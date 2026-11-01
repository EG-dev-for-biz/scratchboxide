/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Placement's reference (photo-match-evaluate.ts placementTarget and streetMesh, photo-match-eval.ts targetFilled and
 * targetPlacement) on synthetic places drawn from a Street View pose: the photo's silhouette is read along the scan's target
 * within the building's footprint, both outlines are outer boundaries, and every build is drawn behind the street. Each of
 * the three ways the old reference rewarded the scan's own defects is shown gone, and a build moved 4 m still scores clearly
 * worse than one in place. The "photo" is the true place drawn by labels, one grey per region. No network, no billed call.
 */

import { describe, expect, it } from 'vitest';
import { SRGB8_TO_LINEAR } from '../src/common/spatial/photogrammetric-delight';
import {
    photoEdgeField, renderTriangles, targetFilled, targetPlacement, triangleRegions, REGION, type PhotoEdgeField, type TerrainLookup
} from '../src/node/3d-engine/staged-location/photo-match-eval';
import type { TileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { castCamera } from '../src/node/3d-engine/staged-location/survey-casting';
import { renderFrameDepth } from '../src/node/spatial/StreetViewPoseRegistrar';
import { cachedFootprints, placementTarget, storedFootprints, streetMesh } from '../src/node/gemini/tools/location-evidence/photo-match-evaluate';
import type { FootprintSource } from '../src/node/3d-engine/staged-location/facade-footprints';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Vec2 } from '../src/common/spatial/staged-location-contracts';

type V3 = [number, number, number];
const FLAT: TerrainLookup = { groundAt: () => 0 };

/** Triangles of quads (corners in order), one flat colour. */
function soup(quads: V3[][], colour: V3 = [128, 128, 128]): TileTriangles {
    const P: number[] = [];
    for (const [a, b, c, d] of quads) P.push(...a, ...b, ...c, ...a, ...c, ...d);
    const nt = P.length / 9, lin = colour.map(c => SRGB8_TO_LINEAR[c]);
    return {
        positions: Float32Array.from(P), uvs: new Float32Array(nt * 6), normals: new Float32Array(nt * 3).fill(0), texture: new Int32Array(nt).fill(-1),
        flatLinear: Float32Array.from(Array.from({ length: nt }, () => lin).flat()), textures: []
    };
}

/** A box's roof and four walls (x0..x1, z0..z1, from y0 to h). */
function box(x0: number, x1: number, z0: number, z1: number, h: number, y0 = 0): V3[][] {
    return [
        [[x0, h, z0], [x1, h, z0], [x1, h, z1], [x0, h, z1]],
        [[x0, y0, z0], [x1, y0, z0], [x1, h, z0], [x0, h, z0]], [[x0, y0, z1], [x1, y0, z1], [x1, h, z1], [x0, h, z1]],
        [[x0, y0, z0], [x0, y0, z1], [x0, h, z1], [x0, h, z0]], [[x1, y0, z0], [x1, y0, z1], [x1, h, z1], [x1, h, z0]]
    ];
}

/** The street: one flat quad at y = 0 under everything. */
const ground = () => soup([[[-90, 0, -60], [90, 0, -60], [90, 0, 150], [-90, 0, 150]]]);

function merge(parts: TileTriangles[]): TileTriangles {
    const cat = (k: 'positions' | 'uvs' | 'normals' | 'flatLinear') => Float32Array.from(parts.flatMap(p => Array.from(p[k])));
    return { positions: cat('positions'), uvs: cat('uvs'), normals: cat('normals'), flatLinear: cat('flatLinear'), texture: Int32Array.from(parts.flatMap(p => Array.from(p.texture))), textures: [] };
}

function select(t: TileTriangles, keep: ArrayLike<number>): TileTriangles {
    const k: number[] = [];
    for (let i = 0; i < keep.length; i++) if (keep[i]) k.push(i);
    const f = (a: Float32Array, w: number) => Float32Array.from(k.flatMap(i => Array.from(a.subarray(i * w, i * w + w))));
    return { ...t, positions: f(t.positions, 9), uvs: f(t.uvs, 6), normals: f(t.normals, 3), flatLinear: f(t.flatLinear, 3), texture: Int32Array.from(k.map(i => t.texture[i])) };
}

const shift = (t: TileTriangles, dx: number): TileTriangles => ({ ...t, positions: t.positions.map((v, i) => (i % 3 === 0 ? v + dx : v)) });

