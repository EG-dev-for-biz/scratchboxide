/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/
import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import {
    formatCategoryLabel,
    getMemoryCategoryGroup,
    ImageVideoStylePreference,
    MemoryCategoryGroup,
    PROJECT_CONTEXT_CATEGORIES,
    UserMemoriesConfig,
    UserMemoriesStore,
    UserMemoryCategory,
    UserMemoryItem,
    VISUAL_STYLE_CATEGORIES,
    WRITING_STYLE_CATEGORIES,
    WritingStyleProfile
} from '../browser/generative-canvas/canvas-types';

export interface UserMemoriesServiceOptions {
    globalStorePath?: string;
    defaultWorkspaceRoot?: string;
}

export interface ListMemoriesOptions {
    category?: UserMemoryCategory;
    categoryGroup?: MemoryCategoryGroup;
    searchQuery?: string;
    scope?: 'global' | 'workspace' | 'all';
    workspaceRoot?: string;
}

export interface CreateMemoryParams {
    category: UserMemoryCategory;
    key: string;
    value: string;
    scope?: 'global' | 'workspace';
    workspaceId?: string;
    workspaceRoot?: string;
}

export interface UpdateMemoryParams {
    category?: UserMemoryCategory;
    key?: string;
    value?: string;
    workspaceRoot?: string;
}

export interface CreateWritingProfileParams {
    name: string;
    stylePrompt: string;
    samples?: string[];
    isActive?: boolean;
    scope?: 'global' | 'workspace';
    workspaceRoot?: string;
}

export interface CreateStylePreferenceParams {
    name: string;
    description?: string;
    stylePrompt: string;
    category?: string;
    isDefault?: boolean;
    sortOrder?: number;
    scope?: 'global' | 'workspace';
    workspaceRoot?: string;
}

const DEFAULT_CONFIG: UserMemoriesConfig = {
    enableMemoryInjection: true,
    maxInjectedMemories: 40
};
export class UserMemoriesService {
    private globalStorePath: string;
    private defaultWorkspaceRoot?: string;

    constructor(options?: UserMemoriesServiceOptions) {
        this.globalStorePath = options?.globalStorePath || path.join(os.homedir(), '.scratchbox-ide', 'memories.json');
        this.defaultWorkspaceRoot = options?.defaultWorkspaceRoot;
    }

    public setGlobalStorePath(globalStorePath: string): void {
        this.globalStorePath = globalStorePath;
    }

    public setDefaultWorkspaceRoot(workspaceRoot: string): void {
        this.defaultWorkspaceRoot = workspaceRoot;
    }

    // -------------------------------------------------------------
    // Store Load & Save Helpers
    // -------------------------------------------------------------

    private getWorkspaceStorePath(workspaceRoot?: string): string | undefined {
        const root = workspaceRoot || this.defaultWorkspaceRoot || (typeof process !== 'undefined' ? process.cwd() : undefined);
        if (!root) {
            return undefined;
        }
        return path.join(root, '.scratchbox', 'memories.json');
    }

    private async loadStoreFromFile(filePath: string): Promise<UserMemoriesStore> {
        try {
            if (await fs.pathExists(filePath)) {
                const data = await fs.readJson(filePath);
                return {
                    version: data.version || 1,
                    config: { ...DEFAULT_CONFIG, ...(data.config || {}) },
                    memories: Array.isArray(data.memories) ? data.memories : [],
                    writingProfiles: Array.isArray(data.writingProfiles) ? data.writingProfiles : [],
                    stylePreferences: Array.isArray(data.stylePreferences) ? data.stylePreferences : [],
                    lastUpdated: data.lastUpdated
                };
            }
        } catch (err) {
            console.error(`[UserMemoriesService] Failed to read store from ${filePath}:`, err);
        }

        return {
            version: 1,
            config: { ...DEFAULT_CONFIG },
            memories: [],
            writingProfiles: [],
            stylePreferences: []
        };
    }

    private async saveStoreToFile(filePath: string, store: UserMemoriesStore): Promise<void> {
        try {
            await fs.ensureDir(path.dirname(filePath));
            store.lastUpdated = new Date().toISOString();
            await fs.writeJson(filePath, store, { spaces: 2 });
        } catch (err) {
            console.error(`[UserMemoriesService] Failed to write store to ${filePath}:`, err);
            throw err;
        }
    }

