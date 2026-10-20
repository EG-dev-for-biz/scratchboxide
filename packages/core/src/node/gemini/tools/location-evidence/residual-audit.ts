/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_residual_audit: of the scan triangles a staged build's clean massing does not explain (its "as-scanned"
 * residual), which are real objects, which are scan artefacts, and which are unsure, decided from measured numbers.
 *
 * Inputs, one of:
 *   - runId: a staged-location run (its pipeline E build is found through the run's remesh key);
 *   - buildDir: a pipeline E build directory (.scratchbox/cache/staged_location/pipeline_e/<key>) or one native run in it
 *     (a directory with report.json and mesh.bin);
 *   - glbPath (+ massingGlbPath): any GLB whose residual nodes are named "residual..." or labelled as-scanned, measured
 *     against its other nodes or against the massing GLB given (no photo agreement in this mode).
 * The measures are native (scratchbox_residual_audit.hpp); the verdict and its reason come from the numbers
 * (residual-audit.ts, thresholds documented there). Writes the result JSON (every cluster with its measures, verdict,
 * reason, triangle ids, local frame and sb-feature/1 record) and, when asked, a cleaned GLB per layer GLB with the
 * artefacts removed. Real data only: the scan's own triangles and photos against the massing from Google's vector data.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome } from '../types';
import { readNodes, type MassingReport, type MassingRun } from '../../../3d-engine/staged-location/pipeline-e/native-massing';
import { auditMassingRun } from '../../../3d-engine/staged-location/pipeline-e/residual-audit-e';
import { auditResidual, cleanGlbBytes, writeAuditResult, type ResidualAuditResult } from '../../../3d-engine/staged-location/residual-audit';
import { parseGlbNodes } from '../../../3d-engine/staged-location/glb-nodes';

export const RESIDUAL_AUDIT_TOOL_NAME = 'location_residual_audit';

export class ResidualAuditToolError extends Error {
    constructor(readonly code: 'no_input' | 'not_found' | 'no_residual' | 'audit_failed' | (string & {}), message: string) { super(message); this.name = 'ResidualAuditToolError'; }
}

const STAGED_CACHE = path.join('.scratchbox', 'cache', 'staged_location');
/** Native runs of a pipeline E build, latest layer first. */
const LAYER_RUNS = [path.join('relief', 'native'), path.join('inference', 'native3'), path.join('inference', 'native2'), 'native'];

const isRunDir = (d: string) => fs.existsSync(path.join(d, 'report.json')) && fs.existsSync(path.join(d, 'mesh.bin'));

/** The pipeline E build directory of a staged run (through its remesh key). */
export function buildDirOfRun(workspaceRoot: string, runId: string): string {
    const stages = path.join(workspaceRoot, STAGED_CACHE, 'runs', runId, 'stages.json');
    if (!fs.existsSync(stages)) throw new ResidualAuditToolError('not_found', `no staged run ${runId} in this workspace (${stages})`);
    const key = JSON.parse(fs.readFileSync(stages, 'utf8'))?.keys?.remesh as string | undefined;
    const dir = key ? path.join(workspaceRoot, STAGED_CACHE, 'pipeline_e', key.slice(0, 24)) : '';
    if (!key || !fs.existsSync(dir)) throw new ResidualAuditToolError('not_found', `staged run ${runId} has no pipeline E build (remesh key ${key ?? 'missing'}); the audit reads pipeline E builds`);
    return dir;
}

/** The native run directories of a build (or the directory itself when it is one), latest layer first. */
export function runDirsOf(dir: string): Array<{ layer: string; dir: string }> {
    if (isRunDir(dir)) return [{ layer: path.basename(dir), dir }];
    return LAYER_RUNS.map(l => ({ layer: l, dir: path.join(dir, l) })).filter(x => isRunDir(x.dir));
}

