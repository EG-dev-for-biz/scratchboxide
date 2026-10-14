/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    detect3DSceneTheme,
    synthesizeContextual3DScene
} from '../src/browser/generative-canvas/procedural-3d-synthesizer';
import { Scene3DData, ChatMessage } from '../src/browser/generative-canvas/canvas-types';

describe('Mars Rover Exploration & Non-Earth Geospatial Guardrails', () => {
    describe('1. Mars Rover Theme Detection', () => {
        it('identifies mars rover exploration as mars_rover theme rather than solar-system or architecture', () => {
            const prompt = 'build a 3d scene for Mars Rover exploration';
            const theme = detect3DSceneTheme(prompt);
            expect(theme).toBe('mars_rover');
        });

        it('identifies curiosity, perseverance, and martian surface prompts as mars_rover', () => {
            expect(detect3DSceneTheme('perseverance rover traverse across jezero crater')).toBe('mars_rover');
            expect(detect3DSceneTheme('martian surface terrain with autonomous robotic rover')).toBe('mars_rover');
            expect(detect3DSceneTheme('curiosity rover on red planet')).toBe('mars_rover');
        });
    });

    describe('2. Mars Rover Procedural Scene Generation', () => {
        it('synthesizes authentic Martian surface terrain, 6-wheel rover, sensor mast, and dust atmosphere', () => {
            const prompt = 'build a 3d scene for Mars Rover exploration';
            const scene: Scene3DData = synthesizeContextual3DScene(prompt);

            // Title & branch must reflect Mars Rover exploration
            expect(scene.title.toLowerCase()).toContain('mars rover');
            expect(scene.worldBranch).toContain('mars');
            expect(scene.worldBranch).not.toContain('architecture');
            expect(scene.worldBranch).not.toContain('earth');

            // Must include Martian regolith and rover components
            const meshNames = (scene.customMeshes || []).map(m => m.name.toLowerCase());
            expect(meshNames.some(n => n.includes('regolith') || n.includes('martian') || n.includes('terrain'))).toBe(true);
            expect(meshNames.some(n => n.includes('rover') || n.includes('chassis') || n.includes('body'))).toBe(true);
            expect(meshNames.some(n => n.includes('mast') || n.includes('mastcam') || n.includes('camera'))).toBe(true);
            expect(meshNames.some(n => n.includes('wheel'))).toBe(true);

            // Environment must reflect Mars (not Earth studio daylight or Fallingwater)
            expect(scene.environment?.skybox).toMatch(/mars|dust|sunset|golden_hour/i);
            expect(scene.environment?.ground).toBe(true);
        });

        it('gives a Mars scene no geodetic anchor (Earth tiles would stream at the Jezero lat/lng in India)', () => {
            for (const prompt of ['build a 3d scene for Mars Rover exploration', 'perseverance rover traverse across jezero crater']) {
                const scene: Scene3DData = synthesizeContextual3DScene(prompt);
                expect(scene.geoAnchor).toBeUndefined();
            }
        });
    });

    describe('3. Clarification Selection Context Recovery', () => {
        it('recovers prior user goal when prompt is a clarification selection response', () => {
            const messages: ChatMessage[] = [
                {
                    id: 'msg-1',
                    sender: 'user',
                    text: 'build a 3d scene for Mars Rover exploration',
                    timestamp: '12:00 PM'
                },
                {
                    id: 'msg-2',
                    sender: 'assistant',
                    text: 'Please select configuration',
                    timestamp: '12:01 PM'
                }
            ];
            const answerText = '[Clarification Selection]: Which 3D representation and execution architecture do you want to generate?: Procedural C++20 Astro Mesh (.glb)';
            const priorUserMsg = [...messages].reverse().find(m =>
                m.sender === 'user' &&
                !m.text.startsWith('[Clarification Selection]') &&
                !m.text.startsWith('[Execution Plan') &&
                !m.text.startsWith('Confirmed. Proceed')
            );
            expect(priorUserMsg?.text).toBe('build a 3d scene for Mars Rover exploration');
            const recoveredPrompt = priorUserMsg?.text || answerText;
            const theme = detect3DSceneTheme(recoveredPrompt);
            expect(theme).toBe('mars_rover');
            const scene = synthesizeContextual3DScene(recoveredPrompt);
            expect(scene.title.toLowerCase()).toContain('mars rover');
            expect(scene.worldBranch).toContain('mars');
        });
    });
});
