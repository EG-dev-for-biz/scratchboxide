/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Road surfaces of a staged place, from two sources that agree on where the streets are: Google's vector road centrelines
 * say which lines are streets; the photo tiles' scan says how wide and how high each one is. Along every centreline, at
 * stations a few metres apart, a cross-section of the scan's surface is read: the carriageway's level (a low percentile,
 * so cars and street furniture do not raise it), its camber (the level at five places across it), and its kerbs (the
 * first sustained rise on each side). Where a kerb is found the half-width is measured; where none shows within reach
 * (canopy over the street, the scan's edge) the half-width is a default and the station says so. A raised strip under
 * the centreline itself is a median: its edges are found first and the carriageways lie outside it, so the median is
 * never drivable. Outside each kerb a sidewalk strip runs to the first building (or a few metres) at the level the scan
 * shows there.
 *
 * The surfaces are ribbons swept along the centrelines (operator 1: a profile along a carrier curve) through the measured
 * levels, with kerb faces and sidewalks, lifted a few centimetres above the scan they are read from, so they draw over it.
 * They carry planar UVs into a top-down render of the tile photo, so their colour is the photo's own. Every station
 * records what was measured and what was defaulted; nothing here names a road class.
 */

import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { writeStagedGlbFile } from './staged-glb-writer';

export interface RoadSurfaceParams {
    /** Distance between stations along a centreline (m). */
    stationM: number;
    /** Lateral sampling step of a cross-section (m). */
    lateralStepM: number;
    /** How far from the centreline a kerb is looked for (m). */
    maxHalfWidthM: number;
    /** A kerb: the surface rises at least this (m) ... */
    kerbRiseM: number;
    /** ... and stays up over this run (m). */
    kerbRunM: number;
    /** The carriageway level is this percentile of the surface samples (low: cars stand on it, nothing stands under it). */
    levelPercentile: number;
    /** Half-width used where no kerb shows (m). */
    defaultHalfWidthM: number;
    /** A sidewalk runs from the kerb at most this far (m), or to the first building. */
    sidewalkMaxM: number;
    /** The surfaces stand this far above the scan they were read from (m), so they draw over it. */
    liftM: number;
    /** A rise of at least this at the centreline over the sides means the centreline runs along a median (m). */
    medianRiseM: number;
    /**
     * The street is looked for within this of the vector centreline (m): Google's line and the scan disagree by a few
     * metres, so each station moves onto the flattest, lowest lane-wide window near it (its shift is recorded).
     */
    snapM: number;
    /** Half the window a lane is looked for in (m). */
    laneHalfWindowM: number;
    /** The window's spread (80th minus 20th percentile) a street surface may have (m); more is a wall, a roof, a tree. */
    maxSpreadM: number;
    /** A street stands at most this far above the terrain the scan shows (m); higher it is a roof or bridge deck the line runs under (a tunnel). */
    maxAboveGroundM: number;
    /** A kerb is looked for from this distance out (m): nearer rises are cars, posts and furniture. */
    minHalfWidthM: number;
    /** The levels across one station may differ by at most this (m): more is not one carriageway. */
    maxProfileRangeM: number;
}

export const ROAD_SURFACE_PARAMS: RoadSurfaceParams = {
    stationM: 2, lateralStepM: 0.25, maxHalfWidthM: 14, kerbRiseM: 0.08, kerbRunM: 0.75, levelPercentile: 0.2,
    defaultHalfWidthM: 3.5, sidewalkMaxM: 4, liftM: 0.04, medianRiseM: 0.08,
    snapM: 8, laneHalfWindowM: 2.5, maxSpreadM: 0.35, maxAboveGroundM: 2.5, minHalfWidthM: 2.0, maxProfileRangeM: 1.0
};

/** The scan's surface, highest point per cell (NaN where it has nothing). */
export interface SurfaceGrid { x0: number; z0: number; nx: number; nz: number; cellM: number; top: Float32Array }

export type KerbSource = 'measured' | 'vector-modelled';

export interface RoadSide {
    /** Distance from the centreline to the kerb (m). */
    halfWidthM: number;
    kerb: KerbSource;
    /** The kerb's top (the sidewalk level) when measured. */
    kerbTopY?: number;
    /** The sidewalk beyond the kerb: its width and level (absent when the scan shows none). */
    sidewalk?: { widthM: number; level: number };
}

export interface RoadStation {
    x: number; z: number;
    /** Unit tangent along the road and unit normal to its left (x east, z south: left is (-tz, tx)). */
    tx: number; tz: number; nx: number; nz: number;
    /** The carriageway's level at five places across it: left kerb, left mid, centre, right mid, right kerb (lifted by liftM). */
    profile: [number, number, number, number, number];
    left: RoadSide;
    right: RoadSide;
    /** A median under the centreline: the carriageways run from its edges to the kerbs; nothing between is drivable. */
    median?: { leftEdgeM: number; rightEdgeM: number; level: number };
    /** Surface samples the cross-section read. */
    samples: number;
    /** How far the station moved from the vector centreline onto the measured street (m, signed along the left normal). */
    shiftM: number;
}

export interface RoadSurface {
    id: string;
    stations: RoadStation[];
    lengthM: number;
    /** Share of the stations' kerbs (both sides) that were measured. */
    measuredKerbShare: number;
    /** Stations left out, by reason: no street surface near the line (a roof, a wall, a tree), above the terrain (a tunnel's line), levels not one carriageway. */
    dropped: { noSurface: number; aboveGround: number; uneven: number };
}

export interface RoadMeasureInput {
    roads: Vec2[][];
    grid: SurfaceGrid;
    /** Whether a point is inside the place (the extraction's cover); stations outside are not built. */
    within: (x: number, z: number) => boolean;
    /** Cells the surface is not read on (tree canopy over the street). */
    exclude?: (x: number, z: number) => boolean;
    /** A building (> 0) at a point: a sidewalk ends there. */
    buildingAt?: (x: number, z: number) => number;
    /** The terrain the scan shows at a point (NaN where unknown): a street level far above it is not a street. */
    groundAt?: (x: number, z: number) => number;
}

function percentile(values: number[], p: number): number {
    if (!values.length) return NaN;
    const s = [...values].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))));
    return s[i];
}

