/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * StreetViewMaterialHarvester on a synthetic street: an ashlar facade with a known metric pattern (stack-bond blocks
 * 1.2 m x 0.5 m) photographed in perspective. Checks metric scale and aspect recovery from the mesh plane and from a
 * facade quad, robustness to a perturbed pose, axis alignment, tileability (periodic + smooth decomposition), the
 * texture-agent kernel outputs (albedo / normal / ORM, no metalness for a dielectric), tile statistics at the source
 * surface, the incidence / occlusion / resolution gates, and the segmentation cache.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    harvestStreetViewMaterials, periodicSmoothDecomposition, seamResidual, dominantPeriod, fft1, largestValidRectangle,
    rasterizePolygon, planeFromQuad, parseMaterialSegmentation, cachedGeminiSegmenter, fitPlaneRansac,
    type HarvestFrameInput, type FrameMaterialSegmentation, type MaterialLibrary
} from '../src/node/spatial/StreetViewMaterialHarvester';
import { frameCamera, ZERO_CORRECTION, type FrameCamera, type TexturedPrimitive } from '../src/node/spatial/StreetViewPoseRegistrar';
import { decodePng, encodePng } from '../src/node/texture-processing';

const SCREENSHOT_DIR = path.resolve(process.cwd(), 'test-results/screenshots');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-matharvest-'));

type V3 = [number, number, number];
const toSrgb8 = (v: number) => { const c = Math.min(1, Math.max(0, v)); return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255); };
/** Integer hash in [0, 1) (no spatial periodicity, unlike sin-based hashes). */
const hash2 = (x: number, y: number) => {
    let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
};

const BLOCK_W = 1.2, BLOCK_H = 0.5, JOINT = 0.05;
/** Ashlar facade on z = 0 (linear RGB): stack-bond blocks with dark joints and fine grain. */
function facade(x: number, y: number): V3 {
    const fx = ((x % BLOCK_W) + BLOCK_W) % BLOCK_W, fy = ((y % BLOCK_H) + BLOCK_H) % BLOCK_H;
    const joint = fx < JOINT || fy < JOINT;
    const g = 0.9 + 0.2 * hash2(Math.floor(x / 0.03), Math.floor(y / 0.03));
    const tint = 1 + 0.08 * Math.sin(Math.floor(x / BLOCK_W) * 1.7 + Math.floor(y / BLOCK_H) * 2.3);
    const k = joint ? 0.35 : g * tint;
    return [0.55 * k, 0.50 * k, 0.40 * k];
}
function ground(x: number, z: number): V3 {
    const g = 0.7 + 0.6 * hash2(Math.floor(x / 0.05), Math.floor(z / 0.05));
    return [0.06 * g, 0.06 * g, 0.065 * g];
}

const FACADE = { x0: -20, x1: 20, y0: 0, y1: 30 };
const GROUND = { x0: -60, x1: 60, z0: 0, z1: 60 };

function renderPhoto(cam: FrameCamera, ss = 3): Buffer {
    const W = cam.width, H = cam.height, rgba = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let r = 0, g = 0, b = 0;
        for (let a = 0; a < ss; a++) for (let c = 0; c < ss; c++) {
            const u = x + (a + 0.5) / ss, v = y + (c + 0.5) / ss;
            const rx = (u - cam.cx) / cam.fx, ry = -(v - cam.cy) / cam.fy;
            const d: V3 = [0, 1, 2].map(k => cam.fwd[k] + cam.right[k] * rx + cam.up[k] * ry) as V3;
            let best = Infinity, col: V3 = [0.35, 0.5, 0.8];
            if (d[2] < 0) {
                const t = -cam.eye[2] / d[2], px = cam.eye[0] + t * d[0], py = cam.eye[1] + t * d[1];
                if (t > 0 && px >= FACADE.x0 && px <= FACADE.x1 && py >= FACADE.y0 && py <= FACADE.y1) { best = t; col = facade(px, py); }
            }
            if (d[1] < 0) {
                const t = -cam.eye[1] / d[1], px = cam.eye[0] + t * d[0], pz = cam.eye[2] + t * d[2];
                if (t > 0 && t < best && px >= GROUND.x0 && px <= GROUND.x1 && pz >= GROUND.z0 && pz <= GROUND.z1) { best = t; col = ground(px, pz); }
            }
            r += col[0]; g += col[1]; b += col[2];
        }
        const k = (y * W + x) * 4, n = ss * ss;
        rgba[k] = toSrgb8(r / n); rgba[k + 1] = toSrgb8(g / n); rgba[k + 2] = toSrgb8(b / n); rgba[k + 3] = 255;
    }
    return rgba;
}

