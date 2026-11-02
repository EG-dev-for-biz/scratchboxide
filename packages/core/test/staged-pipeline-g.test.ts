/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G on synthetic inputs (no network, no model): a station's depth laid onto a wall plate in metres, a facade
 * program turned into native openings and sweeps (read vs continued kept apart), arched opening outlines, and the paint
 * (glazing inside the arch, wall colour in its spandrels, an unread face generated).
 */

import { describe, expect, it } from 'vitest';
import { emptyPlate, finishPlate, layStation, PLATE_PIXEL_M } from '../src/node/3d-engine/staged-location/pipeline-g/plates';
import { programItems, parseProgram } from '../src/node/3d-engine/staged-location/pipeline-g/read';
import { enclosedHoles, G_SRC, inOpening, paintFaces, plateOntoFace, sweepFootprints } from '../src/node/3d-engine/staged-location/pipeline-g/pipeline-g';
import type { MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { aerialStations, AERIAL_VIEWS } from '../src/node/3d-engine/staged-location/pipeline-g/stations';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';

/** A 10 m x 8 m wall facing +z (south) at z = 0, s along +x from 0, t up from 0. */
const WALL: MassingFace = {
    index: 0, key: 'w:p:0:0', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true,
    normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0],
    sMin: 0, sMax: 10, tMin: 0, tMax: 8, tBottom: 0, area: 80, pixel: 0.05, orthoSMin: 0, orthoTMax: 8, width: 200, height: 160, coverage: 1, openings: [], top: []
};


describe('wall plates', () => {
    it('lays a square-on station onto the wall in metres, with its relief', () => {
        // a camera 10 m in front of the wall at (5, 4, 10) looking at its centre; every pixel hits the wall plane z = 0
        // except a 1 m-proud band (z = 1) across 3 <= y <= 3.5
        const w = 800, h = 450, vfov = 60;
        const fy = (h / 2) / Math.tan((vfov * Math.PI / 180) / 2);
        const depth = new Float32Array(w * h), rgba = new Uint8Array(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const v = (y + 0.5 - h / 2) / fy;
            const wy = 4 - v * 10;
            const proud = wy >= 3 && wy <= 3.5;
            depth[y * w + x] = proud ? 9 : 10;
            rgba.set(proud ? [200, 50, 50, 255] : [90, 90, 120, 255], (y * w + x) * 4);
        }
        const plate = emptyPlate(0, WALL);
        const hits = layStation({ rgba, depth, cameraPose: { x: 5, y: 4, z: 10, targetX: 5, targetY: 4, targetZ: 0, up: [0, 1, 0] }, intrinsics: { verticalFovDegrees: vfov }, width: w, height: h }, 1, [plate], [WALL]);
        const done = finishPlate(plate);
        // the frame spans about 20 x 11.5 m at the wall: the 10 x 8 m wall fills about a third of it
        expect(hits[0]).toBeGreaterThan(w * h * 0.3);
        // the frame spans about 2 * 10 * tan(30) = 11.5 m vertically: the whole 8 m wall height, about 10 m of its width
        expect(done.coverage).toBeGreaterThan(0.85);
        // the band lands at its height with its relief, the wall around it on the plane
        const at = (s: number, t: number) => Math.floor((WALL.tMax - t) / PLATE_PIXEL_M) * done.w + Math.floor((s - WALL.sMin) / PLATE_PIXEL_M);
        expect(done.relief[at(5, 3.25)]).toBeCloseTo(1, 1);
        expect([...done.rgb.subarray(at(5, 3.25) * 3, at(5, 3.25) * 3 + 3)]).toEqual([200, 50, 50]);
        expect(done.relief[at(5, 6)]).toBeCloseTo(0, 3);
        expect(done.stations).toEqual([1]);
    });
});

