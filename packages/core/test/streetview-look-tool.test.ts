/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * streetview_look on a synthetic street, no network. Captures of three months: a June 2024 drive along the street north
 * of the spot, a June 2019 drive 5 m off the same line (found where it is the nearest capture; discovery lists one beside
 * a newer capture as superseded, and the look still uses it), a March 2021 drive up a cross street, and a user photosphere
 * (not eligible). The grounding service answers a real JPEG coloured by the month (red 2024, grey 2019, blue 2021) and
 * refuses the first pano it is asked for; the fake vision model reads the photo's centre (red: yes, grey: no, blue: the
 * spot hidden). The tool must cover every month, aim each view at the spot, size the field to an outline, replace and
 * report the refusal, write the bytes exactly as returned and tally the answers per month.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { geodeticToScan, scanToGeodetic, type GeodeticOrigin } from '../src/node/spatial/StreetViewSurveyPlanner';
import type { GroundingImage, GroundingImageRequest } from '../src/node/spatial/StreetViewGroundingImageService';
import { bearingDeg, STREET_VIEW_EYE_HEIGHT_M, type StreetViewEvidenceDeps } from '../src/node/3d-engine/staged-location/streetview-evidence';
import {
    aimAt, bearingArc, chooseLookViews, lookCandidates, lookProbePoints, lookPrompt, parseLookReply, runStreetViewLook, spotDistance, StreetViewLookNoCoverageError,
    type LookAsker, type LookSpot
} from '../src/node/gemini/tools/location-evidence/streetview-look';
import { StreetViewSurveyCredentialsError } from '../src/node/gemini/tools/location-evidence/streetview-survey';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { DEFAULT_TOOL_DECLARATIONS } from '../src/node/gemini/tools';

const SPOT: GeodeticOrigin = { lat: 40.7503, lng: -73.9917, heightMeters: 0 };
const DEG = Math.PI / 180;

interface SynthPano { panoId: string; x: number; z: number; date: string; copyright: string }
const PANOS: SynthPano[] = [
    ...Array.from({ length: 13 }, (_, k) => ({ panoId: `jun24_${k}`, x: -60 + 10 * k, z: -15, date: '2024-06', copyright: '© Google' })),
    ...Array.from({ length: 12 }, (_, k) => ({ panoId: `aug19_${k}`, x: -55 + 10 * k, z: -14, date: '2019-08', copyright: '© Google' })),
    ...Array.from({ length: 5 }, (_, k) => ({ panoId: `mar21_${k}`, x: 32, z: -5 + 10 * k, date: '2021-03', copyright: '© Google' })),
    { panoId: 'ugc_0', x: -8, z: 6, date: '2023-01', copyright: '© A. Photographer' }
];
const geo = (p: { x: number; z: number }) => scanToGeodetic(SPOT, p.x, 0, p.z);
const COLOUR: Record<string, [number, number, number]> = { '2024-06': [200, 30, 30], '2019-08': [128, 128, 128], '2021-03': [30, 30, 200] };

function jpeg(rgb: [number, number, number]): Buffer {
    const w = 64, h = 48, data = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255; }
    return Buffer.from(jpegJs.encode({ data, width: w, height: h }, 92).data);
}

const metadataFetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    const [lat, lng] = (url.searchParams.get('location') ?? '0,0').split(',').map(Number);
    const radius = Number(url.searchParams.get('radius') ?? 8);
    const q = geodeticToScan(SPOT, lat, lng);
    // the endpoint answers with the capture nearest the point
    const near = PANOS.map(p => ({ p, d: Math.hypot(p.x - q.x, p.z - q.z) })).filter(e => e.d <= radius).sort((a, b) => a.d - b.d)[0];
    const g = near && geo(near.p);
    const body = near ? { status: 'OK', pano_id: near.p.panoId, location: { lat: g.lat, lng: g.lng }, date: near.p.date, copyright: near.p.copyright } : { status: 'ZERO_RESULTS' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}) as unknown as typeof fetch;

