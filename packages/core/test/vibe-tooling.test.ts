/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import { test } from 'vitest';
import * as assert from 'assert';
import {
    isVibeToolRequest,
    extractToolTitle,
    synthesizeVibeToolSandbox
} from '../src/browser/generative-canvas/vibe-tool-synthesizer';
import {
    buildSandboxSrcDoc
} from '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
import { PrimitiveSynthesizer } from '../src/node/deep-write/primitive-synthesizer';

test('vibe-tooling.test', () => {


    console.log('🧪 Running Vibe-Coding Custom Tools & Micro-Studios Test Suite...\n');

    // ----------------------------------------------------
    // Test 1: Vibe Tool Prompt Intent Detection
    // ----------------------------------------------------
    console.log('  Testing Vibe Tool Intent Detection...');
    const testPrompts = [
        { prompt: 'vibe code a 3D pre-blocking tool for this scene', expected: true },
        { prompt: 'build a custom blocking studio with camera controls', expected: true },
        { prompt: 'create a micro-studio for shot pre-viz', expected: true },
        { prompt: 'make an editor app for directing video scenes', expected: true },
        { prompt: 'vibe-code a camera sequencer tool', expected: true },
        { prompt: 'explain how the react useEffect hook works', expected: false },
        { prompt: 'fix this python syntax error', expected: false }
    ];

    testPrompts.forEach(({ prompt, expected }) => {
        const result = isVibeToolRequest(prompt);
        assert.strictEqual(
            result,
            expected,
            `Expected isVibeToolRequest("${prompt}") to be ${expected}, got ${result}`
        );
    });
    console.log('  ✓ Test 1 Passed: Vibe-tool intent detector accurately matches custom tool requests');

    // ----------------------------------------------------
    // Test 2: Tool Title Extraction
    // ----------------------------------------------------
    console.log('  Testing Tool Title Extraction...');
    assert.strictEqual(extractToolTitle('vibe code a 3D blocking tool for this scene'), '3D Blocking Studio');
    assert.strictEqual(extractToolTitle('build a camera sequencer for our movie'), 'Camera Sequencer Studio');
    assert.strictEqual(extractToolTitle('make a custom scene editor'), 'Custom Scene Editor');
    console.log('  ✓ Test 2 Passed: Title extraction extracts clean, human-readable studio names');

    // ----------------------------------------------------
    // Test 3: Micro-Studio Synthesizer Schema & Features
    // ----------------------------------------------------
    console.log('  Testing Micro-Studio Synthesizer Contracts...');
    const studioSandbox = synthesizeVibeToolSandbox('vibe code a 3D blocking tool', 'Pre-Blocking Studio');

    assert.strictEqual(studioSandbox.title, 'Pre-Blocking Studio');
    assert.strictEqual(studioSandbox.template, 'react');
    assert.ok(studioSandbox.dependencies?.['three'], 'Dependencies must include three.js');
    assert.ok(studioSandbox.dependencies?.['lucide-react'], 'Dependencies must include lucide-react');

    const entryFile = studioSandbox.files.find(f => f.isEntry);
    assert.ok(entryFile, 'Studio must have an entrypoint file');
    assert.ok(entryFile.content.includes('OrbitControls'), 'Entrypoint must import Three.js OrbitControls');
    assert.ok(entryFile.content.includes('Free Orbit Camera'), 'Entrypoint must include Director Free Orbit Camera');
    assert.ok(entryFile.content.includes('Shot Reference Camera'), 'Entrypoint must include Shot Reference Camera');
    assert.ok(entryFile.content.includes('exportBlockingPass'), 'Entrypoint must wire into window.scratchbox media export bridge');
    assert.ok(entryFile.content.includes('Focal Length (FOV)'), 'Entrypoint must include focal length / lens inspector');
    assert.ok(entryFile.content.includes('120 Frames'), 'Entrypoint must include timeline scrubber dock');
    console.log('  ✓ Test 3 Passed: Synthesized micro-studio satisfies all spatial pre-blocking requirements');

    // ----------------------------------------------------
    // Test 4: Sandbox HTML Bundler with Three.js & Host RPC Bridge
    // ----------------------------------------------------
    console.log('  Testing Sandbox HTML Bundler with ESM Import Maps & RPC Bridge...');
    const srcDoc = buildSandboxSrcDoc(studioSandbox);

    // Verify Import Map entries
    assert.ok(srcDoc.includes('"three": "https://esm.sh/three@0.160.0"'), 'Import map must map three');
    assert.ok(srcDoc.includes('"three/addons/": "https://esm.sh/three@0.160.0/examples/jsm/"'), 'Import map must map three/addons/');
    assert.ok(srcDoc.includes('"@react-three/fiber"'), 'Import map must map @react-three/fiber');

    // Verify Host SDK RPC Bridge
    assert.ok(srcDoc.includes('window.scratchbox = {'), 'srcDoc must inject window.scratchbox SDK bridge');
    assert.ok(srcDoc.includes('sb-tool-rpc-request'), 'RPC bridge must post sb-tool-rpc-request messages');
    assert.ok(srcDoc.includes('operators: {'), 'RPC bridge must provide operators namespace');
    assert.ok(srcDoc.includes('media: {'), 'RPC bridge must provide media export namespace');
    assert.ok(srcDoc.includes('window.THREE = THREE;'), 'Babel module script must bind global window.THREE');
    console.log('  ✓ Test 4 Passed: Sandbox HTML bundler packages Three.js ESM maps and @scratchbox/tool-sdk bridge');

    // ----------------------------------------------------
    // Test 5: DeepWrite PrimitiveSynthesizer Studio Tool Integration
    // ----------------------------------------------------
    console.log('  Testing PrimitiveSynthesizer Studio Tool Integration...');
    const synth = new PrimitiveSynthesizer();
    const synthesizedTool = synth.synthesizeStudioTool('Director Blocking Tool', 'build a blocking tool');
    assert.ok(synthesizedTool, 'PrimitiveSynthesizer must return a synthesized tool');
    assert.strictEqual(synthesizedTool.template, 'react');
    assert.ok(synthesizedTool.dependencies?.['three'], 'Must include three in dependencies');
    console.log('  ✓ Test 5 Passed: PrimitiveSynthesizer exposes synthesizeStudioTool for autonomous planning');

    console.log('\n🎉 ALL VIBE-CODED CUSTOM TOOL TESTS PASSED SUCCESSFULLY!\n');

});
