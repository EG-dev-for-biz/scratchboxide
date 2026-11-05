/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree grower's growth forms (nature::SpaceColonizationConfig, user ask 2026-11-05), each on a synthetic crown
 * through the real generator (scripts/tree_form_probe.cpp, compiled with clang++): tiers of laterals on a single leader
 * that shorten up a cone; a rosette of arching compound leaves on an unbranched stem; shoots that droop and tails that
 * hang; laterals held at an angle that changes with their order; the momentum release that ends the high-apical stall;
 * the trunk that climbs its own line to a crown that begins above it; an open crown. And that with none of them set
 * the generator grows the tree it grew before it had them, bit for bit. And through the whole grower (tile_vegetation
 * grow, its levels of detail): a rosette's fronds are drawn at the near, near-mid and mid levels, every form's levels get
 * lighter with distance, stems from the ground reach a crown that begins above them, and a rosette is fitted to an uneven
 * crown.
 *
 * Every parameter is a number; nothing here names a kind of tree to the grower. Nothing reaches a network.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateTreeSpeciesIndex, type TreeSpeciesEntry, type TreeSpeciesIndex } from '../src/common/spatial/tree-species-library';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { parseGlb, readAccessor } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const INCLUDE = path.join(REPO, 'packages/core/src/native/3d-engine/include');
const INDEX = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/vegetation/species/index.json'), 'utf8')) as TreeSpeciesIndex;

interface Node { parent: number; x: number; y: number; z: number; children: number; order: number; rosetteLeaf: number; tail: number }
interface Probe {
    crown: { heightM: number; radiusM: number; crownBaseY: number; stepM: number; attractors: number };
    colonisation: { stop: string; iterations: number; attractorsReached: number; trunkNodes: number; leaderNodes: number; trunkSeekSteps: number };
    skeletonHash: string;
    meshHash: string;
    mesh: { woodTriangles: number; foliageTriangles: number; foliagePieces: number; trianglesPerPiece: number; foliageLowestY: number | null };
    nodeCount: number;
    nodes: Node[];
    foliage: [number, number, number][];
}

let work: string;
let probeBin: string;
let matchBin: string;

function probe(flags: Record<string, number> = {}): Probe {
    const args = Object.entries(flags).flatMap(([k, v]) => [`--${k}`, String(v)]);
    const raw = JSON.parse(execFileSync(probeBin, [...args, '--nodes', '1', '--foliage', '1'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }));
    return {
        ...raw,
        nodes: (raw.nodes as number[][]).map(n => ({ parent: n[0], x: n[1], y: n[2], z: n[3], children: n[4], order: n[5], rosetteLeaf: n[6], tail: n[7] })),
        foliage: raw.foliageVertices
    };
}

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
const horizontal = (n: { x: number; z: number }) => Math.hypot(n.x, n.z);

beforeAll(() => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-growth-forms-')));
    probeBin = path.join(work, 'tree_form_probe');
    matchBin = path.join(work, 'tree_species_match');
    const cxx = process.env.CXX || 'clang++';
    execFileSync(cxx, ['-std=c++20', '-O2', '-w', '-I', INCLUDE, path.join(REPO, 'scripts/tree_form_probe.cpp'), '-lz', '-o', probeBin], { stdio: 'pipe' });
    execFileSync(cxx, ['-std=c++20', '-O2', '-w', '-I', INCLUDE, path.join(REPO, 'scripts/tree_species_match.cpp'), '-o', matchBin], { stdio: 'pipe' });
}, 600_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

// five default trees: a dome; an excurrent cone with a held leader; a wide flat crown on five limbs; a crown that
// begins above the trunk (the trunk seeks it); a small budget
const DEFAULT_CASES: Record<string, Record<string, number>> = {
    dome: {},
    cone: { 'top-exponent': 1, 'widest-at': 0, 'crown-base-ratio': 0.15, radius: 3, height: 20, apical: 0.62, 'leader-hold': 1, excurrence: 0.9, 'branch-angle': 1.3 },
    flat: { 'top-exponent': 5, radius: 9, height: 12, scaffold: 5, 'branch-angle': 1.1, apical: 0.3 },
    seeking: { 'crown-starts-at': 0.7, 'crown-base-ratio': 0.2, height: 18, radius: 6 },
    smallBudget: { budget: 1500, seed: 77 }
};

