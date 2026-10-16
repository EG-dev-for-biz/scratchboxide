/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tile vegetation (scratchbox_tile_vegetation.hpp + scripts/tile_vegetation.cpp), compiled with clang++ and run through
 * TileVegetationService on a synthetic photo-textured tile with known ground truth: three rough green crowns draped
 * onto flat ground (one with a grey drape hem hanging 3 m beyond it, one with a planar tile-seam curtain under it, as
 * real photogrammetry has), one crown cut by the tile edge, and a planar building whose roof carries a low green bump.
 *
 * strip must find each crown where it stands with its height above the ground, keep the roof bump (lower than the
 * minimum tree height) and the cut crown as scanned, remove the trees with their drape and curtains down to the ground
 * and cap it on the ground without opening any hole or leaving any wall standing. plant must grow one SB-Veggie tree
 * per crown within the triangle budget, in studio clay, deterministically, and write nothing geodetic into the trees
 * model. Screenshots (top-down measurement, clay renders before/after) go to test-results/screenshots/tile_vegetation/
 * (gitignored).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TileVegetationError, TileVegetationService, type TileVegetationStripResult } from '../src/node/3d-engine/tile-vegetation-service';
import { buildSyntheticTile, localToEcef, tileToLatLng, type SyntheticCurtain, type SyntheticTileSpec, type SyntheticTree } from './helpers/synthetic-textured-tile';
import { parseGlb, readGlbTriangles, renderClayPng, type GlbTriangles } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_vegetation');

const INTERIOR: SyntheticTree[] = [
    { x: -12, z: -10, height: 11, radius: 4.5 },
    { x: 10, z: 12, height: 8, radius: 3.5 },
    { x: -14, z: 14, height: 14, radius: 5.5, hem: 3, hemHeight: 3.5 }
];
/** A planar curtain under the first crown, from the ground to 0.4 m under its canopy (a tile-seam curtain). */
const CURTAIN: SyntheticCurtain = { x0: -15.5, z0: -8, x1: -8.5, z1: -8, belowCanopy: 0.4 };
const CUT: SyntheticTree = { x: 28.5, z: -20, height: 9, radius: 4 };
const ANCHOR = { lat: 40.7411, lng: -73.9897, ellipsoidalHeightM: -22.5 };
const SPEC: SyntheticTileSpec = {
    halfSize: 30,
    spacing: 0.75,
    trees: [...INTERIOR, CUT],
    curtains: [CURTAIN],
    building: { x0: 4, z0: -16, x1: 16, z1: -4, height: 15, roofBump: { x: 10, z: -10, height: 1.6, radius: 2.5 } },
    anchor: ANCHOR
};

/** Edges used by exactly one triangle, vertices welded at 1 cm (independent of the native welding). */
function openEdges(t: GlbTriangles): number {
    const key = (v: number) => `${Math.round(t.positions[v * 3] * 100)},${Math.round(t.positions[v * 3 + 1] * 100)},${Math.round(t.positions[v * 3 + 2] * 100)}`;
    const ids = new Map<string, number>();
    const weld = (v: number) => {
        const k = key(v);
        let id = ids.get(k);
        if (id === undefined) { id = ids.size; ids.set(k, id); }
        return id;
    };
    const edges = new Map<string, number>();
    for (let i = 0; i < t.indices.length; i += 3) {
        const w = [weld(t.indices[i]), weld(t.indices[i + 1]), weld(t.indices[i + 2])];
        for (let j = 0; j < 3; j++) {
            const a = w[j], b = w[(j + 1) % 3];
            if (a === b) continue;
            const e = a < b ? `${a}:${b}` : `${b}:${a}`;
            edges.set(e, (edges.get(e) ?? 0) + 1);
        }
    }
    let open = 0;
    for (const n of edges.values()) if (n === 1) open++;
    return open;
}

/** Triangles whose centroid lies within `r` (horizontally) of (x, z) and above `minY`. */
function trianglesNear(t: GlbTriangles, x: number, z: number, r: number, minY: number): number {
    let n = 0;
    for (let i = 0; i < t.indices.length; i += 3) {
        let cx = 0, cy = 0, cz = 0;
        for (let j = 0; j < 3; j++) { const v = t.indices[i + j]; cx += t.positions[v * 3] / 3; cy += t.positions[v * 3 + 1] / 3; cz += t.positions[v * 3 + 2] / 3; }
        if (Math.hypot(cx - x, cz - z) <= r && cy > minY) n++;
    }
    return n;
}

/** Binary glTF 2.0 header: magic "glTF", version 2, declared length equal to the file, JSON chunk first. */
function expectValidGlb(buf: Buffer): void {
    expect(buf.subarray(0, 4).toString('latin1')).toBe('glTF');
    expect(buf.readUInt32LE(4)).toBe(2);
    expect(buf.readUInt32LE(8)).toBe(buf.length);
    expect(buf.readUInt32LE(16)).toBe(0x4e4f534a);
}

