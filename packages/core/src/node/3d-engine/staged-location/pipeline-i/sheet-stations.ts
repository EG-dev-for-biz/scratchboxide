/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The four character-sheet stations of an isolated structure, planned from the scan alone: the facade axes from the
 * minimum-area rectangle of the raised scan, then the two adjacent faces with the most outward-facing scanned wall (a
 * party wall the scan never saw is not one of them) each get a straight-on station, then their shared corner and an
 * aerial over that corner. Every station stands far enough out to frame the whole structure, street to the top of its
 * roof objects, with a margin. Nothing here knows what the structure is.
 */

import { stationFromLookAt } from '../../../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose, GeodeticAnchor } from '../../../../common/spatial/colmap-vector-reference-types';
import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';

/** A 24 mm lens on full frame, 16:9: the survey stations' optics (pipeline G's STATION_OPTICS). */
export const SHEET_OPTICS = { focalLengthMm: 24, sensorWidthMm: 36, aspectRatio: 16 / 9 };
/** Framing margin around the structure. */
export const SHEET_MARGIN = 1.15;
/** Height above the ground below which the scan is street, not structure. */
const RAISED_M = 3;
const AERIAL_ELEVATION_DEG = 35;

type V3 = [number, number, number];

export interface SheetStationPlan {
    stations: ColmapCameraPose[];
    /** The facade axis (degrees from +x toward +z) and the scanned wall area facing each of the four directions. */
    axisDeg: number;
    wallAreaM2: number[];
    /** Index of the first of the two adjacent faces chosen. */
    pair: number;
    heightM: number;
}

const pct = (sorted: Float64Array, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p / 100 * (sorted.length - 1))))];
const sortedOf = (a: number[] | Float64Array) => Float64Array.from(a).sort();

export function planSheetStations(mesh: RenderMesh3D, groundY: number, anchor: GeodeticAnchor): SheetStationPlan {
    const v = mesh.vertices, idx = mesh.indices;
    const up: Array<[number, number, number]> = [];
    for (let i = 0; i < v.length; i += 3) if (v[i + 1] > groundY + RAISED_M) up.push([v[i], v[i + 1], v[i + 2]]);
    if (up.length < 20) throw new Error('planSheetStations: the scan has no raised structure to frame');
    // facade axes: the rotation whose 1st-99th percentile plan rectangle is smallest
    let best = { area: Infinity, a: 0 };
    for (let deg = 0; deg < 90; deg += 0.5) {
        const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
        const us = sortedOf(up.map(p => p[0] * c + p[2] * s)), vs = sortedOf(up.map(p => -p[0] * s + p[2] * c));
        const area = (pct(us, 99) - pct(us, 1)) * (pct(vs, 99) - pct(vs, 1));
        if (area < best.area) best = { area, a };
    }
    const ax0: V3 = [Math.cos(best.a), 0, Math.sin(best.a)], ax1: V3 = [-Math.sin(best.a), 0, Math.cos(best.a)];
    const dirs: V3[] = [ax0, ax1, [-ax0[0], 0, -ax0[2]], [-ax1[0], 0, -ax1[2]]];   // outward normals, in order around the plan
    // scanned wall area facing each direction (raised triangles whose normal is within ~45 deg of it)
    const wall = [0, 0, 0, 0];
    for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
        if ((v[a + 1] + v[b + 1] + v[c + 1]) / 3 < groundY + RAISED_M) continue;
        const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2], wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
        const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, len = Math.hypot(nx, ny, nz);
        if (len < 1e-9) continue;
        for (let k = 0; k < 4; k++) if ((nx * dirs[k][0] + nz * dirs[k][2]) / len > 0.7) wall[k] += len / 2;
    }
    let pair = 0;
    for (let k = 1; k < 4; k++) if (wall[k] + wall[(k + 1) % 4] > wall[pair] + wall[(pair + 1) % 4]) pair = k;
    const fa = dirs[pair], fb = dirs[(pair + 1) % 4];
    const ys = sortedOf(up.map(p => p[1])), top = pct(ys, 99.8), H = top - groundY, cy = groundY + H / 2;
    const proj = (d: V3) => sortedOf(up.map(p => p[0] * d[0] + p[2] * d[2]));
    const th = Math.tan(Math.atan(SHEET_OPTICS.sensorWidthMm / 2 / SHEET_OPTICS.focalLengthMm)), tv = th / SHEET_OPTICS.aspectRatio;
    const p0 = proj(ax0), p1 = proj(ax1);
    const centre: V3 = [0, cy, 0];
    for (const [d, p] of [[ax0, p0], [ax1, p1]] as Array<[V3, Float64Array]>) {
        const mid = (pct(p, 1) + pct(p, 99)) / 2; centre[0] += d[0] * mid; centre[2] += d[2] * mid;
    }
    const stations: ColmapCameraPose[] = [];
    for (const [i, d] of [fa, fb].entries()) {
        const perp: V3 = [-d[2], 0, d[0]], pp = proj(perp), pd = proj(d);
        const width = pct(pp, 99) - pct(pp, 1), offset = (pct(pp, 1) + pct(pp, 99)) / 2;
        const face: V3 = [perp[0] * offset + d[0] * pct(pd, 99), cy, perp[2] * offset + d[2] * pct(pd, 99)];
        const dist = Math.max(H / 2 * SHEET_MARGIN / tv, width / 2 * SHEET_MARGIN / th);
        stations.push(stationFromLookAt(i + 1, [face[0] + d[0] * dist, cy, face[2] + d[2] * dist], face, SHEET_OPTICS, anchor, { name: `SHEET_FACE_${'AB'[i]}` }));
    }
    const dl = Math.hypot(fa[0] + fb[0], fa[2] + fb[2]), diag: V3 = [(fa[0] + fb[0]) / dl, 0, (fa[2] + fb[2]) / dl];
    const r = 0.5 * Math.hypot(pct(p0, 99) - pct(p0, 1), pct(p1, 99) - pct(p1, 1), H);
    const d3 = r * SHEET_MARGIN / Math.sin(Math.atan(tv));
    stations.push(stationFromLookAt(3, [centre[0] + diag[0] * d3, cy, centre[2] + diag[2] * d3], centre, SHEET_OPTICS, anchor, { name: 'SHEET_CORNER' }));
    const el = AERIAL_ELEVATION_DEG * Math.PI / 180, d4 = d3 * 1.1;
    stations.push(stationFromLookAt(4, [centre[0] + diag[0] * Math.cos(el) * d4, cy + Math.sin(el) * d4, centre[2] + diag[2] * Math.cos(el) * d4], centre, SHEET_OPTICS, anchor, { name: 'SHEET_AERIAL' }));
    return { stations, axisDeg: best.a * 180 / Math.PI, wallAreaM2: wall.map(w => Math.round(w)), pair, heightM: H };
}
