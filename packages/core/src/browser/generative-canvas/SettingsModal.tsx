/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
import { AppearanceTab } from './settings/tabs/AppearanceTab';
import { ModelsTab } from './settings/tabs/ModelsTab';
import { WorkspaceTab } from './settings/tabs/WorkspaceTab';
import { SkillsTab } from './settings/tabs/SkillsTab';
import { McpTab } from './settings/tabs/McpTab';
import { ShortcutsTab } from './settings/tabs/ShortcutsTab';
import { AboutTab } from './settings/tabs/AboutTab';
import { AccountTab } from './settings/tabs/AccountTab';
import { useScratchboxAccount } from './services/scratchbox-account-client';
import { MemoriesTab } from './settings/tabs/MemoriesTab';
import { AdminTab } from './settings/tabs/AdminTab';
import { ShowcaseDemoItem } from './demos/preloadedDemos';

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
    onLaunchDemo?: (demo: ShowcaseDemoItem) => void;
}

const ACTIVE_TAB_IDS = new Set<StudioSettingsTab>([
    'general',
    'account',
    'appearance',
    'models',
    'workspace',
    'skills',
    'mcp',
    'memories',
    'shortcuts',
    'admin',
    'about'
]);

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
    onExecuteCommand,
    onLaunchDemo
}) => {
    // Normalize initial tab (fallback to 'general' if tab is inactive or legacy 'guide')
    const normalizedInitialTab = (initialTab && ACTIVE_TAB_IDS.has(initialTab)) ? initialTab : 'general';
    const [activeTab, setActiveTab] = React.useState<StudioSettingsTab>(normalizedInitialTab);
    const [searchQuery, setSearchQuery] = React.useState<string>('');
    const avatarInputRef = React.useRef<HTMLInputElement>(null);

    // All per-control settings live in one reducer-backed store (see settings/settingsReducer.ts)
    const { state: settingsState, setters: settingsSetters } = useSettingsStore({ propGoogleSearchGrounding });
    const account = useScratchboxAccount();
    const activeUserName = account?.signedIn && account.user?.username ? account.user.username : getActiveUserName(`${settingsState.firstName} ${settingsState.lastName}`.trim());

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

    // Active Scratchbox Settings Navigation Items — clean typography
    const sidebarNavSections: { id: StudioSettingsTab; label: string; isExternal?: boolean }[] = [
        { id: 'general', label: 'General' },
        { id: 'account', label: 'Account' },
        { id: 'appearance', label: 'Appearance' },
        { id: 'models', label: 'Models & AI' },
        { id: 'workspace', label: 'Workspace Rules' },
        { id: 'skills', label: 'Skills' },
        { id: 'mcp', label: 'MCP Tools' },
        { id: 'memories', label: 'Memories' },
        { id: 'shortcuts', label: 'Shortcuts' },
        { id: 'admin', label: 'Admin & Demos' },
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
        onLaunchDemo,
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
                                aria-label="Back"
                            >
                                <IconArrowLeft size={14} strokeWidth={2} />
                                <span>Back</span>
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
                        {!settingsState.isCustomizeBannerDismissed && (
                            <div className="sb-cursor-customize-banner">
                                <div className="sb-cursor-banner-text">
                                    <div className="sb-cursor-banner-title">
                                        Plugins, MCPs, Skills, and Rules have moved to Customize
                                    </div>
                                    <div className="sb-cursor-banner-subtitle">
                                        We've introduced a new home for all the ways to customize Scratchbox.
                                    </div>
                                </div>
                                <div className="sb-cursor-banner-actions">
                                    <button
                                        type="button"
                                        className="sb-cursor-banner-dismiss-btn"
                                        onClick={() => settingsSetters.setIsCustomizeBannerDismissed(true)}
                                    >
                                        Dismiss
                                    </button>
                                    <button type="button" className="sb-cursor-banner-open-btn" onClick={() => setActiveTab('workspace')}>
                                        Open Customize →
                                    </button>
                                </div>
                            </div>
                        )}

                        {activeTab === 'general' && <GeneralTab />}
                        {activeTab === 'account' && <AccountTab />}
                        {activeTab === 'appearance' && <AppearanceTab />}
                        {activeTab === 'models' && <ModelsTab />}
                        {activeTab === 'workspace' && <WorkspaceTab />}
                        {activeTab === 'skills' && <SkillsTab />}
                        {activeTab === 'mcp' && <McpTab />}
                        {activeTab === 'memories' && <MemoriesTab />}
                        {activeTab === 'shortcuts' && <ShortcutsTab />}
                        {activeTab === 'admin' && <AdminTab />}
                        {activeTab === 'about' && <AboutTab />}
                    </div>
                </div>
            </div>
        </SettingsProvider>
    );
};
