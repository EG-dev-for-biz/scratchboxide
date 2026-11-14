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
import * as fs from 'fs';
import * as path from 'path';
import { composeShapeDetail, measureShapeFit, SHAPE_DETAIL_PARAMS, type ShapeFit } from '../../3d-engine/staged-location/shape-detail';
import { publishedModelPath, publishToModels, structureScanOf } from './python-3d-tools';

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

/**
 * structure_shape_detail: how well a clean shape on the canvas reproduces the staged structure's scan, and the two put
 * together (shape-detail.ts): the shape kept where it explains the scan, the scan's own surface kept where it stands off
 * the shape, the tiles' interior surfaces dropped. Distances only; no structure type is consulted.
 */
export const STRUCTURE_SHAPE_DETAIL_TOOL_NAME = 'structure_shape_detail';

export const STRUCTURE_SHAPE_DETAIL_DECLARATION: ToolDeclaration = {
    name: STRUCTURE_SHAPE_DETAIL_TOOL_NAME,
    description: 'Measure how well a clean generated shape of the staged 3D Building open on the canvas (a massing from structure_massing, or any generated model object in the scan\'s frame) reproduces its scan, and compose the two: the clean shape stays where the scan lies on it, the scan\'s own measured surface is kept where it stands off the shape (crowns, roof objects, setback edges, recesses), the shape\'s surface standing in air in front of the scan is removed, and scan surfaces never seen from outside are dropped. Reports the share of the seen scan within the tolerance overall and by height band, so the bands the shape gets wrong can be rebuilt. The result joins the scene in the scan\'s frame; the shape\'s part stays generated, the scan\'s part measured. With measureOnly nothing is added.',
    parameters: {
        type: 'OBJECT',
        properties: {
            shapeObjectId: { type: 'STRING', description: 'The scene object holding the clean shape. Omit for the latest massing object in the scene.' },
            keepM: { type: 'NUMBER', description: `Scan within this many metres of the shape is explained by it; scan farther off is kept as scanned (default ${SHAPE_DETAIL_PARAMS.keepM}).` },
            measureOnly: { type: 'BOOLEAN', description: 'Report the fit only; compose and add nothing.' }
        }
    }
};

function fitLine(f: ShapeFit): string {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    return `${pct(f.nearShare)} of the scan seen from outside lies on the shape (${pct(f.reliefShare)} relief, ${pct(f.geometryShare)} geometry the shape lacks); by height ${f.bands.map(b => `${Math.round(b.fromY)}-${Math.round(b.toY)} m ${pct(b.nearShare)}`).join(', ')}; ${pct(f.supportedShare)} of the shape has scan behind it`;
}