function sha(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

let work: string;
let svc: TileVegetationService;
let strip: TileVegetationStripResult;
let crowns: any[];
let raw: GlbTriangles;
let out: GlbTriangles;

beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-vegetation-'));
    fs.writeFileSync(path.join(work, 'tile.glb'), buildSyntheticTile(SPEC));
    svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
    strip = await svc.strip({ tilePath: 'tile.glb', topDown: true });
    crowns = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8')).crowns;
    raw = readGlbTriangles(fs.readFileSync(path.join(work, 'tile.glb')));
    out = readGlbTriangles(fs.readFileSync(strip.devegetatedGlb));
}, 600_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('tile_vegetation strip on a synthetic photo-textured tile', () => {
    it('finds each tree crown where it stands, with its height above the ground and its lat/lng', () => {
        const trees = crowns.filter(c => c.status === 'tree');
        expect(trees).toHaveLength(INTERIOR.length);
        const frame = localToEcef(ANCHOR.lat, ANCHOR.lng, ANCHOR.ellipsoidalHeightM);
        for (const t of INTERIOR) {
            const c = trees.reduce((best: any, x: any) => (Math.hypot(x.stem[0] - t.x, x.stem[1] - t.z) < Math.hypot(best.stem[0] - t.x, best.stem[1] - t.z) ? x : best));
            expect(Math.hypot(c.stem[0] - t.x, c.stem[1] - t.z)).toBeLessThan(0.75);
            expect(Math.abs(c.supportY)).toBeLessThan(0.1);
            expect(Math.abs(c.apexAboveSupport - t.height)).toBeLessThan(0.6);
            const area = Math.PI * t.radius * t.radius;
            expect(c.areaM2).toBeGreaterThan(0.6 * area);
            expect(c.areaM2).toBeLessThan(1.5 * area);
            const sector = c.sectorRadii as number[];
            expect(Math.min(...sector)).toBeGreaterThan(0.5 * t.radius);
            expect(Math.max(...sector)).toBeLessThan(1.5 * t.radius);
            expect(c.samples.length).toBeGreaterThan(10);
            // geodesy: the reported stem lat/lng is the stem through the tile's own frame
            const ll = tileToLatLng(frame, c.stem[0], c.supportY, c.stem[1]);
            expect(Math.abs(c.stemLatLng[0] - ll.lat)).toBeLessThan(1e-7);
            expect(Math.abs(c.stemLatLng[1] - ll.lng)).toBeLessThan(1e-7);
            const truth = tileToLatLng(frame, t.x, 0, t.z);
            expect(Math.abs(c.stemLatLng[0] - truth.lat) * 111_000).toBeLessThan(0.75);
        }
    });

    it('keeps roof vegetation lower than the minimum tree height in the scan, measured against the roof', () => {
        const bump = SPEC.building!.roofBump!;
        const low = crowns.find(c => Math.hypot(c.stem[0] - bump.x, c.stem[1] - bump.z) < 1.5);
        expect(low?.status).toBe('below_min_height');
        expect(Math.abs(low.supportY - SPEC.building!.height)).toBeLessThan(0.1);
        expect(low.apexAboveSupport).toBeLessThan(3);
        const before = trianglesNear(raw, bump.x, bump.z, bump.radius, SPEC.building!.height + 0.1);
        expect(before).toBeGreaterThan(20);
        expect(trianglesNear(out, bump.x, bump.z, bump.radius, SPEC.building!.height + 0.1)).toBe(before);
    });

    it('keeps a crown cut by the extraction boundary as scanned and reports it', () => {
        const cut = crowns.find(c => Math.hypot(c.stem[0] - CUT.x, c.stem[1] - CUT.z) < 2);
        expect(cut?.status).toBe('cut_at_boundary');
        const before = trianglesNear(raw, CUT.x, CUT.z, CUT.radius, 0.5);
        expect(before).toBeGreaterThan(20);
        expect(trianglesNear(out, CUT.x, CUT.z, CUT.radius, 0.5)).toBe(before);
    });

    it('removes the trees down to the ground, caps it on the terrain, and opens no hole', () => {
        expect(strip.stats.triangles.removed).toBeGreaterThan(300);
        // no hole: the output has no more open edges than the input (welded independently here)
        expect(openEdges(out)).toBeLessThanOrEqual(openEdges(raw));
        expect(strip.stats.openEdges.after).toBeLessThanOrEqual(strip.stats.openEdges.before);
        for (const t of INTERIOR) {
            expect(trianglesNear(raw, t.x, t.z, 0.75 * t.radius, 1)).toBeGreaterThan(20);
            // nothing is left standing in the cleared footprint or its hem (the scanned crown drapes down to the ground
            // around it, with the grey hem and the curtain), and the cap sits on the ground (y = 0 here)
            const reach = Math.max(1.5 * t.radius, t.radius + (t.hem ?? 0) + 0.5);
            let maxY = -Infinity, minY = Infinity, n = 0;
            for (let v = 0; v < out.positions.length; v += 3) {
                if (Math.hypot(out.positions[v] - t.x, out.positions[v + 2] - t.z) > reach) continue;
                maxY = Math.max(maxY, out.positions[v + 1]);
                minY = Math.min(minY, out.positions[v + 1]);
                n++;
            }
            expect(n).toBeGreaterThan(3);
            // only scan that never rose more than the clearance (0.3 m) above the ground stays
            expect(maxY).toBeLessThan(0.35);
            expect(minY).toBeGreaterThan(-0.05);
        }
        // every point the cap itself put down (lowered loop points, interior points) lies on the ground: within 0.05 m
        const scanXZ = new Set<string>();
        for (let v = 0; v < raw.positions.length; v += 3) scanXZ.add(`${Math.round(raw.positions[v] * 100)},${Math.round(raw.positions[v + 2] * 100)}`);
        const capTris = out.nodeRanges.find(r => r.name === 'vegetation_removed_cap');
        expect(capTris).toBeDefined();
        let capPoints = 0, capWorst = 0;
        for (let i = capTris!.firstTriangle * 3; i < (capTris!.firstTriangle + capTris!.triangleCount) * 3; i++) {
            const v = out.indices[i];
            const x = out.positions[v * 3], y = out.positions[v * 3 + 1], z = out.positions[v * 3 + 2];
            if (scanXZ.has(`${Math.round(x * 100)},${Math.round(z * 100)}`)) continue;
            capPoints++;
            capWorst = Math.max(capWorst, Math.abs(y));
        }
        expect(capPoints).toBeGreaterThan(50);
        expect(capWorst).toBeLessThan(0.05);
        // the building is untouched: walls and roof keep every triangle
        const b = SPEC.building!;
        const inBuilding = (g: GlbTriangles) => {
            let n = 0;
            for (let i = 0; i < g.indices.length; i += 3) {
                let cx = 0, cy = 0, cz = 0;
                for (let j = 0; j < 3; j++) { const v = g.indices[i + j]; cx += g.positions[v * 3] / 3; cy += g.positions[v * 3 + 1] / 3; cz += g.positions[v * 3 + 2] / 3; }
                if (cx >= b.x0 - 0.01 && cx <= b.x1 + 0.01 && cz >= b.z0 - 0.01 && cz <= b.z1 + 0.01 && cy > 0.2) n++;
            }
            return n;
        };
        expect(inBuilding(out)).toBe(inBuilding(raw));
        // the curtain went with the tree as part of its drape (planar, but nothing planar meets its top), and no skirt
        // was needed anywhere: every hole edge lay on the ground
        expect(strip.stats.drape.sheets).toBeGreaterThanOrEqual(1);
        expect(trianglesNear(raw, (CURTAIN.x0 + CURTAIN.x1) / 2, CURTAIN.z0, 3, 1)).toBeGreaterThan(30);
        expect(strip.stats.skirts.areaM2).toEqual({ onWalls: 0, onLevelSurfaces: 0, onKeptCanopy: 0, onOther: 0 });
        expect(strip.stats.holes.capMaxRiseM).toBeLessThan(0.35);
        expectValidGlb(fs.readFileSync(strip.devegetatedGlb));
        // the photographs ride along unchanged
        const rawGlb = parseGlb(fs.readFileSync(path.join(work, 'tile.glb')));
        const outGlb = parseGlb(fs.readFileSync(strip.devegetatedGlb));
        expect(outGlb.json.images).toHaveLength(rawGlb.json.images.length);
        const bytes = (g: { json: any; bin: Buffer }, i: number) => {
            const v = g.json.bufferViews[g.json.images[i].bufferView];
            return g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
        };
        for (let i = 0; i < rawGlb.json.images.length; i++) expect(Buffer.compare(bytes(outGlb, i), bytes(rawGlb, i))).toBe(0);
        // and the frame too
        expect(outGlb.json.extras.localToEcef).toEqual(rawGlb.json.extras.localToEcef);
    });

    it('is deterministic', async () => {
        const again = await new TileVegetationService({ workspaceRoot: work, repoRoot: REPO, cacheDir: 'cache_again' }).strip({ tilePath: 'tile.glb', topDown: true });
        expect(again.cached).toBe(false);
        expect(sha(again.devegetatedGlb)).toBe(sha(strip.devegetatedGlb));
        expect(sha(again.crownsJson)).toBe(sha(strip.crownsJson));
    });

    it('fails with a typed error on a corrupt photo texture, and on a tile without photo textures', async () => {
        fs.writeFileSync(path.join(work, 'corrupt.glb'), buildSyntheticTile({ ...SPEC, corruptTexture: true }));
        fs.writeFileSync(path.join(work, 'clay.glb'), buildSyntheticTile({ ...SPEC, untextured: true }));
        const corrupt = await svc.strip({ tilePath: 'corrupt.glb' }).catch(e => e);
        expect(corrupt).toBeInstanceOf(TileVegetationError);
        expect(corrupt.code).toBe('texture_decode');
        const clay = await svc.strip({ tilePath: 'clay.glb' }).catch(e => e);
        expect(clay).toBeInstanceOf(TileVegetationError);
        expect(clay.code).toBe('no_photo_texture');
    });
});

