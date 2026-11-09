import { describe, expect, it } from 'vitest';
import { frameCamera, PLATE_EMPTY_DEPTH, ZERO_CORRECTION, type FrameCamera, type PoseCorrection } from '../src/node/spatial/StreetViewPoseRegistrar';
import { correctionFromPose, covisibility, liftThroughDepth, poseFromCorrection } from '../src/node/3d-engine/staged-location/pano-drive-registration';
import { posedCamera, type V3 } from '../src/node/spatial/street-view-drive-registration';

const near = (a: number[], b: number[], tol: number) => a.forEach((x, i) => expect(Math.abs(x - b[i])).toBeLessThan(tol));

describe('pano-drive-registration', () => {
    it('turns a correction into a drive pose and back, the cameras unchanged at every heading', () => {
        const eye: V3 = [3, 2.5, -7];
        for (const corr of [
            { dx: 1.2, dy: -0.4, dz: 2.1, dyawDeg: 1.7, dpitchDeg: -0.8, drollDeg: 0.6, referenceHeadingDeg: 40 },
            { dx: -6, dy: -2, dz: 3, dyawDeg: -3.2, dpitchDeg: 1.1, drollDeg: -1.4 }
        ] as PoseCorrection[]) {
            const ref = corr.referenceHeadingDeg ?? 75;
            const pose = poseFromCorrection(eye, corr, ref);
            const back = correctionFromPose(eye, pose);
            for (const h of [0, 75, 160, 290]) {
                const a = frameCamera(eye, h, 5, 90, 640, 640, corr, corr.referenceHeadingDeg ?? ref);
                const b = frameCamera(eye, h, 5, 90, 640, 640, back, 0);
                const n = frameCamera(eye, h, 5, 90, 640, 640, ZERO_CORRECTION, 0);
                const viaPose = posedCamera({ right: n.right, up: n.up, fwd: n.fwd, fx: n.fx, fy: n.fy, cx: n.cx, cy: n.cy, width: 640, height: 640 }, pose);
                for (const k of ['eye', 'right', 'up', 'fwd'] as const) {
                    near(b[k], a[k], 1e-9);
                    near(viaPose[k], a[k], 1e-9);
                }
            }
        }
    });

    it('lifts a render pixel through its depth and refuses depth steps', () => {
        const cam = frameCamera([0, 2, 0], 0, 0, 90, 64, 64, ZERO_CORRECTION, 0);
        const depth = new Float32Array(64 * 64).fill(10);
        for (let y = 0; y < 64; y++) for (let x = 40; x < 64; x++) depth[y * 64 + x] = 25;
        const X = liftThroughDepth({ cam, depth, width: 64, height: 64 }, 20.5, 32.5)!;
        // camera faces north (-z): the point is 10 m ahead
        expect(X[2]).toBeCloseTo(-10, 6);
        expect(liftThroughDepth({ cam, depth, width: 64, height: 64 }, 40.2, 32.5)).toBeNull();
    });

    it('measures how much of one view\'s surface another view sees', () => {
        // a wall 10 m north; view a from x = 0, view b from x = 4 looking the same way, view c looking south
        const wallDepth = (cam: FrameCamera) => {
            const d = new Float32Array(cam.width * cam.height);
            for (let y = 0; y < cam.height; y++) for (let x = 0; x < cam.width; x++) {
                const dir = [0, 1, 2].map(i => cam.fwd[i] + cam.right[i] * (x + 0.5 - cam.cx) / cam.fx + cam.up[i] * (cam.cy - y - 0.5) / cam.fy);
                const t = dir[2] < -1e-6 ? (-10 - cam.eye[2]) / dir[2] : -1;
                d[y * cam.width + x] = t > 0 ? t * (dir[0] * cam.fwd[0] + dir[1] * cam.fwd[1] + dir[2] * cam.fwd[2]) : PLATE_EMPTY_DEPTH;
            }
            return d;
        };
        const mk = (eye: V3, h: number) => { const cam = frameCamera(eye, h, 0, 90, 128, 128, ZERO_CORRECTION, 0); return { cam, depth: wallDepth(cam), width: 128, height: 128 }; };
        const a = mk([0, 2, 0], 0), b = mk([4, 2, 0], 0), c = mk([0, 2, 0], 180);
        const ab = covisibility(a, b, 0);
        expect(ab).toBeGreaterThan(0.5);
        expect(ab).toBeLessThan(1);
        expect(covisibility(a, c, 0)).toBe(0);
    });
});
