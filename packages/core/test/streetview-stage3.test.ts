/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Stage 3 wiring (registrar plates -> fusion) and the independent Stage 3 gate metrics:
 * poseQuality calibration against the gates, plate camera round trip, depth re-render for another
 * base mesh, the plate depth-edge guard, sample coverage from confidence maps, CIEDE2000, GLB image
 * identity and material audits. The real-data case uses the local (gitignored) ESB Street View cache
 * and is skipped when it is absent.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    poseQuality, PLAN_GATES, TEXTURING_GATES, evaluateFrameGates, frameCamera, frameCameraToPose, projectToFrame, streetViewIntrinsics, plateRecordCamera,
    loadStreetViewPlates, readGlbScene, sceneToRenderMesh, ZERO_CORRECTION, type RegistrationGates, type GateInput
} from '../src/node/spatial/StreetViewPoseRegistrar';
import { guardPlateDepthEdges } from '../src/node/spatial/StreetViewTextureFusion';
import {
    ciede2000, confidenceCoverageAtSamples, compareBaseColorImages, auditMaterials, exactDistanceTransform, maskedNcc, laplacianVariance
} from '../src/node/spatial/StreetViewStage3Metrics';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { encodePng } from '../src/node/texture-processing';

const REPO = path.resolve(__dirname, '../../..');
const SHOTS = path.join(REPO, 'test-results/screenshots');
const PLATES = path.join(REPO, '.scratchbox/streetview_cache/esb/plates/plates.json');
/** Mesh the local plates were registered on (from plates.json), when both exist; the real-data case is skipped otherwise. */
const REGISTERED_ON: string | null = (() => {
    if (!fs.existsSync(PLATES)) return null;
    const p = path.resolve(path.dirname(PLATES), JSON.parse(fs.readFileSync(PLATES, 'utf8')).glbPath);
    return fs.existsSync(p) ? p : null;
})();

const gateInput = (sil: number | null, crease: number | null, iou: number | null, ncc: number | null): GateInput => ({
    final: { silhouetteMedianPx: sil, creaseMedianPx: crease, skyIoU: iou, photometricNcc: ncc }, photometricPeak: null, agreement: null
});

function grey(width: number, height: number, f: (x: number, y: number) => number): Buffer {
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const v = Math.max(0, Math.min(255, Math.round(f(x, y))));
        const i = (y * width + x) * 4;
        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
    return rgba;
}

/** Two unit quads (two meshes, one primitive each), each with its own PNG baseColor image. */
function twoQuadGlb(images: Buffer[], materials: any[]): Buffer {
    const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const uv = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
    const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
    const parts: Buffer[] = [];
    let len = 0;
    const bufferViews: any[] = [];
    const add = (b: Buffer) => { const al = (len + 3) & ~3; if (al > len) parts.push(Buffer.alloc(al - len)); parts.push(b); len = al + b.length; bufferViews.push({ buffer: 0, byteOffset: al, byteLength: b.length }); return bufferViews.length - 1; };
    const vPos = add(Buffer.from(pos.buffer)), vUv = add(Buffer.from(uv.buffer)), vIdx = add(Buffer.from(idx.buffer));
    const imageViews = images.map(add);
    const json: any = {
        asset: { version: '2.0' },
        buffers: [{ byteLength: 0 }],
        bufferViews,
        accessors: [
            { bufferView: vPos, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
            { bufferView: vUv, componentType: 5126, count: 4, type: 'VEC2' },
            { bufferView: vIdx, componentType: 5123, count: 6, type: 'SCALAR' }
        ],
        images: imageViews.map(v => ({ bufferView: v, mimeType: 'image/png' })),
        textures: images.map((_, i) => ({ source: i })),
        materials,
        meshes: [0, 1].map(m => ({ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2, material: m }] })),
        nodes: [{ mesh: 0 }, { mesh: 1 }],
        scenes: [{ nodes: [0, 1] }],
        scene: 0
    };
    const bin = Buffer.concat(parts, len);
    json.buffers[0].byteLength = bin.length;
    return AlgorithmicUvEngine.serializeGlb(json, bin);
}

