/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * "Render still" beside a path-traced view: one denoised high-sample render of the current camera, saved in the
 * workspace (renders/path-traced/), with what it did shown under the button. Shared by both path-traced viewports.
 */

import * as React from 'react';
import type { PathTraceOverlayHandle } from '../../services/virtual-geometry/path-trace-client';

export interface PathTraceStillButtonProps {
    handle: () => PathTraceOverlayHandle | null;
    /** Width over height of the view the still is taken from. */
    aspect: () => number;
    workspaceRoot?: string;
    name?: string;
    className?: string;
    style?: React.CSSProperties;
}

/** Long side of a still: 4K, the frame's aspect kept. */
const STILL_LONG_SIDE = 3840;
const STILL_SPP = 1024;

export const PathTraceStillButton: React.FC<PathTraceStillButtonProps> = ({ handle, aspect: viewAspect, workspaceRoot, name, className, style }) => {
    const [state, setState] = React.useState<{ kind: 'idle' } | { kind: 'rendering' } | { kind: 'saved'; path: string; seconds: number } | { kind: 'error'; message: string }>({ kind: 'idle' });
    const render = async () => {
        const h = handle();
        if (!h) {
            setState({ kind: 'error', message: 'the path tracer is not open' });
            return;
        }
        setState({ kind: 'rendering' });
        try {
            const a = viewAspect();
            const aspect = Number.isFinite(a) && a > 0 ? a : 16 / 9;
            const width = aspect >= 1 ? STILL_LONG_SIDE : Math.round(STILL_LONG_SIDE * aspect);
            const height = aspect >= 1 ? Math.round(STILL_LONG_SIDE / aspect) : STILL_LONG_SIDE;
            const still = await h.renderStill({ width, height, samplesPerPixel: STILL_SPP, ...(workspaceRoot ? { workspaceRoot } : {}), ...(name ? { name } : {}) });
            setState({ kind: 'saved', path: still.path, seconds: still.stats.renderMs / 1000 });
        } catch (err: any) {
            setState({ kind: 'error', message: err?.message ?? String(err) });
        }
    };
    return (
        <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 2 }}>
            <button
                type="button"
                className={className}
                style={style}
                onClick={() => { void render(); }}
                disabled={state.kind === 'rendering'}
                title={`Render the current view as a ${STILL_LONG_SIDE}-pixel, ${STILL_SPP}-sample denoised still into renders/path-traced/`}
                data-testid="path-trace-still"
            >
                {state.kind === 'rendering' ? 'Rendering still…' : 'Render still'}
            </button>
            {state.kind === 'saved' && (
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.85)', background: 'rgba(0,0,0,0.55)', padding: '2px 6px', borderRadius: 4 }} data-testid="path-trace-still-saved">
                    Saved {state.path} ({state.seconds.toFixed(1)} s on the GPU)
                </span>
            )}
            {state.kind === 'error' && (
                <span style={{ fontSize: 10, color: '#fecaca', background: 'rgba(69,10,10,0.85)', padding: '2px 6px', borderRadius: 4, maxWidth: 320, whiteSpace: 'pre-wrap' }}>
                    {state.message}
                </span>
            )}
        </span>
    );
};
