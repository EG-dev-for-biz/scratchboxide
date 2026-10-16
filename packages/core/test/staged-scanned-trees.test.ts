/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A failed tree stage puts the scanned trees back, labelled as scanned: exactly the triangles strip removed (input
 * triangles absent from its output), unchanged, one node per measured crown. Synthetic truth, then Central Park's
 * real strip (copied): the count matches strip's own stats. Screenshots: the remesh with the scanned trees put back.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { putBackScannedTrees } from '../src/node/3d-engine/staged-location/scanned-trees';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { validateContract } from '../src/common/spatial/staged-location-contracts';
import { readGlbScene, sceneToRenderMesh } from '../src/node/spatial/StreetViewPoseRegistrar';
import { readGlbTriangles, renderClayPng } from './helpers/clay-glb-render';
import { withReason } from './helpers/requirements';
import { centralParkRealData, copyInto, STAGED_SCREENSHOT_DIR } from './helpers/staged-real-data';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-scanned-trees-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A grid of quads over [x0, x1] x [z0, z1] at height y (or y(x, z)). */
function patch(x0: number, x1: number, z0: number, z1: number, n: number, y: (x: number, z: number) => number) {
    const p: number[] = [], idx: number[] = [];
    for (let k = 0; k <= n; k++) for (let i = 0; i <= n; i++) {
        const x = x0 + ((x1 - x0) * i) / n, z = z0 + ((z1 - z0) * k) / n;
        p.push(x, y(x, z), z);
    }
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
        const a = k * (n + 1) + i;
        idx.push(a, a + 1, a + n + 1, a + 1, a + n + 2, a + n + 1);
    }
    return { positions: Float32Array.from(p), indices: Uint32Array.from(idx) };
}

const dome = (cx: number, cz: number, r: number, h: number) => (x: number, z: number) => h * Math.max(0.2, 1 - ((x - cx) ** 2 + (z - cz) ** 2) / (r * r)) + 2;
const square = (cx: number, cz: number, r: number): Array<[number, number]> => [[cx - r, cz - r], [cx + r, cz - r], [cx + r, cz + r], [cx - r, cz + r]];

