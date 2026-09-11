/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact, ChatSession, StudioAppearanceConfig } from '../canvas-types';
import { DEFAULT_APPEARANCE_CONFIG, DEFAULT_SESSIONS } from '../state/studio-defaults';
import { ChatState, Updater } from '../state/chatStore';


const LS_SESSIONS_KEY = 'scratchbox_studio_sessions_v10';
const LS_CURRENT_SESSION_KEY = 'scratchbox_studio_current_session_id_v10';
const LS_VERSIONS_KEY = 'scratchbox_studio_artifact_versions_v10';
const LS_APPEARANCE_KEY = 'scratchbox_studio_appearance_v6';

const loadSavedSessions = (): ChatSession[] => {
    if (typeof window !== 'undefined') {
        try {
            const raw = localStorage.getItem(LS_SESSIONS_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    return parsed;
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
    appearanceConfig: StudioAppearanceConfig
): { persistSessionsImmediately: (updatedSessions: ChatSession[]) => void } {
    const { sessions, currentSessionId, messages, activeArtifact, artifactHistory, layoutMode, artifactVersions } = chatState;

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
                                    layoutMode,
                                    updatedAt: 'Just now'
                                };
                            }
                            return s;
                        });
                        try {
                            localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(updated));
                        } catch (err) {
                            // ignore quota error
                        }
                        return updated;
                    });
                    localStorage.setItem(LS_CURRENT_SESSION_KEY, currentSessionId);
                } else {
                    localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(sessions));
                }
                localStorage.setItem(LS_VERSIONS_KEY, JSON.stringify(artifactVersions));
                localStorage.setItem(LS_APPEARANCE_KEY, JSON.stringify(appearanceConfig));
            } catch (e) {
                console.warn('Failed to persist studio session state', e);
            }
        }, 400);

        return () => clearTimeout(timer);
    }, [messages, activeArtifact, artifactHistory, layoutMode, artifactVersions, appearanceConfig, currentSessionId]);

    const persistSessionsImmediately = React.useCallback((updatedSessions: ChatSession[]) => {
        try {
            localStorage.setItem(LS_SESSIONS_KEY, JSON.stringify(updatedSessions));
            if (currentSessionId) {
                localStorage.setItem(LS_CURRENT_SESSION_KEY, currentSessionId);
            }
        } catch (err) {
            // ignore quota error
        }
    }, [currentSessionId]);

    return { persistSessionsImmediately };
}
