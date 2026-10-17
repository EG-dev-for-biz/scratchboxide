/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Staged location texture pass: the shared contracts (docs/processes/staged_location_texture_pass_design.md, sections 2 to 8).
 *
 * Three workstreams code against this file and nothing else of each other:
 *   B (UV + GLB writer)   produces a UvAtlas and consumes BakedTexturePlanes;
 *   C (projection bake)   consumes a UvAtlas and ProjectionViews, produces BakedTexturePlanes;
 *   D (tile transfer)     consumes a UvAtlas and a tile photo texture, produces BakedTexturePlanes.
 * The JSON Schema of the published records (TexelProvenance, SurfaceUvMap, TextureLayerBundle, TexturePassRecord)
 * is registered in STAGED_LOCATION_SCHEMA (staged-location-contracts.ts), so validateContract checks them.
 *
 * Open literals only. TexelSource and TexelLabel are `'…' | (string & {})`; nothing branches on them. Decisions read
 * measured quantities: coverage, texelsPerMeter, residuals, the per-texel weight and rung.
 *
 * Honesty rules encoded here: every texel is labelled (the provenance list covers 100 percent of texels), a photo-derived
 * texel is labelled 'photo-inferred', only a texel with no real data may be 'generated', and a failing rung moves its
 * texels down ONE rung to simpler real data (TEXTURE_LADDER_RUNGS) with a degradation entry, never to invention.
 */

import type { Vec3 } from './staged-location-contracts';

// =============================================================================
// Provenance of texels
// =============================================================================

/** Where a texel's colour came from. Open: a new source is a new string, not a code change. */
export type TexelSource =
    | 'street-view-projection' | 'tile-photo-transfer' | 'tile-photo-enhanced' | 'measured-palette' | 'generated-pbr'
    | (string & {});

/** 'photo-inferred' for anything derived from a real photo; 'generated' only for texels with no real data. */
export type TexelLabel = 'photo-inferred' | 'generated' | (string & {});

export interface TexelProvenance {
    source: TexelSource;
    label: TexelLabel;
    /** How it was made, one line ("weighted linear-RGB mean, 3 views"). */
    method: string;
    panoIds?: string[];
    /** Share of the layer's texels this entry accounts for, 0..1. Entries of a layer sum to 1 (every texel is labelled). */
    coverage: number;
}

/** Degrade ladder of the texture pass (design section 8). Index = rung; lower is better. */
export const TEXTURE_LADDER_RUNGS = [
    'street-view multi-view blend',
    'street-view single view',
    'tile photo transfer',
    'measured palette colour',
    'generated tileable PBR',
    'clay'
] as const;
/** The rung index of clay: the floor, always available. */
export const TEXTURE_RUNG_CLAY = TEXTURE_LADDER_RUNGS.length - 1;

// =============================================================================
// UV and bundle records (published, JSON)
// =============================================================================

export interface SurfaceUvMap {
    /** The glTF node this map belongs to; the textured twin keeps the clay node names. */
    nodeName: string;
    /** Diagnostic: 'chart-plane', 'chart-cylinder', 'atlas'. Open; nothing branches on it. */
    kind: string;
    /** Measured texel density in the atlas. */
    texelsPerMeter: number;
    /** [u0, v0, u1, v1] in the layer's atlas, 0..1. */
    atlasRect: [number, number, number, number];
    /** Fitted surface id for chart UVs ("s03"). */
    chartId?: string;
}

export interface TextureLayerBundle {
    layerKey: string;
    /** Published file refs; bytes are never on disk before publish. */
    maps: { albedo: string; normal?: string; roughness?: string };
    uv: SurfaceUvMap[];
    provenance: TexelProvenance[];
    /** Layer-level rung: the worst rung that holds more than 10 percent of the layer's texels. */
    ladderRung: number;
    rungReason?: string;
    /** Ref of the baked per-texel confidence plane (ConfidencePlane, PNG): R = index into provenance[], G = weight, B = rung. */
    confidence: string;
    /** Held-out fit of the textured layer against the Street View photos (texture-fit-metric.ts); absent when no view scored. */
    fit?: TextureLayerFit;
}

/**
 * How well a textured layer, rendered from each Street View pose, lines up with that photo, scored only on texels the
 * photo's own pano did not make (leave one pano out). Chamfer distances in pixels at `widthPx` (lower is better), NCC of the
 * surface's luminance gradients (higher is better). Pixel-weighted means over the scoring views.
 */
