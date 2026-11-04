/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Kerbs and gutters as geometry, from what SB-Roadie measures (road-surfaces.ts). SB-Roadie finds each kerb on the scan's
 * 0.5 m surface model; here every kerb is read again across its line on the scan's own triangles, a cross-section every
 * 5 cm: the road's level inside it, the sidewalk's level behind it, where the face stands (the half-rise crossing), how
 * long the rise runs (a kerb's face is short, a ramp's slope long), and the dip at its foot (a gutter, when the scan
 * resolves one). The kerb line is smoothed along the street.
 *
 * One profile is swept along each street (operator 1, a profile along a carrier curve): the kerb top behind the face, a
 * small chamfered nosing, the face from the measured rise, the gutter, the carriageway through SB-Roadie's measured
 * camber, and the same mirrored, so carriageway, gutter and kerb share their seams. A side whose kerb was not measured
 * ends at the carriageway's edge: no kerb is drawn there, and the sample says why. Where the face shrinks to the road
 * while the sidewalk behind stays up, the scan shows a ramp, and the kerb drops to the road with it.
 *
 * Where a street's kerb ends at a crossing, it is joined to the next street's: around a corner, on the arc tangent to
 * both kerb lines whose radius is measured from rays cast across the corner's own kerb; straight across a gap where the
 * line runs on. A join is drawn only where the scan shows its kerb. Nothing here names a road class: every length and
 * level is read from the scan, and what is not (the nosing, the kerb top's width, a gutter the scan does not resolve) is
 * a plausible fill, labelled generated with its reason.
 */

import type { ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import type { RoadAtlasLayout, RoadMeshPart, RoadStation, RoadSurface, RoadSurfaceParams } from './road-surfaces';
import { stationsAlong } from './road-surfaces';
import { writeStagedGlbFile } from './staged-glb-writer';
import { assembleGlb, parseGlbBytes, readAccessor } from './glb-bytes';

export const ROAD_KERBS_VERSION = 'road-kerbs/2';

/**
 * SCRATCHBOX_STAGED_ROAD_KERBS=1 builds the streets with kerbs and gutters as geometry and carves the scan under them
 * (road-carve.ts); it turns the roads stage on with it. Off until the user judges it.
 */
export function roadKerbsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_ROAD_KERBS?.trim() === '1';
}

export const ROAD_KERB_PARAMS = {
    /** A kerb's cross-section is read at this step (m) ... */
    sectionStepM: 0.05,
    /** ... this far either side of where SB-Roadie found it (m) ... */
    sectionReachM: 1.2,
    /** ... each offset the median of the reads this far along the street either way (m). */
    sectionAlongM: 0.5,
    /** A kerb's rise lies between these (m): less is no step, more a wall, a planter, a car. */
    minRiseM: 0.06, maxRiseM: 0.35,
    /** The face's rise runs at most this far across (m); a longer one is a ramp's slope. */
    maxFaceRunM: 0.9,
    /** A ramp: just behind the kerb line the surface stands under rampFaceM above the road, while the sidewalk further back (up to rampBackM, m) stands rampRiseM up. */
    rampFaceM: 0.04, rampRiseM: 0.05, rampBackM: 2.5,
    /** A ramp's rise runs at least this far across (m): a crisp step is a kerb, whichever way it runs. */
    rampMinRunM: 0.5,
    /** The fine face position may differ from SB-Roadie's by at most this (m); further is not the same kerb. */
    maxShiftM: 0.8,
    /** Where SB-Roadie's step is a wall, the kerb is looked for further in at this step (m). */
    inwardStepM: 1,
    /** A gutter is measured where the dip at the face's foot is at least this deep (m) and dipNoise times the road's spread ... */
    minDipM: 0.015, dipNoise: 1.5,
    /** ... and between these wide (m). */
    minDipWidthM: 0.1, maxDipWidthM: 0.6,
    /** The gutter where the scan does not resolve one (generated): a plausible pan at the face's foot (m). */
    gutterWidthM: 0.3, gutterDepthM: 0.025,
    /** The kerb top drawn behind the face (generated width, m); the scan's own sidewalk continues beyond it. */
    kerbTopM: 0.15,
    /** The face's arris chamfered at 45 degrees by frontBevelM of the kerb's smallest dimension (generated), at most half the face. */
    /** The kerb line along a run: a local line fitted over this far either way (m), residuals past lineTrimM (m) dropped ... */
    lineHalfM: 8, lineTrimM: 0.25,
    /** ... except at a stretch's last two samples, where a kerb that bends off it by more than this (m) stays where the scan puts it (into a corner). */
    bendM: 0.2,
    /** A gap SB-Roadie bridged between two stations is read again every this (m). */
    gapStepM: 2,
    /** Joins: two kerb ends this close (m) along their lines are joined around a corner, or straight across a gap up to bridgeM. */
    cornerReachM: 15, bridgeM: 12,
    /** A straight join's lines run within this angle (degrees) and this far apart sideways (m); a corner's turn at least cornerMinDeg. */
    bridgeMaxDeg: 15, bridgeMaxOffsetM: 0.6, cornerMinDeg: 30,
    /** The corner's radius: rays across the corner, a measured radius from at least minHits of them agreeing within maxSpreadM; a
     *  tighter arc than cornerMinRadiusM is a planter's or a bollard's foot the rays found, not the kerb's turn. */
    cornerRays: 9, cornerMinHits: 5, cornerMaxSpreadM: 0.6, cornerMinRadiusM: 1, cornerMaxRadiusM: 14,
    /** A corner's arc is drawn in steps of at most this angle (degrees) and length (m). */
    arcStepDeg: 10, arcStepM: 0.75,
    /** The two ends of a join stand within this of one another's kerb top (m): more is another level, not the same kerb. */
    joinMaxLevelM: 0.3
};
export type RoadKerbParams = typeof ROAD_KERB_PARAMS;

/**
 * The bevel of a built element's front edge (user decision, 2026-11-03): about 1.5 % of the element's smallest dimension,
 * clamped to 1-5 cm. A kerb (a face and a top of some 15 cm) gets 1 cm; a flight of steps metres high a few centimetres.
 * Generated: the scan resolves no arris.
 */
export function frontBevelM(smallestDimensionM: number): number {
    return Math.max(0.01, Math.min(0.05, 0.015 * Math.max(0, smallestDimensionM)));
}

/** The scan's surface at a plan point (its highest triangle there), NaN where it has none. */
export type HeightAt = (x: number, z: number) => number;

/**
 * The scan's triangles as a plan lookup (CSR bins of `cellM`): the highest surface over a point, read on the triangles
 * themselves (barycentric), not a cell grid. `include` limits it to some triangles (those near the streets).
 */
export function scanHeightIndex(scan: ScanMesh, cellM = 1, include?: (triangle: number) => boolean): HeightAt {
    const V = scan.mesh.vertices, I = scan.mesh.indices;
    const x0 = Math.floor(scan.bounds.min[0]), z0 = Math.floor(scan.bounds.min[2]);
    const nx = Math.max(1, Math.ceil((scan.bounds.max[0] - x0) / cellM) + 1), nz = Math.max(1, Math.ceil((scan.bounds.max[2] - z0) / cellM) + 1);
    const counts = new Uint32Array(nx * nz + 1);
    const bin = (t: number, visit: (c: number) => void) => {
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const i0 = Math.floor((Math.min(V[a], V[b], V[c]) - x0) / cellM), i1 = Math.floor((Math.max(V[a], V[b], V[c]) - x0) / cellM);
        const k0 = Math.floor((Math.min(V[a + 2], V[b + 2], V[c + 2]) - z0) / cellM), k1 = Math.floor((Math.max(V[a + 2], V[b + 2], V[c + 2]) - z0) / cellM);
        for (let k = Math.max(0, k0); k <= Math.min(nz - 1, k1); k++) for (let i = Math.max(0, i0); i <= Math.min(nx - 1, i1); i++) visit(k * nx + i);
    };
    for (let t = 0; t < scan.triCount; t++) if (!include || include(t)) bin(t, c => { counts[c + 1]++; });
    for (let c = 0; c < nx * nz; c++) counts[c + 1] += counts[c];
    const tris = new Uint32Array(counts[nx * nz]), fill = counts.slice(0, nx * nz);
    for (let t = 0; t < scan.triCount; t++) if (!include || include(t)) bin(t, c => { tris[fill[c]++] = t; });
    return (x, z) => {
        const i = Math.floor((x - x0) / cellM), k = Math.floor((z - z0) / cellM);
        if (i < 0 || k < 0 || i >= nx || k >= nz) return NaN;
        const c = k * nx + i;
        let best = NaN;
        for (let q = counts[c]; q < counts[c + 1]; q++) {
            const t = tris[q], a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, cc = I[t * 3 + 2] * 3;
            const ax = V[a], az = V[a + 2], bx = V[b] - ax, bz = V[b + 2] - az, cx = V[cc] - ax, cz = V[cc + 2] - az;
            const det = bx * cz - bz * cx;
            if (Math.abs(det) < 1e-12) continue;
            const px = x - ax, pz = z - az;
            const u = (px * cz - pz * cx) / det, v = (bx * pz - bz * px) / det;
            if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
            const y = V[a + 1] + u * (V[b + 1] - V[a + 1]) + v * (V[cc + 1] - V[a + 1]);
            if (!(best >= y)) best = y;
        }
        return best;
    };
}

function quantile(values: number[], p: number): number {
    if (!values.length) return NaN;
    const s = [...values].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

/** One reading across a kerb line, outward (toward the sidewalk) from the point it was read at. */
export interface KerbSectionReading {
    kind: 'kerb' | 'ramp' | 'none';
    /** Where the face stands, outward from the read point (m). */
    shiftM: number;
    /** The road's level just inside the face, and the sidewalk's just behind it (m). */
    roadY: number; topY: number;
    /** The face's height: topY - roadY (m). */
    faceM: number;
    /** The rise from the road to the sidewalk further back (m). */
    riseM: number;
    /** How far across the rise runs, 20 % to 80 % of it (m). */
    runM: number;
    /** The road's spread inside the face (80th minus 20th percentile, m): the scan's noise there. */
    noiseM: number;
    /** The dip at the face's foot, where the scan resolves one. */
    gutter?: { widthM: number; depthM: number };
    /** Why it is a ramp or nothing. */
    reason?: string;
    /** Nothing, because the surface rises past a kerb's height here (a wall, a stoop, a car): the kerb may stand further in. */
    wall?: boolean;
}

/**
 * Reads the scan across a kerb: offsets from -reach (the road side) to +reach (the sidewalk side) of (x, z) along the
 * outward unit (ox, oz), each the median of three reads along (tx, tz).
 */
export function readKerbSection(h: HeightAt, x: number, z: number, ox: number, oz: number, tx: number, tz: number, P: RoadKerbParams = ROAD_KERB_PARAMS): KerbSectionReading {
    const us: number[] = [], hs: number[] = [];
    const n = Math.round(P.sectionReachM / P.sectionStepM);
    const back = Math.round(P.rampBackM / P.sectionStepM);
    for (let k = -n; k <= Math.max(n, back); k++) {
        const u = k * P.sectionStepM, vals: number[] = [];
        for (const a of [-P.sectionAlongM, 0, P.sectionAlongM]) { const v = h(x + ox * u + tx * a, z + oz * u + tz * a); if (v === v) vals.push(v); }
        us.push(u); hs.push(vals.length ? quantile(vals, 0.5) : NaN);
    }
    const win = (lo: number, hi: number) => hs.filter((v, i) => v === v && us[i] >= lo - 1e-9 && us[i] <= hi + 1e-9);
    const none = (reason: string, extra: Partial<KerbSectionReading> = {}): KerbSectionReading => ({ kind: 'none', shiftM: 0, roadY: NaN, topY: NaN, faceM: 0, riseM: 0, runM: 0, noiseM: NaN, reason, ...extra });
    const inner = win(-P.sectionReachM, -0.5), outer = win(0.5, P.sectionReachM);
    if (inner.length < 4 || outer.length < 4) return none('the scan has no surface across the kerb line here');
    // both levels read low: cars stand on the road, bollards, planters and sheds' posts on the sidewalk
    const roadFar = quantile(inner, 0.3), topFar = quantile(outer, 0.25), rise = topFar - roadFar;
    // the sidewalk's highest level further back (a ramp's top), at most a kerb's height up: a wall or a stoop behind is not it
    const backTop = (() => { let m = -Infinity; for (let lo = 0.5; lo + 0.5 <= P.rampBackM + 1e-9; lo += 0.25) { const w = win(lo, lo + 0.5); if (w.length < 4) continue; const v = quantile(w, 0.5); if (v - roadFar <= P.maxRiseM) m = Math.max(m, v); } return m; })();
    if (rise > P.maxRiseM) return none(`the surface rises ${rise.toFixed(2)} m here: a wall or an object, not a kerb`, { riseM: rise, roadY: roadFar, wall: true });
    if (rise < P.rampRiseM && !(backTop - roadFar >= P.rampRiseM)) return none(`no step: the sidewalk side stands ${rise.toFixed(3)} m above the road`, { riseM: rise, roadY: roadFar });
    // the face: the first sustained crossing of the half rise going outward (a step the scan smears over a few samples)
    const mid = roadFar + Math.max(rise, P.rampRiseM) / 2;
    let e = NaN;
    for (let i = 1; i < us.length; i++) {
        if (!(hs[i] >= mid) || us[i] > P.sectionReachM) continue;
        const ahead = hs.slice(i, i + 4).filter(v => v === v);
        if (ahead.length < 2 || quantile(ahead, 0.5) < mid) continue;
        let j = i - 1;
        while (j >= 0 && hs[j] !== hs[j]) j--;
        e = j >= 0 && hs[i] > hs[j] ? us[j] + ((mid - hs[j]) / (hs[i] - hs[j])) * (us[i] - us[j]) : us[i];
        break;
    }
    if (e !== e) return none('no crossing of the half rise across the line', { riseM: rise, roadY: roadFar });
    if (Math.abs(e) > P.maxShiftM) return none(`the step stands ${e.toFixed(2)} m from where SB-Roadie found the kerb`, { riseM: rise, roadY: roadFar });
    // the levels beside the face, and how far across the rise runs
    const near = win(e - 1.0, e - 0.45), behind = win(e + 0.15, e + 0.5);
    if (near.length < 4 || behind.length < 3) return none('the scan has too little surface beside the face', { riseM: rise, roadY: roadFar });
    const roadY = quantile(near, 0.3), topY = quantile(behind, 0.3), face = topY - roadY;
    const noise = quantile(near, 0.8) - quantile(near, 0.2);
    const cross = (level: number) => { for (let i = 1; i < us.length; i++) if (us[i] >= e - 1 && hs[i] >= level) return us[i]; return NaN; };
    const lift = Math.max(topFar, backTop) - roadY;
    const run = cross(roadY + 0.8 * lift) - cross(roadY + 0.2 * lift);
    // the gutter: a dip at the face's foot below the road's own line (its cross-fall fitted beyond the gutter and carried
    // to the face), deeper than the road's own spread
    let gutter: KerbSectionReading['gutter'];
    const pts = us.map((u, i) => ({ u, v: hs[i] })).filter(p => p.v === p.v);
    const ref = pts.filter(p => p.u >= e - P.sectionReachM - 0.3 && p.u <= e - P.maxDipWidthM - 0.05), foot = pts.filter(p => p.u >= e - P.maxDipWidthM && p.u <= e - 0.05);
    if (ref.length >= 5 && foot.length >= 3) {
        const mu = ref.reduce((a, p) => a + p.u, 0) / ref.length, mv = ref.reduce((a, p) => a + p.v, 0) / ref.length;
        const suu = ref.reduce((a, p) => a + (p.u - mu) ** 2, 0), slope = suu > 0 ? ref.reduce((a, p) => a + (p.u - mu) * (p.v - mv), 0) / suu : 0;
        const line = (u: number) => mv + slope * (u - mu);
        const low = foot.reduce((a, p) => (p.v - line(p.u) < a.v - line(a.u) ? p : a));
        const dip = line(low.u) - low.v;
        if (dip >= Math.max(P.minDipM, P.dipNoise * noise)) {
            let start = low.u;
            for (const p of [...foot].reverse()) if (p.u <= low.u) { if (p.v <= line(p.u) - 0.25 * dip) start = p.u; else break; }
            const width = e - start;
            if (width >= P.minDipWidthM && width <= P.maxDipWidthM) gutter = { widthM: width, depthM: dip };
        }
    }
    const base = { shiftM: e, roadY, topY, faceM: face, riseM: rise, runM: run === run ? run : 0, noiseM: noise, ...(gutter ? { gutter } : {}) };
    if (face >= P.minRiseM && face <= P.maxRiseM && !(run > P.maxFaceRunM)) return { kind: 'kerb', ...base };
    if (face < P.minRiseM && Math.max(rise, backTop - roadY) >= P.rampRiseM) return { kind: 'ramp', ...base, faceM: Math.max(0, face), reason: `the face is ${Math.max(0, face).toFixed(3)} m while the sidewalk behind stands ${Math.max(rise, backTop - roadY).toFixed(2)} m up: a ramp to the road` };
    if (run > P.maxFaceRunM && Math.max(rise, backTop - roadY) >= P.rampRiseM) return { kind: 'ramp', ...base, reason: `the rise runs ${run.toFixed(2)} m across: a ramp's slope, not a face` };
    return none(`a ${face.toFixed(3)} m face over a ${run === run ? run.toFixed(2) : '?'} m run is no kerb`, base);
}

export type KerbSource = 'fine' | 'coarse' | 'between';
export type GutterSource = 'measured' | 'generated';

/** One side of one sample: the kerb drawn there. */
export interface KerbSide {
    /** Distance from the carrier to the face, outward (m). */
    offsetM: number;
    /** The kerb top, and the face's foot (the gutter's invert) (m). */
    topY: number; footY: number;
    /** The face as drawn: topY - footY (m). */
    faceM: number;
    ramp: boolean;
    /** Where the face's position came from: the fine read, SB-Roadie's step, or carried along the line from its neighbours (a ramp). */
    source: KerbSource;
    /** The scan smears this kerb over this run across (m): the face stands at its half-rise crossing, its height the measured rise. */
    softRunM?: number;
    /** Where the street's straight kerb line runs, when the kerb bends off it here (into a corner): the joins' lines are these. */
    lineOffsetM?: number;
    gutter: { widthM: number; depthM: number; source: GutterSource; reason?: string };
}

/** A sample along a street: SB-Roadie's station (or one read again in a gap it bridged), its carrier smoothed. */
export interface KerbSample {
    x: number; z: number; tx: number; tz: number; nx: number; nz: number;
    /** SB-Roadie's station, else a sample read in a gap it bridged. */
    station: boolean;
    /** The camber: lateral positions from the carrier (left negative) and levels, left to right. */
    camber: Array<[number, number]>;
    /** Where the carriageway ends on a side with no kerb (m from the carrier). */
    edgeL: number; edgeR: number;
    left?: KerbSide; right?: KerbSide;
    median?: { leftM: number; rightM: number; level: number };
    /** The sidewalk SB-Roadie measured beyond each kerb (width from the kerb, level). */
    walkL?: { widthM: number; level: number }; walkR?: { widthM: number; level: number };
    /** Why a side has no kerb drawn. */
    noKerb?: { left?: string; right?: string };
}

export interface KerbRun { id: string; samples: KerbSample[] }

/** A kerb along a polyline outside a street's run: a corner's arc or a straight span across a gap. */
export interface KerbJoinSample {
    /** The face's foot line point, the outward unit (toward the sidewalk) and the tangent. */
    x: number; z: number; ox: number; oz: number;
    topY: number; footY: number; edgeY: number;
    ramp: boolean;
    gutter: { widthM: number; depthM: number; source: GutterSource; reason?: string };
    source: KerbSource;
    /** A run's own kerb end ("run|sample index|side"): the join's sweep starts or ends on that run's cross-section. */
    anchor?: string;
}

export interface KerbJoin {
    kind: 'corner' | 'straight';
    from: { run: string; end: 'start' | 'end'; side: 'left' | 'right' };
    to: { run: string; end: 'start' | 'end'; side: 'left' | 'right' };
    /** Drawn: the scan showed the kerb; else the reason it was not. */
    drawn: boolean;
    reason?: string;
    radiusM?: number;
    /** The rays that agreed on the radius, of those cast. */
    rays?: { hits: number; cast: number; spreadM: number };
    /** Pieces drawn (a straight span breaks where the scan shows no kerb). */
    pieces: KerbJoinSample[][];
}

export interface KerbModelStats {
    /** Kerb line where a kerb (or ramp) was measured, along the streets' runs (m), and drawn in all, joins included. */
    measuredM: number; drawnM: number;
    /** Of the drawn: read on the scan's triangles, SB-Roadie's step, carried along the line (through a ramp, past one sample an object hides); ramps; joins. */
    fineM: number; coarseM: number; betweenM: number; rampM: number; cornerM: number; straightJoinM: number;
    /** Of the drawn: kerb the scan smears over more than a face's run (its face at the half-rise crossing, its height the rise) (m). */
    softM: number;
    /** Kerb line along the streets' runs where no kerb was measured on either sample (m): nothing drawn there (the reasons below). */
    notDrawnM: number;
    gutterMeasuredM: number; gutterGeneratedM: number;
    corners: { drawn: number; notDrawn: number; radiusP50M: number | null };
    straightJoins: { drawn: number; notDrawn: number };
    /** The drawn face heights (m). */
    faceP10M: number | null; faceP50M: number | null; faceP90M: number | null;
    /** Why kerbs or joins were not drawn, counted. */
    reasons: Record<string, number>;
}

export interface KerbModel { version: string; runs: KerbRun[]; joins: KerbJoin[]; stats: KerbModelStats }

const sideOf = (s: RoadStation, side: 'left' | 'right') => s[side];

/** The station's carriageway levels at their lateral positions (SB-Roadie's convention: left negative), the median's level left out. */
function camberOf(s: RoadStation, liftM: number): Array<[number, number]> {
    const L = s.left.halfWidthM, R = s.right.halfWidthM, p = s.profile.map(v => v - liftM);
    if (s.median) {
        const ml = s.median.leftEdgeM, mr = s.median.rightEdgeM;
        return [[-L, p[0]], [-(ml + (L - ml) / 2), p[1]], [-ml, p[1]], [mr, p[3]], [mr + (R - mr) / 2, p[3]], [R, p[4]]];
    }
    return [[-L, p[0]], [-L / 2, p[1]], [0, p[2]], [R / 2, p[3]], [R, p[4]]];
}

/** The camber's level at lateral position d: linear between its points, flat beyond its ends; a median's span skipped. */
export function camberAt(camber: Array<[number, number]>, d: number): number {
    if (d <= camber[0][0]) return camber[0][1];
    for (let i = 0; i + 1 < camber.length; i++) {
        const [a, ya] = camber[i], [b, yb] = camber[i + 1];
        if (d <= b) return b - a > 1e-9 ? ya + ((d - a) / (b - a)) * (yb - ya) : yb;
    }
    return camber[camber.length - 1][1];
}

/** A median over 2k+1 then a mean over 3 of the finite values (missing ones filled from their nearest neighbours first). */
function smoothLine(values: Array<number | undefined>, k: number): Array<number | undefined> {
    const n = values.length;
    const filled = values.map((v, i) => {
        if (v !== undefined) return v;
        for (let q = 1; q < n; q++) { const a = values[i - q], b = values[i + q]; if (a !== undefined && b !== undefined) return (a + b) / 2; if (a !== undefined || b !== undefined) return (a ?? b)!; }
        return undefined;
    });
    const med = filled.map((v, i) => { if (v === undefined) return undefined; const w = filled.slice(Math.max(0, i - k), i + k + 1).filter((x): x is number => x !== undefined); return quantile(w, 0.5); });
    return med.map((v, i) => { if (v === undefined || values[i] === undefined) return values[i] === undefined ? filled[i] : v; const w = med.slice(Math.max(0, i - 1), i + 2).filter((x): x is number => x !== undefined); return w.reduce((a, b) => a + b, 0) / w.length; });
}

/** A robust local line: at each sample, the line fitted to the values within halfM along (those off it by more than trimM left out, once). */
function robustLine(along: number[], values: Array<number | undefined>, halfM: number, trimM: number): Array<number | undefined> {
    const fit = (pts: Array<[number, number]>) => {
        const ma = pts.reduce((s, p) => s + p[0], 0) / pts.length, mv = pts.reduce((s, p) => s + p[1], 0) / pts.length;
        const saa = pts.reduce((s, p) => s + (p[0] - ma) ** 2, 0);
        const b = saa > 1e-9 ? pts.reduce((s, p) => s + (p[0] - ma) * (p[1] - mv), 0) / saa : 0;
        return (x: number) => mv + b * (x - ma);
    };
    return values.map((own, i) => {
        const pts: Array<[number, number]> = [];
        values.forEach((v, j) => { if (v !== undefined && Math.abs(along[j] - along[i]) <= halfM) pts.push([along[j], v]); });
        if (!pts.length) return own;
        if (pts.length < 3) return quantile(pts.map(p => p[1]), 0.5);
        // a first line through the median, then the line through the values near it
        const med = quantile(pts.map(p => p[1]), 0.5);
        const near = pts.filter(p => Math.abs(p[1] - med) <= Math.max(trimM, 0.5));
        const first = fit(near.length >= 3 ? near : pts);
        const kept = pts.filter(p => Math.abs(p[1] - first(p[0])) <= trimM);
        return (kept.length >= 3 ? fit(kept) : first)(along[i]);
    });
}

interface RawSide { reading?: KerbSectionReading; coarse?: { halfWidthM: number; topY: number }; coarseRejected?: string }

/**
 * The kerbs of SB-Roadie's measured streets read again on the scan's triangles, smoothed along each street, and joined
 * at crossings where the scan shows the kerb running on (around a corner or straight across a gap).
 */
export function measureKerbs(roads: RoadSurface[], h: HeightAt, roadParams: RoadSurfaceParams, P: RoadKerbParams = ROAD_KERB_PARAMS): KerbModel {
    const reasons: Record<string, number> = {};
    const why = (r: string) => { const k = r.replace(/-?\d+(\.\d+)?/g, '#'); reasons[k] = (reasons[k] ?? 0) + 1; };
    const runs: KerbRun[] = [];
    let measuredM = 0, notDrawnM = 0;
    for (const road of roads) {
        // the samples: SB-Roadie's stations, and fresh ones every gapStepM in a gap it bridged (dropped stations between two kept)
        type Raw = { s: RoadStation; station: boolean; left: RawSide; right: RawSide };
        const raws: Raw[] = [];
        road.stations.forEach((s, i) => {
            if (i > 0) {
                const a = road.stations[i - 1], gap = Math.hypot(s.x - a.x, s.z - a.z);
                const m = Math.round(gap / P.gapStepM);
                for (let k = 1; k < m; k++) {
                    const f = k / m, lerp = (p: number, q: number) => p + (q - p) * f;
                    let tx = lerp(a.tx, s.tx), tz = lerp(a.tz, s.tz);
                    const tl = Math.hypot(tx, tz) || 1;
                    tx /= tl; tz /= tl;
                    const sideAt = (side: 'left' | 'right') => ({ ...sideOf(a, side), halfWidthM: lerp(a[side].halfWidthM, s[side].halfWidthM), kerbTopY: a[side].kerbTopY !== undefined && s[side].kerbTopY !== undefined ? lerp(a[side].kerbTopY!, s[side].kerbTopY!) : undefined, sidewalk: undefined });
                    const g: RoadStation = {
                        x: lerp(a.x, s.x), z: lerp(a.z, s.z), tx, tz, nx: -tz, nz: tx, profile: a.profile.map((v, j) => lerp(v, s.profile[j])) as RoadStation['profile'],
                        left: sideAt('left'), right: sideAt('right'), ...(a.median && s.median ? { median: { leftEdgeM: lerp(a.median.leftEdgeM, s.median.leftEdgeM), rightEdgeM: lerp(a.median.rightEdgeM, s.median.rightEdgeM), level: lerp(a.median.level, s.median.level) } } : {}),
                        samples: 0, shiftM: lerp(a.shiftM, s.shiftM)
                    };
                    raws.push({ s: g, station: false, left: {}, right: {} });
                }
            }
            raws.push({ s, station: true, left: {}, right: {} });
        });
        for (const r of raws) for (const [side, sign] of [['left', -1], ['right', 1]] as const) {
            const sd = r.s[side];
            const ox = r.s.nx * sign, oz = r.s.nz * sign;
            const kx = r.s.x + ox * sd.halfWidthM, kz = r.s.z + oz * sd.halfWidthM;
            let rd = readKerbSection(h, kx, kz, ox, oz, r.s.tx, r.s.tz, P);
            const coarseRise = sd.kerbTopY !== undefined ? sd.kerbTopY - r.s.profile[side === 'left' ? 0 : 4] : NaN;
            // a wall where SB-Roadie stopped (its first sustained rise was a building, a stoop, a car): the kerb is looked for
            // further in, a metre at a time, the first kerb-height step found taken
            if (rd.kind !== 'kerb' && (rd.wall || coarseRise > P.maxRiseM)) for (let o = sd.halfWidthM - P.inwardStepM; o >= roadParams.minHalfWidthM - 1e-9; o -= P.inwardStepM) {
                const q = readKerbSection(h, r.s.x + ox * o, r.s.z + oz * o, ox, oz, r.s.tx, r.s.tz, P);
                // a crisp step, or a slope (a kerb the scan smears, or a ramp: told apart along the street below)
                if (q.kind !== 'none') { rd = { ...q, shiftM: q.shiftM - (sd.halfWidthM - o), reason: `the kerb ${(sd.halfWidthM - o - q.shiftM).toFixed(2)} m inside SB-Roadie's step (a wall or an object)` }; break; }
            }
            r[side].reading = rd;
            // SB-Roadie's step stands in where the fine read finds none, only when it is a kerb's height above the road beside it
            // (its first sustained rise is as often a wall, a car or a scaffold shed: those are no kerb)
            if (r.station && sd.kerb === 'measured' && sd.kerbTopY !== undefined) {
                const rise = coarseRise;
                if (rise >= P.minRiseM && rise <= P.maxRiseM) r[side].coarse = { halfWidthM: sd.halfWidthM, topY: sd.kerbTopY - roadParams.liftM };
                else r[side].coarseRejected = `SB-Roadie's step here rises ${rise.toFixed(2)} m: a wall or an object, not a kerb`;
            }
        }
        // the carrier: Google's own centreline, smooth (each station records how far SB-Roadie moved it onto the measured street,
        // jumping between lane windows and recentring between its own kerbs: none of that jitter reaches the kerb line)
        const delta = raws.map(r => -r.s.shiftM);
        // the distance along the run, for the line fits
        const along: number[] = [];
        raws.forEach((r, i) => along.push(i ? along[i - 1] + Math.hypot(r.s.x - raws[i - 1].s.x, r.s.z - raws[i - 1].s.z) : 0));
        // each side's face offset from the carrier: the fine read's where it found a kerb, SB-Roadie's where it did not
        const sides = (['left', 'right'] as const).map(side => {
            const sign = side === 'left' ? -1 : 1;
            // each sample's step: the fine read's face (a kerb, or a slope it took for a ramp), else SB-Roadie's step where believable
            const raw = raws.map((r, i): { offset: number | undefined; source: KerbSource; rd: KerbSectionReading; soft?: number } | undefined => {
                const rd = r[side].reading!, co = r[side].coarse, hw = r.s[side].halfWidthM;
                const off = (shift: number) => hw + shift - sign * delta[i];
                // a step the scan smears over more than a face's run: its top is the sidewalk's level further back
                const soft = rd.kind === 'ramp' || rd.runM > P.maxFaceRunM;
                if (rd.kind !== 'none') return { offset: off(rd.shiftM), source: 'fine' as KerbSource, rd: soft ? { ...rd, topY: rd.roadY + Math.max(rd.faceM, rd.riseM) } : rd, ...(soft ? { soft: rd.runM } : {}) };
                if (co) return { offset: off(0), source: 'coarse' as KerbSource, rd };
                return undefined;
            });
            // a ramp: just behind the kerb line its neighbours draw, the surface stands at the road's level (the face drops to the
            // road) while the sidewalk further back stands up; its face is carried on that line. A slope that is up already behind
            // the line is a kerb the scan smears (labelled soft)
            const pointAt = (i: number, offset: number) => ({ x: raws[i].s.x + raws[i].s.nx * (delta[i] + sign * offset), z: raws[i].s.z + raws[i].s.nz * (delta[i] + sign * offset) });
            const ramps = raw.map((q, i) => {
                // a slope, not a crisp step: a kerb bending into a corner leaves the straight line's spot at the road's level too
                if (!q || q.source !== 'fine' || !(q.rd.runM >= P.rampMinRunM)) return undefined;
                const others = raw.slice(Math.max(0, i - 2), i + 3).filter(o => o && o !== q && o.offset !== undefined && (o.rd.kind === 'kerb' || o.source === 'coarse')).map(o => o!.offset!);
                const line = others.length ? quantile(others, 0.5) : q.offset!;
                const f = pointAt(i, line), ox = raws[i].s.nx * sign, oz = raws[i].s.nz * sign, behind: number[] = [];
                for (let u = 0.1; u <= 0.3 + 1e-9; u += P.sectionStepM) for (const a of [-P.sectionAlongM, 0, P.sectionAlongM]) { const v = h(f.x + ox * u + raws[i].s.tx * a, f.z + oz * u + raws[i].s.tz * a); if (v === v) behind.push(v); }
                if (!behind.length || !(quantile(behind, 0.3) - q.rd.roadY < P.rampFaceM) || !(q.rd.riseM >= P.rampRiseM)) return undefined;
                return { line, top: quantile(behind, 0.3) };
            });
            raw.forEach((q, i) => { if (q && ramps[i]) raw[i] = { offset: undefined, source: 'between', rd: { ...q.rd, kind: 'ramp' } }; });
            // a gap of one sample in a measured kerb line (its read failed: an object at the kerb, a car's remnant) is carried
            // across where the scan there still steps up a kerb's height at the carried line
            for (let i = 1; i + 1 < raw.length; i++) {
                const a = raw[i - 1], b = raw[i + 1];
                if (raw[i] || !a || !b || a.offset === undefined || b.offset === undefined) continue;
                const line = (a.offset + b.offset) / 2, f = pointAt(i, line), ox = raws[i].s.nx * sign, oz = raws[i].s.nz * sign;
                const at = (u0: number, u1: number) => { const v: number[] = []; for (let u = u0; u <= u1 + 1e-9; u += P.sectionStepM) for (const w of [-P.sectionAlongM, 0, P.sectionAlongM]) { const y = h(f.x + ox * u + raws[i].s.tx * w, f.z + oz * u + raws[i].s.tz * w); if (y === y) v.push(y); } return v; };
                const front = at(-0.6, -0.2), behind = at(0.1, 0.4);
                if (front.length < 3 || behind.length < 3) continue;
                const step = quantile(behind, 0.3) - quantile(front, 0.3);
                if (step >= P.minRiseM * 0.8 && step <= P.maxRiseM) raw[i] = { offset: line, source: 'between', rd: { ...a.rd, kind: 'kerb', roadY: quantile(front, 0.3), topY: quantile(behind, 0.3), faceM: step, gutter: undefined } };
            }
            // the kerb line: a robust local line along the run (the scan's step jitters a few decimetres either way); only at a
            // stretch's ends may the line bend off it, where the scan already curves into a corner
            const lineOffsets = robustLine(along, raw.map(q => q?.offset), P.lineHalfM, P.lineTrimM);
            const offsets = lineOffsets.map((v, i) => {
                const own = raw[i]?.offset;
                const nearEnd = [1, 2].some(k => !raw[i - k] || !raw[i + k]);
                return own !== undefined && v !== undefined && nearEnd && Math.abs(v - own) > P.bendM ? own : v;
            });
            const tops = smoothLine(raw.map((q, i) => (q?.source === 'fine' ? q.rd.topY : q?.source === 'coarse' ? raws[i][side].coarse!.topY : undefined)), 1);
            // a gutter is measured over a stretch where most of the samples around read one; its size the median of theirs
            const dips = raw.map(q => q?.rd.gutter);
            return raw.map((q, i): { side?: KerbSide; reason?: string } => {
                if (!q) { const rs = raws[i][side].coarseRejected ?? raws[i][side].reading!.reason ?? 'no kerb measured'; return { reason: rs }; }
                const off = offsets[i];
                if (off === undefined) return { reason: 'no kerb measured on this stretch to carry the line from' };
                const near = dips.slice(Math.max(0, i - 2), i + 3);
                const seen = near.filter((g): g is NonNullable<typeof g> => !!g);
                const measured = seen.length >= 2 && seen.length * 2 > near.length;
                const gutter = measured
                    ? { widthM: quantile(seen.map(g => g.widthM), 0.5), depthM: quantile(seen.map(g => g.depthM), 0.5), source: 'measured' as GutterSource }
                    : { widthM: P.gutterWidthM, depthM: P.gutterDepthM, source: 'generated' as GutterSource, reason: q.rd.noiseM === q.rd.noiseM ? `the scan shows no dip at the face's foot here (its road spreads ${(q.rd.noiseM * 100).toFixed(1)} cm): a plausible gutter` : 'the scan resolves no gutter here: a plausible one' };
                const top = ramps[i] ? ramps[i]!.top : q.source === 'between' ? q.rd.topY : (tops[i] ?? q.rd.topY);
                const line = lineOffsets[i];
                return { side: { offsetM: off, topY: top, footY: NaN, faceM: NaN, ramp: !!ramps[i], source: q.source, gutter, ...(q.soft !== undefined ? { softRunM: Math.round(q.soft * 100) / 100 } : {}), ...(line !== undefined && Math.abs(line - off) > 1e-9 ? { lineOffsetM: line } : {}) } };
            });
        });
        const samples: KerbSample[] = raws.map((r, i) => {
            const s = r.s;
            const cx = s.x + s.nx * delta[i], cz = s.z + s.nz * delta[i];
            const camber = camberOf(s, roadParams.liftM).map(([d, y]) => [d - delta[i], y] as [number, number]);
            const out: KerbSample = {
                x: cx, z: cz, tx: s.tx, tz: s.tz, nx: s.nx, nz: s.nz, station: r.station, camber,
                edgeL: s.left.halfWidthM + delta[i], edgeR: s.right.halfWidthM - delta[i],
                ...(s.median ? { median: { leftM: s.median.leftEdgeM + delta[i], rightM: s.median.rightEdgeM - delta[i], level: s.median.level - roadParams.liftM } } : {}),
                ...(s.left.sidewalk ? { walkL: { widthM: s.left.sidewalk.widthM, level: s.left.sidewalk.level - roadParams.liftM } } : {}),
                ...(s.right.sidewalk ? { walkR: { widthM: s.right.sidewalk.widthM, level: s.right.sidewalk.level - roadParams.liftM } } : {})
            };
            for (const [k, side, sign] of [[0, 'left', -1], [1, 'right', 1]] as const) {
                const got = sides[k][i];
                if (!got.side) { out.noKerb = { ...out.noKerb, [side]: got.reason }; why(got.reason ?? 'no kerb'); continue; }
                const sd = got.side;
                const edgeY = camberAt(camber, sign * (sd.offsetM - sd.gutter.widthM));
                sd.footY = edgeY - sd.gutter.depthM;
                // a kerb top under the road beside it is a flush ramp: the top sits on the road
                if (!(sd.topY >= edgeY)) sd.topY = edgeY;
                sd.faceM = sd.topY - sd.footY;
                out[side] = sd;
            }
            return out;
        });
        // the kerb line measured, and what SB-Roadie bridged that shows no kerb on the scan
        for (let i = 0; i + 1 < samples.length; i++) {
            const len = Math.hypot(samples[i + 1].x - samples[i].x, samples[i + 1].z - samples[i].z);
            for (const side of ['left', 'right'] as const) {
                const a = samples[i][side], b = samples[i + 1][side];
                if (a && b) measuredM += len;
                else if (a || b) measuredM += len / 2;
                if (!a && !b) notDrawnM += len;
            }
        }
        runs.push({ id: road.id, samples });
    }
    const joins = joinKerbs(runs, h, P, why);
    return { version: ROAD_KERBS_VERSION, runs, joins, stats: kerbStats(runs, joins, measuredM, notDrawnM, reasons) };
}

/** A side's face point (on the foot line) and outward unit at a sample. */
function facePoint(s: KerbSample, side: 'left' | 'right'): { x: number; z: number; ox: number; oz: number } {
    const sign = side === 'left' ? -1 : 1, o = s[side]!.offsetM;
    return { x: s.x + s.nx * sign * o, z: s.z + s.nz * sign * o, ox: s.nx * sign, oz: s.nz * sign };
}

interface KerbEnd {
    run: string; end: 'start' | 'end'; side: 'left' | 'right'; /** The sample's index in its run. */ i: number; s: KerbSample; k: KerbSide;
    /** The end's face point (where a join meets the run) ... */
    x: number; z: number;
    /** ... and the street's straight kerb line there (the same, unless the kerb already bends into the corner). */
    lx: number; lz: number;
    ox: number; oz: number; /** Unit along the line, out of the run. */ tx: number; tz: number;
}

/** Every stretch end of every side's kerb along the runs (a stretch: consecutive samples with that side's kerb). */
function kerbEnds(runs: KerbRun[]): KerbEnd[] {
    const ends: KerbEnd[] = [];
    for (const r of runs) for (const side of ['left', 'right'] as const) {
        const S = r.samples;
        for (let i = 0; i < S.length; i++) {
            if (!S[i][side]) continue;
            const startHere = i === 0 || !S[i - 1][side], endHere = i === S.length - 1 || !S[i + 1][side];
            const f = facePoint(S[i], side), lo = S[i][side]!.lineOffsetM ?? S[i][side]!.offsetM;
            const l = { lx: S[i].x + f.ox * lo, lz: S[i].z + f.oz * lo };
            if (startHere) ends.push({ run: r.id, end: 'start', side, i, s: S[i], k: S[i][side]!, ...f, ...l, tx: -S[i].tx, tz: -S[i].tz });
            if (endHere) ends.push({ run: r.id, end: 'end', side, i, s: S[i], k: S[i][side]!, ...f, ...l, tx: S[i].tx, tz: S[i].tz });
        }
    }
    return ends;
}

/** The join's samples along a polyline of face points, each read across: a kerb, a ramp, or nothing (a break). */
function readAlong(points: Array<{ x: number; z: number; ox: number; oz: number; tx: number; tz: number; top: number; edge: number }>, h: HeightAt, P: RoadKerbParams, fixed: Set<number>): Array<KerbJoinSample | undefined> {
    return points.map((p, i) => {
        if (fixed.has(i)) return undefined;
        const rd = readKerbSection(h, p.x, p.z, p.ox, p.oz, p.tx, p.tz, { ...P, maxShiftM: Math.min(P.maxShiftM, 0.4) });
        if (rd.kind === 'none') return undefined;
        const gutter = rd.gutter ? { ...rd.gutter, source: 'measured' as GutterSource } : { widthM: P.gutterWidthM, depthM: P.gutterDepthM, source: 'generated' as GutterSource, reason: 'the scan resolves no gutter here: a plausible one' };
        const edgeY = rd.roadY === rd.roadY ? rd.roadY : p.edge;
        const topY = Math.max(edgeY, rd.kind === 'kerb' ? rd.topY : rd.topY === rd.topY ? rd.topY : edgeY);
        return { x: p.x, z: p.z, ox: p.ox, oz: p.oz, topY, footY: edgeY - gutter.depthM, edgeY, ramp: rd.kind === 'ramp', gutter, source: rd.kind === 'kerb' ? 'fine' : 'between' };
    });
}

/** A run's kerb end as a join's first or last sample (its exact face point and levels, so the join meets the run's sweep). */
function endSample(e: KerbEnd): KerbJoinSample {
    const edgeY = e.k.footY + e.k.gutter.depthM;
    return { x: e.x, z: e.z, ox: e.ox, oz: e.oz, topY: e.k.topY, footY: e.k.footY, edgeY, ramp: e.k.ramp, gutter: e.k.gutter, source: e.k.source, anchor: `${e.run}|${e.i}|${e.side}` };
}

/** The corner's radius, from rays cast from the corner point into the block across its kerb (the arc tangent to both lines). */
function cornerRadius(a: KerbEnd, b: KerbEnd, C: { x: number; z: number }, h: HeightAt, P: RoadKerbParams): { radiusM?: number; hits: number; spreadM: number; reason?: string } {
    const c = a.ox * b.ox + a.oz * b.oz;
    const wx = (a.ox + b.ox) / (1 + c), wz = (a.oz + b.oz) / (1 + c), w2 = wx * wx + wz * wz, A = w2 - 1;
    if (!(A > 1e-3)) return { hits: 0, spreadM: 0, reason: 'the kerb lines are too near parallel for a corner' };
    const road = (a.k.footY + b.k.footY) / 2 + (a.k.gutter.depthM + b.k.gutter.depthM) / 2, top = (a.k.topY + b.k.topY) / 2;
    const mid = road + Math.max(P.minRiseM, top - road) / 2;
    // the rays: from the corner point into the block, between the two lines (their ends left out: they graze the lines)
    const d0 = Math.atan2(-a.tz, -a.tx), d1 = Math.atan2(-b.tz, -b.tx);
    let span = d1 - d0;
    while (span > Math.PI) span -= 2 * Math.PI;
    while (span < -Math.PI) span += 2 * Math.PI;
    // far enough to meet the largest arc on any ray (past it lies the centre)
    const reach = P.cornerMaxRadiusM * Math.sqrt(w2) + 2;
    const radii: number[] = [];
    for (let j = 0; j < P.cornerRays; j++) {
        const f = 0.15 + (0.7 * j) / Math.max(1, P.cornerRays - 1), ang = d0 + span * f, dx = Math.cos(ang), dz = Math.sin(ang);
        // the first sustained crossing of the half rise going into the block
        let hit = NaN, prev = NaN, prevT = 0;
        for (let t = 0; t <= reach; t += P.sectionStepM) {
            const v = h(C.x + dx * t, C.z + dz * t);
            if (v === v && v >= mid && v - road <= P.maxRiseM + 0.1) {
                let ok = 0, seen = 0;
                for (let q = 1; q <= 4; q++) { const u = h(C.x + dx * (t + q * P.sectionStepM), C.z + dz * (t + q * P.sectionStepM)); if (u === u) { seen++; if (u >= mid) ok++; } }
                if (seen >= 2 && ok >= seen - 1) { hit = prev === prev && v > prev ? prevT + ((mid - prev) / (v - prev)) * (t - prevT) : t; break; }
            }
            if (v === v) { prev = v; prevT = t; }
        }
        if (hit !== hit) continue;
        // the arc through that point: |K - C - R w| = R; of the two circles tangent to both lines through it, the one whose
        // arc faces the corner point (K between C and the centre), not the small one K lies on the far side of
        const kx = dx * hit, kz = dz * hit, aa = kx * wx + kz * wz, bb = kx * kx + kz * kz;
        const disc = aa * aa - A * bb;
        if (disc < 0) continue;
        const R = [(aa + Math.sqrt(disc)) / A, (aa - Math.sqrt(disc)) / A].find(r => r > 0 && (kx - r * wx) * -wx + (kz - r * wz) * -wz > 0);
        if (R !== undefined && R >= P.cornerMinRadiusM && R <= P.cornerMaxRadiusM) radii.push(R);
    }
    if (radii.length < P.cornerMinHits) return { hits: radii.length, spreadM: 0, reason: `the scan shows the corner's kerb on ${radii.length} of ${P.cornerRays} rays across it (at least ${P.cornerMinHits} wanted)` };
    const R = quantile(radii, 0.5), spread = quantile(radii.map(r => Math.abs(r - R)), 0.5);
    if (spread > P.cornerMaxSpreadM) return { hits: radii.length, spreadM: spread, reason: `the rays across the corner disagree on its radius by ${spread.toFixed(2)} m (median)` };
    return { radiusM: R, hits: radii.length, spreadM: spread };
}

/** Joins the kerb ends at crossings: around a corner on the measured arc, or straight on across a gap, where the scan shows the kerb. */
function joinKerbs(runs: KerbRun[], h: HeightAt, P: RoadKerbParams, why: (r: string) => void): KerbJoin[] {
    const ends = kerbEnds(runs);
    type Cand = { a: KerbEnd; b: KerbEnd; kind: 'corner' | 'straight'; cost: number; C?: { x: number; z: number }; ua: number; ub: number };
    const cands: Cand[] = [];
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i], b = ends[j];
        if (a.run === b.run && a.side === b.side && Math.abs(a.s.x - b.s.x) + Math.abs(a.s.z - b.s.z) < 1e-6) continue;
        if (Math.abs(a.k.topY - b.k.topY) > P.joinMaxLevelM) continue;
        // the two kerb lines (each street's straight line at its end)
        const dx = b.lx - a.lx, dz = b.lz - a.lz, dist = Math.hypot(dx, dz);
        if (dist > P.cornerReachM * 2) continue;
        const along = a.tx * -b.tx + a.tz * -b.tz;
        if (along >= Math.cos((P.bridgeMaxDeg * Math.PI) / 180) && a.ox * b.ox + a.oz * b.oz > 0.9) {
            // straight on: b ahead of a along its line, little off it sideways
            const ahead = dx * a.tx + dz * a.tz, side = Math.abs(dx * a.ox + dz * a.oz);
            if (ahead > 0.2 && ahead <= P.bridgeM && side <= P.bridgeMaxOffsetM) cands.push({ a, b, kind: 'straight', cost: ahead + 4 * side, ua: ahead, ub: ahead });
            continue;
        }
        const cross = a.tx * b.tz - a.tz * b.tx;
        if (Math.abs(cross) < Math.sin((P.cornerMinDeg * Math.PI) / 180)) continue;
        // where the two lines meet: a + ua ta = b + ub tb
        const ua = (dx * b.tz - dz * b.tx) / cross, ub = (dx * a.tz - dz * a.tx) / cross;
        if (!(ua > -1 && ub > -1 && ua <= P.cornerReachM && ub <= P.cornerReachM)) continue;
        // the block is on both sidewalks' sides: each end stands on the other's sidewalk side of its line
        if (dx * a.ox + dz * a.oz <= 0 || -dx * b.ox - dz * b.oz <= 0) continue;
        cands.push({ a, b, kind: 'corner', cost: Math.max(0, ua) + Math.max(0, ub), C: { x: a.lx + a.tx * ua, z: a.lz + a.tz * ua }, ua, ub });
    }
    cands.sort((p, q) => p.cost - q.cost);
    const used = new Set<KerbEnd>();
    const joins: KerbJoin[] = [];
    for (const c of cands) {
        if (used.has(c.a) || used.has(c.b)) continue;
        used.add(c.a); used.add(c.b);
        const base = { kind: c.kind, from: { run: c.a.run, end: c.a.end, side: c.a.side }, to: { run: c.b.run, end: c.b.end, side: c.b.side } } as const;
        const first = endSample(c.a), last = endSample(c.b);
        const lerp = (p: number, q: number, f: number) => p + (q - p) * f;
        type Pt = { x: number; z: number; ox: number; oz: number; tx: number; tz: number; top: number; edge: number };
        const pts: Pt[] = [];
        let radius: ReturnType<typeof cornerRadius> | undefined;
        if (c.kind === 'straight') {
            const n = Math.max(1, Math.round(c.ua / 1));
            for (let k = 0; k <= n; k++) {
                const f = k / n;
                pts.push({ x: lerp(c.a.x, c.b.x, f), z: lerp(c.a.z, c.b.z, f), ox: c.a.ox, oz: c.a.oz, tx: c.a.tx, tz: c.a.tz, top: lerp(first.topY, last.topY, f), edge: lerp(first.edgeY, last.edgeY, f) });
            }
        } else {
            radius = cornerRadius(c.a, c.b, c.C!, h, P);
            if (radius.radiusM === undefined) { why(radius.reason!); joins.push({ ...base, drawn: false, reason: radius.reason, rays: { hits: radius.hits, cast: P.cornerRays, spreadM: radius.spreadM }, pieces: [] }); continue; }
            const R = radius.radiusM, cc = c.a.ox * c.b.ox + c.a.oz * c.b.oz;
            const wx = (c.a.ox + c.b.ox) / (1 + cc), wz = (c.a.oz + c.b.oz) / (1 + cc);
            const O = { x: c.C!.x + R * wx, z: c.C!.z + R * wz };
            // the arc from a's tangent point to b's: radial directions from -oa to -ob, the short way round
            const fa = Math.atan2(-c.a.oz, -c.a.ox);
            let sweep = Math.atan2(-c.b.oz, -c.b.ox) - fa;
            while (sweep > Math.PI) sweep -= 2 * Math.PI;
            while (sweep < -Math.PI) sweep += 2 * Math.PI;
            const arc = (f: number) => { const ang = fa + sweep * f; return { x: O.x + R * Math.cos(ang), z: O.z + R * Math.sin(ang), ox: -Math.cos(ang), oz: -Math.sin(ang) }; };
            // a run's end that lies past its tangent point already follows the arc: the arc starts at its first point ahead of that
            // end along the street (so the join never folds back over the run's last cross-section)
            const ahead = (e: KerbEnd, fromStart: boolean) => {
                for (let k = 0; k <= 128; k++) { const f = fromStart ? k / 128 : 1 - k / 128, p = arc(f); if ((p.x - e.x) * e.tx + (p.z - e.z) * e.tz >= 0.05) return f; }
                return fromStart ? 0 : 1;
            };
            const f0 = c.ua < R ? ahead(c.a, true) : 0, f1 = c.ub < R ? ahead(c.b, false) : 1;
            // both runs already follow the curve to (nearly) one another: the join is the short piece between their ends
            const meet = f1 - f0 < 1e-3;
            const ta = arc(f0), tb = arc(f1);
            const straight = (from: { x: number; z: number }, to: { x: number; z: number }, o: { ox: number; oz: number }, t: { tx: number; tz: number }, top0: number, top1: number, e0: number, e1: number, skipLast: boolean) => {
                const len = Math.hypot(to.x - from.x, to.z - from.z), n = Math.max(1, Math.round(len));
                for (let k = 0; k <= n - (skipLast ? 1 : 0); k++) { const f = k / n; pts.push({ x: lerp(from.x, to.x, f), z: lerp(from.z, to.z, f), ox: o.ox, oz: o.oz, tx: t.tx, tz: t.tz, top: lerp(top0, top1, f), edge: lerp(e0, e1, f) }); }
            };
            const midTop = (first.topY + last.topY) / 2, midEdge = (first.edgeY + last.edgeY) / 2;
            if (meet) {
                straight(c.a, c.b, c.a, c.a, first.topY, last.topY, first.edgeY, last.edgeY, false);
            } else {
                straight(c.a, ta, c.a, c.a, first.topY, midTop, first.edgeY, midEdge, true);
                const steps = Math.max(2, Math.ceil(Math.max((Math.abs(sweep * (f1 - f0)) * 180) / Math.PI / P.arcStepDeg, (Math.abs(sweep * (f1 - f0)) * R) / P.arcStepM)));
                for (let k = 0; k <= steps; k++) { const p = arc(f0 + ((f1 - f0) * k) / steps); pts.push({ ...p, tx: -p.oz, tz: p.ox, top: midTop, edge: midEdge }); }
                const back: Pt[] = [];
                const len = Math.hypot(c.b.x - tb.x, c.b.z - tb.z), n = Math.max(1, Math.round(len));
                for (let k = 1; k <= n; k++) { const f = k / n; back.push({ x: lerp(tb.x, c.b.x, f), z: lerp(tb.z, c.b.z, f), ox: c.b.ox, oz: c.b.oz, tx: -c.b.tx, tz: -c.b.tz, top: lerp(midTop, last.topY, f), edge: lerp(midEdge, last.edgeY, f) }); }
                pts.push(...back);
            }
        }
        // the ends are the runs' own; every point between read across
        const fixed = new Set([0, pts.length - 1]);
        const read = readAlong(pts, h, P, fixed);
        read[0] = first; read[read.length - 1] = last;
        // a corner's arc was measured by its rays: a point on it the section read finds no step on keeps the arc, its levels carried
        const samples = read.map((r, i) => (r ?? (c.kind === 'corner' ? { x: pts[i].x, z: pts[i].z, ox: pts[i].ox, oz: pts[i].oz, topY: pts[i].top, footY: pts[i].edge - P.gutterDepthM, edgeY: pts[i].edge, ramp: false, gutter: { widthM: P.gutterWidthM, depthM: P.gutterDepthM, source: 'generated' as GutterSource, reason: 'the scan resolves no gutter here: a plausible one' }, source: 'between' as KerbSource } : undefined)));
        // the levels along a corner: what each read found, else carried between its neighbours
        const pieces: KerbJoinSample[][] = [];
        let cur: KerbJoinSample[] = [];
        for (const s of samples) { if (s) cur.push(s); else { if (cur.length >= 2) pieces.push(cur); cur = []; } }
        if (cur.length >= 2) pieces.push(cur);
        const drawn = pieces.length > 0;
        const reason = drawn ? undefined : 'the scan shows no kerb across the gap';
        if (reason) why(reason);
        joins.push({ ...base, drawn, ...(reason ? { reason } : {}), ...(radius?.radiusM !== undefined ? { radiusM: radius.radiusM, rays: { hits: radius.hits, cast: P.cornerRays, spreadM: radius.spreadM } } : {}), pieces });
    }
    return joins;
}

