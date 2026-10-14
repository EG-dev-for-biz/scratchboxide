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

/** The file `tilePath` names under `root`, when it exists there and stays inside it. */
function existingWithin(root: string, tilePath: string): string | undefined {
    try {
        const file = resolveWithinRoot(root, tilePath);
        return fs.existsSync(file) ? file : undefined;
    } catch (err) {
        if (err instanceof PathTraversalError) return undefined;
        throw err;
    }
}

/**
 * The root tile_refine reads `tilePath` from. The tile extraction tools write <repo>/public/models (the checkout that
 * holds the tile_refine sources), while the server runs from desktop-app/, so the two roots differ. A relative path is
 * looked up in the checkout first, then the workspace, so a stale copy left under the workspace never shadows the
 * extraction's output; an absolute path is looked up in the workspace first. Falls back to the workspace, which then
 * reports the path as missing or outside it. When a relative path names two different files (size or modification
 * time), `note` says which one was used.
 */
export function tileRefineRootFor(tilePath: string, workspaceRoot: string): { root: string; note?: string } {
    const wanted = typeof tilePath === 'string' ? tilePath.trim() : '';
    if (!wanted) return { root: workspaceRoot };
    const repoRoot = findTileRefineRepoRoot();
    const found = (path.isAbsolute(wanted) ? [workspaceRoot, repoRoot] : [repoRoot, workspaceRoot])
        .map(root => ({ root, file: existingWithin(root, wanted) }))
        .filter((c): c is { root: string; file: string } => c.file !== undefined);
    if (found.length === 0) return { root: workspaceRoot };
    const [used, other] = found;
    if (!other || other.file === used.file) return { root: used.root };
    const a = fs.statSync(used.file);
    const b = fs.statSync(other.file);
    if (a.size === b.size && a.mtimeMs === b.mtimeMs) return { root: used.root };
    const describe = (s: fs.Stats) => `${s.size} bytes, modified ${s.mtime.toISOString()}`;
    return {
        root: used.root,
        note: `Two different copies of ${wanted} exist; used ${used.file} (${describe(a)}), not ${other.file} (${describe(b)}).`
    };
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
                facadeFlatten: { type: 'BOOLEAN', description: 'Flatten the scan\'s wall planes: vertices within 10 cm of a detected wall move onto it, deeper features stay (default true).' },
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
        // Set when the relative tilePath names two different files; the result says which one was refined.
        let note: string | undefined;
        try {
            const resolved = tileRefineRootFor(args.tilePath as string, ctx.workspaceRoot);
            const root = resolved.root;
            note = resolved.note;
            const svc = getTileRefineService(root);
            const r = await svc.refine({
                tilePath: args.tilePath as string,
                anchor: args.anchor as TileRefineRequest['anchor'],
                roiRadius: typeof args.roiRadius === 'number' ? args.roiRadius : undefined,
                relief: typeof args.relief === 'boolean' ? args.relief : undefined,
                facadeFlatten: typeof args.facadeFlatten === 'boolean' ? args.facadeFlatten : undefined,
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
                summaryResult: `Refined tile in ${(r.ms / 1000).toFixed(1)} s${r.cached ? ' (cached)' : ''}: ${r.stats.outputs?.triangles ?? '?'} triangles${note ? `. ${note}` : ''}`,
                resultPayload: {
                    status: 'success',
                    ...(note ? { note } : {}),
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
                summaryResult: `tile_refine failed: ${message}${note ? ` ${note}` : ''}`,
                resultPayload: { status: 'error', code, message, ...(note ? { note } : {}) }
            };
        }
    }
};
