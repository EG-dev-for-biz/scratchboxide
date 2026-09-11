/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
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


export function useCapabilities() {
    // Capabilities & Live Tools state
    const [skills, setSkills] = React.useState<SkillItem[]>(DEFAULT_SKILLS_CATALOG);
    const [mcpServers, setMcpServers] = React.useState<McpServerItem[]>(DEFAULT_MCP_SERVERS);
    const [mcpExecutions, setMcpExecutions] = React.useState<McpExecutionState[]>([]);
    const [googleSearchGrounding, setGoogleSearchGrounding] = React.useState<boolean>(() => {
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('scratchbox_google_search_grounding');
            if (saved !== null) return saved === 'true';
        }
        return true;
    });

    const [, setGeminiStatus] = React.useState<GeminiStatus | undefined>(undefined);

    // Check Gemini 3.7 Flash Backend Status
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
                    activeModel: 'gemini-3.7-flash',
                    availableModels: ['gemini-3.7-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
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
                setSkills(prev => {
                    const existingIds = new Set(prev.map(s => s.id));
                    const newSkills = cfg.customSkills.filter(s => !existingIds.has(s.id));
                    return [...newSkills, ...prev];
                });
            }
            if (cfg.customMcpServers && cfg.customMcpServers.length > 0) {
                setMcpServers(prev => {
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
