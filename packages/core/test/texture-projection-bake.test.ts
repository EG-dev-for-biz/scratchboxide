/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View projection bake (texture pass task C). Synthetic, analytic rigs only: a planar facade with a known albedo,
 * optional occluding panels, pinhole views rendered by exact ray casting. No network, no image bytes on disk except the
 * screenshots under test-results/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import {
    unpackConfidenceTexel, type DecodedImage, type DepthMap, type PinholeCamera, type ProjectionView, type UvAtlas
} from '../src/common/spatial/texture-pass-contracts';
import { delightLinearRgb } from '../src/common/spatial/photogrammetric-delight';
import { bakeStreetViewProjection, type ProjectionBakeOptions, type ProjectionBakeResult } from '../src/node/3d-engine/staged-location/texture-projection';
import { deltaE00, SRGB_TO_LINEAR, linearToSrgb255 } from '../src/node/3d-engine/staged-location/texel-exposure';
import { measurePalette } from '../src/node/3d-engine/staged-location/photo-palette';
import { ProColorGradeMatchingService as Colour } from '../src/node/image/ProColorGradeMatchingService';
import { encodePng } from '../src/node/texture-processing';
import * as jpegJs from 'jpeg-js';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import type { Registration, RegView } from '../src/node/3d-engine/staged-location/pano-registration';
import { depthForMesh, poseQualityFromResidual, projectionViewFromRegistered } from '../src/node/3d-engine/staged-location/texture-projection-views';
import { FACADE, facadeAlbedo, facadeAtlas, lookAtCamera } from './helpers/texture-pass-fixtures';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/texture_bake');

// ---------------------------------------------------------------------------------------------------------------------
// A tiny analytic ray caster: rectangles with a colour function, the facade first
// ---------------------------------------------------------------------------------------------------------------------

interface Rect { origin: Vec3; u: Vec3; v: Vec3; w: number; h: number; color: (a: number, b: number) => Vec3 }
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const facadeRect = (color: (u: number, v: number) => Vec3 = facadeAlbedo): Rect =>
    ({ origin: FACADE.origin, u: FACADE.u, v: FACADE.v, w: FACADE.widthM, h: FACADE.heightM, color });
/** A magenta panel parallel to the facade, `standoff` metres in front of it. */
const panel = (x0: number, x1: number, y0: number, y1: number, standoff: number): Rect =>
    ({ origin: [x0, y0, -standoff], u: [1, 0, 0], v: [0, 1, 0], w: x1 - x0, h: y1 - y0, color: () => [255, 0, 255] });

function castPixel(cam: PinholeCamera, rects: Rect[], px: number, py: number): { rgb: Vec3; depth: number; hit: number; uv: [number, number] } {
    const sx = (px - cam.cx) / cam.fx, sy = (py - cam.cy) / cam.fy;
    const dir: Vec3 = [cam.fwd[0] + sx * cam.right[0] - sy * cam.up[0], cam.fwd[1] + sx * cam.right[1] - sy * cam.up[1], cam.fwd[2] + sx * cam.right[2] - sy * cam.up[2]];
    let best = Infinity, rgb: Vec3 = [128, 128, 128], hit = -1, uv: [number, number] = [0, 0];
    rects.forEach((r, i) => {
        const n = cross(r.u, r.v);
        const den = dot(dir, n);
        if (Math.abs(den) < 1e-12) return;
        const t = dot([r.origin[0] - cam.eye[0], r.origin[1] - cam.eye[1], r.origin[2] - cam.eye[2]], n) / den;
        if (!(t > 0) || t >= best) return;
        const p: Vec3 = [cam.eye[0] + t * dir[0] - r.origin[0], cam.eye[1] + t * dir[1] - r.origin[1], cam.eye[2] + t * dir[2] - r.origin[2]];
        const a = dot(p, r.u), b = dot(p, r.v);
        if (a < 0 || a > r.w || b < 0 || b > r.h) return;
        best = t; rgb = r.color(a, b); hit = i; uv = [a, b];
    });
    // depth along fwd: t * dot(dir, fwd) = t (dir has unit fwd component)
    return { rgb, depth: best, hit, uv };
}

/**
 * Image (sRGB, optional linear exposure gain) and depth (camera z) of a scene. Colour is box-filtered over 3 x 3
 * sub-pixels in linear light, as a real sensor integrates its pixel (point sampling would alias thin joints differently
 * in every view); depth is the pixel centre's.
 */
