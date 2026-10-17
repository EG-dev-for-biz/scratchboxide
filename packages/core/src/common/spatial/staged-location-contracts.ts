/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Staged location builds: the shared contracts.
 *
 * A real-world location request returns Google 3D Tiles in clay, remeshed, with measured trees regrown as SB-Veggie, and
 * for an isolated structure a scan-fitted rebuild with photo-inferred parametric detail. Every stage commits as it
 * finishes and the user watches each real result arrive in its real build order. This file is the one place the
 * SERVER (orchestrator, evidence, vision, summary), NATIVE (scan_fit, ornament builder, staged GLB writer, trees) and
 * VIEWPORT (reveal, overlay, provenance shading) workstreams agree on:
 *   - the TypeScript types: StructureFit, OrnamentSpec and the compact vision reply, the GLB node and root extras,
 *     StageEvent and StagedBuildState, DegradationRecord, the provenance records (including tile_refine's banded
 *     per-vertex provenance), the final tool result, and the native <-> server interfaces;
 *   - STAGED_LOCATION_SCHEMA, the draft-07 JSON Schema the native writers and the server validate against;
 *   - validateContract(name, value), an in-repo validator for exactly the schema subset used here (no dependency);
 *   - the decisions every workstream must apply the same way: the degrade ladder, the provenance labels and legend,
 *     the vision model, the Street View limit, the photo-correction tolerance, and the summary rules.
 *
 * Adaptive Domain Architecture. The only closed unions are execution contracts that say how geometry is made or how a
 * run proceeds, never what a structure depicts: the four geometric operators, the chart axes, lifecycle statuses and
 * chart parametrisations. Every descriptive string (labels, reason codes, reveal kinds, provenance labels, legend
 * patterns) is an open literal `'…' | (string & {})`, and nothing executes on it: code reads continuous fields and
 * positional parameter indices. A correction names its parameter by index, never by a name such as "riseToSpan".
 *
 * User decisions (2026-10-15) applied here:
 *   - Degrade, don't fabricate. A failing part drops one rung to a simpler version of the same real data
 *     (STAGED_DEGRADE_LADDER). A failed tree stage puts the scanned trees back, labelled as scanned. Hard failure only
 *     when there is no real data (an unresolved place, no tile coverage).
 *   - tile_refine's photo relief stays on by default (TILE_REFINE_RELIEF_DEFAULT) and is shaded photo-inferred.
 *   - Facade detail is read by gemini-4-argon at thinking LOW, chosen without a benchmark, with any fallback visible.
 *   - At most 4 Street View images per building, only through StreetViewGroundingImageService, decoded in memory and
 *     never written to disk; pano ids may be stored.
 *   - Photo corrections stay within 0.31 m of the scan (PHOTO_CORRECTION_TOLERANCE_M).
 *   - Trees are labelled "grown to the measured crown"; photo-read detail "photo-inferred"; corrections "photo-corrected".
 */

import type { LocationClayTrees } from '../../node/3d-engine/location-clay-pipeline';
import type { TexturePassRecord } from './texture-pass-contracts';

// =============================================================================
// Decisions shared by every workstream
// =============================================================================

/** Largest change a photo correction may make to a fitted surface, measured as scan residual rms (m). User decision. */
export const PHOTO_CORRECTION_TOLERANCE_M = 0.31;

/** Street View images per building, all fetched through StreetViewGroundingImageService (Maps Imagery Grounding API). */
export const MAX_STREET_VIEW_IMAGES_PER_BUILDING = 16;
/** Faces of one structure that are surveyed (the survey takes a ring of views of each, up to the image budget). */
export const MAX_SURVEY_FACES = 4;

/** tile_refine's photometric relief stays on: it is gated (confirmed patterns only) and labelled inferred (906a62d4). */
export const TILE_REFINE_RELIEF_DEFAULT = true;

/** The vision model for facade detail. A fallback is recorded in VisionModelUse.skipped and shown, never hidden. */
export const STAGED_VISION_MODEL_DEFAULT = {
    model: 'gemini-4-argon',
    thinking: { level: 'LOW' },
    selection: 'user decision 2026-10-15: gemini-4-argon at thinking LOW, chosen without a benchmark'
} as const;

// =============================================================================
// §3.1 Common types
// =============================================================================

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** A box on an image as sent to the model, in Gemini's box convention: [y0, x0, y1, x1], each 0..1000 of height or width. */
export type Box1000 = [number, number, number, number];

/** Right-handed orthonormal frame in the tile frame (x = east, y = up, z = south; metres). */
export interface Frame3 { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 }

/** Area-weighted distance statistics (metres). */
export interface ResidualStats {
    rmsM: number; p50M: number; p95M: number; maxM: number;
    samples: number; areaM2: number;
    /** Share of the sample area inside the inlier band. */
    inlierFraction?: number;
    /** Share of the exposed surface backed by scan samples. */
    supportFraction?: number;
}

export interface GateResult {
    /** Diagnostic name, e.g. "scan→fit rms". */
    gate: string;
    value: number; threshold: number; comparison: '<=' | '>='; passed: boolean;
    /** "m", "ratio", "m2", "deg". */
    unit: string;
}

/**
 * Legend key of a piece of geometry. Nothing branches on it; colours and patterns come from
 * StagedBuildState.provenanceLegend (defaults in DEFAULT_PROVENANCE_LEGEND).
 */
export type ProvenanceLabel =
    | 'as-scanned' | 'scan-flattened' | 'remeshed' | 'fitted' | 'fitted-unobserved'
    | 'photo-corrected' | 'photo-inferred' | 'grown to the measured crown' | (string & {});

/** The canonical labels, so no workstream re-types one. */
export const PROVENANCE = {
    /** Google tile triangles as downloaded: raw tiles, pass-through regions, crowns kept as scanned, the scanned trees put back. */
    asScanned: 'as-scanned',
    /** The raw scan with vertices within 0.10 m of a fitted plane moved onto it (the remesh rung). Nothing added. */
    scanFlattened: 'scan-flattened',
    /** tile_refine output; per vertex it is refined by tile_refine's own attributes (classifyRemeshVertex). */
    remeshed: 'remeshed',
    /** A fitted surface backed by scan samples (supportFraction >= 0.5), with residuals. */
    fitted: 'fitted',
    /** A face the fit placed where the scan has no samples; measuredGeometry false, confidence = support fraction. */
    fittedUnobserved: 'fitted-unobserved',
    /** A fitted primitive whose parameter vision changed inside the scan-admissible range. */
    photoCorrected: 'photo-corrected',
    /** Detail read from photos, with a confidence, kept only if its evidence shows and resolves it. */
    photoInferred: 'photo-inferred',
    /** A scanned lump smoothed (Taubin) with no vertex moved further than the scan's own tolerance: the rung under a figure read from a photo. Nothing added. */
    smoothedScan: 'smoothed-scan',
    /** SB-Veggie trees: stem, crown extent and height measured from the tiles, branching grown inside that crown. */
    grownToMeasuredCrown: 'grown to the measured crown'
} as const;

/** Labels whose geometry is not scan measurement: their ProvenanceRecord must say measuredGeometry false, with a confidence. */
export const NON_MEASURED_PROVENANCE_LABELS: readonly ProvenanceLabel[] = [
    PROVENANCE.photoInferred, PROVENANCE.photoCorrected, PROVENANCE.fittedUnobserved
];

export interface SourceRef {
    kind: 'tile-extraction' | 'tile-leaf' | 'tile-ortho' | 'streetview-grounding' | 'stage-output' | (string & {});
    /** Ids only: leaf id, ortho id, "sv:<panoId>:<h>:<p>:<fov>", stage key. Never image bytes. */
    id: string;
    note?: string;
}

export interface ProvenanceRecord {
    label: ProvenanceLabel;
    /** True when placement and extent come from scan measurement. False for photo inference and for faces the fit placed without samples. */
    measuredGeometry: boolean;
    /** In words: "scan_fit: region-grown plane, LS refine". */
    method: string;
    sources: SourceRef[];
    /** 0..1; required when measuredGeometry is false. */
    confidence?: number;
    residual?: ResidualStats;
    /** Per-run facts in words with numbers: what was closed or moved and was not in the scan. */
    note?: string;
    /** Quantities set by ratios rather than observed, with their values (trees: crown base ratio, trunk radius). */
    inferred?: Record<string, number>;
}

/** What the source can resolve. The mesh and the photo have different limits. */
export interface SourceLimits {
    /** 2.0064 on the Washington Square Arch. */
    leafGeometricErrorM: number;
    /** Median scan triangle edge: 0.69 m on the arch. */
    meshEdgeP50M: number;
    /** max(meshEdgeP50M, 0.25 × leafGeometricErrorM): 0.69 m on the arch. */
    meshResolvableM: number;
    /** 0.154 m on the arch. */
    texelM: number;
    /** 2 × texelM: 0.31 m on the arch. */
    photoResolvableM: number;
}

// =============================================================================
// Provenance legend defaults (§7.4): Okabe-Ito hues, pattern marks a variant of a kind
// =============================================================================

export interface ProvenanceLegendEntry {
    label: ProvenanceLabel;
    color: string;
    pattern: 'solid' | 'stripes' | 'dots' | (string & {});
    /** Written per run from that run's data ("remeshed: rectify moved 49% of vertices over 1 cm, max 0.43 m"). */
    description: string;
}

/** Colour and pattern per label; the per-run description is added by the server. Confidence shows as dot density, never as fading. */
export const DEFAULT_PROVENANCE_LEGEND: ReadonlyArray<Omit<ProvenanceLegendEntry, 'description'>> = [
    { label: PROVENANCE.asScanned, color: '#E69F00', pattern: 'solid' },
    { label: PROVENANCE.scanFlattened, color: '#E69F00', pattern: 'stripes' },
    { label: PROVENANCE.remeshed, color: '#56B4E9', pattern: 'solid' },
    { label: PROVENANCE.fitted, color: '#0072B2', pattern: 'solid' },
    { label: PROVENANCE.fittedUnobserved, color: '#0072B2', pattern: 'stripes' },
    { label: PROVENANCE.photoCorrected, color: '#F0E442', pattern: 'solid' },
    { label: PROVENANCE.photoInferred, color: '#CC79A7', pattern: 'dots' },
    { label: PROVENANCE.smoothedScan, color: '#E69F00', pattern: 'dots' },
    { label: PROVENANCE.grownToMeasuredCrown, color: '#009E73', pattern: 'solid' }
];

/** 2 px lines outlining degraded parts (a slot whose detail fell to the flat fitted face). */
export const DEGRADED_OUTLINE_COLOR = '#D55E00';

/** scene.background while provenance mode is on; every legend colour keeps >= 3:1 contrast against it. */
export const PROVENANCE_BACKGROUND = '#1c2026';

// =============================================================================
// tile_refine's per-vertex provenance (595978d7), read in bands, never by an exact-zero test
// =============================================================================

/**
 * The per-vertex attributes tile_refine writes on both GLBs (clay and textured). A written attribute is on every
 * primitive, so an absent attribute means "no per-vertex claim", never "as scanned". three's GLTFLoader lowercases them
 * (`_rectify_displacement`, `_proud_block`, `_relief_height`).
 */
export const TILE_REFINE_VERTEX_ATTRIBUTES = {
    /** Float metres the scan surface under the vertex was moved by rectify and facade flatten. Relief is not in it. */
    rectifyDisplacement: '_RECTIFY_DISPLACEMENT',
    /** Float code: 1 = block kept as scanned, 2 = block snapped at its own level, 0 = not a block. */
    proudBlock: '_PROUD_BLOCK',
    /** Float metres along the facade normal carved by photometric relief: inferred from the photo, never measured. */
    reliefHeight: '_RELIEF_HEIGHT'
} as const;

/** One band of a per-vertex value: minM inclusive, maxM exclusive; no maxM = no upper bound. */
export interface VertexBand {
    /** Diagnostic name; code reads minM and maxM. */
    band: string;
    minM: number;
    maxM?: number;
    label: ProvenanceLabel;
    description: string;
}

/**
 * _RECTIFY_DISPLACEMENT in bands. The seam solve nudges vertices by sub-millimetre amounts (arch: 30% exactly 0, 38%
 * under 1 mm, 49% under 1 cm; max 0.433 m), so "untouched" is a band under 1 cm, not a zero test. Every band is still
 * the remeshed surface: a vertex under 1 cm was not moved by rectify, but it is part of the remesh, not "as scanned".
 */
export const RECTIFY_DISPLACEMENT_BANDS: readonly VertexBand[] = [
    { band: 'untouched', minM: 0, maxM: 0.01, label: PROVENANCE.remeshed, description: 'moved under 1 cm by rectify and facade flatten' },
    { band: 'moved', minM: 0.01, maxM: 0.05, label: PROVENANCE.remeshed, description: 'moved 1–5 cm onto a rectified or flattened plane' },
    { band: 'reshaped', minM: 0.05, label: PROVENANCE.remeshed, description: 'moved more than 5 cm: the remesh reshaped the scan here' }
];

/** _PROUD_BLOCK codes in bands around their integer values (the relief interpolates nothing here, but a float is a float). */
export const PROUD_BLOCK_BANDS: readonly VertexBand[] = [
    { band: 'block-kept-as-scanned', minM: 0.5, maxM: 1.5, label: PROVENANCE.asScanned, description: 'a proud block tile_refine kept as scanned' },
    { band: 'block-snapped', minM: 1.5, maxM: 2.5, label: PROVENANCE.remeshed, description: 'a proud block tile_refine snapped at its own level' }
];

/**
 * |_RELIEF_HEIGHT| at or above this is a carved vertex, shaded photo-inferred with no confidence ("unrated"). Relief
 * carves features at least 3 cm proud at their centres (minProudDepth) and ramps to 0 at their edges; 1 mm separates a
 * carved vertex from float noise without testing for exact zero.
 */
export const RELIEF_HEIGHT_CARVED_MIN_M = 0.001;

/** One vertex's tile_refine attributes, each absent when the GLB does not carry it. */
export interface RemeshVertexSample { rectifyDisplacementM?: number; proudBlock?: number; reliefHeightM?: number }

/** What the viewport shades a remeshed vertex as, and why. */
export interface RemeshVertexClass { label: ProvenanceLabel; band: string }

function inBand(value: number, b: VertexBand): boolean {
    return value >= b.minM && (b.maxM === undefined || value < b.maxM);
}

/**
 * The one reading of tile_refine's per-vertex provenance, shared by viewport shading and the server's counts:
 * a carved relief vertex is photo-inferred; else a proud-block code decides; else the displacement band; else (no
 * attribute) the vertex makes no per-vertex claim and keeps its layer's label.
 */
export function classifyRemeshVertex(sample: RemeshVertexSample, layerLabel: ProvenanceLabel = PROVENANCE.remeshed): RemeshVertexClass {
    const h = sample.reliefHeightM;
    if (h !== undefined && Number.isFinite(h) && Math.abs(h) >= RELIEF_HEIGHT_CARVED_MIN_M) {
        return { label: PROVENANCE.photoInferred, band: 'relief-inferred' };
    }
    const block = sample.proudBlock;
    if (block !== undefined && Number.isFinite(block)) {
        const b = PROUD_BLOCK_BANDS.find(x => inBand(block, x));
        if (b) return { label: b.label, band: b.band };
    }
    const d = sample.rectifyDisplacementM;
    if (d !== undefined && Number.isFinite(d)) {
        const b = RECTIFY_DISPLACEMENT_BANDS.find(x => inBand(Math.abs(d), x));
        if (b) return { label: b.label, band: b.band };
    }
    return { label: layerLabel, band: 'no-per-vertex-claim' };
}

/** tile_refine's GLB asset.extras.scratchbox, in its own words (read side; tile_refine owns the format). */
export interface TileRefineAssetExtras {
    scratchbox?: {
        relief?: {
            provenance: 'inferred' | (string & {});
            source: string;
            attribute: '_RELIEF_HEIGHT';
            units: string;
            displacedVertices: number;
            maxAbsHeight_m: number;
        };
        /** Attribute name -> what it means, for every per-vertex attribute written. */
        attributes?: Record<string, string>;
    };
}