function median(values: number[]): number {
    return percentile(values, 0.5);
}

/** The surface height at (x, z): the cell's own, else the nearest finite cell within one cell. NaN beyond. */
export function surfaceAt(g: SurfaceGrid, x: number, z: number): number {
    const i = Math.floor((x - g.x0) / g.cellM), k = Math.floor((z - g.z0) / g.cellM);
    if (i < 0 || k < 0 || i >= g.nx || k >= g.nz) return NaN;
    const v = g.top[k * g.nx + i];
    if (v === v) return v;
    let best = NaN, bd = Infinity;
    for (let dk = -1; dk <= 1; dk++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, kk = k + dk;
        if (ii < 0 || kk < 0 || ii >= g.nx || kk >= g.nz) continue;
        const u = g.top[kk * g.nx + ii];
        if (u !== u) continue;
        const d = di * di + dk * dk;
        if (d < bd) { bd = d; best = u; }
    }
    return best;
}

/** Resamples a polyline at `step` metres, keeping its ends; returns the points with their tangents. */
export function stationsAlong(line: Vec2[], step: number): Array<{ x: number; z: number; tx: number; tz: number }> {
    const pts: Array<{ x: number; z: number; tx: number; tz: number }> = [];
    let carry = 0;
    for (let s = 0; s + 1 < line.length; s++) {
        const [ax, az] = line[s], [bx, bz] = line[s + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-6) continue;
        const tx = (bx - ax) / len, tz = (bz - az) / len;
        let d = carry;
        while (d <= len + 1e-9) {
            pts.push({ x: ax + tx * d, z: az + tz * d, tx, tz });
            d += step;
        }
        carry = d - len;
    }
    const last = line[line.length - 1];
    if (pts.length && Math.hypot(pts[pts.length - 1].x - last[0], pts[pts.length - 1].z - last[1]) > step * 0.25) {
        const p = pts[pts.length - 1];
        pts.push({ x: last[0], z: last[1], tx: p.tx, tz: p.tz });
    }
    // tangents smoothed at the joints: the mean of the neighbours' directions
    for (let i = 1; i + 1 < pts.length; i++) {
        const tx = pts[i - 1].tx + pts[i + 1].tx, tz = pts[i - 1].tz + pts[i + 1].tz;
        const n = Math.hypot(tx, tz);
        if (n > 1e-6) { pts[i].tx = tx / n; pts[i].tz = tz / n; }
    }
    return pts;
}

interface Section { d: number[]; h: number[] }

