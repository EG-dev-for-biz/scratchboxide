/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What the model and the user are told about a staged build: one case per rule of STAGED_SUMMARY_RULES, the digest
 * (≤ 200 characters, status and degradations first, then the retry handle) and the context line a later turn carries.
 */

import { describe, it, expect } from 'vitest';
import {
    PHOTO_INFERRED_FORBIDDEN_WORDS,
    STAGED_SUMMARY_RULES,
    SUMMARY_FORBIDDEN_ADJECTIVES,
    type DegradationRecord
} from '../src/common/spatial/staged-location-contracts';
import { stagedBuildContext, stagedDigest, summarizeStagedBuild, type StagedSummaryInput } from '../src/node/3d-engine/staged-location/staged-summary';
import { correction, ornamentSpec, RUN_ID, stagedBuildState, stagedLocationResult, visionModelUse } from './helpers/staged-location-fixtures';

function input(over: Partial<StagedSummaryInput> = {}): StagedSummaryInput {
    const { digest: _d, summary: _s, artifact: _a, ...rest } = stagedLocationResult();
    return { ...rest, runId: RUN_ID, ...over };
}

/** The arch with detail built: vision answered, 14 elements. */
function withDetail(): StagedSummaryInput {
    const base = input();
    const stages = base.stages.map(s => s.stage === 'vision' ? { ...s, status: 'committed' as const, reason: undefined, degradationIds: [] } : s);
    stages.push({ stage: 'detail', order: 4, title: 'Photo-inferred detail', source: 'scan_fit ornament', status: 'committed', layerIds: ['stg-1a2b3c4d-l4'], timings: { startedAtMs: 0, ms: 400, cached: false }, degradationIds: [] });
    return {
        ...base, stages, degradations: base.degradations.filter(d => d.stage !== 'vision'),
        ornament: {
            elements: 14, slotsFilled: 6, slotsEmpty: 3, confidence: { min: 0.42, median: 0.66, max: 0.81 },
            evidence: { tileOrthos: 4, streetView: 3 }, model: visionModelUse('answered'), revisionPass: false, dropped: 3, specPath: 'x'
        },
        droppedNotResolvable: 3
    };
}

