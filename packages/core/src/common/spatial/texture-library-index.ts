/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The index of the texture library bucket (assets/textures/library/index.json, schema scratchbox.texture-library/1):
 * one entry per material set stored there (ambientCG and Poly Haven PBR sets), so a script's surfaces are chosen by
 * searching what the library holds, by appearance and real-world scale, instead of by guessed names.
 *
 * Like the surface texture library (surface-texture-library.ts), entries are described by continuous quantities: colour
 * statistics, the real size one tile spans as its publisher measured it, roughness and metalness. `appearance` and
 * `tags` are the publisher's free text for a model or a text search to read; nothing branches on them.
 *
 * The index file holds only the publishers' metadata (sizes, text, preview links), so building it downloads no images.
 * Colour, roughness, metalness and normal relief are measured on demand, for the sets a search is about to rank, from their publishers'
 * small preview maps, and cached per set (build/texture-library/stats/); a set nobody searched for stays unmeasured.
 * Quantities not measured or not published are left out rather than guessed, and the entry says why.
 */

export const TEXTURE_LIBRARY_SCHEMA = 'scratchbox.texture-library/1';

export interface TextureLibraryColour {
    /** Linear sRGB (Rec. 709, D65) and CIELAB (D65) of the colour map's pixels: mean and standard deviation. */
    meanLinearRgb: [number, number, number];
    spreadLinearRgb: [number, number, number];
    meanLab: [number, number, number];
    spreadLab: [number, number, number];
}

export interface TextureLibraryEntry {
    /** The set's folder in the bucket (its name for librarySets). */
    id: string;
    publisher: 'ambientCG' | 'Poly Haven' | (string & {});
    /** Bucket object names by role (only the roles a GLB material uses), and their total download size. */
    maps: { color?: string; normal?: string; roughness?: string; ao?: string; metalness?: string; arm?: string; /** The height (displacement) map: fetched only when a caller asks for it. */ height?: string };
    downloadMB: number;
    /** Pixel size of the stored maps, when the publisher states it. */
    pixels?: [number, number];
    /** Real-world size one tile spans (x, y), metres, as the publisher measured it. */
    realSizeM?: [number, number];
    /** The publisher's width alone, when it gives no height: the height follows from the preview's aspect once measured. */
    widthOnlyM?: number;
    /** The publisher's small preview maps by role (ambientCG lists them; Poly Haven's are looked up when measured). */
    previews?: { color?: string; normal?: string; roughness?: string; metalness?: string; arm?: string; height?: string };
    sizeSource: string;
    /**
     * The real depth the height map spans from its black to its white, metres, and where it comes from: the publisher's
     * own figure when it gives one, else an estimate (texture-library-heights.ts: the depth at which the height map's
     * slopes equal the normal map's over the tile's real size), labelled so. Absent for a set with no height map, no real
     * size or no usable estimate: its height is then never drawn.
     */
    heightDepthM?: number;
    heightDepthSource?: string;
    /** How well the estimate's height slopes follow the normal map's (their correlation, 0..1); absent for a publisher's depth. */
    heightDepthFit?: number;
    colour?: TextureLibraryColour;
    /** Roughness map mean and spread, and the metalness map's mean, 0..1. `metallic` is 0 for a set the bucket holds no
     * metalness map for (glTF's default: its publisher left it dielectric); hasMetalnessMap tells the two apart. */
    roughnessMean?: number;
    roughnessSpread?: number;
    metallic?: number;
    /** Whether the bucket holds a metalness map for the set (its own or a packed ARM map's blue channel). */
    hasMetalnessMap?: boolean;
    /** Measured on the metalness preview only (absent when no metalness map was measured): the share of pixels with
     * metalness at least 0.5, and the 95th percentile of metalness, 0..1. */
    metalShare?: number;
    metalnessP95?: number;
    /** RMS angle, degrees, between the normal map's normals and the flat normal, measured on the preview resampled to at
     * most 256 px a side (so relief finer than a preview pixel is not counted). Absent when no normal preview was measured. */
    normalTiltRmsDeg?: number;
    /** Where the colour and roughness statistics were measured (the publisher's preview maps). */
    statsSource?: string;
    appearance: string;
    tags: string[];
    provenance: 'library';
    /** Why a quantity is missing, when one is. */
    notes?: string[];
}

export interface TextureLibraryIndex {
    schema: typeof TEXTURE_LIBRARY_SCHEMA;
    about: string;
    bucket: string;
    builtAt: string;
    sets: TextureLibraryEntry[];
}

export interface TextureLibraryQuery {
    /** Wanted colour, sRGB 0..1 (a measured wall colour, say). Chroma and hue weigh most; lightness less, since a chosen set is tinted. */
    colorSrgb?: [number, number, number];
    /** Wanted colour variation, a measured CIELAB standard deviation [L, a, b] of the surface (e.g. from photo texels);
     * a negative L leaves lightness variation out of the comparison. */
    colorSpreadLab?: [number, number, number];
    /** Wanted finish, 0 polished .. 1 matte. */
    roughness?: number;
    /** Wanted metalness, 0 dielectric .. 1 metal. */
    metallic?: number;
    /** Wanted share of the surface that is metal (metalness at least 0.5), 0..1. */
    metalShare?: number;
    /** Wanted normal relief as an RMS tilt in degrees (about 2 smooth render or sheet, 10-25 rough masonry). */
    normalTiltDeg?: number;
    /** true keeps only sets with a metalness map in the bucket; false only sets without one. */
    hasMetalnessMap?: boolean;
    /** Wanted real size of one tile, metres (the longer side); compared as a ratio. */
    tileSizeM?: number;
    /** Words of which at least one must appear in the set's name, tags or appearance text (alternatives, case-insensitive). */
    text?: string;
    limit?: number;
}

