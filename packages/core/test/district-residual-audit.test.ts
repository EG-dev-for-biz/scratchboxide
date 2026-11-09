/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The residual audit on a district (district-residual-audit.ts), on a synthetic street with the native measures (no network,
 * no model): the scan splits into the ground, the building and what stands in the street; a pole the leaf scan collapsed to a
 * sheet of needle triangles, which the surface measures alone call an artefact, is re-judged an upright standing on the street
 * (its first verdict and reason kept), while the same sheet hanging in the air stays an artefact; the counts follow; rail lines
 * along a road and on their own way are told apart by measurement; Google's FEATURE_TYPE_RAIL lines are decoded as rails.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { auditDistrict, buildingClearance, DISTRICT_AUDIT_PARAMS, districtAuditSplit, districtStreetAuditSummary, measureRailLines, railContexts, uprightMeasure } from '../src/node/3d-engine/staged-location/district-residual-audit';
import { decodeFeatureTile } from '../src/node/spatial/google-feature-tile-decoder';
import type { GroundModel, ScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

type P3 = [number, number, number];

/** A ScanMesh over a triangle soup (each triangle its own three vertices). */
function scanOf(soup: number[]): ScanMesh {
    const V = Float32Array.from(soup), n = V.length / 9;
    const I = Uint32Array.from({ length: n * 3 }, (_, i) => i);
    const triCentroid = new Float32Array(n * 3), triArea = new Float32Array(n), triNormal = new Float32Array(n * 3);
    for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) triCentroid[t * 3 + k] = (V[t * 9 + k] + V[t * 9 + 3 + k] + V[t * 9 + 6 + k]) / 3;
    const min: P3 = [Infinity, Infinity, Infinity], max: P3 = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < V.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], V[i + k]); max[k] = Math.max(max[k], V[i + k]); }
    return { mesh: { vertices: V, indices: I } as unknown as ScanMesh['mesh'], triCount: n, triNormal, triArea, triCentroid, triTexelMeters: new Float32Array(n).fill(NaN), bounds: { min, max } };
}

/** Flat street at y = 0 over x, z in [-R, R] (1 m cells). */
function flatGround(R: number): GroundModel {
    const nx = 2 * R, nz = 2 * R;
    const ground = new Float32Array(nx * nz).fill(0), top = new Float32Array(nx * nz).fill(0), open = new Uint8Array(nx * nz).fill(1);
    return {
        cellMeters: 1, x0: -R, z0: -R, nx, nz, top, ground, open, terrainMethod: 'walkable-surface',
        cellIndex: (x, z) => Math.floor(z + R) * nx + Math.floor(x + R),
        groundAt: (x, z) => (Math.abs(x) <= R && Math.abs(z) <= R ? 0 : NaN),
        topAt: () => 0
    };
}

const tri = (o: number[], a: P3, b: P3, c: P3) => o.push(...a, ...b, ...c);
const quad = (o: number[], a: P3, b: P3, c: P3, d: P3) => { tri(o, a, b, c); tri(o, a, c, d); };
function box(o: number[], lo: P3, hi: P3): void {
    quad(o, [lo[0], hi[1], lo[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]]);
    quad(o, [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]]);
    quad(o, [lo[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], lo[1], hi[2]]);
    quad(o, [lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [lo[0], hi[1], hi[2]], [lo[0], lo[1], hi[2]]);
    quad(o, [hi[0], lo[1], lo[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]]);
}
/** A pole as the leaf scan draws it: two needle triangles in a vertical sheet from y0 to y1 (0.6 m wide at the foot). */
function needlePole(o: number[], x: number, z: number, y0: number, y1: number): void {
    tri(o, [x - 0.3, y0, z], [x + 0.3, y0, z], [x, y1, z]);
    tri(o, [x - 0.3, y0, z], [x, y1, z], [x - 0.05, y1 - 0.4, z]);
}

const R = 40;
const BUILDING = { lo: [10, 0, -10] as P3, hi: [30, 15, 10] as P3 };
const buildingAt = (x: number, z: number) => (x >= BUILDING.lo[0] && x <= BUILDING.hi[0] && z >= BUILDING.lo[2] && z <= BUILDING.hi[2] ? 1 : 0);

