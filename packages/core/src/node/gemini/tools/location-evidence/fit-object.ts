/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * location_fit_object: a real-object residual cluster (location_residual_audit) that reads as a thin vertical member or a
 * radial bundle of them (a water tower's legs, a mast, a drainpipe, a flagpole) turned into a clean procedural sweep
 * instead of left as the scan's own tangled residue -- AGENTS.md's believability-first default (a plausible, honestly
 * labelled fill beats a blank gap or raw scan noise) applied to this one shape family.
 *
 * What this reads is measured (residual-audit.ts's per-cluster `slices` and `symmetry`, already computed and written to
 * disk by location_residual_audit, just never exposed past its own trimmed summary). What this writes is not: the
 * carrier curve is read straight off the measured slice centres (confidence tracks the audit's own shape numbers), but
 * an individual leg's own thickness and count, for a bundle, cannot be recovered from the audit's per-height aggregate
 * circle fit alone -- those two numbers are reported as `estimated`, separately from the `measured` ones, and the
 * replicate call itself is left to space copies by the measured period (`pitch_meters`) rather than a count this tool
 * invented.
 *
 * Only generates a standalone preview GLB (via a returned `execute_3d_python_script` script, which always starts a new
 * scene -- it never carries over the build already on the canvas). Splicing the result back into the staged build in
 * place of the residual cluster is not done by any tool yet; this tool says so rather than imply it already happened.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome } from '../types';
import type { AuditedCluster, ResidualAuditResult } from '../../../3d-engine/staged-location/residual-audit';
import { ramp } from '../../../3d-engine/staged-location/residual-audit';

export const FIT_OBJECT_TOOL_NAME = 'location_fit_object';

export class FitObjectToolError extends Error {
    constructor(readonly code: 'no_input' | 'not_found' | 'no_cluster' | 'not_real' | (string & {}), message: string) { super(message); this.name = 'FitObjectToolError'; }
}

/** A cluster reads as a clean sweep candidate from its shape numbers alone (no geometry generated yet). */
export const FIT_OBJECT_THRESHOLDS = {
    /** Member/bundle axis close to vertical. */
    verticality: [0.7, 0.9] as [number, number],
    /** height / max(plan extents): a pole, mast or leg bundle reads tall and narrow. */
    slenderness: [1.0, 2.2] as [number, number],
    /** A single solid member: constant cross-section, little change with height. */
    singleConstancy: [0.5, 0.8] as [number, number],
    /** A radial bundle: the cross-section repeats around the circumference (residual-audit's own periodicity measure). */
    bundlePeriodicity: [0.3, 0.65] as [number, number]
};

export interface FitObjectCarrierPoint { x: number; y: number; z: number; radiusM: number }

export interface FitObjectResult {
    clusterId: number;
    verdict: AuditedCluster['verdict'];
    kind: 'single-member' | 'bundle' | 'none';
    confidence: number;
    reason: string;
    measured: {
        /** The member's (or bundle's) centreline, one point per usable height slice -- straight off the audit's own circle fits. */
        carrier: FitObjectCarrierPoint[];
        radiusMedianM: number;
        heightM: number;
        verticality: number;
        crossSectionConstancy: number;
        periodicity: number;
        periodM: number;
    };
    estimated?: {
        memberRadiusM: number;
        memberCountGuess: number | null;
        note: string;
    };
    /** A standalone preview script for execute_3d_python_script (starts a new scene; does not splice into the staged build). */
    pythonScript?: string;
    scriptNote: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

function carrierOf(c: AuditedCluster): FitObjectCarrierPoint[] {
    return c.slices.filter(s => s.r > 0).sort((a, b) => a.y - b.y).map(s => ({ x: s.cx, y: s.y, z: s.cz, radiusM: s.r }));
}

function circlePoints(cx: number, y: number, cz: number, r: number, n = 64): string {
    const pts: string[] = [];
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; pts.push(`[${(cx + r * Math.cos(a)).toFixed(4)}, ${y.toFixed(4)}, ${(cz + r * Math.sin(a)).toFixed(4)}]`); }
    return `[${pts.join(', ')}]`;
}

function pathLiteral(carrier: FitObjectCarrierPoint[]): string {
    return `[${carrier.map(p => `[${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)}]`).join(', ')}]`;
}

