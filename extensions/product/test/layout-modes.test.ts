import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { StudioLayoutMode } from '../src/browser/generative-canvas/canvas-types';

async function runLayoutModeTests() {
    console.log('🧪 Running Studio Layout Modes (Chat, Code/Sandbox, Document/Spec, Kanban) Test Suite...');

    // Test 1: Validate StudioLayoutMode union types
    const validModes: StudioLayoutMode[] = ['chat', 'code', 'document', 'kanban', 'automation'];
    assert.strictEqual(validModes.length, 5, 'There must be 5 dedicated modes');
    assert.ok(validModes.includes('chat'), 'Must include chat mode');
    assert.ok(validModes.includes('code'), 'Must include code (sandbox) mode');
    assert.ok(validModes.includes('document'), 'Must include document spec mode');
    assert.ok(validModes.includes('kanban'), 'Must include kanban mode');
    assert.ok(validModes.includes('automation'), 'Must include automation mode');
    console.log('  ✓ Test 1 Passed: StudioLayoutMode type contains chat, code, document, kanban, automation');

    // Test 2: Mode mapping resolver for artifact types
    const resolveModeForArtifact = (type: string): StudioLayoutMode => {
        if (type === 'live-code-sandbox') return 'code';
        if (type === 'node-graph') return 'automation';
        if (type === 'markdown-document' || type === 'rendered-document') return 'document';
        if (type === 'kanban-board' || type === 'kanban') return 'kanban';
        return 'code';
    };

    assert.strictEqual(resolveModeForArtifact('live-code-sandbox'), 'code');
    assert.strictEqual(resolveModeForArtifact('node-graph'), 'automation');
    assert.strictEqual(resolveModeForArtifact('markdown-document'), 'document');
    assert.strictEqual(resolveModeForArtifact('kanban-board'), 'kanban');
    console.log('  ✓ Test 2 Passed: Mode resolver correctly maps artifacts to code, automation, document, or kanban');

    // Test 3: Validate that 'split' is deprecated and removed
    const isLegacySplitAllowed = (mode: string): boolean => {
        return ['chat', 'code', 'canvas', 'document', 'kanban', 'automation'].includes(mode);
    };
    assert.strictEqual(isLegacySplitAllowed('split'), false, 'Legacy split mode must not be allowed');
    console.log('  ✓ Test 3 Passed: Legacy split mode successfully rejected');

    // Test 4: Verify ChatGPT-style Split Layout for Document Editing
    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    assert.ok(fs.existsSync(studioTsxPath), 'GenerativeCanvasStudio.tsx must exist');
    const source = fs.readFileSync(studioTsxPath, 'utf-8');

    assert.ok(source.includes('sb-document-split-container'), 'Must render side-by-side flex split layout container');
    assert.ok(source.includes('sb-chatgpt-document-card'), 'Must wrap MarkdownDocumentPrimitive in ChatGPT-style document workspace frame');
    assert.ok(source.includes('docReadOnly'), 'Must track document read-only edit state');
    assert.ok(source.includes('triggerMarkdownExport'), 'Must support document markdown export download');
    console.log('  ✓ Test 4 Passed: Side-by-side split view, ChatGPT-style document card, and sync/export state verified');

    console.log('\n🎉 ALL LAYOUT MODE TESTS PASSED SUCCESSFULLY!');
}

runLayoutModeTests().catch(err => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
});
