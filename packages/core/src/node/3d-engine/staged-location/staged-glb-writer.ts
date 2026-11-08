/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A small binary glTF 2.0 writer for staged layers the server writes itself: one node per StagedGlbNode (TRIANGLES,
 * POSITION + NORMAL, optional extra float attributes), one studio clay material, node extras and root extras. Used for
 * the scanned trees put back after a failed tree stage (l5x): the raw scan triangles strip removed, written as they
 * were downloaded, in clay. It writes geometry it is given; it makes none.
 *
 * writeTexturedTwin (texture pass, task B) rewrites a clay GLB into its textured twin: the same nodes, names, extras and
 * clay vertex bytes (gathered by the atlas layout's source-vertex index, so border vertices are duplicated but never
 * changed), plus TEXCOORD_0, the baked images as in-memory PNGs and one PBR material. The clay writer above is unchanged.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { BakedTexturePlanes, SurfaceUvMap, TexturedTwinInput, WriteTexturedTwin } from '../../../common/spatial/texture-pass-contracts';
import { TEXTURE_LADDER_RUNGS } from '../../../common/spatial/texture-pass-contracts';
import { assembleGlb, gatherElements, parseGlbBytes } from './glb-bytes';
import { encodePng } from './png-encode';
import type { LaidOutUvAtlas } from './texture-uv';

export interface StagedGlbNode {
    name?: string;
    /** Tile-frame positions (x east, y up, z south), 3 per vertex. */
    positions: Float32Array;
    /** Triangle indices; omitted = consecutive triples. */
    indices?: Uint32Array;
    /** Unit normals, 3 per vertex; computed from the triangles when omitted. */
    normals?: Float32Array;
    /** Extra per-vertex float attributes (scalar), by glTF attribute name ("_FOO"). */
    attributes?: Record<string, Float32Array>;
    /** TEXCOORD_0, 2 per vertex: the node is drawn with the options' texture (glTF convention: (0, 0) the image's top left). */
    uv?: Float32Array;
    /** Node extras (StagedNodeExtras for staged layers). */
    extras?: unknown;
    /** COLOR_0, linear RGB 0..1, 3 per vertex: multiplies the material's base colour (glTF). */
    colors?: Float32Array;
    /**
     * The node drawn as several primitives, each with its own index list and one of the options' `materials` (by index
     * into that list): a surface with more than one material. Replaces `indices`; the vertices are shared.
     */
    parts?: Array<{ indices: Uint32Array; material: number }>;
    /** The whole node drawn with one of the options' `materials` (by index into that list) instead of the texture or clay. */
    material?: number;
}

/** An embedded image (JPEG or PNG bytes). */
export interface StagedGlbImage { bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png'; name?: string }

/**
 * A material written beside the clay and photo ones: a tiling PBR material (base colour, normal and metallic-roughness
 * maps, repeated) or a plain colour. Materials naming the same image object share it in the file.
 */
export interface StagedGlbMaterial {
    name: string;
    baseColorFactor?: [number, number, number, number];
    baseColor?: StagedGlbImage;
    normal?: StagedGlbImage;
    normalScale?: number;
    /** glTF metallicRoughness: G roughness, B metalness (times the factors). */
    metallicRoughness?: StagedGlbImage;
    roughness?: number;
    metallic?: number;
    doubleSided?: boolean;
    extras?: Record<string, unknown>;
}

export interface StagedGlbOptions {
    /** Root (scene) extras: StagedGlbRootExtras beside the frame extras. */
    rootExtras?: Record<string, unknown>;
    /** asset.extras. */
    assetExtras?: Record<string, unknown>;
    copyright?: string;
    generator?: string;
    /** One embedded base-colour texture for the nodes that carry `uv` (JPEG or PNG bytes). */
    texture?: { bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png' };
    /** The textured material's surface (default: roughness 0.9, not metallic, the texture clamped at its edges). */
    textureMaterial?: { roughness?: number; metallic?: number; repeat?: boolean };
    /** Further materials nodes name by `material` or `parts` (their textures repeat). */
    materials?: StagedGlbMaterial[];
    /** Small embedded images the materials' extras refer to (e.g. a confidence texture), by key: the texture index is written into `extras` where the string `@image:<key>` stands. */
    extraImages?: Record<string, StagedGlbImage>;
}

function pad4(buf: Buffer, fill = 0): Buffer {
    const rem = buf.length % 4;
    return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(4 - rem, fill)]);
}

