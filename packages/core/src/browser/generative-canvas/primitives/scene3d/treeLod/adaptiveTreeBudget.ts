/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/


/**
 * The tree triangle budget, adapted to the GPU it runs on. The default budget (DEFAULT_TREE_TRIANGLE_BUDGET) was measured on
 * an Apple M1 Ultra; a weaker GPU drawing the same triangles takes longer. The viewport times its own frames on the GPU
 * (EXT_disjoint_timer_query_webgl2, one query per frame, read back a few frames later) and feeds the times here:
 *  - while the smoothed GPU time stays above `targetMs` for `downAfterMs`, the budget scale drops by `downFactor` (and again
 *    after each further `downAfterMs` over), never below `minScale`;
 *  - while it stays below `raiseBelowMs` for `upAfterMs`, the scale rises by `upFactor`, never above 1 (the configured budget);
 *  - in between nothing moves, so a frame time near the target does not make the trees breathe.
 * Without the timer extension nothing is measured and the scale stays 1. Off with `?sbAdaptiveTreeBudget=0` or
 * `localStorage['sb.adaptiveTreeBudget'] = '0'`.
 */

export interface AdaptiveTreeBudgetOptions {
    /** Smoothed GPU frame time (ms) above which the budget comes down. */
    targetMs: number;
    /** Smoothed GPU frame time (ms) below which a lowered budget goes back up. */
    raiseBelowMs: number;
    /** How long (ms) the time must stay over the target before each step down, and under `raiseBelowMs` before each step up. */
    downAfterMs: number;
    upAfterMs: number;
    downFactor: number;
    upFactor: number;
    /** The lowest share of the configured budget it may come down to. */
    minScale: number;
    /** Weight of a new sample in the exponential moving average. */
    smoothing: number;
}

export const DEFAULT_ADAPTIVE_TREE_BUDGET: Readonly<AdaptiveTreeBudgetOptions> = {
    targetMs: 14, raiseBelowMs: 10, downAfterMs: 1000, upAfterMs: 4000, downFactor: 0.85, upFactor: 1.08, minScale: 0.25, smoothing: 0.1
};

export class AdaptiveTreeBudget {
    private readonly o: AdaptiveTreeBudgetOptions;
    private ema: number | undefined;
    private overSince: number | undefined;
    private underSince: number | undefined;
    /** Share of the configured budget in force (minScale..1). */
    scale = 1;
    samples = 0;

    constructor(options: Partial<AdaptiveTreeBudgetOptions> = {}) {
        this.o = { ...DEFAULT_ADAPTIVE_TREE_BUDGET, ...options };
    }

    /** The smoothed GPU frame time (ms), once there is a sample. */
    get smoothedMs(): number | undefined { return this.ema; }

    /** One GPU frame time (ms) measured at `nowMs`. Returns the scale in force. */
    sample(gpuMs: number, nowMs: number): number {
        if (!(gpuMs >= 0) || !Number.isFinite(gpuMs)) return this.scale;
        this.samples++;
        this.ema = this.ema === undefined ? gpuMs : this.ema + this.o.smoothing * (gpuMs - this.ema);
        if (this.ema > this.o.targetMs) {
            this.underSince = undefined;
            this.overSince ??= nowMs;
            if (nowMs - this.overSince >= this.o.downAfterMs && this.scale > this.o.minScale) {
                this.scale = Math.max(this.o.minScale, this.scale * this.o.downFactor);
                this.overSince = nowMs;
            }
        } else if (this.ema < this.o.raiseBelowMs && this.scale < 1) {
            this.overSince = undefined;
            this.underSince ??= nowMs;
            if (nowMs - this.underSince >= this.o.upAfterMs) {
                this.scale = Math.min(1, this.scale * this.o.upFactor);
                this.underSince = nowMs;
            }
        } else {
            this.overSince = undefined; this.underSince = undefined;
        }
        return this.scale;
    }
}

/** Off with `?sbAdaptiveTreeBudget=0` or `localStorage['sb.adaptiveTreeBudget'] = '0'`. */
export function adaptiveTreeBudgetEnabled(): boolean {
    try {
        if (typeof window === 'undefined') return false;
        if (/[?&]sbAdaptiveTreeBudget=0\b/.test(window.location?.search ?? '')) return false;
        if (window.localStorage?.getItem('sb.adaptiveTreeBudget') === '0') return false;
    } catch { /* storage blocked: on */ }
    return true;
}

/**
 * The GPU time target from `localStorage['sb.adaptiveTreeBudgetTargetMs']` (a number of ms; the lower bound for raising back
 * follows at 70 % of it), for trying the adaptation on a fast GPU or tuning it on a slow one.
 */
export function adaptiveTreeBudgetOverrides(): Partial<AdaptiveTreeBudgetOptions> {
    try {
        const v = Number(typeof window !== 'undefined' ? window.localStorage?.getItem('sb.adaptiveTreeBudgetTargetMs') : NaN);
        if (Number.isFinite(v) && v > 0) return { targetMs: v, raiseBelowMs: 0.7 * v };
    } catch { /* storage blocked */ }
    return {};
}

interface TimerQueryExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

/**
 * GPU time of whole frames: `begin()` before the frame's draws, `end()` after; `poll()` returns the times (ms) of the frames
 * whose results have arrived (usually two or three frames later). At most `maxPending` queries are in flight; a frame begun
 * while that many are pending is not timed. Times from a disjoint period (the GPU was switched or reset) are dropped.
 */
export class GpuFrameTimer {
    private readonly ext: TimerQueryExt | null;
    private readonly pending: WebGLQuery[] = [];
    private active: WebGLQuery | null = null;

    constructor(private readonly gl: WebGL2RenderingContext, private readonly maxPending = 4) {
        this.ext = typeof gl.getExtension === 'function' ? gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null : null;
    }

    get available(): boolean { return !!this.ext; }

    begin(): void {
        if (!this.ext || this.active || this.pending.length >= this.maxPending) return;
        const q = this.gl.createQuery();
        if (!q) return;
        this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
        this.active = q;
    }

    end(): void {
        if (!this.ext || !this.active) return;
        this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
        this.pending.push(this.active);
        this.active = null;
    }

    poll(): number[] {
        const out: number[] = [];
        if (!this.ext) return out;
        const disjoint = !!this.gl.getParameter(this.ext.GPU_DISJOINT_EXT);
        while (this.pending.length && this.gl.getQueryParameter(this.pending[0], this.gl.QUERY_RESULT_AVAILABLE)) {
            const q = this.pending.shift()!;
            if (!disjoint) out.push(Number(this.gl.getQueryParameter(q, this.gl.QUERY_RESULT)) / 1e6);
            this.gl.deleteQuery(q);
        }
        return out;
    }

    dispose(): void {
        if (this.active && this.ext) { this.gl.endQuery(this.ext.TIME_ELAPSED_EXT); this.gl.deleteQuery(this.active); this.active = null; }
        for (const q of this.pending.splice(0)) this.gl.deleteQuery(q);
    }
}
