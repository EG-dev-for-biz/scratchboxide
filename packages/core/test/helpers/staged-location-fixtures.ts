/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Valid examples of every staged-location contract, typed against the contracts' TypeScript types so the types and the
 * JSON Schema are checked against each other. Numbers follow the Washington Square Arch investigation (span 9.73 m,
 * segmental arch R 5.007 m, scan→fit 3.2 cm rms, leaf error 2.0064 m, texel 0.154 m) and trees-fix's Central Park run.
 * Each builder returns a fresh object, so a test may mutate it.
 */

import {
    PHOTO_CORRECTION_TOLERANCE_M,
    PROVENANCE,
    STAGED_VISION_MODEL_DEFAULT,
    type CanopyMask,
    type DegradationRecord,
    type FittedPrimitive,
    type FittedSurface,
    type FlattenStats,
    type OrnamentBuildReport,
    type OrnamentSpec,
    type PrimitiveCorrection,
    type ProvenanceLabel,
    type ProvenanceRecord,
    type ResidualStats,
    type SourceLimits,
    type StagedBuildState,
    type StagedGlbRootExtras,
    type StagedLayer,
    type StagedLocationResult,
    type StagedNodeExtras,
    type StageEvent,
    type StageSummary,
    type StripRoi,
    type StructureFit,
    type VertexProvenanceSummary,
    type VisionModelUse,
    type VisionOrnamentReply
} from '../../src/common/spatial/staged-location-contracts';

export const RUN_ID = 'a1b2c3d4';
export const BUILDING_ID = '3fa9c2d1e07b5a44';

export function residual(rmsM = 0.032, areaM2 = 310.5): ResidualStats {
    return { rmsM, p50M: rmsM * 0.7, p95M: rmsM * 2.1, maxM: rmsM * 5, samples: 4200, areaM2, inlierFraction: 0.94 };
}

export function measured(label: ProvenanceLabel, method: string, extra: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
    return { label, measuredGeometry: true, method, sources: [{ kind: 'stage-output', id: 'remesh:90e961' }], ...extra };
}

export function photoInferred(confidence: number, imageId = 'sv:CAoSLEFGMVFpcE:12:8:42'): ProvenanceRecord {
    return {
        label: PROVENANCE.photoInferred, measuredGeometry: false, confidence,
        method: 'gemini-4-argon (thinking LOW) reading the facade photos, expanded slot-relative',
        sources: [{ kind: 'streetview-grounding', id: imageId }]
    };
}

export function sourceLimits(): SourceLimits {
    return { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.154, photoResolvableM: 0.308 };
}

export function visionModelUse(outcome: 'answered' | 'failed' = 'answered'): VisionModelUse {
    const base: VisionModelUse = {
        requested: STAGED_VISION_MODEL_DEFAULT.model, used: STAGED_VISION_MODEL_DEFAULT.model, answered: 'gemini-4-argon-001',
        thinking: { level: STAGED_VISION_MODEL_DEFAULT.thinking.level }, skipped: [], backend: 'injected',
        ms: 12400, ttftMs: 4100, promptTokens: 9200, outputTokens: 1830, thinkingTokens: 410, finishReason: 'STOP',
        outcome: 'answered', selection: STAGED_VISION_MODEL_DEFAULT.selection
    };
    if (outcome === 'answered') return base;
    const { finishReason: _f, outputTokens: _o, thinkingTokens: _t, ttftMs: _ttft, ...failed } = base;
    return { ...failed, answered: '', outcome: 'failed', error: '503 UNAVAILABLE (twice)' };
}

