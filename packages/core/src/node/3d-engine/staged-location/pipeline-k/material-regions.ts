/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * Pipeline K's material regions: the harmonised photos of one textured building kept as its colour, with the occlusion,
 * roughness, metalness and normal of a detected material under every texel, so the building answers the scene's light
 * instead of showing the light it was photographed in (the photos were drawn unlit before this stage). One material path
 * for every surface (user decision, 2026-11-05): no glass layer, no metal gate, no plain finish.
 *
 *  1. Appearance classes: k-means in CIELAB on texels sampled from the rebuilt facades' photos, one set of classes for the
 *     whole building, read apart inside the window openings (the lattice's fitted windows: glass, frames, blinds) and
 *     outside them (walls, spandrels, piers), so a glass and a panel of one colour are two materials. The lightest class
 *     outside is labelled the wall.
 *  2. A library set per class (resolved by the caller, material-sets.ts: ranked by the class's colour and the finish the
 *     vision model read, then picked by its look among the nearest).
 *  3. Each texel's class: its nearest class in CIELAB among its region's (inside an opening or not; a scan piece is all
 *     outside), then the majority over a square of regionSmoothM about it (so a material reads as a region, never as texel
 *     speckle).
 *  4. Repeats: a building's materials follow its architecture and repeat with it. Each fitted window's unit cell (the
 *     window and half the gap to its neighbours in its row and column: its glass, frame, mullions, the spandrel and the
 *     piers' halves) is a repeat of every other of its size (a family); each position of the cell takes the class most
 *     of the family's repeats hold there, so one bay never reads metal while the bays beside it read glass, and a frame
 *     stays a frame on every window (photo-inferred). The texels outside every unit cell keep their own class.
 *  5. Glass (user priority, 2026-11-06): on each rebuilt facade the panes the lattice carries (sbFacadeLattice.windows.panes:
 *     the facade reader's accepted openings with the pane splits it read where it read the plane, the window fit's elsewhere)
 *     are drawn as glass (GLASS: roughness 0.08, no metalness, a flat normal; the photo stays the colour), except a pane
 *     most of whose texels (paneWallShare) are the wall's class, which is stone whatever was fitted there, and the wall's
 *     class's texels within a glass pane (a mullion, a sill); each texel's class among every class, so a stone texel in a
 *     pane is told from glass. Photo-inferred.
 *  6. Maps: on each rebuilt facade, each texel's class's set tiled at the set's real size, box-filtered to the facade's
 *     texel (so a tile never aliases): occlusion, roughness and metalness (ORM) and the normal, as the set has them; on
 *     scan pieces, whose atlases carry no metric frame for a tile, each texel's class's set's mean ORM.
 *  7. Height: each class's set's height as a recess below the rebuilt facade's plane (material-height.ts), one small tile
 *     a class at the tile's own resolution (millimetres a texel, where the facade's photo has centimetres), with each
 *     facade's class map and metric frame to place it. The viewer's parallax and the near displacement
 *     (height-relief.ts) read them. A glass pane takes none (its class map texel names no class), and scan pieces
 *     take none: a measured surface is never moved.
 *
 * Labels: base colour photo-inferred (the photo, never relit or lifted: it is the evidence of how the building looks); each
 * texel's material photo-inferred (its class); occlusion, roughness, metalness, normal and height generated (library sets).
 * Nothing is drawn where no photo is.
 */

import { readAccessor, type ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import { linearRgbToLab } from '../../../../common/spatial/texture-library-index';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { bandResponses, TEXTURE_BANDS_M, type TextureEnergy } from './material-harvest';
import { HEIGHT_RELIEF, MATERIAL_HEIGHT_VERSION, type DrawnHeight } from './material-height';

export const MATERIAL_REGIONS_VERSION = 'material-regions/34';

export const MATERIAL_REGIONS_PARAMS = {
    /**
     * Appearance classes outside the window openings and inside them (the rebuilt facades' fitted windows), texels sampled
     * per facade photo, k-means iterations, sampling seed.
     */
    classes: 4, openingClasses: 2, samplesPerPhoto: 40000, iterations: 40, seed: 7,
    /**
     * A texel takes the class most of the square within this of it holds (m; at least one texel): a material is a region of
     * the surface, under a mullion's width, so shading speckle and a photo seam never flip one texel's finish.
     */
    regionSmoothM: 0.15,
    /** The square's largest half-side, texels (on a scan atlas of coarse texels the square stays a few texels). */
    regionSmoothMaxTexels: 32,
    /**
     * Repeats (see the file comment, 4): a window's unit cell repeats another when both sides are within repeatTolerance of
     * the family's first; a family is folded with at least minRepeats members, each cell cut into repeatGrid x repeatGrid.
     */
    repeatTolerance: 0.1, minRepeats: 3, repeatGrid: 24,
    /** A pane is stone, not glass, when at least this share of its texels fall in the wall's class. */
    paneWallShare: 0.5
};

/** The glass drawn in the panes (see the file comment, 5): main's smooth-glass setting, roughness 0.08, no metalness, flat. */
export const GLASS = { roughness: 0.08, metalness: 0 } as const;
export type MaterialRegionsParams = typeof MATERIAL_REGIONS_PARAMS;

/** A rebuilt facade's mesh, by the name facade-lattice.ts gives it: its photo is a metric orthophoto of one plane. */
const REBUILT_FACADE = /^facade_lattice_\d+$/;

export interface RegionClass {
    index: number;
    /** Mean colour, CIELAB and linear sRGB, and spread (CIELAB standard deviation). */
    meanLab: [number, number, number]; meanLinear: [number, number, number]; spreadLab: [number, number, number];
    /** Share of the sampled facade texels. */
    share: number;
    /** The lightest class outside the openings (a label only: every class is drawn with its own set wherever its texels are). */
    wall: boolean;
    /** Read from the texels inside the window openings, and drawn only there (else outside them). */
    openings: boolean;
    /** The tile-only harvest (material-harvest.ts): the class's texture energy on the facade photos, and on how many facades it holds at least 5%. Photo-inferred. */
    texture?: TextureEnergy; facades?: number;
    /** The class's texture energy as the photos show it, measured for every class (classPhotoTextures): what a library set's grain is held to. Photo-inferred. */
    photoTexture?: TextureEnergy;
    /** The median shorter side (m) of the repeated elements (windows' unit cells) this class holds most of (classRepeatSizes); none when it holds none. */
    repeatM?: number;
}

/** One class's library set, resolved by the caller: maps prepared small (the engine's prepare_material_maps). */
export interface RegionSet {
    name: string;
    /** Real size of one tile, metres (x, y). */
    realSizeM: [number, number];
    /** OpenGL tangent-space normal and packed occlusion/roughness/metalness, RGBA8, drawn as they are. */
    normal: RgbaImage8; orm: RgbaImage8;
    /** How near the set lies to the class (the library search's distance). */
    distance: number;
    /** The tile-only harvest's pick (material-harvest.ts): the class's and the set's texture energy at the class's texel, the distances it was chosen by, and what of it is generated. */
    harvest?: { colourDistance: number; textureDistance: number; classEnergy: number[]; setEnergy: number[]; texelM: number; candidates: number; grain: string };
    /** The pick by appearance (material-choice.ts): the candidates shown, whether the look or the ranking chose, what the chooser saw and why the ranking's nearest was kept; `reused`: the pick kept for an earlier class shown the same candidates, its colour and how far this class's lies from it (CHOICE_REUSE), not asked again. */
    choice?: { candidates: string[]; by: 'appearance' | 'ranking'; seen?: string; conf?: number; reused?: { meanLab: [number, number, number]; colourUnits: number }; why?: string };
    /** The class's finish read by the vision model (material-finish.ts), or why there is none, and what the ranking ranked toward. Photo-inferred. */
    /**
     * The set's height as a recess below the surface (material-height.ts): 255 the surface, 0 a recess of HEIGHT_RELIEF.capM;
     * none for a set without a height map or a depth, or drawn too flat to show. And what it was drawn at.
     */
    height?: RgbaImage8; heightDrawn?: DrawnHeight;
    finish?: { read?: { roughness: number; metalness: number; conf: number; seen?: string }; why?: string; roughness: number; metallic: number; /** The finish and grain the set's maps were drawn at (material-finish.ts finishMaps), when either changed them. */ drawn?: { roughness: number; /** The regressor's grain held to what the photo bears out (material-sets.ts capGrain): the cap, where it came from, and the regressor's own grain. */ cap?: { grain: number; by: 'photo' | 'other classes' | 'none measured'; regressor: number }; metallic: number; relief: number; grain: number }; label: 'photo-inferred' };
}

export interface MaterialRegionsReport {
    version: string;
    classes: Array<Pick<RegionClass, 'index' | 'meanLab' | 'share' | 'wall' | 'openings' | 'texture' | 'facades'> & { set: string; distance: number; harvest?: RegionSet['harvest']; choice?: RegionSet['choice']; finish?: RegionSet['finish']; /** The set's height as drawn (material-height.ts); none when it has none. Generated. */ height?: DrawnHeight }>;
    /** The rebuilt facades: each one's texel, the share of its texels each class (by index) holds, and the share drawn as glass. */
    facades: { total: number; perFacade: Array<{ mesh: string; texelM: number; classShares: number[]; /** The share of its texels the fold over its repeats changed (see the file comment, 4). */ foldedShare: number; /** The pane rects the lattice carried, and the share of the facade drawn as glass. */ panes: number; glassShare: number }> };
    scanPieces: { total: number };
    /** Every planned texel, how many each class holds (by index), and how many are drawn as glass. */
    texels: { total: number; perClass: number[]; glass: number };
    /** The wall guard on the panes (see the file comment, 5): panes not drawn as glass, most of their texels wall-like (stone, whatever was fitted there), and texels of glass panes left out as wall-like. A reader pane the guard drops may be the reader's error or the guard's: both are reported. */
    panesOnStone: number; paneWallTexels: number;
    ms: number;
}

/** A material's maps, planned before the photos are encoded. */
interface PlannedMaterial {
    material: number;
    orm: RgbaImage8; normal?: RgbaImage8;
    /**
     * Each texel's class (r and b the class index; g the share of the relief it takes, classBorderWeights) and the photo's texel (m), on a rebuilt facade when any class's
     * set has a height: with the sets' recess tiles (RegionSet.height) the relief under every texel at the tile's own
     * resolution, far finer than the facade's texel.
     */
    classes?: RgbaImage8; texelM?: number;
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

/** A rebuilt facade's fitted windows (window-fit.ts, as facade-lattice.ts wrote them: sbFacadeLattice.windows.uv, u0 v0 u1 v1 each). */
function fittedWindows(json: any, meshName: string): number[] | undefined {
    const mi = (json.meshes ?? []).findIndex((m: any) => m.name === meshName);
    const uv = (json.nodes ?? []).find((n: any) => n.mesh === mi && n.extras?.sbFacadeLattice?.windows)?.extras.sbFacadeLattice.windows.uv;
    return Array.isArray(uv) && uv.length % 4 === 0 && uv.length ? uv : undefined;
}

/** A rebuilt facade's panes (the glass in its fitted windows: the reader's pane splits where it read, window-fit.ts's elsewhere; sbFacadeLattice.windows.panes, u0 v0 u1 v1 each). */
function fittedPanes(json: any, meshName: string): number[] | undefined {
    const mi = (json.meshes ?? []).findIndex((m: any) => m.name === meshName);
    const uv = (json.nodes ?? []).find((n: any) => n.mesh === mi && n.extras?.sbFacadeLattice?.windows)?.extras.sbFacadeLattice.windows.panes;
    return Array.isArray(uv) && uv.length % 4 === 0 && uv.length ? uv : undefined;
}

/**
 * The glass texels of a photo (see the file comment, 5): each pane rect's texels (Math.round at its edges, at least one texel
 * each way, the first rect holding a texel), each classed between the wall's class and the classes read inside the openings: a texel nearer the
 * wall's colour than any of theirs is the wall (a pier through a window's box), not what fills the openings. The other
 * outside classes are not candidates: among them there is always a dark one near the openings' colours (spandrels, shade)
 * that would take a window's texels for stone. A pane at least `share` of whose texels look like the wall is stone and
 * counted (`stone`), else its texels are glass but those. With no class read inside the openings, every class is a
 * candidate and the wall's class alone counts as the wall. Returns none without pane rects.
 */
export function paneGlass(img: RgbaImage8, classes: RegionClass[], panes: number[] | undefined, share: number): { glass: Uint8Array; stone: number; panes: number; /** Texels of glass panes left out as wall-like. */ wallTexels: number } | undefined {
    if (!panes?.length) return undefined;
    const { width: W, height: H, rgba } = img, wall = Math.max(0, classes.findIndex(c => c.wall));
    // the guard's candidates: the wall's class against the opening classes (the other outside classes always hold a
    // dark one next to the openings' colours, which would take a window's texels for stone); every class without openings
    const cands = classes.some(c => c.openings) ? classes.map((c, i) => i).filter(i => i === wall || classes[i].openings) : classes.map((_, i) => i);
    const glass = new Uint8Array(W * H), seen = new Uint8Array(W * H);
    let stone = 0, wallTexels = 0;
    const wallLike = (k: number) => {
        const [L, a, b] = labOf(rgba[k * 4], rgba[k * 4 + 1], rgba[k * 4 + 2]);
        let best = 0, bd = Infinity;
        for (const i of cands) { const m = classes[i].meanLab, d = (L - m[0]) ** 2 + (a - m[1]) ** 2 + (b - m[2]) ** 2; if (d < bd) { bd = d; best = i; } }
        return best === wall;
    };
    for (let i = 0; i + 3 < panes.length; i += 4) {
        // a pane under a texel wide or tall (the reader's rects come at fractional pixels) still holds the texel it rounds into
        const x0 = Math.max(0, Math.round(panes[i] * W)), x1 = Math.min(W, Math.max(Math.round(panes[i + 2] * W), x0 + 1)), y0 = Math.max(0, Math.round(panes[i + 1] * H)), y1 = Math.min(H, Math.max(Math.round(panes[i + 3] * H), y0 + 1));
        const mine: number[] = [], isWall: number[] = [];
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
            const k = y * W + x;
            if (seen[k] || !rgba[k * 4 + 3]) continue;
            seen[k] = 1; mine.push(k); isWall.push(wallLike(k) ? 1 : 0);
        }
        if (!mine.length) continue;
        if (isWall.reduce((s, v) => s + v, 0) >= share * mine.length) { stone++; continue; }
        mine.forEach((k, q) => { if (!isWall[q]) glass[k] = 1; else wallTexels++; });
    }
    return { glass, stone, panes: panes.length / 4, wallTexels };
}

/** The openings' texels of a photo (1 inside a rect, u0 v0 u1 v1 each: floor at the start, ceil at the end); none without rects. */
export function openingMask(rects: number[] | undefined, W: number, H: number): Uint8Array | undefined {
    if (!rects?.length) return undefined;
    const m = new Uint8Array(W * H);
    for (let k = 0; k + 3 < rects.length; k += 4) {
        const x0 = Math.max(0, Math.floor(rects[k] * W)), y0 = Math.max(0, Math.floor(rects[k + 1] * H)), x1 = Math.min(W, Math.ceil(rects[k + 2] * W)), y1 = Math.min(H, Math.ceil(rects[k + 3] * H));
        for (let y = y0; y < y1; y++) m.fill(1, y * W + x0, y * W + x1);
    }
    return m;
}

/** A material's photo's openings mask (rebuilt facades only; a scan piece's atlas has none). */
function maskOf(json: any, mesh: string | undefined, img: RgbaImage8): Uint8Array | undefined {
    return mesh ? openingMask(fittedWindows(json, mesh), img.width, img.height) : undefined;
}

/** Each region's class indices, outside (0) and inside (1) the openings; a region with none takes every class. */
export function regionCandidates(classes: Array<Pick<RegionClass, 'openings'>>): [number[], number[]] {
    const all = classes.map((_, k) => k), out = all.filter(k => !classes[k].openings), inn = all.filter(k => classes[k].openings);
    return [out.length ? out : all, inn.length ? inn : all];
}

/** The lightness-seeded CIELAB k-means of samples X (L a b each): the centres and each sample's centre. */
function kMeansLab(X: number[], K: number, iterations: number, wL: number): { C: number[][]; lab: Int32Array } {
    const n = X.length / 3;
    // seeds spread over lightness, so the classes come out ordered and the result does not depend on a draw
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => X[a * 3] - X[b * 3]);
    let C = Array.from({ length: K }, (_, k) => { const i = order[Math.floor(((k + 0.5) / K) * n)]; return [X[i * 3], X[i * 3 + 1], X[i * 3 + 2]]; });
    const lab = new Int32Array(n);
    for (let it = 0; it < iterations; it++) {
        const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
        for (let i = 0; i < n; i++) {
            let best = 0, bd = Infinity;
            for (let k = 0; k < K; k++) { const d = (wL * (X[i * 3] - C[k][0])) ** 2 + (X[i * 3 + 1] - C[k][1]) ** 2 + (X[i * 3 + 2] - C[k][2]) ** 2; if (d < bd) { bd = d; best = k; } }
            lab[i] = best; sum[best][0] += X[i * 3]; sum[best][1] += X[i * 3 + 1]; sum[best][2] += X[i * 3 + 2]; sum[best][3]++;
        }
        C = C.map((c, k) => sum[k][3] ? [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]] : c);
    }
    return { C, lab };
}

