/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { StudioLayoutMode } from '../canvas-types';

/**
 * Jitter-Free RAF Token Buffer Queue for 60fps adaptive streaming.
 * Absorbs bursts of SSE chunks and drains tokens with natural cognitive pacing.
 */
export class StreamBufferQueue {
    private queue: string[] = [];
    private displayed = '';
    private rafId: number | null = null;
    private isClosed = false;
    private onToken: (text: string) => void;
    private onDone?: () => void;
    private lastFrameTime = 0;
    private minFrameIntervalMs = 16; // ~60fps target

    constructor(onToken: (text: string) => void, onDone?: () => void) {
        this.onToken = onToken;
        this.onDone = onDone;
    }

    push(chunk: string) {
        if (!chunk) return;
        const tokens = chunk.split(/(\s+)/);
        for (const t of tokens) {
            if (t) this.queue.push(t);
        }
        if (this.rafId === null && typeof window !== 'undefined') {
            this.lastFrameTime = performance.now();
            this.rafId = requestAnimationFrame(this.step);
        }
    }

    close() {
        this.isClosed = true;
        if (this.queue.length === 0 && this.rafId === null) {
            this.onDone?.();
        }
    }

    cancel() {
        if (this.rafId !== null && typeof window !== 'undefined') {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        this.queue = [];
        this.isClosed = true;
    }

    private step = (timestamp: number) => {
        if (timestamp - this.lastFrameTime >= this.minFrameIntervalMs) {
            this.lastFrameTime = timestamp;
            if (this.queue.length > 0) {
                const batchSize = this.queue.length > 100 ? 8 : this.queue.length > 40 ? 4 : this.queue.length > 15 ? 2 : 1;
                for (let i = 0; i < batchSize && this.queue.length > 0; i++) {
                    this.displayed += this.queue.shift()!;
                }
                this.onToken(this.displayed);
            }
        }

        if (this.queue.length > 0 && typeof window !== 'undefined') {
            this.rafId = requestAnimationFrame(this.step);
        } else if (this.isClosed) {
            this.rafId = null;
            this.onDone?.();
        } else {
            this.rafId = null;
        }
    };
}

/**
 * Smooth Token Stream Ticker for local responsiveness (15-25ms per token).
 * Emits word/whitespace tokens with 60fps pacing.
 */
export function streamTokensAsync(
    fullText: string,
    onToken: (streamedText: string) => void,
    onProgress?: (progressFraction: number) => void,
    intervalMs = 18
): Promise<void> {
    return new Promise(resolve => {
        if (!fullText) {
            resolve();
            return;
        }

        const tokens = fullText.split(/(\s+)/);
        let accumulated = '';
        let idx = 0;

        const timer = setInterval(() => {
            if (idx < tokens.length) {
                accumulated += tokens[idx];
                idx++;
                onToken(accumulated);
                if (onProgress) {
                    onProgress(idx / tokens.length);
                }
            } else {
                clearInterval(timer);
                resolve();
            }
        }, intervalMs);
    });
}

/**
 * A frame of the active studio canvas (3D viewport, code sandbox or browser stage) as a PNG data URL, taken by the
 * capture function the mounted primitive registered. Null when none is mounted or it cannot read its canvas: no
 * other canvas on the page and no placeholder image stands in for it.
 */
export function captureActiveCanvasScreenshot(targetLayoutMode?: StudioLayoutMode): string | null {
    if (typeof window === 'undefined') return null;
    const registered: Array<[boolean, string]> = [
        [targetLayoutMode === '3d' || !targetLayoutMode, '__scratchbox_capture_active_3d_scene'],
        [targetLayoutMode === 'code' || !targetLayoutMode, '__scratchbox_capture_active_sandbox'],
        [targetLayoutMode === 'browser' || !targetLayoutMode, '__scratchbox_capture_active_browser']
    ];
    for (const [applies, key] of registered) {
        const capture = (window as any)[key];
        if (!applies || typeof capture !== 'function') continue;
        try {
            const frame = capture();
            if (typeof frame === 'string' && frame.startsWith('data:image/')) return frame;
        } catch {
            // That primitive could not read its canvas (lost context, cross-origin); try the next registered one.
        }
    }
    return null;
}
