/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A tiny trees GLB that follows the tree LOD contract (validateTreesGlbJson): per tree, three level children (0 near, 1 mid,
 * 2 far), wood as a small triangle fan, and for levels 0 and 1 two EXT_mesh_gpu_instancing leaf-cluster nodes instancing
 * one shared cluster mesh. Geometry is a stand-in sized for tests; the structure is what the contract fixes.
 */

import * as fs from 'fs';
import type { TreeLodExtras, TreesGlbRootExtras } from '../../src/common/spatial/staged-location-contracts';

export interface TreesLodFixtureOptions { trees?: number; psiSeason?: number }

/** The glTF JSON and binary of the fixture; `mutate` lets a test break one detail. */
export function buildTreesLodGltf(opts: TreesLodFixtureOptions = {}): { json: any; bin: Buffer } {
    const trees = opts.trees ?? 2;
    const parts: Buffer[] = [];
    const bufferViews: any[] = [], accessors: any[] = [];
    let offset = 0;
    const push = (b: Buffer): number => {
        parts.push(b);
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: b.length });
        offset += b.length;
        return bufferViews.length - 1;
    };
    const vec3 = (values: number[], withBounds: boolean): number => {
        const f = new Float32Array(values);
        const acc: any = { bufferView: push(Buffer.from(f.buffer)), componentType: 5126, count: values.length / 3, type: 'VEC3' };
        if (withBounds) {
            acc.min = [0, 1, 2].map(k => Math.min(...values.filter((_, i) => i % 3 === k)));
            acc.max = [0, 1, 2].map(k => Math.max(...values.filter((_, i) => i % 3 === k)));
        }
        accessors.push(acc);
        return accessors.length - 1;
    };
    const mesh = (positions: number[], indices: number[]): any => {
        const p = vec3(positions, true);
        accessors.push({ bufferView: push(Buffer.from(new Uint16Array(indices).buffer)), componentType: 5123, count: indices.length, type: 'SCALAR' });
        return { primitives: [{ attributes: { POSITION: p }, indices: accessors.length - 1, mode: 4 }] };
    };
    const fan = (n: number, r: number, h: number): { positions: number[]; indices: number[] } => {
        const positions = [0, h, 0], indices: number[] = [];
        for (let i = 0; i < n; i++) positions.push(r * Math.cos((2 * Math.PI * i) / n), 0, r * Math.sin((2 * Math.PI * i) / n));
        for (let i = 0; i < n; i++) indices.push(0, 1 + i, 1 + ((i + 1) % n));
        return { positions, indices };
    };
    // buffer views are 4-byte aligned by construction (float32 and uint16 pairs); pad uint16 index runs explicitly
    const pad = () => { if (offset % 4) { const b = Buffer.alloc(4 - (offset % 4)); parts.push(b); offset += b.length; } };

    const meshes: any[] = [];
    const nodes: any[] = [];
    const addMesh = (positions: number[], indices: number[]): number => { const m = mesh(positions, indices); pad(); meshes.push(m); return meshes.length - 1; };
    const clusterMesh = addMesh([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0.05], [0, 1, 2]);
    meshes[clusterMesh].name = 'leaf_cluster_a';
    const levelTris = [12, 6, 4];
    const bands: Array<[number, number, number]> = [[0, 60, 10], [50, 200, 30], [170, 1e6, 60]];
    const treeNodes: number[] = [];
    for (let t = 0; t < trees; t++) {
        const levelNodes: number[] = [];
        for (let level = 0; level < 3; level++) {
            const f = fan(levelTris[level], 0.3 - 0.05 * level, 8);
            const wood = addMesh(f.positions, f.indices);
            const instanced = level < 2;
            const children: number[] = [];
            if (instanced) {
                for (let c = 0; c < 2; c++) {
                    const tr = vec3(level === 0 ? [0, 6, 0.5, 0.4, 7, 0, -0.4, 5, 0.2] : [0, 6, 0.5, 0.4, 7, 0], false);
                    nodes.push({
                        name: `tree${t}_lod${level}_cluster${c}`, mesh: clusterMesh,
                        extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: tr } } },
                        extras: { sbCluster: { clusterMesh: 'leaf_cluster_a', hashSeed: 1000 * t + 10 * level + c } }
                    });
                    children.push(nodes.length - 1);
                }
            }
            const lod: TreeLodExtras = { level: level as 0 | 1 | 2, minDistM: bands[level][0], maxDistM: bands[level][1], fadeM: bands[level][2], triangles: levelTris[level], instanced };
            nodes.push({ name: `tree${t}_lod${level}`, mesh: wood, ...(children.length ? { children } : {}), extras: { sbLod: lod } });
            levelNodes.push(nodes.length - 1);
        }
        nodes.push({ name: `tree${t}`, translation: [10 * t, 0, 0], children: levelNodes, extras: { sbTree: { id: t, hashSeed: 7919 * (t + 1), label: 'grown to the measured crown' } } });
        treeNodes.push(nodes.length - 1);
    }
    const root: TreesGlbRootExtras = {
        schema: 'scratchbox.trees-lod/1', psiSeason: opts.psiSeason ?? 1,
        clusterLibrary: {
            variants: [{ mesh: 'leaf_cluster_a', leavesLevel0: 24, leavesLevel1: 3 }],
            leafSizeModel: { sizeRatioToCrownHeight: 0.004, minM: 0.05, maxM: 0.12 }
        }
    };
    pad();
    const bin = Buffer.concat(parts);
    const json = {
        asset: { version: '2.0' }, extensionsUsed: ['EXT_mesh_gpu_instancing'], extras: { sbTrees: root },
        buffers: [{ byteLength: bin.length }], bufferViews, accessors, meshes, nodes, scenes: [{ nodes: treeNodes }], scene: 0
    };
    return { json, bin };
}

/** Serialises glTF JSON and binary as a .glb. */
export function writeTreesLodGlb(file: string, gltf: { json: any; bin: Buffer } = buildTreesLodGltf()): void {
    let js = Buffer.from(JSON.stringify(gltf.json));
    js = Buffer.concat([js, Buffer.alloc((4 - (js.length % 4)) % 4, 0x20)]);
    const header = Buffer.alloc(12); header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + js.length + 8 + gltf.bin.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.write('JSON', 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(gltf.bin.length, 0); bh.write('BIN\0', 4);
    fs.writeFileSync(file, Buffer.concat([header, jh, js, bh, gltf.bin]));
}
