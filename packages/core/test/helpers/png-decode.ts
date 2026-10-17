/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A test-side PNG decoder (8-bit grey/RGB/RGBA, non-interlaced, all five filters), written independently of the
 * encoder under test: it checks every chunk CRC with zlib.crc32 when Node has it and inflates with zlib.
 */

import * as zlib from 'zlib';

export interface DecodedPng { width: number; height: number; channels: number; pixels: Uint8Array }

export function decodePng(png: Uint8Array): DecodedPng {
    const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
    if (b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('not a PNG (bad signature)');
    let o = 8, width = 0, height = 0, channels = 0;
    const idat: Buffer[] = [];
    let sawEnd = false;
    while (o < b.length) {
        const len = b.readUInt32BE(o), type = b.toString('latin1', o + 4, o + 8), data = b.subarray(o + 8, o + 8 + len);
        const crcFn = (zlib as unknown as { crc32?: (d: Buffer, v?: number) => number }).crc32;
        if (crcFn && (crcFn(data, crcFn(Buffer.from(type, 'latin1'))) >>> 0) !== b.readUInt32BE(o + 8 + len)) throw new Error(`PNG chunk ${type} has a bad CRC`);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0); height = data.readUInt32BE(4);
            if (data[8] !== 8 || data[12] !== 0) throw new Error('only 8-bit non-interlaced PNG is decoded here');
            channels = ({ 0: 1, 2: 3, 6: 4 } as Record<number, number>)[data[9]] ?? 0;
            if (!channels) throw new Error(`PNG colour type ${data[9]} is not decoded here`);
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') { sawEnd = true; break; }
        o += 12 + len;
    }
    if (!sawEnd) throw new Error('PNG has no IEND');
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length !== (stride + 1) * height) throw new Error(`PNG data is ${raw.length} bytes for ${width}x${height}x${channels}`);
    const out = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
        const f = raw[y * (stride + 1)];
        for (let i = 0; i < stride; i++) {
            const x = raw[y * (stride + 1) + 1 + i];
            const a = i >= channels ? out[y * stride + i - channels] : 0;
            const up = y ? out[(y - 1) * stride + i] : 0;
            const c = y && i >= channels ? out[(y - 1) * stride + i - channels] : 0;
            let p = 0;
            if (f === 1) p = a; else if (f === 2) p = up; else if (f === 3) p = (a + up) >> 1;
            else if (f === 4) { const q = a + up - c, pa = Math.abs(q - a), pb = Math.abs(q - up), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
            else if (f !== 0) throw new Error(`PNG filter ${f} is not valid`);
            out[y * stride + i] = (x + p) & 0xff;
        }
    }
    return { width, height, channels, pixels: out };
}
