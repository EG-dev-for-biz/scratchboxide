/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * One object cut out of a layer GLB, and layers put back together from objects: the scene object store keeps every
 * rebuilt building and tree as its own GLB (asset-store/scene-object-store.ts), and a later build reuses them.
 *
 * `composeGlb` copies node subtrees out of one or more source GLBs into a new GLB: names, transforms, extras, meshes,
 * materials, textures, images and samplers come across unchanged, attribute bytes are copied as stored (quantized
 * attributes stay quantized), and the EXT_mesh_gpu_instancing attributes a tree's leaf clusters use are carried. A
 * selected node can instead keep only some of its own triangles (a district's scanned residual, cut by the building it
 * stands on): its primitives are rewritten with just those triangles, every attribute gathered bit for bit.
 *
 * What it cannot carry it refuses with the reason (a skinned node, a sparse accessor, a node or primitive extension it
 * does not know how to renumber), so an object is never stored with a reference that points nowhere.
 */

import { assembleGlb, COMPONENT_BYTES, gatherElements, nodeWorldMatrices, isIdentity, readAccessor, TYPE_COMPONENTS, type ParsedGlb } from './glb-bytes';

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is untyped */

export interface ComposeSelection {
    /** Source node index. Without `triangles` its whole subtree is copied. */
    node: number;
    /**
     * Keep only these triangles of the node's own mesh (numbered over its TRIANGLES primitives in order, then within
     * each); the node's children are not copied. An empty list copies nothing.
     */
    triangles?: ArrayLike<number>;
}

export interface ComposeSource {
    glb: ParsedGlb;
    select: ComposeSelection[];
    /**
     * Bake the source world matrix of each selected node's parent into the copy (default true), so the copy stands
     * where it stood in the layer even when the layer's root carried a transform.
     */
    keepPlacement?: boolean;
}

export interface ComposeOptions {
    /** The new root node's name. */
    name: string;
    rootExtras?: Record<string, unknown>;
    assetExtras?: Record<string, unknown>;
    generator?: string;
    /** asset.copyright (default: the first source's). */
    copyright?: string;
}

/** Node and primitive extensions this module knows how to renumber; anything else is refused. */
const NODE_EXTENSIONS = new Set(['EXT_mesh_gpu_instancing', 'KHR_materials_variants']);
const PRIMITIVE_EXTENSIONS = new Set(['KHR_materials_variants']);

class Bin {
    private readonly parts: Buffer[] = [];
    readonly views: any[] = [];
    private offset = 0;
    push(bytes: Uint8Array, extra: { target?: number; byteStride?: number } = {}): number {
        const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const pad = (4 - (b.length % 4)) % 4;
        this.parts.push(b);
        if (pad) this.parts.push(Buffer.alloc(pad));
        this.views.push({ buffer: 0, byteOffset: this.offset, byteLength: b.length, ...(extra.byteStride ? { byteStride: extra.byteStride } : {}), ...(extra.target ? { target: extra.target } : {}) });
        this.offset += b.length + pad;
        return this.views.length - 1;
    }
    bytes(): Buffer { return Buffer.concat(this.parts); }
    get length(): number { return this.offset; }
}

type Usage = 'vertex' | 'index' | 'instance';

interface SourceMaps {
    glb: ParsedGlb;
    accessor: Map<string, number>;
    mesh: Map<number, number>;
    material: Map<number, number>;
    texture: Map<number, number>;
    image: Map<number, number>;
    sampler: Map<number, number>;
    camera: Map<number, number>;
}

/** Element bytes padded to 4 when the accessor feeds a vertex or instance attribute (the glTF alignment rule). */
function padElements(bytes: Uint8Array, elementBytes: number, count: number): { bytes: Uint8Array; stride?: number } {
    if (elementBytes % 4 === 0) return { bytes };
    const stride = elementBytes + ((4 - (elementBytes % 4)) % 4);
    const out = new Uint8Array(stride * count);
    for (let i = 0; i < count; i++) out.set(bytes.subarray(i * elementBytes, (i + 1) * elementBytes), i * stride);
    return { bytes: out, stride };
}

