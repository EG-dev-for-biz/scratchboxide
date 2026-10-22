/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Surface grit for a 3D asset: the weathering read from a reference photo of the real thing (a Street View frame, a
 * survey station) painted by an image model as ONE large grayscale grime map that does not tile, then baked into the asset
 * as a decal: a skin GRIT_OFFSET_M off every near-vertical face, black, its opacity the map's darkness. A plain glTF
 * blended material, so any viewer and the app show it; the library materials under it keep their own detail. The decal is
 * labelled generated.
 */

import { readGlbChunks, readTileTriangles, type RgbaImage8 } from './staged-location/tile-texture-transfer';
import { decodeImageInMemory } from './staged-location/tile-texture-transfer';
import { encodePng } from '../texture-processing';
import { resizeRgba } from './staged-location/texture-enhance';
import { generateImageWithModels } from '../google-media-generation-service';

/** The decal stands this far off its face, along the face's normal. */
export const GRIT_OFFSET_M = 0.01;
/** The decal's darkest opacity (where the map is black). */
export const GRIT_DEFAULT_STRENGTH = 0.8;
/** A face is a wall (decalled) when its normal's vertical component is at most this. */
export const GRIT_MAX_NORMAL_Y = 0.3;
/** The decal texture's side. */
export const GRIT_MAP_SIDE = 2048;

/** The weathering asked for when none is described: city grime on an old facade. */
export const GRIT_DEFAULT_WEATHERING = 'heavier soot near the bottom and in a band just under the top edge, long vertical rain streaks running down from a few points along the top, irregular soft blotches and faint speckle elsewhere, each streak and blotch different';

/** The prompt for one grime map `widthM` x `heightM`: what to paint is `weathering` (open text), read from the photo when one is given. */
export const gritPrompt = (widthM: number, heightM: number, weathering = GRIT_DEFAULT_WEATHERING, withReference = true): string =>
    `${withReference ? 'The photo shows the real surface and its weathering. Paint ONLY that weathering' : 'Paint ONLY surface weathering'} as ONE grayscale map for a whole ${Math.round(widthM)} by ${Math.round(heightM)} metre surface, seen straight on, NOT tiling and with nothing repeated: white where the surface is clean, darker where the weathering is. ` +
    `The weathering: ${weathering}. ` +
    'No bricks, no joints, no windows, no architecture, no perspective, no objects, no text: only the weathering, mostly light (average about 80 percent white).';

/** The grime map from a reference photo (an image-model call). */
export async function generateGritMap(input: {
    client: unknown; models: string[]; reference?: { bytes: Uint8Array; mimeType: string }; widthM: number; heightM: number; weathering?: string; signal?: AbortSignal;
}): Promise<{ map: RgbaImage8; modelUsed: string; modelNote: string }> {
    const answer = await generateImageWithModels(input.client, {
        models: input.models,
        contents: [{ text: gritPrompt(input.widthM, input.heightM, input.weathering, !!input.reference) }, ...(input.reference ? [{ inlineData: { mimeType: input.reference.mimeType, data: Buffer.from(input.reference.bytes).toString('base64') } }] : [])],
        imageConfig: { aspectRatio: '1:1' }, signal: input.signal
    });
    return { map: decodeImageInMemory(new Uint8Array(answer.data)), modelUsed: answer.modelUsed, modelNote: answer.modelNote };
}

export interface GritBakeResult { glb: Buffer; decalTriangles: number; widthM: number; heightM: number }

/**
 * Bakes `grime` (white = clean) into `glb` as a decal node: every near-vertical triangle of the nodes `keep` accepts
 * (default: all but openings and glass), offset along its normal, mapped once across the asset's width (along its wall
 * direction, mirrored on the opposite side) and height.
 */
