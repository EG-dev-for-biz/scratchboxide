/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View registration on the real ESB scan tile.
 *
 *  1. Raster primitives and the plates.json contract.
 *  2. Feature registration (StreetViewFeatureRegistrar): the scan rendered with its own texture at a known pose is
 *     turned into a "photo" with a polarity-folding tone curve (windows dark in the scan texture may be bright in a
 *     street photo), an unsharp mask and noise; from a 2 m / 0.8 m / 1.5 deg perturbed GPS pose the registrar must
 *     recover the pose within 0.3 m / 0.3 deg, align interior edges to <= 1 px and pass every gate.
 *  3. Feature gates and pose quality: pure functions; every gated statistic counts, unverified agreement rejects.
 *  4. Billing safety: one fixed global ledger path, no custom ledger for real requests, concurrent runs cannot
 *     overspend the cap.
 *  5. Rigid registrar synthetic recovery (method rigid).
 *  6. Real regression on cached Street View frames (local fixtures, skipped and reported when absent): the feature
 *     registration of the W 34th St frame must lower the truncated interior-edge cost and raise the orientation NCC
 *     over the GPS pose without hitting a search bound.
 *
 * Overlays (photo red / textured render cyan, GPS pose | registered pose) are written to test-results/screenshots/
 * (gitignored).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    StreetViewPoseRegistrar, extractCreaseSamples, frameCamera, renderFrameDepth, renderRegistrationOverlay, renderTexturedView,
    decodeImageToRgba, distanceTransform, segmentSky, buildValidMask, loadTexturedScene, extractTextureLineSamples, ZERO_CORRECTION,
    frameCameraToPose, streetViewIntrinsics, stationForFrame, encodeDepthF32, encodeMaskPng, loadStreetViewPlates, projectToFrame, PLATE_EMPTY_DEPTH,
    type PanoRegistrationInput, type CreaseSampleSet, type RgbaImage, type TexturedPrimitive, type StreetViewPlatesFile
} from '../src/node/spatial/StreetViewPoseRegistrar';
import {
    loadScanMesh, buildGroundModel, geodeticToScan, localStreetHeight, defaultStreetViewLedgerPath, fetchFrames, readLedger,
    type ScanMesh, type GroundModel, type CandidateFrame, type PanoRecord
} from '../src/node/spatial/StreetViewSurveyPlanner';
import {
    StreetViewFeatureRegistrar, evaluateFeatureGates, featurePoseQuality, DEFAULT_FEATURE_GATES,
    type FeatureGateInput, type FeaturePanoInput
} from '../src/node/spatial/StreetViewFeatureRegistrar';
import { encodeRgbaToJpeg, resolveFfmpegPath } from '../src/node/image-codec-ffmpeg';
import { findBinary, HOW_TO, requireAll, requireAsset, requireFile, withReason, type Requirement } from './helpers/requirements';
import * as os from 'os';
import { encodePng } from '../src/node/texture-processing';

const REPO = path.resolve(__dirname, '../../..');
const TILE = path.join(REPO, 'public/tiles/scan_studio_tile_esb_77197_98526.glb');
const SHOTS = path.join(REPO, 'test-results/screenshots');
const ANCHOR = { lat: 40.7484405, lng: -73.9856644, heightMeters: -30 };
// Street View imagery cannot be committed: the real-data fixtures live in the gitignored repo-local cache
// (.scratchbox/streetview_fixtures/esb: sv_meta.json + sv_<id>.jpg) or STREETVIEW_FIXTURE_DIR. Without them the
// real-data suite is reported as skipped (never silently passed).
const SV_FIXTURES = process.env.STREETVIEW_FIXTURE_DIR || path.join(REPO, '.scratchbox/streetview_fixtures/esb');
const tileReq = requireAsset(TILE, 'scripts/extract_esb_tile.html (ESB Google 3D Tiles extraction)');
const fixturesReq = requireAll(tileReq, requireFile(path.join(SV_FIXTURES, 'sv_meta.json'),
    'cached real Street View frames; set STREETVIEW_FIXTURE_DIR or copy .scratchbox/streetview_fixtures/esb from a machine that has it'));