class Composer {
    readonly json: any;
    readonly bin = new Bin();
    readonly used = new Set<string>();
    private readonly indexAccessors = new Set<number>();
    private readonly sourceExtensions = { used: new Set<string>(), required: new Set<string>() };

    constructor(opts: ComposeOptions, firstSource: any) {
        this.json = {
            asset: {
                version: '2.0', generator: opts.generator ?? 'Scratchbox glb-subset',
                ...(opts.copyright ?? firstSource?.asset?.copyright ? { copyright: opts.copyright ?? firstSource.asset.copyright } : {}),
                ...(opts.assetExtras ? { extras: opts.assetExtras } : {})
            },
            scene: 0, scenes: [{ nodes: [0] }],
            nodes: [{ name: opts.name, children: [] as number[], ...(opts.rootExtras ? { extras: opts.rootExtras } : {}) }],
            meshes: [], accessors: [], materials: [], textures: [], images: [], samplers: [], cameras: []
        };
    }

    noteSource(json: any): void {
        for (const e of json.extensionsUsed ?? []) this.sourceExtensions.used.add(e);
        for (const e of json.extensionsRequired ?? []) this.sourceExtensions.required.add(e);
    }

    maps(glb: ParsedGlb): SourceMaps {
        return { glb, accessor: new Map(), mesh: new Map(), material: new Map(), texture: new Map(), image: new Map(), sampler: new Map(), camera: new Map() };
    }

    private pushAccessor(src: any, bytes: Uint8Array, count: number, usage: Usage, minMax?: { min: number[]; max: number[] }): number {
        const comps = TYPE_COMPONENTS[src.type], size = COMPONENT_BYTES[src.componentType];
        const elementBytes = comps * size;
        let view: number;
        if (usage === 'index') view = this.bin.push(bytes, { target: 34963 });
        else {
            const padded = padElements(bytes, elementBytes, count);
            view = this.bin.push(padded.bytes, { ...(usage === 'vertex' ? { target: 34962 } : {}), ...(padded.stride ? { byteStride: padded.stride } : {}) });
        }
        const out: any = { bufferView: view, componentType: src.componentType, count, type: src.type };
        if (src.normalized) out.normalized = true;
        if (minMax) { out.min = minMax.min; out.max = minMax.max; } else {
            if (Array.isArray(src.min)) out.min = src.min.slice();
            if (Array.isArray(src.max)) out.max = src.max.slice();
        }
        if (src.name) out.name = src.name;
        this.json.accessors.push(out);
        if (usage === 'index') this.indexAccessors.add(this.json.accessors.length - 1);
        return this.json.accessors.length - 1;
    }

    accessor(m: SourceMaps, index: number, usage: Usage): number {
        const key = `${index}:${usage}`;
        const had = m.accessor.get(key);
        if (had !== undefined) return had;
        const src = m.glb.json.accessors?.[index];
        if (!src) throw new Error(`glb-subset: accessor ${index} does not exist`);
        if (src.sparse) throw new Error(`glb-subset: accessor ${index} is sparse, which an object copy does not carry`);
        if (src.bufferView === undefined) throw new Error(`glb-subset: accessor ${index} has no bufferView`);
        const out = this.pushAccessor(src, gatherElements(m.glb, index, undefined), src.count, usage);
        m.accessor.set(key, out);
        return out;
    }