describe('streetview_look', () => {
    let root: string;
    let served: Map<string, Buffer>;
    let requests: GroundingImageRequest[];
    let refused: string[];
    const grounding = {
        retrieveGroundingImage: async (req: GroundingImageRequest): Promise<GroundingImage> => {
            requests.push(req);
            // the first pano asked for is refused, as the API does an unpublished pano
            if (!refused.length) refused.push(req.panoId);
            if (refused.includes(req.panoId)) throw new Error('Maps Imagery Grounding API 403: Pano is not published or eligible.');
            const p = PANOS.find(x => x.panoId === req.panoId)!;
            const image = jpeg(COLOUR[p.date]);
            served.set(`${req.panoId}`, image);
            return { image, mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: req.headingDegree!, pitchDegree: req.pitchDegree!, fovDegree: req.fovDegree! };
        }
    };
    const streetView = (over: Partial<StreetViewEvidenceDeps> = {}): StreetViewEvidenceDeps => ({
        mapsApiKey: 'test-key', grounding, fetchImpl: metadataFetch, metadataCachePath: path.join(root, 'sv', `metadata-${Math.random()}.json`), refusedPanos: new Map(), ...over
    });
    let asked: Array<{ target: string; question: string }>;
    const asker: LookAsker = async (image, ask) => {
        asked.push({ target: ask.target, question: ask.question });
        const img = jpegJs.decode(image.bytes, { useTArray: true });
        const i = ((img.height >> 1) * img.width + (img.width >> 1)) * 4;
        const [r, , b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
        if (b > 150) return { placeInView: false, answer: 'a parked truck hides it', yes: null, confidence: 0.8 };
        return r > 150 ? { placeInView: true, answer: 'a sidewalk shed stands here', yes: true, confidence: 0.9 } : { placeInView: true, answer: 'the sidewalk is open', yes: false, confidence: 0.85 };
    };

    beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-look-')); });
    afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
    const reset = () => { served = new Map(); requests = []; refused = []; asked = []; };

    it('bearingArc takes the smallest arc, across north too', () => {
        expect(bearingArc([350, 10])).toEqual({ middleDeg: 0, spanDeg: 20 });
        const a = bearingArc([10, 80, 45]);
        expect(a.middleDeg).toBeCloseTo(45, 9);
        expect(a.spanDeg).toBeCloseTo(70, 9);
        expect(bearingArc([123])).toEqual({ middleDeg: 123, spanDeg: 0 });
    });

    it('aims a point view at the spot, at its mid-height', () => {
        const spot: LookSpot = { points: [{ x: 0, z: 0 }], heightM: 6 };
        const aim = aimAt({ x: 0, z: -20 }, spot);
        expect(aim.headingDeg).toBe(180);
        expect(aim.distanceM).toBe(20);
        const lo = Math.atan2(-STREET_VIEW_EYE_HEIGHT_M, 20) / DEG, hi = Math.atan2(6 - STREET_VIEW_EYE_HEIGHT_M, 20) / DEG;
        expect(aim.elevationDeg).toBeCloseTo((lo + hi) / 2, 1);
        // the vertical field (4:3) holds street to top
        const vfov = 2 * Math.atan(Math.tan(aim.fovDeg / 2 * DEG) * 3 / 4) / DEG;
        expect(vfov).toBeGreaterThanOrEqual(hi - lo);
        expect(aim.framed).toBe(true);
        // no height: level, the narrowest field
        expect(aimAt({ x: 0, z: -20 }, { points: [{ x: 0, z: 0 }] })).toMatchObject({ elevationDeg: 0, fovDeg: 30 });
    });

    it('sizes an outline view to the arc it spans, and says when it cannot fit', () => {
        const line: LookSpot = { points: [{ x: -15, z: 0 }, { x: 15, z: 0 }] };
        const cam = { x: 4, z: -25 };
        const aim = aimAt(cam, line);
        for (const p of line.points) expect(Math.abs(((bearingDeg(cam.x, cam.z, p.x, p.z) - aim.headingDeg + 540) % 360) - 180)).toBeLessThanOrEqual(aim.fovDeg / 2);
        expect(aim.framed).toBe(true);
        expect(aim.distanceM).toBe(25);
        // standing 2 m from a 30 m line, its ends lie ~165° apart: the widest field, not framed
        expect(aimAt({ x: 0, z: -2 }, line)).toMatchObject({ fovDeg: 90, framed: false });
        // inside a polygon: distance 0, the whole circle
        const square: LookSpot = { points: [{ x: -5, z: -5 }, { x: 5, z: -5 }, { x: 5, z: 5 }, { x: -5, z: 5 }] };
        expect(spotDistance({ x: 1, z: 1 }, square)).toBe(0);
        expect(aimAt({ x: 1, z: 1 }, square)).toMatchObject({ spanDeg: 360, framed: false });
    });

    it('chooses a new month first, then a new side, then the nearer', () => {
        const spot: LookSpot = { points: [{ x: 0, z: 0 }] };
        const pano = (p: SynthPano) => ({ ...p, ...geo(p) });
        const cands = lookCandidates(PANOS.filter(p => p.copyright === '© Google').map(pano), spot, 50);
        const three = chooseLookViews(cands, 3, 50);
        expect(new Set(three.map(c => c.pano.date))).toEqual(new Set(['2024-06', '2019-08', '2021-03']));
        // the first is the nearest capture; the fourth adds a side not yet seen
        expect(three[0].distanceM).toBe(Math.min(...cands.map(c => c.distanceM)));
        const four = chooseLookViews(cands, 4, 50);
        const sides = four.slice(0, 3).map(c => c.sideDeg);
        expect(Math.min(...sides.map(s => Math.abs(((four[3].sideDeg - s + 540) % 360) - 180)))).toBeGreaterThan(20);
    });

    it('covers every month, aims each view, replaces the refused pano and tallies the answers per month', async () => {
        reset();
        const sv = streetView();
        const r = await runStreetViewLook({ lat: SPOT.lat, lng: SPOT.lng, heightM: 4, description: 'the low structure on the sidewalk' },
            { maxViews: 6, question: 'Is a temporary sidewalk shed standing here?', outDir: path.join(root, 'out1'), workspaceRoot: root }, { streetView: sv, asker });

        expect(r.views.length).toBe(6);
        expect(new Set(r.views.map(v => v.captureMonth))).toEqual(new Set(['2024-06', '2019-08', '2021-03']));
        // the user photosphere is never asked for
        expect(requests.some(q => q.panoId.startsWith('ugc'))).toBe(false);
        expect(r.discovery.rejectedNotGoogle).toBe(1);
        // the refusal is reported with its replacement, which was fetched
        expect(r.refusals).toHaveLength(1);
        expect(r.refusals[0].panoId).toBe(refused[0]);
        expect(r.refusals[0].replacedBy).toBeDefined();
        expect(r.views.map(v => v.panoId)).toContain(r.refusals[0].replacedBy);
        expect(r.views.map(v => v.panoId)).not.toContain(refused[0]);

        for (const v of r.views) {
            const p = PANOS.find(x => x.panoId === v.panoId)!;
            // aimed at the spot: the heading is the bearing to it, the API pitch the elevation's negative
            expect(Math.abs(v.request.headingDeg - bearingDeg(p.x, p.z, 0, 0))).toBeLessThanOrEqual(0.051);
            expect(v.request.pitchDeg).toBe(v.request.elevationDeg === 0 ? 0 : -v.request.elevationDeg);
            expect(Math.abs(v.distanceM - Math.hypot(p.x, p.z))).toBeLessThanOrEqual(0.051);
            // written exactly as the API returned them
            expect(fs.readFileSync(path.join(root, v.imagePath)).equals(served.get(v.panoId)!)).toBe(true);
            expect(v.answer?.placeInView).toBe(p.date !== '2021-03');
        }
        expect(asked).toHaveLength(6);
        expect(asked.every(a => a.target === 'the low structure on the sidewalk' && a.question === 'Is a temporary sidewalk shed standing here?')).toBe(true);

        const month = (m: string) => r.months.find(x => x.month === m)!;
        const n = (m: string) => r.views.filter(v => v.captureMonth === m).length;
        expect(month('2024-06')).toMatchObject({ yes: n('2024-06'), no: 0, notInView: 0, failed: 0 });
        expect(month('2019-08')).toMatchObject({ yes: 0, no: n('2019-08') });
        expect(month('2021-03')).toMatchObject({ yes: 0, no: 0, notInView: n('2021-03') });
        // every month in range is listed with its captures, newest first, the older drive included though the thinning hides it
        expect(r.months.map(m => m.month)).toEqual(['2024-06', '2021-03', '2019-08']);
        expect(month('2019-08').capturesInRange).toBeGreaterThan(3);
        expect(r.summary).toContain('2024-06 yes');
        expect(r.summary).toContain('2019-08 no');
    });

    it('frames an outline from every camera that can hold it, and asks nothing without a question', async () => {
        reset();
        const ends = [{ x: -8, z: 0 }, { x: 8, z: 0 }];
        const corners = ends.map(geo);
        const r = await runStreetViewLook({ lat: SPOT.lat, lng: SPOT.lng, outline: corners.map(c => ({ lat: c.lat, lng: c.lng })) },
            { maxViews: 4, outDir: path.join(root, 'out2'), workspaceRoot: root }, { streetView: streetView(), asker });
        expect(asked).toHaveLength(0);
        expect(r.views.every(v => v.answer === undefined)).toBe(true);
        expect(r.months.every(m => m.yes === undefined)).toBe(true);
        expect(r.target.outline).toHaveLength(2);
        for (const v of r.views) {
            const p = PANOS.find(x => x.panoId === v.panoId)!;
            if (!v.framed) continue;
            for (const c of ends) {
                const off = Math.abs(((bearingDeg(p.x, p.z, c.x, c.z) - v.request.headingDeg + 540) % 360) - 180);
                expect(off).toBeLessThanOrEqual(v.request.fovDeg / 2 + 0.1);
            }
        }
        expect(r.views.some(v => v.framed)).toBe(true);
    });

    it('a question with no vision model is reported, never answered', async () => {
        reset();
        const r = await runStreetViewLook({ lat: SPOT.lat, lng: SPOT.lng }, { maxViews: 2, question: 'Is anything here?', outDir: path.join(root, 'out3'), workspaceRoot: root },
            { streetView: streetView(), askerUnavailable: 'no Gemini key' });
        expect(r.questionSkipped).toBe('no Gemini key');
        expect(r.views.every(v => v.answer === undefined)).toBe(true);
        expect(r.summary).toContain('The question was not asked: no Gemini key');
    });

    it('fails plainly without credentials or coverage', async () => {
        reset();
        await expect(runStreetViewLook({ lat: SPOT.lat, lng: SPOT.lng }, { outDir: root, workspaceRoot: root }, { streetView: { grounding, fetchImpl: metadataFetch } }))
            .rejects.toBeInstanceOf(StreetViewSurveyCredentialsError);
        // nothing within 5 m of the spot
        await expect(runStreetViewLook({ lat: SPOT.lat, lng: SPOT.lng }, { maxRangeM: 5, outDir: root, workspaceRoot: root }, { streetView: streetView() }))
            .rejects.toBeInstanceOf(StreetViewLookNoCoverageError);
        expect(requests).toHaveLength(0);
    });

    it('parses the answer shape and rejects anything else', () => {
        expect(parseLookReply('```json\n{"placeInView": true, "answer": "a shed", "yes": true, "confidence": 1.4}\n```')).toEqual({ placeInView: true, answer: 'a shed', yes: true, confidence: 1 });
        expect(parseLookReply('{"placeInView": false, "answer": "", "yes": "maybe"}')).toMatchObject({ yes: null, confidence: 0.5 });
        expect(() => parseLookReply('{"answer": "x"}')).toThrow(/placeInView/);
        expect(() => parseLookReply('no')).toThrow(/not JSON/);
        // the place, not the thing asked about, decides whether it is in view: a thing gone by a capture is a "no", not "not in view"
        expect(lookPrompt('the west sidewalk', 'Is a shed here?', 12, 40, 90)).toMatch(/true even when what the question asks about is absent/);
    });

    it('probes every point within reach and nothing far outside it', () => {
        const spot: LookSpot = { points: [{ x: 0, z: 0 }] };
        const probes = lookProbePoints(spot, 50);
        expect(probes.every(p => Math.hypot(p.x, p.z) <= 58 + 1e-9)).toBe(true);
        // any street point within range lies within the metadata search's 8 m of a probe
        for (let a = 0; a < 360; a += 7) for (const r of [0, 13, 29, 49]) {
            const q = { x: r * Math.sin(a * DEG), z: -r * Math.cos(a * DEG) };
            expect(Math.min(...probes.map(p => Math.hypot(p.x - q.x, p.z - q.z)))).toBeLessThanOrEqual(8);
        }
    });

    it('is registered as a tool', () => {
        expect(createDefaultToolRegistry().get('streetview_look')).toBeDefined();
        expect(DEFAULT_TOOL_DECLARATIONS.some(d => d.name === 'streetview_look')).toBe(true);
    });
});
