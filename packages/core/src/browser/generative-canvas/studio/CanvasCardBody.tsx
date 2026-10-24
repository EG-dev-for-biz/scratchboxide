/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import { BentoStageLayout } from '../BentoStageLayout';
import { CanvasArtifact, InteractiveBrowserData, KanbanBoardData, LiveCodeSandboxData, MarkdownDocumentData, MetricDashboardData, NodeGraphData, PrimitiveType, Scene3DData, VideoTimelineData, getActiveUserName } from '../canvas-types';
import { CanvasErrorBoundary } from '../CanvasErrorBoundary';
import { InteractiveBrowserPrimitive } from '../primitives/InteractiveBrowserPrimitive';
import { KanbanBoardPrimitive } from '../primitives/KanbanBoardPrimitive';
import { LiveCodeSandboxPrimitive } from '../primitives/LiveCodeSandboxPrimitive';
import { MarkdownDocumentPrimitive } from '../primitives/MarkdownDocumentPrimitive';
import { MetricCardsPrimitive } from '../primitives/MetricCardsPrimitive';
import { NodeGraphPrimitive } from '../primitives/NodeGraphPrimitive';
import { Scene3DPrimitive } from '../primitives/Scene3DPrimitive';
import { VideoTimelinePrimitive } from '../primitives/VideoTimelinePrimitive';
import { VirtualGeometryViewport } from '../primitives/VirtualGeometryViewport';
import { morphArtifact } from '../primitive-transformer-engine';
import { ArtifactStageProps } from './artifact-stage-props';

