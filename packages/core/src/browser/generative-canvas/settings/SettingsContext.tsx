/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * SettingsContext
 *
 * Flat bag of everything a settings tab may read: reducer state + setters, handlers, the modal props
 * and the shell-level navigation state. Tabs destructure exactly what they use via `useSettingsContext()`.
 */
import * as React from 'react';
import { ProjectItem } from '../ProjectsModal';
import { McpServerItem, SkillItem, StudioAppearanceConfig, StudioSettingsTab } from '../canvas-types';
import { ShowcaseDemoItem } from '../demos/preloadedDemos';
import { SettingsSetters, SettingsState } from './settingsReducer';
import { useSettingsHandlers } from './useSettingsHandlers';

export interface SettingsNavSection {
    id: StudioSettingsTab;
    label: string;
    isExternal?: boolean;
}

export interface SettingsShellValues {
    isOpen: boolean;
    initialTab?: StudioSettingsTab;
    onClose: () => void;
    skills: SkillItem[];
    onSkillsChange: (skills: SkillItem[]) => void;
    mcpServers: McpServerItem[];
    onMcpServersChange: (servers: McpServerItem[]) => void;
    appearanceConfig: StudioAppearanceConfig;
    onAppearanceConfigChange: (config: StudioAppearanceConfig) => void;
    onSelectPromptStarter: (prompt: string, skill?: SkillItem) => void;
    activeWorkspace?: ProjectItem;
    propGoogleSearchGrounding?: boolean;
    onGoogleSearchGroundingChange?: (enabled: boolean) => void;
    onOpenFolder?: () => void;
    onCreateFile?: () => void;
    onOpenWorkspace?: () => void;
    onOpenPreferences?: () => void;
    onOpenKeyboardShortcuts?: () => void;
    onExecuteCommand?: (commandId: string) => void;
    onLaunchDemo?: (demo: ShowcaseDemoItem) => void;
    activeTab: StudioSettingsTab;
    setActiveTab: React.Dispatch<React.SetStateAction<StudioSettingsTab>>;
    searchQuery: string;
    setSearchQuery: React.Dispatch<React.SetStateAction<string>>;
    normalizedInitialTab: StudioSettingsTab;
    avatarInputRef: React.RefObject<HTMLInputElement>;
    activeUserName: string;
    sidebarNavSections: SettingsNavSection[];
    filteredNavSections: SettingsNavSection[];
}

export type SettingsHandlers = ReturnType<typeof useSettingsHandlers>;

export type SettingsContextValue = SettingsState & SettingsSetters & SettingsHandlers & SettingsShellValues;

const SettingsContext = React.createContext<SettingsContextValue | undefined>(undefined);

export const SettingsProvider: React.FC<{ value: SettingsContextValue; children?: React.ReactNode }> = ({ value, children }) => (
    <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
);

export function useSettingsContext(): SettingsContextValue {
    const value = React.useContext(SettingsContext);
    if (!value) {
        throw new Error('useSettingsContext must be used inside <SettingsProvider>');
    }
    return value;
}
