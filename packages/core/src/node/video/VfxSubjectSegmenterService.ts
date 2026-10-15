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
import { spawn, exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
    /** Optional subject hint forwarded to the Python segmenter (for future model routing). */
    subjectHint?: string;
    /** When true, plans execution without spawning processes. */
    dryRun?: boolean;
    /** Override path to segment_subject.py script. */
    scriptPath?: string;
    /** Override Python binary name/path. */
    pythonBinary?: string;
}

export interface SegmentSubjectResult {
    success: boolean;
    videoPath: string;
    outputDir: string;
    totalFrames: number;
    sampleFps: number;
    width: number;
    height: number;
    /** Absolute paths to mask PNGs, in frame order: mask_0000.png, mask_0001.png, … */
    maskPaths: string[];
    /**
     * Relative pattern usable with FFmpeg image2 demuxer:
     *   ffmpeg -framerate <fps> -i <outputDir>/mask_%04d.png …
     */
    ffmpegPattern: string;
    durationSec: number;
    dryRun?: boolean;
    error?: string;
    [key: string]: unknown;
}

// ============================================================================
// Service
// ============================================================================

export class VfxSubjectSegmenterService {
    private pythonBinary: string;
    private scriptPath: string;

    constructor(options?: { pythonBinary?: string; scriptPath?: string }) {
        this.pythonBinary = options?.pythonBinary ?? process.env.PYTHON_BIN ?? 'python3';
        this.scriptPath = options?.scriptPath
            ?? path.resolve(process.cwd(), 'scripts/segment_subject.py');
    }

    async segmentSubject(options: SegmentSubjectOptions): Promise<SegmentSubjectResult> {
        const {
            videoPath,
            outputDir,
            fps = 5,
            dryRun = false,
        } = options;

        if (!fs.existsSync(videoPath)) {
            return this.failure(videoPath, outputDir, fps, `Video file not found: ${videoPath}`);
        }

        if (!fs.existsSync(this.scriptPath)) {
            return this.failure(videoPath, outputDir, fps,
                `Segmentation script not found: ${this.scriptPath}`);
        }

        // Probe video dimensions and duration.
        let width = 0;
        let height = 0;
        let durationSec = 0;
        try {
            const probe = await this.probeVideo(videoPath);
            width = probe.width;
            height = probe.height;
            durationSec = probe.duration;
        } catch (err: unknown) {
            return this.failure(videoPath, outputDir, fps,
                `FFmpeg probe failed: ${String(err)}`);
        }

        const safeFps = Math.max(1, Math.min(fps, 30));
        const expectedFrames = Math.max(1, Math.ceil(durationSec * safeFps));
        const ffmpegPattern = path.join(outputDir, 'mask_%04d.png');

        if (dryRun) {
            return {
                success: true,
                videoPath,
                outputDir,
                totalFrames: expectedFrames,
                sampleFps: safeFps,
                width,
                height,
                maskPaths: [],
                ffmpegPattern,
                durationSec,
                dryRun: true
            };
        }

        await fs.ensureDir(outputDir);

        // Step 1: Extract frames from video using FFmpeg.
        const rawFrameDir = path.join(outputDir, '.raw_frames');
        await fs.ensureDir(rawFrameDir);
        const rawPattern = path.join(rawFrameDir, 'frame_%04d.png');

        await this.extractFrames(videoPath, rawPattern, safeFps);

        // Step 2: Collect extracted frames.
        const rawFrames = (await fs.readdir(rawFrameDir))
            .filter(f => f.endsWith('.png'))
            .sort();

        if (rawFrames.length === 0) {
            await fs.remove(rawFrameDir);
            return this.failure(videoPath, outputDir, fps,
                'FFmpeg extracted zero frames — check video file and fps setting');
        }

        // Step 3: Run segmenter on each frame via Python subprocess.
        const maskPaths: string[] = [];
        for (let i = 0; i < rawFrames.length; i++) {
            const inputFrame = path.join(rawFrameDir, rawFrames[i]);
            const maskPath = path.join(outputDir, `mask_${String(i).padStart(4, '0')}.png`);
            const ok = await this.runSegmenterOnFrame(inputFrame, maskPath);
            if (ok) {
                maskPaths.push(maskPath);
            }
        }

        await fs.remove(rawFrameDir);

        if (maskPaths.length === 0) {
            return this.failure(videoPath, outputDir, fps,
                'Segmenter produced no output masks — check Python dependencies (mediapipe, opencv-python-headless)');
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
            durationSec
        };
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private async probeVideo(
        videoPath: string
    ): Promise<{ width: number; height: number; duration: number }> {
        const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -of csv=p=0 "${videoPath}"`;
        const { stdout } = await execAsync(cmd, { timeout: 10_000 });
        const parts = stdout.trim().split(',');
        const width = parseInt(parts[0] ?? '0', 10);
        const height = parseInt(parts[1] ?? '0', 10);
        const duration = parseFloat(parts[2] ?? '0');
        if (!width || !height) {
            throw new Error(`Unable to read dimensions from ffprobe output: ${stdout.trim()}`);
        }
        return { width, height, duration: isNaN(duration) ? 0 : duration };
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
            const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
            child.on('close', code => {
                if (code !== 0) {
                    reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
                } else {
                    resolve();
                }
            });
            child.on('error', reject);
        });
    }

    private runSegmenterOnFrame(inputPath: string, outputPath: string): Promise<boolean> {
        return new Promise(resolve => {
            const child = spawn(this.pythonBinary, [this.scriptPath, inputPath, outputPath], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            let stdout = '';
            child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
            child.on('close', () => {
                try {
                    const result = JSON.parse(stdout.trim());
                    resolve(result.success === true && fs.existsSync(outputPath));
                } catch {
                    resolve(false);
                }
            });
            child.on('error', () => resolve(false));
        });
    }

    private failure(
        videoPath: string,
        outputDir: string,
        fps: number,
        error: string
    ): SegmentSubjectResult {
        return {
            success: false,
            videoPath,
            outputDir,
            totalFrames: 0,
            sampleFps: fps,
            width: 0,
            height: 0,
            maskPaths: [],
            ffmpegPattern: path.join(outputDir, 'mask_%04d.png'),
            durationSec: 0,
            error
        };
    }
}
