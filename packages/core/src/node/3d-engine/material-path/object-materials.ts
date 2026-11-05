/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The material path on any object (user ask, 2026-11-05: the material detection usable on any 3D object the app builds,
 * not only buildings). The same steps a building's rebuilt facades go through (surface-classes.ts, class-sets.ts), with
 * the object supplying what a facade's photo and plane supply:
 *
 *  1. A metric frame: the UV rewrap (UvAtlasRewrap.ts 'rewrap') gives every material its own atlas on TEXCOORD_0 at one
 *     texel density across the object, rebaking whatever maps the material has, so a texel is a known size in metres.
 *  2. Classes: a material with a photo or reference texture whose colours vary (a street object rebuilt from Street View,
 *     an object made from a real photo) is read into appearance classes by CIELAB k-means over its covered texels, as a
 *     facade's photo is; a material with one colour (a generated object's part, its factors read from its reference) is
 *     one class. A part's own roughness and metalness are its class's finish, read at full confidence.
 *  3. Sets: each class's texture library set by colour, finish and real size (resolveClassSets), the tile scale from the
 *     object's own size; with a chooser, picked by its look among the nearest.
 *  4. Maps: on each atlas, each texel's class's set tiled at the set's real size: occlusion, roughness and metalness, and
 *     the normal. The colour is never touched: the part's colour, or its photo, stays the colour. A material that already
 *     has a metallic-roughness or a normal map keeps it (a part the detail pass weathered keeps its weathered finish and
 *     is classed by its as-built factors, which that pass keeps in its extras).
 *  5. Height: the classes' recess tiles on the asset and each material's class map and metric frame (extras.sbRelief),
 *     capped by the object's size (a recess never deeper than a hundredth of its diagonal, at most 3 cm), then the
 *     native displacement over the whole object (height-relief.ts), drawn up close.
 *
 * Everything written is labelled generated; a material's factors before the pass are kept in its extras. Left as they
 * are: SB-Veggie trees (their own library textures) and decal skins. Callers refuse measured or scanned content: this is
 * for generated objects (the tool checks: object-detail-tools.ts).
 */

import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint, type ParsedGlb } from '../staged-location/glb-bytes';
import { decodeImageInMemory, type RgbaImage8 } from '../staged-location/tile-texture-transfer';
import { encodePng } from '../staged-location/png-encode';
import { SRGB8_TO_LINEAR } from '../../../common/spatial/photogrammetric-delight';
import { linearRgbToLab } from '../../../common/spatial/texture-library-index';
import { isSbVeggieNode } from '../part-connectivity';
import { unwrapRewrapGlb } from '../../spatial/UvAtlasRewrap';
import { encodeRgbaToJpeg } from '../../image-codec-ffmpeg';
import { applyHeightRelief, HEIGHT_RELIEF_PARAMS, type HeightReliefParams, type HeightReliefReport } from '../height-relief';
import { resolveClassSets, type TileScale } from './class-sets';
import type { ClassFinish } from './material-finish';
import { HEIGHT_RELIEF, reliefAssetExtras, type DrawnHeight } from './material-height';
import { drawClassSets, formatRegionClasses, kMeansLab, type RegionClass, type RegionSet } from './surface-classes';

export const OBJECT_MATERIAL_PATH_VERSION = 'object-material-path/1';

export const OBJECT_MATERIAL_PARAMS = {
    /** Texels the whole object's atlases share (about a 2K map's worth). */
    targetTexels: 2048 * 2048 * 0.55,
    /** Classes read from a photo-textured material, when its colours spread at least photoSpread (CIELAB units); else one. */
    photoClasses: 3, photoSpread: 6,
    /** Texels sampled per photo material for its classes, k-means iterations, seed. */
    samples: 40000, iterations: 40, seed: 7,
    /** The tile scale from the object's diagonal d: ranked toward d / 2 within [wantMinM, wantMaxM], tiles up to 4 d within [maxMinM, maxMaxM]. */
    wantMinM: 0.25, wantMaxM: 2, maxMinM: 2, maxMaxM: 8,
    /** The deepest recess: this share of the object's diagonal, within [capMinM, HEIGHT_RELIEF.capM]. */
    capOfDiagonal: 0.01, capMinM: 0.002,
    /** The displaced copy's triangles, all parts together. */
    maxTriangles: 400_000
};
export type ObjectMaterialParams = typeof OBJECT_MATERIAL_PARAMS;

