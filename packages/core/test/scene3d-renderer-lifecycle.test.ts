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

const GC_DIR = path.resolve(__dirname, '../src/browser/generative-canvas');
const SCENE3D_PATH = path.join(GC_DIR, 'primitives/Scene3DPrimitive.tsx');
const SCENE3D_HELPERS_DIR = path.join(GC_DIR, 'primitives/scene3d');

/**
 * Finds the `React.useEffect(` (or `useEffect(`) block that contains `needle` and returns
 * the effect body plus its trailing dependency array source.
 */
function findEffectContaining(source: string, needle: string): { body: string; deps: string } {
    const needleIdx = source.indexOf(needle);
    assert.ok(needleIdx >= 0, `Source must contain "${needle}"`);

    const effectRegex = /(?:React\.)?useEffect\(\s*\(\)\s*=>\s*\{/g;
    let start = -1;
    let m: RegExpExecArray | null;
    while ((m = effectRegex.exec(source)) !== null) {
        if (m.index > needleIdx) break;
        start = m.index;
    }
    assert.ok(start >= 0, `"${needle}" must live inside a useEffect`);

    // Walk braces from the arrow-function body opening brace to find the closing one.
    const bodyOpen = source.indexOf('{', source.indexOf('=>', start));
    let depth = 0;
    let i = bodyOpen;
    for (; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    const body = source.slice(bodyOpen, i + 1);
    const afterBody = source.slice(i + 1, i + 4000);
    const depsMatch = afterBody.match(/^\s*,\s*(\[[\s\S]*?\])\s*\)/);
    assert.ok(depsMatch, `useEffect containing "${needle}" must declare a dependency array`);
    return { body, deps: depsMatch![1] };
}

async function runScene3DRendererLifecycleTests() {
    console.log('🧪 Running Scene3D Renderer Lifecycle Test Suite...\n');

    assert.ok(fs.existsSync(SCENE3D_PATH), 'Scene3DPrimitive.tsx must exist');
    const primitiveSource = fs.readFileSync(SCENE3D_PATH, 'utf-8');

    // Gather helper module sources (renderer stack + slice sync helpers)
    assert.ok(fs.existsSync(SCENE3D_HELPERS_DIR), 'primitives/scene3d/ helper folder must exist');
    const helperFiles = fs.readdirSync(SCENE3D_HELPERS_DIR).filter(f => f.endsWith('.ts'));
    const helperSources: Record<string, string> = {};
    for (const f of helperFiles) {
        helperSources[f] = fs.readFileSync(path.join(SCENE3D_HELPERS_DIR, f), 'utf-8');
    }
    const combinedSource = primitiveSource + '\n' + Object.values(helperSources).join('\n');

    // -------------------------------------------------------------
    // Test 1: Exactly one WebGLRenderer construction across primitive + helpers
    // -------------------------------------------------------------
    console.log('  Testing single WebGLRenderer construction site...');
    const rendererCtorCount = (combinedSource.match(/new THREE\.WebGLRenderer\(/g) || []).length;
    assert.strictEqual(rendererCtorCount, 1, `Expected exactly one "new THREE.WebGLRenderer(" (found ${rendererCtorCount})`);
    assert.ok(fs.existsSync(path.join(SCENE3D_HELPERS_DIR, 'createRendererStack.ts')), 'createRendererStack.ts helper must exist');
    assert.ok(helperSources['createRendererStack.ts'].includes('new THREE.WebGLRenderer('), 'Renderer must be constructed inside createRendererStack.ts');
    console.log('  ✓ Test 1 Passed: renderer is constructed in exactly one place.');

    // -------------------------------------------------------------
    // Test 2: The mount effect that creates the renderer stack has no per-slice object-identity deps
    // -------------------------------------------------------------
    console.log('  Testing renderer-stack effect dependency array...');
    const mountEffect = findEffectContaining(primitiveSource, 'createRendererStack(');
    const forbiddenDeps = [
        /sceneData\.objects/, /sceneData\.features/, /sceneData\.shaders/, /sceneData\.customMeshes/,
        /sceneData\.environment/, /sceneData\.title/, /sceneData\.sceneType/, /sceneData\.customScript/,
        /data\?\.objects/, /data\?\.features/, /data\?\.shaders/, /data\?\.customMeshes/, /data\?\.title/,
        /\brenderMode\b/, /\bcameraMode\b/, /\bisAirplane\b/, /\bworldBranch\b/, /\bhasGeoCoordinates\b/
    ];
    for (const fd of forbiddenDeps) {
        assert.ok(!fd.test(mountEffect.deps), `Renderer-stack effect deps must not include ${fd} (got ${mountEffect.deps})`);
    }
    const depsTokens = mountEffect.deps.replace(/[\[\]\s]/g, '').split(',').filter(Boolean);
    assert.ok(depsTokens.length <= 1, `Renderer-stack effect must be mount-once (deps: ${mountEffect.deps})`);
    console.log('  ✓ Test 2 Passed: renderer-stack effect is mount-once.');

    // -------------------------------------------------------------
    // Test 3: Renderer disposal still lives in a cleanup path
    // -------------------------------------------------------------
    console.log('  Testing renderer.dispose() cleanup...');
    assert.ok(/renderer\.dispose\(\)/.test(combinedSource), 'renderer.dispose() must still be invoked on teardown');
    assert.ok(/dispose\(\)/.test(mountEffect.body) || /return\s+\(\)\s*=>/.test(mountEffect.body) || /return\s+\w+\.dispose/.test(mountEffect.body), 'Mount effect must return a cleanup that disposes the renderer stack');
    console.log('  ✓ Test 3 Passed: renderer disposal preserved.');

    // -------------------------------------------------------------
    // Test 4: Custom meshes sync in a dedicated effect keyed by a fingerprint
    // -------------------------------------------------------------
    console.log('  Testing customMeshes slice sync effect...');
    const customMeshEffect = findEffectContaining(primitiveSource, 'syncCustomMeshes(');
    assert.ok(/[Ff]ingerprint|Ids\b/.test(customMeshEffect.deps), `customMeshes effect deps must use a fingerprint/ids (got ${customMeshEffect.deps})`);
    assert.ok(!/sceneData\.customMeshes/.test(customMeshEffect.deps), 'customMeshes effect must not depend on the array identity');
    assert.ok(/useMemo\([\s\S]*?JSON\.stringify\([\s\S]*?customMeshes/.test(primitiveSource), 'A useMemo JSON fingerprint of customMeshes must exist');
    assert.ok(fs.existsSync(path.join(SCENE3D_HELPERS_DIR, 'syncCustomMeshes.ts')), 'syncCustomMeshes.ts helper must exist');
    console.log('  ✓ Test 4 Passed: customMeshes synchronise via fingerprint-keyed effect.');

    // -------------------------------------------------------------
    // Test 5: Other slices (atmosphere, tiles, scene content, shaders) are also split out
    // -------------------------------------------------------------
    console.log('  Testing per-slice sync helpers...');
    for (const helper of ['syncAtmosphere.ts', 'syncTilesLayer.ts', 'syncSceneContent.ts', 'syncCustomShaders.ts']) {
        assert.ok(fs.existsSync(path.join(SCENE3D_HELPERS_DIR, helper)), `${helper} helper must exist`);
    }
    for (const call of ['syncAtmosphere(', 'syncTilesLayer(', 'syncSceneContent(', 'syncCustomShaders(']) {
        const eff = findEffectContaining(primitiveSource, call);
        assert.ok(!/new THREE\.WebGLRenderer/.test(eff.body), `${call} effect must not construct a renderer`);
    }
    console.log('  ✓ Test 5 Passed: atmosphere / tiles / content / shaders each sync in their own effect.');

    // -------------------------------------------------------------
    // Test 6: Mirror-state-into-ref boilerplate replaced by useLatest
    // -------------------------------------------------------------
    console.log('  Testing useLatest adoption...');
    assert.ok(fs.existsSync(path.join(GC_DIR, 'hooks/useLatest.ts')), 'hooks/useLatest.ts must exist');
    assert.ok(primitiveSource.includes('useLatest('), 'Scene3DPrimitive must use useLatest for mirrored refs');
    const mirrorEffects = (primitiveSource.match(/React\.useEffect\(\(\) => \{ \w+Ref\.current = \w+; \}, \[\w+\]\);/g) || []).length;
    assert.strictEqual(mirrorEffects, 0, `No one-line "mirror state into ref" effects should remain (found ${mirrorEffects})`);
    console.log('  ✓ Test 6 Passed: useLatest replaces mirror effects.');

    // -------------------------------------------------------------
    // Test 7: Behavioural surface preserved (sculpting, gizmo, tiles, splat, FPS, atmosphere, wireframe, undo/redo, sky presets)
    // -------------------------------------------------------------
    console.log('  Testing preserved behavioural surface...');
    const mustContain = [
        'applySculptStroke', 'TransformGizmoEngine', 'GooglePhotorealistic3DTilesLayer', 'InHouseSplatViewer',
        "cameraMode === 'orbit'", 'createAtmosphericSkyDome', 'wireframeOverlay', 'handleUndo', 'handleRedo',
        'FogExp2', "skybox === 'sunset'", 'ResizeObserver', 'requestAnimationFrame'
    ];
    for (const token of mustContain) {
        assert.ok(combinedSource.includes(token), `Refactored Scene3D must still reference "${token}"`);
    }
    console.log('  ✓ Test 7 Passed: behavioural surface preserved.');

    console.log('\n🎉 ALL SCENE3D RENDERER LIFECYCLE TESTS PASSED SUCCESSFULLY!');
}

test('scene3d-renderer-lifecycle.test', async () => {
    await runScene3DRendererLifecycleTests();
}, 60_000);
