/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import type {
    CanvasArtifact,
    ContextMentionCategory,
    ContextMentionItem,
    McpServerItem,
    ParsedContextMentions,
    Scene3DData,
    VideoTimelineData
} from './canvas-types';

export type {
    ContextMentionCategory,
    ContextMentionItem,
    McpServerItem,
    ParsedContextMentions
};

export const CONTEXT_MENTION_TAGS: ContextMentionCategory[] = [
    'file',
    'files',
    'folder',
    'git',
    'terminal',
    'web',
    'docs',
    'mcp',
    'skill',
    'scene',
    'mesh',
    'camera',
    'timeline'
];

export const CONTEXT_MENTION_METADATA: Record<
    ContextMentionCategory,
    { label: string; icon: string; description: string; placeholder: string }
> = {
    file: {
        label: 'File (@file)',
        icon: '📄',
        description: 'Reference a workspace file (.tsx, .ts, .py, .hpp, .glb)',
        placeholder: 'Search files...'
    },
    files: {
        label: 'Files (@files)',
        icon: '📁',
        description: 'Reference multiple workspace files',
        placeholder: 'Search files...'
    },
    folder: {
        label: 'Folder (@folder)',
        icon: '📂',
        description: 'Reference an entire directory tree',
        placeholder: 'Search directories...'
    },
    git: {
        label: 'Git Status (@git)',
        icon: '🌿',
        description: 'Reference current branch, diffs, or staged commits',
        placeholder: 'Branch, commit, diff...'
    },
    terminal: {
        label: 'Terminal (@terminal)',
        icon: '⚡',
        description: 'Run a command in the workspace sandbox and attach its output',
        placeholder: 'Command to run (e.g. git status)...'
    },
    web: {
        label: 'Live Web (@web)',
        icon: '🌐',
        description: 'Ground this message in a Google Search',
        placeholder: 'Web search topic...'
    },
    docs: {
        label: 'Documentation (@docs)',
        icon: '📚',
        description: 'Search Apple HIG, Gemini API & developer documentation',
        placeholder: 'Search documentation...'
    },
    mcp: {
        label: 'MCP Tool (@mcp)',
        icon: '🔌',
        description: 'Attach Model Context Protocol live tool bridge',
        placeholder: 'Search MCP servers...'
    },
    skill: {
        label: 'Skill (/skill)',
        icon: '✨',
        description: 'Attach domain intelligence capability',
        placeholder: 'Search skills...'
    },
    scene: {
        label: '3D Scene (@scene)',
        icon: '🌐',
        description: 'Reference active 3D scene state, environment, and staged layers',
        placeholder: 'Filter scene state or layers...'
    },
    mesh: {
        label: '3D Mesh (@mesh)',
        icon: '🧊',
        description: 'Reference a specific 3D mesh, object, or staged building layer',
        placeholder: 'Search meshes or objects in scene...'
    },
    camera: {
        label: '3D Camera (@camera)',
        icon: '🎥',
        description: 'Reference active 3D viewport camera pose, FOV, and target',
        placeholder: 'Camera pose or keyframe...'
    },
    timeline: {
        label: 'Timeline (@timeline)',
        icon: '🎬',
        description: 'Reference NLE playhead timecode, tracks, clips, or 3D keyframes',
        placeholder: 'Search tracks, clips, or timecodes...'
    }
};

export interface TriggerMatch {
    type: 'context' | 'skill';
    triggerIndex: number;
    query: string;
    prefix: string;
    suffix: string;
}

/**
 * Finds active trigger (@ or /) in text around the cursor position, supporting multi-word queries.
 */