/** One side of a cross-section from `from` outward: the kerb (first sustained rise over the running level), or none. */
function findKerb(sec: Section, sign: 1 | -1, from: number, P: RoadSurfaceParams): { halfWidthM: number; kerbTopY: number } | undefined {
    const run = Math.max(1, Math.round(P.kerbRunM / P.lateralStepM));
    const idx = sec.d.map((d, i) => i).filter(i => sign * sec.d[i] >= from - 1e-9).sort((a, b) => sign * sec.d[a] - sign * sec.d[b]);
    const level: number[] = [];
    let gap = 0;
    for (let q = 0; q < idx.length; q++) {
        const h = sec.h[idx[q]];
        if (h !== h) { if (++gap * P.lateralStepM > 1.5) return undefined; continue; }
        gap = 0;
        if (level.length >= 3) {
            const ref = median(level.slice(-6));
            if (h - ref >= P.kerbRiseM) {
                // sustained: the next `run` finite samples stay up
                const ahead: number[] = [];
                for (let r = q; r < idx.length && ahead.length < run; r++) { const v = sec.h[idx[r]]; if (v === v) ahead.push(v); }
                if (ahead.length >= Math.max(1, run - 1) && median(ahead) - ref >= P.kerbRiseM) {
                    // the kerb stands where the surface model's ramp crosses half the rise (a step smeared over a cell)
                    const prev = q > 0 ? sec.h[idx[q - 1]] : NaN;
                    const at = prev === prev && prev - ref >= P.kerbRiseM / 2 ? idx[q - 1] : idx[q];
                    return { halfWidthM: sign * sec.d[at], kerbTopY: median(ahead) };
                }
            }
        }
        level.push(h);
    }
    return undefined;
}

/** The median under the centreline, when the centre stands above both sides: its edges (the first drops outward). */
function findMedian(sec: Section, P: RoadSurfaceParams): { leftEdgeM: number; rightEdgeM: number; level: number } | undefined {
    const near = (lo: number, hi: number) => sec.h.filter((h, i) => h === h && Math.abs(sec.d[i]) >= lo && Math.abs(sec.d[i]) <= hi);
    const centre = near(0, 0.75), sides = near(2.5, 6);
    if (centre.length < 2 || sides.length < 4) return undefined;
    const c = median(centre), s = percentile(sides, P.levelPercentile);
    if (c - s < P.medianRiseM) return undefined;
    // each edge: the first drop of half the rise outward (the surface model smears a step over a cell), confirmed by the full
    // drop within the next metre; distances are positive on both sides
    const edge = (sign: 1 | -1): number | undefined => {
        const idx = sec.d.map((d, i) => i).filter(i => sign * sec.d[i] >= 0).sort((a, b) => sign * sec.d[a] - sign * sec.d[b]);
        for (let q = 0; q < idx.length; q++) {
            const h = sec.h[idx[q]];
            if (h !== h || c - h < P.medianRiseM * 0.45) continue;
            const ahead = idx.slice(q, q + Math.ceil(1 / P.lateralStepM) + 1).map(i => sec.h[i]).filter(v => v === v);
            if (ahead.length && c - median(ahead) >= P.medianRiseM) return sign * sec.d[idx[q]];
        }
        return undefined;
    };
    const l = edge(-1), r = edge(1);
    if (l === undefined || r === undefined) return undefined;
    return { leftEdgeM: l, rightEdgeM: r, level: c };
}

