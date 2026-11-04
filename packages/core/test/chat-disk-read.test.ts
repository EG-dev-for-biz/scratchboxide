/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The browser cache can hold an older copy of the open chat than disk (seen 2026-11-02: a fresh browser profile opens
 * on the empty default chat while disk holds 11 messages of it). Reading disk brings the open chat up to date, so its
 * next save, which writes it whole, keeps what only disk held; and the read itself is not a change to write back.
 */

import { describe, expect, it } from 'vitest';
import type { CanvasArtifact, ChatMessage, ChatSession } from '../src/browser/generative-canvas/canvas-types';
import { ChatState, chatReducer, selectChatToWrite } from '../src/browser/generative-canvas/state/chatStore';
import { loadInitialChatState } from '../src/browser/generative-canvas/hooks/usePersistedChatState';
import { openChatMessagesAfterDiskRead } from '../src/common/chat-session-merge';
import { ChatBaseline, chatChangeSince } from '../src/browser/generative-canvas/state/chat-activity';

const artifact = (id: string, type: CanvasArtifact['type'] = '3d-scene'): CanvasArtifact =>
    ({ id, type, title: id, version: 1, data: {} } as unknown as CanvasArtifact);

const message = (id: string, artifacts?: CanvasArtifact[]): ChatMessage =>
    ({ id, sender: id.startsWith('msg-user') ? 'user' : 'assistant', text: id, timestamp: '10:00', artifacts });

/** The open chat as disk holds it: 11 messages, five scenes and a browser view. */
function openChatOnDisk(): ChatSession {
    const scenes = [1, 2, 3, 4, 5].map(i => artifact(`scene-${i}`));
    const viewer = artifact('art-viewer', 'interactive-browser');
    const messages: ChatMessage[] = [];
    scenes.forEach((scene, i) => messages.push(message(`msg-user-179357248${i}000`), message(`msg-assistant-179357259${i}000`, [scene])));
    messages.push(message('msg-demo-1793632267733', [viewer]));
    return {
        id: 'sess-new-canvas',
        title: 'Build 229 Mott Street, New York as...',
        dateCategory: 'Today',
        updatedAt: 'Just now',
        workspaceId: 'proj-scratchbox-ide',
        layoutMode: 'chat',
        messages,
        activeArtifact: viewer,
        artifactHistory: [viewer, ...scenes]
    };
}

const otherChatOnDisk = (): ChatSession => ({
    id: 'session-chat-1793319932174',
    title: 'Build the real place at 40.749400,...',
    dateCategory: 'Today',
    updatedAt: 'Just now',
    workspaceId: 'proj-scratchbox-ide',
    messages: [message('msg-user-1793319932200'), message('msg-assistant-1793319990000')],
    artifactHistory: []
});

/** What launching an admin demo does to the store (GenerativeCanvasStudio handleLaunchDemo). */
function launchDemo(state: ChatState, demo: CanvasArtifact): ChatState {
    const demoMessage = message(`msg-demo-${1793700000000}`, [demo]);
    state = chatReducer(state, { type: 'artifactHistory/set', payload: prev => [demo, ...prev.filter(a => a.id !== demo.id)] });
    state = chatReducer(state, { type: 'activeArtifact/set', payload: demo });
    state = chatReducer(state, { type: 'layoutMode/set', payload: '3d' });
    const openId = state.currentSessionId;
    state = chatReducer(state, { type: 'sessions/set', payload: prev => prev.map(s => (s.id === openId ? { ...s, activeArtifact: demo } : s)) });
    return chatReducer(state, { type: 'messages/set', payload: prev => [...prev, demoMessage] });
}

