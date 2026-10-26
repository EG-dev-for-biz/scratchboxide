/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The replica scorecard's fairer judge (replica-scorecard.ts): search-grounded references shown beside the tiles (the
 * judge sees them as G1..Gn after image 0, never as scored renders, and scores realism and identity too), the lit prompt,
 * the view phrase a grounded reference is asked for (read from the camera, no labels), and the comparison of two
 * scorecards with each delta's standard error. A fake client stands in for the model. No network, no billed call.
 */

import { describe, expect, it } from 'vitest';
import type { JudgeClient } from '../src/node/3d-engine/staged-location/photo-match-eval';
import {
    aggregateReplicaRuns, believabilityPrompt, compareJudgedBlocks, groundedViewPhrase, judgeReplicaView, parseReplicaReply, replicaJudgePrompt, stat
} from '../src/node/3d-engine/staged-location/replica-scorecard';

type Part = { text?: string; inlineData?: { mimeType: string; data: string } };

/** A fake judge: scores each rebuild by the first byte of its image (so the shuffled order must be mapped back), realism 10 - that. */
function fakeJudge(): { client: JudgeClient; calls: Part[][] } {
    const calls: Part[][] = [];
    return {
        calls,
        client: {
            async generate(params) {
                const parts = params.contents[0].parts as Part[];
                calls.push(parts);
                const renders: Array<Record<string, unknown>> = [];
                let k = 0;
                for (let i = 0; i < parts.length; i++) {
                    if (!/^Image \d+: a rebuild/.test(parts[i].text ?? '')) continue;
                    const v = Buffer.from(parts[i + 1].inlineData!.data, 'base64')[0];
                    k++;
                    renders.push({ image: k, shape: v, materials: v, detail: v, errors: v, overall: v, realism: 10 - v, identity: v, defects: [{ what: 'x', where: 'y', severity: 0.2 }], note: 'n' });
                }
                return { response: { candidates: [{ content: { parts: [{ text: JSON.stringify({ renders }) }] } }] }, model: 'fake-judge' };
            }
        }
    };
}

const png = (v: number) => Uint8Array.from([v, 0, 0, 0]);

