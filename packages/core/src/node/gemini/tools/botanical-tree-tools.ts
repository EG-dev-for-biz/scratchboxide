/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The vegetation tool: SB-Veggie trees (the one vegetation generator of every 3D path) grown to the measurements the
 * request gives - one tree or a group, each described by its height and crown spread (required), and optionally its
 * crown base, where its crown is widest, the shape of its top, its trunk radius, its leaf colour and a free-text
 * label. They are grown by the staged location's planting (tile_vegetation grow, scratchbox_sb_veggie_grove.hpp):
 * space-colonisation branching inside each described crown, SB-Veggie leaf clusters, the tree species library chosen
 * by the crown's measurements (it supplies what the description leaves out, reported), the tree texture library and
 * the viewport's levels of detail. Each tree is labelled generated (no scan behind it). The result opens as a new 3D
 * scene unless openScene is false. Trees inside a scripted scene come from sb.create_tree (the same grower); a real
 * place's trees are measured and regrown by google_3d_tiles_get_clay.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolResultPayload } from './types';
import { findTileVegetationRepoRoot, getTileVegetationService, type DescribedTreeSpec } from '../../3d-engine/tile-vegetation-service';
import { glbWorldBounds } from '../../3d-engine/part-connectivity';
import { resolveWithinRoot } from '../../security/path-guard';

const TREE_FIELDS = {
    heightMeters: { type: 'NUMBER', description: 'Trunk base to the top of the crown, metres (required).' },
    crownDiameterMeters: { type: 'NUMBER', description: 'Crown spread (diameter), metres (required unless crownDiametersMeters is given).' },
    crownDiametersMeters: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Optional oval crown: spread along x and along z, metres.' },
    crownBaseHeightMeters: { type: 'NUMBER', description: 'Height of the lowest crown branches above the trunk base, metres. Omitted: the tree species library entry nearest the crown\'s shape gives it (reported as inferred).' },
    crownWidestAt: { type: 'NUMBER', description: 'Share of the crown\'s depth at which it is widest: 0 a cone widest at its base (a fir), 0.5 a round crown (default), 0.8 an umbrella or flat-topped crown.' },
    crownTopExponent: { type: 'NUMBER', description: 'Shape of the crown\'s top: 1 a cone, 2 a dome (default), 4 a flat top.' },
    trunkRadiusMeters: { type: 'NUMBER', description: 'Trunk radius above the root flare, metres. Omitted: from the species entry (reported as inferred).' },
    leafColor: { type: 'STRING', description: 'Optional foliage colour as #rrggbb (sRGB); the species and leaf textures are chosen by it, with the crown shape.' },
    position: { type: 'ARRAY', items: { type: 'NUMBER' }, description: 'Trunk base [x, y, z] in metres, y up (default: the origin).' },
    label: { type: 'STRING', description: 'Optional free-text label (what the tree is); stored in the GLB, it does not change the geometry.' }
} as const;

export const BOTANICAL_TREE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'botanical_synthesize_tree',
        description: 'The vegetation generator for any 3D scene: grows SB-Veggie trees, shrubs or a group of them (space-colonisation branching inside each described crown, SB-Veggie leaf clusters, species and leaf textures chosen by the crown\'s shape and colour, viewport levels of detail), the same trees a staged real place gets. Each tree is described by measurements: height and crown spread (required), optionally crown base, where the crown is widest, the shape of its top, trunk radius, leaf colour and position. Give one tree with the top-level fields, or several with trees. The trees open as a new 3D scene (openScene false: only the GLB). Inside a scripted scene, add trees with sb.create_tree in the script instead (the same grower); never model trees or foliage from boxes, cones, spheres, sweeps or L-systems. Not for real places: google_3d_tiles_get_clay measures and regrows a location\'s trees itself.',
        parameters: {
            type: 'OBJECT',
            properties: {
                ...TREE_FIELDS,
                trees: {
                    type: 'ARRAY',
                    description: 'Several trees, each with the fields above (heightMeters and crownDiameterMeters required per tree); replaces the top-level tree fields.',
                    items: { type: 'OBJECT', properties: { ...TREE_FIELDS }, required: ['heightMeters'] }
                },
                triangleBudget: { type: 'NUMBER', description: 'Optional triangle budget for all the trees\' wood together (default: each tree\'s own budget from its crown). The trees are delivered at four levels of detail; the leaves of each level come on top, and every level is reported.' },
                seed: { type: 'STRING', description: 'Optional hex seed (1-16 digits) for a different but reproducible branching.' },
                outputGlbPath: { type: 'STRING', description: 'Optional workspace path to copy the resulting .glb to.' },
                openScene: { type: 'BOOLEAN', description: 'Open the trees as a new 3D scene (default true).' }
            }
        }
    }
];