/** Classifies a cluster and builds its carrier curve + (when it qualifies) a standalone preview script. Real-object clusters only. */
export function fitObjectFromCluster(c: AuditedCluster): FitObjectResult {
    const sy = c.symmetry, sh = c.shape;
    const carrier = carrierOf(c);
    const [L, H, W] = c.frame.extentsM;
    const slenderness = H / Math.max(0.1, Math.max(L, W));
    const measured = { carrier, radiusMedianM: sy.radiusMedianM, heightM: H, verticality: sh.mainAxisVerticality, crossSectionConstancy: sy.crossSectionConstancy, periodicity: sy.periodicity, periodM: sy.periodM };
    const base = { clusterId: c.id, verdict: c.verdict, measured, scriptNote: '' as string };

    if (carrier.length < 2) return { ...base, kind: 'none', confidence: 0, reason: `too few valid height slices (${carrier.length}) to trace a centreline`, scriptNote: 'no script: not enough measured slices to build a carrier curve' };

    const vScore = ramp(sh.mainAxisVerticality, FIT_OBJECT_THRESHOLDS.verticality);
    const slenderScore = ramp(slenderness, FIT_OBJECT_THRESHOLDS.slenderness);
    const singleScore = vScore * slenderScore * ramp(sy.crossSectionConstancy, FIT_OBJECT_THRESHOLDS.singleConstancy);
    const bundleScore = vScore * slenderScore * ramp(sy.periodicity, FIT_OBJECT_THRESHOLDS.bundlePeriodicity);

    const bottom = carrier[0], top = carrier[carrier.length - 1];
    const cx = carrier.reduce((s, p) => s + p.x, 0) / carrier.length, cz = carrier.reduce((s, p) => s + p.z, 0) / carrier.length;

    if (bundleScore >= 0.4 && bundleScore >= singleScore) {
        const memberCountGuess = sy.periodM > 0 ? clamp(Math.round((2 * Math.PI * Math.max(sy.radiusMedianM, 0.1)) / sy.periodM), 2, 24) : null;
        const memberRadiusM = r2(clamp(memberCountGuess ? sy.radiusMedianM / (memberCountGuess * 1.5) : sy.radiusMedianM * 0.15, 0.03, 0.3));
        const guide = circlePoints(cx, (bottom.y + top.y) / 2, cz, sy.radiusMedianM);
        const pythonScript = [
            '# location_fit_object: generated preview, NOT spliced into the staged build (execute_3d_python_script always starts a new scene).',
            `# cluster ${c.id}: bundle of thin radial members (confidence ${r2(bundleScore)}). Member thickness and count below are ESTIMATED, not measured --`,
            '# the audit only gives the bundle\'s own aggregate circle fit per height, not each member\'s. The replicate call spaces copies by the',
            '# measured period (pitch_meters) rather than the estimated count, so the actual number placed comes from real data where it can.',
            'import scratchbox as sb',
            'scene = sb.Scene()',
            `seed_leg = sb.sweep_curve_profile(path=${pathLiteral([{ x: 0, y: bottom.y, z: 0, radiusM: 0 }, { x: 0, y: top.y, z: 0, radiusM: 0 }])}, profile='CIRCULAR', profile_dimensions=(${memberRadiusM}, ${memberRadiusM}))`,
            `legs = sb.replicate_metric_array(distribution_mode='CURVE_1D', guide_points=${guide}, pitch_meters=${r2(sy.periodM || 0.5)}, seed_geometry=seed_leg)`,
            'scene.add(legs)',
            'sb.io.write_glb(OUTPUT_GLB_PATH, scene)'
        ].join('\n');
        return {
            ...base, kind: 'bundle', confidence: r2(bundleScore),
            reason: `reads as a radial bundle of thin vertical members: periodicity ${r2(sy.periodicity)}, verticality ${r2(sh.mainAxisVerticality)}, slenderness ${r2(slenderness)} (bundle score ${r2(bundleScore)} vs single-member ${r2(singleScore)})`,
            estimated: { memberRadiusM, memberCountGuess, note: 'memberRadiusM and memberCountGuess are rough estimates from the bundle\'s aggregate radius and measured period, not individually measured -- label any geometry built from them "generated", not "measured".' },
            pythonScript, scriptNote: 'ready to paste into execute_3d_python_script; places member copies along the measured period, not the estimated count'
        };
    }

    if (singleScore >= 0.4) {
        const r = Math.max(0.02, sy.radiusMedianM);
        const pythonScript = [
            '# location_fit_object: generated preview, NOT spliced into the staged build (execute_3d_python_script always starts a new scene).',
            `# cluster ${c.id}: single slender vertical member (confidence ${r2(singleScore)}). Carrier curve and radius are the audit's own measured slice fits.`,
            'import scratchbox as sb',
            'scene = sb.Scene()',
            `member = sb.sweep_curve_profile(path=${pathLiteral(carrier)}, profile='CIRCULAR', profile_dimensions=(${r2(r)}, ${r2(r)}))`,
            'scene.add(member)',
            'sb.io.write_glb(OUTPUT_GLB_PATH, scene)'
        ].join('\n');
        return {
            ...base, kind: 'single-member', confidence: r2(singleScore),
            reason: `reads as one slender, mostly-constant-section vertical member: cross-section constancy ${r2(sy.crossSectionConstancy)}, verticality ${r2(sh.mainAxisVerticality)}, slenderness ${r2(slenderness)} (single-member score ${r2(singleScore)} vs bundle ${r2(bundleScore)})`,
            pythonScript, scriptNote: 'ready to paste into execute_3d_python_script; path and radius are measured, not estimated'
        };
    }

    return {
        ...base, kind: 'none', confidence: 0,
        reason: `does not read as a clean sweep candidate: verticality ${r2(sh.mainAxisVerticality)}, slenderness ${r2(slenderness)}, cross-section constancy ${r2(sy.crossSectionConstancy)}, periodicity ${r2(sy.periodicity)} -- none of single-member (${r2(singleScore)}) or bundle (${r2(bundleScore)}) clears 0.4`,
        scriptNote: 'no script: the cluster does not read as a thin vertical member or a radial bundle of them'
    };
}

