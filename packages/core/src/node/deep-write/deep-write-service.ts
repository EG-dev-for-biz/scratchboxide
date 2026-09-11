/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import { GoalAnalyzer } from './goal-analyzer';
import { MultiPlatformScaffolder } from './multi-platform-scaffolder';
import { DynamicDagPlanner } from './dynamic-dag-planner';
import { DeepWriteExecutionBridge } from './deep-write-execution-bridge';
import { CodebaseLensSyncService } from './codebase-lens-sync-service';
import { PrimitiveSynthesizer } from './primitive-synthesizer';
import { UserLearningService } from './user-learning-service';
import { VisualVerificationService } from '../visual-verification-service';
import { 
    DeepWriteGoalRequest, 
    DeepWriteStreamEvent, 
    DiscoveredGoalPlan
} from '../../common/deep-write/deep-write-protocol';

interface SuspendedPipeline {
    goalPlan: DiscoveredGoalPlan;
    stageIndex: number;
    historyContext: Record<string, any>;
    filesContext: Record<string, string>;
    onEvent: (event: DeepWriteStreamEvent) => void;
    resolve: () => void;
}
export class DeepWriteService {
    private suspendedPipelines = new Map<string, SuspendedPipeline>();

    constructor(
        protected readonly goalAnalyzer: GoalAnalyzer,
        protected readonly scaffolder: MultiPlatformScaffolder,
        protected readonly dagPlanner: DynamicDagPlanner,
        protected readonly executionBridge: DeepWriteExecutionBridge,
        protected readonly lensSync: CodebaseLensSyncService,
        protected readonly synthesizer: PrimitiveSynthesizer,
        protected readonly learningService: UserLearningService,
        protected readonly visualVerifier?: VisualVerificationService
    ) {}

    /**
     * Start a boundless, goal-driven deep planning and writing pipeline.
     */
    public async runPipeline(
        request: DeepWriteGoalRequest,
        onEvent: (event: DeepWriteStreamEvent) => void,
        signal?: AbortSignal
    ): Promise<void> {
        const sessionId = request.sessionId || `dw-sess-${Date.now()}`;
        const workspaceRoot = request.workspaceRoot || process.cwd();

        try {
            if (signal?.aborted) {
                return;
            }
            // 1. Strategic Goal Discovery & Deliverable Formulation
            onEvent({
                type: 'pipeline_start',
                sessionId,
                message: 'Strategic Meta-Architect formulating comprehensive project blueprints...'
            });

            const plan = await this.goalAnalyzer.analyzeGoal(
                request.prompt,
                workspaceRoot,
                request.activeArtifact?.title
            );

            onEvent({
                type: 'goal_analyzed',
                sessionId,
                title: plan.goal,
                plan,
                message: `Analyzed goal: formulated target platforms [${plan.domains.join(', ')}] and primitives.`
            });

            if (signal?.aborted) {
                return;
            }

            // 2. Generate Initial Multi-Platform Project Scaffolding
            onEvent({
                type: 'deliverables_planned',
                sessionId,
                message: 'Auto-generating multi-platform directory scaffolding and compile manifests...'
            });

            const scaffoldFiles = this.scaffolder.generateScaffold(
                plan.domains[0],
                plan.goal,
                plan.deliverables.config.languages
            );

            await this.lensSync.syncBundleToWorkspace(workspaceRoot, scaffoldFiles);

            onEvent({
                type: 'file_scaffold_ready',
                sessionId,
                message: `Folder structures & build systems synchronized to workspace disk path.`
            });

            // 3. Sequential Stage Execution with Interactive Gates
            const historyContext: Record<string, any> = {};
            const filesContext = { ...scaffoldFiles };

            await this.executeStagesFromIndex(
                sessionId,
                plan,
                0,
                historyContext,
                filesContext,
                workspaceRoot,
                onEvent,
                signal
            );

        } catch (err: any) {
            console.error('[DeepWriteService] Error running pipeline:', err);
            onEvent({
                type: 'error',
                sessionId,
                error: err.message || 'Fatal error occurred in Deep-Write pipeline execution.'
            });
        }
    }

