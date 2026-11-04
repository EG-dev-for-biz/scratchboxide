/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The scan's own streets settled flat (pipeline K-D): the photo tiles' carriageways and sidewalks are lumpy (the
 * photogrammetry's noise, the patches where vehicles were removed), so each is moved onto the level SB-Roadie measures
 * across it (road-surfaces.ts measureRoadSurfaces: every 2 m along Google's road centrelines, the carriageway's level at
 * five places kerb to kerb and each sidewalk's level), smoothed along the street over a few stations. The street keeps its
 * grade and camber; only the bumps go. Nothing new is drawn: the scan's own vertices move up or down, never sideways, so
 * the photo stays where it was.
 *
 * Moved only where it is safe: a vertex between two measured kerbs (or on a sidewalk beside one), no triangle it belongs
 * to near vertical, within `toleranceM` of the level (so a car left behind, a bollard, a kerb face, a wall or a tree
 * is never pulled down), and clear of the kerb lines by `kerbMarginM` (the kerb's step stays sharp). A station with a
 * median is left as scanned. The moved vertices' normals point straight up.
 */

import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import type { RoadStation, RoadSurface } from './road-surfaces';
import { ROAD_SURFACE_PARAMS } from './road-surfaces';
import { assembleGlb, invert, isIdentity, nodeWorldMatrices, parseGlbBytes, transformPoint } from './glb-bytes';

export const ROAD_FLATTEN_VERSION = 'road-flatten/1';

export const ROAD_FLATTEN_PARAMS = {
    /** Each station's levels are averaged with this many stations either side along the street (2 m apart: 8 m in all). */
    smoothStations: 2,
    /** Consecutive stations further apart than this (m) are two runs (a gap where the street was not measured). */
    maxStationGapM: 3,
    /** A carriageway vertex moves only when it lies within this of the level (m). */
    toleranceM: 0.25,
    /** A sidewalk vertex moves only when it lies within this of the sidewalk's level (m): a kerb is about 0.15 m high. */
    sidewalkToleranceM: 0.12,
    /** Vertices this close to a kerb line, either side (m), stay where they are, so the kerb's step stays sharp. */
    kerbMarginM: 0.2,
    /** A sidewalk is settled only where its kerb top stands this far above the carriageway's edge (m): a kerb's height. */
    kerbRiseMinM: 0.03, kerbRiseMaxM: 0.35,
    /**
     * A vertex stays where it is when a triangle it belongs to is steeper than this (the normal's y below it): a wall, a
     * pole, a kerb face. Low, so the street's own lumps (small steep facets within the tolerance) are flattened, not kept
     * as spikes in a flat street.
     */
    minUp: 0.3,
    /** The lookup grid's cell (m). */
    cellM: 4
};
export type RoadFlattenParams = typeof ROAD_FLATTEN_PARAMS;

/** SCRATCHBOX_KD_ROAD_FLATTEN=0 leaves the streets as scanned. */
export function roadFlattenEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_KD_ROAD_FLATTEN?.trim() !== '0';
}

/** A station's levels after smoothing along its run: the carriageway profile (lift taken off) and each sidewalk's level. */
interface Smoothed {
    s: RoadStation;
    profile: number[];
    left?: { level: number; widthM: number };
    right?: { level: number; widthM: number };
}

/** Where a plan point stands on the measured streets: the level it is settled to, and which surface that is. */
export interface FlattenTarget { level: number; zone: 'carriageway' | 'sidewalk' }

/**
 * The measured streets as a lookup: a plan point's target level, or undefined off every street (or too near a kerb, or
 * where a median runs). Each street is cut into runs where stations are missing; within a run each station's levels are
 * the mean of its neighbours', and a point between two stations takes the levels interpolated along and across.
 */
export function flattenTargets(roads: RoadSurface[], P: RoadFlattenParams = ROAD_FLATTEN_PARAMS, opts: { liftM?: number; /** A building (> 0) at a point: never a street there, whatever the measured widths say. */ buildingAt?: (x: number, z: number) => number } = {}): (x: number, z: number) => FlattenTarget | undefined {
    const liftM = opts.liftM ?? ROAD_SURFACE_PARAMS.liftM;
    const segments: Array<{ a: Smoothed; b: Smoothed }> = [];
    // a station is used only when both its kerbs rise a kerb's height above the carriageway's edge: where the scan's first
    // rise was a wall, a scaffold shed or a parked car, the measured carriageway runs over the sidewalk to it, and settling
    // it would pull the sidewalk down and erase the kerb
    const kerbRise = (t: RoadStation, side: 'left' | 'right') => {
        const k = t[side].kerbTopY;
        return k === undefined ? NaN : k - (t.profile[side === 'left' ? 0 : 4] - liftM);
    };
    const believable = (t: RoadStation) => (['left', 'right'] as const).every(side => { const r = kerbRise(t, side); return r >= P.kerbRiseMinM && r <= P.kerbRiseMaxM; });
    for (const road of roads) {
        const runs: RoadStation[][] = [];
        for (const s of road.stations.filter(believable)) {
            const run = runs[runs.length - 1], last = run?.[run.length - 1];
            if (last && Math.hypot(s.x - last.x, s.z - last.z) <= P.maxStationGapM) run.push(s); else runs.push([s]);
        }
        for (const run of runs) {
            const sm: Smoothed[] = run.map((s, i) => {
                const near = run.slice(Math.max(0, i - P.smoothStations), i + P.smoothStations + 1);
                const profile = s.profile.map((_, j) => near.reduce((a, t) => a + t.profile[j], 0) / near.length - liftM);
                // a sidewalk's level is its kerb's top, read at the kerb edge (the scan's highest surface further out is as
                // often a scaffold shed, an awning or a tree as the pavement), kept only when it stands a kerb's height
                // above the carriageway's edge beside it
                const kerbTop = (t: RoadStation, side: 'left' | 'right') => {
                    const r = kerbRise(t, side);
                    return r >= P.kerbRiseMinM && r <= P.kerbRiseMaxM ? t[side].kerbTopY : undefined;
                };
                const side = (name: 'left' | 'right') => {
                    const own = s[name].sidewalk;
                    if (!own || kerbTop(s, name) === undefined) return undefined;
                    const tops = near.map(t => (t[name].sidewalk ? kerbTop(t, name) : undefined)).filter((k): k is number => k !== undefined);
                    return { level: tops.reduce((a, k) => a + k, 0) / tops.length, widthM: own.widthM };
                };
                const left = side('left'), right = side('right');
                return { s, profile, ...(left ? { left } : {}), ...(right ? { right } : {}) };
            });
            for (let i = 0; i + 1 < sm.length; i++) segments.push({ a: sm[i], b: sm[i + 1] });
        }
    }
    // each segment filed in the cells its reach covers (the kerbs and sidewalks either side)
    const grid = new Map<string, number[]>();
    const key = (i: number, k: number) => `${i},${k}`;
    segments.forEach(({ a, b }, n) => {
        const reach = Math.max(a.s.left.halfWidthM + (a.left?.widthM ?? 0), a.s.right.halfWidthM + (a.right?.widthM ?? 0), b.s.left.halfWidthM + (b.left?.widthM ?? 0), b.s.right.halfWidthM + (b.right?.widthM ?? 0)) + 1;
        const x0 = Math.min(a.s.x, b.s.x) - reach, x1 = Math.max(a.s.x, b.s.x) + reach, z0 = Math.min(a.s.z, b.s.z) - reach, z1 = Math.max(a.s.z, b.s.z) + reach;
        for (let i = Math.floor(x0 / P.cellM); i <= Math.floor(x1 / P.cellM); i++) for (let k = Math.floor(z0 / P.cellM); k <= Math.floor(z1 / P.cellM); k++) {
            const l = grid.get(key(i, k));
            if (l) l.push(n); else grid.set(key(i, k), [n]);
        }
    });
    const lerp = (p: number, q: number, u: number) => p + (q - p) * u;
    return (x, z) => {
        if (opts.buildingAt && opts.buildingAt(x, z) > 0) return undefined;
        for (const n of grid.get(key(Math.floor(x / P.cellM), Math.floor(z / P.cellM))) ?? []) {
            const { a, b } = segments[n];
            const cx = b.s.x - a.s.x, cz = b.s.z - a.s.z;
            // along: measured on the street's own direction (the stations' mean tangent), not the chord, which runs at an
            // angle where a station was shifted sideways onto the measured street; a little past each end, so a bend's
            // outer wedge is covered
            let tx = a.s.tx + b.s.tx, tz = a.s.tz + b.s.tz;
            const tl = Math.hypot(tx, tz);
            if (tl < 1e-9) continue;
            tx /= tl; tz /= tl;
            const along = cx * tx + cz * tz;
            if (along < 1e-6) continue;
            const u = ((x - a.s.x) * tx + (z - a.s.z) * tz) / along;
            if (u < -0.1 || u > 1.1) continue;
            const w = Math.max(0, Math.min(1, u));
            // a stretch with a median is left as scanned (another street's segment may still take the point)
            if (a.s.median || b.s.median) continue;
            const px = a.s.x + cx * w, pz = a.s.z + cz * w;
            let nx = lerp(a.s.nx, b.s.nx, w), nz = lerp(a.s.nz, b.s.nz, w);
            const nl = Math.hypot(nx, nz) || 1;
            nx /= nl; nz /= nl;
            // across: signed distance to the left of the centreline
            const d = (x - px) * nx + (z - pz) * nz;
            const hwL = lerp(a.s.left.halfWidthM, b.s.left.halfWidthM, w), hwR = lerp(a.s.right.halfWidthM, b.s.right.halfWidthM, w);
            if (d > -hwR + P.kerbMarginM && d < hwL - P.kerbMarginM) {
                // the five levels across (left kerb, left mid, centre, right mid, right kerb), interpolated along
                const at = [hwL, hwL / 2, 0, -hwR / 2, -hwR];
                const lv = a.profile.map((v, j) => lerp(v, b.profile[j], w));
                for (let j = 0; j + 1 < at.length; j++) {
                    if (d <= at[j] && d >= at[j + 1]) {
                        const f = at[j] === at[j + 1] ? 0 : (at[j] - d) / (at[j] - at[j + 1]);
                        return { level: lerp(lv[j], lv[j + 1], f), zone: 'carriageway' };
                    }
                }
            }
            for (const [side, sign, hw] of [['left', 1, hwL], ['right', -1, hwR]] as const) {
                const sa = a[side], sb = b[side];
                if (!sa || !sb) continue;
                const out = sign * d - hw, width = lerp(sa.widthM, sb.widthM, w);
                if (out > P.kerbMarginM && out < width - P.kerbMarginM) return { level: lerp(sa.level, sb.level, w), zone: 'sidewalk' };
            }
            // at this street's kerb, or past its sidewalk: another street may still take the point (a crossing's carriageway)
        }
        return undefined;
    };
}

/**
 * Google's road corridors as a plan lookup: within `halfWidthM` of a road centreline (wide enough for its sidewalks: the
 * lines are a few metres off the street at times), rasterised at `cellM`.
 */
export function roadCorridor(lines: Vec2[][], halfWidthM: number, cellM = 1): (x: number, z: number) => boolean {
    const cells = new Set<string>();
    const r = Math.ceil(halfWidthM / cellM);
    for (const line of lines) for (let s = 0; s + 1 < line.length; s++) {
        const [ax, az] = line[s], [bx, bz] = line[s + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (cellM / 2)));
        for (let q = 0; q <= n; q++) {
            const i = Math.floor((ax + ((bx - ax) * q) / n) / cellM), k = Math.floor((az + ((bz - az) * q) / n) / cellM);
            for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) if (di * di + dk * dk <= r * r) cells.add(`${i + di},${k + dk}`);
        }
    }
    return (x, z) => cells.has(`${Math.floor(x / cellM)},${Math.floor(z / cellM)}`);
}

