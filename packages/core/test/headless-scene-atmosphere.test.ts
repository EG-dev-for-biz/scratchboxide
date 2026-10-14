/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
    synthesizeContextual3DScene,
    buildHeadlessAtmosphere
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { classifyAtmosphere } from '../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere';

describe('Headless Scene Atmosphere Architecture', () => {
    it('does not enable atmospheric scattering or sky dome on non-atmospheric scenes', () => {
        // Bullet through glass scene (user's explicit scenario)
        const glassScene = synthesizeContextual3DScene('build me a scene of a bully going through a plate of glass');
        expect(glassScene.sceneType).toBe('glass_shatter');
        expect(glassScene.features?.atmosphericScattering).toBeUndefined();
        expect(glassScene.environment?.skybox).toBe('studio');
        expect(glassScene.environment?.ground).toBe(false);

        // Robotic arm / lab scene
        const robotScene = synthesizeContextual3DScene('robotic arm picking up a silicon wafer in a sterile lab');
        expect(robotScene.features?.atmosphericScattering).toBeUndefined();
        expect(robotScene.environment?.skybox).not.toBe('realistic-sky');

        // Physics demo scene
        const physicsScene = synthesizeContextual3DScene('simulate double pendulum chaotic trajectory');
        expect(physicsScene.features?.atmosphericScattering).toBeUndefined();
    });

    it('enables physical atmospheric scattering when explicitly requested headlessly', () => {
        const atmospherePrompt = 'Create a scenic valley with atmospheric scattering, clouds and sunset haze';
        const outdoorScene = synthesizeContextual3DScene(atmospherePrompt);
        
        expect(outdoorScene.features?.atmosphericScattering).toBeDefined();
        const scattering = outdoorScene.features!.atmosphericScattering as any;
        expect(scattering.enabled).toBe(true);
        expect(scattering.rayleigh).toBeCloseTo(0.55);
        expect(scattering.mie).toBeCloseTo(0.003);
        expect(scattering.aerialPerspectiveEnabled).toBe(true);
        expect(scattering.cloudShadowsEnabled).toBe(true);
    });

    it('does not enable haze or fog when prompt does not request haze or fog', () => {
        const skyPrompt = 'Create a scenic valley with realistic sky and daylight';
        const outdoorScene = synthesizeContextual3DScene(skyPrompt);
        
        expect(outdoorScene.features?.atmosphericScattering).toBeDefined();
        const scattering = outdoorScene.features!.atmosphericScattering as any;
        expect(scattering.enabled).toBe(true);
        expect(scattering.aerialPerspectiveEnabled).toBe(false);
        expect(scattering.inscatteringIntensity).toBe(0.0);
        expect(outdoorScene.environment?.fog).toBeUndefined();
    });

    it('buildHeadlessAtmosphere constructs valid physical parameters with zero default haze/fog', () => {
        const defaultAtmosphere = buildHeadlessAtmosphere();
        expect(defaultAtmosphere.enabled).toBe(true);
        expect(defaultAtmosphere.rayleigh).toBe(0.55);
        expect(defaultAtmosphere.mie).toBe(0.003);
        expect(defaultAtmosphere.turbidity).toBe(1.6);
        expect(defaultAtmosphere.volumetricClouds).toBe(false);
        expect(defaultAtmosphere.cloudCoverage).toBe(0.0);
        expect(defaultAtmosphere.aerialPerspectiveEnabled).toBe(false);

        const customAtmosphere = buildHeadlessAtmosphere({
            rayleigh: 0.85,
            cloudCoverage: 0.72,
            cloudAltitude: 1800,
            aerialPerspectiveEnabled: true,
            windVector: [0.1, 0.04]
        });
        expect(customAtmosphere.rayleigh).toBe(0.85);
        expect(customAtmosphere.cloudCoverage).toBe(0.72);
        expect(customAtmosphere.cloudAltitude).toBe(1800);
        expect(customAtmosphere.aerialPerspectiveEnabled).toBe(true);
        expect(customAtmosphere.windVector).toEqual([0.1, 0.04]);
    });

    it('classifyAtmosphere strictly requires explicit headless atmosphere configuration and ignores title keywords', () => {
        // Scene with title containing sky/flight keywords but NO atmosphericScattering feature
        const nonAtmosphericClassification = classifyAtmosphere({
            skybox: 'studio',
            title: 'High-Altitude Airplane Flight in Blue Sky',
            dataTitle: 'Sunset Glider Flight',
            atmosphericScattering: undefined
        });

        expect(nonAtmosphericClassification.hasAtmosphere).toBe(false);
        expect(nonAtmosphericClassification.isSkySkybox).toBe(false);
        expect(nonAtmosphericClassification.effectiveAtmosphericScattering).toBeUndefined();

        // Scene with explicit atmospheric scattering configuration
        const atmosphericClassification = classifyAtmosphere({
            skybox: 'realistic-sky',
            atmosphericScattering: {
                enabled: true,
                rayleigh: 0.55
            }
        });

        expect(atmosphericClassification.hasAtmosphere).toBe(true);
        expect(atmosphericClassification.isSkySkybox).toBe(true);
        expect(atmosphericClassification.effectiveAtmosphericScattering).toBeDefined();

        // Scene with explicitly disabled atmospheric scattering
        const disabledClassification = classifyAtmosphere({
            skybox: 'realistic-sky',
            atmosphericScattering: {
                enabled: false
            }
        });

        expect(disabledClassification.hasAtmosphere).toBe(false);
    });

    it('confirms all Diurnal Time-of-Day Atmosphere Presets buttons have been removed from Scene3DPrimitive toolbar', () => {
        const primitiveFilePath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx');
        const sourceCode = fs.readFileSync(primitiveFilePath, 'utf-8');

        // Confirm preset comment and buttons are absent
        expect(sourceCode).not.toContain('Diurnal Time-of-Day Atmosphere Presets');
        expect(sourceCode).not.toContain("presetItem.label === 'Dawn'");
        expect(sourceCode).not.toContain("title={`${presetItem.label} Lighting & Physical Atmospheric Scattering`}");
    });

    it('defaults 3D scene background to clay grey (0xb0b8c4) unless specifically directed to be dark/black', () => {
        // Standard studio or unspecified scenes default to clay grey
        const studioScene = classifyAtmosphere({ skybox: 'studio' });
        expect(studioScene.backgroundHex).toBe(0xb0b8c4);

        const defaultScene = classifyAtmosphere({});
        expect(defaultScene.backgroundHex).toBe(0xb0b8c4);

        // Explicit daylight skybox gives soft sky-tinted clay
        const daylightScene = classifyAtmosphere({ skybox: 'daylight' });
        expect(daylightScene.backgroundHex).toBe(0xc4d4e8);

        // Directed dark/black scenes preserve dark backgrounds
        const spaceScene = classifyAtmosphere({ skybox: 'space' });
        expect(spaceScene.backgroundHex).toBe(0x0a0a0f);

        const cyberpunkScene = classifyAtmosphere({ worldBranch: 'earth/cyberpunk' });
        expect(cyberpunkScene.backgroundHex).toBe(0x0f0a1c);
    });

    it('confirms in-viewport C++20 Spatial Engine drawer and buttons are removed from Scene3DPrimitive', () => {
        const primitiveFilePath = path.resolve(__dirname, '../src/browser/generative-canvas/primitives/Scene3DPrimitive.tsx');
        const sourceCode = fs.readFileSync(primitiveFilePath, 'utf-8');

        expect(sourceCode).not.toContain('C++ Studio');
        expect(sourceCode).not.toContain('sb-3d-cpp-studio-panel');
        expect(sourceCode).not.toContain('handleCompileCpp');
    });

    it('syncAtmosphere sets scene.fog to null by default and only applies fog when explicitly configured', async () => {
        const THREE = await import('three');
        const { syncAtmosphere } = await import('../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere');

        const mockScene = new THREE.Scene();
        const mockGrid = new THREE.GridHelper(20, 20);
        const mockContainer = { clientWidth: 800, clientHeight: 600 } as any;
        const stack = {
            scene: mockScene,
            gridHelper: mockGrid,
            container: mockContainer,
            renderer: {} as any,
            camera: new THREE.PerspectiveCamera(),
            controls: {} as any
        };
        const factories = {
            createVolumetricGodRays: () => ({ dispose: () => {} }),
            createProceduralBiomeTerrain: () => ({ mesh: new THREE.Mesh(), dispose: () => {} })
        };

        // 1. Unconfigured default studio scene -> ZERO FOG
        const handle1 = syncAtmosphere(stack, { worldBranch: 'studio', renderMode: 'pbr', hasGeoCoordinates: false, has3DTiles: false }, factories);
        expect(mockScene.fog).toBeNull();
        handle1.dispose();

        // 2. Daylight skybox without explicit fog -> ZERO FOG
        const handle2 = syncAtmosphere(stack, {
            skybox: 'daylight',
            worldBranch: 'studio',
            renderMode: 'pbr',
            hasGeoCoordinates: false,
            has3DTiles: false,
            atmosphericScattering: { enabled: true }
        }, factories);
        expect(mockScene.fog).toBeNull();
        handle2.dispose();

        // 3. Explicit fog requested via input.fog -> FogExp2 created
        const handle3 = syncAtmosphere(stack, {
            worldBranch: 'studio',
            renderMode: 'pbr',
            hasGeoCoordinates: false,
            has3DTiles: false,
            fog: { density: 0.012, color: 0x8899aa }
        }, factories);
        expect(mockScene.fog).not.toBeNull();
        expect(mockScene.fog instanceof THREE.FogExp2).toBe(true);
        expect((mockScene.fog as any).density).toBe(0.012);
        handle3.dispose();
    });

    it('god rays place a light emitter in a studio scene without turning on atmosphere', async () => {
        const THREE = await import('three');
        const { syncAtmosphere } = await import('../src/browser/generative-canvas/primitives/scene3d/syncAtmosphere');

        const scene = new THREE.Scene();
        const stack = {
            scene,
            gridHelper: new THREE.GridHelper(20, 20),
            container: { clientWidth: 800, clientHeight: 600 } as any,
            renderer: {} as any,
            camera: new THREE.PerspectiveCamera(),
            controls: {} as any
        };
        const rayOrigins: number[][] = [];
        const factories = {
            createVolumetricGodRays: (_s: any, origin: any) => { rayOrigins.push(origin.toArray()); return { dispose: () => {} }; },
            createProceduralBiomeTerrain: () => ({ mesh: new THREE.Mesh(), dispose: () => {} })
        };
        const base = { skybox: 'studio', lighting: 'studio', worldBranch: 'studio', hasGeoCoordinates: false, has3DTiles: false };

        const handle = syncAtmosphere(stack as any, { ...base, renderMode: 'pbr', godRays: { emitterPosition: [3, 12, -2] } }, factories);
        const emitter = scene.getObjectByName('god-rays-emitter') as any;
        expect(emitter?.isSpotLight).toBe(true);
        expect(emitter.position.toArray()).toEqual([3, 12, -2]);
        expect(rayOrigins).toEqual([[3, 12, -2]]);
        expect(scene.fog).toBeNull();
        expect(classifyAtmosphere({ ...base, renderMode: 'pbr', godRays: true } as any).hasAtmosphere).toBe(false);
        handle.dispose();
        expect(scene.getObjectByName('god-rays-emitter')).toBeUndefined();

        // Clay mode keeps the emitter but leaves the shafts out.
        rayOrigins.length = 0;
        const clayHandle = syncAtmosphere(stack as any, { ...base, renderMode: 'clay', godRays: true }, factories);
        expect(scene.getObjectByName('god-rays-emitter')).toBeDefined();
        expect(rayOrigins).toEqual([]);
        clayHandle.dispose();
    });
});
