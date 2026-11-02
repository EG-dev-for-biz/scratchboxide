/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { labelSplats, renderSplatArm, splatPositions, splatRegions } from '../src/node/3d-engine/staged-location/splat-arm-render';
import { PHOTO_MATCH_AMBIENT, PHOTO_MATCH_BACKGROUND, PHOTO_MATCH_CLAY, PHOTO_MATCH_GROUND_BAND_M, REGION } from '../src/node/3d-engine/staged-location/photo-match-eval';
import { projectSplatEwa } from '../src/common/spatial/splat-ewa-projection';
import type { PinholeCamera } from '../src/common/spatial/texture-pass-contracts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-splat-arm-'));
afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

interface Splat { p: [number, number, number]; s: [number, number, number]; rgb: [number, number, number]; a: number }

/** The native .splat layout: position, scale (float32), RGBA8, quaternion x y z w in [-1, 1] -> [0, 255]; every splat faces +z. */
function writeSplats(file: string, list: Splat[]): void {
    const b = Buffer.alloc(list.length * 32);
    list.forEach((s, i) => {
        const o = i * 32;
        s.p.forEach((v, k) => b.writeFloatLE(v, o + k * 4));
        s.s.forEach((v, k) => b.writeFloatLE(v, o + 12 + k * 4));
        b[o + 24] = s.rgb[0]; b[o + 25] = s.rgb[1]; b[o + 26] = s.rgb[2]; b[o + 27] = Math.round(s.a * 255);
        b[o + 28] = 128; b[o + 29] = 128; b[o + 30] = 128; b[o + 31] = 255;   // identity: local +z is world +z
    });
    fs.writeFileSync(file, b);
}

const toLinear = (c: number) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
const toSrgb = (c: number) => { const x = Math.min(1, Math.max(0, c)); return 255 * (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055); };

// a camera 1.5 m up at the origin looking north (-z); 160 x 120, f = 500 px, so the sheet's 5 cm spacing is 2.5 px at 10 m
// (minified below a pixel, the viewer's EWA opacity compensation leaves a dense sheet a few percent translucent; at
// 2.5 px and the surface layer's 0.75 overlap, under 1%)
const CAM: PinholeCamera = { eye: [0, 1.5, 0], right: [1, 0, 0], up: [0, 1, 0], fwd: [0, 0, -1], fx: 500, fy: 500, cx: 80, cy: 60, width: 160, height: 120 };
const px = (r: { rgba: Uint8Array; width: number }, x: number, y: number) => Array.from(r.rgba.subarray((y * r.width + x) * 4, (y * r.width + x) * 4 + 3));

