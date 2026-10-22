/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { availableToolNames } from '../src/node/gemini/tool-catalog';
import { describe, it, expect } from 'vitest';
import { GeminiService } from '../src/node/gemini-service';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';

describe('AI Beautify Agent Tool & Capability Resolution', () => {
    it('does not offer build_beautify_prompt (deprecated, hidden): the generating tools apply the template themselves', () => {
        const geminiService = new GeminiService();
        const request: GeminiGenerateRequest = {
            prompt: 'Beautify this 3D tiles rendering of Philadelphia Independence Hall',
            enableWorkspaceTools: true
        };

        const toolDeclarations = (geminiService as any).buildToolDeclarations(request);
        expect(toolDeclarations).toBeDefined();

        const fnDeclsContainer = toolDeclarations.find((t: any) => t.functionDeclarations);
        expect(fnDeclsContainer).toBeDefined();

        // Declared up front or loadable by name through load_tools (tool-catalog.ts).
        const toolNames = availableToolNames(toolDeclarations).all;

        expect(toolNames).not.toContain('build_beautify_prompt');
        expect(toolNames).toContain('survey_beautify_station');
        expect(toolNames).toContain('spatial_ai_render_scene');

        // Still registered for saved scripts, with its parameters intact.
        const registry = createDefaultToolRegistry();
        const beautifyTool = registry.get('build_beautify_prompt')!.declaration;
        expect(registry.get('build_beautify_prompt')!.offeredByDefault).toBe(false);
        expect(beautifyTool.parameters!.required).toContain('locationName');
        expect(beautifyTool.description).toMatch(/^DEPRECATED \(hidden since 2026-10-20; remove after one release\)/);
        expect(beautifyTool.parameters!.properties!.aspectRatio).toBeDefined();
        expect(beautifyTool.parameters!.properties!.distance).toBeDefined();
        expect(beautifyTool.parameters!.properties!.coords).toBeDefined();
        expect(beautifyTool.parameters!.properties!.heading).toBeDefined();
    });

    it('executes build_beautify_prompt via tool registry and produces verbatim template with distance', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'build_beautify_prompt',
            {
                locationName: 'Philadelphia Independence Hall',
                coords: '39.948900, -75.150000',
                heading: 180,
                earthUrl: 'https://earth.google.com/web/@39.948900,-75.150000,180h,45t',
                aspectRatio: '16:9',
                moodPromptContext: 'Crisp autumn morning sunlight. ',
                distance: 120,
                styleSuffix: ' High dynamic range architectural photography.'
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.locationName).toBe('Philadelphia Independence Hall');
        expect(payload.heading).toBe(180);
        expect(payload.aspectRatio).toBe('16:9');

        const expectedPrompt =
            'Transform this malformed 3D photogrammetry render of Philadelphia Independence Hall (camera at coordinates 39.948900, -75.150000, facing 180°) into a photorealistic photograph. It is a mesh rebuilt automatically from aerial photographs: the shapes are roughly right but melted, warped and smeared, edges are rounded off, small parts are fused into blobs, and the texture is blurred and stretched. Map reference: https://earth.google.com/web/@39.948900,-75.150000,180h,45t. Crisp autumn morning sunlight. This is a real location — the reference image shows the actual 3D-rendered buildings, streets, and terrain at these exact coordinates. CRITICAL FRAMING RULES — non-negotiable: (1) Output MUST use exactly 16:9 aspect ratio, matching the reference image canvas. (2) Preserve the EXACT same camera angle, pitch, yaw, viewpoint, composition, focal length, and field of view as the reference. (3) Every building, street, and rooftop must stay in the same on-image position — do not pan, zoom, crop, recompose, or change the horizon line. (4) Do not invent or add buildings, landmarks, or features that are not visible in the reference. Add realistic textures, materials, atmospheric haze, natural lighting, and fine architectural detail to make this look like a real photograph taken from this exact vantage point. Subject distance: approximately 120 meters from camera (use this for depth-of-field, focus, and aerial-perspective haze). High dynamic range architectural photography.';

        expect(payload.prompt).toBe(expectedPrompt);
        expect(outcome.exec.summaryResult).toMatch(/Constructed AI Beautify prompt for Philadelphia Independence Hall/i);
    });

    it('executes build_beautify_prompt via tool registry omitting subjectDistanceHint when distance is omitted', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'build_beautify_prompt',
            {
                locationName: 'Midtown Manhattan',
                coords: '40.748400, -73.985700',
                heading: 45
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.prompt).not.toContain('Subject distance:');
        expect(payload.prompt).toContain('(camera at coordinates 40.748400, -73.985700, facing 45°)');
        expect(payload.prompt).toContain('CRITICAL FRAMING RULES — non-negotiable:');
    });

    it('TaskCapabilityResolver routes AI Beautify location tasks natively to Tier 1', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Beautify photorealistic 3D tiles of Philadelphia Independence Hall with buildBeautifyPrompt'
        );

        expect(resolution.canSolveNatively).toBe(true);
        expect(resolution.tier1Assessment.nativeCapabilitiesUsed.some(c => c.includes('buildBeautifyPrompt'))).toBe(true);
        expect(resolution.tier1Assessment.suggestedNativeAction?.serviceOrTool).toMatch(/buildBeautifyPrompt inside survey_beautify_station/);
    });
});
