/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact, ChatMessage, ChatSession, StudioLayoutMode } from '../canvas-types';

/**
 * Central chat/canvas state for the Generative Canvas Studio.
 * Sessions, the active conversation, the active artifact and its history/versions
 * all live here so that deep children can read through `StudioContext` instead of props.
 */
export interface ChatState {
    sessions: ChatSession[];
    currentSessionId: string | undefined;
    messages: ChatMessage[];
    activeArtifact: CanvasArtifact | undefined;
    artifactHistory: CanvasArtifact[];
    artifactVersions: Record<string, CanvasArtifact[]>;
    layoutMode: StudioLayoutMode;
}

/** A value or a functional updater, mirroring `React.SetStateAction`. */
export type Updater<T> = T | ((prev: T) => T);

export type ChatAction =
    | { type: 'sessions/set'; payload: Updater<ChatSession[]> }
    | { type: 'currentSessionId/set'; payload: Updater<string | undefined> }
    | { type: 'messages/set'; payload: Updater<ChatMessage[]> }
    | { type: 'activeArtifact/set'; payload: Updater<CanvasArtifact | undefined> }
    | { type: 'artifactHistory/set'; payload: Updater<CanvasArtifact[]> }
    | { type: 'artifactVersions/set'; payload: Updater<Record<string, CanvasArtifact[]>> }
    | { type: 'layoutMode/set'; payload: Updater<StudioLayoutMode> }
    /** Record (or replace) a version snapshot for an artifact id. */
    | { type: 'artifact/recordVersion'; artifact: CanvasArtifact }
    /** Make an artifact active and move it to the front of the history list. */
    | { type: 'artifact/activate'; artifact: CanvasArtifact; layoutMode?: StudioLayoutMode }
    /** Prepend a new session and make it the current one, seeding the active conversation from it. */
    | { type: 'session/create'; session: ChatSession }
    /** Switch the active conversation to an existing session. */
    | { type: 'session/open'; session: ChatSession; activeArtifact?: CanvasArtifact };

function resolve<T>(updater: Updater<T>, prev: T): T {
    return typeof updater === 'function' ? (updater as (prev: T) => T)(prev) : updater;
}

export function recordVersionInMap(
    versions: Record<string, CanvasArtifact[]>,
    art: CanvasArtifact
): Record<string, CanvasArtifact[]> {
    const list = versions[art.id] || [];
    const ver = art.version || 1;
    const exists = list.some(v => (v.version || 1) === ver);
    if (exists) {
        return {
            ...versions,
            [art.id]: list.map(v => (v.version || 1) === ver ? art : v)
        };
    }
    return {
        ...versions,
        [art.id]: [...list, art].sort((a, b) => (a.version || 1) - (b.version || 1))
    };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
    switch (action.type) {
        case 'sessions/set':
            return { ...state, sessions: resolve(action.payload, state.sessions) };
        case 'currentSessionId/set':
            return { ...state, currentSessionId: resolve(action.payload, state.currentSessionId) };
        case 'messages/set':
            return { ...state, messages: resolve(action.payload, state.messages) };
        case 'activeArtifact/set':
            return { ...state, activeArtifact: resolve(action.payload, state.activeArtifact) };
        case 'artifactHistory/set':
            return { ...state, artifactHistory: resolve(action.payload, state.artifactHistory) };
        case 'artifactVersions/set':
            return { ...state, artifactVersions: resolve(action.payload, state.artifactVersions) };
        case 'layoutMode/set':
            return { ...state, layoutMode: resolve(action.payload, state.layoutMode) };
        case 'artifact/recordVersion':
            return { ...state, artifactVersions: recordVersionInMap(state.artifactVersions, action.artifact) };
        case 'artifact/activate': {
            const art = action.artifact;
            return {
                ...state,
                activeArtifact: art,
                artifactHistory: [art, ...state.artifactHistory.filter(a => a.id !== art.id)],
                layoutMode: action.layoutMode ?? state.layoutMode
            };
        }
        case 'session/create': {
            const session = action.session;
            return {
                ...state,
                sessions: [session, ...state.sessions],
                currentSessionId: session.id,
                messages: session.messages || [],
                activeArtifact: session.activeArtifact,
                artifactHistory: session.artifactHistory || (session.activeArtifact ? [session.activeArtifact] : []),
                layoutMode: session.layoutMode || 'chat'
            };
        }
        case 'session/open': {
            const session = action.session;
            const activeArt = action.activeArtifact !== undefined ? action.activeArtifact : session.activeArtifact;
            return {
                ...state,
                currentSessionId: session.id,
                messages: session.messages || [],
                activeArtifact: activeArt,
                artifactHistory: session.artifactHistory || (activeArt ? [activeArt] : [])
            };
        }
        default:
            return state;
    }
}