function kerbStats(runs: KerbRun[], joins: KerbJoin[], measuredM: number, notDrawnM: number, reasons: Record<string, number>): KerbModelStats {
    const st = { fineM: 0, coarseM: 0, betweenM: 0, rampM: 0, softM: 0, cornerM: 0, straightJoinM: 0, gutterMeasuredM: 0, gutterGeneratedM: 0 };
    const faces: number[] = [];
    const add = (len: number, a: { source: KerbSource; ramp: boolean; gutter: { source: GutterSource }; faceM?: number; softRunM?: number }, b: typeof a) => {
        const half = len / 2;
        for (const s of [a, b]) {
            st[s.source === 'fine' ? 'fineM' : s.source === 'coarse' ? 'coarseM' : 'betweenM'] += half;
            if (s.ramp) st.rampM += half;
            if (s.softRunM !== undefined && !s.ramp) st.softM += half;
            st[s.gutter.source === 'measured' ? 'gutterMeasuredM' : 'gutterGeneratedM'] += half;
        }
    };
    for (const r of runs) for (let i = 0; i + 1 < r.samples.length; i++) {
        const p = r.samples[i], q = r.samples[i + 1], len = Math.hypot(q.x - p.x, q.z - p.z);
        for (const side of ['left', 'right'] as const) { const a = p[side], b = q[side]; if (a && b) { add(len, a, b); faces.push(a.faceM); } }
    }
    for (const j of joins) for (const piece of j.pieces) for (let i = 0; i + 1 < piece.length; i++) {
        const len = Math.hypot(piece[i + 1].x - piece[i].x, piece[i + 1].z - piece[i].z);
        add(len, piece[i], piece[i + 1]);
        faces.push(piece[i].topY - piece[i].footY);
        if (j.kind === 'corner') st.cornerM += len; else st.straightJoinM += len;
    }
    const corners = joins.filter(j => j.kind === 'corner'), straights = joins.filter(j => j.kind === 'straight');
    const radii = corners.filter(j => j.drawn && j.radiusM !== undefined).map(j => j.radiusM!);
    const q = (p: number) => (faces.length ? Math.round(quantile(faces, p) * 1000) / 1000 : null);
    const r1 = (v: number) => Math.round(v * 10) / 10;
    return {
        measuredM: r1(measuredM), drawnM: r1(st.fineM + st.coarseM + st.betweenM), fineM: r1(st.fineM), coarseM: r1(st.coarseM), betweenM: r1(st.betweenM), rampM: r1(st.rampM), softM: r1(st.softM),
        cornerM: r1(st.cornerM), straightJoinM: r1(st.straightJoinM), notDrawnM: r1(notDrawnM), gutterMeasuredM: r1(st.gutterMeasuredM), gutterGeneratedM: r1(st.gutterGeneratedM),
        corners: { drawn: corners.filter(j => j.drawn).length, notDrawn: corners.filter(j => !j.drawn).length, radiusP50M: radii.length ? Math.round(quantile(radii, 0.5) * 100) / 100 : null },
        straightJoins: { drawn: straights.filter(j => j.drawn).length, notDrawn: straights.filter(j => !j.drawn).length },
        faceP10M: q(0.1), faceP50M: q(0.5), faceP90M: q(0.9), reasons
    };
}