export interface ObjectMaterialOptions {
    repoRoot?: string;
    signal?: AbortSignal;
    progress?: (m: string) => void;
    /** The pick by appearance and where prepared maps are kept (class-sets.ts); both optional. */
    choose?: Parameters<typeof resolveClassSets>[2] extends infer O ? (O extends { choose?: infer C } ? C : never) : never;
    store?: Parameters<typeof resolveClassSets>[2] extends infer O ? (O extends { store?: infer S } ? S : never) : never;
    /** The sets, given the classes (default the library's: resolveClassSets). A test passes its own. */
    resolveSets?: (classes: RegionClass[], tile: TileScale, o: { heightCapM: number; finish: () => Promise<Array<ClassFinish | undefined>> }) => Promise<RegionSet[]>;
    /** false: no displaced geometry (the viewer's parallax still reads the relief). */
    displace?: boolean;
    native?: { repoRoot?: string; threads?: number; timeoutMs?: number };
}

export interface ObjectMaterialReport {
    version: string;
    label: 'generated';
    objectSizeM: [number, number, number];
    texelM: number;
    tile: TileScale;
    heightCapM: number;
    classes: Array<{ index: number; from: 'part' | 'photo'; material: string; meanLab: [number, number, number]; share: number; set: string; distance: number; finish?: RegionSet['finish']; choice?: RegionSet['choice']; height?: DrawnHeight }>;
    materials: Array<{ material: number; name?: string; width: number; height: number; classes: number[]; wrote: string[]; kept: string[]; reason?: string }>;
    relief?: HeightReliefReport;
    ms: number;
}

const labOf = (r: number, g: number, b: number) => linearRgbToLab([SRGB8_TO_LINEAR[r], SRGB8_TO_LINEAR[g], SRGB8_TO_LINEAR[b]]);
const linearToSrgb8 = (c: number) => Math.max(0, Math.min(255, Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055))));

/** The atlas texels a material's triangles cover (1), rasterised from their UVs. */
function coverage(g: ParsedGlb, prims: any[], W: number, H: number): Uint8Array {
    const mask = new Uint8Array(W * H);
    for (const def of prims) {
        const uv = readAccessor(g, def.attributes.TEXCOORD_0).data;
        const idx = def.indices !== undefined ? readAccessor(g, def.indices).data : undefined;
        const n = idx ? idx.length : uv.length / 2;
        for (let t = 0; t + 2 < n; t += 3) {
            const i = [0, 1, 2].map(k => (idx ? idx[t + k] : t + k));
            const x = i.map(v => uv[v * 2] * W), y = i.map(v => uv[v * 2 + 1] * H);
            const x0 = Math.max(0, Math.floor(Math.min(...x))), x1 = Math.min(W - 1, Math.ceil(Math.max(...x))), y0 = Math.max(0, Math.floor(Math.min(...y))), y1 = Math.min(H - 1, Math.ceil(Math.max(...y)));
            const d = (x[1] - x[0]) * (y[2] - y[0]) - (x[2] - x[0]) * (y[1] - y[0]);
            if (!d) continue;
            for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
                const cx = px + 0.5, cy = py + 0.5;
                const a = ((x[1] - cx) * (y[2] - cy) - (x[2] - cx) * (y[1] - cy)) / d, b = ((x[2] - cx) * (y[0] - cy) - (x[0] - cx) * (y[2] - cy)) / d;
                if (a >= -0.01 && b >= -0.01 && a + b <= 1.01) mask[py * W + px] = 1;
            }
        }
    }
    return mask;
}