function concatIndices(parts: Uint32Array[]): Uint32Array {
    const out = new Uint32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/** Area-weighted vertex normals of an indexed triangle mesh. */
export function vertexNormals(positions: Float32Array, indices: Uint32Array): Float32Array {
    const n = new Float32Array(positions.length);
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const i of [a, b, c]) { n[i] += nx; n[i + 1] += ny; n[i + 2] += nz; }
    }
    for (let i = 0; i < n.length; i += 3) {
        const l = Math.hypot(n[i], n[i + 1], n[i + 2]);
        if (l > 1e-20) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; } else { n[i + 1] = 1; }
    }
    return n;
}

export function writeStagedGlb(nodes: StagedGlbNode[], options: StagedGlbOptions = {}): Buffer {
    const chunks: Buffer[] = [];
    let binLength = 0;
    const bufferViews: any[] = [];
    const accessors: any[] = [];
    const meshes: any[] = [];
    const gltfNodes: any[] = [{ name: 'staged', children: [] as number[], ...(options.rootExtras ? { extras: options.rootExtras } : {}) }];
    let textured = false;
    const addView = (data: Buffer, target?: number): number => {
        bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.length, ...(target ? { target } : {}) });
        const padded = pad4(data);
        chunks.push(padded);
        binLength += padded.length;
        return bufferViews.length - 1;
    };
    const f32 = (a: Float32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
    for (const node of nodes) {
        const count = node.positions.length / 3;
        if (!Number.isInteger(count)) throw new Error('staged GLB: positions must hold 3 numbers per vertex');
        const indices = node.indices ?? (node.parts ? concatIndices(node.parts.map(p => p.indices)) : Uint32Array.from({ length: count - (count % 3) }, (_, i) => i));
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < node.positions.length; i += 3) {
            for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], node.positions[i + k]); max[k] = Math.max(max[k], node.positions[i + k]); }
        }
        const attributes: Record<string, number> = {};
        accessors.push({ bufferView: addView(f32(node.positions), 34962), componentType: 5126, count, type: 'VEC3', ...(count ? { min, max } : {}) });
        attributes.POSITION = accessors.length - 1;
        const normals = node.normals ?? vertexNormals(node.positions, indices);
        accessors.push({ bufferView: addView(f32(normals), 34962), componentType: 5126, count, type: 'VEC3' });
        attributes.NORMAL = accessors.length - 1;
        for (const [name, values] of Object.entries(node.attributes ?? {})) {
            if (values.length !== count) throw new Error(`staged GLB: attribute ${name} has ${values.length} values for ${count} vertices`);
            accessors.push({ bufferView: addView(f32(values), 34962), componentType: 5126, count, type: 'SCALAR' });
            attributes[name] = accessors.length - 1;
        }
        const ownMaterial = node.parts !== undefined || node.material !== undefined;
        for (const k of [node.material, ...(node.parts ?? []).map(p => p.material)]) {
            if (k !== undefined && !(options.materials && k >= 0 && k < options.materials.length)) throw new Error(`staged GLB: material ${k} is not among the ${options.materials?.length ?? 0} given`);
        }
        if (node.uv) {
            if (node.uv.length !== count * 2) throw new Error(`staged GLB: ${node.uv.length / 2} UVs for ${count} vertices`);
            if (!options.texture && !ownMaterial) throw new Error('staged GLB: a node carries UVs but no texture was given');
            accessors.push({ bufferView: addView(f32(node.uv), 34962), componentType: 5126, count, type: 'VEC2' });
            attributes.TEXCOORD_0 = accessors.length - 1;
            if (!ownMaterial) textured = true;
        }
        if (node.colors) {
            if (node.colors.length !== count * 3) throw new Error(`staged GLB: ${node.colors.length / 3} colours for ${count} vertices`);
            accessors.push({ bufferView: addView(f32(node.colors), 34962), componentType: 5126, count, type: 'VEC3' });
            attributes.COLOR_0 = accessors.length - 1;
        }
        const primitive = (idx: Uint32Array, material: number) => {
            accessors.push({ bufferView: addView(Buffer.from(idx.buffer, idx.byteOffset, idx.byteLength), 34963), componentType: 5125, count: idx.length, type: 'SCALAR' });
            return { attributes, indices: accessors.length - 1, mode: 4, material };
        };
        // materials: 0 clay, 1 the photo texture (when any node uses it; renumbered below), then options.materials
        if (node.parts) meshes.push({ primitives: node.parts.filter(p => p.indices.length).map(p => primitive(p.indices, -1 - p.material)) });
        else meshes.push({ primitives: [primitive(indices, node.material !== undefined ? -1 - node.material : node.uv ? 1 : 0)] });
        gltfNodes.push({ name: node.name ?? `node_${meshes.length - 1}`, mesh: meshes.length - 1, ...(node.extras !== undefined ? { extras: node.extras } : {}) });
        gltfNodes[0].children.push(gltfNodes.length - 1);
    }
    // the further materials, their images shared by object identity, and the extra images
    const firstOwn = textured ? 2 : 1;
    for (const m of meshes) for (const p of m.primitives) if (p.material < 0) p.material = firstOwn + (-1 - p.material);
    const images: any[] = [], textures: any[] = [];
    if (textured) {
        images.push({ bufferView: addView(Buffer.from(options.texture!.bytes)), mimeType: options.texture!.mimeType });
        textures.push({ source: 0, sampler: 0 });
    }
    const imageTexture = new Map<StagedGlbImage, number>();
    const textureOf = (im: StagedGlbImage, sampler: number): number => {
        const key = imageTexture.get(im);
        if (key !== undefined && textures[key].sampler === sampler) return key;
        images.push({ bufferView: addView(Buffer.from(im.bytes)), mimeType: im.mimeType, ...(im.name ? { name: im.name } : {}) });
        textures.push({ source: images.length - 1, sampler, ...(im.name ? { name: im.name } : {}) });
        imageTexture.set(im, textures.length - 1);
        return textures.length - 1;
    };
    const ownMaterials = options.materials ?? [];
    const extraImageIndex = new Map<string, number>();
    for (const [k, im] of Object.entries(options.extraImages ?? {})) extraImageIndex.set(k, textureOf(im, 2));
    const withImageRefs = (v: unknown): unknown => {
        if (typeof v === 'string' && v.startsWith('@image:')) { const i = extraImageIndex.get(v.slice(7)); if (i === undefined) throw new Error(`staged GLB: no extra image ${v.slice(7)}`); return i; }
        if (Array.isArray(v)) return v.map(withImageRefs);
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withImageRefs(x)]));
        return v;
    };
    const ownJson = ownMaterials.map(m => ({
        name: m.name, ...(m.doubleSided ? { doubleSided: true } : {}),
        pbrMetallicRoughness: {
            ...(m.baseColorFactor ? { baseColorFactor: m.baseColorFactor } : {}),
            ...(m.baseColor ? { baseColorTexture: { index: textureOf(m.baseColor, 1) } } : {}),
            ...(m.metallicRoughness ? { metallicRoughnessTexture: { index: textureOf(m.metallicRoughness, 1) } } : {}),
            metallicFactor: m.metallic ?? (m.metallicRoughness ? 1 : 0), roughnessFactor: m.roughness ?? (m.metallicRoughness ? 1 : 0.85)
        },
        ...(m.normal ? { normalTexture: { index: textureOf(m.normal, 1), ...(m.normalScale !== undefined ? { scale: m.normalScale } : {}) } } : {}),
        ...(m.extras ? { extras: withImageRefs(m.extras) } : {})
    }));
    const json = {
        asset: {
            version: '2.0', generator: options.generator ?? 'scratchbox-staged-location',
            ...(options.copyright ? { copyright: options.copyright } : {}),
            ...(options.assetExtras ? { extras: options.assetExtras } : {})
        },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: gltfNodes,
        meshes,
        materials: [
            { name: 'StudioGreyClay', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 } },
            ...(textured ? [{ name: 'PhotoTextured', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: options.textureMaterial?.metallic ?? 0, roughnessFactor: options.textureMaterial?.roughness ?? 0.9 } }] : []),
            ...ownJson
        ],
        ...(images.length ? {
            images,
            samplers: [
                { magFilter: 9729, minFilter: 9987, wrapS: options.textureMaterial?.repeat ? 10497 : 33071, wrapT: options.textureMaterial?.repeat ? 10497 : 33071 },
                // the further materials' maps tile
                { magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 },
                // raw lookups (a confidence texture): nearest, no mipmaps
                { magFilter: 9728, minFilter: 9728, wrapS: 33071, wrapT: 33071 }
            ],
            textures
        } : {}),
        accessors,
        bufferViews,
        buffers: [{ byteLength: binLength }]
    };
    const jsonBuf = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
    const bin = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write('glTF', 0, 'utf8');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + bin.length, 8);
    const jsonHeader = Buffer.alloc(8);
    jsonHeader.writeUInt32LE(jsonBuf.length, 0);
    jsonHeader.writeUInt32LE(0x4e4f534a, 4);
    const binHeader = Buffer.alloc(8);
    binHeader.writeUInt32LE(bin.length, 0);
    binHeader.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jsonHeader, jsonBuf, binHeader, bin]);
}

