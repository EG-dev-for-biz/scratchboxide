/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import { execSync } from 'child_process';
import { BakedGaussian } from '../../common/geospatial-4d-protocol';
import {
    HumanoidMotionData,
    HumanoidMotionFrame,
    SkinWeightedGaussian,
    Dynamic4DGaussianSplatService
} from '../3d-engine/Dynamic4DGaussianSplatService';
import { SplatService } from '../3d-engine/splat-service';
import { SbHumanLoader } from '../../common/spatial/SbHumanLoader';
import { CharacterSilhouetteSolver } from './CharacterSilhouetteSolver';
import { CharacterAnatomicalRatios } from '../../common/character-morph-protocol';
import {
    MUSIC_VENUE_PRESETS,
    MusicVenuePreset
} from '../../browser/generative-canvas/services/ConcertStagePerformerService';
import { HeadlessVideoEditorService, resolveBinary } from '../video/HeadlessVideoEditorService';
import { NerfstudioDatasetService } from './NerfstudioDatasetService';
import { MediaPipePoseService } from './MediaPipePoseService';
import { PerformerPoseTrack, PerformerPoseTrackService } from './PerformerPoseTrackService';
import { HumanoidMotionBridgeService } from './HumanoidMotionBridgeService';
import { GvhmrBody, GvhmrBodyService } from './GvhmrBodyService';
import { encodeGaussianPly } from '../../common/gaussian-ply-codec';
import { Mat3, Vec3, applyMat3, computeBoneRotations, skinPoint, transposeMat3 } from '../../common/humanoid-skinning';

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v'];

function normalize3(v: Vec3): Vec3 {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
}

// ============================================================================
// Types & Contracts
// ============================================================================

export interface MediaPipeNormalizedLandmark33 {
    x: number; // [0, 1] normalized to image width
    y: number; // [0, 1] normalized to image height
    z?: number;
    visibility?: number;
}

export const MEDIAPIPE_33_KEYPOINTS = {
    NOSE: 0,
    LEFT_EYE_INNER: 1,
    LEFT_EYE: 2,
    LEFT_EYE_OUTER: 3,
    RIGHT_EYE_INNER: 4,
    RIGHT_EYE: 5,
    RIGHT_EYE_OUTER: 6,
    LEFT_EAR: 7,
    RIGHT_EAR: 8,
    MOUTH_LEFT: 9,
    MOUTH_RIGHT: 10,
    LEFT_SHOULDER: 11,
    RIGHT_SHOULDER: 12,
    LEFT_ELBOW: 13,
    RIGHT_ELBOW: 14,
    LEFT_WRIST: 15,
    RIGHT_WRIST: 16,
    LEFT_PINKY: 17,
    RIGHT_PINKY: 18,
    LEFT_INDEX: 19,
    RIGHT_INDEX: 20,
    LEFT_THUMB: 21,
    RIGHT_THUMB: 22,
    LEFT_HIP: 23,
    RIGHT_HIP: 24,
    LEFT_KNEE: 25,
    RIGHT_KNEE: 26,
    LEFT_ANKLE: 27,
    RIGHT_ANKLE: 28,
    LEFT_HEEL: 29,
    RIGHT_HEEL: 30,
    LEFT_FOOT_INDEX: 31,
    RIGHT_FOOT_INDEX: 32
} as const;

export interface VideoTo4DPerformerOptions {
    videoPath: string;
    outputDir?: string;
    heroTimestampSec?: number;
    numGaussians?: number;
    targetHeightMeters?: number;
    venueId?: string;
    fps?: number;
    motionSequenceLengthSec?: number;
    characterId?: string;
    dryRun?: boolean;
    landmarks2D?: MediaPipeNormalizedLandmark33[];
    /**
     * Human motion & shape recovery. 'gvhmr' (default for video) fits an SMPL-X body with GVHMR and builds
     * the avatar from it; 'mediapipe' uses landmark tracking on the parametric template. GVHMR failures
     * fall back to MediaPipe.
     */
    motionEstimator?: 'gvhmr' | 'mediapipe';
    /** Pre-computed scripts/run_gvhmr.py output (gvhmr_body.json). */
    gvhmrBodyPath?: string;
    /** Pre-computed PerformerPoseTrack JSON; otherwise video inputs are tracked with MediaPipe. */
    poseTrackPath?: string;
    /**
     * Accept the procedural idle sway when no motion can be tracked (still-image inputs).
     * Without it the pipeline refuses to emit an avatar that does not move.
     */
    allowSyntheticIdleMotion?: boolean;
    exportNerfstudioDataset?: boolean;
    nerfstudioOutputDir?: string;
    /**
     * Optional frame-motivated ingestion configuration.
     * When provided, the video ingestion pipeline validates and conditions motion on the reference A-pose hero frame.
     */
    frameMotivatedInput?: {
        referenceFramePath?: string;
        referenceFrameRef?: string;
        isAFramePose?: boolean;
        heroPoseType?: 'casual' | 'a-pose' | 'as-input';
        cameraPositions?: Array<'front' | 'left_45' | 'right_45' | 'rear_180' | 'orbit_360'>;
        cameraRigPreset?: '6-view-orbit' | '24-view-dense' | '48-view-multipitch' | '24-view-frontal-arc';
        videoDiffusionModel?: 'Wan2.2-TI2V-5B' | 'SVD' | 'Veo2';
    };
}

export interface VideoTo4DPerformerResult {
    success: boolean;
    characterId: string;
    numGaussians: number;
    numFrames: number;
    fps: number;
    heroFramePath?: string;
    plyPath: string;
    motionPath: string;
    splatPath: string;
    geoManifestPath: string;
    stagePlacementPath: string;
    nerfstudioTransformsPath?: string;
    nerfstudioSparsePcdPath?: string;
    backprojectionIoU?: number;
    backprojectionGated?: boolean;
    landmarksDetected?: number;
    frameMotivated?: {
        motivatedByFrame: boolean;
        referenceFrameRef?: string;
        cameraPositions?: string[];
        cameraRigPreset?: string;
        videoDiffusionModel?: string;
        heroPoseType?: 'casual' | 'a-pose' | 'as-input';
        aFramePoseValidated: boolean;
    };
    morphology: {
        heightMeters: number;
        shoulderWidthMeters: number;
        hipWidthMeters: number;
        legToTorsoRatio: number;
        headsTall: number;
        solvedBetas: number[];
        ratios: {
            headsTall: number;
            shoulderToHipRatio: number;
            legToTorsoRatio: number;
            waistCinchRatio: number;
        };
        colorSamples: {
            hairColorRgb: [number, number, number];
            torsoColorRgb: [number, number, number];
            legsColorRgb: [number, number, number];
            skinToneRgb: [number, number, number];
        };
    };
    cameraIntrinsics: {
        fx: number;
        fy: number;
        cx: number;
        cy: number;
        width: number;
        height: number;
        standoff?: number;
        camX?: number;
        camY?: number;
    };
    telemetry: {
        stage1DurationMs: number;
        stage2DurationMs: number;
        stage3DurationMs: number;
        stage4DurationMs: number;
        stage5DurationMs: number;
        stage6DurationMs: number;
        totalDurationMs: number;
        projectedRgbCount: number;
        groundOffsetMeters: number;
        backprojectionIoU: number;
        backprojectionGated: boolean;
        backprojectionReason?: string;
        motionSource?: string;
        trackedFrames?: number;
        cameraSolve?: 'gvhmr' | 'landmarks' | 'silhouette';
    };
    venueAnchor: {
        venueId: string;
        venueName: string;
        latitude: number;
        longitude: number;
        altitudeMsl: number;
        stageHeadingDeg: number;
    };
    error?: string;
}

export interface SilhouetteExtractionResult {
    heroFramePath: string;
    width: number;
    height: number;
    boundingBox: { minX: number; minY: number; maxX: number; maxY: number };
    ratios: CharacterAnatomicalRatios;
    solvedBetas: number[];
    colorSamples: {
        hairColorRgb: [number, number, number];
        torsoColorRgb: [number, number, number];
        legsColorRgb: [number, number, number];
        skinToneRgb: [number, number, number];
    };
    landmarks2D?: MediaPipeNormalizedLandmark33[];
    detectedPoseAngles?: {
        leftShoulderAngleRad?: number;
        rightShoulderAngleRad?: number;
        leftElbowAngleRad?: number;
        rightElbowAngleRad?: number;
        leftHipAngleRad?: number;
        rightHipAngleRad?: number;
    };
    foregroundMask?: Uint8Array;
    maskWidth?: number;
    maskHeight?: number;
}

export interface CanonicalGaussiansResult {
    gaussians: SkinWeightedGaussian[];
    canonicalJoints: Array<[number, number, number]>;
    kintreeParents: number[];
    jointNames: string[];
    heroPoseJoints?: Array<[number, number, number]>;
}

// SB-Human 22 Joint Canonical Hierarchy & Names
export const SBHUMAN_22_JOINTS: Array<{ index: number; name: string; parent: number; restOffset: [number, number, number] }> = [
    { index: 0,  name: 'pelvis',          parent: -1, restOffset: [0.0, 0.95, 0.0] },
    { index: 1,  name: 'left_hip',        parent: 0,  restOffset: [-0.09, 0.88, 0.0] },
    { index: 2,  name: 'right_hip',       parent: 0,  restOffset: [0.09, 0.88, 0.0] },
    { index: 3,  name: 'spine1',          parent: 0,  restOffset: [0.0, 1.08, 0.0] },
    { index: 4,  name: 'left_knee',       parent: 1,  restOffset: [-0.10, 0.49, 0.01] },
    { index: 5,  name: 'right_knee',      parent: 2,  restOffset: [0.10, 0.49, 0.01] },
    { index: 6,  name: 'spine2',          parent: 3,  restOffset: [0.0, 1.22, 0.0] },
    { index: 7,  name: 'left_ankle',      parent: 4,  restOffset: [-0.10, 0.08, -0.02] },
    { index: 8,  name: 'right_ankle',     parent: 5,  restOffset: [0.10, 0.08, -0.02] },
    { index: 9,  name: 'spine3',          parent: 6,  restOffset: [0.0, 1.36, 0.0] },
    { index: 10, name: 'left_foot',       parent: 7,  restOffset: [-0.10, 0.00, 0.10] },
    { index: 11, name: 'right_foot',      parent: 8,  restOffset: [0.10, 0.00, 0.10] },
    { index: 12, name: 'neck',            parent: 9,  restOffset: [0.0, 1.50, 0.0] },
    { index: 13, name: 'left_collar',     parent: 9,  restOffset: [-0.08, 1.44, -0.01] },
    { index: 14, name: 'right_collar',    parent: 9,  restOffset: [0.08, 1.44, -0.01] },
    { index: 15, name: 'head',            parent: 12, restOffset: [0.0, 1.62, 0.0] },
    { index: 16, name: 'left_shoulder',   parent: 13, restOffset: [-0.21, 1.42, -0.01] },
    { index: 17, name: 'right_shoulder',  parent: 14, restOffset: [0.21, 1.42, -0.01] },
    { index: 18, name: 'left_elbow',      parent: 16, restOffset: [-0.29, 1.15, -0.02] },
    { index: 19, name: 'right_elbow',     parent: 17, restOffset: [0.29, 1.15, -0.02] },
    { index: 20, name: 'left_wrist',      parent: 18, restOffset: [-0.34, 0.88, -0.01] },
    { index: 21, name: 'right_wrist',     parent: 19, restOffset: [0.34, 0.88, -0.01] }
];

// Backward compatibility alias for legacy SMPL-X nomenclature
export const SMPLX_22_JOINTS = SBHUMAN_22_JOINTS;

// ============================================================================
// Video-to-Performer 4D Projection Pipeline Service
// ============================================================================

export class VideoTo4DPerformerPipelineService {
    private videoEditor: HeadlessVideoEditorService;

    constructor() {
        this.videoEditor = new HeadlessVideoEditorService();
    }

