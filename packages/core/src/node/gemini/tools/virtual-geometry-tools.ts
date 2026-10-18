/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import type { CanvasArtifact, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import type { ToolDeclaration, ToolHandler } from './types';
import { getVirtualGeometryBuildService, VirtualGeometryBuildError } from '../../3d-engine/virtual-geometry-service';
import { PathTraversalError, resolveWithinRoot } from '../../security/path-guard';

export const VIRTUAL_GEOMETRY_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'virtual_geometry_open_glb',
        description: 'Open a GLB from the workspace in the WebGPU virtual geometry viewport. The native C++20 builder turns the mesh into a Nanite-style cluster LOD hierarchy (.sbvg), which the app streams coarsest level first while the GPU picks per-cluster detail every frame (one indirect draw). Use it for meshes too heavy for the regular 3D viewport (hundreds of thousands to millions of triangles: scans, 3D tiles, CAD). Geometry is shown in clay (positions and normals only: no textures, UVs or materials). The GLB must use float32 positions without Draco or meshopt compression. The viewport needs WebGPU in the app\'s browser.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'Path of the .glb inside the workspace (relative to the workspace root, or absolute within it).' },
                title: { type: 'STRING', description: 'Tab title for the scene.' },
                errorThresholdPx: { type: 'NUMBER', description: 'Allowed screen-space geometric error in pixels (default 1; larger draws fewer triangles).' },
                doubleSided: { type: 'BOOLEAN', description: 'Draw back faces too, for meshes with inconsistent winding (disables back-face and cone culling).' }
            },
            required: ['glbPath']
        }
    }
];

export const virtualGeometryHandlers: Record<string, ToolHandler> = {
    async virtual_geometry_open_glb(args, ctx) {
        const glbPath = typeof args.glbPath === 'string' ? args.glbPath.trim() : '';
        const fail = (error: string) => ({ status: 'failed' as const, resultPayload: { success: false, error }, summaryResult: `Failed: ${error}` });
        if (!glbPath) return fail('glbPath is required: the .glb to open, inside the workspace.');
        let file: string;
        try {
            file = resolveWithinRoot(ctx.workspaceRoot, glbPath);
        } catch (err) {
            if (err instanceof PathTraversalError) return fail(`${glbPath} is outside the workspace (${ctx.workspaceRoot}).`);
            throw err;
        }
        if (!fs.existsSync(file)) return fail(`${glbPath} does not exist in the workspace (${ctx.workspaceRoot}).`);

        let built;
        try {
            built = await getVirtualGeometryBuildService().buildServed(file);
        } catch (err) {
            if (err instanceof VirtualGeometryBuildError) return fail(err.message);
            throw err;
        }

        const title = (typeof args.title === 'string' && args.title.trim()) || `${glbPath.split(/[\\/]/).pop()} (virtual geometry)`;
        const threshold = typeof args.errorThresholdPx === 'number' && args.errorThresholdPx > 0 ? args.errorThresholdPx : undefined;
        const data: Scene3DData = {
            title,
            environment: { skybox: 'studio', lighting: 'studio', ground: false },
            virtualGeometry: {
                sourceGlbPath: glbPath,
                sbvgUrl: built.sbvgUrl,
                ...(threshold ? { errorThresholdPx: threshold } : {}),
                ...(args.doubleSided === true ? { doubleSided: true } : {}),
                ...(built.stats ? {
                    buildStats: {
                        sourceTriangles: built.stats.sourceTriangles,
                        clusterCount: built.stats.clusterCount,
                        levelCount: built.stats.levelCount,
                        fileBytes: built.stats.fileBytes,
                        buildMs: built.buildMs ?? 0
                    }
                } : {})
            }
        };
        const artifact: CanvasArtifact = {
            id: `art-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: '3d-scene',
            title,
            summary: 'WebGPU virtual geometry (streamed cluster LOD)',
            data,
            createdAt: new Date().toISOString(),
            version: 1
        };
        const s = built.stats;
        const detail = s
            ? `${s.sourceTriangles.toLocaleString()} triangles -> ${s.clusterCount.toLocaleString()} clusters in ${s.levelCount} LOD levels (${(s.fileBytes / 1048576).toFixed(1)} MB), built in ${((built.buildMs ?? 0) / 1000).toFixed(1)} s`
            : 'reused the existing build for this GLB';
        return {
            resultPayload: { status: 'success', artifact, sbvgUrl: built.sbvgUrl, cached: built.cached, stats: built.stats },
            summaryResult: `Opened ${glbPath} in the virtual geometry viewport: ${detail}.`
        };
    }
};
