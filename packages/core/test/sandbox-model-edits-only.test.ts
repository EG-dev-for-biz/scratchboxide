/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The live code sandbox's AI buttons edit code with the model or say why they could not.
 *
 * - "Add JSDoc / Comments" proposes the model's commented file as a quick-edit diff. It used to call /generate, which
 *   now refuses replies without an artifact, and every failure wrote canned "Auto-generated JSDoc annotations" into
 *   the file as if the model had written them.
 * - The sandbox chat and its console "Auto-Fix with AI" button used to make no model call at all: after 600 ms they
 *   replaced every .tsx file with a template picked by prompt words (spring / glass / bento, else "Vibecoding Active").
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as Sandbox from '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
import { JSDOC_INSTRUCTION, proposeSandboxQuickEdit, runSandboxChatEdit, type SandboxQuickEditCall } from '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive';
import type { QuickEditRequest, QuickEditResponse } from '../src/common/gemini-protocol';

const file = { name: 'App.tsx', language: 'react' as const, content: 'export default function App() {\n  return <div>Hi</div>;\n}\n' };

function recordingCall(answer: (req: QuickEditRequest) => QuickEditResponse | Promise<QuickEditResponse>) {
    const calls: QuickEditRequest[] = [];
    const call: SandboxQuickEditCall = async req => { calls.push(req); return answer(req); };
    return { call, calls };
}

describe('Add JSDoc / Comments and ⌘K quick edit', () => {
    it('propose the model\'s code as a diff to review, sent with the JSDoc instruction', async () => {
        const commented = '/** Renders the greeting. */\n' + file.content;
        const { call, calls } = recordingCall(() => ({ success: true, proposedCode: commented, modelUsed: 'gemini-3.8-flash', credential: 'vertex' }));
        const proposal = await proposeSandboxQuickEdit(file, JSDOC_INSTRUCTION, call);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ originalCode: file.content, instruction: JSDOC_INSTRUCTION, fileName: 'App.tsx' });
        expect(proposal).toEqual({ kind: 'diff', originalCode: file.content, proposedCode: commented });
    });

    it('a failed model call is an error to show, never locally generated comments', async () => {
        const { call } = recordingCall(() => ({ success: false, proposedCode: file.content, error: 'The edit failed: Vertex AI error (503): overloaded' }));
        const proposal = await proposeSandboxQuickEdit(file, JSDOC_INSTRUCTION, call);
        expect(proposal).toEqual({ kind: 'error', error: 'The edit failed: Vertex AI error (503): overloaded' });

        const thrown = await proposeSandboxQuickEdit(file, JSDOC_INSTRUCTION, async () => { throw new Error('Failed to fetch'); });
        expect(thrown).toEqual({ kind: 'error', error: 'The edit failed: Failed to fetch' });
        // The pattern-matching comment writer is gone from the module.
        expect((Sandbox as Record<string, unknown>).generateLocalComments).toBeUndefined();
    });

    it('says which credential answered when the API key stood in for the service account', async () => {
        const { call } = recordingCall(() => ({ success: true, proposedCode: '// c\n' + file.content, credential: 'api-key', credentialNote: 'the Vertex AI service account could not get an access token (invalid_grant)' }));
        const proposal = await proposeSandboxQuickEdit(file, JSDOC_INSTRUCTION, call);
        expect(proposal).toMatchObject({ kind: 'diff', note: 'Answered with the Gemini API key — the Vertex AI service account could not get an access token (invalid_grant)' });
    });
});

describe('sandbox chat and Auto-Fix with AI', () => {
    it('asks the model with the user\'s words and returns its code, naming the model that edited', async () => {
        const fixed = 'export default function App() {\n  return <div>Fixed</div>;\n}\n';
        const { call, calls } = recordingCall(() => ({ success: true, proposedCode: fixed, modelUsed: 'gemini-3.8-flash', additions: 1, deletions: 1 }));
        // "spring" used to pick the canned Spring Motion UI template.
        const edit = await runSandboxChatEdit(file, 'Add a bouncy spring animation to the button', call);
        expect(calls).toEqual([{ originalCode: file.content, instruction: 'Add a bouncy spring animation to the button', language: 'react', fileName: 'App.tsx' }]);
        expect(edit).toEqual({ ok: true, content: fixed, reply: 'Edited App.tsx with gemini-3.8-flash (+1/-1 lines).' });
    });

    it('a failed call changes nothing and the reply carries the error', async () => {
        const { call } = recordingCall(() => ({ success: false, proposedCode: file.content, error: 'No Google Cloud service account or Gemini API key is configured, so no model can make this edit.' }));
        const edit = await runSandboxChatEdit(file, 'Auto-fix the following runtime error in file App.tsx:\n\nTypeError: x is undefined', call);
        expect(edit).toEqual({ ok: false, reply: 'No change made to App.tsx: No Google Cloud service account or Gemini API key is configured, so no model can make this edit.' });
        const none = await runSandboxChatEdit(undefined, 'make it glass', call);
        expect(none).toEqual({ ok: false, reply: 'No file is open, so there is nothing to edit.' });
    });

    it('the prompt-keyword templates are gone from the sandbox', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive.tsx'), 'utf-8');
        for (const canned of ['Vibecoding Active', 'Spring Motion UI', 'Liquid Glass Card', 'Performance Velocity', 'Auto-generated JSDoc annotations']) {
            expect(source).not.toContain(canned);
        }
    });
});
