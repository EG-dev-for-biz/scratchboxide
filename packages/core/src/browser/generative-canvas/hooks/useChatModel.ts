/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The model the open chat runs on. Each chat keeps its own (ChatSession.chatModel, saved with the chat); a new chat
 * starts on the model picked last, else on Settings > Models & AI's default, else the server's.
 */

import * as React from 'react';
import type { ChatSession } from '../canvas-types';
import type { ChatModelAvailability } from '../../../common/chat-models';
import { GeminiClient } from '../gemini-client';

const LAST_PICKED_KEY = 'scratchbox.chat.lastModel';

function readLastPicked(): string {
    try {
        return (typeof window !== 'undefined' && window.localStorage.getItem(LAST_PICKED_KEY)) || '';
    } catch {
        return '';
    }
}

function writeLastPicked(model: string): void {
    try {
        if (typeof window !== 'undefined') window.localStorage.setItem(LAST_PICKED_KEY, model);
    } catch {
        // Private windows: the pick still holds for the open chat.
    }
}

export interface ChatModelState {
    /** The open chat's model; empty for the default. */
    chatModel: string;
    setChatModel: (model: string) => void;
    chatModels: ChatModelAvailability[];
    defaultChatModel?: string;
    /** Fetch the list again (after a key is saved in Settings). */
    refreshChatModels: () => void;
}

export function useChatModel(
    sessions: ChatSession[],
    currentSessionId: string | undefined,
    setSessions: (update: (prev: ChatSession[]) => ChatSession[]) => void,
    persistSessionsImmediately: (updated: ChatSession[]) => void,
    settingsDefaultModel?: string
): ChatModelState {
    const [chatModels, setChatModels] = React.useState<ChatModelAvailability[]>([]);
    const [serverDefault, setServerDefault] = React.useState<string | undefined>();
    const [lastPicked, setLastPicked] = React.useState<string>(readLastPicked);

    const refreshChatModels = React.useCallback(() => {
        void GeminiClient.getInstance().listChatModels().then(r => {
            setChatModels(r.models);
            setServerDefault(r.defaultModel);
        });
    }, []);
    React.useEffect(refreshChatModels, [refreshChatModels]);

    const session = currentSessionId ? sessions.find(s => s.id === currentSessionId) : undefined;
    const chatModel = session?.chatModel || lastPicked || settingsDefaultModel || '';

    const setChatModel = React.useCallback((model: string) => {
        writeLastPicked(model);
        setLastPicked(model);
        if (!currentSessionId) return;
        setSessions(prev => {
            if (!prev.some(s => s.id === currentSessionId)) return prev;
            const updated = prev.map(s => s.id === currentSessionId ? { ...s, chatModel: model } : s);
            persistSessionsImmediately(updated);
            return updated;
        });
    }, [currentSessionId, setSessions, persistSessionsImmediately]);

    return { chatModel, setChatModel, chatModels, defaultChatModel: settingsDefaultModel || serverDefault, refreshChatModels };
}
