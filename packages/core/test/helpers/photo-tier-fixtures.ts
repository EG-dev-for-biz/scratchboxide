/**
 * A synthetic planar facade for photo tier A (photo-tier-rectify.ts): a 12 m x 9 m wall facing south (+z) with a repeated
 * stone coursing (blocks 0.6 x 0.3 m, staggered; per-block tone, fine grain and a few dark marks so features are unique), a
 * statue standing 1.2 m proud of its lower right, and, in the photos only, a van parked 8 m in front. Photos are ray cast
 * through the Maps Imagery Grounding camera (castCamera: fx = 960 / tan(fov / 2) at the delivered crop) from the TRUE
 * pose; the views handed to the tier carry a perturbed (registered) pose, as the pipeline's do.
 */
import type { Vec3 } from '../../src/common/spatial/staged-location-contracts';
import type { DecodedImage, PinholeCamera, ProjectionView, UvAtlas } from '../../src/common/spatial/texture-pass-contracts';
import type { RenderMesh3D } from '../../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { castCamera } from '../../src/node/3d-engine/staged-location/survey-casting';
import { groundingRequestFovDeg, type PoseCorrection } from '../../src/node/spatial/StreetViewPoseRegistrar';

export const WALL = { x0: -6, x1: 6, y0: 0, y1: 9, z: 0, depthM: 1 };
export const STATUE = { x0: 2, x1: 3.5, y0: 0, y1: 2.5, z0: 0, z1: 1.2 };
export const VAN = { x0: -3.6, x1: -2.4, y0: 0, y1: 1.5, z0: 8, z1: 9 };
export const SKY: Vec3 = [175, 205, 235];
export const VAN_RGB: Vec3 = [120, 22, 24];
const STATUE_RGB: Vec3 = [96, 74, 40];

function hash(i: number, j: number, seed: number): number {
    let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number, seed: number): number {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(i, j, seed), b = hash(i + 1, j, seed), c = hash(i, j + 1, seed), d = hash(i + 1, j + 1, seed);
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Wall albedo (sRGB 0..255) at wall coordinates a (m from the left edge), b (m from the bottom). `seed` changes the stones. */
export function wallAlbedo(a: number, b: number, seed = 1): Vec3 {
    const course = Math.floor(b / 0.3);
    const off = course % 2 ? 0.3 : 0;
    const block = Math.floor((a + off) / 0.6);
    const ja = (a + off) - block * 0.6, jb = b - course * 0.3;
    const grain = (valueNoise(a / 0.05, b / 0.05, seed + 7) - 0.5) * 26 + (valueNoise(a / 0.17, b / 0.17, seed + 11) - 0.5) * 18;
    if (ja < 0.018 || ja > 0.582 || jb < 0.018 || jb > 0.282) return [70 + grain * 0.3, 64 + grain * 0.3, 58 + grain * 0.3];
    // a dark mark in some blocks (unique features)
    const hm = hash(block, course, seed + 3);
    if (hm < 0.18) {
        const ca = 0.12 + 0.36 * hash(block, course, seed + 5), cb = 0.08 + 0.14 * hash(block, course, seed + 9);
        if (Math.hypot(ja - ca, jb - cb) < 0.05 + 0.04 * hm) return [60, 52, 46];
    }
    const tone = 150 + 60 * hash(block, course, seed);
    const warm = 12 * (hash(block, course, seed + 1) - 0.5);
    return [tone + warm + grain, tone + grain * 0.95, tone - warm - 8 + grain * 0.9];
}

/** The wall albedo averaged over a square of side `s` (m) centred at (a, b): what a texel of that size should hold. */
export function wallAlbedoBox(a: number, b: number, s: number, seed = 1): Vec3 {
    const n = 4; const out: Vec3 = [0, 0, 0];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const c = wallAlbedo(a + ((i + 0.5) / n - 0.5) * s, b + ((j + 0.5) / n - 0.5) * s, seed);
        out[0] += c[0]; out[1] += c[1]; out[2] += c[2];
    }
    return [out[0] / (n * n), out[1] / (n * n), out[2] / (n * n)];
}

type Box = { x0: number; x1: number; y0: number; y1: number; z0: number; z1: number };
const WALL_BOX: Box = { x0: WALL.x0, x1: WALL.x1, y0: WALL.y0, y1: WALL.y1, z0: WALL.z - WALL.depthM, z1: WALL.z };
const STATUE_BOX: Box = STATUE;

function rayBox(o: Vec3, d: Vec3, b: Box): { t: number; face: number } | null {
    let t0 = -Infinity, t1 = Infinity, face = -1;
    const lo = [b.x0, b.y0, b.z0], hi = [b.x1, b.y1, b.z1];
    for (let k = 0; k < 3; k++) {
        if (Math.abs(d[k]) < 1e-12) { if (o[k] < lo[k] || o[k] > hi[k]) return null; continue; }
        let ta = (lo[k] - o[k]) / d[k], tb = (hi[k] - o[k]) / d[k];
        if (ta > tb) [ta, tb] = [tb, ta];
        // the entry face: the low side when the ray runs up the axis, the high side when it runs down
        if (ta > t0) { t0 = ta; face = d[k] > 0 ? k * 2 : k * 2 + 1; }
        t1 = Math.min(t1, tb);
    }
    return t0 <= t1 && t0 > 0 ? { t: t0, face } : null;
}

