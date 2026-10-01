/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { ChatSession, StudioAppearanceConfig } from '../canvas-types';
import { MASTER_SCENE_CPP_SOURCE, MASTER_SCENE_GLB_BASE64, MASTER_SCENE_STATS } from './master-scene-data';
import { synthesizeContextual3DScene } from '../procedural-3d-synthesizer';

/** Mock workspace file list used by the `@file` context-mention autocomplete. */
export const DEFAULT_WORKSPACE_FILES: string[] = [
    'src/browser/generative-canvas/GenerativeCanvasStudio.tsx',
    'src/browser/generative-canvas/canvas-types.ts',
    'src/browser/generative-canvas/context-mention-engine.ts',
    'src/browser/generative-canvas/multi-file-diff-engine.ts',
    'src/browser/generative-canvas/terminal-debug-bridge.ts',
    'src/browser/generative-canvas/SpotlightLauncherModal.tsx',
    'src/browser/generative-canvas/primitives/LiveCodeSandboxPrimitive.tsx',
    'src/browser/generative-canvas/primitives/McpHubPrimitive.tsx',
    'src/browser/generative-canvas/primitives/KanbanBoardPrimitive.tsx',
    'src/browser/generative-canvas/primitives/MarkdownDocumentPrimitive.tsx',
    'src/browser/generative-canvas/primitives/NodeGraphPrimitive.tsx',
    'src/node/workspace-config-service.ts',
    'src/node/gemini-endpoint.ts',
    'src/node/gemini-service.ts',
    'package.json',
    'tsconfig.json',
    'README.md'
];

export interface WorkspaceGitStatusSnapshot {
    branch: string;
    modified: string[];
    staged: string[];
    untracked: string[];
}

/** Mock git status used by the `@git` context-mention autocomplete. */
export const DEFAULT_WORKSPACE_GIT_STATUS: WorkspaceGitStatusSnapshot = {
    branch: 'feature/vibe-coding',
    modified: [
        'src/browser/generative-canvas/GenerativeCanvasStudio.tsx',
        'src/browser/generative-canvas/canvas-types.ts'
    ],
    staged: [
        'src/browser/generative-canvas/context-mention-engine.ts',
        'src/browser/generative-canvas/multi-file-diff-engine.ts'
    ],
    untracked: [
        'src/browser/generative-canvas/SpotlightLauncherModal.tsx'
    ]
};


/** Directory that contains `workspacePath`; falls back to a home-relative dev folder when the root is not known yet. */
export function parentDirectoryOf(workspacePath: string | undefined): string {
    const trimmed = (workspacePath || '').replace(/\/+$/, '');
    if (!trimmed || !trimmed.includes('/')) {
        return '~/dev';
    }
    return trimmed.slice(0, trimmed.lastIndexOf('/')) || '/';
}

/** Path for a new workspace created next to the active one. */
export function siblingWorkspacePath(activeWorkspacePath: string | undefined, slug: string): string {
    return `${parentDirectoryOf(activeWorkspacePath)}/${slug}`;
}

/** Up to two upper-case initials for an avatar badge. */
export function initialsOf(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
        return '?';
    }
    return parts.slice(0, 2).map(p => p.charAt(0).toUpperCase()).join('');
}

const bulletGlassSceneData = synthesizeContextual3DScene('build me a scene of a bully going through a plate of glass');