/** Measures every road's stations against the scan's surface. */
export function measureRoadSurfaces(input: RoadMeasureInput, P: RoadSurfaceParams = ROAD_SURFACE_PARAMS): RoadSurface[] {
    const g = input.grid;
    const read = (x: number, z: number): number => (input.exclude && input.exclude(x, z) ? NaN : surfaceAt(g, x, z));
    const out: RoadSurface[] = [];
    const steps = Math.round(P.maxHalfWidthM / P.lateralStepM);
    input.roads.forEach((line, ri) => {
        const pts = stationsAlong(line, P.stationM).filter(p => input.within(p.x, p.z));
        if (pts.length < 2) return;
        const dropped = { noSurface: 0, aboveGround: 0, uneven: 0 };
        /** Consecutive kept stations make one run; a gap splits the road into separate surfaces. */
        let run: RoadStation[] = [];
        let measured = 0;
        const flush = (): void => {
            if (run.length >= 2) {
                let lengthM = 0;
                for (let i = 1; i < run.length; i++) lengthM += Math.hypot(run[i].x - run[i - 1].x, run[i].z - run[i - 1].z);
                out.push({ id: `road_${ri}${out.some(r => r.id.startsWith(`road_${ri}`)) ? `_${out.filter(r => r.id.startsWith(`road_${ri}`)).length}` : ''}`, stations: run, lengthM, measuredKerbShare: 0, dropped: { ...dropped } });
            }
            run = [];
        };
        for (const p of pts) {
            const nx = -p.tz, nz = p.tx;
            // the cross-section about the vector line: lateral offsets, each the median of three reads along the road (-1, 0, +1 m)
            const wide: Section = { d: [], h: [] };
            const span = steps + Math.round(P.snapM / P.lateralStepM);
            let samples = 0;
            for (let k = -span; k <= span; k++) {
                const d = k * P.lateralStepM;
                const hs: number[] = [];
                for (const a of [-1, 0, 1]) {
                    const h = read(p.x + nx * d + p.tx * a, p.z + nz * d + p.tz * a);
                    if (h === h) hs.push(h);
                }
                samples += hs.length;
                wide.d.push(d);
                wide.h.push(hs.length ? median(hs) : NaN);
            }
            // a median under the line pins the station there (the line is the street's centre); else the street near the line is
            // the lane-wide window with the least spread (and, among the flat ones, the lowest and nearest)
            const atLine: Section = { d: wide.d.filter(d => Math.abs(d) <= P.maxHalfWidthM + 1e-9), h: wide.h.filter((_, i) => Math.abs(wide.d[i]) <= P.maxHalfWidthM + 1e-9) };
            const pinned = findMedian(atLine, P);
            let best: { c: number; level: number; spread: number } | undefined;
            if (pinned) {
                const vals = atLine.h.filter((h, i) => h === h && Math.abs(atLine.d[i]) <= 0.75);
                best = { c: 0, level: percentile(vals, P.levelPercentile), spread: 0 };
            }
            for (let c = -P.snapM; !pinned && c <= P.snapM + 1e-9; c += P.lateralStepM * 2) {
                const vals = wide.h.filter((h, i) => h === h && Math.abs(wide.d[i] - c) <= P.laneHalfWindowM);
                if (vals.length < Math.max(4, Math.floor((2 * P.laneHalfWindowM) / P.lateralStepM) * 0.6)) continue;
                const level = percentile(vals, P.levelPercentile), spread = percentile(vals, 0.8) - level;
                if (spread > P.maxSpreadM) continue;
                const score = spread + 0.03 * Math.abs(c) + 0.05 * level;
                if (!best || score < best.spread + 0.03 * Math.abs(best.c) + 0.05 * best.level) best = { c, level, spread };
            }
            if (!best) { dropped.noSurface++; flush(); continue; }
            if (input.groundAt) {
                const g = input.groundAt(p.x + nx * best.c, p.z + nz * best.c);
                if (g === g && best.level - g > P.maxAboveGroundM) { dropped.aboveGround++; flush(); continue; }
            }
            const sx = p.x + nx * best.c, sz = p.z + nz * best.c;
            const sec: Section = { d: wide.d.map(d => d - best!.c).filter(d => Math.abs(d) <= P.maxHalfWidthM + 1e-9), h: [] };
            sec.h = wide.h.filter((_, i) => Math.abs(wide.d[i] - best!.c) <= P.maxHalfWidthM + 1e-9);
            const medianStrip = findMedian(sec, P);
            const fromL = Math.max(P.minHalfWidthM, medianStrip ? medianStrip.leftEdgeM : 0), fromR = Math.max(P.minHalfWidthM, medianStrip ? medianStrip.rightEdgeM : 0);
            const kl = findKerb(sec, -1, fromL, P), kr = findKerb(sec, 1, fromR, P);
            let measuredHere = 0;
            const side = (sign: 1 | -1, k: { halfWidthM: number; kerbTopY: number } | undefined): RoadSide => {
                if (!k) return { halfWidthM: P.defaultHalfWidthM, kerb: 'vector-modelled' };
                measuredHere++;
                // the sidewalk: from the kerb outward at the kerb's level until a building, a further step, or sidewalkMaxM
                let width = 0;
                const levels: number[] = [];
                for (let d = k.halfWidthM + P.lateralStepM; d <= k.halfWidthM + P.sidewalkMaxM; d += P.lateralStepM) {
                    const x = sx + nx * sign * d, z = sz + nz * sign * d;
                    if (input.buildingAt && input.buildingAt(x, z) > 0) break;
                    const h = read(x, z);
                    if (h !== h) break;
                    if (Math.abs(h - k.kerbTopY) > 0.35) break;
                    levels.push(h);
                    width = d - k.halfWidthM;
                }
                return { halfWidthM: k.halfWidthM, kerb: 'measured', kerbTopY: k.kerbTopY, ...(width >= 0.5 ? { sidewalk: { widthM: width, level: median(levels) } } : {}) };
            };
            let left = side(-1, kl), right = side(1, kr);
            // both kerbs measured and no median: the station is centred between them (the line may run off-centre in the carriageway)
            let recentre = 0;
            if (kl && kr && !medianStrip) {
                recentre = (kr.halfWidthM - kl.halfWidthM) / 2;
                const half = (kl.halfWidthM + kr.halfWidthM) / 2;
                left = { ...left, halfWidthM: half };
                right = { ...right, halfWidthM: half };
                for (let i = 0; i < sec.d.length; i++) sec.d[i] -= recentre;
            }
            const cx = sx + nx * recentre, cz = sz + nz * recentre;
            // the carriageway's level at five places across it (a low percentile of the samples around each)
            const at = (t: number): number => {
                const inner = t < 0 ? (medianStrip ? medianStrip.leftEdgeM : 0) : (medianStrip ? medianStrip.rightEdgeM : 0);
                const outerHalf = t < 0 ? left.halfWidthM : right.halfWidthM;
                const d = t === 0 && medianStrip ? 0 : inner + (outerHalf - inner) * Math.abs(t);
                const band = Math.max(0.5, 0.25 * (outerHalf - inner));
                const vals = sec.h.filter((h, i) => h === h && Math.abs(Math.sign(t || 1) * sec.d[i] - d) <= band && (t === 0 || Math.sign(sec.d[i]) === Math.sign(t) || sec.d[i] === 0));
                return percentile(vals, P.levelPercentile);
            };
            const profile: [number, number, number, number, number] = [at(-1), at(-0.5), at(0), at(0.5), at(1)];
            const finite = profile.filter(v => v === v);
            if (finite.length && Math.max(...finite) - Math.min(...finite) > P.maxProfileRangeM) { dropped.uneven++; flush(); continue; }
            measured += measuredHere;
            run.push({ x: cx, z: cz, tx: p.tx, tz: p.tz, nx, nz, profile, left, right, samples, shiftM: best.c + recentre, ...(medianStrip ? { median: medianStrip } : {}) });
        }
        flush();
        const runs = out.filter(r => r.id === `road_${ri}` || r.id.startsWith(`road_${ri}_`));
        const kept = runs.reduce((n, r) => n + r.stations.length, 0);
        for (const r of runs) { r.measuredKerbShare = kept ? measured / (2 * kept) : 0; r.dropped = { ...dropped }; }
        for (const r of runs) {
        const stations = r.stations;
        // levels smoothed along the road (median of three stations) and gaps filled from neighbours; then lifted
        for (let k = 0; k < 5; k++) {
            const raw = stations.map(s => s.profile[k]);
            for (let i = 0; i < stations.length; i++) {
                const win = [raw[i - 1], raw[i], raw[i + 1]].filter(v => v !== undefined && v === v);
                let v = win.length ? median(win) : NaN;
                if (v !== v) {
                    for (let q = 1; q < stations.length && v !== v; q++) {
                        const a = raw[i - q], b = raw[i + q];
                        if (a !== undefined && a === a) v = a; else if (b !== undefined && b === b) v = b;
                    }
                }
                stations[i].profile[k] = (v === v ? v : 0) + P.liftM;
            }
        }
        for (const s of stations) {
            if (s.median) s.median.level += P.liftM;
            for (const sd of [s.left, s.right]) { if (sd.kerbTopY !== undefined) sd.kerbTopY += P.liftM; if (sd.sidewalk) sd.sidewalk.level += P.liftM; }
        }
        }
    });
    return out;
}

