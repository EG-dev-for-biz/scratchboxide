/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Scene healing (the scene-healing skill): measure a scene's defects, and heal a mesh with bounded fixes, measuring it
 * again after. Measuring changes nothing; healing writes new files and leaves the input as it came.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome } from './types';
import { tileRefineRootFor } from './tile-refine-tools';
import { sceneSeamCensus } from '../../3d-engine/scene-seam-census';
import { runTileSeamWeld } from '../../3d-engine/tile-seam-weld-service';
import { measureVisibleDefects, type VisibleDefectsReport } from '../../3d-engine/staged-location/pipeline-k/visible-defects';
import { orientRemesh } from '../../3d-engine/staged-location/remesh-orient';
import { fillOpenLoops } from '../../3d-engine/staged-location/pipeline-k/lattice-stitch';
import { resolveWithinRoot } from '../../security/path-guard';

export const SCENE_HEALING_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'scene_measure_defects',
        description: 'Measure what is wrong with a 3D scene or scan (a .glb), changing nothing. Outside check: views from around and above count the share of the surface seen untextured (clay), through holes or from inside, and with smeared texture, each by the mesh it sits on. Seam census: how the scene\'s pieces meet - a gap histogram, T-junctions (a vertex on another piece\'s edge), steps across seams, and overlapping strips (m²). Use before and after any repair, and to find which step introduced a defect.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'The scene .glb: workspace-relative or absolute (e.g. a glbPath returned by google_3d_tiles_get_full_texture or tile_refine).' },
                seams: { type: 'BOOLEAN', description: 'Also run the seam census (default true).' }
            },
            required: ['glbPath']
        }
    },
    {
        name: 'scene_heal_mesh',
        description: 'Heal a scene or scan (a .glb) with bounded fixes, in order: (1) seams - open edges of different pieces within the tolerance snap together and the slivers they collapse are dropped (positions only, texture kept); (2) inside-out surfaces seen only from behind and facing inward are turned; (3) holes - open loops are capped (shortest-closing-edge ears) unless the cap would leave the object\'s envelope, lie on an existing surface, or stray off its plane, in which case the loop stays open and is counted. Writes a healed textured .glb and its clay beside the input (never overwrites it) and measures defects before and after. Melted walls are tile_refine\'s job (plane snapping), not this tool\'s.',
        parameters: {
            type: 'OBJECT',
            properties: {
                glbPath: { type: 'STRING', description: 'The textured scene .glb to heal: workspace-relative or absolute.' },
                steps: { type: 'ARRAY', items: { type: 'STRING', enum: ['seams', 'orient', 'holes'] }, description: 'Which fixes to run, in this order (default all three).' },
                toleranceM: { type: 'NUMBER', description: 'Seam weld tolerance in metres (default 0.03; at most 1). Keep it within the pieces\' own measurement error.' }
            },
            required: ['glbPath']
        }
    }
];

/** The file a glbPath names (the checkout's public files first for a relative path, as tile_refine reads them). */
function resolveGlb(glbPath: unknown, workspaceRoot: string): string {
    if (typeof glbPath !== 'string' || !glbPath.trim()) throw new Error('glbPath must name a .glb file');
    const { root } = tileRefineRootFor(glbPath, workspaceRoot);
    const file = resolveWithinRoot(root, glbPath.trim());
    if (!fs.existsSync(file)) throw new Error(`no such file: ${glbPath}`);
    return file;
}

function defectsSummary(r: VisibleDefectsReport) {
    const pct = (v: number) => Math.round(v * 10000) / 100;
    const top = (m: Record<string, number>) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([node, px]) => ({ node, px }));
    return {
        clayPct: pct(r.clayShare), holePct: pct(r.holeShare), smearPct: pct(r.smearShare),
        worstViewClayPct: pct(r.maxViewClayShare), worstViewHolePct: pct(r.maxViewHoleShare), flagged: r.flagged,
        holesAt: top(r.byNode.holes), clayAt: top(r.byNode.clay), smearAt: top(r.byNode.smear), why: r.why
    };
}

const failed = (tool: string, err: unknown): ToolHandlerOutcome => {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', summaryResult: `${tool} failed: ${message}`, resultPayload: { status: 'error', message } };
};

