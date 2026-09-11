/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * useWorkspaceFiles
 *
 * Workspace explorer actions: open a file from the tree into the right canvas primitive, surface AI prompts from a canvas, create new workspace files.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { ProjectItem } from '../ProjectsModal';
import { CanvasArtifact, ChatSession, CodeFileTab, InteractiveBrowserData, KanbanBoardData, LiveCodeSandboxData, MarkdownDocumentData, NodeGraphData, PrimitiveType, Scene3DData, StudioLayoutMode, WorkspaceFileType, getActiveUserName } from '../canvas-types';
import { synthesizeComprehensiveDocument } from '../document-synthesis-engine';
import { KanbanBoardPrimitive } from '../primitives/KanbanBoardPrimitive';
import { MarkdownDocumentPrimitive } from '../primitives/MarkdownDocumentPrimitive';
import { NodeGraphPrimitive } from '../primitives/NodeGraphPrimitive';
import { Scene3DPrimitive } from '../primitives/Scene3DPrimitive';
import { ChatState, ChatStore } from '../state/chatStore';

export interface UseWorkspaceFilesDeps {
    activeArtifact: ChatState['activeArtifact'];
    activeWorkspace: ProjectItem;
    artifactHistory: ChatState['artifactHistory'];
    currentSessionId: ChatState['currentSessionId'];
    handleSendMessage: (textToSend?: string, targetPrimitiveType?: PrimitiveType) => Promise<void>;
    isGenerating: boolean;
    layoutMode: ChatState['layoutMode'];
    messages: ChatState['messages'];
    setActiveArtifact: ChatStore['setActiveArtifact'];
    setArtifactHistory: ChatStore['setArtifactHistory'];
    setCurrentSessionId: ChatStore['setCurrentSessionId'];
    setLayoutMode: ChatStore['setLayoutMode'];
    setMessages: ChatStore['setMessages'];
    setSessions: ChatStore['setSessions'];
    setShowComposerWorkspaceMenu: React.Dispatch<React.SetStateAction<boolean>>;
    setShowNewWorkspaceMenu: React.Dispatch<React.SetStateAction<boolean>>;
    showComposerWorkspaceMenu: boolean;
    showNewWorkspaceMenu: boolean;
    showToast: (text: string, icon?: string) => void;
}