    private async loadGlobalStore(): Promise<UserMemoriesStore> {
        return this.loadStoreFromFile(this.globalStorePath);
    }

    private async saveGlobalStore(store: UserMemoriesStore): Promise<void> {
        await this.saveStoreToFile(this.globalStorePath, store);
    }

    private async loadWorkspaceStore(workspaceRoot?: string): Promise<UserMemoriesStore | undefined> {
        const wsPath = this.getWorkspaceStorePath(workspaceRoot);
        if (!wsPath) {
            return undefined;
        }
        return this.loadStoreFromFile(wsPath);
    }

    private async saveWorkspaceStore(store: UserMemoriesStore, workspaceRoot?: string): Promise<void> {
        const wsPath = this.getWorkspaceStorePath(workspaceRoot);
        if (!wsPath) {
            throw new Error('Cannot save workspace memories: workspaceRoot not provided');
        }
        await this.saveStoreToFile(wsPath, store);
    }

    // -------------------------------------------------------------
    // Configuration
    // -------------------------------------------------------------

    async getConfig(): Promise<UserMemoriesConfig> {
        const globalStore = await this.loadGlobalStore();
        return globalStore.config;
    }

    async updateConfig(partialConfig: Partial<UserMemoriesConfig>): Promise<UserMemoriesConfig> {
        const globalStore = await this.loadGlobalStore();
        globalStore.config = { ...globalStore.config, ...partialConfig };
        await this.saveGlobalStore(globalStore);
        return globalStore.config;
    }

    // -------------------------------------------------------------
    // User Memory CRUD Operations
    // -------------------------------------------------------------

