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
import {
    auditCameraFraming,
    isVisualAuditUnavailable,
    type VisualAuditResult,
    type VisualAuditUnavailable,
    type VisualVerificationOutcome,
    type VisualVerificationRequest
} from '../../../common/visual-verification-protocol';
import { ProjectItem } from '../ProjectsModal';
import { CanvasArtifact, ChatSession, LiveCodeSandboxData, Scene3DData } from '../canvas-types';
import { captureActiveCanvasPixels } from '../chat/streaming-utils';
import { PRELOADED_SHOWCASE_DEMOS } from '../demos/preloadedDemos';
import { GeminiClient } from '../gemini-client';
import { artifactVersionKey, chatArtifactVersionKeys } from '../state/chat-activity';
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

/**
 * Whether the background audit may screenshot this artifact now. Never while a reply is still
 * generating: a repair version written mid-stream is buried when the stream-end commit
 * re-activates the version it streamed, leaving that one marked historical.
 */
export function shouldAuditArtifactInBackground(artifact: CanvasArtifact | null | undefined, isGenerating: boolean): artifact is CanvasArtifact {
    if (!artifact || isGenerating) return false;
    if (isCuratedShowcaseArtifact(artifact)) return false;
    return artifact.type === '3d-scene' || artifact.type === 'live-code-sandbox' || artifact.type === 'interactive-browser';
}

/**
 * The data a background audit may write back, or null when it may write nothing. A 3D scene's
 * sky, atmosphere, lighting, render mode, ground and world are its own choices, so the audit keeps
 * at most a camera framing, and only when it reported a framing defect (`defects3D`) on a scene whose
 * geometry is all in customMeshes, the bounds that framing is computed from. A sandbox takes CSS fixes.
 */
export function backgroundAuditRepairData(artifact: CanvasArtifact, audit: VisualAuditResult): CanvasArtifact['data'] | null {
    if (artifact.type === '3d-scene') {
        const scene = (artifact.data || {}) as Scene3DData;
        const framing = auditCameraFraming(audit, scene);
        if (!framing) return null;
        const camera = { ...(scene.camera || { position: [15, 12, 15] as [number, number, number], target: [0, 0, 0] as [number, number, number] }), ...framing };
        if (JSON.stringify(camera) === JSON.stringify(scene.camera)) return null;
        return { ...scene, camera };
    }
    if (artifact.type === 'live-code-sandbox') {
        const cssFixes = audit.visualFixes?.cssFixes;
        const sandbox = artifact.data as LiveCodeSandboxData;
        const files = Array.isArray(sandbox?.files) ? sandbox.files : [];
        const cssIndex = files.findIndex(f => f.name?.endsWith('.css') || f.path?.endsWith('.css'));
        if (!cssFixes || cssIndex === -1) return null;
        return {
            ...sandbox,
            files: files.map((f, i) => i === cssIndex ? { ...f, content: `${f.content}\n/* Visual Auto-Repair Fixes */\n${cssFixes}` } : f)
        };
    }
    return null;
}

/**
 * The version a failing background audit writes, or null. Each version is repaired at most once,
 * and a version the repair wrote is never repaired again, so audits cannot chain new versions.
 * `repairWritten` holds the keys of versions this loop wrote (the caller adds the registered one too).
 */
export function backgroundAuditRepair(artifact: CanvasArtifact, audit: VisualAuditResult, repairWritten: Set<string>): CanvasArtifact | null {
    if (audit.fidelityScore >= 80 || !audit.visualFixes || repairWritten.has(artifactVersionKey(artifact))) return null;
    const data = backgroundAuditRepairData(artifact, audit);
    if (!data) return null;
    const repaired: CanvasArtifact = { ...artifact, version: (artifact.version || 1) + 1, data };
    if (repairWritten.has(artifactVersionKey(repaired))) return null;
    repairWritten.add(artifactVersionKey(repaired));
    return repaired;
}

