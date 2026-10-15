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

        it('parses custom ratios and refuses one that is not a ratio instead of assuming 9:16', async () => {
            const { MissingInputError } = await import('../src/common/errors/pipeline-errors');
            expect(MediaPipeVideoDirectorService.parseAspectRatio('21:9')).toBeCloseTo(21 / 9);
            expect(MediaPipeVideoDirectorService.parseAspectRatio('0.75')).toBeCloseTo(0.75);
            expect(() => MediaPipeVideoDirectorService.parseAspectRatio('invalid')).toThrow(MissingInputError);
            expect(() => MediaPipeVideoDirectorService.parseAspectRatio('0:16')).toThrow(/not a ratio/);
        });
    });

    describe('No dry runs: nothing is reported for a video that was not read', () => {
        it('tracking and reframing a missing video fail, with no canned poses, sizes or crop', async () => {
            const { MissingInputError } = await import('../src/common/errors/pipeline-errors');
            // The review's probes: these used to return 30 canned walking poses (confidence 0.88) and a 1920x1080 crop plan.
            await expect(directorService.trackVideoMotion({ videoPath: '/nonexistent/clip.mp4', fps: 15, dryRun: true } as any))
                .rejects.toBeInstanceOf(MissingInputError);
            await expect(directorService.autoReframeVideo({ inputVideoPath: '/nonexistent/portrait.mp4', targetAspectRatio: '9:16', dryRun: true } as any))
                .rejects.toBeInstanceOf(MissingInputError);
        });

        it('reframes from the probed size of the real input (a portrait clip is not treated as 1920x1080)', async () => {
            const fs = await import('fs');
            const os = await import('os');
            const path = await import('path');
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-reframe-probe-'));
            const video = path.join(dir, 'portrait.mp4');
            fs.writeFileSync(video, 'not decoded by the fake editor');
            const crops: any[] = [];
            const editor: any = {
                probeMedia: async () => ({ width: 720, height: 1280, durationSec: 1.0 }),
                extractKeyframes: async ({ timestampsSec }: { timestampsSec: number[] }) => ({
                    outputPaths: timestampsSec.map((_, i) => { const f = path.join(dir, `f${i}.png`); fs.writeFileSync(f, `frame ${i}`); return f; })
                }),
                quickEdit: async (args: any) => { crops.push(args.crop.box); return { success: true, ffmpegCommand: 'ffmpeg (fake)' }; }
            };
            const lms = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
            const pose: any = { runPoseLandmarker: async () => ({ detection: { imageLandmarks: [lms], worldLandmarks: [lms] } }) };
            const result = await new MediaPipeVideoDirectorService(editor, pose).autoReframeVideo({ inputVideoPath: video, targetAspectRatio: '1:1' });
            expect(result.inputDimensions).toEqual({ width: 720, height: 1280 });
            expect(result.cropDimensions).toEqual({ width: 720, height: 720 });
            expect(result.dryRun).toBeUndefined();
            expect(crops).toHaveLength(1);
            fs.rmSync(dir, { recursive: true, force: true });
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