describe('defaults grow the trees the grower grew before', () => {
    it('every form parameter given at its default grows the same skeleton and mesh as not giving it', () => {
        const defaults = { 'momentum-release': 0, 'trunk-seek-along-stem': 0, 'whorl-branches': 0, 'whorl-spacing': 0, 'lateral-angle-hold': 0, 'lateral-angle-order-gain': 0, 'shoot-droop': 0, 'tail-share': 0, 'rosette-leaves': 0, 'crown-openness': 0 };
        for (const [name, flags] of Object.entries(DEFAULT_CASES)) {
            const plain = probe(flags), explicit = probe({ ...flags, ...defaults });
            expect(explicit.skeletonHash, name).toBe(plain.skeletonHash);
            expect(explicit.meshHash, name).toBe(plain.meshHash);
            // and none of the new marks is on any node
            expect(plain.nodes.every(n => n.rosetteLeaf === -1 && n.tail === -1), name).toBe(true);
        }
    });

    // The bits of the skeleton and the mesh as origin/main's generator (f4989130, before the forms) grew them, hashed by
    // the same probe built against that header on the machine this was written on. Floating point is only bit-stable
    // on one compiler and architecture, so the comparison runs there; elsewhere the test above stands.
    const onReferenceMachine = process.platform === 'darwin' && process.arch === 'arm64';
    it.skipIf(!onReferenceMachine)('bit for bit the trees of the generator before the forms (hashes recorded from origin/main f4989130, macOS arm64 clang -O2)', () => {
        const before: Record<string, [string, string, number]> = {
            dome: ['15216836178355884685', '9432385511221213800', 2123],
            cone: ['11763979373633531134', '5953357922317415117', 382],
            flat: ['2531690553516359638', '9138746870744666120', 9153],
            seeking: ['8240286177800905459', '10233317858951024211', 1398],
            smallBudget: ['8739920812312109527', '8215661794776716623', 2096]
        };
        for (const [name, flags] of Object.entries(DEFAULT_CASES)) {
            const now = probe(flags);
            expect([now.skeletonHash, now.meshHash, now.nodeCount], name).toEqual(before[name]);
        }
    });
});

describe('spire: tiers of laterals on a single leader', () => {
    const CONE = { 'top-exponent': 1, 'widest-at': 0, 'crown-base-ratio': 0.15, radius: 3.5, height: 20, apical: 0.62, 'leader-hold': 1, 'branch-angle': 1.3 };

    it('the leader runs to the crown\'s top and carries its laterals only in whorls, the same number in each, a spacing apart', () => {
        const t = probe({ ...CONE, 'whorl-branches': 5, 'whorl-spacing': 1.2 });
        const leader = t.nodes.filter(n => n.order === 0);
        expect(Math.max(...leader.map(n => n.y))).toBeGreaterThan(20 - 2 * t.crown.stepM);
        // the leader is one straight stem: it never strays from the axis
        expect(Math.max(...leader.map(horizontal))).toBeLessThan(0.05);
        // laterals that leave the leader, by the leader node they leave
        const tiers = new Map<number, number>();
        t.nodes.forEach(n => { if (n.order === 1 && t.nodes[n.parent].order === 0) tiers.set(n.parent, (tiers.get(n.parent) ?? 0) + 1); });
        expect(tiers.size).toBeGreaterThanOrEqual(10);
        const counts = [...tiers.values()];
        // five in every tier (the leader's own tip may add a lateral or two of its own at the very top)
        expect(counts.filter(c => c === 5).length).toBeGreaterThanOrEqual(tiers.size - 2);
        const heights = [...tiers.keys()].map(i => t.nodes[i].y).sort((a, b) => a - b);
        const gaps = heights.slice(1).map((y, i) => y - heights[i]).filter(g => g > 0.3);
        expect(Math.min(...gaps)).toBeGreaterThan(1.2 - t.crown.stepM - 1e-3);
        expect(mean(gaps)).toBeLessThan(1.2 + 2 * t.crown.stepM);
        // without whorls the same crown has laterals all along its leader
        const plain = probe(CONE);
        const plainParents = new Set(plain.nodes.filter(n => n.order >= 1 && plain.nodes[n.parent].order === 0).map(n => n.parent));
        expect(plainParents.size).toBeGreaterThan(tiers.size);
    });

    it('in a cone the tiers shorten with height: the crown\'s width falls from its base to a point', () => {
        const t = probe({ ...CONE, 'whorl-branches': 5, 'whorl-spacing': 1.2 });
        // how far the wood reaches from the stem in each fifth of the crown's depth, and how far the leaves do
        const base = t.crown.crownBaseY, depth = 20 - base;
        const band = (y: number) => Math.min(4, Math.max(0, Math.floor(((y - base) / depth) * 5)));
        const wood = [0, 0, 0, 0, 0], leaves = [0, 0, 0, 0, 0];
        for (const n of t.nodes) if (n.y >= base) wood[band(n.y)] = Math.max(wood[band(n.y)], horizontal(n));
        for (const v of t.foliage) if (v[1] >= base) leaves[band(v[1])] = Math.max(leaves[band(v[1])], Math.hypot(v[0], v[2]));
        for (const reach of [wood, leaves]) {
            for (let k = 1; k < 5; k++) expect(reach[k], `band ${k} of ${reach.map(r => r.toFixed(2)).join(', ')}`).toBeLessThan(reach[k - 1] + 0.35);
        }
        expect(wood[2]).toBeLessThan(0.85 * wood[0]);
        // the wood to under half its lowest reach at the top; the leaf masses, which have a size of their own, to under two thirds
        expect(wood[4]).toBeLessThan(0.5 * wood[0]);
        expect(leaves[4]).toBeLessThan(0.66 * leaves[0]);
        // and the tree fills its crown
        expect(t.colonisation.attractorsReached / t.crown.attractors).toBeGreaterThan(0.95);
    });

    it('the trunk climbs its own line to a crown that begins above it instead of bending over to its rim', () => {
        const HIGH = { 'crown-starts-at': 0.75, 'crown-base-ratio': 0.15, height: 30, radius: 4.5, 'top-exponent': 1.5, apical: 0.62, 'leader-hold': 1, 'branch-angle': 1.3 };
        const kinked = probe(HIGH), straight = probe({ ...HIGH, 'trunk-seek-along-stem': 1 });
        expect(kinked.colonisation.trunkSeekSteps).toBeGreaterThan(3);
        const offAxis = (t: Probe) => Math.max(...t.nodes.filter(n => n.order === 0).map(horizontal));
        expect(offAxis(kinked)).toBeGreaterThan(1.0);
        expect(offAxis(straight)).toBeLessThan(0.05);
        expect(straight.colonisation.attractorsReached / straight.crown.attractors).toBeGreaterThan(0.9);
    });

    it('momentum release: a strongly apical tree reaches its crown instead of passing its attractors and stalling', () => {
        const share = (t: Probe) => t.colonisation.attractorsReached / t.crown.attractors;
        const cases = [{ apical: 0.95, seed: 1234 }, { apical: 0.95, seed: 7 }, { apical: 0.9, seed: 99, radius: 7, height: 14 }, { apical: 1.0, seed: 5, 'top-exponent': 4, radius: 8, height: 12 }];
        const without = cases.map(c => share(probe(c))), withRelease = cases.map(c => share(probe({ ...c, 'momentum-release': 1 })));
        for (let i = 0; i < cases.length; i++) expect(withRelease[i], `case ${i}: ${without[i]} -> ${withRelease[i]}`).toBeGreaterThanOrEqual(without[i] - 0.01);
        expect(mean(withRelease)).toBeGreaterThan(mean(without));
        expect(Math.min(...withRelease)).toBeGreaterThan(0.97);
    });
});