describe('facade program', () => {
    const prog = parseProgram('```json\n' + JSON.stringify({
        wallColour: '#a0a0b0',
        openings: [{ h0: 1, h1: 4, archRise: 5, depth: 0.3, colour: '#202830', cols: [[1, 2.5], [4, 5.5]], filledCols: [[7, 8.5]] }],
        horizontal: [{ h: 5, u0: 0, u1: 10, colour: '#c0c0c0', profile: [[-0.2, 0], [0, 0.3], [0.2, 0]] }],
        vertical: [{ u: [3.25], filledU: [6.25], h0: 0, h1: 8, profile: [[-0.15, 0], [0, 0.1], [0.15, 0]] }],
        notes: 'synthetic'
    }) + '\n```');
    const items = programItems(prog, WALL, 'g0_');

    it('keeps what was read photo-inferred and what was continued generated', () => {
        expect(items.openings.map(o => o.provenance)).toEqual(['photo-inferred', 'photo-inferred', 'generated']);
        expect(items.counts).toEqual({ openings: 3, filledOpenings: 1, horizontal: 1, vertical: 2, filledVertical: 1, paned: 0, sills: 0, surrounds: 0 });
        expect(items.faceSweeps.map(w => [w.id, w.provenance, w.axis])).toEqual([['g0_h0', 'photo-inferred', 0], ['g0_v0', 'photo-inferred', 1], ['g0_v0f', 'generated', 1]]);
    });

    it('places openings in the face frame and clamps the arch rise to half the width', () => {
        expect(items.openings[0]).toMatchObject({ face: WALL.key, s0: 1, s1: 2.5, t0: 1, t1: 4, depth: 0.3, archRiseM: 0.75 });
        expect(items.wallColour).toEqual([160, 160, 176]);
        expect(items.colours.get('g0_o0_0')).toEqual([32, 40, 48]);
    });

    it('a horizontal profile covers its height band, a vertical one its width around each centre', () => {
        const [band] = sweepFootprints(items.faceSweeps[0]);
        expect(band[0]).toBe(0); expect(band[1]).toBe(10); expect(band[2]).toBeCloseTo(4.8, 9); expect(band[3]).toBeCloseTo(5.2, 9);
        const [member] = sweepFootprints(items.faceSweeps[1]);
        expect(member[0]).toBeCloseTo(3.1, 9); expect(member[1]).toBeCloseTo(3.4, 9); expect(member[2]).toBe(0); expect(member[3]).toBe(8);
    });
});

describe('arched opening outline and paint', () => {
    const o = { s0: 1, s1: 3, t0: 1, t1: 5, archRiseM: 1 };
    it('is the rectangle to the springing line and the semicircle above', () => {
        expect(inOpening(o, 2, 4.9)).toBe(true);       // under the crown
        expect(inOpening(o, 1.05, 4.9)).toBe(false);   // a spandrel corner
        expect(inOpening(o, 1.05, 3.9)).toBe(true);    // the jamb below the springing
        expect(inOpening(o, 3.5, 3)).toBe(false);
    });

    it('paints glazing inside the arch, wall in the spandrel, and an unread face generated', () => {
        const prog = programItems({ wallColour: '#ff0000', openings: [{ h0: 1, h1: 5, archRise: 1, colour: '#0000ff', cols: [[1, 3]] }] }, WALL, 'g0_');
        const other: MassingFace = { ...WALL, index: 1, key: 'w:p:0:1' };
        const tex = paintFaces([WALL, other], new Map([[WALL.key, prog]]), [10, 20, 30]);
        const px = (s: number, t: number) => Math.floor((WALL.orthoTMax - t) / WALL.pixel) * WALL.width + Math.floor((s - WALL.orthoSMin) / WALL.pixel);
        const t0 = tex.get(0)!;
        expect([...t0.rgba.subarray(px(2, 4.9) * 4, px(2, 4.9) * 4 + 3)]).toEqual([0, 0, 255]);
        expect([...t0.rgba.subarray(px(1.05, 4.9) * 4, px(1.05, 4.9) * 4 + 3)]).toEqual([255, 0, 0]);
        expect(t0.source[px(2, 4.9)]).toBe(G_SRC.read);
        const t1 = tex.get(1)!;
        expect([...t1.rgba.subarray(0, 3)]).toEqual([10, 20, 30]);
        expect(t1.source[0]).toBe(G_SRC.continued);
    });

    it('gives a face built without the tile bake its own raster frame, so it is painted', () => {
        const unbaked: MassingFace = { ...WALL, pixel: 0, width: 0, height: 0, orthoSMin: 0, orthoTMax: 0 };
        const tex = paintFaces([unbaked], new Map([[WALL.key, programItems({ wallColour: '#336699' }, WALL, 'g0_')]]), [0, 0, 0]);
        expect(unbaked).toMatchObject({ pixel: 0.05, orthoSMin: 0, orthoTMax: 8, width: 200, height: 160 });
        expect([...tex.get(0)!.rgba.subarray(0, 3)]).toEqual([51, 102, 153]);
    });
});

