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
    deduceOptimalAspectRatio,
    deduceOptimalResolution,
    calculateMultiTilePlan,
    doBoxesIntersect,
    createCenteredClampedBox,
    BoundingBox
} from '../src/common/video-generative-patch';
import { HeadlessVideoCompositorService } from '../src/node/video/HeadlessVideoCompositorService';
import type { VideoTimelineData } from '../src/browser/generative-canvas/services/video/videoTypes';

describe('Generative Video Inpaint & VFX Patch Engine', () => {
    // ==========================================
    // 1. Dynamic Aspect Ratio Deduction (16:9 vs 9:16)
    // ==========================================
    describe('Aspect Ratio Deduction Solver', () => {
        const frame = { width: 1920, height: 1080 };

        it('selects 16:9 for wide horizontal defects (e.g. burned-in timecode)', () => {
            // Standard timecode window in lower third
            const bitcDefect: BoundingBox = {
                x: 100,
                y: 900,
                width: 500,
                height: 80
            };

            const decision = deduceOptimalAspectRatio(bitcDefect, frame);
            expect(decision.aspectRatio).toBe('16:9');
            expect(decision.cropBox.width).toBeGreaterThanOrEqual(bitcDefect.width);
            expect(decision.cropBox.height).toBeGreaterThanOrEqual(bitcDefect.height);
            expect(decision.reason).toContain('16:9 selected');
        });

        it('selects 9:16 for tall vertical defects (e.g. vertical boom mic / rigging)', () => {
            const verticalRig: BoundingBox = {
                x: 900,
                y: 100,
                width: 90,
                height: 600
            };

            const decision = deduceOptimalAspectRatio(verticalRig, frame);
            expect(decision.aspectRatio).toBe('9:16');
            expect(decision.cropBox.width).toBeGreaterThanOrEqual(verticalRig.width);
            expect(decision.cropBox.height).toBeGreaterThanOrEqual(verticalRig.height);
            expect(decision.reason).toContain('9:16 selected');
        });

        it('clamps crop box within canvas boundaries at frame edges', () => {
            const edgeDefect: BoundingBox = {
                x: 1850,
                y: 1000,
                width: 100,
                height: 50
            };

            const decision = deduceOptimalAspectRatio(edgeDefect, frame);
            expect(decision.cropBox.x + decision.cropBox.width).toBeLessThanOrEqual(frame.width);
            expect(decision.cropBox.y + decision.cropBox.height).toBeLessThanOrEqual(frame.height);
            expect(decision.cropBox.x).toBeGreaterThanOrEqual(0);
            expect(decision.cropBox.y).toBeGreaterThanOrEqual(0);
        });

        it('switches from 16:9 to 9:16 to avoid face collisions (dodging safety filter)', () => {
            // Defect where 16:9 would horizontally intersect an actor's face
            const defectNearFace: BoundingBox = {
                x: 500,
                y: 400,
                width: 180,
                height: 180
            };

            // Actor face directly to the right of the defect
            const actorFace: BoundingBox = {
                x: 700,
                y: 380,
                width: 160,
                height: 200
            };

            const decision = deduceOptimalAspectRatio(defectNearFace, frame, [actorFace]);
            // Because 16:9 extends horizontally into the face, 9:16 is preferred to dodge the filter
            expect(decision.aspectRatio).toBe('9:16');
            expect(decision.faceCollisions).toBe(0);
            expect(decision.reason).toContain('avoids face collision');
        });
    });

    // ==========================================
    // 2. Resolution Deduction Engine (720p vs 1080p vs 4K)
    // ==========================================
    describe('Resolution Deduction Solver (VFX Supersampling Invariant)', () => {
        it('deduces 720p for small crops (enforcing 2x+ supersampling)', () => {
            const smallCrop: BoundingBox = { x: 50, y: 50, width: 480, height: 270 };
            const decision = deduceOptimalResolution(smallCrop, '16:9');

            expect(decision.tier).toBe('720p');
            expect(decision.dimensions).toEqual({ width: 1280, height: 720 });
            expect(decision.samplingRatio).toBeGreaterThan(2.0);
            expect(decision.isSupersampled).toBe(true);
        });

        it('deduces 1080p for medium crops exceeding 1280px', () => {
            const medCrop: BoundingBox = { x: 100, y: 100, width: 1440, height: 810 };
            const decision = deduceOptimalResolution(medCrop, '16:9');

            expect(decision.tier).toBe('1080p');
            expect(decision.dimensions).toEqual({ width: 1920, height: 1080 });
            expect(decision.samplingRatio).toBeGreaterThanOrEqual(1.0);
            expect(decision.isSupersampled).toBe(true);
        });

        it('deduces 4K for large crops on 6K/8K plates to prevent upsampling blur', () => {
            // A 2560x1440 crop extracted from an 8K (8192x4320) raw negative
            const highResCrop: BoundingBox = { x: 1000, y: 1000, width: 2560, height: 1440 };
            const decision = deduceOptimalResolution(highResCrop, '16:9', '8k');

            expect(decision.tier).toBe('4k');
            expect(decision.dimensions).toEqual({ width: 3840, height: 2160 });
            expect(decision.samplingRatio).toBe(1.5);
            expect(decision.isSupersampled).toBe(true);
            expect(decision.reason).toContain('4K selected');
        });

        it('forces 720p when draft fidelity mode is requested for fast previews', () => {
            const largeCrop: BoundingBox = { x: 100, y: 100, width: 2560, height: 1440 };
            const decision = deduceOptimalResolution(largeCrop, '16:9', '4k', 'draft');

            expect(decision.tier).toBe('720p');
            expect(decision.dimensions).toEqual({ width: 1280, height: 720 });
            expect(decision.reason).toContain('draft preview');
        });

        it('properly configures 9:16 vertical resolution dimensions', () => {
            const vertCrop: BoundingBox = { x: 100, y: 100, width: 540, height: 960 };
            const decision = deduceOptimalResolution(vertCrop, '9:16');

            expect(decision.tier).toBe('720p');
            expect(decision.dimensions).toEqual({ width: 720, height: 1280 });
        });
    });

    // ==========================================
    // 3. Multi-Tile Decomposition
    // ==========================================
    describe('Multi-Tile Decomposition', () => {
        it('keeps single tile for spans within 3840px limit', () => {
            const standardBox: BoundingBox = { x: 0, y: 0, width: 1920, height: 1080 };
            const plan = calculateMultiTilePlan(standardBox);

            expect(plan.isMultiTile).toBe(false);
            expect(plan.tiles.length).toBe(1);
        });

        it('splits horizontal span exceeding 3840px into overlapping tiles', () => {
            // Extreme panoramic defect spanning 5000px on an 8K plate
            const wideBox: BoundingBox = { x: 0, y: 0, width: 5000, height: 1000 };
            const plan = calculateMultiTilePlan(wideBox, 3840, 0.15);

            expect(plan.isMultiTile).toBe(true);
            expect(plan.tiles.length).toBe(2);
            expect(plan.tiles[0].overlapPixels).toBeGreaterThan(0);
            expect(plan.tiles[1].cropBox.x).toBeLessThan(wideBox.width / 2);
        });
    });

    // ==========================================
    // 4. Full Compositor Integration (FFmpeg Filter Graph)
    // ==========================================
    describe('Headless Video Compositor Generative Patch Integration', () => {
        const headlessService = new HeadlessVideoCompositorService();

        const patchTimeline: VideoTimelineData = {
            id: 'timeline-vfx-patch',
            version: '1.0.0',
            duration: 5,
            fps: 24,
            currentTime: 0,
            tracks: [
                {
                    id: 'track-plate',
                    name: 'Archival 35mm Master Plate',
                    type: 'video',
                    visible: true,
                    elements: [
                        {
                            id: 'el-plate-1',
                            name: 'Documentary Reel Clip',
                            type: 'video',
                            startTime: 0,
                            duration: 5,
                            trimStart: 0,
                            trimEnd: 5,
                            url: '/plates/documentary_reel.mp4',
                            generativePatch: {
                                enabled: true,
                                mode: 'remove',
                                patchUrl: '/plates/bitc_inpaint_patch.mp4',
                                targetBox: {
                                    x: 120,
                                    y: 840,
                                    width: 640,
                                    height: 180
                                },
                                prompt: 'Remove burned-in timecode digits and restore natural background texture',
                                aspectRatio: '16:9',
                                resolutionTier: '720p',
                                featherRadius: 10,
                                matchGrain: true,
                                grainIntensity: 15
                            }
                        }
                    ]
                }
            ]
        };

        it('builds filtergraph with patch conform, Lanczos scaling, feathered alpha edge, and grain match', () => {
            const { filterComplex, inputs } = headlessService.buildFilterGraph(
                patchTimeline,
                { width: 1920, height: 1080 }
            );

            expect(filterComplex).toBeDefined();
            // Input 0: base canvas, Input 1: clip, Input 2: generative patch
            expect(inputs.length).toBe(3);

            // 1. Verify patch trim and FPS conform
            expect(filterComplex).toContain('fps=fps=24');

            // 2. Verify Lanczos downscaling to native crop box (640x180)
            expect(filterComplex).toContain('scale=w=640:h=180:flags=lanczos');

            // 3. Verify feathered alpha edge mask with geq filter
            expect(filterComplex).toContain('format=rgba,geq=');
            expect(filterComplex).toContain('X/10'); // feather radius 10

            // 4. Verify film grain matching pass
            expect(filterComplex).toContain('noise=alls=15:allf=t+u');

            // 5. Verify overlay positioning at (x=120, y=840)
            expect(filterComplex).toContain('overlay=x=120:y=840');
        });

        it('executes dry run successfully with generative patch active', async () => {
            const jobResult = await headlessService.execute({
                timeline: patchTimeline,
                outputPath: '/mock/workspace/output/bitc_inpaint_master.mp4',
                dryRun: true,
                format: 'mp4',
                crf: 17
            });

            expect(jobResult.success).toBe(true);
            expect(jobResult.ffmpegCommand).toContain('scale=w=640:h=180:flags=lanczos');
            expect(jobResult.ffmpegCommand).toContain('noise=alls=15:allf=t+u');
            expect(jobResult.ffmpegCommand).toContain('overlay=x=120:y=840');
            expect(jobResult.durationSec).toBe(5);
        });
    });
});
