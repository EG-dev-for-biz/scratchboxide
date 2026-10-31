/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's outside check (pipeline-k/visible-defects.ts) on a textured 10 m cube, wound outward:
 *  - an untextured 4 m x 4 m patch on the outside of a face is seen and counted as clay; the same patch inside the cube
 *    is never seen; a small one is reported under the limits;
 *  - a 4 m x 4 m hole in the front face: straight on and from above, every inner face is a back (hidden), so the background
 *    shows through, counted as see-through; a double-sided inner surface behind it is the inside showing; an inner surface facing outward behind the hole is
 *    drawn as a front face, and that hole is not counted (the method's stated limit);
 *  - a hole closed by a double-sided clay cap is clay, not a hole.
 */

import { describe, expect, it } from 'vitest';
import { DEFECT, embeddedImageSize, measureVisibleDefects, smearedMapping, VISIBLE_DEFECTS_PARAMS } from '../src/node/3d-engine/staged-location/pipeline-k/visible-defects';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';

type V = [number, number, number];

/** A square as two triangles (corner o, edges a and b), counter-clockwise seen from the side a x b points to. */
const quad = (o: V, a: V, b: V): V[] => {
    const p = (i: number, j: number): V => [o[0] + a[0] * i + b[0] * j, o[1] + a[1] * i + b[1] * j, o[2] + a[2] * i + b[2] * j];
    return [p(0, 0), p(1, 0), p(1, 1), p(0, 0), p(1, 1), p(0, 1)];
};
/** A 1 m grid over a face (corner o, unit steps a and b, 10 x 10), cells skipped by `hole`. */
const grid = (o: V, a: V, b: V, hole: (i: number, j: number) => boolean = () => false): V[] => {
    const out: V[] = [];
    for (let j = 0; j < 10; j++) for (let i = 0; i < 10; i++) if (!hole(i, j)) out.push(...quad([o[0] + a[0] * i + b[0] * j, o[1] + a[1] * i + b[1] * j, o[2] + a[2] * i + b[2] * j], a, b));
    return out;
};
const frontHole = (i: number, j: number) => i >= 3 && i < 7 && j >= 3 && j < 7;
/** The cube [0, 10]^3, every face wound outward; the front (z = 10) with an optional hole. */
const cube = (hole?: (i: number, j: number) => boolean): V[] => [
    ...grid([0, 0, 10], [1, 0, 0], [0, 1, 0], hole),   // front, +z
    ...grid([10, 0, 0], [-1, 0, 0], [0, 1, 0]),        // back, -z
    ...grid([0, 0, 0], [0, 0, 1], [0, 1, 0]),          // left, -x
    ...grid([10, 0, 10], [0, 0, -1], [0, 1, 0]),       // right, +x
    ...grid([0, 10, 10], [1, 0, 0], [0, 0, -1]),       // top, +y
    ...grid([0, 0, 0], [1, 0, 0], [0, 0, 1])           // bottom, -y
];

/** Texture coordinates with width on every face of the cube (no face edge-on to the map). */
const planarUv = (pts: V[]) => Float32Array.from(pts.flatMap(([x, y, z]) => [x + z, y + 0.5 * z]));

/** "Building" (textured, single-sided), "Seal" (untextured, double-sided like the seal's fill) and "Inner" (textured, double-sided). */
function glb(building: V[], seal: V[], inner: V[] = [], smearBuilding = false): Buffer {
    const chunks: Buffer[] = [], views: any[] = [], accessors: any[] = [];
    let len = 0;
    const add = (data: Float32Array, type: 'VEC3' | 'VEC2', n: number) => {
        const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        views.push({ buffer: 0, byteOffset: len, byteLength: b.length }); chunks.push(b); len += b.length;
        accessors.push({ bufferView: views.length - 1, componentType: 5126, count: n, type });
        return accessors.length - 1;
    };
    const meshes: any[] = [{ primitives: [{ attributes: { POSITION: add(Float32Array.from(building.flat()), 'VEC3', building.length), TEXCOORD_0: add(smearBuilding ? Float32Array.from(building.flatMap(([, y]) => [0.5, y])) : planarUv(building), 'VEC2', building.length) }, material: 0 }] }];
    const nodes: any[] = [{ name: 'Building', mesh: 0 }];
    if (seal.length) { meshes.push({ primitives: [{ attributes: { POSITION: add(Float32Array.from(seal.flat()), 'VEC3', seal.length) }, material: 1 }] }); nodes.push({ name: 'Seal', mesh: 1 }); }
    if (inner.length) { meshes.push({ primitives: [{ attributes: { POSITION: add(Float32Array.from(inner.flat()), 'VEC3', inner.length), TEXCOORD_0: add(planarUv(inner), 'VEC2', inner.length) }, material: 2 }] }); nodes.push({ name: 'Inner', mesh: meshes.length - 1 }); }
    const json = {
        asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: nodes.map((_, i) => i) }], nodes, meshes,
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }, { name: 'Seal', doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.55, 0.53, 0.5, 1] } }, { doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        textures: [{ source: 0 }], images: [{ uri: 'data:image/png;base64,' }],
        buffers: [{ byteLength: len }], bufferViews: views, accessors
    };
    return assembleGlb(json, Buffer.concat(chunks));
}
const P = { ...VISIBLE_DEFECTS_PARAMS, resolution: 200, pixelM: 0 };
const front = (r: ReturnType<typeof measureVisibleDefects>) => r.views.find(v => v.azimuthDeg === 0 && v.elevationDeg === 0)!;

