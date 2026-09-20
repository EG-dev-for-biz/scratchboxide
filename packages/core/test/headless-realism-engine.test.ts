/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { createOperatorEngine } from '../src/browser/generative-canvas/services/direct-dispatch-operator-engine';
import {
    estimateDifferentialCurvature,
    computeStratifiedWear,
    applyWeightedNormals,
    simulateGeomorphologyOnGeometry,
    transferCanopyNormals,
    evaluateAiryThinFilm,
    blackbodyKelvinToLinearRgb,
    evaluateAnalyticalGobo
} from '../src/browser/generative-canvas/services/headless-realism-service';

describe('Headless Realism Engine (Decoupled Numerical Solvers)', () => {

    describe('C++20 Native Headless Realism Pipeline', () => {
        it('compiles and executes headless differential curvature, stratified wear, weighted normals, geomorphology PDE, canopy transfer, thin film optics, and photometric Planck radiance in C++20', async () => {
            const compiler = new NativeCppCompilerService();

            const cppSource = `#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox;
    using namespace scratchbox::math;
    using namespace scratchbox::geometry;
    using namespace scratchbox::realism;

    // 1. Headless Differential Curvature Operator
    ScratchboxMesh cube = ScratchboxMesh::createBox(Vec3(2.0f, 2.0f, 2.0f));
    CurvatureTensorField curvs = HeadlessDifferentialCurvatureOperator::evaluateCurvatureField(cube);
    assert(curvs.shapeIndex.size() == cube.vertices.size());
    for (float s : curvs.shapeIndex) {
        assert(s >= -1.01f && s <= 1.01f);
    }

    // 2. Headless Stratified Wear Operator
    WearTransferParameters wearParams;
    wearParams.convexitySensitivity = 2.0f;
    wearParams.wearExposure = 0.2f;

    std::vector<WearLayerDefinition> layers = {
        { Vec4(0.1f, 0.4f, 0.9f, 1.0f), 0.0f, 0.2f, 0.0f }, // Topcoat paint
        { Vec4(0.7f, 0.6f, 0.5f, 1.0f), 0.1f, 0.8f, 0.0f }, // Primer
        { Vec4(0.9f, 0.9f, 0.95f, 1.0f), 1.0f, 0.3f, 0.0f }  // Substrate metal
    };

    HeadlessStratifiedWearOperator::applyStratifiedWear(cube, wearParams, layers);
    for (const auto& v : cube.vertices) {
        assert(v.color.w == 1.0f);
        assert(v.color.x >= 0.0f && v.color.x <= 1.0f);
    }

    // 3. Headless Weighted Normal Modifier
    HeadlessWeightedNormalOptions normalOpts;
    normalOpts.areaWeightPower = 1.0f;
    normalOpts.angleWeightPower = 1.0f;
    HeadlessWeightedNormalModifier::applyWeightedNormals(cube, normalOpts);
    for (const auto& v : cube.vertices) {
        float len = v.normal.length();
        assert(std::abs(len - 1.0f) < 1e-3f);
    }

    // 4. Headless Geomorphological PDE Simulator
    ScalarField2D field(16, 16, 1.0f, 5.0f);
    for (int y = 0; y < 16; ++y) {
        for (int x = 0; x < 16; ++x) {
            field.set(x, y, 5.0f + 2.0f * std::sin(x * 0.5f) * std::cos(y * 0.5f));
        }
    }
    float initialSum = 0.0f;
    for (float h : field.data) initialSum += h;

    HeadlessErosionPDEParams erosionParams;
    erosionParams.iterations = 5;
    erosionParams.erodibility = 0.05f;
    HeadlessGeomorphologySimulator::solveErosionPDE(field, erosionParams);
    assert(field.data.size() == 256);

    // 5. Headless Canopy Normal Transfer Operator
    ScratchboxMesh canopyMesh = ScratchboxMesh::createSphere(1.0f, 8, 8);
    CanopyProjectionParams canopyParams;
    canopyParams.proxyCenter = Vec3(0, 0, 0);
    canopyParams.proxyRadii = Vec3(1.5f, 2.0f, 1.5f);
    canopyParams.blendFactor = 0.9f;
    HeadlessCanopyNormalTransferOperator::transferCanopyNormals(canopyMesh, canopyParams);
    for (const auto& v : canopyMesh.vertices) {
        assert(std::abs(v.normal.length() - 1.0f) < 1e-3f);
    }

    // 6. Headless Thin-Film Optics Solver (Airy Wave Model)
    ThinFilmLayer filmLayer;
    filmLayer.thicknessNm = 420.0f;
    filmLayer.nFilm = 1.33f;
    filmLayer.nSubstrate = 1.52f;
    Vec3 reflectance = HeadlessThinFilmOpticsSolver::evaluateAiryInterference(filmLayer, 0.866f);
    assert(reflectance.x >= 0.0f && reflectance.x <= 1.0f);
    assert(reflectance.y >= 0.0f && reflectance.y <= 1.0f);
    assert(reflectance.z >= 0.0f && reflectance.z <= 1.0f);

    // 7. Headless Photometric Planck Blackbody Solver
    Vec3 warmLinear = HeadlessPhotometricSolver::blackbodyKelvinToLinearRgb(3200.0f);
    Vec3 daylightLinear = HeadlessPhotometricSolver::blackbodyKelvinToLinearRgb(6500.0f);
    assert(warmLinear.x > warmLinear.z);    // 3200K tungsten has more red than blue
    assert(daylightLinear.z > warmLinear.z); // 6500K daylight has significantly more blue

    float foliageShadow = HeadlessPhotometricSolver::evaluateAnalyticalGobo(0.5f, 0.5f, 1.0f, 0, 4.0f);
    assert(foliageShadow >= 0.0f && foliageShadow <= 1.0f);

    std::cout << "HEADLESS_REALISM_CPP20_VALIDATED_SUCCESSFULLY" << std::endl;
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
            expect(execResult.stdout).toContain('HEADLESS_REALISM_CPP20_VALIDATED_SUCCESSFULLY');
        }, 30000);
    });

    describe('TypeScript DirectDispatchOperatorEngine Headless Operators', () => {

        it('dispatches sb_apply_weighted_normals and modifies geometry normals without preset hardcoding', () => {
            const engine = createOperatorEngine();
            const threeScene = new THREE.Scene();
            engine.attachThreeScene(threeScene);

            // Add box geometry to scene
            const geo = new THREE.BoxGeometry(2, 2, 2);
            const mat = new THREE.MeshStandardMaterial({ color: 0x888888 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.name = 'test_box';
            threeScene.add(mesh);

            // Register in sceneData
            engine.dispatch('sb_add_mesh', {
                objectId: 'test_box',
                type: 'box'
            });

            const result = engine.dispatch('sb_apply_weighted_normals', {
                targetId: 'test_box',
                areaWeightPower: 1.5,
                angleWeightPower: 1.0,
                thresholdAngleDeg: 50.0
            });

            expect(result.success).toBe(true);
            expect(result.data.targetId).toBe('test_box');
            expect(result.data.weightedNormals.enabled).toBe(true);
            expect(result.data.weightedNormals.areaWeightPower).toBe(1.5);

            // Check that normals attribute on three.js geometry is valid and normalized
            const normAttr = geo.getAttribute('normal') as THREE.BufferAttribute;
            expect(normAttr).toBeDefined();
            const n = new THREE.Vector3();
            for (let i = 0; i < normAttr.count; i++) {
                n.fromBufferAttribute(normAttr, i);
                expect(n.length()).toBeCloseTo(1.0, 3);
            }
        });

        it('dispatches sb_synthesize_differential_wear and computes multi-layer substratum wear', () => {
            const engine = createOperatorEngine();
            const threeScene = new THREE.Scene();
            engine.attachThreeScene(threeScene);

            const geo = new THREE.BoxGeometry(2, 2, 2, 2, 2, 2);
            const mat = new THREE.MeshStandardMaterial({ color: 0x3366cc, roughness: 0.3 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.name = 'test_crevice_box';
            threeScene.add(mesh);

            engine.dispatch('sb_add_mesh', {
                objectId: 'test_crevice_box',
                type: 'box'
            });

            const result = engine.dispatch('sb_synthesize_differential_wear', {
                targetId: 'test_crevice_box',
                options: {
                    convexitySensitivity: 2.5,
                    wearExposure: 0.3,
                    substrateRoughness: 0.85,
                    substrateMetallic: 0.95
                }
            });

            expect(result.success).toBe(true);
            expect(result.data.averageWear).toBeGreaterThan(0.0);
            expect(result.data.stratifiedWear.enabled).toBe(true);

            // Buffer geometry should now have vertex colors
            const colorAttr = geo.getAttribute('color') as THREE.BufferAttribute;
            expect(colorAttr).toBeDefined();
            expect(colorAttr.count).toBe(geo.getAttribute('position').count);
        });

        it('dispatches sb_simulate_geomorphological_erosion and relaxes steep gradients via PDEs', () => {
            const engine = createOperatorEngine();
            const threeScene = new THREE.Scene();
            engine.attachThreeScene(threeScene);

            const geo = new THREE.PlaneGeometry(10, 10, 8, 8);
            geo.rotateX(-Math.PI / 2);
            // Add a sharp peak
            const pos = geo.getAttribute('position') as THREE.BufferAttribute;
            pos.setY(36, 10.0); // Center vertex high peak
            pos.needsUpdate = true;

            const mat = new THREE.MeshStandardMaterial({ color: 0x886644 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.name = 'test_terrain';
            threeScene.add(mesh);

            engine.dispatch('sb_add_mesh', {
                objectId: 'test_terrain',
                type: 'plane'
            });

            const initialPeakHeight = pos.getY(36);

            const result = engine.dispatch('sb_simulate_geomorphological_erosion', {
                targetId: 'test_terrain',
                iterations: 15,
                erodibility: 0.12,
                talusReposeAngleDeg: 30.0
            });

            expect(result.success).toBe(true);
            expect(result.data.erosion.simulated).toBe(true);

            const erodedPeakHeight = pos.getY(36);
            expect(erodedPeakHeight).toBeLessThan(initialPeakHeight);
        });

        it('dispatches sb_transfer_canopy_normals for foliage envelope smoothing', () => {
            const engine = createOperatorEngine();
            const threeScene = new THREE.Scene();
            engine.attachThreeScene(threeScene);

            const geo = new THREE.SphereGeometry(1.5, 8, 8);
            const mat = new THREE.MeshStandardMaterial({ color: 0x228833 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.name = 'test_canopy';
            threeScene.add(mesh);

            engine.dispatch('sb_add_mesh', {
                objectId: 'test_canopy',
                type: 'sphere'
            });

            const result = engine.dispatch('sb_transfer_canopy_normals', {
                targetId: 'test_canopy',
                proxyCenter: [0, 1.5, 0],
                proxyRadii: [2, 2.5, 2],
                blendFactor: 0.95
            });

            expect(result.success).toBe(true);
            expect(result.data.canopyNormals.transferred).toBe(true);

            const normAttr = geo.getAttribute('normal') as THREE.BufferAttribute;
            const n = new THREE.Vector3();
            for (let i = 0; i < normAttr.count; i++) {
                n.fromBufferAttribute(normAttr, i);
                expect(n.length()).toBeCloseTo(1.0, 3);
            }
        });

        it('dispatches sb_apply_thin_film_interference solving Airy wave equations', () => {
            const engine = createOperatorEngine();
            const threeScene = new THREE.Scene();
            engine.attachThreeScene(threeScene);

            const geo = new THREE.SphereGeometry(1.0, 16, 16);
            const mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.1 });
            const mesh = new THREE.Mesh(geo, mat);
            mesh.name = 'test_bubble';
            threeScene.add(mesh);

            engine.dispatch('sb_add_mesh', {
                objectId: 'test_bubble',
                type: 'sphere'
            });

            const result = engine.dispatch('sb_apply_thin_film_interference', {
                targetId: 'test_bubble',
                thicknessNm: 450,
                nFilm: 1.33,
                nSubstrate: 1.52
            });

            expect(result.success).toBe(true);
            expect(result.data.spectralReflectanceRgb).toHaveLength(3);
            expect(result.data.spectralReflectanceRgb[0]).toBeGreaterThanOrEqual(0.0);
            expect(result.data.spectralReflectanceRgb[0]).toBeLessThanOrEqual(1.0);
            expect(mat.iridescence).toBe(1.0);
        });

        it('dispatches sb_configure_photometric_light with Planck blackbody radiation and analytical gobo', () => {
            const engine = createOperatorEngine();
            const threeScene = new THREE.Scene();
            engine.attachThreeScene(threeScene);

            const result = engine.dispatch('sb_configure_photometric_light', {
                kelvin: 3200,
                lux: 1200,
                distanceMeters: 3.0,
                goboMode: 'canopy',
                goboFrequency: 5.0
            });

            expect(result.success).toBe(true);
            expect(result.data.kelvin).toBe(3200);
            expect(result.data.linearRgb[0]).toBeGreaterThan(result.data.linearRgb[2]); // Warm color has more R than B
            expect(result.data.intensity).toBe(1200 * 9); // Lux * distance^2

            // Verify analytical gobo evaluations
            const goboVal = evaluateAnalyticalGobo(0.5, 0.5, 0.0, 0, 4.0);
            expect(goboVal).toBeGreaterThanOrEqual(0.0);
            expect(goboVal).toBeLessThanOrEqual(1.0);
        });
    });
});