    /** An accessor gathered in a new element order (a triangle subset), its min/max recomputed for POSITION. */
    gatheredAccessor(m: SourceMaps, index: number, order: ArrayLike<number>, usage: Usage, withBounds: boolean): number {
        const src = m.glb.json.accessors?.[index];
        if (!src) throw new Error(`glb-subset: accessor ${index} does not exist`);
        if (src.sparse) throw new Error(`glb-subset: accessor ${index} is sparse, which an object copy does not carry`);
        let minMax: { min: number[]; max: number[] } | undefined;
        if (withBounds) {
            const all = readAccessor(m.glb, index);
            const min = new Array(all.comps).fill(Infinity), max = new Array(all.comps).fill(-Infinity);
            for (let i = 0; i < order.length; i++) for (let c = 0; c < all.comps; c++) {
                const v = all.data[order[i] * all.comps + c];
                if (v < min[c]) min[c] = v;
                if (v > max[c]) max[c] = v;
            }
            // float32 bounds as stored (min/max must match the stored values exactly)
            if (src.componentType === 5126) for (let c = 0; c < all.comps; c++) { min[c] = Math.fround(min[c]); max[c] = Math.fround(max[c]); }
            minMax = { min, max };
        }
        const bytes = gatherElements(m.glb, index, order);
        const copy = { ...src };
        if (!withBounds) { delete copy.min; delete copy.max; }
        return this.pushAccessor(copy, bytes, order.length, usage, minMax);
    }

    image(m: SourceMaps, index: number): number {
        const had = m.image.get(index);
        if (had !== undefined) return had;
        const src = m.glb.json.images?.[index];
        if (!src) throw new Error(`glb-subset: image ${index} does not exist`);
        const im = JSON.parse(JSON.stringify(src));
        if (im.bufferView !== undefined) {
            const v = m.glb.json.bufferViews[im.bufferView];
            const o = v.byteOffset ?? 0;
            im.bufferView = this.bin.push(m.glb.bin.subarray(o, o + v.byteLength));
        }
        this.json.images.push(im);
        m.image.set(index, this.json.images.length - 1);
        return this.json.images.length - 1;
    }

    sampler(m: SourceMaps, index: number): number {
        const had = m.sampler.get(index);
        if (had !== undefined) return had;
        this.json.samplers.push(JSON.parse(JSON.stringify(m.glb.json.samplers[index])));
        m.sampler.set(index, this.json.samplers.length - 1);
        return this.json.samplers.length - 1;
    }

    texture(m: SourceMaps, index: number): number {
        const had = m.texture.get(index);
        if (had !== undefined) return had;
        const src = m.glb.json.textures?.[index];
        if (!src) throw new Error(`glb-subset: texture ${index} does not exist`);
        const t = JSON.parse(JSON.stringify(src));
        if (t.source !== undefined) t.source = this.image(m, t.source);
        if (t.sampler !== undefined) t.sampler = this.sampler(m, t.sampler);
        for (const [name, e] of Object.entries(t.extensions ?? {}) as Array<[string, any]>) {
            this.used.add(name);
            if (e && typeof e.source === 'number') e.source = this.image(m, e.source);
        }
        this.json.textures.push(t);
        m.texture.set(index, this.json.textures.length - 1);
        return this.json.textures.length - 1;
    }

    material(m: SourceMaps, index: number): number {
        const had = m.material.get(index);
        if (had !== undefined) return had;
        const src = m.glb.json.materials?.[index];
        if (!src) throw new Error(`glb-subset: material ${index} does not exist`);
        const mat = JSON.parse(JSON.stringify(src));
        for (const name of Object.keys(mat.extensions ?? {})) this.used.add(name);
        // every { index: n } texture reference anywhere in the material (core slots and extensions)
        const walk = (o: any): void => {
            if (!o || typeof o !== 'object') return;
            for (const [k, v] of Object.entries(o)) {
                if (v && typeof v === 'object' && /Texture$/.test(k) && typeof (v as { index?: unknown }).index === 'number') {
                    (v as { index: number }).index = this.texture(m, (v as { index: number }).index);
                    for (const name of Object.keys((v as any).extensions ?? {})) this.used.add(name);
                } else walk(v);
            }
        };
        walk({ ...mat, extras: undefined });
        // the staged layers' confidence map is a texture index in the material's extras (staged-glb-writer, massing-glb)
        const conf = mat.extras?.sbTexture?.confidenceTexture;
        if (typeof conf === 'number') mat.extras.sbTexture.confidenceTexture = this.texture(m, conf);
        this.json.materials.push(mat);
        m.material.set(index, this.json.materials.length - 1);
        return this.json.materials.length - 1;
    }

