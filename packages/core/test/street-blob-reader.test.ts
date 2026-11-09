/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { blobEvidence, blobReadPrompt, blobsToRead, contactSheet, parseBlobReading, patchSideM, BLOB_READ_PARAMS } from '../src/node/3d-engine/staged-location/street-objects/blob-reader';
import type { ResidualAuditResult } from '../src/node/3d-engine/staged-location/residual-audit';

/** A cluster with the measures the read takes, as a district audit writes it. */
const cluster = (id: number, x: number, z: number, w: number, d: number, h: number, verdict = 'real-object') => ({
    id, triangles: 12, areaM2: 2 * (w * d + w * h + d * h), lo: [x - w / 2, 0, z - d / 2], hi: [x + w / 2, h, z + d / 2],
    frame: { origin: [x, 0, z], xAxis: [1, 0, 0], yAxis: [0, 1, 0], zAxis: [0, 0, 1], extentsM: [w, h, d] },
    shape: { thinness: 0.8, elongation: 0.5, mainAxisVerticality: h > w ? 0.95 : 0.1, sheetNormalVerticality: 0.1 },
    surface: { upShare: 0.2, sideShare: 0.8 }, symmetry: { radialSymmetry: 0.9, radiusMedianM: w / 2, periodM: 0 },
    attachment: { groundedShare: 0.9, topAboveSupportM: h }, verdict, confidence: 0.8
});

// a building footprint over x in [10, 20], z in [-5, 5]; a road centreline along z = 8
const square = (x0: number, z0: number, x1: number, z1: number) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] as Array<[number, number]>;
const vector = { buildings: [{ id: 'b', parts: [[square(10, -5, 20, 5)]] }], roads: [[[-50, 8], [50, 8]]] as Array<Array<[number, number]>> };
const look = {
    buildingAt: (x: number, z: number) => (x >= 10 && x <= 20 && z >= -5 && z <= 5 ? 0 : -1),
    roadAt: (_x: number, z: number) => Math.abs(z - 8) < 3,
    landuseAt: () => undefined
};
const audit = {
    clusters: [cluster(1, 0, 0, 0.3, 0.3, 1.1), cluster(2, 15, 0, 1, 1, 2), cluster(3, 9.8, 0, 1, 1, 2), cluster(4, 0, 8, 2, 4, 1.5), cluster(5, -5, 0, 3, 3, 0.4, 'scan-artefact')],
    groundY: 0
} as unknown as ResidualAuditResult;

describe('blobs read from the cheap evidence first', () => {
    it('measures each blob and places it against the map: building line, road centreline, carriageway, footprint', () => {
        const ev = blobEvidence(audit, look, vector);
        const by = new Map(ev.map(e => [e.clusterId, e]));
        expect(by.get(1)!.heightM).toBeCloseTo(1.1, 3);
        expect(by.get(1)!.vector.toBuildingM).toBeCloseTo(10, 3);
        expect(by.get(1)!.vector.toRoadM).toBeCloseTo(8, 3);
        expect(by.get(1)!.vector.onCarriageway).toBe(false);
        expect(by.get(2)!.vector.inFootprint).toBe(true);
        expect(by.get(2)!.vector.toBuildingM!).toBeLessThan(0);
        // the box of cluster 3 reaches over the footprint's edge at x = 10
        expect(by.get(3)!.vector.inFootprint).toBe(false);
        expect(by.get(3)!.vector.touchesFootprint).toBe(true);
        expect(by.get(4)!.vector.onCarriageway).toBe(true);
    });

    it('leaves out a building\'s parts (inside or touching a footprint) and the audit\'s scan artefacts, with why', () => {
        const { read, leftOut } = blobsToRead(blobEvidence(audit, look, vector));
        expect(read.map(e => e.clusterId)).toEqual([1, 4]);
        expect(leftOut.find(o => o.clusterId === 2)!.reason).toMatch(/inside a building footprint/);
        expect(leftOut.find(o => o.clusterId === 3)!.reason).toMatch(/touching a building footprint/);
        expect(leftOut.find(o => o.clusterId === 5)!.reason).toMatch(/scan artefact/);
    });

    it('draws a numbered contact sheet of patches from the orthophoto, each blob\'s plan box outlined', () => {
        const { read } = blobsToRead(blobEvidence(audit, look, vector));
        // a grey orthophoto, 0.1 m a texel over x, z in [-20, 20]
        const W = 400, rgba = new Uint8Array(W * W * 4).fill(100);
        const sheet = contactSheet({ width: W, height: W, rgba, texelM: 0.1, triangles: 0, ms: 0, x0: -20, z0: -20 }, read);
        const P = BLOB_READ_PARAMS;
        expect(sheet.width).toBe(P.sheetColumns * P.patchPx + (P.sheetColumns + 1) * 6);
        expect(sheet.height).toBe(P.patchPx + 2 * 6);
        let magenta = 0, white = 0;
        for (let i = 0; i < sheet.rgba.length; i += 4) {
            if (sheet.rgba[i] === 255 && sheet.rgba[i + 1] === 0 && sheet.rgba[i + 2] === 255) magenta++;
            if (sheet.rgba[i] === 255 && sheet.rgba[i + 1] === 255 && sheet.rgba[i + 2] === 255) white++;
        }
        expect(magenta).toBeGreaterThan(100);
        expect(white).toBeGreaterThan(0);
        expect(patchSideM(read[0])).toBe(P.minPatchM);
    });

    it('asks with the measures and the map in numbers, and gives no list of things to choose from', () => {
        const { read } = blobsToRead(blobEvidence(audit, look, vector));
        const prompt = blobReadPrompt(read);
        expect(prompt).toMatch(/Patch 1: 5 m across; 1\.1 m tall/);
        expect(prompt).toMatch(/10\.0 m from the nearest building line; 8\.0 m from the nearest road centreline/);
        expect(prompt).toMatch(/Patch 2:.*on the carriageway/);
        expect(prompt).toMatch(/in a few plain words of your own/);
    });

    it('takes the labels the reply gives and never guesses one it leaves out', () => {
        const { read } = blobsToRead(blobEvidence(audit, look, vector));
        const parsed = parseBlobReading('```json\n{"blobs": [{"patch": 1, "label": "a short steel post", "confidence": 0.82, "standing": 1, "permanent": 0.9, "scanFault": 0.05}, {"patch": 9, "label": "out of range"}]}\n```', read, 3);
        expect('error' in parsed).toBe(false);
        const labels = parsed as Exclude<typeof parsed, { error: string }>;
        expect(labels).toHaveLength(1);
        expect(labels[0]).toMatchObject({ clusterId: 1, label: 'a short steel post', confidence: 0.82, sheet: 3, provenance: 'photo-inferred' });
        expect('error' in (parseBlobReading('not json', read, 0) as object)).toBe(true);
    });
});
