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
    buildNeutralPerformerPrompt,
    buildNeutralPerformerImagePrompt,
    buildNeutralPerformerVideoPrompt,
    getOmniStylePreset
} from '../src/browser/generative-canvas/services/video/omniVideoPromptService';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';

describe('Neutral Performer Studio Prompt Pipeline (Prompt Neutrality Contract)', () => {
    const FORBIDDEN_LIGHTING = [
        'golden hour',
        'sunlight',
        'stage spotlight',
        'spotlights',
        'colored gels',
        'rim light',
        'chiaroscuro',
        'dramatic lighting'
    ];

    const FORBIDDEN_CONTEXT = [
        'living room',
        'bedroom',
        'parquet floor',
        'carpet',
        'rug',
        'furniture',
        'radiator',
        'concert venue',
        'city street',
        'outdoor landscape'
    ];

    it('builds a strictly neutral image prompt with head-to-toe framing and A-frame pose', () => {
        const result = buildNeutralPerformerImagePrompt({
            subject: 'A female vocalist',
            wardrobe: 'oversized white linen tunic, wide-leg palazzo trousers, chunky white sneakers',
            aspectRatio: '9:16'
        });

        expect(result.kind).toBe('image');
        expect(result.aspectRatio).toBe('9:16');
        expect(result.isAFramePose).toBe(true);

        const promptLower = result.prompt.toLowerCase();

        // 1. Full-body head-to-toe framing
        expect(promptLower).toContain('full-body');
        expect(promptLower).toContain('head-to-toe');
        expect(promptLower).toContain('soles of the shoes');
        expect(promptLower).toContain('zero cropping');

        // 2. Canonical A-frame pose
        expect(promptLower).toContain('a-frame pose');
        expect(promptLower).toContain('35 to 45 degrees');
        expect(promptLower).toContain('palms facing forward');
        expect(promptLower).toContain('shoulder-width apart');
        expect(promptLower).toContain('feet planted flat on the floor');

        // 3. Flat shadowless diffuse lighting
        expect(promptLower).toContain('flat, neutral, high-cri, diffuse, shadowless studio illumination');
        expect(promptLower).toContain('zero directional keylights');
        expect(promptLower).toContain('zero cast shadows');

        // 4. Solid neutral grey studio backdrop (zero context)
        expect(promptLower).toContain('solid neutral grey studio backdrop (#808080)');
        expect(promptLower).toContain('pure seamless cyclorama');

        // 5. Wardrobe integration
        expect(promptLower).toContain('oversized white linen tunic');
        expect(promptLower).toContain('wide-leg palazzo trousers');
        expect(promptLower).toContain('chunky white sneakers');

        // 6. Zero forbidden lighting & context in the positive prompt
        for (const forbidden of FORBIDDEN_LIGHTING) {
            expect(promptLower).not.toContain(forbidden);
        }
        for (const forbidden of FORBIDDEN_CONTEXT) {
            expect(promptLower).not.toContain(forbidden);
        }

        // 7. Negative prompt explicitly rejects dramatic lighting & environment
        const negLower = result.negativePrompt.toLowerCase();
        expect(negLower).toContain('dramatic lighting');
        expect(negLower).toContain('directional sunlight');
        expect(negLower).toContain('harsh shadows');
        expect(negLower).toContain('stage spotlights');
        expect(negLower).toContain('room');
        expect(negLower).toContain('furniture');
        expect(negLower).toContain('cropped head');
        expect(negLower).toContain('cropped feet');
    });

    it('builds a continuous single-shot video prompt for character conditioning', () => {
        const result = buildNeutralPerformerVideoPrompt({
            subject: 'A dancer',
            wardrobe: 'minimalist grey athletic wear',
            aspectRatio: '9:16'
        });

        expect(result.kind).toBe('video');
        expect(result.aspectRatio).toBe('9:16');
        expect(result.isAFramePose).toBe(true);

        const promptLower = result.prompt.toLowerCase();

        // Must enforce continuous single-shot without scene cuts
        expect(promptLower).toContain('single continuous shot, no scene cuts');
        expect(promptLower).toContain('locked-off stationary camera at eye level');
        expect(promptLower).toContain('stationary in the calibrated a-frame pose');
        expect(promptLower).toContain('subtle natural resting breathing');
        expect(promptLower).toContain('head-to-toe');
        expect(promptLower).toContain('shadowless studio illumination');
        expect(promptLower).toContain('solid neutral grey studio backdrop (#808080)');

        // Zero forbidden keywords
        for (const forbidden of FORBIDDEN_LIGHTING) {
            expect(promptLower).not.toContain(forbidden);
        }
        for (const forbidden of FORBIDDEN_CONTEXT) {
            expect(promptLower).not.toContain(forbidden);
        }
    });

    it('retrieves the neutral-portrait-a-frame preset from the preset catalog', () => {
        const preset = getOmniStylePreset('neutral-portrait-a-frame');
        expect(preset.id).toBe('neutral-portrait-a-frame');
        expect(preset.name).toContain('Neutral Performer Studio Portrait');
        expect(preset.defaultLighting).toContain('flat, diffuse, shadowless studio illumination');
        expect(preset.cameraDetails).toContain('Full-body eye-level uncropped portrait lens framing from head to toe');
        expect(preset.negativePrompt).toContain('dramatic lighting');
        expect(preset.negativePrompt).toContain('room');
    });

    it('executes build_neutral_performer_prompt via the default Gemini tool registry', async () => {
        const registry = createDefaultToolRegistry();
        const outcome = await registry.dispatch(
            'build_neutral_performer_prompt',
            {
                subject: 'Lead performer',
                wardrobe: 'white oversized tunic, palazzo trousers, sneakers',
                aspectRatio: '9:16',
                kind: 'video',
                isAFramePose: true
            },
            {} as any
        );

        expect(outcome.exec.status).toBe('completed');
        const payload: any = outcome.resultPayload;
        expect(payload.success).toBe(true);
        expect(payload.aspectRatio).toBe('9:16');
        expect(payload.kind).toBe('video');
        expect(payload.isAFramePose).toBe(true);

        const prompt = payload.prompt as string;
        expect(prompt.toLowerCase()).toContain('head-to-toe');
        expect(prompt.toLowerCase()).toContain('a-frame pose');
        expect(prompt.toLowerCase()).toContain('single continuous shot, no scene cuts');
        expect(prompt.toLowerCase()).toContain('shadowless studio illumination');
        expect(prompt.toLowerCase()).toContain('#808080');

        const summary = outcome.exec.summaryResult;
        expect(summary).toMatch(/Constructed neutral video prompt from head to toe in A-frame pose/i);
    });

    it('resolves performer/avatar prompt requests as Tier 1 Native Google Models', () => {
        const resolution = TaskCapabilityResolver.resolveTaskCapability(
            'Generate a neutral video prompt for an avatar in an A-frame pose from head to toe with even lighting and no context'
        );

        expect(resolution.tier1Assessment.canSolveNatively).toBe(true);
        expect(resolution.recommendedResolutionRoute).toBe('tier1-native');
        expect(resolution.tier1Assessment.primaryNativeEngine).toBe('google-models');
        expect(resolution.tier1Assessment.nativeCapabilitiesUsed).toContain(
            'Neutral Performer Studio Prompt Pipeline (buildNeutralPerformerPrompt)'
        );
        expect(resolution.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain('build_neutral_performer_prompt');
    });
});