/** The classes of one region from its k-means' centres, member counts and squared deviations, ordered by lightness, indexed from `first`. */
export function formatRegionClasses(C: ArrayLike<number>[], count: ArrayLike<number>, sd: ArrayLike<number>[], total: number, first: number, openings: boolean): RegionClass[] {
    const idx = C.map((_, k) => k).sort((a, b) => C[a][0] - C[b][0]);
    return idx.map((k, rank) => {
        const cnt = count[k];
        const [L, a, b] = [C[k][0], C[k][1], C[k][2]];
        // back to linear sRGB for the library query (CIELAB D65 inverted)
        const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
        const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
        const Xw = inv(fx) * 0.95047, Yw = inv(fy), Zw = inv(fz) * 1.08883;
        const lin: [number, number, number] = [3.2406 * Xw - 1.5372 * Yw - 0.4986 * Zw, -0.9689 * Xw + 1.8758 * Yw + 0.0415 * Zw, 0.0557 * Xw - 0.204 * Yw + 1.057 * Zw].map(v => Math.max(0, Math.min(1, v))) as [number, number, number];
        const r2 = (v: number) => Math.round(v * 100) / 100;
        return {
            index: first + rank, meanLab: [r2(L), r2(a), r2(b)], meanLinear: lin.map(r2) as [number, number, number],
            spreadLab: [0, 1, 2].map(c => r2(Math.sqrt(sd[k][c] / Math.max(1, cnt)))) as [number, number, number],
            share: Math.round((cnt / total) * 1000) / 1000, wall: !openings && rank === idx.length - 1, openings
        };
    });
}

