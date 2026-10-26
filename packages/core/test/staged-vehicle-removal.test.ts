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
import { parseVehicleReply, removeVehicles, type VehicleJudge } from '../src/node/3d-engine/staged-location/vehicle-removal';
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

function syntheticStreet(withTexture: boolean): Buffer {
    const n = Math.round((2 * HALF) / STEP) + 1;
    const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
        const x = -HALF + i * STEP, z = -HALF + k * STEP;
        pos.push(x, height(x, z), z); nor.push(0, 1, 0); uv.push((x + HALF) / (2 * HALF), (z + HALF) / (2 * HALF));
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
            const c = albedo(-HALF + ((i + 0.5) / TEX) * 2 * HALF, -HALF + ((k + 0.5) / TEX) * 2 * HALF);
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
});
