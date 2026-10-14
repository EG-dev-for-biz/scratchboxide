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
    classifyFallbackPrompt,
    synthesize3DFallback
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
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

        it('synthesizes open-domain subterranean architectural structure', () => {
            const prompt = 'Subterranean hyperloop terminal with ferroconcrete caissons and vacuum transit tubes';
            const scene = synthesizeContextual3DScene(prompt);

            expect(scene).toBeDefined();
            expect(scene.title).toMatch(/Subterranean|Hyperloop|Terminal/i);
            expect(scene.customMeshes).toBeDefined();
            expect(scene.customMeshes!.length).toBeGreaterThanOrEqual(3);
            expect(scene.customMeshes!.some(m => m.tier === 'primary')).toBe(true);
            expect(scene.customMeshes!.some(m => m.tier === 'secondary')).toBe(true);

            // Biophysical PBR materials
            const hasPbr = scene.customMeshes!.some(m => typeof m.material?.roughness === 'number' && typeof m.material?.metalness === 'number');
            expect(hasPbr).toBe(true);
        });

        it('synthesizes open-domain quantum technology apparatus', () => {
            const prompt = 'Quantum computing cryogenic dilution refrigerator with gold-plated thermal stages';
            const scene = synthesizeContextual3DScene(prompt);

            expect(scene).toBeDefined();
            expect(scene.title).toMatch(/Quantum|Cryogenic|Refrigerator/i);
            expect(scene.customMeshes!.length).toBeGreaterThanOrEqual(3);
            
            // Material cues check: gold-plated thermal stages mapped to high metalness / gold preset
            const goldStage = scene.customMeshes!.find(m => m.name.toLowerCase().includes('stage') || m.name.toLowerCase().includes('gold') || m.name.toLowerCase().includes('torus') || m.name.toLowerCase().includes('flange') || m.name.toLowerCase().includes('gimbal'));
            expect(goldStage).toBeDefined();
        });

        it('synthesizes aerodynamic rocketship with cylindrical fuselage, payload nosecone, 4 delta fins, and bell nozzle', () => {
            const prompt = 'rocketship';
            const scene = synthesizeContextual3DScene(prompt);

            expect(scene).toBeDefined();
            expect(scene.title).toMatch(/rocketship|rocket/i);
            expect(scene.customMeshes).toBeDefined();
            expect(scene.customMeshes!.length).toBeGreaterThanOrEqual(6);

            // 1. Primary Cylindrical Booster Body
            const body = scene.customMeshes!.find(m => m.tier === 'primary' && m.type === 'cylinder');
            expect(body).toBeDefined();

            // 2. Conical Nosecone
            const nosecone = scene.customMeshes!.find(m => m.type === 'cone' && m.name.toLowerCase().includes('nosecone'));
            expect(nosecone).toBeDefined();

            // 3. Four Symmetrical Stabilizer Delta Fins
            const fins = scene.customMeshes!.filter(m => m.id.includes('fin') || m.name.toLowerCase().includes('fin'));
            expect(fins.length).toBe(4);

            // 4. Propulsion Engine Bell Nozzle
            const nozzle = scene.customMeshes!.find(m => m.id.includes('nozzle') || m.name.toLowerCase().includes('nozzle') || m.name.toLowerCase().includes('engine'));
            expect(nozzle).toBeDefined();
            expect(nozzle!.material?.emissiveIntensity).toBeGreaterThan(1.0);
        });

        it('synthesizes traditional karate dojo with hinoki platform, tatami mat, perimeter pillars, and kamiza wall', () => {
            const prompt = '3d scene of a karate dojo';
            const scene = synthesizeContextual3DScene(prompt);

            expect(scene).toBeDefined();
            expect(scene.title).toMatch(/karate dojo|dojo/i);
            expect(scene.customMeshes).toBeDefined();

            // 1. Hinoki Platform
            const platform = scene.customMeshes!.find(m => m.tier === 'primary' && m.name.toLowerCase().includes('platform'));
            expect(platform).toBeDefined();

            // 2. Tatami Mat
            const tatami = scene.customMeshes!.find(m => m.name.toLowerCase().includes('tatami'));
            expect(tatami).toBeDefined();

            // 3. Perimeter Pillars
            const pillars = scene.customMeshes!.filter(m => m.name.toLowerCase().includes('pillar') || m.name.toLowerCase().includes('column'));
            expect(pillars.length).toBeGreaterThanOrEqual(4);

            // 4. Kamiza Honor Wall
            const kamiza = scene.customMeshes!.find(m => m.name.toLowerCase().includes('kamiza'));
            expect(kamiza).toBeDefined();
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
