/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tile_refine's occlusion masks (--relief-occlusion / --relief-occluders): beside each relief ortho, the share of a fan of
 * rays from the facade toward where the capture stood that something in front of it blocks. A block standing 2 to 5 m in
 * front of the lower facade is in the mask; the upper facade is clear; with the block absent nothing is; and a block that
 * is only in the occluder file (taken out of the scan, as the tree strip does) is in the mask too.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { decodePng } from '../src/node/texture-processing';
import { type Chunk, quad, flat, writeGlb, encodePng, buildTileRefine } from './helpers/synthetic-scan-glb';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/tile-refine-occlusion');
const BIN = path.join(WORK, 'tile_refine');

/** A plain facade texture: wall grey with a dark window grid (the relief needs a decoded photo to draw an ortho). */
function facadeTexture(): Buffer {
    const TW = 300, TH = 400, PX = 0.1, rgb = new Uint8Array(TW * TH * 3);
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
        const s = x * PX, t = 40 - y * PX, win = (s - 0.8) % 3 < 1.4 && (t - 1) % 3.6 < 2;
        rgb.fill(win ? 60 : 185, (y * TW + x) * 3, (y * TW + x) * 3 + 3);
    }
    return encodePng(TW, TH, rgb);
}

/** A closed box (outward faces), x0..x1, y0..y1, z0..z1. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): Chunk[] {
    return [
        quad([x1, y0, z1], [0, 0, z0 - z1], [0, y1 - y0, 0], 2, 2), quad([x0, y0, z0], [0, 0, z1 - z0], [0, y1 - y0, 0], 2, 2),
        quad([x0, y0, z1], [x1 - x0, 0, 0], [0, y1 - y0, 0], 2, 2), quad([x1, y0, z0], [x0 - x1, 0, 0], [0, y1 - y0, 0], 2, 2),
        flat(x0, x1, z0, z1, y1, 2)
    ];
}

/** The building (facade at x = 10, normal +x, 30 x 40 m) on its ground, and optionally the block in front of it. */
function scene(withBlock: boolean): Chunk[] {
    const facade: Chunk = quad([10, 0, 15], [0, 0, -30], [0, 40, 0], 10, 10);
    facade.uvs = [];
    for (let i = 0; i < facade.positions.length; i += 3) facade.uvs.push((15 - facade.positions[i + 2]) / 30, 1 - facade.positions[i + 1] / 40);
    facade.image = 0;
    return [
        flat(-70, 70, -70, 70, 0, 20), facade,
        quad([-10, 0, -15], [0, 0, 30], [0, 40, 0], 6, 6), quad([-10, 0, 15], [20, 0, 0], [0, 40, 0], 6, 6),
        quad([10, 0, -15], [-20, 0, 0], [0, 40, 0], 6, 6), flat(-10, 10, -15, 15, 40, 6),
        ...(withBlock ? box(12, 15, 2, 8, -5, 5) : [])
    ];
}

interface Frame { facadeId: number; image: string; centroid: number[]; normal: number[]; axisS: number[]; axisT: number[]; orthoSMin: number; orthoTMax: number; pixel: number; width: number; height: number; occludedMask?: string; occludedShare?: number; occlusionMean?: number }

