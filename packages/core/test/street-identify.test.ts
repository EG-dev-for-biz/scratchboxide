/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street identification (street-identify.ts) without the network or a model: the model's reply parsed, a box cast into
 * a rendered depth image places a known pole where it stands and measures its height and width, boxes from two views that
 * land together and say the same merge (and those that do not, do not), objects match the inventory entity they stand on
 * (and a bin a metre off a wall is not fixed to the building), the panos are spaced and capped, and the identifications go
 * into the inventory as labels on what the scan has and as new photo-inferred entities where it has nothing.
 */

import { describe, expect, it } from 'vitest';
import { applyStreetIdentification, castReading, fetchStaticViews, matchToInventory, mergeDetections, parseStreetOutdoors, parseStreetReply, pickPanos, streetPoints, type StreetDetection, type StreetIdentifyResult } from '../src/node/3d-engine/staged-location/street-identify';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { projectToFrame, renderFrameDepth } from '../src/node/spatial/StreetViewPoseRegistrar';
import type { SceneInventory } from '../src/node/3d-engine/staged-location/scene-inventory';
import type { SbFeature } from '../src/common/spatial/sb-feature-types';

type V3 = [number, number, number];

/** A flat street at y = 0, 200 m square. */
const GROUND = { vertices: Float32Array.from([-100, 0, -100, 100, 0, -100, 100, 0, 100, -100, 0, 100]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };

/** The 0..1000 box a vertical pole from `foot` up `h` metres, `w` wide, makes in `cam`. */
function poleBox(cam: ReturnType<typeof castCamera>, foot: V3, h: number, w: number): [number, number, number, number] {
    const pts: V3[] = [[foot[0] - w / 2, foot[1], foot[2]], [foot[0] + w / 2, foot[1], foot[2]], [foot[0] - w / 2, foot[1] + h, foot[2]], [foot[0] + w / 2, foot[1] + h, foot[2]]];
    const px = pts.map(p => projectToFrame(cam, p)!);
    const xs = px.map(p => p[0]), ys = px.map(p => p[1]);
    return [Math.min(...ys) / cam.height * 1000, Math.min(...xs) / cam.width * 1000, Math.max(...ys) / cam.height * 1000, Math.max(...xs) / cam.width * 1000];
}

const view = (headingDeg: number, eye: V3 = [0, 2.5, 0]) => ({ eye, headingDeg, pitchDeg: 6, fovDeg: 90 });

describe('the reply', () => {
    it('keeps well-formed objects, clamps boxes, and drops what has no label or a broken box', () => {
        const r = parseStreetReply(JSON.stringify({ objects: [
            { label: 'fire hydrant', box_2d: [600, 400, 900, 450], code: 'SB_FEATURE_TYPE_STREET_FURNITURE', heightM: 0.8, baseVisible: true, permanent: true, confidence: 0.9, shape: 'a squat cylinder with a domed cap' },
            { label: 'traffic cone', box_2d: [700, 100, 1100, 130], permanent: false },
            { label: '', box_2d: [0, 0, 10, 10] },
            { label: 'broken', box_2d: [500, 500, 400, 600] }
        ] }));
        expect(r).toHaveLength(2);
        expect(r[0]).toMatchObject({ label: 'fire hydrant', heightM: 0.8, permanent: true, baseVisible: true, confidence: 0.9 });
        expect(r[1].box[2]).toBe(1000);
        expect(r[1].permanent).toBe(false);
        expect(parseStreetReply('not json')).toEqual([]);
        // an interior capture (a gallery panorama Google took inside): the model says so, and the view's boxes are not used
        expect(parseStreetOutdoors('{"outdoors": false, "objects": []}')).toBe(false);
        expect(parseStreetOutdoors('{"objects": []}')).toBe(true);
        expect(parseStreetReply('```json\n[{"label":"bench","box_2d":[1,2,3,4]}]\n```')).toHaveLength(1);
    });
});

describe('casting a box', () => {
    it('places a pole where it stands and measures it, from a rendered depth image', () => {
        const cam = castCamera({ ...view(0), widthPx: 800, heightPx: 600 });
        const depthCam = castCamera({ ...view(0), widthPx: 400, heightPx: 300 });
        const depth = renderFrameDepth(GROUND, depthCam);
        const foot: V3 = [1.5, 0, -12];
        const c = castReading({ box: poleBox(cam, foot, 5, 0.4) }, cam, depth, depthCam)!;
        expect(c).toBeDefined();
        expect(Math.hypot(c.foot[0] - foot[0], c.foot[2] - foot[2])).toBeLessThan(0.35);
        // the foot takes the nearest depth in a few-pixel window (a pole's foot is a few pixels wide): at 12 m one pixel of
        // the 400 px depth image spans about 6 cm, so the foot may sit that much above the street
        expect(Math.abs(c.foot[1])).toBeLessThan(0.15);
        expect(c.heightM).toBeGreaterThan(4.6);
        expect(c.heightM).toBeLessThan(5.4);
        expect(c.widthM).toBeGreaterThan(0.3);
        expect(c.widthM).toBeLessThan(0.6);
        expect(c.rangeM).toBeCloseTo(Math.hypot(1.5, 12), 0);
        // a box whose foot is in the sky meets nothing
        expect(castReading({ box: [10, 400, 40, 420] }, cam, depth, depthCam)).toBeUndefined();
    });
});

describe('merging and matching', () => {
    const det = (view: number, label: string, foot: V3, h = 4, conf = 0.8): StreetDetection =>
        ({ view, label, box: [0, 0, 1, 1], baseVisible: true, permanent: true, confidence: conf, cast: { foot, rangeM: 10, heightM: h, widthM: 0.3 } });

    it('merges boxes from different views that land together and say the same, and keeps the rest apart', () => {
        const objs = mergeDetections([
            det(0, 'street lamp pole', [5, 0, 5], 8), det(1, 'lamp post', [5.6, 0, 5.4], 8.4), det(2, 'street lamp', [4.7, 0, 4.9], 7.6),
            det(1, 'fire hydrant', [5.3, 0, 5.2], 0.8),      // beside the lamp, a different thing
            det(0, 'bench', [6.6, 0, 5.1], 0.9),             // the same view as the lamp, 1.4 m from the hydrant: apart
            det(3, 'street lamp', [30, 0, 30], 8)            // far away
        ]);
        const lamp = objs.find(o => o.views.length === 3)!;
        expect(lamp.label).toMatch(/lamp/);
        expect(lamp.heightM).toBe(8);
        expect(lamp.confidence).toBeCloseTo(0.8, 6);
        expect(objs).toHaveLength(4);
        expect(objs.find(o => o.label === 'fire hydrant')!.views).toEqual([1]);
        expect(objs.find(o => o.label === 'fire hydrant')!.confidence).toBeCloseTo(0.56, 6);  // one view: the model's word alone
        // the same spot and the same height under two names (Flatiron: one view's "trash bin", another's "round planter")
        // is one thing; it needs both views close, where placement is good
        const named = mergeDetections([det(0, 'trash bin', [1, 0, 1], 1.0), det(1, 'round concrete planter', [1.4, 0, 1.3], 0.9)]);
        expect(named).toHaveLength(1);
        expect(named[0].labels.map(l => l.label).sort()).toEqual(['round concrete planter', 'trash bin']);
        const far = (d: StreetDetection): StreetDetection => ({ ...d, cast: { ...d.cast!, rangeM: 22 } });
        expect(mergeDetections([far(det(0, 'trash bin', [1, 0, 1], 1.0)), far(det(1, 'round concrete planter', [1.4, 0, 1.3], 0.9))])).toHaveLength(2);
    });

    it('matches an object to the street cluster it stands as, a building only when fixed to it, and a crown it stands under', () => {
        const ent = (id: string, lo: V3, hi: V3): SbFeature => ({ schema: 'sb-feature/1', id, types: [], geometry: { boundingBox: { lo, hi } }, provenance: { label: 'measured', confidence: 1, sources: [{ kind: 'x', id: 'y' }] } });
        const inv = { entities: [ent('cluster/1', [4.8, 0, 4.8], [5.2, 8, 5.2]), ent('building/a', [10, 0, 0], [30, 20, 20]), ent('tree/7', [-25, 0, -25], [-15, 9, -15])] };
        const objs = mergeDetections([det(0, 'lamp', [5.5, 0, 5], 8), det(0, 'projecting sign', [10.3, 0, 8], 3), det(0, 'trash bin', [9, 0, 12], 1), det(0, 'bench', [-20, 0, -20], 1)]);
        matchToInventory(objs, inv);
        const by = (l: string) => objs.find(o => o.label === l)!;
        expect(by('lamp').match).toMatchObject({ entityId: 'cluster/1', relation: 'STANDS_AS' });
        expect(by('projecting sign').match).toMatchObject({ entityId: 'building/a', relation: 'ATTACHED_TO' });
        expect(by('trash bin').match).toBeUndefined();                       // a metre off the wall: on the pavement
        expect(by('bench').match).toMatchObject({ entityId: 'tree/7', relation: 'UNDER' });
    });
});

describe('planning', () => {
    it('samples the streets in the area and keeps panos apart, nearest the centre first, capped', () => {
        const pts = streetPoints([[[-100, 0], [100, 0]]], (x, z) => Math.hypot(x, z) <= 30, 12);
        expect(pts.length).toBeGreaterThanOrEqual(4);
        expect(pts.every(p => Math.abs(p.x) <= 30)).toBe(true);
        const panos = [0, 3, 8, 13, 25, 40].map((x, i) => ({ panoId: `p${i}`, lat: 0, lng: 0, x, z: 0 }));
        expect(pickPanos(panos, { x: 0, z: 0 }, 12, 3).map(p => p.panoId)).toEqual(['p0', 'p3', 'p4']);
    });
});

describe('the Street View Static API views (outside the grounding API\'s US coverage)', () => {
    it('asks for the same pano, heading and elevation, and records a view whose camera has the true 90 degree field of view', async () => {
        const asked: string[] = [];
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
        const fake = (async (url: string) => { asked.push(url); return url.includes('pano=bad') ? new Response('', { status: 404 }) : new Response(jpeg, { status: 200, headers: { 'content-type': 'image/jpeg' } }); }) as unknown as typeof fetch;
        const v = { panoId: 'abc', eye: [0, 2.5, 0] as V3, facadeHeadingDeg: 0, headingDeg: 120, pitchDeg: 6, fovDeg: 90, aspectRatio: 'RATIO_4X3' as const, distanceM: 0, score: 1 };
        const r = await fetchStaticViews([v, { ...v, panoId: 'bad' }], 'KEY', { fovDeg: 90, staticWidthPx: 640, staticHeightPx: 480 }, fake);
        expect(r.images).toHaveLength(1);
        expect(r.failures[0]).toMatch(/bad 120°: Street View Static API 404/);
        const q = new URL(asked[0]).searchParams;
        expect(Object.fromEntries(['size', 'pano', 'heading', 'pitch', 'fov', 'return_error_code'].map(k => [k, q.get(k)]))).toEqual({ size: '640x480', pano: 'abc', heading: '120', pitch: '6', fov: '90', return_error_code: 'true' });
        const im = r.images[0];
        expect(im.bytes.equals(jpeg)).toBe(true);
        const cam = castCamera({ eye: im.view.eye, headingDeg: im.view.headingDeg, pitchDeg: im.view.pitchDeg, fovDeg: im.view.fovDeg, widthPx: im.widthPx, heightPx: im.heightPx });
        expect(2 * Math.atan(cam.width / 2 / cam.fx) * 180 / Math.PI).toBeCloseTo(90, 6);
    });
});

describe('into the inventory', () => {
    it('labels the matched entity (photo-inferred, with its views) and adds an entity for what the scan has nothing for', () => {
        const cluster: SbFeature = { schema: 'sb-feature/1', id: 'cluster/1', types: ['SB_FEATURE_TYPE_OBJECT'], typeLabels: [{ code: 'SB_FEATURE_TYPE_OBJECT', confidence: 0.5 }], geometry: { boundingBox: { lo: [0, 0, 0], hi: [1, 3, 1] } }, provenance: { label: 'measured', confidence: 0.5, sources: [{ kind: 'residual-audit', id: 'a' }] } };
        const inv = { entities: [cluster] } as unknown as SceneInventory;
        const base = { labels: [], estimated: {}, shapes: ['a round pole'], detections: [], permanent: true };
        const r = { objects: [
            { ...base, id: 'street/0', label: 'parking sign post', code: 'SB_FEATURE_TYPE_POLE', foot: [0.5, 0, 0.5], heightM: 3, widthM: 0.3, views: [0, 1], confidence: 0.8, match: { entityId: 'cluster/1', relation: 'STANDS_AS', distanceM: 0 } },
            { ...base, id: 'street/1', label: 'fire hydrant', code: 'SB_FEATURE_TYPE_STREET_FURNITURE', foot: [9, 0, 9], heightM: 0.8, widthM: 0.4, views: [2], confidence: 0.6 }
        ] } as unknown as StreetIdentifyResult;
        expect(applyStreetIdentification(inv, r)).toEqual({ labelled: 1, added: 1 });
        expect(cluster.types).toContain('SB_FEATURE_TYPE_POLE');
        expect(cluster.typeLabels!.at(-1)!.by).toMatch(/vision model/);
        expect(cluster.provenance.sources.map(s => s.kind)).toContain('street-view');
        expect(cluster.description).toMatch(/Street View \(2 views\): parking sign post/);
        const added = inv.entities.find(e => e.id === 'street/1')!;
        expect(added.provenance.label).toBe('photo-inferred');
        expect(added.description).toMatch(/the scan has no geometry here/);
        expect((added.geometry.boundingBox as { hi: number[] }).hi[1]).toBeCloseTo(0.8, 6);
    });
});
