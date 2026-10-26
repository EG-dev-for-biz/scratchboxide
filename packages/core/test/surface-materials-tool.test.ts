/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * infer_surface_materials (gemini/tools/surface-material-tools.ts over staged-location/surface-inference.ts): the tool runs
 * the surface step on a stage folder in the mode asked (inferred by default), publishes the GLBs it wrote under /models
 * and reports the choices; a folder that is not a district massing stage is refused, naming what is missing; the
 * the tool infers by default; a build takes the texture pass unless SCRATCHBOX_STAGED_SURFACE_TEXTURES=inferred.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createSurfaceMaterialsHandler, SURFACE_MATERIALS_TOOL_NAME } from '../src/node/gemini/tools/surface-material-tools';
import { stageSurfaceFiles } from '../src/node/3d-engine/staged-location/surface-inference';
import { proceduralSurfaceMode } from '../src/node/3d-engine/staged-location/procedural-materials';
import { DEFAULT_TOOL_DECLARATIONS } from '../src/node/gemini/tools';
import { GEOSPATIAL_3D_PACK } from '../src/node/gemini/domain-tool-packs';

describe('infer_surface_materials', () => {
    it('runs the surface step in the mode asked and publishes the GLBs it wrote', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-tool-')), models = path.join(dir, 'models');
        const calls: any[] = [];
        const handler = createSurfaceMaterialsHandler({
            chain: { generate: async () => { throw new Error('not called'); } } as never, modelsDir: models,
            run: async (input) => {
                calls.push(input);
                const out = path.join(dir, 'out');
                fs.mkdirSync(out, { recursive: true });
                for (const n of ['massing_inferred.glb', 'ground_inferred.glb']) fs.writeFileSync(path.join(out, n), Buffer.from('glTF'));
                fs.writeFileSync(path.join(out, 'materials.json'), '{}');
                return { mode: input.mode!, outDir: out, buildings: 3, files: { massing: path.join(out, 'massing_inferred.glb'), ground: path.join(out, 'ground_inferred.glb'), materials: path.join(out, 'materials.json') },
                    summary: { chosen: { buildings: 6, ground: 2 }, byVision: 7, byColour: 1, borrowed: 0, entries: { red_brick_wall: 4, asphalt_worn: 1 }, groundRegions: 2, shadowedCells: 0, inferred: { ground: 'ground_inferred.glb', massing: 'massing_inferred.glb' } } };
            }
        });
        const r = await handler({ stageDir: '/stage/abc12345', tilesGlb: '/tiles.glb' }, {} as never);
        expect(calls[0]).toMatchObject({ stageDir: '/stage/abc12345', tilesGlb: '/tiles.glb', mode: 'inferred' });
        const p = r.resultPayload as any;
        expect(Object.keys(p.published).sort()).toEqual(['ground', 'massing']);
        expect(p.published.massing.url).toMatch(/^\/models\/surfaces_abc12345_inferred_\d+_massing_inferred\.glb$/);
        expect(fs.readFileSync(p.published.massing.path, 'utf8')).toBe('glTF');
        expect(r.summaryResult).toMatch(/Inferred materials for 3 buildings, 2 ground regions: red_brick_wall x4, asphalt_worn x1 \(7 by vision, 1 by measured colour alone\)/);
        await handler({ stageDir: '/stage/abc12345', tilesGlb: '/tiles.glb', mode: 'photo' }, {} as never);
        expect(calls[1].mode).toBe('photo');
    });

    it('refuses a folder that is not a district massing stage, naming what is missing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surf-stage-'));
        fs.writeFileSync(path.join(dir, 'ground.glb'), '');
        expect(() => stageSurfaceFiles(dir)).toThrow(/missing district_massing_textured\.glb, buildings\.json, native\/report\.json/);
    });

    it('builds take the texture pass by default, inferred on request; it is offered in the geospatial pack', () => {
        expect(proceduralSurfaceMode({})).toBe('photo');
        expect(proceduralSurfaceMode({ SCRATCHBOX_STAGED_SURFACE_TEXTURES: 'inferred' })).toBe('inferred');
        expect(DEFAULT_TOOL_DECLARATIONS.some(d => d.name === SURFACE_MATERIALS_TOOL_NAME)).toBe(true);
        expect(GEOSPATIAL_3D_PACK.toolNames).toContain(SURFACE_MATERIALS_TOOL_NAME);
    });
});
