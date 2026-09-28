/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import {
    CanvasArtifact,
    ChartDataPoint,
    ChatMessage,
    ChatSession,
    DEFAULT_MCP_SERVERS,
    DEFAULT_SKILLS_CATALOG,
    GroundingMetadata,
    KanbanBoardData,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    MarkdownSection,
    McpExecutionState,
    McpServerItem,
    MetricDashboardData,
    MetricCardsData,
    MetricItem,
    ModalStackManager,
    ModalType,
    NodeGraphData,
    PrimitiveType,
    SessionViewState,
    SessionViewStateCache,
    SkillItem,
    StudioAppearanceConfig,
    StudioLayoutMode,
    StageLayoutMode,
    StudioSettingsTab,
    TokenBudgetMetrics,
    TerminalExecutionError,
    WorkspaceFileType,
    Scene3DData,
    InteractiveBrowserData,
    CodeFileTab,
    getActiveUserName,
    AgentExecutionStep,
    SandboxTemplate,
    SandboxLanguage
} from './canvas-types';
import { NodeGraphPrimitive } from './primitives/NodeGraphPrimitive';
import { MarkdownDocumentPrimitive } from './primitives/MarkdownDocumentPrimitive';
import { KanbanBoardPrimitive } from './primitives/KanbanBoardPrimitive';
import { LiveCodeSandboxPrimitive } from './primitives/LiveCodeSandboxPrimitive';
import { isVibeToolRequest, synthesizeVibeToolSandbox } from './vibe-tool-synthesizer';
import { Scene3DPrimitive } from './primitives/Scene3DPrimitive';
import { InteractiveBrowserPrimitive } from './primitives/InteractiveBrowserPrimitive';
import { BentoStageLayout } from './BentoStageLayout';
import { RelatedArtifactsRail } from './RelatedArtifactsRail';
import { ProjectArtifactController } from './project-artifact-controller';
import { UnifiedProjectCoordinator } from './unified-project-coordinator';
import { stableProjectArtifactId } from '../../common/project-artifact-graph-protocol';
import { SettingsModal } from './SettingsModal';
import { DEFAULT_RECENT_PROJECTS, ProjectItem } from './ProjectsModal';
import { SpotlightLauncherModal } from './SpotlightLauncherModal';
import { AutomationsModal } from './AutomationsModal';
export { AutomationsModal };
import { GoogleDriveConnectModal } from './GoogleDriveConnectModal';
import { GoogleDriveService } from './google-drive-service';
import type {
    ContextMentionCategory,
    ContextMentionItem
} from './context-mention-engine';
import {
    resolveContextMentionQuery,
    findTriggerMatch,
    insertMentionToken,
    cycleSelectedIndex
} from './context-mention-engine';
import { ContextMentionAutocompletePopover } from './ContextMentionAutocompletePopover';
import {
    synthesizeTerminalDebugPrompt
} from './terminal-debug-bridge';
import { GeminiClient, AudioPlayer } from './gemini-client';
import { WorkspaceConfigClient } from './workspace-config-client';
import {
    IconAutomations,
    IconChat,
    IconChevronDown,
    IconChevronRight,
    IconClose,
    IconCode,
    IconCustomize,
    IconDocument,
    IconFolder,
    IconKanban,
    IconMic,
    IconNewChat,
    IconPlus,
    IconSearch,
    IconSettings,
    IconSparkles,
    Icon3D,
    IconGlobe,
    IconList,
    IconEdit,
    IconSplit,
    getPrimitiveSvgIcon
} from './canvas-icons';
import {
    AttachedMcpToolContext,
    AttachedSkillContext,
    GeminiStatus
} from '../../common/gemini-protocol';
import {
    AgentSessionState,
    AgentStreamEvent,
    AgentStepRecord
} from '../../common/agent-checkpoint-protocol';
import {
    ChatMarkdownRenderer,
    ThinkingDisclosure,
    AgentExecutionStepper,
    StreamingCursor,
    cleanMessageTextSmart,
    extractArtifactFromJson
} from './ChatMarkdownRenderer';
import { CanvasErrorBoundary } from './CanvasErrorBoundary';
import {
    resolveModeForArtifact,
    sanitizeLayoutMode
} from './guardrails-service';
import { morphArtifact } from './primitive-transformer-engine';
import { synthesizeContextual3DScene } from './procedural-3d-synthesizer';
import {
    CodebaseLensController,
    CodebaseLensRegistry,
    MarkdownDocumentLens,
    LiveCodeSandboxLens,
    KanbanTaskLens,
    NodeGraphWorkflowLens
} from './lenses';
import {
    extractDocumentTitleFromPrompt,
    generateMotivatedEditorialImageSection,
    synthesizeComprehensiveDocument,
    synthesizeMediaDocument
} from './document-synthesis-engine';

export {
    extractDocumentTitleFromPrompt,
    generateMotivatedEditorialImageSection,
    synthesizeComprehensiveDocument,
    synthesizeMediaDocument
};
import { useChatStore, selectActiveSession } from './state/chatStore';
import { StudioProvider, useStableStudioActions } from './state/StudioContext';
import { Composer, ComposerProps } from './chat/Composer';
import { MessageList } from './chat/MessageList';
import { WorkspaceSidebar, WorkspaceSidebarProps } from './studio/WorkspaceSidebar';
import { StudioTopBar, StudioTopBarProps } from './studio/StudioTopBar';
import { ArtifactStage, ArtifactStageProps } from './studio/ArtifactStage';
import { useWorkspaceGraphCoordinator } from './studio/useWorkspaceGraphCoordinator';
import { useResolvedWorkspaceRoot } from './hooks/useResolvedWorkspaceRoot';
import { useComposerGitEnv } from './hooks/useComposerGitEnv';
import { useArtifactExports } from './hooks/useArtifactExports';
import { useCanvasOpeners } from './hooks/useCanvasOpeners';
import { useArtifactSync } from './hooks/useArtifactSync';
import { useLayoutModeSwitch, useCreateEmptyCanvas, UseLayoutModeSwitchDeps } from './hooks/useLayoutModeSwitch';
import { useWorkspaceFiles, useWorkspaceFileCreation, UseWorkspaceFilesDeps } from './hooks/useWorkspaceFiles';
import { useCapabilities } from './hooks/useCapabilities';
import { useComposerInput } from './hooks/useComposerInput';
import { useComposerAutocomplete } from './hooks/useComposerAutocomplete';
import { useSessionHandlers } from './hooks/useSessionHandlers';
import { useDataFileAttachments } from './hooks/useDataFileAttachments';
import { AgentDashboard } from './studio/AgentDashboard';
import { useDeepWritePipeline } from './hooks/useDeepWritePipeline';
import { useLongRunningAgent } from './hooks/useLongRunningAgent';
import {
    getPrimitiveIcon,
    getPrimitiveLabel,
    getCanvasHeaderLabel as canvasHeaderLabel,
    getCanvasReopenLabel as canvasReopenLabel,
    getCanvasReopenTabTitle as canvasReopenTabTitle,
    getCanvasReopenIcon as canvasReopenIcon
} from './studio/canvas-labels';
import { DEFAULT_WORKSPACE_FILES, DEFAULT_WORKSPACE_GIT_STATUS, siblingWorkspacePath } from './state/studio-defaults';
import { loadInitialChatState, loadSavedAppearance, usePersistedChatState } from './hooks/usePersistedChatState';


import type { FileTreeNode } from './studio/workspace-trees';
export type { FileTreeNode } from './studio/workspace-trees';
export { SCRATCHBOX_TREE, POSE_3D_TREE } from './studio/workspace-trees';
import { SCRATCHBOX_TREE, POSE_3D_TREE } from './studio/workspace-trees';



export { StreamBufferQueue, captureActiveCanvasScreenshot } from './chat/streaming-utils';
import { StreamBufferQueue, captureActiveCanvasScreenshot, streamTokensAsync } from './chat/streaming-utils';
import { useSendMessage } from './hooks/useSendMessage';
import { LIVE_CODE_STARTER_APP } from './studio/liveCodeStarterTemplate';

export interface GenerativeCanvasStudioProps {
    onOpenFolder?: () => void;
    onCreateFile?: () => void;
    onOpenWorkspace?: () => void;
    onOpenPreferences?: () => void;
    onOpenKeyboardShortcuts?: () => void;
    onExecuteCommand?: (commandId: string) => void;
}

