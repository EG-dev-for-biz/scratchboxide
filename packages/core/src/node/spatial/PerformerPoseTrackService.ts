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
import { execFileBuffer } from '../process/exec-file-async';
import { resolveRepoPython } from '../process/repo-python';

/** [x, y, z, visibility]; image landmarks are normalized, world landmarks are metric hip-centred Y-down. */
export type PoseLandmarkTuple = [number, number, number, number];

export interface PerformerPoseTrackFrame {
    frame_index: number;
    timestamp: number;
    image: PoseLandmarkTuple[] | null;
    world: PoseLandmarkTuple[] | null;
}

export interface PerformerPoseTrack {
    source: string;
    width: number;
    height: number;
    fps: number;
    model: string;
    /** First-frame person segmentation PNG (0..255), when requested. */
    hero_mask?: string | null;
    frames: PerformerPoseTrackFrame[];
}

export interface TrackVideoOptions {
    outputPath?: string;
    fps?: number;
    maxSeconds?: number;
    maxWidth?: number;
    maskOutputPath?: string;
    pythonBinary?: string;
    /** Aborting it kills the tracking child process. */
    signal?: AbortSignal;
}

function findRepoFile(relative: string): string | null {
    for (const start of [process.cwd(), __dirname]) {
        let cur = start;
        while (cur !== path.dirname(cur)) {
            const candidate = path.join(cur, relative);
            if (fs.existsSync(candidate)) return candidate;
            cur = path.dirname(cur);
        }
    }
    return null;
}

/**
 * Runs MediaPipe PoseLandmarker (scripts/track_performer_pose.py) over a performer video and
 * returns per-frame 33-landmark image + world poses used to drive performer avatar motion.
 */
export class PerformerPoseTrackService {
    public static resolvePythonBinary(explicit?: string): string {
        const candidates = [
            explicit,
            process.env.SCRATCHBOX_POSE_PYTHON,
            path.join(os.homedir(), '.cache/scratchbox/pose-venv/bin/python')
        ];
        for (const c of candidates) {
            if (c && (c.includes(path.sep) ? fs.existsSync(c) : true)) return c;
        }
        return resolveRepoPython({ modules: ['numpy', 'cv2', 'mediapipe'], purpose: 'MediaPipe performer pose tracking' });
    }

    public static countTrackedFrames(track: PerformerPoseTrack): number {
        return track.frames.filter(f => Array.isArray(f.world) && f.world.length >= 33).length;
    }

    public loadTrack(trackPath: string): PerformerPoseTrack {
        const track = JSON.parse(fs.readFileSync(trackPath, 'utf-8')) as PerformerPoseTrack;
        if (!Array.isArray(track.frames)) {
            throw new Error(`Pose track ${trackPath} has no frames array`);
        }
        return track;
    }

    public async trackVideo(inputPath: string, options: TrackVideoOptions = {}): Promise<PerformerPoseTrack> {
        if (!fs.existsSync(inputPath)) {
            throw new Error(`Pose tracking input not found: ${inputPath}`);
        }
        const script = findRepoFile('scripts/track_performer_pose.py');
        if (!script) {
            throw new Error('scripts/track_performer_pose.py not found; cannot track performer motion');
        }
        const outputPath = options.outputPath || path.join(os.tmpdir(), `pose_track_${Date.now()}.json`);
        const python = PerformerPoseTrackService.resolvePythonBinary(options.pythonBinary);
        const args = [script, '--input', inputPath, '--output', outputPath, '--max-width', String(options.maxWidth ?? 720)];
        if (options.fps) args.push('--fps', String(options.fps));
        if (options.maxSeconds) args.push('--max-seconds', String(options.maxSeconds));
        if (options.maskOutputPath) args.push('--mask-output', options.maskOutputPath);

        try {
            await execFileBuffer(python, args, { maxBuffer: 64 * 1024 * 1024, timeoutMs: 15 * 60 * 1000, signal: options.signal });
        } catch (err: any) {
            if (options.signal?.aborted) throw err;
            const stderr = String(err?.stderr || '').split('\n').filter(l => l && !/^[IW]0000/.test(l)).slice(-6).join('\n');
            throw new Error(
                `MediaPipe pose tracking failed (${python}). Install with ` +
                '`python3.11 -m venv ~/.cache/scratchbox/pose-venv && ~/.cache/scratchbox/pose-venv/bin/pip install mediapipe==0.10.14 opencv-python-headless` ' +
                `or set SCRATCHBOX_POSE_PYTHON. ${stderr}`
            );
        }
        return this.loadTrack(outputPath);
    }
}
