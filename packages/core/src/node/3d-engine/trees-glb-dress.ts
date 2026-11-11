/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * SB-Veggie trees dressed in glTF materials, for renderers that read only the GLB (the path tracer, any glTF viewer).
 *
 * A trees GLB gives every tree mesh the shared clay material; the viewport dresses them at runtime from the tree texture
 * library (treeTextureMaterials.ts), by what the file declares: each tree's chosen leaf and bark sets and their tints
 * (sbTree.texture), the leaf-card attribute that picks an atlas cell (clusterLibrary.leafCard), the crown cards' layout
 * (sbTrees.crownCards) and the far level's foliage primitives (sbLod.foliagePrimitives). This writes a copy with the same
 * looks as plain glTF:
 * - leaf cards: one alpha-masked material per tree and atlas cell, its texture the cell alone (colour and opacity, a
 *   transparent rim, clamped), the cards' TEXCOORD_0 mapped to the cell's leaf coordinates (leafAtlasUv, the shader's
 *   mapping); stalks opaque in the leaf colour;
 * - crown cards: the card atlas baked from the leaf set (bakeCrownCardAtlas with texturedLeafPaint, as the viewport and
 *   the photo-match evaluator bake it), alpha-masked, clamped;
 * - wood and twigs: the bark set's colour map, repeating in the bark tiles the writer laid out;
 * - the far level's leaf masses: the tree's measured crown colour.
 * Each is tinted by the tree's own tint (linear, from its measured colour). Meshes are told apart only by the names the
 * file itself lists; nothing is branched on a kind of plant. Per-leaf colour variation, translucency and the viewport's
 * mip alpha lift are not carried.
 */

import * as fs from 'fs';
import * as path from 'path';
import { crownCardAtlasPx, bakeCrownCardAtlas, crownCardsOf, texturedLeafPaint, type AtlasPixels } from '../../common/spatial/tree-crown-card-atlas';
import { DEFAULT_TREE_TEXTURE_OPTIONS, MAX_LEAF_CELLS, leafAtlasUv, leafCellIndex, validateTreeTextureIndex, type TreeLeafCell, type TreeLeafTextureEntry, type TreeTextureIndex } from '../../common/spatial/tree-texture-library';
import { parseGlbBytes, readAccessor, assembleGlb, type ParsedGlb } from './staged-location/glb-bytes';
import { decodeImageInMemory } from './staged-location/tile-texture-transfer';
import { encodePng } from './staged-location/png-encode';

/** Bumped whenever the dressing changes what it writes (cached dressed files are keyed by it). */
export const TREES_DRESS_VERSION = 2;

export interface TreesDressReport {
    trees: number;
    dressedTrees: number;
    leafMeshes: number;
    cardMeshes: number;
    woodMeshes: number;
    massPrimitives: number;
    images: number;
    materials: number;
    /** Trees left in clay, each with its reason (no texture choice, a set the library lacks). */
    skipped: string[];
}

const CLAMP = 33071, REPEAT = 10497;
const FLOAT = 5126, UINT32 = 5125;

interface Rgba { data: Uint8Array; width: number; height: number }

/** An image decoded once (rows from the top), keyed by file. */
const decoded = new Map<string, Rgba>();
function decodeFile(file: string): Rgba {
    let img = decoded.get(file);
    if (!img) {
        const d = decodeImageInMemory(fs.readFileSync(file));
        decoded.set(file, img = { data: d.rgba, width: d.width, height: d.height });
    }
    return img;
}

/** A leaf set's colour (RGB) and opacity (alpha, from the opacity map's red) as one RGBA image, rows from the top. */
function leafRgba(dir: string, e: TreeLeafTextureEntry): Rgba {
    const colour = decodeFile(path.join(dir, e.maps.color));
    const opacity = decodeFile(path.join(dir, e.maps.opacity));
    const w = colour.width, h = colour.height;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const ox = Math.min(opacity.width - 1, Math.floor((x * opacity.width) / w)), oy = Math.min(opacity.height - 1, Math.floor((y * opacity.height) / h));
        out[o] = colour.data[o]; out[o + 1] = colour.data[o + 1]; out[o + 2] = colour.data[o + 2];
        out[o + 3] = opacity.data[(oy * opacity.width + ox) * 4];
    }
    return { data: out, width: w, height: h };
}

