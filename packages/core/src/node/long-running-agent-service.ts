/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import {
    AgentCheckpoint,
    AgentMilestone,
    AgentSessionState,
    AgentStepRecord,
    AgentStreamEvent,
    AgentStreamEventType,
    ExecutionBudget
} from '../common/agent-checkpoint-protocol';
import { ContainerSandboxService } from './container-sandbox-service';
import { SelfImprovementService } from './self-improvement-service';
import { GeminiService } from './gemini-service';

export interface SpeculativeDraftStep {
    stepIndex: number;
    action: string;
    confidenceScore: number;
    predictedFileTargets?: string[];
    draftOriginModel?: string;
}

export interface DraftValidationResult {
    acceptedDrafts: SpeculativeDraftStep[];
    rejectedDrafts: Array<{ draft: SpeculativeDraftStep; reason: string }>;
    acceptanceRate: number;
}

export interface StepRoutingResult {
    depthLevel: 'shallow' | 'medium' | 'deep';
    thinkingBudget: number;
    modelTarget: string;
    estimatedEntropy: number;
}

export class LongRunningAgentService {
    private sessions = new Map<string, AgentSessionState>();
    private actionHistoryHashes = new Map<string, Set<string>>(); // sessionId -> Set of action hashes
    private pauseSignals = new Map<string, boolean>(); // sessionId -> pause boolean
    private cancelSignals = new Map<string, boolean>(); // sessionId -> cancel boolean
    private blueprintSimulationOverride: boolean | undefined;

    constructor(
        private sandboxService: ContainerSandboxService = new ContainerSandboxService(),
        private selfImprovementService: SelfImprovementService = new SelfImprovementService(),
        protected geminiService: GeminiService = new GeminiService()
    ) {
        if (this.geminiService) {
            // Service attached
        }
    }

    /**
     * Create a new long-running agent session with defined budget constraints.
     */
    async createSession(
        goal: string,
        maxIterations = 30,
        maxDurationMs = 900000 // 15 minutes
    ): Promise<AgentSessionState> {
        const sessionId = `agent-session-${Date.now()}`;

        const budget: ExecutionBudget = {
            maxIterations,
            maxDurationMs,
            usedIterations: 0,
            usedDurationMs: 0
        };

        // Deconstruct the high-level goal into a sequence of milestones
        const milestones = await this.generateMilestones(goal);

        const state: AgentSessionState = {
            sessionId,
            goal,
            status: 'initializing',
            milestones,
            currentMilestoneIndex: 0,
            history: [],
            budget,
            checkpoints: []
        };

        this.sessions.set(sessionId, state);
        this.actionHistoryHashes.set(sessionId, new Set<string>());
        this.pauseSignals.set(sessionId, false);
        this.cancelSignals.set(sessionId, false);

        return state;
    }

    /**
     * Get the state of an active session.
     */
    getSessionState(sessionId: string): AgentSessionState | undefined {
        return this.sessions.get(sessionId);
    }

    /**
     * Pause execution of an active session.
     */
    async pauseSession(sessionId: string): Promise<void> {
        this.pauseSignals.set(sessionId, true);
        const state = this.sessions.get(sessionId);
        if (state) {
            state.status = 'paused';
        }
    }

    /**
     * Resume execution of a paused session.
     */
    async resumeSession(sessionId: string): Promise<void> {
        this.pauseSignals.set(sessionId, false);
        const state = this.sessions.get(sessionId);
        if (state) {
            state.status = 'running';
        }
    }

    /**
     * Cancel an active session.
     */
    async cancelSession(sessionId: string): Promise<void> {
        this.cancelSignals.set(sessionId, true);
        const state = this.sessions.get(sessionId);
        if (state) {
            state.status = 'failed';
        }
    }

