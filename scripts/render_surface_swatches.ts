/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Renders every entry of the surface texture library as it would be seen in a scene, for judging by eye (and by the
 * visual critic): a ground plane receding 30 m from a 1.6 m eye height and a wall 4 m away seen at 35 degrees, both at the
 * entry's real-world size, under a low sun (GGX specular with the roughness map, the normal map, a sky ambient) with
 * mip-filtered sampling. Repetition, wrong scale, flat or noisy relief and a plastic sheen show here, not in a flat swatch.
 *
 *   tsx scripts/render_surface_swatches.ts [--index <index.json>] [--out <dir>] [--only id,id]
 *
 * Reads the index from the durable asset store (/models/surfaces/index.json) unless --index names a file (maps are then
 * read beside it). Writes <out>/<id>.png and <out>/contact.png. No model is called.
 */

import * as fs from 'fs';
import * as path from 'path';
import { decodeImageToRgbaSync } from '../packages/core/src/node/image-codec-ffmpeg';
import { encodePng } from '../packages/core/src/node/3d-engine/staged-location/png-encode';
import { defaultDurableAssetStore } from '../packages/core/src/node/asset-store/durable-asset-store';
import type { SurfaceTextureEntry, SurfaceTextureIndex } from '../packages/core/src/common/spatial/surface-texture-library';