/**
 * Runs the material path on an object's GLB (see the file comment). Returns the GLB with its parts' maps and relief, and
 * the report; throws with the reason when the object has no surface the path can read or the library cannot give a set.
 */
export async function runObjectMaterialPath(input: Buffer | Uint8Array, options: ObjectMaterialOptions = {}, P: ObjectMaterialParams = OBJECT_MATERIAL_PARAMS): Promise<{ glb: Buffer; report: ObjectMaterialReport }> {
    const t0 = Date.now();
    const src = parseGlbBytes(input instanceof Uint8Array ? input : new Uint8Array(input));
    const srcJson = src.json;
    if (!(srcJson.meshes ?? []).length) throw new Error('the GLB has no meshes to give materials to');
    // trees and decal skins are left as they are
    const leftMeshes = new Set<number>();
    const visit = (i: number, left: boolean) => {
        const n = srcJson.nodes[i], l = left || isSbVeggieNode(String(n.name ?? '')) || n.extras?.decal === true;
        if (l && n.mesh !== undefined) leftMeshes.add(n.mesh);
        for (const c of n.children ?? []) visit(c, l);
    };
    const nodes: any[] = srcJson.nodes ?? [], roots = new Set<number>(nodes.map((_, i) => i));
    for (const n of nodes) for (const c of n.children ?? []) roots.delete(c);
    for (const r of roots) visit(r, false);
    // the object's extent and surface area, in the world's metres
    const world = nodeWorldMatrices(srcJson);
    let area = 0;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    nodes.forEach((n, ni) => {
        if (n.mesh === undefined) return;
        for (const def of srcJson.meshes[n.mesh].primitives ?? []) {
            if ((def.mode ?? 4) !== 4 || def.attributes?.POSITION === undefined) continue;
            const pos = readAccessor(src, def.attributes.POSITION).data, idx = def.indices !== undefined ? readAccessor(src, def.indices).data : undefined;
            const count = idx ? idx.length : pos.length / 3;
            for (let t = 0; t + 2 < count; t += 3) {
                const q = [0, 1, 2].map(k => { const v = idx ? idx[t + k] : t + k; return transformPoint(world[ni], pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]); });
                for (const p of q) for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], p[j]); hi[j] = Math.max(hi[j], p[j]); }
                if (leftMeshes.has(n.mesh)) continue;
                const e1 = [q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]], e2 = [q[2][0] - q[0][0], q[2][1] - q[0][1], q[2][2] - q[0][2]];
                area += 0.5 * Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
            }
        }
    });
    if (!(area > 0)) throw new Error('the GLB has no triangle surface to give materials to (only trees or decal skins)');
    const size: [number, number, number] = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], diag = Math.hypot(...size);
    const texelsPerMeter = Math.sqrt(Math.max(64 * 64, P.targetTexels) / area), texelM = 1 / texelsPerMeter;
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    const tile: TileScale = { wantM: clamp(diag / 2, P.wantMinM, P.wantMaxM), maxM: clamp(4 * diag, P.maxMinM, P.maxMaxM) };
    const heightCapM = clamp(P.capOfDiagonal * diag, P.capMinM, HEIGHT_RELIEF.capM);

    // 1. every material its own atlas at one density
    options.progress?.(`object materials: rewrapping the object's UVs at ${Math.round(texelM * 1000)} mm a texel`);
    const rewrap = await unwrapRewrapGlb('rewrap', input, {
        texelsPerMeter, gutterTexels: 4, maxAtlasSide: 4096, outputImageFormat: 'png',
        leaveMeshes: { meshes: [...leftMeshes], reason: 'a tree or decal skin, left as it is' },
        native: { ...(options.native?.repoRoot ? { repoRoot: options.native.repoRoot } : {}), ...(options.native?.threads ? { threads: options.native.threads } : {}), ...(options.native?.timeoutMs ? { timeoutMs: options.native.timeoutMs } : {}) },
        ...(options.signal ? { signal: options.signal } : {})
    });
    const g = parseGlbBytes(new Uint8Array(rewrap.glb)), json = g.json;
    const texture = (index: number | undefined): RgbaImage8 | undefined => {
        const im = index !== undefined ? json.images?.[json.textures?.[index]?.source] : undefined, bv = im?.bufferView !== undefined ? json.bufferViews[im.bufferView] : undefined;
        return bv ? decodeImageInMemory(g.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength)) : undefined;
    };

    // 2. classes: per atlas, from its photo's colours or its one colour
    interface Atlas { material: number; name: string; width: number; height: number; cls: Uint8Array; first: number; count: number; texels: number[]; from: 'part' | 'photo'; finish?: ClassFinish }
    const atlases: Atlas[] = [], report: ObjectMaterialReport = { version: OBJECT_MATERIAL_PATH_VERSION, label: 'generated', objectSizeM: size.map(v => Math.round(v * 1000) / 1000) as [number, number, number], texelM: Math.round(texelM * 1e5) / 1e5, tile, heightCapM: Math.round(heightCapM * 1e4) / 1e4, classes: [], materials: [], ms: 0 };
    const classes: RegionClass[] = [], finishes: Array<ClassFinish | undefined> = [], classFrom: Array<{ from: 'part' | 'photo'; material: string; texels: number }> = [];
    for (const at of rewrap.report.atlases) {
        const mi = at.material;
        if (at.status === 'skipped' || mi === null) { report.materials.push({ material: mi ?? -1, width: 0, height: 0, classes: [], wrote: [], kept: [], reason: at.skippedReason ?? 'its primitives have no material' }); continue; }
        const m = json.materials[mi], pbr = m.pbrMetallicRoughness ?? {}, name = String(m.name ?? `material_${mi}`);
        const W = at.width, H = at.height, N = W * H;
        const prims = (json.meshes as any[]).flatMap((mesh, k) => (leftMeshes.has(k) ? [] : (mesh.primitives ?? []).filter((d: any) => d.material === mi && d.attributes?.TEXCOORD_0 !== undefined)));
        const cover = coverage(g, prims, W, H);
        // a part the detail pass weathered keeps its as-built factors in its extras: its class is read from those, not
        // from its weathered maps (dirt is not the part's material)
        const asBuilt = m.extras?.sbDetailPass?.before as { baseColorFactor?: number[]; roughnessFactor?: number; metallicFactor?: number; hadBaseColorTexture?: boolean } | undefined;
        const part = asBuilt && !asBuilt.hadBaseColorTexture ? asBuilt : undefined;
        const factor = (part?.baseColorFactor ?? pbr.baseColorFactor ?? [1, 1, 1, 1]) as number[];
        const photo = part ? undefined : texture(pbr.baseColorTexture?.index);
        const rough = part ? part.roughnessFactor : pbr.roughnessFactor, metal = part ? part.metallicFactor : pbr.metallicFactor;
        // the part's own finish, when its material states one (glTF's defaults say nothing)
        const finish: ClassFinish | undefined = rough !== undefined || metal !== undefined ? { roughness: clamp(rough ?? 1, 0, 1), metalness: clamp(metal ?? 1, 0, 1), conf: 100, seen: 'the part\'s own material factors' } : undefined;
        // the covered texels' colours (the photo times the factor, or the factor alone)
        const X: number[] = [], rnd = (() => { let s = P.seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); })();
        const colourAt = (k: number): [number, number, number] => {
            if (!photo || photo.width !== W || photo.height !== H) return [linearToSrgb8(factor[0]), linearToSrgb8(factor[1]), linearToSrgb8(factor[2])];
            const p = k * 4;
            return [linearToSrgb8(SRGB8_TO_LINEAR[photo.rgba[p]] * factor[0]), linearToSrgb8(SRGB8_TO_LINEAR[photo.rgba[p + 1]] * factor[1]), linearToSrgb8(SRGB8_TO_LINEAR[photo.rgba[p + 2]] * factor[2])];
        };
        let covered = 0;
        for (let k = 0; k < N; k++) covered += cover[k];
        if (!covered) { report.materials.push({ material: mi, name, width: W, height: H, classes: [], wrote: [], kept: [], reason: 'its triangles cover no texel of its atlas' }); continue; }
        for (let s = 0; s < Math.min(N, P.samples); s++) { const k = Math.floor(rnd() * N); if (cover[k]) X.push(...labOf(...colourAt(k))); }
        const n = X.length / 3, mean = [0, 1, 2].map(c => { let a = 0; for (let i = 0; i < n; i++) a += X[i * 3 + c]; return a / Math.max(1, n); });
        const spread = Math.sqrt([0, 1, 2].reduce((a, c) => { let v = 0; for (let i = 0; i < n; i++) v += (X[i * 3 + c] - mean[c]) ** 2; return a + v / Math.max(1, n); }, 0));
        const K = photo && spread >= P.photoSpread && n >= P.photoClasses * 10 ? P.photoClasses : 1;
        const km = K > 1 ? kMeansLab(X, K, P.iterations, 1) : { C: [mean], lab: new Int32Array(n) };
        const count = new Array<number>(K).fill(0), sd = Array.from({ length: K }, () => [0, 0, 0]);
        for (let i = 0; i < n; i++) { const k = km.lab[i]; count[k]++; for (let c = 0; c < 3; c++) sd[k][c] += (X[i * 3 + c] - km.C[k][c]) ** 2; }
        const mine = formatRegionClasses(km.C, count, sd, Math.max(1, n), classes.length, false);
        // each texel's class: its nearest among this material's (one class: all of them)
        const cls = new Uint8Array(N).fill(mine[0].index), texels = new Array<number>(K).fill(0);
        if (K > 1) for (let k = 0; k < N; k++) {
            const L = labOf(...colourAt(k));
            let best = 0, bd = Infinity;
            mine.forEach((c, j) => { const d = (L[0] - c.meanLab[0]) ** 2 + (L[1] - c.meanLab[1]) ** 2 + (L[2] - c.meanLab[2]) ** 2; if (d < bd) { bd = d; best = j; } });
            cls[k] = mine[best].index;
            if (cover[k]) texels[best]++;
        } else texels[0] = covered;
        atlases.push({ material: mi, name, width: W, height: H, cls, first: classes.length, count: K, texels, from: K > 1 ? 'photo' : 'part', ...(finish ? { finish } : {}) });
        mine.forEach((c, j) => { classes.push({ ...c, wall: false }); finishes.push(finish); classFrom.push({ from: K > 1 ? 'photo' : 'part', material: name, texels: texels[j] }); });
    }
    if (!classes.length) throw new Error(`no material of the object could be read: ${report.materials.map(r => r.reason).join('; ')}`);
    if (classes.length > 255) throw new Error(`the object has ${classes.length} material classes; the path draws at most 255`);
    const allTexels = classFrom.reduce((a, c) => a + c.texels, 0);
    classes.forEach((c, k) => { c.share = Math.round((classFrom[k].texels / Math.max(1, allTexels)) * 1000) / 1000; });

    // 3. a library set per class, at the object's scale
    options.progress?.(`object materials: ${classes.length} classes of ${atlases.length} materials; matching library sets of a ${tile.wantM.toFixed(2)} m tile (at most ${tile.maxM.toFixed(1)} m)`);
    const finishOf = async () => finishes;
    const sets = options.resolveSets
        ? await options.resolveSets(classes, tile, { heightCapM, finish: finishOf })
        : await resolveClassSets(classes, tile, { heightCapM, finish: finishOf, ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.progress ? { progress: options.progress } : {}), ...(options.choose ? { choose: options.choose } : {}), ...(options.store ? { store: options.store } : {}) });
    options.signal?.throwIfAborted();

    // 4. the maps on each material, 5. the relief
    // the GLB appended to in place (a writer that drops what no material slot names would drop the relief's textures,
    // which only the extras name)
    const out = JSON.parse(JSON.stringify(json));
    const chunks: Uint8Array[] = [g.bin];
    let binLength = g.bin.length;
    const addImage = (bytes: Uint8Array, mimeType: string, name: string): number => {
        if (binLength % 4) { const pad = new Uint8Array(4 - (binLength % 4)); chunks.push(pad); binLength += pad.length; }
        out.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength });
        chunks.push(bytes); binLength += bytes.byteLength;
        out.images.push({ bufferView: out.bufferViews.length - 1, mimeType, name });
        return out.images.length - 1;
    };
    out.samplers ??= []; out.textures ??= []; out.images ??= []; out.bufferViews ??= [];
    out.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 33071, wrapT: 33071 });
    const clampSampler = out.samplers.length - 1;
    out.samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 });
    const repeatSampler = out.samplers.length - 1;
    const addTexture = (bytes: Uint8Array, mime: string, name: string, sampler: number) => { out.textures.push({ sampler, source: addImage(bytes, mime, name), name }); return out.textures.length - 1; };
    const png = (img: RgbaImage8) => encodePng(img.width, img.height, img.rgba, 4);
    const jpeg = (img: RgbaImage8) => encodeRgbaToJpeg(img.rgba, img.width, img.height, { quality: 92, chroma: '444' });
    const anyRelief = sets.some(s => !!s.height);
    for (const at of atlases) {
        const present = classes.map((_, k) => (k >= at.first && k < at.first + at.count ? 1 : 0));
        const drawn = drawClassSets(at.cls, at.width, at.height, texelM, sets, present);
        const m = out.materials[at.material], pbr = (m.pbrMetallicRoughness ??= {});
        const before = { roughnessFactor: pbr.roughnessFactor ?? null, metallicFactor: pbr.metallicFactor ?? null, hadMetallicRoughnessTexture: !!pbr.metallicRoughnessTexture, hadNormalTexture: !!m.normalTexture };
        const wrote: string[] = [], kept: string[] = [];
        if (!pbr.metallicRoughnessTexture) {
            const orm = addTexture(await jpeg(drawn.orm), 'image/jpeg', `${at.name}_material_orm`, clampSampler);
            pbr.metallicRoughnessTexture = { index: orm }; pbr.roughnessFactor = 1; pbr.metallicFactor = 1;
            wrote.push('roughness', 'metalness');
            if (!m.occlusionTexture) { m.occlusionTexture = { index: orm }; wrote.push('occlusion'); } else kept.push('occlusion');
        } else kept.push('roughness', 'metalness');
        if (!m.normalTexture) { m.normalTexture = { index: addTexture(await jpeg(drawn.normal), 'image/jpeg', `${at.name}_material_normal`, clampSampler) }; wrote.push('normal'); } else kept.push('normal');
        const mine = sets.slice(at.first, at.first + at.count);
        const relief = drawn.classes && mine.some(s => !!s.height) ? { classTexture: addTexture(png(drawn.classes), 'image/png', `${at.name}_classes`, clampSampler), weights: true, uvMetres: [Math.round(at.width * texelM * 1e4) / 1e4, Math.round(at.height * texelM * 1e4) / 1e4] } : undefined;
        if (relief) wrote.push('height');
        m.extras = {
            ...(m.extras ?? {}),
            ...(relief ? { sbRelief: relief } : {}),
            sbMaterialPath: {
                label: 'generated', version: OBJECT_MATERIAL_PATH_VERSION,
                method: `the material path on an object (object-materials.ts): ${at.from === 'photo' ? `${at.count} appearance classes read from this material's photo` : 'this part one class by its colour and factors'}, each a texture library set by colour, finish and real size, its maps tiled at the set's real size; the colour untouched`,
                classes: mine.map((s, j) => ({ class: at.first + j, set: s.name, tileM: s.realSizeM, ...(s.heightDrawn ? { height: s.heightDrawn } : {}) })), wrote, kept, before
            }
        };
        report.materials.push({ material: at.material, name: at.name, width: at.width, height: at.height, classes: mine.map((_, j) => at.first + j), wrote, kept });
    }
    if (anyRelief) {
        out.asset = out.asset ?? { version: '2.0' };
        out.asset.extras = { ...(out.asset.extras ?? {}), sbMaterialRelief: reliefAssetExtras(sets, heightCapM, (img, name) => addTexture(png(img), 'image/png', name, repeatSampler)) };
    }
    report.classes = classes.map((c, k) => ({ index: c.index, from: classFrom[k].from, material: classFrom[k].material, meanLab: c.meanLab, share: c.share, set: sets[k].name, distance: Math.round(sets[k].distance * 100) / 100, ...(sets[k].finish ? { finish: sets[k].finish } : {}), ...(sets[k].choice ? { choice: sets[k].choice } : {}), ...(sets[k].heightDrawn ? { height: sets[k].heightDrawn } : {}) }));
    if (binLength % 4) { const pad = new Uint8Array(4 - (binLength % 4)); chunks.push(pad); binLength += pad.length; }
    out.buffers = [{ byteLength: binLength }];
    const packed = new Uint8Array(binLength);
    let at = 0;
    for (const c of chunks) { packed.set(c, at); at += c.byteLength; }
    let glb: Uint8Array = assembleGlb(out, packed);

    // the whole object's relief displaced in the engine, drawn up close
    if (anyRelief && options.displace !== false) {
        const params: HeightReliefParams = {
            ...HEIGHT_RELIEF_PARAMS, bandM: undefined, cellM: Math.max(1, 2 * diag), edgeMinM: Math.max(0.003, texelM), edgeMaxM: Math.max(0.02, 0.05 * diag),
            toleranceM: heightCapM / 20, minRecessM: heightCapM / 30, fadeM: Math.max(0.005, Math.min(0.08, 0.02 * diag)), maxTriangles: P.maxTriangles, showWithinM: Math.max(4, 6 * diag)
        };
        options.progress?.('object materials: displacing the parts by their materials\' height');
        const hr = await applyHeightRelief(glb, params, { ...(options.native?.threads ? { threads: options.native.threads } : {}), ...(options.signal ? { signal: options.signal } : {}) });
        glb = hr.glb;
        report.relief = hr.report;
    }
    report.ms = Date.now() - t0;
    const fin = parseGlbBytes(glb);
    fin.json.asset = fin.json.asset ?? { version: '2.0' };
    fin.json.asset.extras = { ...(fin.json.asset.extras ?? {}), sbMaterialPath: report };
    return { glb: assembleGlb(fin.json, fin.bin), report };
}

/** One line for a tool's result. */
export function describeObjectMaterials(r: ObjectMaterialReport): string {
    return `object materials: ${r.classes.length} classes on ${r.materials.filter(m => m.wrote.length).length} materials (${r.classes.map(c => `${c.material}${c.from === 'photo' ? ` L ${Math.round(c.meanLab[0])}` : ''} -> ${c.set}${c.height ? `, height up to ${Math.round(c.height.maxRecessM * 1000)} mm` : ''}`).join('; ')}); ` +
        `tiles toward ${r.tile.wantM.toFixed(2)} m, ${Math.round(r.texelM * 1000)} mm a texel` +
        `${r.relief?.cells ? `; ${r.relief.nearTriangles + r.relief.riserTriangles} displaced triangles drawn within ${r.relief.showWithinM} m` : r.relief?.skipped ? `; nothing displaced: ${r.relief.skipped}` : ''} (generated, ${r.ms} ms)`;
}
