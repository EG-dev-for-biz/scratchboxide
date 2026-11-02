/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree texture library (assets/textures/trees/index.json, schema scratchbox.tree-textures/1): surface textures for
 * staged trees, chosen per tree by appearance in the native trees writer (scratchbox_tree_textures.hpp) and drawn by the
 * viewport in textured mode (treeTextureMaterials.ts).
 *
 * Every entry is described by continuous quantities only (colour statistics, leaf length and width in metres, bark relief
 * and real-world size); `appearance` is free text for a model to read and is never branched on. Entries are grouped by
 * the part of a tree they surface (leaves, bark) because their maps and layouts differ, not by any kind of tree.
 *
 * A leaf set is an atlas of several leaves. Its cells map leaf-local coordinates (s across, t along, base at t = 0) to the
 * atlas: uv = origin + t * along + s * across (UV origin bottom-left, v up). A leaf card carries its own blade coordinates
 * (TEXCOORD_0: u = 0.5 + across / blade length, v = along / blade length) and a pick in [0, 1) (`_LEAF`.x) that chooses
 * its cell; leafAtlasUv below is the mapping the viewport's shader runs, written once here so tests can check it.
 */

export const TREE_TEXTURE_SCHEMA = 'scratchbox.tree-textures/1';

/** Colour statistics of an entry's pixels (linear sRGB, Rec. 709 primaries, D65; CIELAB D65). */
export interface TreeTextureColour {
    meanLinearRgb: [number, number, number];
    spreadLinearRgb: [number, number, number];
    meanLab: [number, number, number];
    spreadLab: [number, number, number];
    meanLuminance: number;
}

/** One leaf of an atlas: the box it occupies, base to tip along `along`. */
export interface TreeLeafCell {
    origin: [number, number];
    along: [number, number];
    across: [number, number];
    lengthM: number;
    widthM: number;
    /** Share of the cell's box the leaf covers. */
    fill: number;
    /** Whether the leaf's stalk was found (its base is where the stalk meets the blade). */
    stalkSeen: boolean;
}

export interface TreeLeafTextureEntry {
    id: string;
    maps: { color: string; opacity: string; normal?: string; roughness?: string };
    pixels: [number, number];
    realSizeM: [number, number];
    colour: TreeTextureColour;
    /** bladeWidthM: the width of the leaf's flat parts (2 x area / outline; a needle spray's few millimetres, a leaf's
     *  centimetres), which the native choice matches to the species leaf's; absent on an index not yet measured. */
    leaf: { lengthM: number; widthM: number; lengthRangeM: [number, number]; aspect: number; fill: number; bladeWidthM?: number };
    /** Opaque share of the whole atlas. */
    coverage: number;
    atlas: { layout: string; cells: TreeLeafCell[] };
    appearance: string;
    provenance: 'library';
}

export interface TreeBarkTextureEntry {
    id: string;
    maps: { color: string; normal?: string; roughness?: string; ao?: string };
    pixels: [number, number];
    /** Real-world size: around the trunk (x), along it (y). */
    realSizeM: [number, number];
    colour: TreeTextureColour;
    bark: { displacementRange: number; normalSlopeMean: number; reliefIndex: number; furrowDepthM: number; ridgeSpacingM: number };
    appearance: string;
    provenance: 'library';
}

export interface TreeTextureIndex {
    schema: typeof TREE_TEXTURE_SCHEMA;
    about: string;
    conventions: Record<string, string>;
    leaves: TreeLeafTextureEntry[];
    bark: TreeBarkTextureEntry[];
}

/** The most leaf cells the viewport's shader reads for one atlas. */
export const MAX_LEAF_CELLS = 24;

/** How much wider than its own aspect a narrow leaf may be drawn to fill more of its card (1 keeps the atlas's aspect). */
export const DEFAULT_LEAF_STRETCH = 2;

/** How the viewport draws the library's surfaces (treeTextureMaterials.ts); the photo-match evaluator cuts leaves out by the same numbers. */
/** A factor per detail slot: near, near-mid, mid, far (crownSlotOf). */
export type LeafSlotFactors = [number, number, number, number];

