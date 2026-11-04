/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Kerbs and gutters as geometry (road-kerbs.ts) and the scan carved under them (road-carve.ts), on synthetic surfaces:
 * cross-sections read across a kerb (its face, a gutter's dip, a ramp's slope, a wall, nothing), and a scanned crossing
 * (two 8 m streets, 0.13 m kerbs, 3 m corners, a 4 cm gutter on one side, a ramp, a lump and a tall object on the road)
 * measured by SB-Roadie, its kerbs read again, swept, joined around the corners, and the scan carved under them: the lump
 * gone, the tall object kept, the scan's rim on the new surfaces' edge with no crack between them.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadScanMesh, surfaceModel } from '../src/node/spatial/StreetViewSurveyPlanner';
import { measureRoadSurfaces, ROAD_SURFACE_PARAMS, type RoadSurface } from '../src/node/3d-engine/staged-location/road-surfaces';
import {
    buildKerbedRoadMesh, measureKerbs, planarFrameOf, readKerbSection, ROAD_KERB_PARAMS, scanHeightIndex, withGlbImage, writeKerbedRoadsGlb, type HeightAt, type KerbModel,
    type KerbedRoadMesh
} from '../src/node/3d-engine/staged-location/road-kerbs';
import { carveUnderRoads, isRoadCarved, prepareFootprint, type RoadCarveReport } from '../src/node/3d-engine/staged-location/road-carve';
import { writeStagedGlbFile } from '../src/node/3d-engine/staged-location/staged-glb-writer';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { renderTopDownPhoto } from '../src/node/3d-engine/staged-location/top-down-photo';
import * as jpegJs from 'jpeg-js';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-kerbs-'));
afterAll(() => fs.rmSync(WORK, { recursive: true, force: true }));

// ---- cross-sections: a kerb line along z at x = 0, the road at x < 0, the sidewalk at x > 0, read outward along +x ----
const read = (h: HeightAt, at = 0) => readKerbSection(h, at, 0, 1, 0, 0, 1);
/** A step of `rise` at x = 0, smeared over `smear` m (as the scan's triangles smear a face). */
const step = (rise: number, smear = 0.2) => (x: number) => (x <= -smear / 2 ? 0 : x >= smear / 2 ? rise : ((x + smear / 2) / smear) * rise);

describe('a kerb read across', () => {
    it('finds the face at the half-rise crossing and its height, with no gutter on a flat road', () => {
        const r = read((x: number) => step(0.12)(x), -0.3);
        expect(r.kind).toBe('kerb');
        // read 0.3 m inside the face: it stands 0.3 m outward
        expect(Math.abs(r.shiftM - 0.3)).toBeLessThan(0.03);
        expect(Math.abs(r.faceM - 0.12)).toBeLessThan(0.01);
        expect(r.gutter).toBeUndefined();
    });

    it('measures a gutter where the scan dips at the face\'s foot', () => {
        // a pan 0.4 m wide, 4 cm deep at the face, the road level beyond it; the kerb 0.13 m above the road
        const h = (x: number) => (x < -0.4 ? 0 : x < 0 ? -0.04 * ((x + 0.4) / 0.4) : 0) + step(0.13 + 0.04 * 0, 0.1)(x) + (x >= 0.05 ? 0 : 0);
        const r = read(h);
        expect(r.kind).toBe('kerb');
        expect(r.gutter).toBeDefined();
        expect(Math.abs(r.gutter!.depthM - 0.04)).toBeLessThan(0.01);
        expect(Math.abs(r.gutter!.widthM - 0.4)).toBeLessThan(0.12);
    });

    it('reads a ramp where the face drops to the road and the sidewalk slopes up behind it', () => {
        // flush with the road at the line, rising 1:12 to the sidewalk 0.15 m up
        const h = (x: number) => (x <= 0 ? 0 : Math.min(0.15, x / 12));
        const r = read(h);
        expect(r.kind).toBe('ramp');
        expect(r.reason).toMatch(/ramp/);
    });

    it('reads nothing on a flat surface, and no kerb where a wall stands', () => {
        expect(read(() => 0).kind).toBe('none');
        const wall = read((x: number) => (x > 0.3 ? 2.5 : 0));
        expect(wall.kind).toBe('none');
        expect(wall.reason).toMatch(/wall or an object/);
    });
});

