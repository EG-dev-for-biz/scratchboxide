/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import type { RendererStack } from './types';

/** The viewport camera's vertical field of view when the scene names none. */
export const DEFAULT_CAMERA_FOV_DEG = 45;

export interface CreateRendererStackOptions {
    container: HTMLElement;
    /** Initial camera position; orbit mode overrides it every frame from the orbit state. */
    cameraPosition?: [number, number, number];
}

/**
 * Creates the long-lived three.js stack for a Scene3D viewport: Scene, PerspectiveCamera,
 * WebGLRenderer (appended to `container`) and the shared GridHelper.
 *
 * This is the ONLY place a WebGLRenderer is constructed for the primitive. It must run once per
 * mount; per-slice content (atmosphere, tiles, meshes, shaders) is synchronised separately by
 * mutating the returned scene.
 *
 * @throws when WebGL is unavailable: the caller shows the error in the viewport. There is no stand-in canvas.
 */
export function createRendererStack(options: CreateRendererStackOptions): RendererStack {
    const { container } = options;
    const width = container.clientWidth || 500;
    const height = container.clientHeight || 450;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(DEFAULT_CAMERA_FOV_DEG, width / height, 0.1, 20000);
    const [px, py, pz] = options.cameraPosition || [15, 12, 15];
    camera.position.set(px, py, pz);

    let renderer: THREE.WebGLRenderer;
    const instantiateRenderer = (opts: THREE.WebGLRendererParameters) => new THREE.WebGLRenderer(opts);
    try {
        renderer = instantiateRenderer({
            antialias: true,
            alpha: false,
            powerPreference: 'high-performance',
            preserveDrawingBuffer: true
        });
        renderer.setSize(width, height);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.shadowMap.enabled = true;
        // PCFSoftShadowMap was removed in three r186 (it silently fell back to PCFShadowMap). Under the sky's sun
        // syncAtmosphere switches to BasicShadowMap, whose raw depth the soft sun filter reads (softShadowChunk.ts).
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        renderer.domElement.style.display = 'block';
        container.appendChild(renderer.domElement);
    } catch (first) {
        // One retry without antialiasing and without failing on a major performance caveat (software or blocklisted
        // GPUs). If that cannot get a WebGL context either, the error goes to the caller: nothing stands in for it.
        try {
            renderer = instantiateRenderer({
                antialias: false,
                failIfMajorPerformanceCaveat: false
            });
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            const firstReason = first instanceof Error ? first.message : String(first);
            throw new Error(reason === firstReason ? reason : `${reason} (first attempt: ${firstReason})`);
        }
        renderer.setSize(width, height);
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        renderer.domElement.style.display = 'block';
        container.appendChild(renderer.domElement);
    }

    // Grid colours are re-tinted and visibility toggled by syncAtmosphere.
    const gridHelper = new THREE.GridHelper(30, 30, 0x3f3f5a, 0x1f1f2c);
    gridHelper.position.y = -1;
    gridHelper.name = 'sb-grid-helper';
    scene.add(gridHelper);

    const dispose = () => {
        scene.remove(gridHelper);
        gridHelper.geometry.dispose();
        (gridHelper.material as THREE.Material).dispose();
        renderer.dispose();
        if (renderer.domElement && container.contains(renderer.domElement)) {
            container.removeChild(renderer.domElement);
        }
    };

    return { container, scene, camera, renderer, gridHelper, dispose };
}

/**
 * Keeps the renderer/camera sized to the container (ResizeObserver + window resize).
 * `onResize` lets slices with their own render targets (aerial perspective) follow along.
 */
export function attachViewportResize(
    stack: RendererStack,
    onResize?: (width: number, height: number) => void
): () => void {
    const { container, camera, renderer } = stack;

    const handleResize = () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w === 0 || h === 0) return;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h, false);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        onResize?.(w, h);
    };

    window.addEventListener('resize', handleResize);
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);
    requestAnimationFrame(handleResize);

    return () => {
        window.removeEventListener('resize', handleResize);
        resizeObserver.disconnect();
    };
}

/** Per-frame guard: resize the drawing buffer if the container changed without an event. */
export function reconcileDrawingBufferSize(stack: RendererStack): void {
    const { container, camera, renderer } = stack;
    const currentW = container.clientWidth;
    const currentH = container.clientHeight;
    if (currentW <= 0 || currentH <= 0) return;
    const dpr = Math.min(window.devicePixelRatio, 2);
    if (renderer.domElement.width !== Math.floor(currentW * dpr) || renderer.domElement.height !== Math.floor(currentH * dpr)) {
        camera.aspect = currentW / currentH;
        camera.updateProjectionMatrix();
        renderer.setSize(currentW, currentH, false);
    }
}