describe('putBackScannedTrees', () => {
    it('writes exactly the triangles strip removed, unchanged, one node per measured crown plus the canopy that went with them', () => {
        const ground = patch(-20, 20, -20, 20, 10, () => 0);
        const treeA = patch(-12, -4, -12, -4, 6, dome(-8, -8, 4, 6));        // 72 triangles, crown 3
        const treeB = patch(4, 12, 4, 12, 4, dome(8, 8, 4, 5));              // 32 triangles, crown 7
        const drape = patch(12.5, 14, 4, 6, 1, () => 3);                    // 2 triangles outside every crown
        const raw = path.join(TMP, 'raw.glb'), deveg = path.join(TMP, 'deveg.glb'), crowns = path.join(TMP, 'crowns.json');
        writeStagedGlbFile(raw, [ground, treeA, treeB, drape]);
        const cap = patch(-12, -4, -12, -4, 1, () => 0.01);                  // strip's closure: in the output, not the input
        writeStagedGlbFile(deveg, [ground, cap]);
        fs.writeFileSync(crowns, JSON.stringify({ crowns: [
            { id: 7, status: 'tree', footprint: square(8, 8, 4.2) },
            { id: 3, status: 'tree', footprint: square(-8, -8, 4.2) },
            { id: 9, status: 'not_regrowable', footprint: square(0, 0, 3) }  // kept in the scan by strip: not put back
        ] }));
        const out = path.join(TMP, 'scanned_trees.glb');
        const r = putBackScannedTrees({ rawGlb: raw, devegetatedGlb: deveg, crownsJson: crowns, outGlb: out, reason: 'plant failed: budget_too_small' });
        expect(r.inputTriangles).toBe(200 + 72 + 32 + 2);
        expect(r.triangles).toBe(106);
        expect(r.crowns).toEqual([{ crownId: 3, triangles: 72 }, { crownId: 7, triangles: 32 }]);
        expect(r.canopyWithTreesTriangles).toBe(2);

        const g = readGlbTriangles(fs.readFileSync(out));
        expect(g.nodeRanges.map(n => [n.name, n.triangleCount])).toEqual([['scanned_crown_3', 72], ['scanned_crown_7', 32], ['scanned_canopy_with_trees', 2]]);
        for (const n of g.nodeRanges) {
            expect(validateContract('StagedNodeExtras', n.extras)).toEqual([]);
            expect(n.extras.sb.provenance).toMatchObject({ label: 'as-scanned', measuredGeometry: true });
            expect(n.extras.sb.provenance.note).toContain('plant failed: budget_too_small');
        }
        expect(g.nodeRanges.map(n => n.extras.sb.buildOrder)).toEqual([0, 1, 2]);
        // unchanged: every written vertex is a vertex of the raw scan
        const rawVerts = new Set<string>();
        for (const p of readGlbScene(raw)) for (let i = 0; i < p.positions.length; i += 3) rawVerts.add(`${p.positions[i]},${p.positions[i + 1]},${p.positions[i + 2]}`);
        for (let i = 0; i < g.positions.length; i += 3) expect(rawVerts.has(`${g.positions[i]},${g.positions[i + 1]},${g.positions[i + 2]}`)).toBe(true);
    });

    it('keeps only what lies inside an isolated structure\'s extent', () => {
        const raw = path.join(TMP, 'raw.glb'), deveg = path.join(TMP, 'deveg.glb'), crowns = path.join(TMP, 'crowns.json');
        const r = putBackScannedTrees({ rawGlb: raw, devegetatedGlb: deveg, crownsJson: crowns, outGlb: path.join(TMP, 'iso.glb'), reason: 'x', keepXZ: { minX: 0, maxX: 20, minZ: 0, maxZ: 20 } });
        expect(r.crowns).toEqual([{ crownId: 7, triangles: 32 }]);
        expect(r.triangles).toBe(34);
    });

    const cp = centralParkRealData();
    it.skipIf(!cp.requirement.ok)(withReason('puts back Central Park\'s real removed trees: the count strip reports, crown by crown', cp.requirement), () => {
        const files = copyInto(path.join(TMP, 'cp'), {
            'raw.glb': cp.data!.textured, 'devegetated.glb': cp.data!.strip.devegetated, 'crowns.json': cp.data!.strip.crowns,
            'stats.json': cp.data!.strip.stats, 'remesh.glb': cp.data!.remesh.clay
        });
        const stats = JSON.parse(fs.readFileSync(files['stats.json'], 'utf8'));
        const r = putBackScannedTrees({ rawGlb: files['raw.glb'], devegetatedGlb: files['devegetated.glb'], crownsJson: files['crowns.json'], outGlb: path.join(TMP, 'cp_scanned_trees.glb'), reason: 'plant failed (test)' });
        expect(r.inputTriangles).toBe(stats.triangles.input);
        // the removed triangles strip counted, within the few the output repeats exactly (duplicated input triangles)
        expect(Math.abs(r.triangles - stats.triangles.removed)).toBeLessThanOrEqual(10);
        const removedCrowns = JSON.parse(fs.readFileSync(files['crowns.json'], 'utf8')).crowns.filter((c: any) => c.status === 'tree').length;
        expect(r.crowns.length).toBeGreaterThan(0.9 * removedCrowns);
        expect(r.ms).toBeLessThan(60_000);

        // screenshot: the remeshed park with its scanned trees put back (green), and the trees alone
        const remesh = readGlbScene(files['remesh.glb']);
        const trees = readGlbTriangles(fs.readFileSync(r.glbPath));
        const rm = sceneToRenderMesh(remesh);
        fs.mkdirSync(STAGED_SCREENSHOT_DIR, { recursive: true });
        const view = { kind: 'aerial' as const, width: 1200, height: 800, region: [-150, -150, 150, 150] as [number, number, number, number], bearingDeg: 200, elevationDeg: 35 };
        const both = renderClayPng([
            { positions: Float32Array.from(rm.vertices as Float32Array), indices: Uint32Array.from(rm.indices as Uint32Array) },
            { positions: trees.positions, indices: trees.indices, color: [0.0, 0.62, 0.45] }
        ], view);
        fs.writeFileSync(path.join(STAGED_SCREENSHOT_DIR, 'trees_put_back_as_scanned_central_park.png'), both);
        fs.writeFileSync(path.join(STAGED_SCREENSHOT_DIR, 'trees_put_back_as_scanned_central_park_trees_only.png'), renderClayPng([{ positions: trees.positions, indices: trees.indices, color: [0.0, 0.62, 0.45] }], view));
        expect(both.length).toBeGreaterThan(10_000);
    });
});
