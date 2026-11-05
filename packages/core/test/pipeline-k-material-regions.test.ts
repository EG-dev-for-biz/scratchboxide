/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's material regions (pipeline-k/material-regions.ts, tile-refine-twin.ts): one material path for every surface:
 * each texel takes its detected class's library set (occlusion, roughness, metalness and normal as the set has them) at
 * the set's real size, whatever the window fit or the lattice read there; a speckle under regionSmoothM never flips a
 * texel; the photo stays the colour; the twin written lit with the maps and labels.
 */

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { planMaterialRegions, readRegionClasses, regionClassMap, regionRadius, type RegionClass, type RegionSet } from '../src/node/3d-engine/staged-location/pipeline-k/material-regions';
import { planMaterialRegionsOnThreads } from '../src/node/3d-engine/staged-location/pipeline-k/material-regions-pool';
import { tileRefineTwin } from '../src/node/3d-engine/staged-location/tile-refine-twin';
import { decodeImageInMemory, type RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const PX = 0.1; // metres per texel of the facade photos

/** A 20 x 30 m facade: light piers every 5 m (1.5 m wide), brown spandrels, two 1 x 1.8 m panes per bay a storey (3.5 m), every third storey's panes reflecting the sky. */
function piered(): RgbaImage8 {
    const W = 200, H = 300, rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xm = (x * PX) % 5, ym = (y * PX) % 3.5, storey = Math.floor((y * PX) / 3.5);
        let c = [70, 55, 50];
        if (xm < 1.5) c = [190, 185, 175];
        else if (((xm >= 1.9 && xm < 2.9) || (xm >= 3.6 && xm < 4.6)) && ym >= 0.8 && ym < 2.6) c = storey % 3 === 2 ? [120, 150, 160] : [25, 30, 40];
        rgba.set([...c, 255], (y * W + x) * 4);
    }
    return { width: W, height: H, rgba };
}

/** A 10 x 15 m wall of grey stone with irregular dark weathering: no pier rhythm. */
function weathered(): RgbaImage8 {
    const W = 100, H = 150, rgba = new Uint8Array(W * H * 4);
    let s = 12345;
    const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    const blots = Array.from({ length: 25 }, () => [rnd() * W, rnd() * H, 3 + rnd() * 8]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const dark = blots.some(([bx, by, r]) => (x - bx) ** 2 + (y - by) ** 2 < r * r);
        rgba.set([...(dark ? [70, 55, 50] : [190, 185, 175]), 255], (y * W + x) * 4);
    }
    return { width: W, height: H, rgba };
}

/** A scan piece's photo: all spandrel brown. */
function brown(): RgbaImage8 {
    const W = 64, H = 32, rgba = new Uint8Array(W * H * 4);
    for (let k = 0; k < W * H; k++) rgba.set([70, 55, 50, 255], k * 4);
    return { width: W, height: H, rgba };
}

interface Quad { mesh: string; corners: number[]; uv: number[]; relief?: number; material: number; extras?: unknown }

/** Named meshes of single quads, each on a material with its own embedded PNG. */
function scene(quads: Quad[], photos: RgbaImage8[]): Uint8Array {
    const idx = new Uint32Array([0, 1, 2, 0, 2, 3]);
    const chunks: Uint8Array[] = [], views: any[] = [], accessors: any[] = [];
    let length = 0;
    const push = (b: Uint8Array) => { views.push({ buffer: 0, byteOffset: length, byteLength: b.length }); chunks.push(b); length += b.length; const pad = (4 - (length % 4)) % 4; if (pad) { chunks.push(new Uint8Array(pad)); length += pad; } return views.length - 1; };
    const acc = (view: number, count: number, type: string, componentType = 5126) => { accessors.push({ bufferView: view, componentType, count, type }); return accessors.length - 1; };
    const meshes = quads.map(q => {
        const attributes: Record<string, number> = {
            POSITION: acc(push(new Uint8Array(new Float32Array(q.corners).buffer)), 4, 'VEC3'),
            TEXCOORD_0: acc(push(new Uint8Array(new Float32Array(q.uv).buffer)), 4, 'VEC2')
        };
        if (q.relief !== undefined) attributes._RELIEF_HEIGHT = acc(push(new Uint8Array(new Float32Array([q.relief, q.relief, q.relief, q.relief]).buffer)), 4, 'SCALAR');
        return { name: q.mesh, primitives: [{ attributes, indices: acc(push(new Uint8Array(idx.buffer)), 6, 'SCALAR', 5125), material: q.material, mode: 4 }] };
    });
    const images = photos.map(p => ({ bufferView: push(new Uint8Array(encodePng(p.width, p.height, Buffer.from(p.rgba), 4))), mimeType: 'image/png' }));
    const bin = new Uint8Array(length);
    let o = 0;
    for (const c of chunks) { bin.set(c, o); o += c.length; }
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: quads.map((_, k) => k) }], nodes: quads.map((q, k) => ({ mesh: k, ...(q.extras ? { extras: q.extras } : {}) })), meshes,
        extensionsUsed: ['KHR_materials_unlit'],
        materials: photos.map((_, k) => ({ name: `m${k}`, pbrMetallicRoughness: { baseColorTexture: { index: k } }, extensions: { KHR_materials_unlit: {} } })),
        textures: photos.map((_, k) => ({ source: k })), images, accessors, bufferViews: views, buffers: [{ byteLength: bin.length }]
    };
    return assembleGlb(json as never, bin);
}

