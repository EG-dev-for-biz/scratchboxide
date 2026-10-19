/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getPythonWorkerPool, PythonWorkerError } from '../process/persistent-python-worker';
import { GeneratorFailedError } from '../../common/errors/pipeline-errors';
import { resolveRepoPython } from '../process/repo-python';
import type {
    IPointTracker
} from '../../common/tracking/PointTrackingModel';
import {
    LucasKanadeFlowTracker,
    PointSamplers,
    SyntheticTracker
} from '../../common/tracking/PointTrackingModel';
import type {
    NormalizedPoint2D,
    PointTracks,
    SamplingConfig,
    TrackingConfig,
    VideoFrameData
} from '../../common/tracking/tapir-tracking-protocol';

export interface TapirTrackingServiceOptions {
    pythonBinary?: string;
    scriptPath?: string;
    checkpointPath?: string;
    timeoutMs?: number;
}

export interface TrackingExecutionResult {
    tracks: PointTracks;
    backendUsed: 'tapir' | 'lk_flow' | 'mock';
    durationMs: number;
    numFrames: number;
    numPoints: number;
}

/**
 * Service for tracking 2D points and feature trajectories across video sequences.
 * The backend is the caller's choice and is reported in backendUsed: 'tapir' (Google DeepMind TAPIR through the
 * Python bridge, the default), 'lk_flow' (native pyramidal Lucas-Kanade optical flow) or 'mock' (tests only).
 * When TAPIR cannot run, the call fails with the reason; it never switches to optical flow on its own.
 */
export class TapirTrackingService implements IPointTracker {
    private readonly pythonOverride?: string;
    private scriptPath: string;
    private checkpointPath?: string;
    private timeoutMs: number;
    private lkTracker: LucasKanadeFlowTracker;
    private syntheticTracker: SyntheticTracker;

    constructor(options?: TapirTrackingServiceOptions) {
        this.pythonOverride = options?.pythonBinary;
        this.scriptPath = options?.scriptPath ?? path.resolve(process.cwd(), 'scripts/run_tapir.py');
        this.checkpointPath = options?.checkpointPath;
        this.timeoutMs = options?.timeoutMs ?? 30_000;
        this.lkTracker = new LucasKanadeFlowTracker();
        this.syntheticTracker = new SyntheticTracker();
    }

    /** The interpreter (the caller's, else the project's, checked at first use: PythonEnvironmentError). */
    private get pythonBinary(): string {
        return this.pythonOverride ?? resolveRepoPython({ modules: ['numpy', 'cv2'], purpose: 'TAPIR point tracking (scripts/run_tapir.py)' });
    }

    /**
     * Executes point tracking on video frames.
     */
    public async trackPoints(
        frames: VideoFrameData[],
        queryPoints: NormalizedPoint2D[],
        queryFrames?: number[],
        config?: TrackingConfig
    ): Promise<PointTracks> {
        const result = await this.executeTracking(frames, queryPoints, queryFrames, config);
        return result.tracks;
    }

    /**
     * Complete tracking execution with backend telemetry.
     */
    public async executeTracking(
        frames: VideoFrameData[],
        queryPoints: NormalizedPoint2D[],
        queryFrames?: number[],
        config?: TrackingConfig
    ): Promise<TrackingExecutionResult> {
        const start = Date.now();
        const backend = config?.backend ?? 'tapir';

        if (backend === 'mock') {
            const tracks = this.syntheticTracker.trackPoints(frames, queryPoints, queryFrames);
            return {
                tracks,
                backendUsed: 'mock',
                durationMs: Date.now() - start,
                numFrames: frames.length,
                numPoints: queryPoints.length
            };
        }

        if (backend === 'lk_flow') {
            const tracker = config ? new LucasKanadeFlowTracker(config) : this.lkTracker;
            const tracks = tracker.trackPoints(frames, queryPoints, queryFrames);
            return {
                tracks,
                backendUsed: 'lk_flow',
                durationMs: Date.now() - start,
                numFrames: frames.length,
                numPoints: queryPoints.length
            };
        }

        if (backend !== 'tapir') {
            throw new GeneratorFailedError('tracking', `unknown tracker backend "${backend}" (tapir, lk_flow or mock)`);
        }
        // DeepMind TAPIR through the Python bridge: the frames go with the request. Any failure is reported as such.
        if (!fs.existsSync(this.scriptPath)) {
            throw new GeneratorFailedError('tapir', `the TAPIR bridge script ${this.scriptPath} does not exist; choose backend 'lk_flow' explicitly for optical flow`);
        }
        let tapirOutput: any;
        try {
            tapirOutput = await this.runPythonTapir({
                frames,
                queryPoints,
                queryFrames,
                checkpointPath: config?.checkpointPath ?? this.checkpointPath,
                useCausal: config?.useCausal ?? true
            });
        } catch (err: any) {
            throw new GeneratorFailedError('tapir', `TAPIR tracking failed: ${err?.message || err}`);
        }
        if (!tapirOutput?.success || !Array.isArray(tapirOutput.coords) || tapirOutput.coords.length !== frames.length) {
            throw new GeneratorFailedError('tapir', `TAPIR returned no tracks for the ${frames.length} frames: ${tapirOutput?.error || tapirOutput?.reason || JSON.stringify(tapirOutput).slice(0, 300)}`);
        }
        return {
            tracks: {
                coords: tapirOutput.coords,
                visibilities: tapirOutput.visibilities ?? [],
                queryPoints,
                queryFrames
            },
            backendUsed: 'tapir',
            durationMs: Date.now() - start,
            numFrames: frames.length,
            numPoints: queryPoints.length
        };
    }

