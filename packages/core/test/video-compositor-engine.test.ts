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
import { parseOrSynthesizeArtifact } from '../src/node/gemini/artifact-synthesis';
import { classifyFallbackPrompt } from '../src/browser/generative-canvas/hooks/sendMessageFallbacks';
import { synthesizeContextualVideoTimeline } from '../src/browser/generative-canvas/services/video/videoTimelineSynthesizer';
import { COMPOSITOR_VERT, COMPOSITOR_FRAG } from '../src/browser/generative-canvas/services/video/compositorShaders';
import { VideoCompositor } from '../src/browser/generative-canvas/services/video/VideoCompositor';
import { HeadlessVideoCompositorService } from '../src/node/video/HeadlessVideoCompositorService';
import type { VideoTimelineData, TimelineElement } from '../src/browser/generative-canvas/services/video/videoTypes';

describe('Video Compositing Engine - Full Stack Compositor & Headless Service', () => {
    const defaultRequest = {
        prompt: '',
        activeArtifact: undefined,
        chatHistory: [],
        sessionContext: {
            workspacePath: '/mock/workspace',
            activeFilePath: '/mock/workspace/project.sb',
            openFiles: [],
            projectType: 'generative'
        }
    };

    // ==========================================
    // 1. Classification & Routing Verification
    // ==========================================
    describe('Compositing Prompt Dispatch and Routing', () => {
        it('classifies green screen and chroma key prompts to video-timeline', () => {
            const result1 = classifyFallbackPrompt('Chroma key green screen background and place actor over cyber city', undefined, 'video', undefined);
            expect(result1.isVideoTimelineRequest).toBe(true);

            const result2 = classifyFallbackPrompt('Apply despill suppression and key out green backdrop', undefined, 'canvas', undefined);
            expect(result2.isVideoTimelineRequest).toBe(true);

            const result3 = classifyFallbackPrompt('Composite video with optical light wrap around edges', undefined, 'canvas', undefined);
            expect(result3.isVideoTimelineRequest).toBe(true);

            const result4 = classifyFallbackPrompt('Picture in picture PIP composite overlay in corner', undefined, 'video', undefined);
            expect(result4.isVideoTimelineRequest).toBe(true);
        });

        it('synthesizes artifact with video-timeline primitive for chroma key prompts', () => {
            const prompt = 'Chroma key green screen background and despill foreground subject';
            const prose = 'Configured green screen chroma keying and despill suppression on the foreground track.';
            const artifact = parseOrSynthesizeArtifact(prompt, prose, { ...defaultRequest, prompt }, []);

            expect(artifact.type).toBe('video-timeline');
            const data = artifact.data as VideoTimelineData;
            expect(data.tracks).toBeDefined();
            
            // Check that at least one element has keying enabled
            const allElements = data.tracks.flatMap(t => t.elements);
            const keyedElement = allElements.find(el => el.keying?.enabled);
            expect(keyedElement).toBeDefined();
            expect(keyedElement?.keying?.keyColor).toBe('#00ff00');
            expect(keyedElement?.keying?.despill).toBeGreaterThan(0);
        });

        it('synthesizes picture-in-picture affine transforms for PiP prompt', () => {
            const prompt = 'Add picture in picture PiP video composite overlay';
            const timeline = synthesizeContextualVideoTimeline(prompt, undefined, '/mock/workspace');
            
            const allElements = timeline.tracks.flatMap(t => t.elements);
            const pipElement = allElements.find(el => el.layerTransform && (el.layerTransform.scaleX ?? 1) < 1.0);
            expect(pipElement).toBeDefined();
            expect(pipElement?.layerTransform?.scaleX).toBe(0.45);
            expect(pipElement?.layerTransform?.scaleY).toBe(0.45);
            expect(pipElement?.layerTransform?.x).toBe(0.25);
            expect(pipElement?.layerTransform?.y).toBe(-0.25);
        });

        it('synthesizes blue screen keying when blue screen is mentioned', () => {
            const prompt = 'Key out blue screen plate and match foreground';
            const timeline = synthesizeContextualVideoTimeline(prompt, undefined, '/mock/workspace');
            
            const allElements = timeline.tracks.flatMap(t => t.elements);
            const blueKeyed = allElements.find(el => el.keying?.keyColor === '#0000ff');
            expect(blueKeyed).toBeDefined();
            expect(blueKeyed?.keying?.enabled).toBe(true);
        });
    });

    // ==========================================
    // 2. GLSL Shaders & Math Verification
    // ==========================================
    describe('GLSL Compositor Shaders Inspection', () => {
        it('includes YCbCr conversion and Euclidean distance keying uniforms', () => {
            expect(COMPOSITOR_FRAG).toContain('rgb2cbcr');
            expect(COMPOSITOR_FRAG).toContain('uniform vec3 uKeyColor;');
            expect(COMPOSITOR_FRAG).toContain('uniform float uKeyTolerance;');
            expect(COMPOSITOR_FRAG).toContain('uniform float uKeySoftness;');
            expect(COMPOSITOR_FRAG).toContain('uniform float uKeyDespill;');
            expect(COMPOSITOR_FRAG).toContain('uniform bool uKeyInvert;');
        });

        it('includes 2D affine transform and boundary clipping math', () => {
            expect(COMPOSITOR_FRAG).toContain('uniform vec2 uLayerPosition;');
            expect(COMPOSITOR_FRAG).toContain('uniform vec2 uLayerScale;');
            expect(COMPOSITOR_FRAG).toContain('uniform float uLayerRotation;');
            expect(COMPOSITOR_FRAG).toContain('getLayerUv');
        });

        it('includes optical light wrap radiance bleeding uniforms', () => {
            expect(COMPOSITOR_FRAG).toContain('uniform float uLightWrapIntensity;');
            expect(COMPOSITOR_FRAG).toContain('uniform float uLightWrapSpread;');
            expect(COMPOSITOR_FRAG).toContain('uniform sampler2D uMaskTexture;');
            expect(COMPOSITOR_FRAG).toContain('uniform bool uUseMask;');
        });
    });

    // ==========================================
    // 3. WebGL VideoCompositor Engine
    // ==========================================
    describe('VideoCompositor WebGL Engine Instance', () => {
        function createMockWebGLRenderer(): THREE.WebGLRenderer {
            return {
                setSize: () => {},
                getRenderTarget: () => null,
                setRenderTarget: () => {},
                setClearColor: () => {},
                clear: () => {},
                render: () => {},
                dispose: () => {},
                domElement: {
                    toDataURL: () => 'data:image/png;base64,mockPngDataUrl'
                }
            } as unknown as THREE.WebGLRenderer;
        }

        it('initializes cleanly and creates ping-pong render targets', () => {
            const mockRenderer = createMockWebGLRenderer();
            const compositor = new VideoCompositor({
                width: 1920,
                height: 1080,
                renderer: mockRenderer
            });

            const rt = compositor.getRenderTarget();
            expect(rt).toBeDefined();
            expect(rt.width).toBe(1920);
            expect(rt.height).toBe(1080);
            expect(rt.texture.format).toBe(THREE.RGBAFormat);

            compositor.dispose();
        });

        it('resizes internal render targets dynamically', () => {
            const mockRenderer = createMockWebGLRenderer();
            const compositor = new VideoCompositor({
                width: 1280,
                height: 720,
                renderer: mockRenderer
            });

            compositor.resize(3840, 2160);
            const rt = compositor.getRenderTarget();
            expect(rt.width).toBe(3840);
            expect(rt.height).toBe(2160);

            compositor.dispose();
        });

        it('renders layers and exports frame as data URL', () => {
            const mockRenderer = createMockWebGLRenderer();
            const compositor = new VideoCompositor({
                width: 1920,
                height: 1080,
                renderer: mockRenderer
            });

            const dummyTexture = new THREE.Texture();
            compositor.render([
                {
                    texture: dummyTexture,
                    opacity: 1.0,
                    blendMode: 'normal'
                },
                {
                    texture: dummyTexture,
                    opacity: 0.9,
                    blendMode: 'screen',
                    keying: {
                        enabled: true,
                        keyColor: '#00ff00',
                        tolerance: 40,
                        softness: 20,
                        despill: 70
                    },
                    layerTransform: {
                        x: 0.5,
                        y: -0.5,
                        scaleX: 0.5,
                        scaleY: 0.5
                    },
                    lightWrap: {
                        intensity: 0.5,
                        spread: 15
                    }
                }
            ]);

            const dataUrl = compositor.exportFrameAsDataUrl();
            expect(dataUrl).toBe('data:image/png;base64,mockPngDataUrl');

            compositor.dispose();
        });
    });

    // ==========================================
    // 4. Headless Video Compositor Service (FFmpeg)
    // ==========================================
    describe('HeadlessVideoCompositorService', () => {
        const headlessService = new HeadlessVideoCompositorService();

        const mockTimeline: VideoTimelineData = {
            id: 'mock-composite-timeline',
            version: '1.0.0',
            duration: 10,
            fps: 30,
            currentTime: 0,
            tracks: [
                {
                    id: 'track-v1',
                    name: 'Background Plate',
                    type: 'video',
                    visible: true,
                    elements: [
                        {
                            id: 'el-bg',
                            name: 'Cyber City Background',
                            type: 'video',
                            startTime: 0,
                            duration: 10,
                            trimStart: 0,
                            trimEnd: 10,
                            color: 'blue'
                        }
                    ]
                },
                {
                    id: 'track-v2',
                    name: 'Keyed Actor Plate',
                    type: 'overlay',
                    visible: true,
                    elements: [
                        {
                            id: 'el-actor',
                            name: 'Green Screen Actor',
                            type: 'video',
                            startTime: 0,
                            duration: 10,
                            trimStart: 0,
                            trimEnd: 10,
                            color: 'green',
                            keying: {
                                enabled: true,
                                keyColor: '#00ff00',
                                tolerance: 35,
                                softness: 15,
                                despill: 65
                            },
                            layerTransform: {
                                scaleX: 0.5,
                                scaleY: 0.5,
                                x: 0.25,
                                y: 0.1
                            }
                        }
                    ]
                },
                {
                    id: 'track-a1',
                    name: 'Atmospheric Audio',
                    type: 'audio',
                    visible: true,
                    elements: [
                        {
                            id: 'el-audio',
                            name: 'Ambient Score',
                            type: 'audio',
                            startTime: 0,
                            duration: 10,
                            trimStart: 0,
                            trimEnd: 10,
                            url: '/mock/workspace/audio.wav'
                        }
                    ]
                }
            ],
            globalGrade: {
                contrast: 15,
                saturation: 110
            }
        };

        it('detects ffmpeg binary in the host environment', async () => {
            const available = await headlessService.isFfmpegAvailable();
            expect(available).toBe(true);
        });

        it('builds a valid filter complex graph with chromakey, despill, scale, overlay, and eq', () => {
            const { filterComplex, videoOutputTag, audioOutputTag, inputs } = headlessService.buildFilterGraph(
                mockTimeline,
                { width: 1920, height: 1080 }
            );

            expect(filterComplex).toBeDefined();
            // Input 0 is base black color, Input 1 is bg, Input 2 is actor, Input 3 is audio
            expect(inputs.length).toBe(4);

            // Verify chroma keying filter is in filterComplex
            expect(filterComplex).toContain('chromakey=color=0x00FF00');
            expect(filterComplex).toContain('similarity=0.35:blend=0.15');

            // Verify despill suppression filter
            expect(filterComplex).toContain('despill=type=green:mix=0.65');

            // Verify spatial scaling
            expect(filterComplex).toContain('scale=w=960:h=540:flags=lanczos');

            // Verify overlay positioning expressions
            expect(filterComplex).toContain('overlay=x=');
            expect(filterComplex).toContain('between(t,0,10)');

            // Verify global color grading eq filter
            expect(filterComplex).toContain('eq=contrast=1.15:saturation=1.10');
            expect(videoOutputTag).toBe('[v_master_graded]');
            expect(audioOutputTag).toBe('[3:a]');
        });

        it('generates complete CLI execution string in dry run mode', async () => {
            const jobResult = await headlessService.execute({
                timeline: mockTimeline,
                outputPath: '/mock/workspace/output/composite_test.mp4',
                dryRun: true,
                format: 'mp4',
                crf: 18,
                preset: 'fast'
            });

            expect(jobResult.success).toBe(true);
            expect(jobResult.outputPath).toBe('/mock/workspace/output/composite_test.mp4');
            expect(jobResult.ffmpegCommand).toContain('ffmpeg');
            expect(jobResult.ffmpegCommand).toContain('-filter_complex');
            expect(jobResult.ffmpegCommand).toContain('libx264');
            expect(jobResult.ffmpegCommand).toContain('-crf 18');
            expect(jobResult.ffmpegCommand).toContain('-preset fast');
            expect(jobResult.ffmpegCommand).toContain('-pix_fmt yuv420p');
            expect(jobResult.durationSec).toBe(10);
        });
    });
});
