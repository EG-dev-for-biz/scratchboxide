/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The chat's Stop control and its tool-step cards: a running tool's card shows its live progress and
 * is replaced in place by the finished result (a late progress report never undoes it); Stop and a
 * failed stream keep what already streamed and leave no step or tool card "running" in the saved
 * message; a reply that finishes while the user views another session is saved whole, without taking
 * that other session's canvas; the composer offers Stop only for a chat reply it can stop.
 */

import { afterEach, test, vi } from 'vitest';
import * as assert from 'assert';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
    AgentExecutionStep,
    CanvasArtifact,
    ChatMessage,
    ChatSession,
    McpExecutionState,
    StudioLayoutMode
} from '../src/browser/generative-canvas/canvas-types';
import {
    buildFailedReply,
    buildStoppedReply,
    committedSessionCanvas,
    isLateProgressReport,
    mcpExecutionToStep,
    recordExecution,
    settleRunningExecution,
    settleRunningSteps,
    STOPPED_NOTE,
    STREAM_ENDED,
    STREAM_FAILED,
    upsertExecution,
    upsertStep,
    USER_STOP
} from '../src/browser/generative-canvas/hooks/toolStepState';
import { Composer, type ComposerProps } from '../src/browser/generative-canvas/chat/Composer';
import { useSendMessage, type SendMessageDeps, type UseSendMessageResult } from '../src/browser/generative-canvas/hooks/useSendMessage';
import { ChatRequestError, GeminiClient } from '../src/browser/generative-canvas/gemini-client';
import { WorkspaceConfigClient, type FullWorkspaceConfig } from '../src/browser/generative-canvas/workspace-config-client';
import type { ProjectArtifactController } from '../src/browser/generative-canvas/project-artifact-controller';
import type { ProjectItem } from '../src/browser/generative-canvas/ProjectsModal';
import type { GeminiGenerateRequest, GeminiStreamEvent } from '../src/common/gemini-protocol';

function exec(overrides: Partial<McpExecutionState>): McpExecutionState {
    return {
        id: 'call-1',
        mcpServerId: 'scratchbox-tool-progress',
        mcpName: 'Scratchbox',
        toolName: 'render_scene',
        humanTitle: 'render_scene',
        status: 'running',
        timestamp: '10:00:00',
        steps: [{ id: 's1', title: 'Run render_scene', status: 'running' }],
        ...overrides
    };
}

test('a running tool step shows the tool name, its progress and elapsed seconds', () => {
    const step = mcpExecutionToStep(exec({ summaryResult: 'compiling shaders (45s)', args: { quality: 'high' } }));
    assert.strictEqual(step.title, 'Running render_scene: compiling shaders (45s)');
    assert.strictEqual(step.status, 'running');
    assert.strictEqual(step.kind, 'tool');
    assert.strictEqual(step.id, 'call-1');
    assert.deepStrictEqual(JSON.parse(step.details!), { quality: 'high' });

    const noProgress = mcpExecutionToStep(exec({ summaryResult: undefined }));
    assert.strictEqual(noProgress.title, 'Running render_scene');
});

test('a finished tool step keeps the "Executed tool" title and its duration', () => {
    const done = mcpExecutionToStep(exec({ status: 'completed', summaryResult: 'wrote scene.glb', durationMs: 61234 }));
    assert.strictEqual(done.title, 'Executed tool: render_scene');
    assert.strictEqual(done.status, 'completed');
    assert.strictEqual(done.durationFormatted, '61234ms');

    const failed = mcpExecutionToStep(exec({ status: 'failed', summaryResult: 'timed out' }));
    assert.strictEqual(failed.title, 'Executed tool: render_scene');
    assert.strictEqual(failed.status, 'failed');
});

test('progress reports and the final result replace the same card in place', () => {
    const before: AgentExecutionStep = { id: 'task-0', title: 'Plan the scene', status: 'completed', kind: 'task' };
    const after: AgentExecutionStep = { id: 'verify-1', title: 'Verify', status: 'completed', kind: 'verify' };

    let steps = upsertStep([before], mcpExecutionToStep(exec({ summaryResult: 'starting (0s)' })));
    steps = upsertStep(steps, after);
    steps = upsertStep(steps, mcpExecutionToStep(exec({ summaryResult: 'meshing (15s)' })));
    assert.strictEqual(steps.length, 3);
    assert.strictEqual(steps[1].title, 'Running render_scene: meshing (15s)');

    steps = upsertStep(steps, mcpExecutionToStep(exec({ status: 'completed', durationMs: 31000 })));
    assert.deepStrictEqual(steps.map(s => s.id), ['task-0', 'call-1', 'verify-1']);
    assert.strictEqual(steps[1].title, 'Executed tool: render_scene');
    assert.strictEqual(steps[1].status, 'completed');
});

