/**
 * Blob graph prototype (dev tool, not shipped): the renders the readers look at (plan §5.3), with the app's software
 * rasterizer (photo-match-eval.ts renderTriangles) on the welded scan's own photo textures.
 *
 * Per blob: four textured views round it, the same four in clay, a context view of its surroundings with the blob outlined,
 * and a held-out textured view the reader never sees (the judge's). Extra views on a reader's request: closer, lower,
 * other light (a clay render lit by a low sun with cast shadows), neighbour (a wider context).
 */
import * as fs from 'fs';
import * as path from 'path';
import { readTileTriangles, type TileTriangles } from '../../../packages/core/src/node/3d-engine/staged-location/tile-texture-transfer';
import { renderTriangles, composeGrid, sunDirection, type ArmRender } from '../../../packages/core/src/node/3d-engine/staged-location/photo-match-eval';
import { encodePng } from '../../../packages/core/src/node/3d-engine/staged-location/png-encode';
import type { PinholeCamera, OrthoCamera } from '../../../packages/core/src/common/spatial/texture-pass-contracts';

type V3 = [number, number, number];

export interface Scene {
    soup: TileTriangles;
    labels: Int32Array;
    /** Triangles of each blob. */
    members: number[][];
    /** Plan buckets of triangle indices (8 m cells). */
    buckets: Map<number, number[]>;
    centroid: Float32Array;
}

const BUCKET_M = 8;
const bucketKey = (i: number, k: number) => (i + 10000) * 20000 + (k + 10000);

export function loadScene(out: string, blobCount: number): Scene {
    const soup = readTileTriangles(fs.readFileSync(path.join(out, 'welded.glb')));
    const labels = new Int32Array(new Uint8Array(fs.readFileSync(path.join(out, 'split', 'labels.bin'))).buffer);
    const nt = soup.texture.length;
    if (labels.length !== nt) throw new Error(`labels ${labels.length} vs soup ${nt}`);
    const members: number[][] = Array.from({ length: blobCount }, () => []);
    const centroid = new Float32Array(nt * 3);
    const buckets = new Map<number, number[]>();
    const P = soup.positions;
    for (let t = 0; t < nt; t++) {
        const x = (P[t * 9] + P[t * 9 + 3] + P[t * 9 + 6]) / 3, y = (P[t * 9 + 1] + P[t * 9 + 4] + P[t * 9 + 7]) / 3, z = (P[t * 9 + 2] + P[t * 9 + 5] + P[t * 9 + 8]) / 3;
        centroid[t * 3] = x; centroid[t * 3 + 1] = y; centroid[t * 3 + 2] = z;
        if (labels[t] >= 0) members[labels[t]].push(t);
        const key = bucketKey(Math.floor(x / BUCKET_M), Math.floor(z / BUCKET_M));
        let b = buckets.get(key); if (!b) buckets.set(key, b = []);
        b.push(t);
    }
    return { soup, labels, members, buckets, centroid };
}

/** A soup of the given triangles (textures shared). `flat` paints them one linear colour instead of their photo. */
export function subset(s: TileTriangles, tris: ArrayLike<number>, flat?: V3): TileTriangles {
    const n = tris.length;
    const positions = new Float32Array(n * 9), uvs = new Float32Array(n * 6), normals = new Float32Array(n * 3), texture = new Int32Array(n), flatLinear = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
        const t = tris[k];
        positions.set(s.positions.subarray(t * 9, t * 9 + 9), k * 9);
        uvs.set(s.uvs.subarray(t * 6, t * 6 + 6), k * 6);
        normals.set(s.normals.subarray(t * 3, t * 3 + 3), k * 3);
        if (flat) { texture[k] = -1; flatLinear.set(flat, k * 3); }
        else { texture[k] = s.texture[t]; flatLinear.set(s.flatLinear.subarray(t * 3, t * 3 + 3), k * 3); }
    }
    return { positions, uvs, normals, texture, flatLinear, textures: s.textures };
}

export function boundsOf(s: Scene, tris: number[]): { lo: V3; hi: V3; centre: V3; radius: number } {
    const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    const P = s.soup.positions;
    for (const t of tris) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) { const v = P[t * 9 + j * 3 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    const centre: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    return { lo, hi, centre, radius: Math.max(0.5, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2) };
}

/** Triangles with centroids within `r` (plan) of (x, z), not in `exclude`. */
export function near(s: Scene, x: number, z: number, r: number, exclude?: Set<number>, cap = 400_000): number[] {
    const out: number[] = [];
    const i0 = Math.floor((x - r) / BUCKET_M), i1 = Math.floor((x + r) / BUCKET_M), k0 = Math.floor((z - r) / BUCKET_M), k1 = Math.floor((z + r) / BUCKET_M);
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
        const b = s.buckets.get(bucketKey(i, k));
        if (!b) continue;
        for (const t of b) {
            const dx = s.centroid[t * 3] - x, dz = s.centroid[t * 3 + 2] - z;
            if (dx * dx + dz * dz <= r * r && !exclude?.has(s.labels[t])) out.push(t);
        }
    }
    if (out.length > cap) { const step = out.length / cap; return Array.from({ length: cap }, (_, k) => out[Math.floor(k * step)]); }
    return out;
}

