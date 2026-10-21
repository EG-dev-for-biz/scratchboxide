/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Residual audit: decides, from measured numbers only, whether each leftover scan cluster of a staged build (the triangles
 * the clean massing does not explain, kept "as scanned") is a real object, a scan artefact or unsure.
 *
 *   1. The native tool (scripts/residual_audit.cpp, scratchbox_residual_audit.hpp) groups the candidate triangles into
 *      connected clusters and measures each against the clean solid, the ground and the other clusters (size, oriented
 *      extents, thinness, triangle quality, normal coherence, closure, envelope volume, contact, support and open space
 *      below, height above its support, radial symmetry of horizontal slices, cross-section constancy, periodicity).
 *   2. Photo agreement here: each triangle's tile photo, sampled at its corners and centre (mean colour, luminance spread).
 *   3. The verdict (`judgeCluster`): continuous evidence scores built from the measures with the ramps of
 *      RESIDUAL_AUDIT_THRESHOLDS; the reason states the numbers. Feature-type codes (sb-feature-types.ts) are attached
 *      afterwards as labels with a confidence; nothing is decided from a code.
 *
 * Real data only: the scan's own triangles and photos and the clean massing built from Google's vector data. Nothing is
 * generated, and an audit that cannot run says so (the residual then stays as it was, unaudited).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from '../native-build-cache';
import { findTileRefineRepoRoot } from '../tile-refine-service';
import type { RgbaImage8 } from './tile-texture-transfer';
import { assembleGlb, parseGlbBytes, readAccessor } from './glb-bytes';
import { SB_FEATURE_PREFIX, typesFromLabels, type SbFeature, type SbFeatureTypeLabel } from '../../../common/spatial/sb-feature-types';

export const RESIDUAL_AUDIT_VERSION = 'residual-audit/1';
export type V3 = [number, number, number];

/** The native measuring parameters (metres or ratios). */
export const RESIDUAL_AUDIT_MEASURE_PARAMS = {
    /** Vertices this close are one (clusters are connected through shared vertices). */
    weldM: 0.001,
    /** Within this of a surface counts as touching it: just over pipeline E's residualProud (0.6 m), where the residual begins. */
    contactTol: 0.75,
    /** A plan cell with at least this drop to the surface below is open underneath. */
    openBelowM: 0.75,
    /** A plan cell with more than this drop (or nothing) below overhangs. */
    maxDropM: 6.0,
    /** Triangles with quality under this (4 sqrt(3) A / sum l^2) are slivers. */
    sliverQuality: 0.15,
    /** A slice's circle fit scores 0 at an RMS of this share of its radius. */
    radialTol: 0.25,
    /** Horizontal slice spacing for the symmetry measures. */
    sliceStepM: 0.25,
    /** Clusters smaller than this are not measured (0: all). */
    minClusterAreaM2: 0,
    /** A triangle facing the nearest solid surface squarely (|normal . direction| >= copyParallel) within copyReachM of it is a copy of that surface. */
    copyReachM: 3.0,
    copyParallel: 0.9,
    /** A copy component joins the one other component sharing at least this share of its boundary (a box's top). */
    copyMergeShare: 0.5
};

/**
 * The verdict's ramps: ramp(x, a, b) rises from 0 at a to 1 at b (falls when b < a). Every score is in [0, 1].
 *   spike    = ramp(a, spikeLenM) * ramp(b/a, spikeElongation) * (1 - ramp(main-axis verticality, poleVerticality))
 *              * ramp(contact along its length, alongContact): a shard touches at one end, a band fixed to a wall all along
 *   sliver   = ramp(sliver area share, sliverShare) * ramp(c/a, sheetThinness)
 *   floating = ramp(min gap to the solid, floatGapM) * (1 - ramp(grounded share, floatGrounded))
 *   curtain  = sheet * ramp(1 - sheet-normal verticality, verticalSheet) * ramp(open-below share, curtainOpenBelow)
 *              * ramp(contact along its length, alongContact)
 *   offset   = ramp(copy share, copyShare): most of it faces the nearest massing surface squarely within copyReachM, the
 *              scan's own copy of a surface the massing already has (a roof patch poking through a roof plane)
 *   real     = min(ramp(c/a, bodyThinness), ramp(1 - normal coherence, bodyEnclosure), ramp(top above support, riseM),
 *              max(ramp(min gap to the solid, attachGapM), ramp(grounded share, attach)), ramp(share inside the solid, outside))
              * (1 + shapeBonus * max(radial, constancy))
 * A body (thick and enclosed) that touches nothing is held at `floatingBodyCap` artefact: its supports may be what the scan
 * lost, so it stays, unsure. Verdict: artefact when artefact >= artefactMin and it leads real by `margin`; real object when
 * real >= realMin and it leads artefact by `margin`; otherwise unsure.
 */