test('Stop marks the running tool step as stopped and leaves finished steps alone', () => {
    const execs = [
        exec({ id: 'call-1', toolName: 'render_scene', summaryResult: 'meshing (15s)' }),
        exec({ id: 'call-0', toolName: 'read_file', status: 'completed' })
    ];
    const steps: AgentExecutionStep[] = [
        { id: 'task-0', title: 'Build the mesh', status: 'running', kind: 'task' },
        mcpExecutionToStep(execs[1]),
        mcpExecutionToStep(execs[0]),
        { id: 'verify-1', title: 'Automated verification', status: 'running', kind: 'verify' }
    ];
    const settled = settleRunningSteps(steps, execs, USER_STOP);

    assert.strictEqual(settled[0].status, 'pending', 'an unfinished checklist item goes back to pending');
    assert.strictEqual(settled[0].title, 'Build the mesh');
    assert.deepStrictEqual(settled[1], steps[1], 'a finished tool step is unchanged');
    assert.strictEqual(settled[2].status, 'failed');
    assert.strictEqual(settled[2].title, 'Stopped: render_scene');
    assert.strictEqual(settled[3].status, 'failed');
    assert.strictEqual(settled[3].title, 'Stopped: Automated verification');
    assert.ok(settled.every(s => s.status !== 'running'));
});

test('a running tool step is named from its title when its call record is missing', () => {
    const step = mcpExecutionToStep(exec({ id: 'orphan', toolName: 'bake_lightmaps', summaryResult: 'texel 4/9 (30s)' }));
    const [settled] = settleRunningSteps([step], [], STREAM_ENDED);
    assert.strictEqual(settled.title, 'Interrupted: bake_lightmaps');
    assert.strictEqual(settled.status, 'failed');
});

test('a running tool card is marked failed with the reason and its last progress', () => {
    const settled = settleRunningExecution(exec({ summaryResult: 'meshing (15s)' }), USER_STOP);
    assert.strictEqual(settled.status, 'failed');
    assert.strictEqual(settled.summaryResult, `${USER_STOP.reason} (last progress: meshing (15s))`);
    assert.deepStrictEqual(settled.steps.map(s => s.status), ['failed']);

    const done = exec({ status: 'completed', summaryResult: 'ok', steps: [{ id: 's1', title: 'Run', status: 'done' }] });
    assert.strictEqual(settleRunningExecution(done, USER_STOP), done);
});

test('the stopped reply keeps the streamed text and steps and adds no note', () => {
    const running = exec({ summaryResult: 'meshing (15s)' });
    const reply = buildStoppedReply({
        text: 'Building the hull first.',
        thinkingText: 'Plan: hull, then wings.',
        thinkingDurationSeconds: 17.2,
        steps: [mcpExecutionToStep(running)],
        execs: [running]
    }, new Date(1_700_000_000_000));

    assert.strictEqual(reply.sender, 'assistant');
    assert.strictEqual(reply.id, 'msg-assistant-1700000000000');
    assert.strictEqual(reply.text, 'Building the hull first.');
    assert.strictEqual(reply.thinkingText, 'Plan: hull, then wings.');
    assert.strictEqual(reply.thinkingDurationSeconds, 17.2);
    assert.strictEqual(reply.steps![0].title, 'Stopped: render_scene');
    assert.strictEqual(reply.steps![0].status, 'failed');
    assert.strictEqual(reply.mcpExecutions![0].status, 'failed');
    assert.strictEqual(running.status, 'running', 'the streamed record itself is not mutated');
});

test('the stopped reply reads "Stopped." when nothing had streamed', () => {
    const reply = buildStoppedReply({ text: '  ', thinkingText: '', thinkingDurationSeconds: 0.4, steps: [], execs: [] });
    assert.strictEqual(reply.text, STOPPED_NOTE);
    assert.strictEqual(reply.steps, undefined);
    assert.strictEqual(reply.mcpExecutions, undefined);
    assert.strictEqual(reply.thinkingText, undefined);
    assert.strictEqual(reply.thinkingDurationSeconds, undefined);
});

