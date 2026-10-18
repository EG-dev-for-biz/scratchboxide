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
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
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
    evaluateAnalyticalGobo,
    synthesizeMoistureRunoff,
    applyNormalBevel,
    evaluateAgXTonemapping,
    applyBurleySubsurfaceScattering
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

    // 8. Headless Dynamic Gravity Moisture Runoff Operator
    MoistureRunoffParams moistureParams;
    moistureParams.runoffIntensity = 0.8f;
    moistureParams.creviceAccumulation = 0.9f;
    MoistureRunoffResult runoffRes = HeadlessMoistureRunoffOperator::applyMoistureRunoff(cube, moistureParams);
    assert(runoffRes.moistureLevels.size() == cube.vertices.size());
    for (float m : runoffRes.moistureLevels) {
        assert(m >= 0.0f && m <= 1.0f);
    }

    // 9. Headless Analytical Edge-Normal Fillet Bevel Operator
    EdgeFilletBevelParams bevelParams;
    bevelParams.thresholdAngleDeg = 45.0f;
    bevelParams.maxAngleDeg = 135.0f;
    HeadlessEdgeFilletBevelOperator::applyEdgeFilletBevel(cube, bevelParams);
    for (const auto& v : cube.vertices) {
        assert(std::abs(v.normal.length() - 1.0f) < 1e-3f);
    }

    // 10. Headless AgX Photographic Log Tone Curve Operator
    AgXParams agxParams;
    agxParams.exposure = 1.5f;
    Vec3 hdrColor(5.0f, 2.0f, 0.5f);
    Vec3 agxOut = HeadlessAgXTonemappingOperator::evaluateAgX(hdrColor, agxParams);
    assert(agxOut.x >= 0.0f && agxOut.x <= 1.0f);
    assert(agxOut.y >= 0.0f && agxOut.y <= 1.0f);
    assert(agxOut.z >= 0.0f && agxOut.z <= 1.0f);

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

        /** Engine with a live Three.js scene holding `mesh`, plus a matching customMeshes record. */
        function engineWithLiveMesh(mesh: THREE.Mesh) {
            const engine = createOperatorEngine({
                customMeshes: [{ id: mesh.name, name: mesh.name, type: 'custom', position: [0, 0, 0] } as any]
            });
            const threeScene = new THREE.Scene();
            threeScene.add(mesh);
            engine.attachThreeScene(threeScene);
            return engine;
        }

        const LIVE_MESH_OPERATORS: Array<[string, Record<string, unknown>]> = [
            ['sb_apply_weighted_normals', {}],
            ['sb_synthesize_differential_wear', {}],
            ['sb_simulate_geomorphological_erosion', {}],
            ['sb_transfer_canopy_normals', {}],
            ['sb_apply_thin_film_interference', {}],
            ['sb_synthesize_moisture_runoff', {}],
            ['sb_apply_normal_bevel', {}],
            ['sb_apply_subsurface_scattering', {}]
        ];

        it('fails with not_available_here when the target has no live viewport mesh', () => {
            for (const [name, extra] of LIVE_MESH_OPERATORS) {
                // Record exists, no viewport attached.
                const engine = createOperatorEngine({ customMeshes: [{ id: 'record_only', name: 'record_only', type: 'box' } as any] });
                const res = engine.dispatch(name, { targetId: 'record_only', ...extra });
                expect(res.success, name).toBe(false);
                expect(res.errorCode, name).toBe('not_available_here');

                // Viewport attached, but it holds no mesh for this record.
                engine.attachThreeScene(new THREE.Scene());
                const res2 = engine.dispatch(name, { targetId: 'record_only', ...extra });
                expect(res2.success, name).toBe(false);
                expect(res2.errorCode, name).toBe('not_available_here');

                // Nothing written into the record.
                expect(Object.keys(engine.getSceneData().customMeshes![0]).sort(), name).toEqual(['id', 'name', 'type']);
            }
        });

        it('no longer registers the photometric light and AgX tonemapping operators', () => {
            const engine = createOperatorEngine();
            for (const name of ['sb_configure_photometric_light', 'sb_apply_agx_tonemapping']) {
                expect(engine.getOperator(name)).toBeUndefined();
                expect(engine.dispatch(name, {}).success).toBe(false);
            }
        });

        it('sb_apply_weighted_normals recomputes normals from the faces of the live mesh', () => {
            const geo = new THREE.SphereGeometry(1, 16, 12);
            // Corrupt the normals: every one points along +Z.
            const corrupt = geo.getAttribute('normal') as THREE.BufferAttribute;
            for (let i = 0; i < corrupt.count; i++) corrupt.setXYZ(i, 0, 0, 1);
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x888888 }));
            mesh.name = 'test_sphere';
            const engine = engineWithLiveMesh(mesh);

            const result = engine.dispatch('sb_apply_weighted_normals', {
                targetId: 'test_sphere',
                areaWeightPower: 1.5,
                angleWeightPower: 1.0,
                keepSharpEdges: false
            });
            expect(result.success).toBe(true);
            expect(result.data.vertexCount).toBe(geo.getAttribute('position').count);

            // The edit lands on a copy that is swapped in; the old geometry is left as it was (for undo).
            expect(mesh.geometry).not.toBe(geo);
            expect(corrupt.getZ(0)).toBe(1);

            const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
            const nrm = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
            const n = new THREE.Vector3();
            const radial = new THREE.Vector3();
            // SphereGeometry leaves one pole vertex at each end unused by any triangle; check the vertices faces use.
            const used = new Set<number>(Array.from(mesh.geometry.index!.array));
            expect(used.size).toBeGreaterThan(nrm.count - 3);
            for (const i of used) {
                n.fromBufferAttribute(nrm, i);
                radial.fromBufferAttribute(pos, i).normalize();
                expect(n.length()).toBeCloseTo(1.0, 3);
                // Face-weighted normals of a sphere point outward along the radius.
                expect(n.dot(radial)).toBeGreaterThan(0.95);
            }
        });

        it('sb_apply_weighted_normals keeps the hard edges of a box sharp', () => {
            const geo = new THREE.BoxGeometry(2, 2, 2, 2, 2, 2);
            const before = (geo.getAttribute('normal') as THREE.BufferAttribute).array.slice();
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
            mesh.name = 'test_box';
            const engine = engineWithLiveMesh(mesh);

            const result = engine.dispatch('sb_apply_weighted_normals', { targetId: 'test_box', thresholdAngleDeg: 50 });
            expect(result.success).toBe(true);
            const after = (mesh.geometry.getAttribute('normal') as THREE.BufferAttribute).array;
            for (let i = 0; i < after.length; i++) expect(after[i]).toBeCloseTo(before[i], 5);
        });

        it('sb_synthesize_differential_wear paints layered wear into vertex colors and turns vertex colors on', () => {
            const run = (wearExposure: number) => {
                const material = new THREE.MeshStandardMaterial({ color: 0x3366cc, roughness: 0.3 });
                const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), material);
                mesh.name = 'worn_sphere';
                const engine = engineWithLiveMesh(mesh);
                const result = engine.dispatch('sb_synthesize_differential_wear', {
                    targetId: 'worn_sphere',
                    options: { wearExposure, microNoiseScale: 0 }
                });
                return { result, mesh, material };
            };

            const fresh = run(-3);
            expect(fresh.result.success).toBe(true);
            expect(fresh.result.data.vertexCount).toBe(fresh.mesh.geometry.getAttribute('position').count);
            expect(fresh.result.data.averageWear).toBeLessThan(0.01);
            // Material swapped for a copy with vertex colors on; the original is unchanged.
            expect(fresh.mesh.material).not.toBe(fresh.material);
            expect((fresh.mesh.material as THREE.Material).vertexColors).toBe(true);
            expect(fresh.material.vertexColors).toBe(false);
            const freshColors = fresh.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
            expect(freshColors.itemSize).toBe(4);
            expect(freshColors.count).toBe(fresh.mesh.geometry.getAttribute('position').count);
            // Unworn: the default blue topcoat.
            expect(freshColors.getX(0)).toBeCloseTo(0.15, 2);
            expect(freshColors.getZ(0)).toBeCloseTo(0.85, 2);

            const worn = run(3);
            expect(worn.result.data.averageWear).toBeGreaterThan(0.99);
            const wornColors = worn.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
            // Worn through to the default substrate metal.
            expect(wornColors.getX(0)).toBeCloseTo(0.88, 2);
            expect(wornColors.getZ(0)).toBeCloseTo(0.90, 2);
        });

        it('sb_simulate_geomorphological_erosion lowers a sharp peak and reports the real height change', () => {
            const geo = new THREE.PlaneGeometry(10, 10, 8, 8);
            geo.rotateX(-Math.PI / 2);
            const pos = geo.getAttribute('position') as THREE.BufferAttribute;
            const centre = 40; // row 4, column 4 of the 9x9 grid
            expect(pos.getX(centre)).toBeCloseTo(0, 5);
            expect(pos.getZ(centre)).toBeCloseTo(0, 5);
            pos.setY(centre, 10.0);
            pos.needsUpdate = true;
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x886644 }));
            mesh.name = 'test_terrain';
            const engine = engineWithLiveMesh(mesh);

            const result = engine.dispatch('sb_simulate_geomorphological_erosion', {
                targetId: 'test_terrain',
                iterations: 15,
                erodibility: 0.12,
                talusReposeAngleDeg: 30.0
            });
            expect(result.success).toBe(true);
            expect(result.data.iterations).toBe(15);
            expect(result.data.vertexCount).toBe(81);

            const livePos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
            const drop = 10.0 - livePos.getY(centre);
            expect(drop).toBeGreaterThan(0.5);
            expect(result.data.maxHeightChange).toBeGreaterThanOrEqual(drop - 1e-6);
            expect(result.data.meanHeightChange).toBeGreaterThan(0);
            expect(result.data.meanHeightChange).toBeLessThan(result.data.maxHeightChange);
            // Plan positions are untouched; only heights move.
            expect(livePos.getX(centre)).toBeCloseTo(0, 5);
            expect(livePos.getZ(centre)).toBeCloseTo(0, 5);
            // No flag record is written into the scene.
            expect((engine.getSceneData().customMeshes![0] as any).erosion).toBeUndefined();
        });

        it('sb_simulate_geomorphological_erosion leaves a flat plane flat', () => {
            const geo = new THREE.PlaneGeometry(10, 10, 6, 6);
            geo.rotateX(-Math.PI / 2);
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
            mesh.name = 'flat_terrain';
            const engine = engineWithLiveMesh(mesh);
            const result = engine.dispatch('sb_simulate_geomorphological_erosion', { targetId: 'flat_terrain', iterations: 10 });
            expect(result.success).toBe(true);
            expect(result.data.maxHeightChange).toBeLessThan(1e-9);
        });

        it('sb_transfer_canopy_normals blends normals toward the envelope normals', () => {
            const geo = new THREE.SphereGeometry(1.5, 8, 8);
            const original = (geo.getAttribute('normal') as THREE.BufferAttribute).array.slice();
            const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x228833 }));
            mesh.name = 'test_canopy';
            const engine = engineWithLiveMesh(mesh);

            const proxyCenter: [number, number, number] = [0, 1.5, 0];
            const proxyRadii: [number, number, number] = [2, 2.5, 2];
            const blend = 0.95;
            const skyBias = 0.25;
            const result = engine.dispatch('sb_transfer_canopy_normals', {
                targetId: 'test_canopy', proxyCenter, proxyRadii, blendFactor: blend, skyHemisphereBias: skyBias
            });
            expect(result.success).toBe(true);
            expect(mesh.geometry).not.toBe(geo);

            const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
            const nrm = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
            const p = new THREE.Vector3();
            const expected = new THREE.Vector3();
            const proxy = new THREE.Vector3();
            const got = new THREE.Vector3();
            let changed = 0;
            for (let i = 0; i < pos.count; i++) {
                p.fromBufferAttribute(pos, i);
                proxy.set((p.x - proxyCenter[0]) / proxyRadii[0], (p.y - proxyCenter[1]) / proxyRadii[1], (p.z - proxyCenter[2]) / proxyRadii[2]).normalize();
                proxy.y += skyBias;
                proxy.normalize();
                expected.set(original[i * 3], original[i * 3 + 1], original[i * 3 + 2]).lerp(proxy, blend).normalize();
                got.fromBufferAttribute(nrm, i);
                expect(got.distanceTo(expected)).toBeLessThan(1e-5);
                if (Math.abs(got.x - original[i * 3]) + Math.abs(got.y - original[i * 3 + 1]) + Math.abs(got.z - original[i * 3 + 2]) > 0.05) changed++;
            }
            // The envelope is offset from the sphere, so most normals turn.
            expect(changed).toBeGreaterThan(pos.count / 2);
        });

        it('sb_apply_thin_film_interference turns on physical iridescence with the Airy film', () => {
            const original = new THREE.MeshStandardMaterial({ color: 0xff8800, roughness: 0.1 });
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.0, 16, 16), original);
            mesh.name = 'test_bubble';
            const engine = engineWithLiveMesh(mesh);

            const result = engine.dispatch('sb_apply_thin_film_interference', {
                targetId: 'test_bubble',
                thicknessNm: 450,
                nFilm: 1.33,
                nSubstrate: 1.52
            });
            expect(result.success).toBe(true);
            const expected = evaluateAiryThinFilm(450, 0.866, 1.33, 1.52, 1.0);
            expect(result.data.spectralReflectanceRgb).toEqual(expected);
            for (const c of expected) {
                expect(c).toBeGreaterThanOrEqual(0);
                expect(c).toBeLessThanOrEqual(1);
            }

            const mat = mesh.material as THREE.MeshPhysicalMaterial;
            expect(mat).toBeInstanceOf(THREE.MeshPhysicalMaterial);
            expect(mat).not.toBe(original);
            expect(mat.iridescence).toBe(1.0);
            expect(mat.iridescenceIOR).toBeCloseTo(1.33, 6);
            expect(mat.iridescenceThicknessRange[0]).toBeCloseTo(360, 6);
            expect(mat.iridescenceThicknessRange[1]).toBeCloseTo(540, 6);
            // Colour and roughness carried over from the standard material.
            expect(mat.color.getHex()).toBe(0xff8800);
            expect(mat.roughness).toBeCloseTo(0.1, 6);
            expect((engine.getSceneData().customMeshes![0] as any).material.iridescence.thicknessNm).toBe(450);
        });

        it('blackbody and analytical gobo functions return physical values', () => {
            const warm = blackbodyKelvinToLinearRgb(3200);
            const daylight = blackbodyKelvinToLinearRgb(6500);
            expect(warm[0]).toBeGreaterThan(warm[2]);
            expect(daylight[2]).toBeGreaterThan(warm[2]);
            const goboVal = evaluateAnalyticalGobo(0.5, 0.5, 0.0, 0, 4.0);
            expect(goboVal).toBeGreaterThanOrEqual(0.0);
            expect(goboVal).toBeLessThanOrEqual(1.0);
        });

        it('sb_synthesize_moisture_runoff darkens vertical faces and leaves the flat top dry', () => {
            const geom = new THREE.BoxGeometry(2, 2, 2, 4, 4, 4);
            const original = new THREE.MeshStandardMaterial({ color: 0x888888 });
            const mesh = new THREE.Mesh(geom, original);
            mesh.name = 'runoff_box';
            const engine = engineWithLiveMesh(mesh);

            const result = engine.dispatch('sb_synthesize_moisture_runoff', {
                targetId: 'runoff_box',
                options: {
                    gravityDirection: [0, -1, 0],
                    runoffIntensity: 0.75,
                    creviceAccumulation: 0.85,
                    wetDarkeningFactor: 0.5
                }
            });
            expect(result.success).toBe(true);
            expect(result.data.averageMoisture).toBeGreaterThan(0.0);
            expect(result.data.averageMoisture).toBeLessThanOrEqual(1.0);
            expect(mesh.geometry).not.toBe(geom);
            expect(geom.getAttribute('color')).toBeUndefined();
            expect((mesh.material as THREE.Material).vertexColors).toBe(true);
            expect(original.vertexColors).toBe(false);

            const nrm = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
            const col = mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
            let top = 0, side = 0;
            for (let i = 0; i < nrm.count; i++) {
                if (nrm.getY(i) > 0.99) {
                    // Gravity has no tangential component on an upward face: no runoff, base 0.8 grey kept.
                    expect(col.getX(i)).toBeCloseTo(0.8, 5);
                    top++;
                } else if (Math.abs(nrm.getY(i)) < 0.01) {
                    // On a vertical face the full gravity vector runs along the surface: at least
                    // 0.6 * 0.6 * 0.75 = 0.27 moisture, so darkened by at least 13.5%.
                    expect(col.getX(i)).toBeLessThan(0.8 * (1 - 0.27 * 0.5) + 1e-5);
                    side++;
                }
            }
            expect(top).toBeGreaterThan(0);
            expect(side).toBeGreaterThan(0);

            // Direct function invocation on a cylinder.
            const directGeom = new THREE.CylinderGeometry(1, 1, 3, 16, 8);
            const directRes = synthesizeMoistureRunoff(directGeom, { runoffIntensity: 0.8, creviceAccumulation: 0.9 });
            expect(directRes.moistureLevels.length).toBe(directGeom.getAttribute('position').count);
            const colorAttr = directGeom.getAttribute('color') as THREE.BufferAttribute;
            expect(colorAttr).toBeDefined();
            expect(colorAttr.getX(0)).toBeLessThanOrEqual(0.8);
        });

        it('sb_apply_normal_bevel rounds shading normals across the creases of a welded box', () => {
            const box = new THREE.BoxGeometry(2, 2, 2, 2, 2, 2);
            box.deleteAttribute('normal');
            box.deleteAttribute('uv');
            const geom = mergeVertices(box);
            // Start every vertex from an arbitrary upward normal so only the bevel can turn them.
            const flat = new Float32Array(geom.getAttribute('position').count * 3);
            for (let i = 0; i < flat.length; i += 3) flat[i + 1] = 1;
            geom.setAttribute('normal', new THREE.BufferAttribute(flat, 3));
            const mesh = new THREE.Mesh(geom, new THREE.MeshStandardMaterial({ color: 0xcccccc }));
            mesh.name = 'bevel_cube';
            const engine = engineWithLiveMesh(mesh);

            const result = engine.dispatch('sb_apply_normal_bevel', {
                targetId: 'bevel_cube',
                thresholdAngleDeg: 45,
                maxAngleDeg: 135,
                filletSharpness: 2.0
            });
            expect(result.success).toBe(true);
            expect(mesh.geometry).not.toBe(geom);
            expect(flat[0]).toBe(0);

            const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
            const nrm = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
            const p = new THREE.Vector3();
            const n = new THREE.Vector3();
            let edgeChecked = 0, interiorChecked = 0;
            for (let i = 0; i < pos.count; i++) {
                p.fromBufferAttribute(pos, i);
                n.fromBufferAttribute(nrm, i);
                const onFace = [Math.abs(p.x) > 0.999, Math.abs(p.y) > 0.999, Math.abs(p.z) > 0.999].filter(Boolean).length;
                if (onFace === 2) {
                    // Middle of an edge between two faces: the 90 degree crease bisector.
                    const expected = new THREE.Vector3(
                        Math.abs(p.x) > 0.999 ? Math.sign(p.x) : 0,
                        Math.abs(p.y) > 0.999 ? Math.sign(p.y) : 0,
                        Math.abs(p.z) > 0.999 ? Math.sign(p.z) : 0
                    ).normalize();
                    expect(n.distanceTo(expected)).toBeLessThan(1e-4);
                    edgeChecked++;
                } else if (onFace === 1) {
                    // Face centre: all its faces are coplanar, so no crease and the normal is left alone.
                    expect(n.x).toBe(0); expect(n.y).toBe(1); expect(n.z).toBe(0);
                    interiorChecked++;
                }
            }
            expect(edgeChecked).toBe(12);
            expect(interiorChecked).toBe(6);
        });

        it('AgX tonemapping compresses HDR input into display range', () => {
            const tonemapped = evaluateAgXTonemapping([10.0, 5.0, 1.0], { exposure: 1.0 });
            for (const c of tonemapped) {
                expect(c).toBeGreaterThanOrEqual(0.0);
                expect(c).toBeLessThanOrEqual(1.0);
            }
            const dim = evaluateAgXTonemapping([0.05, 0.05, 0.05], { exposure: 1.0 });
            expect(tonemapped[0]).toBeGreaterThan(dim[0]);
        });

        it('sb_apply_subsurface_scattering gives the live mesh a transmissive physical material with the back-scatter shader', () => {
            const original = new THREE.MeshStandardMaterial({ color: 0xffccaa });
            const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 16), original);
            mesh.name = 'sss_sphere';
            const engine = engineWithLiveMesh(mesh);

            const result = engine.dispatch('sb_apply_subsurface_scattering', {
                targetId: 'sss_sphere',
                scatterColor: [0.98, 0.45, 0.35],
                scatterDistance: 0.25,
                ior: 1.42,
                transmission: 0.4,
                thickness: 0.6
            });
            expect(result.success).toBe(true);
            const mat = mesh.material as THREE.MeshPhysicalMaterial;
            expect(mat).toBeInstanceOf(THREE.MeshPhysicalMaterial);
            expect(mat.color.getHex()).toBe(0xffccaa);
            expect(mat.transmission).toBe(0.4);
            expect(mat.ior).toBeCloseTo(1.42, 6);
            expect(mat.thickness).toBe(0.6);
            expect(result.data).toMatchObject({ transmission: 0.4, thickness: 0.6 });
            expect(result.data.ior).toBeCloseTo(1.42, 6);

            const shader: any = { uniforms: {}, fragmentShader: 'void main() { #include <lights_fragment_end> }' };
            mat.onBeforeCompile(shader, undefined as any);
            expect(shader.uniforms.uSssScatterColor.value.toArray()).toEqual([0.98, 0.45, 0.35]);
            expect(shader.uniforms.uSssScatterDistance.value).toBe(0.25);
            expect(shader.fragmentShader).toContain('uniform vec3 uSssScatterColor;');
            expect(shader.fragmentShader).toContain('reflectedLight.directDiffuse += uSssScatterColor');
        });
    });
});
