/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K: the scan straightened and its facades rebuilt on straightened photos. On the remeshed scan (tile_refine:
 * facades snapped to fitted planes, the remesh polish's cleanup), every rectified facade's ortho is straightened and its
 * smears levelled (ortho-rectify.ts), and the facade is then rebuilt on the lines that ortho shows and textured with it
 * (facade-lattice.ts through remesh-polish.ts). Asked for with the staged tool's pipeline 'k' (or
 * SCRATCHBOX_STAGED_PROCEDURAL=k); it replaces pipeline E's massing and any procedural rebuild for that build, so what is
 * shown is the real scan, straightened, with its own photo.
 *
 * The rectified orthos are written beside the originals in a folder keyed by the rectifier's version and parameters,
 * with a facades.json of the same facades and a report per facade; a repeat build reads them back.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { workerTsRegisterSource } from '../../../worker-ts-register';
import { FACADE_LATTICE_PARAMS, facadeEligible, wallCoverage, type ReliefFacade } from '../facade-lattice';
import { decodePng } from '../../../texture-processing';
import { featurelessMaskName, ORTHO_RECTIFY_PARAMS, ORTHO_RECTIFY_VERSION, uncoveredMaskName, type OrthoRectifyParams, type OrthoRectifyReport } from './ortho-rectify';
import type { RectifyJob, RectifyMessage } from './ortho-rectify-worker';
import { encodePng } from '../png-encode';

/** The featureless photo refilled region by region: regions found, filled (each from one source at one shift), their texels, and the texels kept as photographed. */
export interface ContinuedFill { regions: number; filled: number; texels: number; fromFacades: Record<string, number>; kept: number; sources: Array<{ texels: number; from: number; shiftM: number; ringDiff: number }> }

/** A straightened facade photo with its masks: where the photo never reached, and where it is a smear (featureless). */
export interface FacadeImage { f: ReliefFacade; rgba: Uint8Array; width: number; height: number; uncovered?: Uint8Array; featureless?: Uint8Array }

export const CONTINUE_FEATURELESS = {
    /** Sources: the facade itself and every other facade whose normal is within this |cos| on the same side (never mirrored). */
    facingCos: 0.9,
    /** The ring around a region its source is aligned on (m), and how many of its texels are compared (an even sample). */
    ringM: 1, ringSamples: 400,
    /** How many of the region's texels the cover check samples. */
    coverSamples: 300,
    /** Shifts along the wall tried every this many of the source's texels. */
    shiftStepPx: 2,
    /** A source must hold real photo (not its holes, not its smear) for at least this share of the region at the shift chosen. */
    minCover: 0.9
};

/**
 * Featureless photo (a smear on a wall the photo did not see) refilled region by region, each region from one source at one
 * alignment, so its piers and windows run on unbroken: the region's texels mapped by their points on the wall into a source
 * photo (the facade itself, or another facing the same way, never mirrored), at the same height (never shifted up or down)
 * and shifted along the wall by the amount that best matches the real photo in a ring around the region (mean absolute luma
 * difference); a source repeats along the wall past its edges. The source and shift with the best ring match among those
 * holding real photo over at least minCover of the region are copied in whole; a region no source covers keeps its photo.
 * Generated: a fill. Edits the images in place.
 */
