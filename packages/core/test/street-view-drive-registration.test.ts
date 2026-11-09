import { describe, expect, it } from 'vitest';
import {
    DrivePano, DrivePose, DriveScanMatch, DriveTie, DriveView, V3,
    posedCamera, poseTurnDeg, registerDriveOnScan, rotationFromVector, scanResidualsByView, vectorFromRotation
} from '../src/node/spatial/street-view-drive-registration';

/**
 * A synthetic street canyon (walls at x = -10 and x = +10, 25 m tall), five panoramas along it whose true poses are off
 * their stated ones by up to 2 m and 1.2 degrees, each differently. Each panorama's scan matches lie on one wall only
 * (the 7th Ave failure: one facade lets a wrong pose fit it), 15% of them wrong; the photo-to-photo ties cover both.
 */
function rng(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const DEG = Math.PI / 180;

function view(h: number): DriveView {
    const f: V3 = [Math.sin(h * DEG), 0, -Math.cos(h * DEG)];
    const r: V3 = [-f[2], 0, f[0]];
    const u: V3 = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return { right: r, up: u, fwd: f, fx: 320, fy: 320, cx: 320, cy: 320, width: 640, height: 640 };
}

function project(p: DrivePano, pose: DrivePose, vi: number, X: V3): [number, number] | null {
    const c = posedCamera(p.views[vi], pose);
    const d: V3 = [X[0] - c.eye[0], X[1] - c.eye[1], X[2] - c.eye[2]];
    const z = d[0] * c.fwd[0] + d[1] * c.fwd[1] + d[2] * c.fwd[2];
    if (z < 1) return null;
    const u = c.cx + c.fx * (d[0] * c.right[0] + d[1] * c.right[1] + d[2] * c.right[2]) / z;
    const v = c.cy - c.fy * (d[0] * c.up[0] + d[1] * c.up[1] + d[2] * c.up[2]) / z;
    return u >= 0 && u < 640 && v >= 0 && v < 640 ? [u, v] : null;
}

function scene(seed = 7) {
    const rand = rng(seed);
    const views = Array.from({ length: 12 }, (_, i) => view(i * 30));
    const offsets: Array<{ d: V3; w: V3 }> = [
        { d: [1.5, -0.6, 1.0], w: [0.004, 0.012, -0.006] },
        { d: [-1.2, 0.4, 2.0], w: [-0.008, -0.015, 0.003] },
        { d: [0.8, -1.0, -1.5], w: [0.006, 0.02, 0.005] },
        { d: [-2.0, 0.2, 0.5], w: [-0.003, -0.01, -0.008] },
        { d: [1.0, 0.8, -2.0], w: [0.01, 0.005, 0.004] }
    ];
    const panos: DrivePano[] = offsets.map((_, i) => ({ panoId: `p${i}`, eye: [(i % 2 ? 1.5 : -1.5), 2.5, -30 + 15 * i] as V3, views }));
    const truth: DrivePose[] = panos.map((p, i) => ({ eye: [p.eye[0] + offsets[i].d[0], p.eye[1] + offsets[i].d[1], p.eye[2] + offsets[i].d[2]], omega: offsets[i].w }));
    const wallPoint = (side: number): V3 => [side * 10, 0.5 + rand() * 24, -70 + rand() * 140];
    const noise = () => (rand() - 0.5) * 0.8;
    const ties: DriveTie[] = [];
    for (let k = 0; k < 2500; k++) {
        const X = wallPoint(rand() < 0.5 ? -1 : 1);
        const a = Math.floor(rand() * 5); let b = Math.floor(rand() * 5); if (b === a) b = (a + 1) % 5;
        const va = Math.floor(rand() * 12), vb = Math.floor(rand() * 12);
        const pa = project(panos[a], truth[a], va, X), pb = project(panos[b], truth[b], vb, X);
        if (!pa || !pb) continue;
        ties.push({ a: { pano: a, view: va, u: pa[0] + noise(), v: pa[1] + noise() }, b: { pano: b, view: vb, u: pb[0] + noise(), v: pb[1] + noise() } });
    }
    const scan: DriveScanMatch[] = [];
    for (let i = 0; i < 5; i++) {
        const side = i % 2 ? 1 : -1; // one wall per panorama
        let made = 0;
        for (let k = 0; k < 20000 && made < 300; k++) {
            const X = wallPoint(side); const vi = Math.floor(rand() * 12);
            const p = project(panos[i], truth[i], vi, X); if (!p) continue;
            made++;
            const wrong = rand() < 0.15;
            scan.push({ pano: i, view: vi, u: wrong ? rand() * 640 : p[0] + noise(), v: wrong ? rand() * 640 : p[1] + noise(), X });
        }
    }
    return { panos, truth, ties, scan };
}

const posErr = (a: DrivePose, b: DrivePose) => Math.hypot(a.eye[0] - b.eye[0], a.eye[1] - b.eye[1], a.eye[2] - b.eye[2]);
const rotErrDeg = (a: DrivePose, b: DrivePose) => {
    const Ra = rotationFromVector(a.omega), Rb = rotationFromVector(b.omega);
    const RbT = [Rb[0], Rb[3], Rb[6], Rb[1], Rb[4], Rb[7], Rb[2], Rb[5], Rb[8]];
    const M = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) M[i * 3 + j] += Ra[i * 3 + k] * RbT[k * 3 + j];
    return Math.hypot(...vectorFromRotation(M)) / DEG;
};