// ---------------------------------------------------------------------------------------------------------------------
// the sweep
// ---------------------------------------------------------------------------------------------------------------------

/** The parts the sweep draws, each its own node with its own label. */
export type KerbPart = 'carriageway' | 'gutter' | 'face' | 'nosing' | 'top' | 'sidewalk';
export type KerbLabel = 'measured' | 'generated';

/** A point of a cross-section: lateral position from the carrier (left negative), level, and a key that names it across samples. */
interface ProfilePt { d: number; y: number; key: string }
/** A cross-section: its points left to right, and each segment's part and label (segment k joins points k and k + 1). */
interface Profile { pts: ProfilePt[]; seg: Array<{ part: KerbPart; label: KerbLabel; gutter?: 'left' | 'right' }> }

/** A kerb's points from its raised side to the road side: back, arris top, arris on the face, foot, gutter edge (d along `toward`). */
function kerbPoints(faceD: number, toward: 1 | -1, k: { topY: number; footY: number; gutter: { widthM: number } }, edgeY: number, P: RoadKerbParams, prefix: string, back = true): ProfilePt[] {
    const face = k.topY - k.footY, nosing = Math.max(0, Math.min(frontBevelM(Math.min(face, P.kerbTopM)), face / 2));
    return [
        ...(back ? [{ d: faceD + toward * P.kerbTopM, y: k.topY, key: `${prefix}.back` }] : []),
        { d: faceD + toward * nosing, y: k.topY, key: `${prefix}.arrisTop` },
        { d: faceD, y: k.topY - nosing, key: `${prefix}.arrisFace` },
        { d: faceD, y: k.footY, key: `${prefix}.foot` },
        { d: faceD - toward * k.gutter.widthM, y: edgeY, key: `${prefix}.edge` }
    ];
}