function render(cam: PinholeCamera, rects: Rect[], gain = 1): { image: DecodedImage; depth: DepthMap } {
    const rgba = new Uint8Array(cam.width * cam.height * 4), depthM = new Float32Array(cam.width * cam.height);
    const SS = 3;
    for (let y = 0; y < cam.height; y++) {
        for (let x = 0; x < cam.width; x++) {
            const i = y * cam.width + x;
            const acc = [0, 0, 0];
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const c = castPixel(cam, rects, x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
                    for (let k = 0; k < 3; k++) acc[k] += SRGB_TO_LINEAR[Math.round(Math.min(255, Math.max(0, c.rgb[k])))];
                }
            }
            for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.round(linearToSrgb255((acc[k] / (SS * SS)) * gain));
            rgba[i * 4 + 3] = 255;
            const d = castPixel(cam, rects, x + 0.5, y + 0.5).depth;
            depthM[i] = Number.isFinite(d) ? d : Infinity;
        }
    }
    return { image: { width: cam.width, height: cam.height, rgba }, depth: { width: cam.width, height: cam.height, depthM } };
}

const EYES: Record<string, Vec3> = { 'pano-front': [5, 1.7, -14], 'pano-left': [-3, 1.7, -12], 'pano-right': [13, 1.7, -12] };

interface RigView { view: ProjectionView; depth: DepthMap }
function rig(rects: Rect[], opts: { ids?: string[]; size?: [number, number]; gains?: Record<string, number>; quality?: Record<string, number>; occluders?: Rect[] } = {}): RigView[] {
    const [w, h] = opts.size ?? [160, 96];
    return (opts.ids ?? Object.keys(EYES)).map((panoId) => {
        const camera = lookAtCamera(EYES[panoId], [5, 3, 0], w, h, 70);
        const { image, depth } = render(camera, rects, opts.gains?.[panoId] ?? 1);
        return { view: { panoId, camera, image, poseQuality: opts.quality?.[panoId] ?? 1, poseSigmaPx: 0 }, depth };
    });
}

async function bake(views: RigView[], atlas: UvAtlas, options: ProjectionBakeOptions = {}, paletteLab?: Array<{ lab: Vec3; share: number }>): Promise<ProjectionBakeResult> {
    const depthOf = new Map(views.map((v) => [v.view, v.depth]));
    return bakeStreetViewProjection({ atlas, views: views.map((v) => v.view), depthFor: (v) => depthOf.get(v)!, paletteLab, options });
}

/** Facade (u, v) metres of an atlas texel (facadeAtlas layout). */
const texelUv = (atlas: UvAtlas, t: number): [number, number] => [atlas.texels.position[t * 3] - FACADE.origin[0], atlas.texels.position[t * 3 + 1] - FACADE.origin[1]];

function albedoError(res: ProjectionBakeResult, atlas: UvAtlas, truth: (u: number, v: number) => Vec3): { max: number; mean: number; n: number; maxDE: number } {
    let max = 0, sum = 0, n = 0, maxDE = 0;
    for (let t = 0; t < atlas.width * atlas.height; t++) {
        if (res.albedo[t * 4 + 3] !== 255) continue;
        const [u, v] = texelUv(atlas, t);
        const g = truth(u, v);
        for (let c = 0; c < 3; c++) { const e = Math.abs(res.albedo[t * 4 + c] - g[c]); max = Math.max(max, e); sum += e; }
        maxDE = Math.max(maxDE, deltaE00(Colour.srgbToLab(res.albedo[t * 4], res.albedo[t * 4 + 1], res.albedo[t * 4 + 2]), Colour.srgbToLab(g[0], g[1], g[2])));
        n++;
    }
    return { max, mean: sum / Math.max(1, 3 * n), n, maxDE };
}

/** A facade with real structure (panels, mortar joints, a smooth tone) so a held-out comparison means something. */
const panelled = (u: number, v: number): Vec3 => {
    const pu = ((u % 1.25) + 1.25) % 1.25, pv = ((v % 0.75) + 0.75) % 0.75;
    const joint = pu < 0.12 || pv < 0.1;
    const tone = 0.5 + 0.5 * Math.sin(u * 0.9) * Math.cos(v * 1.3);
    return joint ? [70, 66, 60] : [150 + 60 * tone, 110 + 40 * tone, 80 + 30 * tone];
};

