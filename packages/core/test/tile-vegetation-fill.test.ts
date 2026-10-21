/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree strip's caps and skirts carry photo-inferred texels, never flat clay, and a skirt is kept off a real wall
 * (scratchbox_tile_vegetation.hpp buildFill / skirtBacking, scratchbox_strip_fill.hpp). A synthetic photo-textured tile
 * with a tree over pavement pressed against a building wall, in two scans:
 *
 *   A. the wall is in the scan below the crown's underside (crownBaseM 3): the skirt hanging from the crown's top crease
 *      is cut down to the band the tree hid (3 m up to the crease), the skirt hanging from the underside crease is a
 *      panel pasted over the scanned wall and is not built;
 *   B. the crown reaches the ground against the wall (crownBaseM 0): nothing of the wall under the crease is scanned, so
 *      the skirt is kept whole and textured from the wall above the crease.
 *
 * In both, the cap under the removed crown carries the pavement's own texels from the ring around the hole (not the
 * crown's green, not clay), every cap and skirt primitive is textured and labelled photo-inferred with a confidence, the
 * geometry is the same as with the fill off, and the photo transfer never reads the fill as the scan's photo.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TileVegetationService, type TileVegetationStripResult } from '../src/node/3d-engine/tile-vegetation-service';
import { buildTileSurface, readGlbChunks, readTileTriangles, type TaggedTileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { linearToSrgb255 } from '../src/common/spatial/photogrammetric-delight';
import { buildSyntheticTile, FACADE_RGB, FOLIAGE_RGB, GROUND_RGB, type SyntheticTileSpec } from './helpers/synthetic-textured-tile';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));

const HALF = 30, S = 0.75;
const BUILDING = { x0: 3, z0: -15, x1: 15, z1: -3, height: 15 };
/** Pressed against the building's west wall (x = 3): its centre 0.6 radii out, so the wall cuts the crown. */
const PRESSED = { x: BUILDING.x0 - 0.6 * 4.5, z: -9, height: 10, radius: 4.5 };
/** A tree in the open, for a cap with pavement all round. */
const OPEN = { x: -14, z: 12, height: 9, radius: 4 };

function spec(crownBaseM: number): SyntheticTileSpec {
    return { halfSize: HALF, spacing: S, trees: [{ ...PRESSED, againstWall: { crownBaseM } }, OPEN], building: BUILDING };
}

interface Out {
    strip: TileVegetationStripResult;
    glb: Buffer;
    json: any;
    tris: TaggedTileTriangles;
    /** Triangles (indices into tris) by node name. */
    byNode: Map<string, number[]>;
}

async function run(work: string, name: string, crownBaseM: number, params?: Record<string, number>): Promise<Out> {
    const dir = path.join(work, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'tile.glb'), buildSyntheticTile(spec(crownBaseM)));
    const svc = new TileVegetationService({ workspaceRoot: dir, repoRoot: REPO });
    const strip = await svc.strip({ tilePath: 'tile.glb', ...(params ? { params } : {}) });
    const glb = fs.readFileSync(strip.devegetatedGlb);
    const json = readGlbChunks(new Uint8Array(glb)).json;
    const tris = readTileTriangles(new Uint8Array(glb), { nodeTags: true });
    const byNode = new Map<string, number[]>();
    for (let t = 0; t < tris.node.length; t++) {
        const n = String(json.nodes[tris.node[t]]?.name ?? '');
        if (!byNode.has(n)) byNode.set(n, []);
        byNode.get(n)!.push(t);
    }
    return { strip, glb, json, tris, byNode };
}

/** Mean sRGB colour of the given triangles' texels at their centroids (flat colour for an untextured one). */
function meanColour(o: Out, ts: number[]): [number, number, number] {
    const sum = [0, 0, 0];
    for (const t of ts) {
        const ti = o.tris.texture[t];
        if (ti < 0) { for (let k = 0; k < 3; k++) sum[k] += linearToSrgb255(o.tris.flatLinear[t * 3 + k]); continue; }
        const tex = o.tris.textures[ti], U = o.tris.uvs;
        const u = (U[t * 6] + U[t * 6 + 2] + U[t * 6 + 4]) / 3, v = (U[t * 6 + 1] + U[t * 6 + 3] + U[t * 6 + 5]) / 3;
        const x = Math.min(tex.width - 1, Math.max(0, Math.floor(u * tex.width))), y = Math.min(tex.height - 1, Math.max(0, Math.floor(v * tex.height)));
        for (let k = 0; k < 3; k++) sum[k] += linearToSrgb255(tex.linear[(y * tex.width + x) * 3 + k]);
    }
    return [sum[0] / ts.length, sum[1] / ts.length, sum[2] / ts.length];
}

