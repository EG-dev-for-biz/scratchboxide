/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * 3D routing is the model's decision: no noun regex adds a location or hero directive to the user's prompt, and
 * one 3D intent policy reaches every prompt through the system instruction.
 */

import { describe, it, expect } from 'vitest';
import { buildContents, buildSystemInstruction, SB_PYTHON_SCRIPT_GUIDE, SPATIAL_INTENT_POLICY } from '../src/node/gemini/prompt-builder';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';

const PROMPTS = [
    'a vintage brass telescope on a tripod',
    'make me a hand-carved wooden chess knight',
    'build a 3d tower',
    'build a race car in Seattle',
    'build a gondola in venice',
    'Eiffel Tower',
    'an abstract sculpture of intertwined ribbons',
    'a bioluminescent mycelium lantern',
    'what is the capital of France?',
    'refactor the login handler to use async/await'
];

const userText = (prompt: string) => {
    const contents = buildContents({ prompt } as GeminiGenerateRequest);
    return contents[contents.length - 1].parts![0].text as string;
};

describe('3D routing: no keyword directives', () => {
    it('adds nothing to the user prompt for objects, places or anything else', () => {
        for (const prompt of PROMPTS) {
            const text = userText(prompt);
            expect(text, prompt).toBe(prompt);
        }
    });

    it('no longer ships the removed directives anywhere in the prompt', async () => {
        for (const prompt of PROMPTS) {
            const system = await buildSystemInstruction({ prompt, mode: 'agent' } as GeminiGenerateRequest);
            const all = system + userText(prompt);
            expect(all).not.toContain('PURE REAL-WORLD LOCATION QUERY');
            expect(all).not.toContain('HERO OBJECT STAGED AT REAL-WORLD LOCATION');
            expect(all).not.toContain('latent knowledge');
            expect(all).not.toContain('AdaptiveHeroObjectSynthesizer');
            expect(all).not.toContain("'generate_image'");
            expect(all).not.toMatch(/ALWAYS (?:use|lean on Python first via) (?:the )?'?execute_3d_python_script/);
        }
    });
});

describe('3D intent policy', () => {
    it('reaches every prompt in every mode', async () => {
        for (const mode of ['agent', 'plan', 'ask', 'studio', undefined]) {
            for (const prompt of PROMPTS) {
                const system = await buildSystemInstruction({ prompt, mode } as GeminiGenerateRequest);
                expect(system, `${mode}: ${prompt}`).toContain(SPATIAL_INTENT_POLICY);
            }
        }
    });

    it('names one tool per kind of request and leaves geocoding to the tools', () => {
        expect(SPATIAL_INTENT_POLICY).toContain('A real-world place');
        expect(SPATIAL_INTENT_POLICY).toContain('call google_3d_tiles_get_clay');
        expect(SPATIAL_INTENT_POLICY).toContain('remeshed in studio grey clay, with trees');
        expect(SPATIAL_INTENT_POLICY).toContain('isolate: true');
        expect(SPATIAL_INTENT_POLICY).toContain('abstract form, with no place: call build_3d_object_from_reference');
        expect(SPATIAL_INTENT_POLICY).toContain('An object at a real-world place: call build_3d_object_from_reference with location');
        expect(SPATIAL_INTENT_POLICY).toContain('Never supply coordinates from memory');
        expect(SPATIAL_INTENT_POLICY).toContain('not from particular words');
    });

    it('teaches script writing only where scripts can run', async () => {
        const agent = await buildSystemInstruction({ prompt: 'x', mode: 'agent' } as GeminiGenerateRequest);
        const plan = await buildSystemInstruction({ prompt: 'x', mode: 'plan' } as GeminiGenerateRequest);
        expect(agent).toContain(SB_PYTHON_SCRIPT_GUIDE);
        expect(plan).not.toContain(SB_PYTHON_SCRIPT_GUIDE);
        expect(SB_PYTHON_SCRIPT_GUIDE).not.toContain('Pattern 3');
        expect(SB_PYTHON_SCRIPT_GUIDE).not.toContain('Pattern 4');
        expect(SB_PYTHON_SCRIPT_GUIDE).toContain('Pattern 1');
    });

    it('sends objects at a place on an active scene to the reference builder', () => {
        const contents = buildContents({ prompt: 'put a bench here', activeArtifact: { id: 'a', type: '3d-scene', title: 'Plaza', data: {} } } as any);
        const text = contents[contents.length - 1].parts![0].text as string;
        expect(text).toContain('To build an object at a place, call build_3d_object_from_reference with location.');
        expect(text).not.toContain('execute_3d_python_script({ location');
    });
});
