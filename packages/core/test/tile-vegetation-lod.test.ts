/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Trees written at four levels on one skeleton (scratchbox_tree_lod.hpp, written by writeTreesGlb), compiled with clang++
 * and run through TileVegetationService on synthetic crowns:
 *
 * - the file passes the contract (validateTreesGlbJson): four levels per tree (near, near-mid, mid, far), instanced leaf
 *   clusters under the first three, the cluster library named in the root extras, no species and no "measured" claim on a leaf;
 * - leaves have real sizes (7-14 cm blades, scaled from the tree's height), the near-mid level draws about a third of the
 *   near level's leaf triangles and the mid level about an eighth, and the delivered leaves of every level are measured
 *   against the measured crown;
 * - the far level holds its own wood, the trunk and main limbs within a few hundred triangles (trees-lod/3), counted in
 *   its triangles;
 * - every crown carries its lobes (a smooth union of spheres) around its leaves, and the levels' bands follow each other
 *   with no gap, each handover centred where lodBandsFor puts it;
 * - a tree is the same bytes at any thread count;
 * - psiSeason scales leaf density, down to the wood alone;
 * - no two trunks fork at the same relative height.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';
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

describe('trees at four levels', () => {
    it('writes a file that passes the contract, with leaves of real size and honest labels', async () => {
        const planted = await svc.plant({ crownsPath: writeCrowns('four.json', CROWNS), triangleBudget: 16000, seed: 'abc' });
        const { json } = parseGlb(fs.readFileSync(planted.treesGlb));
        expect(validateTreesGlbJson(json)).toEqual([]);
        expect(json.extras.sbTrees.schema).toBe('scratchbox.trees-lod/3');
        const trees = json.nodes.filter((n: any) => n.extras?.sbTree !== undefined);
        expect(trees).toHaveLength(4);
        // no measured claim on anything a leaf is: the trees stay "grown to the measured crown"; a species entry is a library
        // choice by the crown's measurements, never a measurement of the tree
        for (const t of trees) {
            expect(['library', 'unmatched']).toContain(t.extras.sbTree.species.provenance);
            expect(t.extras.sbTree.species.measured.provenance).toBe('measured');
            expect(t.extras.sb.provenance.label).toBe('grown to the measured crown');
            expect(t.extras.sbTree.label).toBe('grown to the measured crown');
            for (const k of t.children) {
                const level = json.nodes[k];
                expect(JSON.stringify(level.extras)).not.toMatch(/measured/i);
                for (const c of level.children ?? []) expect(JSON.stringify(json.nodes[c].extras)).not.toMatch(/measured/i);
            }
        }
        // each tree carries the crown ellipsoid of its delivered leaves (in the tree node's frame = the tile frame), around
        // its measured crown: centred over the stem (these crowns are round and upright), as wide as the crown, inside its height
        for (const t of trees) {
            const c = CROWNS.find(k => k.id === t.extras.sbTree.id)!;
            const crown = t.extras.sbTree.crown;
            expect(crown, `tree ${c.id} has a crown`).toBeTruthy();
            expect(crown.fittedTo).toBe('leaf clusters');
            expect(crown.points).toBeGreaterThan(100);
            expect(Math.hypot(crown.centre[0] - c.stem[0], crown.centre[2] - c.stem[1])).toBeLessThan(1.0);
            expect(Math.hypot(crown.leanM[0], crown.leanM[1])).toBeLessThan(1.0);
            const radius = c.sectorRadii[0];
            for (const r of [crown.radii[0], crown.radii[2]]) { expect(r).toBeGreaterThan(0.7 * radius); expect(r).toBeLessThan(1.3 * radius); }
            expect(crown.centre[1] + crown.radii[1]).toBeLessThan(c.apex[1] + 1.0);
            expect(crown.centre[1] - crown.radii[1]).toBeGreaterThan(c.supportY);
            // the lobes: within the crown's extent, their union reaching about as wide as the crown
            expect(crown.lobes.length).toBeGreaterThanOrEqual(1);
            expect(crown.lobes.length).toBeLessThanOrEqual(8);
            expect(crown.lobeBlendM).toBeGreaterThan(0);
            for (const l of crown.lobes) {
                expect(l[3]).toBeGreaterThan(0.25);
                expect(Math.hypot(l[0] - c.stem[0], l[2] - c.stem[1])).toBeLessThan(radius);
                expect(l[1]).toBeLessThan(c.apex[1]); expect(l[1]).toBeGreaterThan(c.supportY);
            }
            const reach = Math.max(...crown.lobes.map((l: number[]) => Math.hypot(l[0] - c.stem[0], l[2] - c.stem[1]) + l[3]));
            expect(reach).toBeGreaterThan(0.7 * radius); expect(reach).toBeLessThan(1.4 * radius);
            const levels = t.children.map((k: number) => json.nodes[k]).sort((a: any, b: any) => a.extras.sbLod.level - b.extras.sbLod.level);
            expect(levels.map((n: any) => n.extras.sbLod.level)).toEqual([0, 1, 2, 3]);
            expect(levels.map((n: any) => n.extras.sbLod.instanced)).toEqual([true, true, true, false]);
            const l3 = levels[3];
            expect(l3.extras.sbLod.foliagePrimitives).toEqual([1]);
            expect(json.meshes[l3.mesh].primitives).toHaveLength(2);
            // the far level's own wood: the trunk and main limbs within a few hundred triangles (trees-lod/3), not the near
            // level's whole wood, rising from the ground into the crown and reaching out along its limbs
            const per = planted.stats.perTree.find((p: any) => p.crownId === c.id);
            const [farWoodPrim, blobPrim] = json.meshes[l3.mesh].primitives;
            const farWoodTris = json.accessors[farWoodPrim.indices].count / 3, blobTris = json.accessors[blobPrim.indices].count / 3;
            expect(farWoodTris).toBe(per.lod.farWoodTriangles);
            expect(farWoodTris).toBeGreaterThanOrEqual(100); expect(farWoodTris).toBeLessThanOrEqual(700);
            expect(farWoodTris).toBeLessThan(per.lod.woodTriangles);
            expect(farWoodPrim.attributes.POSITION).not.toBe(json.meshes[levels[0].mesh].primitives[0].attributes.POSITION);
            expect(l3.extras.sbLod.triangles).toBe(farWoodTris + blobTris);
            expect(per.lod.level2Triangles).toBe(farWoodTris + blobTris);
            expect(t.extras.farLevelTriangles).toBe(farWoodTris + blobTris);
            expect(t.extras.farWoodTriangles).toBe(farWoodTris);
            const wp = json.accessors[farWoodPrim.attributes.POSITION];
            expect(wp.max[1] - wp.min[1]).toBeGreaterThan(0.5 * (c.apex[1] - c.supportY));
            expect(Math.max(wp.max[0] - wp.min[0], wp.max[2] - wp.min[2])).toBeGreaterThan(0.5 * radius);
            // the near-mid and mid levels share the near level's wood mesh, and draw no twigs: leaf clusters at near-mid, crown cards at mid
            expect(levels[1].mesh).toBe(levels[0].mesh); expect(levels[2].mesh).toBe(levels[0].mesh);
            for (const ci of levels[1].children) expect(json.nodes[ci].extras.sbCluster.clusterMesh).toMatch(/leaf_cluster/);
            for (const ci of levels[2].children) expect(json.nodes[ci].extras.sbCluster.clusterMesh).toMatch(/leaf_cluster|crown_card/);
            // bands: each handover centred on lodBandsFor's distance, neighbours overlapping (no gap), handovers in order
            const H = t.extras.heightAboveSupportM as number;
            const b = levels.map((n: any) => n.extras.sbLod);
            // lodBandsFor's defaults (2026-10-21): near 1.15 H in [14, 35], near-mid 6.5 H in [30, 120], mid 9.0 H in [100, 190],
            // fades 7 m, 0.2 and 0.25 of their distance
            const fade = 7;
            const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
            const d0 = clamp(1.15 * H, 14, 35), nm = clamp(6.5 * H, 30, 120), far = clamp(9.0 * H, 100, 190);
            const fadeNM = Math.max(fade, 0.2 * nm), fade1 = Math.max(fade, 0.25 * far);
            const d1 = Math.max(d0 + 0.5 * fade + fadeNM + 0.5 * fade1, far), dNM = clamp(nm, d0 + 0.5 * (fade + fadeNM), d1 - 0.5 * (fadeNM + fade1));
            expect((b[0].maxDistM + b[1].minDistM) / 2).toBeCloseTo(d0, 2);
            expect((b[1].maxDistM + b[2].minDistM) / 2).toBeCloseTo(dNM, 2);
            expect((b[2].maxDistM + b[3].minDistM) / 2).toBeCloseTo(d1, 2);
            expect(b[1].maxDistM - b[2].minDistM).toBeCloseTo(fadeNM, 2);
            for (let k = 0; k < 3; k++) {
                expect(b[k + 1].minDistM).toBeLessThanOrEqual(b[k].maxDistM);           // no gap
                expect(b[k + 1].minDistM).toBeGreaterThan(b[k].minDistM);
                if (k < 2) expect(b[k].maxDistM).toBeLessThanOrEqual(b[k + 2].minDistM + 1e-6);   // handovers do not overlap each other
            }
            // triangles per level: near > near-mid > mid > far
            expect(b[0].triangles).toBeGreaterThan(b[1].triangles); expect(b[1].triangles).toBeGreaterThan(b[2].triangles); expect(b[2].triangles).toBeGreaterThan(b[3].triangles);
        }
        // blade length follows the tree's height within the real range of leaf sizes; with a leaf texture chosen (the
        // default) the cards take that set's own leaf length instead, within [minM, atlasMaxM]
        const model = json.extras.sbTrees.clusterLibrary.leafSizeModel;
        expect(model.minM).toBeGreaterThanOrEqual(0.07);
        expect(model.maxM).toBeLessThanOrEqual(0.15);
        expect(model.atlasMaxM).toBeGreaterThanOrEqual(model.maxM);
        const index = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/textures/trees/index.json'), 'utf8')) as { leaves: Array<{ id: string; leaf: { lengthM: number } }> };
        const entryOf = new Map(trees.map((t: any) => [t.extras.sbTree.id, t.extras.sbTree.texture?.leaves?.entry as string | undefined]));
        const lens = planted.stats.perTree.map((t: any) => t.lod.leafLengthM as number);
        planted.stats.perTree.forEach((t: any, k: number) => {
            const entry = entryOf.get(t.crownId);
            if (entry) {
                const own = index.leaves.find(e => e.id === entry)!.leaf.lengthM;
                expect(lens[k]).toBeCloseTo(Math.min(model.atlasMaxM, Math.max(model.minM, own)), 6);
            } else {
                expect(lens[k]).toBeGreaterThanOrEqual(model.minM - 1e-9);
                expect(lens[k]).toBeLessThanOrEqual(model.maxM + 1e-9);
            }
        });
        // without textures, the taller tree's leaves are never smaller than a shorter one's
        if (!entryOf.get(planted.stats.perTree[3].crownId) && !entryOf.get(planted.stats.perTree[0].crownId)) expect(lens[3]).toBeGreaterThanOrEqual(lens[0]);
        // levels: the near-mid level draws about a third of the near level's triangles in its leaves, the mid level about an eighth
        for (const t of planted.stats.perTree) {
            const { level0, nearMid, level1 } = t.lod;
            expect(level0.leaves).toBeGreaterThan(50);
            expect(nearMid.leaves).toBeGreaterThan(level1.leaves); expect(nearMid.leaves).toBeLessThan(level0.leaves);
            expect(nearMid.leafTriangles).toBeLessThan(level0.leafTriangles * 0.5);
            expect(nearMid.leafTriangles).toBeGreaterThan(level1.leafTriangles);
            expect(level1.leafTriangles).toBeLessThan(level0.leafTriangles * 0.2);
            expect(level1.leafTriangles).toBeGreaterThan(level0.leafTriangles * 0.05);
            expect(nearMid.drawnTriangles).toBeLessThan(level0.drawnTriangles);
            expect(level1.drawnTriangles).toBeLessThan(nearMid.drawnTriangles);
            expect(nearMid.within1mShare).toBeGreaterThanOrEqual(0.8);
            // measured on the delivered leaves of each level, and the leaves reach the apex
            expect(level0.within1mShare).toBeGreaterThanOrEqual(0.85);
            expect(level1.within1mShare).toBeGreaterThanOrEqual(0.8);
            expect(Math.abs(level0.leavesBelowApexM)).toBeLessThan(1.0);
            expect(level0.sectorsOver1p5).toBe(0);
        }
        // the frame estimate counts the near-mid level between the near and mid ones
        const f = planted.stats.lodFrames;
        expect(f.allNearMid).toBeLessThan(f.allLevel0); expect(f.allNearMid).toBeGreaterThan(f.allLevel1); expect(f.allLevel1).toBeGreaterThan(f.allLevel2);
        expect(f.worstTreesPerLevel).toHaveLength(4);
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

    it('gives the mid level level1AreaGain and the near-mid level nearMidAreaGain times the near level\'s leaf area in every shared cluster', () => {
        // the library is built by the header itself: compile a probe against it and read back the blade areas
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-lodarea-'));
        const src = path.join(dir, 'probe.cpp'), bin = path.join(dir, 'probe');
        fs.writeFileSync(src, `#include "scratchbox_tile_vegetation.hpp"
#include <cstdio>
int main(){ using namespace scratchbox; tree_lod::LodParams P; auto lib = tree_lod::buildClusterLibrary(P);
  std::printf("%.4f %.4f", P.level1AreaGain, P.nearMidAreaGain);
  for (auto& v : lib.variants) std::printf(" %.5f %.5f %.5f %d %d %d", v.level0.bladeArea, v.level1.bladeArea, v.nearMid.bladeArea, v.level0.leaves, v.nearMid.leaves, v.level1.leaves); }`);
        const r = spawnSync(process.env.CXX || 'clang++', ['-std=c++20', '-O1', '-I' + path.join(REPO, 'packages/core/src/native/3d-engine/include'), src, '-o', bin], { encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        const out = spawnSync(bin, [], { encoding: 'utf8' });
        expect(out.status).toBe(0);
        const [gain, nmGain, ...areas] = out.stdout.trim().split(' ').map(Number);
        expect(gain).toBeGreaterThan(1);
        expect(nmGain).toBeGreaterThan(0);
        expect(areas.length).toBeGreaterThanOrEqual(36);
        for (let k = 0; k < areas.length; k += 6) {
            expect(areas[k]).toBeGreaterThan(0.05);
            expect(areas[k + 1] / areas[k]).toBeGreaterThan(gain * 0.97);
            expect(areas[k + 1] / areas[k]).toBeLessThan(gain * 1.03);
            expect(areas[k + 2] / areas[k]).toBeGreaterThan(nmGain * 0.97);
            expect(areas[k + 2] / areas[k]).toBeLessThan(nmGain * 1.03);
            // leaf counts: near > near-mid > mid
            expect(areas[k + 3]).toBeGreaterThan(areas[k + 4]); expect(areas[k + 4]).toBeGreaterThan(areas[k + 5]);
        }
    }, 120_000);

describe('heroRoi: trees inside the hero area hold full quality at any distance', () => {
    it('gives a tree inside heroRoi a near band reaching heroFullQualityM, and leaves a tree outside it on the normal bands', async () => {
        // two identical trees, one inside a small hero square around the origin, one well outside it
        const inside = crown(10, [0, 0], 0, 14, 4.5);
        const outside = crown(11, [60, 60], 0, 14, 4.5);
        const heroRoi = { schema: 'scratchbox.strip-roi/1' as const, polygon: [[-10, -10], [10, -10], [10, 10], [-10, 10]] as Array<[number, number]> };
        const planted = await svc.plant({ crownsPath: writeCrowns('hero.json', [inside, outside]), triangleBudget: 16000, seed: 'aaaa1', heroRoi });
        const { json } = parseGlb(fs.readFileSync(planted.treesGlb));
        const trees = json.nodes.filter((n: any) => n.extras?.sbTree !== undefined);
        expect(trees).toHaveLength(2);
        const byId = (id: number) => trees.find((t: any) => t.extras.sbTree.id === id);
        const levelsOf = (t: any) => t.children.map((k: number) => json.nodes[k]).sort((a: any, b: any) => a.extras.sbLod.level - b.extras.sbLod.level);

        const heroLevels = levelsOf(byId(10));
        expect(heroLevels[0].extras.sbLod.maxDistM).toBeGreaterThan(2900);   // heroFullQualityM default 3000, not the ~35 m normal near band
        expect(byId(10).extras.lod.hero).toBe(true);

        const normalLevels = levelsOf(byId(11));
        expect(normalLevels[0].extras.sbLod.maxDistM).toBeLessThan(40);     // the ordinary near band (~35 m for a 14 m tall tree)
        expect(byId(11).extras.lod.hero).toBeUndefined();
    });

    it('an unset heroRoi changes nothing: both trees keep the normal bands', async () => {
        const a = crown(20, [0, 0], 0, 14, 4.5), b = crown(21, [60, 60], 0, 14, 4.5);
        const planted = await svc.plant({ crownsPath: writeCrowns('nohero.json', [a, b]), triangleBudget: 16000, seed: 'aaaa0' });
        const { json } = parseGlb(fs.readFileSync(planted.treesGlb));
        const trees = json.nodes.filter((n: any) => n.extras?.sbTree !== undefined);
        for (const t of trees) {
            const l0 = t.children.map((k: number) => json.nodes[k]).find((n: any) => n.extras.sbLod.level === 0);
            expect(l0.extras.sbLod.maxDistM).toBeLessThan(40);
            expect(t.extras.lod.hero).toBeUndefined();
        }
    });
});

