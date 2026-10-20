/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The trees layer's bounds, on real SB-Veggie trees planted by the native engine (TileVegetationService, compiled with
 * clang++), which writes them quantised (KHR_mesh_quantization: normalised SHORT positions inside a node scale) with
 * instanced leaf clusters (EXT_mesh_gpu_instancing):
 *
 * - the shared GLB reader (glbToTriangleSoup) reads them at their real size, the same triangles as the texture pass's
 *   reader; reading the normalised integers raw put staged trees at Haughwout Building 883,679 m up, so placement found
 *   every spot covered;
 * - with instances left out (as placement reads a vegetation layer) the crown tops are the same, from the far masses;
 * - glbWorldBounds holds every triangle and the placement sampler finds a crown top at its real height;
 * - a cached trees entry whose bounds are impossible is refused and rebuilt, saying why, and a layer with impossible
 *   bounds is named as such by implausibleLayerBounds.
 *
 * A top-down and an aerial clay render of the planted trees go to test-results/screenshots/ (gitignored).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { glbToTriangleSoup, glbWorldBounds, type TriangleSoup } from '../src/node/3d-engine/part-connectivity';
import { implausibleLayerBounds } from '../src/node/3d-engine/layer-bounds-guard';
import { readTileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { SurfaceSampler } from '../src/node/gemini/tools/object-reference-tools';
import { parseGlb, renderClayPng } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SHOTS = path.join(REPO, 'test-results/screenshots');
type Vec3 = [number, number, number];

function crown(id: number, stem: [number, number], supportY: number, apexY: number, radius: number) {
    const samples: Vec3[] = [];
    const n = Math.ceil(radius / 0.7);
    for (let i = -n; i <= n; i++) {
        for (let k = -n; k <= n; k++) {
            const dx = i * 0.7, dz = k * 0.7, d = Math.hypot(dx, dz);
            if (d > radius) continue;
            samples.push([stem[0] + dx, apexY - 0.45 * (apexY - supportY) * (d / radius) ** 2, stem[1] + dz]);
        }
    }
    return {
        id, status: 'tree', reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY, supportSource: 'given', terrainY: supportY,
        apexAboveSupport: apexY - supportY, areaM2: Math.PI * radius * radius, sectorRadii: new Array(16).fill(radius), samples
    };
}

const CROWNS = [crown(0, [0, 0], 0, 14, 4.5), crown(1, [16, 3], 0.4, 14, 4.5), crown(2, [4, -16], 0, 22, 6)];

let work: string;
let svc: TileVegetationService;

function writeCrowns(name: string): string {
    fs.writeFileSync(path.join(work, name), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 }, crowns: CROWNS }));
    return name;
}

function soupBounds(s: { positions: Float32Array | Float64Array | number[] }): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < s.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], s.positions[i + k]); max[k] = Math.max(max[k], s.positions[i + k]); }
    return { min, max };
}