/** The library convention's (u, v), v up from the bottom, sampled (nearest) from an image whose rows run from the top. */
function sampleLibrary(img: Rgba, u: number, v: number): [number, number, number, number] {
    const x = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)));
    const y = Math.min(img.height - 1, Math.max(0, Math.floor((1 - v) * img.height)));
    const o = (y * img.width + x) * 4;
    return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

/**
 * One atlas cell as its own image in leaf coordinates: column s (across) and row t (along, base at the top row, glTF's
 * v = 0), with a transparent one-pixel rim so a clamped sampler shows nothing outside the leaf.
 */
function cellImage(img: Rgba, cell: TreeLeafCell): { png: Buffer; width: number; height: number } {
    const lenPx = Math.hypot(cell.along[0] * img.width, cell.along[1] * img.height);
    const widPx = Math.hypot(cell.across[0] * img.width, cell.across[1] * img.height);
    const height = Math.max(8, Math.min(256, Math.round(lenPx)));
    const width = Math.max(8, Math.min(256, Math.round(widPx)));
    const px = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) continue; // the transparent rim
        const s = (x + 0.5) / width, t = (y + 0.5) / height;
        const c = sampleLibrary(img, cell.origin[0] + t * cell.along[0] + s * cell.across[0], cell.origin[1] + t * cell.along[1] + s * cell.across[1]);
        px.set(c, o);
    }
    // transparent texels take the leaf's mean colour, so filtering does not darken the leaf's edge toward black
    const sum = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 3] >= 128) { sum[0] += px[i]; sum[1] += px[i + 1]; sum[2] += px[i + 2]; n++; }
    if (n) for (let i = 0; i < px.length; i += 4) if (px[i + 3] === 0) { px[i] = sum[0] / n; px[i + 1] = sum[1] / n; px[i + 2] = sum[2] / n; }
    return { png: encodePng(width, height, px, 4), width, height };
}

/** The leaf set as the crown-card painter reads it: RGBA rows from v = 0 (the bottom) up, at most leafAtlasPx. */
function atlasPixels(img: Rgba, maxPx: number): AtlasPixels {
    const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const sx = Math.min(img.width - 1, Math.floor((x * img.width) / w)), sy = Math.min(img.height - 1, Math.floor((y * img.height) / h));
        data.set(img.data.subarray((sy * img.width + sx) * 4, (sy * img.width + sx) * 4 + 4), ((h - 1 - y) * w + x) * 4);
    }
    return { data, width: w, height: h };
}

/** The library index the file names (sbTrees.textures.index, relative to the repository), else `fallback`. */
function loadLibrary(indexFile: string): TreeTextureIndex | undefined {
    if (!fs.existsSync(indexFile)) return undefined;
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as TreeTextureIndex;
    return validateTreeTextureIndex(index).length ? undefined : index;
}

/**
 * The GLB with its SB-Veggie trees dressed (see the file comment), or undefined when it holds no trees with texture
 * choices (nothing to dress) or the library cannot be read. `indexFile` is the tree texture library's index.json.
 */
