/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade material reading (facade-materials.ts) on a synthetic wall with analytic cameras: glass accepted only where
 * held-out evidence agrees (two panos, a pano and the tile, or the tile in a measured lattice), written as glass with the
 * photo kept as the fallback and labelled photo-inferred; coursing measured at the drawn pitch and joint width; the
 * kernel's structured pattern; the twin's material channels and extras.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { BakedTexturePlanes, PinholeCamera, ProjectionView, UvAtlas } from '../src/common/spatial/texture-pass-contracts';
import { packConfidenceTexel, unpackConfidenceTexel } from '../src/common/spatial/texture-pass-contracts';
import { MASK_NO, MASK_UNREAD, MASK_YES, faceFrame, gatherMaterialEvidence, type MaterialEvidence, type SurfaceMaterialMask } from '../src/node/3d-engine/staged-location/facade-material-evidence';
import { FACADE_MATERIAL_SOURCE, GLASS_ROUGHNESS, readCourses, readFacadeMaterials, detrendProfile } from '../src/node/3d-engine/staged-location/facade-materials';
import { bakeCourseProfile } from '../src/node/3d-engine/staged-location/masonry-relief-native';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

type V3 = [number, number, number];

/** A planar wall z = 0 facing +z, `size` metres square from the origin, at `texelM` per texel (one chart, map 0). */
function wallAtlas(size: number, texelM: number): UvAtlas {
    const W = Math.round(size / texelM), H = W, N = W * H;
    const position = new Float32Array(N * 3), normal = new Float32Array(N * 3), sizeM = new Float32Array(N).fill(texelM);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        position.set([(x + 0.5) * texelM, size - (y + 0.5) * texelM, 0], i * 3);
        normal.set([0, 0, 1], i * 3);
    }
    return {
        layerKey: 'l2', width: W, height: H,
        maps: [{ nodeName: 'wall', kind: 'chart-plane', texelsPerMeter: 1 / texelM, atlasRect: [0, 0, 1, 1], chartId: 's00' }],
        texels: { covered: new Uint8Array(N).fill(1), gutter: new Uint8Array(N), mapIndex: new Uint16Array(N), position, normal, sizeM }
    };
}

function camera(eye: V3, fx: number, w: number, h: number): PinholeCamera {
    return { eye, right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1], fx, fy: fx, cx: w / 2, cy: h / 2, width: w, height: h };
}

/** The wall point a pixel sees (the ray from the eye along -z meets z = 0). */
function wallPoint(cam: PinholeCamera, px: number, py: number): [number, number] {
    const z = cam.eye[2];
    return [cam.eye[0] + ((px + 0.5 - cam.cx) / cam.fx) * z, cam.eye[1] - ((py + 0.5 - cam.cy) / cam.fy) * z];
}

/** A view whose photo is `shade(x, y)` (sRGB 0..255 grey) of the wall point under each pixel. */
function view(panoId: string, eye: V3, fx: number, w: number, h: number, shade: (x: number, y: number) => number): ProjectionView {
    const camera_ = camera(eye, fx, w, h);
    const rgba = new Uint8Array(w * h * 4);
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        // a camera integrates over its pixel (4 x 4 samples), so a pattern finer than a pixel blurs rather than aliases
        let acc = 0;
        for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) { const [x, y] = wallPoint(camera_, px - 0.5 + (sx + 0.5) / 4, py - 0.5 + (sy + 0.5) / 4); acc += shade(x, y); }
        const v = Math.max(0, Math.min(255, Math.round(acc / 16)));
        rgba.set([v, v, v, 255], (py * w + px) * 4);
    }
    return { panoId, camera: camera_, image: { width: w, height: h, rgba }, poseQuality: 1, poseSigmaPx: 1 };
}

