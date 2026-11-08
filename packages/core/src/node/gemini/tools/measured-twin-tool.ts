/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_measured_twin: the measured procedural twin of a staged pipeline K building (measured-twin.ts over
 * scratchbox_measured_twin.hpp), generated from what the build measured and shown beside it in the open scene. Part of
 * the Google 3D Tiles pack (spatial-tools.ts). Makes no model call and fetches nothing: it reads the finished build's
 * records from the staged cache and its library maps from the model readings store.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { CanvasArtifact, Media4DObject, Scene3DData } from '../../../browser/generative-canvas/canvas-types';
import { NativeTilePathTracerService } from '../../3d-engine/native-tile-path-tracer-service';
import { buildMeasuredTwin, type MeasuredTwinResult } from '../../3d-engine/staged-location/measured-twin/measured-twin';
import { fileReadingStore, modelReadingsDir } from '../../3d-engine/staged-location/pipeline-k/model-readings';
import { stagedWorkspaceRoot } from '../../3d-engine/staged-location/stage-cache';
import type { ToolContext, ToolDeclaration, ToolHandlerOutcome } from './types';

export const MEASURED_TWIN_TOOL = 'location_measured_twin';

export const MEASURED_TWIN_DECLARATION: ToolDeclaration = {
    name: MEASURED_TWIN_TOOL,
    description:
        'Generate a procedural twin of the staged building from what its pipeline K build measured, with none of the scan\'s surface in it, and show it beside the build in the open scene. ' +
        'The massing is the scan\'s height-map tiers (and a revolved, stepped slender top such as a mast when the scan has one), measured; every window box the build kept is punched into the walls and recessed, photo-inferred; ' +
        'each wall cell, window, frame and roof cell takes its colour from the scan\'s own photo and its material from the build\'s measured appearance classes. ' +
        'Windows the build left unread are continued along their row only where the photo looks like a window, and a reading that put neighbouring columns half a storey apart is put back on the wall\'s storey rhythm; both are labelled generated, as is the reveal depth unless Street View read one. ' +
        'Needs a finished pipeline K build (the 3D Building default) of one building, or with kFree any staged run with a cut-out scan; makes no model call and fetches nothing. Returns four path-traced proof views and the GLB, both copied into the workspace (renders/measured-twin/<runId>/, paths relative to the workspace) for viewing, rendering or judging. ' +
        'Use it when the user asks for a procedural, generated or lightweight version of the staged building, or to compare a procedural rebuild with the scan-based one.',
    parameters: {
        type: 'OBJECT',
        properties: {
            runId: { type: 'STRING', description: 'Optional: the staged build\'s run id (8 hex). Default: the open scene\'s staged build.' },
            gapM: { type: 'NUMBER', description: 'Optional: metres between the build and the twin placed beside it (default 20).' },
            scanDetailM: { type: 'NUMBER', description: 'Optional: keep the scan\'s own surface (Google 3D Tiles, measured) wherever it stands at least this many metres outside the procedural shell (e.g. 0.3: terrace objects, statues, antenna equipment, ornament the shell misses); its parapet and roof blocks are then left out. Omit or 0 for a fully procedural twin with no scan surface.' },
            kFree: { type: 'BOOLEAN', description: 'Optional: read nothing of pipeline K, only the staged run\'s cut-out scan and its photo texture (any pipeline\'s run with a remesh stage): the street level is estimated from the scan, each wall\'s photo rendered from the texture and its windows found in it by the twin\'s own detector (no model call). Default false: the twin uses the K build\'s window boxes, frames and materials.' },
            reliefM: { type: 'NUMBER', description: 'Optional: purely procedural detail down to this size (e.g. 0.3): relief maps of the scan on the walls, roofs and mast in 0.3 m cells, and whatever stands at least this far off the shell rebuilt as measured blocks, with no scan surface kept. Ignored when scanDetailM is given.' }
        }
    }
};

const RUN_ID = /^[0-9a-f]{8}$/;