    async createMemory(params: CreateMemoryParams): Promise<UserMemoryItem> {
        const isWorkspace = params.scope === 'workspace';
        const targetStore = isWorkspace
            ? (await this.loadWorkspaceStore(params.workspaceRoot)) || (await this.loadGlobalStore())
            : await this.loadGlobalStore();

        const now = new Date().toISOString();
        const id = `mem-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
        const newItem: UserMemoryItem = {
            id,
            category: params.category,
            key: params.key.trim(),
            value: params.value.trim(),
            scope: isWorkspace ? 'workspace' : 'global',
            workspaceId: params.workspaceId,
            createdAt: now,
            updatedAt: now
        };

        targetStore.memories.push(newItem);

        if (isWorkspace) {
            await this.saveWorkspaceStore(targetStore, params.workspaceRoot);
        } else {
            await this.saveGlobalStore(targetStore);
        }

        return newItem;
    }

    async getMemoryById(id: string, workspaceRoot?: string): Promise<UserMemoryItem | undefined> {
        const globalStore = await this.loadGlobalStore();
        const fromGlobal = globalStore.memories.find(m => m.id === id);
        if (fromGlobal) {
            return fromGlobal;
        }

        const wsStore = await this.loadWorkspaceStore(workspaceRoot);
        if (wsStore) {
            return wsStore.memories.find(m => m.id === id);
        }

        return undefined;
    }

    async listMemories(options?: ListMemoriesOptions): Promise<UserMemoryItem[]> {
        const scope = options?.scope || 'all';
        const globalStore = await this.loadGlobalStore();
        const wsStore = await this.loadWorkspaceStore(options?.workspaceRoot);

        let combined: UserMemoryItem[] = [];

        if (scope === 'global' || scope === 'all') {
            combined = combined.concat(globalStore.memories.map(m => ({ ...m, scope: 'global' as const })));
        }

        if ((scope === 'workspace' || scope === 'all') && wsStore) {
            combined = combined.concat(wsStore.memories.map(m => ({ ...m, scope: 'workspace' as const })));
        }

        // Filter by specific category
        if (options?.category) {
            combined = combined.filter(m => m.category === options.category);
        }

        // Filter by category group ('writing', 'visual', 'project')
        if (options?.categoryGroup && options.categoryGroup !== 'all') {
            combined = combined.filter(m => getMemoryCategoryGroup(m.category) === options.categoryGroup);
        }

        // Filter by search query
        if (options?.searchQuery && options.searchQuery.trim()) {
            const query = options.searchQuery.toLowerCase().trim();
            combined = combined.filter(m =>
                m.key.toLowerCase().includes(query) ||
                m.value.toLowerCase().includes(query) ||
                m.category.toLowerCase().includes(query) ||
                formatCategoryLabel(m.category).toLowerCase().includes(query)
            );
        }

        return combined;
    }

    async updateMemory(id: string, params: UpdateMemoryParams): Promise<UserMemoryItem | undefined> {
        // Check global store first
        const globalStore = await this.loadGlobalStore();
        const globalIndex = globalStore.memories.findIndex(m => m.id === id);
        if (globalIndex !== -1) {
            const existing = globalStore.memories[globalIndex];
            const updated: UserMemoryItem = {
                ...existing,
                category: params.category || existing.category,
                key: params.key ? params.key.trim() : existing.key,
                value: params.value ? params.value.trim() : existing.value,
                updatedAt: new Date().toISOString()
            };
            globalStore.memories[globalIndex] = updated;
            await this.saveGlobalStore(globalStore);
            return updated;
        }

        // Check workspace store
        const wsStore = await this.loadWorkspaceStore(params.workspaceRoot);
        if (wsStore) {
            const wsIndex = wsStore.memories.findIndex(m => m.id === id);
            if (wsIndex !== -1) {
                const existing = wsStore.memories[wsIndex];
                const updated: UserMemoryItem = {
                    ...existing,
                    category: params.category || existing.category,
                    key: params.key ? params.key.trim() : existing.key,
                    value: params.value ? params.value.trim() : existing.value,
                    updatedAt: new Date().toISOString()
                };
                wsStore.memories[wsIndex] = updated;
                await this.saveWorkspaceStore(wsStore, params.workspaceRoot);
                return updated;
            }
        }

        return undefined;
    }

    async deleteMemory(id: string, workspaceRoot?: string): Promise<boolean> {
        // Check global store
        const globalStore = await this.loadGlobalStore();
        const globalIndex = globalStore.memories.findIndex(m => m.id === id);
        if (globalIndex !== -1) {
            globalStore.memories.splice(globalIndex, 1);
            await this.saveGlobalStore(globalStore);
            return true;
        }

        // Check workspace store
        const wsStore = await this.loadWorkspaceStore(workspaceRoot);
        if (wsStore) {
            const wsIndex = wsStore.memories.findIndex(m => m.id === id);
            if (wsIndex !== -1) {
                wsStore.memories.splice(wsIndex, 1);
                await this.saveWorkspaceStore(wsStore, workspaceRoot);
                return true;
            }
        }

        return false;
    }

    async clearCategory(category: UserMemoryCategory, workspaceRoot?: string): Promise<number> {
        let clearedCount = 0;

        // Clear in workspace if available
        const wsStore = await this.loadWorkspaceStore(workspaceRoot);
        if (wsStore) {
            const initialLen = wsStore.memories.length;
            wsStore.memories = wsStore.memories.filter(m => m.category !== category);
            clearedCount += (initialLen - wsStore.memories.length);
            if (clearedCount > 0) {
                await this.saveWorkspaceStore(wsStore, workspaceRoot);
            }
        }

        // Clear in global store as well
        const globalStore = await this.loadGlobalStore();
        const initialGlobalLen = globalStore.memories.length;
        globalStore.memories = globalStore.memories.filter(m => m.category !== category);
        const globalCleared = initialGlobalLen - globalStore.memories.length;
        clearedCount += globalCleared;
        if (globalCleared > 0) {
            await this.saveGlobalStore(globalStore);
        }

        return clearedCount;
    }

    // -------------------------------------------------------------
    // Writing Style Profiles
    // -------------------------------------------------------------

    async createWritingProfile(params: CreateWritingProfileParams): Promise<WritingStyleProfile> {
        const isWorkspace = params.scope === 'workspace';
        const targetStore = isWorkspace
            ? (await this.loadWorkspaceStore(params.workspaceRoot)) || (await this.loadGlobalStore())
            : await this.loadGlobalStore();

        const now = new Date().toISOString();
        const id = `profile-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

        if (params.isActive) {
            // Deactivate other profiles
            targetStore.writingProfiles.forEach(p => { p.isActive = false; });
        }

        const newProfile: WritingStyleProfile = {
            id,
            name: params.name.trim(),
            stylePrompt: params.stylePrompt.trim(),
            samples: params.samples || [],
            isActive: params.isActive ?? (targetStore.writingProfiles.length === 0),
            scope: isWorkspace ? 'workspace' : 'global',
            createdAt: now,
            updatedAt: now
        };

        targetStore.writingProfiles.push(newProfile);

        if (isWorkspace) {
            await this.saveWorkspaceStore(targetStore, params.workspaceRoot);
        } else {
            await this.saveGlobalStore(targetStore);
        }

        return newProfile;
    }

