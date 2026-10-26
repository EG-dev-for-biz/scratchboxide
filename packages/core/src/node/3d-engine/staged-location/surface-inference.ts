/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The surface step of a rebuilt district, callable on its own (tool infer_surface_materials): a district massing stage
 * folder (its ground.glb, roads.glb, district_massing_textured.glb, buildings.json and the native massing run under
 * native/) and the place's photo tiles go through prepareProceduralTexturing (procedural-materials.ts):
 * - 'inferred' (the default, user decision 2026-10-22): each surface in the library material the vision model inferred for
 *   it, at real scale, tinted to the colour measured on lit tile-photo texels; the GLBs are ready to show;
 * - 'photo': the clays and fill spec the texture pass needs (the tile photo transferred onto each surface's atlas).
 * The ground counts as everything not under a rebuilt building (water is not known here, so it is measured as ground).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import type { MassingReport } from './pipeline-e/native-massing';
import { readNodes } from './pipeline-e/native-massing';
import { planRaster, prepareProceduralTexturing, readGlbNodes, type ProceduralSurfaceMode, type ProceduralTexturingSummary } from './procedural-materials';
import { loadSurfaceLibrary, type SurfaceLibrary } from './surface-materials';

export interface StageSurfaceInput {
    /** A district massing stage folder (staged build, procedural district). */
    stageDir: string;
    /** The place's photo tiles: the textured tile GLB the build extracted. */
    tilesGlb: string;
    mode?: ProceduralSurfaceMode;
    /** Where the outputs go (default <stageDir>/surfaces-<mode>). */
    outDir?: string;
    library?: SurfaceLibrary;
    chain?: Pick<VisionModelChain<string>, 'generate'>;
    unavailable?: string;
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
}

export interface StageSurfaceResult {
    mode: ProceduralSurfaceMode;
    outDir: string;
    summary: ProceduralTexturingSummary;
    /** Absolute paths of what was written: the inferred layers, or the texture pass's clays and fill spec. */
    files: Record<string, string>;
    buildings: number;
}

/** What a stage folder must hold, with the reason when something is missing. */
export function stageSurfaceFiles(stageDir: string): { ground: string; massing: string; roads?: string; buildings: string; nativeDir: string } {
    const f = (n: string) => path.join(stageDir, n);
    const need = { ground: f('ground.glb'), massing: f('district_massing_textured.glb'), buildings: f('buildings.json'), report: path.join(f('native'), 'report.json') };
    const missing = Object.entries(need).filter(([, p]) => !fs.existsSync(p)).map(([, p]) => path.relative(stageDir, p));
    if (missing.length) throw new Error(`${stageDir} is not a procedural district massing stage folder: missing ${missing.join(', ')}`);
    return { ground: need.ground, massing: need.massing, ...(fs.existsSync(f('roads.glb')) ? { roads: f('roads.glb') } : {}), buildings: need.buildings, nativeDir: f('native') };
}

export async function inferStageSurfaces(input: StageSurfaceInput): Promise<StageSurfaceResult> {
    const mode = input.mode ?? 'inferred';
    const files = stageSurfaceFiles(input.stageDir);
    if (!fs.existsSync(input.tilesGlb)) throw new Error(`no photo tiles at ${input.tilesGlb}`);
    const report = JSON.parse(fs.readFileSync(path.join(files.nativeDir, 'report.json'), 'utf8')) as MassingReport;
    const run = { dir: files.nativeDir, report, nodes: readNodes(files.nativeDir, report) };
    const rows = JSON.parse(fs.readFileSync(files.buildings, 'utf8')) as Array<{ id: string; ok?: boolean; parts?: number }>;
    const buildingIds = rows.filter(r => r.ok && (r.parts ?? 0) > 0).map(r => r.id);
    const onBuilding = planRaster(readGlbNodes(fs.readFileSync(files.massing)), 1);
    const outDir = input.outDir ?? path.join(input.stageDir, `surfaces-${mode}`);
    fs.mkdirSync(outDir, { recursive: true });
    const summary = await prepareProceduralTexturing({
        dir: outDir, tileBytes: fs.readFileSync(input.tilesGlb), files: { ground: files.ground, massing: files.massing, ...(files.roads ? { roads: files.roads } : {}) },
        buildingIds, run, include: (x, z) => !onBuilding(x, z), library: input.library ?? loadSurfaceLibrary(), mode,
        ...(input.chain ? { chain: input.chain } : {}), ...(input.unavailable ? { unavailable: input.unavailable } : {}), ...(input.signal ? { signal: input.signal } : {}), ...(input.onProgress ? { onProgress: input.onProgress } : {})
    });
    const out: Record<string, string> = {};
    if (summary.inferred) for (const [k, v] of Object.entries(summary.inferred)) { if (v) out[k] = path.join(outDir, v); }
    else for (const n of ['massing_clay.glb', 'ground_clay.glb', 'roads_clay.glb', 'fill-spec.json']) if (fs.existsSync(path.join(outDir, n))) out[n.replace(/\.\w+$/, '')] = path.join(outDir, n);
    out.materials = path.join(outDir, 'materials.json');
    return { mode, outDir, summary, files: out, buildings: buildingIds.length };
}