/** A mask of the view marking the wall points `inside(x, y)`. */
function viewMask(v: ProjectionView, viewIndex: number, inside: (x: number, y: number) => boolean) {
    const { width: w, height: h } = v.camera;
    const mask = new Uint8Array(w * h);
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) { const [x, y] = wallPoint(v.camera, px, py); mask[py * w + px] = inside(x, y) ? MASK_YES : MASK_NO; }
    return { viewIndex, panoId: v.panoId, width: w, height: h, mask, crops: 9, cropsFailed: 0 };
}

/** The wall's tile face raster (frame from faceFrame), marking `inside`, luminance `lum`. */
function tileFace(size: number, mpp: number, inside: (x: number, y: number) => boolean, lum: (x: number, y: number) => number): SurfaceMaterialMask {
    const { h, w } = faceFrame([0, 0, 1], [1, 0, 0]);
    const W = Math.round(size / mpp), H = W;
    const mask = new Uint8Array(W * H), luminance = new Float32Array(W * H);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
        const a = (c + 0.5) * mpp, b = size - (r + 0.5) * mpp;
        const x = a * h[0] + b * w[0], y = a * h[1] + b * w[1];
        mask[r * W + c] = inside(x, y) ? MASK_YES : MASK_NO;
        luminance[r * W + c] = lum(x, y);
    }
    return { surfaceId: 's00', origin: [0, 0, 0], h, w, normal: [0, 0, 1], a0: 0, b1: size, mppM: mpp, width: W, height: H, mask, luminance, crops: 1, cropsFailed: 0 };
}

/** The projected photo as the planes: mid grey walls, a brighter (reflected sky) window, rung 1, provenance 0. */
function photoPlanes(atlas: UvAtlas, inWindow: (x: number, y: number) => boolean): BakedTexturePlanes {
    const N = atlas.width * atlas.height;
    const albedo = new Uint8Array(N * 4);
    const confidence = { width: atlas.width, height: atlas.height, data: new Uint8Array(N * 4) };
    for (let i = 0; i < N; i++) {
        const x = atlas.texels.position[i * 3], y = atlas.texels.position[i * 3 + 1];
        // the window shows a reflection: bright in most texels, the interior dark in a few
        const v = inWindow(x, y) ? ((i % 7) === 0 ? 30 : 220) : 140;
        albedo.set([v, v, v, 255], i * 4);
        packConfidenceTexel(confidence, i, 0, 0.8, 1);
    }
    return { layerKey: atlas.layerKey, width: atlas.width, height: atlas.height, albedo, confidence, provenance: [{ source: 'street-view-projection', label: 'photo-inferred', method: 'test', coverage: 1 }], degradations: [] };
}

const evidence = (views: MaterialEvidence['views'], surfaces: SurfaceMaterialMask[] = []): MaterialEvidence =>
    ({ target: 'the glass window panes', views, surfaces, unavailable: [], models: ['test'], calls: views.length + surfaces.length, failedCalls: 0, ms: 0 });

const inWin = (x: number, y: number) => x > 4 && x < 6 && y > 4 && y < 7;

