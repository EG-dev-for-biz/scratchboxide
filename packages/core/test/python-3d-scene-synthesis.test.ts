import { describe, it, expect } from 'vitest';
import { parseOrSynthesizeArtifact, generateNativeCppGenerator } from '../src/node/gemini/artifact-synthesis';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('Python 3D Scene Architecture & Grounded Zero-Defaults Verification', () => {
    it('1. Synthesizes 3d-scene artifact directly from python scratchbox code block without falling back to live-code-sandbox', () => {
        const pythonCode = `\`\`\`python
import scratchbox as sb

# Create a grounded showcase pedestal
pedestal = sb.geometry.create_studio_pedestal(radius=3.5, height=0.3, bevel_radius=0.04)

# Create an architectural test cube
cube = sb.geometry.create_cube(width=1.5, height=1.5, depth=1.5)
cube.translate(0.0, 1.0, 0.0)

# Merge and stream directly
scene = sb.geometry.Mesh()
scene.append(pedestal)
scene.append(cube)
sb.io.export_glb(scene)
\`\`\``;

        const modelResponse = `Here is the procedural 3D scene designed using the Blender mental model:\n\n${pythonCode}\n\nThe scene is now rendered with a grounded pedestal.`;

        const artifact = parseOrSynthesizeArtifact(
            'Create a procedural 3D sculpture on a pedestal',
            modelResponse,
            { prompt: 'Create a procedural 3D sculpture on a pedestal' } as any,
            []
        );

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('3d-scene');

        const sceneData = artifact?.data as Scene3DData;
        expect(sceneData.pythonGenerator).toBeDefined();
        expect(sceneData.pythonGenerator?.enabled).toBe(true);
        expect(sceneData.pythonGenerator?.sourceCode).toContain('import scratchbox as sb');
        expect(sceneData.pythonGenerator?.glbBase64).toBeDefined();
        expect(typeof sceneData.pythonGenerator?.glbBase64).toBe('string');
        expect(sceneData.pythonGenerator?.glbBase64?.length).toBeGreaterThan(50);
    });

    it('2. Neutralizes floating wavy cloth by emitting a grounded studio pedestal when terrain is not explicitly requested', () => {
        const cppCode = generateNativeCppGenerator('Cyberpunk Outpost Laboratory');
        expect(cppCode).toContain('generateStudioPedestal');
        expect(cppCode).not.toContain('ProceduralTerrainSDF');
        expect(cppCode).not.toContain('sphereBound * 0.15f');
    });

    it('3. Generates grounded geological terrain with edge damping to ground plane (y=0) when terrain is explicitly requested', () => {
        const cppCode = generateNativeCppGenerator('Rocky Canyon Mountain Landscape');
        expect(cppCode).toContain('Grounded Geological Terrain');
        expect(cppCode).toContain('edgeFade');
        expect(cppCode).not.toContain('ProceduralTerrainSDF');
        expect(cppCode).not.toContain('sphereBound * 0.15f');
    });
});