/** A Street View pose looking north at the place, at the metric width. */
const pose = (distanceZ: number, pitchDeg: number) => castCamera({ eye: [0, 2.5, distanceZ], headingDeg: 0, pitchDeg, fovDeg: 80, widthPx: 640, heightPx: 480 });
type Cam = ReturnType<typeof pose>;
const degPerPx = (c: Cam) => (2 * Math.atan(c.width / (2 * c.fx)) * 180) / Math.PI / c.width;

/** The photo: the true place drawn from the pose, each region one grey (the building pale, neighbours mid, the street dark). */
function photo(cam: Cam, meshes: TileTriangles[], labels: Array<number | Uint8Array>): PhotoEdgeField {
    const r = renderTriangles(meshes, cam, { supersample: 1, regions: { meshes: labels } }).regions!;
    const grey: Record<number, number> = { [REGION.sky]: 40, [REGION.ground]: 90, [REGION.neighbours]: 150, [REGION.target]: 215 };
    const rgba = new Uint8Array(cam.width * cam.height * 4);
    for (let i = 0; i < r.length; i++) rgba.set([grey[r[i]], grey[r[i]], grey[r[i]], 255], i * 4);
    return photoEdgeField({ width: cam.width, height: cam.height, rgba });
}

/** A build drawn alone from the pose, labelled by geometry as the evaluator labels a target arm; behind the street when given. */
const alone = (cam: Cam, mesh: TileTriangles, street?: Float32Array, labels?: Uint8Array) =>
    renderTriangles([mesh], cam, { supersample: 1, ...(street ? { occluderDepth: street } : {}), regions: { meshes: [labels ?? triangleRegions(mesh, FLAT, REGION.target)] } }).regions!;

const BUILDING_LOOP: Vec2[][] = [[[-10, -10], [10, -10], [10, 10], [-10, 10]]];

