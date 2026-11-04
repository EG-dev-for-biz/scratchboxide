/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street residue out of the tree-stripped scan (user report, 2026-11-03, 8th Ave at the Farley Building: "a big lumpy brown
 * pile sits in the roadway (a car remnant). Beside it is a tall black spike"): what the district residual audit
 * (district-residual-audit.ts) finds standing in the streets that nothing explains is taken out before anything builds on
 * the scan, and the street under it is rebuilt and painted by the surface infill (surface-infill.ts), as the vehicle step
 * does under a vehicle. Only the audit's measures decide, never what a cluster is called:
 *
 * - Floating: a cluster the audit calls a scan artefact because it touches nothing (its floating score, its gap to the
 *   ground and the buildings) and that no cluster left standing comes near: its triangles are deleted. Nothing rests on
 *   it, so no surface opens.
 * - A lump: a cluster on the measured carriageway (a road's kerb-to-kerb band, at its level: never a roof, a deck or a
 *   plaza, where the low structures the vector footprints miss stand), wider than it is tall, at most a vehicle's height
 *   above what supports it, joined with the neighbouring clusters the audit split the same melted pile into, whose
 *   area-weighted real-object score stays under the audit's own bar and that overlaps no fixture the vehicle step's model
 *   read: its cells are patched as the vehicle step
 *   patches a vehicle (vehicle-removal.ts: the region and its skirt, the ring, the stacks; every vertex moved down onto
 *   the infill's surface; the texels from the infill's ladder behind its seam gate).
 * - A spike: a slender cluster whose section swings up its height (the scan's twisted sheet, not a post), neither real
 *   nor an upright by the audit's measures, wherever it stands: patched the same way.
 * - Stays: anything slender with a steady section (a bollard, a post, a pole, a hydrant), anything off the carriageway
 *   that is not a spike, anything the audit calls a real object on its own, anything over a fixture the model read,
 *   anything building-sized or taller than a vehicle.
 *
 * Labels: the deleted triangles are reported; a patched lump's heights are generated (nothing was measured under it) and
 * its texels carry the infill's labels, all in the GLB's root extras (sbStreetResidue).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GroundModel, ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from './glb-bytes';
import { readTileTriangles } from './tile-texture-transfer';
import type { RoadSurface } from './road-surfaces';
import { BUILDING_PART_MIN, RESIDUAL_AUDIT_THRESHOLDS, type AuditedCluster } from './residual-audit';
import { UPRIGHT, type DistrictAuditResult } from './district-residual-audit';
import { applyInfillToGlb, cellsToTriangles, infillExtras, infillRegions, writeInfillRecords, type InfillRegionSpec, type RegionInfill } from './surface-infill';
import {
    measureRings, measureStacks, patchHeight, patchVehiclesInGlb, vehicleCandidates, vehicleRegion, VEHICLE_REMOVAL_PARAMS,
    type PatchGlbStats, type VehicleLookups, type VehicleRemovalParams
} from './vehicle-removal';

export const STREET_RESIDUE_VERSION = 'street-residue/1';

export const STREET_RESIDUE_PARAMS = {
    /** A scan artefact is floating when the audit's floating score is at least this and its nearest gap to the ground and buildings at least `floatingGapM`. */
    floatingMin: 0.5,
    floatingGapM: 0.25,
    /** ...and no cluster that stays comes within this of it (box to box): a part the scan detached from a standing thing stays with it. */
    floatingClearM: 0.5,
    /** A lump lies on the carriageway when at least this share of its plan samples does, and it stands within `carriagewayLevelM` of the carriageway's level. */
    carriagewayShare: 0.6,
    carriagewayLevelM: 0.5,
    /** A point takes the band of the nearest measured station along its road within this (stations drop out where the street is cluttered). */
    carriagewayAlongM: 30,
    /** A lump's height above what supports it over its larger plan extent, at most: a bollard (2.4 on Penn's 8th Ave) or a post is taller than it is wide. */
    lumpMaxSlenderness: 1.2,
    /** A lump stands at most this above what supports it (a vehicle's height; taller is not a remnant on the street). */
    lumpMaxHeightM: 2.5,
    /** A lump covers at least this in plan (its clusters' plan extents): smaller is a fragment the vehicle step's debris rule reaches. */
    lumpMinAreaM2: 1.5,
    /** Clusters whose plan boxes lie this close are one lump: the audit splits one melted pile into pieces. */
    mergeGapM: 0.75,
    /** A lump whose box overlaps a fixture the vehicle step's model read by this share of the lump's box stays. */
    keepOverlap: 0.3,
    /**
     * A spike: a slender cluster whose cross-section swings up its height, wider, narrower and wider again at least
     * `spikeMinReversals` times over at least `spikeMinSlices` of the audit's slices (a change under `spikeSizeTol` of the
     * median slice size is no change). A bollard or a post keeps one section (Penn's 8th Ave: every slice the same size);
     * a sign or a signal head on a pole steps out and back once; the scan's twisted sheet (the 2.9 m one at the Farley
     * block: 0.15, 0.39, 0.10, 0.58 m) keeps turning. It is patched like a lump when the audit cannot call it real or an upright.
     */
    spikeMinSlices: 6,
    /** A spike stands at most this above what supports it (the vehicle step's patch never moves a vertex further). */
    spikeMaxHeightM: 5,
    spikeMinReversals: 3,
    spikeSizeTol: 0.15,
    /** A cluster with at least this share of its plan box inside a removed cluster's box, and within `mergeGapM` of it, goes with it. */
    absorbShare: 0.5,
    /** What stays is kept out of every patch region by this much around its plan footprint (the skirt never reaches it). */
    keepPadM: 0.25,
    /** Sample spacing over a cluster's triangles when its plan footprint is rasterised (m). */
    sampleM: 0.1
};
export type StreetResidueParams = typeof STREET_RESIDUE_PARAMS;

/** On in a district unless SCRATCHBOX_STREET_RESIDUE=0. */
export function streetResidueEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STREET_RESIDUE !== '0';
}

type Box2 = { lo: [number, number]; hi: [number, number] };

/** Why a cluster stays (the measure that keeps it). */
export type ResidueKept = 'slender' | 'real' | 'fixture' | 'building-sized' | 'tall' | 'small' | 'off the carriageway' | 'on the street' | 'near a standing cluster' | 'under what stays';

export interface ResidueLump {
    id: number;
    /** A lump (wide and low) or a spike (slender, its section swinging up its height). */
    kind: 'lump' | 'spike';
    clusters: number[];
    lo: [number, number]; hi: [number, number];
    planM2: number;
    heightM: number;
    /** Area-weighted real-object score of its clusters (the audit's). */
    real: number;
    slenderness: number;
}

export interface ResidueSelection {
    floating: number[];
    lumps: ResidueLump[];
    kept: Array<{ id: number; why: ResidueKept }>;
}

const heightOf = (c: Pick<AuditedCluster, 'attachment' | 'lo' | 'hi'>) => {
    const h = c.attachment?.topAboveSupportM;
    return typeof h === 'number' && Number.isFinite(h) ? h : c.hi[1] - c.lo[1];
};
const planExtent = (c: Pick<AuditedCluster, 'frame'>) => Math.max(c.frame.extentsM[0], c.frame.extentsM[2], 0.05);
const slendernessOf = (c: Pick<AuditedCluster, 'attachment' | 'lo' | 'hi' | 'frame'>) => heightOf(c) / planExtent(c);
const buildingSized = (c: Pick<AuditedCluster, 'frame'>) => c.frame.extentsM[1] >= BUILDING_PART_MIN.heightM && c.frame.extentsM[0] * c.frame.extentsM[2] >= BUILDING_PART_MIN.planM2;
const planGap = (a: Box2, b: Box2) => Math.hypot(Math.max(0, a.lo[0] - b.hi[0], b.lo[0] - a.hi[0]), Math.max(0, a.lo[1] - b.hi[1], b.lo[1] - a.hi[1]));
const boxGap3 = (a: Pick<AuditedCluster, 'lo' | 'hi'>, b: Pick<AuditedCluster, 'lo' | 'hi'>) => Math.hypot(...[0, 1, 2].map(k => Math.max(0, a.lo[k] - b.hi[k], b.lo[k] - a.hi[k])));
const plan = (c: Pick<AuditedCluster, 'lo' | 'hi'>): Box2 => ({ lo: [c.lo[0], c.lo[2]], hi: [c.hi[0], c.hi[2]] });
/** How many times a cluster's slice sizes turn from growing to shrinking or back, going up (changes under the tolerance ignored). */
export function sectionReversals(sizes: number[], tol: number): number {
    const med = [...sizes].sort((a, b) => a - b)[Math.floor(sizes.length / 2)] ?? 0;
    let last = 0, n = 0;
    for (let i = 1; i < sizes.length; i++) {
        const d = sizes[i] - sizes[i - 1];
        if (Math.abs(d) < tol * med) continue;
        const s = Math.sign(d);
        if (last && s !== last) n++;
        last = s;
    }
    return n;
}
const overlapShare = (a: Box2, b: Box2) => {
    const ix = Math.min(a.hi[0], b.hi[0]) - Math.max(a.lo[0], b.lo[0]), iz = Math.min(a.hi[1], b.hi[1]) - Math.max(a.lo[1], b.lo[1]);
    const area = Math.max(1e-6, (a.hi[0] - a.lo[0]) * (a.hi[1] - a.lo[1]));
    return ix > 0 && iz > 0 ? (ix * iz) / area : 0;
};

/**
 * The measured carriageway (road-surfaces.ts measureRoadSurfaces): the level of the street at a plan point, NaN off every
 * carriageway. Each road's band is the median over its stations of where the measured carriageway lies across its vector
 * centreline (the station's shift less its left kerb, plus its right kerb; road-surfaces.ts reads the left kerb on the
 * normal's negative side), so one station's kerb read on a parked car or a bollard does not move it; a point takes the band and the level of the nearest station along its road (within
 * `carriagewayAlongM`), and a median strip under the line is not carriageway.
 */
export function carriagewayLevelAt(roads: RoadSurface[], P: StreetResidueParams = STREET_RESIDUE_PARAMS): (x: number, z: number) => number {
    const median = (v: number[]) => { const a = [...v].sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : NaN; };
    const stations = roads.flatMap(r => {
        const lo = median(r.stations.map(s => s.shiftM - s.left.halfWidthM)), hi = median(r.stations.map(s => s.shiftM + s.right.halfWidthM));
        return r.stations.map(s => ({ s, lo, hi, vx: s.x - s.shiftM * s.nx, vz: s.z - s.shiftM * s.nz }));
    });
    const CELL = 16, cells = new Map<string, typeof stations>();
    for (const q of stations) { const k = `${Math.floor(q.vx / CELL)},${Math.floor(q.vz / CELL)}`; let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(q); }
    const reach = Math.ceil((P.carriagewayAlongM + 20) / CELL);
    return (x, z) => {
        let best = Infinity, level = NaN;
        const ci = Math.floor(x / CELL), ck = Math.floor(z / CELL);
        for (let dk = -reach; dk <= reach; dk++) for (let di = -reach; di <= reach; di++) for (const q of cells.get(`${ci + di},${ck + dk}`) ?? []) {
            const dx = x - q.vx, dz = z - q.vz, along = dx * q.s.tx + dz * q.s.tz, across = dx * q.s.nx + dz * q.s.nz;
            if (Math.abs(along) > P.carriagewayAlongM || Math.abs(along) >= best || across < q.lo || across > q.hi) continue;
            const m = q.s.median, c = across - q.s.shiftM;
            if (m && c > -m.leftEdgeM && c < m.rightEdgeM) continue;
            best = Math.abs(along);
            // the station's profile, left kerb (the normal's negative side) to right kerb across it
            const f = Math.max(-1, Math.min(1, c < 0 ? c / Math.max(q.s.left.halfWidthM, 1e-3) : c / Math.max(q.s.right.halfWidthM, 1e-3)));
            const t = (f + 1) * 2, i = Math.min(3, Math.floor(t)), w = t - i;
            level = (1 - w) * q.s.profile[i] + w * q.s.profile[i + 1];
        }
        return level;
    };
}

/** A spike by the audit's measures: its section swings up its height, and the audit calls it neither real nor an upright. */
function spiky(c: AuditedCluster, P: StreetResidueParams): boolean {
    if (c.verdict === 'real-object' || (c.scores?.real ?? 0) >= RESIDUAL_AUDIT_THRESHOLDS.realMin) return false;
    const upright = Number((c.feature?.measurements as Record<string, unknown> | undefined)?.uprightScore ?? 0);
    if (upright >= UPRIGHT.min) return false;
    const sizes = (c.slices ?? []).map(s => s.size).filter(v => Number.isFinite(v) && v > 0);
    return sizes.length >= P.spikeMinSlices && sectionReversals(sizes, P.spikeSizeTol) >= P.spikeMinReversals;
}

/** Which of the audit's clusters go (floating, lumps, spikes) and why each other one stays. Measures only. */
export function selectStreetResidue(clusters: AuditedCluster[], keep: Box2[] = [], P: StreetResidueParams = STREET_RESIDUE_PARAMS, onCarriageway: (c: AuditedCluster) => boolean = () => false): ResidueSelection {
    const why = new Map<number, ResidueKept>();
    const floatingFirst = clusters.filter(c => c.verdict === 'scan-artefact' && (c.scores?.floating ?? 0) >= P.floatingMin && (c.attachment?.minGapToSolidM ?? 0) >= P.floatingGapM);
    const floatingIds = new Set(floatingFirst.map(c => c.id));
    // the spikes: slender, the section swinging up the height, neither real nor an upright by the audit's measures
    const spikes: AuditedCluster[] = [];
    // the lumps: wide and low, a vehicle's height at most, joined with the pieces beside them
    const eligible = clusters.filter(c => {
        if (floatingIds.has(c.id)) return false;
        const h = heightOf(c);
        if (buildingSized(c)) { why.set(c.id, 'building-sized'); return false; }
        if (!(h > 0)) { why.set(c.id, 'on the street'); return false; }
        if (slendernessOf(c) > P.lumpMaxSlenderness) {
            if (h <= P.spikeMaxHeightM && spiky(c, P)) spikes.push(c);
            else why.set(c.id, h > P.lumpMaxHeightM ? 'tall' : 'slender');
            return false;
        }
        if (h > P.lumpMaxHeightM) { why.set(c.id, 'tall'); return false; }
        if (!onCarriageway(c)) { why.set(c.id, 'off the carriageway'); return false; }
        return true;
    });
    const parent = eligible.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < eligible.length; i++) for (let j = i + 1; j < eligible.length; j++) if (planGap(plan(eligible[i]), plan(eligible[j])) <= P.mergeGapM) parent[find(i)] = find(j);
    const groups = new Map<number, AuditedCluster[]>();
    eligible.forEach((c, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), c]); });
    const lumps: ResidueLump[] = [];
    for (const members of groups.values()) {
        const lo: [number, number] = [Math.min(...members.map(c => c.lo[0])), Math.min(...members.map(c => c.lo[2]))];
        const hi: [number, number] = [Math.max(...members.map(c => c.hi[0])), Math.max(...members.map(c => c.hi[2]))];
        const planM2 = members.reduce((s, c) => s + c.frame.extentsM[0] * c.frame.extentsM[2], 0);
        const area = members.reduce((s, c) => s + Math.max(c.areaM2, 1e-6), 0);
        const real = members.reduce((s, c) => s + Math.max(c.areaM2, 1e-6) * (c.scores?.real ?? 0), 0) / area;
        const heightM = Math.max(...members.map(heightOf));
        const slenderness = heightM / Math.max(hi[0] - lo[0], hi[1] - lo[1], 0.05);
        const box = { lo, hi };
        const stay: ResidueKept | undefined = keep.some(k => overlapShare(box, k) >= P.keepOverlap) ? 'fixture'
            : real >= RESIDUAL_AUDIT_THRESHOLDS.realMin ? 'real'
                : planM2 < P.lumpMinAreaM2 ? 'small'
                    : slenderness > P.lumpMaxSlenderness ? 'slender' : undefined;
        if (stay) { for (const c of members) why.set(c.id, stay); continue; }
        lumps.push({ id: lumps.length, kind: 'lump', clusters: members.map(c => c.id).sort((a, b) => a - b), lo, hi, planM2: r2(planM2), heightM: r2(heightM), real: r2(real), slenderness: r2(slenderness) });
    }
    for (const c of spikes) {
        if (keep.some(k => overlapShare(plan(c), k) >= P.keepOverlap)) { why.set(c.id, 'fixture'); continue; }
        lumps.push({ id: lumps.length, kind: 'spike', clusters: [c.id], lo: [c.lo[0], c.lo[2]], hi: [c.hi[0], c.hi[2]], planM2: r2(c.frame.extentsM[0] * c.frame.extentsM[2]), heightM: r2(heightOf(c)), real: r2(c.scores?.real ?? 0), slenderness: r2(slendernessOf(c)) });
    }
    // a piece inside a removed cluster's own box (the audit split one spike or pile into a sheet and its copy) goes with it,
    // unless the audit calls it real
    const byId = new Map(clusters.map(c => [c.id, c] as const));
    for (const c of clusters) {
        if (floatingIds.has(c.id) || c.verdict === 'real-object' || (c.scores?.real ?? 0) >= RESIDUAL_AUDIT_THRESHOLDS.realMin || lumps.some(l => l.clusters.includes(c.id))) continue;
        const host = lumps.find(l => l.clusters.some(id => { const h = byId.get(id)!; return overlapShare(plan(c), plan(h)) >= P.absorbShare && boxGap3(c, h) < P.mergeGapM; }));
        if (!host) continue;
        host.clusters = [...host.clusters, c.id].sort((x, y) => x - y);
        why.delete(c.id);
    }
    // a floating piece near something that stays belongs with it
    const removedByLump = new Set(lumps.flatMap(l => l.clusters));
    const standing = clusters.filter(c => !floatingIds.has(c.id) && !removedByLump.has(c.id));
    const floating: number[] = [];
    for (const c of floatingFirst) {
        if (standing.some(o => boxGap3(c, o) < P.floatingClearM)) { why.set(c.id, 'near a standing cluster'); continue; }
        floating.push(c.id);
    }
    const gone = new Set([...floating, ...removedByLump]);
    const kept = clusters.filter(c => !gone.has(c.id)).map(c => ({ id: c.id, why: why.get(c.id) ?? (c.verdict === 'real-object' ? 'real' : 'on the street') as ResidueKept }));
    return { floating: floating.sort((a, b) => a - b), lumps, kept };
}

