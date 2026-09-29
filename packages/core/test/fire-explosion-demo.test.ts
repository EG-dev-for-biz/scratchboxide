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

    it('verifies that the standalone fire explosion HTML demo file exists and contains complete WebGL2 shaders and Web Audio synthesis', () => {
        const demoPath = path.resolve(process.cwd(), 'public/demos/fire-explosion.html');
        expect(fs.existsSync(demoPath)).toBe(true);

        const content = fs.readFileSync(demoPath, 'utf8');

        // Check WebGL2 and single-file zero-dependency architecture
        expect(content).toContain('getContext(\'webgl2\'');
        expect(content).toContain('#version 300 es');

        // Check Volumetric Raymarching & Physics
        expect(content).toContain('marchExplosion');
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