function near(c: number[], rgb: number[], tol: number): boolean {
    return Math.abs(c[0] - rgb[0]) <= tol && Math.abs(c[1] - rgb[1]) <= tol && Math.abs(c[2] - rgb[2]) <= tol;
}

/** Skirt triangles (indices) whose corners all lie within 0.1 m of the building's west wall plane. */
function wallSkirts(o: Out): number[] {
    const out: number[] = [];
    for (const name of ['vegetation_removed_skirt', 'vegetation_removed_skirt_generated']) {
        for (const t of o.byNode.get(name) ?? []) {
            const P = o.tris.positions;
            if (Math.abs(P[t * 9] - BUILDING.x0) < 0.1 && Math.abs(P[t * 9 + 3] - BUILDING.x0) < 0.1 && Math.abs(P[t * 9 + 6] - BUILDING.x0) < 0.1) out.push(t);
        }
    }
    return out;
}

/** Area of the built skirt triangles on the west wall (m²). */
function wallSkirtArea(o: Out): number {
    let a = 0;
    for (const t of wallSkirts(o)) {
        const P = o.tris.positions, o9 = t * 9;
        const e1 = [P[o9 + 3] - P[o9], P[o9 + 4] - P[o9 + 1], P[o9 + 5] - P[o9 + 2]], e2 = [P[o9 + 6] - P[o9], P[o9 + 7] - P[o9 + 1], P[o9 + 8] - P[o9 + 2]];
        a += 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
    }
    return a;
}

function minY(o: Out, ts: number[]): number {
    let y = Infinity;
    for (const t of ts) for (let k = 0; k < 3; k++) y = Math.min(y, o.tris.positions[t * 9 + k * 3 + 1]);
    return y;
}

const CLAY = [0.55, 0.57, 0.6].map(linearToSrgb255);
const STRIP_NODES = ['vegetation_removed_cap', 'vegetation_removed_skirt', 'vegetation_removed_cap_generated', 'vegetation_removed_skirt_generated'];

let work: string;
let A: Out, B: Out, Bclay: Out;

beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-vegetation-fill-'));
    A = await run(work, 'scanned_wall', 3);
    B = await run(work, 'hidden_wall', 0);
    Bclay = await run(work, 'hidden_wall_clay', 0, { fill: 0 });
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('the strip measures and removes the pressed crown in both scans', () => {
    it('removes a tree against a wall as a tree, in both scans', () => {
        for (const o of [A, B]) {
            const crowns = JSON.parse(fs.readFileSync(o.strip.crownsJson, 'utf8')).crowns as any[];
            const trees = crowns.filter(c => c.status === 'tree');
            expect(trees.length).toBe(2);
            expect(trees.some(c => Math.hypot(c.stem[0] - PRESSED.x, c.stem[1] - PRESSED.z) < 2.5)).toBe(true);
            expect(o.strip.stats.triangles.removed).toBeGreaterThan(200);
            expect((o.byNode.get('vegetation_removed_cap') ?? []).length).toBeGreaterThan(20);
        }
    });
});

