/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

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
        if (!fs.existsSync(inputPath)) {
            throw new Error(`probeMedia: input file does not exist at "${inputPath}"`);
        }

        const sizeBytes = fs.statSync(inputPath).size;

        // 1. Duration
        const durCmd = await execFileAsync(this.ffprobeBin, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            inputPath
        ], { timeout: timeoutMs });
        const durationSec = parseFloat(durCmd.stdout.trim()) || 0;

        // 2. Dimensions
        const dimCmd = await execFileAsync(this.ffprobeBin, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=p=0:s=x',
            inputPath
        ], { timeout: timeoutMs });
        const [rawW, rawH] = dimCmd.stdout.trim().split('x').map(Number);
        const width = rawW || 1920;
        const height = rawH || 1080;

        // 3. Audio Presence
        let hasAudio = false;
        try {
            const audioCmd = await execFileAsync(this.ffprobeBin, [
                '-v', 'error',
                '-select_streams', 'a',
                '-show_entries', 'stream=index',
                '-of', 'csv=p=0',
                inputPath
            ], { timeout: timeoutMs });
            hasAudio = audioCmd.stdout.trim().length > 0;
        } catch {
            hasAudio = false;
        }

        // 4. FPS
        let fps = 30;
        try {
            const fpsCmd = await execFileAsync(this.ffprobeBin, [
                '-v', 'error',
                '-select_streams', 'v:0',
                '-show_entries', 'stream=avg_frame_rate',
                '-of', 'default=noprint_wrappers=1:nokey=1',
                inputPath
            ], { timeout: timeoutMs });
            const [num, den] = fpsCmd.stdout.trim().split('/').map(Number);
            if (num && den) {
                fps = Math.round((num / den) * 100) / 100;
            }
        } catch {
            fps = 30;
        }

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
            preset = 'fast',
            dryRun = false,
            timeoutMs = 120000
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
                args.push('-c:v', 'libvpx-vp9', '-crf', String(crf || 28), '-b:v', '0', '-pix_fmt', 'yuv420p');
            } else {
                // Default mp4 / mov: H.264 high compatibility
                args.push('-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
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

        const execRes = await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
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
            timeoutMs = 60000
        } = opts;

        if (!fs.existsSync(inputPath) && !dryRun) {
            throw new Error(`extractKeyframes: input file does not exist at "${inputPath}"`);
        }

        const targetTimestamps = heroFrameOnly ? [0] : timestampsSec;
        const outDir = outputDir || (outputPathPattern ? path.dirname(outputPathPattern) : path.dirname(inputPath));

        if (!fs.existsSync(outDir) && !dryRun) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const outputPaths: string[] = [];
        const executedCommands: string[] = [];

        for (let i = 0; i < targetTimestamps.length; i++) {
            const ts = targetTimestamps[i];
            let outPath: string;
            if (outputPathPattern && outputPathPattern.includes('%')) {
                outPath = outputPathPattern.replace(/%0?(\d+)d/, (_, width) => String(i).padStart(parseInt(width, 10), '0'));
            } else if (outputPathPattern) {
                outPath = outputPathPattern;
            } else {
                const base = path.basename(inputPath, path.extname(inputPath));
                const tsLabel = String(Math.round(ts * 100)).padStart(4, '0');
                outPath = path.join(outDir, `${base}_keyframe_${i}_${tsLabel}cs.${format}`);
            }

            outputPaths.push(outPath);

            const args = [
                '-y',
                '-ss', String(ts),
                '-i', inputPath,
                '-frames:v', '1',
                '-q:v', '2',
                outPath
            ];

            const cmd = `${this.ffmpegBin} ${args.join(' ')}`;
            executedCommands.push(cmd);

            if (!dryRun) {
                await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs });
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

        const args = [
            '-y',
            '-i', leftVideoPath,
            '-i', rightVideoPath,
            '-filter_complex', filterGraph,
            '-map', '[v]',
            '-map', '0:a:0?'
        ];

        if (format === 'webm') {
            args.push('-c:v', 'libvpx-vp9', '-crf', String(crf || 28), '-b:v', '0', '-pix_fmt', 'yuv420p');
        } else {
            args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-movflags', '+faststart');
        }

        args.push(outputPath);

        const command = `${this.ffmpegBin} ${args.map(a => (a.includes(' ') || a.includes(';') ? `"${a}"` : a)).join(' ')}`;

        if (dryRun) {
            return {
                success: true,
                outputPath,
                command,
                commandString: command,
                ffmpegCommand: command,
                commands: [command],
                args
            };
        }

        const outDir = path.dirname(outputPath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        const execRes = await execFileAsync(this.ffmpegBin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
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
                    '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
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
}
