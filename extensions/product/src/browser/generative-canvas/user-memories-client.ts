/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    ImageVideoStylePreference,
    MemoryCategoryGroup,
    UserMemoriesConfig,
    UserMemoryCategory,
    UserMemoryItem,
    WritingStyleProfile
} from './canvas-types';

export class UserMemoriesClient {
    private static instance: UserMemoriesClient;

    public static getInstance(): UserMemoriesClient {
        if (!UserMemoriesClient.instance) {
            UserMemoriesClient.instance = new UserMemoriesClient();
        }
        return UserMemoriesClient.instance;
    }

    protected endpoint(): string {
        return '/gemini/memories';
    }

    /**
     * List user memories with optional filtering.
     */
    async getMemories(options?: {
        category?: string;
        categoryGroup?: MemoryCategoryGroup;
        searchQuery?: string;
        scope?: 'global' | 'workspace' | 'all';
        workspaceRoot?: string;
    }): Promise<UserMemoryItem[]> {
        try {
            const params = new URLSearchParams();
            if (options?.category) {
                params.append('category', options.category);
            }
            if (options?.categoryGroup && options.categoryGroup !== 'all') {
                params.append('categoryGroup', options.categoryGroup);
            }
            if (options?.searchQuery) {
                params.append('searchQuery', options.searchQuery);
            }
            if (options?.scope) {
                params.append('scope', options.scope);
            }
            if (options?.workspaceRoot) {
                params.append('workspaceRoot', options.workspaceRoot);
            }

            const qs = params.toString();
            const url = qs ? `${this.endpoint()}?${qs}` : this.endpoint();
            const res = await fetch(url, {
                method: 'GET',
                headers: { Accept: 'application/json' }
            });

            if (res.ok) {
                const data = await res.json();
                return data.memories || [];
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to fetch memories:', e);
        }
        return [];
    }

    /**
     * Create a new memory item.
     */
    async createMemory(params: {
        category: UserMemoryCategory;
        key: string;
        value: string;
        scope?: 'global' | 'workspace';
        workspaceId?: string;
        workspaceRoot?: string;
    }): Promise<UserMemoryItem | undefined> {
        try {
            const res = await fetch(`${this.endpoint()}/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });

            if (res.ok) {
                const data = await res.json();
                return data.memory;
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to create memory:', e);
        }
        return undefined;
    }

    /**
     * Update an existing memory item.
     */
    async updateMemory(
        id: string,
        params: {
            category?: UserMemoryCategory;
            key?: string;
            value?: string;
            workspaceRoot?: string;
        }
    ): Promise<UserMemoryItem | undefined> {
        try {
            const res = await fetch(`${this.endpoint()}/update`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, ...params })
            });

            if (res.ok) {
                const data = await res.json();
                return data.memory;
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to update memory:', e);
        }
        return undefined;
    }

    /**
     * Delete a memory item.
     */
    async deleteMemory(id: string, workspaceRoot?: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.endpoint()}/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, workspaceRoot })
            });

            if (res.ok) {
                const data = await res.json();
                return !!data.success;
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to delete memory:', e);
        }
        return false;
    }

    /**
     * Clear all memories within a category.
     */
    async clearCategory(category: UserMemoryCategory, workspaceRoot?: string): Promise<number> {
        try {
            const res = await fetch(`${this.endpoint()}/clear-category`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ category, workspaceRoot })
            });

            if (res.ok) {
                const data = await res.json();
                return data.clearedCount || 0;
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to clear category:', e);
        }
        return 0;
    }

    /**
     * Get Writing Style Profiles.
     */
    async getWritingProfiles(workspaceRoot?: string): Promise<{
        profiles: WritingStyleProfile[];
        activeProfile?: WritingStyleProfile;
    }> {
        try {
            const url = workspaceRoot
                ? `${this.endpoint()}/writing-profiles?workspaceRoot=${encodeURIComponent(workspaceRoot)}`
                : `${this.endpoint()}/writing-profiles`;

            const res = await fetch(url, {
                method: 'GET',
                headers: { Accept: 'application/json' }
            });

            if (res.ok) {
                const data = await res.json();
                return {
                    profiles: data.profiles || [],
                    activeProfile: data.activeProfile
                };
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to fetch writing profiles:', e);
        }
        return { profiles: [] };
    }

    /**
     * Create Writing Style Profile.
     */
    async createWritingProfile(params: {
        name: string;
        stylePrompt: string;
        samples?: string[];
        isActive?: boolean;
        scope?: 'global' | 'workspace';
        workspaceRoot?: string;
    }): Promise<WritingStyleProfile | undefined> {
        try {
            const res = await fetch(`${this.endpoint()}/writing-profiles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'create', ...params })
            });

