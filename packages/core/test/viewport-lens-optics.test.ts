/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport's lens optics (viewportOptics.ts):
 * - the distortion the GPU pass draws is the Brown-Conrady model of the spatial services (VfxPlateMatchmoveService),
 *   in normalized camera coordinates, and the pointer / overscan inverse round-trips it;
 * - the depth-of-field blur is the thin-lens circle of confusion, and the pass gets exactly those pixels;
 * - passes exist only when camera.lens configures them.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as THREE from 'three';
import {
    ViewportOpticsChain,
    planViewportOptics,
    cameraToFrameCoefficients,
    displayedNdcToPinholeNdc,
    distortionOverscan,
    distortionMaxAspect,
    distortCameraPoint,
    undistortCameraPoint,
    circleOfConfusionMm,
    circleOfConfusionPx,
    frameHeightOnSensorMm
} from '../src/browser/generative-canvas/primitives/scene3d/viewportOptics';
import { computeBrownConradyUV, LENS_DISTORTION_SHADER } from '../src/browser/generative-canvas/services/optics/LensDistortionEffect';
import { CINEMATIC_BOKEH_SHADER } from '../src/browser/generative-canvas/services/optics/CinematicBokehPass';
import { VfxPlateMatchmoveService } from '../src/browser/generative-canvas/services/video/VfxPlateMatchmoveService';
import { PhysicalCameraModel } from '../src/common/optics/PhysicalCameraModel';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

const SHOTS = path.resolve(__dirname, '..', '..', '..', 'test-results', 'screenshots', 'lens_dof');
const BARREL = { k1: -0.15, k2: 0, k3: 0, p1: 0, p2: 0 };
const MIXED = { k1: -0.12, k2: 0.03, k3: -0.004, p1: 0.0015, p2: -0.001 };

/** The redistort shader's Newton inverse (5 iterations from the target), on the CPU. */
function glslUndistort(tx: number, ty: number, c: typeof BARREL): [number, number] {
    let x = tx, y = ty;
    for (let i = 0; i < 5; i++) {
        const r2 = x * x + y * y, r4 = r2 * r2, r6 = r4 * r2;
        const radial = 1 + c.k1 * r2 + c.k2 * r4 + c.k3 * r6;
        const fx = x * radial + 2 * c.p1 * x * y + c.p2 * (r2 + 2 * x * x) - tx;
        const fy = y * radial + c.p1 * (r2 + 2 * y * y) + 2 * c.p2 * x * y - ty;
        const dRad = 2 * (c.k1 + 2 * c.k2 * r2 + 3 * c.k3 * r4);
        const j00 = radial + x * x * dRad + 2 * c.p1 * y + 6 * c.p2 * x;
        const j01 = x * y * dRad + 2 * c.p1 * x + 2 * c.p2 * y;
        const j10 = j01;
        const j11 = radial + y * y * dRad + 6 * c.p1 * y + 2 * c.p2 * x;
        const det = j00 * j11 - j01 * j10;
        if (Math.abs(det) < 1e-7) break;
        x -= (j11 * fx - j01 * fy) / det;
        y -= (-j10 * fx + j00 * fy) / det;
    }
    return [x, y];
}

