/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as assert from 'assert';
import { GeminiService } from '../src/node/gemini-service';
import { DynamicDagPlanner } from '../src/node/deep-write/dynamic-dag-planner';
import { DeepWriteExecutionBridge } from '../src/node/deep-write/deep-write-execution-bridge';

async function runCoreIntelligenceSystemsIntegrationTestSuite() {
    console.log('🧪 Running 4 Core Intelligence Systems End-to-End Integration Test Suite...');

    // 1. Initialize GeminiService
    const geminiService = new GeminiService();
    const contextGraph = geminiService.getContextGraphService();
    const patternEngine = geminiService.getPatternEngine();
    const lspService = geminiService.getLspFeedbackService();
    const diffMemory = geminiService.getDiffMemoryService();

    assert.ok(geminiService, 'GeminiService should be initialized');
    assert.ok(contextGraph, 'ProjectContextGraphService should be accessible');
    assert.ok(patternEngine, 'CodebasePatternEngine should be accessible');
    assert.ok(lspService, 'LspDiagnosticFeedbackService should be accessible');
    assert.ok(diffMemory, 'ConversationDiffMemoryService should be accessible');

    // =========================================================================
    // SECTION 1: System 1 - Indexing & Symbol Retrieval Setup
    // =========================================================================
    console.log('\n--- Section 1: Ingesting Symbols into Context Graph ---');

    contextGraph.indexSourceFile(
        'src/services/billing-service.ts',
        `export interface InvoiceRecord { id: string; amount: number; paid: boolean; }
export class BillingCalculationService {
    calculateTotalWithTax(invoices: InvoiceRecord[], taxRate: number = 0.08): number {
        const subtotal = invoices.reduce((acc, cur) => acc + cur.amount, 0);
        return subtotal * (1 + taxRate);
    }
}`,
        'typescript'
    );

    const symbols = contextGraph.getAllSymbols();
    assert.ok(symbols.length >= 2, 'Should index BillingCalculationService and calculateTotalWithTax');
    console.log('  ✓ Section 1: Symbols indexed in context graph');

    // =========================================================================
    // SECTION 2: System 2 - Pattern Engine Setup
    // =========================================================================
    console.log('\n--- Section 2: In-Context Pattern Matching Setup ---');

    patternEngine.analyzeFilesPatterns([
        {
            path: 'src/services/billing-service.ts',
            content: `import { injectable } from '@theia/core/shared/inversify';
@injectable()
export class BillingCalculationService {}`
        }
    ]);
    console.log('  ✓ Section 2: Workspace conventions extracted');

    // =========================================================================
    // SECTION 3: System 3 - Language Server Diagnostic Setup
    // =========================================================================
    console.log('\n--- Section 3: LSP Diagnostic Feedback Setup ---');

    lspService.ingestDiagnostics('src/services/billing-service.ts', [
        {
            id: 'diag-b1',
            filePath: 'src/services/billing-service.ts',
            range: { startLine: 4, startColumn: 9, endLine: 4, endColumn: 25 },
            severity: 'error',
            code: 'TS2322',
            source: 'tsc',
            message: "Type 'string' is not assignable to type 'number'.",
            timestamp: Date.now()
        }
    ]);
    assert.strictEqual(lspService.getSummary().errorCount, 1);
    console.log('  ✓ Section 3: Diagnostic feedback registered');

    // =========================================================================
    // SECTION 4: System 4 - Multi-Turn Diff Memory Setup
    // =========================================================================
    console.log('\n--- Section 4: Multi-Turn Conversation & Recent Diffs Setup ---');

    diffMemory.recordTurnEdits(
        'turn-101',
        [
            {
                filePath: 'src/services/billing-service.ts',
                oldContent: 'const subtotal = 0;',
                newContent: 'const subtotal = invoices.reduce((acc, cur) => acc + cur.amount, 0);'
            }
        ],
        { userPrompt: 'Implement subtotal reduction calculation' }
    );

    diffMemory.recordUncommittedChange(
        'src/services/billing-service.ts',
        'const subtotal = invoices.reduce((acc, cur) => acc + cur.amount, 0);',
        'const subtotal = invoices.filter(i => i.paid).reduce((acc, cur) => acc + cur.amount, 0);'
    );
    console.log('  ✓ Section 4: Turn edits and live uncommitted changes tracked');

    // =========================================================================
    // SECTION 5: Prompt Context Synthesis Verification
    // =========================================================================
    console.log('\n--- Section 5: Gemini Prompt Context Auto-Injection Verification ---');

    const promptInstruction = await geminiService.buildSystemInstructionPrompt({
        prompt: 'Fix calculateTotalWithTax to only include paid invoices',
        targetFiles: ['src/services/billing-service.ts']
    });

    // 1. Verify Semantic Symbol Graph Injection
    assert.ok(
        promptInstruction.includes('RELEVANT CODEBASE SYMBOLS & DEPENDENCY SUBGRAPH') ||
        promptInstruction.includes('BillingCalculationService'),
        'Prompt must contain semantic codebase symbol subgraph'
    );
    console.log('  ✓ Test 5.1 Passed: Semantic Symbol Graph injected into Gemini prompt context');

    // 2. Verify In-Context Few-Shot Pattern Matching Injection
    assert.ok(
        promptInstruction.includes('WORKSPACE_ARCHITECTURAL_CONVENTIONS') ||
        promptInstruction.includes('Naming:'),
        'Prompt must contain workspace architectural conventions'
    );
    console.log('  ✓ Test 5.2 Passed: In-Context few-shot pattern conventions injected into Gemini prompt context');

    // 3. Verify LSP Diagnostic Feedback Injection
    assert.ok(
        promptInstruction.includes('ACTIVE LSP & COMPILER DIAGNOSTICS FOR SELF-HEALING REPAIR') ||
        promptInstruction.includes('TS2322'),
        'Prompt must contain active LSP diagnostics for auto-repair'
    );
    console.log('  ✓ Test 5.3 Passed: LSP & compiler diagnostics injected into Gemini prompt context');

    // 4. Verify Multi-Turn Conversation & Recent Diffs Injection
    assert.ok(
        promptInstruction.includes('RECENT CODE MODIFICATIONS & MULTI-TURN DIFF HISTORY') ||
        promptInstruction.includes('Turn #1'),
        'Prompt must contain recent turn diffs and conversational lineage'
    );
    console.log('  ✓ Test 5.4 Passed: Multi-turn diff history and uncommitted edits injected into Gemini prompt context');

    // =========================================================================
    // SECTION 6: DeepWrite & Dynamic DAG Planner Integration
    // =========================================================================
    console.log('\n--- Section 6: Deep-Write & Dynamic DAG Planner Integration ---');

    const dagPlanner = new DynamicDagPlanner(geminiService, patternEngine, contextGraph);
    assert.ok(dagPlanner.getPatternEngine());
    assert.ok(dagPlanner.getContextGraphService());

    const execBridge = new DeepWriteExecutionBridge(geminiService, lspService);
    assert.ok(execBridge.getLspFeedbackService());
    console.log('  ✓ Test 6.1 Passed: DynamicDagPlanner and DeepWriteExecutionBridge configured with core intelligence hooks');

    console.log('\n🎉 ALL 4 CORE INTELLIGENCE SYSTEMS INTEGRATION TESTS PASSED WITH 100% GREEN STATUS!');
}

runCoreIntelligenceSystemsIntegrationTestSuite().catch(err => {
    console.error('Integration Test Suite Failed:', err);
    process.exit(1);
});
