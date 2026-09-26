/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDeclaration, ToolHandler, ToolResultPayload } from './types';
import {
    AdaptiveMatchmoveCalibrationService,
    type AdaptiveMatchmoveContext,
    type SpatialAnchorCorrespondence,
    type LensIntrinsicsProfile,
    type KeyframeCalibrationState,
    type SequenceMetrologyReport,
    type OptimizationOptions,
    type TrajectoryFrameState,
    AdaptiveKeyframeDensityOptimizer,
    type MotionAdaptiveConfig,
    type KeyframeSelectionResult,
    type TrajectoryInputPoint
} from '../../spatial/AdaptiveMatchmoveCalibrationService';
import {
    ContinuousSplineMatchmoveService,
    type SplineKnot,
    type PersistentTrack3D2D,
    type SplineAnchorConstraint,
    type ContinuousSplineSolveOptions
} from '../../spatial/ContinuousSplineMatchmoveService';

function asString(val: unknown): string | undefined {
    return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function asNumber(val: unknown, fallback?: number): number | undefined {
    if (typeof val === 'number' && !Number.isNaN(val)) return val;
    if (typeof val === 'string' && val.trim() !== '') {
        const parsed = parseFloat(val);
        return !Number.isNaN(parsed) ? parsed : fallback;
    }
    return fallback;
}

function asBoolean(val: unknown, fallback = false): boolean {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') return val.toLowerCase() === 'true';
    return fallback;
}

function asVec3(val: unknown, fallback: [number, number, number]): [number, number, number] {
    if (Array.isArray(val) && val.length >= 3) {
        return [Number(val[0]) || 0, Number(val[1]) || 0, Number(val[2]) || 0];
    }
    return fallback;
}

// ============================================================================
// Tool Declarations
// ============================================================================

export const ADAPTIVE_MATCHMOVE_TOOL_DECLARATIONS: ToolDeclaration[] = [
    {
        name: 'adaptive_matchmove_calibrate_sequence',
        description: 'Calibrate and resect an entire multi-keyframe sequence adhering to Adaptive Domain Architecture. Solves camera 6-DOF poses, Brown-Conrady radial lens breathing (k1), and gimbal-free facade-normal slerp across milestones with sub-pixel precision (< 0.05 px RMS) using Levenberg-Marquardt bundle adjustment, synthesizes a C2 continuous Hermite trajectory spline, verifies drone kinematic safety (velocity < 15 m/s, accel < 10 m/s^2), and generates a SequenceMetrologyReport.',
        parameters: {
            type: 'OBJECT',
            properties: {
                sequencePath: {
                    type: 'STRING',
                    description: 'Optional path on disk to a sequence JSON file containing context and milestones.'
                },
                landmark: {
                    type: 'STRING',
                    description: 'Optional landmark name (e.g. "The Plaza Hotel") to automatically resolve context and spatial anchors.'
                },
                context: {
                    type: 'OBJECT',
                    description: 'AdaptiveMatchmoveContext object ({ sequenceId, fps, totalFrames, durationSec, plateResolution: { width, height }, facadeNormal }).'
                },
                milestones: {
                    type: 'ARRAY',
                    description: 'Array of KeyframeCalibrationState milestone objects containing spatial anchor correspondences and initial poses.'
                },
                outputCameraPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the exported 361-frame continuous camera path JSON.'
                },
                outputReportPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the formal SequenceMetrologyReport JSON.'
                },
                maxIterations: {
                    type: 'NUMBER',
                    description: 'Maximum Levenberg-Marquardt bundle adjustment iterations per keyframe (default: 40).'
                },
                tolerancePx: {
                    type: 'NUMBER',
                    description: 'Convergence tolerance in reprojection pixels (default: 0.02).'
                },
                initialDamping: {
                    type: 'NUMBER',
                    description: 'Initial Levenberg-Marquardt damping factor lambda (default: 0.001).'
                },
                huberThresholdPx: {
                    type: 'NUMBER',
                    description: 'Huber loss outlier downweighting threshold in pixels (default: 15.0).'
                },
                optimizeFov: {
                    type: 'BOOLEAN',
                    description: 'Whether to optimize vertical field of view during resection (default: false).'
                },
                optimizeK1: {
                    type: 'BOOLEAN',
                    description: 'Whether to optimize Brown-Conrady k1 radial distortion during resection (default: false).'
                }
            }
        }
    },
    {
        name: 'adaptive_matchmove_resect_keyframe',
        description: 'Perform high-precision 6-DOF optical camera resection for a single keyframe milestone using Damped Levenberg-Marquardt bundle adjustment and Huber robust downweighting against 3D-to-2D spatial anchor correspondences. Solves optimal camera position, target, up-vector, pitch attitude, standoff, and Brown-Conrady radial lens distortion.',
        parameters: {
            type: 'OBJECT',
            properties: {
                anchors: {
                    type: 'ARRAY',
                    description: 'Array of SpatialAnchorCorrespondence objects ({ id, label, point3D: [x, y, z], pixel2D: [u, v], weight }).'
                },
                cameraPosition: {
                    type: 'ARRAY',
                    description: 'Initial camera position [x, y, z] in metric local space.'
                },
                targetPosition: {
                    type: 'ARRAY',
                    description: 'Initial camera look-at target position [x, y, z] in metric local space.'
                },
                upVector: {
                    type: 'ARRAY',
                    description: 'Initial camera up-vector [x, y, z] (default: [0, 1, 0]).'
                },
                lens: {
                    type: 'OBJECT',
                    description: 'Initial lens intrinsics profile ({ fovYDeg, k1, k2, scale }).'
                },
                plateWidth: {
                    type: 'NUMBER',
                    description: 'Plate image width in pixels (default: 1920).'
                },
                plateHeight: {
                    type: 'NUMBER',
                    description: 'Plate image height in pixels (default: 1080).'
                },
                maxIterations: {
                    type: 'NUMBER',
                    description: 'Max LM iterations (default: 40).'
                },
                tolerancePx: {
                    type: 'NUMBER',
                    description: 'Convergence tolerance in pixels (default: 0.02).'
                },
                initialDamping: {
                    type: 'NUMBER',
                    description: 'Initial LM damping lambda (default: 0.001).'
                },
                huberThresholdPx: {
                    type: 'NUMBER',
                    description: 'Huber loss threshold in pixels (default: 15.0).'
                },
                optimizeFov: {
                    type: 'BOOLEAN',
                    description: 'Whether to optimize FOV during resection (default: false).'
                },
                optimizeK1: {
                    type: 'BOOLEAN',
                    description: 'Whether to optimize Brown-Conrady k1 radial coefficient during resection (default: false).'
                },
                imagePath: {
                    type: 'STRING',
                    description: 'Optional path on disk or URL to the keyframe plate image for automated pose extraction.'
                },
                autoExtractPose: {
                    type: 'BOOLEAN',
                    description: 'Whether to automatically extract 33 MediaPipe pose anchors from the image frame (default: false).'
                },
                subjectHeightMeters: {
                    type: 'NUMBER',
                    description: 'Estimated subject height in meters when autoExtractPose is enabled (default: 1.80).'
                }
            }
        }
    },
    {
        name: 'adaptive_matchmove_synthesize_trajectory',
        description: 'Synthesize a continuous C2 Hermite cubic spline trajectory from calibrated keyframe milestones with gimbal-free facade-normal slerp and full kinematic telemetry (velocity, acceleration, jerk) over time.',
        parameters: {
            type: 'OBJECT',
            properties: {
                milestones: {
                    type: 'ARRAY',
                    description: 'Array of KeyframeCalibrationState milestone objects.'
                },
                sequenceId: {
                    type: 'STRING',
                    description: 'Sequence identifier (default: "trajectory_sequence").'
                },
                fps: {
                    type: 'NUMBER',
                    description: 'Playback frame rate (default: 24).'
                },
                totalFrames: {
                    type: 'NUMBER',
                    description: 'Total sequence frame count (default: 361).'
                },
                durationSec: {
                    type: 'NUMBER',
                    description: 'Total sequence duration in seconds (default: 15.0).'
                },
                plateWidth: {
                    type: 'NUMBER',
                    description: 'Plate width in pixels (default: 1920).'
                },
                plateHeight: {
                    type: 'NUMBER',
                    description: 'Plate height in pixels (default: 1080).'
                },
                facadeNormal: {
                    type: 'ARRAY',
                    description: 'Facade normal unit vector [nx, ny, nz] (default: [-0.8746, 0.0, -0.4848]).'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the synthesized trajectory JSON.'
                }
            },
            required: ['milestones']
        }
    },
    {
        name: 'adaptive_matchmove_verify_metrology',
        description: 'Audit and verify camera trajectory and keyframe matchmove metrology against VFX photorealistic criteria: RMS reprojection residual < 0.05 px, Sobel edge correlation >= 98.0%, and physical drone kinematic thresholds.',
        parameters: {
            type: 'OBJECT',
            properties: {
                report: {
                    type: 'OBJECT',
                    description: 'SequenceMetrologyReport object to audit.'
                },
                reportPath: {
                    type: 'STRING',
                    description: 'Path on disk to a SequenceMetrologyReport JSON file.'
                },
                maxAllowedRmsPx: {
                    type: 'NUMBER',
                    description: 'Maximum allowable mean reprojection RMS residual in pixels (default: 0.05).'
                },
                minAllowedCorrelationPercent: {
                    type: 'NUMBER',
                    description: 'Minimum allowable Sobel edge normalized cross correlation percentage (default: 98.0).'
                },
                maxVelocityMps: {
                    type: 'NUMBER',
                    description: 'Maximum physical drone velocity limit in m/s (default: 15.0).'
                },
                maxAccelerationMps2: {
                    type: 'NUMBER',
                    description: 'Maximum physical drone acceleration limit in m/s^2 (default: 10.0).'
                }
            }
        }
    },
    {
        name: 'adaptive_matchmove_extract_pose_anchors',
        description: 'Intelligently extracts 3D-to-2D spatial anchor correspondences for a human or articulated subject from a plate image or video frame using MediaPipe / Gemini Multimodal vision and anatomical skeletal priors. Maps the 33 canonical MediaPipe/SMPL-X landmarks into metric 3D coordinates and sub-pixel 2D image coordinates, ready for 6-DOF optical camera resection.',
        parameters: {
            type: 'OBJECT',
            properties: {
                imagePath: {
                    type: 'STRING',
                    description: 'Path on disk or URL to the keyframe plate image.'
                },
                imageBase64: {
                    type: 'STRING',
                    description: 'Optional base64-encoded image string.'
                },
                plateWidth: {
                    type: 'NUMBER',
                    description: 'Plate image width in pixels (default: 1920).'
                },
                plateHeight: {
                    type: 'NUMBER',
                    description: 'Plate image height in pixels (default: 1080).'
                },
                subjectHeightMeters: {
                    type: 'NUMBER',
                    description: 'Estimated subject physical height in meters (default: 1.80).'
                },
                groundAltitudeMeters: {
                    type: 'NUMBER',
                    description: 'Floor / ground plane Y altitude in meters (default: 0.0).'
                },
                facingCamera: {
                    type: 'BOOLEAN',
                    description: 'Whether subject is facing towards the camera (default: true).'
                },
                minConfidence: {
                    type: 'NUMBER',
                    description: 'Minimum landmark detection confidence threshold (default: 0.3).'
                }
            }
        }
    },
    {
        name: 'adaptive_matchmove_optimize_keyframe_density',
        description: 'Optimizes variable-density keyframe allocation for camera matchmoving. Places dense keyframes during rapid camera movement, sharp turns, and accelerations, sparse keyframes during linear flight or hovers, and strictly pins Frame 1 (t=0) and Frame N (t=end) as immutable boundary anchors. Supports Recursive Error-Bisection (tolerance-bounded) and Cumulative Motion Saliency Integration.',
        parameters: {
            type: 'OBJECT',
            properties: {
                trajectory: {
                    type: 'ARRAY',
                    description: 'Array of trajectory frame objects containing timeSec, position [x,y,z], target [x,y,z], and optional up/fov.'
                },
                trajectoryPath: {
                    type: 'STRING',
                    description: 'Path to camera trajectory JSON file (e.g. public/models/plaza_hotel_camera_path.json).'
                },
                mode: {
                    type: 'STRING',
                    enum: ['error_bisection', 'cumulative_saliency', 'hybrid'],
                    description: 'Optimization strategy: error_bisection (tolerance-bounded, default), cumulative_saliency (budget-constrained), or hybrid.'
                },
                targetKeyframeCount: {
                    type: 'NUMBER',
                    description: 'Target keyframe count for cumulative_saliency mode. Default: 25.'
                },
                maxDriftTolerance: {
                    type: 'NUMBER',
                    description: 'Maximum allowable 3D interpolation drift (meters/scene units). Default: 0.05.'
                },
                minIntervalSec: {
                    type: 'NUMBER',
                    description: 'Minimum time interval between adjacent keyframes (seconds) to prevent micro-clustering. Default: 0.15.'
                },
                maxIntervalSec: {
                    type: 'NUMBER',
                    description: 'Maximum time interval between adjacent keyframes (seconds) to prevent blind spans. Default: 3.0.'
                },
                curvatureWeight: {
                    type: 'NUMBER',
                    description: 'Frenet-Serret spatial curvature sensitivity weight kappa(t). Default: 1.5.'
                },
                angularRateWeight: {
                    type: 'NUMBER',
                    description: 'Angular look-at velocity sensitivity weight omega(t). Default: 1.2.'
                },
                velocityWeight: {
                    type: 'NUMBER',
                    description: 'Linear velocity magnitude sensitivity weight. Default: 0.4.'
                },
                outputKeyframesPath: {
                    type: 'STRING',
                    description: 'Optional output path to save the selected keyframes JSON.'
                }
            }
        }
    },
    {
        name: 'continuous_spline_matchmove_optimize',
        description: 'Optimize continuous-time SE(3) Catmull-Rom spline camera trajectory knots against persistent multi-frame 2D tracks (TAPIR / optical flow), 3D anchor locks, and kinematic acceleration penalties via Levenberg-Marquardt.',
        parameters: {
            type: 'OBJECT',
            properties: {
                knots: {
                    type: 'ARRAY',
                    description: 'Array of SplineKnot objects with timeSec, position, target, up, fovYDeg, and optional k1.'
                },
                knotsPath: {
                    type: 'STRING',
                    description: 'Path on disk to load knots or camera path from.'
                },
                tracks: {
                    type: 'ARRAY',
                    description: 'Array of PersistentTrack3D2D with worldPoint3D and frame observations.'
                },
                tracksPath: {
                    type: 'STRING',
                    description: 'Path on disk to load persistent tracks from.'
                },
                anchors: {
                    type: 'ARRAY',
                    description: 'Array of SplineAnchorConstraint with timeSec, position, target, up, and weight.'
                },
                width: {
                    type: 'NUMBER',
                    description: 'Image viewport width in pixels (default: 1920).'
                },
                height: {
                    type: 'NUMBER',
                    description: 'Image viewport height in pixels (default: 1080).'
                },
                maxIterations: {
                    type: 'NUMBER',
                    description: 'Maximum Levenberg-Marquardt optimizer iterations (default: 25).'
                },
                tolerancePx: {
                    type: 'NUMBER',
                    description: 'Target RMS reprojection residual in pixels (default: 0.05).'
                },
                kinematicSmoothnessWeight: {
                    type: 'NUMBER',
                    description: 'Kinematic acceleration penalty weight (default: 1.0).'
                },
                huberLossThresholdPx: {
                    type: 'NUMBER',
                    description: 'Huber loss outlier rejection threshold in pixels (default: 4.0).'
                },
                enforceMonotonicDescent: {
                    type: 'BOOLEAN',
                    description: 'Enforce strictly non-increasing Y coordinate (downward descent).'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the optimized trajectory JSON.'
                }
            }
        }
    },
    {
        name: 'continuous_spline_synthesize_trajectory',
        description: 'Synthesize a dense per-frame 6-DOF camera trajectory table from continuous spline knots, complete with numerical velocity (m/s), acceleration (m/s^2), jerk (m/s^3), and unit quaternions.',
        parameters: {
            type: 'OBJECT',
            properties: {
                knots: {
                    type: 'ARRAY',
                    description: 'Array of SplineKnot objects.'
                },
                knotsPath: {
                    type: 'STRING',
                    description: 'Path on disk to load knots from.'
                },
                fps: {
                    type: 'NUMBER',
                    description: 'Framerate in frames per second (default: 24).'
                },
                durationSec: {
                    type: 'NUMBER',
                    description: 'Total flight duration in seconds (default: 10.0).'
                },
                exportSolveTrack: {
                    type: 'BOOLEAN',
                    description: 'When true, formats output as a canonical CameraSolveTrack.'
                },
                outputPath: {
                    type: 'STRING',
                    description: 'Optional path on disk to write the dense trajectory JSON.'
                }
            },
            required: ['knots']
        }
    }
];

