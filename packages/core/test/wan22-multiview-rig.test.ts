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
    generateMultiViewCameraRig,
    buildFrameMotivatedPerformerVideoPrompt
} from '../src/browser/generative-canvas/services/video/omniVideoPromptService';
import {
    vfxVideoHandlers,
    VFX_VIDEO_TOOL_DECLARATIONS
} from '../src/node/gemini/tools/vfx-video-tools';
import {
    VideoTo4DPerformerPipelineService
} from '../src/node/spatial/VideoTo4DPerformerPipelineService';

describe('Multi-View Video Diffusion & Non-A-Pose Casual Ingestion', () => {
    describe('1. Multi-View Camera Rig Generator (generateMultiViewCameraRig)', () => {
        it('should generate canonical 6-view full orbit rig with correct orbital geometry', () => {
            const rig = generateMultiViewCameraRig('6-view-orbit');
            expect(rig.preset).toBe('6-view-orbit');
            expect(rig.totalCameras).toBe(6);
            expect(rig.cameras.length).toBe(6);
            expect(rig.viewsPerLayer).toBe(6);
            expect(rig.layerPitches).toEqual([0]);
            expect(rig.startYaw).toBe(0);
            expect(rig.yawSpan).toBe(360);
            expect(rig.radius).toBe(2.2);
            expect(rig.elevation).toBe(1.25);
            expect(rig.fov).toBe(50.0);

            // Front hero camera check (yaw = 0°)
            const cam0 = rig.cameras[0];
            expect(cam0.index).toBe(0);
            expect(cam0.yaw).toBe(0);
            expect(cam0.pitch).toBe(0);
            expect(cam0.position[0]).toBeCloseTo(0.0, 3);
            expect(cam0.position[1]).toBeCloseTo(1.25, 3);
            expect(cam0.position[2]).toBeCloseTo(2.2, 3);

            // LookAt must center on metric subject root (Y = 1.0)
            expect(cam0.lookAt).toEqual([0.0, 1.0, 0.0]);

            // All camera transforms must have valid 4x4 OpenCV and Nerfstudio/OpenGL matrices
            rig.cameras.forEach(cam => {
                expect(cam.transformMatrixOpencv.length).toBe(4);
                expect(cam.transformMatrixNerfstudio.length).toBe(4);
                // Nerfstudio OpenGL contract: cols 1 & 2 (Y and Z axes) must be inverted
                for (let row = 0; row < 3; row++) {
                    expect(cam.transformMatrixNerfstudio[row][0]).toBeCloseTo(cam.transformMatrixOpencv[row][0], 4);
                    expect(cam.transformMatrixNerfstudio[row][1]).toBeCloseTo(-cam.transformMatrixOpencv[row][1], 4);
                    expect(cam.transformMatrixNerfstudio[row][2]).toBeCloseTo(-cam.transformMatrixOpencv[row][2], 4);
                    expect(cam.transformMatrixNerfstudio[row][3]).toBeCloseTo(cam.transformMatrixOpencv[row][3], 4);
                }
            });
        });

        it('should generate 24-view dense orbit rig (15° steps for high-fidelity 4DGS training)', () => {
            const rig = generateMultiViewCameraRig('24-view-dense');
            expect(rig.preset).toBe('24-view-dense');
            expect(rig.totalCameras).toBe(24);
            expect(rig.cameras.length).toBe(24);
            expect(rig.viewsPerLayer).toBe(24);
            expect(rig.layerPitches).toEqual([0]);

            // Check uniform 15° angular steps
            for (let i = 0; i < 24; i++) {
                expect(rig.cameras[i].yaw).toBeCloseTo(i * 15, 2);
            }
        });

        it('should generate 48-view multi-pitch orbit rig across [-10°, 15°, 35°] layers', () => {
            const rig = generateMultiViewCameraRig('48-view-multipitch');
            expect(rig.preset).toBe('48-view-multipitch');
            expect(rig.totalCameras).toBe(48);
            expect(rig.cameras.length).toBe(48);
            expect(rig.viewsPerLayer).toBe(16);
            expect(rig.layerPitches).toEqual([-10, 15, 35]);

            // 16 cameras per pitch layer
            const layer0 = rig.cameras.filter(c => c.pitch === -10);
            const layer1 = rig.cameras.filter(c => c.pitch === 15);
            const layer2 = rig.cameras.filter(c => c.pitch === 35);
            expect(layer0.length).toBe(16);
            expect(layer1.length).toBe(16);
            expect(layer2.length).toBe(16);
        });

        it('should generate 24-view frontal arc rig across 180° frontal hemisphere', () => {
            const rig = generateMultiViewCameraRig('24-view-frontal-arc');
            expect(rig.preset).toBe('24-view-frontal-arc');
            expect(rig.totalCameras).toBe(24);
            expect(rig.viewsPerLayer).toBe(12);
            expect(rig.layerPitches).toEqual([0, 30]);
            expect(rig.startYaw).toBe(-90);
            expect(rig.yawSpan).toBe(180);

            // First camera in each layer should start at -90° (left lateral)
            expect(rig.cameras[0].yaw).toBeCloseTo(-90, 2);
            expect(rig.cameras[12].yaw).toBeCloseTo(-90, 2);
        });
    });

    describe('2. Non-A-Pose Video Conditioning Prompt (buildFrameMotivatedPerformerVideoPrompt)', () => {
        it('should NOT condition or force A-pose when hero frame is in casual stance', () => {
            const result = buildFrameMotivatedPerformerVideoPrompt({
                referenceFrameRef: '<IMAGE_REF_0>',
                subject: 'young male vocalist in black tailored jacket and dark trousers',
                heroPoseType: 'casual',
                heroPoseDescription: 'relaxed standing posture with arms resting naturally along flanks and thighs',
                videoMotion: 'singing passionately into handheld microphone, natural swaying, expressive gestures',
                cameraRigPreset: '6-view-orbit'
            });

            // Must NOT contain mandatory A-pose forcing language
            expect(result.prompt).not.toContain('symmetrical A-frame');
            expect(result.prompt).not.toContain('A-pose');
            expect(result.prompt).not.toContain('arms angled downward 35');
            expect(result.prompt).not.toContain('arms angled downward 45');

            // Must contain casual stance anchors and Frame 0 motivated syntax
            expect(result.prompt).toContain('<FIRST_FRAME><IMAGE_REF_0></FIRST_FRAME>');
            // Default video model backbone is Google Veo 2
            expect(result.prompt).toContain('veo-2.0-generate-001');
            expect(result.prompt).toContain('closed-loop orbital video conditioning');
            expect(result.cameraRig).toBeDefined();
            expect(result.cameraRig?.totalCameras).toBe(6);

            // Also test explicit Wan2.2-TI2V-5B fallback
            const wanResult = buildFrameMotivatedPerformerVideoPrompt({
                referenceFrameRef: '<IMAGE_REF_0>',
                subject: 'young male vocalist in black tailored jacket and dark trousers',
                videoModelBackbone: 'wan2.2-ti2v-5b',
                heroPoseType: 'casual',
                cameraRigPreset: '6-view-orbit'
            });
            expect(wanResult.prompt.toLowerCase()).toContain('wan2.2-ti2v-5b');
            expect(wanResult.prompt).toContain('Reference Context Packing (RCP)');
            expect(wanResult.prompt).toContain('Target Context Routing (TCR)');
        });

        it('should correctly condition A-frame pose ONLY when explicitly requested (heroPoseType === "a-pose")', () => {
            const result = buildFrameMotivatedPerformerVideoPrompt({
                referenceFrameRef: '<IMAGE_REF_0>',
                subject: 'dancer in white rehearsal leotard',
                heroPoseType: 'a-pose',
                videoMotion: 'fluid contemporary floor sequence',
                cameraRigPreset: '24-view-dense'
            });

            // Must contain canonical A-frame descriptors
            expect(result.prompt).toContain('symmetrical A-frame pose');
            expect(result.prompt).toContain('arms angled downward and outward 35-45 degrees');
            expect(result.cameraRig?.preset).toBe('24-view-dense');
            expect(result.cameraRig?.totalCameras).toBe(24);
        });
    });

    describe('3. VFX Video Gemini Agent Tools Execution Handlers', () => {
        it('should handle build_frame_motivated_performer_prompt with casual stance and rig preset', async () => {
            const handler = vfxVideoHandlers['build_frame_motivated_performer_prompt'];
            expect(handler).toBeDefined();

            const response = await handler({
                referenceFramePath: 'public/models/performer_4dgs/demos/10331522/canonical_frame.jpg',
                characterDescription: 'performer in grey studio',
                heroPoseType: 'casual',
                heroPoseDescription: 'natural standing posture',
                cameraRigPreset: '48-view-multipitch'
            }, {} as any);

            expect(response.resultPayload.heroPoseType).toBe('casual');
            expect(response.resultPayload.cameraRig.preset).toBe('48-view-multipitch');
            expect(response.resultPayload.videoModelBackbone).toBe('Wan2.2-TI2V-5B');
            expect(response.resultPayload.cameraRig.totalCameras).toBe(48);
            expect(response.resultPayload.prompt).toContain('<FIRST_FRAME>public/models/performer_4dgs/demos/10331522/canonical_frame.jpg</FIRST_FRAME>');
            expect(response.resultPayload.prompt).not.toContain('symmetrical A-frame pose');
            expect(response.resultPayload.negativePrompt).not.toContain('non-A-frame pose');
        });
    });

    describe('4. VideoTo4DPerformerPipelineService Ingestion Contract', () => {
        it('should validate frameMotivatedInput casual stance and cameraRigPreset schema', () => {
            const input = {
                videoPath: 'public/models/performer_4dgs/demos/10331522/canonical_frame.jpg',
                characterId: 'test_10331522',
                heroPoseType: 'casual' as const,
                cameraRigPreset: '24-view-frontal-arc' as const,
                frameMotivatedInput: {
                    referenceFramePath: 'public/models/performer_4dgs/demos/10331522/canonical_frame.jpg',
                    isAFramePose: false,
                    heroPoseType: 'casual' as const,
                    cameraRigPreset: '24-view-frontal-arc' as const,
                    videoDiffusionModel: 'Wan2.2-TI2V-5B' as const
                }
            };

            expect(input.frameMotivatedInput.heroPoseType).toBe('casual');
            expect(input.frameMotivatedInput.isAFramePose).toBe(false);
            expect(input.frameMotivatedInput.cameraRigPreset).toBe('24-view-frontal-arc');
            expect(input.frameMotivatedInput.videoDiffusionModel).toBe('Wan2.2-TI2V-5B');

            // Verify rig configuration generates matching viewpoints
            const rig = generateMultiViewCameraRig(input.frameMotivatedInput.cameraRigPreset);
            expect(rig.totalCameras).toBe(24);
            expect(rig.yawSpan).toBe(180);
        });
    });
});
