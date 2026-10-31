/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * useLayoutModeSwitch
 *
 * Switching the dedicated workspace layout mode (chat / code / document / kanban / canvas) and creating empty canvases of a given primitive type.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { CanvasArtifact, InteractiveBrowserData, KanbanBoardData, LiveCodeSandboxData, MarkdownDocumentData, MetricDashboardData, NodeGraphData, PrimitiveType, StudioLayoutMode, VideoTimelineData, getActiveUserName } from '../canvas-types';
import { resolveModeForArtifact } from '../guardrails-service';
import { useCapabilities } from '../hooks/useCapabilities';
import { newEmptySceneArtifact } from './useWorkspaceFiles';
import { canShowLayoutMode, primitiveOutOfScopeReason } from '../../../common/product-scope';
import { postScopeNote } from '../chat/scopeNote';
import { ChatState, ChatStore } from '../state/chatStore';

export interface UseLayoutModeSwitchDeps {
    activeArtifact: ChatState['activeArtifact'];
    artifactHistory: ChatState['artifactHistory'];
    recordArtifactVersion: (art: CanvasArtifact) => void;
    setActiveArtifact: ChatStore['setActiveArtifact'];
    setArtifactHistory: ChatStore['setArtifactHistory'];
    setDocumentPaneState: React.Dispatch<React.SetStateAction<'split' | 'collapsed' | 'expanded'>>;
    setLayoutMode: ChatStore['setLayoutMode'];
    setMessages: ChatStore['setMessages'];
    showToast: (text: string, icon?: string) => void;
    skills: ReturnType<typeof useCapabilities>['skills'];
}

