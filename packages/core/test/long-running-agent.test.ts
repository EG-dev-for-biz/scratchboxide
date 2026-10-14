import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LongRunningAgentService } from '../src/node/long-running-agent-service';
import { AgentContextCompactor } from '../src/node/agent-context-compactor';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';
import { SelfImprovementService } from '../src/node/self-improvement-service';
import { AgentStreamEvent } from '../src/common/agent-checkpoint-protocol';

async function runLongRunningAgentTests() {
    console.log('🧪 Running Long-Running Agent State Machine & TDD Loop Test Suite...');

    const sandboxService = new ContainerSandboxService();
    const selfImprovementService = new SelfImprovementService();
    const agentService = new LongRunningAgentService(sandboxService, selfImprovementService);

    // Initialize sandbox environment for tests. Every session gets a temp workspace root: checkpoint
    // rollbacks and blueprint patches write files (e.g. src/core.ts) relative to the session's
    // environment, which otherwise defaults to process.cwd() (the repository root).
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-long-running-agent-'));
    await sandboxService.createEnvironment({
        environmentId: 'test-env',
        isolationLevel: 'process-jail',
        workspaceRoot
    });
    const useTempWorkspace = (sessionId: string) => sandboxService.createEnvironment({
        environmentId: sessionId,
        isolationLevel: 'process-jail',
        workspaceRoot
    });

    // Test 1: Initialize long running agent session and deconstruct milestones
    const sessionState = await agentService.createSession('Configure and verify custom memory limits inside secure sandbox', 15);
    await useTempWorkspace(sessionState.sessionId);
    assert.strictEqual(sessionState.status, 'initializing');
    assert.strictEqual(sessionState.goal, 'Configure and verify custom memory limits inside secure sandbox');
    assert.ok(sessionState.milestones.length > 0, 'Milestones must be successfully deconstructed from goal');
    assert.strictEqual(sessionState.currentMilestoneIndex, 0, 'Must start at first milestone');
    console.log('  ✓ Test 1 Passed: Long-running agent session initialized and goal deconstructed');

    // Test 2: Deterministic checkpointing and recovery state preservation
    const initialCheckpoint = await agentService.createCheckpoint(sessionState.sessionId, 'Pre-execution baseline', {
        'src/core.ts': 'export class Core {}'
    });
    assert.ok(initialCheckpoint.checkpointId.startsWith('chk-'));
    assert.strictEqual(initialCheckpoint.description, 'Pre-execution baseline');

    // Modify active state indexes
    sessionState.currentMilestoneIndex = 1;
    sessionState.status = 'running';

    // Rollback to checkpoint
    const restoredState = await agentService.rollbackToLastCheckpoint(sessionState.sessionId);
    assert.strictEqual(restoredState.currentMilestoneIndex, 0, 'Milestone index must rollback to checkpoint state');
    assert.strictEqual(restoredState.status, 'initializing', 'Status must roll back to initialized state');
    assert.strictEqual(restoredState.history.length, 1);
    assert.ok(restoredState.history[0].description.includes('Rolled back workspace'), 'Rollback action must be logged in history');
    console.log('  ✓ Test 2 Passed: Deterministic state checkpointing and recovery rollback verified');

    // Test 3: Bounded execution budget constraints (Exceed iterations)
    const budgetSession = await agentService.createSession('Failing Task', 1); // 1 iteration limit
    await useTempWorkspace(budgetSession.sessionId);
    const events: AgentStreamEvent[] = [];
    await agentService.runMilestoneLoop(budgetSession.sessionId, (e) => events.push(e));

    assert.strictEqual(budgetSession.status, 'failed', 'Session status should be failed on budget exhaustion');
    assert.ok(events.some(e => e.type === 'budget_exhausted'), 'Must emit budget_exhausted streaming event');
    console.log('  ✓ Test 3 Passed: Bounded execution budgets properly gate runaway processes');

    // Test 4: Sliding window context compaction of verbose logs
    const verboseLog = `
Starting build process...
Error: TS2339: Property 'sandboxConfig' does not exist on type 'CoreEngine'.
    at compiler.ts:14:15
    at buildRunner.ts:55:12
Compilation failed.
`;
    const compacted = AgentContextCompactor.summarizeLog(verboseLog, 250);
    assert.ok(compacted.includes('TS2339'), 'Compaction summary must retain key error codes');
    assert.ok(compacted.includes('compiler.ts'), 'Compaction summary must retain stack frame references');
    assert.ok(compacted.length <= 250, 'Compaction must strictly satisfy the character limit bound');

    const historySteps = [
        { stepNumber: 1, description: 'Step 1', status: 'failure' as const, timestamp: Date.now(), actionType: 'patch', filesModified: [], logs: 'very long logs '.repeat(20) },
        { stepNumber: 2, description: 'Step 2', status: 'failure' as const, timestamp: Date.now(), actionType: 'patch', filesModified: [], logs: 'very long logs '.repeat(20) },
        { stepNumber: 3, description: 'Step 3', status: 'success' as const, timestamp: Date.now(), actionType: 'patch', filesModified: [] }
    ];
    const compactedHistory = AgentContextCompactor.compactHistory(historySteps, 1);
    assert.ok(compactedHistory[0].logs?.includes('[Compacted]'), 'Older steps must be distilled');
    assert.strictEqual(compactedHistory[2].logs, undefined, 'Last step must remain unaltered in full detail');
    console.log('  ✓ Test 4 Passed: Sliding window log and history record compaction verified');

    // Test 5: Stuck cycle / repetition detection and strategy pivoting
    const cycleSession = await agentService.createSession('repetition-test', 20);
    await useTempWorkspace(cycleSession.sessionId);
    const cycleEvents: AgentStreamEvent[] = [];

    // Rig environment to produce same step records consecutively and trigger cycle detection
    const loopPromise = agentService.runMilestoneLoop(cycleSession.sessionId, (e) => cycleEvents.push(e));

    // Wait short delay to allow inner loop to spin
    await new Promise(r => setTimeout(r, 500));
    await agentService.cancelSession(cycleSession.sessionId);
    await loopPromise;

    assert.ok(
        cycleEvents.some(e => e.type === 'guardrail_gate' && e.message.includes('Cycle detected')),
        'Must detect action cycles and trigger guardrail safety gate'
    );
    console.log('  ✓ Test 5 Passed: Runaway / infinite action cycles intercepted with automated strategy pivoting');

    // Test 6: Play/Pause/Resume & Cancellation Signals
    const flowSession = await agentService.createSession('flow-test', 10);
    await useTempWorkspace(flowSession.sessionId);
    const flowEvents: AgentStreamEvent[] = [];

    const executionPromise = agentService.runMilestoneLoop(flowSession.sessionId, (e) => flowEvents.push(e));

    await agentService.pauseSession(flowSession.sessionId);
    assert.strictEqual(flowSession.status, 'paused', 'Session must successfully pause execution on signal');

    await agentService.resumeSession(flowSession.sessionId);
    assert.strictEqual(flowSession.status, 'running', 'Session must successfully resume execution on signal');

    await agentService.cancelSession(flowSession.sessionId);
    await executionPromise;
    assert.strictEqual(flowSession.status, 'failed', 'Session status should compile as failed on cancellation');
    console.log('  ✓ Test 6 Passed: Resilient play, pause, resume, and cancellation signals handled gracefully');

    // Test 7: Native Gemini 3.8 Reasoning & Turn-based Tool Loop Validation
    console.log('  Running Test 7: Native Gemini 3.8 Reasoning & Turn-based Tool Loop Validation...');
    const tddSession = await agentService.createSession('tdd-self-correcting-test', 10);
    await useTempWorkspace(tddSession.sessionId);
    const tddEvents: AgentStreamEvent[] = [];

    process.env.SCRATCHBOX_TEST_USE_REAL_AI = 'true';

    // Temporarily mock getStatus and streamGenerate on agentService's geminiService
    const originalGetStatus = (agentService as any).geminiService.getStatus;
    const originalStreamGenerate = (agentService as any).geminiService.streamGenerate;

    (agentService as any).geminiService.getStatus = async () => ({
        connected: true,
        serviceAccount: 'scratchbox-test@scratchbox.iam.gserviceaccount.com',
        projectId: 'scratchbox-test-project',
        activeModel: 'gemini-3.8-flash',
        availableModels: ['gemini-3.8-flash', 'gemini-3.1-pro-preview'],
        thinkingBudget: 2048,
        authMethod: 'service-account'
    });

    let mockThoughtsEmitted = false;
    (agentService as any).geminiService.streamGenerate = async (req: any, onGeminiEvent: any) => {
        // Stream simulated thought events
        onGeminiEvent({
            type: 'thought',
            thought: 'Gemini 3.8 Reasoning Loop: Analyzing the failing test trace...',
            modelUsed: req.model || 'gemini-3.8-flash'
        });
        onGeminiEvent({
            type: 'thought',
            thought: 'Synthesizing minimal patch for core-logic file to export missing bindings.',
            modelUsed: req.model || 'gemini-3.8-flash'
        });
        mockThoughtsEmitted = true;

        // Return a mock action blueprint JSON
        const milestoneMatch = req.prompt.match(/Milestone:\s*(.+)/);
        const milestoneDesc = milestoneMatch ? milestoneMatch[1].trim() : 'current';
        
        const isRetry = req.prompt.includes('Attempt: 2') || 
                        req.prompt.includes('Last Exit Code: 1') || 
                        req.prompt.includes('compilation error');
        
        console.log('MOCK isRetry:', isRetry, 'Milestone:', milestoneDesc);

        const blueprint = isRetry 
            ? {
                actionType: 'patch_files',
                filesModified: ['src/core.ts'],
                description: `Refined patch fixing strict interface property types for milestone: ${milestoneDesc} (TDD correction applied)`,
                commands: ['echo "tests passing"'] // on attempt 2 we pass
              }
            : {
                actionType: 'patch_files',
                filesModified: ['src/core.ts'],
                description: `Initial structural code modification for milestone: ${milestoneDesc} with potential strict type issues`,
                commands: ['echo "compilation error" && exit 1'] // on attempt 1 we fail
              };

        return {
            success: true,
            text: `\`\`\`json\n${JSON.stringify(blueprint, null, 2)}\n\`\`\``,
            thoughts: ['Gemini 3.8 Reasoning Loop: Analyzing the failing test trace...'],
            modelUsed: req.model || 'gemini-3.8-flash'
        };
    };

    // Run the milestone loop
    const tddPromise = agentService.runMilestoneLoop(tddSession.sessionId, (e) => tddEvents.push(e));
    await tddPromise;

    delete process.env.SCRATCHBOX_TEST_USE_REAL_AI;

    // Restore original methods
    (agentService as any).geminiService.getStatus = originalGetStatus;
    (agentService as any).geminiService.streamGenerate = originalStreamGenerate;

    // Assert that the session completed successfully after self-correction
    assert.strictEqual(tddSession.status, 'completed', 'TDD self-correcting session should successfully converge to completed status');
    assert.ok(mockThoughtsEmitted, 'Must successfully emit mock reasoning thoughts via GeminiService');
    
    // Assert that we captured 'agent_thought' events
    const thoughtEvents = tddEvents.filter(e => e.type === 'agent_thought');
    assert.ok(thoughtEvents.length > 0, 'Must pipe gemini thought events as agent_thought stream events back to the client');
    assert.ok(thoughtEvents.some(e => e.message.includes('Analyzing the failing test trace')), 'Thought messages must convey the thinking steps');

    // Assert that we successfully routed tool executions / sandbox actions
    const stepCompleteEvents = tddEvents.filter(e => e.type === 'step_complete');
    assert.ok(stepCompleteEvents.length > 0, 'Must successfully execute turn-based action steps and complete milestones');

    console.log('  ✓ Test 7 Passed: Native Gemini 3.8 Reasoning & Turn-based Tool Loop successfully validated!');

    // Test 8: Gemini failures surface as a failed run (no silent simulated blueprint substitution)
    console.log('  Running Test 8: Gemini failures fail the run instead of falling back to simulation...');
    {
        const geminiAny = (agentService as any).geminiService;
        const savedGetStatus = geminiAny.getStatus;
        const savedStreamGenerate = geminiAny.streamGenerate;
        agentService.setBlueprintSimulation(false);
        try {
            // A: streamGenerate throws -> agent_error + failed status, no "Simulated" thoughts
            process.env.SCRATCHBOX_TEST_USE_REAL_AI = 'true';
            geminiAny.getStatus = async () => ({ connected: true });
            geminiAny.streamGenerate = async () => { throw new Error('503 model overloaded'); };
            const errSession = await agentService.createSession('gemini-error-surface', 10);
            await useTempWorkspace(errSession.sessionId);
            const errEvents: AgentStreamEvent[] = [];
            await agentService.runMilestoneLoop(errSession.sessionId, e => errEvents.push(e));
            assert.strictEqual(errSession.status, 'failed', 'Gemini errors must fail the run');
            assert.ok(errEvents.some(e => e.type === 'agent_error' && e.message.includes('503 model overloaded')),
                'agent_error event must carry the underlying Gemini error');
            assert.ok(!errEvents.some(e => e.message.includes('Simulated')), 'No simulated thought events may be emitted');
            assert.strictEqual(errSession.milestones[0].status, 'failed');
            assert.ok(!errEvents.some(e => e.type === 'milestone_complete'), 'No milestone may complete without a real blueprint');

            // B: Gemini disconnected with simulation disabled -> failed run naming the cause
            delete process.env.SCRATCHBOX_TEST_USE_REAL_AI;
            geminiAny.getStatus = async () => ({ connected: false });
            const offlineSession = await agentService.createSession('gemini-offline-surface', 10);
            await useTempWorkspace(offlineSession.sessionId);
            const offlineEvents: AgentStreamEvent[] = [];
            await agentService.runMilestoneLoop(offlineSession.sessionId, e => offlineEvents.push(e));
            assert.strictEqual(offlineSession.status, 'failed', 'Disconnected Gemini must fail the run');
            assert.ok(offlineEvents.some(e => e.type === 'agent_error' && /Gemini is not connected/.test(e.message)));
            assert.ok(!offlineEvents.some(e => e.message.includes('Simulated')));
        } finally {
            delete process.env.SCRATCHBOX_TEST_USE_REAL_AI;
            geminiAny.getStatus = savedGetStatus;
            geminiAny.streamGenerate = savedStreamGenerate;
            agentService.setBlueprintSimulation(undefined);
        }
    }
    console.log('  ✓ Test 8 Passed: Gemini errors surface as failed runs with agent_error events');

    // Cleanup environment
    await sandboxService.destroyEnvironment('test-env');
    fs.rmSync(workspaceRoot, { recursive: true, force: true });

    console.log('\n🎉 ALL LONG-RUNNING AGENT & STATE MACHINE TESTS PASSED SUCCESSFULLY!');
}

test('long-running-agent.test', async () => {
    await runLongRunningAgentTests();
}, 180_000);