/** Per-run counts of a remeshed layer's per-vertex provenance, by band. */
export interface VertexProvenanceSummary {
    schema: 'scratchbox.vertex-provenance/1';
    /** GLB attribute names the layer carries. One not listed makes no per-vertex claim. */
    attributes: string[];
    vertices: number;
    /** _RECTIFY_DISPLACEMENT counted in RECTIFY_DISPLACEMENT_BANDS. */
    rectifyDisplacement?: { maxM: number; bands: Array<{ band: string; minM: number; maxM?: number; vertices: number }> };
    /** _PROUD_BLOCK counted in PROUD_BLOCK_BANDS. */
    proudBlocks?: { keptAsScannedVertices: number; snappedVertices: number };
    /** _RELIEF_HEIGHT: vertices carved by tile_refine's photometric relief (photo-inferred, unrated). */
    relief?: { carvedVertices: number; maxAbsHeightM: number };
}

// =============================================================================
// §3.2 The four operators (shared by StructureFit and OrnamentSpec)
// =============================================================================

/** The four universal geometric operators (AGENTS.md pillar 6). Closed by design: how geometry is made, never what it is. */
export type GeometricOperatorKind = 'sweep' | 'revolve' | 'replicate' | 'relief';

/** An explicit path C(t), t ∈ [0, 1] by arc length. Bulges: tan(θ/4) per segment, arcs in the plane normal to arcNormal. */
export interface Carrier { points: Vec3[]; bulges?: number[]; arcNormal?: Vec3; closed: boolean; lengthM: number }

/**
 * Where a sweep or a replicate runs. Ornament never re-types 3D points: it follows an edge slot's own crease, or draws a
 * polyline in its host chart. A refit moves both with the corrected primitive.
 */
export type CarrierRef =
    /** Explicit: fitter output only. */
    | { path: Carrier }
    /** Along an edge slot's crease, t by arc length; offset (u out, v up) in metres, in the section. */
    | { slot: { slotId: string; t0: number; t1: number; offset: Vec2 } }
    /** A polyline in the host chart, metres, at n = 0. */
    | { chart: { pointsUv: Vec2[]; closed: boolean } };

/** Operator 1: SE(3) sweep of a profile P(u, v) along a carrier, with scale s(t) and twist θ(t). */
export interface SweepParams {
    carrier: CarrierRef;
    /**
     * Profile in the section plane, metres. Slot carrier: u out of the surface, v up. Chart carrier: u to the left of travel
     * in the chart, v along the chart normal. Path carrier: u along the rotation-minimising axis, v along profileUp.
     */
    profile: { outer: Vec2[]; holes?: Vec2[][] };
    /** Required with a path carrier; the builder rejects its absence. */
    profileUp?: Vec3;
    /** [t, s] samples; omitted = 1. */
    scale?: Vec2[];
    /** [t, θ°] samples; omitted = 0. */
    twistDeg?: Vec2[];
    miterLimit: number;
    caps: boolean;
}

/** Operator 2: harmonic solid of revolution r(θ, z) = r(z)·(1 + A·cos(K·θ + 2π·helixTurns·z/H)). */
export interface RevolveParams {
    axisOrigin: Vec3; axisDir: Vec3;
    /** [r, z] from bottom to top, metres. */
    profile: Vec2[];
    lobes: number; lobeAmplitude: number; helixTurns: number;
    startAngleDeg: number; sweepAngleDeg: number; segments: number;
}

/** Operator 4: isoparametric normal relief Δh(u, v)·n over a region of a surface chart. */
export type ReliefHeight =
    /** + proud, − recess. */
    | { panel: { depthM: number; edgeWidthM: number; edgeProfile: Vec2[] } }
    | { grid: { cols: number; rows: number; cellM: number; originUv: Vec2; heightsM: number[] } };
export interface ReliefParams { surfaceId: string; region: { outer: Vec2[]; holes?: Vec2[][] }; height: ReliefHeight; maxEdgeM: number }

/** A seed for a replicate. A replicate never nests a replicate: a 2D lattice covers what nesting would. */
export type LeafOperatorSpec =
    | { operator: 'sweep'; sweep: SweepParams }
    | { operator: 'revolve'; revolve: RevolveParams }
    | { operator: 'relief'; relief: ReliefParams };

/** Operator 3: affine metric replicator along a carrier, or over the host chart's lattice. */
export type ReplicateDomain =
    | { along: { carrier: CarrierRef; pitchM: number; count: number; startOffsetM: number } }
    | { lattice: { originUv: Vec2; pitchUv: Vec2; counts: [number, number]; rowOffsetU: number } };
export interface ReplicateParams { seed: LeafOperatorSpec; domain: ReplicateDomain; alignToSurface: boolean }

export type OperatorSpec = LeafOperatorSpec | { operator: 'replicate'; replicate: ReplicateParams };

// =============================================================================
// §3.3 (a) StructureFit
// =============================================================================

/** A chart on a fitted surface. Plane: u, v in metres along the axes. Cylinder: u = r·θ (metres), v = z along the axis. */
export type SurfaceChart =
    | { plane: { origin: Vec3; u: Vec3; v: Vec3; normal: Vec3; extentUv: Vec2[] } }
    | { cylinder: { axisOrigin: Vec3; axisDir: Vec3; thetaZeroDir: Vec3; radiusM: number; thetaDeg: Vec2; zM: Vec2; normalSign: 1 | -1 } };

export interface FittedSurface {
    /** "s03": stable across a refit. */
    id: string;
    primitiveId: string;
    chart: SurfaceChart;
    areaM2: number;
    fit: ResidualStats;
    /** Share the scan's exterior samples see. */
    visibleFraction: number;
    /** Share of the surface with scan samples inside the inlier band. Below 0.5 the face was placed by the fit: 'fitted-unobserved'. */
    supportFraction: number;
    provenance: ProvenanceRecord;
}

/** One continuous parameter of a primitive's fit, by position. Refits and corrections name a parameter by (primitiveId, index). */
export interface FitParam {
    index: number;
    value: number;
    unit: string;
    /** Diagnostic. */
    description: string;
}

/**
 * A fit parameter photos may correct, with the scan's residual for each value. [min, max] keeps the scan residual rms
 * within toleranceM, and toleranceM never exceeds PHOTO_CORRECTION_TOLERANCE_M.
 */
export interface CorrectableParam {
    /** Index into the primitive's fitParams: what refit executes on. */
    param: number;
    /** Diagnostic only ("riseToSpan"). */
    key: string;
    value: number; min: number; max: number; unit: string; description: string;
    toleranceM: number;
    /** [value, rmsM]. */
    residualCurve: Vec2[];
}

export interface PrimitiveCorrection {
    primitiveId: string;
    param: number;
    /** Diagnostic. */
    key: string;
    from: number; to: number; confidence: number; reason: string;
    evidence: ElementEvidence[];
    check: { residualBefore: ResidualStats; residualAfter: ResidualStats; toleranceM: number; accepted: boolean; why: string };
}

export interface FittedPrimitive {
    /** "p07": stable across a refit. */
    id: string;
    /** Diagnostic ("cornice band"); never read by code. */
    label?: string;
    /** In `frame`. */
    spec: OperatorSpec;
    frame: Frame3;
    fit: ResidualStats;
    gates: GateResult[];
    accepted: boolean;
    /** 'fitted', or 'photo-corrected' once a correction is applied. */
    provenance: ProvenanceRecord;
    /** The fitter's real sequence. */
    buildOrder: number;
    surfaceIds: string[];
    parentId?: string;
    fitParams: FitParam[];
    correctable: CorrectableParam[];
    alternatives: Array<{ spec: OperatorSpec; fit: ResidualStats; why: string }>;
    correction?: PrimitiveCorrection;
}

/** Where detail may go. Slot ids are stable across a refit; a slot whose host changed is re-derived under the same id. */
export type SlotHost =
    | { surface: { surfaceId: string; regionUv: Vec2[] } }
    /** envelope: the measured section [u out, v up] that any profile swept on this edge must stay inside. */
    | { edge: { carrier: Carrier; surfaceIds: string[]; envelope: Vec2[] } };

export interface OrnamentSlot {
    /** "S12". */
    id: string;
    /** Diagnostic. */
    label?: string;
    /** The primitive it belongs to (refit re-validation). */
    primitiveId?: string;
    host: SlotHost;
    /** Extent along u (or the crease) and v. */
    sizeM: Vec2;
    bounds: { maxProudM: number; maxRecessM: number; minFeatureM: number };
}

export interface PassThroughRegion {
    id: string; triangles: number; areaM2: number; aabbMin: Vec3; aabbMax: Vec3;
    /** The box test values, or "not box-like". */
    reason: string;
    test?: Record<string, number>;
}

export interface OrthoImage {
    /** "ortho:s03". */
    id: string;
    surfaceId: string;
    /** PNG on disk (tile-derived, cacheable). */
    path: string;
    widthPx: number; heightPx: number;
    /** The ortho's pixel size (resampled). */
    gsdM: number;
    /** The photo's own texel on this surface: the native sample distance. */
    texelM: number;
    /** Chart (u, v) of pixel (0, 0); u grows right, v grows up. */
    originUv: Vec2;
    slotsDrawn: string[];
    sha256: string;
}

export interface StructureFit {
    schema: 'scratchbox.structure-fit/2';
    /** 16 hex: sha256(footprint quantised to 0.25 m + seed to 1 cm). */
    buildingId: string;
    input: { scanSha256: string; scanTriangles: number; scanSource: string; texturedSha256?: string; anchor: Vec2; refitOf?: string };
    frame: Frame3;
    ground: { normal: Vec3; offsetM: number; tiltDeg: number; rmsM: number; baseY: number };
    footprint: { outer: Vec2[]; holes?: Vec2[][]; areaM2: number };
    sourceLimits: SourceLimits;
    primitives: FittedPrimitive[];
    surfaces: FittedSurface[];
    slots: OrnamentSlot[];
    passThrough: { triangles: number; areaM2: number; regions: PassThroughRegion[] };
    metrics: {
        scanToFit: ResidualStats; fitToScan: ResidualStats; scanToFitPlusPassThrough: ResidualStats;
        /** Share of the visible scan area within 7 cm of the fitted primitives. */
        coverage: number;
        hausdorffM: number;
        /** What the remesh moved: the real relief it removed. */
        remeshToScan?: ResidualStats;
    };
    gates: GateResult[];
    accepted: boolean;
    counts: { vertices: number; triangles: number };
    outputs: { fittedGlb: string; outlinesGlb: string; passThroughGlb?: string; orthos: OrthoImage[]; reportJson: string };
    timingsMs: Record<string, number>;
}

// =============================================================================
// §3.4 (b) OrnamentSpec and the vision reply
// =============================================================================

export interface EvidenceImageRef {
    /** "ortho:s03" | "sv:<panoId>:<heading>:<pitch>:<fov>". */
    id: string;
    /** Its position in the prompt's image list; the reply cites images by this index. */
    index: number;
    kind: 'tile-ortho' | 'streetview-grounding' | (string & {});
    /** Street View: read from the image itself, never assumed. */
    widthPx: number; heightPx: number;
    /** Of the bytes sent. Street View bytes are decoded in memory only and never written anywhere. */
    sha256: string;
    /** The smallest distance the image can show on the slot: ortho = texelM; Street View = distanceM × fov(rad) / widthPx. */
    nativeSampleM: number;
    /** Tile ortho. */
    surfaceId?: string; gsdM?: number; texelM?: number;
    /** Street View (Google captures only; pano ids may be stored). */
    panoId?: string; captureDate?: string; copyright?: string;
    headingDeg?: number; pitchDeg?: number; fovDeg?: number; distanceM?: number;
    /** v1 uses the nominal pose only: registered is always false and the uncertainty is stated. */
    pose?: { eye: Vec3; registered: boolean; uncertaintyM: number; uncertaintyDeg: number };
    /** Each slot projected into this image: polygon as [y, x, y, x, …] in 0..1000, and the share of it not occluded. */
    slotsShown: Array<{ slotId: string; polygon1000: number[]; visibleFraction: number }>;
}

export interface ElementEvidence { imageId: string; box1000: Box1000 }

export interface OrnamentElement {
    /** "e014". */
    id: string;
    slotId: string;
    /** The model's words, diagnostic. */
    label?: string;
    /** In the host chart (u, v, n), metres; carriers are slot or chart refs. */
    spec: OperatorSpec;
    /** 0..1. */
    confidence: number;
    /** How depth was judged, in the model's words; diagnostic. */
    depthBasis: string;
    continuesBeyondView?: boolean;
    evidence: ElementEvidence[];
    /** The deterministic evidence checks it passed. */
    checks: {
        slotOverlap: number; minFeatureM: number; nativeSampleM: number;
        /** Set when the element was snapped to the scan-anchored geometry: the error it carried and what changed (photo-corrected). */
        anchor?: { errorM: number; toleranceM: number; changes: string[] };
    };
    /** 'photo-inferred', measuredGeometry false, confidence = element confidence. */
    provenance: ProvenanceRecord;
    buildOrder: number;
}

export interface VisionModelUse {
    /** answered: the version the API reports ("" on failure). */
    requested: string; used: string; answered: string;
    thinking: { level: 'LOW' | 'MEDIUM' | 'HIGH' } | { budget: number };
    /** Every model passed over, with why: a fallback is always visible. */
    skipped: Array<{ model: string; reason: string }>;
    backend: 'vertex' | 'api-key' | 'injected';
    ms: number; ttftMs?: number;
    promptTokens?: number; outputTokens?: number; thinkingTokens?: number;
    /** "STOP", "MAX_TOKENS", … */
    finishReason?: string;
    outcome: 'answered' | 'failed';
    /** On failure: what the last attempt returned. */
    error?: string;
    /** Why this model: STAGED_VISION_MODEL_DEFAULT.selection, or "requested". */
    selection: string;
}

export interface OrnamentSpec {
    schema: 'scratchbox.ornament-spec/2';
    buildingId: string;
    /** Of the StructureFit the elements were validated against (refit: the corrected one). */
    structureFitSha256: string;
    /** "ornament/v2". */
    promptVersion: string;
    evidence: EvidenceImageRef[];
    elements: OrnamentElement[];
    corrections: PrimitiveCorrection[];
    emptySlots: Array<{ slotId: string; reason: string }>;
    model: VisionModelUse;
    revision: { passes: 0 | 1; problems: string[] };
    dropped: Array<{ elementId: string; slotId: string; by: 'validator' | 'builder' | 'refit' | (string & {}); problems: string[] }>;
}

/** [image index, y0, x0, y1, x1], box corners in 0..1000 of the image. */
export type CompactBox = [number, number, number, number, number];
export type CompactLeafOp =
    /** Edge slot: t [t0, t1] per-mille along the crease, offset [u, v] mm. Surface slot: path [u0, v0, u1, v1, …] mm. Profile [u, v, …] mm. */
    | { sweep: { t?: [number, number]; offset?: [number, number]; path?: number[]; closed?: boolean; profile: number[] } }
    /** At [u, v] mm in the chart, about chart axis n, u or v; profile [r, z, …] mm, z along the axis from the surface. */
    | { revolve: { at: [number, number]; axis: 'n' | 'u' | 'v'; profile: number[]; lobes?: number; lobeAmp?: number; sweepDeg?: number } }
    /** Region box [u0, v0, u1, v1] mm or poly [u, v, …] mm; depth mm (+ proud, − recess); edge width mm; or a grid ≤ 12 × 12. */
    | {
        relief: {
            box?: [number, number, number, number]; poly?: number[]; depth?: number; edge?: number; edgeProfile?: number[];
            grid?: { cols: number; rows: number; cell: number; heights: number[] };
        };
    };
export type CompactOp =
    | CompactLeafOp
    /** along: [t0 per-mille, pitch mm, count] on the slot's crease. grid: [u0, v0, pitchU, pitchV, countU, countV, rowOffsetU] mm. */
    | { replicate: { seed: CompactLeafOp; along?: [number, number, number]; grid?: [number, number, number, number, number, number, number] } };
