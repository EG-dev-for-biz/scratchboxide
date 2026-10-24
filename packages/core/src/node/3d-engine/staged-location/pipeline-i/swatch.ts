/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The structure's colour swatch and the colour match of a generated model to it: the CIELAB mean and spread of the
 * structure's pixels in the character-sheet views (everything not near-white), and every base-colour texture of the
 * model moved onto them, channel by channel (Puck, 2026-10-24: Trellis's orange-brown brick to the sheet's red, colour
 * difference 9.6 -> 4.5). The mesh and its UVs are untouched; only the texture images are replaced.
 */

import { decodeImageToRgbaSync } from '../../../image-codec-ffmpeg';
import { decodePng, encodePng } from '../../../texture-processing';
import { assembleGlb, parseGlbBytes } from '../glb-bytes';

export interface Swatch { mean: [number, number, number]; std: [number, number, number]; samples: number }

const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const gam = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const fL = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fi = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);

export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
    const R = lin(r), G = lin(g), B = lin(b);
    const x = fL((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = fL(0.2126 * R + 0.7152 * G + 0.0722 * B), z = fL((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function labToRgb(L: number, a: number, b: number): [number, number, number] {
    const y = (L + 16) / 116, x = a / 500 + y, z = y - b / 200;
    const X = fi(x) * 0.95047, Y = fi(y), Z = fi(z) * 1.08883;
    const R = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, B = 0.0557 * X - 0.204 * Y + 1.057 * Z;
    const c = (v: number) => Math.max(0, Math.min(255, Math.round(gam(Math.max(0, Math.min(1, v))))));
    return [c(R), c(G), c(B)];
}

function stats(rgba: Uint8Array | Buffer, keep: (r: number, g: number, b: number) => boolean, stride = 1): Swatch {
    const s = [0, 0, 0], q = [0, 0, 0]; let n = 0;
    for (let i = 0; i < rgba.length; i += 4 * stride) {
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
        if (!keep(r, g, b)) continue;
        const l = rgbToLab(r, g, b);
        for (let k = 0; k < 3; k++) { s[k] += l[k]; q[k] += l[k] * l[k]; }
        n++;
    }
    if (!n) throw new Error('no structure pixels to measure a colour swatch from');
    const mean = s.map(v => v / n) as [number, number, number];
    return { mean, std: q.map((v, k) => Math.sqrt(Math.max(1e-6, v / n - mean[k] ** 2))) as [number, number, number], samples: n };
}

const notWhite = (r: number, g: number, b: number) => (255 - r) + (255 - g) + (255 - b) > 40;

/** The swatch of the structure in the views sent to the model (PNG, structure on white). */
export function measureSwatch(viewPngs: Buffer[]): Swatch {
    const parts = viewPngs.map(p => decodePng(p).rgba);
    const all = Buffer.concat(parts.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
    return stats(all, notWhite, 3);
}

/** Every base-colour image of the GLB moved onto the swatch's Lab mean and spread (the atlas's black padding kept). */
export function colourMatchGlb(glb: Buffer, swatch: Swatch): { glb: Buffer; before: Swatch[] } {
    const { json, bin } = parseGlbBytes(glb);
    const used = new Set<number>();
    for (const m of json.materials ?? []) { const t = m?.pbrMetallicRoughness?.baseColorTexture?.index; if (t !== undefined && json.textures?.[t]?.source !== undefined) used.add(json.textures[t].source); }
    let extra = Buffer.alloc(0), base = bin.byteLength + ((4 - (bin.byteLength % 4)) % 4);
    const before: Swatch[] = [];
    for (const idx of used) {
        const im = json.images[idx];
        if (im?.bufferView === undefined) continue;
        const bv = json.bufferViews[im.bufferView], off = bv.byteOffset ?? 0;
        const img = decodeImageToRgbaSync(Buffer.from(bin.buffer, bin.byteOffset + off, bv.byteLength));
        const content = (r: number, g: number, b: number) => r + g + b > 15;
        const src = stats(img.rgba, content, 2); before.push(src);
        const out = Buffer.from(img.rgba);
        for (let i = 0; i < out.length; i += 4) {
            if (!content(out[i], out[i + 1], out[i + 2])) continue;
            const l = rgbToLab(out[i], out[i + 1], out[i + 2]);
            const t = [0, 1, 2].map(k => (l[k] - src.mean[k]) / src.std[k] * swatch.std[k] + swatch.mean[k]);
            const c = labToRgb(t[0], t[1], t[2]); out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2];
        }
        const png = encodePng(img.width, img.height, out);
        const pad = (4 - (png.length % 4)) % 4;
        json.bufferViews.push({ buffer: 0, byteOffset: base + extra.length, byteLength: png.length });
        im.bufferView = json.bufferViews.length - 1; im.mimeType = 'image/png';
        extra = Buffer.concat([extra, png, Buffer.alloc(pad)]);
    }
    const head = Buffer.concat([Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength), Buffer.alloc(base - bin.byteLength)]);
    const all = Buffer.concat([head, extra]);
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: all.length }];
    return { glb: assembleGlb(json, all), before };
}
