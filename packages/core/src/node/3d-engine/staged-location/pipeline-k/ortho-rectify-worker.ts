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
 * writes each as a PNG into the output folder and posts its report back.
 */

import * as fs from 'fs';
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';
import { decodePng } from '../../../texture-processing';
import { encodePng } from '../png-encode';
import { rectifyOrtho, uncoveredMaskName, type OrthoRectifyParams, type OrthoRectifyReport } from './ortho-rectify';

export interface RectifyJob { srcDir: string; outDir: string; facades: Array<{ facadeId: number; image: string; pixel: number }>; params: OrthoRectifyParams }
export type RectifyMessage = { facadeId: number; report?: OrthoRectifyReport; error?: string };

const job = (workerData as { job: RectifyJob }).job;
for (const f of job.facades) {
    try {
        const png = decodePng(fs.readFileSync(path.join(job.srcDir, f.image)));
        const r = rectifyOrtho({ width: png.width, height: png.height, rgba: new Uint8Array(png.rgba) }, f.pixel, job.params);
        fs.writeFileSync(path.join(job.outDir, f.image), encodePng(r.image.width, r.image.height, r.image.rgba, 4));
        // where the photo did not reach (its holes are filled in the ortho): the facade rebuild reads coverage from this
        fs.writeFileSync(path.join(job.outDir, uncoveredMaskName(f.image)), encodePng(r.image.width, r.image.height, r.uncovered.map(v => (v ? 255 : 0)), 1));
        parentPort!.postMessage({ facadeId: f.facadeId, report: r.report } satisfies RectifyMessage);
    } catch (err) {
        parentPort!.postMessage({ facadeId: f.facadeId, error: (err as Error).message } satisfies RectifyMessage);
    }
}