/** The twin's GLB under public/models/measured-twin/, named by its bytes. */
function publish(glb: string, runId: string, root: string): { uri: string; file: string } {
    const bytes = fs.readFileSync(glb);
    const name = `${runId}-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.glb`;
    const dir = path.join(root, 'public', 'models', 'measured-twin');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) fs.copyFileSync(glb, file);
    return { uri: `/models/measured-twin/${name}`, file };
}

/** The twin as an objects[] entry, beside the building: moved along +x by the scan's width and the gap. */
export function measuredTwinObject(runId: string, uri: string, offsetX: number, meta: Record<string, unknown>): Media4DObject {
    return {
        id: `measured-twin-${runId}`,
        content: {
            type: '3d-model',
            durableUri: uri,
            mimeType: 'model/gltf-binary',
            metadata: { source: 'measured_twin', role: 'hero', provenance: 'measured', metricScale: 1.0, groundDatumMeters: 0.0, ...meta }
        } as Media4DObject['content'],
        space: { spatial3d: { x: offsetX, y: 0, z: 0 } } as Media4DObject['space'],
        time: { startMs: 0, durationMs: 20000 } as Media4DObject['time'],
        lineage: { version: 1 } as Media4DObject['lineage']
    };
}

/**
 * Proof views of the twin, path traced in the tile frame: two obliques of the whole building, a close view of the
 * facade at a third of its height, and a look down on the top. Shown to the chat model and to the turn's reviewer.
 */
export async function renderTwinViews(r: MeasuredTwinResult, outDir: string, signal?: AbortSignal): Promise<Array<{ path: string; label: string }>> {
    const pts = r.records.loops.flat();
    const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const g = r.records.groundY, H = r.report.topM, plan = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
    const radius = Math.hypot(plan, H) / 2;
    const at = (headingDeg: number, pitchDeg: number, dist: number, target: number[]) => {
        const h = headingDeg * Math.PI / 180, p = pitchDeg * Math.PI / 180;
        const look = [Math.sin(h) * Math.cos(p), -Math.sin(p), -Math.cos(h) * Math.cos(p)];
        return { position: target.map((c, k) => c - look[k] * dist), target };
    };
    const whole = [cx, g + H / 2, cz];
    const views = [
        { name: 'oblique_45', label: 'whole building, 45 degrees, 15 degrees down', cam: at(45, 15, 2.2 * radius / Math.tan(17.5 * Math.PI / 180) / 2, whole), fov: 35 },
        { name: 'oblique_225', label: 'whole building, 225 degrees, 15 degrees down', cam: at(225, 15, 2.2 * radius / Math.tan(17.5 * Math.PI / 180) / 2, whole), fov: 35 },
        { name: 'facade_close', label: 'facade close-up at a third of the height', cam: at(135, 5, plan * 0.9, [cx, g + H / 3, cz]), fov: 40 },
        { name: 'top', label: 'the top, from above', cam: at(315, 35, Math.max(60, H * 0.35), [cx, g + H * 0.8, cz]), fov: 45 }
    ];
    const tracer = new NativeTilePathTracerService();
    const out: Array<{ path: string; label: string }> = [];
    fs.mkdirSync(path.join(outDir, 'views'), { recursive: true });
    for (const v of views) {
        if (signal?.aborted) break;
        const work = path.join(outDir, 'views', `work_${v.name}`);
        const res = await tracer.render({ glbPath: r.glb, outputDir: work, sun: { elevationDeg: 45, azimuthDeg: 135 }, width: 640, height: 800, samplesPerPixel: 16, maxBounces: 2, shadingMode: 'relit', denoise: true, groundPlane: false, camera: { ...v.cam, verticalFovDeg: v.fov } } as Parameters<NativeTilePathTracerService['render']>[0]);
        if (!res.success) continue;
        const png = path.join(outDir, 'views', `${v.name}.png`);
        fs.copyFileSync(res.beautyPngPath, png);
        fs.rmSync(work, { recursive: true, force: true });
        out.push({ path: png, label: v.label });
    }
    return out;
}

