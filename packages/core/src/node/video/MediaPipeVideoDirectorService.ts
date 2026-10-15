/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { Type, type Schema } from '@google/genai';
import { HeadlessVideoEditorService, toEven } from './HeadlessVideoEditorService';
import { MediaPipePoseService } from '../spatial/MediaPipePoseService';
import { GeneratorFailedError, MissingInputError, VisionUnavailableError } from '../../common/errors/pipeline-errors';
import {
    HumanoidPoseAngles,
    BodyFrame,
    MediaPipeLandmark,
    RiggedPoseOutput
} from '../../common/character-pose-protocol';

// ============================================================================
// Types & Interfaces
// ============================================================================

export interface TrackVideoMotionOptions {
    videoPath: string;
    fps?: number; // Sampling frame rate (default: 15)
    startTime?: number; // Start offset in seconds (default: 0)
    duration?: number; // Duration in seconds (default: entire clip)
    smoothingWindow?: number; // Moving average window size for joint smoothing (default: 3)
    minConfidence?: number; // Minimum pose confidence threshold (default: 0.4)
    outputJsonPath?: string; // Optional path to write JSON motion telemetry
}

export interface VideoMotionPoseFrame {
    frameIndex: number;
    timestampSec: number;
    angles: HumanoidPoseAngles;
    hipPositionMeters: [number, number, number];
    /** Hip-to-ground distance measured from the visible feet; absent when no foot is visible in the frame. */
    groundedYOffsetMeters?: number;
    confidence: number;
    bodyFrame?: BodyFrame;
    worldLandmarks?: MediaPipeLandmark[];
    imageLandmarks?: MediaPipeLandmark[];
    /** True when MediaPipe detected the person in this frame (every tracked frame is). */
    detected?: boolean;
}

/** A sampled frame in which MediaPipe found no person: it is left out of the track, never filled with a pose. */
export interface UndetectedMotionFrame {
    frameIndex: number;
    timestampSec: number;
    reason: string;
}

export interface VideoMotionTrackResult {
    success: boolean;
    durationSec: number;
    totalFramesAnalyzed: number;
    sampleFps: number;
    averageConfidence: number;
    maxDisplacementMeters: number;
    /** Mean hip-to-ground distance over the frames whose feet were visible; absent when no frame showed a foot. */
    groundedYReferenceMeters?: number;
    frames: VideoMotionPoseFrame[];
    /** Sampled frames with no detected person (left out of frames). */
    undetectedFrames?: UndetectedMotionFrame[];
    outputJsonPath?: string;
    error?: string;
    [key: string]: unknown;
}

export interface AutoReframeOptions {
    inputVideoPath: string;
    outputVideoPath?: string;
    targetAspectRatio: '9:16' | '1:1' | '4:5' | '16:9' | string;
    focusMode?: 'face' | 'body' | 'action' | 'center'; // default: 'body'
    sampleIntervalSec?: number; // Sampling interval for subject tracking (default: 0.5s)
}

export interface ReframeWaypoint {
    timestampSec: number;
    cropX: number;
    cropY: number;
    cropWidth: number;
    cropHeight: number;
    subjectCenterX: number;
    subjectCenterY: number;
    /** Mean visibility of the landmarks the subject centre came from; absent for focusMode 'center' (no tracking). */
    confidence?: number;
}

export interface AutoReframeResult {
    success: boolean;
    inputVideoPath: string;
    outputVideoPath: string;
    targetAspectRatio: string;
    inputDimensions: { width: number; height: number };
    cropDimensions: { width: number; height: number };
    waypoints: ReframeWaypoint[];
    /** Sampled frames in which MediaPipe found no person: left out of the crop, never centred instead. */
    undetectedSamples?: Array<{ timestampSec: number; reason: string }>;
    ffmpegCommand?: string;
    filtergraph?: string;
    error?: string;
    [key: string]: unknown;
}

export interface VisualCriticDimensionAudit {
    /** The vision model's score for this dimension, 0..10. */
    score: number;
    /** score >= the audit's minPassingScore. */
    passed: boolean;
    /** What the vision model saw that led to the score. */
    notes: string;
}