    /**
     * Seeds tracking points using the specified sampler on the hero frame and tracks across all frames.
     */
    public async sampleAndTrack(
        frames: VideoFrameData[],
        sampleConfig: SamplingConfig,
        trackingConfig?: TrackingConfig,
        heroFrameIndex: number = 0
    ): Promise<TrackingExecutionResult> {
        if (frames.length === 0) {
            throw new Error('No video frames provided for sampleAndTrack.');
        }

        const heroFrame = frames[Math.max(0, Math.min(heroFrameIndex, frames.length - 1))];
        let queryPoints: NormalizedPoint2D[];

        switch (sampleConfig.type) {
            case 'grid':
                queryPoints = PointSamplers.sampleGrid(heroFrame.width, heroFrame.height, {
                    stride: sampleConfig.stride,
                    margin: sampleConfig.margin,
                    maxPoints: sampleConfig.maxPoints
                });
                break;
            case 'saliency':
                queryPoints = PointSamplers.sampleSaliency(heroFrame, {
                    qualityLevel: sampleConfig.qualityLevel,
                    minDistance: sampleConfig.minDistance,
                    maxPoints: sampleConfig.maxPoints
                });
                break;
            case 'hybrid':
            default:
                queryPoints = PointSamplers.sampleHybrid(heroFrame, {
                    cellSize: sampleConfig.cellSize,
                    qualityLevel: sampleConfig.qualityLevel,
                    maxPoints: sampleConfig.maxPoints
                });
                break;
        }

        const queryFrames = new Array(queryPoints.length).fill(heroFrameIndex);
        return this.executeTracking(frames, queryPoints, queryFrames, trackingConfig);
    }

    /**
     * Runs the Python TAPIR bridge. The frames are written to a raw RGB file (T x H x W x 3, uint8) whose path and
     * shape go in the JSON request on stdin; the bridge answers with JSON on stdout and exits non-zero on failure.
     */
    private async runPythonTapir(input: {
        frames: VideoFrameData[];
        queryPoints: NormalizedPoint2D[];
        queryFrames?: number[];
        checkpointPath?: string;
        useCausal?: boolean;
    }): Promise<any> {
        if (input.frames.length === 0) {
            throw new Error('no video frames to track');
        }
        const { width, height } = input.frames[0];
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-tapir-'));
        const framesPath = path.join(dir, 'frames.rgb');
        try {
            const fd = fs.openSync(framesPath, 'w');
            try {
                for (const frame of input.frames) {
                    if (frame.width !== width || frame.height !== height) {
                        throw new Error(`frame ${frame.frameIndex} is ${frame.width}x${frame.height}, the first frame ${width}x${height}`);
                    }
                    const channels = frame.channels ?? 3;
                    let rgb: Uint8Array = frame.data;
                    if (channels !== 3) {
                        rgb = new Uint8Array(width * height * 3);
                        for (let i = 0; i < width * height; i++) {
                            rgb[i * 3] = frame.data[i * channels];
                            rgb[i * 3 + 1] = frame.data[i * channels + 1];
                            rgb[i * 3 + 2] = frame.data[i * channels + 2];
                        }
                    }
                    fs.writeSync(fd, rgb, 0, width * height * 3);
                }
            } finally {
                fs.closeSync(fd);
            }
            return await this.spawnBridge(JSON.stringify({
                framesPath,
                numFrames: input.frames.length,
                width,
                height,
                queryPoints: input.queryPoints,
                queryFrames: input.queryFrames,
                checkpointPath: input.checkpointPath,
                useCausal: input.useCausal
            }));
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    /**
     * Sends one request to the TAPIR bridge running in a persistent worker (the checkpoint stays loaded between
     * calls). The request JSON is the script's stdin; frames travel in the raw file named in it.
     */
    private async spawnBridge(payload: string): Promise<any> {
        const pool = getPythonWorkerPool({ pythonBinary: this.pythonBinary, scriptPath: this.scriptPath, label: 'the TAPIR bridge' });
        let res;
        try {
            res = await pool.run({ stdin: payload, timeoutMs: this.timeoutMs });
        } catch (err: any) {
            if (err instanceof PythonWorkerError && err.kind === 'timeout') {
                throw new Error(`TAPIR python process timed out after ${this.timeoutMs}ms`);
            }
            throw err;
        }
        const { exitCode: code, stdout, stderr } = res;
        let parsed: any;
        try {
            parsed = JSON.parse(stdout.trim());
        } catch {
            parsed = undefined;
        }
        if (code !== 0) {
            throw new Error(`TAPIR process exited with code ${code}: ${parsed?.error || stderr.trim() || stdout.trim().slice(0, 300)}`);
        }
        if (parsed === undefined) {
            throw new Error(`Failed to parse TAPIR stdout JSON: ${stdout.slice(0, 200)}...`);
        }
        return parsed;
    }
}