// ---- a scanned crossing ----
// the kerbs between the scan's vertex rows (as a real kerb falls anywhere between them)
const R_CORNER = 3, KERB = 0.13, HALF = 4.1, CX = 10;
/** The surface: two streets crossing at (CX, 0), blocks between them at the kerb's height with rounded corners. */
function surface(x: number, z: number): number {
    const dx = Math.abs(x - CX) - HALF, dz = Math.abs(z) - HALF;
    const block = dx > 0 && dz > 0 && !(dx < R_CORNER && dz < R_CORNER && (R_CORNER - dx) ** 2 + (R_CORNER - dz) ** 2 > R_CORNER ** 2);
    let y: number;
    if (block) {
        y = KERB;
        // a ramp on the north side of the east-west street: flush at the kerb line, rising 1:12 behind it
        if (z < -HALF && x >= -12 && x <= -9.5) y = Math.min(KERB, (-HALF - z) / 12);
    } else {
        // the road: a crown on the east-west street, a 4 cm gutter along its south kerb west of the crossing
        y = Math.abs(z) <= HALF && Math.abs(x - CX) > HALF ? 0.04 * (1 - (z / HALF) ** 2) : 0;
        if (z > 0 && z <= HALF && x < 5) y -= 0.04 * Math.max(0, 1 - (HALF - z) / 0.4);
        // a lump left on the carriageway (0.3 m), and a tall object standing on it (1.5 m)
        y += 0.3 * Math.max(0, 1 - Math.hypot(x + 15, z - 1) / 0.6);
        if (Math.abs(x + 5) < 0.3 && Math.abs(z + 1.5) < 0.3) y += 1.5;
    }
    return y;
}

// every arm of the crossing longer than SB-Roadie's shortest run (20 m)
const X0 = -30, X1 = 50, Z0 = -34, Z1 = 34, STEP = 0.25;
function scanGlb(file: string): void {
    const nx = Math.round((X1 - X0) / STEP) + 1, nz = Math.round((Z1 - Z0) / STEP) + 1;
    const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        const x = X0 + i * STEP, z = Z0 + k * STEP, v = k * nx + i;
        pos.set([x, surface(x, z), z], v * 3);
        uv.set([i / (nx - 1), k / (nz - 1)], v * 2);
    }
    const idx: number[] = [];
    for (let k = 0; k + 1 < nz; k++) for (let i = 0; i + 1 < nx; i++) { const a = k * nx + i, b = a + 1, c = a + nx, d = c + 1; idx.push(a, c, b, b, c, d); }
    // a small photo, so the scan carries texture coordinates the carve must carry through its cuts
    const photo = jpegJs.encode({ data: Buffer.alloc(4 * 4 * 4, 128), width: 4, height: 4 }, 90).data;
    writeStagedGlbFile(file, [{ name: 'scan', positions: pos, indices: Uint32Array.from(idx), uv }], { texture: { bytes: photo, mimeType: 'image/jpeg' } });
}

let roads: RoadSurface[];
let model: KerbModel;
let mesh: KerbedRoadMesh;
let scanFile: string;
let h: HeightAt;
const P = { ...ROAD_SURFACE_PARAMS, liftM: 0 };

beforeAll(() => {
    scanFile = path.join(WORK, 'scan.glb');
    scanGlb(scanFile);
    const scan = loadScanMesh(scanFile);
    const grid = { ...surfaceModel(scan, 0.5), cellM: 0.5 };
    roads = measureRoadSurfaces({ roads: [[[X0 + 1, 0], [X1 - 1, 0]], [[CX, Z0 + 1], [CX, Z1 - 1]]], grid, within: (x, z) => x > X0 + 0.5 && x < X1 - 0.5 && Math.abs(z) < Z1 - 0.5 }, P);
    h = scanHeightIndex(scan, 1);
    model = measureKerbs(roads, h, P);
    mesh = buildKerbedRoadMesh(model, 'metres');
});

describe('the scan read on its triangles', () => {
    it('gives the surface between grid points, not the cell top', () => {
        // inside the gutter's pan: linear between the scan's 0.25 m vertices
        expect(h(-20.1, 3.9)).toBeCloseTo(surface(-20.1, 3.9), 2);
        expect(h(-20, 6)).toBeCloseTo(KERB, 5);
        expect(Number.isNaN(h(100, 100))).toBe(true);
    });
});

