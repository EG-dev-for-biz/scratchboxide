/**
 * The texture tiers' de-light caps the shadow lift by local contrast (delightLinearPlane), so a genuinely dark surface
 * (a window opening in a lit wall) keeps its darkness while a face in shade is still lifted; the browser shader's
 * per-fragment function (delightLinearRgb) is unchanged.
 */
import { describe, expect, it } from 'vitest';
import {
    delightLinearPlane, delightLinearRgb, PHOTOGRAMMETRIC_DELIGHT, TEXTURE_LIFT_CAP
} from '../src/common/spatial/photogrammetric-delight';

const W = 120, H = 60;
const WALL = 0.42, WINDOW = 0.025, SHADE = 0.05;
/** Left half: a lit wall with a 10 x 16 texel dark window opening. Right half: the same wall entirely in shade. */
function scene(): { rgb: Float64Array; has: Uint8Array; windowTexel: number; shadeTexel: number; wallTexel: number } {
    const rgb = new Float64Array(W * H * 3), has = new Uint8Array(W * H).fill(1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inWindow = x >= 25 && x < 35 && y >= 22 && y < 38;
        const v = x >= W / 2 ? SHADE : inWindow ? WINDOW : WALL;
        rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = v;
    }
    return { rgb, has, windowTexel: 30 * W + 30, shadeTexel: 30 * W + 90, wallTexel: 10 * W + 10 };
}

describe('texture de-light lift cap', () => {
    it('keeps a dark window opening dark and still lifts a face in shade', () => {
        const s = scene();
        // 0.05 m texels: TEXTURE_LIFT_CAP's 1.5 m neighbourhood is 30 texels
        const report = delightLinearPlane(s.rgb, s.has, W, H, PHOTOGRAMMETRIC_DELIGHT.defaults, { radiusTexels: TEXTURE_LIFT_CAP.radiusM / 0.05, contrastGain: TEXTURE_LIFT_CAP.contrastGain });
        const uncappedWindow = delightLinearRgb(WINDOW, WINDOW, WINDOW)[0];
        const uncappedShade = delightLinearRgb(SHADE, SHADE, SHADE)[0];
        // the window: inside a lit wall its local darkness is ~0.9, so (gain 2) the lift is gone: it stays at its own value
        expect(uncappedWindow).toBeGreaterThan(WINDOW * 3); // what the uncapped lift would do: toward grey
        expect(Math.abs(s.rgb[s.windowTexel * 3] - WINDOW)).toBeLessThan(0.01);
        // the shaded face: uniform darkness, no local contrast at its centre: the full shader lift
        expect(s.rgb[s.shadeTexel * 3]).toBeCloseTo(uncappedShade, 6);
        // the lit wall is above the shadow ramp: unchanged by either
        expect(s.rgb[s.wallTexel * 3]).toBeCloseTo(delightLinearRgb(WALL, WALL, WALL)[0], 6);
        expect(report.texels).toBe(W * H);
        expect(report.liftHalvedTexels).toBeGreaterThanOrEqual(10 * 16);
        expect(report.meanLiftKept).toBeGreaterThan(0.5); // most dark texels are the shaded face, lifted
        expect(report.meanLiftKept).toBeLessThan(1);
    });

    it('is continuous in local contrast (no threshold) and exactly the shader function without a cap', () => {
        const kept: number[] = [];
        for (const dark of [0.40, 0.20, 0.10, 0.06, 0.04]) {
            const rgb = new Float64Array(W * H * 3).fill(dark), has = new Uint8Array(W * H).fill(1);
            // a 10 x 10 patch at 0.03 inside a field of `dark`
            for (let y = 25; y < 35; y++) for (let x = 55; x < 65; x++) rgb.fill(0.03, (y * W + x) * 3, (y * W + x) * 3 + 3);
            delightLinearPlane(rgb, has, W, H, PHOTOGRAMMETRIC_DELIGHT.defaults, { radiusTexels: 30, contrastGain: 1 });
            const full = delightLinearRgb(0.03, 0.03, 0.03)[0];
            kept.push((rgb[(30 * W + 60) * 3] - 0.03) / (full - 0.03));
        }
        // the darker the surroundings, the less the patch stands out, the more of the lift it keeps; monotone
        for (let k = 1; k < kept.length; k++) expect(kept[k]).toBeGreaterThan(kept[k - 1]);
        expect(kept[0]).toBeLessThan(0.15);
        expect(kept[kept.length - 1]).toBeGreaterThan(0.6);

        const s = scene();
        const copy = Float64Array.from(s.rgb);
        delightLinearPlane(s.rgb, s.has, W, H);
        for (let i = 0; i < W * H; i += 37) {
            const e = delightLinearRgb(copy[i * 3], copy[i * 3 + 1], copy[i * 3 + 2]);
            for (let c = 0; c < 3; c++) expect(s.rgb[i * 3 + c]).toBeCloseTo(e[c], 12);
        }
    });
});
