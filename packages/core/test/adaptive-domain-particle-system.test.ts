/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
    AdaptiveParticleContract,
    DEFAULT_ADAPTIVE_PARTICLE_CONTRACT,
    interpolateAdaptiveParticleContracts
} from '../src/common/spatial/adaptive-particle-contract';
import {
    AdaptiveDomainParticleService,
    type AdaptiveParticleSpec
} from '../src/browser/generative-canvas/services/spatial/AdaptiveDomainParticleService';
import { MissingInputError } from '../src/common/errors/pipeline-errors';

/** A complete spec as the model would supply it (values chosen for the test, not by any code under test). */
function specFor(subject: string, kinematics: Partial<AdaptiveParticleContract['kinematics']>): AdaptiveParticleSpec {
    return {
        subject,
        kinematics: {
            linearVelocity: [0.2, 3.1, -0.4], vorticityTensor: 0.7, radialDivergence: 1.3, ambientWind: [1.1, 0, 0.3],
            windGustiness: 0.4, gravity: -2.5, substanceMass: 0.5, dragCoefficient: 1.1, restitution: 0.25, friction: 0.6,
            ...kinematics
        },
        manifoldWeights: [2, 0.5, 1, 0, 0, 0.5],
        manifoldScale: 1.2,
        advectionCurlScale: 0.5,
        material: {
            emissionModel: 'chemiluminescent spray', coreRadiance: [0.8, 1, 0.9], midRadiance: [0.2, 0.8, 0.6], outerRadiance: [0.05, 0.2, 0.15],
            opticalExtinction: 1.4, specularGloss: 0.5, colorTemperatureK: 9000, particleSizePx: 1.2, particleCount: 4000
        },
        optics: { bloomMultiplier: 1.4, diffusionBlurRadius: 1, thermalMirageHaze: 0.1, chromaticDispersion: 0.02 },
        acoustics: { subBassHertz: 40, resonantCenterHertz: 300, impulseRate: 12 }
    };
}

