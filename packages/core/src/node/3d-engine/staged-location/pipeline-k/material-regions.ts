/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * Pipeline K's material regions: the harmonised photos of one textured building kept as its colour, with a roughness and
 * normal under them, so the building answers the scene's light instead of showing the light it was photographed in (the
 * photos were drawn unlit before this stage).
 *
 *  1. Appearance classes: k-means in CIELAB on texels sampled from the rebuilt facades' photos, one set of classes for the
 *     whole building. The lightest class is the wall.
 *  2. Openings: where the lattice drew a structure (facade-lattice.ts STRUCTURE: the piers, bands and parapets) and the
 *     bays it frames (the window strips), the wall's set is drawn on the structure alone; glass is decided by bay, never
 *     texel by texel: a bay most of whose texels are not the wall's class is glass whole; a bay mostly of the wall's
 *     class (a column of punched windows on a masonry wall) and the windows outside the bays (a base; window-fit.ts)
 *     take glass on their fitted panes alone, less a pane most of whose texels are the wall's class; the rest the
 *     frame's finish, one set: the most common class other than the wall among them. A scan piece lying on a fitted
 *     plane (facing its way within planeCos, within planeBandM of it; window-fit.ts fittedPlanesOf) takes glass by that
 *     plane's bays alone (the strips windowStrips draws from its windows; a bay mostly of the wall's class there none),
 *     each texel projected into the plane's ortho. Everywhere else every texel is wall, whatever its colour: a darker
 *     class is weathered or shaded stone as often as anything else, and a colour alone never makes a window or a metal.
 *  3. A library set per class (resolved by the caller: the texture library ranked by the class colour as a dielectric
 *     surface), its roughness and normal drawn at the set's real size over each rebuilt facade (box-filtered to the
 *     facade's texel, so a tile never aliases), and the wall set's mean finish on scan pieces. Nothing is drawn metal: no
 *     reading here tells a metal from a dark stone.
 *  4. Glass: the photo kept as its colour (its reflection is what the photo shows), the roughness of float glass, and the
 *     parameters texture (R glass weight; A the seed of each bay's storey, from the facade's own storey pitch, the viewer's
 *     tilt) the viewer reads for the scene's reflection; it fades in over glassFeatherM from its edge (weight, roughness
 *     and normal blended from the finish it sits in), so no hard line rings it.
 *
 * Labels: base colour photo-inferred (the photo, never relit or lifted: it is the evidence of how the building looks);
 * roughness and normal generated (library sets); glass photo-inferred (the bays' texels off the wall's class). Nothing is
 * drawn where no photo is.
 */

import { readAccessor, type ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import { linearRgbToLab } from '../../../../common/spatial/texture-library-index';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { GLASS_ROUGHNESS } from '../facade-materials';
import { MATERIAL_PARAMS_CHANNELS } from '../staged-glb-writer';
import { bandResponses, TEXTURE_BANDS_M, type TextureEnergy } from './material-harvest';
import type { FittedPlane } from '../window-fit';
import { windowStrips } from '../facade-lattice';

export const MATERIAL_REGIONS_VERSION = 'material-regions/28';

export const MATERIAL_REGIONS_PARAMS = {
    /** Appearance classes, texels sampled per facade photo, k-means iterations, sampling seed. */
    classes: 4, samplesPerPhoto: 40000, iterations: 40, seed: 7,
    /** A fitted pane's glass weight in the parameters texture (0-255): the window fit's confidence, not a measurement of the glass. */
    paneGlassWeight: 128,
    /** Glass fades in over this from its edge (m): its weight, roughness and normal blend from the finish around it. */
    glassFeatherM: 0.15,
    /** A bay is glass whole, and a punched window's pane glass, only when less than this share of its texels fall in the wall's class. */
    paneWallShare: 0.5,
    /** A scan triangle lies on a fitted plane when it faces the plane's way within this cosine and its centre is within this of the plane (m). */
    planeCos: 0.9, planeBandM: 1.0
};

/**
 * Each fitted pane's seed (1-254) in the parameters texture's alpha: the viewer tilts the pane by a small angle of its own
 * from it (generated: real panes sit a degree or so off their wall's plane), so a facade's panes catch the sun one by one.
 */
export const paneSeed = (pane: number) => 1 + ((Math.imul(pane + 1, 2654435761) >>> 0) % 254);
export type MaterialRegionsParams = typeof MATERIAL_REGIONS_PARAMS;

/** A rebuilt facade's mesh, by the name facade-lattice.ts gives it: its photo is a metric orthophoto of one plane. */
const REBUILT_FACADE = /^facade_lattice_\d+$/;

export interface RegionClass {
    index: number;
    /** Mean colour, CIELAB and linear sRGB, and spread (CIELAB standard deviation). */
    meanLab: [number, number, number]; meanLinear: [number, number, number]; spreadLab: [number, number, number];
    /** Share of the sampled facade texels. */
    share: number;
    /** The lightest class: the wall, drawn everywhere outside the fitted windows. */
    wall: boolean;
    /** The tile-only harvest (material-harvest.ts): the class's texture energy on the facade photos, and on how many facades it holds at least 5%. Photo-inferred. */
    texture?: TextureEnergy; facades?: number;
}

/** One class's library set, resolved by the caller: maps prepared small (the engine's prepare_material_maps). */
export interface RegionSet {
    name: string;
    /** Real size of one tile, metres (x, y). */
    realSizeM: [number, number];
    /** OpenGL tangent-space normal and packed occlusion/roughness/metalness, RGBA8 (its metalness is not drawn). */
    normal: RgbaImage8; orm: RgbaImage8;
    /** How near the set lies to the class (the library search's distance). */
    distance: number;
    /** The tile-only harvest's pick (material-harvest.ts): the class's and the set's texture energy at the class's texel, the distances it was chosen by, and what of it is generated. */
    harvest?: { colourDistance: number; textureDistance: number; classEnergy: number[]; setEnergy: number[]; texelM: number; candidates: number; grain: string };
}

export interface MaterialRegionsReport {
    version: string;
    classes: Array<Pick<RegionClass, 'index' | 'meanLab' | 'share' | 'wall' | 'texture' | 'facades'> & { set: string; distance: number; harvest?: RegionSet['harvest'] }>;
    facades: { total: number; withWindows: number; perFacade: Array<{ mesh: string; texelM: number; /** The window fit's windows (window-fit.ts) and the lattice's bays, the share of the facade the windows cover, and the share drawn as glass (the bays' texels off the wall's class). */ fittedWindows: number; bays: number; windowShare: number; glassShare: number; /** The share of the facade its structure covers (the wall's set there; the bays' infill takes the frame's). */ structureShare: number; /** The class the windows' frames and the bays' infill are drawn with. */ frameSet: string }> };
    /** Scan pieces: their texels on a fitted plane, in its windows and in its panes (shares of all their texels), and the planes drawn on them. */
    scanPieces: { total: number; onPlanes: number; windowShare: number; paneShare: number; planes: number[] };
    texels: { total: number; glass: number };
    /** Punched windows' panes (outside the glass bays) not drawn as glass: most of their texels the wall's class. */
    panesOnStone: number;
    /** Bays (rebuilt facades' and scan pieces') mostly of the wall's class: glass only on their windows' panes. */
    baysOnStone: number;
    ms: number;
}

/** A material's maps, planned before the photos are encoded. */
interface PlannedMaterial {
    material: number;
    orm: RgbaImage8; normal?: RgbaImage8; params: RgbaImage8;
    rebuilt: boolean; glass: boolean;
}

export interface MaterialRegionsPlan { materials: PlannedMaterial[]; sets: RegionSet[]; report: MaterialRegionsReport }


// ---- colour ----
const LAB_CACHE = new Map<number, [number, number, number]>();
function labOf(r: number, g: number, b: number): [number, number, number] {
    // 5 bits a channel is finer than the classes need and keeps the cache small; the value is the bucket's own centre, so it
    // never depends on which texel filled the cache first (and is the same on every worker thread)
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let v = LAB_CACHE.get(key);
    if (!v) { v = linearRgbToLab([SRGB8_TO_LINEAR[(r & ~7) | 4], SRGB8_TO_LINEAR[(g & ~7) | 4], SRGB8_TO_LINEAR[(b & ~7) | 4]]); LAB_CACHE.set(key, v); }
    return v;
}
const lumaOf = (rgba: Uint8Array, p: number) => 0.2126 * SRGB8_TO_LINEAR[rgba[p]] + 0.7152 * SRGB8_TO_LINEAR[rgba[p + 1]] + 0.0722 * SRGB8_TO_LINEAR[rgba[p + 2]];

/** The image a material's colour texture shows, and the UV set it uses. */
function photoOf(json: any, material: number | undefined): { image: number; texCoord: number } | undefined {
    if (material === undefined) return undefined;
    const t = json.materials?.[material]?.pbrMetallicRoughness?.baseColorTexture;
    const image = t ? json.textures?.[t.index]?.source : undefined;
    return image === undefined ? undefined : { image, texCoord: t.texCoord ?? 0 };
}

/** Each textured triangle of a material: its world corners and UVs. */
function forEachTriangleOf(g: ParsedGlb, json: any, material: number, fn: (p: Float64Array, uv: Float64Array) => void): void {
    const p = new Float64Array(9), q = new Float64Array(6);
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.material !== material || prim.attributes?.POSITION === undefined) continue;
        const photo = photoOf(json, material);
        const uvAcc = photo ? prim.attributes[`TEXCOORD_${photo.texCoord}`] : undefined;
        if (uvAcc === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data, uv = readAccessor(g, uvAcc).data;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        for (let t = 0; t + 2 < n; t += 3) {
            for (let k = 0; k < 3; k++) {
                const i = idx ? idx[t + k] : t + k;
                p[k * 3] = pos[i * 3]; p[k * 3 + 1] = pos[i * 3 + 1]; p[k * 3 + 2] = pos[i * 3 + 2]; q[k * 2] = uv[i * 2]; q[k * 2 + 1] = uv[i * 2 + 1];
            }
            fn(p, q);
        }
    }
}

