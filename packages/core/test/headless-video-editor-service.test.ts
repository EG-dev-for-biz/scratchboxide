/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as fs from 'fs-extra';
import { HeadlessVideoEditorService } from '../src/node/video/HeadlessVideoEditorService';

describe('HeadlessVideoEditorService', () => {
    const service = new HeadlessVideoEditorService();
    const sampleVideoPath = path.resolve(__dirname, '../../../public/videos/interaction_input_video.mp4');

    describe('Binary Resolution', () => {
        it('resolves ffmpeg and ffprobe paths without throwing', () => {
            const ffmpeg = service.getFfmpegPath();
            const ffprobe = service.getFfprobePath();
            expect(ffmpeg).toBeDefined();
            expect(typeof ffmpeg).toBe('string');
            expect(ffprobe).toBeDefined();
            expect(typeof ffprobe).toBe('string');
        });
    });

    describe('Probe Metadata', () => {
        it('probes a real video file and extracts duration, dimensions, and streams', async () => {
            if (!(await fs.pathExists(sampleVideoPath))) {
                console.warn('Skipping real probe test: sample video does not exist');
                return;
            }

            const metadata = await service.probeMedia(sampleVideoPath);
            expect(metadata.durationSec).toBeGreaterThan(0);
            expect(metadata.width).toBeGreaterThan(0);
            expect(metadata.height).toBeGreaterThan(0);
            expect(metadata.fps).toBeGreaterThan(0);
            expect(metadata.format).toBe('mp4');
        });

        it('throws an informative error when probing non-existent file', async () => {
            await expect(service.probeMedia('/nonexistent/path/fake.mp4')).rejects.toThrow();
        });
    });

    describe('Quick Edit (Dry Run Pipeline Construction)', () => {
        it('constructs trim filter with fast seek and duration', async () => {
            const result = await service.quickEdit({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output_trim.mp4',
                trim: {
                    startSec: 2.5,
                    durationSec: 4.0
                },
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('-ss 2.5');
            expect(result.commandString).toContain('-t 4');
            expect(result.commandString).toContain('-movflags +faststart');
            expect(result.durationSec).toBe(4.0);
        });

        it('constructs aspect ratio crop filter (16:9)', async () => {
            const result = await service.quickEdit({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output_crop_169.mp4',
                crop: {
                    aspectRatio: '16:9'
                },
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('crop=w=min(iw\\,ih*16/9):h=min(ih\\,iw*9/16)');
        });

        it('constructs explicit bounding box crop filter', async () => {
            const result = await service.quickEdit({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output_crop_box.mp4',
                crop: {
                    box: { x: 100, y: 50, width: 640, height: 360 }
                },
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('crop=640:360:100:50');
        });

        it('constructs scale filter with even dimension clamping and aspect contain', async () => {
            const result = await service.quickEdit({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output_scale.mp4',
                scale: {
                    width: 1280,
                    height: 720,
                    fit: 'contain'
                },
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('scale=1280:720:force_original_aspect_ratio=decrease');
            expect(result.commandString).toContain('pad=1280:720:(ow-iw)/2:(oh-ih)/2');
        });

        it('constructs retiming speed multiplier filter', async () => {
            const result = await service.quickEdit({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output_slowmo.mp4',
                speedMultiplier: 0.5,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('setpts=2.0000*PTS');
            expect(result.commandString).toContain('atempo=0.50');
        });

        it('bakes Planckian Kelvin color balance, eq, film grain, and vignette', async () => {
            const result = await service.quickEdit({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output_graded.mp4',
                filterBake: {
                    colorTemperatureKelvin: 3200,
                    brightness: 0.05,
                    contrast: 1.15,
                    saturation: 1.1,
                    grainIntensity: 12,
                    vignetteAngle: 0.5
                },
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('colortemperature=temperature=3200');
            expect(result.commandString).toContain('contrast=1.150');
            expect(result.commandString).toContain('noise=alls=12:allf=t+u');
            expect(result.commandString).toContain('vignette=angle=0.5');
        });

        it('handles mute audio and audio remux options', async () => {
            const muteResult = await service.quickEdit({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output_muted.mp4',
                muteAudio: true,
                dryRun: true
            });
            expect(muteResult.commandString).toContain('-an');

            const remuxResult = await service.quickEdit({
                inputPath: '/workspace/video_only.mp4',
                outputPath: '/workspace/output_remuxed.mp4',
                remuxAudioPath: '/workspace/plate_audio.mp4',
                dryRun: true
            });
            expect(remuxResult.commandString).toContain('-i /workspace/plate_audio.mp4');
            expect(remuxResult.commandString).toContain('-map 0:v:0');
            expect(remuxResult.commandString).toContain('-map 1:a:0?');
            expect(remuxResult.commandString).toContain('-shortest');
        });

        it('constructs VP9 WebM and GIF commands properly', async () => {
            const webmResult = await service.quickEdit({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output.webm',
                format: 'webm',
                dryRun: true
            });
            expect(webmResult.commandString).toContain('libvpx-vp9');
            expect(webmResult.commandString).toContain('libopus');

            const gifResult = await service.quickEdit({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output.gif',
                format: 'gif',
                dryRun: true
            });
            expect(gifResult.commandString).toContain('palettegen');
            expect(gifResult.commandString).toContain('paletteuse');
        });
    });

    describe('Keyframe Extraction', () => {
        it('constructs hero frame extraction command with fast seek', async () => {
            const result = await service.extractKeyframes({
                inputPath: '/workspace/input.mp4',
                outputPathPattern: '/workspace/frames/frame_00.png',
                heroFrameOnly: true,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.outputPaths.length).toBe(1);
            expect(result.outputPaths[0]).toBe('/workspace/frames/frame_00.png');
            expect(result.commands?.[0]).toContain('-ss 0');
            expect(result.commands?.[0]).toContain('-frames:v 1');
        });

        it('constructs multi-timestamp extraction commands', async () => {
            const result = await service.extractKeyframes({
                inputPath: '/workspace/input.mp4',
                outputDir: '/workspace/keyframes',
                timestampsSec: [0, 1.5, 3.25],
                format: 'png',
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.outputPaths.length).toBe(3);
            expect(result.outputPaths[1]).toContain('_keyframe_1_');
            expect(result.commands?.[1]).toContain('-ss 1.5');
            expect(result.commands?.[2]).toContain('-ss 3.25');
        });
    });

    describe('Split-Screen Comparison', () => {
        it('constructs horizontal 50/50 side-by-side comparison command', async () => {
            const result = await service.createSplitScreen({
                leftVideoPath: '/workspace/blockout.mp4',
                rightVideoPath: '/workspace/synthesis.mp4',
                outputPath: '/workspace/comparison_5050.mp4',
                layout: 'horizontal',
                crf: 18,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('scale=960:1080');
            expect(result.commandString).toContain('hstack');
            expect(result.commandString).toContain('-crf 18');
            expect(result.commandString).toContain('-movflags +faststart');
        });

        it('constructs vertical split comparison command', async () => {
            const result = await service.createSplitScreen({
                leftVideoPath: '/workspace/top.mp4',
                rightVideoPath: '/workspace/bottom.mp4',
                outputPath: '/workspace/comparison_vert.mp4',
                layout: 'vertical',
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('scale=1920:1080');
            expect(result.commandString).toContain('vstack');
        });
    });

    describe('Concat Clips (Dry Run)', () => {
        it('plans normalization and lossless concat demuxer pass', async () => {
            const result = await service.concatClips({
                clipPaths: ['/workspace/clip1.mp4', '/workspace/clip2.mp4', '/workspace/clip3.mp4'],
                outputPath: '/workspace/master_assembly.mp4',
                targetFps: 30,
                targetDimensions: { width: 1920, height: 1080 },
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('-f concat');
            expect(result.commandString).toContain('-safe 0');
            expect(result.commandString).toContain('-c copy');
            expect(result.commandString).toContain('-movflags +faststart');
        });

        it('throws error when fewer than 2 clips provided', async () => {
            await expect(service.concatClips({
                clipPaths: ['/workspace/single.mp4'],
                outputPath: '/workspace/out.mp4'
            })).rejects.toThrow('at least 2 clips');
        });
    });
});
