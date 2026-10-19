/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E enhanced mode's guards on synthetic walls (no network, no model): the invention and erasure check of a redrawn
 * plate (a sharpened redraw passes; an added block, a painted-over dark bay and a large retoned area are flagged, reverted
 * with a feather, or reject the wall), and the Street View photo (a photo rendered through a pinhole camera rectified back
 * onto the wall, the best registered view chosen, the plate checked against it, the photo keeping what it shows), the
 * prompt's Street View wording, and enhanceWall sending the photo and labelling the texels with it.
 * Screenshots under test-results/screenshots/version_e/guards/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { auditPlate, cellMaskToPixels, revertRegions, MAX_FLAGGED_SHARE } from '../src/node/3d-engine/staged-location/pipeline-e/plate-audit';
import { bestStreetViewForWall, rectifyViewOntoWall, streetBandTop, verifyAgainstPhoto, type GuideView } from '../src/node/3d-engine/staged-location/pipeline-e/plate-streetview';
import { enhanceWall, guardPlate, type PlateRequest } from '../src/node/3d-engine/staged-location/pipeline-e/enhance';
import { buildTexturePlatePrompt } from '../src/browser/generative-canvas/services/location-beautify-service';
import type { MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import type { PinholeCamera } from '../src/common/spatial/texture-pass-contracts';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/version_e/guards');
const PX = 0.1;
const W = 300, H = 150; // 30 m x 15 m at 0.1 m
type Rgb = [number, number, number];
const BRICK: Rgb = [180, 120, 90];

/** A synthetic facade: brick, a window every 3 m across and 3.5 m up above a plain ground storey (3.5 m), plus `paint` overrides (metres from the bottom-left). */
function wall(paint: (xm: number, ym: number) => Rgb | undefined = () => undefined): Uint8Array {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xm = (x + 0.5) * PX, ym = (H - y - 0.5) * PX;
        let c: Rgb = BRICK;
        const lx = (xm % 3) / 3, ly = ((ym - 3.5) % 3.5) / 3.5;
        if (ym > 3.5 && lx > 0.3 && lx < 0.7 && ly > 0.2 && ly < 0.8) c = [45, 55, 75];
        c = paint(xm, ym) ?? c;
        rgba.set([...c, 255], (y * W + x) * 4);
    }
    return rgba;
}

/** A blurred, noisy copy (the scan's photo is soft). */
function soften(src: Uint8Array, r = 3, noise = 10, seed = 3): Uint8Array {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
    const out = new Uint8Array(src.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const acc = [0, 0, 0];
        let n = 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const xx = Math.max(0, Math.min(W - 1, x + dx)), yy = Math.max(0, Math.min(H - 1, y + dy));
            for (let c = 0; c < 3; c++) acc[c] += src[(yy * W + xx) * 4 + c];
            n++;
        }
        for (let c = 0; c < 3; c++) out[(y * W + x) * 4 + c] = Math.max(0, Math.min(255, Math.round(acc[c] / n + noise * rnd())));
        out[(y * W + x) * 4 + 3] = 255;
    }
    return out;
}

const all = () => new Uint8Array(W * H).fill(1);
const shot = (name: string, panels: Uint8Array[]) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const OW = panels.length * (W + 6), out = new Uint8Array(OW * H * 4);
    panels.forEach((p, j) => { for (let y = 0; y < H; y++) out.set(p.subarray(y * W * 4, (y + 1) * W * 4), (y * OW + j * (W + 6)) * 4); });
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    fs.writeFileSync(path.join(SHOTS, name), encodePng(OW, H, Buffer.from(out), 4));
};
/** Mean absolute RGB difference over the pixels `keep` marks. */
const mad = (a: Uint8Array, b: Uint8Array, keep: (x: number, y: number) => boolean) => {
    let s = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (keep(x, y)) { for (let c = 0; c < 3; c++) s += Math.abs(a[(y * W + x) * 4 + c] - b[(y * W + x) * 4 + c]); n += 3; }
    return s / Math.max(1, n);
};
const inBox = (x0: number, x1: number, y0: number, y1: number) => (x: number, y: number) => { const xm = (x + 0.5) * PX, ym = (H - y - 0.5) * PX; return xm >= x0 && xm < x1 && ym >= y0 && ym < y1; };

