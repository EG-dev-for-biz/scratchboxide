/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The residual audit (residual-audit.ts) on a district: what stands in the streets between the buildings. The solid is the
 * measured ground (the walkable street surface, GroundModel) and the scan at the vector buildings; the candidates are the
 * tree-stripped scan's triangles standing proud of the ground away from any building: street furniture, poles, gantries,
 * shelters, vehicles, and whatever the scan made of them. Each cluster is also placed against Google's rail centrelines:
 * how far it is from the nearest track, how much of that track runs along a street (measured: its share within a few metres
 * of a road centreline), where along the track it stands, and whether its neighbours along the same track repeat at a
 * steady pitch. Labels only; nothing here changes the build.
 */

import type { GroundModel, ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { SB_FEATURE_PREFIX, typesFromLabels, type SbFeatureTypeLabel } from '../../../common/spatial/sb-feature-types';
import { auditResidual, BUILDING_PART_MIN, type AuditedCluster, type AuditSource, type ResidualAuditResult, type ResidualVerdict } from './residual-audit';
import { APRON_HEIGHT_M } from './pipeline-e/residual-audit-e';

export const DISTRICT_AUDIT_VERSION = 'district-residual-audit/1';

export const DISTRICT_AUDIT_PARAMS = {
    /** Scan within this of a vector building footprint belongs to the building (the solid): footprints are good to a metre or two. */
    buildingClearM: 2,
    /** Triangles wholly this close above the measured ground are the ground itself (kerbs, kerb-side noise), not audited. */
    apronM: APRON_HEIGHT_M,
    /**
     * A rail stretch within this of a road centreline runs along the street. Measured around Federation Square: track in the
     * streets lies 2-12 m from the nearest centreline (a wide street's carriageways are separate lines), track on its own
     * way 18 m and more.
     */
    streetRunM: 12,
    /** A cluster this close (plan, its nearest bbox point) to a rail centreline stands by the track. */
    railNearM: 6,
    /** Spacing of the rail length samples. */
    railSampleM: 2
};

/** A triangle soup's triangle `t` (9 floats). */
function triOf(V: ArrayLike<number>, I: ArrayLike<number>, t: number, out: Float32Array, o: number): void {
    for (let j = 0; j < 3; j++) { const v = I[t * 3 + j] * 3; out[o + j * 3] = V[v]; out[o + j * 3 + 1] = V[v + 1]; out[o + j * 3 + 2] = V[v + 2]; }
}

export interface DistrictAuditSplit {
    solid: Float32Array;
    sources: AuditSource[];
    stats: { scanTriangles: number; buildingTriangles: number; groundTriangles: number; apronTriangles: number; outsideTriangles: number; candidateTriangles: number };
}

/**
 * Splits the tree-stripped scan into the audit's solid (the ground heightfield and the scan at the buildings) and its
 * candidates (the scan standing proud of the ground away from the buildings), within `within`.
 */
export function districtAuditSplit(scan: ScanMesh, ground: GroundModel, opts: { buildingAt: (x: number, z: number) => number; within: (x: number, z: number) => boolean; waterAt?: (x: number, z: number) => boolean }, P = DISTRICT_AUDIT_PARAMS): DistrictAuditSplit {
    const V = scan.mesh.vertices as ArrayLike<number>, I = scan.mesh.indices as ArrayLike<number>;
    const r = Math.ceil(P.buildingClearM);
    const nearBuilding = (x: number, z: number) => {
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= P.buildingClearM * P.buildingClearM + 0.5 && opts.buildingAt(x + dx, z + dz) > 0) return true;
        return false;
    };
    const building: number[] = [], cand: number[] = [];
    let apron = 0, outside = 0;
    for (let t = 0; t < scan.triCount; t++) {
        const cx = scan.triCentroid[t * 3], cz = scan.triCentroid[t * 3 + 2];
        if (!opts.within(cx, cz)) { outside++; continue; }
        if (nearBuilding(cx, cz)) { building.push(t); continue; }
        if (opts.waterAt?.(cx, cz)) { apron++; continue; }
        const g = ground.groundAt(cx, cz);
        if (!Number.isFinite(g)) { apron++; continue; }
        const top = Math.max(V[I[t * 3] * 3 + 1], V[I[t * 3 + 1] * 3 + 1], V[I[t * 3 + 2] * 3 + 1]);
        if (top <= g + P.apronM) { apron++; continue; }
        cand.push(t);
    }
    // the ground: a heightfield through the cell centres the terrain was measured at, within the extraction
    const g = ground, cell = g.cellMeters;
    const at = (i: number, k: number) => g.ground[k * g.nx + i];
    const quads: number[] = [];
    for (let k = 0; k + 1 < g.nz; k++) for (let i = 0; i + 1 < g.nx; i++) {
        const x = g.x0 + (i + 1) * cell, z = g.z0 + (k + 1) * cell;
        if (!opts.within(x, z)) continue;
        const a = at(i, k), b = at(i + 1, k), c = at(i, k + 1), d = at(i + 1, k + 1);
        if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && Number.isFinite(d)) quads.push(i, k);
    }
    const nGround = (quads.length / 2) * 2;
    const solid = new Float32Array((building.length + nGround) * 9);
    building.forEach((t, k) => triOf(V, I, t, solid, k * 9));
    let o = building.length * 9;
    const put = (i: number, k: number) => { solid[o++] = g.x0 + (i + 0.5) * cell; solid[o++] = at(i, k); solid[o++] = g.z0 + (k + 0.5) * cell; };
    for (let q = 0; q < quads.length; q += 2) {
        const i = quads[q], k = quads[q + 1];
        put(i, k); put(i + 1, k); put(i, k + 1);
        put(i + 1, k); put(i + 1, k + 1); put(i, k + 1);
    }
    const tris = new Float32Array(cand.length * 9);
    cand.forEach((t, k) => triOf(V, I, t, tris, k * 9));
    return {
        solid, sources: [{ node: 'scan', triangles: tris, localTriangles: cand }],
        stats: { scanTriangles: scan.triCount, buildingTriangles: building.length, groundTriangles: nGround, apronTriangles: apron, outsideTriangles: outside, candidateTriangles: cand.length }
    };
}

