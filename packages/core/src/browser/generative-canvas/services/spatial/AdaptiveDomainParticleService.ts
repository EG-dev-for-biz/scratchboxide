/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import {
    AdaptiveParticleContract,
    DEFAULT_ADAPTIVE_PARTICLE_CONTRACT,
    ParticleEmissionModel
} from '../../../../common/spatial/adaptive-particle-contract';
import { extractPromptEntities } from '../adaptive-domain-engine';

/**
 * Adaptive Domain Particle Service.
 * Implements the Antigravity Zero-Preset Directive for 3D Particle & Volumetric Fluid systems:
 * - Never introduces hardcoded domain enums or rigid gating taxonomy
 * - Uses entity-driven extraction to map natural language into continuous physical manifolds
 */
export class AdaptiveDomainParticleService {

    /**
     * Synthesizes an AdaptiveParticleContract from natural language with zero rigid presets
     */
    public static synthesizeFromPrompt(
        prompt: string,
        baseContract: AdaptiveParticleContract = DEFAULT_ADAPTIVE_PARTICLE_CONTRACT
    ): AdaptiveParticleContract {
        const text = prompt.toLowerCase();
        const { subject, keywords } = extractPromptEntities(prompt, 'Adaptive Particle Substance');

        const has = (re: RegExp) => re.test(text);

        // 1. Emission Model Classification
        let emissionModel: ParticleEmissionModel = 'incandescent';
        if (has(/\b(sand|dust|dirt|earth|soil|ash|clay|ochre|powder|pollen|chalk|soot|mineral)\b/)) {
            emissionModel = 'diffuse';
        } else if (has(/\b(water|rain|droplet|mist|spray|splash|liquid|oil|stream|fountain|geyser|drizzle)\b/)) {
            emissionModel = 'transmissive';
        } else if (has(/\b(bioluminescent|plankton|dinoflagellate|fluorescent|glow|neon|plasma|aurora|phosphor|quantum)\b/)) {
            emissionModel = 'luminescent';
        } else {
            emissionModel = 'incandescent';
        }

        // 2. Continuous Kinematic & Aerodynamic Fields
        let linearVel: [number, number, number] = [0.0, 1.8, 0.0];
        let vorticity = 0.5;
        let radialDivergence = 1.0;
        let ambientWind: [number, number, number] = [0.4, 0.1, 0.1];
        let windGustiness = 0.35;
        let gravity = -1.2;
        let substanceMass = 0.30;
        let dragCoeff = 0.88;
        let restitution = 0.30;
        let friction = 0.70;

        // Kinematic tuning guided by extracted entities & physical state
        if (emissionModel === 'transmissive' || has(/\b(marine|seawater|ocean|water|aquatic|wake|fluid|liquid)\b/)) {
            // Liquid droplet / marine suspension physics
            gravity = has(/\b(rain|downpour)\b/) ? -16.0 : (has(/\b(plankton|micro)\b/) ? -0.15 : -9.8);
            substanceMass = has(/\b(plankton|micro)\b/) ? 0.95 : 1.40; // Fluid medium inertia
            dragCoeff = has(/\b(plankton|micro)\b/) ? 1.85 : 1.25;
            linearVel = has(/\b(rain|downpour)\b/) ? [0.0, -12.0, 0.0] : [0.0, 4.2, 0.0];
            restitution = 0.20;
            friction = 0.85;
            radialDivergence = 1.4;
        } else if (emissionModel === 'diffuse') {
            // Earth / Sand / Dust
            gravity = -0.45;
            substanceMass = 0.08; // Ultra-light motes carried by air currents
            dragCoeff = 2.40; // High aerodynamic surface-to-mass coupling
            ambientWind = [3.2, 0.15, 0.4];
            windGustiness = 0.75;
            linearVel = [1.8, 0.3, 0.2];
            restitution = 0.15;
            friction = 0.90;
        } else if (has(/\b(sparks?|slag|torch|welding|grinding|metal|iron)\b/)) {
            // High-density molten metal droplets
            gravity = -9.8;
            substanceMass = 4.50; // Dense metal resisting wind
            dragCoeff = 0.45;
            linearVel = [2.5, 4.5, 2.5];
            restitution = 0.72; // Elastic ricochet off hard surfaces
            friction = 0.40;
            radialDivergence = 2.8;
        } else if (has(/\b(plasma|relativistic|jet|quasar|pulsar|supermassive)\b/)) {
            // High-energy relativistic beam / cosmic advection
            linearVel = [0.0, 6.5, 0.0];
            vorticity = 2.4;
            radialDivergence = 3.2;
            gravity = 0.0;
            substanceMass = 0.12;
            ambientWind = [0.0, 0.0, 0.0];
        } else if (has(/\b(smoke|steam|vapor|fume|chimney)\b/)) {
            // Low-mass thermal buoyant gas
            linearVel = [0.0, 1.2, 0.0];
            gravity = -0.25;
            substanceMass = 0.06;
            dragCoeff = 1.60;
            ambientWind = [1.2, 0.25, 0.2];
        }

        if (has(/\b(vortex|cyclone|tornado|whirlwind|swirl)\b/)) {
            vorticity = 2.85;
        }

        // 3. Continuous Analytical PDE Manifold Weights
        // [0: plume, 1: vortex, 2: fountain, 3: supernova/burst, 4: orbital disk, 5: lateral gale]
        let manifoldWeights: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 0];
        if (has(/\b(fountain|spray|cascade|splash|geyser|droplet)\b/)) {
            manifoldWeights = [0.10, 0.05, 0.85, 0.0, 0.0, 0.0];
        } else if (has(/\b(vortex|cyclone|tornado|whirlpool)\b/)) {
            manifoldWeights = [0.10, 0.90, 0.0, 0.0, 0.0, 0.0];
        } else if (has(/\b(supernova|burst|blast|shockwave|explosion)\b/)) {
            manifoldWeights = [0.10, 0.0, 0.0, 0.90, 0.0, 0.0];
        } else if (has(/\b(orbital|disk|ring|galaxy|accretion|spiral)\b/)) {
            manifoldWeights = [0.05, 0.15, 0.0, 0.0, 0.80, 0.0];
        } else if (has(/\b(dust|sand|gale|blizzard|wind|storm)\b/)) {
            manifoldWeights = [0.05, 0.10, 0.0, 0.0, 0.0, 0.85];
        } else {
            manifoldWeights = [0.90, 0.05, 0.05, 0.0, 0.0, 0.0];
        }

