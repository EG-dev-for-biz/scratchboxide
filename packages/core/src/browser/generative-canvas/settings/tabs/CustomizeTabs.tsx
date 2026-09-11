/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Customize group (Workspace rules, Skills, MCP, Shortcuts, About) with its shared header and sub-tab strip. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { AboutTab } from './AboutTab';
import { McpTab } from './McpTab';
import { ShortcutsTab } from './ShortcutsTab';
import { SkillsTab } from './SkillsTab';
import { WorkspaceTab } from './WorkspaceTab';
import { useSettingsContext } from '../SettingsContext';

export const CustomizeTabs: React.FC = () => {
    const { activeTab, mcpServers, memories, setActiveTab, skills, workspaceRules } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h2 className="sb-cursor-content-title">
                        {activeTab === 'shortcuts' ? 'Keyboard Shortcuts' :
                         activeTab === 'about' ? 'About Scratchbox IDE' :
                         'Customize Studio'}
                    </h2>
                    <p className="text-xs text-zinc-400">
                        {activeTab === 'shortcuts' ? 'Global keystrokes and rapid navigation bindings.' :
                         activeTab === 'about' ? 'Universal AI Software Architecture & Intelligence Environment.' :
                         'Manage project rules, superpowers (skills), and MCP connections.'}
                    </p>
                </div>
                {(activeTab === 'workspace' || activeTab === 'skills' || activeTab === 'mcp') && (
                    <div className="flex items-center gap-1.5 bg-zinc-900/80 p-1 rounded-xl border border-zinc-800/80">
                        <button
                            type="button"
                            className={`sb-segment-btn ${activeTab === 'workspace' ? 'sb-segment-active' : ''}`}
                            onClick={() => setActiveTab('workspace')}
                        >
                            Rules ({workspaceRules.length})
                        </button>
                        <button
                            type="button"
                            className={`sb-segment-btn ${activeTab === 'skills' ? 'sb-segment-active' : ''}`}
                            onClick={() => setActiveTab('skills')}
                        >
                            Skills ({skills.filter(s => s.isEnabled).length})
                        </button>
                        <button
                            type="button"
                            className={`sb-segment-btn ${activeTab === 'mcp' ? 'sb-segment-active' : ''}`}
                            onClick={() => setActiveTab('mcp')}
                        >
                            MCPs ({mcpServers.filter(s => s.isEnabled).length})
                        </button>
                        <button
                            type="button"
                            className="sb-segment-btn"
                            onClick={() => setActiveTab('memories')}
                        >
                            Memories ({memories.length})
                        </button>
                    </div>
                )}
            </div>

            {activeTab === 'workspace' && <WorkspaceTab />}

            {activeTab === 'skills' && <SkillsTab />}

            {activeTab === 'mcp' && <McpTab />}

            {activeTab === 'shortcuts' && <ShortcutsTab />}

            {activeTab === 'about' && <AboutTab />}
        </div>
    );
};
