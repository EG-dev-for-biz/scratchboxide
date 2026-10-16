/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Facade detail read from photos: the ornament/v2 prompt, the expansion of every compact operator and carrier form,
 * each check of §5.5 one by one, the single revision (only for what the model can fix), the truncation path, a
 * visible fallback and a recorded failure. A fake client answers from a script; no billed call.
 */

import { describe, it, expect } from 'vitest';
import { expandOp } from '../src/node/3d-engine/staged-location/ornament-expand';
import {
    checkReply, ornamentContents, ornamentPromptText, orthoCaption, orthoRef, readOrnament, streetViewCaption, VisionStageError,
    ORNAMENT_PROMPT_VERSION, ORNAMENT_VISION_TIMEOUT_MS, type EvidenceInput
} from '../src/node/3d-engine/staged-location/ornament-vision';
import { VisionModelChain, type VisionGenAIClient } from '../src/node/gemini/vision-model-chain';
import { schemaClosure, STAGED_VISION_MODEL_DEFAULT, validateContract, type CompactElement, type EvidenceImageRef, type StructureFit, type VisionOrnamentReply } from '../src/common/spatial/staged-location-contracts';
import { structureFit } from './helpers/staged-location-fixtures';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000100000001008060000001ff3ff61', 'hex');
const JPG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffc00011080300040003012200021101031101ffd9', 'hex');

function fit(): StructureFit {
    return structureFit();
}

/** The evidence: the north face's ortho (S01 and S02 drawn on it) and one Street View image showing S02 and S03. */
function evidence(f = fit()): EvidenceInput[] {
    const ortho = orthoRef({ id: 'ortho:s00', surfaceId: 's00', path: 'x.png', widthPx: 526, heightPx: 488, gsdM: 0.05, texelM: 0.154, originUv: [0, 24.4], slotsDrawn: ['S01', 'S02'], sha256: '' }, 0, f, PNG);
    const sv: EvidenceImageRef = {
        id: 'sv:PANO1:180:15:42', index: 1, kind: 'streetview-grounding', widthPx: 1024, heightPx: 768, sha256: 'c'.repeat(64), nativeSampleM: 0.021,
        panoId: 'PANO1', captureDate: '2025-06', copyright: '© Google', headingDeg: 180, pitchDeg: 15, fovDeg: 42, distanceM: 29.4,
        pose: { eye: [0, 2.5, -34], registered: false, uncertaintyM: 2, uncertaintyDeg: 2 },
        slotsShown: [
            { slotId: 'S02', polygon1000: [130, 50, 130, 950, 220, 950, 220, 50], visibleFraction: 0.92 },
            { slotId: 'S03', polygon1000: [400, 250, 400, 750, 820, 750, 820, 250], visibleFraction: 0.7 }
        ]
    };
    return [
        { ref: ortho, bytes: PNG, mimeType: 'image/png', caption: orthoCaption(ortho, f) },
        { ref: sv, bytes: JPG, mimeType: 'image/jpeg', caption: streetViewCaption(sv) }
    ];
}

const refs = () => evidence().map(e => e.ref);

/** A roundel on S01 (the north spandrel), cited on the ortho over the slot. */
const ROUNDEL: CompactElement = { slot: 'S01', op: { revolve: { at: [5000, 15000], axis: 'n', profile: [0, 0, 900, 0, 900, 120, 0, 180] } }, conf: 62, depthBasis: 'rim highlight', ev: [[0, 300, 120, 470, 260]] };
/** A cornice molding along S02, cited on the Street View image. */
const CORNICE: CompactElement = { slot: 'S02', op: { sweep: { t: [0, 1000], offset: [0, 120], profile: [0, 0, 180, 0, 180, 90, 60, 160, 0, 160] } }, conf: 81, depthBasis: 'shadow line', ev: [[1, 140, 60, 210, 940]] };
const reply = (elements: CompactElement[], corrections: VisionOrnamentReply['corrections'] = [], emptySlots: VisionOrnamentReply['emptySlots'] = []): string => JSON.stringify({ elements, corrections, emptySlots });

