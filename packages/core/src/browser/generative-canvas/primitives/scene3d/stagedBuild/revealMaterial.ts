/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The reveal material and the per-frame guard (design §7.2).
 *
 * One shader patch drives every reveal from the data alone: `_REVEAL` (x = item order in the node, y = order inside
 * the item), `_DISP` (host surface → final position, scaled in as the item reveals), the node's window in its layer
 * and the layer's stagger. A node without `_REVEAL` fades in as one unit with a screen-space dither; a crossfade source
 * uses the complementary dither, so the pair never double-draws or leaves holes. Nothing branches on a stage, layer,
 * kind or label name.
 *
 * The loader swaps every mesh's material for fresh clay right after attaching a model, and the clay/shaded toggle swaps
 * them again, so a material patched when a model is added would be lost before its first frame. The guard therefore
 * runs on `scene.onBeforeRender` (three calls it before projecting the scene, every frame) and re-patches any staged
 * mesh whose material lacks the stamp: the first frame after a layer is attached is drawn patched at progress 0, which
 * covers no pixels. Each staged mesh gets its own material for the reveal's duration (uniforms are per material); the
 * original (clay or shaded) material is restored when the reveal ends and provenance shading is off.
 */

import * as THREE from 'three';
import { PART_ATTRIBUTE, mergedPartsOf, setPartVisibility } from './mergeStagedParts';
import { MATERIAL_READING_STRIPE_COLOR, DEGRADED_OUTLINE_COLOR, PROVENANCE_BACKGROUND, TEXTURE_RUNG_COLORS, VERTEX_ATTRIBUTE, STRIPE_COVERAGE, STRIPE_PERIOD_PX, hexToRgb01, vertexClassGlsl } from './provenanceShading';

/** Stamp on every material the guard installs; its value says which variant. */
const STAMP = 'sbStagedPatch';
/** Whether a staged material carries the reveal's discards (see FRAGMENT_DISCARD). */
const REVEAL_VARIANT = 'sbStagedReveal';
/** Mirrors ORIGINAL_KEY in clayRenderMode.ts (as disposeObject.ts does): the authored material stashed under clay. */
const CLAY_ORIGINAL_MATERIAL_KEY = 'sbClayOriginalMaterial';
const CLAY_FLAG = 'sbClay';

/** _REVEAL and _DISP as three's GLTFLoader names them (it lowercases custom attributes). */
export const REVEAL_ATTRIBUTE = '_reveal';
export const DISP_ATTRIBUTE = '_disp';

export type StagedMaterialKind = 'reveal' | 'provenance' | 'rungs';

/**
 * Where a textured twin's material keeps its confidence texture (R provenance index, G weight, B ladder rung, A produced),
 * set by prepareTexturedTwinModel (texturedTwinModel.ts) from the material's extras.sbTexture.confidenceTexture.
 */
export const CONFIDENCE_MAP_KEY = 'sbConfidenceMap';

/** Stripe colour of texels the facade material reading wrote, in the rung (provenance) view. */
export const MATERIAL_READING_COLOR = MATERIAL_READING_STRIPE_COLOR;

/** The provenance indices of the facade material reading's entries on a twin material (extras.sbMaterial), at most 4. */
export function materialProvenanceIndices(m: THREE.Material | undefined): number[] {
    const v = (m?.userData as { sbMaterial?: { provenanceIndices?: unknown } } | undefined)?.sbMaterial?.provenanceIndices;
    return Array.isArray(v) ? v.filter((x): x is number => Number.isInteger(x) && x >= 0 && x < 255).slice(0, 4) : [];
}

export function confidenceMapOf(m: THREE.Material | undefined): THREE.Texture | undefined {
    const t = m?.userData?.[CONFIDENCE_MAP_KEY] as THREE.Texture | undefined;
    return t && t.isTexture ? t : undefined;
}

/** What one staged mesh should look like this frame. */
export interface MeshStagedLook {
    reveal?: {
        /** The node's own progress, 0..1 (the layer's progress mapped through the node's window). */
        progress: number;
        /** Layer stagger: share of the node's time spent staggering its _REVEAL items. */
        stagger: number;
        /** This node fades in as one unit (no _REVEAL): opacity by dither, 0..1. */
        fade: number;
        /** Fades out under the layer replacing it (complementary dither): 1 = fully present. */
        presence: number;
        /** Revealed over a source that stays drawn: pulled in front of it so coincident surfaces never z-fight. */
        overSource?: boolean;
        /** A material swap (clay <-> textured twin): the geometry is final, so `_DISP` is not animated. */
        noDisp?: boolean;
    };
    provenance?: {
        nodeColor: string;
        nodePattern: number;
        nodeCoverage: number;
        classCount: number;
        classColors: THREE.Color[];
        classPatterns: THREE.Vector2[];
    };
    /** Vermillion hatch: a degraded part, or one the user highlighted from the overlay. */
    mark?: boolean;
    /**
     * Per-texel texture rungs of a textured twin: each texel drawn in the colour of its rung (the base material's
     * confidence texture, B channel; texels no stage produced, and surfaces without the texture, in the clay rung's).
     */
    rungs?: { colors: THREE.Color[] };
}

interface StagedUniforms {
    uSbProgress: { value: number };
    uSbStagger: { value: number };
    uSbFade: { value: number };
    uSbPresence: { value: number };
    uSbHasReveal: { value: number };
    uSbHasDisp: { value: number };
    uSbHasRelief: { value: number };
    uSbHasProud: { value: number };
    uSbHasRectify: { value: number };
    uSbMark: { value: number };
    uSbPxScale: { value: number };
    uSbBackground: { value: THREE.Vector3 };
    uSbMarkColor: { value: THREE.Vector3 };
    uSbClassColor?: { value: THREE.Color[] };
    uSbClassPattern?: { value: THREE.Vector2[] };
    uSbRungColor?: { value: THREE.Color[] };
    /** Merged parts (mergeStagedParts.ts): per part (fade, presence, mark, pattern code) and (provenance colour, pattern coverage). */
    uSbPartA?: { value: THREE.Vector4[] };
    uSbPartB?: { value: THREE.Vector4[] };
    uSbMatIdx?: { value: THREE.Vector4 };
    uSbMatColor?: { value: THREE.Color };
}