const hasTile = tileReq.ok;
/** encodeRgbaToJpeg spawns resolveFfmpegPath() (FFMPEG_PATH, else `ffmpeg` on PATH). */
const ffmpeg: Requirement = findBinary(resolveFfmpegPath()) !== null
    ? { ok: true, reason: '' }
    : { ok: false, reason: `\`${resolveFfmpegPath()}\` not found (set FFMPEG_PATH or ${HOW_TO.ffmpeg})` };

let scan: ScanMesh;
let ground: GroundModel;
let creases: CreaseSampleSet;
let textured: TexturedPrimitive[];
let textureLines: CreaseSampleSet;

beforeAll(() => {
    if (!hasTile) return;
    fs.mkdirSync(SHOTS, { recursive: true });
    scan = loadScanMesh(TILE);
    ground = buildGroundModel(scan);
    creases = extractCreaseSamples(scan.mesh);
    textured = loadTexturedScene(TILE);
    textureLines = extractTextureLineSamples(textured);
}, 900_000);

describe('raster primitives', () => {
    it('exact distance transform matches brute force', () => {
        const w = 37, h = 23;
        const f = new Uint8Array(w * h);
        for (const [x, y] of [[3, 4], [30, 2], [17, 20], [5, 18]]) f[y * w + x] = 1;
        const dt = distanceTransform(f, w, h, 1000);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let best = Infinity;
            for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) if (f[yy * w + xx]) best = Math.min(best, Math.hypot(xx - x, yy - y));
            expect(dt[y * w + x]).toBeCloseTo(best, 5);
        }
    });

    it('sky segmentation keeps warm sunlit stone out of the sky and blue sky in', () => {
        const w = 64, h = 64;
        const rgba = Buffer.alloc(w * h * 4);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const k = (y * w + x) * 4;
            const building = x > 20 + y / 4 || y > 40;
            const c = building ? [226, 214, 192] : [110, 160, 232]; // bright warm limestone vs blue sky
            rgba[k] = c[0]; rgba[k + 1] = c[1]; rgba[k + 2] = c[2]; rgba[k + 3] = 255;
        }
        const sky = segmentSky(rgba, w, h, buildValidMask(w, h, { watermarkBottomPx: 0 }));
        let wrong = 0;
        for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
            const building = x > 20 + y / 4 || y > 40;
            const nearEdge = Math.abs(x - (20 + y / 4)) < 3 || Math.abs(y - 40) < 3;
            if (!nearEdge && (sky[y * w + x] === 1) === building) wrong++;
        }
        expect(wrong).toBe(0);
    });
});