export function continueFeatureless(images: Map<number, FacadeImage>, P = CONTINUE_FEATURELESS): Map<number, ContinuedFill> {
    const out = new Map<number, ContinuedFill>();
    // sources read as they were before any of this (a fill never copies a fill)
    const src = new Map([...images].map(([id, x]) => [id, Uint8Array.from(x.rgba)]));
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const luma = (a: Uint8Array, j: number) => 0.299 * a[j * 4] + 0.587 * a[j * 4 + 1] + 0.114 * a[j * 4 + 2];
    for (const [id, x] of images) {
        const { f, rgba, width: W, height: H, featureless } = x;
        if (!featureless?.some(v => v)) continue;
        const real = (g: FacadeImage, j: number) => src.get(g.f.facadeId)![j * 4 + 3] > 0 && !g.uncovered?.[j] && !g.featureless?.[j];
        const rep: ContinuedFill = { regions: 0, filled: 0, texels: 0, fromFacades: {}, kept: 0, sources: [] };
        const sources = [...images.values()].filter(g => dot(g.f.normal, f.normal) >= P.facingCos);
        // a texel's point on the wall, in a source's frame: its s (along) and its row (height)
        const pointOf = (i: number) => { const px = i % W, py = (i - px) / W, s = f.orthoSMin + (px + 0.5) * f.pixel, t = f.orthoTMax - (py + 0.5) * f.pixel; return [0, 1, 2].map(k => f.centroid[k] + s * f.axisS[k] + t * f.axisT[k]); };
        const inSource = (g: FacadeImage, p: number[]) => { const q = [0, 1, 2].map(k => p[k] - g.f.centroid[k]); return { s: dot(q, g.f.axisS), gy: Math.floor((g.f.orthoTMax - dot(q, g.f.axisT)) / g.f.pixel) }; };
        const sample = (g: FacadeImage, at: { s: number; gy: number }, shiftM: number) => {
            if (at.gy < 0 || at.gy >= g.height) return -1;
            const gx = Math.floor((at.s + shiftM - g.f.orthoSMin) / g.f.pixel), wx = ((gx % g.width) + g.width) % g.width;
            return at.gy * g.width + wx;
        };
        // the regions (4-connected)
        const seen = new Uint8Array(W * H), ringR = Math.max(1, Math.round(P.ringM / f.pixel));
        for (let start = 0; start < W * H; start++) {
            if (!featureless[start] || seen[start]) continue;
            const region: number[] = [], stack = [start];
            seen[start] = 1;
            let x0 = W, x1 = 0, y0 = H, y1 = 0;
            while (stack.length) {
                const i = stack.pop()!, px = i % W, py = (i - px) / W;
                region.push(i); x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
                for (const k of [px > 0 ? i - 1 : -1, px < W - 1 ? i + 1 : -1, i - W, i + W]) if (k >= 0 && k < W * H && featureless[k] && !seen[k]) { seen[k] = 1; stack.push(k); }
            }
            rep.regions++; rep.texels += region.length;
            // the ring: real photo of this facade within ringM of the region (an even sample)
            const ring: number[] = [];
            for (let py = Math.max(0, y0 - ringR); py <= Math.min(H - 1, y1 + ringR); py++) for (let px = Math.max(0, x0 - ringR); px <= Math.min(W - 1, x1 + ringR); px++) {
                const i = py * W + px;
                if (!real(x, i)) continue;
                let near = false;
                for (let dy = -ringR; dy <= ringR && !near; dy += Math.max(1, ringR >> 1)) for (let dx = -ringR; dx <= ringR && !near; dx += Math.max(1, ringR >> 1)) { const xx = px + dx, yy = py + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && featureless[yy * W + xx]) near = true; }
                if (near) ring.push(i);
            }
            const ringPick = ring.filter((_, k) => k % Math.max(1, Math.ceil(ring.length / P.ringSamples)) === 0);
            const regionPick = region.filter((_, k) => k % Math.max(1, Math.ceil(region.length / P.coverSamples)) === 0);
            const ringAt = ringPick.map(pointOf), regionAt = regionPick.map(pointOf);
            let best: { g: FacadeImage; shiftM: number; diff: number } | undefined;
            for (const g of sources) {
                const a = src.get(g.f.facadeId)!, ringIn = ringAt.map(p => inSource(g, p)), regionIn = regionAt.map(p => inSource(g, p));
                const span = g.width * g.f.pixel, step = P.shiftStepPx * g.f.pixel;
                for (let shiftM = 0; shiftM < span; shiftM += step) {
                    // the facade itself is no source at no shift (the region would copy itself)
                    if (g === x && shiftM < (x1 - x0 + 1) * f.pixel) continue;
                    let cover = 0;
                    for (const at of regionIn) { const j = sample(g, at, shiftM); if (j >= 0 && real(g, j)) cover++; }
                    if (cover < P.minCover * regionIn.length) continue;
                    let sum = 0, n = 0;
                    ringPick.forEach((i, k) => { const j = sample(g, ringIn[k], shiftM); if (j >= 0 && real(g, j)) { sum += Math.abs(luma(a, j) - luma(src.get(id)!, i)); n++; } });
                    if (n < Math.min(20, ringPick.length)) continue;
                    const diff = n ? sum / n : Infinity;
                    if (!best || diff < best.diff) best = { g, shiftM, diff };
                }
            }
            if (!best) { rep.kept += region.length; continue; }
            const a = src.get(best.g.f.facadeId)!;
            let n = 0;
            for (const i of region) {
                const j = sample(best.g, inSource(best.g, pointOf(i)), best.shiftM);
                if (j < 0 || !real(best.g, j)) { rep.kept++; continue; }
                for (let c = 0; c < 3; c++) rgba[i * 4 + c] = a[j * 4 + c];
                if (rgba[i * 4] === 128 && rgba[i * 4 + 1] === 128 && rgba[i * 4 + 2] === 128) rgba[i * 4 + 2] = 129;
                n++;
            }
            rep.filled++;
            rep.fromFacades[best.g.f.facadeId] = (rep.fromFacades[best.g.f.facadeId] ?? 0) + n;
            rep.sources.push({ texels: n, from: best.g.f.facadeId, shiftM: Math.round(best.shiftM * 100) / 100, ringDiff: Math.round(best.diff * 10) / 10 });
        }
        out.set(id, rep);
    }
    return out;
}