describe('kerbs from SB-Roadie\'s streets', () => {
    it('reads each kerb again on the scan: the face within a few centimetres, its height the measured rise plus the gutter', () => {
        expect(roads.length).toBeGreaterThanOrEqual(4);
        const ew = model.runs.flatMap(r => r.samples).filter(s => Math.abs(s.tx) > 0.9 && (s.x < -16 || (s.x > -8 && s.x < 0)));
        expect(ew.length).toBeGreaterThan(5);
        for (const s of ew) {
            for (const side of ['left', 'right'] as const) {
                const k = s[side]!;
                expect(k).toBeDefined();
                expect(k.source).not.toBe('between');
                // the face stands within the scan's own step: between its last road vertex (4 m from the centre) and its first sidewalk one
                const fz = s.z + s.nz * (side === 'left' ? -1 : 1) * k.offsetM;
                expect(Math.abs(fz)).toBeGreaterThan(HALF - 0.02);
                expect(Math.abs(fz)).toBeLessThan(HALF + STEP + 0.02);
                expect(k.faceM).toBeGreaterThan(KERB - 0.03);
                expect(k.faceM).toBeLessThan(KERB + 0.04 + 0.05);
            }
        }
        expect(model.stats.fineM).toBeGreaterThan(model.stats.coarseM);
        expect(model.stats.drawnM).toBeGreaterThan(80);
        expect(model.stats.drawnM).toBeLessThanOrEqual(model.stats.measuredM + model.stats.cornerM + model.stats.straightJoinM + 1);
    });

    it('measures the gutter where the scan dips at the kerb, and labels the plausible one elsewhere with its reason', () => {
        const ew = model.runs.flatMap(r => r.samples).filter(s => Math.abs(s.tx) > 0.9 && s.x < -16);
        const south = ew.map(s => (s.nz > 0 ? s.right : s.left)!), north = ew.map(s => (s.nz > 0 ? s.left : s.right)!);
        const measured = south.filter(k => k.gutter.source === 'measured');
        expect(measured.length / south.length).toBeGreaterThan(0.7);
        for (const k of measured) {
            expect(Math.abs(k.gutter.depthM - 0.04)).toBeLessThan(0.012);
            expect(Math.abs(k.gutter.widthM - 0.4)).toBeLessThan(0.15);
        }
        for (const k of north) {
            expect(k.gutter.source).toBe('generated');
            expect(k.gutter.depthM).toBe(ROAD_KERB_PARAMS.gutterDepthM);
            expect(k.gutter.reason).toMatch(/plausible gutter/);
        }
        expect(model.stats.gutterMeasuredM).toBeGreaterThan(10);
        expect(model.stats.gutterGeneratedM).toBeGreaterThan(10);
    });

    it('drops the kerb to the road at the ramp the scan shows, and keeps it up either side', () => {
        const ew = model.runs.flatMap(r => r.samples).filter(s => Math.abs(s.tx) > 0.9 && s.x < 0);
        const northOf = (s: typeof ew[number]) => (s.nz > 0 ? s.left : s.right);
        const inRamp = ew.filter(s => s.x > -11.6 && s.x < -9.9).map(northOf).filter(Boolean);
        const beside = ew.filter(s => (s.x > -20 && s.x < -14) || (s.x > -7 && s.x < -2)).map(northOf).filter(Boolean);
        expect(inRamp.length).toBeGreaterThan(0);
        for (const k of inRamp) { expect(k!.ramp).toBe(true); expect(k!.topY - (k!.footY + k!.gutter.depthM)).toBeLessThan(0.05); }
        for (const k of beside) { expect(k!.ramp).toBe(false); expect(k!.topY - (k!.footY + k!.gutter.depthM)).toBeGreaterThan(0.1); }
        expect(model.stats.rampM).toBeGreaterThan(1);
    });

    it('joins the kerbs around the four corners on the measured radius, on the block\'s own curve', () => {
        const corners = model.joins.filter(j => j.kind === 'corner' && j.drawn);
        expect(corners.length).toBe(4);
        for (const c of corners) {
            expect(Math.abs(c.radiusM! - R_CORNER)).toBeLessThan(0.35);
            expect(c.rays!.hits).toBeGreaterThanOrEqual(ROAD_KERB_PARAMS.cornerMinHits);
            // anchored on both runs: the join starts and ends on their own cross-sections
            expect(c.pieces[0][0].anchor).toBeDefined();
            expect(c.pieces[c.pieces.length - 1][c.pieces[c.pieces.length - 1].length - 1].anchor).toBeDefined();
        }
        expect(model.stats.corners.radiusP50M).not.toBeNull();
        // every kerb face point drawn around a corner (the runs bending into it as the scan does, and the joins) lies on the
        // block's own curve
        const arcGap = (x: number, z: number) => {
            const ax = Math.abs(x - CX), az = Math.abs(z);
            if (!(ax < HALF + R_CORNER && az < HALF + R_CORNER && ax > HALF - 0.3 && az > HALF - 0.3)) return undefined;
            return Math.abs(Math.hypot(HALF + R_CORNER - ax, HALF + R_CORNER - az) - R_CORNER);
        };
        const points: Array<[number, number]> = corners.flatMap(c => c.pieces.flat().map(p => [p.x, p.z] as [number, number]));
        for (const r of model.runs) for (const s of r.samples) for (const [side, sign] of [['left', -1], ['right', 1]] as const) {
            const k = s[side];
            if (k) points.push([s.x + s.nx * sign * k.offsetM, s.z + s.nz * sign * k.offsetM]);
        }
        const gaps = points.map(([x, z]) => arcGap(x, z)).filter((g): g is number => g !== undefined);
        expect(gaps.length).toBeGreaterThanOrEqual(8);
        expect(Math.max(...gaps)).toBeLessThan(0.15);
    });
});

