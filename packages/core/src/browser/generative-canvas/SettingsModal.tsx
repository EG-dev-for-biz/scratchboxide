/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { ProjectItem } from './ProjectsModal';
import { IconArrowLeft, IconClose, IconExternalLink, IconSearch, IconSettings } from './canvas-icons';
import { McpExecutionState, McpServerItem, SkillItem, StudioAppearanceConfig, StudioSettingsTab, getActiveUserName } from './canvas-types';
import { initialsOf } from './state/studio-defaults';
import { SettingsProvider, SettingsContextValue, SettingsNavSection } from './settings/SettingsContext';
import { useSettingsStore } from './settings/settingsReducer';
import { useSettingsHandlers } from './settings/useSettingsHandlers';
import { GeneralTab } from './settings/tabs/GeneralTab';
import { ProfileTab } from './settings/tabs/ProfileTab';
import { AppearanceTab } from './settings/tabs/AppearanceTab';
import { PlanTab } from './settings/tabs/PlanTab';
import { AgentsTab } from './settings/tabs/AgentsTab';
import { CloudAgentsTab } from './settings/tabs/CloudAgentsTab';
import { ModelsTab } from './settings/tabs/ModelsTab';
import { GitPrsTab } from './settings/tabs/GitPrsTab';
import { WorktreesTab } from './settings/tabs/WorktreesTab';
import { BrowserNetworkTab } from './settings/tabs/BrowserNetworkTab';
import { TabTab } from './settings/tabs/TabTab';
import { CodeIntelligenceTab } from './settings/tabs/CodeIntelligenceTab';
import { BetaTab } from './settings/tabs/BetaTab';
import { CustomizeTabs } from './settings/tabs/CustomizeTabs';
import { MemoriesTab } from './settings/tabs/MemoriesTab';
import { DocsTab } from './settings/tabs/DocsTab';

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
    const avatarInputRef = React.useRef<HTMLInputElement>(null);

    // All per-control settings live in one reducer-backed store (see settings/settingsReducer.ts)
    const { state: settingsState, setters: settingsSetters } = useSettingsStore({ propGoogleSearchGrounding });
    const { isCustomizeBannerDismissed } = settingsState;
    const { setIsCustomizeBannerDismissed } = settingsSetters;
    const activeUserName = getActiveUserName(`${settingsState.firstName} ${settingsState.lastName}`.trim());

    const settingsHandlers = useSettingsHandlers({
        activeWorkspace,
        activeWritingProfile: settingsState.activeWritingProfile,
        credentialsInput: settingsState.credentialsInput,
        editingMemoryValue: settingsState.editingMemoryValue,
        googleSearchGrounding: settingsState.googleSearchGrounding,
        initialTab,
        isOpen,
        mapsKeyInput: settingsState.mapsKeyInput,
        memories: settingsState.memories,
        memoriesConfig: settingsState.memoriesConfig,
        newMemoryCategory: settingsState.newMemoryCategory,
        newMemoryKey: settingsState.newMemoryKey,
        newMemoryScope: settingsState.newMemoryScope,
        newMemoryValue: settingsState.newMemoryValue,
        newProfileName: settingsState.newProfileName,
        newProfilePrompt: settingsState.newProfilePrompt,
        newProfileSamples: settingsState.newProfileSamples,
        newStyleCategory: settingsState.newStyleCategory,
        newStyleDesc: settingsState.newStyleDesc,
        newStyleIsDefault: settingsState.newStyleIsDefault,
        newStyleName: settingsState.newStyleName,
        newStylePrompt: settingsState.newStylePrompt,
        onGoogleSearchGroundingChange,
        propGoogleSearchGrounding,
        setActiveTab,
        setActiveWritingProfileState: settingsSetters.setActiveWritingProfileState,
        setConfirmClearCategory: settingsSetters.setConfirmClearCategory,
        setCredentialsInput: settingsSetters.setCredentialsInput,
        setCredsFeedback: settingsSetters.setCredsFeedback,
        setEditingMemoryId: settingsSetters.setEditingMemoryId,
        setEditingMemoryValue: settingsSetters.setEditingMemoryValue,
        setExpandedCategories: settingsSetters.setExpandedCategories,
        setGdriveState: settingsSetters.setGdriveState,
        setGeminiStatus: settingsSetters.setGeminiStatus,
        setGoogleSearchGrounding: settingsSetters.setGoogleSearchGrounding,
        setIsAddMemoryOpen: settingsSetters.setIsAddMemoryOpen,
        setIsAddProfileOpen: settingsSetters.setIsAddProfileOpen,
        setIsAddStyleOpen: settingsSetters.setIsAddStyleOpen,
        setIsSavingCreds: settingsSetters.setIsSavingCreds,
        setIsSavingWorkspace: settingsSetters.setIsSavingWorkspace,
        setIsTestingMapsKey: settingsSetters.setIsTestingMapsKey,
        setMapsFeedback: settingsSetters.setMapsFeedback,
        setMapsKeyInput: settingsSetters.setMapsKeyInput,
        setMapsState: settingsSetters.setMapsState,
        setMemories: settingsSetters.setMemories,
        setMemoriesConfig: settingsSetters.setMemoriesConfig,
        setNewMemoryKey: settingsSetters.setNewMemoryKey,
        setNewMemoryValue: settingsSetters.setNewMemoryValue,
        setNewProfileName: settingsSetters.setNewProfileName,
        setNewProfilePrompt: settingsSetters.setNewProfilePrompt,
        setNewProfileSamples: settingsSetters.setNewProfileSamples,
        setNewStyleDesc: settingsSetters.setNewStyleDesc,
        setNewStyleIsDefault: settingsSetters.setNewStyleIsDefault,
        setNewStyleName: settingsSetters.setNewStyleName,
        setNewStylePrompt: settingsSetters.setNewStylePrompt,
        setSaveFeedback: settingsSetters.setSaveFeedback,
        setStylePreferences: settingsSetters.setStylePreferences,
        setWorkspaceRules: settingsSetters.setWorkspaceRules,
        setWorkspaceSettings: settingsSetters.setWorkspaceSettings,
        setWritingProfiles: settingsSetters.setWritingProfiles,
        workspaceSettings: settingsState.workspaceSettings,
        writingProfiles: settingsState.writingProfiles
    });

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

    const settingsContextValue: SettingsContextValue = {
        ...settingsState,
        ...settingsSetters,
        ...settingsHandlers,
        isOpen,
        initialTab,
        onClose,
        skills,
        onSkillsChange,
        mcpServers,
        onMcpServersChange,
        appearanceConfig,
        onAppearanceConfigChange,
        onSelectPromptStarter,
        activeWorkspace,
        propGoogleSearchGrounding,
        onGoogleSearchGroundingChange,
        onOpenFolder,
        onCreateFile,
        onOpenWorkspace,
        onOpenPreferences,
        onOpenKeyboardShortcuts,
        onExecuteCommand,
        activeTab,
        setActiveTab,
        searchQuery,
        setSearchQuery,
        normalizedInitialTab,
        avatarInputRef,
        activeUserName,
        sidebarNavSections,
        filteredNavSections
    };

    return (
        <SettingsProvider value={settingsContextValue}>
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
                                    <span>{initialsOf(activeUserName)}</span>
                                </div>
                                <span className="sb-cursor-user-name">{activeUserName}</span>
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
                        {(activeTab === 'general' || activeTab === 'guide') && <GeneralTab />}
                        {activeTab === 'profile' && <ProfileTab />}
                        {activeTab === 'appearance' && <AppearanceTab />}
                        {activeTab === 'plan' && <PlanTab />}
                        {activeTab === 'agents' && <AgentsTab />}
                        {activeTab === 'cloud-agents' && <CloudAgentsTab />}
                        {activeTab === 'models' && <ModelsTab />}
                        {activeTab === 'git-prs' && <GitPrsTab />}
                        {activeTab === 'worktrees' && <WorktreesTab />}
                        {activeTab === 'browser-network' && <BrowserNetworkTab />}
                        {activeTab === 'tab' && <TabTab />}
                        {activeTab === 'code-intelligence' && <CodeIntelligenceTab />}
                        {activeTab === 'beta' && <BetaTab />}
                        {(activeTab === 'workspace' || activeTab === 'skills' || activeTab === 'mcp' || activeTab === 'shortcuts' || activeTab === 'about') && <CustomizeTabs />}
                        {activeTab === 'memories' && <MemoriesTab />}
                        {activeTab === 'docs' && <DocsTab />}
                    </div>
                </div>
            </div>
        </SettingsProvider>
    );
};
