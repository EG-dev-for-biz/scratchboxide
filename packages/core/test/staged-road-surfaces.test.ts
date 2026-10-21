/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Road surfaces measured on a synthetic photo tile: along Google-style centrelines the kerbs are found where the scan
 * steps up, the carriageway's level and camber are read low (below parked cars), a median's edges are found and kept
 * undrivable, the crossing is built once, sidewalks run to the kerb's level, the ribbons carry planar UVs into a
 * top-down render of the tile photo (the road reads dark where the photo is dark), and a stem on the carriageway finds
 * the nearest spot off it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadScanMesh, surfaceModel } from '../src/node/spatial/StreetViewSurveyPlanner';
import {
    buildRoadMesh, drivableAt, measureRoadSurfaces, nearestOffRoad, ROAD_SURFACE_PARAMS, stationsAlong, writeRoadsGlb, type RoadSurface
} from '../src/node/3d-engine/staged-location/road-surfaces';
import { renderTopDownPhoto, topDownJpeg } from '../src/node/3d-engine/staged-location/top-down-photo';
import { buildSyntheticTile, GROUND_RGB, ROAD_RGB } from './helpers/synthetic-textured-tile';
import { parseGlb } from './helpers/clay-glb-render';
import { measureGlbMeshCounts } from '../src/common/glb-mesh-counts';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-roads-'));
afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

// an east-west street 8 m wide with 0.12 m kerbs, a north-south street 6 m wide crossing it at x = 10, and a boulevard
// along z = -15 with a 1.5 m median; a tree whose crown overhangs the first street from its south kerb
const TILE = buildSyntheticTile({
    halfSize: 30, spacing: 0.5,
    roads: [
        { x0: -30, z0: 0, x1: 30, z1: 0, halfWidth: 4, kerb: 0.12 },
        { x0: 10, z0: -30, x1: 10, z1: 30, halfWidth: 3, kerb: 0.12 },
        { x0: -30, z0: -15, x1: 30, z1: -15, halfWidth: 7, kerb: 0.12, median: { halfWidth: 1.5 } }
    ],
    trees: [{ x: -12, z: 5.5, height: 9, radius: 3.5 }]
});
const CENTRELINES: Vec2[][] = [[[-28, 0], [28, 0]], [[10, -28], [10, 28]], [[-28, -15], [28, -15]]];

let roads: RoadSurface[];
let tileFile: string;

beforeAll(() => {
    tileFile = path.join(WORK, 'tile.glb');
    fs.writeFileSync(tileFile, TILE);
    const scan = loadScanMesh(tileFile);
    const grid = { ...surfaceModel(scan, 0.5), cellM: 0.5 };
    // the tree's canopy is not surface (as the strip's canopy mask keeps it out in a build)
    roads = measureRoadSurfaces({ roads: CENTRELINES, grid, within: (x, z) => Math.abs(x) <= 29 && Math.abs(z) <= 29, exclude: (x, z) => Math.hypot(x + 12, z - 5.5) < 3.8 });
});

