/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/** ShortcutsTab content of the Customize settings group. Extracted verbatim from SettingsModal.tsx. */
import * as React from 'react';
import { useSettingsContext } from '../SettingsContext';

export const ShortcutsTab: React.FC = () => {
    const { onOpenKeyboardShortcuts } = useSettingsContext();
    return (
        <div className="sb-cursor-settings-content animate-fadeIn">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h2 className="sb-cursor-content-title">Keyboard Shortcuts</h2>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                        Quick keystrokes for rapid navigation, code generation, and diff review.
                    </p>
                </div>
                {onOpenKeyboardShortcuts && (
                    <button
                        type="button"
                        className="sb-cursor-row-btn"
                        onClick={onOpenKeyboardShortcuts}
                        title="Open Keybindings Configuration"
                    >
                        <span>Open Full Keybindings...</span>
                    </button>
                )}
            </div>

            <div className="sb-cursor-group-card">
                {[
                    { keys: '⌘K', title: 'Inline Quick Edit', desc: 'Trigger inline AI prompt & code transformation in Sandbox' },
                    { keys: '⌘Y', title: 'Accept Diff', desc: 'Accept inline code diff and apply changes' },
                    { keys: '⌘N', title: 'Reject Diff / New Chat', desc: 'Reject inline code diff or start clean session' },
                    { keys: '⌘,', title: 'Open Settings', desc: 'Launch full Scratchbox settings modal' },
                    { keys: '⌘O', title: 'Open Folder / Project', desc: 'Open native workspace or directory' },
                    { keys: '⌘P', title: 'Spotlight Search', desc: 'Open spotlight palette for canvases and commands' },
                    { keys: '@', title: 'Context Mentions', desc: 'Attach files, git status, terminals, docs, or MCP tools' },
                    { keys: '/', title: 'Superpower Skills', desc: 'Attach domain skills & specialized instructions' },
                    { keys: 'Enter', title: 'Submit Prompt', desc: 'Send message in unified composer capsule' },
                    { keys: 'Esc', title: 'Dismiss', desc: 'Close modals, popovers, and autocomplete menus' }
                ].map((sc, scIdx) => (
                    <div key={scIdx} className="sb-cursor-row-item">
                        <div className="sb-cursor-row-info">
                            <div className="sb-cursor-row-title">{sc.title}</div>
                            <div className="sb-cursor-row-desc">{sc.desc}</div>
                        </div>
                        <kbd className="px-2.5 py-1 rounded bg-zinc-200 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 font-mono text-xs font-semibold border border-zinc-300 dark:border-zinc-700/80 shadow-xs">
                            {sc.keys}
                        </kbd>
                    </div>
                ))}
            </div>
        </div>
    );
};