export function dressTreesGlb(glb: Uint8Array, indexFile: string): { glb: Buffer; report: TreesDressReport } | undefined {
    const g: ParsedGlb = parseGlbBytes(glb);
    const json = g.json;
    const root = json.extras?.sbTrees;
    if (!root?.textures) return undefined;
    const lib = loadLibrary(indexFile);
    if (!lib) return undefined;
    const dir = path.dirname(indexFile);
    const nodes: any[] = json.nodes ?? [];
    const meshes: any[] = json.meshes ?? [];
    json.materials ??= []; json.images ??= []; json.textures ??= []; json.samplers ??= []; json.bufferViews ??= []; json.accessors ??= [];

    // new binary data, appended after the file's own
    const chunks: Buffer[] = [Buffer.from(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength)];
    let binLength = g.bin.byteLength;
    const addView = (bytes: Buffer, target?: number): number => {
        const pad = (4 - (binLength % 4)) % 4;
        if (pad) { chunks.push(Buffer.alloc(pad)); binLength += pad; }
        json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.length, ...(target ? { target } : {}) });
        chunks.push(bytes); binLength += bytes.length;
        return json.bufferViews.length - 1;
    };
    const samplerOf = new Map<number, number>();
    const sampler = (wrap: number) => {
        let s = samplerOf.get(wrap);
        if (s === undefined) { json.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: wrap, wrapT: wrap }); samplerOf.set(wrap, s = json.samplers.length - 1); }
        return s;
    };
    const textureFromBytes = (bytes: Buffer, mimeType: string, wrap: number): number => {
        json.images.push({ bufferView: addView(bytes), mimeType });
        json.textures.push({ source: json.images.length - 1, sampler: sampler(wrap) });
        return json.textures.length - 1;
    };
    const material = (m: object): number => { json.materials.push(m); return json.materials.length - 1; };
    const tinted = (rgb: number[] | undefined, mean?: number[]): [number, number, number, number] => {
        const t = rgb && rgb.length === 3 ? rgb : [1, 1, 1];
        const m = mean ?? [1, 1, 1];
        return [Math.min(4, t[0] * m[0]), Math.min(4, t[1] * m[1]), Math.min(4, t[2] * m[2]), 1];
    };

    // the cluster library's meshes that hold leaves (its variants also list the twigs and the cards), as the evaluator reads them
    const leafVariants = new Set<string>((root.clusterLibrary?.variants ?? [])
        .filter((v: any) => (v.leavesLevel0 ?? 0) > 0 || (v.leavesNearMid ?? 0) > 0 || (v.leavesLevel1 ?? 0) > 0).map((v: any) => v.mesh));
    const cards = crownCardsOf(root);
    const cardMeshes = new Set<string>(cards?.meshes ?? []);
    const cardWidth: number | undefined = root.clusterLibrary?.leafCard?.widthRatio;
    const leafAttribute = (/^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(root.clusterLibrary?.leafCard?.leafAttribute ?? '')?.[1]) ?? '_LEAF';
    const report: TreesDressReport = { trees: 0, dressedTrees: 0, leafMeshes: 0, cardMeshes: 0, woodMeshes: 0, massPrimitives: 0, images: 0, materials: 0, skipped: [] };
    const imagesBefore = json.images.length, materialsBefore = json.materials.length;

    // per leaf set: its RGBA image, its cells' textures, its card atlas texture; per leaf mesh and set: the remapped UVs and cell triangles
    const leafImages = new Map<string, Rgba>();
    const cellTextures = new Map<string, number>();
    const cardTextures = new Map<string, number>();
    const barkTextures = new Map<string, number>();
    const leafSplits = new Map<string, { uv: number; cells: Map<number, number>; stalk?: number }>();
    const dressedMeshes = new Map<string, number>();

    const leafImage = (e: TreeLeafTextureEntry) => {
        let img = leafImages.get(e.id);
        if (!img) leafImages.set(e.id, img = leafRgba(dir, e));
        return img;
    };
    const cellTexture = (e: TreeLeafTextureEntry, ci: number) => {
        const key = `${e.id}:${ci}`;
        let t = cellTextures.get(key);
        if (t === undefined) cellTextures.set(key, t = textureFromBytes(cellImage(leafImage(e), e.atlas.cells[ci]).png, 'image/png', CLAMP));
        return t;
    };
    const cardTexture = (e: TreeLeafTextureEntry) => {
        let t = cardTextures.get(e.id);
        if (t === undefined && cards) {
            const px = crownCardAtlasPx(cards);
            const baked = bakeCrownCardAtlas(cards, px, texturedLeafPaint(e, atlasPixels(leafImage(e), DEFAULT_TREE_TEXTURE_OPTIONS.leafAtlasPx), cards.clayLeafAspect));
            cardTextures.set(e.id, t = textureFromBytes(encodePng(px, px, baked, 4), 'image/png', CLAMP));
        }
        return t;
    };
    const barkTexture = (id: string) => {
        let t = barkTextures.get(id);
        if (t === undefined) {
            const e = lib.bark.find(b => b.id === id);
            if (!e) return undefined;
            const file = path.join(dir, e.maps.color);
            barkTextures.set(id, t = textureFromBytes(fs.readFileSync(file), /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png', REPEAT));
        }
        return t;
    };

    /** A leaf mesh's cards split by the atlas cell each one shows, with TEXCOORD_0 in the cell's leaf coordinates. */
    const leafSplit = (meshIndex: number, e: TreeLeafTextureEntry, prim: any, primIndex: number) => {
        const key = `${meshIndex}:${primIndex}:${e.id}`;
        const known = leafSplits.get(key);
        if (known) return known;
        const cells = e.atlas.cells.slice(0, MAX_LEAF_CELLS);
        const uv = readAccessor(g, prim.attributes.TEXCOORD_0);
        const leafAcc = json.accessors[prim.attributes[leafAttribute]];
        const leaf = readAccessor(g, prim.attributes[leafAttribute]);
        const leafScale = leafAcc.normalized ? (leafAcc.componentType === 5123 ? 65535 : leafAcc.componentType === 5121 ? 255 : 1) : 1;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : Float64Array.from({ length: uv.count }, (_, i) => i);
        const st = new Float32Array(uv.count * 2);
        const cellOfVertex = new Int32Array(uv.count);
        for (let v = 0; v < uv.count; v++) {
            const ci = leafCellIndex(leaf.data[v * leaf.comps] / leafScale, cells.length);
            cellOfVertex[v] = ci;
            const r = leafAtlasUv([uv.data[v * 2], uv.data[v * 2 + 1]], cells[ci], cardWidth as number, DEFAULT_TREE_TEXTURE_OPTIONS.leafStretch, DEFAULT_TREE_TEXTURE_OPTIONS.cardZoom[0] ?? 1);
            st[v * 2] = r.st[0]; st[v * 2 + 1] = r.st[1];
        }
        json.accessors.push({ bufferView: addView(Buffer.from(st.buffer)), componentType: FLOAT, count: uv.count, type: 'VEC2' });
        const uvAccessor = json.accessors.length - 1;
        const perCell = new Map<number, number[]>(), stalk: number[] = [];
        for (let t = 0; t + 2 < idx.length; t += 3) {
            const a = idx[t], b = idx[t + 1], c = idx[t + 2];
            const blade = (leaf.data[a * leaf.comps + 1] + leaf.data[b * leaf.comps + 1] + leaf.data[c * leaf.comps + 1]) / (3 * leafScale) >= 0.5;
            if (!blade) { stalk.push(a, b, c); continue; }
            const ci = cellOfVertex[a];
            (perCell.get(ci) ?? perCell.set(ci, []).get(ci)!).push(a, b, c);
        }
        const indexAccessor = (list: number[]) => {
            json.accessors.push({ bufferView: addView(Buffer.from(Uint32Array.from(list).buffer), 34963), componentType: UINT32, count: list.length, type: 'SCALAR' });
            return json.accessors.length - 1;
        };
        const split = { uv: uvAccessor, cells: new Map([...perCell].map(([ci, list]) => [ci, indexAccessor(list)])), ...(stalk.length ? { stalk: indexAccessor(stalk) } : {}) };
        leafSplits.set(key, split);
        return split;
    };

    /** The mesh `meshIndex` dressed for one tree (its role read from the file's own lists), cached per tree. */
    const dressMesh = (meshIndex: number, treeKey: string, tex: any, massColour: number[] | undefined, foliagePrimitives: number[] | undefined): number | undefined => {
        const key = `${meshIndex}|${treeKey}|${(foliagePrimitives ?? []).join(',')}`;
        if (dressedMeshes.has(key)) return dressedMeshes.get(key);
        const mesh = meshes[meshIndex];
        if (!mesh) return undefined;
        const name: string = mesh.name ?? '';
        const leafEntry: TreeLeafTextureEntry | undefined = tex?.leaves?.entry ? lib.leaves.find(e => e.id === tex.leaves.entry) : undefined;
        const leafTint = tinted(tex?.leaves?.tint);
        const out: any = { name: `${name}_dressed`, primitives: [] as any[] };
        if (!cardMeshes.has(name) && leafVariants.has(name) && leafEntry && typeof cardWidth === 'number' && cardWidth > 0) {
            mesh.primitives.forEach((prim: any, pi: number) => {
                if (prim.attributes?.TEXCOORD_0 === undefined || prim.attributes?.[leafAttribute] === undefined) { out.primitives.push(prim); return; }
                const split = leafSplit(meshIndex, leafEntry, prim, pi);
                const attributes = { ...prim.attributes, TEXCOORD_0: split.uv };
                for (const [ci, indices] of split.cells) {
                    out.primitives.push({ attributes, indices, mode: 4, material: material({
                        name: `leaf ${leafEntry.id} cell ${ci}`, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true,
                        pbrMetallicRoughness: { baseColorTexture: { index: cellTexture(leafEntry, ci) }, baseColorFactor: leafTint, metallicFactor: 0, roughnessFactor: 0.6 }
                    }) });
                }
                if (split.stalk !== undefined) {
                    out.primitives.push({ attributes, indices: split.stalk, mode: 4, material: material({
                        name: `leaf ${leafEntry.id} stalk`, pbrMetallicRoughness: { baseColorFactor: tinted(tex?.leaves?.tint, leafEntry.colour.meanLinearRgb), metallicFactor: 0, roughnessFactor: 0.7 }
                    }) });
                }
            });
            report.leafMeshes++;
        } else if (cardMeshes.has(name) && leafEntry) {
            const t = cardTexture(leafEntry);
            if (t === undefined) return undefined;
            const m = material({ name: `crown cards ${leafEntry.id}`, alphaMode: 'MASK', alphaCutoff: 0.5, doubleSided: true,
                pbrMetallicRoughness: { baseColorTexture: { index: t }, baseColorFactor: leafTint, metallicFactor: 0, roughnessFactor: 0.65 } });
            out.primitives = mesh.primitives.map((p: any) => ({ ...p, material: m }));
            report.cardMeshes++;
        } else {
            // wood, twigs and the far level: foliage primitives (sbLod.foliagePrimitives) take the measured crown colour, the rest the bark
            const bark = tex?.bark?.entry ? barkTexture(tex.bark.entry) : undefined;
            const barkMaterial = bark !== undefined
                ? material({ name: `bark ${tex.bark.entry}`, pbrMetallicRoughness: { baseColorTexture: { index: bark }, baseColorFactor: tinted(tex?.bark?.tint), metallicFactor: 0, roughnessFactor: 0.85 } })
                : undefined;
            const massMaterial = massColour ? material({ name: 'crown mass', pbrMetallicRoughness: { baseColorFactor: [massColour[0], massColour[1], massColour[2], 1], metallicFactor: 0, roughnessFactor: 0.8 } }) : undefined;
            out.primitives = mesh.primitives.map((p: any, pi: number) => {
                if (foliagePrimitives?.includes(pi) && massMaterial !== undefined) { report.massPrimitives++; return { ...p, material: massMaterial }; }
                return barkMaterial !== undefined && p.attributes?.TEXCOORD_0 !== undefined ? { ...p, material: barkMaterial } : p;
            });
            if (barkMaterial !== undefined) report.woodMeshes++;
        }
        meshes.push(out);
        const index = meshes.length - 1;
        dressedMeshes.set(key, index);
        return index;
    };

    nodes.forEach((n, ti) => {
        const tree = n?.extras?.sbTree;
        if (!tree) return;
        report.trees++;
        const tex = tree.texture;
        if (!tex?.leaves?.entry && !tex?.bark?.entry) { report.skipped.push(`tree ${tree.id ?? ti}: no texture choice`); return; }
        if (tex?.leaves?.entry && !lib.leaves.some(e => e.id === tex.leaves.entry)) report.skipped.push(`tree ${tree.id ?? ti}: the library has no leaf set ${tex.leaves.entry}`);
        const treeKey = `${ti}`;
        const visit = (k: number, foliage: number[] | undefined) => {
            const node = nodes[k];
            if (!node) return;
            const lod = node.extras?.sbLod;
            const f = Array.isArray(lod?.foliagePrimitives) ? lod.foliagePrimitives : foliage;
            if (typeof node.mesh === 'number') {
                const d = dressMesh(node.mesh, treeKey, tex, tex?.massColourLinear, Array.isArray(lod?.foliagePrimitives) ? lod.foliagePrimitives : undefined);
                if (d !== undefined) node.mesh = d;
            }
            for (const c of node.children ?? []) visit(c, f);
        };
        for (const c of n.children ?? []) visit(c, undefined);
        if (typeof n.mesh === 'number') { const d = dressMesh(n.mesh, treeKey, tex, tex?.massColourLinear, undefined); if (d !== undefined) n.mesh = d; }
        report.dressedTrees++;
    });
    if (!report.dressedTrees) return undefined;
    report.images = json.images.length - imagesBefore;
    report.materials = json.materials.length - materialsBefore;
    if (!json.images.length) delete json.images;
    const bin = Buffer.concat(chunks);
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: bin.length }];
    json.extras.sbTrees.dressedFor = { version: TREES_DRESS_VERSION, by: 'trees-glb-dress.ts', label: 'library', note: 'tree materials written into the file from the tree texture library; the viewport dresses the original itself' };
    return { glb: assembleGlb(json, bin), report };
}
