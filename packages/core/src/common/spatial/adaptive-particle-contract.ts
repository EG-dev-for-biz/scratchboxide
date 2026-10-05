/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Emission & Light Interaction Model for Particulate Matter
 */
export type ParticleEmissionModel =
    | 'incandescent'   // Blackbody thermal radiation (fire, embers, molten sparks)
    | 'diffuse'        // Lambertian mineral/dust scattering (sand, soil, dry ash, pollen)
    | 'transmissive'   // Specular liquid refraction (water, oil, clear chemical droplets)
    | 'luminescent'    // Quantum/chemical light emission (bioluminescence, plasma, neon)
    | (string & {});

/**
 * Universal Adaptive Particle Contract.
 * In strict alignment with Scratchbox IDE Adaptive Domain Architecture:
 * - Zero closed classification enums or taxonomies
 * - Purely parameterized across continuous physical vector fields, thermodynamic tensors,
 *   analytical PDE manifolds, and material optical properties.
 */
export interface AdaptiveParticleContract {
    id: string;
    subject: string;
    narrativeContext: string;

    // Kinematic Vector Fields & Classical Aerodynamics
    kinematics: {
        linearVelocity: [number, number, number];  // Primary ejection / bulk advection vector (m/s)
        vorticityTensor: number;                   // Angular rotation shear scale (rad/s)
        radialDivergence: number;                  // Outward expansion divergence (+ explosive, - sink)
        ambientWind: [number, number, number];     // 3D environmental wind vector [Wx, Wy, Wz] (m/s)
        windGustiness: number;                     // Aerodynamic turbulence / eddy amplitude
        gravity: number;                           // Downward vertical acceleration (m/s²)
        substanceMass: number;                     // Particulate mass/inertia (kg normalized: 0.05 smoke/dust to 4.5 metal)
        dragCoefficient: number;                   // Aerodynamic Stokes drag parameter k
        restitution: number;                       // Floor collision coefficient of restitution e (0.0 to 1.0)
        friction: number;                          // Surface contact friction coefficient μ
    };

    // Continuous Analytical PDE Manifolds
    // Represents normalized blend weights [w₀...w₅] across fundamental PDE geometries:
    // [0: convective buoyant plume, 1: hyperbolic cyclone funnel, 2: parabolic fountain jet,
    //  3: spherical shockwave shell, 4: planar accretion disk, 5: lateral turbulent gale]
    manifoldWeights: [number, number, number, number, number, number];
    manifoldScale: number;                         // Spatial bounding scale
    advectionCurlScale: number;                    // 3D divergence-free curl noise frequency

    // Particulate Material & Radiometric Shading
    material: {
        emissionModel: ParticleEmissionModel;
        coreRadiance: [number, number, number];     // High-energy focal radiance [R, G, B]
        midRadiance: [number, number, number];      // Active particulate body radiance [R, G, B]
        outerRadiance: [number, number, number];    // Boundary dissipation / penumbra radiance [R, G, B]
        opticalExtinction: number;                  // Beer-Lambert volume extinction coefficient σ_a
        specularGloss: number;                      // Surface highlight sharpness & reflectivity
        colorTemperatureK: number;                  // Planckian blackbody Kelvin temperature (1000K to 40000K)
        particleSizePx: number;                     // Viewport sprite diameter
        particleCount: number;                      // Active particle budget (typically 2000 to 5000)
    };

    // Optics & Lens Filtration
    optics: {
        bloomMultiplier: number;                    // Screen-space HDR glare power
        diffusionBlurRadius: number;                // Atmospheric optical dispersion
        thermalMirageHaze: number;                  // Refractive index gradient (dn/dT) shimmering
        chromaticDispersion: number;                // Wavelength splitting index
    };

    // Acoustic Resonance & Physical Sonic Profile
    acoustics: {
        subBassHertz: number;                       // Fundamental impulse carrier frequency
        resonantCenterHertz: number;                // Acoustic cavity resonance peak
        impulseRate: number;                        // Detonation / crackle / impact event rate
    };
}

export const DEFAULT_ADAPTIVE_PARTICLE_CONTRACT: AdaptiveParticleContract = {
    id: 'contract-default-combustion',
    subject: 'Volumetric Combustion Plume',
    narrativeContext: 'High-temperature thermodynamic fuel combustion with billowing carbon smoke',
    kinematics: {
        linearVelocity: [0.0, 2.2, 0.0],
        vorticityTensor: 0.85,
        radialDivergence: 1.8,
        ambientWind: [0.4, 0.1, 0.1],
        windGustiness: 0.35,
        gravity: -1.2,
        substanceMass: 0.30,
        dragCoefficient: 0.88,
        restitution: 0.35,
        friction: 0.70
    },
    manifoldWeights: [1.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    manifoldScale: 1.0,
    advectionCurlScale: 0.62,
    material: {
        emissionModel: 'incandescent',
        coreRadiance: [1.0, 0.96, 0.72],
        midRadiance: [1.0, 0.46, 0.05],
        outerRadiance: [0.18, 0.06, 0.02],
        opticalExtinction: 2.15,
        specularGloss: 0.20,
        colorTemperatureK: 2850,
        particleSizePx: 1.5,
        particleCount: 6000
    },
    optics: {
        bloomMultiplier: 1.25,
        diffusionBlurRadius: 1.25,
        thermalMirageHaze: 0.45,
        chromaticDispersion: 0.015
    },
    acoustics: {
        subBassHertz: 60,
        resonantCenterHertz: 350,
        impulseRate: 8
    }
};

/**
 * Linear scalar interpolation helper
 */
function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * Math.max(0.0, Math.min(1.0, t));
}