function archPrimitive(): FittedPrimitive {
    return {
        id: 'p03',
        label: 'passage arch',
        spec: {
            operator: 'sweep',
            sweep: {
                carrier: { path: { points: [[0, 0, -4.5], [0, 0, 4.5]], closed: false, lengthM: 9 } },
                profile: { outer: [[-4.865, 0], [4.865, 0], [4.865, 7.2], [0, 11.0], [-4.865, 7.2]] },
                profileUp: [0, 1, 0], miterLimit: 4, caps: false
            }
        },
        frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
        fit: residual(0.039, 96.2),
        gates: [{ gate: 'soffit circle rms', value: 0.039, threshold: 0.06, comparison: '<=', passed: true, unit: 'm' }],
        accepted: true,
        provenance: measured(PROVENANCE.fitted, 'scan_fit: RANSAC circle on the soffit, Gauss-Newton refine', { residual: residual(0.039, 96.2) }),
        buildOrder: 3,
        surfaceIds: ['s05'],
        parentId: 'p00',
        fitParams: [
            { index: 0, value: 9.73, unit: 'm', description: 'span' },
            { index: 1, value: 7.2, unit: 'm', description: 'springing height' },
            { index: 2, value: 0.39, unit: 'ratio', description: 'rise / span' },
            { index: 3, value: 5.007, unit: 'm', description: 'radius' }
        ],
        correctable: [{
            param: 2, key: 'riseToSpan', value: 0.39, min: 0.31, max: 0.5, unit: 'ratio', description: 'rise over span of the passage arch',
            toleranceM: PHOTO_CORRECTION_TOLERANCE_M, residualCurve: [[0.31, 0.12], [0.39, 0.039], [0.5, 0.223]]
        }],
        alternatives: [{
            spec: {
                operator: 'sweep',
                sweep: {
                    carrier: { path: { points: [[0, 0, -4.5], [0, 0, 4.5]], closed: false, lengthM: 9 } },
                    profile: { outer: [[-4.865, 0], [4.865, 0], [4.865, 7.2], [0, 12.07], [-4.865, 7.2]] },
                    profileUp: [0, 1, 0], miterLimit: 4, caps: false
                }
            },
            fit: residual(0.223, 96.2),
            why: 'semicircle tangent to both jambs: 22.3 cm rms against the soffit'
        }]
    };
}

export function correction(): PrimitiveCorrection {
    return {
        primitiveId: 'p03', param: 2, key: 'riseToSpan', from: 0.39, to: 0.5, confidence: 0.74,
        reason: 'the north Street View image shows a semicircular intrados',
        evidence: [{ imageId: 'sv:CAoSLEFGMVFpcE:12:8:42', box1000: [180, 310, 520, 690] }],
        check: { residualBefore: residual(0.039, 96.2), residualAfter: residual(0.223, 96.2), toleranceM: PHOTO_CORRECTION_TOLERANCE_M, accepted: true, why: '22.3 cm rms is within the 0.31 m tolerance' }
    };
}

function surfaces(): FittedSurface[] {
    return [
        {
            id: 's00', primitiveId: 'p00',
            chart: { plane: { origin: [-13.15, 0, -5.5], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, -1], extentUv: [[0, 0], [26.3, 0], [26.3, 24.4], [0, 24.4]] } },
            areaM2: 520.4, fit: residual(0.028, 520.4), visibleFraction: 0.97, supportFraction: 0.93,
            provenance: measured(PROVENANCE.fitted, 'scan_fit: region-grown plane, LS refine')
        },
        {
            id: 's05', primitiveId: 'p03',
            chart: { cylinder: { axisOrigin: [0, 6.0, -4.5], axisDir: [0, 0, 1], thetaZeroDir: [1, 0, 0], radiusM: 5.007, thetaDeg: [13.8, 166.2], zM: [0, 9], normalSign: -1 } },
            areaM2: 96.2, fit: residual(0.039, 96.2), visibleFraction: 0.81, supportFraction: 0.77,
            provenance: measured(PROVENANCE.fitted, 'scan_fit: RANSAC circle on the soffit')
        },
        {
            id: 's07', primitiveId: 'p07',
            chart: { plane: { origin: [-0.6, 10.4, -5.94], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, -1], extentUv: [[0, 0], [1.2, 0], [1.2, 1.6], [0, 1.6]] } },
            areaM2: 1.92, fit: residual(0.05, 1.92), visibleFraction: 0.4, supportFraction: 0.31,
            provenance: {
                label: PROVENANCE.fittedUnobserved, measuredGeometry: false, confidence: 0.31,
                method: 'scan_fit: box face snapped to the core by raycast', sources: [{ kind: 'stage-output', id: 'fit:7c1e04aa' }]
            }
        }
    ];
}