export const PIPELINE_K_VERSION = `pipeline-k/3(${ORTHO_RECTIFY_VERSION})`;

/** Pipeline K when the request (or SCRATCHBOX_STAGED_PROCEDURAL) asks for 'k'. */
export function stagedPipelineK(request: { pipeline?: string }, env: NodeJS.ProcessEnv = process.env): boolean {
    const p = (request.pipeline ?? env.SCRATCHBOX_STAGED_PROCEDURAL ?? '').trim().toLowerCase();
    return p === 'k' || p === 'kd';
}

/** Pipeline K-D: K's straightening applied to a whole district (no isolate), its trees and surroundings kept. */
export function stagedPipelineKD(request: { pipeline?: string; isolate?: boolean }): boolean {
    return (request.pipeline ?? '').trim().toLowerCase() === 'kd' && request.isolate !== true;
}

export interface RectifiedOrthos {
    /** The folder to hand to the remesh polish in place of the originals. */
    orthosDir: string;
    /** Part of the polish's cache key, so a rectified polish is never mixed up with a plain one. */
    key: string;
    reports: Array<{ facadeId: number; report?: OrthoRectifyReport; error?: string }>;
    cached: boolean;
    ms: number;
}

const BOOTSTRAP = `
const { workerData } = require('worker_threads');
${workerTsRegisterSource()}
require(workerData.entry);
`;

function workerEntry(): string {
    const dir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (const name of ['ortho-rectify-worker.js', 'ortho-rectify-worker.ts']) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`pipeline K: ortho-rectify-worker not found beside ${dir}`);
}

/** Runs the jobs on worker threads (one job a thread); rejects when the signal aborts or a worker dies. */
function runWorkers(jobs: RectifyJob[], signal?: AbortSignal): Promise<RectifyMessage[]> {
    const entry = workerEntry();
    const out: RectifyMessage[] = [];
    const workers: Worker[] = [];
    return new Promise<RectifyMessage[]>((resolve, reject) => {
        let left = jobs.length, failed = false;
        const fail = (err: Error) => { if (failed) return; failed = true; for (const w of workers) void w.terminate(); reject(err); };
        const onAbort = () => fail(signal!.reason instanceof Error ? signal!.reason : new Error('pipeline K: stopped'));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (!left) { resolve(out); return; }
        for (const job of jobs) {
            const w = new Worker(BOOTSTRAP, { eval: true, workerData: { entry, job } });
            workers.push(w);
            w.on('message', (m: RectifyMessage) => out.push(m));
            w.on('error', err => fail(err));
            w.on('exit', code => {
                if (failed) return;
                if (code !== 0) return fail(new Error(`pipeline K: an ortho-rectify worker exited with code ${code}`));
                if (--left === 0) { signal?.removeEventListener('abort', onAbort); resolve(out); }
            });
        }
    });
}

