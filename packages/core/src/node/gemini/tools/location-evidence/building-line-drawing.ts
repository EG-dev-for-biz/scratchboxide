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
import { parseGlbBytes, readAccessor } from '../../../3d-engine/staged-location/glb-bytes';
import { glbSoup } from '../../../3d-engine/staged-location/facade-lattice';
import { LINE_DRAWING_PARAMS, renderBuildingLineDrawings, type LineDrawingParams } from '../../../3d-engine/staged-location/building-line-drawing';
import { encodePng } from '../../../3d-engine/staged-location/png-encode';
import { readTileTriangles } from '../../../3d-engine/staged-location/tile-texture-transfer';
import { renderBlueprints, type BlueprintFacade, type BlueprintInputs, type BlueprintWall } from '../../../3d-engine/staged-location/building-blueprint';
import { detectSymmetry } from '../../../3d-engine/staged-location/pipeline-k/symmetry';
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

export interface BuildingLineDrawingRequest { runId?: string; glbPath?: string; texturedGlbPath?: string; /** A clean shell to draw the outline from (the measured twin's GLB); default: the run's twin when one is on disk. */ structureGlbPath?: string; photo?: boolean; pixelM?: number; creaseDeg?: number; minEdgeLenM?: number; outputDir?: string; /** 'blueprint' (default): the architect's sheets with the windows and symmetry; 'lines': the scan's lines and the photo's edges. */ style?: 'blueprint' | 'lines' }

/**
 * Pipeline K's reading of the cut-out beside a scan (its rectified orthos: tile_refine's relief_orthos_k_*, the newest
 * with window_fit.json): each facade's frame and windows. Undefined when K never read this cut-out.
 */
export function kReadingBeside(clayGlb: string): { dir: string; facades: BlueprintFacade[]; walls: BlueprintWall[] } | undefined {
    const root = path.dirname(clayGlb);
    const dirs = fs.readdirSync(root).filter(d => /^relief_orthos_k_[0-9a-f]+$/.test(d) && fs.existsSync(path.join(root, d, 'window_fit.json')) && fs.existsSync(path.join(root, d, 'facades.json')))
        .map(d => path.join(root, d)).sort((a, b) => fs.statSync(path.join(b, 'window_fit.json')).mtimeMs - fs.statSync(path.join(a, 'window_fit.json')).mtimeMs);
    if (!dirs.length) return undefined;
    const frames = (JSON.parse(fs.readFileSync(path.join(dirs[0], 'facades.json'), 'utf8')) as { facades: Array<BlueprintFacade['frame'] & { facadeId: number }> }).facades;
    const fit = (JSON.parse(fs.readFileSync(path.join(dirs[0], 'window_fit.json'), 'utf8')) as { facades: Array<{ facadeId: number; rects?: Array<[number, number, number, number]>; panes?: Array<[number, number, number, number]> }> }).facades;
    const facades: BlueprintFacade[] = [];
    for (const e of fit) { const frame = frames.find(f => f.facadeId === e.facadeId); if (frame && e.rects?.length) facades.push({ facadeId: e.facadeId, frame, rects: e.rects, ...(e.panes?.length ? { panes: e.panes } : {}) }); }
    // the wall grammar's recessed bays, per wall (wall_grammar.json), when K read them
    const wgFile = path.join(dirs[0], 'wall_grammar.json');
    const walls = fs.existsSync(wgFile) ? (JSON.parse(fs.readFileSync(wgFile, 'utf8')) as { walls?: BlueprintWall[] }).walls ?? [] : [];
    return { dir: dirs[0], facades, walls };
}

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
    const name = req.runId ?? path.basename(glb, '.glb');
    const outDir = req.outputDir ? within(req.outputDir) : path.join(stagedRoot, STAGED_CACHE, 'line_drawing', name);
    const wsDir = path.join(workspaceRoot || stagedRoot, 'renders', 'line-drawing', name);
    if ((req.style ?? 'blueprint') === 'blueprint') return blueprintOf(req, glb, soup, outDir, wsDir, roots);
    // the photo's edges: the textured scan beside the cut-out (tile_refine's textured.glb), or the one given
    const texturedPath = req.photo === false ? undefined : req.texturedGlbPath ? within(req.texturedGlbPath) : path.join(path.dirname(glb), 'textured.glb');
    const photo = texturedPath && fs.existsSync(texturedPath) ? readTileTriangles(fs.readFileSync(texturedPath)) : undefined;
    const { report, pngs } = renderBuildingLineDrawings(soup, undefined, P, photo);
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
    fs.writeFileSync(json, JSON.stringify({ source: glb, ...(photo ? { photoSource: texturedPath } : {}), ...report }, null, 1));
    const per = report.views.map(v => `${v.name} ${v.width}x${v.height} px at ${Math.round(v.pixelM * 1000) / 1000} m (silhouette ${v.silhouette.drawn}, crease ${v.crease.drawn}, open edges ${v.boundary.drawn}${v.photo ? `, photo edges ${v.photo.edgePixels} px` : ''})`).join('; ');
    return {
        summary: `${BUILDING_LINE_DRAWING_TOOL_NAME}: the scan's silhouette and creases, hidden lines removed, from ${report.views.length} views turned ${report.wallAzimuthDeg} degrees to face its walls (${per}); ${report.triangles.toLocaleString('en-US')} triangles; ${photo ? 'the geometry\'s lines measured, the facade detail from the photo\'s edges (photo-inferred)' : 'measured (geometry only: no textured scan found)'}. Files in ${wsDir}.`,
        payload: { source: glb, ...(photo ? { photoSource: texturedPath } : {}), reportJson: json, files, report }
    };
}