describe('caps and skirts carry photo-inferred texels, never clay', () => {
    it('fills the cap under the pressed crown from the pavement around the hole, not from the crown it removed', () => {
        for (const o of [A, B]) {
            // the cap triangles within the pressed crown's footprint
            const caps = (o.byNode.get('vegetation_removed_cap') ?? []).filter(t => {
                const P = o.tris.positions;
                const cx = (P[t * 9] + P[t * 9 + 3] + P[t * 9 + 6]) / 3, cz = (P[t * 9 + 2] + P[t * 9 + 5] + P[t * 9 + 8]) / 3;
                return Math.hypot(cx - PRESSED.x, cz - PRESSED.z) < PRESSED.radius;
            });
            expect(caps.length).toBeGreaterThan(20);
            for (const t of caps) expect(o.tris.texture[t]).toBeGreaterThanOrEqual(0);
            const c = meanColour(o, caps);
            expect(near(c, GROUND_RGB, 12)).toBe(true);
            expect(near(c, FOLIAGE_RGB, 20)).toBe(false);
            expect(near(c, CLAY, 10)).toBe(false);
            // and the cap in the open the same
            const open = (o.byNode.get('vegetation_removed_cap') ?? []).filter(t => {
                const P = o.tris.positions;
                return Math.hypot((P[t * 9] + P[t * 9 + 3] + P[t * 9 + 6]) / 3 - OPEN.x, (P[t * 9 + 2] + P[t * 9 + 5] + P[t * 9 + 8]) / 3 - OPEN.z) < OPEN.radius;
            });
            expect(open.length).toBeGreaterThan(20);
            expect(near(meanColour(o, open), GROUND_RGB, 12)).toBe(true);
        }
    });

    it('leaves no untextured cap or skirt primitive and no clay area, and counts the texels honestly', () => {
        for (const o of [A, B]) {
            const f = o.strip.stats.fill;
            expect(f.enabled).toBe(true);
            expect(f.clayAreaM2).toEqual({ cap: 0, skirt: 0 });
            expect(f.cap.texels.real).toBeGreaterThan(0);
            expect(f.cap.texels.real + f.cap.texels.carried + f.cap.texels.generated).toBe(f.cap.texels.target);
            expect(f.cap.meanConfidence).toBeGreaterThan(0.3);
            expect(f.cap.meanConfidence).toBeLessThanOrEqual(1);
            expect(f.atlas.width).toBeGreaterThan(0);
            expect(f.atlas.pngBytes).toBeGreaterThan(1000);
            for (const name of STRIP_NODES) {
                const node = o.json.nodes.find((n: any) => n.name === name);
                if (!node) continue;
                const prim = o.json.meshes[node.mesh].primitives[0];
                const mat = o.json.materials[prim.material];
                expect(mat.name).toBe('VegetationFill');
                expect(mat.pbrMetallicRoughness.baseColorTexture.index).toBeGreaterThanOrEqual(0);
                expect(mat.extras.scratchbox.photoInferredFill).toBe(true);
                // provenance on the node: photo-inferred with a confidence, or generated (no real neighbour at all)
                const pv = node.extras.scratchbox.stripFill.provenance;
                expect(pv.measuredGeometry).toBe(false);
                if (name.endsWith('_generated')) {
                    expect(pv.label).toBe('generated');
                } else {
                    expect(pv.label).toBe('photo-inferred');
                    expect(pv.confidence).toBeGreaterThan(0);
                    expect(pv.confidence).toBeLessThanOrEqual(1);
                }
                // (a generated piece can be smaller than a texel: its target count may be 0)
                if (!name.endsWith('_generated')) expect(node.extras.scratchbox.stripFill.texels.target).toBeGreaterThan(0);
            }
            // every strip triangle in the output is textured (the fill atlas) and flagged as a fill for the photo transfer
            for (const name of STRIP_NODES) for (const t of o.byNode.get(name) ?? []) {
                expect(o.tris.texture[t]).toBeGreaterThanOrEqual(0);
                expect(o.tris.fill![t]).toBe(1);
            }
            for (const t of o.byNode.get('tile_m0') ?? []) expect(o.tris.fill![t]).toBe(0);
            // the legacy material is gone
            expect(o.json.materials.some((m: any) => m.name === 'VegetationRemovedCap')).toBe(false);
        }
    });

    it('is not the scan\'s photo for the photo transfer: a sample on the cap finds nothing, with the fill off it found clay', () => {
        const pointOnCap = (o: Out): [number, number, number] => {
            const caps = (o.byNode.get('vegetation_removed_cap') ?? []).filter(t => {
                const P = o.tris.positions;
                return Math.hypot((P[t * 9] + P[t * 9 + 3] + P[t * 9 + 6]) / 3 - OPEN.x, (P[t * 9 + 2] + P[t * 9 + 5] + P[t * 9 + 8]) / 3 - OPEN.z) < 0.5 * OPEN.radius;
            });
            const t = caps[0], P = o.tris.positions;
            return [(P[t * 9] + P[t * 9 + 3] + P[t * 9 + 6]) / 3, (P[t * 9 + 1] + P[t * 9 + 4] + P[t * 9 + 7]) / 3, (P[t * 9 + 2] + P[t * 9 + 5] + P[t * 9 + 8]) / 3];
        };
        const withFill = buildTileSurface(B.tris, { delight: false });
        expect(withFill.sample(pointOnCap(B), [0, 1, 0], 0.3)).toBeUndefined();
        // the legacy clay cap has a flat colour, which the transfer read as the tile's photo (the round-7 fault)
        const clay = buildTileSurface(Bclay.tris, { delight: false });
        const s = clay.sample(pointOnCap(Bclay), [0, 1, 0], 0.3);
        expect(s).toBeDefined();
        expect(near(s!.rgb, CLAY, 3)).toBe(true);
    });

    it('with the fill off writes the legacy clay primitives, with the same geometry', () => {
        expect(Bclay.strip.stats.fill.enabled).toBe(false);
        expect(Bclay.strip.stats.fill.clayAreaM2.cap).toBeGreaterThan(10);
        expect(Bclay.json.materials.some((m: any) => m.name === 'VegetationRemovedCap')).toBe(true);
        expect(Bclay.json.materials.some((m: any) => m.name === 'VegetationFill')).toBe(false);
        const sorted = (o: Out, names: string[]) => {
            const rows: string[] = [];
            for (const name of names) for (const t of o.byNode.get(name) ?? []) {
                const P = o.tris.positions;
                rows.push(Array.from(P.subarray(t * 9, t * 9 + 9)).map(v => v.toFixed(3)).join(','));
            }
            return rows.sort();
        };
        expect(sorted(B, ['vegetation_removed_cap', 'vegetation_removed_cap_generated'])).toEqual(sorted(Bclay, ['vegetation_removed_cap']));
        expect(sorted(B, ['vegetation_removed_skirt', 'vegetation_removed_skirt_generated'])).toEqual(sorted(Bclay, ['vegetation_removed_skirt']));
        // the photographs ride along unchanged, plus the fill atlas
        const rawImages = readGlbChunks(new Uint8Array(fs.readFileSync(path.join(work, 'hidden_wall', 'tile.glb')))).json.images.length;
        expect(Bclay.json.images.length).toBe(rawImages);
        expect(B.json.images.length).toBe(rawImages + 1);
    });
});

