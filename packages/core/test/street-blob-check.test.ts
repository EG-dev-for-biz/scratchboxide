/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { answeredBlobKeys, headWord, BLOB_EVIDENCE_FIELDS, BLOB_LABELS_FILE, BLOB_PATCHES_DIR, BLOB_READ_FILE, BlobCheckService, findBlobCheckSources, labelWords } from '../src/node/3d-engine/staged-location/street-objects/blob-check';

const evidence = (id: number) => ({
    clusterId: id, centre: [id, 0], box: { origin: [id, 0], xAxis: [1, 0], extentsM: [1, 1] }, verdict: 'real-object', auditConfidence: 0.8, heightM: 1, standM: 1, planM: [1, 0.5], areaM2: 2, triangles: 10,
    verticality: 0.9, thinness: 0.6, elongation: 0.4, radialSymmetry: 0.8, radiusMedianM: 0.3, periodM: 0, upShare: 0.2, sideShare: 0.8, groundedShare: 0.9,
    vector: { inFootprint: false, touchesFootprint: false, toBuildingM: 4, toRoadM: 6, onCarriageway: false, landuse: [] }
});
const label = (id: number, text: string, confidence: number, scanFault = 0) => ({ clusterId: id, label: text, confidence, standing: 1, permanent: 0.2, scanFault, sheet: 0, provenance: 'photo-inferred' });

/** A blob read on disk: 8 cars (2 sure), 6 other things (2 sure), 4 scan faults, each with its patch. */
function readOnDisk(origin = { lat: 40.7487, lng: -73.9908 }): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-check-')), dir = path.join(root, 'run1');
    fs.mkdirSync(path.join(dir, BLOB_PATCHES_DIR), { recursive: true });
    const labels = [
        ...[0.95, 0.9, 0.7, 0.6, 0.5, 0.45, 0.4, 0.65].map((c, i) => label(i + 1, i % 2 ? 'dark parked cars' : 'parked car', c)),
        ...[0.95, 0.9, 0.5, 0.4, 0.55, 0.62].map((c, i) => label(20 + i, ['steel bollard', 'street planter', 'bench', 'kiosk', 'sign post', 'bin'][i], c)),
        ...[0.9, 0.5, 0.45, 0.4].map((c, i) => label(40 + i, 'building facade sliver', c, 0.9))
    ];
    for (const l of labels) fs.writeFileSync(path.join(dir, BLOB_PATCHES_DIR, `${l.clusterId}.jpg`), Buffer.from([0xff, 0xd8, 0xff, l.clusterId]));
    fs.writeFileSync(path.join(dir, BLOB_READ_FILE), JSON.stringify({ origin, evidence: labels.map(l => evidence(l.clusterId)), labels }));
    return root;
}

describe('the blob check', () => {
    it('groups by the model\'s own words', () => {
        expect(labelWords('Two parked cars, merged')).toEqual(['parked', 'car', 'merged']);
        expect(labelWords('a bus')).toEqual(['bus']);
        expect(headWord('parked car')).toBe('car');
        expect(headWord('two parked cars merged')).toBe('car');
        expect(headWord('Traffic cone with reflective band')).toBe('cone');
        expect(headWord('orange traffic cone')).toBe('cone');
        expect(headWord('parked van or small truck')).toBe('van');
    });

    it('draws nine patches: unsure blobs, one sure yes and one sure no, and stores the answers with each blob\'s measures', () => {
        const root = readOnDisk(), labels = path.join(root, 'labels');
        const sources = findBlobCheckSources([root]);
        expect(sources).toHaveLength(1);
        const svc = new BlobCheckService(() => sources, labels);
        const { check } = svc.next(7);
        expect(check).toBeDefined();
        expect(check!.tiles).toHaveLength(9);
        expect(check!.detail).toBe(`${check!.lead} ${check!.subject}.`);
        const roles = svc.inspect(check!.id)!;
        expect(roles.filter(r => r.role === 'yes')).toHaveLength(1);
        expect(roles.filter(r => r.role === 'no')).toHaveLength(1);
        expect(roles.filter(r => r.role === 'uncertain')).toHaveLength(7);
        // the patch bytes are the read's own
        const any = roles[0];
        expect(Buffer.from(check!.tiles[0].jpg, 'base64')[3]).toBe(any.clusterId);
        // answer the controls right, and mark one unsure blob
        const yes = roles.find(r => r.role === 'yes')!, unsure = roles.find(r => r.role === 'uncertain')!;
        const r = svc.answer(check!.id, [yes.tileId, unsure.tileId]);
        expect(r).toEqual({ stored: 7, controlsPassed: true });
        const rows = fs.readFileSync(path.join(labels, BLOB_LABELS_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l));
        expect(rows).toHaveLength(7);
        expect(rows.filter(x => x.yes)).toHaveLength(1);
        expect(rows.every(x => x.trusted && x.subject === check!.subject && x.evidence.length === BLOB_EVIDENCE_FIELDS.length)).toBe(true);
        expect(answeredBlobKeys(labels).size).toBe(7);
        expect(() => svc.answer(check!.id, [])).toThrow(/not known/);
    });

    it('keeps answers aside when a control is missed, stores nothing for a skip, and never asks an answered blob again', () => {
        const root = readOnDisk(), labels = path.join(root, 'labels');
        const svc = new BlobCheckService(() => findBlobCheckSources([root]), labels);
        const a = svc.next(3).check!;
        expect(svc.answer(a.id, []).controlsPassed).toBe(false);
        const b = svc.next(3).check;
        if (b) {
            const asked = new Set(svc.inspect(b.id)!.filter(r => r.role === 'uncertain').map(r => r.clusterId));
            const first = fs.readFileSync(path.join(labels, BLOB_LABELS_FILE), 'utf8').trim().split('\n').map(l => JSON.parse(l).clusterId as number);
            expect(first.some(id => asked.has(id))).toBe(false);
            expect(svc.answer(b.id, [], true)).toEqual({ stored: 0, controlsPassed: false });
        }
    });

    it('asks from reads near the place only: a building elsewhere gets no blob check', () => {
        const root = readOnDisk();
        const svc = new BlobCheckService(() => findBlobCheckSources([root]), path.join(root, 'labels'));
        expect(svc.next(1, { lat: 40.7488, lng: -73.9907 }).check).toBeDefined();
        expect(svc.next(1, { lat: 51.5, lng: -0.12 }).reason).toMatch(/no blob read within/);
    });
});
