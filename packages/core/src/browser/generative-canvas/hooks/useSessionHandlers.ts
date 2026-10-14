/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * useSessionHandlers
 *
 * Chat-session management: new chat, switch/delete session (with viewport state retention), clear and export conversation, open settings tab.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import { WorkspaceConfigClient } from '../workspace-config-client';
import * as React from 'react';
import { ChatState, ChatStore } from '../state/chatStore';
import { ProjectItem } from '../ProjectsModal';
import { ChatSession, LiveCodeSandboxData, ModalType, SessionViewStateCache, StudioLayoutMode, StudioSettingsTab } from '../canvas-types';
import { resolveModeForArtifact } from '../guardrails-service';

export interface UseSessionHandlersDeps {
    activeArtifact: ChatState['activeArtifact'];
    activeSession: ChatSession | undefined;
    activeWorkspace: ProjectItem;
    artifactHistory: ChatState['artifactHistory'];
    currentSessionId: ChatState['currentSessionId'];
    handleSwitchMode: (targetMode: StudioLayoutMode) => void;
    inputRef: React.RefObject<HTMLTextAreaElement>;
    layoutMode: ChatState['layoutMode'];
    messages: ChatState['messages'];
    openModal: (modal: ModalType) => void;
    saveCurrentSessionViewState: () => void;
    sessionViewStateCacheRef: React.MutableRefObject<SessionViewStateCache>;
    sessions: ChatState['sessions'];
    setActiveArtifact: ChatStore['setActiveArtifact'];
    setArtifactHistory: ChatStore['setArtifactHistory'];
    setCurrentSessionId: ChatStore['setCurrentSessionId'];
    setInputValue: React.Dispatch<React.SetStateAction<string>>;
    setIsConversationMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setIsSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setLayoutMode: ChatStore['setLayoutMode'];
    setLiveThinkingText: React.Dispatch<React.SetStateAction<string>>;
    setMessages: ChatStore['setMessages'];
    setSessions: ChatStore['setSessions'];
    setSettingsInitialTab: React.Dispatch<React.SetStateAction<StudioSettingsTab>>;
    showToast: (text: string, icon?: string) => void;
}

export function useSessionHandlers(deps: UseSessionHandlersDeps) {
    const { activeArtifact, activeSession, activeWorkspace, artifactHistory, currentSessionId, handleSwitchMode, inputRef, layoutMode, messages, openModal, saveCurrentSessionViewState, sessionViewStateCacheRef, sessions, setActiveArtifact, setArtifactHistory, setCurrentSessionId, setInputValue, setIsConversationMenuOpen, setIsSidebarOpen, setLayoutMode, setLiveThinkingText, setMessages, setSessions, setSettingsInitialTab, showToast } = deps;

    const openSettingsToTab = (tab: StudioSettingsTab) => {
        setSettingsInitialTab(tab);
        openModal('settings');
    };

    // Chat Session Management (Matching Cursor New Chat & Thread Switch behavior)
    const handleNewChat = () => {
        const newSessionId = `session-chat-${Date.now()}`;
        const newChatSession: ChatSession = {
            id: newSessionId,
            title: 'New Chat',
            fileType: 'chat',
            layoutMode: 'chat',
            workspaceId: activeWorkspace.id,
            workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
            relativeTime: 'Just now',
            dateCategory: 'Today',
            updatedAt: 'Just now',
            messages: [],
            artifactHistory: []
        };
        setSessions(prev => [newChatSession, ...prev]);
        setCurrentSessionId(newSessionId);
        setMessages([]);
        setActiveArtifact(undefined);
        setArtifactHistory([]);
        setLayoutMode('chat');
        setInputValue('');
        setLiveThinkingText('');
        if (typeof window !== 'undefined' && window.innerWidth <= 767) {
            setIsSidebarOpen(false);
        }
        setTimeout(() => {
            inputRef.current?.focus();
        }, 50);
    };

    const handleSelectSession = (session: ChatSession) => {
        saveCurrentSessionViewState();
        setCurrentSessionId(session.id);
        setMessages(session.messages || []);

        // Check if there is cached view state for this session
        const cachedVs = sessionViewStateCacheRef.current.getViewState(session.id);
        let activeArt = session.activeArtifact;

        if (activeArt && activeArt.type === 'live-code-sandbox' && cachedVs) {
            const sbData = { ...(activeArt.data as LiveCodeSandboxData) };
            if (cachedVs.activeSandboxTabId) sbData.activeFileId = cachedVs.activeSandboxTabId;
            if (cachedVs.sandboxViewMode) sbData.viewMode = cachedVs.sandboxViewMode;
            if (cachedVs.sandboxViewportMode) sbData.viewportMode = cachedVs.sandboxViewportMode;
            activeArt = { ...activeArt, data: sbData };
        }

        setActiveArtifact(activeArt);
        setArtifactHistory(session.artifactHistory || (activeArt ? [activeArt] : []));

        const targetMode = cachedVs?.layoutMode || session.fileType || session.layoutMode || (session.activeArtifact ? resolveModeForArtifact(session.activeArtifact.type) : 'chat');
        handleSwitchMode(targetMode === 'canvas' ? 'code' : targetMode);
        if (typeof window !== 'undefined' && window.innerWidth <= 767) {
            setIsSidebarOpen(false);
        }
    };

    const handleDeleteSession = (sessionId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const remaining = sessions.filter(s => s.id !== sessionId);
        setSessions(remaining);
        void WorkspaceConfigClient.getInstance().deleteSession(activeWorkspace.path, sessionId);
        if (currentSessionId === sessionId) {
            const nextSession = remaining.find(s => s.workspaceId === activeWorkspace.id) || remaining[0];
            if (nextSession) {
                handleSelectSession(nextSession);
            } else {
                handleNewChat();
            }
        }
        showToast('Conversation deleted');
    };

    const handleClearCurrentConversation = () => {
        setMessages([]);
        if (activeSession) {
            setSessions(prev => prev.map(s => s.id === activeSession.id ? { ...s, messages: [] } : s));
        }
        showToast('Conversation cleared');
        setIsConversationMenuOpen(false);
    };

    const handleExportConversationMarkdown = () => {
        if (!messages || messages.length === 0) {
            showToast('No messages to export');
            setIsConversationMenuOpen(false);
            return;
        }
        const md = messages.map(m => `### ${m.sender === 'user' ? 'User' : 'Scratchbox AI'}\n\n${m.text}`).join('\n\n---\n\n');
        if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText) {
            navigator.clipboard.writeText(md);
            showToast('✓ Conversation copied as Markdown');
        } else {
            showToast('✓ Conversation exported');
        }
        setIsConversationMenuOpen(false);
    };

    return { handleClearCurrentConversation, handleDeleteSession, handleExportConversationMarkdown, handleNewChat, handleSelectSession, openSettingsToTab };
}