export function structureFit(): StructureFit {
    const fit: StructureFit = {
        schema: 'scratchbox.structure-fit/2',
        buildingId: BUILDING_ID,
        input: { scanSha256: 'f'.repeat(64), scanTriangles: 2616, scanSource: 'raw_clay.glb (tile_refine isolate)', texturedSha256: 'e'.repeat(64), anchor: [0.4, -1.2] },
        frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
        ground: { normal: [0, 1, 0], offsetM: 0, tiltDeg: 0.4, rmsM: 0.021, baseY: 0 },
        footprint: { outer: [[-13.15, -5.5], [13.15, -5.5], [13.15, 5.5], [-13.15, 5.5]], areaM2: 289.3 },
        sourceLimits: sourceLimits(),
        primitives: [
            {
                id: 'p00', label: 'body', buildOrder: 0, surfaceIds: ['s00'],
                spec: {
                    operator: 'sweep',
                    sweep: {
                        carrier: { path: { points: [[-13.15, 0, -5.5], [13.15, 0, -5.5], [13.15, 0, 5.5], [-13.15, 0, 5.5]], closed: true, lengthM: 74.6 } },
                        profile: { outer: [[0, 0], [0.01, 0], [0.01, 24.4], [0, 24.4]] }, profileUp: [0, 1, 0], miterLimit: 4, caps: true
                    }
                },
                frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
                fit: residual(0.028, 1200), gates: [], accepted: true,
                provenance: measured(PROVENANCE.fitted, 'scan_fit: band polygon swept vertically'),
                fitParams: [{ index: 0, value: 24.4, unit: 'm', description: 'height' }], correctable: [], alternatives: []
            },
            archPrimitive(),
            {
                id: 'p07', label: 'south keystone', buildOrder: 7, surfaceIds: ['s07'], parentId: 'p00',
                spec: {
                    operator: 'relief',
                    relief: {
                        surfaceId: 's00', region: { outer: [[12.55, 10.4], [13.75, 10.4], [13.75, 12.0], [12.55, 12.0]] },
                        height: { panel: { depthM: 0.44, edgeWidthM: 0.02, edgeProfile: [[0, 0], [1, 1]] } }, maxEdgeM: 0.1
                    }
                },
                frame: { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] },
                fit: residual(0.05, 1.92), gates: [{ gate: 'box support', value: 0.62, threshold: 0.5, comparison: '>=', passed: true, unit: 'ratio' }],
                accepted: true, provenance: measured(PROVENANCE.fitted, 'scan_fit: trimmed box fit'),
                fitParams: [{ index: 0, value: 0.44, unit: 'm', description: 'projection' }], correctable: [], alternatives: []
            }
        ],
        surfaces: surfaces(),
        slots: [
            { id: 'S01', label: 'north spandrel', primitiveId: 'p00', host: { surface: { surfaceId: 's00', regionUv: [[2, 12], [8, 12], [8, 18], [2, 18]] } }, sizeM: [6, 6], bounds: { maxProudM: 0.6, maxRecessM: 0.4, minFeatureM: 0.308 } },
            {
                id: 'S02', label: 'cornice crease', primitiveId: 'p00',
                host: { edge: { carrier: { points: [[-13.15, 20.1, -5.5], [13.15, 20.1, -5.5]], closed: false, lengthM: 26.3 }, surfaceIds: ['s00'], envelope: [[0, 0], [1.1, 0], [1.1, 0.35], [0, 0.35]] } },
                sizeM: [26.3, 0.35], bounds: { maxProudM: 0.6, maxRecessM: 0.2, minFeatureM: 0.308 }
            },
            { id: 'S03', label: 'soffit', primitiveId: 'p03', host: { surface: { surfaceId: 's05', regionUv: [[0, 0], [13.3, 0], [13.3, 9], [0, 9]] } }, sizeM: [13.3, 9], bounds: { maxProudM: 0.3, maxRecessM: 0.3, minFeatureM: 0.308 } }
        ],
        passThrough: {
            triangles: 412, areaM2: 35.8,
            regions: [
                { id: 'r0', triangles: 230, areaM2: 19.6, aabbMin: [-11.2, 0, -7.4], aabbMax: [-8.9, 6.1, -5.5], reason: 'not box-like', test: { boxRms: 0.31, support: 0.28 } },
                { id: 'r1', triangles: 182, areaM2: 16.2, aabbMin: [8.9, 0, -7.4], aabbMax: [11.2, 6.0, -5.5], reason: 'not box-like' }
            ]
        },
        metrics: {
            scanToFit: residual(0.032), fitToScan: residual(0.036), scanToFitPlusPassThrough: residual(0.03),
            coverage: 0.97, hausdorffM: 0.41, remeshToScan: residual(0.042)
        },
        gates: [
            { gate: 'coverage', value: 0.97, threshold: 0.85, comparison: '>=', passed: true, unit: 'ratio' },
            { gate: 'scan→fit rms', value: 0.032, threshold: 0.06, comparison: '<=', passed: true, unit: 'm' }
        ],
        accepted: true,
        counts: { vertices: 1124, triangles: 620 },
        outputs: {
            fittedGlb: '.scratchbox/cache/scan_fit/7c1e04aa/fitted.glb', outlinesGlb: '.scratchbox/cache/scan_fit/7c1e04aa/outlines.glb',
            passThroughGlb: '.scratchbox/cache/scan_fit/7c1e04aa/passthrough.glb', reportJson: '.scratchbox/cache/scan_fit/7c1e04aa/structure_fit.json',
            orthos: [{ id: 'ortho:s00', surfaceId: 's00', path: '.scratchbox/cache/scan_fit/7c1e04aa/orthos/s00.png', widthPx: 526, heightPx: 488, gsdM: 0.05, texelM: 0.154, originUv: [0, 24.4], slotsDrawn: ['S01', 'S02'], sha256: 'a'.repeat(64) }]
        },
        timingsMs: { load: 120, planes: 310, openings: 180, total: 1210 }
    };
    return fit;
}