export function useLayoutModeSwitch(deps: UseLayoutModeSwitchDeps) {
    const { activeArtifact, artifactHistory, recordArtifactVersion, setActiveArtifact, setArtifactHistory, setDocumentPaneState, setLayoutMode, showToast, skills } = deps;

    // Switch dedicated workspace layout mode (Chat, Code/Sandbox, Document/Spec, Kanban)
    const handleSwitchMode = (targetMode: StudioLayoutMode) => {
        const requestedMode = targetMode === 'canvas' ? 'code' : targetMode;
        // The 3D/VFX build (common/product-scope.ts) shows a mode it does not offer as chat, and makes nothing for it;
        // the session's saved canvases are left as they are.
        const effectiveMode = canShowLayoutMode(requestedMode) ? requestedMode : 'chat';
        setLayoutMode(effectiveMode);
        if (effectiveMode !== 'chat') {
            setDocumentPaneState(prev => prev === 'collapsed' ? 'split' : prev);
        }
        if (effectiveMode === 'chat') {
            return;
        }

        const typeMap: Record<string, PrimitiveType[]> = {
            code: ['live-code-sandbox'],
            canvas: ['node-graph', 'live-code-sandbox', 'metric-dashboard', 'mind-map', 'skills-hub', 'mcp-hub'],
            document: ['markdown-document', 'checklist', 'interactive-form'],
            kanban: ['kanban-board'],
            automation: ['node-graph'],
            '3d': ['3d-scene'],
            browser: ['interactive-browser', 'browser'],
            video: ['video-timeline']
        };

        const targetTypes = typeMap[effectiveMode] || [];

        // If activeArtifact matches the target mode, keep it
        if (activeArtifact && targetTypes.includes(activeArtifact.type)) {
            return;
        }

        // Check if there is an artifact in history matching this mode
        const matchingFromHistory = artifactHistory.find(a => targetTypes.includes(a.type));
        if (matchingFromHistory) {
            setActiveArtifact(matchingFromHistory);
            return;
        }

        // Contextual defaults for immediate visualization
        if (effectiveMode === 'code') {
            const defaultSandbox: CanvasArtifact = {
                id: `art-sandbox-${Date.now()}`,
                type: 'live-code-sandbox',
                title: 'Interactive React 19 UI Playground',
                summary: 'Live editable multi-tab code runner with hot reload, CDN packages & runtime console.',
                version: 1,
                createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                data: {
                    title: 'Interactive React 19 UI Playground',
                    subtitle: 'Multi-tab live code runner with hot reload & runtime console',
                    template: 'react',
                    files: [
                        {
                            id: 'file-app',
                            name: 'App.tsx',
                            language: 'react',
                            content: `import React, { useState } from 'react';\nimport { Sparkles, Play, CheckCircle2 } from 'lucide-react';\nimport confetti from 'canvas-confetti';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n\n  const handleCelebrate = () => {\n    setCount(prev => prev + 1);\n    confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });\n    console.log('Celebration action triggered! Count:', count + 1);\n  };\n\n  return (\n    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100 selection:bg-blue-500 selection:text-white">\n      <div className="w-full max-w-md p-8 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/80 rounded-3xl shadow-2xl space-y-6 text-center">\n        <div className="inline-flex p-3 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-inner">\n          <Sparkles className="w-8 h-8 animate-pulse" />\n        </div>\n        <div className="space-y-2">\n          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-zinc-100 via-zinc-200 to-zinc-400 bg-clip-text text-transparent">Scratchbox Live UI Sandbox</h1>\n          <p className="text-sm text-zinc-400">Interactive React 19 + Tailwind CSS playground with hot reload and live console streams.</p>\n        </div>\n        <div className="p-4 bg-zinc-950/60 rounded-2xl border border-zinc-800/50 flex items-center justify-around">\n          <div><div className="text-xs text-zinc-500 font-medium">Interactions</div><div className="text-3xl font-extrabold text-blue-400">{count}</div></div>\n          <div className="h-8 w-px bg-zinc-800"></div>\n          <div><div className="text-xs text-zinc-500 font-medium">Status</div><div className="text-sm font-semibold text-emerald-400 flex items-center gap-1 mt-1"><CheckCircle2 className="w-4 h-4" /> Live</div></div>\n        </div>\n        <button onClick={handleCelebrate} className="sb-btn sb-btn-primary w-full py-3.5 px-6 rounded-xl font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/25 active:scale-[0.98] transition-all flex items-center justify-center gap-2 group">\n          <Play className="w-4 h-4 fill-current transition-transform group-hover:translate-x-0.5" />\n          <span>Trigger Interactive Action</span>\n        </button>\n      </div>\n    </div>\n  );\n}`,
                            isEntry: true
                        },
                        {
                            id: 'file-css',
                            name: 'styles.css',
                            language: 'css',
                            content: `/* Custom Sandbox Styles */\nbody {\n  margin: 0;\n  padding: 0;\n}`
                        }
                    ],
                    dependencies: {
                        'lucide-react': '^0.468.0',
                        'canvas-confetti': '^1.9.3'
                    },
                    viewportMode: 'desktop'
                } as LiveCodeSandboxData
            };
            setActiveArtifact(defaultSandbox);
            setArtifactHistory(prev => [defaultSandbox, ...prev.filter(a => a.id !== defaultSandbox.id)]);
        } else if (targetMode === 'document') {
            const defaultDoc: CanvasArtifact = {
                id: `art-doc-${Date.now()}`,
                type: 'markdown-document',
                title: 'Project Specification & Notes',
                summary: 'Rich document specification with blocks and callouts.',
                version: 1,
                createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                data: {
                    title: 'Project Specification & Notes',
                    subtitle: 'Rich block document for architecture, roadmap, and specs',
                    author: getActiveUserName(),
                    lastUpdated: 'Just now',
                    tags: ['Specification', 'Architecture', 'DocumentSpec', 'Reasoning'],
                    sections: [
                        { id: 'sec-1', type: 'heading', level: 1, content: '1. Overview & Vision' },
                        { id: 'sec-2', type: 'paragraph', content: 'Scratchbox IDE empowers developers with an AI-native workspace featuring N8N workflow canvases, rich document specs, and Kanban sprint boards.' },
                        { id: 'sec-3', type: 'callout', calloutType: 'info', calloutTitle: 'Key Architecture Insight', content: 'Subagents running on Gemini Flash Lite handle ultra-fast data preprocessing while Gemini 3.8 Flash powers high-reasoning synthesis.' },
                        { id: 'sec-4', type: 'heading', level: 2, content: '2. Next Action Items' },
                        { id: 'sec-5', type: 'checklist', checklistItems: [
                            { id: 'c1', text: 'Verify N8N canvas node routing & simulation', done: true },
                            { id: 'c2', text: 'Structure rich document blocks & callouts', done: true },
                            { id: 'c3', text: 'Verify Kanban sprint columns and drag & drop', done: false }
                        ]}
                    ]
                }
            };
            setActiveArtifact(defaultDoc);
            setArtifactHistory(prev => [defaultDoc, ...prev.filter(a => a.id !== defaultDoc.id)]);
        } else if (targetMode === 'kanban') {
            const defaultKanban: CanvasArtifact = {
                id: `art-kanban-${Date.now()}`,
                type: 'kanban-board',
                title: 'Sprint Roadmap Kanban Board',
                summary: 'Sprint delivery board with Backlog, In Progress, QA Review, and Done.',
                version: 1,
                createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                data: {
                    title: 'Sprint Roadmap Kanban Board',
                    subtitle: 'Multi-stage delivery board with real-time card synchronization',
                    columns: [
                        {
                            id: 'col-backlog',
                            title: 'Backlog',
                            color: 'indigo',
                            cards: [
                                { id: 'card-1', title: 'Stripe Webhook Listeners', description: 'Automated subscription reconciliation pipe', tag: 'Backend', tagColor: 'indigo', priority: 'medium', completedSubtasks: 2, totalSubtasks: 4 },
                                { id: 'card-2', title: 'Multi-tenant Org Switcher', description: 'Team workspace tenancy isolation', tag: 'Core', tagColor: 'purple', priority: 'low' }
                            ]
                        },
                        {
                            id: 'col-inprogress',
                            title: 'In Progress',
                            color: 'blue',
                            cards: [
                                { id: 'card-3', title: 'N8N Canvas & Rich Spec Surfaces', description: 'Apple HIG vibrancy and continuous corner curves', tag: 'Design', tagColor: 'blue', priority: 'urgent', completedSubtasks: 3, totalSubtasks: 3 }
                            ]
                        },
                        {
                            id: 'col-qa',
                            title: 'QA Review',
                            color: 'amber',
                            cards: [
                                { id: 'card-4', title: 'Subagent Fallback Matrix', description: 'Verify seamless routing across Gemini models', tag: 'AI', tagColor: 'amber', priority: 'high', completedSubtasks: 2, totalSubtasks: 2 }
                            ]
                        },
                        {
                            id: 'col-done',
                            title: 'Done',
                            color: 'emerald',
                            cards: [
                                { id: 'card-5', title: 'AI Studio Backend Engine', description: 'Native REST pipe with high-reasoning tokens budget', tag: 'AI Core', tagColor: 'emerald', priority: 'high' }
                            ]
                        }
                    ]
                }
            };
            setActiveArtifact(defaultKanban);
            setArtifactHistory(prev => [defaultKanban, ...prev.filter(a => a.id !== defaultKanban.id)]);
        } else if (targetMode === 'browser') {
            const defaultBrowser: CanvasArtifact = {
                id: `art-browser-${Date.now()}`,
                type: 'interactive-browser',
                title: 'Interactive Web Browser',
                summary: 'AI-controllable web browser with responsive device frames, live console logs, and dev inspection tools.',
                version: 1,
                createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                data: {
                    url: 'https://example.com',
                    title: 'Example Domain',
                    viewportMode: 'desktop',
                    history: ['https://example.com'],
                    historyIndex: 0,
                    isLoading: false,
                    consoleLogs: [],
                    inspectMode: false,
                    deviceScale: 1
                } as InteractiveBrowserData
            };
            setActiveArtifact(defaultBrowser);
            setArtifactHistory(prev => [defaultBrowser, ...prev.filter(a => a.id !== defaultBrowser.id)]);
        } else if (effectiveMode === 'video') {
            const defaultVideo: CanvasArtifact = {
                id: `art-video-${Date.now()}`,
                type: 'video-timeline',
                title: 'Cyberpunk 2088 Motion Teaser',
                summary: 'Multi-track non-linear video editing timeline with real-time WebGL compositor, color wheels & scopes.',
                version: 1,
                createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                data: {
                    title: 'Cyberpunk 2088 Motion Teaser',
                    subtitle: 'Multi-Track NLE Timeline with WebGL Compositor & Scopes',
                    fps: 30,
                    aspectRatio: '16:9',
                    duration: 15.0,
                    currentTime: 2.5,
                    zoom: 50,
                    tracks: [
                        {
                            id: 'v2-overlay',
                            name: 'V2 Title Graphics',
                            type: 'overlay',
                            visible: true,
                            muted: false,
                            locked: false,
                            elements: [
                                {
                                    id: 'clip-v2-1',
                                    name: 'SCRATCHBOX NLE HUD',
                                    trackId: 'v2-overlay',
                                    type: 'text',
                                    startTime: 1.0,
                                    duration: 4.5,
                                    trimStart: 0,
                                    trimEnd: 4.5,
                                    opacity: 0.95,
                                    textContent: 'SYSTEM: COMPOSITING MATRIX ONLINE',
                                    textColor: '#38bdf8'
                                }
                            ]
                        },
                        {
                            id: 'v1-video',
                            name: 'V1 Video Footage',
                            type: 'video',
                            visible: true,
                            muted: false,
                            locked: false,
                            elements: [
                                {
                                    id: 'clip-v1-1',
                                    name: 'City Skyline Drone Shot',
                                    trackId: 'v1-video',
                                    type: 'video',
                                    startTime: 0,
                                    duration: 5.0,
                                    trimStart: 0,
                                    trimEnd: 5.0,
                                    opacity: 1.0,
                                    grade: {
                                        exposure: 0,
                                        contrast: 0,
                                        saturation: 100
                                    }
                                },
                                {
                                    id: 'clip-v1-2',
                                    name: '3D Hologram Mech Scene',
                                    trackId: 'v1-video',
                                    type: '3d',
                                    startTime: 5.0,
                                    duration: 6.5,
                                    trimStart: 0,
                                    trimEnd: 6.5,
                                    opacity: 1.0,
                                    grade: {
                                        exposure: 0,
                                        contrast: 0,
                                        saturation: 100
                                    }
                                }
                            ]
                        },
                        {
                            id: 'a1-music',
                            name: 'A1 Synthwave Soundtrack',
                            type: 'audio',
                            visible: true,
                            muted: false,
                            locked: false,
                            volume: 0.9,
                            elements: [
                                {
                                    id: 'clip-a1-1',
                                    name: 'Synthwave Night City Theme.wav',
                                    trackId: 'a1-music',
                                    type: 'audio',
                                    startTime: 0,
                                    duration: 15.0,
                                    trimStart: 0,
                                    trimEnd: 15.0,
                                    volume: 0.9
                                }
                            ]
                        }
                    ],
                    mediaAssets: [
                        { id: 'med-1', name: 'City Skyline Drone Shot.mp4', type: 'video', duration: 12.0, width: 3840, height: 2160, fps: 30 },
                        { id: 'med-2', name: '3D Hologram Mech Scene.glb', type: '3d', duration: 10.0 },
                        { id: 'med-3', name: 'Synthwave Night City Theme.wav', type: 'audio', duration: 30.0 }
                    ],
                    globalGrade: {
                        exposure: 0,
                        contrast: 0,
                        saturation: 100,
                        colorTemp: 6500,
                        colorTint: 0
                    }
                } as VideoTimelineData
            };
            setActiveArtifact(defaultVideo);
            setArtifactHistory(prev => [defaultVideo, ...prev.filter(a => a.id !== defaultVideo.id)]);
        }
    };

    return { handleSwitchMode };
}