describe('street-view-drive-registration', () => {
    it('round-trips rotation vectors and reads a pure heading turn as yaw', () => {
        const w: V3 = [0.1, -0.2, 0.05];
        const back = vectorFromRotation(rotationFromVector(w));
        back.forEach((x, i) => expect(x).toBeCloseTo(w[i], 9));
        const t = poseTurnDeg({ eye: [0, 0, 0], omega: [0, -2 * DEG, 0] });
        expect(t.yawDeg).toBeCloseTo(2, 6);
        expect(Math.abs(t.pitchDeg)).toBeLessThan(1e-6);
    });

    it('recovers every panorama of a drive whose scan matches each lie on one wall', () => {
        const { panos, truth, ties, scan } = scene();
        const r = registerDriveOnScan(panos, ties, scan);
        const statedErr = panos.map((p, i) => posErr({ eye: p.eye, omega: [0, 0, 0] }, truth[i]));
        expect(Math.min(...statedErr)).toBeGreaterThan(1);
        r.joint.poses.forEach((p, i) => {
            expect(posErr(p, truth[i])).toBeLessThan(0.1);
            expect(rotErrDeg(p, truth[i])).toBeLessThan(0.1);
        });
        expect(r.joint.scanInliers).toBeGreaterThan(r.stated.scanInliers);
        // every view that has scan matches lands within 3 px for most of them
        const byView = scanResidualsByView(panos, r.joint.poses, scan);
        for (const pv of byView) for (const v of pv) if (v.n >= 10) expect(v.within).toBeGreaterThan(0.7);
    });

    it('places a panorama with no scan matches from its ties to the rest of the drive', () => {
        const { panos, truth, ties, scan } = scene(11);
        const held = 2;
        const r = registerDriveOnScan(panos, ties, scan.filter(m => m.pano !== held));
        expect(posErr(r.joint.poses[held], truth[held])).toBeLessThan(0.2);
        expect(rotErrDeg(r.joint.poses[held], truth[held])).toBeLessThan(0.15);
        const heldRes = scanResidualsByView(panos, r.joint.poses, scan.filter(m => m.pano === held))[held];
        const statedRes = scanResidualsByView(panos, panos.map(p => ({ eye: p.eye, omega: [0, 0, 0] as V3 })), scan.filter(m => m.pano === held))[held];
        const share = (rs: typeof heldRes) => rs.filter(v => v.n).reduce((a, v) => a + v.within * v.n, 0) / rs.reduce((a, v) => a + v.n, 0);
        expect(share(heldRes)).toBeGreaterThan(0.75);
        expect(share(statedRes)).toBeLessThan(0.2);
    });
});
