/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What the K-free twin infers from Google's data before its second pass (measured-twin.ts `infer`). The first pass
 * writes each wall's own photo, rendered from the cut-out scan's texture, as an orthos folder in pipeline K's frame
 * (facades.json); from it:
 *   1. the building's window system, read by the vision model from all the walls on one sheet (building-system.ts),
 *      laid on every wall where its photo shows it (window-array.ts), each wall's own photo deciding (photo-inferred);
 *   2. windows on a wall the array left empty copied from a congruent wall (the same tier, height and length): the
 *      building's repetition (generated);
 *   3. the depth of the window columns behind the piers is measured by the generator from the scan (param piers);
 *   4. each appearance class's finish (roughness, metalness) read by the vision model from its patches
 *      (material-finish.ts), confident readings drawn as read, the rest matte or, inside the openings, smooth glass;
 *   5. the street-level band of each wall from registered Street View plates: each texel the plates that see it
 *      (depth-tested, incidence-weighted), toned to the scan photo's own colour (photo-inferred);
 *   7. the walls' relief: an image model's height map of each large wall's photo, kept only where its edges line up with
 *      the photo's, drawn as a normal map, never moving the surface (generated).
 * Item 6 (thin elements) is the generator's: the slender top's narrow sections are turned exact circles.
 * Numbers and fields only: nothing here routes on a name of what the building is.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../../../texture-processing';
import { encodePng } from '../png-encode';
import { readBuildingSystem, type BuildingSystem } from '../pipeline-k/building-system';
import type { FacadeAsk } from '../pipeline-k/facade-reader';
import { FACADE_READER_MODEL_KEY } from '../pipeline-k/facade-reader';
import type { NamedBuilding } from '../pipeline-k/facade-reader-brief';
import { drawnMetalness, drawnRoughness, finishPrompt, parseClassFinish, settleFinishes, type ClassFinish } from '../pipeline-k/material-finish';
import { readingKey, type ModelReadingStore } from '../pipeline-k/model-readings';
import { inferWindowArrays, type WindowArrayReport } from '../pipeline-k/window-array';
import type { WindowFitFile, WindowRect } from '../window-fit';
import { plateRecordCamera, projectToFrame, decodeImageToRgba, PLATE_EMPTY_DEPTH } from '../../../spatial/StreetViewPoseRegistrar';

export const INFER_VERSION = 'measured-twin-infer/1';

export const INFER_PARAMS = {
    /** Windows copied to a wall the array left empty from one within these of its tier's height range and length (m, share). */
    congruentHeightM: 1.0, congruentLengthShare: 0.03,
    /** The street-level band: up to this height above the street, at this pixel (m). */
    baseTopM: 18, basePixelM: 0.05,
    /** A plate texel: seen at least this squarely (cosine), resolving at least this finely (m per plate pixel), within this depth of the plate's own depth (m + share). */
    baseMinCos: 0.3, baseMaxMetresPerPx: 0.12, baseDepthTolM: 0.6, baseDepthTolShare: 0.03,
    /** Appearance classes: inside the openings, outside them; a finish read with this confidence or more is drawn as read. */
    classesIn: 2, classesOut: 4, finishMinConf: 50,
    /** Relief: the largest walls with windows (at most), each split into chunks of at most this aspect, the answer kept when its edges correlate with the photo's at least this much, at most this deep (m). */
    reliefFaces: 12, reliefMaxAspect: 2.0, reliefMinEdgeCorr: 0.25, reliefDepthM: 0.08
} as const;

type V3 = [number, number, number];
interface SelfFrame { facadeId: number; kind: string; image: string; uncoveredMask: string; width: number; height: number; pixel: number; coverage: number; centroid: V3; normal: V3; axisS: V3; axisT: V3; orthoSMin: number; orthoTMax: number; tMin: number; tMax: number; tier: number; lengthM: number; h0: number; h1: number }

/** The vision and image models the inference asks (none: those steps are skipped, each with its reason). */
export interface InferModels {
    /** A vision model's JSON answer to images and a prompt. */
    text(images: Buffer[], prompt: string): Promise<string>;
    /** An image model's picture for an image and a prompt (PNG or JPEG bytes), or undefined when it drew none. */
    image?(png: Buffer, prompt: string, aspect: string): Promise<Buffer | undefined>;
}