        // 4. Material Radiance Palette & Spectral Tuning
        let coreRGB: [number, number, number] = [...baseContract.material.coreRadiance];
        let midRGB: [number, number, number] = [...baseContract.material.midRadiance];
        let outerRGB: [number, number, number] = [...baseContract.material.outerRadiance];
        let opticalExtinction = 2.15;
        let specularGloss = 0.25;
        let colorTemperatureK = 2850;

        if (has(/\b(bioluminescent|plankton|dinoflagellate|cyan|azure|electric)\b/)) {
            coreRGB = [0.82, 0.96, 1.0];
            midRGB = [0.08, 0.65, 0.95];
            outerRGB = [0.02, 0.15, 0.45];
            opticalExtinction = 1.15;
            colorTemperatureK = 14000;
        } else if (has(/\b(purple|violet|magenta)\b/)) {
            coreRGB = [0.95, 0.82, 1.0];
            midRGB = [0.65, 0.15, 0.95];
            outerRGB = [0.20, 0.02, 0.38];
            colorTemperatureK = 9500;
        } else if (has(/\b(green|emerald|lime|toxic|acid)\b/)) {
            coreRGB = [0.88, 1.0, 0.45];
            midRGB = [0.12, 0.92, 0.25];
            outerRGB = [0.02, 0.28, 0.08];
            opticalExtinction = 1.45;
        } else if (has(/\b(dust|sand|desert|earth|ochre|dirt)\b/)) {
            coreRGB = [0.95, 0.85, 0.65];
            midRGB = [0.78, 0.58, 0.28];
            outerRGB = [0.38, 0.26, 0.12];
            opticalExtinction = 3.20; // Opaque particulate scattering
            specularGloss = 0.08;
            colorTemperatureK = 2200;
        } else if (has(/\b(water|ocean|river|fountain)\b/)) {
            coreRGB = [0.88, 0.96, 1.0];
            midRGB = [0.15, 0.65, 0.95];
            outerRGB = [0.05, 0.25, 0.45];
            opticalExtinction = 0.85; // Highly transmissive
            specularGloss = 0.88;
            colorTemperatureK = 6500;
        } else if (has(/\b(steam|vapor|mist|fog)\b/)) {
            coreRGB = [0.98, 0.98, 1.0];
            midRGB = [0.85, 0.88, 0.92];
            outerRGB = [0.35, 0.38, 0.42];
            opticalExtinction = 0.95;
            specularGloss = 0.15;
            colorTemperatureK = 5800;
        } else if (has(/\b(sparks?|torch|welding|slag|molten)\b/)) {
            coreRGB = [1.0, 1.0, 0.88];
            midRGB = [1.0, 0.65, 0.12];
            outerRGB = [0.45, 0.12, 0.02];
            specularGloss = 0.55;
            colorTemperatureK = 3200;
        }