    private primitiveCommon(m: SourceMaps, p: any, out: any): void {
        if (p.material !== undefined) out.material = this.material(m, p.material);
        for (const name of Object.keys(p.extensions ?? {})) {
            if (!PRIMITIVE_EXTENSIONS.has(name)) throw new Error(`glb-subset: a primitive carries ${name}, which an object copy does not know how to renumber`);
            this.used.add(name);
        }
        if (p.extensions) {
            const ext = JSON.parse(JSON.stringify(p.extensions));
            for (const mapping of ext.KHR_materials_variants?.mappings ?? []) mapping.material = this.material(m, mapping.material);
            out.extensions = ext;
        }
        if (p.extras !== undefined) out.extras = JSON.parse(JSON.stringify(p.extras));
    }

    mesh(m: SourceMaps, index: number): number {
        const had = m.mesh.get(index);
        if (had !== undefined) return had;
        const src = m.glb.json.meshes?.[index];
        if (!src) throw new Error(`glb-subset: mesh ${index} does not exist`);
        const out: any = { primitives: [] };
        if (src.name !== undefined) out.name = src.name;
        if (src.weights) out.weights = src.weights.slice();
        if (src.extras !== undefined) out.extras = JSON.parse(JSON.stringify(src.extras));
        for (const p of src.primitives ?? []) {
            const prim: any = { attributes: {} };
            for (const [name, ai] of Object.entries(p.attributes ?? {}) as Array<[string, number]>) prim.attributes[name] = this.accessor(m, ai, 'vertex');
            if (p.indices !== undefined) prim.indices = this.accessor(m, p.indices, 'index');
            if (p.mode !== undefined) prim.mode = p.mode;
            if (p.targets) prim.targets = p.targets.map((t: Record<string, number>) => Object.fromEntries(Object.entries(t).map(([k, ai]) => [k, this.accessor(m, ai, 'vertex')])));
            this.primitiveCommon(m, p, prim);
            out.primitives.push(prim);
        }
        this.json.meshes.push(out);
        m.mesh.set(index, this.json.meshes.length - 1);
        return this.json.meshes.length - 1;
    }

    /** A new mesh holding only `keep` (sorted triangle numbers over the mesh's TRIANGLES primitives). Undefined when nothing is kept. */
    meshSubset(m: SourceMaps, index: number, keep: ArrayLike<number>): number | undefined {
        const src = m.glb.json.meshes?.[index];
        if (!src) throw new Error(`glb-subset: mesh ${index} does not exist`);
        const wanted = new Set<number>();
        for (let i = 0; i < keep.length; i++) wanted.add(keep[i]);
        const out: any = { primitives: [] };
        if (src.name !== undefined) out.name = src.name;
        if (src.extras !== undefined) out.extras = JSON.parse(JSON.stringify(src.extras));
        let first = 0;
        for (const p of src.primitives ?? []) {
            if (p.mode !== undefined && p.mode !== 4) continue;
            if (p.targets) throw new Error(`glb-subset: mesh ${index} has morph targets, which a triangle subset does not carry`);
            const posIndex = p.attributes?.POSITION;
            if (posIndex === undefined) continue;
            const vertexCount = m.glb.json.accessors[posIndex].count;
            const idx = p.indices !== undefined ? readAccessor(m.glb, p.indices).data : Float64Array.from({ length: vertexCount - (vertexCount % 3) }, (_, i) => i);
            const triangles = idx.length / 3;
            const remap = new Map<number, number>();
            const order: number[] = [];
            const newIdx: number[] = [];
            for (let t = 0; t < triangles; t++) {
                if (!wanted.has(first + t)) continue;
                for (let k = 0; k < 3; k++) {
                    const v = idx[t * 3 + k];
                    let nv = remap.get(v);
                    if (nv === undefined) { nv = order.length; remap.set(v, nv); order.push(v); }
                    newIdx.push(nv);
                }
            }
            first += triangles;
            if (!newIdx.length) continue;
            const prim: any = { attributes: {}, mode: 4 };
            for (const [name, ai] of Object.entries(p.attributes) as Array<[string, number]>) prim.attributes[name] = this.gatheredAccessor(m, ai, order, 'vertex', name === 'POSITION');
            const indexBytes = new Uint8Array(new Uint32Array(newIdx).buffer);
            prim.indices = this.pushRaw({ componentType: 5125, type: 'SCALAR' }, indexBytes, newIdx.length, 'index');
            this.primitiveCommon(m, p, prim);
            out.primitives.push(prim);
        }
        if (!out.primitives.length) return undefined;
        this.json.meshes.push(out);
        return this.json.meshes.length - 1;
    }