describe('the sweep', () => {
    it('draws every part with its label, faces toward the road and level parts up, the seams shared', () => {
        for (const k of ['carriageway:measured', 'face:measured', 'nosing:generated', 'top:generated', 'gutter:measured', 'gutter:generated']) expect(mesh.parts.has(k)).toBe(true);
        const normal = (p: { positions: Float32Array }, t: [number, number, number]) => {
            const v = (i: number) => [p.positions[i * 3], p.positions[i * 3 + 1], p.positions[i * 3 + 2]];
            const [a, b, c] = t.map(v);
            const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
            return { n: [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]], c: [(a[0] + b[0] + c[0]) / 3, (a[2] + b[2] + c[2]) / 3] };
        };
        for (const key of ['carriageway:measured', 'gutter:measured', 'top:generated', 'nosing:generated']) {
            const p = mesh.parts.get(key)!;
            for (let t = 0; t < p.indices.length; t += 3) expect(normal(p, [p.indices[t], p.indices[t + 1], p.indices[t + 2]]).n[1]).toBeGreaterThan(0);
        }
        // a face toward the nearer street's centreline
        const face = mesh.parts.get('face:measured')!;
        let toward = 0, faces = 0;
        for (let t = 0; t < face.indices.length; t += 3) {
            const { n, c } = normal(face, [face.indices[t], face.indices[t + 1], face.indices[t + 2]]);
            const inEW = Math.abs(c[1]) < HALF + 0.5 && Math.abs(c[0] - CX) > HALF + R_CORNER + 0.5, inNS = Math.abs(c[0] - CX) < HALF + 0.5 && Math.abs(c[1]) > HALF + R_CORNER + 0.5;
            if (!inEW && !inNS) continue;
            faces++;
            const dir = inEW ? [0, -c[1]] : [CX - c[0], 0];
            if (n[0] * dir[0] + n[2] * dir[1] > 0) toward++;
        }
        expect(faces).toBeGreaterThan(20);
        expect(toward).toBe(faces);
        // the carriageway's edge vertices are the gutters' inner edge vertices
        const key = (p: Float32Array, i: number) => `${p[i * 3]},${p[i * 3 + 1]},${p[i * 3 + 2]}`;
        const gut = new Set<string>();
        for (const k of ['gutter:measured', 'gutter:generated']) { const p = mesh.parts.get(k)!; for (let i = 0; i < p.positions.length / 3; i++) gut.add(key(p.positions, i)); }
        const car = mesh.parts.get('carriageway:measured')!;
        let shared = 0;
        for (let i = 0; i < car.positions.length / 3; i++) if (gut.has(key(car.positions, i))) shared++;
        expect(shared).toBeGreaterThan(40);
        expect(mesh.footprint.length).toBeGreaterThan(100);
    });

    it('writes a GLB with one node per part, each with its label and method', () => {
        const file = path.join(WORK, 'roads.glb');
        writeKerbedRoadsGlb(file, mesh, { stats: model.stats });
        const g = parseGlbBytes(fs.readFileSync(file));
        const names = (g.json.nodes ?? []).map((n: any) => n.name);
        expect(names).toEqual(expect.arrayContaining(['face_measured', 'gutter_generated', 'nosing_generated']));
        const gen = g.json.nodes.find((n: any) => n.name === 'gutter_generated');
        expect(gen.extras.provenance).toBe('generated');
        expect(gen.extras.method).toMatch(/plausible gutter/);
    });

    it('is coloured again from another photo over the same frame: the frame read off its own vertices, the image swapped, the geometry kept', () => {
        const file = path.join(WORK, 'roads-photo.glb');
        const photo = (shade: number) => Buffer.from(jpegJs.encode({ data: Buffer.alloc(16 * 16 * 4, shade), width: 16, height: 16 }, 90).data);
        // coloured as a build colours it: planar, by the photo seen from above
        const planar = buildKerbedRoadMesh(model);
        writeKerbedRoadsGlb(file, planar, { stats: model.stats }, { jpeg: photo(60), width: 16, height: 16 });
        const bytes = fs.readFileSync(file);
        const frame = planarFrameOf(bytes)!;
        expect(frame.x0).toBeCloseTo(planar.uvFrame.x0, 3);
        expect(frame.z0).toBeCloseTo(planar.uvFrame.z0, 3);
        expect(frame.widthM).toBeCloseTo(planar.uvFrame.widthM, 3);
        expect(frame.heightM).toBeCloseTo(planar.uvFrame.heightM, 3);
        const lighter = photo(200), out = withGlbImage(bytes, lighter);
        const a = parseGlbBytes(bytes), b = parseGlbBytes(out);
        const view = b.json.bufferViews[b.json.images[0].bufferView];
        expect(Buffer.from(b.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength)).equals(lighter)).toBe(true);
        // every accessor reads the same as before
        expect(b.json.accessors.length).toBe(a.json.accessors.length);
        for (let i = 0; i < a.json.accessors.length; i++) expect(Array.from(readAccessor(b, i).data)).toEqual(Array.from(readAccessor(a, i).data));
        expect(b.json.nodes.map((n: any) => n.extras)).toEqual(a.json.nodes.map((n: any) => n.extras));
    });

    it('sees the ground from above to scale at the ground\'s level, a tower beside it or not', () => {
        // a 100 m square of ground at 0 m and a 200 m tower's roof over one corner; the photo of the ground's square: at the
        // tower's height (the default) the ground is drawn 1 / 15 small toward the centre, its edges short of the photo's
        const quad = (x0: number, x1: number, z0: number, z1: number, y: number) => [x0, y, z0, x0, y, z1, x1, y, z0, x1, y, z0, x0, y, z1, x1, y, z1];
        const pos = Float32Array.from([...quad(-50, 50, -50, 50, 0), ...quad(40, 50, 40, 50, 200)]);
        const uv = new Float32Array(pos.length / 3 * 2).fill(0.5);
        const file = path.join(WORK, 'tower.glb');
        writeStagedGlbFile(file, [{ positions: pos, uv }], { texture: { bytes: jpegJs.encode({ data: Buffer.alloc(64, 250), width: 4, height: 4 }, 90).data, mimeType: 'image/jpeg' } });
        const frame = { x0: -50, z0: -50, widthM: 100, heightM: 100 };
        const grey = (ph: ReturnType<typeof renderTopDownPhoto>) => {
            // the background (128) in the middle row, left of the centre: the ground did not reach there
            const row = Math.floor(ph.height / 2);
            let n = 0;
            for (let c = 0; c < ph.width / 2; c++) if (ph.rgba[(row * ph.width + c) * 4] < 200) n++;
            return n;
        };
        const atTop = renderTopDownPhoto(fs.readFileSync(file), frame, { texelM: 0.5 }), atGround = renderTopDownPhoto(fs.readFileSync(file), frame, { texelM: 0.5, referenceY: 0 });
        expect(grey(atTop)).toBeGreaterThan(4);
        expect(grey(atGround)).toBeLessThanOrEqual(1);
    });
});

