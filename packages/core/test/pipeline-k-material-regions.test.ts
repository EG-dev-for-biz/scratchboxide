/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's material regions (pipeline-k/material-regions.ts, tile-refine-twin.ts): nothing drawn metal; openings
 * only from the window fit (its panes glass, the rest of each window one frame finish), the wall's set everywhere else
 * whatever the colour; the twin written lit with the maps and labels.
 */

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { GLASS_ROUGHNESS } from '../src/node/3d-engine/staged-location/facade-materials';
import { MATERIAL_REGIONS_PARAMS, paneSeed, planMaterialRegions, readRegionClasses, type RegionClass, type RegionSet } from '../src/node/3d-engine/staged-location/pipeline-k/material-regions';
import { planMaterialRegionsOnThreads } from '../src/node/3d-engine/staged-location/pipeline-k/material-regions-pool';
import { tileRefineTwin } from '../src/node/3d-engine/staged-location/tile-refine-twin';
import type { FittedPlane } from '../src/node/3d-engine/staged-location/window-fit';
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

/** Flat-normal sets, each class its own roughness (wall 179, the others 64 + 16 x index), every set's metalness map full (so drawn metal anywhere would show). */
const roughnessOf = (c: RegionClass) => (c.wall ? 179 : 64 + 16 * c.index);
function sets(classes: RegionClass[]): RegionSet[] {
    return classes.map(c => {
        const orm = { width: 8, height: 8, rgba: new Uint8Array(256) }, normal = { width: 8, height: 8, rgba: new Uint8Array(256) };
        for (let k = 0; k < 64; k++) { orm.rgba.set([255, roughnessOf(c), 255, 255], k * 4); normal.rgba.set([128, 128, 255, 255], k * 4); }
        return { name: c.wall ? 'TestStone' : `TestDark${c.index}`, realSizeM: [1, 1], normal, orm, distance: 0 };
    });
}

const imagesOf = (photos: RgbaImage8[]) => new Map(photos.map((p, i) => [i, { ...p, rgba: p.rgba.slice() }]));

const at = (img: RgbaImage8, x: number, y: number) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const metalTexels = (img: RgbaImage8) => { let n = 0; for (let k = 0; k < img.width * img.height; k++) if (img.rgba[k * 4 + 2]) n++; return n; };

/** The piered facade with one fitted strip window (a bay's left pane column over two storeys) and its upper pane. */
function fittedFacade(): { g: ReturnType<typeof parseGlbBytes>; photo: RgbaImage8; classes: RegionClass[] } {
    const photo = piered(), W = photo.width, H = photo.height;
    const win = [19 / W, 8 / H, 29 / W, 43 / H], pane = [19 / W, 8 / H, 29 / W, 26 / H];
    const quads: Quad[] = [{ mesh: 'facade_lattice_1', corners: wall(0, 20, 30), uv: FULL_UV, material: 0, extras: { sbFacadeLattice: { facadeId: 1, windows: { uv: win, panes: pane, label: 'photo-inferred', source: 'test' } } } }];
    const g = parseGlbBytes(scene(quads, [photo]));
    const b = building(), bg = parseGlbBytes(b.glb);
    return { g, photo, classes: readRegionClasses(bg.json, imagesOf(b.photos))! };
}