    /**
     * Resume a suspended checkpoint pipeline with fresh user feedback steering directives.
     */
    public async resumePipeline(
        sessionId: string,
        feedback: string,
        workspaceRoot?: string
    ): Promise<void> {
        const suspended = this.suspendedPipelines.get(sessionId);
        if (!suspended) {
            throw new Error(`No active suspended Deep-Write pipeline found for session: ${sessionId}`);
        }

        this.suspendedPipelines.delete(sessionId);
        const root = workspaceRoot || process.cwd();

        suspended.onEvent({
            type: 'checkpoint_resumed',
            sessionId,
            message: `Feedback received. Extracting style conventions and resuming pipeline...`
        });

        // Learn styling conventions directly from user feedback to memories
        await this.learningService.learnFromFeedback(feedback, root);

        // Resume stage execution with user feedback
        const activeStage = suspended.goalPlan.stages[suspended.stageIndex];
        
        try {
            // Execute the current stage again incorporating the user's feedback
            const res = await this.dagPlanner.executeStage(
                suspended.goalPlan,
                activeStage,
                suspended.historyContext,
                feedback
            );

            if (res.success) {
                suspended.historyContext[activeStage.id] = res.output;
                if (res.output.files) {
                    suspended.filesContext = { ...suspended.filesContext, ...res.output.files };
                }

                // Project output to disk
                if (res.output.files && Object.keys(res.output.files).length > 0) {
                    await this.lensSync.syncBundleToWorkspace(root, res.output.files);
                }

                suspended.onEvent({
                    type: 'stage_complete',
                    sessionId,
                    currentStageId: activeStage.id,
                    currentStageName: activeStage.name,
                    message: `Resumed stage "${activeStage.name}" completed successfully.`
                });

                // Continue with subsequent stages
                await this.executeStagesFromIndex(
                    sessionId,
                    suspended.goalPlan,
                    suspended.stageIndex + 1,
                    suspended.historyContext,
                    suspended.filesContext,
                    root,
                    suspended.onEvent
                );
            } else {
                suspended.onEvent({
                    type: 'error',
                    sessionId,
                    error: res.error || `Failed to resume stage "${activeStage.name}" execution.`
                });
            }
        } catch (err: any) {
            suspended.onEvent({
                type: 'error',
                sessionId,
                error: err.message || 'Error occurred while resuming pipeline execution.'
            });
        }

        suspended.resolve();
    }

