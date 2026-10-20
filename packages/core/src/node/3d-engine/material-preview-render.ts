/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A software render of an object build with its part materials, under the same kind of light and backdrop the colour
 * reference is drawn with: a plain #808080 backdrop and even, soft, neutral white studio light (an overhead softbox,
 * a frontal key and a side fill, all white). It exists so the vision model can compare the build's surfaces with the
 * reference; the clay render (visual-review renderReviewViews) is for shape.
 *
 * Shading reads every factor of a part's material continuously: base colour, roughness, metalness, transmission,
 * ior, clearcoat and emission. Diffuse light is the studio irradiance; specular light is the studio's reflection,
 * sharper for lower roughness, with Schlick Fresnel (F0 from ior for a dielectric, the base colour for a metal).
 * See-through surfaces pass the light behind them, tinted by their base colour, and add their own reflection: the
 * pixel is (what is behind) x (product of every see-through layer's tint) + (sum of their reflections), which does
 * not depend on drawing order. A surface stops what is behind it in proportion to its opacity. Smooth vertex
 * normals, perspective-correct, 2x supersampled. No texture maps (the spec has none), no shadows, no refraction.
 *
 * Nothing here reads part ids or labels for meaning: a part without a material is studio clay.
 */

import type { PartMaterial } from '../../common/spatial/object-build-spec';
import { HeadlessMeshSilhouetteRenderer } from '../spatial/HeadlessMeshSilhouetteRenderer';
import type { TriangleSoup } from './part-connectivity';

/** Studio clay, as object_spec.py builds a part with no material. */
export const CLAY_PREVIEW_MATERIAL: PartMaterial = { baseColor: [0.55, 0.57, 0.6], roughness: 0.85, metalness: 0, transmission: 0 };

/** The reference backdrop: sRGB #808080, linear. */
const BACKDROP_LINEAR = Math.pow((128 / 255 + 0.055) / 1.055, 2.4);

export interface MaterialPreviewMesh {
    soup: TriangleSoup;
    material?: PartMaterial;
}

export interface MaterialPreviewView {
    azimuthDeg: number;
    elevationDeg: number;
}

type V3 = [number, number, number];
const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A soft studio light: direction it comes from, radiance, and how tight it is (a cosine-power lobe). */
interface StudioLight { dir: V3; radiance: number; tightness: number }

/**
 * The studio as seen from the object, in world axes, built around the camera's direction so the key always lights the
 * visible side the way a product photograph is lit: an overhead softbox, a white card around the camera, a key from
 * above the camera on its left, a fill from its right.
 */
function studioLights(toCamera: V3): StudioLight[] {
    const side = norm([toCamera[2], 0, -toCamera[0]]); // the camera's left, horizontal
    const key = norm([toCamera[0] * 0.8 + side[0] * 0.55, 0.75, toCamera[2] * 0.8 + side[2] * 0.55]);
    const fill = norm([toCamera[0] * 0.5 - side[0] * 0.85, 0.3, toCamera[2] * 0.5 - side[2] * 0.85]);
    const card = norm([toCamera[0], toCamera[1] + 0.25, toCamera[2]]);
    return [
        { dir: [0, 1, 0], radiance: 2.2, tightness: 6 },
        // a broad white bounce card around the camera, which flat metal facing the viewer reflects
        { dir: card, radiance: 1.3, tightness: 3 },
        { dir: key, radiance: 3.2, tightness: 24 },
        { dir: fill, radiance: 1.6, tightness: 14 }
    ];
}

/** Radiance of the studio seen along `d`: the grey surround plus the lights. */
function studioRadiance(d: V3, lights: StudioLight[], sharpness: number): number {
    // The surround a reflection picks up: the light room around the set (white walls and floor sweep; the grey
    // backdrop paper is only behind the object), a little brighter above.
    let r = 0.5 + 0.35 * Math.max(0, d[1]);
    for (const l of lights) {
        // A lobe widened by the surface's roughness (sharpness is the reflection's own cosine power): the two widths
        // combine, and the peak drops as the spread grows so the energy stays about the same.
        const p = 1 / (1 / l.tightness + 1 / Math.max(1, sharpness));
        const c = Math.max(0, dot(d, l.dir));
        r += l.radiance * Math.pow(c, p) * (p + 1) / (l.tightness + 1);
    }
    return r;
}

/** Irradiance on a surface facing `n` (cosine-weighted studio), scaled so a white diffuse surface reads about 0.8. */
function studioIrradiance(n: V3, lights: StudioLight[]): number {
    let e = BACKDROP_LINEAR * (1.1 + 0.5 * Math.max(0, n[1]));
    for (const l of lights) e += 0.22 * l.radiance * Math.max(0, dot(n, l.dir));
    return e;
}

/** Linear 0..1+ to an sRGB byte, with a soft shoulder so highlights do not clip flat. */
function toSrgbByte(x: number): number {
    const t = x <= 0 ? 0 : x < 0.8 ? x : 0.8 + 0.2 * (1 - Math.exp(-(x - 0.8) / 0.2));
    const s = t <= 0.0031308 ? 12.92 * t : 1.055 * Math.pow(t, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(s * 255)));
}

