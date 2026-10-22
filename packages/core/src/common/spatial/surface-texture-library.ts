/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The surface texture library (assets/textures/surfaces/index.json, schema scratchbox.surface-textures/1): tileable
 * materials for the surfaces a procedural rebuild lays down (ground, carriageways, walls, decks, roofs), chosen by appearance
 * and real-world scale and tinted to the colour measured at the place. Nothing of the scan's photo is reused on them.
 *
 * Entries are described by continuous quantities only (colour statistics, the real-world size one tile spans, relief and
 * roughness); `appearance` is free text for a model to read and is never branched on. Entries made by an image model carry
 * provenance 'generated' with the model and prompt that made them; entries from a texture set carry 'library'.
 */

export const SURFACE_TEXTURE_SCHEMA = 'scratchbox.surface-textures/1';

/** Colour statistics of an entry's pixels (linear sRGB, Rec. 709 primaries, D65; CIELAB D65). */
export interface SurfaceTextureColour {
    meanLinearRgb: [number, number, number];
    spreadLinearRgb: [number, number, number];
    meanLab: [number, number, number];
    spreadLab: [number, number, number];
    meanLuminance: number;
}

export interface SurfaceTextureEntry {
    id: string;
    /** Paths relative to the index's folder; every map tiles (its left edge continues its right, its top its bottom). */
    maps: { color: string; normal: string; roughness: string; height?: string };
    pixels: [number, number];
    /** Real-world size one tile spans (x, y), metres. */
    realSizeM: [number, number];
    /** How realSizeM was set: the size asked for, or a vision reading of the texture's own features. */
    sizeSource: string;
    colour: SurfaceTextureColour;
    surface: {
        /** Mean slope of the normal map (|n_xy|). */
        normalSlopeMean: number;
        /** Robust range (2.5-97.5 %) of the height map, as a share of its full range. */
        heightRange: number;
        /** Peak-to-trough relief the normal map stands for, metres. */
        reliefM: number;
        /** Mean and spread of the roughness map, 0..1. */
        roughnessMean: number;
        roughnessSpread: number;
        metallic: number;
    };
    appearance: string;
    provenance: 'generated' | 'library';
    /** For a generated entry: the models and prompts that made it and how the maps were derived. */
    source?: { model: string; prompt: string; heightModel?: string; heightPrompt?: string; method: string };
    /** For a generated entry: how closely the height map's edges follow the colour map's (0..1, normalised cross-correlation). */
    heightAlignment?: number;
}

export interface SurfaceTextureIndex {
    schema: typeof SURFACE_TEXTURE_SCHEMA;
    about: string;
    conventions: Record<string, string>;
    surfaces: SurfaceTextureEntry[];
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const vec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(finite);

/** Problems with an index (structure and value ranges); [] when it is usable. */
export function validateSurfaceTextureIndex(doc: unknown): string[] {
    const out: string[] = [];
    const d = doc as Partial<SurfaceTextureIndex> | undefined;
    if (!d || d.schema !== SURFACE_TEXTURE_SCHEMA) return [`schema is not ${SURFACE_TEXTURE_SCHEMA}`];
    if (!Array.isArray(d.surfaces) || d.surfaces.length === 0) return ['surfaces: at least one entry'];
    const ids = new Set<string>();
    for (const e of d.surfaces) {
        const at = `surfaces.${e?.id}`;
        if (!e?.id || ids.has(e.id)) out.push(`${at}: missing or repeated id`);
        ids.add(e?.id);
        if (!e?.maps?.color || !e.maps.normal || !e.maps.roughness) out.push(`${at}: needs color, normal and roughness maps`);
        const c = e?.colour;
        if (!c || !vec(c.meanLinearRgb, 3) || !vec(c.spreadLinearRgb, 3) || !vec(c.meanLab, 3) || !vec(c.spreadLab, 3) || !finite(c.meanLuminance)
            || !c.meanLinearRgb.every(x => x >= 0 && x <= 1)) out.push(`${at}.colour: bad statistics`);
        if (!vec(e?.realSizeM, 2) || !(e.realSizeM[0] > 0 && e.realSizeM[1] > 0)) out.push(`${at}.realSizeM: two positive sizes`);
        if (!vec(e?.pixels, 2)) out.push(`${at}.pixels: width and height`);
        const s = e?.surface;
        if (!s || !(s.normalSlopeMean >= 0) || !(s.reliefM >= 0) || !(s.roughnessMean >= 0 && s.roughnessMean <= 1) || !(s.metallic >= 0 && s.metallic <= 1)) out.push(`${at}.surface: slope, relief, roughness and metallic`);
        if (typeof e?.appearance !== 'string' || !e.appearance) out.push(`${at}.appearance: a description is required`);
        if (e?.provenance !== 'generated' && e?.provenance !== 'library') out.push(`${at}.provenance: "generated" or "library"`);
        if (e?.provenance === 'generated' && (!e.source?.model || !e.source.prompt)) out.push(`${at}.source: a generated entry names its model and prompt`);
    }
    return out;
}

/** Every file an index names (relative to the index's folder). */
export function surfaceTextureFiles(index: SurfaceTextureIndex): string[] {
    return index.surfaces.flatMap(e => Object.values(e.maps).filter((f): f is string => typeof f === 'string'));
}

/**
 * The per-channel multiplier that takes an entry's mean colour to a measured one (linear sRGB): the texture keeps its own
 * variation and lands on the place's colour. Clamped so a near-black channel is not blown up.
 */
export function surfaceTint(entry: Pick<SurfaceTextureEntry, 'colour'>, measuredLinearRgb: [number, number, number], maxGain = 4): [number, number, number] {
    return [0, 1, 2].map(k => Math.min(maxGain, Math.max(1 / maxGain, measuredLinearRgb[k] / Math.max(1e-4, entry.colour.meanLinearRgb[k])))) as [number, number, number];
}

/**
 * Entries ranked by how near they lie to what was measured: CIELAB chroma and hue (lightness is left to the tint), the
 * relief in metres (log ratio) and the roughness, each scaled so one unit is a clearly visible difference. Missing
 * quantities are not compared. This ranks; a vision model that has read the place chooses among the leaders by appearance.
 */
export function rankSurfaceTextures(index: SurfaceTextureIndex, wanted: { meanLab?: [number, number, number]; reliefM?: number; roughness?: number }): Array<{ id: string; distance: number }> {
    return index.surfaces.map(e => {
        let d = 0;
        if (wanted.meanLab) d += Math.hypot(e.colour.meanLab[1] - wanted.meanLab[1], e.colour.meanLab[2] - wanted.meanLab[2]) / 10;
        if (wanted.reliefM !== undefined) d += Math.abs(Math.log((e.surface.reliefM + 0.002) / (wanted.reliefM + 0.002)));
        if (wanted.roughness !== undefined) d += Math.abs(e.surface.roughnessMean - wanted.roughness) / 0.15;
        return { id: e.id, distance: d };
    }).sort((a, b) => a.distance - b.distance);
}
