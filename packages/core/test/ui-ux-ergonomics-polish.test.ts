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
import * as fs from 'fs';
import * as path from 'path';
import { readStudioSources } from './source-helpers';

async function runUiUxErgonomicsTests() {
    console.log('🧪 Running Comprehensive UI/UX & Ergonomics Polish Test Suite...\n');

    const unifiedUiCssPath = path.resolve(__dirname, '../src/browser/style/unified-ui.css');
    const indexCssPath = path.resolve(__dirname, '../src/browser/style/index.css');
    const spotlightModalPath = path.resolve(__dirname, '../src/browser/generative-canvas/SpotlightLauncherModal.tsx');
    const automationsModalPath = path.resolve(__dirname, '../src/browser/generative-canvas/AutomationsModal.tsx');
    const projectsModalPath = path.resolve(__dirname, '../src/browser/generative-canvas/ProjectsModal.tsx');
    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const markdownDocPrimitivePath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx');

    assert.ok(fs.existsSync(unifiedUiCssPath), 'unified-ui.css must exist');
    assert.ok(fs.existsSync(indexCssPath), 'index.css must exist');
    assert.ok(fs.existsSync(spotlightModalPath), 'SpotlightLauncherModal.tsx must exist');
    assert.ok(fs.existsSync(automationsModalPath), 'AutomationsModal.tsx must exist');
    assert.ok(fs.existsSync(projectsModalPath), 'ProjectsModal.tsx must exist');
    assert.ok(fs.existsSync(studioTsxPath), 'GenerativeCanvasStudio.tsx must exist');
    assert.ok(fs.existsSync(markdownDocPrimitivePath), 'MarkdownDocumentPrimitive.tsx must exist');

    const unifiedUiCss = fs.readFileSync(unifiedUiCssPath, 'utf-8');
    const indexCss = fs.readFileSync(indexCssPath, 'utf-8');
    const spotlightModalSource = fs.readFileSync(spotlightModalPath, 'utf-8');
    const automationsModalSource = fs.readFileSync(automationsModalPath, 'utf-8');
    const projectsModalSource = fs.readFileSync(projectsModalPath, 'utf-8');
    const studioSource = readStudioSources();
    const markdownDocSource = fs.readFileSync(markdownDocPrimitivePath, 'utf-8');

    // -------------------------------------------------------------
    // Phase 1: Spotlight Modal & CSS Styles
    // -------------------------------------------------------------
    console.log('--- Phase 1: Critical Fixes & Missing Styles (P0) ---');
    assert.ok(indexCss.includes('@import "./unified-ui.css"'), 'index.css must import unified-ui.css');
    assert.ok(spotlightModalSource.includes('sb-spotlight-backdrop'), 'SpotlightLauncherModal must use sb-spotlight-backdrop');
    assert.ok(spotlightModalSource.includes('sb-spotlight-palette-card'), 'SpotlightLauncherModal must use sb-spotlight-palette-card');
    assert.ok(unifiedUiCss.includes('.sb-spotlight-backdrop'), 'unified-ui.css must define .sb-spotlight-backdrop');
    assert.ok(unifiedUiCss.includes('.sb-spotlight-palette-card'), 'unified-ui.css must define .sb-spotlight-palette-card');
    assert.ok(unifiedUiCss.includes('.sb-spotlight-search-row'), 'unified-ui.css must define .sb-spotlight-search-row');
    assert.ok(unifiedUiCss.includes('.sb-spotlight-input'), 'unified-ui.css must define .sb-spotlight-input');
    assert.ok(unifiedUiCss.includes('.sb-spotlight-item-selected'), 'unified-ui.css must define .sb-spotlight-item-selected');
    assert.ok(unifiedUiCss.includes('.sb-spotlight-kbd-badge kbd'), 'unified-ui.css must define .sb-spotlight-kbd-badge kbd');
    console.log('  ✓ Test 1 Passed: Complete .sb-spotlight-* classes codified in unified-ui.css');

    // Focus Visible Rings
    assert.ok(unifiedUiCss.includes(':focus-visible'), 'unified-ui.css must define accessible :focus-visible rings');
    assert.ok(unifiedUiCss.includes('0 0 0 4px var(--sb-system-blue, #007aff)'), 'unified-ui.css focus rings must use system blue');
    console.log('  ✓ Test 2 Passed: Global accessible :focus-visible rings configured for buttons & inputs');

    // Hit-Target Expansions
    assert.ok(unifiedUiCss.includes('.sb-node-port::after'), 'unified-ui.css must include .sb-node-port::after expander');
    assert.ok(unifiedUiCss.includes('.sb-composer-pill-remove::after'), 'unified-ui.css must include .sb-composer-pill-remove::after expander');
    assert.ok(unifiedUiCss.includes('.sb-context-chip-remove::after'), 'unified-ui.css must include .sb-context-chip-remove::after expander');
    console.log('  ✓ Test 3 Passed: Hit-target pseudo-element expanders added for node ports & pill remove buttons');

    // -------------------------------------------------------------
    // Phase 2: Modal & Navigation Ergonomics
    // -------------------------------------------------------------
    console.log('\n--- Phase 2: Modal & Navigation Ergonomics (P1) ---');
    // AutomationsModal Category Pills & Semantic Colors
    assert.ok(automationsModalSource.includes('sb-category-pills-row'), 'AutomationsModal must render category filter pills');
    assert.ok(automationsModalSource.includes('Pipeline') && automationsModalSource.includes('Interactive UI'), 'AutomationsModal must include required category pills');
    assert.ok(automationsModalSource.includes('var(--sb-system-purple'), 'AutomationsModal must use semantic color tokens for action cards');
    assert.ok(automationsModalSource.includes('Clear search and filters'), 'AutomationsModal must have empty state with reset button');
    console.log('  ✓ Test 4 Passed: AutomationsModal category filter pills, semantic colors, and empty state verified');

    // ProjectsModal Keyboard Navigation & Empty State
    assert.ok(projectsModalSource.includes('selectedProjectIndex'), 'ProjectsModal must maintain selectedProjectIndex state');
    assert.ok(projectsModalSource.includes("e.key === 'ArrowDown'") && projectsModalSource.includes("e.key === 'ArrowUp'"), 'ProjectsModal must handle ArrowUp/Down');
    assert.ok(projectsModalSource.includes("e.key === 'Enter'"), 'ProjectsModal must handle Enter to open selected project');
    assert.ok(projectsModalSource.includes('sb-workspace-selected'), 'ProjectsModal must highlight selected card');
    assert.ok(projectsModalSource.includes('Create new project'), 'ProjectsModal empty state must offer create new project CTA');
    console.log('  ✓ Test 5 Passed: ProjectsModal ArrowUp/Down/Enter keyboard navigation and empty search CTA verified');

    // Composer Chip Truncation
    assert.ok(studioSource.includes('max-w-[140px] truncate'), 'GenerativeCanvasStudio composer pills must have text truncation');
    console.log('  ✓ Test 6 Passed: Composer attachment chips configured with max-w-[140px] truncation');

    // -------------------------------------------------------------
    // Phase 3: Canvas Primitives, Document TOC & Motion
    // -------------------------------------------------------------
    console.log('\n--- Phase 3: Canvas Primitives, Document TOC & Motion (P2) ---');
    // MarkdownDocument TOC & Code Block
    assert.ok(markdownDocSource.includes('headingSections.length >= 3'), 'MarkdownDocumentPrimitive must support TOC for 3+ headings');
    assert.ok(markdownDocSource.includes('sb-doc-toc-floating-container'), 'MarkdownDocumentPrimitive must render floating TOC container');
    assert.ok(markdownDocSource.includes('sb-doc-code-lang-badge'), 'MarkdownDocumentPrimitive must render code language badge');
    assert.ok(markdownDocSource.includes('sb-code-copy-btn'), 'MarkdownDocumentPrimitive must render 1-click Copy button');
    assert.ok(markdownDocSource.includes('navigator.clipboard.writeText'), 'MarkdownDocumentPrimitive must copy code to clipboard');
    console.log('  ✓ Test 7 Passed: MarkdownDocumentPrimitive floating TOC and code block language/copy features verified');

    // Fluid Keyframe Spring Waveform
    assert.ok(unifiedUiCss.includes('@keyframes sb-waveform-pulse'), 'unified-ui.css must define @keyframes sb-waveform-pulse');
    assert.ok(!studioSource.includes('setInterval(() => { setWaveformHeights'), 'GenerativeCanvasStudio must not use jittery setInterval for waveform');
    assert.ok(studioSource.includes('sb-waveform-animated-bar'), 'GenerativeCanvasStudio must use fluid CSS keyframe waveform');
    console.log('  ✓ Test 8 Passed: Fluid keyframe spring waveform replaced jittery random interval');

    // Global Scrollbar & Tactile Feedback
    assert.ok(unifiedUiCss.includes('*::-webkit-scrollbar'), 'unified-ui.css must define Apple glass scrollbar');
    assert.ok(unifiedUiCss.includes('.sb-btn:active') && unifiedUiCss.includes('transform: scale(0.98)'), 'unified-ui.css must define tactile press feedback');
    console.log('  ✓ Test 9 Passed: Global Apple glass scrollbars and tactile active press feedback verified');

    console.log('\n🎉 ALL UI/UX & ERGONOMICS POLISH TESTS PASSED SUCCESSFULLY!');
}

test('ui-ux-ergonomics-polish.test', async () => {
    await runUiUxErgonomicsTests();
}, 180_000);