describe('the open chat after its disk copy is read', () => {
    it('a demo launched in a fresh profile is written after the 11 messages disk holds, not over them', () => {
        const fresh = loadInitialChatState();
        expect(fresh.currentSessionId).toBe('sess-new-canvas');
        expect(fresh.messages).toHaveLength(0);

        const disk = [openChatOnDisk(), otherChatOnDisk()];
        const read = chatReducer(fresh, { type: 'sessions/fromDisk', disk });
        const launched = launchDemo(read, artifact('demo-hero'));
        const written = selectChatToWrite(launched, disk[0]);

        expect(written?.messages.map(m => m.id)).toEqual([...disk[0].messages.map(m => m.id), 'msg-demo-1793700000000']);
        expect(written?.title).toBe('Build 229 Mott Street, New York as...');
        expect(written?.artifactHistory.map(a => a.id)).toEqual(['demo-hero', ...disk[0].artifactHistory.map(a => a.id)]);
    });

    it('reading the chat is not a change: nothing is written, and the chat list holds every chat on disk', () => {
        const disk = [openChatOnDisk(), otherChatOnDisk()];
        const read = chatReducer(loadInitialChatState(), { type: 'sessions/fromDisk', disk });

        expect(read.messages).toBe(disk[0].messages);
        expect(read.activeArtifact).toBe(disk[0].activeArtifact);
        expect(read.artifactHistory).toBe(disk[0].artifactHistory);
        expect(selectChatToWrite(read, disk[0])).toBeUndefined();
        expect(read.sessions.map(s => s.id)).toEqual(['sess-new-canvas', 'session-chat-1793319932174']);
    });

    it('a demo launched before the read arrives stays, after the messages disk holds', () => {
        const demo = artifact('demo-hero');
        const launched = launchDemo(loadInitialChatState(), demo);
        const disk = [openChatOnDisk(), otherChatOnDisk()];
        const read = chatReducer(launched, { type: 'sessions/fromDisk', disk });

        expect(read.messages.map(m => m.id)).toEqual([...disk[0].messages.map(m => m.id), 'msg-demo-1793700000000']);
        expect(read.activeArtifact).toBe(demo);
        expect(read.artifactHistory.map(a => a.id)).toEqual(['demo-hero', ...disk[0].artifactHistory.map(a => a.id)]);
        expect(selectChatToWrite(read, disk[0])?.messages).toHaveLength(12);
    });

    it('an open copy that already holds everything on disk is left as it is', () => {
        const onDisk = openChatOnDisk();
        const newer = [...onDisk.messages, message('msg-user-1793700000001')];
        const open: ChatState = { ...loadInitialChatState(), messages: newer };
        const read = chatReducer(open, { type: 'sessions/fromDisk', disk: [onDisk] });

        expect(read.messages).toBe(newer);
        expect(read.sessions[0].messages).toHaveLength(11);
        expect(selectChatToWrite(read, onDisk)?.messages).toBe(newer);
    });

    it('a chat changed after the read is written', () => {
        const disk = [openChatOnDisk()];
        const read = chatReducer(loadInitialChatState(), { type: 'sessions/fromDisk', disk });
        const changed = chatReducer(read, { type: 'activeArtifact/set', payload: disk[0].artifactHistory[1] });
        expect(selectChatToWrite(changed, disk[0])?.activeArtifact?.id).toBe('scene-1');
    });
});

/**
 * One pass of usePersistedChatState's disk write: the change is measured by chatChangeSince, nothing is written before
 * the read (`root` undefined), and what is written is selectChatToWrite's.
 */
function writePass(state: ChatState, baseline: ChatBaseline | undefined, root: string | undefined, onDisk?: ChatSession, opens = 0) {
    const open = { id: state.currentSessionId!, opens, root, messages: state.messages, activeArtifact: state.activeArtifact, artifactHistory: state.artifactHistory };
    const step = chatChangeSince(baseline, open, root === undefined ? undefined : onDisk);
    return { baseline: step.baseline, written: step.changed && root !== undefined ? selectChatToWrite(state, onDisk) : undefined };
}