describe('the scan carved under the new surfaces', () => {
    let carved: Buffer;
    let report: RoadCarveReport;
    beforeAll(() => {
        const out = carveUnderRoads(fs.readFileSync(scanFile), prepareFootprint(mesh.footprint));
        carved = out.glb;
        report = out.report;
    });

    /** Every live triangle of a GLB, as positions. */
    const triangles = (bytes: Uint8Array) => {
        const g = parseGlbBytes(bytes), out: number[][] = [];
        for (const m of g.json.meshes) for (const p of m.primitives) {
            const X = readAccessor(g, p.attributes.POSITION).data, I = readAccessor(g, p.indices).data;
            for (let t = 0; t + 2 < I.length; t += 3) {
                if (I[t] === I[t + 1] || I[t + 1] === I[t + 2] || I[t] === I[t + 2]) continue;
                out.push([...[0, 1, 2].flatMap(k => [X[I[t + k] * 3], X[I[t + k] * 3 + 1], X[I[t + k] * 3 + 2]])]);
            }
        }
        return out;
    };

    it('removes the scan under them, the lump with it, and keeps what stands taller on the street', () => {
        expect(report.removed).toBeGreaterThan(1000);
        expect(report.cut).toBeGreaterThan(100);
        expect(report.standing).toBeGreaterThan(0);
        expect(isRoadCarved(carved)).toBe(true);
        const tris = triangles(carved);
        const nearLump = tris.filter(t => Math.hypot((t[0] + t[3] + t[6]) / 3 + 15, (t[2] + t[5] + t[8]) / 3 - 1) < 0.5);
        expect(nearLump.length).toBe(0);
        const atObject = tris.filter(t => Math.abs((t[0] + t[3] + t[6]) / 3 + 5) < 0.25 && Math.abs((t[2] + t[5] + t[8]) / 3 + 1.5) < 0.25 && Math.max(t[1], t[4], t[7]) > 1);
        expect(atObject.length).toBeGreaterThan(0);
    });

    it('meets the new surfaces with no crack: every open edge of the carved scan lies on an open edge of the streets, and back', () => {
        expect(report.pinned).toBeGreaterThan(100);
        expect(report.maxPinM).toBeLessThanOrEqual(0.25);
        // the open edges of a triangle soup, welded by exact position
        const openEdges = (tris: number[][]) => {
            const count = new Map<string, { n: number; a: number[]; b: number[] }>();
            for (const t of tris) for (let k = 0; k < 3; k++) {
                const a = t.slice(k * 3, k * 3 + 3), b = t.slice(((k + 1) % 3) * 3, ((k + 1) % 3) * 3 + 3);
                const ka = a.join(','), kb = b.join(','), key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
                const e = count.get(key);
                if (e) e.n++; else count.set(key, { n: 1, a, b });
            }
            return [...count.values()].filter(e => e.n === 1);
        };
        const roadTris: number[][] = [];
        for (const p of mesh.parts.values()) for (let t = 0; t < p.indices.length; t += 3) roadTris.push([0, 1, 2].flatMap(k => [p.positions[p.indices[t + k] * 3], p.positions[p.indices[t + k] * 3 + 1], p.positions[p.indices[t + k] * 3 + 2]]));
        const scanOpen = openEdges(triangles(carved)), roadOpen = openEdges(roadTris);
        const border = (p: number[]) => p[0] < X0 + 0.3 || p[0] > X1 - 0.3 || p[2] < Z0 + 0.3 || p[2] > Z1 - 0.3;
        // the distance from a point to the nearest of some edges (a grid of 1 m cells over them)
        const index = (edges: Array<{ a: number[]; b: number[] }>) => {
            const cells = new Map<string, number[]>();
            edges.forEach((e, i) => { for (let x = Math.floor(Math.min(e.a[0], e.b[0])); x <= Math.floor(Math.max(e.a[0], e.b[0])); x++) for (let z = Math.floor(Math.min(e.a[2], e.b[2])); z <= Math.floor(Math.max(e.a[2], e.b[2])); z++) { const k = `${x},${z}`; const l = cells.get(k); if (l) l.push(i); else cells.set(k, [i]); } });
            return (p: number[], self = -1) => {
                let best = Infinity;
                for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const i of cells.get(`${Math.floor(p[0]) + dx},${Math.floor(p[2]) + dz}`) ?? []) {
                    if (i === self) continue;
                    const { a, b } = edges[i], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
                    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / l2)) : 0;
                    best = Math.min(best, Math.hypot(a[0] + t * d[0] - p[0], a[1] + t * d[1] - p[1], a[2] + t * d[2] - p[2]));
                }
                return best;
            };
        };
        const nearRoad = index(roadOpen), nearScan = index(scanOpen);
        // a cut triangle's pieces may meet with a vertex on one side of their shared edge only (a T-junction, collinear: no
        // crack), so an open edge of the scan lies on the streets' outline or along another of the scan's own open edges
        // the tall object stands inside the footprint with its own open base: those edges are not the rim
        const object = (p: number[]) => Math.abs(p[0] + 5) < 0.6 && Math.abs(p[2] + 1.5) < 0.6;
        let checked = 0, worst = 0;
        scanOpen.forEach((e, i) => { for (const f of [0.25, 0.5, 0.75]) {
            const p = [0, 1, 2].map(k => e.a[k] + (e.b[k] - e.a[k]) * f);
            if (border(p) || object(p)) continue;
            checked++;
            worst = Math.max(worst, Math.min(nearRoad(p), nearScan(p, i)));
        } });
        expect(checked).toBeGreaterThan(500);
        expect(worst).toBeLessThan(2e-3);
        // and every open edge of the streets meets the scan's rim, or lies on the streets' own surface (where two runs already
        // meet on a corner's curve, the short join between their end sections overlaps them: covered, not open to the scan)
        const onRoad = (p: number[], e: { a: number[]; b: number[] }) => roadTris.some(t => {
            const same = (q: number[]) => [0, 3, 6].some(o => t[o] === q[0] && t[o + 1] === q[1] && t[o + 2] === q[2]);
            if (same(e.a) && same(e.b)) return false;
            const [ax, ay, az, bx, by, bz, cx, cy, cz] = t, det = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
            if (Math.abs(det) < 1e-9) return false;
            const u = ((p[0] - ax) * (cz - az) - (p[2] - az) * (cx - ax)) / det, v = ((bx - ax) * (p[2] - az) - (bz - az) * (p[0] - ax)) / det;
            return u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6 && Math.abs(ay + u * (by - ay) + v * (cy - ay) - p[1]) < 2e-3;
        });
        worst = 0; checked = 0;
        let overlapped = 0;
        for (const e of roadOpen) for (const f of [0.25, 0.5, 0.75]) {
            const p = [0, 1, 2].map(k => e.a[k] + (e.b[k] - e.a[k]) * f);
            if (border(p)) continue;
            checked++;
            const d = nearScan(p);
            if (d >= 2e-3 && onRoad(p, e)) { overlapped++; continue; }
            worst = Math.max(worst, d);
        }
        expect(checked).toBeGreaterThan(200);
        expect(worst).toBeLessThan(2e-3);
        expect(overlapped).toBeLessThan(checked * 0.05);
    });
});

