/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, vi } from 'vitest';
import * as assert from 'assert';
import { CameraPose6DOF } from '../src/node/spatial/SubPixelEdgeAlignmentOptimizer';
import { RenderMesh3D } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { NativeAiRenderEngineService } from '../src/node/spatial/NativeAiRenderEngineService';
import { SpatialSmartPointInpaintService } from '../src/node/spatial/SpatialSmartPointInpaintService';
import { MeshAiTextureBakingService } from '../src/node/spatial/MeshAiTextureBakingService';
import { SceneKeyframeVideoService } from '../src/node/spatial/SceneKeyframeVideoService';

// Create a simple test mesh (a triangle)
const testMesh: RenderMesh3D = {
    vertices: new Float32Array([
        0, 0, 0,
        1, 0, 0,
        0, 1, 0
    ]),
    indices: new Uint32Array([
        0, 1, 2
    ])
};

const testPose: CameraPose6DOF = {
    x: 0,
    y: 0,
    z: 5,
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    up: [0, 1, 0],
    fov: 60
};

describe('Native 3D Engine AI Render & Keyframing Suite', () => {
    describe('1. NativeAiRenderEngineService', () => {
        it('can extract render passes (clay, depth, mist, normal)', () => {
            const service = new NativeAiRenderEngineService();
            const passes = service.extractRenderPasses(testMesh, testPose, 64, 48);

            expect(passes.width).toBe(64);
            expect(passes.height).toBe(48);
            expect(passes.clay).toBeInstanceOf(Buffer);
            expect(passes.clay.length).toBeGreaterThan(0);
            expect(passes.depth).toBeInstanceOf(Float32Array);
            expect(passes.depth.length).toBe(64 * 48);
            expect(passes.mist).toBeInstanceOf(Buffer); // Mist is encoded grayscale image
            expect(passes.mist.length).toBeGreaterThan(0);
            expect(passes.normal).toBeInstanceOf(Buffer); // Normal shaded pass
            expect(passes.normal.length).toBeGreaterThan(0);
        });

        it('can synthesize an AI beauty frame using a mock generator', async () => {
            const mockGenerator = {
                name: 'mock-beautify',
                generate: vi.fn(async () => Buffer.from('beauty-frame-data'))
            };
            const service = new NativeAiRenderEngineService({ generator: mockGenerator });
            const result = await service.renderAiBeautyFrame({
                mesh: testMesh,
                pose: testPose,
                prompt: 'Golden hour stone temple',
                width: 64,
                height: 48
            });

            expect(result.image).toEqual(Buffer.from('beauty-frame-data'));
            expect(result.width).toBe(64);
            expect(result.height).toBe(48);
            expect(mockGenerator.generate).toHaveBeenCalled();
        });
    });

    describe('2. SpatialSmartPointInpaintService', () => {
        it('can project a 3D smart point to screen coordinate and construct a mask', () => {
            const service = new SpatialSmartPointInpaintService();
            // Point (0, 0, 0) should project to the center of the viewport
            const result = service.projectSmartPointToMask(testMesh, testPose, [0, 0, 0], 10, 100, 100);

            expect(result.x).toBeCloseTo(50, 0);
            expect(result.y).toBeCloseTo(50, 0);
            expect(result.mask).toBeInstanceOf(Buffer);
            expect(result.mask.length).toBeGreaterThan(0);
            
            // Center of the mask should be projected to near 50, 50
            expect(result.x).toBeCloseTo(50, 0);
            expect(result.y).toBeCloseTo(50, 0);
        });

        it('can execute spatial inpainting using a mock editor client', async () => {
            const mockClient = {
                models: {
                    generateContent: vi.fn(async () => ({
                        candidates: [{
                            content: {
                                parts: [{
                                    inlineData: {
                                        mimeType: 'image/png',
                                        data: Buffer.from('inpainted-result').toString('base64')
                                    }
                                }]
                            }
                        }]
                    }))
                }
            } as any;

            const service = new SpatialSmartPointInpaintService({ client: mockClient });
            const result = await service.executeSpatialInpaint({
                image: Buffer.from('base-image'),
                mask: Buffer.from('mask-image'),
                prompt: 'Add an ivy climber here'
            });

            expect(result.image.toString()).toBe('inpainted-result');
            expect(mockClient.models.generateContent).toHaveBeenCalled();
        });
    });

    describe('3. MeshAiTextureBakingService', () => {
        it('can generate a 6-camera orthogonal rig around a mesh', () => {
            const service = new MeshAiTextureBakingService();
            const rig = service.generateOrthogonalCameraRig(testMesh);

            expect(rig).toHaveLength(6);
            expect(rig[0].name).toBe('Front');
            expect(rig[1].name).toBe('Back');
            expect(rig[2].name).toBe('Left');
            expect(rig[3].name).toBe('Right');
            expect(rig[4].name).toBe('Top');
            expect(rig[5].name).toBe('Bottom');

            // All poses should look towards the mesh center (0.5, 0.5, 0)
            for (const camera of rig) {
                expect(camera.pose.targetX).toBeCloseTo(0.5, 1);
                expect(camera.pose.targetY).toBeCloseTo(0.5, 1);
                expect(camera.pose.targetZ).toBeCloseTo(0, 1);
            }
        });

        it('can perform mock multi-angle texture baking', async () => {
            const mockGenerator = {
                generate: vi.fn(async () => Buffer.from('baked-view-texture'))
            };
            const service = new MeshAiTextureBakingService({ generator: mockGenerator });
            const result = await service.bakeMeshTexturesWithAi({
                mesh: testMesh,
                stylePrompt: 'Rusty iron panels',
                width: 32,
                height: 32
            });

            expect(result.views).toHaveLength(6);
            expect(result.views[0].name).toBe('Front');
            expect(result.views[0].image).toEqual(Buffer.from('baked-view-texture'));
            expect(mockGenerator.generate).toHaveBeenCalledTimes(6);
        });
    });

    describe('4. SceneKeyframeVideoService', () => {
        it('can capture a keyframe pair', () => {
            const service = new SceneKeyframeVideoService();
            const startPose = testPose;
            const endPose = { ...testPose, x: 2, y: 1 };
            const pair = service.captureKeyframePair(testMesh, startPose, endPose, 64, 48);

            expect(pair.start.clay).toBeInstanceOf(Buffer);
            expect(pair.end.clay).toBeInstanceOf(Buffer);
        });

        it('can plan and synthesize keyframe interpolation video using a mock client', async () => {
            const mockClient = {
                interactions: {
                    create: vi.fn(async () => ({
                        steps: [{
                            model_output: {
                                content: {
                                    parts: [{
                                        inlineData: {
                                            data: Buffer.from('interpolated-video-bytes').toString('base64')
                                        }
                                    }]
                                }
                            }
                        }]
                    }))
                }
            } as any;

            const service = new SceneKeyframeVideoService({ client: mockClient });
            const result = await service.synthesizeKeyframeInterpolationVideo({
                mesh: testMesh,
                startPose: testPose,
                endPose: { ...testPose, x: 2 },
                prompt: 'Camera sweeps around temple',
                width: 64,
                height: 48
            });

            expect(result.video).toEqual(Buffer.from('interpolated-video-bytes'));
            expect(mockClient.interactions.create).toHaveBeenCalled();
        });
    });
});