function ssimMasked(a: Float64Array, b: Float64Array, mask: Uint8Array, w: number, h: number, win = 8): number {
    const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
    let total = 0, count = 0;
    for (let y0 = 0; y0 + win <= h; y0 += win / 2) {
        for (let x0 = 0; x0 + win <= w; x0 += win / 2) {
            let n = 0, ma = 0, mb = 0;
            for (let y = y0; y < y0 + win; y++) for (let x = x0; x < x0 + win; x++) { const i = y * w + x; if (!mask[i]) continue; ma += a[i]; mb += b[i]; n++; }
            if (n < win * win) continue;
            ma /= n; mb /= n;
            let va = 0, vb = 0, cov = 0;
            for (let y = y0; y < y0 + win; y++) for (let x = x0; x < x0 + win; x++) { const i = y * w + x; va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; cov += (a[i] - ma) * (b[i] - mb); }
            va /= n - 1; vb /= n - 1; cov /= n - 1;
            total += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
            count++;
        }
    }
    return count ? total / count : 0;
}

/** Re-renders the baked atlas onto the facade from a camera: bilinear lookup in the atlas, -1 where the texel is not baked. */
function renderBaked(cam: PinholeCamera, res: ProjectionBakeResult, atlas: UvAtlas): { rgba: Uint8Array; mask: Uint8Array } {
    const rgba = new Uint8Array(cam.width * cam.height * 4), mask = new Uint8Array(cam.width * cam.height);
    const S = atlas.width;
    for (let y = 0; y < cam.height; y++) {
        for (let x = 0; x < cam.width; x++) {
            const i = y * cam.width + x;
            const c = castPixel(cam, [facadeRect()], x + 0.5, y + 0.5);
            rgba[i * 4] = 40; rgba[i * 4 + 1] = 44; rgba[i * 4 + 2] = 52; rgba[i * 4 + 3] = 255;
            if (c.hit !== 0) continue;
            const fx = (c.uv[0] / FACADE.widthM) * S - 0.5, fy = (1 - c.uv[1] / FACADE.heightM) * S - 0.5;
            const x0 = Math.max(0, Math.min(S - 1, Math.floor(fx))), y0 = Math.max(0, Math.min(S - 1, Math.floor(fy)));
            const x1 = Math.min(S - 1, x0 + 1), y1 = Math.min(S - 1, y0 + 1);
            const ax = Math.min(1, Math.max(0, fx - x0)), ay = Math.min(1, Math.max(0, fy - y0));
            const taps = [[x0, y0, (1 - ax) * (1 - ay)], [x1, y0, ax * (1 - ay)], [x0, y1, (1 - ax) * ay], [x1, y1, ax * ay]];
            if (taps.some(([tx, ty]) => res.albedo[(ty * S + tx) * 4 + 3] !== 255)) {
                rgba[i * 4] = 255; rgba[i * 4 + 1] = 0; rgba[i * 4 + 2] = 255; // unbaked: shown magenta, excluded from scores
                continue;
            }
            for (let k = 0; k < 3; k++) {
                let s = 0;
                for (const [tx, ty, w] of taps) s += w * SRGB_TO_LINEAR[res.albedo[(ty * S + tx) * 4 + k]];
                rgba[i * 4 + k] = Math.round(linearToSrgb255(s));
            }
            mask[i] = 1;
        }
    }
    return { rgba, mask };
}