/** The 8 dimensions of the Visual Fidelity Rubric, each scored by the vision model from the contact sheet. */
export const VISUAL_CRITIC_DIMENSIONS = {
    geometricDefinition: 'Geometric definition and silhouette crispness: no amorphous, lumpy, melting or stretched shapes; limbs and edges keep their form across frames.',
    pixelSplatDensity: 'Pixel / splat density: even sampling with no macro-blocking, compression banding, holes, or point-sprite billboard discs.',
    materialMicroSurface: 'Material and micro-surface definition: physically plausible albedo, roughness, specular highlights and micro-detail, not flat untextured grey.',
    environmentalGrounding: 'Environmental context and grounding: a complete environment (no black or empty void), subjects in contact with the ground, nothing floating or cut off.',
    radiometricLighting: 'Radiometric lighting and shadows: shadows that match the light direction and the silhouettes, contact occlusion, no painted-on 2D drop shadows.',
    colorTemperature: 'Colour temperature harmony: foreground and background lit at one consistent colour temperature, no unexplained colour cast.',
    volumetricDepth: 'Volumetric depth and interleaving: believable depth separation and parallax, no clipping or boundary seams between layers.',
    photographicRealism: 'Photographic realism (the squint test): would an unprimed viewer take these frames for a real optical photograph?'
} as const;

export type VisualCriticDimension = keyof typeof VISUAL_CRITIC_DIMENSIONS;

/** The vision model that scores the rubric. */
export const VISUAL_CRITIC_MODEL = 'gemini-2.5-flash';

export interface VisualCriticAuditOptions {
    videoPath: string;
    promptContext?: string;
    referencePlatePath?: string;
    minPassingScore?: number; // default: 8.5
}

/**
 * Body consistency measured with MediaPipe on frames sampled from the video. A video with nobody in it has nothing to
 * measure: the counts say so and limbLengthStabilityRatio is absent with the reason.
 */
export interface AnatomicalConsistencyAudit {
    framesSampled: number;
    framesWithPerson: number;
    /**
     * 1 minus the mean coefficient of variation of the four limb lengths (shoulder-elbow-wrist, hip-knee-ankle)
     * across the frames with 3D landmarks (1 = the limbs keep their length). Absent when fewer than two frames had them.
     */
    limbLengthStabilityRatio?: number;
    /** Why limbLengthStabilityRatio is absent. */
    notMeasuredReason?: string;
}

export interface VisualCriticAuditResult {
    success: boolean;
    videoPath: string;
    /** Mean of the eight dimension scores the vision model gave. */
    overallScore: number;
    /** True only when every dimension scored at least minPassingScore. */
    passed: boolean;
    minPassingScore: number;
    failedDimensions: VisualCriticDimension[];
    /** The 3x3 contact sheet the vision model scored. */
    storyboardSheetPath: string;
    /** The vision model that scored the dimensions. */
    visionModel: string;
    anatomicalConsistency: AnatomicalConsistencyAudit;
    dimensionAudits: Record<VisualCriticDimension, VisualCriticDimensionAudit>;
    /** The vision model's fixes for the failing dimensions; present only when the audit failed. */
    remediationRecipe?: {
        actionDirectives: string[];
        suggestedFfmpegFilters: string[];
    };
    [key: string]: unknown;
}

const visualCriticDimensionSchema: Schema = {
    type: Type.OBJECT,
    properties: {
        score: { type: Type.NUMBER, description: 'Score from 0 (fails completely) to 10 (flawless), from what the frames show.' },
        notes: { type: Type.STRING, description: 'What in the frames led to this score, specific to this video.' }
    },
    required: ['score', 'notes']
};

const visualCriticSchema: Schema = {
    type: Type.OBJECT,
    properties: {
        dimensions: {
            type: Type.OBJECT,
            properties: Object.fromEntries(Object.keys(VISUAL_CRITIC_DIMENSIONS).map(k => [k, visualCriticDimensionSchema])),
            required: Object.keys(VISUAL_CRITIC_DIMENSIONS)
        },
        actionDirectives: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Concrete fixes for the dimensions that score below the passing score; empty when none do.' },
        suggestedFfmpegFilters: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'FFmpeg -vf filter expressions that would address those dimensions, if any can; empty otherwise.' }
    },
    required: ['dimensions', 'actionDirectives', 'suggestedFfmpegFilters']
};

// ============================================================================
// Service Implementation
// ============================================================================

export class MediaPipeVideoDirectorService {
    private editorService: HeadlessVideoEditorService;
    private poseService: MediaPipePoseService;
    private visionClient: any;

    /**
     * @param options.visionClient a `@google/genai` client for the visual critic (tests inject one); otherwise the
     *   configured Gemini client is used when an audit runs.
     */
    constructor(
        editorService?: HeadlessVideoEditorService,
        poseService?: MediaPipePoseService,
        options?: { visionClient?: any }
    ) {
        this.editorService = editorService ?? new HeadlessVideoEditorService();
        this.poseService = poseService ?? new MediaPipePoseService();
        this.visionClient = options?.visionClient;
    }

