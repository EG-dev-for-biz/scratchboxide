/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as path from 'path';
import * as fs from 'fs-extra';
import { exec, spawn } from 'child_process';
import { resolveWithinRoot } from '../security/path-guard';
import { MissingInputError } from '../../common/errors/pipeline-errors';
import type {
    VideoTimelineData,
    TimelineElement,
    KeyingParams,
    LayerTransform,
    LightWrapParams,
    GenerativePatchConfig
} from '../../browser/generative-canvas/services/video/videoTypes';

export interface CompositeJobRequest {
    timeline: VideoTimelineData;
    outputPath: string;
    workspaceRoot?: string;
    resolution?: { width: number; height: number };
    format?: 'mp4' | 'mov' | 'webm' | 'gif';
    crf?: number;
    preset?: string;
    dryRun?: boolean;
    customInputs?: Record<string, string>; // map clipId -> local file path
    /**
     * When set, every non-virtual FFmpeg input must be an http(s) URL or a local path that
     * resolves inside this root (symlink-aware); anything else is rejected before spawning.
     */
    inputRoot?: string;
}

/** Protocols FFmpeg may open for media inputs (blocks concat:, subfile:, ftp:, gopher:, etc.). */
export const FFMPEG_INPUT_PROTOCOL_WHITELIST = 'file,http,https,tcp,tls';

/** Coerce caller-supplied numerics so they can never smuggle filtergraph syntax. */
function finiteNumber(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
    return Number.isFinite(n) ? n : fallback;
}

/** A media path the compositor reads as a real input (blob: and data: URLs only exist in the browser). */
function renderablePath(value: unknown): string {
    return typeof value === 'string' && value && !value.startsWith('blob:') && !value.startsWith('data:') ? value : '';
}

/**
 * How long the composite runs: the duration the timeline states, else the end of its last clip that renders (an
 * element of a visible video or overlay track, or of an unmuted audio track with a media path). A timeline that
 * states no duration and has no such clip is refused with MissingInputError; no length is assumed.
 */
export function measureCompositeDuration(timeline: VideoTimelineData, customInputs?: Record<string, string>): number {
    const stated = finiteNumber(timeline?.duration, 0);
    if (stated > 0) return stated;
    let end = 0;
    for (const track of timeline?.tracks || []) {
        const isPicture = track.type === 'video' || track.type === 'overlay';
        if (isPicture ? track.visible === false : track.type !== 'audio' || track.muted) continue;
        for (const el of track.elements || []) {
            if (!isPicture && !renderablePath(customInputs?.[el.id] || el.url)) continue;
            const start = Math.max(0, finiteNumber(el.startTime, 0));
            const duration = finiteNumber(el.duration, 0);
            if (duration > 0) end = Math.max(end, start + duration);
        }
    }
    if (!(end > 0)) {
        throw new MissingInputError('video composite', 'timeline.duration',
            'the timeline states no duration and has no rendered clip with a duration to measure it from');
    }
    return Number(end.toFixed(6));
}

/** Filtergraph link labels may only contain safe identifier characters. */
function safeLabel(id: unknown): string {
    return String(id ?? '').replace(/[^A-Za-z0-9_-]/g, '_') || 'clip';
}

export interface CompositeJobResult {
    success: boolean;
    outputPath: string;
    ffmpegCommand: string;
    filterGraph: string;
    durationSec: number;
    outputSizeBytes?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
    [key: string]: unknown;
}

export class HeadlessVideoCompositorService {
    private ffmpegPath: string = 'ffmpeg';

    constructor(customFfmpegPath?: string) {
        if (customFfmpegPath) {
            this.ffmpegPath = customFfmpegPath;
        }
    }

    /**
     * Checks whether ffmpeg is available in the environment path or configured location.
     */
    async isFfmpegAvailable(): Promise<boolean> {
        return new Promise<boolean>(resolve => {
            exec(`${this.ffmpegPath} -version`, (err) => {
                resolve(!err);
            });
        });
    }