/** A wall quad facing +z from (x0, 0) to (x0 + w, h) in the plane z, UVs (0,0) at its top left. */
const wall = (x0: number, w: number, h: number, z = 0) => [x0, h, z, x0, 0, z, x0 + w, 0, z, x0 + w, h, z];
const FULL_UV = [0, 0, 0, 1, 1, 1, 1, 0];

function building(): { glb: Uint8Array; photos: RgbaImage8[] } {
    const photos = [piered(), weathered(), brown()];
    const quads: Quad[] = [
        { mesh: 'facade_lattice_1', corners: wall(0, 20, 30), uv: FULL_UV, material: 0 },
        // a wall face of its own, 5 m behind
        { mesh: 'facade_lattice_2', corners: wall(30, 10, 15, -5), uv: FULL_UV, material: 1 },
        // a scan piece: its left half on a relief recess, its right half flush
        { mesh: 'relief_m0', corners: wall(50, 5, 5), uv: [0, 0, 0, 1, 0.5, 1, 0.5, 0], relief: -0.25, material: 2 },
        { mesh: 'relief_m1', corners: wall(55, 5, 5), uv: [0.5, 0, 0.5, 1, 1, 1, 1, 0], relief: 0, material: 2 }
    ];
    return { glb: scene(quads, photos), photos };
}

/** Each class's set: its own occlusion (250 - 10 x index), roughness (64 + 32 x index), metalness (40 x index) and normal tilt (128 + 8 x index in x). */
const ormOf = (c: RegionClass) => [250 - 10 * c.index, 64 + 32 * c.index, 40 * c.index];
function sets(classes: RegionClass[]): RegionSet[] {
    return classes.map(c => {
        const orm = { width: 8, height: 8, rgba: new Uint8Array(256) }, normal = { width: 8, height: 8, rgba: new Uint8Array(256) };
        for (let k = 0; k < 64; k++) { orm.rgba.set([...ormOf(c), 255], k * 4); normal.rgba.set([128 + 8 * c.index, 128, 255, 255], k * 4); }
        return { name: `TestSet${c.index}`, realSizeM: [1, 1], normal, orm, distance: 0 };
    });
}

const imagesOf = (photos: RgbaImage8[]) => new Map(photos.map((p, i) => [i, { ...p, rgba: p.rgba.slice() }]));

const at = (img: RgbaImage8, x: number, y: number) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

