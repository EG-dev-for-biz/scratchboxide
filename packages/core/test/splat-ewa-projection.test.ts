/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * EWA splat projection: the CPU mirror of the shader against an independent numeric linearisation, and the real
 * PhotorealGaussianSplatMesh shader rendered in headless Chrome (orientation and shape of a rotated anisotropic splat,
 * 2DGS surfel foreshortening, temporal stability of small splats under sub-pixel camera moves). Screenshots go to
 * test-results/screenshots/splat_ewa/.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'path';
import * as THREE from 'three';
import { EWA_DILATION_PX2, projectSplatEwa } from '../src/common/spatial/splat-ewa-projection';
import { openSplatChrome, splatChrome, type SplatChromeSession } from './helpers/splat-chrome';
import { REPO_ROOT, withReason } from './helpers/requirements';

const SHOTS = path.join(REPO_ROOT, 'test-results/screenshots/splat_ewa');

function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

function randomQuat(r: () => number): [number, number, number, number] {
    // Uniform random rotation (Shoemake).
    const u1 = r(), u2 = r() * 2 * Math.PI, u3 = r() * 2 * Math.PI;
    const a = Math.sqrt(1 - u1), b = Math.sqrt(u1);
    return [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
}

function camera(W: number, H: number, fov: number, pos: number[], target: number[]) {
    const cam = new THREE.PerspectiveCamera(fov, W / H, 0.05, 5000);
    cam.position.fromArray(pos);
    cam.lookAt(new THREE.Vector3().fromArray(target));
    cam.updateMatrixWorld(true);
    return cam;
}

function viewRotRowMajor(m: THREE.Matrix4): number[] {
    const e = m.elements;
    return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

/** Independent reference: Σ_world from three's own quaternion->matrix, Σ_view = W Σ Wᵀ, J by central differences of the
 * actual pixel projection through the projection matrix. */
function numericCov2d(center: THREE.Vector3, sigma: number[], q: number[], cam: THREE.PerspectiveCamera, W: number, H: number) {
    const R = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize()));
    const S = new THREE.Matrix3().set(sigma[0], 0, 0, 0, sigma[1], 0, 0, 0, sigma[2]);
    const M = R.clone().multiply(S);
    const Sigma = M.clone().multiply(M.clone().transpose());
    const Wm = new THREE.Matrix3().setFromMatrix4(cam.matrixWorldInverse);
    const SigmaV = Wm.clone().multiply(Sigma).multiply(Wm.clone().transpose());
    const tView = center.clone().applyMatrix4(cam.matrixWorldInverse);
    const px = (v: THREE.Vector3) => { const c = new THREE.Vector4(v.x, v.y, v.z, 1).applyMatrix4(cam.projectionMatrix); return [c.x / c.w * W / 2, c.y / c.w * H / 2]; };
    const h = 1e-5 * Math.max(1, tView.length());
    const J: number[][] = [[0, 0, 0], [0, 0, 0]];
    for (let a = 0; a < 3; a++) {
        const dp = tView.clone(), dm = tView.clone();
        dp.setComponent(a, dp.getComponent(a) + h); dm.setComponent(a, dm.getComponent(a) - h);
        const p1 = px(dp), p0 = px(dm);
        J[0][a] = (p1[0] - p0[0]) / (2 * h); J[1][a] = (p1[1] - p0[1]) / (2 * h);
    }
    const e = SigmaV.elements; // column-major
    const sv = (i: number, j: number) => e[j * 3 + i];
    const c = (r: number, s: number) => { let acc = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) acc += J[r][i] * sv(i, j) * J[s][j]; return acc; };
    return { s00: c(0, 0), s01: c(0, 1), s11: c(1, 1), tView, J };
}

function ewaFor(center: THREE.Vector3, sigma: number[], q: number[], cam: THREE.PerspectiveCamera, W: number, H: number, opacity = 1) {
    const v = center.clone().applyMatrix4(cam.matrixWorldInverse);
    return projectSplatEwa({
        viewCenter: [v.x, v.y, v.z], sigma: sigma as [number, number, number], quat: q as [number, number, number, number],
        viewRot: viewRotRowMajor(cam.matrixWorldInverse), proj: cam.projectionMatrix.elements, viewportPx: [W, H], opacity
    });
}