/** The wall as a massing face: the plane z = 0 facing +z, s along +x, t up, foot at y = 0. */
function face(): MassingFace {
    return {
        index: 7, key: 'w7', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true, normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0],
        sMin: 0, sMax: W * PX, tMin: 0, tMax: H * PX, tBottom: 0, area: W * H * PX * PX, pixel: PX, orthoSMin: 0, orthoTMax: H * PX, width: W, height: H, coverage: 1, openings: [], top: []
    } as MassingFace;
}

/** A street-level camera at (ex, 1.6, ez) looking at (tx, ty, 0), and the photo of `tex` (the wall) it takes, the sky grey. */
function photoOf(tex: Uint8Array, ex: number, ez: number, tx: number, ty: number, f = 700, IW = 960, IH = 640): { camera: PinholeCamera; image: { width: number; height: number; rgba: Uint8Array }; owner: Uint8Array } {
    const eye: [number, number, number] = [ex, 1.6, ez];
    const d = [tx - ex, ty - 1.6, -ez], l = Math.hypot(d[0], d[1], d[2]);
    const fwd: [number, number, number] = [d[0] / l, d[1] / l, d[2] / l];
    const r0 = [-fwd[2], 0, fwd[0]], rl = Math.hypot(r0[0], r0[2]);
    const right: [number, number, number] = [r0[0] / rl, 0, r0[2] / rl];
    const up: [number, number, number] = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const camera: PinholeCamera = { eye, right, up, fwd, fx: f, fy: f, cx: IW / 2, cy: IH / 2, width: IW, height: IH };
    const rgba = new Uint8Array(IW * IH * 4), owner = new Uint8Array(IW * IH);
    for (let v = 0; v < IH; v++) for (let u = 0; u < IW; u++) {
        const a = (u + 0.5 - camera.cx) / f, b = (camera.cy - v - 0.5) / f;
        const dir = [fwd[0] + a * right[0] + b * up[0], fwd[1] + a * right[1] + b * up[1], fwd[2] + a * right[2] + b * up[2]];
        const o = (v * IW + u) * 4;
        rgba.set([150, 160, 175, 255], o);
        if (dir[2] >= -1e-6) continue;
        const k = -eye[2] / dir[2], px = eye[0] + k * dir[0], py = eye[1] + k * dir[1];
        const x = Math.floor(px / PX), y = Math.floor(H - py / PX);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        rgba.set(tex.subarray((y * W + x) * 4, (y * W + x) * 4 + 3), o);
        owner[v * IW + u] = 1;
    }
    return { camera, image: { width: IW, height: IH, rgba }, owner };
}

const guide = (p: ReturnType<typeof photoOf>, panoId: string, method = 'joint'): GuideView => ({ panoId, camera: p.camera, image: p.image, ownerMask: p.owner, poseQuality: 1, poseSigmaPx: 1, registration: { method, residualM: 0.2 } });

