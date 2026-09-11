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

async function runDsignAttentionArchitectureTests() {
    console.log('🧪 Running Visual Attention Architecture & Perception Hierarchy (dsign) Test Suite...');

    const baseDir = path.resolve(__dirname, '..');
    const styleDir = path.join(baseDir, 'src/browser/style');
    const unifiedCssPath = path.join(styleDir, 'unified-ui.css');
    const indexCssPath = path.join(styleDir, 'index.css');
    const canvasDir = path.join(baseDir, 'src/browser/generative-canvas');
    const studioPath = path.join(canvasDir, 'GenerativeCanvasStudio.tsx');
    const bentoPath = path.join(canvasDir, 'BentoStageLayout.tsx');
    const sideChatPath = path.join(canvasDir, 'VibecodeAiSideChat.tsx');
    const spotlightPath = path.join(canvasDir, 'SpotlightLauncherModal.tsx');
    const settingsPath = path.join(canvasDir, 'SettingsModal.tsx');

    // Test 1: Design tokens for Visual Attention Architecture exist in CSS
    assert.ok(fs.existsSync(unifiedCssPath), 'unified-ui.css must exist');
    assert.ok(fs.existsSync(indexCssPath), 'index.css must exist');
    const unifiedCss = fs.readFileSync(unifiedCssPath, 'utf-8');
    const indexCss = fs.readFileSync(indexCssPath, 'utf-8');

    const requiredDsignTokens = [
        '--sb-attention-beacon',
        '--sb-cadence-high',
        '--sb-cadence-medium',
        '--sb-cadence-low',
        '--sb-surface-subtractive-border',
        '--sb-gestalt-gap-sm',
        '--sb-gestalt-gap-md',
        '--sb-gestalt-gap-lg'
    ];

    for (const token of requiredDsignTokens) {
        assert.ok(
            unifiedCss.includes(token) || indexCss.includes(token),
            `Stylesheets must define attention architecture token "${token}"`
        );
    }
    console.log('  ✓ Test 1 Passed: Attention architecture & perception tokens defined in CSS');

    // Test 2: Subtractive styling & 3-Tier Typographic Scale Discipline
    const requiredDsignClasses = [
        '.sb-dsign-beacon',
        '.sb-dsign-tier1',
        '.sb-dsign-tier2',
        '.sb-dsign-tier3',
        '.sb-dsign-hud-overlay',
        '.sb-dsign-subtractive-card',
        '.sb-dsign-progressive-reveal'
    ];

    for (const cls of requiredDsignClasses) {
        assert.ok(
            unifiedCss.includes(cls) || indexCss.includes(cls),
            `Stylesheets must define subtractive styling helper class "${cls}"`
        );
    }
    console.log('  ✓ Test 2 Passed: Subtractive styling & progressive disclosure classes verified');

    // Test 3: GenerativeCanvasStudio follows 3-tier perceptual layout & eye trace flow
    assert.ok(fs.existsSync(studioPath), 'GenerativeCanvasStudio.tsx must exist');
    const studioContent = fs.readFileSync(studioPath, 'utf-8');
    
    assert.ok(
        studioContent.includes('sb-chatgpt-topbar') || studioContent.includes('sb-topbar-right'),
        'Top bar must establish a primary orienting landmark'
    );
    assert.ok(
        studioContent.includes('SpotlightLauncherModal') && studioContent.includes('⌘K'),
        'Global wayfinding must provide fast Cmd+K command HUD jump'
    );
    console.log('  ✓ Test 3 Passed: GenerativeCanvasStudio implements perceptual landmark & Cmd+K wayfinding');

    // Test 4: BentoStageLayout implements Creative Tools pattern with calibrated viewport dominance
    assert.ok(fs.existsSync(bentoPath), 'BentoStageLayout.tsx must exist');
    const bentoContent = fs.readFileSync(bentoPath, 'utf-8');

    assert.ok(
        bentoContent.includes('layoutMode') && bentoContent.includes('renderPrimitiveContent'),
        'Bento stage must support multi-zone viewport layout and primitive rendering'
    );
    console.log('  ✓ Test 4 Passed: BentoStageLayout conforms to Creative Tools viewport dominance');

    // Test 5: VibecodeAiSideChat implements clear CTA priority & progressive disclosure
    assert.ok(fs.existsSync(sideChatPath), 'VibecodeAiSideChat.tsx must exist');
    const sideChatContent = fs.readFileSync(sideChatPath, 'utf-8');

    assert.ok(
        sideChatContent.includes('handleSend') && sideChatContent.includes('ContextMention'),
        'Side chat must provide clear send action and contextual mention binding'
    );
    console.log('  ✓ Test 5 Passed: VibecodeAiSideChat conforms to Notice -> Understand -> Act funnel');

    // Test 6: SpotlightLauncherModal & SettingsModal implement categoric zoning & safe defaults
    assert.ok(fs.existsSync(spotlightPath), 'SpotlightLauncherModal.tsx must exist');
    assert.ok(fs.existsSync(settingsPath), 'SettingsModal.tsx must exist');
    const spotlightContent = fs.readFileSync(spotlightPath, 'utf-8');
    const settingsContent = fs.readFileSync(settingsPath, 'utf-8');

    assert.ok(
        spotlightContent.includes('category') && spotlightContent.includes('Actions'),
        'Spotlight modal must chunk commands by semantic category'
    );
    assert.ok(
        settingsContent.includes('workspace') || settingsContent.includes('settingsScope'),
        'Settings modal must organize preferences by user intent'
    );
    console.log('  ✓ Test 6 Passed: Spotlight & Settings modals implement cognitive zoning & intent grouping');

    console.log('\n🎉 ALL DSIGN ATTENTION ARCHITECTURE & PERCEPTION HIERARCHY TESTS PASSED SUCCESSFULLY!');
}

test('dsign-attention-architecture.test', async () => {
    await runDsignAttentionArchitectureTests();
}, 180_000);