export function visionReply(): VisionOrnamentReply {
    return {
        elements: [
            { slot: 'S02', op: { sweep: { t: [0, 1000], offset: [0, 120], profile: [0, 0, 180, 0, 180, 90, 60, 160, 0, 160] } }, conf: 81, depthBasis: 'shadow line under the cornice, about 18 cm', ev: [[1, 140, 60, 210, 940]], label: 'dentil band' },
            { slot: 'S01', op: { revolve: { at: [3000, 3000], axis: 'n', profile: [0, 0, 900, 0, 900, 120, 0, 180], lobes: 0 } }, conf: 62, depthBasis: 'roundel rim highlight', ev: [[0, 300, 250, 520, 470]] },
            { slot: 'S03', op: { replicate: { seed: { relief: { box: [0, 0, 1100, 1100], depth: -120, edge: 60 } }, grid: [300, 300, 1450, 1450, 9, 6, 0] } }, conf: 48, depthBasis: 'coffer shading in the soffit view', ev: [[2, 400, 300, 800, 700]], beyondView: true }
        ],
        corrections: [{ prim: 'p03', param: 2, to: 0.5, conf: 74, why: 'the intrados is a semicircle in image 1', ev: [[1, 180, 310, 520, 690]] }],
        emptySlots: [{ slot: 'S04', why: 'no image shows it' }]
    };
}