/** Visits the texels of a triangle given in pixel coordinates. */

const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Visits the texels of a triangle given in UVs (uv * size), with each texel centre's barycentric weights. */
function forTexelsOf(uv: ArrayLike<number>, W: number, H: number, visit: (k: number, wa: number, wb: number, wc: number) => void): void {
    const ax = uv[0] * W, ay = uv[1] * H, bx = uv[2] * W, by = uv[3] * H, cx = uv[4] * W, cy = uv[5] * H;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) return;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const wa = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, wb = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, wc = 1 - wa - wb;
        if (wa >= 0 && wb >= 0 && wc >= 0) visit(y * W + x, wa, wb, wc);
    }
}

/** Metres per texel of a rebuilt facade's photo, from its triangles' world area against their area in texels. */
function texelMetres(g: ParsedGlb, json: any, material: number, img: RgbaImage8): number {
    let world = 0, texels = 0;
    forEachTriangleOf(g, json, material, (p, uv) => {
        const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
        world += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        texels += 0.5 * Math.abs((uv[2] - uv[0]) * img.width * (uv[5] - uv[1]) * img.height - (uv[4] - uv[0]) * img.width * (uv[3] - uv[1]) * img.height);
    });
    return texels > 0 ? Math.sqrt(world / texels) : 0;
}



/** A rebuilt facade's fitted windows (window-fit.ts), u0 v0 u1 v1 per window, as facade-lattice.ts wrote them (sbFacadeLattice.windows). */
function fittedWindows(json: any, meshName: string): number[] | undefined {
    const mi = (json.meshes ?? []).findIndex((m: any) => m.name === meshName);
    const uv = (json.nodes ?? []).find((n: any) => n.mesh === mi && n.extras?.sbFacadeLattice?.windows)?.extras.sbFacadeLattice.windows.uv;
    return Array.isArray(uv) && uv.length % 4 === 0 ? uv : undefined;
}

/** The glass in a rebuilt facade's fitted windows (window-fit.ts panes), u0 v0 u1 v1 each, as facade-lattice.ts wrote them. */
function fittedPanes(json: any, meshName: string): number[] | undefined {
    const mi = (json.meshes ?? []).findIndex((m: any) => m.name === meshName);
    const uv = (json.nodes ?? []).find((n: any) => n.mesh === mi && n.extras?.sbFacadeLattice?.windows)?.extras.sbFacadeLattice.windows.panes;
    return Array.isArray(uv) && uv.length % 4 === 0 && uv.length ? uv : undefined;
}

/** A rebuilt facade's bays (the window strips its structure frames), u0 v0 u1 v1 each, as facade-lattice.ts wrote them. */
function structureBays(json: any, meshName: string): number[] | undefined {
    const mi = (json.meshes ?? []).findIndex((m: any) => m.name === meshName);
    const uv = (json.nodes ?? []).find((n: any) => n.mesh === mi && n.extras?.sbFacadeLattice?.structure)?.extras.sbFacadeLattice.structure.bays;
    return Array.isArray(uv) && uv.length % 4 === 0 && uv.length ? uv : undefined;
}

/** A rebuilt facade's structure (facade-lattice.ts STRUCTURE: its piers, bands and parapets), u0 v0 u1 v1 per run, as facade-lattice.ts wrote it. */
function structureRuns(json: any, meshName: string): number[] | undefined {
    const mi = (json.meshes ?? []).findIndex((m: any) => m.name === meshName);
    const uv = (json.nodes ?? []).find((n: any) => n.mesh === mi && n.extras?.sbFacadeLattice?.structure)?.extras.sbFacadeLattice.structure.uv;
    return Array.isArray(uv) && uv.length % 4 === 0 && uv.length ? uv : undefined;
}

