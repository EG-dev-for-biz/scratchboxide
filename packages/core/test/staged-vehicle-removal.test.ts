/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Vehicle removal (vehicle-removal.ts) on a synthetic street scan: a sloping road with a lane line, a parked car draped
 * into it as a photogrammetry lump (red), and a planter beside it (green). The judge stands in for the vision model's
 * reading (the car boxed as a vehicle, the planter boxed as not one); everything after it is the real step: the proud
 * candidates, the region, the ring heights, the moved vertices, the repainted texels and the rewritten GLBs, read back.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { fillDirection, parseVehicleBatchReply, parseVehicleReply, removeVehicles, vehicleRemovalParams, VEHICLE_REMOVAL_PARAMS, type VehicleBatchJudge, type VehicleJudge } from '../src/node/3d-engine/staged-location/vehicle-removal';
import { buildGroundModel, loadScanMesh } from '../src/node/spatial/StreetViewSurveyPlanner';

const HALF = 15, STEP = 0.25, TEX = 600;
const SLOPE = 0.02;
const road = (x: number) => SLOPE * x;
/** The car: an ellipse 4.4 m by 1.8 m along x at the origin, draped 1.4 m high. */
const CAR = { cx: 0, cz: 0, ax: 2.2, az: 0.9, h: 1.4 };
/** The planter: a disc of 1 m radius, 1.2 m high, east of the car. */
const PLANTER = { cx: 7, cz: 4, r: 1, h: 1.2 };
const LANE_Z = 0.15;

const carBump = (x: number, z: number) => { const q = ((x - CAR.cx) / CAR.ax) ** 2 + ((z - CAR.cz) / CAR.az) ** 2; return q < 1 ? CAR.h * Math.cos((Math.PI / 2) * q) ** 0.5 : 0; };
const planterBump = (x: number, z: number) => (Math.hypot(x - PLANTER.cx, z - PLANTER.cz) < PLANTER.r ? PLANTER.h : 0);
const height = (x: number, z: number) => road(x) + carBump(x, z) + planterBump(x, z);

/** The street's photo: grey asphalt, a white lane line along x through the car, the car red, the planter green. */
function albedo(x: number, z: number): [number, number, number] {
    if (carBump(x, z) > 0 || ((x - CAR.cx) / (CAR.ax + 0.1)) ** 2 + ((z - CAR.cz) / (CAR.az + 0.1)) ** 2 < 1) return [200, 30, 30];
    if (Math.hypot(x - PLANTER.cx, z - PLANTER.cz) < PLANTER.r + 0.1) return [40, 150, 40];
    if (Math.abs(z) < LANE_Z) return [235, 235, 235];
    return [90, 90, 90];
}

function syntheticStreet(withTexture: boolean, extra: (x: number, z: number) => number = () => 0, look = albedo, base = height): Buffer {
    const n = Math.round((2 * HALF) / STEP) + 1;
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
        const x = -HALF + i * STEP, z = -HALF + k * STEP;
        pos.push(x, base(x, z) + extra(x, z), z); nor.push(0, 1, 0); uv.push((x + HALF) / (2 * HALF), (z + HALF) / (2 * HALF));
    }
    for (let k = 0; k + 1 < n; k++) for (let i = 0; i + 1 < n; i++) {
        const a = k * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
    }
    const parts: Buffer[] = [];
    const views: any[] = [];
    let off = 0;
    const add = (b: Buffer, target?: number) => { const pad = (4 - (off % 4)) % 4; if (pad) { parts.push(Buffer.alloc(pad)); off += pad; } views.push({ buffer: 0, byteOffset: off, byteLength: b.length, ...(target ? { target } : {}) }); parts.push(b); off += b.length; return views.length - 1; };
    const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer);
    const vPos = add(f32(pos), 34962), vNor = add(f32(nor), 34962), vUv = add(f32(uv), 34962), vIdx = add(Buffer.from(new Uint32Array(idx).buffer), 34963);
    const mn = [-HALF, Math.min(...pos.filter((_, j) => j % 3 === 1)), -HALF], mx = [HALF, Math.max(...pos.filter((_, j) => j % 3 === 1)), HALF];
    const accessors: any[] = [
        { bufferView: vPos, componentType: 5126, count: n * n, type: 'VEC3', min: mn, max: mx },
        { bufferView: vNor, componentType: 5126, count: n * n, type: 'VEC3' },
        { bufferView: vUv, componentType: 5126, count: n * n, type: 'VEC2' },
        { bufferView: vIdx, componentType: 5125, count: idx.length, type: 'SCALAR' }
    ];
    const json: any = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, ...(withTexture ? { TEXCOORD_0: 2 } : {}) }, indices: 3, mode: 4, material: 0 }] }],
        materials: [withTexture ? { pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0, roughnessFactor: 1 } } : { pbrMetallicRoughness: { baseColorFactor: [0.5, 0.5, 0.5, 1] } }],
        accessors, bufferViews: views
    };
    if (withTexture) {
        const rgba = new Uint8Array(TEX * TEX * 4);
        for (let k = 0; k < TEX; k++) for (let i = 0; i < TEX; i++) {
            const c = look(-HALF + ((i + 0.5) / TEX) * 2 * HALF, -HALF + ((k + 0.5) / TEX) * 2 * HALF);
            rgba.set([c[0], c[1], c[2], 255], (k * TEX + i) * 4);
        }
        const jpg = Buffer.from(jpegJs.encode({ data: Buffer.from(rgba.buffer), width: TEX, height: TEX }, 95).data);
        const vImg = add(jpg);
        json.images = [{ bufferView: vImg, mimeType: 'image/jpeg' }];
        json.textures = [{ source: 0, sampler: 0 }];
        json.samplers = [{ magFilter: 9729, minFilter: 9729, wrapS: 33071, wrapT: 33071 }];
    }
    json.buffers = [{ byteLength: off }];
    return assembleGlb(json, Buffer.concat(parts));
}

