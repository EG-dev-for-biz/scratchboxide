/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's facade upscale (pipeline-k/facade-upscale.ts). The detail transfer on synthetic photos: a faithful answer's
 * fine detail is kept and the photo survives it texel for texel when shrunk back; a block the answer invented over a
 * plain patch (a sign drawn into a blur) is dropped; detail stronger than the photo's own contrast is capped. Then a twin
 * with one rebuilt facade (FacadeLattice_3, a 64 x 48 photo with a window grid) and a fake image client (no model is
 * reached) that answers each tile with its nearest-neighbour enlargement plus a fine checker: the facade's texture comes
 * back 4x, labelled generated, and a second run reads every tile back from the store with no call.
 */

import { describe, expect, it } from 'vitest';
import { BUILD_STEPS, TOGGLEABLE_STEPS } from '../src/common/staged-build-steps';
import { FACADE_UPSCALE_DISTRICT_PARAMS, FACADE_UPSCALE_EXTRA_MS, FACADE_UPSCALE_PARAMS, facadeIdentityKey, facadeUpscaleAsked, facadeUpscaleProvenance, tileStarts, transferDetail, upscaleFacadeTextures, upscaleFactor } from '../src/node/3d-engine/staged-location/pipeline-k/facade-upscale';
import { memoryReadingStore } from '../src/node/3d-engine/staged-location/pipeline-k/model-readings';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodeImageInMemory, type RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { resolveToolTimeBudget } from '../src/node/gemini/tool-time-budgets';
import { finalImagePart } from '../src/node/google-media-generation-service';
import type { EnhanceModelRequest } from '../src/node/3d-engine/staged-location/texture-enhance';

/** A facade photo: stone (190, 170, 150) with dark windows (60, 70, 80) on a 8 x 6 px grid. */
function facadePhoto(w: number, h: number): RgbaImage8 {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const win = x % 8 >= 2 && x % 8 < 6 && y % 6 >= 1 && y % 6 < 5;
        rgba.set(win ? [60, 70, 80, 255] : [190, 170, 150, 255], (y * w + x) * 4);
    }
    return { width: w, height: h, rgba };
}

/** The photo enlarged F x (nearest) with a +/- amp checker of one output texel: fine detail whose box average is zero. */
function enlargeWithChecker(img: RgbaImage8, F: number, amp: number): RgbaImage8 {
    const W = img.width * F, H = img.height * F, rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = (Math.floor(y / F) * img.width + Math.floor(x / F)) * 4, d = (x + y) % 2 ? amp : -amp;
        for (let c = 0; c < 3; c++) rgba[(y * W + x) * 4 + c] = Math.max(0, Math.min(255, img.rgba[s + c] + d));
        rgba[(y * W + x) * 4 + 3] = 255;
    }
    return { width: W, height: H, rgba };
}

/** The image box-averaged F x F back down. */
function shrink(img: RgbaImage8, F: number): RgbaImage8 {
    const W = img.width / F, H = img.height / F, rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let dy = 0; dy < F; dy++) for (let dx = 0; dx < F; dx++) s += img.rgba[((y * F + dy) * img.width + x * F + dx) * 4 + c];
        rgba[(y * W + x) * 4 + c] = Math.round(s / (F * F));
    }
    return { width: W, height: H, rgba };
}

/** A twin with one rebuilt facade: a 10 x 6 m quad at y 0..6, textured with `png`. */
function twin(png: Uint8Array): Buffer {
    const json: any = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [], meshes: [], accessors: [], bufferViews: [], buffers: [{}], materials: [], textures: [], images: [], samplers: [{}] };
    const chunks: Uint8Array[] = [];
    let len = 0;
    const view = (b: Uint8Array, target?: number) => { const pad = (4 - (len % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); len += pad; } json.bufferViews.push({ buffer: 0, byteOffset: len, byteLength: b.byteLength, ...(target ? { target } : {}) }); chunks.push(b); len += b.byteLength; return json.bufferViews.length - 1; };
    const f32 = (a: number[]) => new Uint8Array(Float32Array.from(a).buffer), u32 = (a: number[]) => new Uint8Array(Uint32Array.from(a).buffer);
    json.accessors.push({ bufferView: view(f32([0, 0, 0, 10, 0, 0, 10, 6, 0, 0, 6, 0]), 34962), componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [10, 6, 0] });
    json.accessors.push({ bufferView: view(f32([0, 1, 1, 1, 1, 0, 0, 0]), 34962), componentType: 5126, count: 4, type: 'VEC2' });
    json.accessors.push({ bufferView: view(u32([0, 1, 2, 0, 2, 3]), 34963), componentType: 5125, count: 6, type: 'SCALAR' });
    json.images.push({ bufferView: view(png), mimeType: 'image/png' });
    json.textures.push({ source: 0, sampler: 0 });
    json.materials.push({ name: 'FacadeLattice_3', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } });
    json.meshes.push({ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: 0, mode: 4 }] });
    json.nodes.push({ name: 'FacadeLattice_3', mesh: 0, extras: { sbFacadeLattice: { facadeId: 3, provenance: { texture: 'tile photo' } } } });
    const bin = new Uint8Array(len);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    json.buffers = [{ byteLength: len }];
    return assembleGlb(json, bin);
}