describe('enhanced mode: the invention and erasure check', () => {
    it('passes a sharper redraw of the same facade', () => {
        const truth = wall();
        const a = auditPlate(soften(truth), truth, W, H, all(), PX);
        expect(a.regions).toEqual([]);
        expect(a.reject).toBe(false);
    });

    it('keeps finer detail drawn over ordinary wall, and reverts, feathered, a block that replaces a distinct element', () => {
        // the input's ground storey: plain brick, and a distinct grey stone base under the right half
        const stone = (xm: number, ym: number): Rgb | undefined => (xm > 18 && xm < 30 && ym < 3.2 ? [150, 150, 145] : undefined);
        const input = soften(wall(stone));
        // the plate draws rusticated coursing on the plain brick (finer detail in the same material) and a glazed front with
        // mullions on the stone base (replacing it)
        const coursing = (xm: number, ym: number): Rgb | undefined => (ym < 3.2 && xm > 3 && xm < 12 ? ((ym % 0.45) < 0.1 || ((xm + (Math.floor(ym / 0.45) % 2) * 0.45) % 0.9) < 0.08 ? [120, 78, 58] : [190, 128, 96]) : undefined);
        const glazed = (xm: number, ym: number): Rgb | undefined => (ym < 3.2 && xm > 19 && xm < 29 ? ((xm % 1.2) < 0.15 || (ym % 1.6) < 0.15 ? [235, 235, 230] : [30, 40, 55]) : undefined);
        const plate = wall((x, y) => coursing(x, y) ?? glazed(x, y) ?? stone(x, y));
        const a = auditPlate(input, plate, W, H, all(), PX);
        expect(a.inventedDetailM2).toBeGreaterThan(5);
        const onStone = a.regions.filter(r => r.box[0] * PX >= 17).reduce((t, r) => t + r.areaM2, 0);
        const onBrick = a.regions.filter(r => r.box[2] * PX <= 13).reduce((t, r) => t + r.areaM2, 0);
        expect(onStone).toBeGreaterThan(15);
        expect(onBrick).toBe(0);
        const { rgba, weight } = revertRegions(input, plate, W, H, cellMaskToPixels(a.flagged, a.grid, W, H), PX);
        // the stone is back; the coursing on the brick and the wall above are the plate's; the blend is gradual at the edge
        expect(mad(rgba, input, inBox(20.5, 27.5, 0.5, 2.5))).toBeLessThan(2);
        expect(mad(rgba, plate, inBox(4, 11, 0.5, 2.5))).toBe(0);
        expect(mad(rgba, plate, inBox(2, 15, 6, 14))).toBe(0);
        const ramp = Array.from(weight).filter(w => w > 0.05 && w < 0.95).length;
        expect(ramp).toBeGreaterThan(50);
        shot('audit_detail_kept_element_reverted.png', [input, plate, rgba]);
    });

    it('flags a dark bay the plate painted over as wall and windows', () => {
        // the input: a dark recessed bay with diagonal stairs, 4 m wide, the full height above the ground storey
        const bay = (xm: number, ym: number): Rgb | undefined => (xm > 12 && xm < 16 && ym > 1 ? (((xm + ym) % 1.4) < 0.25 ? [95, 95, 100] : [28, 30, 34]) : undefined);
        const input = soften(wall(bay));
        const plate = wall();
        const a = auditPlate(input, plate, W, H, all(), PX);
        const covered = a.regions.filter(r => r.box[0] * PX < 16 && r.box[2] * PX > 12).reduce((s, r) => s + r.areaM2, 0);
        expect(covered).toBeGreaterThan(0.5 * 4 * 14);
        const g = guardPlate(input, plate, W, H, all(), PX);
        expect(g.reject).toBe(false);
        expect(mad(g.rgba, input, inBox(12.8, 15.2, 3, 14))).toBeLessThan(3);
        shot('audit_erased_bay.png', [input, plate, g.rgba]);
    });

    it('rejects the whole wall when the flagged area is too large', async () => {
        const input = soften(wall());
        // the left half of the wall repainted a cold grey: the windows stay, the material does not
        const plate = wall((xm, ym) => (xm < 16 && !(ym > 3.5 && ((xm % 3) / 3) > 0.3 && ((xm % 3) / 3) < 0.7 && (((ym - 3.5) % 3.5) / 3.5) > 0.2 && (((ym - 3.5) % 3.5) / 3.5) < 0.8) ? [128, 134, 142] : undefined));
        const g = guardPlate(input, plate, W, H, all(), PX);
        expect(g.audit.flaggedShare).toBeGreaterThan(MAX_FLAGGED_SHARE);
        expect(g.reject).toBe(true);
        // enhanceWall: the same answer through a model client is accepted by the alignment gate alone, and rejected with the guards
        const client = async (r: PlateRequest) => ({ bytes: new Uint8Array(encodePng(r.width, r.height, Buffer.from(padTo(plate, r.width, r.height)), 4)), modelUsed: 'fake' });
        const mk = () => ({ width: W, height: H, rgba: input.slice(), source: new Uint8Array(W * H) });
        const off = await enhanceWall(face(), mk(), all(), { client, models: ['fake'], locationName: 'X', source: 3, guards: false });
        expect(off.accepted).toBe(true);
        const t = mk();
        const on = await enhanceWall(face(), t, all(), { client, models: ['fake'], locationName: 'X', source: 3 });
        expect(on.accepted).toBe(false);
        expect(on.audit!.flaggedShare).toBeGreaterThan(MAX_FLAGGED_SHARE);
        expect(Array.from(t.source).every(v => v === 0)).toBe(true);
    });
});

