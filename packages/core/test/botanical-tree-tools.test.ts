/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * botanical_synthesize_tree, the vegetation generator of every scene, grows SB-Veggie trees (space colonisation through
 * the native tile_vegetation grow stage: the staged planting, its species library chosen by the crown's measurements and
 * its four levels of detail) to the measurements it is given. A missing height or crown spread fails the call; what the
 * description leaves out comes from the species entry nearest the crown and is reported as inferred.
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
        // one tree with the top-level fields or several with trees: the handler requires height and spread per tree
        expect(Object.keys(params.properties)).toEqual(expect.arrayContaining(['heightMeters', 'crownDiameterMeters', 'trees']));
        expect(params.properties.trees.items.required).toEqual(['heightMeters']);
        for (const gone of ['species', 'season', 'treeId', 'rawScanGlbPath', 'archetype']) expect(params.properties[gone]).toBeUndefined();
        const registry = createDefaultToolRegistry();
        expect(registry.get('botanical_query_separator_trees')).toBeUndefined();
        expect(registry.get('harmonize_photogrammetric_district')).toBeUndefined();
    });

    it('grows a clay tree to the requested height and spread, standing where it was asked, within its budget', async () => {
        const outcome = await botanicalTreeHandlers.botanical_synthesize_tree(
            { heightMeters: 12, crownDiameterMeters: 8, position: [5, 2, -3], triangleBudget: 3000, label: 'plane tree', openScene: false }, ctx);
        const r: any = outcome.resultPayload;
        expect(r.success).toBeUndefined();
        expect(r.generator).toBe('SB-Veggie (space colonisation)');
        // the budget is the wood's; the leaves of each level come on top, and every level is reported
        expect(r.woodTriangles).toBeLessThanOrEqual(3000);
        expect(r.levelTriangles).toHaveLength(4);
        expect(r.triangles).toBe(r.levelTriangles[3]);
        expect(r.provenance).toContain('generated');
        // near > near-mid > mid > far
        for (let k = 0; k < 3; k++) expect(r.levelTriangles[k]).toBeGreaterThan(r.levelTriangles[k + 1]);
        // the leaf masses stay inside the requested crown even at a coarse budget
        expect(Math.abs(r.grown.heightMeters - 12)).toBeLessThan(1.0);
        expect(r.grown.crownSpreadMeters).toBeGreaterThan(0.85 * 8);
        expect(r.grown.crownSpreadMeters).toBeLessThan(1.15 * 8);
        // what the description leaves out comes from the species library, reported as inferred
        expect(r.inferred.crownBaseRatio).toBeGreaterThan(0);
        expect(r.inferred.trunkRadiusM).toBeGreaterThan(0);
        expect(outcome.summaryResult).toMatch(/inferred, not given/i);

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
            { heightMeters: 9, crownDiameterMeters: 6, crownBaseHeightMeters: 3, trunkRadiusMeters: 0.2, triangleBudget: 2000, openScene: false }, ctx)).resultPayload;
        expect(r.inferred).toEqual({});
        expect(r.woodTriangles).toBeLessThanOrEqual(2000);
        expect(r.trees[0].inferred).toEqual({});
    }, 600_000);

    it('grows a group of described trees in one call and opens them as a scene of SB-Veggie trees', async () => {
        const outcome = await botanicalTreeHandlers.botanical_synthesize_tree({
            trees: [
                { heightMeters: 14, crownDiameterMeters: 4.5, crownWidestAt: 0.05, crownTopExponent: 1, position: [0, 0, 0], label: 'cone' },
                { heightMeters: 9, crownDiameterMeters: 9, leafColor: '#5a7a2c', position: [10, 0, 2], label: 'round' }
            ]
        }, ctx);
        const r: any = outcome.resultPayload;
        expect(r.trees).toHaveLength(2);
        expect(r.trees.map((t: any) => t.label)).toEqual(['cone', 'round']);
        for (const t of r.trees) expect(t.levelTriangles).toHaveLength(4);
        expect(r.trees[0].species?.entry).not.toBe(r.trees[1].species?.entry);
        expect(r.artifact.type).toBe('3d-scene');
        expect(r.artifact.data.objects[0].content.durableUri).toMatch(/^\/models\/sb_veggie_trees_[0-9a-f]{12}\.glb$/);
        const json = parseGlb(fs.readFileSync(r.outputGlbPath)).json;
        expect(json.extras.sbVeggie.trees).toBe(2);
        const nodes = json.nodes.filter((n: any) => n.extras?.sbTree);
        expect(nodes.map((n: any) => n.extras.sb.provenance.label)).toEqual(['generated', 'generated']);
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
