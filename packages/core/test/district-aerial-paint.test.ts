/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The district's aerial paint (district-aerial-paint.ts) on a synthetic massing: one 20 x 20 x 30 m block whose atlas
 * holds a blurred copy of a window grid on two walls and the roof (photo texels), a flat median on the south wall and
 * half the east wall (fill texels), and a repeat fill on the west wall; the tile scan is the same block with the crisp
 * grid everywhere, standing on a paved street. A stand-in image model that answers with the evidence it is shown (image 2) paints the fill texels
 * with the grid, keeps the photo texels' low band and sharpens them, and labels every texel it wrote with the paint's
 * own provenance; one that answers a few pixels off is warped back and paints the same, and one that reframed the view
 * (zoomed 25%) is rejected and changes nothing. The sweep's cameras stand clear of the block on four headings; a face is
 * written by at most K views.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProvenanceRecord } from '../src/common/spatial/staged-location-contracts';
import { writeMassingTexturedGlb, type FaceTexture, type TexelSource } from '../src/node/3d-engine/staged-location/pipeline-e/massing-glb';
import type { MassingFace, MassingNode } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import {
    aerialCamera, aerialSweep, DISTRICT_PAINT_PARAMS, heightGrid, loadPaintTarget, paintDistrictAerial, rankViews, sameFaceLowPass, texelClassOf, TEXEL, writesFace,
    type PaintModelClient
} from '../src/node/3d-engine/staged-location/district-aerial-paint';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { encodePng } from '../src/node/texture-processing';

const PIXEL = 0.25;
type V3 = [number, number, number];

/** The legend pipeline E's plain textures use (face-textures.ts baseLegend): 0 photo, 1 nearest fill, 2 facade median, 3 repeat. */
const LEGEND: TexelSource[] = [
    { source: 'tile-ortho', label: 'as-scanned', method: 'test', rung: 2, weight: 0.5 },
    { source: 'nearest-observed', label: 'filled', method: 'test', rung: 4, weight: 0.15 },
    { source: 'facade-median', label: 'filled', method: 'test', rung: 4, weight: 0.05 },
    { source: 'texture-repeat-inference', label: 'inferred-repeat', method: 'test', rung: 3, weight: 0.3 }
];

interface FaceSpec { name: string; origin: V3; axisS: V3; axisT: V3; normal: V3; L: number; H: number; base: [number, number, number]; source: (s: number, t: number) => number }

const FACES: FaceSpec[] = [
    { name: 'north', origin: [10, 0, -10], axisS: [-1, 0, 0], axisT: [0, 1, 0], normal: [0, 0, -1], L: 20, H: 30, base: [182, 150, 118], source: () => 0 },
    { name: 'east', origin: [10, 0, 10], axisS: [0, 0, -1], axisT: [0, 1, 0], normal: [1, 0, 0], L: 20, H: 30, base: [176, 146, 120], source: s => (s < 10 ? 0 : 2) },
    { name: 'south', origin: [-10, 0, 10], axisS: [1, 0, 0], axisT: [0, 1, 0], normal: [0, 0, 1], L: 20, H: 30, base: [180, 152, 116], source: () => 2 },
    { name: 'west', origin: [-10, 0, -10], axisS: [0, 0, 1], axisT: [0, 1, 0], normal: [-1, 0, 0], L: 20, H: 30, base: [178, 148, 122], source: () => 3 },
    { name: 'roof', origin: [-10, 30, 10], axisS: [1, 0, 0], axisT: [0, 0, -1], normal: [0, 1, 0], L: 20, H: 20, base: [120, 124, 128], source: () => 0 }
];

/** The crisp window grid (walls) or roof tiles at face coordinates (s, t). */
function pattern(f: FaceSpec, s: number, t: number): [number, number, number] {
    const window = f.normal[1] === 0 ? (s % 3 > 0.8 && s % 3 < 2.2 && t % 3.5 > 1 && t % 3.5 < 2.6) : ((Math.floor(s / 2) + Math.floor(t / 2)) % 2 === 0);
    return window ? [58, 68, 84] : f.base;
}