/**
 * The building's appearance classes, from its rebuilt facades' photos (image index -> photo): the classes outside the
 * window openings first (index order), then those inside them; undefined when it has no rebuilt facade (nothing gives the
 * classes a metric photo to come from). The openings get classes of their own only with at least ten samples a class.
 */
export function readRegionClasses(json: any, images: Map<number, RgbaImage8>, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS, harvest?: { g: ParsedGlb }): RegionClass[] | undefined {
    const { rebuilt } = photoMaterials(json);
    const rnd = sampler(P.seed), X: [number[], number[]] = [[], []];
    for (const [mi, mesh] of rebuilt) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        const N = img.width * img.height, take = Math.min(N, P.samplesPerPhoto), open = maskOf(json, mesh, img);
        for (let s = 0; s < take; s++) {
            const q = Math.floor(rnd() * N), p = q * 4;
            if (!img.rgba[p + 3]) continue;
            X[open?.[q] ? 1 : 0].push(...labOf(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]));
        }
    }
    // the harvest weighs lightness at half: one material lit two ways, or split by a photo seam, stays one class
    const wL = harvest ? 0.5 : 1;
    const n0 = X[0].length / 3, n1 = X[1].length / 3, total = n0 + n1;
    if (n0 < P.classes * 10) return undefined;
    const classes: RegionClass[] = [];
    for (const [r, K] of [[0, P.classes], [1, P.openingClasses]] as const) {
        const n = X[r].length / 3;
        if (!K || n < K * 10) continue;
        const { C, lab } = kMeansLab(X[r], K, P.iterations, wL);
        const count = new Array<number>(K).fill(0), sd = Array.from({ length: K }, () => [0, 0, 0]);
        for (let k = 0; k < K; k++) for (let i = 0; i < n; i++) if (lab[i] === k) { count[k]++; for (let c = 0; c < 3; c++) sd[k][c] += (X[r][i * 3 + c] - C[k][c]) ** 2; }
        classes.push(...formatRegionClasses(C, count, sd, total, classes.length, r === 1));
    }
    if (harvest) harvestTextures(harvest.g, json, images, rebuilt, classes, wL);
    return classes;
}