function composerProps(overrides: Partial<ComposerProps>): ComposerProps {
    const noop = () => undefined;
    return {
        inputValue: '',
        isGenerating: false,
        isVoiceActive: false,
        isDraggingDataFile: false,
        setIsDraggingDataFile: noop,
        aiInteractionMode: 'agent',
        setAiInteractionMode: noop,
        attachedDataFile: undefined,
        setAttachedDataFile: noop,
        attachedContextMentions: [],
        setAttachedContextMentions: noop,
        skills: [],
        mcpServers: [],
        selectedSkillIds: [],
        selectedMcpIds: [],
        autocompleteType: undefined,
        setAutocompleteType: noop,
        autocompleteQuery: undefined,
        selectedAutocompleteIndex: 0,
        activeContextCategory: 'files' as ComposerProps['activeContextCategory'],
        setActiveContextCategory: noop,
        filteredAutocompleteSkills: [],
        workspaceFilesList: [],
        workspaceGitStatus: {} as ComposerProps['workspaceGitStatus'],
        activeArtifactTitle: undefined,
        layoutMode: 'chat',
        inputRef: React.createRef<HTMLTextAreaElement>(),
        fileInputRef: React.createRef<HTMLInputElement>(),
        handleFileDrop: noop,
        handleFileInputChange: noop,
        handleInputChange: noop,
        handleKeyDown: noop,
        handleVoiceToggle: noop,
        handleToggleComposerSkill: noop,
        handleToggleComposerMcp: noop,
        handleSelectAutocompleteSkill: noop,
        handleSelectAutocompleteContext: noop,
        sendMessage: noop,
        stopGenerating: noop,
        canStop: false,
        ...overrides
    };
}

/** Every <button> element in the composer's rendered element tree. */
function findButtons(node: React.ReactNode): React.ReactElement<any>[] {
    const found: React.ReactElement<any>[] = [];
    const visit = (n: React.ReactNode) => {
        if (Array.isArray(n)) {
            n.forEach(visit);
            return;
        }
        if (!React.isValidElement(n)) {
            return;
        }
        const el = n as React.ReactElement<any>;
        if (el.type === 'button') {
            found.push(el);
        }
        visit(el.props?.children);
    };
    visit(node);
    return found;
}

test('while a reply generates, the composer shows a Stop button that calls stopGenerating', () => {
    let stops = 0;
    let sends = 0;
    const props = composerProps({ isGenerating: true, canStop: true, inputValue: 'draft', stopGenerating: () => { stops++; }, sendMessage: () => { sends++; } });
    const buttons = findButtons(Composer(props));
    const stop = buttons.find(b => b.props['aria-label'] === 'Stop generating');
    assert.ok(stop, 'a Stop button is rendered');
    assert.strictEqual(stop.props.title, 'Stop');
    assert.ok(!stop.props.disabled, 'the Stop button is enabled');
    assert.ok(!buttons.some(b => b.props['aria-label'] === 'Send message'), 'the send button is replaced');
    stop.props.onClick();
    assert.strictEqual(stops, 1);
    assert.strictEqual(sends, 0);

    const html = renderToStaticMarkup(React.createElement(Composer, props));
    assert.ok(html.includes('aria-label="Stop generating"'));
    assert.ok(!html.includes('sb-send-loading-dot'), 'the loading dot is gone');
});

test('when idle, the composer shows the send button and no Stop button', () => {
    let sends = 0;
    const props = composerProps({ inputValue: 'build a hull', sendMessage: () => { sends++; } });
    const buttons = findButtons(Composer(props));
    assert.ok(!buttons.some(b => b.props['aria-label'] === 'Stop generating'));
    const send = buttons.find(b => b.props['aria-label'] === 'Send message');
    assert.ok(send, 'a send button is rendered');
    assert.ok(!send.props.disabled);
    send.props.onClick();
    assert.strictEqual(sends, 1);

    const empty = findButtons(Composer(composerProps({ inputValue: '' }))).find(b => b.props['aria-label'] === 'Send message');
    assert.strictEqual(empty?.props.disabled, true, 'send stays disabled with nothing to send');
});

test('while work that cannot be stopped runs (deep write), the composer keeps the busy send button', () => {
    let stops = 0;
    const props = composerProps({ isGenerating: true, canStop: false, inputValue: 'draft', stopGenerating: () => { stops++; } });
    const buttons = findButtons(Composer(props));
    assert.ok(!buttons.some(b => b.props['aria-label'] === 'Stop generating'), 'no Stop button that would do nothing');
    const send = buttons.find(b => b.props['aria-label'] === 'Send message');
    assert.ok(send, 'the send button is rendered');
    assert.strictEqual(send.props.disabled, true, 'send is disabled while generating');
    assert.strictEqual(stops, 0);

    const html = renderToStaticMarkup(React.createElement(Composer, props));
    assert.ok(html.includes('sb-send-loading-dot'), 'the loading dot shows the work is running');
    assert.ok(!html.includes('aria-label="Stop generating"'));
});

// --- Late progress reports (a "running" report after the result) ---------------------------------

