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
import {
    SubagentPoolService,
    SubagentDAGPlan,
    SubagentTaskNode,
    SubagentRole
} from '../src/node/subagent-pool-service';
import { GeminiService } from '../src/node/gemini-service';

async function runTests() {
    console.log('🧪 Running Multi-Subagent Swarm & High-Concurrency Pool Test Suite...');

    // =========================================================================
    // Test 1: Worker Pool Limits & High-Concurrency Capacity Verification
    // =========================================================================
    console.log('\n--- Section 1: Worker Pool Sizing & Concurrency Bounds ---');
    const poolService = new SubagentPoolService({
        maxConcurrentWorkers: 64,
        defaultWorkerTimeoutMs: 15000,
        enableAdaptiveBackpressure: true
    });

    const initialMetrics = poolService.getPoolMetrics();
    assert.strictEqual(initialMetrics.maxWorkers, 64, 'Max workers must be configured to 64');
    assert.strictEqual(initialMetrics.activeWorkers, 0, 'Active workers must initialize to 0');
    assert.strictEqual(initialMetrics.queuedTasks, 0, 'Queued tasks must initialize to 0');
    console.log('  ✓ Test 1 Passed: Subagent pool initializes with 64 max concurrent capacity');

    // =========================================================================
    // Test 2: Shared Blackboard State & Inter-Agent Communication
    // =========================================================================
    console.log('\n--- Section 2: Shared Blackboard & Event Bus Architecture ---');
    const blackboard = poolService.getBlackboard();
    let eventReceived = false;

    blackboard.subscribe('codebase_findings', entry => {
        if (entry.key === 'auth_middleware' && entry.authorRole === 'explorer') {
            eventReceived = true;
        }
    });

    blackboard.set('auth_middleware', {
        authorRole: 'explorer',
        data: { file: 'src/node/auth.ts', exportedFunctions: ['authenticateJwt', 'verifyToken'] },
        confidence: 0.95
    });

    const retrieved = blackboard.get('auth_middleware');
    assert.ok(retrieved, 'Blackboard entry must exist');
    assert.strictEqual(retrieved?.authorRole, 'explorer');
    assert.strictEqual(eventReceived, true, 'Blackboard subscriber must be notified on update');
    console.log('  ✓ Test 2 Passed: Shared blackboard supports atomic writes, reads, and pub/sub notifications');

    // =========================================================================
    // Test 3: Directed Acyclic Graph (DAG) Task Orchestration & Parallel Execution
    // =========================================================================
    console.log('\n--- Section 3: DAG Task Dependency Resolution & Parallel Execution ---');
    const executionLog: string[] = [];

    const testDAG: SubagentDAGPlan = {
        planId: 'dag-feature-auth-refactor',
        orchestratorModel: 'gemini-3.8-flash',
        goal: 'Refactor authentication middleware with parallel testing and security review',
        tasks: [
            {
                id: 'task-explore',
                role: 'explorer',
                description: 'Index auth modules and usage call-sites',
                dependencies: [],
                status: 'pending',
                execute: async () => {
                    executionLog.push('task-explore');
                    return { files: ['src/node/auth.ts', 'src/node/user.ts'] };
                }
            },
            {
                id: 'task-draft-code',
                role: 'drafter',
                description: 'Draft modernized async auth helper functions',
                dependencies: ['task-explore'],
                status: 'pending',
                execute: async ctx => {
                    executionLog.push('task-draft-code');
                    return { patch: 'export async function verifyToken() { return true; }' };
                }
            },
            {
                id: 'task-gen-tests',
                role: 'tester',
                description: 'Generate comprehensive unit test suite in parallel',
                dependencies: ['task-draft-code'],
                status: 'pending',
                execute: async () => {
                    executionLog.push('task-gen-tests');
                    return { testsCreated: 5 };
                }
            },
            {
                id: 'task-sec-review',
                role: 'reviewer',
                description: 'Perform static security and vulnerability audit in parallel',
                dependencies: ['task-draft-code'],
                status: 'pending',
                execute: async () => {
                    executionLog.push('task-sec-review');
                    return { vulnerabilitiesFound: 0, status: 'approved' };
                }
            },
            {
                id: 'task-synthesize',
                role: 'synthesizer',
                description: 'Aggregate test results and security approval into final deliverable',
                dependencies: ['task-gen-tests', 'task-sec-review'],
                status: 'pending',
                execute: async ctx => {
                    executionLog.push('task-synthesize');
                    return { readyToMerge: true };
                }
            }
        ]
    };

    const dagResult = await poolService.executeDAG(testDAG);
    assert.strictEqual(dagResult.status, 'completed', 'DAG execution must succeed');
    assert.strictEqual(dagResult.completedTaskCount, 5, 'All 5 tasks must be completed');
    
    // Validate execution order constraints
    assert.strictEqual(executionLog[0], 'task-explore', 'Explore task must execute first');
    assert.strictEqual(executionLog[1], 'task-draft-code', 'Draft task must execute after explore');
    assert.ok(
        executionLog.indexOf('task-gen-tests') > executionLog.indexOf('task-draft-code'),
        'Test task must execute after draft'
    );
    assert.ok(
        executionLog.indexOf('task-sec-review') > executionLog.indexOf('task-draft-code'),
        'Review task must execute after draft'
    );
    assert.strictEqual(executionLog[4], 'task-synthesize', 'Synthesize task must execute last');
    console.log('  ✓ Test 3 Passed: Multi-subagent DAG plan executed with correct topological sequencing');

    // =========================================================================
    // Test 4: Multi-Subagent Consensus Voting & Best-of-N Candidate Selection
    // =========================================================================
    console.log('\n--- Section 4: Consensus Engine & Speculative Voting ---');
    const candidates = [
        {
            candidateId: 'cand-1',
            authorRole: 'drafter' as SubagentRole,
            output: 'function hashPassword(p) { return crypto.createHash("sha256").update(p).digest("hex"); }',
            confidenceScore: 0.65,
            passesValidation: false,
            vulnerabilities: ['Weak legacy hashing algorithm']
        },
        {
            candidateId: 'cand-2',
            authorRole: 'drafter' as SubagentRole,
            output: 'async function hashPassword(p) { return await argon2.hash(p); }',
            confidenceScore: 0.94,
            passesValidation: true,
            vulnerabilities: []
        },
        {
            candidateId: 'cand-3',
            authorRole: 'drafter' as SubagentRole,
            output: 'async function hashPassword(p) { return await bcrypt.hash(p, 12); }',
            confidenceScore: 0.88,
            passesValidation: true,
            vulnerabilities: []
        }
    ];

    const consensus = poolService.resolveConsensus(candidates);
    assert.strictEqual(consensus.selectedCandidateId, 'cand-2', 'Consensus must select the highest-scoring valid candidate');
    assert.strictEqual(consensus.acceptedCount, 2, 'Two candidates must pass validation');
    console.log('  ✓ Test 4 Passed: Consensus engine accurately selected optimal candidate based on weighted verification');

    // =========================================================================
    // Test 5: Speculative Cancellation via Abort Signals
    // =========================================================================
    console.log('\n--- Section 5: Speculative Parallel Cancellation ---');
    let slowTaskCancelled = false;

    const speculativeTasks: SubagentTaskNode[] = [
        {
            id: 'spec-fast',
            role: 'drafter',
            description: 'Fast direct solution',
            dependencies: [],
            status: 'pending',
            execute: async () => {
                return { solution: 'fast_winner', confidence: 0.96 };
            }
        },
        {
            id: 'spec-slow',
            role: 'drafter',
            description: 'Slow exploratory solution',
            dependencies: [],
            status: 'pending',
            execute: async (ctx, signal) => {
                return new Promise((resolve, reject) => {
                    const timer = setTimeout(() => resolve({ solution: 'slow' }), 5000);
                    if (signal) {
                        signal.addEventListener('abort', () => {
                            clearTimeout(timer);
                            slowTaskCancelled = true;
                            reject(new Error('Aborted'));
                        });
                    }
                });
            }
        }
    ];

    const raceResult = await poolService.executeFirstWinningBranch(speculativeTasks, { minConfidence: 0.90 });
    assert.strictEqual(raceResult.winningTaskId, 'spec-fast');
    assert.strictEqual(slowTaskCancelled, true, 'Losing speculative branch must be aborted');
    console.log('  ✓ Test 5 Passed: Losing speculative tasks cleanly cancelled via AbortSignal');

    // =========================================================================
    // Test 6: GeminiService Orchestrator Model Verification (Gemini 3.8 Orchestrator)
    // =========================================================================
    console.log('\n--- Section 6: Gemini 3.8 Orchestrator Integration ---');
    const geminiService = new GeminiService();
    const status = await geminiService.getStatus();

    assert.strictEqual(status.activeModel, 'gemini-3.8-flash', 'Master orchestrator must be Gemini 3.8 Flash');
    assert.strictEqual(status.subagentModel, 'gemini-3.5-flash-lite', 'Subagents must execute on Gemini 3.5 Flash Lite');
    console.log('  ✓ Test 6 Passed: Gemini 3.8 Flash configured as orchestrator with Gemini 3.5 Flash Lite subagents');

    // =========================================================================
    // Test 7: Real Subagent DAG Dispatch & Shared Blackboard Recording
    // =========================================================================
    console.log('\n--- Section 7: Automated Subagent DAG Dispatch & Blackboard Integration ---');
    const poolWithGemini = new SubagentPoolService({
        maxConcurrentWorkers: 16
    }, geminiService);

    const automatedDAG: SubagentDAGPlan = {
        planId: 'dag-auto-analysis',
        orchestratorModel: 'gemini-3.8-flash',
        goal: 'Autonomous exploration and review',
        tasks: [
            {
                id: 'task-auto-explore',
                role: 'explorer',
                description: 'Explore workspace packages and export graph',
                dependencies: [],
                status: 'pending'
            },
            {
                id: 'task-auto-review',
                role: 'reviewer',
                description: 'Verify exported types and backward compatibility',
                dependencies: ['task-auto-explore'],
                status: 'pending'
            }
        ]
    };

    const autoResult = await poolWithGemini.executeDAG(automatedDAG);
    assert.strictEqual(autoResult.status, 'completed', 'Automated subagent DAG must complete');
    assert.strictEqual(autoResult.completedTaskCount, 2, 'Both subagent tasks must complete');
    assert.ok(autoResult.results['task-auto-explore'], 'Explorer task must produce a result');
    assert.ok(autoResult.results['task-auto-review'], 'Reviewer task must produce a result');

    const autoBlackboard = poolWithGemini.getBlackboard();
    const exploreEntry = autoBlackboard.get('task:task-auto-explore');
    assert.ok(exploreEntry, 'Explorer task output must be published to blackboard');
    assert.strictEqual(exploreEntry?.authorRole, 'explorer');

    const reviewEntry = autoBlackboard.get('task:task-auto-review');
    assert.ok(reviewEntry, 'Reviewer task output must be published to blackboard');
    assert.strictEqual(reviewEntry?.authorRole, 'reviewer');
    console.log('  ✓ Test 7 Passed: Subagent pool automatically dispatched tasks to Gemini service and recorded findings to blackboard');

    console.log('\n🎉 ALL MULTI-SUBAGENT SWARM & HIGH-CONCURRENCY POOL TESTS PASSED SUCCESSFULLY!');
}

test('subagent-swarm-orchestration.test', async () => {
    await runTests();
}, 180_000);