describe('fronds: a rosette of compound leaves on an unbranched stem', () => {
    const PALM = { height: 18, radius: 3.6, 'crown-base-ratio': 0.8, 'top-exponent': 2.2, 'branch-angle': 1.2 };
    const RACHIS = 4;   // the pieces each leaf's rachis is drawn as (kRachisRibbons), before its leaflets

    it('has no branch below the crown: one stem, then every leaf from its top', () => {
        const t = probe({ ...PALM, 'rosette-leaves': 14 });
        const stem = t.nodes.filter(n => n.rosetteLeaf === -1);
        const centre = stem[stem.length - 1];
        // the stem is a single chain: every node of it but its top has exactly one child, and its top has the leaves
        expect(stem.slice(0, -1).every(n => n.children === 1)).toBe(true);
        // the species' 14 leaves, and up to half as many again sent to the parts of the dome's surface they leave unreached
        const leafCount = new Set(t.nodes.filter(n => n.rosetteLeaf >= 0).map(n => n.rosetteLeaf)).size;
        expect(leafCount).toBeGreaterThanOrEqual(14);
        expect(leafCount).toBeLessThanOrEqual(21);
        expect(centre.children).toBe(leafCount);
        expect(centre.y).toBeGreaterThanOrEqual(t.crown.crownBaseY - 1e-3);
        expect(Math.max(...stem.map(horizontal))).toBeLessThan(0.05);
        // nothing forks anywhere else, and no wood but the stem stands below the crown base
        const leafNodes = t.nodes.filter(n => n.rosetteLeaf >= 0);
        expect(leafNodes.every(n => n.children <= 1)).toBe(true);
        expect(leafNodes.every(n => n.y >= t.crown.crownBaseY - 1e-3)).toBe(true);
        expect(t.colonisation.stop).toBe('rosette');
        // the leaves reach the crown's footprint and stay within its height
        const reach = Math.max(...leafNodes.map(horizontal));
        expect(reach).toBeGreaterThan(0.6 * 3.6);
        expect(reach).toBeLessThan(1.5 * 3.6);
        expect(Math.max(...leafNodes.map(n => n.y))).toBeLessThanOrEqual(18 + 0.3);
        // drawn as flat pieces of two triangles: each leaf's rachis as 4, and a side's worth of leaflets on both its sides
        expect(t.mesh.trianglesPerPiece).toBe(2);
        expect(t.mesh.foliagePieces).toBe(leafCount * (2 * 24 + RACHIS));
        expect(t.mesh.foliageTriangles).toBe(leafCount * (2 * 24 + RACHIS) * 2);
    });

    it('arch bends the leaves down along their length; without it they stand straight', () => {
        const tipsY = (t: Probe) => t.nodes.filter(n => n.rosetteLeaf >= 0 && n.children === 0).map(n => n.y);
        const straight = probe({ ...PALM, 'rosette-leaves': 14, 'rosette-arch': 0 }), arched = probe({ ...PALM, 'rosette-leaves': 14, 'rosette-arch': 1 });
        expect(mean(tipsY(arched))).toBeLessThan(mean(tipsY(straight)) - 0.4);
        // a straight leaf's nodes lie on one line from the stem's top; an arched one's tip hangs below that line
        const sag = (t: Probe) => {
            const out: number[] = [];
            // (the species' own 14; the leaves sent after the crown's surface run straight at it)
            for (let leaf = 0; leaf < 14; leaf++) {
                const chain = t.nodes.filter(n => n.rosetteLeaf === leaf);
                const first = chain[0], centre = t.nodes[first.parent], tip = chain[chain.length - 1];
                const slope0 = (first.y - centre.y) / Math.max(1e-6, Math.hypot(first.x - centre.x, first.z - centre.z));
                out.push(centre.y + slope0 * Math.hypot(tip.x - centre.x, tip.z - centre.z) - tip.y);
            }
            return out;
        };
        expect(Math.max(...sag(straight).map(Math.abs))).toBeLessThan(0.05);
        expect(Math.min(...sag(arched))).toBeGreaterThan(0.1);
    });

    it('leaflets: a full span lines the whole rachis (pinnate), a short one gathers them at its end (palmate); the count follows the parameter and the budget', () => {
        const pinnate = probe({ ...PALM, 'rosette-leaves': 12, 'leaflet-span': 1 }), palmate = probe({ ...PALM, 'rosette-leaves': 12, 'leaflet-span': 0.2 });
        // each piece is four vertices, its first two its base on the rachis; a leaf's pieces are its rachis, then its leaflets
        const baseReach = (t: Probe) => {
            const perLeaf = t.mesh.foliagePieces / new Set(t.nodes.filter(n => n.rosetteLeaf >= 0).map(n => n.rosetteLeaf)).size;
            return t.foliage.filter((_, i) => i % 4 === 0 && Math.floor(i / 4) % perLeaf >= RACHIS).map(v => Math.hypot(v[0], v[2]));
        };
        expect(Math.min(...baseReach(pinnate))).toBeLessThan(0.5);
        expect(Math.min(...baseReach(palmate))).toBeGreaterThan(Math.min(...baseReach(pinnate)) + 0.5);
        expect(mean(baseReach(palmate))).toBeGreaterThan(mean(baseReach(pinnate)));
        const ten = probe({ ...PALM, 'rosette-leaves': 12, 'leaflets-per-side': 10 });
        expect(ten.mesh.foliagePieces).toBe(new Set(ten.nodes.filter(n => n.rosetteLeaf >= 0).map(n => n.rosetteLeaf)).size * (2 * 10 + RACHIS));
        // a budget that holds fewer draws fewer a side, never more triangles than it has
        const tight = probe({ ...PALM, 'rosette-leaves': 12, 'leaflets-per-side': 40, budget: 1200 });
        expect(tight.mesh.woodTriangles + tight.mesh.foliageTriangles).toBeLessThanOrEqual(1200);
        expect(tight.mesh.foliagePieces).toBeGreaterThan(0);
        expect(tight.mesh.foliagePieces).toBeLessThan(12 * 2 * 40);

    });
});

