/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


import * as THREE from 'three';
import type { TreeCrownCardsExtras, TreeLodExtras, TreeNodeExtras, TreesGlbRootExtras } from '../../../../../common/spatial/staged-location-contracts';
import {
    DEFAULT_TREE_TEXTURE_OPTIONS, MAX_LEAF_CELLS, leafSolidity, validateTreeTextureIndex, type TreeBarkTextureEntry, type TreeLeafTextureEntry, type TreeTextureIndex, type TreeTextureOptions
} from '../../../../../common/spatial/tree-texture-library';
import { texturedLeafPaint, type AtlasPixels } from '../../../../../common/spatial/tree-crown-card-atlas';
import { setTreeLodTexturedMaterial } from '../clayRenderMode';
import { setPerMeshAttribute } from './treeCrownShading';
import { crownSlotOf } from './treeLodMath';
import { CROWN_CARD_ATLAS_PX, CROWN_CARD_MIP_SCALE, bakeCrownCardAtlas, clayLeafPaint, crownCardTexture, crownCardsOf, markCrownCardShader } from './treeCrownCards';

// shared with the photo-match evaluator's software renderer (common): the options' defaults, the card painter, the atlas pixels
export { DEFAULT_TREE_TEXTURE_OPTIONS, type LeafSlotFactors, type TreeTextureOptions } from '../../../../../common/spatial/tree-texture-library';
export { texturedLeafPaint, type AtlasPixels } from '../../../../../common/spatial/tree-crown-card-atlas';

/**
 * Textured mode for the staged trees: the surfaces of the tree texture library (assets/textures/trees, index.json) on the
 * trees whose extras name their choice (sbTree.texture, chosen by appearance in the native trees writer). Clay mode is
 * untouched: these materials are what a tree mesh wears outside clay (clayRenderMode keeps the shared tree clay there).
 *
 * - Leaf cards (the instanced clusters of the near, near-mid and mid levels): the chosen leaf set's colour (its opacity packed
 *   into the alpha, one texture) and normal map, at most leafAtlasPx on the GPU. A card carries its blade coordinates (TEXCOORD_0) and a pick (`_LEAF`.x) that chooses one leaf cell
 *   of the atlas; the vertex stage maps it there (leafAtlasUv in tree-texture-library.ts, the same mapping), and the
 *   fragment stage cuts the leaf out with alpha to coverage. The colour is tinted to the tree's measured crown colour (a
 *   per-mesh attribute, the tint the writer chose) with a small variation per leaf and per cluster, and a cheap backlight
 *   term lets sunlight through thin leaves seen against it. Stalks and sub-shoots are opaque and tinted.
 * - Crown cards (the mid level's cut-out cards, treeCrownCards.ts): a card atlas baked from the chosen leaf set's cells by
 *   the GLB's card layout (each leaf its pick's image, at the clay leaf's area), tinted like the leaves, varied per card,
 *   with the leaves' sunlight-through term; the clay mask stands in until the leaf atlas has loaded.
 * - The far level's leaf masses: the measured crown colour (the writer's massColourLinear) with gentle noise.
 * - Wood and twigs: the chosen bark's maps, in UVs the writer laid out in the bark's real-world tiles, tinted lightly.
 *
 * Textures load once per library and every tree of every scene shares them; one material per library entry, so a tree's
 * tint is data (a per-mesh attribute on the mesh's own light geometry), never a new texture or material. The crown shading
 * (treeCrownShading.ts) and the level dissolve (treeLodFade.ts) clone these materials and chain their shader code, so leaves
 * keep the crown's soft volume and dither between levels as before.
 */

export const TREE_TEXTURE_BASE_URL = '/assets/textures/trees/';

/** Per-mesh attribute: rgb a multiplier of the surface's linear colour (a tint, or the masses' colour); w the leaf cards' width ratio (leaves). */
export const TREE_TINT_ATTRIBUTE = 'sbTreeTint';
/** Per-mesh attribute of a leaf mesh: x the card zoom, y the alpha gain of its level's detail slot (TreeTextureOptions). */
export const TREE_CARD_ATTRIBUTE = 'sbTreeCard';

/**
 * Hashed alpha (Wyman and McGuire, 2017): a threshold per cell of the surface's own space at the pixel's scale (two
 * scales blended, the blend's distribution made uniform again), so a partly covered texel draws that share of its pixels
 * in a pattern that holds still as the view moves, with or without multisampling. `p` is a position in the surface's
 * space (here the mesh position plus its instance's offset).
 */
