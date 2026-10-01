/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Botanical Tree Gemini / Antigravity Agent Tools
 * Exposes the SB-Veggie (formerly SMPL-Tree) Botanical Synthesis & Inversion Engine
 * as high-level agent tools that ingest entities from the 3D Tile Spatial Separator,
 * adjust dynamically to any tree species, and output 1:1 metric watertight GLBs.
 ********************************************************************************/

import type { ToolDeclaration, ToolHandler } from './types';
import {
    UniversalBotanicalBridgeService,
    SPECIES_ADAPTERS,
    type SpatialTreeEntity,
    type SupportedTreeSpecies
} from '../../spatial/UniversalBotanicalBridgeService';
import {
    ColosseumTreeIdentificationEngine,
    type BotanicalZone,
    type BotanicalSpecies
} from '../../spatial/ColosseumTreeIdentificationEngine';

export const BOTANICAL_TREE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'botanical_synthesize_tree',
        description: 'Synthesizes a 1:1 metric, watertight, biologically accurate 3D tree asset (.glb) using the native C++20 SB-Veggie botanical engine. Ingests tree data from the 3D tile Spatial Separator (e.g. from GET /api/spatial/3d-mesh/objects?mode=trees or /api/spatial/trees), automatically adapts species archetypes (Parasol Stone Pine, Columnar Cypress, Decurrent Holm Oak, Gnarled Olive, Laurel, Birch, Maple, etc.), solves Da Vinci branch taper & 16-mode morphological shape basis, and fits the exact oriented bounding box in real-world metric ENU coordinates.',
        parameters: {
            type: 'OBJECT',
            properties: {
                treeId: {
                    type: 'STRING',
                    description: 'Unique identifier for the tree (e.g., "fol-tree-oppian-crest-001" or "tree-central-park-042").'
                },
                species: {
                    type: 'STRING',
                    description: 'Botanical species or common tree type (e.g., "pinus_pinea", "quercus_ilex", "cupressus_sempervirens", "olea_europaea", "laurus_nobilis", "oak", "pine", "cypress", "olive", "birch").'
                },
                name: {
                    type: 'STRING',
                    description: 'Optional human-readable name or descriptive label for the tree.'
                },
                canopyHeightMeters: {
                    type: 'NUMBER',
                    description: 'Total vertical height of the tree in meters (from ground datum to apex).'
                },
                crownDiameterMeters: {
                    type: 'NUMBER',
                    description: 'Diameter of the foliage crown spread in meters.'
                },
                boundingBox: {
                    type: 'OBJECT',
                    description: 'Axis-aligned 3D bounding box { min: [x,y,z], max: [x,y,z], dimensions: [w,h,d], centroid: [cx,cy,cz] } in metric ENU space.'
                },
                orientedBoundingBox: {
                    type: 'OBJECT',
                    description: 'Oriented 3D bounding box { center: [x,y,z], dimensions: [w,h,d], halfExtents: [hx,hy,hz], yawRad: number }.'
                },
                season: {
                    type: 'NUMBER',
                    description: 'Phenological season: 1.0 = Summer lush green, 0.45 = Autumn golden amber, 0.0 = Winter bare wood manifold.'
                },
                leafDensity: {
                    type: 'NUMBER',
                    description: 'Foliage density multiplier (default 1.0, 0.0 for bare winter manifold).'
                },
                saturationScale: {
                    type: 'NUMBER',
                    description: 'Foliage color saturation scaling (default 0.78 for authentic photorealistic tile harmony).'
                },
                outputGlbPath: {
                    type: 'STRING',
                    description: 'Optional destination file path for the resulting binary glTF 2.0 (.glb) asset.'
                },
                rawScanGlbPath: {
                    type: 'STRING',
                    description: 'Optional path to raw photogrammetry 3D tile submesh blob to run SMPLify-Tree scan inversion.'
                }
            },
            required: []
        }
    },
    {
        name: 'botanical_query_separator_trees',
        description: 'Queries identified 3D tree entities from the Spatial Separator service across any geographic zone, returning bounding boxes, botanical species classifications, and metric dimensions.',
        parameters: {
            type: 'OBJECT',
            properties: {
                zone: {
                    type: 'STRING',
                    description: 'Geographic zone name (e.g. "oppian_hill_crest", "colle_oppio_slopes", "palatine_hill_slopes", "via_san_gregorio", etc.).'
                },
                species: {
                    type: 'STRING',
                    description: 'Filter by species: "pinus_pinea", "quercus_ilex", "cupressus_sempervirens", "olea_europaea", or "laurus_nobilis".'
                },
                minHeight: {
                    type: 'NUMBER',
                    description: 'Minimum canopy height in meters.'
                },
                maxHeight: {
                    type: 'NUMBER',
                    description: 'Maximum canopy height in meters.'
                },
                limit: {
                    type: 'NUMBER',
                    description: 'Maximum number of trees to return (default 20).'
                }
            },
            required: []
        }
    }
];

