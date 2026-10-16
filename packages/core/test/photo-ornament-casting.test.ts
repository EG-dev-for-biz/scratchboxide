/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The pitch convention of the grounding API, the camera model, and image boxes cast onto a known synthetic structure.
 * No network, no image: only the geometry.
 */
import { describe, it, expect } from 'vitest';
import { elevationForGroundingPitch, groundingPitchForElevation } from '../src/node/spatial/StreetViewGroundingImageService';
import { projectToFrame } from '../src/node/spatial/StreetViewPoseRegistrar';
import { boxPixels, castBox, castCamera, castRay, fitFaces, footprintFaces, pixelRay, slotForCast, type CastFace, type CastView } from '../src/node/3d-engine/staged-location/survey-casting';
import { EVIDENCE_IMAGE_TIMEOUT_MS, fetchViews, type SelectedView } from '../src/node/3d-engine/staged-location/streetview-evidence';
import { StreetViewGroundingImageService } from '../src/node/spatial/StreetViewGroundingImageService';
import { bandJpeg, STONE } from './helpers/photo-ornament-fixtures';
import { structureFit } from './helpers/staged-location-fixtures';

const NORTH: CastFace = { id: 'north', source: 'fit', chart: { plane: { origin: [-13, 0, -5.5], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, -1], extentUv: [[0, 0], [26, 24]] } } };
const view = (over: Partial<CastView> = {}): CastView => ({ eye: [0, 2.5, -40], headingDeg: 180, pitchDeg: 20, fovDeg: 50, widthPx: 1440, heightPx: 1080, ...over });

describe('grounding pitch convention', () => {
    it('the API counts down as positive: looking up 34 degrees is pitch -34 (measured: +38 gave pavement, -34 gave cornice and spandrels)', () => {
        expect(groundingPitchForElevation(34)).toBe(-34);
        expect(groundingPitchForElevation(-38)).toBe(38);
        expect(groundingPitchForElevation(0)).toBe(0);
        expect(Object.is(groundingPitchForElevation(0), 0)).toBe(true);
        expect(elevationForGroundingPitch(-34)).toBe(34);
        expect(groundingPitchForElevation(120)).toBe(-90);
    });
    it('fetchViews converts the app elevation at the call, so every staged caller is right', async () => {
        const sent: number[] = [];
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
        const grounding = { retrieveGroundingImage: async (req: any) => { sent.push(req.pitchDegree); return { image: jpeg, mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: 0, pitchDegree: req.pitchDegree, fovDegree: 50 }; } };
        const v = (pitchDeg: number): SelectedView => ({ panoId: 'p', eye: [0, 2.5, 0], facadeHeadingDeg: 0, headingDeg: 0, pitchDeg, fovDeg: 50, aspectRatio: 'RATIO_4X3', distanceM: 30, score: 1 });
        await fetchViews([v(34), v(-10)], { mapsApiKey: 'k', grounding });
        expect(sent).toEqual([-34, 10]);
    });
});