/** The carriageway outline of a road (left kerbs forward, right kerbs back), as a polygon. */
export function carriagewayPolygon(r: RoadSurface): Vec2[] {
    const left = r.stations.map(s => [s.x + s.nx * -s.left.halfWidthM, s.z + s.nz * -s.left.halfWidthM] as Vec2);
    const right = r.stations.map(s => [s.x + s.nx * s.right.halfWidthM, s.z + s.nz * s.right.halfWidthM] as Vec2).reverse();
    return [...left, ...right];
}

export function pointInPolygon(poly: Vec2[], x: number, z: number): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, zi] = poly[i], [xj, zj] = poly[j];
        if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/** Whether (x, z) lies on a drivable carriageway (inside a road's kerbs and not on its median). */
export function drivableAt(roads: RoadSurface[], x: number, z: number, polygons = roads.map(carriagewayPolygon)): boolean {
    for (let i = 0; i < roads.length; i++) {
        if (!pointInPolygon(polygons[i], x, z)) continue;
        const r = roads[i];
        // the nearest station says whether a median covers this offset
        let best: RoadStation | undefined, bd = Infinity;
        for (const s of r.stations) { const d = (x - s.x) ** 2 + (z - s.z) ** 2; if (d < bd) { bd = d; best = s; } }
        if (best?.median) {
            const off = (x - best.x) * best.nx + (z - best.z) * best.nz;
            if (off >= -best.median.leftEdgeM && off <= best.median.rightEdgeM) continue;
        }
        return true;
    }
    return false;
}

