/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tile_refine's per-vertex provenance read into the staged build's summary: _RECTIFY_DISPLACEMENT in bands (never an
 * exact-zero test), _PROUD_BLOCK codes, _RELIEF_HEIGHT carved vertices (photo-inferred); an absent attribute is no
 * claim. On a synthetic GLB with values at every band edge, and on Central Park's real remesh (copied), whose maximum
 * must equal tile_refine's own stats. Screenshot: the remesh shaded by band.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeRemeshProvenance, readRemeshProvenance } from '../src/node/3d-engine/staged-location/remesh-provenance';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { glbMeshCounts } from '../src/node/3d-engine/location-clay-pipeline';
import { classifyRemeshVertex, validateContract } from '../src/common/spatial/staged-location-contracts';
import { readGlbScene } from '../src/node/spatial/StreetViewPoseRegistrar';
import { renderClayPng, parseGlb } from './helpers/clay-glb-render';
import { withReason } from './helpers/requirements';
import { centralParkRealData, copyInto, STAGED_SCREENSHOT_DIR } from './helpers/staged-real-data';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-remesh-prov-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** A strip of n quads (2n triangles, 2n + 2 vertices). */
function strip(n: number): { positions: Float32Array; indices: Uint32Array } {
    const p: number[] = [], idx: number[] = [];
    for (let i = 0; i <= n; i++) p.push(i, 0, 0, i, 0, 1);
    for (let i = 0; i < n; i++) { const a = 2 * i; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    return { positions: Float32Array.from(p), indices: Uint32Array.from(idx) };
}

describe('readRemeshProvenance', () => {
    it('counts every attribute in its bands, at the band edges, and never by an exact-zero test', () => {
        const s = strip(4); // 10 vertices
        // float32 values just past each edge (0.01 itself is stored as 0.0099999998, under 1 cm)
        const disp = Float32Array.from([0, 0.0004, 0.0099, 0.0101, 0.049, 0.0501, 0.433, -0.02, 0, 0]);
        const block = Float32Array.from([0, 0, 1, 1, 2, 0, 0, 0, 0.4, 2.6]);
        const relief = Float32Array.from([0, 0.0009, 0.001, -0.03, 0, 0, 0, 0, 0, 0]);
        const file = path.join(TMP, 'bands.glb');
        writeStagedGlbFile(file, [{ ...s, attributes: { _RECTIFY_DISPLACEMENT: disp, _PROUD_BLOCK: block, _RELIEF_HEIGHT: relief } }]);
        const { summary } = readRemeshProvenance(file);
        expect(validateContract('vertexProvenance', summary)).toEqual([]);
        expect(summary.vertices).toBe(10);
        expect(summary.attributes).toEqual(['_RECTIFY_DISPLACEMENT', '_PROUD_BLOCK', '_RELIEF_HEIGHT']);
        // untouched < 1 cm (0, 0.0004, 0.0099, 0, 0), moved 1-5 cm (0.0101, 0.049, |-0.02|), reshaped >= 5 cm (0.0501, 0.433)
        expect(summary.rectifyDisplacement!.bands.map(b => [b.band, b.vertices])).toEqual([['untouched', 5], ['moved', 3], ['reshaped', 2]]);
        expect(summary.rectifyDisplacement!.maxM).toBeCloseTo(0.433, 6);
        // 1 = kept as scanned (two), 2 = snapped (one); 0.4 and 2.6 fall in neither band
        expect(summary.proudBlocks).toEqual({ keptAsScannedVertices: 2, snappedVertices: 1 });
        // carved: |h| >= 1 mm (0.001 and -0.03); 0.0009 is not
        expect(summary.relief!.carvedVertices).toBe(2);
        expect(summary.relief!.maxAbsHeightM).toBeCloseTo(0.03, 6);
        // the per-vertex reading the viewport shades by agrees with the counts
        expect(classifyRemeshVertex({ rectifyDisplacementM: 0, proudBlock: 0, reliefHeightM: 0 }).label).toBe('remeshed');
        expect(classifyRemeshVertex({ rectifyDisplacementM: 0.0004, proudBlock: 1, reliefHeightM: 0 }).label).toBe('as-scanned');
        expect(classifyRemeshVertex({ rectifyDisplacementM: 0, proudBlock: 0, reliefHeightM: -0.03 }).label).toBe('photo-inferred');
        expect(describeRemeshProvenance(summary)).toBe('rectify and facade flatten moved 50% of its 10 vertices by 1 cm or more (20% by more than 5 cm; at most 0.43 m); 2 vertices of proud blocks were kept as scanned and 1 snapped at their own level; 2 vertices were carved by photo relief (photo-inferred, up to 3 cm)');
    });

    it('makes no per-vertex claim when tile_refine wrote no attribute: never "as scanned"', () => {
        const file = path.join(TMP, 'bare.glb');
        writeStagedGlbFile(file, [strip(2)]);
        const { summary } = readRemeshProvenance(file);
        expect(summary).toEqual({ schema: 'scratchbox.vertex-provenance/1', attributes: [], vertices: 6 });
        expect(describeRemeshProvenance(summary)).toContain('no vertex is claimed as moved or as scanned');
        expect(classifyRemeshVertex({}).label).toBe('remeshed');
    });

    const cp = centralParkRealData();
    it.skipIf(!cp.requirement.ok)(withReason('reads Central Park\'s real remesh: bands sum to its vertices, and the maximum equals tile_refine\'s own stats', cp.requirement), () => {
        const files = copyInto(path.join(TMP, 'cp'), { 'clay.glb': cp.data!.remesh.clay, 'stats.json': cp.data!.remesh.stats });
        const before = fs.readFileSync(files['clay.glb']);
        const { summary, attributeNotes } = readRemeshProvenance(files['clay.glb']);
        expect(fs.readFileSync(files['clay.glb']).equals(before)).toBe(true); // read only
        const stats = JSON.parse(fs.readFileSync(files['stats.json'], 'utf8'));
        expect(summary.vertices).toBe(glbMeshCounts(files['clay.glb']).vertices);
        expect(summary.attributes).toContain('_RECTIFY_DISPLACEMENT');
        expect(summary.rectifyDisplacement!.bands.reduce((s, b) => s + b.vertices, 0)).toBe(summary.vertices);
        expect(summary.rectifyDisplacement!.maxM).toBeCloseTo(stats.rectify.displacementAll_m.max, 5);
        expect(attributeNotes._RECTIFY_DISPLACEMENT).toMatch(/rectify and facade flatten/);
        if (stats.rectify?.proudBlocks?.blocks > 0) {
            expect(summary.proudBlocks!.keptAsScannedVertices + summary.proudBlocks!.snappedVertices).toBeGreaterThan(0);
        }
        expect(validateContract('vertexProvenance', summary)).toEqual([]);

        // screenshot: the remesh shaded by band (untouched grey, moved light blue, reshaped dark blue, proud block kept orange)
        const prims = readGlbScene(files['clay.glb']);
        const raw = fs.readFileSync(files['clay.glb']);
        const gltf = parseGlb(raw).json;
        const binChunk = parseGlb(raw).bin;
        const attr = (prim: any, name: string): Float32Array | undefined => {
            const i = prim.attributes[name];
            if (i === undefined) return undefined;
            const acc = gltf.accessors[i], view = gltf.bufferViews[acc.bufferView];
            const out = new Float32Array(acc.count);
            const stride = view.byteStride || 4;
            for (let k = 0; k < acc.count; k++) out[k] = binChunk.readFloatLE((view.byteOffset || 0) + (acc.byteOffset || 0) + k * stride);
            return out;
        };
        const triPrims = gltf.meshes.flatMap((m: any) => m.primitives).filter((p: any) => (p.mode ?? 4) === 4);
        const colours: Record<string, [number, number, number]> = {
            untouched: [0.62, 0.63, 0.66], moved: [0.34, 0.71, 0.91], reshaped: [0.0, 0.45, 0.7],
            'block-kept-as-scanned': [0.9, 0.62, 0.0], 'block-snapped': [0.8, 0.47, 0.65], 'relief-inferred': [0.8, 0.47, 0.65], 'no-per-vertex-claim': [0.55, 0.57, 0.6]
        };
        const byBand = new Map<string, { p: number[]; i: number[] }>();
        prims.forEach((p, pi) => {
            const d = attr(triPrims[pi], '_RECTIFY_DISPLACEMENT'), b = attr(triPrims[pi], '_PROUD_BLOCK'), h = attr(triPrims[pi], '_RELIEF_HEIGHT');
            for (let t = 0; t < p.indices.length; t += 3) {
                const v = p.indices[t];
                const band = classifyRemeshVertex({ rectifyDisplacementM: d?.[v], proudBlock: b?.[v], reliefHeightM: h?.[v] }).band;
                const layer = byBand.get(band) ?? { p: [], i: [] };
                byBand.set(band, layer);
                for (let j = 0; j < 3; j++) {
                    const k = p.indices[t + j];
                    layer.i.push(layer.p.length / 3);
                    layer.p.push(p.positions[k * 3], p.positions[k * 3 + 1], p.positions[k * 3 + 2]);
                }
            }
        });
        const layers = [...byBand.entries()].map(([band, l]) => ({ positions: Float32Array.from(l.p), indices: Uint32Array.from(l.i), color: colours[band] ?? [1, 0, 1] }));
        fs.mkdirSync(STAGED_SCREENSHOT_DIR, { recursive: true });
        const png = renderClayPng(layers, { kind: 'aerial', width: 1200, height: 800, region: [-120, -120, 120, 120], bearingDeg: 200, elevationDeg: 40 });
        fs.writeFileSync(path.join(STAGED_SCREENSHOT_DIR, 'remesh_provenance_central_park.png'), png);
        expect(png.length).toBeGreaterThan(10_000);
        expect(byBand.size).toBeGreaterThanOrEqual(2);
    });
});
