/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact, ChatSession, StudioAppearanceConfig } from '../canvas-types';
import { ChatBaseline, chatBaseline, chatChangeSince } from '../state/chat-activity';
import { DEFAULT_APPEARANCE_CONFIG, DEFAULT_SESSIONS } from '../state/studio-defaults';
import { ChatOnDisk, ChatState, selectChatToWrite, Updater } from '../state/chatStore';
import { WorkspaceConfigClient } from '../workspace-config-client';
import { stripEmbeddedGlb } from '../../../common/strip-embedded-glb';


const LS_SESSIONS_KEY = 'scratchbox_studio_sessions_v18';
const LS_CURRENT_SESSION_KEY = 'scratchbox_studio_current_session_id_v18';
const LS_VERSIONS_KEY = 'scratchbox_studio_artifact_versions_v18';
const LS_APPEARANCE_KEY = 'scratchbox_studio_appearance_v6';

const loadSavedSessions = (): ChatSession[] => {
    if (typeof window !== 'undefined') {
        try {
            const raw = localStorage.getItem(LS_SESSIONS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    const filtered = parsed.filter(s =>
                        s.id !== 'sess-active-threejs' &&
                        s.id !== 'sess-active-agent' &&
                        s.id !== 'sess-test-generative' &&
                        s.workspaceId !== 'proj-test-workspace'
                    );
                    if (filtered.length > 0) {
                        return filtered;
                    }
                }
            }
        } catch (e) {
            console.warn('Failed to load saved sessions', e);
        }
    }
    return DEFAULT_SESSIONS;
};

const loadInitialSessionId = (allSessions: ChatSession[]): string | undefined => {
    if (typeof window !== 'undefined') {
        try {
            const savedId = localStorage.getItem(LS_CURRENT_SESSION_KEY);
            if (savedId && allSessions.some(s => s.id === savedId)) {
                return savedId;
            }
        } catch (e) {
            // ignore
        }
    }
    return allSessions[0]?.id;
};