    /**
     * Translates a VideoTimelineData structure into an FFmpeg -filter_complex command string
     * with input arguments and mapping specs.
     */
    buildFilterGraph(
        timeline: VideoTimelineData,
        resolution: { width: number; height: number } = { width: 1920, height: 1080 },
        customInputs?: Record<string, string>
    ): {
        inputs: Array<{ path: string; isVirtual: boolean; duration: number }>;
        filterComplex: string;
        videoOutputTag: string;
        audioOutputTag: string;
        /** The composite's length: the timeline's duration, or the end of its last rendered clip (measureCompositeDuration). */
        durationSec: number;
    } {
        const width = Math.max(2, Math.round(finiteNumber(resolution?.width, 1920)));
        const height = Math.max(2, Math.round(finiteNumber(resolution?.height, 1080)));
        const fps = finiteNumber(timeline.fps, 0) || 30;

        // Gather all video elements ordered by tracks (bottom/background V1 to top overlay)
        const videoTracks = timeline.tracks.filter(t => t.type === 'video' || t.type === 'overlay');
        const audioTracks = timeline.tracks.filter(t => t.type === 'audio');

        const inputs: Array<{ path: string; isVirtual: boolean; duration: number }> = [];
        const filterChains: string[] = [];

        // Base solid background canvas generator: black, for the composite's measured length
        const totalDuration = measureCompositeDuration(timeline, customInputs);
        // Input 0: virtual color background canvas
        inputs.push({
            path: `color=c=black:s=${width}x${height}:r=${fps}:d=${totalDuration}`,
            isVirtual: true,
            duration: totalDuration
        });

        let currentBaseTag = '[0:v]';
        let inputIdx = 1;

        // Process each video track from bottom to top
        for (const track of videoTracks) {
            if (track.visible === false) continue;

            for (const rawEl of track.elements) {
                const elLabel = safeLabel(rawEl.id);
                const el = {
                    ...rawEl,
                    id: elLabel,
                    duration: finiteNumber(rawEl.duration, 0),
                    startTime: finiteNumber(rawEl.startTime, 0)
                } as TimelineElement;
                const clipFilePathRaw = customInputs?.[rawEl.id] || rawEl.url || (rawEl as any).sourceUrl || (rawEl as any).src;
                const clipFilePath = typeof clipFilePathRaw === 'string' ? clipFilePathRaw : '';
                const isVirtualColor = !clipFilePath || clipFilePath.startsWith('blob:') || clipFilePath.startsWith('data:');

                if (isVirtualColor) {
                    // Create a virtual color source if no physical media path is available
                    const hexColor = el.color ? this.mapNamedColorToHex(el.color) : '0x1e293b';
                    inputs.push({
                        path: `color=c=${hexColor}:s=${width}x${height}:r=${fps}:d=${el.duration}`,
                        isVirtual: true,
                        duration: el.duration
                    });
                } else {
                    inputs.push({
                        path: clipFilePath,
                        isVirtual: false,
                        duration: el.duration
                    });
                }

                const rawInputTag = `[${inputIdx}:v]`;
                let lastTag = rawInputTag;
                let stepIdx = 0;

                // 1. Trim / timing filter
                const trimTag = `[v_${el.id}_trim_${stepIdx++}]`;
                filterChains.push(`${lastTag}trim=duration=${el.duration},setpts=PTS-STARTPTS${trimTag}`);
                lastTag = trimTag;

                // 1.5 Generative VFX / Inpainting Patch
                if (el.generativePatch && el.generativePatch.enabled && el.generativePatch.targetBox) {
                    const patch = el.generativePatch;
                    const patchFilePathRaw = customInputs?.[`${rawEl.id}_patch`] || patch.patchUrl;
                    const patchFilePath = typeof patchFilePathRaw === 'string' ? patchFilePathRaw : '';

                    const cropBox = el.generativePatch.targetBox;
                    const cropW = Math.max(2, Math.round(finiteNumber(cropBox.width, 2)));
                    const cropH = Math.max(2, Math.round(finiteNumber(cropBox.height, 2)));
                    const cropX = Math.round(finiteNumber(cropBox.x, 0));
                    const cropY = Math.round(finiteNumber(cropBox.y, 0));

                    inputIdx++;
                    const patchInputIdx = inputIdx;
                    if (patchFilePath && !patchFilePath.startsWith('blob:') && !patchFilePath.startsWith('data:')) {
                        inputs.push({
                            path: patchFilePath,
                            isVirtual: false,
                            duration: el.duration
                        });
                    } else {
                        // Virtual color source for patch placeholder / dry run
                        inputs.push({
                            path: `color=c=gray:s=${cropW}x${cropH}:r=${fps}:d=${el.duration}`,
                            isVirtual: true,
                            duration: el.duration
                        });
                    }

                    const rawPatchTag = `[${patchInputIdx}:v]`;
                    let patchStepIdx = 0;

                    // 1.5.1 Conform FPS and trim patch stream
                    const patchTrimTag = `[v_${el.id}_patch_trim_${patchStepIdx++}]`;
                    filterChains.push(`${rawPatchTag}trim=duration=${el.duration},setpts=PTS-STARTPTS,fps=fps=${fps}${patchTrimTag}`);
                    let currentPatchTag = patchTrimTag;

                    // 1.5.2 Downscale back to native crop dimensions using Lanczos
                    const patchScaledTag = `[v_${el.id}_patch_scale_${patchStepIdx++}]`;
                    filterChains.push(`${currentPatchTag}scale=w=${cropW}:h=${cropH}:flags=lanczos${patchScaledTag}`);
                    currentPatchTag = patchScaledTag;

                    // 1.5.3 Soft feathered alpha edge mask
                    const r = Math.max(1, finiteNumber(patch.featherRadius, 8));
                    const patchFeatherTag = `[v_${el.id}_patch_feather_${patchStepIdx++}]`;
                    const alphaExpr = `min(1,min(min(X/${r},(${cropW}-1-X)/${r}),min(Y/${r},(${cropH}-1-Y)/${r})))*255`;
                    filterChains.push(`${currentPatchTag}format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alphaExpr}'${patchFeatherTag}`);
                    currentPatchTag = patchFeatherTag;

                    // 1.5.4 Film grain matching pass
                    if (patch.matchGrain !== false) {
                        const grainInt = Math.max(1, Math.min(100, finiteNumber(patch.grainIntensity, 12)));
                        const patchGrainedTag = `[v_${el.id}_patch_grain_${patchStepIdx++}]`;
                        filterChains.push(`${currentPatchTag}noise=alls=${grainInt}:allf=t+u${patchGrainedTag}`);
                        currentPatchTag = patchGrainedTag;
                    }

                    // 1.5.5 Composite patch onto clip at (cropX, cropY)
                    const patchedClipTag = `[v_${el.id}_patched_${stepIdx++}]`;
                    filterChains.push(`${lastTag}${currentPatchTag}overlay=x=${cropX}:y=${cropY}:format=auto${patchedClipTag}`);
                    lastTag = patchedClipTag;
                }

                // 2. Chroma keying filter
                if (el.keying && el.keying.enabled) {
                    const keyColorHex = this.normalizeHexColor(el.keying.keyColor || '#00ff00');
                    const similarity = (Math.max(1, Math.min(100, finiteNumber(el.keying.tolerance, 35))) / 100).toFixed(2);
                    const blend = (Math.max(0, Math.min(100, finiteNumber(el.keying.softness, 15))) / 100).toFixed(2);
                    
                    const keyedTag = `[v_${el.id}_keyed_${stepIdx++}]`;
                    filterChains.push(`${lastTag}chromakey=color=${keyColorHex}:similarity=${similarity}:blend=${blend}${keyedTag}`);
                    lastTag = keyedTag;

                    // Despill suppression
                    const despillAmount = finiteNumber(el.keying.despill, 60) / 100;
                    if (despillAmount > 0) {
                        const isBlue = keyColorHex.toLowerCase().includes('0000ff') || keyColorHex.toLowerCase().includes('blue');
                        const despillType = isBlue ? 'blue' : 'green';
                        const despilledTag = `[v_${el.id}_despill_${stepIdx++}]`;
                        filterChains.push(`${lastTag}despill=type=${despillType}:mix=${despillAmount.toFixed(2)}${despilledTag}`);
                        lastTag = despilledTag;
                    }
                }

                // 3. Layer Affine Transform (scale & positioning)
                const scaleX = finiteNumber(el.layerTransform?.scaleX ?? el.scale, 1.0);
                const scaleY = finiteNumber(el.layerTransform?.scaleY ?? el.scale, 1.0);
                const targetW = Math.round(width * scaleX);
                const targetH = Math.round(height * scaleY);

                if (targetW !== width || targetH !== height) {
                    const scaledTag = `[v_${el.id}_scaled_${stepIdx++}]`;
                    filterChains.push(`${lastTag}scale=w=${targetW}:h=${targetH}:flags=lanczos${scaledTag}`);
                    lastTag = scaledTag;
                }

                // 4. Opacity
                const opacity = el.opacity === undefined ? undefined : finiteNumber(el.opacity, 1.0);
                if (opacity !== undefined && opacity < 1.0) {
                    const opacityTag = `[v_${el.id}_alpha_${stepIdx++}]`;
                    filterChains.push(`${lastTag}colorchannelmixer=aa=${opacity.toFixed(2)}${opacityTag}`);
                    lastTag = opacityTag;
                }

                // 5. Overlay onto composite stack
                const posX = finiteNumber(el.layerTransform?.x, 0); // range -1 to 1 relative to half width
                const posY = finiteNumber(el.layerTransform?.y, 0);

                // Center position offset: overlay center = (W - w)/2 + (posX * W / 2)
                const xExpr = `(W-w)/2+(${posX}*W/2)`;
                const yExpr = `(H-h)/2+(${posY}*H/2)`;
                const enableExpr = `between(t,${el.startTime},${el.startTime + el.duration})`;

                const overlayTag = `[v_comp_${inputIdx}]`;
                filterChains.push(`${currentBaseTag}${lastTag}overlay=x='${xExpr}':y='${yExpr}':enable='${enableExpr}':format=auto${overlayTag}`);
                currentBaseTag = overlayTag;

                inputIdx++;
            }
        }

        // Color grade the final master stream if globalGrade or LUT is present
        let finalVideoTag = currentBaseTag;
        if (timeline.globalGrade) {
            const contrast = finiteNumber(timeline.globalGrade.contrast, 0) / 100 + 1.0;
            const saturation = finiteNumber(timeline.globalGrade.saturation, 100) / 100;
            const gradedTag = '[v_master_graded]';
            filterChains.push(`${finalVideoTag}eq=contrast=${contrast.toFixed(2)}:saturation=${saturation.toFixed(2)}${gradedTag}`);
            finalVideoTag = gradedTag;
        }

        // Audio mix
        const audioInputs: string[] = [];
        for (const track of audioTracks) {
            if (track.muted) continue;
            for (const el of track.elements) {
                const audioPath = renderablePath(customInputs?.[el.id] || el.url);
                if (audioPath) {
                    inputs.push({
                        path: audioPath,
                        isVirtual: false,
                        duration: finiteNumber(el.duration, 0)
                    });
                    audioInputs.push(`[${inputIdx++}:a]`);
                }
            }
        }

        let finalAudioTag = '';
        if (audioInputs.length > 0) {
            if (audioInputs.length === 1) {
                finalAudioTag = audioInputs[0];
            } else {
                filterChains.push(`${audioInputs.join('')}amix=inputs=${audioInputs.length}:duration=longest[a_master]`);
                finalAudioTag = '[a_master]';
            }
        }

        return {
            inputs,
            filterComplex: filterChains.join('; '),
            videoOutputTag: finalVideoTag,
            audioOutputTag: finalAudioTag,
            durationSec: totalDuration
        };
    }

