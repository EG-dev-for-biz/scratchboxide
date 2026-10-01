/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { QUAD_VERT, COMPOSITOR_FRAG } from './compositorShaders';
import {
    GradeParams,
    VfxParams,
    BlendMode,
    KeyingParams,
    LayerTransform,
    LightWrapParams
} from './videoTypes';
import { generateProceduralLut } from './cubeLutParser';

export interface RenderLayer {
    texture: THREE.Texture;
    maskTexture?: THREE.Texture;
    opacity: number;
    blendMode: BlendMode;
    transform?: Partial<LayerTransform>;
    keying?: Partial<KeyingParams>;
    lightWrap?: Partial<LightWrapParams>;
    grade?: Partial<GradeParams>;
    vfx?: Partial<VfxParams>;
    lutTexture?: THREE.Data3DTexture;
}

function parseColorToVec3(colorStr?: string, defaultColor = new THREE.Vector3(0, 1, 0)): THREE.Vector3 {
    if (!colorStr) return defaultColor;
    try {
        const c = new THREE.Color(colorStr);
        return new THREE.Vector3(c.r, c.g, c.b);
    } catch {
        return defaultColor;
    }
}

export class VideoCompositor {
    private renderer: THREE.WebGLRenderer;
    private scene: THREE.Scene;
    private camera: THREE.OrthographicCamera;
    private quadMesh: THREE.Mesh;
    private material: THREE.ShaderMaterial;

    private rtA: THREE.WebGLRenderTarget;
    private rtB: THREE.WebGLRenderTarget;

    private width: number;
    private height: number;
    private pixelBuffer: Uint8Array | null = null;

    // Default procedural LUT cache
    private lutCache = new Map<string, THREE.Data3DTexture>();

    constructor(
        canvasOrOptions?: HTMLCanvasElement | { canvas?: HTMLCanvasElement; width?: number; height?: number; renderer?: THREE.WebGLRenderer },
        initialWidth = 1280,
        initialHeight = 720
    ) {
        let canvas: HTMLCanvasElement | undefined;
        let customRenderer: THREE.WebGLRenderer | undefined;
        let width = initialWidth;
        let height = initialHeight;

        if (canvasOrOptions && typeof (canvasOrOptions as any).getContext === 'function') {
            canvas = canvasOrOptions as HTMLCanvasElement;
        } else if (canvasOrOptions && typeof canvasOrOptions === 'object') {
            const opts = canvasOrOptions as { canvas?: HTMLCanvasElement; width?: number; height?: number; renderer?: THREE.WebGLRenderer };
            canvas = opts.canvas;
            customRenderer = opts.renderer;
            if (opts.width !== undefined) width = opts.width;
            if (opts.height !== undefined) height = opts.height;
        }

        this.width = width;
        this.height = height;

        if (customRenderer) {
            this.renderer = customRenderer;
        } else {
            const effectiveCanvas = canvas || (typeof document !== 'undefined' ? document.createElement('canvas') : undefined);
            this.renderer = new THREE.WebGLRenderer({
                canvas: effectiveCanvas,
                alpha: true,
                antialias: false,
                preserveDrawingBuffer: true,
                powerPreference: 'high-performance'
            });
        }
        this.renderer.setSize(width, height, false);
        this.renderer.setClearColor(0x000000, 1.0);

        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.scene = new THREE.Scene();

        const rtOptions: THREE.RenderTargetOptions = {
            format: THREE.RGBAFormat,
            type: THREE.UnsignedByteType,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: false,
            stencilBuffer: false
        };

        this.rtA = new THREE.WebGLRenderTarget(width, height, rtOptions);
        this.rtB = new THREE.WebGLRenderTarget(width, height, rtOptions);

        this.material = new THREE.ShaderMaterial({
            vertexShader: QUAD_VERT,
            fragmentShader: COMPOSITOR_FRAG,
            uniforms: {
                uTexture: { value: null },
                uBackground: { value: null },
                uHasBackground: { value: false },
                uMaskTexture: { value: null },
                uUseMask: { value: false },
                uInvertMask: { value: false },
                uLayerPosition: { value: new THREE.Vector2(0, 0) },
                uLayerScale: { value: new THREE.Vector2(1, 1) },
                uLayerRotation: { value: 0.0 },
                uLayerAnchor: { value: new THREE.Vector2(0.5, 0.5) },
                uKeyingEnabled: { value: false },
                uKeyColor: { value: new THREE.Vector3(0, 1, 0) },
                uKeyTolerance: { value: 0.35 },
                uKeySoftness: { value: 0.15 },
                uKeyDespill: { value: 0.6 },
                uKeyInvert: { value: false },
                uLightWrapIntensity: { value: 0.0 },
                uLightWrapSpread: { value: 0.0 },
                uBlendMode: { value: 0 },
                uOpacity: { value: 1.0 },
                uExposure: { value: 0.0 },
                uContrast: { value: 1.0 },
                uSaturation: { value: 1.0 },
                uColorBalance: { value: new THREE.Vector3(0, 0, 0) },
                uLift: { value: new THREE.Vector3(0, 0, 0) },
                uGamma: { value: new THREE.Vector3(0, 0, 0) },
                uGain: { value: new THREE.Vector3(0, 0, 0) },
                uOffset: { value: new THREE.Vector3(0, 0, 0) },
                uLut3D: { value: null },
                uUseLut3D: { value: false },
                uVignette: { value: 0.0 },
                uChromatic: { value: 0.0 },
                uOldFilm: { value: 0.0 },
                uTime: { value: 0.0 }
            },
            depthTest: false,
            depthWrite: false
        });

        const geo = new THREE.PlaneGeometry(2, 2);
        this.quadMesh = new THREE.Mesh(geo, this.material);
        this.scene.add(this.quadMesh);

        // Pre-warm default LUTs
        this.lutCache.set('teal-orange', generateProceduralLut('teal-orange'));
        this.lutCache.set('cyberpunk', generateProceduralLut('cyberpunk'));
        this.lutCache.set('vintage', generateProceduralLut('vintage'));
        this.lutCache.set('noir', generateProceduralLut('noir'));
    }