export function ornamentSpec(): OrnamentSpec {
    return {
        schema: 'scratchbox.ornament-spec/2',
        buildingId: BUILDING_ID,
        structureFitSha256: 'b'.repeat(64),
        promptVersion: 'ornament/v2',
        evidence: [
            { id: 'ortho:s00', index: 0, kind: 'tile-ortho', widthPx: 526, heightPx: 488, sha256: 'a'.repeat(64), nativeSampleM: 0.154, surfaceId: 's00', gsdM: 0.05, texelM: 0.154, slotsShown: [{ slotId: 'S01', polygon1000: [100, 100, 100, 400, 400, 400, 400, 100], visibleFraction: 1 }] },
            {
                id: 'sv:CAoSLEFGMVFpcE:12:8:42', index: 1, kind: 'streetview-grounding', widthPx: 1024, heightPx: 768, sha256: 'c'.repeat(64), nativeSampleM: 0.021,
                panoId: 'CAoSLEFGMVFpcE', captureDate: '2025-06', copyright: '© Google', headingDeg: 12, pitchDeg: 8, fovDeg: 42, distanceM: 29.4,
                pose: { eye: [1.2, 2.5, -34.0], registered: false, uncertaintyM: 2, uncertaintyDeg: 2 },
                slotsShown: [{ slotId: 'S02', polygon1000: [130, 50, 130, 950, 220, 950, 220, 50], visibleFraction: 0.92 }]
            }
        ],
        elements: [
            {
                id: 'e000', slotId: 'S02', label: 'dentil band', confidence: 0.81, depthBasis: 'shadow line under the cornice', buildOrder: 0,
                spec: {
                    operator: 'sweep',
                    sweep: {
                        carrier: { slot: { slotId: 'S02', t0: 0, t1: 1, offset: [0, 0.12] } },
                        profile: { outer: [[0, 0], [0.18, 0], [0.18, 0.09], [0.06, 0.16], [0, 0.16]] }, miterLimit: 4, caps: true
                    }
                },
                evidence: [{ imageId: 'sv:CAoSLEFGMVFpcE:12:8:42', box1000: [140, 60, 210, 940] }],
                checks: { slotOverlap: 0.88, minFeatureM: 0.09, nativeSampleM: 0.021 },
                provenance: photoInferred(0.81)
            },
            {
                id: 'e001', slotId: 'S01', confidence: 0.62, depthBasis: 'roundel rim highlight', buildOrder: 1,
                spec: { operator: 'revolve', revolve: { axisOrigin: [3, 3, 0], axisDir: [0, 0, 1], profile: [[0, 0], [0.9, 0], [0.9, 0.12], [0, 0.18]], lobes: 0, lobeAmplitude: 0, helixTurns: 0, startAngleDeg: 0, sweepAngleDeg: 360, segments: 64 } },
                evidence: [{ imageId: 'ortho:s00', box1000: [300, 250, 520, 470] }],
                checks: { slotOverlap: 1, minFeatureM: 1.8, nativeSampleM: 0.154 },
                provenance: photoInferred(0.62, 'ortho:s00')
            },
            {
                id: 'e002', slotId: 'S03', confidence: 0.48, depthBasis: 'coffer shading', continuesBeyondView: true, buildOrder: 2,
                spec: {
                    operator: 'replicate',
                    replicate: {
                        seed: { operator: 'relief', relief: { surfaceId: 's05', region: { outer: [[0, 0], [1.1, 0], [1.1, 1.1], [0, 1.1]] }, height: { panel: { depthM: -0.12, edgeWidthM: 0.06, edgeProfile: [[0, 0], [1, 1]] } }, maxEdgeM: 0.1 } },
                        domain: { lattice: { originUv: [0.3, 0.3], pitchUv: [1.45, 1.45], counts: [9, 6], rowOffsetU: 0 } },
                        alignToSurface: true
                    }
                },
                evidence: [{ imageId: 'sv:CAoSLEFGMVFpcE:12:8:42', box1000: [400, 300, 800, 700] }],
                checks: { slotOverlap: 0.71, minFeatureM: 1.1, nativeSampleM: 0.021 },
                provenance: photoInferred(0.48)
            }
        ],
        corrections: [correction()],
        emptySlots: [{ slotId: 'S04', reason: 'no image shows it' }],
        model: visionModelUse(),
        revision: { passes: 0, problems: [] },
        dropped: [{ elementId: 'e003', slotId: 'S03', by: 'validator', problems: ['rule 10: 0.2 m rosette is under 2 × the 0.154 m texel'] }]
    };
}

export function buildReport(): OrnamentBuildReport {
    return {
        schema: 'scratchbox.ornament-build/1', structureFitSha256: 'b'.repeat(64), ornamentSpecSha256: 'd'.repeat(64),
        built: [
            { elementId: 'e000', slotId: 'S02', node: 0, vertices: 4410, triangles: 8640 },
            { elementId: 'e002', slotId: 'S03', node: 2, vertices: 9800, triangles: 17280, instances: { placed: 52, skippedOutside: 2 }, support: { test: 'periodic peak', value: 4.2, limit: 3 } }
        ],
        dropped: [{ elementId: 'e001', slotId: 'S01', checks: [{ check: 'edge contrast', value: 1.1, limit: 1.5, unit: 'ratio', message: 'not visible in the tile photo' }] }],
        degradedSlots: ['S01'],
        counts: { vertices: 14210, triangles: 25920 },
        timingsMs: { resolve: 12, build: 310 }
    };
}

export function flattenStats(): FlattenStats {
    return {
        schema: 'scratchbox.flatten-stats/1', inputTriangles: 12600, keptTriangles: 2616,
        isolate: { footprintAreaM2: 289.3, dilationM: 4, droppedTriangles: 9984 },
        planes: 23, movedVertices: 1410, maxMoveM: 0.098, p95MoveM: 0.061, bandM: 0.1, timingsMs: { total: 410 }
    };
}

export function canopyMask(): CanopyMask {
    return { schema: 'scratchbox.canopy-mask/1', cellM: 1, x0: -27, z0: -27, nx: 54, nz: 54, runs: [1200, 34, 900, 12, 770], canopyCells: 46, ms: 180 };
}

export function stripRoi(): StripRoi {
    return { schema: 'scratchbox.strip-roi/1', polygon: [[-25.15, -17.5], [25.15, -17.5], [25.15, 17.5], [-25.15, 17.5]] };
}

