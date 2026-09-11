/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * useSettingsHandlers
 *
 * Effects and event handlers of the Settings modal (credentials, Google Maps key, workspace settings,
 * user memories / writing profiles / style preferences, Google Search grounding sync).
 *
 * Extracted verbatim from SettingsModal.tsx.
 */
import * as React from 'react';
import { ProjectItem } from '../ProjectsModal';
import { StudioSettingsTab, UserMemoryCategory } from '../canvas-types';
import { GeminiClient } from '../gemini-client';
import { GoogleDriveService } from '../google-drive-service';
import { GoogleMapsService } from '../google-maps-service';
import { UserMemoriesClient } from '../user-memories-client';
import { WorkspaceConfigClient } from '../workspace-config-client';
import { SettingsSetters, SettingsState } from './settingsReducer';

export interface UseSettingsHandlersDeps {
    activeWorkspace: ProjectItem | undefined;
    activeWritingProfile: SettingsState['activeWritingProfile'];
    credentialsInput: SettingsState['credentialsInput'];
    editingMemoryValue: SettingsState['editingMemoryValue'];
    googleSearchGrounding: SettingsState['googleSearchGrounding'];
    initialTab: StudioSettingsTab | undefined;
    isOpen: boolean;
    mapsKeyInput: SettingsState['mapsKeyInput'];
    memories: SettingsState['memories'];
    memoriesConfig: SettingsState['memoriesConfig'];
    newMemoryCategory: SettingsState['newMemoryCategory'];
    newMemoryKey: SettingsState['newMemoryKey'];
    newMemoryScope: SettingsState['newMemoryScope'];
    newMemoryValue: SettingsState['newMemoryValue'];
    newProfileName: SettingsState['newProfileName'];
    newProfilePrompt: SettingsState['newProfilePrompt'];
    newProfileSamples: SettingsState['newProfileSamples'];
    newStyleCategory: SettingsState['newStyleCategory'];
    newStyleDesc: SettingsState['newStyleDesc'];
    newStyleIsDefault: SettingsState['newStyleIsDefault'];
    newStyleName: SettingsState['newStyleName'];
    newStylePrompt: SettingsState['newStylePrompt'];
    onGoogleSearchGroundingChange?: (enabled: boolean) => void;
    propGoogleSearchGrounding: boolean | undefined;
    setActiveTab: React.Dispatch<React.SetStateAction<StudioSettingsTab>>;
    setActiveWritingProfileState: SettingsSetters['setActiveWritingProfileState'];
    setConfirmClearCategory: SettingsSetters['setConfirmClearCategory'];
    setCredentialsInput: SettingsSetters['setCredentialsInput'];
    setCredsFeedback: SettingsSetters['setCredsFeedback'];
    setEditingMemoryId: SettingsSetters['setEditingMemoryId'];
    setEditingMemoryValue: SettingsSetters['setEditingMemoryValue'];
    setExpandedCategories: SettingsSetters['setExpandedCategories'];
    setGdriveState: SettingsSetters['setGdriveState'];
    setGeminiStatus: SettingsSetters['setGeminiStatus'];
    setGoogleSearchGrounding: SettingsSetters['setGoogleSearchGrounding'];
    setIsAddMemoryOpen: SettingsSetters['setIsAddMemoryOpen'];
    setIsAddProfileOpen: SettingsSetters['setIsAddProfileOpen'];
    setIsAddStyleOpen: SettingsSetters['setIsAddStyleOpen'];
    setIsSavingCreds: SettingsSetters['setIsSavingCreds'];
    setIsSavingWorkspace: SettingsSetters['setIsSavingWorkspace'];
    setIsTestingMapsKey: SettingsSetters['setIsTestingMapsKey'];
    setMapsFeedback: SettingsSetters['setMapsFeedback'];
    setMapsKeyInput: SettingsSetters['setMapsKeyInput'];
    setMapsState: SettingsSetters['setMapsState'];
    setMemories: SettingsSetters['setMemories'];
    setMemoriesConfig: SettingsSetters['setMemoriesConfig'];
    setNewMemoryKey: SettingsSetters['setNewMemoryKey'];
    setNewMemoryValue: SettingsSetters['setNewMemoryValue'];
    setNewProfileName: SettingsSetters['setNewProfileName'];
    setNewProfilePrompt: SettingsSetters['setNewProfilePrompt'];
    setNewProfileSamples: SettingsSetters['setNewProfileSamples'];
    setNewStyleDesc: SettingsSetters['setNewStyleDesc'];
    setNewStyleIsDefault: SettingsSetters['setNewStyleIsDefault'];
    setNewStyleName: SettingsSetters['setNewStyleName'];
    setNewStylePrompt: SettingsSetters['setNewStylePrompt'];
    setSaveFeedback: SettingsSetters['setSaveFeedback'];
    setStylePreferences: SettingsSetters['setStylePreferences'];
    setWorkspaceRules: SettingsSetters['setWorkspaceRules'];
    setWorkspaceSettings: SettingsSetters['setWorkspaceSettings'];
    setWritingProfiles: SettingsSetters['setWritingProfiles'];
    workspaceSettings: SettingsState['workspaceSettings'];
    writingProfiles: SettingsState['writingProfiles'];
}

export function useSettingsHandlers(deps: UseSettingsHandlersDeps) {
    const { activeWorkspace, activeWritingProfile, credentialsInput, editingMemoryValue, googleSearchGrounding, initialTab, isOpen, mapsKeyInput, memories, memoriesConfig, newMemoryCategory, newMemoryKey, newMemoryScope, newMemoryValue, newProfileName, newProfilePrompt, newProfileSamples, newStyleCategory, newStyleDesc, newStyleIsDefault, newStyleName, newStylePrompt, onGoogleSearchGroundingChange, propGoogleSearchGrounding, setActiveTab, setActiveWritingProfileState, setConfirmClearCategory, setCredentialsInput, setCredsFeedback, setEditingMemoryId, setEditingMemoryValue, setExpandedCategories, setGdriveState, setGeminiStatus, setGoogleSearchGrounding, setIsAddMemoryOpen, setIsAddProfileOpen, setIsAddStyleOpen, setIsSavingCreds, setIsSavingWorkspace, setIsTestingMapsKey, setMapsFeedback, setMapsKeyInput, setMapsState, setMemories, setMemoriesConfig, setNewMemoryKey, setNewMemoryValue, setNewProfileName, setNewProfilePrompt, setNewProfileSamples, setNewStyleDesc, setNewStyleIsDefault, setNewStyleName, setNewStylePrompt, setSaveFeedback, setStylePreferences, setWorkspaceRules, setWorkspaceSettings, setWritingProfiles, workspaceSettings, writingProfiles } = deps;

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

    React.useEffect(() => {
        if (isOpen) {
            setActiveTab(initialTab === 'guide' || !initialTab ? 'general' : initialTab);
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

    return { handleClearCategory, handleCreateMemory, handleCreateStylePreference, handleCreateWritingProfile, handleDeleteMemory, handleDeleteStylePreference, handleDeleteWritingProfile, handleSaveCredentials, handleSaveEditMemory, handleSaveMapsKey, handleSaveWorkspaceSettings, handleSetActiveWritingProfile, handleTestMapsKey, handleToggleGoogleSearchGrounding, handleToggleMemoryInjection, loadMemoriesData, toggleCategoryAccordion };
}