    private pushRaw(desc: { componentType: number; type: string }, bytes: Uint8Array, count: number, usage: Usage): number {
        return this.pushAccessor(desc, bytes, count, usage);
    }

    camera(m: SourceMaps, index: number): number {
        const had = m.camera.get(index);
        if (had !== undefined) return had;
        this.json.cameras.push(JSON.parse(JSON.stringify(m.glb.json.cameras[index])));
        m.camera.set(index, this.json.cameras.length - 1);
        return this.json.cameras.length - 1;
    }

    /** Copies node `index` (its subtree, or its own triangles `keep`) and returns the new node's index; undefined when nothing was kept. */
    node(m: SourceMaps, index: number, keep?: ArrayLike<number>, placement?: number[]): number | undefined {
        const src = m.glb.json.nodes?.[index];
        if (!src) throw new Error(`glb-subset: node ${index} does not exist`);
        if (src.skin !== undefined) throw new Error(`glb-subset: node ${index} is skinned, which an object copy does not carry`);
        const out: any = {};
        if (src.name !== undefined) out.name = src.name;
        if (placement) {
            out.matrix = placement;
        } else {
            for (const k of ['matrix', 'translation', 'rotation', 'scale']) if (src[k] !== undefined) out[k] = src[k].slice();
        }
        if (src.weights) out.weights = src.weights.slice();
        if (src.extras !== undefined) out.extras = JSON.parse(JSON.stringify(src.extras));
        if (src.camera !== undefined) out.camera = this.camera(m, src.camera);
        if (src.mesh !== undefined) {
            if (keep) {
                const mesh = this.meshSubset(m, src.mesh, keep);
                if (mesh === undefined) return undefined;
                out.mesh = mesh;
            } else out.mesh = this.mesh(m, src.mesh);
        } else if (keep) return undefined;
        for (const [name, e] of Object.entries(src.extensions ?? {}) as Array<[string, any]>) {
            if (!NODE_EXTENSIONS.has(name)) throw new Error(`glb-subset: node ${index} carries ${name}, which an object copy does not know how to renumber`);
            if (name === 'EXT_mesh_gpu_instancing' && keep) throw new Error(`glb-subset: node ${index} is instanced; a triangle subset of an instanced node is not supported`);
            this.used.add(name);
            const copy = JSON.parse(JSON.stringify(e));
            if (name === 'EXT_mesh_gpu_instancing') copy.attributes = Object.fromEntries(Object.entries(copy.attributes ?? {}).map(([k, ai]) => [k, this.accessor(m, ai as number, 'instance')]));
            out.extensions = { ...(out.extensions ?? {}), [name]: copy };
        }
        this.json.nodes.push(out);
        const at = this.json.nodes.length - 1;
        if (!keep && src.children?.length) {
            out.children = [];
            for (const c of src.children) {
                const ci = this.node(m, c);
                if (ci !== undefined) out.children.push(ci);
            }
        }
        return at;
    }

    attach(child: number): void {
        this.json.nodes[0].children.push(child);
    }