describe('a scan primitive drawn without an index list', () => {
    it('is carved like any other (the remesh writes some so)', () => {
        // two triangles, a triangle soup with no index list
        const soup = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 0, 1, 5, 0, 5, 6, 0, 5, 5, 0, 6]);
        const file = path.join(WORK, 'soup.glb');
        writeStagedGlbFile(file, [{ positions: soup }]);
        const g = parseGlbBytes(fs.readFileSync(file));
        for (const m of g.json.meshes) for (const p of m.primitives) delete p.indices;
        const bytes = assembleGlb(g.json, g.bin);
        // a footprint over the first triangle only, at its level
        const fp = prepareFootprint([[-1, 0, -1, 3, 0, -1, -1, 0, 3]]);
        const { glb, report } = carveUnderRoads(bytes, fp);
        expect(report.skippedPrimitives).toBe(0);
        expect(report.removed).toBe(1);
        const out = parseGlbBytes(glb);
        let live = 0;
        for (const m of out.json.meshes) for (const p of m.primitives) { const I = readAccessor(out, p.indices).data; for (let t = 0; t < I.length; t += 3) if (I[t] !== I[t + 1] && I[t + 1] !== I[t + 2] && I[t] !== I[t + 2]) live++; }
        expect(live).toBe(1);
    });
});
