/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * In-memory PNG encoder (8-bit grey, RGB or RGBA; non-interlaced) for the textured twin's images. zlib from Node; each
 * row takes the PNG filter (None, Sub, Up, Average, Paeth) with the smallest sum of absolute residuals. No files.
 */

import * as zlib from 'zlib';

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(parts: Uint8Array[]): number {
    let c = 0xffffffff;
    for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const tag = Buffer.from(type, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32([tag, data]), 0);
    return Buffer.concat([len, tag, Buffer.from(data.buffer, data.byteOffset, data.byteLength), crc]);
}

const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Encodes `pixels` (row-major, `channels` bytes per pixel: 1 grey, 3 RGB, 4 RGBA) as PNG bytes. */
export function encodePng(width: number, height: number, pixels: Uint8Array, channels: 1 | 3 | 4): Buffer {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error(`PNG size ${width}x${height} is not valid`);
    const stride = width * channels;
    if (pixels.length !== stride * height) throw new Error(`PNG data has ${pixels.length} bytes for ${width}x${height}x${channels}`);
    const raw = new Uint8Array((stride + 1) * height);
    const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
    for (let y = 0; y < height; y++) {
        const row = pixels.subarray(y * stride, (y + 1) * stride);
        const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
        let best = 0, bestCost = Infinity;
        for (let f = 0; f < 5; f++) {
            const out = cand[f];
            let cost = 0;
            for (let i = 0; i < stride; i++) {
                const a = i >= channels ? row[i - channels] : 0, b = up ? up[i] : 0, c = up && i >= channels ? up[i - channels] : 0;
                const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
                const v = (row[i] - pred) & 0xff;
                out[i] = v;
                cost += v < 128 ? v : 256 - v;
                if (cost >= bestCost) break;
            }
            if (cost < bestCost) { bestCost = cost; best = f; }
        }
        raw[y * (stride + 1)] = best;
        raw.set(cand[best], y * (stride + 1) + 1);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = channels === 1 ? 0 : channels === 3 ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
        chunk('IEND', new Uint8Array(0))
    ]);
}