function faceRecord(f: FaceSpec, index: number): MassingFace {
    const W = Math.round(f.L / PIXEL), H = Math.round(f.H / PIXEL);
    return {
        index, key: `f:${f.name}`, kind: f.normal[1] ? 'roof' : 'wall', part: 'p', loop: 0, edge: index, wall: !f.normal[1],
        normal: f.normal, axisS: f.axisS, axisT: f.axisT, origin: f.origin, sMin: 0, sMax: f.L, tMin: 0, tMax: f.H, tBottom: 0, area: f.L * f.H,
        pixel: PIXEL, orthoSMin: 0, orthoTMax: f.H, width: W, height: H, coverage: 1, openings: [], top: []
    };
}

function faceNode(f: FaceSpec, index: number): MassingNode {
    const at = (s: number, t: number) => f.origin.map((o, k) => o + f.axisS[k] * s + f.axisT[k] * t);
    const corners: Array<[number, number]> = [[0, 0], [f.L, 0], [f.L, f.H], [0, f.H]];
    return {
        name: `f:${f.name}`, kind: f.normal[1] ? 'roof' : 'wall', provenance: 'vector-massing', confidence: null,
        positions: new Float32Array(corners.flatMap(([s, t]) => at(s, t))), normals: new Float32Array(corners.flatMap(() => f.normal)),
        ref: new Int32Array([index, index, index, index]), st: new Float32Array(corners.flat()), indices: new Uint32Array([0, 1, 2, 0, 2, 3])
    };
}

/** One face's texture: the crisp grid (evidence), or the massing's own: blurred where photo, flat where fill. */
function faceTexture(f: FaceSpec, evidence: boolean): FaceTexture {
    const W = Math.round(f.L / PIXEL), H = Math.round(f.H / PIXEL);
    const tex: FaceTexture = { width: W, height: H, rgba: new Uint8Array(W * H * 4), source: new Uint8Array(W * H) };
    const st = (x: number, y: number): [number, number] => [(x + 0.5) * PIXEL, f.H - (y + 0.5) * PIXEL];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const [s, t] = st(x, y), i = y * W + x;
        const src = evidence ? 0 : f.source(s, t);
        tex.source[i] = src;
        let c: number[];
        if (src === 0) {
            // the photo: the grid, blurred over 3 texels unless it is the evidence
            const r = evidence ? 0 : 1, acc = [0, 0, 0];
            let n = 0;
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const p = pattern(f, ...st(x + dx, y + dy)); acc[0] += p[0]; acc[1] += p[1]; acc[2] += p[2]; n++; }
            c = acc.map(v => v / n);
        } else if (src === 3) c = pattern(f, s, t).map(v => v * 0.92 + 8);
        else c = [160, 140, 120];
        tex.rgba.set([...c.map(Math.round), 255], i * 4);
    }
    return tex;
}

/** The street around the block, in the scan only (the massing layer has no ground): paving in 2 m squares. */
const GROUND: FaceSpec = { name: 'ground', origin: [-50, 0, 50], axisS: [1, 0, 0], axisT: [0, 0, -1], normal: [0, 1, 0], L: 100, H: 100, base: [96, 96, 92], source: () => 0 };

function writeBlock(file: string, evidence: boolean): void {
    const specs = evidence ? [...FACES, GROUND] : FACES;
    const faces = specs.map(faceRecord), nodes = specs.map(faceNode);
    const provenanceOf = (): ProvenanceRecord => ({ label: 'vector-massing', measuredGeometry: true, method: 'test', sources: [] });
    const out = writeMassingTexturedGlb({
        nodes, faces, stage: 'massing', stageKey: 'test', provenanceOf, textures: new Map(specs.map((f, k) => [k, faceTexture(f, evidence)])),
        legend: LEGEND, tileImages: new Map(), tileLegendIndex: 0, materials: false
    });
    fs.writeFileSync(file, out.glb);
}

/** The fixture's frame is a fifth of the real one: the registration blocks and search scale with it (96 / 24 px at 1344). */
const SMALL = { width: 256, height: 144, scoreSamples: 64, minScorePx: 150, registration: { ...DISTRICT_PAINT_PARAMS.registration, blockPx: 24, searchPx: 8 } };