describe('weeping: shoots that droop, tails that hang', () => {
    // a dome whose leaves begin well above its crown base, so there is room under it to hang into
    const DOME = { height: 12, radius: 6, 'crown-base-ratio': 0.15, 'top-exponent': 2.2, scaffold: 4, 'crown-starts-at': 0.6 };

    it('droop lowers the branch tips, the longer and higher-order shoots most; with none nothing moves', () => {
        const upright = probe(DOME), drooping = probe({ ...DOME, 'shoot-droop': 0.9, 'shoot-droop-length': 1.5 });
        // the tips of the laterals (order 2 and more), and how they head: the vertical part of their last step
        const heading = (t: Probe) => t.nodes.filter(n => n.children === 0 && n.order >= 2).map(n => (n.y - t.nodes[n.parent].y) / t.crown.stepM);
        expect(mean(heading(drooping))).toBeLessThan(mean(heading(upright)) - 0.15);
        const tipsY = (t: Probe) => t.nodes.filter(n => n.children === 0 && n.order >= 1).map(n => n.y);
        expect(mean(tipsY(drooping))).toBeLessThan(mean(tipsY(upright)));
        // the trunk is not a shoot off the leader: it stands as it stood
        const trunk = (t: Probe) => t.nodes.slice(0, t.colonisation.trunkNodes).map(n => [n.x, n.y, n.z]);
        expect(trunk(drooping)).toEqual(trunk(upright));
    });

    it('tails hang from the tips straight down toward the crown base, never below it, and are drawn as strands', () => {
        const plain = probe(DOME), weeping = probe({ ...DOME, 'tail-share': 0.85 });
        const tails = weeping.nodes.filter(n => n.tail >= 0);
        expect(tails.length).toBeGreaterThan(200);
        expect(plain.nodes.some(n => n.tail >= 0)).toBe(false);
        for (const n of tails) {
            const tip = weeping.nodes[n.tail];
            expect(n.y).toBeLessThan(tip.y);
            expect(n.y).toBeGreaterThanOrEqual(weeping.crown.crownBaseY - 1e-3);
            // it hangs under its tip, not out from it: within a couple of steps sideways
            expect(Math.hypot(n.x - tip.x, n.z - tip.z)).toBeLessThan(3 * weeping.crown.stepM);
        }
        // every node the tails did not add is where it was
        expect(weeping.nodes.slice(0, plain.nodeCount).map(n => [n.x, n.y, n.z])).toEqual(plain.nodes.map(n => [n.x, n.y, n.z]));
        // the leaves hang lower than the crown's own masses did, down toward the crown base
        expect(weeping.mesh.foliageLowestY!).toBeLessThan(plain.mesh.foliageLowestY! - 1.0);
        expect(weeping.mesh.foliageLowestY!).toBeGreaterThanOrEqual(weeping.crown.crownBaseY - 0.6);
        // strands are taller than they are wide: among the foliage pieces some are at least four times so
        const per = weeping.foliage.length / weeping.mesh.foliagePieces;
        expect(Number.isInteger(per)).toBe(true);
        let strands = 0;
        for (let p = 0; p < weeping.mesh.foliagePieces; p++) {
            const vs = weeping.foliage.slice(p * per, (p + 1) * per);
            const tall = Math.max(...vs.map(v => v[1])) - Math.min(...vs.map(v => v[1]));
            const wide = Math.max(Math.max(...vs.map(v => v[0])) - Math.min(...vs.map(v => v[0])), Math.max(...vs.map(v => v[2])) - Math.min(...vs.map(v => v[2])));
            if (tall > 4 * wide) strands++;
        }
        expect(strands).toBeGreaterThan(20);
    });
});

