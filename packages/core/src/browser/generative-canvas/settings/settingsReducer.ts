/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * settingsReducer
 *
 * Single reducer-backed store for every Settings modal control. Each field keeps the exact
 * initial value and setter semantics (value or updater function) of the former `useState` calls.
 *
 * Extracted verbatim from SettingsModal.tsx.
 */
import * as React from 'react';
import { GeminiStatus } from '../../../common/gemini-protocol';
import { ImageVideoStylePreference, MemoryCategoryGroup, UserMemoriesConfig, UserMemoryCategory, UserMemoryItem, WritingStyleProfile, getActiveUserName } from '../canvas-types';
import { GoogleDriveConnectionState, GoogleDriveService } from '../google-drive-service';
import { GoogleMapsService, GoogleMapsState } from '../services/google-maps-service';
import { ProjectRule, WorkspaceSettings } from '../workspace-config-client';

export type Updater<T> = T | ((prev: T) => T);

export interface SettingsInitOptions {
    /** Initial Google Search grounding value handed down from the Studio. */
    propGoogleSearchGrounding?: boolean;
}

export interface SettingsState {
    isCustomizeBannerDismissed: boolean;
    // General Tab Configuration States
    tipsEnabled: boolean;
    windowRestoration: 'default' | 'folders' | 'empty';
    continueInterruptedAgents: boolean;
    systemNotifications: boolean;
    warningNotifications: boolean;
    menuBarIcon: boolean;
    completionSound: boolean;
    privacyMode: boolean;
    firstName: string;
    lastName: string;
    handle: string;
    link1: string;
    publicProfile: boolean;
    profileSavedFeedback: boolean;
    customAvatar: string | null;
    handleClaimedFeedback: string | null;
    // Integrations & Feedback States
    isLoggedOut: boolean;
    planUpgradeNotice: string | null;
    spendLimitSaved: boolean;
    copiedDomains: boolean;
    showDomainsList: boolean;
    // Google Drive & Docs Integration State
    gdriveState: GoogleDriveConnectionState;
    isConnectingGdrive: boolean;
    gdriveFeedback: string | null;
    // Google Maps Platform Integration State
    mapsState: GoogleMapsState;
    mapsKeyInput: string;
    mapsFeedback: { message: string; error?: boolean } | null;
    isTestingMapsKey: boolean;
    // Appearance Tab States
    selectedTheme: 'system' | 'dark' | 'light' | 'high-contrast';
    toolCallDensity: number;
    codeBlockWordWrap: boolean;
    themedDiffBackgrounds: boolean;
    colorHue: number;
    colorIntensity: number;
    reduceTransparency: boolean;
    uiFontSize: number;
    codeFontSize: number;
    uiFontFamily: string;
    codeFontFamily: string;
    fontSmoothing: boolean;
    followSystemHighContrast: boolean;
    reduceMotionSetting: string;
    // Plan & Usage States
    monthlySpendLimit: string;
    // Agents Tab States
    submitWithCmdEnter: boolean;
    defaultEnvironment: string;
    defaultAgentModel: string;
    newMessagesBehavior: string;
    manualQueueBehavior: string;
    usageSummaryBehavior: string;
    agentAutocomplete: boolean;
    autoApproveTransitions: boolean;
    includeThirdPartyConfigs: boolean;
    importClaudeCode: boolean;
    remoteControlEnabled: boolean;
    keepComputerAwake: boolean;
    webSearchToolEnabled: boolean;
    autoAcceptWebSearch: boolean;
    webFetchToolEnabled: boolean;
    waitForMcpAuth: boolean;
    runModeSetting: string;
    legacyTerminalTool: boolean;
    autoParseLinks: boolean;
    // Git & PRs States
    reviewProvider: string;
    prLinkDestination: string;
    commitAttribution: boolean;
    prAttribution: boolean;
    branchPrefix: string;
    // Worktrees States
    maxWorktrees: number;
    maxTotalSizeGb: number;
    // Browser & Network States
    browserAutomationMode: string;
    browserProtection: boolean;
    openLocalLinksBrowser: boolean;
    openWebLinksBrowser: boolean;
    httpCompatibilityMode: string;
    diagnosticRunOutput: string | null;
    // Tab (Autocomplete) States
    cursorTabEnabled: boolean;
    partialAccepts: boolean;
    suggestionsWhileCommenting: boolean;
    whitespaceOnlySuggestions: boolean;
    autoImportsTs: boolean;
    autoImportPython: boolean;
    ignoredFilesGlob: string;
    // Code Intelligence States
    indexRepositoriesGrep: boolean;
    hierarchicalCursorIgnore: boolean;
    ignoreSymlinks: boolean;
    enableLsps: boolean;
    enableLspsWorktrees: boolean;
    maxLocalLspWorkspaces: number;
    maxRemoteLspWorkspaces: number;
    // Beta States
    subagentSpeculative: boolean;
    deepResearchMode: boolean;
    // Cloud Agents States
    cloudAgentTarget: string;
    cloudCpuCores: number;
    cloudRamGb: number;
    cloudTimeoutSeconds: number;
    googleSearchGrounding: boolean;
    pythonCodeExecution: boolean;
    gcpProjectIdMapping: boolean;
    bidirectionalFilesystemSync: boolean;
    // Workspace & Gemini Configuration State
    workspaceRules: ProjectRule[];
    workspaceSettings: WorkspaceSettings;
    isSavingWorkspace: boolean;
    saveFeedback: string | undefined;
    geminiStatus: GeminiStatus | undefined;
    credentialsInput: string;
    isSavingCreds: boolean;
    credsFeedback: { message: string; error?: boolean } | undefined;
    // ============================================================
    // User Memories States & Handlers
    // ============================================================
    memories: UserMemoryItem[];
    writingProfiles: WritingStyleProfile[];
    activeWritingProfile: WritingStyleProfile | undefined;
    stylePreferences: ImageVideoStylePreference[];
    memoriesConfig: UserMemoriesConfig;
    memoriesFilterGroup: MemoryCategoryGroup;
    memorySearchQuery: string;
    expandedCategories: Record<string, boolean>;
    isAddMemoryOpen: boolean;
    newMemoryCategory: UserMemoryCategory;
    newMemoryKey: string;
    newMemoryValue: string;
    newMemoryScope: 'global' | 'workspace';
    editingMemoryId: string | null;
    editingMemoryValue: string;
    confirmClearCategory: string | null;
    // Writing Profile Form States
    isAddProfileOpen: boolean;
    newProfileName: string;
    newProfilePrompt: string;
    newProfileSamples: string;
    // Style Preference Form States
    isAddStyleOpen: boolean;
    newStyleName: string;
    newStyleDesc: string;
    newStylePrompt: string;
    newStyleCategory: string;
    newStyleIsDefault: boolean;
}