export interface CompactElement {
    slot: string;
    op: CompactOp;
    /** 0..100. */
    conf: number;
    /** ≤ 80 chars. */
    depthBasis: string;
    /** 1..3. */
    ev: CompactBox[];
    /** ≤ 40 chars, diagnostic. */
    label?: string;
    beyondView?: boolean;
}
/** The reply the vision model writes (prompt ornament/v2): compact, slot-relative, integer millimetres, never 3D points. */
export interface VisionOrnamentReply {
    /** ≤ 60, and ≤ 6 per slot (the slot cap is checked by the server). */
    elements: CompactElement[];
    /** ≤ 4. */
    corrections: Array<{ prim: string; param: number; to: number; conf: number; why: string; ev: CompactBox[] }>;
    emptySlots: Array<{ slot: string; why: string }>;
}

// =============================================================================
// §3.5 (c) GLB extras and vertex attributes
// =============================================================================

/**
 * Node extras of a staged layer GLB. GLB bytes are run-independent: they hold only what the generator knows (stage,
 * provenance, build order, ids). Anything that depends on a run lives in StagedLayer. A node without extras.sb (tile_refine's
 * own GLB) inherits StagedLayer.provenance and reveals as one unit.
 */
export interface StagedNodeExtras {
    sb: {
        schema: 'scratchbox.staged-node/2';
        /** Stage id that produced it ("fit"). */
        stage: string;
        provenance: ProvenanceRecord;
        /** Position in the stage's real build sequence, 0-based. */
        buildOrder: number;
        buildCount: number;
        /** Diagnostic. */
        revealKind: 'appear' | 'crossfade' | 'outline' | 'sweep' | 'cells' | 'rise' | 'grow' | (string & {});
        reveal: {
            /** '_REVEAL' when vertices carry it: VEC2 UNSIGNED_SHORT normalised; x = item order in the node, y = order inside the item. */
            attribute: '_REVEAL' | null;
            /** '_DISP' when vertices carry it: VEC3 FLOAT, metres, host-surface-to-final displacement, scaled 0 → 1 as the item reveals. */
            displacement: '_DISP' | null;
            /** This node's share of the layer's reveal time (0..1]. */
            durationShare: number;
        };
        /** Moldings: t = arc length / carrierLengthM. */
        sweep?: { carrierLengthM: number; closed: boolean; tAttribute: '_REVEAL.y' };
        ids: { primitiveId?: string; surfaceId?: string; slotId?: string; elementId?: string; crownId?: number; leafId?: string; degradationId?: string };
        /** A recut copy of a surface (recessed relief) hides the surface node it replaces. */
        replacesSurfaceIds?: string[];
        fitError?: ResidualStats;
        counts: { vertices: number; triangles: number; lines?: number };
    };
}

/** Root extras of a staged layer GLB; the crawler's frame extras are kept beside it. */
export interface StagedGlbRootExtras { sb: { schema: 'scratchbox.staged-glb/2'; stage: string; stageKey: string; buildingId?: string; frame: string } }

// =============================================================================
// Tree LOD structure of the trees GLB (SB-Veggie)
// =============================================================================

/** Detail level of one tree: 0 near (instanced leaf clusters), 1 mid (same cluster positions, fewer larger leaves), 2 far (blob masses). */
export type TreeLodLevel = 0 | 1 | 2;

/** Node extras `sbLod` of each of the three children of a tree node. Distances are metres from the camera; fadeM is the dither band. */
export interface TreeLodExtras { level: TreeLodLevel; minDistM: number; maxDistM: number; fadeM: number; triangles: number; instanced: boolean }

/** Node extras `sbCluster` of an EXT_mesh_gpu_instancing leaf-cluster node (a child of a level-0/1 node): which shared mesh it instances and its hash seed for the dither. */
export interface TreeClusterExtras { clusterMesh: string; hashSeed: number }

/** Leaf blade length (m) = clamp(sizeRatio * crownHeightM, minM, maxM). Continuous, so it scales with the tree. */
export interface TreeLeafSizeModel { sizeRatioToCrownHeight: number; minM: number; maxM: number }

/** One shared cluster mesh: how many leaves it holds at level 0 and level 1. */
export interface TreeClusterVariant { mesh: string; leavesLevel0: number; leavesLevel1: number }

/** Node extras `sbTree` of each tree node. Carries no species or measured claim for leaves. */
export interface TreeNodeExtras { id: number; hashSeed: number; label: string }

/** Root extras `sbTrees` of the trees GLB. psiSeason 0..1 scales leaf density (0 bare winter, 1 full summer). */
export interface TreesGlbRootExtras {
    schema: 'scratchbox.trees-lod/1';
    psiSeason: number;
    clusterLibrary: { variants: TreeClusterVariant[]; leafSizeModel: TreeLeafSizeModel };
}

// =============================================================================
// §3.6 (d) StageEvent and the scene state it updates
// =============================================================================

export type StageStatus = 'pending' | 'running' | 'committed' | 'degraded' | 'skipped' | 'failed' | 'stopped';

export interface StageTimings {
    startedAtMs: number; endedAtMs?: number; ms?: number;
    cached: boolean;
    /** When the cached output was produced. */
    builtAtMs?: number;
    /** Waiting for a native build (warm-up still running, or a header changed). */
    waitedForEngineMs?: number;
    breakdownMs?: Record<string, number>;
}

export interface StagedLayer {
    /** "stg-<first 8 hex of the stage cache key>-<layer>": identical across runs and retries that reuse the output. */
    objectId: string;
    stage: string;
    /**
     * l1 tiles, l2 remesh, l3a outlines, l3b fitted body, l3c pass-through, l4 detail, l5 trees; a refit adds l3ar / l3br;
     * l5x is the scanned trees put back after a failed tree stage (as-scanned).
     */
    layer: string;
    /** Canonical display order. */
    order: number;
    /** objects[].content.durableUri. */
    url: string;
    bytes: number;
    /** Default for nodes without extras.sb. */
    provenance: ProvenanceRecord;
    provenanceLabels: ProvenanceLabel[];
    /** tile_refine's per-vertex provenance counted in bands (the remesh layer only). */
    vertexProvenance?: VertexProvenanceSummary;
    /** Object ids hidden (kept loaded) once this layer's reveal ends. */
    supersedes: string[];
    /** Object ids that must finish revealing first: a real data dependency. */
    revealAfter: string[];
    reveal: {
        durationMs: number;
        /** 0..1: share of the time spent staggering items rather than growing inside one. */
        stagger: number;
        /** Object ids that fade out as this fades in. */
        crossfadeFrom: string[];
        /** Sidecar JSON {leafId: rank}: L1's download order, not in the GLB bytes. */
        orderUrl?: string;
        /** Refit: only these animate; every other node starts revealed. */
        only?: { primitiveIds: string[] };
    };
    cached: boolean;
    builtAtMs: number;
    /** Removed from objects[] at finish to free memory. */
    retired?: boolean;
    counts: { vertices: number; triangles: number };
    /**
     * The textured twin of this layer from the background texture pass (texture-pass-contracts.ts): the same node names
     * and byte-identical positions, plus TEXCOORD_0, a de-lit photo albedo and the per-texel confidence plane. The
     * viewport keeps the clay layer mounted and shows the twin only when the material mode is 'textured'.
     */
    textured?: StagedTexturedVariant;
}

/** A cached textured variant of a staged layer (the texture pass's output for that layer). */
export interface StagedTexturedVariant {
    url: string;
    bytes: number;
    /** Layer-level rung (TEXTURE_LADDER_RUNGS): the worst rung holding more than 10 percent of the layer's texels. */
    ladderRung: number;
    /** Share of the layer's atlas texels per rung, indexed like TEXTURE_LADDER_RUNGS (sums to 1). */
    rungShares: number[];
    /** The provenance entries of the layer's texels (labels and sources are open strings). */
    provenance: Array<{ source: string; label: string; method: string; panoIds?: string[]; coverage: number }>;
    /** What the confidence image's channels mean. */
    confidenceChannels: string;
    builtAtMs: number;
    cached: boolean;
}

export interface ScenePatch { upsertObjects: string[]; removeObjects: string[]; supersede: Array<{ objectId: string; by: string }> }

export interface StageSummary {
    stage: string;
    /** Canonical display order (stages with no layer: -1). */
    order: number;
    /** Overlay title: "Scan-fitted rebuild". */
    title: string;
    /** Overlay source line: "scan_fit: 23 primitives fitted to 2,616 scan triangles, 3.2 cm rms". */
    source: string;
    status: StageStatus;
    /** skipped / failed / degraded, one sentence. */
    reason?: string;
    layerIds: string[];
    timings: StageTimings;
    degradationIds: string[];
    /** Images, vision calls and seconds this stage spent (stages that spend any). */
    cost?: StageCost;
}

/** Isolated structure: which structure was picked, and how far it is from the geocoded point. */
export interface StructurePick {
    buildingId?: string;
    seed: Vec2;
    geocodeToStructureM: number;
    footprintAreaM2: number;
    extractionRadiusM: number;
    containmentRounds: number;
    isolateIoU?: number;
}

/** Scene3DData.stagedBuild: what the viewport reads to reveal, label and shade. */
export interface StagedBuildState {
    schema: 'scratchbox.staged-build/2';
    /** 8 hex. */
    runId: string;
    requestKey: string;
    /** "scene-stg-<runId>" or the active scene's id: never ends in a run of 10 or more digits. */
    artifactId: string;
    /** `alternatives`: other distinct places Google found for the same text, present only when it was ambiguous. */
    place: { query: string; resolvedAddress: string; lat: number; lng: number; alternatives?: Array<{ name?: string; formattedAddress: string; lat: number; lng: number; placeId?: string; userRatingCount?: number }> };
    structure?: StructurePick;
    runState: 'running' | 'finished' | 'stopped' | 'failed' | 'interrupted';
    /** Server clock at the last artifact emission. */
    updatedAtMs: number;
    stages: StageSummary[];
    layers: StagedLayer[];
    degradations: DegradationRecord[];
    /** Colour, pattern and a per-run description per label. */
    provenanceLegend: ProvenanceLegendEntry[];
    /** Also on failure (outcome 'failed'). */
    visionModel?: VisionModelUse;
    /** The draft survey's materials and measured colours (photo-inferred hints; clay stays one grey). */
    materialHints?: MaterialHints;
    /** "Map data ©Google", "Street View ©Google". */
    attribution: string[];
    /** Stages that can be retried from this run. */
    retry?: { retryRunId: string; stages: string[] };
    /** How the staged layers are drawn: 'clay' (default, the first result) or 'textured' (each layer's textured twin where it has one). Open. */
    materialMode?: 'clay' | 'textured' | (string & {});
    /** The background texture pass: its progress and per-layer outcome, while it runs and after. */
    texturePass?: StagedTexturePassState;
}

/** The texture pass as the viewport and the model see it. */
export interface StagedTexturePassState {
    status: 'pending' | 'running' | 'committed' | 'degraded' | 'skipped' | 'failed' | 'stopped';
    /** Layers with a textured twin published, of the layers the pass works on. */
    layersDone: number;
    layersTotal: number;
    /** Share of all atlas texels per rung over every textured layer (TEXTURE_LADDER_RUNGS order). */
    rungShares?: number[];
    message?: string;
}

/** Streamed during the run on the chat SSE as GeminiStreamEvent.stageEvent. */
export interface StageEvent {
    schema: 'scratchbox.stage-event/2';
    runId: string;
    /** Strictly increasing per run. */
    seq: number;
    stage: string; order: number; status: StageStatus;
    title: string; source: string;
    progress?: number; message?: string;
    /** On commit and degrade; the same event carries the artifact. */
    patch?: ScenePatch;
    layers?: StagedLayer[];
    degradations: DegradationRecord[];
    timings: StageTimings;
    model?: VisionModelUse;
}

// =============================================================================
// §3.7 (e) DegradationRecord and the degrade ladder
// =============================================================================

export interface DegradationRecord {
    /** Deterministic: "d-fit-gate", "d-el-e014". */
    id: string;
    stage: string;
    part: {
        description: string; buildingId?: string; primitiveId?: string; surfaceId?: string; slotId?: string;
        elementId?: string; crownId?: number; objectId?: string;
    };
    /** "photo-inferred detail". */
    intended: string;
    /** "the flat fitted face": the same real data, one rung down. */
    fellTo: string;
    provenanceAfter: ProvenanceLabel;
    /** Open diagnostic: "vision_unavailable", "not_resolvable_in_evidence", "isolate_mismatch", … */
    reasonCode: string;
    /** One user-facing sentence. */
    reason: string;
    cause?: { error: string; at: string };
    /** Vision failures: the model and thinking level that were tried. */
    model?: VisionModelUse;
    /** A retry may succeed (network, quota, model, timeout). */
    transient: boolean;
    /** Retry this stage alone from this run: the tool resolves everything else from the run record. */
    retry?: { tool: 'google_3d_tiles_get_clay'; args: { retryRunId: string; retryStage: string }; reuses: string[] };
    atMs: number;
}

/** One rung of the degrade ladder: what a failing part falls to. */
export interface DegradeRung {
    stage: string;
    /** What fails, in words. */
    failure: string;
    /** One rung down on the same real data; null = hard failure, because no real data exists to show. */
    fellTo: string | null;
    /** The label the part carries afterwards (null with a hard failure). */
    provenanceAfter: ProvenanceLabel | null;
    /** The record's default reason code (open diagnostic). */
    reasonCode: string;
}

/**
 * The degrade ladder (user decision: degrade, don't fabricate). Every rung is a simpler version of the same real data,
 * and a later failure never removes a committed stage. Hard failures are only the two cases with no real data.
 */
export const STAGED_DEGRADE_LADDER: readonly DegradeRung[] = [
    { stage: 'resolve', failure: 'the place cannot be resolved', fellTo: null, provenanceAfter: null, reasonCode: 'place_unresolved' },
    { stage: 'tiles', failure: 'no Photorealistic 3D Tiles coverage at the place', fellTo: null, provenanceAfter: null, reasonCode: 'no_tile_coverage' },
    { stage: 'tiles', failure: 'no structure of 3 m or more stands within 30 m of the anchor', fellTo: 'the remeshed area around the anchor, without a rebuild', provenanceAfter: PROVENANCE.remeshed, reasonCode: 'no_structure_at_anchor' },
    { stage: 'tiles', failure: 'the canopy mask fails', fellTo: 'the structure picked on the unmasked surface model', provenanceAfter: PROVENANCE.asScanned, reasonCode: 'canopy_not_masked' },
    { stage: 'tiles', failure: 'the structure still touches the extraction edge after 3 rounds or at 150 m', fellTo: 'the remeshed district around it, without a rebuild', provenanceAfter: PROVENANCE.remeshed, reasonCode: 'containment_failed' },
    { stage: 'trees-measure', failure: 'strip fails', fellTo: "the scan's own trees, left in the remeshed scan", provenanceAfter: PROVENANCE.remeshed, reasonCode: 'trees_not_measured' },
    { stage: 'remesh', failure: 'tile_refine fails or times out', fellTo: 'the raw scan with its facades flattened, its scanned trees kept in it', provenanceAfter: PROVENANCE.scanFlattened, reasonCode: 'remesh_failed' },
    { stage: 'remesh', failure: 'flattening the raw scan fails too', fellTo: 'the raw scan as downloaded', provenanceAfter: PROVENANCE.asScanned, reasonCode: 'flatten_failed' },
    { stage: 'remesh', failure: "tile_refine's isolated structure is not the one picked (IoU < 0.7)", fellTo: 'the remeshed scan, without a rebuild', provenanceAfter: PROVENANCE.remeshed, reasonCode: 'isolate_mismatch' },
    { stage: 'fit', failure: 'scan_fit fails or its global gate fails', fellTo: 'the remeshed scan', provenanceAfter: PROVENANCE.remeshed, reasonCode: 'fit_rejected' },
    { stage: 'fit', failure: 'a primitive gate fails, or a residual slab is not box-like', fellTo: 'that region as scanned (pass-through)', provenanceAfter: PROVENANCE.asScanned, reasonCode: 'pass_through' },
    { stage: 'survey', failure: 'Street View is not configured, or no Google pano looks at any face, or every survey image fails', fellTo: 'no survey: the detail passes aim at the scan-only slots', provenanceAfter: PROVENANCE.photoInferred, reasonCode: 'no_street_view' },
    { stage: 'survey', failure: 'the one vision call times out, is invalid, or the model chain is exhausted', fellTo: 'no survey: the detail passes aim at the scan-only slots', provenanceAfter: PROVENANCE.photoInferred, reasonCode: 'survey_failed' },
    { stage: 'survey', failure: 'a face has no Google pano looking at it, or its image does not arrive', fellTo: 'that face is left out of the survey and reported', provenanceAfter: PROVENANCE.photoInferred, reasonCode: 'face_not_surveyed' },
    { stage: 'evidence', failure: 'Street View is not configured, has no Google pano, or every fetch fails', fellTo: 'detail read from the tile photos only', provenanceAfter: PROVENANCE.photoInferred, reasonCode: 'no_street_view' },
    { stage: 'vision', failure: 'the model chain is exhausted, the reply is invalid twice, or the call times out', fellTo: 'the flat fitted face', provenanceAfter: PROVENANCE.fitted, reasonCode: 'vision_unavailable' },
    { stage: 'vision', failure: 'an element is not shown or not resolved by the image it cites', fellTo: 'the flat fitted face', provenanceAfter: PROVENANCE.fitted, reasonCode: 'not_resolvable_in_evidence' },
    { stage: 'figures', failure: 'a figure has no Google pano that sees it, its crop does not arrive, or the vision model gives no usable spec', fellTo: 'the scanned lump smoothed inside the scan tolerance, labelled smoothed scan', provenanceAfter: PROVENANCE.smoothedScan, reasonCode: 'figure_smoothed' },
    { stage: 'figures', failure: 'the lump cannot be smoothed either, or the figures stage fails', fellTo: 'the scanned lump as scanned', provenanceAfter: PROVENANCE.asScanned, reasonCode: 'figure_not_smoothed' },
    { stage: 'detail', failure: 'the ornament build fails, or drops an element', fellTo: 'the flat fitted face', provenanceAfter: PROVENANCE.fitted, reasonCode: 'detail_failed' },
    { stage: 'trees', failure: 'a measured crown cannot regrow', fellTo: 'that tree kept as scanned', provenanceAfter: PROVENANCE.asScanned, reasonCode: 'not_regrowable' },
    { stage: 'trees', failure: 'the tree stage fails', fellTo: 'the scanned trees put back', provenanceAfter: PROVENANCE.asScanned, reasonCode: 'trees_failed' }
];

