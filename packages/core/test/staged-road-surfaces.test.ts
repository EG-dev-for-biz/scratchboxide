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
import { synthesizeRoadTextures } from '../src/node/3d-engine/staged-location/road-texture';
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
    trees: [{ x: -12, z: 5.5, height: 9, radius: 3.5 }],
    roadMarkings: true
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

    it('moves a station from a vector line that misses the street onto the measured lane, and drops a line under a roof', () => {
        const scan = loadScanMesh(tileFile);
        const grid = { ...surfaceModel(scan, 0.5), cellM: 0.5 };
        // Google's line 1.5 m south of the street's centre: every station is centred back between the kerbs, still 4 m out.
        // minRunLengthM is relaxed here: this checks snapping and centring, not the conservative run-length gate (covered below)
        const off = measureRoadSurfaces({ roads: [[[-28, 1.5], [28, 1.5]]], grid, within: () => true, exclude: (x, z) => Math.hypot(x + 12, z - 5.5) < 3.8 }, { ...ROAD_SURFACE_PARAMS, minRunLengthM: 0 });
        const mid = off.flatMap(r => r.stations).filter(s => Math.abs(s.x - 10) > 6 && Math.abs(s.x + 12) > 6);
        expect(mid.length).toBeGreaterThan(10);
        for (const s of mid) {
            expect(Math.abs(s.z)).toBeLessThanOrEqual(0.6);
            expect(Math.abs(s.shiftM)).toBeGreaterThan(1.0);
            expect(Math.abs(s.left.halfWidthM - 4)).toBeLessThanOrEqual(0.6);
            expect(Math.abs(s.right.halfWidthM - 4)).toBeLessThanOrEqual(0.6);
        }
        // a line that runs under a building (a tunnel): its stations over the roof stand 12 m above the terrain and are left out,
        // and the road becomes two runs, one each side of the building
        const roofed = buildSyntheticTile({ halfSize: 30, spacing: 0.5, trees: [], building: { x0: -8, z0: -27, x1: 8, z1: -23, height: 12 } });
        const f = path.join(WORK, 'roofed.glb');
        fs.writeFileSync(f, roofed);
        const g2 = { ...surfaceModel(loadScanMesh(f), 0.5), cellM: 0.5 };
        // (both-kerb gating off here: the flat ground shows none, and the gate under test is the terrain one)
        const tunnel = measureRoadSurfaces({ roads: [[[-28, -25], [28, -25]]], grid: g2, within: () => true, groundAt: () => 0 }, { ...ROAD_SURFACE_PARAMS, requireBothKerbs: false, minRunLengthM: 4 });
        expect(tunnel.length).toBe(2);
        expect(tunnel[0].dropped.aboveGround).toBeGreaterThanOrEqual(6);
        for (const r of tunnel) for (const s of r.stations) { expect(Math.abs(s.x)).toBeGreaterThan(7); expect(s.profile[2]).toBeLessThan(0.2); }
        // the flat ground shows no kerb: the widths are the default and say so
        expect(tunnel[0].measuredKerbShare).toBe(0);
        expect(tunnel[0].stations[0].left.kerb).toBe('vector-modelled');
        // conservative by default: with no kerb measured nothing is built at all
        expect(measureRoadSurfaces({ roads: [[[-28, -25], [28, -25]]], grid: g2, within: () => true, groundAt: () => 0 })).toEqual([]);
        // the trees come first: a measured crown over the main street takes its stations out of the road
        const treed = measureRoadSurfaces({ roads: [[[-28, 0], [28, 0]]], grid, within: () => true, exclude: (x, z) => Math.hypot(x + 12, z - 5.5) < 3.8, avoid: [{ x: 0, z: 2, radiusM: 3 }] });
        const xs = treed.flatMap(r => r.stations.map(s => s.x));
        expect(xs.some(x => Math.abs(x) <= 2)).toBe(false);
        expect(treed.reduce((n, r) => n + r.dropped.underTree, 0)).toBeGreaterThanOrEqual(2);
    });

    it('builds the ribbons once at the crossing, with kerb faces and sidewalks, and writes a textured GLB that reads the photo', () => {
        const mesh = buildRoadMesh(roads);
        expect(mesh.stats.roads).toBe(3);
        // conservative gating (both kerbs required) already stops each ribbon short of a crossing it cannot measure
        // cleanly, so there is nothing left to skip there
        expect(mesh.stats.skippedQuads).toBe(0);
        expect(mesh.stats.medians).toBeGreaterThan(10);
        expect(mesh.carriageway.indices.length).toBeGreaterThan(0);
        expect(mesh.kerbs.indices.length).toBeGreaterThan(0);
        // conservative: no sidewalk strips are built (the measured sidewalks stay in the stations for the tool's report)
        expect(mesh.sidewalks.indices.length).toBe(0);
        expect(roads[0].stations.some(s => s.left.sidewalk)).toBe(true);
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
        expect(near(at(3, 2.5), ROAD_RGB, 40), `street ${at(3, 2.5)}`).toBe(true);
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

    it('reads the tarmac and the lane markings along each street from the photo and redraws them, solid or dashed as measured', () => {
        const planar = buildRoadMesh(roads);
        const photo = renderTopDownPhoto(fs.readFileSync(tileFile), planar.uvFrame, { texelM: 0.1 });
        const atlas = synthesizeRoadTextures(roads, photo, planar.uvFrame);
        expect(atlas.stats.runs).toBe(roads.length);
        expect(atlas.height).toBeLessThanOrEqual(4096);
        const ew = atlas.bands.get(roads[0].id)!, ns = atlas.bands.get(roads[1].id)!;
        // the tarmac is the street's own colour, the sidewalk the ground's
        const near = (a: number[], b: number[], tol: number) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])) <= tol;
        expect(near(ew.tarmacRgb, ROAD_RGB, 40), `tarmac ${ew.tarmacRgb}`).toBe(true);
        expect(near(ew.sidewalkRgb, GROUND_RGB, 40), `sidewalk ${ew.sidewalkRgb}`).toBe(true);
        // the main street carries a dashed white centre line (5 m on, 5 m off), the side street a solid one
        const centreEw = ew.markings.find(m => Math.abs(m.acrossShare - 0.5) < 0.12);
        expect(centreEw, JSON.stringify(ew.markings)).toBeDefined();
        expect(centreEw!.dashed).toBe(true);
        expect(Math.abs(centreEw!.dashM! - 5)).toBeLessThanOrEqual(1.5);
        expect(Math.abs(centreEw!.gapM! - 5)).toBeLessThanOrEqual(1.5);
        expect(centreEw!.rgb[0]).toBeGreaterThan(180);
        expect(centreEw!.widthM).toBeLessThanOrEqual(0.45);
        const centreNs = ns.markings.find(m => Math.abs(m.acrossShare - 0.5) < 0.12);
        expect(centreNs, JSON.stringify(ns.markings)).toBeDefined();
        expect(centreNs!.dashed).toBe(false);
        // the band is painted: the centre row white on a dash, the tarmac beside it; the across stripes (every 10 m) are gone
        const px = (band: typeof ew, col: number, row: number) => { const o = ((band.row0 + row) * atlas.width + col) * 4; return [atlas.rgba[o], atlas.rgba[o + 1], atlas.rgba[o + 2]]; };
        const midRow = Math.min(ew.rows - 1, Math.floor(centreEw!.acrossShare * ew.rows));
        // the run starts at x = -28: the painted dashes lie at x in [-30, -25), [-20, -15) ... so along 0.5 m is on one, 7.5 m is off
        const onDash = px(ew, 2, midRow), offDash = px(ew, Math.round(7.5 / 0.2), midRow);
        expect(onDash[0]).toBeGreaterThan(180);
        expect(near(offDash, ROAD_RGB, 40), `off dash ${offDash}`).toBe(true);
        expect(near(px(ew, 10, 3), ROAD_RGB, 40)).toBe(true);
        // the ribbons take road-aligned UVs into the band
        const mesh = buildRoadMesh(roads, ROAD_SURFACE_PARAMS, atlas);
        for (let i = 0; i < mesh.carriageway.uv.length; i += 2) {
            expect(mesh.carriageway.uv[i]).toBeGreaterThanOrEqual(0); expect(mesh.carriageway.uv[i]).toBeLessThanOrEqual(1);
            expect(mesh.carriageway.uv[i + 1]).toBeGreaterThanOrEqual(0); expect(mesh.carriageway.uv[i + 1]).toBeLessThanOrEqual(1);
        }
        const vs = Array.from({ length: mesh.carriageway.uv.length / 2 }, (_, i) => mesh.carriageway.uv[i * 2 + 1] * atlas.height);
        expect(Math.min(...vs)).toBeGreaterThanOrEqual(ew.row0 - 1e-6);
    });
});
