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
 * Global utility to capture a visual screenshot snapshot frame of the currently active studio canvas.
 */
export function captureActiveCanvasScreenshot(targetLayoutMode?: StudioLayoutMode): string {
    if (typeof window !== 'undefined') {
        if (targetLayoutMode === '3d' || !targetLayoutMode) {
            const capture3D = (window as any).__scratchbox_capture_active_3d_scene;
            if (typeof capture3D === 'function') {
                try {
                    const res = capture3D();
                    if (res && res.length > 22) return res;
                } catch (e) {
                    // ignore
                }
            }
        }
        if (targetLayoutMode === 'code' || !targetLayoutMode) {
            const captureSandbox = (window as any).__scratchbox_capture_active_sandbox;
            if (typeof captureSandbox === 'function') {
                try {
                    const res = captureSandbox();
                    if (res && res.length > 22) return res;
                } catch (e) {
                    // ignore
                }
            }
        }
        if (targetLayoutMode === 'browser' || !targetLayoutMode) {
            const captureBrowser = (window as any).__scratchbox_capture_active_browser;
            if (typeof captureBrowser === 'function') {
                try {
                    const res = captureBrowser();
                    if (res && res.length > 22) return res;
                } catch (e) {
                    // ignore
                }
            }
        }

        const canvas = document.querySelector('.sb-3d-stage-wrapper canvas, .sb-ide-iframe-wrapper canvas, .sb-browser-stage-wrapper canvas, canvas') as HTMLCanvasElement;
        if (canvas && typeof canvas.toDataURL === 'function') {
            try {
                const res = canvas.toDataURL('image/png');
                if (res && res.length > 22) return res;
            } catch (e) {
                // ignore
            }
        }
    }

    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
}