// =============================================================================
// §3.8 (f) The final tool result, its digest and its summary sentence
// =============================================================================

export interface StagedLocationResult {
    /** Real data was mounted; with none, the tool throws a hard failure instead. */
    success: true;
    status: 'complete' | 'degraded' | 'stopped';
    place: { query: string; resolvedAddress: string; lat: number; lng: number; elevationM?: number; alternatives?: Array<{ name?: string; formattedAddress: string; lat: number; lng: number; placeId?: string; userRatingCount?: number }> };
    structure?: StructurePick;
    extraction: {
        requestedRadiusM?: number; radiusM: number;
        sizedTo: 'structure' | 'request' | 'district-fallback';
        leafTiles: number; cached: boolean; ageDays?: number;
        geometricErrorM: number; texelM: number; attribution: string[];
    };
    stages: StageSummary[];
    degradations: DegradationRecord[];
    provenance: Array<{ label: ProvenanceLabel; objects: number; triangles: number; areaM2?: number }>;
    /** tile_refine's per-vertex provenance on the remesh, in bands (relief vertices are photo-inferred). */
    remeshVertexProvenance?: VertexProvenanceSummary;
    structureFit?: {
        buildingId: string; accepted: boolean; primitives: number;
        scanToFitRmsM: number; fitToScanRmsM: number; coverage: number;
        passThroughAreaM2: number; unobservedFaceAreaM2: number;
        gates: GateResult[]; corrections: PrimitiveCorrection[]; reportPath: string;
    };
    ornament?: {
        /** The elements BUILT and committed to the detail layer (what is visible); 0 when the detail build did not commit a layer. */
        elements: number; slotsFilled: number; slotsEmpty: number;
        /** The elements the reading kept after its checks, whether or not they were then built. */
        read?: number;
        confidence: { min: number; median: number; max: number };
        /** streetView ≤ MAX_STREET_VIEW_IMAGES_PER_BUILDING. */
        evidence: { tileOrthos: number; streetView: number };
        model: VisionModelUse; revisionPass: boolean; dropped: number; specPath: string;
        /** What the scan-anchoring snapped or clipped (photo-corrected inside the 0.31 m tolerance), with the error each carried. */
        anchoring?: Array<{ elementId: string; slotId: string; kind: string; errorM: number; toleranceM: number; note: string }>;
        /** The survey's elements placed on the fitted slots by casting their image boxes, and the narrow crops that followed. */
        surveyLocated?: { elements: number; unlocated: number; slots: number; crops: number };
        /** Which fitted slots the reading was asked about: only those on an open exterior face that an image shows. */
        slotsOffered?: { offered: number; total: number; hidden: number; unseen: number; exposureJudged: boolean };
        /** How the Street View poses were registered: the disagreement of the matched pairs before and after, per pano, and any pano set aside as implausible. */
        registration?: { pairs: number; used: number; beforeRmsM: number; afterRmsM: number; perPano: Array<{ panoId: string; pairs: number; beforeRmsM: number; afterRmsM: number; dxM: number; dzM: number; dyawDeg: number; dpitchDeg: number }>; setAside: Array<{ panoId: string; reason: string }> };
        /** The targeted second pass: repeating runs and bands read again alone from narrow crops. */
        runReadings?: { targets: number; read: number; elements: number; replaced: number; skipped: Array<{ id: string; kind: string; slotId?: string; reason: string }> };
    };
    /** The draft survey's materials and measured colours. */
    /** The background texture pass (textured twins of the staged layers), when it ran. */
    texturePass?: TexturePassRecord;
    materialHints?: MaterialHints;
    figures?: FigureRecord[];
    /** Street View images, vision calls and seconds, in all and per stage. */
    photoCost?: { total: StageCost; byStage: Record<string, StageCost> };
    /** trees-fix's summary; its trees are labelled "grown to the measured crown". */
    trees?: LocationClayTrees;
    complexityGate: { passed: boolean; totalVertices: number; totalTriangles: number; violations: string[]; exemptions: string[] };
    sourceLimits: SourceLimits;
    timingsMs: { total: number; firstVisual: number; byStage: Record<string, number> };
    cache: Record<string, 'hit' | 'miss' | 'bypassed'>;
    /** The scene artifact (CanvasArtifact), as mounted. */
    artifact: unknown;
    /** ≤ 200 chars, used as the card's summaryResult: the part chat history keeps. */
    digest: string;
    summary: string;
}

/** Limits the summary, the digest and the model's context line keep. */
export const STAGED_SUMMARY_LIMITS = {
    /** Chat history keeps 200 characters of a card's summaryResult. */
    digestMaxChars: 200,
    /** stagedBuildContext's line ahead of the 5,000-character scene summary. */
    contextLineMaxChars: 1500,
    /** Degraded parts written out one sentence each; the rest are "and N more (listed in degradations)". */
    degradedPartsWrittenOut: 5
} as const;

/** Words the summary never uses for photo-inferred detail (rule 3). */
export const PHOTO_INFERRED_FORBIDDEN_WORDS: readonly string[] = ['measured', 'accurate', 'real'];

/** Quality adjectives the summary never uses (rule 12). */
export const SUMMARY_FORBIDDEN_ADJECTIVES: readonly string[] = ['photorealistic', 'perfect', 'high-fidelity'];

/** The summary rules staged-summary.ts implements; its test has one case per rule id. */
export const STAGED_SUMMARY_RULES: ReadonlyArray<{ id: string; rule: string }> = [
    { id: 'digest', rule: 'The digest (≤ 200 characters) leads with the status and any degradations, then the retry handle (retryRunId and stage).' },
    { id: 'mounted', rule: 'Lead with what is mounted and from what: the place, its distance from the geocoded point, the layers, the fit residual and coverage, the area placed by the fit without scan samples, and the photo-inferred detail count.' },
    { id: 'evidence-and-model', rule: 'Name the evidence (tile-photo views, Street View images © Google) and the model with its thinking level and time; name any fallback and why; on a failure, name the model tried and its error.' },
    { id: 'photo-inferred-wording', rule: 'Never call photo-inferred detail "measured", "accurate" or "real": write "photo-inferred" with its confidence range, and say how many elements were dropped as not resolvable in their evidence.' },
    { id: 'corrections', rule: 'One sentence per photo correction, with the before and after scan residuals and the 0.31 m tolerance, labelled photo-corrected.' },
    { id: 'degradations', rule: 'One sentence per degraded part, what fell to what and why; at most 5, then "and N more (listed in degradations)". Pass-through regions are aggregated.' },
    { id: 'trees', rule: 'Trees use trees-fix\'s describeTreeOutcome sentence unchanged and are called "grown to the measured crown"; a failed tree stage says the scanned trees were put back, labelled as scanned.' },
    { id: 'resolution', rule: 'Two resolution facts, kept apart: what the scan resolves (median triangle edge, leaf error) and what the photo texture resolves (texel); finer detail is photo-inferred.' },
    { id: 'remesh-changes', rule: 'What the remesh changed that the scan did not hold: ground rebuilt under the structure, closures where trees were removed, real relief removed, and vertices carved by tile_refine\'s photo relief (photo-inferred).' },
    { id: 'timings-and-cache', rule: 'Total time and time per stage in seconds; which stages came from cache and when they were built.' },
    { id: 'stop', rule: 'After Stop: which stage it stopped after, what was not built, that finished stages stay in the scene, and the retryRunId.' },
    { id: 'gate-exemptions', rule: 'State any vertex-floor exemption with its basis (scan-derived layer, or a measured rebuild with its StructureFit id).' },
    { id: 'no-adjectives', rule: 'No quality adjectives ("photorealistic", "perfect", "high-fidelity"); every number carries a unit; every count matches the result fields.' }
];

// =============================================================================
// §3.9b The draft survey (pass 1) and the figures (pass 2): contracts
// =============================================================================

/** What a stage spent: images fetched, vision calls made, seconds taken. Reported per stage and in the result. */
/** `images` counts Street View images FETCHED by the stage (the billed ones); `imagesSent` counts the images a vision call was given, which may include images fetched by an earlier stage and non-fetched renders. */
export interface StageCost { images: number; visionCalls: number; seconds: number; imagesSent?: number }

/** One colour measured from the pixels of a Street View image (decoded in memory), in sRGB. */
export interface MeasuredColour { srgb: [number, number, number]; hex: string; /** Share of the face's pixels (0..1). */ share: number }

/** A face's palette: Lab k-means with CIEDE2000 merging over the image's pixels. Measured, never named by the model. */
export interface FacePalette { colours: MeasuredColour[]; method: string; pixels: number; measuredFromPhoto: true }

/**
 * An element the survey saw on one face. `kind` is an open string (the model's own word), never a closed list. Boxes are
 * [y0, x0, y1, x1] in 0..1000 of the face's image; size and pitch are ratios of the visible face, not metres (the scan
 * anchors the metres later).
 */
export interface SurveyElement {
    kind: string;
    box: [number, number, number, number];
    /** Width and height of the element over the face's visible width and height. */
    sizeRatio?: [number, number];
    repeat?: { count: number; /** Pitch over the visible face width (axis 'h') or height ('v'). */ pitchRatio: number; axis: 'h' | 'v' | 'grid' | (string & {}) };
    material: string;
    weathering: string;
    /** 0..100, the model's. */
    confidence: number;
}

export interface SurveyMaterial { description: string; weathering?: string; where?: string }

/** What the one vision call returns for one image. */
export interface SurveyFaceReply { image: number; elements: SurveyElement[]; materials: SurveyMaterial[] }
export interface FaceSurveyReply { faces: SurveyFaceReply[] }

/** One surveyed face with its measured palette. A face without a pano is listed with `skipped`. */
export interface SurveyedFace {
    faceId: string;
    /** Outward direction of the face, degrees clockwise from north. */
    headingDeg: number;
    source: 'fit' | 'footprint';
    panoId?: string;
    captureDate?: string;
    skipped?: string;
    palette?: FacePalette;
    elements: SurveyElement[];
    materials: SurveyMaterial[];
}

/**
 * The materials and colours the survey read, for the later texture and PBR steps. Clay stays one grey; these are hints,
 * labelled photo-inferred, and the palette is marked measured-from-photo. No Street View pixel is ever used as a texture.
 */
export interface MaterialHints {
    schema: 'scratchbox.material-hints/1';
    label: 'photo-inferred';
    palette: 'measured-from-photo';
    textureUse: 'none: the Street View pixels are not projected onto the model';
    faces: SurveyedFace[];
    model: VisionModelUse;
    cost: StageCost;
}

/** One figure the figures stage tried: built from a photo, or fallen one rung to the smoothed scan. */
export interface FigureRecord {
    id: string;
    outcome: 'photo-inferred' | 'smoothed-scan' | (string & {});
    reason?: string;
    boundsM: { min: Vec3; max: Vec3 };
    panoId?: string;
    confidence?: number;
}

// =============================================================================
// §3.10 (g) Native <-> server interfaces
// =============================================================================

export interface ScanFitCall { signal?: AbortSignal; onProgress?: (fraction: number, message: string) => void; timeoutMs?: number }
export interface ScanFitOutput<T> {
    value: T; path: string; dir: string; key: string; binarySha256: string;
    cached: boolean; builtAtMs: number; ms: number; waitedForEngineMs: number;
}

export interface ScanFitFitRequest extends ScanFitCall {
    /** raw_clay.glb (tile_refine isolate), or flatten's isolate of the raw scan. */
    scanGlb: string;
    /** The textured extraction, for orthos. */
    texturedGlb?: string;
    /** For metrics.remeshToScan. */
    remeshGlb?: string;
    /** The probe seed (tile frame). */
    anchor: { x: number; z: number };
    sourceLimits: SourceLimits;
}
/** A failed gate is a result (accepted: false), not an error. */
export type ScanFitFitResult = ScanFitOutput<StructureFit>;

export interface ScanFitRefitRequest extends ScanFitCall {
    fitPath: string; scanGlb: string;
    /** By parameter index, never by name. */
    set: Array<{ primitiveId: string; param: number; value: number }>;
}

export interface ScanFitOrnamentRequest extends ScanFitCall { fitPath: string; spec: OrnamentSpec; texturedGlb: string }
export interface ScanFitOrnamentResult extends ScanFitOutput<OrnamentBuildReport> { detailGlb: string }

export interface ScanFitFlattenRequest extends ScanFitCall { inputGlb: string; footprint?: Vec2[]; bandM?: number }
export interface ScanFitFlattenResult extends ScanFitOutput<FlattenStats> { glb: string }

/** ScanFitError(code, message, detail). `transient` decides the negative cache. */
export type ScanFitErrorCode =
    | 'build_failed' | 'input_unreadable' | 'no_structure' | 'invalid_output' | 'crashed' | 'timeout' | 'aborted' | (string & {});
/** Whether a scan_fit failure may succeed on a retry. An unknown code is treated as transient (never negative-cached). */
export const SCAN_FIT_ERROR_TRANSIENT = {
    /** A later build may succeed; there is no stage key to cache under. */
    build_failed: true,
    /** Negative-cached with the binary sha. */
    input_unreadable: false,
    no_structure: false,
    /** The output failed validateContract. */
    invalid_output: false,
    /** A signal other than our SIGKILL. */
    crashed: false,
    timeout: true,
    aborted: true
} as const;

export interface BuildCheck { check: string; value: number; limit: number; unit: string; message: string }
export interface OrnamentBuildReport {
    schema: 'scratchbox.ornament-build/1';
    structureFitSha256: string; ornamentSpecSha256: string;
    built: Array<{
        elementId: string; slotId: string; node: number; vertices: number; triangles: number;
        instances?: { placed: number; skippedOutside: number };
        support?: { test: string; value: number; limit: number };
    }>;
    dropped: Array<{ elementId: string; slotId: string; checks: BuildCheck[] }>;
    degradedSlots: string[];
    counts: { vertices: number; triangles: number };
    timingsMs: Record<string, number>;
}

