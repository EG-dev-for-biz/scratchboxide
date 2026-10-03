/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** WorkspaceTab content of the Customize settings group. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const WorkspaceTab: React.FC = () => {
    const { activeWorkspace, onCreateFile, onOpenFolder, onOpenWorkspace, workspaceRules } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Workspace Rules</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
                Active workspace configuration, project root bindings, and custom AI behavior directives.
            </p>

            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Active Workspace</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Workspace Root Directory</div>
                            <div className="sb-cursor-row-desc font-mono text-xs text-zinc-600 dark:text-zinc-300 mt-0.5">
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
            </div>

            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header flex items-center justify-between">
                    <span>Project Directives (.scratchbox/rules/*.md)</span>
                    <span className="sb-badge-unified sb-badge-zinc font-mono">{workspaceRules.length} rules</span>
                </div>
                <div className="sb-cursor-group-card">
                    {workspaceRules.length === 0 ? (
                        <div className="sb-cursor-row-item">
                            <div className="sb-cursor-row-desc">
                                No custom rules found in <code>.scratchbox/rules/</code>. Create <code>SCRATCHBOX.md</code> or <code>AGENTS.md</code> to add directives.
                            </div>
                        </div>
                    ) : (
                        workspaceRules.map(rule => (
                            <div key={rule.id} className="sb-cursor-row-item">
                                <div className="sb-cursor-row-info">
                                    <div className="sb-cursor-row-title">{rule.title || (rule as any).name || 'Rule'}</div>
                                    <div className="sb-cursor-row-desc font-mono">{rule.content.slice(0, 120)}...</div>
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
};
