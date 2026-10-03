/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
    CanvasArtifact,
    DiscoveredExternalMcpSource,
    McpServerItem,
    SkillItem
} from './canvas-types';
import type { FileTreeNode } from '../../common/workspace-sync-protocol';

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
     * Auto-discover external MCP configurations from Claude Desktop and external IDEs.
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

    /**
     * Fetch real file content from disk.
     */
    async fetchFileContent(filePath: string, workspaceRoot?: string): Promise<{ success: boolean; content?: string; size?: number; isBinary?: boolean; error?: string }> {
        try {
            const rootParam = workspaceRoot ? `&root=${encodeURIComponent(workspaceRoot)}` : '';
            const res = await fetch(`${this.endpoint()}/file-content?path=${encodeURIComponent(filePath)}${rootParam}`);
            if (res.ok) {
                return await res.json();
            }
            return { success: false, error: `HTTP ${res.status}` };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Save updated file content to disk.
     */
    async saveFileContent(filePath: string, content: string, workspaceRoot?: string): Promise<{ success: boolean; path?: string; size?: number; error?: string }> {
        try {
            const res = await fetch(`${this.endpoint()}/file-content`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json'
                },
                body: JSON.stringify({
                    workspaceRoot,
                    path: filePath,
                    content
                })
            });
            if (res.ok) {
                return await res.json();
            }
            return { success: false, error: `HTTP ${res.status}` };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }

    /**
     * Fetch workspace directory tree.
     */
    async fetchDirectoryTree(workspaceRoot?: string, maxDepth: number = 6): Promise<{ success: boolean; files?: FileTreeNode[]; error?: string }> {
        try {
            const rootParam = workspaceRoot ? `?root=${encodeURIComponent(workspaceRoot)}&maxDepth=${maxDepth}` : `?maxDepth=${maxDepth}`;
            const res = await fetch(`${this.endpoint()}/files${rootParam}`);
            if (res.ok) {
                return await res.json();
            }
            return { success: false, error: `HTTP ${res.status}` };
        } catch (e: any) {
            return { success: false, error: e.message };
        }
    }
}