const r2 = (v: number) => Math.round(v * 1000) / 1000;

export interface FitObjectToolRequest { resultJson: string; clusterId: number }

export async function runFitObjectTool(req: FitObjectToolRequest, workspaceRoot: string): Promise<{ summary: string; payload: Record<string, unknown> }> {
    if (!req.resultJson) throw new FitObjectToolError('no_input', 'give resultJson (the path location_residual_audit returned at payload.layers[].resultJson)');
    const jsonPath = path.isAbsolute(req.resultJson) ? req.resultJson : path.join(workspaceRoot, req.resultJson);
    if (!fs.existsSync(jsonPath)) throw new FitObjectToolError('not_found', `no residual audit result at ${jsonPath}`);
    const result = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as ResidualAuditResult;
    const cluster = result.clusters.find(c => c.id === req.clusterId);
    if (!cluster) throw new FitObjectToolError('no_cluster', `${jsonPath} has no cluster ${req.clusterId} (clusters: ${result.clusters.map(c => c.id).join(', ') || 'none'})`);
    if (cluster.verdict === 'scan-artefact') throw new FitObjectToolError('not_real', `cluster ${req.clusterId} is a scan artefact (${cluster.reason}), not a real object to fit`);
    const fit = fitObjectFromCluster(cluster);
    const summary = `${FIT_OBJECT_TOOL_NAME}: cluster ${cluster.id} (${cluster.verdict}) -- ${fit.kind === 'none' ? 'no sweep candidate' : `${fit.kind}, confidence ${fit.confidence}`}: ${fit.reason}`;
    return { summary, payload: { status: 'success', ...fit } };
}

export const FIT_OBJECT_TOOL_DECLARATION: ToolDeclaration = {
    name: FIT_OBJECT_TOOL_NAME,
    description: 'Turns one real-object cluster from location_residual_audit into a clean procedural sweep, when its shape reads as a thin vertical member (a mast, drainpipe, flagpole) or a radial bundle of them ' +
        '(a water tower\'s support legs, cross-bracing) -- instead of leaving it as the scan\'s own tangled residue. Reads the audit\'s own per-height slice fits (its measured centreline and radius) and classifies ' +
        'single-member vs bundle from verticality, slenderness, cross-section constancy and periodicity (all measured). A bundle\'s own member count and thickness cannot be read individually off the audit\'s aggregate ' +
        'fit, so those two numbers come back labelled "estimated", not measured; the generated replicate script still spaces copies by the measured period, not the estimate. ' +
        'Returns a ready execute_3d_python_script script for a standalone preview GLB -- that tool always starts a fresh scene, so this never splices the result into the staged build in place of the residual; say so ' +
        'plainly rather than imply otherwise. Give resultJson (location_residual_audit\'s own output path) and the clusterId to fit.',
    parameters: {
        type: 'OBJECT',
        properties: {
            resultJson: { type: 'STRING', description: 'Path to a residual_audit.json written by location_residual_audit (its payload.layers[].resultJson).' },
            clusterId: { type: 'NUMBER', description: 'The cluster id to fit (from location_residual_audit\'s clusters[].id), a real-object or unsure verdict.' }
        },
        required: ['resultJson', 'clusterId']
    }
};

export const fitObjectHandler: ToolHandler = async (args, ctx): Promise<ToolHandlerOutcome> => {
    const resultJson = typeof args.resultJson === 'string' ? args.resultJson.trim() : '';
    const clusterId = typeof args.clusterId === 'number' ? args.clusterId : Number(args.clusterId);
    try {
        if (!Number.isFinite(clusterId)) throw new FitObjectToolError('no_input', 'clusterId must be a number');
        const r = await runFitObjectTool({ resultJson, clusterId }, ctx.workspaceRoot);
        return { status: 'completed', summaryResult: r.summary, resultPayload: { status: 'success', ...r.payload } };
    } catch (err) {
        const code = err instanceof FitObjectToolError ? err.code : 'fit_failed';
        const msg = err instanceof Error ? err.message : String(err);
        return { status: 'failed', summaryResult: `${FIT_OBJECT_TOOL_NAME} (${code}): ${msg}`, resultPayload: { status: 'error', code, error: msg } };
    }
};