function street(): { soup: number[]; groundTris: number } {
    const o: number[] = [];
    for (let x = -R; x < R; x += 4) for (let z = -R; z < R; z += 4) quad(o, [x, 0, z], [x, 0, z + 4], [x + 4, 0, z + 4], [x + 4, 0, z]);
    const groundTris = o.length / 9;
    box(o, BUILDING.lo, BUILDING.hi);
    needlePole(o, -10, 19, 0, 7);     // standing by the track, clear of the building
    needlePole(o, -20, -5, 4, 9);     // the same sheet hanging 4 m up, touching nothing
    return { soup: o, groundTris };
}

const RAIL_ALONG_ROAD: Vec2[] = [[-R, 20], [R, 20]];
const ROAD: Vec2[] = [[-R, 22], [R, 22]];
const RAIL_OWN_WAY: Vec2[] = [[-R, -35], [R, -35]];

describe('the district split', () => {
    it('puts the building and the ground in the solid and only what stands in the street in the candidates', () => {
        const { soup, groundTris } = street();
        const s = districtAuditSplit(scanOf(soup), flatGround(R), { buildingAt, within: (x, z) => Math.abs(x) <= R && Math.abs(z) <= R });
        // the box's five faces and the street under and beside it belong to the building; the rest of the street is ground
        expect(s.stats.buildingTriangles).toBeGreaterThan(10);
        expect(s.stats.buildingTriangles - 10 + s.stats.apronTriangles).toBe(groundTris);
        expect(s.stats.candidateTriangles).toBe(4);           // two needle triangles per pole
        expect(s.stats.outsideTriangles).toBe(0);
        expect(s.stats.buildingTriangles + s.stats.apronTriangles + s.stats.candidateTriangles).toBe(s.stats.scanTriangles);
        expect(s.stats.groundTriangles).toBe((2 * R - 1) * (2 * R - 1) * 2);
        expect(s.solid.length / 9).toBe(s.stats.buildingTriangles + s.stats.groundTriangles);
    });
});

describe('the measures', () => {
    it('tells a track along a street from one on its own way, by its distance to the road centrelines', () => {
        const lines = measureRailLines([RAIL_ALONG_ROAD, RAIL_OWN_WAY], [ROAD]);
        expect(lines[0].streetRunningShare).toBe(1);
        expect(lines[1].streetRunningShare).toBe(0);
        expect(lines[0].lengthM).toBeCloseTo(2 * R, 6);
    });

    it('measures a row of clusters along a track: its pitch and how steady it is', () => {
        const lines = measureRailLines([RAIL_ALONG_ROAD], [ROAD]);
        const at = (id: number, x: number) => ({ id, lo: [x - 0.3, 0, 18.5] as P3, hi: [x + 0.3, 7, 18.7] as P3 });
        const steady = railContexts([at(0, -30), at(1, -0), at(2, 30), at(3, 15), at(4, -15)], lines);
        expect(steady.size).toBe(5);
        expect(steady.get(2)!.row).toEqual({ members: 5, pitchM: 15, pitchRegularity: 1 });
        const ragged = railContexts([at(0, -30), at(1, -27), at(2, 5), at(3, 6), at(4, 30)], lines);
        expect(ragged.get(0)!.row!.pitchRegularity).toBeLessThan(0.5);
        expect(railContexts([{ id: 9, lo: [0, 0, 0], hi: [1, 1, 1] }], lines).size).toBe(0);  // 17 m off the track
    });

    it('calls a slender vertical cluster with its foot at the street an upright, and not one hanging, squat or against a wall', () => {
        const pole = { lo: [-10.3, 0, 19] as P3, hi: [-9.7, 7, 19] as P3, frame: { extentsM: [0.6, 7, 0.02] as P3 } as never, shape: { mainAxisVerticality: 0.99 } as never };
        const flat = () => 0;
        expect(uprightMeasure(pole, flat, buildingAt).score).toBe(1);
        expect(uprightMeasure({ ...pole, lo: [-10.3, 4, 19], hi: [-9.7, 11, 19] }, flat, buildingAt).score).toBe(0);
        expect(uprightMeasure({ ...pole, frame: { extentsM: [5, 7, 3] } as never }, flat, buildingAt).score).toBe(0);
        expect(uprightMeasure({ ...pole, lo: [8.7, 0, 0], hi: [9.3, 7, 0] }, flat, buildingAt).score).toBe(0);
        expect(buildingClearance(buildingAt, -10, 19)).toBe(12);
        expect(buildingClearance(buildingAt, 8, 0)).toBe(2);
    });
});

