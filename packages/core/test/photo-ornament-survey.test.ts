/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pass 1, the draft survey: which panos look at which faces, the fetch, the one vision call with the replayed reply,
 * the measured palettes, the material hints and the rungs of the degrade ladder. No network.
 */
import { describe, it, expect } from 'vitest';
import {
    fitSurveyFaces, footprintSurveyFaces, parseSurveyReply, runFaceSurvey, selectSurveyViews, surveyAim, surveyContents, surveyPrompt, SURVEY_FOV_MAX_DEG, SURVEY_FOV_MIN_DEG
} from '../src/node/3d-engine/staged-location/face-survey';
import { VisionModelChain } from '../src/node/gemini/vision-model-chain';
import { validateContract } from '../src/common/spatial/staged-location-contracts';
import type { PanoCandidate } from '../src/node/3d-engine/staged-location/streetview-evidence';
import { VisionStageError } from '../src/node/3d-engine/staged-location/ornament-vision';
import { ProColorGradeMatchingService as Colour } from '../src/node/image/ProColorGradeMatchingService';
import { bandJpeg, GREY, routedVisionClient, SKY, STONE, surveyReply, type RoutedCall } from './helpers/photo-ornament-fixtures';
import { structureFit } from './helpers/staged-location-fixtures';

const STRUCTURE = {
    outline: [[-13.15, -5.5], [13.15, -5.5], [13.15, 5.5], [-13.15, 5.5]] as Array<[number, number]>,
    centroid: { x: 0, z: 0 }, facadeHeadingsDeg: [0, 90, 180, 270], cells: new Set<string>(), groundY: 0, heightM: 24.4
};
const GROUND = { cellIndex: () => -1, groundAt: () => 0 };
const pano = (id: string, x: number, z: number, date = '2025-06'): PanoCandidate => ({ panoId: id, lat: 0, lng: 0, x, z, date, copyright: '© Google' });
const PANOS = [pano('N1', 0, -34), pano('N2', 3, -40, '2021-05'), pano('E1', 44, 1), pano('S1', -4, 38), pano('W1', -46, -2), pano('FAR', 0, -190), pano('INSIDE', 0, 1)];
const deltaE = (a: number[], b: number[]) => Colour.calculateDeltaE00(Colour.srgbToLab(a[0], a[1], a[2]), Colour.srgbToLab(b[0], b[1], b[2]));

describe('which panos look at which faces', () => {
    it('takes one distinct pano per face from its outward side, wide, aimed at the face middle, 4:3', () => {
        const faces = footprintSurveyFaces(STRUCTURE);
        expect(faces.map(f => f.headingDeg).sort((a, b) => a - b)).toEqual([0, 90, 180, 270]);
        const plan = selectSurveyViews(PANOS, faces, STRUCTURE, GROUND, new Float32Array(0));
        expect(plan.skipped).toEqual([]);
        expect(plan.views.length).toBe(4);
        expect(new Set(plan.views.map(v => v.panoId)).size).toBe(4);
        // the north face (outward 0 deg) is looked at from the north, the east face from the east, and so on
        const byHeading = (h: number) => plan.views.find(v => v.facadeHeadingDeg === h)!;
        expect(byHeading(0).panoId).toBe('N1');
        expect(byHeading(90).panoId).toBe('E1');
        expect(byHeading(180).panoId).toBe('S1');
        expect(byHeading(270).panoId).toBe('W1');
        for (const v of plan.views) {
            expect(v.fovDeg).toBeGreaterThanOrEqual(SURVEY_FOV_MIN_DEG);
            expect(v.fovDeg).toBeLessThanOrEqual(SURVEY_FOV_MAX_DEG);
            expect(v.aspectRatio).toBe('RATIO_4X3');
            // aimed at the vertical middle (12.2 m up): looking UP from a 2.5 m eye, elevation positive in the app's convention
            expect(v.pitchDeg).toBeGreaterThan(5);
            expect(v.pitchDeg).toBeCloseTo(surveyAim(v.eye, faces.find(f => f.headingDeg === v.facadeHeadingDeg)!).elevationDeg, 1);
        }
        // the pano 190 m away and the one inside the footprint are never chosen
        expect(plan.views.some(v => v.panoId === 'FAR' || v.panoId === 'INSIDE')).toBe(false);
        // newest wins among panos in front of the same face at similar distance: N1 (2025) over N2 (2021)
        expect(byHeading(0).panoId).not.toBe('N2');
    });

    it('skips a face no pano looks at and says why, and never reuses one pano for two faces', () => {
        const faces = footprintSurveyFaces(STRUCTURE);
        const plan = selectSurveyViews([pano('N1', 0, -34), pano('E1', 44, 1), pano('S1', -4, 38)], faces, STRUCTURE, GROUND, new Float32Array(0));
        expect(plan.views.map(v => v.facadeHeadingDeg).sort((a, b) => a - b)).toEqual([0, 90, 180]);
        expect(plan.skipped).toEqual([expect.objectContaining({ faceId: 'h270', headingDeg: 270, reason: expect.stringContaining('no Google panorama') })]);
        // one pano standing north-east can serve one face only
        const corner = selectSurveyViews([pano('NE', 40, -40)], faces, STRUCTURE, GROUND, new Float32Array(0));
        expect(corner.views.length).toBe(1);
        expect(corner.skipped.length).toBe(3);
    });

    it('keeps panos at different bearings apart where it can, and honours the image budget', () => {
        const faces = footprintSurveyFaces(STRUCTURE);
        // two north panos 4 deg apart and one 30 deg off: only the second pair differs in bearing; the east face wants E1 only
        const plan = selectSurveyViews([pano('N1', 0, -34), pano('N3', 36, -34), pano('E1', 44, 1)], faces, STRUCTURE, GROUND, new Float32Array(0));
        expect(plan.views.every(v => v.panoId !== undefined)).toBe(true);
        expect(selectSurveyViews(PANOS, faces, STRUCTURE, GROUND, new Float32Array(0), 2).views.length).toBe(2);
        expect(selectSurveyViews(PANOS, faces, STRUCTURE, GROUND, new Float32Array(0), 9).views.length).toBe(4);
    });

    it('uses the fitted faces\' outward normals when a fit is accepted, the footprint compass sides otherwise', () => {
        const fit = structureFit();
        const faces = fitSurveyFaces(fit, STRUCTURE);
        // the fixture has one vertical planar face (the north wall, outward -z): fewer than two groups falls back to the footprint
        expect(faces.map(f => f.source)).toEqual(['footprint', 'footprint', 'footprint', 'footprint']);
        // a fit with four walls: sources are the fit's
        const wall = (id: string, origin: number[], u: number[], n: number[]) => ({ ...fit.surfaces[0], id, areaM2: 300, chart: { plane: { origin, u, v: [0, 1, 0], normal: n, extentUv: [[0, 0], [26, 24]] } } });
        const four = { surfaces: [wall('w0', [-13, 0, -5.5], [1, 0, 0], [0, 0, -1]), wall('w1', [13, 0, -5.5], [0, 0, 1], [1, 0, 0]), wall('w2', [13, 0, 5.5], [-1, 0, 0], [0, 0, 1]), wall('w3', [-13, 0, 5.5], [0, 0, -1], [-1, 0, 0])] as any };
        const fromFit = fitSurveyFaces(four, STRUCTURE);
        expect(fromFit.map(f => f.source)).toEqual(['fit', 'fit', 'fit', 'fit']);
        expect(fromFit.map(f => f.headingDeg).sort((a, b) => a - b)).toEqual([0, 90, 180, 270]);
    });
});