export const HASHED_ALPHA_FUNCTIONS = `
float sbHash2( vec2 p ) { return fract( 1.0e4 * sin( 17.0 * p.x + 0.1 * p.y ) * ( 0.1 + abs( sin( 13.0 * p.y + p.x ) ) ) ); }
float sbHash3( vec3 p ) { return sbHash2( vec2( sbHash2( p.xy ), p.z ) ); }
float sbHashedThreshold( vec3 p ) {
    float sbScale = 1.0 / max( max( length( dFdx( p ) ), length( dFdy( p ) ) ), 1e-6 );
    float sbL = log2( sbScale );
    vec2 sbS = vec2( exp2( floor( sbL ) ), exp2( ceil( sbL ) ) );
    float sbF = fract( sbL );
    float sbX = mix( sbHash3( floor( sbS.x * p ) ), sbHash3( floor( sbS.y * p ) ), sbF );
    float sbA = max( min( sbF, 1.0 - sbF ), 1e-4 );
    vec3 sbC = vec3( sbX * sbX / ( 2.0 * sbA * ( 1.0 - sbA ) ), ( sbX - 0.5 * sbA ) / ( 1.0 - sbA ), 1.0 - ( 1.0 - sbX ) * ( 1.0 - sbX ) / ( 2.0 * sbA * ( 1.0 - sbA ) ) );
    float sbT = sbX < 1.0 - sbA ? ( sbX < sbA ? sbC.x : sbC.y ) : sbC.z;
    return clamp( sbT, 1e-4, 1.0 );
}
`;

export const LEAF_VERTEX_PARS = `
attribute vec2 _leaf;
attribute vec4 ${TREE_TINT_ATTRIBUTE};
attribute vec4 ${TREE_CARD_ATTRIBUTE};
uniform vec4 uSbCellA[ ${MAX_LEAF_CELLS} ];
uniform vec4 uSbCellB[ ${MAX_LEAF_CELLS} ];
uniform float uSbCellCount;
uniform float uSbLeafStretch;
uniform float uSbLeafVariation;
varying vec2 vSbST;
varying float vSbBlade;
varying vec3 vSbTint;
varying float vSbAlphaGain;
varying vec3 vSbHashPos;
`;

/** After uv_vertex: the card's blade coordinates into its leaf cell (mirrors leafAtlasUv), and the leaf's tint. */
export const LEAF_VERTEX_MAIN = `
{
    int sbI = int( clamp( floor( _leaf.x * uSbCellCount ), 0.0, uSbCellCount - 1.0 ) );
    vec4 sbA = uSbCellA[ sbI ];
    vec4 sbB = uSbCellB[ sbI ];
    float sbR = sbB.z;
    float sbCard = ${TREE_TINT_ATTRIBUTE}.w;
    float sbDrawn = min( max( sbR, sbCard ), sbR * uSbLeafStretch );
    float sbF = min( 1.0, sbCard / sbDrawn );
    float sbT = uv.y / sbF;
    float sbS = 0.5 + ( uv.x - 0.5 ) / ( sbF * sbDrawn );
    // the level's card zoom, about the card's centre (a mesh without the attribute reads 0: no zoom, no gain)
    float sbZoom = ${TREE_CARD_ATTRIBUTE}.x > 0.0 ? ${TREE_CARD_ATTRIBUTE}.x : 1.0;
    sbS = 0.5 + ( sbS - 0.5 ) / sbZoom;
    sbT = 0.5 + ( sbT - 0.5 ) / sbZoom;
    vSbAlphaGain = ${TREE_CARD_ATTRIBUTE}.y > 0.0 ? ${TREE_CARD_ATTRIBUTE}.y : 1.0;
    vSbST = vec2( sbS, sbT );
    vec2 sbUv = sbA.xy + sbT * sbA.zw + sbS * sbB.xy;
#ifdef USE_MAP
    vMapUv = sbUv;
#endif
#ifdef USE_ALPHAMAP
    vAlphaMapUv = sbUv;
#endif
#ifdef USE_NORMALMAP
    vNormalMapUv = sbUv;
#endif
#ifdef USE_ROUGHNESSMAP
    vRoughnessMapUv = sbUv;
#endif
    vSbBlade = _leaf.y;
    // a leaf's own variation (its pick), and its cluster's (the instance's place)
    float sbJ = fract( _leaf.x * 7.31 + 0.13 );
#ifdef USE_INSTANCING
    sbJ = fract( sbJ + fract( sin( dot( floor( instanceMatrix[ 3 ].xyz * 64.0 ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ) );
#endif
    float sbK = fract( sbJ * 3.71 + 0.29 );
    vec3 sbVar = vec3( 1.0 + uSbLeafVariation * ( sbJ - 0.5 ) * ( 1.0 + 0.4 * ( sbK - 0.5 ) ),
                       1.0 + uSbLeafVariation * ( sbJ - 0.5 ),
                       1.0 + uSbLeafVariation * ( sbJ - 0.5 ) * ( 1.0 - 0.6 * ( sbK - 0.5 ) ) );
    vSbTint = ${TREE_TINT_ATTRIBUTE}.rgb * sbVar;
    // the hashed cut-out's own space: the leaf's place in its cluster, offset per instance
    vSbHashPos = position;
#ifdef USE_INSTANCING
    vSbHashPos += instanceMatrix[ 3 ].xyz;
#endif
}
`;

export const LEAF_FRAGMENT_PARS = `
uniform vec3 uSbStem;
uniform float uSbTranslucency;
uniform float uSbMipScale;
uniform float uSbSolidity;
varying vec2 vSbST;
varying float vSbBlade;
varying vec3 vSbTint;
varying float vSbAlphaGain;
varying vec3 vSbHashPos;
${HASHED_ALPHA_FUNCTIONS}
`;