describe('broadleaf architecture: lateral angle, order gain, openness', () => {
    const DOME = { height: 15, radius: 5.5, 'crown-base-ratio': 0.3, 'top-exponent': 2 };
    // the angle at which each lateral leaves the shoot it grows from: its first step against its parent's heading
    const departures = (t: Probe, order: number) => {
        const out: number[] = [];
        for (const n of t.nodes) {
            if (n.order !== order || n.parent < 0) continue;
            const p = t.nodes[n.parent];
            if (p.order !== order - 1 || p.parent < 0) continue;
            const g = t.nodes[p.parent];
            const a = [p.x - g.x, p.y - g.y, p.z - g.z], b = [n.x - p.x, n.y - p.y, n.z - p.z];
            const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
            out.push(Math.acos(Math.min(1, Math.max(-1, cos))));
        }
        return out;
    };

    it('a held angle sets how the laterals leave: steep when it is small, wide when it is large', () => {
        const steep = probe({ ...DOME, 'branch-angle': 0.4, 'lateral-angle-hold': 0.9 }), wide = probe({ ...DOME, 'branch-angle': 1.2, 'lateral-angle-hold': 0.9 });
        const free = probe({ ...DOME, 'branch-angle': 0.4 });
        const s = mean(departures(steep, 2)), w = mean(departures(wide, 2)), f = mean(departures(free, 2));
        expect(departures(steep, 2).length).toBeGreaterThan(15);
        expect(s).toBeLessThan(w - 0.3);
        // held, the steep tree's laterals leave nearer its 0.4 rad than the same tree's do unheld
        expect(Math.abs(s - 0.4)).toBeLessThan(Math.abs(f - 0.4));
        // both still fill the crown
        for (const t of [steep, wide]) expect(t.colonisation.attractorsReached / t.crown.attractors).toBeGreaterThan(0.9);
    });

    it('the order gain widens (or narrows) the angle with each branch order', () => {
        const widening = probe({ ...DOME, 'branch-angle': 0.5, 'lateral-angle-hold': 0.9, 'lateral-angle-order-gain': 0.3 });
        const narrowing = probe({ ...DOME, 'branch-angle': 1.0, 'lateral-angle-hold': 0.9, 'lateral-angle-order-gain': -0.25 });
        expect(mean(departures(widening, 3))).toBeGreaterThan(mean(departures(widening, 2)) + 0.1);
        expect(mean(departures(narrowing, 3))).toBeLessThan(mean(departures(narrowing, 2)) - 0.1);
    });

    it('an open crown has fewer and smaller leaf masses on the same skeleton', () => {
        const dense = probe(DOME), open = probe({ ...DOME, 'crown-openness': 0.8 });
        expect(open.skeletonHash).toBe(dense.skeletonHash);
        expect(open.mesh.foliagePieces).toBeLessThan(dense.mesh.foliagePieces);
        expect(open.mesh.foliagePieces).toBeGreaterThan(0.4 * dense.mesh.foliagePieces);
        const size = (t: Probe) => {
            const per = t.foliage.length / t.mesh.foliagePieces;
            const out: number[] = [];
            for (let p = 0; p < t.mesh.foliagePieces; p++) {
                const vs = t.foliage.slice(p * per, (p + 1) * per);
                out.push(Math.max(...vs.map(v => v[0])) - Math.min(...vs.map(v => v[0])));
            }
            return mean(out);
        };
        expect(size(open)).toBeLessThan(0.8 * size(dense));
    });
});

