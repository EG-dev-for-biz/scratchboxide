/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact, ChatMessage, McpExecutionState, PrimitiveType, StudioAppearanceConfig, StudioLayoutMode, StudioSettingsTab } from '../canvas-types';
import { ChatStore } from './chatStore';

/**
 * Callbacks that deep children need. `useStableStudioActions` wraps them in identity-stable
 * proxies so the actions context value never changes and `React.memo` children stay memoized.
 */
export interface StudioActions {
    showToast: (text: string, icon?: string) => void;
    sendMessage: (textToSend?: string, targetPrimitiveType?: PrimitiveType) => Promise<void>;
    handleOpenInAppBrowser: (targetUrl: string, targetTitle?: string) => void;
    handlePreviewCodeInCanvas: (language: string, content: string) => void;
    handleSelectVersion: (targetVersion: CanvasArtifact) => void;
    handleUpdateArtifact: (updatedArtifact: CanvasArtifact, opts?: { keepStage?: boolean }) => void;
    handleMorphArtifact: (morphedArtifact: CanvasArtifact) => void;
    /**
     * An artifact a canvas tool node's run produced or updated (a staged build's scene as its stages commit): kept in
     * the session by id, and shown at once when it is the artifact on stage, without taking the stage from the graph.
     */
    applyStreamedArtifact: (artifact: CanvasArtifact) => void;
    /** A canvas tool node's run, written into the chat as a tool card so the conversation and the model see it. */
    recordToolNodeRun: (exec: McpExecutionState, note: string) => void;
    handleSurfaceAiPrompt: (promptText: string) => void;
    openSettingsToTab: (tab: StudioSettingsTab) => void;
    onExecuteCommand?: (commandId: string) => void;
    executeDeepWritePipeline: (promptText: string, planOverride?: any) => Promise<void>;
    handleDeepWriteResume: (sessionId: string, feedback: string) => Promise<void>;
    setActiveArtifact: ChatStore['setActiveArtifact'];
    setLayoutMode: ChatStore['setLayoutMode'];
    setMessages: ChatStore['setMessages'];
    setCheckpointFeedback: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

/**
 * Returns an object with the same keys as `actions` whose functions never change identity;
 * each call is forwarded to the latest implementation. Missing optional actions stay undefined.
 */
export function useStableStudioActions(actions: StudioActions): StudioActions {
    const latestRef = React.useRef<StudioActions>(actions);
    latestRef.current = actions;
    const hasExecuteCommand = typeof actions.onExecuteCommand === 'function';
    return React.useMemo(() => {
        const stable: Record<string, unknown> = {};
        (Object.keys(latestRef.current) as Array<keyof StudioActions>).forEach(key => {
            if (key === 'onExecuteCommand' && !hasExecuteCommand) {
                stable[key] = undefined;
                return;
            }
            stable[key] = (...args: unknown[]) => {
                const impl = latestRef.current[key] as unknown as ((...a: unknown[]) => unknown) | undefined;
                return impl ? impl(...args) : undefined;
            };
        });
        return stable as unknown as StudioActions;
    }, [hasExecuteCommand]);
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

/** The studio actions, or undefined outside a StudioProvider (a primitive rendered on its own, as in tests). */
export function useOptionalStudioActions(): StudioActions | undefined {
    return React.useContext(StudioActionsContext);
}

/** The studio state, or undefined outside a StudioProvider. */
export function useOptionalStudioState(): StudioStateSnapshot | undefined {
    return React.useContext(StudioStateContext);
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
