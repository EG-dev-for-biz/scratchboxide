/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { CanvasArtifact, StudioLayoutMode, StudioSettingsTab, WorkspaceFileType } from '../canvas-types';
import { ProjectItem } from '../ProjectsModal';
import {
    Icon3D,
    IconChat,
    IconChevronDown,
    IconClose,
    IconCode,
    IconCustomize,
    IconDocument,
    IconFilm,
    IconFolder,
    IconKanban,
    IconMetrics,
    IconNodeGraph,
    IconPlus,
    IconSettings
} from '../canvas-icons';

export interface StudioTopBarProps {
    activeArtifact: CanvasArtifact | undefined;
    layoutMode: StudioLayoutMode;
    isSidebarOpen: boolean;
    setIsSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
    documentPaneState: 'split' | 'collapsed' | 'expanded';
    setDocumentPaneState: React.Dispatch<React.SetStateAction<'split' | 'collapsed' | 'expanded'>>;
    isConversationMenuOpen: boolean;
    setIsConversationMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
    conversationMenuRef: React.RefObject<HTMLDivElement>;
    currentArtifactVersionsList: CanvasArtifact[];
    currentArtifactVersionIndex: number;
    isCurrentArtifactLatestVersion: boolean;
    handlePrevArtifactVersion: () => void;
    handleNextArtifactVersion: () => void;
    handleRollbackArtifactToVersion: (targetVersion: CanvasArtifact) => void;
    handleClearCurrentConversation: () => void;
    handleExportConversationMarkdown: () => void;
    handleCreateWorkspaceFile: (type: WorkspaceFileType) => void;
    getCanvasReopenIcon: () => React.ReactElement;
    getCanvasReopenLabel: () => string;
    getCanvasReopenTabTitle: () => string;
    showToast: (text: string, icon?: string) => void;
    handleSwitchMode?: (mode: StudioLayoutMode) => void;
    openSettingsToTab?: (tab: StudioSettingsTab) => void;
    activeWorkspace?: ProjectItem;
    workspaces?: ProjectItem[];
    onSelectWorkspace?: (ws: ProjectItem) => void;
    onOpenFolder?: () => void;
    onOpenWorkspace?: () => void;
    onNewWorkspace?: () => void;
}

