/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Botanical Tree Tools Unit Tests
 * Validates Gemini / Antigravity agent tools for botanical synthesis and querying.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import {
    BOTANICAL_TREE_TOOL_DECLARATIONS,
    botanicalTreeHandlers
} from '../src/node/gemini/tools/botanical-tree-tools';

describe('Botanical Tree Agent Tools', () => {
    it('defines botanical tool declarations with appropriate parameters', () => {
        expect(BOTANICAL_TREE_TOOL_DECLARATIONS.length).toBe(2);
        const synthTool = BOTANICAL_TREE_TOOL_DECLARATIONS.find(t => t.name === 'botanical_synthesize_tree');
        expect(synthTool).toBeDefined();
        expect(synthTool!.parameters?.properties?.species).toBeDefined();
        expect(synthTool!.parameters?.properties?.season).toBeDefined();

        const queryTool = BOTANICAL_TREE_TOOL_DECLARATIONS.find(t => t.name === 'botanical_query_separator_trees');
        expect(queryTool).toBeDefined();
        expect(queryTool!.parameters?.properties?.zone).toBeDefined();
    });

    it('queries trees from the spatial separator dataset via tool handler', async () => {
        const rawRes: any = await botanicalTreeHandlers.botanical_query_separator_trees({
            zone: 'oppian_hill_crest',
            species: 'pinus_pinea',
            limit: 5
        });
        const result = rawRes.resultPayload || rawRes;

        expect(result.success).toBe(true);
        expect(result.totalFound).toBeGreaterThan(0);
        expect(result.returnedCount).toBeLessThanOrEqual(5);
        expect(result.trees[0].species).toBe('pinus_pinea');
        expect(result.trees[0].canopyHeightMeters).toBeGreaterThan(0);
    });

    it('synthesizes a 1:1 metric replacement GLB via agent tool handler', async () => {
        const rawQuery: any = await botanicalTreeHandlers.botanical_query_separator_trees({
            species: 'pinus_pinea',
            limit: 1
        });
        const queryRes = rawQuery.resultPayload || rawQuery;
        const tree = queryRes.trees[0];

        const rawSynth: any = await botanicalTreeHandlers.botanical_synthesize_tree({
            treeId: tree.id,
            species: tree.species,
            season: 1.0,
            leafDensity: 0.7
        });
        const synthRes = rawSynth.resultPayload || rawSynth;

        expect(synthRes.success).toBe(true);
        expect(synthRes.treeId).toBe(tree.id);
        expect(synthRes.species).toBe('pinus_pinea');
        expect(synthRes.archetype).toBe('conifer');
        expect(synthRes.outputGlbPath).toBeDefined();
        expect(fs.existsSync(synthRes.outputGlbPath)).toBe(true);
        expect(synthRes.worldPosition).toBeDefined();
    }, 30000);
});
