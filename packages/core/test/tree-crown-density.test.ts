/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Crown density (scratchbox_tree_lod.hpp, treeCrownShading.ts, treeTextureMaterials.ts):
 *
 * - the projected-coverage measure on synthetic crowns of known cover: a closed shell covers the whole silhouette from
 *   every view, an upper half covers it from above and about half from the side, nothing covers nothing, and a cut-out
 *   card covers its leaf's share of the card;
 * - the season cue: a summer crown (green share 1) is filled toward its target and its mid levels reach most of it; a
 *   leafless cue (green share near 0) keeps the crown bare or sparse, with no fill;
 * - the inner-crown darkening in the leaf shader's chunk, in the crown variant's program and in its dither (fade) variants;
 * - clay mode keeps one grey for the wood and the leaves (the darkening multiplies the leaves' diffuse colour in the shader,
 *   never the material).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as THREE from 'three';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import {
    CROWN_VERTEX_MAIN, CROWN_VERTEX_PARS, DEFAULT_CROWN_SHADING, crownShadingUniforms, makeCrownVariant, resolveCrownShading, setCrownShadingUniforms
} from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeCrownShading';
import { makeFadeVariant } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeLodFade';
import { DEFAULT_TREE_TEXTURE_OPTIONS, LEAF_FRAGMENT_ALPHA, LEAF_VERTEX_MAIN, TREE_CARD_ATTRIBUTE } from '../src/browser/generative-canvas/primitives/scene3d/treeLod/treeTextureMaterials';
import { applyClayRenderMode, sharedTreeClayMaterial } from '../src/browser/generative-canvas/primitives/scene3d/clayRenderMode';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const INCLUDE = path.join(REPO, 'packages/core/src/native/3d-engine/include');
const SHOTS = path.join(REPO, 'test-results/screenshots/tree_density');

