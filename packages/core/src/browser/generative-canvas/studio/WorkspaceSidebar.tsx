/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { ChatSession, StudioSettingsTab, WorkspaceFileType, getActiveUserName } from '../canvas-types';
import { initialsOf } from '../state/studio-defaults';
import { Icon3D, IconAutomations, IconChat, IconChevronDown, IconChevronRight, IconClose, IconCode, IconCustomize, IconDocument, IconFilm, IconFolder, IconGlobe, IconKanban, IconList, IconNewChat, IconPlus, IconSearch, IconSettings } from '../canvas-icons';
import { ProjectItem } from '../ProjectsModal';
import { FileTreeNode, POSE_3D_TREE, SCRATCHBOX_TREE } from './workspace-trees';
import { WorkspaceFileTree } from './WorkspaceFileTree';

export function getSessionIcon(session?: ChatSession): React.ReactElement | null {
    if (!session) return null;
    if (session.fileType === 'chat' || !session.fileType) {
        return null;
    }
    switch (session.fileType) {
        case 'code':
            return <IconCode size={11} className="text-blue-400" strokeWidth={1.8} />;
        case 'browser':
            return <IconGlobe size={11} className="text-teal-400" strokeWidth={1.8} />;
        case 'document':
            return <IconDocument size={11} className="text-amber-400" strokeWidth={1.8} />;
        case 'kanban':
            return <IconKanban size={11} className="text-purple-400" strokeWidth={1.8} />;
        case 'automation':
            return <IconAutomations size={11} className="text-emerald-400" strokeWidth={1.8} />;
        case '3d':
            return <Icon3D size={11} className="text-rose-400" strokeWidth={1.8} />;
        case 'video':
            return <IconFilm size={11} className="text-pink-400" strokeWidth={1.8} />;
        default:
            return null;
    }
};

export interface WorkspaceSidebarProps {
    activeWorkspace: ProjectItem;
    setActiveWorkspace: React.Dispatch<React.SetStateAction<ProjectItem>>;
    workspaces: ProjectItem[];
    sessions: ChatSession[];
    currentSessionId: string | undefined;
    isSidebarOpen: boolean;
    setIsSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
    handleCreateNewWorkspace: (workspaceName?: string, customPath?: string) => Promise<void>;
    onCreateWorkspaceFile: (type: WorkspaceFileType) => void;
    handleDeleteSession: (sessionId: string, e: React.MouseEvent) => void;
    handleNewChat: () => void;
    handleSelectSession: (session: ChatSession) => void;
    onOpenFolder: (() => void) | undefined;
    onOpenWorkspace: (() => void) | undefined;
    openSettingsToTab: (tab: StudioSettingsTab) => void;
    showToast: (text: string, icon?: string) => void;
    showNewWorkspaceMenu: boolean;
    setShowNewWorkspaceMenu: React.Dispatch<React.SetStateAction<boolean>>;
    newWorkspaceInputName: string;
    setNewWorkspaceInputName: React.Dispatch<React.SetStateAction<string>>;
    onFileClick: (filePath: string, fileName: string) => void;
}

/**
 * Left sidebar: new chat / search / customize, the workspaces list with threads or the file
 * explorer, the add-file menu and the account footer. Owns its own search/expansion UI state.
 */
