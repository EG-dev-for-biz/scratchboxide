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
                    { keys: '⌘P / ⌘K', title: 'Command Palette & Quick Open', desc: 'Open spotlight palette for files, actions, and canvases' },
                    { keys: '⌘B', title: 'Toggle Primary Sidebar', desc: 'Show or hide the workspace navigation sidebar' },
                    { keys: '⌘L / ⌘J', title: 'Focus Composer Input', desc: 'Jump focus directly into the chat & action composer' },
                    { keys: '⌘S', title: 'Save & Commit Canvas', desc: 'Save and synchronize active canvas artifact or document' },
                    { keys: '⌘T', title: 'New Live Sandbox Tab', desc: 'Create a fresh runnable interactive sandbox canvas tab' },
                    { keys: '⌘W', title: 'Close Active Tab', desc: 'Close the current canvas artifact tab' },
                    { keys: '⌘1 – ⌘9', title: 'Switch Canvas Tabs', desc: 'Directly switch to canvas tab by number index' },
                    { keys: '⌥⌘← / ⌥⌘→', title: 'Cycle Previous / Next Tab', desc: 'Navigate forward or backward through open canvas tabs' },
                    { keys: '⌘\\', title: 'Toggle Split View', desc: 'Collapse or restore side-by-side canvas stage' },
                    { keys: '⌘N', title: 'New Conversation', desc: 'Start a clean AI reasoning chat session' },
                    { keys: '⌘O', title: 'Open Folder / Workspace', desc: 'Open native workspace or directory' },
                    { keys: '⌘,', title: 'Open Preferences', desc: 'Launch full Scratchbox settings and configuration modal' },
                    { keys: '⌘/', title: 'Keyboard Shortcuts', desc: 'Open this keystrokes and navigation reference' },
                    { keys: '@', title: 'Context Mentions', desc: 'Attach files, git status, terminals, docs, or MCP tools' },
                    { keys: '/', title: 'Superpower Skills', desc: 'Attach domain skills & specialized instructions' },
                    { keys: 'Enter / ⌘↵', title: 'Submit Prompt', desc: 'Send message in unified composer capsule (Shift+Enter for newline)' },
                    { keys: 'Esc', title: 'Dismiss LIFO', desc: 'Close modals, popovers, and autocomplete menus' }
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
