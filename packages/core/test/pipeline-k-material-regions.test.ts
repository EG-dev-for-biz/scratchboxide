/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's material regions (pipeline-k/material-regions.ts, tile-refine-twin.ts): metal and glass only where an
 * opening is shown (a facade's pier rhythm, a scan piece's relief recess), wall finish everywhere else whatever the
 * colour; glass by the facade material reading's lattice test; the twin written lit with the maps and labels.
 */

import { describe, expect, it } from 'vitest';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { GLASS_ROUGHNESS } from '../src/node/3d-engine/staged-location/facade-materials';
import { MATERIAL_REGIONS_PARAMS, pierRhythm, planMaterialRegions, readRegionClasses, type RegionClass, type RegionSet } from '../src/node/3d-engine/staged-location/pipeline-k/material-regions';
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

/** Flat-normal sets: the wall class matte stone, every darker class metal (so metal anywhere on stone would show). */
function sets(classes: RegionClass[]): RegionSet[] {
    return classes.map(c => {
        const orm = { width: 8, height: 8, rgba: new Uint8Array(256) }, normal = { width: 8, height: 8, rgba: new Uint8Array(256) };
        for (let k = 0; k < 64; k++) { orm.rgba.set([255, c.wall ? 179 : 128, c.wall ? 0 : 230, 255], k * 4); normal.rgba.set([128, 128, 255, 255], k * 4); }
        return { name: c.wall ? 'TestStone' : `TestMetal${c.index}`, realSizeM: [1, 1], normal, orm, distance: 0 };
    });
}

const imagesOf = (photos: RgbaImage8[]) => new Map(photos.map((p, i) => [i, { ...p, rgba: p.rgba.slice() }]));