describe('plates.json contract', () => {
    it('round-trips a plate (image, depth, mask, pose) and keeps the renderer projection convention', () => {
        const dir = path.join(REPO, 'test-results/streetview_plates_contract');
        fs.mkdirSync(dir, { recursive: true });
        const W = 64, H = 48;
        const rgba = Buffer.alloc(W * H * 4);
        for (let i = 0; i < W * H; i++) { rgba[i * 4] = i % 251; rgba[i * 4 + 1] = (i * 7) % 253; rgba[i * 4 + 2] = 90; rgba[i * 4 + 3] = 255; }
        const depth = new Float32Array(W * H).map((_, i) => 10 + (i % W) * 0.01);
        const valid = buildValidMask(W, H, { watermarkBottomPx: 4 });
        for (let i = 0; i < W * H; i++) if (!valid[i]) depth[i] = PLATE_EMPTY_DEPTH;
        fs.writeFileSync(path.join(dir, 'f.png'), encodePng(W, H, rgba));
        fs.writeFileSync(path.join(dir, 'f.depth.f32'), encodeDepthF32(depth));
        fs.writeFileSync(path.join(dir, 'f.mask.png'), encodeMaskPng(valid, W, H));
        const cam = frameCamera([5, 14, -30], 200, 25, 70, W, H, { dx: 0.3, dy: -0.1, dz: 0.2, dyawDeg: 0.5, dpitchDeg: -0.4, drollDeg: 0.7 }, 200);
        const file: StreetViewPlatesFile = {
            version: 1, createdAt: new Date().toISOString(), glbPath: TILE, anchor: ANCHOR, frameConvention: 'x=East,y=Up,z=South(-North); heading clockwise from north',
            plates: [{
                id: 'f', panoId: 'p', date: '2026-04', imagePath: 'f.png', depthPath: 'f.depth.f32', maskPngPath: 'f.mask.png', width: W, height: H,
                request: { headingDeg: 200, pitchDeg: 25, fovDeg: 70 }, pose: frameCameraToPose(cam), intrinsics: streetViewIntrinsics(70, W, H),
                station: stationForFrame(0, 'f', cam, 70, ANCHOR), poseQuality: 0.8, occluders: [],
                registration: { method: 'search', correction: ZERO_CORRECTION, moveMeters: 0, creaseMedianPx: null, silhouetteMedianPx: null, skyIoU: null }
            }],
            rejected: []
        };
        fs.writeFileSync(path.join(dir, 'plates.json'), JSON.stringify(file));
        const [plate] = loadStreetViewPlates(path.join(dir, 'plates.json'));
        expect(plate.width).toBe(W);
        expect(Buffer.from(plate.rgba).equals(rgba)).toBe(true);
        expect(Array.from(plate.depth)).toEqual(Array.from(depth));
        expect(plate.station.rollDegrees).toBeCloseTo(-0.7, 0); // roll survives through the `up` vector
        // A world point projected with the frame camera lands where the renderer convention (pose) puts it
        const p: [number, number, number] = [cam.eye[0] + cam.fwd[0] * 20 + cam.right[0] * 3, cam.eye[1] + cam.fwd[1] * 20 + cam.up[1] * 2, cam.eye[2] + cam.fwd[2] * 20 + cam.right[2] * 3];
        const a = projectToFrame(cam, p)!;
        const pose = plate.pose;
        const f = [pose.targetX - pose.x, pose.targetY - pose.y, pose.targetZ - pose.z];
        const fl = Math.hypot(f[0], f[1], f[2]); const fw = f.map(v => v / fl);
        const up = pose.up!;
        const r = [fw[1] * up[2] - fw[2] * up[1], fw[2] * up[0] - fw[0] * up[2], fw[0] * up[1] - fw[1] * up[0]];
        const rl = Math.hypot(r[0], r[1], r[2]); const rr = r.map(v => v / rl);
        const uu = [rr[1] * fw[2] - rr[2] * fw[1], rr[2] * fw[0] - rr[0] * fw[2], rr[0] * fw[1] - rr[1] * fw[0]];
        const d = [p[0] - pose.x, p[1] - pose.y, p[2] - pose.z];
        const z = d[0] * fw[0] + d[1] * fw[1] + d[2] * fw[2];
        const P11 = 1 / Math.tan(pose.fov * Math.PI / 360), P00 = P11 / (W / H);
        const sx = (P00 * (d[0] * rr[0] + d[1] * rr[1] + d[2] * rr[2]) / z + 1) * W / 2;
        const sy = (1 - P11 * (d[0] * uu[0] + d[1] * uu[1] + d[2] * uu[2]) / z) * H / 2;
        expect(sx).toBeCloseTo(a[0], 6);
        expect(sy).toBeCloseTo(a[1], 6);
    });
});

/** Textured render of the scan (its own photogrammetric texture) with a clear-sky background, used as a synthetic "photo". */
function syntheticPhoto(eye: [number, number, number], heading: number, pitch: number, fov: number, size = 640): RgbaImage {
    const cam = frameCamera(eye, heading, pitch, fov, size, size, ZERO_CORRECTION, heading);
    return { width: size, height: size, rgba: renderTexturedView(textured, cam, [110, 160, 232]).rgba };
}

