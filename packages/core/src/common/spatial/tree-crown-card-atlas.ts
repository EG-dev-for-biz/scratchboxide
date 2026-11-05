/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The crown-card atlas bake (scratchbox_tree_lod.hpp placeCrownCards writes the layout, the GLB's `sbTrees.crownCards`), with
 * no renderer attached: the viewport (browser/.../treeLod/treeCrownCards.ts, treeTextureMaterials.ts) uploads it as a texture
 * and the photo-match evaluator's software renderer (node/.../staged-location/tree-lod-view.ts) samples its alpha, so both
 * cut a card out by the same pixels.
 */

import type { TreeCrownCardsExtras, TreesGlbRootExtras } from './staged-location-contracts';
import { MAX_LEAF_CELLS, leafCellIndex, type TreeLeafTextureEntry } from './tree-texture-library';

/** Atlas side (px) a 2 x 2 card atlas is baked at (cells of ATLAS_PX / cols across). */
export const CROWN_CARD_ATLAS_PX = 512;
/** A cell's side (px) in a baked atlas. */
export const CROWN_CARD_CELL_PX = 256;
/** Atlas side (px) a layout's cards are baked at: every cell CROWN_CARD_CELL_PX on its longer side, whatever the grid. */
export const crownCardAtlasPx = (cards: Pick<TreeCrownCardsExtras, 'cols' | 'rows'>): number => CROWN_CARD_CELL_PX * Math.max(1, cards.cols, cards.rows);
/** How much a card's alpha rises per mip level of its mask (as the leaves' alphaMipScale), so a distant card does not erode. */
export const CROWN_CARD_MIP_SCALE = 0.4;

/** The crown cards of a trees GLB's root extras, or undefined when it has none (an older file, or no tree has cards). */
export function crownCardsOf(root: TreesGlbRootExtras | undefined): TreeCrownCardsExtras | undefined {
    const c = root?.crownCards;
    return c && Array.isArray(c.meshes) && c.meshes.length > 0 && Array.isArray(c.cells) && c.cols > 0 && c.rows > 0 ? c : undefined;
}

/** One leaf of a card, as a painter draws it: its box's length scale (x the leaf's length) and aspect, and its colour at a point of the box. */
export interface CrownCardLeafPaint {
    lengthScale: number;
    aspect: number;
    /** RGBA (0-255) at (`along` base to tip, `across`) in [0, 1]^2 of the leaf's box, or null where the leaf is not. */
    sample(along: number, across: number): [number, number, number, number] | null;
}

/**
 * Bakes the card atlas: `px` x `px` RGBA, row 0 at v = 0 (a DataTexture's first row, as the GLB's TEXCOORD_0 reads it), each
 * cell's leaves drawn in the listed order over transparent black, alpha composited ("over").
 */
export function bakeCrownCardAtlas(cards: TreeCrownCardsExtras, px: number, paint: (leaf: readonly number[], cell: number) => CrownCardLeafPaint): Uint8Array {
    const out = new Uint8Array(px * px * 4);
    const cw = px / cards.cols, ch = px / cards.rows;
    cards.cells.forEach((leaves, cell) => {
        const col = cell % cards.cols, row = Math.floor(cell / cards.cols);
        if (row >= cards.rows) return;
        const x0 = Math.round(col * cw), x1 = Math.round((col + 1) * cw), y0 = Math.round(row * ch), y1 = Math.round((row + 1) * ch);
        for (const leaf of leaves) {
            const [u, v, angle, length] = leaf;
            const p = paint(leaf, cell);
            const L = length * p.lengthScale, W = L * p.aspect;
            if (!(L > 0 && W > 0)) continue;
            const ca = Math.cos(angle), sa = Math.sin(angle);
            const ext = 0.5 * Math.hypot(L, W);
            const i0 = Math.max(x0, Math.floor(x0 + (u - ext) * cw)), i1 = Math.min(x1 - 1, Math.ceil(x0 + (u + ext) * cw));
            const j0 = Math.max(y0, Math.floor(y0 + (v - ext) * ch)), j1 = Math.min(y1 - 1, Math.ceil(y0 + (v + ext) * ch));
            for (let j = j0; j <= j1; j++) {
                const dt = (j + 0.5 - y0) / ch - v;
                for (let i = i0; i <= i1; i++) {
                    const ds = (i + 0.5 - x0) / cw - u;
                    const along = (ds * ca + dt * sa) / L + 0.5, across = (-ds * sa + dt * ca) / W + 0.5;
                    if (along < 0 || along > 1 || across < 0 || across > 1) continue;
                    const c = p.sample(along, across);
                    if (!c || c[3] <= 0) continue;
                    const o = (j * px + i) * 4, a = c[3] / 255, da = out[o + 3] / 255;
                    const outA = a + da * (1 - a);
                    for (let k = 0; k < 3; k++) out[o + k] = Math.round((c[k] * a + out[o + k] * da * (1 - a)) / Math.max(outA, 1e-6));
                    out[o + 3] = Math.round(outA * 255);
                }
            }
        }
        // the cell's empty pixels take its leaves' mean colour, so the mips (which average colour and alpha apart) do not
        // darken the leaves' rims toward the empty pixels' black
        const sum = [0, 0, 0];
        let n = 0;
        for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
            const o = (j * px + i) * 4;
            if (out[o + 3] >= 128) { sum[0] += out[o]; sum[1] += out[o + 1]; sum[2] += out[o + 2]; n++; }
        }
        if (n) for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) {
            const o = (j * px + i) * 4;
            if (out[o + 3] === 0) { out[o] = Math.round(sum[0] / n); out[o + 1] = Math.round(sum[1] / n); out[o + 2] = Math.round(sum[2] / n); }
        }
    });
    return out;
}