const ruleCase: Record<string, () => void> = {
    digest: () => {
        const d = stagedDigest(input());
        expect(d.length).toBeLessThanOrEqual(200);
        // both degradations do not fit in full: each by stage and reason code
        expect(d).toBe(`Staged build degraded: tiles, remesh, fit committed; vision: vision_unavailable (gemini-4-argon 503); trees: trees_failed; retry retryRunId ${RUN_ID} stage vision.`);
        // one fits in full: what fell to what
        const one = stagedDigest(input({ degradations: [input().degradations[0]] }));
        expect(one).toBe(`Staged build degraded: tiles, remesh, fit committed; vision fell to the flat fitted face (vision_unavailable, gemini-4-argon 503); retry retryRunId ${RUN_ID} stage vision.`);
        // many degradations: still ≤ 200, status first, retry handle last, the rest counted
        const many: DegradationRecord[] = Array.from({ length: 12 }, (_, i) => ({ ...input().degradations[1], id: `d-${i}`, part: { description: `part ${i}` } }));
        const crowded = stagedDigest(input({ degradations: [input().degradations[0], ...many] }));
        expect(crowded.length).toBeLessThanOrEqual(200);
        expect(crowded).toMatch(/^Staged build degraded: /);
        expect(crowded).toMatch(/\+\d+ more degraded; retry retryRunId a1b2c3d4 stage vision\.$/);
    },
    mounted: () => {
        const s = summarizeStagedBuild(withDetail()).summary;
        expect(s.startsWith('Washington Square Arch (Washington Square N, New York, NY 10011, 6.1 m from the geocoded point) in clay from Google 3D Tiles, extracted 31.0 m around the structure: the remeshed scan, a scan-fitted rebuild of 23 primitives (3.2 cm rms to the scan, 97% of the visible surface; 4.1 m² of faces placed by the fit without scan samples) and 14 photo-inferred details.')).toBe(true);
        // a district, with trees, and the scanned trees put back after a failed tree stage
        const district = input({ structure: undefined, structureFit: undefined, extraction: { ...input().extraction, sizedTo: 'request', radiusM: 250 }, treesPutBack: { triangles: 614_622, crowns: 852, reason: 'plant failed' } });
        district.place = { ...district.place, query: 'Central Park', resolvedAddress: 'New York, NY, USA' };
        expect(summarizeStagedBuild(district).summary.startsWith('Central Park (New York, NY, USA) in clay from Google 3D Tiles within 250 m: the remeshed scan and the scanned trees put back as scanned.')).toBe(true);
    },
    'evidence-and-model': () => {
        const s = summarizeStagedBuild(withDetail()).summary;
        expect(s).toContain('The details were read by gemini-4-argon (thinking low, 12.4 s) from 4 facade views of the tile photos and 3 Street View images (© Google).');
        const fallback = withDetail();
        fallback.ornament!.model = { ...visionModelUse('answered'), used: 'gemini-3.8-flash', skipped: [{ model: 'gemini-4-argon', reason: 'gemini-4-argon failed (unsupported 404): not found' }] };
        expect(summarizeStagedBuild(fallback).summary).toContain('gemini-3.8-flash read them because gemini-4-argon was not served (404).');
        // a failure names the model and thinking that were tried
        expect(summarizeStagedBuild(input()).summary).toContain('No detail: gemini-4-argon (thinking low) failed: 503 UNAVAILABLE (twice); the fitted faces stay flat.');
    },
    'photo-inferred-wording': () => {
        const s = summarizeStagedBuild(withDetail()).summary;
        expect(s).toContain('They are photo-inferred, confidence 0.42–0.81; 3 elements were dropped as not resolvable in their evidence.');
        const sentence = s.split('. ').find(x => x.startsWith('They are photo-inferred'))!;
        for (const w of PHOTO_INFERRED_FORBIDDEN_WORDS) expect(sentence.toLowerCase()).not.toMatch(new RegExp(`\\b${w}\\b`));
    },
    corrections: () => {
        const i = withDetail();
        i.structureFit = { ...i.structureFit!, corrections: [correction(), { ...correction(), primitiveId: 'p09', check: { ...correction().check, accepted: false } }] };
        const s = summarizeStagedBuild(i).summary;
        expect(s).toContain('Primitive p03 was photo-corrected from riseToSpan 0.39 to 0.50; its scan residual went from 3.9 cm to 22.3 cm rms, within the 31 cm tolerance the photos allow.');
        expect(s).not.toContain('p09'); // a rejected correction changed nothing
    },
    degradations: () => {
        const s = summarizeStagedBuild(input()).summary;
        expect(s).toContain('Facade detail of the arch fell to the flat fitted face: gemini-4-argon (thinking LOW) returned 503 twice; the fitted faces stay flat.');
        const many: DegradationRecord[] = Array.from({ length: 8 }, (_, i) => ({ ...input().degradations[1], id: `d-${i}`, part: { description: `element e0${i}` } }));
        const passThrough: DegradationRecord[] = Array.from({ length: 7 }, (_, i) => ({ ...input().degradations[1], id: `d-pt-${i}`, stage: 'fit', reasonCode: 'pass_through', part: { description: `region r${i}` } }));
        const crowded = summarizeStagedBuild(input({ degradations: [...many, ...passThrough] })).summary;
        expect(crowded.match(/fell to/g)).toHaveLength(5);
        expect(crowded).toContain('And 3 more (listed in degradations).');
        expect(crowded).toContain('7 regions (35.8 m²) kept as scanned where no fitted shape explained the scan.');
    },
    trees: () => {
        const putBack = summarizeStagedBuild(input({ treesPutBack: { triangles: 8840, crowns: 6, reason: 'tile_vegetation plant exited with code 134' } })).summary;
        expect(putBack).toContain('The tree stage failed (tile_vegetation plant exited with code 134), so the scanned trees were put back, labelled as scanned (8,840 triangles over 6 measured crowns).');
        const grown = input();
        grown.trees = {
            outcome: '940 of 941 trees rebuilt as SB-Veggie; 1 left as scanned: crown 1139', measured: 941, count: 940, notRegrowable: 1, keptAsScanned: [], shortOfCrown: [], offGround: [],
            cutAtBoundary: 2, belowMinHeight: 5, cutRemoved: 1, cutCanopyRemovedM2: 30, canopyTakenWithTreesM2: 0, treeCanopyAreaM2: 61_000, filledCanopyAreaM2: 61_000, reachingBoundary: 0,
            triangles: 1_100_000, triangleBudget: 1_500_000, canopyAreaM2: 70_000,
            strip: { removedTriangles: 9000, skirtAreaM2: { onWalls: 80, onLevelSurfaces: 0, onKeptCanopy: 0, onOther: 40 }, skirtMaxHeightM: { onWalls: 12.5, onLevelSurfaces: 0, onKeptCanopy: 0, onOther: 6 } },
            url: '/models/x_trees.glb'
        } as any;
        const text = summarizeStagedBuild(grown).summary;
        expect(text).toContain('Trees, grown to the measured crown: 940 of 941 trees rebuilt as SB-Veggie; 1 left as scanned: crown 1139.');
        // what the model needs to tell the user about the trees, not only the headline: what stayed as scanned, what was taken out, what was added
        expect(text).toContain('Kept as scanned: 2 crowns cut by the extraction boundary (their tops lie outside it), 5 low plantings (under the minimum tree height).');
        expect(text).toContain('Taken out with the trees it was joined to, and not rebuilt');
        expect(text).toContain('walls and building sides the trees hid were continued straight down to that ground (80 m², up to 12.5 m tall; not in the scan)');
        expect(text).toContain('the edges of other surfaces left standing over it were closed down to it (40 m², up to 6.0 m tall; not in the scan)');
        // a district with no measurable crown says so, and does not lead with the trees heading
        const none = input();
        none.trees = { outcome: '', measured: 0, count: 0, canopyAreaM2: 0, notOnStructure: 0, keptAsScanned: [], shortOfCrown: [], offGround: [], strip: { skirtAreaM2: {}, skirtMaxHeightM: {} } } as any;
        const noneText = summarizeStagedBuild(none).summary;
        expect(noneText).toContain('No tree canopy was measured in the photo tiles, so no trees were added.');
        expect(noneText).not.toContain('Trees, grown to the measured crown:');
    },
    resolution: () => {
        // a district measures no triangle edge or texel: it states the leaf error alone, never a 0.00 m edge
        const district = summarizeStagedBuild(input({ sourceLimits: { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0, meshResolvableM: 0.5016, texelM: 0, photoResolvableM: 0 } })).summary;
        expect(district).toContain("The scan's leaf tiles have a geometric error of 2.0 m. Finer detail is photo-inferred.");
        expect(district).not.toContain('median triangle edge');
        expect(summarizeStagedBuild(input()).summary).toContain('The scan resolves shapes of about 0.7 m (median triangle edge 0.69 m, leaf error 2.0 m); the photo texture resolves about 0.31 m (15 cm texels). Finer detail is photo-inferred.');
    },
    'remesh-changes': () => {
        const s = summarizeStagedBuild(input({ remeshNote: 'the ground under the arch is rebuilt (68 closure triangles, 41 m²) and not in the scan; 214 vertices were carved by photo relief (photo-inferred)' })).summary;
        expect(s).toContain('What the remesh changed that the scan did not hold: the ground under the arch is rebuilt (68 closure triangles, 41 m²) and not in the scan; 214 vertices were carved by photo relief (photo-inferred).');
    },
    'timings-and-cache': () => {
        const s = summarizeStagedBuild(input()).summary;
        expect(s).toContain('Built in 23.7 s (tiles 3.1, remesh 0.9, fit 2.2, vision 12.4, trees 5.4 s); remesh from cache.');
    },
    stop: () => {
        const i = input({ status: 'stopped' });
        // stages end in their real order: tiles, remesh, fit
        i.stages = i.stages.map((s, k) => s.stage === 'vision' || s.stage === 'trees'
            ? { ...s, status: 'stopped' as const, timings: { startedAtMs: 0, cached: false } }
            : { ...s, timings: { ...s.timings, endedAtMs: 1_760_540_000_000 + 1000 * (k + 1) } });
        i.degradations = [];
        const s = summarizeStagedBuild(i).summary;
        expect(s.startsWith(`Stopped after the scan-fitted rebuild; reading the photos and trees were not built, and the finished stages stay in the scene. Retry with retryRunId ${RUN_ID}.`)).toBe(true);
        expect(stagedDigest(i)).toMatch(/^Staged build stopped: tiles, remesh, fit committed; stopped before vision, trees; retry retryRunId a1b2c3d4 stage vision\.$/);
    },
    'gate-exemptions': () => {
        expect(summarizeStagedBuild(input()).summary).toContain('Exempt from the vertex floor, as measured geometry: vertex floor: measured rebuild (1,124 vertices; StructureFit 3fa9c2d1 accepted).');
    },
    'no-adjectives': () => {
        const all = [summarizeStagedBuild(input()).summary, summarizeStagedBuild(withDetail()).summary];
        for (const s of all) {
            for (const adj of SUMMARY_FORBIDDEN_ADJECTIVES) expect(s.toLowerCase()).not.toContain(adj);
            // every number is followed by a unit, a %, or is a count of named things
            for (const m of s.matchAll(/(\d[\d,.]*)(?=\s*(cm|m²|m\b|s\b|%|primitives|photo|vertices|triangles|facade|Street|elements|measured|regions|more|trees))/g)) expect(m[1]).toBeTruthy();
        }
        // counts in the text are the result's own fields
        const s = summarizeStagedBuild(withDetail()).summary;
        expect(s).toContain(`${withDetail().structureFit!.primitives} primitives`);
        expect(s).toContain(`${withDetail().ornament!.elements} photo-inferred details`);
    }
};