/**
 * Where no kerb was measured, the street's heights are settled instead, keeping its steps: each vertex moves to the most
 * common height among its neighbours near its own (mean shift over their heights, weighted by distance and by height
 * difference), so a lump with few vertices at its height is drawn down to the street around it, while a sidewalk, with many
 * vertices at its own level, stays there and the kerb between them keeps its step. Only vertices on the street
 * (`onStreet`), near the ground the scan shows (`groundAt`: not a car roof, a shed or a canopy) and on no near-vertical
 * triangle take part.
 */
export interface StreetSmoothing {
    onStreet: (x: number, z: number) => boolean;
    groundAt: (x: number, z: number) => number;
}

export const STREET_SMOOTHING_PARAMS = {
    /** Neighbours within this (m) are weighed ... */
    radiusM: 2,
    /** ... by distance with this spread (m) ... */
    sigmaM: 1,
    /** ... and by height difference with this spread (m). */
    rangeM: 0.06,
    /** Mean-shift steps at most. */
    iterations: 12,
    /** A vertex is moved at most this far (m); one that would move further is left as it is. */
    maxShiftM: 0.15,
    /** A vertex takes part only within this of the ground the scan shows (m). */
    groundBandM: 0.5
};
export type StreetSmoothingParams = typeof STREET_SMOOTHING_PARAMS;