export const botanicalTreeHandlers: Record<string, ToolHandler> = {
    botanical_synthesize_tree: async (args: Record<string, any>) => {
        const bridge = new UniversalBotanicalBridgeService();

        // Check if treeId corresponds to a known tree in the Colosseum dataset if no dimensions provided
        let entity: SpatialTreeEntity = {
            id: args.treeId || `tree_${Date.now()}`,
            name: args.name,
            species: args.species,
            canopyHeightMeters: args.canopyHeightMeters,
            crownDiameterMeters: args.crownDiameterMeters,
            boundingBox: args.boundingBox,
            orientedBoundingBox: args.orientedBoundingBox,
            rawScanGlbPath: args.rawScanGlbPath
        };

        if (args.treeId && (!args.canopyHeightMeters || !args.crownDiameterMeters)) {
            const allTrees = ColosseumTreeIdentificationEngine.getIdentifiedTrees();
            const matched = allTrees.find(t => t.id === args.treeId);
            if (matched) {
                entity = {
                    name: matched.name,
                    species: matched.species,
                    nominalDimensions: matched.nominalDimensions,
                    nominalCentroid: matched.nominalCentroid,
                    canopyHeightMeters: matched.canopyHeightMeters,
                    crownDiameterMeters: matched.crownDiameterMeters,
                    trellisPrompt: matched.trellisPrompt,
                    ...entity,
                    id: matched.id
                };
            }
        }

        const result = await bridge.synthesizeTreeFromEntity(entity, {
            season: args.season !== undefined ? Number(args.season) : 1.0,
            leafDensity: args.leafDensity !== undefined ? Number(args.leafDensity) : undefined,
            saturationScale: args.saturationScale !== undefined ? Number(args.saturationScale) : 0.78,
            outputGlbPath: args.outputGlbPath,
            runInversionIfScanAvailable: !!args.rawScanGlbPath
        });

        return {
            resultPayload: {
                success: true,
                treeId: result.treeId,
                species: result.species,
                archetype: result.archetype,
                worldPosition: result.worldPosition,
                worldRotationYawRad: result.worldRotationYawRad,
                fittedHeightMeters: result.fittedHeightMeters,
                fittedSpreadMeters: result.fittedSpreadMeters,
                outputGlbPath: result.outputGlbPath,
                telemetry: result.telemetry,
                appliedBeta: result.appliedBeta
            }
        };
    },

    botanical_query_separator_trees: async (args: Record<string, any>) => {
        const trees = ColosseumTreeIdentificationEngine.filterTrees({
            zone: args.zone as BotanicalZone,
            species: args.species as BotanicalSpecies,
            minHeight: args.minHeight ? Number(args.minHeight) : undefined,
            maxHeight: args.maxHeight ? Number(args.maxHeight) : undefined
        });

        const limit = args.limit ? Number(args.limit) : 20;
        const sliced = trees.slice(0, limit);

        return {
            resultPayload: {
                success: true,
                totalFound: trees.length,
                returnedCount: sliced.length,
                trees: sliced.map(t => ({
                    id: t.id,
                    name: t.name,
                    species: t.species,
                    commonName: t.commonName,
                    zone: t.zone,
                    canopyHeightMeters: t.canopyHeightMeters,
                    crownDiameterMeters: t.crownDiameterMeters,
                    centroid: t.nominalCentroid,
                    dimensions: t.nominalDimensions
                }))
            }
        };
    }
};
