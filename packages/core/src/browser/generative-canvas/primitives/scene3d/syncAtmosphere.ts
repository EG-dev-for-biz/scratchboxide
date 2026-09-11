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
    createAerialPerspectiveEffect,
    createTerrainCloudShadows
} from '../../services/atmosphere';
import type { AtmosphereHandle, RendererStack, Scene3DRenderMode } from './types';
import { removeAndDispose } from './types';

const SKY_KEYWORDS = /sky|realistic|flight|aviation|atmosphere|cloud|plane|aircraft|jet|airplane/i;
const SUNSET_KEYWORDS = /sunset|dusk|golden\s*hour/i;
const GOD_RAY_KEYWORDS = /god\s*ray|light\s*shaft|crepuscular/i;

export interface AtmosphereInput {
    skybox?: string;
    lighting?: string;
    ground?: boolean;
    /** Live scene title (state) and the incoming prop title/subtitle used for keyword hints. */
    title?: string;
    dataTitle?: string;
    dataSubtitle?: string;
    worldBranch: string;
    renderMode: Scene3DRenderMode;
    hasGeoCoordinates: boolean;
    has3DTiles: boolean;
    atmosphericScattering?: any;
    godRays?: any;
    terrainBiomes?: any;
}

/** Factories that live in the primitive module (kept injectable to avoid an import cycle). */
export interface AtmosphereFactories {
    createVolumetricGodRays: (scene: THREE.Scene, sunPosition: THREE.Vector3, isSunset: boolean, options: any) => any;
    createProceduralBiomeTerrain: (scene: THREE.Scene, biomeType: string, renderMode: string, isSunset: boolean) => any;
}

export interface AtmosphereClassification {
    isSkySkybox: boolean;
    isSunset: boolean;
    hasGodRays: boolean;
    hasBiomes: boolean;
    biomeType: string;
    backgroundHex: number;
}

export function classifyAtmosphere(input: AtmosphereInput): AtmosphereClassification {
    const worldBranch = (input.worldBranch || '').toLowerCase();
    const isSkySkybox =
        input.skybox === 'realistic-sky' ||
        input.skybox === 'daylight' ||
        input.skybox === 'blue-sky' ||
        input.skybox === 'sky' ||
        input.skybox === 'sunset' ||
        !!input.atmosphericScattering ||
        SKY_KEYWORDS.test(input.title || '') ||
        SKY_KEYWORDS.test(input.dataTitle || '') ||
        SKY_KEYWORDS.test(input.dataSubtitle || '');

    const isSunset = input.skybox === 'sunset' || SUNSET_KEYWORDS.test(input.title || '') || SUNSET_KEYWORDS.test(input.dataTitle || '');
    const hasGodRays = !!input.godRays || GOD_RAY_KEYWORDS.test(input.title || '') || GOD_RAY_KEYWORDS.test(input.dataTitle || '');
    const hasBiomes = !!input.terrainBiomes;
    const biomeType = (typeof input.terrainBiomes === 'object' && input.terrainBiomes && input.terrainBiomes.biomeType)
        ? input.terrainBiomes.biomeType
        : 'alpine';

    let backgroundHex = isSunset ? 0x1e1b4b : (isSkySkybox ? 0x0284c7 : 0x0a0a0f);
    if (!isSkySkybox) {
        if (worldBranch === 'earth/cyberpunk') backgroundHex = 0x0f0a1c;
        else if (worldBranch === 'earth/post-apocalypse') backgroundHex = 0x0c120e;
        else if (worldBranch === 'earth/mars-colony-2150') backgroundHex = 0x2a1a15;
    }

    return { isSkySkybox, isSunset, hasGodRays, hasBiomes, biomeType, backgroundHex };
}

/**
 * Re-tints an existing GridHelper in place. three.js lays the grid out as `divisions + 1`
 * line pairs (4 vertices each); the pair at `divisions / 2` is the centre cross.
 */
export function tintGridHelper(gridHelper: THREE.GridHelper, centreHex: number, lineHex: number): void {
    const colors = gridHelper.geometry.attributes.color as THREE.BufferAttribute | undefined;
    if (!colors) return;
    const divisions = colors.count / 4 - 1;
    const centre = Math.floor(divisions / 2);
    const c1 = new THREE.Color(centreHex);
    const c2 = new THREE.Color(lineHex);
    for (let i = 0; i <= divisions; i++) {
        const c = i === centre ? c1 : c2;
        for (let v = 0; v < 4; v++) {
            colors.setXYZ(i * 4 + v, c.r, c.g, c.b);
        }
    }
    colors.needsUpdate = true;
}

