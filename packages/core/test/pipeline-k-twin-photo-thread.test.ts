/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The twin's texel passes on their own thread (pipeline-k/twin-photo-thread.ts): a roof deck with a tower and a setback, its
 * five photos painted with the tower's and a neighbour's cast shadow under one sun and embedded in the GLB, made into a
 * twin with the roof-shadow lift and harmonising (pipeline K), once on the photo thread and once on the calling thread.
 * 1. The same GLB byte for byte, and the same reports, with the roof-shadow lift applied and harmonising kept (both ran).
 * 2. On the thread the calling thread's event loop turns while the passes run; inline it does not.
 * 3. A call after close is refused, not left waiting.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { shadowMap, shadowedAt } from '../src/node/3d-engine/staged-location/pipeline-k/roof-shadow';
import { collect } from '../src/node/3d-engine/staged-location/pipeline-k/view-relight';
import { ensureNativeTwinBinary } from '../src/node/3d-engine/staged-location/pipeline-k/native/twin-texels-native';
import { TwinPhotoThreadError, twinPhotoPasses } from '../src/node/3d-engine/staged-location/pipeline-k/twin-photo-thread';
import { tileRefineTwin } from '../src/node/3d-engine/staged-location/tile-refine-twin';
import { linearToSrgb255 } from '../src/common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

interface Prim { pos: number[]; uv?: number[]; idx: number[]; image?: number }

/** A GLB of the primitives, each textured one drawing on its photo (embedded as a PNG) through a material of its own. */
function glbOf(prims: Prim[], photos: RgbaImage8[]): Uint8Array {
    const chunks: Uint8Array[] = [], views: any[] = [], accessors: any[] = [];
    let length = 0;
    const push = (b: Uint8Array) => { views.push({ buffer: 0, byteOffset: length, byteLength: b.length }); chunks.push(b); length += b.length; const pad = (4 - (length % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); length += pad; } return views.length - 1; };
    const add = (arr: Float32Array | Uint32Array, type: string, ct: number, count: number) => { accessors.push({ bufferView: push(new Uint8Array(arr.buffer)), componentType: ct, count, type }); return accessors.length - 1; };
    const meshes = prims.map(p => {
        const POSITION = add(new Float32Array(p.pos), 'VEC3', 5126, p.pos.length / 3);
        const TEXCOORD_0 = p.uv ? add(new Float32Array(p.uv), 'VEC2', 5126, p.uv.length / 2) : undefined;
        const indices = add(new Uint32Array(p.idx), 'SCALAR', 5125, p.idx.length);
        return { primitives: [{ attributes: { POSITION, ...(TEXCOORD_0 !== undefined ? { TEXCOORD_0 } : {}) }, indices, mode: 4, ...(p.image !== undefined ? { material: p.image } : {}) }] };
    });
    const images = photos.map(im => ({ bufferView: push(new Uint8Array(encodePng(im.width, im.height, Buffer.from(im.rgba), 4))), mimeType: 'image/png' }));
    const bin = new Uint8Array(length);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: meshes.map((_, k) => k) }], nodes: meshes.map((_, k) => ({ mesh: k })), meshes,
        materials: photos.map((_, k) => ({ pbrMetallicRoughness: { baseColorTexture: { index: k } } })), textures: photos.map((_, k) => ({ source: k })), images,
        accessors, bufferViews: views, buffers: [{ byteLength: bin.length }]
    };
    return new Uint8Array(assembleGlb(json as never, bin));
}

/** A closed box's four sides (untextured), in quads of about `stepM` (one quad a side when absent). */
function sides(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, stepM?: number): Prim {
    const c = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]], pos: number[] = [], idx: number[] = [];
    for (let k = 0; k < 4; k++) {
        const [ax, az] = c[k], [bx, bz] = c[(k + 1) % 4];
        const nu = stepM ? Math.ceil(Math.hypot(bx - ax, bz - az) / stepM) : 1, nv = stepM ? Math.ceil((y1 - y0) / stepM) : 1;
        for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
            const xa = ax + ((bx - ax) * i) / nu, za = az + ((bz - az) * i) / nu, xb = ax + ((bx - ax) * (i + 1)) / nu, zb = az + ((bz - az) * (i + 1)) / nu;
            const ya = y0 + ((y1 - y0) * j) / nv, yb = y0 + ((y1 - y0) * (j + 1)) / nv, b = pos.length / 3;
            pos.push(xa, ya, za, xb, ya, zb, xb, yb, zb, xa, yb, za);
            idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
        }
    }
    return { pos, idx };
}

