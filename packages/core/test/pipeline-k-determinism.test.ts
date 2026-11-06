/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K builds the same model from the same scan and the same model answers (docs/processes/k_determinism.md).
 * Two ESB builds with their vision and image answers replayed came out byte for byte the same; two live builds differed
 * only where an answer did. These tests hold what made the live builds differ:
 * - the lattice's lines are read from the photo, never from the hole fill (an image model's inpaint, different each time);
 * - the lattice rebuild, run twice on a synthetic scan, gives the same bytes;
 * - the hole inpaint and the ownership outlines are kept in the model readings store, so a second build with an empty
 *   stage cache takes the same answers (and the ownership vote's 30 s cut never drops a view answered before);
 * - the polish's key ignores the timings its JSON inputs record.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { facadeSamples, latticeFacade, photoLattice, type ReliefFacade } from '../src/node/3d-engine/staged-location/facade-lattice';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodePng } from '../src/node/texture-processing';
import { rectifyReliefOrthos } from '../src/node/3d-engine/staged-location/pipeline-k/pipeline-k';
import type { ModelReadingStore } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import type { EnhanceModelClient } from '../src/node/3d-engine/staged-location/texture-enhance';
import { segmentOwnershipViews } from '../src/node/3d-engine/staged-location/ownership-masks';
import { contentHash } from '../src/node/3d-engine/staged-location/remesh-polish';
import { VisionHedgeBook, VisionModelChain, type VisionGenAIClient } from '../src/node/gemini/vision-model-chain';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-k-determinism-')));

/** The model readings store in memory, counting what it answered and kept. */
function memoryStore(): ModelReadingStore & { hits: number; puts: number; size: () => number } {
    const m = new Map<string, unknown>();
    const s = { hits: 0, puts: 0, size: () => m.size, get: <T>(k: string) => { const v = m.get(k) as T | undefined; if (v !== undefined) s.hits++; return v; }, put: (k: string, v: unknown) => { s.puts++; m.set(k, JSON.parse(JSON.stringify(v))); } };
    return s;
}

/** A seeded generator (an image model that draws differently every time it is asked: another seed). */
function rng(seed: number): () => number { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

// ------------------------------------------------------------------------------------------------------------------
// the lattice: a 12 x 9 m facade, windows 1.2 m wide every 3 m on three storeys, its scan recessed in the windows
// ------------------------------------------------------------------------------------------------------------------
const PX = 0.1, W = 120, H = 90;
const F: ReliefFacade = { facadeId: 7, image: 'f.png', centroid: [0, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: 0, sMax: 12, tMin: 0, tMax: 9, pixel: PX, width: W, height: H, orthoSMin: 0, orthoTMax: 9, coverage: 1 };
const isWindow = (s: number, t: number) => { const ss = s % 3, tt = t % 3; return ss > 0.9 && ss < 2.1 && tt > 0.7 && tt < 2.3; };

/** The photo; texels under `hole` are what a fill drew there (`fill` gives each one's grey). */
function photo(hole?: Uint8Array, fill?: () => number): { rgba: Uint8Array; width: number; height: number } {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x, s = (x + 0.5) * PX, t = 9 - (y + 0.5) * PX;
        const v = hole?.[k] && fill ? Math.round(fill() * 255) : isWindow(s, t) ? 40 : 200;
        rgba.set([v, v, v, 255], k * 4);
    }
    return { rgba, width: W, height: H };
}

function scan(): Float32Array {
    const out: number[] = [];
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.12;
    const z = (s: number, t: number) => (isWindow(s, t) ? -0.3 : 0) + rnd();
    for (let s = 0; s < 12; s += 0.25) for (let t = 0; t < 9; t += 0.25) {
        const a = [s, t, z(s, t)], b = [s + 0.25, t, z(s + 0.25, t)], c = [s + 0.25, t + 0.25, z(s + 0.25, t + 0.25)], d = [s, t + 0.25, z(s, t + 0.25)];
        out.push(...a, ...b, ...c, ...a, ...c, ...d);
    }
    return Float32Array.from(out);
}

describe('pipeline K is repeatable: the lattice', () => {
    // the photo never reached a block of wall and window (s 6.3..9.6, t 2..6.5): its texels are the hole fill's
    const hole = new Uint8Array(W * H);
    for (let y = 25; y < 70; y++) for (let x = 63; x < 96; x++) hole[y * W + x] = 1;

    it("reads its lines from the photo alone: two fills of the photo's holes give the same lines and the same rebuild", () => {
        const a = photo(hole, rng(1)), b = photo(hole, rng(2));
        expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(false);
        // the fills differ texel by texel (noise draws edges everywhere); read as the uncovered grey, they draw no line
        expect(photoLattice(a, F, undefined, hole)).toEqual(photoLattice(b, F, undefined, hole));
        const samples = facadeSamples(scan(), F);
        const ra = latticeFacade(F, a, samples, undefined, hole, true)!, rb = latticeFacade(F, b, samples, undefined, hole, true)!;
        expect(ra.s).toEqual(rb.s);
        expect(ra.t).toEqual(rb.t);
        expect(Buffer.from(ra.positions.buffer).equals(Buffer.from(rb.positions.buffer))).toBe(true);
        expect(Array.from(ra.indices)).toEqual(Array.from(rb.indices));
        // the photo's own edge against the hole is still a line: the window's right edge at s 5.1 stands beside the hole
        expect(ra.s.some(v => Math.abs(v - 5.1) <= 0.15)).toBe(true);
        // without the mask the fills' noise drew lines of its own, and the two rebuilds differed
        expect(photoLattice(a, F)).not.toEqual(photoLattice(b, F));
    });

    it('rebuilds the same facade twice to the same bytes', () => {
        const samples = facadeSamples(scan(), F);
        const runs = [0, 1].map(() => latticeFacade(F, photo(hole, rng(5)), samples, undefined, hole, true, [[3.9, 3.7, 5.1, 5.3], [0.9, 0.7, 2.1, 2.3]])!);
        expect(runs[0].cells).toBeGreaterThan(0);
        expect(Buffer.from(runs[0].positions.buffer).equals(Buffer.from(runs[1].positions.buffer))).toBe(true);
        expect(Buffer.from(runs[0].uv.buffer).equals(Buffer.from(runs[1].uv.buffer))).toBe(true);
        expect(Array.from(runs[0].indices)).toEqual(Array.from(runs[1].indices));
        expect(Array.from(runs[0].built)).toEqual(Array.from(runs[1].built));
    });
});

// ------------------------------------------------------------------------------------------------------------------
// the hole inpaint: a plain wall (no repeats to fill from) with small holes only the image model reaches
// ------------------------------------------------------------------------------------------------------------------
const RW = 160, RH = 200, RPX = 0.075;

/** An image model that paints each crop's holes with its own noise (a seeded picture, different for every seed). */
function noisyInpainter(seed: number): EnhanceModelClient & { calls: number } {
    const r = rng(seed);
    const client = (async req => {
        client.calls++;
        const img = decodePng(Buffer.from(req.image.bytes));
        const out = new Uint8Array(img.width * img.height * 4);
        // the holes come magenta: each takes the colour above it, give or take the model's own few levels
        const hole = (i: number) => img.rgba[i * 4] > 240 && img.rgba[i * 4 + 1] < 15 && img.rgba[i * 4 + 2] > 240;
        for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
            const i = y * img.width + x, j = hole(i) && y > 0 ? i - img.width : i, d = hole(i) ? Math.round((r() - 0.5) * 6) : 0;
            for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, (hole(i) ? out[j * 4 + c] : img.rgba[i * 4 + c]) + d));
            out[i * 4 + 3] = 255;
        }
        return { bytes: encodePng(img.width, img.height, out, 4), mimeType: 'image/png', modelUsed: 'test-inpaint', requestedModels: req.models, skippedModels: [], modelNote: 'test' };
    }) as EnhanceModelClient & { calls: number };
    client.calls = 0;
    return client;
}

