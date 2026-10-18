/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Object ownership by multi-view mask voting (scratchbox_mask_vote.hpp, tile_refine --ownership-*), on a synthetic scan
 * with a known answer: a 24 m tower (red texture) with a 14 m neighbour (blue) built against its east wall. Their
 * footprints touch, so the geometric isolate (footprint + connectivity) takes both. The masks come from the rendered views
 * alone (the red pixels, as a segmenter would see them), made imperfect on purpose: dilated 3 px (edge bleed) and, in
 * one view, a wrong 80 px block. The vote must
 *  - drop the neighbour's raised triangles and keep every raised triangle of the tower (ownership accuracy against the
 *    known owner of every triangle);
 *  - beat the geometric decision on held-out views;
 *  - feed scan_fit: on the geometric isolate (neighbour still in it) the vote leaves the neighbour out of the fit as clutter.
 * The owner-coloured panels (view + mask | vote heat map / geometry | vote) go to test-results/screenshots/mask_voting/.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { ScanFitService } from '../src/node/3d-engine/scan-fit-service';
import { validateContract } from '../src/common/spatial/staged-location-contracts';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { encodePng as encodeGrey } from '../src/node/3d-engine/staged-location/png-encode';
import { parseOutlineReply, rasterizeOutlines, readOwnershipViewList } from '../src/node/3d-engine/staged-location/ownership-masks';
import { type Chunk, quad, flat, writeGlb, encodePng, buildTileRefine } from './helpers/synthetic-scan-glb';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const WORK = path.join(REPO, 'test-results/mask-voting');
const SHOTS = path.join(REPO, 'test-results/screenshots/mask_voting');
const BIN = path.join(WORK, 'tile_refine');
const ANCHOR = '-4,0';
const SPLIT_X = 2;  // the tower is x <= 2, the neighbour x > 2
const RAISED_Y = 2.5;  // above tile_refine's open-ground tolerance: what the vote decides (ground-level triangles keep the geometric rules)

const solid = (rgb: [number, number, number]) => encodePng(4, 4, new Uint8Array(Array.from({ length: 16 }, () => rgb).flat()));
const tex = (c: Chunk, image: number): Chunk => ({ ...c, image, uvs: Array.from({ length: c.positions.length / 3 }, () => [0.5, 0.5]).flat() });

/** Walls (facing out) of an axis-aligned box from y0 to y1; `skip` leaves out the wall on that side. */
function box(x0: number, x1: number, z0: number, z1: number, y1: number, image: number, skip?: '-x'): Chunk[] {
    const h = y1, n = 6;
    const walls: Array<[string, Chunk]> = [
        ['+x', quad([x1, 0, z0], [0, 0, z1 - z0], [0, h, 0], n, n)], ['-x', quad([x0, 0, z1], [0, 0, z0 - z1], [0, h, 0], n, n)],
        ['+z', quad([x1, 0, z1], [x0 - x1, 0, 0], [0, h, 0], n, n)], ['-z', quad([x0, 0, z0], [x1 - x0, 0, 0], [0, h, 0], n, n)]
    ];
    return [...walls.filter(([s]) => s !== skip).map(([, c]) => tex(c, image)), tex(flat(x0, x1, z0, z1, y1, n), image)];
}

function tileRefine(args: string[]): void {
    execFileSync(BIN, ['--input', path.join(WORK, 'scene.glb'), '--isolate', '--anchor', ANCHOR, '--threads', '4', ...args], { stdio: 'pipe', timeout: 300_000 });
}

/** Raised triangles (centroid above RAISED_Y) of a GLB by side of the split: [tower, neighbour]. */
function raisedBySide(glb: string): [number, number] {
    const m = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glb);
    let a = 0, b = 0;
    for (let t = 0; t < m.indices.length; t += 3) {
        let cx = 0, cy = 0;
        for (let k = 0; k < 3; k++) { cx += m.vertices[3 * m.indices[t + k]]; cy += m.vertices[3 * m.indices[t + k] + 1]; }
        if (cy / 3 < RAISED_Y) continue;
        if (cx / 3 < SPLIT_X + 0.01) a++; else b++;  // the shared wall at x = 2 is the tower's
    }
    return [a, b];
}

