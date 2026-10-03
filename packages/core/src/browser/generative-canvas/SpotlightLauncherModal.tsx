/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import {
    ChatSession,
    PrimitiveType
} from './canvas-types';
import {
    IconAutomations,
    IconChat,
    IconClose,
    IconCode,
    IconDiff,
    IconDocument,
    IconKanban,
    IconMcp,
    IconSearch,
    IconSparkles,
    IconTerminal
} from './canvas-icons';

export interface SpotlightActionItem {
    id: string;
    title: string;
    subtitle: string;
    category: 'Actions' | 'Canvases' | 'Files' | 'AI Tools' | 'Recent';
    icon: React.ReactNode;
    shortcut?: string;
    onExecute: () => void;
}

export interface SpotlightLauncherModalProps {
    isOpen: boolean;
    onClose: () => void;
    onPromptGemini: (promptText: string) => void;
    onCreateArtifact: (type: PrimitiveType, title?: string) => void;
    onOpenSettings: (tab?: string) => void;
    onOpenAutomations?: () => void;
    onOpenMcpHub?: () => void;
    onOpenGitReview?: () => void;
    onDebugTerminal?: () => void;
    recentSessions?: ChatSession[];
    onSelectSession?: (sessionId: string) => void;
    workspaceFiles?: Array<string | { path: string; name: string }>;
    onOpenFile?: (filePath: string, fileName: string) => void;
}