    /**
     * Executes the end-to-end 6-stage video-to-performer 4D projection pipeline.
     */
    public async executePipeline(options: VideoTo4DPerformerOptions): Promise<VideoTo4DPerformerResult> {
        const startTime = Date.now();
        const characterId = options.characterId || `performer_${path.basename(options.videoPath, path.extname(options.videoPath))}_${Date.now()}`;
        const outputDir = options.outputDir || path.resolve(process.cwd(), 'models/performer_4dgs/demos', characterId);
        await fs.ensureDir(outputDir);

        const targetHeight = options.targetHeightMeters ?? 1.78;
        const numGaussians = options.numGaussians ?? 120000;
        const fps = options.fps ?? 25;
        const venuePreset = MUSIC_VENUE_PRESETS[options.venueId || 'red_rocks'] || MUSIC_VENUE_PRESETS.red_rocks;

        // --------------------------------------------------------------------
        // Stage 1: Video Ingestion & Hero Frame Extraction
        // --------------------------------------------------------------------
        const t1 = Date.now();
        const heroResult = await this.extractHeroFrame(options.videoPath, outputDir, options.heroTimestampSec ?? 0.0);
        const motionDurationSec = options.motionSequenceLengthSec ?? 4.8;

        const isVideoInput = VIDEO_EXTENSIONS.includes(path.extname(options.videoPath).toLowerCase());

        // GVHMR fits the performer's SMPL-X body (shape + world-grounded motion + hero camera).
        const gvhmrService = new GvhmrBodyService();
        let gvhmrBody: GvhmrBody | null = null;
        let gvhmrError: string | undefined;
        if (options.gvhmrBodyPath) {
            gvhmrBody = gvhmrService.load(options.gvhmrBodyPath);
        } else if (isVideoInput && fs.existsSync(options.videoPath) && options.motionEstimator !== 'mediapipe' && !options.poseTrackPath) {
            try {
                gvhmrBody = gvhmrService.run(options.videoPath, outputDir, { maxFrames: Math.round(motionDurationSec * fps) + 1 });
            } catch (err: any) {
                gvhmrError = err?.message || String(err);
            }
        }

        // Otherwise a MediaPipe pose track drives the hero pose, the camera solve and the motion.
        const poseTrackService = new PerformerPoseTrackService();
        let poseTrack: PerformerPoseTrack | null = null;
        let poseTrackError: string | undefined;
        if (gvhmrBody) {
            // GVHMR supplies everything MediaPipe would
        } else if (options.poseTrackPath) {
            poseTrack = poseTrackService.loadTrack(options.poseTrackPath);
        } else if (isVideoInput && fs.existsSync(options.videoPath)) {
            try {
                poseTrack = poseTrackService.trackVideo(options.videoPath, {
                    outputPath: path.join(outputDir, 'pose_track.json'),
                    maxSeconds: motionDurationSec,
                    maskOutputPath: path.join(outputDir, 'hero_mask.png')
                });
            } catch (err: any) {
                poseTrackError = err?.message || String(err);
            }
        }
        if (poseTrack && PerformerPoseTrackService.countTrackedFrames(poseTrack) < 2) {
            poseTrackError = `only ${PerformerPoseTrackService.countTrackedFrames(poseTrack)} frame(s) contained a detectable performer`;
            poseTrack = null;
        }
        if (!gvhmrBody && !poseTrack && !options.allowSyntheticIdleMotion) {
            throw new Error(
                `No performer motion could be tracked from "${options.videoPath}"` +
                ([gvhmrError, poseTrackError].filter(Boolean).length ? `: ${[gvhmrError, poseTrackError].filter(Boolean).join('; ')}` : ' (still image input)') +
                '. Provide the performer video or a poseTrackPath, or pass allowSyntheticIdleMotion to accept a procedural idle sway.'
            );
        }
        const heroTrackIndex = poseTrack
            ? Math.min(poseTrack.frames.length - 1, Math.round((options.heroTimestampSec ?? 0) * (poseTrack.fps || fps)))
            : 0;
        const heroTrackImage = poseTrack?.frames[heroTrackIndex]?.image || null;
        const heroLandmarks2D: MediaPipeNormalizedLandmark33[] | undefined = options.landmarks2D
            || (heroTrackImage ? heroTrackImage.map(([x, y, z, v]) => ({ x, y, z, visibility: v })) : undefined);
        const stage1DurationMs = Date.now() - t1;

        // --------------------------------------------------------------------
        // Stage 2: Performer 2D Silhouette & Morphology Resection
        // --------------------------------------------------------------------
        const t2 = Date.now();
        const silhouetteResult = await this.solvePerformerMorphology(
            heroResult.heroFramePath,
            targetHeight,
            heroLandmarks2D
        );
        const heroMaskPath = poseTrack?.hero_mask && fs.existsSync(poseTrack.hero_mask) ? poseTrack.hero_mask : null;
        if (heroMaskPath) {
            const coarse = this.readGrayMask(heroMaskPath, 64, 128);
            if (coarse) {
                silhouetteResult.foregroundMask = coarse;
                silhouetteResult.maskWidth = 64;
                silhouetteResult.maskHeight = 128;
            }
        }
        const stage2DurationMs = Date.now() - t2;

        // --------------------------------------------------------------------
        // Stage 3: Canonical Humanoid Surface Sampling & 4-Bone LBS Rigging
        // --------------------------------------------------------------------
        const t3 = Date.now();
        const gvhmrAvatar = gvhmrBody
            ? gvhmrService.sampleCanonicalAvatar(gvhmrBody, numGaussians, silhouetteResult.colorSamples.torsoColorRgb)
            : null;
        const canonicalResult: CanonicalGaussiansResult = gvhmrAvatar
            ? {
                gaussians: gvhmrAvatar.gaussians,
                canonicalJoints: gvhmrAvatar.canonicalJoints,
                kintreeParents: gvhmrAvatar.kintreeParents,
                jointNames: SBHUMAN_22_JOINTS.map(j => j.name),
                heroPoseJoints: gvhmrBody!.frames[0].joints.map(j => [j[0], j[1], j[2]] as [number, number, number])
            }
            : this.generateCanonicalPosedGaussians(silhouetteResult, numGaussians, targetHeight);
        if (gvhmrBody) silhouetteResult.solvedBetas = gvhmrBody.betas.slice();
        const stage3DurationMs = Date.now() - t3;

        // --------------------------------------------------------------------
        // Stage 4: Multi-Angle Optical Video Ray Backprojection & Color Baking
        // --------------------------------------------------------------------
        const t4 = Date.now();
        let cameraIntrinsics: {
            width: number;
            height: number;
            fx: number;
            fy: number;
            cx: number;
            cy: number;
            standoff?: number;
            camX?: number;
            camY?: number;
            /** Gravity-aligned world -> hero camera rotation; camX/camY/standoff are in the camera-aligned frame. */
            worldToCamera?: Mat3;
        } = {
            width: heroResult.width,
            height: heroResult.height,
            fx: Math.round(heroResult.width / (2 * Math.tan(0.8202546810829819 / 2))),
            fy: Math.round(heroResult.width / (2 * Math.tan(0.8202546810829819 / 2))),
            cx: heroResult.width * 0.5,
            cy: heroResult.height * 0.5
        };

        const adjacentCamPath = path.join(path.dirname(heroResult.heroFramePath), 'cameras.json');
        if (gvhmrBody) {
            const sx = heroResult.width / gvhmrBody.width;
            const sy = heroResult.height / gvhmrBody.height;
            cameraIntrinsics = {
                width: heroResult.width,
                height: heroResult.height,
                fx: gvhmrBody.K[0][0] * sx,
                fy: gvhmrBody.K[1][1] * sy,
                cx: gvhmrBody.K[0][2] * sx,
                cy: gvhmrBody.K[1][2] * sy
            };
        } else if (fs.existsSync(adjacentCamPath)) {
            try {
                const camJson = fs.readJsonSync(adjacentCamPath);
                const sameFrameSize = camJson.w === heroResult.width && camJson.h === heroResult.height;
                if (sameFrameSize && camJson.fl_x && camJson.cx && camJson.cy) {
                    cameraIntrinsics = {
                        width: camJson.w || heroResult.width,
                        height: camJson.h || heroResult.height,
                        fx: camJson.fl_x,
                        fy: camJson.fl_y,
                        cx: camJson.cx,
                        cy: camJson.cy
                    };
                }
            } catch {
                // Keep computed fallback intrinsics
            }
        }

        // Motion (and therefore the exact Frame 0 hero pose) comes from the tracked video when available.
        const t5 = Date.now();
        let motionData: HumanoidMotionData | null = gvhmrBody
            ? gvhmrService.toMotion(gvhmrBody, characterId)
            : poseTrack
            ? new HumanoidMotionBridgeService().retargetPoseTrack(poseTrack, canonicalResult.canonicalJoints, {
                clipId: characterId,
                targetHeightMeters: targetHeight
            })
            : null;
        let stage5DurationMs = Date.now() - t5;

        const heroPoseJoints = motionData
            ? motionData.frames[Math.min(heroTrackIndex, motionData.frames.length - 1)].joint_positions_3d
            : (canonicalResult.heroPoseJoints || this.computeHeroRestingPoseJoints(canonicalResult.canonicalJoints));

        // Camera: pinhole resection of tracked 2D joints against the posed 3D skeleton, else silhouette fit.
        const worldToCamera = motionData?.camera_to_world ? transposeMat3(motionData.camera_to_world) : undefined;
        const landmarkCamera = heroTrackImage
            ? this.solveCameraFromLandmarks(
                heroTrackImage,
                worldToCamera ? heroPoseJoints.map(j => applyMat3(worldToCamera, j as Vec3)) : heroPoseJoints,
                cameraIntrinsics
            )
            : null;
        const solvedCamera = landmarkCamera || this.solveCameraFromSilhouette(
            silhouetteResult.boundingBox,
            cameraIntrinsics,
            targetHeight
        );
        cameraIntrinsics.standoff = solvedCamera.standoff;
        cameraIntrinsics.camX = solvedCamera.camX;
        cameraIntrinsics.camY = solvedCamera.camY;
        if (landmarkCamera && worldToCamera) cameraIntrinsics.worldToCamera = worldToCamera;

        let gvhmrSampledFraction = 0;
        if (gvhmrBody && gvhmrAvatar) {
            gvhmrSampledFraction = gvhmrService.bakeHeroTexture(
                gvhmrBody,
                gvhmrAvatar,
                gvhmrService.readRgb(heroResult.heroFramePath, heroResult.width, heroResult.height),
                heroResult.width,
                heroResult.height
            ).sampledFraction;
        }
        const texturedGaussians = gvhmrAvatar
            ? Object.assign(gvhmrAvatar.gaussians, {
                // No mask-IoU gate: colours come from the fitted mesh's own projection.
                iou: Number.NaN,
                gated: false,
                reason: `GVHMR hero mesh projection sampled ${(gvhmrSampledFraction * 100).toFixed(1)}% of Gaussians directly`
            })
            : this.backprojectVideoTextures(
            canonicalResult.gaussians,
            heroResult.heroFramePath,
            silhouetteResult.colorSamples,
            cameraIntrinsics,
            canonicalResult.canonicalJoints,
            heroPoseJoints,
            silhouetteResult.foregroundMask,
            silhouetteResult.maskWidth,
            silhouetteResult.maskHeight,
            heroMaskPath ? this.readGrayMask(heroMaskPath, cameraIntrinsics.width, cameraIntrinsics.height) : null
        );
        const stage4DurationMs = Date.now() - t4;

        // --------------------------------------------------------------------
        // Stage 5: Kinematic Joint Motion Recovery & Dynamic Ground Clamping
        // --------------------------------------------------------------------
        if (!motionData) {
            const t5b = Date.now();
            motionData = this.recoverPerformerMotion(
                canonicalResult.canonicalJoints,
                canonicalResult.kintreeParents,
                fps,
                motionDurationSec,
                characterId,
                heroPoseJoints,
                options.videoPath,
                heroResult.heroFramePath
            );
            stage5DurationMs += Date.now() - t5b;
        }

        // --------------------------------------------------------------------
        // Stage 6: 4D Splat Serialization, PLY Export & Concert Stage Docking
        // --------------------------------------------------------------------
        const t6 = Date.now();
        const plyPath = path.join(outputDir, 'human_4dgs.ply');
        const motionPath = path.join(outputDir, 'motion.json');
        const splatPath = path.join(outputDir, `${characterId}.splat`);
        const geoManifestPath = path.join(outputDir, 'geo_manifest.json');
        const stagePlacementPath = path.join(outputDir, 'stage_placement.json');
        const transformsPath = path.join(outputDir, 'transforms.json');
        const camerasPath = path.join(outputDir, 'cameras.json');

        // Write PLY
        this.writeStandardPly(plyPath, texturedGaussians);

        // Write motion.json
        await fs.writeJson(motionPath, motionData, { spaces: 2 });

        // Serialize 32-byte binary .splat
        const splatBuffer = SplatService.serializeSplatBuffer(texturedGaussians);
        await fs.writeFile(splatPath, splatBuffer);

        // Write geo_manifest.json
        const geoManifest = {
            character_id: characterId,
            dataset_name: `Performer 4DGS - ${characterId}`,
            created_at: new Date().toISOString(),
            generator: 'Scratchbox IDE VideoTo4DPerformerPipelineService',
            geographic_anchor: {
                venue_id: venuePreset.id,
                venue_name: venuePreset.name,
                latitude: venuePreset.lat,
                longitude: venuePreset.lng,
                altitude: venuePreset.altMeters,
                stage_heading_deg: venuePreset.stageHeadingDeg
            },
            num_gaussians: texturedGaussians.length,
            num_frames: motionData.num_frames,
            fps: motionData.fps,
            foot_contact_altitude_msl: venuePreset.altMeters
        };
        await fs.writeJson(geoManifestPath, geoManifest, { spaces: 2 });

        // Write stage_placement.json
        const stagePlacement = {
            venue: venuePreset,
            characterId,
            spawnPositionMsl: [0, 0, 0], // Local stage origin
            orientationEulerDeg: [0, venuePreset.stageHeadingDeg, 0],
            footContactElevationMeters: 0.0,
            spotlightFollow: true,
            pbrAlbedoGain: 1.12
        };
        await fs.writeJson(stagePlacementPath, stagePlacement, { spaces: 2 });

        // Write cameras.json & Nerfstudio-compliant transforms.json & sparse_pcd.ply
        const camerasData = {
            camera_angle_x: 2 * Math.atan(cameraIntrinsics.width / (2 * cameraIntrinsics.fx)),
            camera_angle_y: 2 * Math.atan(cameraIntrinsics.height / (2 * cameraIntrinsics.fy)),
            fl_x: cameraIntrinsics.fx,
            fl_y: cameraIntrinsics.fy,
            cx: cameraIntrinsics.cx,
            cy: cameraIntrinsics.cy,
            w: cameraIntrinsics.width,
            h: cameraIntrinsics.height
        };
        await fs.writeJson(camerasPath, camerasData, { spaces: 2 });

        // Calibrate 4-camera orbital rig: Hero Front (0°), Left Lateral (45°), Right Lateral (-45°), Rear Survey (180°)
        const orbitalRig = NerfstudioDatasetService.generateOrbitalCameraRig({
            target: [0.0, targetHeight * 0.55, 0.0],
            radius: 2.4,
            intrinsics: cameraIntrinsics,
            cameras: [
                { id: 0, name: 'Cam 0 (Hero Front 0°)', position: [0.0, targetHeight * 0.65, 2.4] },
                { id: 1, name: 'Cam 1 (Left 45° Lateral)', position: [-1.7, targetHeight * 0.70, 1.7] },
                { id: 2, name: 'Cam 2 (Right 45° Lateral)', position: [1.7, targetHeight * 0.70, 1.7] },
                { id: 3, name: 'Cam 3 (Rear 180° Survey)', position: [0.0, targetHeight * 0.75, -2.4] }
            ]
        });

        const transformsFrames = orbitalRig.map((cam, idx) => ({
            file_path: idx === 0 ? 'canonical_frame.jpg' : `cam_${String(idx).padStart(2, '0')}.png`,
            transform_matrix: cam.c2wNerfstudio,
            mask_path: idx === 0 ? 'canonical_mask.png' : `cam_${String(idx).padStart(2, '0')}_mask.png`,
            fl_x: cam.intrinsics.fx,
            fl_y: cam.intrinsics.fy,
            cx: cam.intrinsics.cx,
            cy: cam.intrinsics.cy,
            w: cam.intrinsics.width,
            h: cam.intrinsics.height
        }));

        const transformsData = {
            camera_model: 'OPENCV',
            fl_x: cameraIntrinsics.fx,
            fl_y: cameraIntrinsics.fy,
            cx: cameraIntrinsics.cx,
            cy: cameraIntrinsics.cy,
            w: cameraIntrinsics.width,
            h: cameraIntrinsics.height,
            frames: transformsFrames
        };
        await fs.writeJson(transformsPath, transformsData, { spaces: 2 });

        // Write standard Nerfstudio sparse_pcd.ply for visual-hull / initial geometry
        const sparsePcdPath = path.join(outputDir, 'sparse_pcd.ply');
        const sparsePoints = texturedGaussians.slice(0, 15000).map(g => ({
            position: [g.position[0], g.position[1], g.position[2]] as [number, number, number],
            normal: [0.0, 1.0, 0.0] as [number, number, number],
            color: [g.colorRgb[0], g.colorRgb[1], g.colorRgb[2]] as [number, number, number]
        }));
        const plyAscii = NerfstudioDatasetService.serializeSparsePcdPly(sparsePoints);
        await fs.writeFile(sparsePcdPath, plyAscii, 'utf-8');

        // Full multi-view dataset export if requested
        if (options.exportNerfstudioDataset) {
            const nsOutputDir = options.nerfstudioOutputDir || path.join(outputDir, 'nerfstudio_dataset');
            const datasetService = new NerfstudioDatasetService();
            const heroMaskCandidate = path.join(path.dirname(heroResult.heroFramePath), 'canonical_mask.png');
            const heroMaskPath = (await fs.pathExists(heroMaskCandidate)) ? heroMaskCandidate : undefined;
            const cameraRigInputs = orbitalRig.map((cam, idx) => {
                if (idx === 0) {
                    return {
                        cameraId: 0,
                        imagePath: heroResult.heroFramePath,
                        maskPath: heroMaskPath,
                        c2wMatrix: cam.c2wMatrix,
                        intrinsics: cam.intrinsics
                    };
                }
                return {
                    cameraId: idx,
                    c2wMatrix: cam.c2wMatrix,
                    intrinsics: cam.intrinsics
                };
            });
            await datasetService.exportDataset({
                outputDir: nsOutputDir,
                cameraRig: cameraRigInputs,
                defaultIntrinsics: cameraIntrinsics,
                sparsePoints
            });
        }

        const stage6DurationMs = Date.now() - t6;
        const totalDurationMs = Date.now() - startTime;

        return {
            success: true,
            characterId,
            numGaussians: texturedGaussians.length,
            numFrames: motionData.num_frames,
            fps: motionData.fps,
            heroFramePath: heroResult.heroFramePath,
            plyPath,
            motionPath,
            splatPath,
            geoManifestPath,
            stagePlacementPath,
            nerfstudioTransformsPath: transformsPath,
            nerfstudioSparsePcdPath: sparsePcdPath,
            backprojectionIoU: (texturedGaussians as any).iou ?? 0.88,
            backprojectionGated: (texturedGaussians as any).gated ?? false,
            landmarksDetected: silhouetteResult.landmarks2D?.length ?? 0,
            frameMotivated: options.frameMotivatedInput
                ? {
                      motivatedByFrame: true,
                      referenceFrameRef: options.frameMotivatedInput.referenceFrameRef || options.frameMotivatedInput.referenceFramePath,
                      cameraPositions: options.frameMotivatedInput.cameraPositions || ['front', 'left_45', 'right_45', 'rear_180'],
                      cameraRigPreset: options.frameMotivatedInput.cameraRigPreset || '6-view-orbit',
                      videoDiffusionModel: options.frameMotivatedInput.videoDiffusionModel || 'Wan2.2-TI2V-5B',
                      heroPoseType: options.frameMotivatedInput.heroPoseType || (options.frameMotivatedInput.isAFramePose === false ? 'casual' : 'a-pose'),
                      aFramePoseValidated: options.frameMotivatedInput.isAFramePose ?? (options.frameMotivatedInput.heroPoseType === 'a-pose')
                  }
                : undefined,
            morphology: {
                heightMeters: targetHeight,
                shoulderWidthMeters: 0.42 * (1.0 + (silhouetteResult.ratios.shoulderToHipRatio - 1.05)),
                hipWidthMeters: 0.36 * (1.0 + (1.05 - silhouetteResult.ratios.shoulderToHipRatio)),
                legToTorsoRatio: silhouetteResult.ratios.legToTorsoRatio,
                headsTall: silhouetteResult.ratios.headsTall,
                solvedBetas: silhouetteResult.solvedBetas,
                ratios: silhouetteResult.ratios,
                colorSamples: silhouetteResult.colorSamples
            },
            cameraIntrinsics,
            telemetry: {
                stage1DurationMs,
                stage2DurationMs,
                stage3DurationMs,
                stage4DurationMs,
                stage5DurationMs,
                stage6DurationMs,
                totalDurationMs,
                projectedRgbCount: texturedGaussians.length,
                groundOffsetMeters: 0.0,
                backprojectionIoU: (texturedGaussians as any).iou ?? 0.0,
                backprojectionGated: (texturedGaussians as any).gated ?? true,
                backprojectionReason: (texturedGaussians as any).reason ?? 'Unspecified',
                motionSource: motionData.motion_source,
                trackedFrames: gvhmrBody ? gvhmrBody.frames.length : poseTrack ? PerformerPoseTrackService.countTrackedFrames(poseTrack) : 0,
                cameraSolve: gvhmrBody ? 'gvhmr' : landmarkCamera ? 'landmarks' : 'silhouette'
            },
            venueAnchor: {
                venueId: venuePreset.id,
                venueName: venuePreset.name,
                latitude: venuePreset.lat,
                longitude: venuePreset.lng,
                altitudeMsl: venuePreset.altMeters,
                stageHeadingDeg: venuePreset.stageHeadingDeg
            }
        };
    }

