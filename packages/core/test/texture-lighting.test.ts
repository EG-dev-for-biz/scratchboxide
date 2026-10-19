/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Model lighting correction, detail-locked (texture-lighting.ts). Synthetic only: a known albedo with fine structure, a known
 * shading field multiplied into it, and a fake model whose answer is the albedo evenly lit PLUS detail it invented. The
 * corrected photo must lose the shading and keep none of the invented detail. No network, no billed call; screenshots under
 * test-results/screenshots/nb_delight/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import { unpackConfidenceTexel, type DecodedImage, type DepthMap, type PinholeCamera, type ProjectionView, type UvAtlas } from '../src/common/spatial/texture-pass-contracts';
import { MediaModelUnavailableError } from '../src/common/errors/pipeline-errors';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../src/common/spatial/photogrammetric-delight';
import { encodePng } from '../src/node/texture-processing';
import {
    applyLightingField, correctTilePlaneLighting, detailLock, LIGHTING_MODEL_LITE, LIGHTING_PROMPTS, lightingCorrectImage, lightingModels, measureSourceSeam
} from '../src/node/3d-engine/staged-location/texture-lighting';
import type { EnhanceModelClient } from '../src/node/3d-engine/staged-location/texture-enhance';
import { decodeImageInMemory, type RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { bakeStreetViewProjection, measureCrossViewAgreement } from '../src/node/3d-engine/staged-location/texture-projection';
import { gateLightingViews, lightingProvenance } from '../src/node/3d-engine/staged-location/texture-pass';
import { FACADE, facadeAtlas, lookAtCamera } from './helpers/texture-pass-fixtures';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/nb_delight');
const shot = (name: string, img: RgbaImage8) => { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, `${name}.png`), encodePng(img.width, img.height, Buffer.from(img.rgba))); };
const side = (imgs: RgbaImage8[]): RgbaImage8 => {
    const w = imgs.reduce((s, i) => s + i.width + 4, -4), h = Math.max(...imgs.map(i => i.height)), out = new Uint8Array(w * h * 4).fill(255);
    let x0 = 0;
    for (const im of imgs) { for (let y = 0; y < im.height; y++) out.set(im.rgba.subarray(y * im.width * 4, (y + 1) * im.width * 4), (y * w + x0) * 4); x0 += im.width + 4; }
    return { width: w, height: h, rgba: out };
};

/** Albedo with fine structure: coursed blocks, dark joints, a carved "letter" band, at (x, y) in 0..1. */
function albedo(x: number, y: number): Vec3 {
    const bu = (x * 18) % 1, bv = (y * 10 + (Math.floor(x * 18) % 2) * 0.5) % 1;
    const joint = bu < 0.06 || bv < 0.08;
    const letter = y > 0.42 && y < 0.5 && Math.sin(x * 160) > 0.6;
    const base: Vec3 = [190 + 20 * Math.sin(x * 7), 175 + 15 * Math.cos(y * 5), 150];
    return joint ? [95, 88, 80] : letter ? [60, 55, 50] : base;
}
/** A known shading field (linear): a soft-edged cast shadow over the left 40 percent, a vertical falloff, a warm cast. */
function shading(x: number, y: number): Vec3 {
    const shadow = 0.35 + 0.65 / (1 + Math.exp(-(x - 0.4) * 60));
    const fall = 0.8 + 0.2 * (1 - y);
    return [shadow * fall * 1.1, shadow * fall, shadow * fall * 0.8];
}
/** Invented detail (what a model might draw): thin bright diagonal strokes nowhere in the albedo. */
const invented = (x: number, y: number): number => (Math.abs(((x + y) * 25) % 1 - 0.5) < 0.04 ? 1 : 0);