/** The scan triangle ids of a cluster (the audit's candidate ids through its sources). */
function scanTriangles(audit: DistrictAuditResult, c: AuditedCluster): number[] {
    const out: number[] = [];
    for (const t of c.triangleIds) {
        const s = audit.audit.sources.find(q => t >= q.firstTriangle && t < q.firstTriangle + q.triangles);
        if (s) out.push(s.localTriangles ? s.localTriangles[t - s.firstTriangle] : t - s.firstTriangle);
    }
    return out;
}

/** Calls `visit` with the plan point of every sample over scan triangle `t` (spacing at most `stepM`). */
function sampleTriangle(scan: ScanMesh, t: number, stepM: number, visit: (x: number, z: number) => void): void {
    const V = scan.mesh.vertices as ArrayLike<number>, I = scan.mesh.indices as ArrayLike<number>;
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const len = Math.max(Math.hypot(V[b] - V[a], V[b + 2] - V[a + 2]), Math.hypot(V[c] - V[a], V[c + 2] - V[a + 2]), Math.hypot(V[c] - V[b], V[c + 2] - V[b + 2]));
    const n = Math.max(1, Math.ceil(len / stepM));
    for (let i = 0; i <= n; i++) for (let j = 0; i + j <= n; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        visit(w * V[a] + u * V[b] + v * V[c], w * V[a + 2] + u * V[b + 2] + v * V[c + 2]);
    }
}