const lumaOf = (rgba: Uint8Array): Float64Array => {
    const out = new Float64Array(rgba.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
    return out;
};

function savePng(name: string, w: number, h: number, rgba: Uint8Array): string {
    fs.mkdirSync(SHOTS, { recursive: true });
    const p = path.join(SHOTS, name);
    fs.writeFileSync(p, encodePng(w, h, Buffer.from(rgba)));
    return p;
}

// ---------------------------------------------------------------------------------------------------------------------

describe('Street View projection bake', () => {
    it('reproduces the analytic facade albedo on every unoccluded texel', async () => {
        const atlas = facadeAtlas(48);
        const res = await bake(rig([facadeRect()]), atlas);
        const err = albedoError(res, atlas, facadeAlbedo);
        expect(err.n / (48 * 48)).toBeGreaterThan(0.8);
        // what is left uncovered is only the depth-edge guard band along the facade's own silhouette (3 px of every view)
        for (let t = 0; t < 48 * 48; t++) {
            if (res.albedo[t * 4 + 3] === 255) continue;
            const [u, v] = texelUv(atlas, t);
            expect(Math.min(u, v, FACADE.widthM - u, FACADE.heightM - v)).toBeLessThan(0.6);
        }
        expect(err.max).toBeLessThanOrEqual(2);
        expect(err.mean).toBeLessThanOrEqual(0.6);
        expect(res.report.views.every((v) => v.samples > 0)).toBe(true);
    });

    it('leaves texels no view sees uncovered and never paints the occluder onto the wall', async () => {
        const atlas = facadeAtlas(64);
        const occ = panel(4, 6, 0, 4, 1.0); // 1 m proud of the wall: past the 0.20 m + 0.02 z depth tolerance
        const res = await bake(rig([facadeRect(), occ]), atlas);
        // texels hidden behind the panel from every view (analytic): must stay uncovered
        const views = rig([facadeRect()]).map((v) => v.view.camera);
        let hiddenEverywhere = 0, hiddenBaked = 0;
        for (let t = 0; t < 64 * 64; t++) {
            const P: Vec3 = [atlas.texels.position[t * 3], atlas.texels.position[t * 3 + 1], atlas.texels.position[t * 3 + 2]];
            const hidden = views.every((cam) => {
                const d: Vec3 = [P[0] - cam.eye[0], P[1] - cam.eye[1], P[2] - cam.eye[2]];
                const s = (occ.origin[2] - cam.eye[2]) / d[2]; // ray parameter at the panel plane z = -0.4 (eye z < panel z < 0)
                const q = [cam.eye[0] + s * d[0], cam.eye[1] + s * d[1]];
                return q[0] >= 4 && q[0] <= 6 && q[1] >= 0 && q[1] <= 4;
            });
            if (!hidden) continue;
            hiddenEverywhere++;
            if (res.albedo[t * 4 + 3] === 255) hiddenBaked++;
            expect(unpackConfidenceTexel(res.confidence, t).covered).toBe(false);
        }
        expect(hiddenEverywhere).toBeGreaterThan(10);
        expect(hiddenBaked).toBe(0);
        const err = albedoError(res, atlas, facadeAlbedo);
        expect(err.max).toBeLessThanOrEqual(3); // no magenta bleed anywhere
        const deg = res.degradations.find((d) => d.reasonCode === 'no_view_sees_texel');
        expect(deg?.texelShare).toBeGreaterThan(0);
        expect(deg?.toRung).toBe(2);
    });

    it('a held-out view re-rendered from the bake matches the real view (SSIM >= 0.85)', async () => {
        const atlas = facadeAtlas(160);
        const scene = [facadeRect(panelled)];
        const used = rig(scene, { ids: ['pano-front', 'pano-left'], size: [320, 192] });
        const res = await bake(used, atlas);
        const held = rig(scene, { ids: ['pano-right'], size: [320, 192] })[0];
        const re = renderBaked(held.view.camera, res, atlas);
        const ssim = ssimMasked(lumaOf(held.view.image.rgba), lumaOf(re.rgba), re.mask, 320, 192);
        let dE = 0, n = 0;
        const des: number[] = [];
        for (let i = 0; i < 320 * 192; i++) {
            if (!re.mask[i]) continue;
            des.push(deltaE00(Colour.srgbToLab(re.rgba[i * 4], re.rgba[i * 4 + 1], re.rgba[i * 4 + 2]),
                Colour.srgbToLab(held.view.image.rgba[i * 4], held.view.image.rgba[i * 4 + 1], held.view.image.rgba[i * 4 + 2])));
            dE += des[des.length - 1]; n++;
        }
        des.sort((a, b) => a - b);
        expect(n).toBeGreaterThan(320 * 192 * 0.1);
        expect(ssim).toBeGreaterThanOrEqual(0.85);
        expect(des[des.length >> 1]).toBeLessThanOrEqual(6);
        // side by side: real held-out view | re-rendered bake
        const side = new Uint8Array(640 * 192 * 4);
        for (let y = 0; y < 192; y++) {
            side.set(held.view.image.rgba.subarray(y * 320 * 4, (y + 1) * 320 * 4), y * 640 * 4);
            side.set(re.rgba.subarray(y * 320 * 4, (y + 1) * 320 * 4), (y * 640 + 320) * 4);
        }
        savePng('heldout_real_vs_baked.png', 640, 192, side);
        expect(dE / n).toBeLessThan(6);
    });

    it('views with different exposure meet without a seam (dE <= 3) and land on the anchor exposure', async () => {
        const atlas = facadeAtlas(48);
        const gains = { 'pano-front': 1, 'pano-left': 1.25, 'pano-right': 0.65 }; // linear; no channel clips
        const res = await bake(rig([facadeRect()], { gains }), atlas);
        expect(res.report.maxSeamDeltaE).toBeLessThanOrEqual(3);
        expect(albedoError(res, atlas, facadeAlbedo).maxDE).toBeLessThanOrEqual(3);
        const g = Object.fromEntries(res.report.views.map((v) => [v.panoId, v.gain[1]]));
        expect(g['pano-front']).toBeCloseTo(1, 2);
        expect(g['pano-left']).toBeCloseTo(1 / 1.25, 1);
        expect(g['pano-right']).toBeCloseTo(1 / 0.65, 1);
        // the same views without exposure compensation do show the seam: the solve is what removes it
        const raw = await bake(rig([facadeRect()], { gains }), atlas, { exposure: false });
        expect(raw.report.maxSeamDeltaE).toBeGreaterThan(3);
    });

    it('the palette gate pulls a view whose exposure is far off the measured palette back onto it', async () => {
        const atlas = facadeAtlas(48);
        const front = rig([facadeRect()], { ids: ['pano-front'] })[0];
        // the face's palette: measured on the facade's own pixels (sky masked out), as the survey measures it per face
        const faceOnly = Uint8Array.from(front.view.image.rgba);
        for (let i = 0; i < front.depth.depthM.length; i++) if (!Number.isFinite(front.depth.depthM[i])) faceOnly[i * 4 + 3] = 0;
        const pal = measurePalette({ width: front.view.image.width, height: front.view.image.height, data: faceOnly });
        const paletteLab = pal.colours.map((c) => ({ lab: Colour.srgbToLab(c.srgb[0], c.srgb[1], c.srgb[2]) as Vec3, share: c.share }));
        const bright = rig([facadeRect()], { ids: ['pano-front'], gains: { 'pano-front': 0.55 } }); // -0.86 EV, nothing clips
        const ungated = await bake(bright, atlas);
        const gated = await bake(bright, atlas, {}, paletteLab);
        const gate = gated.report.views[0].paletteGate!;
        expect(gate.deltaEBefore).toBeGreaterThan(6);
        expect(gate.triggered).toBe(true);
        expect(gate.deltaEAfter).toBeLessThan(2);
        const eU = albedoError(ungated, atlas, facadeAlbedo), eG = albedoError(gated, atlas, facadeAlbedo);
        expect(eU.mean).toBeGreaterThan(15);
        expect(eG.mean).toBeLessThan(4);
        expect(Number.isFinite(gated.paletteDeltaE)).toBe(true);
        // a view within the gate is left alone
        const mild = await bake(rig([facadeRect()], { ids: ['pano-front'], gains: { 'pano-front': 0.95 } }), atlas, {}, paletteLab);
        expect(mild.report.views[0].paletteGate!.triggered).toBe(false);
        expect(mild.report.views[0].gain).toEqual([1, 1, 1]);
    });

    it('weights views by pose quality, and a pano set aside contributes nothing', async () => {
        const atlas = facadeAtlas(48);
        // the left view's image is real but its stated pose is 0.6 m off: a badly registered pano
        const views = rig([facadeRect(panelled)], { ids: ['pano-front', 'pano-left'] });
        const left = views[1].view;
        const offCam = { ...left.camera, eye: [left.camera.eye[0] + 0.6, left.camera.eye[1], left.camera.eye[2]] as Vec3 };
        const withQuality = async (q: number) => bake([views[0], { view: { ...left, camera: offCam, poseQuality: q }, depth: views[1].depth }], atlas, { bandSigmasTexels: [] });
        const good = albedoError(await withQuality(1), atlas, panelled);
        const low = albedoError(await withQuality(0.02), atlas, panelled);
        expect(low.mean).toBeLessThan(good.mean);
        const aside = await withQuality(0);
        expect(aside.report.views[1].samples).toBe(0);
        expect(aside.degradations.some((d) => d.reasonCode === 'pano_set_aside')).toBe(true);
        expect(aside.provenance.every((p) => !p.panoIds!.includes('pano-left'))).toBe(true);
        // weight grows with incidence: the frontal view alone is more confident than the oblique one alone on the same texel
        const t = 24 * 48 + 30;
        const f = await bake([views[0]], atlas), o = await bake([views[1]], atlas);
        expect(unpackConfidenceTexel(f.confidence, t).weight01).toBeGreaterThan(unpackConfidenceTexel(o.confidence, t).weight01);
    });

    it('excludes redaction rects: a smeared region comes from other views or stays uncovered', async () => {
        const atlas = facadeAtlas(48);
        const views = rig([facadeRect()]);
        const front = views[0].view;
        const rect: [number, number, number, number] = [60, 30, 100, 60];
        for (let y = rect[1]; y < rect[3]; y++) for (let x = rect[0]; x < rect[2]; x++) front.image.rgba.set([200, 30, 30], (y * 160 + x) * 4);
        front.redactionRects = [rect];
        const all = await bake(views, atlas);
        expect(albedoError(all, atlas, facadeAlbedo).max).toBeLessThanOrEqual(3);
        const alone = await bake([views[0]], atlas);
        let inside = 0;
        for (let t = 0; t < 48 * 48; t++) {
            const P = [atlas.texels.position[t * 3], atlas.texels.position[t * 3 + 1], atlas.texels.position[t * 3 + 2]];
            const d = [P[0] - front.camera.eye[0], P[1] - front.camera.eye[1], P[2] - front.camera.eye[2]];
            const z = d[0] * front.camera.fwd[0] + d[1] * front.camera.fwd[1] + d[2] * front.camera.fwd[2];
            const x = front.camera.cx + front.camera.fx * (d[0] * front.camera.right[0] + d[1] * front.camera.right[1] + d[2] * front.camera.right[2]) / z;
            const y = front.camera.cy - front.camera.fy * (d[0] * front.camera.up[0] + d[1] * front.camera.up[1] + d[2] * front.camera.up[2]) / z;
            if (x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3]) { inside++; expect(alone.albedo[t * 4 + 3]).toBe(0); }
        }
        expect(inside).toBeGreaterThan(20);
        expect(albedoError(alone, atlas, facadeAlbedo).max).toBeLessThanOrEqual(3);
    });

    it('labels every baked texel street-view-projection / photo-inferred with its pano ids, and is deterministic', async () => {
        const atlas = facadeAtlas(48);
        const occ = panel(4, 6, 0, 4, 1.0);
        const a = await bake(rig([facadeRect(), occ], { gains: { 'pano-left': 1.3 } }), atlas);
        const b = await bake(rig([facadeRect(), occ], { gains: { 'pano-left': 1.3 } }), atlas);
        expect(Buffer.from(a.albedo).equals(Buffer.from(b.albedo))).toBe(true);
        expect(Buffer.from(a.confidence.data).equals(Buffer.from(b.confidence.data))).toBe(true);
        expect(a.provenance).toEqual(b.provenance);
        expect(a.provenance.every((p) => p.source === 'street-view-projection' && p.label === 'photo-inferred' && p.panoIds!.length >= 1)).toBe(true);
        const counted = new Array(a.provenance.length).fill(0);
        for (let t = 0; t < 48 * 48; t++) {
            const c = unpackConfidenceTexel(a.confidence, t);
            expect(c.covered).toBe(a.albedo[t * 4 + 3] === 255);
            if (!c.covered) continue;
            counted[c.provenanceIndex]++;
            expect(c.rung).toBe(a.provenance[c.provenanceIndex].panoIds!.length >= 2 ? 0 : 1);
        }
        a.provenance.forEach((p, i) => expect(p.coverage).toBeCloseTo(counted[i] / a.report.coveredTexels, 6));
        const covered = a.provenance.reduce((s, p) => s + p.coverage, 0);
        expect(covered).toBeCloseTo(a.report.bakedTexels / a.report.coveredTexels, 6);
    });

    it('de-lights through the shared helpers: solar irradiance per view when its capture time is known, shadow lift after', async () => {
        const atlas = facadeAtlas(32);
        const views = rig([facadeRect()], { ids: ['pano-front'] });
        views[0].view.captureDate = '2024-06';
        const noTime = await bake(views, atlas, { delight: { latitude: 41.9, longitude: 12.48 } });
        expect(noTime.degradations.some((d) => d.reasonCode === 'capture_time_unknown')).toBe(true);
        expect(noTime.report.views[0].solarDelit).toBe(false);
        views[0].view.captureDate = '2024-06-12T15:30:00Z';
        const res = await bake(views, atlas, { delight: { latitude: 41.9, longitude: 12.48 } });
        expect(res.report.views[0].solarDelit).toBe(true);
        // one plane: E(n) is the same for every texel, so the solar step is neutral and the result is the shared lift of the truth
        const lifted = (u: number, v: number): Vec3 => {
            const g = facadeAlbedo(u, v).map((c) => SRGB_TO_LINEAR[Math.round(c)]) as Vec3;
            return delightLinearRgb(g[0], g[1], g[2]).map((c) => linearToSrgb255(c)) as Vec3;
        };
        expect(albedoError(res, atlas, lifted).max).toBeLessThanOrEqual(3);
        expect(albedoError(res, atlas, facadeAlbedo).max).toBeGreaterThan(5);
    });

    it('screenshot: baked atlas, confidence and a novel view of the textured facade', async () => {
        const atlas = facadeAtlas(160);
        const occ = panel(4, 6, 0, 4, 1.0);
        const res = await bake(rig([facadeRect(panelled), occ], { size: [320, 192], gains: { 'pano-left': 1.25, 'pano-right': 0.7 } }), atlas);
        const S = 160;
        // atlas | confidence (R: provenance entry hue, G: weight, B: rung) | ground truth
        const sheet = new Uint8Array(S * 3 * S * 4);
        for (let y = 0; y < S; y++) {
            for (let x = 0; x < S; x++) {
                const t = y * S + x, o = (y * S * 3 + x) * 4;
                if (res.albedo[t * 4 + 3] === 255) sheet.set(res.albedo.subarray(t * 4, t * 4 + 4), o);
                else sheet.set([255, 0, 255, 255], o);
                const c = unpackConfidenceTexel(res.confidence, t);
                sheet.set(c.covered ? [c.provenanceIndex * 60 % 256, Math.round(c.weight01 * 255), c.rung * 255, 255] : [0, 0, 0, 255], o + S * 4);
                const [u, v] = texelUv(atlas, t);
                const g = panelled(u, v);
                sheet.set([Math.round(g[0]), Math.round(g[1]), Math.round(g[2]), 255], o + 2 * S * 4);
            }
        }
        const p1 = savePng('baked_atlas_confidence_truth.png', S * 3, S, sheet);
        const novel = lookAtCamera([2, 4, -9], [5, 3, 0], 480, 288, 75);
        const re = renderBaked(novel, res, atlas);
        const p2 = savePng('textured_facade_novel_view.png', 480, 288, re.rgba);
        expect(fs.statSync(p1).size).toBeGreaterThan(1000);
        expect(fs.statSync(p2).size).toBeGreaterThan(1000);
        fs.writeFileSync(path.join(SHOTS, 'bake_report.json'), JSON.stringify({ ...res.report, views: res.report.views.map((v) => ({ id: v.panoId, n: v.samples, gain: v.gain.map((g) => +g.toFixed(3)) })) }));
        expect(res.report.p95SeamDeltaE).toBeLessThanOrEqual(3);
    });
});

