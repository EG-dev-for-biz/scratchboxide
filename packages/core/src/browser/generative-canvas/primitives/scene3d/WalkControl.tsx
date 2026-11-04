/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The walk mode's toolstrip button and its heads-up display (walkMode.ts): the crosshair, what the walker is doing, how
 * fast, and what a frame costs. The display reads the session four times a second, so the viewport itself never
 * re-renders for it.
 */

import * as React from 'react';
import type { WalkFrameStats, WalkSession } from './walkMode';

export const WALK_SHORTCUT_HINT = 'Shift+F';

export function WalkButton({ active, onToggle }: { active: boolean; onToggle: () => void }): React.ReactElement {
    return (
        <button
            type="button"
            data-testid="sb-3d-walk-toggle"
            aria-pressed={active}
            className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
                active
                    ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
            }`}
            onClick={onToggle}
            title={active
                ? 'Leave walk mode (Esc)'
                : `Walk at street level (${WALK_SHORTCUT_HINT}): WASD or arrows to move, Shift to run, F to fly or walk, Esc to leave`}
        >
            <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="13.5" cy="3.5" r="1.8" />
                <path d="M9 21l2.5-6" />
                <path d="M16 21l-1.5-5-3-3 1.2-5" />
                <path d="M7 11.5l2.8-3.2 2.9-.3 2.3 3.3 2.5 1" />
            </svg>
        </button>
    );
}

const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '-');

function stateLabel(s: WalkFrameStats): string {
    if (s.mode === 'fly') return 'Flying';
    if (s.overVoid) return 'Nothing below';
    if (s.falling) return 'Falling';
    if (s.speed < 0.05) return 'Standing';
    return s.running ? 'Running' : 'Walking';
}

export function WalkHud({ session }: { session: () => WalkSession | null }): React.ReactElement | null {
    const [stats, setStats] = React.useState<WalkFrameStats | null>(() => session()?.stats() ?? null);
    React.useEffect(() => {
        const id = window.setInterval(() => setStats(session()?.stats() ?? null), 250);
        return () => window.clearInterval(id);
    }, [session]);
    if (!stats) return null;
    const fps = stats.frameMs > 0 ? 1000 / stats.frameMs : 0;
    return (
        <>
            <div
                className="sb-3d-walk-crosshair absolute left-1/2 top-1/2 z-30 w-1.5 h-1.5 -ml-[3px] -mt-[3px] rounded-full bg-white/85 ring-1 ring-black/40 pointer-events-none"
                aria-hidden="true"
            />
            <div
                data-testid="sb-3d-walk-hud"
                className="sb-3d-walk-hud absolute left-1/2 bottom-4 z-30 -translate-x-1/2 flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl bg-black/70 backdrop-blur-md border border-white/10 text-[11px] font-mono text-zinc-100 shadow-lg pointer-events-none select-none whitespace-nowrap"
            >
                <div>
                    <span data-testid="sb-3d-walk-state" className="text-sky-300">{stateLabel(stats)}</span>
                    <span className="text-zinc-400"> · </span>
                    <span data-testid="sb-3d-walk-speed">{fmt(stats.speed)} m/s</span>
                    <span className="text-zinc-400"> · frame </span>
                    <span data-testid="sb-3d-walk-frame">{fmt(stats.frameMs)} ms ({fmt(fps, 0)} fps, p95 {fmt(stats.frameP95Ms)})</span>
                    <span className="text-zinc-400"> · walk </span>
                    <span data-testid="sb-3d-walk-cost">{fmt(stats.stepMs, 2)} ms</span>
                </div>
                <div className="text-[10px] text-zinc-400">
                    WASD / arrows move · Shift run · F {stats.mode === 'walk' ? 'fly' : 'walk'}
                    {stats.mode === 'fly' ? ' · E / Q up and down' : ''} · Esc leave
                    {stats.pointerLocked ? '' : ' · drag or click to look'}
                </div>
            </div>
        </>
    );
}