/** The nearest point within `maxM` of (x, z) that is not drivable (a search ring at 0.5 m), or undefined. */
export function nearestOffRoad(roads: RoadSurface[], x: number, z: number, maxM: number): { x: number; z: number; movedM: number } | undefined {
    const polygons = roads.map(carriagewayPolygon);
    for (let r = 0.5; r <= maxM + 1e-9; r += 0.5) {
        const n = Math.max(8, Math.round((2 * Math.PI * r) / 0.5));
        for (let k = 0; k < n; k++) {
            const a = (k / n) * 2 * Math.PI;
            const px = x + r * Math.cos(a), pz = z + r * Math.sin(a);
            if (!drivableAt(roads, px, pz, polygons)) return { x: px, z: pz, movedM: r };
        }
    }
    return undefined;
}

export interface RoadMeshPart { positions: Float32Array; indices: Uint32Array; uv: Float32Array }

export interface RoadMesh {
    carriageway: RoadMeshPart;
    kerbs: RoadMeshPart;
    sidewalks: RoadMeshPart;
    /** The planar UV frame: uv = ((x - x0) / width, (z - z0) / height). */
    uvFrame: { x0: number; z0: number; widthM: number; heightM: number };
    stats: { roads: number; stations: number; measuredKerbs: number; defaultKerbs: number; medians: number; sidewalkM: number; skippedQuads: number; triangles: number; droppedStations: { noSurface: number; aboveGround: number; uneven: number } };
    minY: number; maxY: number;
}

class PartBuilder {
    positions: number[] = [];
    indices: number[] = [];
    uv: number[] = [];
    constructor(private readonly frame: { x0: number; z0: number; widthM: number; heightM: number }) {}
    vertex(x: number, y: number, z: number): number {
        this.positions.push(x, y, z);
        this.uv.push((x - this.frame.x0) / this.frame.widthM, (z - this.frame.z0) / this.frame.heightM);
        return this.positions.length / 3 - 1;
    }
    quad(a: number, b: number, c: number, d: number): void {
        // a b on one station, d c on the next (a-b across, d-c across), counter-clockwise seen from above
        this.indices.push(a, c, b, a, d, c);
    }
    part(): RoadMeshPart {
        return { positions: Float32Array.from(this.positions), indices: Uint32Array.from(this.indices), uv: Float32Array.from(this.uv) };
    }
}

/**
 * The ribbons: per road, between consecutive stations, the carriageway (four quads across, through the five profile
 * levels), the kerb faces (vertical) and the sidewalks (flat at their level). Quads whose centre lies on another road's
 * carriageway (the crossing, built once by the longer road) are left out; a median's strip is built as a raised island.
 */
