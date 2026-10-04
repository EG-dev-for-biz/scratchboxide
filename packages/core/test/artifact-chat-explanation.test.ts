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
    extractPromptEntities,
    synthesizeAdaptive3DScene
} from '../src/browser/generative-canvas/services/adaptive-domain-engine';
import {
    buildFallbackAssistantText,
    buildArtifactExplanationMarkdown
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import { cleanMessageTextSmart } from '../src/browser/generative-canvas/ChatMarkdownRenderer';
import { CanvasArtifact, Scene3DData, LiveCodeSandboxData } from '../src/browser/generative-canvas/canvas-types';

describe('Cursor-Grade Chat Explanations & Viewport Cleanliness', () => {
    describe('1. Prompt Sanitization & Entity Extraction', () => {
        it('cleans clarification selection tags and question prefixes from prompt', () => {
            const rawPrompt = '[Clarification Selection]: Which 3D representation: Photorealistic Google 3D Tiles (PBR Mesh)';
            const entities = extractPromptEntities(rawPrompt);

            expect(entities.subject).not.toContain('[Clarification');
            expect(entities.subject).not.toContain('Which 3D representation');
            expect(entities.subject.toLowerCase()).toContain('photorealistic google 3d tiles');
        });

        it('cleans execution plan approval tags from prompt', () => {
            const rawPrompt = '[Execution Plan Approved]: Proceed with Tier 1 Native C++20 Astro pipeline for Mars Rover';
            const entities = extractPromptEntities(rawPrompt);

            expect(entities.subject).not.toContain('[Execution Plan');
            expect(entities.subject.toLowerCase()).toContain('mars rover');
        });

        it('generates clean titles and world branches for adaptive 3D scenes without meta tags', () => {
            const prompt = '[Clarification Selection]: Which 3D representation: Photorealistic Google 3D Tiles (PBR Mesh)';
            const scene = synthesizeAdaptive3DScene('geospatial', undefined, prompt);

            expect(scene.title).not.toContain('[Clarification');
            expect(scene.title).not.toContain('Which 3D representation');
            expect(scene.worldBranch).not.toContain('clarification-selection');
            expect(scene.worldBranch).not.toContain('which-3d-representation');
        });
    });

    describe('2. Cursor-Grade Markdown Chat Explanation Generation', () => {
        it('generates rich, structured explanation for 3D scenes with specs and controls', () => {
            const sceneData: Scene3DData = {
                title: 'Mars Rover Exploration Site',
                subtitle: 'Grounded planetary terrain with autonomous navigation rover',
                worldBranch: 'space/mars-rover',
                renderMode: 'pbr',
                cameraMode: 'orbit',
                geoAnchor: {
                    lat: 18.38,
                    lng: 77.58,
                    alt: 120,
                    heading: 45,
                    pitch: -15
                },
                environment: {
                    skybox: 'mars',
                    lighting: 'golden_hour',
                    lightingKelvin: 4200,
                    ground: true
                },
                cppGenerator: {
                    sourceCode: '#include "scratchbox_engine.hpp"\nvoid generate() {}',
                    glbPath: '/models/mars_rover.glb'
                },
                customMeshes: [
                    { id: 'chassis', name: 'Rover Chassis', type: 'box', position: [0, 0.5, 0], scale: [2, 1, 3] },
                    { id: 'mast', name: 'Sensor Mast', type: 'cylinder', position: [0, 1.5, 1], scale: [0.2, 1, 0.2] }
                ]
            };

            const artifact: CanvasArtifact = {
                id: 'art-3d-1',
                type: '3d-scene',
                title: 'Mars Rover Exploration Site',
                summary: 'Grounded planetary terrain with autonomous navigation rover',
                data: sceneData
            };

            const explanation = buildArtifactExplanationMarkdown(artifact);

            // Must include title / icon
            expect(explanation).toContain('Mars Rover Exploration Site');
            // Must include architectural specs
            expect(explanation).toMatch(/C\+\+20|Astro/i);
            expect(explanation).toMatch(/PBR/i);
            expect(explanation).toMatch(/18\.38°N.*77\.58°/);
            expect(explanation).toMatch(/4200K/);
            expect(explanation).toContain('Rover Chassis');
            // Must include clear interaction controls guide
            expect(explanation).toMatch(/Orbit|Pan|Zoom|Controls/i);
            expect(explanation).toMatch(/Space|Playhead|Export/i);
        });

        it('generates rich, structured explanation for Live Code Sandbox artifacts', () => {
            const sandboxData: LiveCodeSandboxData = {
                title: 'Interactive Audio Synthesizer',
                subtitle: 'Web Audio API oscillator with virtual keys',
                viewMode: 'preview',
                files: [
                    { name: 'App.tsx', content: 'export default function App() { return <div>Synth</div>; }' },
                    { name: 'synth.ts', content: 'export class SynthEngine {}' }
                ]
            };

            const artifact: CanvasArtifact = {
                id: 'art-sandbox-1',
                type: 'live-code-sandbox',
                title: 'Interactive Audio Synthesizer',
                summary: 'Web Audio API oscillator with virtual keys',
                data: sandboxData
            };

            const explanation = buildArtifactExplanationMarkdown(artifact);

            expect(explanation).toContain('Interactive Audio Synthesizer');
            expect(explanation).toMatch(/React 18|TypeScript|Tailwind/i);
            expect(explanation).toMatch(/App\.tsx|synth\.ts/);
            expect(explanation).toMatch(/Split|Code|Preview/i);
        });

        it('enriches sparse assistant chat messages with structured explanation', () => {
            const artifact: CanvasArtifact = {
                id: 'art-3d-2',
                type: '3d-scene',
                title: 'Neo-Tokyo Metropolitan Skyline',
                summary: 'Procedural cyberpunk urban core with volumetric lighting',
                data: {
                    title: 'Neo-Tokyo Metropolitan Skyline',
                    worldBranch: 'earth/cyberpunk',
                    renderMode: 'pbr'
                } as Scene3DData
            };

            // When LLM returned bare JSON or generic one-liner
            const cleaned = cleanMessageTextSmart('Here is the 3D scene JSON: ```json\n{"type":"3d-scene"}\n```', artifact);
            expect(cleaned).toContain('Neo-Tokyo Metropolitan Skyline');
            expect(cleaned).toMatch(/PBR|Camera|Controls/i);
        });
    });
});
