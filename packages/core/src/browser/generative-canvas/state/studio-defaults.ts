/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { ChatSession, StudioAppearanceConfig } from '../canvas-types';

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

export const DEFAULT_SESSIONS: ChatSession[] = [
    {
        id: 'sess-active-agent',
        title: 'New Agent',
        fileType: 'chat',
        layoutMode: 'chat',
        workspaceId: 'proj-scratchbox-ide',
        workspaceName: 'scratchbox-ide-master',
        relativeTime: '1m',
        dateCategory: 'Today',
        updatedAt: '1m ago',
        messages: [],
        artifactHistory: []
    },
    {
        id: 'sess-active-threejs',
        title: 'three.js bullet impact ...',
        fileType: 'chat',
        layoutMode: 'chat',
        workspaceId: 'proj-scratchbox-ide',
        workspaceName: 'scratchbox-ide-master',
        relativeTime: '20h',
        dateCategory: 'Today',
        updatedAt: '20h ago',
        messages: [],
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

export const DEFAULT_APPEARANCE_CONFIG: StudioAppearanceConfig = {
    glassBlur: 'standard',
    canvasDensity: 'standard',
    enableSpringMotion: true,
    showLineNumbersInCode: false,
    autoAttachSuperpowers: true,
    hapticFeedback: true
};
