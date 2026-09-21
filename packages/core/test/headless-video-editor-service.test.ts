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

    describe('Storyboard Sheet (Dry Run)', () => {
        it('constructs mosaic grid with timecode burn and tile filter', async () => {
            const result = await service.generateStoryboardSheet({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/storyboard.png',
                columns: 3,
                rows: 3,
                cellWidth: 640,
                cellHeight: 360,
                labelTimecode: true,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('tile=3x3:nb_frames=9');
            expect(result.commandString).toContain('drawtext=text=');
            expect(result.commandString).toContain('scale=640:360');
            expect(result.commandString).toContain('-frames:v 1');
        });
    });

    describe('3D LUT Grading (Dry Run)', () => {
        it('constructs 100% intensity tetrahedral LUT3D filter', async () => {
            const result = await service.applyLutGrade({
                inputPath: '/workspace/input.mp4',
                lutPath: '/workspace/kodak_2383.cube',
                outputPath: '/workspace/graded.mp4',
                intensity: 1.0,
                interpolation: 'tetrahedral',
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain("lut3d=file='/workspace/kodak_2383.cube':interp=tetrahedral");
            expect(result.commandString).toContain('-pix_fmt yuv420p');
            expect(result.commandString).toContain('-movflags +faststart');
        });

        it('constructs blended intensity filter graph when intensity < 1.0', async () => {
            const result = await service.applyLutGrade({
                inputPath: '/workspace/input.mp4',
                lutPath: '/workspace/kodak_2383.cube',
                outputPath: '/workspace/graded_75.mp4',
                intensity: 0.75,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('blend=all_mode=normal:all_opacity=0.75');
            expect(result.commandString).toContain('-map [v]');
        });
    });

    describe('Chroma Keying (Dry Run)', () => {
        it('constructs green screen chromakey with despill and background overlay', async () => {
            const result = await service.applyChromaKey({
                inputPath: '/workspace/fg_green.mp4',
                backgroundPath: '/workspace/bg_plate.mp4',
                outputPath: '/workspace/composite.mp4',
                keyColor: 'green',
                similarity: 0.12,
                blend: 0.08,
                spillSuppression: true,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('chromakey=0x00FF00:0.12:0.08,despill=green');
            expect(result.commandString).toContain('overlay=0:0:shortest=1');
            expect(result.commandString).toContain('-pix_fmt yuv420p');
        });
    });

    describe('Conditioning Maps (Dry Run)', () => {
        it('constructs Sobel edge conditioning map', async () => {
            const result = await service.generateConditioningMap({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/edge_map.mp4',
                mapType: 'edge',
                strength: 1.5,
                threshold: 0.1,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('format=gray,sobel=scale=3.00,lut=y=val-26,format=yuv420p');
            expect(result.commandString).toContain('-an');
            expect(result.commandString).toContain('-pix_fmt yuv420p');
        });

        it('constructs height/displacement conditioning map', async () => {
            const result = await service.generateConditioningMap({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/height_map.mp4',
                mapType: 'height',
                strength: 2.0,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('format=gray,lut=y=(val-128)*2.00+128,format=yuv420p');
        });
    });

    describe('Camera Motion Stabilization (Dry Run)', () => {
        it('constructs two-pass vidstabdetect and vidstabtransform pipeline', async () => {
            const result = await service.stabilizeMotion({
                inputPath: '/workspace/drone_shake.mp4',
                outputPath: '/workspace/drone_stable.mp4',
                shakiness: 8,
                accuracy: 12,
                smoothing: 45,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commands?.length).toBe(2);
            expect(result.commands?.[0]).toContain('vidstabdetect=stepsize=6:shakiness=8:accuracy=12');
            expect(result.commands?.[1]).toContain('vidstabtransform=input=');
            expect(result.commands?.[1]).toContain('smoothing=45');
        });
    });

    describe('Seamless Loop (Dry Run)', () => {
        it('constructs ping-pong reverse concat loop', async () => {
            const result = await service.createSeamlessLoop({
                inputPath: '/workspace/ambient.mp4',
                outputPath: '/workspace/ambient_loop.mp4',
                mode: 'ping_pong',
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('reverse[rev]');
            expect(result.commandString).toContain('concat=n=2:v=1:a=0');
        });

        it('constructs temporal crossfade transition loop', async () => {
            const result = await service.createSeamlessLoop({
                inputPath: '/workspace/ambient.mp4',
                outputPath: '/workspace/ambient_xfade.mp4',
                mode: 'crossfade',
                crossfadeDurationSec: 1.5,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('xfade=transition=fade:duration=1.500:offset=0');
        });
    });

    describe('Audio Loudness Normalization (Dry Run)', () => {
        it('constructs EBU R128 loudnorm filter with video copy', async () => {
            const result = await service.normalizeAudioLoudness({
                inputPath: '/workspace/video_quiet.mp4',
                outputPath: '/workspace/video_normalized.mp4',
                targetLufs: -14,
                loudnessRange: 7,
                truePeak: -1.0,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('loudnorm=I=-14:LRA=7:TP=-1');
            expect(result.commandString).toContain('-c:v copy');
            expect(result.commandString).toContain('-c:a aac');
        });
    });

    describe('Audio Ducking (Dry Run)', () => {
        it('constructs sidechain compression ducking filter complex', async () => {
            const result = await service.duckAudio({
                musicTrackPath: '/workspace/bg_music.mp3',
                voiceoverTrackPath: '/workspace/voice.wav',
                outputPath: '/workspace/mixed_audio.mp4',
                threshold: 0.08,
                ratio: 4,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('sidechaincompress=threshold=0.08:ratio=4:attack=50:release=500');
            expect(result.commandString).toContain('amix=inputs=2:dropout_transition=0');
        });
    });

    describe('Frame Sequence Encoding (Dry Run)', () => {
        it('constructs numbered frame sequence ingestion with progressive faststart', async () => {
            const result = await service.encodeFrameSequence({
                framePattern: '/workspace/renders/frame_%04d.png',
                outputPath: '/workspace/render_output.mp4',
                fps: 24,
                codec: 'h264',
                crf: 18,
                faststart: true,
                dryRun: true
            });

            expect(result.success).toBe(true);
            expect(result.commandString).toContain('-framerate 24');
            expect(result.commandString).toContain('-i /workspace/renders/frame_%04d.png');
            expect(result.commandString).toContain('-c:v libx264');
            expect(result.commandString).toContain('-pix_fmt yuv420p');
            expect(result.commandString).toContain('-movflags +faststart');
        });
    });
});
