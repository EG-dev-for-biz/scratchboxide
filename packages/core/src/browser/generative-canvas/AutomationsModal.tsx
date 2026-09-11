/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import {
    CanvasArtifact,
    KanbanBoardData,
    LiveCodeSandboxData,
    MarkdownDocumentData,
    NodeGraphData,
    PrimitiveType
} from './canvas-types';
import {
    getPrimitiveSvgIcon,
    IconArrowRight,
    IconAutomations,
    IconCheck,
    IconClose,
    IconCode,
    IconDocument,
    IconGoogleDocs,
    IconGoogleDriveColor,
    IconKanban,
    IconNodeGraph,
    IconSearch,
    IconSparkles
} from './canvas-icons';
import { GoogleDriveConnectionState, GoogleDriveService } from './google-drive-service';

export interface AutomationTemplateItem {
    id: string;
    title: string;
    subtitle: string;
    primitiveType: PrimitiveType;
    category: 'Pipeline' | 'Interactive UI' | 'Specification' | 'Sprint' | 'Analytics';
    tag: string;
    accentColor: string;
    prompt: string;
    sampleArtifact: CanvasArtifact;
}

export const AUTOMATION_CANVAS_TEMPLATES: AutomationTemplateItem[] = [
    {
        id: 'tmpl-gdrive-sync',
        title: 'Google Drive & Docs Auto-Sync Pipeline',
        subtitle: 'Automated document spec pipeline with real-time Google Docs conversion, file backup, and Drive search',
        primitiveType: 'node-graph',
        category: 'Pipeline',
        tag: 'Google Drive',
        accentColor: 'blue',
        prompt: 'Generate an automated Google Drive document sync workflow that converts Markdown architecture specs into Google Docs format.',
        sampleArtifact: {
            id: 'art-tmpl-gdrive-node-graph',
            type: 'node-graph',
            title: 'Google Drive & Docs Auto-Sync Pipeline',
            summary: 'Live document conversion, Drive file upload, and semantic search routing.',
            version: 1,
            createdAt: 'Just now',
            data: {
                title: 'Google Drive & Docs Auto-Sync Pipeline',
                subtitle: 'Real-time document format converter and Google Drive cloud synchronizer',
                nodes: [
                    { id: 'node-gdrive-trigger', label: 'Document Change Trigger', subtitle: 'On Spec Save / Update', category: 'input', color: 'blue', x: 60, y: 160, status: 'completed', parameters: { event: 'document.save', debounceMs: 1000 } },
                    { id: 'node-gdrive-ai', label: 'AI Document Formatter', subtitle: 'Autonomous AI Agent', category: 'ai', color: 'purple', x: 420, y: 80, status: 'running', parameters: { model: 'gemini-3.7-flash', format: 'google-docs' } },
                    { id: 'node-gdrive-mcp', label: 'Google Drive & Docs MCP', subtitle: 'create_document / upload_file', category: 'mcp', color: 'blue', x: 420, y: 280, status: 'completed', parameters: { server: 'mcp-google-drive', tools: ['create_document', 'upload_file', 'list_drive_files', 'search_drive'] } },
                    { id: 'node-gdrive-sync', label: 'Google Docs Exporter', subtitle: 'docs.google.com sync', category: 'database', color: 'emerald', x: 780, y: 160, status: 'completed', parameters: { autoSync: true, notify: true } }
                ],
                edges: [
                    { id: 'ge1', source: 'node-gdrive-trigger', target: 'node-gdrive-ai', label: 'Spec AST', style: 'solid', color: 'purple' },
                    { id: 'ge2', source: 'node-gdrive-trigger', target: 'node-gdrive-mcp', label: 'Payload', style: 'dashed', color: 'blue' },
                    { id: 'ge3', source: 'node-gdrive-ai', target: 'node-gdrive-sync', label: 'Formatted Doc', style: 'solid', color: 'emerald' },
                    { id: 'ge4', source: 'node-gdrive-mcp', target: 'node-gdrive-sync', label: 'Drive File ID', style: 'solid', color: 'emerald' }
                ]
            } as NodeGraphData
        }
    },
    {
        id: 'tmpl-n8n-pipeline',
        title: 'AI Webhook & Reasoning Pipeline',
        subtitle: 'Bi-directional N8N logic flow connecting Webhook triggers, Gemini reasoning, and MCP tools',
        primitiveType: 'node-graph',
        category: 'Pipeline',
        tag: 'Node Graph',
        accentColor: 'purple',
        prompt: 'Generate an interactive node flow graph mapping user authentication, AI prompt routing, and database execution.',
        sampleArtifact: {
            id: 'art-tmpl-node-graph',
            type: 'node-graph',
            title: 'N8N AI Reasoning & MCP Pipeline',
            summary: 'Visual node flow with bi-directional drag wiring and parameter inspection.',
            version: 1,
            createdAt: 'Just now',
            data: {
                title: 'N8N AI Reasoning & MCP Pipeline',
                subtitle: 'Visual node graph & logic builder with bi-directional wiring & parameter editing',
                nodes: [
                    { id: 'node-trigger', label: 'Webhook Trigger', subtitle: 'POST /api/v1/events', category: 'input', color: 'blue', x: 60, y: 160, status: 'completed', parameters: { triggerType: 'webhook', endpoint: '/api/v1/events', httpMethod: 'POST' } },
                    { id: 'node-ai', label: 'AI Reasoning Engine', subtitle: 'Autonomous AI Agent', category: 'ai', color: 'purple', x: 420, y: 80, status: 'running', parameters: { model: 'gemini-3.7-flash', temperature: 0.2 } },
                    { id: 'node-mcp', label: 'MCP Integrations', subtitle: 'Stripe & GitHub Tools', category: 'mcp', color: 'indigo', x: 420, y: 280, status: 'pending', parameters: { server: 'mcp-stripe', tool: 'get_balance' } },
                    { id: 'node-gate', label: 'Decision Gate', subtitle: 'Confidence > 0.85', category: 'decision', color: 'amber', x: 780, y: 160, status: 'pending', parameters: { rule: 'payload.confidence > 0.85' } },
                    { id: 'node-cli', label: 'CLI Test Runner', subtitle: 'yarn test:verification', category: 'cli', color: 'emerald', x: 1140, y: 80, status: 'pending', parameters: { command: 'yarn test' } },
                    { id: 'node-db', label: 'Database Action', subtitle: 'PostgreSQL Audit Sink', category: 'database', color: 'cyan', x: 1140, y: 280, status: 'pending', parameters: { database: 'postgresql', table: 'workflow_logs' } }
                ],
                edges: [
                    { id: 'e1', source: 'node-trigger', target: 'node-ai', label: 'Payload', style: 'solid', color: 'purple' },
                    { id: 'e2', source: 'node-trigger', target: 'node-mcp', label: 'Tool Events', style: 'dashed', color: 'indigo' },
                    { id: 'e3', source: 'node-ai', target: 'node-gate', label: 'Reasoning', style: 'solid', color: 'amber' },
                    { id: 'e4', source: 'node-mcp', target: 'node-gate', label: 'Telemetry', style: 'solid', color: 'amber' },
                    { id: 'e5', source: 'node-gate', target: 'node-cli', label: 'True Branch', style: 'solid', color: 'emerald' },
                    { id: 'e6', source: 'node-gate', target: 'node-db', label: 'Log Stream', style: 'dashed', color: 'cyan' }
                ]
            } as NodeGraphData
        }
    },
    {
        id: 'tmpl-live-sandbox',
        title: 'Live React 19 UI Playground',
        subtitle: 'Multi-tab hot-reloading code editor with ESM package imports and runtime console bridge',
        primitiveType: 'live-code-sandbox',
        category: 'Interactive UI',
        tag: 'Live Sandbox',
        accentColor: 'blue',
        prompt: 'Create a live interactive UI component playground with React 19, Framer Motion animations, and confetti triggers.',
        sampleArtifact: {
            id: 'art-tmpl-live-sandbox',
            type: 'live-code-sandbox',
            title: 'Interactive React 19 UI Playground',
            summary: 'Live editable multi-tab code runner with hot reload, CDN packages & runtime console.',
            version: 1,
            createdAt: 'Just now',
            data: {
                title: 'Interactive React 19 UI Playground',
                subtitle: 'Multi-tab live code runner with hot reload & runtime console',
                template: 'react',
                files: [
                    {
                        id: 'file-app',
                        name: 'App.tsx',
                        language: 'react',
                        content: `import React, { useState } from 'react';
import { Sparkles, Play, CheckCircle2 } from 'lucide-react';
import confetti from 'canvas-confetti';

export default function App() {
  const [count, setCount] = useState(0);

  const handleCelebrate = () => {
    setCount(prev => prev + 1);
    confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });
    console.log('Celebration triggered! Count:', count + 1);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100">
      <div className="w-full max-w-md p-8 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/80 rounded-3xl shadow-2xl space-y-6 text-center">
        <div className="inline-flex p-3 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
          <Sparkles className="w-8 h-8 animate-pulse" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-white">Live React Sandbox</h1>
        <div className="p-4 bg-zinc-950/60 rounded-2xl border border-zinc-800 flex justify-around">
          <div><div className="text-xs text-zinc-500">Count</div><div className="text-2xl font-bold text-blue-400">{count}</div></div>
          <div><div className="text-xs text-zinc-500">Status</div><div className="text-sm font-semibold text-emerald-400">Live</div></div>
        </div>
        <button onClick={handleCelebrate} className="sb-btn sb-btn-primary w-full py-3 rounded-xl font-semibold flex items-center justify-center gap-2">
          <Play className="w-4 h-4 fill-current" />
          <span>Trigger Interactive Action</span>
        </button>
      </div>
    </div>
  );
}`,
                        isEntry: true
                    },
                    {
                        id: 'file-css',
                        name: 'styles.css',
                        language: 'css',
                        content: `body { margin: 0; padding: 0; }`
                    }
                ],
                dependencies: {
                    'lucide-react': '^0.468.0',
                    'canvas-confetti': '^1.9.3'
                },
                viewportMode: 'desktop'
            } as LiveCodeSandboxData
        }
    },
    {
        id: 'tmpl-rich-spec',
        title: 'Architecture Blueprint & Spec',
        subtitle: 'Rich structured block document with callouts, comparison matrices, and diff tracking',
        primitiveType: 'markdown-document',
        category: 'Specification',
        tag: 'Document Spec',
        accentColor: 'cyan',
        prompt: 'Draft an executive product strategy document for Scratchbox 2.0 with architecture callouts and comparison tables.',
        sampleArtifact: {
            id: 'art-tmpl-spec',
            type: 'markdown-document',
            title: 'Scratchbox 2.0: Architecture Blueprint',
            summary: 'Executive specification with block tables and callouts.',
            version: 1,
            createdAt: 'Just now',
            data: {
                title: 'Scratchbox 2.0: Architecture Blueprint',
                subtitle: 'AI-Native Development with Collaborative Visual Canvas',
                sections: [
                    { id: 'sec-1', type: 'heading', level: 1, content: '1. Executive Summary' },
                    { id: 'sec-2', type: 'paragraph', content: 'Scratchbox transforms software engineering into an interactive visual canvas.' },
                    { id: 'sec-3', type: 'callout', calloutType: 'tip', calloutTitle: 'Live MCP Telemetry', content: 'Typed MCP tools connect real-time financial balances and repositories directly to canvas blocks.' },
                    { id: 'sec-4', type: 'table', tableHeaders: ['Capability', 'Scratchbox IDE', 'Legacy IDEs'], tableRows: [['Visual Canvas', 'Interactive Live', 'None'], ['Live MCP', 'Built-in Streaming', 'Manual']] }
                ]
            } as MarkdownDocumentData
        }
    },
    {
        id: 'tmpl-sprint-kanban',
        title: 'Release Roadmap & Sprint Board',
        subtitle: 'Multi-column Kanban workflow with priority queues, assignee pills, and stage metrics',
        primitiveType: 'kanban-board',
        category: 'Sprint',
        tag: 'Kanban Board',
        accentColor: 'emerald',
        prompt: 'Create a Kanban board for our v2.0 product launch with Backlog, In Progress, QA Review, and Released.',
        sampleArtifact: {
            id: 'art-tmpl-kanban',
            type: 'kanban-board',
            title: 'Product Launch Kanban Board',
            summary: 'Sprint delivery board with 4 automated columns.',
            version: 1,
            createdAt: 'Just now',
            data: {
                title: 'Scratchbox 2.0 Launch Roadmap',
                subtitle: 'Multi-stage delivery board with priority items',
                columns: [
                    { id: 'col-backlog', title: 'Backlog', color: 'indigo', cards: [{ id: 'c1', title: 'Setup MCP Stream', priority: 'high', completedSubtasks: 2, totalSubtasks: 4 }] },
                    { id: 'col-inprogress', title: 'In Progress', color: 'blue', cards: [{ id: 'c2', title: 'N8N Canvas Surfaces', priority: 'urgent', completedSubtasks: 3, totalSubtasks: 3 }] },
                    { id: 'col-qa', title: 'QA Review', color: 'amber', cards: [{ id: 'c3', title: 'Subagent Fallback Matrix', priority: 'high', completedSubtasks: 2, totalSubtasks: 2 }] },
                    { id: 'col-done', title: 'Done', color: 'emerald', cards: [{ id: 'c4', title: 'AI Studio Backend Engine', priority: 'high' }] }
                ]
            } as KanbanBoardData
        }
    }
];