export interface FlattenStats {
    schema: 'scratchbox.flatten-stats/1';
    inputTriangles: number; keptTriangles: number;
    isolate?: { footprintAreaM2: number; dilationM: number; droppedTriangles: number };
    planes: number; movedVertices: number; maxMoveM: number; p95MoveM: number; bandM: number;
    timingsMs: Record<string, number>;
}

/** tile_vegetation canopy: the cells strip's own classifier calls canopy, as run-lengths (first run = not canopy). */
export interface CanopyMask { schema: 'scratchbox.canopy-mask/1'; cellM: number; x0: number; z0: number; nx: number; nz: number; runs: number[]; canopyCells: number; ms: number }

/** Where strip may measure and regrow trees: a polygon in the tile frame (x east, z south), metres. CLI: --roi-json <file>. */
export interface StripRoi { schema: 'scratchbox.strip-roi/1'; polygon: Vec2[] }

// =============================================================================
// §3.9 JSON Schema (draft-07 subset)
// =============================================================================

/** The draft-07 subset validateContract implements. */
export interface JsonSchema {
    $ref?: string;
    type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
    properties?: Record<string, JsonSchema>;
    required?: readonly string[];
    additionalProperties?: boolean | JsonSchema;
    items?: JsonSchema;
    minItems?: number;
    maxItems?: number;
    enum?: readonly unknown[];
    const?: unknown;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    oneOf?: readonly JsonSchema[];
    allOf?: readonly JsonSchema[];
    if?: JsonSchema;
    then?: JsonSchema;
}

const ref = (name: string): JsonSchema => ({ $ref: `#/definitions/${name}` });
const STR: JsonSchema = { type: 'string' };
const NUM: JsonSchema = { type: 'number' };
const BOOL: JsonSchema = { type: 'boolean' };
const INT: JsonSchema = { type: 'integer' };
const NONNEG_INT: JsonSchema = { type: 'integer', minimum: 0 };
const arr = (items: JsonSchema, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'array', items, ...extra });
/** A closed object: these properties only, `required` must be present. */
const obj = (required: readonly string[], properties: Record<string, JsonSchema>, extra: Partial<JsonSchema> = {}): JsonSchema =>
    ({ type: 'object', required, additionalProperties: false, properties, ...extra });
const numberMap: JsonSchema = { type: 'object', additionalProperties: NUM };
const counts = obj(['vertices', 'triangles'], { vertices: INT, triangles: INT });