describe('tile_vegetation plant (SB-Veggie, space colonisation)', () => {
    it('grows one clay tree per measured crown, in its place and size, within the triangle budget', async () => {
        const planted = await svc.plant({ crownsPath: strip.crownsJson, triangleBudget: 6000, seed: strip.tileSha256.slice(0, 16), publishAs: 'synthetic_trees.glb' });
        expect(planted.stats.trees).toBe(INTERIOR.length);
        expect(planted.stats.triangles).toBeLessThanOrEqual(6000);
        expect(planted.published?.url).toBe('/models/synthetic_trees.glb');
        expectValidGlb(fs.readFileSync(planted.treesGlb));
        const glb = parseGlb(fs.readFileSync(planted.treesGlb));
        expect(glb.json.materials).toHaveLength(1);
        expect(glb.json.materials[0].pbrMetallicRoughness).toMatchObject({ baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 });
        // nothing geodetic goes into the published model: the trees sit in the tile frame, mounted with the tile; the
        // crowns' lat/lng stay in the strip's cache entry (crowns.json)
        expect(glb.json.extras).toEqual({ frame: 'x = east, y = up, z = south (metres)', sbVeggie: expect.any(Object), sb: expect.objectContaining({ schema: 'scratchbox.staged-glb/2', stage: 'trees' }) });
        expect(JSON.stringify(glb.json)).not.toMatch(/LatLng|localToEcef|anchor/);
        const tris = readGlbTriangles(fs.readFileSync(planted.treesGlb));
        expect(tris.indices.length / 3).toBe(planted.stats.triangles);
        expect(tris.nodeRanges).toHaveLength(INTERIOR.length);
        for (const range of tris.nodeRanges) {
            expect(range.name).toMatch(/^sb_veggie_crown_\d+$/);
            const ex = range.extras;
            const crown = crowns.find(c => c.id === ex.crownId);
            expect(crown.status).toBe('tree');
            expect(ex.inferred).toMatchObject({ crownBaseRatio: 0.35, trunkRadiusPerHeight: 0.016 });
            expect(ex.triangles).toBeLessThanOrEqual(ex.triangleBudget);
            let minY = Infinity, maxY = -Infinity, maxR = 0;
            for (let i = range.firstTriangle * 3; i < (range.firstTriangle + range.triangleCount) * 3; i++) {
                const v = tris.indices[i];
                const x = tris.positions[v * 3], y = tris.positions[v * 3 + 1], z = tris.positions[v * 3 + 2];
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                maxR = Math.max(maxR, Math.hypot(x - crown.stem[0], z - crown.stem[1]));
            }
            const truth = INTERIOR.reduce((best, t) => (Math.hypot(t.x - crown.stem[0], t.z - crown.stem[1]) < Math.hypot(best.x - crown.stem[0], best.z - crown.stem[1]) ? t : best));
            expect(Math.abs(minY - crown.supportY)).toBeLessThan(0.3);  // stands on the ground it was measured on
            expect(maxY).toBeGreaterThan(crown.apex[1] - 1.5);          // reaches the measured apex ...
            expect(maxY).toBeLessThan(crown.apex[1] + 1.5);             // ... and no further
            expect(maxR).toBeLessThan(1.6 * truth.radius);
            expect(maxR).toBeGreaterThan(0.5 * truth.radius);
        }
    });

    it('stays within a tighter budget and grows the same trees again from the same crowns and seed', async () => {
        const a = await svc.plant({ crownsPath: strip.crownsJson, triangleBudget: 1200, seed: '00c0ffee' });
        const b = await new TileVegetationService({ workspaceRoot: work, repoRoot: REPO, cacheDir: 'cache_plant_again' }).plant({ crownsPath: strip.crownsJson, triangleBudget: 1200, seed: '00c0ffee' });
        expect(a.stats.triangles).toBeLessThanOrEqual(1200);
        expect(b.cached).toBe(false);
        expect(sha(b.treesGlb)).toBe(sha(a.treesGlb));
        const c = await svc.plant({ crownsPath: strip.crownsJson, triangleBudget: 1200, seed: '00c0ffef' });
        expect(sha(c.treesGlb)).not.toBe(sha(a.treesGlb));
    });

    it('plants only crowns whose trunk base stands on the support mesh (isolate requests)', async () => {
        // a ground patch around the first tree only
        const t = INTERIOR[0];
        const patch = buildSyntheticTile({ halfSize: 6, spacing: 1, trees: [] });
        // move it under the first tree: the synthetic builder centres on the origin, so shift the crowns instead
        const crownsDoc = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8'));
        for (const c of crownsDoc.crowns) {
            c.stem = [c.stem[0] - t.x, c.stem[1] - t.z];
            c.apex = [c.apex[0] - t.x, c.apex[1], c.apex[2] - t.z];
            c.samples = c.samples.map((s: number[]) => [s[0] - t.x, s[1], s[2] - t.z]);
        }
        fs.writeFileSync(path.join(work, 'shifted_crowns.json'), JSON.stringify(crownsDoc));
        fs.writeFileSync(path.join(work, 'patch.glb'), patch);
        const planted = await svc.plant({ crownsPath: 'shifted_crowns.json', triangleBudget: 4000, seed: 'abc', supportMeshPath: 'patch.glb' });
        expect(planted.stats.trees).toBe(1);
        expect(planted.stats.skipped.map((s: any) => s.reason)).toEqual(['not_on_support_mesh', 'not_on_support_mesh']);
    });

    it('fails with a typed error when the budget cannot hold the trees', async () => {
        const err = await svc.plant({ crownsPath: strip.crownsJson, triangleBudget: 100, seed: 'abc' }).catch(e => e);
        expect(err).toBeInstanceOf(TileVegetationError);
        expect(err.code).toBe('budget_too_small');
        expect(err.message).toContain('cannot hold 3 trees');
    });

    it('writes top-down and aerial clay screenshots of the measurement and the result', async () => {
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.copyFileSync(strip.topDownPng!, path.join(SHOTS, 'synthetic_topdown_measurement.png'));
        const planted = await svc.plant({ crownsPath: strip.crownsJson, triangleBudget: 6000, seed: strip.tileSha256.slice(0, 16) });
        const trees = readGlbTriangles(fs.readFileSync(planted.treesGlb));
        const shots: Array<[string, Buffer]> = [
            ['synthetic_raw_aerial.png', renderClayPng([{ positions: raw.positions, indices: raw.indices }], { kind: 'aerial', width: 960, height: 640, bearingDeg: 200, elevationDeg: 35 })],
            ['synthetic_rebuilt_aerial.png', renderClayPng([{ positions: out.positions, indices: out.indices }, { positions: trees.positions, indices: trees.indices }], { kind: 'aerial', width: 960, height: 640, bearingDeg: 200, elevationDeg: 35 })],
            ['synthetic_rebuilt_top.png', renderClayPng([{ positions: out.positions, indices: out.indices }, { positions: trees.positions, indices: trees.indices, color: [0.45, 0.55, 0.45] }], { kind: 'top', width: 800, height: 800 })]
        ];
        for (const [name, png] of shots) {
            fs.writeFileSync(path.join(SHOTS, name), png);
            expect(png.readUInt32BE(0)).toBe(0x89504e47);
            expect(png.length).toBeGreaterThan(5000);
        }
    });
});