/** Registered Street View plates (StreetViewPoseRegistrar's plates.json) and where their frame's origin lies in the run's (m: east, up, south). */
export interface StreetViewSource { platesFile: string; offset: V3 }

export interface InferReport {
    version: string;
    walls: number;
    system?: { conf: number; patterns: number; regions: number; reused: boolean } | { reason: string };
    windows: { arrayed: number; walls: number; copied: number; copiedWalls: number; array?: Pick<WindowArrayReport, 'building'> };
    base?: { faces: number; texels: number; plates: number } | { reason: string };
    classes?: { count: number; read: number; finishes: Array<{ lab: V3; openings: boolean; roughness: number; metalness: number; conf: number; seen?: string }> } | { reason: string };
    relief?: { faces: number; chunks: number; kept: number; rejected: number } | { reason: string };
    calls: { text: number; image: number };
    ms: number;
}

export interface InferredInputs {
    groundY: number;
    planes: Array<{ facadeId: number; image: string; centroid: V3; normal: V3; axisS: V3; axisT: V3; orthoSMin: number; orthoTMax: number; pixel: number; width: number; height: number }>;
    windowFit: Array<{ facadeId: number; width: number; height: number; rects: Array<[number, number, number, number]>; panes?: Array<[number, number, number, number]>; generated?: Array<[number, number, number, number]> }>;
    photos: Record<number, { image: string; mask?: string }>;
    classes: Array<{ index: number; meanLab: V3; openings?: boolean; set?: string; finish?: { roughness?: number; metallic?: number } }>;
    base: Array<{ id: number; png: string; pixel: number; topM: number }>;
    height: Array<{ id: number; png: string; depthM: number }>;
    report: InferReport;
}

// --- colour helpers (sRGB 8-bit <-> linear, CIELAB D65)
const toLin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const toS8 = (c: number) => { c = Math.max(0, Math.min(1, c)); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); };
function labOfLin(r: number, g: number, b: number): V3 {
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(X), fy = f(Y), fz = f(Z);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** The vision model as K's facade reader asks it (one call a sheet). */
function facadeAskOf(m: InferModels, tally: { text: number }): FacadeAsk {
    return async (png, prompt) => { tally.text++; return m.text(Array.isArray(png) ? png : [png], prompt); };
}

/** Deterministic k-means in CIELAB (k colours, seeded by lightness quantiles). */
function kmeans(pts: V3[], k: number): { centres: V3[]; label: Int32Array } {
    const label = new Int32Array(pts.length);
    if (pts.length === 0) return { centres: [], label };
    const byL = pts.map((p, i) => [p[0], i] as const).sort((a, b) => a[0] - b[0]);
    let centres: V3[] = Array.from({ length: k }, (_, j) => [...pts[byL[Math.min(pts.length - 1, Math.floor(((j + 0.5) / k) * pts.length))][1]]] as V3);
    for (let it = 0; it < 12; it++) {
        const sum = centres.map(() => [0, 0, 0, 0]);
        for (let i = 0; i < pts.length; i++) {
            let best = 0, bd = Infinity;
            for (let j = 0; j < centres.length; j++) { const c = centres[j]; const d = (pts[i][0] - c[0]) ** 2 + (pts[i][1] - c[1]) ** 2 + (pts[i][2] - c[2]) ** 2; if (d < bd) { bd = d; best = j; } }
            label[i] = best; const s = sum[best]; s[0] += pts[i][0]; s[1] += pts[i][1]; s[2] += pts[i][2]; s[3]++;
        }
        centres = centres.map((c, j) => (sum[j][3] ? [sum[j][0] / sum[j][3], sum[j][1] / sum[j][3], sum[j][2] / sum[j][3]] : c) as V3);
    }
    return { centres, label };
}

/** Bilinear resample of an RGBA image to w x h (one channel out: its luminance), for edge comparisons. */
function lumaResampled(img: { width: number; height: number; rgba: Uint8Array | Buffer }, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, Math.floor(((x + 0.5) / w) * img.width)), sy = Math.min(img.height - 1, Math.floor(((y + 0.5) / h) * img.height));
        const o = (sy * img.width + sx) * 4;
        out[y * w + x] = 0.299 * img.rgba[o] + 0.587 * img.rgba[o + 1] + 0.114 * img.rgba[o + 2];
    }
    return out;
}
function gradMag(L: Float32Array, w: number, h: number): Float32Array {
    const g = new Float32Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) g[y * w + x] = Math.hypot(L[y * w + x + 1] - L[y * w + x - 1], L[(y + 1) * w + x] - L[(y - 1) * w + x]);
    return g;
}
function ncc(a: Float32Array, b: Float32Array, valid?: Uint8Array): number {
    let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
    for (let i = 0; i < a.length; i++) { if (valid && !valid[i]) continue; sa += a[i]; sb += b[i]; saa += a[i] * a[i]; sbb += b[i] * b[i]; sab += a[i] * b[i]; n++; }
    if (n < 50) return 0;
    const cov = sab / n - (sa / n) * (sb / n), va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
    return va > 1e-9 && vb > 1e-9 ? cov / Math.sqrt(va * vb) : 0;
}

