/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Decals on a 3D asset: an image laid over the asset's own materials as a decal node in its GLB, a skin DECAL_OFFSET_M off
 * the faces it covers, so any glTF viewer and the app show it. What the decal is stays open: the caller's own image (a
 * logo, a sign, a poster, a photo), or an image a model paints from a description (grime, graffiti, ivy, a mural, damage,
 * lettering...), optionally read from a reference photo. Where it goes is continuous numbers, never a mode list:
 *   - the faces: within `maxNormalY` of vertical, of the parts `keep` accepts, facing `headingDeg` within `headingToleranceDeg`;
 *   - the mapping: once across the covered faces (default), repeated every `tileM` metres, or one patch of `sizeM` metres
 *     centred at `centre` (fractions across and up the asset), clear outside it.
 * Opacity is the image's own alpha where it has one, else its distance from the white it was painted on; colour is the
 * image's own, or `colour` for a one-colour decal. A generated decal is labelled generated, a given image photo-inferred.
 */

import { readGlbChunks, readTileTriangles, decodeImageInMemory, type RgbaImage8 } from './staged-location/tile-texture-transfer';
import { encodePng } from '../texture-processing';
import { resizeRgba } from './staged-location/texture-enhance';
import { generateImageWithModels } from '../google-media-generation-service';

/** The decal stands this far off its face, along the face's normal. */
export const DECAL_OFFSET_M = 0.01;
/** The decal's default opacity (times its own alpha). */
export const DECAL_DEFAULT_STRENGTH = 0.8;
/** A face is covered when its normal's vertical component is at most this (walls). */
export const DECAL_MAX_NORMAL_Y = 0.3;
/** A face counts as facing a heading when its normal is within this many degrees of it. */
export const DECAL_HEADING_TOLERANCE_DEG = 45;
/** The decal texture's longest side. */
export const DECAL_MAP_SIDE = 2048;

/** What a generated decal shows when nothing is described: the weathering of an old city facade. */
export const DECAL_DEFAULT_DESCRIPTION = 'city weathering: heavier soot near the bottom and in a band just under the top edge, long vertical rain streaks running down from a few points along the top, irregular soft blotches and faint speckle, each streak and blotch different';

/**
 * The prompt for a decal `widthM` x `heightM`: `description` (open text) painted on plain white, seen straight on, read
 * from the reference photo when one is given; `tiles` when the image is to repeat seamlessly.
 */
export const decalPrompt = (widthM: number, heightM: number, description = DECAL_DEFAULT_DESCRIPTION, withReference = true, tiles = false): string =>
    `${withReference ? 'Use the photo as the reference for what it should look like. ' : ''}Paint ONLY this, as a flat decal covering ${widthM.toFixed(1)} by ${heightM.toFixed(1)} metres of a surface, seen straight on with no perspective: ${description}. ` +
    `Everything that is not the decal is plain pure white (#FFFFFF): no wall, no bricks, no background scene, no frame, no shadow. ${tiles ? 'It tiles seamlessly: its left edge continues its right and its top its bottom.' : 'It does not tile and nothing in it repeats.'}`;

/** A decal image painted by an image model. */
export async function generateDecalImage(input: {
    client: unknown; models: string[]; description?: string; reference?: { bytes: Uint8Array; mimeType: string }; widthM: number; heightM: number; tiles?: boolean; signal?: AbortSignal;
}): Promise<{ image: RgbaImage8; modelUsed: string; modelNote: string }> {
    const answer = await generateImageWithModels(input.client, {
        models: input.models,
        contents: [{ text: decalPrompt(input.widthM, input.heightM, input.description, !!input.reference, input.tiles) }, ...(input.reference ? [{ inlineData: { mimeType: input.reference.mimeType, data: Buffer.from(input.reference.bytes).toString('base64') } }] : [])],
        imageConfig: { aspectRatio: nearestAspect(input.widthM / Math.max(1e-6, input.heightM)) }, signal: input.signal
    });
    return { image: decodeImageInMemory(new Uint8Array(answer.data)), modelUsed: answer.modelUsed, modelNote: answer.modelNote };
}

function nearestAspect(r: number): string {
    const options: Array<[string, number]> = [['1:1', 1], ['4:3', 4 / 3], ['3:4', 3 / 4], ['16:9', 16 / 9], ['9:16', 9 / 16], ['3:2', 1.5], ['2:3', 2 / 3], ['21:9', 21 / 9]];
    return options.reduce((b, o) => (Math.abs(Math.log(o[1] / r)) < Math.abs(Math.log(b[1] / r)) ? o : b))[0];
}

export interface DecalPlacement {
    /** Faces whose normal's vertical component is at most this (0 = vertical only, 1 = every face). */
    maxNormalY?: number;
    /** Only faces facing this compass heading (degrees, 0 = north, 90 = east), within headingToleranceDeg. */
    headingDeg?: number;
    headingToleranceDeg?: number;
    /** Repeat the image every this many metres (width; height keeps the image's aspect). Absent = once across. */
    tileM?: number;
    /** One patch: its centre as fractions across (0 left, 1 right, seen from outside) and up (0 bottom, 1 top) the covered extent, and its size in metres. */
    patch?: { centre: [number, number]; sizeM: [number, number] };
    /** Distance off the surface, metres. */
    offsetM?: number;
}