describe('staged-summary', () => {
    for (const rule of STAGED_SUMMARY_RULES) {
        it(`rule ${rule.id}: ${rule.rule}`, () => {
            const run = ruleCase[rule.id];
            expect(run, `no test for rule ${rule.id}`).toBeDefined();
            run();
        });
    }

    it('the context line carries run state, stages, degradations, retry and vision model, within 1,500 characters', () => {
        const line = stagedBuildContext({ stagedBuild: stagedBuildState() });
        expect(line.startsWith('[Staged location build: {')).toBe(true);
        const json = JSON.parse(line.slice('[Staged location build: '.length, -2));
        expect(json).toMatchObject({
            runState: 'finished',
            stages: { tiles: 'committed', remesh: 'committed', fit: 'committed', vision: 'degraded', trees: 'degraded' },
            degradations: [{ stage: 'vision', reasonCode: 'vision_unavailable', transient: true }, { stage: 'trees', reasonCode: 'trees_failed', transient: false }],
            retry: { retryRunId: RUN_ID, stages: ['vision'] },
            visionModel: { used: 'gemini-4-argon', thinking: { level: 'LOW' }, outcome: 'failed' }
        });
        const crowded = stagedBuildState();
        crowded.degradations = Array.from({ length: 200 }, (_, i) => ({ ...crowded.degradations[0], id: `d-${i}` }));
        const long = stagedBuildContext({ stagedBuild: crowded });
        expect(long.length).toBeLessThanOrEqual(1500);
        expect(JSON.parse(long.slice('[Staged location build: '.length, -2)).moreDegradations).toBeGreaterThan(0);
        expect(stagedBuildContext({})).toBe('');
        expect(stagedBuildContext(undefined)).toBe('');
        void ornamentSpec;
    });
});