describe('the ornament/v2 prompt', () => {
    it('lays out preamble, each image with its caption, the slot table, the Street View polygons, the correctable values, the rules and the inline schema', () => {
        const f = fit();
        const contents = ornamentContents(f, evidence(f));
        const parts = contents[0].parts!;
        expect(parts.map(p => (p.inlineData ? `image:${p.inlineData.mimeType}` : 'text'))).toEqual(['text', 'image:image/png', 'text', 'image:image/jpeg', 'text', 'text']);
        expect(parts[0].text).toBe('You are reading architectural ornament on one real structure from photographs. It will be added as parametric detail to a clay model that was fitted to a 3D scan. The scan resolves shapes of about 0.69 m and the tile photos about 0.31 m. Everything you add is labelled "photo-inferred" with the confidence you give, and anything smaller than the image you cite can show is discarded.\n\nImages (cite them by index):');
        expect(parts[2].text).toBe('[0] Orthographic view of fitted surface s00, 26.3 × 24.4 m, from the Google 3D Tiles photo texture resampled to 0.05 m per pixel. The photo\'s own texel here is 0.15 m, so nothing under 0.31 m is visible. Coloured outlines are slots, with their ids.');
        expect(parts[4].text).toBe('[1] Google Street View image (© Google, 2025-06), looking 180° from about 29 m, field of view 42°, 1024 × 768 px; one pixel spans about 0.02 m on the facade. Its slot outlines are listed below as polygons. They come from an approximate camera position and may be off by about 2 m.');
        const tables = parts[5].text!;
        expect(tables).toContain('S01: surface s00, 6 × 6 m, maxProud 600 mm, maxRecess 400 mm, in images [0]');
        expect(tables).toContain('S02: edge along s00, 26.3 m, 26.3 × 0.35 m, maxProud 600 mm, maxRecess 200 mm, envelope [u out, v up] mm [[0,0],[1100,0],[1100,350],[0,350]], in images [0, 1]');
        expect(tables).toContain('S03: surface s05, 13.3 × 9 m, maxProud 300 mm, maxRecess 300 mm, in images [1]');
        expect(tables).toContain('[1] S02 → [130,50,130,950,220,950,220,50]; S03 → [400,250,400,750,820,750,820,250]');
        expect(tables).toContain('p03 (passage arch): param 2 (riseToSpan) = 0.39 ratio, admissible 0.31–0.5; rise over span of the passage arch');
        expect(tables).toContain('6. Shadows, stains, trees, people, vehicles and statues standing in front of a wall are not ornament on that wall.');
        expect(tables.endsWith(`Reply with JSON only, matching this schema: ${JSON.stringify(schemaClosure('VisionOrnamentReply'))}`)).toBe(true);
        expect(JSON.stringify(schemaClosure('VisionOrnamentReply')).length).toBeLessThan(4.5 * 1024);
        // the Street View bytes go in exactly as they came
        expect(Buffer.from(parts[3].inlineData!.data!, 'base64').equals(JPG)).toBe(true);
        expect(ornamentPromptText(f, refs()).preamble).toBe(parts[0].text);
    });

    it('puts the ortho\'s slots where the fit\'s chart puts them', () => {
        const o = refs()[0];
        // S01: u 2..8 m, v 12..18 m on a 26.3 × 24.4 m face at 5 cm, v down from 24.4
        expect(o.slotsShown.find(s => s.slotId === 'S01')!.polygon1000).toEqual([508, 76, 508, 304, 262, 304, 262, 76]);
        expect(o.slotsShown.map(s => s.slotId)).toEqual(['S01', 'S02']);
        expect(o.nativeSampleM).toBe(0.154);
    });
});

