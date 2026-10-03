/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** CodeIntelligence settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const CodeIntelligenceTab: React.FC = () => {
    const { enableLsps, enableLspsWorktrees, hierarchicalCursorIgnore, ignoreSymlinks, indexRepositoriesGrep, maxLocalLspWorkspaces, maxRemoteLspWorkspaces, setEnableLsps, setEnableLspsWorktrees, setHierarchicalCursorIgnore, setIgnoreSymlinks, setIndexRepositoriesGrep, setMaxLocalLspWorkspaces, setMaxRemoteLspWorkspaces } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Code Intelligence</h2>

            {/* Codebase */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Codebase</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Index Repositories for Instant Grep</div>
                            <div className="sb-cursor-row-desc">Automatically index repositories to speed up Grep searches. All data is stored locally.</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={indexRepositoriesGrep}
                            className={`sb-cursor-toggle ${indexRepositoriesGrep ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setIndexRepositoriesGrep(!indexRepositoriesGrep)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Ignore Files */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Ignore Files</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Hierarchical Scratchbox Ignore</div>
                            <div className="sb-cursor-row-desc">Apply .scratchboxignore files to all subdirectories. Changing this setting requires restarting Scratchbox.</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={hierarchicalCursorIgnore}
                            className={`sb-cursor-toggle ${hierarchicalCursorIgnore ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setHierarchicalCursorIgnore(!hierarchicalCursorIgnore)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Ignore Symlinks in Scratchbox Ignore Search</div>
                            <div className="sb-cursor-row-desc">Use with caution. Skip symlinks during ignore file discovery. Enable only when all ignore files are reachable without symlinks. Changing this setting requires restarting Scratchbox.</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={ignoreSymlinks}
                            className={`sb-cursor-toggle ${ignoreSymlinks ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setIgnoreSymlinks(!ignoreSymlinks)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* LSP */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">LSP</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Enable LSPs</div>
                            <div className="sb-cursor-row-desc">Enable language server by default to provide code intelligence in workspaces</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={enableLsps}
                            className={`sb-cursor-toggle ${enableLsps ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setEnableLsps(!enableLsps)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Enable LSPs for Worktrees</div>
                            <div className="sb-cursor-row-desc">Enable language server by default to provide code intelligence in agent worktree workspaces</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={enableLspsWorktrees}
                            className={`sb-cursor-toggle ${enableLspsWorktrees ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setEnableLspsWorktrees(!enableLspsWorktrees)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Maximum Local LSP Workspaces</div>
                            <div className="sb-cursor-row-desc">Maximum local workspaces that can run language servers at the same time</div>
                        </div>
                        <div className="sb-cursor-stepper">
                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxLocalLspWorkspaces(Math.max(1, maxLocalLspWorkspaces - 1))}>−</button>
                            <span className="sb-stepper-val">{maxLocalLspWorkspaces}</span>
                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxLocalLspWorkspaces(maxLocalLspWorkspaces + 1)}>+</button>
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Maximum Remote LSP Workspaces</div>
                            <div className="sb-cursor-row-desc">Maximum remote workspaces that can run language servers at the same time</div>
                        </div>
                        <div className="sb-cursor-stepper">
                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxRemoteLspWorkspaces(Math.max(1, maxRemoteLspWorkspaces - 1))}>−</button>
                            <span className="sb-stepper-val">{maxRemoteLspWorkspaces}</span>
                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxRemoteLspWorkspaces(maxRemoteLspWorkspaces + 1)}>+</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
