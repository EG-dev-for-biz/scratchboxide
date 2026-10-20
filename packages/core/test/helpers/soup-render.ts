/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A small z-buffered software render of triangle soups (9 floats per triangle) for test screenshots: an oblique
 * orthographic view, each soup in one colour, flat-shaded by a fixed light. Returns RGBA.
 */

export interface SoupLayer { tris: Float32Array; rgb: [number, number, number] }

export function renderSoups(layers: SoupLayer[], opts: { width?: number; height?: number; azimuthDeg?: number; elevationDeg?: number; focus?: { lo: number[]; hi: number[] } } = {}): { width: number; height: number; rgba: Uint8Array } {
    const W = opts.width ?? 480, H = opts.height ?? 360;
    const az = ((opts.azimuthDeg ?? 35) * Math.PI) / 180, el = ((opts.elevationDeg ?? 30) * Math.PI) / 180;
    // camera axes: fwd looks down at the scene from azimuth az, elevation el
    const fwd = [-Math.cos(el) * Math.sin(az), -Math.sin(el), -Math.cos(el) * Math.cos(az)];
    const right = [Math.cos(az), 0, -Math.sin(az)];
    const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    if (opts.focus) { lo = opts.focus.lo; hi = opts.focus.hi; } else for (const l of layers) for (let i = 0; i < l.tris.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], l.tris[i + k]); hi[k] = Math.max(hi[k], l.tris[i + k]); }
    const c = [0, 1, 2].map(k => (lo[k] + hi[k]) / 2);
    const rad = Math.max(1e-3, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    const scale = (0.9 * Math.min(W, H)) / (2 * rad);
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = 236; rgba[i * 4 + 1] = 238; rgba[i * 4 + 2] = 242; rgba[i * 4 + 3] = 255; }
    const zb = new Float32Array(W * H).fill(Infinity);
    const light = [0.4, 0.8, 0.45];
    const ll = Math.hypot(...light);
    for (const l of layers) {
        const P = l.tris;
        for (let t = 0; t + 8 < P.length; t += 9) {
            const X: number[] = [], Y: number[] = [], Z: number[] = [];
            for (let k = 0; k < 3; k++) {
                const d = [P[t + k * 3] - c[0], P[t + k * 3 + 1] - c[1], P[t + k * 3 + 2] - c[2]];
                X.push(W / 2 + scale * (d[0] * right[0] + d[1] * right[1] + d[2] * right[2]));
                Y.push(H / 2 - scale * (d[0] * up[0] + d[1] * up[1] + d[2] * up[2]));
                Z.push(d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2]);
            }
            const ux = P[t + 3] - P[t], uy = P[t + 4] - P[t + 1], uz = P[t + 5] - P[t + 2], vx = P[t + 6] - P[t], vy = P[t + 7] - P[t + 1], vz = P[t + 8] - P[t + 2];
            const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
            const nl = Math.hypot(...n) || 1;
            const shade = 0.45 + 0.55 * Math.abs((n[0] * light[0] + n[1] * light[1] + n[2] * light[2]) / (nl * ll));
            const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
            if (Math.abs(area) < 1e-9) continue;
            const x0 = Math.max(0, Math.floor(Math.min(...X))), x1 = Math.min(W - 1, Math.ceil(Math.max(...X)));
            const y0 = Math.max(0, Math.floor(Math.min(...Y))), y1 = Math.min(H - 1, Math.ceil(Math.max(...Y)));
            for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
                const xc = px + 0.5, yc = py + 0.5;
                const w0 = ((X[1] - xc) * (Y[2] - yc) - (X[2] - xc) * (Y[1] - yc)) / area, w1 = ((X[2] - xc) * (Y[0] - yc) - (X[0] - xc) * (Y[2] - yc)) / area, w2 = 1 - w0 - w1;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                const z = w0 * Z[0] + w1 * Z[1] + w2 * Z[2];
                const i = py * W + px;
                if (z >= zb[i]) continue;
                zb[i] = z;
                rgba[i * 4] = Math.min(255, l.rgb[0] * shade); rgba[i * 4 + 1] = Math.min(255, l.rgb[1] * shade); rgba[i * 4 + 2] = Math.min(255, l.rgb[2] * shade);
            }
        }
    }
    return { width: W, height: H, rgba };
}

/** Tiles equal-size RGBA images into a grid. */
export function contactSheet(images: Array<{ width: number; height: number; rgba: Uint8Array }>, columns: number): { width: number; height: number; rgba: Uint8Array } {
    const w = images[0].width, h = images[0].height, rows = Math.ceil(images.length / columns);
    const W = w * columns, H = h * rows, rgba = new Uint8Array(W * H * 4).fill(255);
    images.forEach((im, k) => {
        const ox = (k % columns) * w, oy = Math.floor(k / columns) * h;
        for (let y = 0; y < h; y++) rgba.set(im.rgba.subarray(y * w * 4, (y + 1) * w * 4), ((oy + y) * W + ox) * 4);
    });
    return { width: W, height: H, rgba };
}