describe('viewport lens distortion is the spatial services\' Brown-Conrady model', () => {
    const fov = 50, aspect = 16 / 9, s = 2 * Math.tan(THREE.MathUtils.degToRad(fov) / 2);

    it('the shader frame (frame-height units) with converted coefficients draws the camera-coordinate model', () => {
        for (const c of [BARREL, MIXED]) {
            const frame = cameraToFrameCoefficients(c, fov);
            for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
                const uv: [number, number] = [i / 8, j / 8];
                // GPU mirror (computeBrownConradyUV = the shader's distortCoords) in the frame
                const [gu, gv] = computeBrownConradyUV(uv, { ...frame, k4: 0 }, aspect);
                // the spatial services' model in normalized camera coordinates
                const xn = (uv[0] - 0.5) * aspect * s, yn = (uv[1] - 0.5) * s;
                const [xd, yd] = VfxPlateMatchmoveService.distortPoint(xn, yn, c);
                expect(gu).toBeCloseTo(0.5 + xd / s / aspect, 12);
                expect(gv).toBeCloseTo(0.5 + yd / s, 12);
            }
        }
    });

    it('undistort / distort round-trips across the frame (and the shader\'s 5-step inverse converges at the corners)', () => {
        for (const c of [BARREL, MIXED]) {
            const frame = cameraToFrameCoefficients(c, fov);
            let worst = 0, worstGlsl = 0;
            for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
                const xn = (i / 10 - 0.5) * aspect * s, yn = (j / 10 - 0.5) * s;
                const [xu, yu] = undistortCameraPoint(xn, yn, c);
                const [xr, yr] = distortCameraPoint(xu, yu, c);
                worst = Math.max(worst, Math.hypot(xr - xn, yr - yn));
                // same point through the spatial service directly
                const [xs, ys] = VfxPlateMatchmoveService.undistortPoint(xn, yn, c, 20, 1e-12);
                expect(xu).toBeCloseTo(xs, 10);
                expect(yu).toBeCloseTo(ys, 10);
                // GLSL inverse in frame units vs the exact one
                const [gx, gy] = glslUndistort((i / 10 - 0.5) * aspect, j / 10 - 0.5, frame);
                worstGlsl = Math.max(worstGlsl, Math.hypot(gx - xu / s, gy - yu / s));
            }
            expect(worst).toBeLessThan(1e-9);
            // < 1e-4 frame heights: a tenth of a pixel on a 1000 px viewport
            expect(worstGlsl).toBeLessThan(1e-4);
        }
    });

    it('the pointer mapping inverts what is drawn, and the overscan covers the frame border', () => {
        const plan = { coefficients: BARREL, anamorphicSqueeze: 1 };
        for (const [x, y] of [[0, 0], [0.5, 0.3], [-1, -1], [1, 1], [-0.7, 0.95]]) {
            const p = displayedNdcToPinholeNdc(x, y, plan, fov, aspect)!;
            // forward: pinhole NDC -> camera coords -> distort -> displayed NDC
            const [xd, yd] = distortCameraPoint(p[0] * aspect / 2 * s, p[1] / 2 * s, BARREL);
            expect(xd / s * 2 / aspect).toBeCloseTo(x, 9);
            expect(yd / s * 2).toBeCloseTo(y, 9);
            // barrel distortion shows more than the pinhole frame off-centre
            if (x !== 0 || y !== 0) expect(Math.hypot(p[0], p[1])).toBeGreaterThan(Math.hypot(x, y));
        }
        const { overscan, folds } = distortionOverscan(plan, fov, aspect);
        expect(folds).toBe(false);
        const corner = displayedNdcToPinholeNdc(1, 1, plan, fov, aspect)!;
        expect(overscan).toBeCloseTo(Math.max(Math.abs(corner[0]), Math.abs(corner[1])), 9);
        expect(overscan).toBeGreaterThan(1.1);
        // pincushion pulls the frame in: no overscan needed
        expect(distortionOverscan({ coefficients: { ...BARREL, k1: 0.1 }, anamorphicSqueeze: 1 }, fov, aspect).overscan).toBe(1);
        // a lens folding inside the frame is detected
        expect(distortionOverscan({ coefficients: { ...BARREL, k1: -2 }, anamorphicSqueeze: 1 }, fov, aspect).folds).toBe(true);
    });

    it('distortionMaxAspect finds the widest frame before the model folds', () => {
        // fov with s = 2 tan(fov/2) = 1: r (1 - 0.15 r^2) peaks at 0.9938; corner (1/2) sqrt(w^2 + 1) reaches it at w = 1.718
        const fov1 = 2 * Math.atan(0.5) * 180 / Math.PI;
        const w = distortionMaxAspect({ coefficients: BARREL, anamorphicSqueeze: 1 }, fov1);
        const peak = (1 / Math.sqrt(0.45)) * (1 - 0.15 / 0.45);
        expect(w).toBeCloseTo(Math.sqrt((2 * peak) ** 2 - 1), 2);
        expect(distortionMaxAspect({ coefficients: BARREL, anamorphicSqueeze: 1 }, 16)).toBe(Infinity);
    });

    it('draws a k1 = -0.15 grid through the pass mapping (screenshot)', () => {
        const W = 640, H = 360, px = new Uint8Array(W * H * 3);
        const plan = { coefficients: BARREL, anamorphicSqueeze: 1 };
        for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
            const ndcX = (i + 0.5) / W * 2 - 1, ndcY = 1 - (j + 0.5) / H * 2;
            const p = displayedNdcToPinholeNdc(ndcX, ndcY, plan, fov, aspect)!;
            // a square grid in the scene (10 cells per frame height), and the pinhole frame's edge
            const gx = p[0] * aspect * 5, gy = p[1] * 5;
            const line = Math.min(Math.abs(gx - Math.round(gx)), Math.abs(gy - Math.round(gy))) < 0.025;
            const edge = Math.abs(Math.abs(p[0]) - 1) < 0.006 && Math.abs(p[1]) <= 1 || Math.abs(Math.abs(p[1]) - 1) < 0.01 && Math.abs(p[0]) <= 1;
            px.set(edge ? [230, 80, 60] : line ? [235, 235, 240] : [38, 40, 48], (j * W + i) * 3);
        }
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'unit_barrel_k1_-0.15_grid_50deg.png'), encodePng(W, H, px, 3));
    });
});