export interface SceneOptions { van?: boolean; seed?: number }

function shade(o: Vec3, d: Vec3, opts: SceneOptions): Vec3 {
    let best: { t: number; rgb: () => Vec3 } | null = null;
    const consider = (t: number, rgb: () => Vec3) => { if (!best || t < best.t) best = { t, rgb }; };
    const w = rayBox(o, d, WALL_BOX);
    if (w) consider(w.t, () => {
        if (w.face === 5) { const p = [o[0] + d[0] * w.t, o[1] + d[1] * w.t]; return wallAlbedo(p[0] - WALL.x0, p[1] - WALL.y0, opts.seed ?? 1); }
        return [120, 118, 112];
    });
    const s = rayBox(o, d, STATUE_BOX);
    if (s) consider(s.t, () => { const p = [o[0] + d[0] * s.t, o[1] + d[1] * s.t, o[2] + d[2] * s.t]; const g = (valueNoise(p[0] / 0.08 + p[2] * 9, p[1] / 0.08, 21) - 0.5) * 40; return [STATUE_RGB[0] + g, STATUE_RGB[1] + g, STATUE_RGB[2] + g * 0.6]; });
    if (opts.van) { const v = rayBox(o, d, VAN); if (v) consider(v.t, () => VAN_RGB); }
    return best ? (best as { rgb: () => Vec3 }).rgb() : SKY;
}

/** Ray casts the scene through a camera (2 x 2 supersampled). */
export function renderPhoto(cam: PinholeCamera, opts: SceneOptions = {}): DecodedImage {
    const { width: W, height: H } = cam;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const acc = [0, 0, 0];
        for (const [sx, sy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
            const xc = (x + sx - cam.cx) / cam.fx, yc = -(y + sy - cam.cy) / cam.fy;
            const d: Vec3 = [cam.fwd[0] + xc * cam.right[0] + yc * cam.up[0], cam.fwd[1] + xc * cam.right[1] + yc * cam.up[1], cam.fwd[2] + xc * cam.right[2] + yc * cam.up[2]];
            const c = shade(cam.eye, d, opts);
            acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
        }
        const o = (y * W + x) * 4;
        rgba[o] = Math.max(0, Math.min(255, Math.round(acc[0] / 4))); rgba[o + 1] = Math.max(0, Math.min(255, Math.round(acc[1] / 4)));
        rgba[o + 2] = Math.max(0, Math.min(255, Math.round(acc[2] / 4))); rgba[o + 3] = 255;
    }
    return { width: W, height: H, rgba };
}

function boxTriangles(b: Box, v: number[], idx: number[]): void {
    const base = v.length / 3;
    for (let k = 0; k < 8; k++) v.push(k & 1 ? b.x1 : b.x0, k & 2 ? b.y1 : b.y0, k & 4 ? b.z1 : b.z0);
    const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
    for (const [a, b2, c, d] of quads) idx.push(base + a, base + b2, base + c, base + a, base + c, base + d);
}

/** The tile mesh: the wall box and the statue (the van is not in it, as a parked van is not in a tile). Optionally a wall so big the frame shows no outline. */
export function sceneMesh(opts: { statue?: boolean; huge?: boolean } = {}): RenderMesh3D {
    const v: number[] = [], idx: number[] = [];
    boxTriangles(opts.huge ? { x0: -80, x1: 80, y0: -40, y1: 80, z0: -1, z1: 0 } : WALL_BOX, v, idx);
    if (opts.statue !== false) boxTriangles(STATUE_BOX, v, idx);
    return { vertices: Float32Array.from(v), indices: Uint32Array.from(idx) };
}

/** The fitted face's atlas: one plane chart over the wall at `density` texels/m. */
export function wallAtlas(density = 30): UvAtlas {
    const W = Math.round((WALL.x1 - WALL.x0) * density), H = Math.round((WALL.y1 - WALL.y0) * density), n = W * H;
    const position = new Float32Array(n * 3), normal = new Float32Array(n * 3), sizeM = new Float32Array(n);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        position.set([WALL.x0 + (x + 0.5) / density, WALL.y1 - (y + 0.5) / density, WALL.z], i * 3);
        normal.set([0, 0, 1], i * 3); sizeM[i] = 1 / density;
    }
    return {
        layerKey: 'l3b', width: W, height: H,
        maps: [{ nodeName: 'wall', kind: 'chart-plane', texelsPerMeter: density, atlasRect: [0, 0, 1, 1], chartId: 's00' }],
        texels: { covered: new Uint8Array(n).fill(1), gutter: new Uint8Array(n), mapIndex: new Uint16Array(n), position, normal, sizeM }
    };
}

