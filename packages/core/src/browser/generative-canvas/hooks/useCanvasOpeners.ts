/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * useCanvasOpeners
 *
 * Opens URLs in the in-app browser primitive, previews code snippets in a sandbox canvas and applies primitive morphs.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { stableProjectArtifactId } from '../../../common/project-artifact-graph-protocol';
import { ProjectItem } from '../ProjectsModal';
import { CanvasArtifact, ChatSession, InteractiveBrowserData, LiveCodeSandboxData, SandboxLanguage, SandboxTemplate, StageLayoutMode, WorkspaceFileType } from '../canvas-types';
import { resolveModeForArtifact } from '../guardrails-service';
import { primitiveOutOfScopeReason } from '../../../common/product-scope';
import { ChatState, ChatStore } from '../state/chatStore';
import { WorkspaceGraphCoordinator } from '../studio/useWorkspaceGraphCoordinator';
import { artifactOnStage, upsertArtifact } from '../tool-node-runs';

export interface UseCanvasOpenersDeps {
    activeArtifact: ChatState['activeArtifact'];
    activeWorkspace: ProjectItem;
    artifactHistory: ChatState['artifactHistory'];
    currentSessionId: ChatState['currentSessionId'];
    graphControllerRef: WorkspaceGraphCoordinator['graphControllerRef'];
    layoutMode: ChatState['layoutMode'];
    persistSessionsImmediately: (sessions: ChatSession[]) => void;
    recordArtifactVersion: (art: CanvasArtifact) => void;
    setActiveArtifact: ChatStore['setActiveArtifact'];
    setArtifactHistory: ChatStore['setArtifactHistory'];
    setGraphEpoch: WorkspaceGraphCoordinator['setGraphEpoch'];
    setLayoutMode: ChatStore['setLayoutMode'];
    setSessions: ChatStore['setSessions'];
    showToast: (text: string, icon?: string) => void;
    stageLayoutMode: StageLayoutMode;
}

