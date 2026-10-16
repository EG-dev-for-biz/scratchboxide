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
import { DEGRADED_OUTLINE_COLOR, PROVENANCE_BACKGROUND, VERTEX_ATTRIBUTE, STRIPE_COVERAGE, STRIPE_PERIOD_PX, hexToRgb01, vertexClassGlsl } from './provenanceShading';

/** Stamp on every material the guard installs; its value says which variant. */
const STAMP = 'sbStagedPatch';
/** Mirrors ORIGINAL_KEY in clayRenderMode.ts (as disposeObject.ts does): the authored material stashed under clay. */
const CLAY_ORIGINAL_MATERIAL_KEY = 'sbClayOriginalMaterial';
const CLAY_FLAG = 'sbClay';

/** _REVEAL and _DISP as three's GLTFLoader names them (it lowercases custom attributes). */
export const REVEAL_ATTRIBUTE = '_reveal';
export const DISP_ATTRIBUTE = '_disp';

export type StagedMaterialKind = 'reveal' | 'provenance';

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
#ifdef SB_PROVENANCE
attribute float ${VERTEX_ATTRIBUTE.reliefHeight};
attribute float ${VERTEX_ATTRIBUTE.proudBlock};
attribute float ${VERTEX_ATTRIBUTE.rectifyDisplacement};
uniform float uSbHasRelief;
uniform float uSbHasProud;
uniform float uSbHasRectify;
flat varying float vSbClass;
#endif
`;

const VERTEX_BODY = `
    {
        float sbItemStart = ${REVEAL_ATTRIBUTE}.x * uSbStagger;
        float sbLocal = clamp((uSbProgress - sbItemStart) / max(1e-4, 1.0 - uSbStagger), 0.0, 1.0);
        transformed -= uSbHasDisp * ${DISP_ATTRIBUTE} * (1.0 - sbLocal);
        vSbRevealK = uSbHasReveal * (${REVEAL_ATTRIBUTE}.x * uSbStagger + ${REVEAL_ATTRIBUTE}.y * (1.0 - uSbStagger));
    }
#ifdef SB_PROVENANCE
    {${vertexClassGlsl()}
    }