describe('pipeline K material regions', () => {
    it("gives every texel its detected class's set, with every map the set has, whatever the windows", () => {
        const { glb, photos } = building();
        const g = parseGlbBytes(glb);
        const images = imagesOf(photos);
        const classes = readRegionClasses(g.json, images)!;
        expect(classes).toHaveLength(4);
        const plan = planMaterialRegions(g, g.json, images, classes, sets(classes));
        const facade = plan.materials.find(m => m.material === 0)!;
        expect(facade.rebuilt).toBe(true);
        const cls = regionClassMap(photos[0], classes, regionRadius(PX));
        // a pier, a spandrel, a dark pane and a sky pane: each its own class's occlusion, roughness, metalness and normal
        const probes: Array<[number, number]> = [[7, 150], [24, 5], [24, 15], [24, 85]];
        for (const [x, y] of probes) {
            const c = classes[cls[y * photos[0].width + x]];
            expect(at(facade.orm, x, y)).toEqual([...ormOf(c), 255]);
            expect(at(facade.normal!, x, y)[0]).toBe(128 + 8 * c.index);
        }
        // the pier is the lightest class, the dark pane the darkest: different sets, each drawn with its own metalness
        expect(cls[150 * 200 + 7]).toBe(3);
        expect(cls[15 * 200 + 24]).toBe(0);
        expect(at(facade.orm, 24, 15)[2]).toBe(0);
        expect(at(facade.orm, 7, 150)[2]).toBe(120);
        // the classes drawn on the piered facade, the shares adding up
        const shares = plan.report.facades.perFacade.find(f => f.mesh === 'facade_lattice_1')!.classShares;
        expect(shares.filter(v => v > 0).length).toBeGreaterThanOrEqual(3);
        expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2);
        expect(plan.report.texels.perClass.reduce((a, b) => a + b, 0)).toBe(plan.report.texels.total);
    });
    it('reads the materials inside the window openings apart from those outside, so a pane and a panel of one colour are two', () => {
        // a 20 x 20 m wall of grey panels with grey glass of the same colour in 2 x 2 m windows (fitted), and light piers
        const W = 200, H = 200, rgba = new Uint8Array(W * H * 4), windows: number[] = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba.set([...(x % 50 < 10 ? [200, 196, 188] : [92, 96, 100]), 255], (y * W + x) * 4);
        for (let b = 0; b < 4; b++) for (let st = 0; st < 5; st++) windows.push((b * 50 + 20) / W, (st * 40 + 10) / H, (b * 50 + 40) / W, (st * 40 + 30) / H);
        const extras = { sbFacadeLattice: { facadeId: 1, windows: { uv: windows } } };
        const g = parseGlbBytes(scene([{ mesh: 'facade_lattice_1', corners: wall(0, 20, 20), uv: FULL_UV, material: 0, extras }], [{ width: W, height: H, rgba }]));
        const images = imagesOf([{ width: W, height: H, rgba }]);
        const classes = readRegionClasses(g.json, images)!;
        expect(classes.filter(c => c.openings)).toHaveLength(2);
        expect(classes.find(c => c.wall)!.openings).toBe(false);
        const plan = planMaterialRegions(g, g.json, images, classes, sets(classes));
        const orm = plan.materials[0].orm;
        // the glass (inside a window) and the panel (outside) share a colour but not a material
        const pane = at(orm, 30, 20), panel = at(orm, 45, 20);
        expect(pane).not.toEqual(panel);
        const opening = new Set(classes.filter(c => c.openings).map(c => ormOf(c).join()));
        expect(opening.has(pane.slice(0, 3).join())).toBe(true);
        expect(opening.has(panel.slice(0, 3).join())).toBe(false);
    });
    it('draws a speckle under regionSmoothM as the surface around it; a blot a metre across keeps its own set', () => {
        const W = 100, H = 100, rgba = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const blot = x >= 60 && x < 70 && y >= 60 && y < 70, speck = x === 20 && y === 20;
            rgba.set([...(blot || speck ? [25, 30, 40] : [190, 185, 175]), 255], (y * W + x) * 4);
        }
        const img = { width: W, height: H, rgba };
        const g = parseGlbBytes(scene([{ mesh: 'facade_lattice_1', corners: wall(0, 10, 10), uv: FULL_UV, material: 0 }], [img]));
        const b = building(), classes = readRegionClasses(parseGlbBytes(b.glb).json, imagesOf(b.photos))!;
        const orm = planMaterialRegions(g, g.json, imagesOf([img]), classes, sets(classes)).materials[0].orm;
        expect([regionRadius(0.03), regionRadius(0), regionRadius(0.001)]).toEqual([5, 1, 32]);
        expect(at(orm, 20, 20)).toEqual(at(orm, 25, 25));
        expect(at(orm, 65, 65)).not.toEqual(at(orm, 25, 25));
    });
    it("draws a scan piece's texels with their class's set's mean finish, no normal", () => {
        const { glb, photos } = building();
        const g = parseGlbBytes(glb);
        const classes = readRegionClasses(g.json, imagesOf(photos))!;
        const plan = planMaterialRegions(g, g.json, imagesOf(photos), classes, sets(classes));
        const scan = plan.materials.find(m => m.material === 2)!;
        expect(scan.rebuilt).toBe(false);
        expect(scan.normal).toBeUndefined();
        const c = classes[regionClassMap(photos[2], classes, 1)[0]];
        expect(at(scan.orm, 10, 10)).toEqual([...ormOf(c), 255]);
        expect(plan.report.scanPieces.total).toBe(1);
    });
    it('plans the same maps and report on worker threads as on one thread', async () => {
        const { glb, photos: flat } = building();
        // photo noise, so texels of one colour bucket differ (each thread's colour cache fills in its own order)
        const photos = flat.map((p, i) => ({ ...p, rgba: p.rgba.map((v, k) => (k % 4 === 3 ? v : Math.max(0, Math.min(255, v + ((k * 7919 + i * 104729) % 13) - 6)))) }));
        const g = parseGlbBytes(glb);
        const classes = readRegionClasses(g.json, imagesOf(photos))!;
        const one = planMaterialRegions(g, g.json, imagesOf(photos), classes, sets(classes));
        const many = await planMaterialRegionsOnThreads(g, g.json, imagesOf(photos), classes, sets(classes), undefined, { threads: 3 });
        expect(many.materials.length).toBeGreaterThan(1);
        expect(many.materials.map(m => m.material)).toEqual(one.materials.map(m => m.material));
        many.materials.forEach((m, i) => {
            const o = one.materials[i];
            expect(Buffer.from(m.orm.rgba).equals(Buffer.from(o.orm.rgba))).toBe(true);
            expect(!!m.normal && Buffer.from(m.normal.rgba).equals(Buffer.from(o.normal!.rgba))).toBe(!!o.normal);
            expect(m.rebuilt).toBe(o.rebuilt);
        });
        expect({ ...many.report, ms: 0 }).toEqual({ ...one.report, ms: 0 });
    });
    it('keeps the photo as the base colour everywhere', () => {
        const { glb, photos } = building();
        const g = parseGlbBytes(glb);
        const images = imagesOf(photos);
        const classes = readRegionClasses(g.json, images)!;
        planMaterialRegions(g, g.json, images, classes, sets(classes));
        photos.forEach((p, i) => expect(Buffer.from(images.get(i)!.rgba).equals(Buffer.from(p.rgba))).toBe(true));
    });
    it('writes the twin lit, with the maps, the extras and the labels', async () => {
        const { glb } = building();
        const twin = await tileRefineTwin(glb, 'esb', { harmonize: { groundY: 0 }, materialRegions: { sets: async classes => sets(classes) } });
        expect(twin.materialRegions && 'version' in twin.materialRegions).toBe(true);
        const g = parseGlbBytes(twin.glb);
        const json: any = g.json;
        expect(json.extensionsUsed ?? []).not.toContain('KHR_materials_unlit');
        const m = json.materials[0];
        expect(m.extensions?.KHR_materials_unlit).toBeUndefined();
        expect(m.pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
        expect(m.occlusionTexture.index).toBe(m.pbrMetallicRoughness.metallicRoughnessTexture.index);
        expect(m.normalTexture).toBeDefined();
        expect(m.extras.sbMaterial).toEqual({ schema: 'scratchbox.staged-material/1', provenanceIndices: expect.any(Array) });
        expect(m.extras.sbMaterialRegions.maps.label).toBe('generated');
        expect(m.extras.sbMaterialRegions.material.label).toBe('photo-inferred');
        expect(m.extras.sbMaterialRegions.baseColor.label).toBe('photo-inferred');
        const prov = json.asset.extras.sbTexture.provenance;
        expect(prov.find((p: any) => p.source === 'material-regions').label).toBe('generated');
        expect(prov.find((p: any) => p.source === 'facade-material-reading')).toBeUndefined();
        // the ORM decodes with a set's own metalness where its class lies
        const src = json.textures[m.pbrMetallicRoughness.metallicRoughnessTexture.index].source;
        const view = json.bufferViews[json.images[src].bufferView];
        const orm = decodeImageInMemory(g.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
        expect(Math.max(...Array.from({ length: orm.width * orm.height }, (_, k) => orm.rgba[k * 4 + 2]))).toBeGreaterThan(60);
    });
    it('leaves the twin unlit and says why when the library cannot give the sets', async () => {
        const { glb } = building();
        const twin = await tileRefineTwin(glb, 'esb', { harmonize: { groundY: 0 }, materialRegions: { sets: async () => { throw new Error('no credentials'); } } });
        expect(twin.materialRegions).toEqual({ skipped: 'the library sets could not be resolved: no credentials' });
        const json: any = parseGlbBytes(twin.glb).json;
        expect(json.materials[0].extensions?.KHR_materials_unlit).toBeDefined();
        expect(json.materials[0].pbrMetallicRoughness.metallicRoughnessTexture).toBeUndefined();
    });
});