describe('facade material reading: glass', () => {
    const atlas = wallAtlas(10, 0.1);
    const views = [
        view('panoA', [3, 5, 16], 500, 640, 640, () => 128),
        view('panoB', [7, 5, 16], 500, 640, 640, () => 128),
        view('panoC', [5, 5, 18], 500, 640, 640, () => 128)
    ];

    it('accepts a window two panos mark, writes it as glass and keeps the photo as the fallback', () => {
        const planes = photoPlanes(atlas, inWin);
        const ev = evidence([viewMask(views[0], 0, inWin), viewMask(views[1], 1, inWin), viewMask(views[2], 2, inWin)]);
        const r = readFacadeMaterials({ atlas, planes, views, evidence: ev, delit: false });
        const glass = r.record.regions.filter(g => g.label === 'glass');
        expect(glass.length).toBe(1);
        expect(glass[0].accepted).toBe(true);
        expect(glass[0].decidedBy).toBe('street-view');
        expect(glass[0].evidence.panosMarking).toBe(3);
        expect(glass[0].fields.roughness).toBe(GLASS_ROUGHNESS);
        expect(glass[0].fields.delit).toBe(false);
        // the interior: the darker end of the region's own photo texels, not the bright reflection
        expect(glass[0].fields.albedoLinear[0]).toBeLessThan(0.05);
        // texels: inside the window glass, outside untouched
        const inside = atlas.width * 45 + 50, outside = atlas.width * 80 + 10;
        expect(r.glass[inside]).toBeGreaterThan(0);
        expect(r.glass[outside]).toBe(0);
        expect(r.roughness[inside]).toBe(Math.round(GLASS_ROUGHNESS * 255));
        expect(r.planes.albedo[inside * 4]).toBeLessThan(100);
        expect(r.planes.albedo[outside * 4]).toBe(140);
        expect(r.photoAlbedo[inside * 4]).toBe(planes.albedo[inside * 4]);
        // provenance: the reading's entry, photo-inferred, with the confidence in the weight
        const c = unpackConfidenceTexel(r.planes.confidence, inside);
        const e = r.planes.provenance[c.provenanceIndex];
        expect(e.source).toBe(FACADE_MATERIAL_SOURCE);
        expect(e.label).toBe('photo-inferred');
        expect(e.method).toMatch(/fallback/);
        expect(c.weight01).toBeCloseTo(glass[0].confidence, 1);
        expect(c.rung).toBe(1);
        expect(r.provenanceIndices).toEqual([c.provenanceIndex]);
    });

    it('rejects a window only one pano marks, and leaves the photo', () => {
        const planes = photoPlanes(atlas, inWin);
        const ev = evidence([viewMask(views[0], 0, inWin), viewMask(views[1], 1, () => false)]);
        const r = readFacadeMaterials({ atlas, planes, views: views.slice(0, 2), evidence: ev, delit: true });
        const glass = r.record.regions.filter(g => g.label === 'glass');
        expect(glass.length).toBe(1);
        expect(glass[0].accepted).toBe(false);
        expect(glass[0].reason).toMatch(/1 of 2 panos/);
        // a third pano that does not mark it leaves no candidate at all
        const r3_ = readFacadeMaterials({ atlas, planes, views, evidence: evidence([...ev.views, viewMask(views[2], 2, () => false)]), delit: true });
        expect(r3_.record.totals.glassTexels).toBe(0);
        expect(r.record.totals.glassTexels).toBe(0);
        expect(Buffer.from(r.planes.albedo).equals(Buffer.from(planes.albedo))).toBe(true);
    });

    it('a crop that was not read is not a vote: two marking panos still decide against an unread third', () => {
        const planes = photoPlanes(atlas, inWin);
        const unread = viewMask(views[2], 2, () => false);
        unread.mask.fill(MASK_UNREAD);
        const r = readFacadeMaterials({ atlas, planes, views, evidence: evidence([viewMask(views[0], 0, inWin), viewMask(views[1], 1, inWin), unread]), delit: true });
        const g = r.record.regions.find(x => x.label === 'glass')!;
        expect(g.accepted).toBe(true);
        expect(g.evidence.panosSeeing).toBe(2);
    });

    it('one pano and the tile agreeing decide together (both)', () => {
        const planes = photoPlanes(atlas, inWin);
        const ev = evidence([viewMask(views[0], 0, inWin)], [tileFace(10, 0.08, inWin, (x, y) => (inWin(x, y) ? 0.05 : 0.3))]);
        const r = readFacadeMaterials({ atlas, planes, views, evidence: ev, delit: true });
        const g = r.record.regions.find(x => x.label === 'glass')!;
        expect(g.accepted).toBe(true);
        expect(g.decidedBy).toBe('both');
    });

    it('the tile alone: accepted in a measured lattice of darker panes, rejected for a lone pane', () => {
        const lattice = (x: number, y: number) => [1.5, 4.5, 7.5].some(cx => x > cx && x < cx + 1.2) && y > 5 && y < 6.8;
        const planes = photoPlanes(atlas, lattice);
        const lum = (x: number, y: number) => (lattice(x, y) ? 0.04 : 0.3 + 0.05 * Math.sin(x * 9));
        const r = readFacadeMaterials({ atlas, planes, views: [], evidence: evidence([], [tileFace(10, 0.08, lattice, lum)]), delit: false });
        const glass = r.record.regions.filter(x => x.label === 'glass');
        expect(glass.length).toBe(3);
        for (const g of glass) { expect(g.accepted).toBe(true); expect(g.decidedBy).toBe('tiles'); expect(g.evidence.lattice!.neighbours).toBe(2); expect(g.evidence.lattice!.darker).toBe(true); }

        const lone = (x: number, y: number) => x > 4.5 && x < 5.7 && y > 5 && y < 6.8;
        const r2 = readFacadeMaterials({ atlas, planes: photoPlanes(atlas, lone), views: [], evidence: evidence([], [tileFace(10, 0.08, lone, lum)]), delit: false });
        const g2 = r2.record.regions.filter(x => x.label === 'glass');
        expect(g2.length).toBe(1);
        expect(g2[0].accepted).toBe(false);
        expect(g2[0].reason).toMatch(/does not agree/);
    });

    it('two marking panos the tile contradicts are rejected (the sources disagree)', () => {
        const planes = photoPlanes(atlas, inWin);
        const ev = evidence([viewMask(views[0], 0, inWin), viewMask(views[1], 1, inWin)], [tileFace(10, 0.08, () => false, () => 0.3)]);
        const r = readFacadeMaterials({ atlas, planes, views: views.slice(0, 2), evidence: ev, delit: false });
        const g = r.record.regions.find(x => x.label === 'glass')!;
        expect(g.accepted).toBe(false);
        expect(g.reason).toMatch(/disagree/);
    });

    it('a mask that leaks over a whole facade in one pano writes glass only where two panos agree, and nowhere the tile read as wall', () => {
        const planes = photoPlanes(atlas, inWin);
        const leak = (x: number, y: number) => x > 1 && x < 9 && y > 1 && y < 9;
        const ev = evidence([viewMask(views[0], 0, leak), viewMask(views[1], 1, inWin), viewMask(views[2], 2, inWin)]);
        const r = readFacadeMaterials({ atlas, planes, views, evidence: ev, delit: false });
        const wallTexel = atlas.width * 20 + 20, winTexel = atlas.width * 45 + 50;
        expect(r.glass[winTexel]).toBeGreaterThan(0);
        expect(r.glass[wallTexel]).toBe(0);
        // with the tile reading part of the window as wall, those texels are not glass either
        const half = (x: number, y: number) => inWin(x, y) && x < 5;
        const r2 = readFacadeMaterials({ atlas, planes, views, evidence: evidence([viewMask(views[0], 0, inWin), viewMask(views[1], 1, inWin), viewMask(views[2], 2, inWin)], [tileFace(10, 0.08, half, () => 0.2)]), delit: false });
        expect(r2.glass[atlas.width * 45 + 45]).toBeGreaterThan(0);
        expect(r2.glass[atlas.width * 45 + 55]).toBe(0);
    });

    it('leaving a pano out removes its masks from the vote (the leave-one-pano-out reading)', () => {
        const planes = photoPlanes(atlas, inWin);
        const ev = evidence([viewMask(views[0], 0, inWin), viewMask(views[1], 1, inWin), viewMask(views[2], 2, () => false)]);
        expect(readFacadeMaterials({ atlas, planes, views, evidence: ev, delit: false }).record.totals.accepted).toBe(1);
        // without pano B one of two remaining marks it: not enough
        expect(readFacadeMaterials({ atlas, planes, views, evidence: ev, delit: false, excludePano: 'panoB' }).record.totals.accepted).toBe(0);
    });
});