/** After map_fragment: stalks take the stalk colour; everything takes the tree's tint. */
export const LEAF_FRAGMENT_COLOR = `
if ( vSbBlade < 0.5 ) diffuseColor.rgb = uSbStem;
diffuseColor.rgb *= vSbTint;
`;

/**
 * After alphamap_fragment: stalks are opaque; outside the leaf's cell the card shows nothing. A leaf seen small samples a
 * coarse mip of the opacity map, whose averaged edges fall under the cutoff and would erode a blade away; the alpha is
 * raised with the mip level the sample reads (uSbMipScale per level, times the set's solidity, leafSolidity), so a distant
 * blade keeps its coverage, and by its level's alpha gain (vSbAlphaGain). The porous share (1 - solidity: a needle
 * spray, whose averaged alpha is its true cover) is cut at a hashed threshold, so it draws that share of its pixels
 * instead of a solid flake.
 */
export const LEAF_FRAGMENT_ALPHA = `
#ifdef USE_MAP
{
    vec2 sbTexels = fwidth( vMapUv ) * vec2( textureSize( map, 0 ) );
    float sbMip = max( 0.0, log2( max( max( sbTexels.x, sbTexels.y ), 1e-6 ) ) );
    diffuseColor.a *= ( 1.0 + sbMip * uSbMipScale * uSbSolidity ) * vSbAlphaGain;
}
#endif
{
    float sbHashed = diffuseColor.a >= sbHashedThreshold( vSbHashPos ) ? 1.0 : 0.0;
    diffuseColor.a = mix( sbHashed, diffuseColor.a, uSbSolidity );
}
if ( vSbBlade < 0.5 ) diffuseColor.a = 1.0;
else if ( vSbST.x < 0.0 || vSbST.x > 1.0 || vSbST.y < 0.0 || vSbST.y > 1.0 ) diffuseColor.a = 0.0;
`;

/**
 * The sun the leaves are lit through: the sky's sun (a SunLight, sunShadowCascades.ts), else the first directional light.
 * Defines SB_SUN_DIR and SB_SUN_COLOR where there is one.
 */
const SUN_FOR_TRANSLUCENCY = `
#if NUM_SUN_LIGHTS > 0
#define SB_SUN_DIR sunLights[ 0 ].direction
#define SB_SUN_COLOR sunLights[ 0 ].color
#elif NUM_DIR_LIGHTS > 0
#define SB_SUN_DIR directionalLights[ 0 ].direction
#define SB_SUN_COLOR directionalLights[ 0 ].color
#endif
`;

/** After lights_fragment_end: sunlight arriving from behind the leaf (as seen) passes through it, coloured by the leaf. */
export const LEAF_FRAGMENT_TRANSLUCENCY = `${SUN_FOR_TRANSLUCENCY}
#ifdef SB_SUN_DIR
{
    float sbBack = max( 0.0, dot( - normal, SB_SUN_DIR ) );
    reflectedLight.directDiffuse += diffuseColor.rgb * SB_SUN_COLOR * ( sbBack * uSbTranslucency * vSbBlade );
}
#undef SB_SUN_DIR
#undef SB_SUN_COLOR
#endif
`;

