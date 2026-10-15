/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * tile_refine's photometric relief only carves what the photo supports, and labels it as inferred
 * (scratchbox_photometric_relief.hpp), on a synthetic 40 m tower whose +x facade carries a painted texture:
 *  - a regular 10 x 10 window grid: carved, and the GLBs say so (asset.extras.scratchbox.relief, _RELIEF_HEIGHT per vertex);
 *  - the same lattice painted only faintly except at 3 sites: the lattice is not confirmed, nothing is carved
 *    (before the gate those 3 sites became windows);
 *  - one line casting a 0.6 m shadow band: its depth would exceed the 0.35 m clamp, so no band is made (before, it was
 *    emitted at exactly the clamp).
 * The grid tower's clay render goes to test-results/screenshots/tile_refine_relief_provenance/ (gitignored).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { type Chunk, quad, flat, writeGlb, encodePng, buildTileRefine } from './helpers/synthetic-scan-glb';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/tile-refine-relief-provenance');
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_refine_relief_provenance');
const BIN = path.join(WORK, 'tile_refine');

type Paint = 'grid' | 'sparse-lattice' | 'wide-shadow';

/** The facade texture: 600 x 800 px over 30 x 40 m (5 cm), s along the facade from its -z end, t up. */
function facadeTexture(paint: Paint): Buffer {
    const TW = 600, TH = 800, PX = 0.05;
    const rgb = new Uint8Array(TW * TH * 3);
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const strong = new Set(['2,3', '6,7', '8,2']);
    for (let y = 0; y < TH; y++)
        for (let x = 0; x < TW; x++) {
            const s = x * PX, t = 40 - y * PX;
            const col = Math.floor((s - 0.8) / 3.0), sc = s - 0.8 - col * 3.0;
            const row = Math.floor((t - 1.0) / 3.6), tc = t - 1.0 - row * 3.6;
            const inWindow = col >= 0 && col < 10 && row >= 0 && row < 10 && sc < 1.4 && tc < 2.0;
            let v = 190;
            if (paint === 'wide-shadow') { if (t < 30 && t > 29.4) v = 70; }
            else if (inWindow) v = paint === 'grid' || strong.has(`${col},${row}`) ? 55 : 172;
            v += (rnd() - 0.5) * 10;
            for (let c = 0; c < 3; c++) rgb[(y * TW + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v)));
        }
    return encodePng(TW, TH, rgb);
}

interface Glb { json: any; attribute(name: string): Float32Array[] }

function readGlb(file: string): Glb {
    const b = fs.readFileSync(file);
    const jsonLen = b.readUInt32LE(12);
    const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
    const bin = b.subarray(20 + jsonLen + 8);
    return {
        json,
        attribute(name: string) {
            const out: Float32Array[] = [];
            for (const m of json.meshes)
                for (const p of m.primitives) {
                    if (p.attributes[name] === undefined) continue;
                    const acc = json.accessors[p.attributes[name]], view = json.bufferViews[acc.bufferView];
                    out.push(new Float32Array(bin.buffer.slice(bin.byteOffset + (view.byteOffset ?? 0), bin.byteOffset + (view.byteOffset ?? 0) + acc.count * 4)));
                }
            return out;
        }
    };
}

