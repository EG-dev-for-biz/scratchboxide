/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One SPZ decoder for browser and Node. Input is the decompressed payload (callers gunzip with
 * zlib or DecompressionStream). Handles Niantic SPZ v2 ('NGSP'), the interim Scratchbox planar
 * layout (NGSP header, 22 bytes per splat) and legacy 'SPZ1' records.
 */

export interface DecodedSpz {
    format: 'spz-v2' | 'spz-interim-planar' | 'spz1-legacy';
    count: number;
    positions: Float32Array;
    /** Linear metres. */
    scales: Float32Array;
    /** Display RGB in 0..1 (SH DC evaluated as 0.5 + C0 * dc). */
    colors: Float32Array;
    /** 0..1 */
    opacities: Float32Array;
    /** x, y, z, w with w >= 0. */
    quats: Float32Array;
    shDegree: number;
    /** Higher-order SH coefficients in file order, count * shDim * 3 values in [-1, 1]. */
    sh?: Float32Array;
}

const MAGIC_NGSP = 0x5053474e;
const MAGIC_SPZ1 = 0x315a5053;
const SPZ_COLOR_SCALE = 0.15;
const SH_C0 = 0.28209479177387814;

function shDimFor(degree: number): number {
    return degree === 1 ? 3 : degree === 2 ? 8 : degree === 3 ? 15 : 0;
}

export function isGzip(bytes: Uint8Array): boolean {
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function allocate(count: number, format: DecodedSpz['format'], shDegree = 0): DecodedSpz {
    return {
        format,
        count,
        positions: new Float32Array(count * 3),
        scales: new Float32Array(count * 3),
        colors: new Float32Array(count * 3),
        opacities: new Float32Array(count),
        quats: new Float32Array(count * 4),
        shDegree
    };
}

export function decodeSpz(bytes: Uint8Array): DecodedSpz {
    if (isGzip(bytes)) throw new Error('decodeSpz expects a decompressed SPZ payload');
    if (bytes.length < 16) throw new Error('SPZ payload too small for its header');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const magic = view.getUint32(0, true);

    if (magic === MAGIC_NGSP) {
        const version = view.getUint32(4, true);
        const n = view.getUint32(8, true);
        const shDegree = view.getUint8(12);
        const fractionalBits = view.getUint8(13);
        const body = bytes.length - 16;
        const shDim = shDimFor(shDegree);
        const nianticBytes = n * (9 + 1 + 3 + 3 + (version >= 3 ? 4 : 3)) + n * shDim * 3;
        if (body === n * 22 && body !== nianticBytes) return decodeInterimPlanar(view, n, fractionalBits);
        if (version >= 3) throw new Error('SPZ v3 (smallest-three rotations) is not supported yet');
        if (body < nianticBytes) throw new Error(`SPZ body too small: ${body} < ${nianticBytes}`);

        const out = allocate(n, 'spz-v2', shDegree);
        const posScale = 1 / (1 << fractionalBits);
        const posOff = 16, alphaOff = posOff + 9 * n, colorOff = alphaOff + n, scaleOff = colorOff + 3 * n, rotOff = scaleOff + 3 * n, shOff = rotOff + 3 * n;
        for (let i = 0; i < n; i++) {
            for (let k = 0; k < 3; k++) {
                const b = posOff + (i * 3 + k) * 3;
                let v = bytes[b] | (bytes[b + 1] << 8) | (bytes[b + 2] << 16);
                if (v & 0x800000) v |= 0xff000000;
                out.positions[i * 3 + k] = v * posScale;
                out.scales[i * 3 + k] = Math.exp(bytes[scaleOff + i * 3 + k] / 16 - 10);
                const dc = (bytes[colorOff + i * 3 + k] / 255 - 0.5) / SPZ_COLOR_SCALE;
                out.colors[i * 3 + k] = Math.min(1, Math.max(0, dc * SH_C0 + 0.5));
            }
            out.opacities[i] = bytes[alphaOff + i] / 255;
            const qx = bytes[rotOff + i * 3] / 127.5 - 1;
            const qy = bytes[rotOff + i * 3 + 1] / 127.5 - 1;
            const qz = bytes[rotOff + i * 3 + 2] / 127.5 - 1;
            out.quats.set([qx, qy, qz, Math.sqrt(Math.max(0, 1 - (qx * qx + qy * qy + qz * qz)))], i * 4);
        }
        if (shDim > 0) {
            const coeffs = shDim * 3;
            out.sh = new Float32Array(n * coeffs);
            for (let j = 0; j < n * coeffs; j++) out.sh[j] = (bytes[shOff + j] - 127.5) / 127.5;
        }
        return out;
    }

    if (magic === MAGIC_SPZ1) {
        const fractionalBits = view.getUint8(12);
        const count = Math.min(view.getUint32(8, true), Math.floor((bytes.length - 16) / 22));
        const out = allocate(count, 'spz1-legacy');
        const posScale = 1 / (1 << fractionalBits);
        let o = 16;
        for (let i = 0; i < count; i++) {
            for (let k = 0; k < 3; k++) out.positions[i * 3 + k] = view.getInt32(o + k * 4, true) * posScale;
            o += 12;
            for (let k = 0; k < 3; k++) out.scales[i * 3 + k] = Math.exp(((view.getInt8(o++) + 128) / 255) * 12 - 8);
            const qx = view.getInt8(o++) / 127, qy = view.getInt8(o++) / 127, qz = view.getInt8(o++) / 127;
            out.quats.set([qx, qy, qz, Math.sqrt(Math.max(0, 1 - (qx * qx + qy * qy + qz * qz)))], i * 4);
            for (let k = 0; k < 3; k++) out.colors[i * 3 + k] = view.getUint8(o++) / 255;
            out.opacities[i] = view.getUint8(o++) / 255;
        }
        return out;
    }

    throw new Error(`Invalid SPZ magic: 0x${magic.toString(16)} (expected 0x5053474e or 0x315a5053)`);
}

function decodeInterimPlanar(view: DataView, n: number, fractionalBits: number): DecodedSpz {
    const out = allocate(n, 'spz-interim-planar');
    const posScale = 1 / (1 << fractionalBits);
    const px = 16, py = px + n * 4, pz = py + n * 4;
    const sx = pz + n * 4, sy = sx + n, sz = sy + n;
    const qx = sz + n, qy = qx + n, qz = qy + n;
    const r = qz + n, g = r + n, b = g + n, a = b + n;
    for (let i = 0; i < n; i++) {
        out.positions.set([view.getInt32(px + i * 4, true) * posScale, view.getInt32(py + i * 4, true) * posScale, view.getInt32(pz + i * 4, true) * posScale], i * 3);
        out.scales.set([sx, sy, sz].map(off => Math.exp(((view.getInt8(off + i) + 128) / 255) * 12 - 8)), i * 3);
        const fx = view.getInt8(qx + i) / 127, fy = view.getInt8(qy + i) / 127, fz = view.getInt8(qz + i) / 127;
        out.quats.set([fx, fy, fz, Math.sqrt(Math.max(0, 1 - (fx * fx + fy * fy + fz * fz)))], i * 4);
        out.colors.set([view.getUint8(r + i) / 255, view.getUint8(g + i) / 255, view.getUint8(b + i) / 255], i * 3);
        out.opacities[i] = view.getUint8(a + i) / 255;
    }
    return out;
}
