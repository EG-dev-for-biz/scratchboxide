/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * street-objects/auto.ts: the automatic wiring of street-objects into a district build (orchestrator.ts's scene-
 * inventory step, gated by staged-switches.ts streetObjectsAuto). Real code paths throughout, no mocks:
 * - unsureClusters, the pure rule deciding which clusters are worth Street View's paid calls, at its exact boundaries;
 * - autoRebuildStreetObjects's cheap read (readBlobs, blobEvidence, districtOrtho) run for real, against a real glTF
 *   tile file and a real VisionModelChain whose underlying client is a scripted fake (the same pattern
 *   vision-model-chain.test.ts uses for the network boundary) -- never a mock of the function under test.
 *
 * rebuildStreetObjects itself (the Street View fetch, pano registration, and the native four-operator build) is not
 * exercised here: it needs a live Maps Imagery Grounding credential and a native C++ compile, which nothing else in
 * this suite does either (see street-objects.test.ts's own header). These tests instead prove the two gates that
 * decide whether that expensive path is ever reached: "nothing left unsure" and "Street View is not configured" each
 * stop before it, exactly as autoRebuildStreetObjects's control flow says they must.
 */

import { describe, expect, it } from 'vitest';
import { autoRebuildStreetObjects, STREET_OBJECTS_AUTO_DEFAULT_MAX_FAMILIES, unsureClusters } from '../src/node/3d-engine/staged-location/street-objects/auto';
import { BLOB_READ_PARAMS, type BlobReadReport } from '../src/node/3d-engine/staged-location/street-objects/blob-reader';
import { RESIDUAL_AUDIT_MEASURE_PARAMS, RESIDUAL_AUDIT_THRESHOLDS, type AuditedCluster, type ResidualAuditResult } from '../src/node/3d-engine/staged-location/residual-audit';
import { assembleGlb } from '../src/node/3d-engine/staged-location/glb-bytes';
import { VisionModelChain, type VisionGenAIClient } from '../src/node/gemini/vision-model-chain';
import { SB_FEATURE_SCHEMA, type SbFeature } from '../src/common/spatial/sb-feature-types';
import type { EvidenceLookup, VectorEvidence } from '../src/node/3d-engine/staged-location/vector-footprints';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ------------------------------------------------------------------------------------------------ fixtures

/** A minimal, real glTF tile: one untextured flat quad (two triangles) at y = 0, coloured by a plain material factor --
 * enough for readTileTriangles (tile-texture-transfer.ts) to read real triangles (a triangle with no colour information
 * at all is dropped), which is all districtOrtho / readBlobs need to draw their orthophoto. */
function tinyTileGlb(): Buffer {
    const z = [-50, 50];
    // two triangles covering [-50, 50] x [-50, 50] at y = 0
    const pos = Float32Array.from([
        z[0], 0, z[0], z[1], 0, z[0], z[1], 0, z[1],
        z[0], 0, z[0], z[1], 0, z[1], z[0], 0, z[1]
    ]);
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0, mode: 4 }] }],
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: 'VEC3' }],
        bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
        buffers: [{ byteLength: pos.byteLength }]
    };
    return assembleGlb(json, new Uint8Array(pos.buffer));
}

/** A real AuditedCluster: a bollard-sized upright at (x, z), height h, square in plan, standing on the ground (y = 0), with
 * every measure a real object's own numbers (the audit's own ramps, had they run), not placeholders a verdict would reject. */
function auditedCluster(id: number, x: number, z: number, h = 1.0, planM = 0.3): AuditedCluster {
    const half = planM / 2, triangles = 12;
    const feature: SbFeature = { schema: SB_FEATURE_SCHEMA, id: `cluster:${id}`, types: [], geometry: { type: 'box', frame: { origin: [x, 0, z], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1], extentsM: [planM, h, planM] } } as unknown as SbFeature['geometry'], provenance: { label: 'as-scanned', measuredGeometry: true } as unknown as SbFeature['provenance'] };
    return {
        id, triangles, areaM2: planM * planM, lo: [x - half, 0, z - half], hi: [x + half, h, z + half],
        frame: { origin: [x, 0, z], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1], extentsM: [planM, h, planM] },
        principal: { axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], extentsM: [planM, h, planM] },
        shape: { thinness: 0.5, elongation: 0.3, mainAxisVerticality: 0.95, sheetNormalVerticality: 0.5 },
        surface: { qualityMedian: 0.8, sliverShare: 0, maxEdgeM: 0.1, normalCoherence: 0.8, upShare: 0.1, downShare: 0, sideShare: 0.9, boundaryEdgeShare: 0.1, copyShare: 0 },
        volume: { envelopeM3: planM * planM * h, boxM3: planM * planM * h, fill: 1, cellM: 0.05 },
        attachment: {
            minGapToSolidM: 0, medianGapToSolidM: 0, contactShare: 1, contactAlongShare: 1, insideShare: 0, gapToGroundM: 0, footprintCells: 1, groundedShare: 1, enclosedShare: 0, openBelowShare: 0,
            overhangShare: 0, medianDropM: 0, maxDropM: 0, supportY: 0, baseAboveSupportM: 0, topAboveSupportM: h, baseAboveGroundM: 0, topAboveGroundM: h
        },
        symmetry: { radialSymmetry: 0.8, radiusMedianM: half, slicesUsed: 4, crossSectionConstancy: 0.8, periodicity: 0, periodM: 0 },
        slices: [], photo: null, triangleIds: Array.from({ length: triangles }, (_, i) => id * 100 + i),
        verdict: 'real-object', confidence: 0.9, reason: 'a real object by the audit\'s own ramps (test fixture)',
        scores: { spike: 0, sliver: 0, floating: 0, curtain: 0, offset: 0, sky: 0, artefact: 0.1, real: 0.9 },
        skyShare: null, typeLabels: [], feature
    };
}

