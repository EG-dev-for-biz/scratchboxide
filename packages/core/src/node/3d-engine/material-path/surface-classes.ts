/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The material path's classes and sets, for any surface (user ask, 2026-11-05: the material detection usable on any 3D
 * object the app builds, not only buildings). An appearance class is a colour a surface's texels gather around (CIELAB
 * k-means), or one part of a generated object; its set is the texture library set matched to it (class-sets.ts). Nothing
 * here knows what the surface is: a facade supplies its window openings and repeats as optional priors (`openings`,
 * `repeatM`), an object none.
 */

import type { RgbaImage8 } from '../staged-location/tile-texture-transfer';
import type { TextureEnergy } from './material-harvest';
import type { DrawnHeight } from './material-height';

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
    finish?: { read?: { roughness: number; metalness: number; conf: number; seen?: string }; why?: string; roughness: number; metallic: number; /** The finish and grain the set's maps were drawn at (material-finish.ts finishMaps), when either changed them. */ drawn?: { roughness: number; metallic: number; relief: number; grain: number }; label: 'photo-inferred' };
}

/** The lightness-seeded CIELAB k-means of samples X (L a b each): the centres and each sample's centre. */
export function kMeansLab(X: number[], K: number, iterations: number, wL: number): { C: number[][]; lab: Int32Array } {
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

/**
 * A surface's maps from its texels' classes: each texel's class's set tiled at the set's real size, box-filtered to the
 * surface's texel (`texelM` metres, so a tile never aliases): occlusion, roughness and metalness (ORM) and the normal;
 * and, when any set has a height, each texel's class (r and b the class index) with the share of the relief it takes
 * (g: classBorderWeights), which place the sets' recess tiles.
 * `cls` is one class a texel, row-major; `present[c]` the texels class c holds (a class with none is not tiled).
 */
export function drawClassSets(cls: Uint8Array, W: number, H: number, texelM: number, sets: RegionSet[], present: number[]): { orm: RgbaImage8; normal: RgbaImage8; classes?: RgbaImage8 } {
    const blank = (): RgbaImage8 => ({ width: W, height: H, rgba: new Uint8Array(W * H * 4) });
    const tiles = sets.map((s, c) => {
        if (!present[c]) return undefined;
        const tw = Math.max(2, Math.round(s.realSizeM[0] / texelM)), th = Math.max(2, Math.round(s.realSizeM[1] / texelM));
        return { tw, th, n: shrinkTile(s.normal, tw, th, true), o: shrinkTile(s.orm, tw, th, false) };
    });
    const orm = blank(), nrm = blank();
    const cmap = sets.some(s => !!s.height) ? blank() : undefined;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x, t = tiles[cls[k]]!, j = ((y % t.th) * t.tw + (x % t.tw)) * 3;
        orm.rgba.set([Math.round(t.o[j] * 255), Math.round(t.o[j + 1] * 255), Math.round(t.o[j + 2] * 255), 255], k * 4);
        nrm.rgba.set([Math.round(t.n[j] * 255), Math.round(t.n[j + 1] * 255), Math.round(t.n[j + 2] * 255), 255], k * 4);
        if (cmap) cmap.rgba.set([cls[k], 255, cls[k], 255], k * 4);
    }
    if (cmap) classBorderWeights(cls, W, H, texelM, cmap.rgba);
    return { orm, normal: nrm, ...(cmap ? { classes: cmap } : {}) };
}
