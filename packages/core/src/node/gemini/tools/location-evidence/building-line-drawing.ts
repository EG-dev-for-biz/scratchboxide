/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_building_line_drawing: a staged building's scan drawn as line drawings (building-line-drawing.ts): its
 * silhouette and crease edges, hidden-line removed, as north, east, south and west elevations and a roof plan. A
 * geometric guide to what the scan measures, on every surface, the roofs and setbacks included. Geometry only, no model
 * call; every line is measured.
 *
 * Input: runId (a staged run: its cut-out scan, tile_refine's clay.glb, found through the run's notes) or glbPath (any GLB
 * whose triangles carry no node transforms). Writes one PNG per view and line_drawing.json (the views' frames, so a
 * pixel maps back to the scan, and the edges found and drawn by class) into the staged cache, and copies the PNGs into
 * the chat's workspace under renders/line-drawing/<name>/ for the agent's image tools.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome } from '../types';
import { parseGlbBytes } from '../../../3d-engine/staged-location/glb-bytes';
import { glbSoup } from '../../../3d-engine/staged-location/facade-lattice';
import { LINE_DRAWING_PARAMS, renderBuildingLineDrawings, type LineDrawingParams } from '../../../3d-engine/staged-location/building-line-drawing';
import { encodePng } from '../../../3d-engine/staged-location/png-encode';
import { stagedWorkspaceRoot } from '../../../3d-engine/staged-location/stage-cache';

export const BUILDING_LINE_DRAWING_TOOL_NAME = 'location_building_line_drawing';

export class BuildingLineDrawingError extends Error {
    constructor(readonly code: 'no_input' | 'not_found' | 'no_triangles' | (string & {}), message: string) { super(message); this.name = 'BuildingLineDrawingError'; }
}

const STAGED_CACHE = path.join('.scratchbox', 'cache', 'staged_location');

/** A staged run's cut-out scan: the tile_refine folder its remesh entry or any of its notes names, holding clay.glb. */
export function scanOfRun(roots: string[], runId: string): string {
    if (!/^[0-9a-f]{8}$/.test(runId)) throw new BuildingLineDrawingError('no_input', `runId "${runId}" is not a staged run id (8 hex digits)`);
    const root = roots.find(r => fs.existsSync(path.join(r, STAGED_CACHE, 'runs', runId, 'stages.json')));
    if (!root) throw new BuildingLineDrawingError('not_found', `no staged run ${runId} under ${roots.join(' or ')}`);
    const runDir = path.join(root, STAGED_CACHE, 'runs', runId), cacheRoot = path.join(root, '.scratchbox', 'cache');
    const texts: string[] = [];
    const key = (JSON.parse(fs.readFileSync(path.join(runDir, 'stages.json'), 'utf8')) as { keys?: Record<string, string> }).keys?.remesh;
    const done = key ? path.join(cacheRoot, 'staged_location', 'remesh', key, 'done.json') : '';
    if (done && fs.existsSync(done)) texts.push(fs.readFileSync(done, 'utf8'));
    for (const f of fs.readdirSync(runDir)) if (f.endsWith('.json')) { try { texts.push(fs.readFileSync(path.join(runDir, f), 'utf8')); } catch { /* unreadable: skipped */ } }
    for (const t of texts) for (const m of t.matchAll(/tile_refine\/([0-9a-f]{64})/g)) {
        const clay = path.join(cacheRoot, 'tile_refine', m[1], 'clay.glb');
        if (fs.existsSync(clay)) return clay;
    }
    throw new BuildingLineDrawingError('not_found', `staged run ${runId} names no cut-out scan (tile_refine/<key>/clay.glb) on this machine`);
}

export interface BuildingLineDrawingRequest { runId?: string; glbPath?: string; pixelM?: number; creaseDeg?: number; minEdgeLenM?: number; outputDir?: string }