describe('depth of field: thin-lens circle of confusion', () => {
    it('c = f^2 |d - s| / (N d (s - f)), zero at the focus, and the model\'s DoF limits are where c is the acceptable blur', () => {
        // 50 mm f/2 focused at 5 m, a point at 10 m: 0.05^2 * 5 / (2 * 10 * 4.95) m
        expect(circleOfConfusionMm(50, 2, 5, 10)).toBeCloseTo((0.0025 * 5) / (2 * 10 * 4.95) * 1000, 12);
        expect(circleOfConfusionMm(50, 2, 5, 5)).toBe(0);
        // far background tends to f^2 / (N (s - f))
        expect(circleOfConfusionMm(85, 1.4, 3, 1e9)).toBeCloseTo(0.085 ** 2 / (1.4 * (3 - 0.085)) * 1000, 6);
        // focus inside the focal length has no real image
        expect(circleOfConfusionMm(50, 2, 0.04, 10)).toBe(0);

        const diag = Math.hypot(36, 24), cAcceptable = diag / 1500;
        const dof = PhysicalCameraModel.calculateDepthOfField(85, 1.4, 5, diag);
        expect(circleOfConfusionMm(85, 1.4, 5, dof.nearFocusLimitMeters) / cAcceptable).toBeCloseTo(1, 1);
        expect(circleOfConfusionMm(85, 1.4, 5, dof.farFocusLimitMeters) / cAcceptable).toBeCloseTo(1, 1);
    });

    it('pixels: scaled by the frame height on the sensor, 2 f tan(vfov / 2) = 24 mm for the FOV a 50 mm full-frame lens sets', () => {
        const fov = 2 * Math.atan(12 / 50) * 180 / Math.PI;
        expect(frameHeightOnSensorMm(50, fov)).toBeCloseTo(24, 10);
        expect(circleOfConfusionPx(50, 2, 5, 10, fov, 1080)).toBeCloseTo(circleOfConfusionMm(50, 2, 5, 10) / 24 * 1080, 10);
    });

    it('the bokeh shader computes the same diameter; the viewport passes radius = diameter / 2 (uBokehScale 0.5)', () => {
        // the GLSL computeCoCPixels, on the CPU
        const glsl = (d: number, df: number, fMm: number, N: number, sensorHmm: number, resY: number, scale: number) => {
            const f = fMm * 0.001, A = f / N;
            return (A * (f / (df - f)) * ((d - df) / d)) / (sensorHmm * 0.001) * resY * scale;
        };
        expect(CINEMATIC_BOKEH_SHADER.fragmentShader).toContain('float cocSensorM = aperture * (f / (df - f)) * ((d - df) / d);');
        const fov = 2 * Math.atan(12 / 85) * 180 / Math.PI;
        expect(Math.abs(glsl(20, 5, 85, 1.4, 24, 1080, 1))).toBeCloseTo(circleOfConfusionPx(85, 1.4, 5, 20, fov, 1080), 9);
        // with overscan the target is m frames tall and the pass gets m frame heights of sensor: same pixels
        expect(glsl(20, 5, 85, 1.4, 24 * 1.25, 1350, 0.5)).toBeCloseTo(circleOfConfusionPx(85, 1.4, 5, 20, fov, 1080) / 2, 9);
    });

    it('plots blur radius against depth for 85 mm f/1.4 focused at 5 m (screenshot)', () => {
        const W = 600, H = 240, px = new Uint8Array(W * H * 3).fill(30);
        const fov = 2 * Math.atan(12 / 85) * 180 / Math.PI;
        for (let i = 0; i < W; i++) {
            const depth = 0.5 + (i / W) * 29.5;
            const r = circleOfConfusionPx(85, 1.4, 5, depth, fov, 1080) / 2;
            const h = Math.min(H - 1, Math.round(r * 2));
            for (let j = H - 1; j >= H - 1 - h; j--) px.set(Math.abs(depth - 5) < 0.06 ? [240, 90, 60] : [90, 170, 240], (j * W + i) * 3);
        }
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'unit_coc_radius_85mm_f1.4_focus5m.png'), encodePng(W, H, px, 3));
    });
});