function residualAudit(clusters: AuditedCluster[]): ResidualAuditResult {
    return {
        schema: 'scratchbox.residual-audit-result/1', version: 'test', sources: [{ node: 'residue', firstTriangle: 0, triangles: clusters.reduce((n, c) => n + c.triangles, 0) }],
        candidateTriangles: clusters.reduce((n, c) => n + c.triangles, 0), solidTriangles: 0, groundY: 0, params: RESIDUAL_AUDIT_MEASURE_PARAMS, thresholds: RESIDUAL_AUDIT_THRESHOLDS,
        clusters, counts: { clusters: clusters.length, realObjects: clusters.length, artefacts: 0, unsure: 0, removedTriangles: 0, keptTriangles: 0, removedAreaM2: 0 },
        candidates: clusters.map(c => c.id), notes: [], ms: 0, dataNote: 'test fixture'
    };
}

const openLook: Pick<EvidenceLookup, 'buildingAt' | 'roadAt' | 'landuseAt'> = { buildingAt: () => 0, roadAt: () => false, landuseAt: () => [] };
const emptyVector: Pick<VectorEvidence, 'buildings' | 'roads'> = { buildings: [], roads: [] };

/** A VisionModelChain whose underlying client answers every call with `reply(callIndex)`, scripted rather than scraping the
 * prompt -- the same boundary-fake pattern vision-model-chain.test.ts uses, never a mock of readBlobs or blobEvidence. */
function fakeVisionChain(reply: (callIndex: number) => string): VisionModelChain<string> {
    let n = 0;
    const client: VisionGenAIClient = {
        models: {
            generateContent: async params => ({
                candidates: [{ content: { role: 'model', parts: [{ text: reply(n++) }] }, finishReason: 'STOP' }],
                modelVersion: `${(params as { model: string }).model}-001`
            }) as never
        }
    };
    return new VisionModelChain<string>({ client, candidates: ['test-vision-model'] });
}

// ------------------------------------------------------------------------------------------------ unsureClusters

describe('unsureClusters: which blobs are worth Street View\'s paid calls', () => {
    const blobs = (over: Partial<BlobReadReport>): BlobReadReport => ({
        schema: 'scratchbox.blob-read/1', version: 'test', evidence: [], leftOut: [], labels: [], sheets: [],
        stats: { clusters: 0, read: 0, confident: 0, unsure: 0, inFootprint: 0, artefacts: 0, fragments: 0, visionCalls: 0, storeHits: 0, orthoMs: 0, readMs: 0 }, ...over
    });
    const label = (over: Partial<BlobReadReport['labels'][number]>) => ({ clusterId: 1, label: 'bollard', confidence: 0.9, standing: 0.9, permanent: 0.9, scanFault: 0, sheet: 0, provenance: 'photo-inferred' as const, ...over });

    it('asks Street View for a label under the confident bar, standing up, not a scan fault', () => {
        expect(unsureClusters(blobs({ labels: [label({ confidence: BLOB_READ_PARAMS.confidentAt - 0.01 })] }))).toEqual([1]);
    });
    it('does not ask for a confident label, even standing and real', () => {
        expect(unsureClusters(blobs({ labels: [label({ confidence: BLOB_READ_PARAMS.confidentAt })] }))).toEqual([]);
    });
    it('does not ask for an unconfident label that lies flat (standing under 0.5)', () => {
        expect(unsureClusters(blobs({ labels: [label({ confidence: 0.1, standing: 0.49 })] }))).toEqual([]);
    });
    it('does not ask for an unconfident label the read itself thinks is a scan fault', () => {
        expect(unsureClusters(blobs({ labels: [label({ confidence: 0.1, scanFault: 0.5 })] }))).toEqual([]);
    });
    it('asks for every cluster the cheap read reached but labelled nothing (parsing dropped it), unless it was explicitly left out', () => {
        const ev = (id: number) => ({ clusterId: id }) as BlobReadReport['evidence'][number];
        expect(unsureClusters(blobs({ evidence: [ev(5), ev(6)], leftOut: [{ clusterId: 6, reason: 'a fragment' }] }))).toEqual([5]);
    });
    it('is empty with nothing read at all', () => {
        expect(unsureClusters(blobs({}))).toEqual([]);
    });
});

