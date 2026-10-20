/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Reflections made from the place itself (scenes at real places: 3D tiles or geo coordinates).
 *
 * Studio scenes reflect a neutral studio room (syncAtmosphere.ts). At a real place that room would be wrong, so a metal
 * or glass object staged there used to reflect nothing and render dark. Here each object standing in the place (a hero:
 * not a staged layer, not an environment layer) gets its own reflection probe: one cube render of the scene from the
 * object's centre with the object itself hidden (so it sees the street, the staged buildings, the ground and, when an
 * atmosphere is on, its sky), prefiltered (PMREM) and set as the environment of the object's own materials only. The
 * tiles, buildings and trees keep exactly the light they had.
 *
 * Directions where nothing was rendered see a fallback sky gradient, scaled to the scene's own lights. It is drawn only
 * into the probe (as the capture's background, restored in the same call) and labelled `PLACE_REFLECTION_FALLBACK_SOURCE`;
 * it is never the viewport background, and no sky, cloud or fog is added to the scene (AGENTS.md "Zero Uninvited
 * Defaults"): the probe is lighting and reflection only.
 *
 * The same capture (`ReflectionProbeRenderer`) draws the facade material reading's glass probe (facadeMaterialLook.ts),
 * so the facade glass also sees the fallback sky, not the backdrop, where its layer stands alone.
 *
 * Cost: probes are re-rendered only when the scene changes materially (an object loads, moves or is removed, the
 * geometry or textures resident on the GPU change, the atmosphere or render mode changes, or the camera moves far
 * enough for tiles and tree levels to change), once that change has settled, and at most once a second; never every frame.
 *
 * Opt out (for before/after comparisons) with `?sbPlaceReflections=0` or `localStorage['sb.placeReflections'] = '0'`.
 */

import * as THREE from 'three';
import { hasFacadeMaterial } from './stagedBuild/facadeMaterialLook';
import { PLACE_PROBE_SIZE, PLACE_REFLECTION_FALLBACK_SOURCE, ReflectionProbeRenderer, pmremBytes } from './reflectionProbe';

export { PLACE_REFLECTION_FALLBACK_SOURCE } from './reflectionProbe';

/** envMapIntensity of a hero's place probe: the probe holds the scene's own radiance, so it is used as rendered. */
export const PLACE_REFLECTION_INTENSITY = 1.0;
/** A change must hold still this long before the probes are re-rendered. */
export const PLACE_PROBE_SETTLE_MS = 350;
/** Probes are re-rendered at most this often. */
export const PLACE_PROBE_MIN_INTERVAL_MS = 1000;
/** A change that never settles (tiles streaming far away) is taken anyway after this long. */
export const PLACE_PROBE_MAX_STALE_MS = 4000;
/** The camera counts as having moved materially when it moves this share of its distance to the nearest probe. */
const CAMERA_MOVE_SHARE = 0.25;
const PLACE_ENV_KEY = 'sbPlaceEnv';
const PRIOR_KEY = 'sbPlaceEnvPrior';
const HOOK_KEY = 'sbPlaceEnvHook';

/** Opt-out switch (default on). */
export function placeReflectionsEnabled(): boolean {
    try {
        if (typeof window === 'undefined') return true;
        if (/[?&]sbPlaceReflections=0\b/.test(window.location?.search ?? '')) return false;
        return window.localStorage?.getItem('sb.placeReflections') !== '0';
    } catch {
        return true;
    }
}

/** Whether a material takes a hero's place probe: a lit standard/physical surface that is not clay or the facade reading. */
function takesPlaceProbe(m: THREE.Material | undefined): m is THREE.MeshStandardMaterial {
    return !!m && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial === true && !m.userData?.sbClay && !hasFacadeMaterial(m);
}

function materialsOf(mesh: THREE.Mesh): THREE.Material[] {
    return Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
}

/** Sets (or, with no env, restores) a material's environment, remembering what it had. */
function applyEnv(m: THREE.MeshStandardMaterial, env: THREE.Texture | undefined): void {
    const prior = m.userData[PRIOR_KEY] as { envMap: THREE.Texture | null; envMapIntensity: number } | undefined;
    if (env) {
        if (m.envMap === env) return;
        if (!prior) m.userData[PRIOR_KEY] = { envMap: m.envMap, envMapIntensity: m.envMapIntensity };
        m.envMap = env;
        m.envMapIntensity = PLACE_REFLECTION_INTENSITY;
        m.needsUpdate = true;
    } else if (prior) {
        m.envMap = prior.envMap;
        m.envMapIntensity = prior.envMapIntensity;
        delete m.userData[PRIOR_KEY];
        m.needsUpdate = true;
    }
}

/** Whether a root has any surface that takes a place probe. */
export function hasPlaceProbeSurface(root: THREE.Object3D): boolean {
    let has = false;
    root.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (has || !mesh.isMesh || mesh.userData.sbKeepAuthoredMaterial) return;
        if (materialsOf(mesh).some(takesPlaceProbe)) has = true;
    });
    return has;
}

