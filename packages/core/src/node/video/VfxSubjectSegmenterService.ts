/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs-extra';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { resolveBinary } from './HeadlessVideoEditorService';
import { GeneratorFailedError, MissingInputError } from '../../common/errors/pipeline-errors';
import { getPythonWorkerPool, mapWithConcurrency, PythonWorkerError } from '../process/persistent-python-worker';

const execFileAsync = promisify(execFile);
const TOOL = 'vfx_segment_subject';

// ============================================================================
// Types
// ============================================================================

export interface SegmentSubjectOptions {
    /** Absolute path to the source video file. */
    videoPath: string;
    /** Directory where mask PNGs will be written. Created if absent. */
    outputDir: string;
    /** Frame sampling rate (default 5 fps). Lower = faster, fewer masks. */
    fps?: number;
    /** When true, plans execution without spawning processes. */
    dryRun?: boolean;
    /** Override path to segment_subject.py script. */
    scriptPath?: string;
    /** Override Python binary name/path. */
    pythonBinary?: string;
}

export interface SegmentSubjectResult {
    success: true;
    videoPath: string;
    outputDir: string;
    /** Frames sampled from the video; every one has a mask (a frame that cannot be segmented fails the call). */
    totalFrames: number;
    sampleFps: number;
    width: number;
    height: number;
    /** Absolute paths to mask PNGs, in frame order without gaps: mask_0000.png, mask_0001.png, … */
    maskPaths: string[];
    /**
     * Relative pattern usable with FFmpeg image2 demuxer:
     *   ffmpeg -framerate <fps> -i <outputDir>/mask_%04d.png …
     */
    ffmpegPattern: string;
    /** The video's length as ffprobe measured it (absent when ffprobe reports none; a dry run then fails). */
    durationSec?: number;
    /** The segmentation models that made the masks (empty for a dry run). */
    models: string[];
    /** Why a model other than the segmenter's first choice made masks, one line per distinct reason. */
    modelNotes: string[];
    dryRun?: boolean;
    [key: string]: unknown;
}

type FrameOutcome = { ok: true; model?: string; modelNote?: string } | { ok: false; error: string };

// ============================================================================
// Service
// ============================================================================

export class VfxSubjectSegmenterService {
    private pythonBinary: string;
    private scriptPath: string;
    private maxWorkers: number;
    private frameTimeoutMs: number;