// ------------------------------------------------------------------------------------------------ rail context

const segDist = (p: Vec2, a: Vec2, b: Vec2): { d: number; u: number } => {
    const dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
    const u = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L)) : 0;
    return { d: Math.hypot(p[0] - a[0] - u * dx, p[1] - a[1] - u * dz), u };
};

export interface RailLine {
    index: number;
    points: Vec2[];
    lengthM: number;
    /** Share of the line's length within `streetRunM` of a road centreline (1: it runs along a street, 0: on its own way). */
    streetRunningShare: number;
}

/** Each rail centreline with its length and how much of it runs along a road (measured on samples `railSampleM` apart). */
export function measureRailLines(rails: Vec2[][], roads: Vec2[][], P = DISTRICT_AUDIT_PARAMS): RailLine[] {
    const nearRoad = (p: Vec2) => {
        for (const r of roads) for (let i = 1; i < r.length; i++) if (segDist(p, r[i - 1], r[i]).d <= P.streetRunM) return true;
        return false;
    };
    return rails.filter(l => l.length >= 2).map((pts, index) => {
        let on = 0, total = 0;
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const n = Math.max(1, Math.ceil(L / P.railSampleM));
            for (let k = 0; k < n; k++) { const u = (k + 0.5) / n; if (nearRoad([a[0] + u * (b[0] - a[0]), a[1] + u * (b[1] - a[1])])) on += L / n; }
            total += L;
        }
        return { index, points: pts, lengthM: total, streetRunningShare: total > 0 ? on / total : 0 };
    });
}

export interface RailContext {
    /** The rail line (index into the measured lines) the cluster stands nearest. */
    line: number;
    /** Plan distance from the cluster's footprint (its bbox) to the centreline. */
    distanceM: number;
    /** Where along that line (metres from its first point) the cluster's centre projects. */
    alongM: number;
    streetRunningShare: number;
    /** Its neighbours by the same line: how many, their median spacing, and how steady it is (1 - MAD / median; 0 for fewer than 3). */
    row?: { members: number; pitchM: number; pitchRegularity: number };
}

/** The nearest rail line to a plan box, with the distance to its nearest point and the arc length at the box centre's foot. */
function nearestRail(lines: RailLine[], lo: Vec2, hi: Vec2): { line: RailLine; distanceM: number; alongM: number } | undefined {
    const c: Vec2 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2];
    const halfDiag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) / 2;
    let best: { line: RailLine; distanceM: number; alongM: number } | undefined;
    for (const l of lines) {
        let s = 0;
        for (let i = 1; i < l.points.length; i++) {
            const a = l.points[i - 1], b = l.points[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
            const q = segDist(c, a, b);
            const d = Math.max(0, q.d - halfDiag);
            if (!best || d < best.distanceM) best = { line: l, distanceM: d, alongM: s + q.u * L };
            s += L;
        }
    }
    return best;
}