export function bakeGritDecal(glb: Uint8Array, grime: RgbaImage8, opts: { strength?: number; keep?: (nodeName: string) => boolean; method?: string; /** sRGB colour of the grit (default black). */ colour?: [number, number, number]; maxNormalY?: number; offsetM?: number } = {}): GritBakeResult {
    const strength = Math.max(0, Math.min(1, opts.strength ?? GRIT_DEFAULT_STRENGTH));
    const keep = opts.keep ?? ((n: string) => !/opening|glass/i.test(n));
    const { json, bin } = readGlbChunks(glb);
    const names: string[] = (json.nodes ?? []).map((n: { name?: string }) => n.name ?? '');
    const t = readTileTriangles(glb, { nodeTags: true });
    const nTri = t.positions.length / 9;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < t.positions.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], t.positions[i + k]); hi[k] = Math.max(hi[k], t.positions[i + k]); }
    const pos: number[] = [], nor: number[] = [], uv: number[] = [];
    for (let k = 0; k < nTri; k++) {
        const nx = t.normals[k * 3], ny = t.normals[k * 3 + 1], nz = t.normals[k * 3 + 2];
        if (Math.abs(ny) > (opts.maxNormalY ?? GRIT_MAX_NORMAL_Y) || !keep(names[t.node[k]] ?? '')) continue;
        const alongZ = Math.abs(nx) > Math.abs(nz);
        for (let v = 0; v < 3; v++) {
            const x = t.positions[k * 9 + v * 3], y = t.positions[k * 9 + v * 3 + 1], z = t.positions[k * 9 + v * 3 + 2];
            const off = opts.offsetM ?? GRIT_OFFSET_M;
            pos.push(x + nx * off, y + ny * off, z + nz * off);
            nor.push(nx, ny, nz);
            let u = alongZ ? (z - lo[2]) / Math.max(1e-6, hi[2] - lo[2]) : (x - lo[0]) / Math.max(1e-6, hi[0] - lo[0]);
            if ((alongZ ? nx : -nz) < 0) u = 1 - u;
            uv.push(u, 1 - (y - lo[1]) / Math.max(1e-6, hi[1] - lo[1]));
        }
    }
    const widthM = Math.max(hi[0] - lo[0], hi[2] - lo[2]), heightM = hi[1] - lo[1];
    if (!pos.length) return { glb: Buffer.from(glb), decalTriangles: 0, widthM, heightM };

    // the decal texture: black, its opacity the map's darkness
    const g = resizeRgba(grime, GRIT_MAP_SIDE, GRIT_MAP_SIDE);
    const rgba = Buffer.alloc(GRIT_MAP_SIDE * GRIT_MAP_SIDE * 4);
    for (let i = 0; i < GRIT_MAP_SIDE * GRIT_MAP_SIDE; i++) {
        const lum = (0.2126 * g.rgba[i * 4] + 0.7152 * g.rgba[i * 4 + 1] + 0.0722 * g.rgba[i * 4 + 2]) / 255;
        const c = opts.colour ?? [0, 0, 0];
        rgba[i * 4] = c[0]; rgba[i * 4 + 1] = c[1]; rgba[i * 4 + 2] = c[2];
        rgba[i * 4 + 3] = Math.round((1 - lum) * strength * 255);
    }
    const png = encodePng(GRIT_MAP_SIDE, GRIT_MAP_SIDE, rgba);

    // appended to the asset: buffer views, accessors, image, texture, material, mesh, node
    const pad4 = (b: Buffer) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
    const parts: Buffer[] = [pad4(Buffer.from(bin))];
    let offset = parts[0].length;
    json.bufferViews ??= []; json.accessors ??= []; json.images ??= []; json.textures ??= []; json.samplers ??= []; json.materials ??= []; json.meshes ??= []; json.nodes ??= [];
    const view = (data: Buffer, target?: number): number => {
        json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target ? { target } : {}) });
        const p = pad4(data); parts.push(p); offset += p.length;
        return json.bufferViews.length - 1;
    };
    const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer);
    const count = pos.length / 3;
    const pMin = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), pMax = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
    json.accessors.push({ bufferView: view(f32(pos), 34962), componentType: 5126, count, type: 'VEC3', min: pMin, max: pMax });
    const aPos = json.accessors.length - 1;
    json.accessors.push({ bufferView: view(f32(nor), 34962), componentType: 5126, count, type: 'VEC3' });
    const aNor = json.accessors.length - 1;
    json.accessors.push({ bufferView: view(f32(uv), 34962), componentType: 5126, count, type: 'VEC2' });
    const aUv = json.accessors.length - 1;
    json.images.push({ bufferView: view(Buffer.from(png)), mimeType: 'image/png', name: 'grit_decal' });
    json.samplers.push({ wrapS: 33071, wrapT: 33071, magFilter: 9729, minFilter: 9987 });
    json.textures.push({ source: json.images.length - 1, sampler: json.samplers.length - 1 });
    json.materials.push({
        name: 'grit_decal', alphaMode: 'BLEND', doubleSided: false,
        pbrMetallicRoughness: { baseColorTexture: { index: json.textures.length - 1 }, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
        extras: { label: 'generated', method: opts.method ?? 'grime read from a reference photo by an image model, one non-tiling map per wall' }
    });
    json.meshes.push({ name: 'grit_decal', primitives: [{ attributes: { POSITION: aPos, NORMAL: aNor, TEXCOORD_0: aUv }, material: json.materials.length - 1, mode: 4 }] });
    json.nodes.push({ name: 'grit_decal', mesh: json.meshes.length - 1, extras: { label: 'generated', decal: 'grit', strength } });
    const scene = json.scenes?.[json.scene ?? 0];
    if (scene) scene.nodes = [...(scene.nodes ?? []), json.nodes.length - 1];
    const binOut = Buffer.concat(parts);
    json.buffers = [{ byteLength: binOut.length }];

    const jsonBuf = Buffer.from(JSON.stringify(json));
    const jsonPad = jsonBuf.length % 4 ? Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)]) : jsonBuf;
    const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8);
    header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonPad.length + 8 + binOut.length, 8);
    jh.writeUInt32LE(jsonPad.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    bh.writeUInt32LE(binOut.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return { glb: Buffer.concat([header, jh, jsonPad, bh, binOut]), decalTriangles: count / 3, widthM, heightM };
}