export interface TextureLayerFit {
    chamferPx: number | null;
    clayChamferPx: number | null;
    gradNcc: number | null;
    scoredViews: number;
    heldOutShare: number;
    widthPx: number;
    views: Array<{ panoId: string; pixels: number; ownPixels: number; chamferPx: number | null; clayChamferPx: number | null; gradNcc: number | null }>;
}

export interface TexturePassDegradation {
    stage: string;
    /** Open diagnostic: "pano_set_aside", "tile_fetch_failed", "edge_gate_rejected", … */
    reasonCode: string;
    /** One user-facing sentence with the real cause. */
    reason: string;
    layerKey?: string;
    fromRung?: number;
    toRung?: number;
    /** Share of the layer's texels that moved down, 0..1. */
    texelShare?: number;
}

export interface TexturePassRecord {
    /** Part of stageKey(layerKey, poseHash, imageSha256s, passVersion). */
    passVersion: string;
    layers: TextureLayerBundle[];
    degradations: TexturePassDegradation[];
    costUsd?: number;
    timingsMs: Record<string, number>;
}

// =============================================================================
// In-memory data handed between tasks (not JSON; never written to disk)
// =============================================================================

/** Per-texel confidence plane (RGBA8, row-major, `width * height * 4`): R = TexelProvenance index, G = weight 0..255, B = rung, A = 255 when the texel is covered by the atlas. */
export interface ConfidencePlane { width: number; height: number; data: Uint8Array }

/** Pack/unpack one confidence texel so B, C, D and the viewport overlay read and write the same bytes. */
export function packConfidenceTexel(plane: ConfidencePlane, texel: number, provenanceIndex: number, weight01: number, rung: number): void {
    const o = texel * 4;
    plane.data[o] = provenanceIndex;
    plane.data[o + 1] = Math.round(Math.min(1, Math.max(0, weight01)) * 255);
    plane.data[o + 2] = rung;
    plane.data[o + 3] = 255;
}
export function unpackConfidenceTexel(plane: ConfidencePlane, texel: number): { provenanceIndex: number; weight01: number; rung: number; covered: boolean } {
    const o = texel * 4;
    return { provenanceIndex: plane.data[o], weight01: plane.data[o + 1] / 255, rung: plane.data[o + 2], covered: plane.data[o + 3] !== 0 };
}

/** A decoded image held in memory (RGBA8, row-major, sRGB). Decoded from grounding JPEG bytes; dropped after use. */
export interface DecodedImage { width: number; height: number; rgba: Uint8Array }

/** Pinhole camera, structurally the same as StreetViewPoseRegistrar's FrameCamera (world axes; image y points down; `fwd` is the view direction). */
export interface PinholeCamera {
    eye: Vec3; right: Vec3; up: Vec3; fwd: Vec3;
    fx: number; fy: number; cx: number; cy: number;
    width: number; height: number;
}

/**
 * B output. One RGBA atlas per layer. The per-texel arrays (length width * height) invert the UV map so the projector never
 * searches: for a texel the world point and normal come straight from the chart (fitted) or the island (scan).
 */
export interface UvAtlas {
    layerKey: string;
    width: number;
    height: number;
    maps: SurfaceUvMap[];
    texels: {
        /** 1 where an island or chart covers the texel, gutter included; 0 elsewhere. */
        covered: Uint8Array;
        /** 1 for gutter texels (filled by bleed, never projected). */
        gutter: Uint8Array;
        /** Index into `maps`, 65535 where uncovered. */
        mapIndex: Uint16Array;
        /** World position, 3 floats per texel, in the layer's frame (tile frame). */
        position: Float32Array;
        /** Unit geometric normal, 3 floats per texel. */
        normal: Float32Array;
        /** Surface sample spacing in metres at the texel (area per texel is its square). */
        sizeM: Float32Array;
    };
}

