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
    AdaptiveDomainParticleService
} from '../src/browser/generative-canvas/services/spatial/AdaptiveDomainParticleService';

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

    it('synthesizes an adaptive particle contract for an arbitrary biomedical prompt via entity extraction', () => {
        // High-specificity domain prompt: zero presets exist for this in the codebase
        const prompt = 'Bioluminescent dinoflagellate marine plankton swirling in nocturnal seawater wake';
        const contract = AdaptiveDomainParticleService.synthesizeFromPrompt(prompt);

        expect(contract.subject.toLowerCase()).toContain('plankton');
        expect(contract.material.emissionModel).toBe('luminescent');
        // Cyan / electric blue ocean bioluminescence
        expect(contract.material.midRadiance[2]).toBeGreaterThan(contract.material.midRadiance[0]); // Blue > Red
        // Water viscosity and slight buoyancy for floating plankton
        expect(contract.kinematics.substanceMass).toBeGreaterThan(0.5); // Liquid medium
        expect(contract.kinematics.dragCoefficient).toBeGreaterThan(1.0); // Fluid drag
    });

    it('synthesizes an adaptive particle contract for an extreme astrophysics prompt', () => {
        const prompt = 'Relativistic astrophysical plasma jet erupting from supermassive black hole accretion disk';
        const contract = AdaptiveDomainParticleService.synthesizeFromPrompt(prompt);

        expect(contract.subject.toLowerCase()).toContain('plasma');
        expect(contract.kinematics.linearVelocity[1]).toBeGreaterThan(3.0); // Relativistic upward jet
        expect(contract.kinematics.vorticityTensor).toBeGreaterThan(1.5); // High accretion spin
        expect(contract.optics.bloomMultiplier).toBeGreaterThan(1.3); // High energy emission
        expect(contract.acoustics.subBassHertz).toBeLessThan(45); // Infrasonic rumble
    });

    it('synthesizes an adaptive particle contract for a practical metallurgy prompt', () => {
        const prompt = 'Oxy-acetylene cutting torch slag and incandescent molten steel sparks bouncing on floor';
        const contract = AdaptiveDomainParticleService.synthesizeFromPrompt(prompt);

        expect(contract.subject.toLowerCase()).toContain('torch');
        expect(contract.material.emissionModel).toBe('incandescent');
        expect(contract.kinematics.restitution).toBeGreaterThan(0.5); // Elastic bounce of molten droplets
        expect(contract.kinematics.substanceMass).toBeGreaterThan(2.5); // Dense metal
        expect(contract.kinematics.gravity).toBeLessThan(-8.0); // Earth gravity
    });

    it('synthesizes an adaptive particle contract for a geological desert prompt', () => {
        const prompt = 'Bagnold saltating desert sand and airborne mineral dust motes carried by arid wind';
        const contract = AdaptiveDomainParticleService.synthesizeFromPrompt(prompt);

        expect(contract.subject.toLowerCase()).toContain('sand');
        expect(contract.material.emissionModel).toBe('diffuse'); // Diffuse non-glowing mineral motes
        expect(contract.material.specularGloss).toBeLessThan(0.3); // Dry earth
        expect(contract.kinematics.substanceMass).toBeLessThan(0.15); // Ultra-light wind-carried motes
        expect(Math.hypot(contract.kinematics.ambientWind[0], contract.kinematics.ambientWind[2])).toBeGreaterThan(1.5);
    });

    it('smoothly interpolates between two completely disparate contracts without algebraic discontinuities', () => {
        const c1 = AdaptiveDomainParticleService.synthesizeFromPrompt('desert sandstorm');
        const c2 = AdaptiveDomainParticleService.synthesizeFromPrompt('bioluminescent sea plankton');

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

        const handler = spatialHandlers['synthesize_adaptive_particle_system'];
        expect(handler).toBeDefined();

        const res = await handler({ prompt: 'ferrofluid magnetic spikes in mineral oil' }, {} as any);
        expect(res.resultPayload).toBeDefined();
        expect((res.resultPayload as any).subject.toLowerCase()).toContain('ferrofluid');
        expect((res.resultPayload as any).kinematics.gravity).toBeDefined();
    });
});