/** Creates an empty canvas artifact of the given primitive type and activates it. */
export function useCreateEmptyCanvas(deps: UseLayoutModeSwitchDeps) {
    const { recordArtifactVersion, setActiveArtifact, setArtifactHistory, setLayoutMode, setMessages, showToast } = deps;

    const handleCreateEmptyCanvas = (type: PrimitiveType, customTitle?: string) => {
        const outOfScope = primitiveOutOfScopeReason(type);
        if (outOfScope) {
            postScopeNote(setMessages, outOfScope);
            return;
        }
        let newArtifact: CanvasArtifact;
        const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        if (type === 'node-graph') {
            newArtifact = {
                id: `art-node-graph-${Date.now()}`,
                type: 'node-graph',
                title: customTitle || 'New Canvas Workflow',
                summary: 'Visual node graph & canvas workflow',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'New Canvas Workflow',
                    subtitle: 'Drag and connect nodes to create automated execution pipelines',
                    nodes: [
                        { id: 'node-1', label: 'Webhook Trigger', subtitle: 'POST /api/v1/event', category: 'input', color: 'blue', x: 100, y: 160, status: 'completed' },
                        { id: 'node-2', label: 'Reasoning Engine', subtitle: 'Gemini 3.8 Flash', category: 'ai', color: 'purple', x: 440, y: 160, status: 'running' }
                    ],
                    edges: [
                        { id: 'e1', source: 'node-1', target: 'node-2', label: 'Payload', style: 'solid', color: 'purple' }
                    ]
                } as NodeGraphData
            };
        } else if (type === 'live-code-sandbox') {
            newArtifact = {
                id: `art-sandbox-${Date.now()}`,
                type: 'live-code-sandbox',
                title: customTitle || 'New Live Code Sandbox',
                summary: 'Live editable code runner & interactive preview',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'New Live Code Sandbox',
                    subtitle: 'Interactive hot-reloading playground',
                    template: 'react',
                    viewMode: 'preview',
                    viewportMode: 'desktop',
                    files: [
                        { id: 'f1', name: 'App.tsx', language: 'react', content: `import React from 'react';\n\nexport default function App() {\n  return (\n    <div className="flex items-center justify-center min-h-screen bg-zinc-950 text-white p-6">\n      <h1 className="text-2xl font-bold">Hello from Canvas Sandbox</h1>\n    </div>\n  );\n}`, isEntry: true }
                    ]
                } as LiveCodeSandboxData
            };
        } else if (type === 'markdown-document') {
            newArtifact = {
                id: `art-doc-${Date.now()}`,
                type: 'markdown-document',
                title: customTitle || 'New Document Specification',
                summary: 'Structured block spec document with tables and callouts',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'New Document Specification',
                    subtitle: 'Rich blocks and architecture specifications',
                    sections: [
                        { id: 'sec-1', type: 'heading', level: 1, content: '1. Executive Specification' },
                        { id: 'sec-2', type: 'paragraph', content: 'Draft your project requirements, architecture specifications, and API designs here.' }
                    ]
                } as MarkdownDocumentData
            };
        } else if (type === 'kanban-board') {
            newArtifact = {
                id: `art-kanban-${Date.now()}`,
                type: 'kanban-board',
                title: customTitle || 'New Sprint Kanban Board',
                summary: 'Multi-stage delivery workflow board',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'Sprint Roadmap',
                    columns: [
                        { id: 'col-backlog', title: 'Backlog', color: 'indigo', cards: [] },
                        { id: 'col-inprogress', title: 'In Progress', color: 'blue', cards: [] },
                        { id: 'col-done', title: 'Done', color: 'emerald', cards: [] }
                    ]
                } as KanbanBoardData
            };
        } else if (type === 'interactive-browser' || type === 'browser') {
            newArtifact = {
                id: `art-browser-${Date.now()}`,
                type: 'interactive-browser',
                title: customTitle || 'New Web Browser',
                summary: 'Interactive AI-controllable web browser primitive',
                version: 1,
                createdAt: timestamp,
                data: {
                    url: 'https://example.com',
                    title: customTitle || 'Example Domain',
                    viewportMode: 'desktop',
                    history: ['https://example.com'],
                    historyIndex: 0,
                    isLoading: false,
                    consoleLogs: [],
                    inspectMode: false,
                    deviceScale: 1
                } as InteractiveBrowserData
            };
        } else if (type === 'video-timeline') {
            newArtifact = {
                id: `art-video-${Date.now()}`,
                type: 'video-timeline',
                title: customTitle || 'New Video Project',
                summary: 'Multi-track non-linear video editing timeline with real-time WebGL compositor',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'New Video Project',
                    subtitle: 'Multi-Track NLE Timeline',
                    fps: 30,
                    aspectRatio: '16:9',
                    duration: 10.0,
                    currentTime: 0.0,
                    zoom: 50,
                    tracks: [
                        { id: 'v1', name: 'Video 1', type: 'video', muted: false, locked: false, visible: true, volume: 1.0, elements: [] },
                        { id: 'a1', name: 'Audio 1', type: 'audio', muted: false, locked: false, visible: true, volume: 1.0, elements: [] }
                    ],
                    mediaAssets: []
                } as VideoTimelineData
            };
        } else if (type === '3d-scene') {
            newArtifact = newEmptySceneArtifact(Date.now(), customTitle || 'New 3D Scene');
        } else if (type === 'metric-dashboard') {
            newArtifact = {
                id: `art-metric-${Date.now()}`,
                type: 'metric-dashboard',
                title: customTitle || 'System Performance & Telemetry',
                summary: 'Real-time telemetry and metric cards',
                version: 1,
                createdAt: timestamp,
                data: {
                    title: customTitle || 'System Performance & Telemetry',
                    subtitle: 'Real-time telemetry and KPI metrics',
                    metrics: [
                        { id: 'm1', label: 'Throughput', value: '1,240 req/s', change: '+12%', trend: 'up', color: 'blue', sparkline: [100, 110, 105, 120, 118, 125, 130] },
                        { id: 'm2', label: 'Avg Latency', value: '42ms', change: '-8%', trend: 'down', color: 'emerald', sparkline: [50, 48, 45, 46, 44, 43, 42] },
                        { id: 'm3', label: 'Error Rate', value: '0.02%', change: '-0.01%', trend: 'down', color: 'purple', sparkline: [0.05, 0.04, 0.03, 0.03, 0.02, 0.02, 0.02] },
                        { id: 'm4', label: 'Active Nodes', value: '18 / 20', change: 'Stable', trend: 'neutral', color: 'indigo', sparkline: [16, 16, 17, 18, 18, 18, 18] }
                    ],
                    chart: {
                        title: 'Hourly API Throughput (req/s)',
                        data: [
                            { label: '00:00', value: 320 },
                            { label: '04:00', value: 280 },
                            { label: '08:00', value: 890 },
                            { label: '12:00', value: 1240 },
                            { label: '16:00', value: 1180 },
                            { label: '20:00', value: 950 }
                        ]
                    }
                } as MetricDashboardData
            };
        } else {
            // a type with no empty canvas says so, instead of opening some other primitive in its place
            showToast(`No empty ${type} canvas can be created here`, '⚠️');
            return;
        }

        setActiveArtifact(newArtifact);
        recordArtifactVersion(newArtifact);
        setArtifactHistory(prev => [newArtifact, ...prev.filter(a => a.id !== newArtifact.id)]);
        const resolvedSurface = resolveModeForArtifact(newArtifact.type);
        setLayoutMode(resolvedSurface);
        showToast(`Created new canvas "${newArtifact.title}"`);
    };

    return { handleCreateEmptyCanvas };
}