export function createInitialSettingsState({ propGoogleSearchGrounding }: SettingsInitOptions = {}): SettingsState {
    const [defaultFirstName, ...defaultLastNameParts] = getActiveUserName().split(' ');
    let saved: Partial<SettingsState> = {};
    if (typeof localStorage !== 'undefined') {
        try {
            const raw = localStorage.getItem('scratchbox_ide_settings');
            if (raw) saved = JSON.parse(raw);
        } catch {
            // ignore JSON parse error
        }
    }

    return {
        isCustomizeBannerDismissed: saved.isCustomizeBannerDismissed ?? false,
        tipsEnabled: saved.tipsEnabled ?? true,
        windowRestoration: saved.windowRestoration ?? 'default',
        continueInterruptedAgents: saved.continueInterruptedAgents ?? true,
        systemNotifications: saved.systemNotifications ?? true,
        warningNotifications: saved.warningNotifications ?? true,
        menuBarIcon: saved.menuBarIcon ?? true,
        completionSound: saved.completionSound ?? false,
        privacyMode: saved.privacyMode ?? true,
        firstName: saved.firstName ?? defaultFirstName ?? '',
        lastName: saved.lastName ?? defaultLastNameParts.join(' '),
        handle: saved.handle ?? '',
        link1: saved.link1 ?? '',
        publicProfile: saved.publicProfile ?? false,
        profileSavedFeedback: false,
        customAvatar: saved.customAvatar ?? null,
        handleClaimedFeedback: null,
        isLoggedOut: false,
        planUpgradeNotice: null,
        spendLimitSaved: false,
        copiedDomains: false,
        showDomainsList: false,
        gdriveState: (() => GoogleDriveService.getInstance().getState())(),
        isConnectingGdrive: false,
        gdriveFeedback: null,
        mapsState: (() => GoogleMapsService.getInstance().getState())(),
        mapsKeyInput: (() => GoogleMapsService.getInstance().getApiKey())(),
        mapsFeedback: null,
        isTestingMapsKey: false,
        selectedTheme: saved.selectedTheme ?? 'system',
        toolCallDensity: saved.toolCallDensity ?? 15,
        codeBlockWordWrap: saved.codeBlockWordWrap ?? true,
        themedDiffBackgrounds: saved.themedDiffBackgrounds ?? true,
        colorHue: saved.colorHue ?? 210,
        colorIntensity: saved.colorIntensity ?? 0,
        reduceTransparency: saved.reduceTransparency ?? false,
        uiFontSize: saved.uiFontSize ?? 15,
        codeFontSize: saved.codeFontSize ?? 14,
        uiFontFamily: saved.uiFontFamily ?? 'system',
        codeFontFamily: saved.codeFontFamily ?? 'system-mono',
        fontSmoothing: saved.fontSmoothing ?? true,
        followSystemHighContrast: saved.followSystemHighContrast ?? true,
        reduceMotionSetting: saved.reduceMotionSetting ?? 'system',
        monthlySpendLimit: saved.monthlySpendLimit ?? 'unlimited',
        submitWithCmdEnter: saved.submitWithCmdEnter ?? false,
        defaultEnvironment: saved.defaultEnvironment ?? 'last-used',
        defaultAgentModel: (saved.defaultAgentModel === 'cursor-default' ? 'scratchbox-default' : saved.defaultAgentModel) ?? 'scratchbox-default',
        newMessagesBehavior: saved.newMessagesBehavior ?? 'steer',
        manualQueueBehavior: saved.manualQueueBehavior ?? 'interrupt',
        usageSummaryBehavior: saved.usageSummaryBehavior ?? 'auto',
        agentAutocomplete: saved.agentAutocomplete ?? true,
        autoApproveTransitions: saved.autoApproveTransitions ?? true,
        includeThirdPartyConfigs: saved.includeThirdPartyConfigs ?? true,
        importClaudeCode: saved.importClaudeCode ?? false,
        remoteControlEnabled: saved.remoteControlEnabled ?? true,
        keepComputerAwake: saved.keepComputerAwake ?? true,
        webSearchToolEnabled: saved.webSearchToolEnabled ?? true,
        autoAcceptWebSearch: saved.autoAcceptWebSearch ?? true,
        webFetchToolEnabled: saved.webFetchToolEnabled ?? true,
        waitForMcpAuth: saved.waitForMcpAuth ?? true,
        runModeSetting: saved.runModeSetting ?? 'unsandboxed',
        legacyTerminalTool: saved.legacyTerminalTool ?? false,
        autoParseLinks: saved.autoParseLinks ?? false,
        reviewProvider: saved.reviewProvider ?? 'github',
        prLinkDestination: saved.prLinkDestination ?? 'inside',
        commitAttribution: saved.commitAttribution ?? true,
        prAttribution: saved.prAttribution ?? true,
        branchPrefix: saved.branchPrefix ?? 'scratchbox/',
        maxWorktrees: saved.maxWorktrees ?? 25,
        maxTotalSizeGb: saved.maxTotalSizeGb ?? 50,
        browserAutomationMode: saved.browserAutomationMode ?? 'tab',
        browserProtection: saved.browserProtection ?? false,
        openLocalLinksBrowser: saved.openLocalLinksBrowser ?? true,
        openWebLinksBrowser: saved.openWebLinksBrowser ?? true,
        httpCompatibilityMode: saved.httpCompatibilityMode ?? 'http2',
        diagnosticRunOutput: null,
        cursorTabEnabled: saved.cursorTabEnabled ?? true,
        partialAccepts: saved.partialAccepts ?? false,
        suggestionsWhileCommenting: saved.suggestionsWhileCommenting ?? true,
        whitespaceOnlySuggestions: saved.whitespaceOnlySuggestions ?? false,
        autoImportsTs: saved.autoImportsTs ?? true,
        autoImportPython: saved.autoImportPython ?? false,
        ignoredFilesGlob: saved.ignoredFilesGlob ?? '',
        indexRepositoriesGrep: saved.indexRepositoriesGrep ?? true,
        hierarchicalCursorIgnore: saved.hierarchicalCursorIgnore ?? false,
        ignoreSymlinks: saved.ignoreSymlinks ?? false,
        enableLsps: saved.enableLsps ?? true,
        enableLspsWorktrees: saved.enableLspsWorktrees ?? false,
        maxLocalLspWorkspaces: saved.maxLocalLspWorkspaces ?? 3,
        maxRemoteLspWorkspaces: saved.maxRemoteLspWorkspaces ?? 3,
        subagentSpeculative: saved.subagentSpeculative ?? true,
        deepResearchMode: saved.deepResearchMode ?? false,
        cloudAgentTarget: saved.cloudAgentTarget ?? 'antigravity-preview-05-2026',
        cloudCpuCores: saved.cloudCpuCores ?? 2,
        cloudRamGb: saved.cloudRamGb ?? 4,
        cloudTimeoutSeconds: saved.cloudTimeoutSeconds ?? 900,
        googleSearchGrounding: (() => {
        if (propGoogleSearchGrounding !== undefined) return propGoogleSearchGrounding;
        if (saved.googleSearchGrounding !== undefined) return saved.googleSearchGrounding;
        if (typeof localStorage !== 'undefined') {
            const savedGrounding = localStorage.getItem('scratchbox_google_search_grounding');
            if (savedGrounding !== null) return savedGrounding === 'true';
        }
        return true;
    })(),
        pythonCodeExecution: saved.pythonCodeExecution ?? true,
        gcpProjectIdMapping: saved.gcpProjectIdMapping ?? false,
        bidirectionalFilesystemSync: saved.bidirectionalFilesystemSync ?? true,
        workspaceRules: [],
        workspaceSettings: {
        defaultModel: 'gemini-3.7-flash',
        thinkingBudget: 1024,
        customPromptInstructions: 'Follow Apple Human Interface Guidelines and strict TypeScript typing.',
        autoAttachSuperpowers: true
    },
        isSavingWorkspace: false,
        saveFeedback: undefined,
        geminiStatus: undefined,
        credentialsInput: '',
        isSavingCreds: false,
        credsFeedback: undefined,
        memories: [],
        writingProfiles: [],
        activeWritingProfile: undefined,
        stylePreferences: [],
        memoriesConfig: { enableMemoryInjection: true },
        memoriesFilterGroup: 'all',
        memorySearchQuery: '',
        expandedCategories: {},
        isAddMemoryOpen: false,
        newMemoryCategory: 'tone_and_voice',
        newMemoryKey: '',
        newMemoryValue: '',
        newMemoryScope: 'global',
        editingMemoryId: null,
        editingMemoryValue: '',
        confirmClearCategory: null,
        isAddProfileOpen: false,
        newProfileName: '',
        newProfilePrompt: '',
        newProfileSamples: '',
        isAddStyleOpen: false,
        newStyleName: '',
        newStyleDesc: '',
        newStylePrompt: '',
        newStyleCategory: 'visual_composition',
        newStyleIsDefault: false,
    };
}