describe('registered grounding views -> bake inputs', () => {
    /** A facade grid mesh (20 x 12 quads) plus the proud panel: the occluder the registration renders depth from. */
    function sceneMesh(): { vertices: number[]; indices: number[] } {
        const vertices: number[] = [], indices: number[] = [];
        const quadGrid = (o: Vec3, w: number, h: number, nx: number, ny: number) => {
            const base = vertices.length / 3;
            for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) vertices.push(o[0] + (w * i) / nx, o[1] + (h * j) / ny, o[2]);
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
                const a = base + j * (nx + 1) + i;
                indices.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1);
            }
        };
        quadGrid([0, 0, 0], FACADE.widthM, FACADE.heightM, 20, 12);
        quadGrid([4, 0, -1], 2, 4, 4, 8);
        return { vertices, indices };
    }

    it('decodes grounding JPEGs in memory, applies the pose correction, renders occluder depth with renderFrameDepth, and bakes', async () => {
        const occ = panel(4, 6, 0, 4, 1.0);
        const scene = [facadeRect(), occ];
        // nominal eyes are 0.5 m off; the registration's correction puts them back where the photos were taken
        const shots: Array<[string, Vec3, number]> = [['pano-a', [5, 1.7, -14], 180], ['pano-b', [-3, 1.7, -12], 146.3], ['pano-c', [13, 1.7, -12], 213.7]];
        const registration = {
            corrections: {}, setAside: [{ panoId: 'pano-c', reason: 'implausible shift', dxM: 6, dzM: 0, dyawDeg: 0, dpitchDeg: 0 }],
            perPano: [{ panoId: 'pano-a', dxM: 0.5, dzM: 0, dyawDeg: 0, dpitchDeg: 0, pairs: 12, beforeRmsM: 2, afterRmsM: 0.4 },
                { panoId: 'pano-b', dxM: 0.5, dzM: 0, dyawDeg: 0, dpitchDeg: 0, pairs: 9, beforeRmsM: 2, afterRmsM: 1.3 }],
            pairs: [], beforeRmsM: 2, afterRmsM: 0.9, used: 21, rejected: 0
        } as unknown as Registration;
        const views = shots.map(([panoId, eye, headingDeg]) => {
            const view: RegView = { panoId, eye: [eye[0] - 0.5, eye[1], eye[2]], headingDeg, pitchDeg: 4, fovDeg: 80, widthPx: 320, heightPx: 200,
                correction: { dx: 0.5, dy: 0, dz: 0, dyawDeg: 0, dpitchDeg: 0, drollDeg: 0 } };
            const { image } = render(castCamera(view), scene);
            const jpeg = new Uint8Array(jpegJs.encode({ width: image.width, height: image.height, data: Buffer.from(image.rgba) }, 95).data);
            return projectionViewFromRegistered({ view, jpeg, registration, captureDate: '2024-06' });
        });
        expect(views[0].camera.eye[0]).toBeCloseTo(5, 9);
        expect(views[0].poseQuality).toBeCloseTo(poseQualityFromResidual(0.4), 9);
        expect(views[1].poseQuality).toBeLessThan(views[0].poseQuality);
        expect(views[2].poseQuality).toBe(0);
        expect(views[0].poseSigmaPx).toBeCloseTo(views[0].camera.fx * 0.4, 6);
        const atlas = facadeAtlas(96);
        const res = await bakeStreetViewProjection({ atlas, views, depthFor: depthForMesh(sceneMesh()) });
        expect(res.degradations.some((d) => d.reasonCode === 'pano_set_aside' && d.reason.includes('pano-c'))).toBe(true);
        expect(res.provenance.every((p) => !p.panoIds!.includes('pano-c'))).toBe(true);
        const err = albedoError(res, atlas, facadeAlbedo);
        expect(err.n).toBeGreaterThan(96 * 96 * 0.5);
        expect(err.mean).toBeLessThan(1.5); // JPEG q95 round trip
        expect(err.max).toBeLessThanOrEqual(8);
        // nothing behind the panel is baked: texels the panel hides from both used views stay uncovered
        let hidden = 0;
        for (let t = 0; t < 96 * 96; t++) {
            const P: Vec3 = [atlas.texels.position[t * 3], atlas.texels.position[t * 3 + 1], atlas.texels.position[t * 3 + 2]];
            const hiddenFromAll = views.slice(0, 2).every((v) => {
                const cam = v.camera;
                const d: Vec3 = [P[0] - cam.eye[0], P[1] - cam.eye[1], P[2] - cam.eye[2]];
                const sp = (occ.origin[2] - cam.eye[2]) / d[2];
                const q = [cam.eye[0] + sp * d[0], cam.eye[1] + sp * d[1]];
                return q[0] >= 4 && q[0] <= 6 && q[1] >= 0 && q[1] <= 4;
            });
            if (!hiddenFromAll) continue;
            hidden++;
            expect(res.albedo[t * 4 + 3]).toBe(0);
        }
        expect(hidden).toBeGreaterThan(20);
    });
});
