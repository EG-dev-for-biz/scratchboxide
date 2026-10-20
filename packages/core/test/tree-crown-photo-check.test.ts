/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The Street View crown check and the photo-inferred crown correction (tree-crown-photo-check.ts, CrownCorrection in
 * scratchbox_tile_vegetation.hpp):
 *
 * - a crown ellipsoid projected through a known camera, and a photo box of a known crown, lift back to the right widths,
 *   tops and bases on the stem plane (so the ratios and heights the check reports are the scene's own);
 * - the gates refuse a shrub under the crown, an unseparated crown and another tree's trunk;
 * - the correction takes each seen tree's own reading and the district median for the others, within its limits;
 * - planted with a correction, a crown grows wider by the scale and lower to the base asked for, its top unchanged, its
 *   extras say photo-inferred; the trees stage finds a correction recorded for its crowns.json by itself.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { projectToFrame } from '../src/node/spatial/StreetViewPoseRegistrar';
import {
    CROWN_CORRECTION_SCHEMA, crownCorrectionFromReadings, ellipsoidImageBox, ellipsoidImageMask, liftToStemPlane, perTreeReadings, readCrown, rejectReading,
    type CheckedTree, type CrownPhotoReading
} from '../src/node/3d-engine/staged-location/tree-crown-photo-check';
import { TileVegetationService, crownCorrectionPathFor } from '../src/node/3d-engine/tile-vegetation-service';
import { encodePng } from '../src/node/texture-processing';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SHOTS = path.join(REPO, 'test-results/screenshots/tree_crown_size');

// a camera 20 m south of a tree, 2.5 m up, looking north and 15° up (tile frame: x east, y up, z south)
const cam = castCamera({ eye: [0, 2.5, 20], headingDeg: 0, pitchDeg: 15, fovDeg: 90, widthPx: 1920, heightPx: 1280 });
const tree: CheckedTree = { id: 7, crown: { centre: [0, 9, 0], radii: [3, 4, 3], yawRad: 0.3 }, stem: [0, 0], groundY: 0 };

describe('the crown check on the stem plane', () => {
    it('lifts a pixel back onto the plane through the stem that faces the camera', () => {
        for (const p of [[1.5, 6, 0], [-2, 11, 0], [0, 0.5, 0]] as Array<[number, number, number]>) {
            const q = projectToFrame(cam, p)!;
            const l = liftToStemPlane(cam, tree.stem, q[0], q[1])!;
            expect(l.y).toBeCloseTo(p[1], 3);
            // the camera looks north: to the right of the stem is east
            expect(l.along).toBeCloseTo(p[0], 3);
        }
    });

    it('reads the ratios and heights of a known crown from its box', () => {
        // the real crown: 1.3 x as wide, from 2 m up to the same top (13 m)
        const real = { centre: [0, 7.5, 0] as [number, number, number], radii: [3.9, 5.5, 3.9] as [number, number, number], yawRad: 0 };
        const box = ellipsoidImageBox(cam, real)!;
        const r = readCrown(cam, tree, box)!;
        expect(r.modelTopM).toBeGreaterThan(12.5);
        expect(r.modelTopM).toBeLessThan(13.8);
        expect(r.photoTopM / r.modelTopM).toBeGreaterThan(0.97);
        expect(r.photoTopM / r.modelTopM).toBeLessThan(1.03);
        expect(r.photoBaseM).toBeGreaterThan(1.4);
        expect(r.photoBaseM).toBeLessThan(2.6);
        expect(r.modelBaseM).toBeGreaterThan(r.photoBaseM + 2);
        expect(r.widthRatio).toBeGreaterThan(1.2);
        expect(r.widthRatio).toBeLessThan(1.4);
        expect(r.distanceM).toBeCloseTo(20, 5);
        // the projected outline, for the record
        fs.mkdirSync(SHOTS, { recursive: true });
        const W = 480, H = 320, small = castCamera({ eye: [0, 2.5, 20], headingDeg: 0, pitchDeg: 15, fovDeg: 90, widthPx: W, heightPx: H });
        const a = ellipsoidImageMask(small, tree.crown), b = ellipsoidImageMask(small, real);
        const rgba = new Uint8Array(W * H * 4);
        for (let i = 0; i < W * H; i++) { rgba[i * 4] = a[i] ? 220 : 30; rgba[i * 4 + 1] = b[i] ? 200 : 30; rgba[i * 4 + 2] = 40; rgba[i * 4 + 3] = 255; }
        fs.writeFileSync(path.join(SHOTS, 'test_photo_check_model_red_photo_green.png'), encodePng(W, H, Buffer.from(rgba)));
        expect(a.reduce((s, v) => s + v, 0)).toBeGreaterThan(1000);
    });

    it('refuses a shrub under the crown, a merged crown and another tree\'s trunk', () => {
        const foot = projectToFrame(cam, [0, 0, 0])!;
        const footPx = { x: foot[0], y: foot[1] };
        const crownBox = ellipsoidImageBox(cam, { centre: [0, 9, 0], radii: [3.5, 4, 3.5], yawRad: 0 })!;
        const good = { found: true, box: crownBox, trunk: footPx, separable: 'partly', topVisible: true, occludedShare: 0.1 };
        expect(rejectReading(good, footPx, readCrown(cam, tree, crownBox))).toBeUndefined();
        const shrub = ellipsoidImageBox(cam, { centre: [0, 1, 0], radii: [2, 1, 2], yawRad: 0 })!;
        expect(rejectReading({ ...good, box: shrub }, footPx, readCrown(cam, tree, shrub))).toMatch(/far below the measured top/);
        expect(rejectReading({ ...good, separable: 'merged' }, footPx, readCrown(cam, tree, crownBox))).toMatch(/merges/);
        expect(rejectReading({ ...good, trunk: { x: footPx.x + 600, y: footPx.y } }, footPx, readCrown(cam, tree, crownBox))).toMatch(/not the one marked/);
        expect(rejectReading({ ...good, found: false }, footPx, null)).toMatch(/no tree/);
    });
});

describe('the photo-inferred correction', () => {
    const reading = (treeId: number, widthRatio: number, photoBaseM: number): CrownPhotoReading => ({
        treeId, widthRatio, heightRatio: 1, photoBaseM, modelBaseM: 5, photoTopM: 15, modelTopM: 15, photoWidthM: 8 * widthRatio, modelWidthM: 8, distanceM: 20
    });

    it('takes each seen tree\'s own reading (the median of its photos) and the district median for the rest', () => {
        const per = perTreeReadings([reading(1, 1.2, 2), reading(1, 1.4, 3), reading(2, 1.1, 1.5), reading(3, 3.5, -1)]);
        expect(per.find(r => r.treeId === 1)!.widthRatio).toBeCloseTo(1.3, 6);
        const c = crownCorrectionFromReadings(per, [1, 2, 3, 4], () => 15, new Map([[1, 2]]));
        expect(c.schema).toBe(CROWN_CORRECTION_SCHEMA);
        expect(c.provenance).toBe('photo-inferred');
        expect(c.trees['1']).toMatchObject({ source: 'photo', photos: 2, crownBaseRatio: 2.5 / 15 });
        expect(c.trees['1'].widthScale).toBeCloseTo(1.3, 6);
        // held to the limits: a 3.5 x reading and a base under the ground are misreads more likely than crowns
        expect(c.trees['3'].widthScale).toBe(2.0);
        expect(c.trees['3'].crownBaseRatio).toBe(0.08);
        expect(c.trees['4'].source).toBe('district-median');
        expect(c.trees['4'].widthScale).toBeCloseTo(c.median.widthScale, 9);
        expect(c.median.trees).toBe(3);
    });
});

type Vec3 = [number, number, number];
function crown(id: number, stem: [number, number], supportY: number, apexY: number, radius: number) {
    const samples: Vec3[] = [];
    const n = Math.ceil(radius / 0.7);
    for (let i = -n; i <= n; i++) for (let k = -n; k <= n; k++) {
        const dx = i * 0.7, dz = k * 0.7, d = Math.hypot(dx, dz);
        if (d <= radius) samples.push([stem[0] + dx, apexY - 0.45 * (apexY - supportY) * (d / radius) ** 2, stem[1] + dz]);
    }
    return {
        id, status: 'tree', reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY, supportSource: 'given', terrainY: supportY,
        apexAboveSupport: apexY - supportY, areaM2: Math.PI * radius * radius, sectorRadii: new Array(16).fill(radius), samples,
        colour: { meanLinearRgb: [0.08, 0.09, 0.045], spreadLinearRgb: [0.02, 0.02, 0.01], samples: 100, cells: 50, greenShare: 1, hueDeg: 70, chroma: 0.5 }
    };
}
const CROWNS = [crown(0, [0, 0], 0, 14, 4), crown(1, [18, 3], 0, 12, 3.5)];

function treeExtras(glb: string): Map<number, any> {
    const b = fs.readFileSync(glb);
    const g = JSON.parse(b.toString('utf8', 20, 20 + b.readUInt32LE(12)));
    return new Map((g.nodes as any[]).filter(n => n.extras?.sbTree).map(n => [n.extras.sbTree.id, n.extras]));
}

describe('planting with a crown correction', () => {
    let work: string;
    let svc: TileVegetationService;
    let plain: Awaited<ReturnType<TileVegetationService['plant']>>;
    let corrected: Awaited<ReturnType<TileVegetationService['plant']>>;
    let recorded: Awaited<ReturnType<TileVegetationService['plant']>>;
    const correction = {
        schema: CROWN_CORRECTION_SCHEMA, provenance: 'photo-inferred', method: 'test',
        median: { widthScale: 1.3, crownBaseRatio: 0.15, trees: 1, readings: 1 },
        trees: { '0': { widthScale: 1.3, crownBaseRatio: 0.15, source: 'photo', photos: 1 }, '1': { widthScale: 1.3, crownBaseRatio: 0.15, source: 'district-median' } }
    };
    beforeAll(async () => {
        work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-crown-correction-')));
        svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
        await svc.ensureBinary();
        fs.writeFileSync(path.join(work, 'crowns.json'), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 }, crowns: CROWNS }));
        fs.writeFileSync(path.join(work, 'correction.json'), JSON.stringify(correction));
        plain = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 12000, seed: 'abc' });
        corrected = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 12000, seed: 'abc', crownCorrectionPath: 'correction.json' });
        // recorded for these crowns: the trees stage's plain call picks it up
        const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(work, 'crowns.json'))).digest('hex');
        fs.mkdirSync(path.dirname(crownCorrectionPathFor(work, sha)), { recursive: true });
        fs.writeFileSync(crownCorrectionPathFor(work, sha), JSON.stringify(correction));
        recorded = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 12000, seed: 'abc' });
    }, 900_000);
    afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

    it('grows the crown wider by the scale and lower to the base, the top unchanged, labelled photo-inferred', () => {
        const a = treeExtras(plain.treesGlb), b = treeExtras(corrected.treesGlb);
        for (const id of [0, 1]) {
            const ca = a.get(id).sbTree.crown, cb = b.get(id).sbTree.crown;
            const wa = Math.max(ca.radii[0], ca.radii[2]), wb = Math.max(cb.radii[0], cb.radii[2]);
            expect(wb / wa).toBeGreaterThan(1.15);
            expect(wb / wa).toBeLessThan(1.45);
            const topA = ca.centre[1] + ca.radii[1], topB = cb.centre[1] + cb.radii[1];
            expect(Math.abs(topB - topA)).toBeLessThan(0.8);
            const baseA = ca.centre[1] - ca.radii[1], baseB = cb.centre[1] - cb.radii[1];
            expect(baseB).toBeLessThan(baseA - 1);
            const c = CROWNS[id];
            expect(b.get(id).inferred.crownBaseRatio).toBeCloseTo(0.15, 6);
            expect(b.get(id).inferred.crownBaseY).toBeCloseTo(c.supportY + 0.15 * (c.apex[1] - c.supportY), 3);
            expect(b.get(id).crownCorrection).toMatchObject({ widthScale: 1.3, crownBaseRatio: 0.15, provenance: 'photo-inferred', source: id === 0 ? 'photo' : 'district-median' });
            expect(JSON.stringify(b.get(id).sb.provenance)).toContain('photo-inferred');
            expect(JSON.stringify(a.get(id).sb.provenance)).not.toContain('photo-inferred');
            expect(a.get(id).crownCorrection).toBeUndefined();
        }
        expect(corrected.crownCorrection).toMatchObject({ provenance: 'photo-inferred', trees: 2, fromPhotos: 1 });
        expect(plain.crownCorrection).toBeUndefined();
    });

    it('finds a correction recorded for its crowns.json by itself', () => {
        expect(recorded.crownCorrection?.trees).toBe(2);
        expect(recorded.cacheKey).toBe(corrected.cacheKey);
    });
});
