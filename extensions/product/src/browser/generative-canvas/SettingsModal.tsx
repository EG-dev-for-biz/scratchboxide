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
    formatCategoryLabel,
    getMemoryCategoryGroup,
    ImageVideoStylePreference,
    McpExecutionState,
    McpServerItem,
    MemoryCategoryGroup,
    PROJECT_CONTEXT_CATEGORIES,
    SkillItem,
    StudioAppearanceConfig,
    StudioSettingsTab,
    UserMemoriesConfig,
    UserMemoryCategory,
    UserMemoryItem,
    VISUAL_STYLE_CATEGORIES,
    WRITING_STYLE_CATEGORIES,
    WritingStyleProfile
} from './canvas-types';
import { UserMemoriesClient } from './user-memories-client';
import { McpHubPrimitive } from './primitives/McpHubPrimitive';
import { SkillsManagerPrimitive } from './primitives/SkillsManagerPrimitive';
import { ProjectRule, WorkspaceConfigClient, WorkspaceSettings } from './workspace-config-client';
import { ProjectItem } from './ProjectsModal';
import {
    IconArrowLeft,
    IconCheck,
    IconClose,
    IconExternalLink,
    IconGoogleDriveColor,
    IconLock,
    IconSearch,
    IconSettings,
    IconSparkles
} from './canvas-icons';
import { GeminiClient } from './gemini-client';
import { GeminiStatus } from '../../common/gemini-protocol';
import { GoogleDriveConnectionState, GoogleDriveService } from './google-drive-service';
import { GoogleMapsService, GoogleMapsState } from './google-maps-service';