describe('the growth-form fields in the species library', () => {
    const entry = (id: string): TreeSpeciesEntry => INDEX.entries.find(e => e.id === id)!;
    const nativeLoad = (doc: unknown): string => {
        const file = path.join(work, `i-${Math.random().toString(16).slice(2)}.json`);
        fs.writeFileSync(file, JSON.stringify(doc));
        const r = spawnSync(matchBin, ['--species-index', file], { encoding: 'utf8' });
        return r.status === 0 ? '' : r.stderr.trim();
    };

    it('the index is valid in both loaders, and its forms are told by numbers alone', () => {
        expect(validateTreeSpeciesIndex(INDEX)).toEqual([]);
        expect(nativeLoad(INDEX)).toBe('');
        const rosettes = INDEX.entries.filter(e => (e.rosetteLeaves ?? 0) > 0), whorled = INDEX.entries.filter(e => (e.whorlBranches ?? 0) > 0), weeping = INDEX.entries.filter(e => (e.weeping ?? 0) >= 0.5);
        expect(rosettes.length).toBeGreaterThanOrEqual(4);
        expect(whorled.length).toBeGreaterThanOrEqual(5);
        expect(weeping.length).toBeGreaterThanOrEqual(1);
        // a rosette is a long-leaved single stem with a high crown base; a whorled entry holds its leader and is pointed
        for (const e of rosettes) {
            expect(e.stems, e.id).toBe(1);
            expect(e.leafLengthM, e.id).toBeGreaterThanOrEqual(1);
            expect(e.crownBaseRatio, e.id).toBeGreaterThanOrEqual(0.7);
        }
        for (const e of whorled) {
            expect(e.apicalDominance, e.id).toBeGreaterThanOrEqual(0.6);
            expect(e.topShare, e.id).toBeLessThan(0.35);
        }
        // every entry with a long compound leaf and a bare stem is a rosette: none is left to grow as a ball of leaves
        for (const e of INDEX.entries) if (e.leafLengthM >= 1 && e.crownBaseRatio >= 0.7) expect(e.rosetteLeaves ?? 0, e.id).toBeGreaterThan(0);
    });

    it('the five entries that grew as one round tree now differ in what the grower reads', () => {
        const five = ['green_ash', 'hornbeam', 'mango', 'bitter_orange', 'mesquite'].map(entry);
        const signature = (e: TreeSpeciesEntry) => [e.stems, e.crownBaseRatio, e.branchAngleRad, e.branchAngleHold ?? 0, e.internodeLengthPerHeight ?? 0, e.crownOpenness ?? 0, e.weeping ?? 0];
        for (let i = 0; i < five.length; i++) {
            for (let k = i + 1; k < five.length; k++) {
                const a = signature(five[i]), b = signature(five[k]);
                // at least three of the seven quantities differ between any two
                expect(a.filter((v, j) => Math.abs(v - b[j]) > 1e-9).length, `${five[i].id} vs ${five[k].id}`).toBeGreaterThanOrEqual(3);
            }
        }
    });

    it('both loaders refuse each form field out of range, naming it', () => {
        const withEntry = (patch: Record<string, unknown>, base = 'red_oak'): unknown => ({ ...INDEX, entries: [{ ...entry(base), id: 'x', ...patch }] });
        const cases: [Record<string, unknown>, string][] = [
            [{ whorlBranches: 13, whorlSpacingPerHeight: 0.03 }, 'whorlBranches'],
            [{ whorlBranches: 2.5, whorlSpacingPerHeight: 0.03 }, 'whorlBranches'],
            [{ whorlBranches: 5 }, 'whorlSpacingPerHeight'],
            [{ whorlBranches: 5, whorlSpacingPerHeight: 0.5 }, 'whorlSpacingPerHeight'],
            [{ weeping: 1.5 }, 'weeping'],
            [{ rosetteLeaves: 61 }, 'rosetteLeaves'],
            [{ rosetteLeaves: 12, stems: 3 }, 'rosette'],
            [{ rosetteLeaves: 12, whorlBranches: 4, whorlSpacingPerHeight: 0.03 }, 'rosette'],
            [{ leafArch: 2 }, 'leafArch'],
            [{ leafletsPerSide: 0 }, 'leafletsPerSide'],
            [{ leafletSpanShare: 0 }, 'leafletSpanShare'],
            [{ leafletLengthShare: 1.5 }, 'leafletLengthShare'],
            [{ leafletAngleRad: 2 }, 'leafletAngleRad'],
            [{ branchAngleHold: -0.1 }, 'branchAngleHold'],
            [{ branchAngleOrderGainRad: 1 }, 'branchAngleOrderGainRad'],
            [{ internodeLengthPerHeight: 0.5 }, 'internodeLengthPerHeight'],
            [{ crownOpenness: 1.2 }, 'crownOpenness']
        ];
        for (const [patch, names] of cases) {
            const doc = withEntry(patch);
            expect(validateTreeSpeciesIndex(doc).join('; '), `TypeScript on ${JSON.stringify(patch)}`).toContain(names);
            expect(nativeLoad(doc), `native on ${JSON.stringify(patch)}`).toContain(names);
        }
        // and an entry with none of them is as valid as it was
        const bare = { ...entry('red_oak'), id: 'bare' };
        expect(validateTreeSpeciesIndex({ ...INDEX, entries: [bare] })).toEqual([]);
        expect(nativeLoad({ ...INDEX, entries: [bare] })).toBe('');
    });

    it('the growth call hands every form field of the matched entry to the grower', () => {
        const src = fs.readFileSync(path.join(INCLUDE, 'scratchbox_tile_vegetation.hpp'), 'utf8');
        for (const field of ['whorlBranches', 'whorlSpacingPerHeight', 'weeping', 'rosetteLeaves', 'leafArch', 'leafletsPerSide', 'leafletSpanShare', 'leafletLengthShare', 'leafletAngleRad', 'branchAngleHold', 'branchAngleOrderGainRad', 'internodeLengthPerHeight', 'crownOpenness']) {
            expect(src, field).toContain(`form->${field}`);
        }
    });
});