describe('facade material reading: masonry coursing', () => {
    const pitch = 0.0677, joint = 0.012;
    // brick faces 150, mortar 215 (lighter joints), one course every `pitch` from y = 0.02
    const brick = (x: number, y: number) => { const f = (((y - 0.02) / pitch) % 1 + 1) % 1; const d = Math.min(f, 1 - f) * pitch; return d < joint / 2 ? 90 : 150 + 10 * Math.sin(x * 3.1); };

    it('reads the pitch and joint width two panos agree on', () => {
        const atlas = wallAtlas(4, 0.05);
        const views = [view('p1', [1.6, 2, 7], 1700, 1000, 1000, brick), view('p2', [2.4, 2, 7.5], 1700, 1000, 1000, brick)];
        const r = readFacadeMaterials({ atlas, planes: photoPlanes(atlas, () => false), views, evidence: evidence([viewMask(views[0], 0, () => false), viewMask(views[1], 1, () => false)]), delit: false });
        expect(r.record.courses.length).toBe(1);
        const c = r.record.courses[0];
        expect(Math.abs(c.pitchM - pitch) / pitch).toBeLessThan(0.03);
        expect(c.jointWidthM).toBeGreaterThan(0.005);
        expect(c.jointWidthM).toBeLessThan(0.025);
        expect(c.decidedBy).toBe('street-view');
        expect(c.panos.length).toBe(2);
        // the phase: a joint centre lies on the drawn joints (y = 0.02 + k * pitch)
        const off = (((c.phaseM - 0.02) / pitch) % 1 + 1) % 1;
        expect(Math.min(off, 1 - off) * pitch).toBeLessThan(0.008);
        const wall = r.record.regions.find(x => x.label === 'wall')!;
        expect(wall.fields.coursePitchM).toBeCloseTo(c.pitchM, 4);
        expect(r.record.totals.courseTexels).toBeGreaterThan(0.9 * atlas.width * atlas.height);
        // albedo untouched
        expect(r.record.totals.glassTexels).toBe(0);
    });

    it('a view too coarse to resolve the courses does not read them; one pano alone does not decide', () => {
        const atlas = wallAtlas(4, 0.05);
        const coarse = [view('p1', [2, 2, 12], 300, 400, 400, brick), view('p2', [2.2, 2, 14], 300, 400, 400, brick)];
        const r = readFacadeMaterials({ atlas, planes: photoPlanes(atlas, () => false), views: coarse, evidence: evidence([viewMask(coarse[0], 0, () => false), viewMask(coarse[1], 1, () => false)]), delit: false });
        expect(r.record.courses.length).toBe(0);
        expect(r.record.coursesRejected.length).toBe(1);
        const fine = [view('p1', [2, 2, 7], 1700, 1000, 1000, brick)];
        const r1 = readFacadeMaterials({ atlas, planes: photoPlanes(atlas, () => false), views: fine, evidence: evidence([viewMask(fine[0], 0, () => false)]), delit: false });
        expect(r1.record.courses.length).toBe(0);
    });

    it('a dark band too wide to be a joint (a moulding, a shadow line) is not drawn as coursing', () => {
        const atlas = wallAtlas(4, 0.05);
        const bands = (x: number, y: number) => { const f = ((y / 0.3) % 1 + 1) % 1; return f < 0.4 ? 70 : 160; };
        const views = [view('p1', [1.6, 2, 7], 1700, 1000, 1000, bands), view('p2', [2.4, 2, 7.5], 1700, 1000, 1000, bands)];
        const r = readFacadeMaterials({ atlas, planes: photoPlanes(atlas, () => false), views, evidence: evidence([viewMask(views[0], 0, () => false), viewMask(views[1], 1, () => false)]), delit: false });
        expect(r.record.courses.length).toBe(0);
        expect(r.record.coursesRejected[0].reason).toMatch(/wider than a joint/);
    });

    it('readCourses finds the period of a striped profile and nothing in noise', () => {
        const bin = 0.005, n = 800;
        const sum = new Float64Array(n), cnt = new Uint32Array(n).fill(1);
        for (let i = 0; i < n; i++) sum[i] = brick(0, i * bin);
        const c = readCourses([detrendProfile(sum, cnt, bin)], bin, 0, 0.02)!;
        expect(Math.abs(c.pitchM - pitch) / pitch).toBeLessThan(0.02);
        let seed = 7;
        const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        for (let i = 0; i < n; i++) sum[i] = 150 + 40 * rnd();
        const noise = readCourses([detrendProfile(sum, cnt, bin)], bin, 0, 0.02);
        expect(!noise || noise.prominence < 12).toBe(true);
    });
});