describe('what the open chat writes, read first and only when it changed', () => {
    it('a stale cached copy replaced by the read writes nothing', () => {
        const fresh = loadInitialChatState();
        const disk = [openChatOnDisk(), otherChatOnDisk()];
        const mounted = writePass(fresh, undefined, undefined);
        const read = chatReducer(fresh, { type: 'sessions/fromDisk', disk });
        expect(writePass(read, mounted.baseline, '', disk[0]).written).toBeUndefined();
    });

    it('a demo launched before the read is written after the messages disk holds', () => {
        const fresh = loadInitialChatState();
        const disk = [openChatOnDisk(), otherChatOnDisk()];
        const mounted = writePass(fresh, undefined, undefined);
        const launched = launchDemo(fresh, artifact('demo-hero'));
        const before = writePass(launched, mounted.baseline, undefined);
        expect(before.written).toBeUndefined();

        const read = chatReducer(launched, { type: 'sessions/fromDisk', disk });
        expect(writePass(read, before.baseline, '', disk[0]).written?.messages).toHaveLength(12);
    });

    it('an open copy holding a message disk lacks is written once read', () => {
        const onDisk = openChatOnDisk();
        const newer = [...onDisk.messages, message('msg-user-1793700000001')];
        const open: ChatState = { ...loadInitialChatState(), messages: newer };
        const mounted = writePass(open, undefined, undefined);
        const read = chatReducer(open, { type: 'sessions/fromDisk', disk: [onDisk] });
        expect(writePass(read, mounted.baseline, '', onDisk).written?.messages).toBe(newer);
    });

    it('an open copy holding the messages disk holds, one of them with another check result, writes nothing', () => {
        const onDisk = openChatOnDisk();
        const cached = onDisk.messages.map((m, i) => (i === onDisk.messages.length - 1 ? { ...m, visualAudit: { status: 'unavailable', error: 'No frame of the canvas could be captured.' } } : { ...m })) as ChatMessage[];
        const open: ChatState = { ...loadInitialChatState(), messages: cached, activeArtifact: onDisk.activeArtifact, artifactHistory: onDisk.artifactHistory };
        const mounted = writePass(open, undefined, undefined);
        const read = chatReducer(open, { type: 'sessions/fromDisk', disk: [onDisk] });
        expect(read.messages).toBe(cached);

        const settled = writePass(read, mounted.baseline, '', onDisk);
        expect(settled.written).toBeUndefined();
        expect(writePass(read, settled.baseline, '', onDisk).written).toBeUndefined();
    });

    it('a chat disk does not hold, changed before the read, is written once read', () => {
        const fresh = loadInitialChatState();
        const mounted = writePass(fresh, undefined, undefined);
        const launched = launchDemo(fresh, artifact('demo-hero'));
        const read = chatReducer(launched, { type: 'sessions/fromDisk', disk: [otherChatOnDisk()] });
        expect(writePass(read, writePass(launched, mounted.baseline, undefined).baseline, '').written?.messages).toHaveLength(1);
    });

    it('after the read, opening the chat or showing an artifact it holds writes nothing; a new message does', () => {
        const disk = [openChatOnDisk()];
        const read = chatReducer(loadInitialChatState(), { type: 'sessions/fromDisk', disk });
        const settled = writePass(read, writePass(loadInitialChatState(), undefined, undefined).baseline, '', disk[0]);

        const reopened = writePass(read, settled.baseline, '', disk[0], 1);
        expect(reopened.written).toBeUndefined();
        const shown = chatReducer(read, { type: 'activeArtifact/set', payload: disk[0].artifactHistory[1] });
        expect(writePass(shown, reopened.baseline, '', disk[0], 1).written).toBeUndefined();

        const said = chatReducer(shown, { type: 'messages/set', payload: prev => [...prev, message('msg-user-1793700000002')] });
        expect(writePass(said, reopened.baseline, '', disk[0], 1).written?.messages).toHaveLength(12);
    });
});

describe('openChatMessagesAfterDiskRead', () => {
    const m = (id: string) => ({ id });

    it('is undefined when the open copy holds every message on disk', () => {
        expect(openChatMessagesAfterDiskRead([m('a'), m('b'), m('c')], [m('a'), m('b')])).toBeUndefined();
        expect(openChatMessagesAfterDiskRead([m('a')], [])).toBeUndefined();
    });

    it('is disk\'s own array when the open copy holds nothing disk does not', () => {
        const disk = [m('a'), m('b'), m('c')];
        expect(openChatMessagesAfterDiskRead([], disk)).toBe(disk);
        expect(openChatMessagesAfterDiskRead([m('a')], disk)).toBe(disk);
    });

    it('puts what only the open copy holds after disk\'s messages', () => {
        expect(openChatMessagesAfterDiskRead([m('a'), m('x')], [m('a'), m('b')])?.map(x => x.id)).toEqual(['a', 'b', 'x']);
    });
});
