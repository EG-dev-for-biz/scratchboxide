/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { BentoStageLayout } from '../BentoStageLayout';
import { CanvasArtifact, InteractiveBrowserData, KanbanBoardData, LiveCodeSandboxData, MarkdownDocumentData, NodeGraphData, Scene3DData, getActiveUserName } from '../canvas-types';
import { CanvasErrorBoundary } from '../CanvasErrorBoundary';
import { InteractiveBrowserPrimitive } from '../primitives/InteractiveBrowserPrimitive';
import { KanbanBoardPrimitive } from '../primitives/KanbanBoardPrimitive';
import { LiveCodeSandboxPrimitive } from '../primitives/LiveCodeSandboxPrimitive';
import { MarkdownDocumentPrimitive } from '../primitives/MarkdownDocumentPrimitive';
import { NodeGraphPrimitive } from '../primitives/NodeGraphPrimitive';
import { Scene3DPrimitive } from '../primitives/Scene3DPrimitive';
import { morphArtifact } from '../primitive-transformer-engine';
import { generateMotivatedEditorialImageSection, synthesizeComprehensiveDocument } from '../document-synthesis-engine';
import { ArtifactStageProps } from './artifact-stage-props';

/** Document and live-code sandbox surfaces. */
export const DocumentCodeSurfaces: React.FC<ArtifactStageProps> = props => {
    const { activeArtifact, setActiveArtifact, setArtifactHistory, activeWorkspace, layoutMode, docReadOnly, isGenerating, activeStreamingSectionId, handleUpdateArtifact, handleMorphArtifact, handleOpenInAppBrowser, handleSurfaceAiPrompt, handleSendMessage, syncSandboxSaveToMarkdown } = props;
    return (
        <>
        {layoutMode === 'document' && (
            <CanvasErrorBoundary fallbackTitle="Document Canvas">
                <MarkdownDocumentPrimitive
                    activeArtifact={activeArtifact}
                    activeArtifactTitle={activeArtifact?.title}
                    workspacePath={activeWorkspace.path}
                    isStreaming={isGenerating}
                    streamingSectionId={activeStreamingSectionId}
                    streamingBadgeText="✨ Synthesizing Document in Real-time..."
                    data={(() => {
                        if (activeArtifact?.type === 'markdown-document') {
                            const doc = activeArtifact.data as MarkdownDocumentData;
                            const effectiveTitle = doc?.title && doc.title !== 'Markdown Document' ? doc.title : activeArtifact.title || 'Project Specification & Notes';
                            const sections = Array.isArray(doc?.sections) && doc.sections.length > 0
                                ? doc.sections
                                : synthesizeComprehensiveDocument(effectiveTitle, effectiveTitle).sections;
                            return {
                                ...doc,
                                title: effectiveTitle,
                                sections
                            };
                        }
                        return {
                            title: 'Project Specification & Notes',
                            subtitle: 'Rich block document for architecture, roadmap, and specs',
                            author: getActiveUserName(),
                            lastUpdated: 'Just now',
                            tags: ['Specification', 'Architecture', 'DocumentSpec', 'Reasoning'],
                            sections: [
                                { id: 'sec-1', type: 'heading', level: 1, content: '1. Overview & Vision' },
                                { id: 'sec-2', type: 'paragraph', content: 'Scratchbox IDE empowers developers with an AI-native workspace featuring N8N workflow canvases, rich document specs, and Kanban sprint boards.' },
                                generateMotivatedEditorialImageSection('1776-revolution'),
                                { id: 'sec-3', type: 'callout', calloutType: 'info', calloutTitle: 'Key Architecture Insight', content: 'Subagents running on Gemini Flash Lite handle ultra-fast data preprocessing while Gemini 3.7 Flash powers high-reasoning synthesis.' },
                                { id: 'sec-4', type: 'heading', level: 2, content: '2. Next Action Items' },
                                { id: 'sec-5', type: 'checklist', checklistItems: [
                                    { id: 'c1', text: 'Verify N8N canvas node routing & simulation', done: true },
                                    { id: 'c2', text: 'Validate Nano Banana editorial image generation & art styles', done: true },
                                    { id: 'c3', text: 'Confirm elimination of fake player controls & scrubber artifacts', done: true }
                                ]}
                            ]
                        };
                    })()}
                    onUpdate={(updatedData: MarkdownDocumentData) => {
                        const nextTitle = updatedData.title && updatedData.title !== 'Markdown Document' ? updatedData.title : (activeArtifact?.title || 'Project Specification & Notes');
                        const updatedArtifact: CanvasArtifact = {
                            id: activeArtifact?.id || `art-doc-${Date.now()}`,
                            type: 'markdown-document',
                            version: (activeArtifact?.version || 1),
                            summary: updatedData.subtitle || 'Specification Document',
                            createdAt: activeArtifact?.createdAt || new Date().toLocaleTimeString(),
                            title: nextTitle,
                            data: {
                                ...updatedData,
                                title: nextTitle
                            }
                        };
                        handleUpdateArtifact(updatedArtifact);
                    }}
                    onMorphArtifact={handleMorphArtifact}
                    onMorphToKanban={(kanbanData: KanbanBoardData) => {
                        handleMorphArtifact({
                            id: `art-kanban-${Date.now()}`,
                            title: kanbanData.title,
                            summary: kanbanData.subtitle || 'Morphed Kanban Board',
                            type: 'kanban-board',
                            data: kanbanData,
                            createdAt: new Date().toLocaleTimeString(),
                            version: 1
                        });
                    }}
                    onMorphToNodeGraph={(graphData: NodeGraphData) => {
                        handleMorphArtifact({
                            id: `art-graph-${Date.now()}`,
                            title: graphData.title,
                            summary: graphData.subtitle || 'Morphed Node Graph Flow',
                            type: 'node-graph',
                            data: graphData,
                            createdAt: new Date().toLocaleTimeString(),
                            version: 1
                        });
                    }}
                    onPromptAction={(promptText: string) => handleSurfaceAiPrompt(promptText)}
                    onOpenInBrowser={handleOpenInAppBrowser}
                    readOnly={docReadOnly}
                />
            </CanvasErrorBoundary>
        )}
        {layoutMode === 'code' && (
            <CanvasErrorBoundary fallbackTitle="Live Code Sandbox">
                <LiveCodeSandboxPrimitive
                    data={(activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData) : undefined) || {
                        title: 'Interactive React 19 UI Playground',
                        subtitle: 'Multi-tab live code runner with hot reload & runtime console',
                        template: 'react',
                        viewMode: 'preview',
                        files: [
                            {
                                id: 'file-gen-webpack',
                                name: 'gen-webpack.config.js',
                                path: 'applications/electron/gen-webpack.config.js',
                                language: 'javascript',
                                content: `/**\n * Don't touch this file. It will be regenerated by theia build.\n * To customize webpack configuration change /Users/eligreen/dev/scratchbox-ide-master/applications/electron/webpack.config.js\n */\n// @ts-check\nconst path = require('path');\nconst webpack = require('webpack');\nconst yargs = require('yargs');\nconst CopyWebpackPlugin = require('copy-webpack-plugin');\nconst CompressionPlugin = require('compression-webpack-plugin');\nconst MiniCssExtractPlugin = require('mini-css-extract-plugin');\nconst { MonacoWebpackPlugin } = require('@theia/native-webpack-plugin/lib/monaco-webpack-plugins.js');\n\nconst outputPath = path.resolve(__dirname, 'lib', 'frontend');\nconst { mode, staticCompression } = yargs.option('mode', {\n    description: 'Mode to use',\n    choices: ['development', 'production'],\n    default: 'production'\n}).option('static-compression', {\n    description: 'Controls whether to enable compression of static artifacts.',\n    type: 'boolean',\n    default: true\n}).argv;\n\nconst development = mode === 'development';\n\nconst plugins = [\n    new CopyWebpackPlugin({\n        patterns: [\n            {\n                from: path.resolve(__dirname, 'src-gen/frontend/secondary-window.html')\n            },\n            {\n                from: path.join(require.resolve('@theia/plugin-ext'), '..', 'src', 'main', 'browser', 'webview', 'pre'),\n                to: path.resolve(__dirname, 'lib', 'webview', 'pre')\n            }\n        ]\n    }),\n    new webpack.ProvidePlugin({\n        Buffer: ['buffer', 'Buffer']\n    }),\n    new MonacoWebpackPlugin()\n];\n\nmodule.exports = {\n    mode,\n    devtool: development ? 'eval-cheap-module-source-map' : 'source-map',\n    entry: {\n        'secondary-window': path.resolve(__dirname, 'src-gen/frontend/secondary-index.js')\n    },\n    output: {\n        path: outputPath,\n        filename: '[name].js'\n    },\n    plugins\n};`
                            },
                            {
                                id: 'file-app',
                                name: 'App.tsx',
                                path: 'src/App.tsx',
                                language: 'react',
                                content: `import React, { useState } from 'react';\nimport { Sparkles, Play, CheckCircle2 } from 'lucide-react';\nimport confetti from 'canvas-confetti';\n\nexport default function App() {\n  const [count, setCount] = useState(0);\n\n  const handleCelebrate = () => {\n    setCount(prev => prev + 1);\n    confetti({ particleCount: 80, spread: 70, origin: { y: 0.6 } });\n    console.log('Celebration action triggered! Count:', count + 1);\n  };\n\n  return (\n    <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-zinc-950 text-zinc-100 selection:bg-blue-500 selection:text-white">\n      <div className="w-full max-w-md p-8 bg-zinc-900/80 backdrop-blur-xl border border-zinc-800/80 rounded-3xl shadow-2xl space-y-6 text-center">\n        <div className="inline-flex p-3 rounded-2xl bg-blue-500/10 text-blue-400 border border-blue-500/20 shadow-inner">\n          <Sparkles className="w-8 h-8 animate-pulse" />\n        </div>\n        <div className="space-y-2">\n          <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-zinc-100 via-zinc-200 to-zinc-400 bg-clip-text text-transparent">Scratchbox Live UI Sandbox</h1>\n          <p className="text-sm text-zinc-400">Interactive React 19 + Tailwind CSS playground with hot reload and live console streams.</p>\n        </div>\n        <div className="p-4 bg-zinc-950/60 rounded-2xl border border-zinc-800/50 flex items-center justify-around">\n          <div><div className="text-xs text-zinc-500 font-medium">Interactions</div><div className="text-3xl font-extrabold text-blue-400">{count}</div></div>\n          <div className="h-8 w-px bg-zinc-800"></div>\n          <div><div className="text-xs text-zinc-500 font-medium">Status</div><div className="text-sm font-semibold text-emerald-400 flex items-center gap-1 mt-1"><CheckCircle2 className="w-4 h-4" /> Live</div></div>\n        </div>\n        <button onClick={handleCelebrate} className="sb-btn sb-btn-primary w-full py-3.5 px-6 rounded-xl font-semibold bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white shadow-lg shadow-blue-500/25 active:scale-[0.98] transition-all flex items-center justify-center gap-2 group">\n          <Play className="w-4 h-4 fill-current transition-transform group-hover:translate-x-0.5" />\n          <span>Trigger Interactive Action</span>\n        </button>\n      </div>\n    </div>\n  );\n}`,
                                isEntry: true
                            },
                            {
                                id: 'file-css',
                                name: 'styles.css',
                                path: 'src/styles.css',
                                language: 'css',
                                content: `/* Custom Sandbox Styles */\nbody {\n  margin: 0;\n  padding: 0;\n}`
                            },
                            {
                                id: 'file-pkg',
                                name: 'package.json',
                                path: 'package.json',
                                language: 'json',
                                content: `{\n  "name": "scratchbox-ide-master",\n  "version": "1.67.100",\n  "private": true\n}`
                            }
                        ],
                        dependencies: {
                            'lucide-react': '^0.468.0',
                            'canvas-confetti': '^1.9.3'
                        },
                        viewportMode: 'desktop'
                    }}
                    onUpdate={updatedData => {
                        if (activeArtifact) {
                            handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                        }
                    }}
                    onSave={syncSandboxSaveToMarkdown}
                    onForkArtifact={forked => {
                        setActiveArtifact(forked);
                        setArtifactHistory(prev => [forked, ...prev]);
                    }}
                    onPromptAction={promptText => handleSurfaceAiPrompt(promptText)}
                    onDebugWithAi={errorPrompt => handleSendMessage(errorPrompt)}
                    hideTopbar={false}
                    hideInternalChat={true}
                />
            </CanvasErrorBoundary>
        )}
        </>
    );
};