const BASE = new WeakMap<THREE.Material, THREE.Material>();
const UNIFORMS = new WeakMap<THREE.Material, StagedUniforms>();

/** Written after <colorspace_fragment>, where the output is already sRGB: the hex's own components. */
function srgbVec(hex: string): THREE.Vector3 {
    const [r, g, b] = hexToRgb01(hex);
    return new THREE.Vector3(r, g, b);
}

export function isStagedMaterial(m: THREE.Material | THREE.Material[] | null | undefined): m is THREE.Material {
    return !!m && !Array.isArray(m) && typeof m.userData?.[STAMP] === 'string';
}

export function stagedKindOf(m: THREE.Material): StagedMaterialKind | undefined {
    return m.userData?.[STAMP] as StagedMaterialKind | undefined;
}

/** What a staged material is drawing with right now (diagnostics and tests; nothing in the viewport reads it). */
export function stagedMaterialUniforms(m: THREE.Material): { progress: number; stagger: number; fade: number; presence: number; background: THREE.Vector3 } | undefined {
    const u = UNIFORMS.get(m);
    return u ? { progress: u.uSbProgress.value, stagger: u.uSbStagger.value, fade: u.uSbFade.value, presence: u.uSbPresence.value, background: u.uSbBackground.value } : undefined;
}

/** A merged mesh's per-part fade, presence and mark as its staged material draws them (diagnostics and tests). */
export function stagedPartUniforms(m: THREE.Material): Array<{ fade: number; presence: number; mark: number }> | undefined {
    const u = UNIFORMS.get(m);
    return u?.uSbPartA ? u.uSbPartA.value.map(v => ({ fade: v.x, presence: v.y, mark: v.z })) : undefined;
}

/** The material a staged material stands in for. */
export function baseMaterialOf(m: THREE.Material): THREE.Material | undefined {
    return BASE.get(m);
}

const VERTEX_DECL = `
attribute vec2 ${REVEAL_ATTRIBUTE};
attribute vec3 ${DISP_ATTRIBUTE};
uniform float uSbProgress;
uniform float uSbStagger;
uniform float uSbHasReveal;
uniform float uSbHasDisp;
varying float vSbRevealK;
#ifdef SB_PARTS
attribute float ${PART_ATTRIBUTE};
uniform vec4 uSbPartA[SB_PARTS];
uniform vec4 uSbPartB[SB_PARTS];
varying vec4 vSbPartA;
#endif
#ifdef SB_PROVENANCE
attribute float ${VERTEX_ATTRIBUTE.reliefHeight};
attribute float ${VERTEX_ATTRIBUTE.proudBlock};
attribute float ${VERTEX_ATTRIBUTE.rectifyDisplacement};
uniform float uSbHasRelief;
uniform float uSbHasProud;
uniform float uSbHasRectify;
uniform vec3 uSbClassColor[SB_CLASSES];
uniform vec2 uSbClassPattern[SB_CLASSES];
// Smooth, not flat: ANGLE's Metal backend emulates GL's provoking vertex for flat varyings, at a heavy per-draw cost.
// The class is looked up here, so a triangle across two bands blends their colours instead.
varying vec3 vSbColor;
varying vec2 vSbPattern;
#endif
`;

const VERTEX_BODY = `
#ifdef SB_PARTS
    int sbPart = int(${PART_ATTRIBUTE} + 0.5);
    vSbPartA = uSbPartA[sbPart];
#endif
    {
        float sbItemStart = ${REVEAL_ATTRIBUTE}.x * uSbStagger;
        float sbLocal = clamp((uSbProgress - sbItemStart) / max(1e-4, 1.0 - uSbStagger), 0.0, 1.0);
        transformed -= uSbHasDisp * ${DISP_ATTRIBUTE} * (1.0 - sbLocal);
        vSbRevealK = uSbHasReveal * (${REVEAL_ATTRIBUTE}.x * uSbStagger + ${REVEAL_ATTRIBUTE}.y * (1.0 - uSbStagger));
    }
#ifdef SB_PROVENANCE
    {${vertexClassGlsl()}
#ifdef SB_PARTS
    // a merged part's own legend colour and pattern stand in for the node's (class 0)
    if (sbCls == 0) { vSbColor = uSbPartB[sbPart].rgb; vSbPattern = vec2(uSbPartA[sbPart].w, uSbPartB[sbPart].a); }
#endif
    }
#endif
`;