type Args = Record<string, unknown>;

function positiveNumber(args: Args, key: string, required: boolean, where: string): number | undefined {
    const v = args[key];
    if (v === undefined || v === null) {
        if (required) throw new Error(`botanical_synthesize_tree: ${where}"${key}" is required (metres); nothing is assumed.`);
        return undefined;
    }
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`botanical_synthesize_tree: ${where}"${key}" must be a number greater than 0.`);
    return n;
}

function shareOf(args: Args, key: string, lo: number, hi: number, where: string): number | undefined {
    const v = args[key];
    if (v === undefined || v === null) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`botanical_synthesize_tree: ${where}"${key}" must be a number in [${lo}, ${hi}].`);
    return n;
}

/** sRGB #rrggbb -> linear RGB. */
function leafLinear(value: unknown, where: string): [number, number, number] | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const m = typeof value === 'string' ? /^#?([0-9a-fA-F]{6})$/.exec(value.trim()) : null;
    if (!m) throw new Error(`botanical_synthesize_tree: ${where}"leafColor" must be #rrggbb.`);
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const hex = m[1];
    return [0, 2, 4].map(i => Number(lin(parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(6))) as [number, number, number];
}

/** One tool tree (metres, diameters) -> a described tree (radii). */
export function describedTreeFromArgs(a: Args, where = ''): DescribedTreeSpec {
    const height = positiveNumber(a, 'heightMeters', true, where)!;
    let radii: [number, number];
    if (Array.isArray(a.crownDiametersMeters)) {
        const d = (a.crownDiametersMeters as unknown[]).map(Number);
        if (d.length !== 2 || d.some(v => !Number.isFinite(v) || v <= 0)) throw new Error(`botanical_synthesize_tree: ${where}"crownDiametersMeters" must be [along x, along z] in metres.`);
        radii = [d[0] / 2, d[1] / 2];
    } else {
        const d = positiveNumber(a, 'crownDiameterMeters', true, where)!;
        radii = [d / 2, d / 2];
    }
    const base = positiveNumber(a, 'crownBaseHeightMeters', false, where);
    if (base !== undefined && base >= height) throw new Error(`botanical_synthesize_tree: ${where}"crownBaseHeightMeters" must be lower than "heightMeters".`);
    const trunk = positiveNumber(a, 'trunkRadiusMeters', false, where);
    const widest = shareOf(a, 'crownWidestAt', 0, 0.9, where);
    const exponent = shareOf(a, 'crownTopExponent', 0.5, 8, where);
    const pos = Array.isArray(a.position) ? (a.position as unknown[]).map(Number) : [0, 0, 0];
    if (pos.length !== 3 || pos.some(v => !Number.isFinite(v))) throw new Error(`botanical_synthesize_tree: ${where}"position" must be [x, y, z] in metres.`);
    const leaf = leafLinear(a.leafColor, where);
    return {
        position: [pos[0], pos[1], pos[2]], heightM: height, crownRadiiM: radii,
        ...(base !== undefined ? { crownBaseHeightM: base } : {}),
        ...(trunk !== undefined ? { trunkRadiusM: trunk } : {}),
        ...(widest !== undefined ? { crownWidestAt: widest } : {}),
        ...(exponent !== undefined ? { crownTopExponent: exponent } : {}),
        ...(leaf ? { leafLinearRgb: leaf } : {}),
        ...(typeof a.label === 'string' && a.label.trim() ? { label: a.label.slice(0, 200) } : {})
    };
}