/** Deletes the GLB's triangles whose world centroid is one of `centroids` (within 2 mm): a new index accessor per primitive cut. */
export function cutTrianglesAt(bytes: Uint8Array, centroids: Float32Array): { glb: Buffer; removedTriangles: number } {
    const Q = 0.002, key = (x: number, y: number, z: number) => `${Math.round(x / Q)},${Math.round(y / Q)},${Math.round(z / Q)}`;
    const want = new Set<string>();
    for (let i = 0; i < centroids.length; i += 3) want.add(key(centroids[i], centroids[i + 1], centroids[i + 2]));
    const near = (x: number, y: number, z: number) => {
        for (const dx of [-Q, 0, Q]) for (const dy of [-Q, 0, Q]) for (const dz of [-Q, 0, Q]) if (want.has(key(x + dx, y + dy, z + dz))) return true;
        return false;
    };
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const world = nodeWorldMatrices(json);
    const extra: Uint8Array[] = [];
    let binLength = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    let removed = 0;
    const done = new Set<number>();
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || done.has(node.mesh)) return;
        done.add(node.mesh);
        for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pos = readAccessor(glb, prim.attributes.POSITION).data;
            const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : undefined;
            const count = idx ? idx.length : pos.length / 3;
            const keep: number[] = [];
            let cut = 0;
            for (let t = 0; t + 2 < count; t += 3) {
                const v = [idx ? idx[t] : t, idx ? idx[t + 1] : t + 1, idx ? idx[t + 2] : t + 2];
                const w = transformPoint(world[ni], (pos[v[0] * 3] + pos[v[1] * 3] + pos[v[2] * 3]) / 3, (pos[v[0] * 3 + 1] + pos[v[1] * 3 + 1] + pos[v[2] * 3 + 1]) / 3, (pos[v[0] * 3 + 2] + pos[v[1] * 3 + 2] + pos[v[2] * 3 + 2]) / 3);
                if (near(w[0], w[1], w[2])) { cut++; continue; }
                keep.push(v[0], v[1], v[2]);
            }
            if (!cut) continue;
            removed += cut;
            const data = new Uint8Array(new Uint32Array(keep).buffer);
            json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target: 34963 });
            json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: keep.length, type: 'SCALAR' });
            prim.indices = json.accessors.length - 1;
            extra.push(data);
            binLength += data.byteLength;
        }
    });
    if (!removed) return { glb: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), removedTriangles: 0 };
    const bin = new Uint8Array(binLength);
    bin.set(glb.bin, 0);
    let o = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    for (const e of extra) { bin.set(e, o); o += e.byteLength; }
    if (json.buffers?.[0]) json.buffers[0].byteLength = binLength;
    return { glb: assembleGlb(json, bin), removedTriangles: removed };
}