const FRAGMENT_DECL = `
#ifdef SB_RUNGS
uniform vec3 uSbRungColor[SB_RUNG_COUNT];
#endif
#ifdef SB_MAT_STRIPES
uniform vec4 uSbMatIdx;
uniform vec3 uSbMatColor;
#endif
uniform float uSbProgress;
uniform float uSbFade;
uniform float uSbPresence;
uniform float uSbMark;
uniform float uSbPxScale;
uniform vec3 uSbBackground;
uniform vec3 uSbMarkColor;
varying float vSbRevealK;
#ifdef SB_PROVENANCE
varying vec3 vSbColor;
varying vec2 vSbPattern;
#endif
#ifdef SB_PARTS
varying vec4 vSbPartA;
#endif
float sbDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
bool sbStripe(vec2 p, float period, float coverage, float dir) { return mod(p.x + dir * p.y, period) < coverage * period; }
// A stripe whose edges are antialiased over one device pixel, so its share of the surface is the coverage at any pixel
// density (the diagonal x + y only takes whole values on the pixel grid, which gave a 35 percent stripe a share of 50).
float sbStripeAlpha(vec2 p, float period, float coverage, float dir, float pxScale) {
    float hw = 0.5 * coverage * period;
    float d = abs(mod(p.x + dir * p.y, period) - hw);
    d = min(d, period - d);
    return clamp((hw - d) * pxScale + 0.5, 0.0, 1.0);
}
// How much of a pixel a round dot covers: the dot's area is the coverage share of its cell, and its edge is antialiased
// over one device pixel, so the share of the surface the dots take stays proportional to the coverage at any pixel
// density (a hard edge would give every coverage under 16 percent the same four pixels at 1x).
float sbDotAlpha(vec2 p, float period, float coverage, float pxScale) {
    vec2 c = mod(p, period) - 0.5 * period;
    float r = sqrt(coverage * period * period / 3.14159265);
    return clamp((r - length(c)) * pxScale + 0.5, 0.0, 1.0);
}
`;

/**
 * Only materials of a node that is revealing (or fading under a replacement) carry `discard`: a shader that may discard
 * defeats the GPU's hidden-surface removal (early depth test, and Apple's tile-based HSR), which on a dense canopy costs
 * an order of magnitude in fragment work. Steady looks (provenance of a revealed layer, a highlight) compile without it.
 */
const FRAGMENT_DISCARD = `
#ifdef SB_REVEAL
    if (uSbProgress <= 0.0 || (uSbProgress < 1.0 && vSbRevealK >= uSbProgress)) discard;
    {
        float sbFadeP = uSbFade;
        float sbPresenceP = uSbPresence;
#ifdef SB_PARTS
        // a merged part's own fade and presence (a hidden part has fade 0)
        sbFadeP *= vSbPartA.x;
        sbPresenceP *= vSbPartA.y;
#endif
        float sbH = sbDither(gl_FragCoord.xy);
        if (sbH >= sbFadeP || sbH < 1.0 - sbPresenceP) discard;
    }
#endif
`;

const FRAGMENT_PROVENANCE_COLOR = `
#ifdef SB_PROVENANCE
    vec4 diffuseColor = vec4( vSbColor, opacity );
#else
    vec4 diffuseColor = vec4( diffuse, opacity );
#endif
`;

/**
 * Provenance shading keeps the lighting (shape stays readable) but adds a floor of the legend colour itself, so a face
 * turned away from every light (a soffit, a north wall) still shows its hue instead of going black.
 */
export const PROVENANCE_LIGHT_FLOOR = 0.35;
const FRAGMENT_PROVENANCE_FLOOR = `
#if defined( SB_PROVENANCE ) || defined( SB_RUNGS )
    totalEmissiveRadiance += diffuseColor.rgb * ${PROVENANCE_LIGHT_FLOOR.toFixed(2)};
#endif
`;

const FRAGMENT_END = `
    {
        vec2 sbP = gl_FragCoord.xy / max(uSbPxScale, 1e-3);
#ifdef SB_PROVENANCE
        vec2 sbPat = vec2(floor(vSbPattern.x + 0.5), vSbPattern.y);
        float sbStripes = 0.0;
        if (sbPat.x > 0.5 && sbPat.x < 1.5) sbStripes = sbStripeAlpha(sbP, ${STRIPE_PERIOD_PX.toFixed(1)}, ${STRIPE_COVERAGE.toFixed(3)}, 1.0, uSbPxScale);
        else if (sbPat.x > 1.5 && sbPat.x < 2.5) sbStripes = 1.0 - (1.0 - sbStripeAlpha(sbP, ${STRIPE_PERIOD_PX.toFixed(1)}, ${STRIPE_COVERAGE.toFixed(3)}, 1.0, uSbPxScale)) * (1.0 - sbStripeAlpha(sbP, ${STRIPE_PERIOD_PX.toFixed(1)}, ${STRIPE_COVERAGE.toFixed(3)}, -1.0, uSbPxScale));
        float sbDots = sbPat.y > 0.0 ? sbDotAlpha(sbP + vec2(3.0), ${STRIPE_PERIOD_PX.toFixed(1)}, sbPat.y, uSbPxScale) : 0.0;
        gl_FragColor.rgb = mix(gl_FragColor.rgb, uSbBackground, 1.0 - (1.0 - sbStripes) * (1.0 - sbDots));
#endif
        float sbMarkOn = uSbMark;
#ifdef SB_PARTS
        sbMarkOn = max(sbMarkOn, vSbPartA.z);
#endif
        if (sbMarkOn > 0.5 && sbStripe(sbP, 10.0, 0.2, -1.0)) gl_FragColor.rgb = uSbMarkColor;
    }
`;

/**
 * The rung of each texel from the confidence texture (sampled nearest, never colour-converted): B is the rung index,
 * A is 255 where a stage produced the texel. Replaces the map's colour; the lighting stays, so the shape reads.
 */
const FRAGMENT_RUNGS = `
#ifdef SB_RUNGS
    {
        vec4 sbConf = texture2D( map, vMapUv );
        int sbRung = int( clamp( floor( sbConf.b * 255.0 + 0.5 ), 0.0, float( SB_RUNG_COUNT - 1 ) ) );
        if ( sbConf.a < 0.5 ) sbRung = SB_RUNG_COUNT - 1;
        diffuseColor.rgb = uSbRungColor[ sbRung ];
#ifdef SB_MAT_STRIPES
        // texels the facade material reading wrote (photo-inferred glass): stripes over the rung, as strong as their confidence
        float sbIdx = floor( sbConf.r * 255.0 + 0.5 );
        if ( sbConf.a > 0.5 && ( sbIdx == uSbMatIdx.x || sbIdx == uSbMatIdx.y || sbIdx == uSbMatIdx.z || sbIdx == uSbMatIdx.w ) ) {
            float sbS = mod( gl_FragCoord.x + gl_FragCoord.y, 8.0 ) < 4.0 ? 1.0 : 0.0;
            diffuseColor.rgb = mix( diffuseColor.rgb, uSbMatColor, sbS * ( 0.4 + 0.6 * sbConf.g ) );
        }
#endif
    }
#else
#include <map_fragment>
#endif
`;

