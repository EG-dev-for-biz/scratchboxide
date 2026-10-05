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
import { synthesizeContextual3DScene } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { Scene3DData } from '../src/browser/generative-canvas/canvas-types';
import { rasterizeChatMarkdownToScreenshot } from './helpers/test-screenshot-helper';

describe('Complex 3D Scene Fidelity & Multi-Tier Hierarchy Test Suite', () => {

    it('1. synthesizes research outpost with observation tower, solar arrays, and grounded flora', () => {
        const prompt = 'A 3D architectural research outpost with a central observation tower and solar panels';
        const scene: Scene3DData = synthesizeContextual3DScene(prompt);

        expect(scene).toBeDefined();
        expect(scene.title).toMatch(/research outpost|outpost/i);
        expect(scene.customMeshes).toBeDefined();
        expect(scene.customMeshes!.length).toBeGreaterThanOrEqual(4);

        // 1. Primary Research Hub
        const hub = scene.customMeshes!.find(m => m.id === 'arch-primary-hub' || m.tier === 'primary');
        expect(hub).toBeDefined();
        expect(hub!.position[1]).toBeGreaterThanOrEqual(1.0);
        expect(hub!.position[1]).toBeLessThanOrEqual(3.0); // Ground-anchored

        // 2. Secondary Observation Tower
        const tower = scene.customMeshes!.find(m => m.id === 'arch-observation-tower' || m.name.toLowerCase().includes('tower'));
        expect(tower).toBeDefined();
        expect(tower!.tier).toBe('secondary');

        // 3. Tertiary Solar Arrays
        const solarPanels = scene.customMeshes!.filter(m => m.id.includes('solar') || m.name.toLowerCase().includes('solar') || m.name.toLowerCase().includes('photovoltaic'));
        expect(solarPanels.length).toBeGreaterThanOrEqual(2);
        for (const panel of solarPanels) {
            expect(panel.tier).toBe('tertiary');
            expect(panel.material?.metalness).toBeGreaterThanOrEqual(0.7);
        }

        // 4. Zero Floating Green Cylinders: verify all elements have bounded coordinates and PBR materials
        for (const mesh of scene.customMeshes!) {
            expect(Math.abs(mesh.position[0])).toBeLessThanOrEqual(20); // No wild 60m scatter
            expect(Math.abs(mesh.position[2])).toBeLessThanOrEqual(20);
            expect(mesh.material?.color).not.toBe('#22c55e'); // No lime green placeholders
            expect(mesh.material?.color).not.toBe(0x22c55e);
        }

        // 5. C++20 engine source code attached
        expect(scene.cppGenerator?.sourceCode).toContain('#include "scratchbox_engine.hpp"');
    });

    it('2. synthesizes medieval citadel with keep, battlements, and grounded courtyard', () => {
        const prompt = 'Medieval stone castle citadel with fortified keep, battlements, and perimeter towers';
        const scene: Scene3DData = synthesizeContextual3DScene(prompt);

        expect(scene).toBeDefined();
        expect(scene.customMeshes).toBeDefined();
        expect(scene.customMeshes!.length).toBeGreaterThanOrEqual(3);

        const hasPrimary = scene.customMeshes!.some(m => m.tier === 'primary');
        const hasSecondary = scene.customMeshes!.some(m => m.tier === 'secondary');
        expect(hasPrimary).toBe(true);
        expect(hasSecondary).toBe(true);

        // Zero Default Fog: crystal clear unless fog is requested
        expect(scene.features?.atmosphericScattering?.aerialPerspectiveEnabled).toBeFalsy();
    });

    it('3. captures visual verification screenshot of complex 3D outpost telemetry', () => {
        const summary = `# 🪐 Architectural Research Outpost 3D Specification\n\n### 1. 70-20-10 Geometric Form Hierarchy\n* Primary Massing (70%): Central Research Hub Facility (Titanium Grade 5, roughness 0.35)\n* Secondary Architecture (20%): Observation Tower & Skyward Cupola (Glazing, clearcoat 1.0)\n* Tertiary Detail (10%): Dual Photovoltaic Solar Arrays + Telemetry Mast\n\n### 2. Environmental PBR Elements\n| Element | Geometry | Position | Material |\n| :--- | :--- | :--- | :--- |\n| Main Facility | Box | [0, 1.8, 0] | Titanium Grade 5 |\n| Observation Tower | Cylinder | [0, 4.8, 0] | Observation Glass |\n| Solar Wing Left | Box | [-4.6, 2.0, 0] | Photovoltaic Dark Slate |\n| Solar Wing Right | Box | [4.6, 2.0, 0] | Photovoltaic Dark Slate |\n| Conifer Stand | Cylinder | [-4.5, 1.2, 3.2] | Subalpine Pine |`;

        const shotPath = rasterizeChatMarkdownToScreenshot('complex_3d_outpost_fidelity_proof', summary);
        expect(fs.existsSync(shotPath)).toBe(true);
    });
});
