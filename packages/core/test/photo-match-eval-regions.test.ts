/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The photo-match evaluator's regions (photo-match-eval.ts triangleRegions, renderTriangles `regions`, regionMasks,
 * regionScores) on synthetic scenes whose pixel counts are known exactly: orthographic cameras with every edge on a pixel
 * boundary, so each region's count follows from the geometry by hand. Then the per-region numbers against a "photo", and the
 * judge's opt-in region criteria (the old prompt is pinned by its hash). No network, no billed call; screenshots under
 * test-results/screenshots/photo_match_regions/.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { OrthoCamera } from '../src/common/spatial/texture-pass-contracts';
import { SRGB8_TO_LINEAR } from '../src/common/spatial/photogrammetric-delight';
import {
    aggregateCriteria, composeGrid, judgePrompt, judgeView, parseJudgeReply, planOutlineCells, regionMasks, regionOverlay, regionScores, renderTriangles, skylineBandPx, triangleRegions,
    JUDGE_REGION_CRITERIA, PHOTO_MATCH_GROUND_BAND_M, PHOTO_MATCH_REGION_LEGEND, REGION, type JudgeClient, type TerrainGrid, type TerrainLookup
} from '../src/node/3d-engine/staged-location/photo-match-eval';
import type { TileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/photo_match_regions');
const FLAT: TerrainLookup = { groundAt: () => 0 };

type V3 = [number, number, number];

/** Triangles of quads (corners in order), one flat linear colour, or one texture of stripes in two colours. */
function soup(quads: V3[][], colour: V3, stripe?: V3): TileTriangles {
    const P: number[] = [], UV: number[] = [], N: number[] = [];
    for (const q of quads) {
        const [a, b, c, d] = q;
        P.push(...a, ...b, ...c, ...a, ...c, ...d);
        UV.push(0, 1, 1, 1, 1, 0, 0, 1, 1, 0, 0, 0);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
        const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        N.push(n[0] / l, n[1] / l, n[2] / l, n[0] / l, n[1] / l, n[2] / l);
    }
    const nt = P.length / 9;
    const lin = colour.map(c => SRGB8_TO_LINEAR[c]);
    const textures: TileTriangles['textures'] = [];
    if (stripe) {
        const size = 32, linear = new Float32Array(size * size * 3);
        for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            const c = Math.floor(x / 4) % 2 ? colour : stripe;
            for (let k = 0; k < 3; k++) linear[(y * size + x) * 3 + k] = SRGB8_TO_LINEAR[c[k]];
        }
        textures.push({ width: size, height: size, linear, repeatS: false, repeatT: false });
    }
    return {
        positions: Float32Array.from(P), uvs: Float32Array.from(UV), normals: Float32Array.from(N), texture: new Int32Array(nt).fill(stripe ? 0 : -1),
        flatLinear: Float32Array.from(Array.from({ length: nt }, () => lin).flat()), textures
    };
}

/** A box's roof and four walls (x0..x1, z0..z1, from y = 0 to h). */
function box(x0: number, x1: number, z0: number, z1: number, h: number): V3[][] {
    return [
        [[x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]],
        [[x0, 0, z0], [x1, 0, z0], [x1, h, z0], [x0, h, z0]], [[x0, 0, z1], [x1, 0, z1], [x1, h, z1], [x0, h, z1]],
        [[x0, 0, z0], [x0, 0, z1], [x0, h, z1], [x0, h, z0]], [[x1, 0, z0], [x1, 0, z1], [x1, h, z1], [x1, h, z0]]
    ];
}

/** A vertical wall facing -z at depth z (x0..x1, y0..y1). */
const wall = (z: number, x0: number, x1: number, y0: number, y1: number): V3[] => [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]];

/** Straight down from 100 m, north (-z) up: 80 x 60 px at 0.5 m, x in [-20, 20], z in [-15, 15]. */
const TOP: OrthoCamera = { projection: 'ortho', eye: [0, 100, 0], right: [1, 0, 0], up: [0, 0, -1], fwd: [0, -1, 0], pixelM: 0.5, cx: 40, cy: 30, width: 80, height: 60 };
/** Looking north (+z) from z = -50 at 15 m: 320 x 240 px at 0.125 m, x in [-20, 20], y in [0, 30]. */
const FRONT: OrthoCamera = { projection: 'ortho', eye: [0, 15, -50], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, 1], pixelM: 0.125, cx: 160, cy: 120, width: 320, height: 240 };