    finish(): Buffer {
        const json = this.json;
        for (const k of ['meshes', 'accessors', 'materials', 'textures', 'images', 'samplers', 'cameras']) if (!json[k].length) delete json[k];
        if (!json.nodes[0].children.length) delete json.nodes[0].children;
        // quantized attributes are only legal under KHR_mesh_quantization: kept whenever the sources declared it and an attribute needs it
        if (this.sourceExtensions.used.has('KHR_mesh_quantization') && (json.accessors ?? []).some((a: any, i: number) => a.componentType !== 5126 && !this.indexAccessors.has(i))) this.used.add('KHR_mesh_quantization');
        const used = [...this.used].sort();
        if (used.length) json.extensionsUsed = used;
        const required = used.filter(e => this.sourceExtensions.required.has(e));
        if (required.length) json.extensionsRequired = required;
        const data = this.bin.bytes();
        if (data.length) {
            json.bufferViews = this.bin.views;
            json.buffers = [{ byteLength: data.length }];
        }
        return assembleGlb(json, data);
    }
}

function parentsOf(json: any): Int32Array {
    const parent = new Int32Array((json.nodes ?? []).length).fill(-1);
    (json.nodes ?? []).forEach((n: any, i: number) => { for (const c of n.children ?? []) parent[c] = i; });
    return parent;
}

/** Column-major world matrix of a node's local transform composed with its parent's world matrix, as glTF's `matrix`. */
function placementOf(json: any, worlds: Float64Array[], parents: Int32Array, node: number): number[] | undefined {
    const p = parents[node];
    if (p < 0 || isIdentity(worlds[p])) return undefined;
    return Array.from(worlds[node]);
}

/** A new GLB holding the selected nodes of every source under one root (see the module doc). */
export function composeGlb(sources: ComposeSource[], opts: ComposeOptions): Buffer {
    const composer = new Composer(opts, sources[0]?.glb.json);
    for (const s of sources) {
        composer.noteSource(s.glb.json);
        const maps = composer.maps(s.glb);
        const keepPlacement = s.keepPlacement !== false;
        const worlds = keepPlacement ? nodeWorldMatrices(s.glb.json) : [];
        const parents = keepPlacement ? parentsOf(s.glb.json) : new Int32Array(0);
        for (const sel of s.select) {
            if (!Number.isInteger(sel.node) || !s.glb.json.nodes?.[sel.node]) throw new Error(`glb-subset: node ${sel.node} does not exist`);
            const placement = keepPlacement ? placementOf(s.glb.json, worlds, parents, sel.node) : undefined;
            const at = composer.node(maps, sel.node, sel.triangles, placement);
            if (at !== undefined) composer.attach(at);
        }
    }
    return composer.finish();
}

/** The scene root nodes of a GLB (what a whole-layer merge copies). */
export function sceneRoots(json: any): number[] {
    const scene = json.scenes?.[json.scene ?? 0];
    if (scene?.nodes) return scene.nodes.slice();
    const parents = parentsOf(json);
    return (json.nodes ?? []).map((_: unknown, i: number) => i).filter((i: number) => parents[i] < 0);
}

/**
 * Several GLBs as one: each source's scene roots (or, when a root is an unmeshed group like a staged layer's "staged"
 * node, that root's children) under one new root. Used to put a layer back together from stored objects.
 */
export function mergeGlbs(glbs: ParsedGlb[], opts: ComposeOptions & { unwrapGroups?: boolean }): Buffer {
    return composeGlb(glbs.map(glb => {
        const roots = sceneRoots(glb.json);
        const select = opts.unwrapGroups === false ? roots : roots.flatMap(r => {
            const n = glb.json.nodes[r];
            const plain = n.mesh === undefined && !n.matrix && !n.translation && !n.rotation && !n.scale && !n.extensions && n.children?.length;
            return plain ? n.children : [r];
        });
        return { glb, select: select.map((node: number) => ({ node })) };
    }), opts);
}