export function findTriggerMatch(text: string, cursorPosition?: number): TriggerMatch | undefined {
    if (!text || typeof text !== 'string') return undefined;

    const pos = typeof cursorPosition === 'number' ? Math.max(0, Math.min(cursorPosition, text.length)) : text.length;
    const textBefore = text.slice(0, pos);

    // Look backward from cursor to find the last @ or / trigger
    let triggerIndex = -1;
    let triggerChar: '@' | '/' | undefined = undefined;

    for (let i = pos - 1; i >= 0; i--) {
        const char = textBefore[i];
        if (char === '@' || char === '/') {
            if (i === 0 || /\s/.test(textBefore[i - 1])) {
                triggerIndex = i;
                triggerChar = char as '@' | '/';
                break;
            }
        }
    }

    if (triggerIndex === -1 || !triggerChar) {
        return undefined;
    }

    const prefix = text.slice(0, triggerIndex);
    const remainderAfterTrigger = text.slice(triggerIndex + 1);

    let queryLength = pos - (triggerIndex + 1);
    const afterCursor = text.slice(pos);
    const wordContinuation = afterCursor.match(/^[a-zA-Z0-9_\-\./:]*/);
    if (wordContinuation && wordContinuation[0]) {
        queryLength += wordContinuation[0].length;
    }

    const query = remainderAfterTrigger.slice(0, queryLength);
    const suffix = remainderAfterTrigger.slice(queryLength);

    return {
        type: triggerChar === '@' ? 'context' : 'skill',
        triggerIndex,
        query,
        prefix,
        suffix
    };
}

/**
 * Inserts a mention token preserving text before and after the trigger.
 */
export function insertMentionToken(
    originalText: string,
    triggerIndex: number,
    queryLength: number,
    replacementToken: string
): { newText: string; newCursorPosition: number } {
    const prefix = originalText.slice(0, triggerIndex);
    const suffix = originalText.slice(triggerIndex + queryLength);
    const newText = prefix + replacementToken + suffix;
    const newCursorPosition = (prefix + replacementToken).length;
    return {
        newText,
        newCursorPosition
    };
}

/**
 * Cycles keyboard navigation selected index with wrap-around support.
 */
export function cycleSelectedIndex(
    currentIndex: number,
    totalItems: number,
    direction: 'up' | 'down'
): number {
    if (totalItems <= 0) return 0;
    if (direction === 'down') {
        return (currentIndex + 1) % totalItems;
    } else {
        return (currentIndex - 1 + totalItems) % totalItems;
    }
}

/**
 * Parses all `@tag` or `@tag:query` mentions from a user prompt.
 */
export function parseContextMentions(prompt: string): ParsedContextMentions {
    if (!prompt || typeof prompt !== 'string') {
        return { cleanPrompt: '', mentions: [] };
    }

    const mentions: ParsedContextMentions['mentions'] = [];
    const mentionRegex = /@([a-zA-Z0-9_\-]+)(?::([^\s]+))?/g;

    let match: RegExpExecArray | null;
    while ((match = mentionRegex.exec(prompt)) !== null) {
        const rawTag = match[1].toLowerCase();
        const query = match[2] || undefined;

        let resolvedType: ContextMentionCategory | undefined = undefined;

        if (CONTEXT_MENTION_TAGS.includes(rawTag as ContextMentionCategory)) {
            resolvedType = rawTag as ContextMentionCategory;
        } else if (rawTag === 'code' || rawTag === 'src') {
            resolvedType = 'file';
        } else if (rawTag === 'dir' || rawTag === 'directory') {
            resolvedType = 'folder';
        } else if (rawTag === 'diff' || rawTag === 'branch') {
            resolvedType = 'git';
        } else if (rawTag === 'term' || rawTag === 'console' || rawTag === 'cli') {
            resolvedType = 'terminal';
        } else if (rawTag === 'search' || rawTag === 'internet') {
            resolvedType = 'web';
        } else if (rawTag === 'doc' || rawTag === 'reference') {
            resolvedType = 'docs';
        } else if (rawTag === '3d' || rawTag === 'world' || rawTag === 'stage') {
            resolvedType = 'scene';
        } else if (rawTag === 'object' || rawTag === 'prop' || rawTag === 'layer' || rawTag === 'model') {
            resolvedType = 'mesh';
        } else if (rawTag === 'cam' || rawTag === 'view' || rawTag === 'viewport') {
            resolvedType = 'camera';
        } else if (rawTag === 'clip' || rawTag === 'track' || rawTag === 'playhead' || rawTag === 'nle') {
            resolvedType = 'timeline';
        } else {
            // Check if matches known MCP server prefix
            resolvedType = 'mcp';
        }

        mentions.push({
            tag: match[0],
            query,
            type: resolvedType
        });
    }

    // Generate a clean prompt string with mention tags normalized
    const cleanPrompt = prompt.replace(mentionRegex, '').replace(/\s{2,}/g, ' ').trim();

    return {
        cleanPrompt: cleanPrompt || prompt,
        mentions
    };
}

