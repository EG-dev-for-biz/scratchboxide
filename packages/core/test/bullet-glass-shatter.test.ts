/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    classifyFallbackPrompt,
    generateAdaptiveSandboxCode
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import {
    detect3DSceneTheme,
    generateDefaultCpp3DSource,
    synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { DEMO_SESSIONS } from '../src/browser/generative-canvas/state/studio-defaults';

describe('Bullet Glass Shatter & Ballistic Fracture System', () => {

    it('1. should classify user prompt as 3D request and prevent blank sandbox routing', () => {
        // Test verbatim user prompt from screenshot
        const prompt1 = 'build me a scene of a bully going through a plate of glass';
        const classification1 = classifyFallbackPrompt(prompt1);
        expect(classification1.is3DRequest).toBe(true);
        expect(classification1.isSandboxRequest).toBe(false);

        // Test variations
        const prompt2 = 'three.js bullet impact through plate of glass';
        const classification2 = classifyFallbackPrompt(prompt2);
        expect(classification2.is3DRequest).toBe(true);
        expect(classification2.isSandboxRequest).toBe(false);

        const prompt3 = 'supersonic projectile shattering glass window';
        const classification3 = classifyFallbackPrompt(prompt3);
        expect(classification3.is3DRequest).toBe(true);
        expect(classification3.isSandboxRequest).toBe(false);
    });

    it('2. should detect glass_shatter theme for ballistics and glass fracture prompts', () => {
        const theme = detect3DSceneTheme('build me a scene of a bully going through a plate of glass');
        expect(theme).toBe('glass_shatter');

        const theme2 = detect3DSceneTheme('bullet impact on glass pane');
        expect(theme2).toBe('glass_shatter');
    });

    it('3. should generate compilable C++20 ballistic fracture engine source code', () => {
        const cppSource = generateDefaultCpp3DSource('glass_shatter', 'Bullet Glass Impact');
        expect(cppSource).toContain('#include "scratchbox_engine.hpp"');
        expect(cppSource).toContain('using namespace scratchbox::fracture;');
        expect(cppSource).toContain('GlassPaneConfig pane;');
        expect(cppSource).toContain('BulletConfig bullet;');
        expect(cppSource).toContain('GlassFractureGenerator::buildCompleteScene');
        expect(cppSource).toContain('scratchbox::io::GlbWriter::writeGlb');
        expect(cppSource).toContain('scratchbox::io::GlbWriter::streamChunk');
        expect(cppSource).toContain('bullet_glass_impact');
    });

    it('4. should synthesize Scene3DData with Voronoi shards, bullet mesh, timeline, and C++ generator', () => {
        const scene = synthesizeContextual3DScene('build me a scene of a bully going through a plate of glass');
        expect(scene.sceneType).toBe('glass_shatter');
        expect(scene.renderMode).toBe('pbr');
        expect(scene.cameraMode).toBe('orbit');
        expect(scene.timeline).toBeDefined();
        expect(scene.timeline?.isPlaying).toBe(true);
        expect(scene.timeline?.durationMs).toBe(3000);

        // Verify C++ generator is attached
        expect(scene.cppGenerator).toBeDefined();
        expect(scene.cppGenerator?.enabled).toBe(true);
        expect(scene.cppGenerator?.filename).toBe('world_generator.cpp');
        expect(scene.cppGenerator?.sourceCode).toContain('#include "scratchbox_engine.hpp"');
        expect(scene.cppGenerator?.sourceCode).toContain('GlassFractureGenerator::buildCompleteScene');

        // Verify meshes
        expect(scene.customMeshes).toBeDefined();
        const meshes = scene.customMeshes!;
        expect(meshes.some(m => m.name === 'Clamping_Frame')).toBe(true);
        expect(meshes.some(m => m.name === 'Intact_Glass_Pane')).toBe(true);
        expect(meshes.some(m => m.name === 'Spitzer_Bullet_9mm')).toBe(true);
        expect(meshes.some(m => m.name === 'Supersonic_Mach_Cone')).toBe(true);
        expect(meshes.filter(m => m.name.startsWith('Voronoi_Shard_')).length).toBeGreaterThanOrEqual(20);

        // Verify customScript animation logic is present
        expect(scene.customScript).toBeDefined();
        expect(scene.customScript).toContain('Spitzer_Bullet_9mm');
        expect(scene.customScript).toContain('Voronoi_Shard_');
        expect(scene.customScript).toContain('onFrame');
    });

    it('5. should provide adaptive sandbox code with ballistic canvas simulation if sandbox is triggered', () => {
        const code = generateAdaptiveSandboxCode('bullet going through plate of glass');
        expect(code).toContain('Ballistic Glass Impact Simulation');
        expect(code).toContain('canvas');
        expect(code).toContain('requestAnimationFrame');
        expect(code).toContain('shards');
        expect(code).toContain('projectile');
    });

    it('6. should initialize sess-active-threejs with 3D scene artifact and user prompt', () => {
        const session = DEMO_SESSIONS.find(s => s.id === 'sess-active-threejs');
        expect(session).toBeDefined();
        expect(session?.layoutMode).toBe('3d');
        expect(session?.activeArtifact).toBeDefined();
        expect(session?.activeArtifact?.type).toBe('3d-scene');
        expect(session?.messages.length).toBeGreaterThanOrEqual(2);
        expect(session?.messages[0].text).toContain('bully going through a plate of glass');
    });
});