describe('facade upscale: tiles and factor', () => {
    it('tiles a side with the last tile flush, and picks the largest factor within the limits', () => {
        expect(tileStarts(500, 1024, 48)).toEqual([0]);
        expect(tileStarts(2000, 1024, 48)).toEqual([0, 976]);
        const s = tileStarts(3000, 1024, 48);
        expect(s[0]).toBe(0);
        expect(s[s.length - 1]).toBe(3000 - 1024);
        for (let i = 1; i < s.length; i++) expect(s[i] - s[i - 1]).toBeLessThanOrEqual(1024 - 48);
        expect(upscaleFactor(400, 600)).toBe(4);
        expect(upscaleFactor(1500, 2500)).toBe(2); // 4x and 3x pass 4096^2 texels
        expect(upscaleFactor(3000, 5000)).toBe(0);
    });
});

describe('the image model reply', () => {
    it("takes the answer, not Gemini 3 Pro Image's draft thought images before it", () => {
        const parts = [{ text: 'thinking' }, { inlineData: { data: 'draft1', mimeType: 'image/png' }, thought: true }, { inlineData: { data: 'draft2', mimeType: 'image/png' }, thought: true }, { inlineData: { data: 'final', mimeType: 'image/png' } }];
        expect(finalImagePart(parts)?.inlineData?.data).toBe('final');
        expect(finalImagePart([{ inlineData: { data: 'only', mimeType: 'image/png' }, thought: true }])?.inlineData?.data).toBe('only');
        expect(finalImagePart([{ text: 'no image' }])).toBeUndefined();
    });
});

describe('facade upscale: detail transfer', () => {
    const photo = facadePhoto(32, 24);

    it("keeps a faithful answer's fine detail, and the result shrunk back is the photo", () => {
        const ai = enlargeWithChecker(photo, 4, 4);
        const t = transferDetail(photo, ai, 4);
        expect(t.image.width).toBe(128);
        expect(t.image.height).toBe(96);
        expect(t.keptShare).toBeGreaterThan(0.99);
        expect(t.meanDeltaE).toBeLessThan(0.5);
        // the checker is there (neighbouring output texels differ) ...
        let diff = 0;
        for (let x = 1; x < 128; x++) diff += Math.abs(t.image.rgba[(50 * 128 + x) * 4] - t.image.rgba[(50 * 128 + x - 1) * 4]);
        expect(diff / 127).toBeGreaterThan(2);
        // ... and the photo's colours are kept: shrunk back, within 2 levels inside the flat stone and window areas
        const back = shrink(t.image, 4);
        let worst = 0;
        for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
            const edge = [x % 8 === 1 || x % 8 === 2 || x % 8 === 5 || x % 8 === 6, y % 6 === 0 || y % 6 === 1 || y % 6 === 4 || y % 6 === 5].some(Boolean);
            if (edge) continue;
            for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(back.rgba[(y * 32 + x) * 4 + c] - photo.rgba[(y * 32 + x) * 4 + c]));
        }
        expect(worst).toBeLessThanOrEqual(2);
    });

    it('keeps the detail of an answer whose colours are shifted as a whole (a brighter answer)', () => {
        const ai = enlargeWithChecker(photo, 4, 4);
        for (let i = 0; i < ai.rgba.length; i++) if (i % 4 !== 3) ai.rgba[i] = Math.min(255, ai.rgba[i] + 12);
        const t = transferDetail(photo, ai, 4);
        expect(t.keptShare).toBeGreaterThan(0.9);
        // and the photo's colours are kept, not the answer's brighter ones
        const back = shrink(t.image, 4);
        expect(Math.abs(back.rgba[(3 * 32 + 0) * 4] - photo.rgba[(3 * 32 + 0) * 4])).toBeLessThanOrEqual(2);
    });

    it('drops the detail where the answer redrew the photo (a block invented over a plain patch)', () => {
        const plain: RgbaImage8 = { width: 32, height: 24, rgba: new Uint8Array(32 * 24 * 4).map((_, i) => (i % 4 === 3 ? 255 : 160)) };
        const ai = enlargeWithChecker(plain, 4, 2);
        // the "sign": dark letters drawn at output 40..88 x 32..64 (photo 10..22 x 8..16), a 1-texel stroke pattern
        for (let y = 32; y < 64; y++) for (let x = 40; x < 88; x++) if ((x % 6 < 2) || (y % 8 < 2)) for (let c = 0; c < 3; c++) ai.rgba[(y * 128 + x) * 4 + c] = 20;
        const t = transferDetail(plain, ai, 4);
        expect(t.keptShare).toBeLessThan(0.9);
        // inside the sign the output is the plain photo (no letters)
        let maxDev = 0;
        for (let y = 36; y < 60; y++) for (let x = 44; x < 84; x++) maxDev = Math.max(maxDev, Math.abs(t.image.rgba[(y * 128 + x) * 4] - 160));
        expect(maxDev).toBeLessThanOrEqual(1);
    });

    it("caps detail at the photo's own contrast on a plain patch", () => {
        const plain: RgbaImage8 = { width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).map((_, i) => (i % 4 === 3 ? 255 : 128)) };
        const t = transferDetail(plain, enlargeWithChecker(plain, 4, 40), 4);
        const lim = FACADE_UPSCALE_PARAMS.softRatio * FACADE_UPSCALE_PARAMS.contrastFloor;
        let maxDev = 0;
        for (let i = 0; i < 64 * 64; i++) maxDev = Math.max(maxDev, Math.abs(t.image.rgba[i * 4] - 128));
        expect(maxDev).toBeLessThanOrEqual(Math.ceil(lim));
        expect(t.cappedShare).toBeGreaterThan(0.9);
    });
});

