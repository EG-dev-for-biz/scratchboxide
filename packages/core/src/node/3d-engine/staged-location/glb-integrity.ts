/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A structural check of GLB bytes before the scene object store keeps them (the repo has no Khronos glTF validator
 * dependency; this checks the core rules that validator reports as errors and that a cut-out object could break):
 *   - the container: magic, version 2, declared length, 4-byte-aligned JSON and BIN chunks, the BIN chunk large enough
 *     for buffer 0;
 *   - every index in range (buffer views, accessors, meshes, materials, textures, images, samplers, nodes, cameras),
 *     every node with at most one parent and no cycle, scene roots that are roots;
 *   - every buffer view inside its buffer, byteStride 4..252 and a multiple of 4; every accessor inside its view,
 *     aligned to its component size, vertex attributes aligned to 4, POSITION with min/max that match the data;
 *   - every primitive's attributes of one count, its indices an unsigned type, in range, a whole number of triangles;
 *   - every extension a node, primitive, material or texture uses declared in extensionsUsed, extensionsRequired a
 *     subset of it, EXT_mesh_gpu_instancing attributes of one count.
 * It reads every index value and every POSITION, so a reference that points nowhere cannot pass.
 */

import { COMPONENT_BYTES, GLB_MAGIC, readAccessor, TYPE_COMPONENTS, type ParsedGlb } from './glb-bytes';

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is untyped */

export interface GlbCheck {
    ok: boolean;
    errors: string[];
    counts: { nodes: number; meshes: number; primitives: number; triangles: number; vertices: number; materials: number; images: number };
}

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const INDEX_TYPES = new Set([5121, 5123, 5125]);
const INT_TYPES = new Set([5120, 5121, 5122, 5123]);