export const WorkspaceSidebar: React.FC<WorkspaceSidebarProps> = props => {
    const activeUserName = getActiveUserName();
    const { activeWorkspace, setActiveWorkspace, workspaces, sessions, currentSessionId, isSidebarOpen, setIsSidebarOpen, handleCreateNewWorkspace, onCreateWorkspaceFile, handleDeleteSession, handleNewChat, handleSelectSession, onOpenFolder, onOpenWorkspace, openSettingsToTab, showToast, showNewWorkspaceMenu, setShowNewWorkspaceMenu, newWorkspaceInputName, setNewWorkspaceInputName, onFileClick } = props;

    // Scratchbox Studio Sidebar Layout & Navigation State
    const [sidebarSearchQuery, setSidebarSearchQuery] = React.useState<string>('');
    const [isSidebarSearchOpen, setIsSidebarSearchOpen] = React.useState<boolean>(false);
    const [isWorkspacesExpanded, setIsWorkspacesExpanded] = React.useState<boolean>(true);
    const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = React.useState<Record<string, boolean>>({});
    const [showAddFileMenu, setShowAddFileMenu] = React.useState<boolean>(false);
    const [sidebarViewMode, setSidebarViewMode] = React.useState<'threads' | 'explorer'>('threads');
    const [serverTree, setServerTree] = React.useState<FileTreeNode[] | null>(null);

    React.useEffect(() => {
        let isMounted = true;
        const fetchTree = async () => {
            try {
                const rootParam = activeWorkspace.path ? `?root=${encodeURIComponent(activeWorkspace.path)}` : '';
                const res = await fetch(`/workspace/files${rootParam}`);
                if (res.ok) {
                    const data = await res.json();
                    if (data.success && Array.isArray(data.files) && data.files.length > 0 && isMounted) {
                        setServerTree(data.files);
                    }
                }
            } catch {
                // Ignore network error; fallback to static trees
            }
        };
        fetchTree();
        return () => { isMounted = false; };
    }, [activeWorkspace.path, activeWorkspace.id]);

    const isWorkspaceCollapsed = (workspaceId: string): boolean => {
        return !!collapsedWorkspaceIds[workspaceId];
    };

    const toggleWorkspaceCollapse = (workspaceId: string, e?: React.MouseEvent) => {
        if (e) {
            e.stopPropagation();
        }
        setCollapsedWorkspaceIds(prev => ({
            ...prev,
            [workspaceId]: !prev[workspaceId]
        }));
    };

    const handleCreateWorkspaceFile = (type: WorkspaceFileType) => {
        setShowAddFileMenu(false);
        onCreateWorkspaceFile(type);
    };

    // Global click listener to close the add-file popup
    React.useEffect(() => {
        if (!showAddFileMenu) return;
        const handleGlobalClick = () => setShowAddFileMenu(false);
        window.addEventListener('click', handleGlobalClick);
        return () => window.removeEventListener('click', handleGlobalClick);
    }, [showAddFileMenu]);

    const handleWindowClose = React.useCallback(() => {
        const desktop = (window as any).scratchboxDesktop;
        if (desktop?.close) {
            desktop.close();
        } else if (window.opener) {
            window.close();
        } else {
            console.log('[WorkspaceSidebar] Window close requested');
        }
    }, []);

    const handleWindowMinimize = React.useCallback(() => {
        const desktop = (window as any).scratchboxDesktop;
        if (desktop?.minimize) {
            desktop.minimize();
        } else {
            setIsSidebarOpen(false);
        }
    }, [setIsSidebarOpen]);

    const handleWindowMaximize = React.useCallback(() => {
        const desktop = (window as any).scratchboxDesktop;
        if (desktop?.maximize) {
            desktop.maximize();
        } else if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        } else {
            document.documentElement.requestFullscreen().catch(() => {});
        }
    }, []);

    return (
    <aside className={`sb-chatgpt-sidebar ${isSidebarOpen ? 'sb-sidebar-open' : 'sb-sidebar-collapsed'}`}>
        {/* Sidebar Top Controls: Window Traffic Lights & Navigation */}
        <div className="sb-sidebar-top-header" style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div className="sb-mac-traffic-lights" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span
                    role="button"
                    tabIndex={0}
                    aria-label="Close window"
                    className="sb-traffic-light sb-tl-close"
                    onClick={handleWindowClose}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleWindowClose(); }}
                    title="Close Window"
                />
                <span
                    role="button"
                    tabIndex={0}
                    aria-label="Minimize window"
                    className="sb-traffic-light sb-tl-min"
                    onClick={handleWindowMinimize}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleWindowMinimize(); }}
                    title="Minimize Window"
                />
                <span
                    role="button"
                    tabIndex={0}
                    aria-label="Maximize window"
                    className="sb-traffic-light sb-tl-max"
                    onClick={handleWindowMaximize}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleWindowMaximize(); }}
                    title="Maximize Window"
                />
            </div>
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    className="sb-btn sb-btn-ghost sb-btn-icon-xs"
                    onClick={() => setIsSidebarOpen(false)}
                    title="Collapse Sidebar (⌘B)"
                    style={{ width: '24px', height: '24px', color: '#71717a' }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="9" y1="3" x2="9" y2="21" />
                    </svg>
                </button>
            </div>
        </div>

        {/* Primary Scratchbox Studio Navigation Actions */}
        <div className="sb-sidebar-nav-list" style={{ marginTop: '4px' }}>
            <button
                type="button"
                className="sb-sidebar-nav-row sb-sidebar-nav-new"
                onClick={handleNewChat}
                title="New Chat (⌘K)"
            >
                <span className="sb-nav-icon">
                    <IconNewChat size={14} strokeWidth={1.8} />
                </span>
                <span className="sb-nav-label">New Chat</span>
            </button>

            <button
                type="button"
                className={`sb-sidebar-nav-row ${isSidebarSearchOpen ? 'sb-sidebar-nav-active' : ''}`}
                onClick={() => setIsSidebarSearchOpen(!isSidebarSearchOpen)}
                title="Search conversations"
            >
                <span className="sb-nav-icon">
                    <IconSearch size={14} strokeWidth={1.8} />
                </span>
                <span className="sb-nav-label">Search</span>
            </button>

            <button
                type="button"
                className="sb-sidebar-nav-row"
                onClick={() => openSettingsToTab('workspace')}
                title="Customize project rules & superpowers"
            >
                <span className="sb-nav-icon">
                    <IconCustomize size={14} strokeWidth={1.8} />
                </span>
                <span className="sb-nav-label">Customize</span>
            </button>
        </div>

        {/* Search Input Box (when search is toggled open) */}
        {isSidebarSearchOpen && (
            <div className="sb-sidebar-search-box animate-fadeIn">
                <input
                    type="text"
                    className="sb-sidebar-search-input"
                    placeholder="Filter chats..."
                    value={sidebarSearchQuery}
                    onChange={e => setSidebarSearchQuery(e.target.value)}
                    autoFocus
                />
                {sidebarSearchQuery && (
                    <button
                        type="button"
                        className="sb-search-clear-btn"
                        onClick={() => setSidebarSearchQuery('')}
                    >
                        <IconClose size={10} />
                    </button>
                )}
            </div>
        )}

        {/* Workspaces Explorer & Chat Hierarchy (Scratchbox Studio Organization) */}
        <div className="sb-sidebar-workspaces-section">
            <div className="sb-workspaces-header" onClick={() => setIsWorkspacesExpanded(!isWorkspacesExpanded)}>
                <div className="sb-workspaces-title-group">
                    <span className="sb-workspaces-chevron">
                        {isWorkspacesExpanded ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                    </span>
                    <span className="sb-workspaces-heading">Workspaces</span>
                </div>
                <div className="sb-workspaces-actions" onClick={e => e.stopPropagation()}>
                    <button
                        type="button"
                        className={`sb-workspace-header-btn ${sidebarViewMode === 'explorer' ? 'sb-workspace-header-btn-active' : ''}`}
                        onClick={() => setSidebarViewMode(sidebarViewMode === 'threads' ? 'explorer' : 'threads')}
                        title={sidebarViewMode === 'threads' ? "Switch to Files Explorer" : "Switch to Chat Threads"}
                        style={{ marginRight: '6px' }}
                    >
                        <IconList size={12} />
                    </button>
                    <button
                        type="button"
                        className="sb-workspace-header-btn"
                        onClick={e => {
                            e.stopPropagation();
                            setShowNewWorkspaceMenu(!showNewWorkspaceMenu);
                        }}
                        title="Start New Workspace / Open Folder"
                    >
                        <IconPlus size={12} />
                    </button>
                </div>
            </div>

            {/* Inline Sidebar New Workspace Drawer */}
            {showNewWorkspaceMenu && (
                <div className="sb-sidebar-new-workspace-drawer animate-fadeIn" onClick={e => e.stopPropagation()}>
                    <div className="sb-new-ws-drawer-title">New Workspace / Folder</div>
                    <input
                        type="text"
                        className="sb-new-ws-drawer-input"
                        placeholder="Workspace name (e.g. scrape)"
                        value={newWorkspaceInputName}
                        onChange={e => setNewWorkspaceInputName(e.target.value)}
                        onKeyDown={e => {
                            if (e.key === 'Enter') {
                                setShowNewWorkspaceMenu(false);
                                handleCreateNewWorkspace();
                            } else if (e.key === 'Escape') {
                                setShowNewWorkspaceMenu(false);
                            }
                        }}
                        autoFocus
                    />
                    <div className="sb-new-ws-drawer-actions">
                        <button
                            type="button"
                            className="sb-new-ws-create-btn"
                            onClick={() => {
                                setShowNewWorkspaceMenu(false);
                                handleCreateNewWorkspace();
                            }}
                        >
                            Create Folder
                        </button>
                        <button
                            type="button"
                            className="sb-new-ws-open-btn"
                            onClick={() => {
                                setShowNewWorkspaceMenu(false);
                                if (onOpenFolder) {
                                    onOpenFolder();
                                } else if (onOpenWorkspace) {
                                    onOpenWorkspace();
                                }
                            }}
                            title="Open Folder from Disk"
                        >
                            Open...
                        </button>
                    </div>
                </div>
            )}

            {isWorkspacesExpanded && (
                <div className="sb-workspace-tree animate-fadeIn">
                    {/* Primary Active Workspace Header */}
                    <div className={`sb-workspace-node-active ${isWorkspaceCollapsed(activeWorkspace.id) ? 'sb-workspace-collapsed' : ''}`}>
                        <div className="sb-ws-node-header" onClick={() => toggleWorkspaceCollapse(activeWorkspace.id)}>
                            <div className="sb-ws-title-left">
                                <span
                                    className="sb-workspace-folder-chevron"
                                    onClick={e => toggleWorkspaceCollapse(activeWorkspace.id, e)}
                                    title={isWorkspaceCollapsed(activeWorkspace.id) ? 'Expand workspace folder' : 'Collapse workspace folder'}
                                >
                                    {isWorkspaceCollapsed(activeWorkspace.id) ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
                                </span>
                                <IconFolder size={13} className="text-zinc-300" />
                                <span className="sb-workspace-name" title={activeWorkspace.name}>{activeWorkspace.path.split('/').pop() || activeWorkspace.name}</span>
                            </div>
                            <div className="sb-ws-actions-right" onClick={e => e.stopPropagation()}>
                                <span className="sb-git-branch-pill">main</span>
                                {sidebarViewMode === 'threads' && (
                                    <button
                                        type="button"
                                        className="sb-workspace-add-btn"
                                        onClick={e => {
                                            e.stopPropagation();
                                            setShowAddFileMenu(!showAddFileMenu);
                                        }}
                                        title="Add file to workspace (Chat, Code, Document, Kanban)"
                                    >
                                        <IconPlus size={12} strokeWidth={2} />
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Floating Add File Dropdown */}
                        {showAddFileMenu && sidebarViewMode === 'threads' && (
                            <div className="sb-add-file-dropdown animate-popover" onClick={e => e.stopPropagation()}>
                                <div className="sb-dropdown-header">New Workspace File</div>
                                <button
                                    type="button"
                                    className="sb-dropdown-item"
                                    onClick={() => handleCreateWorkspaceFile('chat')}
                                >
                                    <IconChat size={13} className="text-zinc-400" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">New Chat</span>
                                        <span className="sb-dropdown-item-sub">Conversational AI thread</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-dropdown-item"
                                    onClick={() => handleCreateWorkspaceFile('code')}
                                >
                                    <IconCode size={13} className="text-zinc-300" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">Code Sandbox</span>
                                        <span className="sb-dropdown-item-sub">Interactive React / Python runner</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-dropdown-item"
                                    onClick={() => handleCreateWorkspaceFile('document')}
                                >
                                    <IconDocument size={13} className="text-zinc-300" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">Document Spec</span>
                                        <span className="sb-dropdown-item-sub">Rich block notes & spec</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-dropdown-item"
                                    onClick={() => handleCreateWorkspaceFile('kanban')}
                                >
                                    <IconKanban size={13} className="text-zinc-300" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">Kanban Board</span>
                                        <span className="sb-dropdown-item-sub">Sprint roadmap & stage tracking</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-dropdown-item"
                                    onClick={() => handleCreateWorkspaceFile('automation')}
                                >
                                    <IconAutomations size={13} className="text-zinc-300" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">Canvas Workflow</span>
                                        <span className="sb-dropdown-item-sub">Visual node graph & pipeline</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-dropdown-item"
                                    onClick={() => handleCreateWorkspaceFile('3d')}
                                >
                                    <Icon3D size={13} className="text-zinc-300" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">4D Scene</span>
                                        <span className="sb-dropdown-item-sub">Temporal 4-dimensional spatial studio</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-dropdown-item"
                                    onClick={() => handleCreateWorkspaceFile('browser')}
                                >
                                    <IconGlobe size={13} className="text-zinc-300" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">Web Browser</span>
                                        <span className="sb-dropdown-item-sub">Interactive AI-controlled web canvas</span>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    className="sb-dropdown-item"
                                    onClick={() => handleCreateWorkspaceFile('video')}
                                >
                                    <IconFilm size={13} className="text-pink-400" />
                                    <div className="sb-dropdown-item-text">
                                        <span className="sb-dropdown-item-title">Video Timeline</span>
                                        <span className="sb-dropdown-item-sub">Multi-track NLE & WebGL compositor</span>
                                    </div>
                                </button>
                            </div>
                        )}
                    </div>

                    {/* Active Workspace Chats or Files Tree */}
                    {!isWorkspaceCollapsed(activeWorkspace.id) && (
                        sidebarViewMode === 'explorer' ? (
                            <div className="sb-workspace-explorer-tree animate-fadeIn" style={{ paddingLeft: '8px', paddingBottom: '8px' }}>
                                <WorkspaceFileTree nodes={serverTree || (activeWorkspace.id === 'proj-3dpose' ? POSE_3D_TREE : SCRATCHBOX_TREE)} onFileClick={onFileClick} />
                            </div>
                        ) : (
                            <div className="sb-workspace-threads-list animate-fadeIn">
                                {sessions
                                    .filter(s => (s.workspaceId === activeWorkspace.id || (!s.workspaceId && activeWorkspace.id === 'proj-scratchbox-ide')) && (!sidebarSearchQuery || s.title.toLowerCase().includes(sidebarSearchQuery.toLowerCase())))
                                    .map((s, idx) => {
                                        const isSelected = currentSessionId === s.id;
                                        const rawTime = s.relativeTime || (idx === 0 ? '8m' : idx === 1 ? '47m' : idx === 2 ? '1h' : '4h');
                                        const relTime = rawTime === 'Just now' ? 'now' : rawTime.replace(' ago', '');
                                        return (
                                            <div
                                                key={`ws-active-${s.id}`}
                                                className={`sb-workspace-thread-item ${isSelected ? 'sb-workspace-thread-selected' : ''}`}
                                                onClick={() => handleSelectSession(s)}
                                                title={s.title}
                                            >
                                                <div className="sb-ws-thread-left">
                                                    {getSessionIcon(s) || (
                                                        <span className={`sb-cursor-radio-dot ${isSelected ? 'sb-cursor-dot-active' : ''}`}>
                                                            {isSelected ? '●' : '○'}
                                                        </span>
                                                    )}
                                                    <span className="sb-ws-thread-title">{s.title}</span>
                                                </div>
                                                <div className="sb-ws-thread-right">
                                                    <span className="sb-history-time-badge">{relTime}</span>
                                                    <button
                                                        type="button"
                                                        className="sb-history-item-delete"
                                                        onClick={e => handleDeleteSession(s.id, e)}
                                                        title="Delete conversation"
                                                    >
                                                        <IconClose size={10} strokeWidth={2.2} />
                                                    </button>
                                                </div>
                                            </div>
                                        );
                                    })}
                            </div>
                        )
                    )}

                    {/* Secondary Workspaces with associated chats/files */}
                    {workspaces.filter(p => p.id !== activeWorkspace.id && (sidebarViewMode === 'explorer' || sessions.some(s => s.workspaceId === p.id && (!sidebarSearchQuery || s.title.toLowerCase().includes(sidebarSearchQuery.toLowerCase()))))).map(proj => {
                        const projSessions = sessions.filter(s => s.workspaceId === proj.id && (!sidebarSearchQuery || s.title.toLowerCase().includes(sidebarSearchQuery.toLowerCase())));
                        const isCollapsed = isWorkspaceCollapsed(proj.id);
                        return (
                            <div key={`ws-group-${proj.id}`} className="sb-secondary-workspace-group">
                                <div className={`sb-workspace-node-secondary ${isCollapsed ? 'sb-workspace-collapsed' : ''}`}>
                                    <div className="sb-ws-node-header" onClick={() => {
                                        if (sidebarViewMode === 'explorer') {
                                            setActiveWorkspace(proj);
                                            showToast(`Switched active workspace to "${proj.name}"`);
                                        } else {
                                            toggleWorkspaceCollapse(proj.id);
                                        }
                                    }}>
                                        <div className="sb-ws-title-left">
                                            <span
                                                className="sb-workspace-folder-chevron"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    if (sidebarViewMode === 'explorer') {
                                                        setActiveWorkspace(proj);
                                                        showToast(`Switched active workspace to "${proj.name}"`);
                                                    } else {
                                                        toggleWorkspaceCollapse(proj.id, e);
                                                    }
                                                }}
                                                title={isCollapsed ? 'Expand workspace folder' : 'Collapse workspace folder'}
                                            >
                                                {isCollapsed ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
                                            </span>
                                            <IconFolder size={13} className="text-zinc-500" />
                                            <span
                                                className="sb-workspace-name-secondary"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    setActiveWorkspace(proj);
                                                    showToast(`Switched active workspace to "${proj.name}"`);
                                                }}
                                                title={`Switch to ${proj.name}`}
                                            >
                                                {proj.path.split('/').pop() || proj.name}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                {sidebarViewMode === 'threads' && !isCollapsed && (
                                    <div className="sb-workspace-threads-list animate-fadeIn">
                                        {projSessions.map(s => {
                                            const isSelected = currentSessionId === s.id;
                                            return (
                                                <div
                                                    key={`ws-sec-${s.id}`}
                                                    className={`sb-workspace-thread-item ${isSelected ? 'sb-workspace-thread-selected' : ''}`}
                                                    onClick={() => {
                                                        setActiveWorkspace(proj);
                                                        handleSelectSession(s);
                                                    }}
                                                    title={s.title}
                                                >
                                                    <div className="sb-ws-thread-left">
                                                        {getSessionIcon(s) || (
                                                            <span className={`sb-cursor-radio-dot ${isSelected ? 'sb-cursor-dot-active' : ''}`}>
                                                                {isSelected ? '●' : '○'}
                                                            </span>
                                                        )}
                                                        <span className="sb-ws-thread-title">{s.title}</span>
                                                    </div>
                                                    <div className="sb-ws-thread-right">
                                                        <span className="sb-history-time-badge">{(s.relativeTime === 'Just now' ? 'now' : (s.relativeTime || '2h')).replace(' ago', '')}</span>
                                                        <button
                                                            type="button"
                                                            className="sb-history-item-delete"
                                                            onClick={e => handleDeleteSession(s.id, e)}
                                                            title="Delete conversation"
                                                        >
                                                            <IconClose size={10} strokeWidth={2.2} />
                                                        </button>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>

        {/* Sidebar Bottom: User Profile & Settings Trigger */}
        <div className="sb-sidebar-profile-footer">
            <div className="sb-profile-avatar-info">
                <div className="sb-profile-avatar">{initialsOf(activeUserName)}</div>
                <div className="sb-profile-text">
                    <span className="sb-profile-name">{activeUserName}</span>
                </div>
            </div>

            <div className="flex items-center gap-1.5">
                <button
                    type="button"
                    className="sb-profile-settings-btn"
                    onClick={() => openSettingsToTab('general')}
                    title="Settings (⌘,)"
                >
                    <IconSettings size={14} strokeWidth={1.8} />
                </button>
            </div>
        </div>
    </aside>
    );
};
