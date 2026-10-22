/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * SB-Veggie is the one vegetation generator of every 3D path (user decision, 2026-10-22): staged places regrow their
 * measured crowns with it, imagined scenes grow sb.create_tree descriptions with it (scratchbox_sb_veggie_grove.hpp),
 * and botanical_synthesize_tree grows requested trees with it. The engine still holds older tree generators (an
 * L-system, a bare space-colonisation mesher, named plant presets, a botanical pipeline) for its own internals and
 * tests; they are not reachable from code a model or user writes.
 *
 * This module is the check on such code: it names the engine API symbols (identifiers, not words of any request) that
 * grow trees outside SB-Veggie, and finds them in a C++ generator's source or a viewport script. A source that uses one
 * is refused before it is compiled or run, with the route to SB-Veggie in the message.
 */

/** C++ engine symbols that grow trees, branches or foliage outside SB-Veggie's grove. */
export const RETIRED_CPP_VEGETATION_SYMBOLS: readonly string[] = [
    // scratchbox_nature.hpp: the L-system and the bare space-colonisation mesher
    'LSystemTreeParams',
    'generateProceduralTree',
    'buildLSystemNode',
    'SpaceColonizationTreeGenerator',
    'SpaceColonizationConfig',
    'DetailedLeafGenerator',
    'TwigClusterGenerator',
    'appendDetailedFoliageCards',
    'appendLeafCluster',
    // scratchbox_plant_builder.hpp: named plant presets
    'ProceduralPlantBuilder',
    'PlantPresets',
    'scratchbox_plant_builder.hpp',
    // scratchbox_botanical_pipeline.hpp
    'BotanicalSynthesisPipeline',
    'BotanicalPbrTextureSynthesizer',
    'scratchbox_botanical_pipeline.hpp',
    // SB-Veggie's own internals, used without the grove (no species, textures or levels of detail)
    'SbVeggieFoliage',
    'SbVeggieModelBuilder'
];

/** Viewport-script (customScript) helpers that build trees from Three.js primitives. */
export const RETIRED_SCRIPT_VEGETATION_SYMBOLS: readonly string[] = [
    'generateProceduralThreeMeshFromPrompt'
];

/** Where vegetation comes from instead, for the refusal message. */
export const SB_VEGGIE_ROUTE =
    'Every tree, shrub or plant crown in a scene is an SB-Veggie tree: in a script, sb.create_tree(position=, height=, crown_radius=, ...) ' +
    'added to the scene (execute_3d_python_script); on its own, the botanical_synthesize_tree tool; at a real place, google_3d_tiles_get_clay ' +
    'regrows the measured trees.';

function stripCppComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function stripJsComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function findSymbols(source: string, symbols: readonly string[]): string[] {
    const found: string[] = [];
    for (const sym of symbols) {
        const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = /\.hpp$/.test(sym) ? new RegExp(escaped) : new RegExp(`\\b${escaped}\\b`);
        if (pattern.test(source)) found.push(sym);
    }
    return found;
}

/** The retired tree generators a C++ generator's source uses (comments ignored); empty when it uses none. */
export function cppVegetationViolations(source: string): string[] {
    if (typeof source !== 'string' || !source) return [];
    return findSymbols(stripCppComments(source), RETIRED_CPP_VEGETATION_SYMBOLS);
}

/** The retired tree helpers a viewport script uses (comments ignored); empty when it uses none. */
export function scriptVegetationViolations(source: string): string[] {
    if (typeof source !== 'string' || !source) return [];
    return findSymbols(stripJsComments(source), RETIRED_SCRIPT_VEGETATION_SYMBOLS);
}

/** The refusal for a source that uses retired tree generators. */
export function vegetationViolationMessage(kind: 'C++ generator' | 'viewport script', symbols: string[]): string {
    return `This ${kind} grows vegetation outside SB-Veggie (${symbols.join(', ')}), so it was not ${kind === 'C++ generator' ? 'compiled' : 'run'}. ${SB_VEGGIE_ROUTE}`;
}

export class VegetationGeneratorRefusedError extends Error {
    readonly code = 'vegetation_outside_sb_veggie';
    constructor(readonly kind: 'C++ generator' | 'viewport script', readonly symbols: string[]) {
        super(vegetationViolationMessage(kind, symbols));
        this.name = 'VegetationGeneratorRefusedError';
    }
}
