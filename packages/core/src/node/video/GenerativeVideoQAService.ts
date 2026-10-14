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
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type DeltaSpikeCategory = 'clean' | 'acceptable' | 'morph_cut';

export interface DeltaSpikeFrame {
    frameIndex: number;
    deltaValue: number;
    category: DeltaSpikeCategory;
}

export interface VideoQAReport {
    videoPath: string;
    frameCount: number;
    fps: number;
    /** Delta spike analysis — detects morph-cut artefacts */
    deltaSpike: {
        maxDelta: number;
        meanDelta: number;
        spikeFrames: DeltaSpikeFrame[];
        passed: boolean;
    };
    /** Global PSNR across the full video sequence (first-to-last frame) */
    psnrGlobal: number;
    /** Worst-block PSNR (8×8 tile) */
    psnrWorstBlock: number;
    /** Temporal stability score (mean inter-frame delta; lower = more stable) */
    temporalStability: number;
    /** Per-channel color bias (mean absolute deviation from neutral 128) */
    colorBias: { r: number; g: number; b: number; maxChannel: number; passed: boolean };
    /** Overall QA pass/fail */
    passed: boolean;
    /** Human-readable summary */
    summary: string;
}

export interface VideoQAOptions {
    /** Max acceptable per-frame delta before flagging (default: 15.0) */
    deltaSpikeThreshold?: number;
    /** Min acceptable global PSNR in dB (default: 38) */
    psnrGlobalMin?: number;
    /** Min acceptable worst-block PSNR in dB (default: 28) */
    psnrWorstBlockMin?: number;
    /** Max acceptable color bias per channel in DN (default: 2.0) */
    colorBiasMax?: number;
    /** Working directory for extracted frames (if omitted, a temp dir is used and cleaned up) */
    workDir?: string;
}

const DELTA_CLEAN = 4.1;
const DELTA_ACCEPTABLE = 15.0;

function categorizeDelta(delta: number): DeltaSpikeCategory {
    if (delta < DELTA_CLEAN) return 'clean';
    if (delta <= DELTA_ACCEPTABLE) return 'acceptable';
    return 'morph_cut';
}

async function getVideoInfo(videoPath: string): Promise<{ fps: number }> {
    const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        videoPath
    ]);
    const probeData = JSON.parse(stdout);
    const videoStream = probeData.streams?.find((s: Record<string, unknown>) => s.codec_type === 'video');
    const fpsStr = (videoStream?.r_frame_rate as string) ?? '24/1';
    const [num, den] = fpsStr.split('/').map(Number);
    const fps = den > 0 ? num / den : 24;
    return { fps };
}

async function extractFrames(videoPath: string, outputDir: string): Promise<string[]> {
    await execFileAsync('ffmpeg', [
        '-i', videoPath,
        '-q:v', '2',
        path.join(outputDir, 'frame_%06d.png')
    ]);
    return fs.readdirSync(outputDir)
        .filter(f => f.startsWith('frame_') && f.endsWith('.png'))
        .sort()
        .map(f => path.join(outputDir, f));
}

/** Extract raw RGB pixels from a PNG via FFmpeg rawvideo pipe */
async function extractRawRgb(framePath: string): Promise<{ data: Buffer; width: number; height: number }> {
    // First probe dimensions
    const { stdout: probe } = await execFileAsync('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_streams', framePath
    ]);
    const info = JSON.parse(probe);
    const stream = info.streams?.find((s: Record<string, unknown>) => s.codec_type === 'video');
    const width: number = stream?.width ?? 0;
    const height: number = stream?.height ?? 0;

    const { stdout } = await execFileAsync('ffmpeg', [
        '-i', framePath,
        '-f', 'rawvideo',
        '-pix_fmt', 'rgb24',
        '-frames:v', '1',
        'pipe:1'
    ], { encoding: 'buffer', maxBuffer: width * height * 3 * 2 } as any);
    return { data: stdout as unknown as Buffer, width, height };
}

function computeFrameDelta(a: Buffer, b: Buffer): number {
    const len = Math.min(a.length, b.length);
    if (len === 0) return 0;
    let sumSq = 0;
    for (let i = 0; i < len; i++) {
        const d = a[i] - b[i];
        sumSq += d * d;
    }
    return Math.sqrt(sumSq / len);
}

function computePSNR(a: Buffer, b: Buffer): { global: number; worstBlock: number; width: number; height: number } {
    const len = Math.min(a.length, b.length);
    if (len === 0) return { global: 0, worstBlock: 0, width: 0, height: 0 };

    let mse = 0;
    for (let i = 0; i < len; i++) {
        const d = a[i] - b[i];
        mse += d * d;
    }
    mse /= len;
    const globalPSNR = mse > 0 ? 10 * Math.log10((255 * 255) / mse) : 100;

    // Approximate worst 8×8 block PSNR — scan in 8-pixel channel groups
    const blockSize = 8 * 3; // 8 pixels × 3 channels
    let worstBlockMSE = 0;
    for (let offset = 0; offset + blockSize <= len; offset += blockSize) {
        let blockMSE = 0;
        for (let i = 0; i < blockSize; i++) {
            const d = a[offset + i] - b[offset + i];
            blockMSE += d * d;
        }
        blockMSE /= blockSize;
        if (blockMSE > worstBlockMSE) worstBlockMSE = blockMSE;
    }
    const worstBlock = worstBlockMSE > 0 ? 10 * Math.log10((255 * 255) / worstBlockMSE) : 100;

    return { global: globalPSNR, worstBlock, width: 0, height: 0 };
}