/**
 * Puts the root's probe (root.userData.sbPlaceEnv) on whichever material each of its meshes draws with, at draw time, and
 * restores a material once the probe is gone: the viewport swaps materials for render-mode looks and reveals.
 */
function hookRoot(root: THREE.Object3D): void {
    root.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || mesh.userData[HOOK_KEY] || mesh.userData.sbKeepAuthoredMaterial) return;
        mesh.userData[HOOK_KEY] = true;
        const prior = mesh.onBeforeRender;
        mesh.onBeforeRender = function (...args) {
            const env = root.userData[PLACE_ENV_KEY] as THREE.Texture | undefined;
            for (const m of materialsOf(mesh)) {
                if (takesPlaceProbe(m)) applyEnv(m, env);
                else if (m?.userData?.[PRIOR_KEY]) applyEnv(m as THREE.MeshStandardMaterial, undefined);
            }
            return prior.apply(this, args);
        };
    });
}

function releaseRoot(root: THREE.Object3D): void {
    delete root.userData[PLACE_ENV_KEY];
    root.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        // the drawn materials and the authored ones the clay render mode put aside
        const stashed = mesh.userData.sbClayOriginalMaterial as THREE.Material | THREE.Material[] | undefined;
        const all = [...materialsOf(mesh), ...(Array.isArray(stashed) ? stashed : stashed ? [stashed] : [])];
        for (const m of all) if (m?.userData?.[PRIOR_KEY]) applyEnv(m as THREE.MeshStandardMaterial, undefined);
    });
}

export interface PlaceReflectionsDeps {
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.Camera;
    /** The objects standing in the place that receive a probe (heroes: not staged layers or environment layers). */
    receivers: () => THREE.Object3D[];
    /** Hidden in every capture (gizmos, selection box, brush cursor, grid). */
    overlays?: () => Array<THREE.Object3D | null | undefined>;
    /** Re-rendered with the heroes' probes (the facade glass probe), when given. */
    refreshOthers?: () => void;
    size?: number;
}

export interface PlaceReflectionStats {
    active: boolean;
    probes: number;
    captures: number;
    lastCaptureMs: number;
    meanCaptureMs: number;
    /** GPU bytes of the probes' environments plus the capture's kept working targets. */
    textureBytes: number;
    size: number;
    fallbackSource: string;
}

interface Probe { target: THREE.WebGLRenderTarget; centre: THREE.Vector3; radius: number }

/** The probes of the heroes at a real place and when they are re-rendered (see the file comment). */
export class PlaceReflections {
    private active = false;
    private readonly probes = new Map<THREE.Object3D, Probe>();
    private readonly capturer: ReflectionProbeRenderer;
    private version = 0;
    private lastSig = '';
    private changedAt = 0;
    private pendingSince: number | null = null;
    private lastCaptureAt = -Infinity;
    private captures = 0;
    private lastCaptureMs = 0;
    private totalCaptureMs = 0;
    private readonly box = new THREE.Box3();
    private readonly v = new THREE.Vector3();

    constructor(private readonly d: PlaceReflectionsDeps) {
        this.capturer = new ReflectionProbeRenderer(d.renderer, d.size ?? PLACE_PROBE_SIZE);
    }

    get isActive(): boolean { return this.active; }

    setActive(on: boolean): void {
        if (on === this.active) return;
        this.active = on;
        if (!on) this.clear();
        else this.invalidate();
    }

    /** Something the probes see changed (an object loaded, the atmosphere): re-render once it settles. */
    invalidate(): void { this.version++; }

    private currentReceivers(): THREE.Object3D[] {
        return this.d.receivers().filter(r => !!r.parent && hasPlaceProbeSurface(r));
    }

