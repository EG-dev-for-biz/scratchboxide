/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E's layer GLBs from the native massing's nodes: the clay layer (studio grey, node extras with each node's
 * provenance) and its textured twin (the same nodes, names and position bytes, plus TEXCOORD_0 into texture pages that
 * pack the faces' textures, and the tile's own photos for the scanned residual). Every material of the twin carries a
 * confidence texture (R provenance index, G weight, B ladder rung, A produced), so the viewport keeps the photo material and
 * can shade texels by where they came from.
 */

import { TEXTURE_LADDER_RUNGS } from '../../../../common/spatial/texture-pass-contracts';
import type { ProvenanceRecord, StagedNodeExtras } from '../../../../common/spatial/staged-location-contracts';
import { assembleGlb } from '../glb-bytes';
import { encodePng } from '../png-encode';
import { CONFIDENCE_CHANNELS, writeStagedGlb, type StagedGlbNode } from '../staged-glb-writer';
import type { MassingFace, MassingNode } from './native-massing';

/** One face's texture: RGBA (A 255 = produced) and, per texel, an index into the legend (255 = none). */
export interface FaceTexture { width: number; height: number; rgba: Uint8Array; source: Uint8Array }

/** Where a texel came from (open strings), with the ladder rung it counts as. */
export interface TexelSource { source: string; label: string; method: string; rung: number; weight: number }

export interface PackedPage { width: number; height: number; rgba: Uint8Array; conf: Uint8Array }
export interface Packing { pages: PackedPage[]; place: Map<number, { page: number; x: number; y: number; scale: number }> }

const GUTTER = 2;

/** Shelf packing of the face textures into pages of at most `maxSide` (faces larger than a page are scaled down). */
export function packFaces(textures: Map<number, FaceTexture>, legend: TexelSource[], maxSide = 4096): Packing {
    const items = [...textures.entries()].map(([face, t]) => {
        const scale = Math.min(1, (maxSide - 2 * GUTTER) / Math.max(t.width, t.height));
        return { face, t, scale, w: Math.max(1, Math.round(t.width * scale)), h: Math.max(1, Math.round(t.height * scale)) };
    }).sort((a, b) => b.h - a.h || b.w - a.w);
    const place = new Map<number, { page: number; x: number; y: number; scale: number }>();
    const shelves: Array<{ page: number; y: number; h: number; x: number }> = [];
    const pageH: number[] = [];
    for (const it of items) {
        const W = it.w + 2 * GUTTER, H = it.h + 2 * GUTTER;
        let shelf = shelves.find(s => s.h >= H && s.x + W <= maxSide);
        if (!shelf) {
            let page = pageH.length - 1;
            if (page < 0 || pageH[page] + H > maxSide) { pageH.push(0); page = pageH.length - 1; }
            shelf = { page, y: pageH[page], h: H, x: 0 };
            pageH[page] += H;
            shelves.push(shelf);
        }
        place.set(it.face, { page: shelf.page, x: shelf.x + GUTTER, y: shelf.y + GUTTER, scale: it.scale });
        shelf.x += W;
    }
    // pages: the full width (a power of two), as tall as their shelves (rounded up to a power of two)
    const pages: PackedPage[] = pageH.map(h => {
        const width = maxSide, height = Math.min(maxSide, Math.max(4, nextPow2(h)));
        return { width, height, rgba: new Uint8Array(width * height * 4), conf: new Uint8Array(width * height * 4) };
    });
    for (const it of items) {
        const pl = place.get(it.face)!;
        const page = pages[pl.page];
        // nearest resample into place, the gutter repeating the edge texels
        for (let y = -GUTTER; y < it.h + GUTTER; y++) for (let x = -GUTTER; x < it.w + GUTTER; x++) {
            const sx = Math.min(it.t.width - 1, Math.max(0, Math.floor(((x + 0.5) / it.w) * it.t.width)));
            const sy = Math.min(it.t.height - 1, Math.max(0, Math.floor(((y + 0.5) / it.h) * it.t.height)));
            const px = pl.x + x, py = pl.y + y;
            if (px < 0 || py < 0 || px >= page.width || py >= page.height) continue;
            const si = sy * it.t.width + sx, di = py * page.width + px;
            page.rgba.set(it.t.rgba.subarray(si * 4, si * 4 + 4), di * 4);
            page.rgba[di * 4 + 3] = 255;
            const src = it.t.source[si];
            const L = legend[src];
            if (L) { page.conf[di * 4] = src; page.conf[di * 4 + 1] = Math.round(255 * L.weight); page.conf[di * 4 + 2] = L.rung; page.conf[di * 4 + 3] = 255; }
            else { page.conf[di * 4 + 2] = TEXTURE_LADDER_RUNGS.length - 1; }
        }
    }
    return { pages, place };
}