export const WALL_SURFACES = [{ id: 's00', chart: { plane: { origin: [WALL.x0, WALL.y0, WALL.z] as Vec3, u: [1, 0, 0] as Vec3, v: [0, 1, 0] as Vec3, normal: [0, 0, 1] as Vec3, extentUv: [[0, 0], [12, 0], [12, 9], [0, 9]] as Array<[number, number]> } } }];

export interface PanoSpec { panoId: string; eye: Vec3; date: string; correction: PoseCorrection; narrow?: boolean; wide?: boolean; seed?: number; narrowTargets?: Vec3[] }

function aim(eye: Vec3, target: Vec3): { headingDeg: number; pitchDeg: number } {
    const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
    return { headingDeg: ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360, pitchDeg: (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI };
}

export interface RenderedView { view: ProjectionView; trueCamera: PinholeCamera; kind: 'wide' | 'narrow' }

/**
 * Renders a pano's views: a wide 4:3 crop (1024 x 768, a 0.6 downscale of 1707 x 1280) of the whole wall and narrow 1:1 crops
 * (768 x 768) of the left and right halves, requested with the grounding API's fov for those crops.
 */
export function panoViews(p: PanoSpec, opts: SceneOptions = {}): RenderedView[] {
    const out: RenderedView[] = [];
    const mk = (target: Vec3, trueHfov: number, aspect: number, W: number, H: number, kind: 'wide' | 'narrow') => {
        const a = aim(p.eye, target);
        const fovDeg = groundingRequestFovDeg(trueHfov, aspect);
        const base = { eye: p.eye, headingDeg: a.headingDeg, pitchDeg: a.pitchDeg, fovDeg, widthPx: W, heightPx: H };
        const trueCamera = castCamera(base);
        const registered = castCamera({ ...base, correction: { ...p.correction, referenceHeadingDeg: 0 } });
        const image = renderPhoto(trueCamera, { ...opts, seed: p.seed ?? opts.seed });
        out.push({ kind, trueCamera, view: { panoId: p.panoId, camera: registered, image, poseQuality: 1, poseSigmaPx: 2, captureDate: p.date } });
    };
    if (p.wide !== false) mk([0, 4.5, 0], 42, 4 / 3, 1024, 768, 'wide');
    if (p.narrow !== false) for (const t of p.narrowTargets ?? [[-3, 4.5, 0] as Vec3, [3, 4.5, 0] as Vec3]) mk(t, 17, 1, 768, 768, 'narrow');
    return out;
}

export const PANOS: PanoSpec[] = [
    { panoId: 'PANO_LEFT_000000000001', eye: [-6, 1.7, 22], date: '2019-05', correction: { dx: 0.3, dy: 0, dz: 0, dyawDeg: 0.5, dpitchDeg: -0.3, drollDeg: 0 } },
    { panoId: 'PANO_MID_0000000000002', eye: [2, 1.7, 25], date: '2021-08', correction: { dx: 0, dy: 0, dz: 0.5, dyawDeg: -0.4, dpitchDeg: 0.2, drollDeg: 0 } },
    { panoId: 'PANO_RIGHT_00000000003', eye: [9, 1.7, 21], date: '2022-10', correction: { dx: 0, dy: 0, dz: 0, dyawDeg: 0.3, dpitchDeg: 0.4, drollDeg: 0 } },
    { panoId: 'PANO_FAR_0000000000004', eye: [-1, 1.7, 28], date: '2023-06', correction: { dx: -0.2, dy: 0, dz: 0, dyawDeg: -0.6, dpitchDeg: 0, drollDeg: 0 } }
];

/** An old capture: the stones were different (another seed), and only a narrow view with no outline in it. */
export const OLD_PANO: PanoSpec = { panoId: 'PANO_OLD_0000000000005', eye: [4, 1.7, 24], date: '2009-07', correction: { dx: 0, dy: 0, dz: 0, dyawDeg: 0.2, dpitchDeg: 0, drollDeg: 0 }, wide: false, narrowTargets: [[0, 4.5, 0]], seed: 99 };

/** A tile sampler: the wall blurred over 15 cm (a photogrammetric tile is soft), nothing off the wall. */
export function blurredTile(): { sample(p: Vec3, n: Vec3, maxD: number): { rgb: Vec3; distanceM: number; cosNormal: number } | undefined } {
    return {
        sample(p: Vec3) {
            if (Math.abs(p[2] - WALL.z) > 0.05 || p[0] < WALL.x0 || p[0] > WALL.x1 || p[1] < WALL.y0 || p[1] > WALL.y1) return undefined;
            return { rgb: wallAlbedoBox(p[0] - WALL.x0, p[1] - WALL.y0, 0.15), distanceM: 0, cosNormal: 1 };
        }
    };
}