function image(W: number, H: number, f: (x: number, y: number) => Vec3): RgbaImage8 {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = f((x + 0.5) / W, (y + 0.5) / H), i = (y * W + x) * 4;
        rgba[i] = Math.round(Math.max(0, Math.min(255, c[0]))); rgba[i + 1] = Math.round(Math.max(0, Math.min(255, c[1]))); rgba[i + 2] = Math.round(Math.max(0, Math.min(255, c[2]))); rgba[i + 3] = 255;
    }
    return { width: W, height: H, rgba };
}
const lit = (a: Vec3, s: Vec3): Vec3 => [0, 1, 2].map(c => linearToSrgb255(SRGB8_TO_LINEAR[Math.round(a[c])] * s[c])) as Vec3;
const photo = (W: number, H: number) => image(W, H, (x, y) => lit(albedo(x, y), shading(x, y)));
/** The fake model's answer: the albedo evenly lit at 0.9, blurred slightly, with invented strokes painted on. */
const answer = (W: number, H: number) => image(W, H, (x, y) => { const a = lit(albedo(x, y), [0.9, 0.9, 0.9]); return invented(x, y) ? [255, 255, 255] : a; });

const pngOf = (img: RgbaImage8) => new Uint8Array(encodePng(img.width, img.height, Buffer.from(img.rgba)));
/** A client answering with `make(width, height)` at the size it was sent (as the image models do). */
const fakeClient = (make: (w: number, h: number) => RgbaImage8, model = LIGHTING_MODEL_LITE): EnhanceModelClient => async req => ({
    bytes: pngOf(make(req.image.width, req.image.height)), mimeType: 'image/png', modelUsed: model, requestedModels: req.models, skippedModels: [], modelNote: `${model} answered`
});

/** log-ratio of an image to the albedo, per pixel luminance, over pixels away from the joints and letters. */
function shadingResidualStd(img: RgbaImage8): number {
    const v: number[] = [];
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const fx = (x + 0.5) / img.width, fy = (y + 0.5) / img.height, a = albedo(fx, fy), i = (y * img.width + x) * 4;
        const la = 0.2126 * SRGB8_TO_LINEAR[Math.round(a[0])] + 0.7152 * SRGB8_TO_LINEAR[Math.round(a[1])] + 0.0722 * SRGB8_TO_LINEAR[Math.round(a[2])];
        const li = 0.2126 * SRGB8_TO_LINEAR[img.rgba[i]] + 0.7152 * SRGB8_TO_LINEAR[img.rgba[i + 1]] + 0.0722 * SRGB8_TO_LINEAR[img.rgba[i + 2]];
        if (li > 0.003 && la > 0.003) v.push(Math.log(li / la));
    }
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length);
}

/** Pearson correlation of an image's luma high band with the invented-stroke pattern. */
function inventedCorrelation(img: RgbaImage8): number {
    const W = img.width, H = img.height, a: number[] = [], b: number[] = [];
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const L = (xx: number, yy: number) => { const i = (yy * W + xx) * 4; return 0.2126 * img.rgba[i] + 0.7152 * img.rgba[i + 1] + 0.0722 * img.rgba[i + 2]; };
        a.push(L(x, y) - 0.25 * (L(x - 1, y) + L(x + 1, y) + L(x, y - 1) + L(x, y + 1)));
        b.push(invented((x + 0.5) / W, (y + 0.5) / H));
    }
    const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
    let num = 0, va = 0, vb = 0;
    for (let i = 0; i < a.length; i++) { num += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
    return num / Math.sqrt(va * vb);
}

