/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The native grass field (grass-field.ts over scratchbox_grass_field.hpp) on a grid with a known truth: a confident lawn
 * and a half-confident lawn of equal area, a building footprint and a pond set into the confident lawn, plaza around.
 * Instance counts must follow the mask area times its confidence, no clump may stand within its reach of a building or
 * water cell, nothing grows off the mask or past the band, the budget keeps the nearest, and the GLB must carry the
 * instancing extension with the labels.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { buildGrassField, grassFieldGrid, writeGrassFieldGlb, type GrassField, type GrassFieldGrid } from '../src/node/3d-engine/staged-location/grass-field';
import type { GrassMask } from '../src/node/3d-engine/staged-location/grass-detect';
import type { GroundModel } from '../src/node/spatial/StreetViewSurveyPlanner';

const N = 60, CELL = 1;
type Rect = [number, number, number, number];
const inRect = (x: number, z: number, [x0, z0, x1, z1]: Rect) => x >= x0 && x < x1 && z >= z0 && z < z1;
// lawns in the scene's own frame (the grid starts at -30, -30)
const FULL: Rect = [-28, -28, 2, 2], HALF: Rect = [6, -28, 26, 2], BUILDING: Rect = [-20, -20, -12, -12], POND: Rect = [-8, -24, -2, -18];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'grass-field-'));

function scene(): { grid: GrassFieldGrid; mask: GrassMask } {
    const M = N * N, mask = new Uint8Array(M), confidence = new Float32Array(M), colour = new Float32Array(M * 3);
    const top = new Float32Array(M), groundH = new Float32Array(M), building = new Uint8Array(M), water = new Uint8Array(M);
    for (let k = 0; k < N; k++) for (let i = 0; i < N; i++) {
        const c = k * N + i, x = -30 + i + 0.5, z = -30 + k + 0.5;
        groundH[c] = 10; top[c] = 10.03;
        if (inRect(x, z, BUILDING)) { building[c] = 1; top[c] = 25; continue; }
        // the mask lies about the pond (a green pool passes the colour test); exclusion must still win
        if (inRect(x, z, POND)) water[c] = 1;
        const conf = inRect(x, z, FULL) ? 1 : inRect(x, z, HALF) ? 0.5 : 0;
        if (!conf) continue;
        mask[c] = 1; confidence[c] = conf;
        // the right half of each lawn seen, the left filled (no colour): the nearest seen colour must carry over
        if (x > -14 || x > 6) colour.set([0.06, 0.12, 0.03], c * 3);
    }
    const ground = { cellMeters: CELL, x0: -30, z0: -30, nx: N, nz: N, top, ground: groundH } as unknown as GroundModel;
    const g = { x0: -30, z0: -30, nx: N, nz: N, cellM: CELL, mask, confidence, colour } as unknown as GrassMask;
    // the scan over the confident lawn: its ground 0.2 m above the cell surface (snapped to), and a crown far above (ignored)
    const quad = ([x0, z0, x1, z1]: Rect, y: number) => [x0, y, z0, x1, y, z0, x1, y, z1, x0, y, z0, x1, y, z1, x0, y, z1];
    const scan = Float32Array.from([...quad(FULL, 10.23), ...quad(FULL, 18)]);
    return { grid: grassFieldGrid(g, ground, { building, water }, scan), mask: g };
}

