/**
 * Pipeline E: real Street View texels on the walls (street-view-texels.ts). Synthetic: a wall whose texture is a softened
 * copy of the truth (the melted tile ortho), photographed sharp from the street; the step must put the photo's texels
 * back where the photo resolves the wall finer than the tile, colour-matched, labelled, and nowhere else.
 */
import { describe, expect, it } from 'vitest';
import { applyStreetViewTexels, exposureGain, rectifyQualifying, MIN_SHARPER, STREET_VIEW_TEXEL_SOURCE, STREET_VIEW_TEXEL_SOURCE_MULTI } from '../src/node/3d-engine/staged-location/pipeline-e/street-view-texels';
import { streetBandTop, type GuideView } from '../src/node/3d-engine/staged-location/pipeline-e/plate-streetview';
import { baseLegend } from '../src/node/3d-engine/staged-location/pipeline-e/face-textures';
import type { MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import type { FaceTexture } from '../src/node/3d-engine/staged-location/pipeline-e/massing-glb';
import type { PinholeCamera } from '../src/common/spatial/texture-pass-contracts';

const PX = 0.1;
const W = 240, H = 120; // 24 m x 12 m at 0.1 m (10 px/m: the tile's pitch)
type Rgb = [number, number, number];

function truth(): Uint8Array {
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xm = (x + 0.5) * PX, ym = (H - y - 0.5) * PX;
        let c: Rgb = [180, 120, 90];
        const lx = (xm % 2) / 2, ly = (ym % 3) / 3;
        if (lx > 0.35 && lx < 0.65 && ly > 0.25 && ly < 0.75) c = [45, 55, 75];
        if (Math.floor(xm * 5) % 2 === 0 && ym < 0.5) c = [90, 90, 95];
        rgba.set([...c, 255], (y * W + x) * 4);
    }
    return rgba;
}

function soften(src: Uint8Array, r = 4): Uint8Array {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const acc = [0, 0, 0];
        let n = 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
            for (let c = 0; c < 3; c++) acc[c] += src[(yy * W + xx) * 4 + c];
            n++;
        }
        for (let c = 0; c < 3; c++) out[(y * W + x) * 4 + c] = Math.round(acc[c] / n);
        out[(y * W + x) * 4 + 3] = 255;
    }
    return out;
}

function face(): MassingFace {
    return {
        index: 3, key: 'w3', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true, normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0],
        sMin: 0, sMax: W * PX, tMin: 0, tMax: H * PX, tBottom: 0, area: W * H * PX * PX, pixel: PX, orthoSMin: 0, orthoTMax: H * PX, width: W, height: H, coverage: 1, openings: [], top: []
    } as MassingFace;
}

/** A camera at (ex, 1.6, ez) looking at (tx, ty, 0) and its photo of `tex` (the wall), darkened by `expo`, the sky grey. */
function photoOf(tex: Uint8Array, ex: number, ez: number, tx: number, ty: number, expo = 1, f = 700, IW = 960, IH = 640): { camera: PinholeCamera; image: { width: number; height: number; rgba: Uint8Array }; owner: Uint8Array } {
    const eye: [number, number, number] = [ex, 1.6, ez];
    const d = [tx - ex, ty - 1.6, -ez], l = Math.hypot(d[0], d[1], d[2]);
    const fwd: [number, number, number] = [d[0] / l, d[1] / l, d[2] / l];
    const r0 = [-fwd[2], 0, fwd[0]], rl = Math.hypot(r0[0], r0[2]);
    const right: [number, number, number] = [r0[0] / rl, 0, r0[2] / rl];
    const up: [number, number, number] = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const camera: PinholeCamera = { eye, right, up, fwd, fx: f, fy: f, cx: IW / 2, cy: IH / 2, width: IW, height: IH };
    const rgba = new Uint8Array(IW * IH * 4), owner = new Uint8Array(IW * IH);
    for (let v = 0; v < IH; v++) for (let u = 0; u < IW; u++) {
        const a = (u + 0.5 - camera.cx) / f, b = (camera.cy - v - 0.5) / f;
        const dir = [fwd[0] + a * right[0] + b * up[0], fwd[1] + a * right[1] + b * up[1], fwd[2] + a * right[2] + b * up[2]];
        const o = (v * IW + u) * 4;
        rgba.set([150, 160, 175, 255], o);
        if (dir[2] >= -1e-6) continue;
        const k = -eye[2] / dir[2], px = eye[0] + k * dir[0], py = eye[1] + k * dir[1];
        const x = Math.floor(px / PX), y = Math.floor(H - py / PX);
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        for (let c = 0; c < 3; c++) rgba[o + c] = Math.round(tex[(y * W + x) * 4 + c] * expo);
        owner[v * IW + u] = 1;
    }
    return { camera, image: { width: IW, height: IH, rgba }, owner };
}