    /**
     * Fast buffer reader for JPEG dimensions without subprocess overhead.
     */
    public getJpegDimensions(buf: Buffer): { width: number; height: number } | null {
        if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
        let i = 2;
        while (i < buf.length - 8) {
            if (buf[i] !== 0xFF) { i++; continue; }
            const marker = buf[i + 1];
            if (marker === 0xC0 || marker === 0xC2) {
                return {
                    height: buf.readUInt16BE(i + 5),
                    width: buf.readUInt16BE(i + 7)
                };
            }
            if (i + 4 <= buf.length) {
                const len = buf.readUInt16BE(i + 2);
                i += 2 + len;
            } else {
                break;
            }
        }
        return null;
    }

    /**
     * Stage 1: Extracts the canonical hero frame from video or leverages pre-existing frame.
     */
    public async extractHeroFrame(
        videoPath: string,
        outputDir: string,
        timestampSec: number
    ): Promise<{ heroFramePath: string; width: number; height: number }> {
        const canonicalOut = path.join(outputDir, 'canonical_frame.jpg');
        const videoDir = path.dirname(videoPath);

        const resolveDims = (imgPath: string): { width: number; height: number } => {
            const camPath = path.join(videoDir, 'cameras.json');
            if (fs.existsSync(camPath)) {
                try {
                    const c = fs.readJsonSync(camPath);
                    if (c.w && c.h) return { width: c.w, height: c.h };
                } catch {
                    // Fallback
                }
            }
            if (fs.existsSync(imgPath)) {
                try {
                    const buf = fs.readFileSync(imgPath);
                    const size = this.getJpegDimensions(buf);
                    if (size) return size;
                } catch {
                    // Fallback
                }
            }
            return { width: 2160, height: 3840 };
        };

        // Video input: the hero frame must be the exact frame the pose track starts from.
        const ffmpegForHero = resolveBinary('ffmpeg');
        if (VIDEO_EXTENSIONS.includes(path.extname(videoPath).toLowerCase()) && fs.existsSync(videoPath) && ffmpegForHero) {
            try {
                execSync(`"${ffmpegForHero}" -v error -y -ss ${timestampSec} -i "${videoPath}" -frames:v 1 -q:v 2 "${canonicalOut}"`);
                const size = this.getJpegDimensions(fs.readFileSync(canonicalOut));
                if (size) return { heroFramePath: canonicalOut, width: size.width, height: size.height };
            } catch {
                // Fall through to the legacy discovery paths below
            }
        }

        // Check if an existing canonical_frame.jpg exists next to the video
        const adjacentHero = path.join(videoDir, 'canonical_frame.jpg');
        if (adjacentHero === canonicalOut && fs.existsSync(canonicalOut)) {
            const dims = resolveDims(canonicalOut);
            return { heroFramePath: canonicalOut, width: dims.width, height: dims.height };
        }
        if (fs.existsSync(adjacentHero)) {
            if (adjacentHero !== canonicalOut) {
                await fs.copy(adjacentHero, canonicalOut);
            }
            const dims = resolveDims(canonicalOut);
            return { heroFramePath: canonicalOut, width: dims.width, height: dims.height };
        }

        // Check if input is already an image
        const ext = path.extname(videoPath).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
            if (videoPath !== canonicalOut) {
                await fs.copy(videoPath, canonicalOut);
            }
            const dims = resolveDims(canonicalOut);
            return { heroFramePath: canonicalOut, width: dims.width, height: dims.height };
        }

        // Attempt ffmpeg extraction
        try {
            const ffmpegBin = resolveBinary('ffmpeg');
            if (fs.existsSync(videoPath) && fs.existsSync(ffmpegBin)) {
                await this.videoEditor.extractKeyframes({
                    inputPath: videoPath,
                    outputDir,
                    timestampsSec: [timestampSec],
                    heroFrameOnly: true,
                    format: 'jpg'
                });
                if (fs.existsSync(canonicalOut)) {
                    const dims = resolveDims(canonicalOut);
                    return { heroFramePath: canonicalOut, width: dims.width, height: dims.height };
                }
            }
        } catch {
            // Fall back to synthetic frame creation
        }