export const DEMO_SESSIONS: ChatSession[] = [
    {
        id: 'sess-active-threejs',
        title: 'three.js bullet impact ...',
        fileType: '3d',
        layoutMode: '3d',
        workspaceId: 'proj-scratchbox-ide',
        workspaceName: 'scratchbox-ide-master',
        relativeTime: '20h',
        dateCategory: 'Today',
        updatedAt: '20h ago',
        messages: [
            {
                id: 'msg-bullet-user-1',
                sender: 'user',
                text: 'build me a scene of a bully going through a plate of glass',
                timestamp: '20h ago'
            },
            {
                id: 'msg-bullet-ai-1',
                sender: 'assistant',
                text: 'Synthesized high-velocity ballistic impact scene with 110+ Voronoi fracture glass shards, copper spitzer projectile (820 m/s, Mach 2.4), and supersonic Mach shockwave. C++20 generator attached in world_generator.cpp with real-time PBR viewport streaming.',
                timestamp: '20h ago',
                artifacts: [
                    {
                        id: 'art-bullet-glass-shatter',
                        type: '3d-scene',
                        title: 'Bullet Glass Impact & Voronoi Fracture',
                        summary: 'High-speed ballistics (820 m/s) piercing optical glass. 110+ Voronoi shards with momentum integration and supersonic Mach shockwave.',
                        version: 1,
                        createdAt: '20h ago',
                        data: bulletGlassSceneData
                    }
                ]
            }
        ],
        activeArtifact: {
            id: 'art-bullet-glass-shatter',
            type: '3d-scene',
            title: 'Bullet Glass Impact & Voronoi Fracture',
            summary: 'High-speed ballistics (820 m/s) piercing optical glass. 110+ Voronoi shards with momentum integration and supersonic Mach shockwave.',
            version: 1,
            createdAt: '20h ago',
            data: bulletGlassSceneData
        },
        artifactHistory: []
    },
    {
        id: 'sess-active-agent',
        title: 'Grand Master 3D Sanctuary',
        fileType: '3d',
        layoutMode: '3d',
        workspaceId: 'proj-scratchbox-ide',
        workspaceName: 'scratchbox-ide-master',
        relativeTime: 'Just now',
        dateCategory: 'Today',
        updatedAt: 'Just now',
        messages: [
            {
                id: 'msg-master-scene-init',
                sender: 'assistant',
                text: 'Synthesized grand master 3D sanctuary combining FastNoise3D terrain pedestal, 7-bone multibody ragdoll physics, hair & fur grooming with Marschner BSDF, orthotropic draped textile banner, rigid body collision manifolds, Garland-Heckbert QEM LOD pyramids, 72 glowing crystal spires, and spatial BVH ray-traced ambient occlusion (RTAO).',
                timestamp: 'Just now',
                artifacts: [
                    {
                        id: 'art-master-scene-synthesis',
                        title: 'Sanctuary of Synthesis',
                        summary: 'Procedural Terrain, Multibody Ragdoll, Hair/Fur Grooming, Orthotropic Fabric & RTAO',
                        type: '3d-scene',
                        version: 1,
                        createdAt: 'Just now',
                        data: {
                            title: 'Sanctuary of Synthesis',
                            subtitle: 'Procedural Terrain, Multibody Ragdoll, Hair/Fur Grooming, Orthotropic Fabric & RTAO',
                            sceneType: 'architecture',
                            renderMode: 'pbr',
                            camera: {
                                position: [3.8, 3.2, 5.0],
                                target: [0.0, 1.2, 0.0],
                                fov: 45
                            },
                            environment: {
                                skybox: 'nebula',
                                lighting: 'cinematic',
                                ambientIntensity: 0.65,
                                tonemapping: {
                                    curve: 'aces',
                                    exposure: 1.15
                                }
                            },
                            cppGenerator: {
                                enabled: true,
                                filename: 'world_generator.cpp',
                                sourceCode: MASTER_SCENE_CPP_SOURCE,
                                glbBase64: MASTER_SCENE_GLB_BASE64,
                                vertexCount: MASTER_SCENE_STATS.vertexCount,
                                triangleCount: MASTER_SCENE_STATS.triangleCount,
                                lastCompiledTimeMs: Date.now(),
                                lastExecutionDurationMs: 199
                            }
                        }
                    }
                ]
            }
        ],
        activeArtifact: {
            id: 'art-master-scene-synthesis',
            title: 'Sanctuary of Synthesis',
            summary: 'Procedural Terrain, Multibody Ragdoll, Hair/Fur Grooming, Orthotropic Fabric & RTAO',
            type: '3d-scene',
            version: 1,
            createdAt: 'Just now',
            data: {
                title: 'Sanctuary of Synthesis',
                subtitle: 'Procedural Terrain, Multibody Ragdoll, Hair/Fur Grooming, Orthotropic Fabric & RTAO',
                sceneType: 'architecture',
                renderMode: 'pbr',
                camera: {
                    position: [3.8, 3.2, 5.0],
                    target: [0.0, 1.2, 0.0],
                    fov: 45
                },
                environment: {
                    skybox: 'nebula',
                    lighting: 'cinematic',
                    ambientIntensity: 0.65,
                    tonemapping: {
                        curve: 'aces',
                        exposure: 1.15
                    }
                },
                cppGenerator: {
                    enabled: true,
                    filename: 'world_generator.cpp',
                    sourceCode: MASTER_SCENE_CPP_SOURCE,
                    glbBase64: MASTER_SCENE_GLB_BASE64,
                    vertexCount: MASTER_SCENE_STATS.vertexCount,
                    triangleCount: MASTER_SCENE_STATS.triangleCount,
                    lastCompiledTimeMs: Date.now(),
                    lastExecutionDurationMs: 199
                }
            }
        },
        artifactHistory: []
    },
    {
        id: 'sess-test-generative',
        title: 'New Agent',
        fileType: 'chat',
        layoutMode: 'chat',
        workspaceId: 'proj-test-workspace',
        workspaceName: 'scratchbox-test-workspace',
        relativeTime: '1m',
        dateCategory: 'Today',
        updatedAt: '1m ago',
        messages: [],
        artifactHistory: []
    }
];

/**
 * Clean default initial sessions for a fresh user environment.
 * Users start with an open canvas and zero pre-baked demo conversations or clutter.
 */
export const DEFAULT_SESSIONS: ChatSession[] = [
    {
        id: 'sess-new-canvas',
        title: 'New Canvas',
        fileType: 'chat',
        layoutMode: 'chat',
        workspaceId: 'proj-scratchbox-ide',
        workspaceName: 'scratchbox-ide-master',
        relativeTime: 'Just now',
        dateCategory: 'Today',
        updatedAt: 'Just now',
        messages: [],
        artifactHistory: []
    }
];

export const DEFAULT_APPEARANCE_CONFIG: StudioAppearanceConfig = {
    glassBlur: 'standard',
    canvasDensity: 'standard',
    enableSpringMotion: true,
    showLineNumbersInCode: false,
    autoAttachSuperpowers: true,
    hapticFeedback: true
};