describe('a skirt on a wall is kept off the real wall', () => {
    it('A: the wall is scanned below the underside: the top skirt is cut down to the band the tree hid, the underside skirt is not built', () => {
        const d = A.strip.stats.skirtDecisions;
        expect(d.onWalls.shortened.count).toBeGreaterThanOrEqual(1);
        expect(d.onWalls.dropped.count).toBeGreaterThanOrEqual(1);
        expect(d.onWalls.shortened.areaRemovedM2).toBeGreaterThan(1);
        expect(d.onWalls.dropped.areaM2).toBeGreaterThan(1);
        expect(d.openEdgesAtDroppedSkirts).toBe(d.onWalls.dropped.count + d.onLevelSurfaces.dropped.count);
        // what was built on the wall lies above the underside: nothing pasted over the scanned wall
        const skirts = wallSkirts(A);
        expect(skirts.length).toBeGreaterThan(0);
        expect(minY(A, skirts)).toBeGreaterThan(3 - 0.05);
        // and it is textured from the wall itself
        expect(near(meanColour(A, skirts), FACADE_RGB, 14)).toBe(true);
        expect(near(meanColour(A, skirts), CLAY, 10)).toBe(false);
        // the strip's own accounting: what was built on walls is at least the whole skirts and less than everything
        // the hole edges asked for (the dropped area and the area cut off never reach the GLB)
        const onWalls = A.strip.stats.skirts.areaM2.onWalls;
        expect(onWalls).toBeGreaterThanOrEqual(d.onWalls.kept.areaM2 - 1e-6);
        expect(onWalls).toBeLessThan(d.onWalls.kept.areaM2 + d.onWalls.dropped.areaM2 + d.onWalls.shortened.areaRemovedM2 + wallSkirtArea(A));
    });

    it('B: nothing of the wall under the crown is scanned: the skirt is kept whole and textured from the wall above', () => {
        const d = B.strip.stats.skirtDecisions;
        expect(d.onWalls.kept.count).toBeGreaterThanOrEqual(1);
        expect(d.onWalls.dropped.count).toBe(0);
        expect(d.onWalls.shortened.count).toBe(0);
        const skirts = wallSkirts(B);
        expect(skirts.length).toBeGreaterThan(0);
        // down to the ground
        expect(minY(B, skirts)).toBeLessThan(0.1);
        expect(B.strip.stats.skirts.maxHeightByHangM.onWalls).toBeGreaterThan(3);
        expect(near(meanColour(B, skirts), FACADE_RGB, 14)).toBe(true);
        expect(near(meanColour(B, skirts), CLAY, 10)).toBe(false);
        expect(B.strip.stats.fill.skirt.texels.real).toBeGreaterThan(0);
        expect(B.strip.stats.fill.skirt.meanConfidence).toBeGreaterThan(0.2);
    });

    it('with the wall test off every skirt is built whole', async () => {
        const whole = await run(work, 'scanned_wall_whole', 3, { skirtDropBacked: 0 });
        const d = whole.strip.stats.skirtDecisions;
        expect(d.onWalls.dropped.count).toBe(0);
        expect(d.onWalls.shortened.count).toBe(0);
        expect(d.onWalls.kept.count).toBeGreaterThan(A.strip.stats.skirtDecisions.onWalls.kept.count);
        expect(minY(whole, wallSkirts(whole))).toBeLessThan(0.1);
    }, 300_000);
});