/** Each cluster near a rail line, with the line's measures and its row (clusters by the same line, by position along it). */
export function railContexts(clusters: Pick<AuditedCluster, 'id' | 'lo' | 'hi'>[], lines: RailLine[], P = DISTRICT_AUDIT_PARAMS): Map<number, RailContext> {
    const out = new Map<number, RailContext>();
    if (!lines.length) return out;
    for (const c of clusters) {
        const n = nearestRail(lines, [c.lo[0], c.lo[2]], [c.hi[0], c.hi[2]]);
        if (n && n.distanceM <= P.railNearM) out.set(c.id, { line: n.line.index, distanceM: n.distanceM, alongM: n.alongM, streetRunningShare: n.line.streetRunningShare });
    }
    const byLine = new Map<number, number[]>();
    for (const [id, r] of out) byLine.set(r.line, [...(byLine.get(r.line) ?? []), id]);
    for (const ids of byLine.values()) {
        const sorted = ids.map(id => out.get(id)!).sort((a, b) => a.alongM - b.alongM);
        const gaps = sorted.slice(1).map((r, i) => r.alongM - sorted[i].alongM).filter(g => g > 0.5);
        const med = (a: number[]) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
        const pitch = med(gaps);
        const mad = med(gaps.map(g => Math.abs(g - pitch)));
        const regularity = gaps.length >= 2 && pitch > 0 ? Math.max(0, 1 - mad / pitch) : 0;
        for (const id of ids) out.get(id)!.row = { members: ids.length, pitchM: Number.isFinite(pitch) ? Math.round(pitch * 100) / 100 : 0, pitchRegularity: Math.round(regularity * 1000) / 1000 };
    }
    return out;
}

// ------------------------------------------------------------------------------------------------ uprights

const r2 = (v: number) => Math.round(v * 100) / 100;
const ramp = (x: number, a: number, b: number) => (!Number.isFinite(x) ? 0 : a === b ? (x >= a ? 1 : 0) : Math.max(0, Math.min(1, (x - a) / (b - a))));

/**
 * An upright standing on the street: vertical, a few metres tall, slender, its foot at the street. The leaf scan collapses a
 * pole or mast to a sheet of a few needle triangles, which the residual audit's surface measures read as a sliver, a hanging
 * curtain or a copy of a surface: right for a drape off a facade, wrong for a thing rising from the street clear of every
 * building (the district split keeps the buildings out of the candidates). Each ramp rises from 0 to 1.
 */
export const UPRIGHT = {
    verticality: [0.85, 0.95] as [number, number],
    heightM: [2.5, 4] as [number, number],
    /** Height over the larger plan extent. */
    slenderness: [2, 4] as [number, number],
    /** Its lowest point above the measured street (falls from 1 at the first value to 0 at the second). */
    footAboveStreetM: [1, 2] as [number, number],
    /**
     * Plan clearance from the nearest vector building: a sheet within a couple of metres of a footprint is the facade the
     * footprint misses, a pole stands at the kerb (around Federation Square half the measured uprights sat 1-3 m off a
     * footprint, on its corners and along its walls).
     */
    buildingClearanceM: [2.5, 3.5] as [number, number],
    /** At or above this it is called an upright. */
    min: 0.5
};

export interface UprightMeasure { score: number; heightM: number; planM: number; footAboveStreetM: number; buildingClearanceM: number }

/** Plan distance from (x, z) to the nearest vector building cell, searched out to `maxM` (maxM when none is nearer). */
export function buildingClearance(buildingAt: (x: number, z: number) => number, x: number, z: number, maxM = 12): number {
    let best = maxM;
    const r = Math.ceil(maxM);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const d = Math.hypot(dx, dz);
        if (d < best && buildingAt(x + dx, z + dz) > 0) best = d;
    }
    return best;
}

export function uprightMeasure(c: Pick<AuditedCluster, 'lo' | 'hi' | 'frame' | 'shape'>, groundAt: (x: number, z: number) => number, buildingAt: (x: number, z: number) => number): UprightMeasure {
    const [L, H, W] = c.frame.extentsM;
    const planM = Math.max(L, W, 0.05);
    const cx = (c.lo[0] + c.hi[0]) / 2, cz = (c.lo[2] + c.hi[2]) / 2;
    const g = groundAt(cx, cz);
    const foot = Number.isFinite(g) ? c.lo[1] - g : NaN;
    const clearance = buildingClearance(buildingAt, cx, cz);
    const score = ramp(c.shape.mainAxisVerticality, ...UPRIGHT.verticality) * ramp(H, ...UPRIGHT.heightM) * ramp(H / planM, ...UPRIGHT.slenderness)
        * (Number.isFinite(foot) ? 1 - ramp(foot, ...UPRIGHT.footAboveStreetM) : 0) * ramp(clearance, ...UPRIGHT.buildingClearanceM);
    return { score: r2(score), heightM: r2(H), planM: r2(planM), footAboveStreetM: r2(foot), buildingClearanceM: r2(clearance) };
}