/** The sample's cross-section: kerbs where measured (their gutters, faces, nosings and tops), the carriageway through the camber. */
function sampleProfile(s: KerbSample, P: RoadKerbParams, sidewalks: boolean): Profile {
    const pts: ProfilePt[] = [], seg: Profile['seg'] = [];
    const push = (p: ProfilePt, part?: KerbPart, label: KerbLabel = 'measured', gutter?: 'left' | 'right') => { if (pts.length && part) seg.push({ part, label, ...(gutter ? { gutter } : {}) }); pts.push(p); };
    const kerbSegs: Array<[KerbPart, KerbLabel]> = [['top', 'generated'], ['nosing', 'generated'], ['face', 'measured']];
    // the carriageway only between two measured kerbs: where one side shows none, its edge is unknown (SB-Roadie's step there
    // is as often the building line), so that side's scan is kept and only the measured kerb is drawn
    const both = !!s.left && !!s.right;
    if (!both) {
        if (s.left) {
            const k = s.left, kp = kerbPoints(-k.offsetM, -1, k, k.footY + k.gutter.depthM, P, 'kL');
            if (sidewalks && s.walkL && s.walkL.widthM > P.kerbTopM) push({ d: -k.offsetM - s.walkL.widthM, y: s.walkL.level, key: 'kL.walk' });
            kp.forEach((p, i) => push(p, i === 0 ? (pts.length ? 'sidewalk' : undefined) : i < 4 ? kerbSegs[i - 1][0] : 'gutter', i === 0 ? 'measured' : i < 4 ? kerbSegs[i - 1][1] : k.gutter.source, i === 4 ? 'left' : undefined));
        }
        if (s.right) {
            const k = s.right, kp = kerbPoints(k.offsetM, 1, k, k.footY + k.gutter.depthM, P, 'kR').reverse();
            kp.forEach((p, i) => push(p, i === 0 ? undefined : i === 1 ? 'gutter' : i < 5 ? kerbSegs[4 - i][0] : 'top', i === 1 ? k.gutter.source : i === 0 ? 'measured' : kerbSegs[4 - i][1], i === 1 ? 'right' : undefined));
            if (sidewalks && s.walkR && s.walkR.widthM > P.kerbTopM) push({ d: k.offsetM + s.walkR.widthM, y: s.walkR.level, key: 'kR.walk' }, 'sidewalk');
        }
        return { pts, seg };
    }
    // the left kerb (raised to the left)
    if (s.left) {
        const k = s.left, edgeY = k.footY + k.gutter.depthM;
        const kp = kerbPoints(-k.offsetM, -1, k, edgeY, P, 'kL');
        if (sidewalks && s.walkL && s.walkL.widthM > P.kerbTopM) push({ d: -k.offsetM - s.walkL.widthM, y: s.walkL.level, key: 'kL.walk' });
        kp.forEach((p, i) => push(p, i === 0 ? (pts.length ? 'sidewalk' : undefined) : i < 4 ? kerbSegs[i - 1][0] : 'gutter', i === 0 ? 'measured' : i < 4 ? kerbSegs[i - 1][1] : k.gutter.source, i === 4 ? 'left' : undefined));
    } else push({ d: -s.edgeL, y: camberAt(s.camber, -s.edgeL), key: 'cL' });
    const leftIn = pts[pts.length - 1].d;
    if (s.median) {
        // a median's edges are kerbs SB-Roadie measured (their faces up to its level); their gutters the plausible pan
        const m = s.median, kl = { topY: m.level, footY: camberAt(s.camber, -m.leftM - P.gutterWidthM) - P.gutterDepthM, gutter: { widthM: P.gutterWidthM } };
        const kr = { topY: m.level, footY: camberAt(s.camber, m.rightM + P.gutterWidthM) - P.gutterDepthM, gutter: { widthM: P.gutterWidthM } };
        const c1 = s.camber[1];
        if (c1[0] > leftIn + 0.05 && c1[0] < -m.leftM - P.gutterWidthM - 0.05) push({ d: c1[0], y: c1[1], key: 'c1' }, 'carriageway');
        const ml = kerbPoints(-m.leftM, 1, kl, camberAt(s.camber, -m.leftM - P.gutterWidthM), P, 'mL', false).reverse();
        ml.forEach((p, i) => push(p, i === 0 ? 'carriageway' : i === 1 ? 'gutter' : i === 2 ? 'face' : 'nosing', i === 1 ? 'generated' : i === 2 ? 'measured' : i === 0 ? 'measured' : 'generated', i === 1 ? 'right' : undefined));
        const mr = kerbPoints(m.rightM, -1, kr, camberAt(s.camber, m.rightM + P.gutterWidthM), P, 'mR', false);
        mr.forEach((p, i) => push(p, i === 0 ? 'top' : i === 1 ? 'nosing' : i === 2 ? 'face' : 'gutter', i === 0 ? 'measured' : i === 1 ? 'generated' : i === 2 ? 'measured' : 'generated', i === 3 ? 'left' : undefined));
        const c3 = s.camber[s.camber.length - 2];
        const rightIn = s.right ? s.right.offsetM - s.right.gutter.widthM : s.edgeR;
        if (c3[0] > m.rightM + P.gutterWidthM + 0.05 && c3[0] < rightIn - 0.05) push({ d: c3[0], y: c3[1], key: 'c3' }, 'carriageway');
    } else {
        const rightIn = s.right ? s.right.offsetM - s.right.gutter.widthM : s.edgeR;
        for (const [d, y] of s.camber.slice(1, -1)) if (d > leftIn + 0.05 && d < rightIn - 0.05) push({ d, y, key: `c${s.camber.findIndex(c => c[0] === d)}` }, 'carriageway');
    }
    if (s.right) {
        const k = s.right, edgeY = k.footY + k.gutter.depthM;
        const kp = kerbPoints(k.offsetM, 1, k, edgeY, P, 'kR').reverse();
        kp.forEach((p, i) => push(p, i === 0 ? 'carriageway' : i === 1 ? 'gutter' : i < 5 ? kerbSegs[4 - i][0] : 'top', i === 0 ? 'measured' : i === 1 ? k.gutter.source : kerbSegs[4 - i][1], i === 1 ? 'right' : undefined));
        if (sidewalks && s.walkR && s.walkR.widthM > P.kerbTopM) push({ d: k.offsetM + s.walkR.widthM, y: s.walkR.level, key: 'kR.walk' }, 'sidewalk');
    } else push({ d: s.edgeR, y: camberAt(s.camber, s.edgeR), key: 'cR' }, 'carriageway');
    return { pts, seg };
}

