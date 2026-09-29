/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Analytical Blackbody Kelvin to Linear RGB (Planck's Law Approximation)
 * Matches Scratchbox native 3D engine physics (scratchbox_particles.hpp & scratchbox_lighting.hpp)
 */
export function evaluateBlackbodyRamp(kelvin: number): [number, number, number] {
    const temp = Math.max(10.0, Math.min(120.0, kelvin / 100.0));
    let r = 0, g = 0, b = 0;

    // Red component
    if (temp <= 66.0) {
        r = 1.0;
    } else {
        r = Math.max(0.0, Math.min(1.0, 1.292936186 * Math.pow(temp - 60.0, -0.1332047592)));
    }

    // Green component
    if (temp <= 66.0) {
        g = Math.max(0.0, Math.min(1.0, 0.39008157876 * Math.log(temp) - 0.63184144378));
    } else {
        g = Math.max(0.0, Math.min(1.0, 1.129817658 * Math.pow(temp - 60.0, -0.0755148492)));
    }

    // Blue component
    if (temp >= 66.0) {
        b = 1.0;
    } else if (temp <= 19.0) {
        b = 0.0;
    } else {
        b = Math.max(0.0, Math.min(1.0, 0.54320678911 * Math.log(temp - 10.0) - 1.19625408914));
    }

    return [r, g, b];
}

/**
 * Beer-Lambert Optical Extinction Law
 * Transmittance T(s) = exp(-sigma_a * s)
 */
export function evaluateBeerLambertTransmittance(density: number, stepSize: number, absorptionCoeff: number): number {
    const opticalDepth = density * stepSize * absorptionCoeff;
    return Math.exp(-opticalDepth);
}

/**
 * Aerodynamic Drag Deceleration (Stokes / Quadratic Resistance)
 * v(t) = v0 / (1 + k * v0 * t) or exponential deceleration v(t) = v0 * exp(-k * t)
 * Position x(t) = (v0 / k) * (1 - exp(-k * t))
 */
export function evaluateAerodynamicDeceleration(v0: number, k: number, t: number): { position: number, velocity: number } {
    const velocity = v0 * Math.exp(-k * t);
    const position = (v0 / k) * (1.0 - Math.exp(-k * t));
    return { position, velocity };
}

/**
 * Non-Spherical Organic Plume Morphological Velocity
 * Shapes the explosion into an upward convective mushroom column with asymmetrical turbulent lobes
 */
export function evaluateNonSphericalPlumeVelocity(
    unitDir: [number, number, number],
    upwardBuoyancy: number,
    lobeStrength: number
): [number, number, number] {
    const [dx, dy, dz] = unitDir;
    const theta = Math.atan2(dz, dx);
    const phi = Math.acos(Math.max(-1.0, Math.min(1.0, dy)));

    // Asymmetric azimuthal and polar multipole lobes (breaks spherical symmetry!)
    // sin(phi) is 1.0 at the equator, so azimuthal lobes modulate the horizontal envelope
    const lobeModulation = 1.0 + lobeStrength * (
        Math.cos(2.0 * theta) * Math.sin(phi) * 0.45 +
        Math.sin(3.0 * theta) * Math.sin(phi) * 0.30 +
        Math.cos(2.0 * phi) * 0.25
    );

    // Convective upward bias: hot combustion gas expands primarily upward (+Y)
    const vy = (dy + upwardBuoyancy) * lobeModulation;
    const vx = dx * lobeModulation;
    const vz = dz * lobeModulation;

    return [vx, vy, vz];
}

/**
 * Graceful Particle Dissipation & Falloff Curve
 * Soft cubic attack -> prolonged incandescent sustain -> smooth exponential Beer-Lambert dissipation
 */
export function evaluateGracefulParticleFalloff(age: number, lifetime: number): { alpha: number, scale: number, kelvin: number } {
    const t = Math.max(0.0, Math.min(1.0, age / lifetime));

    // Smooth cubic hermite attack (fast 4% rise) and smooth dissipation decay without harsh popping
    const attack = Math.min(1.0, t / 0.04);
    const smoothAttack = attack * attack * (3.0 - 2.0 * attack);
    
    // Graceful exponential decay in the second half of life with zero boundary termination
    const decay = t > 0.40 ? Math.exp(-4.2 * (t - 0.40)) * (1.0 - Math.pow(t, 3.0)) : 1.0;
    const alpha = smoothAttack * decay;

    // Scale expands as gas decompresses, then gracefully erodes as combustion burns out
    const expansion = Math.sin(Math.PI * Math.pow(t, 0.42));
    const scale = Math.max(0.02, expansion);

    // Continuous Planckian temperature transition: 5500K -> 2400K -> 1200K -> 550K (soot)
    const heat = Math.pow(Math.max(0.0, 1.0 - t), 1.4);
    const kelvin = 550.0 + heat * (5500.0 - 550.0);

    return { alpha, scale, kelvin };
}

/**
 * 3D Spatial Audio Telemetry & Doppler Shift Calculation
 */
export function computeExplosionAudioTelemetry(
    cameraPos: [number, number, number],
    cameraVelocity: [number, number, number],
    explosionCenter: [number, number, number],
    coreRadius: number
) {
    const dx = cameraPos[0] - explosionCenter[0];
    const dy = cameraPos[1] - explosionCenter[1];
    const dz = cameraPos[2] - explosionCenter[2];
    const distance = Math.hypot(dx, dy, dz);

    const isInsideCore = distance < coreRadius;
    const speed = Math.hypot(cameraVelocity[0], cameraVelocity[1], cameraVelocity[2]);

    // Radial velocity (component towards/away from explosion center)
    const normX = distance > 1e-4 ? dx / distance : 0;
    const normY = distance > 1e-4 ? dy / distance : 1;
    const normZ = distance > 1e-4 ? dz / distance : 0;
    const radialVelocity = -(cameraVelocity[0] * normX + cameraVelocity[1] * normY + cameraVelocity[2] * normZ);

    // Speed of sound in warm air approx 343 m/s (normalized simulation scale: 50 units/s)
    const c = 50.0;
    const dopplerPitchFactor = Math.max(0.5, Math.min(2.0, (c + radialVelocity) / c));

    // Low-pass cutoff: 18000 Hz in open air, drops to 350 Hz when submerged inside fire core
    const lowPassCutoff = isInsideCore ? 350.0 + (distance / coreRadius) * 200.0 : Math.max(800.0, 18000.0 / (1.0 + distance * 0.15));

    // Internal combustion rumble boost
    const bassRumbleGain = isInsideCore ? 1.0 : Math.max(0.05, 1.0 / (1.0 + distance * 0.4));

    return {
        distance,
        isInsideCore,
        speed,
        radialVelocity,
        dopplerPitchFactor,
        lowPassCutoff,
        bassRumbleGain
    };
}

describe('Photorealistic 3D Fire Explosion Demo Suite', () => {

    it('verifies Planckian blackbody thermal radiation spectrum from core to perimeter', () => {
        // Core: 5000K (White-hot incandescent)
        const [rCore, gCore, bCore] = evaluateBlackbodyRamp(5000);
        expect(rCore).toBeCloseTo(1.0, 1);
        expect(gCore).toBeGreaterThan(0.7);
        expect(bCore).toBeGreaterThan(0.4);

        // Mid-flame: 2200K (Vibrant Golden Orange)
        const [rMid, gMid, bMid] = evaluateBlackbodyRamp(2200);
        expect(rMid).toBeCloseTo(1.0, 1);
        expect(gMid).toBeGreaterThan(0.4);
        expect(gMid).toBeLessThan(0.75);
        expect(bMid).toBeLessThan(0.2);

        // Outer smoke boundary / embers: 1200K (Deep Crimson)
        const [rRim, gRim, bRim] = evaluateBlackbodyRamp(1200);
        expect(rRim).toBeCloseTo(1.0, 1);
        expect(gRim).toBeLessThan(0.4);
        expect(bRim).toBeCloseTo(0.0, 1);
    });

    it('validates Beer-Lambert volume extinction and internal self-shadowing', () => {
        const stepSize = 0.1;
        const absorption = 3.5;

        // Zero density -> 100% transmission
        const tZero = evaluateBeerLambertTransmittance(0.0, stepSize, absorption);
        expect(tZero).toBe(1.0);

        // Thin smoke density (0.5)
        const tThin = evaluateBeerLambertTransmittance(0.5, stepSize, absorption);
        expect(tThin).toBeLessThan(1.0);
        expect(tThin).toBeGreaterThan(0.8);

        // Dense sooty smoke core (5.0)
        const tDense = evaluateBeerLambertTransmittance(5.0, stepSize, absorption);
        expect(tDense).toBeLessThan(0.2);
    });

    it('computes 3D spatial audio Doppler shift, proximity dampening, and internal core muffling', () => {
        const explosionCenter: [number, number, number] = [0, 2.0, 0];
        const coreRadius = 2.5;

        // 1. Distant observer moving towards explosion
        const telemetryApproaching = computeExplosionAudioTelemetry(
            [0, 2.0, 10.0],
            [0, 0, -10.0], // 10 units/s towards explosion
            explosionCenter,
            coreRadius
        );
        expect(telemetryApproaching.distance).toBe(10.0);
        expect(telemetryApproaching.isInsideCore).toBe(false);
        expect(telemetryApproaching.radialVelocity).toBe(10.0);
        expect(telemetryApproaching.dopplerPitchFactor).toBeGreaterThan(1.1); // Higher pitch on approach
        expect(telemetryApproaching.lowPassCutoff).toBeGreaterThan(5000);

        // 2. Submerged inside fireball core
        const telemetryInside = computeExplosionAudioTelemetry(
            [0, 2.0, 0.5],
            [0, 0, 0],
            explosionCenter,
            coreRadius
        );
        expect(telemetryInside.isInsideCore).toBe(true);
        expect(telemetryInside.lowPassCutoff).toBeLessThan(600); // Heavy resonant muffling inside fire!
        expect(telemetryInside.bassRumbleGain).toBe(1.0); // Maximum sub-bass thump
    });

    it('verifies non-spherical plume velocity shaping and asymmetrical directional lobes', () => {
        const upwardBuoyancy = 0.85;
        const lobeStrength = 0.5;

        // Equator right (+X)
        const [vxRight, vyRight, vzRight] = evaluateNonSphericalPlumeVelocity([1, 0, 0], upwardBuoyancy, lobeStrength);
        // Equator front (+Z)
        const [vxFront, vyFront, vzFront] = evaluateNonSphericalPlumeVelocity([0, 0, 1], upwardBuoyancy, lobeStrength);
        // Pole upward (+Y)
        const [vxUp, vyUp, vzUp] = evaluateNonSphericalPlumeVelocity([0, 1, 0], upwardBuoyancy, lobeStrength);

        // Upward expansion must exceed horizontal expansion (non-spherical mushrooming!)
        expect(vyUp).toBeGreaterThan(Math.abs(vxRight));
        expect(vyUp).toBeGreaterThan(Math.abs(vzFront));

        // Asymmetry: Right (+X) and Front (+Z) magnitudes must differ due to harmonic lobes
        const magRight = Math.hypot(vxRight, vzRight);
        const magFront = Math.hypot(vxFront, vzFront);
        expect(Math.abs(magRight - magFront)).toBeGreaterThan(0.05); // True asymmetry, not a ball!
    });

    it('verifies aerodynamic drag deceleration and graceful dissipation falloff', () => {
        const v0 = 10.0;
        const k = 1.2;

        const at0s = evaluateAerodynamicDeceleration(v0, k, 0.0);
        const at1s = evaluateAerodynamicDeceleration(v0, k, 1.0);
        const at3s = evaluateAerodynamicDeceleration(v0, k, 3.0);

        // Velocity decays exponentially
        expect(at0s.velocity).toBe(10.0);
        expect(at1s.velocity).toBeLessThan(4.0);
        expect(at3s.velocity).toBeLessThan(0.5);

        // Position approaches finite terminal envelope (cushioning)
        const maxDisplacement = v0 / k; // 8.33
        expect(at3s.position).toBeLessThan(maxDisplacement);
        expect(at3s.position).toBeGreaterThan(7.5);

        // Graceful falloff: continuous dissipation without abrupt clipping
        const early = evaluateGracefulParticleFalloff(0.1, 2.0); // 5% age
        const mid = evaluateGracefulParticleFalloff(1.0, 2.0);   // 50% age
        const late = evaluateGracefulParticleFalloff(1.8, 2.0);  // 90% age
        const end = evaluateGracefulParticleFalloff(2.0, 2.0);   // 100% age

        expect(early.alpha).toBeGreaterThan(0.8);
        expect(early.kelvin).toBeGreaterThan(4500); // White hot

        expect(mid.alpha).toBeGreaterThan(0.5);
        expect(mid.kelvin).toBeLessThan(3500); // Orange-gold
        expect(mid.kelvin).toBeGreaterThan(1800);

        expect(late.alpha).toBeLessThan(0.2); // Gracefully faded
        expect(late.alpha).toBeGreaterThan(0.01);
        expect(late.kelvin).toBeLessThan(1200); // Dark crimson embers

        expect(end.alpha).toBeLessThan(0.02); // Smooth zero termination
        expect(end.kelvin).toBeCloseTo(550, 0); // Cool smoke
    });

    it('verifies that the standalone fire explosion HTML demo file exists and contains complete WebGL2 shaders and Web Audio synthesis', () => {
        const demoPath = path.resolve(process.cwd(), 'public/demos/fire-explosion.html');
        expect(fs.existsSync(demoPath)).toBe(true);

        const content = fs.readFileSync(demoPath, 'utf8');

        // Check WebGL2 and single-file zero-dependency architecture
        expect(content).toContain('getContext(\'webgl2\'');
        expect(content).toContain('#version 300 es');

        // Check Simulation & Physics
        expect(content).toMatch(/marchExplosion|particleProgram/);
        expect(content).toContain('curlNoise');
        expect(content).toContain('blackbody');
        expect(content).toContain('beerLambert');

        // Check 3D Fly-Through and Orbit controls
        expect(content).toContain('camera');
        expect(content).toContain('KeyW');
        expect(content).toContain('KeyS');
        expect(content).toContain('KeyA');
        expect(content).toContain('KeyD');

        // Check Web Audio API procedural sound engine
        expect(content).toContain('AudioContext');
        expect(content).toContain('createPanner');
        expect(content).toContain('createBiquadFilter');
        expect(content).toContain('doppler');
    });
});
