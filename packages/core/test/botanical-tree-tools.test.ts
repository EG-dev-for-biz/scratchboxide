/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * botanical_synthesize_tree grows one SB-Veggie tree (space colonisation through the native tile_vegetation plant
 * stage) to the measurements it is given, in studio clay. Nothing is assumed: no default height, no species
 * catalogue, no "identified" trees from a list; a missing measurement fails the call.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { BOTANICAL_TREE_TOOL_DECLARATIONS, botanicalTreeHandlers } from '../src/node/gemini/tools/botanical-tree-tools';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { parseGlb, readGlbTriangles, renderClayPng } from './helpers/clay-glb-render';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/tile_vegetation');

const ctx = { request: { prompt: 'grow a tree' } } as any;

describe('botanical_synthesize_tree (SB-Veggie, space colonisation)', () => {
    it('declares one tool that needs the tree measurements and offers no species catalogue or scan query', () => {
        expect(BOTANICAL_TREE_TOOL_DECLARATIONS.map(d => d.name)).toEqual(['botanical_synthesize_tree']);
        const params = BOTANICAL_TREE_TOOL_DECLARATIONS[0].parameters as any;
        expect(params.required).toEqual(['heightMeters', 'crownDiameterMeters']);
        for (const gone of ['species', 'season', 'treeId', 'rawScanGlbPath', 'archetype']) expect(params.properties[gone]).toBeUndefined();
        const registry = createDefaultToolRegistry();
        expect(registry.get('botanical_query_separator_trees')).toBeUndefined();
        expect(registry.get('harmonize_photogrammetric_district')).toBeUndefined();
    });

    it('grows a clay tree to the requested height and spread, standing where it was asked, within its budget', async () => {
        const outcome = await botanicalTreeHandlers.botanical_synthesize_tree(
            { heightMeters: 12, crownDiameterMeters: 8, position: [5, 2, -3], triangleBudget: 3000, label: 'plane tree' }, ctx);
        const r: any = outcome.resultPayload;
        expect(r.success).toBeUndefined();
        expect(r.generator).toBe('SB-Veggie (space colonisation)');
        // the budget is the wood's; the leaves of each level come on top, and every level is reported
        expect(r.woodTriangles).toBeLessThanOrEqual(3000);
        expect(r.levelTriangles).toHaveLength(3);
        expect(r.triangles).toBe(r.levelTriangles[2]);
        // the leaf masses stay inside the requested crown even at a coarse budget
        expect(Math.abs(r.grown.heightMeters - 12)).toBeLessThan(1.0);
        expect(r.grown.crownSpreadMeters).toBeGreaterThan(0.85 * 8);
        expect(r.grown.crownSpreadMeters).toBeLessThan(1.15 * 8);
        expect(r.inferred).toMatchObject({ crownBaseRatio: 0.35, trunkRadiusPerHeight: 0.016 });
        expect(outcome.summaryResult).toContain('Inferred, not given');

        const buf = fs.readFileSync(r.outputGlbPath);
        expect(buf.subarray(0, 4).toString('latin1')).toBe('glTF');
        expect(buf.readUInt32LE(4)).toBe(2);
        expect(buf.readUInt32LE(8)).toBe(buf.length);
        const glb = parseGlb(buf);
        expect(glb.json.materials[0].pbrMetallicRoughness).toMatchObject({ baseColorFactor: [0.55, 0.57, 0.6, 1], metallicFactor: 0, roughnessFactor: 0.85 });
        expect(glb.json.extras.label).toBe('plane tree');
        const tris = readGlbTriangles(buf);
        expect(tris.indices.length / 3).toBe(r.triangles);
        let minY = Infinity, maxY = -Infinity;
        for (let v = 1; v < tris.positions.length; v += 3) { minY = Math.min(minY, tris.positions[v]); maxY = Math.max(maxY, tris.positions[v]); }
        expect(Math.abs(minY - 2)).toBeLessThan(0.3);   // the trunk base stands on the given position
        expect(Math.abs(maxY - 14)).toBeLessThan(1.0);  // and the crown reaches the given height above it
        fs.mkdirSync(SHOTS, { recursive: true });
        const png = renderClayPng([{ positions: tris.positions, indices: tris.indices }], { kind: 'aerial', width: 720, height: 720, region: [-7, -15, 17, 9], bearingDeg: 210, elevationDeg: 20 });
        fs.writeFileSync(path.join(SHOTS, 'botanical_synthesize_tree_12m_8m.png'), png);
        expect(png.readUInt32BE(0)).toBe(0x89504e47);
    }, 600_000);

    it('reports a given crown base and trunk radius as measured, not inferred', async () => {
        const r: any = (await botanicalTreeHandlers.botanical_synthesize_tree(
            { heightMeters: 9, crownDiameterMeters: 6, crownBaseHeightMeters: 3, trunkRadiusMeters: 0.2, triangleBudget: 2000 }, ctx)).resultPayload;
        expect(r.inferred).toEqual({});
        expect(r.woodTriangles).toBeLessThanOrEqual(2000);
    }, 600_000);

    it('fails, with nothing grown, when a measurement is missing or impossible', async () => {
        const registry = createDefaultToolRegistry();
        const noHeight = await registry.dispatch('botanical_synthesize_tree', { crownDiameterMeters: 8 }, ctx);
        expect(noHeight.exec.status).toBe('failed');
        expect((noHeight.resultPayload as any).error).toContain('"heightMeters" is required');
        const noSpread = await registry.dispatch('botanical_synthesize_tree', { heightMeters: 12 }, ctx);
        expect(noSpread.exec.status).toBe('failed');
        expect((noSpread.resultPayload as any).error).toContain('"crownDiameterMeters" is required');
        const baseAboveTop = await registry.dispatch('botanical_synthesize_tree', { heightMeters: 8, crownDiameterMeters: 6, crownBaseHeightMeters: 9 }, ctx);
        expect(baseAboveTop.exec.status).toBe('failed');
        const tiny = await registry.dispatch('botanical_synthesize_tree', { heightMeters: 8, crownDiameterMeters: 6, triangleBudget: 10 }, ctx);
        expect(tiny.exec.status).toBe('failed');
        expect((tiny.resultPayload as any).error).toContain('cannot hold 1 trees');
    }, 600_000);
});
