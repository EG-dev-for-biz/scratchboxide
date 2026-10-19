/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Small image operations on RGBA8 face textures for pipeline E's inference steps (masked blur, NCC, sampling). */

export const lumaAt = (rgba: Uint8Array, i: number): number => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];

export function lumaPlane(rgba: Uint8Array, W: number, H: number): Float32Array {
    const L = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) L[i] = lumaAt(rgba, i);
    return L;
}

/** Box-blurred values over the pixels `use` marks (normalised convolution, radius r, separable, two passes ~ gaussian). */
export function maskedBlur(v: Float32Array, use: Uint8Array | undefined, W: number, H: number, r: number, passes = 2): Float32Array {
    let val: Float32Array = new Float32Array(v.length), wt: Float32Array = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) { const u = use ? use[i] : 1; val[i] = u ? v[i] : 0; wt[i] = u ? 1 : 0; }
    const pass = (a: Float32Array, horizontal: boolean): Float32Array => {
        const out = new Float32Array(a.length);
        const n = horizontal ? W : H, m = horizontal ? H : W;
        for (let j = 0; j < m; j++) {
            let acc = 0;
            const at = (k: number) => (horizontal ? j * W + k : k * W + j);
            for (let k = -r; k <= r; k++) if (k >= 0 && k < n) acc += a[at(k)];
            for (let k = 0; k < n; k++) {
                out[at(k)] = acc;
                const add = k + r + 1, sub = k - r;
                if (add < n) acc += a[at(add)];
                if (sub >= 0) acc -= a[at(sub)];
            }
        }
        return out;
    };
    for (let p = 0; p < passes; p++) { val = pass(pass(val, true), false); wt = pass(pass(wt, true), false); }
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = wt[i] > 1e-6 ? val[i] / wt[i] : NaN;
    return out;
}

/** Per-channel masked blur of an RGBA8 image (float, NaN where nothing reaches). */
export function blurRgb(rgba: Uint8Array, use: Uint8Array | undefined, W: number, H: number, r: number): Float32Array[] {
    return [0, 1, 2].map(c => {
        const v = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) v[i] = rgba[i * 4 + c];
        return maskedBlur(v, use, W, H, r);
    });
}

/** Zero-mean normalised cross-correlation of a and b over the pixels both mark (null with too few or flat). */
export function ncc(a: Float32Array, b: Float32Array, useA?: Uint8Array, useB?: Uint8Array): number | null {
    let n = 0, sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) if ((!useA || useA[i]) && (!useB || useB[i]) && Number.isFinite(a[i]) && Number.isFinite(b[i])) { n++; sa += a[i]; sb += b[i]; }
    if (n < 16) return null;
    const ma = sa / n, mb = sb / n;
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) if ((!useA || useA[i]) && (!useB || useB[i]) && Number.isFinite(a[i]) && Number.isFinite(b[i])) { const x = a[i] - ma, y = b[i] - mb; ab += x * y; aa += x * x; bb += y * y; }
    if (aa < 1e-6 * n || bb < 1e-6 * n) return null;
    return ab / Math.sqrt(aa * bb);
}

/** A crop [x0, x0 + w) x [y0, y0 + h) of a float plane (out of range: NaN). */
export function crop(v: Float32Array, W: number, H: number, x0: number, y0: number, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h).fill(NaN);
    for (let y = 0; y < h; y++) {
        const yy = y0 + y;
        if (yy < 0 || yy >= H) continue;
        for (let x = 0; x < w; x++) { const xx = x0 + x; if (xx >= 0 && xx < W) out[y * w + x] = v[yy * W + xx]; }
    }
    return out;
}

export function cropMask(m: Uint8Array, W: number, H: number, x0: number, y0: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        const yy = y0 + y;
        if (yy < 0 || yy >= H) continue;
        for (let x = 0; x < w; x++) { const xx = x0 + x; if (xx >= 0 && xx < W) out[y * w + x] = m[yy * W + xx]; }
    }
    return out;
}

export const medianOf = (v: number[]): number => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]); };

/** Dilates a 0/1 mask by r pixels (square). */
export function dilate(m: Uint8Array, W: number, H: number, r: number): Uint8Array {
    if (r <= 0) return m.slice();
    const tmp = new Uint8Array(m.length), out = new Uint8Array(m.length);
    for (let y = 0; y < H; y++) { let run = -1e9; for (let x = 0; x < W; x++) { if (m[y * W + x]) run = x; tmp[y * W + x] = x - run <= r ? 1 : 0; } run = 1e9; for (let x = W - 1; x >= 0; x--) { if (m[y * W + x]) run = x; if (run - x <= r) tmp[y * W + x] = 1; } }
    for (let x = 0; x < W; x++) { let run = -1e9; for (let y = 0; y < H; y++) { if (tmp[y * W + x]) run = y; out[y * W + x] = y - run <= r ? 1 : 0; } run = 1e9; for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) run = y; if (run - y <= r) out[y * W + x] = 1; } }
    return out;
}