/** A join sample's cross-section: the kerb alone, back to gutter edge (d from the face toward the road, the sidewalk negative). */
function joinProfile(j: KerbJoinSample, P: RoadKerbParams): Profile {
    return { pts: kerbPoints(0, -1, j, j.edgeY, P, 'k'), seg: [{ part: 'top', label: 'generated' }, { part: 'nosing', label: 'generated' }, { part: 'face', label: 'measured' }, { part: 'gutter', label: j.gutter.source, gutter: 'left' }] };
}

class PartMesh {
    positions: number[] = []; indices: number[] = []; uv: number[] = [];
    vertex(x: number, y: number, z: number, u: number, v: number): number { this.positions.push(x, y, z); this.uv.push(u, v); return this.positions.length / 3 - 1; }
    /** Two triangles a b c, a c d (a degenerate one left out), each wound to face `want`. */
    quad(a: number, b: number, c: number, d: number, want: [number, number, number]): void {
        const tri = (i: number, j: number, k: number) => {
            const P = this.positions, ux = P[j * 3] - P[i * 3], uy = P[j * 3 + 1] - P[i * 3 + 1], uz = P[j * 3 + 2] - P[i * 3 + 2];
            const vx = P[k * 3] - P[i * 3], vy = P[k * 3 + 1] - P[i * 3 + 1], vz = P[k * 3 + 2] - P[i * 3 + 2];
            const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
            if (!(Math.hypot(n[0], n[1], n[2]) > 1e-8)) return;
            if (n[0] * want[0] + n[1] * want[1] + n[2] * want[2] >= 0) this.indices.push(i, j, k); else this.indices.push(i, k, j);
        };
        tri(a, b, c);
        tri(a, c, d);
    }
    part(): RoadMeshPart { return { positions: Float32Array.from(this.positions), indices: Uint32Array.from(this.indices), uv: Float32Array.from(this.uv) }; }
}

