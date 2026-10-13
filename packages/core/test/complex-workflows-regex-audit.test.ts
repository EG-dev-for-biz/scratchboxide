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
    classifyFallbackPrompt,
    synthesizeSandboxFallback,
    synthesize3DFallback,
    synthesizeVideoTimelineFallback,
    synthesizeDefaultDocument
} from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import {
    extractScratchboxPrimitiveTag,
    is3DStudioIntent
} from '../src/node/gemini/artifact-synthesis';
import {
    resolveTaskCapability
} from '../src/node/agent/task-capability-resolver';
import {
    detectRealWorldLocationIntent
} from '../src/browser/generative-canvas/services/Google3DTileService';
import {
    parseContextMentions,
    findTriggerMatch
} from '../src/browser/generative-canvas/context-mention-engine';
import {
    isVibeToolRequest
} from '../src/browser/generative-canvas/vibe-tool-synthesizer';

describe('Complex Workflows Prompt & Regex Audit', () => {

    describe('1. 3D Spatial & Procedural World Prompt Triggers', () => {
        const testCases = [
            'Create a 3D futuristic megacity hub with flying transit vehicles and neon skyscrapers',
            'Build me a 3D scene of a medieval castle fortress under siege',
            'Render a Mars rover habitat with red terrain and solar collectors in 3D',
            'Generate a procedural mountain terrain with alpine snow peaks and pine forests',
            'Simulate an asteroid belt orbiting a gas giant in 3D space',
            'Show me a sports car model with metallic PBR materials',
            'Build a 3D cyberpunk street canyon with wet asphalt and volumetric god rays'
        ];

        testCases.forEach(prompt => {
            it(`correctly classifies 3D intent for: "${prompt.slice(0, 50)}..."`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
                expect(classification.is3DRequest).toBe(true);
            });
        });

        it('detects 3D studio intent via is3DStudioIntent helper', () => {
            expect(is3DStudioIntent('procedural marching cubes terrain', 'Terrain Generator')).toBe(true);
            expect(is3DStudioIntent('build glb mesh using cpp engine', 'C++ World')).toBe(true);
            expect(is3DStudioIntent('sdf signed distance field simulation', 'SDF Raymarcher')).toBe(true);
        });
    });

    describe('2. Real-World Geodetic Coordinates & Landmarks Prompt Triggers', () => {
        it('extracts explicit latitude and longitude coordinates', () => {
            const prompt = 'Ingest 3D tiles around lat 41.8902, lng 12.4922 with maximum leaf LOD';
            const location = detectRealWorldLocationIntent(prompt);
            expect(location).toBeDefined();
            expect(location?.isRealWorld).toBe(true);
            expect(location?.lat).toBeCloseTo(41.8902, 3);
            expect(location?.lng).toBeCloseTo(12.4922, 3);
        });

        it('extracts iconic landmarks by name from prompt', () => {
            const prompt = 'Reconstruct the Roman Colosseum in photorealistic 3D tiles';
            const location = detectRealWorldLocationIntent(prompt);
            expect(location).toBeDefined();
            expect(location?.isRealWorld).toBe(true);
            expect(location?.landmarkName?.toLowerCase()).toContain('colosseum');
        });

        it('extracts metropolitan cities by name from prompt', () => {
            const prompt = 'Build a 3D tile model of Paris around the Eiffel Tower';
            const location = detectRealWorldLocationIntent(prompt);
            expect(location).toBeDefined();
            expect(location?.isRealWorld).toBe(true);
        });
    });

    describe('3. Multi-Track Video Timeline NLE Prompt Triggers', () => {
        const videoPrompts = [
            '/timeline assemble multi-track intro sequence',
            '/video compose teaser trailer',
            'Create a video timeline with green screen chroma keying and despill',
            'Assemble a multi-track video editor with ripple delete and playhead scrubbing',
            'Cut active clip at 5 seconds and add picture in picture pip overlay',
            'Build a video timeline with audio mixer track and color grade clip'
        ];

        videoPrompts.forEach(prompt => {
            it(`correctly identifies video timeline NLE intent for: "${prompt.slice(0, 50)}..."`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
                expect(classification.isVideoTimelineRequest).toBe(true);
            });
        });
    });

    describe('4. Visual Node Graph Automation Prompt Triggers', () => {
        const graphPrompts = [
            'Create a node graph pipeline for automated data ingestion',
            'Generate a workflow pipeline connecting webhook to AI classifier',
            'Build a system diagram with event triggers and transform nodes',
            'Make an architecture map showing microservices routing'
        ];

        graphPrompts.forEach(prompt => {
            it(`correctly identifies node graph intent for: "${prompt.slice(0, 50)}..."`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
                expect(classification.isGraphRequest).toBe(true);
            });
        });
    });

    describe('5. Sprint Roadmap Kanban Prompt Triggers', () => {
        const kanbanPrompts = [
            'Create a kanban board for our sprint tasks',
            'Generate a sprint board with backlog, in-progress, review, and done',
            'Build a task board to manage the 3D engine migration roadmap',
            'Make a todo board for release milestones'
        ];

        kanbanPrompts.forEach(prompt => {
            it(`correctly identifies kanban board intent for: "${prompt.slice(0, 50)}..."`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
                expect(classification.isKanbanRequest).toBe(true);
            });
        });
    });

    describe('6. Quantitative KPI Telemetry Dashboard Prompt Triggers', () => {
        const metricsPrompts = [
            'Create a KPI dashboard tracking API throughput, latency, and error rate',
            'Generate a metric dashboard with sparkline charts and trend indicators',
            'Build a telemetry dashboard for distributed cluster memory usage',
            'Summarize into metrics the quarterly performance indicators'
        ];

        metricsPrompts.forEach(prompt => {
            it(`correctly identifies KPI metrics dashboard intent for: "${prompt.slice(0, 50)}..."`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
                expect(classification.isMetricsRequest).toBe(true);
            });
        });
    });

    describe('7. Interactive Full-Stack Code Sandbox & Vibe-Tooling Prompt Triggers', () => {
        const sandboxPrompts = [
            'Build an interactive 8-bit synthesizer app with virtual keyboard and frequency spectrum',
            'Create a runnable prototype calculator for orbital delta-v transfer',
            'Code a React sorting visualizer with audio feedback and speed slider',
            'Generate an interactive physics playground with bouncing rigid bodies',
            'Prototype a web app dashboard for weather telemetry'
        ];

        sandboxPrompts.forEach(prompt => {
            it(`correctly identifies live code sandbox intent for: "${prompt.slice(0, 50)}..."`, () => {
                const c = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
                expect({ prompt, isSandbox: c.isSandboxRequest, is3D: c.is3DRequest, isDoc: c.isDocumentRequest, isChat: c.isChatIntent })
                    .toEqual({ prompt, isSandbox: true, is3D: false, isDoc: false, isChat: false });
            });
        });

        it('detects vibe-coding micro-studio requests via isVibeToolRequest', () => {
            expect(isVibeToolRequest('vibe code a custom 3D blocking tool for camera layout')).toBe(true);
            expect(isVibeToolRequest('build a micro-studio editor app for procedural materials')).toBe(true);
            expect(isVibeToolRequest('vibe-code a pre-viz director tool')).toBe(true);
        });

        it('does not falsely classify generic non-geo words like transfer as SF real-world locations', () => {
            const loc = detectRealWorldLocationIntent('Create a runnable prototype calculator for orbital delta-v transfer');
            expect(loc).toBeUndefined();
        });
    });

    describe('8. Deep Architectural Spec Markdown Document Prompt Triggers', () => {
        const docPrompts = [
            '/doc write complete distributed system RFC',
            '/document draft architecture guidelines',
            '/deepwrite comprehensive security audit report',
            'Draft a specification for high-throughput zero-trust authentication',
            'Write a technical report on quantum annealing algorithms',
            'Draft an architectural proposal for native C++20 SIMD rendering'
        ];

        docPrompts.forEach(prompt => {
            it(`correctly identifies document spec intent for: "${prompt.slice(0, 50)}..."`, () => {
                const classification = classifyFallbackPrompt(prompt, undefined, 'chat', undefined);
                expect(classification.isDocumentRequest).toBe(true);
            });
        });
    });

    describe('9. Task Capability Resolver Regex Routing', () => {
        it('routes native C++20, Three.js, and procedural 3D natively', () => {
            const capability = resolveTaskCapability({
                userGoal: 'Build a procedural terrain mesh using C++20 Apple Clang and SIMD marching cubes',
                promptContext: 'Native 3D engine execution'
            });
            expect(capability.canSolveNatively).toBe(true);
            expect(capability.tier1Assessment.canSolveNatively).toBe(true);
        });

        it('routes UTDRA photogrammetric tile decomposition natively', () => {
            const capability = resolveTaskCapability({
                userGoal: 'Decompose photogrammetric 3D tiles using UTDRA algorithm to excise bridge voids and preserve crowns',
                promptContext: 'UTDRA tile processing'
            });
            expect(capability.canSolveNatively).toBe(true);
            expect(capability.tier1Assessment.canSolveNatively).toBe(true);
        });

        it('routes camera matchmoving and NOAA ephemeris natively', () => {
            const capability = resolveTaskCapability({
                userGoal: 'Calculate NOAA solar ephemeris and Brown-Conrady lens undistortion for camera solve',
                promptContext: 'VFX plate alignment'
            });
            expect(capability.canSolveNatively).toBe(true);
            expect(capability.tier1Assessment.canSolveNatively).toBe(true);
        });

        it('reports neural image-to-3D diffusion (Trellis / TripoSR) as not natively solvable', () => {
            const capability = resolveTaskCapability({
                userGoal: 'Generate a 3D mesh from a single photo using Trellis image-to-3d diffusion model',
                promptContext: 'Neural reconstruction'
            });
            expect(capability.canSolveNatively).toBe(false);
            expect(capability.tier1Assessment.canSolveNatively).toBe(false);
        });

        it('reports neural video-to-video restyling as not natively solvable', () => {
            const capability = resolveTaskCapability({
                userGoal: 'Apply AnimateDiff video-to-video neural restyling with custom LoRA checkpoint',
                promptContext: 'Neural video transfer'
            });
            expect(capability.canSolveNatively).toBe(false);
            expect(capability.tier1Assessment.canSolveNatively).toBe(false);
        });
    });

    describe('10. Unified Artifact Tag Architecture Regex Parsing', () => {
        it('parses canonical <scratchboxPrimitive> tag with attributes and inner JSON', () => {
            const modelOutput = `Here is your 3D scene:
<scratchboxPrimitive type="3d-scene" title="Orbital Habitat" summary="Futuristic space station" version="1.0">
\`\`\`json
{
  "environment": { "sky": "space", "sunPosition": [0, 10, 5] },
  "objects": [{ "id": "ring-1", "type": "cylinder", "position": [0, 0, 0] }]
}
\`\`\`
</scratchboxPrimitive>
Enjoy exploring the orbital station!`;

            const extracted = extractScratchboxPrimitiveTag(modelOutput);
            expect(extracted.matched).toBe(true);
            expect(extracted.type).toBe('3d-scene');
            expect(extracted.title).toBe('Orbital Habitat');
            expect(extracted.summary).toBe('Futuristic space station');
            expect(extracted.rawPayload).toContain('"environment"');
        });

        it('gracefully parses incomplete/streaming primitive tags without closing tag', () => {
            const streamingOutput = `<scratchboxPrimitive type="live-code-sandbox" title="Live Clock">
export default function App() { return <div>Clock</div>; }`;

            const extracted = extractScratchboxPrimitiveTag(streamingOutput);
            expect(extracted.matched).toBe(true);
            expect(extracted.type).toBe('live-code-sandbox');
            expect(extracted.title).toBe('Live Clock');
            expect(extracted.rawPayload).toContain('export default function App');
        });
    });

    describe('11. Context Mentions & Industry-Standard /skill Trigger Regexes', () => {
        it('extracts context mention triggers for @ and /', () => {
            const atTrigger = findTriggerMatch('@model', 6);
            expect(atTrigger).toBeDefined();
            expect(atTrigger?.type).toBe('context');
            expect(atTrigger?.query).toBe('model');

            const slashTrigger = findTriggerMatch('/skill', 6);
            expect(slashTrigger).toBeDefined();
            expect(slashTrigger?.type).toBe('skill');
            expect(slashTrigger?.query).toBe('skill');
        });

        it('parses multiple context mentions from a user prompt', () => {
            const prompt = 'Please review @file:packages/core/src/App.tsx and @git with @mcp:chrome';
            const parsed = parseContextMentions(prompt);
            expect(parsed.mentions.length).toBe(3);
            expect(parsed.mentions[0].type).toBe('file');
            expect(parsed.mentions[0].query).toBe('packages/core/src/App.tsx');
            expect(parsed.mentions[1].type).toBe('git');
            expect(parsed.mentions[2].type).toBe('mcp');
            expect(parsed.mentions[2].query).toBe('chrome');
        });
    });
});