test('a late "running" report never turns a finished tool card back into a spinner', () => {
    const done = exec({ status: 'completed', summaryResult: 'wrote scene.glb', durationMs: 540000 });
    const late = exec({ summaryResult: 'meshing (539s)' });
    assert.strictEqual(isLateProgressReport([done], late), true);
    assert.strictEqual(isLateProgressReport([exec({ status: 'failed' })], late), true);
    assert.strictEqual(isLateProgressReport([exec({})], late), false, 'a running card takes newer progress');
    assert.strictEqual(isLateProgressReport([done], exec({ status: 'completed' })), false, 'a final report always lands');

    const execs = upsertExecution([done], late);
    assert.strictEqual(execs[0], done);
    const global = [exec({ id: 'other', toolName: 'read_file', status: 'completed' }), done];
    assert.strictEqual(recordExecution(global, late), global, 'the Studio-wide list is unchanged');

    const steps = upsertStep([mcpExecutionToStep(done)], mcpExecutionToStep(late));
    assert.strictEqual(steps[0].status, 'completed');
    assert.strictEqual(steps[0].title, 'Executed tool: render_scene');
});

test('tool reports still replace their card in place, and the Studio-wide list shows the newest first', () => {
    const first = exec({ id: 'call-1', summaryResult: 'starting (0s)' });
    const other = exec({ id: 'call-2', toolName: 'read_file', status: 'completed' });
    let execs = upsertExecution(upsertExecution([], first), other);
    execs = upsertExecution(execs, exec({ id: 'call-1', status: 'completed', summaryResult: 'ok' }));
    assert.deepStrictEqual(execs.map(e => `${e.id}:${e.status}`), ['call-1:completed', 'call-2:completed']);

    const global = recordExecution([other, first], exec({ id: 'call-1', summaryResult: 'meshing (15s)' }));
    assert.deepStrictEqual(global.map(e => `${e.id}:${e.summaryResult}`), ['call-1:meshing (15s)', `call-2:${other.summaryResult}`]);
});

// --- A failed stream keeps what already ran ------------------------------------------------------

test('a failed reply keeps the streamed text, the finished tools and settles the running ones', () => {
    const done = exec({ id: 'call-1', status: 'completed', summaryResult: 'wrote scene.glb', durationMs: 540000 });
    const running = exec({ id: 'call-2', toolName: 'bake_lightmaps', summaryResult: 'texel 4/9 (30s)' });
    const notice = '⚠️ **The AI request failed**\n\nboom';
    const reply = buildFailedReply({
        text: 'The scene is rendered; baking the lightmaps next.',
        thinkingText: 'Render, then bake.',
        thinkingDurationSeconds: 571.3,
        steps: [mcpExecutionToStep(done), mcpExecutionToStep(running)],
        execs: [done, running]
    }, notice, STREAM_FAILED, new Date(1_700_000_000_000));

    assert.strictEqual(reply.text, `The scene is rendered; baking the lightmaps next.\n\n${notice}`, 'the notice sits below the partial text');
    assert.strictEqual(reply.id, 'msg-assistant-1700000000000');
    assert.strictEqual(reply.mcpExecutions![0], done, 'the finished tool keeps its result');
    assert.strictEqual(reply.mcpExecutions![1].status, 'failed');
    assert.strictEqual(reply.mcpExecutions![1].summaryResult, `${STREAM_FAILED.reason} (last progress: texel 4/9 (30s))`);
    assert.deepStrictEqual(reply.steps!.map(s => `${s.status}:${s.title}`), ['completed:Executed tool: render_scene', 'failed:Failed: bake_lightmaps']);
    assert.strictEqual(reply.thinkingText, 'Render, then bake.');

    const bare = buildFailedReply({ text: ' ', thinkingText: '', thinkingDurationSeconds: 1, steps: [], execs: [] }, notice);
    assert.strictEqual(bare.text, notice, 'with nothing streamed the reply is the notice alone');
    assert.strictEqual(bare.steps, undefined);
    assert.strictEqual(bare.mcpExecutions, undefined);

    const ended = buildFailedReply({ text: '', thinkingText: '', thinkingDurationSeconds: 1, steps: [mcpExecutionToStep(running)], execs: [running] }, notice, STREAM_ENDED);
    assert.strictEqual(ended.steps![0].title, 'Interrupted: bake_lightmaps');
});

// --- The canvas saved with a reply whose session is not on screen --------------------------------

function artifact(id: string, type: CanvasArtifact['type'] = '3d-scene'): CanvasArtifact {
    return { id, type, title: id, summary: '', data: {} as CanvasArtifact['data'], createdAt: '2026-10-14T10:00:00Z', version: 1 };
}