function sampler(seed: number): () => number { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

/** The rebuilt facades' materials of a GLB (see REBUILT_FACADE) and every other photo-textured material. */
function photoMaterials(json: any): { rebuilt: Map<number, string>; other: Set<number> } {
    const rebuilt = new Map<number, string>(), other = new Set<number>();
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if (prim.material === undefined || !photoOf(json, prim.material)) continue;
        if (REBUILT_FACADE.test(mesh.name ?? '')) rebuilt.set(prim.material, mesh.name); else other.add(prim.material);
    }
    for (const mi of rebuilt.keys()) other.delete(mi);
    return { rebuilt, other };
}

/**
 * The building's appearance classes, from its rebuilt facades' photos (image index -> photo); undefined when it has no
 * rebuilt facade (nothing gives the classes a metric photo to come from).
 */
export function readRegionClasses(json: any, images: Map<number, RgbaImage8>, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS, harvest?: { g: ParsedGlb }): RegionClass[] | undefined {
    const { rebuilt } = photoMaterials(json);
    const rnd = sampler(P.seed), X: number[] = [];
    // the harvest reads wall only: each rebuilt facade's fitted windows and panes left out
    const excluded = new Map<number, Uint8Array>();
    if (harvest) for (const [mi, mesh] of rebuilt) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        const ex = new Uint8Array(img.width * img.height);
        const rects = [...(fittedWindows(json, mesh) ?? []), ...(fittedPanes(json, mesh) ?? [])];
        for (let k = 0; k + 3 < rects.length; k += 4) {
            const x0 = Math.max(0, Math.floor(rects[k] * img.width)), y0 = Math.max(0, Math.floor(rects[k + 1] * img.height)), x1 = Math.min(img.width, Math.ceil(rects[k + 2] * img.width)), y1 = Math.min(img.height, Math.ceil(rects[k + 3] * img.height));
            for (let y = y0; y < y1; y++) ex.fill(1, y * img.width + x0, y * img.width + x1);
        }
        excluded.set(mi, ex);
    }
    for (const mi of rebuilt.keys()) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        const N = img.width * img.height, take = Math.min(N, P.samplesPerPhoto), ex = excluded.get(mi);
        for (let s = 0; s < take; s++) {
            const q = Math.floor(rnd() * N), p = q * 4;
            if (!img.rgba[p + 3] || ex?.[q]) continue;
            X.push(...labOf(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]));
        }
    }
    // the harvest weighs lightness at half: one material lit two ways, or split by a photo seam, stays one class
    const wL = harvest ? 0.5 : 1;
    const n = X.length / 3, K = P.classes;
    if (n < K * 10) return undefined;
    // seeds spread over lightness, so the classes come out ordered and the result does not depend on a draw
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => X[a * 3] - X[b * 3]);
    let C = Array.from({ length: K }, (_, k) => { const i = order[Math.floor(((k + 0.5) / K) * n)]; return [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]; });
    const lab = new Int32Array(n);
    for (let it = 0; it < P.iterations; it++) {
        const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
        for (let i = 0; i < n; i++) {
            let best = 0, bd = Infinity;
            for (let k = 0; k < K; k++) { const d = (wL * (X[i * 3] - C[k][0])) ** 2 + (X[i * 3 + 1] - C[k][1]) ** 2 + (X[i * 3 + 2] - C[k][2]) ** 2; if (d < bd) { bd = d; best = k; } }
            lab[i] = best; sum[best][0] += X[i * 3]; sum[best][1] += X[i * 3 + 1]; sum[best][2] += X[i * 3 + 2]; sum[best][3]++;
        }
        C = C.map((c, k) => sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : c);
    }
    const idx = C.map((_, k) => k).sort((a, b) => C[a][0] - C[b][0]);
    const classes: RegionClass[] = idx.map((k, rank) => {
        let cnt = 0;
        const sd = [0, 0, 0];
        for (let i = 0; i < n; i++) if (lab[i] === k) { cnt++; for (let c = 0; c < 3; c++) sd[c] += (X[i * 3 + c] - C[k][c]) ** 2; }
        const [L, a, b] = C[k];
        // back to linear sRGB for the library query (CIELAB D65 inverted)
        const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
        const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
        const Xw = inv(fx) * 0.95047, Yw = inv(fy), Zw = inv(fz) * 1.08883;
        const lin: [number, number, number] = [3.2406 * Xw - 1.5372 * Yw - 0.4986 * Zw, -0.9689 * Xw + 1.8758 * Yw + 0.0415 * Zw, 0.0557 * Xw - 0.204 * Yw + 1.057 * Zw].map(v => Math.max(0, Math.min(1, v))) as [number, number, number];
        const r2 = (v: number) => Math.round(v * 100) / 100;
        return {
            index: rank, meanLab: [r2(L), r2(a), r2(b)], meanLinear: lin.map(r2) as [number, number, number],
            spreadLab: sd.map(v => r2(Math.sqrt(v / Math.max(1, cnt)))) as [number, number, number],
            share: Math.round((cnt / n) * 1000) / 1000, wall: rank === K - 1
        };
    });
    if (harvest) harvestTextures(harvest.g, json, images, rebuilt, excluded, classes, wL);
    return classes;
}

/**
 * The tile-only harvest's texture per class (material-harvest.ts): on each rebuilt facade's photo, at its own texel, the band
 * responses of its wall texels (fitted windows and panes left out), summed per class (each texel's nearest class, lightness
 * weighed as the classes were); and on how many facades each class holds at least 5% of the wall.
 */
