/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { usePersistedProjects } from './hooks/usePersistedProjects';
import * as React from 'react';
import {
    IconArrowRight,
    IconClock,
    IconClose,
    IconFolder,
    IconGitBranch,
    IconPlus,
    IconSearch,
    IconSparkles,
    IconTemplate
} from './canvas-icons';

export interface ProjectItem {
    id: string;
    name: string;
    path: string;
    lastActive: string;
    tags: string[];
    isActive?: boolean;
    templateType?: string;
}

export interface StarterTemplateItem {
    id: string;
    title: string;
    subtitle: string;
    tag: string;
    prompt: string;
    accentColor: string;
}

export const DEFAULT_RECENT_PROJECTS: ProjectItem[] = [
    {
        id: 'proj-scratchbox-ide',
        name: 'scratchbox-ide-master',
        // Resolved at runtime from GET /workspace/config (server default = process.cwd()).
        path: '',
        lastActive: 'Active now',
        tags: ['TypeScript', 'React', 'Liquid Glass'],
        isActive: true
    }
];

/**
 * Test & demo workspace definitions retained for unit test suites and offline mock fixtures.
 * Kept separated from active runtime projects so users start with a clean, unencumbered workspace.
 */
export const DEMO_TEST_PROJECTS: ProjectItem[] = [
    {
        id: 'proj-hig-design-system',
        name: 'HIG Design System',
        path: '~/dev/hig-design-system',
        lastActive: 'Offline fixture',
        tags: ['Design System', 'React', 'TypeScript'],
        isActive: false
    },
    {
        id: 'proj-test-workspace',
        name: 'scratchbox-test-workspace',
        path: '~/dev/scratchbox-test-workspace',
        lastActive: 'Offline fixture',
        tags: ['Testing', 'Sandbox', 'Generative Canvas'],
        isActive: false
    }
];

const STARTER_TEMPLATES: StarterTemplateItem[] = [
    {
        id: 'template-blank-project',
        title: 'Blank Project Canvas',
        subtitle: 'Empty canvas workspace — prompt the AI to generate code, specs, workflows, or boards.',
        tag: 'Blank Workspace',
        prompt: '',
        accentColor: 'blue'
    },
    {
        id: 'template-apple-hig',
        title: 'HIG Design System',
        subtitle: 'Cupertino-grade UI components with Liquid Glass materials & SF Pro typography.',
        tag: 'Design System',
        prompt: 'Build a HIG Design System component library with 8-pt grid, Liquid Glass surfaces, and spring micro-interactions.',
        accentColor: 'indigo'
    },
    {
        id: 'template-agent-pipeline',
        title: 'Distributed Agent Pipeline',
        subtitle: 'Multi-agent orchestration with memory, live telemetry, and autonomous execution.',
        tag: 'Autonomous AI',
        prompt: 'Create a distributed multi-agent pipeline architecture with memory layers, MCP tool execution, and Sentry observability.',
        accentColor: 'purple'
    },
    {
        id: 'template-cloud-app',
        title: 'Full-Stack Cloud App',
        subtitle: 'TypeScript web app with PostgreSQL database schema and REST/GraphQL endpoints.',
        tag: 'Production Web',
        prompt: 'Generate an executive architecture and database schema for a production full-stack cloud web app with Postgres and Stripe.',
        accentColor: 'emerald'
    }
];

export interface ProjectsModalProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenFolder?: () => void;
    onCreateFile?: () => void;
    onOpenWorkspace?: () => void;
    onSelectPromptStarter?: (prompt: string) => void;
    onSelectProject?: (project: ProjectItem) => void;
    onExecuteCommand?: (commandId: string) => void;
}