/**
 * One background visual check of `artifact`: capture the canvas, have the vision model inspect it, and decide the
 * repair. The outcome is what the chat shows. When there is no frame or the check is unavailable (no credentials,
 * the model failed, no score), the outcome says why and nothing is repaired.
 */
export async function runBackgroundVisualCheck(
    artifact: CanvasArtifact,
    capture: () => string | null | Promise<string | null>,
    verify: (request: VisualVerificationRequest) => Promise<VisualVerificationOutcome>,
    repairWritten: Set<string>
): Promise<{ outcome: VisualVerificationOutcome; repaired: CanvasArtifact | null }> {
    const unavailable = (error: string): VisualAuditUnavailable => ({
        status: 'unavailable',
        error,
        targetArtifactId: artifact.id,
        timestamp: new Date().toLocaleTimeString()
    });
    const frame = await capture();
    if (!frame) {
        return { outcome: unavailable('No frame of the canvas could be captured.'), repaired: null };
    }
    let outcome: VisualVerificationOutcome;
    try {
        outcome = await verify({
            image: frame,
            prompt: artifact.title || 'Interactive 3D Spatial Canvas or UI Sandbox',
            artifactType: artifact.type,
            context: {
                artifactId: artifact.id,
                title: artifact.title,
                sceneData: artifact.type === '3d-scene' ? (artifact.data as any) : undefined
            }
        });
    } catch (err) {
        return { outcome: unavailable(err instanceof Error ? err.message : String(err)), repaired: null };
    }
    if (isVisualAuditUnavailable(outcome)) {
        return { outcome, repaired: null };
    }
    // A failing score (< 80) applies what the audit may change; no new version when that is nothing.
    return { outcome, repaired: backgroundAuditRepair(artifact, outcome, repairWritten) };
}

export interface UseArtifactSyncDeps {
    activeArtifact: ChatState['activeArtifact'];
    activeWorkspace: ProjectItem;
    artifactHistory: ChatState['artifactHistory'];
    /** Bumped each time a saved chat is opened (GenerativeCanvasStudio). */
    chatOpenCountRef: React.MutableRefObject<number>;
    currentSessionId: ChatState['currentSessionId'];
    graphControllerRef: WorkspaceGraphCoordinator['graphControllerRef'];
    isGenerating: boolean;
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
    const { activeArtifact, activeWorkspace, artifactHistory, chatOpenCountRef, currentSessionId, graphControllerRef, isGenerating, layoutMode, lensControllerRef, messages, persistSessionsImmediately, recordArtifactVersion, setActiveArtifact, setArtifactHistory, setGraphEpoch, setMessages, setSessions } = deps;