function wallOrthos(dir: string): string {
    const src = path.join(dir, 'relief_orthos');
    fs.mkdirSync(src, { recursive: true });
    const rgba = new Uint8Array(RW * RH * 4);
    // a stain spreading over plain render: no repeat to fill from, and no other patch of the wall looks like a hole's ring
    for (let y = 0; y < RH; y++) for (let x = 0; x < RW; x++) { const v = 60 + Math.round(((x - 70) ** 2 + (y - 90) ** 2) / 90); rgba.set([v + 4, v, v - 6, 255], (y * RW + x) * 4); }
    // a band the photo never reached across the whole wall (nothing along the wall to continue it from), the uncovered grey
    for (let y = 100; y < 104; y++) for (let x = 0; x < RW; x++) rgba.set([128, 128, 128, 255], (y * RW + x) * 4);
    fs.writeFileSync(path.join(src, 'facade_0.png'), encodePng(RW, RH, rgba, 4));
    const base = { centroid: [0, 0, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], sMin: 0, sMax: RW * RPX, tMin: 0, tMax: RH * RPX, pixel: RPX, width: RW, height: RH, orthoSMin: 0, orthoTMax: RH * RPX };
    fs.writeFileSync(path.join(src, 'facades.json'), JSON.stringify({ schema: 'test', facades: [{ ...base, facadeId: 0, image: 'facade_0.png', coverage: 0.98 }] }));
    return src;
}