function injectShader(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: StagedUniforms): void {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', FRAGMENT_PROVENANCE_COLOR)
        .replace('#include <map_fragment>', FRAGMENT_RUNGS)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAGMENT_DISCARD}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${FRAGMENT_PROVENANCE_FLOOR}`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${FRAGMENT_END}`);
}

function makeUniforms(): StagedUniforms {
    return {
        uSbProgress: { value: 0 },
        uSbStagger: { value: 0 },
        uSbFade: { value: 0 },
        uSbPresence: { value: 1 },
        uSbHasReveal: { value: 0 },
        uSbHasDisp: { value: 0 },
        uSbHasRelief: { value: 0 },
        uSbHasProud: { value: 0 },
        uSbHasRectify: { value: 0 },
        uSbMark: { value: 0 },
        uSbPxScale: { value: 1 },
        uSbBackground: { value: srgbVec(PROVENANCE_BACKGROUND) },
        uSbMarkColor: { value: srgbVec(DEGRADED_OUTLINE_COLOR) }
    };
}

/**
 * A staged material for `mesh`, standing in for `base`:
 *  - 'reveal': a clone of the base (clay or shaded) with the reveal patch;
 *  - 'provenance': lit MeshStandardMaterial (roughness 0.9) in the legend colours with the reveal patch, the per-vertex
 *    classes and the patterns; lines keep their vertex colours (fit error) or take the node colour.
 * All staged materials of a variant share one program.
 */
export function createStagedMaterial(mesh: THREE.Mesh | THREE.LineSegments, base: THREE.Material, kind: StagedMaterialKind, classCount: number, withReveal = true): THREE.Material {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const isLine = (mesh as THREE.LineSegments).isLine === true;
    let mat: THREE.Material;
    const confidence = kind === 'rungs' && !isLine ? confidenceMapOf(base) : undefined;
    if (kind === 'reveal') {
        mat = base.clone();
    } else if (kind === 'rungs' && !isLine) {
        // Lit like the provenance shading; the confidence texture is bound as the map only to be sampled for its rungs.
        mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, map: confidence ?? null, side: (base as THREE.MeshStandardMaterial).side ?? THREE.FrontSide });
        mat.toneMapped = false;
    } else if (isLine) {
        const hasColor = !!geometry.getAttribute('color');
        mat = new THREE.LineBasicMaterial({ vertexColors: hasColor, color: 0xffffff });
    } else {
        mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: (base as THREE.MeshStandardMaterial).side ?? THREE.FrontSide });
        mat.toneMapped = false;
    }
    const uniforms = makeUniforms();
    const provenanceClasses = kind === 'provenance' && !isLine ? Math.max(1, classCount) : 0;
    const defs = (mat as THREE.Material & { defines?: Record<string, unknown> });
    if (provenanceClasses > 0) {
        uniforms.uSbClassColor = { value: Array.from({ length: provenanceClasses }, () => new THREE.Color(0xffffff)) };
        uniforms.uSbClassPattern = { value: Array.from({ length: provenanceClasses }, () => new THREE.Vector2(0, 0)) };
        defs.defines = { ...(defs.defines ?? {}), SB_PROVENANCE: '', SB_CLASSES: provenanceClasses };
    }
    if (withReveal) defs.defines = { ...(defs.defines ?? {}), SB_REVEAL: '' };
    // a merged mesh (mergeStagedParts.ts): per-part looks from uniform arrays indexed by its part attribute
    const partCount = !isLine ? (mergedPartsOf(mesh)?.parts.length ?? 0) : 0;
    if (partCount > 0) {
        uniforms.uSbPartA = { value: Array.from({ length: partCount }, () => new THREE.Vector4(1, 1, 0, 0)) };
        uniforms.uSbPartB = { value: Array.from({ length: partCount }, () => new THREE.Vector4(1, 1, 1, 0)) };
        defs.defines = { ...(defs.defines ?? {}), SB_PARTS: partCount };
    }
    if (confidence) {
        uniforms.uSbRungColor = { value: TEXTURE_RUNG_COLORS.map(c => new THREE.Color(c)) };
        defs.defines = { ...(defs.defines ?? {}), SB_RUNGS: '', SB_RUNG_COUNT: TEXTURE_RUNG_COLORS.length };
        const matIdx = materialProvenanceIndices(base);
        if (matIdx.length) {
            uniforms.uSbMatIdx = { value: new THREE.Vector4(matIdx[0] ?? -1, matIdx[1] ?? -1, matIdx[2] ?? -1, matIdx[3] ?? -1) };
            uniforms.uSbMatColor = { value: new THREE.Color(MATERIAL_READING_COLOR) };
            defs.defines = { ...(defs.defines ?? {}), SB_MAT_STRIPES: '' };
        }
    } else if (kind === 'rungs' && !isLine) {
        // no confidence texture on this surface (a primitive the pass did not texture): the clay rung, flat
        (mat as THREE.MeshStandardMaterial).color.set(TEXTURE_RUNG_COLORS[TEXTURE_RUNG_COLORS.length - 1]);
        defs.defines = { ...(defs.defines ?? {}), SB_RUNG_FLAT: '' };
    }
    mat.onBeforeCompile = shader => injectShader(shader, uniforms);
    const cacheKey = `sb-staged-v3:${kind}:${provenanceClasses}:${withReveal ? 'r' : 's'}:${confidence ? 'c' : ''}${defs.defines && 'SB_MAT_STRIPES' in defs.defines ? 'm' : ''}:${partCount}`;
    mat.customProgramCacheKey = () => cacheKey;
    mat.userData = { ...(kind === 'reveal' ? mat.userData : {}), [STAMP]: kind, [REVEAL_VARIANT]: withReveal, ...(kind === 'reveal' && base.userData?.[CLAY_FLAG] ? { [CLAY_FLAG]: true } : {}) };
    mat.needsUpdate = true;
    BASE.set(mat, base);
    UNIFORMS.set(mat, uniforms);
    return mat;
}