    public resize(width: number, height: number): void {
        if (width === this.width && height === this.height) return;
        this.width = width;
        this.height = height;
        this.renderer.setSize(width, height, false);
        this.rtA.setSize(width, height);
        this.rtB.setSize(width, height);
        this.pixelBuffer = null;
    }

    public render(layers: RenderLayer[], timeSec = 0): void {
        if (layers.length === 0) {
            this.renderer.setRenderTarget(null);
            this.renderer.clear();
            return;
        }

        let currentRead = this.rtA;
        let currentWrite = this.rtB;

        // Clear initial write target
        this.renderer.setRenderTarget(currentWrite);
        this.renderer.clear();

        for (let i = 0; i < layers.length; i++) {
            const layer = layers[i];
            const isFirst = (i === 0);
            const isLast = (i === layers.length - 1);

            // Target destination: screen for last layer, or ping-pong buffer
            this.renderer.setRenderTarget(isLast ? null : currentWrite);

            // Configure uniforms
            this.material.uniforms.uTexture.value = layer.texture;
            this.material.uniforms.uBackground.value = isFirst ? null : currentRead.texture;
            this.material.uniforms.uHasBackground.value = !isFirst;
            this.material.uniforms.uBlendMode.value = layer.blendMode || 0;
            this.material.uniforms.uOpacity.value = layer.opacity ?? 1.0;
            this.material.uniforms.uTime.value = timeSec;

            // Grading
            const grade = layer.grade;
            this.material.uniforms.uExposure.value = (grade?.exposure ?? 0) / 50.0;
            this.material.uniforms.uContrast.value = 1.0 + (grade?.contrast ?? 0) / 100.0;
            this.material.uniforms.uSaturation.value = (grade?.saturation ?? 100) / 100.0;

            const lift = grade?.lift;
            this.material.uniforms.uLift.value.set(
                (lift?.x ?? 0) * 0.2,
                (lift?.y ?? 0) * 0.2,
                (lift?.luma ?? 0) * 0.005
            );

            const gamma = grade?.gamma;
            this.material.uniforms.uGamma.value.set(
                (gamma?.x ?? 0) * 0.2,
                (gamma?.y ?? 0) * 0.2,
                (gamma?.luma ?? 0) * 0.005
            );

            const gain = grade?.gain;
            this.material.uniforms.uGain.value.set(
                (gain?.x ?? 0) * 0.2,
                (gain?.y ?? 0) * 0.2,
                (gain?.luma ?? 0) * 0.005
            );

            const offset = grade?.offset;
            this.material.uniforms.uOffset.value.set(
                (offset?.x ?? 0) * 0.1,
                (offset?.y ?? 0) * 0.1,
                (offset?.luma ?? 0) * 0.002
            );

            // LUT
            let lutTex = layer.lutTexture;
            if (!lutTex && grade?.lutId && this.lutCache.has(grade.lutId)) {
                lutTex = this.lutCache.get(grade.lutId);
            }

            if (lutTex) {
                this.material.uniforms.uLut3D.value = lutTex;
                this.material.uniforms.uUseLut3D.value = true;
            } else {
                this.material.uniforms.uUseLut3D.value = false;
            }

            // Mask Texture
            if (layer.maskTexture) {
                this.material.uniforms.uMaskTexture.value = layer.maskTexture;
                this.material.uniforms.uUseMask.value = true;
                this.material.uniforms.uInvertMask.value = !!layer.keying?.invert;
            } else {
                this.material.uniforms.uUseMask.value = false;
            }

            // 2D Spatial Affine Transform
            const tf = layer.transform;
            this.material.uniforms.uLayerPosition.value.set(tf?.x ?? 0, tf?.y ?? 0);
            this.material.uniforms.uLayerScale.value.set(tf?.scaleX ?? 1.0, tf?.scaleY ?? 1.0);
            this.material.uniforms.uLayerRotation.value = ((tf?.rotation ?? 0) * Math.PI) / 180.0;
            this.material.uniforms.uLayerAnchor.value.set(tf?.anchorX ?? 0.5, tf?.anchorY ?? 0.5);

            // Chroma Keying & Despill
            const key = layer.keying;
            if (key && key.enabled) {
                this.material.uniforms.uKeyingEnabled.value = true;
                this.material.uniforms.uKeyColor.value.copy(parseColorToVec3(key.keyColor));
                this.material.uniforms.uKeyTolerance.value = (key.tolerance ?? 35) / 100.0;
                this.material.uniforms.uKeySoftness.value = (key.softness ?? 15) / 100.0;
                this.material.uniforms.uKeyDespill.value = (key.despill ?? 60) / 100.0;
                this.material.uniforms.uKeyInvert.value = !!key.invert;
            } else {
                this.material.uniforms.uKeyingEnabled.value = false;
            }

            // Optical Light Wrap
            const lw = layer.lightWrap;
            this.material.uniforms.uLightWrapIntensity.value = (lw?.intensity ?? 0) / 100.0;
            this.material.uniforms.uLightWrapSpread.value = (lw?.spread ?? 0) / 100.0;

            // VFX
            const vfx = layer.vfx;
            this.material.uniforms.uVignette.value = (vfx?.vignette ?? 0) / 100.0;
            this.material.uniforms.uChromatic.value = (vfx?.chromatic ?? 0) / 100.0;
            this.material.uniforms.uOldFilm.value = (vfx?.oldFilm ?? 0) / 100.0;

            // Render quad
            this.renderer.render(this.scene, this.camera);

            // Swap ping-pong buffers
            if (!isLast) {
                const tmp = currentRead;
                currentRead = currentWrite;
                currentWrite = tmp;
            }
        }
    }