export function detailNodeExtras(): StagedNodeExtras {
    return {
        sb: {
            schema: 'scratchbox.staged-node/2', stage: 'detail', provenance: photoInferred(0.48), buildOrder: 2, buildCount: 3, revealKind: 'cells',
            reveal: { attribute: '_REVEAL', displacement: '_DISP', durationShare: 0.4 },
            ids: { slotId: 'S03', elementId: 'e002', surfaceId: 's05' }, replacesSurfaceIds: ['s05'],
            counts: { vertices: 9800, triangles: 17280 }
        }
    };
}

export function treeNodeExtras(): StagedNodeExtras {
    return {
        sb: {
            schema: 'scratchbox.staged-node/2', stage: 'trees',
            provenance: {
                label: PROVENANCE.grownToMeasuredCrown, measuredGeometry: true,
                method: 'SB-Veggie space colonisation grown to the measured crown', sources: [{ kind: 'stage-output', id: 'trees:788091ab' }],
                inferred: { crownBaseRatio: 0.32, trunkRadiusM: 0.21 }
            },
            buildOrder: 0, buildCount: 940, revealKind: 'grow',
            reveal: { attribute: '_REVEAL', displacement: null, durationShare: 1 },
            ids: { crownId: 17 }, counts: { vertices: 2210, triangles: 1494 }
        }
    };
}

export function rootExtras(): StagedGlbRootExtras {
    return { sb: { schema: 'scratchbox.staged-glb/2', stage: 'fit', stageKey: '7c1e04aa9d', buildingId: BUILDING_ID, frame: 'tile-enu' } };
}

export function vertexProvenance(): VertexProvenanceSummary {
    return {
        schema: 'scratchbox.vertex-provenance/1', attributes: ['_RECTIFY_DISPLACEMENT', '_PROUD_BLOCK', '_RELIEF_HEIGHT'], vertices: 3107,
        rectifyDisplacement: {
            maxM: 0.433,
            bands: [{ band: 'untouched', minM: 0, maxM: 0.01, vertices: 1522 }, { band: 'moved', minM: 0.01, maxM: 0.05, vertices: 932 }, { band: 'reshaped', minM: 0.05, vertices: 653 }]
        },
        proudBlocks: { keptAsScannedVertices: 64, snappedVertices: 12 },
        relief: { carvedVertices: 214, maxAbsHeightM: 0.12 }
    };
}

export function layers(): StagedLayer[] {
    const layer = (objectId: string, stage: string, l: string, order: number, provenance: ProvenanceRecord, extra: Partial<StagedLayer> = {}): StagedLayer => ({
        objectId, stage, layer: l, order, url: `/models/washington_square_arch_${stage}_${objectId.slice(4, 12)}.glb`, bytes: 410_000,
        provenance, provenanceLabels: [provenance.label], supersedes: [], revealAfter: [],
        reveal: { durationMs: 800, stagger: 1, crossfadeFrom: [] }, cached: false, builtAtMs: 1_760_540_000_000,
        counts: { vertices: 3107, triangles: 5980 }, ...extra
    });
    return [
        layer('stg-5d6c8812-l1', 'tiles', 'l1', 1, { label: PROVENANCE.asScanned, measuredGeometry: true, method: 'Google Photorealistic 3D Tiles, leaf LOD', sources: [{ kind: 'tile-extraction', id: 'extract:5d6c8812' }] }, {
            reveal: { durationMs: 800, stagger: 1, crossfadeFrom: [], orderUrl: '/models/washington_square_arch_tiles_5d6c8812.order.json' }
        }),
        layer('stg-90e96133-l2', 'remesh', 'l2', 2, measured(PROVENANCE.remeshed, 'tile_refine: rectify, flatten, photometric relief (inferred)', {
            note: 'rectify moved 49% of vertices over 1 cm (max 0.43 m); ground rebuilt under the arch: 68 closure triangles, 41 m², not in the scan; 214 vertices carved by photo relief (photo-inferred)'
        }), {
            provenanceLabels: [PROVENANCE.remeshed, PROVENANCE.asScanned, PROVENANCE.photoInferred], vertexProvenance: vertexProvenance(), supersedes: ['stg-5d6c8812-l1'],
            reveal: { durationMs: 600, stagger: 0, crossfadeFrom: ['stg-5d6c8812-l1'] }
        }),
        layer('stg-7c1e04aa-l3b', 'fit', 'l3b', 3, measured(PROVENANCE.fitted, 'scan_fit'), {
            provenanceLabels: [PROVENANCE.fitted, PROVENANCE.fittedUnobserved], revealAfter: ['stg-90e96133-l2'],
            reveal: { durationMs: 900, stagger: 1, crossfadeFrom: ['stg-90e96133-l2'] }, counts: { vertices: 1124, triangles: 620 }
        }),
        layer('stg-788091ab-l5x', 'trees', 'l5x', 5, { label: PROVENANCE.asScanned, measuredGeometry: true, method: 'the scanned crowns strip removed, put back as downloaded', sources: [{ kind: 'stage-output', id: 'trees-measure:788091ab' }] }, {
            revealAfter: ['stg-90e96133-l2'], reveal: { durationMs: 1500, stagger: 0.3, crossfadeFrom: [] }
        })
    ];
}