/** A deterministic surface colour (linear) at a plan point, a photo exposed by `gain`: stripes and a little grain. */
function albedo(x: number, z: number, img: number, gain: number): [number, number, number] {
    const grain = ((Math.sin(x * 12.9898 + z * 78.233 + img * 3.1) * 43758.5453) % 1 + 1) % 1;
    const v = gain * (0.16 + 0.07 * Math.sin(x * 1.3) * Math.cos(z * 0.7) + 0.05 * grain);
    return [v, v * 0.93, v * 0.82];
}

/** The deck: its GLB (photos embedded, shadowed under az 60, el 40 by the tower and the neighbour) and the neighbour as context. */
function deck(): { glb: Uint8Array; context: { vertices: Float32Array; indices: Uint32Array } } {
    const tpm = 8, sun = { az: 60, el: 40 }, dark = [2.4, 2.3, 2.0];
    // the east half exposed 30% brighter than the west, so harmonising has a seam to level
    const rects = [
        { x0: 0, x1: 20, z0: 0, z1: 40, y: 20, gain: 1 }, { x0: 15, x1: 25, z0: 15, z1: 25, y: 60, gain: 1 }, { x0: 20, x1: 40, z0: 0, z1: 40, y: 20, gain: 1.3 },
        { x0: -15, x1: 0, z0: 0, z1: 40, y: 10, gain: 1 }, { x0: 9, x1: 13, z0: 2, z1: 6, y: 20, gain: 1 }
    ];
    const tops: Prim[] = rects.map((_, k) => ({ pos: [], uv: [], idx: [], image: k }));
    const quad = (img: number, x0: number, x1: number, z0: number, z1: number) => {
        const r = rects[img], p = tops[img], b = p.pos.length / 3, u = (x: number) => (x - r.x0) / (r.x1 - r.x0), v = (z: number) => (z - r.z0) / (r.z1 - r.z0);
        p.pos.push(x0, r.y, z0, x1, r.y, z0, x1, r.y, z1, x0, r.y, z1);
        p.uv!.push(u(x0), v(z0), u(x1), v(z0), u(x1), v(z1), u(x0), v(z1));
        p.idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    };
    for (let x = 0; x < 40; x++) for (let z = 0; z < 40; z++) {
        const mx = x + 0.5, mz = z + 0.5;
        quad(mx > 9 && mx < 13 && mz > 2 && mz < 6 ? 4 : mx < 20 ? 0 : 2, x, x + 1, z, z + 1);
    }
    for (let x = -15; x < 0; x++) for (let z = 0; z < 40; z++) quad(3, x, x + 1, z, z + 1);
    quad(1, 15, 25, 15, 25);
    const prims = [...tops, sides(0, 40, 0, 40, 0, 20), sides(15, 25, 15, 25, 20, 60), sides(-15, 0, 0, 40, 0, 10)];
    const box = sides(50, 60, -10, 50, 0, 45, 0.5);
    const context = { vertices: Float32Array.from(box.pos), indices: Uint32Array.from(box.idx) };
    // the shadows painted from the geometry (a GLB without photos is enough to cast them)
    const bare = parseGlbBytes(glbOf(prims, rects.map(() => ({ width: 1, height: 1, rgba: new Uint8Array(4) }))));
    const soup = collect(bare, bare.json);
    const m = shadowMap({ P: Float32Array.from([...soup.P, ...box.idx.flatMap(i => box.pos.slice(i * 3, i * 3 + 3))]), n: soup.n + box.idx.length / 3 }, sun.az, sun.el, 0.05);
    const photos = rects.map((r, k): RgbaImage8 => {
        const W = Math.round((r.x1 - r.x0) * tpm), H = Math.round((r.z1 - r.z0) * tpm), rgba = new Uint8Array(W * H * 4);
        for (let ty = 0; ty < H; ty++) for (let tx = 0; tx < W; tx++) {
            const x = r.x0 + ((tx + 0.5) / W) * (r.x1 - r.x0), z = r.z0 + ((ty + 0.5) / H) * (r.z1 - r.z0);
            const lin = albedo(x, z, k, r.gain), shaded = shadowedAt(m, x, r.y, z, 0.05), o = (ty * W + tx) * 4;
            for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(linearToSrgb255(shaded ? lin[c] / dark[c] : lin[c]));
            rgba[o + 3] = 255;
        }
        return { width: W, height: H, rgba };
    });
    return { glb: glbOf(prims, photos), context };
}

