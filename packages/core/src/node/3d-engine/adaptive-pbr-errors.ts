/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Typed failures of the adaptive PBR pipeline. Each one names what was asked, what was found and (where it helps the
 * caller) what would have been valid; none is ever swallowed into a pass-through result.
 */
export class AdaptivePbrError extends Error {
    constructor(message: string, public readonly details: Record<string, unknown> = {}) {
        super(message);
        this.name = new.target.name;
    }
}

/** The input mesh cannot be textured: no input, not a GLB, no triangle geometry, an attribute that cannot be read. */
export class AdaptivePbrInputError extends AdaptivePbrError {}

/** A `partMaterials` entry names parts that do not exist, names nothing, or collides with another entry. */
export class AdaptivePbrPartSelectionError extends AdaptivePbrError {
    /** The parts of the scene as they are listed ("#3 node \"tube\" (mesh \"tube\")"), so the caller can correct the names. */
    constructor(message: string, public readonly availableParts: string[], details: Record<string, unknown> = {}) {
        super(message, { ...details, availableParts });
    }
}

/** A material specification (archetype, descriptor, tile size, resolution) is not usable. */
export class AdaptivePbrMaterialSpecError extends AdaptivePbrError {}

/** The request exceeds a cap on distinct texture sets, per-set resolution or total texels. */
export class AdaptivePbrBudgetError extends AdaptivePbrError {}

/** The native C++20 texture synthesizer did not deliver a texture set. */
export class AdaptivePbrTextureSynthesisError extends AdaptivePbrError {}

/** The result could not be written or exported, or the produced GLB failed its own consistency check. */
export class AdaptivePbrOutputError extends AdaptivePbrError {}

/**
 * The native C++20 PBR kernel could not deliver a texture set. There is no in-process substitute: the failure is the
 * result. `stage` says where it failed; `compilerOutput` carries clang's diagnostics for a compile failure.
 */
export class NativePbrSynthesisError extends AdaptivePbrTextureSynthesisError {
    constructor(message: string, public readonly stage: 'compile' | 'run' | 'output', details: Record<string, unknown> = {}) {
        super(message, { ...details, stage });
    }
}

/** An archetype name or id that is not in the catalog. Lists the valid keys so the caller can pick one or pass a descriptor. */
export class PbrUnknownArchetypeError extends AdaptivePbrMaterialSpecError {
    constructor(public readonly requested: string | number, public readonly validArchetypes: string[], hint = '') {
        super(`Unknown material archetype ${JSON.stringify(requested)}${hint}. Valid archetypes: ${validArchetypes.join(', ')}. Or pass a continuous descriptor (albedoLinear, conduction, roughnessBaseline, ...) instead of an archetype.`, { requested, validArchetypes });
    }
}