/** A footprint triangle: the plan of an up-facing surface the sweep drew, its corners with their levels (x, y, z). */
export type FootprintTri = [number, number, number, number, number, number, number, number, number];

export interface KerbedRoadMesh {
    /** Each part, by part and label ("gutter:generated"). */
    parts: Map<string, RoadMeshPart>;
    /** The plan triangles of every up-facing surface drawn (carriageway, gutters, nosings, kerb tops, sidewalks): what the carve cuts under. */
    footprint: FootprintTri[];
    uvFrame: { x0: number; z0: number; widthM: number; heightM: number };
    stats: { samples: number; triangles: number; footprintM2: number };
    minY: number; maxY: number;
}

/**
 * The sweep: per run, between consecutive samples, a quad for every segment both samples' cross-sections share (so a kerb
 * the next sample lacks ends there, and the carriageway runs on to the bare edge); then each join's kerb, its first and
 * last cross-sections the runs' own. Faces and nosings face the road, tops, gutters and the carriageway face up.
 */
export function buildKerbedRoadMesh(model: KerbModel, atlas?: RoadAtlasLayout | 'metres', P: RoadKerbParams = ROAD_KERB_PARAMS, opts: { sidewalks?: boolean } = {}): KerbedRoadMesh {
    const metres = atlas === 'metres', layout = atlas === 'metres' ? undefined : atlas;
    const parts = new Map<string, PartMesh>();
    const partOf = (part: KerbPart, label: KerbLabel) => { const k = `${part}:${label}`; let m = parts.get(k); if (!m) parts.set(k, m = new PartMesh()); return m; };
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const r of model.runs) for (const s of r.samples) { const reach = Math.max(s.edgeL, s.edgeR, s.left?.offsetM ?? 0, s.right?.offsetM ?? 0) + 6; x0 = Math.min(x0, s.x - reach); x1 = Math.max(x1, s.x + reach); z0 = Math.min(z0, s.z - reach); z1 = Math.max(z1, s.z + reach); }
    if (!(x1 > x0)) { x0 = z0 = 0; x1 = z1 = 1; }
    const uvFrame = { x0, z0, widthM: Math.max(1, x1 - x0), heightM: Math.max(1, z1 - z0) };
    const footprint: FootprintTri[] = [];
    let footprintM2 = 0, samples = 0;
    type Pt3 = { x: number; y: number; z: number; d: number };
    type Band = { row0: number; rows: number; cols: number; sideRow: number; kerbRow: number };
    type Section = { prof: Profile; pts: Pt3[]; along: number; band?: Band; width?: [number, number]; u: number };
    const sweep = (sections: Section[]) => {
        for (let i = 0; i + 1 < sections.length; i++) {
            const A = sections[i], B = sections[i + 1];
            const keysB = new Map(B.prof.pts.map((p, k) => [p.key, k]));
            for (let k = 0; k + 1 < A.prof.pts.length; k++) {
                // a segment both cross-sections have: its quad; one the next lacks ends here
                const kb0 = keysB.get(A.prof.pts[k].key), kb1 = keysB.get(A.prof.pts[k + 1].key);
                if (kb0 === undefined || kb1 !== kb0 + 1) continue;
                const seg = A.prof.seg[k], m = partOf(seg.part, seg.label);
                const a0 = A.pts[k], a1 = A.pts[k + 1], b0 = B.pts[kb0], b1 = B.pts[kb1];
                const uv = (S: Section, p: Pt3, top: boolean): [number, number] => {
                    if (metres) return [S.along, seg.part === 'face' ? (top ? 0 : Math.abs(a0.y - a1.y)) : p.d];
                    if (!S.band || !layout) return [(p.x - uvFrame.x0) / uvFrame.widthM, (p.z - uvFrame.z0) / uvFrame.heightM];
                    if (seg.part === 'carriageway' || seg.part === 'gutter') {
                        const [l, r] = S.width ?? [1, 1];
                        const t = seg.part === 'gutter' ? (seg.gutter === 'left' ? 0 : 1) : (p.d + l) / Math.max(1e-6, l + r);
                        return [S.u, (S.band.row0 + Math.max(0, Math.min(1, t)) * S.band.rows) / layout.height];
                    }
                    return [S.u, ((seg.part === 'top' || seg.part === 'sidewalk' ? S.band.sideRow : S.band.kerbRow) + 0.5) / layout.height];
                };
                const hiA = a0.y >= a1.y;
                const ia0 = m.vertex(a0.x, a0.y, a0.z, ...uv(A, a0, hiA)), ia1 = m.vertex(a1.x, a1.y, a1.z, ...uv(A, a1, !hiA));
                const ib0 = m.vertex(b0.x, b0.y, b0.z, ...uv(B, b0, hiA)), ib1 = m.vertex(b1.x, b1.y, b1.z, ...uv(B, b1, !hiA));
                // up, or a face toward the road (toward its gutter's edge, the cross-section's next point that way)
                let want: [number, number, number] = [0, 1, 0];
                if (seg.part === 'face') {
                    const edge = A.prof.pts[k + 2]?.key.endsWith('.edge') ? A.pts[k + 2] : A.prof.pts[k - 1]?.key.endsWith('.edge') ? A.pts[k - 1] : undefined;
                    if (edge) want = [edge.x - a0.x, 0, edge.z - a0.z];
                }
                m.quad(ia0, ia1, ib1, ib0, want);
                if (seg.part === 'face') continue;
                // the plan of every up-facing surface, for the carve
                for (const [p, q, r] of [[a0, a1, b1], [a0, b1, b0]] as const) {
                    const area = Math.abs((q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x)) / 2;
                    if (area < 1e-6) continue;
                    footprint.push([p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z]);
                    footprintM2 += area;
                }
            }
        }
    };
    const at = (s: { x: number; z: number; nx: number; nz: number }, p: ProfilePt): Pt3 => ({ x: s.x + s.nx * p.d, y: p.y, z: s.z + s.nz * p.d, d: p.d });
    // each run's kerb ends, their exact points by key suffix, so a join starts and ends on the run's own cross-section
    const anchors = new Map<string, Map<string, Pt3>>();
    const runBand = new Map<string, { band?: Band; uEnd: number }>();
    for (const r of model.runs) {
        const band = layout?.bands.get(r.id);
        let along = 0, total = 0;
        for (let i = 1; i < r.samples.length; i++) total += Math.hypot(r.samples[i].x - r.samples[i - 1].x, r.samples[i].z - r.samples[i - 1].z);
        const uEnd = band && layout ? band.cols / layout.width : 0;
        const sections: Section[] = r.samples.map((s, i) => {
            if (i > 0) along += Math.hypot(s.x - r.samples[i - 1].x, s.z - r.samples[i - 1].z);
            const prof = sampleProfile(s, P, opts.sidewalks ?? false);
            samples++;
            return { prof, pts: prof.pts.map(p => at(s, p)), along, ...(band ? { band } : {}), width: [s.edgeL, s.edgeR], u: total > 0 ? (Math.min(along, total) / total) * uEnd : 0 };
        });
        runBand.set(r.id, { ...(band ? { band } : {}), uEnd });
        sections.forEach((sec, i) => {
            for (const side of ['left', 'right'] as const) {
                const s = r.samples[i];
                if (!s[side]) continue;
                const prefix = side === 'left' ? 'kL.' : 'kR.';
                const pts = new Map(sec.prof.pts.map((p, k) => [p.key, sec.pts[k]] as const).filter(([k]) => k.startsWith(prefix)).map(([k, p]) => [k.slice(prefix.length), p]));
                if (i === 0 || !r.samples[i - 1][side] || i === r.samples.length - 1 || !r.samples[i + 1][side]) anchors.set(`${r.id}|${i}|${side}`, pts);
            }
        });
        sweep(sections);
    }
    for (const j of model.joins) {
        const rb = runBand.get(j.from.run);
        for (const piece of j.pieces) {
            let along = 0;
            sweep(piece.map((s, i): Section => {
                if (i > 0) along += Math.hypot(s.x - piece[i - 1].x, s.z - piece[i - 1].z);
                const prof = joinProfile(s, P);
                // d from the face toward the road
                const frame = { x: s.x, z: s.z, nx: -s.ox, nz: -s.oz };
                const own = s.anchor ? anchors.get(s.anchor) : undefined;
                const pts = prof.pts.map(p => own?.get(p.key.slice(2)) ?? at(frame, p));
                return { prof, pts, along, ...(rb?.band ? { band: rb.band } : {}), u: j.from.end === 'start' ? 0 : rb?.uEnd ?? 0 };
            }));
        }
    }
    const out = new Map<string, RoadMeshPart>();
    let minY = Infinity, maxY = -Infinity, triangles = 0;
    for (const [k, m] of parts) {
        const p = m.part();
        if (!p.indices.length) continue;
        out.set(k, p);
        triangles += p.indices.length / 3;
        for (let i = 1; i < p.positions.length; i += 3) { minY = Math.min(minY, p.positions[i]); maxY = Math.max(maxY, p.positions[i]); }
    }
    return { parts: out, footprint, uvFrame, stats: { samples, triangles, footprintM2: Math.round(footprintM2 * 10) / 10 }, minY: minY === Infinity ? 0 : minY, maxY: maxY === -Infinity ? 0 : maxY };
}

