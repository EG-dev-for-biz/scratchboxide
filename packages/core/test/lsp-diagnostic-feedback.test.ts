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
import { LspDiagnosticFeedbackService } from '../src/node/lsp-diagnostic-feedback-service';

async function runLspDiagnosticFeedbackTestSuite() {
    console.log('🧪 Running Language Server (LSP) & Diagnostic Feedback Loop Test Suite...');

    const diagnosticService = new LspDiagnosticFeedbackService();

    // =========================================================================
    // SECTION 1: Diagnostic Ingestion & Event Listeners
    // =========================================================================
    console.log('\n--- Section 1: Ingestion & Change Notification ---');

    let notificationCount = 0;
    const sub = diagnosticService.onDiagnosticsChanged(summary => {
        notificationCount++;
    });

    diagnosticService.ingestDiagnostics('src/app/main.ts', [
        {
            id: 'diag-1',
            filePath: 'src/app/main.ts',
            range: { startLine: 10, startColumn: 5, endLine: 10, endColumn: 20 },
            severity: 'error',
            code: 'TS2322',
            source: 'tsc',
            message: "Type 'string' is not assignable to type 'number'.",
            timestamp: Date.now()
        }
    ]);

    assert.strictEqual(notificationCount, 1, 'Listener should be triggered on ingestion');
    const summary1 = diagnosticService.getSummary();
    assert.strictEqual(summary1.errorCount, 1);
    assert.strictEqual(summary1.clean, false);
    assert.ok(summary1.affectedFiles.includes('src/app/main.ts'));

    const fileDiags = diagnosticService.getDiagnosticsForFile('src/app/main.ts');
    assert.strictEqual(fileDiags.length, 1);
    assert.strictEqual(fileDiags[0].code, 'TS2322');

    sub.dispose();
    console.log('  ✓ Test 1.1 Passed: Diagnostic ingestion updates state and dispatches change events');

    // =========================================================================
    // SECTION 2: Compiler Output Parsing (TypeScript, ESLint, Rust, Python)
    // =========================================================================
    console.log('\n--- Section 2: Multi-Compiler Diagnostic Parsing ---');

    const sampleTscOutput = `
src/services/data.ts(45,12): error TS2304: Cannot find name 'GeoCoordinate'.
src/services/data.ts(88,5): warning TS6133: 'unusedVar' is declared but its value is never read.
src/utils/math.ts:12:3 - error TS2554: Expected 2 arguments, but got 1.
`;

    const tscBatch = diagnosticService.ingestCompilerOutput(sampleTscOutput, 'typescript', 1);
    assert.strictEqual(tscBatch.diagnostics.length, 3, 'Should parse 3 TypeScript diagnostics');
    assert.strictEqual(tscBatch.diagnostics.filter(d => d.severity === 'error').length, 2);
    assert.strictEqual(tscBatch.diagnostics.filter(d => d.severity === 'warning').length, 1);
    console.log('  ✓ Test 2.1 Passed: TypeScript compiler tsc errors and warnings parsed into structured LSP diagnostics');

    const sampleRustOutput = `
error[E0425]: cannot find value 'unresolved_symbol' in this scope
  --> src/renderer.rs:24:9
`;
    const rustBatch = diagnosticService.ingestCompilerOutput(sampleRustOutput, 'cargo', 101);
    assert.ok(rustBatch.diagnostics.some(d => d.filePath === 'src/renderer.rs' && d.range.startLine === 24));
    console.log('  ✓ Test 2.2 Passed: Rust compiler errors parsed correctly');

    const samplePyOutput = `
src/worker.py:15: error: Incompatible types in assignment (expression has type "int", variable has type "str")
`;
    const pyBatch = diagnosticService.ingestCompilerOutput(samplePyOutput, 'python', 1);
    assert.ok(pyBatch.diagnostics.some(d => d.filePath === 'src/worker.py' && d.range.startLine === 15));
    console.log('  ✓ Test 2.3 Passed: Python compiler/linter errors parsed correctly');

    const sampleClangOutput = `
packages/core/src/native/world_generator.cpp:42:15: error: no member named 'generateProceduralMesh' in 'Scratchbox3D::Engine'
packages/core/src/native/include/scratchbox_engine.hpp:105:5: note: candidate function not viable
packages/core/src/native/shaders/terrain.frag:18:9: warning: unused variable 'ambientOcclusion'
`;
    const clangBatch = diagnosticService.ingestCompilerOutput(sampleClangOutput, 'clang++', 1);
    assert.strictEqual(clangBatch.diagnostics.length, 3, 'Should parse 3 Clang C++ diagnostics');
    const clangErr = clangBatch.diagnostics.find(d => d.severity === 'error');
    assert.ok(clangErr, 'Should find Clang error');
    assert.strictEqual(clangErr?.range.startLine, 42);
    assert.strictEqual(clangErr?.range.startColumn, 15);
    assert.ok(clangErr?.message.includes('generateProceduralMesh'));
    console.log('  ✓ Test 2.4 Passed: Clang C++20 errors, notes, and warnings parsed with exact file, line, and column coordinates');

    // =========================================================================
    // SECTION 3: Self-Healing Prompt Synthesis & Suggested Actions
    // =========================================================================
    console.log('\n--- Section 3: Self-Healing Diagnostic Prompt Synthesis ---');

    const fixPrompt = diagnosticService.synthesizeDiagnosticFixPrompt(['src/services/data.ts'], {
        'src/services/data.ts': `import { Logger } from './logger';
// Line 40
// Line 41
// Line 42
// Line 43
// Line 44
const coord = new GeoCoordinate(10, 20);`
    });

    assert.strictEqual(fixPrompt.targetedFiles.includes('src/services/data.ts'), true);
    assert.ok(fixPrompt.errorCount >= 1);
    assert.ok(fixPrompt.promptContext.includes('TS2304'));
    assert.ok(fixPrompt.suggestedActions.some(a => a.includes('missing import') || a.includes('src/services/data.ts')));
    console.log('  ✓ Test 3.1 Passed: Self-healing prompt correctly groups errors and synthesizes actionable repair recommendations');

    // Test clear
    diagnosticService.clearDiagnostics();
    const clearSummary = diagnosticService.getSummary();
    assert.strictEqual(clearSummary.clean, true);
    assert.strictEqual(clearSummary.totalCount, 0);
    console.log('  ✓ Test 3.2 Passed: Clearing diagnostics resets state to clean');

    console.log('\n🎉 ALL LSP & DIAGNOSTIC FEEDBACK LOOP TESTS PASSED SUCCESSFULLY!');
}

test('lsp-diagnostic-feedback.test', async () => {
    await runLspDiagnosticFeedbackTestSuite();
}, 180_000);