    private async executeStagesFromIndex(
        sessionId: string,
        plan: DiscoveredGoalPlan,
        startIndex: number,
        historyContext: Record<string, any>,
        filesContext: Record<string, string>,
        workspaceRoot: string,
        onEvent: (event: DeepWriteStreamEvent) => void,
        signal?: AbortSignal
    ): Promise<void> {
        for (let i = startIndex; i < plan.stages.length; i++) {
            if (signal?.aborted) {
                // Client disconnected: stop spending model/tool budget on this session.
                return;
            }
            const stage = plan.stages[i];

            onEvent({
                type: 'stage_start',
                sessionId,
                currentStageId: stage.id,
                currentStageName: stage.name,
                progressPercent: Math.round((i / plan.stages.length) * 100),
                totalStages: plan.stages.length,
                message: `Executing Phase: ${stage.name}`
            });

            // Check if this stage requires a Checkpoint Pause Gate
            if (stage.isCheckpoint && startIndex !== i) {
                // Synthesize intermediate deliverables
                const intermediateBundle = this.synthesizer.synthesizeBundle(
                    plan.goal,
                    plan,
                    historyContext,
                    filesContext
                );

                await new Promise<void>((resolve) => {
                    this.suspendedPipelines.set(sessionId, {
                        goalPlan: plan,
                        stageIndex: i,
                        historyContext,
                        filesContext,
                        onEvent,
                        resolve
                    });

                    onEvent({
                        type: 'checkpoint_paused',
                        sessionId,
                        currentStageId: stage.id,
                        currentStageName: stage.name,
                        checkpoint: {
                            sessionId,
                            stageId: stage.id,
                            stageName: stage.name,
                            status: 'awaiting_feedback',
                            intermediateArtifacts: intermediateBundle.artifacts.map(a => ({
                                id: `dw-artifact-${stage.id}`,
                                type: a.type,
                                title: a.title,
                                summary: intermediateBundle.summary || 'Intermediate planning spec artifact.',
                                version: 1,
                                createdAt: new Date().toLocaleTimeString(),
                                data: a.data
                            })),
                            decisionPoints: [
                                `Review structural configuration for ${stage.name}.`,
                                'Incorporate specific tech-stack overrides if needed.',
                                'Submit steering feedback to resume pipeline downstream.'
                            ]
                        },
                        message: `Pipeline paused at Checkpoint Gate: "${stage.name}". Awaiting feedback.`
                    });
                });
                
                // resolved, loop is broken or has continued elsewhere
                return;
            }

            // Normal sequential stage run
            const res = await this.dagPlanner.executeStage(plan, stage, historyContext);
            if (!res.success) {
                onEvent({
                    type: 'error',
                    sessionId,
                    error: res.error || `Execution of stage "${stage.name}" failed.`
                });
                return;
            }

            historyContext[stage.id] = res.output;
            if (res.output.files) {
                filesContext = { ...filesContext, ...res.output.files };
            }

            // Perform dynamic compile check and self-healing error analysis on native/web code
            if (plan.deliverables.config.toolchain !== 'none' && res.output.files && Object.keys(res.output.files).length > 0) {
                onEvent({
                    type: 'research_thinking',
                    sessionId,
                    thinking: `Performing compiler checks using toolchain "${plan.deliverables.config.toolchain}"...`
                });

                const buildRes = await this.executionBridge.compileAndRun(
                    res.output.files,
                    plan.deliverables.config.toolchain,
                    workspaceRoot,
                    (msg) => onEvent({ type: 'research_thinking', sessionId, thinking: msg })
                );

                onEvent({
                    type: 'execution_output',
                    sessionId,
                    executionLog: {
                        output: buildRes.output,
                        success: buildRes.success
                    }
                });

                if (buildRes.repairedFiles) {
                    filesContext = { ...filesContext, ...buildRes.repairedFiles };
                }
            }

            // Bidirectional CodebaseLens projection to the workspace on disk
            if (res.output.files && Object.keys(res.output.files).length > 0) {
                await this.lensSync.syncBundleToWorkspace(workspaceRoot, res.output.files);
            }

            onEvent({
                type: 'stage_complete',
                sessionId,
                currentStageId: stage.id,
                currentStageName: stage.name,
                progressPercent: Math.round(((i + 1) / plan.stages.length) * 100),
                message: `Stage "${stage.name}" completed successfully.`
            });
        }

        // 4. Synthesize Final Coordinated Deliverable Bundle
        const finalBundle = this.synthesizer.synthesizeBundle(
            plan.goal,
            plan,
            historyContext,
            filesContext
        );

        // Visual Verification & Auto-Repair on generated visual artifacts
        const verifier = this.visualVerifier || new VisualVerificationService();
        if (finalBundle.artifacts && finalBundle.artifacts.length > 0) {
            for (let aIdx = 0; aIdx < finalBundle.artifacts.length; aIdx++) {
                const art = finalBundle.artifacts[aIdx];
                if (art.type === '3d-scene' || art.type === 'live-code-sandbox') {
                    try {
                        const audit = await verifier.verifyVisual({
                            image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                            prompt: plan.goal,
                            artifactType: art.type,
                            context: {
                                title: art.title,
                                sceneData: art.type === '3d-scene' ? (art.data as any) : undefined
                            }
                        });

                        if (audit.visualFixes && audit.fidelityScore < 80) {
                            finalBundle.artifacts[aIdx] = verifier.applyVisualAutoRepair(art as any, audit) as any;
                        }
                    } catch (e) {
                        // ignore
                    }
                }
            }
        }

        onEvent({
            type: 'pipeline_complete',
            sessionId,
            bundle: finalBundle,
            message: `Deep-Planning pipeline successfully completed all ${plan.stages.length} phases.`
        });
    }
}
