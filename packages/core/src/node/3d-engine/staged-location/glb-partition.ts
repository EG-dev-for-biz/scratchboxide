/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A scan GLB split by a label per triangle: each label's triangles written as their own GLB, photo-textured (the scan's
 * own materials and images, attributes copied bit for bit) or as studio clay, in the scan's world frame (node
 * transforms baked in). Every triangle goes to exactly one label's output.
 *
 * Triangles are numbered as loadScanMesh / readGlbScene number them (nodes in index order, each node's mesh primitives
 * in order, triangle primitives only), so a label array computed on a ScanMesh indexes the same triangles here.
 */

import * as fs from 'fs';
import * as path from 'path';
import { assembleGlb, COMPONENT_BYTES, gatherElements, nodeWorldMatrices, parseGlbBytes, readAccessor, TYPE_COMPONENTS, type Mat4, type ParsedGlb } from './glb-bytes';

/** One triangle primitive of one node, in readGlbScene's order. */
interface PrimInstance {
    node: number;
    prim: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- glTF JSON
    world: Mat4;
    /** Vertex index of each triangle corner (local to the primitive). */
    indices: Uint32Array;
    /** World-space positions of the primitive's vertices. */
    positions: Float32Array;
    firstTriangle: number;
    triangles: number;
}

export interface ScanGlb {
    glb: ParsedGlb;
    instances: PrimInstance[];
    triangleCount: number;
}

function dequantize(acc: any, v: number): number { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!acc.normalized) return v;
    switch (acc.componentType) {
        case 5123: return v / 65535;
        case 5122: return Math.max(-1, v / 32767);
        case 5121: return v / 255;
        case 5120: return Math.max(-1, v / 127);
        default: return v;
    }
}

