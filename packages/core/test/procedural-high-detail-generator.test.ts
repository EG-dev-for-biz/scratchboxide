import { describe, it, expect } from 'vitest';
import { synthesizeContextual3DScene, generateDefaultCpp3DSource } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

// Prompts say "procedural" explicitly. Without explicit procedural intent, environmental prompts with no
// named place are creatively cast to a real-world archetype and served as Google 3D Tiles clay
// (sceneType 'worldbuilder', cppGenerator; 6e66ca1). f6f522f deliberately narrowed the procedural-intent
// gate (isExplicitProcedural) to engine keywords and dropped architectural nouns
// (building/architecture/plaza/botanical...) per AGENTS.md "Zero Closed Taxonomies".
describe('High-Detail Procedural Geometric Generation Pipeline', () => {
    it('1. Synthesizes city scene with rich pythonGenerator', () => {
        const scene = synthesizeContextual3DScene('Create a procedural futuristic high-rise metropolitan city skyline with street grid');
        expect(scene.sceneType).toBe('city');
        expect(scene.pythonGenerator).toBeDefined();
        expect(scene.pythonGenerator?.enabled).toBe(true);
        expect(scene.pythonGenerator?.sourceCode).toContain('sb.create_building');
        expect(scene.pythonGenerator?.sourceCode).toContain('sb.create_tree');
        expect(scene.pythonGenerator?.sourceCode).toContain('OUTPUT_GLB_PATH');
    });

    it('2. Synthesizes architectural civic plaza with rich pythonGenerator', () => {
        const scene = synthesizeContextual3DScene('Design a procedural classical civic plaza with municipal palais and botanical trees');
        expect(scene.sceneType).toBe('architecture');
        expect(scene.pythonGenerator).toBeDefined();
        expect(scene.pythonGenerator?.enabled).toBe(true);
        expect(scene.pythonGenerator?.sourceCode).toContain('window_recess_depth');
        expect(scene.pythonGenerator?.sourceCode).toContain('sb.create_ivy');
        expect(scene.pythonGenerator?.sourceCode).toContain('mansard');
    });

    it('3. Synthesizes ziggurat monument with C++20 SDF marching cubes generator', () => {
        const scene = synthesizeContextual3DScene('Construct an ancient Babylonian ziggurat observatory');
        expect(scene.sceneType).toBe('ziggurat');
        expect(scene.cppGenerator).toBeDefined();
        expect(scene.cppGenerator?.enabled).toBe(true);
        expect(scene.cppGenerator?.sourceCode).toContain('MarchingCubesVolume');
        expect(scene.cppGenerator?.sourceCode).toContain('sdBox');
    });

    it('4. Executes city pythonGenerator synchronously to produce binary glTF 2.0', async () => {
        const scene = synthesizeContextual3DScene('Procedural downtown financial district city skyline with high-rise towers');
        expect(scene.sceneType).toBe('city');
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
