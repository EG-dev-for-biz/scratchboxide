/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
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
import { CanvasArtifact, ChatSession, CodeFileTab, InteractiveBrowserData, KanbanBoardData, LiveCodeSandboxData, MarkdownDocumentData, NodeGraphData, PrimitiveType, Scene3DData, StudioLayoutMode, VideoTimelineData, WorkspaceFileType, getActiveUserName } from '../canvas-types';
import { KanbanBoardPrimitive } from '../primitives/KanbanBoardPrimitive';
import { MarkdownDocumentPrimitive } from '../primitives/MarkdownDocumentPrimitive';
import { NodeGraphPrimitive } from '../primitives/NodeGraphPrimitive';
import { Scene3DPrimitive } from '../primitives/Scene3DPrimitive';
import { ChatState, ChatStore } from '../state/chatStore';
import { LIVE_CODE_STARTER_APP } from '../studio/liveCodeStarterTemplate';
import { canCreateInLayoutMode, canShowPrimitive } from '../../../common/product-scope';
import { postScopeNote } from '../chat/scopeNote';

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

    const handleFileClick = async (filePath: string, fileName: string) => {
        // The file's own contents from disk, or the reason they could not be read: nothing stands in for them.
        let realContent: string | null = null;
        let readError = '';
        try {
            const rootParam = activeWorkspace.path ? `&root=${encodeURIComponent(activeWorkspace.path)}` : '';
            const res = await fetch(`/workspace/file-content?path=${encodeURIComponent(filePath)}${rootParam}`);
            const data = res.ok ? await res.json().catch(() => null) : null;
            if (data?.success && typeof data.content === 'string') {
                realContent = data.content;
            } else {
                readError = data?.error || (res.ok ? 'the server sent no file contents' : `HTTP ${res.status}`);
            }
        } catch (err: any) {
            readError = err?.message || String(err);
        }
        if (realContent === null) {
            showToast(`Could not open ${fileName}: ${readError}`, '⚠️');
            return;
        }

        const opened = artifactForOpenedFile(filePath, fileName, realContent, activeArtifact);
        if (!canShowPrimitive(opened.artifact.type)) {
            postScopeNote(setMessages, `${fileName} would open as a ${opened.artifact.type}, which this 3D and VFX build does not show.`);
            return;
        }
        setLayoutMode(opened.layoutMode);
        const updatedArtifact = opened.artifact;
        setActiveArtifact(updatedArtifact);
        setArtifactHistory(prev => {
            const filtered = prev.filter(a => a.id !== updatedArtifact.id);
            return [updatedArtifact, ...filtered];
        });
        setSessions(prev => prev.map(s => s.id === currentSessionId ? { ...s, activeArtifact: updatedArtifact } : s));

        showToast(`Loaded "${fileName}" in ${opened.layoutMode === 'code' ? 'Code Sandbox' : opened.layoutMode + ' view'}`);
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

/** A JSON object parsed from a file's text, or undefined when the text is not one. */
function jsonObjectOf(text: string): Record<string, any> | undefined {
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * The canvas artifact a file opened from the explorer shows, built from the file's contents only. A Markdown file is
 * a document; a .json, .automation or .3d file whose JSON is a kanban board, node graph or 3D scene opens as that
 * primitive; anything else opens as text in the code sandbox. Nothing is added that the file does not hold: no
 * template cards, nodes, meshes, sky, tags or placeholder content (a file that cannot be read is not opened).
 */
export function artifactForOpenedFile(
    filePath: string,
    fileName: string,
    content: string,
    activeArtifact?: CanvasArtifact | null,
    now: number = Date.now()
): { layoutMode: StudioLayoutMode; artifact: CanvasArtifact } {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    const createdAt = new Date(now).toLocaleTimeString();
    const json = ['json', 'automation', '3d'].includes(ext) ? jsonObjectOf(content) : undefined;

    if (ext === 'md') {
        const sections = content.split('\n\n').map((para, idx) => {
            if (para.startsWith('# ')) {
                return { id: `sec-${idx}`, type: 'heading' as const, level: 1 as const, content: para.replace(/^#+\s*/, '') };
            } else if (para.startsWith('## ') || para.startsWith('### ')) {
                return { id: `sec-${idx}`, type: 'heading' as const, level: 2 as const, content: para.replace(/^#+\s*/, '') };
            } else if (para.startsWith('- [ ] ') || para.startsWith('- [x] ')) {
                const done = para.startsWith('- [x] ');
                const text = para.replace(/- \[[x ]\] /, '');
                return { id: `sec-${idx}`, type: 'checklist' as const, checklistItems: [{ id: `item-${idx}`, text, done }] };
            }
            return { id: `sec-${idx}`, type: 'paragraph' as const, content: para };
        });
        const docData: MarkdownDocumentData = {
            title: fileName,
            subtitle: filePath,
            author: getActiveUserName(),
            lastUpdated: 'Just now',
            tags: [],
            sections: sections.length > 0 ? sections : [{ id: 'sec-1', type: 'paragraph', content }]
        };
        return {
            layoutMode: 'document',
            artifact: { id: `art-doc-${now}`, type: 'markdown-document', title: fileName, summary: filePath, version: 1, createdAt, data: docData }
        };
    }
    if (json && Array.isArray(json.columns)) {
        return {
            layoutMode: 'kanban',
            artifact: { id: `art-kanban-${now}`, type: 'kanban-board', title: json.title || fileName, summary: filePath, version: 1, createdAt, data: { title: fileName, ...json } as KanbanBoardData }
        };
    }
    if (json && Array.isArray(json.nodes)) {
        return {
            layoutMode: 'automation',
            artifact: { id: `art-graph-${now}`, type: 'node-graph', title: json.title || fileName, summary: filePath, version: 1, createdAt, data: { title: fileName, edges: [], ...json, nodes: json.nodes } as NodeGraphData }
        };
    }
    if (json && ext === '3d') {
        return {
            layoutMode: '3d',
            artifact: { id: `art-3d-${now}`, type: '3d-scene', title: json.title || fileName, summary: filePath, version: 1, createdAt, data: { title: fileName, ...json } as Scene3DData }
        };
    }

    // Text in the code sandbox: added as a tab to the open sandbox, or a new sandbox holding only this file.
    const open = activeArtifact?.type === 'live-code-sandbox' ? activeArtifact : undefined;
    const sandbox: LiveCodeSandboxData = open
        ? { ...(open.data as LiveCodeSandboxData), files: [...((open.data as LiveCodeSandboxData).files || [])] }
        : { title: fileName, template: 'react', files: [], viewportMode: 'desktop' };
    const existing = sandbox.files.findIndex(f => f.path === filePath || f.name === fileName);
    let fileId = `file-${fileName.replace(/[^a-zA-Z0-9]/g, '-')}`;
    if (existing >= 0) {
        fileId = sandbox.files[existing].id;
        sandbox.files[existing] = { ...sandbox.files[existing], content };
    } else {
        sandbox.files.push({
            id: fileId,
            name: fileName,
            language: ext === 'tsx' ? 'react' : ext === 'ts' ? 'typescript' : ext === 'css' ? 'css' : ext === 'json' ? 'json' : 'javascript',
            content,
            path: filePath,
            isEntry: sandbox.files.length === 0
        } as CodeFileTab);
    }
    sandbox.activeFileId = fileId;
    return {
        layoutMode: 'code',
        artifact: {
            id: open?.id || `art-sandbox-${now}`,
            type: 'live-code-sandbox',
            title: fileName,
            summary: `Editing ${fileName}`,
            version: (open?.version || 0) + 1,
            createdAt,
            data: sandbox
        }
    };
}

/** Creates a new workspace file of the given type as a fresh canvas + chat session. */
/**
 * The scene a new "4D Scene" workspace (or an empty 3D canvas) opens with: empty, in the neutral studio, so the
 * viewport says "No geometry" until the user or the model adds something. It used to hold `internal:grid` and
 * `internal:sunlight` objects that draw nothing, a cyberpunk sky and a summary describing wave solvers and a WASM heap
 * the scene does not have.
 */
export function newEmptySceneArtifact(now: number = Date.now(), title: string = '4D Scene'): CanvasArtifact {
    return {
        id: `art-3d-${now}`,
        type: '3d-scene',
        title,
        summary: '',
        data: {
            title,
            objects: [],
            environment: { skybox: 'studio', lighting: 'studio', ground: false }
        } as Scene3DData,
        createdAt: new Date(now).toLocaleTimeString(),
        version: 1
    };
}

export function useWorkspaceFileCreation(deps: UseWorkspaceFilesDeps) {
    const { activeArtifact, activeWorkspace, artifactHistory, layoutMode, messages, setActiveArtifact, setArtifactHistory, setCurrentSessionId, setLayoutMode, setMessages, setSessions, showToast } = deps;

    const handleCreateWorkspaceFile = (type: WorkspaceFileType) => {
        if (!canCreateInLayoutMode(type)) {
            postScopeNote(setMessages, 'This build of Scratchbox is limited to 3D and VFX projects: new files are chats, 3D scenes and video timelines.');
            return;
        }
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
                            content: LIVE_CODE_STARTER_APP,
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
            // A new document is empty: the user (or the model) writes it. No sample document is filled in.
            const emptyDoc: MarkdownDocumentData = { title: 'Untitled document', lastUpdated: 'Just now', sections: [] };
            const docArtifact: CanvasArtifact = {
                id: `art-doc-${Date.now()}`,
                type: 'markdown-document',
                title: emptyDoc.title,
                summary: '',
                data: emptyDoc,
                version: 1,
                createdAt: 'Just now'
            };
            newSession = {
                id: newSessionId,
                title: emptyDoc.title,
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
            const activeArt = newEmptySceneArtifact();
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
                    consoleLogs: [],
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
        } else if (type === 'video') {
            const activeArt: CanvasArtifact = {
                id: `art-video-${Date.now()}`,
                type: 'video-timeline',
                title: 'Cyberpunk 2088 Motion Teaser',
                summary: 'Multi-track non-linear video editing timeline with real-time WebGL compositor, color wheels & scopes.',
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
                } as VideoTimelineData,
                createdAt: new Date().toLocaleTimeString(),
                version: 1
            };
            newSession = {
                id: newSessionId,
                title: 'Cyberpunk 2088 Motion Teaser',
                fileType: 'video',
                layoutMode: 'video',
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