/** Area-weighted vertex normals of a soup. */
function vertexNormals(soup: TriangleSoup): Float32Array {
    const p = soup.positions, idx = soup.indices;
    const n = new Float32Array(p.length);
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const k of [a, b, c]) { n[k] += nx; n[k + 1] += ny; n[k + 2] += nz; }
    }
    for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1;
        n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
    }
    return n;
}

/** Per-material constants for shading. */
interface Shading {
    base: V3;
    metal: number;
    rough: number;
    /** Share of light that passes through (dielectric part only). */
    pass: number;
    f0: V3;
    clearcoat: number;
    emit: V3;
    /** Cosine power of the reflection lobe. */
    sharpness: number;
}

function shadingOf(m: PartMaterial): Shading {
    const ior = m.ior ?? 1.5;
    const f0d = Math.pow((ior - 1) / (ior + 1), 2);
    const metal = m.metalness, rough = Math.max(0.02, m.roughness);
    const alpha = rough * rough;
    const strength = m.emissiveStrength ?? (m.emissive ? 1 : 0);
    return {
        base: m.baseColor as V3,
        metal,
        rough,
        pass: m.transmission * (1 - metal),
        f0: [0, 1, 2].map(k => f0d * (1 - metal) + m.baseColor[k] * metal) as V3,
        clearcoat: m.clearcoat ?? 0,
        emit: m.emissive ? (m.emissive.map(c => c * strength) as V3) : [0, 0, 0],
        sharpness: Math.min(4000, Math.max(1, 2 / (alpha * alpha) - 2))
    };
}

/**
 * Shades one surface point: returns the light it sends to the camera (`add`) and the factor it multiplies the light
 * behind it by (`mult`, zero for an opaque surface).
 */
function shade(s: Shading, n: V3, v: V3, lights: StudioLight[]): { add: V3; mult: V3 } {
    const ndv = Math.max(1e-3, dot(n, v));
    const r: V3 = [2 * ndv * n[0] - v[0], 2 * ndv * n[1] - v[1], 2 * ndv * n[2] - v[2]];
    const spec = studioRadiance(r, lights, s.sharpness);
    const irr = studioIrradiance(n, lights);
    const grazing = Math.pow(1 - ndv, 5) * (1 - s.rough);
    const ccF = s.clearcoat * (0.04 + 0.96 * Math.pow(1 - ndv, 5));
    const ccSpec = s.clearcoat > 0 ? studioRadiance(r, lights, 2000) : 0;
    const add: V3 = [0, 0, 0], mult: V3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
        const F = s.f0[k] + (1 - s.f0[k]) * grazing;
        const diffuse = s.base[k] * (1 - s.metal) * (1 - s.pass) * irr * (1 - F);
        add[k] = (diffuse + F * spec) * (1 - ccF) + ccF * ccSpec + s.emit[k];
        mult[k] = s.pass * (1 - F) * (1 - ccF) * s.base[k];
    }
    return { add, mult };
}

/**
 * Renders the meshes from one view, framed the way the review renders are (whole object, 40 degree field of view),
 * at `size` pixels square, as a PNG.
 */