describe('Adaptive Domain Particle System Suite (Zero-Preset & Schema-Guided)', () => {

    it('validates the continuous physical contract schema structure without closed taxonomies', () => {
        const contract: AdaptiveParticleContract = DEFAULT_ADAPTIVE_PARTICLE_CONTRACT;

        expect(contract.subject).toBeDefined();
        expect(contract.kinematics.gravity).toBeDefined();
        expect(contract.kinematics.substanceMass).toBeGreaterThan(0.0);
        expect(contract.kinematics.dragCoefficient).toBeGreaterThan(0.0);
        expect(contract.kinematics.restitution).toBeGreaterThanOrEqual(0.0);
        expect(contract.kinematics.restitution).toBeLessThanOrEqual(1.0);

        // Continuous manifold PDE weights must sum to approximately 1.0
        const manifoldSum = contract.manifoldWeights.reduce((a, b) => a + b, 0);
        expect(manifoldSum).toBeCloseTo(1.0, 2);

        // Material & Radiometry
        expect(contract.material.coreRadiance.length).toBe(3);
        expect(contract.material.opticalExtinction).toBeGreaterThan(0.0);
        expect(contract.material.emissionModel).toMatch(/incandescent|diffuse|transmissive|luminescent/);
    });

    it('assembles the contract from the values the model chose, for a substance no code knows about', () => {
        const spec = specFor('bioluminescent methane geyser spray inside a hollow asteroid', { gravity: -0.4, substanceMass: 0.9 });
        const contract = AdaptiveDomainParticleService.buildContract(spec);
        expect(contract.subject).toBe('bioluminescent methane geyser spray inside a hollow asteroid');
        expect(contract.kinematics.gravity).toBe(-0.4);
        expect(contract.kinematics.substanceMass).toBe(0.9);
        expect(contract.material.emissionModel).toBe(spec.material.emissionModel);
        expect(contract.material.coreRadiance).toEqual(spec.material.coreRadiance);
        expect(contract.acoustics).toEqual(spec.acoustics);
        // Weights are normalised; their proportions are the model's.
        expect(contract.manifoldWeights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
        expect(contract.manifoldWeights[2] / contract.manifoldWeights[0]).toBeCloseTo(spec.manifoldWeights[2] / spec.manifoldWeights[0], 9);
    });

    it('the same words give no values: there is no prompt parser to fall back to', () => {
        expect((AdaptiveDomainParticleService as any).synthesizeFromPrompt).toBeUndefined();
        expect(() => AdaptiveDomainParticleService.buildContract({ subject: 'desert sandstorm' } as any)).toThrow(MissingInputError);
    });

    it('names every missing or out-of-range field instead of filling it in', () => {
        const spec = specFor('rain', {}) as any;
        delete spec.kinematics.gravity;
        spec.kinematics.restitution = 1.7;
        spec.material.colorTemperatureK = 200;
        spec.manifoldWeights = [0, 0, 0, 0, 0, 0];
        let message = '';
        try { AdaptiveDomainParticleService.buildContract(spec); } catch (e: any) { message = e.message; }
        expect(message).toContain('kinematics.gravity must be a finite number');
        expect(message).toContain('kinematics.restitution must be a number in [0, 1]');
        expect(message).toContain('material.colorTemperatureK must be a number in [1000, 40000]');
        expect(message).toContain('manifoldWeights must have a positive sum');
    });

    it('smoothly interpolates between two completely disparate contracts without algebraic discontinuities', () => {
        const c1 = AdaptiveDomainParticleService.buildContract(specFor('desert sandstorm', { substanceMass: 0.08 }));
        const c2 = AdaptiveDomainParticleService.buildContract(specFor('bioluminescent sea plankton', { substanceMass: 0.95 }));

        const mid = interpolateAdaptiveParticleContracts(c1, c2, 0.5);

        expect(mid.kinematics.substanceMass).toBeCloseTo(
            (c1.kinematics.substanceMass + c2.kinematics.substanceMass) * 0.5,
            3
        );
        expect(mid.material.midRadiance[0]).toBeCloseTo(
            (c1.material.midRadiance[0] + c2.material.midRadiance[0]) * 0.5,
            3
        );
        expect(mid.manifoldWeights[0]).toBeCloseTo(
            (c1.manifoldWeights[0] + c2.manifoldWeights[0]) * 0.5,
            3
        );
    });

    it('verifies integration into the interactive demo with adaptive uniforms and zero-preset bindings', () => {
        const demoPath = path.resolve(process.cwd(), 'public/demos/fire-explosion.html');
        expect(fs.existsSync(demoPath)).toBe(true);

        const content = fs.readFileSync(demoPath, 'utf8');

        // Check Adaptive Domain Protocol Integration
        expect(content).toMatch(/AdaptiveDomainParticleService|AdaptiveParticleContract|uAdaptiveManifolds/i);
        expect(content).toContain('uKinematicGravity');
        expect(content).toContain('uEmissionModel');
    });

    it('verifies Gemini Agent spatial tool declaration and execution handler', async () => {
        const { SPATIAL_TOOL_DECLARATIONS, spatialHandlers } = await import('../src/node/gemini/tools/spatial-tools');

        const decl = SPATIAL_TOOL_DECLARATIONS.find(t => t.name === 'synthesize_adaptive_particle_system');
        expect(decl).toBeDefined();
        expect(decl?.description).toContain('AdaptiveParticleContract');
        expect(decl?.parameters.required).toEqual(expect.arrayContaining(['subject', 'kinematics', 'material', 'manifoldWeights']));
        expect((decl?.parameters.properties as any).prompt).toBeUndefined();

        const handler = spatialHandlers['synthesize_adaptive_particle_system'];
        expect(handler).toBeDefined();

        const res = await handler(specFor('ferrofluid magnetic spikes in mineral oil', { gravity: -9.8 }) as any, {} as any);
        expect((res.resultPayload as any).subject).toBe('ferrofluid magnetic spikes in mineral oil');
        expect((res.resultPayload as any).kinematics.gravity).toBe(-9.8);
        await expect(handler({ prompt: 'ferrofluid magnetic spikes in mineral oil' }, {} as any)).rejects.toThrow(MissingInputError);
    });
});