    async listWritingProfiles(workspaceRoot?: string): Promise<WritingStyleProfile[]> {
        const globalStore = await this.loadGlobalStore();
        const wsStore = await this.loadWorkspaceStore(workspaceRoot);
        let list = [...globalStore.writingProfiles];
        if (wsStore) {
            list = list.concat(wsStore.writingProfiles);
        }
        return list;
    }

    async getActiveWritingProfile(workspaceRoot?: string): Promise<WritingStyleProfile | undefined> {
        const wsStore = await this.loadWorkspaceStore(workspaceRoot);
        const wsActive = wsStore?.writingProfiles.find(p => p.isActive);
        if (wsActive) {
            return wsActive;
        }

        const globalStore = await this.loadGlobalStore();
        return globalStore.writingProfiles.find(p => p.isActive);
    }

    async setActiveWritingProfile(profileId: string, workspaceRoot?: string): Promise<boolean> {
        const globalStore = await this.loadGlobalStore();
        let foundInGlobal = false;
        globalStore.writingProfiles.forEach(p => {
            if (p.id === profileId) {
                p.isActive = true;
                foundInGlobal = true;
            } else {
                p.isActive = false;
            }
        });
        if (foundInGlobal) {
            await this.saveGlobalStore(globalStore);
            return true;
        }

        const wsStore = await this.loadWorkspaceStore(workspaceRoot);
        if (wsStore) {
            let foundInWs = false;
            wsStore.writingProfiles.forEach(p => {
                if (p.id === profileId) {
                    p.isActive = true;
                    foundInWs = true;
                } else {
                    p.isActive = false;
                }
            });
            if (foundInWs) {
                await this.saveWorkspaceStore(wsStore, workspaceRoot);
                return true;
            }
        }

        return false;
    }

    async deleteWritingProfile(id: string, workspaceRoot?: string): Promise<boolean> {
        const globalStore = await this.loadGlobalStore();
        const gIdx = globalStore.writingProfiles.findIndex(p => p.id === id);
        if (gIdx !== -1) {
            globalStore.writingProfiles.splice(gIdx, 1);
            await this.saveGlobalStore(globalStore);
            return true;
        }

        const wsStore = await this.loadWorkspaceStore(workspaceRoot);
        if (wsStore) {
            const wIdx = wsStore.writingProfiles.findIndex(p => p.id === id);
            if (wIdx !== -1) {
                wsStore.writingProfiles.splice(wIdx, 1);
                await this.saveWorkspaceStore(wsStore, workspaceRoot);
                return true;
            }
        }

        return false;
    }

    // -------------------------------------------------------------
    // Image & Video Style Preferences
    // -------------------------------------------------------------