export interface TreeTextureOptions {
    /** Variation of a leaf's colour around the tree's tint (0 none). */
    leafVariation: number;
    /** Strength of the sunlight seen through a leaf lit from behind. */
    translucency: number;
    /** Amplitude of the far masses' colour noise. */
    massNoise: number;
    /** How much wider than its atlas aspect a narrow leaf may be drawn (tree-texture-library.ts DEFAULT_LEAF_STRETCH). */
    leafStretch: number;
    /** How much a leaf's alpha is raised per mip level of the opacity map it samples (keeps distant leaves from eroding). */
    alphaMipScale: number;
    /** Longest side of a leaf atlas on the GPU (the library's files are 2K; 1K keeps a leaf a few hundred texels long). */
    leafAtlasPx: number;
    /**
     * Card zoom per detail slot: the leaf image drawn this many times larger on its card, about the card's centre (the card
     * crops it). A cut-out leaf covers only part of its card (its cell's fill, 0.6-0.7), and the coarser levels' cards are
     * larger and coarser (a kite at the mid level), so from the mid distances a textured crown read thinner than a clay
     * one of the same cards; zooming the leaf in fills more of each card there, where a single leaf's outline is a few
     * pixels. 1 draws the leaf as it is (the near level).
     */
    cardZoom: LeafSlotFactors;
    /** Alpha gain per detail slot: the leaf's alpha (after the mip lift) times this, so its soft rim stays in the cut at a distance. */
    alphaGain: LeafSlotFactors;
}

export const DEFAULT_TREE_TEXTURE_OPTIONS: Readonly<TreeTextureOptions> = Object.freeze({ leafVariation: 0.18, translucency: 0.45, massNoise: 0.16, leafStretch: DEFAULT_LEAF_STRETCH, alphaMipScale: 0.4, leafAtlasPx: 1024,
    cardZoom: [1, 1.15, 1.3, 1.3] as LeafSlotFactors, alphaGain: [1, 1.1, 1.25, 1.25] as LeafSlotFactors });

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const vec = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(finite);

/** Problems with an index (structure and value ranges); [] when it is usable. */
export function validateTreeTextureIndex(doc: unknown): string[] {
    const out: string[] = [];
    const d = doc as Partial<TreeTextureIndex> | undefined;
    if (!d || d.schema !== TREE_TEXTURE_SCHEMA) return [`schema is not ${TREE_TEXTURE_SCHEMA}`];
    if (!Array.isArray(d.leaves) || d.leaves.length === 0) out.push('leaves: at least one entry');
    if (!Array.isArray(d.bark) || d.bark.length === 0) out.push('bark: at least one entry');
    const ids = new Set<string>();
    const colourOk = (c: TreeTextureColour | undefined) => !!c && vec(c.meanLinearRgb, 3) && vec(c.spreadLinearRgb, 3) && vec(c.meanLab, 3) && vec(c.spreadLab, 3) && finite(c.meanLuminance)
        && c.meanLinearRgb.every(x => x >= 0 && x <= 1) && c.spreadLinearRgb.every(x => x >= 0);
    for (const e of d.leaves ?? []) {
        const at = `leaves.${e?.id}`;
        if (!e?.id || ids.has(e.id)) out.push(`${at}: missing or repeated id`);
        ids.add(e?.id);
        if (!e?.maps?.color || !e.maps.opacity) out.push(`${at}: needs color and opacity maps`);
        if (!colourOk(e?.colour)) out.push(`${at}.colour: bad statistics`);
        if (!(e?.leaf?.lengthM > 0) || !(e.leaf.widthM > 0)) out.push(`${at}.leaf: length and width must be positive`);
        if (e?.leaf?.bladeWidthM !== undefined && !(e.leaf.bladeWidthM > 0 && e.leaf.bladeWidthM <= e.leaf.widthM)) out.push(`${at}.leaf.bladeWidthM: must be positive and at most the leaf's width`);
        if (!(e?.coverage > 0 && e.coverage <= 1)) out.push(`${at}.coverage: must be in (0, 1]`);
        const cells = e?.atlas?.cells ?? [];
        if (cells.length === 0 || cells.length > MAX_LEAF_CELLS) out.push(`${at}.atlas: 1..${MAX_LEAF_CELLS} cells, has ${cells.length}`);
        cells.forEach((c, i) => {
            if (!vec(c.origin, 2) || !vec(c.along, 2) || !vec(c.across, 2)) { out.push(`${at}.atlas.cells[${i}]: origin, along and across are 2-vectors`); return; }
            // the cell's four corners lie in the atlas
            for (const [s, t] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
                const u = c.origin[0] + t * c.along[0] + s * c.across[0], v = c.origin[1] + t * c.along[1] + s * c.across[1];
                if (u < -0.01 || u > 1.01 || v < -0.01 || v > 1.01) { out.push(`${at}.atlas.cells[${i}]: corner (${s}, ${t}) at (${u.toFixed(3)}, ${v.toFixed(3)}) lies outside the atlas`); break; }
            }
            if (!(c.lengthM > 0 && c.widthM > 0)) out.push(`${at}.atlas.cells[${i}]: length and width must be positive`);
        });
        if (typeof e?.appearance !== 'string' || !e.appearance) out.push(`${at}.appearance: a description is required`);
        if (e?.provenance !== 'library') out.push(`${at}.provenance: must be "library"`);
    }
    for (const e of d.bark ?? []) {
        const at = `bark.${e?.id}`;
        if (!e?.id || ids.has(e.id)) out.push(`${at}: missing or repeated id`);
        ids.add(e?.id);
        if (!e?.maps?.color) out.push(`${at}: needs a color map`);
        if (!colourOk(e?.colour)) out.push(`${at}.colour: bad statistics`);
        if (!vec(e?.realSizeM, 2) || !(e.realSizeM[0] > 0 && e.realSizeM[1] > 0)) out.push(`${at}.realSizeM: two positive sizes`);
        const b = e?.bark;
        if (!b || !(b.reliefIndex >= 0) || !(b.furrowDepthM >= 0) || !(b.ridgeSpacingM > 0)) out.push(`${at}.bark: relief, furrow depth and ridge spacing`);
        if (typeof e?.appearance !== 'string' || !e.appearance) out.push(`${at}.appearance: a description is required`);
        if (e?.provenance !== 'library') out.push(`${at}.provenance: must be "library"`);
    }
    return out;
}

