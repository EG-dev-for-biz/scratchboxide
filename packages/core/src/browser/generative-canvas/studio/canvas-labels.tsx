/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as React from 'react';
import { StageLayoutMode, StudioLayoutMode } from '../canvas-types';
import {
    IconAutomations,
    IconCode,
    IconDocument,
    IconGlobe,
    IconKanban,
    IconSparkles,
    Icon3D,
    IconFilm,
    getPrimitiveSvgIcon
} from '../canvas-icons';

/** Human-readable labels and icons for canvas primitives and layout modes. */
export const getPrimitiveIcon = (type: string): React.ReactElement => getPrimitiveSvgIcon(type, 14, 1.8);

export function getPrimitiveLabel(type: string): string {
    switch (type) {
        case 'metric-dashboard':
        case 'metrics':
        case 'dashboard':
            return 'KPI Dashboard';
        case 'kanban-board':
        case 'kanban':
            return 'Kanban Board';
        case 'interactive-form':
        case 'form':
            return 'Interactive Form';
        case 'node-graph':
        case 'flow-graph':
        case 'graph':
            return 'Node Flow Graph';
        case 'markdown-document':
        case 'rendered-document':
        case 'document':
            return 'Document Spec';
        case 'checklist':
        case 'action-checklist':
            return 'Action Checklist';
        case 'mind-map':
            return 'Mind Map';
        case 'interactive-browser':
        case 'browser':
        case 'web-browser':
            return 'Web Browser Canvas';
        case '3d-scene':
        case '3d':
        case 'scene-3d':
        case 'scene3d':
            return '4D Scene Workspace';
        case 'skills-hub':
        case 'skills-manager':
            return 'Superpowers Hub';
        case 'mcp-hub':
            return 'Live MCP Hub';
        case 'video-timeline':
        case 'video':
        case 'timeline':
        case 'nle':
            return 'Video NLE Timeline';
        default:
            return 'Visual Canvas';
    }
};

export function getCanvasHeaderLabel(stageLayoutMode: StageLayoutMode, layoutMode: StudioLayoutMode): string {
    if (stageLayoutMode !== 'single') return 'BENTO CANVAS MATRIX';
    switch (layoutMode) {
        case 'video':
            return 'VIDEO NLE TIMELINE';
        case '3d':
            return '3D SCENE CANVAS';
        case 'document':
            return 'DOCUMENT CANVAS';
        case 'browser':
            return 'BROWSER CANVAS';
        case 'code':
            return 'CODE SANDBOX';
        case 'kanban':
            return 'KANBAN ROADMAP';
        case 'automation':
        case 'canvas':
            return 'CANVAS WORKFLOW';
        default:
            return 'VISUAL CANVAS';
    }
};

export function getCanvasReopenLabel(layoutMode: StudioLayoutMode): string {
    switch (layoutMode) {
        case 'video':
            return 'Reopen Video Timeline';
        case '3d':
            return 'Reopen 3D Canvas';
        case 'document':
            return 'Reopen Document Canvas';
        case 'browser':
            return 'Reopen Browser Canvas';
        case 'code':
            return 'Reopen Code Sandbox';
        case 'kanban':
            return 'Reopen Kanban Roadmap';
        case 'automation':
        case 'canvas':
            return 'Reopen Canvas Workflow';
        default:
            return 'Reopen Canvas';
    }
};

export function getCanvasReopenTabTitle(layoutMode: StudioLayoutMode): string {
    switch (layoutMode) {
        case 'video':
            return 'Video Timeline';
        case '3d':
            return '3D Canvas';
        case 'document':
            return 'Document Canvas';
        case 'browser':
            return 'Browser Canvas';
        case 'code':
            return 'Code Sandbox';
        case 'kanban':
            return 'Kanban Roadmap';
        case 'automation':
        case 'canvas':
            return 'Canvas Workflow';
        default:
            return 'Canvas Studio';
    }
};

export function getCanvasReopenIcon(layoutMode: StudioLayoutMode): React.ReactElement {
    switch (layoutMode) {
        case 'video':
            return <IconFilm size={14} strokeWidth={1.8} />;
        case '3d':
            return <Icon3D size={14} strokeWidth={1.8} />;
        case 'document':
            return <IconDocument size={14} strokeWidth={1.8} />;
        case 'browser':
            return <IconGlobe size={14} strokeWidth={1.8} />;
        case 'code':
            return <IconCode size={14} strokeWidth={1.8} />;
        case 'kanban':
            return <IconKanban size={14} strokeWidth={1.8} />;
        case 'automation':
        case 'canvas':
            return <IconAutomations size={14} strokeWidth={1.8} />;
        default:
            return <IconSparkles size={14} strokeWidth={1.8} />;
    }
};