export interface DecalBakeOptions extends DecalPlacement {
    strength?: number;
    /** A one-colour decal (sRGB 0-255): the image gives only its opacity. */
    colour?: [number, number, number];
    keep?: (nodeName: string) => boolean;
    name?: string;
    label?: 'generated' | 'photo-inferred';
    method?: string;
}

export interface DecalBakeResult { glb: Buffer; decalTriangles: number; widthM: number; heightM: number }

/** The decal texture: the image's colour (or `colour`), its alpha the image's own or its distance from white, times strength; a clear border so clamping leaves the outside clear. */
export function decalTexture(img: RgbaImage8, strength: number, colour?: [number, number, number]): { png: Buffer; width: number; height: number } {
    const scale = Math.min(1, DECAL_MAP_SIDE / Math.max(img.width, img.height));
    const w = Math.max(4, Math.round(img.width * scale)), h = Math.max(4, Math.round(img.height * scale));
    const r = resizeRgba(img, w, h);
    let hasAlpha = false;
    for (let i = 3; i < r.rgba.length; i += 4) if (r.rgba[i] < 250) { hasAlpha = true; break; }
    const out = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) {
        const R = r.rgba[i * 4], G = r.rgba[i * 4 + 1], B = r.rgba[i * 4 + 2];
        // painted on white: the opacity is how far the pixel is from white, and its colour is the white un-blended out
        const a = hasAlpha ? r.rgba[i * 4 + 3] / 255 : Math.max(255 - R, 255 - G, 255 - B) / 255;
        const un = (c: number) => (a > 0.02 ? Math.max(0, Math.min(255, Math.round(255 - (255 - c) / a))) : 0);
        const x = i % w, y = (i - x) / w, border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        out[i * 4] = colour ? colour[0] : hasAlpha ? R : un(R);
        out[i * 4 + 1] = colour ? colour[1] : hasAlpha ? G : un(G);
        out[i * 4 + 2] = colour ? colour[2] : hasAlpha ? B : un(B);
        out[i * 4 + 3] = border ? 0 : Math.round(Math.max(0, Math.min(1, a * strength)) * 255);
    }
    return { png: encodePng(w, h, out), width: w, height: h };
}

/** What a decal asset's sidecar records: what it is, how big it is in the world, and where it came from. */
export interface DecalAssetMeta {
    schema: 'scratchbox.decal/1';
    description: string;
    /** Real-world size the image spans (width, height), metres. */
    sizeM: [number, number];
    tiles: boolean;
    pixels: [number, number];
    label: 'generated' | 'photo-inferred';
    method: string;
    model?: string;
    reference?: string;
}

/** A decal asset from a painted (or given) image: the transparent PNG (decalTexture at full strength) and its sidecar. */
export function decalAsset(image: RgbaImage8, meta: Omit<DecalAssetMeta, 'schema' | 'pixels'>, colour?: [number, number, number]): { png: Buffer; meta: DecalAssetMeta } {
    const tex = decalTexture(image, 1, colour);
    return { png: tex.png, meta: { schema: 'scratchbox.decal/1', ...meta, pixels: [tex.width, tex.height] } };
}

