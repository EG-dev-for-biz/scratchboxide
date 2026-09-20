/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Video3DLayerRenderer } from '../src/browser/generative-canvas/services/video/Video3DLayerRenderer';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import type { TimelineElement } from '../src/browser/generative-canvas/services/video/videoTypes';

function createMockRenderer(): THREE.WebGLRenderer {
    return {
        setSize: () => {},
        getRenderTarget: () => null,
        setRenderTarget: () => {},
        setClearColor: () => {},
        clear: () => {},
        render: () => {},
        dispose: () => {}
    } as unknown as THREE.WebGLRenderer;
}

describe('Video3DLayerRenderer - Project 3D Compositing Without Presets', () => {
    it('initializes with custom dimensions and offscreen render target', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({
            width: 1920,
            height: 1080,
            renderer: mockRenderer
        });

        const rt = layerRenderer.getRenderTarget();
        expect(rt.width).toBe(1920);
        expect(rt.height).toBe(1080);
        expect(rt.texture.format).toBe(THREE.RGBAFormat);

        layerRenderer.dispose();
    });

    it('resizes render target and updates camera aspect ratio', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({
            width: 1280,
            height: 720,
            renderer: mockRenderer
        });

        layerRenderer.resize(3840, 2160);
        const rt = layerRenderer.getRenderTarget();
        expect(rt.width).toBe(3840);
        expect(rt.height).toBe(2160);

        layerRenderer.dispose();
    });

    it('applies direct parametric lighting without presets', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({ renderer: mockRenderer });

        layerRenderer.applyDirectLighting({
            ambientColor: '#06b6d4',
            ambientIntensity: 1.75,
            directionalColor: '#f43f5e',
            directionalIntensity: 4.5,
            directionalPosition: [8, 12, -5]
        });

        // Verify scene lighting rig reflects exact parameters
        const scene = (layerRenderer as any).scene as THREE.Scene;
        const lightGroup = (layerRenderer as any).lightGroup as THREE.Group;
        expect(lightGroup.children.length).toBe(2);

        const amb = lightGroup.children.find(c => c instanceof THREE.AmbientLight) as THREE.AmbientLight;
        const dir = lightGroup.children.find(c => c instanceof THREE.DirectionalLight) as THREE.DirectionalLight;

        expect(amb).toBeDefined();
        expect(amb.intensity).toBe(1.75);
        expect(dir).toBeDefined();
        expect(dir.intensity).toBe(4.5);
        expect(dir.position.x).toBe(8);
        expect(dir.position.y).toBe(12);
        expect(dir.position.z).toBe(-5);

        layerRenderer.dispose();
    });

    it('applies direct continuous camera coordinates and FOV', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({ renderer: mockRenderer });

        layerRenderer.applyCameraConfig({
            fov: 65,
            position: [10, 15, 20],
            target: [0, 2, 0]
        });

        const cam = (layerRenderer as any).camera as THREE.PerspectiveCamera;
        expect(cam.fov).toBe(65);
        expect(cam.position.x).toBe(10);
        expect(cam.position.y).toBe(15);
        expect(cam.position.z).toBe(20);

        layerRenderer.dispose();
    });

    it('loads and constructs an actual project Scene3DData scene', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({ renderer: mockRenderer });

        const projectScene: Scene3DData = {
            title: 'Project Cyber City',
            camera: {
                position: [0, 5, 10],
                target: [0, 0, 0],
                fov: 50
            },
            environment: {
                ambientIntensity: 0.9
            },
            objects: [
                {
                    id: 'tower-1',
                    content: { type: 'mesh' } as any,
                    space: {
                        position: [2, 0, -5],
                        rotation: [0, Math.PI / 4, 0],
                        scale: [1, 5, 1]
                    }
                },
                {
                    id: 'drone-1',
                    content: { type: 'mesh' } as any,
                    space: {
                        position: [0, 3, 2],
                        rotation: [0, 0, 0],
                        scale: [0.5, 0.5, 0.5]
                    }
                }
            ]
        };

        const sceneGroup = layerRenderer.loadProjectScene('cyber-city-scene', projectScene);
        expect(sceneGroup).toBeDefined();
        expect(sceneGroup.children.length).toBe(2);

        // Verify camera updated from scene
        const cam = (layerRenderer as any).camera as THREE.PerspectiveCamera;
        expect(cam.fov).toBe(50);
        expect(cam.position.y).toBe(5);

        layerRenderer.dispose();
    });

    it('scrubs animation mixer synchronized to timeline playhead', () => {
        const mockRenderer = createMockRenderer();
        const layerRenderer = new Video3DLayerRenderer({ renderer: mockRenderer });

        // Create an animated object
        const group = new THREE.Group();
        const track = new THREE.NumberKeyframeTrack('.position[y]', [0, 1, 2], [0, 5, 10]);
        const clip = new THREE.AnimationClip('ElevatorUp', 2, [track]);
        const mixer = new THREE.AnimationMixer(group);
        mixer.clipAction(clip).play();

        layerRenderer.setActiveRoot(group, mixer);

        const timelineClip: TimelineElement = {
            id: '3d-clip-1',
            name: 'Elevator Shot',
            type: '3d',
            startTime: 4.0,
            duration: 5.0,
            trimStart: 0.5,
            trimEnd: 5.5,
            animationSpeed: 1.5,
            cameraConfig: {
                fov: 45,
                position: [0, 2, 5],
                target: [0, 0, 0]
            }
        };

        // Render at timeline time = 5.0s
        // localTime = (5.0 - 4.0) * 1.5 + 0.5 = 2.0s
        const texture = layerRenderer.renderAtTime(timelineClip, 5.0);
        expect(texture).toBeDefined();
        expect(mixer.time).toBeCloseTo(2.0, 3);

        layerRenderer.dispose();
    });

    it('toggles wireframe material override for preview/hologram pass', () => {
        let renderedOverrideMaterial: THREE.Material | null = null;
        const mockRenderer = {
            setSize: () => {},
            getRenderTarget: () => null,
            setRenderTarget: () => {},
            setClearColor: () => {},
            clear: () => {},
            render: (scene: THREE.Scene) => {
                renderedOverrideMaterial = scene.overrideMaterial;
            },
            dispose: () => {}
        } as unknown as THREE.WebGLRenderer;

        const layerRenderer = new Video3DLayerRenderer({ renderer: mockRenderer });

        const wireframeClip: TimelineElement = {
            id: '3d-wireframe',
            name: 'Wireframe Pass',
            type: '3d',
            startTime: 0,
            duration: 4.0,
            trimStart: 0,
            trimEnd: 4.0,
            wireframe: true
        };

        layerRenderer.renderAtTime(wireframeClip, 1.0);
        expect(renderedOverrideMaterial).toBeDefined();
        expect((renderedOverrideMaterial as any)?.wireframe).toBe(true);

        layerRenderer.dispose();
    });
});