export function renderMaterialPreview(meshes: MaterialPreviewMesh[], view: MaterialPreviewView, size = 512): Buffer {
    const ss = 2;
    const W = size * ss, H = size * ss;
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const m of meshes) {
        const p = m.soup.positions;
        for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]); }
    }
    if (!Number.isFinite(min[0])) throw new Error('renderMaterialPreview: nothing to render');
    const center: V3 = [0, 1, 2].map(k => (min[k] + max[k]) / 2) as V3;
    const radius = Math.max(1e-3, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2);
    const fov = 40;
    const distance = (radius / Math.sin((fov * Math.PI) / 360)) * 1.15;
    const az = (view.azimuthDeg * Math.PI) / 180, el = (view.elevationDeg * Math.PI) / 180;
    const toCam: V3 = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
    const eye: V3 = [center[0] + distance * toCam[0], center[1] + distance * toCam[1], center[2] + distance * toCam[2]];
    const fwd = norm([center[0] - eye[0], center[1] - eye[1], center[2] - eye[2]]);
    const right = norm([-fwd[2], 0, fwd[0]]);
    const up: V3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const focal = 1 / Math.tan((fov * Math.PI) / 360);
    const lights = studioLights(toCam);
    const near = 1e-3;

    // Nearest opaque surface per sample, then the see-through layers in front of it.
    const depth = new Float32Array(W * H).fill(Infinity);
    const colour = new Float32Array(W * H * 3);
    const mult = new Float32Array(W * H * 3).fill(1);
    const glassAdd = new Float32Array(W * H * 3);
    for (let i = 0; i < W * H; i++) for (let k = 0; k < 3; k++) colour[i * 3 + k] = BACKDROP_LINEAR;

    type Proj = { sx: Float32Array; sy: Float32Array; iz: Float32Array; normals: Float32Array };
    const projected: Proj[] = meshes.map(m => {
        const p = m.soup.positions, count = p.length / 3;
        const sx = new Float32Array(count), sy = new Float32Array(count), iz = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const dx = p[i * 3] - eye[0], dy = p[i * 3 + 1] - eye[1], dz = p[i * 3 + 2] - eye[2];
            const z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
            const x = dx * right[0] + dy * right[1] + dz * right[2];
            const y = dx * up[0] + dy * up[1] + dz * up[2];
            iz[i] = z > near ? 1 / z : 0;
            sx[i] = (focal * x * iz[i] + 1) * 0.5 * W;
            sy[i] = (1 - focal * y * iz[i]) * 0.5 * H;
        }
        return { sx, sy, iz, normals: vertexNormals(m.soup) };
    });

    const raster = (opaquePass: boolean) => {
        meshes.forEach((m, mi) => {
            const s = shadingOf(m.material ?? CLAY_PREVIEW_MATERIAL);
            const seeThrough = s.pass > 0;
            if (opaquePass === seeThrough) return;
            const { sx, sy, iz, normals } = projected[mi];
            const idx = m.soup.indices, pos = m.soup.positions;
            for (let t = 0; t < idx.length; t += 3) {
                const a = idx[t], b = idx[t + 1], c = idx[t + 2];
                if (!iz[a] || !iz[b] || !iz[c]) continue;
                const x0 = sx[a], y0 = sy[a], x1 = sx[b], y1 = sy[b], x2 = sx[c], y2 = sy[c];
                const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
                if (Math.abs(area) < 1e-9) continue;
                const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
                const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
                for (let py = minY; py <= maxY; py++) {
                    const cy = py + 0.5;
                    for (let px = minX; px <= maxX; px++) {
                        const cx = px + 0.5;
                        let w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
                        let w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
                        let w2 = 1 - w0 - w1;
                        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                        const izp = w0 * iz[a] + w1 * iz[b] + w2 * iz[c];
                        const z = 1 / izp;
                        const pi = py * W + px;
                        if (z >= depth[pi]) continue;
                        // perspective-correct weights
                        w0 = (w0 * iz[a]) / izp; w1 = (w1 * iz[b]) / izp; w2 = 1 - w0 - w1;
                        let n: V3 = norm([
                            w0 * normals[a * 3] + w1 * normals[b * 3] + w2 * normals[c * 3],
                            w0 * normals[a * 3 + 1] + w1 * normals[b * 3 + 1] + w2 * normals[c * 3 + 1],
                            w0 * normals[a * 3 + 2] + w1 * normals[b * 3 + 2] + w2 * normals[c * 3 + 2]
                        ]);
                        const wp: V3 = [
                            w0 * pos[a * 3] + w1 * pos[b * 3] + w2 * pos[c * 3],
                            w0 * pos[a * 3 + 1] + w1 * pos[b * 3 + 1] + w2 * pos[c * 3 + 1],
                            w0 * pos[a * 3 + 2] + w1 * pos[b * 3 + 2] + w2 * pos[c * 3 + 2]
                        ];
                        const v = norm([eye[0] - wp[0], eye[1] - wp[1], eye[2] - wp[2]]);
                        // Surfaces are seen from either side (open sweeps, the inside of a vessel).
                        if (dot(n, v) < 0) n = [-n[0], -n[1], -n[2]];
                        const out = shade(s, n, v, lights);
                        if (opaquePass) {
                            depth[pi] = z;
                            for (let k = 0; k < 3; k++) colour[pi * 3 + k] = out.add[k];
                        } else {
                            for (let k = 0; k < 3; k++) {
                                glassAdd[pi * 3 + k] += out.add[k];
                                mult[pi * 3 + k] *= out.mult[k];
                            }
                        }
                    }
                }
            }
        });
    };
    raster(true);
    raster(false);

    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const acc = [0, 0, 0];
            for (let dy = 0; dy < ss; dy++) {
                for (let dx = 0; dx < ss; dx++) {
                    const i = (y * ss + dy) * W + x * ss + dx;
                    for (let k = 0; k < 3; k++) acc[k] += colour[i * 3 + k] * mult[i * 3 + k] + glassAdd[i * 3 + k];
                }
            }
            const o = (y * size + x) * 4;
            for (let k = 0; k < 3; k++) rgba[o + k] = toSrgbByte(acc[k] / (ss * ss));
            rgba[o + 3] = 255;
        }
    }
    return HeadlessMeshSilhouetteRenderer.encodePng(size, size, rgba);
}

/** The meshes of a build with each part's material from its spec, for renderMaterialPreview. */
export function materialPreviewMeshes(named: Map<string, TriangleSoup>, materialOf: (partId: string) => PartMaterial | undefined): MaterialPreviewMesh[] {
    return [...named].filter(([, s]) => s.indices.length > 0).map(([id, soup]) => ({ soup, material: materialOf(id) }));
}