export interface StreetResidueReport {
    schema: 'scratchbox.street-residue/1';
    version: string;
    clusters: number;
    floating: { clusters: number[]; triangles: number };
    lumps: Array<ResidueLump & {
        /** The patch region groups the lump's cells fell in. */
        regions: number[];
        infill: Array<{ region: number; rungs: string[]; gatePassed: boolean; rimDeltaE: number | null; levels: number; shares: RegionInfill['shares'] }>;
        reason: string;
    }>;
    kept: Partial<Record<ResidueKept, number>>;
    patch?: PatchGlbStats & { paintedTexels: number; repaintedImages: number };
    notes: string[];
    ms: number;
}

export interface StreetResidueInput {
    /** The tree-stripped scan (textured GLB) and the same scan loaded (loadScanMesh). */
    glb: Uint8Array;
    scan: ScanMesh;
    ground: GroundModel;
    /** The district residual audit run on this scan. */
    audit: DistrictAuditResult;
    look?: VehicleLookups;
    /** The fixtures the vehicle step's model read (permanent things): a lump over one stays. */
    keep?: Box2[];
    /** The carriageway's level at a plan point, NaN off it (carriagewayLevelAt over the measured roads): lumps are taken only on it. Absent: no lump is. */
    carriageway?: (x: number, z: number) => number;
    P?: StreetResidueParams;
    vehicleP?: VehicleRemovalParams;
    /** Writes each patch's infill records here. */
    recordsDir?: string;
    signal?: AbortSignal;
    log?: (m: string) => void;
}

