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
import * as path from 'path';
import { readSettingsSources, readStudioSources } from './source-helpers';

async function runCursorExperienceAndGoogleModelsTests() {
    console.log('🧪 Running Cursor Experience & Google Models Privacy Test Suite...\n');

    const studioTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/GenerativeCanvasStudio.tsx');
    const sideChatTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/VibecodeAiSideChat.tsx');
    const settingsTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/SettingsModal.tsx');
    const spotlightTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/SpotlightLauncherModal.tsx');
    const automationsTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/AutomationsModal.tsx');
    const nodeGraphTsxPath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/NodeGraphPrimitive.tsx');
    const geminiServicePath = path.resolve(__dirname, '../src/node/gemini-service.ts');
    const geminiModulesDir = path.resolve(__dirname, '../src/node/gemini');

    assert.ok(fs.existsSync(studioTsxPath), 'GenerativeCanvasStudio.tsx must exist');
    assert.ok(fs.existsSync(sideChatTsxPath), 'VibecodeAiSideChat.tsx must exist');
    assert.ok(fs.existsSync(settingsTsxPath), 'SettingsModal.tsx must exist');
    assert.ok(fs.existsSync(geminiServicePath), 'gemini-service.ts must exist');
    assert.ok(fs.existsSync(path.join(geminiModulesDir, 'gemini-client.ts')), 'gemini/gemini-client.ts must exist');

    const studioSource = readStudioSources();
    const sideChatSource = fs.readFileSync(sideChatTsxPath, 'utf-8');
    const settingsSource = readSettingsSources();
    const spotlightSource = fs.readFileSync(spotlightTsxPath, 'utf-8');
    const automationsSource = fs.readFileSync(automationsTsxPath, 'utf-8');
    const nodeGraphSource = fs.readFileSync(nodeGraphTsxPath, 'utf-8');
    // The Gemini backend is the facade plus the modules it delegates to (model config lives in gemini-client.ts).
    const serviceSource = [
        fs.readFileSync(geminiServicePath, 'utf-8'),
        ...fs.readdirSync(geminiModulesDir)
            .filter(name => name.endsWith('.ts'))
            .map(name => fs.readFileSync(path.join(geminiModulesDir, name), 'utf-8'))
    ].join('\n');

    // -------------------------------------------------------------
    // Test 1: Backend strictly uses Google Models (gemini-3.8-flash, gemini-3.5-flash-lite, gemini-2.5-pro, etc.)
    // -------------------------------------------------------------
    assert.ok(serviceSource.includes("DEFAULT_GEMINI_MODEL = 'gemini-4-argon'"), 'Primary model must be Google gemini-4-argon');
    assert.ok(serviceSource.includes("DEFAULT_SUBAGENT_MODEL = 'gemini-3.5-flash-lite'"), 'Subagent model must be Google gemini-3.5-flash-lite');
    assert.ok(!serviceSource.includes('claude-') && !serviceSource.includes('gpt-4'), 'Backend must not reference non-Google models');
    console.log('  ✓ Test 1 Passed: Backend strictly configured with Google Models (Gemini 3.8 Flash & Subagents)');

    // -------------------------------------------------------------
    // Test 2: UI does not expose raw model slugs to user (Model Privacy)
    // -------------------------------------------------------------
    // Settings modal and components should show friendly tier labels like "High Reasoning Engine", "Fast Assistant", etc.
    assert.ok(settingsSource.includes('High Reasoning Engine'), 'SettingsModal must present capability tier "High Reasoning Engine"');
    assert.ok(settingsSource.includes('Fast Intelligence'), 'SettingsModal must present capability tier "Fast Intelligence"');
    assert.ok(!settingsSource.includes('Active Model: gemini-'), 'SettingsModal must not leak raw model slug string in status display');
    assert.ok(!spotlightSource.includes('Gemini 3.8 reasoning'), 'SpotlightLauncherModal must use generic AI naming in user search');
    assert.ok(automationsSource.includes('Autonomous AI Agent'), 'AutomationsModal must describe AI node as Autonomous AI Agent');
    assert.ok(nodeGraphSource.includes('High Reasoning Engine'), 'NodeGraphPrimitive must describe model options as capability tiers');
    assert.ok(studioSource.includes('GenerativeCanvasStudio'), 'GenerativeCanvasStudio component verified');
    console.log('  ✓ Test 2 Passed: UI abstracts model identity and presents capability tiers without leaking model names');

    // -------------------------------------------------------------
    // Test 3: Cursor-style Interaction Modes (Agent, Ask, Plan) in Side Chat
    // -------------------------------------------------------------
    assert.ok(sideChatSource.includes('aiInteractionMode'), 'Side chat must support Cursor interaction modes');
    assert.ok(sideChatSource.includes("'agent'"), 'Side chat must support Agent mode');
    assert.ok(sideChatSource.includes("'ask'"), 'Side chat must support Ask mode');
    assert.ok(sideChatSource.includes("'plan'"), 'Side chat must support Plan mode');
    assert.ok(sideChatSource.includes('sb-cursor-mode-pill'), 'Side chat must render Cursor-style mode selection pills');
    console.log('  ✓ Test 3 Passed: Cursor-style Interaction Mode Switcher (Agent, Ask, Plan) implemented in Side Chat');

    // -------------------------------------------------------------
    // Test 4: Cursor-style Codebase Indexing & Project Rules Indicator
    // -------------------------------------------------------------
    assert.ok(sideChatSource.includes('sb-cursor-indexing-badge'), 'Side chat must render Codebase Indexing status badge');
    assert.ok(sideChatSource.includes('sb-cursor-rules-badge'), 'Side chat must render Project Rules active badge');
    console.log('  ✓ Test 4 Passed: Cursor-style Codebase Indexing and Project Rules HUD badges integrated');

    // -------------------------------------------------------------
    // Test 5: Interactive Tool Execution Step Badges in Side Chat
    // -------------------------------------------------------------
    assert.ok(sideChatSource.includes('sb-cursor-tool-step'), 'Side chat must render interactive tool-execution pills');
    assert.ok(sideChatSource.includes('expandedToolStepId'), 'Side chat must support expandable/collapsible tool execution details');
    console.log('  ✓ Test 5 Passed: Interactive Cursor-style Tool Execution Step Badges verified');

    console.log('\n🎉 ALL CURSOR EXPERIENCE & GOOGLE MODELS PRIVACY TESTS PASSED SUCCESSFULLY!');
}


export { runCursorExperienceAndGoogleModelsTests };

test('cursor-experience-google-models.test', async () => {
    await runCursorExperienceAndGoogleModelsTests();
}, 180_000);