/** Writes the GLB through a temp file and a rename. */
export function writeStagedGlbFile(file: string, nodes: StagedGlbNode[], options: StagedGlbOptions = {}): { path: string; bytes: number } {
    const glb = writeStagedGlb(nodes, options);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmp, glb);
    fs.renameSync(tmp, file);
    return { path: file, bytes: glb.length };
}

// =============================================================================
// Textured twin (texture pass, task B)
// =============================================================================

/** Extra maps the twin can carry beside the contract's planes (same size as the atlas). */
export interface TexturedTwinOptions extends TexturedTwinInput {
    /** Tangent-space normal map, RGB or RGBA per texel. */
    normal?: Uint8Array;
    /** Roughness 0..255, one byte per texel. */
    roughness?: Uint8Array;
    /** Metalness 0..255, one byte per texel (written with the roughness, glTF metallicRoughness B). */
    metalness?: Uint8Array;
    /**
     * The facade material reading (facade-materials.ts): per-texel parameters for the viewer (RGBA: R glass weight, G coursing
     * index + 1, B metalness, A 255), the projected photo the reading replaced (the fallback, RGBA), the coursing profiles
     * (kernel output, RGB) with each reading's pitch and phase, and the reading's provenance entries.
     */
    material?: {
        params: Uint8Array;
        photoAlbedo?: Uint8Array;
        courses?: { image: { width: number; height: number; rgb: Uint8Array }; readings: Array<{ pitchM: number; phaseM: number; jointWidthM: number; jointDepthM: number }> };
        provenanceIndices: number[];
        summary?: Record<string, unknown>;
    };
}