#endif
`;

const FRAGMENT_DECL = `
uniform float uSbProgress;
uniform float uSbFade;
uniform float uSbPresence;
uniform float uSbMark;
uniform float uSbPxScale;
uniform vec3 uSbBackground;
uniform vec3 uSbMarkColor;
varying float vSbRevealK;
#ifdef SB_PROVENANCE
uniform vec3 uSbClassColor[SB_CLASSES];
uniform vec2 uSbClassPattern[SB_CLASSES];
flat varying float vSbClass;
#endif
float sbDither(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
bool sbStripe(vec2 p, float period, float coverage, float dir) { return mod(p.x + dir * p.y, period) < coverage * period; }
bool sbDot(vec2 p, float period, float coverage) {
    vec2 c = mod(p, period) - 0.5 * period;
    return length(c) < sqrt(coverage * period * period / 3.14159265);
}
`;

const FRAGMENT_DISCARD = `
    if (uSbProgress <= 0.0 || (uSbProgress < 1.0 && vSbRevealK >= uSbProgress)) discard;
    {
        float sbH = sbDither(gl_FragCoord.xy);
        if (sbH >= uSbFade || sbH < 1.0 - uSbPresence) discard;
    }
`;

const FRAGMENT_PROVENANCE_COLOR = `
#ifdef SB_PROVENANCE
    int sbCls = int(vSbClass + 0.5);
    vec4 diffuseColor = vec4( uSbClassColor[sbCls], opacity );
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
#ifdef SB_PROVENANCE
    totalEmissiveRadiance += diffuseColor.rgb * ${PROVENANCE_LIGHT_FLOOR.toFixed(2)};
#endif
`;

const FRAGMENT_END = `
    {
        vec2 sbP = gl_FragCoord.xy / max(uSbPxScale, 1e-3);
#ifdef SB_PROVENANCE
        vec2 sbPat = uSbClassPattern[int(vSbClass + 0.5)];
        bool sbGap = false;
        if (sbPat.x > 0.5 && sbPat.x < 1.5) sbGap = sbStripe(sbP, ${STRIPE_PERIOD_PX.toFixed(1)}, ${STRIPE_COVERAGE.toFixed(3)}, 1.0);
        else if (sbPat.x > 1.5 && sbPat.x < 2.5) sbGap = sbStripe(sbP, ${STRIPE_PERIOD_PX.toFixed(1)}, ${STRIPE_COVERAGE.toFixed(3)}, 1.0) || sbStripe(sbP, ${STRIPE_PERIOD_PX.toFixed(1)}, ${STRIPE_COVERAGE.toFixed(3)}, -1.0);
        if (sbPat.y > 0.0 && sbDot(sbP + vec2(3.0), ${STRIPE_PERIOD_PX.toFixed(1)}, sbPat.y)) sbGap = true;
        if (sbGap) gl_FragColor.rgb = uSbBackground;
#endif
        if (uSbMark > 0.5 && sbStripe(sbP, 10.0, 0.2, -1.0)) gl_FragColor.rgb = uSbMarkColor;
    }
`;

function injectShader(shader: THREE.WebGLProgramParametersWithUniforms, uniforms: StagedUniforms): void {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${VERTEX_DECL}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERTEX_BODY}`);
    shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${FRAGMENT_DECL}`)
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', FRAGMENT_PROVENANCE_COLOR)
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
export function createStagedMaterial(mesh: THREE.Mesh | THREE.LineSegments, base: THREE.Material, kind: StagedMaterialKind, classCount: number): THREE.Material {
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const isLine = (mesh as THREE.LineSegments).isLine === true;
    let mat: THREE.Material;
    if (kind === 'reveal') {
        mat = base.clone();
    } else if (isLine) {
        const hasColor = !!geometry.getAttribute('color');
        mat = new THREE.LineBasicMaterial({ vertexColors: hasColor, color: 0xffffff });
    } else {
        mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, side: (base as THREE.MeshStandardMaterial).side ?? THREE.FrontSide });
        mat.toneMapped = false;
    }
    const uniforms = makeUniforms();
    const provenanceClasses = kind === 'provenance' && !isLine ? Math.max(1, classCount) : 0;
    if (provenanceClasses > 0) {
        uniforms.uSbClassColor = { value: Array.from({ length: provenanceClasses }, () => new THREE.Color(0xffffff)) };
        uniforms.uSbClassPattern = { value: Array.from({ length: provenanceClasses }, () => new THREE.Vector2(0, 0)) };
        (mat as THREE.Material & { defines?: Record<string, unknown> }).defines = {
            ...((mat as THREE.Material & { defines?: Record<string, unknown> }).defines ?? {}),
            SB_PROVENANCE: '',
            SB_CLASSES: provenanceClasses
        };
    }
    mat.onBeforeCompile = shader => injectShader(shader, uniforms);
    const cacheKey = `sb-staged-v2:${kind}:${provenanceClasses}`;
    mat.customProgramCacheKey = () => cacheKey;
    mat.userData = { ...(kind === 'reveal' ? mat.userData : {}), [STAMP]: kind, ...(kind === 'reveal' && base.userData?.[CLAY_FLAG] ? { [CLAY_FLAG]: true } : {}) };
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
    u.uSbHasDisp.value = geometry.getAttribute(DISP_ATTRIBUTE) ? 1 : 0;
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
}

/** The staged materials of one guard, with the base each replaced, so every one can be put back. */
export class StagedMaterialRegistry {
    private readonly meshes = new Map<THREE.Object3D, THREE.Material>();
    /** Bases this registry swapped out that the clay toggle later replaced: freed once nothing uses them. */
    private readonly orphanBases = new Set<THREE.Material>();
    /** Meshes this registry hid (unstarted nodes, superseded layers), so it only ever unhides its own. */
    private readonly hidden = new Set<THREE.Object3D>();
    /** castShadow values taken away while a node reveals (an unrevealed mesh must not cast a shadow). */
    private readonly shadows = new Map<THREE.Object3D, boolean>();

    get size(): number { return this.meshes.size; }

    /**
     * Makes `mesh` look as `look` says. Returns true when a new material had to be built (the per-frame budget
     * counts these); with `allowCreate` false and no fitting material yet, the mesh is hidden for this frame.
     */
    apply(mesh: THREE.Mesh | THREE.LineSegments, look: MeshStagedLook | null, opts: { allowCreate: boolean; pxScale: number; classCount: number }): boolean {
        this.fixClayStash(mesh);
        const current = mesh.material as THREE.Material | THREE.Material[];
        if (!look || (!look.reveal && !look.provenance && !look.mark)) {
            this.restore(mesh);
            return false;
        }
        const wantKind: StagedMaterialKind = look.provenance ? 'provenance' : 'reveal';
        let mat: THREE.Material | undefined = isStagedMaterial(current) && stagedKindOf(current) === wantKind ? current : undefined;
        let created = false;
        if (!mat) {
            if (!opts.allowCreate) {
                this.hide(mesh);
                return false;
            }
            if (Array.isArray(current)) return false;
            let base = current;
            if (isStagedMaterial(current)) {
                base = BASE.get(current) ?? current;
                current.dispose();
            }
            const previousBase = this.meshes.get(mesh);
            if (previousBase && previousBase !== base) this.retireBase(previousBase, mesh);
            mat = createStagedMaterial(mesh, base, wantKind, opts.classCount);
            mesh.material = mat;
            this.meshes.set(mesh, base);
            created = true;
        }
        setUniforms(mat, mesh, look, opts.pxScale);
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

    /** Puts every original material back but keeps the meshes it hid hidden (superseded layers stay out of view). */
    restoreMaterials(): void {
        for (const mesh of [...this.meshes.keys()]) {
            const hidden = this.hidden.has(mesh);
            this.restore(mesh);
            if (hidden) { mesh.visible = false; this.hidden.add(mesh); }
        }
        this.freeOrphans();
    }

    /** Unhides only meshes for which `keep` is false (used when the guard comes off with unstarted nodes hidden). */
    unhideUnless(keep: (mesh: THREE.Object3D) => boolean): void {
        for (const mesh of [...this.hidden]) if (!keep(mesh)) this.unhide(mesh);
    }

    /** Puts the original material back on `mesh` and frees the staged one. */
    restore(mesh: THREE.Object3D): void {
        const m = mesh as THREE.Mesh;
        const current = m.material as THREE.Material | THREE.Material[];
        if (isStagedMaterial(current)) {
            const base = BASE.get(current);
            current.dispose();
            if (base) m.material = base;
        }
        this.meshes.delete(mesh);
        this.unhide(mesh);
        if (this.shadows.has(mesh)) {
            mesh.castShadow = this.shadows.get(mesh)!;
            this.shadows.delete(mesh);
        }
    }

    /** Restores every mesh this registry touched (provenance off, run changed, unmount). */
    restoreAll(): void {
        for (const mesh of [...this.meshes.keys()]) this.restore(mesh);
        for (const mesh of [...this.hidden]) this.unhide(mesh);
        for (const [mesh, cast] of this.shadows) mesh.castShadow = cast;
        this.shadows.clear();
        this.freeOrphans();
    }

    /** Forgets meshes whose model was released by the loader (their materials went with it). */
    prune(isLive: (mesh: THREE.Object3D) => boolean): void {
        if (this.meshes.size === 0 && this.hidden.size === 0 && this.shadows.size === 0) return;
        for (const [mesh, base] of [...this.meshes]) {
            if (isLive(mesh)) continue;
            this.meshes.delete(mesh);
            if (base !== (mesh as THREE.Mesh).material) base.dispose();
        }
        for (const mesh of [...this.hidden]) if (!isLive(mesh)) this.hidden.delete(mesh);
        for (const mesh of [...this.shadows.keys()]) if (!isLive(mesh)) this.shadows.delete(mesh);
        this.freeOrphans();
    }

    /**
     * The clay toggle stashes whatever material a mesh wears as its "authored" one. When that is a staged material,
     * put the real base in the stash instead, so turning clay off never brings back a half-revealed copy.
     */
    private fixClayStash(mesh: THREE.Object3D): void {
        const stash = mesh.userData[CLAY_ORIGINAL_MATERIAL_KEY] as THREE.Material | undefined;
        if (stash && isStagedMaterial(stash)) {
            const base = BASE.get(stash);
            stash.dispose();
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