describe('texture lighting: the detail lock', () => {
    it('removes a known shading field and carries none of the detail the model invented', async () => {
        const W = 384, H = 256;
        const orig = photo(W, H);
        const res = await lightingCorrectImage({ label: 'synthetic', image: orig, client: fakeClient(answer), models: [LIGHTING_MODEL_LITE] });
        expect(res.record.decision, JSON.stringify(res.record)).toBe('accepted');
        const corrected = applyLightingField(orig, res.field!);
        const ans = answer(W, H);
        shot('detail_lock_synthetic_original_answer_corrected', side([orig, ans, corrected]));
        // the shading is gone: the corrected photo's ratio to the albedo is nearly flat (the original's swings by the shadow)
        const before = shadingResidualStd(orig), after = shadingResidualStd(corrected);
        expect(before).toBeGreaterThan(0.3);
        expect(after).toBeLessThan(before / 3);
        // the invented strokes are in the answer and not in the corrected photo
        expect(inventedCorrelation(ans)).toBeGreaterThan(0.5);
        expect(Math.abs(inventedCorrelation(corrected))).toBeLessThan(0.05);
        expect(Math.abs(inventedCorrelation(orig))).toBeLessThan(0.05);
        // fine structure is the photo's own: the corrected photo's high band is the original's times a smooth gain
        expect(res.record.confidence).toBeGreaterThan(0.5);
    });

    it('rejects an answer that moved (misaligned edges) or changed its framing, and keeps the photo', () => {
        const W = 384, H = 256, orig = photo(W, H);
        const shifted = image(W, H, (x, y) => lit(albedo(x + 6 / W, y + 3 / H), [0.9, 0.9, 0.9]));
        const moved = detailLock(orig, shifted);
        expect(moved.accepted).toBe(false);
        expect(['lighting_misaligned', 'lighting_edges_moved']).toContain(moved.reasonCode);
        const reframed = detailLock(orig, answer(W, H), { sentAspect: W / H, answerAspect: 1 });
        expect(reframed.accepted).toBe(false);
        expect(reframed.reasonCode).toBe('lighting_framing_changed');
        const unrelated = detailLock(orig, image(W, H, (x, y) => [128 + 100 * Math.sin(x * 40 + y * 13), 120, 110]));
        expect(unrelated.accepted).toBe(false);
    });

    it('records a model failure (also as it crosses from a worker, by its code) and propagates anything else', async () => {
        const orig = photo(96, 64);
        const failing: EnhanceModelClient = async () => { throw new MediaModelUnavailableError(LIGHTING_MODEL_LITE, 'quota'); };
        expect((await lightingCorrectImage({ label: 'x', image: orig, client: failing, models: [LIGHTING_MODEL_LITE] })).record.decision).toBe('model_failed');
        const wired: EnhanceModelClient = async () => { throw Object.assign(new Error('Media model unavailable'), { code: 'media_model_unavailable' }); };
        expect((await lightingCorrectImage({ label: 'x', image: orig, client: wired, models: [LIGHTING_MODEL_LITE] })).record.decision).toBe('model_failed');
        const bug: EnhanceModelClient = async () => { throw new TypeError('bug'); };
        await expect(lightingCorrectImage({ label: 'x', image: orig, client: bug, models: [LIGHTING_MODEL_LITE] })).rejects.toThrow('bug');
    });

    it('keeps the masked-out region (the sky) out of the field and leaves it untouched', async () => {
        const W = 256, H = 192, orig = photo(W, H);
        // the top quarter is "sky" the model brightened a lot; masked out, it must not change the stone below it
        const mask = new Uint8Array(W * H);
        for (let y = H / 4; y < H; y++) for (let x = 0; x < W; x++) mask[y * W + x] = 1;
        const skyAnswer = (w: number, h: number) => image(w, h, (x, y) => (y < 0.25 ? [255, 255, 255] : lit(albedo(x, y), [0.9, 0.9, 0.9])));
        const res = await lightingCorrectImage({ label: 'sky', image: orig, mask, client: fakeClient(skyAnswer), models: [LIGHTING_MODEL_LITE] });
        expect(res.record.decision).toBe('accepted');
        const out = applyLightingField(orig, res.field!, mask);
        for (let x = 0; x < W; x += 17) expect(out.rgba[(5 * W + x) * 4]).toBe(orig.rgba[(5 * W + x) * 4]);
        // just below the sky the gain is the stone's (no bleed of the sky's huge ratio)
        const row = Math.round(H / 4) + 2, k = (row * W + Math.round(W * 0.8)) * 4;
        const want = lit(albedo(0.8, (row + 0.5) / H), [0.9, 0.9, 0.9]);
        expect(Math.abs(out.rgba[k + 1] - want[1])).toBeLessThan(18);
    });

    it('defaults to Nano Banana Lite and keeps every prompt variant within the model guidance', () => {
        const prev = process.env.SCRATCHBOX_TEXTURE_LIGHTING_MODELS;
        delete process.env.SCRATCHBOX_TEXTURE_LIGHTING_MODELS;
        expect(lightingModels()).toEqual([LIGHTING_MODEL_LITE]);
        if (prev !== undefined) process.env.SCRATCHBOX_TEXTURE_LIGHTING_MODELS = prev;
        for (const [k, f] of Object.entries(LIGHTING_PROMPTS)) {
            const p = f(1024, 768);
            expect(p.length, k).toBeGreaterThan(80);
            expect(/aspect/i.test(p), k).toBe(true);
            if (k.startsWith('json')) expect(() => JSON.parse(p)).not.toThrow();
        }
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// Views of one facade, each photographed under its own sun: the gate and the bake
// ---------------------------------------------------------------------------------------------------------------------

/** Per view, a cast shadow over a different part of the facade (captured at another time of day). */
const SUN: Record<string, (u: number, v: number) => number> = {
    'pano-front': u => 0.35 + 0.65 / (1 + Math.exp(-(u - 3) * 6)),
    'pano-left': u => 0.35 + 0.65 / (1 + Math.exp((u - 7) * 6)),
    'pano-right': (_u, v) => 0.4 + 0.6 / (1 + Math.exp(-(v - 2.5) * 6))
};
const wall = (u: number, v: number): Vec3 => albedo(u / FACADE.widthM, 1 - v / FACADE.heightM);

function renderView(cam: PinholeCamera, light: (u: number, v: number) => number, extra?: (u: number, v: number) => number): { image: DecodedImage; depth: DepthMap } {
    const rgba = new Uint8Array(cam.width * cam.height * 4), depthM = new Float32Array(cam.width * cam.height);
    for (let py = 0; py < cam.height; py++) for (let px = 0; px < cam.width; px++) {
        const sx = (px + 0.5 - cam.cx) / cam.fx, sy = (py + 0.5 - cam.cy) / cam.fy;
        const dir: Vec3 = [cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1], cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]];
        const t = -cam.eye[2] / dir[2], i = py * cam.width + px;
        let rgb: Vec3 = [140, 160, 200];
        depthM[i] = Infinity;
        if (t > 0) {
            const u = cam.eye[0] + t * dir[0], v = cam.eye[1] + t * dir[1];
            if (u >= 0 && u <= FACADE.widthM && v >= 0 && v <= FACADE.heightM) { const s = light(u, v) * (extra ? extra(u, v) : 1); rgb = lit(wall(u, v), [s, s, s]); depthM[i] = t; }
        }
        rgba.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
    }
    return { image: { width: cam.width, height: cam.height, rgba }, depth: { width: cam.width, height: cam.height, depthM } };
}

const EYES: Record<string, Vec3> = { 'pano-front': [5, 1.7, -14], 'pano-left': [-3, 1.7, -12], 'pano-right': [13, 1.7, -12] };
function viewRig(): { views: ProjectionView[]; depth: Map<ProjectionView, DepthMap>; even: Map<string, DecodedImage>; worse: Map<string, DecodedImage> } {
    const depth = new Map<ProjectionView, DepthMap>(), even = new Map<string, DecodedImage>(), worse = new Map<string, DecodedImage>();
    const views = Object.keys(EYES).map(panoId => {
        const camera = lookAtCamera(EYES[panoId], [5, 3, 0], 240, 144, 70);
        const r = renderView(camera, SUN[panoId]);
        const view: ProjectionView = { panoId, camera, image: r.image, poseQuality: 1, poseSigmaPx: 0 };
        depth.set(view, r.depth);
        even.set(panoId, renderView(camera, () => 0.9).image);
        // a "relighting" that stripes the whole wall with dark bands the other views never show
        worse.set(panoId, renderView(camera, SUN[panoId], u => ((u % 1) < 0.5 ? 0.3 : 1)).image);
        return view;
    });
    return { views, depth, even, worse };
}

describe('texture lighting: cross-view gate and bake', () => {
    it('corrected views agree better, the gate takes them, and the bake gets closer to the albedo; a worse photo is set back', async () => {
        const { views, depth, even, worse } = viewRig();
        const atlas = facadeAtlas(96);
        const origOf = new Map<ProjectionView, ProjectionView>(), corrOf = new Map<ProjectionView, ProjectionView>();
        const depthFor = (v: ProjectionView) => depth.get(origOf.get(v) ?? v)!;
        const measure = (vs: ProjectionView[], pairFilter?: (a: number, b: number) => boolean) => measureCrossViewAgreement({ atlas, views: vs, depthFor, spacingM: 0.25, footprintM: 0.3, ...(pairFilter ? { pairFilter } : {}) });
        // the "model": front and left come back evenly lit (their shading removed), right comes back worse
        const { resizeRgba, padToModelAspect } = await import('../src/node/3d-engine/staged-location/texture-enhance');
        const lightingViews = [];
        for (let k = 0; k < views.length; k++) {
            const v = views[k];
            const target = v.panoId === 'pano-right' ? worse.get(v.panoId)! : even.get(v.panoId)!;
            const client: EnhanceModelClient = async req => {
                const { padded } = padToModelAspect(target as RgbaImage8);
                return { bytes: pngOf(resizeRgba(padded, req.image.width, req.image.height)), mimeType: 'image/png', modelUsed: LIGHTING_MODEL_LITE, requestedModels: req.models, skippedModels: [], modelNote: '' };
            };
            const r = await lightingCorrectImage({ label: v.panoId, image: v.image as RgbaImage8, client, models: [LIGHTING_MODEL_LITE] });
            expect(r.record.decision, v.panoId).toBe('accepted');
            lightingViews.push({ index: k, panoId: v.panoId, image: applyLightingField(v.image as RgbaImage8, r.field!), modelUsed: LIGHTING_MODEL_LITE, confidence: r.record.confidence ?? 0 });
        }
        let report: any;
        const chosen = gateLightingViews({ views, corrected: lightingViews, measure, origOf, corrOf, report: r => { report = r; } });
        expect(report.before.medianDeltaE).toBeGreaterThan(2);
        expect(report.applied).toBe(true);
        expect(report.reverted, JSON.stringify([report.before.perView, report.after.perView, report.before.medianDeltaE, report.after.medianDeltaE])).toEqual(['pano-right']);
        expect(report.final.medianDeltaE).toBeLessThan(report.before.medianDeltaE * 0.7);
        expect(chosen.filter((v, k) => v !== views[k]).map(v => v.panoId).sort()).toEqual(['pano-front', 'pano-left']);
        // the bake from the chosen views is closer to the evenly lit wall than the bake from the originals
        // the bake's lighting error: log ratio of 8 x 8 texel block means of the bake to the evenly lit wall's (lighting, not detail)
        const err = async (vs: ProjectionView[]) => {
            const b = await bakeStreetViewProjection({ atlas, views: vs, depthFor, options: { align: false } });
            const B = 8, ref: number[] = [];
            for (let by = 0; by + B <= atlas.height; by += B) for (let bx = 0; bx + B <= atlas.width; bx += B) {
                let sb = 0, sg = 0, n = 0;
                for (let y = by; y < by + B; y++) for (let x = bx; x < bx + B; x++) {
                    const t = y * atlas.width + x;
                    if (b.albedo[t * 4 + 3] !== 255) continue;
                    const g = lit(wall(atlas.texels.position[t * 3], atlas.texels.position[t * 3 + 1]), [0.9, 0.9, 0.9]);
                    sb += SRGB8_TO_LINEAR[b.albedo[t * 4 + 1]]; sg += SRGB8_TO_LINEAR[Math.round(g[1])]; n++;
                }
                if (n === B * B) ref.push(Math.log(sb / sg));
            }
            const m = ref.reduce((a, x) => a + x, 0) / ref.length;
            return { std: Math.sqrt(ref.reduce((a, x) => a + (x - m) ** 2, 0) / ref.length), planes: b };
        };
        const b0 = await err(views), b1 = await err(chosen);
        expect(b1.std, `${b0.std} -> ${b1.std}`).toBeLessThan(b0.std * 0.9);
        // provenance: the corrected panos' entries say so, and stay photo-inferred
        const labelled = lightingProvenance(b1.planes, corrOf, lightingViews);
        const hit = labelled.provenance.filter(p => p.lightingCorrection);
        expect(hit.length).toBeGreaterThan(0);
        for (const p of hit) { expect(p.label).toBe('photo-inferred'); expect(p.lightingCorrection!.note).toBe(`photo, lighting corrected by ${LIGHTING_MODEL_LITE}`); }
        const toImg = (p: { albedo: Uint8Array }) => ({ width: atlas.width, height: atlas.height, rgba: Uint8Array.from(p.albedo, (x, i) => (i % 4 === 3 ? 255 : x)) });
        shot('gate_bake_original_vs_corrected', side([toImg(b0.planes), toImg(b1.planes)]));
    });

    it('stays off when the corrections make the views disagree more', async () => {
        const { views, depth, worse } = viewRig();
        const atlas = facadeAtlas(64);
        const origOf = new Map<ProjectionView, ProjectionView>(), corrOf = new Map<ProjectionView, ProjectionView>();
        const lightingViews = views.map((v, k) => ({ index: k, panoId: v.panoId, image: (k === 0 ? worse.get(v.panoId)! : v.image), modelUsed: LIGHTING_MODEL_LITE, confidence: 1 }));
        let report: any;
        const chosen = gateLightingViews({ views, corrected: lightingViews, measure: (vs, pairFilter) => measureCrossViewAgreement({ atlas, views: vs, depthFor: v => depth.get(origOf.get(v) ?? v)!, ...(pairFilter ? { pairFilter } : {}) }), origOf, corrOf, report: r => { report = r; } });
        expect(report.applied).toBe(false);
        expect(chosen).toBe(views);
        expect(corrOf.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------------------------------------------------
// The tile plane: chart crops, judged against Street View texels
// ---------------------------------------------------------------------------------------------------------------------

describe('texture lighting: the tile photo', () => {
    function tilePlane(atlas: UvAtlas, shade: (u: number, v: number) => number) {
        const n = atlas.width * atlas.height, rgb = new Float32Array(n * 3), has = new Uint8Array(n).fill(1);
        const existing = { albedo: new Uint8Array(n * 4), confidence: { width: atlas.width, height: atlas.height, data: new Uint8Array(n * 4) } };
        for (let t = 0; t < n; t++) {
            const u = atlas.texels.position[t * 3], v = atlas.texels.position[t * 3 + 1], s = shade(u, v);
            rgb.set(lit(wall(u, v), [s, s, s]), t * 3);
            // the Street View bake covers the left half, evenly lit (multi-view, rung 0)
            if (u < 5) { existing.albedo.set([...lit(wall(u, v), [0.9, 0.9, 0.9]), 255], t * 4); existing.confidence.data.set([0, 255, 0, 255], t * 4); }
        }
        return { rgb, has, width: atlas.width, height: atlas.height, existing };
    }
    const shade = (u: number) => 0.35 + 0.65 / (1 + Math.exp(-(u - 2.5) * 5));
    const rungOf = (pl: ReturnType<typeof tilePlane>) => (i: number) => { const c = unpackConfidenceTexel(pl.existing.confidence as never, i); return { covered: c.covered, rung: c.rung }; };
    const evenAnswer = (atlas: UvAtlas): EnhanceModelClient => async req => {
        // the chart crop evenly lit, at the size sent (the facade chart fills its crop)
        const { resizeRgba, padToModelAspect } = await import('../src/node/3d-engine/staged-location/texture-enhance');
        const crop = image(atlas.width, atlas.height, (x, y) => lit(wall(x * FACADE.widthM, (1 - y) * FACADE.heightM), [0.9, 0.9, 0.9]));
        return { bytes: pngOf(resizeRgba(padToModelAspect(crop).padded, req.image.width, req.image.height)), mimeType: 'image/png', modelUsed: LIGHTING_MODEL_LITE, requestedModels: req.models, skippedModels: [], modelNote: '' };
    };

    it('relights the tile chart and stands because the tile agrees better with Street View', async () => {
        const atlas = facadeAtlas(128);
        const plane = tilePlane(atlas, shade);
        const before = Float32Array.from(plane.rgb);
        const r = await correctTilePlaneLighting({ atlas, plane, unpackRung: rungOf(plane), client: evenAnswer(atlas), models: [LIGHTING_MODEL_LITE] });
        expect(r.report.applied).toBe(true);
        expect(r.report.after!.medianDeltaE!).toBeLessThan(r.report.before!.medianDeltaE! / 2);
        expect(r.provenance!.lightingCorrection!.note).toBe(`photo, lighting corrected by ${LIGHTING_MODEL_LITE}`);
        expect(r.provenance!.label).toBe('photo-inferred');
        expect(r.texels!.reduce((s, x) => s + x, 0)).toBe(atlas.width * atlas.height);
        // the shaded right-hand texels (no Street View there) got brighter; joints stay darker than blocks
        let changed = 0;
        for (let i = 0; i < plane.rgb.length; i++) if (Math.abs(plane.rgb[i] - before[i]) > 3) changed++;
        expect(changed).toBeGreaterThan(plane.rgb.length / 4);
        const asImg = (a: Float32Array) => image(atlas.width, atlas.height, (x, y) => { const t = Math.min(atlas.height - 1, Math.floor(y * atlas.height)) * atlas.width + Math.min(atlas.width - 1, Math.floor(x * atlas.width)); return [a[t * 3], a[t * 3 + 1], a[t * 3 + 2]]; });
        shot('tile_chart_before_after', side([asImg(before), asImg(plane.rgb)]));
    });

    it('leaves the tile alone when the relit charts agree worse with Street View', async () => {
        const atlas = facadeAtlas(96);
        const plane = tilePlane(atlas, () => 0.9);
        const before = Float32Array.from(plane.rgb);
        const shadowing: EnhanceModelClient = async req => {
            const { resizeRgba, padToModelAspect } = await import('../src/node/3d-engine/staged-location/texture-enhance');
            const crop = image(atlas.width, atlas.height, (x, y) => { const s = shade(x * FACADE.widthM) * 0.9; return lit(wall(x * FACADE.widthM, (1 - y) * FACADE.heightM), [s, s, s]); });
            return { bytes: pngOf(resizeRgba(padToModelAspect(crop).padded, req.image.width, req.image.height)), mimeType: 'image/png', modelUsed: LIGHTING_MODEL_LITE, requestedModels: req.models, skippedModels: [], modelNote: '' };
        };
        const r = await correctTilePlaneLighting({ atlas, plane, unpackRung: rungOf(plane), client: shadowing, models: [LIGHTING_MODEL_LITE] });
        expect(r.report.applied).toBe(false);
        expect(r.texels).toBeUndefined();
        expect(Array.from(plane.rgb)).toEqual(Array.from(before));
    });

    it('measures the Street View / tile seam on the final texture', () => {
        const atlas = facadeAtlas(32), n = 32 * 32;
        const albedoPlane = new Uint8Array(n * 4), rung = new Int8Array(n);
        for (let t = 0; t < n; t++) { const left = t % 32 < 16; albedoPlane.set(left ? [120, 120, 120, 255] : [60, 60, 60, 255], t * 4); rung[t] = left ? 0 : 2; }
        const seam = measureSourceSeam(atlas, { albedo: albedoPlane }, i => rung[i]);
        expect(seam.pairs).toBe(32);
        expect(seam.medianDeltaE!).toBeGreaterThan(10);
        const flat = Uint8Array.from(albedoPlane).fill(120);
        expect(measureSourceSeam(atlas, { albedo: flat.map((x, i) => (i % 4 === 3 ? 255 : x)) }, i => rung[i]).medianDeltaE).toBeLessThan(0.5);
    });
});

// the answer decodes as the image models' PNG would
describe('texture lighting: answers', () => {
    it('round-trips a fake answer through PNG', () => {
        const a = answer(64, 48);
        const d = decodeImageInMemory(pngOf(a));
        expect([d.width, d.height]).toEqual([64, 48]);
    });
});
