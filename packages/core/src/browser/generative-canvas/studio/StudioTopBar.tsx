/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
    IconSearch,
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
    onOpenSpotlight?: () => void;
}

/** Minimal top navigation bar: sidebar toggle, version pager, layout controls and the conversation menu. */
export const StudioTopBar: React.FC<StudioTopBarProps> = props => {
    const { activeArtifact, layoutMode, isSidebarOpen, setIsSidebarOpen, documentPaneState, setDocumentPaneState, isConversationMenuOpen, setIsConversationMenuOpen, conversationMenuRef, handleClearCurrentConversation, handleExportConversationMarkdown, handleCreateWorkspaceFile, getCanvasReopenIcon, getCanvasReopenLabel, getCanvasReopenTabTitle, showToast, openSettingsToTab, activeWorkspace, onOpenSpotlight } = props;

    return (
    <header className="sb-chatgpt-topbar">
        <div className="sb-topbar-left" style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: '140px' }}>
            {!isSidebarOpen && (
                <>
                    <button
                        type="button"
                        className="sb-topbar-sidebar-open-btn"
                        onClick={() => setIsSidebarOpen(true)}
                        title="Open sidebar (⌘B)"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <line x1="9" y1="3" x2="9" y2="21" />
                        </svg>
                    </button>
                    <div className="sb-sidebar-brand" style={{ paddingLeft: '2px' }} title="Scratchbox IDE">
                        <div className="sb-brand-logo-icon">
                            <img src="/icons/ScratchboxIDE-icon.svg" alt="Scratchbox Logo" />
                        </div>
                        <span className="sb-brand-logo-title">Scratchbox</span>
                        <span className="sb-brand-logo-badge">IDE</span>
                    </div>
                </>
            )}
        </div>

        {/* Cursor-Grade Center Command Search Pill */}
        <div className="sb-topbar-center" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, maxWidth: '520px' }}>
            <button
                type="button"
                className="sb-topbar-command-pill"
                onClick={onOpenSpotlight}
                title="Search files, run commands, or prompt AI (⌘P / ⌘K)"
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    maxWidth: '460px',
                    height: '28px',
                    padding: '0 12px',
                    borderRadius: '7px',
                    background: 'rgba(255, 255, 255, 0.04)',
                    border: '1px solid rgba(255, 255, 255, 0.08)',
                    color: 'var(--sb-text-tertiary, #94a3b8)',
                    fontSize: '12px',
                    cursor: 'pointer',
                    userSelect: 'none',
                    transition: 'all 0.15s ease'
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, overflow: 'hidden' }}>
                    <IconFolder size={12} className="text-zinc-500" />
                    <span style={{ fontWeight: 600, color: 'var(--sb-text-secondary, #cbd5e1)', whiteSpace: 'nowrap' }}>
                        {activeWorkspace?.name || activeWorkspace?.path.split('/').pop() || 'scratchbox-ide'}
                    </span>
                    <span style={{ color: 'rgba(255, 255, 255, 0.2)' }}>·</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--sb-text-tertiary, #94a3b8)' }}>
                        Search files, commands, or prompt...
                    </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '3px', flexShrink: 0 }}>
                    <kbd style={{ fontSize: '10px', fontFamily: 'inherit', background: 'rgba(255, 255, 255, 0.08)', padding: '1px 5px', borderRadius: '4px', border: '1px solid rgba(255, 255, 255, 0.1)', color: 'var(--sb-text-secondary)' }}>⌘P</kbd>
                </div>
            </button>
        </div>

        <div className="sb-topbar-right" style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: '140px', justifyContent: 'flex-end' }}>
            {layoutMode !== 'chat' && documentPaneState === 'collapsed' && (
                <button
                    type="button"
                    className="sb-btn sb-btn-primary sb-btn-xs sb-doc-reopen-btn"
                    onClick={() => setDocumentPaneState('split')}
                    style={{
                        marginRight: '4px',
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

            {openSettingsToTab && (
                <button
                    type="button"
                    className="sb-btn sb-topbar-icon-action"
                    onClick={() => openSettingsToTab('general')}
                    title="Settings (⌘,)"
                >
                    <IconSettings size={14} className="text-zinc-400" />
                </button>
            )}

            {/* Conversation Actions Menu */}
            <div className="relative" ref={conversationMenuRef} style={{ position: 'relative' }}>
                <button
                    type="button"
                    className={`sb-btn sb-topbar-icon-action ${isConversationMenuOpen ? 'sb-topbar-icon-active' : ''}`}
                    onClick={() => setIsConversationMenuOpen(!isConversationMenuOpen)}
                    title="Conversation actions"
                >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="1.5" fill="currentColor" />
                        <circle cx="19" cy="12" r="1.5" fill="currentColor" />
                        <circle cx="5" cy="12" r="1.5" fill="currentColor" />
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