    /**
     * Builds full CLI invocation arguments for FFmpeg.
     */
    buildFFmpegArgs(request: CompositeJobRequest): {
        executable: string;
        args: string[];
        commandString: string;
        filterComplex: string;
        durationSec: number;
    } {
        const resolution = request.resolution || { width: 1920, height: 1080 };
        const { inputs, filterComplex, videoOutputTag, audioOutputTag, durationSec } = this.buildFilterGraph(
            request.timeline,
            resolution,
            request.customInputs
        );

        const args: string[] = ['-y'];

        // Add inputs (non-virtual inputs are restricted to file/http(s) protocols)
        for (const inp of inputs) {
            if (inp.isVirtual) {
                args.push('-f', 'lavfi', '-i', inp.path);
            } else {
                args.push('-protocol_whitelist', FFMPEG_INPUT_PROTOCOL_WHITELIST, '-i', this.resolveMediaInput(inp.path, request.inputRoot));
            }
        }

        // Filter complex
        args.push('-filter_complex', filterComplex);
        args.push('-map', videoOutputTag);

        if (audioOutputTag) {
            args.push('-map', audioOutputTag);
            args.push('-c:a', 'aac', '-b:a', '192k');
        }

        // Codec & Quality
        const format = request.format || 'mp4';
        const crf = Math.round(finiteNumber(request.crf, 20));
        const preset = typeof request.preset === 'string' && /^[a-z]+$/.test(request.preset) ? request.preset : 'medium';

        if (format === 'mp4' || format === 'mov') {
            args.push('-c:v', 'libx264', '-crf', crf.toString(), '-preset', preset, '-pix_fmt', 'yuv420p');
        } else if (format === 'webm') {
            args.push('-c:v', 'libvpx-vp9', '-crf', crf.toString(), '-b:v', '0', '-pix_fmt', 'yuv420p');
        } else if (format === 'gif') {
            args.push('-f', 'gif');
        }

        args.push('-t', durationSec.toString());
        args.push(request.outputPath);

        const commandString = `${this.ffmpegPath} ${args.map(a => a.includes(' ') || a.includes(';') || a.includes('=') ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ')}`;

        return {
            executable: this.ffmpegPath,
            args,
            commandString,
            filterComplex,
            durationSec
        };
    }

