/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    MediaPipeVideoDirectorService
} from '../src/node/video/MediaPipeVideoDirectorService';

describe('MediaPipeVideoDirectorService (FFmpeg + MediaPipe + Gemini Coordination)', () => {
    const directorService = new MediaPipeVideoDirectorService();

    describe('Aspect Ratio Parsing', () => {
        it('correctly parses standard aspect ratio strings', () => {
            expect(MediaPipeVideoDirectorService.parseAspectRatio('9:16')).toBeCloseTo(9 / 16);
            expect(MediaPipeVideoDirectorService.parseAspectRatio('vertical')).toBeCloseTo(9 / 16);
            expect(MediaPipeVideoDirectorService.parseAspectRatio('1:1')).toBeCloseTo(1.0);
            expect(MediaPipeVideoDirectorService.parseAspectRatio('square')).toBeCloseTo(1.0);
            expect(MediaPipeVideoDirectorService.parseAspectRatio('4:5')).toBeCloseTo(4 / 5);
            expect(MediaPipeVideoDirectorService.parseAspectRatio('16:9')).toBeCloseTo(16 / 9);
            expect(MediaPipeVideoDirectorService.parseAspectRatio('landscape')).toBeCloseTo(16 / 9);
        });

        it('handles custom aspect ratio expressions and falls back cleanly', () => {
            expect(MediaPipeVideoDirectorService.parseAspectRatio('21:9')).toBeCloseTo(21 / 9);
            expect(MediaPipeVideoDirectorService.parseAspectRatio('0.75')).toBeCloseTo(0.75);
            expect(MediaPipeVideoDirectorService.parseAspectRatio('invalid')).toBeCloseTo(9 / 16);
        });
    });

    describe('Pipeline 1: trackVideoMotion (Dry Run)', () => {
        it('generates articulated 3D kinematic frames with SB-Human joint angles', async () => {
            const result = await directorService.trackVideoMotion({
                videoPath: '/virtual/test_dancer.mp4',
                fps: 10,
                duration: 2.0,
                smoothingWindow: 3,
                minConfidence: 0.5,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.dryRun).toBe(true);
            expect(result.durationSec).toBe(2.0);
            expect(result.sampleFps).toBe(10);
            expect(result.totalFramesAnalyzed).toBe(20);
            expect(result.averageConfidence).toBeGreaterThan(0.7);
            expect(result.groundedYReferenceMeters).toBeGreaterThan(0);
            expect(result.frames.length).toBe(20);

            // Verify joint kinematics contract for frame 0
            const frame0 = result.frames[0];
            expect(frame0.frameIndex).toBe(0);
            expect(frame0.timestampSec).toBe(0);
            expect(frame0.angles).toBeDefined();
            expect(Array.isArray(frame0.angles.spine)).toBe(true);
            expect(Array.isArray(frame0.angles.leftUpperArm)).toBe(true);
            expect(Array.isArray(frame0.angles.rightUpperArm)).toBe(true);
            expect(Array.isArray(frame0.angles.leftUpperLeg)).toBe(true);
            expect(Array.isArray(frame0.angles.rightUpperLeg)).toBe(true);
            expect(frame0.hipPositionMeters.length).toBe(3);
        });
    });

    describe('Pipeline 2: autoReframeVideo (Dry Run)', () => {
        it('computes vertical 9:16 crop window from 16:9 input and plans FFmpeg filter', async () => {
            const result = await directorService.autoReframeVideo({
                inputVideoPath: '/virtual/wide_landscape_action.mp4',
                targetAspectRatio: '9:16',
                focusMode: 'body',
                sampleIntervalSec: 0.5,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.dryRun).toBe(true);
            expect(result.targetAspectRatio).toBe('9:16');
            expect(result.cropDimensions.height).toBe(1080);
            // 1080 * 9 / 16 = 607.5 -> rounded to even = 608
            expect(result.cropDimensions.width).toBe(608);
            expect(result.waypoints.length).toBeGreaterThan(1);
            expect(result.filtergraph).toContain('crop=608:1080:');
            expect(result.ffmpegCommand).toContain('-vf "crop=608:1080:');
            expect(result.ffmpegCommand).toContain('-movflags +faststart');
        });

        it('computes square 1:1 crop window and preserves even dimensions', async () => {
            const result = await directorService.autoReframeVideo({
                inputVideoPath: '/virtual/action_runner.mp4',
                targetAspectRatio: '1:1',
                focusMode: 'face',
                sampleIntervalSec: 0.25,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.cropDimensions.width).toBe(1080);
            expect(result.cropDimensions.height).toBe(1080);
            expect(result.cropDimensions.width % 2).toBe(0);
            expect(result.cropDimensions.height % 2).toBe(0);
            expect(result.filtergraph).toContain('crop=1080:1080:');
        });
    });

    describe('Pipeline 3: auditVideoFidelity (Dry Run)', () => {
        it('evaluates video against 8-Dimension Visual Fidelity Rubric', async () => {
            const audit = await directorService.auditVideoFidelity({
                videoPath: '/virtual/vfx_shot_final.mp4',
                promptContext: 'Cinematic drone shot flying through neo-classical stone archway',
                minPassingScore: 8.5,
                dryRun: true
            });

            expect(audit.success).toBe(true);
            expect(audit.dryRun).toBe(true);
            expect(audit.overallScore).toBeGreaterThanOrEqual(8.5);
            expect(audit.passed).toBe(true);
            expect(audit.storyboardSheetPath).toContain('_storyboard.jpg');

            // Anatomical consistency metrics
            expect(audit.anatomicalConsistency.limbLengthStabilityRatio).toBeGreaterThan(0.9);
            expect(audit.anatomicalConsistency.jointContinuityScore).toBeGreaterThan(0.9);
            expect(audit.anatomicalConsistency.personCountStability).toBe(1.0);

            // 8 Dimensions verified
            const dims = audit.dimensionAudits;
            expect(dims.geometricDefinition.passed).toBe(true);
            expect(dims.pixelSplatDensity.passed).toBe(true);
            expect(dims.materialMicroSurface.passed).toBe(true);
            expect(dims.environmentalGrounding.passed).toBe(true);
            expect(dims.radiometricLighting.passed).toBe(true);
            expect(dims.colorTemperature.passed).toBe(true);
            expect(dims.volumetricDepth.passed).toBe(true);
            expect(dims.photographicRealism.passed).toBe(true);
        });
    });

    describe('Pipeline 2: autoReframeVideo (tracked frames)', () => {
        it('frames the tracked person, leaves out frames with nobody, and never centres the crop in place of a detection', async () => {
            const { MissingInputError, GeneratorFailedError } = await import('../src/common/errors/pipeline-errors');
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-reframe-'));
            const video = path.join(dir, 'clip.mp4');
            fs.writeFileSync(video, 'not decoded by the fake editor');
            const crops: any[] = [];
            const editor: any = {
                probeMedia: async () => ({ width: 1920, height: 1080, durationSec: 1.0 }),
                extractKeyframes: async ({ timestampsSec }: { timestampsSec: number[] }) => ({
                    outputPaths: timestampsSec.map((_, i) => { const f = path.join(dir, `f${i}.png`); fs.writeFileSync(f, `frame ${i}`); return f; })
                }),
                quickEdit: async (args: any) => { crops.push(args.crop.box); return { success: true, ffmpegCommand: 'ffmpeg (fake)' }; }
            };
            // Two samples (0 s and 0.5 s): a person standing at x = 0.2 of the frame in the first, nobody in the second.
            const lms = Array.from({ length: 33 }, () => ({ x: 0.2, y: 0.5, z: 0, visibility: 0.8 }));
            const tracked: any = {
                runPoseLandmarker: async (image: Buffer) => image.toString() === 'frame 0'
                    ? { detection: { imageLandmarks: [lms], worldLandmarks: [lms] } }
                    : { noPerson: 'MediaPipe found no person in the image' }
            };
            const result = await new MediaPipeVideoDirectorService(editor, tracked).autoReframeVideo({ inputVideoPath: video, targetAspectRatio: '9:16', sampleIntervalSec: 0.5 });
            expect(result.waypoints).toHaveLength(1);
            expect(result.waypoints[0].confidence).toBeCloseTo(0.8, 5);
            expect(result.undetectedSamples?.map(u => u.timestampSec)).toEqual([0.5]);
            // The crop is centred on the person (0.2 x 1920 = 384 px), clamped at the left edge, not on the frame centre.
            expect(crops[0].x).toBe(Math.max(0, Math.round(384 - result.cropDimensions.width / 2)));
            expect(crops[0].x).toBeLessThan((1920 - result.cropDimensions.width) / 2);

            const nobody: any = { runPoseLandmarker: async () => ({ noPerson: 'MediaPipe found no person in the image' }) };
            await expect(new MediaPipeVideoDirectorService(editor, nobody).autoReframeVideo({ inputVideoPath: video, targetAspectRatio: '9:16' }))
                .rejects.toBeInstanceOf(MissingInputError);
            const broken: any = { runPoseLandmarker: async () => ({ unavailable: 'python3 could not be started' }) };
            await expect(new MediaPipeVideoDirectorService(editor, broken).autoReframeVideo({ inputVideoPath: video, targetAspectRatio: '9:16' }))
                .rejects.toBeInstanceOf(GeneratorFailedError);

            // A centred crop only when asked for, without running the detector.
            const never: any = { runPoseLandmarker: async () => { throw new Error('the detector must not run for a centred crop'); } };
            const centred = await new MediaPipeVideoDirectorService(editor, never).autoReframeVideo({ inputVideoPath: video, targetAspectRatio: '9:16', focusMode: 'center' });
            expect(centred.waypoints.every(w => w.confidence === undefined)).toBe(true);
            expect(crops[crops.length - 1].x).toBe(Math.round((1920 - centred.cropDimensions.width) / 2));
            fs.rmSync(dir, { recursive: true, force: true });
        });
    });

    describe('Pipeline 1: trackVideoMotion (tracked frames)', () => {
        it('leaves out frames with no detected person instead of filling them with a standing pose, and fails when the detector cannot run', async () => {
            const { MissingInputError, GeneratorFailedError } = await import('../src/common/errors/pipeline-errors');
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-track-'));
            const video = path.join(dir, 'clip.mp4');
            fs.writeFileSync(video, 'not decoded by the fake editor');
            const editor: any = {
                probeMedia: async () => ({ durationSec: 0.3 }),
                extractKeyframes: async ({ timestampsSec }: { timestampsSec: number[] }) => ({
                    outputPaths: timestampsSec.map((_, i) => { const f = path.join(dir, `f${i}.png`); fs.writeFileSync(f, `frame ${i}`); return f; })
                })
            };
            const angles = { leftUpperArm: [0.1, 0, 0], rightUpperArm: [0.1, 0, 0], leftLowerArm: [0, 0, 0], rightLowerArm: [0, 0, 0], leftUpperLeg: [0, 0, 0], rightUpperLeg: [0, 0, 0], leftLowerLeg: [0, 0, 0], rightLowerLeg: [0, 0, 0], spine: [0, 0, 0], head: [0, 0, 0] };
            const lms = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: 0.9 }));
            const pose: any = {
                estimatePoseFromImage: async ({ image }: { image: Buffer }) => {
                    if (image.toString() === 'frame 1') throw new MissingInputError('pose detection', 'a visible person', 'MediaPipe found no person in the image');
                    return { success: true, personIndex: 0, angles, hipPositionMeters: [0, 0.9, 0], groundedYOffsetMeters: 0.9, confidence: 0.7, worldLandmarks: lms, imageLandmarks: lms };
                }
            };
            const result = await new MediaPipeVideoDirectorService(editor, pose).trackVideoMotion({ videoPath: video, fps: 10, smoothingWindow: 1 });
            expect(result.success).toBe(true);
            expect(result.frames.map(f => f.frameIndex)).toEqual([0, 2]);
            expect(result.frames.every(f => f.detected === true && f.worldLandmarks?.length === 33)).toBe(true);
            expect(result.undetectedFrames).toEqual([{ frameIndex: 1, timestampSec: 0.1, reason: expect.stringContaining('no person') }]);

            const nobody: any = { estimatePoseFromImage: async () => { throw new MissingInputError('pose detection', 'a visible person', 'MediaPipe found no person in the image'); } };
            const empty = await new MediaPipeVideoDirectorService(editor, nobody).trackVideoMotion({ videoPath: video, fps: 10 });
            expect(empty.success).toBe(false);
            expect(empty.error).toContain('no person in any of the 3 sampled frame(s)');

            const broken: any = { estimatePoseFromImage: async () => { throw new GeneratorFailedError('mediapipe', 'pose detection could not run: python3 could not be started'); } };
            await expect(new MediaPipeVideoDirectorService(editor, broken).trackVideoMotion({ videoPath: video, fps: 10 })).rejects.toBeInstanceOf(GeneratorFailedError);
            fs.rmSync(dir, { recursive: true, force: true });
        });
    });
});