describe('after a Stop the next turn can resume', () => {
    it('the context line of a stopped scene names what was not built and a retry handle for the first stopped stage', () => {
        const sb = stagedBuildState();
        sb.retry = undefined;
        sb.runState = 'stopped';
        sb.stages = sb.stages.map(st => (st.stage === 'vision' || st.stage === 'trees' ? { ...st, status: 'stopped' as const } : st));
        const json = JSON.parse(stagedBuildContext({ stagedBuild: sb }).slice('[Staged location build: '.length, -2));
        expect(json.runState).toBe('stopped');
        expect(json.retry).toEqual({ retryRunId: RUN_ID, stages: ['vision', 'trees'] });
        expect(json.stop).toMatch(/^Stopped after the .+; .+ (was|were) not built, and the finished stages stay in the scene\. Retry with retryRunId /);
        expect(json.stop).toContain(RUN_ID);
        // a finished run says nothing of a stop
        expect(JSON.parse(stagedBuildContext({ stagedBuild: stagedBuildState() }).slice('[Staged location build: '.length, -2)).stop).toBeUndefined();
    });
});

describe('the headline follows the layers on screen, not the stage status alone', () => {
    const stage = (id: string, status: StageSummaryStatus, layerIds: string[] = []) =>
        ({ stage: id, order: 0, title: id, source: '', status, layerIds, timings: { startedAtMs: 0, cached: false }, degradationIds: [] }) as StagedSummaryInput['stages'][number];
    type StageSummaryStatus = StagedSummaryInput['stages'][number]['status'];
    const treesOf = (count: number) => ({
        outcome: `${count} of 3 trees rebuilt as SB-Veggie`, measured: 3, count, notRegrowable: 3 - count, keptAsScanned: [], shortOfCrown: [], offGround: [],
        cutAtBoundary: 0, belowMinHeight: 0, cutRemoved: 0, cutCanopyRemovedM2: 0, canopyTakenWithTreesM2: 0, treeCanopyAreaM2: 120, filledCanopyAreaM2: 120, reachingBoundary: 0,
        triangles: 9000, triangleBudget: 1_500_000, canopyAreaM2: 150, strip: { removedTriangles: 900, skirtAreaM2: {}, skirtMaxHeightM: {} }
    }) as any;
    const district = (stages: StagedSummaryInput['stages'], over: Partial<StagedSummaryInput> = {}) => {
        const i = input({ structure: undefined, structureFit: undefined, ornament: undefined, extraction: { ...input().extraction, sizedTo: 'request', radiusM: 60 }, stages, degradations: [], ...over });
        i.place = { ...i.place, query: 'Central Park', resolvedAddress: 'Central Park' };
        return i;
    };
    const headline = (i: StagedSummaryInput) => summarizeStagedBuild(i).summary.split('\n')[0].split('. ')[0];

    it('names trees that are mounted while one crown is kept as scanned (the trees stage degraded)', () => {
        const i = district([stage('tiles', 'committed', ['l1']), stage('remesh', 'committed', ['l2']), stage('trees', 'degraded', ['l5'])], { trees: treesOf(2) });
        expect(headline(i)).toBe('Central Park in clay from Google 3D Tiles within 60 m: the remeshed scan and 2 trees grown to the measured crown');
        // a tree stage that left no layer (every crown kept as scanned) names none
        expect(headline(district([stage('tiles', 'committed', ['l1']), stage('remesh', 'committed', ['l2']), stage('trees', 'degraded')], { trees: treesOf(0) })))
            .toBe('Central Park in clay from Google 3D Tiles within 60 m: the remeshed scan');
        // and the scanned trees put back are not called grown
        const putBack = district([stage('tiles', 'committed', ['l1']), stage('remesh', 'committed', ['l2']), stage('trees', 'degraded', ['l5x'])], { trees: treesOf(2), treesPutBack: { triangles: 100, crowns: 3, reason: 'plant failed' } });
        expect(headline(putBack)).toBe('Central Park in clay from Google 3D Tiles within 60 m: the remeshed scan and the scanned trees put back as scanned');
    });

    it('names the scan as downloaded while the tiles stage is degraded and the remesh did not run, and the digest says what is mounted', () => {
        const i = district([stage('tiles', 'degraded', ['l1']), stage('remesh', 'stopped')]);
        expect(headline(i)).toBe('Central Park in clay from Google 3D Tiles within 60 m: the scan as downloaded');
        expect(stagedDigest(i)).toMatch(/^Staged build degraded: tiles mounted, degraded;/);
        expect(stagedDigest(district([stage('tiles', 'stopped'), stage('remesh', 'stopped')]))).toMatch(/^Staged build degraded: nothing committed;/);
        expect(headline(district([stage('tiles', 'stopped')]))).toBe('Central Park in clay from Google 3D Tiles within 60 m: nothing yet');
    });

    it('names a remeshed or flattened scan from a degraded remesh stage, and details from a degraded detail stage', () => {
        const mismatch: DegradationRecord = { ...input().degradations[1], id: 'd-remesh-isolate_mismatch', stage: 'remesh', reasonCode: 'isolate_mismatch', provenanceAfter: 'remeshed' };
        expect(headline(district([stage('tiles', 'committed', ['l1']), stage('remesh', 'degraded', ['l2'])], { degradations: [mismatch] })))
            .toBe('Central Park in clay from Google 3D Tiles within 60 m: the remeshed scan');
        const flattened: DegradationRecord = { ...mismatch, id: 'd-remesh-remesh_failed', reasonCode: 'remesh_failed', provenanceAfter: 'scan-flattened' };
        expect(headline(district([stage('tiles', 'committed', ['l1']), stage('remesh', 'degraded', ['l2'])], { degradations: [flattened] })))
            .toBe('Central Park in clay from Google 3D Tiles within 60 m: the scan with its facades flattened');
        const detail = withDetail();
        detail.stages = detail.stages.map(s => s.stage === 'detail' ? { ...s, status: 'degraded' as const } : s);
        expect(summarizeStagedBuild(detail).summary).toContain('and 14 photo-inferred details');
    });

    it('states a gate that did not pass and the exemption it refused, instead of leaving the verdict out', () => {
        const failing = input({
            complexityGate: { passed: false, totalVertices: 78, totalTriangles: 26, exemptions: [], violations: ['Insufficient geometric density: scene has 78 non-exempt vertices, minimum required is 25,000 vertices.'] },
            exemptionsRefused: ['measured crowns stg-788091ab-l5: 0 measured crowns is not a whole number of at least 1']
        });
        const s = summarizeStagedBuild(failing).summary;
        expect(s).toContain('Not exempt from the vertex floor: measured crowns stg-788091ab-l5: 0 measured crowns is not a whole number of at least 1.');
        expect(s).toContain('The geometric complexity gate did not pass (Insufficient geometric density: scene has 78 non-exempt vertices, minimum required is 25,000 vertices).');
        expect(summarizeStagedBuild(input()).summary).not.toContain('did not pass');
    });
});