describe('pipeline K outside check: clay', () => {
    it('counts an untextured patch on the outside, names its node, and flags it', () => {
        const r = measureVisibleDefects(glb(cube(), quad([3, 3, 10.01], [4, 0, 0], [0, 4, 0])), P);
        expect(Object.keys(r.byNode.clay)).toEqual(['Seal']);
        // seen straight on from the front: 16 of the 100 m² face
        expect(front(r).clayShare).toBeGreaterThan(0.12);
        expect(front(r).clayShare).toBeLessThan(0.2);
        expect(r.views.find(v => v.azimuthDeg === 180)!.clay).toBe(0);
        expect(r.holeShare).toBe(0);
        expect(r.flagged).toBe(true);
        expect(r.why).toMatch(/Seal/);
    });

    it('a patch inside the shell is never seen', () => {
        const r = measureVisibleDefects(glb(cube(), quad([3, 3, 5], [4, 0, 0], [0, 4, 0])), P);
        expect(r.clay).toBe(0);
        expect(r.holeShare).toBe(0);
        expect(r.flagged).toBe(false);
    });

    it('a small patch under both limits is reported, not flagged', () => {
        const r = measureVisibleDefects(glb(cube(), quad([3, 3, 10.01], [0.5, 0, 0], [0, 0.5, 0])), P);
        expect(r.clay).toBeGreaterThan(0);
        expect(r.clayShare).toBeLessThan(0.01);
        expect(r.flagged).toBe(false);
    });
});