describe('expansion of the compact reply', () => {
    const f = fit();
    const S01 = f.slots[0], S02 = f.slots[1];
    it('expands every operator and carrier form into metres in the host chart', () => {
        expect(expandOp({ sweep: { t: [100, 900], offset: [0, 120], profile: [0, 0, 180, 0, 180, 90] } }, { slot: S02, reliefMaxEdgeM: 0.05 })).toEqual({
            operator: 'sweep', sweep: { carrier: { slot: { slotId: 'S02', t0: 0.1, t1: 0.9, offset: [0, 0.12] } }, profile: { outer: [[0, 0], [0.18, 0], [0.18, 0.09]] }, miterLimit: 4, caps: true }
        });
        expect(expandOp({ sweep: { path: [2000, 12000, 8000, 12000], closed: false, profile: [-50, 0, 50, 0, 0, 40] } }, { slot: S01, reliefMaxEdgeM: 0.05 })).toMatchObject({
            sweep: { carrier: { chart: { pointsUv: [[2, 12], [8, 12]], closed: false } }, profile: { outer: [[-0.05, 0], [0.05, 0], [0, 0.04]] } }
        });
        for (const [axis, dir] of [['n', [0, 0, 1]], ['u', [1, 0, 0]], ['v', [0, 1, 0]]] as const) {
            expect(expandOp({ revolve: { at: [5000, 15000], axis, profile: [0, 0, 900, 0, 0, 180], lobes: 8, lobeAmp: 150, sweepDeg: 180 } }, { slot: S01, reliefMaxEdgeM: 0.05 })).toEqual({
                operator: 'revolve', revolve: { axisOrigin: [5, 15, 0], axisDir: dir, profile: [[0, 0], [0.9, 0], [0, 0.18]], lobes: 8, lobeAmplitude: 0.15, helixTurns: 0, startAngleDeg: 0, sweepAngleDeg: 180, segments: 32 }
            });
        }
        expect(expandOp({ relief: { box: [2000, 12000, 3000, 13000], depth: -120, edge: 60, edgeProfile: [0, 0, 500, 800, 1000, 1000] } }, { slot: S01, reliefMaxEdgeM: 0.05 })).toEqual({
            operator: 'relief', relief: { surfaceId: 's00', region: { outer: [[2, 12], [3, 12], [3, 13], [2, 13]] }, height: { panel: { depthM: -0.12, edgeWidthM: 0.06, edgeProfile: [[0, 0], [0.5, 0.8], [1, 1]] } }, maxEdgeM: 0.05 }
        });
        expect(expandOp({ relief: { poly: [2000, 12000, 4000, 12000, 3000, 14000], grid: { cols: 2, rows: 2, cell: 500, heights: [10, 20, 30, 40] } } }, { slot: S01, reliefMaxEdgeM: 0.05 })).toMatchObject({
            relief: { region: { outer: [[2, 12], [4, 12], [3, 14]] }, height: { grid: { cols: 2, rows: 2, cellM: 0.5, originUv: [2, 12], heightsM: [0.01, 0.02, 0.03, 0.04] } } }
        });
        expect(expandOp({ replicate: { seed: { revolve: { at: [0, 0], axis: 'n', profile: [0, 0, 100, 0, 0, 50] } }, along: [50, 1200, 20] } }, { slot: S02, reliefMaxEdgeM: 0.05 })).toMatchObject({
            replicate: { domain: { along: { carrier: { slot: { slotId: 'S02', t0: 0.05, t1: 1, offset: [0, 0] } }, pitchM: 1.2, count: 20, startOffsetM: 0 } }, alignToSurface: true }
        });
        expect(expandOp({ replicate: { seed: { relief: { box: [0, 0, 1100, 1100], depth: -120 } }, grid: [300, 300, 1450, 1450, 9, 6, 700] } }, { slot: S01, reliefMaxEdgeM: 0.05 })).toMatchObject({
            replicate: { domain: { lattice: { originUv: [0.3, 0.3], pitchUv: [1.45, 1.45], counts: [9, 6], rowOffsetU: 0.7 } } }
        });
    });
});