function harvestTextures(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, rebuilt: Map<number, string>, excluded: Map<number, Uint8Array>, classes: RegionClass[], wL: number): void {
    const K = classes.length, B = TEXTURE_BANDS_M.length;
    const sq = Array.from({ length: K }, () => new Float64Array(B)), lum = Array.from({ length: K }, () => new Float64Array(B)), cnt = Array.from({ length: K }, () => new Float64Array(B));
    const texelSum = new Float64Array(K), texelN = new Float64Array(K), facades = new Int32Array(K);
    for (const [mi] of rebuilt) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        const texelM = texelMetres(g, json, mi, img);
        if (!(texelM > 0)) continue;
        const N = img.width * img.height, ex = excluded.get(mi), valid = new Uint8Array(N), L = new Float32Array(N), cls = new Int8Array(N).fill(-1);
        const share = new Float64Array(K);
        for (let i = 0; i < N; i++) {
            const p = i * 4;
            if (!img.rgba[p + 3] || ex?.[i]) continue;
            valid[i] = 1;
            L[i] = lumaOf(img.rgba, p);
            const lab = labOf(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]);
            let best = 0, bd = Infinity;
            for (let k = 0; k < K; k++) { const c = classes[k].meanLab, d = (wL * (lab[0] - c[0])) ** 2 + (lab[1] - c[1]) ** 2 + (lab[2] - c[2]) ** 2; if (d < bd) { bd = d; best = k; } }
            cls[i] = best; share[best]++;
        }
        const total = share.reduce((a, b) => a + b, 0);
        if (!total) continue;
        for (let k = 0; k < K; k++) if (share[k] / total >= 0.05) facades[k]++;
        const r = bandResponses(L, img.width, img.height, texelM, valid);
        for (let i = 0; i < N; i++) {
            const k = cls[i];
            if (k < 0) continue;
            texelSum[k] += texelM; texelN[k]++;
            for (let b = 0; b < B; b++) if (Number.isFinite(r[b][i])) { sq[k][b] += r[b][i] * r[b][i]; lum[k][b] += L[i]; cnt[k][b]++; }
        }
    }
    classes.forEach((c, k) => {
        if (!texelN[k]) return;
        c.texture = { texelM: Math.round((texelSum[k] / texelN[k]) * 1e4) / 1e4, energy: Array.from({ length: B }, (_, b) => { if (!cnt[k][b]) return NaN; const m = lum[k][b] / cnt[k][b]; return m > 0 ? Math.round((sq[k][b] / cnt[k][b] / (m * m)) * 1e6) / 1e6 : NaN; }) };
        c.facades = facades[k];
    });
}

/** Each texel's class, with a 3 x 3 majority so single-texel speckle never flips a finish. */
function classify(img: RgbaImage8, classes: RegionClass[], only?: Uint8Array): Uint8Array {
    const { width: W, height: H, rgba } = img, K = classes.length;
    const raw = new Uint8Array(W * H);
    for (let k = 0; k < W * H; k++) {
        if (only && !only[k]) { raw[k] = K - 1; continue; }
        const [L, a, b] = labOf(rgba[k * 4], rgba[k * 4 + 1], rgba[k * 4 + 2]);
        let best = 0, bd = Infinity;
        for (let c = 0; c < K; c++) { const m = classes[c].meanLab, d = (L - m[0]) ** 2 + (a - m[1]) ** 2 + (b - m[2]) ** 2; if (d < bd) { bd = d; best = c; } }
        raw[k] = best;
    }
    const out = new Uint8Array(W * H), votes = new Uint16Array(K);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        votes.fill(0);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < H && xx >= 0 && xx < W) votes[raw[yy * W + xx]]++;
        }
        let best = raw[y * W + x];
        for (let c = 0; c < K; c++) if (votes[c] > votes[best]) best = c;
        out[y * W + x] = best;
    }
    return out;
}

/** A library map box-filtered to a tile of tw x th texels (each texel the mean of the source texels it covers). */
function shrinkTile(src: RgbaImage8, tw: number, th: number, normal: boolean): Float32Array {
    const out = new Float32Array(tw * th * 3);
    for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
        const x0 = Math.floor((tx * src.width) / tw), x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * src.width) / tw));
        const y0 = Math.floor((ty * src.height) / th), y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * src.height) / th));
        const s = [0, 0, 0];
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) s[c] += src.rgba[(y * src.width + x) * 4 + c] / 255;
        const n = (x1 - x0) * (y1 - y0);
        let v = s.map(c => c / n);
        if (normal) { const d = v.map(c => c * 2 - 1), l = Math.hypot(d[0], d[1], d[2]) || 1; v = d.map(c => (c / l) * 0.5 + 0.5); }
        out.set(v, (ty * tw + tx) * 3);
    }
    return out;
}

function meanOf(src: RgbaImage8): [number, number, number] {
    const s = [0, 0, 0], n = src.width * src.height;
    for (let k = 0; k < n; k++) for (let c = 0; c < 3; c++) s[c] += src.rgba[k * 4 + c] / 255;
    return s.map(v => v / n) as [number, number, number];
}

const blank = (W: number, H: number): RgbaImage8 => ({ width: W, height: H, rgba: new Uint8Array(W * H * 4) });


/**
 * Marks the texels of rects (u0 v0 u1 v1 each, in the photo's UVs) that `inside` allows, each with `value(rect index)`;
 * returns how many it marked.
 */
function markRects(rects: number[], W: number, H: number, mask: Uint8Array, inside?: Uint8Array, value: (r: number) => number = () => 1): number {
    let n = 0;
    for (let i = 0; i + 3 < rects.length; i += 4) {
        const x0 = Math.max(0, Math.round(rects[i] * W)), x1 = Math.min(W, Math.round(rects[i + 2] * W));
        const y0 = Math.max(0, Math.round(rects[i + 1] * H)), y1 = Math.min(H, Math.round(rects[i + 3] * H));
        const v = value(i / 4);
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * W + x; if (!mask[k] && (!inside || inside[k])) { mask[k] = v; n++; } }
    }
    return n;
}

/** Each texel's pane (rect index + 1; 0 none) of rects (u0 v0 u1 v1 each, in the photo's UVs) within `inside`. */
function paneIdsOf(rects: number[], W: number, H: number, inside: Uint8Array): Int32Array {
    const ids = new Int32Array(W * H);
    for (let i = 0; i + 3 < rects.length; i += 4) {
        const x0 = Math.max(0, Math.round(rects[i] * W)), x1 = Math.min(W, Math.round(rects[i + 2] * W));
        const y0 = Math.max(0, Math.round(rects[i + 1] * H)), y1 = Math.min(H, Math.round(rects[i + 3] * H));
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const k = y * W + x; if (!ids[k] && inside[k]) ids[k] = i / 4 + 1; }
    }
    return ids;
}

/** The panes (ids, as paneIdsOf) at least `share` of whose texels fall in the wall's class: stone, never drawn as glass. */
function stonePanes(img: RgbaImage8, classes: RegionClass[], ids: Int32Array, share: number): Set<number> {
    const mask = Uint8Array.from(ids, v => (v ? 1 : 0));
    if (!mask.some(v => v)) return new Set();
    const cls = classify(img, classes, mask), WALL = classes.length - 1;
    const n = new Map<number, [number, number]>();
    for (let k = 0; k < ids.length; k++) if (ids[k]) { const c = n.get(ids[k]) ?? [0, 0]; c[0]++; if (cls[k] === WALL) c[1]++; n.set(ids[k], c); }
    return new Set([...n].filter(([, [all, wall]]) => wall >= share * all).map(([id]) => id));
}

/**
 * The storey pitch and phase of a facade's fitted windows (u0 v0 u1 v1 each, in the photo's UVs) in texels: the median step
 * between windows standing one above another in a column; undefined with fewer than three such steps.
 */