export function checkGlbBytes(bytes: Uint8Array): GlbCheck {
    const errors: string[] = [];
    const counts = { nodes: 0, meshes: 0, primitives: 0, triangles: 0, vertices: 0, materials: 0, images: 0 };
    const fail = (): GlbCheck => ({ ok: false, errors, counts });
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes.byteLength < 20) { errors.push('shorter than a GLB header'); return fail(); }
    if (dv.getUint32(0, true) !== GLB_MAGIC) { errors.push('missing glTF magic'); return fail(); }
    if (dv.getUint32(4, true) !== 2) errors.push(`container version ${dv.getUint32(4, true)}, not 2`);
    if (dv.getUint32(8, true) !== bytes.byteLength) errors.push(`header length ${dv.getUint32(8, true)} != ${bytes.byteLength} bytes`);
    let json: any;
    let bin: Uint8Array | undefined;
    let o = 12, chunk = 0;
    while (o + 8 <= bytes.byteLength) {
        const len = dv.getUint32(o, true), type = dv.getUint32(o + 4, true);
        if (len % 4) errors.push(`chunk ${chunk} length ${len} is not a multiple of 4`);
        if (o + 8 + len > bytes.byteLength) { errors.push(`chunk ${chunk} runs past the end`); return fail(); }
        const data = bytes.subarray(o + 8, o + 8 + len);
        if (chunk === 0) {
            if (type !== CHUNK_JSON) { errors.push('the first chunk is not JSON'); return fail(); }
            try { json = JSON.parse(Buffer.from(data).toString('utf8')); } catch (err) { errors.push(`JSON chunk does not parse: ${(err as Error).message}`); return fail(); }
        } else if (chunk === 1 && type === CHUNK_BIN) bin = data;
        else if (type === CHUNK_BIN) errors.push('more than one BIN chunk');
        o += 8 + len;
        chunk++;
    }
    if (o !== bytes.byteLength) errors.push(`${bytes.byteLength - o} trailing bytes after the last chunk`);
    if (!json) { errors.push('no JSON chunk'); return fail(); }
    if (json.asset?.version !== '2.0') errors.push(`asset.version is ${JSON.stringify(json.asset?.version)}`);

    const arr = (k: string): any[] => (Array.isArray(json[k]) ? json[k] : []);
    const nodes = arr('nodes'), meshes = arr('meshes'), accessors = arr('accessors'), views = arr('bufferViews'), buffers = arr('buffers');
    const materials = arr('materials'), textures = arr('textures'), images = arr('images'), samplers = arr('samplers'), cameras = arr('cameras');
    counts.nodes = nodes.length; counts.meshes = meshes.length; counts.materials = materials.length; counts.images = images.length;
    const inRange = (what: string, i: unknown, list: unknown[]): boolean => {
        if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < list.length) return true;
        errors.push(`${what} ${JSON.stringify(i)} is out of range (${list.length})`);
        return false;
    };

    // buffers and views
    buffers.forEach((b, i) => {
        if (b.uri === undefined) {
            if (i !== 0) errors.push(`buffer ${i} has no uri (only buffer 0 may be the BIN chunk)`);
            else if (!bin) errors.push('buffer 0 refers to a BIN chunk the file does not have');
            else if (b.byteLength > bin.byteLength || bin.byteLength - b.byteLength > 3) errors.push(`buffer 0 byteLength ${b.byteLength} does not fit the BIN chunk (${bin.byteLength})`);
        }
    });
    views.forEach((v, i) => {
        if (!inRange(`bufferView ${i}: buffer`, v.buffer, buffers)) return;
        if ((v.byteOffset ?? 0) + v.byteLength > buffers[v.buffer].byteLength) errors.push(`bufferView ${i} runs past its buffer`);
        if (v.byteStride !== undefined && (v.byteStride < 4 || v.byteStride > 252 || v.byteStride % 4)) errors.push(`bufferView ${i} byteStride ${v.byteStride} is not 4..252 and a multiple of 4`);
    });

    // accessors
    const vertexAccessors = new Set<number>();
    for (const m of meshes) for (const p of m.primitives ?? []) {
        for (const ai of Object.values(p.attributes ?? {})) vertexAccessors.add(ai as number);
        for (const t of p.targets ?? []) for (const ai of Object.values(t)) vertexAccessors.add(ai as number);
    }
    accessors.forEach((a, i) => {
        const size = COMPONENT_BYTES[a.componentType], comps = TYPE_COMPONENTS[a.type];
        if (!size) { errors.push(`accessor ${i} componentType ${a.componentType} is not valid`); return; }
        if (!comps) { errors.push(`accessor ${i} type ${a.type} is not valid`); return; }
        if (!(a.count >= 1)) errors.push(`accessor ${i} count ${a.count} < 1`);
        if (a.normalized && !INT_TYPES.has(a.componentType)) errors.push(`accessor ${i} is normalized with a non-8/16-bit component type`);
        if (a.min && a.min.length !== comps) errors.push(`accessor ${i} min has ${a.min.length} values for ${comps} components`);
        if (a.max && a.max.length !== comps) errors.push(`accessor ${i} max has ${a.max.length} values for ${comps} components`);
        if (a.sparse) errors.push(`accessor ${i} is sparse (not expected in a stored object)`);
        if (a.bufferView === undefined) return;
        if (!inRange(`accessor ${i}: bufferView`, a.bufferView, views)) return;
        const v = views[a.bufferView];
        const elementBytes = size * comps;
        const stride = v.byteStride ?? elementBytes;
        const off = a.byteOffset ?? 0;
        if (off % size || ((v.byteOffset ?? 0) + off) % size) errors.push(`accessor ${i} is not aligned to its ${size}-byte components`);
        if (vertexAccessors.has(i) && (off % 4 || ((v.byteOffset ?? 0) + off) % 4 || stride % 4)) errors.push(`vertex attribute accessor ${i} is not aligned to 4 bytes`);
        if (v.byteStride !== undefined && v.byteStride < elementBytes) errors.push(`accessor ${i} elements (${elementBytes} bytes) are wider than the stride ${v.byteStride}`);
        if (off + stride * (a.count - 1) + elementBytes > v.byteLength) errors.push(`accessor ${i} runs past its bufferView`);
    });
    const parsed: ParsedGlb | undefined = bin ? { json, bin } : undefined;
    const read = (i: number) => (parsed ? readAccessor(parsed, i) : undefined);

    // meshes
    const declared = new Set<string>(arr('extensionsUsed'));
    for (const e of arr('extensionsRequired')) if (!declared.has(e)) errors.push(`extensionsRequired ${e} is not in extensionsUsed`);
    const usedExt = (where: string, ext: Record<string, unknown> | undefined) => { for (const k of Object.keys(ext ?? {})) if (!declared.has(k)) errors.push(`${where} uses ${k}, which extensionsUsed does not declare`); };
    meshes.forEach((m, mi) => {
        if (!Array.isArray(m.primitives) || !m.primitives.length) { errors.push(`mesh ${mi} has no primitives`); return; }
        m.primitives.forEach((p: any, pi: number) => {
            counts.primitives++;
            const where = `mesh ${mi} primitive ${pi}`;
            usedExt(where, p.extensions);
            const attrs = Object.entries(p.attributes ?? {}) as Array<[string, number]>;
            if (!attrs.length) errors.push(`${where} has no attributes`);
            let vcount: number | undefined;
            for (const [name, ai] of attrs) {
                if (!inRange(`${where} ${name}`, ai, accessors)) continue;
                const c = accessors[ai].count;
                if (vcount === undefined) vcount = c; else if (c !== vcount) errors.push(`${where} attribute ${name} has ${c} elements, others ${vcount}`);
            }
            const pos = p.attributes?.POSITION;
            if (pos !== undefined && accessors[pos]) {
                const a = accessors[pos];
                if (a.type !== 'VEC3') errors.push(`${where} POSITION is ${a.type}`);
                if (!a.min || !a.max) errors.push(`${where} POSITION has no min/max`);
                else {
                    const data = read(pos);
                    if (data) {
                        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
                        for (let e = 0; e < data.count; e++) for (let c = 0; c < 3; c++) { const x = data.data[e * 3 + c]; if (x < min[c]) min[c] = x; if (x > max[c]) max[c] = x; }
                        for (let c = 0; c < 3; c++) if (Math.abs(min[c] - a.min[c]) > 1e-6 * Math.max(1, Math.abs(min[c])) || Math.abs(max[c] - a.max[c]) > 1e-6 * Math.max(1, Math.abs(max[c]))) {
                            errors.push(`${where} POSITION min/max ${JSON.stringify([a.min, a.max])} do not match the data ${JSON.stringify([min, max])}`);
                            break;
                        }
                    }
                }
                counts.vertices += a.count;
            }
            const mode = p.mode ?? 4;
            if (p.indices !== undefined) {
                if (inRange(`${where} indices`, p.indices, accessors)) {
                    const a = accessors[p.indices];
                    if (a.type !== 'SCALAR' || !INDEX_TYPES.has(a.componentType)) errors.push(`${where} indices are ${a.type}/${a.componentType}`);
                    if (mode === 4 && a.count % 3) errors.push(`${where} has ${a.count} indices, not whole triangles`);
                    const data = read(p.indices);
                    if (data && vcount !== undefined) {
                        let bad = 0;
                        for (let e = 0; e < data.count; e++) if (data.data[e] >= vcount) bad++;
                        if (bad) errors.push(`${where} has ${bad} indices past its ${vcount} vertices`);
                    }
                    if (mode === 4) counts.triangles += Math.floor(a.count / 3);
                }
            } else if (mode === 4 && vcount !== undefined) {
                if (vcount % 3) errors.push(`${where} has ${vcount} vertices without indices, not whole triangles`);
                counts.triangles += Math.floor(vcount / 3);
            }
            if (p.material !== undefined) inRange(`${where} material`, p.material, materials);
        });
    });

    // materials, textures, images
    materials.forEach((m, i) => {
        usedExt(`material ${i}`, m.extensions);
        const walk = (o: any) => {
            if (!o || typeof o !== 'object') return;
            for (const [k, v] of Object.entries(o)) {
                if (v && typeof v === 'object' && /Texture$/.test(k) && 'index' in (v as object)) {
                    inRange(`material ${i} ${k}`, (v as { index: unknown }).index, textures);
                    usedExt(`material ${i} ${k}`, (v as any).extensions);
                } else walk(v);
            }
        };
        walk({ ...m, extras: undefined });
        // the staged layers' confidence map: a texture index in the material's extras
        const conf = m.extras?.sbTexture?.confidenceTexture;
        if (conf !== undefined) inRange(`material ${i} extras confidenceTexture`, conf, textures);
    });
    textures.forEach((t, i) => {
        usedExt(`texture ${i}`, t.extensions);
        if (t.source !== undefined) inRange(`texture ${i} source`, t.source, images);
        if (t.sampler !== undefined) inRange(`texture ${i} sampler`, t.sampler, samplers);
        for (const e of Object.values(t.extensions ?? {}) as any[]) if (e && e.source !== undefined) inRange(`texture ${i} extension source`, e.source, images);
    });
    images.forEach((im, i) => {
        if (im.bufferView !== undefined) {
            if (inRange(`image ${i} bufferView`, im.bufferView, views) && !im.mimeType) errors.push(`image ${i} is in a bufferView but has no mimeType`);
        } else if (typeof im.uri !== 'string') errors.push(`image ${i} has neither a bufferView nor a uri`);
    });

    // nodes and scenes
    const parent = new Int32Array(nodes.length).fill(-1);
    nodes.forEach((n, i) => {
        usedExt(`node ${i}`, n.extensions);
        if (n.mesh !== undefined) inRange(`node ${i} mesh`, n.mesh, meshes);
        if (n.camera !== undefined) inRange(`node ${i} camera`, n.camera, cameras);
        if (n.matrix && (n.translation || n.rotation || n.scale)) errors.push(`node ${i} has both a matrix and TRS`);
        if (n.matrix && n.matrix.length !== 16) errors.push(`node ${i} matrix has ${n.matrix.length} values`);
        for (const c of n.children ?? []) {
            if (!inRange(`node ${i} child`, c, nodes)) continue;
            if (c === i) errors.push(`node ${i} is its own child`);
            if (parent[c] >= 0) errors.push(`node ${c} has two parents (${parent[c]} and ${i})`);
            parent[c] = i;
        }
        const inst = n.extensions?.EXT_mesh_gpu_instancing;
        if (inst) {
            let ic: number | undefined;
            for (const [k, ai] of Object.entries(inst.attributes ?? {}) as Array<[string, number]>) {
                if (!inRange(`node ${i} instancing ${k}`, ai, accessors)) continue;
                const c = accessors[ai].count;
                if (ic === undefined) ic = c; else if (c !== ic) errors.push(`node ${i} instancing attribute ${k} has ${c} instances, others ${ic}`);
            }
        }
    });
    for (let i = 0; i < nodes.length; i++) {
        let p = parent[i], steps = 0;
        while (p >= 0 && steps <= nodes.length) { p = parent[p]; steps++; }
        if (steps > nodes.length) { errors.push(`node ${i} is in a cycle`); break; }
    }
    arr('scenes').forEach((s, si) => {
        for (const r of s.nodes ?? []) if (inRange(`scene ${si} node`, r, nodes) && parent[r] >= 0) errors.push(`scene ${si} root ${r} is a child of node ${parent[r]}`);
    });
    if (json.scene !== undefined) inRange('scene', json.scene, arr('scenes'));
    return { ok: errors.length === 0, errors, counts };
}