describe('auditDistrict (native measures)', () => {
    it('re-judges the needle pole an upright, keeps the hanging sheet an artefact, and recounts', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'district-audit-'));
        const { soup } = street();
        const r = await auditDistrict({ scan: scanOf(soup), ground: flatGround(R), buildingAt, within: (x, z) => Math.abs(x) <= R && Math.abs(z) <= R, rails: [RAIL_ALONG_ROAD, RAIL_OWN_WAY], roads: [ROAD], dir });
        expect(r.audit.clusters).toHaveLength(2);
        const byX = (x: number) => r.audit.clusters.find(c => c.lo[0] < x && c.hi[0] > x)!;
        const pole = byX(-10), hanging = byX(-20);
        // the pole: an artefact or unsure by its surface alone, re-judged, its first verdict and reason kept
        expect(pole.verdict).toBe('real-object');
        expect(pole.feature.types).toContain('SB_FEATURE_TYPE_POLE');
        expect(pole.feature.types).toContain('SB_FEATURE_TYPE_STREET_FURNITURE');
        expect(pole.feature.measurements.uprightScore).toBe(1);
        expect(pole.reason).toMatch(/an upright standing on the street clear of the buildings, 7 m tall/);
        const re = r.reassessed.find(x => x.id === pole.id)!;
        expect(re.from).not.toBe('real-object');
        expect(pole.reason).toContain(re.auditReason);
        // by the street-running track, 1 m off it
        expect(r.railContexts[pole.id].streetRunningShare).toBe(1);
        expect(r.railContexts[pole.id].distanceM).toBeLessThan(1.5);
        // the hanging sheet is not an upright
        expect(hanging.verdict).not.toBe('real-object');
        expect(hanging.feature.types).not.toContain('SB_FEATURE_TYPE_POLE');
        expect(r.railContexts[hanging.id]).toBeUndefined();
        // the counts follow the re-judged verdicts
        expect(r.audit.counts.realObjects).toBe(1);
        expect(r.audit.candidates).toEqual([pole.id]);
        expect(r.audit.counts.realObjects + r.audit.counts.artefacts + r.audit.counts.unsure).toBe(2);
        expect(r.audit.notes[0]).toMatch(/1 real objects \(1 uprights, 1 of them re-judged/);
        // the summary catalogues the pole, never an artefact
        const sum = districtStreetAuditSummary(r);
        expect(sum.catalog.map(c => c.id)).toContain(pole.id);
        expect(sum.catalog.find(c => c.id === pole.id)!.type).toBe('SB_FEATURE_TYPE_POLE');
        for (const c of sum.catalog) expect(r.audit.clusters.find(k => k.id === c.id)!.verdict).not.toBe('scan-artefact');
        expect(sum.rails).toEqual({ lines: 2, streetRunning: 1, clustersNear: 1 });
    }, 600_000);
});

describe('Google vector tiles: rail lines', () => {
    it('decodes FEATURE_TYPE_RAIL lines as rails, not roads', () => {
        const line = { vertexOffsets: { xOffsets: [100, 200], yOffsets: [100, 0] } };
        const d = decodeFeatureTile({ x: 0, y: 0, zoom: 17, features: [
            { types: ['FEATURE_TYPE_INFRASTRUCTURE', 'FEATURE_TYPE_RAIL'], geometry: { lines: [line] } },
            { types: ['FEATURE_TYPE_INFRASTRUCTURE', 'FEATURE_TYPE_ROAD'], geometry: { lines: [line] } }
        ] } as never);
        expect(d.rails).toHaveLength(1);
        expect(d.roads).toHaveLength(1);
        expect(d.rails[0].points).toHaveLength(2);
    });
});

