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
import { cleanMessageTextSmart } from '../src/browser/generative-canvas/ChatMarkdownRenderer';
import { CanvasArtifact, Scene3DData } from '../src/browser/generative-canvas/canvas-types';

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
