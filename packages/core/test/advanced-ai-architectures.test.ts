import { test } from 'vitest';
/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import {
    SelfImprovementService,
    TitansMemorySnapshot,
    TitansContextualMemoryItem,
    TitansPersistentMemoryItem
} from '../src/node/self-improvement-service';
import { AgentContextCompactor } from '../src/node/agent-context-compactor';
import { LongRunningAgentService } from '../src/node/long-running-agent-service';
import { ContainerSandboxService } from '../src/node/container-sandbox-service';
import { AgentStepRecord } from '../src/common/agent-checkpoint-protocol';

async function runAdvancedAiArchitectureTests() {
    console.log('🧪 Running Cutting-Edge AI Architectures (Titans Memory, MLA Compression, MTP Drafting, MoD Gating) Test Suite...');

    // ==========================================
    // Section 1: Titans / MIRAS 3-Tier Neural Memory
    // ==========================================
    const improvementService = new SelfImprovementService();

    // 1.1: Register persistent memory (Invariants & Rules that never decay)
    const persistentRule: TitansPersistentMemoryItem = {
        id: 'rule-immutability-01',
        title: 'Strict TypeScript Type Safety',
        content: 'Always define explicit interfaces and avoid using any in public API boundaries',
        category: 'architecture_invariant',
        tags: ['typescript', 'api_contract']
    };
    improvementService.addPersistentMemory(persistentRule);

    // 1.2: Record surprise-weighted contextual memory (Test-Time Memorization with associative decay)
    const testFailureSurpriseItem: TitansContextualMemoryItem = {
        id: 'ctx-mem-001',
        triggerKey: 'TS2339: Property does not exist on type',
        resolutionValue: 'Verify interface definition in src/common/*-protocol.ts and export updated fields',
        surpriseScore: 0.88, // High surprise on unexpected missing property
        decayWeight: 0.95,
        accessCount: 1,
        lastUpdated: Date.now(),
        associatedFiles: ['src/common/agent-checkpoint-protocol.ts']
    };
    improvementService.recordContextualMemory(testFailureSurpriseItem);

    // 1.3: Retrieve Titans 3-tier memory snapshot
    const memorySnapshot: TitansMemorySnapshot = improvementService.retrieveTitansMemory({
        query: 'TS2339 property sandboxConfig does not exist',
        workingContext: ['Running compilation test', 'Checking sandbox configuration']
    });

    assert.ok(memorySnapshot, 'Memory snapshot must be returned');
    assert.strictEqual(memorySnapshot.coreWorkingMemory.length, 2, 'Core working memory must contain 2 active steps');
    assert.ok(memorySnapshot.contextualMemories.length > 0, 'Contextual memory must match the error trigger');
    assert.strictEqual(memorySnapshot.contextualMemories[0].id, 'ctx-mem-001');
    assert.ok(memorySnapshot.persistentMemories.length > 0, 'Persistent memory must include architecture invariants');
    assert.ok(memorySnapshot.promptInjectionText.includes('[Titans Long-Term Memory]'), 'Prompt injection text must format 3-tier memory');
    console.log('  ✓ Test 1 Passed: Titans 3-tier neural memory (Core, Contextual with associative decay, Persistent) verified');

    // 1.4: Verify associative state update and dynamic decay
    improvementService.applyMemoryDecay(0.1); // Apply 10% decay step across contextual memory
    const decayedSnapshot = improvementService.retrieveTitansMemory({
        query: 'TS2339',
        workingContext: []
    });
    assert.ok(decayedSnapshot.contextualMemories[0].decayWeight < 0.95, 'Contextual memory weight must decay over time without reinforcement');
    console.log('  ✓ Test 2 Passed: Dynamic memory decay and test-time state evolution verified');

    // ==========================================
    // Section 2: Multi-Head Latent Context Compression (MLA-Style)
    // ==========================================
    const largeVerboseLogs = [
        'npm run build:tsc',
        'Compiling package scratchbox-ide-product-ext...',
        'src/node/sandbox.ts(45,12): error TS2339: Property memoryLimitMb does not exist on type SandboxOptions.',
        '    at checkNode (/Users/dev/scratchbox/node_modules/typescript/lib/typescript.js:84210:20)',
        '    at checkSourceElement (/Users/dev/scratchbox/node_modules/typescript/lib/typescript.js:85300:15)',
        ...Array.from({ length: 40 }, (_, i) => `[Debug trace line ${i + 1}] internal state check 0x${(i * 1024).toString(16)} ok`),
        'Compilation finished with 1 error, 0 warnings in 1240ms.'
    ].join('\n');

    const mlaCompressed = AgentContextCompactor.compressLatentLog(largeVerboseLogs, {
        maxLatentTokens: 400,
        preserveDiagnostics: true
    });

    assert.ok(mlaCompressed.compressedText.length < largeVerboseLogs.length, 'Compressed text must be significantly smaller than original');
    assert.ok(mlaCompressed.compressionRatio > 0.5, 'Compression ratio should achieve > 50% savings');
    assert.ok(mlaCompressed.diagnosticAnchors.length > 0, 'Diagnostic error anchors must be extracted and preserved');
    assert.ok(mlaCompressed.diagnosticAnchors.some(a => a.includes('TS2339')), 'TS2339 error anchor must be retained in latent memory');
    console.log('  ✓ Test 3 Passed: Multi-head latent context compression (MLA-style KV reduction) verified');

    // 2.2: Test latent history sliding-window compression
    const rawHistory: AgentStepRecord[] = Array.from({ length: 6 }, (_, i) => ({
        stepNumber: i + 1,
        status: i === 3 ? 'failure' : 'success',
        timestamp: Date.now() - (6 - i) * 10000,
        description: `Executed subtask step ${i + 1}`,
        actionType: 'modify_code',
        filesModified: [`src/file_${i + 1}.ts`],
        logs: `Detailed stdout and stderr log trace for step ${i + 1} with extensive metadata: ${'data '.repeat(100)}`,
        errorOutput: i === 3 ? 'TS2304: Cannot find name SandboxEngine' : undefined
    }));

    const latentHistory = AgentContextCompactor.compressLatentHistory(rawHistory, {
        keepRecentUncompressed: 2,
        latentDimension: 256
    });

    assert.strictEqual(latentHistory.length, 6, 'All history records must be retained in compressed/uncompressed forms');
    assert.ok(latentHistory[0].logs && latentHistory[0].logs.includes('[MLA Latent Compressed]'), 'Older steps must be latent-compressed');
    assert.ok(latentHistory[5].logs && latentHistory[5].logs.includes('Detailed stdout'), 'Most recent steps must remain uncompressed');
    console.log('  ✓ Test 4 Passed: Latent sliding-window history compaction verified');

    // ==========================================
    // Section 3: Multi-Token Prediction (MTP) & Speculative Multi-Step Drafting
    // ==========================================
    const sandboxService = new ContainerSandboxService();
    const agentService = new LongRunningAgentService(sandboxService, improvementService);

    const speculativeDrafts = agentService.draftSpeculativeSteps({
        goal: 'Fix Sandbox Options Type and Re-run Test Suite',
        currentMilestone: 'Update SandboxOptions interface in protocol file',
        completedSteps: ['Inspected src/common/container-sandbox-protocol.ts']
    }, 3); // Draft K=3 speculative steps

    assert.strictEqual(speculativeDrafts.length, 3, 'Must draft exactly K=3 speculative candidate steps');
    assert.ok(speculativeDrafts[0].action.length > 0, 'Draft 1 must have valid action');
    assert.ok(speculativeDrafts.every(d => d.confidenceScore > 0 && d.confidenceScore <= 1.0), 'Confidence scores must be between 0 and 1');

    // 3.2: Verify speculative step conflict validation
    const validation = agentService.validateSpeculativeDrafts(speculativeDrafts, {
        allowedFilePaths: ['src/common/container-sandbox-protocol.ts', 'src/node/container-sandbox-service.ts']
    });
    assert.strictEqual(validation.acceptedDrafts.length > 0, true, 'At least one draft must be accepted');
    console.log('  ✓ Test 5 Passed: Multi-Token Prediction (MTP) speculative step drafting and parallel validation verified');

    // ==========================================
    // Section 4: Mixture-of-Depths (MoD) & Dynamic Gating
    // ==========================================
    // 4.1: Low entropy / deterministic step -> Shallow/fast execution depth
    const shallowDepth = agentService.routeStepDepth({
        actionType: 'run_tests',
        description: 'Execute npm run test to verify green build',
        hasErrorDiagnostics: false,
        recentFailureCount: 0
    });
    assert.strictEqual(shallowDepth.depthLevel, 'shallow', 'Deterministic test runner must route to shallow depth');
    assert.strictEqual(shallowDepth.thinkingBudget, 0, 'Shallow depth should bypass heavy thinking budget');

    // 4.2: High entropy / complex diagnostic step -> Deep reasoning depth
    const deepDepth = agentService.routeStepDepth({
        actionType: 'architectural_refactor',
        description: 'Resolve circular dependency and redesign state machine',
        hasErrorDiagnostics: true,
        recentFailureCount: 2
    });
    assert.strictEqual(deepDepth.depthLevel, 'deep', 'Complex architectural debugging must route to deep reasoning depth');
    assert.ok(deepDepth.thinkingBudget >= 4096, 'Deep depth must allocate substantial thinking budget');
    console.log('  ✓ Test 6 Passed: Mixture-of-Depths (MoD) dynamic entropy gating & adaptive compute verified');

    console.log('\n🎉 ALL ADVANCED AI ARCHITECTURE (TITANS, MLA, MTP, MoD) TESTS PASSED SUCCESSFULLY!');
}

test('advanced-ai-architectures.test', async () => {
    await runAdvancedAiArchitectureTests();
}, 180_000);