// ------------------------------------------------------------------------------------------------ labels

/** Labels only: a cluster at least this tall over at least this plan is a part of a building, not furniture (residual-audit.ts). */
const BUILDING_SIZED = (c: Pick<AuditedCluster, 'frame'>) => c.frame.extentsM[1] >= BUILDING_PART_MIN.heightM && c.frame.extentsM[0] * c.frame.extentsM[2] >= BUILDING_PART_MIN.planM2;

/**
 * Street labels from the measures (labels only, the verdict and geometry never read them): a real or unsure cluster standing
 * on the street and smaller than a building part is street furniture; an upright is a pole.
 */
export function streetLabels(c: AuditedCluster, upright: UprightMeasure): SbFeatureTypeLabel[] {
    if (c.verdict === 'scan-artefact' || BUILDING_SIZED(c)) return [];
    const by = `${DISTRICT_AUDIT_VERSION} measures`;
    const standing = ramp(c.attachment.groundedShare, 0, 0.1);
    const furniture = r2(Math.max(upright.score, standing * (c.verdict === 'real-object' ? c.confidence : 0.5)));
    const labels: SbFeatureTypeLabel[] = [];
    if (furniture > 0) labels.push({ code: SB_FEATURE_PREFIX + 'STREET_FURNITURE', confidence: furniture, by });
    if (upright.score >= UPRIGHT.min) labels.push({ code: SB_FEATURE_PREFIX + 'POLE', confidence: upright.score, by });
    return labels;
}

export interface DistrictAuditResult {
    schema: 'scratchbox.district-residual-audit/1';
    version: string;
    audit: ResidualAuditResult;
    split: DistrictAuditSplit['stats'];
    rails: Array<Omit<RailLine, 'points'>>;
    railContexts: Record<number, RailContext>;
    /** Clusters the street context re-judged: the audit's own verdict and reason, kept. */
    reassessed: Array<{ id: number; from: ResidualVerdict; to: ResidualVerdict; auditReason: string; upright: UprightMeasure }>;
}

/**
 * Runs the audit on a district: the clusters measured and judged, uprights the surface measures misread re-judged, the street
 * labels and rail context added to each cluster's feature, and the counts recomputed.
 */