function computeColorBias(rawRgb: Buffer): { r: number; g: number; b: number } {
    const pixelCount = Math.floor(rawRgb.length / 3);
    if (pixelCount === 0) return { r: 0, g: 0, b: 0 };
    let sumR = 0, sumG = 0, sumB = 0;
    for (let i = 0; i < rawRgb.length; i += 3) {
        sumR += rawRgb[i];
        sumG += rawRgb[i + 1];
        sumB += rawRgb[i + 2];
    }
    return {
        r: Math.abs(sumR / pixelCount - 128),
        g: Math.abs(sumG / pixelCount - 128),
        b: Math.abs(sumB / pixelCount - 128)
    };
}

/**
 * Runs multi-metric QA on a generated video file.
 *
 * Metrics:
 * - Delta spike check: detects morph-cut artefacts (< 4.1 clean, 4.1–15.0 acceptable, > 15.0 = morph-cut)
 * - Global PSNR (> 38 dB) and worst-block PSNR (> 28 dB) between first and last frame
 * - Temporal stability: mean inter-frame delta (lower is more stable)
 * - Color bias < 2 DN/channel across all frames
 */
export async function checkVideo(videoPath: string, options: VideoQAOptions = {}): Promise<VideoQAReport> {
    const {
        deltaSpikeThreshold = DELTA_ACCEPTABLE,
        psnrGlobalMin = 38,
        psnrWorstBlockMin = 28,
        colorBiasMax = 2.0,
        workDir
    } = options;

    const tmpDir = workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'sbqa_'));
    const cleanupTmp = !workDir;

    try {
        const { fps } = await getVideoInfo(videoPath);
        const framePaths = await extractFrames(videoPath, tmpDir);
        const frameCount = framePaths.length;

        if (frameCount < 2) {
            throw new Error(`Video has fewer than 2 frames: ${videoPath}`);
        }

        // Extract raw pixel data for all frames
        const rawFrames = await Promise.all(framePaths.map(p => extractRawRgb(p)));

        // Compute per-frame deltas
        const deltas: number[] = [];
        for (let i = 1; i < rawFrames.length; i++) {
            deltas.push(computeFrameDelta(rawFrames[i - 1].data, rawFrames[i].data));
        }

        const maxDelta = Math.max(...deltas);
        const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;

        const spikeFrames: DeltaSpikeFrame[] = deltas
            .map((d, i) => ({ frameIndex: i + 1, deltaValue: d, category: categorizeDelta(d) }))
            .filter(f => f.category !== 'clean');

        const deltaPassed = maxDelta <= deltaSpikeThreshold;

        // PSNR between first and last frame
        const { global: psnrGlobal, worstBlock: psnrWorstBlock } = computePSNR(
            rawFrames[0].data,
            rawFrames[rawFrames.length - 1].data
        );

        const temporalStability = meanDelta;

        // Color bias: mean per-channel across all frames vs. neutral 128
        const biases = rawFrames.map(f => computeColorBias(f.data));
        const biasR = biases.reduce((s, b) => s + b.r, 0) / biases.length;
        const biasG = biases.reduce((s, b) => s + b.g, 0) / biases.length;
        const biasB = biases.reduce((s, b) => s + b.b, 0) / biases.length;
        const maxColorBias = Math.max(biasR, biasG, biasB);
        const colorBiasPassed = maxColorBias <= colorBiasMax;

        const psnrPassed = psnrGlobal >= psnrGlobalMin && psnrWorstBlock >= psnrWorstBlockMin;
        const passed = deltaPassed && psnrPassed && colorBiasPassed;

        const morphCutFrames = spikeFrames.filter(f => f.category === 'morph_cut');
        const summaryParts: string[] = [];
        if (!deltaPassed) summaryParts.push(`${morphCutFrames.length} morph-cut frame(s) detected (max delta ${maxDelta.toFixed(1)} > ${deltaSpikeThreshold})`);
        if (!psnrPassed) summaryParts.push(`PSNR below threshold (global ${psnrGlobal.toFixed(1)} dB, worst-block ${psnrWorstBlock.toFixed(1)} dB)`);
        if (!colorBiasPassed) summaryParts.push(`Color bias too high (${maxColorBias.toFixed(2)} DN)`);
        if (passed) summaryParts.push('All QA metrics passed');

        return {
            videoPath,
            frameCount,
            fps,
            deltaSpike: { maxDelta, meanDelta, spikeFrames, passed: deltaPassed },
            psnrGlobal,
            psnrWorstBlock,
            temporalStability,
            colorBias: { r: biasR, g: biasG, b: biasB, maxChannel: maxColorBias, passed: colorBiasPassed },
            passed,
            summary: summaryParts.join('; ')
        };
    } finally {
        if (cleanupTmp && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }
}
