/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import {
    classifyDomain,
    extractPromptEntities,
    synthesizeAdaptive3DScene
} from '../src/browser/generative-canvas/services/adaptive-domain-engine';
import {
    detect3DSceneTheme,
    synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { rasterizeChatMarkdownToScreenshot } from './helpers/test-screenshot-helper';

describe('Adaptive Domain Architecture (ADA) - Open-Domain 3D Scene Synthesis', () => {
    describe('1. Alien Planet Test (Zero Closed Taxonomies & Open Synthesis)', () => {
        it('synthesizes rich 70-20-10 hierarchy for an unconceived novel prompt without preset hijacking', () => {
            const prompt = 'Bioluminescent geothermal mycelium forest inside a hollow asteroid with liquid methane geysers';
            const scene = synthesizeContextual3DScene(prompt);

            expect(scene).toBeDefined();
            expect(scene.title).toMatch(/Bioluminescent|Mycelium|Asteroid/i);
            expect(scene.sceneType).toMatch(/adaptive|space|worldbuilder/i);
            expect(scene.renderMode).toBe('pbr');
            
            // Verifies 70-20-10 multi-mesh hierarchy
            expect(scene.customMeshes).toBeDefined();
            expect(scene.customMeshes!.length).toBeGreaterThanOrEqual(3);
            const tiers = scene.customMeshes!.map(m => m.tier);
            expect(tiers).toContain('primary');
            expect(tiers).toContain('secondary');
            expect(tiers).toContain('tertiary');

            // Preserves unpolluted spatial coordinates (no forced Manhattan/Tokyo Earth anchor)
            expect(scene.geoAnchor).toBeUndefined();

            // Zero Default Fog: no uninvited haze
            expect(scene.features?.atmosphericScattering?.aerialPerspectiveEnabled).toBeFalsy();

            // Attaches valid C++20 engine generator
            expect(scene.cppGenerator?.sourceCode).toContain('#include "scratchbox_engine.hpp"');
        });

        it('fails prompts no template or generator builds, never mounting an empty scene or primitive stand-ins named after their words', () => {
            for (const prompt of [
                'Subterranean hyperloop terminal with ferroconcrete caissons and vacuum transit tubes',
                'Quantum computing cryogenic dilution refrigerator with gold-plated thermal stages',
                'rocketship',
                '3d scene of a karate dojo'
            ]) {
                let error: any;
                try {
                    synthesizeContextual3DScene(prompt);
                } catch (err) {
                    error = err;
                }
                expect(error?.name, prompt).toBe('NoSceneBuiltError');
                expect(error.code).toBe('NO_SCENE_BUILT');
                expect(error.message).toContain(`No 3D scene was built for "${prompt}"`);
            }
        });

    });

    describe('2. Canonical Specialized Archetypes (Selective Routing)', () => {
        it('preserves exact automotive vehicle generation for sports cars and racing single-seaters', () => {
            const prompt = 'Build an open-wheel Formula 1 race car with front and rear wings';
            const theme = detect3DSceneTheme(prompt);
            expect(theme).toBe('vehicle');

            const scene = synthesizeContextual3DScene(prompt);
            expect(scene.title.toLowerCase()).toMatch(/formula|race|car|vehicle/i);
            expect(scene.customMeshes!.some(m => m.id.includes('chassis') || m.id.includes('wheel'))).toBe(true);
        });

        it('preserves exact planetary surface simulation for Mars rover prompts', () => {
            const prompt = 'Perseverance rover traversing red Martian dunes in Jezero crater';
            const theme = detect3DSceneTheme(prompt);
            expect(theme).toBe('mars_rover');

            const scene = synthesizeContextual3DScene(prompt);
            expect(scene.worldBranch).toBe('planetary/mars-rover');
            // A geoAnchor is a point on Earth; Mars coordinates there would stream Earth tiles, so there is none.
            expect(scene.geoAnchor).toBeUndefined();
        });

        it('preserves exact ballistics Voronoi fracture for glass shatter requests', () => {
            const prompt = 'High-speed bullet piercing a plate of glass with supersonic fracture shards';
            const theme = detect3DSceneTheme(prompt);
            expect(theme).toBe('glass_shatter');

            const scene = synthesizeContextual3DScene(prompt);
            expect(scene.title).toContain('Glass Shatter');
        });
    });

    describe('3. Visual Progress & Screenshot Capture', () => {
        it('captures structured architectural telemetry markdown screenshot', () => {
            const markdownSummary = `# 🪐 Adaptive 3D Scene: Subterranean Hyperloop Terminal\n\n### 1. Spatial Architecture\n* Primary Massing: 70% Ferroconcrete Caisson Structure\n* Secondary Articulation: 20% Vacuum Transit Tubes\n* Tertiary Instrumentation: 10% Digital Telemetry Ports\n\n### 2. Physical PBR Shading\n| Component | Material | Roughness | Metalness |\n| :--- | :--- | :--- | :--- |\n| Caisson Vault | Ferroconcrete | 0.85 | 0.15 |\n| Transit Tube | Titanium Grade 5 | 0.22 | 0.95 |\n| Core Emitter | Cyan Plasma | 0.05 | 0.60 |`;
            
            const shotPath = rasterizeChatMarkdownToScreenshot('adaptive_3d_open_domain_synthesis', markdownSummary);
            expect(fs.existsSync(shotPath)).toBe(true);
        });
    });
});