/**
 * The relief orthos of a remesh, straightened and levelled: the facades the lattice rebuild will use (coverage at least
 * its minCoverage) are rectified, the others copied as they are. Cached beside the originals.
 */
export async function rectifyReliefOrthos(srcDir: string, opts: { params?: OrthoRectifyParams; minCoverage?: number; threads?: number; signal?: AbortSignal } = {}): Promise<RectifiedOrthos> {
    const t0 = Date.now();
    const params = opts.params ?? ORTHO_RECTIFY_PARAMS, minCoverage = opts.minCoverage ?? FACADE_LATTICE_PARAMS.minCoverage;
    const key = crypto.createHash('sha256').update(JSON.stringify({ v: PIPELINE_K_VERSION, params, minCoverage })).digest('hex').slice(0, 16);
    const outDir = path.join(path.dirname(srcDir), `${path.basename(srcDir)}_k_${key}`);
    const reportFile = path.join(outDir, 'rectify.json');
    if (fs.existsSync(reportFile)) {
        const saved = JSON.parse(fs.readFileSync(reportFile, 'utf8')) as { reports: RectifiedOrthos['reports'] };
        return { orthosDir: outDir, key, reports: saved.reports, cached: true, ms: Date.now() - t0 };
    }
    const facadesJson = JSON.parse(fs.readFileSync(path.join(srcDir, 'facades.json'), 'utf8')) as { facades: ReliefFacade[] };
    const tmp = `${outDir}.tmp-${process.pid}-${Date.now()}`;
    fs.mkdirSync(tmp, { recursive: true });
    try {
        // each facade's coverage over its own wall (a stepped face's rectangle holds the air beside its setbacks)
        for (const f of facadesJson.facades) {
            const file = path.join(srcDir, f.image);
            if (!fs.existsSync(file)) continue;
            const w = wallCoverage(decodePng(fs.readFileSync(file)), f.pixel);
            f.wallCoverage = Math.round(w.wallCoverage * 1000) / 1000; f.wallAreaM2 = Math.round(w.wallAreaM2);
        }
        const todo = facadesJson.facades.filter(f => facadeEligible(f, { ...FACADE_LATTICE_PARAMS, minCoverage }) && fs.existsSync(path.join(srcDir, f.image)));
        for (const f of facadesJson.facades) if (!todo.includes(f) && fs.existsSync(path.join(srcDir, f.image))) fs.copyFileSync(path.join(srcDir, f.image), path.join(tmp, f.image));
        // largest first, dealt round the threads
        const n = Math.max(1, Math.min(opts.threads ?? Math.max(1, Math.min(4, os.cpus().length - 1)), todo.length));
        const sorted = [...todo].sort((a, b) => b.width * b.height - a.width * a.height);
        const jobs: RectifyJob[] = Array.from({ length: n }, () => ({ srcDir, outDir: tmp, facades: [], params }));
        sorted.forEach((f, k) => jobs[k % n].facades.push({ facadeId: f.facadeId, image: f.image, pixel: f.pixel }));
        const msgs = await runWorkers(jobs.filter(j => j.facades.length), opts.signal);
        // a facade that failed keeps its original ortho
        for (const m of msgs) if (m.error) { const f = todo.find(x => x.facadeId === m.facadeId)!; fs.copyFileSync(path.join(srcDir, f.image), path.join(tmp, f.image)); }
        const reports = todo.map(f => msgs.find(m => m.facadeId === f.facadeId) ?? { facadeId: f.facadeId, error: 'no report came back' });
        // featureless photo the facades' own repeats could not refill: continued from the nearest facade facing the same way
        const images = new Map<number, FacadeImage>();
        const mask = (name: string) => { const file = path.join(tmp, name); if (!fs.existsSync(file)) return undefined; const m = decodePng(fs.readFileSync(file)); return Uint8Array.from({ length: m.width * m.height }, (_, k) => (m.rgba[k * 4] > 127 ? 1 : 0)); };
        for (const f of todo) {
            const file = path.join(tmp, f.image);
            if (fs.existsSync(file)) { const d = decodePng(fs.readFileSync(file)); images.set(f.facadeId, { f, rgba: new Uint8Array(d.rgba), width: d.width, height: d.height, uncovered: mask(uncoveredMaskName(f.image)), featureless: mask(featurelessMaskName(f.image)) }); }
        }
        const continued = continueFeatureless(images);
        for (const [id, c] of continued) {
            const x = images.get(id)!;
            fs.writeFileSync(path.join(tmp, x.f.image), encodePng(x.width, x.height, x.rgba, 4));
            const r = reports.find(y => y.facadeId === id);
            if (r && 'report' in r && r.report) (r.report.holes as typeof r.report.holes & { continued?: ContinuedFill }).continued = c;
        }
        // a rectified facade names its uncovered mask (the rebuild reads coverage from it, its ortho's holes being filled) and its fill
        for (const f of facadesJson.facades) {
            const rep = reports.find(x => x.facadeId === f.facadeId)?.report;
            if (!rep || !fs.existsSync(path.join(tmp, uncoveredMaskName(f.image)))) continue;
            f.uncoveredMask = uncoveredMaskName(f.image);
            const cont = (rep.holes as typeof rep.holes & { continued?: ContinuedFill }).continued;
            const fromOthers = cont ? Object.values(cont.fromFacades).reduce((a, b) => a + b, 0) : 0;
            const filled = rep.holes.fromRepeats + rep.holes.fromStoreys + rep.holes.fromNearest + fromOthers;
            if (filled) f.textureFill = { label: 'generated', texels: filled, share: Math.round((filled / (rep.width * rep.height)) * 10000) / 10000, method: `holes filled from the facade's own real texels: ${rep.holes.fromRepeats} at its bay pitch, ${rep.holes.fromStoreys} at its storey pitch, ${rep.holes.fromNearest} from the nearest real texel${rep.holes.featureless ? `; ${rep.holes.featureless} texels of featureless photo (a smear on a wall the photo did not see) found${cont ? `, refilled in ${cont.regions} regions, each whole from one source aligned to the photo around it (${Object.entries(cont.fromFacades).map(([k, v]) => `${Number(k) === f.facadeId ? 'its own photo' : `facade ${k}`}: ${v}`).join(', ')})${cont.kept ? `, ${cont.kept} kept as photographed (no source covers them)` : ''}` : ''}` : ''}` };
        }
        fs.writeFileSync(path.join(tmp, 'facades.json'), JSON.stringify(facadesJson));
        fs.writeFileSync(path.join(tmp, 'rectify.json'), JSON.stringify({ version: PIPELINE_K_VERSION, params, minCoverage, reports }, null, 1));
        if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
        fs.renameSync(tmp, outDir);
        return { orthosDir: outDir, key, reports, cached: false, ms: Date.now() - t0 };
    } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw err;
    }
}

