/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { resolveFfmpegPath } from '../image-codec-ffmpeg';

const execFileAsync = promisify(execFile);

export type DeltaSpikeCategory = 'clean' | 'acceptable' | 'morph_cut';

export interface DeltaSpikeFrame {
    frameIndex: number;
    deltaValue: number;
    category: DeltaSpikeCategory;
}

/** One decoded frame: tightly packed RGB24, row 0 = top. */
export interface RgbFrame {
    data: Uint8Array;
}

export interface VideoQAReport {
    videoPath: string;
    frameCount: number;
    width: number;
    height: number;
    /** Frame rate from the container; omitted when ffprobe reports none. */
    fps?: number;
    /** Delta spike analysis (RMS DN between consecutive decoded frames) — detects morph-cut artefacts */
    deltaSpike: {
        maxDelta: number;
        meanDelta: number;
        spikeFrames: DeltaSpikeFrame[];
        passed: boolean;
    };
    /** PSNR (dB) between each pair of consecutive decoded frames. 100 dB marks a bit-identical pair. */
    temporalPsnr: {
        minDb: number;
        meanDb: number;
        /** Index of the later frame of the lowest-PSNR pair. */
        worstFrameIndex: number;
    };
    /** Lowest PSNR of any aligned 8×8 pixel block over all consecutive frame pairs. */
    worstBlockPsnr: {
        db: number;
        frameIndex: number;
        blockX: number;
        blockY: number;
    };
    /**
     * Blockiness on luma: mean |ΔY| across 8×8 block boundaries divided by mean |ΔY| between
     * neighbours inside blocks. ≈1 for content without block artefacts; grows with DCT blocking.
     * Frames with no interior gradient (flat) are skipped; values are null when every frame was flat.
     */
    blockiness: { mean: number | null; max: number | null; worstFrameIndex: number | null };
    /** Temporal stability score (mean inter-frame RMS delta; lower = more stable) */
    temporalStability: number;
    /** Largest drift (DN) of each channel's frame mean from the first frame's channel mean. */
    colorDrift: { r: number; g: number; b: number; maxChannel: number };
    /** Thresholds that were evaluated, and whether each passed. Ungated metrics are reported only. */
    gates: Array<{ metric: string; threshold: number; value: number | null; passed: boolean }>;
    /** Overall QA pass/fail over the evaluated gates */
    passed: boolean;
    /** Human-readable summary */
    summary: string;
}

export interface VideoQAOptions {
    /** Max acceptable per-frame RMS delta before flagging (default: 15.0) */
    deltaSpikeThreshold?: number;
    /** Gate: min acceptable consecutive-frame PSNR in dB (not gated unless given) */
    temporalPsnrMin?: number;
    /** Gate: min acceptable worst 8×8 block PSNR in dB (not gated unless given) */
    worstBlockPsnrMin?: number;
    /** Gate: max acceptable per-frame blockiness ratio (not gated unless given) */
    blockinessMax?: number;
    /** Gate: max acceptable colour drift in DN per channel (not gated unless given) */
    colorDriftMax?: number;
}

export class VideoQAError extends Error {
    constructor(
        readonly code: 'VIDEO_QA_PROBE_FAILED' | 'VIDEO_QA_DECODE_FAILED' | 'VIDEO_QA_TOO_FEW_FRAMES' | 'VIDEO_QA_BAD_INPUT',
        message: string
    ) {
        super(message);
        this.name = 'VideoQAError';
    }
}

const DELTA_CLEAN = 4.1;
const DELTA_ACCEPTABLE = 15.0;
const BLOCK = 8;
const IDENTICAL_PSNR_DB = 100;

function categorizeDelta(delta: number): DeltaSpikeCategory {
    if (delta < DELTA_CLEAN) return 'clean';
    if (delta <= DELTA_ACCEPTABLE) return 'acceptable';
    return 'morph_cut';
}

function mseToPsnr(mse: number): number {
    return mse > 0 ? 10 * Math.log10((255 * 255) / mse) : IDENTICAL_PSNR_DB;
}

/** Mean squared error over every byte of two equally sized RGB24 frames. */
export function frameMse(a: Uint8Array, b: Uint8Array): number {
    if (a.length !== b.length || a.length === 0) {
        throw new VideoQAError('VIDEO_QA_BAD_INPUT', `frame sizes differ or are empty (${a.length} vs ${b.length} bytes)`);
    }
    let sumSq = 0;
    for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sumSq += d * d;
    }
    return sumSq / a.length;
}