export interface TextureLibraryHit {
    entry: TextureLibraryEntry;
    distance: number;
    /** The quantities the distance compared, and the ones the entry could not be compared on. */
    compared: string[];
    unmeasured: string[];
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** CIELAB (D65) of a linear sRGB colour. */
export function linearRgbToLab([r, g, b]: [number, number, number]): [number, number, number] {
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** Whether the bucket holds a metalness map for the set: known from its maps without measuring. */
export const entryHasMetalnessMap = (e: TextureLibraryEntry) => e.hasMetalnessMap ?? !!(e.maps.metalness || e.maps.arm);

/** The sets a search ranks: those with a colour map in the bucket (a set without one cannot be a surface), narrowed by
 * the text words when any set matches one of them, and kept to sets with (or without) a metalness map when asked. */
export function textureLibraryPool(index: TextureLibraryIndex, q: Pick<TextureLibraryQuery, 'text' | 'hasMetalnessMap'>): { pool: TextureLibraryEntry[]; textMatched: boolean } {
    const words = (q.text ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    const usable = index.sets.filter(e => !!e.maps.color && (q.hasMetalnessMap === undefined || entryHasMetalnessMap(e) === q.hasMetalnessMap));
    const pool = words.length ? usable.filter(e => { const hay = `${e.id} ${e.tags.join(' ')} ${e.appearance}`.toLowerCase(); return words.some(w => hay.includes(w)); }) : usable;
    return pool.length || !words.length ? { pool, textMatched: true } : { pool: usable, textMatched: false };
}

/**
 * Sets ranked by how near they lie to what is wanted. Each quantity is scaled so one unit is a clearly visible
 * difference: CIELAB chroma and hue (10), lightness (25: a chosen set is tinted), roughness (0.15), metalness (0.3),
 * metal share (0.25), normal tilt (a 30% ratio, on tilt + 1 degree) and the log ratio of tile sizes; with a wanted spread, its lightness (10) and hue (6) parts, weighed lightly since a
 * spread measured on photo texels also holds what the texels mix (windows into stone). A set with no hue variation
 * of its own also pays a coloured target's chroma, since tinting it gives one flat hue. A quantity an entry lacks counts as one unit, so measured entries come first without
 * dropping the rest. Text words filter (a set matching any of them stays); when none matches, the ranking runs without the
 * filter and says so.
 */
export function searchTextureLibrary(index: TextureLibraryIndex, q: TextureLibraryQuery): { hits: TextureLibraryHit[]; textMatched: boolean } {
    const { pool, textMatched } = textureLibraryPool(index, q);
    const wantLab = q.colorSrgb ? linearRgbToLab(q.colorSrgb.map(srgbToLinear) as [number, number, number]) : undefined;
    const hits = pool.map(entry => {
        let d = 0;
        const compared: string[] = [], unmeasured: string[] = [];
        const term = (name: string, have: boolean, value: () => number) => {
            if (have) { d += value(); compared.push(name); } else { d += 1; unmeasured.push(name); }
        };
        if (wantLab) {
            term('colour', !!entry.colour, () => {
                const L = entry.colour!.meanLab, S = entry.colour!.spreadLab;
                // a set without hue variation of its own (a greyscale map) cannot carry a coloured target's: tinted, it is
                // one flat hue. It pays the target's chroma, fading out as its own hue spread reaches 1 ΔE.
                const flat = Math.hypot(wantLab[1], wantLab[2]) / 10 * Math.max(0, 1 - Math.hypot(S[1], S[2]));
                return Math.hypot(L[1] - wantLab[1], L[2] - wantLab[2]) / 10 + Math.abs(L[0] - wantLab[0]) / 25 + flat;
            });
        }
        if (q.colorSpreadLab) {
            const w = q.colorSpreadLab;
            term('colour spread', !!entry.colour, () => {
                const S = entry.colour!.spreadLab;
                return (w[0] >= 0 ? Math.abs(S[0] - w[0]) / 10 : 0) + Math.abs(Math.hypot(S[1], S[2]) - Math.hypot(w[1], w[2])) / 6;
            });
        }
        if (q.roughness !== undefined) term('roughness', entry.roughnessMean !== undefined, () => Math.abs(entry.roughnessMean! - q.roughness!) / 0.15);
        if (q.metallic !== undefined) term('metallic', entry.metallic !== undefined, () => Math.abs(entry.metallic! - q.metallic!) / 0.3);
        if (q.metalShare !== undefined) term('metal share', entry.metalShare !== undefined || !entryHasMetalnessMap(entry), () => Math.abs((entry.metalShare ?? 0) - q.metalShare!) / 0.25);
        if (q.normalTiltDeg !== undefined) term('normal tilt', entry.normalTiltRmsDeg !== undefined, () => Math.abs(Math.log((entry.normalTiltRmsDeg! + 1) / (Math.max(0, q.normalTiltDeg!) + 1))) / Math.log(1.3));
        if (q.tileSizeM !== undefined) term('tile size', !!entry.realSizeM, () => Math.abs(Math.log(Math.max(...entry.realSizeM!) / Math.max(1e-3, q.tileSizeM!))));
        return { entry, distance: d, compared, unmeasured };
    });
    hits.sort((a, b) => a.distance - b.distance || a.entry.id.localeCompare(b.entry.id));
    return { hits: hits.slice(0, Math.max(1, q.limit ?? 10)), textMatched };
}
