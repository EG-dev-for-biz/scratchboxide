/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import type { CanvasArtifact, PrimitiveType, ArtifactData, VideoTimelineData, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import { synthesizeContextualVideoTimeline } from '../../../browser/generative-canvas/services/video/videoTimelineSynthesizer';
import { synthesizeContextual3DScene } from '../../../browser/generative-canvas/procedural-3d-synthesizer';
import type { ToolDeclaration, ToolHandler } from './types';

function asString(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

export const CANVAS_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'mount_canvas_primitive',
        description: 'Mount or update an interactive visual canvas primitive on the stage (3D scene, video timeline, live code sandbox, kanban board, markdown document, or node graph). Use this tool whenever the user asks to create, build, design, edit, or visualize something.',
        parameters: {
            type: 'OBJECT',
            properties: {
                primitiveType: {
                    type: 'STRING',
                    description: 'The type of canvas primitive: "3d-scene", "video-timeline", "live-code-sandbox", "kanban-board", "markdown-document", "metric-dashboard", or "node-graph"'
                },
                title: {
                    type: 'STRING',
                    description: 'The user-facing title of the canvas primitive'
                },
                summary: {
                    type: 'STRING',
                    description: 'Brief 1-2 sentence description of what was synthesized'
                },
                payload: {
                    type: 'OBJECT',
                    description: 'The strongly-typed primitive data (Scene3DData, VideoTimelineData, SandboxData, KanbanData, DocumentData, or GraphData)'
                }
            },
            required: ['primitiveType', 'title', 'payload']
        }
    }
];

export const canvasHandlers: Record<string, ToolHandler> = {
    mount_canvas_primitive(args, _ctx) {
        let primitiveType = (asString(args.primitiveType) || '3d-scene') as PrimitiveType;
        let title = asString(args.title) || 'Visual Creation';
        let summary = asString(args.summary) || `Synthesized ${title} on visual canvas.`;
        let payload = (args.payload && typeof args.payload === 'object') ? args.payload as ArtifactData : ({} as any);

        const prompt = _ctx?.request?.prompt || '';
        const lowerPrompt = prompt.toLowerCase();
        const isVideoTimelinePrompt = /split\s+(?:active\s+)?clip|ripple\s+delete|playhead|video\s+timeline|timeline\s+editor|video\s+editor|\bnle\b|cut\s+clip|trim\s+clip|multi-track\s+video|b-roll|a-roll|video\s+track|audio\s+mixer\s+track|color\s+grade\s+clip/i.test(prompt) ||
            ((lowerPrompt.includes('clip') || lowerPrompt.includes('timeline')) && (lowerPrompt.includes('split') || lowerPrompt.includes('cut') || lowerPrompt.includes('delete') || lowerPrompt.includes('playhead') || lowerPrompt.includes('ripple') || lowerPrompt.includes('track') || lowerPrompt.includes('video')));

        if (isVideoTimelinePrompt || primitiveType === 'video-timeline' || (primitiveType as string) === 'video-editor' || (primitiveType as string) === 'timeline' || (primitiveType as string) === 'nle') {
            primitiveType = 'video-timeline';
            const activeVideoData = _ctx?.request?.activeArtifact?.type === 'video-timeline' ? (_ctx.request.activeArtifact.data as VideoTimelineData) : undefined;
            const timelineData = synthesizeContextualVideoTimeline(prompt, title !== 'Visual Creation' ? title : undefined, activeVideoData);
            if (payload && typeof payload === 'object') {
                const p = payload as any;
                if (p.tracks && Array.isArray(p.tracks) && p.tracks.length > 0) timelineData.tracks = p.tracks;
                if (p.aspectRatio) timelineData.aspectRatio = p.aspectRatio;
                if (p.fps) timelineData.fps = p.fps;
                if (p.duration) timelineData.duration = p.duration;
                if (p.currentTime !== undefined) timelineData.currentTime = p.currentTime;
            }
            payload = timelineData as any;
            title = timelineData.title;
            summary = timelineData.subtitle || 'Multi-track non-linear video editing timeline with real-time WebGL compositor';
        } else if (primitiveType === '3d-scene' || /3d|scene|mesh|pedestal|orbit|spatial|monolith/i.test(prompt) || /3d|scene/i.test(title)) {
            primitiveType = '3d-scene';
            const contextual3D = synthesizeContextual3DScene(prompt, {
                activeArtifact: _ctx?.request?.activeArtifact,
                chatHistory: _ctx?.request?.chatHistory,
                docTitle: title !== 'Visual Creation' ? title : undefined
            });

            const p = payload && typeof payload === 'object' ? (payload as any) : {};

            payload = {
                ...contextual3D,
                ...p,
                worldBranch: p.worldBranch || contextual3D.worldBranch,
                sceneType: p.sceneType || contextual3D.sceneType,
                customMeshes: (p.customMeshes && Array.isArray(p.customMeshes) && p.customMeshes.length > 0)
                    ? p.customMeshes
                    : contextual3D.customMeshes,
                environment: p.environment || contextual3D.environment,
                camera: p.camera || contextual3D.camera,
                objects: (Array.isArray(p.objects) && p.objects.length > 0) ? p.objects : (contextual3D.objects || []),
                features: {
                    ...(contextual3D.features || {}),
                    ...(p.features || {})
                },
                cppGenerator: p.cppGenerator || contextual3D.cppGenerator
            };
            title = p.title && p.title !== '4D Scene Workspace' ? p.title : (contextual3D.title || title);
            summary = p.subtitle || contextual3D.subtitle || summary;
        }

        const artifactId = `art-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const artifact: CanvasArtifact = {
            id: artifactId,
            type: primitiveType,
            title,
            summary,
            data: payload,
            createdAt: new Date().toISOString(),
            version: 1
        };

        return {
            resultPayload: {
                status: 'success',
                artifactId,
                primitiveType,
                title,
                summary,
                artifact
            },
            summaryResult: `Mounted ${primitiveType} primitive: "${title}".`
        };
    }
};
