/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tile_refine's facade frames face out of the building whatever the scan's winding (photometric_relief orientOutward). A
 * facade's normal was the area sum of its scan triangles' normals, and a photogrammetric remesh leaves whole walls wound
 * inward: on Penn 2 a 3,100 m² wall (F5) was framed facing into the tower, so pipeline K rebuilt it facing in, its photo
 * mirrored and its occlusion fan cast inside. A facade wound inward on a closed building is turned: its frame matches the
 * same facade wound outward (same normal, same axes, the same photo pixel for pixel), its scan triangles are rewound to
 * face out, and the fold check does not count them; one wound outward is left as it is.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../src/node/texture-processing';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { type Chunk, quad, flat, writeGlb, encodePng, buildTileRefine } from './helpers/synthetic-scan-glb';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/tile-refine-outward');
const BIN = path.join(WORK, 'tile_refine');

/** A facade texture with a mark that tells left from right: wall grey, a dark window grid, a red band on its left third. */
function facadeTexture(): Buffer {
    const TW = 300, TH = 400, PX = 0.1, rgb = new Uint8Array(TW * TH * 3);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
        const s = x * PX, t = 40 - y * PX, win = (s - 0.8) % 3 < 1.4 && (t - 1) % 3.6 < 2, o = (y * TW + x) * 3;
        if (x < TW / 3 && !win) { rgb[o] = 200; rgb[o + 1] = 40; rgb[o + 2] = 40; } else rgb.fill(win ? 60 : 185, o, o + 3);
    }
    return encodePng(TW, TH, rgb);
}

/** The building (facade at x = 10, 30 x 40 m, its photo on it) on its ground; the facade's triangles wound outward (+x) or inward. */
function scene(inward: boolean): Chunk[] {
    const facade: Chunk = inward ? quad([10, 0, -15], [0, 0, 30], [0, 40, 0], 10, 10) : quad([10, 0, 15], [0, 0, -30], [0, 40, 0], 10, 10);
    facade.uvs = [];
    for (let i = 0; i < facade.positions.length; i += 3) facade.uvs.push((15 - facade.positions[i + 2]) / 30, 1 - facade.positions[i + 1] / 40);
    facade.image = 0;
    return [
        flat(-70, 70, -70, 70, 0, 20), facade,
        quad([-10, 0, -15], [0, 0, 30], [0, 40, 0], 6, 6), quad([-10, 0, 15], [20, 0, 0], [0, 40, 0], 6, 6),
        quad([10, 0, -15], [-20, 0, 0], [0, 40, 0], 6, 6), flat(-10, 10, -15, 15, 40, 6)
    ];
}

interface Frame { facadeId: number; image: string; centroid: number[]; normal: number[]; axisS: number[]; axisT: number[]; sMin: number; sMax: number; outward?: { openFront: number; openBack: number; turned: boolean; decided: boolean } }

function run(name: string, inward: boolean): { facade: Frame; photo: Uint8Array; facing: number; stats: any } {
    const dir = path.join(WORK, name), orthos = path.join(dir, 'orthos');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(orthos, { recursive: true });
    writeGlb(path.join(dir, 'in.glb'), scene(inward), [facadeTexture()]);
    execFileSync(BIN, ['--input', path.join(dir, 'in.glb'), '--isolate', '--apron', '8', '--out-clay', path.join(dir, 'clay.glb'), '--out-textured', path.join(dir, 'tex.glb'),
        '--stats', path.join(dir, 'stats.json'), '--threads', '4', '--relief-orthos', orthos, '--relief-export-only'], { stdio: 'pipe', timeout: 300_000 });
    // the facade on the plane x = 10, whichever way its frame faces
    const frames = JSON.parse(fs.readFileSync(path.join(orthos, 'facades.json'), 'utf8')).facades as Frame[];
    const facade = frames.find(f => Math.abs(f.normal[0]) > 0.9 && Math.abs(f.centroid[0] - 10) < 0.5)!;
    expect(facade).toBeDefined();
    const photo = decodePng(fs.readFileSync(path.join(orthos, facade.image))).rgba;
    // the clay's triangles on the plane x = 10: their area-weighted facing along x
    const g = parseGlbBytes(fs.readFileSync(path.join(dir, 'clay.glb')));
    let facing = 0;
    for (const m of g.json.meshes ?? []) for (const p of m.primitives ?? []) {
        const P = readAccessor(g, p.attributes.POSITION).data, I = readAccessor(g, p.indices).data;
        for (let t = 0; t + 2 < I.length; t += 3) {
            const v = [I[t], I[t + 1], I[t + 2]].map(k => [P[k * 3], P[k * 3 + 1], P[k * 3 + 2]]);
            if (!v.every(q => Math.abs(q[0] - 10) < 0.05)) continue;
            const u = [0, 1, 2].map(k => v[1][k] - v[0][k]), w = [0, 1, 2].map(k => v[2][k] - v[0][k]);
            facing += (u[1] * w[2] - u[2] * w[1]) / 2;
        }
    }
    return { facade, photo, facing, stats: JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')) };
}

describe('tile_refine facade frames face out', () => {
    beforeAll(() => { fs.mkdirSync(WORK, { recursive: true }); buildTileRefine(REPO, BIN); }, 620_000);

    it('turns a facade wound into the building to face out, its photo and frame the same as when wound out, its scan rewound', () => {
        const out = run('outward', false), inw = run('inward', true);
        // wound outward: left as it is, open in front and closed behind
        expect(out.facade.normal[0]).toBeGreaterThan(0.99);
        expect(out.facade.outward!.turned).toBe(false);
        expect(out.facade.outward!.decided).toBe(true);
        expect(out.facade.outward!.openFront).toBeGreaterThan(0.5);
        expect(out.facade.outward!.openBack).toBeLessThan(0.05);
        expect(out.stats.relief.turnedRegions).toBe(0);
        expect(out.facing).toBeGreaterThan(1000);
        // wound inward: turned, its frame and photo those of the facade wound outward (not mirrored)
        expect(inw.facade.outward!.turned).toBe(true);
        expect(inw.facade.outward!.decided).toBe(true);
        expect(inw.facade.outward!.openFront).toBeGreaterThan(0.5);
        expect(inw.facade.normal[0]).toBeGreaterThan(0.99);
        for (let k = 0; k < 3; k++) {
            expect(inw.facade.axisS[k]).toBeCloseTo(out.facade.axisS[k], 6);
            expect(inw.facade.axisT[k]).toBeCloseTo(out.facade.axisT[k], 6);
        }
        expect(inw.facade.sMin).toBeCloseTo(out.facade.sMin, 4);
        expect(inw.facade.sMax).toBeCloseTo(out.facade.sMax, 4);
        expect(inw.photo.length).toBe(out.photo.length);
        let differ = 0;
        for (let i = 0; i < out.photo.length; i++) if (Math.abs(inw.photo[i] - out.photo[i]) > 2) differ++;
        expect(differ / out.photo.length).toBeLessThan(0.01);
        // the scan under it faces out, rewound on purpose (no folds counted)
        expect(inw.stats.relief.turnedRegions).toBe(1);
        expect(inw.stats.relief.turnedTriangles).toBeGreaterThan(0);
        expect(inw.facing).toBeCloseTo(out.facing, 0);
        expect(inw.stats.relief.flips).toBe(out.stats.relief.flips);
    }, 600_000);
});