/** The twin's parts that draw the building's structure, and those that close its openings (depth only). */
const STRUCTURE_NODES = new Set(['massing', 'slender_top', 'ledge_profiles', 'roof_detail']), FILL_NODES = new Set(['openings']);

/** A GLB's triangles (no node transforms, as the measured twin writes) of the named nodes, as a soup. */
export function nodesSoup(glbFile: string, names: ReadonlySet<string>): Float32Array {
    const g = parseGlbBytes(fs.readFileSync(glbFile)), out: number[] = [];
    for (const n of g.json.nodes ?? []) {
        if (n.mesh === undefined || !names.has(n.name ?? '')) continue;
        for (const pr of g.json.meshes[n.mesh].primitives ?? []) {
            if ((pr.mode ?? 4) !== 4 || pr.attributes?.POSITION === undefined) continue;
            const P = readAccessor(g, pr.attributes.POSITION).data, I = pr.indices !== undefined ? readAccessor(g, pr.indices).data : undefined;
            const cnt = I ? I.length : P.length / 3;
            for (let k = 0; k + 2 < cnt; k += 3) for (let j = 0; j < 3; j++) { const v = I ? I[k + j] : k + j; out.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); }
        }
    }
    return Float32Array.from(out);
}

/** The blueprint sheets: K's windows beside the cut-out, its symmetry read natively there, the run's request as the title. */
async function blueprintOf(req: BuildingLineDrawingRequest, glb: string, soup: Float32Array, outDir: string, wsDir: string, roots: string[]): Promise<{ summary: string; payload: Record<string, unknown> }> {
    const k = kReadingBeside(glb);
    let lowest = Infinity;
    for (let i = 1; i < soup.length; i += 3) if (soup[i] < lowest) lowest = soup[i];
    // the photo's detail: the textured scan beside the cut-out (unless photo: false)
    const texturedPath = req.photo === false ? undefined : req.texturedGlbPath ?? path.join(path.dirname(glb), 'textured.glb');
    const photo = texturedPath && fs.existsSync(texturedPath) ? readTileTriangles(fs.readFileSync(texturedPath)) : undefined;
    // the clean shell: the measured twin's (given, or the run's on disk), its structure drawn and its openings closing the depth
    const roots0 = roots.find(r => req.runId && fs.existsSync(path.join(r, STAGED_CACHE, 'measured_twin', req.runId, 'measured_twin.glb')));
    const structurePath = req.structureGlbPath ?? (roots0 && req.runId ? path.join(roots0, STAGED_CACHE, 'measured_twin', req.runId, 'measured_twin.glb') : undefined);
    const structure = structurePath && fs.existsSync(structurePath) ? nodesSoup(structurePath, STRUCTURE_NODES) : undefined;
    const structureFill = structure && structurePath ? nodesSoup(structurePath, FILL_NODES) : undefined;
    const inputs: BlueprintInputs = { ...(k ? { facades: k.facades, walls: k.walls } : {}), ...(photo ? { photo } : {}), ...(structure && structure.length ? { structure, ...(structureFill && structureFill.length ? { structureFill } : {}) } : {}), note: req.runId ? `run ${req.runId}` : path.basename(glb) };
    let symmetryNote = 'no symmetry read (pipeline K wrote no facade photos beside the cut-out)';
    if (k) {
        try { inputs.symmetry = await detectSymmetry({ scanGlb: glb, groundY: lowest, footprint: [], orthosDir: k.dir }); symmetryNote = `symmetry read from the scan and the facade photos (${inputs.symmetry.facades.filter(f => f.detected && !f.periodic).length} facades mirror-symmetric)`; }
        catch (err) { symmetryNote = `the symmetry reading failed: ${err instanceof Error ? err.message : String(err)}`; }
    }
    if (req.runId) {
        const root = roots.find(r => fs.existsSync(path.join(r, STAGED_CACHE, 'runs', req.runId!, 'stages.json')));
        try { const st = JSON.parse(fs.readFileSync(path.join(root!, STAGED_CACHE, 'runs', req.runId, 'stages.json'), 'utf8')) as { request?: { query?: string } }; if (st.request?.query) inputs.title = st.request.query; } catch { /* untitled */ }
    }
    const { report, pngs } = renderBlueprints(soup, inputs);
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(wsDir, { recursive: true });
    const files: Array<{ view: string; label: string; path: string; svg: string; workspacePath: string }> = [];
    for (const p of pngs) {
        const v = report.views.find(x => x.name === p.name)!, base = `blueprint_${v.label.toLowerCase().replace(/\s+/g, '_')}.png`;
        const file = path.join(outDir, base), ws = path.join(wsDir, base), svg = file.replace(/\.png$/, '.svg'), wsSvg = ws.replace(/\.png$/, '.svg');
        fs.writeFileSync(file, encodePng(p.width, p.height, p.rgb, 3));
        fs.writeFileSync(svg, p.svg);
        if (ws !== file) { fs.copyFileSync(file, ws); fs.copyFileSync(svg, wsSvg); }
        files.push({ view: p.name, label: v.label, path: file, svg, workspacePath: ws });
    }
    const json = path.join(outDir, 'blueprint.json');
    fs.writeFileSync(json, JSON.stringify({ source: glb, ...(k ? { windowsFrom: k.dir } : {}), ...(inputs.structure ? { structureFrom: structurePath } : {}), ...report }, null, 1));
    const per = report.views.map(v => `${v.label.toLowerCase()} (${v.extentM[0]} x ${v.extentM[1]} m${v.bays ? `, ${v.bays} recessed bays` : ''}${v.windows ? `, ${v.windows} windows with ${v.panes} panes, ${v.spandrels} spandrels${v.mirroredWindows ? `, ${v.mirroredWindows} mirrored` : ''}` : ''}${v.ledges ? `, ${v.ledges} ledge runs` : ''}${v.duplicatesSkipped ? `, ${v.duplicatesSkipped} duplicates from overlapping readings left out` : ''}${v.levels.length ? `, ${v.levels.length} levels` : ''}${v.planAxes ? `, ${v.planAxes} centre line${v.planAxes > 1 ? 's' : ''}` : ''})`).join('; ');
    return {
        summary: `${BUILDING_LINE_DRAWING_TOOL_NAME}: the building's elevation set, four elevations square to its walls (${report.wallAzimuthDeg} degrees) and the roof plan: ${per}. The outline, ledges and levels are ${inputs.structure ? 'drawn from the measured twin\'s clean shell (fitted to the scan)' : 'measured from the scan'}; the windows are snapped to each facade\'s module (one width a column, one height a row) and, with the bays, panes and spandrels, ${k ? 'inferred from pipeline K\'s reading of the facades (its wall grammar, facade reader and window arrays: photo-inferred)' : 'not drawn (no pipeline K reading of this cut-out)'}; ${symmetryNote}; dashed windows are mirrors of windows about their facade\'s axis (generated)${photo ? '; the faint hairlines are the photo\'s strongest edges (photo-inferred)' : ''}. Files in ${wsDir}.`,
        payload: { source: glb, ...(k ? { windowsFrom: k.dir } : {}), ...(inputs.structure ? { structureFrom: structurePath } : {}), reportJson: json, files, report }
    };
}

