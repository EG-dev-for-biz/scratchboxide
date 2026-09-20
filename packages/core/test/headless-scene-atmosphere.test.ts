/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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
        const atmospherePrompt = 'Create a scenic valley with atmospheric scattering and sunset haze';
        const outdoorScene = synthesizeContextual3DScene(atmospherePrompt);
        
        expect(outdoorScene.features?.atmosphericScattering).toBeDefined();
        const scattering = outdoorScene.features!.atmosphericScattering as any;
        expect(scattering.enabled).toBe(true);
        expect(scattering.rayleigh).toBeCloseTo(0.55);
        expect(scattering.mie).toBeCloseTo(0.003);
        expect(scattering.aerialPerspectiveEnabled).toBe(true);
        expect(scattering.cloudShadowsEnabled).toBe(true);
    });

    it('buildHeadlessAtmosphere constructs valid physical parameters with overrides', () => {
        const defaultAtmosphere = buildHeadlessAtmosphere();
        expect(defaultAtmosphere.enabled).toBe(true);
        expect(defaultAtmosphere.rayleigh).toBe(0.55);
        expect(defaultAtmosphere.mie).toBe(0.003);
        expect(defaultAtmosphere.turbidity).toBe(1.6);
        expect(defaultAtmosphere.volumetricClouds).toBe(true);
        expect(defaultAtmosphere.cloudCoverage).toBe(0.38);
        expect(defaultAtmosphere.aerialPerspectiveEnabled).toBe(true);

        const customAtmosphere = buildHeadlessAtmosphere({
            rayleigh: 0.85,
            cloudCoverage: 0.72,
            cloudAltitude: 1800,
            windVector: [0.1, 0.04]
        });
        expect(customAtmosphere.rayleigh).toBe(0.85);
        expect(customAtmosphere.cloudCoverage).toBe(0.72);
        expect(customAtmosphere.cloudAltitude).toBe(1800);
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
});