export type SettingsAction =
    | { [K in keyof SettingsState]: { type: 'set'; key: K; value: Updater<SettingsState[K]> } }[keyof SettingsState]
    | { type: 'reset'; state: SettingsState };

export function settingsReducer(state: SettingsState, action: SettingsAction): SettingsState {
    switch (action.type) {
        case 'set': {
            const previous = state[action.key];
            const next = typeof action.value === 'function' ? (action.value as (prev: unknown) => unknown)(previous) : action.value;
            if (Object.is(next, previous)) {
                return state;
            }
            return { ...state, [action.key]: next };
        }
        case 'reset':
            return action.state;
        default:
            return state;
    }
}

export interface SettingsSetters {
    setIsCustomizeBannerDismissed: (value: Updater<SettingsState['isCustomizeBannerDismissed']>) => void;
    setTipsEnabled: (value: Updater<SettingsState['tipsEnabled']>) => void;
    setWindowRestoration: (value: Updater<SettingsState['windowRestoration']>) => void;
    setContinueInterruptedAgents: (value: Updater<SettingsState['continueInterruptedAgents']>) => void;
    setSystemNotifications: (value: Updater<SettingsState['systemNotifications']>) => void;
    setWarningNotifications: (value: Updater<SettingsState['warningNotifications']>) => void;
    setMenuBarIcon: (value: Updater<SettingsState['menuBarIcon']>) => void;
    setCompletionSound: (value: Updater<SettingsState['completionSound']>) => void;
    setPrivacyMode: (value: Updater<SettingsState['privacyMode']>) => void;
    setFirstName: (value: Updater<SettingsState['firstName']>) => void;
    setLastName: (value: Updater<SettingsState['lastName']>) => void;
    setHandle: (value: Updater<SettingsState['handle']>) => void;
    setLink1: (value: Updater<SettingsState['link1']>) => void;
    setPublicProfile: (value: Updater<SettingsState['publicProfile']>) => void;
    setProfileSavedFeedback: (value: Updater<SettingsState['profileSavedFeedback']>) => void;
    setCustomAvatar: (value: Updater<SettingsState['customAvatar']>) => void;
    setHandleClaimedFeedback: (value: Updater<SettingsState['handleClaimedFeedback']>) => void;
    setIsLoggedOut: (value: Updater<SettingsState['isLoggedOut']>) => void;
    setPlanUpgradeNotice: (value: Updater<SettingsState['planUpgradeNotice']>) => void;
    setSpendLimitSaved: (value: Updater<SettingsState['spendLimitSaved']>) => void;
    setCopiedDomains: (value: Updater<SettingsState['copiedDomains']>) => void;
    setShowDomainsList: (value: Updater<SettingsState['showDomainsList']>) => void;
    setGdriveState: (value: Updater<SettingsState['gdriveState']>) => void;
    setIsConnectingGdrive: (value: Updater<SettingsState['isConnectingGdrive']>) => void;
    setGdriveFeedback: (value: Updater<SettingsState['gdriveFeedback']>) => void;
    setMapsState: (value: Updater<SettingsState['mapsState']>) => void;
    setMapsKeyInput: (value: Updater<SettingsState['mapsKeyInput']>) => void;
    setMapsFeedback: (value: Updater<SettingsState['mapsFeedback']>) => void;
    setIsTestingMapsKey: (value: Updater<SettingsState['isTestingMapsKey']>) => void;
    setSelectedTheme: (value: Updater<SettingsState['selectedTheme']>) => void;
    setToolCallDensity: (value: Updater<SettingsState['toolCallDensity']>) => void;
    setCodeBlockWordWrap: (value: Updater<SettingsState['codeBlockWordWrap']>) => void;
    setThemedDiffBackgrounds: (value: Updater<SettingsState['themedDiffBackgrounds']>) => void;
    setColorHue: (value: Updater<SettingsState['colorHue']>) => void;
    setColorIntensity: (value: Updater<SettingsState['colorIntensity']>) => void;
    setReduceTransparency: (value: Updater<SettingsState['reduceTransparency']>) => void;
    setUiFontSize: (value: Updater<SettingsState['uiFontSize']>) => void;
    setCodeFontSize: (value: Updater<SettingsState['codeFontSize']>) => void;
    setUiFontFamily: (value: Updater<SettingsState['uiFontFamily']>) => void;
    setCodeFontFamily: (value: Updater<SettingsState['codeFontFamily']>) => void;
    setFontSmoothing: (value: Updater<SettingsState['fontSmoothing']>) => void;
    setFollowSystemHighContrast: (value: Updater<SettingsState['followSystemHighContrast']>) => void;
    setReduceMotionSetting: (value: Updater<SettingsState['reduceMotionSetting']>) => void;
    setMonthlySpendLimit: (value: Updater<SettingsState['monthlySpendLimit']>) => void;
    setSubmitWithCmdEnter: (value: Updater<SettingsState['submitWithCmdEnter']>) => void;
    setDefaultEnvironment: (value: Updater<SettingsState['defaultEnvironment']>) => void;
    setDefaultAgentModel: (value: Updater<SettingsState['defaultAgentModel']>) => void;
    setNewMessagesBehavior: (value: Updater<SettingsState['newMessagesBehavior']>) => void;
    setManualQueueBehavior: (value: Updater<SettingsState['manualQueueBehavior']>) => void;
    setUsageSummaryBehavior: (value: Updater<SettingsState['usageSummaryBehavior']>) => void;
    setAgentAutocomplete: (value: Updater<SettingsState['agentAutocomplete']>) => void;
    setAutoApproveTransitions: (value: Updater<SettingsState['autoApproveTransitions']>) => void;
    setIncludeThirdPartyConfigs: (value: Updater<SettingsState['includeThirdPartyConfigs']>) => void;
    setImportClaudeCode: (value: Updater<SettingsState['importClaudeCode']>) => void;
    setRemoteControlEnabled: (value: Updater<SettingsState['remoteControlEnabled']>) => void;
    setKeepComputerAwake: (value: Updater<SettingsState['keepComputerAwake']>) => void;
    setWebSearchToolEnabled: (value: Updater<SettingsState['webSearchToolEnabled']>) => void;
    setAutoAcceptWebSearch: (value: Updater<SettingsState['autoAcceptWebSearch']>) => void;
    setWebFetchToolEnabled: (value: Updater<SettingsState['webFetchToolEnabled']>) => void;
    setWaitForMcpAuth: (value: Updater<SettingsState['waitForMcpAuth']>) => void;
    setRunModeSetting: (value: Updater<SettingsState['runModeSetting']>) => void;
    setLegacyTerminalTool: (value: Updater<SettingsState['legacyTerminalTool']>) => void;
    setAutoParseLinks: (value: Updater<SettingsState['autoParseLinks']>) => void;
    setReviewProvider: (value: Updater<SettingsState['reviewProvider']>) => void;
    setPrLinkDestination: (value: Updater<SettingsState['prLinkDestination']>) => void;
    setCommitAttribution: (value: Updater<SettingsState['commitAttribution']>) => void;
    setPrAttribution: (value: Updater<SettingsState['prAttribution']>) => void;
    setBranchPrefix: (value: Updater<SettingsState['branchPrefix']>) => void;
    setMaxWorktrees: (value: Updater<SettingsState['maxWorktrees']>) => void;
    setMaxTotalSizeGb: (value: Updater<SettingsState['maxTotalSizeGb']>) => void;
    setBrowserAutomationMode: (value: Updater<SettingsState['browserAutomationMode']>) => void;
    setBrowserProtection: (value: Updater<SettingsState['browserProtection']>) => void;
    setOpenLocalLinksBrowser: (value: Updater<SettingsState['openLocalLinksBrowser']>) => void;
    setOpenWebLinksBrowser: (value: Updater<SettingsState['openWebLinksBrowser']>) => void;
    setHttpCompatibilityMode: (value: Updater<SettingsState['httpCompatibilityMode']>) => void;
    setDiagnosticRunOutput: (value: Updater<SettingsState['diagnosticRunOutput']>) => void;
    setCursorTabEnabled: (value: Updater<SettingsState['cursorTabEnabled']>) => void;
    setPartialAccepts: (value: Updater<SettingsState['partialAccepts']>) => void;
    setSuggestionsWhileCommenting: (value: Updater<SettingsState['suggestionsWhileCommenting']>) => void;
    setWhitespaceOnlySuggestions: (value: Updater<SettingsState['whitespaceOnlySuggestions']>) => void;
    setAutoImportsTs: (value: Updater<SettingsState['autoImportsTs']>) => void;
    setAutoImportPython: (value: Updater<SettingsState['autoImportPython']>) => void;
    setIgnoredFilesGlob: (value: Updater<SettingsState['ignoredFilesGlob']>) => void;
    setIndexRepositoriesGrep: (value: Updater<SettingsState['indexRepositoriesGrep']>) => void;
    setHierarchicalCursorIgnore: (value: Updater<SettingsState['hierarchicalCursorIgnore']>) => void;
    setIgnoreSymlinks: (value: Updater<SettingsState['ignoreSymlinks']>) => void;
    setEnableLsps: (value: Updater<SettingsState['enableLsps']>) => void;
    setEnableLspsWorktrees: (value: Updater<SettingsState['enableLspsWorktrees']>) => void;
    setMaxLocalLspWorkspaces: (value: Updater<SettingsState['maxLocalLspWorkspaces']>) => void;
    setMaxRemoteLspWorkspaces: (value: Updater<SettingsState['maxRemoteLspWorkspaces']>) => void;
    setSubagentSpeculative: (value: Updater<SettingsState['subagentSpeculative']>) => void;
    setDeepResearchMode: (value: Updater<SettingsState['deepResearchMode']>) => void;
    setCloudAgentTarget: (value: Updater<SettingsState['cloudAgentTarget']>) => void;
    setCloudCpuCores: (value: Updater<SettingsState['cloudCpuCores']>) => void;
    setCloudRamGb: (value: Updater<SettingsState['cloudRamGb']>) => void;
    setCloudTimeoutSeconds: (value: Updater<SettingsState['cloudTimeoutSeconds']>) => void;
    setGoogleSearchGrounding: (value: Updater<SettingsState['googleSearchGrounding']>) => void;
    setPythonCodeExecution: (value: Updater<SettingsState['pythonCodeExecution']>) => void;
    setGcpProjectIdMapping: (value: Updater<SettingsState['gcpProjectIdMapping']>) => void;
    setBidirectionalFilesystemSync: (value: Updater<SettingsState['bidirectionalFilesystemSync']>) => void;
    setWorkspaceRules: (value: Updater<SettingsState['workspaceRules']>) => void;
    setWorkspaceSettings: (value: Updater<SettingsState['workspaceSettings']>) => void;
    setIsSavingWorkspace: (value: Updater<SettingsState['isSavingWorkspace']>) => void;
    setSaveFeedback: (value: Updater<SettingsState['saveFeedback']>) => void;
    setGeminiStatus: (value: Updater<SettingsState['geminiStatus']>) => void;
    setCredentialsInput: (value: Updater<SettingsState['credentialsInput']>) => void;
    setIsSavingCreds: (value: Updater<SettingsState['isSavingCreds']>) => void;
    setCredsFeedback: (value: Updater<SettingsState['credsFeedback']>) => void;
    setMemories: (value: Updater<SettingsState['memories']>) => void;
    setWritingProfiles: (value: Updater<SettingsState['writingProfiles']>) => void;
    setActiveWritingProfileState: (value: Updater<SettingsState['activeWritingProfile']>) => void;
    setStylePreferences: (value: Updater<SettingsState['stylePreferences']>) => void;
    setMemoriesConfig: (value: Updater<SettingsState['memoriesConfig']>) => void;
    setMemoriesFilterGroup: (value: Updater<SettingsState['memoriesFilterGroup']>) => void;
    setMemorySearchQuery: (value: Updater<SettingsState['memorySearchQuery']>) => void;
    setExpandedCategories: (value: Updater<SettingsState['expandedCategories']>) => void;
    setIsAddMemoryOpen: (value: Updater<SettingsState['isAddMemoryOpen']>) => void;
    setNewMemoryCategory: (value: Updater<SettingsState['newMemoryCategory']>) => void;
    setNewMemoryKey: (value: Updater<SettingsState['newMemoryKey']>) => void;
    setNewMemoryValue: (value: Updater<SettingsState['newMemoryValue']>) => void;
    setNewMemoryScope: (value: Updater<SettingsState['newMemoryScope']>) => void;
    setEditingMemoryId: (value: Updater<SettingsState['editingMemoryId']>) => void;
    setEditingMemoryValue: (value: Updater<SettingsState['editingMemoryValue']>) => void;
    setConfirmClearCategory: (value: Updater<SettingsState['confirmClearCategory']>) => void;
    setIsAddProfileOpen: (value: Updater<SettingsState['isAddProfileOpen']>) => void;
    setNewProfileName: (value: Updater<SettingsState['newProfileName']>) => void;
    setNewProfilePrompt: (value: Updater<SettingsState['newProfilePrompt']>) => void;
    setNewProfileSamples: (value: Updater<SettingsState['newProfileSamples']>) => void;
    setIsAddStyleOpen: (value: Updater<SettingsState['isAddStyleOpen']>) => void;
    setNewStyleName: (value: Updater<SettingsState['newStyleName']>) => void;
    setNewStyleDesc: (value: Updater<SettingsState['newStyleDesc']>) => void;
    setNewStylePrompt: (value: Updater<SettingsState['newStylePrompt']>) => void;
    setNewStyleCategory: (value: Updater<SettingsState['newStyleCategory']>) => void;
    setNewStyleIsDefault: (value: Updater<SettingsState['newStyleIsDefault']>) => void;
}