/** The GLB with its JSON chunk replaced (padded with spaces, as glTF requires). */
function withJson(glb: Buffer, edit: (json: any) => void): Buffer {
    const { json, bin } = parseGlb(glb);
    edit(json);
    const text = Buffer.from(JSON.stringify(json));
    const jsonChunk = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
    const head = (length: number, type: string) => { const h = Buffer.alloc(8); h.writeUInt32LE(length, 0); h.write(type, 4, 'ascii'); return h; };
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'ascii');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + bin.length, 8);
    return Buffer.concat([header, head(jsonChunk.length, 'JSON'), jsonChunk, head(bin.length, 'BIN\0'), bin]);
}

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'trees-bounds-')));
    svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('trees layer bounds', () => {
    let planted: Awaited<ReturnType<TileVegetationService['plant']>>;
    let expanded: TriangleSoup;

    it('reads quantised, instanced trees at their real size, as the texture pass reads them', async () => {
        planted = await svc.plant({ crownsPath: writeCrowns('crowns.json'), triangleBudget: 16000, seed: 'abc' });
        const glb = fs.readFileSync(planted.treesGlb);
        const { json } = parseGlb(glb);
        expect(json.extensionsUsed).toEqual(expect.arrayContaining(['KHR_mesh_quantization', 'EXT_mesh_gpu_instancing']));
        expect(json.accessors.some((a: any) => a.componentType === 5122 && a.normalized === true && a.type === 'VEC3')).toBe(true);

        expanded = glbToTriangleSoup(glb, { colors: false })!;
        const reference = readTileTriangles(new Uint8Array(glb));
        expect(expanded.indices.length / 3).toBe(reference.positions.length / 9);
        const b = soupBounds(expanded), r = soupBounds(reference);
        for (let k = 0; k < 3; k++) {
            expect(b.min[k]).toBeCloseTo(r.min[k], 3);
            expect(b.max[k]).toBeCloseTo(r.max[k], 3);
        }
        // the crowns span x -4.5..20.5, z -22..7.5 and stand on y 0..0.4 up to 14 and 22 m
        expect(b.min[1]).toBeGreaterThan(-1);
        expect(b.max[1]).toBeGreaterThan(20);
        expect(b.max[1]).toBeLessThan(24);
        expect(b.min[0]).toBeGreaterThan(-8);
        expect(b.max[0]).toBeLessThan(24);
        expect(implausibleLayerBounds(b)).toBeUndefined();

        const world = glbWorldBounds(glb)!;
        for (let k = 0; k < 3; k++) {
            expect(world.min[k]).toBeLessThanOrEqual(b.min[k] + 1e-4);
            expect(world.max[k]).toBeGreaterThanOrEqual(b.max[k] - 1e-4);
            expect(world.max[k] - world.min[k]).toBeLessThan(b.max[k] - b.min[k] + 3);
        }

        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'trees_layer_bounds_top.png'), renderClayPng([{ positions: expanded.positions, indices: expanded.indices }], { kind: 'top', width: 640, height: 640 }));
        fs.writeFileSync(path.join(SHOTS, 'trees_layer_bounds_aerial.png'), renderClayPng([{ positions: expanded.positions, indices: expanded.indices }], { kind: 'aerial', width: 960, height: 640, bearingDeg: 30, elevationDeg: 25 }));
    }, 900_000);

    it('keeps the crown tops when instanced leaves are left out, and the placement sampler finds them at their real height', () => {
        const glb = fs.readFileSync(planted.treesGlb);
        const skipped = glbToTriangleSoup(glb, { colors: false, instances: 'skip' })!;
        expect(skipped.indices.length).toBeLessThan(expanded.indices.length);
        const s = soupBounds(skipped), e = soupBounds(expanded);
        expect(Math.abs(s.max[1] - e.max[1])).toBeLessThan(1.5);

        const sampler = SurfaceSampler.fromSoup(skipped);
        for (const c of CROWNS) {
            const top = sampler.heightAt(c.stem[0], c.stem[1]);
            expect(top, `crown ${c.id}`).toBeDefined();
            expect(top!).toBeGreaterThan(c.apex[1] - 6);
            expect(top!).toBeLessThan(c.apex[1] + 1.5);
        }
        expect(sampler.bounds.maxY).toBeLessThan(24);
    });

    it('refuses a cached trees entry whose bounds are impossible, rebuilds it and says why', async () => {
        // the cached GLB as the broken one read: every crown 883,679 m up
        const glb = fs.readFileSync(planted.treesGlb);
        fs.writeFileSync(planted.treesGlb, withJson(glb, json => {
            const root = json.nodes[json.scenes[json.scene ?? 0].nodes[0]];
            const t = root.translation ?? [0, 0, 0];
            root.translation = [t[0], t[1] + 883_679, t[2]];
        }));
        expect(implausibleLayerBounds(glbWorldBounds(fs.readFileSync(planted.treesGlb))!)).toContain('beyond the 9,000 m any real surface can be');

        const again = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 16000, seed: 'abc' });
        expect(again.cacheKey).toBe(planted.cacheKey);
        expect(again.cached).toBe(false);
        expect(again.rebuiltStaleCache).toMatch(/^the cached trees [0-9a-f]{8} were rebuilt because its vertices reach from .* to 883,\d{3} m in height/);
        expect(implausibleLayerBounds(glbWorldBounds(fs.readFileSync(again.treesGlb))!)).toBeUndefined();
        expect(fs.readFileSync(again.treesGlb).equals(glb)).toBe(true);

        // a sound entry is a plain hit
        const hit = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 16000, seed: 'abc' });
        expect(hit.cached).toBe(true);
        expect(hit.rebuiltStaleCache).toBeUndefined();
    }, 900_000);

    it('names bounds no staged place can have', () => {
        expect(implausibleLayerBounds({ min: [-30, -2, -30], max: [30, 45, 30] })).toBeUndefined();
        expect(implausibleLayerBounds({ min: [-30, -678_506, -30], max: [30, 883_679, 30] })).toContain('beyond the 9,000 m any real surface can be');
        expect(implausibleLayerBounds({ min: [-30, 0, -30], max: [30, NaN, 30] })).toContain('not finite');
        expect(implausibleLayerBounds({ min: [-64_524, 0, -30], max: [30, 40, 30] })).toContain('beyond the 50,000 m any staged place covers');
    });
});
