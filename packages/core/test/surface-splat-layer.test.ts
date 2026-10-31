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

/** A station looking at the box from `eye`, its image one flat colour, and its pose.json as the bake writes it. */
async function station(renderer: SurveyStationRenderService, id: number, eye: [number, number, number], rgb: [number, number, number]) {
    const st = stationFromLookAt(id, eye, [0, 5, 0], { focalLengthMm: 24, sensorWidthMm: 36, aspectRatio: W / H }, ANCHOR);
    const b = renderer.renderStationBlockout(st, { width: W, height: H });
    const { right, up, forward } = cameraBasis(st.forwardVector, st.upVector || [0, 1, 0]);
    const base = path.join(WORK, `st${id}`);
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