test('a reply saved to the visible session uses the Studio canvas; one saved in the background keeps its own', () => {
    const storedA = { artifactHistory: [artifact('a-0')], layoutMode: '3d' as StudioLayoutMode, activeArtifact: artifact('a-0') };
    const visibleB = { artifactHistory: [artifact('b-0', 'markdown-document')], layoutMode: 'document' as StudioLayoutMode };

    const background = committedSessionCanvas({ targetVisible: false, visible: visibleB, stored: storedA });
    assert.deepStrictEqual(background.artifactHistory.map(a => a.id), ['a-0']);
    assert.strictEqual(background.layoutMode, '3d');
    assert.strictEqual(background.activeArtifact?.id, 'a-0');

    const withArtifact = committedSessionCanvas({ targetVisible: false, visible: visibleB, stored: storedA, finalArtifact: artifact('a-1'), finalArtifactMode: '3d' });
    assert.deepStrictEqual(withArtifact.artifactHistory.map(a => a.id), ['a-1', 'a-0']);
    assert.strictEqual(withArtifact.activeArtifact?.id, 'a-1');

    const fresh = committedSessionCanvas({ targetVisible: false, visible: visibleB, stored: undefined });
    assert.deepStrictEqual(fresh.artifactHistory, []);
    assert.strictEqual(fresh.layoutMode, 'chat', "the other session's layout is not borrowed");

    const onScreen = committedSessionCanvas({ targetVisible: true, visible: { artifactHistory: [artifact('a-live')], layoutMode: 'code' }, stored: { artifactHistory: [], layoutMode: undefined } });
    assert.deepStrictEqual(onScreen.artifactHistory.map(a => a.id), ['a-live']);
    assert.strictEqual(onScreen.layoutMode, 'code');
});

// --- The send pipeline, driven end to end with a scripted stream ---------------------------------

type StudioState = {
    sessions: ChatSession[];
    messages: ChatMessage[];
    isGenerating: boolean;
    liveSteps: AgentExecutionStep[];
    liveStreamedText: string;
    liveThinkingText: string;
    mcpExecutions: McpExecutionState[];
    artifactHistory: CanvasArtifact[];
    activeArtifact: CanvasArtifact | undefined;
    layoutMode: StudioLayoutMode;
};

const LIVE_KEYS: ReadonlyArray<keyof StudioState> = ['liveSteps', 'liveStreamedText', 'liveThinkingText', 'artifactHistory', 'activeArtifact', 'layoutMode'];

function session(id: string, overrides: Partial<ChatSession> = {}): ChatSession {
    return { id, title: `Chat ${id}`, dateCategory: 'Today', updatedAt: 'Just now', messages: [], artifactHistory: [], layoutMode: 'chat', ...overrides };
}

/** A minimal Studio around `useSendMessage`: plain state, a session switcher, and a log of live-UI writes. */
function createStudio(sessions: ChatSession[], current: string) {
    const first = sessions.find(s => s.id === current)!;
    const state: StudioState = {
        sessions,
        messages: first.messages,
        isGenerating: false,
        liveSteps: [],
        liveStreamedText: '',
        liveThinkingText: '',
        mcpExecutions: [],
        artifactHistory: first.artifactHistory,
        activeArtifact: first.activeArtifact,
        layoutMode: first.layoutMode || 'chat'
    };
    const activeSessionRef = { current: current as string | undefined };
    const toasts: string[] = [];
    /** Live-UI writes that put content on screen, with the session that was visible at the time. */
    const liveWrites: Array<{ key: keyof StudioState; visible: string | undefined }> = [];
    const set = <K extends keyof StudioState>(key: K) => (value: StudioState[K] | ((prev: StudioState[K]) => StudioState[K])) => {
        const next = typeof value === 'function' ? (value as (prev: StudioState[K]) => StudioState[K])(state[key]) : value;
        const empty = next === undefined || next === '' || (Array.isArray(next) && next.length === 0);
        if (LIVE_KEYS.includes(key) && !empty) {
            liveWrites.push({ key, visible: activeSessionRef.current });
        }
        state[key] = next;
    };
    const noop = () => undefined;
    const deps: SendMessageDeps = {
        inputValue: '',
        isGenerating: false,
        setInputValue: noop,
        executeDeepWritePipeline: async () => undefined,
        handleStartAgent: async () => undefined,
        skills: [],
        selectedSkillIds: [],
        mcpServers: [],
        selectedMcpIds: [],
        currentSessionId: current,
        setCurrentSessionId: noop,
        sessions,
        setSessions: set('sessions'),
        messages: first.messages,
        setMessages: set('messages'),
        setAutocompleteType: noop,
        setIsGenerating: set('isGenerating'),
        setLiveThinkingText: set('liveThinkingText'),
        setLiveThinkingSeconds: noop,
        setLiveSteps: set('liveSteps'),
        setLiveStreamedText: set('liveStreamedText'),
        setActiveStreamingSectionId: noop,
        liveThinkingText: '',
        liveThinkingSeconds: 0,
        liveSteps: [],
        activeSessionRef,
        googleSearchGrounding: false,
        activeArtifact: first.activeArtifact,
        setActiveArtifact: set('activeArtifact'),
        artifactHistory: first.artifactHistory,
        setArtifactHistory: set('artifactHistory'),
        layoutMode: first.layoutMode || 'chat',
        setLayoutMode: set('layoutMode'),
        setMcpExecutions: set('mcpExecutions'),
        setTokenBudget: noop,
        setActiveTerminalError: noop,
        setShowTerminalErrorToast: noop,
        recordArtifactVersion: noop,
        attachedDataFile: undefined,
        setAttachedDataFile: noop,
        showToast: text => { toasts.push(text); },
        graphControllerRef: { current: { registerArtifact: (a: CanvasArtifact) => a } as unknown as ProjectArtifactController },
        setGraphEpoch: noop,
        activeWorkspace: { id: 'ws', name: 'ws', path: '/tmp/ws', lastActive: 'now', tags: [] } as ProjectItem,
        persistSessionsImmediately: noop,
        aiInteractionMode: 'agent'
    };
    // useState setters are no-ops once a server render has returned, and effects never run, so the
    // hook is driven entirely through `deps`, which it keeps by reference.
    let hook: UseSendMessageResult | undefined;
    const Harness = () => {
        hook = useSendMessage(deps);
        return null;
    };
    renderToStaticMarkup(React.createElement(Harness));

    /** Opens another session the way the sidebar does: the Studio's canvas and messages become its. */
    const view = (id: string) => {
        const s = state.sessions.find(x => x.id === id)!;
        activeSessionRef.current = id;
        Object.assign(deps, { currentSessionId: id, sessions: state.sessions, messages: s.messages, artifactHistory: s.artifactHistory, layoutMode: s.layoutMode || 'chat', activeArtifact: s.activeArtifact });
        Object.assign(state, { messages: s.messages, artifactHistory: s.artifactHistory, layoutMode: s.layoutMode || 'chat', activeArtifact: s.activeArtifact });
    };
    const stored = (id: string) => state.sessions.find(s => s.id === id)!;
    return { state, deps, hook: hook!, toasts, liveWrites, view, stored };
}