describe('the checks of §5.5, one by one', () => {
    const f = fit();
    const check = (elements: CompactElement[], corrections: VisionOrnamentReply['corrections'] = [], finish = 'STOP', final = false) => checkReply(reply(elements, corrections), finish, f, refs(), 'test', final);

    it('keeps elements that pass every rule, and marks the tile-photo-only ones for the builder\'s pixel test', () => {
        const r = check([ROUNDEL, CORNICE]);
        expect(r.problems).toEqual([]);
        expect(r.kept.map(e => e.id)).toEqual(['e000', 'e001']);
        expect(r.supportTestRequired).toEqual(['e000']);
        const roundel = r.kept[0];
        expect(roundel.provenance).toMatchObject({ label: 'photo-inferred', measuredGeometry: false, confidence: 0.62 });
        expect(roundel.checks).toEqual({ slotOverlap: 1, minFeatureM: 1.8, nativeSampleM: 0.154 });
        for (const e of r.kept) expect(validateContract('provenance', e.provenance)).toEqual([]);
    });

    it('rule 1: a reply that is not JSON, or was cut off, is a problem to revise', () => {
        expect(checkReply('{"elements": [', 'STOP', f, refs(), 't').problems[0]).toMatch(/^rule 1: the reply is not valid JSON/);
        expect(checkReply(reply([ROUNDEL]), 'MAX_TOKENS', f, refs(), 't').problems).toEqual(['rule 1: the reply was cut off (MAX_TOKENS)']);
    });
    it('rule 2: a reply that breaks the schema is a problem to revise', () => {
        const bad = JSON.stringify({ elements: [{ ...ROUNDEL, depthBasis: undefined }], corrections: [], emptySlots: [] });
        expect(checkReply(bad, 'STOP', f, refs(), 't').problems[0]).toMatch(/^rule 2: VisionOrnamentReply\.elements\[0\]/);
    });
    it('rule 3: unknown slots and image indices', () => {
        const r = check([{ ...ROUNDEL, slot: 'S99' }, { ...CORNICE, ev: [[7, 140, 60, 210, 940]] }]);
        expect(r.problems).toEqual(['element 0: rule 3: slot S99 is not one of the slots', 'element 1: rule 3: image index 7 is not one of the images']);
    });
    it('rule 4: malformed boxes', () => {
        expect(check([{ ...ROUNDEL, ev: [[0, 470, 120, 300, 260]] }]).problems).toEqual(['element 0: rule 4: box [0, 470, 120, 300, 260] is not well-formed (y0 < y1 and x0 < x1)']);
    });
    it('rule 5: outside the slot', () => {
        expect(check([{ ...ROUNDEL, op: { relief: { box: [0, 0, 1000, 1000], depth: 50 } } }]).problems).toEqual(['element 0: rule 5: the element runs outside slot S01']);
    });
    it('rule 6: beyond the slot\'s depth bounds, or outside the edge envelope', () => {
        const deep: CompactElement = { slot: 'S03', op: { relief: { box: [1000, 1000, 2000, 2000], depth: -400 } }, conf: 60, depthBasis: 'x', ev: [[1, 500, 400, 700, 600]] };
        expect(check([deep]).problems).toEqual(['element 0: rule 6: 400 mm recess is more than slot S03 allows (300 mm)']);
        const fat: CompactElement = { ...CORNICE, op: { sweep: { t: [0, 1000], offset: [0, 300], profile: [0, 0, 180, 0, 180, 90] } } };
        expect(check([fat]).problems).toEqual(['element 0: rule 6: the profile leaves the edge envelope of S02 at 1 point(s)']);
    });
    it('rule 7: a repeat that does not fit its edge', () => {
        const long: CompactElement = { ...CORNICE, op: { replicate: { seed: { revolve: { at: [0, 200], axis: 'n', profile: [0, 0, 100, 0, 0, 60] } }, along: [0, 5000, 7] } } };
        expect(check([long]).problems).toEqual(['element 0: rule 7: the element runs past the 26.30 m edge S02']);
    });
    it('rule 8: overlapping elements in one slot, unless one contains the other', () => {
        const a: CompactElement = { ...ROUNDEL, op: { relief: { box: [2000, 12000, 5000, 15000], depth: 50 } } };
        const b: CompactElement = { ...ROUNDEL, op: { relief: { box: [4000, 14000, 7000, 17000], depth: 50 } } };
        const inner: CompactElement = { ...ROUNDEL, op: { relief: { box: [2500, 12500, 3500, 13500], depth: 30 } } };
        expect(check([a, b]).problems).toEqual(['element 1: rule 8: element 1 overlaps element 0 in slot S01 by 11%']);
        expect(check([a, inner]).problems).toEqual([]);
    });
    it('rule 9: dropped when the cited image does not show the slot, or the box is not on it', () => {
        const soffitOnOrtho: CompactElement = { slot: 'S03', op: { relief: { box: [1000, 1000, 2000, 2000], depth: -100 } }, conf: 60, depthBasis: 'x', ev: [[0, 300, 120, 470, 260]] };
        const offBox: CompactElement = { ...CORNICE, ev: [[1, 600, 60, 700, 300]] };
        const r = check([soffitOnOrtho, offBox]);
        expect(r.problems).toEqual([]);
        expect(r.kept).toEqual([]);
        expect(r.dropped.map(d => [d.elementId, d.reasonCode])).toEqual([['e000', 'slot_not_shown'], ['e001', 'slot_not_shown']]);
        expect(r.dropped[0].problems).toEqual(['rule 9: image 0 does not show slot S03']);
        expect(r.dropped[1].problems[0]).toMatch(/^rule 9: the box in image 1 lies \d+% on slot S02 \(50% needed\)$/);
    });
    it('rule 10: dropped when smaller than twice what its image can show (a 0.2 m rosette on a 0.154 m texel)', () => {
        const rosette: CompactElement = { ...ROUNDEL, op: { revolve: { at: [5000, 15000], axis: 'n', profile: [0, 0, 100, 0, 100, 40, 0, 60] } } };
        const r = check([rosette]);
        expect(r.dropped).toEqual([expect.objectContaining({ reasonCode: 'not_resolvable_in_evidence', problems: ['rule 10: its smallest size, 200 mm, is under twice what its finest cited image can show (308 mm)'] })]);
    });
    it('rule 11: an element backed only by the tile photo goes to the builder\'s pixel support test', () => {
        expect(check([ROUNDEL]).supportTestRequired).toEqual(['e000']);
        expect(check([CORNICE]).supportTestRequired).toEqual([]);
    });
    it('rule 12: dropped under the confidence floor', () => {
        expect(check([{ ...CORNICE, conf: 30 }]).dropped).toEqual([expect.objectContaining({ reasonCode: 'below_confidence_floor', problems: ['rule 12: confidence 30 is under 35'] })]);
    });
    it('rule 13: a correction inside the admissible range, confident, with evidence that shows the primitive', () => {
        const ok = { prim: 'p03', param: 2, to: 0.5, conf: 74, why: 'semicircle', ev: [[1, 450, 300, 780, 700]] as VisionOrnamentReply['corrections'][0]['ev'] };
        // at most 4 corrections per reply (the schema): two replies
        const r = check([], [ok, { ...ok, to: 0.7 }, { ...ok, conf: 60 }]);
        const r2 = check([], [{ ...ok, param: 0 }, { ...ok, ev: [[0, 300, 120, 470, 260]] }]);
        expect(r.problems).toEqual([]);
        expect(r.corrections.map(c => [c.primitiveId, c.param, c.from, c.to, c.check.accepted])).toEqual([['p03', 2, 0.39, 0.5, true]]);
        expect(r.corrections[0].check.toleranceM).toBe(0.31);
        expect([...r.rejectedCorrections, ...r2.rejectedCorrections].map(c => c.check.why)).toEqual([
            'rule 13: 0.7 is outside the admissible 0.31–0.5',
            'rule 13: confidence 60 is under 70',
            'rule 13: p03 param 0 is not a correctable value',
            'rule 13: its evidence does not show p03'
        ]);
        for (const c of [...r.corrections, ...r.rejectedCorrections, ...r2.rejectedCorrections]) expect(validateContract('correction', c)).toEqual([]);
    });
    it('after the revision, an element that still breaks rules 3-8 is dropped instead of asked again', () => {
        const r = check([{ ...ROUNDEL, op: { relief: { box: [0, 0, 1000, 1000], depth: 50 } } }, CORNICE], [], 'STOP', true);
        expect(r.problems).toEqual([]);
        expect(r.kept.map(e => e.id)).toEqual(['e001']);
        expect(r.dropped).toEqual([expect.objectContaining({ elementId: 'e000', reasonCode: 'still_invalid_after_revision' })]);
    });
});

