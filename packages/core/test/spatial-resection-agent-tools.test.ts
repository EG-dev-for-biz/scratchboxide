import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { encodePng } from '../src/node/texture-processing';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { skyscraperMesh, writeFixtureGlb } from './helpers/mesh-glb-fixtures';
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

        it('should dispatch spatial_match_features_2d_3d on the two given images and recover their offset', async () => {
            // A photo and a "render" of the same blocky texture, the render shifted by (+7, +4) px.
            const w = 200, h = 150, dx = 7, dy = 4;
            const texture = (x: number, y: number) => {
                const cell = ((Math.floor(x / 13) * 73856093) ^ (Math.floor(y / 11) * 19349663)) >>> 0;
                return 40 + (cell % 180);
            };
            const image = (shiftX: number, shiftY: number) => {
                const rgba = Buffer.alloc(w * h * 4);
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        const v = texture(x - shiftX + 50, y - shiftY + 50);
                        const i = (y * w + x) * 4;
                        rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
                    }
                }
                return encodePng(w, h, rgba);
            };
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-feature-match-'));
            const queryImagePath = path.join(dir, 'photo.png');
            const renderImagePath = path.join(dir, 'render.png');
            fs.writeFileSync(queryImagePath, image(0, 0));
            fs.writeFileSync(renderImagePath, image(dx, dy));
            try {
                const response = await registry.dispatch('spatial_match_features_2d_3d', {
                    queryImagePath,
                    renderImagePath,
                    maxKeypoints: 300,
                    loweRatio: 0.8,
                    crossCheck: true
                }, {} as any);

                expect(response.exec.status).toBe('completed');
                expect(response.exec.summaryResult).toContain(`Matched ${queryImagePath} against ${renderImagePath}`);
                const payload: any = response.resultPayload;
                expect(payload.queryImageSize).toEqual([w, h]);
                expect(payload.matchesCount).toBeGreaterThan(10);
                const offsets = payload.matches.map((m: any) => [m.point2[0] - m.point1[0], m.point2[1] - m.point1[1]]);
                const near = offsets.filter(([ox, oy]: number[]) => Math.abs(ox - dx) <= 1 && Math.abs(oy - dy) <= 1);
                expect(near.length / offsets.length).toBeGreaterThan(0.8);
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('spatial_match_features_2d_3d fails when an image is not given or does not exist (no synthetic images instead)', async () => {
            const missingRender = await registry.dispatch('spatial_match_features_2d_3d', { queryImagePath: 'photo.png' }, {} as any);
            expect(missingRender.exec.status).toBe('failed');
            expect(String((missingRender.resultPayload as any).error)).toContain('renderImagePath');

            const absent = await registry.dispatch('spatial_match_features_2d_3d', {
                queryImagePath: path.join(os.tmpdir(), 'no-such-photo.png'),
                renderImagePath: path.join(os.tmpdir(), 'no-such-render.png')
            }, {} as any);
            expect(absent.exec.status).toBe('failed');
            expect(String((absent.resultPayload as any).error)).toContain('does not exist');
        });

        it('closed-loop edge alignment works on the photograph and model it is given, and reports what it measured', async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-edge-align-'));
            try {
                // The model: a stepped tower. The "photograph": that model shaded from a pose the tool is not told.
                const glbPath = writeFixtureGlb(path.join(dir, 'tower.glb'), skyscraperMesh(10, 15, 20));
                const truth = { x: 0, y: 10, z: -40, targetX: 0, targetY: 10, targetZ: 0, fov: 45 };
                const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(glbPath);
                const photo = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, truth, 320, 240, { clayColor: [200, 196, 188] });
                const imagePath = path.join(dir, 'photo.png');
                fs.writeFileSync(imagePath, encodePng(320, 240, photo.rgba));

                const initialPose = { x: 2.5, y: 11, z: -38, targetX: 0.5, targetY: 10, targetZ: 0, fov: 47 };
                const response = await registry.dispatch('spatial_closed_loop_edge_align', {
                    imagePath, glbPath, initialPose, maxIterations: 20, targetEdgeCorrelation: 97, analysisMaxSide: 160
                }, {} as any);
                expect(response.exec.status).toBe('completed');
                const payload: any = response.resultPayload;
                expect(payload.finalEdgeCorrelationPct).toBeGreaterThan(payload.initialEdgeCorrelationPct);
                const off = (p: any) => Math.hypot(p.x - truth.x, p.y - truth.y, p.z - truth.z);
                expect(off(payload.finalPose)).toBeLessThan(off(initialPose));
                expect(payload.meanEdgeDistancePx, JSON.stringify({ final: payload.finalPose, d: payload.meanEdgeDistancePx, c: [payload.initialEdgeCorrelationPct, payload.finalEdgeCorrelationPct] })).toBeLessThan(3);
                expect(payload.imageSize).toEqual([320, 240]);
                expect(response.exec.summaryResult).toContain(`Aligned ${glbPath} to ${imagePath}: edge correlation`);
                expect(payload).not.toHaveProperty('metrologicalErrorMm');

                // Proof image: the photograph with the model's edges at the solved pose drawn in red.
                const edges = HeadlessMeshSilhouetteRenderer.renderEdgeField(mesh, payload.finalPose, 320, 240);
                let maxMag = 0;
                for (const m of edges.magnitudes) maxMag = Math.max(maxMag, m);
                const overlay = Buffer.from(photo.rgba);
                for (let i = 0; i < edges.magnitudes.length; i++) {
                    if (edges.magnitudes[i] >= maxMag * 0.25) { overlay[i * 4] = 255; overlay[i * 4 + 1] = 40; overlay[i * 4 + 2] = 40; }
                }
                const shots = path.resolve(__dirname, '../../../test-results/screenshots');
                fs.mkdirSync(shots, { recursive: true });
                fs.writeFileSync(path.join(shots, 'closed_loop_edge_align_solved_pose.png'), encodePng(320, 240, overlay));

                // The same tool under its other names, on the same inputs.
                const geobox = await registry.dispatch('geobox_closed_loop_edge_align', { imagePath, glbPath, initialPose, maxIterations: 2, analysisMaxSide: 96 }, {} as any);
                expect(geobox.exec.status).toBe('completed');
                const optimize = await registry.dispatch('geobox_optimize_edge_alignment', { imagePath, glbPath, initialPose, maxIterations: 2, analysisMaxSide: 96 }, {} as any);
                expect(optimize.exec.status).toBe('completed');

                // Nothing is assumed: no proxy box, no default pose, and a model out of view is an error.
                const noModel = await registry.dispatch('spatial_closed_loop_edge_align', { imagePath, initialPose }, {} as any);
                expect(String((noModel.resultPayload as any).error)).toContain('needs glbPath');
                const noPose = await registry.dispatch('spatial_closed_loop_edge_align', { imagePath, glbPath }, {} as any);
                expect(String((noPose.resultPayload as any).error)).toContain('initialPose');
                const away = await registry.dispatch('spatial_closed_loop_edge_align', {
                    imagePath, glbPath, initialPose: { x: 0, y: 10, z: -40, targetX: 0, targetY: 10, targetZ: -80, fov: 45 }
                }, {} as any);
                expect(String((away.resultPayload as any).error)).toContain('not in view');
            } finally {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        });

        it('declares the photograph, the model and the starting pose as required inputs', () => {
            for (const name of ['spatial_closed_loop_edge_align', 'geobox_closed_loop_edge_align', 'geobox_optimize_edge_alignment']) {
                const decl = registry.get(name)!.declaration;
                expect(decl.parameters!.required, name).toEqual(['imagePath', 'glbPath', 'initialPose']);
                expect(Object.keys(decl.parameters!.properties!), name).not.toContain('meshBoxCenter');
            }
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
                'Closed-Loop Edge Alignment (SubPixelEdgeAlignmentOptimizer: refines a camera pose against a given photo and model, reports the edge correlation it measured)'
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