/**
 * The tile-only harvest's texture per class (material-harvest.ts): on each rebuilt facade's photo, at its own texel, the band
 * responses of its texels, summed per class (each texel's nearest class, lightness
 * weighed as the classes were); and on how many facades each class holds at least 5% of the wall.
 */
function harvestTextures(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, rebuilt: Map<number, string>, classes: RegionClass[], wL: number, put: (c: RegionClass, texture: TextureEnergy, facades: number) => void = (c, t, f) => { c.texture = t; c.facades = f; }): void {
    const K = classes.length, B = TEXTURE_BANDS_M.length;
    const sq = Array.from({ length: K }, () => new Float64Array(B)), lum = Array.from({ length: K }, () => new Float64Array(B)), cnt = Array.from({ length: K }, () => new Float64Array(B));
    const texelSum = new Float64Array(K), texelN = new Float64Array(K), facades = new Int32Array(K), cand = regionCandidates(classes);
    for (const [mi, mesh] of rebuilt) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        const texelM = texelMetres(g, json, mi, img);
        if (!(texelM > 0)) continue;
        const N = img.width * img.height, valid = new Uint8Array(N), L = new Float32Array(N), cls = new Int8Array(N).fill(-1), open = maskOf(json, mesh, img);
        const share = new Float64Array(K);
        for (let i = 0; i < N; i++) {
            const p = i * 4;
            if (!img.rgba[p + 3]) continue;
            valid[i] = 1;
            L[i] = lumaOf(img.rgba, p);
            const lab = labOf(img.rgba[p], img.rgba[p + 1], img.rgba[p + 2]);
            let best = 0, bd = Infinity;
            for (const k of cand[open?.[i] ? 1 : 0]) { const c = classes[k].meanLab, d = (wL * (lab[0] - c[0])) ** 2 + (lab[1] - c[1]) ** 2 + (lab[2] - c[2]) ** 2; if (d < bd) { bd = d; best = k; } }
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
        put(c, { texelM: Math.round((texelSum[k] / texelN[k]) * 1e4) / 1e4, energy: Array.from({ length: B }, (_, b) => { if (!cnt[k][b]) return NaN; const m = lum[k][b] / cnt[k][b]; return m > 0 ? Math.round((sq[k][b] / cnt[k][b] / (m * m)) * 1e6) / 1e6 : NaN; }) }, facades[k]);
    });
}

/** Every class's texture energy as the rebuilt facades' photos show it (RegionClass.photoTexture), as the harvest measures it. */
export function classPhotoTextures(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[]): void {
    harvestTextures(g, json, images, photoMaterials(json).rebuilt, classes, 1, (c, t) => { c.photoTexture = t; });
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
 * A rebuilt facade's repeated elements (see the file comment, 4): each fitted window's unit cell (u0 v0 u1 v1, its photo's
 * UVs) and its family, families of fewer than minRepeats left out. Gaps are to the nearest window beside it (overlapping it
 * by half its height) and above or below it (by half its width); a window with no neighbour on a side takes the other side's.
 */
export function repeatElements(windows: number[] | undefined, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): { rects: number[]; family: number[]; /** Each kept element's window, u0 v0 u1 v1. */ windows: number[] } {
    const w: number[][] = [];
    for (let i = 0; i + 3 < (windows?.length ?? 0); i += 4) w.push(windows!.slice(i, i + 4));
    const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);
    const cells = w.map(([u0, v0, u1, v1]) => {
        let left = Infinity, right = Infinity, up = Infinity, down = Infinity;
        for (const [p0, q0, p1, q1] of w) {
            if (overlap(v0, v1, q0, q1) > 0.5 * (v1 - v0)) { if (p1 <= u0) left = Math.min(left, u0 - p1); if (p0 >= u1) right = Math.min(right, p0 - u1); }
            if (overlap(u0, u1, p0, p1) > 0.5 * (u1 - u0)) { if (q1 <= v0) up = Math.min(up, v0 - q1); if (q0 >= v1) down = Math.min(down, q0 - v1); }
        }
        const h = (a: number, b: number) => (Number.isFinite(a) ? a : Number.isFinite(b) ? b : 0) / 2;
        return [Math.max(0, u0 - h(left, right)), Math.max(0, v0 - h(up, down)), Math.min(1, u1 + h(right, left)), Math.min(1, v1 + h(down, up))];
    });
    const fam: number[] = [], heads: number[][] = [];
    for (const c of cells) {
        const cw = c[2] - c[0], ch = c[3] - c[1];
        let f = heads.findIndex(([hw, hh]) => Math.abs(cw - hw) <= P.repeatTolerance * hw && Math.abs(ch - hh) <= P.repeatTolerance * hh);
        if (f < 0) { f = heads.length; heads.push([cw, ch]); }
        fam.push(f);
    }
    const size = heads.map((_, f) => fam.filter(x => x === f).length), keep = new Map<number, number>();
    size.forEach((n, f) => { if (n >= P.minRepeats) keep.set(f, keep.size); });
    const rects: number[] = [], family: number[] = [], kept: number[] = [];
    cells.forEach((c, i) => { if (keep.has(fam[i])) { rects.push(...c); family.push(keep.get(fam[i])!); kept.push(...w[i]); } });
    return { rects, family, windows: kept };
}

/**
 * Each class's repeat size (RegionClass.repeatM): on every rebuilt facade, each repeated element (repeatElements) sampled
 * every 3rd texel each way, each texel classed by its nearest class among its region's; the window given to the opening
 * class most of its texels hold, and its unit cell, less the window, to the outside class most of the rest hold; per class
 * the median of the shorter sides (m) of what it was given. Sets classes[k].repeatM.
 */