describe('replica scorecard: grounded references and lit judging', () => {
    it('shows the grounded references after the tiles as G1..Gn, maps shuffled scores back and reads realism and identity', async () => {
        const { client, calls } = fakeJudge();
        const runs = await judgeReplicaView({
            client, place: 'Somewhere', reference: png(9), repeats: 3, seed: 's', lit: true,
            renders: [{ armId: 'tiles', png: png(5) }, { armId: 'a', png: png(2) }, { armId: 'b', png: png(7) }],
            grounded: [{ bytes: png(1), mimeType: 'image/png' }, { bytes: png(1), mimeType: 'image/jpeg' }]
        });
        expect(runs).toHaveLength(3);
        for (const r of runs) {
            expect(r.scores.a.overall).toBe(2); expect(r.scores.b.overall).toBe(7); expect(r.scores.tiles.overall).toBe(5);
            expect(r.scores.a.realism).toBe(8); expect(r.scores.b.identity).toBe(7);
        }
        const texts = calls[0].map(p => p.text ?? '');
        const iRef = texts.findIndex(t => t.startsWith('Image 0')), iG1 = texts.findIndex(t => t.startsWith('Image G1')), iG2 = texts.findIndex(t => t.startsWith('Image G2'));
        const iFirst = texts.findIndex(t => t.startsWith('Image 1:'));
        expect(iRef).toBeGreaterThan(0); expect(iG1).toBeGreaterThan(iRef); expect(iG2).toBeGreaterThan(iG1); expect(iFirst).toBeGreaterThan(iG2);
        expect(calls[0][iG2 + 1].inlineData!.mimeType).toBe('image/jpeg');
        expect(texts[0]).toContain('same sun and sky');
        expect(texts[0]).toContain('search-grounded');
        expect(texts[texts.length - 1]).toContain('"realism":n');
        // shuffled per repeat, and still mapped back
        expect(new Set(runs.map(r => r.order.join()))).not.toEqual(new Set([runs[0].order.join()]));
        const st = aggregateReplicaRuns(runs, ['tiles', 'a', 'b']);
        expect(st.a.realism.mean).toBe(8); expect(st.b.identity.n).toBe(3);
    });

    it('without grounded references the prompt and the stats keep the five original criteria', async () => {
        const { client, calls } = fakeJudge();
        const runs = await judgeReplicaView({ client, place: 'P', reference: png(9), repeats: 1, seed: 's', renders: [{ armId: 'a', png: png(3) }] });
        expect(calls[0].some(p => (p.text ?? '').startsWith('Image G'))).toBe(false);
        expect(calls[0][0].text).toContain('flat neutral light');
        expect(Object.keys(aggregateReplicaRuns(runs, ['a']).a)).toEqual(['shape', 'materials', 'detail', 'errors', 'overall']);
        expect(replicaJudgePrompt('P', 1).closing).toContain('five criteria');
        expect(replicaJudgePrompt('P', 1, { grounded: 2 }).closing).toContain('seven criteria');
        expect(believabilityPrompt(true)).toContain('computed sun');
        expect(believabilityPrompt()).toContain('flat, shadowless light');
        // a grounded reply missing realism is a problem, an old-style reply is fine without grounding
        const old = JSON.stringify({ renders: [{ image: 1, shape: 3, materials: 3, detail: 3, errors: 3, overall: 3 }] });
        expect(parseReplicaReply(old, 1).problems).toEqual([]);
        expect(parseReplicaReply(old, 1, ['shape', 'materials', 'detail', 'errors', 'overall', 'realism', 'identity']).problems.length).toBe(1);
    });

    it('phrases the view a grounded reference is asked for from the camera alone', () => {
        const street = groundedViewPhrase({ eye: [0, 8.6, 0], target: [-100, 9.2, 32], hfovDeg: 75 }, 7.2);
        expect(street).toContain('at eye level');
        expect(street).toContain('facing west');
        expect(street).toContain('looking level');
        const aerial = groundedViewPhrase({ eye: [0, 200, 0], target: [100, 0, 100], hfovDeg: 50 }, 7);
        expect(aerial).toContain('about 193 m above');
        expect(aerial).toContain('south-east');
        expect(aerial).toMatch(/looking down about 5\d degrees/);
    });

    it('compares two scorecards per view, arm and criterion with the delta\'s standard error', () => {
        const runsOf = (xs: number[]) => stat(xs);
        const base = [{ id: 'v', replica: { stats: { b: { overall: runsOf([3, 3, 3]), shape: runsOf([2, 4, 3]) } } }, believability: { b: { stat: runsOf([1, 1]) } } }];
        const cur = [
            { id: 'v', replica: { stats: { b: { overall: runsOf([5, 5, 6]), shape: runsOf([2, 5, 3]) } } }, believability: { b: { stat: runsOf([1, 2]) } } },
            { id: 'new-view', replica: { stats: { b: { overall: runsOf([9]) } } } }
        ];
        const d = compareJudgedBlocks(base, cur);
        const overall = d.find(x => x.criterion === 'overall')!, shape = d.find(x => x.criterion === 'shape')!, bel = d.find(x => x.criterion === 'believability')!;
        expect(overall.d.delta).toBeCloseTo(2.33, 2); expect(overall.d.clear).toBe(true);
        expect(shape.d.delta).toBeCloseTo(0.33, 2); expect(shape.d.clear).toBe(false);
        expect(bel.d.delta).toBe(0.5); expect(bel.d.clear).toBe(false); // 0.5 against an se of 0.5: within the noise
        expect(d.some(x => x.view === 'new-view')).toBe(false);
    });
});