const DEFINITIONS = {
    vec2: arr(NUM, { minItems: 2, maxItems: 2 }),
    vec3: arr(NUM, { minItems: 3, maxItems: 3 }),
    box1000: arr({ type: 'number', minimum: 0, maximum: 1000 }, { minItems: 4, maxItems: 4 }),
    unit: { type: 'number', minimum: 0, maximum: 1 },
    nonneg: { type: 'number', minimum: 0 },
    polygon2: arr(ref('vec2'), { minItems: 3 }),
    region2: obj(['outer'], { outer: ref('polygon2'), holes: arr(ref('polygon2')) }),
    frame3: obj(['origin', 'x', 'y', 'z'], { origin: ref('vec3'), x: ref('vec3'), y: ref('vec3'), z: ref('vec3') }),
    residual: obj(['rmsM', 'p50M', 'p95M', 'maxM', 'samples', 'areaM2'], {
        rmsM: ref('nonneg'), p50M: ref('nonneg'), p95M: ref('nonneg'), maxM: ref('nonneg'),
        samples: NONNEG_INT, areaM2: ref('nonneg'), inlierFraction: ref('unit'), supportFraction: ref('unit')
    }),
    gate: obj(['gate', 'value', 'threshold', 'comparison', 'passed', 'unit'], {
        gate: STR, value: NUM, threshold: NUM, comparison: { enum: ['<=', '>='] }, passed: BOOL, unit: STR
    }),
    sourceRef: obj(['kind', 'id'], { kind: STR, id: STR, note: STR }),
    provenance: obj(['label', 'measuredGeometry', 'method', 'sources'], {
        label: { type: 'string', minLength: 1 }, measuredGeometry: BOOL, method: STR, sources: arr(ref('sourceRef')),
        confidence: ref('unit'), residual: ref('residual'), note: STR, inferred: numberMap
    }, {
        allOf: [
            // anything not measured carries a confidence
            { if: { required: ['measuredGeometry'], properties: { measuredGeometry: { const: false } } }, then: { required: ['confidence'] } },
            // photo inference, photo corrections and faces placed without scan samples are never measurement
            { if: { required: ['label'], properties: { label: { enum: NON_MEASURED_PROVENANCE_LABELS } } }, then: { properties: { measuredGeometry: { const: false } } } }
        ]
    }),
    sourceLimits: obj(['leafGeometricErrorM', 'meshEdgeP50M', 'meshResolvableM', 'texelM', 'photoResolvableM'], {
        leafGeometricErrorM: ref('nonneg'), meshEdgeP50M: ref('nonneg'), meshResolvableM: ref('nonneg'), texelM: ref('nonneg'),
        photoResolvableM: ref('nonneg')
    }),
    carrier: obj(['points', 'closed', 'lengthM'], {
        points: arr(ref('vec3'), { minItems: 2 }), bulges: arr(NUM), arcNormal: ref('vec3'),
        closed: BOOL, lengthM: { type: 'number', minimum: 0 }
    }),
    carrierRef: {
        oneOf: [
            obj(['path'], { path: ref('carrier') }),
            obj(['slot'], { slot: obj(['slotId', 't0', 't1', 'offset'], { slotId: STR, t0: ref('unit'), t1: ref('unit'), offset: ref('vec2') }) }),
            obj(['chart'], { chart: obj(['pointsUv', 'closed'], { pointsUv: arr(ref('vec2'), { minItems: 2 }), closed: BOOL }) })
        ]
    },
    sweep: obj(['carrier', 'profile', 'miterLimit', 'caps'], {
        carrier: ref('carrierRef'), profile: ref('region2'), profileUp: ref('vec3'),
        scale: arr(ref('vec2')), twistDeg: arr(ref('vec2')), miterLimit: { type: 'number', minimum: 1 },
        caps: BOOL
    }),
    revolve: obj(['axisOrigin', 'axisDir', 'profile', 'lobes', 'lobeAmplitude', 'helixTurns', 'startAngleDeg', 'sweepAngleDeg', 'segments'], {
        axisOrigin: ref('vec3'), axisDir: ref('vec3'), profile: arr(ref('vec2'), { minItems: 2 }),
        lobes: NONNEG_INT, lobeAmplitude: { type: 'number', minimum: 0, maximum: 1 }, helixTurns: NUM, startAngleDeg: NUM,
        sweepAngleDeg: { type: 'number', minimum: 1, maximum: 360 }, segments: { type: 'integer', minimum: 3, maximum: 512 }
    }),
    reliefHeight: {
        oneOf: [
            obj(['panel'], {
                panel: obj(['depthM', 'edgeWidthM', 'edgeProfile'], {
                    depthM: NUM, edgeWidthM: { type: 'number', minimum: 0 }, edgeProfile: arr(ref('vec2'), { minItems: 2 })
                })
            }),
            obj(['grid'], {
                grid: obj(['cols', 'rows', 'cellM', 'originUv', 'heightsM'], {
                    cols: { type: 'integer', minimum: 2, maximum: 256 }, rows: { type: 'integer', minimum: 2, maximum: 256 },
                    cellM: { type: 'number', minimum: 0.02 }, originUv: ref('vec2'), heightsM: arr(NUM)
                })
            })
        ]
    },
    relief: obj(['surfaceId', 'region', 'height', 'maxEdgeM'], {
        surfaceId: STR, region: ref('region2'), height: ref('reliefHeight'), maxEdgeM: { type: 'number', minimum: 0.02 }
    }),
    leafOperatorSpec: {
        oneOf: [
            obj(['operator', 'sweep'], { operator: { const: 'sweep' }, sweep: ref('sweep') }),
            obj(['operator', 'revolve'], { operator: { const: 'revolve' }, revolve: ref('revolve') }),
            obj(['operator', 'relief'], { operator: { const: 'relief' }, relief: ref('relief') })
        ]
    },
    replicateDomain: {
        oneOf: [
            obj(['along'], {
                along: obj(['carrier', 'pitchM', 'count', 'startOffsetM'], {
                    carrier: ref('carrierRef'), pitchM: { type: 'number', minimum: 0.01 },
                    count: { type: 'integer', minimum: 1, maximum: 400 }, startOffsetM: NUM
                })
            }),
            obj(['lattice'], {
                lattice: obj(['originUv', 'pitchUv', 'counts', 'rowOffsetU'], {
                    originUv: ref('vec2'), pitchUv: ref('vec2'),
                    counts: arr({ type: 'integer', minimum: 1, maximum: 400 }, { minItems: 2, maxItems: 2 }), rowOffsetU: NUM
                })
            })
        ]
    },
    operatorSpec: {
        oneOf: [
            ref('leafOperatorSpec'),
            obj(['operator', 'replicate'], {
                operator: { const: 'replicate' },
                replicate: obj(['seed', 'domain', 'alignToSurface'], { seed: ref('leafOperatorSpec'), domain: ref('replicateDomain'), alignToSurface: BOOL })
            })
        ]
    },
    chart: {
        oneOf: [
            obj(['plane'], {
                plane: obj(['origin', 'u', 'v', 'normal', 'extentUv'], {
                    origin: ref('vec3'), u: ref('vec3'), v: ref('vec3'), normal: ref('vec3'), extentUv: ref('polygon2')
                })
            }),
            obj(['cylinder'], {
                cylinder: obj(['axisOrigin', 'axisDir', 'thetaZeroDir', 'radiusM', 'thetaDeg', 'zM', 'normalSign'], {
                    axisOrigin: ref('vec3'), axisDir: ref('vec3'), thetaZeroDir: ref('vec3'), radiusM: { type: 'number', minimum: 0.01 },
                    thetaDeg: ref('vec2'), zM: ref('vec2'), normalSign: { enum: [1, -1] }
                })
            })
        ]
    },
    evidence: obj(['imageId', 'box1000'], { imageId: STR, box1000: ref('box1000') }),
    fitParam: obj(['index', 'value', 'unit', 'description'], { index: NONNEG_INT, value: NUM, unit: STR, description: STR }),
    correctable: obj(['param', 'key', 'value', 'min', 'max', 'unit', 'description', 'toleranceM', 'residualCurve'], {
        param: NONNEG_INT, key: STR, value: NUM, min: NUM, max: NUM, unit: STR,
        description: STR, toleranceM: { type: 'number', minimum: 0, maximum: PHOTO_CORRECTION_TOLERANCE_M }, residualCurve: arr(ref('vec2'))
    }),
    correction: obj(['primitiveId', 'param', 'key', 'from', 'to', 'confidence', 'reason', 'evidence', 'check'], {
        primitiveId: STR, param: NONNEG_INT, key: STR, from: NUM, to: NUM,
        confidence: ref('unit'), reason: STR, evidence: arr(ref('evidence'), { minItems: 1 }),
        check: obj(['residualBefore', 'residualAfter', 'toleranceM', 'accepted', 'why'], {
            residualBefore: ref('residual'), residualAfter: ref('residual'),
            toleranceM: { type: 'number', minimum: 0, maximum: PHOTO_CORRECTION_TOLERANCE_M }, accepted: BOOL, why: STR
        })
    }),
    slot: obj(['id', 'host', 'sizeM', 'bounds'], {
        id: STR, label: STR, primitiveId: STR,
        host: {
            oneOf: [
                obj(['surface'], { surface: obj(['surfaceId', 'regionUv'], { surfaceId: STR, regionUv: ref('polygon2') }) }),
                obj(['edge'], { edge: obj(['carrier', 'surfaceIds', 'envelope'], { carrier: ref('carrier'), surfaceIds: arr(STR), envelope: ref('polygon2') }) })
            ]
        },
        sizeM: ref('vec2'),
        bounds: obj(['maxProudM', 'maxRecessM', 'minFeatureM'], { maxProudM: ref('nonneg'), maxRecessM: ref('nonneg'), minFeatureM: ref('nonneg') })
    }),
    StructureFit: obj(['schema', 'buildingId', 'input', 'frame', 'ground', 'footprint', 'sourceLimits', 'primitives', 'surfaces', 'slots', 'passThrough', 'metrics', 'gates', 'accepted', 'counts', 'outputs', 'timingsMs'], {
        schema: { const: 'scratchbox.structure-fit/2' }, buildingId: { type: 'string', pattern: '^[0-9a-f]{16}$' },
        input: obj(['scanSha256', 'scanTriangles', 'scanSource', 'anchor'], {
            scanSha256: STR, scanTriangles: INT, scanSource: STR, texturedSha256: STR, anchor: ref('vec2'), refitOf: STR
        }),
        frame: ref('frame3'),
        ground: obj(['normal', 'offsetM', 'tiltDeg', 'rmsM', 'baseY'], { normal: ref('vec3'), offsetM: NUM, tiltDeg: NUM, rmsM: NUM, baseY: NUM }),
        footprint: obj(['outer', 'areaM2'], { outer: ref('polygon2'), holes: arr(ref('polygon2')), areaM2: NUM }),
        sourceLimits: ref('sourceLimits'),
        primitives: arr(obj(['id', 'spec', 'frame', 'fit', 'gates', 'accepted', 'provenance', 'buildOrder', 'surfaceIds', 'fitParams', 'correctable', 'alternatives'], {
            id: STR, label: STR, spec: ref('operatorSpec'), frame: ref('frame3'), fit: ref('residual'),
            gates: arr(ref('gate')), accepted: BOOL, provenance: ref('provenance'),
            buildOrder: NONNEG_INT, surfaceIds: arr(STR), parentId: STR,
            fitParams: arr(ref('fitParam')), correctable: arr(ref('correctable')),
            alternatives: arr(obj(['spec', 'fit', 'why'], { spec: ref('operatorSpec'), fit: ref('residual'), why: STR })),
            correction: ref('correction')
        })),
        surfaces: arr(obj(['id', 'primitiveId', 'chart', 'areaM2', 'fit', 'visibleFraction', 'supportFraction', 'provenance'], {
            id: STR, primitiveId: STR, chart: ref('chart'), areaM2: NUM, fit: ref('residual'),
            visibleFraction: ref('unit'), supportFraction: ref('unit'), provenance: ref('provenance')
        })),
        slots: arr(ref('slot')),
        passThrough: obj(['triangles', 'areaM2', 'regions'], {
            triangles: INT, areaM2: NUM,
            regions: arr(obj(['id', 'triangles', 'areaM2', 'aabbMin', 'aabbMax', 'reason'], {
                id: STR, triangles: INT, areaM2: NUM, aabbMin: ref('vec3'), aabbMax: ref('vec3'), reason: STR, test: numberMap
            }))
        }),
        metrics: obj(['scanToFit', 'fitToScan', 'scanToFitPlusPassThrough', 'coverage', 'hausdorffM'], {
            scanToFit: ref('residual'), fitToScan: ref('residual'), scanToFitPlusPassThrough: ref('residual'),
            coverage: ref('unit'), hausdorffM: NUM, remeshToScan: ref('residual')
        }),
        gates: arr(ref('gate')), accepted: BOOL,
        counts,
        outputs: obj(['fittedGlb', 'outlinesGlb', 'orthos', 'reportJson'], {
            fittedGlb: STR, outlinesGlb: STR, passThroughGlb: STR, reportJson: STR,
            orthos: arr(obj(['id', 'surfaceId', 'path', 'widthPx', 'heightPx', 'gsdM', 'texelM', 'originUv', 'slotsDrawn', 'sha256'], {
                id: STR, surfaceId: STR, path: STR, widthPx: INT, heightPx: INT, gsdM: NUM,
                texelM: NUM, originUv: ref('vec2'), slotsDrawn: arr(STR), sha256: STR
            }))
        }),
        timingsMs: numberMap
    }),
    visionModelUse: obj(['requested', 'used', 'answered', 'thinking', 'skipped', 'backend', 'ms', 'outcome', 'selection'], {
        requested: STR, used: STR, answered: STR,
        thinking: {
            oneOf: [
                obj(['level'], { level: { enum: ['LOW', 'MEDIUM', 'HIGH'] } }),
                obj(['budget'], { budget: NONNEG_INT })
            ]
        },
        skipped: arr(obj(['model', 'reason'], { model: STR, reason: STR })),
        backend: { enum: ['vertex', 'api-key', 'injected'] }, ms: NUM, ttftMs: NUM, promptTokens: INT, outputTokens: INT,
        thinkingTokens: INT, finishReason: STR, outcome: { enum: ['answered', 'failed'] }, error: STR, selection: STR
    }),
    compactBox: arr({ type: 'integer', minimum: 0, maximum: 1000 }, { minItems: 5, maxItems: 5 }),
    compactLeafOp: {
        oneOf: [
            obj(['sweep'], {
                sweep: obj(['profile'], {
                    t: arr({ type: 'integer', minimum: 0, maximum: 1000 }, { minItems: 2, maxItems: 2 }),
                    offset: arr(INT, { minItems: 2, maxItems: 2 }),
                    path: arr({ type: 'integer', minimum: -20000, maximum: 20000 }, { minItems: 4, maxItems: 16 }), closed: BOOL,
                    profile: arr({ type: 'integer', minimum: -20000, maximum: 20000 }, { minItems: 6, maxItems: 24 })
                })
            }),
            obj(['revolve'], {
                revolve: obj(['at', 'axis', 'profile'], {
                    at: arr(INT, { minItems: 2, maxItems: 2 }), axis: { enum: ['n', 'u', 'v'] },
                    profile: arr({ type: 'integer', minimum: -20000, maximum: 20000 }, { minItems: 4, maxItems: 24 }), lobes: { type: 'integer', minimum: 0, maximum: 64 },
                    lobeAmp: { type: 'integer', minimum: 0, maximum: 1000 }, sweepDeg: { type: 'integer', minimum: 1, maximum: 360 }
                })
            }),
            obj(['relief'], {
                relief: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        box: arr(INT, { minItems: 4, maxItems: 4 }),
                        poly: arr({ type: 'integer', minimum: -20000, maximum: 20000 }, { minItems: 6, maxItems: 24 }), depth: { type: 'integer', minimum: -600, maximum: 600 },
                        edge: { type: 'integer', minimum: 0, maximum: 600 }, edgeProfile: arr({ type: 'integer', minimum: 0, maximum: 1000 }, { minItems: 4, maxItems: 16 }),
                        grid: obj(['cols', 'rows', 'cell', 'heights'], {
                            cols: { type: 'integer', minimum: 2, maximum: 12 }, rows: { type: 'integer', minimum: 2, maximum: 12 }, cell: { type: 'integer', minimum: 20, maximum: 2000 },
                            heights: arr({ type: 'integer', minimum: -600, maximum: 600 }, { minItems: 4, maxItems: 144 })
                        })
                    },
                    oneOf: [{ required: ['box'] }, { required: ['poly'] }]
                }
            })
        ]
    },
    compactElement: obj(['slot', 'op', 'conf', 'depthBasis', 'ev'], {
        slot: STR,
        op: {
            oneOf: [
                ref('compactLeafOp'),
                obj(['replicate'], {
                    replicate: obj(['seed'], {
                        seed: ref('compactLeafOp'), along: arr(INT, { minItems: 3, maxItems: 3 }),
                        grid: arr(INT, { minItems: 7, maxItems: 7 })
                    }, { oneOf: [{ required: ['along'] }, { required: ['grid'] }] })
                })
            ]
        },
        conf: { type: 'integer', minimum: 0, maximum: 100 }, depthBasis: { type: 'string', maxLength: 80 },
        ev: arr(ref('compactBox'), { minItems: 1, maxItems: 3 }), label: { type: 'string', maxLength: 40 }, beyondView: BOOL
    }),
    VisionOrnamentReply: obj(['elements', 'corrections', 'emptySlots'], {
        elements: arr(ref('compactElement'), { maxItems: 60 }),
        corrections: arr(obj(['prim', 'param', 'to', 'conf', 'why', 'ev'], {
            prim: STR, param: NONNEG_INT, to: NUM, conf: { type: 'integer', minimum: 0, maximum: 100 },
            why: { type: 'string', maxLength: 120 }, ev: arr(ref('compactBox'), { minItems: 1, maxItems: 3 })
        }), { maxItems: 4 }),
        emptySlots: arr(obj(['slot', 'why'], { slot: STR, why: { type: 'string', maxLength: 80 } }))
    }),
    evidenceImage: obj(['id', 'index', 'kind', 'widthPx', 'heightPx', 'sha256', 'nativeSampleM', 'slotsShown'], {
        id: STR, index: { type: 'integer', minimum: 0, maximum: 63 }, kind: STR, widthPx: INT, heightPx: INT,
        sha256: STR, nativeSampleM: ref('nonneg'), surfaceId: STR, gsdM: NUM, texelM: NUM, panoId: STR,
        captureDate: STR, copyright: STR, headingDeg: NUM, pitchDeg: NUM, fovDeg: NUM, distanceM: NUM,
        pose: obj(['eye', 'registered', 'uncertaintyM', 'uncertaintyDeg'], { eye: ref('vec3'), registered: BOOL, uncertaintyM: NUM, uncertaintyDeg: NUM }),
        slotsShown: arr(obj(['slotId', 'polygon1000', 'visibleFraction'], {
            slotId: STR, polygon1000: arr(NUM, { minItems: 6 }), visibleFraction: ref('unit')
        }))
    }),
    OrnamentSpec: obj(['schema', 'buildingId', 'structureFitSha256', 'promptVersion', 'evidence', 'elements', 'corrections', 'emptySlots', 'model', 'revision', 'dropped'], {
        schema: { const: 'scratchbox.ornament-spec/2' }, buildingId: STR, structureFitSha256: STR, promptVersion: STR,
        evidence: arr(ref('evidenceImage')),
        elements: arr(obj(['id', 'slotId', 'spec', 'confidence', 'depthBasis', 'evidence', 'checks', 'provenance', 'buildOrder'], {
            id: STR, slotId: STR, label: STR, spec: ref('operatorSpec'), confidence: ref('unit'),
            depthBasis: STR, continuesBeyondView: BOOL, evidence: arr(ref('evidence'), { minItems: 1 }),
            checks: obj(['slotOverlap', 'minFeatureM', 'nativeSampleM'], { slotOverlap: ref('unit'), minFeatureM: NUM, nativeSampleM: NUM, anchor: obj(['errorM', 'toleranceM', 'changes'], { errorM: ref('nonneg'), toleranceM: ref('nonneg'), changes: arr(STR) }) }),
            provenance: ref('provenance'), buildOrder: NONNEG_INT
        })),
        corrections: arr(ref('correction')),
        emptySlots: arr(obj(['slotId', 'reason'], { slotId: STR, reason: STR })),
        model: ref('visionModelUse'),
        revision: obj(['passes', 'problems'], { passes: { enum: [0, 1] }, problems: arr(STR) }),
        dropped: arr(obj(['elementId', 'slotId', 'by', 'problems'], { elementId: STR, slotId: STR, by: STR, problems: arr(STR) }))
    }),
    buildCheck: obj(['check', 'value', 'limit', 'unit', 'message'], { check: STR, value: NUM, limit: NUM, unit: STR, message: STR }),
    OrnamentBuildReport: obj(['schema', 'structureFitSha256', 'ornamentSpecSha256', 'built', 'dropped', 'degradedSlots', 'counts', 'timingsMs'], {
        schema: { const: 'scratchbox.ornament-build/1' }, structureFitSha256: STR, ornamentSpecSha256: STR,
        built: arr(obj(['elementId', 'slotId', 'node', 'vertices', 'triangles'], {
            elementId: STR, slotId: STR, node: NONNEG_INT, vertices: INT, triangles: INT,
            instances: obj(['placed', 'skippedOutside'], { placed: INT, skippedOutside: INT }),
            support: obj(['test', 'value', 'limit'], { test: STR, value: NUM, limit: NUM })
        })),
        dropped: arr(obj(['elementId', 'slotId', 'checks'], { elementId: STR, slotId: STR, checks: arr(ref('buildCheck'), { minItems: 1 }) })),
        degradedSlots: arr(STR),
        counts,
        timingsMs: numberMap
    }),
    FlattenStats: obj(['schema', 'inputTriangles', 'keptTriangles', 'planes', 'movedVertices', 'maxMoveM', 'p95MoveM', 'bandM', 'timingsMs'], {
        schema: { const: 'scratchbox.flatten-stats/1' }, inputTriangles: INT, keptTriangles: INT,
        isolate: obj(['footprintAreaM2', 'dilationM', 'droppedTriangles'], { footprintAreaM2: NUM, dilationM: NUM, droppedTriangles: INT }),
        planes: INT, movedVertices: INT, maxMoveM: NUM, p95MoveM: NUM, bandM: NUM,
        timingsMs: numberMap
    }),
    CanopyMask: obj(['schema', 'cellM', 'x0', 'z0', 'nx', 'nz', 'runs', 'canopyCells', 'ms'], {
        schema: { const: 'scratchbox.canopy-mask/1' }, cellM: { type: 'number', exclusiveMinimum: 0 }, x0: NUM, z0: NUM, nx: { type: 'integer', minimum: 1 },
        nz: { type: 'integer', minimum: 1 }, runs: arr(NONNEG_INT), canopyCells: NONNEG_INT, ms: NUM
    }),
    StripRoi: obj(['schema', 'polygon'], { schema: { const: 'scratchbox.strip-roi/1' }, polygon: ref('polygon2') }),
    StagedNodeExtras: {
        // open at the root: the crawler's frame extras sit beside `sb`
        type: 'object', required: ['sb'],
        properties: {
            sb: obj(['schema', 'stage', 'provenance', 'buildOrder', 'buildCount', 'revealKind', 'reveal', 'ids', 'counts'], {
                schema: { const: 'scratchbox.staged-node/2' }, stage: STR, provenance: ref('provenance'), buildOrder: NONNEG_INT,
                buildCount: { type: 'integer', minimum: 1 }, revealKind: STR,
                reveal: obj(['attribute', 'displacement', 'durationShare'], {
                    attribute: { enum: ['_REVEAL', null] }, displacement: { enum: ['_DISP', null] },
                    durationShare: { type: 'number', exclusiveMinimum: 0, maximum: 1 }
                }),
                sweep: obj(['carrierLengthM', 'closed', 'tAttribute'], { carrierLengthM: { type: 'number', minimum: 0 }, closed: BOOL, tAttribute: { const: '_REVEAL.y' } }),
                ids: {
                    type: 'object', additionalProperties: false,
                    properties: { primitiveId: STR, surfaceId: STR, slotId: STR, elementId: STR, crownId: INT, leafId: STR, degradationId: STR }
                },
                replacesSurfaceIds: arr(STR), fitError: ref('residual'),
                counts: obj(['vertices', 'triangles'], { vertices: INT, triangles: INT, lines: INT })
            })
        }
    },
    StagedGlbRootExtras: {
        type: 'object', required: ['sb'],
        properties: {
            sb: obj(['schema', 'stage', 'stageKey', 'frame'], { schema: { const: 'scratchbox.staged-glb/2' }, stage: STR, stageKey: STR, buildingId: STR, frame: STR })
        }
    },
    treeLodExtras: obj(['level', 'minDistM', 'maxDistM', 'fadeM', 'triangles', 'instanced'], {
        level: { type: 'integer', minimum: 0, maximum: 2 }, minDistM: ref('nonneg'), maxDistM: ref('nonneg'), fadeM: ref('nonneg'),
        triangles: NONNEG_INT, instanced: BOOL
    }),
    treeClusterExtras: obj(['clusterMesh', 'hashSeed'], { clusterMesh: { type: 'string', minLength: 1 }, hashSeed: NONNEG_INT }),
    treeNodeExtras: obj(['id', 'hashSeed', 'label'], { id: NONNEG_INT, hashSeed: NONNEG_INT, label: { type: 'string', minLength: 1 } }),
    TreesGlbRootExtras: obj(['schema', 'psiSeason', 'clusterLibrary'], {
        schema: { const: 'scratchbox.trees-lod/1' }, psiSeason: ref('unit'),
        clusterLibrary: obj(['variants', 'leafSizeModel'], {
            variants: arr(obj(['mesh', 'leavesLevel0', 'leavesLevel1'], { mesh: { type: 'string', minLength: 1 }, leavesLevel0: NONNEG_INT, leavesLevel1: NONNEG_INT }), { minItems: 1 }),
            leafSizeModel: obj(['sizeRatioToCrownHeight', 'minM', 'maxM'], {
                sizeRatioToCrownHeight: ref('nonneg'), minM: { type: 'number', exclusiveMinimum: 0 }, maxM: { type: 'number', exclusiveMinimum: 0 }
            })
        })
    }),
    vertexProvenance: obj(['schema', 'attributes', 'vertices'], {
        schema: { const: 'scratchbox.vertex-provenance/1' }, attributes: arr(STR), vertices: NONNEG_INT,
        rectifyDisplacement: obj(['maxM', 'bands'], {
            maxM: ref('nonneg'),
            bands: arr(obj(['band', 'minM', 'vertices'], { band: STR, minM: ref('nonneg'), maxM: ref('nonneg'), vertices: NONNEG_INT }))
        }),
        proudBlocks: obj(['keptAsScannedVertices', 'snappedVertices'], { keptAsScannedVertices: NONNEG_INT, snappedVertices: NONNEG_INT }),
        relief: obj(['carvedVertices', 'maxAbsHeightM'], { carvedVertices: NONNEG_INT, maxAbsHeightM: ref('nonneg') })
    }),
    stageTimings: obj(['startedAtMs', 'cached'], {
        startedAtMs: NUM, endedAtMs: NUM, ms: NUM, cached: BOOL, builtAtMs: NUM, waitedForEngineMs: NUM,
        breakdownMs: numberMap
    }),
    stageCost: obj(['images', 'visionCalls', 'seconds'], { images: NONNEG_INT, visionCalls: NONNEG_INT, seconds: ref('nonneg'), imagesSent: NONNEG_INT }),
    measuredColour: obj(['srgb', 'hex', 'share'], { srgb: arr({ type: 'integer', minimum: 0, maximum: 255 }, { minItems: 3, maxItems: 3 }), hex: { type: 'string', pattern: '^#[0-9a-f]{6}$' }, share: ref('unit') }),
    facePalette: obj(['colours', 'method', 'pixels', 'measuredFromPhoto'], { colours: arr(ref('measuredColour')), method: STR, pixels: NONNEG_INT, measuredFromPhoto: { const: true } }),
    surveyElement: obj(['kind', 'box', 'material', 'weathering', 'confidence'], {
        kind: { type: 'string', minLength: 1, maxLength: 60 }, box: arr({ type: 'integer', minimum: 0, maximum: 1000 }, { minItems: 4, maxItems: 4 }),
        sizeRatio: arr(NUM, { minItems: 2, maxItems: 2 }),
        repeat: obj(['count', 'pitchRatio', 'axis'], { count: { type: 'integer', minimum: 2, maximum: 400 }, pitchRatio: NUM, axis: STR }),
        material: { type: 'string', maxLength: 120 }, weathering: { type: 'string', maxLength: 120 }, confidence: { type: 'integer', minimum: 0, maximum: 100 }
    }),
    surveyMaterial: obj(['description'], { description: { type: 'string', minLength: 1, maxLength: 160 }, weathering: { type: 'string', maxLength: 120 }, where: { type: 'string', maxLength: 120 } }),
    FaceSurveyReply: obj(['faces'], {
        faces: arr(obj(['image', 'elements', 'materials'], {
            image: NONNEG_INT, elements: arr(ref('surveyElement'), { maxItems: 40 }), materials: arr(ref('surveyMaterial'), { maxItems: 8 })
        }), { maxItems: MAX_STREET_VIEW_IMAGES_PER_BUILDING })
    }),
    surveyedFace: obj(['faceId', 'headingDeg', 'source', 'elements', 'materials'], {
        faceId: STR, headingDeg: NUM, source: { enum: ['fit', 'footprint'] }, panoId: STR, captureDate: STR, skipped: STR,
        palette: ref('facePalette'), elements: arr(ref('surveyElement')), materials: arr(ref('surveyMaterial'))
    }),
    materialHints: obj(['schema', 'label', 'palette', 'textureUse', 'faces', 'model', 'cost'], {
        schema: { const: 'scratchbox.material-hints/1' }, label: { const: 'photo-inferred' }, palette: { const: 'measured-from-photo' },
        textureUse: STR, faces: arr(ref('surveyedFace')), model: ref('visionModelUse'), cost: ref('stageCost')
    }),
    figureRecord: obj(['id', 'outcome', 'boundsM'], {
        id: STR, outcome: STR, reason: STR, boundsM: obj(['min', 'max'], { min: ref('vec3'), max: ref('vec3') }), panoId: STR, confidence: ref('unit')
    }),
    stageStatus: { enum: ['pending', 'running', 'committed', 'degraded', 'skipped', 'failed', 'stopped'] },
    stagedLayer: obj(['objectId', 'stage', 'layer', 'order', 'url', 'bytes', 'provenance', 'provenanceLabels', 'supersedes', 'revealAfter', 'reveal', 'cached', 'builtAtMs', 'counts'], {
        objectId: { type: 'string', pattern: '^stg-[0-9a-f]{8}-[a-z0-9]+$' }, stage: STR, layer: { type: 'string', pattern: '^l[0-9][a-z0-9]*$' },
        order: INT, url: STR, bytes: NONNEG_INT, provenance: ref('provenance'), provenanceLabels: arr(STR),
        vertexProvenance: ref('vertexProvenance'),
        supersedes: arr(STR), revealAfter: arr(STR),
        reveal: obj(['durationMs', 'stagger', 'crossfadeFrom'], {
            durationMs: { type: 'number', minimum: 0 }, stagger: ref('unit'), crossfadeFrom: arr(STR), orderUrl: STR,
            only: obj(['primitiveIds'], { primitiveIds: arr(STR) })
        }),
        cached: BOOL, builtAtMs: NUM, retired: BOOL,
        counts,
        textured: obj(['url', 'bytes', 'ladderRung', 'rungShares', 'provenance', 'confidenceChannels', 'builtAtMs', 'cached'], {
            url: STR, bytes: NONNEG_INT, ladderRung: NONNEG_INT, rungShares: arr(ref('unit')), provenance: arr(ref('texelProvenance')),
            confidenceChannels: STR, builtAtMs: NUM, cached: BOOL
        })
    }),
    stageSummary: obj(['stage', 'order', 'title', 'source', 'status', 'layerIds', 'timings', 'degradationIds'], {
        stage: STR, order: INT, title: STR, source: STR, status: ref('stageStatus'), reason: STR,
        layerIds: arr(STR), timings: ref('stageTimings'), degradationIds: arr(STR), cost: ref('stageCost')
    }),
    structurePick: obj(['seed', 'geocodeToStructureM', 'footprintAreaM2', 'extractionRadiusM', 'containmentRounds'], {
        buildingId: STR, seed: ref('vec2'), geocodeToStructureM: ref('nonneg'), footprintAreaM2: ref('nonneg'), extractionRadiusM: ref('nonneg'),
        containmentRounds: NONNEG_INT, isolateIoU: ref('unit')
    }),
    // texture pass (texture-pass-contracts.ts): labels and sources are open strings, nothing branches on them
    texelProvenance: obj(['source', 'label', 'method', 'coverage'], {
        source: { type: 'string', minLength: 1 }, label: { type: 'string', minLength: 1 }, method: STR,
        panoIds: arr(STR), coverage: ref('unit')
    }),
    surfaceUvMap: obj(['nodeName', 'kind', 'texelsPerMeter', 'atlasRect'], {
        nodeName: { type: 'string', minLength: 1 }, kind: STR, texelsPerMeter: { type: 'number', exclusiveMinimum: 0 },
        atlasRect: arr(ref('unit'), { minItems: 4, maxItems: 4 }), chartId: STR
    }),
    texturePassDegradation: obj(['stage', 'reasonCode', 'reason'], {
        stage: STR, reasonCode: { type: 'string', minLength: 1 }, reason: { type: 'string', minLength: 1 },
        layerKey: STR, fromRung: NONNEG_INT, toRung: NONNEG_INT, texelShare: ref('unit')
    }),
    TextureLayerBundle: obj(['layerKey', 'maps', 'uv', 'provenance', 'ladderRung', 'confidence'], {
        layerKey: { type: 'string', minLength: 1 },
        maps: obj(['albedo'], { albedo: STR, normal: STR, roughness: STR }),
        uv: arr(ref('surfaceUvMap')), provenance: arr(ref('texelProvenance'), { minItems: 1 }),
        ladderRung: NONNEG_INT, rungReason: STR, confidence: { type: 'string', minLength: 1 }
    }),
    TexturePassRecord: obj(['passVersion', 'layers', 'degradations', 'timingsMs'], {
        passVersion: { type: 'string', minLength: 1 }, layers: arr(ref('TextureLayerBundle')),
        degradations: arr(ref('texturePassDegradation')), costUsd: ref('nonneg'), timingsMs: numberMap
    }),
    DegradationRecord: obj(['id', 'stage', 'part', 'intended', 'fellTo', 'provenanceAfter', 'reasonCode', 'reason', 'transient', 'atMs'], {
        id: { type: 'string', minLength: 1 }, stage: STR,
        part: obj(['description'], {
            description: STR, buildingId: STR, primitiveId: STR, surfaceId: STR, slotId: STR, elementId: STR,
            crownId: INT, objectId: STR
        }),
        intended: STR, fellTo: { type: 'string', minLength: 1 }, provenanceAfter: { type: 'string', minLength: 1 }, reasonCode: { type: 'string', minLength: 1 },
        reason: { type: 'string', minLength: 1 },
        cause: obj(['error', 'at'], { error: STR, at: STR }),
        model: ref('visionModelUse'), transient: BOOL,
        retry: obj(['tool', 'args', 'reuses'], {
            tool: { const: 'google_3d_tiles_get_clay' },
            args: obj(['retryRunId', 'retryStage'], { retryRunId: { type: 'string', pattern: '^[0-9a-f]{8}$' }, retryStage: STR }),
            reuses: arr(STR)
        }),
        atMs: NUM
    }),
    StagedBuildState: obj(['schema', 'runId', 'requestKey', 'artifactId', 'place', 'runState', 'updatedAtMs', 'stages', 'layers', 'degradations', 'provenanceLegend', 'attribution'], {
        schema: { const: 'scratchbox.staged-build/2' }, runId: { type: 'string', pattern: '^[0-9a-f]{8}$' }, requestKey: STR,
        // resolveCanvasArtifactId re-keys an id ending in 10+ digits, which would remount the viewport at the end of the turn
        artifactId: { type: 'string', minLength: 1, pattern: '^(?![\\s\\S]*[0-9]{10}$)' },
        place: obj(['query', 'resolvedAddress', 'lat', 'lng'], { query: STR, resolvedAddress: STR, lat: NUM, lng: NUM, alternatives: arr(obj(['formattedAddress', 'lat', 'lng'], { name: STR, formattedAddress: STR, lat: NUM, lng: NUM, placeId: STR, userRatingCount: NUM })) }),
        structure: ref('structurePick'),
        runState: { enum: ['running', 'finished', 'stopped', 'failed', 'interrupted'] }, updatedAtMs: NUM, stages: arr(ref('stageSummary')),
        layers: arr(ref('stagedLayer')), degradations: arr(ref('DegradationRecord')),
        provenanceLegend: arr(obj(['label', 'color', 'pattern', 'description'], {
            label: STR, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, pattern: STR, description: STR
        })),
        visionModel: ref('visionModelUse'), materialHints: ref('materialHints'), attribution: arr(STR),
        retry: obj(['retryRunId', 'stages'], { retryRunId: { type: 'string', pattern: '^[0-9a-f]{8}$' }, stages: arr(STR) }),
        materialMode: STR,
        texturePass: obj(['status', 'layersDone', 'layersTotal'], {
            status: ref('stageStatus'), layersDone: NONNEG_INT, layersTotal: NONNEG_INT, rungShares: arr(ref('unit')), message: STR
        })
    }),
    StageEvent: obj(['schema', 'runId', 'seq', 'stage', 'order', 'status', 'title', 'source', 'degradations', 'timings'], {
        schema: { const: 'scratchbox.stage-event/2' }, runId: { type: 'string', pattern: '^[0-9a-f]{8}$' }, seq: NONNEG_INT, stage: STR, order: INT,
        status: ref('stageStatus'), title: STR, source: STR, progress: ref('unit'), message: STR,
        patch: obj(['upsertObjects', 'removeObjects', 'supersede'], {
            upsertObjects: arr(STR), removeObjects: arr(STR),
            supersede: arr(obj(['objectId', 'by'], { objectId: STR, by: STR }))
        }),
        layers: arr(ref('stagedLayer')), degradations: arr(ref('DegradationRecord')),
        timings: ref('stageTimings'), model: ref('visionModelUse')
    }),
    StagedLocationResult: obj(['success', 'status', 'place', 'extraction', 'stages', 'degradations', 'provenance', 'complexityGate', 'sourceLimits', 'timingsMs', 'cache', 'artifact', 'digest', 'summary'], {
        success: { const: true }, status: { enum: ['complete', 'degraded', 'stopped'] },
        place: obj(['query', 'resolvedAddress', 'lat', 'lng'], { query: STR, resolvedAddress: STR, lat: NUM, lng: NUM, elevationM: NUM, alternatives: arr(obj(['formattedAddress', 'lat', 'lng'], { name: STR, formattedAddress: STR, lat: NUM, lng: NUM, placeId: STR, userRatingCount: NUM })) }),
        structure: ref('structurePick'),
        extraction: obj(['radiusM', 'sizedTo', 'leafTiles', 'cached', 'geometricErrorM', 'texelM', 'attribution'], {
            requestedRadiusM: ref('nonneg'), radiusM: ref('nonneg'), sizedTo: { enum: ['structure', 'request', 'district-fallback'] },
            leafTiles: NONNEG_INT, cached: BOOL, ageDays: ref('nonneg'), geometricErrorM: ref('nonneg'), texelM: ref('nonneg'), attribution: arr(STR)
        }),
        stages: arr(ref('stageSummary')), degradations: arr(ref('DegradationRecord')),
        provenance: arr(obj(['label', 'objects', 'triangles'], { label: { type: 'string', minLength: 1 }, objects: NONNEG_INT, triangles: NONNEG_INT, areaM2: ref('nonneg') })),
        remeshVertexProvenance: ref('vertexProvenance'),
        structureFit: obj(['buildingId', 'accepted', 'primitives', 'scanToFitRmsM', 'fitToScanRmsM', 'coverage', 'passThroughAreaM2', 'unobservedFaceAreaM2', 'gates', 'corrections', 'reportPath'], {
            buildingId: { type: 'string', pattern: '^[0-9a-f]{16}$' }, accepted: BOOL, primitives: NONNEG_INT,
            scanToFitRmsM: ref('nonneg'), fitToScanRmsM: ref('nonneg'), coverage: ref('unit'),
            passThroughAreaM2: ref('nonneg'), unobservedFaceAreaM2: ref('nonneg'),
            gates: arr(ref('gate')), corrections: arr(ref('correction')), reportPath: STR
        }),
        ornament: obj(['elements', 'slotsFilled', 'slotsEmpty', 'confidence', 'evidence', 'model', 'revisionPass', 'dropped', 'specPath'], {
            elements: NONNEG_INT, slotsFilled: NONNEG_INT, slotsEmpty: NONNEG_INT, read: NONNEG_INT,
            confidence: obj(['min', 'median', 'max'], { min: ref('unit'), median: ref('unit'), max: ref('unit') }),
            evidence: obj(['tileOrthos', 'streetView'], { tileOrthos: NONNEG_INT, streetView: { type: 'integer', minimum: 0, maximum: MAX_STREET_VIEW_IMAGES_PER_BUILDING } }),
            model: ref('visionModelUse'), revisionPass: BOOL, dropped: NONNEG_INT, specPath: STR,
            anchoring: arr(obj(['elementId', 'slotId', 'kind', 'errorM', 'toleranceM', 'note'], { elementId: STR, slotId: STR, kind: STR, errorM: ref('nonneg'), toleranceM: ref('nonneg'), note: STR })),
            surveyLocated: obj(['elements', 'unlocated', 'slots', 'crops'], { elements: NONNEG_INT, unlocated: NONNEG_INT, slots: NONNEG_INT, crops: NONNEG_INT }),
            slotsOffered: obj(['offered', 'total', 'hidden', 'unseen', 'exposureJudged'], { offered: NONNEG_INT, total: NONNEG_INT, hidden: NONNEG_INT, unseen: NONNEG_INT, exposureJudged: BOOL }),
            registration: obj(['pairs', 'used', 'beforeRmsM', 'afterRmsM', 'perPano', 'setAside'], { pairs: NONNEG_INT, used: NONNEG_INT, beforeRmsM: ref('nonneg'), afterRmsM: ref('nonneg'), perPano: arr(obj(['panoId', 'pairs', 'beforeRmsM', 'afterRmsM', 'dxM', 'dzM', 'dyawDeg', 'dpitchDeg'], { panoId: STR, pairs: NONNEG_INT, beforeRmsM: ref('nonneg'), afterRmsM: ref('nonneg'), dxM: { type: 'number' }, dzM: { type: 'number' }, dyawDeg: { type: 'number' }, dpitchDeg: { type: 'number' } })), setAside: arr(obj(['panoId', 'reason'], { panoId: STR, reason: STR })) }),
            runReadings: obj(['targets', 'read', 'elements', 'replaced', 'skipped'], { targets: NONNEG_INT, read: NONNEG_INT, elements: NONNEG_INT, replaced: NONNEG_INT, skipped: arr(obj(['id', 'kind', 'reason'], { id: STR, kind: STR, slotId: STR, reason: STR })) })
        }),
        materialHints: ref('materialHints'), texturePass: ref('TexturePassRecord'), figures: arr(ref('figureRecord')),
        photoCost: obj(['total', 'byStage'], { total: ref('stageCost'), byStage: { type: 'object', additionalProperties: ref('stageCost') } }),
        // trees-fix's LocationClayTrees (node/3d-engine/location-clay-pipeline.ts) owns its own shape
        trees: { type: 'object' },
        complexityGate: obj(['passed', 'totalVertices', 'totalTriangles', 'violations', 'exemptions'], {
            passed: BOOL, totalVertices: NONNEG_INT, totalTriangles: NONNEG_INT, violations: arr(STR), exemptions: arr(STR)
        }),
        sourceLimits: ref('sourceLimits'),
        timingsMs: obj(['total', 'firstVisual', 'byStage'], { total: ref('nonneg'), firstVisual: ref('nonneg'), byStage: { type: 'object', additionalProperties: ref('nonneg') } }),
        cache: { type: 'object', additionalProperties: { enum: ['hit', 'miss', 'bypassed'] } },
        // the scene artifact as mounted (CanvasArtifact); its own types check it
        artifact: {},
        digest: { type: 'string', minLength: 1, maxLength: STAGED_SUMMARY_LIMITS.digestMaxChars }, summary: { type: 'string', minLength: 1 }
    })
} satisfies Record<string, JsonSchema>;

