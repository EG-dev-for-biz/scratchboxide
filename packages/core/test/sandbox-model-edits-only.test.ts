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
import type { CodeFileTab } from '../src/browser/generative-canvas/canvas-types';
import { QuickEditService } from '../src/node/quick-edit-service';

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

describe('a quick edit the model did not finish is not an edit', () => {
    const longFile = Array.from({ length: 300 }, (_, i) => `export function f${i}(x: number) {\n  return x + ${i};\n}`).join('\n');
    /** A QuickEditService whose model call returns `candidate` (no network; the request is recorded). */
    function serviceAnswering(candidate: Record<string, unknown>) {
        const requests: Array<{ model: string; config: any }> = [];
        const client = {
            getStatus: async () => ({ connected: true, authMethod: 'service-account', activeModel: 'gemini-3.8-flash' }),
            requestGenerateContent: async (model: string, _contents: unknown, _system: string, config: any) => {
                requests.push({ model, config });
                return { json: { candidates: [candidate] }, credential: 'vertex' as const };
            }
        };
        return { service: new QuickEditService(client as any), requests };
    }

    it('a reply cut off at the output limit fails with its reason, and the sandbox chat changes nothing', async () => {
        const cut = 'export function f0(x: number) {\n  return x + 0;\n}\n/** b */\nexport function f1(';
        const { service, requests } = serviceAnswering({ content: { parts: [{ text: cut }] }, finishReason: 'MAX_TOKENS' });
        const res = await service.quickEdit({ originalCode: longFile, instruction: 'Add JSDoc', language: 'typescript', fileName: 'App.tsx' });
        expect(res.success).toBe(false);
        expect(res.proposedCode).toBe(longFile);
        expect(res.error).toBe('gemini-3.8-flash stopped at its output limit before finishing App.tsx, so the file was not changed.');
        expect(res.modelUsed).toBe('gemini-3.8-flash');

        const edit = await runSandboxChatEdit({ name: 'App.tsx', language: 'react', content: longFile }, 'Add JSDoc', req => service.quickEdit(req));
        expect(edit).toEqual({ ok: false, reply: 'No change made to App.tsx: gemini-3.8-flash stopped at its output limit before finishing App.tsx, so the file was not changed.' });
        const proposal = await proposeSandboxQuickEdit({ name: 'App.tsx', language: 'react', content: longFile }, JSDOC_INSTRUCTION, req => service.quickEdit(req));
        expect(proposal.kind).toBe('error');

        // The budget is sized to the whole file, not a fixed 4096 tokens.
        expect(requests[0].config.maxOutputTokens).toBeGreaterThan(Math.ceil(longFile.length / 4));
    });

    it('other unfinished replies fail too; a finished one is the edit', async () => {
        const blocked = serviceAnswering({ content: { parts: [{ text: 'export' }] }, finishReason: 'SAFETY' });
        const res = await blocked.service.quickEdit({ originalCode: 'const a = 1;', instruction: 'rename', fileName: 'a.ts' });
        expect(res).toMatchObject({ success: false, error: 'gemini-3.8-flash stopped before finishing the edit (finish reason: SAFETY), so the file was not changed.' });

        const done = serviceAnswering({ content: { parts: [{ text: 'const b = 1;' }] }, finishReason: 'STOP' });
        expect(await done.service.quickEdit({ originalCode: 'const a = 1;', instruction: 'rename', fileName: 'a.ts' })).toMatchObject({ success: true, proposedCode: 'const b = 1;', modelUsed: 'gemini-3.8-flash' });
    });

    it('a prompt blocked before any reply says it was blocked, not that the model wrote no code', async () => {
        const client = {
            getStatus: async () => ({ connected: true, authMethod: 'service-account', activeModel: 'gemini-3.8-flash' }),
            requestGenerateContent: async () => ({ json: { promptFeedback: { blockReason: 'SAFETY' } }, credential: 'vertex' as const })
        };
        const res = await new QuickEditService(client as any).quickEdit({ originalCode: 'const a = 1;', instruction: 'rename', fileName: 'a.ts' });
        expect(res).toMatchObject({ success: false, proposedCode: 'const a = 1;', error: 'gemini-3.8-flash blocked this edit request (block reason: SAFETY), so the file was not changed.' });
    });
});

describe('a model edit lands in the file it was made for, as the files are when it arrives', () => {
    const tab = (id: string, name: string, content: string): CodeFileTab => ({ id, name, language: 'typescript', content });
    const app = tab('app', 'App.tsx', 'export const App = 1;\n');
    const css = tab('css', 'styles.css', 'body {}\n');

    it('typing in another file while the sandbox chat edit runs keeps that typing', () => {
        const settle = (Sandbox as Record<string, any>).settleSandboxChatEdit;
        expect(typeof settle).toBe('function');
        // The user typed into styles.css after asking for the App.tsx edit.
        const now = [app, { ...css, content: 'body { color: red; }\n' }];
        const settled = settle(now, app, { ok: true, content: 'export const App = 2;\n', reply: 'Edited App.tsx with gemini-3.8-flash (+1/-1 lines).' });
        expect(settled.reply).toBe('Edited App.tsx with gemini-3.8-flash (+1/-1 lines).');
        expect(settled.files.map((f: CodeFileTab) => [f.id, f.content])).toEqual([['app', 'export const App = 2;\n'], ['css', 'body { color: red; }\n']]);
    });

    it('an edit of a file that changed or went away meanwhile is not applied, and the reply says why', () => {
        const settle = (Sandbox as Record<string, any>).settleSandboxChatEdit;
        const changed = settle([{ ...app, content: 'export const App = 99;\n' }, css], app, { ok: true, content: 'export const App = 2;\n', reply: 'Edited App.tsx.' });
        expect(changed).toEqual({ files: null, reply: 'No change made to App.tsx: App.tsx changed after the edit was asked for, and the edit was made from the earlier text. Ask again to edit the current text.' });
        const gone = settle([css], app, { ok: true, content: 'x', reply: 'Edited App.tsx.' });
        expect(gone).toEqual({ files: null, reply: 'No change made to App.tsx: the file was removed while the edit was running. Ask again to edit the current text.' });
        // A failed call stays a failed call.
        expect(settle([app, css], app, { ok: false, reply: 'No change made to App.tsx: offline' })).toEqual({ files: null, reply: 'No change made to App.tsx: offline' });
    });

    it('accepting a JSDoc proposal for one file never writes it into the tab open now', () => {
        const apply = (Sandbox as Record<string, any>).applyModelFileEdit;
        expect(typeof apply).toBe('function');
        const utils = tab('utils', 'utils.ts', 'export const add = (a: number, b: number) => a + b;\n');
        const commented = '/** Adds two numbers. */\n' + utils.content;
        // Proposed for utils.ts; the user then switched to App.tsx and accepted.
        const accepted = apply([app, utils], 'utils', utils.content, commented);
        expect(accepted.ok).toBe(true);
        expect(accepted.files.find((f: CodeFileTab) => f.id === 'app').content).toBe(app.content);
        expect(accepted.files.find((f: CodeFileTab) => f.id === 'utils').content).toBe(commented);

        // The quick-edit proposal carries its file, and accepting goes through applyModelFileEdit, not the open tab.
        const source = fs.readFileSync(path.resolve(__dirname, '../src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive.tsx'), 'utf-8');
        const accept = source.slice(source.indexOf('const handleAcceptQuickEdit'), source.indexOf('const handleRejectQuickEdit'));
        expect(accept).toContain('applyModelFileEdit(latest.files, quickEditDiff.fileId');
        expect(accept).not.toContain('handleCodeChange(');
    });
});