function storeyPitchOf(rects: number[], W: number, H: number): { pitch: number; phase: number } | undefined {
    const ws: Array<[number, number, number]> = [];
    for (let i = 0; i + 3 < rects.length; i += 4) ws.push([(rects[i] + rects[i + 2]) / 2 * W, (rects[i + 2] - rects[i]) * W, rects[i + 1] * H]);
    ws.sort((a, b) => a[0] - b[0] || a[2] - b[2]);
    const steps: number[] = [];
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
        if (Math.abs(ws[j][0] - ws[i][0]) > 0.5 * Math.min(ws[i][1], ws[j][1])) continue;
        const d = Math.abs(ws[j][2] - ws[i][2]);
        if (d > 2) { steps.push(d); break; }
    }
    if (steps.length < 3) return undefined;
    const st = [...steps].sort((a, b) => a - b), pitch = st[st.length >> 1];
    const phases = ws.map(w => ((w[2] % pitch) + pitch) % pitch).sort((a, b) => a - b);
    return { pitch, phase: phases[phases.length >> 1] };
}

/** Each glass texel's weight: its distance (texels, chamfer) to the nearest texel that is not glass, over `ramp`, capped at 1. */
function featherWeights(glass: ArrayLike<number>, W: number, H: number, ramp: number): Float32Array {
    const N = W * H, d = new Float32Array(N);
    for (let k = 0; k < N; k++) d[k] = glass[k] ? 1e9 : 0;
    const relax = (k: number, j: number, c: number) => { if (d[j] + c < d[k]) d[k] = d[j] + c; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x;
        if (!d[k]) continue;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) d[k] = Math.min(d[k], 1);
        if (x > 0) relax(k, k - 1, 1);
        if (y > 0) { relax(k, k - W, 1); if (x > 0) relax(k, k - W - 1, 1.414); if (x < W - 1) relax(k, k - W + 1, 1.414); }
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
        const k = y * W + x;
        if (!d[k]) continue;
        if (x < W - 1) relax(k, k + 1, 1);
        if (y < H - 1) { relax(k, k + W, 1); if (x < W - 1) relax(k, k + W + 1, 1.414); if (x > 0) relax(k, k + W - 1, 1.414); }
    }
    return Float32Array.from(d, v => (v ? Math.min(1, v / Math.max(1, ramp)) : 0));
}

/** One material's share of the plan: a rebuilt facade's photo, or a scan piece's (each photo planned once, the first material using it). */
export interface MaterialPlanJob { kind: 'rebuilt' | 'scan'; material: number; mesh?: string }

/** A job's planned maps and its part of the report, merged in job order (mergeMaterialPlan) so the plan is the same however the jobs ran. */
export interface MaterialPlanPiece {
    planned?: PlannedMaterial;
    facade?: MaterialRegionsReport['facades']['perFacade'][number]; withWindows: boolean;
    panesOnStone: number; baysOnStone: number; texels: { total: number; glass: number };
    scan?: { texels: number; onPlane: number; inWindows: number; inPanes: number; planes: number[] };
}

/** What every job reads: the GLB, its photos, the classes and their sets, the fitted planes. */
export interface MaterialPlanContext {
    g: ParsedGlb; json: any; images: Map<number, RgbaImage8>; classes: RegionClass[]; sets: RegionSet[]; planes: FittedPlane[]; P: MaterialRegionsParams;
    wallMean: [number, number, number]; setMeans: Array<[number, number, number]>;
    /** Each plane's windows and bays rasterised in its ortho's pixels (built once, on first use). */
    rasters: () => PlaneRaster[];
}

interface PlaneRaster { pl: FittedPlane; win: Uint8Array; bay: Int32Array; off: number; storey?: { pitch: number; phase: number }; /** The plane's fitted panes, and the bays holding any of them. */ pane: Uint8Array; panedBays: Set<number> }

export function materialPlanContext(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], sets: RegionSet[], planes: FittedPlane[] = [], P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): MaterialPlanContext {
    let built: PlaneRaster[] | undefined;
    const rasters = (): PlaneRaster[] => {
        if (built) return built;
        let bayBase = 0;
        built = planes.map(pl => {
            const win = new Uint8Array(pl.width * pl.height);
            const uv = (rs: number[][]) => rs.flatMap(([x0, y0, x1, y1]) => [x0 / pl.width, y0 / pl.height, x1 / pl.width, y1 / pl.height]);
            markRects(uv(pl.windows), pl.width, pl.height, win);
            // the wall grammar's bays when it read this plane's wall, else the strips the plane's own windows make
            const bayPx: number[][] = pl.bays ?? windowStrips(pl.windows.map(([x0, y0, x1, y1]) => [pl.orthoSMin + x0 * pl.pixel, pl.orthoTMax - y1 * pl.pixel, pl.orthoSMin + x1 * pl.pixel, pl.orthoTMax - y0 * pl.pixel] as [number, number, number, number]))
                .map(([s0, t0, s1, t1]) => [(s0 - pl.orthoSMin) / pl.pixel, (pl.orthoTMax - t1) / pl.pixel, (s1 - pl.orthoSMin) / pl.pixel, (pl.orthoTMax - t0) / pl.pixel]);
            const local = paneIdsOf(uv(bayPx), pl.width, pl.height, new Uint8Array(pl.width * pl.height).fill(1)), base = bayBase;
            bayBase += bayPx.length;
            const bay = Int32Array.from(local, v => (v ? v + base : 0));
            const off = dot3(pl.centroid, pl.normal), storey = storeyPitchOf(uv(pl.windows), pl.width, pl.height);
            const pane = new Uint8Array(pl.width * pl.height);
            markRects(uv(pl.panes), pl.width, pl.height, pane);
            const panedBays = new Set<number>();
            for (let j = 0; j < pane.length; j++) if (pane[j] && bay[j]) panedBays.add(bay[j]);
            return { pl, win, bay, off, storey, pane, panedBays };
        });
        return built;
    };
    return { g, json, images, classes, sets, planes, P, wallMean: meanOf(sets[sets.length - 1].orm), setMeans: sets.map(st => meanOf(st.orm)), rasters };
}

/** The plan's jobs, in the order the plan is merged: the rebuilt facades' photos, then the scan pieces' (each photo once). */
export function materialPlanJobs(json: any, images: Map<number, RgbaImage8>): MaterialPlanJob[] {
    const { rebuilt, other } = photoMaterials(json);
    const done = new Set<number>(), jobs: MaterialPlanJob[] = [];
    for (const [mi, mesh] of rebuilt) { const image = photoOf(json, mi)!.image; if (!images.get(image) || done.has(image)) continue; done.add(image); jobs.push({ kind: 'rebuilt', material: mi, mesh }); }
    for (const mi of other) { const image = photoOf(json, mi)!.image; if (!images.get(image) || done.has(image)) continue; done.add(image); jobs.push({ kind: 'scan', material: mi }); }
    return jobs;
}