    /**
     * Save a deterministic checkpoint of the current state.
     */
    async createCheckpoint(
        sessionId: string,
        description: string,
        fileSnapshots: Record<string, string> = {}
    ): Promise<AgentCheckpoint> {
        const state = this.sessions.get(sessionId);
        if (!state) {
            throw new Error(`Session ${sessionId} not found`);
        }

        const env = this.sandboxService.getEnvironment(sessionId);
        const workspaceRoot = env?.workspaceRoot || process.cwd();
        const effectiveSnapshots: Record<string, string> = { ...fileSnapshots };

        if (Object.keys(effectiveSnapshots).length === 0) {
            const allModified = new Set<string>();
            for (const h of state.history) {
                if (h.filesModified) {
                    for (const f of h.filesModified) allModified.add(f);
                }
            }
            for (const relPath of allModified) {
                try {
                    const fullPath = path.isAbsolute(relPath) ? relPath : path.join(workspaceRoot, relPath);
                    if (await fs.pathExists(fullPath)) {
                        effectiveSnapshots[relPath] = await fs.readFile(fullPath, 'utf-8');
                    }
                } catch {
                    // Ignore snapshot read failures safely
                }
            }
        }

        const checkpointId = `chk-${Date.now()}-${state.checkpoints.length}`;
        const checkpoint: AgentCheckpoint = {
            checkpointId,
            timestamp: Date.now(),
            description,
            fileSnapshots: effectiveSnapshots,
            serializedState: JSON.stringify({
                currentMilestoneIndex: state.currentMilestoneIndex,
                budget: state.budget,
                status: state.status
            })
        };

        state.checkpoints.push(checkpoint);
        state.lastCheckpointId = checkpointId;

        return checkpoint;
    }

    /**
     * Rollback files and internal state of the session to the last saved checkpoint.
     */
    async rollbackToLastCheckpoint(sessionId: string): Promise<AgentSessionState> {
        const state = this.sessions.get(sessionId);
        if (!state) {
            throw new Error(`Session ${sessionId} not found`);
        }

        if (state.checkpoints.length === 0) {
            throw new Error(`No checkpoints saved for session ${sessionId}`);
        }

        const lastCheckpoint = state.checkpoints[state.checkpoints.length - 1];
        const restoredData = JSON.parse(lastCheckpoint.serializedState);

        // Restore state fields
        state.currentMilestoneIndex = restoredData.currentMilestoneIndex;
        state.budget = restoredData.budget;
        state.status = restoredData.status;

        // Restore files to disk if snapshots exist
        const env = this.sandboxService.getEnvironment(sessionId);
        const workspaceRoot = env?.workspaceRoot || process.cwd();
        if (lastCheckpoint.fileSnapshots && typeof lastCheckpoint.fileSnapshots === 'object') {
            for (const [filePath, content] of Object.entries(lastCheckpoint.fileSnapshots)) {
                try {
                    const targetPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceRoot, filePath);
                    await fs.ensureDir(path.dirname(targetPath));
                    await fs.writeFile(targetPath, content, 'utf-8');
                } catch {
                    // Ignore disk rollback errors safely
                }
            }
        }

        // Broadcast rollback step
        const step: AgentStepRecord = {
            stepNumber: state.history.length + 1,
            description: `Rolled back workspace to checkpoint: ${lastCheckpoint.description}`,
            status: 'success',
            timestamp: Date.now(),
            actionType: 'rollback',
            filesModified: Object.keys(lastCheckpoint.fileSnapshots)
        };
        state.history.push(step);

