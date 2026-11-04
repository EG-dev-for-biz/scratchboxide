/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** The place evidence record (common/spatial/place-evidence.ts): its checks, the merge by source across runs, the common pick. */

import { describe, expect, it } from 'vitest';
import { checkEvidence, evidenceKey, mergeEvidence, pickEvidence, PLACE_EVIDENCE_SCHEMA, type EvidenceRecord } from '../src/common/spatial/place-evidence';

const rec = (over: Partial<EvidenceRecord> & { runId?: string; atMs?: number; sourceId?: string; kind?: string; conf?: number } = {}): EvidenceRecord => ({
    schema: PLACE_EVIDENCE_SCHEMA, subject: over.subject ?? 'building/b1/facade/7', measure: over.measure ?? 'wall.visibleShare', value: over.value ?? 0.4, unit: 'share',
    source: over.source ?? { kind: over.kind ?? 'street-view', id: over.sourceId ?? 'pano-A', capturedAt: '2023-07', pose: { position: [1, 1.8, -20], headingDeg: 12 } },
    provenance: { label: 'measured', confidence: over.conf ?? 0.7 },
    run: { runId: over.runId ?? 'run-1', code: { commit: 'abc1234' }, atMs: over.atMs ?? 1_000 }
});

describe('the place evidence record', () => {
    it('keeps numbers and ids only: never bytes, encoded images or a Street View source without its date', () => {
        expect(checkEvidence(rec())).toEqual([]);
        expect(checkEvidence({ ...rec(), value: [1, Number.NaN] })).toContain('value holds something other than finite numbers');
        expect(checkEvidence({ ...rec(), value: [1, 2, 3], shape: [2, 2] })).toContain('shape 2x2 does not match 3 values');
        expect(checkEvidence({ ...rec(), provenance: { label: 'measured', confidence: 1.2 } })).toContain('provenance.confidence is not in [0, 1]');
        expect(checkEvidence(rec({ source: { kind: 'street-view', id: 'pano-B' } }))).toContain('a Street View source names no capture date');
        expect(checkEvidence(rec({ source: { kind: 'tile-photo', id: `data:image/png;base64,${'A'.repeat(40)}` } })).join()).toContain('source.id holds data');
        expect(checkEvidence({ ...rec(), source: { kind: 'tile-photo', id: 'leaf', image: 'iVBORw0K'.repeat(40) } as never }).join()).toContain('holds data');
        expect(checkEvidence({ ...rec(), source: { kind: 'tile-photo', id: 'leaf', bytes: new Uint8Array(4) } as never }).join()).toContain('holds bytes');
    });

    it('merges by source across runs: a second source and a later view add records, the same one is kept once, nothing is removed', () => {
        const run1 = [rec(), rec({ kind: 'scan', sourceId: 'extract-1', source: { kind: 'scan', id: 'extract-1' }, value: 0.1, conf: 0.9 })];
        const run2 = [rec({ runId: 'run-2', atMs: 2_000, value: 0.8, conf: 0.8 }), rec({ subject: 'street-object/hydrant-3', measure: 'height.m', value: 0.9, sourceId: 'pano-C' })];
        const merged = mergeEvidence(run1, run2);
        expect(merged).toHaveLength(4);
        // merging again changes nothing; the copy first written stands
        expect(mergeEvidence(merged, [{ ...run1[0], value: 0.99 }])).toEqual(merged);
        expect(merged.find(r => evidenceKey(r) === evidenceKey(run1[0]))!.value).toBe(0.4);
        // a run that saw less erases nothing
        expect(mergeEvidence(merged, [])).toHaveLength(4);
        // the common pick: per source its newest record, then the most confident
        expect(pickEvidence(merged, 'building/b1/facade/7', 'wall.visibleShare')!.source.kind).toBe('scan');
        const sv = merged.filter(r => r.source.kind === 'street-view' && r.subject === 'building/b1/facade/7');
        expect(sv.map(r => r.value)).toEqual([0.4, 0.8]);
        expect(pickEvidence(sv, 'building/b1/facade/7', 'wall.visibleShare')!.value).toBe(0.8);
        expect(pickEvidence(merged, 'building/b9', 'height.m')).toBeUndefined();
    });
});
