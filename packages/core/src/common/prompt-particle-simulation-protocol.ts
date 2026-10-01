/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Universal Simulation Profile Contract for 3D Particle & Volumetric Fluid Physics
 */
export interface ParticleSimulationProfile {
    id: string;
    name: string;
    prompt: string;

    topology: 'plume' | 'vortex' | 'fountain' | 'supernova' | 'orbital' | 'blizzard' | 'dust' | 'steam' | 'rain' | 'sparks';
    emissionModel: number; // 0: incandescent, 1: diffuse, 2: transmissive, 3: steam, 4: smoke, 5: luminescent

    swarm: {
        particleCount: number;       // Active particle count (e.g. 2500)
        behavior: 'thermal_drift' | 'helical_funnel' | 'ballistic_cascade' | 'radial_ejecta' | 'keplerian_disk' | 'turbulent_gale' | 'dust_sweep' | 'rain_fall' | 'spark_ricochet';
        particleSize: number;        // Base point sprite pixel size
        particleGlow: number;        // Emissive bloom contribution
        shape: 'orb' | 'spark' | 'droplet' | 'crystal' | 'mote';
        speed: number;               // Kinematic velocity scale
        gravity: number;             // Downward gravitational acceleration (m/s^2)
        fadeRate: number;            // Lifetime decay rate
    };

    dynamics: {
        upwardDraft: number;         // Vertical convective advection speed
        swirlVorticity: number;      // Helical angular rotation velocity
        radialExpansion: number;     // Outward shockwave / blast speed
        turbulenceScale: number;     // Spatial frequency of 3D curl noise
        turbulenceSpeed: number;     // Temporal rate of noise displacement
        gravityBuoyancy: number;     // Gravitational arc (-1.0 heavy fluid, +1.0 buoyant gas)
        dragCoefficient: number;     // Aerodynamic Stokes drag
        windVelocity: [number, number, number]; // [Wx, Wy, Wz] ambient wind velocity in m/s
        windTurbulence: number;      // Wind gustiness & aerodynamic turbulence amplitude
        substanceMass: number;       // Substance inertia: 0.08 (dust/smoke), 0.15 (steam), 1.4 (water), 4.5 (sparks)
    };

    morphology: {
        scale: number;               // Overall bounding scale multiplier
        fluteFrequency: number;      // Angular harmonic tongue flutes (3.0, 5.0, etc.)
        mushroomBulge: number;       // Mid-level buoyant expansion
        densityScale: number;        // Volumetric optical density
        absorptionCoeff: number;     // Beer-Lambert light extinction factor
        dissipationCeiling: number;  // Vertical cutoff altitude
    };

    palette: {
        core: [number, number, number];        // Peak emission/incandescence [R, G, B]
        mid: [number, number, number];         // Active fluid body / flame [R, G, B]
        outer: [number, number, number];       // Boundary smoke / cooling edge [R, G, B]
        background: [number, number, number];  // Ambient void / atmospheric backdrop
    };

    optics: {
        bloomIntensity: number;      // Optical lens bloom multiplier
        blurAmount: number;          // Diffusion blur kernel radius
        shimmerAmount: number;       // Micro-refraction mirage wave strength
        chromaticDispersion: number; // Spectral color split factor
    };

    audio: {
        subBassFreq: number;         // Fundamental detonation / rumble frequency (Hz)
        resonanceFreq: number;       // Resonant bandpass filter center frequency (Hz)
        crackleRate: number;         // Ember / arc crackle frequency
        noiseType: 'rumble' | 'hiss' | 'electrical' | 'bubbling' | 'wind';
    };
}