describe('road surfaces', () => {
    it('places stations along a centreline at the step, ends included, with smoothed tangents', () => {
        const s = stationsAlong([[0, 0], [10, 0], [10, 10]], 2);
        expect(s.length).toBe(11);
        expect(s[0]).toMatchObject({ x: 0, z: 0, tx: 1, tz: 0 });
        expect(s[s.length - 1]).toMatchObject({ x: 10, z: 10 });
        expect(Math.hypot(s[5].tx, s[5].tz)).toBeCloseTo(1, 6);
    });

    it('measures the kerbs where the scan steps up, the carriageway low, and the sidewalk at the kerb level', () => {
        expect(roads.length).toBe(3);
        const [ew, ns] = roads;
        // the crossing (no kerb for 6 m each way on the main street, 8 m on the side street) and the canopy over the south kerb are the gaps
        expect(ew.measuredKerbShare).toBeGreaterThan(0.7);
        expect(ns.measuredKerbShare).toBeGreaterThan(0.5);
        const lift = ROAD_SURFACE_PARAMS.liftM;
        for (const s of ew.stations.filter(s => Math.abs(s.x - 10) > 6 && Math.abs(s.x + 12) > 6)) {
            expect(s.left.kerb).toBe('measured');
            expect(s.right.kerb).toBe('measured');
            expect(Math.abs(s.left.halfWidthM - 4)).toBeLessThanOrEqual(0.6);
            expect(Math.abs(s.right.halfWidthM - 4)).toBeLessThanOrEqual(0.6);
            // the carriageway is 0.12 m down, the kerb top at the ground, both lifted by liftM
            for (const h of s.profile) expect(Math.abs(h - (-0.12 + lift))).toBeLessThan(0.05);
            expect(Math.abs(s.left.kerbTopY! - lift)).toBeLessThan(0.05);
            expect(s.left.sidewalk).toBeDefined();
            expect(s.left.sidewalk!.widthM).toBeGreaterThanOrEqual(2);
            expect(Math.abs(s.left.sidewalk!.level - lift)).toBeLessThan(0.05);
        }
        for (const s of ns.stations.filter(s => Math.abs(s.z) > 6 && Math.abs(s.z + 15) > 9)) {
            expect(Math.abs(s.left.halfWidthM - 3)).toBeLessThanOrEqual(0.6);
            expect(Math.abs(s.right.halfWidthM - 3)).toBeLessThanOrEqual(0.6);
        }
    });

    it('finds a median under the centreline and keeps it undrivable', () => {
        const blvd = roads[2];
        const mid = blvd.stations.filter(s => Math.abs(s.x - 10) > 6);
        expect(mid.filter(s => s.median).length / mid.length).toBeGreaterThan(0.8);
        const s = mid.find(s => s.median)!;
        // the tile's median is 1.5 m to its cell centres, so its top is 1.75 m wide in the 0.5 m surface model
        expect(Math.abs(s.median!.leftEdgeM - 1.75)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(s.median!.rightEdgeM - 1.75)).toBeLessThanOrEqual(0.5);
        expect(Math.abs(s.left.halfWidthM - 7)).toBeLessThanOrEqual(0.6);
        expect(drivableAt(roads, -5, -15)).toBe(false);
        expect(drivableAt(roads, -5, -19)).toBe(true);
        expect(drivableAt(roads, -5, -11)).toBe(true);
    });

    it('tells the drivable surface from the sidewalk, and moves a stem off it to the nearest spot', () => {
        expect(drivableAt(roads, 0, 1)).toBe(true);
        expect(drivableAt(roads, 0, 6)).toBe(false);
        expect(drivableAt(roads, 10, 12)).toBe(true);
        expect(drivableAt(roads, -12, 5.5)).toBe(false);
        const moved = nearestOffRoad(roads, -12, 1, 6)!;
        expect(moved).toBeDefined();
        expect(moved.movedM).toBeLessThanOrEqual(4);
        expect(drivableAt(roads, moved.x, moved.z)).toBe(false);
        expect(nearestOffRoad(roads, 0, 6, 3)).toMatchObject({ movedM: 0.5 });
    });

    it('builds the ribbons once at the crossing, with kerb faces and sidewalks, and writes a textured GLB that reads the photo', () => {
        const mesh = buildRoadMesh(roads);
        expect(mesh.stats.roads).toBe(3);
        expect(mesh.stats.skippedQuads).toBeGreaterThan(0);
        expect(mesh.stats.medians).toBeGreaterThan(10);
        expect(mesh.carriageway.indices.length).toBeGreaterThan(0);
        expect(mesh.kerbs.indices.length).toBeGreaterThan(0);
        expect(mesh.sidewalks.indices.length).toBeGreaterThan(0);
        expect(mesh.carriageway.uv.length).toBe((mesh.carriageway.positions.length / 3) * 2);
        for (let i = 0; i < mesh.carriageway.uv.length; i++) { expect(mesh.carriageway.uv[i]).toBeGreaterThanOrEqual(0); expect(mesh.carriageway.uv[i]).toBeLessThanOrEqual(1); }
        // the photo from above: dark on the street, the ground colour beside it
        const photo = renderTopDownPhoto(fs.readFileSync(tileFile), mesh.uvFrame, { texelM: 0.25 });
        expect(photo.triangles).toBeGreaterThan(1000);
        const at = (x: number, z: number) => {
            const px = Math.floor((x - mesh.uvFrame.x0) / photo.texelM), py = Math.floor((z - mesh.uvFrame.z0) / photo.texelM);
            const o = (py * photo.width + px) * 4;
            return [photo.rgba[o], photo.rgba[o + 1], photo.rgba[o + 2]];
        };
        const near = (a: number[], b: number[], tol: number) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) <= tol;
        expect(near(at(0, 1), ROAD_RGB, 40), `street ${at(0, 1)}`).toBe(true);
        expect(near(at(0, 7), GROUND_RGB, 40), `ground ${at(0, 7)}`).toBe(true);
        expect(near(at(-5, -15), GROUND_RGB, 40), `median ${at(-5, -15)}`).toBe(true);
        const jpeg = topDownJpeg(photo);
        const file = path.join(WORK, 'roads.glb');
        const written = writeRoadsGlb(file, mesh, { stations: mesh.stats.stations }, { jpeg, width: photo.width, height: photo.height });
        expect(written.bytes).toBeGreaterThan(jpeg.length);
        const { json } = parseGlb(fs.readFileSync(file));
        expect(json.images).toHaveLength(1);
        expect(json.images[0].mimeType).toBe('image/jpeg');
        expect(json.materials[1].pbrMetallicRoughness.baseColorTexture.index).toBe(0);
        for (const m of json.meshes) { expect(m.primitives[0].attributes.TEXCOORD_0).toBeDefined(); expect(m.primitives[0].material).toBe(1); }
        expect(json.nodes[0].extras.sbRoads.uvFrame).toEqual(mesh.uvFrame);
        const counts = measureGlbMeshCounts(fs.readFileSync(file));
        expect(counts.triangleCount).toBe(mesh.stats.triangles);
    });
});
