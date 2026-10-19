/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The trees layer of a staged location build, as tile_vegetation writes it (scratchbox_tile_vegetation.hpp writeTreesGlb
 * on scratchbox_staged_glb.hpp, the growth order from nature::MeshGrowth), compiled with clang++ and run through
 * TileVegetationService on synthetic crowns and a synthetic photo-textured tile:
 *
 * - every vertex carries `_REVEAL` (x the plant rank over max(1, trees - 1), y when it grew: node creation order over
 *   max(1, nodes - 1)): a branch's start ring grew before its end ring, the trunk's root first;
 * - the meshes are the same with and without the growth order (trees-fix's outputs are unchanged);
 * - one tree gives x = 0 and two give 0 and 1, never NaN;
 * - a crown kept as scanned gets an as-scanned LINES ring at its measured footprint and support height;
 * - three's GLTFLoader reads the quantised layer natively: extras, `_reveal`, and positions within the reported error;
 * - strip's region of interest keeps trees outside it as scanned, neither regrown nor removed;
 * - the canopy mask is strip's own classification of the same tile.
 *
 * Screenshots of a tree growing (its triangles whose growth order has passed 0.25, 0.5, 1.0) go to
 * test-results/screenshots/staged/ (gitignored).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { decodeCanopyMask, TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { validateContract, type StripRoi } from '../src/common/spatial/staged-location-contracts';
import { buildSyntheticTile, type SyntheticTileSpec, type SyntheticTree } from './helpers/synthetic-textured-tile';
import { parseGlb, readAccessor, readGlbTriangles, renderClayPng } from './helpers/clay-glb-render';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const SHOTS = path.join(REPO, 'test-results/screenshots/staged');

type Vec3 = [number, number, number];

function crown(id: number, stem: [number, number], supportY: number, apexY: number, radius: number, status = 'tree') {
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
        id, status, reachesBoundary: false, apex: [stem[0], apexY, stem[1]], stem, supportY, supportSource: 'given', terrainY: supportY,
        apexAboveSupport: apexY - supportY, areaM2: Math.PI * radius * radius, sectorRadii: new Array(16).fill(radius), samples,
        ...(status === 'not_regrowable' ? { regrowth: { reasonCode: 'crown_not_reached', reason: 'the regrown tree reaches 61% of its measured crown surface (test)' } } : {})
    };
}

let work: string;
let svc: TileVegetationService;

function writeCrowns(name: string, crowns: any[]): string {
    fs.writeFileSync(path.join(work, name), JSON.stringify({ version: 1, frame: { frame: 'x = east, y = up, z = south (metres)' }, params: { sampleSpacing: 0.7 }, crowns }));
    return name;
}

/**
 * Per tree node of a trees GLB: its rank-order extras and the _REVEAL values of its wood and its leaf masses. A tree with
 * levels holds its wood in level 0 (shared by levels 1, 2 and 3) and its blob leaf masses in level 3.
 */
function revealOf(file: string): Array<{ node: any; reveal: Float64Array[]; positions: Float64Array[]; instanceReveal: Float64Array[] }> {
    const { json, bin } = parseGlb(fs.readFileSync(file));
    return json.nodes.filter((n: any) => n.extras?.sb?.revealKind === 'grow').map((n: any) => {
        const kids = (n.children ?? []).map((i: number) => json.nodes[i]);
        const l0 = kids.find((k: any) => k.extras?.sbLod?.level === 0), l2 = kids.find((k: any) => k.extras?.sbLod?.level === 3);
        const prims = [json.meshes[l0.mesh].primitives[0], ...json.meshes[l2.mesh].primitives.slice(1)];
        const inst = (l0.children ?? []).map((i: number) => json.nodes[i].extensions.EXT_mesh_gpu_instancing.attributes._REVEAL).filter((a: any) => a !== undefined);
        return {
            node: n,
            reveal: prims.map((p: any) => readAccessor(json, bin, p.attributes._REVEAL).data),
            positions: prims.map((p: any) => readAccessor(json, bin, p.attributes.POSITION).data),
            instanceReveal: inst.map((a: number) => readAccessor(json, bin, a).data)
        };
    });
}

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tile-growth-order-')));
    svc = new TileVegetationService({ workspaceRoot: work, repoRoot: REPO });
    await svc.ensureBinary();
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('the trees layer carries its real growth order', () => {
    const CROWNS = [crown(0, [0, 0], 0, 12, 4), crown(1, [14, 3], 0.4, 9, 3), crown(2, [-12, 8], -0.2, 15, 5)];

    it('_REVEAL.y follows node creation: every branch segment starts before it ends, and the trunk root comes first', async () => {
        const planted = await svc.plant({ crownsPath: writeCrowns('three.json', CROWNS), triangleBudget: 9000, seed: 'abc', quantize: false });
        const trees = revealOf(planted.treesGlb);
        expect(trees).toHaveLength(3);
        trees.forEach(({ node, reveal, instanceReveal }, rank) => {
            expect(node.extras.sb.buildOrder).toBe(rank);
            expect(node.extras.sb.reveal).toEqual({ attribute: '_REVEAL', displacement: null, durationShare: 1 });
            expect(validateContract('StagedNodeExtras', node.extras)).toEqual([]);
            const [wood, foliage] = reveal;
            for (const r of reveal) {
                for (let v = 0; v < r.length; v += 2) {
                    expect(Number.isFinite(r[v]) && Number.isFinite(r[v + 1])).toBe(true);
                    expect(Math.abs(r[v] - rank / 2)).toBeLessThanOrEqual(1 / 65535);
                }
            }
            // wood: a branch cylinder's vertices alternate start ring, end ring (4 per quad pair)
            let segs = 0, first = Infinity, last = 0;
            for (let v = 0; v + 3 < wood.length; v += 4) {
                expect(wood[v + 1]).toBeLessThanOrEqual(wood[v + 3] + 1e-9);
                first = Math.min(first, wood[v + 1]);
                last = Math.max(last, wood[v + 3]);
                segs++;
            }
            expect(segs).toBeGreaterThan(20);
            expect(first).toBe(0);
            expect(last).toBeGreaterThan(0.5);
            // leaf masses appear once the leaf nodes they hold have grown: never before the trunk's first steps
            let foliageMin = Infinity;
            for (let v = 1; v < foliage.length; v += 2) foliageMin = Math.min(foliageMin, foliage[v]);
            expect(foliageMin).toBeGreaterThan(0);
            // the instances carry it too: x the plant rank, y the growth order of the skeleton node they hang from
            expect(instanceReveal.length).toBeGreaterThan(1);
            for (const r of instanceReveal) {
                expect(r.length).toBeGreaterThan(0);
                for (let v = 0; v < r.length; v += 2) {
                    expect(Math.abs(r[v] - rank / 2)).toBeLessThanOrEqual(1 / 65535);
                    expect(r[v + 1]).toBeGreaterThanOrEqual(0);
                    expect(r[v + 1]).toBeLessThanOrEqual(1);
                }
            }
        });
        // the tree drawn at three moments of its growth (triangles whose every vertex has grown)
        fs.mkdirSync(SHOTS, { recursive: true });
        const tris = readGlbTriangles(fs.readFileSync(planted.treesGlb));
        const allReveal: number[] = [];
        for (const t of trees) for (const r of t.reveal) for (let v = 1; v < r.length; v += 2) allReveal.push(r[v]);
        const covered: number[] = [];
        for (const p of [0.25, 0.5, 1.0]) {
            const idx: number[] = [];
            for (let i = 0; i < tris.indices.length; i += 3) {
                if ([0, 1, 2].every(j => allReveal[tris.indices[i + j]] <= p)) idx.push(tris.indices[i], tris.indices[i + 1], tris.indices[i + 2]);
            }
            covered.push(idx.length);
            const png = renderClayPng([{ positions: tris.positions, indices: Uint32Array.from(idx), color: [0.45, 0.55, 0.45] }], { kind: 'aerial', width: 900, height: 700, region: [-20, -8, 20, 14], bearingDeg: 180, elevationDeg: 12 });
            fs.writeFileSync(path.join(SHOTS, `tree_growth_order_${Math.round(p * 100)}.png`), png);
            expect(png.readUInt32BE(0)).toBe(0x89504e47);
        }
        expect(covered[0]).toBeGreaterThan(0);
        expect(covered[0]).toBeLessThan(covered[1]);
        expect(covered[1]).toBeLessThan(covered[2]);
        expect(covered[2]).toBe(tris.indices.length);
    }, 300_000);

    it('grows the same meshes with and without the growth order', async () => {
        const withOrder = await svc.plant({ crownsPath: writeCrowns('same.json', CROWNS), triangleBudget: 9000, seed: '5eed', quantize: false });
        const without = await svc.plant({ crownsPath: writeCrowns('same.json', CROWNS), triangleBudget: 9000, seed: '5eed', quantize: false, reveal: false });
        const a = parseGlb(fs.readFileSync(withOrder.treesGlb)), b = parseGlb(fs.readFileSync(without.treesGlb));
        const meshesA = a.json.nodes.filter((n: any) => n.mesh !== undefined && n.extras?.sbLod), meshesB = b.json.nodes.filter((n: any) => n.mesh !== undefined && n.extras?.sbLod);
        expect(meshesA.length).toBe(meshesB.length);
        for (let k = 0; k < meshesA.length; k++) {
            const pa = a.json.meshes[meshesA[k].mesh].primitives, pb = b.json.meshes[meshesB[k].mesh].primitives;
            expect(pa.length).toBe(pb.length);
            for (let j = 0; j < pa.length; j++) {
                for (const attr of ['POSITION', 'NORMAL']) expect(Array.from(readAccessor(a.json, a.bin, pa[j].attributes[attr]).data)).toEqual(Array.from(readAccessor(b.json, b.bin, pb[j].attributes[attr]).data));
                expect(Array.from(readAccessor(a.json, a.bin, pa[j].indices).data)).toEqual(Array.from(readAccessor(b.json, b.bin, pb[j].indices).data));
                expect(pb[j].attributes._REVEAL).toBeUndefined();
            }
        }
        for (const t of b.json.nodes.filter((n: any) => n.extras?.sb?.revealKind === 'grow')) expect(t.extras.sb.reveal.attribute).toBeNull();
        expect(without.stats.triangles).toBe(withOrder.stats.triangles);
    }, 300_000);

    it('orders one tree at 0 and two at 0 and 1, never NaN', async () => {
        const one = revealOf((await svc.plant({ crownsPath: writeCrowns('one.json', [CROWNS[0]]), triangleBudget: 3000, seed: '1' })).treesGlb);
        expect(one).toHaveLength(1);
        for (const r of [...one[0].reveal, ...one[0].instanceReveal]) for (let v = 0; v < r.length; v += 2) expect(r[v]).toBe(0);
        expect(one[0].node.extras.sb).toMatchObject({ buildOrder: 0, buildCount: 1 });
        const two = revealOf((await svc.plant({ crownsPath: writeCrowns('two.json', CROWNS.slice(0, 2)), triangleBudget: 6000, seed: '1' })).treesGlb);
        expect(two.map(t => t.reveal[0][0])).toEqual([0, 1]);
    }, 300_000);

    it('outlines each crown kept as scanned with an as-scanned ring at its measured footprint and support', async () => {
        const kept = crown(7, [30, -10], 1.2, 11, 3.5, 'not_regrowable');
        const planted = await svc.plant({ crownsPath: writeCrowns('kept.json', [CROWNS[0], kept]), triangleBudget: 3000, seed: '2' });
        const { json, bin } = parseGlb(fs.readFileSync(planted.treesGlb));
        const ring = json.nodes.find((n: any) => n.extras?.crownId === 7);
        expect(ring.extras.keptAsScanned).toBe(true);
        expect(validateContract('StagedNodeExtras', ring.extras)).toEqual([]);
        expect(ring.extras.sb.provenance.label).toBe('as-scanned');
        expect(ring.extras.sb.provenance.note).toContain('61% of its measured crown surface');
        expect(ring.extras.sb.counts).toEqual({ vertices: 16, triangles: 0, lines: 16 });
        const prim = json.meshes[ring.mesh].primitives[0];
        expect(prim.mode).toBe(1);
        const [tx, ty, tz] = ring.translation ?? [0, 0, 0];
        const [s] = ring.scale ?? [1];
        const p = readAccessor(json, bin, prim.attributes.POSITION).data;
        for (let v = 0; v < p.length; v += 3) {
            expect(Math.abs(ty + s * p[v + 1] - 1.2)).toBeLessThan(0.002);
            expect(Math.abs(Math.hypot(tx + s * p[v] - 30, tz + s * p[v + 2] + 10) - 3.5)).toBeLessThan(0.002);
        }
        expect(Array.from(readAccessor(json, bin, prim.indices).data)).toHaveLength(32);
        // the planted tree is one; the ring follows it in build order
        expect(planted.stats.glb.keptAsScannedRings).toBe(1);
        expect(ring.extras.sb.buildOrder).toBe(1);
        expect(ring.extras.sb.buildCount).toBe(2);
    }, 300_000);

    it('is read natively by three\'s GLTFLoader: quantised positions, the growth order and the extras', async () => {
        const planted = await svc.plant({ crownsPath: writeCrowns('loader.json', CROWNS), triangleBudget: 9000, seed: 'abc' });
        const bytes = fs.readFileSync(planted.treesGlb);
        const { json } = parseGlb(bytes);
        expect(json.extensionsRequired).toEqual(['KHR_mesh_quantization']);
        expect(planted.stats.glb.quantized).toBe(true);
        expect(planted.stats.glb.positionMaxErrorM).toBeLessThan(0.001);
        expect(planted.stats.glb.bytes).toBe(bytes.length);
        expect(planted.stats.glb.bytes).toBeLessThan(planted.stats.glb.unquantizedBytes);
        const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
        const THREE = await import('three');
        const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const gltf = await new GLTFLoader().parseAsync(ab as ArrayBuffer, '');
        expect(gltf.userData.sb).toMatchObject({ schema: 'scratchbox.staged-glb/2', stage: 'trees' });
        expect(gltf.scene.userData.sb).toMatchObject({ schema: 'scratchbox.staged-glb/2', stage: 'trees' });
        gltf.scene.updateMatrixWorld(true);
        // the blob level (level 3, the far one) of every tree, as the loader gives it, against the unquantised file's
        const plain = readGlbTriangles(fs.readFileSync((await svc.plant({ crownsPath: 'loader.json', triangleBudget: 9000, seed: 'abc', quantize: false })).treesGlb));
        const level2: any[] = [];
        gltf.scene.traverse((o: any) => { if (typeof o.name === 'string' && o.name.endsWith('_lod3')) level2.push(o); });
        expect(level2).toHaveLength(3);
        let worst = 0, offset = 0, meshes = 0, instanced = 0;
        for (const holder of level2) {
            const ms: any[] = [];
            holder.traverse((o: any) => { if (o.isMesh) ms.push(o); });
            for (const o of ms) {
                meshes++;
                const g = o.geometry as InstanceType<typeof THREE.BufferGeometry>;
                expect(g.getAttribute('_reveal')).toBeDefined();
                expect(g.getAttribute('_reveal').itemSize).toBe(2);
                const pos = g.getAttribute('position');
                const v = new THREE.Vector3();
                for (let i = 0; i < pos.count; i++) {
                    v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
                    const k = (offset + i) * 3;
                    worst = Math.max(worst, Math.hypot(v.x - plain.positions[k], v.y - plain.positions[k + 1], v.z - plain.positions[k + 2]));
                }
                offset += pos.count;
            }
        }
        gltf.scene.traverse((o: any) => { if (o.isInstancedMesh) { instanced++; expect(o.count).toBeGreaterThan(0); } });
        expect(meshes).toBe(6);
        expect(instanced).toBeGreaterThan(6);
        expect(worst).toBeLessThan(0.001);
        const parents = new Set<any>();
        gltf.scene.traverse((o: any) => { if (o.userData?.sb?.revealKind === 'grow') parents.add(o.userData.crownId); });
        expect([...parents].sort()).toEqual([0, 1, 2]);
    }, 300_000);
});

describe('strip: region of interest and canopy mask', () => {
    const INSIDE: SyntheticTree[] = [{ x: -12, z: -10, height: 11, radius: 4.5 }, { x: 10, z: 12, height: 8, radius: 3.5 }];
    const OUTSIDE: SyntheticTree = { x: -14, z: 14, height: 14, radius: 5.5 };
    const SPEC: SyntheticTileSpec = { halfSize: 30, spacing: 0.75, trees: [...INSIDE, OUTSIDE], anchor: { lat: 40.7411, lng: -73.9897, ellipsoidalHeightM: -22.5 } };
    // a polygon round the first two trees' stems, leaving the third's out
    const ROI: StripRoi = { schema: 'scratchbox.strip-roi/1', polygon: [[-25, -25], [25, -25], [25, 25], [0, 25], [-5, 5], [-25, 5]] };

    it('keeps trees whose stem lies outside the region as scanned: neither regrown nor removed', async () => {
        fs.writeFileSync(path.join(work, 'roi_tile.glb'), buildSyntheticTile(SPEC));
        const all = await svc.strip({ tilePath: 'roi_tile.glb' });
        const roi = await svc.strip({ tilePath: 'roi_tile.glb', roi: ROI });
        const crownsAll = JSON.parse(fs.readFileSync(all.crownsJson, 'utf8')).crowns.filter((c: any) => c.status === 'tree');
        const crownsRoi = JSON.parse(fs.readFileSync(roi.crownsJson, 'utf8')).crowns;
        expect(crownsAll).toHaveLength(3);
        const outside = crownsRoi.filter((c: any) => c.status === 'outside_roi');
        expect(outside).toHaveLength(1);
        expect(Math.hypot(outside[0].stem[0] - OUTSIDE.x, outside[0].stem[1] - OUTSIDE.z)).toBeLessThan(1);
        expect(outside[0].regrowth).toBeUndefined();
        expect(crownsRoi.filter((c: any) => c.status === 'tree')).toHaveLength(2);
        expect(roi.stats.crowns.outsideRoi).toBe(1);
        expect(roi.stats.crowns.tree).toBe(2);
        // its scan is untouched; the trees inside were removed as without a region
        const near = (file: string, t: SyntheticTree) => {
            const g = readGlbTriangles(fs.readFileSync(file));
            let n = 0;
            for (let i = 0; i < g.indices.length; i += 3) {
                let cx = 0, cy = 0, cz = 0;
                for (let j = 0; j < 3; j++) { const v = g.indices[i + j]; cx += g.positions[v * 3] / 3; cy += g.positions[v * 3 + 1] / 3; cz += g.positions[v * 3 + 2] / 3; }
                if (Math.hypot(cx - t.x, cz - t.z) <= t.radius && cy > 2) n++;
            }
            return n;
        };
        const raw = path.join(work, 'roi_tile.glb');
        expect(near(roi.devegetatedGlb, OUTSIDE)).toBe(near(raw, OUTSIDE));
        expect(near(all.devegetatedGlb, OUTSIDE)).toBe(0);
        for (const t of INSIDE) expect(near(roi.devegetatedGlb, t)).toBe(0);
        await expect(svc.strip({ tilePath: 'roi_tile.glb', roi: { schema: 'scratchbox.strip-roi/1', polygon: [[0, 0], [1, 1]] } as StripRoi })).rejects.toThrow(/StripRoi/);
        // what the removal took, as scanned, one node per crown: what a failed tree stage puts back
        const removed = parseGlb(fs.readFileSync(all.removedTreesGlb));
        const removedNodes = removed.json.nodes.filter((n: any) => n.extras?.sb);
        expect(removedNodes.length).toBe(crownsAll.length);
        let removedTris = 0;
        for (const n of removedNodes) {
            expect(validateContract('StagedNodeExtras', n.extras)).toEqual([]);
            expect(n.extras.sb.provenance.label).toBe('as-scanned');
            removedTris += n.extras.sb.counts.triangles;
        }
        expect(removedTris).toBe(all.stats.triangles.removed);
        expect(validateContract('StagedGlbRootExtras', removed.json.extras)).toEqual([]);
        const back = readGlbTriangles(fs.readFileSync(all.removedTreesGlb));
        expect(back.indices.length / 3).toBe(all.stats.triangles.removed);
        // put back over the devegetated tile, the outside tree's scan is there again
        expect(near(all.removedTreesGlb, OUTSIDE)).toBe(near(raw, OUTSIDE));
    }, 600_000);

    it('masks the canopy strip itself classifies, without regrowing or removing anything', async () => {
        const strip = await svc.strip({ tilePath: 'roi_tile.glb' });
        const canopy = await svc.canopy({ tilePath: 'roi_tile.glb' });
        expect(validateContract('CanopyMask', canopy.mask)).toEqual([]);
        const cells = decodeCanopyMask(canopy.mask);
        let n = 0;
        for (const c of cells) n += c;
        expect(n).toBe(canopy.mask.canopyCells);
        // the same classification: the canopy area strip reports is these cells
        expect(canopy.mask.canopyCells * canopy.mask.cellM ** 2).toBeCloseTo(strip.stats.canopyAreaM2, 6);
        // every measured crown surface sample lies on a canopy cell
        const crowns = JSON.parse(fs.readFileSync(strip.crownsJson, 'utf8')).crowns;
        let samples = 0, onCanopy = 0;
        for (const c of crowns) {
            for (const s of c.samples) {
                const i = Math.floor((s[0] - canopy.mask.x0) / canopy.mask.cellM), k = Math.floor((s[2] - canopy.mask.z0) / canopy.mask.cellM);
                samples++;
                onCanopy += cells[k * canopy.mask.nx + i];
            }
        }
        expect(samples).toBeGreaterThan(50);
        expect(onCanopy / samples).toBeGreaterThan(0.97);
        // no tree was regrown or removed for it: its cache entry holds the mask alone
        expect(fs.readdirSync(path.join(svc.cacheDir, canopy.cacheKey)).sort()).toEqual(['canopy.json', 'done.json']);
        // a top-down picture of the mask
        const W = canopy.mask.nx, H = canopy.mask.nz, px = Buffer.alloc(W * H * 4);
        for (let c = 0; c < W * H; c++) { const on = cells[c]; px[c * 4] = on ? 60 : 200; px[c * 4 + 1] = on ? 140 : 200; px[c * 4 + 2] = on ? 60 : 200; px[c * 4 + 3] = 255; }
        const { encodePng } = await import('../src/node/texture-processing');
        fs.mkdirSync(SHOTS, { recursive: true });
        fs.writeFileSync(path.join(SHOTS, 'canopy_mask_synthetic.png'), encodePng(W, H, px));
    }, 600_000);
});
