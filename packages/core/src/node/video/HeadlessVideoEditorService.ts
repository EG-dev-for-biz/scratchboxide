/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { chooseH264Encoder, getFfmpegCapabilities, h264EncodeArgs, vp9EncodeArgs, DEFAULT_X264_PRESET } from './ffmpeg-capabilities';

const execFileAsync = promisify(execFile);

export function resolveBinary(binName: 'ffmpeg' | 'ffprobe'): string {
    if (binName === 'ffmpeg' && process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
        return process.env.FFMPEG_PATH;
    }
    if (binName === 'ffprobe' && process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
        return process.env.FFPROBE_PATH;
    }
    const candidates = [
        `/opt/homebrew/bin/${binName}`,
        `/usr/local/bin/${binName}`,
        `/usr/bin/${binName}`
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return binName;
}

export function toEven(n: number): number {
    const v = Math.round(n);
    return v % 2 === 0 ? v : v - 1;
}

export interface VideoProbeResult {
    durationSec: number;
    width: number;
    height: number;
    fps: number;
    hasAudio: boolean;
    format: string;
    sizeBytes?: number;
}

export interface VideoFilterBakeConfig {
    colorTemperatureKelvin?: number; // 1,000 to 40,000 Kelvin
    brightness?: number;            // -1.0 to 1.0 (default 0)
    contrast?: number;              // 0.0 to 2.0 (default 1.0)
    saturation?: number;            // 0.0 to 2.0 (default 1.0)
    grainIntensity?: number;        // 0 to 100 (noise filter)
    vignetteAngle?: number;         // 0 to 1.57 (radians)
}

export interface QuickEditOptions {
    inputPath: string;
    outputPath: string;
    trim?: {
        startSec?: number;
        durationSec?: number;
        endSec?: number;
    };
    scale?: {
        width?: number;
        height?: number;
        fit?: 'contain' | 'cover' | 'stretch';
    };
    crop?: {
        aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3';
        box?: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
    };
    fps?: number;
    speedMultiplier?: number; // 0.25 to 4.0
    filterBake?: VideoFilterBakeConfig;
    muteAudio?: boolean;
    remuxAudioPath?: string;
    format?: 'mp4' | 'webm' | 'gif' | 'mov';
    crf?: number;
    preset?: string;
    dryRun?: boolean;
    timeoutMs?: number;
    /** The caller's Stop: kills the running ffmpeg, which rejects with an AbortError. */
    signal?: AbortSignal;
}

export interface ExtractKeyframesOptions {
    inputPath: string;
    outputDir?: string;
    outputPathPattern?: string;
    timestampsSec?: number[];
    heroFrameOnly?: boolean;
    format?: 'png' | 'jpg';
    dryRun?: boolean;
    timeoutMs?: number;
    /** The caller's Stop: kills the ffmpeg of the frame in flight and starts none for the frames after it (AbortError). */
    signal?: AbortSignal;
}

export interface SplitScreenOptions {
    leftVideoPath: string;
    rightVideoPath: string;
    outputPath: string;
    layout?: 'horizontal' | 'vertical';
    format?: 'mp4' | 'webm';
    crf?: number;
    dryRun?: boolean;
    timeoutMs?: number;
}

export interface ConcatClipsOptions {
    inputPaths?: string[];
    clipPaths?: string[];
    outputPath: string;
    targetFps?: number;
    targetAudioRate?: number;
    targetDimensions?: { width: number; height: number };
    dryRun?: boolean;
    timeoutMs?: number;
}

export interface StoryboardSheetOptions {
    inputPath: string;
    outputPath: string;
    columns?: number;
    rows?: number;
    totalFrames?: number;
    cellWidth?: number;
    cellHeight?: number;
    padding?: number;
    margin?: number;
    labelTimecode?: boolean;
    timeoutMs?: number;
    dryRun?: boolean;
    /**
     * The input's length in seconds. Measured with ffprobe when the input exists; a dry run of an input that is not
     * on disk needs it to plan the frame times.
     */
    durationSec?: number;
    /** The caller's Stop: kills the running ffmpeg, which rejects with an AbortError. */
    signal?: AbortSignal;
}

export interface LutGradeOptions {
    inputPath: string;
    lutPath: string;
    outputPath: string;
    intensity?: number;
    interpolation?: 'nearest' | 'trilinear' | 'tetrahedral';
    crf?: number;
    preset?: string;
    timeoutMs?: number;
    dryRun?: boolean;
}

export interface ChromaKeyOptions {
    inputPath: string;
    backgroundPath?: string;
    outputPath: string;
    keyColor?: string;
    similarity?: number;
    blend?: number;
    spillSuppression?: boolean;
    crf?: number;
    preset?: string;
    timeoutMs?: number;
    dryRun?: boolean;
}

export interface ConditioningMapOptions {
    inputPath: string;
    outputPath: string;
    mapType: 'edge' | 'height' | 'luminance_contrast';
    strength?: number;
    threshold?: number;
    invert?: boolean;
    crf?: number;
    timeoutMs?: number;
    dryRun?: boolean;
}

export interface MotionStabilizationOptions {
    inputPath: string;
    outputPath: string;
    shakiness?: number;
    accuracy?: number;
    smoothing?: number;
    zoomPercent?: number;
    timeoutMs?: number;
    dryRun?: boolean;
}

export interface SeamlessLoopOptions {
    inputPath: string;
    outputPath: string;
    mode?: 'ping_pong' | 'crossfade';
    crossfadeDurationSec?: number;
    crf?: number;
    timeoutMs?: number;
    dryRun?: boolean;
}

export interface AudioLoudnessOptions {
    inputPath: string;
    outputPath: string;
    targetLufs?: number;
    loudnessRange?: number;
    truePeak?: number;
    timeoutMs?: number;
    dryRun?: boolean;
}

export interface AudioDuckingOptions {
    musicTrackPath: string;
    voiceoverTrackPath: string;
    outputPath: string;
    threshold?: number;
    ratio?: number;
    attackMs?: number;
    releaseMs?: number;
    musicVolume?: number;
    voiceoverVolume?: number;
    timeoutMs?: number;
    dryRun?: boolean;
}

export interface EncodeFrameSequenceOptions {
    framePattern: string;
    outputPath: string;
    fps?: number;
    audioSourcePath?: string;
    codec?: 'h264' | 'prores' | 'vp9';
    crf?: number;
    preset?: string;
    faststart?: boolean;
    timeoutMs?: number;
    dryRun?: boolean;
}

export interface VideoEditorJobResult {
    success: boolean;
    outputPath?: string;
    outputPaths?: string[];
    outputSizeBytes?: number;
    durationSec?: number;
    command?: string;
    commandString?: string;
    ffmpegCommand?: string;
    commands?: string[];
    args?: string[];
    stdout?: string;
    stderr?: string;
    error?: string;
    [key: string]: unknown;
}

function mediaPathCandidates(filePath: string): string[] {
    return [
        filePath,
        path.resolve(process.cwd(), filePath),
        path.resolve(process.cwd(), 'desktop-app', 'public', filePath),
        path.resolve(process.cwd(), 'desktop-app', 'public', filePath.replace(/^\/?(?:desktop-app\/public\/)?/, '')),
        path.resolve(process.cwd(), 'public', filePath.replace(/^\/?(?:public\/)?/, ''))
    ];
}

export function resolveMediaFilePath(filePath: string): string {
    if (!filePath) return filePath;
    const candidates = mediaPathCandidates(filePath);
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    // Fuzzy fallback for synthesis / restyled aliases. Only one alias hop: recursing into
    // resolveMediaFilePath here would bounce synthesis <-> restyled forever when neither exists.
    const aliases: string[] = [];
    if (filePath.includes('synthesis')) aliases.push(filePath.replace('synthesis', 'restyled'));
    if (filePath.includes('restyled')) aliases.push(filePath.replace('restyled', 'synthesis'));
    for (const alt of aliases) {
        for (const c of mediaPathCandidates(alt)) {
            if (fs.existsSync(c)) return c;
        }
    }
    return candidates[1];
}

export class HeadlessVideoEditorService {
    private ffmpegBin: string;
    private ffprobeBin: string;

    constructor(customFfmpeg?: string, customFfprobe?: string) {
        this.ffmpegBin = customFfmpeg || resolveBinary('ffmpeg');
        this.ffprobeBin = customFfprobe || resolveBinary('ffprobe');
    }

    getFfmpegPath(): string {
        return this.ffmpegBin;
    }

    getFfprobePath(): string {
        return this.ffprobeBin;
    }

    /**
     * Inspects media file metadata via ffprobe.
     */
    async probeMedia(inputPath: string, timeoutMs: number = 10000): Promise<VideoProbeResult> {
        const resolvedInput = resolveMediaFilePath(inputPath);
        if (!fs.existsSync(resolvedInput)) {
            throw new Error(`probeMedia: input file does not exist at "${inputPath}"`);
        }

        const sizeBytes = fs.statSync(resolvedInput).size;

        // One ffprobe call for duration, the first video stream's size and frame rate, and the audio streams.
        const probe = await execFileAsync(this.ffprobeBin, [
            '-v', 'error',
            '-show_entries', 'format=duration:stream=codec_type,width,height,avg_frame_rate,r_frame_rate',
            '-of', 'json',
            resolvedInput
        ], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
        let info: any;
        try {
            info = JSON.parse(probe.stdout);
        } catch {
            throw new Error(`probeMedia: ffprobe printed no JSON for "${inputPath}"`);
        }
        const streams: any[] = Array.isArray(info?.streams) ? info.streams : [];
        const video = streams.find(st => st.codec_type === 'video');
        const hasAudio = streams.some(st => st.codec_type === 'audio');
        const durationSec = parseFloat(info?.format?.duration) || 0;
        const width = Number(video?.width);
        const height = Number(video?.height);
        if (!video || !(width > 0) || !(height > 0)) {
            throw new Error(`probeMedia: ffprobe found no video stream with a size in "${inputPath}"`);
        }
        const rate = (r: unknown) => {
            const [num, den] = String(r ?? '').split('/').map(Number);
            return num > 0 && den > 0 ? num / den : 0;
        };
        const fpsRaw = rate(video.avg_frame_rate) || rate(video.r_frame_rate);
        if (!(fpsRaw > 0)) {
            throw new Error(`probeMedia: ffprobe reported no frame rate for the video stream of "${inputPath}"`);
        }
        const fps = Math.round(fpsRaw * 100) / 100;

        const ext = path.extname(inputPath).replace('.', '').toLowerCase();

        return {
            durationSec,
            width,
            height,
            fps,
            hasAudio,
            format: ext,
            sizeBytes
        };
    }

    /**
     * Builds and executes single-pass quick edit operations:
     * Trimming, scaling, cropping, retiming, filter baking, audio muting/remuxing, and transcoding.
     */
    async quickEdit(opts: QuickEditOptions): Promise<VideoEditorJobResult> {
        const {
            inputPath,
            outputPath,
            trim,
            scale,
            crop,
            fps,
            speedMultiplier,
            filterBake,
            muteAudio,
            remuxAudioPath,
            format = 'mp4',
            crf = 20,
            preset,
            dryRun = false,
            timeoutMs = 120000,
            signal
        } = opts;

        const args: string[] = ['-y'];

        // 1. Fast Seek if startSec is given
        if (trim?.startSec && trim.startSec > 0) {
            args.push('-ss', String(trim.startSec));
        }

        // 2. Input
        args.push('-i', inputPath);

        // 2b. Optional remux audio input
        if (remuxAudioPath && !muteAudio) {
            args.push('-i', remuxAudioPath);
        }

        // 3. Duration clamp
        if (trim?.durationSec && trim.durationSec > 0) {
            args.push('-t', String(trim.durationSec));
        } else if (trim?.endSec && trim?.startSec && trim.endSec > trim.startSec) {
            args.push('-t', String(trim.endSec - trim.startSec));
        }

        // 4. Video filter chain construction
        const vfParts: string[] = [];

        // Speed adjustment
        if (speedMultiplier && speedMultiplier > 0 && Math.abs(speedMultiplier - 1.0) > 0.01) {
            const ptsFactor = (1 / speedMultiplier).toFixed(4);
            vfParts.push(`setpts=${ptsFactor}*PTS`);
        }

        // Crop
        if (crop?.box) {
            const cw = toEven(crop.box.width);
            const ch = toEven(crop.box.height);
            const cx = Math.max(0, Math.round(crop.box.x));
            const cy = Math.max(0, Math.round(crop.box.y));
            vfParts.push(`crop=${cw}:${ch}:${cx}:${cy}`);
        } else if (crop?.aspectRatio) {
            if (crop.aspectRatio === '16:9') {
                vfParts.push('crop=w=min(iw\\,ih*16/9):h=min(ih\\,iw*9/16)');
            } else if (crop.aspectRatio === '9:16') {
                vfParts.push('crop=w=min(iw\\,ih*9/16):h=min(ih\\,iw*16/9)');
            } else if (crop.aspectRatio === '1:1') {
                vfParts.push('crop=w=min(iw\\,ih):h=min(iw\\,ih)');
            } else if (crop.aspectRatio === '4:3') {
                vfParts.push('crop=w=min(iw\\,ih*4/3):h=min(ih\\,iw*3/4)');
            }
        }

        // Scale
        if (scale?.width || scale?.height) {
            const sw = scale.width ? toEven(scale.width) : -2;
            const sh = scale.height ? toEven(scale.height) : -2;
            if (scale.fit === 'contain') {
                vfParts.push(`scale=${sw}:${sh}:force_original_aspect_ratio=decrease,pad=${sw}:${sh}:(ow-iw)/2:(oh-ih)/2`);
            } else {
                vfParts.push(`scale=${sw}:${sh}:flags=lanczos`);
            }
        }

        // Frame rate conform
        if (fps && fps > 0) {
            vfParts.push(`fps=${fps}`);
        }

        // Filter baking (Kelvin, eq, noise, vignette)
        if (filterBake) {
            if (filterBake.colorTemperatureKelvin && filterBake.colorTemperatureKelvin > 0) {
                const k = Math.min(40000, Math.max(1000, Math.round(filterBake.colorTemperatureKelvin)));
                vfParts.push(`colortemperature=temperature=${k}`);
            }
            if (filterBake.brightness !== undefined || filterBake.contrast !== undefined || filterBake.saturation !== undefined) {
                const b = filterBake.brightness !== undefined ? filterBake.brightness.toFixed(3) : '0.0';
                const c = filterBake.contrast !== undefined ? Math.max(0, filterBake.contrast).toFixed(3) : '1.0';
                const s = filterBake.saturation !== undefined ? Math.max(0, filterBake.saturation).toFixed(3) : '1.0';
                vfParts.push(`eq=brightness=${b}:contrast=${c}:saturation=${s}`);
            }
            if (filterBake.grainIntensity && filterBake.grainIntensity > 0) {
                const g = Math.min(100, Math.max(1, Math.round(filterBake.grainIntensity)));
                vfParts.push(`noise=alls=${g}:allf=t+u`);
            }
            if (filterBake.vignetteAngle && filterBake.vignetteAngle > 0) {
                const a = Math.min(1.57, filterBake.vignetteAngle).toFixed(3);
                vfParts.push(`vignette=angle=${a}`);
            }
        }

        // 5. Codec & Format Specifics
        if (format === 'gif') {
            const gifFps = fps || 15;
            const gifVf = vfParts.length > 0 ? `${vfParts.join(',')},` : '';
            args.push('-vf', `${gifVf}fps=${gifFps},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`);
            args.push(outputPath);
        } else {
            if (vfParts.length > 0) {
                args.push('-vf', vfParts.join(','));
            }

            if (format === 'webm') {
                args.push(...vp9EncodeArgs(crf || 28), '-pix_fmt', 'yuv420p');
            } else {
                // Default mp4 / mov: H.264. A named x264 preset pins libx264; otherwise the hardware encoder when the
                // capability check proved it works (the command names the encoder used).
                const encoder = await chooseH264Encoder(this.ffmpegBin, preset);
                args.push(...h264EncodeArgs(encoder, crf, preset), '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
            }

            // Audio handling
            const audioCodec = format === 'webm' ? 'libopus' : 'aac';
            const audioSampleRate = format === 'webm' ? '48000' : '44100';

            if (muteAudio) {
                args.push('-an');
            } else if (remuxAudioPath) {
                args.push('-map', '0:v:0', '-map', '1:a:0?', '-c:a', audioCodec, '-ar', audioSampleRate, '-ac', '2', '-b:a', '128k', '-shortest');
            } else {
                if (speedMultiplier && speedMultiplier > 0 && Math.abs(speedMultiplier - 1.0) > 0.01) {
                    const atempo = Math.min(2.0, Math.max(0.5, speedMultiplier)).toFixed(2);
                    args.push('-af', `atempo=${atempo}`, '-c:a', audioCodec, '-ar', audioSampleRate, '-ac', '2');
                } else {
                    args.push('-c:a', audioCodec, '-ar', audioSampleRate, '-ac', '2');
                }
            }

            args.push(outputPath);
        }

        const command = `${this.ffmpegBin} ${args.map(a => (a.includes(' ') || a.includes(';') ? `"${a}"` : a)).join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command,
                commandString: command,
                ffmpegCommand: command,
                commands: [command],
                args,
                durationSec: opts.trim?.durationSec || (opts.trim?.endSec !== undefined && opts.trim?.startSec !== undefined ? opts.trim.endSec - opts.trim.startSec : undefined)
            };
        }

        // Ensure target directory exists
        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const execRes = await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, signal });
        const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

        return {
            success: true,
            outputPath,
            outputSizeBytes: sizeBytes,
            command,
            commandString: command,
            ffmpegCommand: command,
            commands: [command],
            args,
            stdout: execRes.stdout,
            stderr: execRes.stderr
        };
    }

    /**
     * Extracts high-resolution keyframe stills (PNG/JPG) using fast keyframe seeking (-ss before -i).
     */
    async extractKeyframes(opts: ExtractKeyframesOptions): Promise<VideoEditorJobResult> {
        const {
            inputPath,
            outputDir,
            outputPathPattern,
            timestampsSec = [0],
            heroFrameOnly = false,
            format = 'png',
            dryRun = false,
            timeoutMs = 60000,
            signal
        } = opts;

        if (!fs.existsSync(inputPath) && !dryRun) {
            throw new Error(`extractKeyframes: input file does not exist at "${inputPath}"`);
        }

        const targetTimestamps = heroFrameOnly ? [0] : timestampsSec;
        const outDir = outputDir || (outputPathPattern ? path.dirname(outputPathPattern) : path.dirname(inputPath));

        if (!fs.existsSync(outDir) && !dryRun) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        if (outputPathPattern && !outputPathPattern.includes('%') && targetTimestamps.length > 1) {
            throw new Error(`extractKeyframes: ${targetTimestamps.length} timestamps need a numbered output pattern (e.g. frame_%04d.png), not the single path "${outputPathPattern}"`);
        }
        const outputPaths: string[] = targetTimestamps.map((ts, i) => {
            if (outputPathPattern && outputPathPattern.includes('%')) {
                return outputPathPattern.replace(/%0?(\d+)d/, (_, width) => String(i).padStart(parseInt(width, 10), '0'));
            }
            if (outputPathPattern) return outputPathPattern;
            const base = path.basename(inputPath, path.extname(inputPath));
            const tsLabel = String(Math.round(ts * 100)).padStart(4, '0');
            return path.join(outDir, `${base}_keyframe_${i}_${tsLabel}cs.${format}`);
        });

        // One ffmpeg per batch of up to KEYFRAME_BATCH timestamps instead of one per frame: each timestamp is its
        // own fast-seeked input (-ss before -i, the same frame a single-frame extraction picks) mapped to its own
        // one-frame output, so ffmpeg seeks and decodes them in one process. Batches run two at a time.
        const KEYFRAME_BATCH = 24;
        const batches: number[][] = [];
        for (let start = 0; start < targetTimestamps.length; start += KEYFRAME_BATCH) {
            batches.push(targetTimestamps.slice(start, start + KEYFRAME_BATCH).map((_, k) => start + k));
        }
        const batchArgs = batches.map(indices => {
            const args = ['-y', '-hide_banner', '-v', 'error'];
            for (const i of indices) args.push('-ss', String(targetTimestamps[i]), '-i', inputPath);
            indices.forEach((i, k) => args.push('-map', `${k}:v:0`, '-frames:v', '1', '-q:v', '2', outputPaths[i]));
            return args;
        });
        const executedCommands = batchArgs.map(args => `${this.ffmpegBin} ${args.join(' ')}`);

        if (!dryRun) {
            let finished = 0;
            const stopped = () => Object.assign(new Error(`extractKeyframes was stopped after ${finished} of ${targetTimestamps.length} frames`), { name: 'AbortError', cause: signal?.reason });
            if (signal?.aborted) throw stopped();
            let next = 0;
            const lane = async () => {
                while (next < batchArgs.length) {
                    const b = next++;
                    if (signal?.aborted) throw stopped();
                    try {
                        await execFileAsync(this.ffmpegBin, batchArgs[b], { timeout: timeoutMs, signal, maxBuffer: 8 * 1024 * 1024 });
                    } catch (err) {
                        if (signal?.aborted) throw stopped();
                        throw err;
                    }
                    finished += batches[b].length;
                }
            };
            await Promise.all(Array.from({ length: Math.min(2, batchArgs.length) }, lane));
            const missing = outputPaths.filter(p => !fs.existsSync(p));
            if (missing.length > 0) {
                const firstIdx = outputPaths.indexOf(missing[0]);
                throw new Error(`extractKeyframes: ffmpeg wrote no frame for ${missing.length} of ${outputPaths.length} timestamp(s) (first: ${targetTimestamps[firstIdx]} s, past the last frame of "${inputPath}"?)`);
            }
        }

        return {
            success: true,
            outputPaths,
            command: executedCommands.join(' && '),
            commandString: executedCommands.join(' && '),
            ffmpegCommand: executedCommands.join(' && '),
            commands: executedCommands,
            outputPath: outputPaths[0]
        };
    }

    /**
     * Compiles a synchronized 50/50 comparison video (Blockout vs Synthesis) with matched heights.
     */
    async createSplitScreen(opts: SplitScreenOptions): Promise<VideoEditorJobResult> {
        const {
            leftVideoPath,
            rightVideoPath,
            outputPath,
            layout = 'horizontal',
            format = 'mp4',
            crf = 19,
            dryRun = false,
            timeoutMs = 180000
        } = opts;

        // Build filtergraph
        let filterGraph: string;
        if (layout === 'vertical') {
            filterGraph = '[0:v]scale=1920:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:1080[top];[1:v]scale=1920:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=1920:1080[bottom];[top][bottom]vstack[v]';
        } else {
            // Horizontal side-by-side (960x1080 per side for 1080p master canvas)
            filterGraph = '[0:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[left];[1:v]scale=960:1080:flags=lanczos:force_original_aspect_ratio=increase,crop=960:1080[right];[left][right]hstack[v]';
        }

        const actualLeft = resolveMediaFilePath(leftVideoPath);
        const actualRight = resolveMediaFilePath(rightVideoPath);
        const actualOutput = path.isAbsolute(outputPath) ? outputPath : path.resolve(process.cwd(), outputPath);

        if (!dryRun) {
            if (!fs.existsSync(actualLeft)) {
                throw new Error(`createSplitScreen: left input video does not exist at "${leftVideoPath}" (resolved: "${actualLeft}")`);
            }
            if (!fs.existsSync(actualRight)) {
                throw new Error(`createSplitScreen: right input video does not exist at "${rightVideoPath}" (resolved: "${actualRight}")`);
            }
        }

        const args = [
            '-y',
            '-i', actualLeft,
            '-i', actualRight,
            '-filter_complex', filterGraph,
            '-map', '[v]',
            '-map', '0:a:0?'
        ];

        if (format === 'webm') {
            args.push(...vp9EncodeArgs(crf || 28), '-pix_fmt', 'yuv420p');
        } else {
            args.push(...h264EncodeArgs('libx264', crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
        }

        args.push(actualOutput);

        const command = `${this.ffmpegBin} ${args.map(a => (a.includes(' ') || a.includes(';') ? `"${a}"` : a)).join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath: actualOutput,
                command,
                commandString: command,
                ffmpegCommand: command,
                commands: [command],
                args
            };
        }

        const outDir = path.dirname(actualOutput);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const execRes = await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        const sizeBytes = fs.existsSync(actualOutput) ? fs.statSync(actualOutput).size : 0;

        return {
            success: true,
            outputPath: actualOutput,
            outputSizeBytes: sizeBytes,
            command,
            commandString: command,
            ffmpegCommand: command,
            commands: [command],
            args,
            stdout: execRes.stdout,
            stderr: execRes.stderr
        };
    }

    /**
     * Normalizes each clip to uniform FPS, audio config, SAR 1, and yuv420p,
     * then executes lossless concat-copy via the FFmpeg concat demuxer.
     */
    async concatClips(opts: ConcatClipsOptions): Promise<VideoEditorJobResult> {
        const {
            targetFps = 30,
            targetAudioRate = 44100,
            targetDimensions = { width: 1920, height: 1080 },
            dryRun = false,
            timeoutMs = 240000
        } = opts;

        const inputPaths = opts.inputPaths || opts.clipPaths || [];
        if (inputPaths.length < 2) {
            throw new Error(`concatClips: inputPaths array must contain at least 2 clips (received ${inputPaths.length})`);
        }

        const outputPath = opts.outputPath;
        const evenW = toEven(targetDimensions.width);
        const evenH = toEven(targetDimensions.height);

        const tempWorkDir = path.join(os.tmpdir(), `scratchbox-concat-${randomUUID()}`);
        const normalizedPaths: string[] = [];
        const executedCommands: string[] = [];

        try {
            if (!dryRun) {
                fs.mkdirSync(tempWorkDir, { recursive: true });
            }

            // Step 1: Normalize each clip to uniform configuration
            for (let i = 0; i < inputPaths.length; i++) {
                const inPath = inputPaths[i];
                const normPath = path.join(tempWorkDir, `clip_${String(i).padStart(3, '0')}_norm.mp4`);
                normalizedPaths.push(normPath);

                const normArgs = [
                    '-y',
                    '-i', inPath,
                    '-f', 'lavfi', '-i', `anullsrc=r=${targetAudioRate}:cl=stereo`,
                    '-shortest',
                    '-vf', `scale=${evenW}:${evenH}:force_original_aspect_ratio=decrease,pad=${evenW}:${evenH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${targetFps},format=yuv420p`,
                    '-c:v', 'libx264', '-preset', DEFAULT_X264_PRESET, '-crf', '20', '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac', '-ar', String(targetAudioRate), '-ac', '2', '-b:a', '128k',
                    '-movflags', '+faststart',
                    normPath
                ];

                executedCommands.push(`${this.ffmpegBin} ${normArgs.join(' ')}`);

                if (!dryRun) {
                    await execFileAsync(this.ffmpegBin, normArgs, { timeout: timeoutMs });
                }
            }

            // Step 2: Concat demuxer
            const concatListPath = path.join(tempWorkDir, 'concat.txt');
            const concatFileContent = normalizedPaths.map(p => `file '${p}'`).join('\n');

            const demuxArgs = [
                '-y',
                '-f', 'concat',
                '-safe', '0',
                '-i', concatListPath,
                '-c', 'copy',
                '-movflags', '+faststart',
                outputPath
            ];

            const demuxCmd = `${this.ffmpegBin} ${demuxArgs.join(' ')}`;
            executedCommands.push(demuxCmd);

            if (dryRun) {
                return {
                    success: true,
                    outputPath,
                    command: executedCommands.join(' && '),
                    commandString: executedCommands.join(' && '),
                    ffmpegCommand: executedCommands.join(' && '),
                    commands: executedCommands,
                    args: demuxArgs
                };
            }

            fs.writeFileSync(concatListPath, concatFileContent, 'utf8');

            const outDir = path.dirname(outputPath);
            if (!fs.existsSync(outDir)) {
                fs.mkdirSync(outDir, { recursive: true });
            }

            await execFileAsync(this.ffmpegBin, demuxArgs, { timeout: timeoutMs });
            const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

            return {
                success: true,
                outputPath,
                outputSizeBytes: sizeBytes,
                command: executedCommands.join(' && '),
                commandString: executedCommands.join(' && '),
                ffmpegCommand: executedCommands.join(' && '),
                commands: executedCommands
            };
        } finally {
            // Clean up temporary work directory
            if (!dryRun && fs.existsSync(tempWorkDir)) {
                try {
                    fs.rmSync(tempWorkDir, { recursive: true, force: true });
                } catch {
                    // Ignore transient cleanup errors
                }
            }
        }
    }

    /**
     * Compiles a video into a single high-resolution contact sheet mosaic grid (`tile` filter)
     * for token-efficient multimodal Gemini Vision inspection.
     */
    async generateStoryboardSheet(opts: StoryboardSheetOptions): Promise<VideoEditorJobResult> {
        const { inputPath, outputPath } = opts;
        if (!inputPath || !outputPath) {
            throw new Error('generateStoryboardSheet: "inputPath" and "outputPath" are required.');
        }

        const columns = opts.columns || 3;
        const rows = opts.rows || 3;
        const totalFrames = opts.totalFrames || (columns * rows);
        const cellWidth = toEven(opts.cellWidth || 640);
        const cellHeight = toEven(opts.cellHeight || 360);
        const padding = opts.padding ?? 4;
        const margin = opts.margin ?? 4;
        const labelTimecode = opts.labelTimecode !== false;
        const dryRun = !!opts.dryRun;
        const timeoutMs = opts.timeoutMs || 60000;

        // The cells are evenly spaced frames: cell k shows the frame at k * duration / totalFrames. Each is its own
        // fast-seeked input (-ss before -i), so ffmpeg seeks to the nine (or N) frames instead of decoding the whole
        // video through an fps filter.
        let durationSec = opts.durationSec;
        if (fs.existsSync(inputPath)) {
            const meta = await this.probeMedia(inputPath, 10000);
            durationSec = meta.durationSec;
        }
        if (!(typeof durationSec === 'number' && durationSec > 0)) {
            throw new Error(fs.existsSync(inputPath)
                ? `generateStoryboardSheet: ffprobe could not measure the length of "${inputPath}"`
                : `generateStoryboardSheet: "${inputPath}" does not exist${dryRun ? ' (a dry run of a missing input needs durationSec)' : ''}`);
        }
        const interval = durationSec / totalFrames;
        const seekTimes = Array.from({ length: totalFrames }, (_, k) => Math.round(k * interval * 1000) / 1000);

        // Timecodes need the drawtext filter, which an ffmpeg built without libfreetype lacks. Then the sheet is made
        // without them and the result says so (timecodeBurnedIn: false, with the reason); nothing else stands in.
        const notes: string[] = [];
        let burnTimecode = labelTimecode;
        if (labelTimecode) {
            const caps = await getFfmpegCapabilities(this.ffmpegBin).catch(() => undefined);
            if (caps && !caps.filters.has('drawtext')) {
                burnTimecode = false;
                notes.push(`timecodes not burnt in: ${this.ffmpegBin} has no drawtext filter (built without libfreetype); cell k is the frame at ${interval.toFixed(3)} * k s`);
            }
        }
        const scaleFilter = `scale=${cellWidth}:${cellHeight}:flags=lanczos:force_original_aspect_ratio=decrease,pad=${cellWidth}:${cellHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
        const timecodeFilter = burnTimecode
            ? `drawtext=text='%{pts\\:hms}':x=10:y=h-24:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.6`
            : '';
        const tileFilter = `tile=${columns}x${rows}:nb_frames=${totalFrames}:padding=${padding}:margin=${margin}:color=black`;

        // setpts puts each cell back at its seek time, so the burnt-in timecode is the frame's time in the video.
        const cellChains = seekTimes.map((t, k) =>
            `[${k}:v:0]trim=end_frame=1,setpts=PTS-STARTPTS+${t}/TB,${[scaleFilter, timecodeFilter].filter(Boolean).join(',')}[c${k}]`);
        const filterComplex = `${cellChains.join(';')};${seekTimes.map((_, k) => `[c${k}]`).join('')}concat=n=${totalFrames}:v=1:a=0,${tileFilter}[sheet]`;

        const args = ['-y', '-hide_banner', '-v', 'error'];
        for (const t of seekTimes) args.push('-ss', String(t), '-i', inputPath);
        args.push('-filter_complex', filterComplex, '-map', '[sheet]', '-frames:v', '1', '-q:v', '2', outputPath);

        const cmdStr = `${this.ffmpegBin} ${args.join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command: cmdStr,
                commandString: cmdStr,
                ffmpegCommand: cmdStr,
                commands: [cmdStr],
                args,
                cellTimesSec: seekTimes,
                timecodeBurnedIn: burnTimecode,
                notes
            };
        }

        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, signal: opts.signal });
        const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

        return {
            success: true,
            outputPath,
            outputSizeBytes: sizeBytes,
            command: cmdStr,
            commandString: cmdStr,
            ffmpegCommand: cmdStr,
            commands: [cmdStr],
            args,
            cellTimesSec: seekTimes,
            timecodeBurnedIn: burnTimecode,
            notes
        };
    }

    /**
     * Applies an industry-standard .cube or .3dl 3D LUT color grade via `lut3d`.
     */
    async applyLutGrade(opts: LutGradeOptions): Promise<VideoEditorJobResult> {
        const { inputPath, lutPath, outputPath } = opts;
        if (!inputPath || !lutPath || !outputPath) {
            throw new Error('applyLutGrade: "inputPath", "lutPath", and "outputPath" are required.');
        }

        const intensity = Math.max(0.0, Math.min(1.0, opts.intensity ?? 1.0));
        const interpolation = opts.interpolation || 'tetrahedral';
        const crf = opts.crf ?? 18;
        const preset = opts.preset || DEFAULT_X264_PRESET;
        const dryRun = !!opts.dryRun;
        const timeoutMs = opts.timeoutMs || 120000;

        let args: string[];
        if (intensity >= 0.999) {
            args = [
                '-y',
                '-i', inputPath,
                '-vf', `lut3d=file='${lutPath}':interp=${interpolation}`,
                '-c:v', 'libx264',
                '-preset', preset,
                '-crf', String(crf),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'copy',
                '-movflags', '+faststart',
                outputPath
            ];
        } else {
            const filterComplex = `[0:v]split[orig][lut];[lut]lut3d=file='${lutPath}':interp=${interpolation}[graded];[orig][graded]blend=all_mode=normal:all_opacity=${intensity.toFixed(2)}[v]`;
            args = [
                '-y',
                '-i', inputPath,
                '-filter_complex', filterComplex,
                '-map', '[v]',
                '-map', '0:a:0?',
                '-c:v', 'libx264',
                '-preset', preset,
                '-crf', String(crf),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'copy',
                '-movflags', '+faststart',
                outputPath
            ];
        }

        const cmdStr = `${this.ffmpegBin} ${args.join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command: cmdStr,
                commandString: cmdStr,
                ffmpegCommand: cmdStr,
                commands: [cmdStr],
                args
            };
        }

        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

        return {
            success: true,
            outputPath,
            outputSizeBytes: sizeBytes,
            command: cmdStr,
            commandString: cmdStr,
            ffmpegCommand: cmdStr,
            commands: [cmdStr],
            args
        };
    }

    /**
     * Executes green or blue screen chroma keying with despill suppression and optional background composite.
     */
    async applyChromaKey(opts: ChromaKeyOptions): Promise<VideoEditorJobResult> {
        const { inputPath, backgroundPath, outputPath } = opts;
        if (!inputPath || !outputPath) {
            throw new Error('applyChromaKey: "inputPath" and "outputPath" are required.');
        }

        const rawColor = opts.keyColor || '0x00FF00';
        const colorToken = rawColor.startsWith('#')
            ? '0x' + rawColor.slice(1)
            : rawColor.toLowerCase() === 'green'
                ? '0x00FF00'
                : rawColor.toLowerCase() === 'blue'
                    ? '0x0000FF'
                    : rawColor;

        const similarity = Math.max(0.01, Math.min(1.0, opts.similarity ?? 0.12));
        const blend = Math.max(0.0, Math.min(0.5, opts.blend ?? 0.08));
        const spillSuppression = opts.spillSuppression !== false;
        const despill = spillSuppression
            ? colorToken.toLowerCase().includes('0000ff') || rawColor.toLowerCase() === 'blue'
                ? ',despill=blue'
                : ',despill=green'
            : '';
        const crf = opts.crf ?? 18;
        const preset = opts.preset || DEFAULT_X264_PRESET;
        const dryRun = !!opts.dryRun;
        const timeoutMs = opts.timeoutMs || 120000;

        let args: string[];
        if (backgroundPath) {
            const filterComplex = `[0:v]chromakey=${colorToken}:${similarity}:${blend}${despill}[keyed];[1:v]scale=1920:1080:flags=lanczos:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2[bg];[bg][keyed]overlay=0:0:shortest=1[v]`;
            args = [
                '-y',
                '-i', inputPath,
                '-i', backgroundPath,
                '-filter_complex', filterComplex,
                '-map', '[v]',
                '-map', '0:a:0?',
                '-c:v', 'libx264',
                '-preset', preset,
                '-crf', String(crf),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'copy',
                '-movflags', '+faststart',
                outputPath
            ];
        } else {
            args = [
                '-y',
                '-i', inputPath,
                '-vf', `chromakey=${colorToken}:${similarity}:${blend}${despill}`,
                '-c:v', 'libx264',
                '-preset', preset,
                '-crf', String(crf),
                '-pix_fmt', 'yuv420p',
                '-c:a', 'copy',
                '-movflags', '+faststart',
                outputPath
            ];
        }

        const cmdStr = `${this.ffmpegBin} ${args.join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command: cmdStr,
                commandString: cmdStr,
                ffmpegCommand: cmdStr,
                commands: [cmdStr],
                args
            };
        }

        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

        return {
            success: true,
            outputPath,
            outputSizeBytes: sizeBytes,
            command: cmdStr,
            commandString: cmdStr,
            ffmpegCommand: cmdStr,
            commands: [cmdStr],
            args
        };
    }

    /**
     * Extracts single-pass video conditioning maps (Sobel edge or height/luminance) for diffusion/ControlNet.
     */
    async generateConditioningMap(opts: ConditioningMapOptions): Promise<VideoEditorJobResult> {
        const { inputPath, outputPath, mapType } = opts;
        if (!inputPath || !outputPath || !mapType) {
            throw new Error('generateConditioningMap: "inputPath", "outputPath", and "mapType" are required.');
        }

        const strength = opts.strength ?? 1.5;
        const threshold = Math.max(0.0, Math.min(1.0, opts.threshold ?? 0.1));
        const invert = !!opts.invert;
        const crf = opts.crf ?? 20;
        const dryRun = !!opts.dryRun;
        const timeoutMs = opts.timeoutMs || 120000;

        let filterChain: string;
        if (mapType === 'edge') {
            const sobelScale = (strength * 2).toFixed(2);
            const lutThreshold = Math.round(threshold * 255);
            filterChain = `format=gray,sobel=scale=${sobelScale},lut=y=val-${lutThreshold}${invert ? ',negate' : ''},format=yuv420p`;
        } else {
            filterChain = `format=gray,lut=y=(val-128)*${strength.toFixed(2)}+128${invert ? ',negate' : ''},format=yuv420p`;
        }

        const args = [
            '-y',
            '-i', inputPath,
            '-vf', filterChain,
            '-c:v', 'libx264',
            '-preset', DEFAULT_X264_PRESET,
            '-crf', String(crf),
            '-pix_fmt', 'yuv420p',
            '-an',
            '-movflags', '+faststart',
            outputPath
        ];

        const cmdStr = `${this.ffmpegBin} ${args.join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command: cmdStr,
                commandString: cmdStr,
                ffmpegCommand: cmdStr,
                commands: [cmdStr],
                args
            };
        }

        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

        return {
            success: true,
            outputPath,
            outputSizeBytes: sizeBytes,
            command: cmdStr,
            commandString: cmdStr,
            ffmpegCommand: cmdStr,
            commands: [cmdStr],
            args
        };
    }

    /**
     * Executes two-pass camera motion stabilization via vidstabdetect and vidstabtransform.
     */
    async stabilizeMotion(opts: MotionStabilizationOptions): Promise<VideoEditorJobResult> {
        const { inputPath, outputPath } = opts;
        if (!inputPath || !outputPath) {
            throw new Error('stabilizeMotion: "inputPath" and "outputPath" are required.');
        }

        const shakiness = Math.max(1, Math.min(10, opts.shakiness ?? 5));
        const accuracy = Math.max(1, Math.min(15, opts.accuracy ?? 10));
        const smoothing = Math.max(1, opts.smoothing ?? 30);
        const zoomPercent = Math.max(0, opts.zoomPercent ?? 0);
        const dryRun = !!opts.dryRun;
        const timeoutMs = opts.timeoutMs || 240000;

        const trfPath = path.join(os.tmpdir(), `scratchbox-vidstab-${randomUUID()}.trf`);

        const pass1Args = [
            '-y',
            '-i', inputPath,
            '-vf', `vidstabdetect=stepsize=6:shakiness=${shakiness}:accuracy=${accuracy}:result=${trfPath}`,
            '-f', 'null',
            '-'
        ];

        const pass2Args = [
            '-y',
            '-i', inputPath,
            '-vf', `vidstabtransform=input=${trfPath}:smoothing=${smoothing}:zoom=${zoomPercent}:optzoom=1`,
            '-c:v', 'libx264',
            '-preset', DEFAULT_X264_PRESET,
            '-crf', '18',
            '-pix_fmt', 'yuv420p',
            '-c:a', 'copy',
            '-movflags', '+faststart',
            outputPath
        ];

        const commands = [
            `${this.ffmpegBin} ${pass1Args.join(' ')}`,
            `${this.ffmpegBin} ${pass2Args.join(' ')}`
        ];
        const combinedCmd = commands.join(' && ');

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command: combinedCmd,
                commandString: combinedCmd,
                ffmpegCommand: combinedCmd,
                commands,
                args: pass2Args
            };
        }

        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        try {
            await execFileAsync(this.ffmpegBin, pass1Args, { timeout: timeoutMs });
            await execFileAsync(this.ffmpegBin, pass2Args, { timeout: timeoutMs });
            const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
            return {
                success: true,
                outputPath,
                outputSizeBytes: sizeBytes,
                command: combinedCmd,
                commandString: combinedCmd,
                ffmpegCommand: combinedCmd,
                commands
            };
        } finally {
            if (fs.existsSync(trfPath)) {
                try { fs.unlinkSync(trfPath); } catch {}
            }
        }
    }

    /**
     * Synthesizes an infinite seamless video loop (ping-pong reflection or temporal crossfade).
     */
    async createSeamlessLoop(opts: SeamlessLoopOptions): Promise<VideoEditorJobResult> {
        const { inputPath, outputPath } = opts;
        if (!inputPath || !outputPath) {
            throw new Error('createSeamlessLoop: "inputPath" and "outputPath" are required.');
        }

        const mode = opts.mode || 'ping_pong';
        const crf = opts.crf ?? 19;
        const dryRun = !!opts.dryRun;
        const timeoutMs = opts.timeoutMs || 120000;

        let args: string[];
        if (mode === 'ping_pong') {
            args = [
                '-y',
                '-i', inputPath,
                '-filter_complex', '[0:v]reverse[rev];[0:v][rev]concat=n=2:v=1:a=0[v]',
                '-map', '[v]',
                '-c:v', 'libx264',
                '-preset', DEFAULT_X264_PRESET,
                '-crf', String(crf),
                '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart',
                outputPath
            ];
        } else {
            let durationSec = 6.0;
            if (!dryRun && fs.existsSync(inputPath)) {
                try {
                    const meta = await this.probeMedia(inputPath, 5000);
                    if (meta.durationSec > 0) durationSec = meta.durationSec;
                } catch {}
            }
            const crossfadeDur = Math.min(opts.crossfadeDurationSec || 1.0, durationSec / 2);
            const headEnd = durationSec - crossfadeDur;

            const filterComplex = `[0:v]split[v1][v2];[v1]trim=start=0:end=${headEnd.toFixed(3)},setpts=PTS-STARTPTS[head];[v2]trim=start=${headEnd.toFixed(3)}:end=${durationSec.toFixed(3)},setpts=PTS-STARTPTS[tail];[tail][head]xfade=transition=fade:duration=${crossfadeDur.toFixed(3)}:offset=0[v]`;
            args = [
                '-y',
                '-i', inputPath,
                '-filter_complex', filterComplex,
                '-map', '[v]',
                '-c:v', 'libx264',
                '-preset', DEFAULT_X264_PRESET,
                '-crf', String(crf),
                '-pix_fmt', 'yuv420p',
                '-movflags', '+faststart',
                outputPath
            ];
        }

        const cmdStr = `${this.ffmpegBin} ${args.join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command: cmdStr,
                commandString: cmdStr,
                ffmpegCommand: cmdStr,
                commands: [cmdStr],
                args
            };
        }

        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

        return {
            success: true,
            outputPath,
            outputSizeBytes: sizeBytes,
            command: cmdStr,
            commandString: cmdStr,
            ffmpegCommand: cmdStr,
            commands: [cmdStr],
            args
        };
    }

    /**
     * Broadcast and streaming audio loudness normalization conforming to EBU R128 (`loudnorm`).
     */
    async normalizeAudioLoudness(opts: AudioLoudnessOptions): Promise<VideoEditorJobResult> {
        const { inputPath, outputPath } = opts;
        if (!inputPath || !outputPath) {
            throw new Error('normalizeAudioLoudness: "inputPath" and "outputPath" are required.');
        }

        const targetLufs = opts.targetLufs ?? -14;
        const loudnessRange = opts.loudnessRange ?? 7;
        const truePeak = opts.truePeak ?? -1.0;
        const dryRun = !!opts.dryRun;
        const timeoutMs = opts.timeoutMs || 120000;

        const args = [
            '-y',
            '-i', inputPath,
            '-af', `loudnorm=I=${targetLufs}:LRA=${loudnessRange}:TP=${truePeak}`,
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-b:a', '192k',
            '-movflags', '+faststart',
            outputPath
        ];

        const cmdStr = `${this.ffmpegBin} ${args.join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command: cmdStr,
                commandString: cmdStr,
                ffmpegCommand: cmdStr,
                commands: [cmdStr],
                args
            };
        }

        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

        return {
            success: true,
            outputPath,
            outputSizeBytes: sizeBytes,
            command: cmdStr,
            commandString: cmdStr,
            ffmpegCommand: cmdStr,
            commands: [cmdStr],
            args
        };
    }

    /**
     * Dynamically ducks background music under a dialogue/voiceover track via sidechain compression.
     */
    async duckAudio(opts: AudioDuckingOptions): Promise<VideoEditorJobResult> {
        const { musicTrackPath, voiceoverTrackPath, outputPath } = opts;
        if (!musicTrackPath || !voiceoverTrackPath || !outputPath) {
            throw new Error('duckAudio: "musicTrackPath", "voiceoverTrackPath", and "outputPath" are required.');
        }

        const threshold = opts.threshold ?? 0.08;
        const ratio = opts.ratio ?? 4;
        const attackMs = opts.attackMs ?? 50;
        const releaseMs = opts.releaseMs ?? 500;
        const musicVolume = opts.musicVolume ?? 0.8;
        const voiceoverVolume = opts.voiceoverVolume ?? 1.0;
        const dryRun = !!opts.dryRun;
        const timeoutMs = opts.timeoutMs || 120000;

        const filterComplex = `[0:a]volume=${musicVolume}[music];[1:a]volume=${voiceoverVolume}[voice];[music][voice]sidechaincompress=threshold=${threshold}:ratio=${ratio}:attack=${attackMs}:release=${releaseMs}[ducked];[ducked][voice]amix=inputs=2:dropout_transition=0[aout]`;

        const args = [
            '-y',
            '-i', musicTrackPath,
            '-i', voiceoverTrackPath,
            '-filter_complex', filterComplex,
            '-map', '[aout]',
            '-c:a', 'aac',
            '-b:a', '192k',
            outputPath
        ];

        const cmdStr = `${this.ffmpegBin} ${args.join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command: cmdStr,
                commandString: cmdStr,
                ffmpegCommand: cmdStr,
                commands: [cmdStr],
                args
            };
        }

        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

        return {
            success: true,
            outputPath,
            outputSizeBytes: sizeBytes,
            command: cmdStr,
            commandString: cmdStr,
            ffmpegCommand: cmdStr,
            commands: [cmdStr],
            args
        };
    }

    /**
     * Ingests numbered image sequences (`frame_%04d.png/jpg`) rendered from 3D viewports into broadcast video.
     */
    async encodeFrameSequence(opts: EncodeFrameSequenceOptions): Promise<VideoEditorJobResult> {
        const { framePattern, outputPath } = opts;
        if (!framePattern || !outputPath) {
            throw new Error('encodeFrameSequence: "framePattern" and "outputPath" are required.');
        }

        const fps = opts.fps || 24;
        const codec = opts.codec || 'h264';
        const crf = opts.crf ?? 18;
        const preset = opts.preset;
        const faststart = opts.faststart !== false;
        const dryRun = !!opts.dryRun;
        const timeoutMs = opts.timeoutMs || 300000;

        const args: string[] = [
            '-y',
            '-framerate', String(fps),
            '-i', framePattern
        ];

        if (opts.audioSourcePath) {
            args.push('-i', opts.audioSourcePath);
            args.push('-map', '0:v', '-map', '1:a?', '-c:a', 'aac', '-b:a', '192k', '-shortest');
        } else {
            args.push('-map', '0:v', '-an');
        }

        if (codec === 'prores') {
            args.push('-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le');
        } else if (codec === 'vp9') {
            args.push(...vp9EncodeArgs(crf), '-pix_fmt', 'yuv420p');
        } else {
            const encoder = await chooseH264Encoder(this.ffmpegBin, preset);
            args.push(...h264EncodeArgs(encoder, crf, preset), '-pix_fmt', 'yuv420p');
        }

        if (faststart && (outputPath.endsWith('.mp4') || outputPath.endsWith('.mov'))) {
            args.push('-movflags', '+faststart');
        }

        args.push(outputPath);

        const cmdStr = `${this.ffmpegBin} ${args.join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command: cmdStr,
                commandString: cmdStr,
                ffmpegCommand: cmdStr,
                commands: [cmdStr],
                args
            };
        }

        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
        const sizeBytes = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;

        return {
            success: true,
            outputPath,
            outputSizeBytes: sizeBytes,
            command: cmdStr,
            commandString: cmdStr,
            ffmpegCommand: cmdStr,
            commands: [cmdStr],
            args
        };
    }
}