/** A client answering each call from a script, streaming; records the requests. */
function scripted(answers: Array<{ text?: string; finish?: string; error?: Error; hang?: boolean }>, unserved: string[] = []) {
    const calls: Array<{ model: string; contents: any[]; config: any }> = [];
    const client: VisionGenAIClient = {
        models: {
            generateContent: async () => { throw new Error('streaming expected'); },
            generateContentStream: async (params: any) => {
                calls.push({ model: params.model, contents: params.contents, config: params.config });
                if (unserved.includes(params.model)) throw Object.assign(new Error(`model ${params.model} was not found (404)`), { status: 404 });
                const a = answers.length > 1 ? answers.shift()! : answers[0];
                if (a.hang) {
                    const signal: AbortSignal = params.config.abortSignal;
                    if (signal.aborted) throw signal.reason;
                    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
                }
                if (a.error) throw a.error;
                return (async function* () {
                    yield { candidates: [{ content: { parts: [{ text: a.text!.slice(0, 10) }] } }] } as any;
                    yield { candidates: [{ content: { parts: [{ text: a.text!.slice(10) }] }, finishReason: a.finish ?? 'STOP' }], modelVersion: `${params.model}-001`, usageMetadata: { promptTokenCount: 9200, candidatesTokenCount: 1830, thoughtsTokenCount: 410 } } as any;
                })();
            }
        }
    };
    return { client, calls };
}