describe('facade material evidence', () => {
    it('segments every view in crops, keeps unread crops apart from "not found", and reads the tile faces', async () => {
        const v = view('pa', [5, 5, 16], 500, 300, 300, (x, y) => 60 + 10 * x + 3 * y);
        const calls: Array<{ w: number; h: number }> = [];
        let k = 0;
        const segment = async (_png: Buffer, w: number, h: number) => {
            calls.push({ w, h });
            k++;
            if (k === 1) throw new Error('model unavailable');          // a failed call: unread
            if (k === 2) return { mask: null };                       // not found: read, no glass
            return { mask: new Uint8Array(w * h).fill(MASK_YES), model: 'm' };
        };
        const surface = { id: 's00', chart: { plane: { origin: [0, 0, 0] as V3, u: [1, 0, 0] as V3, v: [0, 1, 0] as V3, normal: [0, 0, 1] as V3, extentUv: [[0, 0], [4, 0], [4, 4], [0, 4]] as Array<[number, number]> } } };
        const tile = { sample: (P: V3) => (P[0] > 3 ? undefined : { rgb: [100, 100, 100] as V3, distanceM: 0, cosNormal: 1 }) };
        const ev = await gatherMaterialEvidence({ views: [v], surfaces: [surface], tile, segment });
        expect(ev.views.length).toBe(1);
        const m = ev.views[0].mask;
        const counts = { yes: 0, no: 0, unread: 0 };
        for (const x of m) { if (x === MASK_YES) counts.yes++; else if (x === MASK_NO) counts.no++; else if (x === MASK_UNREAD) counts.unread++; }
        expect(counts.unread).toBeGreaterThan(0);
        expect(counts.no).toBeGreaterThan(0);
        expect(counts.yes).toBeGreaterThan(0);
        expect(ev.failedCalls).toBe(1);
        expect(ev.surfaces.length).toBe(1);
        const f = ev.surfaces[0];
        expect(f.width).toBe(50);
        // where the tile has no surface (x > 3 m) the raster is unread
        expect(f.mask[10 * f.width + 45]).toBe(MASK_UNREAD);
        expect(Number.isNaN(f.luminance[10 * f.width + 45])).toBe(true);
    });
});