/** Bakes `image` into `glb` as a decal node on the faces `opts` selects, mapped as `opts` says. */
export function bakeDecal(glb: Uint8Array, image: RgbaImage8, opts: DecalBakeOptions = {}): DecalBakeResult {
    const strength = Math.max(0, Math.min(1, opts.strength ?? DECAL_DEFAULT_STRENGTH));
    const keep = opts.keep ?? ((n: string) => !/opening|glass/i.test(n));
    const maxNy = opts.maxNormalY ?? DECAL_MAX_NORMAL_Y, off = opts.offsetM ?? DECAL_OFFSET_M;
    const tol = (opts.headingToleranceDeg ?? DECAL_HEADING_TOLERANCE_DEG) * Math.PI / 180;
    const { json, bin } = readGlbChunks(glb);
    const names: string[] = (json.nodes ?? []).map((n: { name?: string }) => n.name ?? '');
    const t = readTileTriangles(glb, { nodeTags: true });
    const nTri = t.positions.length / 9;
    // the faces: slope, part, heading (tile frame: x east, z south, so north is -z)
    const chosen: number[] = [];
    for (let k = 0; k < nTri; k++) {
        const nx = t.normals[k * 3], ny = t.normals[k * 3 + 1], nz = t.normals[k * 3 + 2];
        if (Math.abs(ny) > maxNy || !keep(names[t.node[k]] ?? '')) continue;
        if (opts.headingDeg !== undefined) {
            const h = Math.atan2(nx, -nz), want = opts.headingDeg * Math.PI / 180;
            if (Math.abs(Math.atan2(Math.sin(h - want), Math.cos(h - want))) > tol) continue;
        }
        chosen.push(k);
    }
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const k of chosen) for (let v = 0; v < 3; v++) for (let c = 0; c < 3; c++) { const x = t.positions[k * 9 + v * 3 + c]; lo[c] = Math.min(lo[c], x); hi[c] = Math.max(hi[c], x); }
    const widthM = Math.max(hi[0] - lo[0], hi[2] - lo[2], 0), heightM = Math.max(0, hi[1] - lo[1]);
    if (!chosen.length) return { glb: Buffer.from(glb), decalTriangles: 0, widthM, heightM };
    const aspect = image.height / Math.max(1, image.width);
    const pos: number[] = [], nor: number[] = [], uv: number[] = [];
    for (const k of chosen) {
        const nx = t.normals[k * 3], ny = t.normals[k * 3 + 1], nz = t.normals[k * 3 + 2];
        const alongZ = Math.abs(nx) > Math.abs(nz);
        for (let v = 0; v < 3; v++) {
            const x = t.positions[k * 9 + v * 3], y = t.positions[k * 9 + v * 3 + 1], z = t.positions[k * 9 + v * 3 + 2];
            pos.push(x + nx * off, y + ny * off, z + nz * off);
            nor.push(nx, ny, nz);
            // metres across (left to right seen from outside) and up the covered extent
            const span = alongZ ? hi[2] - lo[2] : hi[0] - lo[0];
            let across = alongZ ? z - lo[2] : x - lo[0];
            // seen from outside, left is to the viewer's left: on a face whose normal points east (+x) or north (-z) that runs the other way
            if ((alongZ ? nx : -nz) > 0) across = span - across;
            const up = y - lo[1];
            if (opts.patch) {
                const [cu, cv] = opts.patch.centre, [pw, ph] = opts.patch.sizeM;
                uv.push((across - (cu * span - pw / 2)) / pw, 1 - (up - (cv * heightM - ph / 2)) / ph);
            } else if (opts.tileM && opts.tileM > 0) {
                uv.push(across / opts.tileM, 1 - up / (opts.tileM * aspect));
            } else {
                uv.push(across / Math.max(1e-6, span), 1 - up / Math.max(1e-6, heightM));
            }
        }
    }
    const tex = decalTexture(image, strength, opts.colour);
    const repeat = !opts.patch && !!opts.tileM;

    // appended to the asset: buffer views, accessors, image, texture, material, mesh, node
    const pad4 = (b: Buffer) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
    const parts: Buffer[] = [pad4(Buffer.from(bin))];
    let offset = parts[0].length;
    for (const key of ['bufferViews', 'accessors', 'images', 'textures', 'samplers', 'materials', 'meshes', 'nodes']) json[key] ??= [];
    const view = (data: Buffer, target?: number): number => {
        json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target ? { target } : {}) });
        const p = pad4(data); parts.push(p); offset += p.length;
        return json.bufferViews.length - 1;
    };
    const f32 = (a: number[]) => Buffer.from(new Float32Array(a).buffer);
    const count = pos.length / 3;
    const pMin = [Infinity, Infinity, Infinity], pMax = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < pos.length; i++) { pMin[i % 3] = Math.min(pMin[i % 3], pos[i]); pMax[i % 3] = Math.max(pMax[i % 3], pos[i]); }
    const name = opts.name ?? 'decal';
    json.accessors.push({ bufferView: view(f32(pos), 34962), componentType: 5126, count, type: 'VEC3', min: pMin, max: pMax });
    const aPos = json.accessors.length - 1;
    json.accessors.push({ bufferView: view(f32(nor), 34962), componentType: 5126, count, type: 'VEC3' });
    const aNor = json.accessors.length - 1;
    json.accessors.push({ bufferView: view(f32(uv), 34962), componentType: 5126, count, type: 'VEC2' });
    const aUv = json.accessors.length - 1;
    json.images.push({ bufferView: view(tex.png), mimeType: 'image/png', name });
    json.samplers.push({ wrapS: repeat ? 10497 : 33071, wrapT: repeat ? 10497 : 33071, magFilter: 9729, minFilter: 9987 });
    json.textures.push({ source: json.images.length - 1, sampler: json.samplers.length - 1 });
    const label = opts.label ?? 'generated';
    json.materials.push({
        name, alphaMode: 'BLEND', doubleSided: false,
        pbrMetallicRoughness: { baseColorTexture: { index: json.textures.length - 1 }, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
        extras: { label, ...(opts.method ? { method: opts.method } : {}) }
    });
    json.meshes.push({ name, primitives: [{ attributes: { POSITION: aPos, NORMAL: aNor, TEXCOORD_0: aUv }, material: json.materials.length - 1, mode: 4 }] });
    json.nodes.push({ name, mesh: json.meshes.length - 1, extras: { label, decal: true, strength, ...(opts.method ? { method: opts.method } : {}) } });
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