function createStarfield(scene: THREE.Scene): THREE.Points {
    const pCount = 1200;
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(pCount * 3);
    for (let i = 0; i < pCount; i++) {
        const idx = i * 3;
        const u = Math.random();
        const v = Math.random();
        const theta = u * 2.0 * Math.PI;
        const phi = Math.acos(2.0 * v - 1.0);
        const radius = 45 + Math.random() * 55;
        const sinPhi = Math.sin(phi);
        pPos[idx] = radius * sinPhi * Math.cos(theta);
        pPos[idx + 1] = radius * Math.cos(phi);
        pPos[idx + 2] = radius * sinPhi * Math.sin(theta);
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    const pMat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.15, transparent: true, opacity: 0.6 });
    const stars = new THREE.Points(pGeo, pMat);
    stars.name = 'sb-starfield';
    scene.add(stars);
    return stars;
}

/**
 * Synchronises everything "environmental": background, fog, sky dome + aerial perspective +
 * cloud shadows, god rays, fallback lights, terrain floor, procedural biome terrain, starfield
 * and grid visibility. Re-run only when the atmosphere fingerprint changes; the renderer stack
 * is left untouched.
 */
export function syncAtmosphere(
    stack: RendererStack,
    input: AtmosphereInput,
    factories: AtmosphereFactories
): AtmosphereHandle {
    const { scene, gridHelper, container } = stack;
    const width = container.clientWidth || 500;
    const height = container.clientHeight || 450;
    const cls = classifyAtmosphere(input);
    const { isSkySkybox, isSunset, hasGodRays, hasBiomes, biomeType, backgroundHex } = cls;

    scene.background = new THREE.Color(backgroundHex);
    scene.fog = new THREE.FogExp2(isSunset ? 0xf97316 : (isSkySkybox ? 0xbae6fd : backgroundHex), isSkySkybox ? 0.005 : 0.015);

    // Grid: tint + visibility (hidden for sky, biome, geo-city and 3D-tile scenes).
    tintGridHelper(gridHelper, isSkySkybox ? 0x93c5fd : 0x3f3f5a, isSkySkybox ? 0x60a5fa : 0x1f1f2c);
    gridHelper.visible = !isSkySkybox && !hasBiomes && !input.has3DTiles && !input.hasGeoCoordinates;

    const owned: THREE.Object3D[] = [];
    let skyDomeModule: any | null = null;
    let skyDomeObject: THREE.Mesh | null = null;
    let aerialPerspective: any | null = null;
    let terrainCloudShadows: any | null = null;
    let godRays: any | null = null;
    let terrainBiome: any | null = null;
    let starsMesh: THREE.Points | null = null;
    let sunPosition = new THREE.Vector3(40, 60, 40);

    if (isSkySkybox) {
        const atmoConfig = (typeof input.atmosphericScattering === 'object' && input.atmosphericScattering !== null)
            ? input.atmosphericScattering
            : {};
        skyDomeModule = createAtmosphericSkyDome(scene, isSunset, atmoConfig);
        skyDomeObject = skyDomeModule.skyDome;

        if (atmoConfig.aerialPerspectiveEnabled !== false) {
            try {
                aerialPerspective = createAerialPerspectiveEffect({
                    inscatteringIntensity: atmoConfig.inscatteringIntensity ?? 1.0,
                    aerialPerspectiveRange: atmoConfig.aerialPerspectiveRange ?? 220.0,
                    rayleigh: atmoConfig.rayleigh ?? 0.5,
                    mie: atmoConfig.mie ?? 0.002,
                    turbidity: atmoConfig.turbidity ?? 1.5,
                    mieDirectionalG: atmoConfig.mieDirectionalG ?? 0.82,
                    albedoScale: atmoConfig.albedoScale ?? 1.1,
                    cloudShadowsEnabled: atmoConfig.cloudShadowsEnabled ?? true,
                    cloudShadowIntensity: atmoConfig.cloudShadowIntensity ?? 0.65,
                    cloudShadowScale: atmoConfig.cloudShadowScale ?? 0.015,
                    atmosphereShadowLength: atmoConfig.atmosphereShadowLength ?? 1.0,
                    cloudAltitude: atmoConfig.cloudAltitude ?? 1200.0,
                    cloudCoverage: atmoConfig.cloudCoverage ?? 0.35,
                    cloudDensity: atmoConfig.cloudDensity ?? 0.45,
                    windVector: atmoConfig.windVector ?? [0.05, 0.02]
                }, width, height);
            } catch (e) {
                console.warn('[AerialPerspectiveEffect] Post-pass setup warning:', e);
            }
        }

        if (atmoConfig.cloudShadowsEnabled !== false) {
            terrainCloudShadows = createTerrainCloudShadows({
                cloudShadowsEnabled: true,
                cloudShadowIntensity: atmoConfig.cloudShadowIntensity ?? 0.65,
                cloudShadowScale: atmoConfig.cloudShadowScale ?? 0.015,
                atmosphereShadowLength: atmoConfig.atmosphereShadowLength ?? 1.0,
                cloudAltitude: atmoConfig.cloudAltitude ?? 1200.0,
                cloudCoverage: atmoConfig.cloudCoverage ?? 0.35,
                cloudDensity: atmoConfig.cloudDensity ?? 0.45,
                windVector: atmoConfig.windVector ?? [0.05, 0.02]
            });
        }

        sunPosition = skyDomeModule.sunMesh ? skyDomeModule.sunMesh.position.clone() : new THREE.Vector3(40, 60, 40);

        if (hasGodRays) {
            godRays = factories.createVolumetricGodRays(
                scene,
                sunPosition,
                isSunset,
                (typeof input.godRays === 'object' && input.godRays !== null) ? input.godRays : {}
            );
        }

        if (!hasBiomes && !input.hasGeoCoordinates && !input.has3DTiles && input.ground !== false) {
            const terrainFloorGeo = new THREE.PlaneGeometry(500, 500, 32, 32);
            terrainFloorGeo.rotateX(-Math.PI / 2);
            const terrainFloorMat = new THREE.MeshStandardMaterial({
                color: isSunset ? 0x1e293b : 0x0284c7,
                roughness: 0.2,
                metalness: 0.7
            });
            terrainCloudShadows?.attachToMaterial(terrainFloorMat);
            const terrainFloor = new THREE.Mesh(terrainFloorGeo, terrainFloorMat);
            terrainFloor.name = 'sb-terrain-floor';
            terrainFloor.position.y = -8.0;
            scene.add(terrainFloor);
            owned.push(terrainFloor);
        }
    } else {
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.15);
        const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
        dirLight.position.set(15, 30, 10);
        dirLight.castShadow = true;
        const pointLight = new THREE.PointLight(0x00f6ff, 1.2, 50);
        pointLight.position.set(0, 5, 0);
        const glowLight = new THREE.DirectionalLight(0xff00dd, 0.45);
        glowLight.position.set(-15, 20, -10);
        for (const light of [ambientLight, dirLight, pointLight, glowLight]) {
            scene.add(light);
            owned.push(light);
        }
    }

    // Procedural biome terrain (only when not standing on real terrain)
    if (hasBiomes && !input.hasGeoCoordinates && !input.has3DTiles) {
        terrainBiome = factories.createProceduralBiomeTerrain(scene, biomeType, input.renderMode, isSunset);
        if (terrainCloudShadows && terrainBiome?.terrainMesh?.material) {
            terrainCloudShadows.attachToMaterial(terrainBiome.terrainMesh.material);
        }
    }

    // Galaxy starfield for space / night / cyberpunk skies
    if (!isSkySkybox) {
        starsMesh = createStarfield(scene);
    }

    return {
        isSkySkybox,
        isSunset,
        sunPosition,
        skyDomeObject,
        skyDomeModule,
        aerialPerspective,
        terrainCloudShadows,
        godRays,
        terrainBiome,
        starsMesh,
        dispose: () => {
            aerialPerspective?.dispose?.();
            terrainCloudShadows?.dispose?.();
            skyDomeModule?.dispose?.();
            godRays?.dispose?.();
            terrainBiome?.dispose?.();
            if (starsMesh) removeAndDispose(scene, starsMesh);
            for (const obj of owned) removeAndDispose(scene, obj);
            scene.fog = null;
        }
    };
}
