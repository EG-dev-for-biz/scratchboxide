/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** WorkspaceTab content of the Customize settings group. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const WorkspaceTab: React.FC = () => {
    const { activeWorkspace, onCreateFile, onOpenFolder, onOpenWorkspace, workspaceRules } = useSettingsContext();
    return (
        <div className="space-y-4">
            <div className="sb-cursor-group-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <div>
                        <h4 className="text-xs font-semibold text-zinc-200">Active Workspace Root</h4>
                        <div className="text-[11px] text-zinc-400 font-mono mt-0.5">
                            {activeWorkspace?.path || (typeof process !== 'undefined' && process.cwd ? process.cwd() : '~')}
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {onOpenFolder && (
                            <button
                                type="button"
                                className="sb-cursor-row-btn"
                                onClick={onOpenFolder}
                                title="Open Local Folder"
                            >
                                <span>Open Folder...</span>
                            </button>
                        )}
                        {onOpenWorkspace && (
                            <button
                                type="button"
                                className="sb-cursor-row-btn"
                                onClick={onOpenWorkspace}
                                title="Open Workspace"
                            >
                                <span>Open Workspace...</span>
                            </button>
                        )}
                        {onCreateFile && (
                            <button
                                type="button"
                                className="sb-cursor-row-btn"
                                onClick={onCreateFile}
                                title="Create New File"
                            >
                                <span>New File</span>
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div className="sb-cursor-group-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <h4 className="text-xs font-semibold text-zinc-200">Active Project Rules (.scratchbox/rules/*.md &amp; .cursorrules)</h4>
                    <span className="text-[11px] text-zinc-500 font-mono">{workspaceRules.length} rules</span>
                </div>
                {workspaceRules.length === 0 ? (
                    <div className="text-xs text-zinc-400 p-3 bg-zinc-900/40 rounded-xl border border-dashed border-zinc-800">
                        No custom rules found in <code>.scratchbox/rules/</code>. Create <code>SCRATCHBOX.md</code> or <code>.cursorrules</code> to add directives.
                    </div>
                ) : (
                    <div className="space-y-2">
                        {workspaceRules.map(rule => (
                            <div key={rule.id} className="p-3 bg-zinc-900/60 rounded-xl border border-zinc-800 text-xs">
                                <div className="font-semibold text-zinc-200">{rule.title || (rule as any).name || 'Rule'}</div>
                                <div className="text-[11px] text-zinc-400 mt-1 font-mono">{rule.content.slice(0, 120)}...</div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
