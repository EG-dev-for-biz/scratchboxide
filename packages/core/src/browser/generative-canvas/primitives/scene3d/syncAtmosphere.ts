/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import {
    createAtmosphericSkyDome,
    createAerialPerspectiveEffect,
    createTerrainCloudShadows
} from '../../services/atmosphere';
import { buildThreeJsLightingRig } from './lightingRigs';
import type { AtmosphereHandle, RendererStack, Scene3DRenderMode } from './types';
import { removeAndDispose } from './types';

export interface AtmosphereInput {
    skybox?: string;
    lighting?: string;
    ambientIntensity?: number;
    cinematicRig?: string;
    lightingKelvin?: number;
    ground?: boolean;
    backgroundHex?: number;
    fog?: boolean | { color?: number | string; density?: number };
    /** Live scene title (state) and the incoming prop title/subtitle. */
    title?: string;
    dataTitle?: string;
    dataSubtitle?: string;
    worldBranch: string;
    renderMode: Scene3DRenderMode;
    hasGeoCoordinates: boolean;
    has3DTiles: boolean;
    atmosphericScattering?: any;
    atmosphere?: any;
    godRays?: any;
    terrainBiomes?: any;
}

/** Factories that live in the primitive module (kept injectable to avoid an import cycle). */
export interface AtmosphereFactories {
    createVolumetricGodRays: (scene: THREE.Scene, sunPosition: THREE.Vector3, isSunset: boolean, options: any) => any;
    createProceduralBiomeTerrain: (scene: THREE.Scene, biomeType: string, renderMode: string, isSunset: boolean) => any;
}

export interface AtmosphereClassification {
    hasAtmosphere: boolean;
    isSkySkybox: boolean;
    isSunset: boolean;
    hasGodRays: boolean;
    hasBiomes: boolean;
    biomeType: string;
    backgroundHex: number;
    effectiveAtmosphericScattering?: any;
}

export const CLAY_GREY_HEX = 0xb0b8c4;