const chainOf = (client: VisionGenAIClient, candidates = [STAGED_VISION_MODEL_DEFAULT.model, 'gemini-3.8-flash']) => new VisionModelChain<string>({ client, candidates, sleep: async () => undefined });

describe('readOrnament', () => {
    it('reads at LOW thinking in one call, streaming, and records the model use', async () => {
        const { client, calls } = scripted([{ text: reply([ROUNDEL, CORNICE], [], [{ slot: 'S03', why: 'blur' }]) }]);
        const progress: string[] = [];
        const r = await readOrnament({ fit: fit(), fitSha256: 'b'.repeat(64), evidence: evidence(), chain: chainOf(client), onProgress: m => progress.push(m) });
        expect(calls).toHaveLength(1);
        expect(calls[0].config).toMatchObject({ responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 16384, thinkingConfig: { thinkingLevel: 'LOW' } });
        expect(validateContract('OrnamentSpec', r.spec)).toEqual([]);
        expect(r.spec.promptVersion).toBe(ORNAMENT_PROMPT_VERSION);
        expect(r.spec.elements.map(e => e.slotId)).toEqual(['S01', 'S02']);
        expect(r.spec.emptySlots).toEqual([{ slotId: 'S03', reason: 'blur' }]);
        expect(r.spec.revision).toEqual({ passes: 0, problems: [] });
        expect(r.spec.model).toMatchObject({
            requested: 'gemini-4-argon', used: 'gemini-4-argon', answered: 'gemini-4-argon-001', thinking: { level: 'LOW' }, skipped: [], backend: 'injected',
            promptTokens: 9200, outputTokens: 1830, thinkingTokens: 410, finishReason: 'STOP', outcome: 'answered', selection: STAGED_VISION_MODEL_DEFAULT.selection
        });
        expect(r.spec.model.ttftMs).toBeGreaterThanOrEqual(0);
        expect(progress.some(p => /^reading the photos \(first token after \d+\.\d s\)$/.test(p))).toBe(true);
        expect(JSON.stringify(r.replies)).not.toContain(JPG.toString('base64'));
    });

    it('revises once for problems the model can fix, quoting them, and not for missing evidence', async () => {
        const broken = { ...ROUNDEL, op: { relief: { box: [0, 0, 1000, 1000], depth: 50 } } } as CompactElement;
        const { client, calls } = scripted([{ text: reply([broken, CORNICE]) }, { text: reply([ROUNDEL, CORNICE]) }]);
        const r = await readOrnament({ fit: fit(), fitSha256: 'b'.repeat(64), evidence: evidence(), chain: chainOf(client) });
        expect(calls).toHaveLength(2);
        const ask = calls[1].contents[2].parts[0].text;
        expect(ask).toBe('These parts cannot be built: 1. element 0: rule 5: the element runs outside slot S01 Reply with the complete corrected JSON.');
        expect(calls[1].contents[1]).toEqual({ role: 'model', parts: [{ text: reply([broken, CORNICE]) }] });
        expect(r.spec.revision).toEqual({ passes: 1, problems: ['element 0: rule 5: the element runs outside slot S01'] });
        expect(r.spec.elements).toHaveLength(2);
        expect(r.spec.model.promptTokens).toBe(18400); // the images are sent again with the first turn

        // rules 9-12 only: no revision
        const rosette: CompactElement = { ...ROUNDEL, op: { revolve: { at: [5000, 15000], axis: 'n', profile: [0, 0, 100, 0, 0, 60] } } };
        const once = scripted([{ text: reply([rosette, CORNICE]) }]);
        const r2 = await readOrnament({ fit: fit(), fitSha256: 'b'.repeat(64), evidence: evidence(), chain: chainOf(once.client) });
        expect(once.calls).toHaveLength(1);
        expect(r2.spec.dropped).toEqual([{ elementId: 'e000', slotId: 'S01', by: 'validator', problems: ['rule 10: its smallest size, 200 mm, is under twice what its finest cited image can show (308 mm)'] }]);
    });

    it('asks for fewer elements when the reply was cut off, and fails after a second invalid reply', async () => {
        const { client, calls } = scripted([{ text: '{"elements": [', finish: 'MAX_TOKENS' }, { text: 'still not json' }]);
        const err = await readOrnament({ fit: fit(), fitSha256: 'b'.repeat(64), evidence: evidence(), chain: chainOf(client) }).catch(e => e);
        expect(calls[1].contents[2].parts[0].text).toBe('Your reply was cut off. Reply with at most 30 elements, highest confidence first.');
        expect(err).toBeInstanceOf(VisionStageError);
        expect(err.reasonCode).toBe('vision_invalid_reply');
        expect(err.model).toMatchObject({ outcome: 'failed', used: 'gemini-4-argon', thinking: { level: 'LOW' }, answered: '' });
        expect(err.message).toMatch(/^the reply was invalid twice \(rule 1: the reply is not valid JSON/);
    });

    it('records a fallback when the chosen model is not served', async () => {
        const { client, calls } = scripted([{ text: reply([CORNICE]) }], ['gemini-4-argon']);
        const r = await readOrnament({ fit: fit(), fitSha256: 'b'.repeat(64), evidence: evidence(), chain: chainOf(client) });
        expect(calls.map(c => [c.model, c.config.thinkingConfig])).toEqual([['gemini-4-argon', { thinkingLevel: 'LOW' }], ['gemini-3.8-flash', { thinkingBudget: 512 }]]);
        expect(r.spec.model).toMatchObject({ requested: 'gemini-4-argon', used: 'gemini-3.8-flash', thinking: { budget: 512 }, outcome: 'answered' });
        expect(r.spec.model.skipped[0]).toMatchObject({ model: 'gemini-4-argon' });
        expect(r.spec.model.skipped[0].reason).toContain('404');
    });

    it('fails visibly, naming the model and thinking tried, on errors and on a timeout', async () => {
        const down = scripted([{ error: Object.assign(new Error('UNAVAILABLE'), { status: 503 }) }]);
        const err = await readOrnament({ fit: fit(), fitSha256: 'b'.repeat(64), evidence: evidence(), chain: chainOf(down.client) }).catch(e => e);
        expect(err).toBeInstanceOf(VisionStageError);
        expect(err.transient).toBe(true);
        expect(err.model).toMatchObject({ requested: 'gemini-4-argon', used: 'gemini-4-argon', thinking: { level: 'LOW' }, outcome: 'failed', error: 'gemini-4-argon failed (transient 503): UNAVAILABLE' });
        expect(down.calls).toHaveLength(3); // the same model, retried twice; never another model for a transient failure
        expect(validateContract('visionModelUse', err.model)).toEqual([]);

        const hang = scripted([{ hang: true }]);
        const late = await readOrnament({ fit: fit(), fitSha256: 'b'.repeat(64), evidence: evidence(), chain: chainOf(hang.client), timeoutMs: 50 }).catch(e => e);
        expect(late).toBeInstanceOf(VisionStageError);
        expect(late.transient).toBe(true);
        expect(late.message).toBe('the vision call took longer than 0 s');
        expect(hang.calls).toHaveLength(1); // its own time limit ended it: not asked again
        expect(ORNAMENT_VISION_TIMEOUT_MS).toBe(120_000);
    });
});