    async createStylePreference(params: CreateStylePreferenceParams): Promise<ImageVideoStylePreference> {
        const isWorkspace = params.scope === 'workspace';
        const targetStore = isWorkspace
            ? (await this.loadWorkspaceStore(params.workspaceRoot)) || (await this.loadGlobalStore())
            : await this.loadGlobalStore();

        const now = new Date().toISOString();
        const id = `style-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

        const newStyle: ImageVideoStylePreference = {
            id,
            name: params.name.trim(),
            description: params.description?.trim(),
            stylePrompt: params.stylePrompt.trim(),
            category: params.category || 'visual_composition',
            isDefault: params.isDefault || false,
            sortOrder: params.sortOrder || targetStore.stylePreferences.length,
            scope: isWorkspace ? 'workspace' : 'global',
            createdAt: now,
            updatedAt: now
        };

        targetStore.stylePreferences.push(newStyle);

        if (isWorkspace) {
            await this.saveWorkspaceStore(targetStore, params.workspaceRoot);
        } else {
            await this.saveGlobalStore(targetStore);
        }

        return newStyle;
    }

    async listStylePreferences(options?: { category?: string; workspaceRoot?: string }): Promise<ImageVideoStylePreference[]> {
        const globalStore = await this.loadGlobalStore();
        const wsStore = await this.loadWorkspaceStore(options?.workspaceRoot);
        let list = [...globalStore.stylePreferences];
        if (wsStore) {
            list = list.concat(wsStore.stylePreferences);
        }
        if (options?.category) {
            list = list.filter(s => s.category === options.category);
        }
        return list;
    }

    async deleteStylePreference(id: string, workspaceRoot?: string): Promise<boolean> {
        const globalStore = await this.loadGlobalStore();
        const gIdx = globalStore.stylePreferences.findIndex(s => s.id === id);
        if (gIdx !== -1) {
            globalStore.stylePreferences.splice(gIdx, 1);
            await this.saveGlobalStore(globalStore);
            return true;
        }

        const wsStore = await this.loadWorkspaceStore(workspaceRoot);
        if (wsStore) {
            const wIdx = wsStore.stylePreferences.findIndex(s => s.id === id);
            if (wIdx !== -1) {
                wsStore.stylePreferences.splice(wIdx, 1);
                await this.saveWorkspaceStore(wsStore, workspaceRoot);
                return true;
            }
        }

        return false;
    }

    // -------------------------------------------------------------
    // AI Prompt Injection Synthesis
    // -------------------------------------------------------------

    /**
     * Synthesizes formatted memory instructions to be injected into Gemini system instructions.
     */
    async buildPromptInjectionText(workspaceRoot?: string): Promise<string> {
        const config = await this.getConfig();
        if (!config.enableMemoryInjection) {
            return '';
        }

        const [activeProfile, stylePreferences, allMemories] = await Promise.all([
            this.getActiveWritingProfile(workspaceRoot),
            this.listStylePreferences({ workspaceRoot }),
            this.listMemories({ workspaceRoot })
        ]);

        const maxCount = config.maxInjectedMemories || 40;
        const memories = allMemories.slice(0, maxCount);

        const writingMemories = memories.filter(m => WRITING_STYLE_CATEGORIES.includes(m.category as any));
        const visualMemories = memories.filter(m => VISUAL_STYLE_CATEGORIES.includes(m.category as any));
        const projectMemories = memories.filter(m =>
            PROJECT_CONTEXT_CATEGORIES.includes(m.category as any) ||
            getMemoryCategoryGroup(m.category) === 'project'
        );

        if (!activeProfile && stylePreferences.length === 0 && memories.length === 0) {
            return '';
        }

        let section = '\n\n### ACTIVE USER MEMORIES & LEARNED PREFERENCES:\n';
        section += 'When generating content, canvas artifacts, documents, or creative assets, adhere strictly to the user\'s explicit style rules, active writing profile, and project knowledge:\n';

        // 1. Writing Voice & Style Profile
        if (activeProfile || writingMemories.length > 0) {
            section += '\n#### Writing Voice & Style Rules:\n';
            if (activeProfile) {
                section += `- Active Writing Style Profile (${activeProfile.name}): ${activeProfile.stylePrompt}\n`;
                if (activeProfile.samples && activeProfile.samples.length > 0) {
                    section += `  Sample Reference Prose:\n`;
                    for (const sample of activeProfile.samples) {
                        section += `  > "${sample.trim()}"\n`;
                    }
                }
            }
            for (const mem of writingMemories) {
                section += `- [${formatCategoryLabel(mem.category)}] ${mem.key}: ${mem.value}\n`;
            }
        }

        // 2. Visual & Cinematic Style Preferences
        const defaultStyles = stylePreferences.filter(s => s.isDefault);
        const otherStyles = stylePreferences.filter(s => !s.isDefault).slice(0, 5);
        const activeStyles = [...defaultStyles, ...otherStyles];

        if (activeStyles.length > 0 || visualMemories.length > 0) {
            section += '\n#### Visual & Cinematic Preferences:\n';
            for (const style of activeStyles) {
                section += `- Visual Preset (${style.name}${style.isDefault ? ' - DEFAULT' : ''}): ${style.stylePrompt}\n`;
            }
            for (const mem of visualMemories) {
                section += `- [${formatCategoryLabel(mem.category)}] ${mem.key}: ${mem.value}\n`;
            }
        }

        // 3. Project Context & Grounded Facts
        if (projectMemories.length > 0) {
            section += '\n#### Project Context & Grounded Facts:\n';
            for (const mem of projectMemories) {
                section += `- [${formatCategoryLabel(mem.category)}] ${mem.key}: ${mem.value}\n`;
            }
        }

        return section;
    }
}