export function visionDegradation(): DegradationRecord {
    return {
        id: 'd-vision', stage: 'vision', part: { description: 'facade detail of the arch', buildingId: BUILDING_ID },
        intended: 'photo-inferred detail', fellTo: 'the flat fitted face', provenanceAfter: PROVENANCE.fitted,
        reasonCode: 'vision_unavailable', reason: 'gemini-4-argon (thinking LOW) returned 503 twice; the fitted faces stay flat.',
        cause: { error: '503 UNAVAILABLE', at: 'ornament-vision' }, model: visionModelUse('failed'), transient: true,
        retry: { tool: 'google_3d_tiles_get_clay', args: { retryRunId: RUN_ID, retryStage: 'vision' }, reuses: ['tiles', 'remesh', 'fit', 'evidence'] },
        atMs: 1_760_540_012_400
    };
}

export function treesDegradation(): DegradationRecord {
    return {
        id: 'd-trees', stage: 'trees', part: { description: 'the 6 measured trees around the arch', objectId: 'stg-788091ab-l5x' },
        intended: 'trees grown to the measured crown', fellTo: 'the scanned trees put back', provenanceAfter: PROVENANCE.asScanned,
        reasonCode: 'trees_failed', reason: 'tile_vegetation plant exited with code 134; the scanned trees were put back as scanned.',
        transient: false, atMs: 1_760_540_009_100
    };
}

function stages(): StageSummary[] {
    const t = (ms: number, cached = false) => ({ startedAtMs: 1_760_540_000_000, endedAtMs: 1_760_540_000_000 + ms, ms, cached });
    return [
        { stage: 'tiles', order: 1, title: 'Google 3D Tiles', source: '9 leaf tiles around the arch (31 m)', status: 'committed', layerIds: ['stg-5d6c8812-l1'], timings: t(3100), degradationIds: [] },
        { stage: 'remesh', order: 2, title: 'Remeshed scan', source: 'tile_refine: 3,107 vertices', status: 'committed', layerIds: ['stg-90e96133-l2'], timings: t(900, true), degradationIds: [] },
        { stage: 'fit', order: 3, title: 'Scan-fitted rebuild', source: 'scan_fit: 23 primitives fitted to 2,616 scan triangles, 3.2 cm rms', status: 'committed', layerIds: ['stg-7c1e04aa-l3b'], timings: t(2200), degradationIds: [] },
        { stage: 'vision', order: -1, title: 'Reading the photos', source: 'gemini-4-argon (thinking LOW)', status: 'degraded', reason: 'the vision model returned 503 twice', layerIds: [], timings: t(12400), degradationIds: ['d-vision'] },
        { stage: 'trees', order: 5, title: 'Trees', source: 'tile_vegetation plant', status: 'degraded', reason: 'plant failed; the scanned trees were put back', layerIds: ['stg-788091ab-l5x'], timings: t(5400), degradationIds: ['d-trees'] }
    ];
}

export function stagedBuildState(): StagedBuildState {
    return {
        schema: 'scratchbox.staged-build/2', runId: RUN_ID, requestKey: 'washington square arch|isolate', artifactId: `scene-stg-${RUN_ID}`,
        place: { query: 'Washington Square Arch', resolvedAddress: 'Washington Square N, New York, NY 10011', lat: 40.73114, lng: -73.99707 },
        structure: { buildingId: BUILDING_ID, seed: [0.4, -1.2], geocodeToStructureM: 6.1, footprintAreaM2: 289.3, extractionRadiusM: 31, containmentRounds: 1, isolateIoU: 0.91 },
        runState: 'finished', updatedAtMs: 1_760_540_023_700,
        stages: stages(), layers: layers(), degradations: [visionDegradation(), treesDegradation()],
        provenanceLegend: [
            { label: PROVENANCE.fitted, color: '#0072B2', pattern: 'solid', description: 'fitted to the scan: 3.2 cm rms over 97% of the visible surface' },
            { label: PROVENANCE.grownToMeasuredCrown, color: '#009E73', pattern: 'solid', description: 'SB-Veggie trees grown to the measured crown' }
        ],
        visionModel: visionModelUse('failed'),
        attribution: ['Map data ©Google', 'Street View ©Google'],
        retry: { retryRunId: RUN_ID, stages: ['vision'] }
    };
}