export const GenerativeCanvasStudio: React.FC<GenerativeCanvasStudioProps> = ({
    onOpenFolder,
    onCreateFile,
    onOpenWorkspace,
    onOpenPreferences,
    onOpenKeyboardShortcuts,
    onExecuteCommand
}) => {
    // Chat Sessions, active conversation & canvas state live in the reducer-backed chat store
    const initialChatState = React.useMemo(() => {
        const loaded = loadInitialChatState();
        return { ...loaded, layoutMode: sanitizeLayoutMode(loaded.layoutMode, loaded.activeArtifact) };
    }, []);
    const chatStore = useChatStore(initialChatState);
    const {
        state: chatState,
        setSessions,
        setCurrentSessionId,
        setMessages,
        setActiveArtifact,
        setArtifactHistory,
        setArtifactVersions,
        setLayoutMode
    } = chatStore;
    const { sessions, currentSessionId, messages, activeArtifact, artifactHistory, artifactVersions, layoutMode } = chatState;
    const activeSession = selectActiveSession(chatState);

    const recordArtifactVersion = (art: CanvasArtifact) => {
        setArtifactVersions(prev => {
            const list = prev[art.id] || [];
            const ver = art.version || 1;
            const exists = list.some(v => (v.version || 1) === ver);
            if (exists) {
                return {
                    ...prev,
                    [art.id]: list.map(v => (v.version || 1) === ver ? art : v)
                };
            }
            return {
                ...prev,
                [art.id]: [...list, art].sort((a, b) => (a.version || 1) - (b.version || 1))
            };
        });
    };
    const [isSidebarOpen, setIsSidebarOpen] = React.useState<boolean>(() =>
        typeof window !== 'undefined' ? window.innerWidth > 1024 : true
    );

    // Session-Bound Stream Isolation Ref
    const activeSessionRef = React.useRef<string | undefined>(currentSessionId);
    React.useEffect(() => {
        activeSessionRef.current = currentSessionId;
    }, [currentSessionId]);

    // Viewport & Sub-Tab State Retention Cache
    const sessionViewStateCacheRef = React.useRef<SessionViewStateCache>(new SessionViewStateCache());

    // Unified LIFO Modal Stack Manager
    const modalManagerRef = React.useRef<ModalStackManager>(new ModalStackManager());
    const [modalStack, setModalStack] = React.useState<ModalType[]>([]);

    const openModal = React.useCallback((modal: ModalType) => {
        modalManagerRef.current.openModal(modal);
        setModalStack(modalManagerRef.current.getStack());
    }, []);

    const closeModal = React.useCallback((modal: ModalType) => {
        modalManagerRef.current.closeModal(modal);
        setModalStack(modalManagerRef.current.getStack());
    }, []);

    const closeTopModal = React.useCallback(() => {
        const popped = modalManagerRef.current.closeTopModal();
        setModalStack(modalManagerRef.current.getStack());
        return popped;
    }, []);

    const isSpotlightOpen = modalStack.includes('spotlight');
    const isSettingsOpen = modalStack.includes('settings');
    const isGoogleDriveOpen = modalStack.includes('google-drive');
    const [globalToast, setGlobalToast] = React.useState<{ text: string; icon: string } | undefined>(undefined);

    const showToast = React.useCallback((text: string, icon: string = '') => {
        setGlobalToast({ text, icon });
        setTimeout(() => setGlobalToast(undefined), 3200);
    }, []);

    // Composer & generation state
    const [inputValue, setInputValue] = React.useState<string>('');
    const [checkpointFeedback, setCheckpointFeedback] = React.useState<Record<string, string>>({});
    const [isGenerating, setIsGenerating] = React.useState<boolean>(false);
    const messagesEndRef = React.useRef<HTMLDivElement>(null);
    const inputRef = React.useRef<HTMLTextAreaElement>(null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);


    const { googleSearchGrounding, mcpExecutions, mcpServers, setGoogleSearchGrounding, setMcpExecutions, setMcpServers, setSkills, skills } = useCapabilities();

    // Gemini 3.7 Flash Backend State & Live Streaming Tokens
    const [liveThinkingText, setLiveThinkingText] = React.useState<string>('');
    const [liveThinkingSeconds, setLiveThinkingSeconds] = React.useState<number>(0);
    const [liveSteps, setLiveSteps] = React.useState<AgentExecutionStep[]>([]);
    const [liveStreamedText, setLiveStreamedText] = React.useState<string>('');
    const [activeStreamingSectionId, setActiveStreamingSectionId] = React.useState<string | undefined>(undefined);

    // Layout Modes (layoutMode itself lives in the chat store)
    const [aiInteractionMode, setAiInteractionMode] = React.useState<'agent' | 'ask' | 'plan'>('agent');
    const [stageLayoutMode, setStageLayoutMode] = React.useState<StageLayoutMode>('single');
    const [docReadOnly, setDocReadOnly] = React.useState<boolean>(false);
    const [documentPaneState, setDocumentPaneState] = React.useState<'split' | 'collapsed' | 'expanded'>('split');
    const [splitRatio, setSplitRatio] = React.useState<number>(0.382); // Golden ratio ~38.2% chat, 61.8% stage
    const [isDraggingSplitter, setIsDraggingSplitter] = React.useState<boolean>(false);
    const splitContainerRef = React.useRef<HTMLDivElement | null>(null);

    React.useEffect(() => {
        if (!isDraggingSplitter) return;
        const handleMouseMove = (e: MouseEvent) => {
            if (!splitContainerRef.current) return;
            const rect = splitContainerRef.current.getBoundingClientRect();
            if (rect.width <= 0) return;
            const newRatio = (e.clientX - rect.left) / rect.width;
            const clampedRatio = Math.max(0.22, Math.min(0.65, newRatio));
            setSplitRatio(clampedRatio);
        };
        const handleMouseUp = () => {
            setIsDraggingSplitter(false);
        };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDraggingSplitter]);

    const layoutModeDeps: UseLayoutModeSwitchDeps = { activeArtifact, artifactHistory, recordArtifactVersion, setActiveArtifact, setArtifactHistory, setDocumentPaneState, setLayoutMode, showToast, skills };
    const { handleSwitchMode } = useLayoutModeSwitch(layoutModeDeps);
    const { handleCreateEmptyCanvas } = useCreateEmptyCanvas(layoutModeDeps);

    // Dedicated Settings & Guide View
    const [settingsInitialTab, setSettingsInitialTab] = React.useState<StudioSettingsTab>('general');
    const [appearanceConfig, setAppearanceConfig] = React.useState<StudioAppearanceConfig>(() => loadSavedAppearance());
    const [isConversationMenuOpen, setIsConversationMenuOpen] = React.useState<boolean>(false);
    const conversationMenuRef = React.useRef<HTMLDivElement | null>(null);



    // Terminal Error Capture & AI Debug Bridge
    const [terminalErrorState, setTerminalErrorState] = React.useState<{ error?: TerminalExecutionError; showToast: boolean }>({ showToast: false });
    const activeTerminalError = terminalErrorState.error;
    const showTerminalErrorToast = terminalErrorState.showToast;
    const setActiveTerminalError = React.useCallback((error?: TerminalExecutionError | ((prev?: TerminalExecutionError) => TerminalExecutionError | undefined)) => {
        setTerminalErrorState(prev => ({ ...prev, error: typeof error === 'function' ? error(prev.error) : error }));
    }, []);
    const setShowTerminalErrorToast = React.useCallback((showToast: boolean | ((prev: boolean) => boolean)) => {
        setTerminalErrorState(prev => ({ ...prev, showToast: typeof showToast === 'function' ? showToast(prev.showToast) : showToast }));
    }, []);

    // Mock/Live Workspace file list & git status for @file / @git autocomplete
    const workspaceFilesList = DEFAULT_WORKSPACE_FILES;
    const workspaceGitStatus = DEFAULT_WORKSPACE_GIT_STATUS;
    const { activeContextCategory, attachedContextMentions, autocompleteQuery, autocompleteType, handleInputChange, handleSelectAutocompleteContext, handleSelectAutocompleteSkill, handleToggleComposerMcp, handleToggleComposerSkill, selectedAutocompleteIndex, selectedMcpIds, selectedSkillIds, setActiveContextCategory, setAttachedContextMentions, setAutocompleteQuery, setAutocompleteType, setSelectedAutocompleteIndex, setSelectedSkillIds, setTokenBudget } = useComposerAutocomplete({ inputRef, inputValue, setInputValue, setSkills, showToast });

    const [workspaces, setWorkspaces] = React.useState<ProjectItem[]>(DEFAULT_RECENT_PROJECTS);
    const [activeWorkspace, setActiveWorkspace] = React.useState<ProjectItem>(DEFAULT_RECENT_PROJECTS[0]);
    const [workspaceMenuOpen, setWorkspaceMenuOpen] = React.useState<{ newWs: boolean; composerWs: boolean }>({ newWs: false, composerWs: false });
    const showNewWorkspaceMenu = workspaceMenuOpen.newWs;
    const setShowNewWorkspaceMenu = React.useCallback((val: boolean | ((p: boolean) => boolean)) => {
        setWorkspaceMenuOpen(prev => ({ ...prev, newWs: typeof val === 'function' ? val(prev.newWs) : val }));
    }, []);
    const showComposerWorkspaceMenu = workspaceMenuOpen.composerWs;
    const setShowComposerWorkspaceMenu = React.useCallback((val: boolean | ((p: boolean) => boolean)) => {
        setWorkspaceMenuOpen(prev => ({ ...prev, composerWs: typeof val === 'function' ? val(prev.composerWs) : val }));
    }, []);
    const [newWorkspaceInputName, setNewWorkspaceInputName] = React.useState<string>('');
    useResolvedWorkspaceRoot(activeWorkspace, setActiveWorkspace, setWorkspaces);

    const {
        currentBranch,
        gitBranches,
        showGitBranchMenu,
        setShowGitBranchMenu,
        executionEnvironment,
        setExecutionEnvironment,
        showEnvironmentMenu,
        setShowEnvironmentMenu,
        handleCheckoutBranch
    } = useComposerGitEnv({ activeWorkspace, showToast });

    const handleCreateNewWorkspace = React.useCallback(async (workspaceName?: string, customPath?: string) => {
        const rawName = (workspaceName || newWorkspaceInputName || 'new-workspace').trim();
        if (!rawName) return;

        const cleanName = rawName.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim();
        const diskPath = customPath || siblingWorkspacePath(activeWorkspace.path, cleanName.toLowerCase().replace(/[\s_]+/g, '-'));

        try {
            const res = await fetch('/workspace/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: cleanName,
                    path: diskPath
                })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.workspace) {
                    const created: ProjectItem = data.workspace;
                    setWorkspaces(prev => [created, ...prev.filter(p => p.id !== created.id)]);
                    setActiveWorkspace(created);
                    setShowNewWorkspaceMenu(false);
                    setNewWorkspaceInputName('');
                    
                    const existing = sessions.find(s => s.workspaceId === created.id);
                    if (existing) {
                        handleSelectSession(existing);
                    } else {
                        const newSession: ChatSession = {
                            id: `sess-${Date.now()}`,
                            title: `Workspace: ${created.name}`,
                            fileType: 'chat',
                            layoutMode: 'chat',
                            workspaceId: created.id,
                            workspaceName: created.name,
                            relativeTime: 'Just now',
                            dateCategory: 'Today',
                            updatedAt: 'Just now',
                            messages: [],
                            artifactHistory: []
                        };
                        setSessions(prev => [newSession, ...prev]);
                        setCurrentSessionId(newSession.id);
                        setMessages([]);
                        setActiveArtifact(undefined);
                        setLayoutMode('chat');
                    }
                    showToast(`Created & switched to workspace "${created.name}"`, '📁');
                    return;
                }
            }
        } catch (e) {
            console.warn('Backend workspace creation error', e);
        }

        const createdLocal: ProjectItem = {
            id: `proj-${Date.now()}`,
            name: cleanName,
            path: diskPath,
            lastActive: 'Just created',
            tags: ['Custom', 'Workspace'],
            isActive: true
        };
        setWorkspaces(prev => [createdLocal, ...prev.filter(p => p.id !== createdLocal.id)]);
        setActiveWorkspace(createdLocal);
        setShowNewWorkspaceMenu(false);
        setNewWorkspaceInputName('');

        const newSessionLocal: ChatSession = {
            id: `sess-${Date.now()}`,
            title: `Workspace: ${createdLocal.name}`,
            fileType: 'chat',
            layoutMode: 'chat',
            workspaceId: createdLocal.id,
            workspaceName: createdLocal.name,
            relativeTime: 'Just now',
            dateCategory: 'Today',
            updatedAt: 'Just now',
            messages: [],
            artifactHistory: []
        };
        setSessions(prev => [newSessionLocal, ...prev]);
        setCurrentSessionId(newSessionLocal.id);
        setMessages([]);
        setActiveArtifact(undefined);
        setLayoutMode('chat');
        showToast(`Created & switched to workspace "${createdLocal.name}"`, '📁');
    }, [newWorkspaceInputName, showToast, activeWorkspace.path]);

    const {
        graphControllerRef,
        lensControllerRef,
        unifiedCoordinatorRef,
        graphEpoch,
        setGraphEpoch
    } = useWorkspaceGraphCoordinator({ activeWorkspace, sessions, activeArtifact });




    const { agentEvents, agentSession, handleCancelAgent, handlePauseAgent, handleResumeAgent, handleStartAgent } = useLongRunningAgent();

    const { attachedDataFile, handleFileDrop, handleFileInputChange, handleGlobalDragLeave, handleGlobalDragOver, handleGlobalDrop, isDraggingDataFile, isGlobalDraggingFile, setAttachedDataFile, setIsDraggingDataFile } = useDataFileAttachments({ inputRef, recordArtifactVersion, setActiveArtifact, setArtifactHistory, setInputValue, setSelectedSkillIds, setSkills, showToast });

    // Auto-expand chat textarea height up to 220px as content is typed/pasted
    React.useEffect(() => {
        if (inputRef.current) {
            inputRef.current.style.height = 'auto';
            const scrollH = inputRef.current.scrollHeight;
            inputRef.current.style.height = `${Math.min(Math.max(scrollH, 24), 220)}px`;
        }
    }, [inputValue]);

    React.useEffect(() => {
        if (messagesEndRef.current) {
            messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, isGenerating, liveStreamedText]);


    // Global keyboard shortcuts (⌘K spotlight toggle, ⌘O projects, ⌘, settings, Esc LIFO)
    React.useEffect(() => {
        const handleGlobalKeyDown = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                if (modalManagerRef.current.isModalOpen('spotlight')) {
                    closeModal('spotlight');
                } else {
                    openModal('spotlight');
                }
            }
            if ((e.metaKey || e.ctrlKey) && (e.key.toLowerCase() === 'o')) {
                e.preventDefault();
                if (onOpenFolder) {
                    onOpenFolder();
                } else if (onOpenWorkspace) {
                    onOpenWorkspace();
                } else {
                    openSettingsToTab('workspace');
                }
            }
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                openSettingsToTab('general');
            }
            if (e.key === 'Escape') {
                if (isConversationMenuOpen) {
                    e.preventDefault();
                    setIsConversationMenuOpen(false);
                    return;
                }
                if (modalManagerRef.current.hasOpenModals()) {
                    e.preventDefault();
                    closeTopModal();
                    return;
                }
                if (autocompleteQuery !== undefined || autocompleteType !== undefined) {
                    e.preventDefault();
                    setAutocompleteQuery(undefined);
                    setAutocompleteType(undefined);
                    return;
                }
                if (isSidebarOpen && typeof window !== 'undefined' && window.innerWidth <= 767) {
                    setIsSidebarOpen(false);
                }
            }
        };
        window.addEventListener('keydown', handleGlobalKeyDown);
        return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }, [isSidebarOpen, autocompleteQuery, autocompleteType, openModal, closeModal, closeTopModal, isConversationMenuOpen]);

    // Close conversation actions dropdown on outside click
    React.useEffect(() => {
        if (!isConversationMenuOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (conversationMenuRef.current && !conversationMenuRef.current.contains(e.target as Node)) {
                setIsConversationMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isConversationMenuOpen]);

    // Local Storage Debounced Auto-Persistence for Sessions, Artifacts & History
    const { persistSessionsImmediately } = usePersistedChatState(chatState, setSessions, appearanceConfig);

    const { handleUpdateArtifact } = useArtifactSync({ activeArtifact, activeWorkspace, artifactHistory, currentSessionId, graphControllerRef, layoutMode, lensControllerRef, messages, persistSessionsImmediately, recordArtifactVersion, setActiveArtifact, setArtifactHistory, setGraphEpoch, setMessages, setSessions });


    const { handleMorphArtifact, handleOpenInAppBrowser, handlePreviewCodeInCanvas } = useCanvasOpeners({ activeArtifact, activeWorkspace, artifactHistory, currentSessionId, graphControllerRef, layoutMode, persistSessionsImmediately, recordArtifactVersion, setActiveArtifact, setArtifactHistory, setGraphEpoch, setLayoutMode, setSessions, showToast, stageLayoutMode });
    const { syncSandboxSaveToMarkdown, triggerGoogleDocsExport, triggerGoogleDriveSave, triggerMarkdownExport } = useArtifactExports({ activeArtifact, artifactHistory, handleOpenInAppBrowser, handleUpdateArtifact, openModal, showToast });

    // Cross-Primitive Event Listeners (Media cards -> 3D scene / Sandbox / Timeline / Composer)
    React.useEffect(() => {
        const handleOpenPrimitive = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.type) {
                if (detail.forceNew) {
                    handleCreateEmptyCanvas(detail.type, detail.title);
                    return;
                }
                const existing = artifactHistory.find(a => a.type === detail.type);
                if (existing) {
                    setActiveArtifact(existing);
                    setLayoutMode(resolveModeForArtifact(existing.type));
                } else {
                    handleCreateEmptyCanvas(detail.type, detail.title);
                }
            }
        };
        const handleInsertCode = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.snippet) {
                if (activeArtifact?.type === 'live-code-sandbox') {
                    const sandboxData = activeArtifact.data as LiveCodeSandboxData;
                    const activeFile = sandboxData.files?.find(f => f.id === sandboxData.activeFileId) || sandboxData.files?.[0];
                    if (activeFile) {
                        const updatedFiles = sandboxData.files.map(f => f.id === activeFile.id ? { ...f, content: `${f.content}\n${detail.snippet}` } : f);
                        handleUpdateArtifact({
                            ...activeArtifact,
                            data: { ...sandboxData, files: updatedFiles }
                        });
                    }
                }
                setLayoutMode('code');
                showToast('Inserted code snippet into active sandbox', 'code');
            }
        };
        const handleRemixPrompt = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            if (detail?.prompt) {
                setInputValue(detail.prompt);
                inputRef.current?.focus();
                showToast('Remix prompt ready in Composer', 'sparkles');
            }
        };
        const handleApply3DTexture = () => {
            setLayoutMode('3d');
            showToast('Texture applied to 3D Scene', 'cube');
        };
        const handleAddVideoToTimeline = () => {
            setLayoutMode('video');
            showToast('Video added to 4D Timeline', 'film');
        };

        window.addEventListener('scratchbox:open-primitive', handleOpenPrimitive);
        window.addEventListener('scratchbox:insert-code', handleInsertCode);
        window.addEventListener('scratchbox:remix-prompt', handleRemixPrompt);
        window.addEventListener('scratchbox:apply-3d-texture', handleApply3DTexture);
        window.addEventListener('scratchbox:add-video-to-timeline', handleAddVideoToTimeline);

        return () => {
            window.removeEventListener('scratchbox:open-primitive', handleOpenPrimitive);
            window.removeEventListener('scratchbox:insert-code', handleInsertCode);
            window.removeEventListener('scratchbox:remix-prompt', handleRemixPrompt);
            window.removeEventListener('scratchbox:apply-3d-texture', handleApply3DTexture);
            window.removeEventListener('scratchbox:add-video-to-timeline', handleAddVideoToTimeline);
        };
    }, [activeArtifact, artifactHistory, handleCreateEmptyCanvas, handleUpdateArtifact, setActiveArtifact, setLayoutMode, setInputValue, showToast]);



    const saveCurrentSessionViewState = React.useCallback(() => {
        if (currentSessionId) {
            const vs: SessionViewState = {
                activeSandboxTabId: activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData)?.activeFileId : undefined,
                sandboxViewMode: activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData)?.viewMode : undefined,
                sandboxViewportMode: activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData)?.viewportMode : undefined,
                layoutMode
            };
            sessionViewStateCacheRef.current.updateViewState(currentSessionId, vs);
        }
    }, [currentSessionId, activeArtifact, layoutMode]);

    // Version Stepper Navigation Helpers
    const currentArtifactVersionsList: CanvasArtifact[] = React.useMemo(() => {
        if (!activeArtifact) return [];
        const recorded = artifactVersions[activeArtifact.id] || [];
        if (recorded.length === 0) return [activeArtifact];
        return recorded;
    }, [activeArtifact, artifactVersions]);

    const currentArtifactVersionIndex = React.useMemo(() => {
        if (!activeArtifact) return -1;
        const idx = currentArtifactVersionsList.findIndex(v => (v.version || 1) === (activeArtifact.version || 1));
        return idx >= 0 ? idx : currentArtifactVersionsList.length - 1;
    }, [activeArtifact, currentArtifactVersionsList]);

    const isCurrentArtifactLatestVersion = currentArtifactVersionIndex >= currentArtifactVersionsList.length - 1;

    // Persistent Artifact Tab Strip across all session artifacts
    const canvasArtifactTabs = React.useMemo(() => {
        const list = [...artifactHistory];
        if (activeArtifact && !list.some(a => a.id === activeArtifact.id)) {
            list.unshift(activeArtifact);
        }
        // Deduplicate tabs by type and title to prevent identical runs from cluttering the tab strip
        const seen = new Set<string>();
        const deduped: typeof list = [];
        for (const art of list) {
            const key = art.title ? `${art.type}::${art.title.trim().toLowerCase()}` : art.id;
            if (activeArtifact?.id === art.id) {
                deduped.push(art);
                seen.add(key);
            } else if (!seen.has(key)) {
                deduped.push(art);
                seen.add(key);
            }
        }
        return deduped;
    }, [artifactHistory, activeArtifact]);

    const getArtifactIcon = React.useCallback((type: PrimitiveType | string) => {
        switch (type) {
            case 'markdown-document': return '📄';
            case '3d-scene': return '🪐';
            case 'live-code-sandbox': return '⚡';
            case 'kanban-board': return '📋';
            case 'node-graph': return '🕸️';
            case 'metric-dashboard': return '📊';
            case 'interactive-browser': return '🌐';
            default: return '✨';
        }
    }, []);

    const handleSelectArtifactTab = React.useCallback((art: CanvasArtifact) => {
        setActiveArtifact(art);
        setLayoutMode(resolveModeForArtifact(art.type));
    }, []);

    const handleCloseArtifactTab = React.useCallback((e: React.MouseEvent, artId: string) => {
        e.stopPropagation();
        const next = artifactHistory.filter(a => a.id !== artId);
        setArtifactHistory(next);
        if (activeArtifact?.id === artId) {
            const remaining = next[0] || undefined;
            setActiveArtifact(remaining);
            if (remaining) {
                setLayoutMode(resolveModeForArtifact(remaining.type));
            } else {
                setLayoutMode('document');
            }
        }
    }, [activeArtifact, artifactHistory]);

    const handleCreateNewSandboxTab = React.useCallback(() => {
        const newTab: CanvasArtifact = {
            id: `art-sandbox-${Date.now()}`,
            type: 'live-code-sandbox',
            title: 'New Live Preview',
            summary: 'Interactive React/HTML preview playground',
            version: 1,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            data: {
                title: 'Live Sandbox Playground',
                subtitle: 'Interactive live prototype with hot reload',
                template: 'react',
                activeFileId: 'App.tsx',
                viewMode: 'preview',
                viewportMode: 'desktop',
                files: [
                    {
                        id: 'App.tsx',
                        name: 'App.tsx',
                        language: 'typescript',
                        content: LIVE_CODE_STARTER_APP,
                        isEntry: true
                    }
                ]
            }
        };
        setActiveArtifact(newTab);
        setArtifactHistory(prev => [newTab, ...prev]);
        setLayoutMode('code');
        showToast('Created new Live Code Preview tab', '⚡');
    }, [showToast]);

    const activeSandboxData = activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData) : null;

    const handleSetSandboxViewMode = React.useCallback((mode: 'code' | 'split' | 'preview') => {
        if (activeArtifact && activeArtifact.type === 'live-code-sandbox') {
            const updated = {
                ...activeArtifact,
                data: {
                    ...(activeArtifact.data as LiveCodeSandboxData),
                    viewMode: mode
                }
            };
            setActiveArtifact(updated);
            setArtifactHistory(prev => prev.map(a => a.id === updated.id ? updated : a));
        } else if (activeArtifact) {
            const morphed = morphArtifact(activeArtifact, 'live-code-sandbox');
            const updated = {
                ...morphed,
                data: {
                    ...(morphed.data as LiveCodeSandboxData),
                    viewMode: mode
                }
            };
            setActiveArtifact(updated);
            setArtifactHistory(prev => [...prev, updated]);
            setLayoutMode('code');
        }
    }, [activeArtifact]);

    const relatedArtifacts = React.useMemo(
        () => activeArtifact ? graphControllerRef.current.related(activeArtifact.id) : [],
        [activeArtifact?.id, graphEpoch]
    );

    const handleSelectRelatedArtifact = React.useCallback((artifactId: string) => {
        const selected = graphControllerRef.current.selectArtifact(
            artifactId,
            `related-select-${activeArtifact?.id || 'none'}-${artifactId}`
        );
        if (!selected) {
            return;
        }
        setActiveArtifact(selected);
        setArtifactHistory(previous => [selected, ...previous.filter(artifact => artifact.id !== selected.id)]);
        setLayoutMode(resolveModeForArtifact(selected.type));
        setGraphEpoch(epoch => epoch + 1);
    }, [activeArtifact?.id]);

    const handleOpenRelatedInBento = React.useCallback((artifactId: string) => {
        const selected = graphControllerRef.current.selectArtifact(
            artifactId,
            `related-bento-${activeArtifact?.id || 'none'}-${artifactId}`
        );
        if (!selected) {
            return;
        }
        setArtifactHistory(previous => {
            const candidates = activeArtifact ? [activeArtifact, selected, ...previous] : [selected, ...previous];
            return candidates.filter((artifact, index, all) =>
                all.findIndex(candidate => candidate.id === artifact.id) === index
            );
        });
        setActiveArtifact(selected);
        setStageLayoutMode('dual-split-horizontal');
        setGraphEpoch(epoch => epoch + 1);
    }, [activeArtifact]);

    const handleSelectVersion = (targetVersion: CanvasArtifact) => {
        setActiveArtifact(targetVersion);
        const targetMode = resolveModeForArtifact(targetVersion.type);
        setLayoutMode(targetMode);
        if (targetMode === 'document') {
            setDocumentPaneState('split');
        }
        if (currentSessionId) {
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: targetVersion } : s));
        }
    };

    const handlePrevArtifactVersion = () => {
        if (currentArtifactVersionIndex > 0) {
            const targetVer = currentArtifactVersionsList[currentArtifactVersionIndex - 1];
            if (targetVer) {
                handleSelectVersion(targetVer);
            }
        }
    };

    const handleNextArtifactVersion = () => {
        if (currentArtifactVersionIndex < currentArtifactVersionsList.length - 1) {
            const targetVer = currentArtifactVersionsList[currentArtifactVersionIndex + 1];
            if (targetVer) {
                handleSelectVersion(targetVer);
            }
        }
    };

    const handleRollbackArtifactToVersion = (targetVersion: CanvasArtifact) => {
        const latestVer = Math.max(...currentArtifactVersionsList.map(v => v.version || 1), activeArtifact?.version || 1);
        const nextVer = latestVer + 1;
        const targetMode = resolveModeForArtifact(targetVersion.type);
        const rolledBack: CanvasArtifact = {
            ...targetVersion,
            version: nextVer,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            summary: `Restored from version v${targetVersion.version || 1}`,
            data: JSON.parse(JSON.stringify(targetVersion.data))
        };
        handleUpdateArtifact(rolledBack);
        setActiveArtifact(rolledBack);
        setLayoutMode(targetMode);
        if (targetMode === 'document') {
            setDocumentPaneState('split');
        }
        showToast(`Restored artifact to v${targetVersion.version || 1} as v${nextVer}`);
    };


    const { handleClearCurrentConversation, handleDeleteSession, handleExportConversationMarkdown, handleNewChat, handleSelectSession, openSettingsToTab } = useSessionHandlers({ activeArtifact, activeSession, activeWorkspace, artifactHistory, currentSessionId, handleSwitchMode, inputRef, layoutMode, messages, openModal, saveCurrentSessionViewState, sessionViewStateCacheRef, sessions, setActiveArtifact, setArtifactHistory, setCurrentSessionId, setInputValue, setIsConversationMenuOpen, setIsSidebarOpen, setLayoutMode, setLiveThinkingText, setMessages, setSessions, setSettingsInitialTab, showToast });




    const getCanvasHeaderLabel = (): string => canvasHeaderLabel(stageLayoutMode, layoutMode);
    const getCanvasReopenLabel = (): string => canvasReopenLabel(layoutMode);
    const getCanvasReopenTabTitle = (): string => canvasReopenTabTitle(layoutMode);
    const getCanvasReopenIcon = (): React.ReactElement => canvasReopenIcon(layoutMode);


    const { executeDeepWritePipeline, handleDeepWriteResume } = useDeepWritePipeline({ activeArtifact, activeWorkspace, artifactHistory, currentSessionId, setActiveArtifact, setCurrentSessionId, setIsGenerating, setMessages, setSessions });

    const { sendMessage: handleSendMessage } = useSendMessage({
        inputValue,
        isGenerating,
        setInputValue,
        executeDeepWritePipeline,
        handleStartAgent,
        skills,
        selectedSkillIds,
        mcpServers,
        selectedMcpIds,
        currentSessionId,
        setCurrentSessionId,
        sessions,
        setSessions,
        messages,
        setMessages,
        setAutocompleteType,
        setIsGenerating,
        setLiveThinkingText,
        setLiveThinkingSeconds,
        setLiveSteps,
        setLiveStreamedText,
        setActiveStreamingSectionId,
        liveThinkingText,
        liveThinkingSeconds,
        liveSteps,
        activeSessionRef,
        googleSearchGrounding,
        activeArtifact,
        setActiveArtifact,
        artifactHistory,
        setArtifactHistory,
        layoutMode,
        setLayoutMode,
        setMcpExecutions,
        setTokenBudget,
        setActiveTerminalError,
        setShowTerminalErrorToast,
        recordArtifactVersion,
        attachedDataFile,
        setAttachedDataFile,
        attachedContextMentions,
        setAttachedContextMentions,
        showToast,
        graphControllerRef,
        setGraphEpoch,
        activeWorkspace,
        persistSessionsImmediately,
        aiInteractionMode,
        openSettingsToTab
    });
    const workspaceFileDeps: UseWorkspaceFilesDeps = { activeArtifact, activeWorkspace, artifactHistory, currentSessionId, handleSendMessage, isGenerating, layoutMode, messages, setActiveArtifact, setArtifactHistory, setCurrentSessionId, setLayoutMode, setMessages, setSessions, setShowComposerWorkspaceMenu, setShowNewWorkspaceMenu, showComposerWorkspaceMenu, showNewWorkspaceMenu, showToast };
    const { handleFileClick, handleSurfaceAiPrompt } = useWorkspaceFiles(workspaceFileDeps);
    const { handleCreateWorkspaceFile } = useWorkspaceFileCreation(workspaceFileDeps);
    const { filteredAutocompleteSkills, handleKeyDown, handleVoiceToggle, isVoiceActive } = useComposerInput({ activeContextCategory, autocompleteQuery, autocompleteType, handleSelectAutocompleteContext, handleSelectAutocompleteSkill, handleSendMessage, mcpServers, selectedAutocompleteIndex, setAutocompleteQuery, setAutocompleteType, setInputValue, setSelectedAutocompleteIndex, showToast, skills, workspaceFilesList, workspaceGitStatus });



    const composerProps: Omit<ComposerProps, 'inSplitPane'> = {
        inputValue,
        isGenerating,
        isVoiceActive,
        isDraggingDataFile,
        setIsDraggingDataFile,
        aiInteractionMode,
        setAiInteractionMode,
        attachedDataFile,
        setAttachedDataFile,
        attachedContextMentions,
        setAttachedContextMentions,
        skills,
        mcpServers,
        selectedSkillIds,
        selectedMcpIds,
        autocompleteType,
        setAutocompleteType,
        autocompleteQuery,
        selectedAutocompleteIndex,
        activeContextCategory,
        setActiveContextCategory,
        filteredAutocompleteSkills,
        workspaceFilesList,
        workspaceGitStatus,
        layoutMode,
        inputRef,
        fileInputRef,
        handleFileDrop,
        handleFileInputChange,
        handleInputChange,
        handleKeyDown,
        handleVoiceToggle,
        handleToggleComposerSkill,
        handleToggleComposerMcp,
        handleSelectAutocompleteSkill,
        handleSelectAutocompleteContext,
        activeArtifactTitle: activeArtifact?.title,
        sendMessage: () => handleSendMessage()
    };

    const messageListProps = {
        messages,
        isGenerating,
        activeArtifactId: activeArtifact?.id,
        activeArtifactVersion: activeArtifact?.version,
        checkpointFeedback,
        messagesEndRef,
        liveThinkingText,
        liveThinkingSeconds,
        liveSteps,
        liveStreamedText
    };

    const sidebarProps: WorkspaceSidebarProps = {
        activeWorkspace,
        setActiveWorkspace,
        workspaces,
        sessions,
        currentSessionId,
        isSidebarOpen,
        setIsSidebarOpen,
        handleCreateNewWorkspace,
        handleDeleteSession,
        handleNewChat,
        handleSelectSession,
        onOpenFolder,
        onOpenWorkspace,
        openSettingsToTab,
        showToast,
        showNewWorkspaceMenu,
        setShowNewWorkspaceMenu,
        newWorkspaceInputName,
        setNewWorkspaceInputName,
        onCreateWorkspaceFile: handleCreateWorkspaceFile,
        onFileClick: handleFileClick
    };

    const topBarProps: StudioTopBarProps = {
        activeArtifact,
        layoutMode,
        isSidebarOpen,
        setIsSidebarOpen,
        documentPaneState,
        setDocumentPaneState,
        isConversationMenuOpen,
        setIsConversationMenuOpen,
        conversationMenuRef,
        currentArtifactVersionsList,
        currentArtifactVersionIndex,
        isCurrentArtifactLatestVersion,
        handlePrevArtifactVersion,
        handleNextArtifactVersion,
        handleRollbackArtifactToVersion,
        handleClearCurrentConversation,
        handleExportConversationMarkdown,
        handleCreateWorkspaceFile,
        getCanvasReopenIcon,
        getCanvasReopenLabel,
        getCanvasReopenTabTitle,
        showToast,
        handleSwitchMode,
        openSettingsToTab,
        activeWorkspace,
        workspaces,
        onSelectWorkspace: setActiveWorkspace,
        onOpenFolder,
        onOpenWorkspace,
        onNewWorkspace: () => {
            setIsSidebarOpen(true);
            setShowNewWorkspaceMenu(true);
        }
    };

    const artifactStageProps: ArtifactStageProps = {
        activeArtifact,
        setActiveArtifact,
        artifactHistory,
        setArtifactHistory,
        activeWorkspace,
        layoutMode,
        stageLayoutMode,
        setStageLayoutMode,
        documentPaneState,
        setDocumentPaneState,
        docReadOnly,
        setDocReadOnly,
        isGenerating,
        activeStreamingSectionId,
        activeSandboxData,
        canvasArtifactTabs,
        relatedArtifacts,
        currentArtifactVersionsList,
        currentArtifactVersionIndex,
        isCurrentArtifactLatestVersion,
        getArtifactIcon,
        getCanvasHeaderLabel,
        getCanvasReopenTabTitle,
        handleSelectArtifactTab,
        handleCloseArtifactTab,
        handleCreateNewSandboxTab,
        handlePrevArtifactVersion,
        handleNextArtifactVersion,
        handleRollbackArtifactToVersion,
        handleSelectVersion,
        handleSelectRelatedArtifact,
        handleOpenRelatedInBento,
        handleSetSandboxViewMode,
        handleUpdateArtifact,
        handleMorphArtifact,
        handleOpenInAppBrowser,
        handleSurfaceAiPrompt,
        handleSendMessage,
        syncSandboxSaveToMarkdown,
        triggerMarkdownExport,
        triggerGoogleDriveSave,
        showToast
    };

    const studioActions = useStableStudioActions({
        showToast,
        sendMessage: handleSendMessage,
        handleOpenInAppBrowser,
        handlePreviewCodeInCanvas,
        handleSelectVersion,
        handleUpdateArtifact,
        handleMorphArtifact,
        handleSurfaceAiPrompt,
        openSettingsToTab,
        onExecuteCommand,
        executeDeepWritePipeline,
        handleDeepWriteResume,
        setActiveArtifact,
        setLayoutMode,
        setMessages,
        setCheckpointFeedback
    });
    const studioStateSnapshot = React.useMemo(() => ({
        activeArtifact,
        artifactHistory,
        messages,
        layoutMode,
        appearanceConfig,
        isGenerating,
        checkpointFeedback
    }), [activeArtifact, artifactHistory, messages, layoutMode, appearanceConfig, isGenerating, checkpointFeedback]);

    return (
        <StudioProvider store={chatStore} actions={studioActions} state={studioStateSnapshot}>
        <div
            className={`sb-chatgpt-studio-app sb-density-${appearanceConfig.canvasDensity} sb-blur-${appearanceConfig.glassBlur}`}
            onDragOver={handleGlobalDragOver}
            onDragLeave={handleGlobalDragLeave}
            onDrop={handleGlobalDrop}
        >
            {/* Global File Drop Overlay */}
            {isGlobalDraggingFile && (
                <div className="sb-global-drop-overlay">
                    <div className="sb-global-drop-card">
                        <h2 className="sb-global-drop-title">Drop SKILL.md or .skill here</h2>
                        <p className="sb-global-drop-desc">
                            Scratchbox will instantly parse, install, and activate this AI Superpower in your studio.
                        </p>
                    </div>
                </div>
            )}

            {/* Global Banner Toast */}
            {globalToast && (
                <div className="sb-global-toast-pill">
                    <span className="sb-global-toast-text">{globalToast.text}</span>
                </div>
            )}

            {/* Mobile Drawer Frosted Glass Backdrop Overlay */}
            {isSidebarOpen && (
                <div
                    className="sb-mobile-sidebar-overlay"
                    onClick={() => setIsSidebarOpen(false)}
                    aria-hidden="true"
                />
            )}

            {/* Left Scratchbox Studio Sidebar */}
            <WorkspaceSidebar {...sidebarProps} />

            {/* Main Stage Workspace Area */}
            <main className="sb-chatgpt-main-stage">
                {/* Top Navigation Bar (Minimalist & Clean) */}
                <StudioTopBar {...topBarProps} />

                {/* Body Content */}
                <div className="sb-main-surface-container">
                    {layoutMode === 'chat' ? (
                        /* Unified Main Stage & ChatGPT / Modern Cursor Layout */
                        <div className="sb-chat-stage-wrapper animate-fadeIn">
                            <div className="sb-chat-stage-content">
                                {messages.length === 0 ? (
                                    /* Empty / New Chat State: Centered Hero & Streamlined Starters */
                                    <div className="sb-chat-empty-hero-container animate-fadeIn">
                                        <div style={{ width: '64px', height: '64px', borderRadius: '18px', background: 'linear-gradient(135deg, #27272a 0%, #09090b 100%)', border: '1px solid rgba(255, 255, 255, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px auto', padding: '10px', boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)', backdropFilter: 'blur(12px)' }}>
                                            <img src="/icons/ScratchboxIDE.png" alt="Scratchbox Logo" style={{ width: '100%', height: '100%', objectFit: 'contain', filter: 'drop-shadow(0 2px 8px rgba(255,255,255,0.2))' }} />
                                        </div>
                                        <div className="sb-chat-empty-hero-badge">
                                            <span className="sb-chat-empty-hero-dot" />
                                            <span>Scratchbox 2.0 Canvas</span>
                                        </div>

                                        <h1 className="sb-chat-empty-hero-title">
                                            A canvas for AI work. What can I help you design, build, or analyze today?
                                        </h1>

                                        <div className="sb-welcome-mode-strip">
                                            <button
                                                type="button"
                                                className={`sb-btn sb-welcome-mode-btn ${aiInteractionMode === 'agent' ? 'sb-welcome-mode-btn-active' : ''}`}
                                                onClick={() => setAiInteractionMode('agent')}
                                            >
                                                Agent: Full-Stack Builder
                                            </button>
                                            <button
                                                type="button"
                                                className={`sb-btn sb-welcome-mode-btn ${aiInteractionMode === 'ask' ? 'sb-welcome-mode-btn-active' : ''}`}
                                                onClick={() => setAiInteractionMode('ask')}
                                            >
                                                Ask: Codebase &amp; Docs
                                            </button>
                                            <button
                                                type="button"
                                                className={`sb-btn sb-welcome-mode-btn ${aiInteractionMode === 'plan' ? 'sb-welcome-mode-btn-active' : ''}`}
                                                onClick={() => setAiInteractionMode('plan')}
                                            >
                                                Plan: Architecture
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    /* Full-Width / Centered Chat Stream View */
                                    <MessageList className="sb-split-chat-messages sb-standalone-chat-messages" {...messageListProps} />
                                )}
                            </div>

                            {/* Floating Bottom-Centered Composer Dock */}
                            <div className="sb-bottom-chatgpt-dock">
                                {/* Context Selector Strip: [ 📁 workspace-name ⌄ ] [ main ⌄ ] [ 💻 This Mac ⌄ ] */}
                                <div className="sb-cursor-context-selector-row" style={{ position: 'relative' }}>
                                    <button
                                        type="button"
                                        className="sb-cursor-context-dropdown-btn"
                                        onClick={e => {
                                            e.stopPropagation();
                                            setShowComposerWorkspaceMenu(!showComposerWorkspaceMenu);
                                        }}
                                        title="Switch Workspace"
                                    >
                                        <IconFolder size={12} className="text-zinc-400" />
                                        <span>{activeWorkspace.path.split('/').pop() || activeWorkspace.name}</span>
                                        <IconChevronDown size={10} className="text-zinc-500" />
                                    </button>

                                    {showComposerWorkspaceMenu && (
                                        <div className="sb-composer-context-popover animate-popover" onClick={e => e.stopPropagation()}>
                                            <div className="sb-dropdown-header">Switch Workspace</div>
                                            {workspaces.map(w => (
                                                <button
                                                    key={w.id}
                                                    type="button"
                                                    className="sb-dropdown-item"
                                                    style={{ padding: '5px 8px', borderRadius: '6px' }}
                                                    onClick={() => {
                                                        setActiveWorkspace(w);
                                                        setShowComposerWorkspaceMenu(false);
                                                        showToast(`Switched active workspace to "${w.name}"`);
                                                    }}
                                                >
                                                    <IconFolder size={12} className={w.id === activeWorkspace.id ? 'text-blue-400' : 'text-zinc-400'} />
                                                    <span style={{ fontSize: '12px', fontWeight: w.id === activeWorkspace.id ? 600 : 400 }}>{w.name}</span>
                                                </button>
                                            ))}
                                            <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: '4px', marginTop: '4px' }}>
                                                <button
                                                    type="button"
                                                    className="sb-dropdown-item"
                                                    style={{ padding: '5px 8px', borderRadius: '6px' }}
                                                    onClick={() => {
                                                        setShowComposerWorkspaceMenu(false);
                                                        setIsSidebarOpen(true);
                                                        setShowNewWorkspaceMenu(true);
                                                    }}
                                                >
                                                    <IconPlus size={12} />
                                                    <span style={{ fontSize: '12px' }}>New Workspace...</span>
                                                </button>
                                            </div>
                                        </div>
                                    )}

                                    {/* Git Branch Dropdown */}
                                    <div style={{ position: 'relative' }}>
                                        <button
                                            type="button"
                                            className="sb-cursor-context-dropdown-btn"
                                            title="Git Branch"
                                            onClick={() => {
                                                setShowGitBranchMenu(!showGitBranchMenu);
                                                setShowEnvironmentMenu(false);
                                                setShowComposerWorkspaceMenu(false);
                                            }}
                                        >
                                            <span>{currentBranch}</span>
                                            <IconChevronDown size={10} className="text-zinc-500" />
                                        </button>
                                        {showGitBranchMenu && (
                                            <div
                                                className="sb-dropdown-menu animate-fadeIn"
                                                style={{
                                                    position: 'absolute',
                                                    top: '100%',
                                                    left: 0,
                                                    marginTop: '6px',
                                                    minWidth: '180px',
                                                    zIndex: 100,
                                                    background: '#18181b',
                                                    border: '1px solid #27272a',
                                                    borderRadius: '8px',
                                                    padding: '4px',
                                                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
                                                }}
                                            >
                                                <div style={{ padding: '4px 8px', fontSize: '11px', color: '#71717a', fontWeight: 600 }}>SWITCH BRANCH</div>
                                                {gitBranches.map(b => (
                                                    <button
                                                        key={b}
                                                        type="button"
                                                        className="sb-dropdown-item flex items-center justify-between"
                                                        style={{ width: '100%', padding: '6px 8px', borderRadius: '4px', background: b === currentBranch ? '#27272a' : 'transparent', textAlign: 'left', cursor: 'pointer' }}
                                                        onClick={() => handleCheckoutBranch(b)}
                                                    >
                                                        <span style={{ fontSize: '12px', color: b === currentBranch ? '#60a5fa' : '#e4e4e7' }}>{b}</span>
                                                        {b === currentBranch && <span style={{ fontSize: '10px', color: '#60a5fa' }}>✓</span>}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    {/* Execution Environment Dropdown */}
                                    <div style={{ position: 'relative' }}>
                                        <button
                                            type="button"
                                            className="sb-cursor-context-dropdown-btn"
                                            title="Execution Environment"
                                            onClick={() => {
                                                setShowEnvironmentMenu(!showEnvironmentMenu);
                                                setShowGitBranchMenu(false);
                                                setShowComposerWorkspaceMenu(false);
                                            }}
                                        >
                                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                                                <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                                                <line x1="8" y1="21" x2="16" y2="21" />
                                                <line x1="12" y1="17" x2="12" y2="21" />
                                            </svg>
                                            <span>{executionEnvironment}</span>
                                            <IconChevronDown size={10} className="text-zinc-500" />
                                        </button>
                                        {showEnvironmentMenu && (
                                            <div
                                                className="sb-dropdown-menu animate-fadeIn"
                                                style={{
                                                    position: 'absolute',
                                                    top: '100%',
                                                    left: 0,
                                                    marginTop: '6px',
                                                    minWidth: '220px',
                                                    zIndex: 100,
                                                    background: '#18181b',
                                                    border: '1px solid #27272a',
                                                    borderRadius: '8px',
                                                    padding: '4px',
                                                    boxShadow: '0 8px 24px rgba(0,0,0,0.5)'
                                                }}
                                            >
                                                <div style={{ padding: '4px 8px', fontSize: '11px', color: '#71717a', fontWeight: 600 }}>RUNTIME TARGET</div>
                                                {[
                                                    { id: 'This Mac', label: 'This Mac (Native)' },
                                                    { id: 'Cloud Run', label: 'Cloud Run Container (GCP)' },
                                                    { id: 'WebAssembly', label: 'WASM Sandbox (In-Browser)' },
                                                    { id: 'Remote SSH', label: 'Remote Linux Cluster' }
                                                ].map(env => (
                                                    <button
                                                        key={env.id}
                                                        type="button"
                                                        className="sb-dropdown-item flex items-center justify-between"
                                                        style={{ width: '100%', padding: '6px 8px', borderRadius: '4px', background: env.id === executionEnvironment ? '#27272a' : 'transparent', textAlign: 'left', cursor: 'pointer' }}
                                                        onClick={() => {
                                                            setExecutionEnvironment(env.id);
                                                            setShowEnvironmentMenu(false);
                                                            showToast(`Switched execution environment to "${env.label}"`);
                                                        }}
                                                    >
                                                        <span style={{ fontSize: '12px', color: env.id === executionEnvironment ? '#34d399' : '#e4e4e7' }}>{env.label}</span>
                                                        {env.id === executionEnvironment && <span style={{ fontSize: '10px', color: '#34d399' }}>✓</span>}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <Composer {...composerProps} inSplitPane={false} />

                                {/* System Footer Note */}
                                {messages.length === 0 && (
                                    <div className="sb-cursor-hero-footer-note">
                                        <span>Use</span>
                                        <span className="sb-code-token">/create-rule</span>
                                        <span>to control agent behavior through system-level instructions</span>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        /* Unified Workspace Surface with Unified AI Side Chat across all non-chat file types */
                        <div className="sb-fullwindow-canvas-container">
                            <div className="sb-surface-with-chat-container" style={{ display: 'flex', flexDirection: 'row', width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}>
                                {/* Unified Side-by-Side Split View for all Canvas Primitives */}
                                <div
                                    ref={splitContainerRef}
                                    className="sb-canvas-split-container sb-document-split-container"
                                    style={{ display: 'flex', width: '100%', height: '100%', overflow: 'hidden', position: 'relative' }}
                                >
                                    {/* Left Pane (splitRatio width or 100% if collapsed, 0% if expanded) */}
                                    {documentPaneState !== 'expanded' && (
                                        <div className="sb-canvas-split-left-pane sb-document-split-left-pane" style={{
                                            width: documentPaneState === 'collapsed' ? '100%' : `${(splitRatio * 100).toFixed(2)}%`,
                                            height: '100%',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            position: 'relative',
                                            borderRight: documentPaneState === 'collapsed' ? 'none' : '1px solid rgba(255,255,255,0.06)',
                                            boxSizing: 'border-box',
                                            background: 'transparent',
                                            minWidth: 0,
                                            flexShrink: 0
                                        }}>
                                            {/* Floating Right-Edge Tab to Reopen Canvas when Collapsed */}
                                            {documentPaneState === 'collapsed' && (
                                                <button
                                                    type="button"
                                                    className="sb-btn sb-doc-floating-reopen-tab animate-fadeIn"
                                                    onClick={() => setDocumentPaneState('split')}
                                                    style={{
                                                        position: 'absolute',
                                                        right: 0,
                                                        top: '50%',
                                                        transform: 'translateY(-50%)',
                                                        background: 'var(--sb-surface-card, #1c1c1e)',
                                                        border: '1px solid var(--sb-ui-card-border, rgba(255,255,255,0.12))',
                                                        borderRight: 'none',
                                                        borderRadius: '8px 0 0 8px',
                                                        padding: '12px 7px',
                                                        display: 'flex',
                                                        flexDirection: 'column',
                                                        alignItems: 'center',
                                                        gap: '8px',
                                                        cursor: 'pointer',
                                                        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                                                        zIndex: 30,
                                                        color: 'var(--sb-cadence-high, #f4f4f5)'
                                                    }}
                                                    title={getCanvasReopenLabel()}
                                                >
                                                    {getCanvasReopenIcon()}
                                                    <span style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: '11px', fontWeight: 600, letterSpacing: '0.04em' }}>{getCanvasReopenTabTitle()}</span>
                                                </button>
                                            )}

                                            {/* Scrollable chat message stream */}
                                            <MessageList
                                                className="sb-split-chat-messages"
                                                style={{
                                                    flex: 1,
                                                    overflowY: 'auto',
                                                    padding: '24px 24px 140px 24px',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    gap: '16px',
                                                    width: '100%',
                                                    boxSizing: 'border-box'
                                                }}
                                                {...messageListProps}
                                            />

                                            {/* Specifically docked beneath the left chat pane in the split-layout */}
                                            <div className="sb-bottom-chatgpt-dock" style={{
                                                position: 'absolute',
                                                bottom: '16px',
                                                left: '50%',
                                                transform: 'translateX(-50%)',
                                                width: 'calc(100% - 32px)',
                                                maxWidth: '800px',
                                                zIndex: 10,
                                                display: 'flex',
                                                flexDirection: 'column',
                                                alignItems: 'center',
                                                boxSizing: 'border-box'
                                            }}>
                                                <Composer {...composerProps} inSplitPane={false} />
                                            </div>
                                        </div>
                                    )}

                                    {/* Draggable Hairline Split Resizer */}
                                    {documentPaneState === 'split' && (
                                        <div
                                            className={`sb-canvas-split-resizer ${isDraggingSplitter ? 'dragging' : ''}`}
                                            onMouseDown={e => {
                                                e.preventDefault();
                                                setIsDraggingSplitter(true);
                                            }}
                                            onDoubleClick={() => setSplitRatio(0.382)}
                                            title="Drag to resize split pane · Double-click to reset (38/62 golden ratio)"
                                        >
                                            <div className="sb-canvas-resizer-line" />
                                            <div className="sb-canvas-resizer-knob" />
                                        </div>
                                    )}

                                    {/* Right Pane (expanded 100%, or flex-1 filling remaining stage) */}
                                    {documentPaneState !== 'collapsed' && <ArtifactStage {...artifactStageProps} />}

                                    {/* Full-screen invisible drag capture overlay to prevent iframe / Three.js mouse trapping */}
                                    {isDraggingSplitter && (
                                        <div
                                            style={{
                                                position: 'fixed',
                                                inset: 0,
                                                zIndex: 99999,
                                                cursor: 'col-resize',
                                                userSelect: 'none'
                                            }}
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </main>

            {/* Long-Running Agent Telemetry Dashboard */}
            <AgentDashboard agentSession={agentSession} agentEvents={agentEvents} handlePauseAgent={handlePauseAgent} handleResumeAgent={handleResumeAgent} handleCancelAgent={handleCancelAgent} />

            {/* Floating Spotlight Companion Launcher Overlay (⌘K) */}
            <SpotlightLauncherModal
                isOpen={isSpotlightOpen}
                onClose={() => closeModal('spotlight')}
                onPromptGemini={prompt => {
                    closeModal('spotlight');
                    if (prompt) {
                        handleSendMessage(prompt);
                    }
                }}
                onCreateArtifact={(type, title) => {
                    closeModal('spotlight');
                    handleCreateEmptyCanvas(type, title);
                }}
                onOpenSettings={tab => {
                    closeModal('spotlight');
                    openSettingsToTab(tab as any || 'general');
                }}
                onOpenAutomations={() => {
                    closeModal('spotlight');
                    handleCreateWorkspaceFile('automation');
                }}
                onOpenMcpHub={() => {
                    closeModal('spotlight');
                    openSettingsToTab('mcp');
                }}
                onDebugTerminal={() => {
                    closeModal('spotlight');
                    if (activeTerminalError) {
                        const debugPrompt = synthesizeTerminalDebugPrompt(activeTerminalError);
                        handleSendMessage(debugPrompt);
                    } else {
                        handleSendMessage('Synthesize latest terminal failure output and generate multi-file patch repair.');
                    }
                }}
                recentSessions={sessions}
                onSelectSession={sessId => {
                    closeModal('spotlight');
                    const s = sessions.find(sess => sess.id === sessId);
                    if (s) handleSelectSession(s);
                }}
            />

            {/* Global 1-Click "Debug with AI" Terminal Error Toast */}
            {showTerminalErrorToast && activeTerminalError && (
                <div className="sb-terminal-error-toast animate-fadeIn" style={{
                    position: 'fixed',
                    bottom: '24px',
                    right: '24px',
                    zIndex: 9999,
                    maxWidth: '460px',
                    padding: '14px 18px',
                    borderRadius: '18px',
                    background: 'rgba(24, 24, 27, 0.96)',
                    backdropFilter: 'blur(24px)',
                    border: '1px solid rgba(244, 63, 94, 0.5)',
                    boxShadow: '0 25px 50px rgba(0,0,0,0.7)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '10px'
                }}>
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <span style={{ fontSize: '18px' }}>🚨</span>
                            <div>
                                <div className="font-semibold text-xs text-rose-400">Terminal Process Failed (Exit Code {activeTerminalError.exitCode})</div>
                                <div className="text-[10px] text-zinc-400 font-mono">Command: {activeTerminalError.command}</div>
                            </div>
                        </div>
                        <button
                            type="button"
                            className="sb-icon-button sb-icon-button-xs"
                            onClick={() => setShowTerminalErrorToast(false)}
                        >
                            <IconClose size={12} />
                        </button>
                    </div>
                    <pre className="text-[11px] text-zinc-300 bg-zinc-950/80 p-2.5 rounded-xl border border-zinc-800/80 font-mono whitespace-pre-wrap max-h-24 overflow-y-auto m-0">
                        {activeTerminalError.output.slice(0, 300)}
                    </pre>
                    <div className="flex items-center justify-end gap-2 pt-1">
                        <button
                            type="button"
                            className="sb-btn sb-btn-ghost sb-btn-xs"
                            onClick={() => setShowTerminalErrorToast(false)}
                        >
                            Dismiss
                        </button>
                        <button
                            type="button"
                            className="sb-btn sb-btn-primary sb-btn-xs bg-rose-600 hover:bg-rose-500 text-white"
                            onClick={() => {
                                setShowTerminalErrorToast(false);
                                const debugPrompt = synthesizeTerminalDebugPrompt(activeTerminalError);
                                handleSendMessage(debugPrompt);
                            }}
                        >
                            <IconSparkles size={11} />
                            <span>1-Click Fix with AI</span>
                        </button>
                    </div>
                </div>
            )}

            {/* Google Drive & Docs 1-Click Connector Modal */}
            <GoogleDriveConnectModal
                isOpen={isGoogleDriveOpen}
                onClose={() => closeModal('google-drive')}
                onExportCurrentDocument={triggerGoogleDocsExport}
            />

            {/* Apple-Grade Settings & Guide Modal */}
            <SettingsModal
                isOpen={isSettingsOpen}
                initialTab={settingsInitialTab}
                onClose={() => closeModal('settings')}
                skills={skills}
                onSkillsChange={setSkills}
                mcpServers={mcpServers}
                onMcpServersChange={setMcpServers}
                mcpExecutions={mcpExecutions}
                appearanceConfig={appearanceConfig}
                onAppearanceConfigChange={setAppearanceConfig}
                activeWorkspace={activeWorkspace}
                googleSearchGrounding={googleSearchGrounding}
                onGoogleSearchGroundingChange={setGoogleSearchGrounding}
                onOpenProjects={() => {
                    openSettingsToTab('workspace');
                }}
                onOpenFolder={onOpenFolder}
                onCreateFile={onCreateFile}
                onOpenWorkspace={onOpenWorkspace}
                onOpenPreferences={onOpenPreferences}
                onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
                onExecuteCommand={onExecuteCommand}
                onSelectPromptStarter={(prompt, skill) => {
                    if (skill && !selectedSkillIds.includes(skill.id)) {
                        setSelectedSkillIds(prev => [...prev, skill.id]);
                    }
                    closeModal('settings');
                    handleSendMessage(prompt);
                }}
            />
        </div>
        </StudioProvider>
    );
};