            if (res.ok) {
                const data = await res.json();
                return data.profile;
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to create writing profile:', e);
        }
        return undefined;
    }

    /**
     * Set active writing style profile.
     */
    async setActiveWritingProfile(profileId: string, workspaceRoot?: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.endpoint()}/writing-profiles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'set-active', id: profileId, workspaceRoot })
            });

            if (res.ok) {
                const data = await res.json();
                return !!data.success;
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to set active writing profile:', e);
        }
        return false;
    }

    /**
     * Delete writing style profile.
     */
    async deleteWritingProfile(id: string, workspaceRoot?: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.endpoint()}/writing-profiles`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', id, workspaceRoot })
            });

            if (res.ok) {
                const data = await res.json();
                return !!data.success;
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to delete writing profile:', e);
        }
        return false;
    }

    /**
     * Get Style Preferences (Image/Video).
     */
    async getStylePreferences(options?: {
        category?: string;
        workspaceRoot?: string;
    }): Promise<ImageVideoStylePreference[]> {
        try {
            const params = new URLSearchParams();
            if (options?.category) {
                params.append('category', options.category);
            }
            if (options?.workspaceRoot) {
                params.append('workspaceRoot', options.workspaceRoot);
            }

            const qs = params.toString();
            const url = qs ? `${this.endpoint()}/style-preferences?${qs}` : `${this.endpoint()}/style-preferences`;
            const res = await fetch(url, {
                method: 'GET',
                headers: { Accept: 'application/json' }
            });

            if (res.ok) {
                const data = await res.json();
                return data.preferences || [];
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to fetch style preferences:', e);
        }
        return [];
    }

    /**
     * Create Style Preference.
     */
    async createStylePreference(params: {
        name: string;
        description?: string;
        stylePrompt: string;
        category?: string;
        isDefault?: boolean;
        sortOrder?: number;
        scope?: 'global' | 'workspace';
        workspaceRoot?: string;
    }): Promise<ImageVideoStylePreference | undefined> {
        try {
            const res = await fetch(`${this.endpoint()}/style-preferences`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'create', ...params })
            });

            if (res.ok) {
                const data = await res.json();
                return data.preference;
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to create style preference:', e);
        }
        return undefined;
    }

    /**
     * Delete Style Preference.
     */
    async deleteStylePreference(id: string, workspaceRoot?: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.endpoint()}/style-preferences`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', id, workspaceRoot })
            });

            if (res.ok) {
                const data = await res.json();
                return !!data.success;
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to delete style preference:', e);
        }
        return false;
    }

    /**
     * Get memories configuration.
     */
    async getConfig(): Promise<UserMemoriesConfig> {
        try {
            const res = await fetch(`${this.endpoint()}/config`, {
                method: 'GET',
                headers: { Accept: 'application/json' }
            });

            if (res.ok) {
                const data = await res.json();
                return data.config || { enableMemoryInjection: true };
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to get config:', e);
        }
        return { enableMemoryInjection: true };
    }

    /**
     * Update memories configuration.
     */
    async updateConfig(config: Partial<UserMemoriesConfig>): Promise<UserMemoriesConfig> {
        try {
            const res = await fetch(`${this.endpoint()}/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            });

            if (res.ok) {
                const data = await res.json();
                return data.config || { enableMemoryInjection: true };
            }
        } catch (e) {
            console.warn('[UserMemoriesClient] Failed to update config:', e);
        }
        return { enableMemoryInjection: true };
    }
}