describe('Street View Stage 3 wiring and gate metrics', () => {
    it('poseQuality is calibrated to the gates: 1 at zero residual, 0.5 at the worst gate, 0 when interior alignment is unverified', () => {
        const g: RegistrationGates = { ...PLAN_GATES };
        expect(poseQuality(gateInput(0, 0, 1, 0.5), g)).toBeCloseTo(1, 9);
        expect(poseQuality(gateInput(2, 0, 1, 0.5), g)).toBeCloseTo(0.5, 9);           // silhouette exactly at its 2 px gate
        expect(poseQuality(gateInput(0, 3, 1, 0.5), g)).toBeCloseTo(0.5, 9);           // line exactly at its 3 px gate
        expect(poseQuality(gateInput(0, 0, 0.96, 0.5), g)).toBeCloseTo(0.5, 9);        // sky IoU exactly at its 0.96 gate
        expect(poseQuality(gateInput(1, 0, 0.98, 0.5), g)).toBeCloseTo(0.8, 9);        // r = max(0.5, 0.5)
        expect(poseQuality(gateInput(1, 0, 0.98, -0.2), g)).toBe(0);                   // anti-correlated render
        expect(poseQuality(gateInput(1, 0, 0.98, 0.05), g)).toBeCloseTo(0.8, 9);       // a weak positive NCC is not a penalty
        expect(poseQuality(gateInput(null, null, null, null), g)).toBe(0);             // no evidence at all
        // Line gate off and no cross-view gate: a sky silhouette pins rotation only, so the frame is never projected
        expect(poseQuality(gateInput(1, 15, 0.98, 0.5), { ...g, creaseMedianPx: null })).toBe(0);
        expect(poseQuality(gateInput(1, null, 0.98, 0.5), g)).toBe(0);                 // line gate on but nothing measured
        // Cross-view gate (texturing gates): the residual counts, too few matches means unverified
        const t: RegistrationGates = { ...TEXTURING_GATES };
        const cv = (medianPx: number, matches = 40) => ({ ...gateInput(0, 15, 1, 0.5), crossView: { matches, medianPx, p75Px: medianPx * 1.5, partnerPanos: 2 } });
        expect(poseQuality(cv(0), t)).toBeCloseTo(1, 9);
        expect(poseQuality(cv(2), t)).toBeCloseTo(0.5, 9);                              // at the 2 px cross-view gate
        expect(poseQuality(cv(1), t)).toBeCloseTo(0.8, 9);
        expect(poseQuality(cv(1, 5), t)).toBe(0);                                       // 5 < 15 matches
        expect(poseQuality({ ...cv(1), final: { ...cv(1).final, photometricNcc: -0.3 } }, t)).toBeCloseTo(0.8, 9); // no NCC veto once cross-view certified
        expect(poseQuality(gateInput(0, 0, 1, 0.5), t)).toBe(0);                        // no cross-view statistic
    });

    it('evaluateFrameGates: the cross-view gate rejects unverified and inconsistent frames', () => {
        const t: RegistrationGates = { ...TEXTURING_GATES };
        const base = { ...gateInput(1, 15, 0.98, 0.3), photometricPeak: -0.01 };
        expect(evaluateFrameGates({ ...base, crossView: { matches: 40, medianPx: 1.2, p75Px: 2, partnerPanos: 2 } }, [], t)).toEqual([]);
        expect(evaluateFrameGates({ ...base, crossView: null }, [], t).join(' ')).toMatch(/unverified/);
        expect(evaluateFrameGates({ ...base, crossView: { matches: 40, medianPx: 2.6, p75Px: 3, partnerPanos: 1 } }, [], t).join(' ')).toMatch(/cross-view median 2.60/);
        expect(evaluateFrameGates({ ...base, crossView: { matches: 40, medianPx: 1.5, p75Px: 4.2, partnerPanos: 1 } }, [], t).join(' ')).toMatch(/p75 4.20/);
        // the plan gates are unchanged by the new fields
        expect(evaluateFrameGates({ ...base, crossView: null }, [], { ...PLAN_GATES }).join(' ')).toMatch(/line \(crease\/contour\) median 15.00/);
    });

    it('plateRecordCamera reproduces the registered frame camera (roll included)', () => {
        const corr = { dx: 0.7, dy: -0.2, dz: 1.3, dyawDeg: 1.1, dpitchDeg: -0.6, drollDeg: 1.2 };
        const cam = frameCamera([10, 14, -30], 37, 22, 60, 640, 480, corr, 37);
        const rec = { pose: frameCameraToPose(cam), intrinsics: streetViewIntrinsics(60, 640, 480), width: 640, height: 480 };
        const back = plateRecordCamera(rec);
        let worst = 0;
        for (let k = 0; k < 200; k++) {
            const p = [10 + 40 * Math.sin(k * 1.7), 14 + 30 * Math.abs(Math.cos(k * 0.9)), -30 - 20 - 60 * Math.abs(Math.sin(k * 0.37))];
            const a = projectToFrame(cam, p), b = projectToFrame(back, p);
            if (!a || !b) { expect(!!a).toBe(!!b); continue; }
            worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1]), Math.abs(a[2] - b[2]));
        }
        expect(worst).toBeLessThan(1e-6);
    });

    it('guardPlateDepthEdges masks pixels around silhouettes and depth jumps only', () => {
        const W = 64, H = 48, d = new Float32Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            // sky (empty) above row 12, a near wall at 10 m for x < 30, a far wall at 20 m beyond, a gently sloping plane (no jump)
            d[y * W + x] = y < 12 ? 1e9 : x < 30 ? 10 + 0.01 * y : 20 + 0.01 * y;
        }
        const before = Float32Array.from(d);
        const masked = guardPlateDepthEdges(d, W, H, 2, 0.04);
        // Edge pixels: row pairs 11/12 (silhouette) and column pairs 29/30 (2x depth jump); radius 2 around them
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const nearSil = y >= 12 && y <= 12 + 2;
            const nearJump = y >= 12 && x >= 29 - 2 && x <= 30 + 2;
            const i = y * W + x;
            if (before[i] >= 1e8) expect(d[i]).toBe(before[i]);
            else if (nearSil || nearJump) expect(d[i]).toBe(1e9);
            else expect(d[i]).toBe(before[i]);
        }
        expect(masked).toBe(3 * W + (H - 15) * 6);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'streetview_stage3_depth_edge_guard.png'), encodePng(W, H, grey(W, H, (x, y) => (d[y * W + x] >= 1e8 ? 0 : 255 - 10 * d[y * W + x]))));
        expect(guardPlateDepthEdges(Float32Array.from(before), W, H, 0)).toBe(0);
        // Object-space radius: 0.5 m on the surface at focal 40 px is 2 px at 10 m and 1 px at 20 m
        const m = Float32Array.from(before);
        guardPlateDepthEdges(m, W, H, 0, 0.04, { radiusMeters: 0.5, focalPx: 40 });
        expect(m[16 * W + 10]).toBeLessThan(1e8);                    // 4 rows below the silhouette at 10 m: kept
        expect(m[14 * W + 10]).toBe(1e9);                            // 2 rows below it: masked (2 px at 10 m)
        expect(m[20 * W + 27]).toBe(1e9);                            // 2 px left of the 10 m / 20 m jump (nearer side 10 m)
        expect(m[20 * W + 25]).toBeLessThan(1e8);
        const near = Float32Array.from(before).map(v => (v < 1e8 ? v / 5 : v)); // same scene at 2 / 4 m: radius 10 px
        guardPlateDepthEdges(near, W, H, 0, 0.04, { radiusMeters: 0.5, focalPx: 40 });
        expect(near[30 * W + 22]).toBe(1e9);
        expect(near[30 * W + 18]).toBeLessThan(1e8);
        expect(near[20 * W + 5]).toBe(1e9);                          // 8 rows below the silhouette at 2 m: inside the 10 px band
    });

    it('confidenceCoverageAtSamples reads the texel under each sample through the UVs', () => {
        // One 10 x 10 m quad, UV (0,0) top-left; confidence 1 on the left half of a 4 x 4 map, 0.3 on the right
        const positions = new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0]);
        const uvs = new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]);
        const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
        const conf = new Float32Array(16).map((_, i) => ((i % 4) < 2 ? 1 : 0.3));
        const pos: number[] = [], tri: number[] = [], group: string[] = [];
        for (let k = 0; k < 400; k++) {
            const x = ((k % 20) + 0.5) / 2, y = (Math.floor(k / 20) + 0.5) / 2;
            pos.push(x, y, 0); tri.push(y > x ? 1 : 0); group.push(y < 5 ? 'low' : 'high');
        }
        const res = confidenceCoverageAtSamples(
            { count: 400, pos: Float32Array.from(pos), area: new Float32Array(400).fill(0.25), triangle: Uint32Array.from(tri), group, inGate: new Uint8Array(400).fill(1) },
            [{ positions, indices, uvs }], new Map([[0, { width: 4, height: 4, confidence: conf }]]));
        expect(res.gateAreaM2).toBeCloseTo(100, 6);
        expect(res.gateConfidentM2).toBeCloseTo(50, 6);
        expect(res.byGroup.map(g => [g.group, g.gateFraction])).toEqual([['high', 0.5], ['low', 0.5]]);
        // A primitive without a map counts as c = 0
        const none = confidenceCoverageAtSamples(
            { count: 1, pos: new Float32Array([1, 1, 0]), area: new Float32Array([1]), triangle: new Uint32Array([0]), group: ['g'], inGate: new Uint8Array([1]) },
            [{ positions, indices, uvs }], new Map());
        expect(none.gateFraction).toBe(0);
    });

    it('ciede2000 matches the Sharma et al. reference pairs', () => {
        expect(ciede2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
        expect(ciede2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(27.1492, 4);
        expect(ciede2000([60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387])).toBeCloseTo(1.2644, 4);
        expect(ciede2000([2.0776, 0.0795, -1.135], [0.9033, -0.0636, -0.5514])).toBeCloseTo(0.9082, 4);
    });

    it('image identity and material audits read only the GLB bytes', () => {
        const imgA = encodePng(8, 8, grey(8, 8, x => 30 * x)), imgB = encodePng(8, 8, grey(8, 8, (x, y) => 20 * y));
        const mats = [
            { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 }, extensions: { KHR_materials_unlit: {} } },
            { pbrMetallicRoughness: { baseColorTexture: { index: 1 }, metallicFactor: 0 }, extensions: { KHR_materials_unlit: {} } }
        ];
        const input = twoQuadGlb([imgA, imgB], mats);
        const changed = twoQuadGlb([imgA, encodePng(8, 8, grey(8, 8, () => 99))], mats);
        const same = compareBaseColorImages(input, input, []);
        expect(same.changed).toEqual([]);
        const diff = compareBaseColorImages(input, changed, [1]);
        expect(diff.changed).toEqual([1]);
        expect(diff.unexpectedChanges).toEqual([]);
        expect(compareBaseColorImages(input, changed, []).unexpectedChanges).toEqual([1]);
        expect(compareBaseColorImages(input, input, [0]).declaredButIdentical).toEqual([0]);
        expect(auditMaterials(input).metallic).toEqual([]);
        // glTF default metallicFactor is 1: a lit material without it renders metallic
        const lit = twoQuadGlb([imgA, imgB], [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, mats[1]]);
        expect(auditMaterials(lit).metallic).toEqual([{ index: 0, metallicFactor: 1, unlit: false }]);
        // an unlit material is not exempt: metallic stays metallic for any viewer that ignores KHR_materials_unlit
        const unlitMetal = twoQuadGlb([imgA, imgB], [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, extensions: { KHR_materials_unlit: {} } }, mats[1]]);
        expect(auditMaterials(unlitMetal).metallic).toEqual([{ index: 0, metallicFactor: 1, unlit: true }]);
    });

    it('screen-space metrics: exact distance transform, masked NCC, Laplacian variance', () => {
        const W = 32, H = 24, src = new Uint8Array(W * H);
        src[5 * W + 7] = 1; src[20 * W + 30] = 1;
        const dt = exactDistanceTransform(src, W, H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            expect(dt[y * W + x]).toBeCloseTo(Math.min(Math.hypot(x - 7, y - 5), Math.hypot(x - 30, y - 20)), 5);
        }
        const a = new Float32Array(W * H).map((_, i) => (i % W) * 3 + 1), mask = new Uint8Array(W * H).fill(1);
        expect(maskedNcc(a, a.map(v => 2 * v + 7), mask).ncc).toBeCloseTo(1, 9);
        expect(maskedNcc(a, a.map(v => -v), mask).ncc).toBeCloseTo(-1, 9);
        expect(laplacianVariance(a, W, H, mask).variance).toBeCloseTo(0, 9); // linear ramp has zero Laplacian
        const checker = new Float32Array(W * H).map((_, i) => (((i % W) + Math.floor(i / W)) & 1) * 10);
        expect(laplacianVariance(checker, W, H, mask).variance).toBeCloseTo(1600, 6);
    });

    it.skipIf(!REGISTERED_ON)('re-rendering plate depth from the registration mesh reproduces the stored plate depth (real ESB plates)', () => {
        const file = JSON.parse(fs.readFileSync(PLATES, 'utf8'));
        expect(file.plates.length).toBeGreaterThan(0);
        const stored = loadStreetViewPlates(PLATES);
        // the mesh the plates were registered on (raw tile or Stage 2 base), whichever it is
        const mesh = sceneToRenderMesh(readGlbScene(REGISTERED_ON!));
        const rerendered = loadStreetViewPlates(PLATES, { depthMesh: mesh });
        expect(rerendered.length).toBe(stored.length);
        for (let k = 0; k < stored.length; k++) {
            const a = stored[k].depth, b = rerendered[k].depth;
            let surface = 0, mismatch = 0;
            for (let i = 0; i < a.length; i++) {
                if (a[i] < 1e8) surface++;
                if ((a[i] < 1e8) !== (b[i] < 1e8) || (a[i] < 1e8 && Math.abs(a[i] - b[i]) > 1e-3)) mismatch++;
            }
            expect(surface).toBeGreaterThan(1000);
            // The stored pose round-trips through target = eye + 100 fwd, so a pixel centre lying exactly on a
            // triangle edge may flip; anything beyond a handful of pixels would be a real convention mismatch.
            expect(mismatch).toBeLessThanOrEqual(Math.ceil(a.length * 5e-4));
            expect(rerendered[k].poseQuality).toBe(stored[k].poseQuality);
        }
        const p = rerendered[0], W = p.width, H = p.height;
        let zmax = 0;
        for (let i = 0; i < W * H; i++) if (p.depth[i] < 1e8) zmax = Math.max(zmax, p.depth[i]);
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'streetview_stage3_rerendered_plate_depth.png'), encodePng(W, H, grey(W, H, (x, y) => (p.depth[y * W + x] >= 1e8 ? 0 : 40 + 215 * (1 - p.depth[y * W + x] / zmax)))));
        // and the camera of a stored record projects like the frame camera it came from
        const cam = plateRecordCamera(p.record);
        expect(cam.width).toBe(W);
        expect(frameCamera([0, 0, 0], 0, 0, 90, 64, 64, ZERO_CORRECTION, 0).fx).toBeCloseTo(32, 9);
    }, 120000);
});
