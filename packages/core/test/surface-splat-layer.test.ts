/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { buildSurfaceSplatLayer, type SurfaceLayerReport } from '../src/node/spatial/surface-splat-layer';
import { SurveyStationRenderService } from '../src/node/spatial/SurveyStationRenderService';
import { stationFromLookAt, cameraBasis } from '../src/common/spatial/SurveySynthesisEngine';
import { encodePng } from '../src/node/texture-processing';
import type { GeodeticAnchor } from '../src/common/spatial/colmap-vector-reference-types';
import { writeBoxGroundGlb } from './helpers/box-ground-glb';

const ANCHOR: GeodeticAnchor = { lat: 40.7497, lng: -73.9916, elevationMeters: 12, headingDeg: 0, formattedAddress: 'test' };
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-surface-splats-'));
const GLB = path.join(WORK, 'box_ground.glb');
const W = 320, H = 240;
const CAR: [number[], number[]] = [[12, 0, 14], [14, 1.5, 18]];

/** A station looking at the box from `eye`, its image one flat colour, and its pose.json as the bake writes it (in `dir`). */
async function station(renderer: SurveyStationRenderService, id: number, eye: [number, number, number], rgb: [number, number, number], dir = WORK) {
    const st = stationFromLookAt(id, eye, [0, 5, 0], { focalLengthMm: 24, sensorWidthMm: 36, aspectRatio: W / H }, ANCHOR);
    const b = renderer.renderStationBlockout(st, { width: W, height: H });
    const { right, up, forward } = cameraBasis(st.forwardVector, st.upVector || [0, 1, 0]);
    const base = path.join(dir, `st${id}`);
    await fs.writeJson(`${base}.pose.json`, { fx: b.intrinsics.fx, fy: b.intrinsics.fy, cx: b.intrinsics.cx, cy: b.intrinsics.cy, eye, right, up, forward, depthKind: 'camera-z' });
    const px = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) { px[i * 4] = rgb[0]; px[i * 4 + 1] = rgb[1]; px[i * 4 + 2] = rgb[2]; px[i * 4 + 3] = 255; }
    await fs.writeFile(`${base}.png`, encodePng(W, H, px));
    return { station: st, imagePath: `${base}.png`, posePath: `${base}.pose.json`, priority: 1 };
}

function readSplats(file: string) {
    const b = fs.readFileSync(file), n = b.length / 32;
    return Array.from({ length: n }, (_, i) => ({ p: [b.readFloatLE(i * 32), b.readFloatLE(i * 32 + 4), b.readFloatLE(i * 32 + 8)], s: b.readFloatLE(i * 32 + 12), c: [b[i * 32 + 24], b[i * 32 + 25], b[i * 32 + 26]] }));
}

describe('buildSurfaceSplatLayer', () => {
    let report: SurfaceLayerReport;
    let splats: ReturnType<typeof readSplats>;
    beforeAll(async () => {
        // a 10 m box 10 m tall on a 120 m ground plane at y = 0, and a parked car beside the walk
        writeBoxGroundGlb(GLB, [-5, 0, -5], [5, 10, 5], 60, [CAR]);
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(GLB);
        // red from the east, blue from the west: each sees one side face head-on, the top and the ground both
        const stations = [await station(renderer, 1, [30, 12, 0], [200, 40, 40]), await station(renderer, 2, [-30, 12, 0], [40, 40, 200])];
        report = await buildSurfaceSplatLayer({
            glbPath: GLB, anchor: ANCHOR, renderer, stations,
            corridor: { a: [-30, 20], b: [30, 20], eyeY: 1.6 },   // a walk 20 m south of the box, along x
            outSplat: path.join(WORK, 'surface.splat'), outSpz: path.join(WORK, 'surface.spz'), workDir: path.join(WORK, 'work'),
            budget: 300_000
        });
        splats = readSplats(path.join(WORK, 'surface.splat'));
    }, 600000);
    afterAll(() => fs.removeSync(WORK));

    it('lays every splat on the scan\'s surface, within the budget, and removes its work files', () => {
        expect(report.splats).toBe(splats.length);
        expect(report.splats).toBeGreaterThan(10_000);
        expect(report.splats).toBeLessThanOrEqual(300_000 * 1.05);
        const onSurface = (p: number[]) => Math.abs(p[1]) < 1e-3
            || (Math.abs(Math.abs(p[0]) - 5) < 1e-3 && Math.abs(p[2]) <= 5.001 && p[1] <= 10.001)
            || (Math.abs(Math.abs(p[2]) - 5) < 1e-3 && Math.abs(p[0]) <= 5.001 && p[1] <= 10.001)
            || (Math.abs(p[1] - 10) < 1e-3 && Math.abs(p[0]) <= 5.001 && Math.abs(p[2]) <= 5.001);
        expect(splats.every(s => onSurface(s.p))).toBe(true);
        expect(fs.existsSync(path.join(WORK, 'work'))).toBe(false);
    });

    it('lays a parked car on the street instead of standing it up beside the walk', () => {
        expect(report.flattenedTriangles).toBeGreaterThan(0);
        const [[x0, , z0], [x1, , z1]] = CAR;
        const overCar = splats.filter(s => s.p[0] >= x0 - 0.01 && s.p[0] <= x1 + 0.01 && s.p[2] >= z0 - 0.01 && s.p[2] <= z1 + 0.01);
        expect(overCar.length).toBeGreaterThan(0);
        expect(Math.max(...overCar.map(s => s.p[1]))).toBeLessThan(1e-3);
    });

    it('colours each face from the station that sees it', () => {
        const mean = (sel: typeof splats) => [0, 1, 2].map(k => sel.reduce((a, s) => a + s.c[k], 0) / sel.length);
        const east = mean(splats.filter(s => Math.abs(s.p[0] - 5) < 1e-3 && s.p[1] > 1));
        const west = mean(splats.filter(s => Math.abs(s.p[0] + 5) < 1e-3 && s.p[1] > 1));
        expect(east[0]).toBeGreaterThan(east[2] * 2);   // red
        expect(west[2]).toBeGreaterThan(west[0] * 2);   // blue
    });

    it('fills what no station sees (the box\'s north and south faces, edge-on to both) and counts it', () => {
        expect(report.unobserved).toBeGreaterThan(0);
        expect(report.observed + report.unobserved).toBe(report.splats);
        expect(report.gains).toHaveLength(2);
    });

    it('packs splats densest along the walk and writes the smaller SPZ', () => {
        const ground = splats.filter(s => Math.abs(s.p[1]) < 1e-3);
        const near = ground.filter(s => Math.abs(s.p[2] - 20) < 4 && Math.abs(s.p[0]) < 20).length / (8 * 40);
        const far = ground.filter(s => s.p[2] < -35 && Math.abs(s.p[0]) < 20).length / (25 * 40);
        // near the walk the spacing is the budget-scaled minimum; the far ground, seen by no station head-on, the far spacing
        expect(near).toBeGreaterThan(far * 2);
        // splats overlap their neighbours: sigma is about half the spacing
        const nearSigma = ground.filter(s => Math.abs(s.p[2] - 20) < 1).map(s => s.s).sort((a, b) => a - b);
        expect(nearSigma[nearSigma.length >> 1]).toBeGreaterThan(0.4 * Math.sqrt(1 / near));
        const spz = fs.statSync(path.join(WORK, 'surface.spz')).size;
        expect(spz).toBeGreaterThan(0);
        expect(spz).toBeLessThan(fs.statSync(path.join(WORK, 'surface.splat')).size / 3);
    });
});