describe('placement reads the building, not the scan\'s defects', () => {
    it('restricts the scan\'s target to the footprint: debris outside it no longer counts against a build that clipped it', () => {
        // the scan's isolate holds the building and a slice of its neighbour (the debris, 6 m past the footprint); the photo
        // shows the neighbour whole, a mid grey beside the pale building
        const building = soup(box(-10, 10, -10, 10, 20));
        const debris = soup(box(10, 16, -4, 4, 12));
        const rest = soup(box(16, 30, -4, 4, 12));
        const street = ground();
        const full = merge([building, debris, rest, street]);
        const nb = building.texture.length, nd = debris.texture.length;
        const targetFlags = Uint8Array.from({ length: full.texture.length }, (_, i) => (i < nb + nd ? 1 : 0));
        const fullLabels = triangleRegions(full, FLAT, i => (targetFlags[i] ? REGION.target : REGION.neighbours));
        const cam = pose(60, 10);
        const field = photo(cam, [building, merge([debris, rest]), street], [REGION.target, REGION.neighbours, REGION.ground]);
        const streetDepth = renderFrameDepth(streetMesh(full, fullLabels)!, cam);

        const restricted = placementTarget(full, targetFlags, FLAT, { loops: BUILDING_LOOP, source: 'the building\'s footprint' });
        expect(restricted.footprint).toMatchObject({ used: true, source: 'the building\'s footprint', marginM: 0.3 });
        expect(restricted.footprint.misfitShare!).toBeLessThan(0.2);
        // every building triangle stays; of the debris only its wall on the footprint's edge does (it stands inside the building)
        expect(restricted.footprint.triangles).toBe(nb + 2);
        expect([...restricted.flags.subarray(0, nb)].every(f => f === 1)).toBe(true);

        const isolate = select(full, targetFlags), inFootprint = select(full, restricted.flags);
        const refOld = alone(cam, isolate, streetDepth), refNew = alone(cam, inFootprint, streetDepth);
        const clipped = alone(cam, building, streetDepth), raw = alone(cam, isolate, streetDepth);
        const d = degPerPx(cam);
        const before = { clipped: targetPlacement(field, refOld, clipped, d)!, raw: targetPlacement(field, refOld, raw, d)! };
        const after = { clipped: targetPlacement(field, refNew, clipped, d)!, raw: targetPlacement(field, refNew, raw, d)! };
        // read along the whole isolate, the neighbour's roofline over the debris was the "silhouette", and the build that
        // clipped the debris paid for it
        expect(before.clipped.errorPx - before.raw.errorPx).toBeGreaterThan(1);
        // within the footprint the clipped build sits on the photo's building, and the scan's debris is what costs
        expect(after.clipped.errorPx).toBeLessThan(1.5);
        expect(after.raw.errorPx).toBeGreaterThan(after.clipped.errorPx + 1);

        // a footprint that does not fit the scan (most of the building past it, pipeline K's 20% rule) is not used
        const misfit = placementTarget(full, targetFlags, FLAT, { loops: [[[-10, -10], [-4, -10], [-4, 10], [-10, 10]]], source: 'a wrong footprint' });
        expect(misfit.footprint.used).toBe(false);
        expect(misfit.footprint.misfitShare!).toBeGreaterThan(0.2);
        expect(misfit.footprint.reason).toMatch(/does not fit the scan/);
        expect(misfit.flags).toBe(targetFlags);
        // and with none, the whole target is read, and the result says so
        const none = placementTarget(full, targetFlags, FLAT, undefined);
        expect(none).toMatchObject({ flags: targetFlags, footprint: { used: false, source: 'none' } });
    });

    it('fills holes: a hole in the scan, or in a build, costs nothing', () => {
        // the photo: a pale block with a dark doorway inside it; the scan has a hole where the doorway is, a build is solid
        const W = 320, H = 240;
        const inBlock = (x: number, y: number) => x >= 120 && x < 200 && y >= 60 && y < 180;
        const inDoor = (x: number, y: number) => x >= 145 && x < 175 && y >= 110 && y < 160;
        const rgba = new Uint8Array(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = inDoor(x, y) ? 60 : inBlock(x, y) ? 220 : 40; rgba.set([v, v, v, 255], (y * W + x) * 4); }
        const field = photoEdgeField({ width: W, height: H, rgba });
        const labels = (hole: boolean) => Uint8Array.from({ length: W * H }, (_, i) => {
            const x = i % W, y = Math.floor(i / W);
            return inBlock(x, y) && !(hole && inDoor(x, y)) ? REGION.target : REGION.sky;
        });
        const solid = labels(false), holed = labels(true);
        // the hole is filled; a notch open to the sky (cut down from the block's top) is not a hole and stays
        expect([...targetFilled(holed, W, H)]).toEqual([...solid]);
        const notched = Uint8Array.from(solid, (l, i) => (i % W >= 150 && i % W < 170 && Math.floor(i / W) < 100 ? REGION.sky : l));
        expect([...targetFilled(notched, W, H)]).toEqual([...notched]);

        const inPlace = targetPlacement(field, solid, solid, 0.25)!;
        // the doorway's edges lie along the hole's border, but the hole is never read: the scan with it, and a build that
        // filled it, score as the solid block does, whichever is the reference
        expect(targetPlacement(field, holed, solid, 0.25)).toEqual(inPlace);
        expect(targetPlacement(field, solid, holed, 0.25)).toEqual(inPlace);
        expect(targetPlacement(field, holed, holed, 0.25)).toEqual(inPlace);
        expect(inPlace.errorPx).toBeLessThanOrEqual(1);
    });

    it('draws every build behind the street: a skirt below the street is hidden', () => {
        // the building meets the street at y = 0; the build's walls run 0.8 m under it (a skirt down to a lower ground level)
        const building = soup(box(-10, 10, -10, 10, 20));
        const skirted = soup(box(-10, 10, -10, 10, 20, -0.8));
        const street = ground();
        const full = merge([building, street]);
        const nb = building.texture.length;
        const fullLabels = triangleRegions(full, FLAT, i => (i < nb ? REGION.target : REGION.neighbours));
        const mesh = streetMesh(full, fullLabels)!;
        // the street is the tile's ground-labelled triangles alone
        expect(mesh.vertices.length).toBe(street.positions.length);
        const cam = pose(60, 10), d = degPerPx(cam);
        const field = photo(cam, [building, street], [REGION.target, REGION.ground]);
        const streetDepth = renderFrameDepth(mesh, cam);
        const reference = alone(cam, building, streetDepth);
        const self = targetPlacement(field, reference, reference, d)!;
        // drawn alone with nothing in front, the skirt shows under the photo's base line and costs the build
        const bare = targetPlacement(field, alone(cam, building), alone(cam, skirted), d)!;
        expect(bare.errorPx).toBeGreaterThan(targetPlacement(field, alone(cam, building), alone(cam, building), d)!.errorPx + 1);
        // behind the street it is hidden as the photo hides it: the build's outline is the building's, to the occluder's own
        // slack (0.25 m + 2% of depth: the few centimetres just under the street, one row of pixels along the base)
        const hidden = alone(cam, skirted, streetDepth);
        let differ = 0, target = 0;
        for (let i = 0; i < hidden.length; i++) { if (reference[i] === REGION.target) target++; if ((hidden[i] === REGION.target) !== (reference[i] === REGION.target)) differ++; }
        expect(differ / target).toBeLessThan(0.01);
        // and it costs nothing: no further from the photo than the building itself
        expect(targetPlacement(field, reference, hidden, d)!.errorPx).toBeLessThanOrEqual(self.errorPx + 0.15);
    });

    it('reads fetched footprints as the vector stage stores them, and keeps a fetch by place and radius', async () => {
        // a building's pieces (a podium, a setback tower) are its parts; a ring under three points is dropped
        const src: FootprintSource = {
            note: '3 pieces (stand-in)', buildings: [
                { id: 'g/a/e0', buildingId: 'g/a', ring: [[0, 0], [10, 0], [10, 10], [0, 10]], heightSource: 'vector' },
                { id: 'g/a/e1', buildingId: 'g/a', ring: [[2, 2], [8, 2], [8, 8], [2, 8]], heightSource: 'vector' },
                { id: 'g/b/e0', buildingId: 'g/b', ring: [[20, 0], [30, 0], [30, 10]], heightSource: 'vector' },
                { id: 'g/c/e0', buildingId: 'g/c', ring: [[40, 0], [50, 0]], heightSource: 'vector' }
            ]
        };
        expect(storedFootprints(src)).toEqual([
            { id: 'g/a', parts: [{ loops: [src.buildings[0].ring] }, { loops: [src.buildings[1].ring] }] },
            { id: 'g/b', parts: [{ loops: [src.buildings[2].ring] }] }
        ]);
        // the second fetch at the same place and radius is read from the cache; another radius is fetched
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-footprints-'));
        try {
            let fetches = 0;
            const fetch = async () => { fetches++; return src; };
            const place = { lat: 40.7484405, lng: -73.9856644 };
            const first = await cachedFootprints(dir, place, 120, fetch);
            const again = await cachedFootprints(dir, place, 120, fetch);
            expect(fetches).toBe(1);
            expect(first).toEqual(src);
            expect(again.buildings).toEqual(src.buildings);
            expect(again.note).toMatch(/^3 pieces \(stand-in\) \(cached \d{4}-\d\d-\d\d\)$/);
            await cachedFootprints(dir, place, 150, fetch);
            expect(fetches).toBe(2);
            // a failed fetch is not cached
            await expect(cachedFootprints(dir, { lat: 1, lng: 2 }, 100, async () => { throw new Error('down'); })).rejects.toThrow('down');
            expect(fs.readdirSync(dir).sort()).toEqual(['40.7484405_-73.9856644_r120.json', '40.7484405_-73.9856644_r150.json']);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('still ranks a build moved 4 m clearly below the building in place', () => {
        // the building and a rebuild of it (its roof 0.4 m low), 100 m from the camera; the decoy is the rebuild moved 4 m east
        const building = soup(box(-10, 10, -10, 10, 20));
        const rebuild = soup(box(-10, 10, -10, 10, 19.6));
        const street = ground();
        const full = merge([building, street]);
        const nb = building.texture.length;
        const targetFlags = Uint8Array.from({ length: full.texture.length }, (_, i) => (i < nb ? 1 : 0));
        const fullLabels = triangleRegions(full, FLAT, i => (targetFlags[i] ? REGION.target : REGION.neighbours));
        const ref = placementTarget(full, targetFlags, FLAT, { loops: BUILDING_LOOP, source: 'the building\'s footprint' });
        expect(ref.footprint.used).toBe(true);
        const cam = pose(110, 8), d = degPerPx(cam);
        const field = photo(cam, [building, street], [REGION.target, REGION.ground]);
        const streetDepth = renderFrameDepth(streetMesh(full, fullLabels)!, cam);
        const reference = alone(cam, select(full, ref.flags), streetDepth, fullLabels.filter((_, i) => ref.flags[i]));
        const inPlace = targetPlacement(field, reference, alone(cam, rebuild, streetDepth), d)!;
        const moved = targetPlacement(field, reference, alone(cam, shift(rebuild, 4), streetDepth), d)!;
        expect(inPlace.errorPx).toBeLessThan(2);
        // 4 m at 100 m is about 15 px at 640 wide: the decoy's sides stand that far off the photo's
        expect(moved.errorPx - inPlace.errorPx).toBeGreaterThan(4);
        expect(Math.abs(moved.shiftPx[0] + 15)).toBeLessThanOrEqual(3);
    });
});