function setUniforms(mat: THREE.Material, mesh: THREE.Object3D, look: MeshStagedLook, pxScale: number): void {
    const u = UNIFORMS.get(mat);
    if (!u) return;
    const geometry = (mesh as THREE.Mesh).geometry as THREE.BufferGeometry;
    const r = look.reveal;
    u.uSbProgress.value = r ? r.progress : 1;
    u.uSbStagger.value = r ? r.stagger : 0;
    u.uSbFade.value = r ? r.fade : 1;
    u.uSbPresence.value = r ? r.presence : 1;
    u.uSbHasReveal.value = geometry.getAttribute(REVEAL_ATTRIBUTE) ? 1 : 0;
    u.uSbHasDisp.value = geometry.getAttribute(DISP_ATTRIBUTE) && !r?.noDisp ? 1 : 0;
    u.uSbHasRelief.value = geometry.getAttribute(VERTEX_ATTRIBUTE.reliefHeight) ? 1 : 0;
    u.uSbHasProud.value = geometry.getAttribute(VERTEX_ATTRIBUTE.proudBlock) ? 1 : 0;
    u.uSbHasRectify.value = geometry.getAttribute(VERTEX_ATTRIBUTE.rectifyDisplacement) ? 1 : 0;
    u.uSbMark.value = look.mark ? 1 : 0;
    const over = !!r?.overSource;
    if (mat.polygonOffset !== over) {
        mat.polygonOffset = over;
        mat.polygonOffsetFactor = over ? -1 : 0;
        mat.polygonOffsetUnits = over ? -4 : 0;
    }
    u.uSbPxScale.value = pxScale;
    const p = look.provenance;
    if (p && u.uSbClassColor && u.uSbClassPattern) {
        const n = u.uSbClassColor.value.length;
        for (let i = 0; i < n; i++) {
            if (p.classColors[i]) u.uSbClassColor.value[i].copy(p.classColors[i]);
            if (p.classPatterns[i]) u.uSbClassPattern.value[i].copy(p.classPatterns[i]);
        }
    }
    if (p && (mat as THREE.LineBasicMaterial).isLineBasicMaterial && !(mat as THREE.LineBasicMaterial).vertexColors) {
        (mat as THREE.LineBasicMaterial).color.set(p.nodeColor);
    }
    const rc = look.rungs?.colors;
    if (rc && u.uSbRungColor) {
        for (let i = 0; i < u.uSbRungColor.value.length; i++) if (rc[i]) u.uSbRungColor.value[i].copy(rc[i]);
    } else if (rc && (mat as THREE.LineBasicMaterial).isLineBasicMaterial && !(mat as THREE.LineBasicMaterial).vertexColors) {
        (mat as THREE.LineBasicMaterial).color.copy(rc[rc.length - 1]);
    }
}

/**
 * A look that is the same for many meshes and changes nothing per frame (provenance shading of a revealed layer) shares
 * one material per key: every tree of a district then draws with one material instead of a thousand, which keeps the
 * per-draw uniform uploads (and the frame time) at or below the plain clay scene's. Revealing nodes keep their own.
 */
function shareKey(mesh: THREE.Mesh | THREE.LineSegments, base: THREE.Material, look: MeshStagedLook, classCount: number): string | undefined {
    // a merged mesh's material carries its own parts' looks
    if (mergedPartsOf(mesh)) return undefined;
    if (!look.reveal && !look.provenance && look.rungs) {
        // one material per confidence texture (every node of a twin layer that shares its atlas)
        const conf = confidenceMapOf(base);
        const g = mesh.geometry as THREE.BufferGeometry;
        return `rungs|${(mesh as THREE.LineSegments).isLine ? 'line' : 'mesh'}|${(base as THREE.MeshStandardMaterial).side ?? 0}|${conf?.uuid ?? 'flat'}|${g.getAttribute('uv') ? 1 : 0}|${look.mark ? 1 : 0}|${look.rungs.colors.map(c => c.getHexString()).join(',')}`;
    }
    if (look.reveal || !look.provenance) return undefined;
    const g = mesh.geometry as THREE.BufferGeometry;
    const p = look.provenance;
    const flags = [REVEAL_ATTRIBUTE, DISP_ATTRIBUTE, VERTEX_ATTRIBUTE.reliefHeight, VERTEX_ATTRIBUTE.proudBlock, VERTEX_ATTRIBUTE.rectifyDisplacement, 'color']
        .map(a => (g.getAttribute(a) ? 1 : 0)).join('');
    const classes = p.classColors.map((c, i) => `${c.getHexString()}:${p.classPatterns[i]?.x ?? 0}:${(p.classPatterns[i]?.y ?? 0).toFixed(3)}`).join(',');
    return `${(mesh as THREE.LineSegments).isLine ? 'line' : 'mesh'}|${(base as THREE.MeshStandardMaterial).side ?? 0}|${flags}|${classCount}|${p.nodeColor}|${look.mark ? 1 : 0}|${classes}`;
}

/** A reveal at its end: every item shown, no fade, nothing replaced. */
const FULL_REVEAL_LOOK: MeshStagedLook = { reveal: { progress: 1, stagger: 0, fade: 1, presence: 1 } };