/** Tile texture (box-filtered pattern) for a rectangle mapped to UV [0,1]^2. */
function tileImage(W: number, H: number, fn: (s: number, t: number) => V3): { width: number; height: number; rgba: Buffer } {
    const rgba = Buffer.alloc(W * H * 4), n = 6;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        let r = 0, g = 0, b = 0;
        for (let a = 0; a < n; a++) for (let c = 0; c < n; c++) { const col = fn((i + (a + 0.5) / n) / W, (j + (c + 0.5) / n) / H); r += col[0]; g += col[1]; b += col[2]; }
        const k = (j * W + i) * 4;
        rgba[k] = toSrgb8(r / n / n); rgba[k + 1] = toSrgb8(g / n / n); rgba[k + 2] = toSrgb8(b / n / n); rgba[k + 3] = 255;
    }
    return { width: W, height: H, rgba };
}

function scenePrims(): TexturedPrimitive[] {
    const F = FACADE, G = GROUND;
    const facadePos = new Float32Array([F.x0, F.y0, 0, F.x1, F.y0, 0, F.x1, F.y1, 0, F.x0, F.y1, 0]);
    const facadeUv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    const groundPos = new Float32Array([G.x0, 0, G.z0, G.x1, 0, G.z0, G.x1, 0, G.z1, G.x0, 0, G.z1]);
    const groundUv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const fImg = tileImage(64, 48, (s, t) => facade(F.x0 + s * (F.x1 - F.x0), F.y1 - t * (F.y1 - F.y0)));
    const gImg = tileImage(96, 48, (s, t) => ground(G.x0 + s * (G.x1 - G.x0), G.z0 + t * (G.z1 - G.z0)));
    return [
        { positions: facadePos, indices: idx, uvs: facadeUv, image: null, imageSize: { width: 64, height: 48 }, materialIndex: 0, rgba: fImg },
        { positions: groundPos, indices: idx, uvs: groundUv, image: null, imageSize: { width: 96, height: 48 }, materialIndex: 1, rgba: gImg }
    ];
}

function lookAt(eye: V3, target: V3, hfov: number, size = 640): FrameCamera {
    const d = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const heading = Math.atan2(d[0], -d[2]) * 180 / Math.PI, pitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180 / Math.PI;
    return frameCamera(eye, heading, pitch, hfov, size, size, ZERO_CORRECTION, heading);
}
function project(cam: FrameCamera, p: V3): [number, number] {
    const d = [p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]];
    const z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
    return [cam.cx + cam.fx * (d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2]) / z, cam.cy - cam.fy * (d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2]) / z];
}

/** Segmentation the way Gemini would return it for these synthetic frames (projected world rectangles). */
function segmentationFor(cam: FrameCamera, extra: Partial<FrameMaterialSegmentation> = {}): FrameMaterialSegmentation {
    const facadePoly = ([[-6, 12], [4, 12], [4, 3], [-6, 3]] as Array<[number, number]>).map(([x, y]) => project(cam, [x, y, 0]));
    const quad = ([[-10, 14], [8, 14], [8, 2], [-10, 2]] as Array<[number, number]>).map(([x, y]) => project(cam, [x, y, 0]));
    const groundPoly = ([[-10, 6], [-2, 6], [-2, 10], [-10, 10]] as Array<[number, number]>).map(([x, z]) => project(cam, [x, 0, z]));
    return {
        model: 'fake', promptVersion: 1, width: cam.width, height: cam.height,
        materials: [
            { label: 'buff limestone ashlar, stack bond', description: 'dressed stone blocks with recessed joints', surfaceTiltDeg: 90, metalness: 0, roughness: 0.8 },
            { label: 'dark asphalt', description: 'road surface', surfaceTiltDeg: 0, metalness: 0, roughness: 0.9 }
        ],
        samples: [
            { materialIndex: 0, polygon: facadePoly, facadeIndex: 0, occludedFraction: 0, evenlyLit: true },
            { materialIndex: 1, polygon: groundPoly, facadeIndex: null, occludedFraction: 0, evenlyLit: true }
        ],
        facades: [{ label: 'front facade', corners: quad }],
        ...extra
    };
}