export async function auditDistrict(input: {
    scan: ScanMesh; ground: GroundModel; buildingAt: (x: number, z: number) => number; within: (x: number, z: number) => boolean; waterAt?: (x: number, z: number) => boolean;
    rails?: Vec2[][]; roads?: Vec2[][]; dir: string; signal?: AbortSignal; idPrefix?: string;
}): Promise<DistrictAuditResult> {
    const split = districtAuditSplit(input.scan, input.ground, input);
    const audit = await auditResidual({ solid: split.solid, sources: split.sources, dir: input.dir, ...(input.signal ? { signal: input.signal } : {}), idPrefix: input.idPrefix ?? 'district/residual' });
    const lines = measureRailLines(input.rails ?? [], input.roads ?? []);
    const ctx = railContexts(audit.clusters, lines);
    const reassessed: DistrictAuditResult['reassessed'] = [];
    for (const c of audit.clusters) {
        const up = uprightMeasure(c, input.ground.groundAt, input.buildingAt);
        if (up.score >= UPRIGHT.min && c.verdict !== 'real-object') {
            reassessed.push({ id: c.id, from: c.verdict, to: 'real-object', auditReason: c.reason, upright: up });
            c.verdict = 'real-object';
            c.confidence = up.score;
            c.reason = `real object: an upright standing on the street clear of the buildings, ${up.heightM} m tall over ${up.planM} m in plan, its foot ${up.footAboveStreetM} m above the street (upright ${up.score}); the leaf scan draws a pole as a sheet of a few needle triangles, which the surface measures alone read as: ${c.reason}`;
            c.typeLabels = [];
            c.feature.description = c.reason;
            c.feature.provenance = { ...c.feature.provenance, confidence: up.score, method: `${c.feature.provenance.method}; re-judged by ${DISTRICT_AUDIT_VERSION}: an upright standing on the street` };
        }
        const labels = streetLabels(c, up);
        if (labels.length || !c.typeLabels.length) {
            c.typeLabels = [...c.typeLabels, ...labels];
            if (!c.typeLabels.length) c.typeLabels = [{ code: SB_FEATURE_PREFIX + 'OBJECT', confidence: c.confidence, by: `${DISTRICT_AUDIT_VERSION} measures` }];
            c.feature.typeLabels = c.typeLabels;
            c.feature.types = typesFromLabels(c.typeLabels);
        }
        const rail = ctx.get(c.id);
        c.feature.measurements = {
            ...c.feature.measurements, uprightScore: up.score, footAboveStreetM: up.footAboveStreetM, buildingClearanceM: up.buildingClearanceM,
            ...(rail ? { railDistanceM: r2(rail.distanceM), railAlongM: r2(rail.alongM), railStreetRunningShare: r2(rail.streetRunningShare), ...(rail.row ? { railRowMembers: rail.row.members, railRowPitchM: rail.row.pitchM, railRowPitchRegularity: rail.row.pitchRegularity } : {}) } : {})
        };
    }
    const art = audit.clusters.filter(c => c.verdict === 'scan-artefact'), real = audit.clusters.filter(c => c.verdict === 'real-object'), uns = audit.clusters.filter(c => c.verdict === 'unsure');
    const removedTriangles = art.reduce((s, c) => s + c.triangles, 0);
    audit.counts = { clusters: audit.clusters.length, realObjects: real.length, artefacts: art.length, unsure: uns.length, removedTriangles, keptTriangles: audit.candidateTriangles - removedTriangles, removedAreaM2: r2(art.reduce((s, c) => s + c.areaM2, 0)) };
    audit.candidates = real.map(c => c.id);
    const poles = audit.clusters.filter(c => c.feature.types.includes(SB_FEATURE_PREFIX + 'POLE'));
    audit.notes[0] = `residual audit (district): ${audit.clusters.length} clusters of ${audit.candidateTriangles} scan triangles standing proud of the street away from the buildings; ${art.length} scan artefacts, ${real.length} real objects (${poles.length} uprights, ${reassessed.length} of them re-judged from the surface measures' verdict), ${uns.length} unsure`;
    audit.notes.push(`district: ${split.stats.buildingTriangles} scan triangles at the buildings and ${split.stats.apronTriangles} on the ground are not audited; ${lines.length} rail line${lines.length === 1 ? '' : 's'} (${lines.filter(l => l.streetRunningShare >= 0.5).length} running along streets), ${ctx.size} cluster${ctx.size === 1 ? '' : 's'} within ${DISTRICT_AUDIT_PARAMS.railNearM} m of one`);
    return {
        schema: 'scratchbox.district-residual-audit/1', version: DISTRICT_AUDIT_VERSION, audit, split: split.stats,
        rails: lines.map(({ points: _p, ...l }) => ({ ...l, lengthM: r2(l.lengthM), streetRunningShare: r2(l.streetRunningShare) })), railContexts: Object.fromEntries(ctx), reassessed
    };
}

/** Unsure clusters smaller than this are not catalogued: fragments of scan noise, not objects (they stay in the audit's own file). */
export const CATALOG_UNSURE_MIN_AREA_M2 = 1;

export interface DistrictStreetAuditSummary {
    counts: ResidualAuditResult['counts'];
    notes: string[];
    split: DistrictAuditSplit['stats'];
    rails: { lines: number; streetRunning: number; clustersNear: number };
    uprights: number;
    reassessed: number;
    /** What goes into the object catalog: real objects, and unsure clusters of at least CATALOG_UNSURE_MIN_AREA_M2. */
    catalog: Array<{ id: number; type: string; reason: string; confidence: number; lo: [number, number, number]; hi: [number, number, number] }>;
    ms: number;
}

export function districtStreetAuditSummary(r: DistrictAuditResult): DistrictStreetAuditSummary {
    const keep = r.audit.clusters.filter(c => c.verdict === 'real-object' || (c.verdict === 'unsure' && c.areaM2 >= CATALOG_UNSURE_MIN_AREA_M2));
    return {
        counts: r.audit.counts, notes: r.audit.notes.slice(0, 1).concat(r.audit.notes.slice(-1)), split: r.split,
        rails: { lines: r.rails.length, streetRunning: r.rails.filter(l => l.streetRunningShare >= 0.5).length, clustersNear: Object.keys(r.railContexts).length },
        uprights: r.audit.clusters.filter(c => c.feature.types.includes(SB_FEATURE_PREFIX + 'POLE')).length, reassessed: r.reassessed.length,
        catalog: keep.map(c => ({ id: c.id, type: c.feature.types[c.feature.types.length - 1] ?? SB_FEATURE_PREFIX + 'OBJECT', reason: c.reason, confidence: c.confidence, lo: c.lo, hi: c.hi })),
        ms: r.audit.ms
    };
}