// ------------------------------------------------------------------------------------------------ autoRebuildStreetObjects

describe('autoRebuildStreetObjects: the cheap read runs for real, Street View only when something is unsure and configured', () => {
    function tmpDir(): string {
        return fs.mkdtempSync(path.join(os.tmpdir(), 'street-objects-auto-'));
    }
    function tileFile(dir: string): string {
        const f = path.join(dir, 'tile.glb');
        fs.writeFileSync(f, tinyTileGlb());
        return f;
    }

    it('runs the cheap read over real geometry and a real (scripted) vision call; confident labels leave nothing for Street View, which is never reached', async () => {
        const dir = tmpDir();
        const audit = residualAudit([auditedCluster(1, 5, 5), auditedCluster(2, 5, 15)]);
        const vision = fakeVisionChain(() => JSON.stringify({
            blobs: [
                { patch: 1, label: 'bollard', confidence: 0.95, standing: 0.95, permanent: 0.95, scanFault: 0.02 },
                { patch: 2, label: 'lamp post', confidence: 0.9, standing: 0.9, permanent: 0.9, scanFault: 0.02 }
            ]
        }));
        const result = await autoRebuildStreetObjects({
            origin: { lat: 0, lng: 0, heightMeters: 0 }, audit, scanGlb: tileFile(dir), tileGlb: tileFile(dir), vector: emptyVector, look: openLook,
            vision, outDir: dir
        });
        expect(result.blobs.stats.read).toBe(2);
        expect(result.blobs.labels).toHaveLength(2);
        expect(result.blobs.labels.every(l => l.confidence >= BLOB_READ_PARAMS.confidentAt)).toBe(true);
        expect(result.objects).toBeUndefined();
        expect(result.skipped).toMatch(/nothing unsure/);
        // the cheap read's own report is written for real, readable back
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'blob_read.json'), 'utf8')).labels).toHaveLength(2);
    });

    it('leaves a low-confidence, standing, not-a-scan-fault blob unsure, but never reaches Street View with no streetView dep configured', async () => {
        const dir = tmpDir();
        const audit = residualAudit([auditedCluster(1, 5, 5)]);
        const vision = fakeVisionChain(() => JSON.stringify({ blobs: [{ patch: 1, label: 'something', confidence: 0.2, standing: 0.9, permanent: 0.8, scanFault: 0.05 }] }));
        const result = await autoRebuildStreetObjects({
            origin: { lat: 0, lng: 0, heightMeters: 0 }, audit, scanGlb: tileFile(dir), tileGlb: tileFile(dir), vector: emptyVector, look: openLook,
            vision, outDir: dir
            // no streetView: the gate must stop here, not throw trying to fetch panos
        });
        expect(unsureClusters(result.blobs)).toEqual([1]);
        expect(result.objects).toBeUndefined();
        expect(result.skipped).toMatch(/no Street View service is configured/);
    });

    it('leaves the same blob unsure but stops on missing credentials when a streetView dep is given without them', async () => {
        const dir = tmpDir();
        const audit = residualAudit([auditedCluster(1, 5, 5)]);
        const vision = fakeVisionChain(() => JSON.stringify({ blobs: [{ patch: 1, label: 'something', confidence: 0.2, standing: 0.9, permanent: 0.8, scanFault: 0.05 }] }));
        const result = await autoRebuildStreetObjects({
            origin: { lat: 0, lng: 0, heightMeters: 0 }, audit, scanGlb: tileFile(dir), tileGlb: tileFile(dir), vector: emptyVector, look: openLook,
            vision, outDir: dir, streetView: {} as never
        });
        expect(result.objects).toBeUndefined();
        expect(result.skipped).toMatch(/Street View credentials/);
    });

    it('exports a sane default family cap', () => {
        expect(STREET_OBJECTS_AUTO_DEFAULT_MAX_FAMILIES).toBeGreaterThan(0);
        expect(STREET_OBJECTS_AUTO_DEFAULT_MAX_FAMILIES).toBeLessThanOrEqual(50);
    });
});