function positionsOf(file: string): Float64Array { const g = parseGlbBytes(fs.readFileSync(file)); return readAccessor(g, g.json.meshes[0].primitives[0].attributes.POSITION).data; }
function indicesOf(file: string): Float64Array { const g = parseGlbBytes(fs.readFileSync(file)); return readAccessor(g, g.json.meshes[0].primitives[0].indices).data; }

/** The judge: what the vision model reads in this scene (the car a vehicle, the planter not), placed in plan. */
const judge: VehicleJudge = async crop => {
    const inCrop = (x: number, z: number) => x >= crop.frame.x0 && z >= crop.frame.z0 && x <= crop.frame.x0 + crop.frame.widthM && z <= crop.frame.z0 + crop.frame.heightM;
    const out = [];
    if (inCrop(CAR.cx, CAR.cz)) out.push({ label: 'parked red car', vehicle: true, permanent: false, confidence: 0.9, lo: [CAR.cx - CAR.ax - 0.15, CAR.cz - CAR.az - 0.15] as [number, number], hi: [CAR.cx + CAR.ax + 0.15, CAR.cz + CAR.az + 0.15] as [number, number], crop: crop.index });
    if (inCrop(PLANTER.cx, PLANTER.cz)) out.push({ label: 'round planter', vehicle: false, permanent: true, confidence: 0.8, lo: [PLANTER.cx - 1.1, PLANTER.cz - 1.1] as [number, number], hi: [PLANTER.cx + 1.1, PLANTER.cz + 1.1] as [number, number], crop: crop.index });
    return out;
};