/** One registered Street View view (C input). */
export interface ProjectionView {
    panoId: string;
    camera: PinholeCamera;
    image: DecodedImage;
    /** 0 for a pano set aside by the registration, else from its per-pair residual, 0..1. */
    poseQuality: number;
    /** Pose uncertainty in pixels at 1 m, for the weight exp(-(sigma/3)^2); from uncertaintyPx. */
    poseSigmaPx: number;
    /**
     * Half-width of the per-chart alignment search for this view, in pose sigmas (default: the alignment's sigmaWindow). A pose
     * registered against the scan's edges is searched only within its own residual, so the search cannot reach the next
     * course of a repeating wall.
     */
    alignSigmas?: number;
    /** ISO capture date of the pano, for solar de-lighting. */
    captureDate?: string;
    /** Pixel rects [x0,y0,x1,y1] of detected redaction blur; weight is zeroed inside. */
    redactionRects?: Array<[number, number, number, number]>;
}

/** Software depth (metres along `fwd`, row-major, Infinity where nothing) of the occluder as seen from a view. */
export type DepthMap = { width: number; height: number; depthM: Float32Array };

/**
 * The colour, confidence and provenance a bake or transfer produced for a UvAtlas (C and D output, B input).
 * Texels it does not touch stay `covered` 0 in the plane so the next rung can fill them.
 */
export interface BakedTexturePlanes {
    layerKey: string;
    width: number;
    height: number;
    /** RGBA8 sRGB albedo, de-lit; alpha 255 where this stage produced the texel. */
    albedo: Uint8Array;
    confidence: ConfidencePlane;
    /** Entries the confidence plane's R channel indexes. */
    provenance: TexelProvenance[];
    degradations: TexturePassDegradation[];
    /** Measured mean CIEDE2000 between the photo palette and the baked texels, when a palette exists. */
    paletteDeltaE?: number;
}

// =============================================================================
// Function signatures at the task seams (types only: the owners implement them)
// =============================================================================

/** B: charts and island atlas for a layer's geometry. `densityTexelsPerMeter` is min(nativeSampleM of the best view, 1/0.05). */
export interface UvAtlasInput {
    layerKey: string;
    /** Clay GLB bytes of the layer (positions are never changed by B). */
    clayGlb: Uint8Array;
    /** Target density in texels per metre. */
    densityTexelsPerMeter: number;
    /** Largest atlas side, texels. */
    maxSide: number;
    /** Angular tolerance (degrees) when clustering scan triangles into islands. */
    islandNormalToleranceDeg: number;
}
export type BuildUvAtlas = (input: UvAtlasInput) => Promise<UvAtlas>;

/** C: Street View projection bake (design section 4). Occlusion comes from `depthFor` (the scan plus the fitted solid). */
export interface ProjectionBakeInput {
    atlas: UvAtlas;
    views: ProjectionView[];
    depthFor: (view: ProjectionView) => DepthMap;
    /**
     * The full scene as scanned (the photogrammetric tile mesh: the real openings, statues, trees and the buildings behind),
     * rendered from each view. When given, a texel is hidden by anything nearer in it as well, and the photo must show the
     * scan's surface at the texel (not what stands behind an opening); the samples it removes are counted as leaks caught.
     */
    contextDepthFor?: (view: ProjectionView) => DepthMap;
    /** Measured palette (Lab) the exposure gate anchors to, when one exists. */
    paletteLab?: Array<{ lab: Vec3; share: number }>;
    signal?: AbortSignal;
}
export type BakeStreetViewProjection = (input: ProjectionBakeInput) => Promise<BakedTexturePlanes>;

/** D: tile photo transfer (design section 5). `tileSample` returns the de-lit tile colour nearest to a world point, or undefined past the distance or angle gate. */
export interface TileTransferInput {
    atlas: UvAtlas;
    tileSample: (position: Vec3, normal: Vec3, maxDistanceM: number) => { rgb: Vec3; distanceM: number } | undefined;
    maxDistanceM: number;
    /** Tier 1 planes; the transfer fills only texels they leave uncovered (fusing with tier 1 is the caller's StreetViewTextureFusion step). */
    existing?: BakedTexturePlanes;
    signal?: AbortSignal;
}
export type TransferTilePhoto = (input: TileTransferInput) => Promise<BakedTexturePlanes>;

/** B: write the textured twin of a clay GLB. Positions and node names stay byte-identical; TEXCOORD_0, image and material are added. */
export interface TexturedTwinInput {
    clayGlb: Uint8Array;
    atlas: UvAtlas;
    planes: BakedTexturePlanes;
}
export type WriteTexturedTwin = (input: TexturedTwinInput) => Promise<{ glb: Uint8Array; uv: SurfaceUvMap[] }>;