export const structureShapeDetailHandler: ToolHandler = async (args, ctx): Promise<ToolHandlerOutcome> => {
    const failed = (message: string): ToolHandlerOutcome => ({ status: 'failed', summaryResult: `${STRUCTURE_SHAPE_DETAIL_TOOL_NAME}: ${message}`, resultPayload: { success: false, error: message } as unknown as ToolResultPayload });
    type SceneObject = { id?: string; content?: { durableUri?: unknown; metadata?: { layer?: unknown } } };
    const scene = ctx?.request?.activeArtifact as { id?: string; version?: number; data?: { objects?: SceneObject[] } & Record<string, unknown> } | undefined;
    const scan = structureScanOf(scene);
    if (!scan) return failed('the scene on the canvas is not a staged 3D Building with an isolated structure scan; build one first, then call this again with it open');
    const objects = scene?.data?.objects ?? [];
    const wanted = typeof args.shapeObjectId === 'string' && args.shapeObjectId.trim() ? args.shapeObjectId.trim() : undefined;
    const shapeObject = wanted ? objects.find(o => o.id === wanted) : [...objects].reverse().find(o => o.content?.metadata?.layer === 'massing');
    if (!shapeObject) return failed(wanted ? `no object "${wanted}" in the scene` : 'the scene holds no massing object; run structure_massing first, or name the shape with shapeObjectId');
    const shapePath = publishedModelPath(shapeObject.content?.durableUri);
    if (!shapePath) return failed(`the shape object "${shapeObject.id}" has no model file this tool can read`);
    const keepM = typeof args.keepM === 'number' && Number.isFinite(args.keepM) && args.keepM > 0 ? args.keepM : SHAPE_DETAIL_PARAMS.keepM;
    const P = { ...SHAPE_DETAIL_PARAMS, keepM, reliefM: Math.max(SHAPE_DETAIL_PARAMS.reliefM, keepM), supportM: Math.max(SHAPE_DETAIL_PARAMS.supportM, keepM) };
    ctx?.reportProgress?.('shape detail: sorting the scan by its distance to the shape');
    try {
        const scanBytes = fs.readFileSync(scan.note.scanGlb), shapeBytes = fs.readFileSync(shapePath);
        if (args.measureOnly === true) {
            const fit = measureShapeFit(scanBytes, shapeBytes, P);
            return { status: 'completed', summaryResult: `Shape against the scan: ${fitLine(fit)}.`, resultPayload: { success: true, fit, shapeObjectId: shapeObject.id } as unknown as ToolResultPayload };
        }
        const { glb, report } = composeShapeDetail(shapeBytes, scanBytes, P);
        const glbPath = path.join(path.dirname(scan.note.scanGlb), `shape_detail_${Date.now()}.glb`);
        fs.writeFileSync(glbPath, glb);
        const url = publishToModels(glbPath), objectId = `structure-shape-detail-${Date.now()}`;
        const object = {
            id: objectId,
            content: {
                type: '3d-model', durableUri: url, mimeType: 'model/gltf-binary',
                metadata: {
                    role: 'environment', isGround: false, layer: 'shape-detail', source: STRUCTURE_SHAPE_DETAIL_TOOL_NAME,
                    builtFrom: { runId: scan.runId, scanGlb: scan.note.scanGlb, shapeObjectId: shapeObject.id },
                    provenance: { label: 'generated', measuredGeometry: false, method: `${STRUCTURE_SHAPE_DETAIL_TOOL_NAME}: the clean shape (generated) with ${report.scanKept.m2} m2 of the scan's own surface kept where it stands ${keepM} m or more off it (measured; labelled per node)` }
                }
            },
            space: { spatial3d: { x: 0, y: 0, z: 0 } }, time: { startMs: 0, durationMs: 20000 }, lineage: { version: 1 }
        };
        const artifact = scene?.data ? { ...scene, version: (scene.version || 1) + 1, data: { ...scene.data, objects: [...objects, object] } } : undefined;
        return {
            status: 'completed',
            summaryResult: `Shape and scan composed: ${fitLine(report.fit)}. Kept ${report.scanKept.m2} m2 of scan as scanned (${report.scanKept.patches} patches), dropped ${report.scanDropped.buriedM2} m2 never seen from outside and ${report.scanDropped.explainedM2} m2 the shape explains; removed ${report.shapeRemoved.m2} m2 of shape standing in air. The result reproduces ${Math.round(report.reproducedShare * 100)}% of the seen scan within ${keepM} m, in ${report.triangles} triangles.`,
            resultPayload: { success: true, report, glbPath, url, objectId, shapeObjectId: shapeObject.id, ...(artifact ? { artifact } : {}) } as unknown as ToolResultPayload
        };
    } catch (err) {
        return failed((err as Error).message);
    }
};

export const MASSING_TOOL_DECLARATIONS: ToolDeclaration[] = [STRUCTURE_MASSING_DECLARATION, STRUCTURE_SHAPE_DETAIL_DECLARATION];
export const massingHandlers: Record<string, ToolHandler> = { [STRUCTURE_MASSING_TOOL_NAME]: structureMassingHandler, [STRUCTURE_SHAPE_DETAIL_TOOL_NAME]: structureShapeDetailHandler };