/** A definition in STAGED_LOCATION_SCHEMA: a contract (capitalised) or a shared part. */
export type StagedSchemaName = keyof typeof DEFINITIONS;

/** The draft-07 JSON Schema of every contract. Each contract is { "$ref": "#/definitions/<Name>" } against this document. */
export const STAGED_LOCATION_SCHEMA: { $schema: string; $id: string; definitions: Record<StagedSchemaName, JsonSchema> } = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'scratchbox:staged-location/2',
    definitions: DEFINITIONS
};

/** The contracts other code reads or writes whole (the rest are shared parts). */
export const STAGED_CONTRACT_NAMES = [
    'StructureFit', 'VisionOrnamentReply', 'OrnamentSpec', 'OrnamentBuildReport', 'FlattenStats', 'CanopyMask', 'StripRoi',
    'StagedNodeExtras', 'StagedGlbRootExtras', 'TreesGlbRootExtras', 'DegradationRecord', 'StagedBuildState', 'StageEvent', 'StagedLocationResult', 'FaceSurveyReply',
    'TextureLayerBundle', 'TexturePassRecord'
] as const satisfies readonly StagedSchemaName[];

/**
 * A self-contained schema for one definition: { $ref, definitions } with only the definitions it reaches. Used to inline
 * the vision reply schema in the prompt (Vertex refuses responseJsonSchema on gemini-4-argon).
 */