/** Intensity-weighted image moments of the red channel (rows bottom-up, y up, as read back from GL). */
function moments(rgba: Uint8Array, W: number, H: number) {
    let m0 = 0, mx = 0, my = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const I = rgba[(y * W + x) * 4]; m0 += I; mx += I * x; my += I * y; }
    mx /= m0; my /= m0;
    let cxx = 0, cxy = 0, cyy = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const I = rgba[(y * W + x) * 4]; const dx = x - mx, dy = y - my;
        cxx += I * dx * dx; cxy += I * dx * dy; cyy += I * dy * dy;
    }
    return { m0, mx, my, cxx: cxx / m0, cxy: cxy / m0, cyy: cyy / m0 };
}

const majorAngleDeg = (s00: number, s01: number, s11: number) => (0.5 * Math.atan2(2 * s01, s00 - s11)) * 180 / Math.PI;
const angleDiff = (a: number, b: number) => { const d = Math.abs(((a - b) % 180 + 180) % 180); return Math.min(d, 180 - d); };

describe('EWA projection: CPU mirror of the shader vs a numeric linearisation', () => {
    it('matches J W Σ Wᵀ Jᵀ from finite differences on 500 random splats and views', () => {
        const r = rng(7);
        let worst = 0;
        for (let n = 0; n < 500; n++) {
            const W = 640 + Math.floor(r() * 1280), H = 360 + Math.floor(r() * 720);
            const target = [r() * 20 - 10, r() * 20 - 10, r() * 20 - 10];
            const dir = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
            const dist = 0.5 + r() * 400;
            const cam = camera(W, H, 20 + r() * 80, [target[0] + dir.x * dist, target[1] + dir.y * dist, target[2] + dir.z * dist], target);
            // Centre within the view cone (inside the 1.3x guard, where the shader uses the exact Jacobian).
            const fwd = new THREE.Vector3(); cam.getWorldDirection(fwd);
            const right = new THREE.Vector3().crossVectors(fwd, cam.up).normalize(), up = new THREE.Vector3().crossVectors(right, fwd);
            const tanY = Math.tan(cam.fov * Math.PI / 360), tanX = tanY * cam.aspect, d = dist * (0.2 + r());
            const center = cam.position.clone().addScaledVector(fwd, d).addScaledVector(right, (r() * 2 - 1) * tanX * d * 0.9).addScaledVector(up, (r() * 2 - 1) * tanY * d * 0.9);
            const sigma = [Math.exp(r() * 6 - 5), Math.exp(r() * 6 - 5), r() < 0.3 ? 1e-5 : Math.exp(r() * 6 - 5)];
            const q = randomQuat(r);
            const ref = numericCov2d(center, sigma, q, cam, W, H);
            const got = ewaFor(center, sigma, q, cam, W, H);
            const scale = Math.max(ref.s00, ref.s11);
            const err = Math.max(Math.abs(got.cov2d[0] - ref.s00), Math.abs(got.cov2d[1] - ref.s01), Math.abs(got.cov2d[2] - ref.s11)) / scale;
            worst = Math.max(worst, err);
        }
        expect(worst).toBeLessThan(1e-5);
    });

    it('matches the sample covariance of projected 3D samples for a small splat (first-order regime)', () => {
        const W = 1280, H = 720;
        const cam = camera(W, H, 60, [3, 2, 9], [0, 0, 0]);
        const center = new THREE.Vector3(0.7, -0.4, 0.2), sigma = [0.05, 0.012, 0.002], q = randomQuat(rng(3));
        const R = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(q[0], q[1], q[2], q[3]));
        const r = rng(11);
        const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
        const pts: number[][] = [];
        for (let i = 0; i < 40000; i++) {
            const p = new THREE.Vector3(gauss() * sigma[0], gauss() * sigma[1], gauss() * sigma[2]).applyMatrix4(R).add(center);
            const c = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(cam.matrixWorldInverse).applyMatrix4(cam.projectionMatrix);
            pts.push([c.x / c.w * W / 2, c.y / c.w * H / 2]);
        }
        const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length, my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
        let sxx = 0, sxy = 0, syy = 0;
        for (const p of pts) { sxx += (p[0] - mx) ** 2; sxy += (p[0] - mx) * (p[1] - my); syy += (p[1] - my) ** 2; }
        sxx /= pts.length; sxy /= pts.length; syy /= pts.length;
        const got = ewaFor(center, sigma, q, cam, W, H).cov2d;
        expect(Math.abs(got[0] - sxx) / sxx).toBeLessThan(0.03);
        expect(Math.abs(got[2] - syy) / syy).toBeLessThan(0.03);
        expect(angleDiff(majorAngleDeg(got[0], got[1], got[2]), majorAngleDeg(sxx, sxy, syy))).toBeLessThan(1.0);
    });

    it('dilates by 0.3 px² and compensates opacity by sqrt(det Σ / det Σ_dilated); culls behind the camera', () => {
        const W = 800, H = 600, cam = camera(W, H, 50, [0, 0, 10], [0, 0, 0]);
        const big = ewaFor(new THREE.Vector3(), [1, 1, 1], [0, 0, 0, 1], cam, W, H, 0.8);
        const tiny = ewaFor(new THREE.Vector3(), [1e-4, 1e-4, 1e-4], [0, 0, 0, 1], cam, W, H, 0.8);
        expect(big.cov2dDilated[0] - big.cov2d[0]).toBeCloseTo(EWA_DILATION_PX2, 10);
        expect(big.opacity).toBeGreaterThan(0.79);
        const det = (c: number[]) => c[0] * c[2] - c[1] * c[1];
        expect(tiny.opacity).toBeCloseTo(0.8 * Math.sqrt(det(tiny.cov2d) / det(tiny.cov2dDilated)), 12);
        expect(tiny.visible).toBe(false); // compensated below 1/255
        expect(ewaFor(new THREE.Vector3(0, 0, 20), [1, 1, 1], [0, 0, 0, 1], cam, W, H).visible).toBe(false);
    });
});