export const RESIDUAL_AUDIT_THRESHOLDS = {
    spikeLenM: [1.5, 4] as [number, number],
    spikeElongation: [0.2, 0.08] as [number, number],
    poleVerticality: [0.85, 0.97] as [number, number],
    sliverShare: [0.3, 0.7] as [number, number],
    sheetThinness: [0.15, 0.06] as [number, number],
    floatGapM: [0.75, 1.5] as [number, number],
    floatGrounded: [0, 0.1] as [number, number],
    alongContact: [0.6, 0.3] as [number, number],
    verticalSheet: [0.6, 0.85] as [number, number],
    curtainOpenBelow: [0.3, 0.7] as [number, number],
    copyShare: [0.6, 0.9] as [number, number],
    bodyThinness: [0.12, 0.3] as [number, number],
    bodyEnclosure: [0.35, 0.7] as [number, number],
    riseM: [0.5, 1.5] as [number, number],
    attachGapM: [1.5, 0.3] as [number, number],
    /** A real object stands outside the clean massing: real falls as the share of it inside the solid rises. */
    outside: [0.5, 0.2] as [number, number],
    attach: [0, 0.05] as [number, number],
    shapeBonus: 0.3,
    floatingBodyCap: 0.55,
    artefactMin: 0.6,
    realMin: 0.6,
    margin: 0.2,
    /** Photo: a sky-coloured cluster (bright, blue over red) adds this times its sky share to the artefact score. */
    skyWeight: 0.15
};

export type ResidualAuditThresholds = typeof RESIDUAL_AUDIT_THRESHOLDS;
export type ResidualVerdict = 'real-object' | 'scan-artefact' | 'unsure';

/** One cluster as the native tool measured it. */
export interface NativeCluster {
    id: number;
    triangles: number;
    areaM2: number;
    lo: V3; hi: V3;
    frame: { origin: V3; xAxis: V3; yAxis: V3; zAxis: V3; extentsM: V3 };
    principal: { axes: [V3, V3, V3]; extentsM: V3 };
    shape: { thinness: number; elongation: number; mainAxisVerticality: number; sheetNormalVerticality: number };
    surface: { qualityMedian: number; sliverShare: number; maxEdgeM: number; normalCoherence: number; upShare: number; downShare: number; sideShare: number; boundaryEdgeShare: number; copyShare: number };
    volume: { envelopeM3: number; boxM3: number; fill: number; cellM: number };
    attachment: {
        minGapToSolidM: number; medianGapToSolidM: number; contactShare: number; contactAlongShare: number; insideShare: number; gapToGroundM: number | null; footprintCells: number; groundedShare: number; enclosedShare: number; openBelowShare: number;
        overhangShare: number; medianDropM: number; maxDropM: number; supportY: number; baseAboveSupportM: number; topAboveSupportM: number; baseAboveGroundM: number | null; topAboveGroundM: number | null;
    };
    symmetry: { radialSymmetry: number; radiusMedianM: number; slicesUsed: number; crossSectionConstancy: number; periodicity: number; periodM: number };
    /** Horizontal slices (sliceStepM apart): each slice's circle fit (y, cx, cz, r all world metres; r 0 when the fit failed). */
    slices: Array<{ y: number; cx: number; cz: number; r: number; rmsRel: number; sectors: number; size: number; points: number }>;
    photo: { rgb: V3; lumaStd: number; share: number } | null;
    triangleIds: number[];
}

export interface NativeAuditReport { schema: 'scratchbox.residual-audit/1'; solidTriangles: number; candidateTriangles: number; params: Record<string, number | null>; clusters: NativeCluster[] }

export interface ClusterScores { spike: number; sliver: number; floating: number; curtain: number; offset: number; sky: number; artefact: number; real: number }