    /**
     * Exports current canvas buffer as an image data URL (PNG/JPEG/WEBP).
     */
    public exportFrameAsDataUrl(mimeType = 'image/png', quality = 0.95): string {
        const canvas = this.renderer.domElement;
        if (canvas && typeof (canvas as any).toDataURL === 'function') {
            return (canvas as HTMLCanvasElement).toDataURL(mimeType, quality);
        }
        return '';
    }

    /**
     * Reads pixels from current output for video scopes and histograms.
     */
    public readPixels(downsample = 4): Uint8Array {
        const sw = Math.floor(this.width / downsample);
        const sh = Math.floor(this.height / downsample);
        const size = sw * sh * 4;

        if (!this.pixelBuffer || this.pixelBuffer.length !== size) {
            this.pixelBuffer = new Uint8Array(size);
        }

        const gl = this.renderer.getContext();
        gl.readPixels(0, 0, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, this.pixelBuffer);
        return this.pixelBuffer;
    }

    public getLut(presetId: string): THREE.Data3DTexture | undefined {
        return this.lutCache.get(presetId);
    }

    public getRenderTarget(): THREE.WebGLRenderTarget {
        return this.rtA;
    }

    public registerLut(id: string, lut: THREE.Data3DTexture): void {
        this.lutCache.set(id, lut);
    }

    public dispose(): void {
        this.quadMesh.geometry.dispose();
        this.material.dispose();
        this.rtA.dispose();
        this.rtB.dispose();
        this.lutCache.forEach(lut => lut.dispose());
        this.lutCache.clear();
        this.renderer.dispose();
    }
}