/** Every file an index names (relative to the index's folder). */
export function treeTextureFiles(index: TreeTextureIndex): string[] {
    const files: string[] = [];
    for (const e of index.leaves) files.push(...Object.values(e.maps).filter((f): f is string => typeof f === 'string'));
    for (const e of index.bark) files.push(...Object.values(e.maps).filter((f): f is string => typeof f === 'string'));
    return files;
}

/** Which cell of an atlas a card's pick (`_LEAF`.x in [0, 1)) shows. Mirrors the shader. */
export const leafCellIndex = (pick: number, cells: number): number => Math.min(cells - 1, Math.max(0, Math.floor(pick * cells)));

/**
 * How a leaf card's blade coordinates reach its cell (leafAtlasUv): the leaf keeps the atlas's aspect (a narrow leaf may be
 * drawn up to `stretch` times wider) as `drawn` (width over length), scaled down by `f` when it is wider than the card.
 * s = 0.5 + (u - 0.5) / (f drawn), t = v / f, then a card zoom about the cell's centre. Mirrors the shader.
 */
export function leafCardFit(cell: Pick<TreeLeafCell, 'lengthM' | 'widthM'>, cardWidthRatio: number, stretch = DEFAULT_LEAF_STRETCH): { drawn: number; f: number } {
    const r = cell.widthM / cell.lengthM;
    const drawn = Math.min(Math.max(r, cardWidthRatio), r * stretch);
    return { drawn, f: Math.min(1, cardWidthRatio / drawn) };
}

/**
 * A leaf card's atlas coordinates. `cardUv` is the card's TEXCOORD_0 (u = 0.5 + across / blade length, v = along / blade
 * length), `cardWidthRatio` its outline's width over its length (the trees GLB's clusterLibrary.leafCard.widthRatio).
 * The leaf keeps the atlas's aspect (a narrow leaf may be drawn up to `stretch` times wider), scaled down when it is wider
 * than the card, base at the card's base; `zoom` (TreeTextureOptions.cardZoom of the level) draws it larger about the cell's
 * centre. `inside` is false where the card shows no part of the leaf's cell (the shader makes it transparent). Mirrors the
 * shader in treeTextureMaterials.ts.
 */
export function leafAtlasUv(cardUv: [number, number], cell: Pick<TreeLeafCell, 'origin' | 'along' | 'across' | 'lengthM' | 'widthM'>, cardWidthRatio: number, stretch = DEFAULT_LEAF_STRETCH, zoom = 1): { uv: [number, number]; st: [number, number]; inside: boolean } {
    const { drawn, f } = leafCardFit(cell, cardWidthRatio, stretch);
    const t = 0.5 + (cardUv[1] / f - 0.5) / zoom;
    const s = 0.5 + (cardUv[0] - 0.5) / (f * drawn * zoom);
    return {
        uv: [cell.origin[0] + t * cell.along[0] + s * cell.across[0], cell.origin[1] + t * cell.along[1] + s * cell.across[1]],
        st: [s, t],
        inside: s >= 0 && s <= 1 && t >= 0 && t <= 1
    };
}