/** Kanban, node-graph, 3D scene and browser surfaces. */
export const BoardGraphSpatialSurfaces: React.FC<ArtifactStageProps> = props => {
    const { activeArtifact, activeWorkspace, layoutMode, handleUpdateArtifact, handleMorphArtifact, handleSurfaceAiPrompt } = props;
    return (
        <>
        {layoutMode === 'kanban' && (
            <CanvasErrorBoundary fallbackTitle="Kanban Board">
                <KanbanBoardPrimitive
                    data={(activeArtifact?.type === 'kanban-board' ? (activeArtifact.data as KanbanBoardData) : undefined) || {
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
                    }}
                    onUpdate={updatedData => {
                        if (activeArtifact) {
                            handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                        }
                    }}
                    onMorphArtifact={handleMorphArtifact}
                    onMorphCardToSandbox={sandboxData => {
                        handleMorphArtifact({
                            id: `art-code-${Date.now()}`,
                            title: sandboxData.title,
                            summary: sandboxData.subtitle || 'Component Sandbox',
                            type: 'live-code-sandbox',
                            data: sandboxData,
                            createdAt: new Date().toLocaleTimeString(),
                            version: 1
                        });
                    }}
                />
            </CanvasErrorBoundary>
        )}
        {(layoutMode === 'automation' || layoutMode === 'canvas') && (
            <CanvasErrorBoundary fallbackTitle="Node Workflow Graph">
                <NodeGraphPrimitive
                    data={(activeArtifact?.data as NodeGraphData) || {
                        title: 'Canvas Workflow',
                        subtitle: 'Drag and connect nodes to create automated execution pipelines',
                        nodes: [
                            { id: 'node-1', label: 'Webhook Trigger', subtitle: 'POST /api/v1/event', category: 'input', color: 'blue', x: 80, y: 140, status: 'completed' },
                            { id: 'node-2', label: 'Reasoning Engine', subtitle: 'Gemini 3.7 Flash', category: 'ai', color: 'purple', x: 440, y: 140, status: 'running' }
                        ],
                        edges: [
                            { id: 'e1', source: 'node-1', target: 'node-2', label: 'Payload', style: 'solid', color: 'purple' }
                        ]
                    }}
                    onUpdate={updatedData => {
                        if (activeArtifact) {
                            handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                        }
                    }}
                    onPromptAction={promptText => handleSurfaceAiPrompt(promptText)}
                    workspacePath={activeWorkspace.path}
                />
            </CanvasErrorBoundary>
        )}
        {layoutMode === '3d' && (
            <div className="sb-3d-stage-wrapper w-full h-full flex flex-col items-center justify-start overflow-hidden flex-1 min-h-0">
                <CanvasErrorBoundary fallbackTitle="3D Scene Viewport">
                    <Scene3DPrimitive
                        data={(activeArtifact?.type === '3d-scene' ? (activeArtifact.data as Scene3DData) : undefined) || {
                            title: 'Interactive 4D Scene Workspace',
                            subtitle: 'WebGL viewport with procedural topography, real-time wave solvers, and simulated WASM linear memory heap.',
                            objects: [],
                            camera: { position: [15, 12, 15], target: [0, 0, 0] },
                            environment: { skybox: 'cyberpunk', lighting: 'shaded', ground: true }
                        }}
                        onUpdate={updatedData => {
                            if (activeArtifact && activeArtifact.type === '3d-scene') {
                                handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                            } else {
                                const newArt: CanvasArtifact = {
                                    id: activeArtifact?.id || `art-3d-${Date.now()}`,
                                    type: '3d-scene',
                                    title: updatedData.title || 'Interactive 3D Scene Workspace',
                                    summary: updatedData.subtitle || 'Interactive 3D spatial canvas viewport',
                                    version: 1,
                                    createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                    data: updatedData
                                };
                                handleUpdateArtifact(newArt);
                            }
                        }}
                        onPromptAction={promptText => handleSurfaceAiPrompt(promptText)}
                        onMorphArtifact={handleMorphArtifact}
                    />
                </CanvasErrorBoundary>
            </div>
        )}
        {layoutMode === 'browser' && (
            <div className="sb-browser-stage-wrapper w-full h-full flex flex-col items-center justify-start overflow-hidden flex-1 min-h-0">
                <CanvasErrorBoundary fallbackTitle="Interactive Browser">
                    <InteractiveBrowserPrimitive
                        data={(activeArtifact?.type === 'interactive-browser' || activeArtifact?.type === 'browser' ? (activeArtifact.data as InteractiveBrowserData) : undefined) || {
                            url: 'https://example.com',
                            title: 'Example Domain',
                            viewportMode: 'desktop',
                            history: ['https://example.com'],
                            historyIndex: 0,
                            isLoading: false,
                            consoleLogs: [
                                { type: 'info', text: 'Browser canvas initialized at https://example.com', timestamp: new Date().toLocaleTimeString() },
                                { type: 'log', text: 'DOM ready. Ready for user navigation and AI agent actions.', timestamp: new Date().toLocaleTimeString() }
                            ],
                            inspectMode: false,
                            deviceScale: 1
                        }}
                        onUpdate={(updatedData: InteractiveBrowserData) => {
                            if (activeArtifact) {
                                handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                            }
                        }}
                        onPromptAction={(promptText: string) => handleSurfaceAiPrompt(promptText)}
                        onMorphArtifact={handleMorphArtifact}
                    />
                </CanvasErrorBoundary>
            </div>
        )}
        </>
    );
};