/** Worst PSNR over the aligned 8×8 pixel blocks (all 3 channels) of two RGB24 frames. Partial edge blocks count. */
export function worstBlockPsnr(a: Uint8Array, b: Uint8Array, width: number, height: number): { db: number; blockX: number; blockY: number } {
    if (a.length !== width * height * 3 || b.length !== a.length) {
        throw new VideoQAError('VIDEO_QA_BAD_INPUT', `frame byte length does not match ${width}x${height} RGB24`);
    }
    let worstMse = -1;
    let worstBx = 0;
    let worstBy = 0;
    for (let by = 0; by < height; by += BLOCK) {
        const yEnd = Math.min(by + BLOCK, height);
        for (let bx = 0; bx < width; bx += BLOCK) {
            const xEnd = Math.min(bx + BLOCK, width);
            let sumSq = 0;
            let n = 0;
            for (let y = by; y < yEnd; y++) {
                const row = (y * width) * 3;
                for (let i = row + bx * 3; i < row + xEnd * 3; i++) {
                    const d = a[i] - b[i];
                    sumSq += d * d;
                    n++;
                }
            }
            const mse = sumSq / n;
            if (mse > worstMse) {
                worstMse = mse;
                worstBx = bx / BLOCK;
                worstBy = by / BLOCK;
            }
        }
    }
    return { db: mseToPsnr(worstMse), blockX: worstBx, blockY: worstBy };
}

function luma(frame: Uint8Array, width: number, height: number): Float32Array {
    const y = new Float32Array(width * height);
    for (let p = 0, i = 0; p < y.length; p++, i += 3) {
        y[p] = 0.299 * frame[i] + 0.587 * frame[i + 1] + 0.114 * frame[i + 2];
    }
    return y;
}

/**
 * Blockiness ratio of one RGB24 frame on luma: mean absolute neighbour difference across
 * 8-pixel grid boundaries over the mean absolute neighbour difference at interior positions,
 * both horizontal and vertical. Returns null when the frame has no interior gradient.
 */
export function blockinessRatio(frame: Uint8Array, width: number, height: number): number | null {
    if (frame.length !== width * height * 3) {
        throw new VideoQAError('VIDEO_QA_BAD_INPUT', `frame byte length does not match ${width}x${height} RGB24`);
    }
    const y = luma(frame, width, height);
    let boundarySum = 0, boundaryN = 0, interiorSum = 0, interiorN = 0;
    for (let r = 0; r < height; r++) {
        const row = r * width;
        for (let c = 1; c < width; c++) {
            const d = Math.abs(y[row + c] - y[row + c - 1]);
            if (c % BLOCK === 0) { boundarySum += d; boundaryN++; } else { interiorSum += d; interiorN++; }
        }
    }
    for (let r = 1; r < height; r++) {
        const row = r * width;
        const prev = (r - 1) * width;
        const isBoundary = r % BLOCK === 0;
        for (let c = 0; c < width; c++) {
            const d = Math.abs(y[row + c] - y[prev + c]);
            if (isBoundary) { boundarySum += d; boundaryN++; } else { interiorSum += d; interiorN++; }
        }
    }
    if (boundaryN === 0 || interiorN === 0) return null;
    const interiorMean = interiorSum / interiorN;
    if (interiorMean < 1e-6) return null;
    return (boundarySum / boundaryN) / interiorMean;
}

function channelMeans(frame: Uint8Array): [number, number, number] {
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < frame.length; i += 3) {
        r += frame[i];
        g += frame[i + 1];
        b += frame[i + 2];
    }
    const n = frame.length / 3;
    return [r / n, g / n, b / n];
}

/**
 * Computes every QA metric from decoded frames. Frames are consumed one at a time
 * (only the previous frame is retained), so arbitrarily long videos stay in bounded memory.
 */
