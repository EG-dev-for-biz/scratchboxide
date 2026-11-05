/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The material path on an object (material-path/object-materials.ts): each part one class with its own colour and
 * factors as its finish, a photo-textured material read into classes by colour; the sets asked at the object's own tile
 * scale and height cap; each material given its set's maps at real size without its colour changing; the relief placed
 * in each material's atlas and displaced; a weathered part classed by its as-built factors; and object_detail_pass
 * running it as part of an object's recipe. The library is not reached: the sets are the test's own.
 */

import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OBJECT_MATERIAL_PATH_VERSION, runObjectMaterialPath } from '../src/node/3d-engine/material-path/object-materials';
import type { TileScale } from '../src/node/3d-engine/material-path/class-sets';
import type { ClassFinish } from '../src/node/3d-engine/material-path/material-finish';
import type { RegionClass, RegionSet } from '../src/node/3d-engine/material-path/surface-classes';
import { parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { runObjectDetailPass } from '../src/node/3d-engine/object-detail-pass';
import { encodePng } from '../src/node/texture-processing';
import { buildFixtureGlb } from './helpers/uv-rewrap-fixtures';

const TIMEOUT = 900_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'object-material-path-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function box(name: string, size: [number, number, number], center: [number, number, number], material: number, uv = false) {
    const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const positions: number[] = [], normals: number[] = [], indices: number[] = [], uvs: number[] = [];
    for (const n of faces) {
        const a = n.findIndex(v => v !== 0), [b, c] = [0, 1, 2].filter(k => k !== a);
        const base = positions.length / 3;
        for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            const p = [0, 0, 0];
            p[a] = n[a]; p[b] = su; p[c] = sv;
            positions.push(...p.map((v, k) => center[k] + v * size[k] / 2));
            normals.push(...n);
            uvs.push((su + 1) / 2, (sv + 1) / 2);
        }
        const flip = n[a] * (a === 1 ? -1 : 1) < 0;
        indices.push(...(flip ? [base, base + 2, base + 1, base, base + 3, base + 2] : [base, base + 1, base + 2, base, base + 2, base + 3]));
    }
    return { positions, normals, indices, material, name, ...(uv ? { uvs: [uvs] } : {}) };
}

/** The test's library: one set a class, grooved every 0.25 m; the odd classes with a height. */
function testSets(seen: { classes?: RegionClass[]; tile?: TileScale; cap?: number; finishes?: Array<ClassFinish | undefined> }) {
    return async (classes: RegionClass[], tile: TileScale, o: { heightCapM: number; finish: () => Promise<Array<ClassFinish | undefined>> }): Promise<RegionSet[]> => {
        seen.classes = classes; seen.tile = tile; seen.cap = o.heightCapM; seen.finishes = await o.finish();
        const S = 64;
        return classes.map((c, k) => {
            const orm = { width: S, height: S, rgba: new Uint8Array(S * S * 4) }, normal = { width: S, height: S, rgba: new Uint8Array(S * S * 4) }, height = { width: S, height: S, rgba: new Uint8Array(S * S * 4) };
            for (let i = 0; i < S * S; i++) {
                const groove = i % S < 8;
                orm.rgba.set([groove ? 120 : 255, 100 + k * 40, k * 60, 255], i * 4);
                normal.rgba.set([128, 128, 255, 255], i * 4);
                const v = groove ? 0 : 255;
                height.rgba.set([v, v, v, 255], i * 4);
            }
            return { name: `TestSet${c.index}`, realSizeM: [0.25, 0.25], distance: k, normal, orm, ...(k % 2 ? { height, heightDrawn: { depthM: 0.01, source: 'test', relief: 1, maxRecessM: o.heightCapM, meanRecessM: o.heightCapM / 8, label: 'generated' as const } } : {}) };
        });
    };
}

const twoParts = () => buildFixtureGlb({
    primitives: [box('body', [0.6, 0.6, 0.6], [0, 0.7, 0], 0), box('base', [1, 0.1, 1], [0, 0.05, 0], 1)],
    materials: [
        { name: 'gold_foil', pbrMetallicRoughness: { baseColorFactor: [0.9, 0.55, 0.12, 1], roughnessFactor: 0.3, metallicFactor: 1 } },
        { name: 'white_paint', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.78, 1], roughnessFactor: 0.6, metallicFactor: 0 } }
    ]
});