function nextPow2(v: number): number { let p = 1; while (p < v) p <<= 1; return p; }

export interface MassingGlbInput {
    nodes: MassingNode[];
    faces: MassingFace[];
    /** The stage that made the layer and its key (root extras). */
    stage: string;
    stageKey: string;
    /** Per node: its provenance record (open labels). */
    provenanceOf: (node: MassingNode) => ProvenanceRecord;
    /** Face textures by face index; the residual's tile photos by tile image index. */
    textures: Map<number, FaceTexture>;
    legend: TexelSource[];
    tileImages: Map<number, { bytes: Uint8Array; mimeType: string }>;
    /** The legend index the tile photo (residual) counts as. */
    tileLegendIndex: number;
}

function nodeExtras(input: MassingGlbInput, node: MassingNode, order: number, count: number): StagedNodeExtras {
    return {
        sb: {
            schema: 'scratchbox.staged-node/2', stage: input.stage, provenance: input.provenanceOf(node), buildOrder: order, buildCount: count,
            revealKind: node.kind === 'residual' ? 'appear' : 'rise', reveal: { attribute: null, displacement: null, durationShare: 1 / Math.max(1, count) },
            ids: { surfaceId: node.name }, counts: { vertices: node.positions.length / 3, triangles: node.indices.length / 3 }
        }
    };
}

/** The clay layer GLB: studio grey, one node per massing node. */
export function writeMassingClayGlb(input: MassingGlbInput): Buffer {
    const nodes: StagedGlbNode[] = input.nodes.map((n, i) => ({ name: n.name, positions: n.positions, normals: n.normals, indices: n.indices, extras: nodeExtras(input, n, i, input.nodes.length) }));
    return writeStagedGlb(nodes, { rootExtras: { sb: { schema: 'scratchbox.staged-glb/2', stage: input.stage, stageKey: input.stageKey, frame: 'tile frame: x east, y up, z south (metres)' } } });
}

