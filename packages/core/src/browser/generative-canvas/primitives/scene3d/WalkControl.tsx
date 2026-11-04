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
    const fps = stats.frameP50Ms > 0 ? 1000 / stats.frameP50Ms : 0;
    const dim = { color: '#a1a1aa' };
    return (
        <>
            <div
                className="sb-3d-walk-crosshair"
                aria-hidden="true"
                style={{
                    position: 'absolute', left: '50%', top: '50%', zIndex: 30, width: 6, height: 6, margin: '-3px 0 0 -3px', borderRadius: '50%',
                    background: 'rgba(255, 255, 255, 0.85)', boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.45)', pointerEvents: 'none'
                }}
            />
            <div
                data-testid="sb-3d-walk-hud"
                className="sb-3d-walk-hud"
                style={{
                    position: 'absolute', left: '50%', bottom: 64, zIndex: 30, transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', gap: 2, padding: '6px 12px', borderRadius: 10, background: 'rgba(0, 0, 0, 0.72)',
                    border: '1px solid rgba(255, 255, 255, 0.1)', color: '#f4f4f5', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11,
                    lineHeight: 1.35, whiteSpace: 'nowrap', pointerEvents: 'none', userSelect: 'none'
                }}
            >
                <div>
                    <span data-testid="sb-3d-walk-state" style={{ color: '#7dd3fc' }}>{stateLabel(stats)}</span>
                    <span style={dim}> · </span>
                    <span data-testid="sb-3d-walk-speed">{fmt(stats.speed)} m/s</span>
                    <span style={dim}> · frame </span>
                    <span data-testid="sb-3d-walk-frame">
                        {fmt(stats.frameP50Ms)} ms ({fmt(fps, 0)} fps), p95 {fmt(stats.frameP95Ms)}{stats.stalls ? `, ${stats.stalls} stall${stats.stalls > 1 ? 's' : ''}` : ''}
                    </span>
                    <span style={dim}> · walk </span>
                    <span data-testid="sb-3d-walk-cost">{fmt(stats.stepP50Ms, 2)} ms</span>
                </div>
                <div style={{ ...dim, fontSize: 10 }}>
                    WASD / arrows move · Shift run · F {stats.mode === 'walk' ? 'fly' : 'walk'}
                    {stats.mode === 'fly' ? ' · E / Q up and down' : ''} · Esc leave
                    {stats.pointerLocked ? '' : ' · drag or click to look'}
                </div>
            </div>
        </>
    );
}