export function buildRoadMesh(roads: RoadSurface[], P: RoadSurfaceParams = ROAD_SURFACE_PARAMS): RoadMesh {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const r of roads) for (const s of r.stations) {
        const reach = Math.max(s.left.halfWidthM + (s.left.sidewalk?.widthM ?? 0), s.right.halfWidthM + (s.right.sidewalk?.widthM ?? 0)) + 1;
        x0 = Math.min(x0, s.x - reach); x1 = Math.max(x1, s.x + reach); z0 = Math.min(z0, s.z - reach); z1 = Math.max(z1, s.z + reach);
    }
    if (!roads.length) { x0 = z0 = 0; x1 = z1 = 1; }
    const frame = { x0, z0, widthM: Math.max(1, x1 - x0), heightM: Math.max(1, z1 - z0) };
    const carriage = new PartBuilder(frame), kerbs = new PartBuilder(frame), walks = new PartBuilder(frame);
    const ordered = [...roads].sort((a, b) => b.lengthM - a.lengthM);
    const polygons = ordered.map(carriagewayPolygon);
    const stats = { roads: roads.length, stations: 0, measuredKerbs: 0, defaultKerbs: 0, medians: 0, sidewalkM: 0, skippedQuads: 0, triangles: 0, droppedStations: { noSurface: 0, aboveGround: 0, uneven: 0 } };
    // a road's runs share one dropped count: counted once per vector line
    const seenLine = new Set<string>();
    for (const r of roads) {
        const line = r.id.replace(/_\d+$/, '');
        if (seenLine.has(line)) continue;
        seenLine.add(line);
        stats.droppedStations.noSurface += r.dropped.noSurface; stats.droppedStations.aboveGround += r.dropped.aboveGround; stats.droppedStations.uneven += r.dropped.uneven;
    }
    const onEarlier = (upTo: number, x: number, z: number): boolean => {
        for (let i = 0; i < upTo; i++) if (pointInPolygon(polygons[i], x, z)) return true;
        return false;
    };
    ordered.forEach((r, ri) => {
        type Row = { c: number[]; kl?: number; kr?: number; sl?: number; sr?: number; wl?: number; wr?: number; ml?: number; mr?: number };
        const rows: Row[] = r.stations.map(s => {
            stats.stations++;
            for (const sd of [s.left, s.right]) { if (sd.kerb === 'measured') stats.measuredKerbs++; else stats.defaultKerbs++; }
            if (s.median) stats.medians++;
            const at = (d: number, y: number) => [s.x + s.nx * d, y, s.z + s.nz * d] as const;
            const row: Row = { c: [] };
            const lIn = s.median ? -s.median.leftEdgeM : -s.left.halfWidthM;
            const rIn = s.median ? s.median.rightEdgeM : s.right.halfWidthM;
            // the five profile points across the drivable width (with a median: two carriageways, three points each)
            if (s.median) {
                const lw = s.left.halfWidthM - s.median.leftEdgeM, rw = s.right.halfWidthM - s.median.rightEdgeM;
                const ls = [-s.left.halfWidthM, -s.left.halfWidthM + lw / 2, -s.median.leftEdgeM].map((d, k) => carriage.vertex(...at(d, s.profile[k === 2 ? 1 : k])));
                const rs = [s.median.rightEdgeM, s.median.rightEdgeM + rw / 2, s.right.halfWidthM].map((d, k) => carriage.vertex(...at(d, s.profile[k === 0 ? 3 : k + 2])));
                row.c = [...ls, ...rs];
                row.ml = carriage.vertex(...at(-s.median.leftEdgeM, s.median.level));
                row.mr = carriage.vertex(...at(s.median.rightEdgeM, s.median.level));
                void lIn; void rIn;
            } else {
                row.c = [-1, -0.5, 0, 0.5, 1].map((t, k) => carriage.vertex(...at(t < 0 ? -s.left.halfWidthM * -t : s.right.halfWidthM * t, s.profile[k])));
            }
            for (const [sd, sign] of [[s.left, -1], [s.right, 1]] as const) {
                if (sd.kerbTopY === undefined) continue;
                const d = sign * sd.halfWidthM;
                const top = kerbs.vertex(...at(d, sd.kerbTopY));
                const foot = kerbs.vertex(...at(d, sign < 0 ? s.profile[0] : s.profile[4]));
                if (sign < 0) { row.kl = top; row.sl = foot; } else { row.kr = top; row.sr = foot; }
                if (sd.sidewalk) {
                    const a = walks.vertex(...at(d, sd.sidewalk.level)), b = walks.vertex(...at(d + sign * sd.sidewalk.widthM, sd.sidewalk.level));
                    if (sign < 0) { row.wl = a; row.wr = b; (row as any).wl2 = b; (row as any).wl1 = a; } else { (row as any).wr1 = a; (row as any).wr2 = b; }
                }
            }
            return row;
        });
        for (let i = 0; i + 1 < rows.length; i++) {
            const a = r.stations[i], b = r.stations[i + 1];
            const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
            if (onEarlier(ri, mid.x, mid.z)) { stats.skippedQuads++; continue; }
            const ra = rows[i], rb = rows[i + 1];
            const n = Math.min(ra.c.length, rb.c.length);
            if (ra.c.length === 6 && rb.c.length === 6) {
                for (const [p, q] of [[0, 1], [1, 2], [3, 4], [4, 5]]) carriage.quad(ra.c[p], ra.c[q], rb.c[q], rb.c[p]);
                if (ra.ml !== undefined && ra.mr !== undefined && rb.ml !== undefined && rb.mr !== undefined) {
                    carriage.quad(ra.ml, ra.mr, rb.mr, rb.ml);
                    carriage.quad(ra.c[2], ra.ml, rb.ml, rb.c[2]);
                    carriage.quad(ra.mr, ra.c[3], rb.c[3], rb.mr);
                }
            } else if (n === 5 && ra.c.length === rb.c.length) {
                for (let p = 0; p + 1 < 5; p++) carriage.quad(ra.c[p], ra.c[p + 1], rb.c[p + 1], rb.c[p]);
            } else {
                // a station with a median next to one without: bridge the outer edges only
                carriage.quad(ra.c[0], ra.c[ra.c.length - 1], rb.c[rb.c.length - 1], rb.c[0]);
            }
            if (ra.kl !== undefined && rb.kl !== undefined) kerbs.quad(ra.sl!, ra.kl, rb.kl, rb.sl!);
            if (ra.kr !== undefined && rb.kr !== undefined) kerbs.quad(ra.kr, ra.sr!, rb.sr!, rb.kr);
            const wa = ra as any, wb = rb as any;
            if (wa.wl1 !== undefined && wb.wl1 !== undefined && !onEarlier(ordered.length, a.x + a.nx * -(a.left.halfWidthM + 1), a.z + a.nz * -(a.left.halfWidthM + 1))) {
                walks.quad(wa.wl2, wa.wl1, wb.wl1, wb.wl2);
                stats.sidewalkM += Math.hypot(b.x - a.x, b.z - a.z);
            }
            if (wa.wr1 !== undefined && wb.wr1 !== undefined && !onEarlier(ordered.length, a.x + a.nx * (a.right.halfWidthM + 1), a.z + a.nz * (a.right.halfWidthM + 1))) {
                walks.quad(wa.wr1, wa.wr2, wb.wr2, wb.wr1);
                stats.sidewalkM += Math.hypot(b.x - a.x, b.z - a.z);
            }
        }
    });
    const parts = { carriageway: carriage.part(), kerbs: kerbs.part(), sidewalks: walks.part() };
    for (const p of Object.values(parts)) for (let i = 1; i < p.positions.length; i += 3) { minY = Math.min(minY, p.positions[i]); maxY = Math.max(maxY, p.positions[i]); }
    stats.triangles = (parts.carriageway.indices.length + parts.kerbs.indices.length + parts.sidewalks.indices.length) / 3;
    return { ...parts, uvFrame: frame, stats, minY: minY === Infinity ? 0 : minY, maxY: maxY === -Infinity ? 0 : maxY };
}

/** Writes the road surfaces as a staged GLB: three nodes, planar UVs into `texture` (a JPEG of the top-down photo render) when given. */
export function writeRoadsGlb(file: string, mesh: RoadMesh, extras: Record<string, unknown>, texture?: { jpeg: Buffer; width: number; height: number }): { path: string; bytes: number } {
    const nodes = [
        { name: 'carriageway', ...mesh.carriageway, extras: { ...extras, part: 'carriageway' } },
        { name: 'kerbs', ...mesh.kerbs, extras: { ...extras, part: 'kerbs' } },
        { name: 'sidewalks', ...mesh.sidewalks, extras: { ...extras, part: 'sidewalks' } }
    ].filter(n => n.indices.length > 0);
    return writeStagedGlbFile(file, nodes, {
        rootExtras: { sbRoads: { ...extras, uvFrame: mesh.uvFrame, ...(texture ? { texture: { source: 'top-down render of the tile photo', width: texture.width, height: texture.height } } : {}) } },
        generator: 'scratchbox staged-location road-surfaces',
        ...(texture ? { texture: { bytes: texture.jpeg, mimeType: 'image/jpeg' } } : {})
    });
}
