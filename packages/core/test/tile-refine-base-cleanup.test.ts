/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tile_refine --isolate cleans up the base of the structure (scratchbox_tile_refine.hpp, isolateStructure), on synthetic
 * scans with known answers:
 *  - a 60 m tower wrapped in a 5 m sidewalk-shed ring: the ring is dropped (roof and outer walls), a floor slab inside
 *    the tower is dropped, a car on the street is gone because the ground is rebuilt on the terrain, and a wall that
 *    continues below the street is cut at street level;
 *  - a 50 m tower on a 12 m podium: the podium stands above the low-attachment height, so it is kept.
 * Clay renders of both outputs go to test-results/screenshots/tile_refine_base_cleanup/ (gitignored).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { type Chunk, quad, flat, writeGlb, buildTileRefine } from './helpers/synthetic-scan-glb';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/tile-refine-base-cleanup');
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_refine_base_cleanup');
const BIN = path.join(WORK, 'tile_refine');

/** The four walls of an axis-aligned box from y0 to y1 (no caps), wound facing into the box. */
function walls(x0: number, x1: number, z0: number, z1: number, y0: number, y1: number, n = 4): Chunk[] {
    const h = y1 - y0;
    return [
        quad([x1, y0, z0], [0, 0, z1 - z0], [0, h, 0], n, n),  // +x
        quad([x0, y0, z1], [0, 0, z0 - z1], [0, h, 0], n, n),  // -x
        quad([x1, y0, z1], [x0 - x1, 0, 0], [0, h, 0], n, n),  // +z
        quad([x0, y0, z0], [x1 - x0, 0, 0], [0, h, 0], n, n)   // -z
    ];
}

/** Upward-facing ring between an outer and an inner square (both centred on the origin). */
function ring(outer: number, inner: number, y: number): Chunk[] {
    return [
        flat(-outer, outer, -outer, -inner, y), flat(-outer, outer, inner, outer, y),
        flat(-outer, -inner, -inner, inner, y), flat(inner, outer, -inner, inner, y)
    ];
}

function run(name: string, chunks: Chunk[], extra: string[] = []): { stats: any; clay: { vertices: Float32Array; indices: Uint32Array } } {
    const input = path.join(WORK, `${name}.glb`), clay = path.join(WORK, `${name}_clay.glb`), statsPath = path.join(WORK, `${name}_stats.json`);
    writeGlb(input, chunks);
    execFileSync(BIN, ['--input', input, '--isolate', '--apron', '8', '--out-textured', path.join(WORK, `${name}_textured.glb`), '--out-clay', clay,
        '--stats', statsPath, '--threads', '4', ...extra], { stdio: 'pipe', timeout: 300_000 });
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(clay);
    const p = { x: 70, y: 45, z: 90, targetX: 0, targetY: 15, targetZ: 0, fov: 45 };
    const img = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, p, 800, 600, { clipNearPlane: true, clayColor: [200, 200, 196], bgColor: [40, 44, 52, 255], lightDir: [0.4, 0.7, 0.5] });
    HeadlessMeshSilhouetteRenderer.exportPngToFile(path.join(SHOTS, `${name}_clay.png`), 800, 600, img.rgba);
    return { stats: JSON.parse(fs.readFileSync(statsPath, 'utf8')), clay: mesh };
}

/** Vertices of the output clay inside an axis-aligned box. */
function verticesIn(mesh: { vertices: Float32Array }, test: (x: number, y: number, z: number) => boolean): number {
    let n = 0;
    for (let i = 0; i < mesh.vertices.length; i += 3) if (test(mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2])) n++;
    return n;
}

describe('tile_refine --isolate: the base of the structure', () => {
    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        fs.mkdirSync(SHOTS, { recursive: true });
        buildTileRefine(REPO, BIN);
    }, 620_000);

    it('drops a low shed ring, an interior floor and a car, and ends the walls at street level', () => {
        const ground = flat(-70, 70, -70, 70, 0, 70);
        const tower = [...walls(-10, 10, -10, 10, 5, 60, 6), flat(-10, 10, -10, 10, 60)];
        const shed = [...ring(14, 10, 5), ...walls(-14, 14, -14, 14, 0, 5)];
        const slab = flat(-6, 6, -6, 6, 20);                                     // a floor inside the tower
        const car = [...walls(-17, -15, 2, 4.5, 0, 1.5, 1), flat(-17, -15, 2, 4.5, 1.5, 1)];
        const skirt = quad([10.2, -4, -6], [0, 0, 12], [0, 9, 0], 2, 4);        // from 4 m below the street up through it
        const { stats, clay } = run('shed_tower', [ground, ...tower, ...shed, slab, ...car, skirt]);
        const iso = stats.isolate;

        expect(iso.lowAttachment.coreHeight_m).toBeCloseTo(8, 6);              // min(8, half of 60)
        expect(iso.lowAttachment.area_m2).toBeGreaterThan(0.75 * (28 * 28 - 20 * 20));
        expect(iso.lowAttachment.trianglesDropped).toBeGreaterThan(0);
        expect(iso.interiorFloorsDropped).toBeGreaterThan(0);
        expect(iso.belowGround.cut + iso.belowGround.dropped).toBeGreaterThan(0);
        expect(iso.groundPatch.triangles).toBeGreaterThan(0);
        const t = iso.triangles;
        expect(t.kept).toBe(t.core + t.closure + t.apron + t.ground + t.belowGroundDelta);

        const ring2d = (x: number, z: number) => Math.max(Math.abs(x), Math.abs(z)) > 10.6 && Math.max(Math.abs(x), Math.abs(z)) < 14.4;
        expect(verticesIn(clay, (x, y, z) => ring2d(x, z) && y > 0.5 && y < 4.6)).toBe(0);                 // shed roof and sides gone
        expect(verticesIn(clay, (x, y, z) => Math.abs(x) < 5.5 && Math.abs(z) < 5.5 && Math.abs(y - 20) < 0.5)).toBe(0);  // slab gone
        expect(verticesIn(clay, (x, y, z) => x > -17.2 && x < -14.8 && z > 1.8 && z < 4.7 && y > 0.3)).toBe(0);         // car gone
        expect(verticesIn(clay, (_x, y) => y < -0.3 - 1e-3)).toBe(0);                                       // nothing below street level
        expect(verticesIn(clay, (_x, y) => Math.abs(y - 60) < 0.2)).toBeGreaterThan(0);                     // the tower is there
        expect(verticesIn(clay, (x, y, z) => Math.abs(x - 10) < 0.3 && y > 30 && y < 40)).toBeGreaterThan(0);
    });

    it('keeps a podium that stands above the low-attachment height', () => {
        const ground = flat(-70, 70, -70, 70, 0, 70);
        const tower = [...walls(-8, 8, -8, 8, 12, 50, 6), flat(-8, 8, -8, 8, 50)];
        const podium = [...ring(16, 8, 12), ...walls(-16, 16, -16, 16, 0, 12, 6)];
        const { stats, clay } = run('podium_tower', [ground, ...tower, ...podium]);
        expect(stats.isolate.lowAttachment.cells).toBe(0);
        expect(verticesIn(clay, (x, y, z) => Math.max(Math.abs(x), Math.abs(z)) > 12 && Math.abs(y - 12) < 0.3)).toBeGreaterThan(0);  // podium roof
        expect(verticesIn(clay, (x, y) => Math.abs(x - 16) < 0.3 && y > 2 && y < 10)).toBeGreaterThan(0);                            // podium wall
    });
});
