/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tile_refine keeps a block the scan shows standing off a wall on its own risers (scratchbox_scan_rectifier.hpp,
 * buildProudBlocks; facadeFlatten skips it too), on a synthetic scan shaped like the Washington Square Arch's south
 * keystone as Google's tiles have it: a 1.4 x 2.2 m block whose front is tilted 6 degrees, flush with the wall at one
 * side and 16 cm proud at the other, its sides reaching 0.9 m back through a wall crinkled +-4 cm. The block keeps its
 * shape while the crinkle around it is still flattened, and the proud-feature audit (independent of both passes)
 * reports nothing removed; the clay marks the block's vertices _PROUD_BLOCK 1 with no _RECTIFY_DISPLACEMENT. With
 * --no-proud-blocks the same block is pressed into the wall and the audit reports it.
 * Clay renders go to test-results/screenshots/tile_refine_proud_blocks/ (gitignored).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { type Chunk, type Glb, quad, flat, writeGlb, readGlb, buildTileRefine } from './helpers/synthetic-scan-glb';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/tile-refine-proud-blocks');
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_refine_proud_blocks');
const BIN = path.join(WORK, 'tile_refine');

/** The +x wall at x = 10 (z -10..10, y 0..40) on a 1 m grid whose inner vertices sit -4..+4 cm off the plane. */
function crinkledWall(): Chunk {
    let s = 4242;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const positions: number[] = [], indices: number[] = [];
    const NZ = 20, NY = 40, W = NZ + 1;
    for (let j = 0; j <= NY; j++)
        for (let k = 0; k <= NZ; k++) {
            const edge = k === 0 || k === NZ || j === 0 || j === NY;
            positions.push(10 + (edge ? 0 : (rnd() - 0.5) * 0.08), j, -10 + k);
        }
    for (let j = 0; j < NY; j++)
        for (let k = 0; k < NZ; k++) {
            const a = j * W + k, b = a + 1, c = a + W, d = c + 1;
            indices.push(a, d, b, a, c, d);
        }
    return { positions, indices };
}

/** The block: front from (z 1, x 10.005) to (z 2.4, x 10.16) between y 25 and 27.2; its sides reach back to x 9.1. */
const BLOCK = { z0: 1, z1: 2.4, y0: 25, y1: 27.2, xBack: 9.1, xFront0: 10.005, xFront1: 10.16 };
function wedgeBlock(): Chunk {
    const { z0, z1, y0, y1, xBack, xFront0, xFront1 } = BLOCK;
    const P = [[xFront0, y0, z0], [xFront1, y0, z1], [xFront1, y1, z1], [xFront0, y1, z0], [xBack, y0, z0], [xBack, y0, z1], [xBack, y1, z1], [xBack, y1, z0]];
    const front = [0, 2, 1, 0, 3, 2], sideZ0 = [4, 3, 0, 4, 7, 3], sideZ1 = [1, 2, 6, 1, 6, 5], bottom = [4, 0, 1, 4, 1, 5], top = [3, 7, 6, 3, 6, 2];
    return { positions: P.flat(), indices: [...front, ...sideZ0, ...sideZ1, ...bottom, ...top] };
}

interface Mesh { vertices: Float32Array; indices: Uint32Array }

function run(name: string, extra: string[]): { stats: any; clay: Mesh; glb: Glb } {
    const chunks: Chunk[] = [
        flat(-70, 70, -70, 70, 0, 20), crinkledWall(), wedgeBlock(),
        quad([-10, 0, -10], [0, 0, 20], [0, 40, 0], 6, 6), quad([-10, 0, 10], [20, 0, 0], [0, 40, 0], 6, 6),
        quad([10, 0, -10], [-20, 0, 0], [0, 40, 0], 6, 6), flat(-10, 10, -10, 10, 40, 6)
    ];
    const input = path.join(WORK, `${name}.glb`), clay = path.join(WORK, `${name}_clay.glb`), statsPath = path.join(WORK, `${name}_stats.json`);
    writeGlb(input, chunks);
    execFileSync(BIN, ['--input', input, '--isolate', '--apron', '8', '--no-relief', '--out-clay', clay, '--stats', statsPath, '--threads', '4', ...extra],
        { stdio: 'pipe', timeout: 300_000 });
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(clay);
    // raking light across the wall from the -z side shows the block's flank and any crinkle left
    const pose = { x: 22, y: 27, z: 9, targetX: 10, targetY: 25, targetZ: 1.5, fov: 40 };
    const img = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, pose, 800, 600, { clipNearPlane: true, clayColor: [200, 200, 196], bgColor: [40, 44, 52, 255], lightDir: [0.35, 0.25, -0.9] });
    HeadlessMeshSilhouetteRenderer.exportPngToFile(path.join(SHOTS, `${name}_clay.png`), 800, 600, img.rgba);
    return { stats: JSON.parse(fs.readFileSync(statsPath, 'utf8')), clay: mesh, glb: readGlb(clay) };
}

/** The largest x of the output vertices on the block's front (the proud edge sits at x 10.16 as scanned). */
function blockFront(mesh: Mesh): number {
    let m = -Infinity;
    for (let i = 0; i < mesh.vertices.length; i += 3) {
        const [x, y, z] = [mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]];
        if (x > 9.9 && x < 10.4 && y > BLOCK.y0 - 0.05 && y < BLOCK.y1 + 0.05 && z > BLOCK.z0 - 0.05 && z < BLOCK.z1 + 0.05) m = Math.max(m, x);
    }
    return m;
}

