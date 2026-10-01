/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
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
 * Employs Google DeepMind TAPIR with automatic two-tier failover to native pyramidal Lucas-Kanade optical flow.
 */
export class TapirTrackingService implements IPointTracker {
    private pythonBinary: string;
    private scriptPath: string;
    private checkpointPath?: string;
    private timeoutMs: number;
    private lkTracker: LucasKanadeFlowTracker;
    private syntheticTracker: SyntheticTracker;

    constructor(options?: TapirTrackingServiceOptions) {
        this.pythonBinary = options?.pythonBinary ?? process.env.PYTHON_BIN ?? 'python3';
        this.scriptPath = options?.scriptPath ?? path.resolve(process.cwd(), 'scripts/run_tapir.py');
        this.checkpointPath = options?.checkpointPath;
        this.timeoutMs = options?.timeoutMs ?? 30_000;
        this.lkTracker = new LucasKanadeFlowTracker();
        this.syntheticTracker = new SyntheticTracker();
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

        // Try Python DeepMind TAPIR first
        try {
            if (fs.existsSync(this.scriptPath)) {
                const tapirOutput = await this.runPythonTapir({
                    frames,
                    queryPoints,
                    queryFrames,
                    checkpointPath: config?.checkpointPath ?? this.checkpointPath,
                    useCausal: config?.useCausal ?? true
                });

                if (tapirOutput && tapirOutput.success && tapirOutput.coords) {
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
            }
        } catch {
            // Python execution failed or TAPIR not installed; fall through to native Lucas-Kanade
        }

        // Automatic transparent failover to native optical flow
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
     * Internal helper to run the Python TAPIR bridge script.
     */
    private runPythonTapir(input: {
        frames: VideoFrameData[];
        queryPoints: NormalizedPoint2D[];
        queryFrames?: number[];
        checkpointPath?: string;
        useCausal?: boolean;
    }): Promise<any> {
        return new Promise((resolve, reject) => {
            const child = spawn(this.pythonBinary, [this.scriptPath], {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            let stdout = '';
            let stderr = '';
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                child.kill('SIGKILL');
                reject(new Error(`TAPIR python process timed out after ${this.timeoutMs}ms`));
            }, this.timeoutMs);

            child.stdout.on('data', (data) => {
                stdout += data.toString('utf-8');
            });

            child.stderr.on('data', (data) => {
                stderr += data.toString('utf-8');
            });

            child.on('close', (code) => {
                clearTimeout(timer);
                if (timedOut) return;

                if (code !== 0) {
                    reject(new Error(`TAPIR process exited with code ${code}: ${stderr}`));
                    return;
                }

                try {
                    const parsed = JSON.parse(stdout.trim());
                    resolve(parsed);
                } catch (e) {
                    reject(new Error(`Failed to parse TAPIR stdout JSON: ${stdout.slice(0, 200)}...`));
                }
            });

            child.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });

            // Write input payload: we pass query points and config (video loading handled via path or fallback)
            const payload = JSON.stringify({
                queryPoints: input.queryPoints,
                queryFrames: input.queryFrames,
                checkpointPath: input.checkpointPath,
                useCausal: input.useCausal
            });

            child.stdin.write(payload);
            child.stdin.end();
        });
    }
}