export function stageEvent(): StageEvent {
    return {
        schema: 'scratchbox.stage-event/2', runId: RUN_ID, seq: 7, stage: 'fit', order: 3, status: 'committed',
        title: 'Scan-fitted rebuild', source: 'scan_fit: 23 primitives fitted to 2,616 scan triangles, 3.2 cm rms', progress: 1,
        patch: { upsertObjects: ['stg-7c1e04aa-l3b'], removeObjects: [], supersede: [] },
        layers: [layers()[2]], degradations: [], timings: { startedAtMs: 1_760_540_004_000, endedAtMs: 1_760_540_006_200, ms: 2200, cached: false, waitedForEngineMs: 0, breakdownMs: { planes: 310 } }
    };
}

export function stagedLocationResult(): StagedLocationResult {
    return {
        success: true, status: 'degraded',
        place: { query: 'Washington Square Arch', resolvedAddress: 'Washington Square N, New York, NY 10011', lat: 40.73114, lng: -73.99707, elevationM: 9.2 },
        structure: stagedBuildState().structure,
        extraction: { radiusM: 31, sizedTo: 'structure', leafTiles: 9, cached: true, ageDays: 1, geometricErrorM: 2.0064, texelM: 0.154, attribution: ['Map data ©Google'] },
        stages: stages(), degradations: [visionDegradation(), treesDegradation()],
        provenance: [{ label: PROVENANCE.remeshed, objects: 1, triangles: 5980 }, { label: PROVENANCE.fitted, objects: 1, triangles: 620, areaM2: 1180 }, { label: PROVENANCE.asScanned, objects: 1, triangles: 8840 }],
        remeshVertexProvenance: vertexProvenance(),
        structureFit: {
            buildingId: BUILDING_ID, accepted: true, primitives: 23, scanToFitRmsM: 0.032, fitToScanRmsM: 0.036, coverage: 0.97,
            passThroughAreaM2: 35.8, unobservedFaceAreaM2: 4.1, gates: structureFit().gates, corrections: [], reportPath: '.scratchbox/cache/scan_fit/7c1e04aa/structure_fit.json'
        },
        complexityGate: { passed: true, totalVertices: 4231, totalTriangles: 6600, violations: [], exemptions: ['vertex floor: measured rebuild (1,124 vertices; StructureFit 3fa9c2d1 accepted)'] },
        sourceLimits: sourceLimits(),
        timingsMs: { total: 23700, firstVisual: 3100, byStage: { tiles: 3100, remesh: 900, fit: 2200, vision: 12400 } },
        cache: { tiles: 'hit', remesh: 'hit', fit: 'miss', vision: 'bypassed' },
        artifact: { id: `scene-stg-${RUN_ID}`, type: '3d-scene' },
        digest: `Staged build degraded: tiles, remesh, fit committed; detail fell to flat faces (vision_unavailable, gemini-4-argon 503); retry retryRunId ${RUN_ID} stage vision.`,
        summary: 'The Washington Square Arch in clay from Google 3D Tiles: the remeshed scan and a scan-fitted rebuild of 23 primitives (3.2 cm rms to the scan).'
    };
}

/** Every contract and shared part with a valid example, by schema name. */
export function validExamples(): Array<[string, unknown]> {
    return [
        ['StructureFit', structureFit()],
        ['VisionOrnamentReply', visionReply()],
        ['OrnamentSpec', ornamentSpec()],
        ['OrnamentBuildReport', buildReport()],
        ['FlattenStats', flattenStats()],
        ['CanopyMask', canopyMask()],
        ['StripRoi', stripRoi()],
        ['StagedNodeExtras', detailNodeExtras()],
        ['StagedNodeExtras', treeNodeExtras()],
        ['StagedGlbRootExtras', rootExtras()],
        ['DegradationRecord', visionDegradation()],
        ['DegradationRecord', treesDegradation()],
        ['StagedBuildState', stagedBuildState()],
        ['StageEvent', stageEvent()],
        ['StagedLocationResult', stagedLocationResult()],
        ['vertexProvenance', vertexProvenance()],
        ['correction', correction()],
        ['visionModelUse', visionModelUse('failed')]
    ];
}