describe('renderSplatArm', () => {
    // a 2 m x 2 m sheet of surfels 10 m ahead (x -1..1, y 0.5..2.5), red on the left and blue on the right, at the
    // surface layer's spacing and overlap (sigma 0.75 of a 5 cm spacing)
    const sheet = path.join(WORK, 'sheet.splat');
    const list: Splat[] = [];
    const labels: number[] = [];
    for (let x = -1; x <= 1 + 1e-9; x += 0.05) for (let y = 0.5; y <= 2.5 + 1e-9; y += 0.05) {
        list.push({ p: [x, y, -10], s: [0.0375, 0.0375, 0.002], rgb: x < 0 ? [200, 40, 40] : [40, 40, 200], a: 1 });
        labels.push(x < 0 ? 3 : 5);
    }
    writeSplats(sheet, list);

    it('draws the sheet where the pinhole puts it, in its own colours under the judge\'s light, on the judge\'s background', async () => {
        const [r] = await renderSplatArm(sheet, [{ camera: CAM }], { workDir: path.join(WORK, 'w1') });
        expect(r.width).toBe(160);
        expect(r.triangles).toBe(list.length);
        // the sheet spans x 30..130 and y 10..110 (cx + fx x / z, cy - fy y / z, from the camera's height)
        const cov = (x: number, y: number) => r.coverage[y * r.width + x];
        expect(cov(55, 60)).toBeGreaterThan(0.99);
        expect(cov(105, 15)).toBeGreaterThan(0.99);
        // past the edge splats' 3 sigma (5.6 px here) nothing is drawn
        expect(cov(22, 60)).toBe(0);
        expect(cov(80, 118)).toBe(0);
        expect(cov(5, 5)).toBe(0);
        // face on, the headlight term is all but 1: the splat's own colour
        const shade = PHOTO_MATCH_AMBIENT + (1 - PHOTO_MATCH_AMBIENT) * 0.999;
        px(r, 55, 60).forEach((c, k) => expect(Math.abs(c - toSrgb(toLinear([200, 40, 40][k]) * shade))).toBeLessThanOrEqual(2));
        px(r, 105, 60).forEach((c, k) => expect(Math.abs(c - toSrgb(toLinear([40, 40, 200][k]) * shade))).toBeLessThanOrEqual(2));
        expect(px(r, 5, 5)).toEqual(PHOTO_MATCH_BACKGROUND);
    }, 120000);

    it('renders clay in the judge\'s albedo and key light, and labels each pixel by the splat that covers it', async () => {
        const [clay, labelled] = await renderSplatArm(sheet, [{ camera: CAM, clay: true }, { camera: CAM }], { workDir: path.join(WORK, 'w2'), labels: Uint8Array.from(labels), skyLabel: 7 });
        // the key light: behind the camera, raised, a little to its left; the sheet faces the camera (+z)
        const k = [0.35 * -1, 0.7, 0.55], kl = Math.hypot(...k);
        const shade = PHOTO_MATCH_CLAY.ambient + (1 - PHOTO_MATCH_CLAY.ambient) * (k[2] / kl);
        px(clay, 80, 60).forEach((c, i) => expect(Math.abs(c - toSrgb(toLinear(PHOTO_MATCH_CLAY.albedo[i]) * shade))).toBeLessThanOrEqual(2));
        expect(px(clay, 5, 5)).toEqual(PHOTO_MATCH_CLAY.background);
        expect(labelled.regions![60 * 160 + 55]).toBe(3);
        expect(labelled.regions![60 * 160 + 105]).toBe(5);
        expect(labelled.regions![5 * 160 + 5]).toBe(7);
    }, 120000);

    it('hides a pixel\'s label behind an occluder by the judge\'s rule (occluderHides), leaving the colour as drawn', async () => {
        // in front of the sheet (10 m) over the left half: 5 m; over the right half 9.8 m, within the rule's slack (0.25 m + 2%)
        const occluderDepth = Float32Array.from({ length: 160 * 120 }, (_, i) => (i % 160 < 80 ? 5 : 9.8));
        const [open, hidden] = await renderSplatArm(sheet, [{ camera: CAM }, { camera: CAM, occluderDepth }], { workDir: path.join(WORK, 'w2b'), labels: Uint8Array.from(labels), skyLabel: 7 });
        expect(hidden.regions![60 * 160 + 55]).toBe(7);
        expect(hidden.regions![60 * 160 + 105]).toBe(5);
        expect(open.regions![60 * 160 + 55]).toBe(3);
        expect(Array.from(hidden.rgba)).toEqual(Array.from(open.rgba));
    }, 120000);

    it('reads the splats\' centres and labels each by the nearest labelled triangle', async () => {
        const pos = await splatPositions(sheet, path.join(WORK, 'w4'));
        expect(pos.length).toBe(list.length * 3);
        expect(Array.from(pos.slice(0, 3))).toEqual([-1, 0.5, -10]);
        // the wall the sheet was laid on, as two labelled triangles per half (3 for the sheet's red columns, 5 for its blue ones,
        // split half a spacing left of its middle column: x ~ 0, summed to +3e-16 by the loop, is blue), and a far one (8)
        const quad = (x0: number, x1: number) => [x0, 0, -10, x1, 0, -10, x1, 3, -10, x0, 0, -10, x1, 3, -10, x0, 3, -10];
        const soup = { positions: Float32Array.from([...quad(-1.2, -0.025), ...quad(-0.025, 1.2), 0, 0, -30, 1, 0, -30, 0, 1, -30]) };
        const { labels: got, fallback } = labelSplats(pos, soup, Uint8Array.from([3, 3, 5, 5, 8]), 1);
        expect(fallback).toBe(0);
        expect(Array.from(got)).toEqual(labels);
        // nothing within reach: the fallback label, counted
        const far = labelSplats(pos, { positions: Float32Array.from([0, 0, -30, 1, 0, -30, 0, 1, -30]) }, 8, 1, 0.5);
        expect(far.fallback).toBe(list.length);
        expect(far.labels.every(l => l === 1)).toBe(true);
    }, 120000);

    it('projects a splat with the viewer\'s EWA footprint and opacity (splat-ewa-projection.ts)', async () => {
        // one round splat, half opaque, 10 m ahead on the optical axis, tilted 60 degrees from the view so its footprint is an
        // ellipse (sigma 12 px across, 6 px up)
        const one = path.join(WORK, 'one.splat');
        writeSplats(one, [{ p: [0, 1.5, -10], s: [1.2, 1.2, 0.001], rgb: [255, 255, 255], a: 0.5 }]);
        const b = fs.readFileSync(one);
        // rotate it 60 degrees about x: q = (sin 30, 0, 0, cos 30)
        b[28] = Math.round((0.5 * 0.5 + 0.5) * 255); b[31] = Math.round((Math.cos(Math.PI / 6) * 0.5 + 0.5) * 255);
        fs.writeFileSync(one, b);
        // the optical axis through pixel (100, 100)'s centre, so the peak is sampled
        const cam = { ...CAM, fx: 100, fy: 100, width: 200, height: 200, cx: 100.5, cy: 100.5 };
        const [r] = await renderSplatArm(one, [{ camera: cam }], { workDir: path.join(WORK, 'w3') });
        // the reference: the viewer's CPU mirror, with the same quantised quaternion and a projection of the same pinhole
        const q = [b[28] / 255 * 2 - 1, b[29] / 255 * 2 - 1, b[30] / 255 * 2 - 1, b[31] / 255 * 2 - 1] as [number, number, number, number];
        const near = 0.25, far = 1000;
        const proj = [2 * cam.fx / cam.width, 0, 0, 0, 0, 2 * cam.fy / cam.height, 0, 0, 0, 0, -(far + near) / (far - near), -1, 0, 0, -2 * far * near / (far - near), 0];
        const ref = projectSplatEwa({ viewCenter: [0, 0, -10], sigma: [1.2, 1.2, 0.001], quat: q, viewRot: [1, 0, 0, 0, 1, 0, 0, 0, 1], proj, viewportPx: [cam.width, cam.height], opacity: b[27] / 255 });
        expect(ref.visible).toBe(true);
        // the render's alpha moments: its peak and its covariance; cut at 3 sigma, a 2D Gaussian keeps 1 - 4.5 e^-4.5 / (1 - e^-4.5)
        // = 0.9495 of its second moment
        let m = 0, mx = 0, my = 0, peak = 0;
        for (let y = 0; y < cam.height; y++) for (let x = 0; x < cam.width; x++) { const a = r.coverage[y * cam.width + x]; m += a; mx += a * (x + 0.5); my += a * (y + 0.5); peak = Math.max(peak, a); }
        mx /= m; my /= m;
        let sxx = 0, syy = 0, sxy = 0;
        for (let y = 0; y < cam.height; y++) for (let x = 0; x < cam.width; x++) { const a = r.coverage[y * cam.width + x]; const dx = x + 0.5 - mx, dy = y + 0.5 - my; sxx += a * dx * dx; syy += a * dy * dy; sxy += a * dx * dy; }
        sxx /= m; syy /= m; sxy /= m;
        expect(Math.abs(mx - 100.5)).toBeLessThan(0.05);
        expect(Math.abs(my - 100.5)).toBeLessThan(0.05);
        expect(Math.abs(peak - ref.opacity) / ref.opacity).toBeLessThan(0.01);
        const [s00, s01, s11] = ref.cov2dDilated, kept = 1 - 4.5 * Math.exp(-4.5) / (1 - Math.exp(-4.5));
        expect(Math.abs(sxx - s00 * kept) / s00).toBeLessThan(0.03);
        expect(Math.abs(syy - s11 * kept) / s11).toBeLessThan(0.03);
        expect(Math.abs(sxy) - Math.abs(s01)).toBeLessThan(0.05 * Math.sqrt(s00 * s11));
        // seen at 60 degrees the splat is foreshortened vertically: half as tall as wide
        expect(syy / sxx).toBeGreaterThan(0.2);
        expect(syy / sxx).toBeLessThan(0.3);
    }, 120000);
    it('moves every splat by an offset as it loads, in the render and in the centres', async () => {
        // a metre west: the sheet's 100 px span moves 50 px left (fx 1 / z 10)
        const [r] = await renderSplatArm(sheet, [{ camera: CAM }], { workDir: path.join(WORK, 'w4'), offset: [-1, 0, 0] });
        expect(r.coverage[60 * r.width + 5]).toBeGreaterThan(0.99);
        expect(r.coverage[60 * r.width + 105]).toBe(0);
        const moved = await splatPositions(sheet, path.join(WORK, 'w5'), undefined, [-1, 0.5, 2]);
        expect([moved[0], moved[1], moved[2]].map(v => Math.round(v * 1000) / 1000)).toEqual([list[0].p[0] - 1, list[0].p[1] + 0.5, list[0].p[2] + 2]);
    }, 120000);
});