/** A ScanMesh over a soup with its corners welded (shared vertices, as a remeshed scan has them) and face normals. */
function weldedScanOf(soup: number[]): ScanMesh {
    const key = (i: number) => `${soup[i].toFixed(4)},${soup[i + 1].toFixed(4)},${soup[i + 2].toFixed(4)}`;
    const at = new Map<string, number>(), verts: number[] = [], idx: number[] = [];
    for (let i = 0; i < soup.length; i += 3) { const k = key(i); let v = at.get(k); if (v === undefined) { v = verts.length / 3; at.set(k, v); verts.push(soup[i], soup[i + 1], soup[i + 2]); } idx.push(v); }
    const s = scanOf(soup), V = Float32Array.from(verts), I = Uint32Array.from(idx);
    for (let t = 0; t < s.triCount; t++) {
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ux = V[b] - V[a], uy = V[b + 1] - V[a + 1], uz = V[b + 2] - V[a + 2], vx = V[c] - V[a], vy = V[c + 1] - V[a + 1], vz = V[c + 2] - V[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
        s.triNormal.set([nx / l, ny / l, nz / l], t * 3); s.triArea[t] = l / 2;
    }
    return { ...s, mesh: { vertices: V, indices: I } as unknown as ScanMesh['mesh'] };
}

describe('walls past the footprint\'s band', () => {
    it('gives the building a wall that runs on past its footprint\'s band, with its recesses, but not what stands off it', () => {
        const o: number[] = [];
        // a facade 1.7 m west of the footprint's west edge (x = 10), in 1 m panels from z = -10 to z = 16: the part past
        // z = 10 runs beyond the footprint's corner; a window recess 0.3 m deep in the far part
        const X = 8.3;
        for (let z = -10; z < 16; z++) for (let y = 0; y < 6; y++) {
            if (z === 13 && (y === 2 || y === 3)) continue;   // the window's opening
            quad(o, [X, y, z], [X, y + 1, z], [X, y + 1, z + 1], [X, y, z + 1]);
        }
        // the window recess: its back 0.3 m in, joined to the wall by its four reveals
        const B = X - 0.3;
        quad(o, [B, 2, 13], [B, 4, 13], [B, 4, 14], [B, 2, 14]);
        quad(o, [X, 2, 13], [B, 2, 13], [B, 2, 14], [X, 2, 14]);
        quad(o, [X, 4, 13], [X, 4, 14], [B, 4, 14], [B, 4, 13]);
        quad(o, [X, 2, 13], [X, 4, 13], [B, 4, 13], [B, 2, 13]);
        quad(o, [X, 2, 14], [B, 2, 14], [B, 4, 14], [X, 4, 14]);
        const wallTris = o.length / 9;
        // a balcony slab on the far part, standing 1.6 m off the wall (sharing the wall's corner at y = 3)
        quad(o, [X, 3, 14], [X - 1.6, 3, 14], [X - 1.6, 3, 15], [X, 3, 15]);
        // a post 4 m off, touching nothing
        needlePole(o, 3.5, 14, 0, 4);
        const within = (x: number, z: number) => Math.abs(x) <= R && Math.abs(z) <= R;
        const scan = weldedScanOf(o);
        const s = districtAuditSplit(scan, flatGround(R), { buildingAt, within });
        // the wall's panels the band holds seed the walk; the panels past it are claimed, recess included
        expect(s.stats.wallTriangles).toBeGreaterThan(0);
        // every wall triangle is the building's; the balcony and the post stay in the street
        const cand = s.sources[0].localTriangles!;
        expect(cand.every(t => t >= wallTris)).toBe(true);
        // the balcony's outer triangle (centroid 1.07 m off the wall) and the post's two stay; the balcony's inner triangle
        // (centroid 0.53 m off, within the wall's band) goes with the wall: what lies within the band counts as wall
        expect(cand).toEqual([wallTris, wallTris + 2, wallTris + 3]);
        expect(s.stats.buildingTriangles).toBe(wallTris + 1);
        // the same scene as a soup (every triangle its own corners, as some remeshed chunks are): the walk meets at the
        // positions the corners share, and claims the same
        const welded = weldedScanOf(o);
        const soupScan = { ...welded, mesh: { vertices: Float32Array.from(o), indices: Uint32Array.from({ length: o.length / 3 }, (_, i) => i) } as unknown as ScanMesh['mesh'] };
        const soup = districtAuditSplit(soupScan, flatGround(R), { buildingAt, within });
        expect(soup.sources[0].localTriangles).toEqual(cand);
        // the same scene without the wall rule (band 0): the far panels fall to the candidates
        const off = districtAuditSplit(scan, flatGround(R), { buildingAt, within }, { ...DISTRICT_AUDIT_PARAMS, wallBandM: -1 });
        expect(off.stats.candidateTriangles).toBeGreaterThan(cand.length);
        expect(off.stats.wallTriangles).toBe(0);
    });
});
