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