describe.skipIf(!tileReq.ok)(withReason('synthetic pose recovery on the real scan', tileReq), () => {
    it('recovers a 2 m / 1.5 deg perturbation within 0.2 m / 0.2 deg', () => {
        // Ground-truth camera: a street-level pano on W 34th St looking at the podium and shaft
        const truthEye: [number, number, number] = [22.74, 14.79, -40.02];
        const shots = [{ heading: 209.6, pitch: 30 }, { heading: 165, pitch: 20 }];
        const pert = { dx: 1.2, dz: -1.6, dyawDeg: 1.5 }; // |(dx, dz)| = 2 m
        const nominalEye: [number, number, number] = [truthEye[0] - pert.dx, truthEye[1], truthEye[2] - pert.dz];
        const input: PanoRegistrationInput = {
            panoId: 'synthetic', nominalEye,
            frames: shots.map((s, i) => ({ key: `synthetic_${i}`, image: syntheticPhoto(truthEye, s.heading, s.pitch, 90), headingDeg: s.heading - pert.dyawDeg, pitchDeg: s.pitch, fovDeg: 90 }))
        };
        const registrar = new StreetViewPoseRegistrar(scan.mesh, { mask: { watermarkBottomPx: 0 } }, creases, { textureLines, textured });
        const res = registrar.registerPano(input);
        const c = res.correction;
        const posErr = Math.hypot(c.dx - pert.dx, c.dy, c.dz - pert.dz);
        const angErr = Math.max(Math.abs(c.dyawDeg - pert.dyawDeg), Math.abs(c.dpitchDeg), Math.abs(c.drollDeg));
        for (const [i, fr] of res.frames.entries()) {
            const d0 = renderFrameDepth(scan.mesh, registrar.camera(input, input.frames[i], ZERO_CORRECTION));
            const d1 = renderFrameDepth(scan.mesh, fr.camera);
            fs.writeFileSync(path.join(SHOTS, `streetview_pose_registrar_synthetic_${i}.png`), encodePng(640, 640, renderRegistrationOverlay(input.frames[i].image, d0, d1)));
        }
        console.log(`[synthetic] correction ${JSON.stringify(c)} posErr ${posErr.toFixed(3)} m angErr ${angErr.toFixed(3)} deg; ` +
            res.frames.map(f => `sil ${f.final.silhouetteMedianPx?.toFixed(2)} line ${f.final.creaseMedianPx?.toFixed(2)} iou ${f.final.skyIoU?.toFixed(3)} ncc ${f.final.photometricNcc?.toFixed(3)}`).join(' | '));
        expect(posErr).toBeLessThanOrEqual(0.2);
        expect(angErr).toBeLessThanOrEqual(0.2);
        expect(res.atBound).toEqual([]);
    }, 900_000);
});

/** Red (photo) / cyan (render) anaglyph, each normalised over the frame. */
function anaglyph(photo: Buffer, render: Buffer, W: number, H: number): Buffer {
    const lum = (b: Buffer, i: number) => 0.299 * b[i * 4] + 0.587 * b[i * 4 + 1] + 0.114 * b[i * 4 + 2];
    const n = W * H;
    let mp = 0, mr = 0, sp = 0, sr = 0;
    for (let i = 0; i < n; i++) { const a = lum(photo, i), b = lum(render, i); mp += a; mr += b; sp += a * a; sr += b * b; }
    mp /= n; mr /= n; sp = Math.sqrt(Math.max(1e-6, sp / n - mp * mp)); sr = Math.sqrt(Math.max(1e-6, sr / n - mr * mr));
    const o = Buffer.alloc(n * 4);
    for (let i = 0; i < n; i++) {
        o[i * 4] = Math.max(0, Math.min(255, 128 + 50 * (lum(photo, i) - mp) / sp));
        o[i * 4 + 1] = o[i * 4 + 2] = Math.max(0, Math.min(255, 128 + 50 * (lum(render, i) - mr) / sr));
        o[i * 4 + 3] = 255;
    }
    return o;
}