function frameOf(key: string, photoCam: FrameCamera, poseCam: FrameCamera = photoCam, occluders: HarvestFrameInput['occluders'] = []): HarvestFrameInput {
    const rgba = renderPhoto(photoCam);
    return { key, image: encodePng(photoCam.width, photoCam.height, rgba), rgba, width: photoCam.width, height: photoCam.height, camera: poseCam, poseSource: 'synthetic', poseConfidence: 1, occluders };
}

function swatchLuma(file: string): { Y: Float32Array; W: number; H: number } {
    const png = decodePng(fs.readFileSync(file));
    const Y = new Float32Array(png.width * png.height);
    for (let i = 0; i < Y.length; i++) Y[i] = 0.2126 * png.rgba[i * 4] + 0.7152 * png.rgba[i * 4 + 1] + 0.0722 * png.rgba[i * 4 + 2];
    return { Y, W: png.width, H: png.height };
}

describe('StreetViewMaterialHarvester: math kernels', () => {
    it('FFT round trip and periodic + smooth decomposition remove the wrap-around seam', () => {
        const re = new Float64Array(64).map((_, i) => Math.sin(i * 0.37) + (i % 7) * 0.1), im = new Float64Array(64);
        const orig = Float64Array.from(re);
        fft1(re, im, false); fft1(re, im, true);
        for (let i = 0; i < 64; i++) expect(Math.abs(re[i] - orig[i])).toBeLessThan(1e-9);
        const W = 64, H = 32, u = new Float32Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) u[y * W + x] = 0.02 * x + 0.03 * y + 0.1 * hash2(x, y) + 0.2 * Math.sin(x * 0.9);
        const before = seamResidual(u, W, H);
        const { periodic, smooth } = periodicSmoothDecomposition(u, W, H);
        const after = seamResidual(periodic, W, H);
        expect(before).toBeGreaterThan(3);
        expect(after).toBeLessThan(1.2);
        // the smooth component is harmonic away from the border (discrete Laplacian ~ 0 inside)
        let maxLap = 0, maxU = 0;
        for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
            const i = y * W + x;
            maxLap = Math.max(maxLap, Math.abs(smooth[i - 1] + smooth[i + 1] + smooth[i - W] + smooth[i + W] - 4 * smooth[i]));
            maxU = Math.max(maxU, Math.abs(u[i]));
        }
        expect(maxLap).toBeLessThan(1e-4 * maxU);
        // and p + s reproduces u exactly
        for (let i = 0; i < W * H; i += 97) expect(periodic[i] + smooth[i]).toBeCloseTo(u[i], 5);
    });

    it('period, rectangle, polygon, RANSAC and quad-plane helpers', () => {
        const W = 96, H = 40, Y = new Float32Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) Y[y * W + x] = Math.cos(2 * Math.PI * x / 12) + 0.5 * Math.cos(2 * Math.PI * y / 8);
        expect(dominantPeriod(Y, W, H, 'x').period!).toBeCloseTo(12, 0);
        expect(dominantPeriod(Y, W, H, 'y').period!).toBeCloseTo(8, 0);
        const m = new Uint8Array(20 * 10);
        for (let y = 2; y < 9; y++) for (let x = 3; x < 17; x++) m[y * 20 + x] = 1;
        m[5 * 20 + 10] = 0;
        const r = largestValidRectangle(m, 20, 10, 4)!;
        expect(r.w * r.h).toBeGreaterThanOrEqual(42);
        for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) expect(m[y * 20 + x]).toBe(1);
        const tri = rasterizePolygon([[0, 0], [10, 0], [0, 10]], 10, 10);
        expect(tri.reduce((s, v) => s + v, 0)).toBeGreaterThan(40);
        // RANSAC: plane z = 0.1 x + 2 with 30% outliers
        const pts: number[] = [], dps: number[] = [];
        for (let i = 0; i < 400; i++) {
            const x = (i % 20) - 10, y = Math.floor(i / 20) - 10;
            const z = i % 10 < 3 ? 5 + hash2(i, 1) * 10 : 0.1 * x + 2 + 0.01 * (hash2(i, 2) - 0.5);
            pts.push(x, y, z); dps.push(20);
        }
        const fit = fitPlaneRansac(Float64Array.from(pts), Float64Array.from(dps))!;
        const n = fit.normal, expected = [-0.1, 0, 1].map(v => v / Math.hypot(0.1, 1));
        expect(Math.abs(n[0] * expected[0] + n[1] * expected[1] + n[2] * expected[2])).toBeGreaterThan(0.9999);
        expect(fit.inlierFraction).toBeGreaterThan(0.65);
        expect(fit.inlierFraction).toBeLessThan(0.75);
        // quad plane recovers a 18 m x 12 m rectangle from its projection
        const cam = lookAt([-15, 1.7, 30], [0, 8, 0], 40);
        const corners = ([[-10, 14], [8, 14], [8, 2], [-10, 2]] as Array<[number, number]>).map(([x, y]) => project(cam, [x, y, 0]));
        const depthAt = (u: number, v: number) => {
            const rx = (u - cam.cx) / cam.fx, ry = -(v - cam.cy) / cam.fy;
            const dz = cam.fwd[2] + cam.right[2] * rx + cam.up[2] * ry;
            return -cam.eye[2] / dz; // camera-z (ray has unit forward component)
        };
        const q = planeFromQuad(cam, corners, depthAt)!;
        expect(q.widthMeters).toBeCloseTo(18, 1);
        expect(q.heightMeters).toBeCloseTo(12, 1);
        expect(q.orthogonalityErrorDeg).toBeLessThan(0.1);
        expect(Math.abs(q.plane.normal[2])).toBeGreaterThan(0.9999);
    });

    it('parses normalised [y, x] segmentation JSON and falls back to box_2d', () => {
        const seg = parseMaterialSegmentation({
            facades: [{ label: 'f', quad: [[100, 100], [100, 900], [900, 900], [900, 100]] }, { label: 'bad', quad: [[1, 2]] }],
            materials: [{ label: ' red brick ', surface_tilt_deg: 90, metalness: 1.4, roughness: 'x', samples: [{ box_2d: [500, 250, 750, 500], facade: 0 }, { polygon: [[0, 0]] }] }, { label: '' }]
        }, 640, 480, 'm');
        expect(seg.facades).toHaveLength(1);
        expect(seg.facades[0].corners[1]).toEqual([576, 48]);
        expect(seg.materials).toHaveLength(1);
        expect(seg.materials[0].label).toBe('red brick');
        expect(seg.materials[0].metalness).toBe(1);
        expect(seg.materials[0].roughness).toBeNull();
        expect(seg.samples).toHaveLength(1);
        expect(seg.samples[0].polygon[0]).toEqual([160, 240]);
        expect(seg.samples[0].facadeIndex).toBe(0);
    });
});

