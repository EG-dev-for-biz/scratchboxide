/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact, ChatMessage, StudioAppearanceConfig, StudioLayoutMode } from '../canvas-types';
import { ChatStore } from './chatStore';

/**
 * Stable callbacks that deep children need. These are wrapped in `useCallback`/refs by the
 * Studio so the actions context value rarely changes and `React.memo` children stay memoized.
 */
export interface StudioActions {
    showToast: (text: string, icon?: string) => void;
    sendMessage: (text?: string, options?: { skipUserBubble?: boolean }) => void;
    handleOpenInAppBrowser: (url: string, title?: string) => void;
    handlePreviewCodeInCanvas: (code: string, language: string) => void;
    handleSelectVersion: (version: CanvasArtifact) => void;
    handleUpdateArtifact: (updated: CanvasArtifact) => void;
    handleMorphArtifact: (source: CanvasArtifact, targetType: string) => void;
    handleSurfaceAiPrompt: (prompt: string) => void;
    openSettingsToTab: (tab: string) => void;
    onExecuteCommand?: (commandId: string) => void;
    setActiveArtifact: ChatStore['setActiveArtifact'];
    setLayoutMode: ChatStore['setLayoutMode'];
    setMessages: ChatStore['setMessages'];
    setCheckpointFeedback: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

/** Frequently read state. Changes whenever any member changes, so keep it lean. */
export interface StudioStateSnapshot {
    activeArtifact: CanvasArtifact | undefined;
    artifactHistory: CanvasArtifact[];
    messages: ChatMessage[];
    layoutMode: StudioLayoutMode;
    appearanceConfig: StudioAppearanceConfig;
    isGenerating: boolean;
    checkpointFeedback: Record<string, string>;
}

const StudioActionsContext = React.createContext<StudioActions | undefined>(undefined);
const StudioStateContext = React.createContext<StudioStateSnapshot | undefined>(undefined);
const StudioStoreContext = React.createContext<ChatStore | undefined>(undefined);

export interface StudioProviderProps {
    store: ChatStore;
    actions: StudioActions;
    state: StudioStateSnapshot;
    children: React.ReactNode;
}

export const StudioProvider: React.FC<StudioProviderProps> = ({ store, actions, state, children }) => (
    <StudioStoreContext.Provider value={store}>
        <StudioActionsContext.Provider value={actions}>
            <StudioStateContext.Provider value={state}>
                {children}
            </StudioStateContext.Provider>
        </StudioActionsContext.Provider>
    </StudioStoreContext.Provider>
);

export function useStudioActions(): StudioActions {
    const ctx = React.useContext(StudioActionsContext);
    if (!ctx) {
        throw new Error('useStudioActions must be used within a StudioProvider');
    }
    return ctx;
}

export function useStudioState(): StudioStateSnapshot {
    const ctx = React.useContext(StudioStateContext);
    if (!ctx) {
        throw new Error('useStudioState must be used within a StudioProvider');
    }
    return ctx;
}

/** Full store (state + dispatch + setters). Re-renders on every chat state change. */
export function useStudioStore(): ChatStore {
    const ctx = React.useContext(StudioStoreContext);
    if (!ctx) {
        throw new Error('useStudioStore must be used within a StudioProvider');
    }
    return ctx;
}
