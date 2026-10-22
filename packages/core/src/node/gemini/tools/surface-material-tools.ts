/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * infer_surface_materials: the surface step of a rebuilt district run on its own (staged-location/surface-inference.ts):
 * each rebuilt surface (building walls and roofs, ground regions, carriageways, kerbs) gets the library material the vision
 * model infers for it from the photo tiles, at real scale, tinted to its lit colour; or, in photo mode, the clays and
 * fill spec for the texture pass. The written GLBs are published under /models for the scene to load.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MissingInputError } from '../../../common/errors/pipeline-errors';
import { inferStageSurfaces, type StageSurfaceInput } from '../../3d-engine/staged-location/surface-inference';
import { createStagedLocationDeps } from '../../3d-engine/staged-location/staged-location-tool';
import { stagedWorkspaceRoot } from '../../3d-engine/staged-location/stage-cache';
import { VisionModelChain } from '../vision-model-chain';
import { resolveRepoRoot } from './nano-banana-tools';
import type { ToolDeclaration, ToolHandler } from './types';

export const SURFACE_MATERIALS_TOOL_NAME = 'infer_surface_materials';

export const SURFACE_MATERIALS_TOOL_DECLARATION: ToolDeclaration = {
    name: SURFACE_MATERIALS_TOOL_NAME,
    description: 'Give every rebuilt surface of a procedural district its material: the vision model infers, from the place\'s photo tiles, '
        + 'which surface-library material each building\'s walls and roofs, each ground region, the carriageways and the kerbs are, and writes '
        + 'them in it at real scale, tinted to the colour measured on lit photo texels (generated, no photo texel drawn, no baked shadow). '
        + 'mode "photo" instead prepares the texture pass (the photo transferred onto each surface). Input: the district massing stage '
        + 'folder a staged build reports (stageDir) and the place\'s photo tiles GLB. Returns the written GLBs with /models URLs and the '
        + 'material chosen per surface.',
    parameters: {
        type: 'OBJECT',
        properties: {
            stageDir: { type: 'STRING', description: 'The district massing stage folder of a staged build (holds ground.glb, district_massing_textured.glb, buildings.json, native/).' },
            tilesGlb: { type: 'STRING', description: 'Path of the place\'s textured photo tiles GLB (the staged build\'s tiles layer).' },
            mode: { type: 'STRING', description: '"inferred" (default): materials inferred per surface; "photo": prepare the texture pass instead.' },
            outputDir: { type: 'STRING', description: 'Optional output folder (default <stageDir>/surfaces-<mode>).' }
        },
        required: ['stageDir', 'tilesGlb']
    }
};

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function createSurfaceMaterialsHandler(deps: { run?: typeof inferStageSurfaces; chain?: StageSurfaceInput['chain']; modelsDir?: string } = {}): ToolHandler {
    return async (args, ctx) => {
        const stageDir = str(args.stageDir), tilesGlb = str(args.tilesGlb);
        if (!stageDir) throw new MissingInputError(SURFACE_MATERIALS_TOOL_NAME, 'stageDir', 'the district massing stage folder');
        if (!tilesGlb) throw new MissingInputError(SURFACE_MATERIALS_TOOL_NAME, 'tilesGlb', 'the place\'s photo tiles GLB');
        const mode = str(args.mode).toLowerCase() === 'photo' ? 'photo' as const : 'inferred' as const;
        let chain = deps.chain, unavailable: string | undefined;
        if (!chain) {
            const staged = await createStagedLocationDeps(stagedWorkspaceRoot(), { signal: ctx?.signal });
            if (staged.vision && 'client' in staged.vision) chain = new VisionModelChain<string>({ client: staged.vision.client, candidates: staged.vision.candidates, ...(ctx?.signal ? { signal: ctx.signal } : {}) });
            else unavailable = staged.vision && 'unavailable' in staged.vision ? String(staged.vision.unavailable) : 'no vision model configured';
        }
        const r = await (deps.run ?? inferStageSurfaces)({ stageDir, tilesGlb, mode, ...(str(args.outputDir) ? { outDir: str(args.outputDir) } : {}), ...(chain ? { chain } : {}), ...(unavailable ? { unavailable } : {}), ...(ctx?.signal ? { signal: ctx.signal } : {}), onProgress: m => ctx?.reportProgress?.(m) });
        // the GLBs published under /models so a scene can load them
        const modelsDir = deps.modelsDir ?? path.join(resolveRepoRoot(), 'public', 'models');
        fs.mkdirSync(modelsDir, { recursive: true });
        const stamp = `${path.basename(stageDir).slice(0, 8)}_${mode}_${Date.now()}`;
        const published: Record<string, { path: string; url: string }> = {};
        for (const [k, p] of Object.entries(r.files)) {
            if (!p.endsWith('.glb')) continue;
            const name = `surfaces_${stamp}_${path.basename(p)}`;
            fs.copyFileSync(p, path.join(modelsDir, name));
            published[k] = { path: path.join(modelsDir, name), url: `/models/${name}` };
        }
        const entries = Object.entries(r.summary.entries).map(([e, n]) => `${e} x${n}`).join(', ');
        const summary = mode === 'inferred'
            ? `Inferred materials for ${r.buildings} buildings, ${r.summary.groundRegions} ground regions${r.files.roads ? ' and the streets' : ''}: ${entries} (${r.summary.byVision} by vision, ${r.summary.byColour} by measured colour alone). Generated library materials tinted to lit colour; no photo texel drawn.`
            : `Prepared the texture pass for ${r.buildings} buildings and ${r.summary.groundRegions} ground regions; library fill: ${entries}.`;
        return { resultPayload: { success: true, mode, provenance: { label: 'generated', basis: mode === 'inferred' ? 'library material inferred per surface' : 'texture-pass preparation' }, outDir: r.outDir, files: r.files, published, choices: r.summary, summary }, summaryResult: summary };
    };
}

export const SURFACE_MATERIALS_TOOL_DECLARATIONS: ToolDeclaration[] = [SURFACE_MATERIALS_TOOL_DECLARATION];

export const surfaceMaterialsHandlers: Record<string, ToolHandler> = {
    [SURFACE_MATERIALS_TOOL_NAME]: createSurfaceMaterialsHandler()
};