/** Plans one job's maps (see the file comment): independent of every other job, so jobs can run on separate threads. */
export function planMaterialJob(job: MaterialPlanJob, ctx: MaterialPlanContext): MaterialPlanPiece {
    const { g, json, images, classes, sets, P } = ctx;
    const K = classes.length, WALL = K - 1;
    const piece: MaterialPlanPiece = { withWindows: false, panesOnStone: 0, baysOnStone: 0, texels: { total: 0, glass: 0 } };
    // dielectric everywhere: the set's roughness, metalness 0
    const write = (orm: RgbaImage8, params: RgbaImage8, k: number, r: number, glassWeight: number, seed = 255) => {
        orm.rgba[k * 4] = 255; orm.rgba[k * 4 + 1] = Math.round(r * 255); orm.rgba[k * 4 + 2] = 0; orm.rgba[k * 4 + 3] = 255;
        params.rgba[k * 4] = glassWeight; params.rgba[k * 4 + 2] = 0; params.rgba[k * 4 + 3] = seed;
        piece.texels.total++;
        if (glassWeight) piece.texels.glass++;
    };
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const mi = job.material, img = images.get(photoOf(json, mi)!.image)!;

    // ---- rebuilt facades: wall, and the window fit's windows (panes glass, the rest their frame) ----
    if (job.kind === 'rebuilt') {
        const mesh = job.mesh!;
        const { width: W, height: H } = img, N = W * H;
        const texelM = texelMetres(g, json, mi, img);
        if (!(texelM > 0)) return piece;
        const fitted = fittedWindows(json, mesh) ?? [];
        const window = new Uint8Array(N), pane = new Uint8Array(N);
        const windowN = markRects(fitted, W, H, window);
        // the structure (piers, bands, parapets) and the bays it frames, where the lattice drew them: the stone's relief on the
        // structure alone; glass by bay, never texel by texel: a bay most of whose texels are not the wall's class (a recessed
        // bay of glass and spandrels) is glass whole, each bay its own seed; a bay mostly of the wall's class (a column of
        // punched windows on a masonry wall) and a window outside the bays take glass on their fitted panes alone, less a pane
        // most of whose texels are the wall's class; the rest of a bay or window the frame's finish
        const runs = structureRuns(json, mesh), stone = new Uint8Array(N);
        const stoneN = runs ? markRects(runs, W, H, stone) : 0;
        const bays = structureBays(json, mesh) ?? [], bayId = paneIdsOf(bays, W, H, new Uint8Array(N).fill(1));
        const stoneBays = stonePanes(img, classes, bayId, P.paneWallShare);
        // a bay holding fitted panes (the facade reader's punched windows) takes glass on its panes alone, its spandrels and
        // mullions the frame's finish; a bay without is glass whole
        const allPanes = paneIdsOf(fittedPanes(json, mesh) ?? [], W, H, new Uint8Array(N).fill(1)), panedBays = new Set<number>();
        for (let k = 0; k < N; k++) if (allPanes[k] && bayId[k]) panedBays.add(bayId[k]);
        const glassBay = (k: number) => !!bayId[k] && !stoneBays.has(bayId[k]) && (!panedBays.has(bayId[k]) || !!allPanes[k]);
        let paneN = 0;
        // each bay's glass tilted storey by storey (the facade's own storey pitch, from its fitted windows), so a glint covers a
        // storey's glass, not a whole bay
        const storey = storeyPitchOf(fitted, W, H);
        for (let k = 0; k < N; k++) if (glassBay(k)) {
            const st = storey ? Math.floor((Math.floor(k / W) - storey.phase) / storey.pitch) : 0;
            pane[k] = paneSeed((bayId[k] - 1) * 997 + st + 500); paneN++;
        }
        const loose = new Uint8Array(N);
        for (let k = 0; k < N; k++) loose[k] = window[k] && !glassBay(k) ? 1 : 0;
        const paneIds = paneIdsOf(fittedPanes(json, mesh) ?? [], W, H, loose), stoneIds = stonePanes(img, classes, paneIds, P.paneWallShare);
        for (let k = 0; k < N; k++) if (paneIds[k] && !stoneIds.has(paneIds[k])) { pane[k] = paneSeed(100000 + paneIds[k]); paneN++; }
        piece.panesOnStone += stoneIds.size;
        piece.baysOnStone += stoneBays.size;
        const framed = (k: number) => !pane[k] && (!!bayId[k] || !!window[k]);
        // the frame: its most common class other than the wall, among the bays' texels that are not glass and the windows'
        let frameClass = WALL;
        const frameMask = Uint8Array.from({ length: N }, (_, k) => (framed(k) ? 1 : 0));
        if (frameMask.some(v => v)) {
            const cls = classify(img, classes, frameMask), inFrames = new Uint32Array(K);
            for (let k = 0; k < N; k++) if (frameMask[k] && cls[k] !== WALL) inFrames[cls[k]]++;
            for (let c = 0; c < WALL; c++) if (inFrames[c] && (frameClass === WALL || inFrames[c] > inFrames[frameClass])) frameClass = c;
        }

        // ---- maps: the sets tiled at their real size, box-filtered to this facade's texel ----
        const orm = blank(W, H), nrm = blank(W, H), params = blank(W, H);
        const tileOf = (s: RegionSet) => {
            const tw = Math.max(2, Math.round(s.realSizeM[0] / texelM)), th = Math.max(2, Math.round(s.realSizeM[1] / texelM));
            return { tw, th, n: shrinkTile(s.normal, tw, th, true), o: shrinkTile(s.orm, tw, th, false) };
        };
        const wallTile = tileOf(sets[WALL]), frameTile = frameClass === WALL ? wallTile : tileOf(sets[frameClass]);
        // glass fades in from its edge: weight, roughness and normal blended from the finish it sits in
        const fw = featherWeights(pane, W, H, P.glassFeatherM / texelM);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const k = y * W + x;
            const t = pane[k] || framed(k) ? frameTile : wallTile, j = ((y % t.th) * t.tw + (x % t.tw)) * 3, a = fw[k];
            if (pane[k]) {
                write(orm, params, k, t.o[j + 1] + (GLASS_ROUGHNESS - t.o[j + 1]) * a, Math.max(1, Math.round(P.paneGlassWeight * a)), pane[k]);
                const n = [0, 1, 2].map(c => (t.n[j + c] * 2 - 1) * (1 - a) + (c === 2 ? a : 0)), l = Math.hypot(n[0], n[1], n[2]) || 1;
                nrm.rgba.set([Math.round((n[0] / l * 0.5 + 0.5) * 255), Math.round((n[1] / l * 0.5 + 0.5) * 255), Math.round((n[2] / l * 0.5 + 0.5) * 255), 255], k * 4);
                continue;
            }
            write(orm, params, k, t.o[j + 1], 0);
            nrm.rgba.set([Math.round(t.n[j] * 255), Math.round(t.n[j + 1] * 255), Math.round(t.n[j + 2] * 255), 255], k * 4);
        }
        piece.withWindows = windowN > 0;
        piece.facade = {
            mesh, texelM: Math.round(texelM * 1e4) / 1e4, fittedWindows: fitted.length / 4, bays: bays.length / 4,
            windowShare: r3(windowN / N), glassShare: r3(paneN / N), structureShare: r3(stoneN / N), frameSet: sets[frameClass].name
        };
        piece.planned = { material: mi, orm, normal: nrm, params, rebuilt: true, glass: paneN > 0 };
        return piece;
    }

    // ---- scan pieces: the wall set's mean finish, and the window fit's windows of the plane a piece lies on ----
    const used = new Set<number>(), scan = { texels: 0, onPlane: 0, inWindows: 0, inPanes: 0, planes: [] as number[] };
    {
        const { width: W, height: H } = img, N = W * H;
        // per texel: on a plane (1), in a window (2), or the pane's seed (in pane)
        const on = new Uint8Array(N), win = new Uint8Array(N), bayId = new Int32Array(N), storeyOf = new Int32Array(N), pane = new Uint8Array(N), onPane = new Uint8Array(N), paned = new Uint8Array(N);
        const rasters = ctx.rasters();
        if (rasters.length) forEachTriangleOf(g, json, mi, (p, uv) => {
            const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
            const nn = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], nl = Math.hypot(nn[0], nn[1], nn[2]);
            if (!(nl > 0)) return;
            const c = [(p[0] + p[3] + p[6]) / 3, (p[1] + p[4] + p[7]) / 3, (p[2] + p[5] + p[8]) / 3];
            // the nearest plane it lies on, its centre inside the plane's ortho
            let best: (typeof rasters)[number] | undefined, bd = Infinity;
            for (const r of rasters) {
                if (dot3(nn, r.pl.normal) / nl < P.planeCos) continue;
                const d = Math.abs(dot3(c, r.pl.normal) - r.off);
                if (d > P.planeBandM || d >= bd) continue;
                const sc = dot3(c, r.pl.axisS) - dot3(r.pl.centroid, r.pl.axisS), tc = dot3(c, r.pl.axisT) - dot3(r.pl.centroid, r.pl.axisT);
                if (sc < r.pl.orthoSMin || sc > r.pl.orthoSMin + r.pl.width * r.pl.pixel || tc > r.pl.orthoTMax || tc < r.pl.orthoTMax - r.pl.height * r.pl.pixel) continue;
                best = r; bd = d;
            }
            if (!best) return;
            used.add(best.pl.facadeId);
            const { pl } = best, s0 = dot3(pl.centroid, pl.axisS), t0 = dot3(pl.centroid, pl.axisT);
            const sv = [dot3([p[0], p[1], p[2]], pl.axisS) - s0, dot3([p[3], p[4], p[5]], pl.axisS) - s0, dot3([p[6], p[7], p[8]], pl.axisS) - s0];
            const tv = [dot3([p[0], p[1], p[2]], pl.axisT) - t0, dot3([p[3], p[4], p[5]], pl.axisT) - t0, dot3([p[6], p[7], p[8]], pl.axisT) - t0];
            forTexelsOf(uv, W, H, (k, wa, wb, wc) => {
                on[k] = 1;
                const x = Math.floor((wa * sv[0] + wb * sv[1] + wc * sv[2] - pl.orthoSMin) / pl.pixel), y = Math.floor((pl.orthoTMax - (wa * tv[0] + wb * tv[1] + wc * tv[2])) / pl.pixel);
                if (x < 0 || y < 0 || x >= pl.width || y >= pl.height) return;
                const j = y * pl.width + x;
                if (best!.win[j]) win[k] = 1;
                if (best!.bay[j]) { bayId[k] = best!.bay[j]; storeyOf[k] = best!.storey ? Math.floor((y - best!.storey.phase) / best!.storey.pitch) : 0; if (best!.panedBays.has(best!.bay[j])) paned[k] = 1; }
                if (best!.pane[j]) onPane[k] = 1;
            });
        });
        // glass by the plane's bays: a bay whose texels here are mostly not the wall's class is glass whole
        const stoneBays = stonePanes(img, classes, bayId, P.paneWallShare);
        for (let k = 0; k < N; k++) if (bayId[k] && !stoneBays.has(bayId[k]) && (!paned[k] || onPane[k])) pane[k] = paneSeed((bayId[k] - 1) * 997 + storeyOf[k] + 500);
        piece.baysOnStone += stoneBays.size;
        // the windows' frame: the most common class other than the wall among their texels that are not pane
        let frameClass = WALL;
        const frameMask = Uint8Array.from(win, (v, k) => ((v || bayId[k]) && !pane[k] ? 1 : 0));
        if (frameMask.some(v => v)) {
            const cls = classify(img, classes, frameMask), n = new Uint32Array(K);
            for (let k = 0; k < N; k++) if (frameMask[k] && cls[k] !== WALL) n[cls[k]]++;
            for (let c = 0; c < WALL; c++) if (n[c] && (frameClass === WALL || n[c] > n[frameClass])) frameClass = c;
        }
        const orm = blank(W, H), params = blank(W, H);
        const scanTexelM = texelMetres(g, json, mi, img), fw = featherWeights(pane, W, H, scanTexelM > 0 ? P.glassFeatherM / scanTexelM : 1);
        for (let k = 0; k < N; k++) {
            const r = (pane[k] || win[k] || bayId[k] ? ctx.setMeans[frameClass] : ctx.wallMean)[1];
            if (pane[k]) write(orm, params, k, r + (GLASS_ROUGHNESS - r) * fw[k], Math.max(1, Math.round(P.paneGlassWeight * fw[k])), pane[k]);
            else write(orm, params, k, r, 0);
            scan.onPlane += on[k]; scan.inWindows += win[k]; if (pane[k]) scan.inPanes++;
        }
        scan.texels = N;
        piece.planned = { material: mi, orm, params, rebuilt: false, glass: pane.some(v => v) };
    }
    scan.planes = [...used];
    piece.scan = scan;
    return piece;
}