describe('the optics passes exist only when the scene lens configures them', () => {
    it('plans no pass without a lens, or for a lens with nothing to draw', () => {
        expect(planViewportOptics(undefined).passes).toEqual([]);
        expect(planViewportOptics({}).passes).toEqual([]);
        expect(planViewportOptics({ distortion: { k1: 0, k2: 0 } }).passes).toEqual([]);
        expect(planViewportOptics({ focalLengthMm: 50, sensorHeightMm: 24 }).passes).toEqual([]);
        // DoF values but no stored focus: drawn anyway, from a live autofocus read (manual never blocks on an unset distance)
        const noFocus = planViewportOptics({ focalLengthMm: 50, apertureFStop: 2 });
        expect(noFocus.passes).toEqual(['depth-of-field', 'output']);
        expect(noFocus.issues).toEqual([]);
        // an explicit track mode with nothing to track is the one case that still has nothing to measure
        const unresolvedTrack = planViewportOptics({ focalLengthMm: 50, apertureFStop: 2, focusMode: 'track' });
        expect(unresolvedTrack.passes).toEqual([]);
        expect(unresolvedTrack.issues[0]).toMatch(/focus distance or focus object/);
        expect(planViewportOptics({ focalLengthMm: 50, apertureFStop: 2, focusDistanceMeters: 4, depthOfField: false }).passes).toEqual([]);
    });

    it('adds exactly the configured passes, in draw order', () => {
        expect(planViewportOptics({ distortion: { k1: -0.15 } }).passes).toEqual(['lens-distortion', 'output']);
        expect(planViewportOptics({ focalLengthMm: 85, apertureFStop: 1.4, focusObjectId: 'bust' }).passes).toEqual(['depth-of-field', 'output']);
        expect(planViewportOptics({ distortion: { k1: -0.15 }, focalLengthMm: 85, apertureFStop: 1.4, focusDistanceMeters: 5 }).passes)
            .toEqual(['depth-of-field', 'lens-distortion', 'output']);
    });

    it('the chain is inactive (the viewport renders straight to the canvas) until configured, and frees passes when cleared', () => {
        const chain = new ViewportOpticsChain();
        expect(chain.active).toBe(false);
        chain.configure({ distortion: { k1: -0.15 }, focalLengthMm: 85, apertureFStop: 1.4, focusDistanceMeters: 5 });
        expect(chain.active).toBe(true);
        expect(chain.passes).toEqual(['depth-of-field', 'lens-distortion', 'output']);
        expect((chain as any).lensPass).not.toBeNull();
        expect((chain as any).bokehPass).not.toBeNull();
        chain.configure({ focalLengthMm: 85, apertureFStop: 1.4, focusDistanceMeters: 5 });
        expect((chain as any).lensPass).toBeNull();
        chain.configure(undefined);
        expect(chain.active).toBe(false);
        expect((chain as any).bokehPass).toBeNull();
        // without distortion the pointer is not remapped
        const ndc = new THREE.Vector2(0.8, -0.6);
        chain.mapPointerNdc(ndc, new THREE.PerspectiveCamera(50, 16 / 9));
        expect([ndc.x, ndc.y]).toEqual([0.8, -0.6]);
        chain.dispose();
    });

    it('the distortion shader maps output uv into an overscanned source (sourceScale)', () => {
        expect(LENS_DISTORTION_SHADER.fragmentShader).toContain('vec2 finalUv = 0.5 + (opticalCenter + mappedCoord - 0.5) * sourceScale;');
        expect(LENS_DISTORTION_SHADER.uniforms.sourceScale.value.toArray()).toEqual([1, 1]);
    });
});
