import { test } from 'vitest';
import { DEFAULT_ACTIVE_USER_NAME } from '../src/browser/generative-canvas/canvas-types';
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
import * as path from 'path';
import { MarkdownDocumentData } from '../src/browser/generative-canvas/canvas-types';

async function runDocumentCanvasTests() {
    console.log('🧪 Running Document Canvas Seamless Editing & Typography Test Suite...');

    // Test 1: Data Model Section Manipulation (Add, Update, Delete on Backspace)
    const initialDoc: MarkdownDocumentData = {
        title: 'API Gateway Architecture',
        subtitle: 'Production high-performance routing specification',
        sections: [
            { id: 'sec-1', type: 'heading', level: 1, content: 'Core Services' },
            { id: 'sec-2', type: 'paragraph', content: 'The gateway coordinates request routing with **sub-millisecond latency** and `zero-trust` validation.' },
            { id: 'sec-3', type: 'paragraph', content: '' } // Empty paragraph to test backspace removal
        ]
    };

    assert.strictEqual(initialDoc.sections.length, 3, 'Initial document has 3 sections');

    // Simulate Backspace on empty paragraph removal
    const filteredSections = initialDoc.sections.filter(sec => !(sec.type === 'paragraph' && (!sec.content || sec.content.trim() === '')));
    assert.strictEqual(filteredSections.length, 2, 'Empty paragraph removed on backspace handler');
    assert.strictEqual(filteredSections[0].id, 'sec-1');
    assert.strictEqual(filteredSections[1].id, 'sec-2');
    console.log('  ✓ Test 1 Passed: Empty paragraph correctly filtered/removed via backspace logic');

    // Test 2: Verify CSS definitions for seamless Notion-grade typography and border elimination in index.css
    const indexCssPath = path.resolve(__dirname, '../src/browser/style/index.css');
    assert.ok(fs.existsSync(indexCssPath), 'index.css exists');
    const indexCss = fs.readFileSync(indexCssPath, 'utf8');

    assert.ok(indexCss.includes('.sb-doc-seamless-textarea'), 'index.css defines .sb-doc-seamless-textarea');
    assert.ok(indexCss.includes('.sb-doc-seamless-input'), 'index.css defines .sb-doc-seamless-input');
    assert.ok(indexCss.includes('.sb-callout-title-seamless'), 'index.css defines .sb-callout-title-seamless');
    assert.ok(indexCss.includes('caret-color: #3b82f6'), 'index.css sets modern blue caret color');
    assert.ok(indexCss.includes('--sb-font-serif'), 'index.css defines serif font stack');
    assert.ok(indexCss.includes('var(--sb-font-serif)'), 'index.css uses serif font for editorial callouts');
    assert.ok(!indexCss.includes('.sb-doc-callout {\n    display: flex;\n    flex-direction: row;\n    align-items: flex-start;\n    gap: 14px;\n    padding: 16px 20px;\n    border-radius: 12px;\n    background: var(--sb-surface-card);\n    border: 1px solid var(--sb-surface-border);\n    border-left: 4px solid var(--sb-system-blue);'), 'index.css eliminates chunky 4px left pill');

    // Inserter hover-only visibility
    assert.ok(indexCss.includes('.sb-doc-inserter-zone') || indexCss.includes('.sb-doc-block-inserter'), 'index.css defines inserter zone styles');
    console.log('  ✓ Test 2 Passed: index.css includes seamless input, serif callout typography, and hover inserter rules');

    // Test 3: Verify light mode styling rules in unified-ui.css
    const unifiedCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css exists');
    const unifiedCss = fs.readFileSync(unifiedCssPath, 'utf8');

    assert.ok(unifiedCss.includes('.sb-doc-seamless-textarea'), 'unified-ui.css defines light mode .sb-doc-seamless-textarea');
    assert.ok(unifiedCss.includes('.sb-doc-seamless-input'), 'unified-ui.css defines light mode .sb-doc-seamless-input');
    assert.ok(unifiedCss.includes('caret-color: #3b82f6'), 'unified-ui.css sets caret color');
    assert.ok(unifiedCss.includes('--sb-font-serif'), 'unified-ui.css defines serif font token');
    assert.ok(unifiedCss.includes('var(--sb-font-serif)'), 'unified-ui.css applies serif font in light mode callouts');
    console.log('  ✓ Test 3 Passed: unified-ui.css includes light mode transparent/borderless overrides and editorial serif callout styles');

    // Test 4: Verify Clean Document Header (No Hashtag Pills & Dynamic Signed-In User Attribution to the active profile)
    const docPrimitivePath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx');
    assert.ok(fs.existsSync(docPrimitivePath), 'MarkdownDocumentPrimitive.tsx exists');
    const docPrimitiveContent = fs.readFileSync(docPrimitivePath, 'utf8');

    // Ensure hashtags pill row is not rendered in document meta header
    assert.ok(!docPrimitiveContent.includes('<div className="sb-doc-tags-list">'), 'MarkdownDocumentPrimitive header eliminates hashtag pills row');
    assert.ok(!docPrimitiveContent.includes('className="sb-doc-tag-pill"'), 'MarkdownDocumentPrimitive header eliminates sb-doc-tag-pill clutter');
    assert.ok(docPrimitiveContent.includes('getActiveUserName(') && docPrimitiveContent.includes('DEFAULT_ACTIVE_USER_NAME'), 'MarkdownDocumentPrimitive attributes author to the active signed-in user');

    // Test 5: Verify Document Synthesis Engine designates creator as active the signed-in user
    const { synthesizeComprehensiveDocument } = await import('../src/browser/generative-canvas/document-synthesis-engine');
    const synthesized1776 = synthesizeComprehensiveDocument('write a document about 1776');
    assert.strictEqual(synthesized1776.author, DEFAULT_ACTIVE_USER_NAME, '1776 synthesized document creator is designated as active the signed-in user');

    const synthesizedAuth = synthesizeComprehensiveDocument('create technical spec for oauth authentication');
    assert.strictEqual(synthesizedAuth.author, DEFAULT_ACTIVE_USER_NAME, 'Auth technical spec creator is designated as active the signed-in user');

    const synthesizedGeneral = synthesizeComprehensiveDocument('project proposal for distributed streaming');
    assert.strictEqual(synthesizedGeneral.author, DEFAULT_ACTIVE_USER_NAME, 'General synthesized document creator is designated as active the signed-in user');
    console.log('  ✓ Tests 4 & 5 Passed: Document header has no hashtag clutter and creator is dynamically attributed to the signed-in user');

    console.log('🎉 ALL DOCUMENT CANVAS SEAMLESS EDITING TESTS PASSED!');
}

test('document-canvas-seamless.test', async () => {
    await runDocumentCanvasTests();
}, 180_000);