export interface AutomationsModalProps {
    isOpen: boolean;
    onClose: () => void;
    savedArtifacts?: CanvasArtifact[];
    onOpenCanvasArtifact: (artifact: CanvasArtifact) => void;
    onCreateNewCanvas: (type: PrimitiveType) => void;
    onSelectPromptStarter?: (prompt: string) => void;
}

export const AutomationsModal: React.FC<AutomationsModalProps> = ({
    isOpen,
    onClose,
    savedArtifacts = [],
    onOpenCanvasArtifact,
    onCreateNewCanvas,
    onSelectPromptStarter
}) => {
    const [searchQuery, setSearchQuery] = React.useState<string>('');
    const [selectedCategory, setSelectedCategory] = React.useState<string>('all');
    const [gdriveState, setGdriveState] = React.useState<GoogleDriveConnectionState>(() => GoogleDriveService.getInstance().getState());
    const [isConnectingDrive, setIsConnectingDrive] = React.useState<boolean>(false);
    const [driveFeedback, setDriveFeedback] = React.useState<string | null>(null);

    const searchInputRef = React.useRef<HTMLInputElement>(null);

    React.useEffect(() => {
        const unsubscribe = GoogleDriveService.getInstance().subscribe(state => {
            setGdriveState(state);
        });
        return () => unsubscribe();
    }, []);

    React.useEffect(() => {
        if (isOpen) {
            setSearchQuery('');
            setSelectedCategory('all');
            setTimeout(() => searchInputRef.current?.focus(), 100);
        }
    }, [isOpen]);

    // Close on Escape
    React.useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && isOpen) {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    if (!isOpen) {
        return null;
    }

    const filteredTemplates = AUTOMATION_CANVAS_TEMPLATES.filter(tmpl => {
        const matchesQuery = !searchQuery ||
            tmpl.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
            tmpl.subtitle.toLowerCase().includes(searchQuery.toLowerCase()) ||
            tmpl.tag.toLowerCase().includes(searchQuery.toLowerCase());
        const matchesCategory = selectedCategory === 'all' || tmpl.category.toLowerCase() === selectedCategory.toLowerCase();
        return matchesQuery && matchesCategory;
    });

    const filteredAutomations = savedArtifacts.filter(art => {
        const matchesQuery = !searchQuery ||
            (art.title || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
            (art.summary || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
            (art.type || '').toLowerCase().includes(searchQuery.toLowerCase());

        let matchesCategory = true;
        if (selectedCategory !== 'all') {
            const cat = selectedCategory.toLowerCase();
            if (cat === 'pipeline') matchesCategory = art.type === 'node-graph';
            else if (cat === 'interactive ui') matchesCategory = art.type === 'live-code-sandbox';
            else if (cat === 'specification') matchesCategory = art.type === 'markdown-document';
            else if (cat === 'sprint') matchesCategory = art.type === 'kanban-board';
            else if (cat === 'analytics') matchesCategory = art.type === 'live-code-sandbox' || art.type === 'node-graph';
        }
        return matchesQuery && matchesCategory;
    });

    const handleCreateType = (type: PrimitiveType) => {
        onClose();
        onCreateNewCanvas(type);
    };

    const handleOpenTemplate = (tmpl: AutomationTemplateItem) => {
        onClose();
        onOpenCanvasArtifact(tmpl.sampleArtifact);
        if (onSelectPromptStarter) {
            onSelectPromptStarter(tmpl.prompt);
        }
    };

    return (
        <div className="sb-settings-modal-backdrop sb-automations-modal-backdrop" onClick={onClose}>
            <div className="sb-settings-window-card sb-automations-window-card" onClick={e => e.stopPropagation()}>
                {/* Top Window Titlebar */}
                <div className="sb-settings-titlebar">
                    <div className="sb-settings-titlebar-left">
                        <div className="sb-mac-traffic-lights">
                            <span className="sb-traffic-light sb-tl-close" onClick={onClose} title="Close (Esc)" />
                            <span className="sb-traffic-light sb-tl-min" />
                            <span className="sb-traffic-light sb-tl-max" />
                        </div>
                        <div className="sb-titlebar-heading">
                            <IconAutomations size={14} className="sb-titlebar-icon text-blue-400" />
                            <span className="sb-titlebar-title">Automations &amp; Canvas Workflows</span>
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

                {/* Modal Body */}
                <div className="sb-automations-modal-body">
                    {/* Header & Search */}
                    <div className="sb-projects-header-row">
                        <div className="sb-projects-header-info">
                            <h2 className="sb-projects-title">Automations &amp; Canvas Workflows</h2>
                            <p className="sb-projects-subtitle">
                                Create, orchestrate, and launch interactive canvas primitives and automated logic pipelines.
                            </p>
                        </div>

                        {/* Search Filter Bar */}
                        <div className="sb-projects-search-bar">
                            <IconSearch size={14} className="sb-search-icon" />
                            <input
                                ref={searchInputRef}
                                type="text"
                                className="sb-projects-search-input"
                                placeholder="Search canvas workflows, templates, or primitives..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                            />
                            {searchQuery && (
                                <button
                                    type="button"
                                    className="sb-projects-search-clear"
                                    onClick={() => setSearchQuery('')}
                                >
                                    <IconClose size={11} />
                                </button>
                            )}
                        </div>
                    </div>

                    {/* Category Filter Pills Row */}
                    <div className="sb-category-pills-row mb-4">
                        {(['all', 'Pipeline', 'Interactive UI', 'Specification', 'Sprint', 'Analytics'] as const).map(cat => {
                            const isSelected = selectedCategory.toLowerCase() === cat.toLowerCase();
                            return (
                                <button
                                    key={cat}
                                    type="button"
                                    className={`sb-category-pill ${isSelected ? 'sb-category-pill-active' : ''}`}
                                    onClick={() => setSelectedCategory(cat)}
                                >
                                    <span>{cat === 'all' ? 'All Workflows' : cat}</span>
                                </button>
                            );
                        })}
                    </div>

                    {/* 1-Click Quick Creation Grid (4 Core Primitives) */}
                    <div className="sb-quick-actions-grid">
                        <button
                            type="button"
                            className="sb-action-card"
                            onClick={() => handleCreateType('node-graph')}
                        >
                            <div className="sb-action-card-icon-wrap" style={{ color: 'var(--sb-system-purple, #a855f7)', background: 'var(--sb-system-purple-subtle, rgba(168, 85, 247, 0.12))' }}>
                                <IconNodeGraph size={18} strokeWidth={1.8} />
                            </div>
                            <div className="sb-action-card-text">
                                <span className="sb-action-card-title">Node Graph (N8N Flow)</span>
                                <span className="sb-action-card-desc">Visual logic &amp; webhook pipeline</span>
                            </div>
                        </button>

                        <button
                            type="button"
                            className="sb-action-card"
                            onClick={() => handleCreateType('live-code-sandbox')}
                        >
                            <div className="sb-action-card-icon-wrap" style={{ color: 'var(--sb-system-blue, #3b82f6)', background: 'var(--sb-system-blue-subtle, rgba(59, 130, 246, 0.12))' }}>
                                <IconCode size={18} strokeWidth={1.8} />
                            </div>
                            <div className="sb-action-card-text">
                                <span className="sb-action-card-title">Live Code Sandbox</span>
                                <span className="sb-action-card-desc">React 19 &amp; Python playground</span>
                            </div>
                        </button>

                        <button
                            type="button"
                            className="sb-action-card"
                            onClick={() => handleCreateType('markdown-document')}
                        >
                            <div className="sb-action-card-icon-wrap" style={{ color: 'var(--sb-system-cyan, #06b6d4)', background: 'var(--sb-system-cyan-subtle, rgba(6, 182, 212, 0.12))' }}>
                                <IconDocument size={18} strokeWidth={1.8} />
                            </div>
                            <div className="sb-action-card-text">
                                <span className="sb-action-card-title">Document Spec</span>
                                <span className="sb-action-card-desc">Block specs with tables &amp; diffs</span>
                            </div>
                        </button>

                        <button
                            type="button"
                            className="sb-action-card"
                            onClick={() => handleCreateType('kanban-board')}
                        >
                            <div className="sb-action-card-icon-wrap" style={{ color: 'var(--sb-system-emerald, #10b981)', background: 'var(--sb-system-emerald-subtle, rgba(16, 185, 129, 0.12))' }}>
                                <IconKanban size={18} strokeWidth={1.8} />
                            </div>
                            <div className="sb-action-card-text">
                                <span className="sb-action-card-title">Kanban Board (Sprint)</span>
                                <span className="sb-action-card-desc">Multi-stage roadmap delivery</span>
                            </div>
                        </button>
                    </div>

                    {/* Scrollable Content Area */}
                    <div className="sb-projects-scroll-area">
                        {/* Section 1: Active & Saved Canvas Automations */}
                        {filteredAutomations.length > 0 && (
                            <div className="sb-projects-section mb-6">
                                <div className="sb-section-heading-row">
                                    <h3 className="sb-section-heading">Saved &amp; Active Canvases in Workspace</h3>
                                    <span className="sb-section-counter">{filteredAutomations.length} canvases</span>
                                </div>

                                <div className="sb-workspaces-grid">
                                    {filteredAutomations.map(art => (
                                        <div
                                            key={art.id}
                                            className="sb-workspace-card"
                                            onClick={() => {
                                                onClose();
                                                onOpenCanvasArtifact(art);
                                            }}
                                        >
                                            <div className="sb-workspace-card-top">
                                                <div className="sb-workspace-icon-box">
                                                    {getPrimitiveSvgIcon(art.type, 17)}
                                                </div>
                                                <div className="sb-workspace-name-wrap">
                                                    <div className="sb-workspace-title-row">
                                                        <span className="sb-workspace-title">{art.title}</span>
                                                        <span className="sb-active-pill">v{art.version || 1}</span>
                                                    </div>
                                                    <span className="sb-workspace-path">{art.summary || 'Canvas Artifact'}</span>
                                                </div>
                                            </div>

                                            <div className="sb-workspace-card-bottom">
                                                <div className="sb-workspace-tags-list">
                                                    <span className="sb-workspace-tag">{art.type}</span>
                                                    <span className="sb-workspace-tag">Canvas</span>
                                                </div>
                                                <button
                                                    type="button"
                                                    className="sb-workspace-open-btn"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onClose();
                                                        onOpenCanvasArtifact(art);
                                                    }}
                                                >
                                                    <span>Open on Canvas</span>
                                                    <IconArrowRight size={11} />
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Section: Superpower & MCP Integrations */}
                        <div className="sb-projects-section mb-6">
                            <div className="sb-section-heading-row">
                                <h3 className="sb-section-heading">Connected Superpowers &amp; MCP Tool Bridges</h3>
                                <span className="sb-section-counter">Google Drive Active</span>
                            </div>

                            <div className="sb-cursor-group-card p-4 bg-zinc-900/90 border border-zinc-800 rounded-2xl shadow-lg space-y-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                                            <IconGoogleDriveColor size={22} />
                                        </div>
                                        <div>
                                            <div className="flex items-center gap-2">
                                                <h4 className="text-xs font-semibold text-zinc-100">
                                                    Google Drive &amp; Docs Integration
                                                </h4>
                                                <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${gdriveState.status === 'connected' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-zinc-800 text-zinc-400 border border-zinc-700'}`}>
                                                    {gdriveState.status === 'connected' ? `Connected as ${gdriveState.accountEmail}` : 'Disconnected'}
                                                </span>
                                            </div>
                                            <p className="text-[11px] text-zinc-400 mt-0.5">
                                                Export document specifications, sync architecture markdown files, and search Drive content.
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex items-center gap-2">
                                        {gdriveState.status === 'connected' ? (
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-danger sb-btn-xs"
                                                onClick={async () => {
                                                    await GoogleDriveService.getInstance().disconnect();
                                                    setDriveFeedback('Disconnected Google Drive');
                                                    setTimeout(() => setDriveFeedback(null), 3000);
                                                }}
                                            >
                                                <span>Disconnect</span>
                                            </button>
                                        ) : (
                                            <button
                                                type="button"
                                                className="sb-btn sb-btn-primary sb-btn-xs bg-blue-600 hover:bg-blue-500 text-white flex items-center gap-1"
                                                disabled={isConnectingDrive}
                                                onClick={async () => {
                                                    setIsConnectingDrive(true);
                                                    try {
                                                        await GoogleDriveService.getInstance().connect();
                                                        setDriveFeedback('✓ Connected to Google Drive');
                                                        setTimeout(() => setDriveFeedback(null), 3000);
                                                    } finally {
                                                        setIsConnectingDrive(false);
                                                    }
                                                }}
                                            >
                                                <IconSparkles size={11} />
                                                <span>{isConnectingDrive ? 'Connecting...' : 'Connect Google Drive'}</span>
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {driveFeedback && (
                                    <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400 text-xs font-medium flex items-center gap-1.5 animate-fadeIn">
                                        <IconCheck size={12} />
                                        <span>{driveFeedback}</span>
                                    </div>
                                )}

                                {/* Available Tools Chips */}
                                <div className="pt-2 border-t border-zinc-800/80 flex items-center justify-between">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-[11px] text-zinc-400 font-medium">Available Tools:</span>
                                        {['create_document', 'upload_file', 'list_drive_files', 'search_drive'].map(tool => (
                                            <span key={tool} className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-950 text-blue-400 border border-zinc-800">
                                                {tool}
                                            </span>
                                        ))}
                                    </div>

                                    <button
                                        type="button"
                                        className="sb-btn sb-btn-secondary sb-btn-xs flex items-center gap-1 text-[11px]"
                                        onClick={() => {
                                            const gdriveTemplate = AUTOMATION_CANVAS_TEMPLATES.find(t => t.id === 'tmpl-gdrive-sync');
                                            if (gdriveTemplate) {
                                                handleOpenTemplate(gdriveTemplate);
                                            }
                                        }}
                                    >
                                        <IconGoogleDocs size={12} />
                                        <span>Launch Auto-Sync Pipeline</span>
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Section 2: Curated Automation Templates */}
                        <div className="sb-projects-section">
                            <div className="sb-section-heading-row">
                                <h3 className="sb-section-heading">Curated Automation &amp; Canvas Templates</h3>
                                <span className="sb-section-counter">{filteredTemplates.length} presets</span>
                            </div>

                            <div className="sb-templates-grid">
                                {filteredTemplates.map(tmpl => (
                                    <div
                                        key={tmpl.id}
                                        className="sb-template-card"
                                        onClick={() => handleOpenTemplate(tmpl)}
                                    >
                                        <div className="sb-template-card-header">
                                            <span className="sb-template-tag">{tmpl.tag}</span>
                                            <button
                                                type="button"
                                                className="sb-template-use-btn"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleOpenTemplate(tmpl);
                                                }}
                                            >
                                                <span>Launch Canvas</span>
                                                <IconArrowRight size={11} />
                                            </button>
                                        </div>

                                        <h4 className="sb-template-title">{tmpl.title}</h4>
                                        <p className="sb-template-desc">{tmpl.subtitle}</p>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Empty State when no items match search or category */}
                        {filteredAutomations.length === 0 && filteredTemplates.length === 0 && (
                            <div className="sb-projects-empty-state animate-fadeIn">
                                <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center text-zinc-400">
                                    <IconSearch size={20} />
                                </div>
                                <div className="space-y-1 text-center">
                                    <h4 className="text-sm font-semibold text-zinc-200">No matching automations or templates</h4>
                                    <p className="text-xs text-zinc-400">
                                        {searchQuery ? `No workflows matching "${searchQuery}" in ${selectedCategory === 'all' ? 'any category' : selectedCategory}.` : `No workflows in category "${selectedCategory}".`}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    className="sb-btn sb-btn-secondary sb-btn-sm mt-1"
                                    onClick={() => {
                                        setSearchQuery('');
                                        setSelectedCategory('all');
                                    }}
                                >
                                    Clear search and filters
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