export interface AuditedCluster extends NativeCluster {
    verdict: ResidualVerdict;
    confidence: number;
    /** In words, from the numbers. */
    reason: string;
    scores: ClusterScores;
    /** Photo agreement: share of the cluster's photo that looks like open sky (bright and blue over red), when it has a photo. */
    skyShare: number | null;
    /** Feature-type labels (open codes, sb-feature-types.ts) with confidence: labels only, the verdict does not use them. */
    typeLabels: SbFeatureTypeLabel[];
    /** The cluster in the sb-feature/1 model, for later tools (streetview_look_at, vision_measure_shape, location_fit_object). */
    feature: SbFeature;
}

export interface ResidualAuditResult {
    schema: 'scratchbox.residual-audit-result/1';
    version: string;
    /** What the candidates were, triangle ids index into this concatenation: per source node, its first id and count. */
    sources: Array<{ node: string; firstTriangle: number; triangles: number; localTriangles?: number[] }>;
    candidateTriangles: number;
    solidTriangles: number;
    groundY: number | null;
    params: typeof RESIDUAL_AUDIT_MEASURE_PARAMS;
    thresholds: ResidualAuditThresholds;
    clusters: AuditedCluster[];
    counts: { clusters: number; realObjects: number; artefacts: number; unsure: number; removedTriangles: number; keptTriangles: number; removedAreaM2: number };
    /** Real objects: candidates for later fitting, kept as scanned. */
    candidates: number[];
    /** Short lines for build notes. */
    notes: string[];
    ms: number;
    dataNote: string;
}

// ------------------------------------------------------------------------------------------------ the native tool