function sideBySide(a: Buffer, b: Buffer, W: number, H: number): Buffer {
    const o = Buffer.alloc(2 * W * H * 4);
    for (let y = 0; y < H; y++) { a.copy(o, y * 2 * W * 4, y * W * 4, (y + 1) * W * 4); b.copy(o, (y * 2 * W + W) * 4, y * W * 4, (y + 1) * W * 4); }
    return o;
}

/**
 * A synthetic street "photo" of the textured scan: supersampled render at the true pose, then a polarity-folding tone
 * curve (|L - 120| stretch: dark windows and bright stone both become bright), an unsharp mask (the photo is sharper
 * than the tile texture), sky background and deterministic noise.
 */
function foldedPhoto(eye: [number, number, number], heading: number, pitch: number, fov: number, size = 640): RgbaImage {
    const cam = frameCamera(eye, heading, pitch, fov, size, size, ZERO_CORRECTION, heading);
    const ss = { ...cam, width: 2 * size, height: 2 * size, fx: 2 * cam.fx, fy: 2 * cam.fy, cx: 2 * cam.cx, cy: 2 * cam.cy };
    const r = renderTexturedView(textured, ss, [0, 0, 0]);
    const L = new Float32Array(size * size), sky = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        let s = 0, empty = 0;
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
            const k = (2 * y + j) * 2 * size + 2 * x + i;
            s += 0.299 * r.rgba[k * 4] + 0.587 * r.rgba[k * 4 + 1] + 0.114 * r.rgba[k * 4 + 2];
            if (!(r.depth[k] < PLATE_EMPTY_DEPTH * 0.5)) empty++;
        }
        L[y * size + x] = s / 4; sky[y * size + x] = empty === 4 ? 1 : 0;
    }
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 - 0.5; };
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = y * size + x;
        let v: number;
        if (sky[i]) v = 225;
        else {
            const lap = 4 * L[i] - L[Math.max(0, i - 1)] - L[Math.min(size * size - 1, i + 1)] - L[Math.max(0, i - size)] - L[Math.min(size * size - 1, i + size)];
            v = 60 + 1.6 * Math.abs(L[i] + 0.6 * lap - 120);
        }
        v = Math.max(0, Math.min(255, v + 8 * rnd()));
        rgba[i * 4] = v; rgba[i * 4 + 1] = v * 0.98; rgba[i * 4 + 2] = v * 0.95; rgba[i * 4 + 3] = 255;
    }
    return { width: size, height: size, rgba };
}

