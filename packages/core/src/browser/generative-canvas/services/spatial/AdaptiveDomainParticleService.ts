/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { AdaptiveParticleContract } from '../../../../common/spatial/adaptive-particle-contract';
import { MissingInputError } from '../../../../common/errors/pipeline-errors';

/**
 * The continuous physical values of a particle system as the model chooses them for the substance the user
 * described. Every field is required: nothing is looked up from words in the prompt or filled from a preset.
 */
export type AdaptiveParticleSpec = Omit<AdaptiveParticleContract, 'id' | 'narrativeContext'> & { narrativeContext?: string };

type Check = (value: unknown) => string | undefined;

const finite: Check = v => (typeof v === 'number' && Number.isFinite(v) ? undefined : 'a finite number');
const atLeast = (min: number): Check => v => finite(v) ?? ((v as number) >= min ? undefined : `a number >= ${min}`);
const positive: Check = v => finite(v) ?? ((v as number) > 0 ? undefined : 'a number > 0');
const between = (min: number, max: number): Check => v => finite(v) ?? ((v as number) >= min && (v as number) <= max ? undefined : `a number in [${min}, ${max}]`);
const vector = (n: number, each: Check = finite, eachDescription = 'finite'): Check => v =>
    Array.isArray(v) && v.length === n && v.every(x => !each(x)) ? undefined : `${n} numbers, each ${eachDescription}`;
const text: Check = v => (typeof v === 'string' && v.trim() ? undefined : 'a non-empty string');

const SPEC_CHECKS: Array<[string, Check]> = [
    ['subject', text],
    ['kinematics.linearVelocity', vector(3)],
    ['kinematics.vorticityTensor', finite],
    ['kinematics.radialDivergence', finite],
    ['kinematics.ambientWind', vector(3)],
    ['kinematics.windGustiness', atLeast(0)],
    ['kinematics.gravity', finite],
    ['kinematics.substanceMass', positive],
    ['kinematics.dragCoefficient', atLeast(0)],
    ['kinematics.restitution', between(0, 1)],
    ['kinematics.friction', atLeast(0)],
    ['manifoldWeights', vector(6, atLeast(0), '>= 0')],
    ['manifoldScale', positive],
    ['advectionCurlScale', atLeast(0)],
    ['material.emissionModel', text],
    ['material.coreRadiance', vector(3, atLeast(0), '>= 0')],
    ['material.midRadiance', vector(3, atLeast(0), '>= 0')],
    ['material.outerRadiance', vector(3, atLeast(0), '>= 0')],
    ['material.opticalExtinction', atLeast(0)],
    ['material.specularGloss', between(0, 1)],
    ['material.colorTemperatureK', between(1000, 40000)],
    ['material.particleSizePx', positive],
    ['material.particleCount', atLeast(1)],
    ['optics.bloomMultiplier', atLeast(0)],
    ['optics.diffusionBlurRadius', atLeast(0)],
    ['optics.thermalMirageHaze', atLeast(0)],
    ['optics.chromaticDispersion', atLeast(0)],
    ['acoustics.subBassHertz', atLeast(0)],
    ['acoustics.resonantCenterHertz', atLeast(0)],
    ['acoustics.impulseRate', atLeast(0)]
];

function at(obj: unknown, dotted: string): unknown {
    return dotted.split('.').reduce<any>((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/**
 * Adaptive Domain Particle Service: validates the continuous particle values the model chose and assembles the
 * AdaptiveParticleContract the renderer consumes. It holds no vocabulary of substances (AGENTS.md, ADA Pillar 2:
 * the LLM is the domain engine), so a "bioluminescent methane geyser" is as expressible as "rain".
 */
export class AdaptiveDomainParticleService {
    /**
     * Builds the contract from an explicit spec. Throws MissingInputError naming every missing or out-of-range
     * field. The manifold weights are normalised to sum to 1 (their sum must be positive).
     */
    public static buildContract(spec: AdaptiveParticleSpec): AdaptiveParticleContract {
        const problems = SPEC_CHECKS
            .map(([field, check]) => {
                const issue = check(at(spec, field));
                return issue ? `${field} must be ${issue}` : undefined;
            })
            .filter((p): p is string => !!p);
        const weightSum = Array.isArray(spec?.manifoldWeights) ? spec.manifoldWeights.reduce((a, b) => a + (Number(b) || 0), 0) : 0;
        if (!problems.some(p => p.startsWith('manifoldWeights')) && !(weightSum > 0)) {
            problems.push('manifoldWeights must have a positive sum');
        }
        if (problems.length) {
            throw new MissingInputError('synthesize_adaptive_particle_system', 'explicit particle values', problems.join('; '));
        }
        const weights = spec.manifoldWeights.map(w => w / weightSum) as AdaptiveParticleContract['manifoldWeights'];
        return {
            id: `contract-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            subject: spec.subject.trim(),
            narrativeContext: spec.narrativeContext?.trim() || spec.subject.trim(),
            kinematics: { ...spec.kinematics },
            manifoldWeights: weights,
            manifoldScale: spec.manifoldScale,
            advectionCurlScale: spec.advectionCurlScale,
            material: { ...spec.material, particleCount: Math.round(spec.material.particleCount) },
            optics: { ...spec.optics },
            acoustics: { ...spec.acoustics }
        };
    }
}