describe('stems from the ground and uneven crowns', () => {
    it('stems from the ground grow on to a crown that begins out of their sight, as a single trunk does', () => {
        // a tall crown whose leaves begin far up: from a fork at the root collar nothing is in sight
        const HIGH = { height: 14, radius: 5, 'crown-base-ratio': 0.15, 'crown-starts-at': 0.9, 'stems-from-ground': 1 };
        const t = probe(HIGH);
        expect(t.colonisation.trunkSeekSteps).toBeGreaterThan(4);
        expect(t.colonisation.attractorsReached / t.crown.attractors).toBeGreaterThan(0.9);
        expect(t.mesh.foliageTriangles).toBeGreaterThan(0);
        // the stems leave the root collar
        const fork = t.nodes.findIndex(n => n.children >= 4);
        expect(fork).toBeGreaterThanOrEqual(0);
        expect(t.nodes[fork].y).toBeLessThan(0.5);
        // a crown that is in sight from the fork grows exactly as it did (the seeking never starts)
        const low = probe({ height: 3, radius: 2, 'crown-base-ratio': 0.05, 'stems-from-ground': 1 });
        expect(low.colonisation.trunkSeekSteps).toBe(0);
        expect(low.colonisation.attractorsReached / low.crown.attractors).toBeGreaterThan(0.9);
    });

    it('a rosette is fitted to an uneven crown: a lump out to one side is reached by a leaf', () => {
        const PALM = { height: 18, radius: 3.6, 'crown-base-ratio': 0.8, 'top-exponent': 2.2, 'branch-angle': 1.2, 'rosette-leaves': 10 };
        const even = probe(PALM);
        // on the even crown nothing reaches out to where the lump will be
        expect(Math.min(...even.nodes.map(n => Math.hypot(n.x - 6.5, n.y - 16, n.z)))).toBeGreaterThan(2.0);
        expect(new Set(even.nodes.filter(n => n.rosetteLeaf >= 0).map(n => n.rosetteLeaf)).size).toBeLessThanOrEqual(15);
        // a ball of crown 6.5 m out to one side, well past the fronds
        const uneven = probe({ ...PALM, 'lump-x': 6.5, 'lump-y': 16, 'lump-r': 1.2 });
        const leaves = new Set(uneven.nodes.filter(n => n.rosetteLeaf >= 0).map(n => n.rosetteLeaf)).size;
        expect(leaves).toBeGreaterThan(10);
        expect(leaves).toBeLessThanOrEqual(15);   // never more than half as many again
        // a leaf reaches the lump: the one in its sector grown out to it (the footprint sets each leaf's length), or one sent after it
        const near = Math.min(...uneven.nodes.filter(n => n.rosetteLeaf >= 0).map(n => Math.hypot(n.x - 6.5, n.y - 16, n.z)));
        expect(near).toBeLessThan(1.5);
        // still one unbranched stem
        expect(uneven.nodes.filter(n => n.rosetteLeaf === -1).slice(0, -1).every(n => n.children === 1)).toBe(true);
        // and its leaflets are drawn on every leaf
        expect(uneven.mesh.foliagePieces).toBe(leaves * (2 * 24 + 4));
    });
});