/**
 * Answers with the evidence it was shown (image 2): as it is, shifted right by `shiftPx` (as the real model returns its
 * picture a few pixels off), or zoomed in by `zoom` about its centre (the view reframed).
 */
function evidenceClient(shiftPx = 0, zoom = 1): PaintModelClient & { calls: number } {
    const fn = (async request => {
        fn.calls++;
        if (!shiftPx && zoom === 1) return { bytes: request.reference.bytes, mimeType: 'image/png', modelUsed: 'evidence-stand-in' };
        const d = decodeImageInMemory(request.reference.bytes), out = new Uint8Array(d.rgba.length);
        for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
            const sx = Math.min(d.width - 1, Math.max(0, Math.round(d.width / 2 + (x - d.width / 2) / zoom) - shiftPx));
            const sy = Math.min(d.height - 1, Math.max(0, Math.round(d.height / 2 + (y - d.height / 2) / zoom)));
            out.set(d.rgba.subarray((sy * d.width + sx) * 4, (sy * d.width + sx) * 4 + 4), (y * d.width + x) * 4);
        }
        return { bytes: new Uint8Array(encodePng(d.width, d.height, Buffer.from(out))), mimeType: 'image/png', modelUsed: zoom !== 1 ? 'zoomed-stand-in' : 'shifted-stand-in' };
    }) as PaintModelClient & { calls: number };
    fn.calls = 0;
    return fn;
}

function fixture(): { dir: string; massing: string; evidence: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'district-paint-'));
    const massing = path.join(dir, 'massing.glb'), evidence = path.join(dir, 'evidence.glb');
    writeBlock(massing, false);
    writeBlock(evidence, true);
    return { dir, massing, evidence };
}

/** Mean and variance of one face's photo/fill texels on the page, by the page's own face map read from the target. */
function faceStats(glb: string, faceName: string, sHalf?: 'low' | 'high') {
    const target = loadPaintTarget(glb);
    const spec = FACES.find(f => f.name === faceName)!;
    const pi = target.prims.findIndex(p => p.page !== null && Math.abs(p.positions[0] - (spec.origin[0] + 0)) < 1e-3 && Math.abs(p.positions[2] - spec.origin[2]) < 1e-3 && Math.abs(p.positions[1] - spec.origin[1]) < 1e-3);
    const prim = target.prims[pi], page = target.pages[prim.page!];
    // the face's texel box on the page from its UVs
    const us = [0, 1, 2, 3].map(v => prim.uvs![v * 2] * page.width), vs = [0, 1, 2, 3].map(v => prim.uvs![v * 2 + 1] * page.height);
    const x0 = Math.ceil(Math.min(...us)), x1 = Math.floor(Math.max(...us)), y0 = Math.ceil(Math.min(...vs)), y1 = Math.floor(Math.max(...vs));
    const xm = Math.round((x0 + x1) / 2);
    let n = 0, sum = [0, 0, 0], sq = 0;
    const indices = new Map<number, number>();
    for (let y = y0 + 2; y < y1 - 2; y++) for (let x = x0 + 2; x < x1 - 2; x++) {
        if (sHalf === 'low' && x >= xm) continue;
        if (sHalf === 'high' && x < xm) continue;
        const i = y * page.width + x;
        const l = 0.2126 * page.albedo[i * 4] + 0.7152 * page.albedo[i * 4 + 1] + 0.0722 * page.albedo[i * 4 + 2];
        sum = sum.map((v, k) => v + page.albedo[i * 4 + k]); sq += l * l; n++;
        indices.set(page.conf[i * 4], (indices.get(page.conf[i * 4]) ?? 0) + 1);
    }
    const mean = sum.map(v => v / n), ml = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
    return { mean, lumaVar: sq / n - ml * ml, indices, n };
}