describe('pipeline K material regions', () => {
    it("finds the piered facade's rhythm at its pitch and none on the weathered wall", () => {
        const piers = pierRhythm(piered(), PX), plain = pierRhythm(weathered(), PX);
        expect(piers.bays).toBeDefined();
        expect(piers.weight).toBe(1);
        expect(piers.pitchM).toBeCloseTo(5, 0);
        expect(piers.ncc).toBeGreaterThan(0.6);
        expect(plain.weight).toBe(0);
    });

    it('puts metal and glass only in openings, the wall finish everywhere else', () => {
        const { glb, photos } = building();
        const g = parseGlbBytes(glb);
        const images = imagesOf(photos);
        const classes = readRegionClasses(g.json, images)!;
        expect(classes).toHaveLength(4);
        expect(classes[3].wall).toBe(true);
        expect(classes.map(c => c.meanLab[0])).toEqual([...classes.map(c => c.meanLab[0])].sort((a, b) => a - b));
        const plan = planMaterialRegions(g, g.json, images, classes, sets(classes));
        const byMat = new Map(plan.materials.map(m => [m.material, m]));
        expect(plan.report.facades.withOpenings).toBe(1);

        // the piered facade: piers stone, spandrels metal, panes glass
        const f1 = byMat.get(0)!, W = 200;
        const at = (img: RgbaImage8, x: number, y: number) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
        const pier = at(f1.orm, 7, 100), spandrel = at(f1.orm, 17, 5 + 35 * 2), pane = at(f1.orm, 24, 12);
        expect(pier[2]).toBe(0);
        expect(spandrel[2]).toBeGreaterThan(200);
        expect(pane[2]).toBe(0);
        expect(pane[1]).toBe(Math.round(GLASS_ROUGHNESS * 255));
        expect(at(f1.params, 24, 12)[0]).toBeGreaterThan(0);
        expect(at(f1.params, 17, 75)[0]).toBe(0);
        const perFacade = plan.report.facades.perFacade.find(f => f.mesh === 'facade_lattice_1')!;
        expect(perFacade.glassRegions).toBeGreaterThan(20);
        expect(perFacade.pitchM).toBeCloseTo(5, 0);
        // accepted glass shows its measured interior (the photo kept as the fallback)
        expect(f1.photoFallback).toBeDefined();
        expect(at(images.get(0)!, 24, 12).slice(0, 3)).toEqual(at(f1.photoFallback!, 24, 12).slice(0, 3));
        expect(W).toBe(f1.orm.width);

        // the weathered wall: dark texels of the metal classes, but no rhythm: no metal, no glass
        const f2 = byMat.get(1)!;
        let metal = 0, glass = 0;
        for (let k = 0; k < f2.orm.width * f2.orm.height; k++) { if (f2.orm.rgba[k * 4 + 2]) metal++; if (f2.params.rgba[k * 4]) glass++; }
        expect(metal).toBe(0);
        expect(glass).toBe(0);
        expect(plan.report.facades.perFacade.find(f => f.mesh === 'facade_lattice_2')!.openings).toMatch(/no confirmed pier rhythm/);

        // the scan piece: all spandrel brown, metal only on its relief recess (left half)
        const s = byMat.get(2)!;
        expect(at(s.orm, 10, 16)[2]).toBeGreaterThan(200);
        expect(at(s.orm, 54, 16)[2]).toBe(0);
        expect(s.normal).toBeUndefined();
        expect(plan.report.scanPieces.fromRelief).toBeGreaterThan(0.4);
        expect(plan.report.scanPieces.fromRelief).toBeLessThan(0.6);
        expect(plan.report.scanPieces.fromFaces).toBe(0);
        expect(plan.report.faces).toHaveLength(2);
    });

    it("decides the bays per wall face: coplanar facades share one rhythm, and a scan piece on the face takes its bay columns", () => {
        // two piered facades side by side in one plane, a scan piece on the same wall over a bay (s 2.5-3.5) and one over a pier (s 20.2-21.2)
        const photos = [piered(), piered(), brown()];
        const quads: Quad[] = [
            { mesh: 'facade_lattice_1', corners: wall(0, 20, 30), uv: FULL_UV, material: 0 },
            { mesh: 'facade_lattice_2', corners: wall(20, 20, 30), uv: FULL_UV, material: 1 },
            { mesh: 'relief_m0', corners: wall(2.5, 1, 5, 0.1), uv: [0, 0, 0, 1, 0.5, 1, 0.5, 0], material: 2 },
            { mesh: 'relief_m1', corners: wall(20.2, 1, 5, 0.1), uv: [0.5, 0, 0.5, 1, 1, 1, 1, 0], material: 2 }
        ];
        const g = parseGlbBytes(scene(quads, photos));
        const images = imagesOf(photos);
        const classes = readRegionClasses(g.json, images)!;
        const plan = planMaterialRegions(g, g.json, images, classes, sets(classes));
        expect(plan.report.faces).toHaveLength(1);
        expect(plan.report.faces[0].facades.sort()).toEqual(['facade_lattice_1', 'facade_lattice_2']);
        expect(plan.report.faces[0].pitchM).toBeCloseTo(5, 0);
        expect(plan.report.faces[0].weight).toBe(1);
        const pf = plan.report.facades.perFacade;
        expect(new Set(pf.map(f => f.face)).size).toBe(1);
        expect(pf.every(f => f.weight === 1)).toBe(true);
        const s = plan.materials.find(m => m.material === 2)!;
        const metal = (x: number, y: number) => s.orm.rgba[(y * s.orm.width + x) * 4 + 2];
        // over the bay: the face's metal; over the pier: wall finish
        expect(metal(16, 16)).toBeGreaterThan(200);
        expect(metal(48, 16)).toBe(0);
        expect(plan.report.scanPieces.fromFaces).toBeGreaterThan(0.4);
    });

    it('shares a rhythm within a height band of a face: a facade too narrow to read one borrows it, a band above keeps its own', () => {
        // the piered tower 0-30 m high; beside it in the same band a 6 m strip (one pitch: too narrow alone); above, a weathered crown
        const strip = piered(); const narrow = { width: 60, height: 300, rgba: new Uint8Array(60 * 300 * 4) };
        for (let y = 0; y < 300; y++) narrow.rgba.set(strip.rgba.subarray(y * 200 * 4, (y * 200 + 60) * 4), y * 60 * 4);
        const photos = [piered(), narrow, weathered()];
        const quads: Quad[] = [
            { mesh: 'facade_lattice_1', corners: wall(0, 20, 30), uv: FULL_UV, material: 0 },
            { mesh: 'facade_lattice_2', corners: wall(20, 6, 30), uv: FULL_UV, material: 1 },
            { mesh: 'facade_lattice_3', corners: wall(0, 10, 15).map((v, i) => (i % 3 === 1 ? v + 40 : v)), uv: FULL_UV, material: 2 }
        ];
        const g = parseGlbBytes(scene(quads, photos));
        const images = imagesOf(photos);
        const classes = readRegionClasses(g.json, images)!;
        expect(pierRhythm(narrow, PX).weight).toBe(0);
        const plan = planMaterialRegions(g, g.json, images, classes, sets(classes));
        const pf = new Map(plan.report.facades.perFacade.map(f => [f.mesh, f]));
        expect(plan.report.faces).toHaveLength(1);
        expect(pf.get('facade_lattice_1')!.weight).toBe(1);
        expect(pf.get('facade_lattice_2')!.rhythmFrom).toBe('band');
        expect(pf.get('facade_lattice_2')!.weight).toBeGreaterThan(0.5);
        expect(pf.get('facade_lattice_3')!.weight).toBe(0);
    });

    it('reads a scan-only wall\'s rhythm from its own texels: no rebuilt facade, bays all the same', () => {
        // the piered photo on two scan triangles of one 20 x 30 m wall, a weathered scan wall facing the other way
        const photos = [piered(), weathered()];
        const quads: Quad[] = [
            { mesh: 'relief_m0', corners: wall(0, 20, 30), uv: FULL_UV, material: 0 },
            { mesh: 'relief_m1', corners: [10, 15, -8, 10, 0, -8, 0, 0, -8, 0, 15, -8], uv: FULL_UV, material: 1 }
        ];
        const g = parseGlbBytes(scene(quads, photos));
        const images = imagesOf(photos);
        // the classes come from rebuilt facades' photos: read them from the building fixture (the same colours)
        const b = building(), bg = parseGlbBytes(b.glb);
        const classes = readRegionClasses(bg.json, imagesOf(b.photos))!;
        const plan = planMaterialRegions(g, g.json, images, classes, sets(classes));
        expect(plan.report.scanPieces.walls).toBe(2);
        expect(plan.report.scanPieces.wallsWithBays).toBe(1);
        const s0 = plan.materials.find(m => m.material === 0)!, s1 = plan.materials.find(m => m.material === 1)!;
        const metal = (img: RgbaImage8, x: number, y: number) => img.rgba[(y * img.width + x) * 4 + 2];
        // a spandrel (s 1.7, between the piers) metal, a pier (s 0.7) stone; the weathered wall stone throughout
        expect(metal(s0.orm, 17, 75)).toBeGreaterThan(200);
        expect(metal(s0.orm, 7, 100)).toBe(0);
        let m1 = 0;
        for (let k = 0; k < s1.orm.width * s1.orm.height; k++) if (s1.orm.rgba[k * 4 + 2]) m1++;
        expect(m1).toBe(0);
    });

    it("draws the lattice's window cells as punched windows on a wall with no pier rhythm", () => {
        // a 12 x 9 m masonry wall, two dark 1.2 x 1.6 m windows; the lattice's cells: 3 columns x 2 rows, windows at (1, 0) and (1, 1)
        const W = 120, H = 90, rgba = new Uint8Array(W * H * 4);
        const inWin = (x: number, y: number) => x >= 54 && x < 66 && ((y >= 12 && y < 28) || (y >= 57 && y < 73));
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba.set([...(inWin(x, y) ? [30, 35, 45] : [190, 185, 175]), 255], (y * W + x) * 4);
        const masonry = { width: W, height: H, rgba };
        const windowCells = { u: [0, 0.45, 0.55, 1], v: [1, 0.5, 0], cells: [1, 4], label: 'photo-inferred', source: 'test' };
        const quads: Quad[] = [{ mesh: 'facade_lattice_1', corners: wall(0, 12, 9), uv: FULL_UV, material: 0, extras: { sbFacadeLattice: { facadeId: 1, windowCells } } }];
        const g = parseGlbBytes(scene(quads, [masonry]));
        const b = building(), bg = parseGlbBytes(b.glb);
        const classes = readRegionClasses(bg.json, imagesOf(b.photos))!;
        const plan = planMaterialRegions(g, g.json, imagesOf([masonry]), classes, sets(classes));
        const f = plan.report.facades.perFacade[0];
        expect(f.weight).toBe(0);
        expect(f.windowCells).toBe(2);
        expect(plan.report.facades.withOpenings).toBe(1);
        const m = plan.materials[0];
        const opened = (x: number, y: number) => m.orm.rgba[(y * W + x) * 4 + 2] > 0 || m.params.rgba[(y * W + x) * 4] > 0;
        // inside each window: metal or glass; the wall beside them and between: neither
        expect(opened(60, 20)).toBe(true);
        expect(opened(60, 65)).toBe(true);
        expect(opened(20, 20)).toBe(false);
        expect(opened(60, 45)).toBe(false);
    });

    it("opens a facade at the window fit's windows, in place of its bays and window cells", () => {
        // the piered facade (bays every 5 m), but with one fitted window: the second bay's left pane on its second storey
        const piers = piered(), W = piers.width, H = piers.height;
        const uv = [19 / W, 43 / H, 29 / W, 61 / H];
        const windowCells = { u: [0, 0.5, 1], v: [0, 1], cells: [0, 1], label: 'photo-inferred', source: 'test' };
        const quads: Quad[] = [{ mesh: 'facade_lattice_1', corners: wall(0, 20, 30), uv: FULL_UV, material: 0, extras: { sbFacadeLattice: { facadeId: 1, windowCells, windows: { uv, label: 'photo-inferred', source: 'test' } } } }];
        const g = parseGlbBytes(scene(quads, [piers]));
        const b = building(), bg = parseGlbBytes(b.glb);
        const classes = readRegionClasses(bg.json, imagesOf(b.photos))!;
        const plan = planMaterialRegions(g, g.json, imagesOf([piers]), classes, sets(classes));
        const f = plan.report.facades.perFacade[0];
        expect(f.fittedWindows).toBe(1);
        expect(f.weight).toBe(0);
        expect(f.windowCells).toBe(0);
        expect(f.openings).toBe('1 windows from the window fit');
        const m = plan.materials[0];
        const opened = (x: number, y: number) => m.orm.rgba[(y * W + x) * 4 + 2] > 0 || m.params.rgba[(y * W + x) * 4] > 0;
        // inside the fitted window: metal or glass; a pane of another bay, which the bay rhythm would have opened: wall
        expect(opened(24, 50)).toBe(true);
        expect(opened(74, 50)).toBe(false);
        expect(opened(24, 120)).toBe(false);
    });

    it("draws a fitted window's panes as glass and the rest of it as one frame finish, never the stone", () => {
        // the piered facade with one fitted strip window (a bay's left pane column over two storeys) and its upper pane
        const piers = piered(), W = piers.width, H = piers.height;
        const win = [19 / W, 8 / H, 29 / W, 43 / H], pane = [19 / W, 8 / H, 29 / W, 26 / H];
        const quads: Quad[] = [{ mesh: 'facade_lattice_1', corners: wall(0, 20, 30), uv: FULL_UV, material: 0, extras: { sbFacadeLattice: { facadeId: 1, windows: { uv: win, panes: pane, label: 'photo-inferred', source: 'test' } } } }];
        const g = parseGlbBytes(scene(quads, [piers]));
        const b = building(), bg = parseGlbBytes(b.glb);
        const classes = readRegionClasses(bg.json, imagesOf(b.photos))!;
        const plan = planMaterialRegions(g, g.json, imagesOf([piers]), classes, sets(classes));
        const f = plan.report.facades.perFacade[0];
        expect(f.panes).toBe(1);
        expect(f.paneShare).toBeGreaterThan(0);
        const m = plan.materials[0];
        const glass = (x: number, y: number) => m.params.rgba[(y * W + x) * 4] > 0;
        const metal = (x: number, y: number) => m.orm.rgba[(y * W + x) * 4 + 2] > 0;
        // in the pane: glass; in the window below it (spandrel, even where its colour is the stone's): the frame's metal; outside: neither
        expect(glass(24, 15)).toBe(true);
        expect(glass(24, 35)).toBe(false);
        expect(metal(24, 35)).toBe(true);
        expect(glass(24, 100) || metal(24, 100)).toBe(false);
    });

    it('scales the bays by a soft gate between nccLo and minNcc, not a hard cut', () => {
        const strong = pierRhythm(piered(), PX);
        expect(strong.weight).toBe(1);
        // the same rhythm read with the gate raised past it: a partial weight, then none
        const partial = pierRhythm(piered(), PX, { ...MATERIAL_REGIONS_PARAMS, nccLo: strong.ncc - 0.2, minNcc: strong.ncc + 0.2 });
        expect(partial.weight).toBeGreaterThan(0.2);
        expect(partial.weight).toBeLessThan(0.8);
        expect(partial.bays).toBeDefined();
        const none = pierRhythm(piered(), PX, { ...MATERIAL_REGIONS_PARAMS, nccLo: strong.ncc + 0.05, minNcc: strong.ncc + 0.3 });
        expect(none.weight).toBe(0);
    });

    it("keeps the photo as the base colour outside glass, scales the bays' metalness, and reports an estimated tile size with its reason", () => {
        const { glb, photos } = building();
        const g = parseGlbBytes(glb);
        const images = imagesOf(photos), before = imagesOf(photos);
        const classes = readRegionClasses(g.json, images)!;
        const estimated = sets(classes).map(s => s.name === 'TestStone' ? s : { ...s, metalnessScale: 0.4, realSizeEstimate: 'its publisher gives no real size; tiled at 1 x 1 m' });
        const plan = planMaterialRegions(g, g.json, images, classes, estimated);
        const f1 = plan.materials.find(m => m.material === 0)!;
        const px = (img: RgbaImage8, x: number, y: number) => Array.from(img.rgba.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 3));
        // a spandrel is drawn part metal (the set's 230/255 scaled by 0.4), its colour still the photo's; a pier and the weathered facade untouched
        expect(f1.orm.rgba[(75 * 200 + 17) * 4 + 2]).toBe(Math.round((230 / 255) * 0.4 * 255));
        expect(f1.params.rgba[(75 * 200 + 17) * 4 + 2]).toBe(Math.round((230 / 255) * 0.4 * 255));
        expect(plan.report.classes.filter(c => !c.wall).every(c => c.metalnessScale === 0.4)).toBe(true);
        expect(px(images.get(0)!, 17, 75)).toEqual(px(before.get(0)!, 17, 75));
        expect(px(images.get(0)!, 7, 100)).toEqual(px(before.get(0)!, 7, 100));
        expect(Buffer.from(images.get(1)!.rgba).equals(Buffer.from(before.get(1)!.rgba))).toBe(true);
        expect(plan.report.classes.filter(c => !c.wall).every(c => /no real size/.test(c.sizeEstimate ?? ''))).toBe(true);
        expect(plan.report.classes.find(c => c.wall)!.sizeEstimate).toBeUndefined();
    });

    it('writes the twin lit, with the maps, the reading extras and the labels', async () => {
        const { glb } = building();
        const twin = await tileRefineTwin(glb, 'esb', { harmonize: { groundY: 0 }, materialRegions: { sets: async classes => sets(classes) } });
        expect(twin.materialRegions && 'version' in twin.materialRegions).toBe(true);
        const g = parseGlbBytes(twin.glb);
        const json: any = g.json;
        expect(json.extensionsUsed ?? []).not.toContain('KHR_materials_unlit');
        for (const m of json.materials.slice(0, 3)) {
            expect(m.extensions?.KHR_materials_unlit).toBeUndefined();
            expect(m.pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
            expect(m.extras.sbMaterial.schema).toBe('scratchbox.staged-material/1');
            expect(m.extras.sbMaterialRegions.roughnessMetalness.label).toBe('generated');
            expect(m.extras.sbMaterialRegions.baseColor.label).toBe('photo-inferred');
        }
        expect(json.materials[0].normalTexture).toBeDefined();
        expect(json.materials[0].extras.sbMaterialRegions.glass.label).toBe('photo-inferred');
        expect(json.materials[2].normalTexture).toBeUndefined();
        const prov = json.asset.extras.sbTexture.provenance;
        expect(prov.find((p: any) => p.source === 'material-regions').label).toBe('generated');
        expect(prov.find((p: any) => p.source === 'facade-material-reading').label).toBe('photo-inferred');
        // the parameters texture decodes and carries glass weight on a pane
        const pt = json.textures[json.materials[0].extras.sbMaterial.paramsTexture].source;
        const view = json.bufferViews[json.images[pt].bufferView];
        const params = decodeImageInMemory(g.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
        expect(params.rgba[(12 * params.width + 24) * 4]).toBeGreaterThan(0);
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