describe('pipeline K outside check: holes', () => {
    it('a hole in the front face: seen straight on it shows through the building, counted and flagged', () => {
        const r = measureVisibleDefects(glb(cube(frontHole), []), P, { keepMasks: true });
        const f = front(r);
        // straight on, the back wall's inside is hidden (single-sided) and nothing else is behind: the background shows
        expect(f.seeThrough / f.building).toBeGreaterThan(0.12);
        expect(f.seeThrough / f.building).toBeLessThan(0.2);
        // the mask has see-through pixels at the hole's centre
        const m = f.mask!;
        expect(m.data[Math.floor(m.height / 2) * m.width + Math.floor(m.width / 2)]).toBe(DEFECT.seeThrough);
        // from above at an angle the hole is seen too (every inner face of a plain cube is a back face: still see-through)
        expect(r.views.filter(v => v.elevationDeg > 0).some(v => v.seeThrough > 0)).toBe(true);
        expect(r.inside).toBe(0);
        expect(r.views.find(v => v.azimuthDeg === 180)!.inside + r.views.find(v => v.azimuthDeg === 180)!.seeThrough).toBe(0);
        expect(r.clay).toBe(0);
        expect(r.flagged).toBe(true);
        expect(Object.keys(r.byNode.holes)).toEqual(['Building']);
    });

    it('not counted: a hole through which the eye meets an inner surface facing outward (drawn as a front face)', () => {
        const inner = quad([0, 0, 5], [10, 0, 0], [0, 10, 0]);
        const f = front(measureVisibleDefects(glb([...cube(frontHole), ...inner], []), P));
        expect(f.inside + f.seeThrough).toBe(0);
    });

    it('behind the hole, the back of an inner wall (hidden) and a drawn surface past it: counted as the inside showing', () => {
        // an inner wall at z = 7 facing the back (its back toward the hole), a double-sided wall at z = 5 behind it
        const innerBack = quad([10, 0, 7], [-10, 0, 0], [0, 10, 0]);
        const f = front(measureVisibleDefects(glb([...cube(frontHole), ...innerBack], [], quad([0, 0, 5], [10, 0, 0], [0, 10, 0])), P));
        expect(f.inside / f.building).toBeGreaterThan(0.12);
        expect(f.seeThrough).toBe(0);
    });

    it('a double-sided textured cube (as the twin draws it) with a hole: the far wall inside is drawn, counted as the inside showing', () => {
        const f = front(measureVisibleDefects(glb([], [], cube(frontHole)), P));
        expect(f.inside / f.building).toBeGreaterThan(0.12);
        expect(f.seeThrough).toBe(0);
        expect(measureVisibleDefects(glb([], [], cube()), P).inside).toBe(0);
    });

    it('the hole closed by a double-sided clay cap is clay, not a hole', () => {
        const r = measureVisibleDefects(glb(cube(frontHole), quad([3, 3, 10], [4, 0, 0], [0, 4, 0])), P);
        const f = front(r);
        expect(f.inside + f.seeThrough).toBe(0);
        expect(f.clayShare).toBeGreaterThan(0.12);
    });

    it('a closed cube has no defect from any view', () => {
        const r = measureVisibleDefects(glb(cube(), []), P);
        expect(r.clay + r.inside + r.seeThrough).toBe(0);
        expect(r.flagged).toBe(false);
    });

    it('a textured face mapped from one column of texels (its texture edge-on) counts as smeared clay; a mapped one does not', () => {
        expect(smearedMapping([0, 0, 0, 1, 0, 0, 0, 1, 0], [0.5, 0, 0.5, 0, 0.5, 1], 0.05)).toBe(true);
        expect(smearedMapping([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 0, 1, 0, 0, 1], 0.05)).toBe(false);
        const r = measureVisibleDefects(glb(cube(), [], [], true), P);
        // every drawn pixel (the outline's few back-face ties aside)
        expect(r.smearShare).toBeGreaterThan(0.99);
        expect(r.clay).toBeGreaterThanOrEqual(r.smear);
        expect(r.byNode.smear.Building).toBe(r.smear);
        expect(r.flagged).toBe(true);
        expect(measureVisibleDefects(glb(cube(), []), P).smear).toBe(0);
    });

    it('one long slot down a tower (1 m x 100 m, under both share limits) is flagged as a hole region; a short one is only reported', () => {
        // a 40 x 120 x 40 m tower drawn double-sided like the twin, its front face (z = 40) open in a 1 m slot 1 m in from the
        // corner, from 10 m up to 10 + slot m: the far walls' insides show through it (the ESB build of 2026-10-26's corner strip)
        const tower = (slot: number): V[] => [
            ...quad([0, 0, 40], [38, 0, 0], [0, 120, 0]),
            ...quad([38, 0, 40], [1, 0, 0], [0, 10, 0]), ...quad([38, 10 + slot, 40], [1, 0, 0], [0, 110 - slot, 0]),
            ...quad([39, 0, 40], [1, 0, 0], [0, 120, 0]),
            ...quad([40, 0, 0], [-40, 0, 0], [0, 120, 0]), ...quad([0, 0, 0], [0, 0, 40], [0, 120, 0]),
            ...quad([40, 0, 40], [0, 0, -40], [0, 120, 0]), ...quad([0, 120, 40], [40, 0, 0], [0, 0, -40]), ...quad([0, 0, 0], [40, 0, 0], [0, 0, 40])
        ];
        const T = { ...VISIBLE_DEFECTS_PARAMS, pixelM: 0.25 };
        const long = measureVisibleDefects(glb([], [], tower(100)), T);
        expect(long.holeShare).toBeLessThan(T.maxHoleShare);
        expect(long.maxViewHoleShare).toBeLessThan(T.maxViewHoleShare);
        expect(long.largestHoleRegionM2).toBeGreaterThan(T.maxHoleRegionM2);
        expect(long.holesFlagged).toBe(true);
        expect(long.flagged).toBe(true);
        // straight on: the slot's area, length and width (the pixels on its two edges belong to the wall: 0.75 of its 1 m at
        // 0.25 m pixels), behind the far wall's inside, centred on the slot
        const g = long.holeRegions[0];
        expect(g.areaM2).toBeGreaterThan(70);
        expect(g.areaM2).toBeLessThan(105);
        expect(g.lengthM).toBeCloseTo(100, -1);
        expect(g.widthM).toBeGreaterThan(0.7);
        expect(g.widthM).toBeLessThan(1.05);
        expect(g.node).toBe('Inner');
        expect(g.rimNode).toBe('Inner');
        // placed in the front face, where the slot is
        expect(Math.abs(g.center[0] - 38.5)).toBeLessThan(1);
        expect(Math.abs(g.center[1] - 60)).toBeLessThan(2);
        expect(Math.abs(g.center[2] - 40)).toBeLessThan(1);
        // the same slot seen from the other views is one place: listed once
        expect(long.holeRegions.filter(h => Math.abs(h.center[0] - 38.5) < 2 && Math.abs(h.center[1] - 60) < 10 && Math.abs(h.center[2] - 40) < 2).length).toBe(1);
        expect(long.why).toMatch(/the largest hole \d+(\.\d)? m² \(\d+(\.\d)? m long/);
        const short = measureVisibleDefects(glb([], [], tower(20)), T);
        expect(short.holeRegions[0].areaM2).toBeGreaterThan(14);
        expect(short.largestHoleRegionM2).toBeLessThan(T.maxHoleRegionM2);
        expect(short.holesFlagged).toBe(false);
        expect(short.flagged).toBe(false);
        const closed = measureVisibleDefects(glb([], [], tower(0)), T);
        expect(closed.holeRegions).toEqual([]);
        expect(closed.largestHoleRegionM2).toBe(0);
    });

    it("judges the mapping in texels: a long thin facade on a long thin photo (76 x 3.5 m on 988 x 45 px) is not a smear", () => {
        // the ESB's ground band: u per metre 1/76, v per metre 1/3.5; in uv units that is 20:1, in texels 13 px/m both ways
        const p = [0, 0, 0, 76, 0, 0, 0, 3.5, 0], uv = [0, 0, 1, 0, 0, 1];
        expect(smearedMapping(p, uv, 0.05)).toBe(true);
        expect(smearedMapping(p, [0, 0, 988, 0, 0, 45], 0.05)).toBe(false);
        const png = encodePng(988, 45, new Uint8Array(988 * 45 * 4), 4);
        const glbBytes = assembleGlb({ asset: { version: '2.0' }, images: [{ bufferView: 0, mimeType: 'image/png' }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: png.length }], buffers: [{ byteLength: png.length }] }, png);
        expect(embeddedImageSize(parseGlbBytes(glbBytes), 0)).toEqual({ width: 988, height: 45 });
    });
});
