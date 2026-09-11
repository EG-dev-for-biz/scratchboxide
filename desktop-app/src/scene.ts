/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import {
    createAtmosphericSkyDome,
    getPresetLightingState,
    AtmosphericScatteringConfig,
    AtmosphericSkyDomeModule
} from '@scratchbox/core';

export interface SceneCreationOptions {
    enableAtmosphere?: boolean;
    preset?: string;
    atmosphereConfig?: AtmosphericScatteringConfig;
}

export function createScene(container: HTMLElement, options: SceneCreationOptions = {}) {
    const scene = new THREE.Scene();
    const preset = options.preset || 'studio';
    const presetState = getPresetLightingState(preset);

    const isAtmospheric = options.enableAtmosphere || options.atmosphereConfig !== undefined || ['dawn', 'golden_hour', 'midday', 'afternoon', 'sunset', 'twilight', 'night', 'overcast'].includes(preset);

    if (!isAtmospheric) {
        scene.background = new THREE.Color(0x0a0a0c);
        scene.fog = new THREE.FogExp2(0x0a0a0c, 0.015);
    }

    const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(0, 5, 10);

    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    let atmosphereModule: AtmosphericSkyDomeModule | null = null;

    if (isAtmospheric) {
        atmosphereModule = createAtmosphericSkyDome(scene, presetState.isGoldenHour, options.atmosphereConfig || {
            sunElevation: presetState.elevationDeg,
            sunAzimuth: presetState.azimuthDeg
        });
    } else {
        // Dynamic Studio Lights
        const ambientLight = new THREE.AmbientLight(0x11111a);
        scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0x00ffcc, 1.5);
        dirLight.position.set(5, 10, 7);
        dirLight.castShadow = true;
        scene.add(dirLight);

        // Grid Floor
        const grid = new THREE.GridHelper(100, 100, 0x00ffcc, 0x112233);
        scene.add(grid);
    }

    return {
        scene,
        camera,
        renderer,
        atmosphereModule,
        update: (time: number, delta: number) => {
            if (atmosphereModule) {
                atmosphereModule.update(time, delta);
            }
        },
        dispose: () => {
            if (atmosphereModule) {
                atmosphereModule.dispose();
            }
            renderer.dispose();
        }
    };
}
