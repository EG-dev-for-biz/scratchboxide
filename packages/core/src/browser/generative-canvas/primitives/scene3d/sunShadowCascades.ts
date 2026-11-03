/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The sky's sun casts camera-fitted cascaded shadows. One box round the scene's origin gave about 15 cm a texel over
 * a 250 m district, the same at the street as on the skyline: blocky at street level. Here the view is cut into
 * SUN_SHADOW_CASCADES slices by depth (logarithmic splits, so the near ones are short), each slice gets its own square
 * shadow box fitted round it, the boxes share one depth atlas, and the shader (softShadowChunk.ts) picks and blends
 * them by view depth: about 1-4 cm a texel near a street-level camera, coarser only where a texel is under a pixel.
 *
 * Stability: a box is sized from its slice's bounding sphere (the same at any view direction), sized in steps of an
 * eighth of an octave, and centred on whole texels, so moving or turning the camera never makes edges crawl. Each box
 * is also cut down to the content (everything that casts or receives a shadow), so from the air the far slices do not
 * spread their texels over empty ground past the district.
 *
 * three's renderer draws a `SunLight` (isSunLight, type 'SunLight') with an atlas of cascades natively: CascadedSunLight
 * is the sky's DirectionalLight flagged as one, with this file's shadow, so everything that reads the sky's sun as a
 * DirectionalLight keeps working.
 */

import * as THREE from 'three';
import { installSoftShadowChunks, SUN_SHADOW_CASCADES, SUN_SHADOW_MAX_KERNEL_TEXELS } from './softShadowChunk';

export { SUN_SHADOW_CASCADES } from './softShadowChunk';

/** Share of each cascade's depth range over which it blends into the next. */
export const SUN_CASCADE_FADE = 0.1;
/** Blend of logarithmic (1) and uniform (0) splits. */
export const SUN_CASCADE_LAMBDA = 0.95;
/** The second split is never nearer than this, metres: the first cascade does not shrink to the camera's near plane. */
export const SUN_CASCADE_MIN_FIRST_SPLIT_M = 4;
/** Box half-sizes come in steps of 2^(1/8): a dolly changes a box's size now and then, never every frame. */
const SIZE_STEPS_PER_OCTAVE = 8;
/** The content's bounds are read from the scene at most this often, ms. */
const CONTENT_REFRESH_MS = 500;

export interface SunCascadeFitInput {
    /** The view camera, its matrices current. */
    camera: THREE.Camera & { near: number; far: number };
    /** Unit vector from the scene toward the sun, world. */
    toSun: THREE.Vector3;
    /** Texels across one cascade's box. */
    resolution: number;
    /** The farthest view depth that is shadowed, metres. */
    maxDistance: number;
    /** World box of everything that casts or receives shadows; undefined: unbounded (the boxes follow the view alone). */
    content?: THREE.Box3;
    /** Without a content box, how far toward the sun past its slice a box reaches for casters, metres. */
    casterReach: number;
    cascades?: number;
    lambda?: number;
}

export interface SunCascade {
    /** World position of the cascade's shadow camera: over the box's centre, above every caster. */
    position: THREE.Vector3;
    /** Half the side of the square box, metres. */
    halfSize: number;
    near: number;
    far: number;
    /** (begin, end, fade start, 0) in view depth: three's per-cascade shader data. */
    data: THREE.Vector4;
}

export interface SunCascadeFit {
    /** View depths of the slice boundaries, cascades + 1 of them. */
    splits: number[];
    cascades: SunCascade[];
    /** The shadow cameras' rotation: z toward the sun. */
    orientation: THREE.Quaternion;
}

/** The light-space rotation for a sun direction: its z axis toward the sun, its y as near world up as it can be. */
export function sunLightOrientation(toSun: THREE.Vector3, out = new THREE.Matrix4()): THREE.Matrix4 {
    const up = Math.abs(toSun.y) > 0.99 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    return out.lookAt(new THREE.Vector3(0, 0, 0), toSun.clone().negate(), up);
}