/** The plate placed in the model's padded frame as padToModelAspect centres it (W x H inside w x h, grey around). */
function padTo(plate: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4).fill(128);
    const ox = Math.floor((w - W) / 2), oy = Math.floor((h - H) / 2);
    for (let y = 0; y < H; y++) out.set(plate.subarray(y * W * 4, (y + 1) * W * 4), ((y + oy) * w + ox) * 4);
    return out;
}

describe('enhanced mode: the Street View photo', () => {
    it('rectifies a photo back onto the wall through its pose', () => {
        const truth = wall((xm, ym) => (xm > 10 && xm < 14 && ym < 3 ? [30, 35, 40] : undefined));
        const p = photoOf(truth, 12, 14, 12, 4);
        const rect = rectifyViewOntoWall(face(), guide(p, 'pano-a'));
        expect(rect.bandCover).toBeGreaterThan(0.4);
        let s = 0, n = 0;
        for (let i = 0; i < W * H; i++) if (rect.valid[i]) { for (let c = 0; c < 3; c++) s += Math.abs(rect.rgba[i * 4 + c] - truth[i * 4 + c]); n += 3; }
        expect(n).toBeGreaterThan(0);
        expect(s / n).toBeLessThan(12);
        shot('streetview_rectified.png', [truth, rect.rgba]);
    });

    it('picks the registered view that sees the street-level band, never a nominal pose', () => {
        const truth = wall();
        const near = photoOf(truth, 12, 14, 12, 4), far = photoOf(truth, 40, 30, 28, 4), away = photoOf(truth, 12, 14, 60, 4);
        const pick = bestStreetViewForWall(face(), [guide(near, 'nominal-near', 'nominal'), guide(far, 'far'), guide(away, 'away'), guide(near, 'near')]);
        expect(pick.view?.panoId).toBe('near');
        expect(bestStreetViewForWall(face(), [guide(near, 'only-nominal', 'nominal')]).view).toBeUndefined();
    });

    it('flags where the plate contradicts the photo and keeps what the photo shows', () => {
        // the real wall: a dark bay at street level and a glazed front the scan smeared flat
        const realFront = (xm: number, ym: number): Rgb | undefined => (xm > 18 && xm < 27 && ym < 3.2 ? ((xm % 1.5) < 0.2 ? [225, 225, 220] : [35, 45, 60]) : undefined);
        const realBay = (xm: number, ym: number): Rgb | undefined => (xm > 6 && xm < 10 && ym < 7 ? (((xm + ym) % 1.4) < 0.25 ? [95, 95, 100] : [28, 30, 34]) : undefined);
        const truth = wall((x, y) => realBay(x, y) ?? realFront(x, y));
        const input = soften(wall((x, y) => realBay(x, y) ?? (x > 18 && x < 27 && y < 3.2 ? [120, 100, 90] : undefined)), 4);
        // the plate paints the bay over with brick and window, and draws the front the photo shows
        const plate = wall(realFront);
        const p = photoOf(truth, 15, 14, 15, 3);
        const f = face();
        const rect = rectifyViewOntoWall(f, guide(p, 'pano-b'));
        const check = verifyAgainstPhoto(input, plate, rect, W, H, all(), PX, streetBandTop(f));
        const g = check.grid;
        const cellsIn = (x0: number, x1: number, y0: number, y1: number, v: string) => check.verdict.filter((x, k) => x === v && inBox(x0, x1, y0, y1)((k % g.cw) * g.cellPx + 1, Math.floor(k / g.cw) * g.cellPx + 1)).length;
        expect(cellsIn(6, 10, 0, 7, 'contradicts-photo')).toBeGreaterThan(10);
        expect(cellsIn(18, 27, 0, 3.2, 'contradicts-photo')).toBe(0);
        // merged with the tile check: the front (unsupported by the soft tile) is kept because the photo shows it; the bay reverts
        const tileOnly = guardPlate(input, plate, W, H, all(), PX);
        const merged = guardPlate(input, plate, W, H, all(), PX, { rect, bandTop: streetBandTop(f) });
        expect(merged.audit.photoKeptM2).toBeGreaterThan(5);
        expect(mad(merged.rgba, plate, inBox(19, 26, 0.5, 2.8))).toBeLessThan(mad(tileOnly.rgba, plate, inBox(19, 26, 0.5, 2.8)));
        expect(mad(merged.rgba, input, inBox(6.8, 9.2, 1, 6))).toBeLessThan(4);
        expect(merged.labels.some(l => l === 'contradicts-photo')).toBe(true);
        shot('streetview_check.png', [input, plate, rect.rgba, merged.rgba]);
    });

    it('asks the model with the photo and labels the texels with the pano', async () => {
        const truth = wall();
        const input = soften(truth);
        const p = photoOf(truth, 12, 14, 12, 4);
        const f = face();
        const view = guide(p, 'pano-c');
        const rect = rectifyViewOntoWall(f, view);
        let seen: PlateRequest | undefined;
        const client = async (r: PlateRequest) => { seen = r; return { bytes: new Uint8Array(encodePng(r.width, r.height, Buffer.from(padTo(truth, r.width, r.height)), 4)), modelUsed: 'fake' }; };
        const t = { width: W, height: H, rgba: input.slice(), source: new Uint8Array(W * H) };
        const crop = new Uint8Array([1, 2, 3]);
        const r = await enhanceWall(f, t, all(), { client, models: ['fake'], locationName: 'X', source: 3, streetView: { view, rect, crop, why: 'test' }, streetViewSource: 9 });
        expect(r.accepted).toBe(true);
        expect(seen?.streetView).toBe(crop);
        expect(seen?.prompt).toMatch(/street-level photograph of this same wall/);
        expect(r.streetView?.panoId).toBe('pano-c');
        expect(r.streetView?.comparedCells).toBeGreaterThan(0);
        expect(Array.from(t.source).filter(v => v === 9).length).toBeGreaterThan(0.9 * W * H);
    });

    it('redraws once without the photo when the photo-guided redraw moves the wall\'s geometry', async () => {
        const truth = wall();
        const input = soften(truth);
        const f = face();
        const view = guide(photoOf(truth, 12, 14, 12, 4), 'pano-d');
        const rect = rectifyViewOntoWall(f, view);
        // with the photo the model answers a facade whose windows sit half a bay along; without it, the facade in place
        const moved = wall((xm, ym) => { const lx = ((xm + 1.5) % 3) / 3, ly = ((ym - 3.5) % 3.5) / 3.5; return ym > 3.5 ? (lx > 0.3 && lx < 0.7 && ly > 0.2 && ly < 0.8 ? [45, 55, 75] : BRICK) : undefined; });
        const asked: boolean[] = [];
        const client = async (r: PlateRequest) => { asked.push(!!r.streetView); return { bytes: new Uint8Array(encodePng(r.width, r.height, Buffer.from(padTo(r.streetView ? moved : truth, r.width, r.height)), 4)), modelUsed: 'fake' }; };
        const t = { width: W, height: H, rgba: input.slice(), source: new Uint8Array(W * H) };
        const r = await enhanceWall(f, t, all(), { client, models: ['fake'], locationName: 'X', source: 3, streetView: { view, rect, crop: new Uint8Array(1), why: 'test' }, streetViewSource: 9 });
        expect(asked).toEqual([true, false]);
        expect(r.accepted).toBe(true);
        expect(r.streetView?.guidedRejected).toMatch(/edge chamfer/);
        expect(Array.from(t.source).filter(v => v === 3).length).toBeGreaterThan(0.9 * W * H);
        expect(Array.from(t.source).some(v => v === 9)).toBe(false);
    });

    it('caches the answer per wall by everything sent, so a rebuild gets the same plate', async () => {
        const { cachedPlate, plateCacheKey } = await import('../src/node/3d-engine/staged-location/pipeline-e/enhance');
        const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'plates-'));
        let calls = 0;
        const client = async () => { calls++; return { bytes: new Uint8Array([calls, 2, 3]), modelUsed: 'm' }; };
        const req = { prompt: 'p', image: new Uint8Array([1]), width: 4, height: 4, models: ['m'] };
        const a = await cachedPlate(dir, req, client), b = await cachedPlate(dir, { ...req }, client);
        expect(calls).toBe(1);
        expect(Array.from(b.bytes)).toEqual(Array.from(a.bytes));
        expect((b as { cached?: boolean }).cached).toBe(true);
        // anything sent differently is another key: the image, a reference, the photo, the prompt
        const keys = new Set([req, { ...req, image: new Uint8Array([2]) }, { ...req, reference: new Uint8Array([1]) }, { ...req, streetView: new Uint8Array([1]) }, { ...req, prompt: 'q' }].map(plateCacheKey));
        expect(keys.size).toBe(5);
        await cachedPlate(dir, { ...req, prompt: 'q' }, client);
        expect(calls).toBe(2);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('makes enhanced appearance the default within pipeline E, with the real-data view as the opt-out', async () => {
        const { stagedEnhance } = await import('../src/node/3d-engine/staged-location/pipeline-e/enhance');
        expect(stagedEnhance({} as NodeJS.ProcessEnv)).toBe(true);
        expect(stagedEnhance({ SCRATCHBOX_STAGED_ENHANCE: '0' } as NodeJS.ProcessEnv)).toBe(false);
        const { stagedPipelineE } = await import('../src/node/3d-engine/staged-location/pipeline-e/pipeline-e');
        expect(stagedPipelineE({} as NodeJS.ProcessEnv)).toBe(false);
    });

    it('aims a street-level view of the same pano at the lower storeys', async () => {
        const { streetLevelView, STREET_LEVEL_AIM_M } = await import('../src/node/3d-engine/staged-location/streetview-registered-views');
        const faceT = { faceId: 'f', headingDeg: 180, centre: [0, 15, 0], outward: [0, 0, 1], widthM: 30, heightM: 30 } as never;
        const v = { faceId: 'f', panoId: 'p', eye: [0, 2.5, 20], headingDeg: 180, pitchDeg: 33, fovDeg: 60, aspectRatio: 'RATIO_4X3', distanceM: 24, facadeHeadingDeg: 0, score: 1, aimedSlotIds: [], coveredSlotIds: [] } as never;
        const low = streetLevelView(v, faceT, 0);
        expect(low.panoId).toBe('p');
        expect(low.headingDeg).toBe(180);
        expect(low.pitchDeg).toBeCloseTo((Math.atan2(STREET_LEVEL_AIM_M - 2.5, 20) * 180) / Math.PI, 1);
        expect(low.pitchDeg).toBeLessThan(10);
    });

    it('adds the Street View wording to the plate prompt only when a photo is sent', () => {
        const o = { locationName: 'X', widthM: 20, heightM: 10, widthPx: 400, heightPx: 200, preserveClause: 'Keep it.', withReference: true };
        const plain = buildTexturePlatePrompt(o), sv = buildTexturePlatePrompt({ ...o, withStreetView: true });
        expect(plain).not.toMatch(/street-level/);
        expect(sv.startsWith(plain)).toBe(true);
        expect(sv).toMatch(/The third image is a street-level photograph of this same wall/);
        expect(sv).toMatch(/keep the geometry of the first image/);
        expect(buildTexturePlatePrompt({ ...o, withReference: false, withStreetView: true })).toMatch(/The second image is a street-level photograph/);
    });
});
