/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** General settings tab. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { IconExternalLink, IconLock } from '../../canvas-icons';
import { useSettingsContext } from '../SettingsContext';

export const GeneralTab: React.FC = () => {
    const { activeWorkspace, completionSound, continueInterruptedAgents, menuBarIcon, onOpenFolder, onOpenWorkspace, privacyMode, setActiveTab, setCompletionSound, setContinueInterruptedAgents, setMenuBarIcon, setPrivacyMode, setSystemNotifications, setTipsEnabled, setWarningNotifications, setWindowRestoration, systemNotifications, tipsEnabled, warningNotifications, windowRestoration, workspaceRules } = useSettingsContext();
    const [isLoggedOut, setIsLoggedOut] = React.useState(false);
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <h2 className="sb-cursor-content-title">General</h2>

            {/* Scratchbox Account */}
            <div className="sb-cursor-group-card">
                <div className="sb-cursor-row-item">
                    <div className="sb-cursor-row-info">
                        <div className="sb-cursor-row-title">Scratchbox Account</div>
                        <div className="sb-cursor-row-desc">Manage your developer profile and preferences</div>
                    </div>
                    <button
                        type="button"
                        className="sb-cursor-row-btn"
                        onClick={() => setActiveTab('profile')}
                    >
                        <span>Open</span>
                        <IconExternalLink size={12} />
                    </button>
                </div>
            </div>

            {/* Startup Group */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Startup</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Tips</div>
                            <div className="sb-cursor-row-desc">Show rotating tips on the empty screen</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={tipsEnabled}
                            className={`sb-cursor-toggle ${tipsEnabled ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setTipsEnabled(!tipsEnabled)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Window Restoration</div>
                            <div className="sb-cursor-row-desc">Controls which windows Scratchbox restores on startup</div>
                        </div>
                        <select
                            className="sb-cursor-select-dropdown"
                            value={windowRestoration}
                            onChange={e => setWindowRestoration(e.target.value as any)}
                        >
                            <option value="default">Default</option>
                            <option value="folders">Open Workspaces Only</option>
                            <option value="empty">New Empty Window</option>
                        </select>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Continue Interrupted Agents</div>
                            <div className="sb-cursor-row-desc">Automatically resume working on agents and their subagents after a reload or restart</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={continueInterruptedAgents}
                            className={`sb-cursor-toggle ${continueInterruptedAgents ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setContinueInterruptedAgents(!continueInterruptedAgents)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Notifications Group */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Notifications</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">System Notifications</div>
                            <div className="sb-cursor-row-desc">Show system notifications when Agent completes or needs attention</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={systemNotifications}
                            className={`sb-cursor-toggle ${systemNotifications ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setSystemNotifications(!systemNotifications)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Warning Notifications</div>
                            <div className="sb-cursor-row-desc">Show notifications for less urgent issues</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={warningNotifications}
                            className={`sb-cursor-toggle ${warningNotifications ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setWarningNotifications(!warningNotifications)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Menu Bar Icon</div>
                            <div className="sb-cursor-row-desc">Show Scratchbox in menu bar</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={menuBarIcon}
                            className={`sb-cursor-toggle ${menuBarIcon ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setMenuBarIcon(!menuBarIcon)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Completion Sound</div>
                            <div className="sb-cursor-row-desc">Play a sound when agents finish or need attention</div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={completionSound}
                            className={`sb-cursor-toggle ${completionSound ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setCompletionSound(!completionSound)}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Privacy Group */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Privacy</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="flex items-center gap-2 sb-cursor-row-title">
                                <IconLock size={12} className={privacyMode ? 'text-emerald-400' : 'text-zinc-400'} />
                                <span>Privacy Mode</span>
                                <span className={`sb-badge-unified ${privacyMode ? 'sb-badge-emerald' : 'sb-badge-zinc'}`}>
                                    {privacyMode ? 'STRICT PRIVACY ENABLED' : 'STANDARD'}
                                </span>
                            </div>
                            <div className="sb-cursor-row-desc">
                                Your code data will not be trained on or used to improve the product. Zero telemetry or model retention is applied when enabled.
                            </div>
                        </div>
                        <button
                            type="button"
                            role="switch"
                            aria-checked={privacyMode}
                            className={`sb-cursor-toggle ${privacyMode ? 'sb-cursor-toggle-on' : ''}`}
                            onClick={() => setPrivacyMode(!privacyMode)}
                            title={privacyMode ? 'Disable Privacy Mode' : 'Enable Privacy Mode'}
                        >
                            <span className="sb-cursor-toggle-thumb" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Workspace & Project Group */}
            <div className="sb-cursor-section-block">
                <div className="sb-cursor-section-header">Workspace &amp; Project</div>
                <div className="sb-cursor-group-card">
                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Active Workspace Root</div>
                            <div className="sb-cursor-row-desc font-mono text-xs text-zinc-600 dark:text-zinc-300">
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
                        </div>
                    </div>

                    <div className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">Custom Project Rules</div>
                            <div className="sb-cursor-row-desc">
                                {workspaceRules.length > 0
                                    ? `${workspaceRules.length} active rule${workspaceRules.length > 1 ? 's' : ''} loaded from .scratchbox/rules/`
                                    : 'Manage custom project directives and system instructions'}
                            </div>
                        </div>
                        <button
                            type="button"
                            className="sb-cursor-row-btn"
                            onClick={() => setActiveTab('workspace')}
                        >
                            <span>Manage Rules</span>
                            <span>→</span>
                        </button>
                    </div>
                </div>
            </div>

            {/* Log Out */}
            <div className="pt-2 flex items-center gap-3">
                <button
                    type="button"
                    className="sb-btn sb-btn-secondary sb-btn-sm"
                    onClick={() => {
                        setIsLoggedOut(true);
                        setTimeout(() => setIsLoggedOut(false), 3000);
                    }}
                >
                    {isLoggedOut ? '✓ Logged Out' : 'Log Out'}
                </button>
                {isLoggedOut && (
                    <span className="text-xs text-zinc-400 font-medium">Session credentials reset.</span>
                )}
            </div>
        </div>
    );
};