export const ProjectsModal: React.FC<ProjectsModalProps> = ({
    isOpen,
    onClose,
    onOpenFolder,
    onCreateFile,
    onOpenWorkspace,
    onSelectPromptStarter,
    onSelectProject,
    onExecuteCommand
}) => {
    const [projects, setProjects] = React.useState<ProjectItem[]>(DEFAULT_RECENT_PROJECTS);
    usePersistedProjects(projects, setProjects);
    const [searchQuery, setSearchQuery] = React.useState<string>('');
    const [selectedProjectIndex, setSelectedProjectIndex] = React.useState<number>(0);
    const [showNewProjectDrawer, setShowNewProjectDrawer] = React.useState<boolean>(false);
    const [showCloneDrawer, setShowCloneDrawer] = React.useState<boolean>(false);
    const [newProjectName, setNewProjectName] = React.useState<string>('');
    const [selectedTemplateId, setSelectedTemplateId] = React.useState<string>('template-blank-project');
    const [gitCloneUrl, setGitCloneUrl] = React.useState<string>('');
    const [isCloning, setIsCloning] = React.useState<boolean>(false);
    const [cloneError, setCloneError] = React.useState<string | null>(null);
    const [toastMessage, setToastMessage] = React.useState<string | undefined>(undefined);

    const searchInputRef = React.useRef<HTMLInputElement>(null);

    React.useEffect(() => {
        if (isOpen) {
            setShowNewProjectDrawer(false);
            setShowCloneDrawer(false);
            setSearchQuery('');
            setSelectedProjectIndex(0);
            setIsCloning(false);
            setCloneError(null);
            setTimeout(() => {
                searchInputRef.current?.focus();
            }, 100);
        }
    }, [isOpen]);

    const showToast = (msg: string) => {
        setToastMessage(msg);
        setTimeout(() => {
            setToastMessage(undefined);
        }, 3200);
    };

    // Close drawers on Escape if open, otherwise close modal
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                if (showNewProjectDrawer) {
                    setShowNewProjectDrawer(false);
                } else if (showCloneDrawer) {
                    setShowCloneDrawer(false);
                } else {
                    onClose();
                }
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, showNewProjectDrawer, showCloneDrawer, onClose]);

    const filteredProjects = React.useMemo(() => {
        if (!searchQuery.trim()) {
            return projects;
        }
        const q = searchQuery.toLowerCase();
        return projects.filter(
            p =>
                p.name.toLowerCase().includes(q) ||
                p.path.toLowerCase().includes(q) ||
                p.tags?.some(t => t.toLowerCase().includes(q))
        );
    }, [projects, searchQuery]);

    const filteredTemplates = React.useMemo(() => {
        if (!searchQuery.trim()) {
            return STARTER_TEMPLATES;
        }
        const q = searchQuery.toLowerCase();
        return STARTER_TEMPLATES.filter(
            t =>
                t.title.toLowerCase().includes(q) ||
                t.subtitle.toLowerCase().includes(q) ||
                t.tag.toLowerCase().includes(q)
        );
    }, [searchQuery]);

    const handleOpenProject = (project: ProjectItem) => {
        setProjects(prev => prev.map(p => ({
            ...p,
            isActive: p.id === project.id
        })));
        onClose();
        if (onSelectProject) {
            onSelectProject(project);
        }
        if (onOpenFolder) {
            onOpenFolder();
        } else if (onOpenWorkspace) {
            onOpenWorkspace();
        } else if (onExecuteCommand) {
            onExecuteCommand('workspace:open');
        }
    };

    const handleCreateProject = () => {
        if (!newProjectName.trim()) {
            return;
        }
        const createdProject: ProjectItem = {
            id: `proj-${Date.now()}`,
            name: newProjectName.trim(),
            path: `~/dev/${newProjectName.trim().toLowerCase().replace(/\s+/g, '-')}`,
            lastActive: 'Just now',
            tags: ['Custom', 'Active Workspace']
        };
        setProjects(prev => [createdProject, ...prev]);
        setShowNewProjectDrawer(false);
        setNewProjectName('');
        showToast(`Workspace "${createdProject.name}" created!`);

        if (onSelectPromptStarter) {
            onClose();
            const template = STARTER_TEMPLATES.find(t => t.id === selectedTemplateId);
            const initialPrompt = template?.prompt || `Set up project ${createdProject.name} with architecture specs and file structure.`;
            onSelectPromptStarter(initialPrompt);
        }
    };

    const handleCloneRepo = async () => {
        if (!gitCloneUrl.trim() || isCloning) {
            return;
        }
        setIsCloning(true);
        setCloneError(null);
        const repoName = gitCloneUrl.split('/').pop()?.replace(/\.git$/, '') || 'cloned-repository';
        showToast(`Cloning ${gitCloneUrl}...`);
        try {
            const res = await fetch('/git/clone', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    repoUrl: gitCloneUrl.trim(),
                    name: repoName
                })
            });
            const data = await res.json();
            if (data.success && data.path) {
                const clonedProject: ProjectItem = {
                    id: `proj-${Date.now()}`,
                    name: repoName,
                    path: data.path,
                    lastActive: 'Just cloned',
                    tags: ['Git', 'Cloned', 'Remote']
                };
                setProjects(prev => [clonedProject, ...prev]);
                setShowCloneDrawer(false);
                setGitCloneUrl('');
                showToast(`Cloned ${repoName} successfully!`);

                if (onSelectProject) {
                    onSelectProject(clonedProject);
                } else if (onSelectPromptStarter) {
                    onClose();
                    onSelectPromptStarter(`Inspect and analyze cloned repository "${repoName}" from ${gitCloneUrl}.`);
                }
            } else {
                setCloneError(data.error || 'Git clone failed');
                showToast(`Clone failed: ${data.error || 'Unknown error'}`);
            }
        } catch (err: any) {
            setCloneError(err.message);
            showToast(`Clone error: ${err.message}`);
        } finally {
            setIsCloning(false);
        }
    };

    const handleUseTemplate = (template: StarterTemplateItem) => {
        onClose();
        if (onSelectPromptStarter) {
            onSelectPromptStarter(template.prompt);
        }
    };

    return (
        <div className="sb-settings-modal-backdrop sb-projects-modal-backdrop" onClick={onClose}>
            <div className="sb-settings-window-card sb-projects-window-card" onClick={e => e.stopPropagation()}>
                {/* Window Top Titlebar */}
                <div className="sb-settings-titlebar">
                    <div className="sb-settings-titlebar-left">
                        <div className="sb-mac-traffic-lights">
                            <span className="sb-traffic-light sb-tl-close" onClick={onClose} title="Close (Esc)" />
                            <span className="sb-traffic-light sb-tl-min" />
                            <span className="sb-traffic-light sb-tl-max" />
                        </div>
                        <div className="sb-titlebar-heading">
                            <IconFolder size={14} className="sb-titlebar-icon" />
                            <span className="sb-titlebar-title">Projects &amp; Workspaces Hub</span>
                        </div>
                    </div>

                    <div className="sb-settings-titlebar-right">
                        <button
                            type="button"
                            className="sb-btn sb-btn-primary sb-btn-sm sb-done-btn"
                            onClick={onClose}
                        >
                            <span>Done</span>
                            <span className="sb-esc-pill">Esc</span>
                        </button>
                    </div>
                </div>

                {/* Window Content */}
                <div className="sb-projects-modal-body">
                    {/* Header & Search */}
                    <div className="sb-projects-header-row">
                        <div className="sb-projects-header-info">
                            <h2 className="sb-projects-title">Projects &amp; Workspaces</h2>
                            <p className="sb-projects-subtitle">
                                Open, manage, or scaffold project workspaces with Apple-grade speed.
                            </p>
                        </div>

                        {/* Search Filter Bar */}
                        <div className="sb-projects-search-bar">
                            <IconSearch size={15} className="sb-search-icon" />
                            <input
                                ref={searchInputRef}
                                type="text"
                                className="sb-projects-search-input"
                                placeholder="Filter workspaces or templates (↑/↓ to select, Enter to open)..."
                                value={searchQuery}
                                onChange={e => {
                                    setSearchQuery(e.target.value);
                                    setSelectedProjectIndex(0);
                                }}
                                onKeyDown={e => {
                                    if (e.key === 'ArrowDown') {
                                        e.preventDefault();
                                        setSelectedProjectIndex(idx => (idx + 1) % Math.max(1, filteredProjects.length));
                                    } else if (e.key === 'ArrowUp') {
                                        e.preventDefault();
                                        setSelectedProjectIndex(idx => (idx - 1 + filteredProjects.length) % Math.max(1, filteredProjects.length));
                                    } else if (e.key === 'Enter') {
                                        e.preventDefault();
                                        if (filteredProjects.length > 0 && filteredProjects[selectedProjectIndex]) {
                                            handleOpenProject(filteredProjects[selectedProjectIndex]);
                                        }
                                    }
                                }}
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    className="sb-projects-search-clear"
                                    onClick={() => {
                                        setSearchQuery('');
                                        setSelectedProjectIndex(0);
                                    }}
                                    title="Clear search"
                                >
                                    <IconClose size={12} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Toast Notification Pill */}
                    {toastMessage && (
                        <div className="sb-projects-toast-pill">
                            <span>{toastMessage}</span>
                        </div>
                    )}

                    {/* Project Actions Bar (4 Minimalist Vector Action Cards) */}
                    <div className="sb-project-actions-grid">
                        <button
                            type="button"
                            className="sb-action-card sb-action-new-project"
                            onClick={() => {
                                setShowNewProjectDrawer(true);
                                setShowCloneDrawer(false);
                            }}
                        >
                            <div className="sb-action-card-icon-wrap">
                                <IconPlus size={18} strokeWidth={2} />
                            </div>
                            <div className="sb-action-card-text">
                                <span className="sb-action-card-title">New Project</span>
                                <span className="sb-action-card-desc">Quick scaffolding wizard</span>
                            </div>
                        </button>

                        <button
                            type="button"
                            className="sb-action-card"
                            onClick={() => {
                                onClose();
                                if (onOpenFolder) {
                                    onOpenFolder();
                                } else if (onExecuteCommand) {
                                    onExecuteCommand('workspace:open');
                                }
                            }}
                        >
                            <div className="sb-action-card-icon-wrap">
                                <IconFolder size={18} strokeWidth={1.8} />
                            </div>
                            <div className="sb-action-card-text">
                                <span className="sb-action-card-title">Open Local Folder</span>
                                <span className="sb-action-card-desc">Browse local disk</span>
                            </div>
                        </button>

                        <button
                            type="button"
                            className="sb-action-card"
                            onClick={() => {
                                setShowCloneDrawer(true);
                                setShowNewProjectDrawer(false);
                            }}
                        >
                            <div className="sb-action-card-icon-wrap">
                                <IconGitBranch size={18} strokeWidth={1.8} />
                            </div>
                            <div className="sb-action-card-text">
                                <span className="sb-action-card-title">Clone from Git</span>
                                <span className="sb-action-card-desc">Clone GitHub repository</span>
                            </div>
                        </button>

                        <button
                            type="button"
                            className="sb-action-card"
                            onClick={() => {
                                onClose();
                                if (onCreateFile) {
                                    onCreateFile();
                                } else if (onExecuteCommand) {
                                    onExecuteCommand('file:newFile');
                                }
                            }}
                        >
                            <div className="sb-action-card-icon-wrap">
                                <IconTemplate size={18} strokeWidth={1.8} />
                            </div>
                            <div className="sb-action-card-text">
                                <span className="sb-action-card-title">New File</span>
                                <span className="sb-action-card-desc">Create standalone document</span>
                            </div>
                        </button>
                    </div>

                    {/* Drawer 1: New Project Wizard */}
                    {showNewProjectDrawer && (
                        <div className="sb-inline-drawer-card">
                            <div className="sb-inline-drawer-header">
                                <div className="sb-drawer-header-left">
                                    <IconPlus size={15} strokeWidth={2} />
                                    <span className="sb-drawer-title">Scaffold New Project</span>
                                </div>
                                <button
                                    type="button"
                                    className="sb-drawer-close-btn"
                                    onClick={() => setShowNewProjectDrawer(false)}
                                >
                                    <IconClose size={13} />
                                </button>
                            </div>

                            <div className="sb-inline-drawer-body">
                                <div className="sb-form-group">
                                    <label className="sb-form-label">Project Name</label>
                                    <input
                                        type="text"
                                        className="sb-text-input"
                                        placeholder="e.g. generative-canvas-app"
                                        value={newProjectName}
                                        onChange={e => setNewProjectName(e.target.value)}
                                        autoFocus
                                    />
                                </div>

                                <div className="sb-form-group">
                                    <label className="sb-form-label">Starter Template</label>
                                    <div className="sb-template-picker-grid">
                                        {STARTER_TEMPLATES.map(tmpl => (
                                            <div
                                                key={tmpl.id}
                                                className={`sb-picker-card ${selectedTemplateId === tmpl.id ? 'sb-picker-card-selected' : ''}`}
                                                onClick={() => setSelectedTemplateId(tmpl.id)}
                                            >
                                                <div className="sb-picker-top">
                                                    <span className="sb-picker-title">{tmpl.title}</span>
                                                    <span className="sb-picker-tag">{tmpl.tag}</span>
                                                </div>
                                                <p className="sb-picker-desc">{tmpl.subtitle}</p>
                                            </div>
                                        ))}
                                    </div>
                                </div>

                                <div className="sb-drawer-actions-row">
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-secondary sb-btn-sm"
                                        onClick={() => setShowNewProjectDrawer(false)}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-primary sb-btn-sm"
                                        disabled={!newProjectName.trim()}
                                        onClick={handleCreateProject}
                                    >
                                        <span>Create &amp; Launch</span>
                                        <IconArrowRight size={13} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Drawer 2: Clone from Git Drawer */}
                    {showCloneDrawer && (
                        <div className="sb-inline-drawer-card">
                            <div className="sb-inline-drawer-header">
                                <div className="sb-drawer-header-left">
                                    <IconGitBranch size={15} strokeWidth={1.8} />
                                    <span className="sb-drawer-title">Clone Repository from Git</span>
                                </div>
                                <button
                                    type="button"
                                    className="sb-drawer-close-btn"
                                    onClick={() => setShowCloneDrawer(false)}
                                >
                                    <IconClose size={13} />
                                </button>
                            </div>

                            <div className="sb-inline-drawer-body">
                                <div className="sb-form-group">
                                    <label className="sb-form-label">Repository URL</label>
                                    <input
                                        type="text"
                                        className="sb-text-input"
                                        placeholder="https://github.com/organization/repository.git"
                                        value={gitCloneUrl}
                                        onChange={e => setGitCloneUrl(e.target.value)}
                                        autoFocus
                                    />
                                    <span className="sb-form-hint">
                                        Supports HTTPS and SSH URLs from GitHub, GitLab, and Bitbucket.
                                    </span>
                                </div>

                                {cloneError && (
                                    <div className="text-xs text-red-400 bg-red-950/40 border border-red-500/30 px-3 py-1.5 rounded-lg mb-3">
                                        {cloneError}
                                    </div>
                                )}

                                <div className="sb-drawer-actions-row">
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-secondary sb-btn-sm"
                                        disabled={isCloning}
                                        onClick={() => setShowCloneDrawer(false)}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-primary sb-btn-sm"
                                        disabled={!gitCloneUrl.trim() || isCloning}
                                        onClick={handleCloneRepo}
                                    >
                                        <span>{isCloning ? 'Cloning Repository...' : 'Clone & Open Workspace'}</span>
                                        <IconArrowRight size={13} />
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Main Scroll Area: Recent Workspaces & Starter Templates */}
                    <div className="sb-projects-scroll-area">
                        {/* Section 1: Recent Workspaces */}
                        <div className="sb-projects-section">
                            <div className="sb-section-heading-row">
                                <h3 className="sb-section-heading">Recent &amp; Active Workspaces</h3>
                                <span className="sb-section-counter">{filteredProjects.length} workspaces</span>
                            </div>

                            <div className="sb-workspaces-grid">
                                {filteredProjects.length > 0 ? (
                                    filteredProjects.map((proj, idx) => {
                                        const isKeyboardSelected = idx === selectedProjectIndex;
                                        return (
                                            <div
                                                key={proj.id}
                                                className={`sb-workspace-card ${proj.isActive ? 'sb-workspace-active' : ''} ${isKeyboardSelected ? 'sb-workspace-selected' : ''}`}
                                                onClick={() => handleOpenProject(proj)}
                                                onMouseEnter={() => setSelectedProjectIndex(idx)}
                                            >
                                                <div className="sb-workspace-card-top">
                                                    <div className="sb-workspace-icon-box">
                                                        <IconFolder size={17} strokeWidth={1.8} />
                                                    </div>
                                                    <div className="sb-workspace-name-wrap">
                                                        <div className="sb-workspace-title-row">
                                                            <span className="sb-workspace-title">{proj.name}</span>
                                                            {proj.isActive && (
                                                                <span className="sb-active-pill">Active</span>
                                                            )}
                                                        </div>
                                                        <span className="sb-workspace-path">{proj.path || 'Current server directory'}</span>
                                                    </div>
                                                </div>

                                                <div className="sb-workspace-card-bottom">
                                                    <div className="sb-workspace-tags-list">
                                                        {proj.tags.map((t, tIdx) => (
                                                            <span key={tIdx} className="sb-workspace-tag">{t}</span>
                                                        ))}
                                                    </div>

                                                    <div className="sb-workspace-footer-right">
                                                        <span className="sb-workspace-time">
                                                            <IconClock size={11} />
                                                            <span>{proj.lastActive}</span>
                                                        </span>
                                                        <button
                                                            type="button"
                                                            className="sb-workspace-open-btn"
                                                            onClick={e => {
                                                                e.stopPropagation();
                                                                handleOpenProject(proj);
                                                            }}
                                                        >
                                                            <span>{proj.isActive ? 'Active' : 'Open'}</span>
                                                            <IconArrowRight size={11} />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })
                                ) : (
                                    <div className="sb-empty-workspaces">
                                        <IconFolder size={28} strokeWidth={1.4} />
                                        <span>No workspaces matching "{searchQuery}"</span>
                                        <div className="flex items-center gap-2 mt-3">
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-secondary sb-btn-xs"
                                                onClick={() => {
                                                    setSearchQuery('');
                                                    setSelectedProjectIndex(0);
                                                }}
                                            >
                                                Clear search
                                            </button>
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-primary sb-btn-xs"
                                                onClick={() => {
                                                    setShowNewProjectDrawer(true);
                                                    setNewProjectName(searchQuery);
                                                }}
                                            >
                                                <IconPlus size={11} />
                                                <span>Create new project</span>
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Section 2: Instant Starter Templates */}
                        <div className="sb-projects-section">
                            <div className="sb-section-heading-row">
                                <div className="sb-section-title-wrap">
                                    <IconSparkles size={15} strokeWidth={1.8} />
                                    <h3 className="sb-section-heading">Instant Starter Templates</h3>
                                </div>
                                <span className="sb-section-counter">4 curated templates</span>
                            </div>

                            <div className="sb-templates-grid">
                                {filteredTemplates.map(tmpl => (
                                    <div
                                        key={tmpl.id}
                                        className={`sb-template-card sb-tmpl-${tmpl.accentColor}`}
                                        onClick={() => handleUseTemplate(tmpl)}
                                    >
                                        <div className="sb-template-card-header">
                                            <span className="sb-template-card-tag">{tmpl.tag}</span>
                                            <button
                                                type="button"
                                                className="sb-template-use-btn"
                                                onClick={e => {
                                                    e.stopPropagation();
                                                    handleUseTemplate(tmpl);
                                                }}
                                                title="Use this starter template"
                                            >
                                                <span>Use Template</span>
                                                <IconArrowRight size={11} />
                                            </button>
                                        </div>

                                        <h4 className="sb-template-card-title">{tmpl.title}</h4>
                                        <p className="sb-template-card-desc">{tmpl.subtitle}</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