export const BUILDING_LINE_DRAWING_TOOL_DECLARATION: ToolDeclaration = {
    name: BUILDING_LINE_DRAWING_TOOL_NAME,
    description: 'Draw a staged building as an architect\'s elevation set (the default): four elevations square to its walls and the roof plan, black line work on white, each with its levels (datum marks at the heights its setbacks and parapets run at), overall dimensions, a scale bar and a title block, constructed from what the pipeline infers about the building: ' +
        'the recessed bays and the piers between them (pipeline K\'s wall grammar), each window with its frame, mullions (its pane splits) and sill, the spandrel panels between stacked windows (the facade reader and the window arrays), all photo-inferred; the scan\'s outline with its ledges and cornice bands doubled, measured; each facade\'s mirror axis and the building\'s plan mirrors as centre lines, and a window mirrored about its facade\'s axis into an empty site dashed (generated). Line weights follow an architect\'s hierarchy. ' +
        'style "lines" instead draws the scan as plain line drawings: its silhouette edges (black), crease edges (dark grey: corners, setbacks, cornices, pier sides, where two surfaces meet at creaseDeg or more) and open edges (light grey: the scan\'s own holes and cuts), with hidden lines removed, ' +
        'from four sides square to the building\'s own walls (their dominant direction measured from the scan) and from above (the roof plan, which shows the terraces and setbacks). A geometric guide to what the scan measures on every surface. Geometry only, no model call: every line is a measured edge of the scan. ' +
        'With the textured scan (found beside the run\'s cut-out, or texturedGlbPath) the facade detail the geometry is too coarse to hold (windows, bands, spandrels, mullions) is added from the photo: its strongest edges, mid grey, labelled photo-inferred (an edge in the photo may also be a shadow or a smear); the geometry\'s lines stay measured. ' +
        'The elevation set draws the design, not the evidence: each facade\'s windows snapped to its module (one width a column, one height a row), the outline from the run\'s measured twin when there is one (its clean shell, fitted to the scan), and every sheet written as SVG beside its PNG. ' +
        'Writes one PNG per view (and, for the elevation set, an SVG), a JSON report (each view\'s frame, so a pixel maps back to the scan, and what was drawn) and copies them into the workspace under renders/line-drawing/. ' +
        'Give runId (a staged run: its cut-out scan is drawn) or glbPath (any GLB without node transforms).',
    parameters: {
        type: 'OBJECT',
        properties: {
            runId: { type: 'STRING', description: 'A staged-location run id (8 hex digits); its cut-out scan (tile_refine clay.glb) is drawn. Default: the staged build open in the viewport.' },
            glbPath: { type: 'STRING', description: 'Instead of a run: a GLB (path or /models/... URL) whose triangles carry no node transforms.' },
            structureGlbPath: { type: 'STRING', description: 'A clean shell (the measured twin\'s GLB) to draw the outline from instead of the raw scan (default: the run\'s twin when one is on disk).' },
            texturedGlbPath: { type: 'STRING', description: 'The textured scan whose photo edges add the facade detail (default: textured.glb beside the cut-out).' },
            photo: { type: 'BOOLEAN', description: 'false: no photo edges (in the elevation set, the faint detail hairlines; in "lines", the facade detail). Default true when a textured scan is found.' },
            style: { type: 'STRING', description: '"blueprint" (default): the architect\'s elevation set with bays, windows, spandrels, ledges, levels, dimensions and symmetry. "lines": the scan\'s lines and the photo\'s edges.' },
            pixelM: { type: 'NUMBER', description: 'Metres per pixel (default 0.1); coarsened so no view passes 4096 px on its long side.' },
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
        const pixelM = num(args.pixelM), creaseDeg = num(args.creaseDeg), minEdgeLenM = num(args.minEdgeLenM), outputDir = str(args.outputDir), glbPath = str(args.glbPath), texturedGlbPath = str(args.texturedGlbPath), structureGlbPath = str(args.structureGlbPath);
        const r = await runBuildingLineDrawing({ ...(runId ? { runId } : {}), ...(glbPath ? { glbPath } : {}), ...(pixelM !== undefined ? { pixelM } : {}), ...(creaseDeg !== undefined ? { creaseDeg } : {}), ...(minEdgeLenM !== undefined ? { minEdgeLenM } : {}), ...(outputDir ? { outputDir } : {}), ...(texturedGlbPath ? { texturedGlbPath } : {}), ...(structureGlbPath ? { structureGlbPath } : {}), ...(args.photo === false ? { photo: false } : {}), ...(args.style === 'lines' || args.style === 'blueprint' ? { style: args.style } : {}) }, ctx.workspaceRoot);
        return { status: 'completed', summaryResult: r.summary, resultPayload: { status: 'success', ...r.payload } };
    } catch (err) {
        const code = err instanceof BuildingLineDrawingError ? err.code : 'draw_failed';
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'failed', summaryResult: `${BUILDING_LINE_DRAWING_TOOL_NAME} (${code}): ${msg}`, resultPayload: { status: 'error', code, error: msg } };
    }
};