        // Fallback: Create placeholder canonical frame
        await fs.writeFile(canonicalOut, Buffer.alloc(1024));
        const dims = resolveDims(canonicalOut);
        return {
            heroFramePath: canonicalOut,
            width: dims.width,
            height: dims.height
        };
    }

    /**
     * Stage 2: Solves performer morphology and anatomical dimensions from hero frame.
     * Integrates MediaPipe 33-joint normalized landmarks for dynamic bounding envelope
     * and anatomical limb pose derivation.
     */
    public async solvePerformerMorphology(
        heroFramePath: string,
        targetHeight: number = 1.78,
        landmarks2D?: MediaPipeNormalizedLandmark33[]
    ): Promise<SilhouetteExtractionResult> {
        // High-fidelity human anatomical prior (default baseline)
        let ratios: CharacterAnatomicalRatios = {
            headsTall: 7.6,
            shoulderToHipRatio: 1.12,
            waistCinchRatio: 0.74,
            bustVolumeScore: 0.18,
            legToTorsoRatio: 1.05,
            muscularityScore: 0.25,
            genderDimorphism: 0.35,
            headWidthToHeightRatio: 0.72
        };

        // Resolve frame dimensions from cameras.json, JPEG header, or portrait standard
        let width = 2160;
        let height = 3840;
        const camPath = path.join(path.dirname(heroFramePath), 'cameras.json');
        const heroSize = fs.existsSync(heroFramePath) ? this.getJpegDimensions(fs.readFileSync(heroFramePath)) : null;
        if (heroSize) {
            width = heroSize.width;
            height = heroSize.height;
        } else if (fs.existsSync(camPath)) {
            try {
                const camData = fs.readJsonSync(camPath);
                if (camData.w && camData.h) {
                    width = camData.w;
                    height = camData.h;
                }
            } catch {
                // Fallback
            }
        }

        let boundingBox = {
            minX: Math.round(width * 0.25),
            minY: Math.round(height * 0.08),
            maxX: Math.round(width * 0.75),
            maxY: Math.round(height * 0.94)
        };

        // Neutral baseline color fallback
        let colorSamples = {
            hairColorRgb: [0.12, 0.09, 0.08] as [number, number, number],
            torsoColorRgb: [0.45, 0.45, 0.48] as [number, number, number],
            legsColorRgb: [0.25, 0.25, 0.28] as [number, number, number],
            skinToneRgb: [0.72, 0.58, 0.48] as [number, number, number]
        };

        // Check for landmarks passed explicitly or saved on disk
        let activeLandmarks = landmarks2D;
        if (!activeLandmarks && heroFramePath) {
            const dir = path.dirname(heroFramePath);
            const candidates = [
                path.join(dir, 'mediapipe_landmarks.json'),
                path.join(dir, 'landmarks.json')
            ];
            for (const cand of candidates) {
                if (fs.existsSync(cand)) {
                    try {
                        const parsed = fs.readJsonSync(cand);
                        if (Array.isArray(parsed) && parsed.length >= 25) {
                            activeLandmarks = parsed;
                            break;
                        }
                    } catch {
                        // ignore
                    }
                }
            }

            if (!activeLandmarks && fs.existsSync(heroFramePath)) {
                try {
                    const poseService = new MediaPipePoseService();
                    const frameBuf = fs.readFileSync(heroFramePath);
                    const poseResult = await poseService.detectPoseLandmarks(frameBuf);
                    if (poseResult && poseResult.imageLandmarks && poseResult.imageLandmarks.length > 0) {
                        const detected = poseResult.imageLandmarks[0];
                        if (detected && detected.length >= 25) {
                            activeLandmarks = detected.map(lm => ({
                                x: lm.x,
                                y: lm.y,
                                z: lm.z ?? 0,
                                visibility: lm.visibility ?? 1.0
                            }));
                        }
                    }
                } catch {
                    // Python / mediapipe daemon unavailable, will fallback to silhouette extraction
                }
            }
        }

        let detectedPoseAngles: SilhouetteExtractionResult['detectedPoseAngles'];

        // If MediaPipe 33-joint landmarks are available, compute dynamic bounding box & anatomical pose angles
        if (activeLandmarks && activeLandmarks.length >= 10) {
            const visible = activeLandmarks.filter(l => (l.visibility ?? 1.0) >= 0.25);
            if (visible.length >= 10) {
                const minLx = Math.min(...visible.map(l => l.x));
                const maxLx = Math.max(...visible.map(l => l.x));
                const minLy = Math.min(...visible.map(l => l.y));
                const maxLy = Math.max(...visible.map(l => l.y));
                const spanY = Math.max(0.1, maxLy - minLy);
                const headTopY = Math.max(0, minLy - spanY * 0.08);
                const footBottomY = Math.min(1.0, maxLy + spanY * 0.02);
                const marginX = (maxLx - minLx) * 0.06;

                boundingBox = {
                    minX: Math.round(Math.max(0, minLx - marginX) * width),
                    minY: Math.round(headTopY * height),
                    maxX: Math.round(Math.min(1.0, maxLx + marginX) * width),
                    maxY: Math.round(footBottomY * height)
                };

                const lSh = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_SHOULDER];
                const rSh = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_SHOULDER];
                const lEl = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_ELBOW];
                const rEl = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_ELBOW];
                const lWr = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_WRIST];
                const rWr = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_WRIST];
                const lHip = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_HIP];
                const rHip = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_HIP];
                const lKnee = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_KNEE];
                const rKnee = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_KNEE];
                const lAnk = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_ANKLE];
                const rAnk = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_ANKLE];

                let leftShoulderAngleRad: number | undefined;
                let rightShoulderAngleRad: number | undefined;
                let leftElbowAngleRad: number | undefined;
                let rightElbowAngleRad: number | undefined;
                let leftHipAngleRad: number | undefined;
                let rightHipAngleRad: number | undefined;

                if (lSh && lEl) {
                    leftShoulderAngleRad = Math.atan2(Math.abs(lEl.x - lSh.x), Math.max(0.001, lEl.y - lSh.y));
                }
                if (rSh && rEl) {
                    rightShoulderAngleRad = Math.atan2(Math.abs(rEl.x - rSh.x), Math.max(0.001, rEl.y - rSh.y));
                }
                if (lEl && lWr) {
                    leftElbowAngleRad = Math.atan2(Math.abs(lWr.x - lEl.x), Math.max(0.001, lWr.y - lEl.y));
                }
                if (rEl && rWr) {
                    rightElbowAngleRad = Math.atan2(Math.abs(rWr.x - rEl.x), Math.max(0.001, rWr.y - rEl.y));
                }
                if (lHip && lKnee) {
                    leftHipAngleRad = Math.atan2(Math.abs(lKnee.x - lHip.x), Math.max(0.001, lKnee.y - lHip.y));
                }
                if (rHip && rKnee) {
                    rightHipAngleRad = Math.atan2(Math.abs(rKnee.x - rHip.x), Math.max(0.001, rKnee.y - rHip.y));
                }

                detectedPoseAngles = {
                    leftShoulderAngleRad,
                    rightShoulderAngleRad,
                    leftElbowAngleRad,
                    rightElbowAngleRad,
                    leftHipAngleRad,
                    rightHipAngleRad
                };

                if (lSh && rSh && lHip && rHip) {
                    const shDist = Math.hypot(rSh.x - lSh.x, rSh.y - lSh.y);
                    const hipDist = Math.hypot(rHip.x - lHip.x, rHip.y - lHip.y);
                    const neckMidY = (lSh.y + rSh.y) * 0.5;
                    const hipMidY = (lHip.y + rHip.y) * 0.5;
                    const torsoLen = Math.abs(hipMidY - neckMidY);
                    let legLen = 0.5;
                    if (lAnk && rAnk) {
                        legLen = Math.abs(((lAnk.y + rAnk.y) * 0.5) - hipMidY);
                    }
                    const shoulderToHipRatio = Number(Math.min(1.4, Math.max(0.85, shDist / Math.max(0.01, hipDist))).toFixed(2));
                    const legToTorsoRatio = Number(Math.min(1.35, Math.max(0.85, legLen / Math.max(0.01, torsoLen))).toFixed(2));
                    const totalBodyHeight = spanY;
                    const headHeight = Math.max(0.04, neckMidY - headTopY);
                    const headsTall = Number(Math.min(8.95, Math.max(6.05, totalBodyHeight / headHeight)).toFixed(2));
                    const waistCinchRatio = Number(Math.min(1.0, Math.max(0.60, 0.72 * (hipDist / Math.max(0.01, shDist)))).toFixed(2));
                    const genderDimorphism = Number(Math.min(1.0, Math.max(-1.0, (hipDist - shDist) / Math.max(0.01, shDist) * 3.0)).toFixed(2));
                    const muscularityScore = Number(Math.min(1.0, Math.max(-0.5, (shDist - hipDist) / Math.max(0.01, hipDist) * 2.0)).toFixed(2));

                    ratios = {
                        ...ratios,
                        shoulderToHipRatio,
                        legToTorsoRatio,
                        headsTall,
                        waistCinchRatio,
                        genderDimorphism,
                        muscularityScore
                    };
                }
            }
        }

        let foregroundMask: Uint8Array | undefined;
        let maskWidth: number | undefined;
        let maskHeight: number | undefined;

        if (fs.existsSync(heroFramePath)) {
            try {
                const stat = fs.statSync(heroFramePath);
                if (stat.size > 512) {
                    const ffmpegBin = resolveBinary('ffmpeg');
                    if (ffmpegBin && fs.existsSync(ffmpegBin)) {
                        const W = 64;
                        const H = 128;
                        const thumb = execSync(
                            `"${ffmpegBin}" -v error -i "${heroFramePath}" -vf scale=${W}:${H} -f rawvideo -pix_fmt rgb24 pipe:1`,
                            { maxBuffer: 10 * 1024 * 1024 }
                        );
                        if (thumb.length === W * H * 3) {
                            foregroundMask = new Uint8Array(W * H);
                            maskWidth = W;
                            maskHeight = H;

                            // 1. Background estimation from border columns (x in [0..2] and [W-3..W-1])
                            let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
                            for (let y = 0; y < H; y++) {
                                for (const x of [0, 1, 2, W - 3, W - 2, W - 1]) {
                                    const idx = (y * W + x) * 3;
                                    bgR += thumb[idx];
                                    bgG += thumb[idx + 1];
                                    bgB += thumb[idx + 2];
                                    bgCount++;
                                }
                            }
                            bgR /= Math.max(1, bgCount);
                            bgG /= Math.max(1, bgCount);
                            bgB /= Math.max(1, bgCount);

                            // 2. Compute foreground mask and row profiles
                            const rowWidths = new Array(H).fill(0);
                            const rowCenters = new Array(H).fill(W / 2);
                            let minX = W, maxX = 0, minY = H, maxY = 0;
                            let fgPixels = 0;

                            for (let y = 0; y < H; y++) {
                                let rMinX = W, rMaxX = 0, rCount = 0, rSumX = 0;
                                for (let x = 3; x < W - 3; x++) {
                                    const idx = (y * W + x) * 3;
                                    const dr = thumb[idx] - bgR;
                                    const dg = thumb[idx + 1] - bgG;
                                    const db = thumb[idx + 2] - bgB;
                                    const dist = Math.sqrt(dr * dr + dg * dg + db * db);
                                    if (dist > 35) {
                                        foregroundMask[y * W + x] = 1;
                                        rCount++;
                                        rSumX += x;
                                        if (x < rMinX) rMinX = x;
                                        if (x > rMaxX) rMaxX = x;
                                        if (x < minX) minX = x;
                                        if (x > maxX) maxX = x;
                                        if (y < minY) minY = y;
                                        if (y > maxY) maxY = y;
                                        fgPixels++;
                                    }
                                }
                                if (rCount > 2) {
                                    rowWidths[y] = rMaxX - rMinX + 1;
                                    rowCenters[y] = Math.round(rSumX / rCount);
                                }
                            }

                            if (fgPixels > 50 && maxY > minY && maxX > minX) {
                                const silHeight = maxY - minY + 1;
                                const scaleX = width / W;
                                const scaleY = height / H;

                                // Only use image-based bounding box if landmarks were not provided
                                if (!activeLandmarks || activeLandmarks.length < 10) {
                                    boundingBox = {
                                        minX: Math.round(minX * scaleX),
                                        minY: Math.round(minY * scaleY),
                                        maxX: Math.round(maxX * scaleX),
                                        maxY: Math.round(maxY * scaleY)
                                    };
                                }

                                // 1. Find neck indentation (minimum contour width in 8-22% of silhouette)
                                let neckY = minY + Math.round(silHeight * 0.13);
                                let minNeckW = 999;
                                const nStart = minY + Math.max(2, Math.round(silHeight * 0.08));
                                const nEnd = minY + Math.round(silHeight * 0.22);
                                for (let y = nStart; y <= nEnd; y++) {
                                    if (rowWidths[y] > 0 && rowWidths[y] < minNeckW) {
                                        minNeckW = rowWidths[y];
                                        neckY = y;
                                    }
                                }
                                const headHeight = Math.max(3, neckY - minY);

                                // 2. Find shoulders (peak width in 15-35% of silhouette)
                                let shoulderY = minY + Math.round(silHeight * 0.22);
                                let maxSW = 0;
                                const sStart = minY + Math.round(silHeight * 0.15);
                                const sEnd = minY + Math.round(silHeight * 0.35);
                                for (let y = sStart; y <= sEnd; y++) {
                                    if (rowWidths[y] > maxSW) {
                                        maxSW = rowWidths[y];
                                        shoulderY = y;
                                    }
                                }

                                // 3. Find waist (minimum width in 35-55% of silhouette)
                                let waistY = minY + Math.round(silHeight * 0.42);
                                let minWW = 999;
                                const wStart = minY + Math.round(silHeight * 0.35);
                                const wEnd = minY + Math.round(silHeight * 0.55);
                                for (let y = wStart; y <= wEnd; y++) {
                                    if (rowWidths[y] > 0 && rowWidths[y] < minWW) {
                                        minWW = rowWidths[y];
                                        waistY = y;
                                    }
                                }

                                // 4. Find hips (peak width in 45-65% of silhouette)
                                let hipY = minY + Math.round(silHeight * 0.52);
                                let maxHW = 0;
                                const hStart = minY + Math.round(silHeight * 0.45);
                                const hEnd = minY + Math.round(silHeight * 0.65);
                                for (let y = hStart; y <= hEnd; y++) {
                                    if (rowWidths[y] > maxHW) {
                                        maxHW = rowWidths[y];
                                        hipY = y;
                                    }
                                }

                                // 5. Find crotch bifurcation (scanning downwards from hips)
                                let crotchY = minY + Math.round(silHeight * 0.52);
                                for (let y = hipY; y <= minY + Math.round(silHeight * 0.70); y++) {
                                    const cx = rowCenters[y];
                                    let hasInternalGap = false;
                                    for (let x = Math.max(0, cx - 2); x <= Math.min(W - 1, cx + 2); x++) {
                                        if (foregroundMask[y * W + x] === 0) {
                                            hasInternalGap = true;
                                            break;
                                        }
                                    }
                                    if (hasInternalGap) {
                                        crotchY = y;
                                        break;
                                    }
                                }
                                const torsoHeight = Math.max(4, crotchY - neckY);
                                const legHeight = Math.max(4, maxY - crotchY);

                                if (!activeLandmarks || activeLandmarks.length < 10) {
                                    const measuredHeadsTall = Number(Math.min(8.95, Math.max(6.05, silHeight / headHeight)).toFixed(2));
                                    const measuredShoulderToHip = Number(Math.min(1.4, Math.max(0.85, maxSW / Math.max(1, maxHW))).toFixed(2));
                                    const measuredWaistCinch = Number(Math.min(1.0, Math.max(0.60, minWW / Math.max(1, Math.max(maxSW, maxHW)))).toFixed(2));
                                    const measuredLegToTorso = Number(Math.min(1.4, Math.max(0.80, legHeight / torsoHeight)).toFixed(2));
                                    const measuredMuscularity = Number(Math.min(1.0, Math.max(-0.5, (maxSW - minWW) / Math.max(1, minWW) - 0.20)).toFixed(2));
                                    const measuredDimorphism = Number(Math.min(1.0, Math.max(-1.0, (maxHW - maxSW) / Math.max(1, maxSW) * 2.0)).toFixed(2));
                                    const measuredBust = Number(Math.min(0.45, Math.max(0.08, 0.18 + (measuredDimorphism > 0 ? measuredDimorphism * 0.12 : 0))).toFixed(2));

                                    ratios = {
                                        headsTall: measuredHeadsTall,
                                        shoulderToHipRatio: measuredShoulderToHip,
                                        waistCinchRatio: measuredWaistCinch,
                                        bustVolumeScore: measuredBust,
                                        legToTorsoRatio: measuredLegToTorso,
                                        muscularityScore: measuredMuscularity,
                                        genderDimorphism: measuredDimorphism,
                                        headWidthToHeightRatio: Number((minNeckW / Math.max(1, headHeight)).toFixed(2))
                                    };
                                }

                                // Extract landmarks from silhouette contour if not yet resolved
                                if (!activeLandmarks || activeLandmarks.length < 10) {
                                    activeLandmarks = this.extractSilhouetteLandmarks(thumb, W, H);
                                }

                                if (activeLandmarks && activeLandmarks.length >= 25) {
                                    const lSh = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_SHOULDER];
                                    const rSh = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_SHOULDER];
                                    const lEl = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_ELBOW];
                                    const rEl = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_ELBOW];
                                    const lWr = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_WRIST];
                                    const rWr = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_WRIST];
                                    const lHip = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_HIP];
                                    const rHip = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_HIP];
                                    const lKnee = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_KNEE];
                                    const rKnee = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_KNEE];

                                    let leftShoulderAngleRad: number | undefined;
                                    let rightShoulderAngleRad: number | undefined;
                                    let leftElbowAngleRad: number | undefined;
                                    let rightElbowAngleRad: number | undefined;
                                    let leftHipAngleRad: number | undefined;
                                    let rightHipAngleRad: number | undefined;

                                    if (lSh && lEl) leftShoulderAngleRad = Math.atan2(Math.abs(lEl.x - lSh.x), Math.max(0.001, lEl.y - lSh.y));
                                    if (rSh && rEl) rightShoulderAngleRad = Math.atan2(Math.abs(rEl.x - rSh.x), Math.max(0.001, rEl.y - rSh.y));
                                    if (lEl && lWr) leftElbowAngleRad = Math.atan2(Math.abs(lWr.x - lEl.x), Math.max(0.001, lWr.y - lEl.y));
                                    if (rEl && rWr) rightElbowAngleRad = Math.atan2(Math.abs(rWr.x - rEl.x), Math.max(0.001, rWr.y - rEl.y));
                                    if (lHip && lKnee) leftHipAngleRad = Math.atan2(Math.abs(lKnee.x - lHip.x), Math.max(0.001, lKnee.y - lHip.y));
                                    if (rHip && rKnee) rightHipAngleRad = Math.atan2(Math.abs(rKnee.x - rHip.x), Math.max(0.001, rKnee.y - rHip.y));

                                    detectedPoseAngles = {
                                        leftShoulderAngleRad,
                                        rightShoulderAngleRad,
                                        leftElbowAngleRad,
                                        rightElbowAngleRad,
                                        leftHipAngleRad,
                                        rightHipAngleRad
                                    };
                                }

                                // Sample colors from anatomical regions anchored by MediaPipe landmarks or silhouette contours
                                const sampleInsideMatte = (targetX: number, targetY: number): [number, number, number] => {
                                    let sx = Math.min(W - 1, Math.max(0, Math.round(targetX)));
                                    let sy = Math.min(H - 1, Math.max(0, Math.round(targetY)));

                                    if (foregroundMask && foregroundMask[sy * W + sx] > 0) {
                                        const idx = (sy * W + sx) * 3;
                                        return [
                                            Number((thumb[idx] / 255).toFixed(3)),
                                            Number((thumb[idx + 1] / 255).toFixed(3)),
                                            Number((thumb[idx + 2] / 255).toFixed(3))
                                        ];
                                    }

                                    // Search radial rings for nearest foreground pixel
                                    let bestDist = Infinity;
                                    let bestX = sx;
                                    let bestY = sy;
                                    let found = false;

                                    if (foregroundMask) {
                                        for (let r = 1; r <= 15 && !found; r++) {
                                            for (let dy = -r; dy <= r; dy++) {
                                                for (let dx = -r; dx <= r; dx++) {
                                                    if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
                                                    const qx = sx + dx;
                                                    const qy = sy + dy;
                                                    if (qx >= 0 && qx < W && qy >= 0 && qy < H) {
                                                        if (foregroundMask[qy * W + qx] > 0) {
                                                            const d = dx * dx + dy * dy;
                                                            if (d < bestDist) {
                                                                bestDist = d;
                                                                bestX = qx;
                                                                bestY = qy;
                                                                found = true;
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    if (!found && rowWidths && rowWidths[sy] > 2) {
                                        bestX = rowCenters[sy];
                                        bestY = sy;
                                    }

                                    const idx = (bestY * W + bestX) * 3;
                                    return [
                                        Number((thumb[idx] / 255).toFixed(3)),
                                        Number((thumb[idx + 1] / 255).toFixed(3)),
                                        Number((thumb[idx + 2] / 255).toFixed(3))
                                    ];
                                };

                                if (activeLandmarks && activeLandmarks.length >= 25) {
                                    const nose = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.NOSE];
                                    const lSh = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_SHOULDER];
                                    const rSh = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_SHOULDER];
                                    const lHip = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_HIP];
                                    const rHip = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_HIP];
                                    const lKnee = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_KNEE];
                                    const rKnee = activeLandmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_KNEE];

                                    // 1. Skin tone: at face/nose
                                    const faceX = (nose ? nose.x : (lSh.x + rSh.x) * 0.5) * W;
                                    const faceY = (nose ? nose.y : (lSh.y + rSh.y) * 0.5 - 0.08) * H;
                                    const skinTone = sampleInsideMatte(faceX, faceY);

                                    // 2. Hair: cranium region above nose
                                    const neckY = (lSh.y + rSh.y) * 0.5;
                                    const headSpan = Math.max(0.04, nose ? (neckY - nose.y) : 0.08);
                                    const craniumY = Math.max(minY / H + 0.01, (nose ? nose.y : neckY - headSpan) - headSpan * 0.55) * H;
                                    const craniumX = (nose ? nose.x : (lSh.x + rSh.x) * 0.5) * W;
                                    const hairColor = sampleInsideMatte(craniumX, craniumY);

                                    // 3. Torso: centroid of shoulders and hips
                                    const torsoX = (lSh.x + rSh.x + lHip.x + rHip.x) * 0.25 * W;
                                    const torsoY = (lSh.y + rSh.y + lHip.y + rHip.y) * 0.25 * H;
                                    const torsoColor = sampleInsideMatte(torsoX, torsoY);

                                    // 4. Legs: centroid of hips and knees
                                    const legsX = (lHip.x + rHip.x + lKnee.x + rKnee.x) * 0.25 * W;
                                    const legsY = (lHip.y + rHip.y + lKnee.y + rKnee.y) * 0.25 * H;
                                    const legsColor = sampleInsideMatte(legsX, legsY);

                                    colorSamples = {
                                        hairColorRgb: hairColor,
                                        skinToneRgb: skinTone,
                                        torsoColorRgb: torsoColor,
                                        legsColorRgb: legsColor
                                    };
                                } else {
                                    colorSamples = {
                                        hairColorRgb: sampleInsideMatte(rowCenters[Math.round(minY + silHeight * 0.04)], minY + silHeight * 0.04),
                                        skinToneRgb: sampleInsideMatte(rowCenters[Math.round(minY + silHeight * 0.10)], minY + silHeight * 0.10),
                                        torsoColorRgb: sampleInsideMatte(rowCenters[Math.round(shoulderY + 4)], shoulderY + 4),
                                        legsColorRgb: sampleInsideMatte(rowCenters[Math.round(minY + silHeight * 0.72)], minY + silHeight * 0.72)
                                    };
                                }
                            }
                        }
                    }
                }
            } catch {
                // Keep neutral fallback colors
            }
        }

        const solvedBetas = CharacterSilhouetteSolver.solveBetasFromRatios(ratios, targetHeight);

        return {
            heroFramePath,
            width,
            height,
            boundingBox,
            ratios,
            solvedBetas,
            colorSamples,
            landmarks2D: activeLandmarks,
            detectedPoseAngles,
            foregroundMask,
            maskWidth,
            maskHeight
        };
    }

    /**
     * Stage 3: Generates 35k–50k dense canonical Gaussians in natural Frame-0 resting pose
     * with 4-influence partition-of-unity skinning weights bound to the 22 SMPL-X joints.
     */
    public generateCanonicalPosedGaussians(
        silhouette: SilhouetteExtractionResult,
        numPoints: number = 8000,
        targetHeight: number = 1.78
    ): CanonicalGaussiansResult {
        // 1. Try loading clean-room .sbhuman parametric humanoid mesh standard
        const candidatePaths = [
            path.resolve('public/models/sbhuman_neutral.sbhuman'),
            path.resolve(process.cwd(), 'public/models/sbhuman_neutral.sbhuman'),
            path.join(__dirname, '../../../../../public/models/sbhuman_neutral.sbhuman'),
            path.join(__dirname, '../../../../public/models/sbhuman_neutral.sbhuman')
        ];

        let sbHumanBuffer: Buffer | null = null;
        for (const p of candidatePaths) {
            if (fs.existsSync(p)) {
                sbHumanBuffer = fs.readFileSync(p);
                break;
            }
        }

        if (sbHumanBuffer) {
            const loader = SbHumanLoader.parse(sbHumanBuffer);
            const betas = silhouette.solvedBetas || [0, 0, 0, 0, 0, 0, 0, 0];
            const sampled = loader.sampleUniformSurface(numPoints, betas);

            // Compute vertical bounding box for height normalization
            let minY = Infinity, maxY = -Infinity;
            for (let i = 0; i < sampled.count; i++) {
                const y = sampled.positions[i * 3 + 1];
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
            const meshHeight = (maxY - minY) || 1.72;
            const heightScale = targetHeight / meshHeight;

            // Scaled canonical joints (first 22 map to SMPL-X body skeleton)
            const canonicalJoints: Array<[number, number, number]> = loader.joints.slice(0, 22).map(j => [
                j.pos[0] * heightScale,
                (j.pos[1] - minY) * heightScale,
                j.pos[2] * heightScale
            ]);
            const kintreeParents = loader.joints.slice(0, 22).map(j => j.parent);
            const jointNames = loader.joints.slice(0, 22).map(j => j.name);

            // Mapping from all 55 joints down to the 22 canonical body joints via parent hierarchy
            const mapJointTo22 = (jId: number): number => {
                let curr = jId;
                while (curr >= 22 && curr >= 0 && curr < loader.joints.length) {
                    curr = loader.joints[curr].parent;
                }
                return Math.max(0, Math.min(21, curr));
            };

            const neckY = canonicalJoints[12] ? canonicalJoints[12][1] : targetHeight * 0.85;
            const pelvisY = canonicalJoints[0] ? canonicalJoints[0][1] : targetHeight * 0.52;
            const ankleY = canonicalJoints[7] ? canonicalJoints[7][1] : targetHeight * 0.06;

            const gaussians: SkinWeightedGaussian[] = [];

            for (let i = 0; i < sampled.count; i++) {
                const px = sampled.positions[i * 3] * heightScale;
                const py = (sampled.positions[i * 3 + 1] - minY) * heightScale;
                const pz = sampled.positions[i * 3 + 2] * heightScale;

                const nx = sampled.normals[i * 3];
                const ny = sampled.normals[i * 3 + 1];
                const nz = sampled.normals[i * 3 + 2];

                // Map 4 bone influences to 0..21
                const j0 = mapJointTo22(sampled.boneIndices[i * 4]);
                const j1 = mapJointTo22(sampled.boneIndices[i * 4 + 1]);
                const j2 = mapJointTo22(sampled.boneIndices[i * 4 + 2]);
                const j3 = mapJointTo22(sampled.boneIndices[i * 4 + 3]);

                // Accumulate duplicate bone influences
                const weightMap = new Map<number, number>();
                weightMap.set(j0, (weightMap.get(j0) || 0) + sampled.boneWeights[i * 4]);
                weightMap.set(j1, (weightMap.get(j1) || 0) + sampled.boneWeights[i * 4 + 1]);
                weightMap.set(j2, (weightMap.get(j2) || 0) + sampled.boneWeights[i * 4 + 2]);
                weightMap.set(j3, (weightMap.get(j3) || 0) + sampled.boneWeights[i * 4 + 3]);

                const sorted = Array.from(weightMap.entries()).sort((a, b) => b[1] - a[1]);
                const finalBones: [number, number, number, number] = [
                    sorted[0] ? sorted[0][0] : 0,
                    sorted[1] ? sorted[1][0] : 0,
                    sorted[2] ? sorted[2][0] : 0,
                    sorted[3] ? sorted[3][0] : 0
                ];
                let wSum = 0;
                for (let k = 0; k < 4; k++) {
                    if (k < sorted.length) wSum += sorted[k][1];
                }
                const invW = wSum > 1e-6 ? 1.0 / wSum : 1.0;
                const finalWeights: [number, number, number, number] = [
                    sorted[0] ? sorted[0][1] * invW : 0,
                    sorted[1] ? sorted[1][1] * invW : 0,
                    sorted[2] ? sorted[2][1] * invW : 0,
                    sorted[3] ? sorted[3][1] * invW : 0
                ];

                // Initial semantic base color before video ray backprojection
                let baseCol: [number, number, number];
                const isHand = Math.abs(px) > 0.58 && py > pelvisY - 0.1;
                const isArm = Math.abs(px) > 0.22 && py > pelvisY - 0.1;
                const hairCol = silhouette.colorSamples?.hairColorRgb || [0.15, 0.12, 0.10];
                const skinCol = silhouette.colorSamples?.skinToneRgb || [0.82, 0.65, 0.55];
                const torsoCol = silhouette.colorSamples?.torsoColorRgb || [0.25, 0.28, 0.32];
                const legsCol = silhouette.colorSamples?.legsColorRgb || [0.18, 0.18, 0.20];

                if (py > neckY) {
                    baseCol = py > neckY + 0.08 ? hairCol : skinCol;
                } else if (isHand) {
                    baseCol = skinCol;
                } else if (isArm) {
                    baseCol = torsoCol;
                } else if (py > pelvisY) {
                    baseCol = torsoCol;
                } else if (py > ankleY) {
                    baseCol = legsCol;
                } else {
                    baseCol = [0.12, 0.12, 0.12]; // Stage shoes
                }

                // Shortest-arc quaternion aligning reference normal (0, 0, 1) to surface normal N
                let qx = 0, qy = 0, qz = 0, qw = 1;
                const dotZ = nz;
                if (dotZ >= 0.9999) {
                    qx = 0; qy = 0; qz = 0; qw = 1;
                } else if (dotZ <= -0.9999) {
                    qx = 0; qy = 1; qz = 0; qw = 0;
                } else {
                    const ax = -ny;
                    const ay = nx;
                    const s = Math.sqrt((1 + dotZ) * 2);
                    const invS = 1 / s;
                    qx = ax * invS;
                    qy = ay * invS;
                    qz = 0;
                    qw = s * 0.5;
                }
                const qLen = Math.hypot(qx, qy, qz, qw) || 1.0;
                const quaternion: [number, number, number, number] = [qx / qLen, qy / qLen, qz / qLen, qw / qLen];

                // Tangent-aligned millimeter surfel scale:
                // Density factor scales smoothly with numPoints (e.g. 120k points -> ~2.6mm x 3.7mm x 0.8mm surfels)
                const densityFactor = Math.sqrt(35000 / Math.max(1000, numPoints));
                const sx = Math.max(0.0020, 0.0048 * densityFactor);
                const sy = Math.max(0.0028, 0.0068 * densityFactor);
                const sz = Math.max(0.0006, 0.0014 * densityFactor);
                const scale: [number, number, number] = [sx, sy, sz];

                gaussians.push({
                    position: [px, py, pz],
                    scale,
                    colorRgb: baseCol,
                    opacity: 0.96,
                    quaternion,
                    boneIndices: finalBones,
                    boneWeights: finalWeights,
                    normal: [nx, ny, nz]
                });
            }

            const heroPoseJoints = (silhouette.landmarks2D && silhouette.landmarks2D.length >= 25)
                ? this.computeDynamicPoseJointsFromLandmarks(canonicalJoints, silhouette.landmarks2D)
                : this.computeHeroRestingPoseJoints(canonicalJoints);

            return {
                gaussians,
                canonicalJoints,
                kintreeParents,
                jointNames,
                heroPoseJoints
            };
        }

        // 2. Fallback: Procedural cylinder proxy if .sbhuman file is absent
        const heightScale = targetHeight / 1.78;
        const shoulderScale = 1.0 + (silhouette.ratios.shoulderToHipRatio - 1.05) * 0.4;
        const legScale = silhouette.ratios.legToTorsoRatio;

        // Scale canonical joints
        const canonicalJoints: Array<[number, number, number]> = SBHUMAN_22_JOINTS.map(j => {
            let [x, y, z] = j.restOffset;
            x *= shoulderScale;
            if (y > 0.95) {
                // Torso & head
                y = 0.95 + (y - 0.95) * heightScale;
            } else {
                // Legs
                y *= heightScale * legScale;
            }
            return [x, y, z];
        });

        const kintreeParents = SBHUMAN_22_JOINTS.map(j => j.parent);
        const jointNames = SBHUMAN_22_JOINTS.map(j => j.name);

        const gaussians: SkinWeightedGaussian[] = [];

        // Define human segment volumetric massing cylinders & ellipsoids
        const segments: Array<{
            jointA: number;
            jointB: number;
            radius: number;
            pointCount: number;
            colorCategory: 'head' | 'torso' | 'arms' | 'legs' | 'feet';
        }> = [
            // Head & Neck
            { jointA: 12, jointB: 15, radius: 0.11, pointCount: Math.round(numPoints * 0.08), colorCategory: 'head' },
            // Torso (Pelvis to Spine3)
            { jointA: 0,  jointB: 9,  radius: 0.17 * shoulderScale, pointCount: Math.round(numPoints * 0.28), colorCategory: 'torso' },
            // Left Arm
            { jointA: 16, jointB: 18, radius: 0.065, pointCount: Math.round(numPoints * 0.07), colorCategory: 'arms' },
            { jointA: 18, jointB: 20, radius: 0.055, pointCount: Math.round(numPoints * 0.07), colorCategory: 'arms' },
            // Right Arm
            { jointA: 17, jointB: 19, radius: 0.065, pointCount: Math.round(numPoints * 0.07), colorCategory: 'arms' },
            { jointA: 19, jointB: 21, radius: 0.055, pointCount: Math.round(numPoints * 0.07), colorCategory: 'arms' },
            // Left Leg
            { jointA: 1,  jointB: 4,  radius: 0.095, pointCount: Math.round(numPoints * 0.12), colorCategory: 'legs' },
            { jointA: 4,  jointB: 7,  radius: 0.075, pointCount: Math.round(numPoints * 0.10), colorCategory: 'legs' },
            // Right Leg
            { jointA: 2,  jointB: 5,  radius: 0.095, pointCount: Math.round(numPoints * 0.12), colorCategory: 'legs' },
            { jointA: 5,  jointB: 8,  radius: 0.075, pointCount: Math.round(numPoints * 0.10), colorCategory: 'legs' },
            // Feet
            { jointA: 7,  jointB: 10, radius: 0.06,  pointCount: Math.round(numPoints * 0.01), colorCategory: 'feet' },
            { jointA: 8,  jointB: 11, radius: 0.06,  pointCount: Math.round(numPoints * 0.01), colorCategory: 'feet' }
        ];

        // Seeded deterministic pseudo-random generator
        let seed = 42;
        const random = () => {
            seed = (seed * 16807) % 2147483647;
            return (seed - 1) / 2147483646;
        };

        for (const seg of segments) {
            const a = canonicalJoints[seg.jointA];
            const b = canonicalJoints[seg.jointB];
            const dx = b[0] - a[0];
            const dy = b[1] - a[1];
            const dz = b[2] - a[2];
            const segLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.1;

            // Coordinate frame along segment
            const up: [number, number, number] = [dx / segLen, dy / segLen, dz / segLen];
            let right: [number, number, number] = [1, 0, 0];
            if (Math.abs(up[0]) > 0.9) right = [0, 1, 0];
            const fwd: [number, number, number] = [
                up[1] * right[2] - up[2] * right[1],
                up[2] * right[0] - up[0] * right[2],
                up[0] * right[1] - up[1] * right[0]
            ];
            const fwdLen = Math.sqrt(fwd[0] * fwd[0] + fwd[1] * fwd[1] + fwd[2] * fwd[2]) || 1;
            fwd[0] /= fwdLen; fwd[1] /= fwdLen; fwd[2] /= fwdLen;

            right[0] = fwd[1] * up[2] - fwd[2] * up[1];
            right[1] = fwd[2] * up[0] - fwd[0] * up[2];
            right[2] = fwd[0] * up[1] - fwd[1] * up[0];

            for (let i = 0; i < seg.pointCount; i++) {
                const t = random();
                const theta = random() * Math.PI * 2;
                // Radial jitter
                const r = seg.radius * (0.85 + 0.3 * (random() - 0.5));

                const cosT = Math.cos(theta);
                const sinT = Math.sin(theta);

                // Normal on cylinder
                const nx = right[0] * cosT + fwd[0] * sinT;
                const ny = right[1] * cosT + fwd[1] * sinT;
                const nz = right[2] * cosT + fwd[2] * sinT;

                const px = a[0] + dx * t + nx * r;
                const py = a[1] + dy * t + ny * r;
                const pz = a[2] + dz * t + nz * r;

                // Shortest-arc quaternion aligning reference normal (0, 0, 1) to surface normal N
                let qx = 0, qy = 0, qz = 0, qw = 1;
                const dotZ = nz;
                if (dotZ >= 0.9999) {
                    qx = 0; qy = 0; qz = 0; qw = 1;
                } else if (dotZ <= -0.9999) {
                    qx = 0; qy = 1; qz = 0; qw = 0;
                } else {
                    const ax = -ny;
                    const ay = nx;
                    const s = Math.sqrt((1 + dotZ) * 2);
                    const invS = 1 / s;
                    qx = ax * invS;
                    qy = ay * invS;
                    qz = 0;
                    qw = s * 0.5;
                }
                const qLen = Math.hypot(qx, qy, qz, qw) || 1.0;
                const quaternion: [number, number, number, number] = [qx / qLen, qy / qLen, qz / qLen, qw / qLen];

                const densityFactor = Math.sqrt(35000 / Math.max(1000, numPoints));
                const sx = Math.max(0.0020, 0.0048 * densityFactor);
                const sy = Math.max(0.0028, 0.0068 * densityFactor);
                const sz = Math.max(0.0006, 0.0014 * densityFactor);
                const scale: [number, number, number] = [sx, sy, sz];

                // Initial base color based on category
                let baseCol: [number, number, number];
                if (seg.colorCategory === 'head') baseCol = py > a[1] + 0.08 ? silhouette.colorSamples.hairColorRgb : silhouette.colorSamples.skinToneRgb;
                else if (seg.colorCategory === 'torso') baseCol = silhouette.colorSamples.torsoColorRgb;
                else if (seg.colorCategory === 'arms') baseCol = py < a[1] - 0.2 ? silhouette.colorSamples.skinToneRgb : silhouette.colorSamples.torsoColorRgb;
                else if (seg.colorCategory === 'legs') baseCol = silhouette.colorSamples.legsColorRgb;
                else baseCol = [0.1, 0.1, 0.1];

                gaussians.push({
                    position: [px, py, pz],
                    scale,
                    colorRgb: baseCol,
                    opacity: 0.95,
                    quaternion,
                    boneIndices: [seg.jointA, seg.jointB, 0, 0],
                    boneWeights: [1 - t, t, 0, 0],
                    normal: [nx, ny, nz]
                });
            }
        }

        // Rig with exact 4-bone partition-of-unity proximity skinning
        const dynamicSplatService = new Dynamic4DGaussianSplatService();
        const skinnedGaussians = dynamicSplatService.bindBoneWeights(gaussians, canonicalJoints, kintreeParents, 0.18);
        const heroPoseJoints = (silhouette.landmarks2D && silhouette.landmarks2D.length >= 25)
            ? this.computeDynamicPoseJointsFromLandmarks(canonicalJoints, silhouette.landmarks2D)
            : this.computeHeroRestingPoseJoints(canonicalJoints);

        return {
            gaussians: skinnedGaussians,
            canonicalJoints,
            kintreeParents,
            jointNames,
            heroPoseJoints
        };
    }

    /**
     * Stage 3b: Computes Frame 0 posed joints directly from MediaPipe 33-joint normalized landmarks,
     * determining true coronal shoulder abduction, elbow flexion, and leg stance angles.
     */
    public computeDynamicPoseJointsFromLandmarks(
        canonicalJoints: Array<[number, number, number]>,
        landmarks: MediaPipeNormalizedLandmark33[]
    ): Array<[number, number, number]> {
        const posed: Array<[number, number, number]> = canonicalJoints.map(j => [j[0], j[1], j[2]]);
        if (canonicalJoints.length < 22 || !landmarks || landmarks.length < 25) {
            return this.computeHeroRestingPoseJoints(canonicalJoints);
        }

        const lSh = landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_SHOULDER];
        const rSh = landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_SHOULDER];
        const lEl = landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_ELBOW];
        const rEl = landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_ELBOW];
        const lWr = landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_WRIST];
        const rWr = landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_WRIST];
        const lHip = landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_HIP];
        const rHip = landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_HIP];
        const lKnee = landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_KNEE];
        const rKnee = landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_KNEE];
        const lAnk = landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_ANKLE];
        const rAnk = landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_ANKLE];

        // Canonical joint references:
        // Left: 16 (shoulder), 18 (elbow), 20 (wrist)
        // Right: 17 (shoulder), 19 (elbow), 21 (wrist)
        const canLeftShoulder = canonicalJoints[16];
        const canLeftElbow = canonicalJoints[18];
        const canLeftWrist = canonicalJoints[20];
        const canRightShoulder = canonicalJoints[17];
        const canRightElbow = canonicalJoints[19];
        const canRightWrist = canonicalJoints[21];

        const leftUpperArmLen = Math.hypot(canLeftElbow[0] - canLeftShoulder[0], canLeftElbow[1] - canLeftShoulder[1], canLeftElbow[2] - canLeftShoulder[2]) || 0.26;
        const leftForearmLen = Math.hypot(canLeftWrist[0] - canLeftElbow[0], canLeftWrist[1] - canLeftElbow[1], canLeftWrist[2] - canLeftElbow[2]) || 0.25;
        const rightUpperArmLen = Math.hypot(canRightElbow[0] - canRightShoulder[0], canRightElbow[1] - canRightShoulder[1], canRightElbow[2] - canRightShoulder[2]) || 0.26;
        const rightForearmLen = Math.hypot(canRightWrist[0] - canRightElbow[0], canRightWrist[1] - canRightElbow[1], canRightWrist[2] - canRightElbow[2]) || 0.25;

        // Coronal arm abduction angle (from horizontal, 0 = T-pose horizontal, 90 = straight down)
        let leftAdductRad = (76 * Math.PI) / 180;
        let leftFlexRad = (14 * Math.PI) / 180;
        let rightAdductRad = (76 * Math.PI) / 180;
        let rightFlexRad = (14 * Math.PI) / 180;

        if (lSh && lEl) {
            const dy = Math.max(0.001, lEl.y - lSh.y);
            const dx = Math.abs(lEl.x - lSh.x);
            const angleFromVert = Math.atan2(dx, dy);
            leftAdductRad = Math.max(0.1, (Math.PI * 0.5) - angleFromVert);
        }
        if (lEl && lWr) {
            const dy = Math.max(0.001, lWr.y - lEl.y);
            const dx = Math.abs(lWr.x - lEl.x);
            leftFlexRad = Math.atan2(dx, dy);
        }

        if (rSh && rEl) {
            const dy = Math.max(0.001, rEl.y - rSh.y);
            const dx = Math.abs(rEl.x - rSh.x);
            const angleFromVert = Math.atan2(dx, dy);
            rightAdductRad = Math.max(0.1, (Math.PI * 0.5) - angleFromVert);
        }
        if (rEl && rWr) {
            const dy = Math.max(0.001, rWr.y - rEl.y);
            const dx = Math.abs(rWr.x - rEl.x);
            rightFlexRad = Math.atan2(dx, dy);
        }

        // Left arm (positive X in SMPL-X model coordinates)
        posed[18] = [
            canLeftShoulder[0] + leftUpperArmLen * Math.cos(leftAdductRad),
            canLeftShoulder[1] - leftUpperArmLen * Math.sin(leftAdductRad),
            canLeftShoulder[2]
        ];
        posed[20] = [
            posed[18][0] + 0.015,
            posed[18][1] - leftForearmLen * Math.cos(leftFlexRad),
            posed[18][2] + leftForearmLen * Math.sin(leftFlexRad) * 0.2
        ];

        // Right arm (negative X in SMPL-X model coordinates)
        posed[19] = [
            canRightShoulder[0] - rightUpperArmLen * Math.cos(rightAdductRad),
            canRightShoulder[1] - rightUpperArmLen * Math.sin(rightAdductRad),
            canRightShoulder[2]
        ];
        posed[21] = [
            posed[19][0] - 0.015,
            posed[19][1] - rightForearmLen * Math.cos(rightFlexRad),
            posed[19][2] + rightForearmLen * Math.sin(rightFlexRad) * 0.2
        ];

        // Legs stance adjustments if knee/ankle are spread
        if (lHip && lKnee && canonicalJoints[4]) {
            const kDx = (lKnee.x - lHip.x) * 0.5;
            posed[4][0] += kDx;
        }
        if (rHip && rKnee && canonicalJoints[5]) {
            const kDx = (rKnee.x - rHip.x) * 0.5;
            posed[5][0] += kDx;
        }
        if (lKnee && lAnk && canonicalJoints[7]) {
            const aDx = (lAnk.x - lKnee.x) * 0.5;
            posed[7][0] += aDx;
        }
        if (rKnee && rAnk && canonicalJoints[8]) {
            const aDx = (rAnk.x - rKnee.x) * 0.5;
            posed[8][0] += aDx;
        }

        return posed;
    }

    /**
     * Computes Frame 0 resting pose joints (arms adducted down, hands by thighs/waist)
     * matching the natural performer posture in the hero frame video.
     */
    public computeHeroRestingPoseJoints(
        canonicalJoints: Array<[number, number, number]>
    ): Array<[number, number, number]> {
        const posed: Array<[number, number, number]> = canonicalJoints.map(j => [j[0], j[1], j[2]]);
        if (canonicalJoints.length < 22) return posed;

        // SMPL-X arm joints:
        // Left: 16 (shoulder), 18 (elbow), 20 (wrist)
        // Right: 17 (shoulder), 19 (elbow), 21 (wrist)
        const leftShoulder = canonicalJoints[16];
        const leftElbow = canonicalJoints[18];
        const leftWrist = canonicalJoints[20];

        const rightShoulder = canonicalJoints[17];
        const rightElbow = canonicalJoints[19];
        const rightWrist = canonicalJoints[21];

        const leftUpperArmLen = Math.hypot(leftElbow[0] - leftShoulder[0], leftElbow[1] - leftShoulder[1], leftElbow[2] - leftShoulder[2]) || 0.26;
        const leftForearmLen = Math.hypot(leftWrist[0] - leftElbow[0], leftWrist[1] - leftElbow[1], leftWrist[2] - leftElbow[2]) || 0.25;

        const rightUpperArmLen = Math.hypot(rightElbow[0] - rightShoulder[0], rightElbow[1] - rightShoulder[1], rightElbow[2] - rightShoulder[2]) || 0.26;
        const rightForearmLen = Math.hypot(rightWrist[0] - rightElbow[0], rightWrist[1] - rightElbow[1], rightWrist[2] - rightElbow[2]) || 0.25;

        // Natural resting stance: arms adducted down alongside torso/thighs
        const adductRad = (78 * Math.PI) / 180;
        const flexRad = (8 * Math.PI) / 180;

        // Left arm (positive X in SMPL-X model coordinates)
        posed[18] = [
            leftShoulder[0] + leftUpperArmLen * Math.cos(adductRad),
            leftShoulder[1] - leftUpperArmLen * Math.sin(adductRad),
            leftShoulder[2]
        ];
        posed[20] = [
            posed[18][0] + 0.015,
            posed[18][1] - leftForearmLen * Math.cos(flexRad),
            posed[18][2] + leftForearmLen * Math.sin(flexRad) * 0.2
        ];

        // Right arm (negative X in SMPL-X model coordinates)
        posed[19] = [
            rightShoulder[0] - rightUpperArmLen * Math.cos(adductRad),
            rightShoulder[1] - rightUpperArmLen * Math.sin(adductRad),
            rightShoulder[2]
        ];
        posed[21] = [
            posed[19][0] - 0.015,
            posed[19][1] - rightForearmLen * Math.cos(flexRad),
            posed[19][2] + rightForearmLen * Math.sin(flexRad) * 0.2
        ];

        return posed;
    }

    /**
     * Resects the hero camera position from tracked 2D landmarks and the posed 3D skeleton.
     * The camera looks down -Z with known intrinsics, so each joint gives two equations linear in
     * the camera centre (camX, camY, standoff):
     *   (u - cx)·standoff + fx·camX = fx·X + (u - cx)·Z
     *   (v - cy)·standoff - fy·camY = -fy·Y + (v - cy)·Z
     */
    public solveCameraFromLandmarks(
        imageLandmarks: Array<[number, number, number, number]>,
        posedJoints: Array<[number, number, number]>,
        intrinsics: { width: number; height: number; fx: number; fy: number; cx: number; cy: number }
    ): { standoff: number; camX: number; camY: number } | null {
        const px = new HumanoidMotionBridgeService().convertLandmarksToSbHuman22(
            imageLandmarks.map(([x, y, , v]) => ({ x: x * intrinsics.width, y: -y * intrinsics.height, z: 0, visibility: v }))
        );
        const vis = new HumanoidMotionBridgeService().convertLandmarksToSbHuman22(
            imageLandmarks.map(([, , , v]) => ({ x: v, y: 0, z: 0, visibility: v }))
        );
        // Normal equations for A·[camX, camY, standoff] = b
        const AtA = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        const Atb = [0, 0, 0];
        let rows = 0;
        const addRow = (a: number[], b: number, w: number) => {
            for (let i = 0; i < 3; i++) {
                Atb[i] += w * a[i] * b;
                for (let j = 0; j < 3; j++) AtA[i][j] += w * a[i] * a[j];
            }
            rows++;
        };
        for (let j = 0; j < Math.min(22, posedJoints.length); j++) {
            const w = vis[j][0];
            if (w < 0.5) continue;
            const u = px[j][0];
            const v = px[j][1];
            const [X, Y, Z] = posedJoints[j];
            addRow([intrinsics.fx, 0, u - intrinsics.cx], intrinsics.fx * X + (u - intrinsics.cx) * Z, w);
            addRow([0, -intrinsics.fy, v - intrinsics.cy], -intrinsics.fy * Y + (v - intrinsics.cy) * Z, w);
        }
        if (rows < 8) return null;

        const det3 = (m: number[][]) =>
            m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
            m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
            m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        const D = det3(AtA);
        if (Math.abs(D) < 1e-9) return null;
        const solveCol = (k: number) => det3(AtA.map((row, i) => row.map((val, j) => (j === k ? Atb[i] : val)))) / D;
        const camX = solveCol(0);
        const camY = solveCol(1);
        const standoff = solveCol(2);
        if (!Number.isFinite(standoff) || standoff < 0.5 || standoff > 30) return null;
        return { standoff, camX, camY };
    }

    /**
     * Solves camera optical center (camX, camY) and standoff distance Z analytically
     * by fitting 3D target metric height to the 2D silhouette bounding box under pinhole projection.
     */
    public solveCameraFromSilhouette(
        boundingBox: { minX: number; minY: number; maxX: number; maxY: number },
        intrinsics: { width: number; height: number; fx: number; fy: number; cx: number; cy: number },
        targetHeight: number = 1.78
    ): { standoff: number; camX: number; camY: number } {
        const silH = Math.max(20, boundingBox.maxY - boundingBox.minY);
        const silCenterY = (boundingBox.minY + boundingBox.maxY) * 0.5;
        const silCenterX = (boundingBox.minX + boundingBox.maxX) * 0.5;

        // Pinhole camera equation: silH / fy = targetHeight / Z => Z = (fy * targetHeight) / silH
        const standoff = Math.max(0.8, Math.min(6.0, Number(((intrinsics.fy * targetHeight) / silH).toFixed(4))));

        // Vertical and lateral camera position shifts
        const camY = Math.max(0.4, Math.min(2.2, Number(((targetHeight * 0.5) + ((silCenterY - intrinsics.cy) * standoff) / intrinsics.fy).toFixed(4))));
        const camX = Math.max(-1.0, Math.min(1.0, Number((-((silCenterX - intrinsics.cx) * standoff) / intrinsics.fx).toFixed(4))));

        return { standoff, camX, camY };
    }

    /** Loads a grayscale mask image resized to W x H as a binary (>= 128) buffer. */
    public readGrayMask(maskPath: string, W: number, H: number): Uint8Array | null {
        const ffmpegBin = resolveBinary('ffmpeg');
        if (!ffmpegBin) return null;
        try {
            const raw = execSync(`"${ffmpegBin}" -v error -i "${maskPath}" -vf scale=${W}:${H} -f rawvideo -pix_fmt gray pipe:1`, { maxBuffer: W * H + 1024 });
            if (raw.length !== W * H) return null;
            const out = new Uint8Array(W * H);
            for (let i = 0; i < out.length; i++) out[i] = raw[i] >= 128 ? 1 : 0;
            return out;
        } catch {
            return null;
        }
    }

    /** Skins canonical Gaussians (positions + normals) into the Frame 0 hero pose. */
    public poseGaussiansToHero(
        gaussians: SkinWeightedGaussian[],
        canonicalJoints?: Array<[number, number, number]>,
        heroPoseJoints?: Array<[number, number, number]>,
        worldToCamera?: Mat3
    ): { positions: Vec3[]; normals: Vec3[] } {
        const toCam = (v: Vec3): Vec3 => (worldToCamera ? applyMat3(worldToCamera, v) : v);
        if (!canonicalJoints || !heroPoseJoints || canonicalJoints.length !== heroPoseJoints.length) {
            return { positions: gaussians.map(g => toCam(g.position)), normals: gaussians.map(g => toCam((g.normal || [0, 0, 1]) as Vec3)) };
        }
        const rotations: Mat3[] = computeBoneRotations(canonicalJoints, heroPoseJoints);
        return {
            positions: gaussians.map(g => toCam(skinPoint(g.position, g.boneIndices, g.boneWeights, canonicalJoints, heroPoseJoints, rotations))),
            normals: gaussians.map(g => toCam(applyMat3(rotations[g.boneIndices[0]] || rotations[0], (g.normal || [0, 0, 1]) as Vec3)))
        };
    }

    /**
     * Calculates 2D Mask Intersection-over-Union (IoU) by forward-projecting 3D Gaussians
     * onto the camera sensor and comparing against the extracted video foreground mask.
     * Gates video texture sampling if IoU < 0.70 to prevent backprojecting misaligned background pixels.
     */
    public calculateMaskIoU(
        gaussians: SkinWeightedGaussian[],
        camera: { fx: number; fy: number; cx: number; cy: number; width: number; height: number; standoff?: number; camX?: number; camY?: number },
        canonicalJoints?: Array<[number, number, number]>,
        heroPoseJoints?: Array<[number, number, number]>,
        fgMask?: Uint8Array | null,
        maskW: number = 64,
        maskH: number = 128
    ): { iou: number; gated: boolean; intersection: number; union: number; fgPixels: number; meshPixels: number } {
        if (!fgMask || fgMask.length !== maskW * maskH) {
            // When foreground mask is not available, gate texture sampling to prevent misaligned background backprojection
            return { iou: 0.0, gated: true, intersection: 0, union: 0, fgPixels: 0, meshPixels: 0 };
        }

        let fgPixels = 0;
        for (let i = 0; i < fgMask.length; i++) {
            if (fgMask[i] > 0) fgPixels++;
        }
        if (fgPixels < 20) {
            return { iou: 0.0, gated: true, intersection: 0, union: 0, fgPixels, meshPixels: 0 };
        }

        const standoff = (camera as any).standoff ?? (camera.height > camera.width ? 1.375 : 2.8);
        const camX = (camera as any).camX ?? 0.0;
        const camY = (camera as any).camY ?? (camera.height > camera.width ? 0.902 : 1.0);
        const camPos: [number, number, number] = [camX, camY, standoff];
        const posed = this.poseGaussiansToHero(gaussians, canonicalJoints, heroPoseJoints, (camera as any).worldToCamera);

        const meshMask = new Uint8Array(maskW * maskH);
        let meshPixels = 0;

        for (let i = 0; i < gaussians.length; i++) {
            const [x, y, z] = posed.positions[i];
            const camZ = camPos[2] - z;
            if (camZ <= 0.1) continue;

            const relX = x - camPos[0];
            const relY = y - camPos[1];
            const u = camera.fx * (relX / camZ) + camera.cx;
            const v = camera.fy * (-relY / camZ) + camera.cy;

            const mu = Math.floor((u / camera.width) * maskW);
            const mv = Math.floor((v / camera.height) * maskH);

            if (mu >= 0 && mu < maskW && mv >= 0 && mv < maskH) {
                for (let dy = -1; dy <= 1; dy++) {
                    const py = mv + dy;
                    if (py < 0 || py >= maskH) continue;
                    for (let dx = -1; dx <= 1; dx++) {
                        const px = mu + dx;
                        if (px < 0 || px >= maskW) continue;
                        const idx = py * maskW + px;
                        if (meshMask[idx] === 0) {
                            meshMask[idx] = 1;
                            meshPixels++;
                        }
                    }
                }
            }
        }

        let intersection = 0;
        let union = 0;
        for (let i = 0; i < maskW * maskH; i++) {
            const m = meshMask[i] > 0 ? 1 : 0;
            const f = fgMask[i] > 0 ? 1 : 0;
            if (m && f) intersection++;
            if (m || f) union++;
        }

        const iou = union > 0 ? Number((intersection / union).toFixed(4)) : 0.0;
        const gated = iou < 0.70;

        return {
            iou,
            gated,
            intersection,
            union,
            fgPixels,
            meshPixels
        };
    }

    /**
     * Stage 4: Projects 3D canonical Gaussians onto hero camera plane, verifies normal visibility,
     * and bakes high-fidelity video RGB and bilateral fill colors.
     * Uses forward LBS skinning to Frame 0 hero pose so 3D limbs align 1:1 with 2D video limbs.
     * Gated by Mask-IoU: if IoU < 0.70, falls back to palette proxy to prevent misaligned video sampling.
     */
    public backprojectVideoTextures(
        gaussians: SkinWeightedGaussian[],
        heroFramePath: string,
        colorPalette: SilhouetteExtractionResult['colorSamples'],
        camera: { fx: number; fy: number; cx: number; cy: number; width: number; height: number; standoff?: number; camX?: number; camY?: number },
        canonicalJoints?: Array<[number, number, number]>,
        heroPoseJoints?: Array<[number, number, number]>,
        fgMask?: Uint8Array | null,
        maskW: number = 64,
        maskH: number = 128,
        /** Full-resolution person mask; pixels outside it are never sampled as performer texture. */
        sampleMask: Uint8Array | null = null
    ): SkinWeightedGaussian[] & { iou: number; gated: boolean; reason?: string } {
        // Camera positioned at solved optical center [camX, camY, standoff] looking towards [camX, camY, 0]
        const standoff = (camera as any).standoff ?? (camera.height > camera.width ? 1.375 : 2.8);
        const camX = (camera as any).camX ?? 0.0;
        const camY = (camera as any).camY ?? (camera.height > camera.width ? 0.902 : 1.0);
        const camPos: [number, number, number] = [camX, camY, standoff];

        // Evaluate Mask-IoU gating metric
        const iouResult = this.calculateMaskIoU(
            gaussians,
            camera,
            canonicalJoints,
            heroPoseJoints,
            fgMask,
            maskW,
            maskH
        );

        const posed = this.poseGaussiansToHero(gaussians, canonicalJoints, heroPoseJoints, (camera as any).worldToCamera);

        // Attempt reading and decoding raw RGB pixels from heroFramePath
        let rgbBuffer: Buffer | null = null;
        if (heroFramePath && fs.existsSync(heroFramePath)) {
            try {
                const stat = fs.statSync(heroFramePath);
                if (stat.size > 512) {
                    const ffmpegBin = resolveBinary('ffmpeg');
                    if (ffmpegBin && fs.existsSync(ffmpegBin)) {
                        rgbBuffer = execSync(
                            `"${ffmpegBin}" -v error -i "${heroFramePath}" -vf scale=${camera.width}:${camera.height} -f rawvideo -pix_fmt rgb24 pipe:1`,
                            { maxBuffer: 50 * 1024 * 1024 }
                        );
                    }
                }
            } catch {
                rgbBuffer = null;
            }
        }

        const hasValidBuffer = rgbBuffer && rgbBuffer.length === camera.width * camera.height * 3;
        // A person segmentation mask already rejects background pixels per sample, so the coarse
        // IoU gate only applies when sampling would otherwise be unmasked.
        if (sampleMask) iouResult.gated = false;
        const allowVideoSampling = hasValidBuffer && !iouResult.gated;

        // Project every hero-posed Gaussian and keep a coarse z-buffer so occluded surfaces
        // (torso behind an arm, far leg behind near leg) are not painted with foreground pixels.
        const ZB = 4; // pixels per depth cell
        const zbW = Math.ceil(camera.width / ZB);
        const zbH = Math.ceil(camera.height / ZB);
        const zbuf = new Float32Array(zbW * zbH).fill(Infinity);
        const proj = posed.positions.map(([x, y, z]) => {
            const camZ = camPos[2] - z;
            if (camZ <= 0.1) return null;
            const u = camera.fx * ((x - camPos[0]) / camZ) + camera.cx;
            const v = camera.fy * (-(y - camPos[1]) / camZ) + camera.cy;
            if (u < 0 || u >= camera.width || v < 0 || v >= camera.height) return null;
            return { u, v, camZ };
        });
        proj.forEach(p => {
            if (!p) return;
            const cell = Math.floor(p.v / ZB) * zbW + Math.floor(p.u / ZB);
            if (p.camZ < zbuf[cell]) zbuf[cell] = p.camZ;
        });
        const depthTolerance = 0.03;

        const sampled: boolean[] = new Array(gaussians.length).fill(false);
        const mappedGaussians = gaussians.map((g, i) => {
            let col: [number, number, number] = [...g.colorRgb];
            const p = proj[i];
            if (!p) return { ...g, colorRgb: col };

            const [x, y, z] = posed.positions[i];
            const viewDir = normalize3([camPos[0] - x, camPos[1] - y, camPos[2] - z]);
            const n = posed.normals[i];
            const facing = n[0] * viewDir[0] + n[1] * viewDir[1] + n[2] * viewDir[2];
            const cell = Math.floor(p.v / ZB) * zbW + Math.floor(p.u / ZB);
            const visible = facing > 0.05 && p.camZ <= zbuf[cell] + depthTolerance;

            const pixel = Math.floor(p.v) * camera.width + Math.floor(p.u);
            const onPerformer = !sampleMask || sampleMask[pixel] > 0;
            if (visible && onPerformer && allowVideoSampling) {
                const pxIdx = pixel * 3;
                col = [rgbBuffer![pxIdx] / 255.0, rgbBuffer![pxIdx + 1] / 255.0, rgbBuffer![pxIdx + 2] / 255.0];
                sampled[i] = true;
            } else if (visible) {
                const frontalGain = 0.85 + 0.35 * Math.max(0, facing);
                col = [Math.min(1.0, col[0] * frontalGain), Math.min(1.0, col[1] * frontalGain), Math.min(1.0, col[2] * frontalGain)];
            }
            return { ...g, colorRgb: col };
        });

        // Unseen surfaces (back, occluded) inherit the mean observed colour of their primary bone.
        if (allowVideoSampling) {
            const sums = new Map<number, { r: number; g: number; b: number; n: number }>();
            mappedGaussians.forEach((g, i) => {
                if (!sampled[i]) return;
                const bone = g.boneIndices[0];
                const acc = sums.get(bone) || { r: 0, g: 0, b: 0, n: 0 };
                acc.r += g.colorRgb[0]; acc.g += g.colorRgb[1]; acc.b += g.colorRgb[2]; acc.n++;
                sums.set(bone, acc);
            });
            mappedGaussians.forEach((g, i) => {
                if (sampled[i]) return;
                const acc = sums.get(g.boneIndices[0]);
                if (acc && acc.n > 0) {
                    g.colorRgb = [acc.r / acc.n * 0.9, acc.g / acc.n * 0.9, acc.b / acc.n * 0.9];
                }
            });
        }

        const result = mappedGaussians as SkinWeightedGaussian[] & { iou: number; gated: boolean; reason?: string };
        result.iou = iouResult.iou;
        result.gated = iouResult.gated;
        result.reason = iouResult.gated
            ? `Gated: Mask-IoU (${iouResult.iou}) below 0.70 threshold; preserved §7 palette proxy.`
            : sampleMask
                ? `Sampled video pixels inside the person segmentation mask (Mask-IoU ${iouResult.iou}).`
                : `Ungated: Mask-IoU (${iouResult.iou}) >= 0.70 threshold; sampled video frame pixels.`;
        return result;
    }

    /**
     * Extracts 33 normalized MediaPipe-compatible landmarks from an image or video frame buffer
     * using analytical foreground contour and scanline profiling.
     */
    public extractSilhouetteLandmarks(
        thumb: Buffer,
        W: number = 64,
        H: number = 128
    ): MediaPipeNormalizedLandmark33[] {
        const landmarks: MediaPipeNormalizedLandmark33[] = new Array(33).fill(null).map(() => ({
            x: 0.5,
            y: 0.5,
            z: 0.0,
            visibility: 0.5
        }));

        if (!thumb || thumb.length < W * H * 3) {
            return landmarks;
        }

        // 1. Background color estimation from edge borders
        let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
        for (let y = 0; y < H; y++) {
            for (const x of [0, 1, 2, W - 3, W - 2, W - 1]) {
                const idx = (y * W + x) * 3;
                bgR += thumb[idx];
                bgG += thumb[idx + 1];
                bgB += thumb[idx + 2];
                bgCount++;
            }
        }
        bgR /= Math.max(1, bgCount);
        bgG /= Math.max(1, bgCount);
        bgB /= Math.max(1, bgCount);

        // 2. Foreground segmentation & row stats
        const rowWidths = new Array(H).fill(0);
        const rowCenters = new Array(H).fill(W / 2);
        const rowMinX = new Array(H).fill(W);
        const rowMaxX = new Array(H).fill(0);
        let minY = H, maxY = 0;

        for (let y = 0; y < H; y++) {
            let rCount = 0, rSumX = 0;
            for (let x = 2; x < W - 2; x++) {
                const idx = (y * W + x) * 3;
                const dr = thumb[idx] - bgR;
                const dg = thumb[idx + 1] - bgG;
                const db = thumb[idx + 2] - bgB;
                if (Math.hypot(dr, dg, db) > 30) {
                    rCount++;
                    rSumX += x;
                    if (x < rowMinX[y]) rowMinX[y] = x;
                    if (x > rowMaxX[y]) rowMaxX[y] = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                }
            }
            if (rCount > 1) {
                rowWidths[y] = rowMaxX[y] - rowMinX[y] + 1;
                rowCenters[y] = Math.round(rSumX / rCount);
            }
        }

        if (maxY <= minY || maxY - minY < 10) return landmarks;
        const silH = maxY - minY + 1;

        // Head & Neck
        let neckY = minY + Math.round(silH * 0.13);
        let minNW = 999;
        const nStart = minY + Math.max(2, Math.round(silH * 0.08));
        const nEnd = minY + Math.round(silH * 0.22);
        for (let y = nStart; y <= nEnd; y++) {
            if (rowWidths[y] > 0 && rowWidths[y] < minNW) {
                minNW = rowWidths[y];
                neckY = y;
            }
        }
        const headH = Math.max(3, neckY - minY);
        const noseY = minY + Math.round(headH * 0.55);
        const noseX = rowCenters[Math.min(H - 1, noseY)];

        landmarks[MEDIAPIPE_33_KEYPOINTS.NOSE] = { x: noseX / W, y: noseY / H, z: 0.0, visibility: 0.98 };
        landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_EAR] = { x: Math.min(W - 1, noseX + minNW * 0.45) / W, y: noseY / H, z: 0.0, visibility: 0.90 };
        landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_EAR] = { x: Math.max(0, noseX - minNW * 0.45) / W, y: noseY / H, z: 0.0, visibility: 0.90 };

        // Shoulders
        let shoulderY = minY + Math.round(silH * 0.22);
        let maxSW = 0;
        for (let y = minY + Math.round(silH * 0.15); y <= minY + Math.round(silH * 0.35); y++) {
            if (rowWidths[y] > maxSW) {
                maxSW = rowWidths[y];
                shoulderY = y;
            }
        }
        landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_SHOULDER] = { x: rowMaxX[shoulderY] / W, y: shoulderY / H, z: 0.0, visibility: 0.95 };
        landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_SHOULDER] = { x: rowMinX[shoulderY] / W, y: shoulderY / H, z: 0.0, visibility: 0.95 };

        // Hips
        let hipY = minY + Math.round(silH * 0.52);
        let maxHW = 0;
        for (let y = minY + Math.round(silH * 0.45); y <= minY + Math.round(silH * 0.65); y++) {
            if (rowWidths[y] > maxHW) {
                maxHW = rowWidths[y];
                hipY = y;
            }
        }
        landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_HIP] = { x: rowMaxX[hipY] / W, y: hipY / H, z: 0.0, visibility: 0.95 };
        landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_HIP] = { x: rowMinX[hipY] / W, y: hipY / H, z: 0.0, visibility: 0.95 };

        // Feet / Ankles
        const feetY = maxY;
        const leftFootX = rowCenters[feetY] + Math.max(2, Math.round(maxHW * 0.25));
        const rightFootX = rowCenters[feetY] - Math.max(2, Math.round(maxHW * 0.25));
        landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_ANKLE] = { x: Math.min(W - 1, leftFootX) / W, y: feetY / H, z: 0.0, visibility: 0.95 };
        landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_ANKLE] = { x: Math.max(0, rightFootX) / W, y: feetY / H, z: 0.0, visibility: 0.95 };

        // Knees
        const kneeY = Math.round((hipY + feetY) * 0.5);
        landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_KNEE] = { x: (rowMaxX[hipY] + leftFootX) * 0.5 / W, y: kneeY / H, z: 0.0, visibility: 0.95 };
        landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_KNEE] = { x: (rowMinX[hipY] + rightFootX) * 0.5 / W, y: kneeY / H, z: 0.0, visibility: 0.95 };

        // Arms: Find lateral hand / wrist extrema
        let leftWristX = rowMaxX[shoulderY];
        let leftWristY = shoulderY + Math.round(silH * 0.32);
        let rightWristX = rowMinX[shoulderY];
        let rightWristY = shoulderY + Math.round(silH * 0.32);

        // Search outer pixels between shoulder and mid-thigh
        for (let y = shoulderY; y <= hipY + Math.round(silH * 0.15); y++) {
            if (rowMaxX[y] > leftWristX) {
                leftWristX = rowMaxX[y];
                leftWristY = y;
            }
            if (rowMinX[y] < rightWristX && rowMinX[y] > 0) {
                rightWristX = rowMinX[y];
                rightWristY = y;
            }
        }

        landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_WRIST] = { x: leftWristX / W, y: leftWristY / H, z: 0.0, visibility: 0.90 };
        landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_WRIST] = { x: rightWristX / W, y: rightWristY / H, z: 0.0, visibility: 0.90 };

        // Elbows at midpoints
        landmarks[MEDIAPIPE_33_KEYPOINTS.LEFT_ELBOW] = {
            x: ((rowMaxX[shoulderY] + leftWristX) * 0.5 + 1) / W,
            y: (shoulderY + leftWristY) * 0.5 / H,
            z: 0.0,
            visibility: 0.90
        };
        landmarks[MEDIAPIPE_33_KEYPOINTS.RIGHT_ELBOW] = {
            x: ((rowMinX[shoulderY] + rightWristX) * 0.5 - 1) / W,
            y: (shoulderY + rightWristY) * 0.5 / H,
            z: 0.0,
            visibility: 0.90
        };

        return landmarks;
    }

    /**
     * Stage 5: Recovers performer kinematics across video frames with dynamic foot-contact
     * ground clamping so the performer's feet remain anchored to Y = 0.00m.
     * Motion choreographs smoothly from Frame 0 hero resting pose rather than horizontal T-pose.
     */
    public recoverPerformerMotion(
        canonicalJoints: Array<[number, number, number]>,
        parents: number[],
        fps: number = 30,
        durationSec: number = 4.8,
        clipId: string = 'performer_4d',
        heroPoseJoints?: Array<[number, number, number]>,
        videoPath?: string,
        heroFramePath?: string
    ): HumanoidMotionData {
        const totalFrames = Math.max(10, Math.round(durationSec * fps));
        const frames: HumanoidMotionFrame[] = [];
        const baseJoints = heroPoseJoints || canonicalJoints;

        let videoFrameLandmarks: MediaPipeNormalizedLandmark33[][] | null = null;

        // Attempt genuine video frame extraction and landmark tracking
        if (videoPath && fs.existsSync(videoPath)) {
            const ext = path.extname(videoPath).toLowerCase();
            const isVideo = ['.mp4', '.mov', '.webm', '.avi', '.mkv'].includes(ext);
            const ffmpegBin = resolveBinary('ffmpeg');

            if (isVideo && ffmpegBin && fs.existsSync(ffmpegBin)) {
                try {
                    const W = 64;
                    const H = 128;
                    const frameBytes = W * H * 3;
                    // Extract sequential frames at the specified sample fps
                    const rawBuffer = execSync(
                        `"${ffmpegBin}" -v error -i "${videoPath}" -t ${durationSec} -vf "fps=${fps},scale=${W}:${H}" -f rawvideo -pix_fmt rgb24 pipe:1`,
                        { maxBuffer: 40 * 1024 * 1024 }
                    );

                    const extractedCount = Math.floor(rawBuffer.length / frameBytes);
                    if (extractedCount > 0) {
                        videoFrameLandmarks = [];
                        for (let f = 0; f < extractedCount; f++) {
                            const chunk = rawBuffer.subarray(f * frameBytes, (f + 1) * frameBytes);
                            const lm = this.extractSilhouetteLandmarks(chunk, W, H);
                            videoFrameLandmarks.push(lm);
                        }
                    }
                } catch {
                    // Fall back to hero posture tracking
                }
            }
        }

        for (let f = 0; f < totalFrames; f++) {
            const time = f / fps;
            let jointPositions: Array<[number, number, number]>;

            if (videoFrameLandmarks && videoFrameLandmarks.length > 0) {
                // Video-bound motion: use extracted video frame landmarks!
                const lmIndex = Math.min(videoFrameLandmarks.length - 1, f);
                const lm = videoFrameLandmarks[lmIndex];
                jointPositions = this.computeDynamicPoseJointsFromLandmarks(canonicalJoints, lm);
            } else {
                // Posture anchored strictly to genuine heroPoseJoints with subtle natural sway
                const phase = time * Math.PI * 2 * 0.8;
                jointPositions = baseJoints.map((rest, j) => {
                    let [x, y, z] = rest;
                    if (j === 0) {
                        y += Math.sin(phase * 2) * 0.012;
                        x += Math.sin(phase) * 0.015;
                    } else if (j === 3 || j === 6 || j === 9) {
                        z += Math.sin(phase) * 0.010;
                        x += Math.sin(phase * 0.5) * 0.008;
                    } else if (j === 18 || j === 19) {
                        y += Math.sin(phase) * 0.015;
                    } else if (j === 20 || j === 21) {
                        y += Math.sin(phase) * 0.025;
                        x += Math.sin(phase) * 0.015;
                    }
                    return [x, y, z];
                });
            }

            frames.push({
                frame_index: f,
                timestamp: time,
                root_translation: [0, 0, 0],
                root_rotation_quat: [0, 0, 0, 1],
                joint_positions_3d: jointPositions,
                confidence: 0.94
            });
        }

        // Apply 3-frame moving average temporal smoothing to eliminate high-frequency pixel jitter
        if (frames.length >= 3) {
            const smoothedJoints: Array<Array<[number, number, number]>> = [];
            for (let f = 0; f < frames.length; f++) {
                const fPrev = Math.max(0, f - 1);
                const fNext = Math.min(frames.length - 1, f + 1);
                const j0 = frames[fPrev].joint_positions_3d;
                const j1 = frames[f].joint_positions_3d;
                const j2 = frames[fNext].joint_positions_3d;

                const sm: Array<[number, number, number]> = [];
                for (let j = 0; j < 22; j++) {
                    sm.push([
                        (j0[j][0] + j1[j][0] * 2 + j2[j][0]) * 0.25,
                        (j0[j][1] + j1[j][1] * 2 + j2[j][1]) * 0.25,
                        (j0[j][2] + j1[j][2] * 2 + j2[j][2]) * 0.25
                    ]);
                }
                smoothedJoints.push(sm);
            }
            for (let f = 0; f < frames.length; f++) {
                frames[f].joint_positions_3d = smoothedJoints[f];
            }
        }

        // Apply foot-ground clamping (lowest foot Y = 0.000m)
        for (let f = 0; f < frames.length; f++) {
            const jointPositions = frames[f].joint_positions_3d;
            const leftFootY = jointPositions[10][1];
            const rightFootY = jointPositions[11][1];
            const lowestFootY = Math.min(leftFootY, rightFootY);
            const groundDeltaY = 0.0 - lowestFootY;

            for (let j = 0; j < jointPositions.length; j++) {
                jointPositions[j][1] += groundDeltaY;
            }

            const pelvis = jointPositions[0];
            frames[f].root_translation = [pelvis[0], pelvis[1] - canonicalJoints[0][1], pelvis[2]];
        }

        return {
            clip_id: clipId,
            body_model: 'sbhuman_22',
            fps,
            num_frames: totalFrames,
            num_joints: 22,
            joints_name: SBHUMAN_22_JOINTS.map(j => j.name),
            kintree_parents: parents,
            canonical_joints: canonicalJoints,
            frames,
            motion_source: videoFrameLandmarks && videoFrameLandmarks.length > 0 ? 'silhouette_video' : 'synthetic_idle'
        };
    }

    /**
     * Stage 6: Writes the reference 3DGS ASCII PLY (SH colour, w-first quaternion) plus the exact
     * 4-influence Linear Blend Skinning bone indices and weights.
     */
    public writeStandardPly(filePath: string, gaussians: SkinWeightedGaussian[]): void {
        fs.writeFileSync(filePath, encodeGaussianPly(gaussians), 'utf-8');
    }
}
