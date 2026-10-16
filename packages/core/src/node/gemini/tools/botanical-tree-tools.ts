/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Botanical agent tool: one SB-Veggie tree (space colonisation, studio clay) grown to the measurements the request
 * gives. Nothing is assumed: a missing height or crown spread fails the call, and what the measurements cannot say
 * (crown base, trunk radius) comes from explicit ratios that the result reports as inferred. Real-world locations get
 * their trees measured from the photo tiles by google_3d_tiles_get_clay instead.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolResultPayload } from './types';
import { findTileVegetationRepoRoot, getTileVegetationService } from '../../3d-engine/tile-vegetation-service';
import { resolveWithinRoot } from '../../security/path-guard';

export const BOTANICAL_TREE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'botanical_synthesize_tree',
        description: 'Grow one standalone SB-Veggie tree (space colonisation inside an ellipsoidal crown of the given size, studio clay GLB) to the measurements given: total height and crown spread in metres are required; crown base height, trunk radius, position and a triangle budget are optional. Returns the GLB path and the height and spread actually grown. Not for real-world places: google_3d_tiles_get_clay measures and rebuilds the trees of a location itself.',
        parameters: {
            type: 'OBJECT',
            properties: {
                heightMeters: { type: 'NUMBER', description: 'Total tree height from the ground to the top of the crown, metres (required).' },
                crownDiameterMeters: { type: 'NUMBER', description: 'Crown spread (diameter), metres (required).' },
                crownBaseHeightMeters: { type: 'NUMBER', description: 'Height of the lowest crown branches above the ground, metres. When omitted it is 0.35 of the height and reported as inferred.' },
                trunkRadiusMeters: { type: 'NUMBER', description: 'Trunk radius above the root flare, metres. When omitted it is 0.016 of the height and reported as inferred.' },
                position: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Trunk base [x, y, z] in metres (default: the origin).' },
                triangleBudget: { type: 'NUMBER', description: 'Triangle budget for the tree\'s wood (default 8000). The tree is delivered at three levels of detail on that one skeleton; the leaves of each level come on top of the wood, and the triangles of every level are reported.' },
                label: { type: 'STRING', description: 'Optional free-text label for the tree (e.g. what kind of tree it is); stored in the GLB, it does not change the geometry.' },
                seed: { type: 'STRING', description: 'Optional hex seed (1-16 digits) for a different but reproducible branching.' },
                outputGlbPath: { type: 'STRING', description: 'Optional workspace path to copy the resulting .glb to.' }
            },
            required: ['heightMeters', 'crownDiameterMeters']
        }
    }
];

function positiveNumber(args: Record<string, unknown>, key: string, required: boolean): number | undefined {
    const v = args[key];
    if (v === undefined || v === null) {
        if (required) throw new Error(`botanical_synthesize_tree: "${key}" is required (metres); nothing is assumed.`);
        return undefined;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`botanical_synthesize_tree: "${key}" must be a number greater than 0.`);
    return n;
}

/** The surface of an ellipsoidal crown (upper half) on a 0.5 m grid, as the crown samples tile_vegetation plants into. */
function crownSurface(x: number, y: number, z: number, height: number, radius: number, crownBase: number): number[][] {
    const samples: number[][] = [];
    const step = Math.max(0.35, radius / 12);
    const depth = height - crownBase;
    for (let dx = -radius; dx <= radius + 1e-9; dx += step) {
        for (let dz = -radius; dz <= radius + 1e-9; dz += step) {
            const u = 1 - (dx * dx + dz * dz) / (radius * radius);
            if (u < 0) continue;
            samples.push([x + dx, y + crownBase + depth * (0.5 + 0.5 * Math.sqrt(u)), z + dz]);
        }
    }
    return samples;
}

