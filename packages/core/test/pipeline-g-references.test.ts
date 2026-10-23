/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's weak-wall references (pipeline-g/references.ts): a wall the check marks weak gets a search-grounded
 * reference, by its own size and compass heading; a wall that reads well is never asked; one wall's fetch failing does
 * not stop another's or throw; the subject and questions are built from the wall alone, with no model call. A stand-in
 * client: nothing is called over the network.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { headingDeg, weakWallReferences, weakWallSubject } from '../src/node/3d-engine/staged-location/pipeline-g/references';
import type { MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import type { ReadingCheck } from '../src/node/3d-engine/staged-location/pipeline-g/check';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

const check = (weak: boolean): ReadingCheck => ({ precision: 0.5, recall: 0.5, f: 0.5, openingContrast: 1, explained: weak ? 0.02 : 0.2, buildEdges: 1, photoEdges: 1, seen: 0.8, displaced: 0.01, lift: weak ? 1 : 4, weak });

const face = (overrides: Partial<MassingFace>): MassingFace => ({
    index: 0, key: 'w:p:0:0', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true,
    normal: [0, 0, -1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0],
    sMin: 0, sMax: 10, tMin: 0, tMax: 8, tBottom: 0, area: 80, pixel: 0.05, orthoSMin: 0, orthoTMax: 8, width: 200, height: 160, coverage: 1, openings: [], top: [],
    ...overrides
});

function standIn(answers: Record<string, 'image' | 'throw'>) {
    const requests: any[] = [];
    return {
        requests,
        client: {
            models: {
                async generateContent(req: any) {
                    requests.push(req);
                    if (answers[req.model] === 'throw') throw new Error('quota exceeded');
                    const parts: any[] = [{ text: 'A brick wall with five storeys of round-arched windows.' }, { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } }];
                    return { modelVersion: `${req.model}-001`, candidates: [{ finishReason: 'STOP', content: { parts }, groundingMetadata: { webSearchQueries: ['q'], groundingChunks: [{ web: { title: 'a source', uri: 'https://example.org' } }] } }] };
                }
            }
        }
    };
}

describe('weakWallSubject / headingDeg', () => {
    it('reads the compass heading from the face normal (0 = north, 90 = east)', () => {
        expect(headingDeg([0, 0, -1])).toBeCloseTo(0, 5);
        expect(headingDeg([1, 0, 0])).toBeCloseTo(90, 5);
        expect(headingDeg([0, 0, 1])).toBeCloseTo(180, 5);
        expect(headingDeg([-1, 0, 0])).toBeCloseTo(270, 5);
    });

    it('describes a wall by its own size and heading, and asks what the survey could not read', () => {
        const { subject, questions } = weakWallSubject(face({ normal: [0, 0, -1], sMin: 0, sMax: 20, tMin: 0, tMax: 9 }));
        expect(subject).toBe('the north-facing wall, about 20 m wide and 9 m tall');
        expect(questions.length).toBeGreaterThan(0);
        expect(questions.join(' ')).toMatch(/storeys/);
    });
});

describe('weakWallReferences', () => {
    it('fetches a reference only for the weak plates, by their own size and heading', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-refs-'));
        const s = standIn({ 'gemini-3-pro-image': 'image', 'gemini-3.1-flash-image': 'image' });
        const weak = face({ key: 'w:p:0:0', normal: [0, 0, -1] });
        const good = face({ key: 'w:p:0:1', normal: [1, 0, 0] });
        const out = await weakWallReferences({ client: s.client as any, place: 'Test Building', outputDir: dir, plates: [{ face: weak, check: check(true) }, { face: good, check: check(false) }] });
        expect(out).toHaveLength(1);
        expect(out[0].face).toBe('w:p:0:0');
        expect(out[0].references).toHaveLength(2);
        expect(out[0].references.map(r => r.model).sort()).toEqual(['gemini-3-pro-image', 'gemini-3.1-flash-image']);
        for (const r of out[0].references) expect(fs.existsSync(r.path)).toBe(true);
        // the prompt asked about the weak wall by its own size and heading, never the other wall
        const prompts = s.requests.map(r => r.contents[0].parts[0].text as string);
        expect(prompts.every(p => /north-facing wall/.test(p))).toBe(true);
        expect(prompts.some(p => /east-facing/.test(p))).toBe(false);
    });

    it('does not ask when no plate is weak, and never throws for one wall failing', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g-refs-'));
        const good = face({ key: 'w:p:0:0' });
        const none = await weakWallReferences({ client: standIn({}).client as any, place: 'Test Building', outputDir: dir, plates: [{ face: good, check: check(false) }, { face: good, check: undefined }] });
        expect(none).toEqual([]);

        const s = standIn({ 'gemini-3-pro-image': 'throw', 'gemini-3.1-flash-image': 'throw' });
        const weak = face({ key: 'w:p:0:2' });
        const failed = await weakWallReferences({ client: s.client as any, place: 'Test Building', outputDir: dir, plates: [{ face: weak, check: check(true) }] });
        expect(failed).toHaveLength(1);
        expect(failed[0].references).toEqual([]);
        expect(failed[0].skipped).toMatch(/No model gave/);
    });
});
