/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
    createAtmosphericSkyDome,
    createAerialPerspectiveEffect,
    createTerrainCloudShadows
} from '../../services/atmosphere';
import { buildThreeJsLightingRig, isSceneLightingRig } from './lightingRigs';
import type { AtmosphereHandle, RendererStack, Scene3DRenderMode } from './types';
import { removeAndDispose } from './types';
import { hasExplicitSun } from '../../../../common/scene-atmosphere-opt-in';
import { hazeRangeM } from '../../services/atmosphere/scene-weather';

export interface AtmosphereInput {
    skybox?: string;
    lighting?: string;
    ambientIntensity?: number;
    cinematicRig?: string;
    /** An explicit rig (environment.lightingRig); drawn when cinematicRig names it. */
    lightingRig?: unknown;
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
    /** Bounding-sphere radius of the loaded generated geometry, used to size the studio rig. */
    contentRadiusMeters?: number;
}

/** Whether the atmosphere slice draws procedural biome terrain for these inputs (it is the scene's ground then). */
export function drawsProceduralBiomeTerrain(input: Pick<AtmosphereInput, 'renderMode' | 'terrainBiomes' | 'hasGeoCoordinates' | 'has3DTiles'>): boolean {
    return input.renderMode !== 'clay' && !!input.terrainBiomes && !input.hasGeoCoordinates && !input.has3DTiles;
}

/** Bounding radius the cinematic studio rigs are authored around (lights sit ~4-5 m out, 20-25 m range). */
const STUDIO_RIG_REFERENCE_RADIUS_METERS = 6.0;

export function resolveStudioRigScale(input: { isLargeScale: boolean; contentRadiusMeters?: number }): number {
    if (input.isLargeScale) return 100;
    const r = input.contentRadiusMeters;
    if (typeof r !== 'number' || !Number.isFinite(r)) return 1;
    return Math.max(1, r / STUDIO_RIG_REFERENCE_RADIUS_METERS);
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
    /**
     * Whether authored materials get neutral studio reflections (an image-based light of a plain grey room, never drawn
     * as the background): without one, metals reflect nothing and render near black, and glass shows no highlights.
     * Off in clay mode, under an atmosphere sky (it lights the scene itself), in directed dark or space scenes, and at
     * real places (3D tiles or geo coordinates).
     */
    studioReflections: boolean;
    /**
     * Whether objects standing at a real place (3D tiles or geo coordinates) get reflections made from the place itself
     * (placeReflections.ts): a probe rendered from the scene at each object, lighting and reflection only. Off in clay mode.
     */
    placeReflections: boolean;
}

/** environmentIntensity of the studio reflections: under the studio rig's key light, so diffuse surfaces stay as lit. */
export const STUDIO_REFLECTION_INTENSITY = 0.6;

export const CLAY_GREY_HEX = 0xb0b8c4;

export function isGodRaysRequested(godRays: unknown): boolean {
    if (!godRays) return false;
    return typeof godRays !== 'object' || (godRays as { enabled?: boolean }).enabled !== false;
}

/** Where the god-ray emitter sits: the configured position, or high and off to one side of the content. */
export function resolveGodRaysEmitterPosition(godRays: unknown, rigScale: number): [number, number, number] {
    const configured = (typeof godRays === 'object' && godRays !== null)
        ? (godRays as { emitterPosition?: unknown }).emitterPosition
        : undefined;
    if (Array.isArray(configured) && configured.length === 3 && configured.every(v => typeof v === 'number' && Number.isFinite(v))) {
        return configured as [number, number, number];
    }
    return [6 * rigScale, 14 * rigScale, 4 * rigScale];
}