/**
 * 3-component vector interpolation helper
 */
function lerp3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
    const cl = Math.max(0.0, Math.min(1.0, t));
    return [
        a[0] + (b[0] - a[0]) * cl,
        a[1] + (b[1] - a[1]) * cl,
        a[2] + (b[2] - a[2]) * cl
    ];
}

/**
 * 6-component vector interpolation helper
 */
function lerp6(a: [number, number, number, number, number, number], b: [number, number, number, number, number, number], t: number): [number, number, number, number, number, number] {
    const cl = Math.max(0.0, Math.min(1.0, t));
    return [
        a[0] + (b[0] - a[0]) * cl,
        a[1] + (b[1] - a[1]) * cl,
        a[2] + (b[2] - a[2]) * cl,
        a[3] + (b[3] - a[3]) * cl,
        a[4] + (b[4] - a[4]) * cl,
        a[5] + (b[5] - a[5]) * cl
    ];
}

/**
 * Interpolates two Adaptive Particle Contracts smoothly across continuous parameter space
 */
export function interpolateAdaptiveParticleContracts(
    current: AdaptiveParticleContract,
    target: AdaptiveParticleContract,
    alpha: number
): AdaptiveParticleContract {
    const t = Math.max(0.0, Math.min(1.0, alpha));

    return {
        id: t < 0.5 ? current.id : target.id,
        subject: t < 0.5 ? current.subject : target.subject,
        narrativeContext: t < 0.5 ? current.narrativeContext : target.narrativeContext,
        kinematics: {
            linearVelocity: lerp3(current.kinematics.linearVelocity, target.kinematics.linearVelocity, t),
            vorticityTensor: lerp(current.kinematics.vorticityTensor, target.kinematics.vorticityTensor, t),
            radialDivergence: lerp(current.kinematics.radialDivergence, target.kinematics.radialDivergence, t),
            ambientWind: lerp3(current.kinematics.ambientWind, target.kinematics.ambientWind, t),
            windGustiness: lerp(current.kinematics.windGustiness, target.kinematics.windGustiness, t),
            gravity: lerp(current.kinematics.gravity, target.kinematics.gravity, t),
            substanceMass: lerp(current.kinematics.substanceMass, target.kinematics.substanceMass, t),
            dragCoefficient: lerp(current.kinematics.dragCoefficient, target.kinematics.dragCoefficient, t),
            restitution: lerp(current.kinematics.restitution, target.kinematics.restitution, t),
            friction: lerp(current.kinematics.friction, target.kinematics.friction, t)
        },
        manifoldWeights: lerp6(current.manifoldWeights, target.manifoldWeights, t),
        manifoldScale: lerp(current.manifoldScale, target.manifoldScale, t),
        advectionCurlScale: lerp(current.advectionCurlScale, target.advectionCurlScale, t),
        material: {
            emissionModel: t < 0.5 ? current.material.emissionModel : target.material.emissionModel,
            coreRadiance: lerp3(current.material.coreRadiance, target.material.coreRadiance, t),
            midRadiance: lerp3(current.material.midRadiance, target.material.midRadiance, t),
            outerRadiance: lerp3(current.material.outerRadiance, target.material.outerRadiance, t),
            opticalExtinction: lerp(current.material.opticalExtinction, target.material.opticalExtinction, t),
            specularGloss: lerp(current.material.specularGloss, target.material.specularGloss, t),
            colorTemperatureK: lerp(current.material.colorTemperatureK, target.material.colorTemperatureK, t),
            particleSizePx: lerp(current.material.particleSizePx, target.material.particleSizePx, t),
            particleCount: Math.round(lerp(current.material.particleCount, target.material.particleCount, t))
        },
        optics: {
            bloomMultiplier: lerp(current.optics.bloomMultiplier, target.optics.bloomMultiplier, t),
            diffusionBlurRadius: lerp(current.optics.diffusionBlurRadius, target.optics.diffusionBlurRadius, t),
            thermalMirageHaze: lerp(current.optics.thermalMirageHaze, target.optics.thermalMirageHaze, t),
            chromaticDispersion: lerp(current.optics.chromaticDispersion, target.optics.chromaticDispersion, t)
        },
        acoustics: {
            subBassHertz: lerp(current.acoustics.subBassHertz, target.acoustics.subBassHertz, t),
            resonantCenterHertz: lerp(current.acoustics.resonantCenterHertz, target.acoustics.resonantCenterHertz, t),
            impulseRate: lerp(current.acoustics.impulseRate, target.acoustics.impulseRate, t)
        }
    };
}