describe('the PBR kernel\'s structured coursing', () => {
    it('draws joints at the given pitch and width (native C++20, compiled ephemerally)', async () => {
        const p = await bakeCourseProfile(0.0677, 0.012, 0.006, 64);
        const h = Array.from(p.heights);
        // recessed only within half a joint width of the centre (rows 0 and 63 straddle it), flat elsewhere
        const recessedRows = h.filter(v => v < -1e-6).length;
        expect(recessedRows / 64).toBeGreaterThan(0.012 / 0.0677 * 0.6);
        expect(recessedRows / 64).toBeLessThan(0.012 / 0.0677 * 1.4);
        expect(Math.min(...h)).toBeLessThan(-0.004);
        expect(h[32]).toBeCloseTo(0, 9);
        // normals: the groove's upper wall faces down (row 0 is just above the centre), the lower faces up
        expect(p.normals[0 * 3 + 1]).toBeLessThan(-0.3);
        expect(p.normals[63 * 3 + 1]).toBeGreaterThan(0.3);
        expect(p.normals[32 * 3 + 2]).toBeCloseTo(1, 5);
        // a visual record of the profile (screenshot per AGENTS.md)
        const dir = path.join(process.cwd(), 'test-results', 'screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const img = new Uint8Array(64 * 64 * 3);
        for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const n = [p.normals[y * 3], p.normals[y * 3 + 1], p.normals[y * 3 + 2]]; for (let c = 0; c < 3; c++) img[(y * 64 + x) * 3 + c] = Math.round((n[c] * 0.5 + 0.5) * 255); }
        fs.writeFileSync(path.join(dir, 'facade_materials_course_profile.png'), encodePng(64, 64, img, 3));
    }, 300_000);
});