/** One part's look in a merged mesh this frame: a staged look, hidden (not started), concealed (replaced) or untouched. */
export type PartLook = MeshStagedLook | 'hide' | 'conceal' | null;

const PART_GREY = new THREE.Color(0x8a8f96);

/**
 * The mesh-level look of a merged mesh and its per-part uniform values: each part's fade, presence, mark and provenance
 * colour and pattern go into the arrays; the mesh-level uniforms carry what every part shares (the class colours of the
 * per-vertex bands, the overSource offset). Hidden parts are not here: setPartVisibility collapses their triangles. Returns
 * null when no shown part needs a staged look.
 */
export function partArrays(looks: readonly PartLook[]): { look: MeshStagedLook; a: Array<[number, number, number, number]>; b: Array<[number, number, number, number]>; fading: boolean } | null {
    const a: Array<[number, number, number, number]> = [];
    const b: Array<[number, number, number, number]> = [];
    let any = false, fading = false, overSource = false, noDisp = false;
    let prov: MeshStagedLook['provenance'];
    let rungs: MeshStagedLook['rungs'];
    for (const l of looks) {
        if (!l || l === 'hide' || l === 'conceal') { a.push([1, 1, 0, 0]); b.push([PART_GREY.r, PART_GREY.g, PART_GREY.b, 0]); continue; }
        any = true;
        const r = l.reveal;
        // a part's reveal is a fade of the whole part (merged parts carry no per-vertex timing)
        const fade = r ? (r.progress <= 0 ? 0 : r.fade * Math.min(1, r.progress)) : 1;
        const presence = r ? r.presence : 1;
        if (fade < 1 || presence < 1) fading = true;
        if (r?.overSource) overSource = true;
        if (r?.noDisp) noDisp = true;
        const p = l.provenance;
        if (p) {
            prov ??= p;
            const c = new THREE.Color(p.nodeColor);
            a.push([fade, presence, l.mark ? 1 : 0, p.nodePattern]);
            b.push([c.r, c.g, c.b, p.nodeCoverage]);
        } else {
            a.push([fade, presence, l.mark ? 1 : 0, 0]);
            b.push([PART_GREY.r, PART_GREY.g, PART_GREY.b, 0]);
        }
        if (l.rungs) rungs ??= l.rungs;
    }
    if (!any) return null;
    const look: MeshStagedLook = {
        ...(fading || overSource ? { reveal: { progress: 1, stagger: 0, fade: 1, presence: 1, ...(overSource ? { overSource: true } : {}), ...(noDisp ? { noDisp: true } : {}) } } : {}),
        ...(prov ? { provenance: prov } : {}),
        ...(rungs && !prov ? { rungs } : {})
    };
    // a mark-only frame (a highlighted part, nothing else staged) still needs a staged material for the per-part mark
    if (!look.reveal && !look.provenance && !look.rungs) look.reveal = { progress: 1, stagger: 0, fade: 1, presence: 1 };
    return { look, a, b, fading };
}

/** The staged materials of one guard, with the base each mesh wore, so every one can be put back. */
export class StagedMaterialRegistry {
    /** Mesh → the material it wore before (its clay or shaded material): what restore() puts back. */
    private readonly meshes = new Map<THREE.Object3D, THREE.Material>();
    private readonly shared = new Map<string, { mat: THREE.Material; refs: number }>();
    private readonly sharedKeyOf = new Map<THREE.Material, string>();
    private readonly keyCache = new WeakMap<THREE.Object3D, { p: MeshStagedLook['provenance']; mark: boolean; base: THREE.Material; key: string | undefined }>();
    /** Bases this registry swapped out that the clay toggle later replaced: freed once nothing uses them. */
    private readonly orphanBases = new Set<THREE.Material>();
    /** Meshes this registry hid (unstarted nodes, superseded layers), so it only ever unhides its own. */
    private readonly hidden = new Set<THREE.Object3D>();
    /** castShadow values taken away while a node reveals (an unrevealed mesh must not cast a shadow). */
    private readonly shadows = new Map<THREE.Object3D, boolean>();
    /** Merged meshes this registry has shown or hidden parts of (applyParts): restoreAll shows every part again. */
    private readonly partMeshes = new Set<THREE.Mesh>();

    /** Meshes this frame that kept their (fully revealed) staged material because the frame's restore budget was spent. */
    private deferred = 0;

    get size(): number { return this.meshes.size; }
    get sharedMaterials(): number { return this.shared.size; }
    /** Meshes still waiting to get their original material back: the guard must stay up until this is 0. */
    get deferredRestores(): number { return this.deferred; }

    /** Starts a frame's accounting of deferred restores. */
    beginFrame(): void { this.deferred = 0; }