/**
 * At the extraction's edge. A tree whose crown runs past the edge with its top well inside is a tree: measured up to the
 * edge and rebuilt. A crown whose top lies on the edge is cut (its top and trunk may be outside): beside nothing
 * removed it stays as scanned; joined at height to a tree that is removed, it cannot stay (its side would stand over
 * the hole the tree leaves, closable only by a wall nobody scanned), so it goes with that tree, reported and not
 * replanted. No skirt hangs from canopy anywhere.
 */
describe('tile_vegetation strip at the extraction edge', () => {
    const EDGE_REACHING: SyntheticTree = { x: -24, z: -18, height: 12, radius: 6.5 }; // runs past x = -30, top 6 m inside
    const JOINED_TREE: SyntheticTree = { x: 20, z: 12, height: 12, radius: 5.5 };
    const JOINED_CUT: SyntheticTree = { x: 29.5, z: 12, height: 12, radius: 6 };       // top on the edge, joined at ~6.5 m
    const LONE_CUT: SyntheticTree = { x: 2, z: 28.5, height: 9, radius: 4 };            // top 1.5 m from the edge, alone
    const EDGE_SPEC: SyntheticTileSpec = { halfSize: 30, spacing: 0.75, trees: [EDGE_REACHING, JOINED_TREE, JOINED_CUT, LONE_CUT], anchor: ANCHOR };
    let edge: TileVegetationStripResult;
    let edgeCrowns: any[];
    let edgeRaw: GlbTriangles;
    let edgeOut: GlbTriangles;
    const near = (t: SyntheticTree) => edgeCrowns.filter(c => Math.hypot(c.stem[0] - t.x, c.stem[1] - t.z) < t.radius).sort((a, b) => b.areaM2 - a.areaM2)[0];

    beforeAll(async () => {
        fs.writeFileSync(path.join(work, 'edge.glb'), buildSyntheticTile(EDGE_SPEC));
        edge = await svc.strip({ tilePath: 'edge.glb', topDown: true });
        edgeCrowns = JSON.parse(fs.readFileSync(edge.crownsJson, 'utf8')).crowns;
        edgeRaw = readGlbTriangles(fs.readFileSync(path.join(work, 'edge.glb')));
        edgeOut = readGlbTriangles(fs.readFileSync(edge.devegetatedGlb));
    }, 600_000);

    it('measures a tree that runs to the edge with its top inside as a tree, and a crown whose top is on the edge as cut', () => {
        const reaching = near(EDGE_REACHING);
        expect(reaching).toMatchObject({ status: 'tree', reachesBoundary: true });
        expect(Math.hypot(reaching.stem[0] - EDGE_REACHING.x, reaching.stem[1] - EDGE_REACHING.z)).toBeLessThan(1.5);
        expect(Math.abs(reaching.apexAboveSupport - EDGE_REACHING.height)).toBeLessThan(0.6);
        expect(near(JOINED_TREE)).toMatchObject({ status: 'tree', reachesBoundary: false });
        expect(near(LONE_CUT).status).toBe('cut_at_boundary');
        expect(edge.stats.crowns).toMatchObject({ tree: 2, treesReachingBoundary: 1, cutAtBoundary: 1, cutAtBoundaryRemoved: 1 });
    });

    it('takes cut canopy joined to a removed tree with it, keeps lone cut canopy, and closes the ground without walls', () => {
        // the joined cut crown went with the tree (reported, not replanted) ...
        expect(near(JOINED_CUT).status).toBe('cut_at_boundary_removed');
        expect(edge.stats.cutCanopyRemovedM2).toBeGreaterThan(20);
        expect(trianglesNear(edgeRaw, 27, JOINED_CUT.z, 2.5, 1)).toBeGreaterThan(20);
        expect(trianglesNear(edgeOut, 27, JOINED_CUT.z, 2.5, 0.35)).toBe(0);
        // ... the lone cut crown stays exactly as scanned ...
        const lone = trianglesNear(edgeRaw, LONE_CUT.x, LONE_CUT.z, LONE_CUT.radius, 0.5);
        expect(lone).toBeGreaterThan(20);
        expect(trianglesNear(edgeOut, LONE_CUT.x, LONE_CUT.z, LONE_CUT.radius, 0.5)).toBe(lone);
        // ... the tree that runs past the edge is gone up to the edge ...
        expect(trianglesNear(edgeOut, -28.5, EDGE_REACHING.z, 1.5, 0.35)).toBe(0);
        // ... and nothing stands where they were: no skirt at all (no wall here; no canopy left beside a hole) and no hole
        expect(edge.stats.skirts.areaM2).toEqual({ onWalls: 0, onLevelSurfaces: 0, onKeptCanopy: 0, onOther: 0 });
        expect(edge.stats.skirts.maxHeightByHangM.onKeptCanopy).toBe(0);
        expect(openEdges(edgeOut)).toBeLessThanOrEqual(openEdges(edgeRaw));
        for (const t of [JOINED_TREE, JOINED_CUT]) {
            let maxY = -Infinity;
            for (let v = 0; v < edgeOut.positions.length; v += 3) {
                if (Math.hypot(edgeOut.positions[v] - t.x, edgeOut.positions[v + 2] - t.z) <= t.radius) maxY = Math.max(maxY, edgeOut.positions[v + 1]);
            }
            expect(maxY).toBeLessThan(0.35);
        }
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.copyFileSync(edge.topDownPng!, path.join(SHOTS, 'synthetic_edge_topdown_measurement.png'));
    });

    it('rebuilds the tree that runs to the edge up to the edge, and plants nothing for the cut canopy', async () => {
        const planted = await svc.plant({ crownsPath: edge.crownsJson, triangleBudget: 6000, seed: 'e0ed' });
        expect(planted.stats.trees).toBe(2);
        const reaching = near(EDGE_REACHING);
        const tree = planted.stats.perTree.find((t: any) => t.crownId === reaching.id);
        expect(tree).toBeDefined();
        const [lo, hi] = tree.bounds as number[][];
        expect(lo[0]).toBeGreaterThan(-30.6);                                  // its measured crown ends at the edge
        expect(hi[1]).toBeGreaterThan(reaching.apex[1] - 1.5);
        const cutIds = edgeCrowns.filter(c => c.status !== 'tree').map(c => c.id);
        for (const t of planted.stats.perTree) expect(cutIds).not.toContain(t.crownId);
        const trees = readGlbTriangles(fs.readFileSync(planted.treesGlb));
        fs.writeFileSync(path.join(SHOTS, 'synthetic_edge_rebuilt_aerial.png'), renderClayPng([{ positions: edgeOut.positions, indices: edgeOut.indices }, { positions: trees.positions, indices: trees.indices }], { kind: 'aerial', width: 960, height: 640, bearingDeg: 200, elevationDeg: 35 }));
    });
});