describe('the one vision call', () => {
    const faces = footprintSurveyFaces(STRUCTURE);
    const grounding = (calls: any[], pixels: Record<string, Array<[number, number, number]>>) => ({
        retrieveGroundingImage: async (req: any) => {
            calls.push(req);
            return { image: bandJpeg(pixels[req.panoId] ?? [SKY, STONE]), mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree, pitchDegree: req.pitchDegree, fovDegree: req.fovDegree };
        }
    });
    const chainFor = (replies: Parameters<typeof routedVisionClient>[0], record: RoutedCall[]) => new VisionModelChain<string>({ client: routedVisionClient(replies, record), candidates: ['gemini-4-argon'] });

    it('fetches up to four images in parallel, makes ONE vision call, measures the colours from the pixels, and builds the hints', async () => {
        const fetched: any[] = [];
        const record: RoutedCall[] = [];
        const msgs: string[] = [];
        const r = await runFaceSurvey({
            faces, panos: PANOS, structure: STRUCTURE, ground: GROUND, top: new Float32Array(0), deps: { mapsApiKey: 'k', grounding: grounding(fetched, { N1: [SKY, STONE, STONE, GREY], E1: [GREY], S1: [STONE], W1: [GREY, STONE] }) },
            chain: chainFor({ survey: surveyReply() }, record), onProgress: m => msgs.push(m)
        });
        // budget: 4 images, 1 call
        expect(fetched.length).toBe(4);
        expect(record.filter(c => c.kind === 'survey').length).toBe(1);
        expect(r.cost).toEqual({ images: 4, visionCalls: 1, seconds: expect.any(Number) });
        // the grounding pitch is in the API's sign (negative looks up) and the images were requested wide
        for (const q of fetched) { expect(q.pitchDegree).toBeLessThan(0); expect(q.fovDegree).toBeGreaterThanOrEqual(55); expect(q.aspectRatio).toBe('RATIO_4X3'); }
        // the model sees all four images and the prompt has no closed list of kinds
        const parts: any[] = record[0].params.contents[0].parts;
        expect(parts.filter(p => p.inlineData).length).toBe(4);
        const text = parts.filter(p => p.text).map(p => p.text).join('\n');
        expect(text).toMatch(/your own plain word/);
        expect(text).not.toMatch(/\b(dentil|cornice|balustrade|pilaster|column|window)\b.*\|/);
        // every face has an entry, its elements, and a palette MEASURED from its pixels (the model wrote no colour)
        const north = r.faces.find(f => f.headingDeg === 0)!;
        expect(north.panoId).toBe('N1');
        expect(north.elements.map(e => e.kind)).toContain('dentil cornice');
        expect(north.elements[0].repeat).toEqual({ count: 18, pitchRatio: 0.05, axis: 'h' });
        expect(north.palette!.measuredFromPhoto).toBe(true);
        expect(north.palette!.colours.some(c => deltaE(c.srgb, STONE) < 4)).toBe(true);
        expect(r.faces.find(f => f.headingDeg === 90)!.palette!.colours.some(c => deltaE(c.srgb, GREY) < 4)).toBe(true);
        // the hints are labelled and the contract holds
        expect(r.hints).toMatchObject({ label: 'photo-inferred', palette: 'measured-from-photo' });
        expect(r.hints.textureUse).toMatch(/^none/);
        expect(validateContract('materialHints', r.hints)).toEqual([]);
        // the located views carry what the detail pass needs (pose and size), and no bytes
        expect(r.read.length).toBe(4);
        expect(JSON.stringify(r)).not.toMatch(/"bytes"|inlineData/);
        expect(msgs.some(m => /first token/.test(m))).toBe(true);
    });

    it('a face without a pano is skipped and reported; the others are still read', async () => {
        const r = await runFaceSurvey({
            faces, panos: [pano('N1', 0, -34), pano('E1', 44, 1), pano('S1', -4, 38)], structure: STRUCTURE, ground: GROUND, top: new Float32Array(0),
            deps: { mapsApiKey: 'k', grounding: grounding([], {}) }, chain: chainFor({ survey: surveyReply(3) }, [])
        });
        expect(r.cost.images).toBe(3);
        const west = r.faces.find(f => f.headingDeg === 270)!;
        expect(west.skipped).toMatch(/no Google panorama/);
        expect(west.elements).toEqual([]);
        expect(r.faces.filter(f => !f.skipped).length).toBe(3);
        expect(validateContract('materialHints', r.hints)).toEqual([]);
    });

    it('drops an element that breaks the contract instead of the whole reply; a reply that is not JSON fails the stage with its model on record', async () => {
        const bad = surveyReply();
        bad.faces[0].elements.push({ kind: 'x', box: [500, 500, 400, 900], material: 'm', weathering: 'w', confidence: 50 } as any, { kind: '', box: [1, 2, 3, 4], material: 'm', weathering: 'w', confidence: 50 } as any);
        const r = await runFaceSurvey({ faces, panos: PANOS, structure: STRUCTURE, ground: GROUND, top: new Float32Array(0), deps: { mapsApiKey: 'k', grounding: grounding([], {}) }, chain: chainFor({ survey: bad }, []) });
        expect(r.faces.find(f => f.headingDeg === 0)!.elements.length).toBe(3);
        expect(r.problems.filter(p => /dropped an element/.test(p)).length).toBe(2);
        await expect(runFaceSurvey({ faces, panos: PANOS, structure: STRUCTURE, ground: GROUND, top: new Float32Array(0), deps: { mapsApiKey: 'k', grounding: grounding([], {}) }, chain: chainFor({ survey: { nothing: true } }, []) }))
            .rejects.toSatisfy((e: unknown) => e instanceof VisionStageError && /no "faces" list/.test(e.message) && e.model.outcome === 'failed' && e.model.requested === 'gemini-4-argon');
    });

    it('fails with no_street_view when no pano sees any face or every image fails, and fetches nothing in the first case', async () => {
        const fetched: any[] = [];
        await expect(runFaceSurvey({ faces, panos: [pano('FAR', 0, -190)], structure: STRUCTURE, ground: GROUND, top: new Float32Array(0), deps: { mapsApiKey: 'k', grounding: grounding(fetched, {}) }, chain: chainFor({ survey: surveyReply() }, []) }))
            .rejects.toMatchObject({ reasonCode: 'no_street_view' });
        expect(fetched).toEqual([]);
        const failing = { retrieveGroundingImage: async () => { throw new Error('Maps Imagery Grounding API 503: Deadline expired'); } };
        await expect(runFaceSurvey({ faces, panos: PANOS, structure: STRUCTURE, ground: GROUND, top: new Float32Array(0), deps: { mapsApiKey: 'k', grounding: failing }, chain: chainFor({ survey: surveyReply() }, []) }))
            .rejects.toMatchObject({ reasonCode: 'no_street_view', transient: true });
    });

    it('parses defensively: truncation and a wrong image index', () => {
        expect(() => parseSurveyReply('{"faces":[', 'MAX_TOKENS', 4)).toThrow(/cut off/);
        const p = parseSurveyReply(JSON.stringify({ faces: [{ image: 9, elements: [], materials: [] }, { image: 0, elements: [], materials: [] }] }), 'STOP', 4);
        expect(p.faces.size).toBe(1);
        expect(p.problems[0]).toMatch(/image 9/);
        expect(surveyPrompt([]).preamble).toMatch(/0 Google Street View photographs/);
        expect(surveyContents([]).length).toBe(1);
    });
});