    /**
     * Makes `mesh` look as `look` says. Returns true when a new material had to be built (the per-frame budget
     * counts these); with `allowCreate` false and no fitting material yet, the mesh is hidden for this frame.
     */
    apply(mesh: THREE.Mesh | THREE.LineSegments, look: MeshStagedLook | null, opts: { allowCreate: boolean; pxScale: number; classCount: number; restores?: { left: number } }): boolean {
        this.fixClayStash(mesh);
        if (!look || (!look.reveal && !look.provenance && !look.mark && !look.rungs)) {
            // Putting a mesh's own material back disposes it (the renderer releases its program reference), which costs
            // about 20 µs: a district's 2,000 trees would stall the frame their reveal ends. Over the frame's budget a
            // mesh stays on its staged material, drawn fully revealed (identical pixels), and gets its own a frame later.
            const wearing = mesh.material as THREE.Material | THREE.Material[];
            if (opts.restores && !Array.isArray(wearing) && isStagedMaterial(wearing) && !this.sharedKeyOf.has(wearing)) {
                if (opts.restores.left <= 0) {
                    setUniforms(wearing, mesh, FULL_REVEAL_LOOK, opts.pxScale);
                    this.deferred++;
                    return false;
                }
                opts.restores.left--;
            }
            this.restore(mesh);
            return false;
        }
        const current = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(current)) return false;
        const base = isStagedMaterial(current) ? (this.meshes.get(mesh) ?? BASE.get(current) ?? current) : current;
        const wantKind: StagedMaterialKind = look.provenance ? 'provenance' : look.rungs ? 'rungs' : 'reveal';
        // The key depends only on the node's (cached) provenance look, the mark and the mesh: computed once per change.
        const cachedKey = this.keyCache.get(mesh);
        const key = !look.reveal && look.provenance && cachedKey && cachedKey.p === look.provenance && cachedKey.mark === !!look.mark && cachedKey.base === base
            ? cachedKey.key
            : shareKey(mesh, base, look, opts.classCount);
        if (!look.reveal && look.provenance) this.keyCache.set(mesh, { p: look.provenance, mark: !!look.mark, base, key });
        const withReveal = !!look.reveal;
        const fits = isStagedMaterial(current) && stagedKindOf(current) === wantKind && this.sharedKeyOf.get(current) === key
            && current.userData[REVEAL_VARIANT] === withReveal;
        let created = false;
        let mat: THREE.Material | undefined = fits ? current : undefined;
        if (!mat) {
            const entry = key ? this.shared.get(key) : undefined;
            if (!entry && !opts.allowCreate) {
                this.hide(mesh);
                return false;
            }
            this.releaseStaged(mesh, current);
            const previousBase = this.meshes.get(mesh);
            if (previousBase && previousBase !== base) this.retireBase(previousBase, mesh);
            if (entry) {
                entry.refs++;
                mat = entry.mat;
            } else {
                mat = createStagedMaterial(mesh, base, wantKind, opts.classCount, withReveal);
                created = true;
                if (key) {
                    this.shared.set(key, { mat, refs: 1 });
                    this.sharedKeyOf.set(mat, key);
                }
            }
            mesh.material = mat;
            this.meshes.set(mesh, base);
        }
        // A shared material's uniforms are the same for every mesh wearing it: set them when it is made.
        if (!key || created) setUniforms(mat, mesh, look, opts.pxScale);
        this.unhide(mesh);
        const revealing = !!look.reveal && (look.reveal.progress < 1 || look.reveal.fade < 1);
        if (revealing && mesh.castShadow) {
            this.shadows.set(mesh, true);
            mesh.castShadow = false;
        } else if (!revealing && this.shadows.has(mesh)) {
            mesh.castShadow = this.shadows.get(mesh)!;
            this.shadows.delete(mesh);
        }
        return created;
    }

    /**
     * A merged mesh (mergeStagedParts.ts): one look per part. All concealed or all hidden: the mesh is. Otherwise the hidden
     * parts are collapsed in its index (setPartVisibility: no shader work, no shadow, no pick; they stay hidden after the guard
     * is off, as hidden meshes do), and the shown parts get one staged material whose per-part arrays say each one's fade,
     * presence, mark and provenance, or the mesh's own material when none needs a staged look. Returns true when a material
     * was built (counted against the frame's budget).
     */
    applyParts(mesh: THREE.Mesh, looks: readonly PartLook[], opts: { allowCreate: boolean; pxScale: number; classCount: number; restores?: { left: number } }): boolean {
        const table = mergedPartsOf(mesh);
        if (!table) return false;
        this.partMeshes.add(mesh);
        if (looks.length > 0 && looks.every(l => l === 'conceal')) { this.conceal(mesh); return false; }
        if (looks.length > 0 && looks.every(l => l === 'hide' || l === 'conceal')) { this.hide(mesh); return false; }
        setPartVisibility(mesh, i => looks[i] !== 'hide' && looks[i] !== 'conceal');
        const arrays = partArrays(looks);
        if (!arrays) {
            this.apply(mesh, null, opts);
            return false;
        }
        const created = this.apply(mesh, arrays.look, opts);
        const mat = mesh.material as THREE.Material;
        const u = isStagedMaterial(mat) ? UNIFORMS.get(mat) : undefined;
        if (u?.uSbPartA && u.uSbPartB) {
            const n = Math.min(u.uSbPartA.value.length, arrays.a.length);
            for (let i = 0; i < n; i++) { u.uSbPartA.value[i].fromArray(arrays.a[i]); u.uSbPartB.value[i].fromArray(arrays.b[i]); }
        }
        // no shadow from a mesh with parts mid-fade (the depth pass has no dither), as for a revealing node
        if (arrays.fading && mesh.castShadow) {
            this.shadows.set(mesh, true);
            mesh.castShadow = false;
        }
        return created;
    }

    /** Hides a staged mesh (an unstarted node, a superseded layer). Only meshes hidden here are ever unhidden. */
    hide(mesh: THREE.Object3D): void {
        if (!mesh.visible) return;
        mesh.visible = false;
        this.hidden.add(mesh);
    }

    unhide(mesh: THREE.Object3D): void {
        if (this.hidden.delete(mesh)) mesh.visible = true;
    }

    isHiddenHere(mesh: THREE.Object3D): boolean {
        return this.hidden.has(mesh);
    }

    /** Hidden with its original material (a superseded layer): no staged material is kept for it. */
    conceal(mesh: THREE.Object3D): void {
        if (isStagedMaterial((mesh as THREE.Mesh).material as THREE.Material)) {
            const hidden = this.hidden.has(mesh);
            this.restore(mesh);
            if (hidden) this.hidden.add(mesh);
        }
        this.hide(mesh);
    }

    /** Puts the original material back on `mesh` and frees the staged one (a shared one when its last mesh leaves). */
    restore(mesh: THREE.Object3D): void {
        const m = mesh as THREE.Mesh;
        const current = m.material as THREE.Material | THREE.Material[];
        if (isStagedMaterial(current)) {
            const base = this.meshes.get(mesh) ?? BASE.get(current);
            this.releaseStaged(mesh, current);
            if (base) m.material = base;
        }
        this.meshes.delete(mesh);
        this.unhide(mesh);
        if (this.shadows.has(mesh)) {
            mesh.castShadow = this.shadows.get(mesh)!;
            this.shadows.delete(mesh);
        }
    }

    /** Puts every original material back but keeps the meshes it hid hidden (superseded layers stay out of view). */
    restoreMaterials(): void {
        for (const mesh of [...this.meshes.keys()]) {
            const hidden = this.hidden.has(mesh);
            this.restore(mesh);
            if (hidden) { mesh.visible = false; this.hidden.add(mesh); }
        }
        this.freeOrphans();
    }

    /** Restores every mesh this registry touched (provenance off, run changed, unmount). */
    restoreAll(): void {
        for (const mesh of [...this.meshes.keys()]) this.restore(mesh);
        for (const mesh of [...this.hidden]) this.unhide(mesh);
        for (const [mesh, cast] of this.shadows) mesh.castShadow = cast;
        this.shadows.clear();
        for (const mesh of this.partMeshes) setPartVisibility(mesh, () => true);
        this.partMeshes.clear();
        this.freeOrphans();
    }

    /** Forgets meshes whose model was released by the loader (their own materials went with it). */
    prune(isLive: (mesh: THREE.Object3D) => boolean): void {
        if (this.meshes.size === 0 && this.hidden.size === 0 && this.shadows.size === 0 && this.partMeshes.size === 0) return;
        for (const [mesh, base] of [...this.meshes]) {
            if (isLive(mesh)) continue;
            this.meshes.delete(mesh);
            const current = (mesh as THREE.Mesh).material as THREE.Material;
            const key = this.sharedKeyOf.get(current);
            if (key) this.releaseShared(key);
            if (base !== current) base.dispose();
        }
        for (const mesh of [...this.hidden]) if (!isLive(mesh)) this.hidden.delete(mesh);
        for (const mesh of [...this.shadows.keys()]) if (!isLive(mesh)) this.shadows.delete(mesh);
        for (const mesh of [...this.partMeshes]) if (!isLive(mesh)) this.partMeshes.delete(mesh);
        this.freeOrphans();
    }

    /** Lets go of the staged material `mesh` wears: a shared one loses a reference, an own one is disposed. */
    private releaseStaged(mesh: THREE.Object3D, current: THREE.Material | THREE.Material[]): void {
        if (!isStagedMaterial(current)) return;
        const key = this.sharedKeyOf.get(current);
        if (key) this.releaseShared(key);
        else current.dispose();
        void mesh;
    }

    private releaseShared(key: string): void {
        const entry = this.shared.get(key);
        if (!entry) return;
        entry.refs--;
        if (entry.refs <= 0) {
            this.shared.delete(key);
            this.sharedKeyOf.delete(entry.mat);
            entry.mat.dispose();
        }
    }

    /**
     * The clay toggle stashes whatever material a mesh wears as its "authored" one. When that is a staged material,
     * put the real base in the stash instead, so turning clay off never brings back a half-revealed copy.
     */
    private fixClayStash(mesh: THREE.Object3D): void {
        const stash = mesh.userData[CLAY_ORIGINAL_MATERIAL_KEY] as THREE.Material | undefined;
        if (stash && isStagedMaterial(stash)) {
            const base = this.meshes.get(mesh) ?? BASE.get(stash);
            this.releaseStaged(mesh, stash);
            if (base) mesh.userData[CLAY_ORIGINAL_MATERIAL_KEY] = base;
            else delete mesh.userData[CLAY_ORIGINAL_MATERIAL_KEY];
        }
    }

    /** A base the mesh no longer returns to (the clay toggle replaced it): free it once nothing references it. */
    private retireBase(base: THREE.Material, mesh: THREE.Object3D): void {
        const stash = mesh.userData[CLAY_ORIGINAL_MATERIAL_KEY];
        if (stash === base || (mesh as THREE.Mesh).material === base) return;
        this.orphanBases.add(base);
    }

    private freeOrphans(): void {
        const inUse = new Set<THREE.Material>(this.meshes.values());
        for (const base of this.orphanBases) if (!inUse.has(base)) base.dispose();
        this.orphanBases.clear();
    }

    /** Keeps the shared materials' screen-pattern scale current (the pixel ratio can change). */
    updateSharedPixelScale(pxScale: number): void {
        for (const { mat } of this.shared.values()) {
            const u = UNIFORMS.get(mat);
            if (u) u.uSbPxScale.value = pxScale;
        }
    }
}

/**
 * Chains `onFrame` onto `scene.onBeforeRender`: three calls it before it projects the scene, so materials patched here
 * are the ones drawn in this very frame. Returns the uninstaller, which restores the previous hook.
 */
export function installRenderGuard(scene: THREE.Scene, onFrame: (renderer: THREE.WebGLRenderer, camera: THREE.Camera) => void): () => void {
    const previous = scene.onBeforeRender as (...args: unknown[]) => void;
    // three calls Scene.onBeforeRender(renderer, scene, camera, renderTarget); the typings declare Object3D's signature.
    const guard = function (this: THREE.Scene, ...args: unknown[]) {
        previous.apply(this, args);
        onFrame(args[0] as THREE.WebGLRenderer, args[2] as THREE.Camera);
    } as unknown as typeof scene.onBeforeRender;
    (guard as { sbStagedGuard?: boolean }).sbStagedGuard = true;
    scene.onBeforeRender = guard;
    return () => {
        if (scene.onBeforeRender === guard) scene.onBeforeRender = previous;
    };
}
