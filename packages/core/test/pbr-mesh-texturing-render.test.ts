/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * pbr_synthesize_material on a mesh, rendered by three.js in headless Chrome: the pixels show whether the synthesized
 * maps really reach the surface. A sample two-part scene always runs; a real multi-part asset runs too when
 * SCRATCHBOX_PBR_RENDER_GLB names one (e.g. the 25-part telescope build/3d-python/scene_1792093922094_xutp0u.glb),
 * with SCRATCHBOX_PBR_RENDER_PARTS optionally giving partMaterials as JSON. Screenshots: test-results/screenshots/pbr/.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pbrMaterialHandlers } from '../src/node/gemini/tools/pbr-material-tools';
import { renderTwinInChrome, twinChrome } from './helpers/texture-twin-chrome';
import { buildSceneGlb } from './helpers/textured-glb-scene';
import { cylinderMesh, uvCubeMesh } from './helpers/mesh-glb-fixtures';
import { REPO_ROOT, requireAll, requireBinary, withReason } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results', 'screenshots', 'pbr');
const ready = requireAll(twinChrome, requireBinary(process.env.CXX || 'clang++', 'install Xcode command line tools (clang++)'));
const REAL = process.env.SCRATCHBOX_PBR_RENDER_GLB;

async function textureAndRender(input: Buffer, name: string, args: Record<string, unknown>, renderInput: boolean) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `sb-pbr-render-${name}-`));
    try {
        const meshPath = path.join(work, `${name}.glb`);
        fs.writeFileSync(meshPath, input);
        const res: any = await pbrMaterialHandlers.pbr_synthesize_material({ targetMeshPath: meshPath, outputDir: work, ...args }, {} as any);
        const out = fs.readFileSync(path.join(work, `${name}_adaptive_pbr.glb`));
        // the shared Chrome helper needs a materials array, which an untextured fixture may not have
        const before = renderInput ? await renderTwinInChrome(input, path.join(SHOTS, `${name}_input.png`), { bearingDeg: 35, elevationDeg: 18 }) : undefined;
        const after = await renderTwinInChrome(out, path.join(SHOTS, `${name}_textured.png`), { bearingDeg: 35, elevationDeg: 18 });
        const close = await renderTwinInChrome(out, path.join(SHOTS, `${name}_textured_close.png`), { bearingDeg: 35, elevationDeg: 18, distanceScale: 0.45 });
        return { res, out, before, after, close };
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}

describe('pbr_synthesize_material textures a mesh that three.js then renders with those textures', () => {
    it.skipIf(!ready.ok)(withReason('a two-part sample scene: every mesh renders with UVs and its own 1K baseColor map', ready), async () => {
        const scene = buildSceneGlb(
            [{ name: 'barrel_mesh', primitives: [{ mesh: cylinderMesh(0.5, 2, 48, 8) }] }, { name: 'block_mesh', primitives: [{ mesh: uvCubeMesh(1.0) }] }],
            [{ name: 'barrel', mesh: 0, translation: [0.8, 0, 0] }, { name: 'block', mesh: 1, translation: [-0.8, -0.5, 0] }]
        );
        const { res, before, after, close } = await textureAndRender(scene, 'sample', {
            resolution: '1K', tileSizeMeters: 0.5,
            partMaterials: [{ nodes: ['barrel'], materialArchetype: 'copper_verdigris' }, { nodes: ['block'], materialArchetype: 'flemish_brick' }]
        }, false);
        expect(after.errors).toEqual([]);
        expect(after.textured.length).toBe(2);
        for (const t of after.textured) expect(t, t.name).toMatchObject({ hasUv: true, map: true });
        expect(after.images.every(i => i.width === 1024 && i.height === 1024)).toBe(true);
        expect(fs.statSync(close.file).size).toBeGreaterThan(10_000);
        expect(res.resultPayload.boxProjection.textureSets.map((s: any) => s.synthesizer)).toEqual(['native-cpp20', 'native-cpp20']);
    }, 180_000);

    it.skipIf(!ready.ok || !REAL || !fs.existsSync(REAL))(withReason('a real multi-part asset from SCRATCHBOX_PBR_RENDER_GLB', REAL ? ready : { ok: false, reason: 'SCRATCHBOX_PBR_RENDER_GLB is not set' }), async () => {
        const parts = process.env.SCRATCHBOX_PBR_RENDER_PARTS ? JSON.parse(process.env.SCRATCHBOX_PBR_RENDER_PARTS) : undefined;
        const { res, before, after } = await textureAndRender(fs.readFileSync(REAL!), path.basename(REAL!, '.glb'), {
            resolution: '1K', archetype: 'brushed_titanium', ...(parts ? { partMaterials: parts } : {})
        }, true);
        console.log(res.summaryResult);
        expect(after.errors).toEqual([]);
        expect(after.textured.length).toBeGreaterThan(0);
        expect(before!.textured.some(t => t.map)).toBe(false);
        expect(fs.readFileSync(after.file).equals(fs.readFileSync(before!.file))).toBe(false);
        for (const t of after.textured) expect(t, t.name).toMatchObject({ hasUv: true, map: true });
    }, 300_000);
});
