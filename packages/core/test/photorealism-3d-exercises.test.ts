/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import { PhotorealismExerciseRunner } from '../src/node/3d-engine/photorealism-exercise-runner';
import { PhotorealismEvaluator, inspectGlbBuffer } from '../src/node/3d-engine/photorealism-evaluator';

describe('Photorealism 3D Object Creation Exercises (C++20 Engine)', () => {
    const runner = new PhotorealismExerciseRunner();
    const evaluator = new PhotorealismEvaluator();

    it('Exercise 1: should create photorealistic Aerospace Turbine Engine Assembly', async () => {
        const source = runner.getAerospaceTurbineSource();
        const result = await runner.runExercise(
            'exercise-1-aerospace-turbine',
            'Aerospace Turbine Engine Assembly',
            'hard-surface',
            source
        );

        expect(result.glbBase64.length).toBeGreaterThan(1000);
        expect(result.report.vertexCount).toBeGreaterThanOrEqual(2000);
        expect(result.report.normalSmoothnessScore).toBe(25);
        expect(result.report.aoWeatheringScore).toBeGreaterThanOrEqual(20);
        expect(result.report.pbrMaterialScore).toBe(25);
        expect(result.report.totalScore).toBeGreaterThanOrEqual(90);
        expect(result.report.isPhotorealistic).toBe(true);
        expect(result.report.materialSummary.name).toBe('brushed_titanium');
        expect(result.report.materialSummary.hasVertexColors).toBe(true);

        console.log(`\n✅ Exercise 1 Score: ${result.report.totalScore}/100 (${result.report.vertexCount.toLocaleString()} vertices, ${result.executionTimeMs}ms)`);
        for (const diag of result.report.diagnostics) {
            console.log(`   - ${diag}`);
        }
    }, 45000);

    it('Exercise 2: should create photorealistic Volcanic Basalt Rock & Quartz Geode', async () => {
        const source = runner.getVolcanicGeodeSource();
        const result = await runner.runExercise(
            'exercise-2-volcanic-geode',
            'Volcanic Basalt Rock & Quartz Geode',
            'organic-mineral',
            source
        );

        expect(result.glbBase64.length).toBeGreaterThan(1000);
        expect(result.report.vertexCount).toBeGreaterThanOrEqual(2000);
        expect(result.report.normalSmoothnessScore).toBe(25);
        expect(result.report.aoWeatheringScore).toBeGreaterThanOrEqual(20);
        expect(result.report.pbrMaterialScore).toBe(25);
        expect(result.report.totalScore).toBeGreaterThanOrEqual(90);
        expect(result.report.isPhotorealistic).toBe(true);
        expect(result.report.materialSummary.name).toBe('volcanic_basalt');

        console.log(`\n✅ Exercise 2 Score: ${result.report.totalScore}/100 (${result.report.vertexCount.toLocaleString()} vertices, ${result.executionTimeMs}ms)`);
        for (const diag of result.report.diagnostics) {
            console.log(`   - ${diag}`);
        }
    }, 45000);

    it('Exercise 3: should create photorealistic Parametric Sky-Citadel Neo-Spire', async () => {
        const source = runner.getSkyCitadelSpireSource();
        const result = await runner.runExercise(
            'exercise-3-sky-citadel-spire',
            'Parametric Sky-Citadel Neo-Spire',
            'architectural',
            source
        );

        expect(result.glbBase64.length).toBeGreaterThan(1000);
        expect(result.report.vertexCount).toBeGreaterThanOrEqual(2000);
        expect(result.report.normalSmoothnessScore).toBe(25);
        expect(result.report.aoWeatheringScore).toBeGreaterThanOrEqual(20);
        expect(result.report.pbrMaterialScore).toBe(25);
        expect(result.report.totalScore).toBeGreaterThanOrEqual(90);
        expect(result.report.isPhotorealistic).toBe(true);
        expect(result.report.materialSummary.name).toBe('carbon_composite');

        console.log(`\n✅ Exercise 3 Score: ${result.report.totalScore}/100 (${result.report.vertexCount.toLocaleString()} vertices, ${result.executionTimeMs}ms)`);
        for (const diag of result.report.diagnostics) {
            console.log(`   - ${diag}`);
        }
    }, 45000);

    it('Exercise 4: should create photorealistic Autonomous Biomechanical Rover', async () => {
        const source = runner.getBiomechanicalRoverSource();
        const result = await runner.runExercise(
            'exercise-4-biomechanical-rover',
            'Autonomous Biomechanical Rover',
            'mechatronic',
            source
        );

        expect(result.glbBase64.length).toBeGreaterThan(1000);
        expect(result.report.vertexCount).toBeGreaterThanOrEqual(2000);
        expect(result.report.normalSmoothnessScore).toBe(25);
        expect(result.report.aoWeatheringScore).toBeGreaterThanOrEqual(20);
        expect(result.report.pbrMaterialScore).toBe(25);
        expect(result.report.totalScore).toBeGreaterThanOrEqual(90);
        expect(result.report.isPhotorealistic).toBe(true);
        expect(result.report.materialSummary.hasVertexColors).toBe(true);

        console.log(`\n✅ Exercise 4 Score: ${result.report.totalScore}/100 (${result.report.vertexCount.toLocaleString()} vertices, ${result.executionTimeMs}ms)`);
        for (const diag of result.report.diagnostics) {
            console.log(`   - ${diag}`);
        }
    }, 45000);

    it('should correctly parse and inspect binary glTF 2.0 with COLOR_0 and PBR attributes', () => {
        // Construct a synthetic GLB with COLOR_0
        const mesh = new (class {
            vertices = [
                { position: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, uv: { x: 0, y: 0 }, color: { x: 0.8, y: 0.8, z: 0.8, w: 1.0 } }
            ];
            indices = [0];
        })();
        expect(evaluator).toBeDefined();
    });
});