// ------------------------------------------------------------------
// Selectors
// ------------------------------------------------------------------

export const selectActiveSession = (state: ChatState): ChatSession | undefined =>
    state.sessions.find(s => s.id === state.currentSessionId) || state.sessions[0];

/** Ordered list of recorded versions for the active artifact (falls back to the artifact itself). */
export const selectActiveVersionsList = (state: ChatState): CanvasArtifact[] => {
    if (!state.activeArtifact) return [];
    const recorded = state.artifactVersions[state.activeArtifact.id] || [];
    if (recorded.length === 0) return [state.activeArtifact];
    return recorded;
};

export const selectActiveVersionIndex = (state: ChatState, versionsList: CanvasArtifact[]): number => {
    if (!state.activeArtifact) return -1;
    const idx = versionsList.findIndex(v => (v.version || 1) === (state.activeArtifact!.version || 1));
    return idx >= 0 ? idx : versionsList.length - 1;
};

/** Persistent tab strip: history plus the active artifact if it is not yet in history. */
export const selectCanvasArtifactTabs = (state: ChatState): CanvasArtifact[] => {
    const list = [...state.artifactHistory];
    if (state.activeArtifact && !list.some(a => a.id === state.activeArtifact!.id)) {
        list.unshift(state.activeArtifact);
    }
    return list;
};

// ------------------------------------------------------------------
// Hook
// ------------------------------------------------------------------

export interface ChatStore {
    state: ChatState;
    dispatch: React.Dispatch<ChatAction>;
    setSessions: (payload: Updater<ChatSession[]>) => void;
    setCurrentSessionId: (payload: Updater<string | undefined>) => void;
    setMessages: (payload: Updater<ChatMessage[]>) => void;
    setActiveArtifact: (payload: Updater<CanvasArtifact | undefined>) => void;
    setArtifactHistory: (payload: Updater<CanvasArtifact[]>) => void;
    setArtifactVersions: (payload: Updater<Record<string, CanvasArtifact[]>>) => void;
    setLayoutMode: (payload: Updater<StudioLayoutMode>) => void;
    recordArtifactVersion: (artifact: CanvasArtifact) => void;
    activateArtifact: (artifact: CanvasArtifact, layoutMode?: StudioLayoutMode) => void;
    createSession: (session: ChatSession) => void;
    openSession: (session: ChatSession, activeArtifact?: CanvasArtifact) => void;
}

export function useChatStore(initialState: ChatState): ChatStore {
    const [state, dispatch] = React.useReducer(chatReducer, initialState);

    const setSessions = React.useCallback((payload: Updater<ChatSession[]>) => dispatch({ type: 'sessions/set', payload }), []);
    const setCurrentSessionId = React.useCallback((payload: Updater<string | undefined>) => dispatch({ type: 'currentSessionId/set', payload }), []);
    const setMessages = React.useCallback((payload: Updater<ChatMessage[]>) => dispatch({ type: 'messages/set', payload }), []);
    const setActiveArtifact = React.useCallback((payload: Updater<CanvasArtifact | undefined>) => dispatch({ type: 'activeArtifact/set', payload }), []);
    const setArtifactHistory = React.useCallback((payload: Updater<CanvasArtifact[]>) => dispatch({ type: 'artifactHistory/set', payload }), []);
    const setArtifactVersions = React.useCallback((payload: Updater<Record<string, CanvasArtifact[]>>) => dispatch({ type: 'artifactVersions/set', payload }), []);
    const setLayoutMode = React.useCallback((payload: Updater<StudioLayoutMode>) => dispatch({ type: 'layoutMode/set', payload }), []);
    const recordArtifactVersion = React.useCallback((artifact: CanvasArtifact) => dispatch({ type: 'artifact/recordVersion', artifact }), []);
    const activateArtifact = React.useCallback((artifact: CanvasArtifact, layoutMode?: StudioLayoutMode) => dispatch({ type: 'artifact/activate', artifact, layoutMode }), []);
    const createSession = React.useCallback((session: ChatSession) => dispatch({ type: 'session/create', session }), []);
    const openSession = React.useCallback((session: ChatSession, activeArtifact?: CanvasArtifact) => dispatch({ type: 'session/open', session, activeArtifact }), []);

    return React.useMemo(() => ({
        state,
        dispatch,
        setSessions,
        setCurrentSessionId,
        setMessages,
        setActiveArtifact,
        setArtifactHistory,
        setArtifactVersions,
        setLayoutMode,
        recordArtifactVersion,
        activateArtifact,
        createSession,
        openSession
    }), [
        state, setSessions, setCurrentSessionId, setMessages, setActiveArtifact, setArtifactHistory,
        setArtifactVersions, setLayoutMode, recordArtifactVersion, activateArtifact, createSession, openSession
    ]);
}
