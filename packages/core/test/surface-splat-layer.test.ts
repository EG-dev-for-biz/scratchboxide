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
import { encodePng as encodeRgbPng, quad, writeGlb, type Chunk } from './helpers/synthetic-scan-glb';
import { renderTriangles } from '../src/node/3d-engine/staged-location/photo-match-eval';
import { readTileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

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

    it('takes a picture\'s sky only above its camera\'s horizon: the flat blue one is sky there and a wall below', () => {
        // both stations look 13 degrees down from 12 m: their horizon is about 70 px from the top of 240
        expect(report.skyShares[0]).toBe(0);
        expect(report.skyShares[1]).toBeGreaterThan(60 / H);
        expect(report.skyShares[1]).toBeLessThan(90 / H);
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

describe('buildSurfaceSplatLayer: a station\'s sky', () => {
    const DIR = path.join(WORK, 'sky');
    const SKY: [number, number, number] = [120, 170, 230], BRICK: [number, number, number] = [170, 90, 60];
    /** The east face's top metre, where the scan's roof stands above the photo's roofline. */
    const topBand = (list: ReturnType<typeof readSplats>) => list.filter(s => Math.abs(s.p[0] - 5) < 1e-3 && s.p[1] > 9 && Math.abs(s.p[2]) < 4.5);
    const skyColoured = (c: number[]) => c[2] > c[0] + 25;

    async function layer(name: string, skyMask: boolean) {
        const glb = path.join(DIR, 'box.glb');
        if (!fs.existsSync(glb)) { fs.ensureDirSync(DIR); writeBoxGroundGlb(glb, [-5, 0, -5], [5, 10, 5], 60, []); }
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(glb);
        const dir = path.join(DIR, name);
        fs.ensureDirSync(dir);
        // one station at street level east of the box, the roof above its horizon; its photo shows the roofline 12 px
        // lower than the scan puts it (a registration error), sky above it and brick below
        const eye: [number, number, number] = [30, 2.5, 0];
        const st = await station(renderer, 1, eye, BRICK, dir);
        const pose = await fs.readJson(st.posePath) as { fy: number; cy: number; up: number[]; forward: number[] };
        const d = [5 - eye[0], 10 - eye[1], 0 - eye[2]];
        const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const roofRow = Math.round(pose.cy - pose.fy * dot(d, pose.up) / dot(d, pose.forward)) + 12;
        const px = Buffer.alloc(W * H * 4);
        for (let i = 0; i < W * H; i++) {
            const c = Math.floor(i / W) < roofRow ? SKY : BRICK;
            px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
        }
        await fs.writeFile(st.imagePath, encodePng(W, H, px));
        const report = await buildSurfaceSplatLayer({
            glbPath: glb, anchor: ANCHOR, renderer, stations: [st],
            corridor: { a: [-30, 20], b: [30, 20], eyeY: 1.6 },
            outSplat: path.join(dir, 'surface.splat'), outSpz: path.join(dir, 'surface.spz'), workDir: path.join(dir, 'work'), budget: 200_000, skyMask
        });
        return { report, roofRow, splats: readSplats(path.join(dir, 'surface.splat')) };
    }

    it('colours the roof edge from the sky behind it when the sky is read', async () => {
        const { report, splats } = await layer('read', false);
        expect(report.skyShares).toEqual([0]);
        const band = topBand(splats);
        expect(band.length).toBeGreaterThan(200);
        expect(band.filter(s => skyColoured(s.c)).length).toBeGreaterThan(band.length * 0.5);
    }, 600000);

    it('never colours a splat from a station\'s sky when the sky is masked', async () => {
        const { report, roofRow, splats } = await layer('masked', true);
        // the photo's sky, grown by a few pixels, is what the station is not read over
        expect(report.skyShares[0]).toBeGreaterThan(roofRow / H);
        expect(report.skyShares[0]).toBeLessThan((roofRow + 8) / H);
        const band = topBand(splats);
        expect(band.length).toBeGreaterThan(200);
        expect(band.filter(s => skyColoured(s.c)).length).toBeLessThan(band.length * 0.01);
        // the face below the band is still read from the photo: brick
        const face = splats.filter(s => Math.abs(s.p[0] - 5) < 1e-3 && s.p[1] > 1 && s.p[1] < 7 && Math.abs(s.p[2]) < 4.5);
        expect(face.length).toBeGreaterThan(1000);
        expect(face.filter(s => s.c[0] > s.c[2] + 60).length).toBeGreaterThan(face.length * 0.99);
        // and nothing anywhere carries the sky's colour
        expect(splats.filter(s => skyColoured(s.c)).length).toBeLessThan(splats.length * 0.005);
    }, 600000);
});

describe('buildSurfaceSplatLayer: colour from true views', () => {
    const DIR = path.join(WORK, 'true-views');
    const TW = 640, TH = 480;
    /** Textures of light and dark cells (`cells` across, `px` pixels each); the wall facing +X (x = 5) has 40 x 40 of 0.25 m (u along -z, v up). */
    const cellLight = (seed: number, cu: number, cv: number) => ((Math.imul(cu * 73856093 ^ cv * 19349663 ^ seed * 83492791, 2654435761) >>> 0) % 1000) < 500;
    const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const srgb = (l: number) => Math.round(255 * (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055));
    /** `exposure` scales the texture in linear light (the tiles' photo darker than the stations', as on 7th Ave). */
    function cellTexture(seed: number, cells: number, px: number, exposure = 1): Buffer {
        const N = cells * px, rgb = new Uint8Array(N * N * 3);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
            const c = cellLight(seed, Math.floor(x / px), Math.floor(y / px)) ? [200, 200, 190] : [60, 60, 70];
            rgb.set(c.map(v => srgb(lin(v) * exposure)), (y * N + x) * 3);
        }
        return encodeRgbPng(N, N, rgb);
    }
    const withUvs = (c: Chunk, nu: number, nv: number, image: number): Chunk => {
        const uvs: number[] = [];
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) uvs.push(i / nu, j / nv);
        return { ...c, uvs, image };
    };
    /** A textured scan: the box with its +X wall in `seed`'s cells (or every face, `allFaces`), the rest and the ground in another pattern, and a car beside the walk. */
    function scan(file: string, seed: number, opts: { allFaces?: boolean; exposure?: number } = {}) {
        const side = opts.allFaces ? 0 : 1;
        const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, wallImage: number): Chunk[] => [
            withUvs(quad([x1, y0, z1], [0, 0, z0 - z1], [0, y1 - y0, 0], 10, 10), 10, 10, wallImage),   // +X
            withUvs(quad([x0, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], 10, 10), 10, 10, wallImage === 0 ? side : 1),   // -X
            withUvs(quad([x0, y0, z1], [x1 - x0, 0, 0], [0, y1 - y0, 0], 10, 10), 10, 10, wallImage === 0 ? side : 1),   // +Z
            withUvs(quad([x1, y0, z0], [x0 - x1, 0, 0], [0, y1 - y0, 0], 10, 10), 10, 10, wallImage === 0 ? side : 1),   // -Z
            withUvs(quad([x0, y1, z1], [x1 - x0, 0, 0], [0, 0, z0 - z1], 10, 10), 10, 10, wallImage === 0 ? side : 1)    // top
        ];
        const ground = withUvs(quad([-60, 0, 60], [120, 0, 0], [0, 0, -120], 40, 40), 40, 40, 1);
        // the ground's cells 0.25 m too (480 across its 120 m)
        writeGlb(file, [...box(-5, 0, -5, 5, 10, 5, 0), ground, ...box(CAR[0][0], 0, CAR[0][2], CAR[1][0], CAR[1][1], CAR[1][2], 1)], [cellTexture(seed, 40, 10, opts.exposure), cellTexture(seed + 100, 480, 2, opts.exposure)]);
    }
    /** A station at `eye` looking at the box, its photo `glb`'s texture as the camera sees it, tinted. */
    async function photographed(renderer: SurveyStationRenderService, id: number, eye: [number, number, number], glb: string, tint: number[]) {
        const st = stationFromLookAt(id, eye, [0, 5, 0], { focalLengthMm: 24, sensorWidthMm: 36, aspectRatio: TW / TH }, ANCHOR);
        const b = renderer.renderStationBlockout(st, { width: TW, height: TH });
        const { right, up, forward } = cameraBasis(st.forwardVector, st.upVector || [0, 1, 0]);
        const base = path.join(DIR, `st${id}_${path.basename(glb, '.glb')}`);
        await fs.writeJson(`${base}.pose.json`, { fx: b.intrinsics.fx, fy: b.intrinsics.fy, cx: b.intrinsics.cx, cy: b.intrinsics.cy, eye, right, up, forward, depthKind: 'camera-z' });
        const r = renderTriangles([readTileTriangles(fs.readFileSync(glb))], { eye, right: right as [number, number, number], up: up as [number, number, number], fwd: forward as [number, number, number], fx: b.intrinsics.fx, fy: b.intrinsics.fy, cx: b.intrinsics.cx, cy: b.intrinsics.cy, width: TW, height: TH }, { ambient: 1, supersample: 2, background: [225, 232, 245] });
        const px = Buffer.from(r.rgba);
        for (let i = 0; i < TW * TH; i++) for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round(px[i * 4 + c] * tint[c]);
        await fs.writeFile(`${base}.png`, encodePng(TW, TH, px));
        return { station: st, imagePath: `${base}.png`, posePath: `${base}.pose.json`, priority: 1 };
    }
    const SCAN = path.join(DIR, 'scan.glb'), OTHER = path.join(DIR, 'other_era.glb');
    async function layer(name: string, photoOf: string, tint: number[], refused?: string) {
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(SCAN);
        const st = { ...(await photographed(renderer, 1, [20, 5, 3], photoOf, tint)), ...(refused ? { refused } : {}) };
        const dir = path.join(DIR, name);
        fs.ensureDirSync(dir);
        const report = await buildSurfaceSplatLayer({
            glbPath: SCAN, tileGlbPath: SCAN, anchor: ANCHOR, renderer, stations: [st],
            corridor: { a: [-30, 20], b: [30, 20], eyeY: 1.6 },
            outSplat: path.join(dir, 'surface.splat'), outSpz: path.join(dir, 'surface.spz'), workDir: path.join(dir, 'work'), budget: 200_000,
            outProvenance: path.join(dir, 'provenance.u8')
        });
        const splats = readSplats(path.join(dir, 'surface.splat'));
        const sources = fs.readFileSync(path.join(dir, 'provenance.u8'));
        return { report, splats, sources };
    }
    /** The +X wall's splats away from its cell borders, with the scan's own light or dark there. */
    function wall(list: ReturnType<typeof readSplats>, sources: Buffer) {
        return list.map((sp, i) => ({ ...sp, src: sources[i] })).filter(sp => Math.abs(sp.p[0] - 5) < 1e-3 && sp.p[1] > 0.5 && sp.p[1] < 9.5 && Math.abs(sp.p[2]) < 4.5).flatMap(sp => {
            const fu = (5 - sp.p[2]) / 0.25, fv = sp.p[1] / 0.25;
            if (Math.abs(fu - Math.round(fu)) < 0.2 || Math.abs(fv - Math.round(fv)) < 0.2) return [];
            return [{ ...sp, light: cellLight(1, Math.floor(fu), Math.floor(fv)) }];
        });
    }
    const luma = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    beforeAll(() => { fs.ensureDirSync(DIR); scan(SCAN, 1); scan(OTHER, 7); });

    it('colours a wall from a photo that truly sees it', async () => {
        const { report, splats, sources } = await layer('seen', SCAN, [1, 0.75, 0.35]);
        expect(report.trueViews![0].passed).toBeGreaterThan(0);
        expect(report.trueViews![0].seenShare).toBeGreaterThan(0.5);
        const w = wall(splats, sources);
        expect(w.length).toBeGreaterThan(1000);
        expect(w.filter(s => s.src === 0).length).toBeGreaterThan(w.length * 0.9);
        // the photo's warm tint, on the scan's own light and dark cells
        expect(w.filter(s => s.c[0] > s.c[2] + 30).length).toBeGreaterThan(w.length * 0.9);
        expect(w.filter(s => (luma(s.c) > 100) === s.light).length).toBeGreaterThan(w.length * 0.85);
        expect(report.sources.trueView + report.sources.tileTexture + report.sources.generated).toBe(report.splats);
        expect(sources.length).toBe(report.splats);
    }, 600000);

    it('takes nothing from a station whose picture is refused, yet samples what its camera sees as finely', async () => {
        const seen = await layer('seen_again', SCAN, [1, 0.75, 0.35]);
        const { report, splats, sources } = await layer('refused', SCAN, [1, 0.75, 0.35], 'the image model redrew the view');
        expect(report.trueViews![0].pictureRefused).toBe('the image model redrew the view');
        expect(report.sources.trueView).toBe(0);
        const w = wall(splats, sources);
        expect(w.length).toBeGreaterThan(wall(seen.splats, seen.sources).length * 0.9);
        expect(w.filter(s => s.src === 1).length).toBeGreaterThan(w.length * 0.95);
        // the scan's own cells, not the photo's warm tint
        expect(w.filter(s => s.c[0] > s.c[2] + 30).length).toBeLessThan(w.length * 0.05);
    }, 600000);

    it('never paints a photo of something else onto the wall: the scan\'s own texture stands in, and the flattened car is a labelled fill', async () => {
        // the same camera, but its photo shows another era: other cells everywhere, tinted green
        const { report, splats, sources } = await layer('seen_through', OTHER, [0.5, 1, 0.5]);
        expect(report.trueViews![0].seenShare).toBeLessThan(0.1);
        const w = wall(splats, sources);
        expect(w.length).toBeGreaterThan(1000);
        expect(w.filter(s => s.c[1] > s.c[0] + 30 && s.c[1] > s.c[2] + 30).length).toBeLessThan(w.length * 0.01);
        expect(w.filter(s => s.src === 1).length).toBeGreaterThan(w.length * 0.95);
        expect(w.filter(s => (luma(s.c) > 120) === s.light).length).toBeGreaterThan(w.length * 0.85);
        // the car laid on the street has no photo of its new surface: generated, and said so
        expect(report.flattenedTriangles).toBeGreaterThan(0);
        expect(report.sources.generatedMoved).toBeGreaterThan(0);
        const gen = splats.filter((_, i) => sources[i] === 2);
        expect(gen.length).toBe(report.sources.generated);
        expect(gen.filter(s => s.p[0] >= CAR[0][0] - 0.5 && s.p[0] <= CAR[1][0] + 0.5 && s.p[2] >= CAR[0][2] - 0.5 && s.p[2] <= CAR[1][2] + 0.5).length).toBeGreaterThan(gen.length * 0.9);
    }, 600000);

    it('brings the scan\'s texture to the stations\' look where none of them sees it, by the curve fitted where they do', async () => {
        // the tiles photographed every face 0.35 times as bright (linear) as the stations show them; three stations truly
        // see the east, west and north faces, and a fourth faces the south (+Z) one with a photo of something else
        const bright = path.join(DIR, 'bright.glb'), dark = path.join(DIR, 'dark.glb');
        scan(bright, 3, { allFaces: true });
        scan(dark, 3, { allFaces: true, exposure: 0.35 });
        const renderer = new SurveyStationRenderService();
        await renderer.loadMesh(dark);
        const stations = [
            await photographed(renderer, 11, [20, 5, 3], bright, [1, 1, 1]),
            await photographed(renderer, 12, [-20, 5, -3], bright, [1, 1, 1]),
            await photographed(renderer, 13, [3, 5, -20], bright, [1, 1, 1]),
            await photographed(renderer, 14, [-3, 5, 20], OTHER, [1, 1, 1])
        ];
        const dir = path.join(DIR, 'tone');
        fs.ensureDirSync(dir);
        const report = await buildSurfaceSplatLayer({
            glbPath: dark, tileGlbPath: dark, anchor: ANCHOR, renderer, stations,
            corridor: { a: [-30, 20], b: [30, 20], eyeY: 1.6 },
            outSplat: path.join(dir, 'surface.splat'), outSpz: path.join(dir, 'surface.spz'), workDir: path.join(dir, 'work'), budget: 200_000,
            outProvenance: path.join(dir, 'provenance.u8')
        });
        expect(report.trueViews![3].seenShare).toBeLessThan(0.1);
        expect(report.sources.tileToneStations).toBeGreaterThanOrEqual(3);
        for (const g of report.sources.tileGain) expect(g).toBeGreaterThan(2);
        const splats = readSplats(path.join(dir, 'surface.splat')), sources = fs.readFileSync(path.join(dir, 'provenance.u8'));
        /** A face's splats away from its cell borders (u along +x on the south face, -z on the east one), with the scan's light or dark there. */
        const face = (onFace: (p: number[]) => boolean, u: (p: number[]) => number) => splats.map((sp, i) => ({ ...sp, src: sources[i] })).filter(sp => onFace(sp.p) && sp.p[1] > 0.5 && sp.p[1] < 9.5).flatMap(sp => {
            const fu = u(sp.p) / 0.25, fv = sp.p[1] / 0.25;
            if (Math.abs(fu - Math.round(fu)) < 0.2 || Math.abs(fv - Math.round(fv)) < 0.2) return [];
            return [{ ...sp, light: cellLight(3, Math.floor(fu), Math.floor(fv)) }];
        });
        const south = face(p => Math.abs(p[2] - 5) < 1e-3 && Math.abs(p[0]) < 4.5, p => p[0] + 5);
        const east = face(p => Math.abs(p[0] - 5) < 1e-3 && Math.abs(p[2]) < 4.5, p => 5 - p[2]).filter(sp => sp.src === 0);
        expect(south.length).toBeGreaterThan(500);
        expect(east.length).toBeGreaterThan(500);
        expect(south.filter(sp => sp.src === 1).length).toBeGreaterThan(south.length * 0.95);
        // toned, the south face's light cells close most of the gap between the texture as photographed and the east face
        // as a station truly sees it, and its light and dark cells stay apart
        const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
        const level = (list: typeof south, light: boolean) => mean(list.filter(sp => sp.light === light).map(sp => luma(sp.c)));
        const asPhotographed = luma([200, 200, 190].map(v => srgb(lin(v) * 0.35)));
        expect(Math.abs(level(south, true) - level(east, true))).toBeLessThan(0.5 * Math.abs(asPhotographed - level(east, true)));
        expect(level(south, true) - level(south, false)).toBeGreaterThan(80);
    }, 600000);
});