describe('the camera model and box casting', () => {
    it('a view with positive elevation looks up: the image centre ray rises, a point above the axis lands above the centre', () => {
        const cam = castCamera(view({ pitchDeg: 30 }));
        const ray = pixelRay(cam, 720, 540);
        expect(ray.dir[1]).toBeCloseTo(Math.sin(30 * Math.PI / 180), 6);
        const hit = castRay(ray, [NORTH])!;
        expect(hit.point[2]).toBeCloseTo(-5.5, 6);
        expect(hit.v).toBeCloseTo(2.5 + 34.5 * Math.tan(30 * Math.PI / 180), 4);
        const above = projectToFrame(cam, [0, hit.v + 3, -5.5])!;
        expect(above[1]).toBeLessThan(540);
    });

    it('recovers a known point and box from a pixel: projecting a face point and casting it back lands within a millimetre', () => {
        const v = view();
        const cam = castCamera(v);
        const target: [number, number, number] = [3, 15, -5.5];
        const px = projectToFrame(cam, target)!;
        const hit = castRay(pixelRay(cam, px[0], px[1]), [NORTH])!;
        expect(Math.hypot(hit.point[0] - 3, hit.point[1] - 15, hit.point[2] + 5.5)).toBeLessThan(1e-3);
        expect([hit.u, hit.v].map(x => Math.round(x * 1000) / 1000)).toEqual([16, 15]);
        // a box around a 4 x 2 m region of the face, cast back
        const corners = [[1, 14], [5, 14], [5, 16], [1, 16]].map(([x, y]) => projectToFrame(cam, [x, y, -5.5])!);
        const box: [number, number, number, number] = [
            (Math.min(...corners.map(c => c[1])) / v.heightPx) * 1000, (Math.min(...corners.map(c => c[0])) / v.widthPx) * 1000,
            (Math.max(...corners.map(c => c[1])) / v.heightPx) * 1000, (Math.max(...corners.map(c => c[0])) / v.widthPx) * 1000
        ];
        const cast = castBox(v, box, [NORTH])!;
        expect(cast.faceId).toBe('north');
        expect(cast.hits).toBe(5);
        expect(cast.regionUv.u0).toBeCloseTo(14, 0); expect(cast.regionUv.u1).toBeCloseTo(18, 0); // the box is the image-space rectangle round a slanted quad, so it casts slightly wider
        expect(cast.regionUv.v0).toBeCloseTo(14, 0); expect(cast.regionUv.v1).toBeCloseTo(16, 0);
        expect(cast.metresPerPx).toBeGreaterThan(0.005); expect(cast.metresPerPx).toBeLessThan(0.05);
        expect(boxPixels(box, v.widthPx, v.heightPx).x1).toBeGreaterThan(boxPixels(box, v.widthPx, v.heightPx).x0);
    });

    it('a face seen from behind is not hit; a ray that misses the face extent is not hit', () => {
        const south = view({ eye: [0, 2.5, 40], headingDeg: 0, pitchDeg: 20 });
        expect(castRay(pixelRay(castCamera(south), 720, 540), [NORTH])).toBeUndefined();
        const aside = view({ headingDeg: 180 + 60, pitchDeg: 0 });
        expect(castRay(pixelRay(castCamera(aside), 720, 540), [NORTH])).toBeUndefined();
    });

    it('casts onto a cylinder face too (an arch intrados or a drum) and reports its arc coordinate', () => {
        const drum: CastFace = { id: 'drum', source: 'fit', chart: { cylinder: { axisOrigin: [0, 0, 0], axisDir: [0, 1, 0], thetaZeroDir: [1, 0, 0], radiusM: 10, thetaDeg: [0, 360], zM: [0, 20], normalSign: 1 } } };
        // from the +x side looking back toward the axis
        const v = view({ eye: [40, 5, 0], headingDeg: 270, pitchDeg: 0 });
        const hit = castRay(pixelRay(castCamera(v), 720, 540), [drum])!;
        expect(hit.point[0]).toBeCloseTo(10, 6);
        expect(hit.v).toBeCloseTo(5, 6);
        // from the inside the same surface is not hit
        expect(castRay(pixelRay(castCamera(view({ eye: [0, 5, 0], headingDeg: 90, pitchDeg: 0 })), 720, 540), [drum])).toBeUndefined();
    });

    it('finds the slot of a located element on the fitted faces, and falls back to the footprint faces without a fit', () => {
        const fit = structureFit();
        const faces = fitFaces(fit);
        const v = view({ eye: [0, 2.5, -40], headingDeg: 180, pitchDeg: 20 });
        const cam = castCamera(v);
        // S01 is the north spandrel, u 2..8, v 12..18 on s00 (s00 maps u to x + 13.15)
        const c = [[-11.15 + 1, 13], [-11.15 + 5, 13], [-11.15 + 5, 17], [-11.15 + 1, 17]].map(([x, y]) => projectToFrame(cam, [x, y, -5.5])!);
        const box: [number, number, number, number] = [Math.min(...c.map(p => p[1])) / v.heightPx * 1000, Math.min(...c.map(p => p[0])) / v.widthPx * 1000, Math.max(...c.map(p => p[1])) / v.heightPx * 1000, Math.max(...c.map(p => p[0])) / v.widthPx * 1000];
        const cast = castBox(v, box, faces)!;
        expect(cast.faceId).toBe('s00');
        expect(slotForCast(cast, fit)?.slotId).toBe('S01');
        // no accepted fit: the footprint's own vertical faces stand in, and the north face is the one hit
        const fp = footprintFaces([[-13.15, -5.5], [13.15, -5.5], [13.15, 5.5], [-13.15, 5.5]], { x: 0, z: 0 }, 0, 24.4);
        const fpCast = castBox(v, box, fp)!;
        expect(fpCast.source).toBe('footprint');
        expect(fpCast.centre[2]).toBeCloseTo(-5.5, 6);
        expect(fpCast.regionUv.v0).toBeGreaterThan(12);
    });
});

describe('the image limit and the retries', () => {
    const view = (panoId: string): SelectedView => ({ panoId, eye: [0, 2.5, 0], facadeHeadingDeg: 0, headingDeg: 0, pitchDeg: 20, fovDeg: 60, aspectRatio: 'RATIO_4X3', distanceM: 30, score: 1 });
    const jpeg = bandJpeg([STONE]);
    const ok = () => ({ ok: true, status: 200, text: async () => JSON.stringify({ redactedImage: { data: jpeg.toString('base64'), mimeType: 'image/jpeg' } }) } as any);
    const unavailable = () => ({ ok: false, status: 503, text: async () => JSON.stringify({ error: { message: 'Deadline expired before operation could complete.' } }) } as any);

    it('an image gets 30 s, not 8: the endpoint answers in 0.5-25 s', () => {
        expect(EVIDENCE_IMAGE_TIMEOUT_MS).toBe(30_000);
    });

    it('two 503s then an answer arrive inside the limit (the service retries); the request carries the API\'s pitch sign', async () => {
        const bodies: any[] = [];
        let n = 0;
        const service = new StreetViewGroundingImageService({
            getAccessToken: async () => 'tok', getProjectNumber: async () => '491718041258', retryDelayMs: 1,
            fetchImpl: (async (_url: string, init: any) => { bodies.push(JSON.parse(init.body)); return ++n < 3 ? unavailable() : ok(); }) as any
        });
        const r = await fetchViews([view('P1')], { mapsApiKey: 'k', grounding: service }, undefined, 5_000);
        expect(r.images).toHaveLength(1);
        expect(r.failures).toEqual([]);
        expect(n).toBe(3);
        expect(bodies.every(b => b.panoIdLocation.pitchDegree === -20)).toBe(true); // up 20 degrees is -20 for the API
    });

    it('an image that never answers is given up on at the limit, as transient, while the others land', async () => {
        const grounding = {
            retrieveGroundingImage: async (req: any, signal?: AbortSignal) => {
                if (req.panoId === 'SLOW') return new Promise<never>((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason)));
                return { image: jpeg, mimeType: 'image/jpeg', panoId: req.panoId, headingDegree: 0, pitchDegree: 0, fovDegree: 60 };
            }
        };
        const r = await fetchViews([view('FAST'), view('SLOW')], { mapsApiKey: 'k', grounding }, undefined, 250);
        expect(r.images.map(i => i.view.panoId)).toEqual(['FAST']);
        expect(r.failures).toEqual([expect.objectContaining({ error: 'timed out after 0.25 s', transient: true })]);
    });
});
