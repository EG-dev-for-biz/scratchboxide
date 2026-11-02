/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Sky visibility on the native BVH (scratchbox_bvh.hpp skyVisibility, scripts/sky_visibility.cpp, sky-visibility-service.ts),
 * which replaced pipeline K's TypeScript ray grid (sky-delight/1). A street canyon between two closed blocks: on the
 * canyon wall the native values match the old ray grid's (kept below as the reference), rise with height, the open side
 * and an empty scene see all the sky and a point inside a closed box sees none. Then the whole sky de-light on a textured
 * canyon wall photographed darker low down: it fits a positive slope on both halves of the photos and evens the wall out.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { runSkyVisibility } from '../src/node/3d-engine/sky-visibility-service';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { skyDelight, occluderMesh, SKY_DELIGHT_PARAMS } from '../src/node/3d-engine/staged-location/pipeline-k/sky-delight';
import { SRGB8_TO_LINEAR } from '../src/common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const REPO = path.resolve(__dirname, '../../..');
const BIN = path.join(REPO, 'build', '3d-native', 'sky_visibility_test');

/** Compiles scripts/sky_visibility.cpp to BIN unless it is newer than the CLI and every engine header. */
function buildDriver(): void {
    const include = path.join(REPO, 'packages/core/src/native/3d-engine/include');
    const source = path.join(REPO, 'scripts/sky_visibility.cpp');
    const newest = Math.max(...[source, ...fs.readdirSync(include).map(f => path.join(include, f))].map(f => fs.statSync(f).mtimeMs));
    if (fs.existsSync(BIN) && fs.statSync(BIN).mtimeMs >= newest) return;
    fs.mkdirSync(path.dirname(BIN), { recursive: true });
    execFileSync(process.env.CXX || 'clang++', ['-std=c++20', '-O2', '-pthread', '-I', include, source, '-o', BIN], { stdio: 'pipe', timeout: 600_000 });
}