describe('vehicle removal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-vehicles-'));
    const tex = path.join(dir, 'in_textured.glb'), geo = path.join(dir, 'in_geometry.glb');
    fs.writeFileSync(tex, syntheticStreet(true));
    fs.writeFileSync(geo, syntheticStreet(false));

    it('removes the car, keeps the planter, and leaves the street continuous and repainted', async () => {
        const scan = loadScanMesh(tex);
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        const out = await removeVehicles({ texturedGlb: tex, geometryGlb: geo, scan, ground, judge, outDir: path.join(dir, 'out') });
        const r = out.report;
        expect(r.candidates).toBe(2);
        expect(r.vehicles).toBe(1);
        expect(r.removed).toHaveLength(1);
        expect(r.removed[0].labels).toEqual(['parked red car']);
        expect(r.removed[0].provenance.geometry).toBe('generated');
        expect(out.texturedGlb).toBe(path.join(dir, 'out', 'textured.glb'));
        expect(out.geometryGlb).toBe(path.join(dir, 'out', 'geometry.glb'));

        const before = positionsOf(tex), after = positionsOf(out.texturedGlb), afterGeo = positionsOf(out.geometryGlb!);
        // the same triangles: no triangle removed, so no edge opened
        expect(Array.from(indicesOf(out.texturedGlb))).toEqual(Array.from(indicesOf(tex)));
        // the open edges are the grid's own border only
        const idx = indicesOf(out.texturedGlb);
        const edges = new Map<string, number>();
        for (let t = 0; t < idx.length; t += 3) for (let j = 0; j < 3; j++) {
            const a = idx[t + j], b = idx[t + ((j + 1) % 3)];
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            edges.set(key, (edges.get(key) ?? 0) + 1);
        }
        let openInside = 0;
        for (const [key, n] of edges) {
            if (n !== 1) continue;
            const [a, b] = key.split(',').map(Number);
            for (const v of [a, b]) if (Math.abs(after[v * 3]) < HALF - 1e-3 && Math.abs(after[v * 3 + 2]) < HALF - 1e-3) openInside++;
        }
        expect(openInside).toBe(0);

        let carVerts = 0, maxCarErr = 0, planterVerts = 0, maxElsewhere = 0;
        for (let v = 0; v < before.length / 3; v++) {
            const x = before[v * 3], z = before[v * 3 + 2];
            if (carBump(x, z) > 0) {
                carVerts++;
                maxCarErr = Math.max(maxCarErr, Math.abs(after[v * 3 + 1] - road(x)));
            } else if (planterBump(x, z) > 0) {
                planterVerts++;
                expect(after[v * 3 + 1]).toBe(before[v * 3 + 1]);
            } else {
                // the street away from both keeps its measured height (moved at most within the tolerance where the skirt reaches)
                maxElsewhere = Math.max(maxElsewhere, Math.abs(after[v * 3 + 1] - before[v * 3 + 1]));
            }
            // plan positions never move; the geometry twin moved the same
            expect(after[v * 3]).toBe(before[v * 3]);
            expect(after[v * 3 + 2]).toBe(before[v * 3 + 2]);
            expect(afterGeo[v * 3 + 1]).toBeCloseTo(after[v * 3 + 1], 5);
        }
        expect(carVerts).toBeGreaterThan(80);
        expect(planterVerts).toBeGreaterThan(20);
        // no lump: every vertex where the car stood lies on the road within 3 cm
        expect(maxCarErr).toBeLessThan(0.03);
        expect(maxElsewhere).toBeLessThan(0.03);

        // the texels: the car's red is gone, the asphalt continues, the lane line runs through where the car stood
        const g = parseGlbBytes(fs.readFileSync(out.texturedGlb));
        const view = g.json.bufferViews[g.json.images[0].bufferView];
        const img = decodeImageInMemory(g.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength));
        const texel = (x: number, z: number) => { const i = Math.floor(((x + HALF) / (2 * HALF)) * img.width), k = Math.floor(((z + HALF) / (2 * HALF)) * img.height); const p = (k * img.width + i) * 4; return [img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]]; };
        let red = 0, asphalt = 0, samples = 0;
        for (let x = -CAR.ax + 0.2; x <= CAR.ax - 0.2; x += 0.2) for (const z of [-0.6, -0.4, 0.4, 0.6]) {
            if (carBump(x, z) <= 0) continue;
            const [rr, gg, bb] = texel(x, z);
            samples++;
            if (rr - gg > 40) red++;
            if (Math.abs(rr - 90) < 25 && Math.abs(gg - 90) < 25 && Math.abs(bb - 90) < 25) asphalt++;
        }
        expect(samples).toBeGreaterThan(20);
        expect(red).toBe(0);
        expect(asphalt / samples).toBeGreaterThan(0.9);
        let lane = 0, laneSamples = 0;
        for (let x = -CAR.ax + 0.3; x <= CAR.ax - 0.3; x += 0.2) { laneSamples++; if (Math.min(...texel(x, 0)) > 180) lane++; }
        expect(lane / laneSamples).toBeGreaterThan(0.8);
        // the planter's photo is untouched
        const [pr, pg] = texel(PLANTER.cx, PLANTER.cz);
        expect(pg - pr).toBeGreaterThan(60);
        // labelled in the GLB
        expect(g.json.extras.sbVehicleRemoval.removed[0].provenance.geometry.label).toBe('generated');
    });

    it('leaves the scan as it is when the model reads no vehicle', async () => {
        const scan = loadScanMesh(tex);
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        const out = await removeVehicles({ texturedGlb: tex, geometryGlb: geo, scan, ground, judge: async () => [], outDir: path.join(dir, 'none') });
        expect(out.report.removed).toHaveLength(0);
        expect(out.texturedGlb).toBe(tex);
        expect(out.geometryGlb).toBe(geo);
        expect(fs.existsSync(path.join(dir, 'none', 'textured.glb'))).toBe(false);
    });

    it('places the model\'s boxes in plan (row 0 is the frame\'s minimum z)', () => {
        const r = parseVehicleReply('{"objects":[{"box_2d":[100,200,300,600],"label":"van","vehicle":true,"permanent":false,"confidence":0.8},{"box_2d":[0,0,0,0],"label":"bad"}]}', { index: 3, frame: { x0: 10, z0: -20, widthM: 50, heightM: 40 } });
        expect(r).toHaveLength(1);
        expect(r[0].lo).toEqual([20, -16]);
        expect(r[0].hi).toEqual([40, -8]);
        expect(r[0]).toMatchObject({ label: 'van', vehicle: true, permanent: false, confidence: 0.8, crop: 3 });
    });

    it('reads the crops in batches, and any crop the batch leaves out on its own, to the same result', async () => {
        const scan = loadScanMesh(tex);
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        // the batch judge answers every crop but the last of each batch, as the single judge would
        const seen: number[][] = [];
        const many: VehicleBatchJudge = async crops => {
            seen.push(crops.map(c => c.index));
            const out = new Map();
            for (const c of crops.slice(0, -1)) out.set(c.index, await judge(c));
            return out;
        };
        let singles = 0;
        const one: VehicleJudge = async c => { singles++; return judge(c); };
        const P = { ...VEHICLE_REMOVAL_PARAMS, batch: 2 };
        const out = await removeVehicles({ texturedGlb: tex, geometryGlb: geo, scan, ground, judge: one, judgeMany: many, outDir: path.join(dir, 'batched'), P });
        const r = out.report;
        expect(seen.every(b => b.length <= 2)).toBe(true);
        expect(singles).toBe(seen.length);
        expect(r.modelCalls).toBe(seen.length + singles);
        expect(r.removed).toHaveLength(1);
        expect(r.removed[0].labels).toEqual(['parked red car']);
    });

    it("parses a batch reply per image, leaving out an image it does not answer", () => {
        const crops = [{ index: 7, frame: { x0: 0, z0: 0, widthM: 10, heightM: 10 } }, { index: 9, frame: { x0: 100, z0: 0, widthM: 10, heightM: 10 } }];
        const r = parseVehicleBatchReply('{"images":[{"image":2,"objects":[{"box_2d":[0,0,500,500],"label":"car","vehicle":true}]}]}', crops);
        expect([...r.keys()]).toEqual([9]);
        expect(r.get(9)![0].lo).toEqual([100, 0]);
        expect(r.get(9)![0].crop).toBe(9);
    });
});