/** Practical split scheme: a blend of logarithmic and uniform splits of [near, far]. */
export function sunCascadeSplits(near: number, far: number, cascades: number, lambda = SUN_CASCADE_LAMBDA): number[] {
    const splits = [near];
    const logNear = Math.max(near, 1e-3);
    for (let i = 1; i < cascades; i++) {
        const t = i / cascades;
        const log = logNear * Math.pow(far / logNear, t);
        const uniform = near + (far - near) * t;
        splits.push(lambda * log + (1 - lambda) * uniform);
    }
    splits.push(far);
    if (cascades > 1) splits[1] = Math.min(Math.max(splits[1], SUN_CASCADE_MIN_FIRST_SPLIT_M), (splits[2] + splits[0]) / 2);
    return splits;
}

/** Rounds a half-size up to the next of the fixed steps (2^(k/8) metres). */
export function quantiseHalfSize(h: number): number {
    return Math.pow(2, Math.ceil(Math.log2(Math.max(h, 1e-3)) * SIZE_STEPS_PER_OCTAVE) / SIZE_STEPS_PER_OCTAVE);
}

const NDC_CORNERS: Array<[number, number]> = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/**
 * The view's depth range that holds content: from the camera's near plane (or the content's nearest corner along the
 * view axis) to its farthest corner, with a 1% margin, never past `maxDistance`; with no content, near plane to
 * `maxDistance`. `cut`: the range ends before the content does, so the last cascade fades its shadows out.
 */
function shadowedDepthRange(input: SunCascadeFitInput): { near: number; far: number; cut: boolean } {
    const cam = input.camera;
    const limit = Math.min(cam.far, input.maxDistance);
    let near = cam.near;
    let far = limit;
    if (input.content && !input.content.isEmpty()) {
        const origin = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
        const forward = new THREE.Vector3(0, 0, -1).transformDirection(cam.matrixWorld);
        const b = input.content;
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < 8; i++) {
            const c = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z);
            const d = c.sub(origin).dot(forward);
            lo = Math.min(lo, d); hi = Math.max(hi, d);
        }
        const margin = 0.01 * Math.abs(hi) + 0.5;
        near = Math.max(near, lo - margin);
        far = Math.min(far, hi + margin);
    }
    if (!(far > near)) far = near + 1;
    return { near, far, cut: far >= limit };
}

/**
 * Fits the cascades to the view (pure: the camera's matrices are read, nothing is written to it). Each slice's corners
 * go into light space; its box is the bounding sphere's square, or the slice's overlap with the content when that is
 * smaller, rounded up to a size step and centred on the texel grid; its depth runs from above every caster (the content's
 * sunward top, else `casterReach` past the slice) down to the slice's far side.
 */