/** Reads a scan GLB's triangle primitives in loadScanMesh's order (positions in world space). */
export function readScanGlb(file: string): ScanGlb {
    const glb = parseGlbBytes(fs.readFileSync(file));
    const json = glb.json;
    const nodes: any[] = json.nodes ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
    const world = nodeWorldMatrices(json);
    const meshOf: Array<{ node: number; mesh: any; world: Mat4 }> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
    nodes.forEach((n, i) => { if (n.mesh !== undefined && json.meshes?.[n.mesh]) meshOf.push({ node: i, mesh: json.meshes[n.mesh], world: world[i] }); });
    if (!meshOf.length) {
        const id = new Float64Array(16); id[0] = id[5] = id[10] = id[15] = 1;
        for (const mesh of json.meshes ?? []) meshOf.push({ node: -1, mesh, world: id });
    }
    const instances: PrimInstance[] = [];
    let first = 0;
    for (const inst of meshOf) for (const prim of inst.mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
        if (prim.extensions?.KHR_draco_mesh_compression) throw new Error('the scan GLB holds Draco-compressed primitives, which cannot be split triangle by triangle here');
        const pa = readAccessor(glb, prim.attributes.POSITION);
        const acc = json.accessors[prim.attributes.POSITION];
        const m = inst.world;
        const n = pa.count;
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const x = dequantize(acc, pa.data[i * 3]), y = dequantize(acc, pa.data[i * 3 + 1]), z = dequantize(acc, pa.data[i * 3 + 2]);
            positions[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
            positions[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            positions[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        const indices = prim.indices !== undefined ? Uint32Array.from(readAccessor(glb, prim.indices).data) : Uint32Array.from({ length: n }, (_, i) => i);
        const triangles = Math.floor(indices.length / 3);
        instances.push({ node: inst.node, prim, world: m, indices, positions, firstTriangle: first, triangles });
        first += triangles;
    }
    return { glb, instances, triangleCount: first };
}

export interface PartitionOutput {
    /** The label whose triangles this output holds. */
    label: number;
    file: string;
    /** textured: the scan's own materials and images; clay: one matte clay material, no UVs or images. */
    kind: 'textured' | 'clay';
    /** Clay colour (linear RGB, default the studio clay). */
    color?: [number, number, number];
    /** Written into asset.extras. */
    extras?: Record<string, unknown>;
}

export const STUDIO_CLAY: [number, number, number] = [0.55, 0.57, 0.6];

class BinWriter {
    readonly parts: Buffer[] = [];
    readonly views: Array<Record<string, unknown>> = [];
    private offset = 0;
    push(bytes: Uint8Array, target?: number): number {
        const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const pad = (4 - (b.length % 4)) % 4;
        this.parts.push(b, Buffer.alloc(pad));
        this.views.push({ buffer: 0, byteOffset: this.offset, byteLength: b.length, ...(target ? { target } : {}) });
        this.offset += b.length + pad;
        return this.views.length - 1;
    }
    bytes(): Uint8Array { return Buffer.concat(this.parts); }
}

/** Copies a material (and the textures, samplers and images it uses) into the output JSON; returns its new index. */
function copyMaterial(src: any, out: any, bin: BinWriter, glb: ParsedGlb, maps: { mat: Map<number, number>; tex: Map<number, number>; img: Map<number, number>; smp: Map<number, number> }, index: number): number { // eslint-disable-line @typescript-eslint/no-explicit-any
    const had = maps.mat.get(index);
    if (had !== undefined) return had;
    const copyImage = (i: number): number => {
        const h = maps.img.get(i);
        if (h !== undefined) return h;
        const im = { ...src.images[i] };
        if (im.bufferView !== undefined) {
            const v = src.bufferViews[im.bufferView];
            const o = v.byteOffset ?? 0;
            im.bufferView = bin.push(glb.bin.subarray(o, o + v.byteLength));
        }
        out.images.push(im);
        maps.img.set(i, out.images.length - 1);
        return out.images.length - 1;
    };
    const copySampler = (i: number): number => {
        const h = maps.smp.get(i);
        if (h !== undefined) return h;
        out.samplers.push({ ...src.samplers[i] });
        maps.smp.set(i, out.samplers.length - 1);
        return out.samplers.length - 1;
    };
    const copyTexture = (i: number): number => {
        const h = maps.tex.get(i);
        if (h !== undefined) return h;
        const t = JSON.parse(JSON.stringify(src.textures[i]));
        if (t.source !== undefined) t.source = copyImage(t.source);
        if (t.sampler !== undefined) t.sampler = copySampler(t.sampler);
        for (const e of Object.values(t.extensions ?? {}) as any[]) if (e && typeof e.source === 'number') e.source = copyImage(e.source); // eslint-disable-line @typescript-eslint/no-explicit-any
        out.textures.push(t);
        maps.tex.set(i, out.textures.length - 1);
        return out.textures.length - 1;
    };
    const m = JSON.parse(JSON.stringify(src.materials[index]));
    // every { index: n } texture reference anywhere in the material (core slots and extensions)
    const walk = (o: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
            if (v && typeof v === 'object' && /Texture$/.test(k) && typeof (v as { index?: unknown }).index === 'number') (v as { index: number }).index = copyTexture((v as { index: number }).index);
            else walk(v);
        }
    };
    walk(m);
    out.materials.push(m);
    maps.mat.set(index, out.materials.length - 1);
    return out.materials.length - 1;
}

/**
 * Writes one GLB per output: the triangles whose label is `output.label`. Returns the triangle count written per output.
 * `labels[t]` is the label of triangle t (loadScanMesh numbering).
 */
export function writePartition(scan: ScanGlb, labels: Int32Array, outputs: PartitionOutput[]): number[] {
    if (labels.length !== scan.triangleCount) throw new Error(`writePartition: ${labels.length} labels for ${scan.triangleCount} triangles`);
    return outputs.map(o => writeLabel(scan, labels, o));
}

function writeLabel(scan: ScanGlb, labels: Int32Array, o: PartitionOutput): number {
    const src = scan.glb.json;
    const bin = new BinWriter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = {
        asset: { version: '2.0', generator: 'Scratchbox glb-partition', ...(o.extras ? { extras: o.extras } : {}) },
        scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: path.basename(o.file, '.glb'), mesh: 0 }], meshes: [{ primitives: [] }],
        accessors: [], bufferViews: [], buffers: [], materials: [], textures: [], images: [], samplers: []
    };
    if (o.kind === 'textured') {
        for (const k of ['extensionsUsed', 'extensionsRequired']) if (Array.isArray(src[k])) out[k] = src[k].filter((e: string) => e !== 'KHR_draco_mesh_compression' && e !== 'EXT_meshopt_compression');
    } else out.materials.push({ name: 'clay', pbrMetallicRoughness: { baseColorFactor: [...(o.color ?? STUDIO_CLAY), 1], metallicFactor: 0, roughnessFactor: 0.85 } });
    const maps = { mat: new Map<number, number>(), tex: new Map<number, number>(), img: new Map<number, number>(), smp: new Map<number, number>() };
    let written = 0;
    for (const inst of scan.instances) {
        const tris: number[] = [];
        for (let t = 0; t < inst.triangles; t++) if (labels[inst.firstTriangle + t] === o.label) tris.push(t);
        if (!tris.length) continue;
        const remap = new Map<number, number>();
        const order: number[] = [];
        const idx = new Uint32Array(tris.length * 3);
        tris.forEach((t, j) => {
            for (let k = 0; k < 3; k++) {
                const v = inst.indices[t * 3 + k];
                let nv = remap.get(v);
                if (nv === undefined) { nv = order.length; remap.set(v, nv); order.push(v); }
                idx[j * 3 + k] = nv;
            }
        });
        written += tris.length;
        const pos = new Float32Array(order.length * 3);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        order.forEach((v, i) => {
            for (let k = 0; k < 3; k++) {
                const x = inst.positions[v * 3 + k];
                pos[i * 3 + k] = x;
                const f = pos[i * 3 + k];
                if (f < min[k]) min[k] = f;
                if (f > max[k]) max[k] = f;
            }
        });
        const attributes: Record<string, number> = {};
        out.accessors.push({ bufferView: bin.push(new Uint8Array(pos.buffer), 34962), componentType: 5126, count: order.length, type: 'VEC3', min, max });
        attributes.POSITION = out.accessors.length - 1;
        if (o.kind === 'textured') {
            for (const [name, ai] of Object.entries(inst.prim.attributes as Record<string, number>)) {
                if (name === 'POSITION' || !/^(NORMAL|TEXCOORD_\d+|COLOR_\d+)$/.test(name)) continue;
                const a = src.accessors[ai];
                if (!TYPE_COMPONENTS[a.type] || !COMPONENT_BYTES[a.componentType]) continue;
                let bytes: Uint8Array = gatherElements(scan.glb, ai, order);
                if (name === 'NORMAL' && a.componentType === 5126) {
                    // normals turned by the node's world matrix (its upper 3x3), renormalised
                    const n = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
                    const m = inst.world;
                    for (let i = 0; i < n.length; i += 3) {
                        const x = n[i], y = n[i + 1], z = n[i + 2];
                        const tx = m[0] * x + m[4] * y + m[8] * z, ty = m[1] * x + m[5] * y + m[9] * z, tz = m[2] * x + m[6] * y + m[10] * z;
                        const l = Math.hypot(tx, ty, tz) || 1;
                        n[i] = tx / l; n[i + 1] = ty / l; n[i + 2] = tz / l;
                    }
                    bytes = new Uint8Array(n.buffer);
                }
                out.accessors.push({ bufferView: bin.push(bytes, 34962), componentType: a.componentType, count: order.length, type: a.type, ...(a.normalized ? { normalized: true } : {}) });
                attributes[name] = out.accessors.length - 1;
            }
        }
        out.accessors.push({ bufferView: bin.push(new Uint8Array(idx.buffer), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
        const primOut: Record<string, unknown> = { attributes, indices: out.accessors.length - 1, mode: 4 };
        if (o.kind === 'clay') primOut.material = 0;
        else if (inst.prim.material !== undefined) primOut.material = copyMaterial(src, out, bin, scan.glb, maps, inst.prim.material);
        out.meshes[0].primitives.push(primOut);
    }
    for (const k of ['materials', 'textures', 'images', 'samplers']) if (!out[k].length) delete out[k];
    const data = bin.bytes();
    out.bufferViews = bin.views;
    if (data.byteLength) out.buffers = [{ byteLength: data.byteLength }];
    else { delete out.buffers; delete out.bufferViews; delete out.accessors; }
    if (!out.meshes[0].primitives.length) { delete out.meshes; out.nodes = [{ name: path.basename(o.file, '.glb') }]; }
    fs.mkdirSync(path.dirname(o.file), { recursive: true });
    fs.writeFileSync(o.file, assembleGlb(out, data));
    return written;
}

/**
 * One clay GLB holding several labels, one node per label with its own colour (an overview where each label is told
 * apart). `groups` names each node; labels not in it are left out.
 */
export function writeColouredPartition(scan: ScanGlb, labels: Int32Array, groups: Array<{ label: number; name: string; color: [number, number, number]; extras?: Record<string, unknown> }>, file: string, assetExtras?: Record<string, unknown>): number {
    const bin = new BinWriter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = { asset: { version: '2.0', generator: 'Scratchbox glb-partition', ...(assetExtras ? { extras: assetExtras } : {}) }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], accessors: [], materials: [] };
    let written = 0;
    for (const g of groups) {
        const positions: number[] = [];
        for (const inst of scan.instances) for (let t = 0; t < inst.triangles; t++) {
            if (labels[inst.firstTriangle + t] !== g.label) continue;
            for (let k = 0; k < 3; k++) { const v = inst.indices[t * 3 + k]; positions.push(inst.positions[v * 3], inst.positions[v * 3 + 1], inst.positions[v * 3 + 2]); }
        }
        if (!positions.length) continue;
        written += positions.length / 9;
        const pos = Float32Array.from(positions);
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < pos.length; i++) { const k = i % 3; if (pos[i] < min[k]) min[k] = pos[i]; if (pos[i] > max[k]) max[k] = pos[i]; }
        out.accessors.push({ bufferView: bin.push(new Uint8Array(pos.buffer), 34962), componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max });
        out.materials.push({ name: g.name, pbrMetallicRoughness: { baseColorFactor: [...g.color, 1], metallicFactor: 0, roughnessFactor: 0.85 }, doubleSided: true });
        out.meshes.push({ name: g.name, primitives: [{ attributes: { POSITION: out.accessors.length - 1 }, material: out.materials.length - 1, mode: 4 }] });
        out.nodes.push({ name: g.name, mesh: out.meshes.length - 1, ...(g.extras ? { extras: g.extras } : {}) });
        out.scenes[0].nodes.push(out.nodes.length - 1);
    }
    const data = bin.bytes();
    out.bufferViews = bin.views;
    out.buffers = [{ byteLength: data.byteLength }];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, assembleGlb(out, data));
    return written;
}
