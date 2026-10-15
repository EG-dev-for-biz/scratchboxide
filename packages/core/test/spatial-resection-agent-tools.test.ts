import { describe, it, expect } from 'vitest';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { buildSystemInstruction } from '../src/node/gemini/prompt-builder';
import type { GeminiGenerateRequest } from '../src/common/gemini-protocol';
import { KNOWN_RESECTION_LANDMARKS } from '../src/node/spatial/GeoBoxPrecisionResectionService';

/** A surveyed reference pose passed explicitly; resolution never picks one from words in the prompt hint. */
function fixturePose(key: keyof typeof KNOWN_RESECTION_LANDMARKS) {
    const f = KNOWN_RESECTION_LANDMARKS[key];
    return {
        targetLandmarkName: f.name,
        targetCoords: { lat: f.targetCoords.lat, lng: f.targetCoords.lng, alt: f.groundElevation },
        cameraOpticalCenter: { lat: f.vantageCoords.lat, lng: f.vantageCoords.lng, alt: f.vantageCoords.altitudeMeters },
        headingDeg: f.headingDeg,
        pitchDeg: f.pitchDeg,
        glbPath: f.glbPath
    };
}


describe('Spatial 2D-to-3D Resection & Pose Estimation Agent Tools', () => {
    const registry = createDefaultToolRegistry();

    describe('1. Gemini Agent Tools Dispatch & Execution', () => {
        it('should dispatch spatial_solve_pnp with RANSAC outlier rejection', async () => {
            // Ground truth camera extrinsics: looking down +Z with camera translation [0, 0, 50]
            const fx = 1000, fy = 1000, cx = 500, cy = 500;
            const t_gt = [0, 0, 50];

            const basePoints3D = [
                [-10, -8, 20],
                [12, -6, 25],
                [15, 10, 30],
                [-8, 14, 22],
                [0, 18, 35],
                [6, -12, 18]
            ];

            const basePoints2D = basePoints3D.map(([X, Y, Z]) => {
                const xc = X + t_gt[0];
                const yc = Y + t_gt[1];
                const zc = Z + t_gt[2];
                return {
                    x: fx * (xc / zc) + cx,
                    y: fy * (yc / zc) + cy
                };
            });

            // Inject 2 outliers
            const points3D = [
                ...basePoints3D.map(([x, y, z]) => ({ x, y, z })),
                { x: 999, y: 999, z: 999 },
                { x: -500, y: 400, z: -100 }
            ];
            const points2D = [
                ...basePoints2D,
                { x: 10, y: 10 },
                { x: 950, y: 50 }
            ];

            const response = await registry.dispatch('spatial_solve_pnp', {
                points2D,
                points3D,
                imageWidth: 1000,
                imageHeight: 1000,
                focalLengthPx: 1000,
                useRansac: true,
                ransacReprojThresholdPx: 3.0
            }, {} as any);

            expect(response.exec.status).toBe('completed');
            expect(response.exec.summaryResult).toContain('solvePnPRansac');
            expect(response.exec.summaryResult).toContain('inliers');

            const payload: any = response.resultPayload;
            expect(payload.inlierCount).toBe(6);
            expect(payload.pose.meanReprojectionErrorPx).toBeLessThan(0.01);
            expect(payload.pose.translationCamera[0]).toBeCloseTo(0, 1);
            expect(payload.pose.translationCamera[1]).toBeCloseTo(0, 1);
            expect(payload.pose.translationCamera[2]).toBeCloseTo(50, 1);
        });

        it('should dispatch spatial_solve_pnp in closed-form non-RANSAC mode', async () => {
            const fx = 1000, fy = 1000, cx = 500, cy = 500;
            const t_gt = [0, 0, 40];

            const points3D = [
                [-8, -6, 15],
                [10, -5, 20],
                [12, 8, 25],
                [-6, 10, 18],
                [2, 14, 28]
            ];

            const points2D = points3D.map(([X, Y, Z]) => {
                const xc = X + t_gt[0];
                const yc = Y + t_gt[1];
                const zc = Z + t_gt[2];
                return [
                    fx * (xc / zc) + cx,
                    fy * (yc / zc) + cy
                ];
            });

            const response = await registry.dispatch('spatial_solve_pnp', {
                points2D,
                points3D,
                imageWidth: 1000,
                imageHeight: 1000,
                focalLengthPx: 1000,
                useRansac: false
            }, {} as any);

            expect(response.exec.status).toBe('completed');
            expect(response.exec.summaryResult).toContain('solvePnP:');
            const payload: any = response.resultPayload;
            expect(payload.meanReprojectionErrorPx).toBeLessThan(0.01);
            expect(payload.translationCamera[2]).toBeCloseTo(40, 1);
        });

        it('should dispatch spatial_match_features_2d_3d and extract correspondences', async () => {
            const response = await registry.dispatch('spatial_match_features_2d_3d', {
                queryImagePath: 'public/test_images/storefront.jpg',
                maxKeypoints: 200,
                loweRatio: 0.80,
                crossCheck: true
            }, {} as any);

            expect(response.exec.status).toBe('completed');
            expect(response.exec.summaryResult).toContain('Extracted visual features');
            expect(response.exec.summaryResult).toContain('query keypoints');

            const payload: any = response.resultPayload;
            expect(payload.queryKeypointsCount).toBeGreaterThan(0);
            expect(payload.referenceKeypointsCount).toBeGreaterThan(0);
            expect(payload.matchesCount).toBeGreaterThan(0);
        });

        it('should dispatch spatial_closed_loop_edge_align and converge to high overlap', async () => {
            const response = await registry.dispatch('spatial_closed_loop_edge_align', {
                imagePath: 'public/test_images/building.jpg',
                meshBoxCenter: [0, 10, 0],
                meshBoxSize: [10, 20, 15],
                initialPose: { x: 1.5, y: 10.5, z: -38.5, targetX: 0, targetY: 10, targetZ: 0, fov: 46.0 },
                maxIterations: 15,
                targetOverlapScore: 98.0,
                subpixelTolerancePx: 0.15
            }, {} as any);

            expect(response.exec.status).toBe('completed');
            expect(response.exec.summaryResult).toContain('Closed-loop edge optimization converged');

            const payload: any = response.resultPayload;
            expect(payload.overlapScorePercent).toBeGreaterThan(90.0);
            expect(payload.subpixelResidualPx).toBeLessThan(0.5);
        });

        it('should dispatch geobox_closed_loop_edge_align identically', async () => {
            const response = await registry.dispatch('geobox_closed_loop_edge_align', {
                imagePath: 'public/test_images/building.jpg',
                initialPose: { x: 1.0, y: 10.2, z: -39.0, targetX: 0, targetY: 10, targetZ: 0, fov: 45.5 },
                maxIterations: 10
            }, {} as any);

            expect(response.exec.status).toBe('completed');
            const payload: any = response.resultPayload;
            expect(payload.overlapScorePercent).toBeGreaterThan(90.0);
        });

        it('should dispatch spatial_resect_image_location and geobox_resect_image_location', async () => {
            const response1 = await registry.dispatch('spatial_resect_image_location', {
                ...fixturePose('colosseum'),
                promptHint: 'Colosseum Rome dusk vantage point',
                sensorFocalMm: 26.0,
                optimizeTo100Percent: true
            }, {} as any);

            expect(response1.exec.status).toBe('completed');
            expect(response1.exec.summaryResult).toContain('Camera pose for Colosseum');
            const payload1: any = response1.resultPayload;
            // The pose evidence is reported; no edge overlap is claimed for a photo that was never read.
            expect(payload1.edgeAlignment).toBeUndefined();
            expect(payload1.imageAnalysed).toBe(false);
            expect(payload1.poseSource).toMatch(/stated camera position/);

            const response2 = await registry.dispatch('geobox_resect_image_location', {
                ...fixturePose('colosseum'),
                promptHint: 'Colosseum Rome dusk vantage point'
            }, {} as any);

            expect(response2.exec.status).toBe('completed');
            const payload2: any = response2.resultPayload;
            expect(payload2.cameraOpticalCenter.lat).toBeCloseTo(41.8908, 3);
        });
    });

    describe('2. Task Capability Resolver & Two-Tier Routing', () => {
        it('should resolve "solvepnp" to native Spatial Pose Estimator and spatial_solve_pnp tool', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'estimate camera pose using solvePnP from 2d-to-3d point correspondences'
            );

            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.nativeCapabilitiesUsed).toContain(
                'Spatial Pose Estimator (SpatialPoseEstimatorService.solvePnP, solvePnPRansac)'
            );
            expect(res.tier1Assessment.suggestedNativeAction?.serviceOrTool).toContain('SpatialPoseEstimatorService');
        });

        it('should resolve "feature matching 2d-to-3d" to native Visual Feature Matcher', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'perform 2d-to-3d feature matching on the photograph keypoints'
            );

            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.nativeCapabilitiesUsed).toContain(
                'Visual Feature Matcher (VisualFeatureMatcherService, Harris/FAST, 128-D descriptors, Lowe ratio)'
            );
        });

        it('should resolve "camera resection" to native resection pipeline', () => {
            const res = TaskCapabilityResolver.resolveTaskCapability(
                'perform camera resection to align this street photo with the 3D map tile'
            );

            expect(res.tier1Assessment.canSolveNatively).toBe(true);
            expect(res.tier1Assessment.nativeCapabilitiesUsed).toContain(
                'Closed-Loop Sub-Pixel Edge Alignment Optimizer (SubPixelEdgeAlignmentOptimizer, 100% overlap, < 0.1px)'
            );
        });
    });

    describe('3. Agent System Instruction Knowledge & Awareness', () => {
        it('should inject spatial resection tools and capabilities into compiled system instruction', async () => {
            const mockServices: any = {
                contextGraph: { buildContextSummary: () => '' },
                patternEngine: { getProjectPatterns: () => [] },
                lsp: { getDiagnosticSummary: () => '' },
                diffMemory: { buildDiffMemoryPromptContext: () => null },
                memories: { buildPromptInjectionText: async () => '' }
            };

            const req: GeminiGenerateRequest = {
                prompt: 'Test prompt',
                enableWorkspaceTools: true
            };

            const sysInstruction = await buildSystemInstruction(req, mockServices);

            expect(sysInstruction).toContain('spatial_solve_pnp');
            expect(sysInstruction).toContain('spatial_match_features_2d_3d');
            expect(sysInstruction).toContain('spatial_closed_loop_edge_align');
            expect(sysInstruction).toContain('geobox_resect_image_location');
            expect(sysInstruction).toContain('SpatialPoseEstimatorService');
            expect(sysInstruction).toContain('VisualFeatureMatcherService');
            expect(sysInstruction).toContain('HeadlessMeshSilhouetteRenderer');
            expect(sysInstruction).toContain('SubPixelEdgeAlignmentOptimizer');
        });
    });
});