const SETTER_NAMES: Partial<Record<keyof SettingsState, keyof SettingsSetters>> = {
    isCustomizeBannerDismissed: 'setIsCustomizeBannerDismissed',
    tipsEnabled: 'setTipsEnabled',
    windowRestoration: 'setWindowRestoration',
    continueInterruptedAgents: 'setContinueInterruptedAgents',
    systemNotifications: 'setSystemNotifications',
    warningNotifications: 'setWarningNotifications',
    menuBarIcon: 'setMenuBarIcon',
    completionSound: 'setCompletionSound',
    privacyMode: 'setPrivacyMode',
    firstName: 'setFirstName',
    lastName: 'setLastName',
    handle: 'setHandle',
    link1: 'setLink1',
    publicProfile: 'setPublicProfile',
    profileSavedFeedback: 'setProfileSavedFeedback',
    customAvatar: 'setCustomAvatar',
    handleClaimedFeedback: 'setHandleClaimedFeedback',
    isLoggedOut: 'setIsLoggedOut',
    planUpgradeNotice: 'setPlanUpgradeNotice',
    spendLimitSaved: 'setSpendLimitSaved',
    copiedDomains: 'setCopiedDomains',
    showDomainsList: 'setShowDomainsList',
    gdriveState: 'setGdriveState',
    isConnectingGdrive: 'setIsConnectingGdrive',
    gdriveFeedback: 'setGdriveFeedback',
    mapsState: 'setMapsState',
    mapsKeyInput: 'setMapsKeyInput',
    mapsFeedback: 'setMapsFeedback',
    isTestingMapsKey: 'setIsTestingMapsKey',
    selectedTheme: 'setSelectedTheme',
    toolCallDensity: 'setToolCallDensity',
    codeBlockWordWrap: 'setCodeBlockWordWrap',
    themedDiffBackgrounds: 'setThemedDiffBackgrounds',
    colorHue: 'setColorHue',
    colorIntensity: 'setColorIntensity',
    reduceTransparency: 'setReduceTransparency',
    uiFontSize: 'setUiFontSize',
    codeFontSize: 'setCodeFontSize',
    uiFontFamily: 'setUiFontFamily',
    codeFontFamily: 'setCodeFontFamily',
    fontSmoothing: 'setFontSmoothing',
    followSystemHighContrast: 'setFollowSystemHighContrast',
    reduceMotionSetting: 'setReduceMotionSetting',
    monthlySpendLimit: 'setMonthlySpendLimit',
    submitWithCmdEnter: 'setSubmitWithCmdEnter',
    defaultEnvironment: 'setDefaultEnvironment',
    defaultAgentModel: 'setDefaultAgentModel',
    newMessagesBehavior: 'setNewMessagesBehavior',
    manualQueueBehavior: 'setManualQueueBehavior',
    usageSummaryBehavior: 'setUsageSummaryBehavior',
    agentAutocomplete: 'setAgentAutocomplete',
    autoApproveTransitions: 'setAutoApproveTransitions',
    includeThirdPartyConfigs: 'setIncludeThirdPartyConfigs',
    importClaudeCode: 'setImportClaudeCode',
    remoteControlEnabled: 'setRemoteControlEnabled',
    keepComputerAwake: 'setKeepComputerAwake',
    webSearchToolEnabled: 'setWebSearchToolEnabled',
    autoAcceptWebSearch: 'setAutoAcceptWebSearch',
    webFetchToolEnabled: 'setWebFetchToolEnabled',
    waitForMcpAuth: 'setWaitForMcpAuth',
    runModeSetting: 'setRunModeSetting',
    legacyTerminalTool: 'setLegacyTerminalTool',
    autoParseLinks: 'setAutoParseLinks',
    reviewProvider: 'setReviewProvider',
    prLinkDestination: 'setPrLinkDestination',
    commitAttribution: 'setCommitAttribution',
    prAttribution: 'setPrAttribution',
    branchPrefix: 'setBranchPrefix',
    maxWorktrees: 'setMaxWorktrees',
    maxTotalSizeGb: 'setMaxTotalSizeGb',
    browserAutomationMode: 'setBrowserAutomationMode',
    browserProtection: 'setBrowserProtection',
    openLocalLinksBrowser: 'setOpenLocalLinksBrowser',
    openWebLinksBrowser: 'setOpenWebLinksBrowser',
    httpCompatibilityMode: 'setHttpCompatibilityMode',
    diagnosticRunOutput: 'setDiagnosticRunOutput',
    cursorTabEnabled: 'setCursorTabEnabled',
    partialAccepts: 'setPartialAccepts',
    suggestionsWhileCommenting: 'setSuggestionsWhileCommenting',
    whitespaceOnlySuggestions: 'setWhitespaceOnlySuggestions',
    autoImportsTs: 'setAutoImportsTs',
    autoImportPython: 'setAutoImportPython',
    ignoredFilesGlob: 'setIgnoredFilesGlob',
    indexRepositoriesGrep: 'setIndexRepositoriesGrep',
    hierarchicalCursorIgnore: 'setHierarchicalCursorIgnore',
    ignoreSymlinks: 'setIgnoreSymlinks',
    enableLsps: 'setEnableLsps',
    enableLspsWorktrees: 'setEnableLspsWorktrees',
    maxLocalLspWorkspaces: 'setMaxLocalLspWorkspaces',
    maxRemoteLspWorkspaces: 'setMaxRemoteLspWorkspaces',
    subagentSpeculative: 'setSubagentSpeculative',
    deepResearchMode: 'setDeepResearchMode',
    cloudAgentTarget: 'setCloudAgentTarget',
    cloudCpuCores: 'setCloudCpuCores',
    cloudRamGb: 'setCloudRamGb',
    cloudTimeoutSeconds: 'setCloudTimeoutSeconds',
    googleSearchGrounding: 'setGoogleSearchGrounding',
    pythonCodeExecution: 'setPythonCodeExecution',
    gcpProjectIdMapping: 'setGcpProjectIdMapping',
    bidirectionalFilesystemSync: 'setBidirectionalFilesystemSync',
    workspaceRules: 'setWorkspaceRules',
    workspaceSettings: 'setWorkspaceSettings',
    isSavingWorkspace: 'setIsSavingWorkspace',
    saveFeedback: 'setSaveFeedback',
    geminiStatus: 'setGeminiStatus',
    credentialsInput: 'setCredentialsInput',
    isSavingCreds: 'setIsSavingCreds',
    credsFeedback: 'setCredsFeedback',
    memories: 'setMemories',
    writingProfiles: 'setWritingProfiles',
    activeWritingProfile: 'setActiveWritingProfileState',
    stylePreferences: 'setStylePreferences',
    memoriesConfig: 'setMemoriesConfig',
    memoriesFilterGroup: 'setMemoriesFilterGroup',
    memorySearchQuery: 'setMemorySearchQuery',
    expandedCategories: 'setExpandedCategories',
    isAddMemoryOpen: 'setIsAddMemoryOpen',
    newMemoryCategory: 'setNewMemoryCategory',
    newMemoryKey: 'setNewMemoryKey',
    newMemoryValue: 'setNewMemoryValue',
    newMemoryScope: 'setNewMemoryScope',
    editingMemoryId: 'setEditingMemoryId',
    editingMemoryValue: 'setEditingMemoryValue',
    confirmClearCategory: 'setConfirmClearCategory',
    isAddProfileOpen: 'setIsAddProfileOpen',
    newProfileName: 'setNewProfileName',
    newProfilePrompt: 'setNewProfilePrompt',
    newProfileSamples: 'setNewProfileSamples',
    isAddStyleOpen: 'setIsAddStyleOpen',
    newStyleName: 'setNewStyleName',
    newStyleDesc: 'setNewStyleDesc',
    newStylePrompt: 'setNewStylePrompt',
    newStyleCategory: 'setNewStyleCategory',
    newStyleIsDefault: 'setNewStyleIsDefault',
};