export function useWorkspaceFiles(deps: UseWorkspaceFilesDeps) {
    const { activeArtifact, activeWorkspace, artifactHistory, currentSessionId, handleSendMessage, isGenerating, layoutMode, messages, setActiveArtifact, setArtifactHistory, setCurrentSessionId, setLayoutMode, setMessages, setSessions, setShowComposerWorkspaceMenu, setShowNewWorkspaceMenu, showComposerWorkspaceMenu, showNewWorkspaceMenu, showToast } = deps;

    const getMockFileContent = (filePath: string, fileName: string): string => {
        if (fileName.endsWith('.tsx') || fileName.endsWith('.ts')) {
            return `import React from 'react';\n\n// Mock content loaded from ${filePath}\nexport default function ${fileName.split('.')[0]}() {\n    return (\n        <div className="p-6 bg-zinc-900 border border-zinc-800 rounded-2xl text-center space-y-4">\n            <h2 className="text-xl font-semibold text-blue-400">${fileName}</h2>\n            <p className="text-zinc-400">Successfully loaded file from path: <code>\${filePath}</code></p>\n        </div>\n    );\n}`;
        }
        if (fileName.endsWith('.css')) {
            return `/* Mock styles loaded from ${filePath} */\n.file-container {\n    padding: 24px;\n    background-color: var(--sb-surface-glass);\n}`;
        }
        if (fileName.endsWith('.md')) {
            return `# ${fileName.split('.')[0]}\n\nThis is a mock markdown specification document representing **${fileName}**.\n\n## Section 1: Overview\n- Path: \`${filePath}\`\n- Loaded: Yes\n- Integration: Unified Click Routing`;
        }
        return `// File: ${fileName}\n// Path: ${filePath}\nconsole.log("${fileName} successfully initialized");`;
    };


    const handleFileClick = (filePath: string, fileName: string) => {
        const ext = fileName.split('.').pop() || '';
        
        let targetLayoutMode: StudioLayoutMode;
        let artifactType: PrimitiveType;
        
        if (ext === '3d' || fileName === 'Scene3DPrimitive.tsx') {
            targetLayoutMode = '3d';
            artifactType = '3d-scene';
        } else if (ext === 'md' || fileName === 'MarkdownDocumentPrimitive.tsx') {
            targetLayoutMode = 'document';
            artifactType = 'markdown-document';
        } else if (ext === 'json' || fileName === 'KanbanBoardPrimitive.tsx') {
            targetLayoutMode = 'kanban';
            artifactType = 'kanban-board';
        } else if (ext === 'automation' || fileName === 'NodeGraphPrimitive.tsx') {
            targetLayoutMode = 'automation';
            artifactType = 'node-graph';
        } else if (['tsx', 'ts', 'js', 'css'].includes(ext)) {
            targetLayoutMode = 'code';
            artifactType = 'live-code-sandbox';
        } else {
            targetLayoutMode = 'code';
            artifactType = 'live-code-sandbox';
        }

        setLayoutMode(targetLayoutMode);

        if (artifactType === 'live-code-sandbox') {
            let currentSandbox: LiveCodeSandboxData;
            let currentArtifactId = `art-sandbox-${Date.now()}`;
            
            if (activeArtifact && activeArtifact.type === 'live-code-sandbox') {
                currentSandbox = { ...(activeArtifact.data as LiveCodeSandboxData) };
                currentArtifactId = activeArtifact.id;
            } else {
                currentSandbox = {
                    title: 'Interactive React 19 UI Playground',
                    subtitle: 'Multi-tab live code runner with hot reload & runtime console',
                    template: 'react',
                    files: [],
                    dependencies: {
                        'lucide-react': '^0.468.0',
                        'canvas-confetti': '^1.9.3'
                    },
                    viewportMode: 'desktop'
                };
            }

            const normalizedPath = filePath;
            let fileId = `file-${fileName.replace(/[^a-zA-Z0-9]/g, '-')}`;
            const existingFile = currentSandbox.files.find(f => f.path === normalizedPath || f.name === fileName);
            
            if (existingFile) {
                fileId = existingFile.id;
                currentSandbox.activeFileId = fileId;
            } else {
                const mockContent = getMockFileContent(normalizedPath, fileName);
                const newTab: CodeFileTab = {
                    id: fileId,
                    name: fileName,
                    language: ext === 'tsx' ? 'react' : ext === 'ts' ? 'typescript' : ext === 'css' ? 'css' : 'javascript',
                    content: mockContent,
                    path: normalizedPath,
                    isEntry: currentSandbox.files.length === 0
                };
                currentSandbox.files = [...currentSandbox.files, newTab];
                currentSandbox.activeFileId = fileId;
            }

            const updatedArtifact: CanvasArtifact = {
                id: currentArtifactId,
                type: 'live-code-sandbox',
                title: fileName,
                summary: `Editing ${fileName}`,
                version: (activeArtifact?.id === currentArtifactId ? activeArtifact.version : 0) + 1,
                createdAt: new Date().toLocaleTimeString(),
                data: currentSandbox
            };

            setActiveArtifact(updatedArtifact);
            setArtifactHistory(prev => {
                const filtered = prev.filter(a => a.id !== updatedArtifact.id);
                return [updatedArtifact, ...filtered];
            });
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));

        } else if (artifactType === 'markdown-document') {
            const mockContent = getMockFileContent(filePath, fileName);
            const sections = mockContent.split('\n\n').map((para, idx) => {
                if (para.startsWith('# ')) {
                    return { id: `sec-${idx}`, type: 'heading' as const, level: 1 as const, content: para.replace(/^#+\s*/, '') };
                } else if (para.startsWith('## ') || para.startsWith('### ')) {
                    return { id: `sec-${idx}`, type: 'heading' as const, level: 2 as const, content: para.replace(/^#+\s*/, '') };
                } else if (para.startsWith('- [ ] ') || para.startsWith('- [x] ')) {
                    const done = para.startsWith('- [x] ');
                    const text = para.replace(/- \[[x ]\] /, '');
                    return { id: `sec-${idx}`, type: 'checklist' as const, checklistItems: [{ id: `item-${idx}`, text, done }] };
                } else {
                    return { id: `sec-${idx}`, type: 'paragraph' as const, content: para };
                }
            });

            const docData: MarkdownDocumentData = {
                title: fileName,
                subtitle: `Viewing project specification at ${filePath}`,
                author: getActiveUserName(),
                lastUpdated: 'Just now',
                tags: ['Specification', 'Documentation'],
                sections: sections.length > 0 ? sections : [{ id: 'sec-1', type: 'paragraph', content: mockContent }]
            };

            const updatedArtifact: CanvasArtifact = {
                id: `art-doc-${Date.now()}`,
                type: 'markdown-document',
                title: fileName,
                summary: `Viewing document ${fileName}`,
                version: 1,
                createdAt: new Date().toLocaleTimeString(),
                data: docData
            };

            setActiveArtifact(updatedArtifact);
            setArtifactHistory(prev => {
                const filtered = prev.filter(a => a.id !== updatedArtifact.id);
                return [updatedArtifact, ...filtered];
            });
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));

        } else if (artifactType === 'kanban-board') {
            const kanbanData: KanbanBoardData = {
                title: fileName,
                subtitle: `Delivery board representing ${filePath}`,
                columns: [
                    {
                        id: 'todo',
                        title: 'To Do',
                        color: 'blue',
                        cards: [
                            { id: 'c1', title: `Setup workflow for ${fileName}`, description: `Initialize sprint card matching current folder.`, priority: 'medium' }
                        ]
                    },
                    {
                        id: 'in_progress',
                        title: 'In Progress',
                        color: 'amber',
                        cards: [
                            { id: 'c2', title: `Implementing file ${fileName}`, description: 'Active work tracking.', priority: 'high' }
                        ]
                    },
                    {
                        id: 'done',
                        title: 'Done',
                        color: 'emerald',
                        cards: []
                    }
                ]
            };

            const updatedArtifact: CanvasArtifact = {
                id: `art-kanban-${Date.now()}`,
                type: 'kanban-board',
                title: fileName,
                summary: `Sprint board ${fileName}`,
                version: 1,
                createdAt: new Date().toLocaleTimeString(),
                data: kanbanData
            };

            setActiveArtifact(updatedArtifact);
            setArtifactHistory(prev => {
                const filtered = prev.filter(a => a.id !== updatedArtifact.id);
                return [updatedArtifact, ...filtered];
            });
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));

        } else if (artifactType === 'node-graph') {
            const graphData: NodeGraphData = {
                title: fileName,
                subtitle: `Automation canvas node graph at ${filePath}`,
                nodes: [
                    { id: 'n1', label: fileName, subtitle: 'Active File', category: 'input', x: 200, y: 150, status: 'completed' },
                    { id: 'n2', label: 'AI Processor', subtitle: 'Gemini 3.7 Flash', category: 'ai', x: 450, y: 150, status: 'running' }
                ],
                edges: [
                    { id: 'e1', source: 'n1', target: 'n2', style: 'animated', color: 'indigo' }
                ]
            };

            const updatedArtifact: CanvasArtifact = {
                id: `art-graph-${Date.now()}`,
                type: 'node-graph',
                title: fileName,
                summary: `Workflow graph ${fileName}`,
                version: 1,
                createdAt: new Date().toLocaleTimeString(),
                data: graphData
            };

            setActiveArtifact(updatedArtifact);
            setArtifactHistory(prev => {
                const filtered = prev.filter(a => a.id !== updatedArtifact.id);
                return [updatedArtifact, ...filtered];
            });
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));

        } else if (artifactType === '3d-scene') {
            const sceneData: Scene3DData = {
                title: fileName,
                subtitle: `Spatial coordinate scene from ${filePath}`,
                objects: [
                    {
                        id: 'obj-mesh-1',
                        content: {
                            type: '3d-scene',
                            durableUri: 'internal:mesh',
                            mimeType: 'model/gltf-binary',
                            metadata: { dims: { width: 5, height: 5, depth: 5 } }
                        },
                        space: {
                            spatial3d: { x: 0, y: 0, z: 0, pitch: 0, yaw: 45, roll: 0 }
                        },
                        time: { startMs: 0, durationMs: 0 },
                        lineage: { version: 1 }
                    }
                ],
                camera: {
                    position: [10, 10, 10],
                    target: [0, 0, 0]
                },
                environment: {
                    skybox: 'cyberpunk',
                    lighting: 'shaded',
                    ground: true
                }
            };

            const updatedArtifact: CanvasArtifact = {
                id: `art-3d-${Date.now()}`,
                type: '3d-scene',
                title: fileName,
                summary: `3D spatial scene ${fileName}`,
                version: 1,
                createdAt: new Date().toLocaleTimeString(),
                data: sceneData
            };

            setActiveArtifact(updatedArtifact);
            setArtifactHistory(prev => {
                const filtered = prev.filter(a => a.id !== updatedArtifact.id);
                return [updatedArtifact, ...filtered];
            });
            setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));
        }

        showToast(`Loaded "${fileName}" in ${targetLayoutMode === 'code' ? 'Code Sandbox' : targetLayoutMode + ' view'}`);
    };



    const handleSurfaceAiPrompt = (promptText: string) => {
        if (!promptText.trim() || isGenerating) return;
        handleSendMessage(promptText.trim());
    };

    // Global click listener to close new workspace dropdowns
    React.useEffect(() => {
        const handleGlobalClick = () => {
            setShowNewWorkspaceMenu(false);
            setShowComposerWorkspaceMenu(false);
        };
        if (showNewWorkspaceMenu || showComposerWorkspaceMenu) {
            window.addEventListener('click', handleGlobalClick);
            return () => window.removeEventListener('click', handleGlobalClick);
        }
    }, [showNewWorkspaceMenu, showComposerWorkspaceMenu]);

    return { handleFileClick, handleSurfaceAiPrompt };
}