/** What the material parameters image's channels mean (written beside it in the GLB). */
export const MATERIAL_PARAMS_CHANNELS = 'R = glass weight 0..255 (the region confidence), G = index + 1 into courses[] (0 = no coursing read), B = metalness 0..255, A = 255';

/** What the confidence image's channels mean (written beside it in the GLB). */
export const CONFIDENCE_CHANNELS = 'R = index into provenance[], G = weight 0..255, B = ladder rung (TEXTURE_LADDER_RUNGS), A = 255 where a stage produced the texel';

/** Albedo with gutter texels bled from their produced neighbours (planes are not modified). */
function bleedGutter(atlas: LaidOutUvAtlas, planes: BakedTexturePlanes): Uint8Array {
    const { width: W, height: H } = atlas;
    const rgba = Uint8Array.from(planes.albedo);
    const filled = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) filled[i] = atlas.texels.gutter[i] ? 0 : rgba[i * 4 + 3] ? 1 : 0;
    for (let pass = 0; pass <= atlas.layout.gutterTexels + 1; pass++) {
        const add: number[] = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (filled[i] || !atlas.texels.gutter[i]) continue;
            for (let dy = -1, found = false; dy <= 1 && !found; dy++) for (let dx = -1; dx <= 1; dx++) {
                const xx = x + dx, yy = y + dy;
                if ((dx || dy) && xx >= 0 && yy >= 0 && xx < W && yy < H && filled[yy * W + xx]) { add.push(i, yy * W + xx); found = true; break; }
            }
        }
        if (!add.length) break;
        for (let k = 0; k < add.length; k += 2) { rgba.copyWithin(add[k] * 4, add[k + 1] * 4, add[k + 1] * 4 + 4); filled[add[k]] = 1; }
    }
    return rgba;
}