/**
 * Street clutter (user decision, 2026-10-30): what the model reads as neither a vehicle nor permanent goes with the vehicles,
 * and a lump too small to show it, low on the carriageway, goes as debris; a permanent fixture, and a small lump on the
 * sidewalk, stay. The same street, with a small lump in the carriageway west of the car and one on the sidewalk north of it.
 */
describe('street clutter removal', () => {
    const lump = (cx: number, cz: number) => (x: number, z: number) => (Math.hypot(x - cx, z - cz) < 0.4 ? 0.6 : 0);
    const roadLump = lump(-8, 1), walkLump = lump(-8, 9);
    const extra = (x: number, z: number) => roadLump(x, z) + walkLump(x, z);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-clutter-'));
    const tex = path.join(dir, 'in_textured.glb');
    fs.writeFileSync(tex, syntheticStreet(true, extra));
    // the carriageway: within 3 m of the street's centreline (z = 0); the sidewalk lump stands 9 m off it
    const look = { roadAt: (_x: number, z: number) => Math.abs(z) <= 3 };
    // the planter read as a vendor's cart: not a vehicle, not permanent
    const cartJudge: VehicleJudge = async crop => (await judge(crop)).map(r => (r.label === 'round planter' ? { ...r, label: "street vendor's cart", permanent: false } : r));
    const heightAt = (file: string, x: number, z: number) => {
        const p = positionsOf(file);
        let best = Infinity, y = NaN;
        for (let v = 0; v < p.length; v += 3) { const d = Math.hypot(p[v] - x, p[v + 2] - z); if (d < best) { best = d; y = p[v + 1]; } }
        return y;
    };

    it('removes a temporary object and the carriageway debris, and keeps the sidewalk lump', async () => {
        const scan = loadScanMesh(tex);
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        const out = await removeVehicles({ texturedGlb: tex, scan, ground, judge: cartJudge, look, outDir: path.join(dir, 'on') });
        const r = out.report;
        expect(r.vehicles).toBe(1);
        expect(r.temporaryRemoved).toBe(1);
        expect(r.debrisRemoved).toBe(1);
        expect(r.transientKept).toBe(0);
        expect(r.removed.map(x => x.kind).sort()).toEqual(['debris', 'temporary', 'vehicle']);
        expect(r.removed.find(x => x.kind === 'temporary')!.labels).toEqual(["street vendor's cart"]);
        expect(r.removed.find(x => x.kind === 'debris')!.reason).toMatch(/carriageway/);
        // the cart and the carriageway lump are down at the street; the sidewalk lump still stands
        expect(heightAt(out.texturedGlb, PLANTER.cx, PLANTER.cz) - road(PLANTER.cx)).toBeLessThan(0.15);
        expect(heightAt(out.texturedGlb, -8, 1) - road(-8)).toBeLessThan(0.15);
        expect(heightAt(out.texturedGlb, -8, 9) - road(-8)).toBeGreaterThan(0.5);
    });

    it('keeps them all with SCRATCHBOX_STAGED_CLUTTER=0', async () => {
        const P = vehicleRemovalParams({ SCRATCHBOX_STAGED_CLUTTER: '0' });
        expect(vehicleRemovalParams({})).toBe(VEHICLE_REMOVAL_PARAMS);
        const scan = loadScanMesh(tex);
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        const out = await removeVehicles({ texturedGlb: tex, scan, ground, judge: cartJudge, look, outDir: path.join(dir, 'off'), P });
        expect(out.report.removed.map(x => x.kind)).toEqual(['vehicle']);
        expect(out.report.transientKept).toBe(1);
        expect(heightAt(out.texturedGlb, PLANTER.cx, PLANTER.cz) - road(PLANTER.cx)).toBeGreaterThan(1);
        expect(heightAt(out.texturedGlb, -8, 1) - road(-8)).toBeGreaterThan(0.5);
    });
});