export const TINT_VERTEX_PARS = `
attribute vec4 ${TREE_TINT_ATTRIBUTE};
varying vec3 vSbTint;
varying vec3 vSbPos;
`;
export const TINT_VERTEX_MAIN = `
vSbTint = ${TREE_TINT_ATTRIBUTE}.rgb;
vSbPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;
export const TINT_FRAGMENT_PARS = `
uniform float uSbNoise;
varying vec3 vSbTint;
varying vec3 vSbPos;
float sbHash( vec3 p ) { return fract( sin( dot( p, vec3( 127.1, 311.7, 74.7 ) ) ) * 43758.5453 ); }
float sbValueNoise( vec3 p ) {
    vec3 i = floor( p ), f = fract( p );
    f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( mix( sbHash( i ), sbHash( i + vec3( 1, 0, 0 ) ), f.x ), mix( sbHash( i + vec3( 0, 1, 0 ) ), sbHash( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
                mix( mix( sbHash( i + vec3( 0, 0, 1 ) ), sbHash( i + vec3( 1, 0, 1 ) ), f.x ), mix( sbHash( i + vec3( 0, 1, 1 ) ), sbHash( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
`;
/** After map_fragment: the tint, with gentle world-space noise where uSbNoise > 0 (the far masses). */
export const TINT_FRAGMENT_COLOR = `
diffuseColor.rgb *= vSbTint;
if ( uSbNoise > 0.0 ) {
    float sbN = 0.65 * sbValueNoise( vSbPos * 1.3 ) + 0.35 * sbValueNoise( vSbPos * 3.7 );
    diffuseColor.rgb *= 1.0 + uSbNoise * ( sbN - 0.5 ) * 2.0;
}
`;

const replaceOrThrow = (src: string, find: string, add: string, what: string): string => {
    if (!src.includes(find)) throw new Error(`treeTextureMaterials: the ${what} shader has no ${find} to extend`);
    return src.replace(find, `${find}\n${add}`);
};

/**
 * What the library asks a loader for: one texture from `url`, or several maps packed into one texture so a leaf set or
 * a bark costs fewer GPU textures: `alphaUrl` (a leaf's opacity into the alpha of its colour), `aoUrl` (a bark's ambient
 * occlusion into R beside its roughness in G, three's ORM layout). `maxPx`: the longest side uploaded.
 */
export interface TextureRequest {
    url: string; colour: boolean; alphaUrl?: string; aoUrl?: string; maxPx?: number;
    /** Called once a packed texture's pixels are in (RGBA, row 0 at v = 0), e.g. to bake the crown cards from a leaf atlas. */
    onReady?: (pixels: AtlasPixels) => void;
}
export type TextureLoad = (req: TextureRequest) => THREE.Texture;

const loadImage = (url: string): Promise<HTMLImageElement> => new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`tree texture ${url} did not load`));
    img.src = url;
});

/** An image's pixels at `w` x `h` (rows top to bottom), through a canvas (opaque images only: no premultiplication loss). */
function pixelsOf(img: HTMLImageElement, w: number, h: number): Uint8ClampedArray {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(img, 0, 0, w, h);
    return g.getImageData(0, 0, w, h).data;
}

/** Loads a texture for the trees: repeat-wrapped, mipmapped, anisotropic, sRGB for colour; packed maps as a DataTexture. */
export const defaultTextureLoad: TextureLoad = (() => {
    const loader = new THREE.TextureLoader();
    return (req: TextureRequest) => {
        const finish = (t: THREE.Texture) => {
            t.wrapS = t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = 8;
            t.colorSpace = req.colour ? THREE.SRGBColorSpace : THREE.NoColorSpace;
            return t;
        };
        if (!req.alphaUrl && !req.aoUrl) return finish(loader.load(req.url));
        // packed: an empty texture now, filled when both images have loaded (rows flipped so v = 0 is the image's bottom,
        // as a flipY image texture has it; a DataTexture is never premultiplied, so a cut leaf's colour stays under its alpha)
        const tex = finish(new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat));
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.generateMipmaps = true;
        Promise.all([loadImage(req.url), loadImage((req.alphaUrl ?? req.aoUrl)!)]).then(([a, b]) => {
            const scale = Math.min(1, (req.maxPx ?? Infinity) / Math.max(a.naturalWidth, a.naturalHeight));
            const w = Math.max(1, Math.round(a.naturalWidth * scale)), h = Math.max(1, Math.round(a.naturalHeight * scale));
            const pa = pixelsOf(a, w, h), pb = pixelsOf(b, w, h);
            const out = new Uint8Array(w * h * 4);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    const i = (y * w + x) * 4, o = ((h - 1 - y) * w + x) * 4;
                    if (req.alphaUrl) { out[o] = pa[i]; out[o + 1] = pa[i + 1]; out[o + 2] = pa[i + 2]; out[o + 3] = pb[i]; }
                    else { out[o] = pb[i]; out[o + 1] = pa[i]; out[o + 2] = 0; out[o + 3] = 255; }
                }
            }
            tex.image = { data: out, width: w, height: h } as unknown as typeof tex.image;
            tex.needsUpdate = true;
            req.onReady?.({ data: out, width: w, height: h });
        }).catch(err => console.warn('[tree textures]', (err as Error).message));
        return tex;
    };
})();

/** A tree surface material of the library: what kind of surface it is, for diagnostics. */
export type TreeSurface = 'leaves' | 'bark' | 'masses' | (string & {});

/** A leaf atlas's pixels once loaded: the bakes waiting for them run then (or at once when they are in). */
class AtlasReady {
    pixels: AtlasPixels | undefined;
    private readonly waiters: Array<(p: AtlasPixels) => void> = [];
    set(p: AtlasPixels): void { this.pixels = p; for (const w of this.waiters.splice(0)) w(p); }
    then(fn: (p: AtlasPixels) => void): void { if (this.pixels) fn(this.pixels); else this.waiters.push(fn); }
}

function leafMaterial(e: TreeLeafTextureEntry, url: (f: string) => string, load: TextureLoad, o: TreeTextureOptions, ready: AtlasReady): THREE.MeshStandardMaterial {
    // colour with the opacity in its alpha (one texture), and the normal map; a leaf's roughness is near constant, so it
    // is a number, not a texture
    const mat = new THREE.MeshStandardMaterial({
        map: load({ url: url(e.maps.color), colour: true, alphaUrl: url(e.maps.opacity), maxPx: o.leafAtlasPx, onReady: p => ready.set(p) }),
        normalMap: e.maps.normal ? load({ url: url(e.maps.normal), colour: false }) : null,
        roughness: 0.6, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: true
    });
    // the atlas maps are clamped (a cell never wraps into its neighbour)
    for (const t of [mat.map, mat.normalMap]) if (t) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    const cells = e.atlas.cells.slice(0, MAX_LEAF_CELLS);
    const pad = <T,>(a: T[], fill: T) => [...a, ...new Array(MAX_LEAF_CELLS - a.length).fill(fill)];
    const stem = new THREE.Vector3(...e.colour.meanLinearRgb).multiplyScalar(0.55);
    const uniforms = {
        uSbCellA: { value: pad(cells.map(c => new THREE.Vector4(c.origin[0], c.origin[1], c.along[0], c.along[1])), new THREE.Vector4()) },
        uSbCellB: { value: pad(cells.map(c => new THREE.Vector4(c.across[0], c.across[1], c.widthM / c.lengthM, 0)), new THREE.Vector4(0, 0, 1, 0)) },
        uSbCellCount: { value: cells.length },
        uSbLeafStretch: { value: o.leafStretch },
        uSbLeafVariation: { value: o.leafVariation },
        uSbStem: { value: stem },
        uSbTranslucency: { value: o.translucency },
        uSbMipScale: { value: o.alphaMipScale },
        uSbSolidity: { value: leafSolidity(e.leaf.fill) }
    };
    mat.name = `sb-tree-leaves-${e.id}`;
    mat.userData = { sbTreeSurface: 'leaves' as TreeSurface, sbTreeTextureEntry: e.id, sbTreeUniforms: uniforms };
    mat.customProgramCacheKey = () => 'sbTreeLeaves/2';
    mat.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = replaceOrThrow(replaceOrThrow(shader.vertexShader, '#include <common>', LEAF_VERTEX_PARS, 'leaf vertex'), '#include <uv_vertex>', LEAF_VERTEX_MAIN, 'leaf vertex');
        let f = replaceOrThrow(shader.fragmentShader, '#include <common>', LEAF_FRAGMENT_PARS, 'leaf fragment');
        f = replaceOrThrow(f, '#include <map_fragment>', LEAF_FRAGMENT_COLOR, 'leaf fragment');
        f = replaceOrThrow(f, '#include <alphamap_fragment>', LEAF_FRAGMENT_ALPHA, 'leaf fragment');
        f = replaceOrThrow(f, '#include <lights_fragment_end>', LEAF_FRAGMENT_TRANSLUCENCY, 'leaf fragment');
        shader.fragmentShader = f;
    };
    return mat;
}

export const CARD_VERTEX_PARS = `
attribute vec4 ${TREE_TINT_ATTRIBUTE};
uniform float uSbLeafVariation;
varying vec3 vSbTint;
varying vec3 vSbHashPos;
`;
/** After uv_vertex: the tree's tint, varied per card (the instance's place). */
export const CARD_VERTEX_MAIN = `
{
    float sbJ = 0.5;
#ifdef USE_INSTANCING
    sbJ = fract( sin( dot( floor( instanceMatrix[ 3 ].xyz * 64.0 ), vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 );
#endif
    vSbTint = ${TREE_TINT_ATTRIBUTE}.rgb * ( 1.0 + uSbLeafVariation * ( sbJ - 0.5 ) );
    vSbHashPos = position;
#ifdef USE_INSTANCING
    vSbHashPos += instanceMatrix[ 3 ].xyz;
#endif
}
`;
export const CARD_FRAGMENT_PARS = `
uniform float uSbTranslucency;
uniform float uSbCardMipScale;
uniform float uSbSolidity;
varying vec3 vSbTint;
varying vec3 vSbHashPos;
${HASHED_ALPHA_FUNCTIONS}
`;
/**
 * After alphamap_fragment on a textured crown card: the cut-out's mip lift (CARD_ALPHA_MIP) for the solid share of its
 * leaves (leafSolidity), and the porous share cut at a hashed threshold, as the leaves' (LEAF_FRAGMENT_ALPHA).
 */
export const CARD_ALPHA_COVER = `
{
#if defined( USE_MAP )
    vec2 sbCardTexels = fwidth( vMapUv ) * vec2( textureSize( map, 0 ) );
#else
    vec2 sbCardTexels = vec2( 1.0 );
#endif
    float sbCardMip = max( 0.0, log2( max( max( sbCardTexels.x, sbCardTexels.y ), 1e-6 ) ) );
    diffuseColor.a = min( 1.0, diffuseColor.a * ( 1.0 + sbCardMip * uSbCardMipScale * uSbSolidity ) );
}
{
    float sbHashed = diffuseColor.a >= sbHashedThreshold( vSbHashPos ) ? 1.0 : 0.0;
    diffuseColor.a = mix( sbHashed, diffuseColor.a, uSbSolidity );
}
`;
/** After lights_fragment_end: sunlight through the leaves of a card lit from behind (as the leaves' term). */
export const CARD_FRAGMENT_TRANSLUCENCY = `${SUN_FOR_TRANSLUCENCY}
#ifdef SB_SUN_DIR
{
    float sbBack = max( 0.0, dot( - normal, SB_SUN_DIR ) );
    reflectedLight.directDiffuse += diffuseColor.rgb * SB_SUN_COLOR * ( sbBack * uSbTranslucency );
}
#undef SB_SUN_DIR
#undef SB_SUN_COLOR
#endif
`;

function crownCardMaterial(e: TreeLeafTextureEntry, cards: TreeCrownCardsExtras, ready: AtlasReady, o: TreeTextureOptions): THREE.MeshStandardMaterial {
    // until the leaf atlas is in, the clay cut-out in the leaf set's mean colour
    const mean = e.colour.meanLinearRgb.map(c => Math.round(255 * Math.pow(Math.min(1, Math.max(0, c)), 1 / 2.2)));
    const placeholder = bakeCrownCardAtlas(cards, CROWN_CARD_ATLAS_PX, clayLeafPaint(cards));
    for (let i = 0; i < placeholder.length; i += 4) { placeholder[i] = mean[0]; placeholder[i + 1] = mean[1]; placeholder[i + 2] = mean[2]; }
    const map = crownCardTexture(placeholder, CROWN_CARD_ATLAS_PX, true);
    ready.then(px => {
        map.image = { data: bakeCrownCardAtlas(cards, CROWN_CARD_ATLAS_PX, texturedLeafPaint(e, px, cards.clayLeafAspect)), width: CROWN_CARD_ATLAS_PX, height: CROWN_CARD_ATLAS_PX } as unknown as typeof map.image;
        map.needsUpdate = true;
    });
    const mat = new THREE.MeshStandardMaterial({ map, roughness: 0.6, metalness: 0, side: THREE.DoubleSide, alphaTest: 0.5, alphaToCoverage: false });
    const uniforms = { uSbLeafVariation: { value: o.leafVariation }, uSbTranslucency: { value: o.translucency }, uSbCardMipScale: { value: CROWN_CARD_MIP_SCALE },
        uSbSolidity: { value: leafSolidity(e.leaf.fill) } };
    mat.name = `sb-tree-crown-cards-${e.id}`;
    mat.userData = { sbTreeSurface: 'crown-cards' as TreeSurface, sbTreeTextureEntry: e.id, sbTreeUniforms: uniforms };
    mat.customProgramCacheKey = () => 'sbTreeCrownCards/2';
    mat.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, uniforms);
        markCrownCardShader(shader);
        shader.vertexShader = replaceOrThrow(replaceOrThrow(shader.vertexShader, '#include <common>', CARD_VERTEX_PARS, 'card vertex'), '#include <uv_vertex>', CARD_VERTEX_MAIN, 'card vertex');
        let f = replaceOrThrow(shader.fragmentShader, '#include <common>', CARD_FRAGMENT_PARS, 'card fragment');
        f = replaceOrThrow(f, '#include <map_fragment>', 'diffuseColor.rgb *= vSbTint;', 'card fragment');
        f = replaceOrThrow(f, '#include <alphamap_fragment>', CARD_ALPHA_COVER, 'card fragment');
        f = replaceOrThrow(f, '#include <lights_fragment_end>', CARD_FRAGMENT_TRANSLUCENCY, 'card fragment');
        shader.fragmentShader = f;
    };
    return mat;
}

function tintedMaterial(params: THREE.MeshStandardMaterialParameters, surface: TreeSurface, noise: number, name: string): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial(params);
    const uniforms = { uSbNoise: { value: noise } };
    mat.name = name;
    mat.userData = { sbTreeSurface: surface, sbTreeUniforms: uniforms };
    mat.customProgramCacheKey = () => 'sbTreeTinted/1';
    mat.onBeforeCompile = shader => {
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = replaceOrThrow(replaceOrThrow(shader.vertexShader, '#include <common>', TINT_VERTEX_PARS, 'tinted vertex'), '#include <project_vertex>', TINT_VERTEX_MAIN, 'tinted vertex');
        shader.fragmentShader = replaceOrThrow(replaceOrThrow(shader.fragmentShader, '#include <common>', TINT_FRAGMENT_PARS, 'tinted fragment'), '#include <map_fragment>', TINT_FRAGMENT_COLOR, 'tinted fragment');
    };
    return mat;
}

function barkMaterial(e: TreeBarkTextureEntry, url: (f: string) => string, load: TextureLoad): THREE.MeshStandardMaterial {
    const mat = tintedMaterial({
        map: load({ url: url(e.maps.color), colour: true }), normalMap: e.maps.normal ? load({ url: url(e.maps.normal), colour: false }) : null,
        roughness: 1, metalness: 0, aoMapIntensity: 0.8
    }, 'bark', 0, `sb-tree-bark-${e.id}`);
    // roughness (G) and ambient occlusion (R) in one texture
    if (e.maps.roughness) {
        const orm = load({ url: url(e.maps.roughness), colour: false, ...(e.maps.ao ? { aoUrl: url(e.maps.ao) } : {}) });
        mat.roughnessMap = orm;
        if (e.maps.ao) mat.aoMap = orm;
    }
    mat.userData.sbTreeTextureEntry = e.id;
    return mat;
}

/** The library's materials: one per entry, built once, textures shared. */
export class TreeTextureLibrary {
    private readonly leaves = new Map<string, THREE.MeshStandardMaterial>();
    private readonly atlases = new Map<string, AtlasReady>();
    private readonly cards = new Map<string, THREE.MeshStandardMaterial>();
    private readonly bark = new Map<string, THREE.MeshStandardMaterial>();
    readonly masses: THREE.MeshStandardMaterial;
    readonly options: TreeTextureOptions;

    constructor(readonly index: TreeTextureIndex, readonly baseUrl: string = TREE_TEXTURE_BASE_URL, private readonly load: TextureLoad = defaultTextureLoad, options: Partial<TreeTextureOptions> = {}) {
        const problems = validateTreeTextureIndex(index);
        if (problems.length) throw new Error(`the tree texture index is not usable: ${problems.slice(0, 5).join('; ')}`);
        this.options = { ...DEFAULT_TREE_TEXTURE_OPTIONS, ...options };
        this.masses = tintedMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 }, 'masses', this.options.massNoise, 'sb-tree-masses');
    }

    private url = (f: string): string => this.baseUrl.replace(/\/?$/, '/') + f;

    /** The leaf material of an entry; undefined for an entry the library does not hold. */
    leafMaterial(id: string): THREE.MeshStandardMaterial | undefined {
        let m = this.leaves.get(id);
        if (!m) {
            const e = this.index.leaves.find(x => x.id === id);
            if (!e) return undefined;
            this.leaves.set(id, m = leafMaterial(e, this.url, this.load, this.options, this.atlasOf(id)));
        }
        return m;
    }

    private atlasOf(id: string): AtlasReady {
        let a = this.atlases.get(id);
        if (!a) this.atlases.set(id, a = new AtlasReady());
        return a;
    }

    /** The crown-card material of a leaf entry for a card layout (its atlas baked once the entry's leaf atlas has loaded). */
    crownCardMaterial(id: string, cards: TreeCrownCardsExtras): THREE.MeshStandardMaterial | undefined {
        const e = this.index.leaves.find(x => x.id === id);
        if (!e) return undefined;
        this.leafMaterial(id);                          // loads the leaf atlas the cards are baked from
        const key = `${id}|${JSON.stringify([cards.cols, cards.rows, cards.clayLeafAspect, cards.cells])}`;
        let m = this.cards.get(key);
        if (!m) this.cards.set(key, m = crownCardMaterial(e, cards, this.atlasOf(id), this.options));
        return m;
    }

    barkMaterial(id: string): THREE.MeshStandardMaterial | undefined {
        let m = this.bark.get(id);
        if (!m) {
            const e = this.index.bark.find(x => x.id === id);
            if (!e) return undefined;
            this.bark.set(id, m = barkMaterial(e, this.url, this.load));
        }
        return m;
    }
}

let shared: { baseUrl: string; promise: Promise<TreeTextureLibrary> } | undefined;

/** The library at `baseUrl` (its index fetched once; materials and textures shared by every scene). */
export function loadTreeTextureLibrary(baseUrl: string = TREE_TEXTURE_BASE_URL, fetchImpl: typeof fetch = fetch): Promise<TreeTextureLibrary> {
    if (shared?.baseUrl === baseUrl) return shared.promise;
    const promise = fetchImpl(baseUrl.replace(/\/?$/, '/') + 'index.json')
        .then(r => { if (!r.ok) throw new Error(`tree texture index: HTTP ${r.status}`); return r.json(); })
        .then(index => new TreeTextureLibrary(index as TreeTextureIndex, baseUrl));
    shared = { baseUrl, promise };
    promise.catch(() => { if (shared?.promise === promise) shared = undefined; });
    return promise;
}

export interface TreeTextureStats {
    trees: number;
    leafMeshes: number;
    woodMeshes: number;
    twigMeshes: number;
    massMeshes: number;
    /** Crown-card meshes (the mid level's cut-out cards) dressed in their leaf set's card atlas. */
    cardMeshes: number;
    /** Trees whose extras name an entry the library does not hold (they keep the loader's material). */
    unknownEntries: number;
}

/** The level node a mesh belongs to and the mesh's own primitive index in it (a multi-primitive node is a group of meshes). */
function levelOf(m: THREE.Object3D): { lod: TreeLodExtras; primitive: number } | undefined {
    let o: THREE.Object3D | null = m;
    while (o) {
        const lod = (o.userData as { sbLod?: TreeLodExtras }).sbLod;
        if (lod) {
            const prims = (o as THREE.Mesh).isMesh ? [o] : o.children.filter(c => (c as THREE.Mesh).isMesh && !c.userData?.sbCluster && !c.userData?.sbLod);
            return { lod, primitive: prims.indexOf(m) };
        }
        if ((o.userData as { sbTree?: unknown }).sbTree) return undefined;
        o = o.parent;
    }
    return undefined;
}

/** The detail slot (0 near .. 3 far) of a leaf mesh's level, from its level and its tree's number of levels (crownSlotOf). */
function leafSlotOf(m: THREE.Object3D): number {
    let o: THREE.Object3D | null = m;
    while (o) {
        const lod = (o.userData as { sbLod?: TreeLodExtras }).sbLod;
        if (lod) {
            const levels = o.parent ? o.parent.children.filter(c => (c.userData as { sbLod?: unknown }).sbLod).length : 4;
            return crownSlotOf(lod.level, levels);
        }
        o = o.parent;
    }
    return 0;
}

function clusterOf(m: THREE.Object3D): string | undefined {
    let o: THREE.Object3D | null = m;
    while (o) {
        const cl = (o.userData as { sbCluster?: { clusterMesh?: string } }).sbCluster;
        if (cl?.clusterMesh) return cl.clusterMesh;
        if ((o.userData as { sbTree?: unknown }).sbTree || (o.userData as { sbLod?: unknown }).sbLod) return undefined;
        o = o.parent;
    }
    return undefined;
}

/**
 * Dresses the trees under `root` (a loaded trees GLB, its level-of-detail controller already in place) in the library's
 * surfaces, by what each tree's extras chose. Meshes lacking the attributes a surface needs (a file written before the
 * library) keep the loader's material. Returns what it dressed.
 */
export function applyTreeTextures(root: THREE.Object3D, lib: TreeTextureLibrary): TreeTextureStats {
    const stats: TreeTextureStats = { trees: 0, leafMeshes: 0, woodMeshes: 0, twigMeshes: 0, massMeshes: 0, cardMeshes: 0, unknownEntries: 0 };
    let rootExtras: TreesGlbRootExtras | undefined;
    root.traverseAncestors(a => { rootExtras ??= a.userData?.sbTrees as TreesGlbRootExtras | undefined; });
    rootExtras ??= root.userData?.sbTrees as TreesGlbRootExtras | undefined;
    if (!rootExtras) root.traverse(o => { rootExtras ??= o.userData?.sbTrees as TreesGlbRootExtras | undefined; });
    const cardWidth = rootExtras?.clusterLibrary?.leafCard?.widthRatio;
    if (!rootExtras?.textures || !(typeof cardWidth === 'number' && cardWidth > 0)) return stats;
    const leafVariants = new Set((rootExtras.clusterLibrary.variants ?? []).filter(v => v.leavesLevel0 > 0 || (v.leavesNearMid ?? 0) > 0 || v.leavesLevel1 > 0).map(v => v.mesh));
    const cards = crownCardsOf(rootExtras);
    const cardMeshes = new Set(cards?.meshes ?? []);
    const trees: THREE.Object3D[] = [];
    root.traverse(o => { if ((o.userData as { sbTree?: TreeNodeExtras }).sbTree?.texture) trees.push(o); });
    for (const node of trees) {
        const tex = (node.userData.sbTree as TreeNodeExtras).texture!;
        const leaves = lib.leafMaterial(tex.leaves.entry), bark = lib.barkMaterial(tex.bark.entry);
        if (!leaves || !bark) { stats.unknownEntries++; continue; }
        stats.trees++;
        node.traverse(o => {
            const m = o as THREE.Mesh;
            if (!m.isMesh || Array.isArray(m.material)) return;
            const g = m.geometry as THREE.BufferGeometry;
            const hasUv = !!g.getAttribute('uv');
            // what the loader gave it, for comparison (the textured mode before the library)
            m.userData.sbTreeLoaderMaterial ??= (m.userData.sbClayOriginalMaterial ?? m.userData.sbLodBase ?? m.material) as THREE.Material;
            if ((m as THREE.InstancedMesh).isInstancedMesh) {
                const cluster = clusterOf(m);
                if (cards && cluster && cardMeshes.has(cluster)) {
                    const mat = hasUv ? lib.crownCardMaterial(tex.leaves.entry, cards) : undefined;
                    if (!mat) return;
                    setPerMeshAttribute(m, 'sbTreeTint', [...tex.leaves.tint, 1]);
                    setTreeLodTexturedMaterial(m, mat);
                    stats.cardMeshes++;
                    return;
                }
                if (cluster && leafVariants.has(cluster)) {
                    if (!hasUv || !g.getAttribute('_leaf')) return;
                    setPerMeshAttribute(m, 'sbTreeTint', [...tex.leaves.tint, cardWidth]);
                    const slot = leafSlotOf(m);
                    setPerMeshAttribute(m, TREE_CARD_ATTRIBUTE, [lib.options.cardZoom[slot] ?? 1, lib.options.alphaGain[slot] ?? 1, 0, 0]);
                    setTreeLodTexturedMaterial(m, leaves);
                    stats.leafMeshes++;
                } else if (hasUv) {
                    setPerMeshAttribute(m, 'sbTreeTint', [...tex.bark.tint, 1]);
                    setTreeLodTexturedMaterial(m, bark);
                    stats.twigMeshes++;
                }
                return;
            }
            const level = levelOf(m);
            if (level && level.lod.foliagePrimitives?.includes(level.primitive)) {
                setPerMeshAttribute(m, 'sbTreeTint', [...tex.massColourLinear, 1]);
                setTreeLodTexturedMaterial(m, lib.masses);
                stats.massMeshes++;
            } else if (hasUv) {
                setPerMeshAttribute(m, 'sbTreeTint', [...tex.bark.tint, 1]);
                setTreeLodTexturedMaterial(m, bark);
                stats.woodMeshes++;
            }
        });
    }
    return stats;
}
