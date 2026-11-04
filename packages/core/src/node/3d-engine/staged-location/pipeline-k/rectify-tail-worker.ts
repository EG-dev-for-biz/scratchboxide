/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The straightened orthos' tail on a worker thread (rectify-tail.ts owns it): one request at a time, `continue` then
 * `finish`, each the same function the main thread would call; the images go back transferred.
 */

import { isMainThread, parentPort, workerData } from 'worker_threads';
import { continueTail, finishTail, imageBuffers, type TailReply, type TailRequest } from './rectify-tail';

if (!isMainThread && (workerData as { rectifyTail?: boolean } | undefined)?.rectifyTail) {
    parentPort!.on('message', (m: TailRequest) => {
        try {
            if (m.op === 'continue') {
                const result = continueTail(m.images);
                parentPort!.postMessage({ op: 'continue', images: m.images, result } satisfies TailReply, imageBuffers(m.images));
            } else {
                parentPort!.postMessage({ op: 'finish', fromSmooth: finishTail(m.images, m.dir, m.continuedIds, m.holeIds) } satisfies TailReply);
            }
        } catch (err) {
            parentPort!.postMessage({ error: err instanceof Error ? (err.stack ?? err.message) : String(err) } satisfies TailReply);
        }
    });
}