/** The plan from its jobs' pieces, in job order. */
export function mergeMaterialPlan(json: any, classes: RegionClass[], sets: RegionSet[], pieces: MaterialPlanPiece[], ms: number): MaterialRegionsPlan {
    const { rebuilt, other } = photoMaterials(json);
    const report: MaterialRegionsReport = {
        version: MATERIAL_REGIONS_VERSION,
        classes: classes.map((c, k) => ({ index: c.index, meanLab: c.meanLab, share: c.share, wall: c.wall, set: sets[k].name, distance: Math.round(sets[k].distance * 100) / 100, ...(sets[k].harvest ? { harvest: sets[k].harvest } : {}), ...(c.texture ? { texture: c.texture, facades: c.facades } : {}) })),
        facades: { total: rebuilt.size, withWindows: 0, perFacade: [] }, scanPieces: { total: other.size, onPlanes: 0, windowShare: 0, paneShare: 0, planes: [] }, texels: { total: 0, glass: 0 }, panesOnStone: 0, baysOnStone: 0, ms
    };
    const planned: PlannedMaterial[] = [], used = new Set<number>();
    let scanN = 0, onPlane = 0, inWindows = 0, inPanes = 0;
    for (const p of pieces) {
        if (p.planned) planned.push(p.planned);
        if (p.withWindows) report.facades.withWindows++;
        if (p.facade) report.facades.perFacade.push(p.facade);
        report.panesOnStone += p.panesOnStone; report.baysOnStone += p.baysOnStone;
        report.texels.total += p.texels.total; report.texels.glass += p.texels.glass;
        if (p.scan) { scanN += p.scan.texels; onPlane += p.scan.onPlane; inWindows += p.scan.inWindows; inPanes += p.scan.inPanes; for (const id of p.scan.planes) used.add(id); }
    }
    const share = (v: number) => (scanN ? Math.round((v / scanN) * 1e4) / 1e4 : 0);
    report.scanPieces = { total: other.size, onPlanes: share(onPlane), windowShare: share(inWindows), paneShare: share(inPanes), planes: [...used].sort((a, b) => a - b) };
    return { materials: planned, sets, report };
}

