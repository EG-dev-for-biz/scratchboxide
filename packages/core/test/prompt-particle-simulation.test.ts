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
    ParticleSimulationProfile,
    compileSimulationFromPrompt,
    interpolateSimulationProfiles,
    DEFAULT_FIRE_SIMULATION_PROFILE
} from '../src/common/prompt-particle-simulation-protocol';

describe('Universal Prompt-Driven Particle & Volumetric Simulation Suite', () => {

    it('verifies the default baseline fire explosion profile adheres to physics constraints', () => {
        const fire = DEFAULT_FIRE_SIMULATION_PROFILE;
        expect(fire.name).toMatch(/fire/i);
        expect(fire.dynamics.upwardDraft).toBeGreaterThan(1.0);
        expect(fire.dynamics.turbulenceScale).toBeGreaterThan(0.4);

        // Core should be hot white-amber, cooling to dark embers
        expect(fire.palette.core[0]).toBeGreaterThan(0.9);
        expect(fire.palette.core[1]).toBeGreaterThan(0.8);
        expect(fire.palette.outer[0]).toBeGreaterThan(fire.palette.outer[2]); // Warm crimson/charcoal

        // Audio & Optics
        expect(fire.audio.subBassFreq).toBeLessThan(100);
        expect(fire.optics.bloomIntensity).toBeGreaterThan(0.5);
    });

    it('compiles an "electric blue plasma vortex" with rotational vorticity and high-energy spectrum', () => {
        const prompt = 'electric blue plasma vortex with purple lightning';
        const plasma = compileSimulationFromPrompt(prompt);

        expect(plasma.name.toLowerCase()).toContain('plasma');
        expect(plasma.topology).toBe('vortex');
        expect(plasma.swarm.behavior).toBe('helical_funnel');
        expect(plasma.dynamics.swirlVorticity).toBeGreaterThan(2.0); // Strong vortex swirling
        expect(plasma.dynamics.upwardDraft).toBeGreaterThan(1.2);

        // Blue/cyan core with purple/violet outer filaments
        expect(plasma.palette.core[2]).toBeGreaterThan(0.7); // High blue channel
        expect(plasma.palette.mid[2]).toBeGreaterThan(plasma.palette.mid[0]); // Predominantly cyan/blue

        // Sound profile should reflect electrical crackle & higher resonance
        expect(plasma.audio.resonanceFreq).toBeGreaterThan(800);
        expect(plasma.audio.crackleRate).toBeGreaterThan(10);
    });

    it('compiles a "toxic emerald acid fountain" with fluid cascade and chemical luminescence', () => {
        const prompt = 'bubbling toxic emerald acid fountain with lime green mist';
        const acid = compileSimulationFromPrompt(prompt);

        expect(acid.name.toLowerCase()).toContain('acid');
        expect(acid.topology).toBe('fountain');
        expect(acid.swarm.behavior).toBe('ballistic_cascade');
        expect(acid.swarm.shape).toBe('droplet');
        expect(acid.swarm.gravity).toBeLessThan(-5.0); // Heavy downward gravity

        // Green dominance across color palette
        expect(acid.palette.core[1]).toBeGreaterThan(0.85); // High green
        expect(acid.palette.mid[1]).toBeGreaterThan(acid.palette.mid[0]); // Green > Red
        expect(acid.palette.mid[1]).toBeGreaterThan(acid.palette.mid[2]); // Green > Blue

        // Liquid fountain physics: higher viscosity, downward gravitational pull on splatter
        expect(acid.dynamics.gravityBuoyancy).toBeLessThan(0.0); // Downward gravitational arch
        expect(acid.audio.noiseType).toBe('bubbling');
    });

    it('compiles a "cosmic supernova explosion" with vast radial shockwave and deep sub-bass', () => {
        const prompt = 'cosmic supernova explosion with gold and magenta nebula dust';
        const supernova = compileSimulationFromPrompt(prompt);

        expect(supernova.name.toLowerCase()).toContain('supernova');
        expect(supernova.topology).toBe('supernova');
        expect(supernova.swarm.behavior).toBe('radial_ejecta');
        expect(supernova.dynamics.radialExpansion).toBeGreaterThan(2.5); // Massive outward blast
        expect(supernova.morphology.scale).toBeGreaterThan(1.2);

        // Gold & magenta palette
        expect(supernova.palette.core[0]).toBeGreaterThan(0.9); // Brilliant gold
        expect(supernova.palette.mid[0]).toBeGreaterThan(0.6); // Magenta red component
        expect(supernova.palette.mid[2]).toBeGreaterThan(0.6); // Magenta blue component

        // Deep infrasound detonation
        expect(supernova.audio.subBassFreq).toBeLessThan(45); // Sub-rumble
        expect(supernova.optics.bloomIntensity).toBeGreaterThan(1.5);
    });

    it('compiles a "cryogenic blizzard frost vortex" with ethereal translucent ice vapor', () => {
        const prompt = 'cryogenic blizzard frost vortex with freezing white ice crystals';
        const blizzard = compileSimulationFromPrompt(prompt);

        expect(blizzard.name.toLowerCase()).toContain('blizzard');
        expect(blizzard.topology).toBe('blizzard');
        expect(blizzard.swarm.behavior).toBe('turbulent_gale');
        expect(blizzard.swarm.shape).toBe('crystal');
        expect(blizzard.morphology.absorptionCoeff).toBeLessThan(1.5); // Highly translucent vapor
        expect(blizzard.palette.core[0]).toBeGreaterThan(0.8);
        expect(blizzard.palette.core[1]).toBeGreaterThan(0.85);
        expect(blizzard.palette.core[2]).toBeGreaterThan(0.9); // Brilliant ice white-cyan

        // Sound profile: howling wind noise
        expect(blizzard.audio.noiseType).toBe('wind');
    });

    it('compiles practical "crystal clear water fountain" with liquid droplet gravity and transmissive optics', () => {
        const prompt = 'crystal clear water fountain with splashing droplets and ripples';
        const water = compileSimulationFromPrompt(prompt);

        expect(water.name.toLowerCase()).toContain('water');
        expect(water.topology).toBe('fountain');
        expect(water.emissionModel).toBe(2); // Transmissive liquid (no fire)
        expect(water.swarm.behavior).toBe('ballistic_cascade');
        expect(water.swarm.shape).toBe('droplet');
        expect(water.swarm.gravity).toBeLessThan(-9.0); // Earth gravity -9.8 m/s²
        expect(water.palette.core[2]).toBeGreaterThan(0.9); // Clean water blue
    });

    it('compiles practical "desert dust storm" with dry diffuse non-emissive motes and ochre earth palette', () => {
        const prompt = 'swirling desert dust storm with fine sandy wind and ochre particles';
        const dust = compileSimulationFromPrompt(prompt);

        expect(dust.name.toLowerCase()).toContain('dust');
        expect(dust.topology).toBe('dust');
        expect(dust.emissionModel).toBe(1); // Diffuse mineral
        expect(dust.swarm.behavior).toBe('dust_sweep');
        expect(dust.swarm.shape).toBe('mote');
        // Diffuse, non-emissive particles (dust doesn't glow like fire)
        expect(dust.swarm.particleGlow).toBeLessThanOrEqual(0.35);
        // Earthy ochre/tan palette
        expect(dust.palette.mid[0]).toBeGreaterThan(0.65); // Red/tan
        expect(dust.palette.mid[1]).toBeGreaterThan(0.45); // Ochre yellow
        expect(dust.palette.mid[2]).toBeLessThan(0.40); // Low blue
    });

    it('compiles practical "geothermal steam vent" with billowing white vapor and low absorption', () => {
        const prompt = 'geothermal steam vent billowing white vapor and water mist';
        const steam = compileSimulationFromPrompt(prompt);

        expect(steam.name.toLowerCase()).toContain('steam');
        expect(steam.topology).toBe('steam');
        expect(steam.emissionModel).toBe(3); // Condensing steam
        expect(steam.swarm.shape).toBe('orb');
        // Pure soft white/grey vapor
        expect(steam.palette.core[0]).toBeGreaterThan(0.9);
        expect(steam.palette.core[1]).toBeGreaterThan(0.9);
        expect(steam.palette.core[2]).toBeGreaterThan(0.9);
        expect(steam.morphology.absorptionCoeff).toBeLessThan(1.2); // Translucent mist
    });

    it('compiles practical "heavy rain downpour" with high-speed downward droplets', () => {
        const prompt = 'heavy rain downpour with splashing water droplets hitting puddle';
        const rain = compileSimulationFromPrompt(prompt);

        expect(rain.name.toLowerCase()).toContain('rain');
        expect(rain.topology).toBe('rain');
        expect(rain.emissionModel).toBe(2); // Transmissive liquid (no fire)
        expect(rain.swarm.behavior).toBe('rain_fall');
        expect(rain.swarm.shape).toBe('droplet');
        expect(rain.swarm.speed).toBeGreaterThan(2.0); // Fast downward speed
        expect(rain.swarm.gravity).toBeLessThan(-12.0); // Rapid downward acceleration
    });

    it('compiles practical "industrial welding sparks" with bouncing floor ricochet', () => {
        const prompt = 'industrial welding sparks ricocheting off concrete floor with hot embers';
        const sparks = compileSimulationFromPrompt(prompt);

        expect(sparks.name.toLowerCase()).toContain('sparks');
        expect(sparks.topology).toBe('sparks');
        expect(sparks.swarm.behavior).toBe('spark_ricochet');
        expect(sparks.swarm.shape).toBe('spark');
        expect(sparks.swarm.speed).toBeGreaterThan(2.5); // High ejection velocity
        expect(sparks.swarm.particleGlow).toBeGreaterThan(1.4); // Brilliant incandescence
    });

    it('compiles practical "campfire smoke plume" with dark soot and gentle floating embers', () => {
        const prompt = 'gentle campfire smoke plume with cool grey smoke and glowing cinders';
        const smoke = compileSimulationFromPrompt(prompt);

        expect(smoke.name.toLowerCase()).toContain('smoke');
        expect(smoke.topology).toBe('plume');
        expect(smoke.swarm.behavior).toBe('thermal_drift');
        expect(smoke.dynamics.upwardDraft).toBeLessThan(1.8); // Gentle drift
    });

    it('smoothly interpolates between distinct simulation profiles without numeric discontinuities', () => {
        const fire = DEFAULT_FIRE_SIMULATION_PROFILE;
        const plasma = compileSimulationFromPrompt('electric blue plasma vortex');

        // Halfway interpolation (t = 0.5)
        const mid = interpolateSimulationProfiles(fire, plasma, 0.5);

        expect(mid.dynamics.swirlVorticity).toBeCloseTo(
            (fire.dynamics.swirlVorticity + plasma.dynamics.swirlVorticity) * 0.5,
            3
        );
        expect(mid.palette.mid[2]).toBeCloseTo(
            (fire.palette.mid[2] + plasma.palette.mid[2]) * 0.5,
            3
        );

        // Clamping check at t = 0.0 and t = 1.0
        const start = interpolateSimulationProfiles(fire, plasma, 0.0);
        expect(start.dynamics.swirlVorticity).toBeCloseTo(fire.dynamics.swirlVorticity, 4);

        const end = interpolateSimulationProfiles(fire, plasma, 1.0);
        expect(end.dynamics.swirlVorticity).toBeCloseTo(plasma.dynamics.swirlVorticity, 4);
    });

    it('verifies substance-specific wind velocity and aerodynamic mass dynamics', () => {
        // 1. Desert Dust: strong horizontal wind, ultra-light mass for immediate air suspension
        const dust = compileSimulationFromPrompt('desert dust sand storm with strong wind gusts');
        expect(dust.dynamics.windVelocity).toBeDefined();
        const dustWindHoriz = Math.hypot(dust.dynamics.windVelocity[0], dust.dynamics.windVelocity[2]);
        expect(dustWindHoriz).toBeGreaterThan(2.0); // Strong horizontal wind velocity
        expect(dust.dynamics.substanceMass).toBeLessThan(0.15); // Ultra-light mass, easily swept
        expect(dust.dynamics.windTurbulence).toBeGreaterThan(0.5);

        // 2. Crystal Water: high mass liquid, ballistic inertia dominates with subtle mist drift
        const water = compileSimulationFromPrompt('crystal water fountain spray with droplets');
        expect(water.dynamics.substanceMass).toBeGreaterThan(1.0); // Heavy liquid droplets
        expect(water.dynamics.windVelocity[1]).toBeCloseTo(0, 1);

        // 3. Rain Downpour: downward terminal velocity combined with crosswind shear
        const rain = compileSimulationFromPrompt('windblown rainstorm downpour with gale winds');
        expect(Math.abs(rain.dynamics.windVelocity[0])).toBeGreaterThan(1.5); // Angled crosswind
        expect(rain.dynamics.substanceMass).toBeGreaterThan(0.7); // Heavier than dust, lighter than dense metal

        // 4. Geothermal Steam: buoyant vapor with gentle breeze advection
        const steam = compileSimulationFromPrompt('geothermal steam vapor cloud in breeze');
        expect(steam.dynamics.substanceMass).toBeLessThan(0.25); // Very light condensing vapor
        expect(steam.dynamics.windVelocity[1]).toBeGreaterThanOrEqual(0.0); // Positive thermal updraft vector

        // 5. Welding Sparks: heavy molten iron droplets resisting wind deflection
        const sparks = compileSimulationFromPrompt('welding sparks and hot iron slag');
        expect(sparks.dynamics.substanceMass).toBeGreaterThan(3.0); // Heavy metal inertia
    });

    it('smoothly interpolates wind velocity vectors and aerodynamic mass between profiles', () => {
        const dust = compileSimulationFromPrompt('desert dust storm');
        const water = compileSimulationFromPrompt('water fountain');

        const mid = interpolateSimulationProfiles(dust, water, 0.5);
        expect(mid.dynamics.windVelocity[0]).toBeCloseTo(
            (dust.dynamics.windVelocity[0] + water.dynamics.windVelocity[0]) * 0.5,
            3
        );
        expect(mid.dynamics.substanceMass).toBeCloseTo(
            (dust.dynamics.substanceMass + water.dynamics.substanceMass) * 0.5,
            3
        );
    });

    it('verifies that the standalone HTML demo includes the interactive prompt bar and dynamic simulation morphing engine', () => {
        const demoPath = path.resolve(process.cwd(), 'public/demos/fire-explosion.html');
        expect(fs.existsSync(demoPath)).toBe(true);

        const content = fs.readFileSync(demoPath, 'utf8');

        // Check Prompt UI elements
        expect(content).toContain('prompt-input');
        expect(content).toContain('btn-morph');
        expect(content).toContain('prompt-chip');

        // Check Dynamic Morphing & Uniform Binding Logic
        expect(content).toMatch(/compileSimulationFromPrompt|morphToSimulation|targetProfile/);
        expect(content).toContain('uPaletteCore');
        expect(content).toContain('uPaletteMid');
        expect(content).toContain('uPaletteOuter');
        expect(content).toContain('uSwirlVorticity');
        expect(content).toContain('uUpwardDraft');

        // Check Wind Velocity & Substance Aerodynamics Uniforms
        expect(content).toContain('uWindVelocity');
        expect(content).toContain('uSubstanceMass');

        // Check Keyboard Isolation: typing in prompt input must not hijack camera controls or mode
        expect(content).toContain("e.target.tagName === 'INPUT'");
        expect(content).toContain('handleMorphSubmit');
        expect(content).toContain('prompt-form');

        // Check Dynamic GPU Particle Swarm System
        expect(content).toMatch(/ParticleSwarm|swarmProgram|uParticleSize|uParticleShape/i);
        expect(content).toMatch(/uTopologyWeights|topology/i);
    });

    it('verifies broad natural language color parsing (purple, cyan, gold, ruby, emerald, etc.)', () => {
        const purpleStorm = compileSimulationFromPrompt('swirling purple lightning tempest');
        expect(purpleStorm.palette.mid[0]).toBeGreaterThan(0.4); // Red/violet component
        expect(purpleStorm.palette.mid[2]).toBeGreaterThan(0.8); // High blue/violet component

        const rubyFire = compileSimulationFromPrompt('blazing ruby crimson flame');
        expect(rubyFire.palette.mid[0]).toBeGreaterThan(0.9); // Intense red
        expect(rubyFire.palette.mid[1]).toBeLessThan(0.2); // Low green
        expect(rubyFire.palette.mid[2]).toBeLessThan(0.2); // Low blue

        const cyanGeyser = compileSimulationFromPrompt('azure cyan water geyser');
        expect(cyanGeyser.palette.mid[2]).toBeGreaterThan(0.9); // Cyan blue
        expect(cyanGeyser.dynamics.gravityBuoyancy).toBeLessThan(0.0); // Liquid geyser drops
    });
});
