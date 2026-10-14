/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';
import {
    Dynamic4DGaussianSplatService,
    HumanoidMotionBridgeService
} from '../src/node';
import {
    avatar4dgsHandlers,
    AVATAR_4DGS_TOOL_DECLARATIONS
} from '../src/node/gemini/tools/spatial-tools';
import { VideoMotionTrackResult } from '../src/node/video/MediaPipeVideoDirectorService';
import { requireAssets, withReason } from './helpers/requirements';

const DEMO_DIR = 'models/performer_4dgs/demos/2785536';
const demoAvatar = requireAssets(
    [`${DEMO_DIR}/human_4dgs.ply`, `${DEMO_DIR}/motion.json`],
    'scripts/regenerate_5_demos.ts (GVHMR body via scripts/run_gvhmr.py)'
);
const itAvatar = (title: string, fn: () => unknown) => it.skipIf(!demoAvatar.ok)(withReason(title, demoAvatar), fn);

describe('Performer 4D Gaussian Splatting Dynamic Humanoid Avatar System', () => {
    const splatService = new Dynamic4DGaussianSplatService();
    const bridgeService = new HumanoidMotionBridgeService();

    itAvatar('should discover Performer avatars in local catalog', () => {
        const avatars = splatService.listAvatars();
        expect(avatars.length).toBeGreaterThan(0);

        const demo = avatars.find(a => a.id === '2785536');
        expect(demo).toBeDefined();
        expect(demo?.numSplats).toBe(35000);
        expect(demo?.numFrames).toBe(121);
        expect(demo?.fps).toBe(25.0);
        expect(demo?.hasMotion).toBe(true);
        expect(demo?.hasCameras).toBe(true);
        expect(demo?.hasGeoManifest).toBe(true);
    });

    itAvatar('should load avatar metadata, parse 35k Gaussians PLY, and bind bone weights', () => {
        const { gaussians, motion, details } = splatService.loadAvatar('2785536');
        expect(details.id).toBe('2785536');
        expect(gaussians.length).toBe(35000);
        expect(motion.num_joints).toBe(22);
        expect(motion.canonical_joints.length).toBe(22);
        expect(motion.kintree_parents.length).toBe(22);
        expect(motion.frames.length).toBeGreaterThanOrEqual(120);

        // Check Gaussian properties
        const g0 = gaussians[0];
        expect(g0.position.length).toBe(3);
        expect(g0.scale.length).toBe(3);
        expect(g0.colorRgb.length).toBe(3);
        expect(g0.opacity).toBeGreaterThan(0.0);
        expect(g0.opacity).toBeLessThanOrEqual(1.0);
        expect(g0.quaternion?.length).toBe(4);

        // Check bone weights
        expect(g0.boneIndices.length).toBe(4);
        expect(g0.boneWeights.length).toBe(4);
        const sumW = g0.boneWeights.reduce((a, b) => a + b, 0);
        expect(sumW).toBeCloseTo(1.0, 3);
    });

    itAvatar('should animate and deform Gaussians for specific frame indices via LBS', () => {
        const frame0 = splatService.animateFrame('2785536', 0);
        expect(frame0.frameIndex).toBe(0);
        expect(frame0.numSplats).toBe(35000);
        expect(frame0.splats.length).toBe(35000);
        expect(frame0.bounds.min[0]).toBeLessThan(frame0.bounds.max[0]);
        expect(frame0.bounds.min[1]).toBeLessThan(frame0.bounds.max[1]);
        expect(frame0.bounds.min[2]).toBeLessThan(frame0.bounds.max[2]);
        expect(frame0.centroid.length).toBe(3);

        const frame15 = splatService.animateFrame('2785536', 15);
        expect(frame15.frameIndex).toBe(15);
        expect(frame15.numSplats).toBe(35000);

        // Displacements between frame 0 and frame 15 must be non-zero due to humanoid motion
        const diffX = Math.abs(frame15.centroid[0] - frame0.centroid[0]);
        const diffY = Math.abs(frame15.centroid[1] - frame0.centroid[1]);
        const diffZ = Math.abs(frame15.centroid[2] - frame0.centroid[2]);
        const totalDisp = diffX + diffY + diffZ;
        expect(totalDisp).toBeGreaterThan(0.001);
    });

    itAvatar('should serialize deformed Gaussians into standard 32-byte .splat binary format', () => {
        const splatBuffer = splatService.exportSplatBuffer('2785536', 0);
        const expectedBytes = 35000 * 32; // 1,120,000 bytes
        expect(splatBuffer.byteLength).toBe(expectedBytes);

        // Check first Gaussian values in binary buffer
        const x = splatBuffer.readFloatLE(0);
        const y = splatBuffer.readFloatLE(4);
        const z = splatBuffer.readFloatLE(8);
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
        expect(Number.isFinite(z)).toBe(true);

        const sx = splatBuffer.readFloatLE(12);
        const sy = splatBuffer.readFloatLE(16);
        const sz = splatBuffer.readFloatLE(20);
        expect(sx).toBeGreaterThan(0);
        expect(sy).toBeGreaterThan(0);
        expect(sz).toBeGreaterThan(0);

        // Color and opacity bytes at offset 24..27
        const r = splatBuffer.readUInt8(24);
        const g = splatBuffer.readUInt8(25);
        const b = splatBuffer.readUInt8(26);
        const a = splatBuffer.readUInt8(27);
        expect(r).toBeGreaterThanOrEqual(0);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(a).toBeGreaterThan(0);
    });

    itAvatar('should export Decomposed4DSplatScene compatible with 4DGS streaming', () => {
        const decomposed = splatService.exportDecomposed4DScene('2785536', 6);
        expect(decomposed.numFrames).toBe(6);
        expect(decomposed.canonicalSubject.length).toBe(35000);
        expect(decomposed.trajectories.length).toBe(35000);
        expect(decomposed.trajectories[0].timeDeltas.length).toBe(6);
        expect(decomposed.trajectories[0].timeColors.length).toBe(6);

        // Hero frame 0 delta should be [0, 0, 0]
        const heroDelta = decomposed.trajectories[0].timeDeltas[0];
        expect(heroDelta[0]).toBeCloseTo(0.0, 4);
        expect(heroDelta[1]).toBeCloseTo(0.0, 4);
        expect(heroDelta[2]).toBeCloseTo(0.0, 4);
    });

    it('should retarget 33 MediaPipe landmarks to 22 SB-Human joints with terrain grounding', () => {
        // Create synthetic MediaPipe 33 landmarks
        const synthLandmarks = Array.from({ length: 33 }, (_, i) => ({
            x: (i % 5) * 0.1 - 0.2,
            y: (i % 6) * 0.2 - 0.5,
            z: (i % 4) * 0.05,
            visibility: 0.95
        }));

        // Left ankle & foot, right ankle & foot
        synthLandmarks[27] = { x: 0.1, y: 0.8, z: 0.0, visibility: 0.95 }; // left ankle
        synthLandmarks[28] = { x: -0.1, y: 0.8, z: 0.0, visibility: 0.95 }; // right ankle
        synthLandmarks[29] = { x: 0.1, y: 0.9, z: -0.05, visibility: 0.95 }; // left heel
        synthLandmarks[30] = { x: -0.1, y: 0.9, z: -0.05, visibility: 0.95 }; // right heel
        synthLandmarks[31] = { x: 0.1, y: 0.9, z: 0.1, visibility: 0.95 }; // left foot idx
        synthLandmarks[32] = { x: -0.1, y: 0.9, z: 0.1, visibility: 0.95 }; // right foot idx

        const sbhumanJoints = bridgeService.convertLandmarksToSbHuman22(synthLandmarks);
        expect(sbhumanJoints.length).toBe(22);

        // Verify pelvis is midpoint of hips
        const lHip = synthLandmarks[23];
        const rHip = synthLandmarks[24];
        const expectedPelvisX = (lHip.x + rHip.x) * 0.5;
        expect(sbhumanJoints[0][0]).toBeCloseTo(expectedPelvisX, 4);

        // Verify retargetVideoMotionTrack with ground pinning
        const trackResult: VideoMotionTrackResult = {
            success: true,
            durationSec: 1.0,
            totalFramesAnalyzed: 5,
            sampleFps: 25.0,
            averageConfidence: 0.95,
            maxDisplacementMeters: 0.3,
            groundedYReferenceMeters: 0.0,
            frames: Array.from({ length: 5 }, (_, idx) => ({
                frameIndex: idx,
                timestampSec: idx * 0.04,
                angles: {
                    leftUpperArm: [0, 0, 0],
                    rightUpperArm: [0, 0, 0],
                    leftLowerArm: [0, 0, 0],
                    rightLowerArm: [0, 0, 0],
                    leftUpperLeg: [0, 0, 0],
                    rightUpperLeg: [0, 0, 0],
                    leftLowerLeg: [0, 0, 0],
                    rightLowerLeg: [0, 0, 0],
                    spine: [0, 0, 0],
                    head: [0, 0, 0]
                },
                hipPositionMeters: [0, 0.9, 0],
                groundedYOffsetMeters: 0.0,
                confidence: 0.95,
                worldLandmarks: synthLandmarks
            }))
        };

        const targetGround = 15.0; // 15m elevation
        const retargeted = bridgeService.retargetVideoMotionTrack(trackResult, undefined, {
            groundAltitudeMeters: targetGround,
            pinFeetToGround: true,
            smoothingWindow: 3
        });

        expect(retargeted.num_frames).toBe(5);
        expect(retargeted.num_joints).toBe(22);

        // Lowest foot must be pinned exactly to targetGround
        const frame0 = retargeted.frames[0];
        const leftFootY = frame0.joint_positions_3d[10][1];
        const rightFootY = frame0.joint_positions_3d[11][1];
        const lowestFoot = Math.min(leftFootY, rightFootY);
        expect(lowestFoot).toBeCloseTo(targetGround, 3);
    });

    it('should compile and run native C++20 Gaussian humanoid skinning header cleanly', () => {
        const includePath = path.resolve(__dirname, '../src/native/3d-engine/include');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-4dgs-humanoid-'));
        const testCppPath = path.join(tmpDir, 'test_4dgs_humanoid.cpp');
        const testBinPath = path.join(tmpDir, 'test_4dgs_humanoid_bin');

        const testCppContent = `
#include "scratchbox_4dgs_humanoid.hpp"
#include <iostream>
#include <cassert>

int main() {
    using namespace scratchbox::performer_4d;
    FourDHumanoidAvatar avatar;

    assert(avatar.canonicalJoints.size() == 22);
    assert(avatar.kintreeParents.size() == 22);
    assert(avatar.jointNames.size() == 22);

    // Create a synthetic Gaussian near pelvis
    Gaussian g;
    g.position = scratchbox::math::Vec3(0.0031f, 0.9353f, 0.0400f);
    avatar.restGaussians.push_back(g);

    avatar.computeSkinWeights(0.25f);
    assert(avatar.restGaussians[0].boneIndices[0] < 4); // Connected to pelvic/trunk cluster (bones 0..3)
    float totalW = avatar.restGaussians[0].boneWeights[0] + avatar.restGaussians[0].boneWeights[1] +
                   avatar.restGaussians[0].boneWeights[2] + avatar.restGaussians[0].boneWeights[3];
    assert(std::abs(totalW - 1.0f) < 1e-4f);

    // Deform pelvis upwards by 0.5m
    std::vector<scratchbox::math::Vec3> posed = avatar.canonicalJoints;
    for (auto& j : posed) {
        j.y += 0.5f;
    }

    auto deformed = avatar.deform(posed);
    assert(deformed.size() == 1);
    assert(std::abs(deformed[0].position.y - (0.9353f + 0.5f)) < 0.05f);

    auto splatBuf = FourDHumanoidAvatar::serializeSplatBuffer(deformed);
    assert(splatBuf.size() == 32);

    std::cout << "SUCCESS" << std::endl;
    return 0;
}
`;
        fs.writeFileSync(testCppPath, testCppContent, 'utf-8');

        try {
            const compileCmd = `clang++ -std=c++20 -O3 -I "${includePath}" "${testCppPath}" -o "${testBinPath}"`;
            execSync(compileCmd, { stdio: 'pipe' });

            const runOutput = execSync(`"${testBinPath}"`, { encoding: 'utf-8' }).trim();
            expect(runOutput).toBe('SUCCESS');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should expose Gemini agent tool declarations', () => {
        expect(AVATAR_4DGS_TOOL_DECLARATIONS.length).toBe(5);
        const toolNames = AVATAR_4DGS_TOOL_DECLARATIONS.map(d => d.name);
        expect(toolNames).toContain('avatar_4dgs_list');
        expect(toolNames).toContain('avatar_4dgs_get');
        expect(toolNames).toContain('avatar_4dgs_animate');
        expect(toolNames).toContain('avatar_4dgs_retarget');
        expect(toolNames).toContain('performer_4d_create_from_video');
    });

    itAvatar('should successfully invoke the Gemini agent tool handlers', async () => {
        // Test avatar_4dgs_list
        const listRes = await avatar4dgsHandlers.avatar_4dgs_list({});
        expect(listRes.summaryResult).toContain('Found');
        const listPayload = listRes.resultPayload as any;
        expect(listPayload.totalAvatars).toBeGreaterThan(0);

        // Test avatar_4dgs_get
        const getRes = await avatar4dgsHandlers.avatar_4dgs_get({ avatarId: '2785536' });
        expect(getRes.summaryResult).toContain('Loaded Performer avatar');
        const getPayload = getRes.resultPayload as any;
        expect(getPayload.details.id).toBe('2785536');
        expect(getPayload.joints.length).toBe(22);

        // Test avatar_4dgs_animate with exportSplat
        const animRes = await avatar4dgsHandlers.avatar_4dgs_animate({
            avatarId: '2785536',
            frameIndex: 5,
            exportSplat: true
        });
        expect(animRes.summaryResult).toContain('Animated avatar 2785536 at frame 5');
        const animPayload = animRes.resultPayload as any;
        expect(animPayload.frameIndex).toBe(5);
        expect(animPayload.numSplats).toBe(35000);
        expect(animPayload.splatByteLength).toBe(35000 * 32);

        // Test avatar_4dgs_retarget
        const retargetRes = await avatar4dgsHandlers.avatar_4dgs_retarget({
            avatarId: '2785536',
            groundAltitudeMeters: 5.0,
            pinFeetToGround: true
        });
        expect(retargetRes.summaryResult).toContain('Retargeted motion to avatar 2785536');
        const retargetPayload = retargetRes.resultPayload as any;
        expect(retargetPayload.feetPinned).toBe(true);
        expect(retargetPayload.firstFrameFootY).toBeCloseTo(5.0, 3);
    });
});
