import { describe, it, expect } from 'vitest';
import {
    analyzeDecodedFrames,
    blockinessRatio,
    frameMse,
    worstBlockPsnr,
    VideoQAError
} from '../src/node/video/GenerativeVideoQAService';

const W = 32;
const H = 16;

function frame(fn: (x: number, y: number) => [number, number, number]): Uint8Array {
    const out = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const [r, g, b] = fn(x, y);
            const i = (y * W + x) * 3;
            out[i] = r; out[i + 1] = g; out[i + 2] = b;
        }
    }
    return out;
}

/** Smooth gradient: same step between every neighbour, boundary or not. */
const smooth = () => frame((x, y) => { const v = x * 3 + y * 3; return [v, v, v]; });
/** Piecewise-constant 8×8 blocks with a smooth ramp inside: discontinuities sit on the 8-px grid. */
const blocky = () => frame((x, y) => {
    const v = Math.floor(x / 8) * 40 + Math.floor(y / 8) * 30 + (x % 8) + (y % 8);
    return [v, v, v];
});

describe('GenerativeVideoQAService metrics from decoded frames', () => {
    it('blockiness is ~1 for a smooth gradient and large for 8x8 block discontinuities', () => {
        const s = blockinessRatio(smooth(), W, H)!;
        const b = blockinessRatio(blocky(), W, H)!;
        expect(s).toBeGreaterThan(0.9);
        expect(s).toBeLessThan(1.1);
        expect(b).toBeGreaterThan(10);
        expect(blockinessRatio(frame(() => [50, 50, 50]), W, H)).toBeNull();
    });

    it('worst-block PSNR finds the one 8x8 block that changed, at its 2-D grid position', () => {
        const a = smooth();
        const b = Uint8Array.from(a);
        // Perturb only block (bx=2, by=1): pixels x 16..23, y 8..15.
        for (let y = 8; y < 16; y++) for (let x = 16; x < 24; x++) b[(y * W + x) * 3] ^= 0x10;
        const wb = worstBlockPsnr(a, b, W, H);
        expect(wb.blockX).toBe(2);
        expect(wb.blockY).toBe(1);
        // Block MSE: one channel of three changed by 16 -> 256/3.
        expect(wb.db).toBeCloseTo(10 * Math.log10(65025 / (256 / 3)), 6);
        // Whole-frame MSE is diluted by the 7 untouched blocks.
        expect(frameMse(a, b)).toBeCloseTo((256 / 3) / 8, 6);
    });

    it('PSNR is measured between consecutive frames, not first-vs-last', async () => {
        const a = smooth();
        const b = Uint8Array.from(a).map(v => Math.min(255, v + 10));
        // a -> b -> a: first and last frames are identical, but each consecutive pair differs.
        const r = await analyzeDecodedFrames([{ data: a }, { data: b }, { data: Uint8Array.from(a) }], W, H);
        expect(r.frameCount).toBe(3);
        expect(r.temporalPsnr.minDb).toBeLessThan(40);
        expect(r.temporalPsnr.minDb).toBeGreaterThan(20);
        expect(r.temporalPsnr.worstFrameIndex).toBeGreaterThanOrEqual(1);
        expect(r.deltaSpike.maxDelta).toBeGreaterThan(0);
    });

    it('colour drift is measured against frame 0, not against neutral 128', async () => {
        const dark = frame(() => [20, 20, 20]);
        const r = await analyzeDecodedFrames([{ data: dark }, { data: Uint8Array.from(dark) }], W, H, { colorDriftMax: 2 });
        // A static dark video has zero drift (the old metric reported |20-128| = 108 DN "bias").
        expect(r.colorDrift.maxChannel).toBe(0);
        expect(r.gates.find(g => g.metric === 'colorDrift.maxChannel')!.passed).toBe(true);

        const shifted = frame(() => [20, 26, 20]);
        const r2 = await analyzeDecodedFrames([{ data: dark }, { data: shifted }], W, H, { colorDriftMax: 2 });
        expect(r2.colorDrift.g).toBeCloseTo(6, 6);
        expect(r2.colorDrift.r).toBe(0);
        expect(r2.passed).toBe(false);
    });

    it('only gates metrics a threshold was given for', async () => {
        const r = await analyzeDecodedFrames([{ data: blocky() }, { data: blocky() }], W, H);
        expect(r.gates.map(g => g.metric)).toEqual(['deltaSpike.maxDelta']);
        expect(r.passed).toBe(true);
        const gated = await analyzeDecodedFrames([{ data: blocky() }, { data: blocky() }], W, H, { blockinessMax: 1.5 });
        expect(gated.passed).toBe(false);
        expect(gated.blockiness.max!).toBeGreaterThan(10);
    });

    it('throws typed errors for too few frames and wrong frame sizes', async () => {
        await expect(analyzeDecodedFrames([{ data: smooth() }], W, H)).rejects.toMatchObject({ name: 'VideoQAError', code: 'VIDEO_QA_TOO_FEW_FRAMES' });
        await expect(analyzeDecodedFrames([{ data: new Uint8Array(10) }, { data: new Uint8Array(10) }], W, H)).rejects.toBeInstanceOf(VideoQAError);
    });
});