/** The clay painter: each leaf a white ellipse `clayLeafAspect` wide. */
export const clayLeafPaint = (cards: TreeCrownCardsExtras) => (): CrownCardLeafPaint => ({
    lengthScale: 1, aspect: cards.clayLeafAspect,
    sample: (a, b) => ((2 * a - 1) ** 2 + (2 * b - 1) ** 2 <= 1 ? [255, 255, 255, 255] : null)
});

/**
 * The clay cut-out as a mask texture's pixels: the bake's alpha copied into R, G and B as well. three.js reads an alphaMap's
 * green channel, and the bake fills a cell's empty pixels with its leaves' colour (white for clay), so the bake itself used
 * as an alphaMap would be opaque over the whole card.
 */
export function crownCardMaskPixels(cards: TreeCrownCardsExtras, px: number = crownCardAtlasPx(cards)): Uint8Array {
    const out = bakeCrownCardAtlas(cards, px, clayLeafPaint(cards));
    for (let i = 0; i < out.length; i += 4) out[i] = out[i + 1] = out[i + 2] = out[i + 3];
    return out;
}

/** A loaded atlas's pixels: RGBA rows from v = 0 (bottom) up. */
export interface AtlasPixels { data: Uint8Array; width: number; height: number }

/**
 * The crown cards' painter for a leaf set: each leaf of the layout drawn as the atlas cell its pick chooses, along the
 * leaf's axis with the cell's aspect, scaled so the cell's fill covers the clay ellipse's area (what the writer measured),
 * its colour varied a little per leaf.
 */
export function texturedLeafPaint(e: TreeLeafTextureEntry, px: AtlasPixels, clayLeafAspect: number): (leaf: readonly number[]) => CrownCardLeafPaint {
    const cells = e.atlas.cells.slice(0, MAX_LEAF_CELLS);
    return leaf => {
        const pick = leaf[4] ?? 0;
        const c = cells[leafCellIndex(pick, cells.length)];
        const aspect = Math.max(0.05, c.widthM / c.lengthM);
        const k = Math.min(1.8, Math.max(0.6, Math.sqrt((Math.PI / 4) * clayLeafAspect / (Math.max(0.2, c.fill) * aspect))));
        const shade = 0.85 + 0.3 * ((pick * 7.31 + 0.13) % 1);
        return {
            lengthScale: k, aspect,
            sample: (a, b) => {
                const u = c.origin[0] + a * c.along[0] + b * c.across[0], v = c.origin[1] + a * c.along[1] + b * c.across[1];
                const x = Math.min(px.width - 1, Math.max(0, Math.floor(u * px.width))), y = Math.min(px.height - 1, Math.max(0, Math.floor(v * px.height)));
                const i = (y * px.width + x) * 4, alpha = px.data[i + 3];
                if (alpha < 8) return null;
                return [Math.min(255, px.data[i] * shade), Math.min(255, px.data[i + 1] * shade), Math.min(255, px.data[i + 2] * shade), alpha];
            }
        };
    };
}