/**
 * Plans the maps of every photo-textured material (see the file comment). `sets[k]` is class k's set. One thread; the
 * pipeline runs the same jobs across worker threads (material-regions-pool.ts) with the same result.
 */
export function planMaterialRegions(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], sets: RegionSet[], planes: FittedPlane[] = [], P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): MaterialRegionsPlan {
    const t0 = Date.now();
    const ctx = materialPlanContext(g, json, images, classes, sets, planes, P);
    const pieces = materialPlanJobs(json, images).map(j => planMaterialJob(j, ctx));
    return mergeMaterialPlan(json, classes, sets, pieces, Date.now() - t0);
}

/**
 * Writes a plan's maps into the GLB's materials: lit (KHR_materials_unlit removed), the metallic-roughness texture, the
 * normal on rebuilt facades, and the facade material reading's extras (parameters texture). `addTexture` stores an image
 * and returns its texture index.
 */
export function writeMaterialRegions(json: any, plan: MaterialRegionsPlan, addTexture: (img: RgbaImage8, mimeType: 'image/png' | 'image/jpeg', name: string) => number, provenanceIndices: number[]): void {
    for (const pm of plan.materials) {
        const m = json.materials[pm.material];
        if (m.extensions) { delete m.extensions.KHR_materials_unlit; if (!Object.keys(m.extensions).length) delete m.extensions; }
        const name = m.name ?? `material_${pm.material}`;
        const pbr = m.pbrMetallicRoughness = m.pbrMetallicRoughness ?? {};
        pbr.metallicFactor = 1; pbr.roughnessFactor = 1;
        pbr.metallicRoughnessTexture = { index: addTexture(pm.orm, 'image/jpeg', `${name}_orm`) };
        if (pm.normal) m.normalTexture = { index: addTexture(pm.normal, 'image/jpeg', `${name}_normal`) };
        m.extras = {
            ...(m.extras ?? {}),
            sbMaterial: {
                schema: 'scratchbox.staged-material/1', paramsTexture: addTexture(pm.params, 'image/png', `${name}_material`), paramsChannels: MATERIAL_PARAMS_CHANNELS,
                provenanceIndices
            },
            sbMaterialRegions: {
                version: MATERIAL_REGIONS_VERSION,
                baseColor: { label: 'photo-inferred', source: "pipeline K's harmonised photo" },
                roughness: { label: 'generated', source: `texture library sets per appearance class (${plan.sets.map(s => s.harvest ? `${s.name}, chosen by colour and texture at the tile's texel (tile-only harvest), its finer grain ${s.harvest.grain}` : s.name).join('; ')}); ${pm.rebuilt ? "the wall's set on the structure (piers, bands, parapets; outside the windows where the lattice drew none), the frame class's set in the windows and the bays' infill" : "the wall set's mean finish, the frame class's in the windows of the fitted plane it lies on"}` },
                metalness: { label: 'generated', source: 'none drawn: no reading here tells a metal from a dark stone' },
                ...(pm.normal ? { normal: { label: 'generated', source: 'the same sets tiled at their real size' } } : {}),
                ...(pm.glass ? { glass: { label: 'photo-inferred', source: "the window fit's panes (window-fit.ts), the photo kept as their colour" }, paneTilt: { label: 'generated', source: "each pane's seed (parameters alpha): the viewer tilts it by a small angle of its own, as real panes sit off their wall's plane" } } : {})
            }
        };
    }
    if (!json.materials.some((m: any) => m.extensions?.KHR_materials_unlit) && Array.isArray(json.extensionsUsed)) {
        json.extensionsUsed = json.extensionsUsed.filter((e: string) => e !== 'KHR_materials_unlit');
        if (!json.extensionsUsed.length) delete json.extensionsUsed;
    }
}

/** One line for the build's notes. */
export function describeMaterialRegions(r: MaterialRegionsReport): string {
    const pct = (a: number) => r.texels.total ? `${Math.round((100 * a) / r.texels.total)}%` : '0%';
    const windows = r.facades.perFacade.reduce((a, f) => a + f.fittedWindows, 0), bays = r.facades.perFacade.reduce((a, f) => a + f.bays, 0);
    return `material regions: ${r.classes.length} appearance classes (${r.classes.map(c => `${c.wall ? 'wall' : 'L ' + Math.round(c.meanLab[0])} -> ${c.set}`).join(', ')}); ` +
        `${r.facades.withWindows} of ${r.facades.total} rebuilt facades opened at their ${windows} fitted windows (glass in their ${bays} bays whole, ${r.baysOnStone} bays mostly stone taking glass on their windows' panes alone, ${r.panesOnStone} panes left as stone: ${pct(r.texels.glass)} of texels); ` +
        `every other texel the wall's set; ${r.scanPieces.total} scan pieces its mean finish, ${Math.round(r.scanPieces.onPlanes * 1000) / 10}% of their texels on ${r.scanPieces.planes.length} fitted planes (${Math.round(r.scanPieces.windowShare * 1000) / 10}% in windows, ${Math.round(r.scanPieces.paneShare * 1000) / 10}% glass); nothing metal; ` +
        `roughness and normal generated from the library, colour the photo (${r.ms} ms)`;
}