const guide = (p: ReturnType<typeof photoOf>, panoId: string, method = 'joint', owner = p.owner): GuideView => ({ panoId, camera: p.camera, image: p.image, ownerMask: owner, poseQuality: 1, poseSigmaPx: 1, registration: { method, residualM: 0.2 } });
const texture = (rgba: Uint8Array): FaceTexture => ({ width: W, height: H, rgba: rgba.slice(), source: new Uint8Array(W * H) });
const mad = (a: Uint8Array, b: Uint8Array, keep: (x: number, y: number) => boolean) => {
    let s = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (keep(x, y)) { for (let c = 0; c < 3; c++) s += Math.abs(a[(y * W + x) * 4 + c] - b[(y * W + x) * 4 + c]); n += 3; }
    return s / Math.max(1, n);
};

describe('real Street View texels on a pipeline E wall', () => {
    const T = truth();
    const near = photoOf(T, 12, 9, 12, 4); // 9 m off the wall: about 78 px/m against the tile's 10

    it('a sharp, registered, owned photo puts the truth back where it sees the wall, labelled photo-inferred', () => {
        const tex = texture(soften(T));
        const legend = baseLegend();
        const use = new Uint8Array(W * H).fill(1);
        const before = mad(tex.rgba, T, () => true);
        const r = applyStreetViewTexels(face(), tex, use, [guide(near, 'pano-near')], legend, streetBandTop(face()));
        expect(r.texels).toBeGreaterThan(0.3 * W * H);
        expect(r.panos[0].pxPerM).toBeGreaterThan(MIN_SHARPER * 10);
        const written = (x: number, y: number) => tex.source[y * W + x] !== 0;
        expect(mad(tex.rgba, T, written)).toBeLessThan(0.35 * before);
        const k = legend.findIndex(l => l.source === STREET_VIEW_TEXEL_SOURCE);
        expect(k).toBeGreaterThan(0);
        expect(legend[k].label).toBe('photo-inferred');
        expect(legend[k].rung).toBe(1);
        let n = 0;
        for (let i = 0; i < W * H; i++) if (tex.source[i] === k) n++;
        expect(n).toBe(r.texels);
        // a texel the photo does not reach keeps what it had, byte for byte
        const soft = soften(T);
        for (let i = 0; i < W * H; i++) if (tex.source[i] === 0) for (let c = 0; c < 3; c++) expect(tex.rgba[i * 4 + c]).toBe(soft[i * 4 + c]);
        expect(r.why).toMatch(/joint pose/);
    });

    it('matches the photo\'s exposure to the wall (a darker photo comes back at the wall\'s brightness)', () => {
        const dark = photoOf(T, 12, 9, 12, 4, 0.85); // 0.85 in sRGB is about 0.7 in linear light: a gain of 1.4 brings it back
        const tex = texture(soften(T));
        const use = new Uint8Array(W * H).fill(1);
        const g = exposureGain(rectifyQualifying(face(), guide(dark, 'd')).rgba, rectifyQualifying(face(), guide(dark, 'd')).valid, tex.rgba, use)!;
        expect(g).not.toBeNull();
        for (const c of g) { expect(c).toBeGreaterThan(1.25); expect(c).toBeLessThan(1.6); }
        const r = applyStreetViewTexels(face(), tex, use, [guide(dark, 'pano-dark')], baseLegend(), streetBandTop(face()));
        expect(r.panos[0].gain).not.toBeNull();
        const written = (x: number, y: number) => tex.source[y * W + x] !== 0;
        expect(mad(tex.rgba, T, written)).toBeLessThan(mad(soften(T), T, written));
    });

    it('takes nothing from a nominal pose, a far photo coarser than the tile, or a photo that owns no pixel', () => {
        const far = photoOf(T, 12, 90, 12, 6); // 90 m off: about 8 px/m, coarser than the tile
        for (const [views, why] of [
            [[guide(near, 'nominal', 'nominal')], /registered pose/],
            [[guide(far, 'far')], /finer than the tile/],
            [[guide(near, 'unowned', 'joint', new Uint8Array(near.owner.length))], /registered pose and an ownership mask/]
        ] as Array<[GuideView[], RegExp]>) {
            const tex = texture(soften(T));
            const r = applyStreetViewTexels(face(), tex, new Uint8Array(W * H).fill(1), views, baseLegend(), streetBandTop(face()));
            expect(r.texels).toBe(0);
            expect(r.why).toMatch(why);
            expect(tex.rgba).toEqual(soften(T));
        }
    });

    it('refuses a sharp, owned, registered photo of another wall (its structure does not correlate with this wall)', () => {
        // the same camera, but the wall it photographs is a different building: the pose puts the wrong facade here
        const other = new Uint8Array(T.length);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const xm = (x + 0.5) * PX, ym = (H - y - 0.5) * PX;
            const c: Rgb = ((xm * 0.7 + 1) % 3.1) / 3.1 > 0.5 && ((ym + 1.3) % 2.3) / 2.3 > 0.5 ? [60, 70, 90] : [200, 190, 170];
            other.set([...c, 255], (y * W + x) * 4);
        }
        const wrong = photoOf(other, 12, 9, 12, 4);
        const tex = texture(soften(T));
        const r = applyStreetViewTexels(face(), tex, new Uint8Array(W * H).fill(1), [guide(wrong, 'wrong-wall')], baseLegend(), streetBandTop(face()));
        expect(r.texels).toBe(0);
        expect(r.refused.length).toBe(1);
        expect(r.refused[0].agreement).not.toBeNull();
        expect(r.refused[0].agreement!).toBeLessThan(0.2);
        expect(tex.rgba).toEqual(soften(T));
        // the right wall with a pose error: the photo was taken 0.4 m to the left of where its registered camera says
        const moved = photoOf(T, 12, 9, 12, 4);
        (moved.camera.eye as number[])[0] += 0.4;
        const tex2 = texture(soften(T));
        const r2 = applyStreetViewTexels(face(), tex2, new Uint8Array(W * H).fill(1), [guide(moved, 'moved')], baseLegend(), streetBandTop(face()));
        expect(r2.texels).toBeGreaterThan(0);
        expect(r2.panos[0].agreement).toBeGreaterThan(0.5);
    });

    it('two photos that agree are the multi-view rung; the sharper photo weighs more', () => {
        const left = photoOf(T, 6, 8, 10, 4), right = photoOf(T, 18, 8, 14, 4);
        const tex = texture(soften(T));
        const legend = baseLegend();
        const r = applyStreetViewTexels(face(), tex, new Uint8Array(W * H).fill(1), [guide(left, 'L'), guide(right, 'R')], legend, streetBandTop(face()));
        expect(r.multiTexels).toBeGreaterThan(0);
        const m = legend.findIndex(l => l.source === STREET_VIEW_TEXEL_SOURCE_MULTI);
        expect(legend[m].rung).toBe(0);
        expect(r.panos.map(p => p.texels).reduce((a, b) => a + b, 0)).toBe(r.texels);
    });
});