describe('buildSurfaceSplatLayer: one station per patch, stations\' colours agreed', () => {
    const DIR = path.join(WORK, 'patches');
    const eastFace = (list: ReturnType<typeof readSplats>) => list.filter(s => Math.abs(s.p[0] - 5) < 1e-3 && s.p[1] > 1 && Math.abs(s.p[2]) < 4.5);
    async function layer(name: string, colours: [[number, number, number], [number, number, number]]) {
        const glb = path.join(DIR, 'box.glb');
        if (!fs.existsSync(glb)) { fs.ensureDirSync(DIR); writeBoxGroundGlb(glb, [-5, 0, -5], [5, 10, 5], 60, []); }
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(glb);
        const dir = path.join(DIR, name);
        fs.ensureDirSync(dir);
        // two stations either side of the box's east face, seeing it (and the top and the ground) about equally well
        const stations = [await station(renderer, 1, [30, 12, 10], colours[0], dir), await station(renderer, 2, [30, 12, -10], colours[1], dir)];
        const report = await buildSurfaceSplatLayer({
            glbPath: glb, anchor: ANCHOR, renderer, stations,
            corridor: { a: [-30, 20], b: [30, 20], eyeY: 1.6 },
            outSplat: path.join(dir, 'surface.splat'), outSpz: path.join(dir, 'surface.spz'), workDir: path.join(dir, 'work'), budget: 200_000
        });
        return { report, splats: readSplats(path.join(dir, 'surface.splat')) };
    }

    it('colours every splat from its patch\'s one station, never a blend of two stations\' pictures', async () => {
        const { report, splats } = await layer('red-green', [[200, 40, 40], [40, 200, 40]]);
        const face = eastFace(splats);
        expect(face.length).toBeGreaterThan(1000);
        expect(report.patches).toBeGreaterThan(50);
        // a blend of the two would be red and green in proportion (about 150 and 90); one station keeps one dominant
        const blended = face.filter(s => Math.max(s.c[0], s.c[1]) < 2 * Math.min(s.c[0], s.c[1]));
        expect(blended.length).toBeLessThan(face.length * 0.01);
        // both stations colour part of the face, each over whole patches
        const red = face.filter(s => s.c[0] > s.c[1]).length;
        expect(red).toBeGreaterThan(face.length * 0.1);
        expect(red).toBeLessThan(face.length * 0.9);
    }, 600000);

    it('matches a darker station\'s exposure to the other\'s where both show the same surface', async () => {
        const { report, splats } = await layer('exposure', [[160, 160, 160], [125, 125, 125]]);
        expect(report.seams.inliers).toBeGreaterThan(10);
        expect(report.seams.gainResidual).toBeLessThan(0.05);
        expect(report.seams.gainsKept).toBe(true);
        expect(report.seams.afterGain).toBeLessThan(report.seams.before / 5);
        // the darker station is lifted and the brighter lowered toward each other (linear light: 160 is 1.71x 125)
        const lum = (g: number[]) => 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
        expect(lum(report.gains[1]) / lum(report.gains[0])).toBeGreaterThan(1.5);
        // and the face reads as one grey: before, its two halves were 35 levels apart
        const grey = eastFace(splats).map(s => s.c[1]).sort((a, b) => a - b);
        expect(grey[Math.floor(grey.length * 0.95)] - grey[Math.floor(grey.length * 0.05)]).toBeLessThan(8);
    }, 600000);
});
