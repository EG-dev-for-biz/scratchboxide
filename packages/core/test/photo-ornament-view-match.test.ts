/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** The ring of views and the matching call: which panos are chosen, what the model is shown, what a reply becomes. No network. */
import { describe, expect, it } from 'vitest';
import { footprintSurveyFaces, runFaceSurvey, surveyCandidates } from '../src/node/3d-engine/staged-location/face-survey';
import { parseMatchReply, planRingViews, runViewMatch } from '../src/node/3d-engine/staged-location/view-match';
import { VisionModelChain } from '../src/node/gemini/vision-model-chain';
import type { PanoCandidate } from '../src/node/3d-engine/staged-location/streetview-evidence';
import { bandJpeg, GREY, routedVisionClient, SKY, STONE, surveyReply } from './helpers/photo-ornament-fixtures';

const STRUCTURE = {
    outline: [[-13.15, -5.5], [13.15, -5.5], [13.15, 5.5], [-13.15, 5.5]] as Array<[number, number]>,
    centroid: { x: 0, z: 0 }, facadeHeadingsDeg: [0, 90, 180, 270], cells: new Set<string>(), groundY: 0, heightM: 24.4
};
const GROUND = { cellIndex: () => -1, groundAt: () => 0 };
const pano = (id: string, x: number, z: number, date = '2025-06'): PanoCandidate => ({ panoId: id, lat: 0, lng: 0, x, z, date, copyright: '© Google' });
const PANOS = [pano('N1', 0, -34), pano('N2', 9, -40, '2021-05'), pano('N3', -12, -38), pano('N4', 1, -36.5), pano('E1', 44, 1), pano('S1', -4, 38), pano('W1', -46, -2)];
const grounding = (calls: any[]) => ({
    retrieveGroundingImage: async (req: any) => { calls.push(req); return { image: bandJpeg([SKY, STONE, GREY]), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree, widthPx: 1440, heightPx: 1080 } as any; }
});

describe('the ring of views', () => {
    it('takes further panos for a surveyed face, distinct, at least 4 m from the survey pano and from each other', async () => {
        const faces = footprintSurveyFaces(STRUCTURE);
        const calls: any[] = [];
        const survey = await runFaceSurvey({
            faces, panos: PANOS, structure: STRUCTURE, ground: GROUND, top: new Float32Array(0), deps: { mapsApiKey: 'k', grounding: grounding(calls) as any },
            chain: new VisionModelChain<string>({ client: routedVisionClient({ survey: surveyReply() }), candidates: ['gemini-4-argon'] })
        });
        const ring = planRingViews(faces, surveyCandidates(PANOS, faces, STRUCTURE, GROUND, new Float32Array(0)), survey);
        const north = ring.filter(r => r.facadeHeadingDeg === 0);
        expect(north.length).toBeGreaterThanOrEqual(2);
        expect(new Set(north.map(r => r.panoId)).size).toBe(north.length);
        expect(north.every(r => r.panoId !== 'N1' && r.primaryPanoId === 'N1')).toBe(true);
        for (const a of north) {
            expect(Math.hypot(a.eye[0] - 0, a.eye[2] + 34)).toBeGreaterThanOrEqual(4);
            expect(a.fovDeg).toBeGreaterThanOrEqual(55);
        }
        // a face with nothing surveyed in it gets no ring (the east face has no elements in the fake reply)
        expect(ring.some(r => r.facadeHeadingDeg === 90)).toBe(false);
    });

    it('shows the model the survey image with the new ones and the surveyed elements, and turns its boxes into correspondences; a null or low-confidence box is no correspondence', async () => {
        const faces = footprintSurveyFaces(STRUCTURE);
        const calls: any[] = [];
        const surveyChain = new VisionModelChain<string>({ client: routedVisionClient({ survey: surveyReply() }), candidates: ['gemini-4-argon'] });
        const survey = await runFaceSurvey({ faces, panos: PANOS, structure: STRUCTURE, ground: GROUND, top: new Float32Array(0), deps: { mapsApiKey: 'k', grounding: grounding(calls) as any }, chain: surveyChain });
        const asked: any[] = [];
        const client: any = {
            models: {
                generateContent: async () => { throw new Error('streaming expected'); },
                generateContentStream: async (params: any) => {
                    asked.push(params);
                    const reply = { matches: [
                        { element: 'e0', views: [{ image: 1, box: [200, 100, 260, 900], confidence: 80 }, { image: 2, box: null, confidence: 0 }, { image: 3, box: [220, 20, 270, 980], confidence: 30 }] },
                        { element: 'e2', views: [{ image: 1, box: [400, 120, 500, 320], confidence: 90 }] },
                        { element: 'zzz', views: [{ image: 1, box: [1, 2, 3, 4], confidence: 90 }] }
                    ] };
                    return (async function* () { yield { candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] }, finishReason: 'STOP' }], modelVersion: 'm' } as any; })();
                }
            }
        };
        const r = await runViewMatch({
            faces, survey, candidates: surveyCandidates(PANOS, faces, STRUCTURE, GROUND, new Float32Array(0)), deps: { mapsApiKey: 'k', grounding: grounding([]) as any },
            chain: new VisionModelChain<string>({ client, candidates: ['gemini-4-argon'] })
        });
        expect(r.visionCalls).toBeGreaterThanOrEqual(1);
        const parts: any[] = asked[0].contents[0].parts;
        expect(parts.filter(p => p.inlineData).length).toBeGreaterThanOrEqual(3);
        expect(parts.map(p => p.text ?? '').join('\n')).toMatch(/Elements found in image 0:[\s\S]*e0: "dentil cornice"/);
        const ids = r.correspondences.map(c => c.id.replace(/@.*/, ''));
        expect(ids.sort()).toEqual(['h0.e0', 'h0.e2']);
        expect(r.correspondences.every(c => c.a.view.panoId === 'N1' && c.b.view.panoId !== 'N1')).toBe(true);
        expect(r.problems.some(p => /zzz/.test(p))).toBe(true);
        expect(r.problems.some(p => /confidence 30/.test(p))).toBe(true);
        expect(JSON.stringify(r)).not.toMatch(/"bytes"|inlineData/);
    });

    it('parses strictly: a reply that is not JSON, or has no matches list, is an error; bad boxes are dropped with the reason', () => {
        expect(() => parseMatchReply('nope', 'STOP', ['e0'], 1)).toThrow(/not valid JSON/);
        expect(() => parseMatchReply('{}', 'STOP', ['e0'], 1)).toThrow(/no "matches"/);
        expect(() => parseMatchReply('{"matches":[]}', 'MAX_TOKENS', ['e0'], 1)).toThrow(/cut off/);
        const p = parseMatchReply(JSON.stringify({ matches: [{ element: 'e0', views: [{ image: 1, box: [500, 0, 400, 10], confidence: 90 }, { image: 9, box: [0, 0, 10, 10], confidence: 90 }] }] }), 'STOP', ['e0'], 1);
        expect(p.matches).toEqual([]);
        expect(p.problems.length).toBe(2);
    });
});
