/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * useArtifactSync
 *
 * Applies artifact updates to the chat store / project graph / codebase lenses and runs the background visual-verification self-correction loop.
 *
 * Extracted verbatim from GenerativeCanvasStudio.tsx.
 */
import * as React from 'react';
import { ProjectItem } from '../ProjectsModal';
import { CanvasArtifact, ChatSession } from '../canvas-types';
import { captureActiveCanvasScreenshot } from '../chat/streaming-utils';
import { PRELOADED_SHOWCASE_DEMOS } from '../demos/preloadedDemos';
import { GeminiClient } from '../gemini-client';
import { ChatState, ChatStore } from '../state/chatStore';
import { WorkspaceGraphCoordinator } from '../studio/useWorkspaceGraphCoordinator';
import { WorkspaceConfigClient } from '../workspace-config-client';

/**
 * Curated showcase demo artifacts are authored deliberately (camera framing, studio
 * environment, render mode) and are exempt from background visual auto-repair, which
 * screenshots before large GLBs finish loading and would rewrite them with uninvited
 * sky / atmosphere / camera patches. The exemption is keyed on id AND the curated version:
 * in-place viewport edits (selection / gizmo round-trips) keep both, while AI follow-ups reuse
 * the id but bump the version, so those generations are still verified.
 */
const PRELOADED_SHOWCASE_ARTIFACT_VERSIONS: ReadonlyMap<string, number> = new Map(
    PRELOADED_SHOWCASE_DEMOS.map(demo => [demo.artifact.id, demo.artifact.version || 1] as const)
);

function isCuratedShowcaseArtifact(artifact: { id: string; version?: number }): boolean {
    const curatedVersion = PRELOADED_SHOWCASE_ARTIFACT_VERSIONS.get(artifact.id);
    return curatedVersion !== undefined && (artifact.version || 1) === curatedVersion;
}

export interface UseArtifactSyncDeps {
    activeArtifact: ChatState['activeArtifact'];
    activeWorkspace: ProjectItem;
    artifactHistory: ChatState['artifactHistory'];
    currentSessionId: ChatState['currentSessionId'];
    graphControllerRef: WorkspaceGraphCoordinator['graphControllerRef'];
    layoutMode: ChatState['layoutMode'];
    lensControllerRef: WorkspaceGraphCoordinator['lensControllerRef'];
    messages: ChatState['messages'];
    persistSessionsImmediately: (sessions: ChatSession[]) => void;
    recordArtifactVersion: (art: CanvasArtifact) => void;
    setActiveArtifact: ChatStore['setActiveArtifact'];
    setArtifactHistory: ChatStore['setArtifactHistory'];
    setGraphEpoch: WorkspaceGraphCoordinator['setGraphEpoch'];
    setMessages: ChatStore['setMessages'];
    setSessions: ChatStore['setSessions'];
}