describe('pipeline K is repeatable: the answers that shape it are kept', () => {
    it('takes the same hole fill from the readings store in a build whose stage cache is empty', async () => {
        const store = memoryStore();
        const first = noisyInpainter(1), second = noisyInpainter(2), third = noisyInpainter(3);
        const run = async (name: string, client: EnhanceModelClient, readings?: ModelReadingStore) => {
            const r = await rectifyReliefOrthos(wallOrthos(path.join(TMP, name)), { threads: 1, inlineTail: true, inpaint: { client, models: ['test-inpaint'], ...(readings ? { readings } : {}) } });
            return { r, png: fs.readFileSync(path.join(r.orthosDir, 'facade_0.png')) };
        };
        const a = await run('inpaint-a', first, store);
        expect(first.calls).toBeGreaterThan(0);
        expect(a.r.reports[0].report?.holes.fromInpaint).toBeGreaterThan(0);
        expect(store.puts).toBe(1);
        // a second build, its stage cache empty (another folder): the model is not asked, the photo is the same bytes
        const b = await run('inpaint-b', second, store);
        expect(second.calls).toBe(0);
        expect(store.hits).toBe(1);
        expect(b.png.equals(a.png)).toBe(true);
        expect(b.r.reports[0].report?.holes).toEqual(a.r.reports[0].report?.holes);
        // without the store the model is asked again and draws another fill: the build would differ
        const c = await run('inpaint-c', third);
        expect(third.calls).toBeGreaterThan(0);
        expect(c.png.equals(a.png)).toBe(false);
    }, 60_000);

    it("takes each view's kept outline: the same masks, and no view dropped by the vote's cut", async () => {
        const dir = fs.mkdtempSync(path.join(TMP, 'views-'));
        const lines: string[] = [];
        for (let i = 0; i < 6; i++) {
            fs.writeFileSync(path.join(dir, `v${i}.png`), encodePng(16, 16, new Uint8Array(16 * 16 * 3).fill(20 + i), 3));
            lines.push(`v${i} 16 16`);
        }
        fs.writeFileSync(path.join(dir, 'views.txt'), lines.join('\n') + '\n');
        // the model outlines a little differently each time it is asked (a corner moves by the call's count)
        let asked = 0;
        const client: VisionGenAIClient = { models: { generateContent: async () => { asked++; const c = 100 + asked * 7; return { candidates: [{ content: { parts: [{ text: JSON.stringify({ visible: true, polygons: [{ outer: [[c, 100], [c, 900], [900, 900], [900, 100]], holes: [] }] }) }] }, finishReason: 'STOP' }] } as never; } } };
        const store = memoryStore();
        const vote = (masksDir: string, rule: { afterMs: number; share: number } | false, readings?: ModelReadingStore) => segmentOwnershipViews({ viewsDir: dir, masksDir, target: 'the building', chain: new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'], hedgeBook: new VisionHedgeBook() }), concurrency: 3, vote: rule, ...(readings ? { readings } : {}) });
        const masks = (d: string) => fs.readdirSync(d).filter(f => f.endsWith('.mask.png')).sort().map(f => fs.readFileSync(path.join(d, f)));
        const a = await vote(path.join(dir, 'a'), false, store);
        expect(a.masks).toBe(6);
        expect(store.size()).toBe(a.masks);
        const askedBefore = asked;
        // the cut fires at once (afterMs 0) once half have outlines: every kept view still votes, none is asked again
        const b = await vote(path.join(dir, 'b'), { afterMs: 0, share: 0.5 }, store);
        expect(asked).toBe(askedBefore);
        expect(b.masks).toBe(a.masks);
        expect(b.cut).toBeUndefined();
        expect(masks(path.join(dir, 'b'))).toEqual(masks(path.join(dir, 'a')));
        // asked again with no store, the outlines differ
        await vote(path.join(dir, 'c'), false);
        expect(masks(path.join(dir, 'c'))).not.toEqual(masks(path.join(dir, 'a')));
    });

    it("keys the polish by its inputs' content, not by how long they took", () => {
        const a = path.join(TMP, 'fit-a.json'), b = path.join(TMP, 'fit-b.json'), c = path.join(TMP, 'fit-c.json');
        fs.writeFileSync(a, JSON.stringify({ facades: [{ facadeId: 1, rects: [[0, 0, 1, 1]], ms: 812 }], stagesMs: { fit: 3 } }));
        fs.writeFileSync(b, JSON.stringify({ facades: [{ facadeId: 1, rects: [[0, 0, 1, 1]], ms: 95 }], stagesMs: { fit: 40 } }));
        fs.writeFileSync(c, JSON.stringify({ facades: [{ facadeId: 1, rects: [[0, 0, 1, 2]], ms: 95 }] }));
        expect(contentHash(a)).toBe(contentHash(b));
        expect(contentHash(c)).not.toBe(contentHash(a));
    });
});
