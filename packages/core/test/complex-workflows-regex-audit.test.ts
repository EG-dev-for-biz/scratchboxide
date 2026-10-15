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
    extractScratchboxPrimitiveTag
} from '../src/node/gemini/artifact-synthesis';
import {
    resolveTaskCapability
} from '../src/node/agent/task-capability-resolver';
import {
    parseCoordinateText
} from '../src/common/coordinate/parse-coordinates';
import {
    parseContextMentions,
    findTriggerMatch
} from '../src/browser/generative-canvas/context-mention-engine';
import {
    isVibeToolRequest
} from '../src/browser/generative-canvas/vibe-tool-synthesizer';

describe('Complex Workflows Prompt & Regex Audit', () => {

    describe('2. Real-World Locations Are Not Parsed Out Of Prompts', () => {
        // Places are resolved by the location tools with Google Places; only text that is entirely a
        // coordinate pair is read as coordinates, so prose that happens to contain numbers never is.
        it('reads text that is entirely a coordinate pair', () => {
            expect(parseCoordinateText('41.8902, 12.4922')).toEqual({ lat: 41.8902, lng: 12.4922 });
            expect(parseCoordinateText('lat: 41.8902, lng: 12.4922')).toEqual({ lat: 41.8902, lng: 12.4922 });
        });

        it('does not pull coordinates or landmarks out of a sentence', () => {
            expect(parseCoordinateText('Ingest 3D tiles around lat 41.8902, lng 12.4922 with maximum leaf LOD')).toBeUndefined();
            expect(parseCoordinateText('Reconstruct the Roman Colosseum in photorealistic 3D tiles')).toBeUndefined();
            expect(parseCoordinateText('Pier 39, 2 Beach St, San Francisco')).toBeUndefined();
        });
    });

    describe('7. Interactive Full-Stack Code Sandbox & Vibe-Tooling Prompt Triggers', () => {
        it('detects vibe-coding micro-studio requests via isVibeToolRequest', () => {
            expect(isVibeToolRequest('vibe code a custom 3D blocking tool for camera layout')).toBe(true);
            expect(isVibeToolRequest('build a micro-studio editor app for procedural materials')).toBe(true);
            expect(isVibeToolRequest('vibe-code a pre-viz director tool')).toBe(true);
        });

        it('does not read a prompt with no coordinates as a location', () => {
            expect(parseCoordinateText('Create a runnable prototype calculator for orbital delta-v transfer')).toBeUndefined();
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