export const sceneHealingHandlers: Record<string, ToolHandler> = {
    scene_measure_defects: async (args, ctx): Promise<ToolHandlerOutcome> => {
        try {
            const file = resolveGlb(args.glbPath, ctx.workspaceRoot);
            const bytes = fs.readFileSync(file);
            const outside = defectsSummary(measureVisibleDefects(bytes));
            const seams = args.seams === false ? undefined : sceneSeamCensus(bytes);
            return {
                status: 'completed',
                summaryResult: `Untextured ${outside.clayPct}%, holes ${outside.holePct}%, smeared ${outside.smearPct}%${seams ? `; ${seams.seamPoints} seam points, ${seams.tJunctions} T-junctions, ${seams.overlapM2} m² overlapping` : ''}`,
                resultPayload: { status: 'success', glbPath: file, outside, ...(seams ? { seams } : {}) }
            };
        } catch (err) { return failed('scene_measure_defects', err); }
    },

    scene_heal_mesh: async (args, ctx): Promise<ToolHandlerOutcome> => {
        try {
            const file = resolveGlb(args.glbPath, ctx.workspaceRoot);
            const steps = Array.isArray(args.steps) && args.steps.length ? (args.steps as string[]) : ['seams', 'orient', 'holes'];
            const base = file.replace(/\.glb$/i, ''), outTex = `${base}_healed.glb`, outClay = `${base}_healed_clay.glb`;
            const before = defectsSummary(measureVisibleDefects(fs.readFileSync(file)));
            const done: Record<string, unknown> = {};
            let tex: Uint8Array, clay: Uint8Array;
            if (steps.includes('seams')) {
                const tol = typeof args.toleranceM === 'number' ? args.toleranceM : 0.03;
                const w = await runTileSeamWeld({ inputGlb: file, outputGlb: outTex, outputClayGlb: outClay, toleranceM: tol });
                done.seams = { toleranceM: w.toleranceM, welded: w.seamWeld.groupsWelded, reverted: w.seamWeld.groupsReverted, trianglesDropped: w.seamWeld.trianglesDropped, maxMoveM: w.seamWeld.maxWeldDisplacementM, gapHistogramEdgesM: w.seamWeld.gapHistogramEdges_m, gapHistogram: w.seamWeld.gapHistogram };
                tex = fs.readFileSync(outTex); clay = fs.readFileSync(outClay);
            } else {
                tex = fs.readFileSync(file); clay = tex;
            }
            if (steps.includes('orient')) {
                const o = orientRemesh(clay, clay === tex ? [] : [tex]);
                clay = o.clay; if (o.others[0]) tex = o.others[0]; else tex = o.clay;
                done.orient = o.stats;
            }
            if (steps.includes('holes')) {
                const f = fillOpenLoops(clay, clay === tex ? [] : [tex]);
                clay = f.clay; tex = f.others[0] ?? f.clay;
                done.holes = { loops: f.report.loops, filled: f.report.filled + f.report.clipped3d, leftOpen: f.report.unclosedLoops + f.report.refusedCaps, addedM2: f.report.addedAreaM2, droppedCoveredM2: f.report.droppedCoveredM2, openEdgesAfter: f.report.openAfter };
            }
            fs.writeFileSync(outTex, tex); fs.writeFileSync(outClay, clay);
            const after = defectsSummary(measureVisibleDefects(tex));
            const rel = (p: string) => (p.startsWith(ctx.workspaceRoot) ? path.relative(ctx.workspaceRoot, p) : p);
            return {
                status: 'completed',
                summaryResult: `Healed (${steps.join(', ')}): holes ${before.holePct}% -> ${after.holePct}%, untextured ${before.clayPct}% -> ${after.clayPct}%, smeared ${before.smearPct}% -> ${after.smearPct}%`,
                resultPayload: { status: 'success', texturedGlb: rel(outTex), clayGlb: rel(outClay), steps: done, before, after, provenance: 'seam moves stay measured within the tolerance; caps are generated' }
            };
        } catch (err) { return failed('scene_heal_mesh', err); }
    }
};
