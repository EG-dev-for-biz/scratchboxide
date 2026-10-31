/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The photo-match evaluator's software renderer cuts tree leaves and crown cards out as the viewport does (tree-lod-view.ts
 * cut-outs, renderTriangles' alpha test):
 *
 * - a tree planted natively (scratchbox_tree_lod.hpp, crown cards on), drawn at its mid level as cards only, covers the share
 *   of its crown the writer measured for that level (clay: the ellipses; textured: the leaf set's card atlas), not the
 *   whole crown as the solid card squares did;
 * - a textured tree's near leaves are cut out of the library leaf set, so they cover less than their clay outlines;
 * - the viewport's clay mask carries the cut-out in the green channel its alphaMap reads.
 *
 * Coverage is measured as the writer measures it: from its 9 view directions, nearly orthographic (a far pinhole camera),
 * the share of the reference crown ellipsoid's silhouette the samples cover. The reference is the writer's own fit
 * (fitCrownEllipsoid, compiled from the native header) to the same points: the crown's surface samples above its inferred
 * crown base and its footprint ring. No network, no billed call. Screenshots under test-results/screenshots/tree_view_alpha/.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import type { TreeNodeExtras, TreesGlbRootExtras } from '../src/common/spatial/staged-location-contracts';
import type { PinholeCamera } from '../src/common/spatial/texture-pass-contracts';
import { bakeCrownCardAtlas, clayLeafPaint, crownCardMaskPixels } from '../src/common/spatial/tree-crown-card-atlas';
import { composeGrid, renderTriangles, type ArmRender } from '../src/node/3d-engine/staged-location/photo-match-eval';
import { readGlbChunks, selectTriangles, type TileTriangles } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { readTreesLodGlb, type TreesLodGlb } from '../src/node/3d-engine/staged-location/tree-lod-view';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const INCLUDE = path.join(REPO, 'packages/core/src/native/3d-engine/include');
const SHOTS = path.join(REPO, 'test-results/screenshots/tree_view_alpha');

type Vec3 = [number, number, number];
function crown(id: number, stem: [number, number], supportY: number, apexY: number, radius: number, greenShare: number) {
    const samples: Vec3[] = [];
    const n = Math.ceil(radius / 0.7);
    for (let i = -n; i <= n; i++) for (let k = -n; k <= n; k++) {
        const dx = i * 0.7, dz = k * 0.7, d = Math.hypot(dx, dz);
        if (d <= radius) samples.push([stem[0] + dx, apexY - 0.45 * (apexY - supportY) * (d / radius) ** 2, stem[1] + dz]);
    }
    return {
        id, status: 'tree', reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY, supportSource: 'given', terrainY: supportY,
        apexAboveSupport: apexY - supportY, areaM2: Math.PI * radius * radius, sectorRadii: new Array(16).fill(radius), samples,
        colour: { meanLinearRgb: [0.08, 0.09, 0.045], spreadLinearRgb: [0.02, 0.02, 0.01], samples: 100, cells: 50, greenShare, hueDeg: 70, chroma: 0.5 }
    };
}

type Ellipsoid = { centre: number[]; radii: number[]; yawRad: number };

/**
 * The writer's reference crown (scratchbox_tree_lod.hpp, "projected coverage"): fitCrownEllipsoid over the surface samples
 * above the crown base and the footprint ring (16 sector radii at 0.85 of the clear trunk), fitted by the native function.
 */
function referenceCrown(work: string, c: ReturnType<typeof crown>, node: any): Ellipsoid {
    const base = node.inferred.crownBaseY as number, support = c.supportY;
    const pts = c.samples.filter(p => p[1] >= base);
    const bottom = Math.fround(support + Math.fround(base - support) * 0.85);
    c.sectorRadii.forEach((r, k) => { const a = -Math.PI + ((k + 0.5) * 2 * Math.PI) / 16; if (r > 0) pts.push([c.stem[0] + r * Math.cos(a), bottom, c.stem[1] + r * Math.sin(a)]); });
    const src = path.join(work, 'ref.cpp'), bin = path.join(work, 'ref'), input = path.join(work, 'ref.txt');
    fs.writeFileSync(input, pts.map(p => p.join(' ')).join('\n'));
    fs.writeFileSync(src, `#include "scratchbox_tree_lod.hpp"
#include <cstdio>
int main(int, char** argv) { std::vector<scratchbox::tree_lod::Vec3> p; double x, y, z; FILE* f = std::fopen(argv[1], "r");
  while (std::fscanf(f, "%lf %lf %lf", &x, &y, &z) == 3) p.push_back(scratchbox::tree_lod::Vec3(float(x), float(y), float(z)));
  auto e = scratchbox::tree_lod::fitCrownEllipsoid(p);
  std::printf("%.9f %.9f %.9f %.9f %.9f %.9f %.9f\\n", e.centre.x, e.centre.y, e.centre.z, e.radii[0], e.radii[1], e.radii[2], e.yawRad); }`);
    const r = spawnSync(process.env.CXX || 'clang++', ['-std=c++20', '-O2', '-I' + INCLUDE, src, '-o', bin], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    const v = spawnSync(bin, [input], { encoding: 'utf8' }).stdout.trim().split(/\s+/).map(Number);
    return { centre: v.slice(0, 3), radii: v.slice(3, 6), yawRad: v[6] };
}

/** The writer's coverage directions (detail::CoverageViews::directions): 5 near the horizon, 3 at 45 degrees, 1 from above. */
function directions(): Vec3[] {
    const d: Vec3[] = [];
    const at = (e: number, a: number) => { const E = (e * Math.PI) / 180, A = (a * Math.PI) / 180; d.push([Math.cos(E) * Math.cos(A), Math.sin(E), Math.cos(E) * Math.sin(A)]); };
    for (let k = 0; k < 5; k++) at(10, 72 * k);
    for (let k = 0; k < 3; k++) at(45, 36 + 120 * k);
    at(90, 0);
    return d;
}

const norm = (v: number[]): Vec3 => { const l = Math.hypot(v[0], v[1], v[2]); return [v[0] / l, v[1] / l, v[2] / l]; };
const cross = (a: number[], b: number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** A nearly orthographic view of the crown along `d` (3 km away, `cell` metres a pixel) and the ellipsoid's silhouette in it. */
function crownView(c: Ellipsoid, d: Vec3, cell: number): { camera: PinholeCamera; ellipsoid: Uint8Array } {
    const R = Math.max(...c.radii), px = Math.ceil((2.6 * R) / cell);
    const D = 3000, f = D / cell;
    const fwd: Vec3 = [-d[0], -d[1], -d[2]];
    const right = Math.abs(d[1]) > 0.999 ? [1, 0, 0] as Vec3 : norm(cross([0, 1, 0], d));
    const up = cross(right, fwd);
    const eye: Vec3 = [c.centre[0] + D * d[0], c.centre[1] + D * d[1], c.centre[2] + D * d[2]];
    const camera: PinholeCamera = { eye, right, up, fwd, fx: f, fy: f, cx: px / 2, cy: px / 2, width: px, height: px };
    // the ellipsoid's frame: yaw about up (scratchbox_tree_lod.hpp CoverageViews::init)
    const cy = Math.cos(c.yawRad), sy = Math.sin(c.yawRad);
    const axes: Vec3[] = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
    const unit = (v: number[]) => axes.map((a, k) => (a[0] * v[0] + a[1] * v[1] + a[2] * v[2]) / c.radii[k]);
    const ellipsoid = new Uint8Array(px * px);
    const o = unit([eye[0] - c.centre[0], eye[1] - c.centre[1], eye[2] - c.centre[2]]);
    for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
        const xc = (x + 0.5 - px / 2) / f, yc = -(y + 0.5 - px / 2) / f;
        const r = unit([fwd[0] + xc * right[0] + yc * up[0], fwd[1] + xc * right[1] + yc * up[1], fwd[2] + xc * right[2] + yc * up[2]]);
        const a = r[0] * r[0] + r[1] * r[1] + r[2] * r[2], b = o[0] * r[0] + o[1] * r[1] + o[2] * r[2], cc = o[0] * o[0] + o[1] * o[1] + o[2] * o[2] - 1;
        if (b * b - a * cc >= 0) ellipsoid[y * px + x] = 1;
    }
    return { camera, ellipsoid };
}

/** The mean over the 9 views of the share of the ellipsoid's silhouette the render covers, and one view's renders. */
function coverage(tris: TileTriangles, c: Ellipsoid, clay: boolean, cell: number): { mean: number; shot: ArmRender; ms: number } {
    let sum = 0, ms = 0, shot!: ArmRender;
    directions().forEach((d, k) => {
        const v = crownView(c, d, cell);
        const r = renderTriangles([tris], v.camera, { clay });
        ms += r.ms;
        let cov = 0, n = 0;
        for (let i = 0; i < v.ellipsoid.length; i++) if (v.ellipsoid[i]) { n++; cov += r.coverage[i]; }
        sum += cov / n;
        if (k === 1) shot = r;
    });
    return { mean: sum / 9, shot, ms };
}

/** Tree `ti`'s triangles at `level`, those whose `which` cut-out passes `test` (by default all of them). */
function treeLevel(g: TreesLodGlb, ti: number, level: number, test: (clayCut: number, texturedCut: number) => boolean = () => true): TileTriangles {
    const keep = new Uint8Array(g.all.texture.length);
    for (let t = 0; t < keep.length; t++) keep[t] = g.treeOf[t] === ti && g.levelOf[t] === level && test(g.all.cutout?.clay[t] ?? -1, g.all.cutout?.textured[t] ?? -1) ? 1 : 0;
    return selectTriangles(g.all, keep);
}

/** A crown in half leaf (green share 0.25: leafiness 0.5, a coverage target of 0.68), so its cards leave gaps a square would fill. */
const TREE = crown(0, [0, 0], 0, 14, 4.5, 0.25);

describe('photo-match evaluator: tree leaves and crown cards cut out as the viewport cuts them', () => {
    let work: string;
    let planted: Awaited<ReturnType<TileVegetationService['plant']>>;
    let glb: Buffer;
    let ref: Ellipsoid;
    beforeAll(async () => {
        work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-view-alpha-')));
        const svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
        await svc.ensureBinary();
        fs.writeFileSync(path.join(work, 'crowns.json'), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 }, crowns: [TREE] }));
        // grown with the default proportions, not a species entry's (7fad2acc): a matched entry lowers this crown's base, its
        // mid cards then cover ~0.80 of the crown instead of ~0.75 and no longer leave the gaps this fixture is for
        planted = await svc.plant({ crownsPath: 'crowns.json', triangleBudget: 14000, seed: 'abc', species: false });
        glb = fs.readFileSync(planted.treesGlb);
        ref = referenceCrown(work, TREE, readGlbChunks(glb).json.nodes.find((n: any) => n.extras?.sbTree).extras);
        fs.mkdirSync(SHOTS, { recursive: true });
    }, 900_000);
    afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

    it('draws a card-only tree with the coverage the writer measured for its cards, not as solid squares', () => {
        const stats = planted.stats.perTree[0] as any;
        const native = stats.lod.coverage;
        expect(stats.lod.crownCards.cards).toBeGreaterThan(0);
        const g = readTreesLodGlb(glb)!;
        const { json } = readGlbChunks(glb);
        const tree = json.nodes.find((n: any) => n.extras?.sbTree)?.extras.sbTree as TreeNodeExtras;
        expect(tree.texture?.leaves.entry).toBeTruthy();
        // the mid level's cards only (no wood): every one carries a cut-out in both renders
        const cards = treeLevel(g, 0, 2, c => c >= 0);
        expect(cards.texture.length).toBe(2 * stats.lod.crownCards.cards);
        const cell = native.cellM;
        const solid = coverage({ ...cards, cutout: undefined }, ref, true, cell);
        const clay = coverage(cards, ref, true, cell);
        const textured = coverage(cards, ref, false, cell);
        console.log(`[tree-view-alpha] card-only tree (${cards.texture.length} triangles): solid ${solid.mean.toFixed(3)} (${solid.ms} ms / 9 views), clay ${clay.mean.toFixed(3)} (native ${native.mid.mean.toFixed(3)}, ${clay.ms} ms), textured ${textured.mean.toFixed(3)} (native ${native.cutout.mid.mean.toFixed(3)}, ${textured.ms} ms)`);
        // the squares cover almost the whole crown; the cut-outs what the writer measured for the cards. At the writer's own
        // cell a card is ~25 px and samples its mask's mip 3, where the viewport's mip lift (x2.3) keeps more of each leaf's
        // rim than the writer's full-resolution mask: a few hundredths more; at a third of the cell the lift is 1.6 and the
        // two agree closer
        expect(solid.mean).toBeGreaterThan(0.95);
        expect(clay.mean).toBeLessThan(solid.mean - 0.15);
        expect(Math.abs(clay.mean - native.mid.mean)).toBeLessThan(0.06);
        expect(Math.abs(textured.mean - native.cutout.mid.mean)).toBeLessThan(0.06);
        const fineClay = coverage(cards, ref, true, cell / 3), fineTextured = coverage(cards, ref, false, cell / 3);
        console.log(`[tree-view-alpha] at a third of the cell: clay ${fineClay.mean.toFixed(3)}, textured ${fineTextured.mean.toFixed(3)}`);
        expect(Math.abs(fineClay.mean - native.mid.mean)).toBeLessThan(0.03);
        expect(Math.abs(fineTextured.mean - native.cutout.mid.mean)).toBeLessThan(0.03);
        fs.writeFileSync(path.join(SHOTS, 'card_only_tree_before_after.png'), composeGrid([
            { image: solid.shot, label: 'BEFORE: SOLID CARDS', sublabel: `CROWN COVERED ${solid.mean.toFixed(3)}` },
            { image: clay.shot, label: 'AFTER: CLAY CUT-OUT', sublabel: `${clay.mean.toFixed(3)} NATIVE ${native.mid.mean.toFixed(3)}` },
            { image: textured.shot, label: 'AFTER: TEXTURED CUT-OUT', sublabel: `${textured.mean.toFixed(3)} NATIVE ${native.cutout.mid.mean.toFixed(3)}` }
        ], { tileWidth: 360, title: 'CARD-ONLY TREE, MID LEVEL, 72 DEG AZIMUTH 10 DEG UP' }));
    }, 300_000);

    it('cuts a textured tree\'s near leaves out of the library leaf set; clay leaves stay their outlines', () => {
        const g = readTreesLodGlb(glb)!;
        const native = (planted.stats.perTree[0] as any).lod.coverage;
        // the near level's leaf blades (the triangles a textured render cuts out), drawn in clay as their outlines
        const near = treeLevel(g, 0, 0, (_c, tex) => tex >= 0);
        const cut = near.cutout!;
        const leafTris = cut.textured.reduce((s, k) => s + (k >= 0 ? 1 : 0), 0);
        expect(leafTris).toBe(near.texture.length);
        expect(cut.clay.every(k => k < 0)).toBe(true);
        expect(cut.kinds.some(k => k.leaf)).toBe(true);
        const cell = native.cellM;
        const clay = coverage(near, ref, true, cell);
        const textured = coverage(near, ref, false, cell);
        const solid = coverage({ ...near, cutout: undefined }, ref, false, cell);
        console.log(`[tree-view-alpha] near level: clay ${clay.mean.toFixed(3)} (native ${native.level0.mean.toFixed(3)}), textured ${textured.mean.toFixed(3)} (native estimate ${native.cutout.level0.mean.toFixed(3)}), uncut ${solid.mean.toFixed(3)}`);
        // clay draws the leaf outlines whole; the textured leaves lose what their opacity cuts away
        expect(clay.mean).toBeCloseTo(solid.mean, 6);
        expect(textured.mean).toBeLessThan(clay.mean - 0.01);
        // the clay outlines are what the writer measured; its textured figure is an estimate (an ellipse a leaf), close to the real opacity
        expect(Math.abs(clay.mean - native.level0.mean)).toBeLessThan(0.02);
        expect(Math.abs(textured.mean - native.cutout.level0.mean)).toBeLessThan(0.04);
        fs.writeFileSync(path.join(SHOTS, 'near_level_leaves_clay_textured.png'), composeGrid([
            { image: clay.shot, label: 'NEAR LEVEL, CLAY (OUTLINES)', sublabel: `${clay.mean.toFixed(3)} NATIVE ${native.level0.mean.toFixed(3)}` },
            { image: textured.shot, label: 'NEAR LEVEL, TEXTURED CUT-OUT', sublabel: `${textured.mean.toFixed(3)} NATIVE EST ${native.cutout.level0.mean.toFixed(3)}` }
        ], { tileWidth: 360 }));
    }, 300_000);

    it('gives the viewport a clay mask whose green channel (what an alphaMap reads) is the cut-out', () => {
        const { json } = readGlbChunks(glb);
        const cards = (json.extras?.sbTrees as TreesGlbRootExtras).crownCards!;
        const bake = bakeCrownCardAtlas(cards, 512, clayLeafPaint(cards)), mask = crownCardMaskPixels(cards, 512);
        let alpha = 0, bakeGreen = 0, maskGreen = 0;
        for (let i = 0; i < bake.length; i += 4) { alpha += bake[i + 3] >= 128 ? 1 : 0; bakeGreen += bake[i + 1] >= 128 ? 1 : 0; maskGreen += mask[i + 1] >= 128 ? 1 : 0; }
        // the bake fills empty pixels with the leaves' colour (white): used as an alphaMap it was opaque everywhere
        expect(bakeGreen / (bake.length / 4)).toBeGreaterThan(0.99);
        expect(maskGreen).toBe(alpha);
        expect(alpha / (bake.length / 4)).toBeLessThan(0.8);
    });
});
