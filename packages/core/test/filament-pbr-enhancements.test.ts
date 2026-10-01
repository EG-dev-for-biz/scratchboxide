/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import {
    evaluateGgxEnergyCompensation,
    applyFilamentEnergyCompensation,
    evaluateCharlieSheen,
    applyFilamentClothSheen,
    projectEquirectangularToSH
} from '../src/browser/generative-canvas/services/headless-realism-service';
import { SphericalHarmonics9 } from '../src/browser/generative-canvas/services/atmosphere/volumetric-participating-media';
import { AtmosphereService } from '../src/browser/generative-canvas/services/atmosphere/AtmosphereService';

describe('Filament PBR & Lighting Enhancements', () => {

    describe('1. Multi-Scattering GGX Energy Compensation', () => {
        it('preserves energy on smooth surfaces with near-unity compensation factor', () => {
            const smooth = evaluateGgxEnergyCompensation(0.05, 0.8, [0.04, 0.04, 0.04]);
            expect(smooth.directionalAlbedo).toBeGreaterThan(0.95);
            expect(smooth.energyFactor[0]).toBeCloseTo(1.0, 1);
            expect(smooth.energyFactor[1]).toBeCloseTo(1.0, 1);
            expect(smooth.energyFactor[2]).toBeCloseTo(1.0, 1);
        });

        it('restores lost energy on high roughness surfaces and grazing angles', () => {
            const rough = evaluateGgxEnergyCompensation(0.9, 0.1, [0.04, 0.04, 0.04]);
            // On high roughness, directional albedo drops
            expect(rough.directionalAlbedo).toBeLessThan(0.7);
            // Energy compensation factor is > 1.0 to restore lost multi-bounce photons
            expect(rough.energyFactor[0]).toBeGreaterThan(1.01);
            expect(rough.energyFactor[1]).toBeGreaterThan(1.01);
            expect(rough.energyFactor[2]).toBeGreaterThan(1.01);

            // On rough conductive metals (F0 ~ 0.9), compensation is even higher
            const roughGold = evaluateGgxEnergyCompensation(0.9, 0.2, [1.0, 0.76, 0.33]);
            expect(roughGold.energyFactor[0]).toBeGreaterThan(1.3);
        });

        it('patches Three.js material shader chunks via onBeforeCompile', () => {
            const geo = new THREE.BoxGeometry(1, 1, 1);
            const mat = new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.5 });
            const mesh = new THREE.Mesh(geo, mat);

            applyFilamentEnergyCompensation(mesh);
            expect(typeof mat.onBeforeCompile).toBe('function');

            const mockShader: any = {
                fragmentShader: 'void main() { #include <lights_fragment_end> }'
            };
            mat.onBeforeCompile(mockShader, {} as any);

            expect(mockShader.fragmentShader).toContain('Filament Multi-Scattering GGX Energy Compensation');
            expect(mockShader.fragmentShader).toContain('sb_energyCompensation');
            expect(mockShader.fragmentShader).toContain('reflectedLight.directSpecular *= sb_energyCompensation');
        });
    });

    describe('2. Filament Cloth & Micro-Velvet Sheen BRDF (Charlie NDF)', () => {
        it('evaluates Charlie distribution and cloth visibility across grazing angles', () => {
            const sheenColor: [number, number, number] = [0.95, 0.85, 0.6];
            const evalNormal = evaluateCharlieSheen(0.9, 0.8, 0.8, {
                sheenRoughness: 0.4,
                sheenColor
            });

            expect(evalNormal.sheenSpecular[0]).toBeGreaterThan(0);
            expect(evalNormal.sheenSpecular[1]).toBeGreaterThan(0);
            expect(evalNormal.sheenSpecular[2]).toBeGreaterThan(0);

            // Velvet grazing edge highlight check
            const evalGrazing = evaluateCharlieSheen(0.3, 0.1, 0.1, {
                sheenRoughness: 0.4,
                sheenColor
            });
            expect(evalGrazing.sheenSpecular[0]).toBeGreaterThan(0);
        });

        it('evaluates wrap-diffuse fabric subsurface scatter for light transmission', () => {
            const evalSubsurface = evaluateCharlieSheen(0.5, 0.5, 0.0, {
                sheenRoughness: 0.5,
                subsurfaceColor: [0.8, 0.2, 0.1],
                subsurfaceWrap: 0.5
            });

            // Even when NoL = 0, wrap-diffuse produces forward transmission
            expect(evalSubsurface.subsurfaceDiffuse[0]).toBeGreaterThan(0.1);
            expect(evalSubsurface.subsurfaceDiffuse[1]).toBeGreaterThan(0.02);
            expect(evalSubsurface.subsurfaceDiffuse[2]).toBeGreaterThan(0.01);
        });

        it('configures MeshPhysicalMaterial with Charlie sheen uniforms and shader hooks', () => {
            const geo = new THREE.SphereGeometry(1, 16, 16);
            const mat = new THREE.MeshStandardMaterial({ roughness: 0.6 });
            const mesh = new THREE.Mesh(geo, mat);

            applyFilamentClothSheen(mesh, {
                sheenColor: [0.9, 0.8, 0.7],
                sheenRoughness: 0.45,
                subsurfaceColor: [0.4, 0.1, 0.05],
                subsurfaceWrap: 0.6
            });

            // Automatically upgraded to MeshPhysicalMaterial
            expect(mesh.material instanceof THREE.MeshPhysicalMaterial).toBe(true);
            const physMat = mesh.material as THREE.MeshPhysicalMaterial;
            expect(physMat.sheen).toBe(1.0);
            expect(physMat.sheenRoughness).toBe(0.45);

            const mockShader: any = {
                uniforms: {},
                fragmentShader: 'void main() { #include <lights_fragment_end> }'
            };
            physMat.onBeforeCompile(mockShader, {} as any);

            expect(mockShader.uniforms.uClothSheenColor).toBeDefined();
            expect(mockShader.uniforms.uClothSubsurfaceColor).toBeDefined();
            expect(mockShader.fragmentShader).toContain('Filament Charlie Cloth Sheen');
            expect(mockShader.fragmentShader).toContain('cloth_D');
            expect(mockShader.fragmentShader).toContain('cloth_V');
        });
    });

    describe('3. Filament cmgen-Style Analytical Spherical Harmonics Projector', () => {
        it('integrates a uniform environment map and recovers exact analytical constants', () => {
            // A uniform white sphere of radiance 1.0
            const W = 32;
            const H = 16;
            const uniformBuffer = new Float32Array(W * H * 3);
            uniformBuffer.fill(1.0);

            const sh = projectEquirectangularToSH(uniformBuffer, W, H, 3);

            // Ground truth:
            // L00 = int_S2 1 * Y00 dOmega = 4 * pi * 0.282095 = 2 * sqrt(pi) ~ 3.5449
            expect(sh.coeffs[0][0]).toBeCloseTo(3.5449, 1);
            expect(sh.coeffs[0][1]).toBeCloseTo(3.5449, 1);
            expect(sh.coeffs[0][2]).toBeCloseTo(3.5449, 1);

            // By symmetry, all higher-order harmonic coefficients for a uniform field must be ~0
            for (let i = 1; i < 9; ++i) {
                expect(Math.abs(sh.coeffs[i][0])).toBeLessThan(0.08);
                expect(Math.abs(sh.coeffs[i][1])).toBeLessThan(0.08);
                expect(Math.abs(sh.coeffs[i][2])).toBeLessThan(0.08);
            }

            // Irradiance for a uniform environment of unit radiance is PI ~ 3.14159
            const normalUp: [number, number, number] = [0, 1, 0];
            const irrUp = sh.evaluateIrradiance(normalUp);
            expect(irrUp[0]).toBeCloseTo(Math.PI, 1);
            expect(irrUp[1]).toBeCloseTo(Math.PI, 1);
            expect(irrUp[2]).toBeCloseTo(Math.PI, 1);

            const normalSide: [number, number, number] = [1, 0, 0];
            const irrSide = sh.evaluateIrradiance(normalSide);
            expect(irrSide[0]).toBeCloseTo(Math.PI, 1);
        });

        it('AtmosphereService exposes projectEquirectangularToSH static method', () => {
            const data = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
            const sh = AtmosphereService.projectEquirectangularToSH(data, 2, 2, 3);
            expect(sh instanceof SphericalHarmonics9).toBe(true);
            expect(sh.coeffs.length).toBe(9);
        });
    });

    describe('4. C++20 Native Engine Compilation & Execution', () => {
        it('compiles and executes Filament Multi-Scattering GGX, Charlie Sheen, and cmgen SH Projector in Apple Clang C++20', async () => {
            const compiler = new NativeCppCompilerService();

            const cppSource = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <cassert>

int main() {
    using namespace scratchbox;
    using namespace scratchbox::math;
    using namespace scratchbox::realism;
    using namespace scratchbox::ibl;

    // 1. Multi-Scattering GGX Compensation
    auto roughResult = HeadlessGgxEnergyCompensationOperator::evaluate(0.9f, 0.1f, Vec3(0.04f, 0.04f, 0.04f));
    assert(roughResult.directionalAlbedo < 0.7f);
    assert(roughResult.energyFactor.x > 1.01f);

    auto smoothResult = HeadlessGgxEnergyCompensationOperator::evaluate(0.05f, 0.8f, Vec3(0.04f, 0.04f, 0.04f));
    assert(smoothResult.directionalAlbedo > 0.95f);
    assert(smoothResult.energyFactor.x < 1.01f);

    // 2. Charlie Cloth & Velvet Sheen
    ClothSheenParameters clothParams;
    clothParams.roughness = 0.4f;
    clothParams.sheenColor = Vec3(0.95f, 0.85f, 0.6f);
    clothParams.subsurfaceColor = Vec3(0.5f, 0.2f, 0.1f);
    clothParams.subsurfaceWrap = 0.5f;

    auto sheenEval = HeadlessClothSheenOperator::evaluate(0.8f, 0.8f, 0.8f, clothParams);
    assert(sheenEval.sheenSpecular.x > 0.0f);
    assert(sheenEval.subsurfaceDiffuse.x > 0.0f);

    // 3. Filament cmgen-style Spherical Harmonics Projection
    const int W = 16;
    const int H = 8;
    std::vector<float> uniformSky(W * H * 3, 1.0f);

    SphericalHarmonics9 sh = SphericalHarmonics9::projectEquirectangular(uniformSky.data(), W, H, 3);
    // L00 should be approx 2 * sqrt(pi) ~ 3.54
    assert(std::abs(sh.L[0].x - 3.5449f) < 0.3f);

    // Evaluated irradiance on unit sphere should be approx PI ~ 3.14
    Vec3 irr = sh.evaluateIrradiance(Vec3(0, 1, 0));
    assert(std::abs(irr.x - 3.14159f) < 0.3f);

    std::cout << "FILAMENT_PBR_CPP20_SUCCESS" << std::endl;
    return 0;
}
`;

            const compileResult = await compiler.compileSource(cppSource);
            if (!compileResult.success) {
                console.error('Compiler error:', compileResult.errorMessage);
            }
            expect(compileResult.success).toBe(true);
            expect(compileResult.binaryPath).toBeDefined();

            const execResult = await compiler.executeBinary(compileResult.binaryPath!);
            expect(execResult.exitCode).toBe(0);
            expect(execResult.stdout).toContain('FILAMENT_PBR_CPP20_SUCCESS');
        }, 30000);
    });
});