const CLI_SOURCE = path.join('scripts', 'residual_audit.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'residual_audit');
let building: Promise<string> | undefined;

export function ensureResidualAuditBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_RESIDUAL_AUDIT_BIN) return Promise.resolve(process.env.SCRATCHBOX_RESIDUAL_AUDIT_BIN);
    building ??= (async () => {
        const bin = path.join(repoRoot, BINARY);
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), name: 'residual_audit', timeoutMs: 600_000 });
            placeCachedBinary(built.binaryPath, bin);
            return bin;
        } catch (err) {
            throw new Error(`could not build residual_audit: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** Candidate triangles with their photo (rgb 0..255 and luminance variance, or -1 when the triangle has no photo). */
export interface AuditInput { solid: Float32Array; candidates: Float32Array; photo?: Float32Array; groundY?: number }

export function writeAuditInput(file: string, input: AuditInput): void {
    const ns = input.solid.length / 9, nc = input.candidates.length / 9;
    const photo = input.photo ?? new Float32Array(nc * 4).fill(-1);
    if (photo.length !== nc * 4) throw new Error(`photo block has ${photo.length / 4} rows for ${nc} candidate triangles`);
    const head = Buffer.alloc(8);
    head.write('SBRA', 0, 'ascii');
    head.writeUInt32LE(1, 4);
    const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
    const f32 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    fs.writeFileSync(file, Buffer.concat([head, u32(ns), f32(input.solid), u32(nc), f32(input.candidates), f32(photo)]));
}

export async function runNativeAudit(input: AuditInput, dir: string, params: Partial<typeof RESIDUAL_AUDIT_MEASURE_PARAMS> = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<NativeAuditReport> {
    const bin = await ensureResidualAuditBinary();
    fs.mkdirSync(dir, { recursive: true });
    const inFile = path.join(dir, 'audit_in.bin'), outFile = path.join(dir, 'audit_native.json');
    writeAuditInput(inFile, input);
    const all = { ...RESIDUAL_AUDIT_MEASURE_PARAMS, ...params };
    const args = [inFile, outFile, ...Object.entries(all).flatMap(([k, v]) => [k, String(v)]), ...(input.groundY !== undefined && Number.isFinite(input.groundY) ? ['groundY', String(input.groundY)] : [])];
    await new Promise<void>((resolve, reject) => {
        execFile(bin, args, { timeout: opts.timeoutMs ?? 120_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, ...(opts.signal ? { signal: opts.signal } : {}) }, (err, out) => {
            let head: { ok?: boolean; error?: string } = {};
            try { head = JSON.parse(String(out).trim().split('\n').pop() ?? '{}'); } catch { /* not JSON */ }
            if (err || !head.ok) reject(new Error(`residual_audit failed: ${head.error ?? (err ? err.message : 'no answer')}`));
            else resolve();
        });
    });
    try { fs.unlinkSync(inFile); } catch { /* best effort */ }
    return JSON.parse(fs.readFileSync(outFile, 'utf8')) as NativeAuditReport;
}

// ------------------------------------------------------------------------------------------------ the verdict

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
/** 0 at a, 1 at b (decreasing when b < a). */
export const ramp = (x: number, [a, b]: [number, number]) => (!Number.isFinite(x) ? 0 : a === b ? (x >= a ? 1 : 0) : clamp01((x - a) / (b - a)));
const r2 = (v: number) => Math.round(v * 100) / 100;

export function scoreCluster(c: NativeCluster, skyShare: number | null, T: ResidualAuditThresholds = RESIDUAL_AUDIT_THRESHOLDS): ClusterScores {
    const [a] = c.principal.extentsM;
    const s = c.shape, at = c.attachment, su = c.surface, sy = c.symmetry;
    const along = ramp(at.contactAlongShare, T.alongContact);
    const spike = ramp(a, T.spikeLenM) * ramp(s.elongation, T.spikeElongation) * (1 - ramp(s.mainAxisVerticality, T.poleVerticality)) * along;
    const sheet = ramp(s.thinness, T.sheetThinness);
    const sliver = ramp(su.sliverShare, T.sliverShare) * sheet;
    const floatingRaw = ramp(at.minGapToSolidM, T.floatGapM) * (1 - ramp(at.groundedShare, T.floatGrounded));
    const curtain = sheet * ramp(1 - s.sheetNormalVerticality, T.verticalSheet) * ramp(at.openBelowShare, T.curtainOpenBelow) * along;
    const offset = ramp(su.copyShare, T.copyShare);
    const body = Math.min(ramp(s.thinness, T.bodyThinness), ramp(1 - su.normalCoherence, T.bodyEnclosure));
    const attached = Math.max(ramp(at.minGapToSolidM, T.attachGapM), ramp(at.groundedShare, T.attach));
    const shape = Math.max(sy.radialSymmetry, sy.crossSectionConstancy);
    const real = clamp01(Math.min(body, ramp(at.topAboveSupportM, T.riseM), attached, ramp(at.insideShare, T.outside)) * (1 + T.shapeBonus * shape));
    const floating = body >= T.realMin ? Math.min(floatingRaw, T.floatingBodyCap) : floatingRaw;
    const sky = skyShare ?? 0;
    const geo = Math.max(spike, sliver, floating, curtain, offset);
    const artefact = clamp01(geo + (real < 0.5 ? T.skyWeight * sky : 0));
    return { spike, sliver, floating, curtain, offset, sky, artefact, real };
}

/** The verdict, its confidence and its reason (numbers in words). */
export function judgeCluster(c: NativeCluster, skyShare: number | null, T: ResidualAuditThresholds = RESIDUAL_AUDIT_THRESHOLDS): { verdict: ResidualVerdict; confidence: number; reason: string; scores: ClusterScores } {
    const sc = scoreCluster(c, skyShare, T);
    const [a, b, cc] = c.principal.extentsM;
    const at = c.attachment;
    const dims = `${r2(a)} x ${r2(b)} x ${r2(cc)} m (principal), ${r2(c.areaM2)} m2 in ${c.triangles} triangles`;
    const why: string[] = [];
    const lead = Math.max(sc.spike, sc.sliver, sc.floating, sc.curtain, sc.offset);
    if (lead === sc.spike && sc.spike > 0.2) why.push(`line-like: ${r2(a)} m long but only ${r2(c.shape.elongation)} of that wide, its long axis ${Math.round(Math.acos(Math.min(1, c.shape.mainAxisVerticality)) * 180 / Math.PI)} deg off vertical, touching the massing along ${Math.round(at.contactAlongShare * 100)}% of its length (spike ${r2(sc.spike)})`);
    else if (lead === sc.sliver && sc.sliver > 0.2) why.push(`a sheet (thickness ${r2(c.shape.thinness)} of its length) of needle triangles: ${Math.round(c.surface.sliverShare * 100)}% of its area under quality ${RESIDUAL_AUDIT_MEASURE_PARAMS.sliverQuality} (sliver ${r2(sc.sliver)})`);
    else if (lead === sc.floating && sc.floating > 0.2) why.push(`touches nothing: ${r2(at.minGapToSolidM)} m from the massing at its nearest, ${Math.round(at.groundedShare * 100)}% of its footprint resting on anything (floating ${r2(sc.floating)})`);
    else if (lead === sc.curtain && sc.curtain > 0.2) why.push(`a hanging vertical sheet with open space under ${Math.round(at.openBelowShare * 100)}% of it (curtain ${r2(sc.curtain)})`);
    else if (lead === sc.offset && sc.offset > 0.2) why.push(`${Math.round(c.surface.copyShare * 100)}% of it faces the massing's surface squarely ${r2(at.medianGapToSolidM)} m off it (median): the scan's copy of a surface the massing has (copy ${r2(sc.offset)})`);
    if (sc.real > 0.2) {
        const extra = [c.symmetry.radialSymmetry >= 0.5 ? `round in plan (radial symmetry ${r2(c.symmetry.radialSymmetry)}, r ${r2(c.symmetry.radiusMedianM)} m)` : '', at.openBelowShare >= 0.3 ? `open space under ${Math.round(at.openBelowShare * 100)}% of it` : '', c.symmetry.crossSectionConstancy >= 0.7 ? `constant cross-section (${r2(c.symmetry.crossSectionConstancy)})` : ''].filter(Boolean);
        why.push(`a body: thickness ${r2(c.shape.thinness)} of its length, normals spread (coherence ${r2(c.surface.normalCoherence)}), standing ${r2(at.topAboveSupportM)} m above what supports it, ${r2(at.minGapToSolidM)} m from the massing at its nearest${extra.length ? `; ${extra.join(', ')}` : ''} (real ${r2(sc.real)})`);
    }
    if (sc.sky > 0.3) why.push(`${Math.round(sc.sky * 100)}% of its photo looks like open sky`);
    let verdict: ResidualVerdict = 'unsure';
    let confidence: number;
    if (sc.artefact >= T.artefactMin && sc.artefact >= sc.real + T.margin) { verdict = 'scan-artefact'; confidence = sc.artefact * (1 - sc.real); }
    else if (sc.real >= T.realMin && sc.real >= sc.artefact + T.margin) { verdict = 'real-object'; confidence = sc.real * (1 - sc.artefact); }
    else confidence = 1 - Math.abs(sc.real - sc.artefact);
    if (!why.length) why.push('no measure stands out');
    const head = verdict === 'scan-artefact' ? 'scan artefact' : verdict === 'real-object' ? 'real object' : `unsure (artefact ${r2(sc.artefact)}, real ${r2(sc.real)})`;
    return { verdict, confidence: r2(clamp01(confidence) * 1000) / 1000, reason: `${head}: ${why.join('; ')}; ${dims}`, scores: Object.fromEntries(Object.entries(sc).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) as unknown as ClusterScores };
}

/** Labels only: a real cluster at least this tall over at least this plan is labelled a building part. */
export const BUILDING_PART_MIN = { heightM: 8, planM2: 80 };

/**
 * Feature-type labels from the measures and the verdict: open codes with a confidence, for prompting, filtering and export.
 * Geometry and the verdict never read them.
 */
export function clusterTypeLabels(c: NativeCluster, j: { verdict: ResidualVerdict; scores: ClusterScores }): SbFeatureTypeLabel[] {
    const P = SB_FEATURE_PREFIX, by = 'residual-audit measures';
    const s = j.scores, at = c.attachment, sy = c.symmetry;
    if (j.verdict === 'scan-artefact') {
        const best = Math.max(s.spike, s.sliver, s.floating, s.curtain, s.offset);
        const code = best === s.spike ? 'SCAN_ARTEFACT_SPIKE' : best === s.sliver ? 'SCAN_ARTEFACT_SLIVER' : 'SCAN_ARTEFACT_FLOATING';
        return [{ code: P + code, confidence: r2(best), by }];
    }
    if (j.verdict === 'unsure') return [{ code: P + 'SCAN_UNEXPLAINED', confidence: r2(1 - Math.abs(s.real - s.artefact)), by }];
    // real: where it stands, then what its numbers look like (the parent alone when nothing stands out)
    const supportAboveGround = at.baseAboveGroundM === null ? null : at.supportY - (c.lo[1] - at.baseAboveGroundM);
    const onRoof = supportAboveGround !== null && supportAboveGround > 2.5 && at.groundedShare > 0;
    const onWall = !onRoof && at.contactShare > 0 && c.surface.sideShare > 0.5 && at.groundedShare < 0.1;
    // a body storeys tall over a large plan is a part of a building the massing lacks, not something standing on it
    const [L0, H0, W0] = c.frame.extentsM;
    const buildingPart = H0 >= BUILDING_PART_MIN.heightM && L0 * W0 >= BUILDING_PART_MIN.planM2;
    const parent = buildingPart ? 'BUILDING_PART' : onRoof ? 'ROOF_OBJECT' : onWall ? 'FACADE_ELEMENT' : 'OBJECT';
    const labels: SbFeatureTypeLabel[] = [{ code: P + parent, confidence: r2(s.real), by }];
    if (onRoof && !buildingPart) {
        const [L, H, W] = c.frame.extentsM;
        const slender = H / Math.max(0.1, Math.max(L, W));
        const tank = Math.min(sy.radialSymmetry, ramp(at.openBelowShare + sy.radialSymmetry * 0.5, [0.3, 0.8]));
        const chimney = ramp(slender, [1.2, 2.5]) * sy.crossSectionConstancy * (1 - at.openBelowShare);
        const box = ramp(c.volume.fill, [0.4, 0.8]) * (1 - sy.radialSymmetry);
        const best = Math.max(tank, chimney, box);
        if (best >= 0.4) labels.push({ code: P + (best === tank ? 'ROOF_OBJECT_TANK' : best === chimney ? 'ROOF_OBJECT_CHIMNEY' : 'ROOF_OBJECT_BULKHEAD'), confidence: r2(best * s.real), by });
    }
    return labels;
}

// ------------------------------------------------------------------------------------------------ photo

/** Samples a triangle's photo at its corners and centre: mean rgb and luminance variance, or undefined. */
export function trianglePhoto(img: RgbaImage8, uv: [number, number][]): [number, number, number, number] | undefined {
    const pts: [number, number][] = [...uv, [(uv[0][0] + uv[1][0] + uv[2][0]) / 3, (uv[0][1] + uv[1][1] + uv[2][1]) / 3]];
    const sample = ([u, v]: [number, number]) => {
        const x = Math.min(img.width - 1, Math.max(0, Math.floor((u - Math.floor(u)) * img.width))), y = Math.min(img.height - 1, Math.max(0, Math.floor((v - Math.floor(v)) * img.height)));
        const i = (y * img.width + x) * 4;
        return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2]];
    };
    const cs = pts.map(sample);
    const m = [0, 1, 2].map(k => cs.reduce((a, c) => a + c[k], 0) / cs.length);
    const l = cs.map(c => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
    const lm = l.reduce((a, b) => a + b, 0) / l.length;
    return [m[0], m[1], m[2], l.reduce((a, b) => a + (b - lm) ** 2, 0) / l.length];
}

/** Sky-coloured: bright and blue well over red (the colour photogrammetry drapes on geometry it misplaced against sky). */
export const skyLike = (rgb: ArrayLike<number>) => { const l = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; return l > 140 && rgb[2] > rgb[0] + 18 && rgb[2] >= rgb[1]; };

// ------------------------------------------------------------------------------------------------ the audit

export interface AuditSource {
    /** A label for the source (a node name). */
    node: string;
    /** Triangle soup positions (9 floats per triangle). */
    triangles: Float32Array;
    /** Per triangle, the photo sample (rgb, luma variance) or undefined. */
    photo?: Array<[number, number, number, number] | undefined>;
    /** Per candidate triangle, its triangle index in the source node (when only some of the node's triangles are audited). */
    localTriangles?: number[];
}

/** Runs the native measures and the verdicts on candidate sources against a solid. */
export async function auditResidual(input: { solid: Float32Array; sources: AuditSource[]; groundY?: number; dir: string; params?: Partial<typeof RESIDUAL_AUDIT_MEASURE_PARAMS>; thresholds?: Partial<ResidualAuditThresholds>; signal?: AbortSignal; idPrefix?: string }): Promise<ResidualAuditResult> {
    const t0 = Date.now();
    const T = { ...RESIDUAL_AUDIT_THRESHOLDS, ...(input.thresholds ?? {}) } as ResidualAuditThresholds;
    const total = input.sources.reduce((s, x) => s + x.triangles.length / 9, 0);
    const cand = new Float32Array(total * 9), photo = new Float32Array(total * 4).fill(-1);
    const sources: ResidualAuditResult['sources'] = [];
    const skyOf = new Uint8Array(total);
    let o = 0;
    for (const s of input.sources) {
        const n = s.triangles.length / 9;
        sources.push({ node: s.node, firstTriangle: o, triangles: n, ...(s.localTriangles ? { localTriangles: s.localTriangles } : {}) });
        cand.set(s.triangles, o * 9);
        for (let i = 0; i < n; i++) { const p = s.photo?.[i]; if (p) { photo.set(p, (o + i) * 4); skyOf[o + i] = skyLike(p) ? 1 : 0; } }
        o += n;
    }
    const native = await runNativeAudit({ solid: input.solid, candidates: cand, photo, ...(input.groundY !== undefined ? { groundY: input.groundY } : {}) }, input.dir, input.params, { ...(input.signal ? { signal: input.signal } : {}) });
    const area = (t: number) => { const p = cand, b = t * 9; const ux = p[b + 3] - p[b], uy = p[b + 4] - p[b + 1], uz = p[b + 5] - p[b + 2], vx = p[b + 6] - p[b], vy = p[b + 7] - p[b + 1], vz = p[b + 8] - p[b + 2]; return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx); };
    const clusters: AuditedCluster[] = native.clusters.map(c => {
        let skyA = 0, phA = 0;
        for (const t of c.triangleIds) { if (photo[t * 4] >= 0) { const a = area(t); phA += a; if (skyOf[t]) skyA += a; } }
        const skyShare = phA > 0 ? skyA / phA : null;
        const j = judgeCluster(c, skyShare, T);
        const typeLabels = clusterTypeLabels(c, j);
        const feature: SbFeature = {
            schema: 'sb-feature/1', id: `${input.idPrefix ?? 'residual'}/${c.id}`, types: typesFromLabels(typeLabels), typeLabels,
            description: j.reason, geometry: {},
            measurements: {
                areaM2: c.areaM2, lengthM: c.frame.extentsM[0], heightM: c.frame.extentsM[1], widthM: c.frame.extentsM[2], principalExtentsM: c.principal.extentsM, envelopeVolumeM3: c.volume.envelopeM3,
                baseAboveSupportM: c.attachment.baseAboveSupportM, topAboveSupportM: c.attachment.topAboveSupportM, radialSymmetry: c.symmetry.radialSymmetry, radiusMedianM: c.symmetry.radiusMedianM,
                crossSectionConstancy: c.symmetry.crossSectionConstancy, openBelowShare: c.attachment.openBelowShare
            },
            provenance: { label: 'measured', confidence: j.confidence, sources: [{ kind: 'tile-extraction', id: 'residual' }], method: `${RESIDUAL_AUDIT_VERSION}: scan triangles clustered and measured against the clean massing; verdict ${j.verdict}` },
            frame: { kind: 'local', origin: c.frame.origin, xAxis: c.frame.xAxis, yAxis: c.frame.yAxis, zAxis: c.frame.zAxis, parent: 'tile frame (x east, y up, z south)' }
        };
        return { ...c, verdict: j.verdict, confidence: j.confidence, reason: j.reason, scores: j.scores, skyShare: skyShare === null ? null : r2(skyShare), typeLabels, feature };
    });
    const art = clusters.filter(c => c.verdict === 'scan-artefact'), real = clusters.filter(c => c.verdict === 'real-object'), uns = clusters.filter(c => c.verdict === 'unsure');
    const removedTriangles = art.reduce((s, c) => s + c.triangles, 0);
    const notes = [
        `residual audit: ${clusters.length} clusters of ${total} scan triangles the massing does not explain; ${art.length} scan artefacts removed (${removedTriangles} triangles, ${r2(art.reduce((s, c) => s + c.areaM2, 0))} m2), ${real.length} real objects kept as scanned, ${uns.length} unsure kept and labelled`,
        ...art.slice().sort((p, q) => q.areaM2 - p.areaM2).slice(0, 8).map(c => `removed cluster ${c.id}: ${c.reason}`),
        ...real.map(c => `kept cluster ${c.id} (${c.typeLabels.map(l => l.code.replace(SB_FEATURE_PREFIX, '')).join(', ')}): ${c.reason}`),
        ...uns.slice().sort((p, q) => q.areaM2 - p.areaM2).slice(0, 6).map(c => `unsure cluster ${c.id}: ${c.reason}`)
    ];
    return {
        schema: 'scratchbox.residual-audit-result/1', version: RESIDUAL_AUDIT_VERSION, sources, candidateTriangles: total, solidTriangles: native.solidTriangles, groundY: input.groundY ?? null,
        params: { ...RESIDUAL_AUDIT_MEASURE_PARAMS, ...(input.params ?? {}) }, thresholds: T, clusters,
        counts: { clusters: clusters.length, realObjects: real.length, artefacts: art.length, unsure: uns.length, removedTriangles, keptTriangles: total - removedTriangles, removedAreaM2: r2(art.reduce((s, c) => s + c.areaM2, 0)) },
        candidates: real.map(c => c.id), notes, ms: Date.now() - t0,
        dataNote: 'Real data only: the scan\'s own triangles and tile photos measured against the clean massing (Google vector data). No geometry is generated; the verdict comes from the measures, the type codes are labels.'
    };
}

/** The set of candidate triangle ids the audit removes (its artefacts). */
export function removedTriangleIds(r: ResidualAuditResult): Set<number> {
    const out = new Set<number>();
    for (const c of r.clusters) if (c.verdict === 'scan-artefact') for (const t of c.triangleIds) out.add(t);
    return out;
}

/** The verdict of each candidate triangle id. */
export function verdictByTriangle(r: ResidualAuditResult): Map<number, AuditedCluster> {
    const out = new Map<number, AuditedCluster>();
    for (const c of r.clusters) for (const t of c.triangleIds) out.set(t, c);
    return out;
}

/** Writes the result JSON (the clusters' triangle ids included). */
export function writeAuditResult(file: string, r: ResidualAuditResult): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(r, null, 1));
}

/**
 * A GLB with the audit's scan artefacts taken out: per node named in the result's sources, the removed triangles dropped
 * from its index list (a new index accessor; every other byte, material, extras and provenance label kept).
 */
export function cleanGlbBytes(glbBytes: Uint8Array, r: ResidualAuditResult): { glb: Buffer; removedTriangles: number } {
    const glb = parseGlbBytes(glbBytes);
    const removed = removedTriangleIds(r);
    const dropByNode = new Map<string, Set<number>>();
    for (const s of r.sources) {
        const set = new Set<number>();
        for (let k = 0; k < s.triangles; k++) if (removed.has(s.firstTriangle + k)) set.add(s.localTriangles ? s.localTriangles[k] : k);
        if (set.size) dropByNode.set(s.node, set);
    }
    const extra: Buffer[] = [];
    let offset = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    let total = 0;
    for (const node of glb.json.nodes ?? []) {
        const drop = dropByNode.get(node.name);
        if (!drop || node.mesh === undefined) continue;
        for (const prim of glb.json.meshes[node.mesh].primitives ?? []) {
            if (prim.indices === undefined) continue;
            const idx = readAccessor(glb, prim.indices).data;
            const keep: number[] = [];
            for (let t = 0; t < idx.length / 3; t++) { if (drop.has(t)) { total++; continue; } keep.push(idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]); }
            const buf = Buffer.from(Uint32Array.from(keep).buffer);
            glb.json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, target: 34963 });
            glb.json.accessors.push({ bufferView: glb.json.bufferViews.length - 1, componentType: 5125, count: keep.length, type: 'SCALAR' });
            prim.indices = glb.json.accessors.length - 1;
            extra.push(buf);
            offset += buf.length;
        }
    }
    const pad = Buffer.alloc((4 - (glb.bin.byteLength % 4)) % 4);
    const bin = Buffer.concat([Buffer.from(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength), pad, ...extra]);
    if (glb.json.buffers?.[0]) glb.json.buffers[0].byteLength = bin.length;
    return { glb: assembleGlb(glb.json, bin), removedTriangles: total };
}