export function classRepeatSizes(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): void {
    const { rebuilt } = photoMaterials(json), cand = regionCandidates(classes), sizes = classes.map(() => [] as number[]);
    for (const [mi, mesh] of rebuilt) {
        const img = images.get(photoOf(json, mi)!.image);
        if (!img) continue;
        const texelM = texelMetres(g, json, mi, img), el = repeatElements(fittedWindows(json, mesh), P), open = maskOf(json, mesh, img);
        if (!(texelM > 0) || !el.family.length) continue;
        const { width: W, height: H, rgba } = img;
        const span = (r: number[]) => [Math.max(0, Math.floor(r[0] * W)), Math.max(0, Math.floor(r[1] * H)), Math.min(W, Math.ceil(r[2] * W)), Math.min(H, Math.ceil(r[3] * H))];
        for (let e = 0; e < el.family.length; e++) {
            const cell = span(el.rects.slice(e * 4, e * 4 + 4)), win = span(el.windows.slice(e * 4, e * 4 + 4));
            const inWin = new Array<number>(classes.length).fill(0), outWin = new Array<number>(classes.length).fill(0);
            for (let y = cell[1]; y < cell[3]; y += 3) for (let x = cell[0]; x < cell[2]; x += 3) {
                const k = y * W + x;
                if (!rgba[k * 4 + 3]) continue;
                const L = labOf(rgba[k * 4], rgba[k * 4 + 1], rgba[k * 4 + 2]);
                let best = 0, bd = Infinity;
                for (const c of cand[open?.[k] ? 1 : 0]) { const m = classes[c].meanLab, d = (L[0] - m[0]) ** 2 + (L[1] - m[1]) ** 2 + (L[2] - m[2]) ** 2; if (d < bd) { bd = d; best = c; } }
                (x >= win[0] && x < win[2] && y >= win[1] && y < win[3] ? inWin : outWin)[best]++;
            }
            for (const [n, s] of [[inWin, win], [outWin, cell]] as const) {
                const top = n.indexOf(Math.max(...n));
                if (n[top] > 0) sizes[top].push(Math.min(s[2] - s[0], s[3] - s[1]) * texelM);
            }
        }
    }
    classes.forEach((c, k) => {
        const v = sizes[k].sort((a, b) => a - b);
        if (v.length) c.repeatM = Math.round(v[v.length >> 1] * 100) / 100; else delete c.repeatM;
    });
}

/**
 * Folds the classes over the repeats (see the file comment, 4): each element's texels (floor at its start, ceil at its
 * end) vote, by their place in a grid x grid cutting of the element, for their family's class there; then each texel of
 * an element (the first element holding it) takes its cell's winner (the most votes, the lowest index on a tie). Changes
 * `cls` in place; returns how many texels changed.
 */
export function foldRepeats(cls: Uint8Array, W: number, H: number, K: number, el: { rects: number[]; family: number[] }, grid: number): number {
    const F = el.family.length ? Math.max(...el.family) + 1 : 0;
    if (!F) return 0;
    const votes = new Uint32Array(F * grid * grid * K);
    const spans = el.family.map((_, e) => {
        const r = el.rects.slice(e * 4, e * 4 + 4);
        return [Math.max(0, Math.floor(r[0] * W)), Math.max(0, Math.floor(r[1] * H)), Math.min(W, Math.ceil(r[2] * W)), Math.min(H, Math.ceil(r[3] * H))];
    });
    const cellOf = (x: number, y: number, s: number[]) => Math.min(grid - 1, Math.floor(((y - s[1]) * grid) / (s[3] - s[1]))) * grid + Math.min(grid - 1, Math.floor(((x - s[0]) * grid) / (s[2] - s[0])));
    spans.forEach((s, e) => {
        if (s[2] - s[0] < 2 || s[3] - s[1] < 2) return;
        const base = el.family[e] * grid * grid;
        for (let y = s[1]; y < s[3]; y++) for (let x = s[0]; x < s[2]; x++) votes[(base + cellOf(x, y, s)) * K + cls[y * W + x]]++;
    });
    const winner = new Uint8Array(F * grid * grid);
    for (let c = 0; c < F * grid * grid; c++) { let b = 0; for (let k = 1; k < K; k++) if (votes[c * K + k] > votes[c * K + b]) b = k; winner[c] = b; }
    const done = new Uint8Array(W * H);
    let changed = 0;
    spans.forEach((s, e) => {
        if (s[2] - s[0] < 2 || s[3] - s[1] < 2) return;
        const base = el.family[e] * grid * grid;
        for (let y = s[1]; y < s[3]; y++) for (let x = s[0]; x < s[2]; x++) {
            const k = y * W + x;
            if (done[k]) continue;
            done[k] = 1;
            const c = winner[base + cellOf(x, y, s)];
            if (cls[k] !== c) { cls[k] = c; changed++; }
        }
    });
    return changed;
}

/**
 * Each texel's class (see the file comment): its nearest class in CIELAB among its region's (`open`: 1 inside an opening;
 * an empty texel none), then the class most of the (2r+1)-square about it holds, the texel's own on a tie, else the lowest
 * index; a square of empty texels takes the wall. Counted one class at a time with running sums, so memory stays a few
 * bytes a texel.
 */
export function regionClassMap(img: RgbaImage8, classes: RegionClass[], r: number, open?: Uint8Array): Uint8Array {
    const { width: W, height: H, rgba } = img, K = classes.length, N = W * H, NONE = 255, cand = regionCandidates(classes);
    const wall = Math.max(0, classes.findIndex(c => c.wall));
    const raw = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
        if (!rgba[k * 4 + 3]) { raw[k] = NONE; continue; }
        const [L, a, b] = labOf(rgba[k * 4], rgba[k * 4 + 1], rgba[k * 4 + 2]);
        let best = 0, bd = Infinity;
        for (const c of cand[open?.[k] ? 1 : 0]) { const m = classes[c].meanLab, d = (L - m[0]) ** 2 + (a - m[1]) ** 2 + (b - m[2]) ** 2; if (d < bd) { bd = d; best = c; } }
        raw[k] = best;
    }
    const best = new Uint8Array(N).fill(wall), bestN = new Uint16Array(N), rawN = new Uint16Array(N), row = new Uint16Array(N), cnt = new Uint16Array(N);
    for (let c = 0; c < K; c++) {
        // running counts of class c along each row, then down each column, over the square's half-side r
        for (let y = 0; y < H; y++) {
            let run = 0;
            const o = y * W;
            for (let x = 0; x < Math.min(W, r); x++) if (raw[o + x] === c) run++;
            for (let x = 0; x < W; x++) {
                if (x + r < W && raw[o + x + r] === c) run++;
                row[o + x] = run;
                if (x - r >= 0 && raw[o + x - r] === c) run--;
            }
        }
        for (let x = 0; x < W; x++) {
            let run = 0;
            for (let y = 0; y < Math.min(H, r); y++) run += row[y * W + x];
            for (let y = 0; y < H; y++) {
                if (y + r < H) run += row[(y + r) * W + x];
                cnt[y * W + x] = run;
                if (y - r >= 0) run -= row[(y - r) * W + x];
            }
        }
        for (let k = 0; k < N; k++) {
            if (cnt[k] > bestN[k]) { bestN[k] = cnt[k]; best[k] = c; }
            if (raw[k] === c) rawN[k] = cnt[k];
        }
    }
    for (let k = 0; k < N; k++) if (raw[k] !== NONE && rawN[k] === bestN[k]) best[k] = raw[k];
    return best;
}

/** The square's half-side in texels for a texel of `texelM` metres (see MATERIAL_REGIONS_PARAMS.regionSmoothM). */
export const regionRadius = (texelM: number, P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS) =>
    texelM > 0 ? Math.max(1, Math.min(P.regionSmoothMaxTexels, Math.round(P.regionSmoothM / texelM))) : 1;