/**
 * Infers the second pass's inputs from the first pass's orthos folder `dir` (facades.json and each wall's photo).
 * Every step that needs a model or Street View is skipped, with its reason, when that is not given.
 */
export async function inferFromSelfOrthos(dir: string, opts: { models?: InferModels; store?: ModelReadingStore; building?: NamedBuilding; streetView?: StreetViewSource; signal?: AbortSignal; P?: typeof INFER_PARAMS } = {}): Promise<InferredInputs> {
    const t0 = Date.now(), P = opts.P ?? INFER_PARAMS;
    const calls = { text: 0, image: 0 };
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'facades.json'), 'utf8')) as { groundY: number; facades: SelfFrame[] };
    const frames = file.facades.filter(f => fs.existsSync(path.join(dir, f.image)));
    const report: InferReport = { version: INFER_VERSION, walls: frames.length, windows: { arrayed: 0, walls: 0, copied: 0, copiedWalls: 0 }, calls, ms: 0 };
    const photo = new Map<number, { width: number; height: number; rgba: Uint8Array | Buffer }>();
    const photoOf = (f: SelfFrame) => { let p = photo.get(f.facadeId); if (!p) { p = decodePng(fs.readFileSync(path.join(dir, f.image))); photo.set(f.facadeId, p); } return p; };
    const coveredAt = (f: SelfFrame, x: number, y: number) => { const p = photoOf(f), o = (y * p.width + x) * 4; return !(p.rgba[o] === 128 && p.rgba[o + 1] === 128 && p.rgba[o + 2] === 128); };

    // 1. the building's system, then each wall's array
    let system: BuildingSystem | undefined;
    if (opts.models) {
        try {
            const bs = await readBuildingSystem(dir, facadeAskOf(opts.models, calls), { ...(opts.building ? { building: opts.building } : {}), ...(opts.store ? { readings: { store: opts.store, model: FACADE_READER_MODEL_KEY } } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
            system = bs.system;
            report.system = bs.system ? { conf: bs.system.conf, patterns: bs.system.patterns.length, regions: bs.system.regions.length, reused: bs.system.reused } : { reason: bs.reason ?? 'no answer' };
        } catch (err) { report.system = { reason: `the system read failed: ${err instanceof Error ? err.message : String(err)}` }; }
    } else report.system = { reason: 'no vision model' };
    const fit: WindowFitFile = { version: INFER_VERSION, params: {} as WindowFitFile['params'], ms: 0, facades: frames.map(f => ({ facadeId: f.facadeId, width: f.width, height: f.height, rects: [] as WindowRect[], bands: [], ms: 0 })) };
    const top = Math.max(...frames.map(f => f.h1)) + file.groundY;
    const wa = inferWindowArrays(dir, fit, undefined, { envelopeTopY: top, ...(system ? { system } : {}) });
    if (wa.building) report.windows.array = { building: wa.building };
    type Entry = { facadeId: number; width: number; height: number; rects: WindowRect[]; panes?: WindowRect[]; generated?: WindowRect[] };
    const entries = new Map<number, Entry>();
    for (const e of fit.facades) if (!('error' in e)) entries.set(e.facadeId, e as Entry);
    for (const e of entries.values()) if (e.rects.length) { report.windows.arrayed += e.rects.length; report.windows.walls++; }

    // 2. a wall the array left empty takes a congruent wall's windows (the building's repetition: generated)
    for (const f of frames) {
        const e = entries.get(f.facadeId);
        if (!e || e.rects.length || f.lengthM < 4) continue;
        const donor = frames.filter(g => g.facadeId !== f.facadeId && (entries.get(g.facadeId)?.rects.length ?? 0) > 0 && Math.abs(g.h0 - f.h0) <= P.congruentHeightM && Math.abs(g.h1 - f.h1) <= P.congruentHeightM && Math.abs(g.lengthM - f.lengthM) <= P.congruentLengthShare * f.lengthM && Math.abs(g.pixel - f.pixel) < 1e-6)
            .sort((a, b) => (entries.get(b.facadeId)!.rects.length - entries.get(a.facadeId)!.rects.length) || b.coverage - a.coverage)[0];
        if (!donor) continue;
        const d = entries.get(donor.facadeId)!, sx = f.width / d.width, sy = f.height / d.height;
        const map = (r: WindowRect): WindowRect => [r[0] * sx, r[1] * sy, r[2] * sx, r[3] * sy] as WindowRect;
        e.rects = d.rects.map(map); e.panes = (d.panes ?? []).map(map); e.generated = e.rects.slice();
        report.windows.copied += e.rects.length; report.windows.copiedWalls++;
    }

    // 4. appearance classes and their finishes
    const classes: InferredInputs['classes'] = [];
    {
        const inside: V3[] = [], outside: V3[] = [], patches: Array<{ lab: V3; f: SelfFrame; x: number; y: number; in: boolean }> = [];
        for (const f of frames) {
            const p = photoOf(f), e = entries.get(f.facadeId);
            const inWin = new Uint8Array(p.width * p.height);
            for (const r of e?.rects ?? []) for (let y = Math.max(0, Math.floor(r[1])); y < Math.min(p.height, Math.ceil(r[3])); y++) for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(p.width, Math.ceil(r[2])); x++) inWin[y * p.width + x] = 1;
            for (let y = 0; y < p.height; y += 3) for (let x = 0; x < p.width; x += 3) {
                if (!coveredAt(f, x, y)) continue;
                const o = (y * p.width + x) * 4, lab = labOfLin(toLin(p.rgba[o]), toLin(p.rgba[o + 1]), toLin(p.rgba[o + 2]));
                (inWin[y * p.width + x] ? inside : outside).push(lab);
                if ((x + y) % 36 === 0) patches.push({ lab, f, x, y, in: !!inWin[y * p.width + x] });
            }
        }
        const kin = kmeans(inside, inside.length > 100 ? P.classesIn : 0), kout = kmeans(outside, P.classesOut);
        const all = [...kout.centres.map(c => ({ c, openings: false })), ...kin.centres.map(c => ({ c, openings: true }))];
        const shareOf = (j: number, open: boolean) => { const lab = open ? kin.label : kout.label; let n = 0; for (let i = 0; i < lab.length; i++) if (lab[i] === j) n++; return n / Math.max(1, inside.length + outside.length); };
        const rows = all.map((a, k) => ({ meanLab: a.c, share: shareOf(a.openings ? k - kout.centres.length : k, a.openings), wall: !a.openings && k === kout.centres.reduce((bi, c, j) => (c[0] > kout.centres[bi][0] ? j : bi), 0), openings: a.openings }));
        let finishes: Array<ClassFinish | undefined> = all.map(() => undefined);
        if (opts.models && all.length) {
            // the swatch sheet: each row eight 48 px patches of the walls' photo where its class lies nearest
            const PW = 48, N = 8, W = PW * N, H = PW * all.length, sheet = new Uint8Array(W * H * 3).fill(255);
            all.forEach((a, k) => {
                const near = patches.filter(q => q.in === a.openings).map(q => ({ q, d: (q.lab[0] - a.c[0]) ** 2 + (q.lab[1] - a.c[1]) ** 2 + (q.lab[2] - a.c[2]) ** 2 })).sort((x, y) => x.d - y.d).slice(0, N * 6).filter((_, i) => i % 6 === 0);
                near.forEach(({ q }, n) => {
                    const p = photoOf(q.f), half = PW / 2;
                    for (let y = 0; y < PW; y++) for (let x = 0; x < PW; x++) {
                        const sx = Math.max(0, Math.min(p.width - 1, q.x - half + x)), sy = Math.max(0, Math.min(p.height - 1, q.y - half + y)), o = (sy * p.width + sx) * 4, d = ((k * PW + y) * W + n * PW + x) * 3;
                        sheet[d] = p.rgba[o]; sheet[d + 1] = p.rgba[o + 1]; sheet[d + 2] = p.rgba[o + 2];
                    }
                });
            });
            const png = encodePng(W, H, sheet, 3);
            try { fs.writeFileSync(path.join(dir, 'finish_swatches.png'), png); } catch { /* review only */ }
            const prompt = finishPrompt(rows, { ...(opts.building ? { building: [opts.building.name, opts.building.address].filter(Boolean).join(', ') } : {}) });
            const key = opts.store ? readingKey('measured-twin-finish', [INFER_VERSION, FACADE_READER_MODEL_KEY, prompt, png]) : undefined;
            const kept = key ? await opts.store!.get<Array<ClassFinish | null>>(key) : undefined;
            try {
                if (kept && kept.length === all.length) finishes = kept.map(f => f ?? undefined);
                else { calls.text++; finishes = parseClassFinish(await opts.models.text([png], prompt), all.length); if (key) opts.store!.put(key, finishes.map(f => f ?? null)); }
            } catch (err) { report.classes = { reason: `the finish read failed: ${err instanceof Error ? err.message : String(err)}` }; }
        }
        // a class read metal keeps it only when its colour is read metal at least as often as not (K's rule: a shadowed
        // stone class beside a lit one is the stone in shade, not metal)
        finishes = settleFinishes(rows.map(r => ({ meanLab: r.meanLab, share: r.share, openings: r.openings })), finishes);
        all.forEach((a, k) => {
            const f = finishes[k], read = !!f && f.conf >= P.finishMinConf;
            const roughness = read ? drawnRoughness(f!.roughness) : a.openings ? 0.08 : 0.85, metallic = read ? drawnMetalness(f!.metalness) : 0;
            classes.push({ index: k, meanLab: a.c.map(v => Math.round(v * 100) / 100) as V3, openings: a.openings, set: `class${k}`, finish: { roughness, metallic } });
        });
        if (!report.classes) report.classes = { count: classes.length, read: finishes.filter(f => f && f.conf >= P.finishMinConf).length, finishes: classes.map((c, k) => ({ lab: c.meanLab, openings: !!c.openings, roughness: c.finish!.roughness!, metalness: c.finish!.metallic!, conf: finishes[k]?.conf ?? 0, ...(finishes[k]?.seen ? { seen: finishes[k]!.seen } : {}) })) };
    }

    // 5. the street-level band from registered Street View plates
    const base: InferredInputs['base'] = [];
    if (opts.streetView && fs.existsSync(opts.streetView.platesFile)) {
        try {
            const pj = JSON.parse(fs.readFileSync(opts.streetView.platesFile, 'utf8')) as { plates: Array<{ id: string; imagePath: string; depthPath: string; maskPngPath: string; width: number; height: number; pose: { x: number; y: number; z: number; targetX: number; targetY: number; targetZ: number; up?: number[] }; intrinsics: { fx: number; fy: number; cx: number; cy: number } }> };
            const pdir = path.dirname(opts.streetView.platesFile), off = opts.streetView.offset;
            const plates = pj.plates.flatMap(rec => {
                try {
                    const img = decodeImageToRgba(fs.readFileSync(path.resolve(pdir, rec.imagePath)));
                    const depthBuf = fs.readFileSync(path.resolve(pdir, rec.depthPath));
                    const depth = new Float32Array(depthBuf.buffer, depthBuf.byteOffset, Math.floor(depthBuf.byteLength / 4));
                    const m = decodePng(fs.readFileSync(path.resolve(pdir, rec.maskPngPath)));
                    if (img.width !== rec.width || depth.length !== rec.width * rec.height || m.width !== rec.width) return [];
                    // the plate's camera in the run's frame
                    const cam = plateRecordCamera({ ...rec, pose: { ...rec.pose, x: rec.pose.x + off[0], y: rec.pose.y + off[1], z: rec.pose.z + off[2], targetX: rec.pose.targetX + off[0], targetY: rec.pose.targetY + off[1], targetZ: rec.pose.targetZ + off[2] } } as unknown as Parameters<typeof plateRecordCamera>[0]);
                    return [{ cam, img, depth, mask: m }];
                } catch { return []; }
            });
            let texels = 0;
            for (const f of frames) {
                if (f.h0 > P.baseTopM - 1) continue;  // the walls of every tier below the band's top (a tier's walls start at its base)
                const topM = Math.min(f.h1, P.baseTopM), pix = P.basePixelM;
                const W = Math.ceil(f.lengthM / pix), H = Math.ceil((topM - f.h0) / pix);
                if (W < 2 || H < 2) continue;
                const acc = new Float32Array(W * H * 4);
                const n = f.normal;
                for (const pl of plates) {
                    const c = pl.cam;
                    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                        const s = f.orthoSMin + (x + 0.5) * pix, hy = file.groundY + topM - (y + 0.5) * pix;
                        // the wall point (run frame) and the same point in the plates' frame
                        const p: V3 = [f.centroid[0] + f.axisS[0] * s, hy, f.centroid[2] + f.axisS[2] * s];
                        const q: V3 = [p[0] - off[0], p[1] - off[1], p[2] - off[2]];
                        const camLocal = { ...c, eye: [c.eye[0] - off[0], c.eye[1] - off[1], c.eye[2] - off[2]] as V3 };
                        const pr = projectToFrame(camLocal, q);
                        if (!pr) continue;
                        const u = Math.floor(pr[0]), v = Math.floor(pr[1]);
                        if (u < 0 || v < 0 || u >= c.width || v >= c.height) continue;
                        if (pl.mask.rgba[(v * c.width + u) * 4] < 128) continue;
                        const dz = pl.depth[v * c.width + u];
                        if (!(dz < PLATE_EMPTY_DEPTH * 0.5) || Math.abs(dz - pr[2]) > P.baseDepthTolM + P.baseDepthTolShare * pr[2]) continue;
                        if (pr[2] / c.fx > P.baseMaxMetresPerPx) continue;
                        const dx = q[0] - camLocal.eye[0], dy = q[1] - camLocal.eye[1], dzz = q[2] - camLocal.eye[2], L = Math.hypot(dx, dy, dzz);
                        const cos = -(dx * n[0] + dy * n[1] + dzz * n[2]) / L;
                        if (cos < P.baseMinCos) continue;
                        const wgt = (cos * cos) / L, o = (v * c.width + u) * 4, a = (y * W + x) * 4;
                        acc[a] += wgt * toLin(pl.img.rgba[o]); acc[a + 1] += wgt * toLin(pl.img.rgba[o + 1]); acc[a + 2] += wgt * toLin(pl.img.rgba[o + 2]); acc[a + 3] += wgt;
                    }
                }
                // toned to the scan photo: one gain per channel over the texels both see
                const ph = photoOf(f);
                const sum = [0, 0, 0, 0, 0, 0]; let both = 0, seen = 0;
                for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                    const a = (y * W + x) * 4;
                    if (!acc[a + 3]) continue;
                    seen++;
                    const hy = topM - (y + 0.5) * pix, px = Math.floor(((x + 0.5) * pix) / f.pixel), py = Math.floor((f.h1 - hy) / f.pixel);
                    if (px < 0 || py < 0 || px >= ph.width || py >= ph.height || !coveredAt(f, px, py)) continue;
                    const o = (py * ph.width + px) * 4;
                    for (let k = 0; k < 3; k++) { sum[k] += acc[a + k] / acc[a + 3]; sum[3 + k] += toLin(ph.rgba[o + k]); }
                    both++;
                }
                if (seen < 0.05 * W * H || both < 100) continue;
                const gain = [0, 1, 2].map(k => Math.max(0.33, Math.min(3, sum[3 + k] / Math.max(1e-6, sum[k]))));
                const rgba = new Uint8Array(W * H * 4);
                for (let i = 0; i < W * H; i++) { const a = i * 4; if (!acc[a + 3]) continue; for (let k = 0; k < 3; k++) rgba[a + k] = toS8((acc[a + k] / acc[a + 3]) * gain[k]); rgba[a + 3] = 255; }
                const out = path.join(dir, `${f.image.replace(/\.png$/, '')}_base.png`);
                fs.writeFileSync(out, encodePng(W, H, rgba, 4));
                base.push({ id: f.facadeId, png: out, pixel: pix, topM });
                texels += seen;
            }
            report.base = { faces: base.length, texels, plates: plates.length };
        } catch (err) { report.base = { reason: `Street View failed: ${err instanceof Error ? err.message : String(err)}` }; }
    } else report.base = { reason: opts.streetView ? `no plates at ${opts.streetView.platesFile}` : 'no registered Street View plates for this place' };

    // 7. relief: the image model's height map of each large wall with windows, kept where its edges follow the photo's
    const height: InferredInputs['height'] = [];
    if (opts.models?.image) {
        const big = frames.filter(f => (entries.get(f.facadeId)?.rects.length ?? 0) >= 6).sort((a, b) => b.width * b.height * b.coverage - a.width * a.height * a.coverage).slice(0, P.reliefFaces);
        let chunks = 0, kept = 0, rejected = 0;
        const prompt = 'Convert this straightened, front-on photo of a building wall into a grayscale HEIGHT MAP of its surface relief with exactly the same framing, size and layout: every edge must stay where it is in the photo. White = the surfaces standing furthest out (pier faces, cornices, sills, carved ornament, mouldings), black = the deepest (window glass, recesses), mid grey = the main wall plane. No lighting, no shadows, no colour, no text, no perspective: an orthographic depth map aligned pixel for pixel with the input. Uniform grey areas of the input are unknown: keep them mid grey.';
        // every chunk of every wall first, then asked four at a time (a kept answer is not asked again)
        type Chunk = { f: SelfFrame; x0: number; y0: number; cw: number; chh: number; crop: Uint8Array; png: Buffer; aspect: string; key?: string; ans?: string };
        const jobs: Chunk[] = [];
        for (const f of big) {
            const p = photoOf(f);
            const chunkH = Math.max(8, Math.min(p.height, Math.floor(p.width * P.reliefMaxAspect))), chunkW = Math.min(p.width, Math.floor(p.height * P.reliefMaxAspect) || p.width);
            for (let y0 = 0; y0 < p.height; y0 += chunkH) for (let x0 = 0; x0 < p.width; x0 += chunkW) {
                const cw = Math.min(chunkW, p.width - x0), chh = Math.min(chunkH, p.height - y0);
                if (cw < 16 || chh < 16) continue;
                const crop = new Uint8Array(cw * chh * 3);
                for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) { const o = ((y0 + y) * p.width + x0 + x) * 4, d = (y * cw + x) * 3; crop[d] = p.rgba[o]; crop[d + 1] = p.rgba[o + 1]; crop[d + 2] = p.rgba[o + 2]; }
                const png = encodePng(cw, chh, crop, 3);
                const ar = cw / chh, aspect = ar >= 1.6 ? '16:9' : ar >= 1.2 ? '4:3' : ar >= 0.85 ? '1:1' : ar >= 0.65 ? '3:4' : '9:16';
                jobs.push({ f, x0, y0, cw, chh, crop, png, aspect, ...(opts.store ? { key: readingKey('measured-twin-relief', [INFER_VERSION, prompt, png]) } : {}) });
            }
        }
        chunks = jobs.length;
        let next = 0;
        const worker = async () => {
            while (next < jobs.length) {
                const j = jobs[next++];
                if (opts.signal?.aborted) return;
                j.ans = j.key ? await opts.store!.get<string>(j.key) : undefined;
                if (j.ans) continue;
                try { calls.image++; const ans = await opts.models!.image!(j.png, prompt, j.aspect); if (ans) { j.ans = ans.toString('base64'); if (j.key) opts.store!.put(j.key, j.ans); } } catch { /* rejected below */ }
            }
        };
        await Promise.all([0, 1, 2, 3].map(worker));
        for (const f of big) {
            const p = photoOf(f);
            const hmap = new Uint8Array(p.width * p.height).fill(128);
            let any = false;
            for (const j of jobs.filter(q => q.f === f)) {
                const { x0, y0, cw, chh, crop } = j;
                if (!j.ans) { rejected++; continue; }
                let ans: { width: number; height: number; rgba: Uint8Array | Buffer };
                try { ans = decodeImageToRgba(Buffer.from(j.ans, 'base64')); } catch { rejected++; continue; }
                const rgbaCrop = new Uint8Array(cw * chh * 4); for (let i = 0; i < cw * chh; i++) { rgbaCrop[i * 4] = crop[i * 3]; rgbaCrop[i * 4 + 1] = crop[i * 3 + 1]; rgbaCrop[i * 4 + 2] = crop[i * 3 + 2]; }
                const L1 = lumaResampled({ width: cw, height: chh, rgba: rgbaCrop }, cw, chh);
                const L2 = lumaResampled(ans, cw, chh);
                const valid = new Uint8Array(cw * chh); for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) valid[y * cw + x] = coveredAt(f, x0 + x, y0 + y) ? 1 : 0;
                const corr = ncc(gradMag(L1, cw, chh), gradMag(L2, cw, chh), valid);
                if (corr < P.reliefMinEdgeCorr) { rejected++; continue; }
                kept++; any = true;
                for (let y = 0; y < chh; y++) for (let x = 0; x < cw; x++) if (valid[y * cw + x]) hmap[(y0 + y) * p.width + x0 + x] = Math.max(0, Math.min(255, Math.round(L2[y * cw + x])));
            }
            if (!any) continue;
            const out = path.join(dir, `${f.image.replace(/\.png$/, '')}_height.png`);
            fs.writeFileSync(out, encodePng(p.width, p.height, hmap, 1));
            height.push({ id: f.facadeId, png: out, depthM: P.reliefDepthM });
        }
        report.relief = { faces: height.length, chunks, kept, rejected };
    } else report.relief = { reason: 'no image model' };

    const planes = frames.map(f => ({ facadeId: f.facadeId, image: f.image, centroid: f.centroid, normal: f.normal, axisS: f.axisS, axisT: f.axisT, orthoSMin: f.orthoSMin, orthoTMax: f.orthoTMax, pixel: f.pixel, width: f.width, height: f.height }));
    const photos: InferredInputs['photos'] = {};
    for (const f of frames) photos[f.facadeId] = { image: path.join(dir, f.image), mask: path.join(dir, f.uncoveredMask) };
    const windowFit = [...entries.values()].map(e => ({ facadeId: e.facadeId, width: e.width, height: e.height, rects: e.rects as Array<[number, number, number, number]>, ...(e.panes?.length ? { panes: e.panes as Array<[number, number, number, number]> } : {}), ...(e.generated?.length ? { generated: e.generated as Array<[number, number, number, number]> } : {}) }));
    report.ms = Date.now() - t0;
    fs.writeFileSync(path.join(dir, 'infer_report.json'), JSON.stringify(report, null, 1));
    return { groundY: file.groundY, planes, windowFit, photos, classes, base, height, report };
}

/** WGS-84 east, up, south (m) of `p` from `o` (a local tangent plane; within a few hundred metres the curvature is millimetres). */
export function enuOffset(o: { lat: number; lng: number; h: number }, p: { lat: number; lng: number; h: number }): V3 {
    const a = 6378137, e2 = 6.69437999014e-3, lat = (o.lat * Math.PI) / 180;
    const s = Math.sin(lat), N = a / Math.sqrt(1 - e2 * s * s), M = (a * (1 - e2)) / Math.pow(1 - e2 * s * s, 1.5);
    const east = ((p.lng - o.lng) * Math.PI) / 180 * (N + o.h) * Math.cos(lat), north = ((p.lat - o.lat) * Math.PI) / 180 * (M + o.h);
    return [east, p.h - o.h, -north];
}