// ---- the ray grid sky-delight.ts cast on before the port (sky-delight/1), the parity reference -------------------------
function referenceRayGrid(T: Float64Array, cellM: number) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < T.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], T[i + k]); hi[k] = Math.max(hi[k], T[i + k]); }
    const N = [0, 1, 2].map(k => Math.max(1, Math.ceil((hi[k] - lo[k]) / cellM) + 1));
    const key = (x: number, y: number, z: number) => (x * N[1] + y) * N[2] + z;
    const cells = new Map<number, number[]>();
    for (let t = 0; t < T.length / 9; t++) {
        const b0 = [0, 1, 2].map(k => Math.floor((Math.min(T[t * 9 + k], T[t * 9 + 3 + k], T[t * 9 + 6 + k]) - lo[k]) / cellM));
        const b1 = [0, 1, 2].map(k => Math.floor((Math.max(T[t * 9 + k], T[t * 9 + 3 + k], T[t * 9 + 6 + k]) - lo[k]) / cellM));
        for (let x = b0[0]; x <= b1[0]; x++) for (let y = b0[1]; y <= b1[1]; y++) for (let z = b0[2]; z <= b1[2]; z++) {
            const c = key(x, y, z), l = cells.get(c);
            if (l) l.push(t); else cells.set(c, [t]);
        }
    }
    const stamp = new Uint32Array(T.length / 9);
    let ray = 0;
    return (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): boolean => {
        ray++;
        for (let s = 0; s < maxT; s += cellM * 0.5) {
            const cx = Math.floor((ox + dx * s - lo[0]) / cellM), cy = Math.floor((oy + dy * s - lo[1]) / cellM), cz = Math.floor((oz + dz * s - lo[2]) / cellM);
            if (cx < 0 || cy < 0 || cz < 0 || cx >= N[0] || cy >= N[1] || cz >= N[2]) return false;
            const l = cells.get(key(cx, cy, cz));
            if (!l) continue;
            for (const t of l) {
                if (stamp[t] === ray) continue;
                stamp[t] = ray;
                const a = t * 9;
                const e1x = T[a + 3] - T[a], e1y = T[a + 4] - T[a + 1], e1z = T[a + 5] - T[a + 2], e2x = T[a + 6] - T[a], e2y = T[a + 7] - T[a + 1], e2z = T[a + 8] - T[a + 2];
                const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
                const det = e1x * px + e1y * py + e1z * pz;
                if (Math.abs(det) < 1e-12) continue;
                const inv = 1 / det, tx = ox - T[a], ty = oy - T[a + 1], tz = oz - T[a + 2];
                const u = (tx * px + ty * py + tz * pz) * inv;
                if (u < 0 || u > 1) continue;
                const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
                const v = (dx * qx + dy * qy + dz * qz) * inv;
                if (v < 0 || u + v > 1) continue;
                if ((e2x * qx + e2y * qy + e2z * qz) * inv > 0.05) return true;
            }
        }
        return false;
    };
}
function referenceSkyVisibility(hit: ReturnType<typeof referenceRayGrid>, c: number[], n: number[], rays: number, maxRayM: number): number {
    const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = n[1] * a[2] - n[2] * a[1], uy = n[2] * a[0] - n[0] * a[2], uz = n[0] * a[1] - n[1] * a[0];
    const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
    const wx = n[1] * uz - n[2] * uy, wy = n[2] * ux - n[0] * uz, wz = n[0] * uy - n[1] * ux;
    const ox = c[0] + n[0] * 0.05, oy = c[1] + n[1] * 0.05, oz = c[2] + n[2] * 0.05;
    let open = 0, counted = 0;
    for (let k = 0; k < rays; k++) {
        const r = (k + 0.5) / rays, ph = k * 2.39996323, sr = Math.sqrt(r), z = Math.sqrt(1 - r);
        const dx = ux * sr * Math.cos(ph) + wx * sr * Math.sin(ph) + n[0] * z, dy = uy * sr * Math.cos(ph) + wy * sr * Math.sin(ph) + n[1] * z, dz = uz * sr * Math.cos(ph) + wz * sr * Math.sin(ph) + n[2] * z;
        if (dy < -0.02) continue;
        counted++;
        if (!hit(ox, oy, oz, dx, dy, dz, maxRayM)) open++;
    }
    return counted ? open / counted : 0;
}

// ---- scenes ---------------------------------------------------------------------------------------------------------------
interface Soup { positions: number[]; indices: number[] }
/** A quad a, b, c, d (counter-clockwise seen from the side it faces) split into nu x nv cells. */
function quad(s: Soup, a: number[], b: number[], d: number[], nu = 1, nv = 1): void {
    const v0 = s.positions.length / 3;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) for (let k = 0; k < 3; k++) s.positions.push(a[k] + (b[k] - a[k]) * i / nu + (d[k] - a[k]) * j / nv);
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const p = v0 + j * (nu + 1) + i;
        s.indices.push(p, p + 1, p + nu + 2, p, p + nu + 2, p + nu + 1);
    }
}
/** A closed axis-aligned box. */
function box(s: Soup, lo: number[], hi: number[]): void {
    const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
    quad(s, [x0, y0, z1], [x1, y0, z1], [x0, y1, z1], 8, 4); quad(s, [x1, y0, z0], [x0, y0, z0], [x1, y1, z0], 8, 4);
    quad(s, [x0, y0, z0], [x0, y0, z1], [x0, y1, z0], 4, 4); quad(s, [x1, y0, z1], [x1, y0, z0], [x1, y1, z1], 4, 4);
    quad(s, [x0, y1, z1], [x1, y1, z1], [x0, y1, z0], 8, 4); quad(s, [x0, y0, z0], [x1, y0, z0], [x0, y0, z1], 8, 4);
}
/** A 20 m street canyon along x between two 60 m blocks (z -40..-10 and 10..40), on a ground plane. */
function canyon(): Soup {
    const s: Soup = { positions: [], indices: [] };
    quad(s, [-150, 0, 150], [150, 0, 150], [-150, 0, -150], 6, 6);
    box(s, [-100, 0, -40], [100, 60, -10]);
    box(s, [-100, 0, 10], [100, 60, 40]);
    return s;
}
const soupTriangles = (s: Soup) => Float64Array.from(s.indices.flatMap(i => [s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2]]));