describe.skipIf(!tileReq.ok)(withReason('feature registration (textured render, local features, RANSAC-PnP, interior edges)', tileReq), () => {
    it('recovers a 2 m / 0.8 m / 1.5 deg perturbation from a polarity-folded synthetic photo and passes the gates', () => {
        const truthEye: [number, number, number] = [22.74, 14.79, -40.02]; // street level on W 34th St, podium and shaft
        const shots = [{ heading: 209.6, pitch: 30 }, { heading: 165, pitch: 20 }];
        const pert = { dx: 1.2, dy: -0.8, dz: -1.6, dyawDeg: 1.5 };
        const nominalEye: [number, number, number] = [truthEye[0] - pert.dx, truthEye[1] - pert.dy, truthEye[2] - pert.dz];
        const input: FeaturePanoInput = {
            panoId: 'synthetic', nominalEye, referenceHeadingDeg: shots[0].heading - pert.dyawDeg,
            frames: shots.map((s, i) => {
                const image = foldedPhoto(truthEye, s.heading, s.pitch, 90);
                return { key: `synthetic_${i}`, image, valid: buildValidMask(640, 640, { watermarkBottomPx: 0 }), headingDeg: s.heading - pert.dyawDeg, pitchDeg: s.pitch, fovDeg: 90 };
            })
        };
        // one seed (the perturbed GPS pose) keeps the test short; the CLI also tries +-2.5 m seeds
        const reg = new StreetViewFeatureRegistrar(textured, { seedOffsetMeters: 0, featureSeeds: 1 });
        const res = reg.registerPano(input);
        const c = res.correction;
        const posErr = Math.hypot(c.dx - pert.dx, c.dy - pert.dy, c.dz - pert.dz);
        const angErr = Math.max(Math.abs(c.dyawDeg - pert.dyawDeg), Math.abs(c.dpitchDeg), Math.abs(c.drollDeg));
        res.frames.forEach((f, i) => {
            const r0 = reg.render(reg.camera(input, i, ZERO_CORRECTION)).rgba, r1 = reg.render(f.camera).rgba;
            const img = input.frames[i].image.rgba;
            fs.writeFileSync(path.join(SHOTS, `streetview_feature_registrar_synthetic_${i}.png`), encodePng(1280, 640, sideBySide(anaglyph(img, r0, 640, 640), anaglyph(img, r1, 640, 640), 640, 640)));
        });
        console.log(`[feature synthetic] correction ${JSON.stringify(c)} posErr ${posErr.toFixed(3)} m angErr ${angErr.toFixed(3)} deg; ` +
            res.frames.map(f => `inliers ${f.inliers} edges ${f.edges.medianPx?.toFixed(2)} (${f.edges.located}/${f.edges.tested}) at GPS ${f.edgesPrior.medianPx?.toFixed(2)}; oNCC ${f.nccPrior?.toFixed(3)}->${f.nccFinal?.toFixed(3)}; held-out ${f.heldOut?.edges.medianPx?.toFixed(2)}`).join(' | '));
        expect(posErr).toBeLessThanOrEqual(0.3);
        expect(angErr).toBeLessThanOrEqual(0.3);
        expect(res.atBound).toEqual([]);
        for (const f of res.frames) {
            expect(f.edges.medianPx).not.toBeNull();
            expect(f.edges.medianPx!).toBeLessThanOrEqual(1);
            expect(f.edges.truncatedCostPx).toBeLessThan(f.edgesPrior.truncatedCostPx);
            expect(f.nccFinal! - f.nccPrior!).toBeGreaterThan(0);
            const gi: FeatureGateInput = {
                inliers: f.inliers, edgeMedianPx: f.edges.medianPx, edgeLocated: f.edges.located, nccFinal: f.nccFinal, nccPrior: f.nccPrior,
                heldOutEdgeMedianPx: f.heldOut?.edges.medianPx ?? null, hasOtherFrames: true, crossView: null, atBound: res.atBound
            };
            expect(evaluateFeatureGates(gi)).toEqual([]);
            expect(featurePoseQuality(gi)).toBeGreaterThan(0.5);
        }
    }, 900_000);
});