const count = (labels: Uint8Array, l: number) => labels.reduce((n, x) => n + (x === l ? 1 : 0), 0);

/** The front scene: a neighbour wall across the frame (10 m), the target in front of it (20 m), a 0.5 m kerb nearest. */
function frontScene(colours: { target?: V3; neighbour?: V3; ground?: V3 } = {}, withNeighbour = true) {
    const target = soup([wall(10, -5, 5, 0, 20)], colours.target ?? [200, 60, 40], [230, 220, 190]);
    const neighbour = soup([wall(20, -20, 20, 0, 10)], colours.neighbour ?? [60, 90, 200], [180, 190, 210]);
    const kerb = soup([wall(5, -20, 20, 0, 0.5)], colours.ground ?? [120, 120, 112]);
    const meshes = withNeighbour ? [target, neighbour, kerb] : [target, kerb];
    const labels = withNeighbour
        ? [triangleRegions(target, FLAT, REGION.target), triangleRegions(neighbour, FLAT, REGION.neighbours), triangleRegions(kerb, FLAT, REGION.neighbours)]
        : [triangleRegions(target, FLAT, REGION.target), triangleRegions(kerb, FLAT, REGION.neighbours)];
    return { meshes, labels };
}

describe('photo-match regions from geometry', () => {
    it('labels triangles by height over the terrain and by footprint, never by colour', () => {
        // a kerb face (0.5 m) and a step 0.7 m high, both grey: the band alone separates them
        const kerb = soup([wall(0, 0, 1, 0, PHOTO_MATCH_GROUND_BAND_M - 0.1)], [128, 128, 128]);
        const step = soup([wall(0, 0, 1, 0, PHOTO_MATCH_GROUND_BAND_M + 0.1)], [128, 128, 128]);
        expect([...triangleRegions(kerb, FLAT, REGION.neighbours)]).toEqual([REGION.ground, REGION.ground]);
        expect([...triangleRegions(step, FLAT, REGION.neighbours)]).toEqual([REGION.neighbours, REGION.neighbours]);
        // on a slope the terrain under each vertex decides: a lawn 30 m up a hillside is ground, a wall on it is not
        const hill: TerrainLookup = { groundAt: (x: number) => 0.5 * x };
        const lawn = soup([[[60, 30.2, 0], [62, 31.2, 0], [62, 31.2, 2], [60, 30.2, 2]]], [60, 160, 60]);
        const wallOnHill = soup([wall(0, 60, 62, 30, 34)], [60, 160, 60]);
        expect([...triangleRegions(lawn, hill, REGION.neighbours)]).toEqual([REGION.ground, REGION.ground]);
        expect([...triangleRegions(wallOnHill, hill, REGION.neighbours)]).toEqual([REGION.neighbours, REGION.neighbours]);
        // off the measured terrain: ground when the facet faces within 60 degrees of up
        const none: TerrainLookup = { groundAt: () => NaN };
        expect([...triangleRegions(lawn, none, REGION.neighbours)]).toEqual([REGION.ground, REGION.ground]);
        expect([...triangleRegions(wallOnHill, none, REGION.neighbours)]).toEqual([REGION.neighbours, REGION.neighbours]);
        // the standing label can follow a footprint: the triangle's centroid is given
        const two = soup([wall(0, -4, -2, 0, 8), wall(0, 2, 4, 0, 8)], [128, 128, 128]);
        const seen: number[][] = [];
        const byFootprint = triangleRegions(two, FLAT, (i, x) => { seen.push([i, x]); return x < 0 ? REGION.target : REGION.neighbours; });
        expect([...byFootprint]).toEqual([REGION.target, REGION.target, REGION.neighbours, REGION.neighbours]);
        expect(seen.map(s => s[0])).toEqual([0, 1, 2, 3]);
    });

    it('draws a plan outline on the terrain grid from standing geometry: roofs by area, walls by their foot line, enclosed cells filled, the street left out', () => {
        // a flat 1 m grid over x, z in [-20, 20]
        const grid: TerrainGrid = {
            groundAt: () => 0, x0: -20, z0: -20, nx: 40, nz: 40, cellMeters: 1,
            cellIndex: (x, z) => { const i = Math.floor(x + 20), k = Math.floor(z + 20); return i < 0 || k < 0 || i >= 40 || k >= 40 ? -1 : k * 40 + i; }
        };
        const at = (cells: Uint8Array, x: number, z: number) => cells[grid.cellIndex(x, z)];
        const sum = (cells: Uint8Array) => cells.reduce((n, f) => n + f, 0);
        const grey: V3 = [128, 128, 128];
        // a roofed box 10 x 6 m: every cell whose centre lies within 1 m of it, x in [-6, 6) and z in [-4, 4)
        const roofed = planOutlineCells(soup(box(-5, 5, -3, 3, 12), grey), grid);
        expect(sum(roofed)).toBe(12 * 8);
        for (const [x, z] of [[0, 0], [5.9, 0], [-5.9, 3.9], [0, -3.9]]) expect(at(roofed, x, z), `${x}, ${z}`).toBe(1);
        for (const [x, z] of [[6.1, 0], [-6.1, 0], [0, 4.1], [0, -4.1]]) expect(at(roofed, x, z), `${x}, ${z}`).toBe(0);
        // four walls and no roof (a scan hole over the whole roof): the foot lines and every cell they enclose, 18 x 18
        const ring = box(-8, 8, -8, 8, 12).slice(1);
        const walls = planOutlineCells(soup(ring, grey), grid);
        expect(sum(walls)).toBe(18 * 18);
        expect(at(walls, 0, 0)).toBe(1);
        // a wall missing: nothing is enclosed, so the yard between the other three stays outside
        const open = planOutlineCells(soup([ring[0], ring[2], ring[3]], grey), grid);
        expect(at(open, 0, 0)).toBe(0);
        expect(at(open, -8, 0)).toBe(1);
        expect(at(open, 0, 8.6)).toBe(0);
        // the street (within the ground band of the terrain) draws nothing
        expect(sum(planOutlineCells(soup([[[-20, 0.1, -20], [20, 0.1, -20], [20, 0.1, 20], [-20, 0.1, 20]]], grey), grid))).toBe(0);
    });

    it('counts every region\'s pixels exactly from above: target roof, neighbour roof, ground, sky past the tile', () => {
        const ground = soup([[[-20, 0, -15], [12, 0, -15], [12, 0, 15], [-20, 0, 15]]], [110, 110, 104]);
        const target = soup(box(-10, 0, -6, 4, 16), [200, 60, 40]);
        const neighbour = soup(box(6, 16, -4, 4, 10), [60, 90, 200]); // it straddles the tile's edge at x = 12
        const meshes = [ground, target, neighbour];
        const labels = [triangleRegions(ground, FLAT, REGION.neighbours), triangleRegions(target, FLAT, REGION.target), triangleRegions(neighbour, FLAT, REGION.neighbours)];
        expect(labels[0].every(l => l === REGION.ground)).toBe(true);
        const r = renderTriangles(meshes, TOP, { regions: { meshes: labels } });
        const L = r.regions!;
        // target roof 10 x 10 m = 20 x 20 px; neighbour roof 10 x 8 m = 20 x 16 px; the ground 32 x 30 m less what stands on it
        expect(count(L, REGION.target)).toBe(400);
        expect(count(L, REGION.neighbours)).toBe(320);
        expect(count(L, REGION.ground)).toBe(64 * 60 - 400 - 12 * 16);
        expect(count(L, REGION.sky)).toBe(16 * 60 - 8 * 16);
        expect(count(L, REGION.trees)).toBe(0);
        // the masks hold the same counts; the coverage is the arm's, unchanged by labelling
        const m = regionMasks(L, 80, 60);
        expect(m.pixels).toMatchObject({ target: 400, neighbours: 320, ground: 3248, sky: 832, trees: 0 });
        expect(m.masks.building.reduce((n, x) => n + x, 0)).toBe(400);
        expect(m.masks.frame.reduce((n, x) => n + x, 0)).toBe(4800);
        expect(r.coverage.reduce((n, x) => n + x, 0)).toBe(4800 - 832);
        // a mesh list that does not match the meshes is a mistake, not a silent mislabel
        expect(() => renderTriangles(meshes, TOP, { regions: { meshes: labels.slice(1) } })).toThrow(/regions name/);
    });

    it('counts the front view exactly, the kerb as ground, and draws the skyline band where standing geometry meets the sky', () => {
        const { meshes, labels } = frontScene();
        const r = renderTriangles(meshes, FRONT, { regions: { meshes: labels } });
        const L = r.regions!;
        // at 8 px per metre: the kerb row (0.5 m = 4 rows), the target 10 x 20 m, the neighbour 40 x 10 m behind it
        expect(count(L, REGION.ground)).toBe(320 * 4);
        expect(count(L, REGION.target)).toBe(80 * 160 - 80 * 4);
        expect(count(L, REGION.neighbours)).toBe(320 * 80 - 80 * 80 - 240 * 4);
        expect(count(L, REGION.sky)).toBe(320 * 160 - 80 * 80);
        // the band against an independent, brute-force one built from the scene's rectangles
        const b = skylineBandPx(320);
        expect(b).toBe(4);
        const expected = new Uint8Array(320 * 240);
        for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
            const inTarget = x >= 120 && x < 200 && y >= 80, inNeighbour = y >= 160;
            expected[y * 320 + x] = y >= 236 ? REGION.ground : inTarget ? REGION.target : inNeighbour ? REGION.neighbours : REGION.sky;
        }
        expect(Buffer.from(L).equals(Buffer.from(expected))).toBe(true);
        const edge: Array<[number, number]> = [];
        const standing = (l: number) => l === REGION.target || l === REGION.neighbours;
        for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
            const l = expected[y * 320 + x];
            const nb = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([u, v]) => u >= 0 && v >= 0 && u < 320 && v < 240).map(([u, v]) => expected[v * 320 + u]);
            if ((standing(l) && nb.includes(REGION.sky)) || (l === REGION.sky && nb.some(standing))) edge.push([x, y]);
        }
        const m = regionMasks(L, 320, 240);
        let brute = 0;
        for (let y = 0; y < 240; y++) for (let x = 0; x < 320; x++) {
            const near = edge.some(([u, v]) => (u - x) ** 2 + (v - y) ** 2 <= b * b) ? 1 : 0;
            brute += near;
            expect(m.masks.skyline[y * 320 + x], `(${x}, ${y})`).toBe(near);
        }
        expect(m.pixels.skyline).toBe(brute);
        // the ground never makes a skyline: only the neighbour's straight roofline, across the whole frame
        const plain = renderTriangles([meshes[1]], FRONT, { regions: { meshes: [labels[1]] } });
        expect(regionMasks(plain.regions!, 320, 240).pixels.skyline).toBe((2 * b + 2) * 320);
        fs.mkdirSync(SHOTS, { recursive: true });
        const photo = renderTriangles(meshes, FRONT);
        fs.writeFileSync(path.join(SHOTS, 'regions_front.png'), composeGrid([
            { image: photo, label: 'SCENE' }, { image: regionOverlay(photo, L, m.masks.skyline), label: PHOTO_MATCH_REGION_LEGEND[0], sublabel: PHOTO_MATCH_REGION_LEGEND[1] }
        ], { tileWidth: 480, columns: 2 }));
    });

    it('measures the numbers per region against a photo, and how far each arm\'s labels agree with the reference\'s', () => {
        const truth = frontScene();
        const photoR = renderTriangles(truth.meshes, FRONT);
        const photo = { width: photoR.width, height: photoR.height, rgba: photoR.rgba };
        const ref = renderTriangles(truth.meshes, FRONT, { regions: { meshes: truth.labels } }).regions!;
        const masks = regionMasks(ref, 320, 240);
        const score = (s: ReturnType<typeof frontScene>) => regionScores(photo, renderTriangles(s.meshes, FRONT, { regions: { meshes: s.labels } }), masks, ref);
        const same = score(truth);
        for (const k of ['frame', 'building', 'ground', 'neighbours', 'skyline'] as const) {
            expect(same[k].agreement, k).toBe(1);
            expect(same[k].colourDeltaE!, k).toBeLessThan(0.5);
        }
        for (const k of ['frame', 'building', 'neighbours', 'skyline'] as const) expect(same[k].ssim!, k).toBeGreaterThan(0.99);
        expect(same.frame.share).toBe(1);
        expect(same.building.share).toBeCloseTo(12480 / 76800, 2);
        expect(same.trees).toEqual({ share: 0, agreement: null, ssim: null, edgeChamferPx: null, colourDeltaE: null, maskPixels: 0 });
        // the neighbour in the wrong colour: the neighbours' numbers move, the building's barely do
        const recoloured = score(frontScene({ neighbour: [200, 180, 40] }));
        expect(recoloured.neighbours.colourDeltaE!).toBeGreaterThan(20);
        expect(recoloured.building.colourDeltaE!).toBeLessThan(3);
        expect(recoloured.neighbours.agreement).toBe(1);
        // the neighbour missing: its region shows sky in the arm (agreement 0), the building agrees, the skyline moves
        const missing = score(frontScene({}, false));
        expect(missing.neighbours.agreement).toBe(0);
        expect(missing.building.agreement).toBe(1);
        expect(missing.skyline.agreement!).toBeLessThan(0.9);
        expect(missing.frame.agreement!).toBeLessThan(same.frame.agreement!);
        expect(missing.neighbours.ssim!).toBeLessThan(same.neighbours.ssim!);
        // an arm rendered without labels has no agreement, the numbers still stand
        const unlabelled = regionScores(photo, renderTriangles(truth.meshes, FRONT), masks, ref);
        expect(unlabelled.building.agreement).toBeNull();
        expect(unlabelled.building.ssim!).toBeGreaterThan(0.99);
    });
});