function run(name: string, input: Chunk[], occluders?: Chunk[]): { facade: Frame; mask?: { width: number; height: number; v: Uint8Array }; stats: any } {
    const dir = path.join(WORK, name), orthos = path.join(dir, 'orthos');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(orthos, { recursive: true });
    const tex = [facadeTexture()];
    writeGlb(path.join(dir, 'in.glb'), input, tex);
    const args = ['--input', path.join(dir, 'in.glb'), '--isolate', '--apron', '8', '--out-clay', path.join(dir, 'clay.glb'), '--out-textured', path.join(dir, 'tex.glb'),
        '--stats', path.join(dir, 'stats.json'), '--threads', '4', '--relief-orthos', orthos, '--relief-export-only'];
    if (occluders) { writeGlb(path.join(dir, 'occ.glb'), occluders, tex); args.push('--relief-occluders', path.join(dir, 'occ.glb')); }
    else args.push('--relief-occlusion');
    execFileSync(BIN, args, { stdio: 'pipe', timeout: 300_000 });
    const frames = JSON.parse(fs.readFileSync(path.join(orthos, 'facades.json'), 'utf8')).facades as Frame[];
    const facade = frames.find(f => f.normal[0] > 0.9)!;
    expect(facade).toBeDefined();
    let mask: { width: number; height: number; v: Uint8Array } | undefined;
    if (facade.occludedMask) {
        const m = decodePng(fs.readFileSync(path.join(orthos, facade.occludedMask)));
        mask = { width: m.width, height: m.height, v: Uint8Array.from({ length: m.width * m.height }, (_, k) => m.rgba[k * 4]) };
    }
    return { facade, mask, stats: JSON.parse(fs.readFileSync(path.join(dir, 'stats.json'), 'utf8')) };
}

/** Mean mask value (0..1) over the facade's pixels whose world point lies in y0..y1, z0..z1. */
function meanIn(f: Frame, m: { width: number; height: number; v: Uint8Array }, y0: number, y1: number, z0: number, z1: number): { mean: number; n: number } {
    let s = 0, n = 0;
    for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) {
        const ss = f.orthoSMin + (x + 0.5) * f.pixel, tt = f.orthoTMax - (y + 0.5) * f.pixel;
        const wy = f.centroid[1] + ss * f.axisS[1] + tt * f.axisT[1], wz = f.centroid[2] + ss * f.axisS[2] + tt * f.axisT[2];
        if (wy >= y0 && wy <= y1 && wz >= z0 && wz <= z1) { s += m.v[y * m.width + x] / 255; n++; }
    }
    return { mean: n ? s / n : NaN, n };
}

describe('tile_refine occlusion masks', () => {
    beforeAll(() => { fs.mkdirSync(WORK, { recursive: true }); buildTileRefine(REPO, BIN); }, 620_000);

    it('marks the facade behind a block standing in front of it, and only there', () => {
        const { facade, mask, stats } = run('block', scene(true));
        expect(stats.relief.occlusion.enabled).toBe(true);
        expect(stats.relief.occlusion.triangles).toBeGreaterThan(0);
        expect(mask).toBeDefined();
        expect(mask!.width).toBe(facade.width);
        expect(mask!.height).toBe(facade.height);
        const behind = meanIn(facade, mask!, 3, 6, -2, 2), above = meanIn(facade, mask!, 20, 38, -14, 14), beside = meanIn(facade, mask!, 1, 8, 10, 14);
        expect(behind.n).toBeGreaterThan(100);
        expect(behind.mean).toBeGreaterThan(0.6);
        expect(above.mean).toBeLessThan(0.02);
        expect(beside.mean).toBeLessThan(0.15);
        expect(facade.occludedShare!).toBeGreaterThan(0.005);
        expect(facade.occludedShare!).toBeLessThan(0.1);
    }, 300_000);

    it('marks nothing when nothing stands in front', () => {
        const { facade, mask } = run('clear', scene(false));
        expect(mask).toBeDefined();
        expect(facade.occludedShare).toBe(0);
        expect(mask!.v.reduce((a, v) => Math.max(a, v), 0)).toBeLessThan(40);
    }, 300_000);

    it('casts against the occluder file when the block was taken out of the scan', () => {
        const { facade, mask, stats } = run('file', scene(false), scene(true));
        expect(stats.relief.occlusion.source).toContain('occ.glb');
        expect(meanIn(facade, mask!, 3, 6, -2, 2).mean).toBeGreaterThan(0.6);
        expect(meanIn(facade, mask!, 20, 38, -14, 14).mean).toBeLessThan(0.02);
    }, 300_000);
});
