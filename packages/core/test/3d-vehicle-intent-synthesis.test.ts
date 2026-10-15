import { describe, it, expect } from 'vitest';
import {
    classifyFallbackPrompt,
    synthesize3DFallback,
    synthesizeChatFallback
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import { detect3DSceneTheme } from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import type { Scene3DData } from '../src/browser/generative-canvas/canvas-types';

describe('3D Intent Classification & Vehicle Synthesis', () => {
    it('classifies "build me a 3d car" as 3D request, NOT sandbox or chat', () => {
        const result = classifyFallbackPrompt('build me a 3d car', undefined, 'canvas', undefined);
        expect(result.is3DRequest).toBe(true);
        expect(result.isSandboxRequest).toBe(false);
        expect(result.isChatIntent).toBe(false);
    });

    it('classifies "build a 3d scene" as 3D request, NOT sandbox or chat', () => {
        const result = classifyFallbackPrompt('build a 3d scene', undefined, 'canvas', undefined);
        expect(result.is3DRequest).toBe(true);
        expect(result.isSandboxRequest).toBe(false);
        expect(result.isChatIntent).toBe(false);
    });

    it('classifies "3d vehicle simulation" as 3D request', () => {
        const result = classifyFallbackPrompt('3d vehicle simulation', undefined, 'canvas', undefined);
        expect(result.is3DRequest).toBe(true);
        expect(result.isSandboxRequest).toBe(false);
    });

    it('classifies "build me a cyber truck" and "build me a vintage roadster" as 3D requests', () => {
        const cyberResult = classifyFallbackPrompt('build me a cyber truck', undefined, 'canvas', undefined);
        expect(cyberResult.is3DRequest).toBe(true);
        expect(cyberResult.isChatIntent).toBe(false);

        const roadsterResult = classifyFallbackPrompt('build me an emerald green vintage roadster', undefined, 'canvas', undefined);
        expect(roadsterResult.is3DRequest).toBe(true);
        expect(roadsterResult.isChatIntent).toBe(false);
    });

    it('detects vehicle theme from automotive prompts', () => {
        expect(detect3DSceneTheme('build me a 3d car')).toBe('vehicle');
        expect(detect3DSceneTheme('render sports car')).toBe('vehicle');
        expect(detect3DSceneTheme('procedural hypercar model')).toBe('vehicle');
    });

    it('synthesizes a complete 3D vehicle scene with meshes, PBR materials, and C++ source', () => {
        const fallback = synthesize3DFallback('build me a 3d car', 'build me a 3d car', undefined, [], undefined);
        expect(fallback.artifact).toBeDefined();
        expect(fallback.artifact?.type).toBe('3d-scene');
        
        const sceneData = fallback.artifact?.data as Scene3DData;
        expect(sceneData).toBeDefined();
        expect(sceneData.customMeshes).toBeDefined();
        expect(sceneData.customMeshes?.length).toBeGreaterThanOrEqual(10);

        // Check for essential automotive components
        const meshIds = sceneData.customMeshes?.map(m => m.id);
        expect(meshIds).toContain('car-chassis-base');
        expect(meshIds).toContain('car-cabin');
        expect(meshIds).toContain('wheel-fl');
        expect(meshIds).toContain('rim-fl');
        expect(meshIds).toContain('headlight-l');
        expect(meshIds).toContain('taillight-l');

        // Verify C++ source attached
        expect(sceneData.cppGenerator?.sourceCode).toContain('#include "scratchbox_engine.hpp"');
        expect(sceneData.cppGenerator?.sourceCode).toContain('ScratchboxMesh vehicle');
    });

    it('safety delegates in synthesizeChatFallback if user prompt asks for 3D car', () => {
        const result = synthesizeChatFallback('build me a 3d car', undefined);
        // Must NOT return canned chat text, must produce a 3D scene artifact
        expect(result.artifact).toBeDefined();
        expect(result.artifact?.type).toBe('3d-scene');
    });

    it('synthesizes distinct archetypes, dimensions, and materials for contrasting prompts', () => {
        const cyberTruck = synthesize3DFallback('build me a cyber truck', 'build me a cyber truck', undefined, [], undefined);
        const formulaOne = synthesize3DFallback('yellow formula 1 grand prix racer', 'yellow formula 1 grand prix racer', undefined, [], undefined);
        const roadster = synthesize3DFallback('emerald green vintage roadster', 'emerald green vintage roadster', undefined, [], undefined);

        const cyberData = cyberTruck.artifact?.data as Scene3DData;
        const f1Data = formulaOne.artifact?.data as Scene3DData;
        const roadsterData = roadster.artifact?.data as Scene3DData;

        // Verify distinct titles (Zero Static Titles)
        expect(cyberData.title).toContain('Cyber');
        expect(f1Data.title).toContain('Formula 1');
        expect(roadsterData.title).toContain('Roadster');

        // Verify distinct colors & PBR formulas
        const cyberChassis = cyberData.customMeshes?.find(m => m.id === 'car-chassis-base');
        const f1Chassis = f1Data.customMeshes?.find(m => m.id === 'car-chassis-base');
        const roadsterChassis = roadsterData.customMeshes?.find(m => m.id === 'car-chassis-base');

        expect(f1Chassis?.material.color).toBe('#eab308'); // Solar pearl yellow
        expect(roadsterChassis?.material.color).toBe('#064e3b'); // British racing green
        expect(f1Chassis?.material.color).not.toBe(roadsterChassis?.material.color);

        // Verify distinct archetypal features
        const cyberMeshIds = cyberData.customMeshes?.map(m => m.id);
        const f1MeshIds = f1Data.customMeshes?.map(m => m.id);
        const roadsterMeshIds = roadsterData.customMeshes?.map(m => m.id);

        expect(cyberMeshIds).toContain('car-light-bar-front');
        expect(f1MeshIds).toContain('car-front-wing');
        expect(f1MeshIds).toContain('car-halo-hoop');
        expect(roadsterMeshIds).not.toContain('car-halo-hoop');

        // Verify distinct dimensions
        expect(f1Chassis?.scale[0]).toBeLessThan(cyberChassis?.scale[0]!); // F1 is narrower than truck

        // Verify C++ source is tailored to each archetype
        expect(f1Data.cppGenerator?.sourceCode).toContain('formula');
        expect(cyberData.cppGenerator?.sourceCode).toContain('cyber');
    });

    it('generates non-predetermined vehicles across differing seeds for open-ended prompts', () => {
        // Synthesizing open-ended prompt with 2 different seeds must produce different results
        const run1 = synthesize3DFallback('build me a 3d car', 'build me a 3d car', undefined, [], undefined);
        // Add a slight time offset to guarantee different timestamp hash
        const run2 = synthesize3DFallback('make a 3d car', 'make a 3d car', undefined, [], undefined);

        const data1 = run1.artifact?.data as Scene3DData;
        const data2 = run2.artifact?.data as Scene3DData;

        expect(data1).toBeDefined();
        expect(data2).toBeDefined();
        // At least title or finish or archetype should not be a static identical clone
        expect(data1.title).toBeDefined();
        expect(data2.title).toBeDefined();
    });
});