describe('splatRegions', () => {
    it('labels a splat by the nearest reference triangle, else by the judge\'s rule from geometry, and measures its street\'s height', () => {
        // the reference: one ground triangle (x 0..10, z 0..10) labelled ground, one wall triangle over it labelled target
        const reference = { positions: Float32Array.from([0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 10, 0, 0]) };
        const terrain = { groundAt: (x: number, z: number) => (x >= -20 && x <= 40 && z >= -20 && z <= 40 ? 0 : NaN) };
        const positions = Float32Array.from([
            2, 0.04, 2,                                   // on the ground triangle, 4 cm up: ground, by the triangle
            1, 5, 0.1,                                    // on the wall: target, by the triangle
            30, PHOTO_MATCH_GROUND_BAND_M / 2, 30,        // far from both, low over the terrain: ground, by the rule
            30, 8, 30,                                    // far from both, standing: the standing rule (neighbours here)
            100, 8, 100                                   // off the terrain: the standing rule
        ]);
        const r = splatRegions(positions, reference, [REGION.ground, REGION.target], terrain, (x, z) => (x < 50 ? REGION.neighbours : REGION.trees));
        expect(Array.from(r.labels)).toEqual([REGION.ground, REGION.target, REGION.ground, REGION.neighbours, REGION.trees]);
        expect(r.byLabel).toEqual({ ground: 2, neighbours: 1, target: 1, trees: 1 });
        expect(r.unmatchedShare).toBeCloseTo(3 / 5, 6);
        // the median of the ground splats' heights over the terrain (0.04 and half the band)
        expect(r.groundGapM).toBeCloseTo(Math.max(0.04, PHOTO_MATCH_GROUND_BAND_M / 2), 4);
    });
});