    /**
     * Executes the headless composite job via FFmpeg subprocess. A timeline whose length cannot be measured rejects
     * with MissingInputError before FFmpeg runs.
     */
    async execute(request: CompositeJobRequest): Promise<CompositeJobResult> {
        const { executable, args, commandString, filterComplex, durationSec } = this.buildFFmpegArgs(request);

        if (request.dryRun) {
            return {
                success: true,
                outputPath: request.outputPath,
                ffmpegCommand: commandString,
                filterGraph: filterComplex,
                durationSec
            };
        }

        // Ensure output directory exists
        await fs.ensureDir(path.dirname(request.outputPath));

        return new Promise<CompositeJobResult>((resolve) => {
            const child = spawn(executable, args);
            let stdout = '';
            let stderr = '';

            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });

            child.on('close', async (code) => {
                if (code === 0 && (await fs.pathExists(request.outputPath))) {
                    const stats = await fs.stat(request.outputPath);
                    resolve({
                        success: true,
                        outputPath: request.outputPath,
                        ffmpegCommand: commandString,
                        filterGraph: filterComplex,
                        durationSec,
                        outputSizeBytes: stats.size,
                        stdout,
                        stderr
                    });
                } else {
                    resolve({
                        success: false,
                        outputPath: request.outputPath,
                        ffmpegCommand: commandString,
                        filterGraph: filterComplex,
                        durationSec,
                        stdout,
                        stderr,
                        error: `FFmpeg process exited with code ${code}: ${stderr.slice(-500)}`
                    });
                }
            });

            child.on('error', (err) => {
                resolve({
                    success: false,
                    outputPath: request.outputPath,
                    ffmpegCommand: commandString,
                    filterGraph: filterComplex,
                    durationSec,
                    stdout,
                    stderr,
                    error: `Failed to spawn FFmpeg: ${err.message}`
                });
            });
        });
    }

    /**
     * Validates a non-virtual media input. http(s) URLs pass through; when `inputRoot` is set,
     * any other value must be a local path confined to that root (returned as an explicit
     * `file:` URL so FFmpeg cannot reinterpret it as another protocol).
     */
    private resolveMediaInput(inputPath: string, inputRoot?: string): string {
        if (/^https?:\/\//i.test(inputPath)) {
            return inputPath;
        }
        if (!inputRoot) {
            return inputPath;
        }
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(inputPath) && !/^file:/i.test(inputPath) && !/^[A-Za-z]:[\\/]/.test(inputPath)) {
            throw Object.assign(new Error(`Unsupported media input protocol: ${inputPath.split(':')[0]}`), { code: 'invalid_media_input' });
        }
        const localPath = inputPath.replace(/^file:(\/\/)?/i, '');
        return `file:${resolveWithinRoot(inputRoot, localPath)}`;
    }

    private normalizeHexColor(hex: string): string {
        const clean = String(hex ?? '').replace('#', '').trim();
        if (!/^[0-9A-Fa-f]+$/.test(clean)) {
            return '0x00FF00';
        }
        if (clean.length === 6) {
            return `0x${clean.toUpperCase()}`;
        }
        if (clean.length === 3) {
            const expanded = clean.split('').map(c => c + c).join('');
            return `0x${expanded.toUpperCase()}`;
        }
        return '0x00FF00';
    }

    private mapNamedColorToHex(color: string): string {
        switch (String(color).toLowerCase()) {
            case 'emerald':
            case 'green':
                return '0x10b981';
            case 'blue':
                return '0x3b82f6';
            case 'purple':
                return '0x8b5cf6';
            case 'amber':
                return '0xf59e0b';
            case 'rose':
            case 'red':
                return '0xf43f5e';
            case 'cyan':
                return '0x06b6d4';
            default:
                return '0x334155';
        }
    }
}
