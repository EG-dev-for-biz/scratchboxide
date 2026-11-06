/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree species library, end to end (tile_vegetation plant compiled with clang++): the index is sane; a crown is matched
 * by its measurements alone (a tall narrow crown with a bare trunk and a rounded head grows as a palm, a steep cone as a
 * spruce, a low mound as a multi-stem shrub, a broad dome as a broadleaf), the proportions it grows with are the entry's,
 * the leaf set is chosen by the entry's leaf, and every choice is in the extras with its measurements.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { validateTreesGlbJson, type TreeNodeExtras } from '../src/common/spatial/staged-location-contracts';
import { treeSpeciesPlaceParams, validateTreeSpeciesIndex, type TreeSpeciesIndex } from '../src/common/spatial/tree-species-library';
import type { TreeTextureIndex } from '../src/common/spatial/tree-texture-library';
import { parseGlb } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const INDEX = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/vegetation/species/index.json'), 'utf8')) as TreeSpeciesIndex;
const TEXTURES = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/textures/trees/index.json'), 'utf8')) as TreeTextureIndex;
const entry = (id: string) => INDEX.entries.find(e => e.id === id)!;
// what the tests read of a chosen entry: its own continuous fields, never its name (the library grows)
const palmLike = (id: string | null | undefined) => !!id && entry(id).crownBaseRatio >= 0.75 && entry(id).leafLengthM >= 1;

type Vec3 = [number, number, number];

/** A crown's surface over a disc of radius R: `depth(d / R)` metres below the apex at distance d from the stem. */
function crown(id: number, stem: [number, number], apexY: number, radius: number, depth: (t: number) => number, colour: Vec3) {
    const samples: Vec3[] = [];
    const n = Math.ceil(radius / 0.5);
    for (let i = -n; i <= n; i++) for (let k = -n; k <= n; k++) {
        const dx = i * 0.5, dz = k * 0.5, d = Math.hypot(dx, dz);
        if (d <= radius) samples.push([stem[0] + dx, apexY - depth(Math.min(1, d / radius)), stem[1] + dz]);
    }
    return {
        id, status: 'tree', reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY: 0, supportSource: 'given', terrainY: 0,
        apexAboveSupport: apexY, areaM2: Math.PI * radius * radius, sectorRadii: new Array(16).fill(radius), samples,
        colour: { meanLinearRgb: colour, spreadLinearRgb: [0.01, 0.01, 0.01], samples: 40, cells: 50, greenShare: 0.9, hueDeg: 100, chroma: 0.6 }
    };
}
const dome = (R: number) => (t: number) => R * (1 - Math.sqrt(1 - t * t));
const GREEN: Vec3 = [0.045, 0.075, 0.025], PALM: Vec3 = [0.07, 0.095, 0.03], DARK: Vec3 = [0.02, 0.045, 0.028];
// a palm: 15 m, a 3.5 m head, rounded; a spruce: 18 m, a 3 m radius cone 11 m deep (the lower branches hidden in the scan); a shrub: a 2 m mound 1.8 m wide;
// a broadleaf: 14 m, a 6 m dome
const CROWNS = [
    crown(0, [0, 0], 15, 3.5, dome(3.5 * 0.8), PALM),
    crown(1, [30, 0], 18, 3, t => t * 11, DARK),
    crown(2, [0, 30], 2, 1.8, dome(1.8), GREEN),
    crown(3, [30, 30], 14, 6, dome(6), GREEN)
];

let work: string;
let svc: TileVegetationService;
let json: any;

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-species-')));
    svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
    fs.writeFileSync(path.join(work, 'crowns.json'), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.5 }, crowns: CROWNS }));
    const planted = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 60000, seed: 'abc' });
    ({ json } = parseGlb(fs.readFileSync(planted.treesGlb)));
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

const treesOf = (): Map<number, TreeNodeExtras> => new Map(json.nodes.filter((n: any) => n.extras?.sbTree).map((n: any) => [n.extras.sbTree.id, n.extras.sbTree as TreeNodeExtras]));
const sbOf = (id: number): any => json.nodes.find((n: any) => n.extras?.sbTree?.id === id).extras.sb;