/** Scrollable body of the canvas card: the bento matrix or the single active primitive surface. */
export const CanvasCardBody: React.FC<ArtifactStageProps> = props => {
    const { activeArtifact, setActiveArtifact, artifactHistory, activeWorkspace, layoutMode, stageLayoutMode, setStageLayoutMode, handleUpdateArtifact, handleMorphArtifact, handleOpenInAppBrowser, handleSurfaceAiPrompt } = props;
    return (
        <div className="sb-document-card-body sb-surface-main-viewport" style={{
            flex: 1,
            overflowY: layoutMode === '3d' || layoutMode === 'browser' ? 'hidden' : 'auto',
            padding: layoutMode === '3d' || layoutMode === 'browser' ? '0' : '24px 24px 80px 24px',
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0
        }}>
        {stageLayoutMode !== 'single' ? (
            <CanvasErrorBoundary fallbackTitle="Bento Canvas Stage">
                <BentoStageLayout
                    layoutMode={stageLayoutMode}
                    onLayoutModeChange={setStageLayoutMode}
                    artifacts={artifactHistory.length > 0 ? artifactHistory : (activeArtifact ? [activeArtifact] : [])}
                    activeArtifactId={activeArtifact?.id}
                    onSelectArtifact={id => {
                        const found = artifactHistory.find(a => a.id === id);
                        if (found) {
                            setActiveArtifact(found);
                        }
                    }}
                    onUpdateArtifact={handleUpdateArtifact}
                    onMorphArtifact={(artifact, targetType) => {
                        const morphed = morphArtifact(artifact, targetType);
                        handleMorphArtifact(morphed);
                    }}
                    onPromptAction={promptText => handleSurfaceAiPrompt(promptText)}
                    onOpenInBrowser={handleOpenInAppBrowser}
                    workspacePath={activeWorkspace.path}
                />
            </CanvasErrorBoundary>
        ) : (
            <>
                <DocumentCodeSurfaces {...props} />
                <BoardGraphSpatialSurfaces {...props} />
            </>
        )}
    </div>
    );
};
