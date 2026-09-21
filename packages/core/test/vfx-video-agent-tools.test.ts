/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import {
    VFX_VIDEO_TOOL_DECLARATIONS,
    vfxVideoHandlers
} from '../src/node/gemini/tools/vfx-video-tools';
import { createDefaultToolRegistry, inferToolGroup } from '../src/node/gemini/tool-registry';

describe('VFX & FFmpeg Gemini Agent Tools', () => {
    const requiredToolNames = [
        'build_beautify_prompt',
        'vfx_ffmpeg_quick_edit',
        'vfx_ffmpeg_extract_frames',
        'vfx_ffmpeg_split_screen',
        'vfx_ffmpeg_storyboard_sheet',
        'vfx_ffmpeg_lut_grade',
        'vfx_ffmpeg_chromakey',
        'vfx_ffmpeg_controlnet_map',
        'vfx_ffmpeg_audio_normalize',
        'vfx_ffmpeg_seamless_loop',
        'vfx_ffmpeg_encode_sequence',
        'vfx_composite_patch',
        'vfx_composite_timeline'
    ];

    it('declares all expected VFX, video editing, and compositor tools', () => {
        const declaredNames = VFX_VIDEO_TOOL_DECLARATIONS.map(d => d.name);
        for (const name of requiredToolNames) {
            expect(declaredNames).toContain(name);
            expect(typeof vfxVideoHandlers[name]).toBe('function');
        }
    });

    it('infers workspace tool group for all vfx_ tools', () => {
        for (const name of requiredToolNames) {
            expect(inferToolGroup(name)).toBe('workspace');
        }
    });

    describe('Individual Tool Handlers (Dry Run)', () => {
        it('executes build_beautify_prompt and returns strict 3D framing prompt', async () => {
            const handler = vfxVideoHandlers['build_beautify_prompt'];
            const res = await handler({
                locationName: 'Statue of Liberty, New York',
                coords: '40.689249, -74.044500',
                heading: 135,
                aspectRatio: '16:9',
                distance: 250
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            const prompt = (res.resultPayload as any).prompt;
            expect(prompt).toContain('Statue of Liberty, New York');
            expect(prompt).toContain('40.689249, -74.044500');
            expect(prompt).toContain('16:9');
            expect(prompt).toContain('250 meters');
            expect(prompt).toContain('Preserve the EXACT same camera angle, pitch, yaw, viewpoint');
        });

        it('executes vfx_ffmpeg_quick_edit in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_quick_edit'];
            const res = await handler({
                inputPath: '/workspace/input.mp4',
                outputPath: '/workspace/output.mp4',
                startSec: 1.0,
                durationSec: 5.0,
                colorTemperatureKelvin: 5500,
                grainIntensity: 15,
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).commandString).toContain('-ss 1');
            expect((res.resultPayload as any).commandString).toContain('colortemperature=temperature=5500');
            expect((res.resultPayload as any).commandString).toContain('noise=alls=15:allf=t+u');
            expect(res.summaryResult).toContain('dry run');
        });

        it('throws error when required arguments are missing from vfx_ffmpeg_quick_edit', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_quick_edit'];
            await expect(handler({ inputPath: '/workspace/input.mp4' }, {} as any)).rejects.toThrow();
        });

        it('executes vfx_ffmpeg_extract_frames in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_extract_frames'];
            const res = await handler({
                inputPath: '/workspace/input.mp4',
                timestampsSec: [0, 2.5, 5.0],
                outputDir: '/workspace/frames',
                format: 'png',
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).outputPaths.length).toBe(3);
            expect(res.summaryResult).toContain('Extracted 3 keyframe(s)');
        });

        it('executes vfx_ffmpeg_split_screen in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_split_screen'];
            const res = await handler({
                leftVideoPath: '/workspace/left.mp4',
                rightVideoPath: '/workspace/right.mp4',
                outputPath: '/workspace/split.mp4',
                layout: 'horizontal',
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).commandString).toContain('hstack');
            expect(res.summaryResult).toContain('50/50 split comparison');
        });

        it('executes vfx_ffmpeg_storyboard_sheet in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_storyboard_sheet'];
            const res = await handler({
                inputPath: '/workspace/video.mp4',
                outputPath: '/workspace/storyboard.png',
                columns: 3,
                rows: 3,
                cellWidth: 640,
                cellHeight: 360,
                labelTimecode: true,
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).commandString).toContain('tile=3x3:nb_frames=9');
            expect(res.summaryResult).toContain('storyboard contact sheet');
        });

        it('executes vfx_ffmpeg_lut_grade in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_lut_grade'];
            const res = await handler({
                inputPath: '/workspace/video.mp4',
                lutPath: '/workspace/grade.cube',
                outputPath: '/workspace/graded.mp4',
                intensity: 1.0,
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).commandString).toContain("lut3d=file='/workspace/grade.cube'");
            expect(res.summaryResult).toContain('3D LUT grade');
        });

        it('executes vfx_ffmpeg_chromakey in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_chromakey'];
            const res = await handler({
                inputPath: '/workspace/green.mp4',
                backgroundPath: '/workspace/bg.mp4',
                outputPath: '/workspace/keyed.mp4',
                keyColor: 'green',
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).commandString).toContain('chromakey=0x00FF00');
            expect(res.summaryResult).toContain('chroma key composite');
        });

        it('executes vfx_ffmpeg_controlnet_map in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_controlnet_map'];
            const res = await handler({
                inputPath: '/workspace/video.mp4',
                outputPath: '/workspace/sobel.mp4',
                mapType: 'edge',
                strength: 1.5,
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).commandString).toContain('sobel=scale=3.00');
            expect(res.summaryResult).toContain('edge conditioning map');
        });

        it('executes vfx_ffmpeg_audio_normalize in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_audio_normalize'];
            const res = await handler({
                inputPath: '/workspace/video.mp4',
                outputPath: '/workspace/norm.mp4',
                targetLufs: -14,
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).commandString).toContain('loudnorm=I=-14');
            expect(res.summaryResult).toContain('audio loudness normalization');
        });

        it('executes vfx_ffmpeg_seamless_loop in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_seamless_loop'];
            const res = await handler({
                inputPath: '/workspace/video.mp4',
                outputPath: '/workspace/loop.mp4',
                mode: 'ping_pong',
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).commandString).toContain('reverse[rev]');
            expect(res.summaryResult).toContain('seamless ping_pong loop');
        });

        it('executes vfx_ffmpeg_encode_sequence in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_ffmpeg_encode_sequence'];
            const res = await handler({
                framePattern: '/workspace/frames_%04d.png',
                outputPath: '/workspace/video.mp4',
                fps: 24,
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).commandString).toContain('-framerate 24');
            expect(res.summaryResult).toContain('image sequence encode');
        });

        it('executes vfx_composite_patch in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_composite_patch'];
            const res = await handler({
                backgroundVideo: '/workspace/bg.mp4',
                patchMedia: '/workspace/patch.mp4',
                outputPath: '/workspace/composited.mp4',
                bbox: { x: 100, y: 200, width: 400, height: 300 },
                featherPixels: 16,
                grainIntensity: 18,
                duration: 6,
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).ffmpegCommand).toContain('scale=w=400:h=300:flags=lanczos');
            expect((res.resultPayload as any).ffmpegCommand).toContain('noise=alls=18:allf=t+u');
            expect((res.resultPayload as any).ffmpegCommand).toContain('overlay=x=100:y=200');
            expect(res.summaryResult).toContain('localized inpaint patch composite');
        });

        it('executes vfx_composite_timeline in dryRun mode', async () => {
            const handler = vfxVideoHandlers['vfx_composite_timeline'];
            const res = await handler({
                timeline: {
                    id: 'timeline_test',
                    fps: 24,
                    duration: 5,
                    tracks: [
                        {
                            id: 'track_1',
                            name: 'Video 1',
                            type: 'video',
                            muted: false,
                            elements: [
                                {
                                    id: 'el_1',
                                    type: 'video',
                                    startTime: 0,
                                    duration: 5,
                                    sourceUrl: '/workspace/clip.mp4'
                                }
                            ]
                        }
                    ]
                },
                outputPath: '/workspace/final.mp4',
                width: 1920,
                height: 1080,
                dryRun: true
            }, {} as any);

            expect(res.resultPayload.success).toBe(true);
            expect((res.resultPayload as any).ffmpegCommand).toBeDefined();
            expect(res.summaryResult).toContain('multi-track timeline composite');
        });
    });

    describe('ToolRegistry Dispatch', () => {
        const registry = createDefaultToolRegistry();

        it('has all VFX and FFmpeg tools registered', () => {
            for (const name of requiredToolNames) {
                expect(registry.has(name)).toBe(true);
            }
        });

        it('dispatches vfx_ffmpeg_split_screen through registry', async () => {
            const result = await registry.dispatch('vfx_ffmpeg_split_screen', {
                leftVideoPath: '/workspace/left.mp4',
                rightVideoPath: '/workspace/right.mp4',
                outputPath: '/workspace/comparison.mp4',
                dryRun: true
            }, {} as any);

            expect(result.exec.status).toBe('completed');
            expect(result.exec.summaryResult).toContain('50/50 split comparison');
            expect(result.exec.toolName).toBe('vfx_ffmpeg_split_screen');
            expect(result.resultPayload).toBeDefined();
        });
    });
});
