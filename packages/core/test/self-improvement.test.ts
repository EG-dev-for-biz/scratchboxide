import { test } from 'vitest';
import * as assert from 'assert';
import {
    SelfImprovementService,
    ExecutionTrace,
    LearnedInsight
} from '../src/node/self-improvement-service';
import {
    TddFeedbackLoopResult
} from '../src/common/self-improvement-protocol';

async function runSelfImprovementTests() {
    console.log('🧪 Running Self-Improvement & Agent Learning Loop Test Suite...');

    const improvementService = new SelfImprovementService();

    // Test 1: Record Execution Trace
    const trace: ExecutionTrace = {
        traceId: 'trace-test-001',
        taskPrompt: 'Add type-safe container options to sandbox runner',
        timestamp: Date.now(),
        attempts: [
            {
                attemptNumber: 1,
                action: 'modify_code',
                codeSnippet: 'const opt: any = {}',
                outcome: 'failure',
                errorMessage: 'TypeScript error TS7006: Parameter implicitly has any type',
                stackTrace: 'at checkTypes (compiler.ts:42)'
            },
            {
                attemptNumber: 2,
                action: 'fix_types',
                codeSnippet: 'interface LocalOptions { timeoutMs: number; }',
                outcome: 'success',
                resolutionNotes: 'Defined explicit TypeScript interface rather than any'
            }
        ],
        finalStatus: 'resolved'
    };

    await improvementService.recordTrace(trace);
    const retrievedTraces = improvementService.getTracesForPrompt('container options');
    assert.strictEqual(retrievedTraces.length, 1, 'Should find 1 relevant trace');
    assert.strictEqual(retrievedTraces[0].traceId, 'trace-test-001');
    console.log('  ✓ Test 1 Passed: Agent execution trace logged and indexed');

    // Test 2: Distill and Store Learned Insights (Self-Improvement Memory)
    const insight: LearnedInsight = {
        id: 'insight-ts-strict-types',
        category: 'typescript_compilation',
        title: 'Always specify explicit interfaces for sandbox options',
        triggerPattern: 'TS7006|implicitly has any type',
        resolutionGuidance: 'Declare explicit typed interfaces in src/common/*-protocol.ts before implementing',
        confidenceScore: 0.95,
        occurrencesCount: 2,
        lastUpdated: Date.now()
    };

    await improvementService.saveLearnedInsight(insight);
    const matchedInsights = improvementService.findMatchingInsights('TypeScript error TS7006: Parameter implicitly has any type');
    assert.ok(matchedInsights.length > 0, 'Must match stored insight against compiler error');
    assert.strictEqual(matchedInsights[0].id, 'insight-ts-strict-types');
    console.log('  ✓ Test 2 Passed: Error pattern matched against learned insights library');

    // Test 3: Generate TDD Iterative Self-Correction Prompt for Gemini
    const tddContext = {
        testName: 'Container Isolation Test',
        failingFile: 'test/container-sandbox.test.ts',
        sourceFile: 'src/node/container-sandbox-service.ts',
        errorOutput: 'AssertionError [ERR_ASSERTION]: Expected status to be "ready", got "initializing"',
        currentCode: 'export class ContainerSandboxService { ... }'
    };

    const feedbackDirective = improvementService.buildTddCorrectionPrompt(tddContext);
    assert.ok(feedbackDirective.includes('TDD_SELF_CORRECTION'), 'Must include structured TDD header');
    assert.ok(feedbackDirective.includes('AssertionError'), 'Must embed failure stack trace for immediate grounding');
    assert.ok(feedbackDirective.includes('test/container-sandbox.test.ts'), 'Must cite specific test file path');
    console.log('  ✓ Test 3 Passed: Grounded TDD feedback prompt constructed with exact stack trace context');

    // Test 4: Evaluate Iterative Loop Convergence
    const loopResult: TddFeedbackLoopResult = improvementService.evaluateLoopConvergence([
        { iteration: 1, testsPassed: 2, testsTotal: 6, status: 'failing' },
        { iteration: 2, testsPassed: 5, testsTotal: 6, status: 'failing' },
        { iteration: 3, testsPassed: 6, testsTotal: 6, status: 'passed' }
    ]);

    assert.strictEqual(loopResult.converged, true, 'Loop should converge when all tests pass');
    assert.strictEqual(loopResult.totalIterations, 3);
    assert.strictEqual(loopResult.finalStatus, 'green');
    console.log('  ✓ Test 4 Passed: Iterative TDD convergence progress evaluated accurately');

    // Test 5: Export Knowledge Base for Project IDX / Gemini System Instructions
    const systemMemory = improvementService.exportSystemInstructionMemory();
    assert.ok(typeof systemMemory === 'string', 'Memory export must be string');
    assert.ok(systemMemory.includes('insight-ts-strict-types') || systemMemory.includes('TypeScript'), 'Learned patterns exported');
    console.log('  ✓ Test 5 Passed: Learned memories exported into Gemini-ready system instructions');

    console.log('\n🎉 ALL SELF-IMPROVEMENT & LEARNING LOOP TESTS PASSED SUCCESSFULLY!');
}

test('self-improvement.test', async () => {
    await runSelfImprovementTests();
}, 180_000);