/** Each tree's drawn triangles per level of detail, near to far (node extras sbLod of the trees GLB), by crown id. */
function levelTrianglesByCrown(glb: Buffer): Map<number, number[]> {
    const out = new Map<number, number[]>();
    if (glb.length < 20 || glb.toString('utf8', 0, 4) !== 'glTF') return out;
    const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
    const nodes: any[] = json.nodes ?? [];
    for (const node of nodes) {
        const id = node?.extras?.sbTree ? node.extras.crownId : undefined;
        if (typeof id !== 'number') continue;
        const levels = (node.children ?? []).map((i: number) => nodes[i]?.extras?.sbLod).filter(Boolean)
            .sort((a: any, b: any) => a.level - b.level).map((l: any) => l.triangles as number);
        out.set(id, levels);
    }
    return out;
}

/** Copies a GLB into <root>/public/models and returns its /models URL. */
function publishToModels(root: string, glbPath: string, name: string): string {
    const dir = resolveWithinRoot(root, path.join('public', 'models'));
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(glbPath, path.join(dir, name));
    return `/models/${name}`;
}

export const botanicalTreeHandlers: Record<string, ToolHandler> = {
    botanical_synthesize_tree: async (args, ctx) => {
        const list = Array.isArray(args.trees) && args.trees.length > 0 ? args.trees as Args[] : undefined;
        const trees = list ? list.map((t, i) => describedTreeFromArgs(t ?? {}, `trees[${i}]: `)) : [describedTreeFromArgs(args)];
        const budget = positiveNumber(args, 'triangleBudget', false, '');
        const seed = typeof args.seed === 'string' && args.seed ? args.seed : undefined;
        const root = findTileVegetationRepoRoot();
        ctx?.reportProgress?.(`Growing ${trees.length === 1 ? 'the SB-Veggie tree' : `${trees.length} SB-Veggie trees`}`);
        const grown = await getTileVegetationService(root).grow({
            trees, ...(budget !== undefined ? { triangleBudget: budget } : {}), ...(seed ? { seed } : {}),
            ...(trees.length === 1 && trees[0].label ? { label: trees[0].label } : {}), signal: ctx?.signal
        });
        const per: any[] = Array.isArray(grown.stats.perTree) ? grown.stats.perTree : [];
        let outputGlbPath = grown.treesGlb;
        if (typeof args.outputGlbPath === 'string' && args.outputGlbPath.trim()) {
            outputGlbPath = resolveWithinRoot(ctx?.workspaceRoot || root, args.outputGlbPath.trim());
            fs.mkdirSync(path.dirname(outputGlbPath), { recursive: true });
            fs.copyFileSync(grown.treesGlb, outputGlbPath);
        }
        const levels = levelTrianglesByCrown(fs.readFileSync(grown.treesGlb));
        const results = trees.map((t, i) => {
            const s = per.find(p => p.crownId === i) ?? {};
            const [lo, hi] = (s.bounds ?? [[0, 0, 0], [0, 0, 0]]) as number[][];
            const inferred: Record<string, number> = {};
            if (t.crownBaseHeightM === undefined && Number.isFinite(s.crownBaseRatio)) inferred.crownBaseRatio = s.crownBaseRatio;
            if (t.trunkRadiusM === undefined && Number.isFinite(s.trunkRadiusM)) inferred.trunkRadiusM = s.trunkRadiusM;
            return {
                label: t.label,
                position: t.position,
                requested: { heightMeters: t.heightM, crownDiametersMeters: (t.crownRadiiM ?? [0, 0]).map(r => 2 * r) },
                grown: { heightMeters: hi[1] - (t.position?.[1] ?? 0), crownSpreadMeters: Math.max(hi[0] - lo[0], hi[2] - lo[2]), bounds: s.bounds },
                crownSurfaceReached: s.crownSurfaceReached,
                species: s.species ?? null,
                stems: s.stems,
                woodTriangles: s.lod?.woodTriangles,
                farLevelTriangles: s.lod?.farLevelTriangles,
                // drawn triangles per level, near, near-mid, mid, far
                levelTriangles: levels.get(i),
                inferred
            };
        });
        const world = glbWorldBounds(fs.readFileSync(grown.treesGlb));
        let artifact: Record<string, unknown> | undefined;
        if (args.openScene !== false && world) {
            const url = publishToModels(ctx?.workspaceRoot || root, grown.treesGlb, `sb_veggie_trees_${grown.cacheKey.slice(0, 12)}.glb`);
            const c = world.min.map((v, k) => (v + world.max[k]) / 2);
            const size = Math.max(world.max[0] - world.min[0], world.max[1] - world.min[1], world.max[2] - world.min[2]);
            const d = Math.max(6, size * 1.6);
            const title = trees.length === 1 ? (trees[0].label || 'SB-Veggie tree') : `${trees.length} SB-Veggie trees`;
            artifact = {
                id: `artifact-3d-${Date.now()}`, type: '3d-scene', title, summary: 'SB-Veggie trees grown to the described crowns',
                data: {
                    title, subtitle: 'SB-Veggie trees (space colonisation, SB-Veggie leaf clusters, levels of detail)', worldBranch: 'procedural/sb-veggie-trees', sceneType: 'custom',
                    renderMode: 'pbr', cameraMode: 'orbit', animation: 'orbit',
                    camera: { position: [c[0] + d * 0.7, c[1] + d * 0.35, c[2] + d * 0.8], target: [c[0], world.min[1] + (world.max[1] - world.min[1]) * 0.45, c[2]], fov: 50 },
                    environment: { skybox: 'studio', lighting: 'studio', ground: false },
                    objects: [{
                        id: `trees-${grown.cacheKey.slice(0, 12)}`,
                        content: { type: '3d-model', durableUri: url, mimeType: 'model/gltf-binary', metadata: { role: 'hero', description: title, originalPath: grown.treesGlb, metricScale: 1.0, generator: 'SB-Veggie' } },
                        space: { spatial3d: { x: 0, y: 0, z: 0 } }, time: { startMs: 0, durationMs: 20000 }, lineage: { version: 1 }
                    }]
                }
            };
        }
        const one = results[0];
        const summary = results.map(r => `${r.label ? `${r.label}: ` : ''}${r.grown.heightMeters.toFixed(1)} m tall and ${r.grown.crownSpreadMeters.toFixed(1)} m across (asked ${r.requested.heightMeters} m, ${r.requested.crownDiametersMeters.map(v => v.toFixed(1)).join(' x ')} m)${r.species?.label ? `, grown with the proportions of ${r.species.label}` : ''}${Object.keys(r.inferred).length ? `; inferred, not given: ${Object.entries(r.inferred).map(([k, v]) => `${k} ${Number(v).toFixed(3)}`).join(', ')}` : ''}`).join('; ');
        return {
            resultPayload: {
                generator: 'SB-Veggie (space colonisation)',
                provenance: 'generated (grown to described crowns; no scan)',
                outputGlbPath,
                trees: results,
                label: one.label,
                // single-tree fields, as before
                position: one.position,
                requested: trees.length === 1 ? { heightMeters: trees[0].heightM, crownDiameterMeters: one.requested.crownDiametersMeters[0] } : undefined,
                grown: one.grown,
                inferred: one.inferred,
                woodTriangles: one.woodTriangles,
                levelTriangles: one.levelTriangles,
                // the far level's triangles (what every tree holds whole in the file), for one tree; all trees' budgeted triangles otherwise
                triangles: trees.length === 1 ? one.farLevelTriangles ?? grown.stats.triangles : grown.stats.triangles,
                triangleBudget: grown.stats.triangleBudget,
                seed: grown.seed,
                ...(artifact ? { artifact } : {})
            } as unknown as ToolResultPayload,
            summaryResult: `Grew ${trees.length === 1 ? 'one SB-Veggie tree' : `${trees.length} SB-Veggie trees`} (space colonisation, SB-Veggie leaf clusters, four levels of detail; labelled generated): ${summary}. GLB: ${outputGlbPath}.${artifact ? ' Opened as a new 3D scene.' : ''}`
        };
    }
};
