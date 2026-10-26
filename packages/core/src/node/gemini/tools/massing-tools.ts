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

import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolResultPayload } from './types';
import { candidateLine, runScanMassing, type ScanMassingResult } from '../../3d-engine/staged-location/scan-massing';
import { publishToModels, structureScanOf } from './python-3d-tools';

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
    ctx?.reportProgress?.('structure massing: building and scoring the candidates');
    let report: ScanMassingResult;
    try {
        report = await runScanMassing(scan.note, { ...scriptArgs, ...(ctx?.signal ? { signal: ctx.signal } : {}) });
    } catch (err) {
        return fail((err as Error).message);
    }
    const result = { glbPath: report.glbPath };
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
    const rows = candidateLine(report);
    const roofLine = report.roof ? ` Roof: ${report.roof.objects.length} objects${report.roof.photo ? ' (outlines from the photo)' : ' (scan only)'}.` : '';
    const tierLine = report.chosen === 'tiers' ? ` ${report.tiers.length} tiers.` : '';
    return {
        status: 'completed',
        summaryResult: `Massing of the staged structure: ${report.chosen}${report.forced ? ' (asked for)' : report.explains ? '' : ' (no candidate explains the scan within tolerance; the best fit)'}. Coverage/precision per candidate: ${rows}.${roofLine}${tierLine} Joined the scene as ${objectId} (generated).`,
        resultPayload: {
            success: true, chosen: report.chosen, forced: report.forced, explains: report.explains, why: report.why, candidates: report.candidates,
            groundY: report.groundY, roofY: report.roofY, top: report.top, samples: report.samples,
            roof: report.roof && { photo: report.roof.photo, objects: report.roof.objects.map(o => ({ chosen: o.chosen, rise: +(o.topY - o.baseY).toFixed(2), area: +o.areaM2.toFixed(2), outline: o.outlineSource, height: o.heightSource, why: o.why })) },
            tiers: report.tiers.map(t => ({ y0: +t.y0.toFixed(2), y1: +t.y1.toFixed(2), area: +t.area.toFixed(1) })),
            glbPath: result.glbPath, url, objectId, ...(artifact ? { artifact } : {})
        } as unknown as ToolResultPayload
    };
};

export const MASSING_TOOL_DECLARATIONS: ToolDeclaration[] = [STRUCTURE_MASSING_DECLARATION];
export const massingHandlers: Record<string, ToolHandler> = { [STRUCTURE_MASSING_TOOL_NAME]: structureMassingHandler };
