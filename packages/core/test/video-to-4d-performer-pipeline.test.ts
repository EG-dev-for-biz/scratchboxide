/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import {
    VideoTo4DPerformerPipelineService,
    SBHUMAN_22_JOINTS,
    HeroFrameExtractionError,
    PerformerInputUnreadableError,
    PerformerMotionUnavailableError
} from '../src/node/spatial/VideoTo4DPerformerPipelineService';
import { InvalidInputError } from '../src/common/errors/pipeline-errors';
import { execSync } from 'child_process';
import * as jpeg from 'jpeg-js';
import { SbHumanLoader } from '../src/common/spatial/SbHumanLoader';
import { Dynamic4DGaussianSplatService } from '../src/node/3d-engine/Dynamic4DGaussianSplatService';
import { HOW_TO, requireAssets, requireBinary, withReason } from './helpers/requirements';

// The canonical .sbhuman template (gitignored, no generator script in the repo). Without it the service samples a
// procedural proxy whose canonical skeleton already has the arms down, so T-pose-specific checks need the template.
const sbhuman = requireAssets(['public/models/sbhuman_neutral.sbhuman']);
const demoHeroFrames = requireAssets(
    ['10331522', '2785536'].map(id => `models/performer_4dgs/demos/${id}/canonical_frame.jpg`),
    'scripts/regenerate_5_demos.ts (GVHMR body via scripts/run_gvhmr.py)'
);
const ffmpeg = requireBinary('ffmpeg', HOW_TO.ffmpeg);