export interface RoadFlattenStats {
    movedVertices: number;
    carriagewayVertices: number;
    sidewalkVertices: number;
    /** Vertices on a measured street but left where they were: on a triangle not facing up, or off the level by more than the tolerance. */
    keptVertices: number;
    keptNotUp: number;
    keptOffLevel: number;
    maxShiftM: number;
    meanShiftM: number;
    /** Vertices smoothed where no kerb was measured (the step-preserving filter), and how far they moved. */
    smoothedVertices: number;
    smoothedMaxShiftM: number;
    smoothedMeanShiftM: number;
    primitives: number;
}

/**
 * The scan GLB with its street vertices moved: onto `target`'s levels where kerbs were measured, else (with `smoothing`)
 * smoothed keeping their steps. Heights only, in the world frame its nodes place it in; index lists, texture coordinates and
 * every other vertex are untouched; moved vertices' normals point up and the moved accessors' bounds are recomputed.
 */
export function flattenRoadsInGlb(bytes: Uint8Array, target: (x: number, z: number) => FlattenTarget | undefined, P: RoadFlattenParams = ROAD_FLATTEN_PARAMS,
    smoothing?: StreetSmoothing, S: StreetSmoothingParams = STREET_SMOOTHING_PARAMS): { glb: Buffer; stats: RoadFlattenStats } {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const bin = new Uint8Array(glb.bin.byteLength);
    bin.set(glb.bin);
    const dv = new DataView(bin.buffer);
    const world = nodeWorldMatrices(json);
    const stats: RoadFlattenStats = { movedVertices: 0, carriagewayVertices: 0, sidewalkVertices: 0, keptVertices: 0, keptNotUp: 0, keptOffLevel: 0, maxShiftM: 0, meanShiftM: 0, smoothedVertices: 0, smoothedMaxShiftM: 0, smoothedMeanShiftM: 0, primitives: 0 };
    const layout = (ai: number) => {
        const a = json.accessors[ai], v = json.bufferViews[a.bufferView];
        const comps = a.type === 'VEC3' ? 3 : a.type === 'VEC2' ? 2 : 1;
        return { a, v, base: (v.byteOffset ?? 0) + (a.byteOffset ?? 0), stride: v.byteStride || comps * 4, comps };
    };
    // every primitive's vertices in the world frame, with whether a near-vertical triangle touches them
    type Prim = { prim: any; pl: ReturnType<typeof layout>; n: number; wp: Float64Array; steep: Uint8Array; newY: Float64Array; m: ReturnType<typeof nodeWorldMatrices>[number]; ident: boolean };
    const prims: Prim[] = [];
    const done = new Set<number>();
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || done.has(node.mesh)) return;
        done.add(node.mesh);
        const m = world[ni], ident = isIdentity(m);
        for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pl = layout(prim.attributes.POSITION);
            if (pl.a.componentType !== 5126 || pl.comps !== 3 || pl.a.sparse) continue;
            const n = pl.a.count;
            const wp = new Float64Array(n * 3);
            for (let v = 0; v < n; v++) {
                const o = pl.base + v * pl.stride;
                const lx = dv.getFloat32(o, true), ly = dv.getFloat32(o + 4, true), lz = dv.getFloat32(o + 8, true);
                const w = ident ? [lx, ly, lz] : transformPoint(m, lx, ly, lz);
                wp[v * 3] = w[0]; wp[v * 3 + 1] = w[1]; wp[v * 3 + 2] = w[2];
            }
            const steep = new Uint8Array(n);
            const idx = prim.indices !== undefined ? layout(prim.indices) : undefined;
            const size = idx ? (idx.a.componentType === 5125 ? 4 : idx.a.componentType === 5123 ? 2 : 1) : 0;
            const count = idx ? idx.a.count : n;
            const vi = (k: number) => {
                if (!idx) return k;
                const o = (idx.v.byteOffset ?? 0) + (idx.a.byteOffset ?? 0) + k * size;
                return size === 4 ? dv.getUint32(o, true) : size === 2 ? dv.getUint16(o, true) : dv.getUint8(o);
            };
            for (let t = 0; t + 2 < count; t += 3) {
                const i0 = vi(t), i1 = vi(t + 1), i2 = vi(t + 2);
                const ux = wp[i1 * 3] - wp[i0 * 3], uy = wp[i1 * 3 + 1] - wp[i0 * 3 + 1], uz = wp[i1 * 3 + 2] - wp[i0 * 3 + 2];
                const qx = wp[i2 * 3] - wp[i0 * 3], qy = wp[i2 * 3 + 1] - wp[i0 * 3 + 1], qz = wp[i2 * 3 + 2] - wp[i0 * 3 + 2];
                const cx = uy * qz - uz * qy, cy = uz * qx - ux * qz, cz = ux * qy - uy * qx, cl = Math.hypot(cx, cy, cz);
                // facing up either way round (the scan's winding is not consistent)
                if (!(cl > 1e-12) || Math.abs(cy) / cl < P.minUp) { steep[i0] = 1; steep[i1] = 1; steep[i2] = 1; }
            }
            prims.push({ prim, pl, n, wp, steep, newY: new Float64Array(n).fill(NaN), m, ident });
        }
    });
    // the measured streets first: each vertex onto its level
    let shiftSum = 0;
    const smoothCand: Array<{ p: Prim; v: number }> = [];
    for (const p of prims) for (let v = 0; v < p.n; v++) {
        const x = p.wp[v * 3], y = p.wp[v * 3 + 1], z = p.wp[v * 3 + 2];
        const tg = target(x, z);
        if (tg) {
            const shift = tg.level - y;
            if (p.steep[v]) { stats.keptVertices++; stats.keptNotUp++; continue; }
            if (Math.abs(shift) > (tg.zone === 'sidewalk' ? P.sidewalkToleranceM : P.toleranceM)) { stats.keptVertices++; stats.keptOffLevel++; continue; }
            p.newY[v] = tg.level;
            if (tg.zone === 'sidewalk') stats.sidewalkVertices++; else stats.carriagewayVertices++;
            stats.maxShiftM = Math.max(stats.maxShiftM, Math.abs(shift));
            shiftSum += Math.abs(shift);
            continue;
        }
        if (!smoothing || p.steep[v] || !smoothing.onStreet(x, z)) continue;
        const g = smoothing.groundAt(x, z);
        if (g === g && Math.abs(y - g) <= S.groundBandM) smoothCand.push({ p, v });
    }
    const fitted = stats.carriagewayVertices + stats.sidewalkVertices;
    stats.meanShiftM = fitted ? shiftSum / fitted : 0;
    // elsewhere on the street: the step-preserving smoothing, over the candidates (the fitted vertices hold their new levels)
    if (smoothCand.length) {
        const cell = S.radiusM, key = (x: number, z: number) => `${Math.floor(x / cell)},${Math.floor(z / cell)}`;
        const N = smoothCand.length;
        const X = new Float64Array(N), Z = new Float64Array(N), Y0 = new Float64Array(N);
        const Y = new Float64Array(N);
        const grid = new Map<string, number[]>();
        smoothCand.forEach(({ p, v }, i) => {
            X[i] = p.wp[v * 3]; Y0[i] = Y[i] = p.wp[v * 3 + 1]; Z[i] = p.wp[v * 3 + 2];
            const k = key(X[i], Z[i]);
            const l = grid.get(k);
            if (l) l.push(i); else grid.set(k, [i]);
        });
        const r2 = S.radiusM * S.radiusM, s2 = 2 * S.sigmaM * S.sigmaM, h2 = 2 * S.rangeM * S.rangeM;
        // each vertex climbs to the most common height around it (mean shift on the scan's own heights): a lump with few
        // vertices at its height is drawn to the street around it, a sidewalk with many at its own level stays there, so the
        // kerb between them keeps its step
        for (let i = 0; i < N; i++) {
            const ci = Math.floor(X[i] / cell), ck = Math.floor(Z[i] / cell);
            const near: number[] = [], wd: number[] = [];
            for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
                for (const j of grid.get(`${ci + di},${ck + dk}`) ?? []) {
                    const dx = X[j] - X[i], dz = Z[j] - Z[i], d2 = dx * dx + dz * dz;
                    if (d2 > r2) continue;
                    near.push(j); wd.push(Math.exp(-d2 / s2));
                }
            }
            let y = Y0[i];
            for (let it = 0; it < S.iterations; it++) {
                let sw = 0, sy = 0;
                for (let q = 0; q < near.length; q++) {
                    const dh = Y0[near[q]] - y, w = wd[q] * Math.exp(-(dh * dh) / h2);
                    sw += w; sy += w * Y0[near[q]];
                }
                const ny = sw > 0 ? sy / sw : y;
                const moved = Math.abs(ny - y);
                y = ny;
                if (moved < 1e-3) break;
            }
            Y[i] = y;
        }
        let sum = 0;
        smoothCand.forEach(({ p, v }, i) => {
            const shift = Y[i] - Y0[i];
            if (!(Math.abs(shift) > 1e-4) || Math.abs(shift) > S.maxShiftM) return;
            p.newY[v] = Y[i];
            stats.smoothedVertices++;
            stats.smoothedMaxShiftM = Math.max(stats.smoothedMaxShiftM, Math.abs(shift));
            sum += Math.abs(shift);
        });
        stats.smoothedMeanShiftM = stats.smoothedVertices ? sum / stats.smoothedVertices : 0;
    }
    // written back: heights moved in the world frame, normals up, bounds again
    for (const p of prims) {
        let any = 0;
        const inv = p.ident ? p.m : invert(p.m);
        for (let v = 0; v < p.n; v++) {
            const y = p.newY[v];
            if (y !== y) continue;
            any++;
            const x = p.wp[v * 3], z = p.wp[v * 3 + 2];
            const l = p.ident ? [x, y, z] : transformPoint(inv, x, y, z);
            const o = p.pl.base + v * p.pl.stride;
            dv.setFloat32(o, l[0], true); dv.setFloat32(o + 4, l[1], true); dv.setFloat32(o + 8, l[2], true);
        }
        if (!any) continue;
        stats.primitives++;
        stats.movedVertices += any;
        const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
        for (let v = 0; v < p.n; v++) for (let j = 0; j < 3; j++) { const q = dv.getFloat32(p.pl.base + v * p.pl.stride + j * 4, true); mn[j] = Math.min(mn[j], q); mx[j] = Math.max(mx[j], q); }
        p.pl.a.min = mn; p.pl.a.max = mx;
        if (p.prim.attributes.NORMAL !== undefined) {
            const nl = layout(p.prim.attributes.NORMAL);
            if (nl.a.componentType === 5126 && nl.comps === 3) {
                // world up in the node's frame
                const m = p.m;
                const up = p.ident ? [0, 1, 0] : (() => { const x = m[1], y = m[5], z = m[9]; const L = Math.hypot(x, y, z) || 1; return [x / L, y / L, z / L]; })();
                for (let v = 0; v < p.n; v++) if (p.newY[v] === p.newY[v]) { const o = nl.base + v * nl.stride; dv.setFloat32(o, up[0], true); dv.setFloat32(o + 4, up[1], true); dv.setFloat32(o + 8, up[2], true); }
            }
        }
    }
    return { glb: assembleGlb(json, bin), stats };
}