export function fitSunCascades(input: SunCascadeFitInput): SunCascadeFit {
    const n = input.cascades ?? SUN_SHADOW_CASCADES;
    const cam = input.camera;
    const rotation = sunLightOrientation(input.toSun.clone().normalize());
    const toLight = rotation.clone().transpose();
    const { near, far, cut } = shadowedDepthRange(input);
    const splits = sunCascadeSplits(near, far, n, input.lambda);

    // the view's corner rays in world space: a point at view depth d on corner k is a + (b - a) * (d - za) / (zb - za)
    const reversed = (cam as { reversedDepth?: boolean }).reversedDepth === true;
    const ndcNear = reversed ? 1 : (cam.coordinateSystem === THREE.WebGPUCoordinateSystem ? 0 : -1);
    const ndcFar = reversed ? 0 : 1;
    const rays = NDC_CORNERS.map(([x, y]) => {
        const a = new THREE.Vector3(x, y, ndcNear).applyMatrix4(cam.projectionMatrixInverse);
        const b = new THREE.Vector3(x, y, ndcFar).applyMatrix4(cam.projectionMatrixInverse);
        return { a, b, za: -a.z, zb: -b.z };
    });
    const at = (k: number, d: number): THREE.Vector3 => {
        const r = rays[k];
        const t = (d - r.za) / (r.zb - r.za);
        return r.a.clone().lerp(r.b, t).applyMatrix4(cam.matrixWorld).applyMatrix4(toLight);
    };

    // the content in light space (an axis-aligned box round its corners)
    let content: THREE.Box3 | undefined;
    if (input.content && !input.content.isEmpty()) {
        content = new THREE.Box3();
        const b = input.content;
        for (let i = 0; i < 8; i++) {
            content.expandByPoint(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(toLight));
        }
    }

    const cascades: SunCascade[] = [];
    let previousFadeStart = splits[0];
    for (let i = 0; i < n; i++) {
        // each slice also covers the previous one's fade band, so both can be read while they blend
        const begin = i === 0 ? splits[0] : previousFadeStart;
        const end = splits[i + 1];
        // the last cascade fades its shadows out only where the shadow distance cuts the content off, not at its far side
        const fadeStart = i === n - 1 && !cut ? end - 1e-3 : end - SUN_CASCADE_FADE * (end - splits[i]);
        previousFadeStart = fadeStart;

        const corners: THREE.Vector3[] = [];
        for (let k = 0; k < 4; k++) corners.push(at(k, begin), at(k, end));
        const slice = new THREE.Box3().setFromPoints(corners);
        const centre = corners.reduce((s, c) => s.add(c), new THREE.Vector3()).multiplyScalar(1 / corners.length);
        let half = Math.sqrt(corners.reduce((m, c) => Math.max(m, c.distanceToSquared(centre)), 0));
        let cx = centre.x, cy = centre.y;
        if (content) {
            const x0 = Math.max(slice.min.x, content.min.x), x1 = Math.min(slice.max.x, content.max.x);
            const y0 = Math.max(slice.min.y, content.min.y), y1 = Math.min(slice.max.y, content.max.y);
            const overlapHalf = Math.max(x1 - x0, y1 - y0) / 2;
            if (x1 > x0 && y1 > y0 && overlapHalf < half) {
                half = overlapHalf; cx = (x0 + x1) / 2; cy = (y0 + y1) / 2;
            }
        }
        // a size step, padded by a texel so snapping the centre never uncovers an edge
        half = quantiseHalfSize(half) * input.resolution / Math.max(1, input.resolution - 2);
        const texel = (2 * half) / input.resolution;
        cx = Math.round(cx / texel) * texel;
        cy = Math.round(cy / texel) * texel;

        const bottom = content ? Math.max(slice.min.z, content.min.z) : slice.min.z;
        let top = content ? content.max.z : slice.max.z + input.casterReach;
        if (!(top > bottom)) top = bottom + 1;
        const standOff = 1;
        const position = new THREE.Vector3(cx, cy, top + standOff).applyMatrix4(rotation);
        cascades.push({
            position,
            halfSize: half,
            near: standOff / 2,
            far: top + standOff - bottom + standOff,
            data: new THREE.Vector4(i === 0 ? -1e10 : begin, end, fadeStart, 0)
        });
    }
    return { splits, cascades, orientation: new THREE.Quaternion().setFromRotationMatrix(rotation) };
}

/** World box of the visible meshes under `root` that cast or receive shadows (the sky dome, glare and helpers do neither). */
export function shadowContentBounds(root: THREE.Object3D, out = new THREE.Box3()): THREE.Box3 {
    out.makeEmpty();
    const box = new THREE.Box3();
    root.traverseVisible(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !(mesh.castShadow || mesh.receiveShadow) || o.userData?.isHelper) return;
        const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
        if (!geometry?.getAttribute?.('position')) return;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        if (!geometry.boundingBox || geometry.boundingBox.isEmpty()) return;
        out.union(box.copy(geometry.boundingBox).applyMatrix4(mesh.matrixWorld));
    });
    return out;
}