describe('district aerial paint', () => {
    it('classes texels by their ladder rung: photo up to the tile transfer, repeat, everything else fill', () => {
        const conf = (rung: number, a = 255) => [0, 0, rung, a];
        expect(texelClassOf(conf(2), 0)).toBe(TEXEL.photo);
        expect(texelClassOf(conf(1), 0)).toBe(TEXEL.photo);
        expect(texelClassOf(conf(3), 0)).toBe(TEXEL.repeat);
        expect(texelClassOf(conf(4), 0)).toBe(TEXEL.fill);
        expect(texelClassOf(conf(6), 0)).toBe(TEXEL.fill);
        expect(texelClassOf(conf(2, 0), 0)).toBe(TEXEL.none);
        expect(texelClassOf(conf(6, 0), 0)).toBe(TEXEL.fill);      // a face texel no source produced: black, the paint's to draw
        expect(texelClassOf(conf(0, 0), 0)).toBe(TEXEL.none);      // page the packer never used
    });

    it('projects a camera\'s look-at point to the image centre and keeps it pitched down', () => {
        const eye: V3 = [0, 100, 90];
        const cam = aerialCamera(eye, 0, 48, 40, 256, 144);
        const target: V3 = [0, 0, 90 - 100 / Math.tan(48 * Math.PI / 180)];
        const d = target.map((v, k) => v - eye[k]);
        const z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
        const x = cam.cx + cam.fx * (d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2]) / z;
        const y = cam.cy - cam.fy * (d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2]) / z;
        expect(x).toBeCloseTo(128, 6);
        expect(y).toBeCloseTo(72, 6);
        expect(cam.right[0]).toBeCloseTo(1, 9);      // heading north: east is right
    });

    it('sweeps four headings with every camera clear of the block, within the view budget', () => {
        const { massing } = fixture();
        const target = loadPaintTarget(massing);
        const views = aerialSweep({ faces: target.faces, heights: heightGrid(target.prims, 4), groundY: 0, radiusM: 25 }, { ...DISTRICT_PAINT_PARAMS, ...SMALL });
        expect(views.length).toBeGreaterThan(8);
        expect(new Set(views.map(v => Math.round(v.headingDeg) % 360)).size).toBe(4);
        for (const v of views) expect(v.eye[1]).toBeGreaterThanOrEqual(30 + 25 - 1e-6);
        const capped = aerialSweep({ faces: target.faces, heights: heightGrid(target.prims, 4), groundY: 0, radiusM: 25 }, { ...DISTRICT_PAINT_PARAMS, ...SMALL, maxViews: 8 });
        expect(capped.length).toBeLessThanOrEqual(8);
    });

    it('ranks each face\'s views and promotes the next one when a chosen view fails', () => {
        const scores = [new Float64Array([900, 10]), new Float64Array([1000, 0]), new Float64Array([200, 0]), new Float64Array([700, 400])];
        const ranked = rankViews(scores, 2, { rho: 0.25, minScorePx: 50 });
        expect(ranked[0]).toEqual([1, 0, 3]);      // 200 < 0.25 x 1000: view 2 is not eligible
        expect(ranked[1]).toEqual([3]);
        expect(writesFace(ranked[0], 3, new Set(), 0, 2)).toBe(false);
        expect(writesFace(ranked[0], 3, new Set([1]), 1, 2)).toBe(true);     // view 1 failed: view 3 steps up
        expect(writesFace(ranked[0], 0, new Set(), 2, 2)).toBe(false);       // already written by K views
    });

    it('low-passes within a face only', () => {
        const W = 6, H = 1, src = new Float32Array(W * 3), valid = new Uint8Array(W).fill(1), face = new Int32Array([0, 0, 0, 1, 1, 1]);
        for (let x = 0; x < W; x++) src.fill(x < 3 ? 10 : 200, x * 3, x * 3 + 3);
        const out = sameFaceLowPass(src, valid, face, W, H, 2);
        expect(out[2 * 3]).toBe(10);
        expect(out[3 * 3]).toBe(200);
    });

    it('paints the fill with what the evidence shows, sharpens the photo on its own low band, and labels what it wrote', async () => {
        const { dir, massing, evidence } = fixture();
        const out = path.join(dir, 'painted.glb'), client = evidenceClient();
        const report = await paintDistrictAerial({ massingGlb: massing, referenceGlb: evidence, outGlb: out, viewsDir: path.join(dir, 'views'), client, radiusM: 25, groundY: 0, params: SMALL });
        expect(report.views.accepted).toBeGreaterThan(0);
        expect(report.views.rejected).toBe(0);
        expect(client.calls).toBe(report.imagesAsked);
        expect(report.faces.written).toBe(5);
        expect(report.legend.map(l => [l.source, l.label, l.index])).toEqual([['aerial-paint-detail', 'generated', 4], ['aerial-paint', 'generated', 5]]);
        expect(report.texels.fill).toBeGreaterThan(0);
        expect(report.texels.photoDetail).toBeGreaterThan(0);

        // the south wall was one flat median: painted, it carries the window grid (dark windows pull its mean and spread its luma)
        const before = faceStats(massing, 'south'), after = faceStats(out, 'south');
        expect(before.lumaVar).toBeLessThan(1);
        expect(after.lumaVar).toBeGreaterThan(300);
        expect(after.indices.get(5) ?? 0).toBeGreaterThan(0.9 * after.n);

        // the north wall was the blurred photo: its mean colour kept (the low band is the photo's), its detail sharper
        const nb = faceStats(massing, 'north'), na = faceStats(out, 'north');
        for (let k = 0; k < 3; k++) expect(Math.abs(na.mean[k] - nb.mean[k])).toBeLessThan(4);
        expect(na.lumaVar).toBeGreaterThan(nb.lumaVar * 1.05);
        expect(na.indices.get(4) ?? 0).toBeGreaterThan(0.9 * na.n);

        // a face written by at most K views: no view wrote more faces than it was given
        for (const v of report.perView) if (v.decision === 'accepted') expect(v.texelsWritten).toBeGreaterThan(0);
        const json = JSON.parse(fs.readFileSync(path.join(dir, 'district_paint.json'), 'utf8'));
        expect(json.version).toBe('district-aerial-paint/1');
    });

    it('warps an answer the model returned a few pixels off back onto its view, and paints as the unmoved answer does', async () => {
        const { dir, massing, evidence } = fixture();
        const straight = path.join(dir, 'straight.glb'), moved = path.join(dir, 'moved.glb');
        await paintDistrictAerial({ massingGlb: massing, referenceGlb: evidence, outGlb: straight, viewsDir: path.join(dir, 'v0'), client: evidenceClient(), radiusM: 25, groundY: 0, params: SMALL });
        const report = await paintDistrictAerial({ massingGlb: massing, referenceGlb: evidence, outGlb: moved, viewsDir: path.join(dir, 'v1'), client: evidenceClient(6), radiusM: 25, groundY: 0, params: SMALL });
        const accepted = report.perView.filter(v => v.decision === 'accepted');
        expect(accepted.length).toBeGreaterThan(0);
        for (const v of accepted) {
            expect(v.metrics!.warp.shiftPx).toBeGreaterThan(4);
            expect(v.metrics!.warp.shiftPx).toBeLessThan(8);
            expect(v.metrics!.aligned!.medianShiftPx).toBeLessThanOrEqual(1);
        }
        const a = faceStats(straight, 'south'), b = faceStats(moved, 'south');
        expect(b.lumaVar).toBeGreaterThan(300);
        for (let k = 0; k < 3; k++) expect(Math.abs(a.mean[k] - b.mean[k])).toBeLessThan(6);
    });

    it('rejects an answer that reframed the view (zoomed 25%) and leaves the atlas as it was', async () => {
        const { dir, massing, evidence } = fixture();
        const out = path.join(dir, 'painted.glb');
        const report = await paintDistrictAerial({ massingGlb: massing, referenceGlb: evidence, outGlb: out, viewsDir: path.join(dir, 'views'), client: evidenceClient(0, 1.25), radiusM: 25, groundY: 0, params: SMALL });
        expect(report.views.accepted).toBe(0);
        expect(report.views.rejected).toBeGreaterThan(0);
        expect(report.perView.filter(v => v.decision === 'rejected').every(v => v.reasonCode === 'paint_not_registered')).toBe(true);
        expect(report.texels.fill + report.texels.photoDetail + report.texels.repeatReplaced).toBe(0);
        const before = faceStats(massing, 'south'), after = faceStats(out, 'south');
        expect(after.mean).toEqual(before.mean);
    });
});