type V3 = [number, number, number];
const SRGB_LIN = new Float32Array(256).map((_, i) => { const c = i / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const toSrgb = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
const norm = (v: V3): V3 => { const l = Math.hypot(...v) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A mip pyramid of a map in linear float (colour maps) or raw 0..1 (data maps), sampled with wrap. */
class Mipped {
    levels: Array<{ w: number; h: number; d: Float32Array }> = [];
    constructor(rgba: Uint8Array, w: number, h: number, linear: boolean) {
        const d = new Float32Array(w * h * 3);
        for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) d[i * 3 + c] = linear ? SRGB_LIN[rgba[i * 4 + c]] : rgba[i * 4 + c] / 255;
        this.levels.push({ w, h, d });
        while (w > 1 && h > 1) {
            const nw = w >> 1, nh = h >> 1, prev = this.levels[this.levels.length - 1].d, nd = new Float32Array(nw * nh * 3);
            for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) for (let c = 0; c < 3; c++)
                nd[(y * nw + x) * 3 + c] = (prev[((2 * y) * w + 2 * x) * 3 + c] + prev[((2 * y) * w + 2 * x + 1) * 3 + c] + prev[((2 * y + 1) * w + 2 * x) * 3 + c] + prev[((2 * y + 1) * w + 2 * x + 1) * 3 + c]) / 4;
            this.levels.push({ w: nw, h: nh, d: nd }); w = nw; h = nh;
        }
    }
    /** Bilinear sample at uv (wrapping) from the level whose texel matches `footprint` (texels of level 0 per pixel). */
    sample(u: number, v: number, footprint: number): V3 {
        const lod = Math.min(this.levels.length - 1, Math.max(0, Math.log2(Math.max(1, footprint))));
        const l0 = Math.floor(lod), t = lod - l0, a = this.bilinear(l0, u, v);
        if (t < 1e-3 || l0 + 1 >= this.levels.length) return a;
        const b = this.bilinear(l0 + 1, u, v);
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    private bilinear(l: number, u: number, v: number): V3 {
        const { w, h, d } = this.levels[l];
        const x = (u - Math.floor(u)) * w - 0.5, y = (1 - (v - Math.floor(v))) * h - 0.5;   // v up (flipY)
        const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
        const at = (xx: number, yy: number, c: number) => d[((((yy % h) + h) % h) * w + (((xx % w) + w) % w)) * 3 + c];
        const out: V3 = [0, 0, 0];
        for (let c = 0; c < 3; c++) out[c] = (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy;
        return out;
    }
}

interface Material { color: Mipped; normal: Mipped; rough: Mipped; size: [number, number]; px: number }

const SUN = norm([-0.55, 0.42, -0.72]);           // low afternoon sun, from behind-left of the camera
const SUN_RGB: V3 = [3.2, 3.0, 2.7], SKY_RGB: V3 = [0.32, 0.38, 0.48];

/** GGX + Lambert shade of one point with tangent frame (t, b, n) of the surface. */
function shade(m: Material, u: number, v: number, footprint: number, t: V3, b: V3, n: V3, view: V3): V3 {
    const base = m.color.sample(u, v, footprint), nm = m.normal.sample(u, v, footprint), r = Math.max(0.04, m.rough.sample(u, v, footprint)[0]);
    const tn: V3 = [nm[0] * 2 - 1, nm[1] * 2 - 1, nm[2] * 2 - 1];
    const N = norm([t[0] * tn[0] + b[0] * tn[1] + n[0] * tn[2], t[1] * tn[0] + b[1] * tn[1] + n[1] * tn[2], t[2] * tn[0] + b[2] * tn[1] + n[2] * tn[2]]);
    const NL = Math.max(0, dot(N, SUN)), NV = Math.max(1e-3, dot(N, view)), H = norm([SUN[0] + view[0], SUN[1] + view[1], SUN[2] + view[2]]);
    const NH = Math.max(0, dot(N, H)), a2 = (r * r) ** 2, dd = NH * NH * (a2 - 1) + 1, D = a2 / (Math.PI * dd * dd);
    const k = (r + 1) ** 2 / 8, G = (NL / (NL * (1 - k) + k)) * (NV / (NV * (1 - k) + k));
    const F = 0.04 + 0.96 * (1 - Math.max(0, dot(H, view))) ** 5;
    const spec = NL > 0 ? (D * G * F) / (4 * NL * NV) : 0;
    const sky = 0.5 + 0.5 * N[1];
    return [0, 1, 2].map(c => base[c] * (SUN_RGB[c] * NL / Math.PI + SKY_RGB[c] * sky) + spec * SUN_RGB[c] * NL) as V3;
}

/** One view: a camera at `eye` looking along `fwd`, a plane through `p0` with in-plane axes `ax` (u) and `ay` (v). */
function renderView(m: Material, W: number, H: number, eye: V3, fwd: V3, fovDeg: number, p0: V3, ax: V3, ay: V3, out: Uint8Array, ox: number, OW: number): void {
    const f = norm(fwd), right = norm([f[2], 0, -f[0]].map(x => -x) as V3), up = norm([right[1] * f[2] - right[2] * f[1], right[2] * f[0] - right[0] * f[2], right[0] * f[1] - right[1] * f[0]]);
    const n = norm([ax[1] * ay[2] - ax[2] * ay[1], ax[2] * ay[0] - ax[0] * ay[2], ax[0] * ay[1] - ax[1] * ay[0]]);
    const nf: V3 = dot(n, [eye[0] - p0[0], eye[1] - p0[1], eye[2] - p0[2]]) < 0 ? [-n[0], -n[1], -n[2]] : n;
    const tanH = Math.tan(fovDeg * Math.PI / 360), pixelAngle = 2 * tanH / W;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const acc: V3 = [0, 0, 0];
        for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
            const px = ((x + sx) / W * 2 - 1) * tanH, py = (1 - (y + sy) / H * 2) * tanH * H / W;
            const d = norm([f[0] + right[0] * px + up[0] * py, f[1] + right[1] * px + up[1] * py, f[2] + right[2] * px + up[2] * py]);
            const den = dot(d, nf);
            const sky: V3 = [0.55, 0.65, 0.8];
            if (den > -1e-4) { for (let c = 0; c < 3; c++) acc[c] += sky[c] / 4; continue; }
            const tHit = dot([p0[0] - eye[0], p0[1] - eye[1], p0[2] - eye[2]], nf) / den;
            if (tHit <= 0 || tHit > 60) { for (let c = 0; c < 3; c++) acc[c] += sky[c] / 4; continue; }
            const hit: V3 = [eye[0] + d[0] * tHit, eye[1] + d[1] * tHit, eye[2] + d[2] * tHit];
            const rel: V3 = [hit[0] - p0[0], hit[1] - p0[1], hit[2] - p0[2]];
            const u = dot(rel, ax) / m.size[0], v = dot(rel, ay) / m.size[1];
            // texels of level 0 one pixel covers: the pixel's footprint on the plane (stretched by the grazing angle)
            const footM = tHit * pixelAngle / Math.max(0.05, -den);
            const footprint = footM / (m.size[0] / m.px);
            const c = shade(m, u, v, footprint, ax, ay, nf, [-d[0], -d[1], -d[2]]);
            for (let k = 0; k < 3; k++) acc[k] += c[k] / 4;
        }
        const o = (y * OW + ox + x) * 4;
        // a soft filmic shoulder so the sun does not clip
        for (let c = 0; c < 3; c++) out[o + c] = toSrgb(acc[c] / (1 + acc[c] * 0.35));
        out[o + 3] = 255;
    }
}

function loadMap(file: string): { rgba: Uint8Array; w: number; h: number } {
    const d = decodeImageToRgbaSync(fs.readFileSync(file));
    return { rgba: new Uint8Array(d.rgba), w: d.width, h: d.height };
}

function main(): void {
    const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : undefined; };
    let indexFile = arg('index'), mapFile: (rel: string) => string;
    if (indexFile) {
        const dir = path.dirname(path.resolve(indexFile));
        mapFile = rel => path.join(dir, rel);
    } else {
        const store = defaultDurableAssetStore();
        const found = store?.lookup('/models/surfaces/index.json');
        if (!store || !found) throw new Error('No surface library in the asset store (/models/surfaces/index.json); run scripts/generate_surface_textures.ts or pass --index');
        indexFile = found.file;
        mapFile = rel => { const f = store.lookup(`/models/surfaces/${rel}`); if (!f) throw new Error(`missing map /models/surfaces/${rel}`); return f.file; };
    }
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as SurfaceTextureIndex;
    const only = arg('only')?.split(',');
    const out = path.resolve(arg('out') ?? 'docs/screenshots/surface-swatches');
    fs.mkdirSync(out, { recursive: true });
    const W = 480, H = 320, OW = W * 2;
    const files: string[] = [];
    for (const e of index.surfaces.filter((s: SurfaceTextureEntry) => !only || only.includes(s.id))) {
        const c = loadMap(mapFile(e.maps.color)), n = loadMap(mapFile(e.maps.normal)), r = loadMap(mapFile(e.maps.roughness));
        const m: Material = { color: new Mipped(c.rgba, c.w, c.h, true), normal: new Mipped(n.rgba, n.w, n.h, false), rough: new Mipped(r.rgba, r.w, r.h, false), size: e.realSizeM, px: c.w };
        const img = new Uint8Array(OW * H * 4);
        // ground: eye 1.6 m, looking 12 degrees down along -z; plane y = 0 with u along x, v along -z
        renderView(m, W, H, [0, 1.6, 0], [0, -Math.tan(12 * Math.PI / 180), -1], 60, [0, 0, 0], [1, 0, 0], [0, 0, -1], img, 0, OW);
        // wall: plane x = 0 seen from 4 m at 35 degrees; u along -z, v up
        const a = 35 * Math.PI / 180;
        renderView(m, W, H, [4 * Math.cos(a), 1.6, 4 * Math.sin(a)], [-Math.cos(a), 0.05, -Math.sin(a)], 60, [0, 0, 0], [0, 0, -1], [0, 1, 0], img, W, OW);
        const file = path.join(out, `${e.id}.png`);
        fs.writeFileSync(file, encodePng(OW, H, img, 4));
        files.push(file);
        console.log(JSON.stringify({ id: e.id, sizeM: e.realSizeM, reliefM: e.surface.reliefM, roughness: e.surface.roughnessMean, file }));
    }
    fs.writeFileSync(path.join(out, 'files.txt'), files.join('\n'));
}

main();