type Script = (emit: (event: GeminiStreamEvent) => void, signal: AbortSignal | undefined) => Promise<void>;

/** Each `streamGenerate` call plays the next script; returns the requests the hook sent. */
function scriptStreams(...scripts: Script[]): GeminiGenerateRequest[] {
    const requests: GeminiGenerateRequest[] = [];
    vi.spyOn(WorkspaceConfigClient.getInstance(), 'fetchWorkspaceConfig').mockResolvedValue({ workspaceRoot: '/tmp/ws', rules: [], customSkills: [], customMcpServers: [] } as FullWorkspaceConfig);
    vi.spyOn(GeminiClient.getInstance(), 'streamGenerate').mockImplementation(async (request, onEvent, signal) => {
        requests.push(request);
        const script = scripts.shift();
        assert.ok(script, 'no scripted stream left');
        await script(onEvent, signal);
    });
    return requests;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
}

/** Like the real client, a stream that is aborted returns quietly. */
const untilAborted = (signal: AbortSignal | undefined) => new Promise<void>(r => signal?.addEventListener('abort', () => r(), { once: true }));

const status = (overrides: Partial<McpExecutionState>): GeminiStreamEvent => ({ type: 'status', mcpExecution: exec(overrides) });
const RENDER_DONE: Partial<McpExecutionState> = { status: 'completed', summaryResult: 'wrote scene.glb', durationMs: 540000 };

afterEach(() => {
    vi.restoreAllMocks();
});

test('a reply that finishes while the user views another session is saved whole, and the next turn knows the tool ran', async () => {
    const studio = createStudio([session('A'), session('B')], 'A');
    const atTool = deferred();
    const toolDone = deferred();
    const requests = scriptStreams(async emit => {
        emit({ type: 'thought', thought: 'Render first.' });
        emit(status({ summaryResult: 'meshing (15s)' }));
        atTool.resolve();
        await toolDone.promise;
        emit(status(RENDER_DONE));
        emit({ type: 'thought', thought: 'Now describe it.' });
        emit({ type: 'delta', text: 'The hull is ' });
        emit({ type: 'delta', text: 'rendered.' });
    }, async () => undefined);

    const sending = studio.hook.sendMessage('render the hull');
    await atTool.promise;
    studio.view('B');
    toolDone.resolve();
    await sending;

    const reply = studio.stored('A').messages[1];
    assert.strictEqual(reply.sender, 'assistant');
    assert.strictEqual(reply.text, 'The hull is rendered.');
    assert.strictEqual(reply.thinkingText, 'Render first.\nNow describe it.');
    assert.strictEqual(reply.mcpExecutions![0].status, 'completed');
    assert.strictEqual(reply.mcpExecutions![0].summaryResult, 'wrote scene.glb');
    assert.deepStrictEqual(reply.steps!.map(s => `${s.status}:${s.title}`), ['completed:Executed tool: render_scene']);
    assert.strictEqual(studio.state.mcpExecutions[0].status, 'completed', 'the Studio-wide tool list has the result');
    assert.deepStrictEqual(studio.liveWrites.filter(w => w.visible === 'B'), [], "nothing from A's stream was drawn over session B");
    assert.strictEqual(studio.stored('B').messages.length, 0);
    assert.strictEqual(studio.state.isGenerating, false);
    assert.deepStrictEqual(studio.toasts, []);

    // Back in A, the next turn tells the model the tool completed rather than failed.
    studio.view('A');
    await studio.hook.sendMessage('now bake the lightmaps');
    const lastTurn = requests[1].chatHistory!.at(-1)!;
    assert.strictEqual(lastTurn.role, 'model');
    assert.ok(lastTurn.text.includes('[Tools run: render_scene (completed): wrote scene.glb]'), lastTurn.text);
});

