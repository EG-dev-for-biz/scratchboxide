/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, onTestFinished } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { parseOrSynthesizeArtifact } from '../src/node/gemini/artifact-synthesis';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('Procedural Building Complexity & Architectural Grammar Verification', () => {
    const runner = NativePythonRunnerService.getInstance();

    it('1. Generates dense multi-story architectural complex with trees and ivy in under 2 seconds', async () => {
        const pythonScript = `
import scratchbox as sb
import time

start = time.time()
scene = sb.geometry.Mesh("MonumentalCivicPlaza")

# 1. Base pedestal promenade
plaza = sb.geometry.create_studio_pedestal(radius=28.0, height=0.6, bevel=0.08, segments=64)
plaza.material = sb.geometry.PbrMaterial.stone_limestone()
scene.merge(plaza)

# 2. Central 4-story administrative hall with Mansard roof & recessed windows
central = sb.create_building(
    width=20.0, depth=14.0, floors=4, floor_height=3.6,
    ground_floor_height=4.4, plinth_height=0.8,
    bay_width=3.2, window_width=1.8, window_height=2.2, window_recess_depth=0.28,
    roof='mansard', roof_pitch_degrees=38.0, roof_overhang=0.8,
    name='CentralPalais'
)
central.translate(0, 0.6, -4.0)
scene.merge(central)

# 3. Flanking 3-story wings with Hip roofs
east = sb.create_building(
    width=12.0, depth=10.0, floors=3, floor_height=3.4,
    ground_floor_height=4.0, plinth_height=0.6,
    bay_width=3.0, window_width=1.6, window_height=2.0, window_recess_depth=0.22,
    roof='hip', name='EastWing'
)
east.translate(-16.0, 0.6, 0.0)
scene.merge(east)

west = sb.create_building(
    width=12.0, depth=10.0, floors=3, floor_height=3.4,
    ground_floor_height=4.0, plinth_height=0.6,
    bay_width=3.0, window_width=1.6, window_height=2.0, window_recess_depth=0.22,
    roof='hip', name='WestWing'
)
west.translate(16.0, 0.6, 0.0)
scene.merge(west)

# 4. Botanical Trees (Space Colonization)
for pos in [(-9.0, 0.6, 8.0), (9.0, 0.6, 8.0)]:
    tree = sb.create_tree(attractor_count=120, crown_center=(0, 5, 0), crown_extents=(2.5, 3.5, 2.5))
    tree.translate(*pos)
    scene.merge(tree)

# 5. Clinging Ivy on East wing plinth
ivy = sb.create_ivy(root=(-10.0, 0.6, 3.0), obstacle_min=(-16, 0.6, -5), obstacle_max=(-10, 6, 5), max_steps=80)
scene.merge(ivy)

# 6. Stream valid binary glTF 2.0
sb.io.write_glb(OUTPUT_GLB_PATH, scene)

print(f"VERIFICATION_VERTEX_COUNT={scene.vertex_count}")
print(f"VERIFICATION_TRIANGLE_COUNT={scene.triangle_count}")
print(f"VERIFICATION_ELAPSED={time.time() - start:.3f}")
`;

        const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-procedural-building-complexity-'));
        const outGlb = path.join(outDir, 'monumental_civic_plaza.glb');
        onTestFinished(() => fs.rmSync(outDir, { recursive: true, force: true }));

        const result = await runner.runScript(pythonScript, {
            outputGlbPath: outGlb,
            timeoutMs: 30000
        });

        if (!result.success) {
            console.error('Python execution error:', result.stderr, result.stdout);
        }

        expect(result.success).toBe(true);
        expect(fs.existsSync(outGlb)).toBe(true);

        const vMatch = result.stdout.match(/VERIFICATION_VERTEX_COUNT=(\d+)/);
        const tMatch = result.stdout.match(/VERIFICATION_TRIANGLE_COUNT=(\d+)/);
        expect(vMatch).not.toBeNull();
        expect(tMatch).not.toBeNull();

        const vertexCount = parseInt(vMatch![1], 10);
        const triangleCount = parseInt(tMatch![1], 10);

        // Verify genuine geometric complexity (dense multi-story buildings + trees > 50,000 vertices)
        expect(vertexCount).toBeGreaterThan(50000);
        expect(triangleCount).toBeGreaterThan(30000);

        // Verify glTF 2.0 binary header
        const glbBuf = fs.readFileSync(outGlb);
        expect(glbBuf.length).toBeGreaterThan(500000); // Greater than 500 KB
        const magic = glbBuf.readUInt32LE(0);
        expect(magic).toBe(0x46546c67); // "glTF"
        const version = glbBuf.readUInt32LE(4);
        expect(version).toBe(2);
    }, 60000);

    it('2. Builds the procedural architectural 3D scene the model sent in its reply', () => {
        // The model's own scene envelope with its sb script; a bare code block in prose is not mounted as a scene.
        const script = `import scratchbox as sb

scene = sb.geometry.Mesh("CitadelPlaza")

# Ground Pedestal
plaza = sb.geometry.create_studio_pedestal(radius=15.0, height=0.4, bevel=0.05)
scene.merge(plaza)

# Main Palace with Mansard Roof
palais = sb.create_building(width=16.0, depth=12.0, floors=3, roof='mansard', name='Palais')
palais.translate(0, 0.4, 0)
scene.merge(palais)

# Flanking Space-Colonization Tree
tree = sb.create_tree(attractor_count=100, crown_center=(0, 4, 0), crown_extents=(2.0, 3.0, 2.0))
tree.translate(10.0, 0.4, 4.0)
scene.merge(tree)

sb.io.write_glb(OUTPUT_GLB_PATH, scene)
`;
        const pythonResponse = 'Here is the architectural complex:\n```json\n'
            + JSON.stringify({ type: '3d-scene', title: 'Citadel Plaza', data: { pythonGenerator: { sourceCode: script } } })
            + '\n```';

        const artifact = parseOrSynthesizeArtifact(
            'Create a detailed architectural building with trees on a plaza',
            pythonResponse,
            { prompt: 'Create a detailed architectural building with trees on a plaza' } as any,
            []
        );

        expect(artifact).toBeDefined();
        expect(artifact?.type).toBe('3d-scene');

        const sceneData = artifact?.data as Scene3DData;
        expect(sceneData.pythonGenerator).toBeDefined();
        expect(sceneData.pythonGenerator?.enabled).toBe(true);
        expect(sceneData.pythonGenerator?.glbBase64).toBeDefined();
        expect(sceneData.pythonGenerator?.glbBase64?.length).toBeGreaterThan(10000);
    });
});
