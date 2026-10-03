/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { IconFolder, IconSparkles } from '../../canvas-icons';
import { useSettingsContext } from '../SettingsContext';

export const GeneralTab: React.FC = () => {
    const {
        activeWorkspace,
        onOpenFolder,
        onOpenWorkspace,
        onCreateFile,
        setActiveTab,
        workspaceRules
    } = useSettingsContext();

    return (
        <div className="sb-cursor-settings-content animate-fadeIn space-y-4">
            <div>
                <h2 className="sb-cursor-content-title">General Settings</h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                    Workspace directory management, file creation, and project configuration.
                </p>
            </div>

            {/* Workspace & Project Group */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Workspace &amp; Project</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="flex items-center gap-2">
                                <IconFolder size={14} className="text-blue-500" />
                                <span className="sb-cursor-row-title">Active Workspace Root</span>
                            </div>
                            <div className="sb-cursor-row-desc font-mono text-xs text-zinc-600 dark:text-zinc-300 select-all">
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

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="flex items-center gap-2">
                                <IconSparkles size={14} className="text-amber-500" />
                                <span className="sb-cursor-row-title">Workspace Directives &amp; Rules</span>
                            </div>
                            <div className="sb-cursor-row-desc">
                                {workspaceRules.length > 0
                                    ? `${workspaceRules.length} active rule${workspaceRules.length > 1 ? 's' : ''} loaded from .scratchbox/rules/ and AGENTS.md`
                                    : 'Configure project directives, styling guidelines, and agent instructions'}
                            </div>
                        </div>
                        <button
                            type="button"
                            className="sb-cursor-row-btn"
                            onClick={() => setActiveTab('workspace')}
                        >
                            <span>Manage Rules →</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