/** Minimal top navigation bar: sidebar toggle, version pager, layout controls and the conversation menu. */
export const StudioTopBar: React.FC<StudioTopBarProps> = props => {
    const { activeArtifact, layoutMode, isSidebarOpen, setIsSidebarOpen, documentPaneState, setDocumentPaneState, isConversationMenuOpen, setIsConversationMenuOpen, conversationMenuRef, currentArtifactVersionsList, currentArtifactVersionIndex, isCurrentArtifactLatestVersion, handlePrevArtifactVersion, handleNextArtifactVersion, handleRollbackArtifactToVersion, handleClearCurrentConversation, handleExportConversationMarkdown, handleCreateWorkspaceFile, getCanvasReopenIcon, getCanvasReopenLabel, getCanvasReopenTabTitle, showToast, handleSwitchMode, openSettingsToTab, activeWorkspace, workspaces, onSelectWorkspace, onOpenFolder, onOpenWorkspace, onNewWorkspace } = props;

    const [isWorkspaceMenuOpen, setIsWorkspaceMenuOpen] = React.useState<boolean>(false);
    const workspaceMenuRef = React.useRef<HTMLDivElement>(null);

    React.useEffect(() => {
        if (!isWorkspaceMenuOpen) return;
        const handleClickOutside = (e: MouseEvent) => {
            if (workspaceMenuRef.current && !workspaceMenuRef.current.contains(e.target as Node)) {
                setIsWorkspaceMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [isWorkspaceMenuOpen]);
    return (
    <header className="sb-chatgpt-topbar">
        <div className="sb-topbar-left" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            {!isSidebarOpen && (
                <>
                    <button
                        type="button"
                        className="sb-topbar-sidebar-open-btn"
                        onClick={() => setIsSidebarOpen(true)}
                        title="Open sidebar"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <line x1="9" y1="3" x2="9" y2="21" />
                        </svg>
                    </button>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingLeft: '4px' }}>
                        <div style={{ width: '20px', height: '20px', minWidth: '20px', borderRadius: '6px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2px', overflow: 'hidden' }}>
                            <img src="/icons/ScratchboxIDE.png" alt="Scratchbox Logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                        </div>
                        <span style={{ fontSize: '13px', fontWeight: 700, color: '#f4f4f5', letterSpacing: '-0.02em' }}>Scratchbox</span>
                    </div>
                </>
            )}

            {/* TopBar Workspace Selector & Dropdown */}
            {activeWorkspace && (
                <div className="relative" ref={workspaceMenuRef} style={{ position: 'relative' }}>
                    <button
                        type="button"
                        className="sb-btn sb-topbar-action-pill"
                        onClick={() => setIsWorkspaceMenuOpen(!isWorkspaceMenuOpen)}
                        title="Workspace selector & actions"
                        style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 10px', fontSize: '12px' }}
                    >
                        <IconFolder size={13} className="text-zinc-400" />
                        <span style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                            {activeWorkspace.name || activeWorkspace.path.split('/').pop()}
                        </span>
                        <IconChevronDown size={11} className="text-zinc-500" />
                    </button>

                    {isWorkspaceMenuOpen && (
                        <div className="sb-topbar-conversation-menu animate-popover" style={{ minWidth: '220px', left: 0, right: 'auto' }} onClick={e => e.stopPropagation()}>
                            <div className="sb-dropdown-header">
                                Workspaces
                            </div>
                            {workspaces && workspaces.map(ws => {
                                const isCurrent = ws.id === activeWorkspace.id;
                                return (
                                    <button
                                        key={ws.id}
                                        type="button"
                                        className={`sb-btn sb-dropdown-item ${isCurrent ? 'sb-dropdown-item-active' : ''}`}
                                        onClick={() => {
                                            setIsWorkspaceMenuOpen(false);
                                            if (onSelectWorkspace) onSelectWorkspace(ws);
                                        }}
                                    >
                                        <IconFolder size={13} className={isCurrent ? 'text-blue-400' : 'text-zinc-400'} />
                                        <div className="sb-dropdown-item-text">
                                            <span className="sb-dropdown-item-title">{ws.name}</span>
                                        </div>
                                        {isCurrent && <span style={{ color: '#3b82f6', fontSize: '11px', fontWeight: 700, marginLeft: 'auto' }}>✓</span>}
                                    </button>
                                );
                            })}
                            <div style={{ height: '1px', background: 'var(--sb-surface-border, rgba(255, 255, 255, 0.08))', margin: '4px 0' }} />
                            {onNewWorkspace && (
                                <button
                                    type="button"
                                    className="sb-btn sb-dropdown-item"
                                    onClick={() => {
                                        setIsWorkspaceMenuOpen(false);
                                        onNewWorkspace();
                                    }}
                                >
                                    <IconPlus size={13} className="text-emerald-400" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">New Workspace...</span>
                                    </div>
                                </button>
                            )}
                            {onOpenFolder && (
                                <button
                                    type="button"
                                    className="sb-btn sb-dropdown-item"
                                    onClick={() => {
                                        setIsWorkspaceMenuOpen(false);
                                        onOpenFolder();
                                    }}
                                >
                                    <IconFolder size={13} className="text-amber-400" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">Open Folder...</span>
                                    </div>
                                </button>
                            )}
                            {onOpenWorkspace && (
                                <button
                                    type="button"
                                    className="sb-btn sb-dropdown-item"
                                    onClick={() => {
                                        setIsWorkspaceMenuOpen(false);
                                        onOpenWorkspace();
                                    }}
                                >
                                    <IconFolder size={13} className="text-cyan-400" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">Open Workspace...</span>
                                    </div>
                                </button>
                            )}
                            {openSettingsToTab && (
                                <>
                                    <div style={{ height: '1px', background: 'var(--sb-surface-border, rgba(255, 255, 255, 0.08))', margin: '4px 0' }} />
                                    <button
                                        type="button"
                                        className="sb-btn sb-dropdown-item"
                                        onClick={() => {
                                            setIsWorkspaceMenuOpen(false);
                                            openSettingsToTab('workspace');
                                        }}
                                    >
                                        <IconSettings size={13} className="text-zinc-400" />
                                        <div className="sb-dropdown-item-text">
                                            <span className="sb-dropdown-item-title">Settings</span>
                                        </div>
                                    </button>
                                </>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>

        <div className="sb-topbar-center" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            {/* Layout / Primitive Mode Switcher */}
            {handleSwitchMode && (
                <div className="sb-topbar-mode-switcher" style={{
                    display: 'flex',
                    alignItems: 'center',
                    background: 'var(--sb-surface-card, rgba(255, 255, 255, 0.04))',
                    border: '1px solid var(--sb-surface-border, rgba(255, 255, 255, 0.08))',
                    borderRadius: '8px',
                    padding: '2px',
                    gap: '2px'
                }}>
                    {[
                        { id: 'document' as const, label: 'Doc', icon: <IconDocument size={12} strokeWidth={1.8} /> },
                        { id: 'code' as const, label: 'Code', icon: <IconCode size={12} strokeWidth={1.8} /> },
                        { id: '3d' as const, label: '3D', icon: <Icon3D size={12} strokeWidth={1.8} /> },
                        { id: 'video' as const, label: 'Video', icon: <IconFilm size={12} strokeWidth={1.8} /> },
                        { id: 'canvas' as const, label: 'Graph', icon: <IconNodeGraph size={12} strokeWidth={1.8} /> },
                        { id: 'kanban' as const, label: 'Kanban', icon: <IconKanban size={12} strokeWidth={1.8} /> },
                        { id: 'dashboard' as const, label: 'Dashboard', icon: <IconMetrics size={12} strokeWidth={1.8} /> }
                    ].map(mode => {
                        const isSelected = layoutMode === mode.id || (mode.id === 'canvas' && (layoutMode === 'canvas' || layoutMode === 'automation'));
                        return (
                            <button
                                key={mode.id}
                                type="button"
                                className={`sb-btn sb-btn-xs ${isSelected ? 'sb-btn-primary' : 'sb-btn-ghost'}`}
                                onClick={() => handleSwitchMode(mode.id as StudioLayoutMode)}
                                style={{
                                    padding: '3px 8px',
                                    fontSize: '11px',
                                    fontWeight: isSelected ? 600 : 500,
                                    borderRadius: '6px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '4px',
                                    transition: 'all 0.15s ease'
                                }}
                                title={`Switch to ${mode.label} workspace`}
                            >
                                {mode.icon}
                                <span>{mode.label}</span>
                            </button>
                        );
                    })}
                </div>
            )}

            {/* In-Canvas Version Stepper & Rollback Surface */}
            {activeArtifact && currentArtifactVersionsList.length > 1 && (
                <div className="sb-artifact-version-stepper">
                    <button
                        type="button"
                        className="sb-ver-step-btn"
                        onClick={handlePrevArtifactVersion}
                        disabled={currentArtifactVersionIndex <= 0}
                        title="Previous version"
                    >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="15 18 9 12 15 6" />
                        </svg>
                    </button>
                    <span className="sb-ver-badge">
                        v{activeArtifact.version || currentArtifactVersionIndex + 1} of {currentArtifactVersionsList.length}
                    </span>
                    <button
                        type="button"
                        className="sb-ver-step-btn"
                        onClick={handleNextArtifactVersion}
                        disabled={currentArtifactVersionIndex >= currentArtifactVersionsList.length - 1}
                        title="Next version"
                    >
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="9 18 15 12 9 6" />
                        </svg>
                    </button>
                    {!isCurrentArtifactLatestVersion && (
                        <button
                            type="button"
                            className="sb-ver-restore-btn"
                            onClick={() => handleRollbackArtifactToVersion(activeArtifact)}
                            title={`Restore v${activeArtifact.version || currentArtifactVersionIndex + 1}`}
                        >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="1 4 1 10 7 10" />
                                <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                            </svg>
                            <span>Restore v{activeArtifact.version || currentArtifactVersionIndex + 1}</span>
                        </button>
                    )}
                </div>
            )}
        </div>

        <div className="sb-topbar-right">
            {layoutMode !== 'chat' && documentPaneState === 'collapsed' && (
                <button
                    type="button"
                    className="sb-btn sb-btn-primary sb-btn-xs sb-doc-reopen-btn"
                    onClick={() => setDocumentPaneState('split')}
                    style={{
                        marginRight: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        padding: '4px 10px',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontWeight: 500,
                        background: '#2563eb',
                        color: '#ffffff'
                    }}
                    title={getCanvasReopenLabel()}
                >
                    {getCanvasReopenIcon()}
                    <span>Show {getCanvasReopenTabTitle()}</span>
                </button>
            )}
            <button
                type="button"
                className="sb-btn sb-topbar-action-pill"
                onClick={() => {
                    if (typeof window !== 'undefined' && navigator?.clipboard?.writeText) {
                        navigator.clipboard.writeText(window.location.href);
                    }
                    showToast('Link copied to clipboard');
                }}
                title="Share conversation"
            >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="18" cy="5" r="3" />
                    <circle cx="6" cy="12" r="3" />
                    <circle cx="18" cy="19" r="3" />
                    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                </svg>
                <span>Share</span>
            </button>

            {/* Conversation Actions Menu */}
            <div className="relative" ref={conversationMenuRef} style={{ position: 'relative' }}>
                <button
                    type="button"
                    className={`sb-btn sb-topbar-icon-action ${isConversationMenuOpen ? 'sb-topbar-icon-active' : ''}`}
                    onClick={() => setIsConversationMenuOpen(!isConversationMenuOpen)}
                    title="Conversation actions"
                >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="1" />
                        <circle cx="19" cy="12" r="1" />
                        <circle cx="5" cy="12" r="1" />
                    </svg>
                </button>

                {isConversationMenuOpen && (
                    <div
                        className="sb-topbar-conversation-menu animate-popover"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="sb-dropdown-header">
                            Conversation Actions
                        </div>

                        <button
                            type="button"
                            className="sb-btn sb-dropdown-item"
                            onClick={() => {
                                setIsConversationMenuOpen(false);
                                handleCreateWorkspaceFile('chat');
                            }}
                        >
                            <IconChat size={13} className="text-blue-400" />
                            <div className="sb-dropdown-item-text">
                                <span className="sb-dropdown-item-title">New Conversation</span>
                            </div>
                        </button>

                        <button
                            type="button"
                            className="sb-btn sb-dropdown-item"
                            onClick={handleExportConversationMarkdown}
                        >
                            <IconDocument size={13} className="text-emerald-400" />
                            <div className="sb-dropdown-item-text">
                                <span className="sb-dropdown-item-title">Export Chat (Markdown)</span>
                            </div>
                        </button>

                        <button
                            type="button"
                            className="sb-dropdown-item"
                            onClick={() => {
                                if (typeof window !== 'undefined' && navigator?.clipboard?.writeText) {
                                    navigator.clipboard.writeText(window.location.href);
                                }
                                showToast('Conversation link copied');
                                setIsConversationMenuOpen(false);
                            }}
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-zinc-400">
                                <circle cx="18" cy="5" r="3" />
                                <circle cx="6" cy="12" r="3" />
                                <circle cx="18" cy="19" r="3" />
                                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
                                <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                            </svg>
                            <div className="sb-dropdown-item-text">
                                <span className="sb-dropdown-item-title">Copy Link</span>
                            </div>
                        </button>

                        {openSettingsToTab && (
                            <>
                                <div style={{ height: '1px', background: 'var(--sb-surface-border, rgba(255, 255, 255, 0.08))', margin: '3px 0' }} />
                                <button
                                    type="button"
                                    className="sb-btn sb-dropdown-item"
                                    onClick={() => {
                                        setIsConversationMenuOpen(false);
                                        openSettingsToTab('general');
                                    }}
                                >
                                    <IconSettings size={13} className="text-zinc-400" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">Settings</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-btn sb-dropdown-item"
                                    onClick={() => {
                                        setIsConversationMenuOpen(false);
                                        openSettingsToTab('appearance');
                                    }}
                                >
                                    <IconCustomize size={13} className="text-purple-400" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">Preferences</span>
                                    </div>
                                </button>
                            </>
                        )}

                        <div style={{ height: '1px', background: 'var(--sb-surface-border, rgba(255, 255, 255, 0.08))', margin: '3px 0' }} />

                        <button
                            type="button"
                            className="sb-btn sb-dropdown-item"
                            onClick={handleClearCurrentConversation}
                        >
                            <IconClose size={13} className="text-rose-400" />
                            <div className="sb-dropdown-item-text">
                                <span className="sb-dropdown-item-title text-rose-400">Clear Conversation</span>
                            </div>
                        </button>
                    </div>
                )}
            </div>
        </div>
    </header>
    );
};
