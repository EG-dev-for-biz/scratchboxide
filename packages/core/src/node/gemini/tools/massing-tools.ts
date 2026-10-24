/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * structure_massing: the massing of the staged structure on the canvas, read from its isolated scan and chosen by
 * measurement (sb.massing, scratchbox_scan_massing.hpp / scratchbox_roof_objects.hpp). Candidates, simplest first: the
 * footprint raised with its walls on the scanned walls (block); the block with the objects standing on its roof (outlines
 * from the photo straight down, heights from the scan); a stack of tiers, one per setback; lofted sections following
 * tapers, legs and overhangs. The first that explains the scan height band by height band (coverage with a relief
 * allowance, precision at 1 m) wins; the scores of all are reported. The result joins the staged scene in its frame,
 * labelled generated. No structure type is consulted.
 */

import * as fs from 'fs';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolResultPayload } from './types';
import { NativePythonRunnerService } from '../../3d-engine/native-python-runner-service';
import { publishToModels, roofPhotoFor, structureScanOf } from './python-3d-tools';

export const STRUCTURE_MASSING_TOOL_NAME = 'structure_massing';

export const STRUCTURE_MASSING_DECLARATION: ToolDeclaration = {
    name: STRUCTURE_MASSING_TOOL_NAME,
    description: 'Build the massing of the staged 3D Building open on the canvas from its isolated scan, choosing between candidate shapes by how well each explains the scan: a block whose walls sit on the scanned walls; that block with the objects standing on its roof (tanks, bulkheads, plant, rails; outlines from the photo straight down, heights from the scan); a stack of tiers, one per setback; lofted sections that follow tapers, legs and overhangs. The simplest candidate that explains the scan height band by height band wins (coverage within a relief allowance, precision within 1 m); every candidate\'s scores and the roof objects are reported. The chosen massing joins the scene in place, labelled generated. Needs a staged 3D Building scene on the canvas (google_3d_tiles_get_clay with isolate/procedural); it fails with a clear reason otherwise.',
    parameters: {
        type: 'OBJECT',
        properties: {
            relief: { type: 'NUMBER', description: 'Scan surface within this many metres of a candidate counts as explained (facade relief is detail for later stages, not missed shape). Default 2.5.' },
            minCoverage: { type: 'NUMBER', description: 'Least height-balanced coverage of the scan for a candidate to explain it (default 0.9).' },
            minPrecision: { type: 'NUMBER', description: 'Least height-balanced share of a candidate\'s visible surface that lies on the scan (default 0.85).' },
            candidate: { type: 'STRING', description: 'Build this candidate whatever the scores say ("block", "block + roof objects", "tiers", "lofted sections"); its scores are still reported. Omit to let the measurements choose.' }
        }
    }
};

/** The fixed script the tool runs: the choice, the chosen mesh written, the report as one JSON line. */
const MASSING_SCRIPT = `
import json, os
import scratchbox as sb
args = json.loads(os.environ["SB_MASSING_ARGS"])
scan = sb.massing.Scan.from_scene()
cands = scan.candidates()
choice = sb.massing.choose(scan, cands, args["minCoverage"], args["minPrecision"], args["relief"])
chosen = choice.candidate
if args.get("candidate"):
    forced = [c for c in cands if c.label == args["candidate"]]
    if not forced:
        raise SystemExit("no candidate named %r (candidates: %s)" % (args["candidate"], ", ".join(c.label for c in cands)))
    chosen = forced[0]
if chosen is None:
    raise SystemExit("no candidate could be scored against the scan: " + choice.why)
roof = next((c.roof for c in cands if c.roof), None)
tiers = next((c.tiers for c in cands if c.tiers), None)
scene = sb.Scene()
scene.add_mesh(chosen.mesh)
sb.io.write_glb(OUTPUT_GLB_PATH, scene)
report = {
    "chosen": chosen.label, "forced": bool(args.get("candidate")), "explains": choice.explains, "why": choice.why,
    "candidates": choice.rows, "groundY": scan.ground_y, "roofY": scan.roof_y(), "top": scan.top(), "samples": len(scan.samples),
    "roof": None if roof is None else {"photo": roof["photo"], "objects": [
        {"chosen": o["chosen"], "rise": round(o["top_y"] - o["base_y"], 2), "area": round(o["area"], 2), "outline": o["outline_source"], "height": o["height_source"], "why": o["why"]}
        for o in roof["objects"]]},
    "tiers": None if tiers is None else [{"y0": round(t.y0, 2), "y1": round(t.y1, 2), "area": round(t.area, 1)} for t in tiers],
}
print("SB_MASSING_REPORT " + json.dumps(report))
`;

function fail(message: string): ToolHandlerOutcome {
    return { status: 'failed', summaryResult: `${STRUCTURE_MASSING_TOOL_NAME}: ${message}`, resultPayload: { success: false, error: message } as unknown as ToolResultPayload };
}