describe('grass field (native, instanced clumps over a grass mask)', () => {
    const { grid } = scene();
    let field: GrassField;
    const all = (f: GrassField) => f.variants.flatMap(v => Array.from({ length: v.confidence.length }, (_, q) => ({
        x: v.translation[q * 3], y: v.translation[q * 3 + 1], z: v.translation[q * 3 + 2], s: v.scale[q * 3], reach: v.reachM, conf: v.confidence[q], tint: [v.tint[q * 3], v.tint[q * 3 + 1], v.tint[q * 3 + 2]]
    })));

    it('places instances in proportion to grass area times confidence', async () => {
        field = await buildGrassField(grid, tmp(), { densityPerM2: 4, bandRadiusM: 200 });
        const inst = all(field);
        expect(inst.length).toBe(field.report.instances);
        // away from the exclusions, each lawn's count follows its area x density x confidence
        const clear: Rect = [-28, -10, 2, 2], half: Rect = [6, -28, 26, 2];
        const nClear = inst.filter(p => inRect(p.x, p.z, clear)).length, nHalf = inst.filter(p => inRect(p.x, p.z, half)).length;
        const expClear = 30 * 12 * 4, expHalf = 20 * 30 * 4 * 0.5;
        expect(Math.abs(nClear - expClear) / expClear).toBeLessThan(0.08);
        expect(Math.abs(nHalf - expHalf) / expHalf).toBeLessThan(0.1);
        expect(field.report.stats.bandGrassM2).toBe(30 * 30 + 20 * 30 - 8 * 8 - 6 * 6);
        expect(field.report.stats.expected).toBeCloseTo((30 * 30 - 8 * 8 - 6 * 6) * 4 + 20 * 30 * 4 * 0.5, 0);
        // the carried confidence is the cell's
        for (const p of inst) expect(p.conf).toBeCloseTo(inRect(p.x, p.z, FULL) ? 1 : 0.5, 5);
    });

    it('grows nothing off the mask, and no clump within its reach of a building or water', () => {
        const inst = all(field);
        expect(field.report.stats.nearExcluded).toBeGreaterThan(0);
        expect(field.report.stats.snapped + field.report.stats.unsnapped).toBe(field.report.instances);
        expect(field.report.stats.snapped).toBe(inst.filter(p => inRect(p.x, p.z, FULL)).length);
        const dist = (x: number, z: number, [x0, z0, x1, z1]: Rect) => Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(z0 - z, 0, z - z1));
        for (const p of inst) {
            expect(inRect(p.x, p.z, FULL) || inRect(p.x, p.z, HALF)).toBe(true);
            expect(dist(p.x, p.z, BUILDING)).toBeGreaterThan(p.reach * p.s);
            expect(dist(p.x, p.z, POND)).toBeGreaterThan(p.reach * p.s);
            // standing on the scan's ground where it has one near the cell surface, else on the cell surface; tinted
            // toward the seen colour (never the white fallback)
            expect(p.y).toBeCloseTo(inRect(p.x, p.z, FULL) ? 10.23 : 10.03, 3);
            expect(p.tint[1]).toBeLessThan(0.3);
            expect(p.tint[1]).toBeGreaterThan(p.tint[0]);
        }
    });

    it('keeps to the band, and past the budget keeps the nearest', async () => {
        const banded = await buildGrassField(grid, tmp(), { densityPerM2: 4, bandRadiusM: 10, centreX: 16, centreZ: -13 });
        const inst = all(banded);
        expect(inst.length).toBeGreaterThan(0);
        for (const p of inst) expect(Math.hypot(p.x - 16, p.z + 13)).toBeLessThanOrEqual(10);
        // about pi r^2 of half-confident lawn
        expect(Math.abs(inst.length - Math.PI * 100 * 2) / (Math.PI * 100 * 2)).toBeLessThan(0.12);
        const capped = await buildGrassField(grid, tmp(), { densityPerM2: 4, bandRadiusM: 200, centreX: 16, centreZ: -13, maxInstances: 300 });
        const uncapped = await buildGrassField(grid, tmp(), { densityPerM2: 4, bandRadiusM: 200, centreX: 16, centreZ: -13 });
        expect(capped.report.instances).toBe(300);
        expect(capped.report.stats.overBudget).toBe(uncapped.report.instances - 300);
        const r = capped.report.stats.radiusReachedM;
        expect(all(capped).every(p => Math.hypot(p.x - 16, p.z + 13) <= r + 1e-4)).toBe(true);
        // the kept ones are exactly the full run's instances that near the centre
        const nearer = all(uncapped).filter(p => Math.hypot(p.x - 16, p.z + 13) < r - 1e-3).length;
        expect(nearer).toBeLessThanOrEqual(300);
    });

    it('builds real clump variants and writes an instanced GLB with its labels', () => {
        // band 200 m: blades of 5 mm need a 16x widening (capped) by its edge, so 5 rings of 4 variants
        expect(field.variants.length).toBe(4 * 5);
        for (const v of field.variants.filter(w => w.ring === 0)) {
            expect(v.positions.length / 3).toBeGreaterThan(22 * 15);
            expect(v.indices.length % 3).toBe(0);
            expect(Math.max(...v.indices)).toBeLessThan(v.positions.length / 3);
            // blades rise from the anchor: a few centimetres to well under a metre
            expect(v.max[1]).toBeGreaterThan(0.04);
            expect(v.max[1]).toBeLessThan(0.5);
        }
        const file = path.join(tmp(), 'blades.glb');
        const tris = writeGrassFieldGlb(file, field, { sb: { provenance: { label: 'generated', colour: { label: 'photo-inferred' } } } });
        expect(tris).toBe(field.report.instancedTriangles + field.underlayer.indices.length / 3);
        const glb = fs.readFileSync(file);
        expect(glb.readUInt32LE(0)).toBe(0x46546c67);
        const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
        expect(json.extensionsUsed).toContain('EXT_mesh_gpu_instancing');
        // the underlayer is its own node, textured, outside the instancing
        const under = json.nodes.filter((n: { name: string }) => n.name === 'grass underlayer');
        expect(under).toHaveLength(1);
        expect(json.materials[json.meshes[under[0].mesh].primitives[0].material].pbrMetallicRoughness.baseColorTexture.index).toBe(0);
        expect(json.images[0].mimeType).toBe('image/png');
        const counts = json.nodes.filter((n: { name: string }) => n.name !== 'grass underlayer').map((n: { extensions: { EXT_mesh_gpu_instancing: { attributes: Record<string, number> } } }) => {
            const a = n.extensions.EXT_mesh_gpu_instancing.attributes;
            expect(Object.keys(a).sort()).toEqual(['ROTATION', 'SCALE', 'TRANSLATION', '_COLOR_0', '_CONFIDENCE']);
            return json.accessors[a.TRANSLATION].count;
        });
        expect(counts.reduce((s: number, c: number) => s + c, 0)).toBe(field.report.instances);
        expect(json.nodes[0].extras.sb.provenance.label).toBe('generated');
        expect(json.nodes[0].extras.maskConfidence.max).toBeLessThanOrEqual(1);
    });

    it('stands blades under crowns on the nearest seen ground, not the smooth terrain below it, in the nearest seen colour', () => {
        // a park whose real ground lies 0.4 m above the street-level terrain; its middle hidden under a 15 m crown
        const n = 20, M = n * n, top = new Float32Array(M), groundH = new Float32Array(M).fill(5), mask = new Uint8Array(M);
        for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
            const c = k * n + i, hidden = i >= 6 && i < 14 && k >= 6 && k < 14;
            top[c] = hidden ? 20 : 5.4; mask[c] = hidden ? 2 : (i < 2 ? 1 : 0);
        }
        // the hidden patch touches no seen grass: only the strip at the west edge was seen green
        const colour = new Float32Array(M * 3);
        for (let k = 0; k < n; k++) colour.set([0.05, 0.1, 0.02], (k * n) * 3);
        const ground = { cellMeters: 1, x0: 0, z0: 0, nx: n, nz: n, top, ground: groundH } as unknown as GroundModel;
        const g = { x0: 0, z0: 0, nx: n, nz: n, cellM: 1, mask, confidence: new Float32Array(M).fill(0.5), colour } as unknown as GrassMask;
        const grid = grassFieldGrid(g, ground, {});
        expect(grid.surfaceY[10 * n + 10]).toBeCloseTo(5.4, 5);
        expect(grid.surfaceY[2 * n + 1]).toBeCloseTo(5.4, 5);
        // its colour is the nearest seen grass's, carried across the ground between
        expect(Array.from(grid.colour.subarray((10 * n + 10) * 3, (10 * n + 10) * 3 + 3))).toEqual(Array.from(Float32Array.from([0.05, 0.1, 0.02])));
        expect(grid.colour[(2 * n + 4) * 3 + 1]).toBe(0);
    });

    it('widens and thins the blades ring by ring with distance from the centre, so they stay about a pixel wide', async () => {
        const width = (v: GrassField['variants'][number]) => {
            // the first blade's base: its left and right margin vertices (0 and 2), bladeWidthBase x the ring's scale apart
            return Math.hypot(v.positions[0] - v.positions[6], v.positions[1] - v.positions[7], v.positions[2] - v.positions[8]);
        };
        const byRing = new Map<number, GrassField['variants']>();
        for (const v of field.variants) byRing.set(v.ring, [...(byRing.get(v.ring) ?? []), v]);
        expect([...byRing.keys()].sort()).toEqual([0, 1, 2, 3, 4]);
        for (const [r, vs] of byRing) {
            expect(vs[0].widthScale).toBe(2 ** r);
            if (r > 0) {
                expect(width(vs[0])).toBeGreaterThan(width(byRing.get(r - 1)![0]) * 1.5);
                // fewer blades (30, 15, 8, 4, then the floor of 3), and the distant ones with fewer segments: fewer vertices per clump
                expect(vs[0].positions.length).toBeLessThan(byRing.get(r - 1)![0].positions.length);
            }
        }
        // each instance in the ring its distance asks for: the pixel at d metres spans d x 0.0015, a near blade 5 mm
        for (const v of field.variants) for (let q = 0; q < v.confidence.length; q++) {
            const d = Math.hypot(v.translation[q * 3], v.translation[q * 3 + 2]);
            expect(v.ring).toBe(Math.min(4, Math.max(0, Math.floor(Math.log2(Math.max(1, (d * 0.0015) / 0.005))))));
        }
        // the ring count does not change how many clumps stand where
        const flat = await buildGrassField(grid, tmp(), { densityPerM2: 4, bandRadiusM: 200, pixelAngle: 0 });
        expect(flat.variants.length).toBe(4);
        // (only the far rings' wider blades keep a little farther from buildings and water)
        expect(flat.report.instances).toBeGreaterThanOrEqual(field.report.instances);
        expect(flat.report.instances - field.report.instances).toBeLessThan(field.report.instances * 0.01);
        expect(flat.report.instancedTriangles).toBeGreaterThan(field.report.instancedTriangles);
    });

    it('takes blades per clump and segments as parameters: near blades keep their curve, distant ones are cheap', async () => {
        // a blade of n segments is 3n + 1 vertices and 4(n - 1) + 2 triangles
        const f = await buildGrassField(grid, tmp(), { densityPerM2: 4, bandRadiusM: 200, bladeCount: 40, segmentsPerBlade: 6, farSegmentsPerBlade: 1 });
        const near = f.variants.find(v => v.ring === 0)!, far = f.variants.find(v => v.ring === 1)!;
        expect(near.positions.length / 3).toBe(40 * (3 * 6 + 1));
        expect(near.indices.length / 3).toBe(40 * (4 * 5 + 2));
        expect(far.positions.length / 3).toBe(20 * (3 * 1 + 1));
        expect(far.indices.length / 3).toBe(20 * 2);
        // same placement whatever the blades: the clumps are the same
        expect(f.report.instances).toBe(field.report.instances);
    });

    it('writes the instances in square tiles, one node per (variant, tile), each tile holding only its own clumps', () => {
        const read = (file: string) => {
            const glb = fs.readFileSync(file), jl = glb.readUInt32LE(12);
            const json = JSON.parse(glb.subarray(20, 20 + jl).toString('utf8')), bin = glb.subarray(20 + jl + 8);
            const f32 = (acc: number) => { const a = json.accessors[acc], bv = json.bufferViews[a.bufferView]; return new Float32Array(bin.buffer.slice(bin.byteOffset + bv.byteOffset, bin.byteOffset + bv.byteOffset + bv.byteLength)); };
            return { json, f32 };
        };
        const tiled = path.join(tmp(), 'tiled.glb'), whole = path.join(tmp(), 'whole.glb');
        const trisTiled = writeGrassFieldGlb(tiled, field, {}, 10), trisWhole = writeGrassFieldGlb(whole, field, {}, 0);
        expect(trisTiled).toBe(trisWhole);
        const t = read(tiled), w = read(whole);
        const live = field.variants.filter(v => v.confidence.length > 0).length;
        // plus the underlayer, one node and one mesh in both
        expect(w.json.nodes.length).toBe(live + 1);
        expect(t.json.meshes.length).toBe(live + 1);
        expect(t.json.nodes.length).toBeGreaterThan(live * 3);
        let total = 0;
        const seen = new Set<string>();
        for (const node of t.json.nodes.filter((n: { name: string }) => n.name !== 'grass underlayer')) {
            const { i, k, sizeM } = node.extras.tile;
            expect(sizeM).toBe(10);
            const key = `${node.mesh}:${i},${k}`;
            expect(seen.has(key)).toBe(false);
            seen.add(key);
            const tr = t.f32(node.extensions.EXT_mesh_gpu_instancing.attributes.TRANSLATION);
            for (let q = 0; q < tr.length; q += 3) {
                expect(Math.floor(tr[q] / 10)).toBe(i);
                expect(Math.floor(tr[q + 2] / 10)).toBe(k);
            }
            expect(node.extras.instances).toBe(tr.length / 3);
            total += tr.length / 3;
        }
        expect(total).toBe(field.report.instances);
    });

    it('shades each blade from a dark root up to a lit lamina (self-occlusion)', () => {
        // a near blade of 5 segments: rows of three vertices (left, keel, right) root to tip, then the tip
        const v = field.variants.find(w => w.ring === 0)!;
        const tone = (q: number) => v.colours[q * 4 + 1];
        const root = tone(0), mid = tone(3 * 3), upper = tone(4 * 3);
        expect(root).toBeCloseTo(0.8 * 0.3, 3);
        expect(mid).toBeGreaterThan(root * 2);
        expect(upper).toBeGreaterThanOrEqual(mid);
    });

    it('lays a darker, textured sheet under the blades on the grass cells only, lifted off the measured surface', () => {
        const u = field.underlayer, nv = u.positions.length / 3;
        expect(nv).toBeGreaterThan(1000);
        expect(u.areaM2).toBeGreaterThan(1000);
        let interiorMax = 0, edgeMax = 0;
        for (let q = 0; q < nv; q++) {
            const x = u.positions[q * 3], y = u.positions[q * 3 + 1], z = u.positions[q * 3 + 2];
            // on the grass, never on a building or the pond, within the 40 m disk
            expect(inRect(x, z, FULL) || inRect(x, z, HALF)).toBe(true);
            expect(inRect(x, z, BUILDING) || inRect(x, z, POND)).toBe(false);
            expect(Math.hypot(x, z)).toBeLessThanOrEqual(40 + 1e-4);
            // the scan's ground over the confident lawn, else the cell surface, plus the lift
            expect(y).toBeCloseTo((inRect(x, z, FULL) ? 10.23 : 10.03) + 0.02, 3);
            const g = u.colours[q * 4 + 1], deep = x > -24 && x < -4 && z > -8 && z < -2, rim = inRect(x, z, [-28, -10, -27, 2] as Rect);
            if (deep) interiorMax = Math.max(interiorMax, g);
            if (rim) edgeMax = Math.max(edgeMax, g);
        }
        // the seen lawn colour 0.12 green, over the texture's mean: deep inside darkened to at most 0.78 of it, the rim brighter
        const mean = field.report.underlayer.textureMean;
        expect(mean).toBeGreaterThan(0.65);
        expect(mean).toBeLessThan(0.9);
        expect(interiorMax).toBeLessThanOrEqual((0.12 * 0.78) / mean + 1e-4);
        expect(edgeMax).toBeGreaterThan(interiorMax);
        // the detail texture: blade-scale strokes, not flat
        expect(u.texture.length).toBe(u.texPx * u.texPx * 4);
        let sd = 0;
        for (let q = 0; q < u.texture.length; q += 4) sd += (u.texture[q] / 255 - mean) ** 2;
        expect(Math.sqrt(sd / (u.texture.length / 4))).toBeGreaterThan(0.05);
    });

    it('blends the photo colour between cells: no 1 m squares in the underlayer or the blade tints', async () => {
        // a 20 x 20 m lawn, its west half one green and its east half another; no clumps' contact shade in the way
        const n = 20, M = n * n, mask = new Uint8Array(M).fill(1), colour = new Float32Array(M * 3);
        for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) colour.set(i < 10 ? [0.04, 0.10, 0.03] : [0.10, 0.14, 0.05], (k * n + i) * 3);
        const g: GrassFieldGrid = {
            nx: n, nz: n, x0: -10, z0: -10, cellM: 1, mask, exclude: new Uint8Array(M), confidence: new Float32Array(M).fill(1),
            surfaceY: new Float32Array(M).fill(0), colour
        };
        const f = await buildGrassField(g, tmp(), { densityPerM2: 2, bandRadiusM: 30, underlayerRadiusM: 30, contactShade: 0, pixelAngle: 0 });
        const u = f.underlayer;
        // along the row z = 0 (inside the lawn, away from its edges), the red channel west to east
        const row: Array<[number, number]> = [];
        for (let q = 0; q < u.positions.length / 3; q++) if (Math.abs(u.positions[q * 3 + 2]) < 1e-4 && Math.abs(u.positions[q * 3]) <= 4) row.push([u.positions[q * 3], u.colours[q * 4]]);
        row.sort((a, b) => a[0] - b[0]);
        const lo = row[0][1], hi = row[row.length - 1][1];
        expect(hi).toBeGreaterThan(lo * 2);
        // the change is spread over the metre between the two cell centres: no vertex-to-vertex step holds most of it
        let maxStep = 0;
        for (let q = 1; q < row.length; q++) maxStep = Math.max(maxStep, Math.abs(row[q][1] - row[q - 1][1]));
        expect(maxStep).toBeLessThan((hi - lo) * 0.3);
        // halfway between the centres of the two cells at the boundary (x = 0), halfway between the colours
        const mid = row.find(r => Math.abs(r[0]) < 1e-4)!;
        expect(mid[1]).toBeCloseTo((lo + hi) / 2, 2);
        // the blade tints blend the same way: a clump near the boundary takes a colour between the two
        const tints: Array<[number, number]> = [];
        for (const v of f.variants) for (let q = 0; q < v.confidence.length; q++) if (Math.abs(v.translation[q * 3]) < 0.4) tints.push([v.translation[q * 3], v.tint[q * 3] / (1 + 0)]);
        expect(tints.length).toBeGreaterThan(0);
        const strictlyBetween = tints.filter(([, r]) => r > 0.04 / 0.8 * 1.09 && r < 0.10 / 0.8 * 0.91).length;
        expect(strictlyBetween).toBeGreaterThan(0);
    });
});
