/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


import * as THREE from 'three';
import type { TreeCrownCardsExtras, TreesGlbRootExtras } from '../../../../../common/spatial/staged-location-contracts';
import { CLAY_SURFACE } from '../clayRenderMode';

/**
 * Crown cards: a tree's mid level drawn as a few large cards over its crown (scratchbox_tree_lod.hpp placeCrownCards), in
 * place of the mid leaf clusters. A card is one quad of a library mesh (`crownCards.meshes[k]`) whose TEXCOORD_0 spans cell
 * k of a card atlas; the trees GLB lists each cell's leaves (`crownCards.cells`: centre, axis, length, pick), and the viewer
 * bakes the atlas from that list here, so the cut-out drawn is the one the writer measured:
 *
 * - clay and the shadow pass: each leaf a plain ellipse (`clayLeafAspect` wide), white in a mask the clay card material
 *   reads as its alphaMap (one grey: the clay surface's colour, roughness and metalness, only cut out);
 * - textured (treeTextureMaterials.ts): each leaf the chosen leaf set's image for its pick, at the clay ellipse's area.
 *
 * Cards cut out with a plain alpha test, not alpha to coverage: a card's lifted mip alpha sits between the cutoff and 1 over
 * much of the card, and alpha to coverage writes that alpha into the frame, where the page shows through as bright specks.
 *
 * A card mesh is a leaf mesh of the mid level: the controller gives it the crown attributes and the crown and dither
 * variants as for any leaf cluster (they are clones, so the cut-out carries over), and the shadow map copies the material's
 * alphaMap / map and alpha test into the depth pass, so cards cast the leaves' shadow, not a square.
 */

/** Atlas side (px) the cards are baked at (cells of ATLAS_PX / cols across). */
export const CROWN_CARD_ATLAS_PX = 512;
/**
 * Defined at the top of every card material's shaders (by its onBeforeCompile, which its crown and dither clones chain; a
 * material's `defines` would not survive MeshStandardMaterial.copy): the crown shading treats the card as open foliage.
 */
export const CROWN_CARD_DEFINE = 'SB_CROWN_CARD';
/** Marks a card material's shader source (vertex and fragment) with CROWN_CARD_DEFINE. */
export function markCrownCardShader(shader: { vertexShader: string; fragmentShader: string }): void {
    const d = `#define ${CROWN_CARD_DEFINE}\n`;
    if (!shader.vertexShader.startsWith(d)) shader.vertexShader = d + shader.vertexShader;
    if (!shader.fragmentShader.startsWith(d)) shader.fragmentShader = d + shader.fragmentShader;
}
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

/** A baked atlas as a mipmapped, clamped DataTexture (sRGB for colour). */
export function crownCardTexture(data: Uint8Array, px: number, colour: boolean): THREE.DataTexture {
    const t = new THREE.DataTexture(data, px, px, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.colorSpace = colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.needsUpdate = true;
    return t;
}

const keyOf = (cards: TreeCrownCardsExtras): string => JSON.stringify([cards.cols, cards.rows, cards.clayLeafAspect, cards.cells]);
const masks = new Map<string, THREE.DataTexture>();

/** The clay mask of a card atlas (one per distinct layout, shared by every tree and scene). */
export function crownCardMask(cards: TreeCrownCardsExtras): THREE.DataTexture {
    const key = keyOf(cards);
    let t = masks.get(key);
    if (!t) masks.set(key, t = crownCardTexture(bakeCrownCardAtlas(cards, CROWN_CARD_ATLAS_PX, clayLeafPaint(cards)), CROWN_CARD_ATLAS_PX, false));
    return t;
}

/**
 * After alphamap_fragment (and map_fragment's alpha): a card seen small samples a coarse mip of its cut-out, whose averaged
 * leaves fall under the cutoff; the alpha rises with the mip level read (uSbCardMipScale a level), as the leaves' does.
 */
export const CARD_ALPHA_MIP = `
{
#if defined( USE_ALPHAMAP )
    vec2 sbCardTexels = fwidth( vAlphaMapUv ) * vec2( textureSize( alphaMap, 0 ) );
#elif defined( USE_MAP )
    vec2 sbCardTexels = fwidth( vMapUv ) * vec2( textureSize( map, 0 ) );
#else
    vec2 sbCardTexels = vec2( 1.0 );
#endif
    float sbCardMip = max( 0.0, log2( max( max( sbCardTexels.x, sbCardTexels.y ), 1e-6 ) ) );
    diffuseColor.a = min( 1.0, diffuseColor.a * ( 1.0 + sbCardMip * uSbCardMipScale ) );
}
`;

const cardUniforms = { uSbCardMipScale: { value: CROWN_CARD_MIP_SCALE } };

/** Adds the card cut-out's mip lift to a material's shader (chained after its own onBeforeCompile). */
function withCardAlpha<T extends THREE.Material>(mat: T, base: THREE.Material | null, key: string): T {
    const baseKey = base?.customProgramCacheKey?.call(base) ?? '';
    mat.customProgramCacheKey = () => `${baseKey}|${key}`;
    mat.onBeforeCompile = (shader, renderer) => {
        base?.onBeforeCompile?.call(base, shader, renderer);
        Object.assign(shader.uniforms, cardUniforms);
        markCrownCardShader(shader);
        const anchor = '#include <alphamap_fragment>';
        if (!shader.fragmentShader.includes(anchor)) throw new Error('treeCrownCards: the card material has no alphamap_fragment chunk');
        shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uSbCardMipScale;').replace(anchor, `${anchor}\n${CARD_ALPHA_MIP}`);
    };
    return mat;
}

const clayCards = new Map<string, THREE.MeshStandardMaterial>();

/**
 * The clay a card mesh wears in clay mode: the trees' clay surface (the same grey, roughness and metalness as the shared tree
 * clay, so wood and leaves stay one grey), cut out by the card atlas's mask.
 */
export function crownCardClayMaterial(cards: TreeCrownCardsExtras): THREE.MeshStandardMaterial {
    const key = keyOf(cards);
    let m = clayCards.get(key);
    if (!m) {
        m = new THREE.MeshStandardMaterial({ ...CLAY_SURFACE, alphaMap: crownCardMask(cards), alphaTest: 0.5, alphaToCoverage: false, side: THREE.DoubleSide });
        m.name = 'sb-tree-crown-card-clay';
        m.userData = { sbClay: true, sbCrownCardClay: true };
        withCardAlpha(m, null, 'sbCardClay/1');
        clayCards.set(key, m);
    }
    return m;
}

const masked = new WeakMap<THREE.Material, Map<string, THREE.Material>>();

/**
 * A card mesh's loader material (or any base without a cut-out) cut out by the card atlas's mask, so a card never draws as a
 * square before its textured surface (or clay) is on it.
 */
export function crownCardMaskedMaterial(base: THREE.Material, cards: TreeCrownCardsExtras): THREE.Material {
    const b = base as THREE.MeshStandardMaterial;
    if (b.alphaMap || (b.map && b.alphaTest > 0)) return base;
    let per = masked.get(base);
    if (!per) masked.set(base, per = new Map());
    const key = keyOf(cards);
    let m = per.get(key);
    if (!m) {
        const c = base.clone() as THREE.MeshStandardMaterial;
        c.alphaMap = crownCardMask(cards);
        c.alphaTest = 0.5;
        c.alphaToCoverage = false;
        c.side = THREE.DoubleSide;
        c.userData = { ...base.userData, sbCrownCardMasked: true };
        m = withCardAlpha(c, base, 'sbCardMasked/1');
        per.set(key, m);
    }
    return m;
}