export function useCanvasOpeners(deps: UseCanvasOpenersDeps) {
    const { activeArtifact, activeWorkspace, artifactHistory, currentSessionId, graphControllerRef, layoutMode, persistSessionsImmediately, recordArtifactVersion, setActiveArtifact, setArtifactHistory, setGraphEpoch, setLayoutMode, setSessions, showToast, stageLayoutMode } = deps;

    const handleOpenInAppBrowser = React.useCallback((targetUrl: string, targetTitle?: string) => {
        if (!targetUrl || targetUrl === '#') return;

        let normalizedUrl = targetUrl.trim();
        if (!/^https?:\/\//i.test(normalizedUrl) && !normalizedUrl.startsWith('localhost:') && !normalizedUrl.startsWith('127.0.0.1:')) {
            normalizedUrl = `https://${normalizedUrl}`;
        }

        const cleanDomain = normalizedUrl.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
        const displayTitle = targetTitle || cleanDomain || 'Live Web Page';
        const sourceArtifact = activeArtifact;

        const isCurrentBrowser = activeArtifact?.type === 'interactive-browser' || activeArtifact?.type === 'browser';
        const reusableBrowser = graphControllerRef.current.findBrowserByUrl(normalizedUrl);
        const existingBrowser = reusableBrowser || (isCurrentBrowser ? activeArtifact : undefined);
        const browserId = existingBrowser?.id || stableProjectArtifactId('interactive-browser', `${activeWorkspace.id}:${normalizedUrl}`);

        const existingBrowserData = existingBrowser?.data as InteractiveBrowserData | undefined;
        const historyList = existingBrowserData?.history ? [...existingBrowserData.history, normalizedUrl] : [normalizedUrl];

        const browserData: InteractiveBrowserData = {
            url: normalizedUrl,
            title: displayTitle,
            viewportMode: existingBrowserData?.viewportMode || 'desktop',
            history: historyList,
            historyIndex: historyList.length - 1,
            isLoading: false,
            consoleLogs: [
                ...(existingBrowserData?.consoleLogs || []),
                { type: 'info', text: `Navigated to ${normalizedUrl}`, timestamp: new Date().toLocaleTimeString() },
                { type: 'log', text: `Loaded source "${displayTitle}" via in-app browser canvas proxy.`, timestamp: new Date().toLocaleTimeString() }
            ],
            inspectMode: false,
            deviceScale: existingBrowserData?.deviceScale || 1
        };

        const browserArtifact: CanvasArtifact = {
            id: browserId,
            type: 'interactive-browser',
            title: displayTitle,
            summary: `Live Web Page: ${normalizedUrl}`,
            data: browserData,
            createdAt: existingBrowser?.createdAt || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            version: (existingBrowser?.version || 0) + 1
        };
        const correlationId = `open-browser-${browserId}-${browserArtifact.version}`;
        const canonicalSource = sourceArtifact && sourceArtifact.id !== browserId
            ? graphControllerRef.current.registerArtifact(sourceArtifact, correlationId)
            : undefined;
        const canonicalBrowser = graphControllerRef.current.registerArtifact(browserArtifact, correlationId);
        if (canonicalSource?.graphRef && canonicalBrowser.graphRef) {
            const relation = canonicalSource.type === 'markdown-document'
                ? 'cites'
                : canonicalSource.type === 'live-code-sandbox' ? 'previews' : 'references';
            graphControllerRef.current.link(relation, canonicalSource.graphRef, canonicalBrowser.graphRef, correlationId);
        }
        setGraphEpoch(epoch => epoch + 1);

        setActiveArtifact(canonicalBrowser);
        setArtifactHistory(prev => {
            const filtered = prev.filter(a => a.id !== canonicalBrowser.id);
            return [canonicalBrowser, ...filtered];
        });

        // Switch layoutMode to 'browser' if not in multi-pane bento view
        if (stageLayoutMode === 'single') {
            setLayoutMode('browser');
        }

        // Update active session metadata
        setSessions(prev => prev.map(s => {
            if (s.id === currentSessionId) {
                return {
                    ...s,
                    layoutMode: stageLayoutMode === 'single' ? 'browser' : s.layoutMode,
                    activeArtifact: canonicalBrowser,
                    artifactHistory: [canonicalBrowser, ...(s.artifactHistory || []).filter(a => a.id !== canonicalBrowser.id)]
                };
            }
            return s;
        }));

        showToast(`Opening ${displayTitle} in In-App Web Browser`, '🌐');
    }, [activeArtifact, activeWorkspace.id, stageLayoutMode, currentSessionId, showToast]);

    const handlePreviewCodeInCanvas = React.useCallback((language: string, content: string) => {
        const outOfScope = primitiveOutOfScopeReason('live-code-sandbox');
        if (outOfScope) {
            showToast(outOfScope, '⚠️');
            return;
        }
        const lang = (language || '').toLowerCase();
        let template: SandboxTemplate = 'react';
        let fileName = 'App.tsx';
        let fileLang: SandboxLanguage = 'typescript';

        if (['html', 'htm'].includes(lang) || /<!DOCTYPE\s+html|<html/i.test(content)) {
            template = 'vanilla-html';
            fileName = 'index.html';
            fileLang = 'html';
        } else if (['python', 'py'].includes(lang)) {
            template = 'python';
            fileName = 'main.py';
            fileLang = 'python';
        } else if (['svg'].includes(lang) || /<svg/i.test(content)) {
            template = 'vanilla-html';
            fileName = 'index.html';
            fileLang = 'html';
            content = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>SVG Preview</title>
  <style>
    body { margin: 0; padding: 24px; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #0b0f19; }
    svg { max-width: 90vw; max-height: 90vh; }
  </style>
</head>
<body>
${content}
</body>
</html>`;
        }

        const sandboxData: LiveCodeSandboxData = {
            title: `${fileName} Live Preview`,
            subtitle: `Live interactive preview of ${language.toUpperCase()} code`,
            template,
            activeFileId: fileName,
            viewMode: 'preview',
            viewportMode: 'desktop',
            autoRun: true,
            files: [
                {
                    id: fileName,
                    name: fileName,
                    language: fileLang,
                    content,
                    isEntry: true
                }
            ]
        };

        const newArtifact: CanvasArtifact = {
            id: `art-sandbox-${Date.now()}`,
            type: 'live-code-sandbox',
            title: `${fileName} Live Preview`,
            summary: `Interactive preview of ${fileName}`,
            version: 1,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            data: sandboxData
        };

        setActiveArtifact(newArtifact);
        setArtifactHistory(prev => {
            const filtered = prev.filter(a => a.id !== newArtifact.id);
            return [newArtifact, ...filtered];
        });
        setLayoutMode('code');
        showToast(`Previewing ${fileName} live in Canvas`, '⚡');
    }, [showToast]);

    const handleMorphArtifact = React.useCallback((morphedArtifact: CanvasArtifact) => {
        const outOfScope = primitiveOutOfScopeReason(morphedArtifact.type);
        if (outOfScope) {
            showToast(outOfScope, '⚠️');
            return;
        }
        const correlationId = `morph-${activeArtifact?.id || 'unknown'}-${morphedArtifact.id}`;
        const source = activeArtifact
            ? graphControllerRef.current.registerArtifact(activeArtifact, correlationId)
            : undefined;
        const canonicalArtifact = graphControllerRef.current.registerArtifact(
            morphedArtifact,
            correlationId,
            source?.graphRef
        );
        setGraphEpoch(epoch => epoch + 1);
        setActiveArtifact(canonicalArtifact);
        recordArtifactVersion(canonicalArtifact);
        setArtifactHistory(prev => [canonicalArtifact, ...prev.filter(a => a.id !== canonicalArtifact.id)]);
        const targetMode = resolveModeForArtifact(canonicalArtifact.type);
        setLayoutMode(targetMode);

        if (currentSessionId) {
            setSessions(prev => {
                const next = prev.map(s => {
                    if (s.id === currentSessionId) {
                        return {
                            ...s,
                            activeArtifact: canonicalArtifact,
                            layoutMode: targetMode,
                            fileType: (targetMode === 'code' ? 'code' : targetMode === 'document' ? 'document' : targetMode === 'kanban' ? 'kanban' : targetMode === 'automation' ? 'automation' : 'chat') as WorkspaceFileType,
                            artifactHistory: s.artifactHistory
                                ? [canonicalArtifact, ...s.artifactHistory.filter(a => a.id !== canonicalArtifact.id)]
                                : [canonicalArtifact],
                            updatedAt: 'Just now'
                        };
                    }
                    return s;
                });
                persistSessionsImmediately(next);
                return next;
            });
        }
        showToast(`Morphed to ${canonicalArtifact.title}`);
    }, [activeArtifact, currentSessionId, persistSessionsImmediately]);

    const applyStreamedArtifact = React.useCallback((art: CanvasArtifact) => {
        // replaced in place (a canvas tab keeps its position), added when new; the stage changes only if it shows this artifact
        const upsert = (list?: CanvasArtifact[]) => upsertArtifact(list, art);
        setArtifactHistory(prev => upsert(prev));
        if (artifactOnStage(activeArtifact, art) !== activeArtifact) setActiveArtifact(art);
        if (currentSessionId) {
            setSessions(prev => prev.map(s => s.id !== currentSessionId ? s : {
                ...s,
                artifactHistory: upsert(s.artifactHistory),
                ...(s.activeArtifact?.id === art.id ? { activeArtifact: art } : {}),
                updatedAt: 'Just now'
            }));
        }
    }, [activeArtifact, currentSessionId]);

    return { handleMorphArtifact, handleOpenInAppBrowser, handlePreviewCodeInCanvas, applyStreamedArtifact };
}