test('Stop pressed from another session keeps the tool that finished there, with no error toast', async () => {
    const studio = createStudio([session('A'), session('B')], 'A');
    const atTool = deferred();
    const toolDone = deferred();
    const afterResult = deferred();
    scriptStreams(async (emit, signal) => {
        emit(status({ summaryResult: 'meshing (15s)' }));
        atTool.resolve();
        await toolDone.promise;
        emit(status(RENDER_DONE));
        afterResult.resolve();
        await untilAborted(signal);
    });

    const sending = studio.hook.sendMessage('render the hull');
    await atTool.promise;
    studio.view('B');
    toolDone.resolve();
    await afterResult.promise;
    studio.hook.cancelInFlight();
    await sending;

    const reply = studio.stored('A').messages[1];
    assert.strictEqual(reply.text, STOPPED_NOTE);
    assert.strictEqual(reply.mcpExecutions![0].status, 'completed', 'not "Stopped by the user"');
    assert.strictEqual(reply.mcpExecutions![0].summaryResult, 'wrote scene.glb');
    assert.strictEqual(reply.steps![0].status, 'completed');
    assert.strictEqual(studio.state.isGenerating, false);
    assert.deepStrictEqual(studio.toasts, []);
});

test('Stop on screen keeps the partial reply and marks the running tool stopped', async () => {
    const studio = createStudio([session('A')], 'A');
    const streamed = deferred();
    scriptStreams(async (emit, signal) => {
        emit({ type: 'delta', text: 'Meshing the hull first.' });
        emit(status({ summaryResult: 'meshing (15s)' }));
        streamed.resolve();
        await untilAborted(signal);
    });

    const sending = studio.hook.sendMessage('render the hull');
    await streamed.promise;
    assert.strictEqual(studio.state.liveStreamedText, 'Meshing the hull first.');
    studio.hook.cancelInFlight();
    await sending;

    const reply = studio.stored('A').messages[1];
    assert.strictEqual(reply.text, 'Meshing the hull first.');
    assert.strictEqual(reply.steps![0].title, 'Stopped: render_scene');
    assert.strictEqual(studio.state.mcpExecutions[0].status, 'failed');
    assert.strictEqual(studio.state.isGenerating, false);
    assert.deepStrictEqual(studio.toasts, []);
});

test('a stream that fails after a long tool keeps the tool result and partial text above the failure notice', async () => {
    const studio = createStudio([session('A')], 'A');
    const requests = scriptStreams(async emit => {
        emit(status({ summaryResult: 'meshing (15s)' }));
        emit(status(RENDER_DONE));
        emit({ type: 'delta', text: 'The hull is rendered; baking next.' });
        emit(status({ id: 'call-2', toolName: 'bake_lightmaps', summaryResult: 'texel 4/9 (30s)' }));
        throw new ChatRequestError('AI request failed (500): {"error":{"code":500,"message":"Internal error.","status":"INTERNAL"}}', 'ai');
    }, async () => undefined);

    await studio.hook.sendMessage('render and bake the hull');

    const reply = studio.stored('A').messages[1];
    assert.ok(reply.text.startsWith('The hull is rendered; baking next.\n\n⚠️ **The AI request failed**'), reply.text);
    assert.ok(reply.text.includes('Internal error.'));
    assert.deepStrictEqual(reply.mcpExecutions!.map(e => `${e.toolName}:${e.status}`), ['render_scene:completed', 'bake_lightmaps:failed']);
    assert.ok(reply.mcpExecutions![1].summaryResult!.startsWith(STREAM_FAILED.reason));
    assert.deepStrictEqual(reply.steps!.map(s => `${s.status}:${s.title}`), ['completed:Executed tool: render_scene', 'failed:Failed: bake_lightmaps']);
    assert.ok(studio.state.mcpExecutions.every(e => e.status !== 'running'), 'no card keeps spinning in the Studio-wide list');
    assert.deepStrictEqual(studio.toasts, ['AI request failed']);
    assert.strictEqual(studio.state.isGenerating, false);

    // "Try again" sees that render_scene already ran.
    studio.view('A');
    await studio.hook.sendMessage('try again');
    const lastTurn = requests[1].chatHistory!.at(-1)!;
    assert.ok(lastTurn.text.includes('render_scene (completed): wrote scene.glb'), lastTurn.text);
});