describe('feature gates and pose quality', () => {
    const ok: FeatureGateInput = {
        inliers: 60, edgeMedianPx: 0, edgeLocated: 40, nccFinal: 0.3, nccPrior: 0.1, heldOutEdgeMedianPx: 0, hasOtherFrames: true, crossView: null, atBound: []
    };
    const g = DEFAULT_FEATURE_GATES;

    it('accepts a frame passing every gate and scores it against the worst gated statistic', () => {
        expect(evaluateFeatureGates(ok)).toEqual([]);
        // worst ratio: inliers 12/60 = 0.2, NCC term 1 / (1 + 0.2 / 0.02) = 1/11
        expect(featurePoseQuality(ok)).toBeCloseTo(1 / (1 + 0.2 ** 2), 9);
        expect(featurePoseQuality({ ...ok, edgeMedianPx: g.interiorEdgeMedianPx })).toBeCloseTo(0.5, 9);       // edge at its gate
        expect(featurePoseQuality({ ...ok, heldOutEdgeMedianPx: g.heldOutEdgeMedianPx })).toBeCloseTo(0.5, 9); // held-out at its gate
        expect(featurePoseQuality({ ...ok, inliers: g.minInliers })).toBeCloseTo(0.5, 9);                      // inliers at the gate
        expect(featurePoseQuality({ ...ok, nccFinal: 0.1 + 1e-9 })).toBeCloseTo(0.5, 6);                          // NCC gain ~0
        const cross = { ...ok, hasOtherFrames: false, heldOutEdgeMedianPx: null, crossView: { medianPx: g.crossViewMedianPx, matches: 40, partnerPanoId: 'p' } };
        expect(evaluateFeatureGates(cross)).toEqual([]);
        expect(featurePoseQuality(cross)).toBeCloseTo(0.5, 9);                                                   // cross-view at its gate
    });

    it('rejects failed, unmeasured and unverified statistics (quality 0)', () => {
        const cases: Array<[Partial<FeatureGateInput>, RegExp]> = [
            [{ edgeMedianPx: 2.01 }, /interior edge median/],
            [{ edgeMedianPx: null, edgeLocated: 5 }, /interior edges unverified/],
            [{ nccFinal: 0.1 }, /NCC gain/],
            [{ nccFinal: null }, /unmeasured/],
            [{ inliers: 11 }, /PnP inliers/],
            [{ heldOutEdgeMedianPx: 3.5 }, /held-out edge median/],
            [{ heldOutEdgeMedianPx: null }, /held-out check unverified/],
            [{ hasOtherFrames: false, heldOutEdgeMedianPx: null }, /cross-frame agreement unverified/],
            [{ hasOtherFrames: false, heldOutEdgeMedianPx: null, crossView: { medianPx: 1, matches: 5, partnerPanoId: 'p' } }, /cross-frame agreement unverified/],
            [{ crossView: { medianPx: 3, matches: 40, partnerPanoId: 'p' } }, /cross-view median/],
            [{ atBound: ['vertical'] }, /search bound/]
        ];
        for (const [patch, re] of cases) {
            const s = { ...ok, ...patch };
            const reasons = evaluateFeatureGates(s);
            expect(reasons.some(r => re.test(r)), `${JSON.stringify(patch)} -> ${reasons.join('; ')}`).toBe(true);
            expect(featurePoseQuality(s)).toBe(0);
        }
    });
});