describe('facade texture input from the survey plate', () => {
    it('resamples the plate onto the built face through world space, the painted texture where the plate saw nothing', () => {
        // the surveyed face: the same wall, its frame's origin 2 m along (s runs 2 m short), so a plate texel at s = 3 lies at x = 5
        const surveyed: MassingFace = { ...WALL, origin: [2, 0, 0], sMin: -2, sMax: 8 };
        const pl = { ...emptyPlate(0, surveyed), coverage: 0.5 };
        const H0 = pl.h;
        // the plate sees only its right half (x from 5 m), coloured by x so the mapping is visible
        for (let y = 0; y < pl.h; y++) for (let x = 0; x < pl.w; x++) {
            const s = surveyed.sMin + (x + 0.5) * PLATE_PIXEL_M;
            if (s + 2 < 5) continue;
            const j = y * pl.w + x;
            pl.rgb.set([Math.round((s + 2) * 20), 50, 60], j * 3);
            pl.relief[j] = 0;
        }
        const painted = paintFaces([WALL], new Map([[WALL.key, programItems({ wallColour: '#102030' }, WALL, 'g0_')]]), [0, 0, 0]).get(0)!;
        const on = plateOntoFace(WALL, painted, pl, surveyed)!;
        const px = (s: number, t: number) => Math.floor((WALL.orthoTMax - t) / WALL.pixel) * WALL.width + Math.floor((s - WALL.orthoSMin) / WALL.pixel);
        // x = 7 m on the built face reads the plate texel at x = 7 m (red channel 140), and is marked seen (4 m up: above the street band)
        expect(Math.abs(on.tex.rgba[px(7.01, 4) * 4] - 140)).toBeLessThanOrEqual(1);
        expect(on.use[px(7.01, 4)]).toBe(1);
        // x = 2 m was not seen: the painted wall colour, unmarked
        expect([...on.tex.rgba.subarray(px(2, 4) * 4, px(2, 4) * 4 + 3)]).toEqual([16, 32, 48]);
        expect(on.use[px(2, 4)]).toBe(0);
        // the right half above the 2.5 m street band; the band itself is never seen
        expect(on.covered).toBeCloseTo(0.5 * (8 - 2.5) / 8, 1);
        expect(on.use[px(7.01, 1)]).toBe(0);
        expect(on.street[px(7.01, 1)]).toBe(1);
        // the painted texture itself is not changed
        expect(painted.rgba[px(7.01, 4) * 4]).toBe(16);
        // the wall set back 1 m from the massing plane is still the wall; a blob standing 1 m in front of it is not
        const back = { ...pl, relief: pl.relief.map(v => (Number.isNaN(v) ? v : v - 1)) };
        expect(plateOntoFace(WALL, painted, back, surveyed)!.covered).toBeCloseTo(0.5 * (8 - 2.5) / 8, 1);
        const blob = { ...pl, relief: Float32Array.from(pl.relief) };
        for (let y = 0; y < pl.h; y++) for (let x = 0; x < pl.w; x++) { const s = surveyed.sMin + (x + 0.5) * PLATE_PIXEL_M; const tt = (H0 - y) * PLATE_PIXEL_M; if (s + 2 > 8 && tt > 3 && tt < 4.5) blob.relief[y * pl.w + x] = 1; }
        const onBlob = plateOntoFace(WALL, painted, blob, surveyed)!;
        expect(onBlob.use[px(9, 3.6)]).toBe(0);
        expect(onBlob.use[px(7.01, 4)]).toBe(1);
    });
});

describe('openings from the survey: enclosed seen-through holes', () => {
    it('keeps a hole inside the wall and drops one open to the frame\'s edge or larger than an opening', () => {
        const W = 100, H = 80, m = new Uint8Array(W * H);
        for (let y = 20; y < 40; y++) for (let x = 20; x < 30; x++) m[y * W + x] = 1;     // a window, 0.5 x 1 m at 0.05 m
        for (let y = 0; y < 10; y++) for (let x = 60; x < 70; x++) m[y * W + x] = 1;      // open to the top edge
        const o = enclosedHoles(m, W, H, 0.05);
        expect(o[30 * W + 25]).toBe(1);
        expect(o[5 * W + 65]).toBe(0);
        // the same window at 2 m per texel is 800 m2: not an opening
        expect(enclosedHoles(m, W, H, 2)[30 * W + 25]).toBe(0);
    });
});

describe('pipeline G aerial stations', () => {
    it('frames the whole structure from above, four bearings around it', () => {
        const walls = [WALL, { ...WALL, index: 1, key: 'w:p:0:1', normal: [1, 0, 0] as [number, number, number], axisS: [0, 0, -1] as [number, number, number], origin: [10, 0, 0] as [number, number, number], sMax: 6 }];
        const aerials = aerialStations(walls, { groundY: 0, centroid: { x: 5, z: -3 } }, { lat: 0, lng: 0, elevationMeters: 0 }, 1);
        expect(aerials.length).toBe(AERIAL_VIEWS);
        const corners: Array<[number, number, number]> = [[0, 0, 0], [10, 0, 0], [10, 0, -6], [0, 0, -6], [0, 8, 0], [10, 8, 0], [10, 8, -6], [0, 8, -6]];
        for (const { station } of aerials) {
            const { pose, intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(station, 1280, 720);
            expect(pose.y).toBeGreaterThan(8);
            const eye = [pose.x, pose.y, pose.z], fwd = [pose.targetX - pose.x, pose.targetY - pose.y, pose.targetZ - pose.z];
            const fl = Math.hypot(fwd[0], fwd[1], fwd[2]);
            // every corner of the structure lies inside the vertical field of view's cone
            for (const c of corners) {
                const d = [c[0] - eye[0], c[1] - eye[1], c[2] - eye[2]];
                const cos = (d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2]) / (Math.hypot(d[0], d[1], d[2]) * fl);
                expect(Math.acos(cos) * 180 / Math.PI).toBeLessThan(intrinsics.verticalFovDegrees / 2);
            }
        }
    });
});