export const DEFAULT_FIRE_SIMULATION_PROFILE: ParticleSimulationProfile = {
    id: 'default-fire-explosion',
    name: 'Volumetric Fire Explosion',
    prompt: 'realistic 3D fire explosion with dark billowing smoke and incandescent flame tongues',
    topology: 'plume',
    emissionModel: 0,
    swarm: {
        particleCount: 6000,
        behavior: 'thermal_drift',
        particleSize: 1.5,
        particleGlow: 1.2,
        shape: 'spark',
        speed: 1.0,
        gravity: -1.2,
        fadeRate: 0.8
    },
    dynamics: {
        upwardDraft: 2.2,
        swirlVorticity: 0.85,
        radialExpansion: 1.8,
        turbulenceScale: 0.62,
        turbulenceSpeed: 1.15,
        gravityBuoyancy: 0.75,
        dragCoefficient: 0.88,
        windVelocity: [0.4, 0.1, 0.1],
        windTurbulence: 0.35,
        substanceMass: 0.30
    },
    morphology: {
        scale: 1.0,
        fluteFrequency: 3.0,
        mushroomBulge: 1.25,
        densityScale: 2.15,
        absorptionCoeff: 2.15,
        dissipationCeiling: 6.5
    },
    palette: {
        core: [1.0, 0.96, 0.72],
        mid: [1.0, 0.46, 0.05],
        outer: [0.18, 0.06, 0.02],
        background: [0.008, 0.010, 0.014]
    },
    optics: {
        bloomIntensity: 1.25,
        blurAmount: 1.25,
        shimmerAmount: 0.45,
        chromaticDispersion: 0.015
    },
    audio: {
        subBassFreq: 60,
        resonanceFreq: 350,
        crackleRate: 8,
        noiseType: 'rumble'
    }
};

/**
 * Helper to interpolate scalar values with optional clamping
 */
function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * Math.max(0.0, Math.min(1.0, t));
}

/**
 * Helper to interpolate 3-component RGB vectors
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
 * Seamlessly interpolates between two simulation profiles without numeric discontinuities
 */
export function interpolateSimulationProfiles(
    current: ParticleSimulationProfile,
    target: ParticleSimulationProfile,
    alpha: number
): ParticleSimulationProfile {
    const t = Math.max(0.0, Math.min(1.0, alpha));

    return {
        id: t < 0.5 ? current.id : target.id,
        name: t < 0.5 ? current.name : target.name,
        prompt: t < 0.5 ? current.prompt : target.prompt,
        topology: t < 0.5 ? current.topology : target.topology,
        emissionModel: t < 0.5 ? current.emissionModel : target.emissionModel,
        swarm: {
            particleCount: Math.round(lerp(current.swarm.particleCount, target.swarm.particleCount, t)),
            behavior: t < 0.5 ? current.swarm.behavior : target.swarm.behavior,
            particleSize: lerp(current.swarm.particleSize, target.swarm.particleSize, t),
            particleGlow: lerp(current.swarm.particleGlow, target.swarm.particleGlow, t),
            shape: t < 0.5 ? current.swarm.shape : target.swarm.shape,
            speed: lerp(current.swarm.speed, target.swarm.speed, t),
            gravity: lerp(current.swarm.gravity, target.swarm.gravity, t),
            fadeRate: lerp(current.swarm.fadeRate, target.swarm.fadeRate, t)
        },
        dynamics: {
            upwardDraft: lerp(current.dynamics.upwardDraft, target.dynamics.upwardDraft, t),
            swirlVorticity: lerp(current.dynamics.swirlVorticity, target.dynamics.swirlVorticity, t),
            radialExpansion: lerp(current.dynamics.radialExpansion, target.dynamics.radialExpansion, t),
            turbulenceScale: lerp(current.dynamics.turbulenceScale, target.dynamics.turbulenceScale, t),
            turbulenceSpeed: lerp(current.dynamics.turbulenceSpeed, target.dynamics.turbulenceSpeed, t),
            gravityBuoyancy: lerp(current.dynamics.gravityBuoyancy, target.dynamics.gravityBuoyancy, t),
            dragCoefficient: lerp(current.dynamics.dragCoefficient, target.dynamics.dragCoefficient, t),
            windVelocity: lerp3(current.dynamics.windVelocity, target.dynamics.windVelocity, t),
            windTurbulence: lerp(current.dynamics.windTurbulence, target.dynamics.windTurbulence, t),
            substanceMass: lerp(current.dynamics.substanceMass, target.dynamics.substanceMass, t)
        },
        morphology: {
            scale: lerp(current.morphology.scale, target.morphology.scale, t),
            fluteFrequency: lerp(current.morphology.fluteFrequency, target.morphology.fluteFrequency, t),
            mushroomBulge: lerp(current.morphology.mushroomBulge, target.morphology.mushroomBulge, t),
            densityScale: lerp(current.morphology.densityScale, target.morphology.densityScale, t),
            absorptionCoeff: lerp(current.morphology.absorptionCoeff, target.morphology.absorptionCoeff, t),
            dissipationCeiling: lerp(current.morphology.dissipationCeiling, target.morphology.dissipationCeiling, t)
        },
        palette: {
            core: lerp3(current.palette.core, target.palette.core, t),
            mid: lerp3(current.palette.mid, target.palette.mid, t),
            outer: lerp3(current.palette.outer, target.palette.outer, t),
            background: lerp3(current.palette.background, target.palette.background, t)
        },
        optics: {
            bloomIntensity: lerp(current.optics.bloomIntensity, target.optics.bloomIntensity, t),
            blurAmount: lerp(current.optics.blurAmount, target.optics.blurAmount, t),
            shimmerAmount: lerp(current.optics.shimmerAmount, target.optics.shimmerAmount, t),
            chromaticDispersion: lerp(current.optics.chromaticDispersion, target.optics.chromaticDispersion, t)
        },
        audio: {
            subBassFreq: lerp(current.audio.subBassFreq, target.audio.subBassFreq, t),
            resonanceFreq: lerp(current.audio.resonanceFreq, target.audio.resonanceFreq, t),
            crackleRate: lerp(current.audio.crackleRate, target.audio.crackleRate, t),
            noiseType: t < 0.5 ? current.audio.noiseType : target.audio.noiseType
        }
    };
}

