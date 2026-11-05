/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


import * as THREE from 'three';
import type { TreeCrownCardsExtras } from '../../../../../common/spatial/staged-location-contracts';
import { CROWN_CARD_MIP_SCALE, crownCardAtlasPx, crownCardMaskPixels } from '../../../../../common/spatial/tree-crown-card-atlas';
import { CLAY_SURFACE } from '../clayRenderMode';

// the bake itself lives in common (the photo-match evaluator's software renderer samples the same cut-out)
export { CROWN_CARD_ATLAS_PX, CROWN_CARD_MIP_SCALE, crownCardAtlasPx, bakeCrownCardAtlas, clayLeafPaint, crownCardMaskPixels, crownCardsOf, type CrownCardLeafPaint } from '../../../../../common/spatial/tree-crown-card-atlas';

/**
 * Crown cards: a tree's mid level drawn as a few large cards over its crown (scratchbox_tree_lod.hpp placeCrownCards), in
 * place of the mid leaf clusters; its near-mid level as smaller cards of open leaf sprays (placeNearMidCards), in place of
 * the near-mid clusters; and core cards beneath the near level's leaves (placeCoreCards: the dense inner foliage, which
 * the textured pass shades, treeTextureMaterials.ts coreCardShade). A card is one quad of a library mesh (`crownCards.meshes[k]`) whose TEXCOORD_0 spans cell
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
 * A card mesh is a leaf mesh of its level: the controller gives it the crown attributes and the crown and dither
 * variants as for any leaf cluster (they are clones, so the cut-out carries over), and the shadow map copies the material's
 * alphaMap / map and alpha test into the depth pass, so cards cast the leaves' shadow, not a square.
 */

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

/** The clay mask of a card atlas (one per distinct layout, shared by every tree and scene): the cut-out in every channel (an alphaMap reads green). */
export function crownCardMask(cards: TreeCrownCardsExtras): THREE.DataTexture {
    const key = keyOf(cards);
    let t = masks.get(key);
    if (!t) { const px = crownCardAtlasPx(cards); masks.set(key, t = crownCardTexture(crownCardMaskPixels(cards, px), px, false)); }
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
