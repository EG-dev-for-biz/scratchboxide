/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { SbHumanLoader } from '../src/common/spatial/SbHumanLoader';
import { TrainedModelRegistryService } from '../src/node/models/TrainedModelRegistryService';
import { SpatialAssetVaultService } from '../src/node/spatial/SpatialAssetVaultService';
import { VideoTo4DPerformerPipelineService } from '../src/node/spatial/VideoTo4DPerformerPipelineService';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';

describe('SB-Human Sole In-Engine Humanoid Asset Standard', () => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const publicModelsDir = path.join(repoRoot, 'public', 'models');

    it('1. should verify that the three canonical .sbhuman binary files exist and have non-zero size', () => {
        const variants = ['neutral', 'male', 'female'];
        for (const variant of variants) {
            const filePath = path.join(publicModelsDir, `sbhuman_${variant}.sbhuman`);
            expect(fs.existsSync(filePath), `sbhuman_${variant}.sbhuman should exist`).toBe(true);
            const stat = fs.statSync(filePath);
            expect(stat.size).toBeGreaterThan(1_500_000); // ~1.96 MB each
        }
    });

    it('2. should parse all three .sbhuman files using SbHumanLoader and verify topology and kinematics', () => {
        const variants = ['neutral', 'male', 'female'];
        for (const variant of variants) {
            const buffer = fs.readFileSync(path.join(publicModelsDir, `sbhuman_${variant}.sbhuman`));
            const loader = SbHumanLoader.parse(buffer);

            expect(loader.header.magic).toBe(0x4E4D4853); // 'SBHM'
            expect(loader.header.version).toBe(2);
            expect(loader.header.numVertices).toBe(10475);
            expect(loader.header.numIndices).toBe(20908 * 3);
            expect(loader.header.numJoints).toBe(55);
            expect(loader.header.numShapeModes).toBe(8);

            // Verify surface sampling
            const sampled = loader.sampleUniformSurface(2000, [0, 0, 0, 0, 0, 0, 0, 0]);
            expect(sampled.count).toBe(2000);
            expect(sampled.positions.length).toBe(6000);
            expect(sampled.boneIndices.length).toBe(8000);
            expect(sampled.boneWeights.length).toBe(8000);
            expect(sampled.totalSurfaceArea).toBeGreaterThan(1.2);
            expect(sampled.totalSurfaceArea).toBeLessThan(2.5);
        }
    });

    it('3. should discover and resolve .sbhuman models via TrainedModelRegistryService without SMPL-X', () => {
        const registry = new TrainedModelRegistryService(repoRoot);
        const sbHumanModels = registry.discoverSbHumanModels();

        expect(sbHumanModels.length).toBe(3);
        expect(sbHumanModels.every(m => m.status === 'ready')).toBe(true);
        expect(sbHumanModels.every(m => m.family === 'sbhuman')).toBe(true);

        const neutral = registry.getSbHumanModel('neutral');
        const male = registry.getSbHumanModel('male');
        const female = registry.getSbHumanModel('female');

        expect(neutral).toBeDefined();
        expect(male).toBeDefined();
        expect(female).toBeDefined();
        expect(neutral!.endsWith('sbhuman_neutral.sbhuman')).toBe(true);
    });

    it('4. should register SB-Human in SpatialAssetVaultService with durable URI', () => {
        const vault = new SpatialAssetVaultService();
        const records = vault.listAssets();

        const sbHumanRecord = records.find(r => r.representation.durableUri === 'vault://body_models/sbhuman/neutral');
        expect(sbHumanRecord).toBeDefined();
        expect(sbHumanRecord!.representation.metadata?.numVertices).toBe(10475);
        expect(sbHumanRecord!.representation.metadata?.neutralUri).toContain('sbhuman_neutral.sbhuman');
    });

    it('5. should generate canonical posed Gaussians using .sbhuman as the sole asset format', () => {
        const service = new VideoTo4DPerformerPipelineService();
        const dummySilhouette = {
            heroMaskPath: '',
            bbox: [0, 0, 100, 200] as [number, number, number, number],
            solvedBetas: [0.2, -0.1, 0.05, 0, 0, 0, 0, 0],
            maskWidth: 100,
            maskHeight: 200
        };

        const result = service.generateCanonicalPosedGaussians(dummySilhouette, 1500, 1.78);
        expect(result.gaussians.length).toBe(1500);
        expect(result.canonicalJoints.length).toBe(22);
        expect(result.jointNames.length).toBe(22);
    });

    it('6. should compile and load .sbhuman via native C++20 engine without external dependencies', async () => {
        const compiler = NativeCppCompilerService.getInstance();
        const cppCode = `
#include "scratchbox_parametric_human.hpp"
#include <iostream>

using namespace scratchbox;
using namespace scratchbox::parametric;

int main() {
    auto model = SbHumanModel::loadStandardModel(skinning::GenderMorph::Neutral, 1.75f);
    if (model.templateMesh.vertices.size() != 10475) {
        std::cerr << "Expected 10475 vertices, got " << model.templateMesh.vertices.size() << std::endl;
        return 1;
    }
    std::cout << "SUCCESS: Vertices=" << model.templateMesh.vertices.size()
              << " Joints=" << model.skeleton.joints.size() << std::endl;
    return 0;
}
`;

        const compileRes = await compiler.compileSource(cppCode, {
            optimizationLevel: 'O2',
            outputBinaryName: `test_sbhuman_native_${Date.now()}`
        });

        expect(compileRes.success, `Compilation failed: ${compileRes.compilerOutput}`).toBe(true);

        const execRes = await compiler.executeBinary(compileRes.binaryPath!);
        expect(execRes.success).toBe(true);
        expect(execRes.stdout).toContain('SUCCESS: Vertices=10475 Joints=55');
    }, 45000);
});