/** A report without its timings (wall clock differs from run to run). */
function untimed(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(untimed);
    if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'ms' && k !== 'phasesMs' && !k.endsWith('Ms')).map(([k, x]) => [k, untimed(x)]));
    return v;
}

describe("the twin's photo passes on their own thread", () => {
    let fixture: ReturnType<typeof deck>;
    beforeAll(async () => {
        await ensureNativeTwinBinary();
        fixture = deck();
    }, 300_000);
    afterEach(() => { delete process.env.SCRATCHBOX_K_TWIN_THREAD; });

    const twin = async (thread: boolean) => {
        process.env.SCRATCHBOX_K_TWIN_THREAD = thread ? '1' : '0';
        const steps: string[] = [];
        const t = await tileRefineTwin(fixture.glb, 'l2', { onStep: (s, state) => steps.push(`${s}:${state}`), harmonize: { groundY: 0 }, roofShadow: { context: fixture.context } });
        return { t, steps };
    };

    it('makes the same twin on the photo thread as on the calling thread, with the roof shadow lifted and the photos harmonised', async () => {
        const inline = await twin(false), threaded = await twin(true);
        expect(inline.t.roofShadow?.applied).toBe(true);
        expect(inline.t.harmonize?.kept).toBe(true);
        expect(Buffer.from(threaded.t.glb).equals(Buffer.from(inline.t.glb))).toBe(true);
        expect(untimed(threaded.t.roofShadow)).toEqual(untimed(inline.t.roofShadow));
        expect(untimed(threaded.t.roofShadowQa)).toEqual(untimed(inline.t.roofShadowQa));
        expect(untimed(threaded.t.harmonize)).toEqual(untimed(inline.t.harmonize));
        expect(threaded.t.provenance).toEqual(inline.t.provenance);
        expect(threaded.steps).toEqual(inline.steps);
        expect(threaded.steps).toEqual(['roofShadow:running', 'roofShadow:done', 'roofShadowQa:running', 'roofShadowQa:done', 'harmonize:running', 'harmonize:done']);
    }, 300_000);

    it("leaves the calling thread's event loop turning while the passes run on the thread, and not inline", async () => {
        for (const thread of [false, true]) {
            const g = parseGlbBytes(fixture.glb), passes = twinPhotoPasses(g, g.json, { thread });
            try {
                expect(passes.where).toBe(thread ? 'thread' : 'inline');
                const prepared = await passes.prepare({ delight: true, surfaces: true, upLift: 0 });
                expect(prepared.photos.length).toBe(5);
                const images = new Map(prepared.photos.map(p => [p.i, p.delit]));
                let turned = false;
                setImmediate(() => { turned = true; });
                const done = await passes.finish(images, prepared.surfaces, { harmonize: { groundY: 0 } });
                expect(done.report.harmonize?.kept).toBe(true);
                expect(turned).toBe(thread);
            } finally { passes.close(); }
        }
    }, 300_000);

    it('refuses a call after it is closed', async () => {
        const g = parseGlbBytes(fixture.glb), passes = twinPhotoPasses(g, g.json, { thread: true });
        passes.close();
        await expect(passes.prepare({ delight: true, surfaces: false, upLift: 0 })).rejects.toBeInstanceOf(TwinPhotoThreadError);
    });
});