/**
 * Ground with no level paving around the trees: a 20 degree hillside (every surface tilted, the building's roof too,
 * so the tile has no level surface at all) and a flat lawn (level, but green). Neither has a level grey surface to
 * rebuild the ground on; the ground is what the trees stand on, measured around each crown.
 */
describe('tile_vegetation strip where no level paving surrounds the trees: a hillside, a lawn', () => {
    const SLOPE = 0.36; // 19.8 degrees
    const HILL_TREES: SyntheticTree[] = [{ x: -10, z: -8, height: 11, radius: 4.5 }, { x: 9, z: 10, height: 9, radius: 3.5 }];
    const HILL_BUILDING = { x0: 12, z0: -22, x1: 24, z1: -12, height: 12 };
    const LAWN_RGB: [number, number, number] = [86, 128, 58];

    /** Strips `name` and checks the trees were measured and removed, and the ground rebuilt on `ground(x)`. */
    async function stripAndCheck(name: string, spec: SyntheticTileSpec, ground: (x: number) => number) {
        fs.writeFileSync(path.join(work, name), buildSyntheticTile(spec));
        const r = await svc.strip({ tilePath: name });
        const cs = JSON.parse(fs.readFileSync(r.crownsJson, 'utf8')).crowns;
        const before = readGlbTriangles(fs.readFileSync(path.join(work, name)));
        const after = readGlbTriangles(fs.readFileSync(r.devegetatedGlb));
        return { r, cs, before, after, ground };
    }

    function expectGroundRebuilt(x: Awaited<ReturnType<typeof stripAndCheck>>, trees: SyntheticTree[]) {
        const { r, cs, before, after, ground } = x;
        expect(cs.filter((c: any) => c.status === 'tree')).toHaveLength(trees.length);
        for (const t of trees) {
            const c = cs.find((k: any) => Math.hypot(k.stem[0] - t.x, k.stem[1] - t.z) < 0.75);
            expect(c?.status).toBe('tree');
            // the ground it stands on, measured against the slope: height under the stem and slope
            expect(Math.abs(c.supportY - ground(c.stem[0]))).toBeLessThan(0.1);
            expect(Math.abs(c.apexAboveSupport - t.height)).toBeLessThan(0.6);
            expect(Math.abs(c.supportTilt[0] - (ground(1) - ground(0)))).toBeLessThan(0.01);
            expect(Math.abs(c.supportTilt[1])).toBeLessThan(0.01);
            // nothing above the clearance is left where it stood
            expect(trianglesNear(before, t.x, t.z, 0.75 * t.radius, ground(t.x) + 1)).toBeGreaterThan(20);
            for (let v = 0; v < after.positions.length; v += 3) {
                if (Math.hypot(after.positions[v] - t.x, after.positions[v + 2] - t.z) > 1.5 * t.radius) continue;
                expect(after.positions[v + 1] - ground(after.positions[v])).toBeLessThan(0.35);
            }
        }
        expect(r.stats.triangles.removed).toBeGreaterThan(300);
        expect(openEdges(after)).toBeLessThanOrEqual(openEdges(before));
        // every point the cap put down lies on the ground (within 0.05 m), and nothing needed a skirt
        const scanXZ = new Set<string>();
        for (let v = 0; v < before.positions.length; v += 3) scanXZ.add(`${Math.round(before.positions[v] * 100)},${Math.round(before.positions[v + 2] * 100)}`);
        const cap = after.nodeRanges.find(n => n.name === 'vegetation_removed_cap')!;
        let capPoints = 0, worst = 0;
        for (let i = cap.firstTriangle * 3; i < (cap.firstTriangle + cap.triangleCount) * 3; i++) {
            const v = after.indices[i];
            const px = after.positions[v * 3], py = after.positions[v * 3 + 1], pz = after.positions[v * 3 + 2];
            if (scanXZ.has(`${Math.round(px * 100)},${Math.round(pz * 100)}`)) continue;
            capPoints++;
            worst = Math.max(worst, Math.abs(py - ground(px)));
        }
        expect(capPoints).toBeGreaterThan(20);
        expect(worst).toBeLessThan(0.05);
        expect(r.stats.skirts.areaM2).toEqual({ onWalls: 0, onLevelSurfaces: 0, onKeptCanopy: 0, onOther: 0 });
        expectValidGlb(fs.readFileSync(r.devegetatedGlb));
    }

    it('leaves a treeless 20 degree hillside as it is: zero canopy is a valid result', async () => {
        fs.writeFileSync(path.join(work, 'hill_bare.glb'), buildSyntheticTile({ halfSize: 30, spacing: 0.75, trees: [], slope: SLOPE, anchor: ANCHOR }));
        const r = await svc.strip({ tilePath: 'hill_bare.glb' });
        expect(JSON.parse(fs.readFileSync(r.crownsJson, 'utf8')).crowns).toEqual([]);
        expect(r.stats.triangles).toMatchObject({ removed: 0, cap: 0, skirt: 0 });
        expect(readGlbTriangles(fs.readFileSync(r.devegetatedGlb)).indices.length).toBe(readGlbTriangles(fs.readFileSync(path.join(work, 'hill_bare.glb'))).indices.length);
    });

    it('measures the trees on a 20 degree hillside with no level surface at all, and rebuilds the ground on the slope', async () => {
        const x = await stripAndCheck('hill.glb', { halfSize: 30, spacing: 0.75, trees: HILL_TREES, building: HILL_BUILDING, slope: SLOPE, anchor: ANCHOR }, px => SLOPE * px);
        expectGroundRebuilt(x, HILL_TREES);
        expect(x.cs.every((c: any) => c.supportSource === 'surrounding_surface')).toBe(true);
        // and the trees grow back standing on the slope
        const planted = await svc.plant({ crownsPath: x.r.crownsJson, triangleBudget: 6000, seed: x.r.tileSha256.slice(0, 16) });
        expect(planted.stats.trees).toBe(HILL_TREES.length);
        const trees = readGlbTriangles(fs.readFileSync(planted.treesGlb));
        for (const n of trees.nodeRanges) {
            let lowest = Infinity, lowestX = 0;
            for (let i = n.firstTriangle * 3; i < (n.firstTriangle + n.triangleCount) * 3; i++) {
                const v = trees.indices[i];
                if (trees.positions[v * 3 + 1] < lowest) { lowest = trees.positions[v * 3 + 1]; lowestX = trees.positions[v * 3]; }
            }
            expect(Math.abs(lowest - SLOPE * lowestX)).toBeLessThan(0.6); // the trunk base meets the ground (trunk radius on a 20 degree slope)
        }
        fs.mkdirSync(SHOTS, { recursive: true });
        const layers = [{ positions: x.after.positions, indices: x.after.indices }, { positions: trees.positions, indices: trees.indices }];
        fs.writeFileSync(path.join(SHOTS, 'synthetic_hillside_rebuilt_aerial.png'), renderClayPng(layers, { kind: 'aerial', width: 960, height: 640, bearingDeg: 200, elevationDeg: 35 }));
        fs.writeFileSync(path.join(SHOTS, 'synthetic_hillside_raw_aerial.png'), renderClayPng([{ positions: x.before.positions, indices: x.before.indices }], { kind: 'aerial', width: 960, height: 640, bearingDeg: 200, elevationDeg: 35 }));
    });

    // A street on a grade: the ground the trees stood on is rebuilt on the grade, not in level steps. (Ground counted as
    // level whenever most samples were within ~14 degrees left caps up to 0.75 m off a 2-14 degree slope.)
    it.each([5, 12])('rebuilds the ground on a %i degree grade on the grade, without steps', async (deg) => {
        const slope = Math.tan(deg * Math.PI / 180);
        const x = await stripAndCheck(`grade_${deg}.glb`, { halfSize: 30, spacing: 0.75, trees: HILL_TREES, building: HILL_BUILDING, slope, anchor: ANCHOR }, px => slope * px);
        expectGroundRebuilt(x, HILL_TREES);
    });

    it('keeps crowns as scanned on ground too steep to stand on, instead of rebuilding them on a guessed ground', async () => {
        // 34 degrees: no surface around the crowns is standable, so their ground is not measured. The terrain model (an
        // opening of the scan) reads metres low there; taking it as the ground dug pits and grew trees twice as tall.
        const slope = Math.tan(34 * Math.PI / 180);
        fs.writeFileSync(path.join(work, 'steep.glb'), buildSyntheticTile({ halfSize: 30, spacing: 0.75, trees: HILL_TREES, slope, anchor: ANCHOR }));
        const r = await svc.strip({ tilePath: 'steep.glb' });
        const cs = JSON.parse(fs.readFileSync(r.crownsJson, 'utf8')).crowns;
        expect(cs.length).toBeGreaterThan(0);
        for (const c of cs) {
            expect(c.status).toBe('no_measured_ground');
            expect(c.supportSource).toBe('none');
            expect(c.supportY).toBeNull();
        }
        expect(r.stats.crowns.noMeasuredGround).toBe(cs.length);
        expect(r.stats.crowns.tree).toBe(0);
        expect(r.stats.triangles).toMatchObject({ removed: 0, cap: 0, skirt: 0 });
        const before = readGlbTriangles(fs.readFileSync(path.join(work, 'steep.glb')));
        const after = readGlbTriangles(fs.readFileSync(r.devegetatedGlb));
        expect(after.indices.length).toBe(before.indices.length);
    });

    it('measures the trees on a level lawn (green, so no paving) against the lawn', async () => {
        const x = await stripAndCheck('lawn.glb', { halfSize: 30, spacing: 0.75, trees: HILL_TREES, groundRgb: LAWN_RGB, anchor: ANCHOR }, () => 0);
        expectGroundRebuilt(x, HILL_TREES);
    });
});