/**
 * The patch's paint follows the lanes (user report, 2026-10-30: a bus lane's red smeared into the next lane). A street at 30
 * degrees: a red bus lane, a white line, a dark lane; a bus and a car queued nose to tail in the dark lane against the line,
 * their skirt reaching over it. The patch must keep each lane's colour on its own side and carry the line through.
 */
describe('the patch paint follows the lanes', () => {
    const TH = Math.PI / 6, ca = Math.cos(TH), sa = Math.sin(TH);
    /** Across the street (+: the bus lane's side) and along it. */
    const across = (x: number, z: number) => -sa * x + ca * z, along = (x: number, z: number) => ca * x + sa * z;
    const VEHICLES = [
        { v0: -8, v1: 2, u0: -2.9, u1: -0.4, h: 3, colour: [220, 180, 40] as [number, number, number], label: 'city bus' },
        { v0: 3, v1: 7.5, u0: -2.9, u1: -0.4, h: 1.5, colour: [40, 60, 200] as [number, number, number], label: 'blue car' }
    ];
    // a photogrammetry drape: full height half a metre in from the footprint's edge
    const inset = (vh: typeof VEHICLES[number], x: number, z: number) => { const u = across(x, z), v = along(x, z); return Math.min(u - vh.u0, vh.u1 - u, v - vh.v0, vh.v1 - v); };
    const base = (x: number, z: number) => VEHICLES.reduce((y, vh) => Math.max(y, vh.h * Math.max(0, Math.min(1, inset(vh, x, z) / 0.5))), 0);
    const look = (x: number, z: number): [number, number, number] => {
        for (const vh of VEHICLES) if (inset(vh, x, z) > -0.1) return vh.colour;
        const u = across(x, z);
        return u > 0.15 ? [200, 40, 60] : u >= -0.15 ? [235, 235, 235] : [90, 90, 90];
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lanes-'));
    const tex = path.join(dir, 'in_textured.glb');
    fs.writeFileSync(tex, syntheticStreet(true, () => 0, look, base));
    const queueJudge: VehicleJudge = async crop => VEHICLES.flatMap(vh => {
        const xs: number[] = [], zs: number[] = [];
        for (const [u, v] of [[vh.u0, vh.v0], [vh.u0, vh.v1], [vh.u1, vh.v0], [vh.u1, vh.v1]]) { xs.push(-sa * u + ca * v); zs.push(ca * u + sa * v); }
        const lo: [number, number] = [Math.min(...xs) - 0.15, Math.min(...zs) - 0.15], hi: [number, number] = [Math.max(...xs) + 0.15, Math.max(...zs) + 0.15];
        const cx = (lo[0] + hi[0]) / 2, cz = (lo[1] + hi[1]) / 2;
        const inCrop = cx >= crop.frame.x0 && cz >= crop.frame.z0 && cx <= crop.frame.x0 + crop.frame.widthM && cz <= crop.frame.z0 + crop.frame.heightM;
        return inCrop ? [{ label: vh.label, vehicle: true, permanent: false, confidence: 0.9, lo, hi, crop: crop.index }] : [];
    });

    it('keeps the bus lane red, the lane beside it asphalt, and the line between them white', async () => {
        const scan = loadScanMesh(tex);
        const ground = buildGroundModel(scan, { cellMeters: 1 });
        const out = await removeVehicles({ texturedGlb: tex, scan, ground, judge: queueJudge, outDir: path.join(dir, 'out') });
        expect(out.report.removed).toHaveLength(1);
        const g = parseGlbBytes(fs.readFileSync(out.texturedGlb));
        const view = g.json.bufferViews[g.json.images[0].bufferView];
        const img = decodeImageInMemory(g.bin.subarray(view.byteOffset, view.byteOffset + view.byteLength));
        const texel = (u: number, v: number) => {
            const x = -sa * u + ca * v, z = ca * u + sa * v;
            const p = (Math.floor(((z + HALF) / (2 * HALF)) * img.height) * img.width + Math.floor(((x + HALF) / (2 * HALF)) * img.width)) * 4;
            return [img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]];
        };
        let lane = 0, red = 0, laneSamples = 0, line = 0, lineSamples = 0, busLane = 0, busSamples = 0;
        for (let v = -7.5; v <= 7; v += 0.25) {
            for (const u of [-2.6, -2, -1.4, -0.8]) {
                const [r, gg, b] = texel(u, v);
                laneSamples++;
                if (r - gg > 40) red++;
                if (Math.abs(r - 90) < 25 && Math.abs(gg - 90) < 25 && Math.abs(b - 90) < 25) lane++;
            }
            lineSamples++;
            if (Math.min(...texel(0, v)) > 180) line++;
            const [r, gg] = texel(0.26, v);
            busSamples++;
            if (r - gg > 80) busLane++;
        }
        expect(red).toBe(0);
        expect(lane / laneSamples).toBeGreaterThan(0.95);
        expect(line / lineSamples).toBeGreaterThan(0.8);
        expect(busLane / busSamples).toBeGreaterThan(0.8);
    });

    it('reads the direction the markings run from the photo', () => {
        const W = 160, H = 120, phi = (25 * Math.PI) / 180;
        const val = new Float32Array(W * H * 3), dist = new Int32Array(W * H).fill(1);
        for (let k = 0; k < H; k++) for (let i = 0; i < W; i++) {
            const stripe = (((-Math.sin(phi) * i + Math.cos(phi) * k) / 12) % 1 + 1) % 1 < 0.3 ? 200 : 60;
            val.set([stripe, stripe, stripe], (k * W + i) * 3);
        }
        const { dir: d, coherence } = fillDirection(val, () => true, dist, W, H, 0.05, [1, 0]);
        expect(Math.abs(d[0] * Math.cos(phi) + d[1] * Math.sin(phi))).toBeGreaterThan(Math.cos((2 * Math.PI) / 180));
        expect(coherence).toBeGreaterThan(0.8);
        // no markings: the fallback (the region's long axis)
        const flat = fillDirection(new Float32Array(W * H * 3).fill(90), () => true, dist, W, H, 0.05, [0, 1]);
        expect(flat.dir).toEqual([0, 1]);
    });
});
