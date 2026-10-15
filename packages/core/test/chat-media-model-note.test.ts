/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A chat reply whose tools generated media with a model other than the one asked for records that tool result's
 * note (which model answered, and why the earlier ones were skipped), and the reply's image and video cards show it.
 * The stream is driven through useSendMessage with a stubbed backend; the message is rendered with react-dom/server,
 * and screenshotted with headless Chrome (test-results/screenshots/chat_video_card_model_note.png) when it is installed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useSendMessage, type SendMessageDeps, type UseSendMessageResult } from '../src/browser/generative-canvas/hooks/useSendMessage';
import { buildStoppedReply, recordMediaModelNote } from '../src/browser/generative-canvas/hooks/toolStepState';
import { GeminiClient as BrowserGeminiClient } from '../src/browser/generative-canvas/gemini-client';
import { WorkspaceConfigClient, type FullWorkspaceConfig } from '../src/browser/generative-canvas/workspace-config-client';
import { MessageItem } from '../src/browser/generative-canvas/chat/MessageItem';
import { StudioProvider } from '../src/browser/generative-canvas/state/StudioContext';
import type { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import type { ProjectItem } from '../src/browser/generative-canvas/ProjectsModal';
import type { ChatMessage, ChatSession, McpExecutionState } from '../src/browser/generative-canvas/canvas-types';
import type { GeminiStreamEvent } from '../src/common/gemini-protocol';
import { decodePng } from '../src/node/texture-processing';
import { htmlScreenshotChrome, saveHtmlScreenshot } from './helpers/html-screenshot';
import { withReason } from './helpers/requirements';

afterEach(() => vi.restoreAllMocks());

const SUBSTITUTED = {
    success: true,
    modelUsed: 'veo-3.1-fast-generate-preview',
    requestedModels: ['google/omni-1.1', 'veo-3.1-fast-generate-preview'],
    skippedModels: [{ model: 'google/omni-1.1', code: 'unsupported', reason: 'not served: models/google/omni-1.1 is not found' }],
    modelNote: 'Generated with veo-3.1-fast-generate-preview, not the requested google/omni-1.1: skipped google/omni-1.1 (not served: models/google/omni-1.1 is not found).'
};
const AS_REQUESTED = { success: true, modelUsed: 'gemini-3.1-flash-image', requestedModels: ['gemini-3.1-flash-image'], skippedModels: [] };

function exec(id: string, toolName: string): McpExecutionState {
    return { id, mcpServerId: 'scratchbox', mcpName: 'Scratchbox', toolName, humanTitle: toolName, status: 'completed', timestamp: 'now', steps: [], summaryResult: 'done' };
}

/** Sends one message through useSendMessage with a backend that streams `events`; returns the saved reply. */
async function replyTo(events: GeminiStreamEvent[]): Promise<ChatMessage> {
    vi.spyOn(WorkspaceConfigClient.getInstance(), 'fetchWorkspaceConfig').mockResolvedValue({ workspaceRoot: '/tmp/ws', rules: [], customSkills: [], customMcpServers: [] } as FullWorkspaceConfig);
    vi.spyOn(BrowserGeminiClient.getInstance(), 'streamGenerate').mockImplementation(async (_request, onEvent) => {
        for (const event of events) onEvent(event);
    });
    let sessions: ChatSession[] = [{ id: 'S', title: 'Chat', dateCategory: 'Today', updatedAt: 'now', messages: [], artifactHistory: [], layoutMode: 'chat' } as ChatSession];
    const noop = () => undefined;
    const deps = {
        inputValue: '', isGenerating: false, setInputValue: noop,
        executeDeepWritePipeline: async () => undefined, handleStartAgent: async () => undefined,
        skills: [], selectedSkillIds: [], mcpServers: [], selectedMcpIds: [],
        currentSessionId: 'S', setCurrentSessionId: noop,
        sessions, setSessions: (v: any) => { sessions = typeof v === 'function' ? v(sessions) : v; },
        messages: [], setMessages: noop, setAutocompleteType: noop, setIsGenerating: noop,
        setLiveThinkingText: noop, setLiveThinkingSeconds: noop, setLiveSteps: noop, setLiveStreamedText: noop,
        setActiveStreamingSectionId: noop, liveThinkingText: '', liveThinkingSeconds: 0, liveSteps: [],
        activeSessionRef: { current: 'S' }, googleSearchGrounding: false,
        activeArtifact: undefined, setActiveArtifact: noop,
        artifactHistory: [], setArtifactHistory: noop,
        layoutMode: 'chat', setLayoutMode: noop, setMcpExecutions: noop, setTokenBudget: noop,
        setActiveTerminalError: noop, setShowTerminalErrorToast: noop, recordArtifactVersion: noop,
        attachedDataFile: undefined, setAttachedDataFile: noop, showToast: noop,
        graphControllerRef: { current: { registerArtifact: (a: any) => a } as unknown as ProjectArtifactController },
        setGraphEpoch: noop,
        activeWorkspace: { id: 'ws', name: 'ws', path: '/tmp/ws', lastActive: 'now', tags: [] } as ProjectItem,
        persistSessionsImmediately: noop,
        aiInteractionMode: 'agent'
    } as unknown as SendMessageDeps;
    let hook: UseSendMessageResult | undefined;
    const Harness = () => { hook = useSendMessage(deps); return null; };
    renderToStaticMarkup(React.createElement(Harness));
    await hook!.sendMessage('make a short clip of the harbour');
    return sessions[0].messages.find(m => m.sender === 'assistant')!;
}

function render(message: ChatMessage): string {
    const actions = new Proxy({}, { get: () => () => undefined }) as any;
    return renderToStaticMarkup(React.createElement(StudioProvider, { store: {} as any, actions, state: {} as any },
        React.createElement(MessageItem, { message, activeArtifactId: undefined, activeArtifactVersion: undefined, checkpointFeedbackValue: '' })));
}

describe('chat media cards say which model made the media when it was not the requested one', () => {
    it('records each distinct substitution note a tool result reports, and none when the requested model answered', () => {
        expect(recordMediaModelNote([], SUBSTITUTED)).toEqual([SUBSTITUTED.modelNote]);
        expect(recordMediaModelNote([SUBSTITUTED.modelNote], SUBSTITUTED)).toEqual([SUBSTITUTED.modelNote]);
        expect(recordMediaModelNote([], AS_REQUESTED)).toEqual([]);
        expect(recordMediaModelNote([], { success: false, error: 'quota' })).toEqual([]);
        expect(recordMediaModelNote([], undefined)).toEqual([]);
        // A result with no note of its own still says which model answered instead of which.
        expect(recordMediaModelNote([], { modelUsed: 'b', requestedModels: ['a', 'b'] })).toEqual(['Generated with b, not the requested a.']);
    });

    it('a streamed reply keeps the note from its tool result, and its video and image cards show it', async () => {
        const reply = await replyTo([
            { type: 'tool_result', mcpExecution: exec('e1', 'generate_clip'), toolResult: { id: 'c1', name: 'generate_clip', result: SUBSTITUTED } },
            { type: 'done', text: 'Here is the clip.' }
        ]);
        expect(reply.mediaModelNote).toBe(SUBSTITUTED.modelNote);

        const video = render({ ...reply, videoContent: '/media/clip.mp4' });
        expect(video).toContain('data-testid="sb-media-model-note"');
        expect(video).toContain('not the requested google/omni-1.1');
        const image = render({ ...reply, imageContent: '/media/still.png' });
        expect(image).toContain('data-testid="sb-media-model-note"');
        expect(image).toContain('veo-3.1-fast-generate-preview');
    });

    it('a reply whose media came from the requested model shows no note', async () => {
        const reply = await replyTo([
            { type: 'tool_result', mcpExecution: exec('e2', 'generate_still'), toolResult: { id: 'c2', name: 'generate_still', result: AS_REQUESTED } },
            { type: 'done', text: 'Here is the still.' }
        ]);
        expect(reply.mediaModelNote).toBeUndefined();
        expect(render({ ...reply, imageContent: '/media/still.png' })).not.toContain('sb-media-model-note');
    });

    it.skipIf(!htmlScreenshotChrome.ok)(withReason('screenshots the video card with its note', htmlScreenshotChrome), async () => {
        const reply = await replyTo([
            { type: 'tool_result', mcpExecution: exec('e3', 'generate_clip'), toolResult: { id: 'c3', name: 'generate_clip', result: SUBSTITUTED } },
            { type: 'done', text: 'Here is the clip.' }
        ]);
        const html = render({ ...reply, videoContent: '/media/clip.mp4' });
        const shot = await saveHtmlScreenshot('chat_video_card_model_note', `<div style="width:560px;margin:16px">${html}</div>`, { width: 600, height: 520, background: '#0f0f12' });
        // The note is amber text on a dark brown pill: count its amber pixels.
        const { data } = decodePng(shot.png);
        let amber = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 150 && data[i + 1] > 110 && data[i + 2] < 120 && data[i] > data[i + 2] * 1.6) amber++;
        expect(amber).toBeGreaterThan(150);
    });

    it('a stopped reply keeps the note of the media that was already made', () => {
        const stopped = buildStoppedReply({ text: '', thinkingText: '', thinkingDurationSeconds: 0, steps: [], execs: [], mediaModelNote: SUBSTITUTED.modelNote });
        expect(stopped.mediaModelNote).toBe(SUBSTITUTED.modelNote);
    });
});