/**
 * How much of the relief each texel takes, into a class map's green channel (0..255): none on a texel beside another
 * class, rising to all of it CLASS_BORDER_FADE_M away (a city-block distance in texels), so two materials meet level
 * instead of stepping from one set's recess to the other's. A surface of one class is 255 throughout.
 */
export const CLASS_BORDER_FADE_M = 0.12;
export function classBorderWeights(cls: Uint8Array, W: number, H: number, texelM: number, rgba: Uint8Array): void {
    const N = W * H, FAR = 65535, d = new Uint16Array(N).fill(FAR);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x, c = cls[k];
        if ((x > 0 && cls[k - 1] !== c) || (x + 1 < W && cls[k + 1] !== c) || (y > 0 && cls[k - W] !== c) || (y + 1 < H && cls[k + W] !== c)) d[k] = 0;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x;
        if (x > 0 && d[k - 1] + 1 < d[k]) d[k] = d[k - 1] + 1;
        if (y > 0 && d[k - W] + 1 < d[k]) d[k] = d[k - W] + 1;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
        const k = y * W + x;
        if (x + 1 < W && d[k + 1] + 1 < d[k]) d[k] = d[k + 1] + 1;
        if (y + 1 < H && d[k + W] + 1 < d[k]) d[k] = d[k + W] + 1;
    }
    for (let k = 0; k < N; k++) rgba[k * 4 + 1] = d[k] === FAR ? 255 : Math.round(255 * Math.min(1, (d[k] * texelM) / CLASS_BORDER_FADE_M));
}

/** One material's share of the plan: a rebuilt facade's photo, or a scan piece's (each photo planned once, the first material using it). */
export interface MaterialPlanJob { kind: 'rebuilt' | 'scan'; material: number; mesh?: string }

/** A job's planned maps and its part of the report, merged in job order (mergeMaterialPlan) so the plan is the same however the jobs ran. */
export interface MaterialPlanPiece {
    planned?: PlannedMaterial;
    facade?: MaterialRegionsReport['facades']['perFacade'][number];
    /** The job's texels each class holds (by index). */
    classTexels: number[];
    /** The job's texels drawn as glass, its panes left as stone, and the texels of its glass panes left out as wall-like. */
    glass: number; panesOnStone: number; paneWallTexels: number;
}

/** What every job reads: the GLB, its photos, the classes and their sets, and each set's mean ORM. */
export interface MaterialPlanContext {
    g: ParsedGlb; json: any; images: Map<number, RgbaImage8>; classes: RegionClass[]; sets: RegionSet[]; P: MaterialRegionsParams;
    setMeans: Array<[number, number, number]>;
}

export function materialPlanContext(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], sets: RegionSet[], P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): MaterialPlanContext {
    return { g, json, images, classes, sets, P, setMeans: sets.map(st => meanOf(st.orm)) };
}

/** The plan's jobs, in the order the plan is merged: the rebuilt facades' photos, then the scan pieces' (each photo once). */
export function materialPlanJobs(json: any, images: Map<number, RgbaImage8>): MaterialPlanJob[] {
    const { rebuilt, other } = photoMaterials(json);
    const done = new Set<number>(), jobs: MaterialPlanJob[] = [];
    for (const [mi, mesh] of rebuilt) { const image = photoOf(json, mi)!.image; if (!images.get(image) || done.has(image)) continue; done.add(image); jobs.push({ kind: 'rebuilt', material: mi, mesh }); }
    for (const mi of other) { const image = photoOf(json, mi)!.image; if (!images.get(image) || done.has(image)) continue; done.add(image); jobs.push({ kind: 'scan', material: mi }); }
    return jobs;
}

/** The class written for a texel that takes no relief (a glass pane): no tile is ever stacked at it, so it reads as the surface. */
export const NO_RELIEF_CLASS = 255;

/** Plans one job's maps (see the file comment): independent of every other job, so jobs can run on separate threads. */
export function planMaterialJob(job: MaterialPlanJob, ctx: MaterialPlanContext): MaterialPlanPiece {
    const { g, json, images, classes, sets, P } = ctx;
    const K = classes.length;
    const piece: MaterialPlanPiece = { classTexels: new Array<number>(K).fill(0), glass: 0, panesOnStone: 0, paneWallTexels: 0 };
    const mi = job.material, img = images.get(photoOf(json, mi)!.image)!;
    const { width: W, height: H } = img, N = W * H;
    const texelM = texelMetres(g, json, mi, img);
    if (job.kind === 'rebuilt' && !(texelM > 0)) return piece;
    const cls = regionClassMap(img, classes, regionRadius(texelM, P), job.kind === 'rebuilt' ? maskOf(json, job.mesh, img) : undefined);
    const folded = job.kind === 'rebuilt' ? foldRepeats(cls, W, H, K, repeatElements(fittedWindows(json, job.mesh!), P), P.repeatGrid) : 0;
    for (let k = 0; k < N; k++) piece.classTexels[cls[k]]++;
    const orm = blank(W, H);
    if (job.kind === 'rebuilt') {
        // each class's set tiled at its real size, box-filtered to this facade's texel (built for the classes present)
        const tiles = sets.map((s, c) => {
            if (!piece.classTexels[c]) return undefined;
            const tw = Math.max(2, Math.round(s.realSizeM[0] / texelM)), th = Math.max(2, Math.round(s.realSizeM[1] / texelM));
            return { tw, th, n: shrinkTile(s.normal, tw, th, true), o: shrinkTile(s.orm, tw, th, false) };
        });
        const nrm = blank(W, H);
        // the glass in the panes (see the file comment, 5): main's smooth-glass setting, over whatever set the class has
        const pg = paneGlass(img, classes, fittedPanes(json, job.mesh!), P.paneWallShare);
        const gl = pg?.glass, glassR = Math.round(GLASS.roughness * 255), glassM = Math.round(GLASS.metalness * 255);
        // each texel's class, for the relief (the sets' recess tiles are sampled by it, at their own resolution)
        const cmap = sets.some(s => !!s.height) ? blank(W, H) : undefined;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const k = y * W + x, t = tiles[cls[k]]!, j = ((y % t.th) * t.tw + (x % t.tw)) * 3;
            if (gl?.[k]) { orm.rgba.set([255, glassR, glassM, 255], k * 4); nrm.rgba.set([128, 128, 255, 255], k * 4); cmap?.rgba.set([NO_RELIEF_CLASS, NO_RELIEF_CLASS, NO_RELIEF_CLASS, 255], k * 4); piece.glass++; continue; }
            orm.rgba.set([Math.round(t.o[j] * 255), Math.round(t.o[j + 1] * 255), Math.round(t.o[j + 2] * 255), 255], k * 4);
            nrm.rgba.set([Math.round(t.n[j] * 255), Math.round(t.n[j + 1] * 255), Math.round(t.n[j + 2] * 255), 255], k * 4);
            if (cmap) cmap.rgba.set([cls[k], 255, cls[k], 255], k * 4);
        }
        piece.panesOnStone = pg?.stone ?? 0; piece.paneWallTexels = pg?.wallTexels ?? 0;
        if (cmap) classBorderWeights(cls, W, H, texelM, cmap.rgba);
        const r3 = (v: number) => Math.round(v * 1000) / 1000;
        piece.facade = { mesh: job.mesh!, texelM: Math.round(texelM * 1e4) / 1e4, classShares: piece.classTexels.map(n => r3(n / N)), foldedShare: r3(folded / N), panes: pg?.panes ?? 0, glassShare: r3(piece.glass / N) };
        piece.planned = { material: mi, orm, normal: nrm, ...(cmap ? { classes: cmap, texelM } : {}), rebuilt: true, glass: piece.glass > 0 };
        return piece;
    }
    // scan pieces: each texel's class's set's mean ORM
    for (let k = 0; k < N; k++) {
        const m = ctx.setMeans[cls[k]];
        orm.rgba.set([Math.round(m[0] * 255), Math.round(m[1] * 255), Math.round(m[2] * 255), 255], k * 4);
    }
    piece.planned = { material: mi, orm, rebuilt: false, glass: false };
    return piece;
}