describe('tree species library: index', () => {
    it('is sane: unique ids, every quantity in its physical range, palms with high crown bases, conifers with low top shares', () => {
        expect(validateTreeSpeciesIndex(INDEX)).toEqual([]);
        expect(INDEX.entries.length).toBeGreaterThanOrEqual(15);
        for (const id of ['date_palm', 'fan_palm']) expect(entry(id).crownBaseRatio).toBeGreaterThanOrEqual(0.75);
        expect(entry('spruce').topShare).toBeLessThan(0.2);
        for (const id of ['hedge', 'shrub']) expect(entry(id).stems).toBeGreaterThan(1);
        expect(validateTreeSpeciesIndex({ ...INDEX, entries: [...INDEX.entries, INDEX.entries[0]] })).toContain(`${INDEX.entries[0].id} is listed twice`);
        expect(validateTreeSpeciesIndex({ ...INDEX, entries: [{ ...INDEX.entries[0], id: 'x', crownBaseRatio: 2 }] })).toContain('x.crownBaseRatio must be a number in [0, 0.95]');
    });
});

describe('tree species chosen per crown (plant)', () => {
    it('passes the contract and names the library in the root extras', () => {
        expect(validateTreesGlbJson(json)).toEqual([]);
        expect(json.extras.sbTrees.species.index).toBe('assets/vegetation/species/index.json');
        expect(json.extras.sbTrees.species.schema).toBe('scratchbox.tree-species/1');
    });

    it('matches each crown by its measurements and grows it with the entry\'s proportions', () => {
        const trees = treesOf();
        expect(trees.size).toBe(4);
        for (const t of trees.values()) {
            expect(t.species).toBeDefined();
            expect(t.species!.measured.provenance).toBe('measured');
            expect(t.species!.measured.samples).toBeGreaterThan(20);
        }
        // the tall narrow crown with a rounded head: a palm, its crown base high on a bare trunk, fronds for leaves
        const palm = trees.get(0)!;
        expect(palmLike(palm.species!.entry), String(palm.species!.entry)).toBe(true);
        expect(palm.species!.measured.aspect).toBeCloseTo(3.5 / 15, 1);
        expect(palm.species!.grownWith.crownBaseRatio).toBeGreaterThanOrEqual(0.65);
        expect(palm.species!.grownWith.trunkRadiusPerHeight).toBe(entry(palm.species!.entry!).trunkRadiusPerHeight);
        // its fronds (1.5-3.5 m) are beyond every leaf set in the texture library, so the leaf set is still chosen by colour and
        // the tree's size, not by the longest leaves whatever they look like (a frond library entry would change this)
        expect(palm.texture!.leaves.targetLeafLengthM).toBeLessThan(0.6);
        // the steep cone: a spruce, foliage nearly to the ground
        const spruce = trees.get(1)!;
        expect(entry(spruce.species!.entry!).topShare).toBeLessThan(0.2);
        expect(entry(spruce.species!.entry!).leafAspect).toBeLessThanOrEqual(0.2);
        expect(spruce.species!.measured.topShare).toBeLessThan(0.1);
        expect(spruce.species!.grownWith.crownBaseRatio).toBeLessThan(0.25);
        // the low mound: a shrub, several stems from the ground
        const shrub = trees.get(2)!;
        expect(shrub.species!.entry).toBe('shrub');
        expect(shrub.species!.grownWith.stems).toBeGreaterThan(1);
        expect(shrub.species!.grownWith.crownBaseRatio).toBeLessThan(0.2);
        // the broad dome: a broadleaf with one trunk and a crown base between a quarter and half way up
        const broad = trees.get(3)!;
        const broadEntry = entry(broad.species!.entry!);
        expect(broadEntry.stems).toBe(1);
        expect(broadEntry.topShare).toBeGreaterThan(0.4);
        expect(broadEntry.crownRadiusPerHeight).toBeGreaterThan(0.3);
        expect(broadEntry.crownRadiusPerHeight).toBeLessThan(0.65);
        expect(broadEntry.leafAspect).toBeGreaterThan(0.25);
        expect(broad.species!.measured.topShare).toBeGreaterThan(0.4);
        expect(broad.species!.grownWith.stems).toBe(1);
        expect(broad.species!.grownWith.crownBaseRatio).toBeGreaterThan(0.15);
        expect(broad.species!.grownWith.crownBaseRatio).toBeLessThan(0.5);
        // a leaf the library has leaves near (within 1.5 x of its shortest and longest) is what its leaf set is chosen by;
        // a finer leaf than the library carries (honey locust's 3 cm leaflets) leaves the choice to the tree's size
        const leafLengths = TEXTURES.leaves.map(e => e.leaf.lengthM);
        const want = entry(broad.species!.entry!).leafLengthM;
        const near = want >= Math.min(...leafLengths) / 1.5 && want <= Math.max(...leafLengths) * 1.5;
        if (near) expect(broad.texture!.leaves.targetLeafLengthM).toBe(want);
        else expect(broad.texture!.leaves.targetLeafLengthM).not.toBe(want);
        // the inferred proportions in the provenance are the ones each tree grew with, not one ratio for all
        expect(sbOf(0).provenance.inferred.trunkRadiusPerHeight).toBe(palm.species!.grownWith.trunkRadiusPerHeight);
        expect(sbOf(1).provenance.inferred.trunkRadiusPerHeight).toBe(entry(spruce.species!.entry!).trunkRadiusPerHeight);
        expect(sbOf(0).provenance.inferred.trunkRadiusPerHeight).not.toBe(sbOf(1).provenance.inferred.trunkRadiusPerHeight);
    });

    it('grows the trees to their measured crowns: the palm\'s wood is bare for most of its height, the shrub\'s is not', () => {
        const extras = (id: number) => json.nodes.find((n: any) => n.extras?.sbTree?.id === id).extras;
        expect(extras(0).inferred.crownBaseY).toBeGreaterThan(9);
        expect(extras(2).inferred.crownBaseY).toBeLessThan(0.5);
        for (const id of [0, 1, 2, 3]) expect(extras(id).crownSurfaceReached, `crown ${id}`).toBeGreaterThan(0.8);
    });

    it('a build\'s own latitude alone keeps a shape-alike palm from matching well past where palms grow (user report, 2026-10-21)', async () => {
        // the same tall-narrow-crown-bare-trunk-rounded-head measurements that matched a palm above (entry 0, the
        // "palm" fixture) - only this time the build gives its unsigned latitude and nothing else. Latitude alone
        // cannot tell New York from Barcelona, where fan palms line the streets (the signed place below can: the
        // climate, not the latitude, keeps palms out of New York), so this is London's and Berlin's latitude.
        const nyc = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 60000, seed: 'abc', params: { latAbsDeg: 52 } });
        const { json: nycJson } = parseGlb(fs.readFileSync(nyc.treesGlb));
        const palmAtNyc = nycJson.nodes.find((n: any) => n.extras?.sbTree?.id === 0)!.extras.sbTree as TreeNodeExtras;
        expect(palmAtNyc.species).toBeDefined();
        expect(palmLike(palmAtNyc.species!.entry), String(palmAtNyc.species!.entry)).toBe(false);
        // the measurements themselves are unchanged - only which species they are judged against
        expect(palmAtNyc.species!.measured.aspect).toBeCloseTo(3.5 / 15, 1);
    }, 900_000);

    it('the build\'s signed place weighs the pick by region: the palm-shaped crown is a palm in Seville, not in New York (user decision, 2026-11-05)', async () => {
        const at = async (place: { lat: number; lng: number }) => {
            const r = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 60000, seed: 'abc', params: treeSpeciesPlaceParams(place) });
            const { json: j } = parseGlb(fs.readFileSync(r.treesGlb));
            return new Map<number, TreeNodeExtras>(j.nodes.filter((n: any) => n.extras?.sbTree).map((n: any) => [n.extras.sbTree.id, n.extras.sbTree as TreeNodeExtras]));
        };
        const seville = await at({ lat: 37.39, lng: -5.99 }), newYork = await at({ lat: 40.7359, lng: -73.9911 });
        expect(palmLike(seville.get(0)!.species!.entry), String(seville.get(0)!.species!.entry)).toBe(true);
        expect(palmLike(newYork.get(0)!.species!.entry), String(newYork.get(0)!.species!.entry)).toBe(false);
        // the broad dome is a broadleaf in both, of a species common where the build is
        const regionAt = (lat: number, lng: number) => INDEX.regions!.find(g => lat >= g.latDeg[0] && lat <= g.latDeg[1] && lng >= g.lonDeg[0] && lng <= g.lonDeg[1])!.id;
        expect(entry(seville.get(3)!.species!.entry!).regionWeights![regionAt(37.39, -5.99)]).toBeGreaterThanOrEqual(0.5);
        expect(entry(newYork.get(3)!.species!.entry!).regionWeights![regionAt(40.7359, -73.9911)]).toBeGreaterThanOrEqual(0.5);
        // the measurements are the same in both; only what they are judged against moved
        expect(seville.get(0)!.species!.measured.aspect).toBe(newYork.get(0)!.species!.measured.aspect);
    }, 900_000);
});