describe('photo-match judge, region criteria', () => {
    it('keeps the old prompt and reply for old callers, and asks for the place around the building only on request', () => {
        const p = judgePrompt('PLACE', 3);
        // the prompt every report before the regions was judged with
        expect(crypto.createHash('sha256').update(p.preamble + '\n' + p.closing).digest('hex')).toBe('0957f6b95db66330bc35f2d1f9af747540925d78c6494d3e67997c8941e049c5');
        expect(judgePrompt('PLACE', 3, { regions: false })).toEqual(p);
        const q = judgePrompt('PLACE', 3, { regions: true });
        for (const c of JUDGE_REGION_CRITERIA) expect(q.closing).toMatch(new RegExp(`- ${c}: `));
        expect(q.closing).toMatch(/"ground":n,"neighbours":n,"skyline":n/);
        expect(q.closing).toMatch(/on ten criteria/);
        const old = '{"renders":[{"image":1,"shape":3,"materials":4,"detail":5,"errors":6,"overall":7}]}';
        expect(parseJudgeReply(old, 1).problems).toEqual([]);
        expect(parseJudgeReply(old, 1, { regions: true }).problems).toEqual(['image 1: ground is undefined']);
        const full = '{"renders":[{"image":1,"shape":3,"materials":4,"detail":5,"errors":6,"overall":7,"ground":2,"neighbours":8,"skyline":9,"note":"x"}]}';
        expect(parseJudgeReply(full, 1, { regions: true }).scores[0]).toMatchObject({ ground: 2, neighbours: 8, skyline: 9, overall: 7 });
        // an old reader keeps reading only what it read before
        expect(parseJudgeReply(full, 1).scores[0]).not.toHaveProperty('ground');
    });

    it('maps region scores back to the arms through the reshuffles', async () => {
        const marks: Record<string, number> = { a: 2, b: 8 };
        const prompts: string[] = [];
        // the stand-in judge reads each render's first byte of image data to know which it is (it is never told)
        const pngs = { a: Buffer.from([1, 1, 1, 1]), b: Buffer.from([2, 2, 2, 2]) };
        const client: JudgeClient = {
            async generate(params) {
                prompts.push(params.contents[0].parts.map(x => x.text ?? '').join(' '));
                const imgs = params.contents[0].parts.filter(x => x.inlineData).slice(1).map(x => Buffer.from(x.inlineData!.data, 'base64')[0]);
                const renders = imgs.map((tag, k) => {
                    const s = tag === 1 ? marks.a : marks.b;
                    return { image: k + 1, shape: 5, materials: 5, detail: 5, errors: 5, overall: 5, ground: s, neighbours: 11 - s, skyline: s, note: '' };
                });
                return { model: 'stand-in', response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ renders }) }] } }] } };
            }
        };
        const runs = await judgeView({ client, place: 'P', photo: { bytes: Buffer.from([0]), mimeType: 'image/png' }, renders: [{ armId: 'a', png: pngs.a }, { armId: 'b', png: pngs.b }], repeats: 4, seed: 's', regions: true });
        expect(new Set(runs.map(r => r.order.join(','))).size).toBeGreaterThan(1);
        expect(prompts.every(t => /- skyline: /.test(t))).toBe(true);
        const agg = aggregateCriteria(runs, ['a', 'b'], JUDGE_REGION_CRITERIA);
        expect(agg.a.ground.mean).toBe(2);
        expect(agg.b.ground.mean).toBe(8);
        expect(agg.a.neighbours.mean).toBe(9);
        expect(agg.b.skyline).toMatchObject({ mean: 8, sd: 0 });
    });
});
