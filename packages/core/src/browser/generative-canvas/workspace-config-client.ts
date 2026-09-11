/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    CanvasArtifact,
    DiscoveredExternalMcpSource,
    McpServerItem,
    SkillItem
} from './canvas-types';

export interface ProjectRule {
    id: string;
    title: string;
    content: string;
    path: string;
    isRootDirectives?: boolean;
}

export interface WorkspaceSettings {
    glassBlur?: 'subtle' | 'standard' | 'vibrant';
    canvasDensity?: 'spacious' | 'standard' | 'compact';
    enableSpringMotion?: boolean;
    showLineNumbersInCode?: boolean;
    autoAttachSuperpowers?: boolean;
    hapticFeedback?: boolean;
    defaultModel?: string;
    thinkingBudget?: number;
    customPromptInstructions?: string;
    [key: string]: any;
}

export interface FullWorkspaceConfig {
    workspaceRoot: string;
    settings?: WorkspaceSettings;
    rules: ProjectRule[];
    customSkills: SkillItem[];
    customMcpServers: McpServerItem[];
}

export interface ArtifactSyncResult {
    success: boolean;
    writtenFiles: string[];
    targetPath: string;
    error?: string;
}

export class WorkspaceConfigClient {
    private static instance: WorkspaceConfigClient;

    public static getInstance(): WorkspaceConfigClient {
        if (!WorkspaceConfigClient.instance) {
            WorkspaceConfigClient.instance = new WorkspaceConfigClient();
        }
        return WorkspaceConfigClient.instance;
    }

    protected endpoint(): string {
        return '/workspace';
    }

    /**
     * Fetch full workspace configuration including rules, custom skills, and MCP servers.
     */
    async fetchWorkspaceConfig(workspaceRoot?: string): Promise<FullWorkspaceConfig> {
        try {
            const url = workspaceRoot
                ? `${this.endpoint()}/config?root=${encodeURIComponent(workspaceRoot)}`
                : `${this.endpoint()}/config`;

            const res = await fetch(url, {
                method: 'GET',
                headers: { Accept: 'application/json' }
            });

            if (res.ok) {
                return await res.json();
            }
        } catch (e) {
            console.warn('Failed to fetch workspace config from backend', e);
        }

        return {
            workspaceRoot: workspaceRoot || '/workspace',
            rules: [],
            customSkills: [],
            customMcpServers: []
        };
    }

    /**
     * Persist workspace configuration to .scratchbox/config.json.
     */
    async saveWorkspaceConfig(
        workspaceRoot: string,
        config: { settings?: WorkspaceSettings; customSkills?: SkillItem[]; customMcpServers?: McpServerItem[] }
    ): Promise<{ success: boolean; message?: string }> {
        try {
            const res = await fetch(`${this.endpoint()}/config`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    workspaceRoot,
                    ...config
                })
            });

            if (res.ok) {
                return await res.json();
            }
        } catch (e: any) {
            console.warn('Failed to save workspace config', e);
            return { success: false, message: e.message };
        }

        return { success: false, message: 'Server error' };
    }

    /**
     * Sync a visual canvas artifact directly to workspace files.
     */
    async syncArtifactToWorkspace(
        artifact: CanvasArtifact,
        targetSubdir?: string,
        workspaceRoot?: string
    ): Promise<ArtifactSyncResult> {
        try {
            const res = await fetch(`${this.endpoint()}/sync-artifact`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    workspaceRoot,
                    artifact,
                    targetSubdir
                })
            });

            if (res.ok) {
                return await res.json();
            }
            const err = await res.text();
            return { success: false, writtenFiles: [], targetPath: '', error: err };
        } catch (e: any) {
            return {
                success: false,
                writtenFiles: [],
                targetPath: '',
                error: e.message || 'Network error syncing artifact'
            };
        }
    }

    /**
     * Atomically write a map of files to the workspace disk.
     */
    async writeLensFiles(
        files: Record<string, string>,
        workspaceRoot?: string
    ): Promise<{ success: boolean; writtenFiles?: string[]; error?: string }> {
        try {
            const res = await fetch(`${this.endpoint()}/write-lens-files`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    workspaceRoot,
                    files
                })
            });

            if (res.ok) {
                return await res.json();
            }
            const err = await res.text();
            return { success: false, error: err };
        } catch (e: any) {
            return {
                success: false,
                error: e.message || 'Network error writing lens files'
            };
        }
    }

    /**
     * Register a content hash with backend file watcher to suppress echo loops.
     */
    async registerHash(filePath: string, hash: string): Promise<boolean> {
        try {
            const res = await fetch(`${this.endpoint()}/register-hash`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({ filePath, hash })
            });
            return res.ok;
        } catch (e) {
            return false;
        }
    }

    /**
     * Subscribe to live workspace filesystem change events via SSE.
     */
    subscribeToFileChanges(
        onEvent: (event: { type: string; path: string; fileType?: string }) => void,
        workspaceRoot?: string
    ): () => void {
        if (typeof window === 'undefined' || !window.EventSource) {
            return () => {};
        }

        const url = workspaceRoot
            ? `${this.endpoint()}/events/file-change?root=${encodeURIComponent(workspaceRoot)}`
            : `${this.endpoint()}/events/file-change`;

        const eventSource = new EventSource(url);

        eventSource.onmessage = (e) => {
            try {
                const data = JSON.parse(e.data);
                onEvent(data);
            } catch (err) {
                console.warn('Failed to parse SSE file change event', err);
            }
        };

        eventSource.onerror = () => {
            // Reconnection handled automatically by EventSource
        };

        return () => {
            eventSource.close();
        };
    }

    /**
     * Auto-discover external MCP configurations from Claude Desktop and Cursor.
     */
    async discoverExternalMcp(): Promise<DiscoveredExternalMcpSource[]> {
        try {
            const res = await fetch(`${this.endpoint()}/external-mcp`, {
                method: 'GET',
                headers: { Accept: 'application/json' }
            });
            if (res.ok) {
                const data = await res.json();
                return data.sources || [];
            }
        } catch (e) {
            console.warn('Failed to discover external MCP configs', e);
        }
        return [];
    }

    /**
     * Import selected external MCP servers into project workspace.
     */
    async importExternalMcp(
        servers: McpServerItem[],
        workspaceRoot?: string
    ): Promise<{ success: boolean; count?: number; servers?: McpServerItem[]; error?: string }> {
        try {
            const res = await fetch(`${this.endpoint()}/import-mcp`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    workspaceRoot,
                    servers
                })
            });
            if (res.ok) {
                return await res.json();
            }
            const err = await res.text();
            return { success: false, error: err };
        } catch (e: any) {
            return { success: false, error: e.message || 'Failed to import MCP servers' };
        }
    }
}