/**
 * Real-time search query resolution across workspace files, git status, terminal logs, MCP tools,
 * and active 3D scene / VFX video-timeline artifacts (@scene, @mesh, @camera, @timeline).
 */
export function resolveContextMentionQuery(
    type: ContextMentionCategory,
    query: string = '',
    workspaceFiles: string[] = [],
    gitStatus?: { branch?: string; modified?: string[]; staged?: string[]; untracked?: string[] },
    mcpServers: McpServerItem[] = [],
    activeArtifact?: CanvasArtifact
): ContextMentionItem[] {
    const q = (query || '').toLowerCase().trim();
    const results: ContextMentionItem[] = [];

    switch (type) {
        case 'file':
        case 'files': {
            const filtered = workspaceFiles.filter(f => !q || f.toLowerCase().includes(q));
            for (const file of filtered.slice(0, 15)) {
                const fileName = file.split('/').pop() || file;
                const dir = file.includes('/') ? file.substring(0, file.lastIndexOf('/')) : 'root';
                results.push({
                    id: `ctx-file-${file.replace(/[^a-zA-Z0-9]/g, '-')}`,
                    type: 'file',
                    name: fileName,
                    path: file,
                    description: `Workspace file in ${dir}`,
                    detail: file,
                    icon: getFileExtensionIcon(fileName)
                });
            }
            break;
        }

        case 'folder': {
            const folders = new Set<string>();
            workspaceFiles.forEach(f => {
                const parts = f.split('/');
                if (parts.length > 1) {
                    folders.add(parts.slice(0, -1).join('/'));
                    folders.add(parts[0]);
                }
            });
            const folderList = Array.from(folders).filter(f => !q || f.toLowerCase().includes(q));
            for (const folder of folderList.slice(0, 10)) {
                results.push({
                    id: `ctx-folder-${folder.replace(/[^a-zA-Z0-9]/g, '-')}`,
                    type: 'folder',
                    name: `${folder}/`,
                    path: folder,
                    description: 'Workspace Directory',
                    detail: folder,
                    icon: '📂'
                });
            }
            break;
        }

        case 'git': {
            const branch = gitStatus?.branch || 'main';
            if (!q || 'branch'.includes(q) || branch.toLowerCase().includes(q)) {
                results.push({
                    id: 'ctx-git-branch',
                    type: 'git',
                    name: `git: ${branch}`,
                    description: 'Active Git working branch',
                    detail: `Branch: ${branch}`,
                    icon: '🌿',
                    payload: { branch }
                });
            }

            if (gitStatus?.modified && gitStatus.modified.length > 0) {
                const modMatches = gitStatus.modified.filter(m => !q || m.toLowerCase().includes(q));
                if (modMatches.length > 0) {
                    results.push({
                        id: 'ctx-git-modified',
                        type: 'git',
                        name: `git: ${modMatches.length} modified files`,
                        description: modMatches.slice(0, 3).join(', '),
                        detail: modMatches.join('\n'),
                        icon: '📝',
                        payload: { modified: modMatches }
                    });
                }
            }

            if (gitStatus?.staged && gitStatus.staged.length > 0) {
                const stagedMatches = gitStatus.staged.filter(s => !q || s.toLowerCase().includes(q));
                if (stagedMatches.length > 0) {
                    results.push({
                        id: 'ctx-git-staged',
                        type: 'git',
                        name: `git: ${stagedMatches.length} staged files`,
                        description: stagedMatches.slice(0, 3).join(', '),
                        detail: stagedMatches.join('\n'),
                        icon: '📦',
                        payload: { staged: stagedMatches }
                    });
                }
            }

            if (gitStatus?.untracked && gitStatus.untracked.length > 0) {
                const untrackedMatches = gitStatus.untracked.filter(u => !q || u.toLowerCase().includes(q));
                if (untrackedMatches.length > 0) {
                    results.push({
                        id: 'ctx-git-untracked',
                        type: 'git',
                        name: `git: ${untrackedMatches.length} untracked files`,
                        description: untrackedMatches.slice(0, 3).join(', '),
                        detail: untrackedMatches.join('\n'),
                        icon: '❓',
                        payload: { untracked: untrackedMatches }
                    });
                }
            }
            break;
        }

        case 'terminal': {
            // What is typed after @ is the command: it runs in the workspace sandbox when the message is sent
            // (POST /workspace/run-command) and its real output goes into the message.
            if (query.trim()) {
                results.push({
                    id: `ctx-terminal-run-${query.trim().replace(/[^a-zA-Z0-9]/g, '-').slice(0, 40)}`,
                    type: 'terminal',
                    name: `Run: ${query.trim()}`,
                    description: 'Runs in the workspace sandbox when you send; its stdout, stderr and exit code are attached',
                    icon: '⚡',
                    payload: { command: query.trim() }
                });
            }
            break;
        }

        case 'web': {
            // Forces Google Search grounding for the turn; the reply says so when the model ran no search.
            results.push({
                id: q ? `ctx-web-search-${q.replace(/[^a-z0-9]/g, '-').slice(0, 40)}` : 'ctx-web-search',
                type: 'web',
                name: q ? `Search the web: "${query.trim()}"` : 'Search the web for this message',
                description: 'Google Search grounding is required for this turn',
                icon: '🌐',
                payload: q ? { query: query.trim() } : undefined
            });
            break;
        }

        case 'docs': {
            const docsTopics = [
                { name: 'Apple HIG Design System', desc: 'Liquid Glass, 8-pt grid, SF Pro typography', icon: '🍎' },
                { name: 'Gemini 3.8 Flash & 2.5 API', desc: 'Hybrid reasoning, multimodal context, function calling', icon: '✨' },
                { name: 'Model Context Protocol (MCP) Spec', desc: 'JSON-RPC 2.0 tool endpoints, SSE & STDIO transports', icon: '🔌' },
                { name: 'React 19 & Tailwind CSS v4', desc: 'Action hooks, server components, utility tokens', icon: '⚛️' }
            ];

            for (const doc of docsTopics) {
                if (!q || doc.name.toLowerCase().includes(q) || doc.desc.toLowerCase().includes(q)) {
                    results.push({
                        id: `ctx-doc-${doc.name.toLowerCase().replace(/[^a-z0-9]/g, '-')}`,
                        type: 'docs',
                        name: doc.name,
                        description: doc.desc,
                        icon: doc.icon
                    });
                }
            }
            break;
        }

        case 'mcp': {
            const matches = mcpServers.filter(
                s => !q || s.name.toLowerCase().includes(q) || s.tagline.toLowerCase().includes(q)
            );
            for (const srv of matches) {
                results.push({
                    id: `ctx-mcp-${srv.id}`,
                    type: 'mcp',
                    name: srv.name,
                    description: srv.tagline,
                    detail: `${srv.toolsCount} tools • ${srv.status}`,
                    icon: '🔌',
                    payload: srv
                });
            }
            break;
        }

        case 'scene': {
            if (activeArtifact?.type === '3d-scene' && activeArtifact.data) {
                const sceneData = activeArtifact.data as Scene3DData;
                const objCount = (sceneData.objects?.length || 0) + (sceneData.customMeshes?.length || 0);
                const layerCount = sceneData.stagedBuild?.layers?.length || 0;
                const glbPath = sceneData.pythonGenerator?.glbPath || sceneData.cppGenerator?.glbPath;
                const summaryParts = [
                    `mode: ${sceneData.renderMode || 'pbr'}`,
                    `${objCount} object${objCount === 1 ? '' : 's'}`,
                    layerCount > 0 ? `${layerCount} staged layer${layerCount === 1 ? '' : 's'}` : undefined,
                    glbPath ? `glb: ${glbPath}` : undefined
                ].filter(Boolean);

                const sceneTitle = sceneData.title || activeArtifact.title || 'Active 3D Scene';
                if (!q || sceneTitle.toLowerCase().includes(q) || 'scene'.includes(q)) {
                    results.push({
                        id: `ctx-scene-${activeArtifact.id}`,
                        type: 'scene',
                        name: `scene: ${sceneTitle}`,
                        description: summaryParts.join(' • '),
                        detail: JSON.stringify({
                            artifactId: activeArtifact.id,
                            title: sceneTitle,
                            renderMode: sceneData.renderMode || 'pbr',
                            selectedMeshId: sceneData.selectedMeshId,
                            glbPath,
                            objectCount: objCount,
                            stagedBuildPlace: sceneData.stagedBuild?.place,
                            environment: sceneData.environment
                        }),
                        icon: '🌐',
                        payload: {
                            artifactId: activeArtifact.id,
                            title: sceneTitle,
                            renderMode: sceneData.renderMode || 'pbr',
                            selectedMeshId: sceneData.selectedMeshId,
                            glbPath
                        }
                    });
                }

                if (sceneData.stagedBuild?.stages) {
                    for (const st of sceneData.stagedBuild.stages) {
                        if (!q || st.title.toLowerCase().includes(q) || st.stage.toLowerCase().includes(q)) {
                            results.push({
                                id: `ctx-scene-stage-${st.stage}`,
                                type: 'scene',
                                name: `stage: ${st.title} (${st.status})`,
                                description: `Staged location pipeline stage [${st.stage}] • source: ${st.source}`,
                                detail: JSON.stringify(st),
                                icon: '🏛️',
                                payload: st
                            });
                        }
                    }
                }
            }
            break;
        }

        case 'mesh': {
            if (activeArtifact?.type === '3d-scene' && activeArtifact.data) {
                const sceneData = activeArtifact.data as Scene3DData;
                const selectedId = sceneData.selectedMeshId;

                for (const obj of sceneData.objects || []) {
                    const isSelected = Boolean(selectedId && obj.id === selectedId);
                    const label = obj.label || (obj as any).name || obj.id;
                    if (!q || label.toLowerCase().includes(q) || obj.id.toLowerCase().includes(q) || (obj.type || '').toLowerCase().includes(q)) {
                        const pos = Array.isArray(obj.position) ? `[${obj.position.map(n => Number(n).toFixed(2)).join(', ')}]` : '[0, 0, 0]';
                        results.push({
                            id: `ctx-mesh-obj-${obj.id}`,
                            type: 'mesh',
                            name: `mesh: ${label}${isSelected ? ' (selected)' : ''}`,
                            path: obj.durableUri,
                            description: `3D Object (${obj.type || 'mesh'}) at ${pos}${obj.material?.preset ? ` • ${obj.material.preset}` : ''}`,
                            detail: JSON.stringify({
                                id: obj.id,
                                label,
                                selected: isSelected,
                                position: obj.position,
                                rotation: obj.rotation,
                                scale: obj.scale,
                                bounds: (obj as any).bounds,
                                durableUri: obj.durableUri,
                                material: obj.material
                            }),
                            icon: isSelected ? '🎯' : '🧊',
                            payload: obj
                        });
                    }
                }

                for (const mesh of sceneData.customMeshes || []) {
                    const isSelected = Boolean(selectedId && mesh.id === selectedId);
                    const label = mesh.label || (mesh as any).name || mesh.id;
                    if (!q || label.toLowerCase().includes(q) || mesh.id.toLowerCase().includes(q)) {
                        const pos = Array.isArray(mesh.position) ? `[${mesh.position.map(n => Number(n).toFixed(2)).join(', ')}]` : '[0, 0, 0]';
                        results.push({
                            id: `ctx-mesh-custom-${mesh.id}`,
                            type: 'mesh',
                            name: `mesh: ${label}${isSelected ? ' (selected)' : ''}`,
                            description: `Procedural Mesh (${mesh.tier || 'primary'}) at ${pos}`,
                            detail: JSON.stringify({
                                id: mesh.id,
                                label,
                                tier: mesh.tier,
                                selected: isSelected,
                                position: mesh.position,
                                rotation: mesh.rotation,
                                scale: mesh.scale,
                                material: mesh.material
                            }),
                            icon: isSelected ? '🎯' : '🧊',
                            payload: mesh
                        });
                    }
                }

                for (const layer of sceneData.stagedBuild?.layers || []) {
                    const label = layer.label || layer.id;
                    if (!q || label.toLowerCase().includes(q) || layer.id.toLowerCase().includes(q) || (layer.provenance || '').toLowerCase().includes(q)) {
                        results.push({
                            id: `ctx-mesh-layer-${layer.id}`,
                            type: 'mesh',
                            name: `layer: ${label}`,
                            path: layer.glbUrl,
                            description: `Staged 3D Layer (${layer.provenance}) • ${layer.vertexCount?.toLocaleString() ?? 0} verts`,
                            detail: JSON.stringify(layer),
                            icon: '🏛️',
                            payload: layer
                        });
                    }
                }

                // Sort selected mesh to the top
                results.sort((a, b) => (b.name.includes('(selected)') ? 1 : 0) - (a.name.includes('(selected)') ? 1 : 0));
            }
            break;
        }

        case 'camera': {
            if (activeArtifact?.type === '3d-scene' && activeArtifact.data) {
                const sceneData = activeArtifact.data as Scene3DData;
                const cam = sceneData.camera || { position: [5, 4, 8], target: [0, 0, 0], fov: 45 };
                const pos = Array.isArray(cam.position) ? `[${cam.position.map(n => Number(n).toFixed(2)).join(', ')}]` : '[5, 4, 8]';
                const tgt = Array.isArray(cam.target) ? `[${cam.target.map(n => Number(n).toFixed(2)).join(', ')}]` : '[0, 0, 0]';
                if (!q || 'camera'.includes(q) || 'viewport'.includes(q) || (cam.preset || '').toLowerCase().includes(q)) {
                    results.push({
                        id: `ctx-camera-active-${activeArtifact.id}`,
                        type: 'camera',
                        name: `camera: Active Viewport (${cam.fov ?? 45}° FOV)`,
                        description: `pos ${pos} → target ${tgt}${cam.preset ? ` • preset: ${cam.preset}` : ''}`,
                        detail: JSON.stringify(cam),
                        icon: '🎥',
                        payload: cam
                    });
                }
            }
            break;
        }

        case 'timeline': {
            if (activeArtifact?.type === 'video-timeline' && activeArtifact.data) {
                const tl = activeArtifact.data as VideoTimelineData;
                const currentTime = Number(tl.currentTime ?? 0);
                const duration = Number(tl.duration ?? 0);
                const fps = Number(tl.fps ?? 24);
                const frame = Math.round(currentTime * fps);
                if (!q || 'playhead'.includes(q) || 'timeline'.includes(q)) {
                    results.push({
                        id: `ctx-timeline-playhead-${activeArtifact.id}`,
                        type: 'timeline',
                        name: `timeline: Playhead @ ${currentTime.toFixed(2)}s (frame ${frame})`,
                        description: `${tl.title || 'Video Timeline'} • duration ${duration.toFixed(2)}s @ ${fps} fps`,
                        detail: JSON.stringify({
                            artifactId: activeArtifact.id,
                            title: tl.title,
                            currentTime,
                            frame,
                            duration,
                            fps,
                            trackCount: tl.tracks?.length || 0
                        }),
                        icon: '⏱️',
                        payload: { currentTime, frame, duration, fps }
                    });
                }
                for (const track of tl.tracks || []) {
                    const trackLabel = track.label || (track as any).name || track.id;
                    for (const clip of track.clips || []) {
                        const label = clip.label || (clip as any).name || clip.id;
                        if (!q || label.toLowerCase().includes(q) || trackLabel.toLowerCase().includes(q)) {
                            const start = Number(clip.startTime ?? 0);
                            const end = start + Number(clip.duration ?? 0);
                            results.push({
                                id: `ctx-timeline-clip-${clip.id}`,
                                type: 'timeline',
                                name: `clip: ${label} [${start.toFixed(1)}s–${end.toFixed(1)}s]`,
                                path: clip.mediaUrl,
                                description: `Track "${trackLabel}" (${track.type})${clip.mediaUrl ? ` • ${clip.mediaUrl}` : ''}`,
                                detail: JSON.stringify({ trackId: track.id, trackLabel, clip }),
                                icon: '🎞️',
                                payload: { trackId: track.id, clip }
                            });
                        }
                    }
                }
            } else if (activeArtifact?.type === '3d-scene' && activeArtifact.data) {
                const sceneData = activeArtifact.data as Scene3DData;
                if (sceneData.timeline) {
                    const tl = sceneData.timeline;
                    const kfCount = tl.keyframes?.length || 0;
                    if (!q || 'timeline'.includes(q) || 'keyframe'.includes(q)) {
                        results.push({
                            id: `ctx-timeline-3d-${activeArtifact.id}`,
                            type: 'timeline',
                            name: `timeline: 3D Scene @ ${Number(tl.currentTime ?? 0).toFixed(2)}s / ${Number(tl.duration ?? 0).toFixed(2)}s`,
                            description: `${tl.fps ?? 24} fps • ${kfCount} keyframe${kfCount === 1 ? '' : 's'}`,
                            detail: JSON.stringify(tl),
                            icon: '🎬',
                            payload: tl
                        });
                    }
                }
            }
            break;
        }

        default:
            break;
    }

    return results;
}

function getFileExtensionIcon(fileName: string): string {
    if (fileName.endsWith('.tsx') || fileName.endsWith('.jsx')) return '⚛️';
    if (fileName.endsWith('.ts') || fileName.endsWith('.js')) return '📜';
    if (fileName.endsWith('.json')) return '📋';
    if (fileName.endsWith('.css') || fileName.endsWith('.scss')) return '🎨';
    if (fileName.endsWith('.md')) return '📝';
    if (fileName.endsWith('.py')) return '🐍';
    if (fileName.endsWith('.cpp') || fileName.endsWith('.hpp') || fileName.endsWith('.h')) return '⚙️';
    if (fileName.endsWith('.glb') || fileName.endsWith('.gltf') || fileName.endsWith('.obj')) return '🧊';
    if (fileName.endsWith('.spz') || fileName.endsWith('.ply') || fileName.endsWith('.splat')) return '✨';
    if (fileName.endsWith('.mp4') || fileName.endsWith('.mov') || fileName.endsWith('.webm')) return '🎬';
    if (fileName.endsWith('.sh') || fileName.endsWith('.bash')) return '⚡';
    return '📄';
}