const norm = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A pinhole looking at `target` from azimuth `azDeg` (0 = from the south, +z; 90 = from the east) and elevation `elDeg`. */
export function orbit(target: V3, distance: number, azDeg: number, elDeg: number, size: number, fovDeg = 40): PinholeCamera {
    const az = (azDeg * Math.PI) / 180, el = (elDeg * Math.PI) / 180;
    const eye: V3 = [target[0] + distance * Math.cos(el) * Math.sin(az), target[1] + distance * Math.sin(el), target[2] + distance * Math.cos(el) * Math.cos(az)];
    const fwd = norm([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    const right = norm(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    const f = size / 2 / Math.tan(((fovDeg / 2) * Math.PI) / 180);
    return { eye, right, up, fwd, fx: f, fy: f, cx: size / 2, cy: size / 2, width: size, height: size };
}

export function topDown(lo: V3, hi: V3, pixelM: number): OrthoCamera {
    const w = Math.ceil((hi[0] - lo[0]) / pixelM), h = Math.ceil((hi[2] - lo[2]) / pixelM);
    return { projection: 'ortho', eye: [(lo[0] + hi[0]) / 2, hi[1] + 50, (lo[2] + hi[2]) / 2], right: [1, 0, 0], up: [0, 0, -1], fwd: [0, -1, 0], pixelM, cx: w / 2, cy: h / 2, width: w, height: h };
}

/** Draws the outline of the coverage mask (>= 0.5) in `colour`, `thick` px. */
export function outline(r: ArmRender, colour: V3 = [255, 0, 220], thick = 2): void {
    const { width: W, height: H, coverage } = r;
    const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && coverage[y * W + x] >= 0.5;
    const edge = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!inside(x, y)) continue;
        if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) edge[y * W + x] = 1;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!edge[y * W + x]) continue;
        for (let dy = -thick; dy <= thick; dy++) for (let dx = -thick; dx <= thick; dx++) {
            const a = x + dx, b = y + dy;
            if (a < 0 || b < 0 || a >= W || b >= H || inside(a, b)) continue;
            const o = (b * W + a) * 4;
            r.rgba[o] = colour[0]; r.rgba[o + 1] = colour[1]; r.rgba[o + 2] = colour[2];
        }
    }
}

export const png = (r: { width: number; height: number; rgba: Uint8Array }) => encodePng(r.width, r.height, r.rgba, 4);

export interface BlobViews { textured: ArmRender[]; clay: ArmRender[]; context: ArmRender; heldOut: ArmRender; covered: number[] }

export const READER_AZIMUTHS = [45, 135, 225, 315];
export const HELD_OUT = { az: 0, el: 55 };

/** The reader's standard views of one blob, and the judge's held-out one. */
export function blobViews(s: Scene, blob: number, size = 320): BlobViews {
    const tris = s.members[blob];
    const b = boundsOf(s, tris);
    const arm = subset(s.soup, tris);
    const dist = (b.radius / Math.sin((20 * Math.PI) / 180)) * 1.08;
    const el = 22;
    const textured = READER_AZIMUTHS.map(az => renderTriangles([arm], orbit(b.centre, dist, az, el, size), { supersample: 2 }));
    const clay = READER_AZIMUTHS.map(az => renderTriangles([arm], orbit(b.centre, dist, az, el, size), { supersample: 2, clay: true }));
    const heldOut = renderTriangles([arm], orbit(b.centre, dist, HELD_OUT.az, HELD_OUT.el, size), { supersample: 2 });
    const context = contextView(s, blob, size, 1);
    return { textured, clay, context, heldOut, covered: textured.map(r => coverShare(r)) };
}

const coverShare = (r: ArmRender) => { let c = 0; for (let i = 0; i < r.coverage.length; i++) c += r.coverage[i]; return c / r.coverage.length; };

/** The blob in its surroundings (photo textured), outlined. `scale` widens the view. */
export function contextView(s: Scene, blob: number, size: number, scale: number): ArmRender {
    const tris = s.members[blob];
    const b = boundsOf(s, tris);
    const reach = Math.max(25, b.radius * 2.5) * scale;
    const ctx = near(s, b.centre[0], b.centre[2], reach * 1.2, new Set([blob]), 250_000);
    const r = renderTriangles([subset(s.soup, tris)], orbit(b.centre, reach * 1.4, 30, 45, size, 50), { supersample: 2, context: [subset(s.soup, ctx)] });
    outline(r);
    return r;
}

export type ExtraView = 'closer' | 'lower' | 'other-light' | 'neighbour';

export function extraView(s: Scene, blob: number, kind: ExtraView, size = 320): ArmRender {
    const tris = s.members[blob];
    const b = boundsOf(s, tris);
    const arm = subset(s.soup, tris);
    const dist = (b.radius / Math.sin((20 * Math.PI) / 180)) * 1.08;
    if (kind === 'closer') return renderTriangles([arm], orbit(b.centre, dist * 0.55, 160, 15, size), { supersample: 2 });
    if (kind === 'lower') return renderTriangles([arm], orbit(b.centre, dist, 100, 3, size), { supersample: 2 });
    if (kind === 'other-light') return renderTriangles([arm], orbit(b.centre, dist, 200, 25, size), { supersample: 2, clay: true, lit: { sunDir: sunDirection(250, 20), shadowMapPx: 1024, aoSamples: 6 } });
    return contextView(s, blob, size, 3);
}

/** The reader's sheet: textured row, clay row, then context (PNG). */
export function readerSheet(v: BlobViews, title: string): Buffer {
    return composeGrid([
        ...v.textured.map((r, k) => ({ image: r, label: `PHOTO ${READER_AZIMUTHS[k]}` })),
        ...v.clay.map((r, k) => ({ image: r, label: `CLAY ${READER_AZIMUTHS[k]}` })),
        { image: v.context, label: 'CONTEXT (OUTLINED)' }
    ], { tileWidth: 320, columns: 4, title });
}