describe('pipeline K material regions', () => {
    it('draws nothing metal, and the wall set everywhere without a fitted window, whatever the colour', () => {
        const { glb, photos } = building();
        const g = parseGlbBytes(glb);
        const images = imagesOf(photos);
        const classes = readRegionClasses(g.json, images)!;
        expect(classes).toHaveLength(4);
        expect(classes[3].wall).toBe(true);
        expect(classes.map(c => c.meanLab[0])).toEqual([...classes.map(c => c.meanLab[0])].sort((a, b) => a - b));
        const plan = planMaterialRegions(g, g.json, images, classes, sets(classes));
        expect(plan.report.facades.withWindows).toBe(0);
        expect(plan.report.texels.glass).toBe(0);
        const wallRough = roughnessOf(classes[3]);
        for (const m of plan.materials) {
            expect(metalTexels(m.orm)).toBe(0);
            expect(metalTexels(m.params)).toBe(0);
            // the piered facade's dark spandrels and panes, the weathered wall's dark blots, the brown scan piece: all the wall's roughness
            for (let k = 0; k < m.orm.width * m.orm.height; k++) expect(m.orm.rgba[k * 4 + 1]).toBe(wallRough);
        }
        expect(plan.materials.find(m => m.material === 2)!.normal).toBeUndefined();
        expect(plan.report.scanPieces.total).toBe(1);
    });

    it("draws a fitted window's panes as glass and the rest of it as one frame finish, never metal", () => {
        const { g, photo, classes } = fittedFacade();
        const plan = planMaterialRegions(g, g.json, imagesOf([photo]), classes, sets(classes));
        const f = plan.report.facades.perFacade[0];
        expect(f.fittedWindows).toBe(1);
        expect(f.bays).toBe(0);
        expect(f.glassShare).toBeGreaterThan(0);
        expect(f.frameSet).not.toBe('TestStone');
        expect(plan.report.facades.withWindows).toBe(1);
        const m = plan.materials[0];
        const frame = classes.find(c => sets(classes)[c.index].name === f.frameSet)!;
        // in the pane: glass at float glass's roughness; in the window below it: the frame's set; outside, even on another bay's dark pane: the wall's
        expect(at(m.params, 24, 15)[0]).toBe(MATERIAL_REGIONS_PARAMS.paneGlassWeight);
        expect(at(m.orm, 24, 15)[1]).toBe(Math.round(GLASS_ROUGHNESS * 255));
        expect(at(m.params, 24, 35)[0]).toBe(0);
        expect(at(m.orm, 24, 35)[1]).toBe(roughnessOf(frame));
        expect(at(m.orm, 74, 50)[1]).toBe(roughnessOf(classes[3]));
        expect(at(m.params, 74, 50)[0]).toBe(0);
        expect(metalTexels(m.orm)).toBe(0);
        // the pane carries its seed in the parameters alpha (the viewer's tilt), everything else 255
        expect(at(m.params, 24, 15)[3]).toBe(paneSeed(100001));
        expect(at(m.params, 24, 35)[3]).toBe(255);
        expect(at(m.params, 74, 50)[3]).toBe(255);
        const seeds = Array.from({ length: 500 }, (_, i) => paneSeed(i));
        expect(Math.min(...seeds)).toBeGreaterThanOrEqual(1);
        expect(Math.max(...seeds)).toBeLessThanOrEqual(254);
        expect(new Set(seeds).size).toBeGreaterThan(200);
    });

    it("draws glass on a scan piece only in its fitted plane's bays, off the wall's class; none on a piece off the plane", () => {
        const { glb, photos } = building();
        const g = parseGlbBytes(glb);
        const images = imagesOf(photos);
        const classes = readRegionClasses(g.json, images)!;
        // a plane through the scan piece relief_m0 (x 50-55, y 0-5, z 0, facing +z): a column of three windows s -1.5..0.5
        // (x 51-53), each 1.2 m tall every 1.5 m up the wall (t 2.2 to -2.3): one bay from y 0.2 to 4.7
        const windows: Array<[number, number, number, number]> = [[10, 3, 30, 15], [10, 18, 30, 30], [10, 33, 30, 45]];
        const plane: FittedPlane = { facadeId: 9, centroid: [52.5, 2.5, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], orthoSMin: -2.5, orthoTMax: 2.5, pixel: 0.1, width: 50, height: 50, windows, panes: windows };
        const plan = planMaterialRegions(g, g.json, images, classes, sets(classes), [plane]);
        const m = plan.materials.find(x => x.material === 2)!;
        // the brown scan photo is not the wall's class: the bay is glass; beside it (x 54) and relief_m1 (off the plane's ortho), wall
        const wall = roughnessOf(classes[3]);
        expect(at(m.params, 12, 9)[0]).toBe(MATERIAL_REGIONS_PARAMS.paneGlassWeight);
        expect(at(m.params, 12, 9)[3]).toBeLessThan(255);
        expect(at(m.orm, 12, 9)[1]).toBe(Math.round(GLASS_ROUGHNESS * 255));
        expect(at(m.orm, 25, 19)[1]).toBe(wall);
        expect(at(m.orm, 50, 19)[1]).toBe(wall);
        expect(metalTexels(m.orm)).toBe(0);
        expect(m.glass).toBe(true);
        expect(plan.report.scanPieces.planes).toEqual([9]);
        expect(plan.report.scanPieces.paneShare).toBeGreaterThan(0);
        // one window alone makes no bay, but its pane is glass all the same (a row of windows has no strip to make a bay)
        const single = planMaterialRegions(g, g.json, imagesOf(photos), classes, sets(classes), [{ ...plane, windows: [windows[0]], panes: [windows[0]] }]);
        const sm = single.materials.find(x => x.material === 2)!;
        expect(sm.glass).toBe(true);
        expect(at(sm.params, 12, 9)[0]).toBeGreaterThan(0);
        // and not beside it
        expect(at(sm.params, 25, 19)[0]).toBe(0);
        // no pane, no glass
        const none = planMaterialRegions(g, g.json, imagesOf(photos), classes, sets(classes), [{ ...plane, windows: [windows[0]], panes: [] }]);
        expect(none.materials.find(x => x.material === 2)!.glass).toBe(false);
        // a plane facing the other way draws nothing
        const back = planMaterialRegions(g, g.json, imagesOf(photos), classes, sets(classes), [{ ...plane, normal: [0, 0, -1], axisS: [-1, 0, 0] }]);
        expect(back.report.scanPieces.planes).toEqual([]);
    });

    it('plans the same maps and report on worker threads as on one thread', async () => {
        const { glb, photos: flat } = building();
        // photo noise, so texels of one colour bucket differ (each thread's colour cache fills in its own order)
        const photos = flat.map((p, i) => ({ ...p, rgba: p.rgba.map((v, k) => (k % 4 === 3 ? v : Math.max(0, Math.min(255, v + ((k * 7919 + i * 104729) % 13) - 6)))) }));
        const g = parseGlbBytes(glb);
        const classes = readRegionClasses(g.json, imagesOf(photos))!;
        const windows: Array<[number, number, number, number]> = [[10, 3, 30, 15], [10, 18, 30, 30], [10, 33, 30, 45]];
        const plane: FittedPlane = { facadeId: 9, centroid: [52.5, 2.5, 0], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], orthoSMin: -2.5, orthoTMax: 2.5, pixel: 0.1, width: 50, height: 50, windows, panes: windows };
        const one = planMaterialRegions(g, g.json, imagesOf(photos), classes, sets(classes), [plane]);
        const many = await planMaterialRegionsOnThreads(g, g.json, imagesOf(photos), classes, sets(classes), [plane], undefined, { threads: 3 });
        expect(many.materials.length).toBeGreaterThan(1);
        expect(many.materials.map(m => m.material)).toEqual(one.materials.map(m => m.material));
        many.materials.forEach((m, i) => {
            const o = one.materials[i];
            expect(Buffer.from(m.orm.rgba).equals(Buffer.from(o.orm.rgba))).toBe(true);
            expect(Buffer.from(m.params.rgba).equals(Buffer.from(o.params.rgba))).toBe(true);
            expect(!!m.normal && Buffer.from(m.normal.rgba).equals(Buffer.from(o.normal!.rgba))).toBe(!!o.normal);
            expect([m.rebuilt, m.glass]).toEqual([o.rebuilt, o.glass]);
        });
        expect({ ...many.report, ms: 0 }).toEqual({ ...one.report, ms: 0 });
        expect(many.report.scanPieces.planes).toEqual([9]);
    });

    it("puts the stone's relief on the structure alone and glass in the bays it frames, off the wall's class", () => {
        // the piered facade with one fitted window and its pane, the lattice's structure (the piers, x 0-15 mod 50, full height)
        // and its bays (x 15-50 mod 50) up to 25 m (v from 1/6)
        const photo = piered(), W = photo.width, H = photo.height;
        const win = [19 / W, 8 / H, 29 / W, 43 / H], pane = [19 / W, 8 / H, 29 / W, 26 / H];
        const runs = [0, 50, 100, 150].flatMap(x => [x / W, 0, (x + 15) / W, 1]);
        const bays = [15, 65, 115, 165].flatMap(x => [x / W, 1 / 6, (x + 35) / W, 1]);
        const quads: Quad[] = [{ mesh: 'facade_lattice_1', corners: wall(0, 20, 30), uv: FULL_UV, material: 0, extras: { sbFacadeLattice: { facadeId: 1, windows: { uv: win, panes: pane, label: 'photo-inferred', source: 'test' }, structure: { uv: runs, bays, reliefM: 0.18, reliefFrom: 'measured', reason: 'test', chamferM: 0.05, label: 'photo-inferred' } } } }];
        const g = parseGlbBytes(scene(quads, [photo]));
        const b = building(), bg = parseGlbBytes(b.glb);
        const classes = readRegionClasses(bg.json, imagesOf(b.photos))!;
        const plan = planMaterialRegions(g, g.json, imagesOf([photo]), classes, sets(classes));
        const m = plan.materials[0], f = plan.report.facades.perFacade[0];
        const frame = classes.find(c => sets(classes)[c.index].name === f.frameSet)!;
        expect(f.structureShare).toBeCloseTo(0.3, 2);
        expect(frame.wall).toBe(false);
        // a pier: the wall's (stone) set; a spandrel and a pane in a bay: glass; the fitted window above the bays (outside
        // them): its pane glass, the rest of it the frame's
        expect(at(m.orm, 7, 100)[1]).toBe(roughnessOf(classes[3]));
        expect(at(m.params, 74, 110)[0]).toBe(MATERIAL_REGIONS_PARAMS.paneGlassWeight);
        expect(at(m.params, 74, 120)[0]).toBe(MATERIAL_REGIONS_PARAMS.paneGlassWeight);
        // a pane mirroring the sky (light, the third storey's) is glass too: a bay is glass whole, never cut texel by texel
        expect(at(m.params, 24, 85)[0]).toBe(MATERIAL_REGIONS_PARAMS.paneGlassWeight);
        expect(at(m.orm, 24, 15)[1]).toBe(Math.round(GLASS_ROUGHNESS * 255));
        expect(at(m.orm, 24, 35)[1]).toBe(roughnessOf(frame));
        expect(f.bays).toBe(4);
        // the glass fades in from the bay's edge (x 15): weaker at its first texel than inside, never zero
        const gEdge = at(m.params, 15, 120)[0], gIn = at(m.params, 20, 120)[0];
        expect(gEdge).toBeGreaterThan(0);
        expect(gEdge).toBeLessThan(gIn);
        expect(at(m.orm, 15, 120)[1]).toBeGreaterThan(at(m.orm, 20, 120)[1]);
        // each storey of a bay its own tilt seed (the facade's storey pitch from its windows: here one window, so one seed per bay)
        expect(at(m.params, 20, 120)[3]).toBeLessThan(255);
        expect(plan.report.baysOnStone).toBe(0);
        // a "bay" drawn over a pier (mostly the wall's class) is no glass bay: only its window's panes would be
        const gp = parseGlbBytes(scene([{ ...quads[0], extras: { sbFacadeLattice: { facadeId: 1, structure: { uv: runs, bays: [1 / W, 1 / 6, 14 / W, 1], reliefM: 0.18, reliefFrom: 'measured', reason: 'test', chamferM: 0.05, label: 'photo-inferred' } } } }], [photo]));
        const onPier = planMaterialRegions(gp, gp.json, imagesOf([photo]), classes, sets(classes));
        expect(onPier.report.baysOnStone).toBe(1);
        expect(at(onPier.materials[0].params, 7, 100)[0]).toBe(0);
        expect(metalTexels(m.orm)).toBe(0);
    });

    it("puts glass on a bay's fitted panes alone when it holds any (the facade reader's punched windows), whole on a bay without", () => {
        const photo = piered(), W = photo.width, H = photo.height;
        const runs = [0, 50, 100, 150].flatMap(x => [x / W, 0, (x + 15) / W, 1]);
        const bays = [15, 65, 115, 165].flatMap(x => [x / W, 1 / 6, (x + 35) / W, 1]);
        // the second bay's panes, storey by storey (x 69-79 and 86-96, y 8-26 every 35)
        const panes = [2, 3, 4, 5, 6, 7].flatMap(k => [69, 86].flatMap(x => [x / W, (8 + 35 * k) / H, (x + 10) / W, (26 + 35 * k) / H]));
        const quads: Quad[] = [{ mesh: 'facade_lattice_1', corners: wall(0, 20, 30), uv: FULL_UV, material: 0, extras: { sbFacadeLattice: { facadeId: 1, windows: { uv: panes, panes, label: 'photo-inferred', source: 'test' }, structure: { uv: runs, bays, reliefM: 0.18, reliefFrom: 'measured', reason: 'test', chamferM: 0.05, label: 'photo-inferred' } } } }];
        const g = parseGlbBytes(scene(quads, [photo]));
        const b = building(), bg = parseGlbBytes(b.glb);
        const classes = readRegionClasses(bg.json, imagesOf(b.photos))!;
        const m = planMaterialRegions(g, g.json, imagesOf([photo]), classes, sets(classes)).materials[0];
        // the paned bay: glass on a pane, none on the spandrel between storeys (the frame's finish there)
        expect(at(m.params, 74, 118)[0]).toBe(MATERIAL_REGIONS_PARAMS.paneGlassWeight);
        expect(at(m.params, 74, 135)[0]).toBe(0);
        expect(at(m.orm, 74, 135)[1]).not.toBe(Math.round(GLASS_ROUGHNESS * 255));
        // the bay without panes: glass whole, spandrel included
        expect(at(m.params, 24, 135)[0]).toBe(MATERIAL_REGIONS_PARAMS.paneGlassWeight);
    });

    it("draws no glass on a pane whose texels are the wall's class: stone, whatever the fit read", () => {
        // the piered facade with two fitted windows and panes: one on a bay's glass, one across a pier (stone)
        const photo = piered(), W = photo.width, H = photo.height;
        const glassWin = [19 / W, 8 / H, 29 / W, 26 / H], pierWin = [1 / W, 40 / H, 14 / W, 70 / H];
        const quads: Quad[] = [{ mesh: 'facade_lattice_1', corners: wall(0, 20, 30), uv: FULL_UV, material: 0, extras: { sbFacadeLattice: { facadeId: 1, windows: { uv: [...glassWin, ...pierWin], panes: [...glassWin, ...pierWin], label: 'photo-inferred', source: 'test' } } } }];
        const g = parseGlbBytes(scene(quads, [photo]));
        const b = building(), bg = parseGlbBytes(b.glb);
        const classes = readRegionClasses(bg.json, imagesOf(b.photos))!;
        const plan = planMaterialRegions(g, g.json, imagesOf([photo]), classes, sets(classes));
        const m = plan.materials[0];
        expect(at(m.params, 24, 15)[0]).toBe(MATERIAL_REGIONS_PARAMS.paneGlassWeight);
        expect(at(m.params, 7, 55)[0]).toBe(0);
        expect(plan.report.panesOnStone).toBe(1);
    });

    it("tilts a glass bay storey by storey, at the storey pitch of the facade's own windows", () => {
        // a bay x 15-50 with four fitted windows one above another every 35 texels (3.5 m)
        const photo = piered(), W = photo.width, H = photo.height;
        const win = [8, 43, 78, 113].flatMap(y => [19 / W, y / H, 29 / W, (y + 18) / H]);
        const runs = [0, 50, 100, 150].flatMap(x => [x / W, 0, (x + 15) / W, 1]);
        const quads: Quad[] = [{ mesh: 'facade_lattice_1', corners: wall(0, 20, 30), uv: FULL_UV, material: 0, extras: { sbFacadeLattice: { facadeId: 1, windows: { uv: win, label: 'photo-inferred', source: 'test' }, structure: { uv: runs, bays: [15 / W, 0, 50 / W, 1], reliefM: 0.18, reliefFrom: 'measured', reason: 'test', chamferM: 0.05, label: 'photo-inferred' } } } }];
        const g = parseGlbBytes(scene(quads, [photo]));
        const b = building(), bg = parseGlbBytes(b.glb);
        const classes = readRegionClasses(bg.json, imagesOf(b.photos))!;
        const m = planMaterialRegions(g, g.json, imagesOf([photo]), classes, sets(classes)).materials[0];
        const seed = (y: number) => at(m.params, 32, y)[3];
        // within a storey one seed; the next storey another
        expect(seed(12)).toBe(seed(20));
        expect(seed(50)).not.toBe(seed(15));
        expect(seed(85)).not.toBe(seed(50));
    });

    it('keeps the photo as the base colour everywhere, panes included', () => {
        const { g, photo, classes } = fittedFacade();
        const images = imagesOf([photo]);
        planMaterialRegions(g, g.json, images, classes, sets(classes));
        expect(Buffer.from(images.get(0)!.rgba).equals(Buffer.from(photo.rgba))).toBe(true);
    });

    it('writes the twin lit, with the maps, the extras and the labels', async () => {
        const { g: fg } = fittedFacade();
        const twin = await tileRefineTwin(new Uint8Array(assembleGlb(fg.json as never, fg.bin)), 'esb', { harmonize: { groundY: 0 }, materialRegions: { sets: async classes => sets(classes) } });
        expect(twin.materialRegions && 'version' in twin.materialRegions).toBe(true);
        const g = parseGlbBytes(twin.glb);
        const json: any = g.json;
        expect(json.extensionsUsed ?? []).not.toContain('KHR_materials_unlit');
        const m = json.materials[0];
        expect(m.extensions?.KHR_materials_unlit).toBeUndefined();
        expect(m.pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
        expect(m.normalTexture).toBeDefined();
        expect(m.extras.sbMaterial.schema).toBe('scratchbox.staged-material/1');
        expect(m.extras.sbMaterialRegions.roughness.label).toBe('generated');
        expect(m.extras.sbMaterialRegions.metalness.source).toMatch(/none drawn/);
        expect(m.extras.sbMaterialRegions.baseColor.label).toBe('photo-inferred');
        expect(m.extras.sbMaterialRegions.glass.label).toBe('photo-inferred');
        const prov = json.asset.extras.sbTexture.provenance;
        expect(prov.find((p: any) => p.source === 'material-regions').label).toBe('generated');
        expect(prov.find((p: any) => p.source === 'facade-material-reading').label).toBe('photo-inferred');
        // the parameters texture decodes and carries glass weight on the pane
        const pt = json.textures[m.extras.sbMaterial.paramsTexture].source;
        const view = json.bufferViews[json.images[pt].bufferView];
        const params = decodeImageInMemory(g.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
        expect(params.rgba[(15 * params.width + 24) * 4]).toBeGreaterThan(0);
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