export interface SettingsStore {
    state: SettingsState;
    setters: SettingsSetters;
    dispatch: React.Dispatch<SettingsAction>;
}

/** `useReducer`-backed replacement for the former per-control `useState` calls; setters are identity-stable. */
export function useSettingsStore(options: SettingsInitOptions = {}): SettingsStore {
    const [state, dispatch] = React.useReducer(settingsReducer, options, createInitialSettingsState);

    // Persist user-customizable configuration settings across reloads
    React.useEffect(() => {
        if (typeof localStorage === 'undefined') return;
        try {
            const toPersist: Partial<SettingsState> = {
                tipsEnabled: state.tipsEnabled,
                windowRestoration: state.windowRestoration,
                continueInterruptedAgents: state.continueInterruptedAgents,
                systemNotifications: state.systemNotifications,
                warningNotifications: state.warningNotifications,
                menuBarIcon: state.menuBarIcon,
                completionSound: state.completionSound,
                privacyMode: state.privacyMode,
                firstName: state.firstName,
                lastName: state.lastName,
                handle: state.handle,
                link1: state.link1,
                publicProfile: state.publicProfile,
                customAvatar: state.customAvatar,
                selectedTheme: state.selectedTheme,
                toolCallDensity: state.toolCallDensity,
                codeBlockWordWrap: state.codeBlockWordWrap,
                themedDiffBackgrounds: state.themedDiffBackgrounds,
                colorHue: state.colorHue,
                colorIntensity: state.colorIntensity,
                reduceTransparency: state.reduceTransparency,
                uiFontSize: state.uiFontSize,
                codeFontSize: state.codeFontSize,
                uiFontFamily: state.uiFontFamily,
                codeFontFamily: state.codeFontFamily,
                fontSmoothing: state.fontSmoothing,
                followSystemHighContrast: state.followSystemHighContrast,
                reduceMotionSetting: state.reduceMotionSetting,
                monthlySpendLimit: state.monthlySpendLimit,
                submitWithCmdEnter: state.submitWithCmdEnter,
                defaultEnvironment: state.defaultEnvironment,
                defaultAgentModel: state.defaultAgentModel,
                newMessagesBehavior: state.newMessagesBehavior,
                manualQueueBehavior: state.manualQueueBehavior,
                usageSummaryBehavior: state.usageSummaryBehavior,
                agentAutocomplete: state.agentAutocomplete,
                autoApproveTransitions: state.autoApproveTransitions,
                includeThirdPartyConfigs: state.includeThirdPartyConfigs,
                importClaudeCode: state.importClaudeCode,
                remoteControlEnabled: state.remoteControlEnabled,
                keepComputerAwake: state.keepComputerAwake,
                webSearchToolEnabled: state.webSearchToolEnabled,
                autoAcceptWebSearch: state.autoAcceptWebSearch,
                webFetchToolEnabled: state.webFetchToolEnabled,
                waitForMcpAuth: state.waitForMcpAuth,
                runModeSetting: state.runModeSetting,
                legacyTerminalTool: state.legacyTerminalTool,
                autoParseLinks: state.autoParseLinks,
                reviewProvider: state.reviewProvider,
                prLinkDestination: state.prLinkDestination,
                commitAttribution: state.commitAttribution,
                prAttribution: state.prAttribution,
                branchPrefix: state.branchPrefix,
                maxWorktrees: state.maxWorktrees,
                maxTotalSizeGb: state.maxTotalSizeGb,
                browserAutomationMode: state.browserAutomationMode,
                browserProtection: state.browserProtection,
                openLocalLinksBrowser: state.openLocalLinksBrowser,
                openWebLinksBrowser: state.openWebLinksBrowser,
                httpCompatibilityMode: state.httpCompatibilityMode,
                cursorTabEnabled: state.cursorTabEnabled,
                partialAccepts: state.partialAccepts,
                suggestionsWhileCommenting: state.suggestionsWhileCommenting,
                whitespaceOnlySuggestions: state.whitespaceOnlySuggestions,
                autoImportsTs: state.autoImportsTs,
                autoImportPython: state.autoImportPython,
                ignoredFilesGlob: state.ignoredFilesGlob,
                indexRepositoriesGrep: state.indexRepositoriesGrep,
                hierarchicalCursorIgnore: state.hierarchicalCursorIgnore,
                ignoreSymlinks: state.ignoreSymlinks,
                enableLsps: state.enableLsps,
                enableLspsWorktrees: state.enableLspsWorktrees,
                maxLocalLspWorkspaces: state.maxLocalLspWorkspaces,
                maxRemoteLspWorkspaces: state.maxRemoteLspWorkspaces,
                subagentSpeculative: state.subagentSpeculative,
                deepResearchMode: state.deepResearchMode,
                cloudAgentTarget: state.cloudAgentTarget,
                cloudCpuCores: state.cloudCpuCores,
                cloudRamGb: state.cloudRamGb,
                cloudTimeoutSeconds: state.cloudTimeoutSeconds,
                googleSearchGrounding: state.googleSearchGrounding,
                pythonCodeExecution: state.pythonCodeExecution,
                gcpProjectIdMapping: state.gcpProjectIdMapping,
                bidirectionalFilesystemSync: state.bidirectionalFilesystemSync
            };
            localStorage.setItem('scratchbox_ide_settings', JSON.stringify(toPersist));
        } catch {
            // Ignore quota or security errors in iframe environments
        }
    }, [state]);

    const setters = React.useMemo(() => {
        const result: Record<string, (value: unknown) => void> = {};
        (Object.keys(SETTER_NAMES) as (keyof SettingsState)[]).forEach(key => {
            result[SETTER_NAMES[key] as string] = value => dispatch({ type: 'set', key, value } as SettingsAction);
        });
        return result as unknown as SettingsSetters;
    }, []);
    return { state, setters, dispatch };
}