describe.skipIf(!splatChrome.ok)(withReason('EWA splat shader in headless Chrome', splatChrome), () => {
    const W = 400, H = 300;
    let s: SplatChromeSession;
    const flat = { viewDependenceSH: 0, contactAO: 0 };
    beforeAll(async () => { s = await openSplatChrome({ width: W, height: H }); }, 60_000);
    afterAll(async () => { await s?.close(); });

    it('renders a rotated anisotropic splat with the projected orientation and shape', async () => {
        const r = rng(21);
        const cam = camera(W, H, 50, [0, 0, 5], [0, 0, 0]);
        for (let trial = 0; trial < 4; trial++) {
            const q = randomQuat(r);
            const sigma = [0.35, 0.09, 0.03];
            await s.loadInline({ positions: [0, 0, 0], scales: sigma, colors: [1, 1, 1], opacities: [0.5], quats: q }, flat);
            const shot = await s.render({ camPos: [0, 0, 5], target: [0, 0, 0], fovDeg: 50 }, path.join(SHOTS, `rotated_anisotropic_${trial}.png`));
            const m = moments(shot.rgba, W, H);
            const ref = ewaFor(new THREE.Vector3(), sigma, q, cam, W, H, 0.5);
            const [a, b, c] = ref.cov2dDilated;
            // 3-sigma truncation of a 2D Gaussian scales its second moments by (1 - e^-4.5 (1 + 4.5)) / (1 - e^-4.5).
            const trunc = (1 - Math.exp(-4.5) * 5.5) / (1 - Math.exp(-4.5));
            expect(Math.abs(m.mx - W / 2)).toBeLessThan(1);
            expect(Math.abs(m.my - H / 2)).toBeLessThan(1);
            const lRef = [0.5 * (a + c) + Math.sqrt(0.25 * (a - c) ** 2 + b * b), 0.5 * (a + c) - Math.sqrt(0.25 * (a - c) ** 2 + b * b)];
            const lImg = [0.5 * (m.cxx + m.cyy) + Math.sqrt(0.25 * (m.cxx - m.cyy) ** 2 + m.cxy ** 2), 0.5 * (m.cxx + m.cyy) - Math.sqrt(0.25 * (m.cxx - m.cyy) ** 2 + m.cxy ** 2)];
            if (lRef[0] / lRef[1] > 1.3) expect(angleDiff(majorAngleDeg(m.cxx, m.cxy, m.cyy), majorAngleDeg(a, b, c))).toBeLessThan(1.5);
            expect(Math.abs(lImg[0] / (lRef[0] * trunc) - 1)).toBeLessThan(0.06);
            expect(Math.abs(lImg[1] / (lRef[1] * trunc) - 1)).toBeLessThan(0.12);
        }
        expect(s.errors).toEqual([]);
    }, 60_000);

    it('the Scene3D primitive\'s InHouseSplatViewer uses the same projection', async () => {
        const v = await openSplatChrome({ width: W, height: H, inHouseViewer: true });
        try {
            const cam = camera(W, H, 50, [0, 0, 5], [0, 0, 0]);
            const q = randomQuat(rng(77)), sigma = [0.35, 0.09, 0.03];
            await v.loadInHouse({ positions: [0, 0, 0], scales: sigma, colors: [1, 1, 1], opacities: [0.5], quats: q });
            const shot = await v.render({ camPos: [0, 0, 5], target: [0, 0, 0], fovDeg: 50 }, path.join(SHOTS, 'inhouse_viewer_rotated.png'));
            const m = moments(shot.rgba, W, H);
            const [a, b, c] = ewaFor(new THREE.Vector3(), sigma, q, cam, W, H, 0.5).cov2dDilated;
            const trunc = (1 - Math.exp(-4.5) * 5.5) / (1 - Math.exp(-4.5));
            expect(angleDiff(majorAngleDeg(m.cxx, m.cxy, m.cyy), majorAngleDeg(a, b, c))).toBeLessThan(1.5);
            expect(Math.abs((m.cxx + m.cyy) / ((a + c) * trunc) - 1)).toBeLessThan(0.06);
            expect(v.errors).toEqual([]);
        } finally {
            await v.close();
        }
    }, 60_000);

    it('foreshortens a 2DGS surfel by cos(tilt) and fades it out edge-on (no full-strength line)', async () => {
        // Lighting depends on the normal, so compare footprint areas (energy / peak), which the colour cancels out of.
        const measure = async (tiltDeg: number, name: string) => {
            const t = tiltDeg * Math.PI / 180;
            await s.loadInline({ positions: [0, 0, 0], scales: [0.4, 0.4, 1e-4], colors: [1, 1, 1], opacities: [0.6], quats: [Math.sin(t / 2), 0, 0, Math.cos(t / 2)] }, flat);
            const shot = await s.render({ camPos: [0, 0, 5], target: [0, 0, 0], fovDeg: 50 }, path.join(SHOTS, name));
            let peak = 0;
            for (let i = 0; i < shot.rgba.length; i += 4) peak = Math.max(peak, shot.rgba[i]);
            const energy = moments(shot.rgba, W, H).m0;
            return { energy: Number.isFinite(energy) ? energy : 0, peak, area: peak ? energy / peak : 0 };
        };
        const face = await measure(0, 'surfel_face_on.png');
        const tilted = await measure(60, 'surfel_tilt_60.png');
        const edge = await measure(90, 'surfel_edge_on.png');
        expect(face.peak).toBeGreaterThan(50);
        expect(Math.abs(tilted.area / face.area - 0.5)).toBeLessThan(0.05);
        // Edge-on: the coverage left is the compensated 0.3 px² line, a tiny fraction of the disc (colour differs by at
        // most the ambient/diffuse ratio, so 1% leaves margin).
        expect(edge.energy / face.energy).toBeLessThan(0.01);
    }, 60_000);

    it('keeps the image energy of small distant splats stable under sub-pixel camera moves (no aliasing flicker)', async () => {
        const r = rng(5), n = 1500;
        const positions: number[] = [], scales: number[] = [], colors: number[] = [], opacities: number[] = [], quats: number[] = [];
        for (let i = 0; i < n; i++) {
            positions.push((r() - 0.5) * 160, (r() - 0.5) * 110, -200 + (r() - 0.5) * 20);
            const sg = 0.12 + r() * 0.12; // 0.15-0.3 px on screen at 200 m
            scales.push(sg, sg, sg); colors.push(1, 1, 1); opacities.push(0.9); quats.push(...randomQuat(r));
        }
        await s.loadInline({ positions, scales, colors, opacities, quats }, flat);
        // One pixel at 200 m is 2 * 200 * tan(25 deg) / 300 m; step the camera in eighths of it.
        const pxAt200 = 2 * 200 * Math.tan(25 * Math.PI / 180) / H;
        const totals: number[] = [];
        for (let k = 0; k < 16; k++) {
            const dx = (k % 4) * pxAt200 / 4 + 0.03 * pxAt200, dy = Math.floor(k / 4) * pxAt200 / 4;
            const shot = await s.render({ camPos: [dx, dy, 0], target: [dx, dy, -1], fovDeg: 50 }, k === 0 ? path.join(SHOTS, 'small_distant_splats.png') : undefined);
            totals.push(moments(shot.rgba, W, H).m0);
        }
        const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
        const cv = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / totals.length) / mean;
        expect(mean).toBeGreaterThan(0);
        expect(cv).toBeLessThan(0.02);
    }, 120_000);
});