export async function analyzeDecodedFrames(
    frames: AsyncIterable<RgbFrame> | Iterable<RgbFrame>,
    width: number,
    height: number,
    options: VideoQAOptions = {}
): Promise<Omit<VideoQAReport, 'videoPath' | 'fps'>> {
    if (!(width > 0 && height > 0)) throw new VideoQAError('VIDEO_QA_BAD_INPUT', `invalid frame size ${width}x${height}`);
    const frameBytes = width * height * 3;
    const deltaSpikeThreshold = options.deltaSpikeThreshold ?? DELTA_ACCEPTABLE;

    let prev: Uint8Array | null = null;
    let firstMeans: [number, number, number] | null = null;
    let frameIndex = 0;
    const deltas: number[] = [];
    let psnrSum = 0, psnrMin = Infinity, psnrWorstIdx = 0;
    let worstBlock = { db: Infinity, frameIndex: 0, blockX: 0, blockY: 0 };
    let blockSum = 0, blockN = 0, blockMax: number | null = null, blockWorstIdx: number | null = null;
    const drift = [0, 0, 0];

    for await (const f of frames as AsyncIterable<RgbFrame>) {
        if (f.data.length !== frameBytes) {
            throw new VideoQAError('VIDEO_QA_BAD_INPUT', `frame ${frameIndex} has ${f.data.length} bytes, expected ${frameBytes}`);
        }
        const b = blockinessRatio(f.data, width, height);
        if (b !== null) {
            blockSum += b;
            blockN++;
            if (blockMax === null || b > blockMax) { blockMax = b; blockWorstIdx = frameIndex; }
        }
        const means = channelMeans(f.data);
        if (!firstMeans) firstMeans = means;
        for (let c = 0; c < 3; c++) drift[c] = Math.max(drift[c], Math.abs(means[c] - firstMeans[c]));

        if (prev) {
            const mse = frameMse(prev, f.data);
            deltas.push(Math.sqrt(mse));
            const psnr = mseToPsnr(mse);
            psnrSum += psnr;
            if (psnr < psnrMin) { psnrMin = psnr; psnrWorstIdx = frameIndex; }
            const wb = worstBlockPsnr(prev, f.data, width, height);
            if (wb.db < worstBlock.db) worstBlock = { db: wb.db, frameIndex, blockX: wb.blockX, blockY: wb.blockY };
        }
        // Copy: the decoder may reuse its buffer for the next frame.
        prev = Uint8Array.from(f.data);
        frameIndex++;
    }

    const frameCount = frameIndex;
    if (frameCount < 2) throw new VideoQAError('VIDEO_QA_TOO_FEW_FRAMES', `decoded ${frameCount} frame(s); at least 2 are needed`);

    const maxDelta = Math.max(...deltas);
    const meanDelta = deltas.reduce((a, v) => a + v, 0) / deltas.length;
    const spikeFrames: DeltaSpikeFrame[] = deltas
        .map((d, i) => ({ frameIndex: i + 1, deltaValue: d, category: categorizeDelta(d) }))
        .filter(f => f.category !== 'clean');
    const deltaPassed = maxDelta <= deltaSpikeThreshold;

    const temporalPsnr = { minDb: psnrMin, meanDb: psnrSum / deltas.length, worstFrameIndex: psnrWorstIdx };
    const blockiness = { mean: blockN > 0 ? blockSum / blockN : null, max: blockMax, worstFrameIndex: blockWorstIdx };
    const colorDrift = { r: drift[0], g: drift[1], b: drift[2], maxChannel: Math.max(...drift) };

    const gates: VideoQAReport['gates'] = [
        { metric: 'deltaSpike.maxDelta', threshold: deltaSpikeThreshold, value: maxDelta, passed: deltaPassed }
    ];
    if (options.temporalPsnrMin !== undefined) {
        gates.push({ metric: 'temporalPsnr.minDb', threshold: options.temporalPsnrMin, value: temporalPsnr.minDb, passed: temporalPsnr.minDb >= options.temporalPsnrMin });
    }
    if (options.worstBlockPsnrMin !== undefined) {
        gates.push({ metric: 'worstBlockPsnr.db', threshold: options.worstBlockPsnrMin, value: worstBlock.db, passed: worstBlock.db >= options.worstBlockPsnrMin });
    }
    if (options.blockinessMax !== undefined) {
        // A video whose every frame is flat has no measurable blockiness; the gate cannot pass on no data.
        gates.push({ metric: 'blockiness.max', threshold: options.blockinessMax, value: blockiness.max, passed: blockiness.max !== null && blockiness.max <= options.blockinessMax });
    }
    if (options.colorDriftMax !== undefined) {
        gates.push({ metric: 'colorDrift.maxChannel', threshold: options.colorDriftMax, value: colorDrift.maxChannel, passed: colorDrift.maxChannel <= options.colorDriftMax });
    }
    const passed = gates.every(g => g.passed);

    const morphCutFrames = spikeFrames.filter(f => f.category === 'morph_cut');
    const summaryParts: string[] = [];
    for (const g of gates) {
        if (g.passed) continue;
        if (g.metric === 'deltaSpike.maxDelta') {
            summaryParts.push(`${morphCutFrames.length} morph-cut frame(s) detected (max delta ${maxDelta.toFixed(1)} > ${deltaSpikeThreshold})`);
        } else {
            summaryParts.push(`${g.metric} ${g.value === null ? 'unmeasurable' : g.value.toFixed(2)} fails threshold ${g.threshold}`);
        }
    }
    if (passed) summaryParts.push(`All ${gates.length} evaluated QA gate(s) passed`);

    return {
        frameCount,
        width,
        height,
        deltaSpike: { maxDelta, meanDelta, spikeFrames, passed: deltaPassed },
        temporalPsnr,
        worstBlockPsnr: worstBlock,
        blockiness,
        temporalStability: meanDelta,
        colorDrift,
        gates,
        passed,
        summary: summaryParts.join('; ')
    };
}