describe('VideoTo4DPerformerPipelineService', () => {
    let testOutputDir: string;
    let pipeline: VideoTo4DPerformerPipelineService;

    beforeAll(async () => {
        testOutputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sbx-video-to-4d-'));
        pipeline = new VideoTo4DPerformerPipelineService();
    });

    afterAll(async () => {
        await fs.remove(testOutputDir);
    });

    it('1. should extract performer silhouette and solve morphology accurately', async () => {
        const dummyHeroPath = path.join(testOutputDir, 'test_hero.jpg');
        await fs.writeFile(dummyHeroPath, Buffer.alloc(100));

        const morphology = await pipeline.solvePerformerMorphology(dummyHeroPath, 1.82);

        expect(morphology).toBeDefined();
        expect(morphology.ratios.headsTall).toBeCloseTo(7.6, 1);
        expect(morphology.ratios.shoulderToHipRatio).toBeGreaterThan(1.0);
        expect(morphology.ratios.legToTorsoRatio).toBeGreaterThan(1.0);
        expect(morphology.solvedBetas).toHaveLength(8);

        // All 8 PCA betas must fall within normalized standard range [-3.0, +3.0]
        for (const beta of morphology.solvedBetas) {
            expect(beta).toBeGreaterThanOrEqual(-3.0);
            expect(beta).toBeLessThanOrEqual(3.0);
        }
    });

    it('2. should sample canonical humanoid surface and compute 4-influence partition-of-unity skinning', async () => {
        const dummyHeroPath = path.join(testOutputDir, 'test_hero.jpg');
        const morphology = await pipeline.solvePerformerMorphology(dummyHeroPath, 1.78);
        const result = pipeline.generateCanonicalPosedGaussians(morphology, 2000, 1.78);

        expect(result.gaussians.length).toBeGreaterThan(1500);
        expect(result.canonicalJoints).toHaveLength(22);
        expect(result.kintreeParents).toHaveLength(22);

        // Check 100% of Gaussians have partition-of-unity skinning weights (sum == 1.0)
        for (let i = 0; i < result.gaussians.length; i++) {
            const g = result.gaussians[i];
            const weightSum = g.boneWeights[0] + g.boneWeights[1] + g.boneWeights[2] + g.boneWeights[3];
            expect(weightSum).toBeCloseTo(1.0, 4);

            // Bone indices must be valid SB-Human indices [0..21]
            for (let b = 0; b < 4; b++) {
                expect(g.boneIndices[b]).toBeGreaterThanOrEqual(0);
                expect(g.boneIndices[b]).toBeLessThan(22);
            }

            // Normal vector should have non-zero magnitude
            const nx = g.normal?.[0] ?? 0;
            const ny = g.normal?.[1] ?? 0;
            const nz = g.normal?.[2] ?? 0;
            const normLen = Math.sqrt(nx * nx + ny * ny + nz * nz);
            expect(normLen).toBeGreaterThan(0.5);
        }
    });

    it.skipIf(!sbhuman.ok)(withReason('3a. should relax the T-pose .sbhuman template into the hero resting pose', sbhuman), async () => {
        const dummyHeroPath = path.join(testOutputDir, 'test_hero.jpg');
        const morphology = await pipeline.solvePerformerMorphology(dummyHeroPath, 1.78);
        const canonical = pipeline.generateCanonicalPosedGaussians(morphology, 500, 1.78);

        expect(canonical.heroPoseJoints).toBeDefined();
        const heroJoints = canonical.heroPoseJoints!;
        // Wrists (indices 20, 21) in T-pose are at shoulder height (~1.35m); in Hero resting pose they hang at hips (~0.90m)
        expect(heroJoints[20][1]).toBeLessThan(canonical.canonicalJoints[20][1] - 0.25);
        expect(heroJoints[21][1]).toBeLessThan(canonical.canonicalJoints[21][1] - 0.25);
        // Arms are adducted inwards towards torso: |X| is significantly reduced
        expect(Math.abs(heroJoints[20][0])).toBeLessThan(Math.abs(canonical.canonicalJoints[20][0]) - 0.25);
        expect(Math.abs(heroJoints[21][0])).toBeLessThan(Math.abs(canonical.canonicalJoints[21][0]) - 0.25);
    });

    it('3. should backproject optical camera rays and transfer RGB texture', async () => {
        const dummyHeroPath = path.join(testOutputDir, 'test_hero.jpg');
        const morphology = await pipeline.solvePerformerMorphology(dummyHeroPath, 1.78);
        const canonical = pipeline.generateCanonicalPosedGaussians(morphology, 500, 1.78);

        const cameraIntrinsics = {
            width: 1920,
            height: 1080,
            fx: 2200,
            fy: 2200,
            cx: 960,
            cy: 540
        };

        expect(canonical.heroPoseJoints).toBeDefined();

        const textured = await pipeline.backprojectVideoTextures(
            canonical.gaussians,
            dummyHeroPath,
            morphology.colorSamples,
            cameraIntrinsics,
            canonical.canonicalJoints,
            canonical.heroPoseJoints
        );

        expect(textured.length).toBe(canonical.gaussians.length);

        for (const g of textured) {
            // Colors must be normalized [0, 1]
            expect(g.colorRgb[0]).toBeGreaterThanOrEqual(0);
            expect(g.colorRgb[0]).toBeLessThanOrEqual(1.0);
            expect(g.colorRgb[1]).toBeGreaterThanOrEqual(0);
            expect(g.colorRgb[1]).toBeLessThanOrEqual(1.0);
            expect(g.colorRgb[2]).toBeGreaterThanOrEqual(0);
            expect(g.colorRgb[2]).toBeLessThanOrEqual(1.0);
        }
    });

    it('4. should enforce foot-contact ground clamping across motion frames', async () => {
        const canonicalJoints = SBHUMAN_22_JOINTS.map(j => j.restOffset);
        const parents = SBHUMAN_22_JOINTS.map(j => j.parent);
        const heroJoints = pipeline.computeHeroRestingPoseJoints(canonicalJoints);

        const motion = await pipeline.recoverPerformerMotion(canonicalJoints, parents, 25, 2.0, 'test_motion', heroJoints,
            undefined, undefined, { allowSyntheticIdleMotion: true });

        expect(motion.num_frames).toBe(50);
        expect(motion.motion_source).toBe('synthetic_idle');
        expect(motion.num_joints).toBe(22);

        // Frame 0 starts at the natural hero resting pose
        expect(motion.frames[0].joint_positions_3d[20][1]).toBeCloseTo(heroJoints[20][1], 2);

        // In every single frame, the lowest foot vertex must be clamped exactly to ground (0.00m)
        for (const frame of motion.frames) {
            const leftFootY = frame.joint_positions_3d[10][1];
            const rightFootY = frame.joint_positions_3d[11][1];
            const lowestFootY = Math.min(leftFootY, rightFootY);
            expect(lowestFootY).toBeCloseTo(0.0, 3);
        }
    });

    it('4b. refuses the procedural idle sway unless the caller opts in', async () => {
        const canonicalJoints = SBHUMAN_22_JOINTS.map(j => j.restOffset);
        const parents = SBHUMAN_22_JOINTS.map(j => j.parent);
        await expect(pipeline.recoverPerformerMotion(canonicalJoints, parents, 25, 1.0, 'no_motion'))
            .rejects.toThrow(PerformerMotionUnavailableError);
    });

    it('4c. rejects unusable inputs and unknown venues with typed errors (no placeholder hero frame)', async () => {
        const out = path.join(testOutputDir, 'bad_inputs');
        await expect(pipeline.executePipeline({ videoPath: path.join(testOutputDir, 'nope.mp4'), outputDir: out }))
            .rejects.toBeInstanceOf(PerformerInputUnreadableError);
        const empty = path.join(testOutputDir, 'empty.mp4');
        await fs.writeFile(empty, Buffer.alloc(0));
        await expect(pipeline.executePipeline({ videoPath: empty, outputDir: out })).rejects.toBeInstanceOf(PerformerInputUnreadableError);

        // Bytes that are not a decodable video used to yield a 1 KB zero-filled "hero frame".
        const garbage = path.join(testOutputDir, 'garbage.mp4');
        await fs.writeFile(garbage, Buffer.alloc(1024));
        await expect(pipeline.extractHeroFrame(garbage, out, 0)).rejects.toBeInstanceOf(HeroFrameExtractionError);
        const garbageImg = path.join(testOutputDir, 'garbage.jpg');
        await fs.writeFile(garbageImg, Buffer.alloc(1024));
        await expect(pipeline.extractHeroFrame(garbageImg, out, 0)).rejects.toBeInstanceOf(HeroFrameExtractionError);

        // A venue is the caller's coordinates; an unusable one fails before any work, and none is looked up.
        await expect(pipeline.executePipeline({ videoPath: garbageImg, outputDir: out, venue: { name: 'x', lat: 91, lng: 0, altMeters: 0, stageHeadingDeg: 0 } }))
            .rejects.toBeInstanceOf(InvalidInputError);
    });

    it('4d. emits no venue anchor unless one is requested, and labels synthetic motion', async () => {
        // A real 64x128 JPEG still: grey field with a tall bright figure-like block.
        const W = 64, H = 128;
        const rgba = Buffer.alloc(W * H * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const v = x >= 20 && x < 44 && y >= 10 && y < 120 ? 240 : 128;
            rgba.set([v, v, v, 255], (y * W + x) * 4);
        }
        const hero = path.join(testOutputDir, 'still_hero.jpg');
        await fs.writeFile(hero, jpeg.encode({ data: rgba, width: W, height: H }, 90).data);
        const result = await pipeline.executePipeline({
            videoPath: hero,
            outputDir: path.join(testOutputDir, 'no_venue'),
            characterId: 'no_venue_test',
            numGaussians: 500,
            motionSequenceLengthSec: 0.4,
            allowSyntheticIdleMotion: true,
            exportNerfstudioDataset: false
        });
        expect(result.venueAnchor).toBeUndefined();
        expect(result.stagePlacementPath).toBeUndefined();
        expect(result.telemetry.motionSource).toBe('synthetic_idle');
        expect(result.telemetry.syntheticMotion).toBe(true);
        expect(result.cameraIntrinsics.width).toBe(64);
        expect(result.cameraIntrinsics.height).toBe(128);
        const manifest = await fs.readJson(result.geoManifestPath);
        expect(manifest.geographic_anchor).toBeUndefined();
        expect(manifest.motion_source).toBe('synthetic_idle');
        expect(fs.existsSync(path.join(testOutputDir, 'no_venue', 'stage_placement.json'))).toBe(false);
    });

    it.skipIf(!ffmpeg.ok)(withReason('5. should execute full pipeline and produce standard PLY, motion.json, and 32-byte .splat dataset', ffmpeg), async () => {
        const charOutputDir = path.join(testOutputDir, 'demo_character');
        const videoPath = path.join(testOutputDir, 'performer_input.mp4');
        execSync(`ffmpeg -v error -y -f lavfi -i "color=c=gray:s=64x128:d=1,drawbox=x=20:y=10:w=24:h=110:color=white:t=fill" -c:v libx264 -pix_fmt yuv420p "${videoPath}"`);

        const result = await pipeline.executePipeline({
            videoPath,
            motionEstimator: 'mediapipe',
            outputDir: charOutputDir,
            characterId: 'performer_red_rocks_test',
            numGaussians: 1000,
            targetHeightMeters: 1.80,
            venue: { id: 'red_rocks', name: 'Red Rocks Amphitheatre', lat: 39.66555, lng: -105.20525, altMeters: 1932.0, stageHeadingDeg: 285.0 },
            fps: 25,
            motionSequenceLengthSec: 1.0,
            allowSyntheticIdleMotion: true
        });

        expect(result.success).toBe(true);
        expect(result.characterId).toBe('performer_red_rocks_test');
        expect(result.numGaussians).toBeGreaterThan(800);
        expect(result.numFrames).toBe(25);
        expect(result.venueAnchor!.venueId).toBe('red_rocks');
        expect(result.venueAnchor!.latitude).toBeCloseTo(39.66555, 4);

        // Verify all artifact files exist on disk
        expect(fs.existsSync(result.plyPath)).toBe(true);
        expect(fs.existsSync(result.motionPath)).toBe(true);
        expect(fs.existsSync(result.splatPath)).toBe(true);
        expect(fs.existsSync(result.geoManifestPath)).toBe(true);
        expect(fs.existsSync(result.stagePlacementPath!)).toBe(true);

        // Verify standard PLY header
        const plyContent = await fs.readFile(result.plyPath, 'utf-8');
        expect(plyContent.startsWith('ply\nformat ascii 1.0\n')).toBe(true);
        expect(plyContent.includes('property float x')).toBe(true);
        expect(plyContent.includes('property float nx')).toBe(true);
        expect(plyContent.includes('property float f_dc_0')).toBe(true);
        expect(plyContent.includes('comment scratchbox_encoding color=sh_dc quat=wxyz')).toBe(true);
        expect(plyContent.includes('property int bone_idx_0')).toBe(true);
        expect(plyContent.includes('end_header')).toBe(true);

        // Verify 32-byte binary .splat length
        const splatBuffer = await fs.readFile(result.splatPath);
        expect(splatBuffer.length).toBe(result.numGaussians * 32);
    });

    it.skipIf(!ffmpeg.ok)(withReason('6. should evaluate runtime deformation cleanly via Dynamic4DGaussianSplatService', ffmpeg), () => {
        const charOutputDir = path.join(testOutputDir, 'demo_character');
        const customRepoRoot = testOutputDir; // Point to custom test root
        const mockDemosDir = path.join(customRepoRoot, 'models', 'performer_4dgs', 'demos', 'performer_red_rocks_test');
        fs.ensureDirSync(mockDemosDir);
        fs.copySync(charOutputDir, mockDemosDir);

        const splatService = new Dynamic4DGaussianSplatService(customRepoRoot);
        const { gaussians, motion, details } = splatService.loadAvatar('performer_red_rocks_test');

        expect(gaussians.length).toBeGreaterThan(800);
        expect(motion.num_frames).toBe(25);
        expect(details.id).toBe('performer_red_rocks_test');

        // Animate frame 0 and frame 12
        const frame0 = splatService.animateFrame('performer_red_rocks_test', 0);
        const frame12 = splatService.animateFrame('performer_red_rocks_test', 12);

        expect(frame0.splats.length).toBe(gaussians.length);
        expect(frame12.splats.length).toBe(gaussians.length);

        // Bounds must enclose character
        expect(frame0.bounds.max[1] - frame0.bounds.min[1]).toBeGreaterThan(1.2);
    });

    it.skipIf(!sbhuman.ok)(withReason('7. should parse .sbhuman binary model and verify surface area and topology', sbhuman), async () => {
        const sbHumanPath = path.resolve(process.cwd(), 'public/models/sbhuman_neutral.sbhuman');
        expect(await fs.pathExists(sbHumanPath)).toBe(true);

        const buffer = await fs.readFile(sbHumanPath);
        const loader = SbHumanLoader.parse(buffer);

        expect(loader.header.magic).toBe(0x4E4D4853); // 'SBHM'
        expect(loader.header.version).toBe(2);
        expect(loader.header.numVertices).toBe(10475);
        expect(loader.header.numIndices).toBe(62724); // 20,908 triangles * 3
        expect(loader.header.numJoints).toBe(55);
        expect(loader.joints).toHaveLength(55);

        // First 22 joints match SB-Human body skeleton
        expect(loader.joints[0].name).toBe('Pelvis');
        expect(loader.joints[15].name).toBe('Head');
        expect(loader.joints[20].name).toBe('LeftWrist');
        expect(loader.joints[21].name).toBe('RightWrist');

        // Sample 5,000 points with non-zero PCA shape betas
        const betas: [number, number, number, number, number, number, number, number] = [
            0.2, 0.15, -0.1, 0.3, 0.05, 0.1, -0.05, 0.0
        ];
        const sampled = loader.sampleUniformSurface(5000, betas);

        expect(sampled.count).toBe(5000);
        expect(sampled.totalSurfaceArea).toBeGreaterThan(1.6);
        expect(sampled.totalSurfaceArea).toBeLessThan(2.2);

        // Verify partition-of-unity skin weights across all sampled Gaussians
        for (let i = 0; i < sampled.count; i++) {
            const w0 = sampled.boneWeights[i * 4];
            const w1 = sampled.boneWeights[i * 4 + 1];
            const w2 = sampled.boneWeights[i * 4 + 2];
            const w3 = sampled.boneWeights[i * 4 + 3];
            const sumW = w0 + w1 + w2 + w3;
            expect(sumW).toBeCloseTo(1.0, 4);

            const nx = sampled.normals[i * 3];
            const ny = sampled.normals[i * 3 + 1];
            const nz = sampled.normals[i * 3 + 2];
            const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
            expect(len).toBeCloseTo(1.0, 3);
        }
    });

    it.skipIf(!demoHeroFrames.ok)(withReason('8. should solve distinct morphology and sample real albedos across multiple demo performers', demoHeroFrames), async () => {
        const demoIds = ['10331522', '2785536', '5435720', '15443888', '5885633'];
        const results: Record<string, any> = {};

        for (const id of demoIds) {
            const heroPath = path.resolve(process.cwd(), `models/performer_4dgs/demos/${id}/canonical_frame.jpg`);
            if (await fs.pathExists(heroPath)) {
                const morph = await pipeline.solvePerformerMorphology(heroPath, 1.78);
                results[id] = {
                    ratios: morph.ratios,
                    solvedBetas: morph.solvedBetas,
                    colorSamples: morph.colorSamples
                };

                expect(morph.ratios.headsTall).toBeGreaterThan(6.0);
                expect(morph.ratios.headsTall).toBeLessThan(9.0);
                expect(morph.solvedBetas).toHaveLength(8);

                console.log(`[MORPHOLOGY #${id}]`, {
                    headsTall: morph.ratios.headsTall,
                    shoulderToHip: morph.ratios.shoulderToHipRatio,
                    legToTorso: morph.ratios.legToTorsoRatio,
                    betas: morph.solvedBetas.slice(0, 4).map((b: number) => Number(b.toFixed(2))),
                    torsoRgb: morph.colorSamples.torsoColorRgb.map((c: number) => Number(c.toFixed(2)))
                });
            }
        }

        // Verify that different performers produce distinct color samples and morphology
        expect(results['10331522'].colorSamples.torsoColorRgb).not.toEqual(results['2785536'].colorSamples.torsoColorRgb);
    });

    it('9. should integrate MediaPipe 33-joint normalized landmarks for dynamic envelope & pose angle derivation', async () => {
        // Construct synthetic 33-keypoint normalized landmarks for an athletic dancer
        const landmarks33 = new Array(33).fill(null).map((_, i) => ({
            x: 0.5,
            y: 0.5,
            z: 0.0,
            visibility: 0.99
        }));

        // Performer coordinates (mirrored camera space, normalized [0, 1])
        // Head / Nose
        landmarks33[0] = { x: 0.50, y: 0.12, z: 0.0, visibility: 0.99 }; // NOSE
        // Shoulders
        landmarks33[11] = { x: 0.62, y: 0.24, z: 0.0, visibility: 0.98 }; // LEFT_SHOULDER
        landmarks33[12] = { x: 0.38, y: 0.24, z: 0.0, visibility: 0.98 }; // RIGHT_SHOULDER
        // Elbows (abducted slightly outward)
        landmarks33[13] = { x: 0.70, y: 0.42, z: 0.0, visibility: 0.95 }; // LEFT_ELBOW
        landmarks33[14] = { x: 0.30, y: 0.42, z: 0.0, visibility: 0.95 }; // RIGHT_ELBOW
        // Wrists (flexed near waist)
        landmarks33[15] = { x: 0.72, y: 0.60, z: 0.0, visibility: 0.92 }; // LEFT_WRIST
        landmarks33[16] = { x: 0.28, y: 0.60, z: 0.0, visibility: 0.92 }; // RIGHT_WRIST
        // Hips
        landmarks33[23] = { x: 0.56, y: 0.52, z: 0.0, visibility: 0.97 }; // LEFT_HIP
        landmarks33[24] = { x: 0.44, y: 0.52, z: 0.0, visibility: 0.97 }; // RIGHT_HIP
        // Knees
        landmarks33[25] = { x: 0.58, y: 0.72, z: 0.0, visibility: 0.96 }; // LEFT_KNEE
        landmarks33[26] = { x: 0.42, y: 0.72, z: 0.0, visibility: 0.96 }; // RIGHT_KNEE
        // Ankles
        landmarks33[27] = { x: 0.60, y: 0.91, z: 0.0, visibility: 0.95 }; // LEFT_ANKLE
        landmarks33[28] = { x: 0.40, y: 0.91, z: 0.0, visibility: 0.95 }; // RIGHT_ANKLE

        const dummyFrame = path.resolve(process.cwd(), 'models/performer_4dgs/demos/10331522/canonical_frame.jpg');
        const morph = await pipeline.solvePerformerMorphology(dummyFrame, 1.78, landmarks33);

        expect(morph.landmarks2D).toBeDefined();
        expect(morph.landmarks2D).toHaveLength(33);
        expect(morph.detectedPoseAngles).toBeDefined();
        expect(morph.detectedPoseAngles?.leftShoulderAngleRad).toBeGreaterThan(0.2);
        expect(morph.detectedPoseAngles?.rightShoulderAngleRad).toBeGreaterThan(0.2);

        // Verify dynamic bounding box corresponds to landmark envelope
        expect(morph.boundingBox.minY).toBeLessThan(morph.boundingBox.maxY);
        expect(morph.boundingBox.minX).toBeLessThan(morph.boundingBox.maxX);

        // Verify dynamic pose joint solver adjusts arm kinematics based on landmarks
        const canonicalJoints: Array<[number, number, number]> = new Array(22).fill(null).map((_, i) => [
            i === 16 ? 0.16 : i === 17 ? -0.16 : i === 18 ? 0.42 : i === 19 ? -0.42 : i === 20 ? 0.68 : i === 21 ? -0.68 : 0,
            1.38,
            0
        ]);
        const posedFromLandmarks = pipeline.computeDynamicPoseJointsFromLandmarks(canonicalJoints, landmarks33);
        expect(posedFromLandmarks[18][1]).toBeLessThan(canonicalJoints[16][1]); // Left elbow lower than shoulder
        expect(posedFromLandmarks[19][1]).toBeLessThan(canonicalJoints[17][1]); // Right elbow lower than shoulder
        expect(posedFromLandmarks[20][1]).toBeLessThan(posedFromLandmarks[18][1]); // Left wrist lower than elbow
    });

    it('10. should calculate Mask-IoU and gate video texture backprojection when IoU < 0.85', async () => {
        const canonicalHumanoid = await pipeline.generateCanonicalPosedGaussians(
            {
                heroFramePath: '',
                width: 1080,
                height: 1920,
                boundingBox: { minX: 200, minY: 100, maxX: 880, maxY: 1800 },
                ratios: {
                    headsTall: 7.6,
                    shoulderToHipRatio: 1.12,
                    waistCinchRatio: 0.74,
                    bustVolumeScore: 0.18,
                    legToTorsoRatio: 1.05,
                    muscularityScore: 0.25,
                    genderDimorphism: 0.35,
                    headWidthToHeightRatio: 0.72
                },
                solvedBetas: [0, 0, 0, 0, 0, 0, 0, 0],
                colorSamples: {
                    hairColorRgb: [0.1, 0.1, 0.1],
                    torsoColorRgb: [0.4, 0.4, 0.5],
                    legsColorRgb: [0.2, 0.2, 0.2],
                    skinToneRgb: [0.7, 0.6, 0.5]
                }
            },
            5000,
            1.78
        );

        const camera = { fx: 2160, fy: 2160, cx: 540, cy: 960, width: 1080, height: 1920, standoff: 2.8, camY: 1.0 };
        const maskW = 64;
        const maskH = 128;

        // 1. Synthesize ground-truth performer foreground mask matching the forward-LBS projected Gaussians
        const highIoUMask = new Uint8Array(maskW * maskH);
        const heroPosed = pipeline.poseGaussiansToHero(
            canonicalHumanoid.gaussians,
            canonicalHumanoid.canonicalJoints,
            canonicalHumanoid.heroPoseJoints
        );

        for (const [x, y, z] of heroPosed.positions) {
            const camZ = 2.8 - z;
            if (camZ <= 0.1) continue;
            const u = camera.fx * (x / camZ) + camera.cx;
            const v = camera.fy * (-(y - 1.0) / camZ) + camera.cy;
            const mu = Math.floor((u / camera.width) * maskW);
            const mv = Math.floor((v / camera.height) * maskH);
            if (mu >= 0 && mu < maskW && mv >= 0 && mv < maskH) {
                for (let dy = -1; dy <= 1; dy++) {
                    const py = mv + dy;
                    if (py < 0 || py >= maskH) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const px = mu + dx;
                        if (px < 0 || px >= maskW) continue;
                        highIoUMask[py * maskW + px] = 1;
                    }
                }
            }
        }

        const passResult = pipeline.calculateMaskIoU(
            canonicalHumanoid.gaussians,
            camera,
            canonicalHumanoid.canonicalJoints,
            canonicalHumanoid.heroPoseJoints,
            highIoUMask,
            maskW,
            maskH
        );
        expect(passResult.iou).toBeGreaterThanOrEqual(0.95);
        expect(passResult.gated).toBe(false);

        // 2. Synthesize an unaligned/mismatched mask (e.g. corner square with minimal overlap)
        const lowIoUMask = new Uint8Array(maskW * maskH);
        for (let y = 0; y < 15; y++) {
            for (let x = 0; x < 15; x++) {
                lowIoUMask[y * maskW + x] = 1;
            }
        }

        const failResult = pipeline.calculateMaskIoU(
            canonicalHumanoid.gaussians,
            camera,
            canonicalHumanoid.canonicalJoints,
            canonicalHumanoid.heroPoseJoints,
            lowIoUMask,
            maskW,
            maskH
        );
        expect(failResult.iou).toBeLessThan(0.85);
        expect(failResult.gated).toBe(true);

        // 3. Verify backprojectVideoTextures respects gating when IoU < 0.85
        const palette = {
            hairColorRgb: [0.1, 0.1, 0.1] as [number, number, number],
            torsoColorRgb: [0.4, 0.4, 0.5] as [number, number, number],
            legsColorRgb: [0.2, 0.2, 0.2] as [number, number, number],
            skinToneRgb: [0.7, 0.6, 0.5] as [number, number, number]
        };

        const gatedBackprojection = await pipeline.backprojectVideoTextures(
            canonicalHumanoid.gaussians.slice(0, 100),
            '',
            palette,
            camera,
            canonicalHumanoid.canonicalJoints,
            canonicalHumanoid.heroPoseJoints,
            lowIoUMask,
            maskW,
            maskH
        );

        expect(gatedBackprojection.iou).toBeLessThan(0.85);
        expect(gatedBackprojection.gated).toBe(true);
        // Under gated condition, all Gaussians maintain valid RGB in [0, 1] range via palette proxy
        for (const g of gatedBackprojection) {
            expect(g.colorRgb[0]).toBeGreaterThanOrEqual(0.0);
            expect(g.colorRgb[0]).toBeLessThanOrEqual(1.0);
        }
    });

    it('11. should extract optical silhouette landmarks from an A-pose frame buffer', async () => {
        // 1. Create synthetic 64x128 rgb24 buffer representing an A-pose human silhouette
        const W = 64;
        const H = 128;
        const frameBuf = Buffer.alloc(W * H * 3, 128); // Grey background #808080

        // Paint human figure (head, shoulders, torso, legs)
        for (let y = 15; y < 115; y++) {
            let halfW = 4;
            if (y < 28) halfW = 5; // Head
            else if (y < 35) halfW = 3; // Neck
            else if (y < 45) halfW = 14; // Shoulders
            else if (y < 60) halfW = 8; // Torso
            else if (y < 75) halfW = 10; // Hips
            else halfW = 6; // Legs

            const cx = 32;
            for (let x = cx - halfW; x <= cx + halfW; x++) {
                const idx = (y * W + x) * 3;
                frameBuf[idx] = 220;
                frameBuf[idx + 1] = 200;
                frameBuf[idx + 2] = 180;
            }
        }

        const landmarks = pipeline.extractSilhouetteLandmarks(frameBuf, W, H);
        expect(landmarks).toHaveLength(33);
        // Nose near head
        expect(landmarks[0].y).toBeLessThan(0.30);
        // Shoulders around 25-35%
        expect(landmarks[11].y).toBeGreaterThan(0.20);
        expect(landmarks[11].y).toBeLessThan(0.40);
        expect(landmarks[12].y).toBeGreaterThan(0.20);
        expect(landmarks[12].y).toBeLessThan(0.40);
        // Ankles near bottom
        expect(landmarks[27].y).toBeGreaterThan(0.80);
        expect(landmarks[28].y).toBeGreaterThan(0.80);
    });

    it.skipIf(!ffmpeg.ok)(withReason('11b. should track video-bound kinematics with ground clamping from a synthetic MP4', ffmpeg), async () => {
        // 2. Generate a real 1-second synthetic MP4 video to verify video-bound motion extraction
        const tempVideoPath = path.join(os.tmpdir(), `test_performer_motion_${Date.now()}.mp4`);
        const { execSync } = await import('child_process');
        try {
            execSync(`ffmpeg -y -f lavfi -i "color=c=gray:s=64x128:d=1,drawbox=x=20:y=20:w=24:h=80:color=white:t=fill" -c:v libx264 -pix_fmt yuv420p "${tempVideoPath}"`, { stdio: 'ignore' });

            if (fs.existsSync(tempVideoPath)) {
                const canonicalJoints = SBHUMAN_22_JOINTS.map(j => [...j.restOffset] as [number, number, number]);
                const kintreeParents = SBHUMAN_22_JOINTS.map(j => j.parent);
                const heroPoseJoints = pipeline.computeHeroRestingPoseJoints(canonicalJoints);

                const motion = await pipeline.recoverPerformerMotion(
                    canonicalJoints,
                    kintreeParents,
                    15,
                    1.0,
                    'video_bound_test',
                    heroPoseJoints,
                    tempVideoPath
                );

                expect(motion.num_frames).toBe(15);
                expect(motion.frames.length).toBe(15);
                // Verify foot contact ground clamping is strictly enforced: lowest foot Y = 0.00m
                for (const frame of motion.frames) {
                    const leftFootY = frame.joint_positions_3d[10][1];
                    const rightFootY = frame.joint_positions_3d[11][1];
                    const lowestFootY = Math.min(leftFootY, rightFootY);
                    expect(lowestFootY).toBeCloseTo(0.00, 2);
                }
            }
        } finally {
            if (fs.existsSync(tempVideoPath)) {
                fs.unlinkSync(tempVideoPath);
            }
        }
    });
});