export function classifyAtmosphere(input: AtmosphereInput): AtmosphereClassification {
    const worldBranch = (input.worldBranch || '').toLowerCase();
    const skybox = (input.skybox || '').toLowerCase();

    // Atmosphere is an explicit part of the headless build of the scene.
    // There are NO keyword heuristic presets, and scenes do not receive atmosphere by default.
    // A scene has atmosphere IF AND ONLY IF the headless scene data explicitly specifies
    // atmosphericScattering or atmosphere configuration.
    const atmoConfig = input.atmosphericScattering || input.atmosphere;
    const hasAtmosphere = !!(
        atmoConfig && (
            atmoConfig === true ||
            (typeof atmoConfig === 'object' && atmoConfig.enabled !== false)
        )
    );

    const isSkySkybox = hasAtmosphere;
    const isSunset = hasAtmosphere && (
        skybox === 'sunset' ||
        (typeof atmoConfig === 'object' && (
            (atmoConfig.timeOfDay !== undefined && atmoConfig.timeOfDay >= 18 && atmoConfig.timeOfDay <= 20) ||
            (atmoConfig.sunElevation !== undefined && atmoConfig.sunElevation <= 15)
        ))
    );
    const hasGodRays = hasAtmosphere && !!input.godRays;
    const hasBiomes = !!input.terrainBiomes;
    const biomeType = (typeof input.terrainBiomes === 'object' && input.terrainBiomes && input.terrainBiomes.biomeType)
        ? input.terrainBiomes.biomeType
        : 'alpine';

    // Directed dark / black environments (space, night, cyberpunk, deep space)
    const isDirectedDarkOrBlack =
        skybox === 'space' ||
        skybox === 'space-stars' ||
        skybox === 'deep_space' ||
        skybox === 'night' ||
        skybox === 'void' ||
        skybox === 'black' ||
        worldBranch === 'space' ||
        worldBranch.startsWith('space/') ||
        worldBranch.startsWith('earth/space') ||
        worldBranch === 'earth/cyberpunk' ||
        worldBranch === 'earth/post-apocalypse' ||
        worldBranch === 'earth/mars-colony-2150';

    let backgroundHex = CLAY_GREY_HEX;
    if (hasAtmosphere) {
        backgroundHex = isSunset ? 0x1e1b4b : 0xc4d4e8;
    } else if (input.backgroundHex !== undefined) {
        backgroundHex = input.backgroundHex;
    } else if (isDirectedDarkOrBlack) {
        if (worldBranch === 'earth/cyberpunk') {
            backgroundHex = 0x0f0a1c;
        } else if (worldBranch === 'earth/post-apocalypse') {
            backgroundHex = 0x0c120e;
        } else if (worldBranch === 'earth/mars-colony-2150') {
            backgroundHex = 0x2a1a15;
        } else {
            backgroundHex = 0x0a0a0f;
        }
    } else if (skybox === 'clear_daylight' || skybox === 'daylight' || skybox === 'sky') {
        backgroundHex = 0xc4d4e8;
    } else {
        // Unless there is explicit direction on why the viewport should be dark/black, default to studio clay grey
        backgroundHex = CLAY_GREY_HEX;
    }

    const effectiveAtmosphericScattering = hasAtmosphere
        ? (typeof atmoConfig === 'object' ? atmoConfig : { enabled: true })
        : undefined;

    return { hasAtmosphere, isSkySkybox, isSunset, hasGodRays, hasBiomes, biomeType, backgroundHex, effectiveAtmosphericScattering };
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
        colors.setXYZ(i * 4 + 0, c.r, c.g, c.b);
        colors.setXYZ(i * 4 + 1, c.r, c.g, c.b);
        colors.setXYZ(i * 4 + 2, c.r, c.g, c.b);
        colors.setXYZ(i * 4 + 3, c.r, c.g, c.b);
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
    const isLargeScale = !!(input.has3DTiles || input.hasGeoCoordinates || (input.worldBranch || '').startsWith('earth'));

    scene.background = new THREE.Color(backgroundHex);
    if (isSkySkybox) {
        scene.fog = new THREE.FogExp2(isSunset ? 0xf97316 : 0xbae6fd, isLargeScale ? 0.0005 : 0.005);
    } else if (input.fog) {
        let fogColor = backgroundHex;
        if (typeof input.fog === 'object' && input.fog.color !== undefined) {
            try {
                fogColor = typeof input.fog.color === 'string'
                    ? new THREE.Color(input.fog.color).getHex()
                    : Number(input.fog.color);
            } catch {
                fogColor = backgroundHex;
            }
        }
        const defaultDensity = isLargeScale ? 0.0003 : 0.015;
        const fogDensity = (typeof input.fog === 'object' && input.fog.density !== undefined) ? input.fog.density : defaultDensity;
        scene.fog = new THREE.FogExp2(fogColor, fogDensity);
    } else if (backgroundHex === CLAY_GREY_HEX || backgroundHex === 0xc4d4e8) {
        // Soft studio depth fog matching clay grey background to geometry seamlessly
        scene.fog = new THREE.FogExp2(backgroundHex, 0.008);
    } else {
        scene.fog = null;
    }

    // Grid: tint + visibility (grid is cleanly visible on non-atmospheric / studio scenes).
    const isLightBg = backgroundHex === CLAY_GREY_HEX || backgroundHex === 0xc4d4e8 || backgroundHex > 0x888888;
    tintGridHelper(
        gridHelper,
        isSkySkybox ? 0x93c5fd : (isLightBg ? 0x717985 : 0x3f3f5a),
        isSkySkybox ? 0x60a5fa : (isLightBg ? 0x949da8 : 0x1f1f2c)
    );
    gridHelper.visible = !isSkySkybox && !hasBiomes && !input.has3DTiles && !input.hasGeoCoordinates && input.ground !== false;

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
                    cloudShadowsEnabled: atmoConfig.cloudShadowsEnabled === true,
                    cloudShadowIntensity: atmoConfig.cloudShadowIntensity ?? 0.65,
                    cloudShadowScale: atmoConfig.cloudShadowScale ?? 0.015,
                    atmosphereShadowLength: atmoConfig.atmosphereShadowLength ?? 1.0,
                    cloudAltitude: atmoConfig.cloudAltitude ?? 1200.0,
                    cloudCoverage: atmoConfig.cloudCoverage ?? (atmoConfig.volumetricClouds === true ? 0.35 : 0.0),
                    cloudDensity: atmoConfig.cloudDensity ?? (atmoConfig.volumetricClouds === true ? 0.45 : 0.0),
                    windVector: atmoConfig.windVector ?? [0.05, 0.02]
                }, width, height);
            } catch (e) {
                console.warn('[AerialPerspectiveEffect] Post-pass setup warning:', e);
            }
        }

        if (atmoConfig.cloudShadowsEnabled === true) {
            terrainCloudShadows = createTerrainCloudShadows({
                cloudShadowsEnabled: true,
                cloudShadowIntensity: atmoConfig.cloudShadowIntensity ?? 0.65,
                cloudShadowScale: atmoConfig.cloudShadowScale ?? 0.015,
                atmosphereShadowLength: atmoConfig.atmosphereShadowLength ?? 1.0,
                cloudAltitude: atmoConfig.cloudAltitude ?? 1200.0,
                cloudCoverage: atmoConfig.cloudCoverage ?? (atmoConfig.volumetricClouds === true ? 0.35 : 0.0),
                cloudDensity: atmoConfig.cloudDensity ?? (atmoConfig.volumetricClouds === true ? 0.45 : 0.0),
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

        // Zero Ground Plane Invariant: 3D environments do not use artificial flat ground planes.
        // Radiometric illumination and atmospheric scattering interact directly with genuine scene geometry.
    } else {
        const rigKey = input.cinematicRig || input.lighting;
        if (rigKey && rigKey !== 'default') {
            const rigLights = buildThreeJsLightingRig(rigKey, {
                kelvin: input.lightingKelvin,
                scale: isLargeScale ? 100 : 1.0,
                isLargeScale
            });
            for (const light of rigLights) {
                scene.add(light);
                owned.push(light);
            }

            // For macro/geospatial/city scenes, ensure directional sunlight cascades across facades
            if (isLargeScale) {
                const hasDirectional = rigLights.some(l => (l as any).isDirectionalLight);
                if (!hasDirectional) {
                    const citySun = new THREE.DirectionalLight(0xfffaed, 2.2);
                    citySun.name = 'city_geospatial_sun';
                    citySun.position.set(300, 600, 400);
                    scene.add(citySun);
                    owned.push(citySun);
                }
            }
        } else {
            const ambientIntensity = typeof input.ambientIntensity === 'number'
                ? input.ambientIntensity
                : (input.lighting === 'daylight' ? 0.75 : 0.25);
            const ambientLight = new THREE.AmbientLight(0xffffff, ambientIntensity);
            const dirLight = new THREE.DirectionalLight(0xffffff, input.lighting === 'daylight' ? 1.2 : 0.8);
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
    }

    // Procedural biome terrain (only when not standing on real terrain)
    if (hasBiomes && !input.hasGeoCoordinates && !input.has3DTiles) {
        terrainBiome = factories.createProceduralBiomeTerrain(scene, biomeType, input.renderMode, isSunset);
        if (terrainCloudShadows && terrainBiome?.terrainMesh?.material) {
            terrainCloudShadows.attachToMaterial(terrainBiome.terrainMesh.material);
        }
    }

    // Galaxy starfield only for explicit space or night environments
    const isSpaceOrNight = input.skybox === 'space-stars' || input.skybox === 'space' || input.worldBranch === 'earth/space' || input.worldBranch === 'space';
    if (isSpaceOrNight) {
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