describe('levels of detail of every form (tile_vegetation grow)', () => {
    let bin: string;
    const entryOf = (id: string): TreeSpeciesEntry => INDEX.entries.find(e => e.id === id)!;
    interface Levels { triangles: number[]; foliagePrimitives: (number[] | undefined)[]; frondSpread: number[]; frondTop: number[]; instanced: boolean[]; leaves: any }

    /** One described crown grown with one pinned entry through the default path; its four levels, near to far. */
    function grow(id: string, tree: Record<string, unknown>): Levels {
        const dir = fs.mkdtempSync(path.join(work, 'lod-'));
        fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ ...INDEX, entries: [entryOf(id)] }));
        fs.writeFileSync(path.join(dir, 'trees.json'), JSON.stringify({ schema: 'scratchbox.sb-veggie-trees/1', trees: [tree] }));
        execFileSync(bin, ['grow', '--trees', path.join(dir, 'trees.json'), '--out', path.join(dir, 'trees.glb'), '--stats', path.join(dir, 'stats.json'), '--seed', '5eed', '--quantize', '0',
            '--species-index', path.join(dir, 'index.json'), '--species-index-label', 'pinned',
            '--texture-index', path.join(REPO, 'assets/textures/trees/index.json'), '--texture-index-label', 'assets/textures/trees/index.json'], { stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
        const { json, bin: buffer } = parseGlb(fs.readFileSync(path.join(dir, 'trees.glb')));
        const tree0 = json.nodes.find((n: any) => n.extras?.sbTree);
        const levels = (tree0.children as number[]).map(i => json.nodes[i]).filter((n: any) => n.extras?.sbLod).sort((a: any, b: any) => a.extras.sbLod.level - b.extras.sbLod.level);
        const out: Levels = { triangles: [], foliagePrimitives: [], frondSpread: [], frondTop: [], instanced: [], leaves: tree0.extras.sbTree.texture?.leaves };
        for (const n of levels) {
            const lod = n.extras.sbLod;
            out.triangles.push(lod.triangles);
            out.foliagePrimitives.push(lod.foliagePrimitives);
            out.instanced.push(lod.instanced);
            // the level's own leaves (the primitives its extras list): how far they spread from the stem and how high they stand
            let spread = 0, top = -Infinity;
            for (const pi of lod.foliagePrimitives ?? []) {
                const { data } = readAccessor(json, buffer, json.meshes[n.mesh].primitives[pi].attributes.POSITION);
                for (let v = 0; v < data.length; v += 3) {
                    spread = Math.max(spread, Math.hypot(data[v], data[v + 2]));
                    top = Math.max(top, data[v + 1]);
                }
            }
            out.frondSpread.push(spread);
            out.frondTop.push(top);
        }
        return out;
    }

    beforeAll(async () => {
        bin = await new TileVegetationService({ workspaceRoot: work, repoRoot: REPO }).ensureBinary();
    }, 900_000);

    const DOME = { heightM: 18, crownRadiusM: 3.6, crownTopExponent: 2.2, crownWidestAt: 0.5 };

    it('a rosette\'s fronds are each level\'s own leaves: at the near, near-mid and mid levels with the crown\'s spread, fewer leaflets each level out', () => {
        const rosettes = INDEX.entries.filter(e => (e.rosetteLeaves ?? 0) > 0);
        expect(rosettes.length).toBeGreaterThanOrEqual(4);
        for (const e of rosettes) {
            const L = grow(e.id, DOME);
            expect(L.triangles, e.id).toHaveLength(4);
            // every level lists its leaves as its second primitive (the first is the wood)
            for (let k = 0; k < 4; k++) expect(L.foliagePrimitives[k], `${e.id} level ${k}`).toEqual([1]);
            // the mid level keeps the crown's spread and height: within a tenth of the near level's, and most of the crown's radius
            expect(L.frondSpread[2], e.id).toBeGreaterThan(0.9 * L.frondSpread[0]);
            expect(L.frondSpread[2], e.id).toBeGreaterThan(0.7 * DOME.crownRadiusM);
            expect(L.frondSpread[3], e.id).toBeGreaterThan(0.9 * L.frondSpread[0]);
            expect(Math.abs(L.frondTop[2] - L.frondTop[0]), e.id).toBeLessThan(0.5);
            // lighter with distance, and the mid level is not a bare trunk
            for (let k = 0; k < 3; k++) expect(L.triangles[k], `${e.id}: ${L.triangles.join(' > ')}`).toBeGreaterThan(L.triangles[k + 1]);
            expect(L.triangles[2], e.id).toBeGreaterThan(500);
        }
    }, 900_000);

    it('every form\'s levels get lighter with distance: near > near-mid > mid > far', () => {
        // one entry of each form the library has, each on a crown of its own shape
        const cases: [string, Record<string, number>][] = [
            ['spruce', { heightM: 18, crownRadiusM: 3.2, crownTopExponent: 1, crownWidestAt: 0 }],
            ['douglas_fir', { heightM: 14, crownRadiusM: 2.25, crownTopExponent: 1, crownWidestAt: 0.05 }],
            ['norfolk_island_pine', { heightM: 25, crownRadiusM: 2.9, crownTopExponent: 1, crownWidestAt: 0 }],
            ['weeping_willow', { heightM: 12, crownRadiusM: 6, crownTopExponent: 2.2, crownWidestAt: 0.5 }],
            ['mesquite', { heightM: 7, crownRadiusM: 3.5, crownTopExponent: 2.2, crownWidestAt: 0.4 }],
            ['green_ash', { heightM: 15, crownRadiusM: 5.3, crownTopExponent: 2, crownWidestAt: 0.45 }],
            ['hornbeam', { heightM: 15, crownRadiusM: 5.2, crownTopExponent: 1.8, crownWidestAt: 0.4 }],
            ['umbrella_acacia', { heightM: 9, crownRadiusM: 4.5, crownTopExponent: 2, crownWidestAt: 0.5 }],
            ['red_oak', { heightM: 18, crownRadiusM: 9, crownTopExponent: 2.2, crownWidestAt: 0.45 }],
            ['shrub', { heightM: 2.5, crownRadiusM: 2, crownTopExponent: 2, crownWidestAt: 0.4 }],
            ['date_palm', { heightM: 12, crownRadiusM: 4 }],
            ['coconut_palm', { heightM: 25, crownRadiusM: 4.5, crownTopExponent: 2.2, crownWidestAt: 0.5 }]
        ];
        for (const [id, tree] of cases) {
            const L = grow(id, tree);
            for (let k = 0; k < 3; k++) expect(L.triangles[k], `${id}: ${L.triangles.join(' > ')}`).toBeGreaterThan(L.triangles[k + 1]);
            // a branching tree's leaves are the library's instanced clusters and cards; only its far level has leaves of its own
            if (!(entryOf(id).rosetteLeaves ?? 0)) {
                expect(L.foliagePrimitives.slice(0, 3), id).toEqual([undefined, undefined, undefined]);
                expect(L.instanced[0], id).toBe(true);
            }
        }
    }, 900_000);

    it('a needle finer than the texture library\'s finest is still drawn as a needle', () => {
        // a needle under a millimetre wide, finer than any leaf set: it takes the finest set, not broad leaves
        const fine = INDEX.entries.find(e => e.leafLengthM * e.leafAspect < 0.001 && e.leafLengthM < 0.1 && e.stems === 1)!;
        expect(fine).toBeDefined();
        // (with the dark green a conifer's crown measures: the leaf set is chosen by colour and width together)
        const L = grow(fine.id, { heightM: 24, crownRadiusM: 3.7, crownTopExponent: 1, crownWidestAt: 0, leafLinearRgb: [0.02, 0.045, 0.028] });
        const textures = JSON.parse(fs.readFileSync(path.join(REPO, 'assets/textures/trees/index.json'), 'utf8')) as { leaves: Array<{ id: string; leaf: { bladeWidthM: number } }> };
        const thinnest = Math.min(...textures.leaves.map(e => e.leaf.bladeWidthM));
        expect(L.leaves.targetBladeWidthM).toBe(thinnest);
        expect(L.leaves.bladeWidthM).toBe(thinnest);
    }, 900_000);
});