/** The textured twin: same nodes and positions, TEXCOORD_0, page and tile-photo materials with confidence textures. */
export function writeMassingTexturedGlb(input: MassingGlbInput): { glb: Buffer; packing: Packing; shares: number[] } {
    const packing = packFaces(input.textures, input.legend);
    const chunks: Buffer[] = [];
    let binLength = 0;
    const bufferViews: any[] = [], accessors: any[] = [], meshes: any[] = [], images: any[] = [], textures: any[] = [], materials: any[] = [];  // eslint-disable-line @typescript-eslint/no-explicit-any
    const addView = (data: Uint8Array, target?: number): number => {
        const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: buf.length, ...(target ? { target } : {}) });
        const padded = buf.length % 4 ? Buffer.concat([buf, Buffer.alloc(4 - (buf.length % 4))]) : buf;
        chunks.push(padded);
        binLength += padded.length;
        return bufferViews.length - 1;
    };
    const sampler = 0;
    const addTexture = (bytes: Uint8Array, mimeType: string, name: string): number => {
        images.push({ name, mimeType, bufferView: addView(bytes) });
        textures.push({ sampler, source: images.length - 1, name });
        return textures.length - 1;
    };
    const pageMaterial: number[] = packing.pages.map((p, k) => {
        const albedo = addTexture(new Uint8Array(encodePng(p.width, p.height, Buffer.from(p.rgba), 4)), 'image/png', `page_${k}_albedo`);
        const conf = addTexture(new Uint8Array(encodePng(p.width, p.height, Buffer.from(p.conf), 4)), 'image/png', `page_${k}_confidence`);
        materials.push({ name: `MassingPage${k}`, doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: albedo, texCoord: 0 }, metallicFactor: 0, roughnessFactor: 0.85 }, extras: { sbTexture: { confidenceTexture: conf, confidenceChannels: CONFIDENCE_CHANNELS } } });
        return materials.length - 1;
    });
    const tileConf = (() => {
        const L = input.legend[input.tileLegendIndex];
        const px = new Uint8Array([input.tileLegendIndex, Math.round(255 * (L?.weight ?? 0.5)), L?.rung ?? 2, 255]);
        return addTexture(new Uint8Array(encodePng(1, 1, Buffer.from(px), 4)), 'image/png', 'tile_confidence');
    })();
    const tileMaterial = new Map<number, number>();
    for (const [img, t] of input.tileImages) {
        const tex = addTexture(t.bytes, t.mimeType, `tile_${img}`);
        materials.push({ name: `TilePhoto${img}`, doubleSided: true, pbrMetallicRoughness: { baseColorTexture: { index: tex, texCoord: 0 }, metallicFactor: 0, roughnessFactor: 0.9 }, extras: { sbTexture: { confidenceTexture: tileConf, confidenceChannels: CONFIDENCE_CHANNELS } } });
        tileMaterial.set(img, materials.length - 1);
    }
    const flat = materials.length;
    materials.push({ name: 'StudioGreyClay', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 } });
    const f32 = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const gltfNodes: any[] = [{ name: 'staged', children: [] as number[], extras: { sb: { schema: 'scratchbox.staged-glb/2', stage: input.stage, stageKey: input.stageKey, frame: 'tile frame: x east, y up, z south (metres)' } } }];  // eslint-disable-line @typescript-eslint/no-explicit-any
    const facesByIndex = new Map(input.faces.map(f => [f.index, f]));
    const texelCount = new Array<number>(TEXTURE_LADDER_RUNGS.length).fill(0);
    input.nodes.forEach((node, ni) => {
        const n = node.positions.length / 3;
        const uv = new Float32Array(n * 2);
        // a node is drawn with one material: its page, or its tile photo, or clay
        let material = flat;
        for (let v = 0; v < n; v++) {
            const ref = node.ref[v];
            if (ref <= -2) {
                material = tileMaterial.get(-ref - 2) ?? flat;
                uv[2 * v] = node.st[2 * v]; uv[2 * v + 1] = node.st[2 * v + 1];
                continue;
            }
            const face = facesByIndex.get(ref), pl = packing.place.get(ref);
            if (!face || !pl || !face.width) continue;
            const page = packing.pages[pl.page];
            material = pageMaterial[pl.page];
            const fx = ((node.st[2 * v] - face.orthoSMin) / face.pixel) * pl.scale, fy = ((face.orthoTMax - node.st[2 * v + 1]) / face.pixel) * pl.scale;
            uv[2 * v] = (pl.x + fx) / page.width;
            uv[2 * v + 1] = (pl.y + fy) / page.height;
        }
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < node.positions.length; i += 3) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], node.positions[i + k]); max[k] = Math.max(max[k], node.positions[i + k]); }
        const attributes: Record<string, number> = {};
        accessors.push({ bufferView: addView(f32(node.positions), 34962), componentType: 5126, count: n, type: 'VEC3', ...(n ? { min, max } : {}) });
        attributes.POSITION = accessors.length - 1;
        accessors.push({ bufferView: addView(f32(node.normals), 34962), componentType: 5126, count: n, type: 'VEC3' });
        attributes.NORMAL = accessors.length - 1;
        accessors.push({ bufferView: addView(f32(uv), 34962), componentType: 5126, count: n, type: 'VEC2' });
        attributes.TEXCOORD_0 = accessors.length - 1;
        accessors.push({ bufferView: addView(new Uint8Array(node.indices.buffer, node.indices.byteOffset, node.indices.byteLength), 34963), componentType: 5125, count: node.indices.length, type: 'SCALAR' });
        meshes.push({ primitives: [{ attributes, indices: accessors.length - 1, mode: 4, material }] });
        gltfNodes.push({ name: node.name, mesh: meshes.length - 1, extras: nodeExtras(input, node, ni, input.nodes.length) });
        gltfNodes[0].children.push(gltfNodes.length - 1);
    });
    for (const p of packing.pages) for (let i = 0; i < p.conf.length; i += 4) if (p.rgba[i + 3]) texelCount[p.conf[i + 2]]++;
    const total = texelCount.reduce((a, b) => a + b, 0) || 1;
    const json = {
        asset: { version: '2.0', generator: 'scratchbox-staged-location pipeline E' },
        scene: 0, scenes: [{ nodes: [0] }], nodes: gltfNodes, meshes, materials, textures, images,
        samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 }],
        accessors, bufferViews, buffers: [{ byteLength: binLength }]
    };
    return { glb: assembleGlb(json, new Uint8Array(Buffer.concat(chunks))), packing, shares: texelCount.map(c => c / total) };
}