/** Why each part carries its label (GLB extras and the layer's note). */
export const KERB_PART_METHOD: Record<string, string> = {
    'carriageway:measured': 'the carriageway through the camber SB-Roadie measured kerb to kerb, from gutter edge to gutter edge',
    'gutter:measured': "a gutter whose width and depth are the dip the scan shows at the kerb's foot",
    'gutter:generated': "a plausible gutter (0.3 m wide, 2.5 cm deep) where the scan resolves no dip at the kerb's foot",
    'face:measured': "the kerb face where the scan steps up, its height the measured rise (plus the gutter's depth); a ramp's where the face drops to the road",
    'nosing:generated': "a 45-degree chamfer on the kerb's arris, 1.5 % of the kerb's smallest dimension clamped to 1-5 cm (1 cm): the scan does not resolve it",
    'top:generated': "the kerb's top, 0.15 m wide behind the face at the sidewalk level the scan shows (its width not resolved by the scan)",
    'top:measured': "a median's top at the level the scan shows",
    'sidewalk:measured': 'the sidewalk SB-Roadie measured beyond the kerb, at its level'
};

/** Writes the kerbed streets as a staged GLB: one node per part and label, road-aligned UVs into `texture` when given. */
export function writeKerbedRoadsGlb(file: string, mesh: KerbedRoadMesh, extras: Record<string, unknown>, texture?: { jpeg: Buffer; width: number; height: number }): { path: string; bytes: number } {
    const nodes = [...mesh.parts].map(([key, p]) => {
        const [part, label] = key.split(':');
        // UVs only with the texture they index
        return { name: key.replace(':', '_'), positions: p.positions, indices: p.indices, ...(texture ? { uv: p.uv } : {}), extras: { ...extras, part, provenance: label, method: KERB_PART_METHOD[key] ?? '' } };
    });
    return writeStagedGlbFile(file, nodes, {
        rootExtras: { sbRoads: { ...extras, uvFrame: mesh.uvFrame, kerbs: ROAD_KERBS_VERSION, ...(texture ? { texture: { source: 'road surfaces read along each street from the top-down tile photo and redrawn', width: texture.width, height: texture.height } } : {}) } },
        generator: 'scratchbox staged-location road-kerbs',
        ...(texture ? { texture: { bytes: texture.jpeg, mimeType: 'image/jpeg' } } : {})
    });
}

