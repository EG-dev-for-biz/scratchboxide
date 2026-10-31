/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Masks of scene content that post passes must treat apart, drawn alone (with its own materials) over a transparent
 * clear, so the mask's alpha is the content's coverage:
 *  - content that writes no depth (Gaussian splats: sorted, blended, depthWrite false), which a pass telling objects from
 *    the sky by depth would take for sky. Content opts in with `userData[DEPTHLESS_CONTENT_KEY]`; the sky never does;
 *  - content drawn with tone mapping off (`material.toneMapped === false`: the staged build's provenance views), which
 *    three.js leaves un-tone-mapped when drawing to the canvas but the optics chain would tone-map with the rest;
 *  - content whose shader writes final display values (a custom shader with no output colour-space conversion: Gaussian
 *    splats, whose colours are trained against sRGB photos), which the chain would tone-map and encode a second time.
 * The mask's depth is filled from the scene's depth first, pushed back a little, so content hidden behind other geometry
 * is not in it.
 */

import * as THREE from 'three';

export const DEPTHLESS_CONTENT_KEY = 'sbDepthlessContent';
/** How far the scene's depth is pushed back before the mask is drawn against it: a share of the view distance, plus metres. */
export const MASK_DEPTH_SLACK = { relative: 1e-3, metres: 1e-3 };

/** The visible objects under `root` that opted in as depthless content, in scene order. */
export function findDepthlessContent(root: THREE.Object3D): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    root.traverseVisible(o => { if (o.userData?.[DEPTHLESS_CONTENT_KEY]) out.push(o); });
    return out;
}

/** True for a material whose shader writes final display values: a custom shader with no output colour-space conversion. */
export function writesDisplayValues(m: THREE.Material): boolean {
    const shader = m as THREE.ShaderMaterial;
    if (shader.isShaderMaterial !== true || typeof shader.fragmentShader !== 'string') return false;
    return !/colorspace_fragment|linearToOutputTexel/.test(shader.fragmentShader);
}

/**
 * The visible meshes, lines and points under `root` the output must not tone-map, in scene order: `untoned` (tone mapping
 * off, the colour space still converted) and `display` (final display values: neither tone-mapped nor converted). Only
 * content that covers what is behind it (normal blending, or none): additive light is tone-mapped with what it adds to,
 * as its coverage cannot say how much of the pixel is its own. Objects under `exclude` (overlays) are skipped.
 */
export function findToneMapExemptContent(root: THREE.Object3D, exclude: ReadonlySet<THREE.Object3D> = new Set()): { untoned: THREE.Object3D[]; display: THREE.Object3D[] } {
    const untoned: THREE.Object3D[] = [], display: THREE.Object3D[] = [];
    const skip = (o: THREE.Object3D): boolean => {
        for (let p: THREE.Object3D | null = o; p; p = p.parent) if (exclude.has(p)) return true;
        return false;
    };
    root.traverseVisible(o => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (!m || (exclude.size > 0 && skip(o))) return;
        const mats = (Array.isArray(m) ? m : [m]).filter(x => x && x.visible !== false && (x.blending === THREE.NormalBlending || x.blending === THREE.NoBlending));
        if (mats.some(writesDisplayValues)) display.push(o);
        else if (mats.some(x => x.toneMapped === false)) untoned.push(o);
    });
    return { untoned, display };
}

/** True when two lists hold the same objects in the same order (one mask then serves both). */
export function sameContent(a: THREE.Object3D[], b: THREE.Object3D[]): boolean {
    return a.length === b.length && a.every((o, i) => o === b[i]);
}

const DEPTH_FILL = {
    vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `,
    fragmentShader: /* glsl */ `
        #include <packing>
        uniform sampler2D tDepth;
        uniform float uNear;
        uniform float uFar;
        uniform float uRelative;
        uniform float uMetres;
        varying vec2 vUv;
        void main() {
            float d = texture2D(tDepth, vUv).x;
            if (d >= 1.0) { gl_FragDepthEXT = 1.0; return; }
            // view distance (positive), pushed back, then back to window depth
            float dist = -perspectiveDepthToViewZ(d, uNear, uFar);
            dist = dist * (1.0 + uRelative) + uMetres;
            gl_FragDepthEXT = clamp(viewZToPerspectiveDepth(-dist, uNear, uFar), 0.0, 1.0);
            gl_FragColor = vec4(0.0);
        }
    `
};

let depthFill: { scene: THREE.Scene; camera: THREE.OrthographicCamera; material: THREE.ShaderMaterial } | null = null;
function depthFillQuad() {
    if (!depthFill) {
        const material = new THREE.ShaderMaterial({
            uniforms: { tDepth: { value: null }, uNear: { value: 0.1 }, uFar: { value: 1000 }, uRelative: { value: MASK_DEPTH_SLACK.relative }, uMetres: { value: MASK_DEPTH_SLACK.metres } },
            vertexShader: DEPTH_FILL.vertexShader,
            fragmentShader: DEPTH_FILL.fragmentShader,
            depthTest: true,
            depthFunc: THREE.AlwaysDepth,
            depthWrite: true,
            colorWrite: false
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        mesh.frustumCulled = false;
        const scene = new THREE.Scene();
        scene.add(mesh);
        depthFill = { scene, camera: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material };
    }
    return depthFill;
}

/**
 * Draws `objects` (with their own materials) into `target` over a transparent clear: its alpha is their coverage. With
 * `sceneDepth` (the scene draw's depth, same frame) the target's depth is filled from it first, so objects behind other
 * geometry are left out. Returns false (target untouched) when there is nothing to draw.
 */
export function renderContentMask(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, objects: THREE.Object3D[], target: THREE.WebGLRenderTarget, sceneDepth: THREE.Texture | null): boolean {
    if (objects.length === 0) return false;
    const clearColour = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    try {
        renderer.setRenderTarget(target);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, true, false);
        renderer.autoClear = false;
        if (sceneDepth) {
            const fill = depthFillQuad();
            const u = fill.material.uniforms;
            u.tDepth.value = sceneDepth;
            u.uNear.value = camera.near;
            u.uFar.value = camera.far;
            renderer.render(fill.scene, fill.camera);
        }
        for (const o of objects) renderer.render(o, camera);
    } finally {
        renderer.autoClear = autoClear;
        renderer.setClearColor(clearColour, clearAlpha);
    }
    return true;
}