/** The plan from its jobs' pieces, in job order. */
export function mergeMaterialPlan(json: any, classes: RegionClass[], sets: RegionSet[], pieces: MaterialPlanPiece[], ms: number): MaterialRegionsPlan {
    const { rebuilt, other } = photoMaterials(json);
    const report: MaterialRegionsReport = {
        version: MATERIAL_REGIONS_VERSION,
        classes: classes.map((c, k) => ({ index: c.index, meanLab: c.meanLab, share: c.share, wall: c.wall, openings: c.openings, set: sets[k].name, distance: Math.round(sets[k].distance * 100) / 100, ...(sets[k].harvest ? { harvest: sets[k].harvest } : {}), ...(sets[k].choice ? { choice: sets[k].choice } : {}), ...(sets[k].finish ? { finish: sets[k].finish } : {}), ...(sets[k].heightDrawn ? { height: sets[k].heightDrawn } : {}), ...(c.texture ? { texture: c.texture, facades: c.facades } : {}) })),
        facades: { total: rebuilt.size, perFacade: [] }, scanPieces: { total: other.size }, texels: { total: 0, perClass: classes.map(() => 0), glass: 0 }, panesOnStone: 0, paneWallTexels: 0, ms
    };
    const planned: PlannedMaterial[] = [];
    for (const p of pieces) {
        if (p.planned) planned.push(p.planned);
        if (p.facade) report.facades.perFacade.push(p.facade);
        report.texels.glass += p.glass; report.panesOnStone += p.panesOnStone; report.paneWallTexels += p.paneWallTexels;
        p.classTexels.forEach((n, c) => { report.texels.perClass[c] += n; report.texels.total += n; });
    }
    return { materials: planned, sets, report };
}

/**
 * Plans the maps of every photo-textured material (see the file comment). `sets[k]` is class k's set. One thread; the
 * pipeline runs the same jobs across worker threads (material-regions-pool.ts) with the same result.
 */
export function planMaterialRegions(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], sets: RegionSet[], P: MaterialRegionsParams = MATERIAL_REGIONS_PARAMS): MaterialRegionsPlan {
    const t0 = Date.now();
    const ctx = materialPlanContext(g, json, images, classes, sets, P);
    const pieces = materialPlanJobs(json, images).map(j => planMaterialJob(j, ctx));
    return mergeMaterialPlan(json, classes, sets, pieces, Date.now() - t0);
}

/**
 * Writes a plan's maps into the GLB's materials: lit (KHR_materials_unlit removed), the metallic-roughness texture (its
 * red the occlusion, also the occlusion texture), the normal on rebuilt facades, and the extras: sbMaterial (the viewer's
 * reflection probe, every texel by its own roughness and metalness; and the relief: the facade's class map and metric
 * frame, with the classes' recess tiles in the asset's sbMaterialRelief) and the maps' provenance. `addTexture` stores an image
 * and returns its texture index.
 */
export function writeMaterialRegions(json: any, plan: MaterialRegionsPlan, addTexture: (img: RgbaImage8, mimeType: 'image/png' | 'image/jpeg', name: string) => number, provenanceIndices: number[]): void {
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
    let anyRelief = false;
    const sets = plan.sets.map(s => (s.harvest ? `${s.name}, chosen by colour and texture at the tile's texel (tile-only harvest), its finer grain ${s.harvest.grain}` : s.name)).join('; ');
    for (const pm of plan.materials) {
        const m = json.materials[pm.material];
        if (m.extensions) { delete m.extensions.KHR_materials_unlit; if (!Object.keys(m.extensions).length) delete m.extensions; }
        const name = m.name ?? `material_${pm.material}`;
        const pbr = m.pbrMetallicRoughness = m.pbrMetallicRoughness ?? {};
        pbr.metallicFactor = 1; pbr.roughnessFactor = 1;
        const orm = addTexture(pm.orm, 'image/jpeg', `${name}_orm`);
        pbr.metallicRoughnessTexture = { index: orm };
        m.occlusionTexture = { index: orm };
        if (pm.normal) m.normalTexture = { index: addTexture(pm.normal, 'image/jpeg', `${name}_normal`) };
        // the relief: this facade's class map and metric frame; the classes' recess tiles are stored once (below)
        const relief = pm.classes && pm.texelM ? { classTexture: addTexture(pm.classes, 'image/png', `${name}_classes`), weights: true, uvMetres: [r4(pm.classes.width * pm.texelM), r4(pm.classes.height * pm.texelM)] } : undefined;
        if (relief) anyRelief = true;
        m.extras = {
            ...(m.extras ?? {}),
            sbMaterial: { schema: 'scratchbox.staged-material/1', provenanceIndices, ...(relief ? { relief } : {}) },
            sbMaterialRegions: {
                version: MATERIAL_REGIONS_VERSION,
                baseColor: { label: 'photo-inferred', source: "pipeline K's harmonised photo" },
                material: { label: 'photo-inferred', source: `each texel's appearance class (CIELAB, the majority within ${MATERIAL_REGIONS_PARAMS.regionSmoothM} m)` },
                ...(relief ? { height: { label: 'generated', source: `each texel's class's set's height map, tiled at the set's real size, as a recess of at most ${HEIGHT_RELIEF.capM} m below the rebuilt plane (${plan.sets.filter(st => st.heightDrawn).map(st => `${st.name} ${Math.round(st.heightDrawn!.maxRecessM * 1000)} mm, its depth ${st.heightDrawn!.source}`).join('; ')}); the scan's own pieces and the glass panes take none` } } : {}),
                maps: { label: 'generated', source: `the texture library set of each texel's class (${sets}): ${pm.rebuilt ? 'occlusion, roughness, metalness and normal tiled at the set\'s real size' : "the set's mean occlusion, roughness and metalness"}` },
                ...(pm.glass ? { glass: { label: 'photo-inferred', source: `the panes of the fitted windows (the facade reader's accepted openings with the pane splits it read where it read the plane, the window fit's elsewhere), less panes mostly of the wall's class and the wall's class's texels: roughness ${GLASS.roughness}, no metalness, flat; the photo kept as the colour` } } : {})
            }
        };
    }
    // the classes' recess tiles, once for the building: the viewer's parallax and the near displacement sample them by each
    // facade's class map (height-relief.ts, heightRelief.ts)
    if (anyRelief) {
        json.asset = json.asset ?? { version: '2.0' };
        json.asset.extras = {
            ...(json.asset.extras ?? {}),
            sbMaterialRelief: {
                schema: 'scratchbox.material-relief/1', version: MATERIAL_HEIGHT_VERSION, depthM: HEIGHT_RELIEF.capM, label: 'generated',
                about: `each class's library set's height as a recess below the surface it is drawn on: a tile's 255 is the surface, 0 a recess of ${HEIGHT_RELIEF.capM} m; tiled at sizeM, placed by each material's class map (extras.sbMaterial.relief)`,
                tiles: plan.sets.map((st, k) => (st.height && st.heightDrawn ? { class: k, set: st.name, texture: addTexture(st.height, 'image/png', `relief_${st.name}`), sizeM: st.realSizeM, ...st.heightDrawn } : null))
            }
        };
    }
    if (!json.materials.some((m: any) => m.extensions?.KHR_materials_unlit) && Array.isArray(json.extensionsUsed)) {
        json.extensionsUsed = json.extensionsUsed.filter((e: string) => e !== 'KHR_materials_unlit');
        if (!json.extensionsUsed.length) delete json.extensionsUsed;
    }
}