/** three's LightShadow internals a multi-viewport shadow sets (not in its typings). */
interface LightShadowInternals {
    _frameExtents: THREE.Vector2;
    _viewportCount: number;
    _viewports: THREE.Vector4[];
    _frustum: THREE.Frustum;
    _updateMatrix(camera: THREE.Camera, matrix: THREE.Matrix4, frustum: THREE.Frustum, viewport?: THREE.Vector4): void;
}

/**
 * The cascades as three's renderer reads a SunLight's shadow: one depth atlas of 2 x 2 tiles of `mapSize` each, a camera,
 * matrix and frustum per tile, and `_cascadeData` (begin, end, fade start) per cascade. `camera` is kept as the box round
 * all of them (what the tree level-of-detail culling and the triangle budget take for the shadow pass's view).
 * `bias` and `normalBias` are in shadow texels of each cascade, `radius` is the softness (1: the sun's own disc).
 */
export class SunCascadeShadow extends THREE.LightShadow<THREE.OrthographicCamera> {
    readonly isSunCascadeShadow = true;
    /** The farthest view depth that is shadowed, metres. */
    maxDistance = 1500;
    /** Without content bounds, how far toward the sun casters are looked for, metres. */
    casterReach = 1000;
    _cameras: THREE.OrthographicCamera[] = [];
    _matrices: THREE.Matrix4[] = [];
    _frustums: THREE.Frustum[] = [];
    _cascadeData: THREE.Vector4[] = [];
    /** The last fit, for diagnostics and tests. */
    lastFit: SunCascadeFit | null = null;
    private content = new THREE.Box3();
    private contentReadAt = -Infinity;

    constructor() {
        super(new THREE.OrthographicCamera(-5, 5, 5, -5, 0.5, 500));
        installSoftShadowChunks();
        this.mapSize.set(2048, 2048);
        this.bias = 0.5;
        this.normalBias = 1;
        const internals = this as unknown as LightShadowInternals;
        internals._viewportCount = SUN_SHADOW_CASCADES;
        internals._frameExtents.set(2, Math.ceil(SUN_SHADOW_CASCADES / 2));
        for (let i = 0; i < SUN_SHADOW_CASCADES; i++) {
            this._cameras.push(new THREE.OrthographicCamera());
            this._matrices.push(new THREE.Matrix4());
            this._frustums.push(new THREE.Frustum());
            this._cascadeData.push(new THREE.Vector4());
        }
        while (internals._viewports.length < SUN_SHADOW_CASCADES) internals._viewports.push(new THREE.Vector4());
    }

    override getCamera(cascade = 0): THREE.OrthographicCamera { return this._cameras[cascade]; }
    getMatrix(cascade = 0): THREE.Matrix4 { return this._matrices[cascade]; }
    override getFrustum(cascade = 0): THREE.Frustum { return this._frustums[cascade]; }

    /** Reads the content's bounds now (the next shadow pass would otherwise wait up to CONTENT_REFRESH_MS). */
    invalidateContent(): void { this.contentReadAt = -Infinity; }