export function useArtifactSync(deps: UseArtifactSyncDeps) {
    const { activeArtifact, activeWorkspace, artifactHistory, currentSessionId, graphControllerRef, layoutMode, lensControllerRef, messages, persistSessionsImmediately, recordArtifactVersion, setActiveArtifact, setArtifactHistory, setGraphEpoch, setMessages, setSessions } = deps;

    const handleUpdateArtifact = React.useCallback((updatedArtifact: CanvasArtifact) => {
        const canonicalArtifact = graphControllerRef.current.registerArtifact(
            updatedArtifact,
            `studio-update-${updatedArtifact.id}-${updatedArtifact.version}`
        );
        setGraphEpoch(epoch => epoch + 1);
        setActiveArtifact(canonicalArtifact);
        recordArtifactVersion(canonicalArtifact);
        setArtifactHistory(prev => [
            canonicalArtifact,
            ...prev.filter(a => a.id !== updatedArtifact.id && a.id !== canonicalArtifact.id)
        ]);

        // Bi-directional lens unprojection to workspace disk
        try {
            const controller = lensControllerRef.current;
            let binding = controller.getBinding(canonicalArtifact.id);
            if (!binding) {
                let defaultPath = `docs/${canonicalArtifact.id}.md`;
                if (canonicalArtifact.type === 'live-code-sandbox') defaultPath = 'src/components';
                else if (canonicalArtifact.type === 'kanban-board') defaultPath = 'ROADMAP.md';
                else if (canonicalArtifact.type === 'node-graph') defaultPath = `workflows/${canonicalArtifact.id}.workflow.json`;
                else if (canonicalArtifact.type === '3d-scene') defaultPath = `scenes/${canonicalArtifact.id}.scene.json`;

                binding = controller.createBinding({
                    artifactId: canonicalArtifact.id,
                    lensType: canonicalArtifact.type,
                    primaryFilePath: defaultPath,
                    initialContent: typeof canonicalArtifact.data === 'string' ? canonicalArtifact.data : JSON.stringify(canonicalArtifact.data)
                });
            }

            const unprojected = controller.unprojectUiChanges(
                canonicalArtifact.id,
                canonicalArtifact.data,
                {}
            );
            if (unprojected && Object.keys(unprojected.files).length > 0) {
                WorkspaceConfigClient.getInstance().writeLensFiles(unprojected.files, activeWorkspace.path).catch(e =>
                    console.warn('[CodebaseLens] Auto-sync to disk skipped or failed', e)
                );
            }
        } catch (e) {
            console.warn('[CodebaseLens] Error during unprojection', e);
        }

        // Update messages state: update matching version in place without mutating historical snapshots
        setMessages(prev => prev.map(m => {
            if (!m.artifacts || m.artifacts.length === 0) return m;
            const matches = m.artifacts.some(a =>
                (a.id === updatedArtifact.id || a.id === canonicalArtifact.id) &&
                (a.version || 1) === (canonicalArtifact.version || 1)
            );
            if (!matches) return m;
            return {
                ...m,
                artifacts: m.artifacts.map(a =>
                    (a.id === updatedArtifact.id || a.id === canonicalArtifact.id) &&
                    (a.version || 1) === (canonicalArtifact.version || 1)
                        ? canonicalArtifact
                        : a
                ),
                artifactRefs: [canonicalArtifact.graphRef!]
            };
        }));

        if (currentSessionId) {
            setSessions(prev => {
                const next = prev.map(s => {
                    if (s.id === currentSessionId) {
                        return {
                            ...s,
                            activeArtifact: canonicalArtifact,
                            artifactHistory: s.artifactHistory
                                ? [canonicalArtifact, ...s.artifactHistory.filter(a => a.id !== updatedArtifact.id && a.id !== canonicalArtifact.id)]
                                : [canonicalArtifact],
                            messages: s.messages.map(m => {
                                if (!m.artifacts || m.artifacts.length === 0) return m;
                                const matches = m.artifacts.some(a =>
                                    (a.id === updatedArtifact.id || a.id === canonicalArtifact.id) &&
                                    (a.version || 1) === (canonicalArtifact.version || 1)
                                );
                                if (!matches) return m;
                                return {
                                    ...m,
                                    artifacts: m.artifacts.map(a =>
                                        (a.id === updatedArtifact.id || a.id === canonicalArtifact.id) &&
                                        (a.version || 1) === (canonicalArtifact.version || 1)
                                            ? canonicalArtifact
                                            : a
                                    ),
                                    artifactRefs: [canonicalArtifact.graphRef!]
                                };
                            }),
                            updatedAt: 'Just now'
                        };
                    }
                    return s;
                });
                persistSessionsImmediately(next);
                return next;
            });
        }
    }, [currentSessionId, persistSessionsImmediately]);

    // Track verified artifact keys (id + version) to avoid redundant loops
    const verifiedArtifactKeysRef = React.useRef<Set<string>>(new Set());
    const isVerifyingVisualRef = React.useRef<boolean>(false);

    // Automated Background Visual Verification & Self-Correction Loop
    React.useEffect(() => {
        if (!activeArtifact) return;
        if (isCuratedShowcaseArtifact(activeArtifact)) return;
        if (activeArtifact.type !== '3d-scene' && activeArtifact.type !== 'live-code-sandbox' && activeArtifact.type !== 'interactive-browser') {
            return;
        }

        const artifactKey = `${activeArtifact.id}-v${activeArtifact.version || 1}`;
        if (verifiedArtifactKeysRef.current.has(artifactKey)) {
            return;
        }

        let cancelled = false;
        const settleTimer = setTimeout(async () => {
            if (isVerifyingVisualRef.current) return;
            isVerifyingVisualRef.current = true;
            verifiedArtifactKeysRef.current.add(artifactKey);

            try {
                if (activeArtifact.type === '3d-scene') {
                    // Auditing a half-loaded viewport scores low and triggers a needless auto-repair re-render.
                    const pendingLoads = (window as any).__scratchbox_active_3d_scene_pending_loads as (() => number) | undefined;
                    const deadline = Date.now() + 30_000;
                    while (!cancelled && typeof pendingLoads === 'function' && pendingLoads() > 0 && Date.now() < deadline) {
                        await new Promise(resolve => setTimeout(resolve, 250));
                    }
                    await new Promise(resolve => setTimeout(resolve, 300));
                    if (cancelled) return;
                }
                const screenshot = captureActiveCanvasScreenshot(layoutMode);
                const client = GeminiClient.getInstance();

                const audit = await client.verifyVisual({
                    image: screenshot,
                    prompt: activeArtifact.title || 'Interactive 3D Spatial Canvas or UI Sandbox',
                    artifactType: activeArtifact.type,
                    context: {
                        artifactId: activeArtifact.id,
                        title: activeArtifact.title,
                        sceneData: activeArtifact.type === '3d-scene' ? (activeArtifact.data as any) : undefined
                    }
                });
                if (cancelled) {
                    return;
                }

                // Attach audit result to latest assistant message in chat
                setMessages(prev => {
                    const lastIdx = prev.length - 1;
                    if (lastIdx >= 0 && prev[lastIdx].sender === 'assistant') {
                        const updated = [...prev];
                        updated[lastIdx] = {
                            ...updated[lastIdx],
                            visualAudit: audit
                        };
                        return updated;
                    }
                    return prev;
                });

                // If fidelity score is low (< 80) and auto-repair directives exist, automatically apply visual self-correction
                if (audit.visualFixes && audit.fidelityScore < 80) {
                    const fixes = audit.visualFixes;
                    let repairedData: any = { ...activeArtifact.data };

                    if (activeArtifact.type === '3d-scene') {
                        repairedData = {
                            ...repairedData,
                            renderMode: fixes.scenePatches?.renderMode || repairedData.renderMode || 'shaded',
                            environment: {
                                ...(repairedData.environment || {}),
                                ...(fixes.environment || {}),
                                lighting: fixes.environment?.lighting || (fixes.lighting ? 'shaded' : repairedData.environment?.lighting || 'shaded')
                            },
                            camera: {
                                ...(repairedData.camera || { position: [15, 12, 15], target: [0, 0, 0] }),
                                ...(fixes.camera || {})
                            },
                            features: {
                                ...(repairedData.features || {}),
                                ...(fixes.features || {})
                            }
                        };
                        if (fixes.scenePatches) {
                            Object.assign(repairedData, fixes.scenePatches);
                        }
                    } else if (activeArtifact.type === 'live-code-sandbox') {
                        if (fixes.cssFixes && Array.isArray(repairedData.files)) {
                            const cssFile = repairedData.files.find((f: any) => f.name?.endsWith('.css') || f.path?.endsWith('.css'));
                            if (cssFile) {
                                cssFile.content = `${cssFile.content}\n/* Visual Auto-Repair Fixes */\n${fixes.cssFixes}`;
                            }
                        }
                    }

                    const repairedArtifact: CanvasArtifact = {
                        ...activeArtifact,
                        version: (activeArtifact.version || 1) + 1,
                        data: repairedData
                    };

                    handleUpdateArtifact(repairedArtifact);
                }
            } catch (err) {
                console.warn('[GenerativeCanvasStudio] Background visual verification completed with fallback:', err);
            } finally {
                isVerifyingVisualRef.current = false;
            }
        }, 700);

        return () => {
            cancelled = true;
            clearTimeout(settleTimer);
        };
    }, [activeArtifact, layoutMode, handleUpdateArtifact]);

    return { handleUpdateArtifact };
}