    /**
     * An artifact edited on its surface: saved, versioned and written through its lens. It becomes the main view, first in
     * the history, unless `keepStage` (a surface beside the main stage, the docked frame): then it is replaced where it is.
     */
    const handleUpdateArtifact = React.useCallback((updatedArtifact: CanvasArtifact, opts?: { keepStage?: boolean }) => {
        const canonicalArtifact = graphControllerRef.current.registerArtifact(
            updatedArtifact,
            `studio-update-${updatedArtifact.id}-${updatedArtifact.version}`
        );
        setGraphEpoch(epoch => epoch + 1);
        if (opts?.keepStage) setActiveArtifact(prev => (prev?.id === canonicalArtifact.id ? canonicalArtifact : prev));
        else setActiveArtifact(canonicalArtifact);
        recordArtifactVersion(canonicalArtifact);
        setArtifactHistory(prev => opts?.keepStage && prev.some(a => a.id === updatedArtifact.id)
            ? prev.map(a => (a.id === updatedArtifact.id ? canonicalArtifact : a))
            : [canonicalArtifact, ...prev.filter(a => a.id !== updatedArtifact.id && a.id !== canonicalArtifact.id)]);

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

            // single-file lenses write to the first path they are given (else one shared default such as
            // workflow.json), so each artifact is handed its own bound file; a sandbox's binding is a folder
            const unprojected = controller.unprojectUiChanges(
                canonicalArtifact.id,
                canonicalArtifact.data,
                canonicalArtifact.type === 'live-code-sandbox' ? {} : { [binding.primaryFilePath]: '' }
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
                        const keep = opts?.keepStage && s.artifactHistory?.some(a => a.id === updatedArtifact.id);
                        return {
                            ...s,
                            activeArtifact: opts?.keepStage && s.activeArtifact?.id !== canonicalArtifact.id ? s.activeArtifact : canonicalArtifact,
                            artifactHistory: keep
                                ? s.artifactHistory!.map(a => (a.id === updatedArtifact.id ? canonicalArtifact : a))
                                : s.artifactHistory
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
                            updatedAt: new Date().toISOString()
                        };
                    }
                    return s;
                });
                persistSessionsImmediately(next);
                return next;
            });
        }
        return canonicalArtifact;
    }, [currentSessionId, persistSessionsImmediately]);

    // Track verified artifact keys (id + version) to avoid redundant loops
    const verifiedArtifactKeysRef = React.useRef<Set<string>>(new Set());
    // Versions the background repair wrote: never audited or repaired again, so repairs cannot chain
    const repairWrittenKeysRef = React.useRef<Set<string>>(new Set());
    const isVerifyingVisualRef = React.useRef<boolean>(false);

    // A chat opened to look at it is not checked again (each check is a paid vision call): the versions it holds when
    // opened count as checked, so only versions made or edited while it is open are audited. Runs before the audit below.
    const openedRef = React.useRef<{ id?: string; opens: number }>({ opens: -1 });
    React.useEffect(() => {
        const opens = chatOpenCountRef.current;
        if (openedRef.current.id === currentSessionId && openedRef.current.opens === opens) return;
        openedRef.current = { id: currentSessionId, opens };
        for (const key of chatArtifactVersionKeys(messages, activeArtifact, artifactHistory)) verifiedArtifactKeysRef.current.add(key);
    }, [currentSessionId, messages, activeArtifact, artifactHistory, chatOpenCountRef]);

    // Automated Background Visual Verification & Self-Correction Loop
    React.useEffect(() => {
        if (!shouldAuditArtifactInBackground(activeArtifact, isGenerating)) return;

        const artifactKey = artifactVersionKey(activeArtifact);
        if (verifiedArtifactKeysRef.current.has(artifactKey) || repairWrittenKeysRef.current.has(artifactKey)) {
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
                const client = GeminiClient.getInstance();
                const { outcome, repaired } = await runBackgroundVisualCheck(
                    activeArtifact,
                    () => captureActiveCanvasPixels(layoutMode),
                    request => client.verifyVisual(request),
                    repairWrittenKeysRef.current
                );
                if (cancelled) {
                    return;
                }

                // The latest assistant message shows the result, including "Visual check unavailable: <why>".
                setMessages(prev => {
                    const lastIdx = prev.length - 1;
                    if (lastIdx >= 0 && prev[lastIdx].sender === 'assistant') {
                        const updated = [...prev];
                        updated[lastIdx] = {
                            ...updated[lastIdx],
                            visualAudit: outcome
                        };
                        return updated;
                    }
                    return prev;
                });

                if (repaired) {
                    // Registration can rename a timestamped id, so remember the version as it lands too.
                    repairWrittenKeysRef.current.add(artifactVersionKey(handleUpdateArtifact(repaired)));
                }
            } catch (err) {
                console.error('[useArtifactSync] Background visual check could not be recorded:', err);
            } finally {
                isVerifyingVisualRef.current = false;
            }
        }, 700);

        return () => {
            cancelled = true;
            clearTimeout(settleTimer);
        };
    }, [activeArtifact, isGenerating, layoutMode, handleUpdateArtifact]);

    return { handleUpdateArtifact };
}
