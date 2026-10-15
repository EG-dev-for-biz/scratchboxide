/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The chat model fallback list stays, but is never silent.
 *
 * When the requested (or configured) model is not served, the next model in the list answers, and the reply says
 * so: "Answered by X — Y unavailable: <reason>". A model that answered once is no longer made the default for every
 * later turn behind the user's back. When the Vertex service account is configured but cannot get a token and the
 * Gemini API key answers instead, the reply says which credential answered and why.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GeminiService } from '../src/node/gemini-service';
import { GeminiClient, summarizeModelError } from '../src/node/gemini/gemini-client';
import type { GeminiStreamEvent, ModelAnswerProvenance } from '../src/common/gemini-protocol';
import { MessageNotices, describeModelProvenance } from '../src/browser/generative-canvas/chat/MessageNotices';
import { useSendMessage, type SendMessageDeps, type UseSendMessageResult } from '../src/browser/generative-canvas/hooks/useSendMessage';
import { GeminiClient as BrowserGeminiClient } from '../src/browser/generative-canvas/gemini-client';
import { WorkspaceConfigClient, type FullWorkspaceConfig } from '../src/browser/generative-canvas/workspace-config-client';
import type { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import type { ProjectItem } from '../src/browser/generative-canvas/ProjectsModal';
import type { ChatMessage, ChatSession } from '../src/browser/generative-canvas/canvas-types';
import { decodePng } from '../src/node/texture-processing';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';
import { withReason } from './helpers/requirements';

const NOT_FOUND = JSON.stringify({ error: { code: 404, message: 'Publisher Model `projects/p/locations/global/publishers/google/models/gemini-4-argon` was not found or your project does not have access to it.', status: 'NOT_FOUND' } });
const sse = (text: string) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] })}\ndata: [DONE]`;

const savedFetch = (globalThis as any).fetch;
const savedKey = process.env.GEMINI_API_KEY;
afterEach(() => {
    (globalThis as any).fetch = savedFetch;
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    vi.restoreAllMocks();
});

/** A GeminiService on a mocked Vertex service account; `fetch` answers per model id in the URL. */
function serviceWith(answers: Record<string, () => { ok: boolean; status: number; body: string }>, opts: { tokenFails?: boolean } = {}) {
    const service = new GeminiService();
    (service as any).auth = {
        getClient: async () => ({
            getAccessToken: async () => {
                if (opts.tokenFails) throw new Error('invalid_grant: Invalid JWT Signature.');
                return { token: 'mock-token' };
            }
        })
    };
    (service as any).cachedProjectId = 'mock-project';
    const urls: string[] = [];
    (globalThis as any).fetch = async (url: string) => {
        urls.push(url);
        const model = Object.keys(answers).find(m => url.includes(`/models/${m}:`));
        const a = model ? answers[model]() : { ok: false, status: 500, body: 'unexpected url' };
        return { ok: a.ok, status: a.status, text: async () => a.body, json: async () => JSON.parse(a.body), body: null };
    };
    return { service, urls };
}

describe('server: which model and credential answered', () => {
    it('reports the fallback model, the skipped model and why, on the done event and the response', async () => {
        const { service, urls } = serviceWith({
            'gemini-4-argon': () => ({ ok: false, status: 404, body: NOT_FOUND }),
            'gemini-3.8-flash': () => ({ ok: true, status: 200, body: sse('The arch is 26 m tall.') })
        });
        const events: GeminiStreamEvent[] = [];
        const response = await service.streamGenerate({ prompt: 'How tall is the arch?', model: 'gemini-4-argon', mode: 'ask' } as any, e => events.push(e));

        expect(urls.map(u => /models\/([^:]+):/.exec(u)?.[1])).toEqual(['gemini-4-argon', 'gemini-3.8-flash']);
        expect(response.modelUsed).toBe('gemini-3.8-flash');
        const expected: ModelAnswerProvenance = {
            requestedModel: 'gemini-4-argon',
            modelUsed: 'gemini-3.8-flash',
            fallbackReason: expect.stringMatching(/^gemini-4-argon unavailable: 404: Publisher Model .*was not found/) as unknown as string,
            credential: 'vertex'
        };
        expect(response.modelProvenance).toEqual(expected);
        const done = events.find(e => e.type === 'done');
        expect(done?.modelProvenance).toEqual(expected);
        // While it happens the status line says the next model is being tried, not that it answered.
        const notice = events.find(e => e.type === 'status' && e.text?.includes('trying gemini-3.8-flash'));
        expect(notice?.text).toContain('gemini-4-argon is not available');
        expect(events.some(e => e.type === 'status' && /answering with/.test(e.text || ''))).toBe(false);
    });

    it('when no model in the list is available, the error names every model tried and why', async () => {
        const { service } = serviceWith({});
        // Every model id answers 404.
        (globalThis as any).fetch = async () => ({ ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 404, message: 'model not found' } }), json: async () => ({}), body: null });
        const tried = (service as any).client.getModelCandidates('gemini-x') as string[];
        const err = await service.streamGenerate({ prompt: 'hi', model: 'gemini-x', mode: 'ask' } as any, () => {}).then(() => null, e => e as Error);
        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toContain(`none of the ${tried.length} models tried is available`);
        for (const model of tried) expect(err!.message).toContain(`${model} (404: model not found)`);
    });

    it('starts every turn from the requested model again (no sticky default after a fallback)', async () => {
        const { service, urls } = serviceWith({
            'gemini-4-argon': () => ({ ok: false, status: 404, body: NOT_FOUND }),
            'gemini-3.8-flash': () => ({ ok: true, status: 200, body: sse('ok') })
        });
        await service.streamGenerate({ prompt: 'one', mode: 'ask' } as any, () => {});
        urls.length = 0;
        const second = await service.streamGenerate({ prompt: 'two', mode: 'ask' } as any, () => {});
        expect(urls[0]).toContain('/models/gemini-4-argon:');
        expect(second.modelProvenance?.requestedModel).toBe('gemini-4-argon');
        expect(second.modelProvenance?.modelUsed).toBe('gemini-3.8-flash');
    });

    it('says nothing extra when the requested model answers', async () => {
        const { service } = serviceWith({ 'gemini-3.8-flash': () => ({ ok: true, status: 200, body: sse('ok') }) });
        const response = await service.streamGenerate({ prompt: 'hi', model: 'gemini-3.8-flash', mode: 'ask' } as any, () => {});
        expect(response.modelProvenance).toEqual({ requestedModel: 'gemini-3.8-flash', modelUsed: 'gemini-3.8-flash', credential: 'vertex' });
    });

    it('says which credential answered when the service account cannot get a token and the API key answers', async () => {
        process.env.GEMINI_API_KEY = 'test-key-not-real';
        const { service, urls } = serviceWith({ 'gemini-3.8-flash': () => ({ ok: true, status: 200, body: sse('ok') }) }, { tokenFails: true });
        const response = await service.streamGenerate({ prompt: 'hi', model: 'gemini-3.8-flash', mode: 'ask' } as any, () => {});
        expect(urls[0]).toContain('generativelanguage.googleapis.com');
        expect(response.modelProvenance).toMatchObject({
            credential: 'api-key',
            credentialNote: expect.stringContaining('Vertex AI service account could not get an access token (invalid_grant: Invalid JWT Signature.)')
        });
    });

    it('a subagent that falls back does not become the default subagent model', async () => {
        const { service, urls } = serviceWith({
            'gemini-3.1-flash-lite-preview': () => ({ ok: false, status: 404, body: NOT_FOUND }),
            'gemini-3.1-flash-lite': () => ({ ok: true, status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'plan' }] } }] }) })
        });
        const before = service.preferredSubagentModel;
        const res = await service.executeSubagentTask({ taskType: 'preprocess', prompt: 'p', model: 'gemini-3.1-flash-lite-preview' } as any);
        expect(res.modelUsed).toBe('gemini-3.1-flash-lite');
        expect(urls.map(u => /models\/([^:]+):/.exec(u)?.[1])).toEqual(['gemini-3.1-flash-lite-preview', 'gemini-3.1-flash-lite']);
        expect(service.preferredSubagentModel).toBe(before);
        // And it says so: which model answered, which was skipped and why, on which credential.
        expect(res.modelProvenance).toEqual({
            requestedModel: 'gemini-3.1-flash-lite-preview',
            modelUsed: 'gemini-3.1-flash-lite',
            fallbackReason: expect.stringMatching(/^gemini-3\.1-flash-lite-preview unavailable: 404: /),
            credential: 'vertex'
        });
    });

    it('a subagent answered by the API key after a token failure says so', async () => {
        process.env.GEMINI_API_KEY = 'test-key-not-real';
        const { service, urls } = serviceWith({ 'gemini-3.1-flash-lite': () => ({ ok: true, status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'plan' }] } }] }) }) }, { tokenFails: true });
        const res = await service.executeSubagentTask({ taskType: 'preprocess', prompt: 'p', model: 'gemini-3.1-flash-lite' } as any);
        expect(urls[0]).toContain('generativelanguage.googleapis.com');
        expect(res.modelProvenance).toMatchObject({ credential: 'api-key', credentialNote: expect.stringContaining('could not get an access token (invalid_grant') });
    });

    it('skill preprocessing that fell back is named on the turn\'s reply, not only in a passing status line', async () => {
        const { service } = serviceWith({
            'gemini-3.1-flash-lite-preview': () => ({ ok: false, status: 404, body: NOT_FOUND }),
            'gemini-3.1-flash-lite': () => ({ ok: true, status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'use skill A first' }] } }] }) }),
            'gemini-3.8-flash': () => ({ ok: true, status: 200, body: sse('Done.') })
        });
        (service as any).preferredSubagentModel = 'gemini-3.1-flash-lite-preview';
        const events: GeminiStreamEvent[] = [];
        const response = await service.streamGenerate({
            prompt: 'Plan it', model: 'gemini-3.8-flash', mode: 'ask', enableSubagentPreprocess: true,
            attachedSkills: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
        } as any, e => events.push(e));
        expect(response.modelProvenance?.modelUsed).toBe('gemini-3.8-flash');
        expect(response.modelProvenance?.helperNotes).toEqual([expect.stringMatching(/^Skill preprocessing answered by gemini-3\.1-flash-lite — gemini-3\.1-flash-lite-preview unavailable: 404/)]);
        expect(events.some(e => e.type === 'status' && e.text?.startsWith('Skill preprocessing answered by gemini-3.1-flash-lite'))).toBe(true);
        const notice = describeModelProvenance(response.modelProvenance!).notice;
        expect(notice).toContain('Skill preprocessing answered by gemini-3.1-flash-lite');
    });

    it('non-streaming requests (history summary, quick edit, FIM) say which credential answered', async () => {
        process.env.GEMINI_API_KEY = 'test-key-not-real';
        const ok = () => ({ ok: true, status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'summary' }] } }] }) });
        // Token failure: the API key answers, and the answer says why.
        const { service: noToken, urls: keyUrls } = serviceWith({ 'gemini-3.8-flash': ok }, { tokenFails: true });
        const viaKey = await (noToken as any).client.generateContent({ model: 'gemini-3.8-flash', prompt: 'summarize' });
        expect(keyUrls).toHaveLength(1);
        expect(keyUrls[0]).toContain('generativelanguage.googleapis.com');
        expect(viaKey).toMatchObject({ text: 'summary', credential: 'api-key', credentialNote: expect.stringContaining('could not get an access token (invalid_grant') });
        // Vertex answers with an error: that error is the result; the request is not re-sent with the API key.
        const { service: vertex, urls: vertexUrls } = serviceWith({ 'gemini-3.8-flash': () => ({ ok: false, status: 400, body: 'INVALID_ARGUMENT: bad payload' }) });
        await expect((vertex as any).client.generateContent({ model: 'gemini-3.8-flash', prompt: 'summarize' })).rejects.toThrow('Vertex AI error (400): INVALID_ARGUMENT');
        expect(vertexUrls).toHaveLength(1);
        expect(vertexUrls[0]).not.toContain('generativelanguage.googleapis.com');
        // Vertex answers: it says so.
        const { service: vertexOk } = serviceWith({ 'gemini-3.8-flash': ok });
        expect(await (vertexOk as any).client.generateContent({ model: 'gemini-3.8-flash', prompt: 'summarize' })).toEqual({ text: 'summary', credential: 'vertex' });

        // Quick edit and FIM go through the same request: the API key answer is labelled, a Vertex error is a failure.
        // Quick edit asks the configured chat model, FIM the configured subagent model.
        const defaults = new GeminiService() as any;
        const editModels = [defaults.preferredModel, defaults.preferredSubagentModel];
        const answerAll = Object.fromEntries(editModels.map(m => [m, ok]));
        const { service: keyEdit } = serviceWith(answerAll, { tokenFails: true });
        const edit = await keyEdit.quickEditCode({ originalCode: 'let a = 1;', instruction: 'rename a to b', language: 'typescript', fileName: 'a.ts' });
        expect(edit).toMatchObject({ success: true, proposedCode: 'summary', credential: 'api-key', credentialNote: expect.stringContaining('could not get an access token') });
        const fim = await keyEdit.completeFim({ prefix: 'let a = ', suffix: ';', language: 'typescript', fileName: 'a.ts' });
        expect(fim).toMatchObject({ success: true, credential: 'api-key', credentialNote: expect.stringContaining('could not get an access token') });
        const bad = () => ({ ok: false, status: 400, body: 'INVALID_ARGUMENT: bad payload' });
        const { service: vertexBad } = serviceWith(Object.fromEntries(editModels.map(m => [m, bad])));
        const failedEdit = await vertexBad.quickEditCode({ originalCode: 'let a = 1;', instruction: 'rename a to b', language: 'typescript', fileName: 'a.ts' });
        expect(failedEdit).toMatchObject({ success: false, proposedCode: 'let a = 1;', error: expect.stringContaining('Vertex AI error (400): INVALID_ARGUMENT') });
        expect(failedEdit.proposedCode).not.toContain('Auto-documented');
    });

    it('withModelFallback reports each skipped model; a non-404 error is not a fallback', async () => {
        const client = new GeminiClient({ transientRetries: 0 });
        const skipped: string[] = [];
        const result = await client.withModelFallback(['a', 'b', 'c'], async m => {
            if (m !== 'c') throw new Error(`AI request failed (404): model ${m} not found`);
            return m;
        }, { onFallback: (model, reason, next) => skipped.push(`${model}->${next}: ${reason}`) });
        expect(result).toBe('c');
        expect(skipped).toEqual(['a->b: AI request failed (404): model a not found', 'b->c: AI request failed (404): model b not found']);
        await expect(client.withModelFallback(['a', 'b'], async () => { throw new Error('AI request failed (400): bad request'); }, { onFallback: () => skipped.push('x') })).rejects.toThrow('400');
        expect(skipped).not.toContain('x');
        expect(summarizeModelError(new Error(`AI request failed (404): ${NOT_FOUND}`))).toMatch(/^404: Publisher Model .*was not found/);
    });
});

describe('chat: the reply carries and shows which model answered', () => {
    const provenance: ModelAnswerProvenance = {
        requestedModel: 'gemini-4-argon',
        modelUsed: 'gemini-3.8-flash',
        fallbackReason: 'gemini-4-argon unavailable: 404: Publisher Model was not found',
        credential: 'vertex'
    };

    it('describes the fallback as "Answered by X — Y unavailable: <reason>"', () => {
        expect(describeModelProvenance(provenance)).toEqual({
            label: 'Answered by gemini-3.8-flash · Vertex AI',
            notice: 'Answered by gemini-3.8-flash — gemini-4-argon unavailable: 404: Publisher Model was not found'
        });
        expect(describeModelProvenance({ requestedModel: 'm', modelUsed: 'm', credential: 'api-key' })).toEqual({ label: 'Answered by m · Gemini API key', notice: undefined });
        expect(describeModelProvenance({ requestedModel: 'm', modelUsed: 'm', credential: 'api-key', credentialNote: 'the Vertex AI service account could not get an access token (expired key)' }).notice)
            .toBe('Answered with the Gemini API key — the Vertex AI service account could not get an access token (expired key)');
    });

    it('stores the provenance from the stream on the saved assistant message', async () => {
        vi.spyOn(WorkspaceConfigClient.getInstance(), 'fetchWorkspaceConfig').mockResolvedValue({ workspaceRoot: '/tmp/ws', rules: [], customSkills: [], customMcpServers: [] } as FullWorkspaceConfig);
        vi.spyOn(BrowserGeminiClient.getInstance(), 'streamGenerate').mockImplementation(async (_request, onEvent) => {
            onEvent({ type: 'delta', text: 'The arch is 26 m tall.' });
            onEvent({ type: 'done', text: 'The arch is 26 m tall.', modelUsed: 'gemini-3.8-flash', modelProvenance: provenance });
        });
        const saved = await sendOne('How tall is the arch?');
        expect(saved.text).toBe('The arch is 26 m tall.');
        expect(saved.modelProvenance).toEqual(provenance);
    });

    it.skipIf(!htmlScreenshotChrome.ok)(withReason('shows the fallback notice on the message (screenshot)', htmlScreenshotChrome), async () => {
        const message: ChatMessage = { id: 'm', sender: 'assistant', text: 'The arch is 26 m tall.', timestamp: '10:00', modelProvenance: provenance };
        const html = renderToStaticMarkup(React.createElement(MessageNotices, { message }));
        expect(html).toContain('data-testid="sb-model-fallback-notice"');
        expect(html).toContain('Answered by gemini-3.8-flash — gemini-4-argon unavailable: 404');
        // The Vertex -> API key switch on another message: the notice names the credential that answered and why.
        const keyMessage: ChatMessage = {
            ...message, id: 'm2',
            modelProvenance: { requestedModel: 'gemini-3.8-flash', modelUsed: 'gemini-3.8-flash', credential: 'api-key', credentialNote: 'the Vertex AI service account could not get an access token (invalid_grant: Invalid JWT Signature.)' }
        };
        const keyHtml = renderToStaticMarkup(React.createElement(MessageNotices, { message: keyMessage }));
        expect(keyHtml).toContain('Answered with the Gemini API key — the Vertex AI service account could not get an access token');
        expect(keyHtml).toContain('Answered by gemini-3.8-flash · Gemini API key');
        const shot = await saveHtmlScreenshot('chat_model_fallback_notice',
            `<div style="padding:16px;max-width:560px;display:flex;flex-direction:column;gap:14px">${html}${keyHtml}</div>`,
            { width: 600, height: 230, background: '#18181b' });
        const { data } = decodePng(shot.png);
        let amber = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 200 && data[i + 1] > 160 && data[i + 2] < 120) amber++;
        expect(amber).toBeGreaterThan(200);
    });
});

/** Sends one chat message through useSendMessage (server-rendered harness) and returns the saved assistant reply. */
async function sendOne(text: string): Promise<ChatMessage> {
    let sessions: ChatSession[] = [{ id: 'S', title: 'Chat', dateCategory: 'Today', updatedAt: 'now', messages: [], artifactHistory: [], layoutMode: 'chat' }];
    const noop = () => undefined;
    const set = (apply: (v: any) => void) => (value: any) => apply(value);
    const deps: SendMessageDeps = {
        inputValue: '', isGenerating: false, setInputValue: noop,
        executeDeepWritePipeline: async () => undefined, handleStartAgent: async () => undefined,
        skills: [], selectedSkillIds: [], mcpServers: [], selectedMcpIds: [],
        currentSessionId: 'S', setCurrentSessionId: noop,
        sessions, setSessions: set(v => { sessions = typeof v === 'function' ? v(sessions) : v; }),
        messages: [], setMessages: noop, setAutocompleteType: noop, setIsGenerating: noop,
        setLiveThinkingText: noop, setLiveThinkingSeconds: noop, setLiveSteps: noop, setLiveStreamedText: noop,
        setActiveStreamingSectionId: noop, liveThinkingText: '', liveThinkingSeconds: 0, liveSteps: [],
        activeSessionRef: { current: 'S' }, googleSearchGrounding: false,
        activeArtifact: undefined, setActiveArtifact: noop, artifactHistory: [], setArtifactHistory: noop,
        layoutMode: 'chat', setLayoutMode: noop, setMcpExecutions: noop, setTokenBudget: noop,
        setActiveTerminalError: noop, setShowTerminalErrorToast: noop, recordArtifactVersion: noop,
        attachedDataFile: undefined, setAttachedDataFile: noop, showToast: noop,
        graphControllerRef: { current: { registerArtifact: (a: any) => a } as unknown as ProjectArtifactController },
        setGraphEpoch: noop,
        activeWorkspace: { id: 'ws', name: 'ws', path: '/tmp/ws', lastActive: 'now', tags: [] } as ProjectItem,
        persistSessionsImmediately: noop,
        aiInteractionMode: 'ask'
    };
    let hook: UseSendMessageResult | undefined;
    const Harness = () => { hook = useSendMessage(deps); return null; };
    renderToStaticMarkup(React.createElement(Harness));
    await hook!.sendMessage(text);
    const reply = sessions.find(s => s.id === 'S')!.messages.find(m => m.sender === 'assistant');
    if (!reply) throw new Error('no assistant reply was saved');
    return reply;
}