/**
 * Universal Semantic Prompt Compiler
 * Synthesizes physical, optical, and acoustic simulation profiles from natural language
 */
export function compileSimulationFromPrompt(
    prompt: string,
    baseProfile: ParticleSimulationProfile = DEFAULT_FIRE_SIMULATION_PROFILE
): ParticleSimulationProfile {
    const text = prompt.toLowerCase();

    // 1. Semantic Color Detection & Palette Mapping
    const hasWord = (pattern: RegExp) => pattern.test(text);

    let coreRGB: [number, number, number] = [...baseProfile.palette.core];
    let midRGB: [number, number, number] = [...baseProfile.palette.mid];
    let outerRGB: [number, number, number] = [...baseProfile.palette.outer];

    if (text.includes('purple') || text.includes('violet')) {
        coreRGB = [0.92, 0.78, 1.0];
        midRGB = [0.55, 0.12, 0.95];
        outerRGB = [0.18, 0.02, 0.35];
    } else if (text.includes('pink') || text.includes('magenta') || text.includes('rose')) {
        coreRGB = [1.0, 0.85, 0.95];
        midRGB = [0.95, 0.15, 0.65];
        outerRGB = [0.32, 0.02, 0.22];
    } else if (text.includes('blue') || text.includes('cyan') || text.includes('azure') || text.includes('sapphire')) {
        coreRGB = [0.85, 0.95, 1.0];
        midRGB = [0.10, 0.55, 1.0];
        outerRGB = [0.02, 0.15, 0.45];
    } else if (text.includes('turquoise') || text.includes('teal') || text.includes('aqua')) {
        coreRGB = [0.82, 1.0, 0.95];
        midRGB = [0.05, 0.85, 0.78];
        outerRGB = [0.01, 0.25, 0.28];
    } else if (text.includes('green') || text.includes('emerald') || text.includes('lime') || text.includes('jade')) {
        coreRGB = [0.88, 1.0, 0.45];
        midRGB = [0.12, 0.92, 0.25];
        outerRGB = [0.02, 0.28, 0.08];
    } else if (text.includes('yellow') || text.includes('gold') || text.includes('amber')) {
        coreRGB = [1.0, 0.98, 0.85];
        midRGB = [1.0, 0.78, 0.12];
        outerRGB = [0.32, 0.15, 0.02];
    } else if (text.includes('red') || text.includes('crimson') || text.includes('blood') || text.includes('ruby')) {
        coreRGB = [1.0, 0.82, 0.78];
        midRGB = [0.95, 0.08, 0.05];
        outerRGB = [0.28, 0.02, 0.02];
    } else if (text.includes('white') || text.includes('silver') || text.includes('crystal')) {
        coreRGB = [1.0, 1.0, 1.0];
        midRGB = [0.85, 0.90, 0.98];
        outerRGB = [0.35, 0.40, 0.48];
    } else if (text.includes('dark matter') || text.includes('void') || text.includes('singularity') || text.includes('black hole') || text.includes('shadow')) {
        coreRGB = [0.75, 0.45, 0.95];
        midRGB = [0.25, 0.05, 0.35];
        outerRGB = [0.01, 0.005, 0.02];
    } else if (text.includes('plasma') || text.includes('lightning') || text.includes('electric') || text.includes('neon') || text.includes('cyber')) {
        coreRGB = [0.85, 0.95, 1.0];
        midRGB = [0.12, 0.45, 1.0];
        outerRGB = [0.45, 0.05, 0.85];
    } else if (text.includes('acid') || text.includes('toxic') || text.includes('poison') || text.includes('slime')) {
        coreRGB = [0.88, 1.0, 0.35];
        midRGB = [0.08, 0.92, 0.22];
        outerRGB = [0.02, 0.28, 0.08];
    } else if (text.includes('supernova') || text.includes('cosmic') || text.includes('galaxy') || text.includes('stellar') || text.includes('nebula')) {
        coreRGB = [1.0, 0.95, 0.82];
        midRGB = [0.82, 0.15, 0.78];
        outerRGB = [0.25, 0.02, 0.38];
    } else if (text.includes('blizzard') || text.includes('ice') || text.includes('frost') || text.includes('cryo') || text.includes('cold') || text.includes('snow')) {
        coreRGB = [0.92, 0.98, 1.0];
        midRGB = [0.48, 0.78, 0.98];
        outerRGB = [0.15, 0.32, 0.45];
    } else if (hasWord(/\b(dust|sand|desert|earth|clay|ochre)\b/)) {
        coreRGB = [0.95, 0.85, 0.65];
        midRGB = [0.78, 0.58, 0.28];
        outerRGB = [0.38, 0.26, 0.12];
    } else if (text.includes('water') || text.includes('cascade') || text.includes('fountain') || text.includes('splash') || text.includes('ocean') || text.includes('river')) {
        coreRGB = [0.88, 0.96, 1.0];
        midRGB = [0.12, 0.68, 0.95];
        outerRGB = [0.04, 0.28, 0.48];
    } else if (text.includes('steam') || text.includes('vapor') || text.includes('mist') || text.includes('fog')) {
        coreRGB = [0.96, 0.96, 0.98];
        midRGB = [0.82, 0.85, 0.90];
        outerRGB = [0.35, 0.38, 0.42];
    } else if (text.includes('rain') || text.includes('downpour') || text.includes('drizzle')) {
        coreRGB = [0.88, 0.92, 0.98];
        midRGB = [0.25, 0.45, 0.65];
        outerRGB = [0.08, 0.14, 0.22];
    } else if (hasWord(/\b(sparks?|welding|grinding)\b/)) {
        coreRGB = [1.0, 1.0, 0.88];
        midRGB = [1.0, 0.68, 0.15];
        outerRGB = [0.45, 0.15, 0.02];
    } else if (text.includes('smoke') || text.includes('campfire') || text.includes('soot') || text.includes('chimney')) {
        coreRGB = [0.95, 0.75, 0.35];
        midRGB = [0.35, 0.32, 0.32];
        outerRGB = [0.08, 0.08, 0.08];
    } else if (text.includes('solar') || text.includes('sun') || text.includes('holy') || text.includes('divine')) {
        coreRGB = [1.0, 0.98, 0.85];
        midRGB = [1.0, 0.72, 0.12];
        outerRGB = [0.35, 0.18, 0.02];
    }

    // 2. Behavioral Topology Classification
    let topology: ParticleSimulationProfile['topology'] = 'plume';
    if (hasWord(/\b(supernova|shockwave)\b/)) {
        topology = 'supernova';
    } else if (hasWord(/\b(galaxy|accretion|orbital)\b/)) {
        topology = 'orbital';
    } else if (hasWord(/\b(sparks?|welding|grinding)\b/)) {
        topology = 'sparks';
    } else if (hasWord(/\b(fountain|geyser|cascade|waterfall|acid|splash)\b/)) {
        topology = 'fountain';
    } else if (hasWord(/\b(rain|downpour|drizzle)\b/)) {
        topology = 'rain';
    } else if (hasWord(/\b(steam|geothermal)\b/)) {
        topology = 'steam';
    } else if (hasWord(/\b(dust|sand|desert|sandstorm)\b/)) {
        topology = 'dust';
    } else if (hasWord(/\b(blizzard|snow|frost|ice|flurry|freezing)\b/)) {
        topology = 'blizzard';
    } else if (hasWord(/\b(vortex|tornado|cyclone|twister|whirlpool)\b/)) {
        topology = 'vortex';
    }

    // 3. Dynamic Swarm Kinematics & Styling
    let swarmBehavior: ParticleSimulationProfile['swarm']['behavior'] = 'thermal_drift';
    let swarmShape: ParticleSimulationProfile['swarm']['shape'] = 'spark';
    let swarmGravity = -1.2;
    let swarmSpeed = 1.0;
    let particleSize = 1.5;
    let particleGlow = 1.2;
    let fadeRate = 0.8;

    if (topology === 'dust') {
        swarmBehavior = 'dust_sweep';
        swarmShape = 'mote';
        swarmGravity = -0.4;
        swarmSpeed = 1.6;
        particleSize = 1.0;
        particleGlow = 0.22; // Diffuse non-emissive dust motes
        fadeRate = 0.5;
    } else if (topology === 'steam') {
        swarmBehavior = 'thermal_drift';
        swarmShape = 'orb';
        swarmGravity = 0.3; // Soft buoyant rise
        swarmSpeed = 0.8;
        particleSize = 2.2;
        particleGlow = 0.45;
        fadeRate = 0.7;
    } else if (topology === 'rain') {
        swarmBehavior = 'rain_fall';
        swarmShape = 'droplet';
        swarmGravity = -16.0; // Rapid downward downpour
        swarmSpeed = 3.6;
        particleSize = 1.3;
        particleGlow = 0.55;
        fadeRate = 1.4;
    } else if (topology === 'sparks') {
        swarmBehavior = 'spark_ricochet';
        swarmShape = 'spark';
        swarmGravity = -9.8;
        swarmSpeed = 3.8;
        particleSize = 1.2;
        particleGlow = 1.9; // Brilliant molten incandescence
        fadeRate = 1.3;
    } else if (topology === 'fountain') {
        swarmBehavior = 'ballistic_cascade';
        swarmShape = 'droplet';
        swarmGravity = -9.8; // Earth gravitational drop
        swarmSpeed = 2.2;
        particleSize = 1.4;
        particleGlow = 0.75;
        fadeRate = 0.9;
    } else if (topology === 'vortex') {
        swarmBehavior = 'helical_funnel';
        swarmShape = 'spark';
        swarmGravity = 0.8;
        swarmSpeed = 2.6;
        particleSize = 1.4;
        particleGlow = 1.4;
        fadeRate = 0.7;
    } else if (topology === 'orbital') {
        swarmBehavior = 'keplerian_disk';
        swarmShape = 'orb';
        swarmGravity = 0.0;
        swarmSpeed = 1.2;
        particleSize = 1.2;
        particleGlow = 1.5;
        fadeRate = 0.4;
    } else if (topology === 'supernova') {
        swarmBehavior = 'radial_ejecta';
        swarmShape = 'spark';
        swarmGravity = 0.0;
        swarmSpeed = 3.4;
        particleSize = 1.5;
        particleGlow = 1.8;
        fadeRate = 1.2;
    } else if (topology === 'blizzard') {
        swarmBehavior = 'turbulent_gale';
        swarmShape = 'crystal';
        swarmGravity = -0.8;
        swarmSpeed = 1.4;
        particleSize = 1.3;
        particleGlow = 0.9;
        fadeRate = 0.5;
    } else if (text.includes('smoke') || text.includes('campfire')) {
        swarmBehavior = 'thermal_drift';
        swarmShape = 'spark';
        particleSize = 1.3;
        particleGlow = 0.65;
        swarmGravity = -0.5;
    }

    // 4. Dynamics & Fluid Kinematics
    let swirlVorticity = baseProfile.dynamics.swirlVorticity;
    let upwardDraft = baseProfile.dynamics.upwardDraft;
    let radialExpansion = baseProfile.dynamics.radialExpansion;
    let gravityBuoyancy = baseProfile.dynamics.gravityBuoyancy;
    let turbulenceScale = baseProfile.dynamics.turbulenceScale;
    let turbulenceSpeed = baseProfile.dynamics.turbulenceSpeed;

    if (topology === 'dust') {
        upwardDraft = 0.6;
        swirlVorticity = 0.35;
        gravityBuoyancy = 0.1;
        radialExpansion = 1.4;
    } else if (topology === 'steam') {
        upwardDraft = 1.4;
        swirlVorticity = 0.25;
        gravityBuoyancy = 0.45;
        radialExpansion = 1.2;
    } else if (topology === 'rain') {
        upwardDraft = -3.5;
        swirlVorticity = 0.1;
        gravityBuoyancy = -1.0;
        radialExpansion = 0.8;
    } else if (topology === 'sparks') {
        upwardDraft = 2.4;
        swirlVorticity = 0.6;
        radialExpansion = 2.2;
    } else if (topology === 'vortex') {
        swirlVorticity = 2.65;
        upwardDraft = Math.max(upwardDraft, 2.4);
    } else if (topology === 'fountain') {
        gravityBuoyancy = -0.45; // Fluid drops back down under gravity
        upwardDraft = 2.8;
        swirlVorticity = 0.45;
        radialExpansion = 1.1;
    } else if (topology === 'orbital') {
        swirlVorticity = 2.4;
        upwardDraft = 0.25; // Flat disk morphology
        gravityBuoyancy = 0.0;
    } else if (topology === 'supernova') {
        radialExpansion = 2.85;
        upwardDraft = 1.8;
        turbulenceScale = 0.75;
    } else if (topology === 'blizzard') {
        turbulenceSpeed = 0.85;
        gravityBuoyancy = 0.35;
        upwardDraft = 0.8;
    }

    if (text.includes('smoke') || text.includes('campfire')) {
        upwardDraft = 1.25;
        swirlVorticity = 0.45;
    }

    // 5. Substance Aerodynamics & Wind Velocity
    let windVelocity: [number, number, number] = [0.4, 0.1, 0.1];
    let windTurbulence = 0.35;
    let substanceMass = 0.30; // Standard combustion gas/embers

    if (topology === 'dust') {
        windVelocity = [3.2, 0.15, 0.4]; // Strong horizontal wind gusts
        windTurbulence = 0.75;
        substanceMass = 0.08; // Ultra-light sand motes, easily swept by gusts
    } else if (topology === 'fountain') {
        windVelocity = [0.35, 0.0, 0.15];
        windTurbulence = 0.20;
        substanceMass = 1.40; // Heavy liquid mass, ballistic inertia dominates
    } else if (topology === 'rain') {
        windVelocity = [2.4, -2.5, 0.5]; // Crosswind angled downpour
        windTurbulence = 0.45;
        substanceMass = 0.85; // Heavy droplets with crosswind slant
    } else if (topology === 'steam') {
        windVelocity = [0.85, 0.45, 0.25]; // Gentle buoyant thermal breeze
        windTurbulence = 0.40;
        substanceMass = 0.15; // Light buoyant water vapor
    } else if (topology === 'sparks') {
        windVelocity = [0.6, 0.0, 0.2];
        windTurbulence = 0.20;
        substanceMass = 4.50; // Dense molten metal, resists wind deflection
    } else if (topology === 'blizzard') {
        windVelocity = [3.5, -0.4, 0.8]; // Horizontal gale
        windTurbulence = 0.85;
        substanceMass = 0.18; // Lightweight crystalline ice flakes
    } else if (topology === 'vortex') {
        windVelocity = [0.2, 0.0, 0.2];
        windTurbulence = 0.90;
        substanceMass = 0.35;
    } else if (topology === 'orbital') {
        windVelocity = [0.0, 0.0, 0.0];
        windTurbulence = 0.15;
        substanceMass = 1.0;
    } else if (topology === 'supernova') {
        windVelocity = [0.0, 0.0, 0.0];
        windTurbulence = 0.10;
        substanceMass = 2.0;
    } else if (text.includes('smoke') || text.includes('campfire')) {
        windVelocity = [1.2, 0.25, 0.2];
        windTurbulence = 0.55;
        substanceMass = 0.06; // Ultra-light soot particles
    }

    if (hasWord(/\b(wind|gale|breeze|gust|storm)\b/)) {
        windVelocity = [windVelocity[0] * 1.4, windVelocity[1], windVelocity[2] * 1.4];
        windTurbulence = Math.min(1.0, windTurbulence * 1.3);
    }

    // 3. Morphology & Scale
    let scale = baseProfile.morphology.scale;
    let absorptionCoeff = baseProfile.morphology.absorptionCoeff;
    let densityScale = baseProfile.morphology.densityScale;

    if (text.includes('supernova') || text.includes('cosmic') || text.includes('massive') || text.includes('huge')) {
        scale = 1.45;
    } else if (text.includes('tiny') || text.includes('micro') || text.includes('spark')) {
        scale = 0.65;
    }

    if (text.includes('steam') || text.includes('mist') || text.includes('vapor') || text.includes('blizzard') || text.includes('ethereal') || text.includes('ghost')) {
        absorptionCoeff = 0.95; // Sheer translucent light passage
        densityScale = 1.35;
    }

    // 4. Acoustic Synthesis Profile
    let subBassFreq = baseProfile.audio.subBassFreq;
    let resonanceFreq = baseProfile.audio.resonanceFreq;
    let crackleRate = baseProfile.audio.crackleRate;
    let noiseType: ParticleSimulationProfile['audio']['noiseType'] = 'rumble';

    if (text.includes('plasma') || text.includes('electric') || text.includes('lightning') || text.includes('laser')) {
        noiseType = 'electrical';
        resonanceFreq = 1200;
        crackleRate = 24;
    } else if (text.includes('acid') || text.includes('toxic') || text.includes('bubbling') || text.includes('fountain') || text.includes('liquid')) {
        noiseType = 'bubbling';
        resonanceFreq = 580;
        crackleRate = 14;
    } else if (text.includes('blizzard') || text.includes('wind') || text.includes('frost') || text.includes('breeze') || text.includes('cold')) {
        noiseType = 'wind';
        resonanceFreq = 720;
        crackleRate = 2;
    } else if (text.includes('supernova') || text.includes('cosmic') || text.includes('deep') || text.includes('abyss')) {
        subBassFreq = 32;
        resonanceFreq = 220;
    }

    // Derive display name from prompt capitalization
    const words = prompt.trim().split(/\s+/).slice(0, 4);
    const capitalizedName = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');

    let emissionModel = 0;
    if (topology === 'dust') {
        emissionModel = 1; // diffuse mineral
    } else if (topology === 'fountain' || topology === 'rain') {
        emissionModel = 2; // transmissive liquid
    } else if (topology === 'steam') {
        emissionModel = 3; // condensing vapor
    } else if (hasWord(/\b(smoke|campfire|soot|chimney)\b/)) {
        emissionModel = 4; // smoke plume
    } else if (hasWord(/\b(bioluminescent|plankton|dinoflagellate|fluorescent)\b/)) {
        emissionModel = 5; // cold chemical luminescence
    }

    return {
        id: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: capitalizedName || 'Custom Particle Simulation',
        prompt,
        topology,
        emissionModel,
        swarm: {
            particleCount: 6000,
            behavior: swarmBehavior,
            particleSize,
            particleGlow,
            shape: swarmShape,
            speed: swarmSpeed,
            gravity: swarmGravity,
            fadeRate
        },
        dynamics: {
            upwardDraft,
            swirlVorticity,
            radialExpansion,
            turbulenceScale,
            turbulenceSpeed,
            gravityBuoyancy,
            dragCoefficient: baseProfile.dynamics.dragCoefficient,
            windVelocity,
            windTurbulence,
            substanceMass
        },
        morphology: {
            scale,
            fluteFrequency: baseProfile.morphology.fluteFrequency,
            mushroomBulge: baseProfile.morphology.mushroomBulge,
            densityScale,
            absorptionCoeff,
            dissipationCeiling: baseProfile.morphology.dissipationCeiling
        },
        palette: {
            core: coreRGB,
            mid: midRGB,
            outer: outerRGB,
            background: baseProfile.palette.background
        },
        optics: {
            bloomIntensity: text.includes('supernova') || text.includes('plasma') ? 1.75 : 1.25,
            blurAmount: baseProfile.optics.blurAmount,
            shimmerAmount: text.includes('ice') || text.includes('blizzard') ? 0.20 : 0.45,
            chromaticDispersion: text.includes('plasma') || text.includes('cosmic') ? 0.025 : 0.015
        },
        audio: {
            subBassFreq,
            resonanceFreq,
            crackleRate,
            noiseType
        }
    };
}