    /**
     * Parse target aspect ratio string into a float (width / height). A ratio that does not parse to a positive
     * number throws MissingInputError; no ratio is assumed in its place.
     */
    public static parseAspectRatio(ratioStr: string): number {
        const cleaned = ratioStr.trim().toLowerCase();
        if (cleaned === '9:16' || cleaned === 'vertical') return 9 / 16;
        if (cleaned === '1:1' || cleaned === 'square') return 1.0;
        if (cleaned === '4:5') return 4 / 5;
        if (cleaned === '16:9' || cleaned === 'horizontal' || cleaned === 'landscape') return 16 / 9;

        const parts = cleaned.split(':').map(p => Number(p));
        if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[0] > 0 && parts[1] > 0) {
            return parts[0] / parts[1];
        }
        const val = Number(cleaned);
        if (Number.isFinite(val) && val > 0) return val;
        throw new MissingInputError('vfx_video_auto_reframe', 'targetAspectRatio', `"${ratioStr}" is not a ratio such as "9:16", "4:5" or 0.75`);
    }

    // ── Pipeline 1: Video Motion Tracking & SB-Human Kinematics ─────────────

    /**
     * Ingests video, extracts sequential frame stills via FFmpeg, solves 3D body pose
     * kinematics per frame via MediaPipe, applies temporal smoothing, and exports
     * articulated motion tracks ready for the native C++20 SB-Human engine.
     */
    public async trackVideoMotion(options: TrackVideoMotionOptions): Promise<VideoMotionTrackResult> {
        const sampleFps = options.fps ?? 15;
        const smoothingWindow = Math.max(1, options.smoothingWindow ?? 3);
        const minConf = options.minConfidence ?? 0.4;

        if (!await fs.pathExists(options.videoPath)) {
            throw new MissingInputError('vfx_mediapipe_track_video_motion', 'videoPath', `${options.videoPath} does not exist`);
        }

        const probe = await this.editorService.probeMedia(options.videoPath);
        const totalDuration = options.duration ?? Math.max(0.1, probe.durationSec - (options.startTime ?? 0));
        const startSec = Math.max(0, options.startTime ?? 0);

        // Generate timestamps to extract
        const totalSamples = Math.max(1, Math.round(totalDuration * sampleFps));
        const timestamps: number[] = [];
        for (let i = 0; i < totalSamples; i++) {
            const ts = startSec + (i / sampleFps);
            if (ts <= probe.durationSec) {
                timestamps.push(Math.round(ts * 1000) / 1000);
            }
        }

        // Temporary directory for extracted frames
        const tmpDir = path.join(os.tmpdir(), `sb_motion_track_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
        await fs.ensureDir(tmpDir);

        const rawFrames: VideoMotionPoseFrame[] = [];
        const undetectedFrames: UndetectedMotionFrame[] = [];

        try {
            // Extract frame images via FFmpeg
            const extractRes = await this.editorService.extractKeyframes({
                inputPath: options.videoPath,
                outputDir: tmpDir,
                timestampsSec: timestamps,
                format: 'png'
            });

            const extractedFiles = extractRes.outputPaths || [];
            for (let i = 0; i < extractedFiles.length; i++) {
                const filePath = extractedFiles[i];
                const ts = timestamps[i] ?? (startSec + i / sampleFps);

                // A frame with nobody detected is left out and listed; a detector that cannot run fails the track
                // (GeneratorFailedError propagates). No frame is ever filled with a stand-in pose.
                let poseOutput: RiggedPoseOutput;
                try {
                    const imgBuffer = await fs.readFile(filePath);
                    poseOutput = await this.poseService.estimatePoseFromImage({
                        image: imgBuffer,
                        minConfidence: minConf
                    });
                } catch (err) {
                    if (err instanceof MissingInputError) {
                        undetectedFrames.push({ frameIndex: i, timestampSec: ts, reason: err.message });
                        continue;
                    }
                    throw err;
                }

                rawFrames.push({
                    frameIndex: i,
                    timestampSec: ts,
                    angles: poseOutput.angles,
                    hipPositionMeters: poseOutput.hipPositionMeters,
                    groundedYOffsetMeters: poseOutput.groundedYOffsetMeters,
                    confidence: poseOutput.confidence,
                    bodyFrame: poseOutput.bodyFrame,
                    worldLandmarks: poseOutput.worldLandmarks,
                    imageLandmarks: poseOutput.imageLandmarks,
                    detected: true
                });
            }
        } finally {
            // Clean up temporary extracted frame images
            await fs.remove(tmpDir).catch(() => {});
        }

        if (rawFrames.length === 0) {
            return {
                success: false,
                durationSec: 0,
                totalFramesAnalyzed: 0,
                sampleFps,
                averageConfidence: 0,
                maxDisplacementMeters: 0,
                frames: [],
                undetectedFrames,
                error: undetectedFrames.length
                    ? `MediaPipe found no person in any of the ${undetectedFrames.length} sampled frame(s)`
                    : 'No frames were extracted from the video'
            };
        }

        // Apply temporal kinematic smoothing
        const smoothedFrames = this.applyTemporalSmoothing(rawFrames, smoothingWindow);

        // Calculate summary metrics
        const confSum = smoothedFrames.reduce((acc, f) => acc + f.confidence, 0);
        const avgConf = Math.round((confSum / smoothedFrames.length) * 100) / 100;

        let maxDisplacement = 0;
        const initialHip = smoothedFrames[0].hipPositionMeters;
        for (const frame of smoothedFrames) {
            const dx = frame.hipPositionMeters[0] - initialHip[0];
            const dy = frame.hipPositionMeters[1] - initialHip[1];
            const dz = frame.hipPositionMeters[2] - initialHip[2];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > maxDisplacement) maxDisplacement = dist;
        }

        // Only frames whose feet were visible measured the ground; the others do not count towards it.
        const grounded = smoothedFrames.map(f => f.groundedYOffsetMeters).filter((v): v is number => v !== undefined);
        const groundedYRef = grounded.length ? grounded.reduce((acc, v) => acc + v, 0) / grounded.length : undefined;

        const result: VideoMotionTrackResult = {
            success: true,
            durationSec: totalDuration,
            totalFramesAnalyzed: smoothedFrames.length,
            sampleFps,
            averageConfidence: avgConf,
            maxDisplacementMeters: Math.round(maxDisplacement * 1000) / 1000,
            groundedYReferenceMeters: groundedYRef === undefined ? undefined : Math.round(groundedYRef * 1000) / 1000,
            frames: smoothedFrames,
            undetectedFrames,
            outputJsonPath: options.outputJsonPath
        };

        if (options.outputJsonPath) {
            await fs.ensureDir(path.dirname(options.outputJsonPath));
            await fs.writeJson(options.outputJsonPath, result, { spaces: 2 });
        }

        return result;
    }

    /**
     * Applies moving-average smoothing to joint Euler angles and hip translation
     * across temporal frame sequence to eliminate tracking jitter.
     */
    private applyTemporalSmoothing(
        frames: VideoMotionPoseFrame[],
        windowSize: number
    ): VideoMotionPoseFrame[] {
        if (frames.length <= 1 || windowSize <= 1) {
            return frames;
        }

        const halfWin = Math.floor(windowSize / 2);
        const smoothed: VideoMotionPoseFrame[] = [];

        for (let i = 0; i < frames.length; i++) {
            const startIdx = Math.max(0, i - halfWin);
            const endIdx = Math.min(frames.length - 1, i + halfWin);
            const count = endIdx - startIdx + 1;

            const baseAngles = frames[i].angles;
            const jointKeys = Object.keys(baseAngles) as Array<keyof HumanoidPoseAngles>;

            const avgAngles: Partial<HumanoidPoseAngles> = {};

            for (const key of jointKeys) {
                let s0 = 0, s1 = 0, s2 = 0;
                for (let k = startIdx; k <= endIdx; k++) {
                    const rot = frames[k].angles[key];
                    s0 += rot[0];
                    s1 += rot[1];
                    s2 += rot[2];
                }
                avgAngles[key] = [s0 / count, s1 / count, s2 / count];
            }

            let hipX = 0, hipY = 0, hipZ = 0;
            let groundedY = 0, groundedCount = 0;
            for (let k = startIdx; k <= endIdx; k++) {
                hipX += frames[k].hipPositionMeters[0];
                hipY += frames[k].hipPositionMeters[1];
                hipZ += frames[k].hipPositionMeters[2];
                const g = frames[k].groundedYOffsetMeters;
                if (g !== undefined) { groundedY += g; groundedCount++; }
            }

            smoothed.push({
                ...frames[i],
                angles: avgAngles as HumanoidPoseAngles,
                hipPositionMeters: [hipX / count, hipY / count, hipZ / count],
                // A frame with no visible foot keeps no offset rather than borrowing its neighbours'.
                groundedYOffsetMeters: frames[i].groundedYOffsetMeters === undefined || groundedCount === 0 ? undefined : groundedY / groundedCount
            });
        }

        return smoothed;
    }

    // ── Pipeline 2: Intelligent Video Auto-Reframing ─────────────────────────

    /**
     * Re-frames a video into vertical (9:16), square (1:1) or any other aspect ratio: MediaPipe finds the person in
     * frames sampled across the clip, and FFmpeg renders one static crop at the average of the tracked positions.
     * The input's real size and length come from probing it.
     */
    public async autoReframeVideo(options: AutoReframeOptions): Promise<AutoReframeResult> {
        const targetRatio = MediaPipeVideoDirectorService.parseAspectRatio(options.targetAspectRatio);
        const sampleInterval = Math.max(0.1, options.sampleIntervalSec ?? 0.5);
        const focusMode = options.focusMode ?? 'body';

        if (!await fs.pathExists(options.inputVideoPath)) {
            throw new MissingInputError('vfx_video_auto_reframe', 'inputVideoPath', `${options.inputVideoPath} does not exist`);
        }
        const probe = await this.editorService.probeMedia(options.inputVideoPath);
        const inputDims = { width: probe.width, height: probe.height };
        const duration = probe.durationSec;

        // Calculate crop window dimensions bounded inside input dimensions
        let cropW: number;
        let cropH: number;

        if (targetRatio <= inputDims.width / inputDims.height) {
            // Target is taller/narrower than input (e.g. 9:16 from 16:9)
            cropH = inputDims.height;
            cropW = toEven(Math.round(cropH * targetRatio));
            if (cropW > inputDims.width) {
                cropW = toEven(inputDims.width);
                cropH = toEven(Math.round(cropW / targetRatio));
            }
        } else {
            // Target is wider than input
            cropW = inputDims.width;
            cropH = toEven(Math.round(cropW / targetRatio));
            if (cropH > inputDims.height) {
                cropH = toEven(inputDims.height);
                cropW = toEven(Math.round(cropH * targetRatio));
            }
        }

        const maxCropX = Math.max(0, inputDims.width - cropW);
        const maxCropY = Math.max(0, inputDims.height - cropH);

        // Generate sample timestamps
        const sampleCount = Math.max(2, Math.ceil(duration / sampleInterval));
        const waypoints: ReframeWaypoint[] = [];
        const undetectedSamples: Array<{ timestampSec: number; reason: string }> = [];

        // Extract sample keyframes
        const tmpDir = path.join(os.tmpdir(), `sb_reframe_samples_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
        await fs.ensureDir(tmpDir);

        const sampleTimestamps: number[] = [];
        for (let i = 0; i < sampleCount; i++) {
            sampleTimestamps.push(Math.min(duration, i * sampleInterval));
        }

        try {
            const extractRes = await this.editorService.extractKeyframes({
                inputPath: options.inputVideoPath,
                outputDir: tmpDir,
                timestampsSec: sampleTimestamps,
                format: 'png'
            });

            const extractedFiles = extractRes.outputPaths || [];
            if (extractedFiles.length === 0) {
                throw new GeneratorFailedError('ffmpeg', `no frames could be extracted from ${options.inputVideoPath} to track the subject in`);
            }
            for (let i = 0; i < extractedFiles.length; i++) {
                const filePath = extractedFiles[i];
                const ts = sampleTimestamps[i];

                let normCenterX: number;
                let normCenterY: number;
                let confidence: number | undefined;
                if (focusMode === 'center') {
                    // Asked for: a centred crop, with no subject tracking.
                    normCenterX = 0.5;
                    normCenterY = 0.5;
                } else {
                    const run = await this.poseService.runPoseLandmarker(await fs.readFile(filePath), { numPoses: 1 });
                    if ('unavailable' in run) {
                        throw new GeneratorFailedError('mediapipe', `pose detection could not run, so the subject cannot be tracked for reframing: ${run.unavailable}`);
                    }
                    const lms = 'detection' in run ? run.detection.imageLandmarks[0] : undefined;
                    if (!lms || lms.length < 33) {
                        undetectedSamples.push({ timestampSec: Math.round(ts * 100) / 100, reason: 'noPerson' in run ? run.noPerson : 'MediaPipe returned no full set of body landmarks' });
                        continue;
                    }
                    // Face: the nose; body and action: the middle of the shoulders and hips.
                    const used = focusMode === 'face' ? [lms[0]] : [lms[11], lms[12], lms[23], lms[24]];
                    normCenterX = used.reduce((acc, lm) => acc + lm.x, 0) / used.length;
                    normCenterY = used.reduce((acc, lm) => acc + lm.y, 0) / used.length;
                    confidence = used.reduce((acc, lm) => acc + (lm.visibility ?? 0), 0) / used.length;
                }

                const centerPixX = normCenterX * inputDims.width;
                // For vertical formats (9:16), position head in upper third for pleasing composition
                const verticalBias = targetRatio < 1.0 ? 0.38 : 0.5;
                const centerPixY = normCenterY * inputDims.height;

                const targetX = centerPixX - cropW / 2;
                const targetY = centerPixY - cropH * verticalBias;

                const cropX = Math.round(Math.max(0, Math.min(maxCropX, targetX)));
                const cropY = Math.round(Math.max(0, Math.min(maxCropY, targetY)));

                waypoints.push({
                    timestampSec: Math.round(ts * 100) / 100,
                    cropX,
                    cropY,
                    cropWidth: cropW,
                    cropHeight: cropH,
                    subjectCenterX: Math.round(centerPixX),
                    subjectCenterY: Math.round(centerPixY),
                    ...(confidence === undefined ? {} : { confidence })
                });
            }
        } finally {
            await fs.remove(tmpDir).catch(() => {});
        }

        if (waypoints.length === 0) {
            throw new MissingInputError('vfx_video_auto_reframe', 'a video with a visible person',
                `MediaPipe found no person in any of the ${undetectedSamples.length} sampled frame(s) of ${options.inputVideoPath}, so there is no subject to frame on (focusMode 'center' crops the middle without tracking)`);
        }

        // One static crop at the mean of the tracked positions (the video is not panned).
        const avgX = Math.round(waypoints.reduce((acc, w) => acc + w.cropX, 0) / Math.max(1, waypoints.length));
        const avgY = Math.round(waypoints.reduce((acc, w) => acc + w.cropY, 0) / Math.max(1, waypoints.length));

        // Clamped crop filter
        const finalCropX = Math.max(0, Math.min(maxCropX, avgX));
        const finalCropY = Math.max(0, Math.min(maxCropY, avgY));
        const filtergraph = `crop=${cropW}:${cropH}:${finalCropX}:${finalCropY}`;

        const outPath = options.outputVideoPath ?? options.inputVideoPath.replace(/\.([a-z0-9]+)$/i, `_reframe_${options.targetAspectRatio.replace(':', 'x')}.$1`);

        const editRes = await this.editorService.quickEdit({
            inputPath: options.inputVideoPath,
            outputPath: outPath,
            crop: {
                box: {
                    x: finalCropX,
                    y: finalCropY,
                    width: cropW,
                    height: cropH
                }
            }
        });

        return {
            success: editRes.success,
            inputVideoPath: options.inputVideoPath,
            outputVideoPath: outPath,
            targetAspectRatio: options.targetAspectRatio,
            inputDimensions: inputDims,
            cropDimensions: { width: cropW, height: cropH },
            waypoints,
            undetectedSamples,
            filtergraph,
            ffmpegCommand: editRes.ffmpegCommand
        };
    }

    // ── Pipeline 3: Multimodal Visual Critic Quality Audit ──────────────────

    /**
     * Audits a video against the 8-Dimension Visual Fidelity Rubric. FFmpeg makes a 3x3 contact sheet across the clip,
     * MediaPipe measures how steady the limbs of a person in it stay, and a vision model scores each dimension from the
     * sheet (with the measured body consistency and the caller's context as evidence). Every score is the model's;
     * none is assumed. The audit fails, with the reason, when the sheet cannot be made, the motion tracking cannot run,
     * or the vision model cannot score the sheet: it never passes a step it could not do.
     */
    public async auditVideoFidelity(options: VisualCriticAuditOptions): Promise<VisualCriticAuditResult> {
        const tool = 'vfx_visual_critic_audit';
        const minPassing = options.minPassingScore ?? 8.5;
        if (!Number.isFinite(minPassing) || minPassing < 0 || minPassing > 10) {
            throw new MissingInputError(tool, 'minPassingScore', `${options.minPassingScore} is not a score between 0 and 10`);
        }
        if (!await fs.pathExists(options.videoPath)) {
            throw new MissingInputError(tool, 'videoPath', `${options.videoPath} does not exist`);
        }
        if (options.referencePlatePath && !await fs.pathExists(options.referencePlatePath)) {
            throw new MissingInputError(tool, 'referencePlatePath', `${options.referencePlatePath} does not exist`);
        }

        // 1. The 3x3 contact sheet the vision model scores. Without it there is nothing to look at: the audit fails.
        const sheetPath = options.videoPath.replace(/\.([a-z0-9]+)$/i, `_audit_sheet_${Date.now()}.jpg`);
        try {
            await this.editorService.generateStoryboardSheet({
                inputPath: options.videoPath,
                outputPath: sheetPath,
                columns: 3,
                rows: 3,
                labelTimecode: true
            });
        } catch (err: any) {
            throw new GeneratorFailedError('ffmpeg', `the visual critic could not make the contact sheet of ${options.videoPath}: ${err?.stderr || err?.message || String(err)}`);
        }
        const sheetStat = await fs.stat(sheetPath).catch(() => null);
        if (!sheetStat || sheetStat.size === 0) {
            throw new GeneratorFailedError('ffmpeg', `the visual critic's contact sheet of ${options.videoPath} was not written (${sheetPath} is ${sheetStat ? 'empty' : 'missing'})`);
        }

        // 2. Body consistency, measured. Tracking that cannot run fails the audit; a video with nobody in it has no
        //    limbs to measure, which the result says rather than scoring them.
        let track: VideoMotionTrackResult;
        try {
            track = await this.trackVideoMotion({ videoPath: options.videoPath, fps: 8, smoothingWindow: 1 });
        } catch (err: any) {
            throw new GeneratorFailedError('mediapipe', `the visual critic could not track motion in ${options.videoPath}: ${err?.message || String(err)}`);
        }
        const framesWithPerson = track.frames.length;
        const framesSampled = framesWithPerson + (track.undetectedFrames?.length ?? 0);
        if (framesSampled === 0) {
            throw new GeneratorFailedError('mediapipe', `the visual critic could not track motion in ${options.videoPath}: ${track.error || 'no frames were sampled'}`);
        }
        const anatomicalConsistency: AnatomicalConsistencyAudit = { framesSampled, framesWithPerson, ...this.measureLimbLengthStability(track.frames) };

        // 3. The vision model scores the eight dimensions from the sheet.
        const sheet = await fs.readFile(sheetPath);
        const reference = options.referencePlatePath ? await fs.readFile(options.referencePlatePath) : undefined;
        const scored = await this.scoreRubric(sheet, reference, options, anatomicalConsistency, minPassing);

        const dimensionAudits = Object.fromEntries(Object.keys(VISUAL_CRITIC_DIMENSIONS).map(key => {
            const d = scored.dimensions[key as VisualCriticDimension];
            return [key, { score: d.score, passed: d.score >= minPassing, notes: d.notes }];
        })) as Record<VisualCriticDimension, VisualCriticDimensionAudit>;
        const scores = Object.values(dimensionAudits).map(d => d.score);
        const overall = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
        const failedDimensions = (Object.keys(dimensionAudits) as VisualCriticDimension[]).filter(k => !dimensionAudits[k].passed);
        const passed = failedDimensions.length === 0;

        return {
            success: true,
            videoPath: options.videoPath,
            overallScore: overall,
            passed,
            minPassingScore: minPassing,
            failedDimensions,
            storyboardSheetPath: sheetPath,
            visionModel: VISUAL_CRITIC_MODEL,
            anatomicalConsistency,
            dimensionAudits,
            remediationRecipe: passed ? undefined : {
                actionDirectives: scored.actionDirectives,
                suggestedFfmpegFilters: scored.suggestedFfmpegFilters
            }
        };
    }

    /** Limb-length steadiness over the frames that have 3D landmarks, or why it cannot be measured. */
    private measureLimbLengthStability(frames: VideoMotionPoseFrame[]): Pick<AnatomicalConsistencyAudit, 'limbLengthStabilityRatio' | 'notMeasuredReason'> {
        const withLandmarks = frames.filter(f => f.worldLandmarks && f.worldLandmarks.length >= 33);
        if (withLandmarks.length < 2) {
            return {
                notMeasuredReason: frames.length === 0
                    ? 'MediaPipe found no person in any sampled frame, so there are no limbs to measure'
                    : `only ${withLandmarks.length} sampled frame(s) had 3D body landmarks; limb lengths need at least two`
            };
        }
        // Shoulder-elbow-wrist and hip-knee-ankle on each side (MediaPipe pose landmark indices).
        const limbs: Array<[number, number, number]> = [[11, 13, 15], [12, 14, 16], [23, 25, 27], [24, 26, 28]];
        const variations = limbs.map(([a, b, c]) => {
            const lengths = withLandmarks.map(f => {
                const lms = f.worldLandmarks!;
                return this.dist3D(lms[a], lms[b]) + this.dist3D(lms[b], lms[c]);
            });
            const mean = lengths.reduce((s, v) => s + v, 0) / lengths.length;
            const std = Math.sqrt(lengths.reduce((s, v) => s + (v - mean) ** 2, 0) / lengths.length);
            return mean > 0 ? std / mean : 1;
        });
        const meanVariation = variations.reduce((s, v) => s + v, 0) / variations.length;
        return { limbLengthStabilityRatio: Math.round(Math.max(0, Math.min(1, 1 - meanVariation)) * 1000) / 1000 };
    }

    private async getVisionClient(): Promise<any> {
        if (this.visionClient) return this.visionClient;
        try {
            const { GeminiClient } = await import('../gemini/gemini-client');
            this.visionClient = await new GeminiClient().getGenAIClient();
        } catch (err: any) {
            throw new VisionUnavailableError(VISUAL_CRITIC_MODEL, 'no-credentials', err?.message || String(err));
        }
        if (!this.visionClient?.models?.generateContent) {
            throw new VisionUnavailableError(VISUAL_CRITIC_MODEL, 'no-credentials', 'no Gemini client is configured');
        }
        return this.visionClient;
    }

    /** Has the vision model score every rubric dimension from the sheet; an incomplete or failed answer throws. */
    private async scoreRubric(
        sheet: Buffer,
        reference: Buffer | undefined,
        options: VisualCriticAuditOptions,
        anatomy: AnatomicalConsistencyAudit,
        minPassing: number
    ): Promise<{ dimensions: Record<VisualCriticDimension, { score: number; notes: string }>; actionDirectives: string[]; suggestedFfmpegFilters: string[] }> {
        const model = VISUAL_CRITIC_MODEL;
        const client = await this.getVisionClient();
        const anatomyLine = anatomy.limbLengthStabilityRatio !== undefined
            ? `Measured with MediaPipe on ${anatomy.framesSampled} sampled frames (a person in ${anatomy.framesWithPerson}): limb-length stability ${anatomy.limbLengthStabilityRatio} (1 = limbs keep their length).`
            : `Body consistency was not measured: ${anatomy.notMeasuredReason} (${anatomy.framesSampled} frames sampled).`;
        const contents: any[] = [
            { inlineData: { mimeType: 'image/jpeg', data: sheet.toString('base64') } },
            ...(reference ? [{ inlineData: { mimeType: this.imageMimeType(reference), data: reference.toString('base64') } }] : []),
            [
                'The first image is a 3x3 contact sheet of nine frames sampled evenly across a video, each labelled with its timecode.',
                reference ? 'The second image is the original reference plate the video was made from.' : '',
                options.promptContext ? `The shot is meant to be: ${options.promptContext}` : '',
                anatomyLine,
                `Score each dimension from 0 to 10 from what these frames actually show (${minPassing} is the passing score), and say what you saw:`,
                ...Object.entries(VISUAL_CRITIC_DIMENSIONS).map(([key, text]) => `- ${key}: ${text}`),
                `Then list concrete fixes for every dimension below ${minPassing}, and any FFmpeg -vf filters that would help.`
            ].filter(Boolean).join('\n')
        ];

        let text: string;
        try {
            const response = await client.models.generateContent({
                model,
                contents,
                config: {
                    systemInstruction: 'You are a strict VFX supervisor auditing frames for photographic and geometric fidelity. Score only what is visible; do not assume quality you cannot see.',
                    responseMimeType: 'application/json',
                    responseSchema: visualCriticSchema,
                    temperature: 0.1
                }
            });
            text = response?.text || '';
        } catch (err: any) {
            throw new VisionUnavailableError(model, err?.status || err?.code || 'request-failed', err?.message || String(err));
        }
        let parsed: any;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new VisionUnavailableError(model, 'invalid-response', `the answer is not JSON: ${text.slice(0, 200) || '(empty)'}`);
        }
        const missing = Object.keys(VISUAL_CRITIC_DIMENSIONS).filter(key => {
            const d = parsed?.dimensions?.[key];
            return !d || typeof d.score !== 'number' || !Number.isFinite(d.score) || d.score < 0 || d.score > 10 || typeof d.notes !== 'string' || !d.notes.trim();
        });
        if (missing.length) {
            throw new VisionUnavailableError(model, 'invalid-response', `the answer has no valid 0..10 score and notes for ${missing.join(', ')}`);
        }
        const strings = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
        return {
            dimensions: parsed.dimensions,
            actionDirectives: strings(parsed.actionDirectives),
            suggestedFfmpegFilters: strings(parsed.suggestedFfmpegFilters)
        };
    }

    private imageMimeType(bytes: Buffer): string {
        if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
        if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
        if (bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
        throw new MissingInputError('vfx_visual_critic_audit', 'referencePlatePath', 'the reference plate is not a PNG, JPEG or WebP image');
    }

    private dist3D(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dz = a.z - b.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
}