export const SpotlightLauncherModal: React.FC<SpotlightLauncherModalProps> = ({
    isOpen,
    onClose,
    onPromptGemini,
    onCreateArtifact,
    onOpenSettings,
    onOpenAutomations,
    onOpenMcpHub,
    onOpenGitReview,
    onDebugTerminal,
    recentSessions = [],
    onSelectSession,
    workspaceFiles = [],
    onOpenFile
}) => {
    const [searchQuery, setSearchQuery] = React.useState<string>('');
    const [selectedIndex, setSelectedIndex] = React.useState<number>(0);
    const inputRef = React.useRef<HTMLInputElement | null>(null);

    React.useEffect(() => {
        if (isOpen) {
            setSearchQuery('');
            setSelectedIndex(0);
            setTimeout(() => inputRef.current?.focus(), 50);
        }
    }, [isOpen]);

    const defaultActions: SpotlightActionItem[] = [
        {
            id: 'act-new-chat',
            title: 'New Conversational Session',
            subtitle: 'Start a clean AI reasoning chat session',
            category: 'Actions',
            icon: <IconChat size={15} className="text-blue-400" />,
            shortcut: '⌘N',
            onExecute: () => {
                onClose();
                onPromptGemini('');
            }
        },
        {
            id: 'act-open-automations-hub',
            title: 'Automations & Workflow Hub',
            subtitle: 'Orchestrate interactive canvas primitives, templates, and pipelines',
            category: 'Actions',
            icon: <IconAutomations size={15} className="text-cyan-400" />,
            onExecute: () => {
                onClose();
                if (onOpenAutomations) onOpenAutomations();
                else onCreateArtifact('node-graph', 'System Node Flow');
            }
        },
        {
            id: 'act-git-review-staging',
            title: 'Review Git Changes & Staging',
            subtitle: 'Inspect unified diffs, stage files, and commit changes',
            category: 'Actions',
            icon: <IconDiff size={15} className="text-emerald-400" />,
            shortcut: '⌘⇧G',
            onExecute: () => {
                onClose();
                if (onOpenGitReview) onOpenGitReview();
            }
        },
        {
            id: 'act-new-code-sandbox',
            title: 'Create Live Code Sandbox',
            subtitle: 'Interactive React 19 / Tailwind / Pyodide workspace with hot reload',
            category: 'Canvases',
            icon: <IconCode size={15} className="text-emerald-400" />,
            onExecute: () => {
                onClose();
                onCreateArtifact('live-code-sandbox', 'Live UI Sandbox');
            }
        },
        {
            id: 'act-new-doc',
            title: 'Create Rich Document Spec',
            subtitle: 'Rich Markdown doc with comparison tables & callouts',
            category: 'Canvases',
            icon: <IconDocument size={15} className="text-purple-400" />,
            onExecute: () => {
                onClose();
                onCreateArtifact('markdown-document', 'Architecture Spec');
            }
        },
        {
            id: 'act-new-kanban',
            title: 'Create Sprint Kanban Board',
            subtitle: 'Agile task delivery board with stage columns & priority tags',
            category: 'Canvases',
            icon: <IconKanban size={15} className="text-amber-400" />,
            onExecute: () => {
                onClose();
                onCreateArtifact('kanban-board', 'Sprint Delivery Board');
            }
        },
        {
            id: 'act-new-graph',
            title: 'Create Visual Node Flow Graph',
            subtitle: 'n8n/Miro interactive system architecture & signal routing graph',
            category: 'Canvases',
            icon: <IconAutomations size={15} className="text-cyan-400" />,
            onExecute: () => {
                onClose();
                onCreateArtifact('node-graph', 'System Node Flow');
            }
        },
        {
            id: 'act-open-mcp-importer',
            title: '1-Click MCP Auto-Importer',
            subtitle: 'Auto-discover configs from Claude Desktop & external IDEs',
            category: 'AI Tools',
            icon: <IconMcp size={15} className="text-indigo-400" />,
            onExecute: () => {
                onClose();
                if (onOpenMcpHub) onOpenMcpHub();
                else onOpenSettings('mcp');
            }
        },
        {
            id: 'act-debug-terminal',
            title: 'Terminal AI Self-Healing & Debug',
            subtitle: 'Synthesize compiler error diagnostics & auto-generate multi-file fix',
            category: 'AI Tools',
            icon: <IconTerminal size={15} className="text-rose-400" />,
            onExecute: () => {
                onClose();
                if (onDebugTerminal) onDebugTerminal();
                else onPromptGemini('Synthesize terminal failure diagnostics and suggest self-healing patch.');
            }
        }
    ];

    // Add workspace files for quick-open (⌘P / ⌘K)
    const fileActions: SpotlightActionItem[] = (workspaceFiles || []).map(f => {
        const filePath = typeof f === 'string' ? f : f.path;
        const fileName = typeof f === 'string' ? (f.split('/').pop() || f) : f.name;
        return {
            id: `file-${filePath}`,
            title: fileName,
            subtitle: filePath,
            category: 'Files' as const,
            icon: <IconDocument size={14} className="text-cyan-400" />,
            onExecute: () => {
                onClose();
                if (onOpenFile) onOpenFile(filePath, fileName);
            }
        };
    });

    // Add recent sessions to action list
    const sessionActions: SpotlightActionItem[] = (recentSessions || []).slice(0, 4).map(s => ({
        id: `sess-${s.id}`,
        title: s.title || 'Untitled Session',
        subtitle: `Recent workspace session • ${s.relativeTime || s.dateCategory || 'Today'}`,
        category: 'Recent',
        icon: <IconChat size={14} className="text-zinc-400" />,
        onExecute: () => {
            onClose();
            if (onSelectSession) onSelectSession(s.id);
        }
    }));

    const allItems = [...defaultActions, ...fileActions, ...sessionActions];

    const filteredItems = allItems.filter(item => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
            item.title.toLowerCase().includes(q) ||
            item.subtitle.toLowerCase().includes(q) ||
            item.category.toLowerCase().includes(q)
        );
    });

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape') {
            onClose();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            setSelectedIndex(idx => (idx + 1) % Math.max(1, filteredItems.length));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setSelectedIndex(idx => (idx - 1 + filteredItems.length) % Math.max(1, filteredItems.length));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (filteredItems.length > 0 && filteredItems[selectedIndex]) {
                filteredItems[selectedIndex].onExecute();
            } else if (searchQuery.trim()) {
                onClose();
                onPromptGemini(searchQuery.trim());
            }
        }
    };

    if (!isOpen) {
        return null;
    }

    return (
        <div className="sb-spotlight-backdrop animate-fadeIn" onClick={onClose}>
            <div className="sb-spotlight-palette-card animate-popover" onClick={e => e.stopPropagation()}>
                {/* Search Bar Input Row */}
                <div className="sb-spotlight-search-row">
                    <div className="sb-spotlight-search-icon">
                        <IconSearch size={18} className="text-zinc-400" />
                    </div>
                    <input
                        ref={inputRef}
                        type="text"
                        className="sb-spotlight-input"
                        placeholder="Search files, run actions, or prompt AI... (⌘P / ⌘K)"
                        value={searchQuery}
                        onChange={e => {
                            setSearchQuery(e.target.value);
                            setSelectedIndex(0);
                        }}
                        onKeyDown={handleKeyDown}
                    />
                    {searchQuery ? (
                        <button
                            type="button"
                            className="sb-search-clear-btn"
                            onClick={() => setSearchQuery('')}
                        >
                            <IconClose size={14} />
                        </button>
                    ) : (
                        <div className="sb-spotlight-kbd-badge">
                            <kbd>Esc</kbd>
                        </div>
                    )}
                </div>

                {/* Direct Ask AI Prompt Option if user typed custom query */}
                {searchQuery.trim() && (
                    <div
                        className="sb-spotlight-direct-prompt"
                        onClick={() => {
                            onClose();
                            onPromptGemini(searchQuery.trim());
                        }}
                    >
                        <div className="flex items-center gap-2">
                            <IconSparkles size={15} className="text-blue-400 animate-pulse" />
                            <span className="text-xs text-zinc-200">
                                Ask AI: <strong>"{searchQuery}"</strong>
                            </span>
                        </div>
                        <span className="sb-spotlight-item-shortcut">↵ Enter</span>
                    </div>
                )}

                {/* Filtered Action List */}
                <div className="sb-spotlight-list-container">
                    {filteredItems.length > 0 ? (
                        filteredItems.map((item, idx) => {
                            const isSelected = idx === selectedIndex;
                            return (
                                <div
                                    key={item.id}
                                    className={`sb-spotlight-item ${isSelected ? 'sb-spotlight-item-selected' : ''}`}
                                    onClick={item.onExecute}
                                    onMouseEnter={() => setSelectedIndex(idx)}
                                >
                                    <div className="sb-spotlight-item-icon-box">
                                        {item.icon}
                                    </div>
                                    <div className="sb-spotlight-item-text">
                                        <div className="sb-spotlight-item-title">{item.title}</div>
                                        <div className="sb-spotlight-item-sub">{item.subtitle}</div>
                                    </div>
                                    <div className="sb-spotlight-item-meta">
                                        {item.shortcut && (
                                            <span className="sb-spotlight-item-shortcut">{item.shortcut}</span>
                                        )}
                                        <span className="sb-spotlight-item-cat">{item.category}</span>
                                    </div>
                                </div>
                            );
                        })
                    ) : (
                        <div className="sb-spotlight-empty">
                            <span>No exact match found. Press Enter to prompt AI assistant.</span>
                        </div>
                    )}
                </div>

                {/* Spotlight Footer Controls */}
                <div className="sb-spotlight-footer">
                    <div className="sb-spotlight-footer-tips">
                        <span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span>
                        <span><kbd>↵</kbd> to select</span>
                        <span><kbd>Esc</kbd> to dismiss</span>
                    </div>
                    <div className="sb-spotlight-brand">
                        <span>Scratchbox Spotlight Companion</span>
                    </div>
                </div>
            </div>
        </div>
    );
};