describe('sky visibility on the native BVH', () => {
    beforeAll(() => {
        buildDriver();
        process.env.SCRATCHBOX_SKY_VISIBILITY_BIN = BIN;
    }, 600_000);

    it('matches the old ray grid on a street canyon wall, rising with height; the open side sees the sky', async () => {
        const s = canyon();
        const heights = Array.from({ length: 30 }, (_, k) => 1 + 2 * k);
        const inner = heights.map(h => [0, h, -10, 0, 0, 1]), outer = heights.map(h => [0, h, -40, 0, 0, -1]);
        const { visibility } = await runSkyVisibility({ positions: Float32Array.from(s.positions), indices: Uint32Array.from(s.indices), samples: Float32Array.from([...inner, ...outer].flat()), rays: 48, maxRayM: 300 });
        const grid = referenceRayGrid(soupTriangles(s), 2);
        const reference = [...inner, ...outer].map(r => referenceSkyVisibility(grid, r.slice(0, 3), r.slice(3), 48, 300));
        // every ray decides the same: the values differ only by float32 rounding
        const diffs = reference.map((v, i) => Math.abs(v - visibility[i]));
        expect(Math.max(...diffs)).toBeLessThan(1e-6);
        const canyonV = Array.from(visibility.slice(0, heights.length));
        for (let k = 1; k < canyonV.length; k++) expect(canyonV[k]).toBeGreaterThanOrEqual(canyonV[k - 1]);
        expect(canyonV[0]).toBeLessThan(0.2);
        expect(canyonV[canyonV.length - 1]).toBeGreaterThan(0.4);
        for (const v of visibility.slice(heights.length)) expect(v).toBeGreaterThan(0.95);
    });

    it('sees all the sky with no occluders and none from inside a closed box', async () => {
        const empty = await runSkyVisibility({ positions: new Float32Array(0), indices: new Uint32Array(0), samples: Float32Array.from([0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0]) });
        expect(Array.from(empty.visibility)).toEqual([1, 1]);
        const s: Soup = { positions: [], indices: [] };
        box(s, [-5, 0, -5], [5, 10, 5]);
        const inside = await runSkyVisibility({ positions: Float32Array.from(s.positions), indices: Uint32Array.from(s.indices), samples: Float32Array.from([0, 5, 0, 1, 0, 0, 0, 5, 0, 0, 1, 0]) });
        expect(Array.from(inside.visibility)).toEqual([0, 0]);
    });

    it('refuses malformed input before running anything', async () => {
        await expect(runSkyVisibility({ positions: new Float32Array(3), indices: Uint32Array.from([0, 1, 2]), samples: new Float32Array(6) })).rejects.toThrow(/past the 1 vertices/);
        await expect(runSkyVisibility({ positions: new Float32Array(9), indices: Uint32Array.from([0, 1, 2]), samples: new Float32Array(5) })).rejects.toThrow(/a point and a normal/);
    });

    it('de-lights a canyon wall photographed darker low down', async () => {
        // the occluders untextured; the canyon face of the south block (z = -10, x -10..10) textured, four photos by column
        const occ = canyon();
        const cols = 10, rows = 30, W = 32, H = 64;
        const wall = { positions: [] as number[], uvs: [] as number[], indices: [] as number[][] };
        for (let c = 0; c < cols; c++) {
            const photo = c % 4, x0 = -10 + 2 * c, idx: number[] = [];
            for (let r = 0; r < rows; r++) {
                const v0 = wall.positions.length / 3, y0 = 2 * r;
                wall.positions.push(x0, y0, -10, x0 + 2, y0, -10, x0 + 2, y0 + 2, -10, x0, y0 + 2, -10);
                // each column fills its photo's width; the photo's rows run down the wall
                wall.uvs.push(0.05, 1 - y0 / 60, 0.95, 1 - y0 / 60, 0.95, 1 - (y0 + 2) / 60, 0.05, 1 - (y0 + 2) / 60);
                idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
            }
            while (wall.indices.length <= photo) wall.indices.push([]);
            wall.indices[photo].push(...idx);
        }
        const parts: Array<Float32Array | Uint32Array> = [Float32Array.from(occ.positions), Uint32Array.from(occ.indices), Float32Array.from(wall.positions), Float32Array.from(wall.uvs), ...wall.indices.map(i => Uint32Array.from(i))];
        const bytes: number[] = [], views: any[] = [];
        for (const p of parts) { const b = new Uint8Array(p.buffer); views.push({ buffer: 0, byteOffset: bytes.length, byteLength: b.length }); bytes.push(...b); }
        const acc = (bv: number, count: number, type: string, ct: number) => ({ bufferView: bv, componentType: ct, count, type });
        const json = {
            asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }], nodes: [{ mesh: 0 }, { mesh: 1 }],
            meshes: [
                { primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] },
                { primitives: wall.indices.map((_, k) => ({ attributes: { POSITION: 2, TEXCOORD_0: 3 }, indices: 4 + k, material: k, mode: 4 })) }
            ],
            materials: wall.indices.map((_, k) => ({ pbrMetallicRoughness: { baseColorTexture: { index: k } } })),
            textures: wall.indices.map((_, k) => ({ source: k })), images: wall.indices.map((_, k) => ({ uri: `p${k}.png` })),
            accessors: [acc(0, occ.positions.length / 3, 'VEC3', 5126), acc(1, occ.indices.length, 'SCALAR', 5125), acc(2, wall.positions.length / 3, 'VEC3', 5126), acc(3, wall.uvs.length / 2, 'VEC2', 5126), ...wall.indices.map((i, k) => acc(4 + k, i.length, 'SCALAR', 5125))],
            bufferViews: views, buffers: [{ byteLength: bytes.length }]
        };
        const g = parseGlbBytes(assembleGlb(json as never, Uint8Array.from(bytes)));
        // stone photographed 2.5 times darker at the street than at the top
        const photo = (): RgbaImage8 => {
            const rgba = new Uint8Array(W * H * 4);
            for (let y = 0; y < H; y++) { const v = Math.round(70 + 110 * (1 - y / (H - 1))); for (let x = 0; x < W; x++) rgba.set([v, v, v, 255], (y * W + x) * 4); }
            return { width: W, height: H, rgba };
        };
        const images = new Map(wall.indices.map((_, k) => [k, photo()] as [number, RgbaImage8]));
        // a photo's row 0 is the top of the wall: its luminance there over its luminance at the street
        const luma = (im: RgbaImage8, y: number) => SRGB8_TO_LINEAR[im.rgba[(y * W + W / 2) * 4]];
        const topOverStreet = (im: RgbaImage8) => luma(im, 2) / luma(im, H - 3);
        const before = topOverStreet(images.get(0)!);

        // the occluder mesh holds the GLB's every triangle
        expect(occluderMesh(g, g.json).indices.length).toBe(occ.indices.length + wall.indices.flat().length);
        const r = await skyDelight(g, g.json, images, undefined, undefined, SKY_DELIGHT_PARAMS);
        expect(r.applied).toBe(true);
        expect(r.samples).toBe(cols * rows * 2);
        expect(r.b).toBeGreaterThan(0);
        expect(r.bHalves[0]).toBeGreaterThan(0);
        expect(r.bHalves[1]).toBeGreaterThan(0);
        expect(r.heldOutVarianceRemoved).toBeGreaterThan(0.3);
        expect(r.texels).toBeGreaterThan(0);
        // evened out, not inverted: the street still the darker end (the darkening is not all sky)
        const after = topOverStreet(images.get(0)!);
        expect(after).toBeLessThan(before);
        expect(after).toBeGreaterThan(1);
    }, 120_000);
});