    /**
     * @param options.maxWorkers frames segmented at once, each worker keeping the model loaded (default: half the
     *   CPU cores, 1..4).
     * @param options.frameTimeoutMs time limit for one frame (default 120 s; the first frame includes the model load).
     */
    constructor(options?: { pythonBinary?: string; scriptPath?: string; maxWorkers?: number; frameTimeoutMs?: number }) {
        this.pythonBinary = options?.pythonBinary ?? process.env.PYTHON_BIN ?? 'python3';
        this.scriptPath = options?.scriptPath
            ?? path.resolve(process.cwd(), 'scripts/segment_subject.py');
        this.maxWorkers = Math.max(1, Math.floor(options?.maxWorkers ?? Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2)))));
        this.frameTimeoutMs = options?.frameTimeoutMs ?? 120_000;
    }

    /**
     * Writes one binary mask per sampled frame, or throws: a missing video is a MissingInputError, and a failed probe,
     * frame extraction or segmentation of any frame is a GeneratorFailedError naming the step (and the frame). A failed
     * run removes the masks it wrote, so no partial sequence with gaps is left for an alphamerge to pick up.
     */
    async segmentSubject(options: SegmentSubjectOptions): Promise<SegmentSubjectResult> {
        const {
            videoPath,
            outputDir,
            fps = 5,
            dryRun = false,
        } = options;

        if (!fs.existsSync(videoPath)) {
            throw new MissingInputError(TOOL, 'videoPath', `${videoPath} does not exist`);
        }
        if (!fs.existsSync(this.scriptPath)) {
            throw new GeneratorFailedError('python', `${TOOL}: the segmentation script ${this.scriptPath} does not exist`);
        }

        const { width, height, duration: durationSec } = await this.probeVideo(videoPath);

        const safeFps = Math.max(1, Math.min(fps, 30));
        const ffmpegPattern = path.join(outputDir, 'mask_%04d.png');

        if (dryRun) {
            if (durationSec === undefined) {
                throw new GeneratorFailedError('ffprobe', `${TOOL}: ffprobe could not measure the length of ${videoPath}, so a dry run cannot say how many frames it would segment`);
            }
            return {
                success: true,
                videoPath,
                outputDir,
                totalFrames: Math.max(1, Math.ceil(durationSec * safeFps)),
                sampleFps: safeFps,
                width,
                height,
                maskPaths: [],
                ffmpegPattern,
                durationSec,
                models: [],
                modelNotes: [],
                dryRun: true
            };
        }

        await fs.ensureDir(outputDir);
        const rawFrameDir = path.join(outputDir, '.raw_frames');
        const maskPaths: string[] = [];
        const models = new Set<string>();
        const modelNotes = new Set<string>();
        let complete = false;
        try {
            // Step 1: Extract frames from video using FFmpeg.
            await fs.emptyDir(rawFrameDir);
            await this.extractFrames(videoPath, path.join(rawFrameDir, 'frame_%04d.png'), safeFps);
            const rawFrames = (await fs.readdir(rawFrameDir)).filter(f => f.endsWith('.png')).sort();
            if (rawFrames.length === 0) {
                throw new GeneratorFailedError('ffmpeg', `${TOOL}: FFmpeg extracted no frames from ${videoPath} at ${safeFps} fps`);
            }

            // Step 2: Segment every frame; the first frame that cannot be segmented fails the call.
            // Frames are segmented in parallel on persistent workers (the model loads once per worker); the outcomes
            // are checked in frame order, so the failure reported is the earliest frame's.
            const framePaths = rawFrames.map((_, i) => path.join(outputDir, `mask_${String(i).padStart(4, '0')}.png`));
            let anyFailed = false;
            const outcomes = await mapWithConcurrency(rawFrames, this.maxWorkers, async (name, i): Promise<FrameOutcome> => {
                if (anyFailed) return { ok: false, error: 'not run: an earlier frame failed' };
                const outcome = await this.runSegmenterOnFrame(path.join(rawFrameDir, name), framePaths[i]);
                if (!outcome.ok) anyFailed = true;
                return outcome;
            });
            for (let i = 0; i < rawFrames.length; i++) {
                const maskPath = framePaths[i];
                const outcome = outcomes[i];
                if (!outcome.ok) {
                    await Promise.all(framePaths.slice(i).map(p => fs.remove(p)));
                    await fs.remove(maskPath);
                    throw new GeneratorFailedError('python', `${TOOL}: frame ${i + 1} of ${rawFrames.length} (${(i / safeFps).toFixed(2)} s into ${path.basename(videoPath)}) could not be segmented, so no matte sequence was written: ${outcome.error}`);
                }
                maskPaths.push(maskPath);
                if (outcome.model) models.add(outcome.model);
                if (outcome.modelNote) modelNotes.add(outcome.modelNote);
            }
            complete = true;
        } finally {
            await fs.remove(rawFrameDir);
            if (!complete) await Promise.all(maskPaths.map(p => fs.remove(p)));
        }

        return {
            success: true,
            videoPath,
            outputDir,
            totalFrames: maskPaths.length,
            sampleFps: safeFps,
            width,
            height,
            maskPaths,
            ffmpegPattern,
            durationSec,
            models: Array.from(models),
            modelNotes: Array.from(modelNotes)
        };
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    /** Dimensions (throws when there are none) and length (the stream's duration, else the container's, else undefined). */
    private async probeVideo(
        videoPath: string
    ): Promise<{ width: number; height: number; duration?: number }> {
        let stdout: string;
        try {
            ({ stdout } = await execFileAsync(resolveBinary('ffprobe'), [
                '-v', 'error', '-select_streams', 'v:0',
                '-show_entries', 'stream=width,height,duration:format=duration',
                '-of', 'json', videoPath
            ], { timeout: 10_000 }));
        } catch (err: any) {
            throw new GeneratorFailedError('ffprobe', `${TOOL} could not probe ${videoPath}: ${err?.stderr || err?.message || String(err)}`);
        }
        let parsed: any;
        try {
            parsed = JSON.parse(stdout);
        } catch {
            throw new GeneratorFailedError('ffprobe', `${TOOL} could not read ffprobe's answer for ${videoPath}: ${stdout.trim().slice(0, 200)}`);
        }
        const stream = parsed?.streams?.[0] ?? {};
        const width = Number(stream.width);
        const height = Number(stream.height);
        const duration = Number(stream.duration ?? parsed?.format?.duration);
        if (!(width > 0 && height > 0)) {
            throw new GeneratorFailedError('ffprobe', `${TOOL}: ffprobe found no video stream with dimensions in ${videoPath}`);
        }
        return { width, height, duration: Number.isFinite(duration) && duration > 0 ? duration : undefined };
    }

    private extractFrames(
        videoPath: string,
        outputPattern: string,
        fps: number
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            const args = [
                '-y',
                '-i', videoPath,
                '-vf', `fps=${fps}`,
                '-q:v', '2',
                outputPattern
            ];
            const child = spawn(resolveBinary('ffmpeg'), args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
            child.on('close', code => {
                if (code !== 0) {
                    reject(new GeneratorFailedError('ffmpeg', `${TOOL}: frame extraction from ${videoPath} exited ${code}: ${stderr.slice(-400)}`));
                } else {
                    resolve();
                }
            });
            child.on('error', err => reject(new GeneratorFailedError('ffmpeg', `${TOOL}: FFmpeg could not be started: ${err.message}`)));
        });
    }

    /** Runs the segmentation script on one frame; the outcome carries the script's error, or the model that made the mask. */
    private async runSegmenterOnFrame(inputPath: string, outputPath: string): Promise<FrameOutcome> {
        const pool = getPythonWorkerPool({
            pythonBinary: this.pythonBinary,
            scriptPath: this.scriptPath,
            label: 'the segmenter',
            maxWorkers: this.maxWorkers
        });
        let res;
        try {
            res = await pool.run({ argv: [inputPath, outputPath], timeoutMs: this.frameTimeoutMs });
        } catch (err: any) {
            return { ok: false, error: err instanceof PythonWorkerError ? err.message : `${this.pythonBinary} could not run the segmenter: ${err?.message || err}` };
        }
        const { exitCode: code, stdout, stderr } = res;
        // The script answers with one JSON line (the last one; libraries may log before it).
        const line = stdout.trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
        let answer: any;
        try {
            answer = line ? JSON.parse(line) : undefined;
        } catch {
            answer = undefined;
        }
        const stderrTail = stderr.trim() ? `: ${stderr.trim().slice(-400)}` : '';
        if (answer?.success === true) {
            if (code !== 0) return { ok: false, error: `the segmenter answered success but exited ${code}${stderrTail}` };
            if (!fs.existsSync(outputPath)) return { ok: false, error: `the segmenter answered success but wrote no mask at ${outputPath}` };
            return { ok: true, model: typeof answer.model === 'string' ? answer.model : undefined, modelNote: typeof answer.modelNote === 'string' ? answer.modelNote : undefined };
        }
        return { ok: false, error: typeof answer?.error === 'string' ? answer.error : `the segmenter exited ${code} without an answer${stderrTail}` };
    }
}