test('a progress report that arrives after the result does not reopen the tool card', async () => {
    const studio = createStudio([session('A')], 'A');
    scriptStreams(async emit => {
        emit(status({ summaryResult: 'meshing (530s)' }));
        emit(status(RENDER_DONE));
        emit(status({ summaryResult: 'meshing (540s)' }));
        emit({ type: 'delta', text: 'Rendered.' });
    });

    const sending = studio.hook.sendMessage('render the hull');
    await sending;

    const reply = studio.stored('A').messages[1];
    assert.strictEqual(reply.mcpExecutions![0].status, 'completed');
    assert.strictEqual(reply.mcpExecutions![0].summaryResult, 'wrote scene.glb');
    assert.strictEqual(reply.steps![0].title, 'Executed tool: render_scene');
    assert.strictEqual(studio.state.mcpExecutions[0].status, 'completed');
});

test("a reply that ends in the background keeps its own session's artifacts and layout", async () => {
    const a0 = artifact('a-0');
    const b0 = artifact('b-0', 'markdown-document');
    const studio = createStudio([
        session('A', { artifactHistory: [a0], activeArtifact: a0, layoutMode: '3d' }),
        session('B', { artifactHistory: [b0], activeArtifact: b0, layoutMode: 'document' })
    ], 'A');
    const gate = deferred();
    const resume = deferred();
    scriptStreams(async emit => {
        emit({ type: 'artifact_complete', artifact: artifact('a-1') });
        gate.resolve();
        await resume.promise;
        emit({ type: 'delta', text: 'Updated the hull.' });
    });

    const sending = studio.hook.sendMessage('render the hull');
    await gate.promise;
    studio.view('B');
    resume.resolve();
    await sending;

    const a = studio.stored('A');
    assert.deepStrictEqual(a.artifactHistory.map(x => x.id), ['a-1', 'a-0'], "B's artifacts are not saved into A");
    assert.strictEqual(a.layoutMode, '3d');
    assert.strictEqual(a.activeArtifact?.id, 'a-1');
    assert.deepStrictEqual(studio.state.artifactHistory.map(x => x.id), ['b-0'], "B's canvas is untouched");
    assert.strictEqual(studio.state.layoutMode, 'document');
});

test("Stop from another session keeps the stopped session's own artifacts and layout", async () => {
    const a0 = artifact('a-0', 'live-code-sandbox');
    const b0 = artifact('b-0', 'markdown-document');
    const studio = createStudio([
        session('A', { artifactHistory: [a0], activeArtifact: a0, layoutMode: 'code' }),
        session('B', { artifactHistory: [b0], activeArtifact: b0, layoutMode: 'document' })
    ], 'A');
    const started = deferred();
    scriptStreams(async (emit, signal) => {
        emit(status({ summaryResult: 'meshing (15s)' }));
        started.resolve();
        await untilAborted(signal);
    });

    const sending = studio.hook.sendMessage('render the hull');
    await started.promise;
    studio.view('B');
    studio.hook.cancelInFlight();
    await sending;

    const a = studio.stored('A');
    assert.deepStrictEqual(a.artifactHistory.map(x => x.id), ['a-0']);
    assert.strictEqual(a.layoutMode, 'code');
    assert.strictEqual(a.messages[1].steps![0].title, 'Stopped: render_scene');
});

test('a newer message discards the older stream without saving it as a reply', async () => {
    const studio = createStudio([session('A')], 'A');
    const started = deferred();
    scriptStreams(async (emit, signal) => {
        emit({ type: 'delta', text: 'Old answer' });
        emit(status({ summaryResult: 'meshing (15s)' }));
        started.resolve();
        await untilAborted(signal);
    }, async emit => {
        emit({ type: 'delta', text: 'New answer.' });
    });

    const first = studio.hook.sendMessage('render the hull');
    await started.promise;
    studio.deps.isGenerating = true;
    studio.deps.messages = studio.state.messages;
    const second = studio.hook.sendMessage('actually, render the wings');
    await Promise.all([first, second]);

    const messages = studio.stored('A').messages;
    assert.deepStrictEqual(messages.map(m => `${m.sender}:${m.text}`), ['user:render the hull', 'user:actually, render the wings', 'assistant:New answer.']);
    assert.strictEqual(studio.state.mcpExecutions[0].status, 'failed', 'the cut-off tool is settled as cancelled');
    assert.ok(studio.state.mcpExecutions[0].summaryResult!.startsWith('Cancelled before it finished'));
    assert.strictEqual(studio.state.isGenerating, false);
    assert.deepStrictEqual(studio.toasts, []);
});