describe('StreetViewMaterialHarvester: synthetic street', () => {
    const prims = scenePrims();
    const camGood = lookAt([-15, 1.7, 30], [0, 8, 0], 40);
    const camGrazing = lookAt([-60, 1.7, 12], [0, 8, 0], 40);
    let lib: MaterialLibrary;
    let libQuad: MaterialLibrary;
    let libPerturbed: MaterialLibrary;
    const segs = new Map<string, FrameMaterialSegmentation>();
    let calls = 0;
    const segmenter = async (f: HarvestFrameInput) => { calls++; return segs.get(f.key)!; };

    beforeAll(async () => {
        const occ = segmentationFor(camGood);
        const xs = occ.samples[0].polygon.map(p => p[0]), ys = occ.samples[0].polygon.map(p => p[1]);
        segs.set('good', segmentationFor(camGood));
        segs.set('grazing', segmentationFor(camGrazing));
        segs.set('occluded', segmentationFor(camGood));
        const frames = [
            frameOf('good', camGood),
            frameOf('grazing', camGrazing),
            frameOf('occluded', camGood, camGood, [{ label: 'bus', x0: Math.min(...xs), y0: Math.min(...ys) + 0.25 * (Math.max(...ys) - Math.min(...ys)), x1: Math.max(...xs), y1: Math.max(...ys) }])
        ];
        const res = await harvestStreetViewMaterials(frames, { outDir: path.join(WORK, 'lib'), segmenter, texturedPrims: prims, groundHeightAt: () => 0 });
        lib = res.library;
        // quad path only (mesh plane disabled) and a perturbed pose (2 m, 1.5 deg yaw) for the same photo
        segs.set('quad', segmentationFor(camGood));
        libQuad = (await harvestStreetViewMaterials([frameOf('quad', camGood)], { outDir: path.join(WORK, 'libq'), segmenter, texturedPrims: prims, minPlaneInlierFraction: 1.01 })).library;
        const d = [0 - camGood.eye[0], 8 - camGood.eye[1], 0 - camGood.eye[2]];
        const heading = Math.atan2(d[0], -d[2]) * 180 / Math.PI, pitch = Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180 / Math.PI;
        const camBad = frameCamera([-15 + 1.5, 1.7, 30 - 1.3], heading, pitch, 40, 640, 640, { dx: 0, dy: 0, dz: 0, dyawDeg: 1.5, dpitchDeg: 0.5, drollDeg: 0.4 }, heading);
        segs.set('perturbed', segmentationFor(camGood));
        libPerturbed = (await harvestStreetViewMaterials([{ ...frameOf('perturbed', camGood), camera: camBad }], { outDir: path.join(WORK, 'libp'), segmenter, texturedPrims: prims })).library;
    }, 170_000);

    it('harvests a metric, axis-aligned, tileable swatch from the good frame', () => {
        const s = lib.samples.find(x => x.source.frame === 'good' && x.label.includes('limestone'))!;
        expect(s).toBeTruthy();
        expect(s.plane.method).toBe('mesh-plane');
        expect(s.plane.tiltDeg).toBeGreaterThan(88);
        expect(Math.abs(s.plane.normal[2])).toBeGreaterThan(0.999);
        expect(s.geometry.incidenceCos).toBeGreaterThan(0.8);
        expect(s.quality.axisDeviationDeg ?? 0).toBeLessThan(1);
        // metric scale and aspect: block period 1.2 m along u, course 0.5 m along v
        const { Y, W, H } = swatchLuma(path.join(WORK, 'lib', s.files.photoSwatch!));
        expect(W).toBe(s.widthPx); expect(H).toBe(s.heightPx);
        const pu = dominantPeriod(Y, W, H, 'x').period!, pv = dominantPeriod(Y, W, H, 'y').period!;
        expect(Math.abs(pu * s.metresPerPixel.u - BLOCK_W) / BLOCK_W).toBeLessThan(0.03);
        expect(Math.abs(pv * s.metresPerPixel.v - BLOCK_H) / BLOCK_H).toBeLessThan(0.03);
        // swatch resolution near the photo footprint (no gross over/under sampling)
        expect(Math.max(s.metresPerPixel.u, s.metresPerPixel.v)).toBeLessThan(1.6 * s.geometry.photoFootprintMeters.coarse);
        expect(s.sizeMeters.u).toBeGreaterThan(5);
        // tileable: wrap-around seam no larger than an interior step
        expect(s.quality.seamResidualAfter).toBeLessThan(1.2);
        // tile statistics at the source surface (tile texel 40 m / 64 px)
        expect(s.tile!.texelMeters!).toBeCloseTo(0.625, 2);
        expect(s.tile!.resolutionGain!).toBeGreaterThan(8);
        expect(s.geometry.heightAboveGround!.p50).toBeGreaterThan(4);
        expect(s.geometry.heightAboveGround!.p50).toBeLessThan(11);
        // photo and tile share radiometry here: the photo-to-tile gain is ~1 and the tile-domain colour matches the tile
        for (const g of s.tileDomain!.gain) { expect(g).toBeGreaterThan(0.85); expect(g).toBeLessThan(1.15); }
        expect(Math.abs(s.tileDomain!.lab.mean[0] - s.tile!.lab.mean[0])).toBeLessThan(4);
        expect(s.quality.clippedFraction).toBe(0);
    });

    it('runs the texture agent kernel into tileable PBR maps (dielectric: no metalness)', () => {
        const s = lib.samples.find(x => x.source.frame === 'good' && x.label.includes('limestone'))!;
        for (const f of [s.files.albedo, s.files.normal, s.files.orm]) {
            const png = decodePng(fs.readFileSync(path.join(WORK, 'lib', f)));
            expect(png.width).toBe(s.widthPx); expect(png.height).toBe(s.heightPx);
        }
        const orm = decodePng(fs.readFileSync(path.join(WORK, 'lib', s.files.orm)));
        let metal = 0, rough = 0;
        for (let i = 0; i < orm.width * orm.height; i++) { metal += orm.rgba[i * 4 + 2]; rough += orm.rgba[i * 4 + 1]; }
        expect(metal / (orm.width * orm.height)).toBeLessThan(3);
        expect(rough / (orm.width * orm.height) / 255).toBeGreaterThan(0.5);
        const nrm = decodePng(fs.readFileSync(path.join(WORK, 'lib', s.files.normal)));
        let nz = 0;
        for (let i = 0; i < nrm.width * nrm.height; i++) nz += nrm.rgba[i * 4 + 2];
        expect(nz / (nrm.width * nrm.height)).toBeGreaterThan(200); // tangent-space normals point out of the surface
        // the albedo tiles: its wrap-around seam is no stronger than its interior
        const { Y, W, H } = swatchLuma(path.join(WORK, 'lib', s.files.albedo));
        expect(seamResidual(Y, W, H)).toBeLessThan(1.3);
        expect(['native-cpp20', 'node-v8']).toContain(s.kernel.acceleration);
        // visual record: photo swatch | albedo | normal | 2x2 tiling of the albedo
        const tiles = [s.files.photoSwatch!, s.files.albedo, s.files.normal].map(f => decodePng(fs.readFileSync(path.join(WORK, 'lib', f))));
        const T = tiles[1];
        const SW = W * 3 + 2 * W + 24, SH = Math.max(H, 2 * H);
        const sheet = Buffer.alloc(SW * SH * 4, 255);
        tiles.forEach((im, k) => { for (let y = 0; y < im.height; y++) im.rgba.copy(sheet, (y * SW + k * (W + 8)) * 4, y * im.width * 4, (y + 1) * im.width * 4); });
        for (let y = 0; y < 2 * H; y++) for (let x = 0; x < 2 * W; x++) {
            const sx = x % W, sy = y % H;
            T.rgba.copy(sheet, (y * SW + 3 * (W + 8) + x) * 4, (sy * W + sx) * 4, (sy * W + sx) * 4 + 4);
        }
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        fs.writeFileSync(path.join(SCREENSHOT_DIR, 'streetview_material_harvest_synthetic_swatch.png'), encodePng(SW, SH, sheet));
    });

    it('gates grazing views, occluded patches and grazing ground samples', () => {
        expect(lib.samples.some(s => s.source.frame === 'grazing')).toBe(false);
        expect(lib.rejected.some(r => r.frame === 'grazing' && /incidence/.test(r.reason))).toBe(true);
        expect(lib.samples.some(s => s.source.frame === 'occluded')).toBe(false);
        expect(lib.rejected.some(r => r.frame === 'occluded' && /occluded/.test(r.reason))).toBe(true);
        expect(lib.samples.some(s => s.label.includes('asphalt'))).toBe(false); // ground seen at ~6 deg
        const libJson = JSON.parse(fs.readFileSync(path.join(WORK, 'lib', 'library.json'), 'utf8'));
        expect(libJson.samples).toHaveLength(lib.samples.length);
    });

    it('recovers scale from the facade quad alone and survives a perturbed pose', () => {
        for (const [L, method] of [[libQuad, 'facade-quad'], [libPerturbed, null]] as Array<[MaterialLibrary, string | null]>) {
            const s = L.samples.find(x => x.label.includes('limestone'))!;
            expect(s).toBeTruthy();
            if (method) expect(s.plane.method).toBe(method);
            const dir = L === libQuad ? 'libq' : 'libp';
            const { Y, W, H } = swatchLuma(path.join(WORK, dir, s.files.photoSwatch!));
            const pu = dominantPeriod(Y, W, H, 'x').period!, pv = dominantPeriod(Y, W, H, 'y').period!;
            // scale error stays at the few-percent level (depth / pose error), aspect is preserved
            expect(Math.abs(pu * s.metresPerPixel.u - BLOCK_W) / BLOCK_W).toBeLessThan(0.07);
            expect(Math.abs(pv * s.metresPerPixel.v - BLOCK_H) / BLOCK_H).toBeLessThan(0.07);
            expect(Math.abs((pu * s.metresPerPixel.u) / (pv * s.metresPerPixel.v) - BLOCK_W / BLOCK_H) / (BLOCK_W / BLOCK_H)).toBeLessThan(0.04);
            expect(s.quality.axisDeviationDeg ?? 0).toBeLessThan(2);
        }
    });

    it('caches segmentations by prompt version and never calls the network without a client', async () => {
        const dir = path.join(WORK, 'segcache');
        fs.mkdirSync(dir, { recursive: true });
        const frame = frameOf('cached', camGood);
        await expect(cachedGeminiSegmenter(null, dir)(frame)).rejects.toThrow(/no cached segmentation/);
        let requests = 0;
        const client = { models: { generateContent: async () => { requests++; return { text: JSON.stringify({ facades: [], materials: [{ label: 'stone', samples: [{ box_2d: [100, 100, 500, 500], facade: -1 }] }] }) }; } } };
        const seg1 = await cachedGeminiSegmenter(client, dir)(frame);
        const seg2 = await cachedGeminiSegmenter(client, dir)(frame);
        expect(requests).toBe(1);
        expect(seg2).toEqual(seg1);
        expect(seg1.samples).toHaveLength(1);
        expect(calls).toBeGreaterThan(0);
    });
});