export function schemaClosure(name: StagedSchemaName): { $ref: string; definitions: Record<string, JsonSchema> } {
    const definitions: Record<string, JsonSchema> = {};
    const visit = (n: string): void => {
        if (definitions[n]) return;
        const def = STAGED_LOCATION_SCHEMA.definitions[n as StagedSchemaName];
        if (!def) throw new Error(`schemaClosure: unknown definition "${n}"`);
        definitions[n] = def;
        JSON.stringify(def, (key, value) => {
            if (key === '$ref' && typeof value === 'string') visit(value.replace('#/definitions/', ''));
            return value;
        });
    };
    visit(name);
    return { $ref: `#/definitions/${name}`, definitions };
}

// =============================================================================
// validateContract: the draft-07 subset above, with precise messages
// =============================================================================

interface Issue {
    path: string;
    message: string;
    /** Whether the issue is at the value's own level (type, required, extra key, or a discriminating const one level down). */
    shallowAt: string[];
}

const MAX_MESSAGES = 100;

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

function show(v: unknown): string {
    if (typeof v === 'string') return `"${v.length > 40 ? `${v.slice(0, 37)}...` : v}"`;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
    if (Array.isArray(v)) return `an array of ${v.length} item${v.length === 1 ? '' : 's'}`;
    if (v === undefined) return 'nothing';
    return `an ${typeOf(v)}`;
}

function sameJson(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a as object), kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every(k => sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function childPath(path: string, key: string | number): string {
    if (typeof key === 'number') return `${path}[${key}]`;
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function resolveRef(doc: { definitions: Record<string, JsonSchema> }, r: string): JsonSchema | undefined {
    const m = /^#\/definitions\/(.+)$/.exec(r);
    return m ? doc.definitions[m[1]] : undefined;
}

class Validator {
    constructor(private readonly doc: { definitions: Record<string, JsonSchema> }) {}

    check(schema: JsonSchema, value: unknown, path: string, out: Issue[]): void {
        if (schema.$ref !== undefined) {
            const target = resolveRef(this.doc, schema.$ref);
            if (!target) { out.push({ path, message: `${path}: schema error: unresolved $ref ${schema.$ref}`, shallowAt: [path] }); return; }
            this.check(target, value, path, out);
            return;
        }
        if (schema.type !== undefined && !this.checkType(schema.type, value, path, out)) return;
        if (schema.const !== undefined && !sameJson(value, schema.const)) {
            out.push({ path, message: `${path}: must be ${show(schema.const)}, got ${show(value)}`, shallowAt: [path, parentOf(path)] });
        }
        if (schema.enum !== undefined && !schema.enum.some(e => sameJson(value, e))) {
            out.push({ path, message: `${path}: ${show(value)} is not one of ${schema.enum.map(show).join(', ')}`, shallowAt: [path] });
        }
        if (typeof value === 'number') this.checkNumber(schema, value, path, out);
        if (typeof value === 'string') this.checkString(schema, value, path, out);
        if (Array.isArray(value)) this.checkArray(schema, value, path, out);
        if (isObject(value)) this.checkObject(schema, value, path, out);
        if (schema.allOf) for (const s of schema.allOf) this.check(s, value, path, out);
        if (schema.oneOf) this.checkOneOf(schema.oneOf, value, path, out);
        if (schema.if && schema.then) {
            const probe: Issue[] = [];
            this.check(schema.if, value, path, probe);
            if (probe.length === 0) {
                const thenIssues: Issue[] = [];
                this.check(schema.then, value, path, thenIssues);
                const why = describeCondition(schema.if, value);
                for (const i of thenIssues) out.push({ ...i, message: `${i.message} (because ${why})` });
            }
        }
    }

    private checkType(type: NonNullable<JsonSchema['type']>, value: unknown, path: string, out: Issue[]): boolean {
        const actual = typeOf(value);
        let ok: boolean;
        if (type === 'integer' || type === 'number') {
            if (typeof value === 'number' && !Number.isFinite(value)) {
                out.push({ path, message: `${path}: expected a finite ${type}, got ${String(value)}`, shallowAt: [path] });
                return false;
            }
            ok = typeof value === 'number' && (type === 'number' || Number.isInteger(value));
        } else {
            ok = actual === type;
        }
        if (!ok) {
            const got = typeof value === 'number' ? String(value) : typeof value === 'string' || typeof value === 'boolean' ? `${actual} ${show(value)}` : actual;
            out.push({ path, message: `${path}: expected ${type}, got ${got}`, shallowAt: [path] });
        }
        return ok;
    }

    private checkNumber(s: JsonSchema, v: number, path: string, out: Issue[]): void {
        if (s.minimum !== undefined && v < s.minimum) out.push({ path, message: `${path}: ${v} is below the minimum ${s.minimum}`, shallowAt: [] });
        if (s.maximum !== undefined && v > s.maximum) out.push({ path, message: `${path}: ${v} is above the maximum ${s.maximum}`, shallowAt: [] });
        if (s.exclusiveMinimum !== undefined && !(v > s.exclusiveMinimum)) out.push({ path, message: `${path}: must be greater than ${s.exclusiveMinimum}, got ${v}`, shallowAt: [] });
    }

    private checkString(s: JsonSchema, v: string, path: string, out: Issue[]): void {
        const length = Array.from(v).length;
        if (s.minLength !== undefined && length < s.minLength) out.push({ path, message: `${path}: is ${length} characters long, needs at least ${s.minLength}`, shallowAt: [] });
        if (s.maxLength !== undefined && length > s.maxLength) out.push({ path, message: `${path}: is ${length} characters long, allows at most ${s.maxLength}`, shallowAt: [] });
        if (s.pattern !== undefined && !new RegExp(s.pattern).test(v)) out.push({ path, message: `${path}: ${show(v)} does not match /${s.pattern}/`, shallowAt: [] });
    }

    private checkArray(s: JsonSchema, v: unknown[], path: string, out: Issue[]): void {
        if (s.minItems !== undefined && v.length < s.minItems) out.push({ path, message: `${path}: has ${v.length} item${v.length === 1 ? '' : 's'}, needs at least ${s.minItems}`, shallowAt: [] });
        if (s.maxItems !== undefined && v.length > s.maxItems) out.push({ path, message: `${path}: has ${v.length} items, allows at most ${s.maxItems}`, shallowAt: [] });
        if (s.items) v.forEach((item, i) => this.check(s.items as JsonSchema, item, childPath(path, i), out));
    }

    private checkObject(s: JsonSchema, v: Record<string, unknown>, path: string, out: Issue[]): void {
        for (const key of s.required ?? []) {
            if (v[key] === undefined) out.push({ path, message: `${path}: required property "${key}" is missing`, shallowAt: [path] });
        }
        for (const [key, child] of Object.entries(v)) {
            if (child === undefined) continue;
            const p = childPath(path, key);
            const own = s.properties?.[key];
            if (own) this.check(own, child, p, out);
            else if (s.additionalProperties === false) out.push({ path: p, message: `${path}: property "${key}" is not allowed`, shallowAt: [path] });
            else if (isObject(s.additionalProperties)) this.check(s.additionalProperties, child, p, out);
        }
    }

    /**
     * Exactly one alternative must match. When none does, the alternative whose own level matches (its required keys,
     * no extra keys, its discriminating const) is the one the value meant, and its deeper problems are reported as they
     * are; when no alternative matches at its own level, the message lists what was expected.
     */
    private checkOneOf(branches: readonly JsonSchema[], value: unknown, path: string, out: Issue[]): void {
        const results = branches.map(b => { const issues: Issue[] = []; this.check(b, value, path, issues); return issues; });
        const passing = results.flatMap((r, i) => r.length === 0 ? [i] : []);
        if (passing.length === 1) return;
        const labels = branches.map(b => this.describe(b));
        if (passing.length > 1) {
            out.push({ path, message: `${path}: matches ${passing.length} of the alternatives (${passing.map(i => labels[i]).join(', ')}); exactly one must match`, shallowAt: [path] });
            return;
        }
        let best = -1;
        results.forEach((issues, i) => {
            if (issues.some(x => x.shallowAt.includes(path))) return;
            if (best < 0 || issues.length < results[best].length) best = i;
        });
        if (best >= 0) { out.push(...results[best]); return; }
        out.push({ path, message: `${path}: matches none of the alternatives; expected ${labels.join(' or ')}`, shallowAt: [path] });
    }

    private describe(schema: JsonSchema): string {
        if (schema.$ref !== undefined) {
            const target = resolveRef(this.doc, schema.$ref);
            return target ? this.describe(target) : schema.$ref;
        }
        if (schema.oneOf) return schema.oneOf.map(b => this.describe(b)).join(' or ');
        if (schema.required && schema.required.length > 0) {
            return `{${schema.required.map(k => {
                const c = schema.properties?.[k]?.const;
                return c === undefined ? k : `${k}: ${show(c)}`;
            }).join(', ')}}`;
        }
        if (schema.const !== undefined) return show(schema.const);
        return schema.type ?? 'a value';
    }
}

function parentOf(path: string): string {
    const m = /^(.*)(\.[A-Za-z_$][\w$]*|\[[^\]]*\])$/.exec(path);
    return m ? m[1] : path;
}

/** "measuredGeometry is false", from an `if` of const / enum properties and the value's own fields. */
function describeCondition(cond: JsonSchema, value: unknown): string {
    const parts = Object.keys(cond.properties ?? {}).map(k => `${k} is ${show(isObject(value) ? value[k] : undefined)}`);
    return parts.length > 0 ? parts.join(' and ') : 'its condition holds';
}

/**
 * Validates `value` against a contract or shared part of STAGED_LOCATION_SCHEMA. Returns one message per problem, each
 * starting with the path from the contract's name ("StructureFit.primitives[0].provenance: …"); [] means valid.
 */
export function validateContract(name: StagedSchemaName, value: unknown): string[] {
    const schema = STAGED_LOCATION_SCHEMA.definitions[name];
    if (!schema) return [`unknown contract "${String(name)}"; known: ${Object.keys(STAGED_LOCATION_SCHEMA.definitions).join(', ')}`];
    const issues: Issue[] = [];
    new Validator(STAGED_LOCATION_SCHEMA).check(schema, value, String(name), issues);
    const messages = Array.from(new Set(issues.map(i => i.message)));
    return messages.length > MAX_MESSAGES
        ? [...messages.slice(0, MAX_MESSAGES), `… and ${messages.length - MAX_MESSAGES} more problems`]
        : messages;
}

/**
 * Validates the JSON chunk of a trees GLB against the LOD structure: root extras `sbTrees`; every node with extras `sbTree`
 * has exactly three children tagged `sbLod` with levels 0, 1, 2 (distance bands in order, level 2 not instanced); instanced
 * children carry EXT_mesh_gpu_instancing and `sbCluster` naming a variant of the cluster library; no leaf node claims "measured".
 * Returns one message per problem; [] means valid.
 */
export function validateTreesGlbJson(gltf: any): string[] {
    const out: string[] = [];
    const nodes: any[] = Array.isArray(gltf?.nodes) ? gltf.nodes : [];
    const rootExtras = gltf?.extras?.sbTrees;
    for (const m of validateContract('TreesGlbRootExtras', rootExtras)) out.push(m.replace(/^TreesGlbRootExtras/, 'extras.sbTrees'));
    const variants = new Set<string>(Array.isArray(rootExtras?.clusterLibrary?.variants) ? rootExtras.clusterLibrary.variants.map((v: any) => v?.mesh) : []);
    const used: string[] = Array.isArray(gltf?.extensionsUsed) ? gltf.extensionsUsed : [];
    const trees = nodes.map((n, i) => ({ n, i })).filter(({ n }) => n?.extras?.sbTree !== undefined);
    if (trees.length === 0) out.push('no node carries extras.sbTree');
    for (const { n, i } of trees) {
        const at = `nodes[${i}]`;
        for (const m of validateContract('treeNodeExtras', n.extras.sbTree)) out.push(m.replace(/^treeNodeExtras/, `${at}.extras.sbTree`));
        const kids: number[] = Array.isArray(n.children) ? n.children : [];
        if (kids.length !== 3) { out.push(`${at}: a tree has exactly 3 child nodes, has ${kids.length}`); continue; }
        const lods = new Map<number, TreeLodExtras>();
        kids.forEach(k => {
            const c = nodes[k], kat = `nodes[${k}]`;
            if (!c) { out.push(`${kat}: child index out of range`); return; }
            const errs = validateContract('treeLodExtras', c.extras?.sbLod);
            if (errs.length) { errs.forEach(m => out.push(m.replace(/^treeLodExtras/, `${kat}.extras.sbLod`))); return; }
            const lod = c.extras.sbLod as TreeLodExtras;
            if (lods.has(lod.level)) out.push(`${kat}: tree has two level-${lod.level} children`);
            lods.set(lod.level, lod);
            if (lod.minDistM > lod.maxDistM) out.push(`${kat}.extras.sbLod: minDistM ${lod.minDistM} exceeds maxDistM ${lod.maxDistM}`);
            if (lod.level === 2 && lod.instanced) out.push(`${kat}.extras.sbLod: level 2 is the shipped blob masses and is not instanced`);
            // a level node holds the wood mesh; its leaf clusters are child nodes that instance one shared cluster mesh
            const clusters: number[] = Array.isArray(c.children) ? c.children : [];
            if (c.extensions?.EXT_mesh_gpu_instancing !== undefined) out.push(`${kat}: instancing belongs on its leaf-cluster child nodes`);
            if (lod.instanced && clusters.length === 0) out.push(`${kat}: sbLod.instanced is true but the level has no leaf-cluster child node`);
            if (!lod.instanced && clusters.length > 0) out.push(`${kat}: sbLod.instanced is false but the level has child nodes`);
            for (const ci of clusters) {
                const cn = nodes[ci], cat = `nodes[${ci}]`;
                if (!cn) { out.push(`${cat}: cluster index out of range`); continue; }
                if (cn.extensions?.EXT_mesh_gpu_instancing === undefined) out.push(`${cat}: leaf-cluster node lacks EXT_mesh_gpu_instancing`);
                else if (!used.includes('EXT_mesh_gpu_instancing')) out.push(`${cat}: EXT_mesh_gpu_instancing missing from extensionsUsed`);
                const ce = validateContract('treeClusterExtras', cn.extras?.sbCluster);
                ce.forEach(m => out.push(m.replace(/^treeClusterExtras/, `${cat}.extras.sbCluster`)));
                if (!ce.length && !variants.has(cn.extras.sbCluster.clusterMesh)) out.push(`${cat}.extras.sbCluster.clusterMesh: "${cn.extras.sbCluster.clusterMesh}" is not a variant of the cluster library`);
                if (/measured/i.test(JSON.stringify(cn.extras))) out.push(`${cat}: leaf clusters carry no "measured" claim`);
            }
            if (lod.level < 2 && /measured/i.test(JSON.stringify(c.extras))) out.push(`${kat}: leaf levels carry no "measured" claim`);
        });
        for (const lv of [0, 1, 2]) if (!lods.has(lv)) out.push(`${at}: missing level-${lv} child`);
        const [l0, l1, l2] = [lods.get(0), lods.get(1), lods.get(2)];
        if (l0 && l1 && l1.minDistM > l0.maxDistM) out.push(`${at}: gap between level 0 (to ${l0.maxDistM} m) and level 1 (from ${l1.minDistM} m)`);
        if (l1 && l2 && l2.minDistM > l1.maxDistM) out.push(`${at}: gap between level 1 (to ${l1.maxDistM} m) and level 2 (from ${l2.minDistM} m)`);
    }
    return out;
}