export function classifyAtmosphere(input: AtmosphereInput): AtmosphereClassification {
    const worldBranch = (input.worldBranch || '').toLowerCase();
    const skybox = (input.skybox || '').toLowerCase();
    const isClayMode = input.renderMode === 'clay';

    // In clay mode, focus strictly on clay mode and geometry before color and atmospherics.
    // Atmospheric skybox domes, volumetric god rays, and biomes are suppressed in clay mode, unless the scene places
    // the sun explicitly (the user asked for that sun): then its sky, sunlight and shadows are drawn on the clay.
    const explicitSun = hasExplicitSun(input.atmosphericScattering) || hasExplicitSun(input.atmosphere);
    const atmoConfig = isClayMode && !explicitSun ? undefined : (input.atmosphericScattering || input.atmosphere);
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
    // God rays are a light emitter placed in the scene, not an atmosphere opt-in: they render in a
    // studio scene too. Clay mode still keeps the shafts out (geometry first), but the emitter stays.
    const hasGodRays = !isClayMode && isGodRaysRequested(input.godRays);
    const hasBiomes = !isClayMode && !!input.terrainBiomes;
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
    if (isClayMode) {
        backgroundHex = CLAY_GREY_HEX;
    } else if (hasAtmosphere) {
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

    const studioReflections = !isClayMode && !hasAtmosphere && !isDirectedDarkOrBlack && !input.has3DTiles && !input.hasGeoCoordinates;

    const placeReflections = !isClayMode && (input.has3DTiles || input.hasGeoCoordinates);

    return { hasAtmosphere, isSkySkybox, isSunset, hasGodRays, hasBiomes, biomeType, backgroundHex, effectiveAtmosphericScattering, studioReflections, placeReflections };
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

/** The least reach of the sun's shadows over live 3D Tiles, metres (a street and the buildings on both sides). */
export const TILES_SUN_SHADOW_RADIUS_M = 150;

/**
 * The atmospheric sun's shadow camera sized to the content: an orthographic box of half-width `radius` around the scene's
 * centre, the light placed along the sun direction outside it, and a map fine enough for that extent (the three.js default
 * box is 10 m wide, which leaves anything larger unshadowed).
 */
export function fitSunShadowToContent(sunLight: THREE.DirectionalLight | undefined, radius: number): void {
    if (!sunLight?.shadow) return;
    const dir = sunLight.position.clone();
    if (dir.lengthSq() === 0) return;
    dir.normalize();
    sunLight.position.copy(dir.multiplyScalar(radius * 3));
    sunLight.target.position.set(0, 0, 0);
    const cam = sunLight.shadow.camera as THREE.OrthographicCamera;
    cam.left = -radius; cam.right = radius; cam.top = radius; cam.bottom = -radius;
    cam.near = 0.5; cam.far = radius * 10;
    cam.updateProjectionMatrix();
    const size = radius > 150 ? 4096 : 2048;
    sunLight.shadow.mapSize.set(size, size);
    // bias in light-space depth units, scaled to texel size so large extents do not acne
    sunLight.shadow.bias = -0.0002;
    sunLight.shadow.normalBias = Math.max(0.02, (2 * radius) / size);
    sunLight.shadow.map?.dispose();
    sunLight.shadow.map = null as never;
}

/**
 * Holds unlit photo-textured materials (a scan's twin drawn from its photos, MeshBasicMaterial with a map) at the
 * brightness they had under exposure 1 when the camera's metered exposure (sky-light-rig.ts) differs: a photo already
 * carries its own exposure, and scaling it again blew a night scene's unlit building out to white (exposure 9 at -12°).
 * The authored colour is kept in userData and restored at exposure 1.
 */
export function compensateUnlitForExposure(scene: THREE.Object3D, exposure: number): void {
    const k = 1 / Math.max(1e-6, exposure);
    scene.traverse(o => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            const basic = m as THREE.MeshBasicMaterial;
            if (!basic?.isMeshBasicMaterial || !basic.map || !basic.toneMapped) continue;
            const base = (basic.userData.sbUnlitBaseColor ??= basic.color.clone()) as THREE.Color;
            basic.color.copy(base).multiplyScalar(k);
        }
    });
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
    // Zero Default Fog/Haze: fog is strictly null unless explicitly requested via input.fog or explicit atmospheric fog
    const atmoConfig = (typeof input.atmosphericScattering === 'object' && input.atmosphericScattering !== null)
        ? input.atmosphericScattering
        : (typeof input.atmosphere === 'object' && input.atmosphere !== null ? input.atmosphere : undefined);

    const explicitFogRequested = Boolean(
        input.fog ||
        (atmoConfig?.fog === true) ||
        (typeof atmoConfig?.fogDensity === 'number' && atmoConfig.fogDensity > 0)
    );

    if (explicitFogRequested) {
        let fogColor = backgroundHex;
        if (typeof input.fog === 'object' && input.fog.color !== undefined) {
            try {
                fogColor = typeof input.fog.color === 'string'
                    ? new THREE.Color(input.fog.color).getHex()
                    : Number(input.fog.color);
            } catch {
                fogColor = backgroundHex;
            }
        } else if (atmoConfig?.fogColor !== undefined) {
            try {
                fogColor = typeof atmoConfig.fogColor === 'string'
                    ? new THREE.Color(atmoConfig.fogColor).getHex()
                    : Number(atmoConfig.fogColor);
            } catch {
                fogColor = backgroundHex;
            }
        }
        const defaultDensity = isLargeScale ? 0.0003 : 0.005;
        const fogDensity = (typeof input.fog === 'object' && input.fog.density !== undefined)
            ? input.fog.density
            : (typeof atmoConfig?.fogDensity === 'number' ? atmoConfig.fogDensity : defaultDensity);
        scene.fog = new THREE.FogExp2(fogColor, fogDensity);
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
        // the shadow reach: the config's own (atmosphere_configure_scene sizes it to the scene), else the content's radius
        const configured = typeof atmoConfig.sunShadowRadiusMeters === 'number' && atmoConfig.sunShadowRadiusMeters > 0
            ? atmoConfig.sunShadowRadiusMeters
            : Math.max(30, input.contentRadiusMeters ?? (isLargeScale ? 300 : 30));
        // over live 3D Tiles the shadows fall on the street around the camera, not only on the scene's own objects
        const shadowRadius = input.has3DTiles ? Math.max(configured, TILES_SUN_SHADOW_RADIUS_M) : configured;
        // the dome encloses the camera's orbit around content of that size (the stand-off camera sits a few radii out)
        skyDomeModule = createAtmosphericSkyDome(scene, isSunset, atmoConfig, { sphereRadius: Math.max(280, shadowRadius * 8) });
        skyDomeObject = skyDomeModule.skyDome;
        fitSunShadowToContent(skyDomeModule.sunLight, shadowRadius);

        // Aerial perspective is part of the sky: on whenever the sky is (only an explicit false turns it off), over the
        // range the air's haze sets (the turbidity read as the Weather tool's haze), so distance reads as depth.
        if (atmoConfig.aerialPerspectiveEnabled !== false) {
            try {
                aerialPerspective = createAerialPerspectiveEffect({
                    inscatteringIntensity: atmoConfig.inscatteringIntensity ?? 1.0,
                    aerialPerspectiveRange: atmoConfig.aerialPerspectiveRange ?? hazeRangeM(((atmoConfig.turbidity ?? 2.4) - 2) / 8, isLargeScale),
                    rayleigh: atmoConfig.rayleigh ?? 0.5,
                    mie: atmoConfig.mie ?? 0.002,
                    turbidity: atmoConfig.turbidity ?? 1.5,
                    mieDirectionalG: atmoConfig.mieDirectionalG ?? 0.82,
                    albedoScale: atmoConfig.albedoScale ?? 1.1,
                    cloudShadowsEnabled: atmoConfig.cloudShadowsEnabled === true,
                    cloudShadowIntensity: atmoConfig.cloudShadowIntensity ?? 0.65,
                    cloudShadowScale: atmoConfig.cloudShadowScale ?? 0.015,
                    atmosphereShadowLength: atmoConfig.atmosphereShadowLength ?? 1.0,
                    cloudAltitude: atmoConfig.cloudAltitude ?? 2200.0,
                    cloudCoverage: atmoConfig.cloudCoverage ?? (atmoConfig.volumetricClouds === true ? 0.35 : 0.0),
                    cloudDensity: atmoConfig.cloudDensity ?? ((atmoConfig.volumetricClouds === true || (atmoConfig.cloudCoverage ?? 0) > 0) ? 0.3 : 0.0),
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
                cloudAltitude: atmoConfig.cloudAltitude ?? 2200.0,
                cloudCoverage: atmoConfig.cloudCoverage ?? (atmoConfig.volumetricClouds === true ? 0.35 : 0.0),
                cloudDensity: atmoConfig.cloudDensity ?? ((atmoConfig.volumetricClouds === true || (atmoConfig.cloudCoverage ?? 0) > 0) ? 0.3 : 0.0),
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
        // an explicit rig (lighting_configure_gaffer_rig) keeps its own colour temperatures, so no rig-wide Kelvin
        const customRig = isSceneLightingRig(input.lightingRig) && input.lightingRig.name === input.cinematicRig ? input.lightingRig : undefined;
        if (customRig || (rigKey && rigKey !== 'default')) {
            const rigLights = buildThreeJsLightingRig(customRig ?? rigKey, {
                kelvin: customRig ? undefined : input.lightingKelvin,
                scale: resolveStudioRigScale({ isLargeScale, contentRadiusMeters: input.contentRadiusMeters }),
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

    // God rays without an atmosphere: a spot emitter above the content, with the shafts streaming from it.
    if (!isSkySkybox && isGodRaysRequested(input.godRays)) {
        const cfg = (typeof input.godRays === 'object' && input.godRays !== null) ? input.godRays : {};
        const rigScale = resolveStudioRigScale({ isLargeScale, contentRadiusMeters: input.contentRadiusMeters });
        const [ex, ey, ez] = resolveGodRaysEmitterPosition(input.godRays, rigScale);
        const emitterColor = cfg.color !== undefined ? new THREE.Color(cfg.color) : new THREE.Color(0xfffae0);
        const distance = Math.hypot(ex, ey, ez);
        // Same irradiance at the content as the studio key light (18 cd at ~5 m), whatever the emitter distance.
        const emitter = new THREE.SpotLight(emitterColor, 18 * (distance / 5) ** 2 * (cfg.intensity ?? 1), 0, 0.55, 0.6, 2);
        emitter.name = 'god-rays-emitter';
        emitter.position.set(ex, ey, ez);
        emitter.target.position.set(0, 0, 0);
        emitter.castShadow = true;
        scene.add(emitter);
        scene.add(emitter.target);
        owned.push(emitter, emitter.target);
        sunPosition = new THREE.Vector3(ex, ey, ez);
        if (hasGodRays) {
            godRays = factories.createVolumetricGodRays(scene, sunPosition, false, cfg);
        }
    }

    // Procedural biome terrain (only when not standing on real terrain)
    if (hasBiomes && drawsProceduralBiomeTerrain(input)) {
        terrainBiome = factories.createProceduralBiomeTerrain(scene, biomeType, input.renderMode, isSunset);
        if (terrainCloudShadows && terrainBiome?.terrainMesh?.material) {
            terrainCloudShadows.attachToMaterial(terrainBiome.terrainMesh.material);
        }
    }

    // Neutral studio reflections for authored materials (metal, glass, clearcoat); never the background.
    let studioEnvironment: THREE.Texture | null = null;
    if (cls.studioReflections && typeof (stack.renderer as { getContext?: unknown })?.getContext === 'function') {
        const pmrem = new THREE.PMREMGenerator(stack.renderer);
        const room = new RoomEnvironment();
        studioEnvironment = pmrem.fromScene(room, 0.04).texture;
        room.dispose();
        pmrem.dispose();
        scene.environment = studioEnvironment;
        scene.environmentIntensity = STUDIO_REFLECTION_INTENSITY;
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
            if (studioEnvironment) {
                if (scene.environment === studioEnvironment) scene.environment = null;
                studioEnvironment.dispose();
            }
            scene.fog = null;
        }
    };
}
