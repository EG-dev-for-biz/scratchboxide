/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

/**
 * SMPTE timecode formatters and helpers for NLE monitor, timeline ruler, and status bar.
 */

/**
 * Formats seconds as SMPTE timecode, supporting non-drop-frame (HH:MM:SS:FF) and drop-frame (HH:MM:SS;FF).
 */
export function formatTimecode(seconds: number, fps = 30, dropFrame = false): string {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    let totalFrames = Math.round(safe * fps);

    if (dropFrame && (Math.abs(fps - 29.97) < 0.05 || Math.abs(fps - 59.94) < 0.05)) {
        const dropFrames = Math.round(fps * 0.066666); // 2 for 29.97, 4 for 59.94
        const framesPerMinute = Math.round(60 * fps) - dropFrames;
        const framesPer10Minutes = Math.round(10 * 60 * fps) - (dropFrames * 9);

        const d = Math.floor(totalFrames / framesPer10Minutes);
        const m = totalFrames % framesPer10Minutes;

        if (m > dropFrames) {
            totalFrames += (dropFrames * 9) * d + dropFrames * Math.floor((m - dropFrames) / framesPerMinute);
        } else {
            totalFrames += (dropFrames * 9) * d;
        }
    }

    const intFps = Math.round(fps) || 30;
    const frames = totalFrames % intFps;
    const totalSeconds = Math.floor(totalFrames / intFps);
    const s = totalSeconds % 60;
    const m = Math.floor(totalSeconds / 60) % 60;
    const h = Math.floor(totalSeconds / 3600);

    const pad = (n: number) => n.toString().padStart(2, '0');
    const sep = dropFrame ? ';' : ':';
    return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(frames)}`;
}

/**
 * Compact MM:SS:FF form for compact chrome like ruler ticks and clip badges.
 */
export function formatTimecodeShort(seconds: number, fps = 30): string {
    return formatTimecode(seconds, fps).slice(3);
}

/**
 * Human readable duration (e.g. "12.5s" or "2m 14s").
 */
export function formatDuration(seconds?: number): string {
    if (!seconds || !Number.isFinite(seconds)) return '0.0s';
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s.toString().padStart(2, '0')}s`;
}

/**
 * Parses SMPTE timecode (HH:MM:SS:FF or MM:SS:FF) into seconds.
 */
export function parseTimecode(tc: string, fps = 30): number {
    if (!tc || typeof tc !== 'string') return 0;
    const parts = tc.trim().split(/[:;]/).map(p => parseInt(p, 10));
    if (parts.some(p => isNaN(p))) return 0;

    let h = 0, m = 0, s = 0, f = 0;
    if (parts.length === 4) {
        [h, m, s, f] = parts;
    } else if (parts.length === 3) {
        [m, s, f] = parts;
    } else if (parts.length === 2) {
        [s, f] = parts;
    } else if (parts.length === 1) {
        return parts[0] / fps;
    }

    const totalSeconds = h * 3600 + m * 60 + s + (f / fps);
    return Math.max(0, totalSeconds);
}