function compileProbe(name: string, source: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sb-${name}-`));
    const src = path.join(dir, 'probe.cpp'), bin = path.join(dir, 'probe');
    fs.writeFileSync(src, source);
    const r = spawnSync(process.env.CXX || 'clang++', ['-std=c++20', '-O2', '-I' + INCLUDE, src, '-o', bin], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return bin;
}

describe('projected coverage (tree_lod::detail::CoverageViews)', () => {
    it('measures known covers on a synthetic crown: a closed shell, an upper half, nothing, a cut-out card', () => {
        // a unit-radius crown at (0, 5, 0); leaves are a lat-long sphere of radius 1.05 (the shell) or its upper half; the
        // probe also writes each view of the half shell as a PGM so the measure can be looked at
        const bin = compileProbe('coverage', `#include "scratchbox_tree_lod.hpp"
#include <cstdio>
using namespace scratchbox; using namespace scratchbox::tree_lod; using math::Vec3; using math::Vec2;
static LibraryMesh sphere(double r, bool upperOnly) {
  LibraryMesh m; const int U = 48, V = 24;
  for (int j = 0; j <= V; ++j) for (int i = 0; i <= U; ++i) {
    const double th = M_PI * j / V, ph = 2 * M_PI * i / U;
    m.bladePos.push_back(Vec3(float(r * std::sin(th) * std::cos(ph)), float(r * std::cos(th)), float(r * std::sin(th) * std::sin(ph))));
    m.bladeUv.push_back(Vec2(0.5f, 0.5f)); }
  for (int j = 0; j < V; ++j) for (int i = 0; i < U; ++i) {
    if (upperOnly && j >= V / 2) continue;
    const uint32_t a = j * (U + 1) + i, b = a + 1, c = a + U + 1, d = c + 1;
    m.bladeTri.insert(m.bladeTri.end(), {a, c, b, b, c, d}); }
  return m; }
int main(int argc, char** argv) {
  CrownEllipsoid ref; ref.centre = Vec3(0, 5, 0); ref.radii = {1, 1, 1}; ref.points = 1;
  std::vector<Vec3> hull; for (int k = 0; k < 64; ++k) { const double a = 2 * M_PI * k / 64; hull.push_back(Vec3(float(std::cos(a)), 5.0f + float(std::sin(a)), 0)); hull.push_back(Vec3(0, 5.0f + float(std::sin(a)), float(std::cos(a)))); }
  Instance in; in.t = Vec3(0, 5, 0); in.s = Vec3(1, 1, 1);
  auto run = [&](const LibraryMesh* m, const detail::CoverageViews::Cutout* cut, const char* dump) {
    detail::CoverageViews cv; cv.init(ref, hull, 0.01); if (m) cv.add(*m, in, cut);
    std::printf("%zu", cv.views.size());
    for (size_t k = 0; k < cv.views.size(); ++k) { const auto& v = cv.views[k];
      std::printf(" %.4f", v.nEll ? double(v.covEll) / double(v.nEll) : -1.0);
      if (dump) { std::string fn = std::string(dump) + "_v" + std::to_string(k) + ".pgm"; FILE* f = std::fopen(fn.c_str(), "wb");
        std::fprintf(f, "P5 %d %d 255\\n", v.w, v.h);
        for (int j = v.h - 1; j >= 0; --j) for (int i = 0; i < v.w; ++i) { const size_t at = size_t(j) * v.w + i; std::fputc(v.covered[at] ? (v.ell[at] ? 255 : 150) : (v.ell[at] ? 70 : 0), f); }
        std::fclose(f); } }
    const auto L = cv.level(); std::printf(" | %.4f %.4f %.4f\\n", L.meanEllipsoid, L.minEllipsoid, L.meanHull); };
  const LibraryMesh shell = sphere(1.05, false), half = sphere(1.05, true);
  run(&shell, nullptr, nullptr); run(&half, nullptr, argc > 1 ? argv[1] : nullptr); run(nullptr, nullptr, nullptr);
  // a cut-out card: one horizontal square card (blade coordinates over its whole box), seen from above (the last view)
  LibraryMesh card; const float s = 4.0f;
  card.bladePos = {Vec3(-s, 0, -s), Vec3(s, 0, -s), Vec3(s, 0, s), Vec3(-s, 0, s)};
  card.bladeUv = {Vec2(0, 0), Vec2(1, 0), Vec2(1, 1), Vec2(0, 1)};
  card.bladeTri = {0, 1, 2, 0, 2, 3};
  detail::CoverageViews::Cutout cut; cut.cv = 0.5; cut.hu = 0.5; cut.hv = 0.5; cut.r2 = 0.6 / (M_PI / 4.0);
  ref.radii = {6, 6, 6};
  { detail::CoverageViews cv; cv.init(ref, hull, 0.02); cv.add(card, in, &cut);
    detail::CoverageViews cs; cs.init(ref, hull, 0.02); cs.add(card, in, nullptr);
    std::printf("cut %zu %zu\\n", cv.views[8].covEll, cs.views[8].covEll); }
  std::printf("season %.4f %.4f %.4f %.4f %.4f\\n", seasonLeafiness(LodParams{}, 1.0, 100, 0.5), seasonLeafiness(LodParams{}, 0.0, 30, 0.4),
              seasonLeafiness(LodParams{}, std::nan(""), 100, 0.4), seasonLeafiness(LodParams{}, std::nan(""), 25, 0.4), seasonLeafiness(LodParams{}, std::nan(""), 0, 0));
  std::printf("target %.4f %.4f %.4f\\n", coverageTarget(LodParams{}, 1.0), coverageTarget(LodParams{}, 0.5), coverageTarget(LodParams{}, 0.0));
}`);
        fs.mkdirSync(SHOTS, { recursive: true });
        const out = spawnSync(bin, [path.join(SHOTS, 'measure_half_shell')], { encoding: 'utf8' });
        expect(out.status, out.stderr).toBe(0);
        const lines = out.stdout.trim().split('\n');
        const parse = (l: string) => { const [views, rest] = l.split(' | '); const v = views.split(' ').map(Number); return { n: v[0], per: v.slice(1), mean: Number(rest.split(' ')[0]), min: Number(rest.split(' ')[1]) }; };
        const shell = parse(lines[0]), half = parse(lines[1]), none = parse(lines[2]);
        expect(shell.n).toBe(9);
        // a closed shell around the crown hides it from every side
        expect(shell.min).toBeGreaterThan(0.99);
        // the upper half: the top view (the last) sees it all, views near the horizon (the first five) about half
        expect(half.per[8]).toBeGreaterThan(0.99);
        for (const s of half.per.slice(0, 5)) { expect(s).toBeGreaterThan(0.45); expect(s).toBeLessThan(0.65); }
        expect(none.mean).toBe(0);
        // the cut-out card (an ellipse filling 0.6 of the box) covers 0.6 of what the solid card covers, seen from above
        const [, cutCov, solidCov] = lines[3].split(' ').map(Number);
        expect(cutCov / solidCov).toBeGreaterThan(0.57); expect(cutCov / solidCov).toBeLessThan(0.63);
        // the season cue: green share decides when judged; else a green hue and chroma; unknown colour is full leaf
        const season = lines[4].split(' ').slice(1).map(Number);
        expect(season[0]).toBe(1); expect(season[1]).toBe(0);
        expect(season[2]).toBe(1); expect(season[3]).toBe(0); expect(season[4]).toBe(1);
        // the target: about 0.9 at full leaf, less at half, none bare
        const [t1, tHalf, t0] = lines[5].split(' ').slice(1).map(Number);
        expect(t1).toBeGreaterThan(0.88); expect(t1).toBeLessThan(0.92);
        expect(tHalf).toBeGreaterThan(0.5); expect(tHalf).toBeLessThan(t1);
        expect(t0).toBe(0);
        expect(fs.existsSync(path.join(SHOTS, 'measure_half_shell_v0.pgm'))).toBe(true);
    }, 120_000);

    it('counts every drawn triangle: a plain mesh solid, a library mesh\'s blades cut out and its petioles not', () => {
        const bin = compileProbe('coverage-drawn', `#include "scratchbox_tree_lod.hpp"
#include <cstdio>
using namespace scratchbox; using namespace scratchbox::tree_lod; using math::Vec3; using math::Vec2;
int main() {
  CrownEllipsoid ref; ref.centre = Vec3(0, 5, 0); ref.radii = {1, 1, 1}; ref.points = 1;
  std::vector<Vec3> hull; for (int k = 0; k < 64; ++k) { const double a = 2 * M_PI * k / 64; hull.push_back(Vec3(float(std::cos(a)), 5.0f + float(std::sin(a)), 0)); hull.push_back(Vec3(0, 5.0f + float(std::sin(a)), float(std::cos(a)))); }
  // a closed lat-long shell of radius 1.05 around the crown, as a plain mesh (a level's wood, the far level's masses)
  geometry::Mesh shell; const int U = 48, V = 24;
  for (int j = 0; j <= V; ++j) for (int i = 0; i <= U; ++i) { const double th = M_PI * j / V, ph = 2 * M_PI * i / U;
    shell.vertices.push_back(Vec3(float(1.05 * std::sin(th) * std::cos(ph)), 5.0f + float(1.05 * std::cos(th)), float(1.05 * std::sin(th) * std::sin(ph)))); }
  for (int j = 0; j < V; ++j) for (int i = 0; i < U; ++i) { const uint32_t a = j * (U + 1) + i, b = a + 1, c = a + U + 1, d = c + 1; shell.indices.insert(shell.indices.end(), {a, c, b, b, c, d}); }
  { detail::CoverageViews cv; cv.init(ref, hull, 0.01); cv.addMesh(shell); const auto L = cv.level(); std::printf("shell %.4f %.4f\\n", L.meanEllipsoid, L.minEllipsoid); }
  // one horizontal card as a library mesh, flagged as a blade (leaf 1) or as a petiole (leaf 0), seen from above
  auto card = [](float flag) { LibraryMesh m; const float s = 4.0f;
    m.positions = {Vec3(-s, 0, -s), Vec3(s, 0, -s), Vec3(s, 0, s), Vec3(-s, 0, s)};
    m.uvs = {Vec2(0, 0), Vec2(1, 0), Vec2(1, 1), Vec2(0, 1)};
    m.leaf = {{0.5f, flag}, {0.5f, flag}, {0.5f, flag}, {0.5f, flag}};
    m.indices = {0, 1, 2, 0, 2, 3}; return m; };
  detail::CoverageViews::Cutout cut; cut.cv = 0.5; cut.hu = 0.5; cut.hv = 0.5; cut.r2 = 0.6 / (M_PI / 4.0);
  ref.radii = {6, 6, 6};
  Instance in; in.t = Vec3(0, 5, 0); in.s = Vec3(1, 1, 1);
  auto top = [&](const LibraryMesh& m, const detail::CoverageViews::Cutout* c) { detail::CoverageViews cv; cv.init(ref, hull, 0.02); cv.addWhole(m, in, c); return cv.views[8].covEll; };
  std::printf("cards %zu %zu %zu\\n", top(card(1.0f), nullptr), top(card(1.0f), &cut), top(card(0.0f), &cut));
}`);
        const out = spawnSync(bin, [], { encoding: 'utf8' });
        expect(out.status, out.stderr).toBe(0);
        const lines = out.stdout.trim().split('\n');
        const [, mean, min] = lines[0].split(' ').map(Number);
        // a closed plain mesh around the crown hides it from every side
        expect(mean).toBeGreaterThan(0.99); expect(min).toBeGreaterThan(0.99);
        const [, solid, blade, petiole] = lines[1].split(' ').map(Number);
        expect(solid).toBeGreaterThan(0);
        // a blade is cut out as the leaf texture cuts it (the ellipse fills 0.6 of the card); a petiole or sub-shoot is solid
        expect(blade / solid).toBeGreaterThan(0.57); expect(blade / solid).toBeLessThan(0.63);
        expect(petiole).toBe(solid);
    }, 120_000);
});

describe('crown fill by season (TileVegetationService.plant)', () => {
    let work: string;
    let svc: TileVegetationService;
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
    const plant = async (name: string, greenShare: number) => {
        const crowns = [crown(0, [0, 0], 0, 14, 4.5, greenShare), crown(1, [16, 3], 0.4, 14, 4.5, greenShare), crown(2, [4, -16], 0, 22, 6, greenShare)];
        fs.writeFileSync(path.join(work, name), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 }, crowns }));
        return svc.plant({ crownsPath: name, triangleBudget: 14000, seed: 'abc' });
    };
    beforeAll(async () => {
        work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-density-')));
        svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
        await svc.ensureBinary();
    }, 900_000);
    afterAll(() => { if (work) fs.rmSync(work, { recursive: true, force: true }); });

    it('fills a summer crown toward its target and keeps a leafless cue sparse', async () => {
        const summer = await plant('summer.json', 1.0), sparse = await plant('sparse.json', 0.15), bare = await plant('bare.json', 0.0);
        for (const t of summer.stats.perTree) {
            const c = t.lod.coverage;
            expect(c.measured).toBe(true);
            expect(c.leafiness).toBe(1);
            expect(c.target).toBeGreaterThan(0.88);
            // the fill adds stations on the shell and raises the near level's cover
            expect(c.fillStations).toBeGreaterThan(0);
            expect(c.level0.mean).toBeGreaterThan(c.level0Before.mean + 0.15);
            // the mid distances (the near-mid and mid cards) approach the target
            expect(c.nearMid.mean).toBeGreaterThan(0.75);
            expect(c.mid.mean).toBeGreaterThan(0.85);
            expect(c.mid.mean).toBeLessThanOrEqual(1);
            expect(c.views).toBe(9);
            // what each level draws (wood, twigs, petioles and sub-shoots too) covers at least what its blades alone do,
            // and the far level's trunk, limbs and leaf masses are measured
            const d = c.drawn;
            expect(d.level0.mean).toBeGreaterThanOrEqual(c.level0.mean);
            expect(d.nearMid.mean).toBeGreaterThanOrEqual(c.nearMid.mean);
            expect(d.mid.mean).toBeGreaterThanOrEqual(c.mid.mean);
            expect(d.far.mean).toBeGreaterThan(0.3);
            for (const k of ['level0', 'nearMid', 'mid', 'far']) expect(d[k].mean).toBeLessThanOrEqual(1);
        }
        const leaves = (p: typeof summer) => p.stats.perTree.reduce((n: number, t: any) => n + t.lod.level0.leaves, 0);
        for (const t of sparse.stats.perTree) {
            const c = t.lod.coverage;
            expect(c.leafiness).toBeGreaterThan(0); expect(c.leafiness).toBeLessThan(0.5);
            expect(c.target).toBeLessThan(0.6);
            expect(c.level0.mean).toBeLessThan(0.45);
        }
        expect(leaves(sparse)).toBeLessThan(0.45 * leaves(summer));
        for (const t of bare.stats.perTree) {
            expect(t.lod.coverage.leafiness).toBe(0);
            expect(t.lod.coverage.target).toBe(0);
            expect(t.lod.coverage.fillStations).toBe(0);
            expect(t.lod.coverage.level0.mean).toBe(0);
        }
        expect(leaves(bare)).toBe(0);
    }, 900_000);
});

describe('inner-crown darkening and textured cards (shader chunks)', () => {
    it('darkens toward the crown ellipsoid\'s core in the crown chunk, with the strength a uniform', () => {
        expect(CROWN_VERTEX_PARS).toContain('uniform vec2 uSbCrownInner;');
        expect(CROWN_VERTEX_MAIN).toMatch(/sbInnerM = clamp\( 1\.0 - sqrt\(/);
        expect(CROWN_VERTEX_MAIN).toContain('vSbCrownOcc *= 1.0 - uSbCrownInner.x * ( 1.0 - exp( - sbInnerM / max( uSbCrownInner.y, 0.05 ) ) );');
        // the darkening is subtle by default and adjustable
        expect(DEFAULT_CROWN_SHADING.innerDarkening).toBeGreaterThan(0); expect(DEFAULT_CROWN_SHADING.innerDarkening).toBeLessThanOrEqual(0.4);
        const o = resolveCrownShading({ innerDarkening: 0.5, innerDepthM: 2 });
        setCrownShadingUniforms(o);
        expect(crownShadingUniforms().uSbCrownInner.value.toArray()).toEqual([0.5, 2]);
        setCrownShadingUniforms(resolveCrownShading(undefined));
        expect(crownShadingUniforms().uSbCrownInner.value.x).toBe(DEFAULT_CROWN_SHADING.innerDarkening);
    });

    it('carries the darkening into the crown variant\'s program and its dither variants, in clay and textured alike', () => {
        const compile = (m: THREE.Material) => {
            const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> } as unknown as THREE.WebGLProgramParametersWithUniforms;
            m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
            return shader;
        };
        const clay = sharedTreeClayMaterial();
        const textured = new THREE.MeshStandardMaterial({ alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide });
        for (const base of [clay, textured]) {
            const crownVariant = makeCrownVariant(base);
            for (const m of [crownVariant, makeFadeVariant(crownVariant, 2, 9, true), makeFadeVariant(crownVariant, 2, 9, false)]) {
                const s = compile(m);
                expect(s.vertexShader).toContain('uSbCrownInner');
                expect(s.vertexShader).toContain('sbInnerM');
                expect((s.uniforms as Record<string, unknown>).uSbCrownInner).toBe(crownShadingUniforms().uSbCrownInner);
            }
        }
    });

    it('keeps one grey for wood and leaves in clay mode', () => {
        const root = new THREE.Group();
        const wood = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x6b4f2a }));
        const leaves = new THREE.InstancedMesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({ color: 0x2f6b2a }), 4);
        root.add(wood, leaves);
        for (const m of [wood, leaves]) { m.userData.sbTreeLodMesh = true; m.userData.sbLodBase = m.material; }
        applyClayRenderMode([root], true);
        expect(wood.userData.sbLodBase).toBe(sharedTreeClayMaterial());
        expect(leaves.userData.sbLodBase).toBe(sharedTreeClayMaterial());
        const greys = new Set<string>();
        for (const m of [wood, leaves]) {
            const base = (m.userData.sbLodBase ?? m.material) as THREE.MeshStandardMaterial;
            greys.add(base.color.getHexString());
            // the crown variant a leaf wears is a clone of that one grey: the darkening is in the shader, not the colour
            greys.add((makeCrownVariant(base) as THREE.MeshStandardMaterial).color.getHexString());
        }
        expect(greys.size).toBe(1);
    });

    it('zooms the textured leaf card and raises its alpha by level, the near level unchanged', () => {
        const o = DEFAULT_TREE_TEXTURE_OPTIONS;
        expect(o.cardZoom[0]).toBe(1); expect(o.alphaGain[0]).toBe(1);
        expect(o.cardZoom[1]).toBeGreaterThan(1); expect(o.cardZoom[2]).toBeGreaterThanOrEqual(o.cardZoom[1]);
        expect(o.alphaGain[2]).toBeGreaterThan(1);
        expect(LEAF_VERTEX_MAIN).toContain(`${TREE_CARD_ATTRIBUTE}.x > 0.0 ? ${TREE_CARD_ATTRIBUTE}.x : 1.0`);
        expect(LEAF_FRAGMENT_ALPHA).toContain('vSbAlphaGain');
    });
});