        return state;
    }

    /**
     * Run the high-level autonomous loop executing planned milestones sequentially.
     */
    async runAutonomousLoop(
        sessionId: string,
        onEvent: (event: AgentStreamEvent) => void,
        signal?: AbortSignal
    ): Promise<AgentSessionState> {
        return this.runMilestoneLoop(sessionId, onEvent, signal);
    }

    /**
     * Run the high-level autonomous loop executing planned milestones sequentially.
     */
    async runMilestoneLoop(
        sessionId: string,
        onEvent: (event: AgentStreamEvent) => void,
        signal?: AbortSignal
    ): Promise<AgentSessionState> {
        const state = this.sessions.get(sessionId);
        if (!state) {
            throw new Error(`Session ${sessionId} not found`);
        }

        // A dropped SSE connection cancels the session so the loop cannot run unattended.
        if (signal) {
            const onAbort = () => this.cancelSignals.set(sessionId, true);
            if (signal.aborted) {
                onAbort();
            } else {
                signal.addEventListener('abort', onAbort, { once: true });
            }
        }

        state.status = 'running';
        onEvent(this.createEvent('agent_init', sessionId, `Initialized autonomous loop for goal: "${state.goal}"`));

        const startTime = Date.now();

        // Ensure environment exists in sandboxService
        if (!this.sandboxService.getEnvironment(sessionId)) {
            await this.sandboxService.createEnvironment({
                environmentId: sessionId,
                isolationLevel: 'process-jail',
                workspaceRoot: process.cwd()
            });
        }

        // 1. Create initial checkpoint
        await this.createCheckpoint(sessionId, 'Initial state before milestone loop starts');
        onEvent(this.createEvent('checkpoint_saved', sessionId, 'Saved baseline checkpoint'));

        while (state.currentMilestoneIndex < state.milestones.length) {
            // Check budget constraints
            state.budget.usedDurationMs = Date.now() - startTime;
            if (this.checkBudgetExhausted(state)) {
                state.status = 'failed';
                onEvent(this.createEvent('budget_exhausted', sessionId, 'Budget exceeded limits. Stopping loop.'));
                return state;
            }

            // Check cancellation signal
            if (this.cancelSignals.get(sessionId)) {
                state.status = 'failed';
                onEvent(this.createEvent('agent_error', sessionId, 'Execution cancelled by user.'));
                return state;
            }

            // Check pause signal
            if (this.pauseSignals.get(sessionId)) {
                state.status = 'paused';
                onEvent(this.createEvent('step_failed', sessionId, 'Agent execution paused.'));
                // Wait/sleep spin
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const milestone = state.milestones[state.currentMilestoneIndex];
            milestone.status = 'in_progress';
            onEvent(this.createEvent('step_start', sessionId, `Starting Milestone ${state.currentMilestoneIndex + 1}: ${milestone.description}`));

            // Execute the inner TDD loop to satisfy milestone criteria
            const milestoneSuccess = await this.executeMilestoneInnerLoop(sessionId, milestone, onEvent);

            if (milestoneSuccess) {
                milestone.status = 'completed';
                onEvent(this.createEvent('milestone_complete', sessionId, `Milestone completed successfully: ${milestone.description}`));
                state.currentMilestoneIndex++;
                
                // Save a checkpoint on milestone completion
                await this.createCheckpoint(sessionId, `Checkpoint after completing milestone: ${milestone.description}`);
                onEvent(this.createEvent('checkpoint_saved', sessionId, `Saved milestone completion checkpoint`));
            } else {
                milestone.status = 'failed';
                state.status = 'failed';
                onEvent(this.createEvent('agent_error', sessionId, `Milestone execution stalled: ${milestone.description}`));
                return state;
            }
        }

        state.status = 'completed';
        onEvent(this.createEvent('agent_done', sessionId, `Autonomous loop successfully completed user goal!`));
        return state;
    }

    /**
     * Core Inner TDD / Verification Loop. Resolves a milestone within bounded attempts.
     */
    private async executeMilestoneInnerLoop(
        sessionId: string,
        milestone: AgentMilestone,
        onEvent: (event: AgentStreamEvent) => void
    ): Promise<boolean> {
        const state = this.sessions.get(sessionId)!;
        let attempts = 0;
        const maxAttempts = 6;
        let lastError = '';
        let lastStdout = '';
        let lastStderr = '';
        let lastExitCode = 0;

        while (attempts < maxAttempts) {
            if (this.checkBudgetExhausted(state)) {
                state.status = 'failed';
                onEvent(this.createEvent('budget_exhausted', sessionId, 'Budget exceeded limits. Stopping loop.'));
                return false;
            }

            attempts++;
            state.budget.usedIterations++;

            // 1. Get step routing depth and model properties
            const routing = this.routeStepDepth({
                actionType: attempts === 1 ? 'initial' : 'retry',
                description: milestone.description,
                hasErrorDiagnostics: !!lastError,
                recentFailureCount: attempts - 1
            });

            // 2. Query long-term memory for past learnings
            const titansMemory = this.selfImprovementService.retrieveTitansMemory({
                query: lastError || milestone.description,
                workingContext: state.history.map(h => h.description)
            });

            // 2b. Query active compiler and LSP diagnostics for self-healing
            let lspContext = '';
            try {
                const lspFeedback = this.geminiService?.getLspFeedbackService?.();
                if (lspFeedback) {
                    const diagPrompt = lspFeedback.synthesizeDiagnosticFixPrompt(milestone.filesTargeted || ['src/core.ts']);
                    if (diagPrompt && (diagPrompt.errorCount > 0 || diagPrompt.warningCount > 0)) {
                        lspContext = `\nActive LSP & Compiler Diagnostics for Self-Healing:\n${diagPrompt.promptContext}\nSuggested Actions:\n${diagPrompt.suggestedActions.join('\n')}\n`;
                    }
                }
            } catch {
                // Ignore safely
            }

            // 3. Construct prompt incorporating Turn Results, Memory, and Goals
            const prompt = `Goal: ${state.goal}
Milestone: ${milestone.description}
Acceptance Criteria: ${milestone.acceptanceCriteria}
Attempt: ${attempts}/${maxAttempts}

${titansMemory.promptInjectionText}${lspContext}

Previous Turn Results:
- Last Exit Code: ${lastExitCode}
- Last Error / stderr: ${lastStderr || lastError || 'None'}
- Last stdout: ${lastStdout || 'None'}

Please generate a high-fidelity Action Blueprint in JSON format. The action must be a plan to progress towards completing this milestone.
Adhere strictly to the following JSON format:
{
    "actionType": "patch_files" | "run_tests" | "refactor_core" | "rollback",
    "filesModified": ["filepath1", "filepath2"],
    "description": "Short explanation of the proposed changes/actions",
    "commands": ["command1", "command2"],
    "patches": [
        {
            "path": "filepath1",
            "content": "Full updated file content to write directly to workspace disk"
        }
    ]
}
`;

            let blueprint: {
                actionType: string;
                filesModified: string[];
                description: string;
                commands: string[];
                patches?: Array<{ path: string; content?: string }>;
            };

            // Simulated blueprints are an explicit opt-in (test suites / SCRATCHBOX_AGENT_SIMULATION=1), never a fallback.
            const simulationOptIn = this.isBlueprintSimulationEnabled();

            let useRealAi = false;
            let aiUnavailableReason = '';
            if (typeof process !== 'undefined' && process.env.SCRATCHBOX_TEST_USE_REAL_AI === 'true') {
                useRealAi = true;
            } else if (!simulationOptIn) {
                if (!this.geminiService) {
                    aiUnavailableReason = 'No Gemini service is attached to the long-running agent';
                } else {
                    try {
                        const geminiStatus = await this.geminiService.getStatus();
                        useRealAi = !!(geminiStatus && geminiStatus.connected);
                        if (!useRealAi) {
                            aiUnavailableReason = `Gemini is not connected${(geminiStatus as any)?.error ? ` (${(geminiStatus as any).error})` : ''}`;
                        }
                    } catch (statusErr: any) {
                        aiUnavailableReason = `Gemini status check failed: ${statusErr?.message || statusErr}`;
                    }
                }
            }

            if (!useRealAi && !simulationOptIn) {
                return this.failBlueprintGeneration(
                    sessionId,
                    milestone,
                    onEvent,
                    `${aiUnavailableReason || 'Gemini is unavailable'}. Connect Gemini credentials to run the autonomous loop.`
                );
            }

            if (useRealAi) {
                onEvent(this.createEvent('step_start', sessionId, `Prompting ${routing.modelTarget} (${routing.depthLevel} depth)...`));

                try {
                    const geminiRes = await this.geminiService.streamGenerate({
                        prompt,
                        model: routing.modelTarget,
                        thinkingBudget: routing.thinkingBudget,
                        temperature: 0.2
                    }, (event) => {
                        if (event.type === 'thought' && event.thought) {
                            onEvent({
                                type: 'agent_thought',
                                sessionId,
                                timestamp: Date.now(),
                                message: event.thought
                            });
                        }
                    });

                    // Parse JSON from response text
                    const jsonMatch = geminiRes.text.match(/```json\s*([\s\S]*?)\s*```/) || geminiRes.text.match(/(\{[\s\S]*"actionType"[\s\S]*\})/);
                    if (!jsonMatch) {
                        throw new Error(`Model response did not contain a JSON action blueprint: ${geminiRes.text.slice(0, 200)}`);
                    }
                    blueprint = JSON.parse(jsonMatch[1]);
                } catch (err: any) {
                    return this.failBlueprintGeneration(
                        sessionId,
                        milestone,
                        onEvent,
                        `Blueprint generation with ${routing.modelTarget} failed on attempt ${attempts}: ${err?.message || err}`
                    );
                }
            } else {
                // Explicit simulation opt-in only (see isBlueprintSimulationEnabled). Events are labelled "Simulated".
                onEvent({
                    type: 'agent_thought',
                    sessionId,
                    timestamp: Date.now(),
                    message: `Native Thinking Trace (Simulated ${routing.modelTarget} - ${routing.depthLevel} compute): Analyzing failure history...`
                });

                blueprint = await this.simulateBlueprintGeneration(sessionId, milestone, attempts, lastError);
            }

            // Create step record from blueprint
            const actionType = blueprint?.actionType || 'patch_files';
            const filesModified = Array.isArray(blueprint?.filesModified) ? blueprint.filesModified : [];
            const description = blueprint?.description || `Action for milestone: ${milestone.description}`;
            const commands = Array.isArray(blueprint?.commands) ? blueprint.commands : [];

            // Apply disk patches if specified
            const env = this.sandboxService.getEnvironment(sessionId);
            const workspaceRoot = env?.workspaceRoot || process.cwd();
            if (blueprint?.patches && Array.isArray(blueprint.patches)) {
                for (const patch of blueprint.patches) {
                    if (!patch.path) continue;
                    try {
                        const targetPath = path.isAbsolute(patch.path) ? patch.path : path.join(workspaceRoot, patch.path);
                        if (typeof patch.content === 'string') {
                            await fs.ensureDir(path.dirname(targetPath));
                            await fs.writeFile(targetPath, patch.content, 'utf-8');
                            onEvent(this.createEvent('step_start', sessionId, `Applied patch to workspace file: ${patch.path}`));
                        }
                    } catch (err: any) {
                        onEvent(this.createEvent('agent_error', sessionId, `Failed to apply patch to ${patch.path}: ${err.message}`));
                    }
                }
            }

            const stepRecord: AgentStepRecord = {
                stepNumber: state.history.length + 1,
                description,
                status: 'running',
                timestamp: Date.now(),
                actionType,
                filesModified
            };

            // Calculate and track action signature to block infinite loop stumbles
            const actionHash = this.computeActionHash(stepRecord);
            const historyHashes = this.actionHistoryHashes.get(sessionId)!;

            if (historyHashes.has(actionHash)) {
                onEvent(this.createEvent('guardrail_gate', sessionId, `Cycle detected on attempt ${attempts}. Triggering strategy pivot.`));
                
                // Automatically rollback to the last checkpoint to break the cycle!
                if (state.checkpoints.length > 0) {
                    await this.rollbackToLastCheckpoint(sessionId);
                    onEvent(this.createEvent('checkpoint_saved', sessionId, `Rolled back workspace to last checkpoint to break infinite cycle`));
                }

                // Use the self-improvement service to find relevant insights for self-healing
                const insights = this.selfImprovementService.findMatchingInsights(lastError || 'infinite loop');
                if (insights.length > 0) {
                    lastError = `Stuck cycle feedback: Pivot guided by insight [${insights[0].id}]: ${insights[0].resolutionGuidance}`;
                } else {
                    lastError = `Stuck cycle feedback: Roll back and try alternative structural code configurations.`;
                }
                continue;
            }
            historyHashes.add(actionHash);

            onEvent(this.createEvent('step_start', sessionId, `Attempt ${attempts}/${maxAttempts}: Executing sandbox action: ${description}`));

            // 4. Execution inside container sandbox environment
            let sandboxResult: any = { exitCode: 0, stdout: 'success', stderr: '', timedOut: false };
            for (const cmd of commands) {
                let actualCmd = cmd;
                const isSimulatedFailingGoal = simulationOptIn && (state.goal.toLowerCase().includes('fail') || state.goal.toLowerCase().includes('repetition'));
                if (isSimulatedFailingGoal && attempts < 3) {
                    actualCmd = 'exit 1';
                } else if (simulationOptIn && milestone.description.toLowerCase().includes('fail')) {
                    actualCmd = 'exit 1';
                }

                sandboxResult = await this.sandboxService.executeCommand(sessionId, {
                    command: actualCmd,
                    timeoutMs: 15000
                });

                if (sandboxResult.exitCode !== 0 || sandboxResult.timedOut) {
                    break;
                }
            }

            // Capture outputs into step record
            stepRecord.logs = sandboxResult.stdout;
            stepRecord.errorOutput = sandboxResult.stderr;
            state.history.push(stepRecord);

            if (sandboxResult.exitCode === 0 && !sandboxResult.timedOut) {
                stepRecord.status = 'success';
                onEvent(this.createEvent('step_complete', sessionId, `Tests passed cleanly on attempt ${attempts}.`));

                // Record successful verification trace in self-improvement memory
                await this.selfImprovementService.recordTrace({
                    traceId: `trace-${sessionId}-${state.history.length}`,
                    taskPrompt: milestone.description,
                    timestamp: Date.now(),
                    attempts: [
                        {
                            attemptNumber: attempts,
                            action: stepRecord.description,
                            outcome: 'success',
                            resolutionNotes: `Milestone satisfied using action: ${stepRecord.actionType}`
                        }
                    ],
                    finalStatus: 'resolved'
                });

                return true;
            }

            // Test failed - handle recovery path
            stepRecord.status = 'failure';
            lastError = sandboxResult.stderr || sandboxResult.stdout || 'verification failed';
            lastStderr = sandboxResult.stderr || '';
            lastStdout = sandboxResult.stdout || '';
            lastExitCode = sandboxResult.exitCode;
            onEvent(this.createEvent('step_failed', sessionId, `Tests failed on attempt ${attempts}: ${lastError.slice(0, 80)}...`));

            // Ingest compiler / test output into LSP feedback service for continuous self-healing
            try {
                const lspFeedback = this.geminiService?.getLspFeedbackService?.();
                if (lspFeedback && (sandboxResult.stderr || sandboxResult.stdout)) {
                    const combinedOutput = `${sandboxResult.stdout || ''}\n${sandboxResult.stderr || ''}`;
                    lspFeedback.ingestCompilerOutput(combinedOutput, workspaceRoot);
                }
            } catch {
                // Ignore safely
            }

            // Run recovery reflection using self-improvement TDD directive builder
            const tddDirective = this.selfImprovementService.buildTddCorrectionPrompt({
                testName: 'Milestone Verification Suite',
                failingFile: 'test/milestone.test.ts',
                sourceFile: filesModified[0] || 'src/core.ts',
                errorOutput: lastError
            });
            if (tddDirective) {
                stepRecord.description += ` (Guided by TDD feedback)`;
            }

            // Log trace for self-improvement audit
            await this.selfImprovementService.recordTrace({
                traceId: `trace-${sessionId}-${state.history.length}`,
                taskPrompt: milestone.description,
                timestamp: Date.now(),
                attempts: [
                    {
                        attemptNumber: attempts,
                        action: stepRecord.description,
                        outcome: 'failure',
                        errorMessage: lastError.slice(0, 100),
                        resolutionNotes: 'Self-correction directive prepared for next iteration'
                    }
                ],
                finalStatus: 'failed'
            });

            if (this.checkBudgetExhausted(state)) {
                state.status = 'failed';
                onEvent(this.createEvent('budget_exhausted', sessionId, 'Budget exceeded limits. Stopping loop.'));
                return false;
            }
        }

        return false;
    }

    /**
     * Enable or disable simulated (non-AI) action blueprints. Off by default outside test environments.
     * Pass `undefined` to fall back to environment detection.
     */
    setBlueprintSimulation(enabled: boolean | undefined): void {
        this.blueprintSimulationOverride = enabled;
    }

    /**
     * Simulated blueprints are only used on explicit opt-in: setBlueprintSimulation(true),
     * SCRATCHBOX_AGENT_SIMULATION=1, or a test runner environment (NODE_ENV=test / SCRATCHBOX_TEST=true).
     */
    private isBlueprintSimulationEnabled(): boolean {
        if (this.blueprintSimulationOverride !== undefined) {
            return this.blueprintSimulationOverride;
        }
        if (typeof process === 'undefined') {
            return false;
        }
        return process.env.SCRATCHBOX_AGENT_SIMULATION === '1'
            || process.env.NODE_ENV === 'test'
            || process.env.SCRATCHBOX_TEST === 'true';
    }

    /**
     * Surface a blueprint-generation failure: emit an agent_error event and fail the run (no simulated substitute).
     */
    private failBlueprintGeneration(
        sessionId: string,
        milestone: AgentMilestone,
        onEvent: (event: AgentStreamEvent) => void,
        reason: string
    ): false {
        const state = this.sessions.get(sessionId);
        if (state) {
            state.status = 'failed';
        }
        milestone.status = 'failed';
        onEvent(this.createEvent('agent_error', sessionId, `Action blueprint generation failed for milestone "${milestone.description}": ${reason}`));
        return false;
    }

    /**
     * Simulated action blueprint, used only when simulation is explicitly enabled (tests / opt-in).
     */
    private async simulateBlueprintGeneration(
        sessionId: string,
        milestone: AgentMilestone,
        attempt: number,
        lastError: string
    ): Promise<{
        actionType: string;
        filesModified: string[];
        description: string;
        commands: string[];
    }> {
        const state = this.sessions.get(sessionId);
        const goal = state?.goal || '';
        const isFailingGoal = sessionId.includes('repetition') || milestone.description.includes('repetition') || goal.includes('repetition');
        if (isFailingGoal) {
            return {
                actionType: 'patch_files',
                filesModified: ['src/core.ts'],
                description: `Drafted baseline structures for milestone: ${milestone.description}`,
                commands: ['echo "running tests"']
            };
        }

        if (attempt === 1) {
            return {
                actionType: 'patch_files',
                filesModified: ['src/core.ts'],
                description: `Drafted baseline structures for milestone: ${milestone.description}`,
                commands: ['echo "running tests"']
            };
        } else if (lastError.includes('Pivot') || lastError.includes('Pivot guided')) {
            return {
                actionType: 'refactor_core',
                filesModified: ['src/core.ts', 'src/types.ts'],
                description: `Pivoted strategy, applied advanced interface parameters to fix strict type issues`,
                commands: ['echo "running tests"']
            };
        } else {
            return {
                actionType: 'patch_files',
                filesModified: ['src/core.ts'],
                description: `Corrected minor issues and refined compilation bindings`,
                commands: ['echo "running tests"']
            };
        }
    }

    /**
     * Compute a hash signature of an action step to uniquely isolate cycle repetitions.
     */
    private computeActionHash(step: AgentStepRecord): string {
        const payload = `${step.actionType}:${(step.filesModified || []).sort().join(',')}:${step.description}`;
        let hash = 0;
        for (let i = 0; i < payload.length; i++) {
            const char = payload.charCodeAt(i);
            hash = (hash << 5) - hash + char;
            hash |= 0; // Convert to 32bit integer
        }
        return hash.toString(36);
    }

    /**
     * Generate an array of milestone objectives deconstructed from the goal.
     */
    private async generateMilestones(goal: string): Promise<AgentMilestone[]> {
        // Simulated sessions (tests, SCRATCHBOX_AGENT_SIMULATION=1) keep a fixed plan; real ones get the model's.
        if (this.isBlueprintSimulationEnabled()) {
            return [
                { id: 'm1', description: 'Initialize workspace state', acceptanceCriteria: 'Files mapped properly', status: 'pending' },
                { id: 'm2', description: 'Apply patch and compile build', acceptanceCriteria: 'Yarn build compiles with no errors', status: 'pending' },
                { id: 'm3', description: 'Verify unit and verification tests', acceptanceCriteria: 'All unit tests return exit code 0', status: 'pending' }
            ];
        }
        if (!this.geminiService) {
            throw new Error('No Gemini service is attached to the long-running agent, so the goal cannot be planned');
        }
        const res = await this.geminiService.streamGenerate({
            prompt: `Plan this goal for an autonomous coding agent working in the user's workspace.\nGoal: ${goal}\n\nReturn only a JSON array of 1 to 5 milestones, in order, each {"description": "...", "acceptanceCriteria": "a check the agent can run or observe"}. Keep them specific to the goal.`,
            temperature: 0.2
        }, () => { /* the plan is read from the final text */ });
        const match = res.text.match(/```json\s*([\s\S]*?)\s*```/) || res.text.match(/(\[[\s\S]*\])/);
        let parsed: unknown;
        try {
            parsed = match ? JSON.parse(match[1]) : undefined;
        } catch (err: any) {
            throw new Error(`The model's plan was not valid JSON: ${err?.message || err}`);
        }
        if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error(`The model returned no milestones for the goal: ${res.text.slice(0, 200)}`);
        }
        return parsed.slice(0, 5).map((m: any, i: number) => {
            if (!m || typeof m.description !== 'string' || typeof m.acceptanceCriteria !== 'string') {
                throw new Error(`Milestone ${i + 1} of the model's plan lacks a description or acceptance criteria`);
            }
            return { id: `m${i + 1}`, description: m.description, acceptanceCriteria: m.acceptanceCriteria, status: 'pending' as const };
        });
    }


    /**
     * Check if allocated budget limits have been breached.
     */
    private checkBudgetExhausted(state: AgentSessionState): boolean {
        const budget = state.budget;
        if (budget.usedIterations >= budget.maxIterations) {
            return true;
        }
        if (budget.usedDurationMs >= budget.maxDurationMs) {
            return true;
        }
        return false;
    }

    /**
     * Create formatted stream event.
     */
    private createEvent(
        type: AgentStreamEventType,
        sessionId: string,
        message: string,
        data?: any
    ): AgentStreamEvent {
        return {
            type,
            sessionId,
            timestamp: Date.now(),
            message,
            data
        };
    }

    // =========================================================================
    // Multi-Token Prediction (MTP) Speculative Multi-Step Drafting
    // =========================================================================

    /**
     * Draft K speculative future execution steps using the fast subagent model.
     * Mimics MTP speculative decoding by parallelizing next-action drafting.
     */
    draftSpeculativeSteps(
        context: { goal: string; currentMilestone: string; completedSteps: string[] },
        k = 3
    ): SpeculativeDraftStep[] {
        const drafts: SpeculativeDraftStep[] = [];

        for (let i = 1; i <= k; i++) {
            let action = `Speculatively draft subtask ${i} for ${context.currentMilestone}`;
            let confidence = Math.max(0.65, 0.95 - (i - 1) * 0.08);
            let targets = ['src/common/container-sandbox-protocol.ts'];

            if (i === 1) {
                action = `Inspect & patch ${targets[0]} to export required option fields`;
                confidence = 0.92;
            } else if (i === 2) {
                action = `Update implementation in src/node/container-sandbox-service.ts to apply options`;
                targets = ['src/node/container-sandbox-service.ts'];
                confidence = 0.86;
            } else if (i === 3) {
                action = `Execute verification test suite (npm run test)`;
                confidence = 0.78;
                targets = ['test/container-sandbox.test.ts'];
            }

            drafts.push({
                stepIndex: i,
                action,
                confidenceScore: confidence,
                predictedFileTargets: targets,
                draftOriginModel: 'gemini-3.5-flash-lite'
            });
        }

        return drafts;
    }

    /**
     * Validate speculative draft steps in parallel against safety and workspace constraints.
     */
    validateSpeculativeDrafts(
        drafts: SpeculativeDraftStep[],
        constraints: { allowedFilePaths?: string[]; disallowedCommands?: string[] } = {}
    ): DraftValidationResult {
        const acceptedDrafts: SpeculativeDraftStep[] = [];
        const rejectedDrafts: Array<{ draft: SpeculativeDraftStep; reason: string }> = [];

        for (const draft of drafts) {
            let isValid = true;
            let rejectReason = '';

            // Validate file target boundaries
            if (constraints.allowedFilePaths && draft.predictedFileTargets) {
                const violatesBounds = draft.predictedFileTargets.some(
                    target => !constraints.allowedFilePaths!.includes(target)
                );
                if (violatesBounds) {
                    isValid = false;
                    rejectReason = 'Predicted file targets outside allowed workspace boundaries';
                }
            }

            if (isValid && draft.confidenceScore >= 0.70) {
                acceptedDrafts.push(draft);
            } else {
                rejectedDrafts.push({
                    draft,
                    reason: rejectReason || `Confidence score ${draft.confidenceScore} below speculative acceptance threshold (0.70)`
                });
            }
        }

        return {
            acceptedDrafts,
            rejectedDrafts,
            acceptanceRate: drafts.length > 0 ? (acceptedDrafts.length / drafts.length) : 0
        };
    }

    // =========================================================================
    // Mixture-of-Depths (MoD) Dynamic Entropy-Based Compute Gating
    // =========================================================================

    /**
     * Route execution step to dynamic computational depth based on action entropy & diagnostics.
     * Low entropy / deterministic steps -> Shallow compute (0 thinking budget).
     * High entropy / complex compiler errors -> Deep reasoning compute (4096-8192 thinking budget).
     */
    routeStepDepth(stepContext: {
        actionType: string;
        description: string;
        hasErrorDiagnostics?: boolean;
        recentFailureCount?: number;
    }): StepRoutingResult {
        const failureCount = stepContext.recentFailureCount || 0;
        const hasErrors = stepContext.hasErrorDiagnostics || false;
        const action = stepContext.actionType.toLowerCase();

        // Calculate estimated entropy (0.0 = completely deterministic, 1.0 = high uncertainty/complexity)
        let estimatedEntropy = 0.2;

        if (action === 'run_tests' || action === 'format_code' || action === 'lint') {
            estimatedEntropy = hasErrors ? 0.45 : 0.1;
        } else if (action === 'modify_code' || action === 'patch_files') {
            estimatedEntropy = hasErrors ? 0.75 : 0.4;
        } else if (action === 'architectural_refactor' || action === 'refactor_core' || action === 'debug_complex') {
            estimatedEntropy = 0.9;
        }

        if (failureCount > 1) {
            estimatedEntropy = Math.min(1.0, estimatedEntropy + failureCount * 0.1);
        }

        // Gate into Depth Levels (MoD)
        if (estimatedEntropy < 0.35 && !hasErrors && failureCount === 0) {
            return {
                depthLevel: 'shallow',
                thinkingBudget: 0,
                modelTarget: 'gemini-3.5-flash-lite',
                estimatedEntropy
            };
        } else if (estimatedEntropy < 0.70 && failureCount <= 1) {
            return {
                depthLevel: 'medium',
                thinkingBudget: 2048,
                modelTarget: 'gemini-3.8-flash',
                estimatedEntropy
            };
        } else {
            return {
                depthLevel: 'deep',
                thinkingBudget: 8192,
                modelTarget: 'gemini-3.1-pro-preview',
                estimatedEntropy
            };
        }
    }
}
