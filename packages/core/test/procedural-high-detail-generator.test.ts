import { describe, it, expect } from 'vitest';
import { synthesizeContextual3DScene, generateDefaultCpp3DSource } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { GeometricComplexityGate } from '../src/common/spatial/GeometricComplexityGate';
import { compileAndRunEmittedGenerator, maxIndex, NATIVE_GENERATOR_TEST_TIMEOUT_MS } from './helpers/native-generator-harness';
import * as fs from 'fs';

describe('High-Detail Procedural Geometric Generation Pipeline', () => {
    it('1. Synthesizes city scene with rich pythonGenerator', () => {
        const scene = synthesizeContextual3DScene('Create a futuristic high-rise metropolitan city skyline with street grid');
        expect(scene.sceneType).toBe('city');
        expect(scene.pythonGenerator).toBeDefined();
        expect(scene.pythonGenerator?.enabled).toBe(true);
        expect(scene.pythonGenerator?.sourceCode).toContain('sb.create_building');
        expect(scene.pythonGenerator?.sourceCode).toContain('sb.create_tree');
        expect(scene.pythonGenerator?.sourceCode).toContain('OUTPUT_GLB_PATH');
    });

    it('2. Synthesizes architectural civic plaza with rich pythonGenerator', () => {
        const scene = synthesizeContextual3DScene('Design a classical civic plaza with municipal palais and botanical trees');
        expect(scene.sceneType).toBe('architecture');
        expect(scene.pythonGenerator).toBeDefined();
        expect(scene.pythonGenerator?.enabled).toBe(true);
        expect(scene.pythonGenerator?.sourceCode).toContain('window_recess_depth');
        expect(scene.pythonGenerator?.sourceCode).toContain('sb.create_ivy');
        expect(scene.pythonGenerator?.sourceCode).toContain('mansard');
    });

    it('3. Compiles and executes the ziggurat C++20 SDF marching cubes generator', async () => {
        const scene = synthesizeContextual3DScene('Construct an ancient Babylonian ziggurat observatory');
        expect(scene.sceneType).toBe('ziggurat');
        expect(scene.cppGenerator?.enabled).toBe(true);

        const run = await compileAndRunEmittedGenerator(scene.cppGenerator!.sourceCode, 'ziggurat');
        expect(run.chunk.name).toBe('Babylonian_Ziggurat_Observatory');
        expect(run.glb.vertexCount).toBe(run.chunk.vertexCount);
        expect(run.glb.indexCount).toBe(run.chunk.indexCount);
        expect(run.chunk.indexCount % 3).toBe(0);
        expect(maxIndex(run.glb)).toBeLessThan(run.chunk.vertexCount);
        expect(run.chunk.vertexCount).toBeGreaterThanOrEqual(GeometricComplexityGate.DEFAULT_SCENE_MIN_VERTICES);
        expect(run.triangleCount).toBeGreaterThanOrEqual(GeometricComplexityGate.DEFAULT_SCENE_MIN_TRIANGLES);

        // Union of the three box tiers: 48 m square base on y = 0, top tier ending at y = 19.
        // Marching cubes places the surface within one 60/128 m lattice step of the true faces.
        const step = 60 / 128;
        const { min, max } = run.bounds;
        expect(Math.abs(min[0] + 24)).toBeLessThanOrEqual(step);
        expect(Math.abs(max[0] - 24)).toBeLessThanOrEqual(step);
        expect(Math.abs(min[2] + 24)).toBeLessThanOrEqual(step);
        expect(Math.abs(max[2] - 24)).toBeLessThanOrEqual(step);
        expect(min[1]).toBeGreaterThanOrEqual(0);
        expect(min[1]).toBeLessThanOrEqual(step);
        expect(Math.abs(max[1] - 19)).toBeLessThanOrEqual(step);

        expect(fs.statSync(run.screenshotPath).size).toBeGreaterThan(0);
    }, NATIVE_GENERATOR_TEST_TIMEOUT_MS);

    it('3b. Compiles and executes the pyramidal horn C++20 SDF marching cubes generator', async () => {
        const scene = synthesizeContextual3DScene('Build a pyramidal horn with swiss chalets');
        expect(scene.sceneType).toBe('alpine_valley');
        expect(scene.cppGenerator?.enabled).toBe(true);

        const run = await compileAndRunEmittedGenerator(scene.cppGenerator!.sourceCode, 'pyramidal_horn');
        expect(run.chunk.name).toBe('Matterhorn_Alpine_Valley');
        expect(run.glb.vertexCount).toBe(run.chunk.vertexCount);
        expect(run.glb.indexCount).toBe(run.chunk.indexCount);
        expect(run.chunk.indexCount % 3).toBe(0);
        expect(maxIndex(run.glb)).toBeLessThan(run.chunk.vertexCount);
        expect(run.chunk.vertexCount).toBeGreaterThanOrEqual(GeometricComplexityGate.DEFAULT_SCENE_MIN_VERTICES);
        expect(run.triangleCount).toBeGreaterThanOrEqual(GeometricComplexityGate.DEFAULT_SCENE_MIN_TRIANGLES);

        // The horn stands on y = 0 and is cut at y = 65; its base half-width is 45 m perturbed by
        // at most 1.8 m of strata and 3.5 m of ridge noise, so it never reaches the 52 m volume walls.
        const { min, max } = run.bounds;
        const halfWidth = Math.max(-min[0], max[0], -min[2], max[2]);
        expect(min[1]).toBeLessThan(1);
        expect(max[1]).toBeGreaterThan(55);
        expect(max[1]).toBeLessThanOrEqual(66);
        expect(halfWidth).toBeGreaterThan(40);
        expect(halfWidth).toBeLessThan(51);

        expect(fs.statSync(run.screenshotPath).size).toBeGreaterThan(0);
    }, NATIVE_GENERATOR_TEST_TIMEOUT_MS);

    it('4. Executes city pythonGenerator synchronously to produce binary glTF 2.0', async () => {
        const scene = synthesizeContextual3DScene('Metropolitan city financial district with high-rise towers');
        const runner = NativePythonRunnerService.getInstance();
        const pySource = scene.pythonGenerator?.sourceCode;
        expect(pySource).toBeDefined();

        if (pySource) {
            const res = runner.runScriptSync(pySource);
            if (!res.success) {
                console.error('[TEST 4 ERROR]', res.error, res.stderr, res.stdout);
            }
            expect(res.success).toBe(true);
            expect(res.glbBase64).toBeDefined();
            expect(res.glbBase64!.length).toBeGreaterThan(1000);

            // Verify binary glTF 2.0 header magic ('glTF')
            const buf = Buffer.from(res.glbBase64!, 'base64');
            const magic = buf.toString('utf8', 0, 4);
            expect(magic).toBe('glTF');
            const version = buf.readUInt32LE(4);
            expect(version).toBe(2);
        }
    });

    it('5. Compiles and executes C++20 geometry generator producing streamed GLB chunk', async () => {
        const compiler = new NativeCppCompilerService();
        const cppSource = generateDefaultCpp3DSource('universal_scene', 'ProceduralHeroCore');

        const compileRes = await compiler.compileSource(cppSource, 'test_hero_core.cpp');
        if (!compileRes.success) {
            console.error('[TEST 5 ERROR]', compileRes.compilerOutput, compileRes.diagnostics);
        }
        expect(compileRes.success).toBe(true);
        expect(compileRes.binaryPath).toBeDefined();

        if (compileRes.binaryPath) {
            const execRes = await compiler.executeBinary(compileRes.binaryPath);
            expect(execRes.success).toBe(true);
            expect(execRes.chunks.length).toBeGreaterThan(0);
            expect(execRes.chunks[0].glbBase64).toBeDefined();

            // Validate binary glTF header
            const buf = Buffer.from(execRes.chunks[0].glbBase64!, 'base64');
            const magic = buf.toString('utf8', 0, 4);
            expect(magic).toBe('glTF');
        }
    });
});
