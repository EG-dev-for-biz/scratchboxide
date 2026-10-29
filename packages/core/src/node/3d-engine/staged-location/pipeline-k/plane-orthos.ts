/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Every plane of the building, photographed face on: openings can sit on any plane (a roof's skylights, a terrace's glass
 * rail, a return wall tile_refine did not analyse), so the facade reader (facade-reader.ts) reads them all, not only the
 * walls tile_refine wrote orthophotos of.
 *
 * The textured scan's triangles are grown into planes and the coplanar neighbours joined (MaterialDetailBaker's
 * buildPlaneClusters / mergeCoplanarClusters, any orientation). A plane at least PLANE_ORTHOS_PARAMS.minAreaM2 that no
 * facade orthophoto already covers (same facing, within 0.8 m of its plane, inside its rectangle) is rendered face on from
 * the scan's own photo texels at pixelM a pixel (transparent where no triangle of the plane lies), into plane_<id>.png
 * beside facades.json, in the same frame convention (world = centroid + s axisS + t axisT; pixel x at s = orthoSMin + x
 * pixel, y at t = orthoTMax - y pixel). Its t axis is up for a wall or a slope, and for a flat roof the plane's long axis
 * (its edges' dominant direction), so a roof's rows of openings run along the image's axes. planes.json lists them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { buildPlaneClusters, LinearImageCache, loadBaseScan, mergeCoplanarClusters, type PlaneCluster } from '../../../spatial/MaterialDetailBaker';
import { encodePng } from '../png-encode';

export const PLANE_ORTHOS_VERSION = 'plane-orthos/1';

export const PLANE_ORTHOS_PARAMS = {
    /** Planes smaller than this are not photographed. */
    minAreaM2: 25,
    /** Ortho resolution (m a pixel), coarsened so neither side exceeds maxSidePx. */
    pixelM: 0.1, maxSidePx: 2400,
    /** Ids of these planes start here (facades.json's walls keep theirs; wall sheets take 10000 on). */
    firstId: 20000
} as const;

export interface PlaneFrame {
    facadeId: number; image: string; kind: 'wall' | 'slope' | 'roof';
    centroid: number[]; normal: number[]; axisS: number[]; axisT: number[];
    sMin: number; sMax: number; tMin: number; tMax: number;
    orthoSMin: number; orthoTMax: number; pixel: number; texel: number; width: number; height: number;
    coverage: number; areaM2: number;
}

export interface PlaneOrthosFile { version: string; params: typeof PLANE_ORTHOS_PARAMS; source: string; ms: number; planes: PlaneFrame[]; skipped: { covered: number; small: number } }

export const PLANES_FILE = 'planes.json';

type V3 = [number, number, number];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** The plane's frame: t up the plane for a wall or a slope; for a roof (facing within 25 degrees of up or down) its long axis. */
function frameOf(c: PlaneCluster, pts: number[]): { S: V3; T: V3; kind: PlaneFrame['kind'] } {
    const N = c.normal as V3, up: V3 = [0, 1, 0];
    if (Math.abs(N[1]) < Math.cos((25 * Math.PI) / 180)) {
        const T = norm([up[0] - N[0] * N[1], up[1] - N[1] * N[1], up[2] - N[2] * N[1]]);
        return { S: norm(cross(T, N)), T, kind: Math.abs(N[1]) < 0.3 ? 'wall' : 'slope' };
    }
    // the edges' dominant direction (their angles folded to a quarter turn, weighted by length): a roof's openings and its
    // outline run along its walls, so its rows of openings then run along the image's axes
    const a = norm(cross(N, Math.abs(N[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1])), b = cross(N, a);
    let C = 0, Sn = 0;
    for (let i = 0; i + 8 < pts.length; i += 9) for (const [u, v] of [[0, 3], [3, 6], [6, 0]]) {
        const e = [pts[i + v] - pts[i + u], pts[i + v + 1] - pts[i + u + 1], pts[i + v + 2] - pts[i + u + 2]], ex = dot(e, a), ey = dot(e, b), len = Math.hypot(ex, ey);
        if (!(len > 0)) continue;
        const th = Math.atan2(ey, ex);
        C += len * Math.cos(4 * th); Sn += len * Math.sin(4 * th);
    }
    const ang = Math.atan2(Sn, C) / 4;
    const T = norm([a[0] * Math.cos(ang) + b[0] * Math.sin(ang), a[1] * Math.cos(ang) + b[1] * Math.sin(ang), a[2] * Math.cos(ang) + b[2] * Math.sin(ang)]);
    return { S: norm(cross(T, N)), T, kind: 'roof' };
}

/**
 * Photographs every plane of `texturedGlb` the facade orthophotos in `orthosDir` (facades.json) do not cover, writing
 * plane_<id>.png and planes.json there. Done once per scan: a planes.json of this version and source is returned as it is.
 */
export async function planeOrthos(texturedGlb: string, orthosDir: string, P = PLANE_ORTHOS_PARAMS): Promise<{ file: PlaneOrthosFile; cached: boolean }> {
    const out = path.join(orthosDir, PLANES_FILE);
    const source = `${path.basename(path.dirname(texturedGlb))}/${path.basename(texturedGlb)}:${fs.statSync(texturedGlb).size}`;
    if (fs.existsSync(out)) {
        const prior = JSON.parse(fs.readFileSync(out, 'utf8')) as PlaneOrthosFile;
        if (prior.version === PLANE_ORTHOS_VERSION && prior.source === source && JSON.stringify(prior.params) === JSON.stringify(P)) return { file: prior, cached: true };
    }
    const t0 = Date.now();
    const scan = loadBaseScan(texturedGlb);
    const grown = buildPlaneClusters(scan);
    const { triCluster, clusters } = mergeCoplanarClusters(grown.triCluster, grown.clusters);
    const ff = path.join(orthosDir, 'facades.json');
    const facades = fs.existsSync(ff) ? JSON.parse(fs.readFileSync(ff, 'utf8')).facades as Array<{ centroid: number[]; normal: number[]; axisS: number[]; axisT: number[]; sMin: number; sMax: number; tMin: number; tMax: number }> : [];
    const coveredByFacade = (c: PlaneCluster) => facades.some(f => {
        if (dot(c.normal, f.normal) < 0.95) return false;
        const d = [0, 1, 2].map(k => (c.min[k] + c.max[k]) / 2 - f.centroid[k]);
        if (Math.abs(dot(d, f.normal)) > 0.8) return false;
        const s = dot(d, f.axisS), t = dot(d, f.axisT);
        return s >= f.sMin - 1 && s <= f.sMax + 1 && t >= f.tMin - 1 && t <= f.tMax + 1;
    });
    const skipped = { covered: 0, small: 0 };
    const chosen = clusters.filter(c => { if (c.area < P.minAreaM2) { skipped.small++; return false; } if (coveredByFacade(c)) { skipped.covered++; return false; } return true; }).sort((a, b) => b.area - a.area);
    // each chosen plane's triangles (world corners and photo UVs)
    const index = new Map(chosen.map((c, i) => [c.id, i]));
    const tris: Array<Array<{ p: (typeof scan.prims)[number]; t: number }>> = chosen.map(() => []);
    for (const p of scan.prims) for (let t = 0; t < p.indices.length / 3; t++) { const i = index.get(triCluster[p.triOffset + t]); if (i !== undefined) tris[i].push({ p, t }); }
    const images = new LinearImageCache(scan);
    const planes: PlaneFrame[] = [];
    for (let i = 0; i < chosen.length; i++) {
        const c = chosen[i], list = tris[i];
        const pts: number[] = [];
        for (const { p, t } of list) for (let k = 0; k < 3; k++) { const v = p.indices[t * 3 + k]; pts.push(p.positions[v * 3], p.positions[v * 3 + 1], p.positions[v * 3 + 2]); }
        if (!pts.length) continue;
        const { S, T, kind } = frameOf(c, pts);
        const ctr = [0, 1, 2].map(k => (c.min[k] + c.max[k]) / 2);
        // the plane passes through its fitted offset: the centroid moved onto it
        const off = dot(ctr, c.normal) - c.offset, centroid = ctr.map((v, k) => v - off * c.normal[k]);
        let sMin = Infinity, sMax = -Infinity, tMin = Infinity, tMax = -Infinity;
        for (let q = 0; q < pts.length; q += 3) { const d = [pts[q] - centroid[0], pts[q + 1] - centroid[1], pts[q + 2] - centroid[2]]; const s = dot(d, S), t = dot(d, T); sMin = Math.min(sMin, s); sMax = Math.max(sMax, s); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); }
        const pixel = Math.max(P.pixelM, (sMax - sMin) / P.maxSidePx, (tMax - tMin) / P.maxSidePx);
        const W = Math.max(1, Math.ceil((sMax - sMin) / pixel)), H = Math.max(1, Math.ceil((tMax - tMin) / pixel));
        const rgba = new Uint8Array(W * H * 4);
        for (const { p, t } of list) {
            if (p.imageIndex === null || !p.uvs) continue;
            const img = await images.get(p.imageIndex);
            if (!img) continue;
            const q: Array<[number, number]> = [], uv: Array<[number, number]> = [];
            for (let k = 0; k < 3; k++) {
                const v = p.indices[t * 3 + k], d = [p.positions[v * 3] - centroid[0], p.positions[v * 3 + 1] - centroid[1], p.positions[v * 3 + 2] - centroid[2]];
                q.push([(dot(d, S) - sMin) / pixel, (tMax - dot(d, T)) / pixel]);
                uv.push([p.uvs[v * 2], p.uvs[v * 2 + 1]]);
            }
            const area = (q[1][0] - q[0][0]) * (q[2][1] - q[0][1]) - (q[1][1] - q[0][1]) * (q[2][0] - q[0][0]);
            if (Math.abs(area) < 1e-9) continue;
            const x0 = Math.max(0, Math.floor(Math.min(q[0][0], q[1][0], q[2][0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(q[0][0], q[1][0], q[2][0])));
            const y0 = Math.max(0, Math.floor(Math.min(q[0][1], q[1][1], q[2][1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(q[0][1], q[1][1], q[2][1])));
            for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                const px = x + 0.5, py = y + 0.5;
                const w0 = ((q[1][0] - px) * (q[2][1] - py) - (q[1][1] - py) * (q[2][0] - px)) / area;
                const w1 = ((q[2][0] - px) * (q[0][1] - py) - (q[2][1] - py) * (q[0][0] - px)) / area;
                const w2 = 1 - w0 - w1;
                if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
                const u = (uv[0][0] * w0 + uv[1][0] * w1 + uv[2][0] * w2) * img.width - 0.5, v = (uv[0][1] * w0 + uv[1][1] * w1 + uv[2][1] * w2) * img.height - 0.5;
                const xi = Math.min(img.width - 1, Math.max(0, Math.round(u))), yi = Math.min(img.height - 1, Math.max(0, Math.round(v)));
                const k = (yi * img.width + xi) * 4, o = (y * W + x) * 4;
                rgba[o] = img.srgb[k]; rgba[o + 1] = img.srgb[k + 1]; rgba[o + 2] = img.srgb[k + 2]; rgba[o + 3] = 255;
            }
        }
        let filled = 0; for (let k = 3; k < rgba.length; k += 4) if (rgba[k]) filled++;
        if (!filled) continue;
        const id = P.firstId + planes.length, image = `plane_${id}.png`;
        fs.writeFileSync(path.join(orthosDir, image), encodePng(W, H, rgba, 4));
        const r3 = (v: number) => Math.round(v * 1e4) / 1e4;
        planes.push({
            facadeId: id, image, kind, centroid: centroid.map(r3), normal: (c.normal as number[]).map(r3), axisS: S.map(r3), axisT: T.map(r3),
            sMin: r3(sMin), sMax: r3(sMax), tMin: r3(tMin), tMax: r3(tMax), orthoSMin: r3(sMin), orthoTMax: r3(tMax), pixel: r3(pixel), texel: r3(pixel), width: W, height: H,
            coverage: Math.round((filled / (W * H)) * 1000) / 1000, areaM2: Math.round(c.area)
        });
    }
    const file: PlaneOrthosFile = { version: PLANE_ORTHOS_VERSION, params: P, source, ms: Date.now() - t0, planes, skipped };
    fs.writeFileSync(out, JSON.stringify(file));
    return { file, cached: false };
}