describe('the material path on an object', () => {
    it('gives each part its class\'s set at the object\'s scale, keeps its colour, and places and displaces its relief', async () => {
        const seen: Parameters<typeof testSets>[0] = {};
        const { glb, report } = await runObjectMaterialPath(twoParts(), { resolveSets: testSets(seen) }, undefined);
        // one class a part, with the part's colour and its own factors as the finish
        expect(seen.classes!.length).toBe(2);
        expect(report.classes.map(c => [c.from, c.material])).toEqual([['part', 'gold_foil'], ['part', 'white_paint']]);
        expect(seen.finishes).toEqual([{ roughness: 0.3, metalness: 1, conf: 100, seen: 'the part\'s own material factors' }, { roughness: 0.6, metalness: 0, conf: 100, seen: 'the part\'s own material factors' }]);
        expect(seen.classes![0].meanLinear[0]).toBeCloseTo(0.9, 1);
        expect(seen.classes![1].openings).toBe(false);
        expect(seen.classes!.reduce((a, c) => a + c.share, 0)).toBeCloseTo(1, 2);
        // the tile scale and the height cap come from the object's size (about 1.6 m across)
        const diag = Math.hypot(...report.objectSizeM);
        expect(seen.tile).toEqual({ wantM: diag / 2, maxM: Math.min(8, 4 * diag) });
        expect(seen.cap).toBeCloseTo(0.01 * diag, 6);
        expect(seen.cap!).toBeLessThan(0.03);
        const g = parseGlbBytes(new Uint8Array(glb)), json: any = g.json;
        const mats = ['gold_foil', 'white_paint'].map(n => json.materials.find((m: any) => m.name === n));
        for (const m of mats) {
            // the colour untouched; the set's maps in the material's own slots; what it had kept on record
            expect(m.pbrMetallicRoughness.baseColorTexture).toBeUndefined();
            expect(m.pbrMetallicRoughness.metallicRoughnessTexture).toBeDefined();
            expect(m.normalTexture).toBeDefined();
            expect(m.occlusionTexture.index).toBe(m.pbrMetallicRoughness.metallicRoughnessTexture.index);
            expect([m.pbrMetallicRoughness.roughnessFactor, m.pbrMetallicRoughness.metallicFactor]).toEqual([1, 1]);
            expect(m.extras.sbMaterialPath).toMatchObject({ label: 'generated', version: OBJECT_MATERIAL_PATH_VERSION });
        }
        expect(mats[0].pbrMetallicRoughness.baseColorFactor).toEqual([0.9, 0.55, 0.12, 1]);
        expect(mats[0].extras.sbMaterialPath.before).toMatchObject({ roughnessFactor: 0.3, metallicFactor: 1 });
        // the set tiled at its real size: the groove every 0.25 m shows in the occlusion channel
        const img = (t: number) => { const bv = json.bufferViews[json.images[json.textures[t].source].bufferView]; return decodeImageInMemory(g.bin.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength)); };
        const orm = img(mats[1].pbrMetallicRoughness.metallicRoughnessTexture.index);
        const period = Math.round(0.25 / report.texelM);
        let dark = 0, light = 0;
        for (let x = 0; x < orm.width; x++) { if (orm.rgba[(10 * orm.width + x) * 4] < 200) dark++; else light++; }
        expect(dark).toBeGreaterThan(0);
        expect(light).toBeGreaterThan(dark);
        expect(period).toBeGreaterThan(4);
        // the relief: only the class with a height (the base) carries it, in its atlas's metric frame
        expect(mats[0].extras.sbRelief).toBeUndefined();
        const relief = mats[1].extras.sbRelief;
        expect(relief.uvMetres[0]).toBeCloseTo(orm.width * report.texelM, 1);
        const asset = json.asset.extras.sbMaterialRelief;
        expect(asset.depthM).toBeCloseTo(seen.cap!, 6);
        expect(asset.tiles.map((t: unknown) => !!t)).toEqual([false, true]);
        expect(json.asset.extras.sbMaterialPath.classes.length).toBe(2);
        // and displaced over the whole part, inward, as child nodes of the part
        expect(report.relief!.cells).toBeGreaterThan(0);
        expect(report.relief!.bandM).toBeUndefined();
        expect(report.relief!.maxRecessM).toBeLessThanOrEqual(seen.cap! + 1e-6);
        const baseNode = json.nodes.find((n: any) => n.extras?.sbHeightRelief?.role === 'base');
        expect(baseNode.children.length).toBe(report.relief!.cells);
        const near = json.nodes[baseNode.children[0]];
        expect(json.materials[json.meshes[near.mesh].primitives[0].material].extras.sbRelief.displaced).toBe(true);
        // the base is a slab 0.1 m thick about y = 0.05: nothing leaves it
        const pos = readAccessor(g, json.meshes[near.mesh].primitives[0].attributes.POSITION).data;
        for (let v = 0; v < pos.length; v += 3) { expect(Math.abs(pos[v])).toBeLessThanOrEqual(0.5 + 1e-5); expect(pos[v + 1]).toBeGreaterThanOrEqual(-1e-5); expect(pos[v + 1]).toBeLessThanOrEqual(0.1 + 1e-5); }
    }, TIMEOUT);

    it('reads a photo-textured material into classes by its colours', async () => {
        // a 64 x 64 photo: its left half dark red, its right half light grey
        const W = 64, rgba = Buffer.alloc(W * W * 4);
        for (let i = 0; i < W * W; i++) rgba.set(i % W < W / 2 ? [120, 30, 25, 255] : [200, 200, 195, 255], i * 4);
        const glb = buildFixtureGlb({
            primitives: [box('crate', [1, 1, 1], [0, 0.5, 0], 0, true)],
            materials: [{ name: 'photo', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
            textures: [{ source: 0 }], images: [encodePng(W, W, rgba)]
        });
        const seen: Parameters<typeof testSets>[0] = {};
        const { glb: out, report } = await runObjectMaterialPath(glb, { resolveSets: testSets(seen), displace: false }, undefined);
        expect(report.classes.length).toBe(3);
        expect(report.classes.every(c => c.from === 'photo')).toBe(true);
        // the darkest and lightest classes are the photo's two colours; a photo states no finish
        const L = seen.classes!.map(c => c.meanLab[0]);
        expect(Math.min(...L)).toBeLessThan(35);
        expect(Math.max(...L)).toBeGreaterThan(75);
        expect(seen.finishes!.every(f => f === undefined)).toBe(true);
        const json: any = parseGlbBytes(new Uint8Array(out)).json, m = json.materials.find((x: any) => x.name === 'photo');
        expect(m.pbrMetallicRoughness.baseColorTexture).toBeDefined();
        expect(m.extras.sbMaterialPath.method).toMatch(/3 appearance classes read from this material's photo/);
        expect(report.relief).toBeUndefined();
    }, TIMEOUT);

    it('classes a weathered part by its as-built factors and keeps its weathered finish', async () => {
        const weathered = await runObjectDetailPass(twoParts(), { wear: { edgeWear: 0.8, grime: 0.6 }, targetTexels: 256 * 256 });
        const seen: Parameters<typeof testSets>[0] = {};
        const { glb, report } = await runObjectMaterialPath(weathered.glb, { resolveSets: testSets(seen), displace: false }, undefined);
        expect(report.classes.map(c => c.from)).toEqual(['part', 'part']);
        expect(seen.finishes!.map(f => f?.roughness)).toEqual([0.3, 0.6]);
        expect(seen.classes![0].meanLinear[0]).toBeCloseTo(0.9, 1);
        const json: any = parseGlbBytes(new Uint8Array(glb)).json;
        for (const m of json.materials.filter((x: any) => x.extras?.sbMaterialPath)) {
            expect(m.extras.sbMaterialPath.kept).toEqual(expect.arrayContaining(['roughness', 'metalness']));
            expect(m.extras.sbMaterialPath.wrote).toContain('normal');
            expect(m.extras.sbDetailPass).toBeDefined();
        }
    }, TIMEOUT);
});