/** The layer GLBs a native run's residual is in (to clean): the build's GLBs written from that run. */
function layerGlbsOf(buildDir: string, layer: string): string[] {
    const names: Record<string, string[]> = {
        native: ['massing_clay.glb', 'massing_textured.glb'],
        [path.join('inference', 'native2')]: ['inference/massing_inferred_clay.glb', 'inference/massing_inferred_textured.glb', 'inference/massing_enhanced_clay.glb', 'inference/massing_enhanced_textured.glb'],
        [path.join('inference', 'native3')]: ['inference/massing_inferred_clay.glb', 'inference/massing_inferred_textured.glb', 'inference/massing_enhanced_clay.glb', 'inference/massing_enhanced_textured.glb'],
        [path.join('relief', 'native')]: ['relief/massing_relief_clay.glb', 'relief/massing_relief_textured.glb']
    };
    return (names[layer] ?? []).map(n => path.join(buildDir, n)).filter(f => fs.existsSync(f));
}

/** Audits one native run without changing it on disk (the run is read; the result goes to `outDir`). */
async function auditRunDir(runDir: string, outDir: string, groundY?: number): Promise<ResidualAuditResult> {
    const report = JSON.parse(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8')) as MassingReport;
    // a copy of the run that writes into outDir: its tile photos are read from the run's own directory
    const run: MassingRun = { dir: runDir, report, nodes: readNodes(runDir, report), ms: 0, binary: { path: '', built: false } };
    if (!run.nodes.some(n => n.kind === 'residual')) throw new ResidualAuditToolError('no_residual', `${runDir} has no residual nodes to audit`);
    const result = await auditMassingRun(run, { ...(groundY !== undefined ? { groundY } : {}), outDir });
    return result;
}

const soupOf = (n: { positions: Float32Array; indices?: Uint32Array }) => {
    const ix = n.indices ?? Uint32Array.from({ length: n.positions.length / 3 }, (_, i) => i);
    const out = new Float32Array(ix.length * 3);
    for (let i = 0; i < ix.length; i++) out.set(n.positions.subarray(ix[i] * 3, ix[i] * 3 + 3), i * 3);
    return out;
};
const concat = (a: Float32Array[]) => { const o = new Float32Array(a.reduce((s, x) => s + x.length, 0)); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };
const isResidualNode = (n: { name: string; extras?: unknown }) => /^residual/i.test(n.name) || JSON.stringify(n.extras ?? '').includes('"as-scanned"');

export interface ResidualAuditToolRequest { runId?: string; buildDir?: string; glbPath?: string; massingGlbPath?: string; groundY?: number; writeCleanGlb?: boolean; outputDir?: string; allLayers?: boolean }

export async function runResidualAuditTool(req: ResidualAuditToolRequest, workspaceRoot: string): Promise<{ summary: string; payload: Record<string, unknown> }> {
    const within = (p: string) => (path.isAbsolute(p) ? p : path.join(workspaceRoot, p));
    if (req.glbPath) {
        const glbPath = within(req.glbPath);
        if (!fs.existsSync(glbPath)) throw new ResidualAuditToolError('not_found', `no GLB at ${glbPath}`);
        const nodes = parseGlbNodes(fs.readFileSync(glbPath));
        const residual = nodes.filter(isResidualNode);
        if (!residual.length) throw new ResidualAuditToolError('no_residual', `${glbPath} has no node named "residual..." or labelled as-scanned`);
        const solidNodes = req.massingGlbPath ? parseGlbNodes(fs.readFileSync(within(req.massingGlbPath))) : nodes.filter(n => !isResidualNode(n) && !/^(opening|sweep|facesweep)/.test(n.name));
        const outDir = req.outputDir ? within(req.outputDir) : path.join(path.dirname(glbPath), `${path.basename(glbPath, '.glb')}_residual_audit`);
        const r = await auditResidual({ solid: concat(solidNodes.map(soupOf)), sources: residual.map(n => ({ node: n.name, triangles: soupOf(n) })), ...(req.groundY !== undefined ? { groundY: req.groundY } : {}), dir: outDir, idPrefix: path.basename(glbPath) });
        writeAuditResult(path.join(outDir, 'residual_audit.json'), r);
        const cleaned: string[] = [];
        if (req.writeCleanGlb) { const f = path.join(outDir, `${path.basename(glbPath, '.glb')}_audited.glb`); fs.writeFileSync(f, cleanGlbBytes(fs.readFileSync(glbPath), r).glb); cleaned.push(f); }
        return describe([{ layer: path.basename(glbPath), result: r, json: path.join(outDir, 'residual_audit.json'), cleaned }], 'glb (no photo agreement: the GLB mode measures geometry only)');
    }
    const buildDir = req.runId ? buildDirOfRun(workspaceRoot, req.runId) : req.buildDir ? within(req.buildDir) : undefined;
    if (!buildDir) throw new ResidualAuditToolError('no_input', 'give runId, buildDir or glbPath');
    if (!fs.existsSync(buildDir)) throw new ResidualAuditToolError('not_found', `no build at ${buildDir}`);
    const runs = runDirsOf(buildDir);
    if (!runs.length) throw new ResidualAuditToolError('not_found', `${buildDir} holds no pipeline E native run (report.json and mesh.bin)`);
    const outRoot = req.outputDir ? within(req.outputDir) : path.join(buildDir, 'residual_audit_tool');
    const out: Array<{ layer: string; result: ResidualAuditResult; json: string; cleaned: string[] }> = [];
    for (const r of req.allLayers ? runs : runs.slice(0, 1)) {
        const dir = path.join(outRoot, r.layer.replace(/[\\/]/g, '_'));
        const result = await auditRunDir(r.dir, dir, req.groundY);
        const json = path.join(dir, 'residual_audit.json');
        const cleaned: string[] = [];
        if (req.writeCleanGlb) for (const g of layerGlbsOf(isRunDir(buildDir) ? path.dirname(buildDir) : buildDir, r.layer)) {
            const f = path.join(dir, `${path.basename(g, '.glb')}_audited.glb`);
            fs.writeFileSync(f, cleanGlbBytes(fs.readFileSync(g), result).glb);
            cleaned.push(f);
        }
        out.push({ layer: r.layer, result, json, cleaned });
    }
    return describe(out, 'staged build (geometry and tile photos)');
}

function describe(out: Array<{ layer: string; result: ResidualAuditResult; json: string; cleaned: string[] }>, mode: string): { summary: string; payload: Record<string, unknown> } {
    const lines = out.map(o => `${o.layer}: ${o.result.notes[0]}`);
    return {
        summary: `${RESIDUAL_AUDIT_TOOL_NAME} (${mode}): ${lines.join(' | ')}`,
        payload: {
            mode, dataNote: out[0]?.result.dataNote,
            layers: out.map(o => ({
                layer: o.layer, resultJson: o.json, cleanedGlbs: o.cleaned, counts: o.result.counts, notes: o.result.notes, candidates: o.result.candidates,
                clusters: o.result.clusters.map(c => ({
                    id: c.id, verdict: c.verdict, confidence: c.confidence, reason: c.reason, types: c.feature.types, typeLabels: c.typeLabels, areaM2: c.areaM2, lo: c.lo, hi: c.hi, frame: c.frame,
                    measures: { principalExtentsM: c.principal.extentsM, thinness: c.shape.thinness, elongation: c.shape.elongation, normalCoherence: c.surface.normalCoherence, copyShare: c.surface.copyShare, sliverShare: c.surface.sliverShare, minGapToSolidM: c.attachment.minGapToSolidM, insideShare: c.attachment.insideShare, groundedShare: c.attachment.groundedShare, openBelowShare: c.attachment.openBelowShare, topAboveSupportM: c.attachment.topAboveSupportM, radialSymmetry: c.symmetry.radialSymmetry, crossSectionConstancy: c.symmetry.crossSectionConstancy, periodicity: c.symmetry.periodicity, skyShare: c.skyShare },
                    triangles: c.triangles
                }))
            }))
        }
    };
}

export const RESIDUAL_AUDIT_TOOL_DECLARATION: ToolDeclaration = {
    name: RESIDUAL_AUDIT_TOOL_NAME,
    description: 'Audit the leftover scan triangles of a staged location build (pipeline E): the triangles its clean massing does not explain and keeps "as scanned". ' +
        'Groups them into connected clusters and measures each with continuous numbers (oriented extents, area, thinness, triangle quality, normal coherence, closure, envelope volume, ' +
        'contact and gap to the massing, share inside it, support and open space underneath, height above its support, radial symmetry of horizontal slices, cross-section constancy, periodicity, ' +
        'the share that copies a massing surface, and the colour of its tile photo). Each cluster gets a verdict (real-object, scan-artefact or unsure) with a confidence and a reason built from those numbers, ' +
        'plus open feature-type labels (sb-feature/1 codes, labels only). Real objects are listed as candidates for later fitting. Returns per cluster its triangle ids and a local frame; writes the full JSON and, ' +
        'with writeCleanGlb, a copy of each layer GLB with the artefacts removed (the build itself is not changed). Uses real data only: the scan\'s triangles and photos against the massing built from Google vector data; ' +
        'nothing is generated. Give runId (a staged run), buildDir (a pipeline E build or one native run), or glbPath (any GLB with nodes named residual..., geometry only).',
    parameters: {
        type: 'OBJECT',
        properties: {
            runId: { type: 'STRING', description: 'A staged-location run id (as in .scratchbox/cache/staged_location/runs/<id>); its pipeline E build is audited.' },
            buildDir: { type: 'STRING', description: 'A pipeline E build directory (.scratchbox/cache/staged_location/pipeline_e/<key>) or one native run inside it (report.json + mesh.bin). Relative paths are from the workspace.' },
            glbPath: { type: 'STRING', description: 'Instead of a build: a GLB whose residual nodes are named residual... (or labelled as-scanned); the other nodes are the massing unless massingGlbPath is given.' },
            massingGlbPath: { type: 'STRING', description: 'With glbPath: the clean massing as its own GLB.' },
            groundY: { type: 'NUMBER', description: 'Ground height in the build frame (default: the massing\'s lowest base).' },
            writeCleanGlb: { type: 'BOOLEAN', description: 'Also write a copy of the layer GLB(s) with the scan artefacts removed (provenance labels kept).' },
            allLayers: { type: 'BOOLEAN', description: 'Audit every native run of the build (massing, inferred, relief), not only the latest layer.' },
            outputDir: { type: 'STRING', description: 'Where to write (default: <build>/residual_audit_tool).' }
        }
    }
};

export const residualAuditHandler: ToolHandler = async (args, ctx): Promise<ToolHandlerOutcome> => {
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    try {
        const r = await runResidualAuditTool({
            runId: str(args.runId), buildDir: str(args.buildDir), glbPath: str(args.glbPath), massingGlbPath: str(args.massingGlbPath),
            ...(typeof args.groundY === 'number' && Number.isFinite(args.groundY) ? { groundY: args.groundY } : {}),
            writeCleanGlb: args.writeCleanGlb === true, allLayers: args.allLayers === true, outputDir: str(args.outputDir)
        }, ctx.workspaceRoot);
        return { status: 'completed', summaryResult: r.summary, resultPayload: { status: 'success', ...r.payload } };
    } catch (err) {
        const code = err instanceof ResidualAuditToolError ? err.code : 'audit_failed';
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'failed', summaryResult: `${RESIDUAL_AUDIT_TOOL_NAME} (${code}): ${msg}`, resultPayload: { status: 'error', code, error: msg } };
    }
};