// ============================================================================
// Tool Execution Handlers
// ============================================================================

export const adaptiveMatchmoveHandlers: Record<string, ToolHandler> = {
    adaptive_matchmove_calibrate_sequence: async (args, ctx) => {
        let context: AdaptiveMatchmoveContext | undefined = args.context as AdaptiveMatchmoveContext | undefined;
        let milestones: KeyframeCalibrationState[] | undefined = Array.isArray(args.milestones)
            ? (args.milestones as KeyframeCalibrationState[])
            : undefined;

        const sequencePath = asString(args.sequencePath);
        const landmark = asString(args.landmark);

        // Load milestones from the caller's sequence file when they are not passed inline
        if (!milestones || milestones.length === 0) {
            const candidateFile = sequencePath;
            if (candidateFile) {
                const absPath = path.isAbsolute(candidateFile) ? candidateFile : path.resolve(ctx.workspaceRoot || process.cwd(), candidateFile);
                if (fs.existsSync(absPath)) {
                    try {
                        const fileContent = fs.readFileSync(absPath, 'utf-8');
                        const parsed = JSON.parse(fileContent);
                        const rawList = (parsed.milestones && Array.isArray(parsed.milestones))
                            ? parsed.milestones
                            : (parsed.keyframes && Array.isArray(parsed.keyframes))
                                ? parsed.keyframes
                                : undefined;

                        if (rawList) {
                            milestones = rawList.map((m: any, idx: number) => ({
                                index: m.index ?? idx,
                                frameNumber: m.frameNumber ?? m.frame ?? (idx * 15 + 1),
                                timeSec: m.timeSec ?? m.time ?? (idx * 0.6),
                                phaseLabel: m.phaseLabel ?? m.phase ?? m.label ?? `Milestone ${idx}`,
                                cameraPosition: m.cameraPosition ?? m.position ?? [0, 0, 0],
                                targetPosition: m.targetPosition ?? m.target ?? [0, 0, 0],
                                upVector: m.upVector ?? [0, 1, 0],
                                pitchDeg: m.pitchDeg ?? 0,
                                standoffDist: m.standoffDist ?? 50,
                                lens: m.lens ?? {
                                    fovYDeg: m.fovYDeg ?? 50,
                                    aspectRatio: 16 / 9,
                                    k1: m.k1 ?? 0,
                                    k2: 0,
                                    scale: 1.0
                                },
                                anchors: m.anchors ?? [],
                                reprojectionRmsPx: m.reprojectionRmsPx ?? m.rmsPx ?? Number.NaN,
                                maxResidualPx: m.maxResidualPx ?? Number.NaN,
                                edgeCorrelationPercent: m.edgeCorrelationPercent ?? m.sobelNcc ?? Number.NaN,
                                converged: m.converged ?? false
                            }));
                        }
                        if (!context && parsed.sequenceId) {
                            context = {
                                sequenceId: parsed.sequenceId,
                                fps: parsed.fps ?? 24,
                                totalFrames: parsed.totalFrames ?? 361,
                                durationSec: parsed.durationSec ?? 15.0,
                                plateResolution: parsed.plateResolution ?? { width: 1920, height: 1080 },
                                facadeNormal: parsed.facadeNormal ?? [-0.8746, 0.0, -0.4848]
                            };
                        }
                    } catch (e: any) {
                        return {
                            resultPayload: { success: false, error: `Failed to parse sequence file: ${e.message}` },
                            status: 'failed',
                            summaryResult: `Error reading sequence file ${candidateFile}: ${e.message}`
                        };
                    }
                }
            }
        }

        if (!milestones || milestones.length === 0) {
            return {
                resultPayload: {
                    success: false,
                    error: 'adaptive_matchmove_calibrate_sequence: "milestones" array or a valid "sequencePath" is required.'
                },
                status: 'failed',
                summaryResult: 'Calibration failed: no milestones provided.'
            };
        }

        const rawCtx = context ?? {
            sequenceId: landmark ? `${landmark.replace(/\s+/g, '_').toLowerCase()}_seq` : 'adaptive_sequence',
            fps: 24,
            totalFrames: 361,
            durationSec: 15.0,
            plateResolution: { width: 1920, height: 1080 },
            facadeNormal: [-0.8746, 0.0, -0.4848]
        };

        const plateRes = Array.isArray((rawCtx as any).plateResolution)
            ? { width: (rawCtx as any).plateResolution[0], height: (rawCtx as any).plateResolution[1] }
            : (rawCtx.plateResolution ?? { width: 1920, height: 1080 });

        const effectiveContext: AdaptiveMatchmoveContext = {
            ...rawCtx,
            plateResolution: plateRes
        };

        const options: OptimizationOptions = {
            maxIterations: asNumber(args.maxIterations, 40),
            tolerancePx: asNumber(args.tolerancePx, 0.02),
            initialDamping: asNumber(args.initialDamping, 0.001),
            huberThresholdPx: asNumber(args.huberThresholdPx, 15.0),
            optimizeFov: asBoolean(args.optimizeFov, false),
            optimizeK1: asBoolean(args.optimizeK1, false)
        };

        const report: SequenceMetrologyReport = AdaptiveMatchmoveCalibrationService.calibrateSequence(
            milestones,
            effectiveContext,
            options
        );

        // Evaluate kinematic safety across trajectory
        let peakVelocity = 0.0;
        let peakAcceleration = 0.0;
        for (const frame of report.trajectory) {
            if ((frame.velocity ?? 0) > peakVelocity) peakVelocity = frame.velocity!;
            if ((frame.acceleration ?? 0) > peakAcceleration) peakAcceleration = frame.acceleration!;
        }

        const kinematicsSafe = peakVelocity <= 15.0 && peakAcceleration <= 10.0;

        // Optionally write files to disk
        const outputCameraPath = asString(args.outputCameraPath);
        if (outputCameraPath) {
            const absCamPath = path.isAbsolute(outputCameraPath) ? outputCameraPath : path.resolve(ctx.workspaceRoot || process.cwd(), outputCameraPath);
            fs.mkdirSync(path.dirname(absCamPath), { recursive: true });
            fs.writeFileSync(absCamPath, JSON.stringify(report.trajectory, null, 2), 'utf8');
        }

        const outputReportPath = asString(args.outputReportPath);
        if (outputReportPath) {
            const absRepPath = path.isAbsolute(outputReportPath) ? outputReportPath : path.resolve(ctx.workspaceRoot || process.cwd(), outputReportPath);
            fs.mkdirSync(path.dirname(absRepPath), { recursive: true });
            fs.writeFileSync(absRepPath, JSON.stringify(report, null, 2), 'utf8');
        }

        return {
            resultPayload: {
                success: report.status === 'PASSED',
                sequenceId: report.sequenceId,
                keyframeCount: report.keyframeCount,
                totalFrames: report.totalFrames,
                meanRmsResidualPx: report.meanRmsResidualPx,
                maxResidualPx: report.maxResidualPx,
                meanEdgeCorrelationPercent: report.meanEdgeCorrelationPercent,
                minEdgeCorrelationPercent: report.minEdgeCorrelationPercent,
                peakVelocityMps: peakVelocity,
                peakAccelerationMps2: peakAcceleration,
                kinematicsSafe,
                status: report.status,
                outputCameraPath,
                outputReportPath,
                trajectory: report.trajectory,
                metrologyReport: report,
                milestoneSummary: report.keyframes.map(k => ({
                    index: k.index,
                    frame: k.frameNumber,
                    timeSec: k.timeSec,
                    pitchDeg: k.pitchDeg,
                    standoffDist: k.standoffDist,
                    reprojectionRmsPx: k.reprojectionRmsPx,
                    edgeCorrelationPercent: k.edgeCorrelationPercent,
                    converged: k.converged
                }))
            } as ToolResultPayload,
            status: report.status === 'PASSED' ? 'completed' : 'failed',
            summaryResult: `Adaptive Matchmove Calibration ${report.status}: ${report.keyframeCount} keyframes, Mean RMS = ${report.meanRmsResidualPx} px (Target < 0.05 px), Edge NCC = ${report.meanEdgeCorrelationPercent}%, Peak Vel = ${peakVelocity.toFixed(2)} m/s.`
        };
    },

    adaptive_matchmove_resect_keyframe: async (args, _ctx) => {
        let anchors = args.anchors as SpatialAnchorCorrespondence[] | undefined;
        if (!anchors || !Array.isArray(anchors) || anchors.length === 0) {
            const imagePath = asString(args.imagePath);
            const imageBase64 = asString(args.imageBase64);
            if (imagePath || imageBase64 || args.autoExtractPose) {
                const input = imagePath
                    ? (path.isAbsolute(imagePath) ? imagePath : path.resolve(_ctx.workspaceRoot || process.cwd(), imagePath))
                    : (imageBase64 ?? '');
                const plateW = asNumber(args.plateWidth, 1920)!;
                const plateH = asNumber(args.plateHeight, 1080)!;
                const subHeight = asNumber(args.subjectHeightMeters, 1.80)!;
                anchors = await AdaptiveMatchmoveCalibrationService.extractPoseAnchorsFromImage(input, {
                    plateWidth: plateW,
                    plateHeight: plateH,
                    subjectHeightMeters: subHeight
                });
            }
        }

        if (!Array.isArray(anchors) || anchors.length === 0) {
            return {
                resultPayload: { success: false, error: 'adaptive_matchmove_resect_keyframe: "anchors" must be a non-empty array or "imagePath" provided with autoExtractPose.' },
                status: 'failed',
                summaryResult: 'Resection failed: anchors array is empty or missing.'
            };
        }

        const isHumanPose = anchors.length === 33 && anchors.some(a => a.id === 'NOSE' || a.category === 'head');
        const defaultCamPos: [number, number, number] = isHumanPose ? [0.0, 1.20, 3.20] : [0, 10, 20];
        const defaultTargetPos: [number, number, number] = isHumanPose ? [0.0, 0.95, 0.0] : [0, 0, 0];
        const defaultFov = isHumanPose ? 35.0 : 45.0;

        const cameraPosition = asVec3(args.cameraPosition, defaultCamPos);
        const targetPosition = asVec3(args.targetPosition, defaultTargetPos);
        const upVector = asVec3(args.upVector, [0, 1, 0]);

        const lensInput = (args.lens && typeof args.lens === 'object') ? (args.lens as Record<string, unknown>) : {};
        const lens: LensIntrinsicsProfile = {
            fovYDeg: asNumber(lensInput.fovYDeg, defaultFov)!,
            aspectRatio: asNumber(lensInput.aspectRatio, 16 / 9),
            k1: asNumber(lensInput.k1, 0.0)!,
            k2: asNumber(lensInput.k2, 0.0)!,
            scale: asNumber(lensInput.scale, 1.0)!
        };

        const width = asNumber(args.plateWidth, 1920)!;
        const height = asNumber(args.plateHeight, 1080)!;

        const options: OptimizationOptions = {
            maxIterations: asNumber(args.maxIterations, 40),
            tolerancePx: asNumber(args.tolerancePx, 0.02),
            initialDamping: asNumber(args.initialDamping, 0.001),
            huberThresholdPx: asNumber(args.huberThresholdPx, 15.0),
            optimizeFov: asBoolean(args.optimizeFov, false),
            optimizeK1: asBoolean(args.optimizeK1, false)
        };

        const calibrated = AdaptiveMatchmoveCalibrationService.solveKeyframeResection(
            anchors,
            cameraPosition,
            targetPosition,
            upVector,
            lens,
            width,
            height,
            options
        );

        return {
            resultPayload: {
                success: calibrated.converged || calibrated.reprojectionRmsPx < 0.05,
                cameraPosition: calibrated.cameraPosition,
                targetPosition: calibrated.targetPosition,
                upVector: calibrated.upVector,
                pitchDeg: calibrated.pitchDeg,
                standoffDist: calibrated.standoffDist,
                lens: calibrated.lens,
                reprojectionRmsPx: calibrated.reprojectionRmsPx,
                maxResidualPx: calibrated.maxResidualPx,
                edgeCorrelationPercent: calibrated.edgeCorrelationPercent,
                converged: calibrated.converged
            } as ToolResultPayload,
            status: 'completed',
            summaryResult: `Resected keyframe: RMS = ${calibrated.reprojectionRmsPx.toFixed(4)} px, Pitch = ${calibrated.pitchDeg.toFixed(1)}°, Standoff = ${calibrated.standoffDist.toFixed(1)}m, Converged = ${calibrated.converged}.`
        };
    },

    adaptive_matchmove_synthesize_trajectory: async (args, ctx) => {
        const milestones = args.milestones as KeyframeCalibrationState[];
        if (!Array.isArray(milestones) || milestones.length === 0) {
            return {
                resultPayload: { success: false, error: 'adaptive_matchmove_synthesize_trajectory: "milestones" array is required.' },
                status: 'failed',
                summaryResult: 'Trajectory synthesis failed: milestones array is empty.'
            };
        }

        const context: AdaptiveMatchmoveContext = {
            sequenceId: asString(args.sequenceId) ?? 'synthesized_trajectory',
            fps: asNumber(args.fps, 24)!,
            totalFrames: asNumber(args.totalFrames, 361)!,
            durationSec: asNumber(args.durationSec, 15.0)!,
            plateResolution: {
                width: asNumber(args.plateWidth, 1920)!,
                height: asNumber(args.plateHeight, 1080)!
            },
            facadeNormal: asVec3(args.facadeNormal, [-0.8746, 0.0, -0.4848])
        };

        const trajectory = AdaptiveMatchmoveCalibrationService.synthesizeSplineTrajectory(milestones, context);

        let peakVelocity = 0.0;
        let peakAcceleration = 0.0;
        for (const frame of trajectory) {
            if ((frame.velocity ?? 0) > peakVelocity) peakVelocity = frame.velocity!;
            if ((frame.acceleration ?? 0) > peakAcceleration) peakAcceleration = frame.acceleration!;
        }

        const kinematicsSafe = peakVelocity <= 15.0 && peakAcceleration <= 10.0;

        const outputPath = asString(args.outputPath);
        if (outputPath) {
            const absPath = path.isAbsolute(outputPath) ? outputPath : path.resolve(ctx.workspaceRoot || process.cwd(), outputPath);
            fs.mkdirSync(path.dirname(absPath), { recursive: true });
            fs.writeFileSync(absPath, JSON.stringify(trajectory, null, 2), 'utf8');
        }

        return {
            resultPayload: {
                success: true,
                totalFrames: trajectory.length,
                durationSec: context.durationSec,
                fps: context.fps,
                peakVelocityMps: Number(peakVelocity.toFixed(3)),
                peakAccelerationMps2: Number(peakAcceleration.toFixed(3)),
                kinematicsSafe,
                sampleFrames: [
                    trajectory[0],
                    trajectory[Math.floor(trajectory.length / 2)],
                    trajectory[trajectory.length - 1]
                ],
                outputPath
            } as ToolResultPayload,
            status: 'completed',
            summaryResult: `Synthesized C2 Hermite spline: ${trajectory.length} frames (${context.durationSec}s @ ${context.fps} fps), Peak Vel = ${peakVelocity.toFixed(2)} m/s, Peak Acc = ${peakAcceleration.toFixed(2)} m/s², Kinematics Safe = ${kinematicsSafe}.`
        };
    },

    adaptive_matchmove_verify_metrology: async (args, ctx) => {
        let report: SequenceMetrologyReport | undefined = (args.report && typeof args.report === 'object')
            ? (args.report as SequenceMetrologyReport)
            : undefined;

        const reportPath = asString(args.reportPath);
        if (!report && reportPath) {
            const absPath = path.isAbsolute(reportPath) ? reportPath : path.resolve(ctx.workspaceRoot || process.cwd(), reportPath);
            if (fs.existsSync(absPath)) {
                try {
                    report = JSON.parse(fs.readFileSync(absPath, 'utf8'));
                } catch (e: any) {
                    return {
                        resultPayload: { success: false, error: `Failed to read report file: ${e.message}` },
                        status: 'failed',
                        summaryResult: `Verification failed: could not parse ${reportPath}.`
                    };
                }
            }
        }

        if (!report) {
            return {
                resultPayload: { success: false, error: 'adaptive_matchmove_verify_metrology: "report" object or "reportPath" is required.' },
                status: 'failed',
                summaryResult: 'Verification failed: no report provided.'
            };
        }

        const maxAllowedRmsPx = asNumber(args.maxAllowedRmsPx, 0.05)!;
        const minAllowedCorrelationPercent = asNumber(args.minAllowedCorrelationPercent, 98.0)!;
        const maxVelocityMps = asNumber(args.maxVelocityMps, 15.0)!;
        const maxAccelerationMps2 = asNumber(args.maxAccelerationMps2, 10.0)!;

        const rmsPass = report.meanRmsResidualPx <= maxAllowedRmsPx;
        const corrPass = report.meanEdgeCorrelationPercent >= minAllowedCorrelationPercent;

        let peakVel = 0.0;
        let peakAcc = 0.0;
        if (Array.isArray(report.trajectory)) {
            for (const f of report.trajectory) {
                if ((f.velocity ?? 0) > peakVel) peakVel = f.velocity!;
                if ((f.acceleration ?? 0) > peakAcc) peakAcc = f.acceleration!;
            }
        }

        const velPass = peakVel <= maxVelocityMps;
        const accPass = peakAcc <= maxAccelerationMps2;

        const overallPass = rmsPass && corrPass && velPass && accPass;

        return {
            resultPayload: {
                success: overallPass,
                passed: overallPass,
                evaluations: {
                    reprojectionRms: {
                        measuredPx: report.meanRmsResidualPx,
                        thresholdPx: maxAllowedRmsPx,
                        pass: rmsPass
                    },
                    edgeCorrelation: {
                        measuredPercent: report.meanEdgeCorrelationPercent,
                        minPercent: minAllowedCorrelationPercent,
                        pass: corrPass
                    },
                    droneVelocity: {
                        measuredMps: Number(peakVel.toFixed(2)),
                        limitMps: maxVelocityMps,
                        pass: velPass
                    },
                    droneAcceleration: {
                        measuredMps2: Number(peakAcc.toFixed(2)),
                        limitMps2: maxAccelerationMps2,
                        pass: accPass
                    }
                },
                keyframeCount: report.keyframeCount,
                totalFrames: report.totalFrames
            } as ToolResultPayload,
            status: overallPass ? 'completed' : 'failed',
            summaryResult: overallPass
                ? `Metrology Verified (PASS): Mean RMS = ${report.meanRmsResidualPx} px <= ${maxAllowedRmsPx} px, NCC = ${report.meanEdgeCorrelationPercent}% >= ${minAllowedCorrelationPercent}%, Peak Vel = ${peakVel.toFixed(2)} m/s.`
                : `Metrology Audit FAILED: RMS Pass = ${rmsPass}, NCC Pass = ${corrPass}, Velocity Pass = ${velPass}, Accel Pass = ${accPass}.`
        };
    },

    adaptive_matchmove_extract_pose_anchors: async (args, ctx) => {
        const imagePath = asString(args.imagePath);
        const imageBase64 = asString(args.imageBase64);
        const input = imagePath
            ? (path.isAbsolute(imagePath) ? imagePath : path.resolve(ctx.workspaceRoot || process.cwd(), imagePath))
            : (imageBase64 ?? '');

        const plateWidth = asNumber(args.plateWidth, 1920)!;
        const plateHeight = asNumber(args.plateHeight, 1080)!;
        const subjectHeightMeters = asNumber(args.subjectHeightMeters, 1.80)!;
        const groundAltitudeMeters = asNumber(args.groundAltitudeMeters, 0.0)!;
        const facingCamera = asBoolean(args.facingCamera, true)!;
        const minConfidence = asNumber(args.minConfidence, 0.3)!;

        const anchors = await AdaptiveMatchmoveCalibrationService.extractPoseAnchorsFromImage(input, {
            plateWidth,
            plateHeight,
            subjectHeightMeters,
            groundAltitudeMeters,
            facingCamera,
            minConfidence
        });

        return {
            resultPayload: {
                success: anchors.length > 0,
                anchorCount: anchors.length,
                anchors,
                plateResolution: { width: plateWidth, height: plateHeight },
                subjectHeightMeters,
                groundAltitudeMeters
            } as ToolResultPayload,
            status: 'completed',
            summaryResult: `Extracted ${anchors.length} spatial pose correspondences (MediaPipe 33 rig, height = ${subjectHeightMeters}m, resolution = ${plateWidth}x${plateHeight}).`
        };
    },

    adaptive_matchmove_optimize_keyframe_density: async (args, ctx) => {
        let frames: TrajectoryInputPoint[] | undefined = Array.isArray(args.trajectory)
            ? (args.trajectory as TrajectoryInputPoint[])
            : undefined;

        const trajectoryPath = asString(args.trajectoryPath);
        if (!frames || frames.length === 0) {
            let candidatePath = trajectoryPath;
            if (!candidatePath) {
                const defaultPath = path.resolve(ctx.workspaceRoot || process.cwd(), 'public/models/plaza_hotel_camera_path.json');
                if (fs.existsSync(defaultPath)) {
                    candidatePath = defaultPath;
                }
            }
            if (candidatePath) {
                const absPath = path.isAbsolute(candidatePath) ? candidatePath : path.resolve(ctx.workspaceRoot || process.cwd(), candidatePath);
                if (fs.existsSync(absPath)) {
                    try {
                        const content = fs.readFileSync(absPath, 'utf8');
                        const parsed = JSON.parse(content);
                        const rawFrames = Array.isArray(parsed) ? parsed : (parsed.frames || parsed.trajectory);
                        if (Array.isArray(rawFrames)) {
                            frames = rawFrames.map((f: any, idx: number) => ({
                                timeSec: typeof f.timeSec === 'number' ? f.timeSec : (typeof f.time === 'number' ? f.time : idx / 24.0),
                                position: asVec3(f.position, [0, 0, 0]),
                                target: asVec3(f.target, [0, 0, 0]),
                                up: f.up ? asVec3(f.up, [0, 1, 0]) : undefined,
                                fov: asNumber(f.fov, 40)
                            }));
                        }
                    } catch (e: any) {
                        return {
                            resultPayload: { success: false, error: `Failed to read trajectory from ${candidatePath}: ${e.message}` },
                            status: 'failed',
                            error: e.message
                        };
                    }
                }
            }
        }

        if (!frames || frames.length === 0) {
            return {
                resultPayload: { success: false, error: 'No trajectory frames provided or discovered on disk.' },
                status: 'failed',
                error: 'Missing trajectory frames'
            };
        }

        const config: MotionAdaptiveConfig = {
            mode: (args.mode as any) || 'error_bisection',
            targetKeyframeCount: asNumber(args.targetKeyframeCount, 25),
            maxDriftTolerance: asNumber(args.maxDriftTolerance, 0.05),
            minIntervalSec: asNumber(args.minIntervalSec, 0.15),
            maxIntervalSec: asNumber(args.maxIntervalSec, 3.0),
            curvatureWeight: asNumber(args.curvatureWeight, 1.5),
            angularRateWeight: asNumber(args.angularRateWeight, 1.2),
            velocityWeight: asNumber(args.velocityWeight, 0.4)
        };

        const result: KeyframeSelectionResult = AdaptiveKeyframeDensityOptimizer.optimizeFromTrajectory(
            frames,
            undefined,
            config
        );

        const outputPath = asString(args.outputKeyframesPath);
        if (outputPath) {
            const absOut = path.isAbsolute(outputPath) ? outputPath : path.resolve(ctx.workspaceRoot || process.cwd(), outputPath);
            fs.mkdirSync(path.dirname(absOut), { recursive: true });
            fs.writeFileSync(absOut, JSON.stringify(result, null, 2), 'utf8');
        }

        return {
            resultPayload: {
                success: true,
                totalFrames: result.totalFrames,
                totalKeyframes: result.totalKeyframes,
                compressionRatio: result.compressionRatio,
                maxInterpolationDrift: result.maxInterpolationDrift,
                meanInterpolationDrift: result.meanInterpolationDrift,
                motionContrastRatio: result.motionContrastRatio,
                mode: result.mode,
                selectedIndices: result.selectedIndices,
                selectedKeyframes: result.selectedKeyframes
            } as ToolResultPayload,
            status: 'completed',
            summaryResult: `Optimized keyframe density (${result.mode}): selected ${result.totalKeyframes} keyframes from ${result.totalFrames} frames (${result.compressionRatio}x compression, max drift = ${result.maxInterpolationDrift}m, motion contrast = ${result.motionContrastRatio}x). Frame 1 and Frame ${result.totalFrames} pinned.`
        };
    },

    continuous_spline_matchmove_optimize: async (args, ctx) => {
        const service = new ContinuousSplineMatchmoveService();
        let knots: SplineKnot[] = Array.isArray(args.knots) ? (args.knots as SplineKnot[]) : [];
        if (knots.length === 0 && args.knotsPath) {
            const p = path.isAbsolute(args.knotsPath as string) ? (args.knotsPath as string) : path.resolve(ctx.workspaceRoot || process.cwd(), args.knotsPath as string);
            if (fs.existsSync(p)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
                    knots = Array.isArray(parsed) ? parsed : (parsed.knots || parsed.frames || []);
                } catch {
                    // Ignore parse error and proceed
                }
            }
        }

        let tracks: PersistentTrack3D2D[] = Array.isArray(args.tracks) ? (args.tracks as PersistentTrack3D2D[]) : [];
        if (tracks.length === 0 && args.tracksPath) {
            const p = path.isAbsolute(args.tracksPath as string) ? (args.tracksPath as string) : path.resolve(ctx.workspaceRoot || process.cwd(), args.tracksPath as string);
            if (fs.existsSync(p)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
                    tracks = Array.isArray(parsed) ? parsed : (parsed.tracks || []);
                } catch {
                    // Ignore parse error and proceed
                }
            }
        }

        const anchors: SplineAnchorConstraint[] = Array.isArray(args.anchors) ? (args.anchors as SplineAnchorConstraint[]) : [];
        const width = asNumber(args.width, 1920)!;
        const height = asNumber(args.height, 1080)!;

        const solveOptions: ContinuousSplineSolveOptions = {
            maxIterations: asNumber(args.maxIterations, 25),
            tolerancePx: asNumber(args.tolerancePx, 0.05),
            kinematicSmoothnessWeight: asNumber(args.kinematicSmoothnessWeight, 1.0),
            huberLossThresholdPx: asNumber(args.huberLossThresholdPx, 4.0),
            enforceMonotonicDescent: asBoolean(args.enforceMonotonicDescent, false)
        };

        const result = service.optimizeSplineTrajectory(knots, tracks, anchors, width, height, solveOptions);

        const outputPath = asString(args.outputPath);
        if (outputPath) {
            const absOut = path.isAbsolute(outputPath) ? outputPath : path.resolve(ctx.workspaceRoot || process.cwd(), outputPath);
            fs.mkdirSync(path.dirname(absOut), { recursive: true });
            fs.writeFileSync(absOut, JSON.stringify(result, null, 2), 'utf8');
        }

        return {
            resultPayload: {
                success: result.success,
                initialRmsPx: result.initialRmsPx,
                finalRmsPx: result.finalRmsPx,
                iterations: result.iterations,
                optimizedKnots: result.optimizedKnots,
                outputPath
            } as ToolResultPayload,
            status: 'completed',
            summaryResult: `Optimized continuous spline trajectory (${result.optimizedKnots.length} knots): RMS error improved from ${result.initialRmsPx.toFixed(2)}px to ${result.finalRmsPx.toFixed(2)}px in ${result.iterations} LM iterations.`
        };
    },

    continuous_spline_synthesize_trajectory: async (args, ctx) => {
        const service = new ContinuousSplineMatchmoveService();
        let knots: SplineKnot[] = Array.isArray(args.knots) ? (args.knots as SplineKnot[]) : [];
        if (knots.length === 0 && args.knotsPath) {
            const p = path.isAbsolute(args.knotsPath as string) ? (args.knotsPath as string) : path.resolve(ctx.workspaceRoot || process.cwd(), args.knotsPath as string);
            if (fs.existsSync(p)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
                    knots = Array.isArray(parsed) ? parsed : (parsed.knots || parsed.frames || []);
                } catch {
                    // Ignore parse error and proceed
                }
            }
        }

        const fps = asNumber(args.fps, 24)!;
        const durationSec = asNumber(args.durationSec, 10.0)!;
        const exportSolveTrack = asBoolean(args.exportSolveTrack, false);

        const denseTrajectory = service.synthesizeDenseTrajectory(knots, fps, durationSec);
        const solveTrack = exportSolveTrack
            ? service.toCameraSolveTrack(knots, fps, durationSec)
            : undefined;

        const outputPath = asString(args.outputPath);
        if (outputPath) {
            const absOut = path.isAbsolute(outputPath) ? outputPath : path.resolve(ctx.workspaceRoot || process.cwd(), outputPath);
            fs.mkdirSync(path.dirname(absOut), { recursive: true });
            const dataToSave = exportSolveTrack ? solveTrack : { totalFrames: denseTrajectory.length, fps, durationSec, frames: denseTrajectory };
            fs.writeFileSync(absOut, JSON.stringify(dataToSave, null, 2), 'utf8');
        }

        return {
            resultPayload: {
                success: true,
                totalFrames: denseTrajectory.length,
                fps,
                durationSec,
                denseTrajectory,
                solveTrack,
                outputPath
            } as ToolResultPayload,
            status: 'completed',
            summaryResult: `Synthesized continuous spline camera trajectory: ${denseTrajectory.length} frames @ ${fps}fps (${durationSec.toFixed(2)}s) with full velocity, acceleration, and jerk telemetry.`
        };
    }
};

// Aliases for standard prefixing
adaptiveMatchmoveHandlers.adaptive_matchmove_continuous_spline = adaptiveMatchmoveHandlers.continuous_spline_matchmove_optimize;
adaptiveMatchmoveHandlers.adaptive_matchmove_continuous_spline_synthesize = adaptiveMatchmoveHandlers.continuous_spline_synthesize_trajectory;

