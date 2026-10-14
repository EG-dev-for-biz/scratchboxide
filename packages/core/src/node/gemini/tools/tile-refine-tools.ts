/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';
import {
    findTileRefineRepoRoot,
    getTileRefineService,
    summarizeTileRefineStats,
    TileRefineError,
    type TileRefineRequest
} from '../../3d-engine/tile-refine-service';
import { PathTraversalError, resolveWithinRoot } from '../../security/path-guard';

/**
 * The root tile_refine reads `tilePath` from: the workspace when the file is there, else the checkout that holds the
 * tile_refine sources, whose public/models is where the tile extraction tools write (the server runs from desktop-app/,
 * so the two differ). Falls back to the workspace, which then reports the path as missing or outside it.
 */
export function tileRefineRootFor(tilePath: string, workspaceRoot: string): string {
    if (typeof tilePath !== 'string' || !tilePath.trim()) return workspaceRoot;
    for (const root of [workspaceRoot, findTileRefineRepoRoot()]) {
        try {
            if (fs.existsSync(resolveWithinRoot(root, tilePath.trim()))) return root;
        } catch (err) {
            if (!(err instanceof PathTraversalError)) throw err;
        }
    }
    return workspaceRoot;
}

export const TILE_REFINE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'tile_refine',
        description: 'Turn a raw Google Photorealistic 3D Tiles GLB (or any y-up metric photogrammetric tile scan) into a better-defined 3D object in one fast native C++20 pass (~10-15 s, cached repeats are instant): culls hidden shells, snaps facades to planes/lines with bounded displacement, closes cracks, and adds photometric facade relief (window/pier recesses) near the anchor. With isolate it refines just the building under the anchor in about a second. Writes a textured GLB that keeps the original photos and a studio grey clay GLB. Use publishAs to copy them into public/models for the viewer.',
        parameters: {
            type: 'OBJECT',
            properties: {
                tilePath: { type: 'STRING', description: 'Path of the raw tile .glb: workspace-relative (e.g. public/tiles/<tile>.glb), or the glbPath returned by google_3d_tiles_get_full_texture / google_3d_tiles_get_clay (absolute is fine).' },
                anchor: {
                    type: 'OBJECT',
                    description: 'Hero anchor in the tile frame, metres (x = east, z = south). Default: tile origin.',
                    properties: { x: { type: 'NUMBER' }, z: { type: 'NUMBER' } },
                    required: ['x', 'z']
                },
                roiRadius: { type: 'NUMBER', description: 'Relief region of interest: the anchor footprint grown by this many metres (default 60; negative = whole tile).' },
                relief: { type: 'BOOLEAN', description: 'Add photometric facade relief (default true).' },
                isolate: { type: 'BOOLEAN', description: 'Refine only the structure under the anchor: its whole connected footprint and everything above it (never cut; attached neighbours come along, it ends at street canyons) plus a small ground apron. Takes seconds instead of the whole tile; use it to iterate on one building. Also writes the isolated raw scan as clay.' },
                apron: { type: 'NUMBER', description: 'With isolate: metres of ground kept around the footprint (default 4).' },
                publishAs: { type: 'STRING', description: 'Optional base name: writes public/models/<name>_refined.glb (textured) and <name>_refined_clay.glb (and <name>_raw_clay.glb with isolate).' },
                thumbnails: { type: 'BOOLEAN', description: 'Also render raw-vs-output thumbnails (adds ~1-2 s).' }
            },
            required: ['tilePath']
        }
    }
];

export const tileRefineHandlers: Record<string, ToolHandler> = {
    tile_refine: async (args, ctx): Promise<ToolHandlerOutcome> => {
        try {
            const root = tileRefineRootFor(args.tilePath as string, ctx.workspaceRoot);
            const svc = getTileRefineService(root);
            const r = await svc.refine({
                tilePath: args.tilePath as string,
                anchor: args.anchor as TileRefineRequest['anchor'],
                roiRadius: typeof args.roiRadius === 'number' ? args.roiRadius : undefined,
                relief: typeof args.relief === 'boolean' ? args.relief : undefined,
                isolate: args.isolate === true ? (typeof args.apron === 'number' ? { apron: args.apron } : true) : undefined,
                publishAs: typeof args.publishAs === 'string' && args.publishAs.trim() ? args.publishAs.trim() : undefined,
                thumbnails: args.thumbnails === true
            });
            // Outside the workspace, paths are given absolute so later tools can open them. The /models URLs load from
            // <repo>/public, which the server serves after desktop-app/public (a same-named file there would win).
            const outside = root !== ctx.workspaceRoot;
            const shown = (p: string) => (outside ? p : path.relative(svc.workspaceRoot, p));
            const abs = (p: string | undefined) => (p === undefined ? undefined : path.join(svc.workspaceRoot, p));
            const published = r.published && outside
                ? {
                    ...r.published,
                    textured: abs(r.published.textured),
                    clay: abs(r.published.clay),
                    rawClay: abs(r.published.rawClay),
                    backups: r.published.backups.map(b => path.join(svc.workspaceRoot, b))
                }
                : r.published;
            return {
                status: 'completed',
                summaryResult: `Refined tile in ${(r.ms / 1000).toFixed(1)} s${r.cached ? ' (cached)' : ''}: ${r.stats.outputs?.triangles ?? '?'} triangles`,
                resultPayload: {
                    status: 'success',
                    texturedGlb: shown(r.texturedGlb),
                    clayGlb: shown(r.clayGlb),
                    rawClayGlb: r.rawClayGlb ? shown(r.rawClayGlb) : undefined,
                    thumbnailsDir: r.thumbnailsDir ? shown(r.thumbnailsDir) : undefined,
                    published,
                    cached: r.cached,
                    ms: r.ms,
                    stats: summarizeTileRefineStats(r.stats)
                }
            };
        } catch (err) {
            const code = err instanceof TileRefineError ? err.code : (err as { code?: string })?.code ?? 'failed';
            const message = err instanceof Error ? err.message : String(err);
            return {
                status: 'failed',
                summaryResult: `tile_refine failed: ${message}`,
                resultPayload: { status: 'error', code, message }
            };
        }
    }
};
