import { test } from 'vitest';
import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import {
    createDefaultToolRegistry,
    assertSafeWorkspacePath,
    isProtectedInternalPath
} from '../src/node/gemini/tool-registry';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

test('Physical Filesystem Sandboxing & Path Guards', () => {
    // 1. Verify protected path detection
    assert.strictEqual(isProtectedInternalPath('dist-electron'), true);
    assert.strictEqual(isProtectedInternalPath('dist-electron/main.js'), true);
    assert.strictEqual(isProtectedInternalPath('.scratchbox'), true);
    assert.strictEqual(isProtectedInternalPath('.scratchbox/memory.json'), true);
    assert.strictEqual(isProtectedInternalPath('node_modules'), true);
    assert.strictEqual(isProtectedInternalPath('node_modules/three/package.json'), true);
    assert.strictEqual(isProtectedInternalPath('.cache/build.json'), true);

    // 2. Safe user paths should not be protected
    assert.strictEqual(isProtectedInternalPath('src/App.tsx'), false);
    assert.strictEqual(isProtectedInternalPath('components/Button.tsx'), false);
    assert.strictEqual(isProtectedInternalPath('README.md'), false);
    assert.strictEqual(isProtectedInternalPath('assets/models/asteroid.glb'), false);

    // 3. assertSafeWorkspacePath throws on protected paths
    assert.throws(() => {
        assertSafeWorkspacePath('dist-electron/main.js', 'read');
    }, /(?:Cursor|Scratchbox) Sandbox Protection/);

    assert.throws(() => {
        assertSafeWorkspacePath('.scratchbox/keys.json', 'write');
    }, /(?:Cursor|Scratchbox) Sandbox Protection/);

    // Safe path does not throw
    assert.doesNotThrow(() => {
        assertSafeWorkspacePath('src/main.ts', 'read');
    });
});

test('Declarative Canvas Primitive Mounting Tool', async () => {
    const registry = createDefaultToolRegistry();
    const decls = registry.declarations();
    const mountDecl = decls.find(d => d.name === 'mount_canvas_primitive');
    assert.ok(mountDecl, 'mount_canvas_primitive tool must be registered');
    assert.strictEqual(mountDecl?.name, 'mount_canvas_primitive');

    const result = await registry.dispatch(
        'mount_canvas_primitive',
        {
            primitiveType: '3d-scene',
            title: 'Deep Space Nebula Asteroid Field',
            summary: 'High-fidelity procedural asteroid field with C++ generator',
            payload: {
                title: 'Deep Space Nebula Asteroid Field',
                sceneType: 'space',
                lighting: { ambientColor: '#101428', ambientIntensity: 0.8 },
                meshes: [
                    { name: 'CoreAsteroid', type: 'sphere', position: [0, 0, 0] }
                ]
            }
        },
        {
            workspaceRoot: process.cwd(),
            request: { prompt: 'build an asteroid field' } as any,
            browserProxy: {} as any
        }
    );

    assert.ok(result, 'Result must be returned');
    assert.strictEqual(result.resultPayload.status, 'success');
    assert.strictEqual(result.resultPayload.primitiveType, '3d-scene');
    assert.strictEqual(result.resultPayload.title, 'Deep Space Nebula Asteroid Field');

    const artifact = (result.resultPayload as any).artifact;
    assert.ok(artifact, 'CanvasArtifact must be constructed in resultPayload');
    assert.strictEqual(artifact.type, '3d-scene');
    assert.strictEqual(artifact.title, 'Deep Space Nebula Asteroid Field');
    assert.strictEqual(artifact.data.sceneType, 'space');
});

test('C++20 Compilation Cache & Instant Native Replay', async () => {
    const compiler = new NativeCppCompilerService();
    const testDir = path.resolve(process.cwd(), 'build/3d-native/test-cache-verify');
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }

    const testSource = `#include <iostream>
int main() {
    std::cout << "Cursor-grade cached replay test" << std::endl;
    return 0;
}`;

    // First compilation
    const firstResult = await compiler.compileSource(testSource, {
        outputDir: testDir,
        outputBinaryName: 'cache_test_bin'
    });
    assert.strictEqual(firstResult.success, true, `First compilation failed: ${firstResult.compilerOutput}`);

    // Second compilation with exact same source should hit SHA-256 cache
    const secondResult = await compiler.compileSource(testSource, {
        outputDir: testDir,
        outputBinaryName: 'cache_test_bin_2'
    });
    assert.strictEqual(secondResult.success, true);
    assert.ok(secondResult.compilerOutput?.includes('Hit compilation cache'), 'Should hit SHA-256 binary cache');
});
