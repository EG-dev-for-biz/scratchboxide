/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import { python3DHandlers } from '../src/node/gemini/tools/python-3d-tools';
import { dressTreesGlb } from '../src/node/3d-engine/trees-glb-dress';
import { findTileVegetationRepoRoot, treeTextureIndexPath } from '../src/node/3d-engine/tile-vegetation-service';
import { assembleGlb, parseGlbBytes, readAccessor } from '../src/node/3d-engine/staged-location/glb-bytes';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

// One tree grown by the engine (sb.create_tree, SB-Veggie, its texture choices made by appearance), dressed for the tracer.
describe('trees dressed in glTF materials for the path tracer', () => {
    let glb: Buffer;
    const indexFile = treeTextureIndexPath(findTileVegetationRepoRoot())!;

    beforeAll(async () => {
        const outcome = await python3DHandlers.execute_3d_python_script({
            script: [
                'import scratchbox as sb',
                'scene = sb.geometry.Mesh("Plot")',
                'scene.merge(sb.create_box(width=20, height=0.2, depth=20))',
                'scene.merge(sb.create_tree(position=(0, 0.1, 0), height=8.0, crown_radius=2.5, crown_base_height=2.5, leaf_color="#3f7a35"))',
                'sb.io.write_glb(OUTPUT_GLB_PATH, scene)'
            ].join('\n'),
            description: 'One tree'
        });
        expect(outcome.status).toBe('completed');
        glb = fs.readFileSync((outcome.resultPayload as any).glbPath);
    }, 300_000);

    it('gives the leaves cut-out cell textures, the cards their baked atlas and the wood its bark, tinted per tree', () => {
        const dressed = dressTreesGlb(glb, indexFile)!;
        expect(dressed).toBeDefined();
        const r = dressed.report;
        expect(r.trees).toBe(1);
        expect(r.dressedTrees).toBe(1);
        expect(r.leafMeshes).toBeGreaterThan(0);
        expect(r.cardMeshes).toBeGreaterThan(0);
        expect(r.woodMeshes).toBeGreaterThan(0);
        expect(r.skipped).toEqual([]);

        const g = parseGlbBytes(dressed.glb);
        const mats: any[] = g.json.materials;
        const tree = g.json.nodes.find((n: any) => n.extras?.sbTree).extras.sbTree.texture;
        const leaf = mats.filter(m => /^leaf .* cell \d+$/.test(m.name));
        const card = mats.filter(m => /^crown cards /.test(m.name));
        const bark = mats.filter(m => /^bark /.test(m.name));
        expect(leaf.length).toBeGreaterThan(0);
        for (const m of [...leaf, ...card]) {
            expect(m.alphaMode).toBe('MASK');
            expect(m.doubleSided).toBe(true);
            expect(m.pbrMetallicRoughness.baseColorTexture.index).toBeGreaterThanOrEqual(0);
        }
        expect(leaf[0].pbrMetallicRoughness.baseColorFactor.slice(0, 3)).toEqual(tree.leaves.tint.map((v: number) => Math.min(4, v)));
        expect(bark[0].pbrMetallicRoughness.baseColorFactor.slice(0, 3)).toEqual(tree.bark.tint.map((v: number) => Math.min(4, v)));

        // the textures are real images: a leaf cell is cut out (transparent rim and gaps, opaque leaf), clamped
        const imageOf = (texture: number) => {
            const t = g.json.textures[texture], img = g.json.images[t.source], v = g.json.bufferViews[img.bufferView];
            return { png: decodeImageInMemory(g.bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)), sampler: g.json.samplers[t.sampler] };
        };
        for (const m of [leaf[0], card[0]]) {
            const { png, sampler } = imageOf(m.pbrMetallicRoughness.baseColorTexture.index);
            expect(sampler.wrapS).toBe(33071);
            let opaque = 0, clear = 0;
            for (let i = 3; i < png.rgba.length; i += 4) { if (png.rgba[i] >= 128) opaque++; else clear++; }
            expect(opaque).toBeGreaterThan(0.05 * (opaque + clear));
            expect(clear).toBeGreaterThan(0.05 * (opaque + clear));
            expect(png.rgba[3]).toBe(0); // the corner of a leaf cell's rim, or an empty card corner
        }
        expect(imageOf(bark[0].pbrMetallicRoughness.baseColorTexture.index).sampler.wrapS).toBe(10497);

        // a leaf primitive's UVs are the cell's leaf coordinates: around [0, 1], off it only where the card overhangs the leaf
        const leafPrim = g.json.meshes.flatMap((m: any) => m.primitives).find((p: any) => mats[p.material]?.name === leaf[0].name);
        const uv = readAccessor(g, leafPrim.attributes.TEXCOORD_0);
        const used = new Set<number>(Array.from(readAccessor(g, leafPrim.indices).data));
        let inside = 0;
        for (const v of used) { const s = uv.data[v * 2], t = uv.data[v * 2 + 1]; if (s >= -0.5 && s <= 1.5 && t >= -0.5 && t <= 1.5) inside++; }
        expect(inside / used.size).toBeGreaterThan(0.95);
        expect(g.json.extras.sbTrees.dressedFor.version).toBeGreaterThanOrEqual(1);
    });

    it('leaves a GLB without textured trees alone', () => {
        const plain = parseGlbBytes(glb);
        delete plain.json.extras.sbTrees.textures;
        expect(dressTreesGlb(assembleGlb(plain.json, plain.bin), indexFile)).toBeUndefined();
    });
});