const loadSavedVersions = (): Record<string, CanvasArtifact[]> => {
    if (typeof window !== 'undefined') {
        try {
            const saved = localStorage.getItem(LS_VERSIONS_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && typeof parsed === 'object') {
                    return parsed;
                }
            }
        } catch (e) {
            // ignore
        }
    }
    const initial: Record<string, CanvasArtifact[]> = {};
    if (typeof window !== 'undefined') {
        try {
            const saved = localStorage.getItem(LS_VERSIONS_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && typeof parsed === 'object') {
                    Object.assign(initial, parsed);
                }
            }
            // Harvest from saved sessions
            const savedSessions = localStorage.getItem(LS_SESSIONS_KEY);
            if (savedSessions) {
                const parsedSess = JSON.parse(savedSessions);
                if (Array.isArray(parsedSess)) {
                    parsedSess.forEach((sess: ChatSession) => {
                        if (sess.activeArtifact) {
                            const list = initial[sess.activeArtifact.id] || [];
                            if (!list.some(v => (v.version || 1) === (sess.activeArtifact!.version || 1))) {
                                initial[sess.activeArtifact.id] = [...list, sess.activeArtifact!].sort((a, b) => (a.version || 1) - (b.version || 1));
                            }
                        }
                        if (sess.artifactHistory) {
                            sess.artifactHistory.forEach(art => {
                                const list = initial[art.id] || [];
                                if (!list.some(v => (v.version || 1) === (art.version || 1))) {
                                    initial[art.id] = [...list, art].sort((a, b) => (a.version || 1) - (b.version || 1));
                                }
                            });
                        }
                        if (sess.messages) {
                            sess.messages.forEach(m => {
                                if (m.artifacts) {
                                    m.artifacts.forEach(art => {
                                        const list = initial[art.id] || [];
                                        if (!list.some(v => (v.version || 1) === (art.version || 1))) {
                                            initial[art.id] = [...list, art].sort((a, b) => (a.version || 1) - (b.version || 1));
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            }
        } catch (e) {
            // ignore
        }
    }
    DEFAULT_SESSIONS.forEach(sess => {
        if (sess.activeArtifact) {
            const list = initial[sess.activeArtifact.id] || [];
            if (!list.some(v => (v.version || 1) === (sess.activeArtifact!.version || 1))) {
                initial[sess.activeArtifact.id] = [...list, sess.activeArtifact];
            }
        }
        if (sess.artifactHistory) {
            sess.artifactHistory.forEach(art => {
                const list = initial[art.id] || [];
                if (!list.some(v => (v.version || 1) === (art.version || 1))) {
                    initial[art.id] = [...list, art];
                }
            });
        }
    });
    return initial;
};

const loadSavedAppearance = (): StudioAppearanceConfig => {
    if (typeof window !== 'undefined') {
        try {
            const saved = localStorage.getItem(LS_APPEARANCE_KEY);
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && typeof parsed === 'object') {
                    return { ...DEFAULT_APPEARANCE_CONFIG, ...parsed };
                }
            }
        } catch (e) {
            // ignore
        }
    }
    return DEFAULT_APPEARANCE_CONFIG;
};

/** Build the initial `ChatState` from localStorage (or the bundled defaults). */
export function loadInitialChatState(): ChatState {
    const sessions = loadSavedSessions();
    const currentSessionId = loadInitialSessionId(sessions);
    const activeSession = sessions.find(s => s.id === currentSessionId) || sessions[0];
    return {
        sessions,
        currentSessionId,
        messages: activeSession?.messages || [],
        activeArtifact: activeSession?.activeArtifact,
        artifactHistory: activeSession?.artifactHistory || (activeSession?.activeArtifact ? [activeSession.activeArtifact] : []),
        artifactVersions: loadSavedVersions(),
        layoutMode: activeSession?.layoutMode || 'chat'
    };
}

export { loadSavedSessions, loadInitialSessionId, loadSavedVersions, loadSavedAppearance };

/**
 * Debounced localStorage auto-persistence for sessions, artifacts, versions and appearance.
 * Also keeps the current session entry in `sessions` in sync with the live conversation state.
 */
export function usePersistedChatState(
    chatState: ChatState,
    setSessions: (payload: Updater<ChatSession[]>) => void,
    mergeSessionsFromDisk: (disk: ChatSession[]) => void,
    appearanceConfig: StudioAppearanceConfig,
    workspaceRoot?: string,
    /** Bumped each time a saved chat is opened (GenerativeCanvasStudio): the chat as opened is what disk already holds. */
    chatOpenCountRef?: React.MutableRefObject<number>
): { persistSessionsImmediately: (updatedSessions: ChatSession[]) => void } {
    const { sessions, currentSessionId, messages, activeArtifact, artifactHistory, layoutMode, artifactVersions } = chatState;

    // Disk is the durable copy (<workspace>/.scratchbox/sessions); localStorage only gives an instant first paint, and
    // can hold an older copy of a chat than disk. Reading disk brings the open chat up to date ('sessions/fromDisk'),
    // and the open chat, which is written whole, is not written before that read: its older copy would replace disk's.
    // What disk holds of each chat is kept, so a chat exactly as read (or as last written) is not written again.
    const onDiskRef = React.useRef(new Map<string, ChatOnDisk>());
    const [readRoot, setReadRoot] = React.useState<string>();
    React.useEffect(() => {
        let cancelled = false;
        WorkspaceConfigClient.getInstance().fetchSessions<ChatSession>(workspaceRoot).then(disk => {
            if (cancelled) return;
            onDiskRef.current = new Map(disk.map(s => [s.id, s]));
            if (disk.length > 0) mergeSessionsFromDisk(disk);
            setReadRoot(workspaceRoot ?? '');
        });
        return () => { cancelled = true; };
    }, [workspaceRoot]);

    // A chat is written, and its age stamped, only when it changed (chat-activity.ts `chatChangeSince`): opening it,
    // reading its disk copy, or showing one of its artifacts or another layout, writes nothing. Only messages carry
    // history worth keeping; an untouched default session is not written. Nothing is written before the read.
    const writtenRef = React.useRef<ChatBaseline | undefined>(undefined);
    React.useEffect(() => {
        if (!currentSessionId) return;
        const read = readRoot === (workspaceRoot ?? '') ? readRoot : undefined;
        const open = { id: currentSessionId, opens: chatOpenCountRef?.current ?? 0, root: read, messages, activeArtifact, artifactHistory };
        const { changed, baseline } = chatChangeSince(writtenRef.current, open, onDiskRef.current.get(currentSessionId));
        writtenRef.current = baseline;
        if (!changed || read === undefined) return;
        const timer = setTimeout(() => {
            writtenRef.current = chatBaseline(open);
            const chat = selectChatToWrite(chatState, onDiskRef.current.get(currentSessionId));
            if (!chat) return;
            const session = { ...chat, updatedAt: new Date().toISOString() };
            onDiskRef.current.set(session.id, session);
            setSessions(prev => prev.map(s => (s.id === currentSessionId ? { ...s, updatedAt: session.updatedAt } : s)));
            void WorkspaceConfigClient.getInstance().saveSession(workspaceRoot, session);
        }, 1500);
        return () => clearTimeout(timer);
    }, [messages, activeArtifact, artifactHistory, layoutMode, currentSessionId, workspaceRoot, readRoot]);

    // Local Storage Debounced Auto-Persistence for Sessions, Artifacts & History
    React.useEffect(() => {
        if (typeof window === 'undefined') return;
        const timer = setTimeout(() => {
            try {
                if (currentSessionId) {
                    setSessions(prev => {
                        const updated = prev.map(s => {
                            if (s.id === currentSessionId) {
                                return {
                                    ...s,
                                    messages,
                                    activeArtifact,
                                    artifactHistory,
                                    layoutMode
                                };
                            }
                            return s;
                        });
                        try {
                            localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(stripEmbeddedGlb(updated)));
                        } catch (err) {
                            try {
                                localStorage.removeItem(LS_VERSIONS_KEY);
                                const minimal = updated.slice(-3);
                                localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(minimal));
                            } catch {}
                        }
                        return updated;
                    });
                    localStorage.setItem(LS_CURRENT_SESSION_KEY, currentSessionId);
                } else {
                    try {
                        localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(stripEmbeddedGlb(sessions)));
                    } catch {
                        try {
                            localStorage.removeItem(LS_VERSIONS_KEY);
                            localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(sessions.slice(-3)));
                        } catch {}
                    }
                }
                try {
                    // Cap versions to 2 per artifact to prevent quota exhaustion
                    const prunedVersions: Record<string, CanvasArtifact[]> = {};
                    for (const [k, v] of Object.entries(artifactVersions || {})) {
                        prunedVersions[k] = (v || []).slice(-2);
                    }
                    localStorage.setItem(LS_VERSIONS_KEY, JSON.stringify(stripEmbeddedGlb(prunedVersions)));
                } catch {
                    localStorage.removeItem(LS_VERSIONS_KEY);
                }
                try {
                    localStorage.setItem(LS_APPEARANCE_KEY, JSON.stringify(appearanceConfig));
                } catch {}
            } catch (e) {
                console.warn('Failed to persist studio session state', e);
            }
        }, 400);

        return () => clearTimeout(timer);
    }, [messages, activeArtifact, artifactHistory, layoutMode, artifactVersions, appearanceConfig, currentSessionId]);

    const persistSessionsImmediately = React.useCallback((updatedSessions: ChatSession[]) => {
        try {
            localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(stripEmbeddedGlb(updatedSessions)));
            if (currentSessionId) {
                localStorage.setItem(LS_CURRENT_SESSION_KEY, currentSessionId);
            }
        } catch (err) {
            // ignore quota error
        }
    }, [currentSessionId]);

    return { persistSessionsImmediately };
}
