/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('Cinematographic Light Path Bounces & Indirect Shaping (C++20)', () => {
    it('compiles and validates diminishing returns budgeting, albedo decoupling, polyboards, negative fill, and indirect clamping in C++20', async () => {
        const compiler = new NativeCppCompilerService();

        const cppSource = `
#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>
#include <cmath>

int main() {
    using namespace scratchbox::lighting::bounce;
    using namespace scratchbox::math;

    // 1. Validate Diminishing Returns Law
    // At albedo 0.45, by bounce 4 the energy is (0.45)^4 = 0.041 (< 5% of initial radiance)
    float e0 = 100.0f;
    float rAvg = 0.45f;
    float e1 = e0 * LightPathBounceBudget::calculateRemainingEnergy(rAvg, 1);
    float e2 = e0 * LightPathBounceBudget::calculateRemainingEnergy(rAvg, 2);
    float e3 = e0 * LightPathBounceBudget::calculateRemainingEnergy(rAvg, 3);
    float e4 = e0 * LightPathBounceBudget::calculateRemainingEnergy(rAvg, 4);

    assert(std::abs(e1 - 45.0f) < 0.1f);
    assert(std::abs(e2 - 20.25f) < 0.1f);
    assert(std::abs(e3 - 9.1125f) < 0.1f);
    assert(e4 < 5.0f); // Under 5%

    // 2. Validate Production Bounce Budget Presets
    LightPathBounceBudget exterior = LightPathBounceBudget::exteriorSunlight();
    assert(exterior.diffuseBounces == 2);
    assert(exterior.volumeBounces == 0);

    LightPathBounceBudget interior = LightPathBounceBudget::interiorArchviz();
    assert(interior.diffuseBounces == 4);
    assert(interior.transmissionBounces == 12);
    assert(interior.transparentBounces == 32);

    LightPathBounceBudget foliage = LightPathBounceBudget::foliageCanopy();
    assert(foliage.transparentBounces == 64);

    // 3. Validate Albedo Decoupler (Color Bleed Tamer)
    // Saturated red wall albedo
    Vec3 saturatedRed(0.95f, 0.05f, 0.05f);

    // Primary camera ray receives full saturated color
    Vec3 camAlbedo = AlbedoDecoupler::evaluatePerceivedAlbedo(saturatedRed, RAY_CAMERA);
    assert(std::abs(camAlbedo.x - 0.95f) < 0.001f);
    assert(std::abs(camAlbedo.y - 0.05f) < 0.001f);

    // Indirect diffuse bounce receives art-directed desaturated color to tame bleeding
    Vec3 bounceAlbedo = AlbedoDecoupler::evaluatePerceivedAlbedo(
        saturatedRed,
        RAY_DIFFUSE_BOUNCE,
        0.35f, // indirectSaturation
        0.75f  // indirectAlbedoMultiplier
    );
    // Green and blue channels must be lifted (desaturated towards gray), and overall scaled
    assert(bounceAlbedo.y > camAlbedo.y);
    assert(bounceAlbedo.x < camAlbedo.x);

    // 4. Validate Architectural Glass Shadow Ray Bypass
    float physicalTrans = 0.90f;
    float cameraTrans = ArchitecturalGlassBypass::evaluateTransmittance(RAY_CAMERA, physicalTrans);
    float shadowTrans = ArchitecturalGlassBypass::evaluateTransmittance(RAY_SHADOW, physicalTrans);

    assert(std::abs(cameraTrans - 0.90f) < 0.001f);
    assert(std::abs(shadowTrans - 1.00f) < 0.001f); // 100% bypass for shadow ray (no caustic waiting)

    // 5. Validate Virtual Polyboard (Positive Bounce Card)
    CinematicBounceCard polyboard;
    polyboard.position = Vec3(50.0f, 10.0f, 0.0f);
    polyboard.normal = Vec3(-1.0f, 0.0f, 0.0f); // Faces negative X
    polyboard.width = 20.0f;
    polyboard.height = 15.0f;
    polyboard.intensity = 1.5f;

    Vec3 receiverPos(10.0f, 10.0f, 0.0f); // 40 units in front of card
    Vec3 receiverNormal(1.0f, 0.0f, 0.0f); // Faces card
    Vec3 incidentKey(100.0f, 95.0f, 90.0f);

    Vec3 bouncedLight = polyboard.evaluateBounceIlluminance(receiverPos, receiverNormal, incidentKey);
    assert(bouncedLight.x > 0.0f);
    assert(bouncedLight.y > 0.0f);
    assert(bouncedLight.z > 0.0f);

    // Receiver facing away receives zero bounce
    Vec3 receiverFacingAway(-1.0f, 0.0f, 0.0f);
    Vec3 zeroBounce = polyboard.evaluateBounceIlluminance(receiverPos, receiverFacingAway, incidentKey);
    assert(zeroBounce.x == 0.0f && zeroBounce.y == 0.0f && zeroBounce.z == 0.0f);

    // 6. Validate Negative Fill Card (Chiaroscuro Depth Sculptor)
    NegativeFillCard negFill;
    negFill.position = Vec3(-50.0f, 10.0f, 0.0f);
    negFill.normal = Vec3(1.0f, 0.0f, 0.0f); // Faces positive X
    negFill.width = 30.0f;
    negFill.height = 30.0f;
    negFill.absorptionStrength = 0.80f;

    // Point facing negative fill card has ambient light absorbed
    Vec3 shadowSidePos(-10.0f, 10.0f, 0.0f);
    Vec3 shadowSideNormal(-1.0f, 0.0f, 0.0f); // Facing neg fill card
    float ambientAtten = negFill.evaluateAmbientAttenuation(shadowSidePos, shadowSideNormal);
    assert(ambientAtten < 1.0f); // Occluded ambient light
    assert(ambientAtten >= 0.2f); // Retains base floor

    // Point facing away from negative fill card remains unattenuated
    Vec3 litSideNormal(1.0f, 0.0f, 0.0f);
    float unatten = negFill.evaluateAmbientAttenuation(shadowSidePos, litSideNormal);
    assert(std::abs(unatten - 1.0f) < 0.001f);

    // 7. Validate Indirect Light Clamping (Firefly Suppression)
    Vec3 directSunSpecular(150.0f, 140.0f, 120.0f);
    Vec3 clampedDirect = IndirectLightClamper::clampRadiance(directSunSpecular, RAY_CAMERA, 0.0f, 15.0f);
    assert(clampedDirect.x == 150.0f); // Direct specular is NOT clamped

    Vec3 indirectFirefly(85.0f, 80.0f, 75.0f); // Rogue sample spike
    Vec3 clampedIndirect = IndirectLightClamper::clampRadiance(indirectFirefly, RAY_DIFFUSE_BOUNCE, 0.0f, 15.0f);
    assert(clampedIndirect.x <= 15.001f); // Indirect spike is clamped to 15.0 max
    assert(clampedIndirect.x > 0.0f);

    std::cout << "SUCCESS: All C++20 cinematographic bounce mechanics validated." << std::endl;
    return 0;
}
`;

        const compileResult = await compiler.compileSource(cppSource);
        expect(compileResult.success).toBe(true);
        expect(compileResult.compilerOutput).not.toContain('error:');
        expect(compileResult.binaryPath).toBeDefined();

        const execResult = await compiler.executeBinary(compileResult.binaryPath!);
        if (execResult.exitCode !== 0) {
            console.error('Execution failed:', execResult.stderr, execResult.stdout);
        }
        expect(execResult.exitCode).toBe(0);
        expect(execResult.stdout).toContain('SUCCESS: All C++20 cinematographic bounce mechanics validated.');
    }, 45000);
});