export async function runBuildingLineDrawing(req: BuildingLineDrawingRequest, workspaceRoot: string, stagedRoot = stagedWorkspaceRoot()): Promise<{ summary: string; payload: Record<string, unknown> }> {
    const roots = [...new Set([stagedRoot, workspaceRoot].filter(Boolean))];
    const within = (p: string) => {
        if (/^\/models\//.test(p)) return path.join(stagedRoot, 'public', p.slice(1));
        if (path.isAbsolute(p)) return p;
        return roots.map(r => path.join(r, p)).find(f => fs.existsSync(f)) ?? path.join(roots[0], p);
    };
    const glb = req.glbPath ? within(req.glbPath) : req.runId ? scanOfRun(roots, req.runId) : undefined;
    if (!glb) throw new BuildingLineDrawingError('no_input', 'give runId or glbPath (or open a staged build in the viewport)');
    if (!fs.existsSync(glb)) throw new BuildingLineDrawingError('not_found', `no GLB at ${glb}`);
    const soup = glbSoup(parseGlbBytes(fs.readFileSync(glb)));
    if (soup.length < 9) throw new BuildingLineDrawingError('no_triangles', `${glb} holds no triangles`);
    const P: LineDrawingParams = {
        ...LINE_DRAWING_PARAMS,
        ...(req.pixelM !== undefined && req.pixelM > 0 ? { pixelM: req.pixelM } : {}),
        ...(req.creaseDeg !== undefined && req.creaseDeg > 0 && req.creaseDeg < 180 ? { creaseDeg: req.creaseDeg } : {}),
        ...(req.minEdgeLenM !== undefined && req.minEdgeLenM >= 0 ? { minEdgeLenM: req.minEdgeLenM } : {})
    };
    const { report, pngs } = renderBuildingLineDrawings(soup, undefined, P);
    const name = req.runId ?? path.basename(glb, '.glb');
    const outDir = req.outputDir ? within(req.outputDir) : path.join(stagedRoot, STAGED_CACHE, 'line_drawing', name);
    const wsDir = path.join(workspaceRoot || stagedRoot, 'renders', 'line-drawing', name);
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(wsDir, { recursive: true });
    const files: Array<{ view: string; path: string; workspacePath: string }> = [];
    for (const p of pngs) {
        const file = path.join(outDir, `${p.name}.png`), ws = path.join(wsDir, `${p.name}.png`);
        fs.writeFileSync(file, encodePng(p.width, p.height, p.rgb, 3));
        if (ws !== file) fs.copyFileSync(file, ws);
        files.push({ view: p.name, path: file, workspacePath: ws });
    }
    const json = path.join(outDir, 'line_drawing.json');
    fs.writeFileSync(json, JSON.stringify({ source: glb, ...report }, null, 1));
    const per = report.views.map(v => `${v.name} ${v.width}x${v.height} px at ${Math.round(v.pixelM * 1000) / 1000} m (silhouette ${v.silhouette.drawn}, crease ${v.crease.drawn}, open edges ${v.boundary.drawn})`).join('; ');
    return {
        summary: `${BUILDING_LINE_DRAWING_TOOL_NAME}: the scan's silhouette and creases, hidden lines removed, from ${report.views.length} views turned ${report.wallAzimuthDeg} degrees to face its walls (${per}); ${report.triangles.toLocaleString('en-US')} triangles; measured (geometry only). Files in ${wsDir}.`,
        payload: { source: glb, reportJson: json, files, report }
    };
}

export const BUILDING_LINE_DRAWING_TOOL_DECLARATION: ToolDeclaration = {
    name: BUILDING_LINE_DRAWING_TOOL_NAME,
    description: 'Draw a staged building\'s scan as line drawings, the way elevations and a plan draw a building: its silhouette edges (black), crease edges (dark grey: corners, setbacks, cornices, pier sides, where two surfaces meet at creaseDeg or more) and open edges (light grey: the scan\'s own holes and cuts), with hidden lines removed, ' +
        'from four sides square to the building\'s own walls (their dominant direction measured from the scan) and from above (the roof plan, which shows the terraces and setbacks). A geometric guide to what the scan measures on every surface. Geometry only, no model call: every line is a measured edge of the scan. ' +
        'Writes one PNG per view and line_drawing.json (each view\'s frame, so a pixel maps back to the scan, and the edges found and drawn by kind) and copies the PNGs into the workspace under renders/line-drawing/. ' +
        'Give runId (a staged run: its cut-out scan is drawn) or glbPath (any GLB without node transforms).',
    parameters: {
        type: 'OBJECT',
        properties: {
            runId: { type: 'STRING', description: 'A staged-location run id (8 hex digits); its cut-out scan (tile_refine clay.glb) is drawn. Default: the staged build open in the viewport.' },
            glbPath: { type: 'STRING', description: 'Instead of a run: a GLB (path or /models/... URL) whose triangles carry no node transforms.' },
            pixelM: { type: 'NUMBER', description: 'Metres per pixel (default 0.12); coarsened so no view passes 2400 px on its long side.' },
            creaseDeg: { type: 'NUMBER', description: 'Two surfaces meeting at this angle or more draw a crease line (default 25).' },
            minEdgeLenM: { type: 'NUMBER', description: 'Edges shorter than this (metres) are mesh noise and not drawn (default 0.3).' },
            outputDir: { type: 'STRING', description: 'Where to write (default: .scratchbox/cache/staged_location/line_drawing/<run>).' }
        }
    }
};

export const buildingLineDrawingHandler: ToolHandler = async (args, ctx): Promise<ToolHandlerOutcome> => {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    try {
        const active = ctx.request?.activeArtifact?.type === '3d-scene' ? (ctx.request.activeArtifact.data as { stagedBuild?: { runId?: string } } | undefined)?.stagedBuild : undefined;
        const runId = str(args.runId) ?? (!str(args.glbPath) ? active?.runId : undefined);
        const pixelM = num(args.pixelM), creaseDeg = num(args.creaseDeg), minEdgeLenM = num(args.minEdgeLenM), outputDir = str(args.outputDir), glbPath = str(args.glbPath);
        const r = await runBuildingLineDrawing({ ...(runId ? { runId } : {}), ...(glbPath ? { glbPath } : {}), ...(pixelM !== undefined ? { pixelM } : {}), ...(creaseDeg !== undefined ? { creaseDeg } : {}), ...(minEdgeLenM !== undefined ? { minEdgeLenM } : {}), ...(outputDir ? { outputDir } : {}) }, ctx.workspaceRoot);
        return { status: 'completed', summaryResult: r.summary, resultPayload: { status: 'success', ...r.payload } };
    } catch (err) {
        const code = err instanceof BuildingLineDrawingError ? err.code : 'draw_failed';
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'failed', summaryResult: `${BUILDING_LINE_DRAWING_TOOL_NAME} (${code}): ${msg}`, resultPayload: { status: 'error', code, error: msg } };
    }
};