describe('tile_refine: object ownership by multi-view mask voting', () => {
    let stats: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    let towerRaised = 0, neighbourRaised = 0;

    beforeAll(() => {
        fs.rmSync(WORK, { recursive: true, force: true });
        fs.mkdirSync(WORK, { recursive: true });
        fs.mkdirSync(SHOTS, { recursive: true });
        buildTileRefine(REPO, BIN);
        const ground = flat(-60, 60, -60, 60, 0, 60);
        const tower = box(-10, SPLIT_X, -6, 6, 24, 0);
        const neighbour = box(SPLIT_X, 12, -5, 5, 14, 1, '-x');  // built against the tower's east wall
        writeGlb(path.join(WORK, 'scene.glb'), [ground, ...tower, ...neighbour], [solid([200, 40, 40]), solid([40, 70, 200])]);
        const raised = (cs: Chunk[]) => cs.reduce((n, c) => {
            for (let t = 0; t < c.indices.length; t += 3) n += (c.positions[3 * c.indices[t] + 1] + c.positions[3 * c.indices[t + 1] + 1] + c.positions[3 * c.indices[t + 2] + 1]) / 3 >= RAISED_Y ? 1 : 0;
            return n;
        }, 0);
        towerRaised = raised(tower);
        neighbourRaised = raised(neighbour);

        // the views, then masks read from their pixels only (red = the tower), imperfect on purpose
        tileRefine(['--ownership-render', path.join(WORK, 'views'), '--ownership-size', '512x384']);
        const views = readOwnershipViewList(path.join(WORK, 'views'));
        fs.mkdirSync(path.join(WORK, 'masks'), { recursive: true });
        fs.copyFileSync(path.join(WORK, 'views', 'views.txt'), path.join(WORK, 'masks', 'views.txt'));
        views.forEach((v, vi) => {
            const img = decodeImageInMemory(fs.readFileSync(path.join(WORK, 'views', `${v.name}.png`)));
            const red = new Uint8Array(v.width * v.height);
            for (let i = 0; i < red.length; i++) red[i] = img.rgba[4 * i] > 120 && img.rgba[4 * i + 1] < 90 && img.rgba[4 * i + 2] < 90 ? 1 : 0;
            const mask = new Uint8Array(red.length);
            for (let y = 0; y < v.height; y++)
                for (let x = 0; x < v.width; x++) {
                    let on = 0;
                    for (let dy = -3; dy <= 3 && !on; dy++) for (let dx = -3; dx <= 3 && !on; dx++) {
                        const yy = y + dy, xx = x + dx;
                        if (yy >= 0 && yy < v.height && xx >= 0 && xx < v.width && red[yy * v.width + xx]) on = 1;
                    }
                    mask[y * v.width + x] = on ? 255 : 0;
                }
            if (vi === 1) for (let y = 150; y < 230; y++) for (let x = 250; x < 330; x++) mask[y * v.width + x] = 255 - mask[y * v.width + x];
            fs.writeFileSync(path.join(WORK, 'masks', `${v.name}.mask.png`), encodeGrey(v.width, v.height, mask, 1));
        });
        const out = (n: string) => ['--out-textured', path.join(WORK, `${n}_textured.glb`), '--out-clay', path.join(WORK, `${n}_clay.glb`), '--out-raw-clay', path.join(WORK, `${n}_raw.glb`), '--stats', path.join(WORK, `${n}_stats.json`), '--no-relief'];
        tileRefine(out('geometry'));
        tileRefine([...out('vote'), '--ownership-masks', path.join(WORK, 'masks'), '--ownership-out', path.join(WORK, 'vote.sbov'), '--ownership-debug', path.join(WORK, 'debug'), '--ownership-holdout', '3']);
        stats = JSON.parse(fs.readFileSync(path.join(WORK, 'vote_stats.json'), 'utf8'));
        for (const f of fs.readdirSync(path.join(WORK, 'debug'))) fs.copyFileSync(path.join(WORK, 'debug', f), path.join(SHOTS, `synthetic_${f}`));
    }, 900_000);

    it('the geometric isolate alone keeps the touching neighbour (the problem the vote solves)', () => {
        const [tower, neighbour] = raisedBySide(path.join(WORK, 'geometry_raw.glb'));
        expect(tower).toBe(towerRaised);
        expect(neighbour).toBe(neighbourRaised);
    });

    it('the vote splits them: the neighbour leaves, the tower stays whole', () => {
        const [tower, neighbour] = raisedBySide(path.join(WORK, 'vote_raw.glb'));
        const [towerGeom] = raisedBySide(path.join(WORK, 'geometry_raw.glb'));
        const o = stats.isolate.ownership;
        expect(o.votingViews).toBe(8);  // 12 views, every 3rd held out to score
        expect(o.left + o.leftAsOrphans).toBeGreaterThan(0.8 * neighbourRaised);
        expect(neighbour).toBe(0);         // ownership accuracy on the known owners: every raised neighbour triangle left
        expect(tower).toBe(towerGeom);     // and every raised tower triangle stayed
        expect(tower).toBe(towerRaised);
        expect(o.clusters[0].change).toBe('left');
        expect(o.clusters[0].centroid[0]).toBeGreaterThan(SPLIT_X);       // where: east of the split
    });

    it('beats the geometric decision on held-out views', () => {
        const h = stats.isolate.ownership.holdout;
        expect(h.views).toBeGreaterThan(0);
        expect(h.voteAccuracy).toBeGreaterThan(0.97);
        expect(h.voteAccuracy).toBeGreaterThan(h.geometryAccuracy + 0.1);
    });

    it('feeds scan_fit: scan voted not the structure is left out of the fit as clutter', async () => {
        const svc = new ScanFitService({ workspaceRoot: WORK, repoRoot: REPO });
        const limits = { leafGeometricErrorM: 2.0, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.155, photoResolvableM: 0.31 };
        const plain = (await svc.fit({ scanGlb: 'geometry_raw.glb', anchor: { x: -4, z: 0 }, sourceLimits: limits })).value;
        const voted = (await svc.fit({ scanGlb: 'geometry_raw.glb', ownershipVotes: 'vote.sbov', anchor: { x: -4, z: 0 }, sourceLimits: limits })).value;
        expect(validateContract('StructureFit', voted)).toEqual([]);
        expect(plain.input.ownership).toBeUndefined();
        const o = voted.input.ownership!;
        expect(o.otherTriangles).toBeGreaterThan(0);
        expect(o.otherAreaM2).toBeGreaterThan(50);  // the neighbour's visible walls and roof, out of the fit
        // the fit then measures only the tower: its surfaces cover less scan, and nothing it leaves is the neighbour
        expect(voted.passThrough.areaM2).toBeLessThanOrEqual(plain.passThrough.areaM2 + 1e-6);
    }, 600_000);

    it('outline replies fill into masks with their holes', () => {
        const r = parseOutlineReply('```json\n{"visible": true, "polygons": [{"outer": [[0,0],[0,1000],[1000,1000],[1000,0]], "holes": [[[250,250],[250,750],[750,750],[750,250]]]}]}\n```');
        const m = rasterizeOutlines(r.polygons, 100, 100);
        expect(m[5 * 100 + 5]).toBe(255);
        expect(m[50 * 100 + 50]).toBe(0);
        expect(m.reduce((s, v) => s + (v ? 1 : 0), 0)).toBe(10000 - 2500);
        expect(parseOutlineReply('{"visible": false, "polygons": []}').visible).toBe(false);
    });
});