export interface SettingsModalProps {
    isOpen: boolean;
    initialTab?: StudioSettingsTab;
    onClose: () => void;
    skills: SkillItem[];
    onSkillsChange: (skills: SkillItem[]) => void;
    mcpServers: McpServerItem[];
    onMcpServersChange: (servers: McpServerItem[]) => void;
    mcpExecutions?: McpExecutionState[];
    appearanceConfig: StudioAppearanceConfig;
    onAppearanceConfigChange: (config: StudioAppearanceConfig) => void;
    onSelectPromptStarter: (prompt: string, skill?: SkillItem) => void;
    activeWorkspace?: ProjectItem;
    googleSearchGrounding?: boolean;
    onGoogleSearchGroundingChange?: (enabled: boolean) => void;
    onOpenProjects?: () => void;
    onOpenFolder?: () => void;
    onCreateFile?: () => void;
    onOpenWorkspace?: () => void;
    onOpenPreferences?: () => void;
    onOpenKeyboardShortcuts?: () => void;
    onExecuteCommand?: (commandId: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
    isOpen,
    initialTab = 'general',
    onClose,
    skills,
    onSkillsChange,
    mcpServers,
    onMcpServersChange,
    appearanceConfig,
    onAppearanceConfigChange,
    onSelectPromptStarter,
    activeWorkspace,
    googleSearchGrounding: propGoogleSearchGrounding,
    onGoogleSearchGroundingChange,
    onOpenFolder,
    onCreateFile,
    onOpenWorkspace,
    onOpenPreferences,
    onOpenKeyboardShortcuts,
    onExecuteCommand
}) => {
    // Normalize initial tab (map legacy 'guide' to 'general')
    const normalizedInitialTab = initialTab === 'guide' ? 'general' : initialTab;
    const [activeTab, setActiveTab] = React.useState<StudioSettingsTab>(normalizedInitialTab);
    const [searchQuery, setSearchQuery] = React.useState<string>('');
    const [isCustomizeBannerDismissed, setIsCustomizeBannerDismissed] = React.useState<boolean>(false);

    // General Tab Configuration States
    const [tipsEnabled, setTipsEnabled] = React.useState<boolean>(true);
    const [windowRestoration, setWindowRestoration] = React.useState<'default' | 'folders' | 'empty'>('default');
    const [continueInterruptedAgents, setContinueInterruptedAgents] = React.useState<boolean>(true);
    const [systemNotifications, setSystemNotifications] = React.useState<boolean>(true);
    const [warningNotifications, setWarningNotifications] = React.useState<boolean>(true);
    const [menuBarIcon, setMenuBarIcon] = React.useState<boolean>(true);
    const [completionSound, setCompletionSound] = React.useState<boolean>(false);
    const [privacyMode, setPrivacyMode] = React.useState<boolean>(true);

    // Profile Tab States
    const [profileEmail] = React.useState<string>('eligreenproductions@gmail.com');
    const [firstName, setFirstName] = React.useState<string>('Eli');
    const [lastName, setLastName] = React.useState<string>('Green');
    const [handle, setHandle] = React.useState<string>('eligreen');
    const [link1, setLink1] = React.useState<string>('');
    const [publicProfile, setPublicProfile] = React.useState<boolean>(false);
    const [profileSavedFeedback, setProfileSavedFeedback] = React.useState<boolean>(false);
    const [customAvatar, setCustomAvatar] = React.useState<string | null>(null);
    const [handleClaimedFeedback, setHandleClaimedFeedback] = React.useState<string | null>(null);
    const avatarInputRef = React.useRef<HTMLInputElement | null>(null);

    // Integrations & Feedback States
    const [isLoggedOut, setIsLoggedOut] = React.useState<boolean>(false);
    const [planUpgradeNotice, setPlanUpgradeNotice] = React.useState<string | null>(null);
    const [spendLimitSaved, setSpendLimitSaved] = React.useState<boolean>(false);
    const [copiedDomains, setCopiedDomains] = React.useState<boolean>(false);
    const [showDomainsList, setShowDomainsList] = React.useState<boolean>(false);

    // Google Drive & Docs Integration State
    const [gdriveState, setGdriveState] = React.useState<GoogleDriveConnectionState>(() => GoogleDriveService.getInstance().getState());
    const [isConnectingGdrive, setIsConnectingGdrive] = React.useState<boolean>(false);
    const [gdriveFeedback, setGdriveFeedback] = React.useState<string | null>(null);

    // Google Maps Platform Integration State
    const [mapsState, setMapsState] = React.useState<GoogleMapsState>(() => GoogleMapsService.getInstance().getState());
    const [mapsKeyInput, setMapsKeyInput] = React.useState<string>(() => GoogleMapsService.getInstance().getApiKey());
    const [mapsFeedback, setMapsFeedback] = React.useState<{ message: string; error?: boolean } | null>(null);
    const [isTestingMapsKey, setIsTestingMapsKey] = React.useState<boolean>(false);

    React.useEffect(() => {
        const unsubscribeGdrive = GoogleDriveService.getInstance().subscribe(state => {
            setGdriveState(state);
        });
        const unsubscribeMaps = GoogleMapsService.getInstance().subscribe(state => {
            setMapsState(state);
            setMapsKeyInput(state.apiKey);
        });
        return () => {
            unsubscribeGdrive();
            unsubscribeMaps();
        };
    }, []);

    // Appearance Tab States
    const [selectedTheme, setSelectedTheme] = React.useState<'system' | 'dark' | 'light' | 'high-contrast'>('system');
    const [toolCallDensity, setToolCallDensity] = React.useState<number>(15);
    const [codeBlockWordWrap, setCodeBlockWordWrap] = React.useState<boolean>(true);
    const [themedDiffBackgrounds, setThemedDiffBackgrounds] = React.useState<boolean>(true);
    const [colorHue, setColorHue] = React.useState<number>(210);
    const [colorIntensity, setColorIntensity] = React.useState<number>(0);
    const [reduceTransparency, setReduceTransparency] = React.useState<boolean>(false);
    const [uiFontSize, setUiFontSize] = React.useState<number>(15);
    const [codeFontSize, setCodeFontSize] = React.useState<number>(14);
    const [uiFontFamily, setUiFontFamily] = React.useState<string>('system');
    const [codeFontFamily, setCodeFontFamily] = React.useState<string>('system-mono');
    const [fontSmoothing, setFontSmoothing] = React.useState<boolean>(true);
    const [followSystemHighContrast, setFollowSystemHighContrast] = React.useState<boolean>(true);
    const [reduceMotionSetting, setReduceMotionSetting] = React.useState<string>('system');

    // Plan & Usage States
    const [monthlySpendLimit, setMonthlySpendLimit] = React.useState<string>('unlimited');

    // Agents Tab States
    const [submitWithCmdEnter, setSubmitWithCmdEnter] = React.useState<boolean>(false);
    const [defaultEnvironment, setDefaultEnvironment] = React.useState<string>('last-used');
    const [defaultAgentModel, setDefaultAgentModel] = React.useState<string>('cursor-default');
    const [newMessagesBehavior, setNewMessagesBehavior] = React.useState<string>('steer');
    const [manualQueueBehavior, setManualQueueBehavior] = React.useState<string>('interrupt');
    const [usageSummaryBehavior, setUsageSummaryBehavior] = React.useState<string>('auto');
    const [agentAutocomplete, setAgentAutocomplete] = React.useState<boolean>(true);
    const [autoApproveTransitions, setAutoApproveTransitions] = React.useState<boolean>(true);
    const [includeThirdPartyConfigs, setIncludeThirdPartyConfigs] = React.useState<boolean>(true);
    const [importClaudeCode, setImportClaudeCode] = React.useState<boolean>(false);
    const [remoteControlEnabled, setRemoteControlEnabled] = React.useState<boolean>(true);
    const [keepComputerAwake, setKeepComputerAwake] = React.useState<boolean>(true);
    const [webSearchToolEnabled, setWebSearchToolEnabled] = React.useState<boolean>(true);
    const [autoAcceptWebSearch, setAutoAcceptWebSearch] = React.useState<boolean>(true);
    const [webFetchToolEnabled, setWebFetchToolEnabled] = React.useState<boolean>(true);
    const [waitForMcpAuth, setWaitForMcpAuth] = React.useState<boolean>(true);
    const [runModeSetting, setRunModeSetting] = React.useState<string>('unsandboxed');
    const [legacyTerminalTool, setLegacyTerminalTool] = React.useState<boolean>(false);
    const [autoParseLinks, setAutoParseLinks] = React.useState<boolean>(false);

    // Git & PRs States
    const [reviewProvider, setReviewProvider] = React.useState<string>('github');
    const [prLinkDestination, setPrLinkDestination] = React.useState<string>('inside');
    const [commitAttribution, setCommitAttribution] = React.useState<boolean>(true);
    const [prAttribution, setPrAttribution] = React.useState<boolean>(true);
    const [branchPrefix, setBranchPrefix] = React.useState<string>('cursor/');

    // Worktrees States
    const [maxWorktrees, setMaxWorktrees] = React.useState<number>(25);
    const [maxTotalSizeGb, setMaxTotalSizeGb] = React.useState<number>(50);

    // Browser & Network States
    const [browserAutomationMode, setBrowserAutomationMode] = React.useState<string>('tab');
    const [browserProtection, setBrowserProtection] = React.useState<boolean>(false);
    const [openLocalLinksBrowser, setOpenLocalLinksBrowser] = React.useState<boolean>(true);
    const [openWebLinksBrowser, setOpenWebLinksBrowser] = React.useState<boolean>(true);
    const [httpCompatibilityMode, setHttpCompatibilityMode] = React.useState<string>('http2');
    const [diagnosticRunOutput, setDiagnosticRunOutput] = React.useState<string | null>(null);

    // Tab (Autocomplete) States
    const [cursorTabEnabled, setCursorTabEnabled] = React.useState<boolean>(true);
    const [partialAccepts, setPartialAccepts] = React.useState<boolean>(false);
    const [suggestionsWhileCommenting, setSuggestionsWhileCommenting] = React.useState<boolean>(true);
    const [whitespaceOnlySuggestions, setWhitespaceOnlySuggestions] = React.useState<boolean>(false);
    const [autoImportsTs, setAutoImportsTs] = React.useState<boolean>(true);
    const [autoImportPython, setAutoImportPython] = React.useState<boolean>(false);
    const [ignoredFilesGlob, setIgnoredFilesGlob] = React.useState<string>('');

    // Code Intelligence States
    const [indexRepositoriesGrep, setIndexRepositoriesGrep] = React.useState<boolean>(true);
    const [hierarchicalCursorIgnore, setHierarchicalCursorIgnore] = React.useState<boolean>(false);
    const [ignoreSymlinks, setIgnoreSymlinks] = React.useState<boolean>(false);
    const [enableLsps, setEnableLsps] = React.useState<boolean>(true);
    const [enableLspsWorktrees, setEnableLspsWorktrees] = React.useState<boolean>(false);
    const [maxLocalLspWorkspaces, setMaxLocalLspWorkspaces] = React.useState<number>(3);
    const [maxRemoteLspWorkspaces, setMaxRemoteLspWorkspaces] = React.useState<number>(3);

    // Beta States
    const [subagentSpeculative, setSubagentSpeculative] = React.useState<boolean>(true);
    const [deepResearchMode, setDeepResearchMode] = React.useState<boolean>(false);

    // Cloud Agents States
    const [cloudAgentTarget, setCloudAgentTarget] = React.useState<string>('antigravity-preview-05-2026');
    const [cloudCpuCores, setCloudCpuCores] = React.useState<number>(2);
    const [cloudRamGb, setCloudRamGb] = React.useState<number>(4);
    const [cloudTimeoutSeconds, setCloudTimeoutSeconds] = React.useState<number>(900);
    const [googleSearchGrounding, setGoogleSearchGrounding] = React.useState<boolean>(() => {
        if (propGoogleSearchGrounding !== undefined) return propGoogleSearchGrounding;
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('scratchbox_google_search_grounding');
            if (saved !== null) return saved === 'true';
        }
        return true;
    });

    React.useEffect(() => {
        if (propGoogleSearchGrounding !== undefined) {
            setGoogleSearchGrounding(propGoogleSearchGrounding);
        }
    }, [propGoogleSearchGrounding]);

    const handleToggleGoogleSearchGrounding = (newVal: boolean) => {
        setGoogleSearchGrounding(newVal);
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('scratchbox_google_search_grounding', String(newVal));
        }
        setWorkspaceSettings(prev => ({ ...prev, googleSearchGrounding: newVal }));
        if (onGoogleSearchGroundingChange) {
            onGoogleSearchGroundingChange(newVal);
        }
    };
    const [pythonCodeExecution, setPythonCodeExecution] = React.useState<boolean>(true);
    const [gcpProjectIdMapping, setGcpProjectIdMapping] = React.useState<boolean>(false);
    const [bidirectionalFilesystemSync, setBidirectionalFilesystemSync] = React.useState<boolean>(true);

    // Workspace & Gemini Configuration State
    const [workspaceRules, setWorkspaceRules] = React.useState<ProjectRule[]>([]);
    const [workspaceSettings, setWorkspaceSettings] = React.useState<WorkspaceSettings>({
        defaultModel: 'gemini-3.7-flash',
        thinkingBudget: 1024,
        customPromptInstructions: 'Follow Apple Human Interface Guidelines and strict TypeScript typing.',
        autoAttachSuperpowers: true
    });
    const [isSavingWorkspace, setIsSavingWorkspace] = React.useState<boolean>(false);
    const [saveFeedback, setSaveFeedback] = React.useState<string | undefined>(undefined);
    const [geminiStatus, setGeminiStatus] = React.useState<GeminiStatus | undefined>(undefined);
    const [credentialsInput, setCredentialsInput] = React.useState<string>('');
    const [isSavingCreds, setIsSavingCreds] = React.useState<boolean>(false);
    const [credsFeedback, setCredsFeedback] = React.useState<{ message: string; error?: boolean } | undefined>(undefined);

    React.useEffect(() => {
        if (isOpen) {
            setActiveTab(initialTab === 'guide' ? 'general' : initialTab);
            // Load workspace rules & config
            WorkspaceConfigClient.getInstance().fetchWorkspaceConfig().then(cfg => {
                if (cfg.rules) setWorkspaceRules(cfg.rules);
                if (cfg.settings) setWorkspaceSettings(prev => ({ ...prev, ...cfg.settings }));
            });
            // Fetch live Gemini connection & credentials status
            GeminiClient.getInstance().checkStatus().then(status => {
                setGeminiStatus(status);
            });
        }
    }, [isOpen, initialTab]);

    const handleSaveCredentials = async () => {
        if (!credentialsInput.trim()) return;
        setIsSavingCreds(true);
        setCredsFeedback(undefined);
        try {
            const res = await GeminiClient.getInstance().saveCredentials({
                credentialsJson: credentialsInput.trim()
            });
            if (res.success) {
                setCredsFeedback({ message: `Credentials saved & authenticated (${res.projectId || res.authMethod})` });
                setCredentialsInput('');
                const newStatus = await GeminiClient.getInstance().checkStatus();
                setGeminiStatus(newStatus);
            } else {
                setCredsFeedback({ message: res.error || 'Failed to save credentials', error: true });
            }
        } catch (err: any) {
            setCredsFeedback({ message: err.message || 'Error saving credentials', error: true });
        } finally {
            setIsSavingCreds(false);
        }
    };

    const handleSaveMapsKey = () => {
        const trimmed = mapsKeyInput.trim();
        GoogleMapsService.getInstance().setApiKey(trimmed);
        if (trimmed) {
            setMapsFeedback({ message: 'Google Maps API key saved successfully.' });
        } else {
            setMapsFeedback({ message: 'Google Maps API key cleared. Running in procedural fallback mode.' });
        }
        setTimeout(() => setMapsFeedback(null), 3500);
    };

    const handleTestMapsKey = async () => {
        setIsTestingMapsKey(true);
        setMapsFeedback(null);
        try {
            const res = await GoogleMapsService.getInstance().geocode('San Francisco Ferry Building');
            if (res && typeof res.lat === 'number') {
                setMapsFeedback({ message: `✓ Validated! Resolved "${res.formattedAddress}" (${res.lat.toFixed(4)}°, ${res.lng.toFixed(4)}°)` });
            } else {
                setMapsFeedback({ message: 'Failed to resolve test location', error: true });
            }
        } catch (e: any) {
            setMapsFeedback({ message: `Validation error: ${e?.message || 'Unknown error'}`, error: true });
        } finally {
            setIsTestingMapsKey(false);
            setTimeout(() => setMapsFeedback(null), 5000);
        }
    };

    const handleSaveWorkspaceSettings = async () => {
        setIsSavingWorkspace(true);
        const res = await WorkspaceConfigClient.getInstance().saveWorkspaceConfig(process.cwd(), {
            settings: workspaceSettings
        });
        setIsSavingWorkspace(false);
        if (res.success) {
            setSaveFeedback('Workspace configuration saved to .scratchbox/config.json');
            setTimeout(() => setSaveFeedback(undefined), 3000);
        }
    };

    // ============================================================
    // User Memories States & Handlers
    // ============================================================
    const [memories, setMemories] = React.useState<UserMemoryItem[]>([]);
    const [writingProfiles, setWritingProfiles] = React.useState<WritingStyleProfile[]>([]);
    const [activeWritingProfile, setActiveWritingProfileState] = React.useState<WritingStyleProfile | undefined>(undefined);
    const [stylePreferences, setStylePreferences] = React.useState<ImageVideoStylePreference[]>([]);
    const [memoriesConfig, setMemoriesConfig] = React.useState<UserMemoriesConfig>({ enableMemoryInjection: true });
    const [memoriesFilterGroup, setMemoriesFilterGroup] = React.useState<MemoryCategoryGroup>('all');
    const [memorySearchQuery, setMemorySearchQuery] = React.useState<string>('');
    const [expandedCategories, setExpandedCategories] = React.useState<Record<string, boolean>>({});
    const [isAddMemoryOpen, setIsAddMemoryOpen] = React.useState<boolean>(false);
    const [newMemoryCategory, setNewMemoryCategory] = React.useState<UserMemoryCategory>('tone_and_voice');
    const [newMemoryKey, setNewMemoryKey] = React.useState<string>('');
    const [newMemoryValue, setNewMemoryValue] = React.useState<string>('');
    const [newMemoryScope, setNewMemoryScope] = React.useState<'global' | 'workspace'>('global');
    const [editingMemoryId, setEditingMemoryId] = React.useState<string | null>(null);
    const [editingMemoryValue, setEditingMemoryValue] = React.useState<string>('');
    const [confirmClearCategory, setConfirmClearCategory] = React.useState<string | null>(null);

    // Writing Profile Form States
    const [isAddProfileOpen, setIsAddProfileOpen] = React.useState<boolean>(false);
    const [newProfileName, setNewProfileName] = React.useState<string>('');
    const [newProfilePrompt, setNewProfilePrompt] = React.useState<string>('');
    const [newProfileSamples, setNewProfileSamples] = React.useState<string>('');

    // Style Preference Form States
    const [isAddStyleOpen, setIsAddStyleOpen] = React.useState<boolean>(false);
    const [newStyleName, setNewStyleName] = React.useState<string>('');
    const [newStyleDesc, setNewStyleDesc] = React.useState<string>('');
    const [newStylePrompt, setNewStylePrompt] = React.useState<string>('');
    const [newStyleCategory, setNewStyleCategory] = React.useState<string>('visual_composition');
    const [newStyleIsDefault, setNewStyleIsDefault] = React.useState<boolean>(false);

    const loadMemoriesData = React.useCallback(async () => {
        const client = UserMemoriesClient.getInstance();
        const wsRoot = activeWorkspace?.path;
        try {
            const [mems, profilesData, styles, cfg] = await Promise.all([
                client.getMemories({ workspaceRoot: wsRoot }),
                client.getWritingProfiles(wsRoot),
                client.getStylePreferences({ workspaceRoot: wsRoot }),
                client.getConfig()
            ]);
            setMemories(mems);
            setWritingProfiles(profilesData.profiles);
            setActiveWritingProfileState(profilesData.activeProfile);
            setStylePreferences(styles);
            setMemoriesConfig(cfg);
        } catch (e) {
            console.warn('Failed to load user memories:', e);
        }
    }, [activeWorkspace?.path]);

    React.useEffect(() => {
        if (isOpen) {
            loadMemoriesData();
        }
    }, [isOpen, loadMemoriesData]);

    const handleToggleMemoryInjection = async () => {
        const newSetting = !memoriesConfig.enableMemoryInjection;
        setMemoriesConfig(prev => ({ ...prev, enableMemoryInjection: newSetting }));
        await UserMemoriesClient.getInstance().updateConfig({ enableMemoryInjection: newSetting });
    };

    const handleCreateMemory = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newMemoryKey.trim() || !newMemoryValue.trim()) {
            return;
        }
        const wsRoot = activeWorkspace?.path;
        const created = await UserMemoriesClient.getInstance().createMemory({
            category: newMemoryCategory,
            key: newMemoryKey.trim(),
            value: newMemoryValue.trim(),
            scope: newMemoryScope,
            workspaceRoot: wsRoot
        });
        if (created) {
            setMemories(prev => [created, ...prev]);
            setNewMemoryKey('');
            setNewMemoryValue('');
            setIsAddMemoryOpen(false);
            // Ensure newly added category is expanded
            setExpandedCategories(prev => ({ ...prev, [newMemoryCategory]: true }));
        }
    };

    const handleSaveEditMemory = async (id: string) => {
        if (!editingMemoryValue.trim()) {
            return;
        }
        const wsRoot = activeWorkspace?.path;
        const updated = await UserMemoriesClient.getInstance().updateMemory(id, {
            value: editingMemoryValue.trim(),
            workspaceRoot: wsRoot
        });
        if (updated) {
            setMemories(prev => prev.map(m => m.id === id ? updated : m));
            setEditingMemoryId(null);
            setEditingMemoryValue('');
        }
    };

    const handleDeleteMemory = async (id: string) => {
        const wsRoot = activeWorkspace?.path;
        const success = await UserMemoriesClient.getInstance().deleteMemory(id, wsRoot);
        if (success) {
            setMemories(prev => prev.filter(m => m.id !== id));
        }
    };

    const handleClearCategory = async (category: UserMemoryCategory) => {
        const wsRoot = activeWorkspace?.path;
        await UserMemoriesClient.getInstance().clearCategory(category, wsRoot);
        setMemories(prev => prev.filter(m => m.category !== category));
        setConfirmClearCategory(null);
    };

    const handleCreateWritingProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newProfileName.trim() || !newProfilePrompt.trim()) {
            return;
        }
        const wsRoot = activeWorkspace?.path;
        const samples = newProfileSamples
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean);

        const created = await UserMemoriesClient.getInstance().createWritingProfile({
            name: newProfileName.trim(),
            stylePrompt: newProfilePrompt.trim(),
            samples,
            isActive: writingProfiles.length === 0,
            scope: 'global',
            workspaceRoot: wsRoot
        });
        if (created) {
            setWritingProfiles(prev => [...prev, created]);
            if (created.isActive) {
                setActiveWritingProfileState(created);
            }
            setNewProfileName('');
            setNewProfilePrompt('');
            setNewProfileSamples('');
            setIsAddProfileOpen(false);
        }
    };

    const handleSetActiveWritingProfile = async (profileId: string) => {
        const wsRoot = activeWorkspace?.path;
        const success = await UserMemoriesClient.getInstance().setActiveWritingProfile(profileId, wsRoot);
        if (success) {
            setWritingProfiles(prev => prev.map(p => ({
                ...p,
                isActive: p.id === profileId
            })));
            const active = writingProfiles.find(p => p.id === profileId);
            if (active) {
                setActiveWritingProfileState({ ...active, isActive: true });
            }
        }
    };

    const handleDeleteWritingProfile = async (profileId: string) => {
        const wsRoot = activeWorkspace?.path;
        const success = await UserMemoriesClient.getInstance().deleteWritingProfile(profileId, wsRoot);
        if (success) {
            setWritingProfiles(prev => prev.filter(p => p.id !== profileId));
            if (activeWritingProfile?.id === profileId) {
                setActiveWritingProfileState(undefined);
            }
        }
    };

    const handleCreateStylePreference = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newStyleName.trim() || !newStylePrompt.trim()) {
            return;
        }
        const wsRoot = activeWorkspace?.path;
        const created = await UserMemoriesClient.getInstance().createStylePreference({
            name: newStyleName.trim(),
            description: newStyleDesc.trim() || undefined,
            stylePrompt: newStylePrompt.trim(),
            category: newStyleCategory,
            isDefault: newStyleIsDefault,
            scope: 'global',
            workspaceRoot: wsRoot
        });
        if (created) {
            setStylePreferences(prev => [...prev, created]);
            setNewStyleName('');
            setNewStyleDesc('');
            setNewStylePrompt('');
            setNewStyleIsDefault(false);
            setIsAddStyleOpen(false);
        }
    };

    const handleDeleteStylePreference = async (id: string) => {
        const wsRoot = activeWorkspace?.path;
        const success = await UserMemoriesClient.getInstance().deleteStylePreference(id, wsRoot);
        if (success) {
            setStylePreferences(prev => prev.filter(s => s.id !== id));
        }
    };

    const toggleCategoryAccordion = (category: string) => {
        setExpandedCategories(prev => ({
            ...prev,
            [category]: prev[category] === undefined ? false : !prev[category]
        }));
    };

    // Close on Escape key
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) {
        /* eslint-disable-next-line no-null/no-null */
        return null;
    }

    // Cursor Standard Navigation Items — NO ICONS, clean typography
    const sidebarNavSections: { id: StudioSettingsTab; label: string; isExternal?: boolean }[] = [
        { id: 'general', label: 'General' },
        { id: 'profile', label: 'Profile' },
        { id: 'appearance', label: 'Appearance' },
        { id: 'plan', label: 'Plan & Usage' },
        { id: 'agents', label: 'Agents' },
        { id: 'cloud-agents', label: 'Cloud Agents' },
        { id: 'git-prs', label: 'Git & PRs' },
        { id: 'worktrees', label: 'Worktrees' },
        { id: 'browser-network', label: 'Browser & Network' },
        { id: 'tab', label: 'Tab' },
        { id: 'code-intelligence', label: 'Code Intelligence' },
        { id: 'beta', label: 'Beta' },
        { id: 'docs', label: 'Docs', isExternal: true },
        { id: 'workspace', label: 'Workspace' },
        { id: 'skills', label: 'Skills' },
        { id: 'mcp', label: 'MCP' },
        { id: 'memories', label: 'Memories' },
        { id: 'shortcuts', label: 'Shortcuts' },
        { id: 'about', label: 'About' }
    ];

    const filteredNavSections = searchQuery.trim()
        ? sidebarNavSections.filter(s => s.label.toLowerCase().includes(searchQuery.toLowerCase()))
        : sidebarNavSections;

    return (
        <div className="sb-settings-modal-backdrop" onClick={onClose}>
            <div className="sb-cursor-settings-window" onClick={e => e.stopPropagation()}>
                {/* Left Sidebar Navigation */}
                <div className="sb-cursor-settings-sidebar">
                    {/* Top Back Action */}
                    <div className="sb-cursor-settings-back-row">
                        <button
                            type="button"
                            className="sb-cursor-settings-back-btn"
                            onClick={onClose}
                        >
                            <IconArrowLeft size={14} strokeWidth={2} />
                            <span>← Back</span>
                        </button>
                    </div>

                    {/* Search Settings Input */}
                    <div className="sb-cursor-settings-search-wrapper">
                        <IconSearch size={13} className="sb-cursor-settings-search-icon" />
                        <input
                            type="text"
                            className="sb-cursor-settings-search-input"
                            placeholder="Search Settings"
                            value={searchQuery}
                            onChange={e => setSearchQuery(e.target.value)}
                        />
                        {searchQuery && (
                            <button
                                type="button"
                                className="sb-search-clear-btn"
                                onClick={() => setSearchQuery('')}
                            >
                                <IconClose size={12} />
                            </button>
                        )}
                    </div>

                    {/* Navigation Items List — NO ICONS */}
                    <div className="sb-cursor-settings-nav-list">
                        {filteredNavSections.map(item => (
                            <button
                                key={item.id}
                                type="button"
                                className={`sb-cursor-settings-nav-item ${activeTab === item.id ? 'sb-cursor-nav-item-active' : ''}`}
                                onClick={() => setActiveTab(item.id)}
                            >
                                <span className="sb-cursor-nav-item-label">{item.label}</span>
                                {item.isExternal && (
                                    <IconExternalLink size={11} className="sb-cursor-external-indicator" />
                                )}
                            </button>
                        ))}
                    </div>

                    {/* Sidebar Bottom Footer Area */}
                    <div className="sb-cursor-settings-sidebar-footer">
                        <div className="sb-cursor-settings-user-row">
                            <div className="sb-cursor-user-avatar">
                                <span>EG</span>
                            </div>
                            <span className="sb-cursor-user-name">Eli Green</span>
                            <button
                                type="button"
                                className="sb-cursor-user-settings-btn"
                                onClick={() => setActiveTab('general')}
                                title="Settings"
                            >
                                <IconSettings size={13} />
                            </button>
                        </div>
                    </div>
                </div>

                {/* Right Main Stage Content Area */}
                <div className="sb-cursor-settings-main">
                    {/* Top Customize Relocation Banner */}
                    {!isCustomizeBannerDismissed && (
                        <div className="sb-cursor-customize-banner">
                            <div className="sb-cursor-banner-text">
                                <div className="sb-cursor-banner-title">
                                    Plugins, MCPs, Skills, and Rules have moved to Customize
                                </div>
                                <div className="sb-cursor-banner-subtitle">
                                    We've introduced a new home for all the ways to customize Cursor.
                                </div>
                            </div>
                            <div className="sb-cursor-banner-actions">
                                <button
                                    type="button"
                                    className="sb-cursor-banner-dismiss-btn"
                                    onClick={() => setIsCustomizeBannerDismissed(true)}
                                >
                                    Dismiss
                                </button>
                                <button
                                    type="button"
                                    className="sb-cursor-banner-open-btn"
                                    onClick={() => setActiveTab('workspace')}
                                >
                                    Open Customize →
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 1: GENERAL SETTINGS */}
                    {/* ============================================================ */}
                    {(activeTab === 'general' || activeTab === 'guide') && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">General</h2>

                            {/* Cursor Account */}
                            <div className="sb-cursor-group-card">
                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Cursor Account</div>
                                        <div className="sb-cursor-row-desc">Manage your account and billing</div>
                                    </div>
                                    <button
                                        type="button"
                                        className="sb-cursor-row-btn"
                                        onClick={() => setActiveTab('profile')}
                                    >
                                        <span>Open</span>
                                        <IconExternalLink size={12} />
                                    </button>
                                </div>
                            </div>

                            {/* Startup Group */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Startup</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Tips</div>
                                            <div className="sb-cursor-row-desc">Show rotating tips on the empty screen</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={tipsEnabled}
                                            className={`sb-cursor-toggle ${tipsEnabled ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setTipsEnabled(!tipsEnabled)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Window Restoration</div>
                                            <div className="sb-cursor-row-desc">Controls which windows Cursor restores on startup</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={windowRestoration}
                                            onChange={e => setWindowRestoration(e.target.value as any)}
                                        >
                                            <option value="default">Default</option>
                                            <option value="folders">Open Workspaces Only</option>
                                            <option value="empty">New Empty Window</option>
                                        </select>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Continue Interrupted Agents</div>
                                            <div className="sb-cursor-row-desc">Automatically resume working on agents and their subagents after a reload or restart</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={continueInterruptedAgents}
                                            className={`sb-cursor-toggle ${continueInterruptedAgents ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setContinueInterruptedAgents(!continueInterruptedAgents)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Notifications Group */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Notifications</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">System Notifications</div>
                                            <div className="sb-cursor-row-desc">Show system notifications when Agent completes or needs attention</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={systemNotifications}
                                            className={`sb-cursor-toggle ${systemNotifications ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setSystemNotifications(!systemNotifications)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Warning Notifications</div>
                                            <div className="sb-cursor-row-desc">Show notifications for less urgent issues</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={warningNotifications}
                                            className={`sb-cursor-toggle ${warningNotifications ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setWarningNotifications(!warningNotifications)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Menu Bar Icon</div>
                                            <div className="sb-cursor-row-desc">Show Cursor in menu bar</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={menuBarIcon}
                                            className={`sb-cursor-toggle ${menuBarIcon ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setMenuBarIcon(!menuBarIcon)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Completion Sound</div>
                                            <div className="sb-cursor-row-desc">Play a sound when agents finish or need attention</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={completionSound}
                                            className={`sb-cursor-toggle ${completionSound ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setCompletionSound(!completionSound)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Privacy Group */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Privacy</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="flex items-center gap-1.5 sb-cursor-row-title">
                                                <IconLock size={12} className="text-zinc-400" />
                                                <span>Privacy Mode</span>
                                            </div>
                                            <div className="sb-cursor-row-desc">
                                                Your code data will not be trained on or used to improve the product. Code may be stored to provide features such as Background Agent.
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className="sb-cursor-row-btn"
                                            onClick={() => setPrivacyMode(!privacyMode)}
                                        >
                                            <span>Configure</span>
                                            <span className="text-[10px]">▾</span>
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Workspace & Project Group */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Workspace &amp; Project</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Active Workspace Root</div>
                                            <div className="sb-cursor-row-desc font-mono text-[11px] text-zinc-300">
                                                {activeWorkspace?.path || (typeof process !== 'undefined' && process.cwd ? process.cwd() : '/Users/eligreen/dev/scratchbox-ide-master')}
                                            </div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            {onOpenFolder && (
                                                <button
                                                    type="button"
                                                    className="sb-cursor-row-btn"
                                                    onClick={onOpenFolder}
                                                    title="Open Local Folder"
                                                >
                                                    <span>Open Folder...</span>
                                                </button>
                                            )}
                                            {onOpenWorkspace && (
                                                <button
                                                    type="button"
                                                    className="sb-cursor-row-btn"
                                                    onClick={onOpenWorkspace}
                                                    title="Open Workspace"
                                                >
                                                    <span>Open Workspace...</span>
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Custom Project Rules</div>
                                            <div className="sb-cursor-row-desc">
                                                {workspaceRules.length > 0
                                                    ? `${workspaceRules.length} active rule${workspaceRules.length > 1 ? 's' : ''} loaded from .scratchbox/rules/ and .cursorrules`
                                                    : 'Manage custom project directives and system instructions'}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className="sb-cursor-row-btn"
                                            onClick={() => setActiveTab('workspace')}
                                        >
                                            <span>Manage Rules</span>
                                            <span className="text-[10px]">→</span>
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Log Out */}
                            <div className="pt-2 flex items-center gap-3">
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-sm"
                                    onClick={() => {
                                        setIsLoggedOut(true);
                                        setTimeout(() => setIsLoggedOut(false), 3000);
                                    }}
                                >
                                    {isLoggedOut ? '✓ Logged Out' : 'Log Out'}
                                </button>
                                {isLoggedOut && (
                                    <span className="text-xs text-zinc-400 font-medium">Session credentials reset.</span>
                                )}
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 2: PROFILE */}
                    {/* ============================================================ */}
                    {activeTab === 'profile' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Profile</h2>

                            <input
                                ref={avatarInputRef}
                                type="file"
                                accept="image/png, image/jpeg, image/webp"
                                style={{ display: 'none' }}
                                onChange={e => {
                                    const file = e.target.files?.[0];
                                    if (file) {
                                        const reader = new FileReader();
                                        reader.onload = ev => setCustomAvatar(ev.target?.result as string);
                                        reader.readAsDataURL(file);
                                    }
                                }}
                            />

                            <div className="sb-cursor-group-card">
                                {/* Email */}
                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Email</div>
                                    </div>
                                    <span className="text-xs text-zinc-300 font-mono">{profileEmail}</span>
                                </div>

                                {/* Profile Image */}
                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Profile Image</div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        {customAvatar ? (
                                            <img src={customAvatar} alt="Profile" className="w-9 h-9 rounded-full object-cover border border-blue-500/40" />
                                        ) : (
                                            <div className="w-9 h-9 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-200">
                                                CUSTOM
                                            </div>
                                        )}
                                        <button type="button" className="sb-cursor-row-btn" onClick={() => avatarInputRef.current?.click()}>
                                            Upload image
                                        </button>
                                        {customAvatar && (
                                            <button type="button" className="sb-cursor-row-btn" onClick={() => setCustomAvatar(null)}>
                                                Remove
                                            </button>
                                        )}
                                        <span className="text-[11px] text-zinc-500">PNG, JPEG, or...</span>
                                    </div>
                                </div>

                                {/* First Name */}
                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">First Name</div>
                                    </div>
                                    <input
                                        type="text"
                                        className="sb-cursor-text-input"
                                        value={firstName}
                                        onChange={e => setFirstName(e.target.value)}
                                        placeholder="First name"
                                    />
                                </div>

                                {/* Last Name */}
                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Last Name</div>
                                    </div>
                                    <input
                                        type="text"
                                        className="sb-cursor-text-input"
                                        value={lastName}
                                        onChange={e => setLastName(e.target.value)}
                                        placeholder="Last name"
                                    />
                                </div>
                            </div>

                            {/* Public Profile Card */}
                            <div className="sb-cursor-group-card">
                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Handle</div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <input
                                            type="text"
                                            className="sb-cursor-text-input"
                                            value={handle}
                                            onChange={e => setHandle(e.target.value)}
                                            placeholder="username"
                                        />
                                        <button
                                            type="button"
                                            className="sb-cursor-row-btn"
                                            onClick={() => {
                                                setHandleClaimedFeedback(`✓ Claimed @${handle}`);
                                                setTimeout(() => setHandleClaimedFeedback(null), 3000);
                                            }}
                                        >
                                            {handleClaimedFeedback || 'Claim handle'}
                                        </button>
                                    </div>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Link 1</div>
                                    </div>
                                    <div className="flex flex-col items-end gap-1.5">
                                        <input
                                            type="text"
                                            className="sb-cursor-text-input"
                                            value={link1}
                                            onChange={e => setLink1(e.target.value)}
                                            placeholder="x.com/handle"
                                        />
                                        <button type="button" className="sb-btn sb-btn-ghost sb-btn-xs text-blue-400">
                                            + Add link
                                        </button>
                                    </div>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Public Profile</div>
                                        <div className="sb-cursor-row-desc">
                                            When enabled, your cursor.com profile page is visible to anyone with the link.
                                        </div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={publicProfile}
                                        className={`sb-cursor-toggle ${publicProfile ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setPublicProfile(!publicProfile)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>
                            </div>

                            <div className="flex justify-end pt-2">
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-primary sb-btn-sm"
                                    onClick={() => {
                                        setProfileSavedFeedback(true);
                                        setTimeout(() => setProfileSavedFeedback(false), 2500);
                                    }}
                                >
                                    {profileSavedFeedback ? '✓ Saved' : 'Save'}
                                </button>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 3: APPEARANCE */}
                    {/* ============================================================ */}
                    {activeTab === 'appearance' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Appearance</h2>

                            {/* Theme */}
                            <div className="sb-cursor-group-card">
                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Theme</div>
                                        <div className="sb-cursor-row-desc">Choose between light, dark, or high contrast themes</div>
                                    </div>
                                    <select
                                        className="sb-cursor-select-dropdown"
                                        value={selectedTheme}
                                        onChange={e => setSelectedTheme(e.target.value as any)}
                                    >
                                        <option value="system">System ▾</option>
                                        <option value="dark">Dark</option>
                                        <option value="light">Light</option>
                                        <option value="high-contrast">High Contrast</option>
                                    </select>
                                </div>
                            </div>

                            {/* Agent Conversations */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Agent Conversations</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Tool Call Density</div>
                                            <div className="sb-cursor-row-desc">Adjust how much detail is shown for tool calls</div>
                                        </div>
                                        <div className="flex flex-col items-end gap-1">
                                            <input
                                                type="range"
                                                min="0"
                                                max="100"
                                                className="sb-cursor-slider"
                                                value={toolCallDensity}
                                                onChange={e => setToolCallDensity(Number(e.target.value))}
                                            />
                                            <div className="flex justify-between w-full text-[10px] text-zinc-500">
                                                <span>Compact</span>
                                                <span>Detailed</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Code Block Word Wrap</div>
                                            <div className="sb-cursor-row-desc">Wrap long lines in Agent conversation code blocks</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={codeBlockWordWrap}
                                            className={`sb-cursor-toggle ${codeBlockWordWrap ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setCodeBlockWordWrap(!codeBlockWordWrap)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Themed Diff Backgrounds</div>
                                            <div className="sb-cursor-row-desc">Use themed background colors for inline code diffs</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={themedDiffBackgrounds}
                                            className={`sb-cursor-toggle ${themedDiffBackgrounds ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setThemedDiffBackgrounds(!themedDiffBackgrounds)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Colors */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Colors</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Hue</div>
                                            <div className="sb-cursor-row-desc">Choose a tint color</div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="range"
                                                min="0"
                                                max="360"
                                                className="sb-cursor-slider"
                                                value={colorHue}
                                                onChange={e => setColorHue(Number(e.target.value))}
                                            />
                                            <span className="w-4 h-4 rounded-full border border-zinc-700" style={{ background: `hsl(${colorHue}, 80%, 50%)` }} />
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Intensity</div>
                                            <div className="sb-cursor-row-desc">Control how strongly the tint is applied</div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="range"
                                                min="0"
                                                max="100"
                                                className="sb-cursor-slider"
                                                value={colorIntensity}
                                                onChange={e => setColorIntensity(Number(e.target.value))}
                                            />
                                            <span className="text-xs text-zinc-400 font-mono w-8 text-right">{colorIntensity}%</span>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Reduce Transparency</div>
                                            <div className="sb-cursor-row-desc">Replace translucent surfaces with opaque backgrounds</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={reduceTransparency}
                                            className={`sb-cursor-toggle ${reduceTransparency ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setReduceTransparency(!reduceTransparency)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Typography */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Typography</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">UI Font Size</div>
                                            <div className="sb-cursor-row-desc">Font size for the Cursor user interface</div>
                                        </div>
                                        <div className="sb-cursor-stepper">
                                            <button type="button" className="sb-stepper-btn" onClick={() => setUiFontSize(Math.max(10, uiFontSize - 1))}>−</button>
                                            <span className="sb-stepper-val">{uiFontSize}</span>
                                            <button type="button" className="sb-stepper-btn" onClick={() => setUiFontSize(Math.min(24, uiFontSize + 1))}>+</button>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Code Font Size</div>
                                            <div className="sb-cursor-row-desc">Font size for code editors and diffs</div>
                                        </div>
                                        <div className="sb-cursor-stepper">
                                            <button type="button" className="sb-stepper-btn" onClick={() => setCodeFontSize(Math.max(10, codeFontSize - 1))}>−</button>
                                            <span className="sb-stepper-val">{codeFontSize}</span>
                                            <button type="button" className="sb-stepper-btn" onClick={() => setCodeFontSize(Math.min(24, codeFontSize + 1))}>+</button>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">UI Font Family</div>
                                            <div className="sb-cursor-row-desc">Override the Cursor user interface typeface</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={uiFontFamily}
                                            onChange={e => setUiFontFamily(e.target.value)}
                                        >
                                            <option value="system">System font ▾</option>
                                            <option value="sf-pro">SF Pro</option>
                                            <option value="inter">Inter</option>
                                            <option value="geist">Geist</option>
                                        </select>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Code Font Family</div>
                                            <div className="sb-cursor-row-desc">Override the font for code editors and diffs</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={codeFontFamily}
                                            onChange={e => setCodeFontFamily(e.target.value)}
                                        >
                                            <option value="system-mono">System monospace ▾</option>
                                            <option value="menlo">Menlo</option>
                                            <option value="fira-code">Fira Code</option>
                                            <option value="jetbrains-mono">JetBrains Mono</option>
                                        </select>
                                    </div>

                                    {/* Live Code Diff Preview Box */}
                                    <div className="p-3 bg-zinc-950/60 border-t border-zinc-800/80">
                                        <div className="sb-cursor-diff-preview" style={{ fontSize: `${codeFontSize}px` }}>
                                            <div className="sb-diff-line sb-diff-del">
                                                <span className="sb-diff-num">1</span>
                                                <span className="sb-diff-content">return a + b;</span>
                                            </div>
                                            <div className="sb-diff-line sb-diff-add">
                                                <span className="sb-diff-num">1</span>
                                                <span className="sb-diff-content">const result = a + b;</span>
                                            </div>
                                            <div className="sb-diff-line sb-diff-add">
                                                <span className="sb-diff-num">2</span>
                                                <span className="sb-diff-content">return result;</span>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Font Smoothing</div>
                                            <div className="sb-cursor-row-desc">Use native macOS font anti-aliasing</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={fontSmoothing}
                                            className={`sb-cursor-toggle ${fontSmoothing ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setFontSmoothing(!fontSmoothing)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* High Contrast */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">High Contrast</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Follow System High Contrast</div>
                                            <div className="sb-cursor-row-desc">Switch to a high contrast theme when your OS is in a high contrast mode</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={followSystemHighContrast}
                                            className={`sb-cursor-toggle ${followSystemHighContrast ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setFollowSystemHighContrast(!followSystemHighContrast)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Motion */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Motion</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Reduce Motion</div>
                                            <div className="sb-cursor-row-desc">Minimize interface animations. System follows your OS preference.</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={reduceMotionSetting}
                                            onChange={e => setReduceMotionSetting(e.target.value)}
                                        >
                                            <option value="system">System ▾</option>
                                            <option value="always">Always Reduce</option>
                                            <option value="never">Full Motion</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 4: PLAN & USAGE */}
                    {/* ============================================================ */}
                    {activeTab === 'plan' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <div className="flex items-center justify-between mb-1">
                                <h2 className="sb-cursor-content-title">Plan &amp; Usage</h2>
                                <span className="sb-badge-unified sb-badge-emerald font-semibold text-[11px] px-2.5 py-1">
                                    ● 100% Free · Limited Time Promo
                                </span>
                            </div>

                            {/* Dual Plan Cards */}
                            <div className="grid grid-cols-2 gap-4">
                                <div className="sb-cursor-plan-card sb-plan-active-promo-card">
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="sb-plan-card-tag text-emerald-400 font-semibold">CURRENT PLAN · LIMITED TIME PROMO</span>
                                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-bold border border-emerald-500/20">
                                            Free Active
                                        </span>
                                    </div>
                                    <div className="sb-plan-price-title flex items-baseline gap-2">
                                        <span>Pro</span>
                                        <span className="text-sm font-bold text-emerald-400">$0/mo</span>
                                        <span className="text-xs font-normal text-zinc-500 line-through">$20/mo</span>
                                    </div>
                                    <div className="sb-plan-desc">
                                        Enjoy complimentary full Pro features during our limited-time launch promotion.
                                    </div>
                                    <button
                                        type="button"
                                        className="sb-cursor-row-btn mt-3 text-emerald-400 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20"
                                        onClick={() => {
                                            setPlanUpgradeNotice('Your Pro plan is active and complimentary.');
                                            setTimeout(() => setPlanUpgradeNotice(null), 3000);
                                        }}
                                    >
                                        <span>✓ Active (Complimentary)</span>
                                    </button>
                                </div>

                                <div className="sb-cursor-plan-card sb-plan-upgrade-card">
                                    <div className="flex items-center justify-between mb-1">
                                        <span className="sb-plan-card-tag text-blue-400">UPGRADE AVAILABLE</span>
                                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-bold border border-blue-500/20">
                                            Included
                                        </span>
                                    </div>
                                    <div className="sb-plan-price-title flex items-baseline gap-2">
                                        <span>Pro+</span>
                                        <span className="text-sm font-bold text-blue-400">$0/mo</span>
                                        <span className="text-xs font-normal text-zinc-500 line-through">$60/mo</span>
                                    </div>
                                    <div className="sb-plan-desc">
                                        Unlock 3x more usage on Agent &amp; high-reasoning models — all free during preview.
                                    </div>
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-primary sb-btn-sm mt-3"
                                        onClick={() => {
                                            setPlanUpgradeNotice('✓ Pro+ features and extended limits unlocked.');
                                            setTimeout(() => setPlanUpgradeNotice(null), 3500);
                                        }}
                                    >
                                        Upgrade (Free Promo)
                                    </button>
                                </div>
                            </div>

                            {planUpgradeNotice && (
                                <div className="p-3 rounded-xl bg-emerald-950/20 border border-emerald-800/40 text-xs text-emerald-300 font-medium animate-fadeIn">
                                    {planUpgradeNotice}
                                </div>
                            )}

                            {/* Included in Pro */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Included in Pro</div>
                                <div className="sb-cursor-group-card p-4 space-y-4">
                                    <div className="sb-usage-group-row">
                                        <div className="flex justify-between items-center text-xs mb-1.5">
                                            <span className="sb-usage-metric-title font-medium text-zinc-200">Google Reasoning Models</span>
                                            <span className="sb-usage-metric-percent text-emerald-400 font-mono font-semibold">0% used · Unlimited Free</span>
                                        </div>
                                        <div className="text-[11px] text-zinc-500 mb-2">High-reasoning Gemini models and autonomous subagents</div>
                                        <div className="sb-cursor-usage-bar">
                                            <div className="sb-usage-fill" style={{ width: '0%' }} />
                                        </div>
                                        <div className="text-[10px] text-zinc-500 mt-1.5">Unlimited complimentary usage active during the promotional period.</div>
                                    </div>

                                    <div className="pt-3 border-t border-zinc-800/80 sb-usage-group-row">
                                        <div className="flex justify-between items-center text-xs mb-1.5">
                                            <span className="sb-usage-metric-title font-medium text-zinc-200">Background Agent Sessions</span>
                                            <span className="sb-usage-metric-percent text-emerald-400 font-mono font-semibold">0% used · Unlimited Free</span>
                                        </div>
                                        <div className="text-[11px] text-zinc-500 mb-2">Multi-step TDD verification and autonomous tool pipelines</div>
                                        <div className="sb-cursor-usage-bar">
                                            <div className="sb-usage-fill" style={{ width: '0%' }} />
                                        </div>
                                        <div className="text-[10px] text-zinc-500 mt-1.5">All background agent sessions are 100% free during the promotion.</div>
                                    </div>
                                </div>
                            </div>

                            {/* On-Demand Usage */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">On-Demand Usage</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">On-Demand</div>
                                            <div className="sb-cursor-row-desc">Usage past limits is free of charge during the promotion.</div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-xs text-zinc-500 line-through">$43.93</span>
                                            <span className="font-mono text-xs text-emerald-400 font-bold">$0.00 (Free Promo)</span>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Monthly Limit</div>
                                            <div className="sb-cursor-row-desc">Complimentary unlimited usage active.</div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <select
                                                className="sb-cursor-select-dropdown"
                                                value={monthlySpendLimit}
                                                onChange={e => setMonthlySpendLimit(e.target.value)}
                                            >
                                                <option value="unlimited">Unlimited (Free Promo) ▾</option>
                                                <option value="50">$50 / mo</option>
                                                <option value="100">$100 / mo</option>
                                                <option value="200">$200 / mo</option>
                                            </select>
                                            <button
                                                type="button"
                                                className="sb-cursor-row-btn"
                                                onClick={() => {
                                                    setSpendLimitSaved(true);
                                                    setTimeout(() => setSpendLimitSaved(false), 2500);
                                                }}
                                            >
                                                {spendLimitSaved ? '✓ Saved' : 'Save'}
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 5: AGENTS */}
                    {/* ============================================================ */}
                    {activeTab === 'agents' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Agents</h2>

                            {/* Conversation */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Conversation</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Submit with ⌘ + Enter</div>
                                            <div className="sb-cursor-row-desc">⌘Enter submits chat, Enter inserts a newline, and primary actions move to ⌥⇧Enter</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={submitWithCmdEnter}
                                            className={`sb-cursor-toggle ${submitWithCmdEnter ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setSubmitWithCmdEnter(!submitWithCmdEnter)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Default Environment</div>
                                            <div className="sb-cursor-row-desc">Where new agents start by default</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={defaultEnvironment}
                                            onChange={e => setDefaultEnvironment(e.target.value)}
                                        >
                                            <option value="last-used">Last Used ▾</option>
                                            <option value="local">Local Machine</option>
                                            <option value="cloud">Isolated Worktree</option>
                                        </select>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Default Model</div>
                                            <div className="sb-cursor-row-desc">What model new agents use by default</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={defaultAgentModel}
                                            onChange={e => setDefaultAgentModel(e.target.value)}
                                        >
                                            <option value="cursor-default">Cursor Default ▾</option>
                                            <option value="high-reasoning">High Reasoning Engine</option>
                                            <option value="fast">Fast Intelligence</option>
                                        </select>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">New Messages</div>
                                            <div className="sb-cursor-row-desc">Choose the default behavior of messages sent while Agent is working</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={newMessagesBehavior}
                                            onChange={e => setNewMessagesBehavior(e.target.value)}
                                        >
                                            <option value="steer">Steer ▾</option>
                                            <option value="queue">Queue</option>
                                            <option value="interrupt">Interrupt</option>
                                        </select>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Manually Sent Messages from Queue</div>
                                            <div className="sb-cursor-row-desc">Choose the default behavior of messages sent from the queue</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={manualQueueBehavior}
                                            onChange={e => setManualQueueBehavior(e.target.value)}
                                        >
                                            <option value="interrupt">Interrupt ▾</option>
                                            <option value="steer">Steer</option>
                                        </select>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Usage Summary</div>
                                            <div className="sb-cursor-row-desc">When to show the usage summary at the bottom of the chat pane</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={usageSummaryBehavior}
                                            onChange={e => setUsageSummaryBehavior(e.target.value)}
                                        >
                                            <option value="auto">Auto ▾</option>
                                            <option value="always">Always</option>
                                            <option value="never">Never</option>
                                        </select>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Agent Autocomplete</div>
                                            <div className="sb-cursor-row-desc">Contextual suggestions while prompting Agent</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={agentAutocomplete}
                                            className={`sb-cursor-toggle ${agentAutocomplete ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setAgentAutocomplete(!agentAutocomplete)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Auto-Approve Mode Transitions</div>
                                            <div className="sb-cursor-row-desc">Allow agent to switch to modes like Plan or Debug without asking. When off, Cursor asks first, but skips if unanswered within 15 seconds.</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={autoApproveTransitions}
                                            className={`sb-cursor-toggle ${autoApproveTransitions ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setAutoApproveTransitions(!autoApproveTransitions)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Voice Submit Keywords</div>
                                            <div className="sb-cursor-row-desc">Custom words that submit a voice prompt. Spaces and punctuation are ignored.</div>
                                            <div className="mt-2">
                                                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-800 border border-zinc-700 text-xs text-zinc-300 font-mono">
                                                    submit <span className="cursor-pointer text-zinc-500 hover:text-zinc-300">×</span>
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Third-Party Imports */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Third-Party Imports</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Include Third-Party Plugins, Skills, and Other Configs</div>
                                            <div className="sb-cursor-row-desc">Automatically import agent configs from other tools</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={includeThirdPartyConfigs}
                                            className={`sb-cursor-toggle ${includeThirdPartyConfigs ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setIncludeThirdPartyConfigs(!includeThirdPartyConfigs)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Import Claude Code Conversations</div>
                                            <div className="sb-cursor-row-desc">Sync chats and continue them in Cursor</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={importClaudeCode}
                                            className={`sb-cursor-toggle ${importClaudeCode ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setImportClaudeCode(!importClaudeCode)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Remote Control */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Remote Control</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Remote Control</div>
                                            <div className="sb-cursor-row-desc">Allow agents on this machine to be controlled remotely from mobile</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={remoteControlEnabled}
                                            className={`sb-cursor-toggle ${remoteControlEnabled ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setRemoteControlEnabled(!remoteControlEnabled)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Keep This Computer Awake</div>
                                            <div className="sb-cursor-row-desc">Prevent sleep when this computer is plugged in and Remote Control is enabled</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={keepComputerAwake}
                                            className={`sb-cursor-toggle ${keepComputerAwake ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setKeepComputerAwake(!keepComputerAwake)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Context and Tools */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Context and Tools</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Web Search Tool</div>
                                            <div className="sb-cursor-row-desc">Allow Agent to search the web for relevant information</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={webSearchToolEnabled}
                                            className={`sb-cursor-toggle ${webSearchToolEnabled ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setWebSearchToolEnabled(!webSearchToolEnabled)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Auto-Accept Web Search</div>
                                            <div className="sb-cursor-row-desc">Enabled by Run Everything Auto-Run Mode: Agent bypasses approval prompts for tools including Web Search.</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={autoAcceptWebSearch}
                                            className={`sb-cursor-toggle ${autoAcceptWebSearch ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setAutoAcceptWebSearch(!autoAcceptWebSearch)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Web Fetch Tool</div>
                                            <div className="sb-cursor-row-desc">Allow Agent to fetch content from URLs</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={webFetchToolEnabled}
                                            className={`sb-cursor-toggle ${webFetchToolEnabled ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setWebFetchToolEnabled(!webFetchToolEnabled)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Wait for MCP Authentication</div>
                                            <div className="sb-cursor-row-desc">Wait indefinitely to authenticate when prompted. When off, skip authentication prompts after 30 seconds.</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={waitForMcpAuth}
                                            className={`sb-cursor-toggle ${waitForMcpAuth ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setWaitForMcpAuth(!waitForMcpAuth)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Execution and Approvals */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Execution and Approvals</div>
                                <div className="sb-cursor-group-card p-4 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="sb-cursor-row-title">Run Mode</div>
                                            <div className="sb-cursor-row-desc">Choose how Agents run tools like command execution, MCP, and file writes.</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={runModeSetting}
                                            onChange={e => setRunModeSetting(e.target.value)}
                                        >
                                            <option value="unsandboxed">Run Everything (Unsandboxed) ▾</option>
                                            <option value="guarded">Guarded Confirmation</option>
                                            <option value="strict">Strict Sandboxed</option>
                                        </select>
                                    </div>
                                    <div className="text-[11px] text-zinc-500">
                                        All commands will run without approval, classification or sandboxing.
                                    </div>
                                    <a href="#learn-more" className="text-[11px] text-blue-400 hover:underline block pt-1">
                                        Learn more
                                    </a>
                                </div>
                            </div>

                            {/* Terminal and Editing */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Terminal and Editing</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Legacy Terminal Tool</div>
                                            <div className="sb-cursor-row-desc">Use the legacy terminal tool in agent mode, for use on systems with unsupported shell configurations</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={legacyTerminalTool}
                                            className={`sb-cursor-toggle ${legacyTerminalTool ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setLegacyTerminalTool(!legacyTerminalTool)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Auto-Parse Links</div>
                                            <div className="sb-cursor-row-desc">Automatically parse links when pasted into Quick Edit (⌘K) input</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={autoParseLinks}
                                            className={`sb-cursor-toggle ${autoParseLinks ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setAutoParseLinks(!autoParseLinks)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB: CLOUD AGENTS */}
                    {/* ============================================================ */}
                    {activeTab === 'cloud-agents' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Cloud Agents</h2>

                            {/* Group Card 1: Active Google Cloud Agent Target */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Active Google Cloud Agent Target</div>
                                <div className="sb-cursor-group-card p-4 space-y-4">
                                    <div className="flex items-center justify-between">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Managed Agent Type</div>
                                            <div className="sb-cursor-row-desc">
                                                Managed agents run in safe, remote sandboxed Linux containers hosted on Google Cloud.
                                            </div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={cloudAgentTarget}
                                            onChange={e => setCloudAgentTarget(e.target.value)}
                                        >
                                            <option value="antigravity-preview-05-2026">antigravity-preview-05-2026 (Recommended)</option>
                                            <option value="deep-research-preview-04-2026">deep-research-preview-04-2026</option>
                                            <option value="deep-research-max-preview-04-2026">deep-research-max-preview-04-2026</option>
                                            <option value="code-reviewer">code-reviewer</option>
                                        </select>
                                    </div>
                                    <div className="p-3 rounded-xl bg-zinc-900/50 border border-zinc-800 text-[11px] text-zinc-400">
                                        {cloudAgentTarget === 'antigravity-preview-05-2026' && (
                                            <span><strong>Active:</strong> &quot;antigravity-preview-05-2026&quot; runs high-fidelity autonomous agent loops with built-in sandbox bash execution.</span>
                                        )}
                                        {cloudAgentTarget === 'deep-research-preview-04-2026' && (
                                            <span><strong>Active:</strong> &quot;deep-research-preview-04-2026&quot; recursively queries documents and search engines to construct deep blueprints.</span>
                                        )}
                                        {cloudAgentTarget === 'deep-research-max-preview-04-2026' && (
                                            <span><strong>Active:</strong> &quot;deep-research-max-preview-04-2026&quot; allocates maximum thinking tokens to explore extensive codebases.</span>
                                        )}
                                        {cloudAgentTarget === 'code-reviewer' && (
                                            <span><strong>Active:</strong> Custom project reviewer agent. Inspects modifications and provides Apple HIG feedback.</span>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Group Card 2: Sandbox Resource Allocations */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Sandbox Resource Allocations</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">CPU Cores Allocation</div>
                                            <div className="sb-cursor-row-desc">Configure the virtual CPU cores dedicated to the remote container sandbox.</div>
                                        </div>
                                        <div className="sb-cursor-stepper">
                                            <button type="button" className="sb-stepper-btn" onClick={() => setCloudCpuCores(Math.max(1, cloudCpuCores - 1))}>−</button>
                                            <span className="sb-stepper-val">{cloudCpuCores}</span>
                                            <button type="button" className="sb-stepper-btn" onClick={() => setCloudCpuCores(Math.min(8, cloudCpuCores + 1))}>+</button>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">RAM / Memory Allocation</div>
                                            <div className="sb-cursor-row-desc">Slide to adjust virtual memory bounds. Higher values prevent OOM failures during heavy compilation.</div>
                                        </div>
                                        <div className="flex items-center gap-3">
                                            <input
                                                type="range"
                                                min="2"
                                                max="16"
                                                step="2"
                                                className="sb-cursor-slider"
                                                value={cloudRamGb}
                                                onChange={e => setCloudRamGb(Number(e.target.value))}
                                            />
                                            <span className="text-xs text-zinc-300 font-mono font-bold w-12 text-right">{cloudRamGb} GB</span>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Execution Timeout Limit</div>
                                            <div className="sb-cursor-row-desc">Maximum execution budget in seconds for a single cloud agent milestone run.</div>
                                        </div>
                                        <div className="sb-cursor-stepper">
                                            <button type="button" className="sb-stepper-btn" onClick={() => setCloudTimeoutSeconds(Math.max(60, cloudTimeoutSeconds - 60))}>−</button>
                                            <span className="sb-stepper-val" style={{ width: '48px', textAlign: 'center' }}>{cloudTimeoutSeconds}s</span>
                                            <button type="button" className="sb-stepper-btn" onClick={() => setCloudTimeoutSeconds(Math.min(3600, cloudTimeoutSeconds + 60))}>+</button>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Group Card 3: Cloud Agent Capabilities (Google Built-In Tools) */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Cloud Agent Capabilities (Google Built-In Tools)</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Google Search Grounding</div>
                                            <div className="sb-cursor-row-desc">Enables real-time web retrieval during generations for up-to-date documentation and verified citations.</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={googleSearchGrounding}
                                            className={`sb-cursor-toggle ${googleSearchGrounding ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => handleToggleGoogleSearchGrounding(!googleSearchGrounding)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Python Code Execution</div>
                                            <div className="sb-cursor-row-desc">Allows autonomous execution and testing inside Google&apos;s hosted sandboxes.</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={pythonCodeExecution}
                                            className={`sb-cursor-toggle ${pythonCodeExecution ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setPythonCodeExecution(!pythonCodeExecution)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">GCP Project ID Mapping</div>
                                            <div className="sb-cursor-row-desc">Toggles routing of cloud operations using active GCP service credentials.</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={gcpProjectIdMapping}
                                            className={`sb-cursor-toggle ${gcpProjectIdMapping ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setGcpProjectIdMapping(!gcpProjectIdMapping)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Bi-directional Filesystem Sync</div>
                                            <div className="sb-cursor-row-desc">Persists sandboxed container edits back to your local environment workspace.</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={bidirectionalFilesystemSync}
                                            className={`sb-cursor-toggle ${bidirectionalFilesystemSync ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setBidirectionalFilesystemSync(!bidirectionalFilesystemSync)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 6: MODELS */}
                    {/* ============================================================ */}
                    {activeTab === 'models' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Models &amp; AI Engine</h2>

                            <div className="sb-cursor-group-card space-y-4 p-4">
                                <div className="sb-pref-info">
                                    <h4 className="sb-pref-title">Google Reasoning Intelligence</h4>
                                    <p className="sb-pref-desc">
                                        High-performance multimodal models power multi-step agent planning, TDD verification, and canvas synthesis.
                                    </p>
                                </div>

                                <div className="grid grid-cols-2 gap-4">
                                    <div>
                                        <label className="sb-form-label">Preferred AI Reasoning Engine</label>
                                        <select
                                            className="sb-form-select"
                                            value={workspaceSettings.defaultModel || 'gemini-3.7-flash'}
                                            onChange={e => setWorkspaceSettings({ ...workspaceSettings, defaultModel: e.target.value })}
                                        >
                                            <option value="gemini-3.7-flash">High Reasoning Engine (Autonomous &amp; Deep Thought)</option>
                                            <option value="gemini-2.5-pro">Deep Architecture Analysis (Comprehensive Context)</option>
                                            <option value="gemini-2.5-flash">Fast Intelligence (Instant Code &amp; Generation)</option>
                                        </select>
                                    </div>

                                    <div>
                                        <label className="sb-form-label">Thinking Budget (Tokens)</label>
                                        <select
                                            className="sb-form-select"
                                            value={workspaceSettings.thinkingBudget || 1024}
                                            onChange={e => setWorkspaceSettings({ ...workspaceSettings, thinkingBudget: Number(e.target.value) })}
                                        >
                                            <option value={512}>512 tokens (Fast)</option>
                                            <option value={1024}>1024 tokens (Standard Balanced)</option>
                                            <option value={2048}>2048 tokens (Deep Spec &amp; Logic)</option>
                                            <option value={4096}>4096 tokens (Exhaustive Architecture)</option>
                                        </select>
                                    </div>
                                </div>

                                <div>
                                    <label className="sb-form-label">Custom Project Instructions (System Directive)</label>
                                    <textarea
                                        className="sb-form-textarea"
                                        rows={3}
                                        value={workspaceSettings.customPromptInstructions || ''}
                                        onChange={e => setWorkspaceSettings({ ...workspaceSettings, customPromptInstructions: e.target.value })}
                                        placeholder="e.g. Adhere to Apple Human Interface Guidelines and 8-pt spacing tokens across all UI components."
                                    />
                                </div>

                                <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60">
                                    <div className="text-xs text-zinc-400">
                                        {saveFeedback && <span className="text-emerald-400 font-medium">✓ {saveFeedback}</span>}
                                    </div>
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-primary sb-btn-sm"
                                        onClick={handleSaveWorkspaceSettings}
                                        disabled={isSavingWorkspace}
                                    >
                                        {isSavingWorkspace ? 'Saving...' : 'Save Config'}
                                    </button>
                                </div>
                            </div>

                            {/* Credentials & Authentication */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Authentication &amp; API Key</div>
                                <div className="sb-cursor-group-card p-4 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="sb-pref-info">
                                            <h4 className="sb-pref-title">Google Cloud Service Account / API Key</h4>
                                            <p className="sb-pref-desc">
                                                Saved securely to <code>~/.scratchbox-ide/service-account.json</code> for Vertex AI &amp; model execution.
                                            </p>
                                        </div>
                                        {geminiStatus && (
                                            <span className={`sb-badge-unified ${geminiStatus.connected ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                                                {geminiStatus.connected ? '● Authenticated' : '○ Not Connected'}
                                            </span>
                                        )}
                                    </div>

                                    {geminiStatus && geminiStatus.connected && (
                                        <div className="p-3 rounded-xl bg-emerald-950/20 border border-emerald-800/40 text-xs space-y-1">
                                            <div className="flex items-center gap-2 text-emerald-300 font-medium">
                                                <span>Project: {geminiStatus.projectId || 'Default'}</span>
                                                <span>•</span>
                                                <span>Account: {geminiStatus.serviceAccount || 'Google Cloud IAM'}</span>
                                            </div>
                                            <div className="text-zinc-400 text-[11px]">
                                                Engine: High Reasoning AI • Subagents: Autonomous Workers Active
                                            </div>
                                        </div>
                                    )}

                                    <div>
                                        <label className="sb-form-label">Paste Service Account JSON or API Key</label>
                                        <textarea
                                            className="sb-form-textarea font-mono text-[11px]"
                                            rows={3}
                                            value={credentialsInput}
                                            onChange={e => setCredentialsInput(e.target.value)}
                                            placeholder='Paste { "type": "service_account", "project_id": "...", "private_key": "..." } or AIzaSy...'
                                        />
                                    </div>

                                    <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60">
                                        <div className="text-xs">
                                            {credsFeedback && (
                                                <span className={credsFeedback.error ? 'text-rose-400 font-medium' : 'text-emerald-400 font-medium'}>
                                                    {credsFeedback.error ? '✕ ' : '✓ '}{credsFeedback.message}
                                                </span>
                                            )}
                                        </div>
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-primary sb-btn-sm"
                                            onClick={handleSaveCredentials}
                                            disabled={isSavingCreds || !credentialsInput.trim()}
                                        >
                                            {isSavingCreds ? 'Validating...' : 'Save & Authenticate'}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Google Maps Platform Configuration */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Google Maps Platform &amp; Geospatial Intelligence</div>
                                <div className="sb-cursor-group-card p-4 space-y-3">
                                    <div className="flex items-center justify-between">
                                        <div className="sb-pref-info">
                                            <h4 className="sb-pref-title flex items-center gap-1.5">
                                                <span>🗺️</span>
                                                <span>Google Maps API Key</span>
                                            </h4>
                                            <p className="sb-pref-desc">
                                                Powers Geocoding, Google Static Maps, Photorealistic 3D Tiles, Places, and dynamic embedded map rendering.
                                            </p>
                                        </div>
                                        <span className={`sb-badge-unified ${mapsState.status === 'ready' ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                                            {mapsState.status === 'ready' ? '● Key Active' : '○ Missing Key (Fallback Mode)'}
                                        </span>
                                    </div>

                                    <div>
                                        <label className="sb-form-label">Google Maps API Key (AIzaSy...)</label>
                                        <input
                                            type="password"
                                            className="sb-form-input font-mono text-xs"
                                            value={mapsKeyInput}
                                            onChange={e => setMapsKeyInput(e.target.value)}
                                            placeholder="AIzaSy..."
                                        />
                                    </div>

                                    <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60">
                                        <div className="text-xs">
                                            {mapsFeedback && (
                                                <span className={mapsFeedback.error ? 'text-rose-400 font-medium' : 'text-emerald-400 font-medium'}>
                                                    {mapsFeedback.error ? '✕ ' : '✓ '}{mapsFeedback.message}
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-secondary sb-btn-sm"
                                                onClick={handleTestMapsKey}
                                                disabled={isTestingMapsKey}
                                            >
                                                {isTestingMapsKey ? 'Testing...' : 'Test Geocode'}
                                            </button>
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-primary sb-btn-sm"
                                                onClick={handleSaveMapsKey}
                                            >
                                                Save Key
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 7: GIT & PRS */}
                    {/* ============================================================ */}
                    {activeTab === 'git-prs' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Git &amp; PRs</h2>

                            {/* Pull Requests */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Pull Requests</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Review Provider</div>
                                            <div className="sb-cursor-row-desc">Choose Origin (cursor.com/codebase), GitHub, or Graphite for pull request links on web and desktop</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={reviewProvider}
                                            onChange={e => setReviewProvider(e.target.value)}
                                        >
                                            <option value="github">GitHub ▾</option>
                                            <option value="origin">Origin</option>
                                            <option value="graphite">Graphite</option>
                                        </select>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">PR Link Destination</div>
                                            <div className="sb-cursor-row-desc">Open pull request links inside Cursor or in the default browser</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={prLinkDestination}
                                            onChange={e => setPrLinkDestination(e.target.value)}
                                        >
                                            <option value="inside">Inside Cursor ▾</option>
                                            <option value="browser">Default Browser</option>
                                        </select>
                                    </div>
                                </div>
                            </div>

                            {/* Attribution */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Attribution</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Commit Attribution</div>
                                            <div className="sb-cursor-row-desc">Mark Agent commits as 'Made with Cursor'</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={commitAttribution}
                                            className={`sb-cursor-toggle ${commitAttribution ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setCommitAttribution(!commitAttribution)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">PR Attribution</div>
                                            <div className="sb-cursor-row-desc">Mark pull requests as made with Cursor</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={prAttribution}
                                            className={`sb-cursor-toggle ${prAttribution ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setPrAttribution(!prAttribution)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Branches */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Branches</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Branch Prefix</div>
                                            <div className="sb-cursor-row-desc">Prefix for new branches created by Agent (e.g., cursor/, username/)</div>
                                        </div>
                                        <input
                                            type="text"
                                            className="sb-cursor-text-input"
                                            value={branchPrefix}
                                            onChange={e => setBranchPrefix(e.target.value)}
                                            placeholder="cursor/"
                                        />
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 8: WORKTREES */}
                    {/* ============================================================ */}
                    {activeTab === 'worktrees' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Worktrees</h2>

                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Cleanup</div>
                                <p className="text-xs text-zinc-400 mb-2">Cursor periodically removes old worktrees to free disk space. Tune how aggressively cleanup runs.</p>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Max Worktrees</div>
                                            <div className="sb-cursor-row-desc">Maximum number of Cursor-managed worktrees to retain across all workspaces. Older worktrees are removed first.</div>
                                        </div>
                                        <div className="sb-cursor-stepper">
                                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxWorktrees(Math.max(1, maxWorktrees - 5))}>−</button>
                                            <span className="sb-stepper-val">{maxWorktrees}</span>
                                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxWorktrees(maxWorktrees + 5)}>+</button>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Max Total Size (GB)</div>
                                            <div className="sb-cursor-row-desc">Maximum total size in GB across all Cursor-managed worktrees. Set to 0 to disable the size limit.</div>
                                        </div>
                                        <div className="sb-cursor-stepper">
                                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxTotalSizeGb(Math.max(0, maxTotalSizeGb - 10))}>−</button>
                                            <span className="sb-stepper-val">{maxTotalSizeGb}</span>
                                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxTotalSizeGb(maxTotalSizeGb + 10)}>+</button>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="sb-cursor-section-block pt-2">
                                <div className="sb-cursor-section-header">Cursor-Managed Worktrees</div>
                                <div className="p-8 text-center text-xs text-zinc-500 bg-zinc-900/40 rounded-xl border border-dashed border-zinc-800">
                                    No Cursor-managed worktrees on this machine.
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 9: BROWSER & NETWORK */}
                    {/* ============================================================ */}
                    {activeTab === 'browser-network' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Browser &amp; Network</h2>

                            <div className="sb-cursor-group-card">
                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Browser Automation</div>
                                        <div className="sb-cursor-row-desc">Connected to Browser Tab</div>
                                    </div>
                                    <select
                                        className="sb-cursor-select-dropdown"
                                        value={browserAutomationMode}
                                        onChange={e => setBrowserAutomationMode(e.target.value)}
                                    >
                                        <option value="tab">Browser Tab ▾</option>
                                        <option value="window">Dedicated Window</option>
                                        <option value="headless">Headless Chromium</option>
                                    </select>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Browser Protection</div>
                                        <div className="sb-cursor-row-desc">Prevent Agent from automatically running Browser tools</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={browserProtection}
                                        className={`sb-cursor-toggle ${browserProtection ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setBrowserProtection(!browserProtection)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Open Local Links in Cursor Browser</div>
                                        <div className="sb-cursor-row-desc">Automatically open localhost links in the Browser Tab</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={openLocalLinksBrowser}
                                        className={`sb-cursor-toggle ${openLocalLinksBrowser ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setOpenLocalLinksBrowser(!openLocalLinksBrowser)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Open Web Links in Cursor Browser</div>
                                        <div className="sb-cursor-row-desc">Automatically open http and https links in the Browser Tab</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={openWebLinksBrowser}
                                        className={`sb-cursor-toggle ${openWebLinksBrowser ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setOpenWebLinksBrowser(!openWebLinksBrowser)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>
                            </div>

                            {/* Network */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Network</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">HTTP Compatibility Mode</div>
                                            <div className="sb-cursor-row-desc">HTTP/2 is recommended for low-latency streaming. In some corporate proxy and VPN environments, the compatibility mode may need to be lowered.</div>
                                        </div>
                                        <select
                                            className="sb-cursor-select-dropdown"
                                            value={httpCompatibilityMode}
                                            onChange={e => setHttpCompatibilityMode(e.target.value)}
                                        >
                                            <option value="http2">HTTP/2 ▾</option>
                                            <option value="http1">HTTP/1.1</option>
                                        </select>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Required Domains</div>
                                            <div className="sb-cursor-row-desc">These domains must be accessible for Cursor to function. Add them to your firewall or proxy allowlist.</div>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                className="sb-cursor-row-btn"
                                                onClick={() => {
                                                    navigator.clipboard.writeText('api.cursor.sh\napi2.cursor.sh\nrepo.cursor.sh');
                                                    setCopiedDomains(true);
                                                    setTimeout(() => setCopiedDomains(false), 2000);
                                                }}
                                            >
                                                {copiedDomains ? '✓ Copied' : 'Copy Domains'}
                                            </button>
                                            <button
                                                type="button"
                                                className="sb-cursor-row-btn"
                                                onClick={() => setShowDomainsList(!showDomainsList)}
                                            >
                                                {showDomainsList ? 'Hide' : 'Show'}
                                            </button>
                                        </div>
                                    </div>

                                    {showDomainsList && (
                                        <div className="p-3 bg-zinc-900/60 border-t border-zinc-800/80 text-xs font-mono text-zinc-300 space-y-1 animate-fadeIn">
                                            <div>api.cursor.sh</div>
                                            <div>api2.cursor.sh</div>
                                            <div>repo.cursor.sh</div>
                                            <div>open-vsx.org</div>
                                        </div>
                                    )}

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Network Diagnostics</div>
                                            <div className="sb-cursor-row-desc">Check network connectivity to all Cursor services</div>
                                        </div>
                                        <button
                                            type="button"
                                            className="sb-cursor-row-btn"
                                            onClick={() => {
                                                setDiagnosticRunOutput('Checking connections... All 8 endpoints online (avg latency 24ms)');
                                            }}
                                        >
                                            Run Diagnostic
                                        </button>
                                    </div>

                                    {diagnosticRunOutput && (
                                        <div className="p-3 bg-emerald-950/20 border-t border-emerald-800/40 text-xs text-emerald-300 font-mono">
                                            ✓ {diagnosticRunOutput}
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 10: TAB (AUTOCOMPLETE) */}
                    {/* ============================================================ */}
                    {activeTab === 'tab' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Tab</h2>

                            <div className="sb-cursor-group-card">
                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Cursor Tab</div>
                                        <div className="sb-cursor-row-desc">Context-aware, multi-line suggestions around your cursor based on recent edits</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={cursorTabEnabled}
                                        className={`sb-cursor-toggle ${cursorTabEnabled ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setCursorTabEnabled(!cursorTabEnabled)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Partial Accepts ⓘ</div>
                                        <div className="sb-cursor-row-desc">Accept the next word of a suggestion via ⌘→</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={partialAccepts}
                                        className={`sb-cursor-toggle ${partialAccepts ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setPartialAccepts(!partialAccepts)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Suggestions While Commenting</div>
                                        <div className="sb-cursor-row-desc">Allow Tab to trigger while in a comment region</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={suggestionsWhileCommenting}
                                        className={`sb-cursor-toggle ${suggestionsWhileCommenting ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setSuggestionsWhileCommenting(!suggestionsWhileCommenting)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Whitespace-Only Suggestions</div>
                                        <div className="sb-cursor-row-desc">Suggest edits like new lines and indentation that modify whitespace only</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={whitespaceOnlySuggestions}
                                        className={`sb-cursor-toggle ${whitespaceOnlySuggestions ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setWhitespaceOnlySuggestions(!whitespaceOnlySuggestions)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Imports</div>
                                        <div className="sb-cursor-row-desc">Automatically import necessary modules for TypeScript</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={autoImportsTs}
                                        className={`sb-cursor-toggle ${autoImportsTs ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setAutoImportsTs(!autoImportsTs)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Auto Import for Python <span className="sb-badge-unified sb-badge-zinc text-[9px]">BETA</span></div>
                                        <div className="sb-cursor-row-desc">Enable auto import for Python. This is a beta feature.</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={autoImportPython}
                                        className={`sb-cursor-toggle ${autoImportPython ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setAutoImportPython(!autoImportPython)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Ignored Files</div>
                                        <div className="sb-cursor-row-desc">Glob patterns for files where Cursor Tab will not suggest</div>
                                    </div>
                                    <input
                                        type="text"
                                        className="sb-cursor-text-input"
                                        value={ignoredFilesGlob}
                                        onChange={e => setIgnoredFilesGlob(e.target.value)}
                                        placeholder="e.g., *.md, **/generated/*"
                                    />
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 11: CODE INTELLIGENCE */}
                    {/* ============================================================ */}
                    {activeTab === 'code-intelligence' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Code Intelligence</h2>

                            {/* Codebase */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Codebase</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Index Repositories for Instant Grep</div>
                                            <div className="sb-cursor-row-desc">Automatically index repositories to speed up Grep searches. All data is stored locally.</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={indexRepositoriesGrep}
                                            className={`sb-cursor-toggle ${indexRepositoriesGrep ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setIndexRepositoriesGrep(!indexRepositoriesGrep)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Ignore Files */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">Ignore Files</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Hierarchical Cursor Ignore</div>
                                            <div className="sb-cursor-row-desc">Apply .cursorignore files to all subdirectories. Changing this setting requires restarting Cursor.</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={hierarchicalCursorIgnore}
                                            className={`sb-cursor-toggle ${hierarchicalCursorIgnore ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setHierarchicalCursorIgnore(!hierarchicalCursorIgnore)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Ignore Symlinks in Cursor Ignore Search</div>
                                            <div className="sb-cursor-row-desc">Use with caution. Skip symlinks during .cursorignore file discovery. Enable only when all .cursorignore files are reachable without symlinks. Changing this setting requires restarting Cursor.</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={ignoreSymlinks}
                                            className={`sb-cursor-toggle ${ignoreSymlinks ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setIgnoreSymlinks(!ignoreSymlinks)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* LSP */}
                            <div className="sb-cursor-section-block">
                                <div className="sb-cursor-section-header">LSP</div>
                                <div className="sb-cursor-group-card">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Enable LSPs</div>
                                            <div className="sb-cursor-row-desc">Enable language server by default to provide code intelligence in workspaces</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={enableLsps}
                                            className={`sb-cursor-toggle ${enableLsps ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setEnableLsps(!enableLsps)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Enable LSPs for Worktrees</div>
                                            <div className="sb-cursor-row-desc">Enable language server by default to provide code intelligence in agent worktree workspaces</div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={enableLspsWorktrees}
                                            className={`sb-cursor-toggle ${enableLspsWorktrees ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={() => setEnableLspsWorktrees(!enableLspsWorktrees)}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Maximum Local LSP Workspaces</div>
                                            <div className="sb-cursor-row-desc">Maximum local workspaces that can run language servers at the same time</div>
                                        </div>
                                        <div className="sb-cursor-stepper">
                                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxLocalLspWorkspaces(Math.max(1, maxLocalLspWorkspaces - 1))}>−</button>
                                            <span className="sb-stepper-val">{maxLocalLspWorkspaces}</span>
                                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxLocalLspWorkspaces(maxLocalLspWorkspaces + 1)}>+</button>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title">Maximum Remote LSP Workspaces</div>
                                            <div className="sb-cursor-row-desc">Maximum remote workspaces that can run language servers at the same time</div>
                                        </div>
                                        <div className="sb-cursor-stepper">
                                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxRemoteLspWorkspaces(Math.max(1, maxRemoteLspWorkspaces - 1))}>−</button>
                                            <span className="sb-stepper-val">{maxRemoteLspWorkspaces}</span>
                                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxRemoteLspWorkspaces(maxRemoteLspWorkspaces + 1)}>+</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB 12: BETA */}
                    {/* ============================================================ */}
                    {activeTab === 'beta' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">Beta Features</h2>

                            <div className="sb-cursor-group-card">
                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Speculative Subagent Execution (MTP)</div>
                                        <div className="sb-cursor-row-desc">Accelerate multi-step code synthesis using parallel draft proposal verification</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={subagentSpeculative}
                                        className={`sb-cursor-toggle ${subagentSpeculative ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setSubagentSpeculative(!subagentSpeculative)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>

                                <div className="sb-cursor-row-item">
                                    <div className="sb-cursor-row-info">
                                        <div className="sb-cursor-row-title">Deep Research Mode</div>
                                        <div className="sb-cursor-row-desc">Allow agent to recursively query documentation, MCP servers, and files before proposing architectural patches</div>
                                    </div>
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={deepResearchMode}
                                        className={`sb-cursor-toggle ${deepResearchMode ? 'sb-cursor-toggle-on' : ''}`}
                                        onClick={() => setDeepResearchMode(!deepResearchMode)}
                                    >
                                        <span className="sb-cursor-toggle-thumb" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB: CUSTOMIZE (RULES, SKILLS, MCPS) */}
                    {/* ============================================================ */}
                    {(activeTab === 'workspace' || activeTab === 'skills' || activeTab === 'mcp' || activeTab === 'shortcuts' || activeTab === 'about') && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <div className="flex items-center justify-between mb-4">
                                <div>
                                    <h2 className="sb-cursor-content-title">
                                        {activeTab === 'shortcuts' ? 'Keyboard Shortcuts' :
                                         activeTab === 'about' ? 'About Scratchbox IDE' :
                                         'Customize Studio'}
                                    </h2>
                                    <p className="text-xs text-zinc-400">
                                        {activeTab === 'shortcuts' ? 'Global keystrokes and rapid navigation bindings.' :
                                         activeTab === 'about' ? 'Universal AI Software Architecture & Intelligence Environment.' :
                                         'Manage project rules, superpowers (skills), and MCP connections.'}
                                    </p>
                                </div>
                                {(activeTab === 'workspace' || activeTab === 'skills' || activeTab === 'mcp') && (
                                    <div className="flex items-center gap-1.5 bg-zinc-900/80 p-1 rounded-xl border border-zinc-800/80">
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${activeTab === 'workspace' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setActiveTab('workspace')}
                                        >
                                            Rules ({workspaceRules.length})
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${activeTab === 'skills' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setActiveTab('skills')}
                                        >
                                            Skills ({skills.filter(s => s.isEnabled).length})
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${activeTab === 'mcp' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setActiveTab('mcp')}
                                        >
                                            MCPs ({mcpServers.filter(s => s.isEnabled).length})
                                        </button>
                                        <button
                                            type="button"
                                            className="sb-segment-btn"
                                            onClick={() => setActiveTab('memories')}
                                        >
                                            Memories ({memories.length})
                                        </button>
                                    </div>
                                )}
                            </div>

                            {activeTab === 'workspace' && (
                                <div className="space-y-4">
                                    <div className="sb-cursor-group-card p-4 space-y-3">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <h4 className="text-xs font-semibold text-zinc-200">Active Workspace Root</h4>
                                                <div className="text-[11px] text-zinc-400 font-mono mt-0.5">
                                                    {activeWorkspace?.path || (typeof process !== 'undefined' && process.cwd ? process.cwd() : '/Users/eligreen/dev/scratchbox-ide-master')}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                {onOpenFolder && (
                                                    <button
                                                        type="button"
                                                        className="sb-cursor-row-btn"
                                                        onClick={onOpenFolder}
                                                        title="Open Local Folder"
                                                    >
                                                        <span>Open Folder...</span>
                                                    </button>
                                                )}
                                                {onOpenWorkspace && (
                                                    <button
                                                        type="button"
                                                        className="sb-cursor-row-btn"
                                                        onClick={onOpenWorkspace}
                                                        title="Open Workspace"
                                                    >
                                                        <span>Open Workspace...</span>
                                                    </button>
                                                )}
                                                {onCreateFile && (
                                                    <button
                                                        type="button"
                                                        className="sb-cursor-row-btn"
                                                        onClick={onCreateFile}
                                                        title="Create New File"
                                                    >
                                                        <span>New File</span>
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="sb-cursor-group-card p-4 space-y-3">
                                        <div className="flex items-center justify-between">
                                            <h4 className="text-xs font-semibold text-zinc-200">Active Project Rules (.scratchbox/rules/*.md &amp; .cursorrules)</h4>
                                            <span className="text-[11px] text-zinc-500 font-mono">{workspaceRules.length} rules</span>
                                        </div>
                                        {workspaceRules.length === 0 ? (
                                            <div className="text-xs text-zinc-400 p-3 bg-zinc-900/40 rounded-xl border border-dashed border-zinc-800">
                                                No custom rules found in <code>.scratchbox/rules/</code>. Create <code>SCRATCHBOX.md</code> or <code>.cursorrules</code> to add directives.
                                            </div>
                                        ) : (
                                            <div className="space-y-2">
                                                {workspaceRules.map(rule => (
                                                    <div key={rule.id} className="p-3 bg-zinc-900/60 rounded-xl border border-zinc-800 text-xs">
                                                        <div className="font-semibold text-zinc-200">{rule.title || (rule as any).name || 'Rule'}</div>
                                                        <div className="text-[11px] text-zinc-400 mt-1 font-mono">{rule.content.slice(0, 120)}...</div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {activeTab === 'skills' && (
                                <SkillsManagerPrimitive
                                    data={{
                                        title: 'Superpowers (Skills)',
                                        subtitle: 'Domain capabilities and system prompts',
                                        skills
                                    }}
                                    onToggleSkill={(id: string, enabled: boolean) => {
                                        const updated = skills.map(s => s.id === id ? { ...s, isEnabled: enabled } : s);
                                        onSkillsChange(updated);
                                    }}
                                    onSelectPromptStarter={(prompt: string, skill: SkillItem) => {
                                        onClose();
                                        onSelectPromptStarter(prompt, skill);
                                    }}
                                />
                            )}

                            {activeTab === 'mcp' && (
                                <div className="space-y-4">
                                    {/* Google Drive & Docs Integration Card */}
                                    <div className="sb-cursor-group-card p-4 space-y-3 bg-zinc-900/90 border border-zinc-800 rounded-2xl shadow-lg">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                                                    <IconGoogleDriveColor size={22} />
                                                </div>
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <h4 className="text-xs font-semibold text-zinc-100 flex items-center gap-1.5">
                                                            <span>Google Drive &amp; Docs Integration</span>
                                                        </h4>
                                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${gdriveState.status === 'connected' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>
                                                            {gdriveState.status === 'connected' ? `Connected as ${gdriveState.accountEmail}` : 'Disconnected'}
                                                        </span>
                                                    </div>
                                                    <p className="text-[11px] text-zinc-400 mt-0.5">
                                                        Export documents to Google Docs, manage Drive files, real-time sync &amp; search.
                                                    </p>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                {gdriveState.status === 'connected' ? (
                                                    <button
                                                        type="button"
                                                        className="sb-btn sb-btn-danger sb-btn-xs"
                                                        onClick={async () => {
                                                            await GoogleDriveService.getInstance().disconnect();
                                                            setGdriveFeedback('Google Drive disconnected');
                                                            setTimeout(() => setGdriveFeedback(null), 3000);
                                                        }}
                                                    >
                                                        <span>Disconnect</span>
                                                    </button>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        className="sb-btn sb-btn-primary sb-btn-xs bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1"
                                                        disabled={isConnectingGdrive}
                                                        onClick={async () => {
                                                            setIsConnectingGdrive(true);
                                                            try {
                                                                await GoogleDriveService.getInstance().connect();
                                                                setGdriveFeedback('✓ Connected to Google Drive');
                                                                setTimeout(() => setGdriveFeedback(null), 3000);
                                                            } finally {
                                                                setIsConnectingGdrive(false);
                                                            }
                                                        }}
                                                    >
                                                        <IconSparkles size={11} />
                                                        <span>{isConnectingGdrive ? 'Connecting...' : 'Connect Google Drive'}</span>
                                                    </button>
                                                )}
                                            </div>
                                        </div>

                                        {gdriveFeedback && (
                                            <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400 text-xs font-medium flex items-center gap-1.5 animate-fadeIn">
                                                <IconCheck size={12} />
                                                <span>{gdriveFeedback}</span>
                                            </div>
                                        )}

                                        {/* Auto-Sync & Storage Row */}
                                        <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between text-xs">
                                            <div className="flex items-center gap-2">
                                                <span className="text-zinc-300 font-medium">Auto-Sync Document Specs:</span>
                                                <span className="text-zinc-400 text-[11px]">Automatically uploads document updates to Google Drive</span>
                                            </div>
                                            <label className="sb-toggle-switch">
                                                <input
                                                    type="checkbox"
                                                    checked={gdriveState.autoSyncEnabled}
                                                    onChange={e => GoogleDriveService.getInstance().toggleAutoSync(e.target.checked)}
                                                />
                                                <span className="sb-toggle-slider" />
                                            </label>
                                        </div>

                                        {/* Available Tools Grid */}
                                        <div className="pt-2 border-t border-zinc-800/80 space-y-1.5">
                                            <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                                                Active MCP Tools (4 Available)
                                            </div>
                                            <div className="grid grid-cols-2 gap-2">
                                                {[
                                                    { name: 'create_document', title: 'Create & Export Google Doc', desc: 'Converts markdown specifications into formatted Google Docs' },
                                                    { name: 'upload_file', title: 'Upload File to Google Drive', desc: 'Uploads markdown files and datasets to Drive folders' },
                                                    { name: 'list_drive_files', title: 'List Files in Google Drive', desc: 'Lists and filters documents and spreadsheets in Drive' },
                                                    { name: 'search_drive', title: 'Search Google Drive Knowledge', desc: 'Full-text semantic search across Google Drive files' }
                                                ].map((tool, tIdx) => (
                                                    <div key={tIdx} className="p-2.5 bg-zinc-950/60 rounded-xl border border-zinc-800/80 text-xs flex flex-col justify-between">
                                                        <div className="flex items-center justify-between">
                                                            <span className="font-mono text-blue-400 font-medium text-[11px]">{tool.name}</span>
                                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">MCP Tool</span>
                                                        </div>
                                                        <div className="text-zinc-200 font-medium mt-1 text-[11px]">{tool.title}</div>
                                                        <div className="text-zinc-500 text-[10px] mt-0.5">{tool.desc}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Google Maps & Geospatial Intelligence Integration Card */}
                                    <div className="sb-cursor-group-card p-4 space-y-3 bg-zinc-900/90 border border-zinc-800 rounded-2xl shadow-lg">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-3">
                                                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-xl">
                                                    🗺️
                                                </div>
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <h4 className="text-xs font-semibold text-zinc-100 flex items-center gap-1.5">
                                                            <span>Google Maps &amp; Geospatial Intelligence</span>
                                                        </h4>
                                                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${mapsState.status === 'ready' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>
                                                            {mapsState.status === 'ready' ? 'Active / Configured' : 'Procedural Fallback Mode'}
                                                        </span>
                                                    </div>
                                                    <p className="text-[11px] text-zinc-400 mt-0.5">
                                                        High-resolution Static Maps, Photorealistic 3D Tiles, Places geocoding, and live responsive map embeds.
                                                    </p>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    className="sb-btn sb-btn-secondary sb-btn-xs"
                                                    onClick={handleTestMapsKey}
                                                    disabled={isTestingMapsKey}
                                                >
                                                    {isTestingMapsKey ? 'Testing...' : 'Test Geocode'}
                                                </button>
                                            </div>
                                        </div>

                                        {/* API Key Input Line */}
                                        <div className="pt-2 border-t border-zinc-800/80 flex items-center gap-2">
                                            <label className="text-[11px] text-zinc-400 shrink-0">API Key:</label>
                                            <input
                                                type="password"
                                                className="flex-1 bg-zinc-950/80 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-blue-500"
                                                placeholder="Paste Google Maps API Key (AIzaSy...)"
                                                value={mapsKeyInput}
                                                onChange={e => setMapsKeyInput(e.target.value)}
                                            />
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-primary sb-btn-xs bg-blue-600 hover:bg-blue-500 text-white"
                                                onClick={handleSaveMapsKey}
                                            >
                                                Save
                                            </button>
                                        </div>

                                        {mapsFeedback && (
                                            <div className={`p-2 rounded-lg text-xs font-medium flex items-center gap-1.5 animate-fadeIn ${mapsFeedback.error ? 'bg-rose-500/10 border border-rose-500/20 text-rose-400' : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'}`}>
                                                <IconCheck size={12} />
                                                <span>{mapsFeedback.message}</span>
                                            </div>
                                        )}

                                        {/* Available Tools Grid */}
                                        <div className="pt-2 border-t border-zinc-800/80 space-y-1.5">
                                            <div className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">
                                                Active Geospatial MCP Tools (4 Available)
                                            </div>
                                            <div className="grid grid-cols-2 gap-2">
                                                {[
                                                    { name: 'maps_geocode', title: 'Geocoding & Place Search', desc: 'Resolves landmarks & addresses to exact lat/lng and elevation datums' },
                                                    { name: 'maps_static_imagery', title: 'Static Maps & Satellite', desc: 'Generates high-res static roadmap, satellite, and terrain visuals' },
                                                    { name: 'maps_3d_tiles', title: 'Photorealistic 3D Tiles', desc: 'Streams Google 3D geospatial mesh tiles for 3D viewports' },
                                                    { name: 'maps_interactive_embed', title: 'Live Map Embeds', desc: 'Interactive panoramic maps, street views, and navigation routes' }
                                                ].map((tool, tIdx) => (
                                                    <div key={tIdx} className="p-2.5 bg-zinc-950/60 rounded-xl border border-zinc-800/80 text-xs flex flex-col justify-between">
                                                        <div className="flex items-center justify-between">
                                                            <span className="font-mono text-emerald-400 font-medium text-[11px]">{tool.name}</span>
                                                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">Maps API</span>
                                                        </div>
                                                        <div className="text-zinc-200 font-medium mt-1 text-[11px]">{tool.title}</div>
                                                        <div className="text-zinc-500 text-[10px] mt-0.5">{tool.desc}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    </div>

                                    {/* General MCP Hub Primitive */}
                                    <McpHubPrimitive
                                        data={{
                                            title: 'Live Connections (MCP)',
                                            subtitle: 'Model Context Protocol tool endpoints',
                                            servers: mcpServers
                                        }}
                                        onToggleServer={(id: string, enabled: boolean) => {
                                            const updated = mcpServers.map(s => s.id === id ? { ...s, isEnabled: enabled } : s);
                                            onMcpServersChange(updated);
                                        }}
                                    />
                                </div>
                            )}

                            {activeTab === 'shortcuts' && (
                                <div className="space-y-4">
                                    <div className="sb-cursor-group-card p-4 space-y-3">
                                        <div className="flex items-center justify-between">
                                            <div>
                                                <h4 className="text-xs font-semibold text-zinc-200">Global Keyboard Shortcuts</h4>
                                                <p className="text-[11px] text-zinc-400 mt-0.5">Quick keystrokes for rapid navigation, code generation, and diff review.</p>
                                            </div>
                                            {onOpenKeyboardShortcuts && (
                                                <button
                                                    type="button"
                                                    className="sb-cursor-row-btn"
                                                    onClick={onOpenKeyboardShortcuts}
                                                    title="Open Keybindings Configuration"
                                                >
                                                    <span>Open Full Keybindings...</span>
                                                </button>
                                            )}
                                        </div>

                                        <div className="space-y-2 pt-2 border-t border-zinc-800/80">
                                            {[
                                                { keys: '⌘K', title: 'Inline Quick Edit', desc: 'Trigger inline AI prompt & code transformation in Sandbox' },
                                                { keys: '⌘Y', title: 'Accept Diff', desc: 'Accept inline code diff and apply changes' },
                                                { keys: '⌘N', title: 'Reject Diff / New Chat', desc: 'Reject inline code diff or start clean session' },
                                                { keys: '⌘,', title: 'Open Settings', desc: 'Launch full Scratchbox settings modal' },
                                                { keys: '⌘O', title: 'Open Folder / Project', desc: 'Open native workspace or directory' },
                                                { keys: '⌘P', title: 'Spotlight Search', desc: 'Open spotlight palette for canvases and commands' },
                                                { keys: '@', title: 'Context Mentions', desc: 'Attach files, git status, terminals, docs, or MCP tools' },
                                                { keys: '/', title: 'Superpower Skills', desc: 'Attach domain skills & specialized instructions' },
                                                { keys: 'Enter', title: 'Submit Prompt', desc: 'Send message in unified composer capsule' },
                                                { keys: 'Esc', title: 'Dismiss', desc: 'Close modals, popovers, and autocomplete menus' }
                                            ].map((sc, scIdx) => (
                                                <div key={scIdx} className="flex items-center justify-between p-2.5 bg-zinc-900/60 rounded-xl border border-zinc-800 text-xs">
                                                    <div>
                                                        <div className="font-semibold text-zinc-200">{sc.title}</div>
                                                        <div className="text-[11px] text-zinc-400">{sc.desc}</div>
                                                    </div>
                                                    <kbd className="px-2 py-1 rounded bg-zinc-800 text-zinc-300 font-mono text-[11px] font-bold border border-zinc-700/80 shadow-sm">
                                                        {sc.keys}
                                                    </kbd>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeTab === 'about' && (
                                <div className="space-y-4">
                                    <div className="sb-cursor-group-card p-6 space-y-4 text-center">
                                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-blue-600 to-indigo-600 flex items-center justify-center mx-auto shadow-lg shadow-blue-500/20 text-white font-black text-xl">
                                            SB
                                        </div>
                                        <div>
                                            <h3 className="text-base font-bold text-white">Scratchbox IDE</h3>
                                            <div className="text-xs text-blue-400 font-mono font-semibold mt-0.5">Version 1.67.100 · Scratchbox Canvas 2.0</div>
                                            <p className="text-xs text-zinc-400 max-w-md mx-auto mt-2">
                                                Universal AI Software Architecture &amp; Intelligence Environment with WebAssembly and local sandbox runtime.
                                            </p>
                                        </div>

                                        <div className="grid grid-cols-2 gap-3 max-w-md mx-auto text-left pt-2">
                                            <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800">
                                                <div className="text-[10px] uppercase font-bold text-zinc-500">Primary Model</div>
                                                <div className="text-xs font-semibold text-zinc-200 mt-0.5">Gemini 3.7 Flash</div>
                                            </div>
                                            <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800">
                                                <div className="text-[10px] uppercase font-bold text-zinc-500">Subagent Pool</div>
                                                <div className="text-xs font-semibold text-zinc-200 mt-0.5">Gemini 3.5 Flash Lite (64x)</div>
                                            </div>
                                            <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800">
                                                <div className="text-[10px] uppercase font-bold text-zinc-500">Design System</div>
                                                <div className="text-xs font-semibold text-zinc-200 mt-0.5">Apple Liquid Glass HIG</div>
                                            </div>
                                            <div className="p-3 bg-zinc-900/80 rounded-xl border border-zinc-800">
                                                <div className="text-[10px] uppercase font-bold text-zinc-500">License</div>
                                                <div className="text-xs font-semibold text-zinc-200 mt-0.5">MIT Open License</div>
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-center gap-3 pt-2">
                                            <button
                                                type="button"
                                                className="sb-cursor-row-btn"
                                                onClick={() => {
                                                    if (typeof window !== 'undefined') window.open('https://github.com/scratchbox/scratchbox-ide', '_blank');
                                                }}
                                            >
                                                <span>GitHub Repository</span>
                                            </button>
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-primary sb-btn-sm"
                                                onClick={() => {
                                                    if (typeof window !== 'undefined') window.open('https://www.scratchbox.ai', '_blank');
                                                }}
                                            >
                                                <span>Visit scratchbox.ai</span>
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ============================================================ */}
                    {/* TAB: USER MEMORIES & PREFERENCES */}
                    {/* ============================================================ */}
                    {activeTab === 'memories' && (() => {
                        const filteredMemories = memories.filter(m => {
                            if (memoriesFilterGroup !== 'all') {
                                if (getMemoryCategoryGroup(m.category) !== memoriesFilterGroup) {
                                    return false;
                                }
                            }
                            if (memorySearchQuery.trim()) {
                                const q = memorySearchQuery.toLowerCase().trim();
                                return (
                                    m.key.toLowerCase().includes(q) ||
                                    m.value.toLowerCase().includes(q) ||
                                    m.category.toLowerCase().includes(q) ||
                                    formatCategoryLabel(m.category).toLowerCase().includes(q)
                                );
                            }
                            return true;
                        });

                        const groupedMemories = filteredMemories.reduce<Record<string, UserMemoryItem[]>>((acc, item) => {
                            if (!acc[item.category]) {
                                acc[item.category] = [];
                            }
                            acc[item.category].push(item);
                            return acc;
                        }, {});

                        const writingCount = memories.filter(m => getMemoryCategoryGroup(m.category) === 'writing').length;
                        const visualCount = memories.filter(m => getMemoryCategoryGroup(m.category) === 'visual').length;
                        const projectCount = memories.filter(m => getMemoryCategoryGroup(m.category) === 'project').length;

                        return (
                            <div className="sb-cursor-settings-content animate-fadeIn">
                                <div className="flex items-center justify-between mb-2">
                                    <div>
                                        <h2 className="sb-cursor-content-title">User Memories</h2>
                                        <p className="text-xs text-zinc-400">
                                            Manage persistent memory banks, writing style voice profiles, visual aesthetics, and project facts.
                                        </p>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            type="button"
                                            className="sb-btn sb-btn-primary sb-btn-sm flex items-center gap-1.5"
                                            onClick={() => setIsAddMemoryOpen(!isAddMemoryOpen)}
                                        >
                                            <IconSparkles size={13} />
                                            <span>{isAddMemoryOpen ? 'Close Form' : '+ Add Memory'}</span>
                                        </button>
                                    </div>
                                </div>

                                {/* Memory Injection Toggle Card */}
                                <div className="sb-cursor-group-card mb-4">
                                    <div className="sb-cursor-row-item">
                                        <div className="sb-cursor-row-info">
                                            <div className="sb-cursor-row-title flex items-center gap-2">
                                                <span>Inject memories into AI generation</span>
                                                <span className="sb-badge-unified sb-badge-blue text-[9px]">ACTIVE</span>
                                            </div>
                                            <div className="sb-cursor-row-desc">
                                                Automatically supply active writing voice profiles, visual presets, and project facts to Gemini 3.7 Flash and subagent orchestrators.
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            role="switch"
                                            aria-checked={memoriesConfig.enableMemoryInjection}
                                            className={`sb-cursor-toggle ${memoriesConfig.enableMemoryInjection ? 'sb-cursor-toggle-on' : ''}`}
                                            onClick={handleToggleMemoryInjection}
                                        >
                                            <span className="sb-cursor-toggle-thumb" />
                                        </button>
                                    </div>
                                </div>

                                {/* Filter Sub-Tabs / Segments */}
                                <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                                    <div className="flex items-center gap-1 bg-zinc-900/80 p-1 rounded-xl border border-zinc-800/80">
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${memoriesFilterGroup === 'all' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setMemoriesFilterGroup('all')}
                                        >
                                            All Memories ({memories.length})
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${memoriesFilterGroup === 'writing' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setMemoriesFilterGroup('writing')}
                                        >
                                            Writing Style ({writingCount})
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${memoriesFilterGroup === 'visual' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setMemoriesFilterGroup('visual')}
                                        >
                                            Image & Video Style ({visualCount})
                                        </button>
                                        <button
                                            type="button"
                                            className={`sb-segment-btn ${memoriesFilterGroup === 'project' ? 'sb-segment-active' : ''}`}
                                            onClick={() => setMemoriesFilterGroup('project')}
                                        >
                                            Project Entities ({projectCount})
                                        </button>
                                    </div>

                                    {/* Search Filter Input */}
                                    <div className="relative min-w-[220px]">
                                        <IconSearch size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
                                        <input
                                            type="text"
                                            className="sb-cursor-text-input pl-8 py-1.5 h-9 text-xs w-full"
                                            placeholder="Filter memories & keys..."
                                            value={memorySearchQuery}
                                            onChange={e => setMemorySearchQuery(e.target.value)}
                                        />
                                    </div>
                                </div>

                                {/* Add Memory Inline Form Drawer */}
                                {isAddMemoryOpen && (
                                    <form onSubmit={handleCreateMemory} className="sb-cursor-group-card p-4 mb-4 space-y-3 bg-zinc-900/90 border-blue-500/30">
                                        <div className="flex items-center justify-between pb-2 border-b border-zinc-800">
                                            <div className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                                                <IconSparkles size={13} className="text-blue-400" />
                                                <span>Record New User Memory</span>
                                            </div>
                                            <button
                                                type="button"
                                                className="sb-btn-ghost sb-icon-button text-zinc-400 hover:text-zinc-200"
                                                onClick={() => setIsAddMemoryOpen(false)}
                                            >
                                                <IconClose size={13} />
                                            </button>
                                        </div>

                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                            <div>
                                                <label className="block text-[11px] font-medium text-zinc-400 mb-1">Category</label>
                                                <select
                                                    className="sb-cursor-select-dropdown w-full"
                                                    value={newMemoryCategory}
                                                    onChange={e => setNewMemoryCategory(e.target.value as any)}
                                                >
                                                    <optgroup label="Writing Style">
                                                        {WRITING_STYLE_CATEGORIES.map(c => (
                                                            <option key={c} value={c}>{formatCategoryLabel(c)}</option>
                                                        ))}
                                                    </optgroup>
                                                    <optgroup label="Visual Style">
                                                        {VISUAL_STYLE_CATEGORIES.map(c => (
                                                            <option key={c} value={c}>{formatCategoryLabel(c)}</option>
                                                        ))}
                                                    </optgroup>
                                                    <optgroup label="Project Context & Entities">
                                                        {PROJECT_CONTEXT_CATEGORIES.map(c => (
                                                            <option key={c} value={c}>{formatCategoryLabel(c)}</option>
                                                        ))}
                                                    </optgroup>
                                                </select>
                                            </div>

                                            <div>
                                                <label className="block text-[11px] font-medium text-zinc-400 mb-1">Memory Key / Identifier</label>
                                                <input
                                                    type="text"
                                                    className="sb-cursor-text-input w-full"
                                                    placeholder="e.g., tone_preference, brand_color, lead_actor"
                                                    value={newMemoryKey}
                                                    onChange={e => setNewMemoryKey(e.target.value)}
                                                    required
                                                />
                                            </div>
                                        </div>

                                        <div>
                                            <label className="block text-[11px] font-medium text-zinc-400 mb-1">Memory Value / Fact</label>
                                            <textarea
                                                className="sb-cursor-text-input w-full h-20 resize-y"
                                                placeholder="Enter memory instruction or grounded fact..."
                                                value={newMemoryValue}
                                                onChange={e => setNewMemoryValue(e.target.value)}
                                                required
                                            />
                                        </div>

                                        <div className="flex items-center justify-between pt-1">
                                            <div className="flex items-center gap-3">
                                                <label className="text-[11px] text-zinc-400 font-medium">Scope:</label>
                                                <label className="flex items-center gap-1 text-[11px] text-zinc-300 cursor-pointer">
                                                    <input
                                                        type="radio"
                                                        name="memoryScope"
                                                        value="global"
                                                        checked={newMemoryScope === 'global'}
                                                        onChange={() => setNewMemoryScope('global')}
                                                    />
                                                    <span>Global (All Projects)</span>
                                                </label>
                                                <label className="flex items-center gap-1 text-[11px] text-zinc-300 cursor-pointer">
                                                    <input
                                                        type="radio"
                                                        name="memoryScope"
                                                        value="workspace"
                                                        checked={newMemoryScope === 'workspace'}
                                                        onChange={() => setNewMemoryScope('workspace')}
                                                    />
                                                    <span>Workspace Only</span>
                                                </label>
                                            </div>

                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    className="sb-cursor-row-btn"
                                                    onClick={() => setIsAddMemoryOpen(false)}
                                                >
                                                    <span>Cancel</span>
                                                </button>
                                                <button
                                                    type="submit"
                                                    className="sb-btn sb-btn-primary sb-btn-sm"
                                                >
                                                    <span>Save Memory</span>
                                                </button>
                                            </div>
                                        </div>
                                    </form>
                                )}

                                {/* Writing Style Profiles Section */}
                                {(memoriesFilterGroup === 'all' || memoriesFilterGroup === 'writing') && (
                                    <div className="sb-cursor-section-block mb-4">
                                        <div className="flex items-center justify-between sb-cursor-section-header">
                                            <div className="flex items-center gap-2">
                                                <span>Writing Style Profiles</span>
                                                <span className="sb-badge-unified sb-badge-blue text-[9px]">{writingProfiles.length}</span>
                                            </div>
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-ghost sb-btn-xs text-blue-400"
                                                onClick={() => setIsAddProfileOpen(!isAddProfileOpen)}
                                            >
                                                {isAddProfileOpen ? 'Cancel' : '+ New Profile'}
                                            </button>
                                        </div>

                                        {isAddProfileOpen && (
                                            <form onSubmit={handleCreateWritingProfile} className="sb-cursor-group-card p-4 mb-3 space-y-3 bg-zinc-900/90 border-blue-500/30">
                                                <div className="text-xs font-semibold text-zinc-200">Create Writing Style Voice Profile</div>
                                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                                    <div>
                                                        <label className="block text-[11px] text-zinc-400 mb-1">Profile Name</label>
                                                        <input
                                                            type="text"
                                                            className="sb-cursor-text-input w-full"
                                                            placeholder="e.g., Executive Cupertino Voice, Technical RFC Spec"
                                                            value={newProfileName}
                                                            onChange={e => setNewProfileName(e.target.value)}
                                                            required
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="block text-[11px] text-zinc-400 mb-1">Sample Reference Quotes (one per line)</label>
                                                        <input
                                                            type="text"
                                                            className="sb-cursor-text-input w-full"
                                                            placeholder="Sample quotes representing voice..."
                                                            value={newProfileSamples}
                                                            onChange={e => setNewProfileSamples(e.target.value)}
                                                        />
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="block text-[11px] text-zinc-400 mb-1">Style Prompt Instructions</label>
                                                    <textarea
                                                        className="sb-cursor-text-input w-full h-16 resize-y"
                                                        placeholder="Describe the cadence, vocabulary, rhythm, and tone..."
                                                        value={newProfilePrompt}
                                                        onChange={e => setNewProfilePrompt(e.target.value)}
                                                        required
                                                    />
                                                </div>
                                                <div className="flex justify-end gap-2">
                                                    <button type="button" className="sb-cursor-row-btn" onClick={() => setIsAddProfileOpen(false)}>Cancel</button>
                                                    <button type="submit" className="sb-btn sb-btn-primary sb-btn-sm">Save Profile</button>
                                                </div>
                                            </form>
                                        )}

                                        <div className="sb-cursor-group-card">
                                            {writingProfiles.length === 0 ? (
                                                <div className="p-4 text-center text-xs text-zinc-400">
                                                    No writing style profiles configured yet. Add a profile to guide AI voice.
                                                </div>
                                            ) : (
                                                writingProfiles.map(profile => (
                                                    <div key={profile.id} className="sb-cursor-row-item flex items-center justify-between p-3 border-b border-zinc-800/60 last:border-0">
                                                        <div className="space-y-1 max-w-[70%]">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-xs font-semibold text-zinc-200">{profile.name}</span>
                                                                {profile.isActive && (
                                                                    <span className="sb-badge-unified sb-badge-blue text-[9px] font-bold">ACTIVE VOICE</span>
                                                                )}
                                                            </div>
                                                            <div className="text-[11px] text-zinc-400 line-clamp-2">{profile.stylePrompt}</div>
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            {!profile.isActive && (
                                                                <button
                                                                    type="button"
                                                                    className="sb-cursor-row-btn"
                                                                    onClick={() => handleSetActiveWritingProfile(profile.id)}
                                                                >
                                                                    <span>Set Active</span>
                                                                </button>
                                                            )}
                                                            <button
                                                                type="button"
                                                                className="sb-btn sb-btn-ghost sb-btn-xs text-zinc-500 hover:text-red-400 text-xs px-2 py-1"
                                                                onClick={() => handleDeleteWritingProfile(profile.id)}
                                                                title="Delete Profile"
                                                            >
                                                                Delete
                                                            </button>
                                                        </div>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Image & Video Style Preferences Section */}
                                {(memoriesFilterGroup === 'all' || memoriesFilterGroup === 'visual') && (
                                    <div className="sb-cursor-section-block mb-4">
                                        <div className="flex items-center justify-between sb-cursor-section-header">
                                            <div className="flex items-center gap-2">
                                                <span>Visual & Cinematic Style Presets</span>
                                                <span className="sb-badge-unified sb-badge-purple text-[9px]">{stylePreferences.length}</span>
                                            </div>
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-ghost sb-btn-xs text-blue-400"
                                                onClick={() => setIsAddStyleOpen(!isAddStyleOpen)}
                                            >
                                                {isAddStyleOpen ? 'Cancel' : '+ New Preset'}
                                            </button>
                                        </div>

                                        {isAddStyleOpen && (
                                            <form onSubmit={handleCreateStylePreference} className="sb-cursor-group-card p-4 mb-3 space-y-3 bg-zinc-900/90 border-purple-500/30">
                                                <div className="text-xs font-semibold text-zinc-200">Create Visual / Video Style Preset</div>
                                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                                    <div>
                                                        <label className="block text-[11px] text-zinc-400 mb-1">Preset Name</label>
                                                        <input
                                                            type="text"
                                                            className="sb-cursor-text-input w-full"
                                                            placeholder="e.g., Liquid Glass Studio, Cyberpunk Drone"
                                                            value={newStyleName}
                                                            onChange={e => setNewStyleName(e.target.value)}
                                                            required
                                                        />
                                                    </div>
                                                    <div>
                                                        <label className="block text-[11px] text-zinc-400 mb-1">Category</label>
                                                        <select
                                                            className="sb-cursor-select-dropdown w-full"
                                                            value={newStyleCategory}
                                                            onChange={e => setNewStyleCategory(e.target.value)}
                                                        >
                                                            <option value="visual_composition">Visual Composition</option>
                                                            <option value="image_style">Image Style</option>
                                                            <option value="video_style">Video Style</option>
                                                            <option value="style_preferences">General Style</option>
                                                        </select>
                                                    </div>
                                                    <div>
                                                        <label className="block text-[11px] text-zinc-400 mb-1">Short Description</label>
                                                        <input
                                                            type="text"
                                                            className="sb-cursor-text-input w-full"
                                                            placeholder="e.g., Frosted glass and vibrant speculars"
                                                            value={newStyleDesc}
                                                            onChange={e => setNewStyleDesc(e.target.value)}
                                                        />
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="block text-[11px] text-zinc-400 mb-1">Visual Prompt Directives</label>
                                                    <textarea
                                                        className="sb-cursor-text-input w-full h-16 resize-y"
                                                        placeholder="Enter camera angles, lighting conditions, materials, and color palettes..."
                                                        value={newStylePrompt}
                                                        onChange={e => setNewStylePrompt(e.target.value)}
                                                        required
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between">
                                                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                                                        <input
                                                            type="checkbox"
                                                            checked={newStyleIsDefault}
                                                            onChange={e => setNewStyleIsDefault(e.target.checked)}
                                                        />
                                                        <span>Set as Default Visual Preset</span>
                                                    </label>
                                                    <div className="flex gap-2">
                                                        <button type="button" className="sb-cursor-row-btn" onClick={() => setIsAddStyleOpen(false)}>Cancel</button>
                                                        <button type="submit" className="sb-btn sb-btn-primary sb-btn-sm">Save Preset</button>
                                                    </div>
                                                </div>
                                            </form>
                                        )}

                                        <div className="sb-cursor-group-card">
                                            {stylePreferences.length === 0 ? (
                                                <div className="p-4 text-center text-xs text-zinc-400">
                                                    No visual presets created yet.
                                                </div>
                                            ) : (
                                                stylePreferences.map(style => (
                                                    <div key={style.id} className="sb-cursor-row-item flex items-center justify-between p-3 border-b border-zinc-800/60 last:border-0">
                                                        <div className="space-y-1 max-w-[70%]">
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-xs font-semibold text-zinc-200">{style.name}</span>
                                                                {style.isDefault && (
                                                                    <span className="sb-badge-unified sb-badge-purple text-[9px] font-bold">DEFAULT PRESET</span>
                                                                )}
                                                                <span className="sb-badge-unified sb-badge-zinc text-[9px]">{formatCategoryLabel(style.category)}</span>
                                                            </div>
                                                            <div className="text-[11px] text-zinc-400 line-clamp-2">{style.stylePrompt}</div>
                                                        </div>
                                                        <button
                                                            type="button"
                                                            className="sb-btn sb-btn-ghost sb-btn-xs text-zinc-500 hover:text-red-400 text-xs px-2 py-1"
                                                            onClick={() => handleDeleteStylePreference(style.id)}
                                                            title="Delete Preset"
                                                        >
                                                            Delete
                                                        </button>
                                                    </div>
                                                ))
                                            )}
                                        </div>
                                    </div>
                                )}

                                {/* Category Accordions & Memory Items */}
                                <div className="sb-cursor-section-block">
                                    <div className="sb-cursor-section-header flex items-center justify-between">
                                        <span>Learned Memory Banks ({filteredMemories.length} Facts)</span>
                                    </div>

                                    {Object.keys(groupedMemories).length === 0 ? (
                                        <div className="sb-cursor-group-card p-6 text-center space-y-2">
                                            <IconSparkles size={22} className="text-blue-400 mx-auto" />
                                            <div className="text-sm font-semibold text-zinc-200">No memories found</div>
                                            <p className="text-xs text-zinc-400 max-w-sm mx-auto">
                                                {memorySearchQuery
                                                    ? `No memories matched "${memorySearchQuery}". Try clearing search filter.`
                                                    : 'No memories recorded in this category. Click "+ Add Memory" to add your first entry.'}
                                            </p>
                                        </div>
                                    ) : (
                                        <div className="space-y-3">
                                            {Object.entries(groupedMemories).map(([cat, items]) => {
                                                const isExpanded = expandedCategories[cat] !== false; // expanded by default
                                                const catGroup = getMemoryCategoryGroup(cat);
                                                const groupBadgeColor =
                                                    catGroup === 'writing' ? 'sb-badge-blue' :
                                                    catGroup === 'visual' ? 'sb-badge-purple' : 'sb-badge-emerald';

                                                return (
                                                    <div key={cat} className="sb-cursor-group-card overflow-hidden">
                                                        {/* Accordion Header */}
                                                        <div
                                                            className="flex items-center justify-between p-3.5 bg-zinc-900/90 cursor-pointer hover:bg-zinc-800/40 select-none border-b border-zinc-800/80"
                                                            onClick={() => toggleCategoryAccordion(cat)}
                                                        >
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-xs text-zinc-400 font-mono transition-transform duration-200 inline-block">
                                                                    {isExpanded ? '▼' : '▶'}
                                                                </span>
                                                                <span className="text-xs font-semibold text-zinc-200">
                                                                    {formatCategoryLabel(cat)}
                                                                </span>
                                                                <span className="sb-badge-unified sb-badge-zinc text-[10px]">
                                                                    {items.length}
                                                                </span>
                                                                <span className={`sb-badge-unified ${groupBadgeColor} text-[9px] uppercase`}>
                                                                    {catGroup}
                                                                </span>
                                                            </div>

                                                            <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
                                                                {confirmClearCategory === cat ? (
                                                                    <div className="flex items-center gap-1.5 bg-red-950/80 px-2 py-1 rounded-lg border border-red-800">
                                                                        <span className="text-[10px] text-red-300 font-medium">Clear all {items.length}?</span>
                                                                        <button
                                                                            type="button"
                                                                            className="sb-btn sb-btn-danger sb-btn-xs text-[10px] px-2 py-0.5"
                                                                            onClick={() => handleClearCategory(cat)}
                                                                        >
                                                                            Yes
                                                                        </button>
                                                                        <button
                                                                            type="button"
                                                                            className="sb-btn sb-btn-ghost sb-btn-xs text-[10px] text-zinc-400 hover:text-zinc-200 px-1"
                                                                            onClick={() => setConfirmClearCategory(null)}
                                                                        >
                                                                            Cancel
                                                                        </button>
                                                                    </div>
                                                                ) : (
                                                                    <button
                                                                        type="button"
                                                                        className="sb-btn sb-btn-ghost sb-btn-xs text-[11px] text-zinc-500 hover:text-red-400 px-2 py-0.5 rounded hover:bg-zinc-800/60"
                                                                        onClick={() => setConfirmClearCategory(cat)}
                                                                        title="Clear all memories in this category"
                                                                    >
                                                                        Clear Category
                                                                    </button>
                                                                )}
                                                            </div>
                                                        </div>

                                                        {/* Accordion Body */}
                                                        {isExpanded && (
                                                            <div className="divide-y divide-zinc-800/60">
                                                                {items.map(item => (
                                                                    <div key={item.id} className="p-3.5 hover:bg-zinc-900/40 transition-colors">
                                                                        <div className="flex items-center justify-between mb-1.5">
                                                                            <div className="flex items-center gap-2">
                                                                                <span className="font-mono text-xs font-semibold text-blue-300 bg-blue-950/40 px-2 py-0.5 rounded border border-blue-800/30">
                                                                                    {item.key}
                                                                                </span>
                                                                                <span className={`sb-badge-unified ${item.scope === 'workspace' ? 'sb-badge-emerald' : 'sb-badge-zinc'} text-[9px]`}>
                                                                                    {item.scope === 'workspace' ? 'Workspace' : 'Global'}
                                                                                </span>
                                                                            </div>

                                                                            <div className="flex items-center gap-2">
                                                                                {editingMemoryId === item.id ? (
                                                                                    <>
                                                                                        <button
                                                                                            type="button"
                                                                                            className="sb-btn sb-btn-primary sb-btn-sm text-[10px] px-2 py-0.5"
                                                                                            onClick={() => handleSaveEditMemory(item.id)}
                                                                                        >
                                                                                            Save
                                                                                        </button>
                                                                                        <button
                                                                                            type="button"
                                                                                            className="sb-cursor-row-btn text-[10px] px-2 py-0.5"
                                                                                            onClick={() => {
                                                                                                setEditingMemoryId(null);
                                                                                                setEditingMemoryValue('');
                                                                                            }}
                                                                                        >
                                                                                            Cancel
                                                                                        </button>
                                                                                    </>
                                                                                ) : (
                                                                                    <>
                                                                                        <button
                                                                                            type="button"
                                                                                            className="sb-btn sb-btn-ghost sb-btn-xs text-[11px] px-1.5 py-0.5"
                                                                                            onClick={() => {
                                                                                                setEditingMemoryId(item.id);
                                                                                                setEditingMemoryValue(item.value);
                                                                                            }}
                                                                                        >
                                                                                            Edit
                                                                                        </button>
                                                                                        <button
                                                                                            type="button"
                                                                                            className="sb-btn sb-btn-ghost sb-btn-xs text-[11px] px-1.5 py-0.5"
                                                                                            onClick={() => handleDeleteMemory(item.id)}
                                                                                            title="Delete Memory"
                                                                                        >
                                                                                            Delete
                                                                                        </button>
                                                                                    </>
                                                                                )}
                                                                            </div>
                                                                        </div>

                                                                        {editingMemoryId === item.id ? (
                                                                            <textarea
                                                                                className="sb-cursor-text-input w-full h-16 text-xs resize-y mt-1"
                                                                                value={editingMemoryValue}
                                                                                onChange={e => setEditingMemoryValue(e.target.value)}
                                                                            />
                                                                        ) : (
                                                                            <div className="text-xs text-zinc-300 whitespace-pre-wrap leading-relaxed">
                                                                                {item.value}
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })()}

                    {/* Generic fallback for remaining navigation tabs */}
                    {activeTab === 'docs' && (
                        <div className="sb-cursor-settings-content animate-fadeIn">
                            <h2 className="sb-cursor-content-title">
                                {sidebarNavSections.find(s => s.id === activeTab)?.label || 'Settings'}
                            </h2>
                            <div className="sb-cursor-group-card p-6 text-center space-y-2">
                                <IconSparkles size={24} className="text-blue-400 mx-auto animate-pulse" />
                                <div className="text-sm font-semibold text-zinc-200">
                                    {sidebarNavSections.find(s => s.id === activeTab)?.label} Documentation
                                </div>
                                <p className="text-xs text-zinc-400 max-w-md mx-auto">
                                    Cloud agent tasks and documentation links are accessible at docs.cursor.com and scratchbox.io/docs.
                                </p>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
