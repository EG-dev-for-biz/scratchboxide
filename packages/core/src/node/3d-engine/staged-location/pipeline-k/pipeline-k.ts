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
import { FACADE_LATTICE_PARAMS, type ReliefFacade } from '../facade-lattice';
import { ORTHO_RECTIFY_PARAMS, ORTHO_RECTIFY_VERSION, uncoveredMaskName, type OrthoRectifyParams, type OrthoRectifyReport } from './ortho-rectify';
import type { RectifyJob, RectifyMessage } from './ortho-rectify-worker';

export const PIPELINE_K_VERSION = `pipeline-k/1(${ORTHO_RECTIFY_VERSION})`;

/** Pipeline K when the request (or SCRATCHBOX_STAGED_PROCEDURAL) asks for 'k'. */
export function stagedPipelineK(request: { pipeline?: string }, env: NodeJS.ProcessEnv = process.env): boolean {
    return (request.pipeline ?? env.SCRATCHBOX_STAGED_PROCEDURAL ?? '').trim().toLowerCase() === 'k';
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
        const todo = facadesJson.facades.filter(f => f.coverage >= minCoverage && fs.existsSync(path.join(srcDir, f.image)));
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
        // a rectified facade names its uncovered mask (the rebuild reads coverage from it, its ortho's holes being filled) and its fill
        for (const f of facadesJson.facades) {
            const rep = reports.find(x => x.facadeId === f.facadeId)?.report;
            if (!rep || !fs.existsSync(path.join(tmp, uncoveredMaskName(f.image)))) continue;
            f.uncoveredMask = uncoveredMaskName(f.image);
            const filled = rep.holes.fromRepeats + rep.holes.fromStoreys + rep.holes.fromNearest;
            if (filled) f.textureFill = { label: 'generated', texels: filled, share: Math.round((filled / (rep.width * rep.height)) * 10000) / 10000, method: `holes filled from the facade's own real texels: ${rep.holes.fromRepeats} at its bay pitch, ${rep.holes.fromStoreys} at its storey pitch, ${rep.holes.fromNearest} from the nearest real texel` };
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