    /** What the probes see, coarsely: changes when they should be re-rendered. */
    private signature(roots: THREE.Object3D[]): string {
        const mem = this.d.renderer.info?.memory ?? { geometries: 0, textures: 0 };
        const parts: Array<string | number> = [this.version, mem.geometries, mem.textures];
        const cam = this.d.camera.getWorldPosition(this.v);
        let nearest = Infinity;
        for (const r of roots) {
            r.updateWorldMatrix(true, false);
            const e = r.matrixWorld.elements;
            parts.push(r.uuid, Math.round(e[12] * 100), Math.round(e[13] * 100), Math.round(e[14] * 100), Math.round(e[0] * 1000), Math.round(e[2] * 1000));
            const p = this.probes.get(r);
            if (p) nearest = Math.min(nearest, cam.distanceTo(p.centre));
        }
        if (Number.isFinite(nearest)) {
            const step = Math.max(2, nearest * CAMERA_MOVE_SHARE);
            parts.push(Math.round(cam.x / step), Math.round(cam.y / step), Math.round(cam.z / step));
        }
        return parts.join(',');
    }

    /** Called once per frame before the render: cheap unless a re-render is due. */
    tick(now: number): void {
        if (!this.active) return;
        const roots = this.currentReceivers();
        for (const [root] of this.probes) if (!roots.includes(root)) this.drop(root);
        if (!roots.length) return;
        const sig = this.signature(roots);
        if (sig !== this.lastSig) {
            this.lastSig = sig;
            this.changedAt = now;
            this.pendingSince ??= now;
        }
        if (this.pendingSince === null) return;
        const settled = now - this.changedAt >= PLACE_PROBE_SETTLE_MS;
        const overdue = now - this.pendingSince >= PLACE_PROBE_MAX_STALE_MS;
        if ((settled || overdue) && now - this.lastCaptureAt >= PLACE_PROBE_MIN_INTERVAL_MS) {
            this.refresh(roots);
            this.lastCaptureAt = now;
            this.pendingSince = null;
            this.lastSig = this.signature(roots);
        }
    }

    /** Re-renders every hero's probe now (and the others', when given). Returns the number of probes rendered. */
    refresh(roots = this.currentReceivers()): number {
        if (!this.active) return 0;
        const t0 = performance.now();
        const overlays = this.d.overlays?.() ?? [];
        let n = 0;
        for (const root of roots) {
            this.box.setFromObject(root);
            if (this.box.isEmpty()) continue;
            const centre = this.box.getCenter(new THREE.Vector3());
            const radius = this.box.getSize(this.v).length() / 2;
            const prev = this.probes.get(root);
            try {
                const target = this.capturer.capture(this.d.scene, {
                    position: centre,
                    near: Math.max(0.02, Math.min(0.1, radius * 0.05)),
                    far: Math.max(2000, radius * 100),
                    hide: [root, ...overlays]
                }, prev?.target);
                target.texture.name = 'sb-place-reflection-probe';
                target.texture.userData.sbProbeTarget = target;
                this.probes.set(root, { target, centre, radius });
                hookRoot(root);
                root.userData[PLACE_ENV_KEY] = target.texture;
                n++;
            } catch (err) {
                console.warn('[place reflections] the reflection probe failed:', err);
            }
        }
        try { this.d.refreshOthers?.(); } catch (err) { console.warn('[place reflections] the facade glass probe failed:', err); }
        const ms = performance.now() - t0;
        this.captures++;
        this.lastCaptureMs = ms;
        this.totalCaptureMs += ms;
        return n;
    }

    private drop(root: THREE.Object3D): void {
        const p = this.probes.get(root);
        releaseRoot(root);
        p?.target.dispose();
        this.probes.delete(root);
    }

    /** Removes every probe and restores the materials. */
    clear(): void {
        for (const root of [...this.probes.keys()]) this.drop(root);
        this.capturer.dispose();
        this.lastSig = '';
        this.pendingSince = null;
    }

    /** The probe environment of a root, if it has one. */
    probeOf(root: THREE.Object3D): THREE.Texture | undefined {
        return this.probes.get(root)?.target.texture;
    }

    stats(): PlaceReflectionStats {
        let bytes = this.capturer.residentBytes();
        for (const p of this.probes.values()) bytes += pmremBytes(p.target);
        return {
            active: this.active,
            probes: this.probes.size,
            captures: this.captures,
            lastCaptureMs: this.lastCaptureMs,
            meanCaptureMs: this.captures ? this.totalCaptureMs / this.captures : 0,
            textureBytes: bytes,
            size: this.capturer.size,
            fallbackSource: PLACE_REFLECTION_FALLBACK_SOURCE
        };
    }

    dispose(): void {
        this.clear();
        this.active = false;
    }
}
