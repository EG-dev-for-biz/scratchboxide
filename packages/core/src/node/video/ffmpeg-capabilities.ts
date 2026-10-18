/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What the installed ffmpeg can do, measured once per binary and cached, and the encoder arguments built on it.
 *
 * H.264: libx264 at preset `veryfast` unless the caller names a preset. On macOS, when (and only when) the
 * capability check proves h264_videotoolbox works — it is listed in `ffmpeg -encoders` AND a one-frame test encode
 * with the same flags succeeds — an unpinned encode uses the hardware encoder instead. The choice is made before
 * the encode, never by retrying a failed one, and the encoder is named in the command the caller reports.
 * `SCRATCHBOX_H264_ENCODER=libx264` turns the hardware path off.
 *
 * VP9: libvpx-vp9 with row multithreading and the `good` deadline at cpu-used 4 (several times faster than the
 * single-threaded default at a small size cost).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const DEFAULT_X264_PRESET = 'veryfast';
export const VP9_SPEED_ARGS: readonly string[] = ['-row-mt', '1', '-deadline', 'good', '-cpu-used', '4'];

export type H264Encoder = 'libx264' | 'h264_videotoolbox';

export interface FfmpegCapabilities {
    binary: string;
    /** First line of `ffmpeg -version`. */
    version: string;
    encoders: Set<string>;
    /** Filter names from `ffmpeg -filters` (empty when the list could not be read). */
    filters: Set<string>;
    /** h264_videotoolbox is listed and a test encode with it succeeded. */
    h264VideoToolbox: boolean;
    /** Why the hardware encoder is or is not used. */
    h264VideoToolboxNote: string;
}

const cache = new Map<string, Promise<FfmpegCapabilities>>();

/** VideoToolbox constant-quality value (1..100, higher is better) for an x264-style CRF. */
export function videoToolboxQualityForCrf(crf: number): number {
    return Math.max(1, Math.min(100, Math.round(100 - 1.75 * crf)));
}

async function measure(binary: string): Promise<FfmpegCapabilities> {
    const versionOut = await execFileAsync(binary, ['-hide_banner', '-version'], { timeout: 10_000 });
    const version = versionOut.stdout.split('\n')[0]?.trim() ?? '';
    const encoders = new Set<string>();
    try {
        const encOut = await execFileAsync(binary, ['-hide_banner', '-encoders'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
        for (const line of encOut.stdout.split('\n')) {
            const m = /^\s*[VAS][.A-Z]{5}\s+(\S+)/.exec(line);
            if (m) encoders.add(m[1]);
        }
    } catch {
        // No encoder list: nothing is assumed to be available beyond what the encode itself reports.
    }
    const filters = new Set<string>();
    try {
        const filOut = await execFileAsync(binary, ['-hide_banner', '-filters'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
        for (const line of filOut.stdout.split('\n')) {
            const m = /^\s*[TSC.]{2,3}\s+(\S+)\s+\S*->\S*/.exec(line);
            if (m) filters.add(m[1]);
        }
    } catch {
        // No filter list: callers that need a filter treat it as missing.
    }
    let h264VideoToolbox = false;
    let note: string;
    if (process.env.SCRATCHBOX_H264_ENCODER === 'libx264') {
        note = 'SCRATCHBOX_H264_ENCODER=libx264 disables h264_videotoolbox';
    } else if (process.platform !== 'darwin') {
        note = `h264_videotoolbox is macOS only (platform ${process.platform})`;
    } else if (!encoders.has('h264_videotoolbox')) {
        note = `${binary} does not list h264_videotoolbox`;
    } else {
        try {
            await execFileAsync(binary, [
                '-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=128x128:d=0.2', '-frames:v', '2',
                '-c:v', 'h264_videotoolbox', '-q:v', '60', '-pix_fmt', 'yuv420p', '-f', 'null', '-'
            ], { timeout: 15_000 });
            h264VideoToolbox = true;
            note = 'h264_videotoolbox passed a test encode';
        } catch (e: any) {
            note = `h264_videotoolbox is listed but its test encode failed: ${String(e?.stderr || e?.message || e).trim().slice(0, 300)}`;
        }
    }
    return { binary, version, encoders, filters, h264VideoToolbox, h264VideoToolboxNote: note };
}

/** Measured once per binary; a failed measurement (e.g. no ffmpeg) is not cached, so installing it is picked up. */
export function getFfmpegCapabilities(binary: string): Promise<FfmpegCapabilities> {
    let p = cache.get(binary);
    if (!p) {
        p = measure(binary);
        cache.set(binary, p);
        p.catch(() => cache.delete(binary));
    }
    return p;
}

/** Test hook. */
export function clearFfmpegCapabilityCache(): void {
    cache.clear();
}

/**
 * The H.264 encoder for an encode. A caller-named x264 preset pins libx264; otherwise the hardware encoder is used
 * when the capability check proved it works. When ffmpeg cannot be measured, libx264 is chosen and the encode
 * itself reports ffmpeg's error.
 */
export async function chooseH264Encoder(binary: string, explicitPreset?: string): Promise<H264Encoder> {
    if (explicitPreset) return 'libx264';
    try {
        return (await getFfmpegCapabilities(binary)).h264VideoToolbox ? 'h264_videotoolbox' : 'libx264';
    } catch {
        return 'libx264';
    }
}

/** `-c:v ...` arguments for an H.264 encode (without -pix_fmt / -movflags). */
export function h264EncodeArgs(encoder: H264Encoder, crf: number, preset?: string): string[] {
    if (encoder === 'h264_videotoolbox') {
        return ['-c:v', 'h264_videotoolbox', '-q:v', String(videoToolboxQualityForCrf(crf))];
    }
    return ['-c:v', 'libx264', '-preset', preset || DEFAULT_X264_PRESET, '-crf', String(crf)];
}

/** `-c:v libvpx-vp9 ...` arguments (without -pix_fmt). */
export function vp9EncodeArgs(crf: number): string[] {
    return ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', ...VP9_SPEED_ARGS];
}
