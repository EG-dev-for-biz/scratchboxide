/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** Worktrees settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const WorktreesTab: React.FC = () => {
    const { maxTotalSizeGb, maxWorktrees, setMaxTotalSizeGb, setMaxWorktrees } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">Worktrees</h2>

            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Cleanup</div>
                <p className="text-xs text-zinc-400 mb-2">Scratchbox periodically removes old worktrees to free disk space. Tune how aggressively cleanup runs.</p>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Max Worktrees</div>
                            <div className="sb-cursor-row-desc">Maximum number of Scratchbox-managed worktrees to retain across all workspaces. Older worktrees are removed first.</div>
                        </div>
                        <div className="sb-cursor-stepper">
                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxWorktrees(Math.max(1, maxWorktrees - 5))}>−</button>
                            <span className="sb-stepper-val">{maxWorktrees}</span>
                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxWorktrees(maxWorktrees + 5)}>+</button>
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Max Total Size (GB)</div>
                            <div className="sb-cursor-row-desc">Maximum total size in GB across all Scratchbox-managed worktrees. Set to 0 to disable the size limit.</div>
                        </div>
                        <div className="sb-cursor-stepper">
                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxTotalSizeGb(Math.max(0, maxTotalSizeGb - 10))}>−</button>
                            <span className="sb-stepper-val">{maxTotalSizeGb}</span>
                            <button type="button" className="sb-stepper-btn" onClick={() => setMaxTotalSizeGb(maxTotalSizeGb + 10)}>+</button>
                        </div>
                    </div>
                </div>
            </div>

            <div className="sb-cursor-section-block pt-2">
                <div className="sb-cursor-section-header">Scratchbox-Managed Worktrees</div>
                <div className="p-8 text-center text-xs text-zinc-500 bg-zinc-900/40 rounded-xl border border-dashed border-zinc-800">
                    No Scratchbox-managed worktrees on this machine.
                </div>
            </div>
        </div>
    );
};
