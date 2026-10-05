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
 * @throws when WebGL is unavailable (the caller falls back to the 2D canvas).
 */
export function createRendererStack(options: CreateRendererStackOptions): RendererStack {
    const { container } = options;
    const width = container.clientWidth || 500;
    const height = container.clientHeight || 450;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 20000);
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
        // PCFSoftShadowMap was removed in three r186 (it silently fell back to PCFShadowMap).
        renderer.shadowMap.type = THREE.PCFShadowMap;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.0;
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        renderer.domElement.style.display = 'block';
        container.appendChild(renderer.domElement);
    } catch {
        try {
            renderer = instantiateRenderer({
                antialias: false,
                failIfMajorPerformanceCaveat: false
            });
            renderer.setSize(width, height);
            renderer.domElement.style.width = '100%';
            renderer.domElement.style.height = '100%';
            renderer.domElement.style.display = 'block';
            container.appendChild(renderer.domElement);
        } catch (e) {
            console.warn('[3D Renderer] WebGL unavailable:', e);
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.fillStyle = '#0a0e17';
                ctx.fillRect(0, 0, width, height);
                ctx.fillStyle = '#64748b';
                ctx.font = '14px system-ui';
                ctx.textAlign = 'center';
                ctx.fillText('3D Viewport Ready', width / 2, height / 2);
            }
            container.appendChild(canvas);
            renderer = {
                domElement: canvas,
                setSize: () => {},
                setPixelRatio: () => {},
                render: () => {},
                dispose: () => {},
                getRenderTarget: () => null,
                setRenderTarget: () => {},
                clear: () => {},
                clearColor: () => {},
                clearDepth: () => {},
                clearStencil: () => {},
                setClearColor: () => {},
                getClearColor: () => new THREE.Color(),
                getClearAlpha: () => 1,
                resetState: () => {},
                shadowMap: { enabled: false, type: 0 },
                toneMapping: 0,
                toneMappingExposure: 1.0,
                capabilities: { isWebGL2: false, maxTextures: 16 }
            } as unknown as THREE.WebGLRenderer;
        }
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