describe('Street View billing safety', () => {
    const KEY = 'TESTKEY_billing_safety_9q';
    const pano: PanoRecord = { panoId: 'PANO_B', lat: 40.7, lng: -73.9, x: 0, z: 0, streetY: 0, eye: [0, 2.5, 0], distanceToHeroMeters: 10 };
    const frame = (h: number): CandidateFrame => ({ panoId: pano.panoId, headingDeg: h, pitchDeg: 10, fovDeg: 60, width: 16, height: 16 });
    const slowFetch = (counter: { images: number }): typeof fetch => (async (input: any) => {
        const url = String(input);
        if (url.includes('/streetview/metadata')) {
            const q = new URL(url).searchParams;
            return new Response(JSON.stringify({ status: 'OK', pano_id: q.get('pano'), date: '2026-04', location: { lat: 1, lng: 2 }, copyright: '© Google' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        counter.images++;
        await new Promise(r => setTimeout(r, 30));
        const jpg = await encodeRgbaToJpeg(Buffer.alloc(16 * 16 * 4, 100), 16, 16);
        return new Response(new Uint8Array(jpg), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }) as unknown as typeof fetch;

    it('has one fixed global ledger under the repository, independent of any cache directory', () => {
        expect(defaultStreetViewLedgerPath()).toBe(path.join(REPO, '.scratchbox', 'streetview_cache', 'billing_ledger.json'));
    });

    it('refuses a custom ledger for real (non-injected) requests before any request is made', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-ledger-'));
        await expect(fetchFrames([frame(1)], new Map([[pano.panoId, pano]]), { apiKey: KEY, cacheDir: path.join(root, 'c'), ledgerPath: path.join(root, 'l.json') }))
            .rejects.toThrow(/only allowed with an injected fetchImpl/);
        expect(fs.existsSync(path.join(root, 'l.json'))).toBe(false);
    });

    it.skipIf(!ffmpeg.ok)(withReason('concurrent runs sharing the ledger cannot spend more than the cap', ffmpeg), async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-ledger-'));
        const ledgerPath = path.join(root, 'ledger.json');
        fs.writeFileSync(ledgerPath, JSON.stringify({ billedImageRequests: 78, keys: [] }));
        const counter = { images: 0 };
        const panos = new Map([[pano.panoId, pano]]);
        const runs = await Promise.all([0, 1, 2].map(k => fetchFrames([frame(10 + k), frame(20 + k)], panos, { apiKey: KEY, cacheDir: path.join(root, `out${k}`), ledgerPath, fetchImpl: slowFetch(counter) })));
        expect(counter.images).toBe(2);
        expect(runs.reduce((a, r) => a + r.billed, 0)).toBe(2);
        expect(readLedger(ledgerPath).billedImageRequests).toBe(80);
        expect(fs.existsSync(`${ledgerPath}.lock`)).toBe(false);
    });
});

describe.skipIf(!fixturesReq.ok)(withReason('real Street View regression (cached frames, feature registration)', fixturesReq), () => {
    it('W 34th St: registration lowers the interior-edge cost and raises the orientation NCC over the GPS pose', () => {
        const meta = JSON.parse(fs.readFileSync(path.join(SV_FIXTURES, 'sv_meta.json'), 'utf8'));
        const m = meta.find((q: any) => q.id === 'w34th');
        const p = geodeticToScan(ANCHOR, m.location.lat, m.location.lng);
        const eye: [number, number, number] = [p.x, localStreetHeight(scan, ground, p.x, p.z) + 2.5, p.z];
        const image = decodeImageToRgba(fs.readFileSync(path.join(SV_FIXTURES, 'sv_w34th.jpg')));
        const input: FeaturePanoInput = {
            panoId: m.pano, nominalEye: eye, referenceHeadingDeg: m.heading,
            frames: [{ key: 'w34th', image, valid: buildValidMask(image.width, image.height), headingDeg: m.heading, pitchDeg: m.pitch, fovDeg: m.fov }]
        };
        const reg = new StreetViewFeatureRegistrar(textured, {});
        const res = reg.registerPano(input);
        const f = res.frames[0];
        const r0 = reg.render(reg.camera(input, 0, ZERO_CORRECTION)).rgba, r1 = reg.render(f.camera).rgba;
        fs.writeFileSync(path.join(SHOTS, 'streetview_feature_registrar_real_w34th.png'), encodePng(1280, 640, sideBySide(anaglyph(image.rgba, r0, 640, 640), anaglyph(image.rgba, r1, 640, 640), 640, 640)));
        console.log(`[feature real w34th] move ${res.moveMeters.toFixed(2)} m, corr ${JSON.stringify(res.correction)}; inliers ${f.inliers}; ` +
            `edges ${f.edges.medianPx?.toFixed(2)} px (${f.edges.located}/${f.edges.tested}, cost ${f.edges.truncatedCostPx.toFixed(2)}) vs GPS ${f.edgesPrior.medianPx?.toFixed(2)} (cost ${f.edgesPrior.truncatedCostPx.toFixed(2)}); oNCC ${f.nccPrior?.toFixed(3)} -> ${f.nccFinal?.toFixed(3)}`);
        expect(res.atBound).toEqual([]);
        expect(f.edges.truncatedCostPx).toBeLessThan(0.8 * f.edgesPrior.truncatedCostPx);
        expect(f.nccFinal! - f.nccPrior!).toBeGreaterThan(0);
        expect(f.inliers).toBeGreaterThanOrEqual(DEFAULT_FEATURE_GATES.minInliers);
    }, 1_800_000);
});