/** One line for the build's notes. */
export function describeRectified(r: RectifiedOrthos): string {
    const ok = r.reports.filter(x => x.report);
    const kept = ok.filter(x => x.report!.warp.kept);
    const gains = kept.map(x => x.report!.straightnessPx.gain);
    const smeared = ok.reduce((a, x) => a + x.report!.smear.texels, 0);
    const filled = ok.reduce((a, x) => a + x.report!.holes.fromRepeats + x.report!.holes.fromStoreys + x.report!.holes.fromNearest, 0);
    const fromRepeats = ok.reduce((a, x) => a + x.report!.holes.fromRepeats + x.report!.holes.fromStoreys, 0);
    const failed = r.reports.filter(x => x.error);
    return `${ok.length} facade orthos rectified: ${kept.length} straightened (lines ${gains.length ? Math.round(100 * gains.reduce((a, b) => a + b, 0) / gains.length) : 0}% closer to straight on average)${ok.length > kept.length ? `, ${ok.length - kept.length} left as they were (${[...new Set(ok.filter(x => !x.report!.warp.kept).map(x => x.report!.warp.why))].slice(0, 2).join('; ')})` : ''}; ${smeared.toLocaleString('en-US')} smeared texels levelled against their repeats; ${filled.toLocaleString('en-US')} texels the photo did not reach filled (generated: ${filled ? Math.round((100 * fromRepeats) / filled) : 0}% from the facade's own repeats, the rest from the nearest real texel)${failed.length ? `; ${failed.length} failed and kept their original ortho (${failed[0].error})` : ''}`;
}
