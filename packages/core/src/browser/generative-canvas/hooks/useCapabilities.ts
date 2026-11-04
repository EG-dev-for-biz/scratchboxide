/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * useCapabilities
 *
 * Skills / MCP catalog state, Google Search grounding toggle and the Gemini backend status + workspace config bootstrap effect.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { GeminiStatus } from '../../../common/gemini-protocol';
import { DEFAULT_MCP_SERVERS, DEFAULT_SKILLS_CATALOG, McpExecutionState, McpServerItem, SkillItem } from '../canvas-types';
import { GeminiClient } from '../gemini-client';
import { WorkspaceConfigClient } from '../workspace-config-client';


const REMOVED_LEGACY_SKILL_IDS = new Set([
    'skill-frontend-designer',
    'skill-apple-hig',
    'skill-market-analyst',
    'skill-copywriter',
    'skill-cloud-architect',
    'skill-research-agent'
]);

export function useCapabilities() {
    // Capabilities & Live Tools state
    const [skills, setSkillsState] = React.useState<SkillItem[]>(() => {
        if (typeof localStorage !== 'undefined') {
            try {
                const saved = localStorage.getItem('scratchbox_custom_skills');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        const existingIds = new Set(DEFAULT_SKILLS_CATALOG.map(s => s.id));
                        const uniqueCustom = parsed.filter(
                            (s: SkillItem) => !REMOVED_LEGACY_SKILL_IDS.has(s.id) && !existingIds.has(s.id)
                        );
                        if (uniqueCustom.length !== parsed.length) {
                            try {
                                localStorage.setItem('scratchbox_custom_skills', JSON.stringify(uniqueCustom));
                            } catch {}
                        }
                        return [...uniqueCustom, ...DEFAULT_SKILLS_CATALOG];
                    }
                }
            } catch {
                // Ignore parse errors
            }
        }
        return DEFAULT_SKILLS_CATALOG;
    });

    const [mcpServers, setMcpServersState] = React.useState<McpServerItem[]>(() => {
        if (typeof localStorage !== 'undefined') {
            try {
                const saved = localStorage.getItem('scratchbox_custom_mcp_servers');
                if (saved) {
                    const parsed = JSON.parse(saved);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        const existingIds = new Set(DEFAULT_MCP_SERVERS.map(s => s.id));
                        const uniqueCustom = parsed.filter((s: McpServerItem) => !existingIds.has(s.id));
                        return [...uniqueCustom, ...DEFAULT_MCP_SERVERS];
                    }
                }
            } catch {
                // Ignore parse errors
            }
        }
        return DEFAULT_MCP_SERVERS;
    });

    const [mcpExecutions, setMcpExecutions] = React.useState<McpExecutionState[]>([]);
    const [googleSearchGrounding, setGoogleSearchGrounding] = React.useState<boolean>(() => {
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('scratchbox_google_search_grounding');
            if (saved !== null) return saved === 'true';
        }
        return true;
    });

    const [, setGeminiStatus] = React.useState<GeminiStatus | undefined>(undefined);

    const persistSkills = React.useCallback((nextSkills: SkillItem[]) => {
        const customSkills = nextSkills.filter(
            s => !REMOVED_LEGACY_SKILL_IDS.has(s.id) && (s.isCustom || !DEFAULT_SKILLS_CATALOG.some(d => d.id === s.id))
        );
        if (typeof localStorage !== 'undefined') {
            try {
                localStorage.setItem('scratchbox_custom_skills', JSON.stringify(customSkills));
            } catch {}
        }
        WorkspaceConfigClient.getInstance().saveWorkspaceConfig('', { customSkills }).catch(() => {});
    }, []);

    const persistMcpServers = React.useCallback((nextServers: McpServerItem[]) => {
        const customMcpServers = nextServers.filter(
            s => s.id.startsWith('mcp-custom-') || !DEFAULT_MCP_SERVERS.some(d => d.id === s.id)
        );
        if (typeof localStorage !== 'undefined') {
            try {
                localStorage.setItem('scratchbox_custom_mcp_servers', JSON.stringify(customMcpServers));
            } catch {}
        }
        WorkspaceConfigClient.getInstance().saveWorkspaceConfig('', { customMcpServers }).catch(() => {});
    }, []);

    const setSkills = React.useCallback((action: React.SetStateAction<SkillItem[]>) => {
        setSkillsState(prev => {
            const next = typeof action === 'function' ? action(prev) : action;
            persistSkills(next);
            return next;
        });
    }, [persistSkills]);

    const setMcpServers = React.useCallback((action: React.SetStateAction<McpServerItem[]>) => {
        setMcpServersState(prev => {
            const next = typeof action === 'function' ? action(prev) : action;
            persistMcpServers(next);
            return next;
        });
    }, [persistMcpServers]);

    // Check Gemini 3.8 Flash Backend Status
    React.useEffect(() => {
        let cancelled = false;
        GeminiClient.getInstance()
            .checkStatus()
            .then(status => {
                if (cancelled) return;
                setGeminiStatus(status);
            })
            .catch(() => {
                if (cancelled) return;
                setGeminiStatus({
                    connected: false,
                    activeModel: 'gemini-3.8-flash',
                    availableModels: ['gemini-3.8-flash', 'gemini-4-argon', 'gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
                    thinkingBudget: 1024,
                    authMethod: 'unauthenticated'
                });
            });

        // Discover and load workspace-specific superpowers (.scratchbox/skills) & MCP servers (.scratchbox/mcp.json)
        WorkspaceConfigClient.getInstance().fetchWorkspaceConfig().then(cfg => {
            if (cancelled) return;
            if (cfg.settings?.googleSearchGrounding !== undefined) {
                setGoogleSearchGrounding(cfg.settings.googleSearchGrounding);
            }
            if (cfg.customSkills && cfg.customSkills.length > 0) {
                setSkillsState(prev => {
                    const existingIds = new Set(prev.map(s => s.id));
                    const newSkills = cfg.customSkills.filter(s => !existingIds.has(s.id));
                    return [...newSkills, ...prev];
                });
            }
            if (cfg.customMcpServers && cfg.customMcpServers.length > 0) {
                setMcpServersState(prev => {
                    const existingIds = new Set(prev.map(s => s.id));
                    const newMcp = cfg.customMcpServers.filter(s => !existingIds.has(s.id));
                    return [...newMcp, ...prev];
                });
            }
        }).catch(() => {
            // Workspace config is optional; keep bundled defaults.
        });
        return () => {
            cancelled = true;
        };
    }, []);

    return { googleSearchGrounding, mcpExecutions, mcpServers, setGoogleSearchGrounding, setMcpExecutions, setMcpServers, setSkills, skills };
}