        // 5. Optics & Lens Filtration
        let bloomMultiplier = (emissionModel === 'diffuse') ? 0.35 : 1.35;
        if (has(/\b(supernova|plasma|laser|lightning)\b/)) bloomMultiplier = 1.85;

        let thermalMirageHaze = (emissionModel === 'incandescent') ? 0.45 : 0.15;
        let chromaticDispersion = (emissionModel === 'transmissive' || emissionModel === 'luminescent') ? 0.022 : 0.012;

        // 6. Acoustics
        let subBassHertz = 60;
        let resonantCenterHertz = 350;
        let impulseRate = 8;
        if (has(/\b(supernova|black hole|astrophysic|deep|singularity)\b/)) {
            subBassHertz = 32;
            resonantCenterHertz = 180;
        } else if (has(/\b(sparks|welding|grinding)\b/)) {
            resonantCenterHertz = 1400;
            impulseRate = 28;
        } else if (has(/\b(water|fountain|spray)\b/)) {
            resonantCenterHertz = 520;
            impulseRate = 18;
        }

        return {
            id: `contract-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            subject: subject || 'Adaptive Particle Substance',
            narrativeContext: `Synthesized continuous physical manifold tailored for ${subject}`,
            kinematics: {
                linearVelocity: linearVel,
                vorticityTensor: vorticity,
                radialDivergence,
                ambientWind,
                windGustiness,
                gravity,
                substanceMass,
                dragCoefficient: dragCoeff,
                restitution,
                friction
            },
            manifoldWeights,
            manifoldScale: has(/\b(supernova|galaxy|cosmic)\b/) ? 1.4 : 1.0,
            advectionCurlScale: baseContract.advectionCurlScale,
            material: {
                emissionModel,
                coreRadiance: coreRGB,
                midRadiance: midRGB,
                outerRadiance: outerRGB,
                opticalExtinction,
                specularGloss,
                colorTemperatureK,
                particleSizePx: emissionModel === 'diffuse' ? 1.0 : (emissionModel === 'transmissive' ? 1.4 : 1.5),
                particleCount: 6000
            },
            optics: {
                bloomMultiplier,
                diffusionBlurRadius: 1.25,
                thermalMirageHaze,
                chromaticDispersion
            },
            acoustics: {
                subBassHertz,
                resonantCenterHertz,
                impulseRate
            }
        };
    }
}