export interface StreetResidueResult { glb: Buffer; report: StreetResidueReport; infill: RegionInfill[] }

/** Takes the street residue out of the scan: the floating artefacts deleted, the lumps patched by the surface infill. */
export async function removeStreetResidue(input: StreetResidueInput): Promise<StreetResidueResult> {
    const t0 = Date.now();
    const P = input.P ?? STREET_RESIDUE_PARAMS, VP = input.vehicleP ?? VEHICLE_REMOVAL_PARAMS;
    const log = input.log ?? (() => undefined);
    const clusters = input.audit.audit.clusters;
    const byId = new Map(clusters.map(c => [c.id, c] as const));
    // a cluster on the carriageway: most of its plan samples on a road's band, standing at that band's level
    const onCarriageway = (c: AuditedCluster): boolean => {
        if (!input.carriageway) return false;
        const levels: number[] = [];
        let n = 0;
        for (const t of scanTriangles(input.audit, c)) sampleTriangle(input.scan, t, Math.max(P.sampleM, 0.25), (x, z) => { n++; const y = input.carriageway!(x, z); if (y === y) levels.push(y); });
        if (!n || levels.length < P.carriagewayShare * n) return false;
        const support = typeof c.attachment?.supportY === 'number' && Number.isFinite(c.attachment.supportY) ? c.attachment.supportY : c.lo[1];
        return Math.abs(support - [...levels].sort((a, b) => a - b)[Math.floor(levels.length / 2)]) <= P.carriagewayLevelM;
    };
    const sel = selectStreetResidue(clusters, input.keep ?? [], P, onCarriageway);
    const keptCounts: StreetResidueReport['kept'] = {};
    for (const k of sel.kept) keptCounts[k.why] = (keptCounts[k.why] ?? 0) + 1;
    const report: StreetResidueReport = { schema: 'scratchbox.street-residue/1', version: STREET_RESIDUE_VERSION, clusters: clusters.length, floating: { clusters: sel.floating, triangles: 0 }, lumps: [], kept: keptCounts, notes: [], ms: 0 };
    // 1. the floating artefacts: deleted (nothing rests on them)
    const V = input.scan.mesh.vertices as ArrayLike<number>, I = input.scan.mesh.indices as ArrayLike<number>;
    const centroids: number[] = [];
    for (const id of sel.floating) for (const t of scanTriangles(input.audit, byId.get(id)!)) {
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        centroids.push((V[a] + V[b] + V[c]) / 3, (V[a + 1] + V[b + 1] + V[c + 1]) / 3, (V[a + 2] + V[b + 2] + V[c + 2]) / 3);
    }
    const cut = centroids.length ? cutTrianglesAt(input.glb, Float32Array.from(centroids)) : { glb: Buffer.from(input.glb.buffer, input.glb.byteOffset, input.glb.byteLength), removedTriangles: 0 };
    report.floating.triangles = cut.removedTriangles;
    log(`street residue: ${sel.floating.length} floating artefacts (${cut.removedTriangles} triangles) deleted, ${sel.lumps.length} lumps to patch`);
    let glb = cut.glb;
    let infill: RegionInfill[] = [];
    if (sel.lumps.length) {
        // 2. the lumps: their cells patched as the vehicle step patches a vehicle (no reading: carriageway debris)
        const { grid } = vehicleCandidates(input.scan, input.ground, input.look ?? {}, VP);
        const cellAt = (x: number, z: number) => { const i = Math.floor((x - grid.x0) / grid.cellM), k = Math.floor((z - grid.z0) / grid.cellM); return i < 0 || k < 0 || i >= grid.nx || k >= grid.nz ? -1 : k * grid.nx + i; };
        // what stays never enters a region: its footprint, padded, is not street for the patch
        const pad = Math.round(P.keepPadM / grid.cellM);
        for (const k of sel.kept) {
            const c = byId.get(k.id)!;
            if (heightOf(c) <= 0) continue;
            for (const t of scanTriangles(input.audit, c)) sampleTriangle(input.scan, t, P.sampleM, (x, z) => {
                const q = cellAt(x, z);
                if (q < 0) return;
                const i = q % grid.nx, kk = (q - i) / grid.nx;
                for (let dk = -pad; dk <= pad; dk++) for (let di = -pad; di <= pad; di++) { const ii = i + di, k2 = kk + dk; if (ii >= 0 && k2 >= 0 && ii < grid.nx && k2 < grid.nz) grid.street[k2 * grid.nx + ii] = 0; }
            });
        }
        grid.debris = sel.lumps.map(l => {
            const cells = new Set<number>();
            for (const id of l.clusters) for (const t of scanTriangles(input.audit, byId.get(id)!)) sampleTriangle(input.scan, t, P.sampleM, (x, z) => { const q = cellAt(x, z); if (q >= 0 && grid.street[q]) cells.add(q); });
            return [...cells];
        });
        const { region } = vehicleRegion(grid, [], [], VP);
        measureRings(region, input.scan, input.ground, VP);
        measureStacks(region, input.scan, input.ground, VP);
        const lumpOfGroup = region.groups.map(g => sel.lumps.filter((_, li) => grid.debris![li].some(c => region.group[c] === g.id)).map(l => l.id));
        const what = (gid: number) => {
            const ls = lumpOfGroup[gid].map(id => sel.lumps[id]), spikes = ls.filter(l => l.kind === 'spike').length, lumps = ls.length - spikes;
            const parts = [lumps ? `${lumps === 1 ? 'a lump' : `${lumps} lumps`} of scan wider than it is tall (a vehicle's remnant, a dropped load or the scan's own blob)` : '', spikes ? `${spikes === 1 ? 'a spike' : `${spikes} spikes`} of scan whose section swings up its height (the scan's twisted sheet, not a post)` : ''].filter(Boolean);
            return `${parts.join(' and ')} standing on the street, which the residual audit could not call a real object or an upright, under no fixture the vision model read`;
        };
        const specs: InfillRegionSpec[] = region.groups.map(g => ({ id: g.id, what: what(g.id), hole: cellsToTriangles(g.cells, region.nx, region.x0, region.z0, region.cellM, (x, z) => patchHeight(g, x, z)), ring: g.ring, plan: true }));
        const tris = readTileTriangles(glb);
        const filled = await infillRegions({ scan: tris, regions: specs, ...(input.signal ? { signal: input.signal } : {}), log });
        infill = filled.regions;
        if (input.recordsDir && infill.length) writeInfillRecords(input.recordsDir, infill, 'street residue');
        const byGroup = new Map(infill.map(r => [r.id as number, r] as const));
        const surface = (gid: number, x: number, z: number) => { const r = byGroup.get(gid); if (!r) return NaN; const c = r.chart; return c.origin[1] + r.model.heightAt(x - c.origin[0], z - c.origin[2]); };
        const moved = patchVehiclesInGlb(glb, region, { surface, P: VP });
        // a lump whose cells all lie under what stays has nothing to patch: it stays, and is counted so
        const patched = sel.lumps.filter(l => region.groups.some(g => lumpOfGroup[g.id].includes(l.id)));
        for (const l of sel.lumps) if (!patched.includes(l)) keptCounts['under what stays'] = (keptCounts['under what stays'] ?? 0) + l.clusters.length;
        sel.lumps = patched;
        report.lumps = patched.map(l => {
            const regions = region.groups.filter(g => lumpOfGroup[g.id].includes(l.id)).map(g => g.id);
            const fills = regions.map(gid => byGroup.get(gid)!).filter(Boolean);
            return {
                ...l, regions,
                infill: fills.map(f => ({ region: f.id as number, rungs: f.attempts.filter(a => a.accepted).map(a => a.rung), gatePassed: f.gatePassed, rimDeltaE: f.attempts.find(a => a.accepted)?.gate?.metrics.rim?.median ?? null, levels: f.model.levels.length, shares: f.shares })),
                reason: `${l.kind === 'spike' ? 'a spike' : 'a lump'}: ${l.clusters.length} cluster${l.clusters.length === 1 ? '' : 's'} of the residual audit standing ${l.heightM} m over ${l.planM2} m² of street, ${l.slenderness} as tall as wide${l.kind === 'spike' ? ', its section swinging up its height' : ''}, real-object score ${l.real} (under ${RESIDUAL_AUDIT_THRESHOLDS.realMin}), under no fixture the vision model read: removed, the street under it estimated from the measured ring and painted by the surface infill`
            };
        });
        const extras = {
            sbStreetResidue: {
                version: STREET_RESIDUE_VERSION,
                floating: { clusters: sel.floating, triangles: cut.removedTriangles, provenance: 'deleted: scan artefacts touching nothing (the residual audit\'s floating measure), no surface rests on them' },
                lumps: report.lumps.map(l => ({ id: l.id, kind: l.kind, clusters: l.clusters, lo: l.lo, hi: l.hi, planM2: l.planM2, heightM: l.heightM, real: l.real, regions: l.regions, geometry: { label: 'generated', reason: 'heights estimated from the measured scan around it: nothing was measured under it' }, reason: l.reason })),
                infill: (infillExtras(infill, 'street residue') as { sbInfill: unknown }).sbInfill
            }
        };
        const painted = applyInfillToGlb(moved.glb, infill, { paint: true, paintPlan: true, extras });
        glb = painted.glb;
        report.patch = { ...moved.stats, paintedTexels: painted.stats.paintedTexels, repaintedImages: painted.stats.repaintedImages };
    }
    const area = r2(sel.lumps.reduce((s, l) => s + l.planM2, 0)), spikes = sel.lumps.filter(l => l.kind === 'spike').length;
    const stay = Object.values(keptCounts).reduce((a, b) => a + (b ?? 0), 0);
    report.notes.push(`street residue: of ${clusters.length} clusters the residual audit found standing in the streets, ${sel.floating.length} floating artefacts deleted (${cut.removedTriangles} triangles), ${sel.lumps.length - spikes} lumps and ${spikes} spikes (${area} m²) patched by the surface infill; ${stay} stay (${Object.entries(keptCounts).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'})`);
    report.ms = Date.now() - t0;
    return { glb, report, infill };
}

/** Writes the residue's GLB and report into `dir`. */
export function writeStreetResidue(dir: string, r: StreetResidueResult): { glb: string; report: string } {
    fs.mkdirSync(dir, { recursive: true });
    const glb = path.join(dir, 'street_residue.glb'), report = path.join(dir, 'street_residue.json');
    fs.writeFileSync(glb, r.glb);
    fs.writeFileSync(report, JSON.stringify(r.report, null, 1));
    return { glb, report };
}

const r2 = (v: number) => Math.round(v * 100) / 100;