export async function runMeasuredTwinTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolHandlerOutcome> {
    const active = ctx?.request?.activeArtifact;
    const scene = active?.type === '3d-scene' ? (active.data as Scene3DData & { stagedBuild?: { runId?: string } }) : undefined;
    const runId = typeof args.runId === 'string' && args.runId.trim() ? args.runId.trim() : scene?.stagedBuild?.runId;
    if (!runId || !RUN_ID.test(runId)) throw new Error(`${MEASURED_TWIN_TOOL}: no staged build to make a twin of (open a scene staged with the 3D Building button or google_3d_tiles_get_clay, or give its runId)`);
    const root = stagedWorkspaceRoot();
    const cacheRoot = path.join(root, '.scratchbox', 'cache');
    const runDir = path.join(cacheRoot, 'staged_location', 'runs', runId);
    if (!fs.existsSync(runDir)) throw new Error(`${MEASURED_TWIN_TOOL}: run ${runId} is not in this machine's staged cache (${runDir})`);
    ctx.reportProgress?.('measured twin: reading the build\'s measurements', 0.1);
    const outDir = path.join(cacheRoot, 'staged_location', 'measured_twin', runId);
    const scanDetailM = typeof args.scanDetailM === 'number' && Number.isFinite(args.scanDetailM) && args.scanDetailM > 0 ? args.scanDetailM : undefined;
    const reliefM = !scanDetailM && typeof args.reliefM === 'number' && Number.isFinite(args.reliefM) && args.reliefM > 0 ? args.reliefM : undefined;
    const kFree = args.kFree === true;
    const options = { ...(scanDetailM ? { scanDetailM } : reliefM ? { reliefM } : {}), ...(kFree ? { kFree } : {}) };
    const r = await buildMeasuredTwin({ runDir, cacheRoot, outDir, ...(Object.keys(options).length ? { options } : {}), store: fileReadingStore(modelReadingsDir(path.join(cacheRoot, 'staged_location'))), ...(ctx.signal ? { signal: ctx.signal } : {}) });
    ctx.reportProgress?.('measured twin: generated', 0.9);
    const { uri, file } = publish(r.glb, runId, root);
    ctx.reportProgress?.('measured twin: rendering proof views', 0.95);
    const rendered = await renderTwinViews(r, outDir, ctx.signal).catch(() => []);
    // the GLB and its views copied into the chat's workspace, so the agent's file, render and judge tools (which only
    // read inside it) take them as they are: renders/measured-twin/<runId>/
    const ws = ctx.workspaceRoot || root;
    const wsDir = path.join(ws, 'renders', 'measured-twin', runId);
    fs.mkdirSync(wsDir, { recursive: true });
    const wsGlb = path.join(wsDir, 'measured_twin.glb');
    fs.copyFileSync(r.glb, wsGlb);
    const views = rendered.map(v => { const to = path.join(wsDir, path.basename(v.path)); fs.copyFileSync(v.path, to); return { path: to, label: v.label }; });
    const rel = (f: string) => path.relative(ws, f);
    const xsAll = r.records.loops.flat().map(p => p[0]), zsAll = r.records.loops.flat().map(p => p[1]);
    const facts = {
        glbFile: rel(wsGlb), servedAt: file, heightM: Math.round(r.report.topM * 10) / 10, footprintM: [Math.round((Math.max(...xsAll) - Math.min(...xsAll)) * 10) / 10, Math.round((Math.max(...zsAll) - Math.min(...zsAll)) * 10) / 10],
        tiers: r.report.tiers, slenderTopFromM: r.report.slender.fromM, windows: r.report.windows, triangles: r.report.triangles,
        views: views.map(v => rel(v.path)), workspaceRoot: ws
    };
    const modelImages = views.map(v => ({ path: v.path, mimeType: 'image/png', label: `measured twin: ${v.label}` }));
    const w = r.report.windows;
    const summary = `Measured procedural twin of run ${runId}: ${r.report.tiers} tiers from the scan's height map${r.report.slender.fromM !== null && r.report.slender.bands ? `, a revolved slender top from ${r.report.slender.fromM.toFixed(1)} m in ${r.report.slender.bands} measured bands` : ''} up to ${r.report.topM.toFixed(1)} m; `
        + `${w.placed} windows punched (${w.placed - w.generated} where the build read them, ${w.continued} continued along their rows where the photo shows a window, ${w.rephased} put back on their wall's storey rhythm: generated), reveal ${r.report.revealM.toFixed(2)} m (${r.report.revealLabel}); `
        + (kFree ? `K-free: walls photographed from the scan's texture (${r.report.heads.selfWalls}), windows found in ${r.report.heads.selfWindowWalls} of them; ` : '')
        + (r.report.relief.thresholdM > 0 ? `procedural relief down to ${r.report.relief.thresholdM} m: ${r.report.relief.wallPieces} wall pieces (${Math.round(r.report.relief.wallAreaM2)} m²), ${r.report.roofDetail.pieces} roof pieces, ${r.report.relief.mastPieces} mast pieces, as measured blocks (no scan surface); ` : '')
        + (r.report.scanDetail.pieces ? `the scan's own surface kept in ${r.report.scanDetail.pieces} pieces (${Math.round(r.report.scanDetail.areaM2)} m²) where it stands ${r.report.scanDetail.thresholdM} m or more outside the shell (measured, scan); ` : '')
        + `${views.length} proof views rendered (${views.map(v => path.basename(v.path)).join(', ')}); `
        + `${r.report.colour.elements} elements coloured from the scan's photo${r.report.colour.uncoloured ? `, ${r.report.colour.uncoloured} with no photo near taking their wall's colour` : ''}; ${r.report.triangles.toLocaleString('en-US')} triangles. No scan surface is in it.`
        + (r.mapsMissing.length ? ` Library maps not in this machine's readings store: ${r.mapsMissing.join(', ')} (those materials have no relief maps).` : '');
    const meta = { runId, version: r.version, report: r.report, reveal: r.records.reveal };
    const xs0 = r.records.loops.flat().map(p => p[0]), zs0 = r.records.loops.flat().map(p => p[1]);
    if (!active || !scene) {
        // no staged scene open: a studio scene of its own, framed on the twin
        const cx = (Math.min(...xs0) + Math.max(...xs0)) / 2, cz = (Math.min(...zs0) + Math.max(...zs0)) / 2, top = r.records.groundY + r.report.topM;
        const d = Math.max(60, r.report.topM * 1.3);
        const title = `Measured twin (run ${runId})`;
        const artifact = {
            id: `artifact-3d-measured-twin-${runId}`, type: '3d-scene', title, summary,
            data: {
                title, subtitle: 'Procedural twin generated from a pipeline K build\'s measurements', sceneType: 'custom', renderMode: 'pbr', cameraMode: 'orbit',
                camera: { position: [cx + d * 0.6, r.records.groundY + top * 0.45, cz + d * 0.8], target: [cx, r.records.groundY + r.report.topM * 0.45, cz], fov: 45 },
                environment: { skybox: 'studio', lighting: 'studio', ground: false },
                objects: [measuredTwinObject(runId, uri, 0, meta)]
            }
        } as unknown as CanvasArtifact;
        return { resultPayload: { success: true, glbPath: facts.glbFile, viewerUrl: uri, ...facts, report: r.report, modelImages, artifact }, summaryResult: summary };
    }
    const gap = typeof args.gapM === 'number' && Number.isFinite(args.gapM) ? Math.max(0, args.gapM) : 20;
    // beside a staged build (its layers stand at the place); in a scene with no staged build (an earlier twin's own), in place
    const offsetX = scene.stagedBuild ? (xs0.length ? Math.max(...xs0) - Math.min(...xs0) : 100) + gap : 0;
    const obj = measuredTwinObject(runId, uri, offsetX, meta);
    const objects = [...(scene.objects ?? []).filter((o: Media4DObject) => o.id !== obj.id), obj];
    const artifact: CanvasArtifact = { ...active, data: { ...scene, objects } as Scene3DData, version: ((active as { version?: number }).version || 1) + 1 } as CanvasArtifact;
    return { resultPayload: { success: true, glbPath: facts.glbFile, viewerUrl: uri, ...facts, report: r.report, modelImages, artifact }, summaryResult: summary };
}
