/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A PNG codec worker thread (png-codec-pool.ts owns them): encodes and decodes with the very functions the main thread
 * would run (png-encode.ts encodePng, texture-processing.ts decodePng) and the same bundled zlib, so its bytes are theirs.
 * Each answer's buffer is transferred back, not copied.
 */

import { parentPort } from 'worker_threads';
import { encodePng } from './3d-engine/staged-location/png-encode';
import { decodePng } from './texture-processing';
import type { PngCodecReply, PngCodecRequest } from './png-codec-pool';

/** `bytes` as an ArrayBuffer of exactly its length, safe to transfer (its own buffer when it fills it, else a copy). */
function transferable(bytes: Uint8Array): ArrayBuffer {
    const b = bytes.buffer;
    if (b instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === b.byteLength) return b;
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
}

parentPort!.on('message', (m: PngCodecRequest) => {
    try {
        if (m.op === 'encode') {
            const out = transferable(encodePng(m.width, m.height, new Uint8Array(m.pixels), m.channels));
            parentPort!.postMessage({ id: m.id, bytes: out } satisfies PngCodecReply, [out]);
        } else {
            const d = decodePng(Buffer.from(m.png));
            const out = transferable(d.rgba);
            parentPort!.postMessage({ id: m.id, width: d.width, height: d.height, bytes: out } satisfies PngCodecReply, [out]);
        }
    } catch (err) {
        parentPort!.postMessage({ id: m.id, error: err instanceof Error ? err.message : String(err) } satisfies PngCodecReply);
    }
});