    override updateMatrices(light: THREE.Light, viewCamera?: THREE.Camera): void {
        if (!viewCamera || (viewCamera as THREE.PerspectiveCamera).near === undefined) return;
        const internals = this as unknown as LightShadowInternals;
        // each tile inset by the widest filter, so a kernel never reads a neighbouring cascade
        const inset = Math.min(0.25, (SUN_SHADOW_MAX_KERNEL_TEXELS + 2) / this.mapSize.x);
        for (let i = 0; i < SUN_SHADOW_CASCADES; i++) internals._viewports[i].set((i % 2) + inset, Math.floor(i / 2) + inset, 1 - 2 * inset, 1 - 2 * inset);
        const resolution = this.mapSize.x * (1 - 2 * inset);

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - this.contentReadAt >= CONTENT_REFRESH_MS) {
            let root: THREE.Object3D = light;
            while (root.parent) root = root.parent;
            shadowContentBounds(root, this.content);
            this.contentReadAt = now;
        }
        light.updateMatrixWorld();
        const toSun = new THREE.Vector3().setFromMatrixPosition(light.matrixWorld);
        if (toSun.lengthSq() === 0) toSun.set(0, 1, 0);
        const fit = fitSunCascades({
            camera: viewCamera as THREE.PerspectiveCamera,
            toSun: toSun.normalize(),
            resolution,
            maxDistance: this.maxDistance,
            content: this.content.isEmpty() ? undefined : this.content,
            casterReach: this.casterReach
        });
        this.lastFit = fit;

        const reversed = this.camera.reversedDepth;
        const union = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, top: -Infinity, bottom: Infinity };
        const toLight = new THREE.Matrix4().makeRotationFromQuaternion(fit.orientation).transpose();
        fit.cascades.forEach((c, i) => {
            const cam = this._cameras[i];
            cam.position.copy(c.position);
            cam.quaternion.copy(fit.orientation);
            cam.left = -c.halfSize; cam.right = c.halfSize; cam.top = c.halfSize; cam.bottom = -c.halfSize;
            cam.near = c.near; cam.far = c.far;
            cam.coordinateSystem = this.camera.coordinateSystem;
            (cam as unknown as { _reversedDepth: boolean })._reversedDepth = reversed;
            cam.updateProjectionMatrix();
            cam.updateMatrixWorld(true);
            this._cascadeData[i].copy(c.data);
            internals._updateMatrix(cam, this._matrices[i], this._frustums[i], internals._viewports[i]);
            const p = c.position.clone().applyMatrix4(toLight);
            union.minX = Math.min(union.minX, p.x - c.halfSize); union.maxX = Math.max(union.maxX, p.x + c.halfSize);
            union.minY = Math.min(union.minY, p.y - c.halfSize); union.maxY = Math.max(union.maxY, p.y + c.halfSize);
            union.top = Math.max(union.top, p.z); union.bottom = Math.min(union.bottom, p.z - c.far);
        });
        const cover = this.camera;
        const hx = (union.maxX - union.minX) / 2, hy = (union.maxY - union.minY) / 2;
        cover.position.set((union.minX + union.maxX) / 2, (union.minY + union.maxY) / 2, union.top).applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(fit.orientation));
        cover.quaternion.copy(fit.orientation);
        cover.left = -hx; cover.right = hx; cover.top = hy; cover.bottom = -hy;
        cover.near = 0; cover.far = union.top - union.bottom;
        cover.updateProjectionMatrix();
        cover.updateMatrixWorld(true);
        internals._updateMatrix(cover, this.matrix, internals._frustum);
    }

    override copy(source: SunCascadeShadow): this {
        super.copy(source);
        this.maxDistance = source.maxDistance;
        this.casterReach = source.casterReach;
        return this;
    }
}

/**
 * The sky's sun as a DirectionalLight that three draws as a SunLight (cascaded shadows, shining from its position toward
 * the origin, as the sky's sun with its target at the origin already did).
 */
export class CascadedSunLight extends THREE.DirectionalLight {
    readonly isSunLight = true;

    constructor(color?: THREE.ColorRepresentation, intensity?: number) {
        super(color, intensity);
        (this as { type: string }).type = 'SunLight';
        this.shadow = new SunCascadeShadow() as unknown as THREE.DirectionalLightShadow;
    }

    get cascades(): SunCascadeShadow { return this.shadow as unknown as SunCascadeShadow; }
}

export function isCascadedSunShadow(shadow: unknown): shadow is SunCascadeShadow {
    return (shadow as { isSunCascadeShadow?: boolean } | null)?.isSunCascadeShadow === true;
}
