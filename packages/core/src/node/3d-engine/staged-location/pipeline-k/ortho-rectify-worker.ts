/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's worker thread: rectifies the facade orthos it is given (pipeline-k.ts) off the server's main thread,
 * writes each as a PNG into the output folder and posts its report back, with its pixels and masks as raw buffers (moved,
 * not copied), so the tail in pipeline-k.ts need not decode the PNGs again. When SCRATCHBOX_K_NATIVE runs `rectify` (the default), each
 * through the native kernel (native/ortho-rectify-native.ts, the same result; four threads, past which it is memory bound).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';
import { decodePng } from '../../../texture-processing';
import { encodePng } from '../png-encode';
import { featurelessMaskName, occludedMaskName, rectifyOrtho, uncoveredMaskName, type OrthoRectifyParams, type OrthoRectifyReport } from './ortho-rectify';
import { rectifyOrthoNative } from './native/ortho-rectify-native';
import { kNative } from './native/native-switch';

export interface RectifyJob { srcDir: string; outDir: string; facades: Array<{ facadeId: number; image: string; pixel: number }>; params: OrthoRectifyParams }
/** A straightened ortho as the main thread uses it: RGBA, and 0/1 masks of where the photo did not reach and of its smear (absent when none). */
export interface RectifiedPixels { width: number; height: number; rgba: Uint8Array; uncovered: Uint8Array; featureless?: Uint8Array }
export type RectifyMessage = { facadeId: number; report?: OrthoRectifyReport; pixels?: RectifiedPixels; error?: string };

const job = (workerData as { job: RectifyJob }).job;
const native = kNative('rectify');
void (async () => { for (const f of job.facades) {
    try {
        const png = decodePng(fs.readFileSync(path.join(job.srcDir, f.image)));
        // tile_refine's occlusion mask, when it wrote one, follows the photo through the warp
        const occFile = path.join(job.srcDir, occludedMaskName(f.image));
        const occPng = fs.existsSync(occFile) ? decodePng(fs.readFileSync(occFile)) : undefined;
        const occ = occPng && occPng.width === png.width && occPng.height === png.height ? Uint8Array.from({ length: png.width * png.height }, (_, k) => occPng.rgba[k * 4]) : undefined;
        const img = { width: png.width, height: png.height, rgba: new Uint8Array(png.rgba) };
        const r = native ? await rectifyOrthoNative(img, f.pixel, job.params, occ, { threads: 4 }) : rectifyOrtho(img, f.pixel, job.params, occ);
        fs.writeFileSync(path.join(job.outDir, f.image), encodePng(r.image.width, r.image.height, r.image.rgba, 4));
        // where the photo did not reach (its holes are filled in the ortho): the facade rebuild reads coverage from this
        fs.writeFileSync(path.join(job.outDir, uncoveredMaskName(f.image)), encodePng(r.image.width, r.image.height, r.uncovered.map(v => (v ? 255 : 0)), 1));
        if (r.occluded) fs.writeFileSync(path.join(job.outDir, occludedMaskName(f.image)), encodePng(r.image.width, r.image.height, r.occluded, 1));
        if (r.featureless.some(v => v)) fs.writeFileSync(path.join(job.outDir, featurelessMaskName(f.image)), encodePng(r.image.width, r.image.height, r.featureless.map(v => (v ? 255 : 0)), 1));
        // the pixels as the files hold them: the masks read back as 0/1 (a featureless mask only where there is one)
        const uncovered = Uint8Array.from(r.uncovered, v => (v ? 1 : 0));
        const featureless = r.featureless.some(v => v) ? Uint8Array.from(r.featureless, v => (v ? 1 : 0)) : undefined;
        const rgba = Uint8Array.from(r.image.rgba);
        const pixels: RectifiedPixels = { width: r.image.width, height: r.image.height, rgba, uncovered, ...(featureless ? { featureless } : {}) };
        parentPort!.postMessage({ facadeId: f.facadeId, report: r.report, pixels } satisfies RectifyMessage, [rgba.buffer, uncovered.buffer, ...(featureless ? [featureless.buffer] : [])]);
    } catch (err) {
        parentPort!.postMessage({ facadeId: f.facadeId, error: (err as Error).message } satisfies RectifyMessage);
    }
} })();
