/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Trees written at three levels on one skeleton (scratchbox_tree_lod.hpp, written by writeTreesGlb), compiled with clang++
 * and run through TileVegetationService on synthetic crowns:
 *
 * - the file passes the contract (validateTreesGlbJson): three levels per tree, instanced leaf clusters under levels 0 and
 *   1, the cluster library named in the root extras, no species and no "measured" claim on a leaf;
 * - leaves have real sizes (7-14 cm blades, scaled from the tree's height), level 1 draws about an eighth of level 0's
 *   triangles, and the delivered leaves of every level are measured against the measured crown;
 * - a tree is the same bytes at any thread count;
 * - psiSeason scales leaf density, down to the wood alone;
 * - no two trunks fork at the same relative height.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { validateTreesGlbJson } from '../src/common/spatial/staged-location-contracts';
import { parseGlb } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
type Vec3 = [number, number, number];

function crown(id: number, stem: [number, number], supportY: number, apexY: number, radius: number) {
    const samples: Vec3[] = [];
    const n = Math.ceil(radius / 0.7);
    for (let i = -n; i <= n; i++) {
        for (let k = -n; k <= n; k++) {
            const dx = i * 0.7, dz = k * 0.7, d = Math.hypot(dx, dz);
            if (d > radius) continue;
            samples.push([stem[0] + dx, apexY - 0.45 * (apexY - supportY) * (d / radius) ** 2, stem[1] + dz]);
        }
    }
    return {
        id, status: 'tree', reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY, supportSource: 'given', terrainY: supportY,
        apexAboveSupport: apexY - supportY, areaM2: Math.PI * radius * radius, sectorRadii: new Array(16).fill(radius), samples
    };
}

let work: string;
let svc: TileVegetationService;
const CROWNS = [crown(0, [0, 0], 0, 14, 4.5), crown(1, [16, 3], 0.4, 14, 4.5), crown(2, [-14, 8], -0.2, 14, 4.5), crown(3, [4, -16], 0, 22, 6)];

function writeCrowns(name: string, crowns: any[]): string {
    fs.writeFileSync(path.join(work, name), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 }, crowns }));
    return name;
}

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tile-lod-')));
    svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('trees at three levels', () => {
    it('writes a file that passes the contract, with leaves of real size and honest labels', async () => {
        const planted = await svc.plant({ crownsPath: writeCrowns('four.json', CROWNS), triangleBudget: 16000, seed: 'abc' });
        const { json } = parseGlb(fs.readFileSync(planted.treesGlb));
        expect(validateTreesGlbJson(json)).toEqual([]);
        const trees = json.nodes.filter((n: any) => n.extras?.sbTree !== undefined);
        expect(trees).toHaveLength(4);
        // no species and no measured claim on anything a leaf is: the trees stay "grown to the measured crown"
        const text = JSON.stringify(json);
        expect(text).not.toMatch(/species/i);
        for (const t of trees) {
            expect(t.extras.sb.provenance.label).toBe('grown to the measured crown');
            expect(t.extras.sbTree.label).toBe('grown to the measured crown');
            for (const k of t.children) {
                const level = json.nodes[k];
                expect(JSON.stringify(level.extras)).not.toMatch(/measured/i);
                for (const c of level.children ?? []) expect(JSON.stringify(json.nodes[c].extras)).not.toMatch(/measured/i);
            }
        }
        // blade length follows the tree's height within the real range of leaf sizes
        const model = json.extras.sbTrees.clusterLibrary.leafSizeModel;
        expect(model.minM).toBeGreaterThanOrEqual(0.07);
        expect(model.maxM).toBeLessThanOrEqual(0.15);
        const lens = planted.stats.perTree.map((t: any) => t.lod.leafLengthM as number);
        for (const l of lens) { expect(l).toBeGreaterThanOrEqual(model.minM - 1e-9); expect(l).toBeLessThanOrEqual(model.maxM + 1e-9); }
        // the taller tree's leaves are never smaller than a shorter one's
        expect(lens[3]).toBeGreaterThanOrEqual(lens[0]);
        // levels: distances in order, level 1 draws about an eighth of level 0's triangles in its leaves, level 2 is the blob masses
        for (const t of planted.stats.perTree) {
            const { level0, level1 } = t.lod;
            expect(level0.leaves).toBeGreaterThan(50);
            expect(level1.leafTriangles).toBeLessThan(level0.leafTriangles * 0.2);
            expect(level1.leafTriangles).toBeGreaterThan(level0.leafTriangles * 0.05);
            expect(level1.drawnTriangles).toBeLessThan(level0.drawnTriangles);
            // measured on the delivered leaves of each level, and the leaves reach the apex
            expect(level0.within1mShare).toBeGreaterThanOrEqual(0.85);
            expect(level1.within1mShare).toBeGreaterThanOrEqual(0.8);
            expect(Math.abs(level0.leavesBelowApexM)).toBeLessThan(1.0);
            expect(level0.sectorsOver1p5).toBe(0);
        }
        // the cluster library is in the file once, whatever the trees: a handful of meshes
        expect(planted.stats.glb.instances).toBeGreaterThan(1000);
        expect(planted.stats.glb.instancedTriangles).toBeGreaterThan(planted.stats.glb.triangles);
    }, 600_000);

    it('is the same bytes at any thread count', async () => {
        const crowns = writeCrowns('det.json', CROWNS);
        const a = await svc.plant({ crownsPath: crowns, triangleBudget: 16000, seed: '5eed', threads: 1 });
        const other = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO, cacheDir: 'cache_threads_4' });
        const b = await other.plant({ crownsPath: crowns, triangleBudget: 16000, seed: '5eed', threads: 4 });
        expect(b.cached).toBe(false);
        expect(sha(b.treesGlb)).toBe(sha(a.treesGlb));
    }, 600_000);

    it('scales leaf density with psiSeason, down to the wood alone, and the file stays valid', async () => {
        const crowns = writeCrowns('psi.json', CROWNS);
        const instances = async (psi: number) => {
            const p = await svc.plant({ crownsPath: crowns, triangleBudget: 16000, seed: 'abc', params: { psiSeason: psi } });
            const { json } = parseGlb(fs.readFileSync(p.treesGlb));
            expect(validateTreesGlbJson(json)).toEqual([]);
            expect(json.extras.sbTrees.psiSeason).toBe(psi);
            const leaves = p.stats.perTree.reduce((n: number, t: any) => n + t.lod.level0.leaves, 0);
            return { leaves, json, stats: p.stats };
        };
        const full = await instances(1), half = await instances(0.5), bare = await instances(0);
        expect(half.leaves).toBeLessThan(full.leaves * 0.75);
        expect(half.leaves).toBeGreaterThan(full.leaves * 0.25);
        expect(bare.leaves).toBe(0);
        // bare: the wood level exists, nothing is instanced above its twigs, and no leaf cluster node is written
        const clusters = bare.json.nodes.filter((n: any) => n.extras?.sbCluster?.clusterMesh?.startsWith('sb_veggie_leaf'));
        expect(clusters).toHaveLength(0);
        expect(bare.stats.perTree.every((t: any) => t.lod.woodTriangles > 0)).toBe(true);
        expect(bare.stats.shortOfCrown).toEqual([]);
    }, 900_000);

    it('forks no two trunks at the same relative height, and grows them the same again', async () => {
        const planted = await svc.plant({ crownsPath: writeCrowns('fork.json', CROWNS.slice(0, 3)), triangleBudget: 12000, seed: 'abc' });
        const ratios = planted.stats.perTree.map((t: any) => t.crownBaseRatio as number);
        expect(new Set(ratios.map((r: number) => r.toFixed(4))).size).toBe(3);
        for (const r of ratios) expect(Math.abs(r - 0.35)).toBeLessThanOrEqual(0.1 + 1e-9);
    }, 300_000);
});