async function probeVideo(videoPath: string): Promise<{ width: number; height: number; fps?: number }> {
    const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 'v:0', videoPath]));
    } catch (err) {
        throw new VideoQAError('VIDEO_QA_PROBE_FAILED', `ffprobe could not read ${videoPath}: ${(err as Error).message}`);
    }
    const stream = JSON.parse(stdout).streams?.[0] as Record<string, unknown> | undefined;
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (!stream || !(width > 0) || !(height > 0)) {
        throw new VideoQAError('VIDEO_QA_PROBE_FAILED', `no video stream with dimensions in ${videoPath}`);
    }
    const rate = String(stream.avg_frame_rate ?? stream.r_frame_rate ?? '');
    const [num, den] = rate.split('/').map(Number);
    const fps = num > 0 && den > 0 ? num / den : undefined;
    return { width, height, fps };
}

/** Streams decoded RGB24 frames out of ffmpeg one at a time. */
async function* decodeFrames(videoPath: string, width: number, height: number): AsyncGenerator<RgbFrame> {
    const frameBytes = width * height * 3;
    const proc = spawn(resolveFfmpegPath(), ['-nostdin', '-v', 'error', '-i', videoPath, '-map', '0:v:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    const exited = new Promise<number | null>((resolve, reject) => {
        proc.on('error', reject);
        proc.on('close', code => resolve(code));
    });
    let pending: Buffer = Buffer.alloc(0);
    try {
        for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
            pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
            while (pending.length >= frameBytes) {
                yield { data: pending.subarray(0, frameBytes) };
                pending = pending.subarray(frameBytes);
            }
        }
        let code: number | null;
        try {
            code = await exited;
        } catch (err) {
            throw new VideoQAError('VIDEO_QA_DECODE_FAILED', `could not run ffmpeg: ${(err as Error).message}`);
        }
        if (code !== 0) throw new VideoQAError('VIDEO_QA_DECODE_FAILED', `ffmpeg exited ${code} decoding ${videoPath}: ${stderr.trim().slice(-500)}`);
        if (pending.length !== 0) throw new VideoQAError('VIDEO_QA_DECODE_FAILED', `decoder output ended mid-frame (${pending.length} trailing bytes)`);
    } finally {
        if (proc.exitCode === null) proc.kill('SIGKILL');
    }
}

/**
 * Runs multi-metric QA on a video file, decoding every frame with ffmpeg.
 *
 * Metrics (all computed from decoded pixels):
 * - Delta spike: RMS DN between consecutive frames (< 4.1 clean, 4.1–15.0 acceptable, > 15.0 morph-cut); gated by default
 * - Temporal PSNR between consecutive frames (min / mean)
 * - Worst aligned 8×8 block PSNR over all consecutive pairs
 * - Blockiness: 8×8 grid-boundary vs interior luma discontinuity ratio
 * - Colour drift: max per-channel mean drift from the first frame
 * Only deltaSpike is gated by default; the others are gated when a threshold is supplied.
 */
export async function checkVideo(videoPath: string, options: VideoQAOptions = {}): Promise<VideoQAReport> {
    const { width, height, fps } = await probeVideo(videoPath);
    const result = await analyzeDecodedFrames(decodeFrames(videoPath, width, height), width, height, options);
    return { videoPath, ...(fps !== undefined ? { fps } : {}), ...result };
}