/** The title of a document nobody named. */
const UNTITLED_DOCUMENT = 'Untitled document';

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
                        // Only the document's own sections: a document with none renders empty (with its add-section
                        // controls), never a template document written from its title.
                        if (activeArtifact?.type === 'markdown-document') {
                            const doc = activeArtifact.data as MarkdownDocumentData;
                            const effectiveTitle = doc?.title && doc.title !== 'Markdown Document' ? doc.title : activeArtifact.title || UNTITLED_DOCUMENT;
                            return {
                                ...doc,
                                title: effectiveTitle,
                                sections: Array.isArray(doc?.sections) ? doc.sections : []
                            };
                        }
                        return { title: UNTITLED_DOCUMENT, sections: [] };
                    })()}
                    onUpdate={(updatedData: MarkdownDocumentData) => {
                        const nextTitle = updatedData.title && updatedData.title !== 'Markdown Document' ? updatedData.title : (activeArtifact?.title || UNTITLED_DOCUMENT);
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
            activeArtifact?.type === 'metric-dashboard' ? (
                <CanvasErrorBoundary fallbackTitle="KPI Metrics Dashboard">
                    <MetricCardsPrimitive
                        data={(activeArtifact.data as MetricDashboardData) || {
                            title: 'Performance & Telemetry Metrics',
                            subtitle: 'Real-time telemetry and KPI metrics',
                            metrics: [
                                { id: 'm1', label: 'Throughput', value: '1,240 req/s', change: '+12%', trend: 'up', color: 'blue', sparkline: [100, 110, 105, 120, 118, 125, 130] },
                                { id: 'm2', label: 'Avg Latency', value: '42ms', change: '-8%', trend: 'down', color: 'emerald', sparkline: [50, 48, 45, 46, 44, 43, 42] },
                                { id: 'm3', label: 'Error Rate', value: '0.02%', change: '-0.01%', trend: 'down', color: 'purple', sparkline: [0.05, 0.04, 0.03, 0.03, 0.02, 0.02, 0.02] }
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
                        }}
                        onUpdate={updatedData => {
                            if (activeArtifact) {
                                handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                            }
                        }}
                        onAnalyzeWithAi={metricTitle => handleSurfaceAiPrompt(`Analyze metric: ${metricTitle}`)}
                    />
                </CanvasErrorBoundary>
            ) : (
                <CanvasErrorBoundary fallbackTitle="Live Code Sandbox">
                    <LiveCodeSandboxPrimitive
                        data={(activeArtifact?.type === 'live-code-sandbox' ? (activeArtifact.data as LiveCodeSandboxData) : undefined) || {
                            title: 'Interactive React 19 UI Playground',
                            subtitle: 'Multi-tab live code runner with hot reload & runtime console',
                            template: 'react',
                            viewMode: 'preview',
                            files: [
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
                        hideTopbar={true}
                        hideInternalChat={true}
                    />
                </CanvasErrorBoundary>
            )
        )}
        </>
    );
};

/** Kanban, node-graph, 3D scene and browser surfaces. */
export const BoardGraphSpatialSurfaces: React.FC<ArtifactStageProps> = props => {
    const { activeArtifact, activeWorkspace, layoutMode, handleUpdateArtifact, handleMorphArtifact, handleSurfaceAiPrompt, isGenerating } = props;
    return (
        <>
        {layoutMode === 'kanban' && (
            <CanvasErrorBoundary fallbackTitle="Kanban Board">
                <KanbanBoardPrimitive
                    activeArtifact={activeArtifact?.type === 'kanban-board' ? activeArtifact : undefined}
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
                    isAgentGenerating={isGenerating}
                    onPromptAction={handleSurfaceAiPrompt}
                    onMorphArtifact={handleMorphArtifact}
                    onMorphWholeBoard={(artifact, targetType) => {
                        const morphed = morphArtifact(artifact, targetType as PrimitiveType);
                        handleMorphArtifact(morphed);
                    }}
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
                            { id: 'node-2', label: 'Reasoning Engine', subtitle: 'Gemini 3.8 Flash', category: 'ai', color: 'purple', x: 440, y: 140, status: 'running' }
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
                    artifactId={activeArtifact?.type === 'node-graph' ? activeArtifact.id : undefined}
                />
            </CanvasErrorBoundary>
        )}
        {layoutMode === '3d' && (
            <div className="sb-3d-stage-wrapper w-full h-full flex flex-col items-center justify-start overflow-hidden flex-1 min-h-0">
                <CanvasErrorBoundary fallbackTitle="3D Scene Viewport">
                    {activeArtifact?.type === '3d-scene' && (activeArtifact.data as Scene3DData)?.virtualGeometry ? (
                    <VirtualGeometryViewport
                        key={`${activeArtifact.id}-virtual-geometry`}
                        data={activeArtifact.data as Scene3DData}
                        workspacePath={activeWorkspace?.path}
                        onUpdate={updatedData => handleUpdateArtifact({ ...activeArtifact, data: updatedData })}
                    />
                    ) : (
                    <Scene3DPrimitive
                        key={activeArtifact?.id || 'scene-3d-primitive'}
                        activeArtifact={activeArtifact?.type === '3d-scene' ? activeArtifact : undefined}
                        data={(() => {
                            if (activeArtifact?.type === '3d-scene') {
                                const d = (activeArtifact.data as Scene3DData) || {};
                                return {
                                    ...d,
                                    title: (activeArtifact.title && activeArtifact.title !== 'Visual Creation' && activeArtifact.title !== '4D Scene Workspace')
                                        ? activeArtifact.title
                                        : (d.title || activeArtifact.title || 'Interactive 3D Scene Workspace')
                                };
                            }
                            // No 3D scene yet: an empty one in the neutral studio, the same as a new 4D Scene workspace
                            // (newEmptySceneArtifact). The viewport says "No geometry"; nothing describes content it lacks.
                            return {
                                title: '4D Scene',
                                objects: [],
                                environment: { skybox: 'studio', lighting: 'studio', ground: false }
                            };
                        })()}
                        onUpdate={updatedData => {
                            if (activeArtifact && activeArtifact.type === '3d-scene') {
                                handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                            } else {
                                const newArt: CanvasArtifact = {
                                    id: activeArtifact?.id || `art-3d-${Date.now()}`,
                                    type: '3d-scene',
                                    title: updatedData.title || '4D Scene',
                                    summary: updatedData.subtitle || '',
                                    version: 1,
                                    createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                    data: updatedData
                                };
                                handleUpdateArtifact(newArt);
                            }
                        }}
                        onPromptAction={promptText => handleSurfaceAiPrompt(promptText)}
                        onMorphArtifact={(artifact, targetType) => {
                            const morphed = morphArtifact(artifact, targetType as PrimitiveType);
                            handleMorphArtifact(morphed);
                        }}
                    />
                    )}
                </CanvasErrorBoundary>
            </div>
        )}
        {layoutMode === 'browser' && (
            <div className="sb-browser-stage-wrapper w-full h-full flex flex-col items-center justify-start overflow-hidden flex-1 min-h-0">
                <CanvasErrorBoundary fallbackTitle="Interactive Browser">
                    <InteractiveBrowserPrimitive
                        key={activeArtifact?.id || 'browser'}
                        data={(activeArtifact?.type === 'interactive-browser' || activeArtifact?.type === 'browser' ? (activeArtifact.data as InteractiveBrowserData) : undefined) || {
                            url: 'https://example.com',
                            title: 'Example Domain',
                            viewportMode: 'desktop',
                            history: ['https://example.com'],
                            historyIndex: 0,
                            isLoading: false,
                            consoleLogs: [],
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
        {layoutMode === 'video' && (
            <div className="sb-video-stage-wrapper w-full h-full flex flex-col items-center justify-start overflow-hidden flex-1 min-h-0">
                <CanvasErrorBoundary fallbackTitle="Video NLE Timeline">
                    <VideoTimelinePrimitive
                        data={(activeArtifact?.type === 'video-timeline' ? (activeArtifact.data as VideoTimelineData) : undefined)}
                        onUpdate={(updatedData: VideoTimelineData) => {
                            if (activeArtifact && activeArtifact.type === 'video-timeline') {
                                handleUpdateArtifact({ ...activeArtifact, data: updatedData });
                            } else {
                                const newArt: CanvasArtifact = {
                                    id: activeArtifact?.id || `art-video-${Date.now()}`,
                                    type: 'video-timeline',
                                    title: updatedData.title || 'Video Timeline',
                                    summary: updatedData.subtitle || 'Non-linear video editor timeline',
                                    version: 1,
                                    createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                                    data: updatedData
                                };
                                handleUpdateArtifact(newArt);
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
    const { activeArtifact, setActiveArtifact, artifactHistory, activeWorkspace, layoutMode, stageLayoutMode, setStageLayoutMode, handleUpdateArtifact, handleMorphArtifact, handleOpenInAppBrowser, handleSurfaceAiPrompt, showToast } = props;
    return (
        <div className="sb-document-card-body sb-surface-main-viewport" style={{
            flex: 1,
            overflowY: layoutMode === '3d' || layoutMode === 'browser' || layoutMode === 'video' ? 'hidden' : 'auto',
            padding: layoutMode === '3d' || layoutMode === 'browser' || layoutMode === 'video' ? '0' : '24px 24px 80px 24px',
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
                        // A morph that cannot make what was asked (such as a 3D scene from a document no template
                        // fits) fails with its reason, shown here, instead of opening a stand-in.
                        let morphed: ReturnType<typeof morphArtifact>;
                        try {
                            morphed = morphArtifact(artifact, targetType);
                        } catch (err) {
                            showToast(`Could not turn "${artifact.title}" into a ${targetType}: ${err instanceof Error ? err.message : String(err)}`, '⚠️');
                            return;
                        }
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