/** Largest residual of the wall's vertices away from the block from their least-squares plane x = a y + b z + c. */
function wallResidual(mesh: Mesh): number {
    const pts: number[][] = [];
    for (let i = 0; i < mesh.vertices.length; i += 3) {
        const [x, y, z] = [mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]];
        const nearBlock = y > BLOCK.y0 - 1.5 && y < BLOCK.y1 + 1.5 && z > BLOCK.z0 - 1.5 && z < BLOCK.z1 + 1.5;
        if (x > 9.85 && x < 10.15 && y > 1.5 && y < 38.5 && Math.abs(z) < 8.5 && !nearBlock) pts.push([x, y, z]);
    }
    let Syy = 0, Syz = 0, Szz = 0, Sy = 0, Sz = 0, Sx = 0, Sxy = 0, Sxz = 0;
    for (const [x, y, z] of pts) { Syy += y * y; Syz += y * z; Szz += z * z; Sy += y; Sz += z; Sx += x; Sxy += x * y; Sxz += x * z; }
    const A = [[Syy, Syz, Sy], [Syz, Szz, Sz], [Sy, Sz, pts.length]], rhs = [Sxy, Sxz, Sx];
    const det3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const D = det3(A);
    const [a, b, c] = [0, 1, 2].map(col => det3(A.map((r, ri) => r.map((v, ci) => (ci === col ? rhs[ri] : v)))) / D);
    expect(pts.length).toBeGreaterThan(300);
    return Math.max(...pts.map(([x, y, z]) => Math.abs(x - (a * y + b * z + c))));
}

describe('tile_refine proud blocks', () => {
    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        fs.mkdirSync(SHOTS, { recursive: true });
        buildTileRefine(REPO, BIN);
    }, 620_000);

    it('keeps a keystone-like block on its risers while the crinkle around it is flattened', () => {
        const kept = run('wedge_block', []);
        const pressed = run('wedge_block_no_proud_blocks', ['--no-proud-blocks']);

        // kept as scanned: the proud edge stays 16 cm out, and the audit finds nothing removed
        expect(kept.stats.rectify.proudBlocks.blocks).toBeGreaterThanOrEqual(1);
        expect(kept.stats.rectify.proudBlocks.keptAsScannedGroups).toBeGreaterThan(0);
        expect(kept.stats.flatten.proudBlockGroupsKept).toBeGreaterThan(0);
        expect(blockFront(kept.clay)).toBeCloseTo(BLOCK.xFront1, 3);
        const audit = kept.stats.proudFeatures;
        expect(audit.features).toBeGreaterThanOrEqual(1);
        expect(audit.removed).toBe(0);
        expect(audit.retainedVolumeShare).toBeGreaterThan(0.95);
        // the wall around it is still one plane
        expect(wallResidual(kept.clay)).toBeLessThan(0.003);
        // per-vertex provenance in the clay (one primitive, vertices in the order loadMeshFromGlb returns them)
        const [flag] = kept.glb.attribute('_PROUD_BLOCK'), [moved] = kept.glb.attribute('_RECTIFY_DISPLACEMENT');
        expect(flag.length).toBe(kept.clay.vertices.length / 3);
        expect(moved.length).toBe(flag.length);
        let front = 0, wallMoved = 0;
        for (let i = 0; i < flag.length; i++) {
            const [x, y, z] = [kept.clay.vertices[3 * i], kept.clay.vertices[3 * i + 1], kept.clay.vertices[3 * i + 2]];
            if (x > 10.05 && y > BLOCK.y0 - 0.01 && y < BLOCK.y1 + 0.01 && z > BLOCK.z0 - 0.01 && z < BLOCK.z1 + 0.01) {
                ++front;
                expect(flag[i]).toBe(1);
                expect(moved[i]).toBe(0);
            } else if (Math.abs(x - 10) < 0.06 && y > 2 && y < 20 && Math.abs(z) < 8) {
                wallMoved = Math.max(wallMoved, moved[i]);
            }
        }
        expect(front).toBeGreaterThanOrEqual(2);
        expect(wallMoved).toBeGreaterThan(0.01);

        // without the protection the block is pressed into the wall, and the audit says so
        expect(pressed.stats.rectify.proudBlocks.blocks).toBe(0);
        expect(pressed.glb.attribute('_PROUD_BLOCK')).toHaveLength(0);
        expect(blockFront(pressed.clay)).toBeLessThan(10.05);
        const lost = pressed.stats.proudFeatures;
        expect(lost.removed).toBeGreaterThanOrEqual(1);
        const block = lost.largestRemoved[0];
        expect(block.retained).toBeLessThan(0.2);
        expect(block.centroid[1]).toBeGreaterThan(BLOCK.y0);
        expect(block.centroid[1]).toBeLessThan(BLOCK.y1);
        expect(block.rawP95_m).toBeGreaterThan(0.12);

        for (const r of [kept, pressed]) {
            expect(r.stats.rectify.flips).toBe(0);
            expect(r.stats.openEdges.final.newBoundaryEdges).toBe(0);
        }
    }, 300_000);
});