describe('the textured twin carries the reading', () => {
    it('writes metalness with the roughness, the parameters, the photo fallback and the coursing profiles, with their extras', async () => {
        const { writeStagedGlb, writeTexturedTwinGlb, MATERIAL_PARAMS_CHANNELS } = await import('../src/node/3d-engine/staged-location/staged-glb-writer');
        const { buildUvAtlas } = await import('../src/node/3d-engine/staged-location/texture-uv');
        const { parseGlb } = await import('./helpers/clay-glb-render');
        const { decodePng } = await import('./helpers/png-decode');
        const clay = writeStagedGlb([{ name: 'wall', positions: new Float32Array([0, 0, 0, 4, 0, 0, 4, 4, 0, 0, 0, 0, 4, 4, 0, 0, 4, 0]) }]);
        const atlas = await buildUvAtlas({ layerKey: 'l2', clayGlb: clay, densityTexelsPerMeter: 8, maxSide: 256, islandNormalToleranceDeg: 30, surfaces: [] });
        const N = atlas.width * atlas.height;
        const planes = photoPlanes(atlas, () => false);
        const params = new Uint8Array(N * 4), rough = new Uint8Array(N).fill(217), metal = new Uint8Array(N);
        for (let i = 0; i < N; i++) { params[i * 4 + 3] = 255; if (i % 5 === 0) { params[i * 4] = 200; rough[i] = 13; metal[i] = 9; } }
        const profile = await bakeCourseProfile(0.0677, 0.012, 0.006, 32);
        const { courseProfilesImage } = await import('../src/node/3d-engine/staged-location/masonry-relief-native');
        const img = courseProfilesImage([profile]);
        const { glb } = writeTexturedTwinGlb({
            clayGlb: clay, atlas, planes, roughness: rough, metalness: metal,
            material: { params, photoAlbedo: planes.albedo, courses: { image: img, readings: [{ pitchM: 0.0677, phaseM: 0.02, jointWidthM: 0.012, jointDepthM: 0.006 }] }, provenanceIndices: [0] }
        });
        const { json, bin } = parseGlb(glb);
        const mat = json.materials[json.materials.length - 1];
        expect(mat.pbrMetallicRoughness.metallicFactor).toBe(1);
        const ex = mat.extras.sbMaterial;
        expect(ex.paramsChannels).toBe(MATERIAL_PARAMS_CHANNELS);
        expect(ex.courses[0].pitchM).toBe(0.0677);
        expect(ex.provenanceIndices).toEqual([0]);
        const imageOf = (tex: number) => { const im = json.images[json.textures[tex].source]; const v = json.bufferViews[im.bufferView]; return decodePng(bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)); };
        const mr = imageOf(mat.pbrMetallicRoughness.metallicRoughnessTexture.index);
        const byIdx = (d: ReturnType<typeof decodePng>, i: number, c: number) => d.pixels[i * d.channels + c];
        // texel 0 was read as glass: roughness 13 in G, metalness 9 in B
        expect(byIdx(mr, 0, 1)).toBe(13);
        expect(byIdx(mr, 0, 2)).toBe(9);
        const pr = imageOf(ex.paramsTexture);
        expect(byIdx(pr, 0, 0)).toBe(200);
        const ct = imageOf(ex.courseTexture);
        expect(ct.height).toBe(32);
        expect(imageOf(ex.photoFallbackTexture).width).toBe(atlas.width);
    }, 300_000);
});