function dropAlpha(rgba: Uint8Array, n: number): Uint8Array {
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { rgb[i * 3] = rgba[i * 4]; rgb[i * 3 + 1] = rgba[i * 4 + 1]; rgb[i * 3 + 2] = rgba[i * 4 + 2]; }
    return rgb;
}

/**
 * Writes the textured twin of a clay GLB (contract WriteTexturedTwin). The atlas must come from buildUvAtlas over the
 * same clay bytes (it carries the twin layout). Returns the GLB and the UV maps of the nodes that got textures.
 */
export function writeTexturedTwinGlb(input: TexturedTwinOptions): { glb: Buffer; uv: SurfaceUvMap[] } {
    const atlas = input.atlas as Partial<LaidOutUvAtlas> as LaidOutUvAtlas;
    if (!atlas.layout) throw new Error('the UV atlas has no twin layout; build it with buildUvAtlas over the clay GLB');
    const clayGlb = input.clayGlb;
    const sha = crypto.createHash('sha256').update(clayGlb).digest('hex');
    if (sha !== atlas.layout.claySha256) throw new Error('the UV atlas was laid out over a different clay GLB');
    const { planes } = input;
    const W = atlas.width, H = atlas.height, N = W * H;
    if (planes.width !== W || planes.height !== H) throw new Error(`the baked planes are ${planes.width}x${planes.height}, the atlas is ${W}x${H}`);
    if (planes.albedo.length !== N * 4 || planes.confidence.data.length !== N * 4) throw new Error('the baked planes are not RGBA8 of the atlas size');
    if (input.normal && input.normal.length !== N * 3 && input.normal.length !== N * 4) throw new Error('the normal map is not RGB or RGBA of the atlas size');
    if (input.roughness && input.roughness.length !== N) throw new Error('the roughness map is not one byte per atlas texel');
    if (input.metalness && input.metalness.length !== N) throw new Error('the metalness map is not one byte per atlas texel');
    if (input.material && input.material.params.length !== N * 4) throw new Error('the material parameters are not RGBA of the atlas size');

    const clay = parseGlbBytes(clayGlb);
    const json = JSON.parse(JSON.stringify(clay.json));
    const chunks: Buffer[] = [];
    let binLength = 0;
    const views: any[] = [];
    const accessors: any[] = [];
    const addView = (bytes: Uint8Array | Float32Array | Uint32Array, target?: number): number => {
        views.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
        const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const padded = b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b;
        chunks.push(padded);
        binLength += padded.length;
        return views.length - 1;
    };
    const origTarget = (i: number) => clay.json.bufferViews?.[clay.json.accessors[i].bufferView]?.target;
    const copied = new Map<number, number>();
    const copyAccessor = (i: number): number => {
        if (copied.has(i)) return copied.get(i)!;
        const a = clay.json.accessors[i];
        const { bufferView: _v, byteOffset: _o, ...rest } = a;
        accessors.push({ ...rest, bufferView: addView(gatherElements(clay, i, undefined), origTarget(i)) });
        copied.set(i, accessors.length - 1);
        return accessors.length - 1;
    };
    const gatherAccessor = (i: number, order: Uint32Array, isPosition: boolean): number => {
        const a = clay.json.accessors[i];
        const bytes = gatherElements(clay, i, order);
        const { bufferView: _v, byteOffset: _o, min: _mn, max: _mx, ...rest } = a;
        // vertex attribute elements start on 4-byte boundaries: pad 1/2/3/6-byte elements with a byteStride
        const el = order.length ? bytes.length / order.length : 0;
        let view: number;
        if (el % 4) {
            const stride = el + (4 - (el % 4));
            const padded = new Uint8Array(stride * order.length);
            for (let k = 0; k < order.length; k++) padded.set(bytes.subarray(k * el, (k + 1) * el), k * stride);
            view = addView(padded, 34962);
            views[view].byteStride = stride;
        } else {
            view = addView(bytes, 34962);
        }
        const acc: any = { ...rest, count: order.length, bufferView: view };
        if (isPosition && order.length) {
            const f = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
            const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
            for (let k = 0; k < f.length; k += 3) for (let c = 0; c < 3; c++) { mn[c] = Math.min(mn[c], f[k + c]); mx[c] = Math.max(mx[c], f[k + c]); }
            acc.min = mn; acc.max = mx;
        }
        accessors.push(acc);
        return accessors.length - 1;
    };

    // images and the material
    const images: Array<{ name: string; png: Buffer }> = [
        { name: `${planes.layerKey}_albedo`, png: encodePng(W, H, dropAlpha(bleedGutter(atlas, planes), N), 3) },
        { name: `${planes.layerKey}_confidence`, png: encodePng(W, H, planes.confidence.data, 4) }
    ];
    if (input.normal) images.push({ name: `${planes.layerKey}_normal`, png: encodePng(W, H, input.normal.length === N * 4 ? dropAlpha(input.normal, N) : input.normal, 3) });
    if (input.roughness) {
        const mr = new Uint8Array(N * 3);
        // glTF metallicRoughness: G = roughness, B = metalness
        for (let i = 0; i < N; i++) { mr[i * 3 + 1] = input.roughness[i]; mr[i * 3 + 2] = input.metalness ? input.metalness[i] : 0; }
        images.push({ name: `${planes.layerKey}_roughness`, png: encodePng(W, H, mr, 3) });
    }
    if (input.material) {
        images.push({ name: `${planes.layerKey}_material`, png: encodePng(W, H, input.material.params, 4) });
        if (input.material.photoAlbedo) images.push({ name: `${planes.layerKey}_photo`, png: encodePng(W, H, dropAlpha(bleedGutter(atlas, { ...planes, albedo: input.material.photoAlbedo }), N), 3) });
        const c = input.material.courses;
        if (c) images.push({ name: `${planes.layerKey}_courses`, png: encodePng(c.image.width, c.image.height, c.image.rgb, 3) });
    }
    json.images = json.images ?? [];
    json.samplers = json.samplers ?? [];
    json.textures = json.textures ?? [];
    json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 });
    const sampler = json.samplers.length - 1;
    const textureOf: Record<string, number> = {};
    // pre-existing embedded images of the clay GLB keep their bytes
    for (const img of json.images) if (img.bufferView !== undefined) img.bufferView = addView(clay.bin.subarray(clay.json.bufferViews[img.bufferView].byteOffset ?? 0, (clay.json.bufferViews[img.bufferView].byteOffset ?? 0) + clay.json.bufferViews[img.bufferView].byteLength));
    for (const img of images) {
        json.images.push({ name: img.name, mimeType: 'image/png', bufferView: addView(img.png) });
        json.textures.push({ sampler, source: json.images.length - 1, name: img.name });
        textureOf[img.name.slice(planes.layerKey.length + 1)] = json.textures.length - 1;
    }
    json.materials = json.materials ?? [];
    json.materials.push({
        name: 'StagedTexturedPhoto',
        // drawn from both sides like the clay it swaps with (the clay pass renders double-sided): a primitive wound inside
        // out (some native detail solids are) would otherwise show its far inner faces, the wall behind it, as if see-through
        doubleSided: true,
        pbrMetallicRoughness: {
            baseColorTexture: { index: textureOf.albedo, texCoord: 0 },
            metallicFactor: textureOf.roughness !== undefined && input.metalness ? 1 : 0,
            roughnessFactor: textureOf.roughness !== undefined ? 1 : 0.85,
            ...(textureOf.roughness !== undefined ? { metallicRoughnessTexture: { index: textureOf.roughness, texCoord: 0 } } : {})
        },
        ...(textureOf.normal !== undefined ? { normalTexture: { index: textureOf.normal, texCoord: 0 } } : {}),
        extras: {
            sbTexture: { confidenceTexture: textureOf.confidence, confidenceChannels: CONFIDENCE_CHANNELS },
            ...(input.material ? { sbMaterial: {
                schema: 'scratchbox.staged-material/1', paramsTexture: textureOf.material, paramsChannels: MATERIAL_PARAMS_CHANNELS,
                ...(textureOf.photo !== undefined ? { photoFallbackTexture: textureOf.photo } : {}),
                ...(textureOf.courses !== undefined && input.material.courses ? { courseTexture: textureOf.courses, courses: input.material.courses.readings } : {}),
                provenanceIndices: input.material.provenanceIndices,
                ...(input.material.summary ? { summary: input.material.summary } : {})
            } } : {})
        }
    });
    const texturedMaterial = json.materials.length - 1;

    // meshes: laid-out primitives gathered by source vertex; the rest copied as they are
    const laid = new Map(atlas.layout.primitives.map(p => [`${p.meshIndex}:${p.primitiveIndex}`, p]));
    (json.meshes ?? []).forEach((mesh: any, mi: number) => {
        mesh.primitives.forEach((prim: any, pi: number) => {
            const L = laid.get(`${mi}:${pi}`);
            const orig = clay.json.meshes[mi].primitives[pi];
            if (!L) {
                for (const k of Object.keys(prim.attributes ?? {})) prim.attributes[k] = copyAccessor(orig.attributes[k]);
                if (orig.indices !== undefined) prim.indices = copyAccessor(orig.indices);
                prim.targets = orig.targets?.map((t: Record<string, number>) => Object.fromEntries(Object.entries(t).map(([k, a]) => [k, copyAccessor(a)])));
                if (!prim.targets) delete prim.targets;
                return;
            }
            const attributes: Record<string, number> = {};
            for (const [k, a] of Object.entries(orig.attributes as Record<string, number>)) {
                if (k === 'TEXCOORD_0') continue;
                attributes[k] = gatherAccessor(a, L.sourceVertex, k === 'POSITION');
            }
            accessors.push({ bufferView: addView(L.uv, 34962), componentType: 5126, count: L.sourceVertex.length, type: 'VEC2' });
            attributes.TEXCOORD_0 = accessors.length - 1;
            prim.attributes = attributes;
            accessors.push({ bufferView: addView(L.indices, 34963), componentType: 5125, count: L.indices.length, type: 'SCALAR' });
            prim.indices = accessors.length - 1;
            if (orig.targets) prim.targets = orig.targets.map((t: Record<string, number>) => Object.fromEntries(Object.entries(t).map(([k, a]) => [k, gatherAccessor(a, L.sourceVertex, false)])));
            prim.material = texturedMaterial;
            prim.mode = 4;
        });
    });
    for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = copyAccessor(skin.inverseBindMatrices);
    for (const anim of json.animations ?? []) for (const s of anim.samplers ?? []) { s.input = copyAccessor(s.input); s.output = copyAccessor(s.output); }

    // per-node texture extras: the map, the provenance list and the measured share of each provenance entry on the node
    const conf = planes.confidence.data;
    const shares = atlas.maps.map(() => ({ texels: 0, labelled: new Map<number, number>(), unproduced: 0 }));
    for (let i = 0; i < N; i++) {
        const m = atlas.texels.mapIndex[i];
        if (m === 65535 || atlas.texels.gutter[i] || !atlas.texels.covered[i]) continue;
        const s = shares[m];
        s.texels++;
        if (conf[i * 4 + 3]) s.labelled.set(conf[i * 4], (s.labelled.get(conf[i * 4]) ?? 0) + 1); else s.unproduced++;
    }
    const usedMaps = new Set(atlas.layout.primitives.map(p => p.mapIndex));
    const nodeMap = new Map(atlas.layout.primitives.map(p => [p.nodeIndex, p.mapIndex]));
    for (const [nodeIndex, mapIndex] of nodeMap) {
        const node = json.nodes[nodeIndex];
        const s = shares[mapIndex];
        const sbTexture = {
            schema: 'scratchbox.staged-texture-node/1', layerKey: planes.layerKey, map: atlas.maps[mapIndex],
            provenance: planes.provenance,
            texelProvenance: [...s.labelled.entries()].sort((a, b) => a[0] - b[0]).map(([provenanceIndex, n]) => ({ provenanceIndex, share: s.texels ? n / s.texels : 0 })),
            unproducedShare: s.texels ? s.unproduced / s.texels : 0,
            confidenceTexture: textureOf.confidence, confidenceChannels: CONFIDENCE_CHANNELS
        };
        if (node.extras === undefined || (typeof node.extras === 'object' && node.extras !== null && !Array.isArray(node.extras))) node.extras = { ...(node.extras ?? {}), sbTexture };
    }
    json.asset = json.asset ?? { version: '2.0' };
    json.asset.extras = {
        ...(json.asset.extras ?? {}),
        sbTexture: {
            schema: 'scratchbox.staged-texture/1', layerKey: planes.layerKey, width: W, height: H, provenance: planes.provenance, degradations: planes.degradations,
            ...(planes.paletteDeltaE !== undefined ? { paletteDeltaE: planes.paletteDeltaE } : {}),
            ladder: TEXTURE_LADDER_RUNGS, confidenceTexture: textureOf.confidence, confidenceChannels: CONFIDENCE_CHANNELS,
            untextured: atlas.layout.untextured, uvStats: { ...atlas.layout.stats }
        }
    };
    json.accessors = accessors;
    json.bufferViews = views;
    json.buffers = [{ byteLength: binLength }];
    return { glb: assembleGlb(json, Buffer.concat(chunks)), uv: atlas.maps.filter((_, i) => usedMaps.has(i)) };
}

/** The contract seam (WriteTexturedTwin): bytes are built in memory; nothing touches the disk. */
export const writeTexturedTwin: WriteTexturedTwin = async input => {
    const r = writeTexturedTwinGlb(input as TexturedTwinOptions);
    return { glb: new Uint8Array(r.glb.buffer, r.glb.byteOffset, r.glb.byteLength), uv: r.uv };
};