/**
 * The appearance classes as a picture, for a vision model to name them (material-naming.ts) and to choose their library
 * sets by their look (material-choice.ts): one row a class, up to
 * `perClass` patches of the harmonised rebuilt facade photos where that class covers most of the patch (each texel given
 * to its nearest class, as the classes were read), scaled up `zoom` times, on white. The rows follow `classes`' order.
 */
export function classSwatchSheet(json: any, images: Map<number, RgbaImage8>, classes: RegionClass[], opts: { patch?: number; perClass?: number; zoom?: number; seed?: number; /** The parsed GLB: the patches' real size measured (`spanM`). */ g?: ParsedGlb } = {}): { width: number; height: number; rgba: Uint8Array; /** The median real size of a patch, metres (with `g`). */ spanM?: number } | undefined {
    const patch = opts.patch ?? 24, per = opts.perClass ?? 6, zoom = opts.zoom ?? 4, gap = 8;
    const { rebuilt } = photoMaterials(json);
    const texel = new Map<RgbaImage8, number>();
    const photos = [...rebuilt].map(([mi, mesh]) => { const img = images.get(photoOf(json, mi)!.image); if (img && opts.g && !texel.has(img)) texel.set(img, texelMetres(opts.g, json, mi, img)); return img ? { img, open: maskOf(json, mesh, img) } : undefined; }).filter((x): x is { img: RgbaImage8; open: Uint8Array | undefined } => !!x && x.img.width > patch && x.img.height > patch);
    if (!photos.length || !classes.length) return undefined;
    const cand = regionCandidates(classes);
    const nearest = (r: number, g: number, b: number, inside: boolean) => { const L = labOf(r, g, b); let best = 0, bd = Infinity; for (const k of cand[inside ? 1 : 0]) { const c = classes[k].meanLab, d = (L[0] - c[0]) ** 2 + (L[1] - c[1]) ** 2 + (L[2] - c[2]) ** 2; if (d < bd) { bd = d; best = k; } } return best; };
    const found: Array<Array<{ img: RgbaImage8; x: number; y: number; size: number }>> = classes.map(() => []);
    const rnd = sampler(opts.seed ?? 11);
    // patches of the full size and of half of it, in turn: an opening is often narrower than a full patch
    for (let tries = 0; tries < 6000 && found.some(f => f.length < per); tries++) {
        const { img, open } = photos[tries % photos.length], size = tries % 2 ? patch >> 1 : patch, x = Math.floor(rnd() * (img.width - size)), y = Math.floor(rnd() * (img.height - size));
        const count = new Array<number>(classes.length).fill(0);
        let covered = 0;
        for (let yy = y; yy < y + size; yy += 2) for (let xx = x; xx < x + size; xx += 2) { const t = yy * img.width + xx, q = t * 4; if (!img.rgba[q + 3]) continue; covered++; count[nearest(img.rgba[q], img.rgba[q + 1], img.rgba[q + 2], !!open?.[t])]++; }
        if (covered < 0.9 * (size / 2) ** 2) continue;
        const k = count.indexOf(Math.max(...count));
        if (count[k] >= 0.7 * covered && found[k].length < per) found[k].push({ img, x, y, size });
    }
    const cell = patch * zoom, W = per * (cell + gap) + gap, H = classes.length * (cell + gap) + gap, out = new Uint8Array(W * H * 4).fill(255);
    found.forEach((row, r) => row.forEach((p, c) => {
        for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
            const sq = ((p.y + Math.floor((y * p.size) / cell)) * p.img.width + p.x + Math.floor((x * p.size) / cell)) * 4, dq = ((gap + r * (cell + gap) + y) * W + gap + c * (cell + gap) + x) * 4;
            out[dq] = p.img.rgba[sq]; out[dq + 1] = p.img.rgba[sq + 1]; out[dq + 2] = p.img.rgba[sq + 2]; out[dq + 3] = 255;
        }
    }));
    const spans = found.flat().map(p => p.size * (texel.get(p.img) ?? 0)).filter(v => v > 0).sort((a, b) => a - b);
    return { width: W, height: H, rgba: out, ...(spans.length ? { spanM: spans[spans.length >> 1] } : {}) };
}

/** One line for the build's notes. */
export function describeMaterialRegions(r: MaterialRegionsReport): string {
    const pct = (a: number) => (r.texels.total ? `${Math.round((100 * a) / r.texels.total)}%` : '0%');
    return `material regions: ${r.classes.length} appearance classes (${r.classes.map((c, k) => `${c.openings ? 'in openings ' : ''}${c.wall ? 'lightest' : 'L ' + Math.round(c.meanLab[0])} -> ${c.set}, ${pct(r.texels.perClass[k] ?? 0)} of texels`).join('; ')}); ` +
        `every texel its class's set: ${r.facades.total} rebuilt facades tiled at the sets' real size, ${r.scanPieces.total} scan pieces the sets' mean finish; glass in the fitted windows' panes on ${pct(r.texels.glass)} of texels (the wall guard: ${r.panesOnStone} panes left as stone, ${pct(r.paneWallTexels)} of texels wall-like within glass panes); ` +
        `occlusion, roughness, metalness and normal generated from the library, colour the photo` +
        `${r.classes.some(c => c.height) ? `; height (a recess below the rebuilt planes, generated): ${r.classes.filter(c => c.height).map(c => `${c.set} up to ${Math.round(c.height!.maxRecessM * 1000)} mm`).join(', ')}` : ''} (${r.ms} ms)`;
}