export const structureMassingHandler: ToolHandler = async (args, ctx): Promise<ToolHandlerOutcome> => {
    const scene = ctx?.request?.activeArtifact as { id?: string; version?: number; data?: { objects?: unknown[] } & Record<string, unknown> } | undefined;
    const scan = structureScanOf(scene);
    if (!scan) return fail('the scene on the canvas is not a staged 3D Building with an isolated structure scan; build one first (google_3d_tiles_get_clay with isolate and procedural), then call this again with it open');
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    const scriptArgs = {
        relief: num(args.relief, 2.5), minCoverage: num(args.minCoverage, 0.9), minPrecision: num(args.minPrecision, 0.85),
        candidate: typeof args.candidate === 'string' && args.candidate.trim() ? args.candidate.trim() : undefined
    };
    const env: Record<string, string> = {
        SCAN_GLB_PATH: scan.note.scanGlb, SCAN_GROUND_Y: String(scan.note.groundY), SCAN_PLAN: JSON.stringify(scan.note.plan),
        SB_MASSING_ARGS: JSON.stringify(scriptArgs)
    };
    if (scan.note.districtGlb && fs.existsSync(scan.note.districtGlb)) env.SCAN_DISTRICT_GLB_PATH = scan.note.districtGlb;
    ctx?.reportProgress?.('structure massing: the photo straight down over the roof');
    try {
        const roof = roofPhotoFor(scan.note);
        if (roof) { env.SCAN_ROOF_PHOTO_PATH = roof.path; env.SCAN_ROOF_PHOTO_FRAME = JSON.stringify(roof.frame); }
    } catch (err) {
        console.warn(`[${STRUCTURE_MASSING_TOOL_NAME}] no roof photo: ${(err as Error).message}`);
    }
    ctx?.reportProgress?.('structure massing: building and scoring the candidates');
    const result = await NativePythonRunnerService.getInstance().runScript(MASSING_SCRIPT, { timeoutMs: 240_000, env: { ...process.env, ...env } as Record<string, string> });
    const line = (result.stdout || '').split('\n').find(l => l.startsWith('SB_MASSING_REPORT '));
    if (!result.success || !line || !result.glbPath || !fs.existsSync(result.glbPath)) {
        return fail(`the massing could not be built: ${(result.errorDetails || result.stderr || 'no report').toString().slice(-1200)}`);
    }
    const report = JSON.parse(line.slice('SB_MASSING_REPORT '.length));
    const url = publishToModels(result.glbPath);
    const objectId = `structure-massing-${Date.now()}`;
    const object = {
        id: objectId,
        content: {
            type: '3d-model', durableUri: url, mimeType: 'model/gltf-binary',
            metadata: {
                // placed like the staged layers: in the scan's frame, never seated like a hero
                role: 'environment', isGround: false, layer: 'massing', source: STRUCTURE_MASSING_TOOL_NAME,
                candidate: report.chosen, builtFrom: { runId: scan.runId, scanGlb: scan.note.scanGlb, plan: scan.note.planSource ?? 'scan outline' },
                provenance: { label: 'generated', measuredGeometry: false, method: `${STRUCTURE_MASSING_TOOL_NAME}: ${report.why}` }
            }
        },
        space: { spatial3d: { x: 0, y: 0, z: 0 } }, time: { startMs: 0, durationMs: 20000 }, lineage: { version: 1 }
    };
    const artifact = scene?.data ? { ...scene, version: (scene.version || 1) + 1, data: { ...scene.data, objects: [...(scene.data.objects ?? []), object] } } : undefined;
    const rows = (report.candidates as Array<{ label: string; coverage: number; precision: number; accepted: boolean }>)
        .map(r => `${r.label} ${r.coverage.toFixed(2)}/${r.precision.toFixed(2)}${r.label === report.chosen ? ' (chosen)' : ''}`).join('; ');
    const roofLine = report.roof ? ` Roof: ${report.roof.objects.length} objects${report.roof.photo ? ' (outlines from the photo)' : ' (scan only)'}.` : '';
    const tierLine = report.chosen === 'tiers' && report.tiers ? ` ${report.tiers.length} tiers.` : '';
    return {
        status: 'completed',
        summaryResult: `Massing of the staged structure: ${report.chosen}${report.forced ? ' (asked for)' : report.explains ? '' : ' (no candidate explains the scan within tolerance; the best fit)'}. Coverage/precision per candidate: ${rows}.${roofLine}${tierLine} Joined the scene as ${objectId} (generated).`,
        resultPayload: { success: true, ...report, glbPath: result.glbPath, url, objectId, ...(artifact ? { artifact } : {}) } as unknown as ToolResultPayload
    };
};

export const MASSING_TOOL_DECLARATIONS: ToolDeclaration[] = [STRUCTURE_MASSING_DECLARATION];
export const massingHandlers: Record<string, ToolHandler> = { [STRUCTURE_MASSING_TOOL_NAME]: structureMassingHandler };