/** The streets' corridors' plan test, for the scan index: within `reachM` of a centreline. */
export function nearStreets(roads: RoadSurface[], reachM: number): (x: number, z: number) => boolean {
    const cell = 2, cells = new Set<string>(), r = Math.ceil(reachM / cell);
    for (const road of roads) for (const s of stationsAlong(road.stations.map(t => [t.x, t.z]), 1)) {
        const i = Math.floor(s.x / cell), k = Math.floor(s.z / cell);
        for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) cells.add(`${i + di},${k + dk}`);
    }
    return (x, z) => cells.has(`${Math.floor(x / cell)},${Math.floor(z / cell)}`);
}

/**
 * The planar frame a self-textured surface's texture coordinates read the photo seen from above in (u = (x - x0) / width,
 * v = (z - z0) / height), fitted on the GLB's own vertices: so a layer can be coloured again from another photo of the same
 * ground without its frame being stored (and its mean height, the level that photo's scale should be exact at). Undefined
 * when the GLB has no texture coordinates or they are not planar.
 */
export function planarFrameOf(bytes: Uint8Array): { x0: number; z0: number; widthM: number; heightM: number; meanY: number } | undefined {
    const glb = parseGlbBytes(bytes);
    // least squares u = a + b x, v = c + d z over every textured vertex
    let n = 0, sx = 0, sxx = 0, su = 0, sxu = 0, sz = 0, szz = 0, sv = 0, szv = 0, sy = 0;
    for (const mesh of glb.json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        const pa = prim.attributes?.POSITION, ta = prim.attributes?.TEXCOORD_0;
        if (pa === undefined || ta === undefined) continue;
        const P = readAccessor(glb, pa).data, T = readAccessor(glb, ta).data;
        for (let i = 0; i * 3 < P.length && i * 2 < T.length; i++) {
            const x = P[i * 3], z = P[i * 3 + 2], u = T[i * 2], v = T[i * 2 + 1];
            n++; sx += x; sxx += x * x; su += u; sxu += x * u; sz += z; szz += z * z; sv += v; szv += z * v; sy += P[i * 3 + 1];
        }
    }
    const dx = n * sxx - sx * sx, dz = n * szz - sz * sz;
    if (n < 3 || !(dx > 0) || !(dz > 0)) return undefined;
    const b = (n * sxu - sx * su) / dx, a = (su - b * sx) / n, d = (n * szv - sz * sv) / dz, c = (sv - d * sz) / n;
    if (!(b > 0) || !(d > 0)) return undefined;
    return { x0: -a / b, z0: -c / d, widthM: 1 / b, heightM: 1 / d, meanY: sy / n };
}

/** The GLB with its one embedded image replaced by `jpeg`: every buffer view laid out again in order, the image's swapped. */
export function withGlbImage(bytes: Uint8Array, jpeg: Uint8Array): Buffer {
    const { json, bin } = parseGlbBytes(bytes);
    const image = json.images?.[0];
    if (!image || image.bufferView === undefined || (json.images?.length ?? 0) !== 1) throw new Error('the GLB has not exactly one embedded image to replace');
    const parts: Uint8Array[] = [];
    let offset = 0;
    json.bufferViews = (json.bufferViews as any[]).map((v, i) => {
        const data = i === image.bufferView ? jpeg : bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
        const pad = (4 - (offset % 4)) % 4;
        if (pad) { parts.push(new Uint8Array(pad)); offset += pad; }
        parts.push(data);
        const placed = { ...v, byteOffset: offset, byteLength: data.byteLength };
        offset += data.byteLength;
        return placed;
    });
    image.mimeType = 'image/jpeg';
    const out = Buffer.concat(parts);
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: out.byteLength }];
    return assembleGlb(json, out);
}