describe('facade upscale: the twin', () => {
    const photo = facadePhoto(64, 48);
    const png = encodePng(64, 48, photo.rgba, 4);

    it('upscales the rebuilt facade 4x, labels it generated, and reads the answer back from the store next time', async () => {
        const asked: EnhanceModelRequest[] = [];
        const client = async (req: EnhanceModelRequest) => {
            asked.push(req);
            const tile = decodeImageInMemory(req.image.bytes);
            const up = enlargeWithChecker(tile, 4, 3);
            return { bytes: encodePng(up.width, up.height, up.rgba, 4), mimeType: 'image/png', modelUsed: 'fake-image', requestedModels: req.models, skippedModels: [], modelNote: 'fake' };
        };
        const store = memoryReadingStore();
        const out = await upscaleFacadeTextures(twin(png), { client, store });
        expect(out.report.upscaled).toBe(1);
        expect(out.report.calls).toBe(1);
        expect(asked[0].imageSize).toBe('1K');
        expect(asked[0].image.width).toBe(64); // one square tile, the photo's longest side
        const g = parseGlbBytes(out.glb);
        const v = g.json.bufferViews[g.json.images[0].bufferView];
        const img = decodeImageInMemory(g.bin.subarray(v.byteOffset, v.byteOffset + v.byteLength));
        expect([img.width, img.height]).toEqual([256, 192]);
        const extras = g.json.nodes[0].extras;
        expect(extras.sbFacadeUpscale.label).toBe('generated');
        expect(extras.sbFacadeUpscale.model).toBe('fake-image');
        expect(extras.sbFacadeUpscale.factor).toBe(4);
        expect(extras.sbFacadeLattice.facadeId).toBe(3);
        // the geometry's views are copied unchanged
        const pos = g.json.bufferViews[g.json.accessors[0].bufferView];
        expect(Array.from(new Float32Array(Uint8Array.from(g.bin.subarray(pos.byteOffset, pos.byteOffset + pos.byteLength)).buffer))).toEqual([0, 0, 0, 10, 0, 0, 10, 6, 0, 0, 6, 0]);
        expect(facadeUpscaleProvenance(out.report)).toMatchObject({ source: 'facade-upscale', label: 'generated', coverage: 1 });
        // again: every tile from the store, no call
        const again = await upscaleFacadeTextures(twin(png), { client, store });
        expect(again.report.calls).toBe(0);
        expect(again.report.cached).toBe(1);
        expect(asked.length).toBe(1);
        expect(Buffer.compare(again.glb, out.glb)).toBe(0);
    });

    it('asks a facade in tiles, never more calls at once than the limit, and blends them to the whole facade', async () => {
        let inFlight = 0, most = 0;
        const client = async (req: EnhanceModelRequest) => {
            inFlight++; most = Math.max(most, inFlight);
            await new Promise(r => setTimeout(r, 5));
            inFlight--;
            const up = enlargeWithChecker(decodeImageInMemory(req.image.bytes), 4, 3);
            return { bytes: encodePng(up.width, up.height, up.rgba, 4), mimeType: 'image/png', modelUsed: 'fake-image', requestedModels: req.models, skippedModels: [], modelNote: 'fake' };
        };
        const out = await upscaleFacadeTextures(twin(png), { client }, { ...FACADE_UPSCALE_PARAMS, tilePx: 32, overlapPx: 8, concurrency: 2 });
        expect(out.report.calls).toBe(6); // 3 tiles across 64 px, 2 down 48 px
        expect(most).toBeLessThanOrEqual(2);
        expect(out.report.perFacade[0].to).toEqual([256, 192]);
        expect(out.report.perFacade[0].keptShare).toBeGreaterThan(0.95);
    });

    describe('the best upscale kept per facade, and always loaded (user decision 2026-11-05)', () => {
        const place = { lat: 40.7503, lng: -73.9917, heightMeters: -30 };
        const answering = (amp: number, asked: EnhanceModelRequest[]) => async (req: EnhanceModelRequest) => {
            asked.push(req);
            const up = enlargeWithChecker(decodeImageInMemory(req.image.bytes), 4, amp);
            return { bytes: encodePng(up.width, up.height, up.rgba, 4), mimeType: 'image/png', modelUsed: 'fake-image', requestedModels: req.models, skippedModels: [], modelNote: 'fake' };
        };
        /** The photo a later build sees: the same facade with its texels nudged (a new de-light or tile set), so no tile's pixels match. */
        const nudged = (() => { const p = facadePhoto(64, 48); for (let i = 0; i < p.rgba.length; i += 4) p.rgba[i] = Math.min(255, p.rgba[i] + 2); return encodePng(64, 48, p.rgba, 4); })();

        it('names a facade by where it stands and its size, not by its pixels', () => {
            const a = facadeIdentityKey(place, [0, 0, 0], [10, 6, 0], ['m']);
            expect(facadeIdentityKey(place, [0.1, 0.05, 0.1], [10.1, 6.05, 0.1], ['m'])).toBe(a);
            expect(facadeIdentityKey(place, [20, 0, 0], [30, 6, 0], ['m'])).not.toBe(a);
            expect(facadeIdentityKey(place, [0, 0, 0], [10, 9, 0], ['m'])).not.toBe(a);
        });

        it("loads the kept upscale onto a changed photo without asking the model again", async () => {
            const store = memoryReadingStore(), asked: EnhanceModelRequest[] = [];
            const first = await upscaleFacadeTextures(twin(png), { client: answering(3, asked), store, place });
            expect(first.report.calls).toBe(1);
            expect(first.report.bestWritten).toBe(1);
            const never = async () => { throw new Error('must not be called'); };
            const later = await upscaleFacadeTextures(twin(nudged), { client: never, store, place });
            expect(later.report.calls).toBe(0);
            expect(later.report.reused).toBe(1);
            expect(later.report.perFacade[0].reused).toBe('kept');
            expect(later.report.perFacade[0].keptShare).toBeGreaterThan(0.9);
            expect(later.report.upscaled).toBe(1);
            // without the place, the changed photo's tiles are new and would be asked for
            const unkept = await upscaleFacadeTextures(twin(nudged), { client: answering(3, asked), store });
            expect(unkept.report.calls).toBe(1);
        });

        it('asks again when the kept one no longer fits, keeps the new one only when it scores higher', async () => {
            const store = memoryReadingStore(), asked: EnhanceModelRequest[] = [];
            await upscaleFacadeTextures(twin(png), { client: answering(3, asked), store, place });
            // a strict reuse bar makes the kept one "not fit": the model is asked again for the changed photo
            const strict = { ...FACADE_UPSCALE_PARAMS, reuseMinKept: 1.01 };
            // the new answer is redrawn (a large offset everywhere): it scores lower than the kept one, which stays
            const worse = async (req: EnhanceModelRequest) => {
                asked.push(req);
                const t = decodeImageInMemory(req.image.bytes), up = enlargeWithChecker(t, 4, 3);
                for (let i = 0; i < up.rgba.length; i += 4) if ((i / 4) % 7 < 3) { up.rgba[i] = 255 - up.rgba[i]; up.rgba[i + 1] = 255 - up.rgba[i + 1]; }
                return { bytes: encodePng(up.width, up.height, up.rgba, 4), mimeType: 'image/png', modelUsed: 'fake-image', requestedModels: req.models, skippedModels: [], modelNote: 'fake' };
            };
            const n = asked.length;
            const r = await upscaleFacadeTextures(twin(nudged), { client: worse, store, place }, strict);
            expect(asked.length).toBe(n + 1);
            expect(r.report.perFacade[0].reused).toBe('kept-over-new');
            expect(r.report.bestWritten).toBe(0);
            // past the call budget the kept one is used as it scores, however strict the bar
            const none = await upscaleFacadeTextures(twin(nudged), { client: async () => { throw new Error('no'); }, store, place }, { ...strict, maxCalls: 0 });
            expect(none.report.perFacade[0].reused).toBe('kept');
            expect(none.report.upscaled).toBe(1);
        });
    });

    it('leaves the twin as it was, with the reason, without a client or past the call budget', async () => {
        const none = await upscaleFacadeTextures(twin(png), {});
        expect(none.report.upscaled).toBe(0);
        expect(none.report.skipped).toMatch(/no image model client/);
        const client = async () => { throw new Error('must not be called'); };
        const over = await upscaleFacadeTextures(twin(png), { client }, { ...FACADE_UPSCALE_PARAMS, maxCalls: 0 });
        expect(over.report.upscaled).toBe(0);
        expect(over.report.perFacade[0].skipped).toMatch(/model calls/);
        const late = await upscaleFacadeTextures(twin(png), { client }, { ...FACADE_UPSCALE_PARAMS, maxMs: -1 });
        expect(late.report.upscaled).toBe(0);
        expect(late.report.perFacade[0].skipped).toMatch(/not started within/);
        const failing = await upscaleFacadeTextures(twin(png), { client: async () => { throw new Error('quota'); } });
        expect(failing.report.perFacade[0].skipped).toMatch(/quota/);
    });

    it('gives the build and its chat tool the extra time only when asked', () => {
        const isolate = { query: 'x', isolate: true };
        const base = resolveToolTimeBudget('google_3d_tiles_get_clay', isolate, 5 * 60_000).maxMs;
        expect(resolveToolTimeBudget('google_3d_tiles_get_clay', { ...isolate, steps: { 'twin.facadeUpscale': true } }, 5 * 60_000).maxMs).toBe(base + FACADE_UPSCALE_EXTRA_MS);
        expect(facadeUpscaleAsked({ 'twin.facadeUpscale': false })).toBe(false);
        // a district: on by default, the node graph and the environment still decide
        const env = process.env.SCRATCHBOX_K_FACADE_UPSCALE;
        try {
            delete process.env.SCRATCHBOX_K_FACADE_UPSCALE;
            expect(facadeUpscaleAsked(undefined, { district: true })).toBe(true);
            expect(facadeUpscaleAsked(undefined)).toBe(false);
            expect(facadeUpscaleAsked({ 'twin.facadeUpscale': false }, { district: true })).toBe(false);
            process.env.SCRATCHBOX_K_FACADE_UPSCALE = '0';
            expect(facadeUpscaleAsked(undefined, { district: true })).toBe(false);
            process.env.SCRATCHBOX_K_FACADE_UPSCALE = '1';
            expect(facadeUpscaleAsked(undefined)).toBe(true);
            // a district's capped upscale adds no time to its budget
            delete process.env.SCRATCHBOX_K_FACADE_UPSCALE;
            const district = { query: 'x', isolate: false };
            expect(resolveToolTimeBudget('google_3d_tiles_get_clay', { ...district, steps: { 'twin.facadeUpscale': true } }, 5 * 60_000).maxMs).toBe(resolveToolTimeBudget('google_3d_tiles_get_clay', district, 5 * 60_000).maxMs);
        } finally {
            if (env === undefined) delete process.env.SCRATCHBOX_K_FACADE_UPSCALE; else process.env.SCRATCHBOX_K_FACADE_UPSCALE = env;
        }
        // a district chunk's cap: a dozen calls and six minutes
        expect(FACADE_UPSCALE_DISTRICT_PARAMS.maxCalls).toBe(12);
        expect(FACADE_UPSCALE_DISTRICT_PARAMS.maxMs).toBe(6 * 60_000);
        expect(facadeUpscaleAsked(undefined)).toBe(process.env.SCRATCHBOX_K_FACADE_UPSCALE?.trim() === '1');
    });

    it('is a node graph step, off by default', () => {
        expect(BUILD_STEPS.find(s => s.key === 'twin.facadeUpscale')?.stage).toBe('textures');
        expect(TOGGLEABLE_STEPS.has('twin.facadeUpscale')).toBe(true);
    });
});