/** Creates a new workspace file of the given type as a fresh canvas + chat session. */
export function useWorkspaceFileCreation(deps: UseWorkspaceFilesDeps) {
    const { activeArtifact, activeWorkspace, artifactHistory, layoutMode, messages, setActiveArtifact, setArtifactHistory, setCurrentSessionId, setLayoutMode, setMessages, setSessions, showToast } = deps;

    const handleCreateWorkspaceFile = (type: WorkspaceFileType) => {
        const newSessionId = `session-${type}-${Date.now()}`;

        let newSession: ChatSession;
        if (type === 'chat') {
            newSession = {
                id: newSessionId,
                title: 'New Chat',
                fileType: 'chat',
                layoutMode: 'chat',
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                artifactHistory: []
            };
        } else if (type === 'code') {
            const codeArtifact: CanvasArtifact = {
                id: `art-sandbox-${Date.now()}`,
                type: 'live-code-sandbox',
                title: 'Component Sandbox',
                summary: 'Live editable code runner & interactive preview',
                version: 1,
                createdAt: 'Just now',
                data: {
                    title: 'Live Sandbox Playground',
                    subtitle: 'Interactive React/Tailwind preview playground',
                    template: 'react',
                    viewMode: 'preview',
                    viewportMode: 'desktop',
                    files: [
                        {
                            id: 'App.tsx',
                            name: 'App.tsx',
                            language: 'typescript',
                            content: `import React, { useState } from 'react';\n\nexport default function App() {\n    const [count, setCount] = useState(0);\n    return (\n        <div style={{ padding: 32, fontFamily: 'system-ui, sans-serif', color: '#f8fafc', background: '#090d16', minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>\n            <div style={{ background: '#131b2e', padding: 32, borderRadius: 16, border: '1px solid #1e293b', textAlign: 'center', maxWidth: 440, width: '100%' }}>\n                <h1 style={{ fontSize: 24, margin: '0 0 12px 0', color: '#60a5fa' }}>⚡ Scratchbox Live Preview</h1>\n                <p style={{ color: '#94a3b8', fontSize: 14, margin: '0 0 24px 0' }}>Edit this code in Split or Code mode, and watch your changes render instantly.</p>\n                <button onClick={() => setCount(c => c + 1)} style={{ padding: '10px 24px', fontSize: 15, fontWeight: 600, borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', cursor: 'pointer', boxShadow: '0 4px 12px rgba(37,99,235,0.3)' }}>\n                    Interactive Counter: {count}\n                </button>\n            </div>\n        </div>\n    );\n}`,
                            isEntry: true
                        }
                    ]
                } as LiveCodeSandboxData
            };
            newSession = {
                id: newSessionId,
                title: 'Component Sandbox',
                fileType: 'code',
                layoutMode: 'code',
                activeArtifact: codeArtifact,
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                artifactHistory: [codeArtifact]
            };
        } else if (type === 'document') {
            const defaultDoc = synthesizeComprehensiveDocument('write a document about 1776');
            const docArtifact: CanvasArtifact = {
                id: `art-doc-${Date.now()}`,
                type: 'markdown-document',
                title: defaultDoc.title,
                summary: defaultDoc.subtitle || 'Specification Document',
                data: defaultDoc,
                version: 1,
                createdAt: 'Just now'
            };
            newSession = {
                id: newSessionId,
                title: 'The Enduring Significance of 1776',
                fileType: 'document',
                layoutMode: 'document',
                activeArtifact: docArtifact,
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                artifactHistory: [docArtifact]
            };
        } else if (type === 'kanban') {
            newSession = {
                id: newSessionId,
                title: 'Sprint Roadmap',
                fileType: 'kanban',
                layoutMode: 'kanban',
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                artifactHistory: []
            };
        } else if (type === '3d') {
            const activeArt: CanvasArtifact = {
                id: `art-3d-${Date.now()}`,
                type: '3d-scene',
                title: 'Interactive 4D Scene Workspace',
                summary: 'WebGL viewport with procedural topography, real-time wave solvers, and simulated WASM linear memory heap.',
                data: {
                    title: 'Interactive 4D Scene Workspace',
                    subtitle: 'WebGL viewport with procedural topography, real-time wave solvers, and simulated WASM linear memory heap.',
                    objects: [
                        {
                            id: 'obj-grid-1',
                            content: {
                                type: '3d-scene',
                                durableUri: 'internal:grid',
                                mimeType: 'model/gltf-binary',
                                metadata: { dims: { width: 30, height: 0, depth: 30 } }
                            },
                            space: {
                                spatial3d: { x: 0, y: -1, z: 0, pitch: 0, yaw: 0, roll: 0 }
                            },
                            time: { startMs: 0, durationMs: 0 },
                            lineage: { version: 1 }
                        },
                        {
                            id: 'obj-light-1',
                            content: {
                                type: '3d-scene',
                                durableUri: 'internal:sunlight',
                                mimeType: 'model/gltf-binary',
                                metadata: {}
                            },
                            space: {
                                spatial3d: { x: 15, y: 30, z: 10, pitch: 0, yaw: 0, roll: 0 }
                            },
                            time: { startMs: 0, durationMs: 0 },
                            lineage: { version: 1 }
                        }
                    ],
                    camera: {
                        position: [15, 12, 15],
                        target: [0, 0, 0]
                    },
                    environment: {
                        skybox: 'cyberpunk',
                        lighting: 'shaded',
                        ground: true
                    }
                },
                createdAt: new Date().toLocaleTimeString(),
                version: 1
            };
            newSession = {
                id: newSessionId,
                title: 'Workspace 4D Scene',
                fileType: '3d',
                layoutMode: '3d',
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                activeArtifact: activeArt,
                artifactHistory: [activeArt]
            };
        } else if (type === 'browser') {
            const activeArt: CanvasArtifact = {
                id: `art-browser-${Date.now()}`,
                type: 'interactive-browser',
                title: 'Interactive Web Browser',
                summary: 'AI-controllable web browser with responsive device frames, live console logs, and dev inspection tools.',
                data: {
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
                } as InteractiveBrowserData,
                createdAt: new Date().toLocaleTimeString(),
                version: 1
            };
            newSession = {
                id: newSessionId,
                title: 'Interactive Web Browser',
                fileType: 'browser',
                layoutMode: 'browser',
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                activeArtifact: activeArt,
                artifactHistory: [activeArt]
            };
        } else {
            newSession = {
                id: newSessionId,
                title: 'Canvas Workflow',
                fileType: 'automation',
                layoutMode: 'automation',
                workspaceId: activeWorkspace.id,
                workspaceName: activeWorkspace.path.split('/').pop() || activeWorkspace.name,
                relativeTime: 'Just now',
                dateCategory: 'Today',
                updatedAt: 'Just now',
                messages: [],
                artifactHistory: []
            };
        }

        setSessions(prev => [newSession, ...prev]);
        setCurrentSessionId(newSession.id);
        setMessages(newSession.messages);
        setActiveArtifact(newSession.activeArtifact);
        setArtifactHistory(newSession.artifactHistory || []);
        setLayoutMode(newSession.layoutMode || 'chat');
        showToast(`Created new blank ${type} file in ${activeWorkspace.name}`);
    };

    return { handleCreateWorkspaceFile };
}
