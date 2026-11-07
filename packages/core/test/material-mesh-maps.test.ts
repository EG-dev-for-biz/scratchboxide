/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's finish shaded by mesh-measured maps (pipeline-k/material-mesh-maps.ts), on a floor photographed from
 * above with a wall standing on it: at the wall's foot the occlusion is darker and the roughness higher than out in the
 * open, which keeps its finish; glass keeps its own; the occlusion texture is written as the orm, labelled generated.
 */

import { describe, expect, it } from 'vitest';
import { parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { applyMeshMapsToPlan } from '../src/node/3d-engine/staged-location/pipeline-k/material-mesh-maps';
import { writeMaterialRegions, type MaterialRegionsPlan, type PlannedMaterial } from '../src/node/3d-engine/staged-location/pipeline-k/material-regions';
import { buildFixtureGlb, type FixturePrimitive } from './helpers/uv-rewrap-fixtures';

const TIMEOUT = 600_000;

function grid(n: number, at: (u: number, v: number) => [number, number, number], flip = false): { positions: number[]; indices: number[]; uv: number[] } {
    const positions: number[] = [], indices: number[] = [], uv: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) { positions.push(...at(i / n, j / n)); uv.push(i / n, j / n); }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 2, d = a + n + 1;
        if (flip) indices.push(a, b, c, a, c, d); else indices.push(a, c, b, a, d, c);
    }
    return { positions, indices, uv };
}

describe('pipeline K: the finish shaded by mesh-measured maps', () => {
    it('darkens occlusion and roughens the floor at a wall\'s foot, leaves the open floor and glass as they were', async () => {
        // the floor: x, z -2..2 at y 0, facing up, UVs planar; the wall: x 0..0.3, y 0..3, its -x face toward the floor
        const f = grid(16, (u, v) => [-2 + 4 * u, 0, -2 + 4 * v]);
        const floor: FixturePrimitive = { positions: f.positions, indices: f.indices, uvs: [f.uv], material: 0, name: 'floor' };
        const w = grid(12, (u, v) => [0, 3 * v, -2 + 4 * u], true);
        const top = grid(4, (u, v) => [0.3 * u, 3, -2 + 4 * v]);
        const wall: FixturePrimitive = { positions: [...w.positions, ...top.positions], indices: [...w.indices, ...top.indices.map(i => i + w.positions.length / 3)], material: 1, name: 'wall' };
        const glb = buildFixtureGlb({
            primitives: [floor, wall],
            materials: [{ name: 'floor', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { name: 'wall' }],
            textures: [{ source: 0 }]
        });
        const g = parseGlbBytes(new Uint8Array(glb));
        const S = 64, blank = () => ({ width: S, height: S, rgba: new Uint8Array(S * S * 4) });
        const orm = blank(), params = blank();
        for (let k = 0; k < S * S; k++) { orm.rgba[k * 4] = 255; orm.rgba[k * 4 + 1] = 128; orm.rgba[k * 4 + 3] = 255; }
        const glassK = 50 * S + 31;                           // a glass texel by the wall
        params.rgba[glassK * 4] = 200;
        const pm: PlannedMaterial = { material: 0, orm, params, rebuilt: true, glass: true };
        const plan = { materials: [pm], sets: [], report: { texels: { total: S * S, glass: 1 } } } as unknown as MaterialRegionsPlan;

        const report = await applyMeshMapsToPlan(g, g.json, plan, { params: { maxQueries: 64 * 64 } });
        expect(report.label).toBe('generated');
        expect(report.step).toBe(1);
        expect(plan.report.meshMaps).toBe(report);
        // texel (x, y) is at world x = -2 + 4 (x + 0.5) / 64, z = -2 + 4 (y + 0.5) / 64
        const at = (x: number, y: number) => ({ ao: orm.rgba[(y * S + x) * 4], rough: orm.rgba[(y * S + x) * 4 + 1] });
        const foot = at(30, 32), open = at(3, 32);           // world x -0.094 and -1.78
        expect(foot.ao).toBeLessThan(200);
        expect(open.ao).toBe(255);
        expect(foot.rough).toBeGreaterThan(150);
        expect(open.rough).toBe(128);
        expect(orm.rgba[glassK * 4]).toBe(255);
        expect(orm.rgba[glassK * 4 + 1]).toBe(128);
        expect(pm.occlusion).toBe(true);

        const json = JSON.parse(JSON.stringify(g.json));
        let next = 0;
        writeMaterialRegions(json, plan, () => next++, []);
        expect(json.materials[0].occlusionTexture.index).toBe(json.materials[0].pbrMetallicRoughness.metallicRoughnessTexture.index);
        expect(json.materials[0].extras.sbMaterialRegions.occlusion.label).toBe('generated');
    }, TIMEOUT);
});