export const botanicalTreeHandlers: Record<string, ToolHandler> = {
    botanical_synthesize_tree: async (args, ctx) => {
        const height = positiveNumber(args, 'heightMeters', true)!;
        const diameter = positiveNumber(args, 'crownDiameterMeters', true)!;
        const crownBaseArg = positiveNumber(args, 'crownBaseHeightMeters', false);
        const trunkRadius = positiveNumber(args, 'trunkRadiusMeters', false);
        const budget = positiveNumber(args, 'triangleBudget', false) ?? 8000;
        if (crownBaseArg !== undefined && crownBaseArg >= height) throw new Error('botanical_synthesize_tree: "crownBaseHeightMeters" must be lower than "heightMeters".');
        const pos = Array.isArray(args.position) ? (args.position as unknown[]).map(Number) : [0, 0, 0];
        if (pos.length !== 3 || pos.some(v => !Number.isFinite(v))) throw new Error('botanical_synthesize_tree: "position" must be [x, y, z] in metres.');
        const [x, y, z] = pos;
        const radius = diameter / 2;
        const crownBaseRatio = crownBaseArg !== undefined ? crownBaseArg / height : 0.35;
        const label = typeof args.label === 'string' ? args.label.slice(0, 200) : undefined;
        const seed = typeof args.seed === 'string' && args.seed ? args.seed : crypto.createHash('sha256').update(JSON.stringify([height, diameter, crownBaseRatio, x, y, z])).digest('hex').slice(0, 16);

        const root = findTileVegetationRepoRoot();
        const id = crypto.createHash('sha256').update(JSON.stringify({ height, diameter, crownBaseRatio, trunkRadius, x, y, z, seed, label: label ?? null })).digest('hex').slice(0, 16);
        const requestDir = resolveWithinRoot(root, path.join('.scratchbox', 'cache', 'botanical_requests'));
        fs.mkdirSync(requestDir, { recursive: true });
        const crownsPath = path.join(requestDir, `${id}.json`);
        const area = Math.PI * radius * radius;
        fs.writeFileSync(crownsPath, JSON.stringify({
            version: 1,
            frame: null,
            // a free-text name for the tree: written to the GLB's root extras, it never changes the geometry
            ...(label ? { label } : {}),
            crowns: [{
                id: 0, status: 'tree', apex: [x, y + height, z], stem: [x, z], supportY: y, supportSource: 'given', terrainY: y,
                apexAboveSupport: height, areaM2: area, sectorRadii: new Array(16).fill(radius),
                samples: crownSurface(x, y, z, height, radius, crownBaseRatio * height)
            }]
        }));
        ctx?.reportProgress?.('Growing the SB-Veggie tree');
        const planted = await getTileVegetationService(root).plant({
            crownsPath,
            triangleBudget: budget,
            seed,
            params: { crownBaseRatio, ...(trunkRadius !== undefined ? { trunkRadiusPerHeight: trunkRadius / height } : {}) }
        });
        const tree = planted.stats.perTree?.[0];
        if (!tree?.bounds) throw new Error('botanical_synthesize_tree: the tree model reports no geometry');
        const [lo, hi] = tree.bounds as number[][];
        let outputGlbPath = planted.treesGlb;
        if (typeof args.outputGlbPath === 'string' && args.outputGlbPath.trim()) {
            outputGlbPath = resolveWithinRoot(ctx?.workspaceRoot || root, args.outputGlbPath.trim());
            fs.mkdirSync(path.dirname(outputGlbPath), { recursive: true });
            fs.copyFileSync(planted.treesGlb, outputGlbPath);
        }
        const grownHeight = hi[1] - y;
        const grownSpread = Math.max(hi[0] - lo[0], hi[2] - lo[2]);
        const inferred: Record<string, number> = {};
        if (crownBaseArg === undefined) inferred.crownBaseRatio = crownBaseRatio;
        if (trunkRadius === undefined) inferred.trunkRadiusPerHeight = Number(planted.stats.inferred?.trunkRadiusPerHeight);
        return {
            resultPayload: {
                treeId: id,
                label,
                generator: 'SB-Veggie (space colonisation)',
                outputGlbPath,
                position: [x, y, z],
                requested: { heightMeters: height, crownDiameterMeters: diameter },
                grown: { heightMeters: grownHeight, crownSpreadMeters: grownSpread, bounds: tree.bounds },
                triangles: tree.triangles,
                woodTriangles: tree.wood,
                levelTriangles: tree.lod ? [tree.lod.level0?.drawnTriangles, tree.lod.level1?.drawnTriangles, tree.lod.level2Triangles] : undefined,
                triangleBudget: budget,
                inferred,
                seed
            } as unknown as ToolResultPayload,
            summaryResult: `Grew one SB-Veggie tree (space colonisation, studio clay): ${grownHeight.toFixed(1)} m tall and ${grownSpread.toFixed(1)} m across (asked for ${height} m and ${diameter} m), ${tree.triangles} triangles at the far level (${tree.wood} of them wood, within the ${budget} budget for wood; nearer levels draw ${tree.lod?.level0?.drawnTriangles ?? 'n/a'} and ${tree.lod?.level1?.drawnTriangles ?? 'n/a'}). ${Object.keys(inferred).length ? `Inferred, not given: ${Object.entries(inferred).map(([k, v]) => `${k} ${v}`).join(', ')}. ` : ''}GLB: ${outputGlbPath}.`
        };
    }
};