function run(paint: Paint): { relief: any; clay: Glb; textured: Glb } {
    const facade: Chunk = quad([10, 0, 15], [0, 0, -30], [0, 40, 0], 10, 10);  // x = 10, normal +x
    facade.uvs = [];
    for (let i = 0; i < facade.positions.length; i += 3) facade.uvs.push((15 - facade.positions[i + 2]) / 30, 1 - facade.positions[i + 1] / 40);
    facade.image = 0;
    const chunks: Chunk[] = [
        flat(-70, 70, -70, 70, 0, 20), facade,
        quad([-10, 0, -15], [0, 0, 30], [0, 40, 0], 6, 6), quad([-10, 0, 15], [20, 0, 0], [0, 40, 0], 6, 6),
        quad([10, 0, -15], [-20, 0, 0], [0, 40, 0], 6, 6), flat(-10, 10, -15, 15, 40, 6)
    ];
    const input = path.join(WORK, `${paint}.glb`), clay = path.join(WORK, `${paint}_clay.glb`), textured = path.join(WORK, `${paint}_textured.glb`);
    const statsPath = path.join(WORK, `${paint}_stats.json`);
    writeGlb(input, chunks, [facadeTexture(paint)]);
    execFileSync(BIN, ['--input', input, '--isolate', '--apron', '8', '--out-clay', clay, '--out-textured', textured, '--stats', statsPath, '--threads', '4'],
        { stdio: 'pipe', timeout: 300_000 });
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(clay);
    const pose = { x: 48, y: 22, z: 30, targetX: 10, targetY: 20, targetZ: 0, fov: 50 };
    const img = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, pose, 800, 600, { clipNearPlane: true, clayColor: [200, 200, 196], bgColor: [40, 44, 52, 255], lightDir: [0.6, 0.5, 0.6] });
    HeadlessMeshSilhouetteRenderer.exportPngToFile(path.join(SHOTS, `${paint}_clay.png`), 800, 600, img.rgba);
    return { relief: JSON.parse(fs.readFileSync(statsPath, 'utf8')).relief, clay: readGlb(clay), textured: readGlb(textured) };
}

describe('tile_refine photometric relief: evidence and provenance', () => {
    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        fs.mkdirSync(SHOTS, { recursive: true });
        buildTileRefine(REPO, BIN);
    }, 620_000);

    it('carves a confirmed window grid and labels it inferred, per vertex and per file', () => {
        const { relief, clay, textured } = run('grid');
        expect(relief.regionsTreated).toBe(1);
        expect(relief.provenance).toBe('inferred');
        expect(relief.recessArea_m2).toBeGreaterThan(150);
        expect(relief.facades[0].latticeConfirmation).toBeGreaterThan(0.8);
        for (const glb of [clay, textured]) {
            const extras = glb.json.asset.extras?.scratchbox?.relief;
            expect(extras?.provenance).toBe('inferred');
            expect(extras?.attribute).toBe('_RELIEF_HEIGHT');
            const heights = glb.attribute('_RELIEF_HEIGHT');
            expect(heights.length).toBeGreaterThan(0);
            const all = heights.flatMap(h => Array.from(h));
            const displaced = all.filter(h => h !== 0);
            expect(displaced.length).toBeGreaterThan(100);
            expect(Math.min(...displaced)).toBeGreaterThanOrEqual(relief.facades[0].minHeight_m - 1e-6);
            expect(Math.max(...all.map(Math.abs))).toBeCloseTo(extras.maxAbsHeight_m, 5);
        }
        // the clay has one vertex per (position, normal): every position the relief displaced is in it
        expect(clay.json.asset.extras.scratchbox.relief.displacedVertices).toBeGreaterThan(100);
    }, 300_000);

    it('does not carve a lattice confirmed at only 3 of its sites', () => {
        const { relief, clay } = run('sparse-lattice');
        expect(relief.latticesRejected).toBe(1);
        expect(relief.latticeFeaturesDropped).toBe(3);
        expect(relief.regionsTreated).toBe(0);
        expect(relief.recessArea_m2).toBe(0);
        expect(relief.provenance).toBe('none');
        expect(clay.json.asset.extras).toBeUndefined();
        expect(clay.attribute('_RELIEF_HEIGHT')).toHaveLength(0);
    }, 300_000);

    it('drops a shadowed band whose depth would exceed the clamp instead of emitting the clamp', () => {
        const { relief, clay } = run('wide-shadow');
        expect(relief.proudClampedDropped).toBeGreaterThanOrEqual(1);
        expect(relief.proudArea_m2).toBe(0);
        expect(relief.heightMax_m).toBeLessThan(0.35 - 1e-6);
        expect(clay.attribute('_RELIEF_HEIGHT')).toHaveLength(0);
    }, 300_000);
});
