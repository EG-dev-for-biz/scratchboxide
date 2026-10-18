/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import type { Scene3DData } from '../canvas-types';
import {
    VirtualGeometryFetchError,
    VirtualGeometryRenderer,
    type VirtualGeometryShading,
    type VirtualGeometryStats
} from '../services/virtual-geometry/VirtualGeometryRenderer';

export interface VirtualGeometryViewportProps {
    data: Scene3DData;
    /** Workspace root the source GLB path resolves against. */
    workspacePath?: string;
    onUpdate?: (updated: Scene3DData) => void;
}

type Phase = { kind: 'building' } | { kind: 'streaming' } | { kind: 'ready' } | { kind: 'error'; message: string };

const SHADINGS: Array<{ id: VirtualGeometryShading; label: string }> = [
    { id: 'clay', label: 'Clay' },
    { id: 'clusters', label: 'Clusters' },
    { id: 'lod-levels', label: 'LOD levels' }
];

const styles: Record<string, React.CSSProperties> = {
    root: { position: 'relative', width: '100%', height: '100%', flex: 1, minHeight: 0, overflow: 'hidden', background: '#292a2d' },
    canvas: { position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', touchAction: 'none', outline: 'none' },
    toolbar: { position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 },
    chip: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 8px', borderRadius: 6, border: 'none', background: 'rgba(0,0,0,0.55)', color: 'rgba(255,255,255,0.9)', fontSize: 12, cursor: 'pointer' },
    hud: { position: 'absolute', bottom: 12, left: 12, padding: '8px 12px', borderRadius: 6, background: 'rgba(0,0,0,0.6)', color: 'rgba(255,255,255,0.9)', fontSize: 11, lineHeight: '20px', fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' },
    centered: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, color: 'rgba(255,255,255,0.8)', fontSize: 14, pointerEvents: 'none' },
    errorBox: { maxWidth: 520, padding: 16, borderRadius: 6, border: '1px solid rgba(248,113,113,0.5)', background: 'rgba(69,10,10,0.85)', color: '#fee2e2', fontSize: 14, pointerEvents: 'auto' }
};

const fmt = (n: number) => n.toLocaleString();
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * WebGPU virtual geometry viewport for a 3d-scene with `virtualGeometry` set. Builds the source GLB
 * into a .sbvg cluster LOD DAG on the server when needed, streams it, and shows the GPU-measured
 * statistics. There is no fallback renderer: without WebGPU, or when a build fails, it says why.
 */
export const VirtualGeometryViewport: React.FC<VirtualGeometryViewportProps> = ({ data, workspacePath, onUpdate }) => {
    const vg = data.virtualGeometry ?? {};
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const rendererRef = React.useRef<VirtualGeometryRenderer | null>(null);
    const [phase, setPhase] = React.useState<Phase>({ kind: 'streaming' });
    const [stats, setStats] = React.useState<VirtualGeometryStats | null>(null);
    const [threshold, setThreshold] = React.useState(vg.errorThresholdPx ?? 1);
    const [shading, setShading] = React.useState<VirtualGeometryShading>(vg.shading ?? 'clay');
    const latest = React.useRef({ data, onUpdate });
    latest.current = { data, onUpdate };

    // Read by the load effect, which must not re-run when these change.
    const latestThreshold = React.useRef(threshold);
    latestThreshold.current = threshold;
    const latestShading = React.useRef(shading);
    latestShading.current = shading;

    const persist = React.useCallback((patch: NonNullable<Scene3DData['virtualGeometry']>) => {
        const { data: d, onUpdate: update } = latest.current;
        update?.({ ...d, virtualGeometry: { ...d.virtualGeometry, ...patch } });
    }, []);

    // A URL this component just built and persisted must not restart the load it came from.
    const producedUrl = React.useRef<string | null>(null);
    const source = vg.sbvgUrl && vg.sbvgUrl !== producedUrl.current ? `url:${vg.sbvgUrl}` : `glb:${vg.sourceGlbPath ?? ''}`;

    // Build (if needed), create the renderer and stream the file. Re-runs only when the source changes.
    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        let cancelled = false;
        let renderer: VirtualGeometryRenderer | null = null;
        let detachStats: (() => void) | null = null;

        const build = async (): Promise<string> => {
            if (!vg.sourceGlbPath) throw new Error('This scene has no virtual geometry source: set virtualGeometry.sourceGlbPath to a GLB in the workspace.');
            setPhase({ kind: 'building' });
            const res = await fetch('/3d/virtual-geometry/build', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sourceGlbPath: vg.sourceGlbPath, workspaceRoot: workspacePath })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.success) throw new Error(body.error || `Virtual geometry build failed (HTTP ${res.status})`);
            const url = body.sbvgUrl as string;
            if (!cancelled) {
                producedUrl.current = url;
                persist({
                    sbvgUrl: url,
                    ...(body.stats ? {
                        buildStats: {
                            sourceTriangles: body.stats.sourceTriangles,
                            clusterCount: body.stats.clusterCount,
                            levelCount: body.stats.levelCount,
                            fileBytes: body.stats.fileBytes,
                            buildMs: body.buildMs
                        }
                    } : {})
                });
            }
            return url;
        };

        (async () => {
            try {
                let url = source.startsWith('url:') ? source.slice(4) : await build();
                if (cancelled) return;
                setPhase({ kind: 'streaming' });
                renderer = new VirtualGeometryRenderer(canvas, {
                    errorThresholdPx: latestThreshold.current,
                    shading: latestShading.current,
                    doubleSided: vg.doubleSided
                });
                await renderer.initialize();
                if (cancelled) { renderer.dispose(); return; }
                rendererRef.current = renderer;
                detachStats = renderer.onStats(setStats);
                renderer.attachOrbitControls();
                renderer.start();
                try {
                    await renderer.load(url);
                } catch (err) {
                    // A saved file that is gone (cleaned build directory) is rebuilt from its source GLB.
                    if (!(err instanceof VirtualGeometryFetchError && err.status === 404 && source.startsWith('url:') && vg.sourceGlbPath)) throw err;
                    url = await build();
                    if (cancelled) return;
                    setPhase({ kind: 'streaming' });
                    await renderer.load(url);
                }
                if (!cancelled) setPhase({ kind: 'ready' });
            } catch (err: any) {
                if (!cancelled && err?.name !== 'AbortError') setPhase({ kind: 'error', message: err?.message ?? String(err) });
            }
        })();

        return () => {
            cancelled = true;
            detachStats?.();
            renderer?.dispose();
            rendererRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [source, vg.doubleSided, workspacePath]);

    // Keep the drawing buffer at the element's device-pixel size.
    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const fit = () => {
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.max(1, Math.round(canvas.clientWidth * dpr));
            canvas.height = Math.max(1, Math.round(canvas.clientHeight * dpr));
        };
        fit();
        const ro = new ResizeObserver(fit);
        ro.observe(canvas);
        return () => ro.disconnect();
    }, []);

    const changeThreshold = (px: number) => {
        setThreshold(px);
        rendererRef.current?.setErrorThreshold(px);
    };
    const changeShading = (s: VirtualGeometryShading) => {
        setShading(s);
        rendererRef.current?.setShading(s);
        persist({ shading: s });
    };

    return (
        <div className="sb-virtual-geometry" style={styles.root} data-testid="virtual-geometry-viewport">
            <canvas ref={canvasRef} style={styles.canvas} />

            <div style={styles.toolbar}>
                <div className="sb-segmented-control sb-segmented-control-xs">
                    {SHADINGS.map(s => (
                        <button key={s.id} type="button" className={`sb-segment-btn ${shading === s.id ? 'sb-segment-active' : ''}`} onClick={() => changeShading(s.id)}>
                            {s.label}
                        </button>
                    ))}
                </div>
                <label style={styles.chip} title="Allowed screen-space geometric error before finer clusters are drawn">
                    Error
                    <input
                        type="range" min={-2} max={4} step={0.25}
                        value={Math.log2(threshold)}
                        onChange={e => changeThreshold(2 ** Number(e.target.value))}
                        onPointerUp={() => persist({ errorThresholdPx: latestThreshold.current })}
                        aria-label="Screen-space error threshold"
                    />
                    <span style={{ minWidth: 48, fontVariantNumeric: 'tabular-nums' }}>{threshold < 1 ? threshold.toFixed(2) : threshold.toFixed(1)} px</span>
                </label>
                <button type="button" style={styles.chip} onClick={() => rendererRef.current?.frameModel()}>
                    Frame
                </button>
            </div>

            {stats && stats.clusterCount > 0 && (
                <div style={styles.hud} data-testid="virtual-geometry-stats">
                    <div style={{ fontWeight: 600, color: '#fff' }}>WebGPU virtual geometry</div>
                    <div>{stats.adapter}</div>
                    <div>Triangles drawn: {fmt(stats.visibleTriangles)} of {fmt(stats.leafTriangles)} at full detail</div>
                    <div>Clusters drawn: {fmt(stats.visibleClusters)} of {fmt(stats.clusterCount)} · {stats.drawCalls} draw call</div>
                    <div>{stats.fps.toFixed(0)} fps{stats.gpuCullMs !== null ? ` · GPU cull ${stats.gpuCullMs.toFixed(2)} ms · draw ${stats.gpuDrawMs!.toFixed(2)} ms` : ' · GPU timing unavailable on this adapter'}</div>
                    <div>Streamed {stats.loadedLevels}/{stats.levelCount} levels · {mb(stats.bytesReceived)} of {mb(stats.bytesTotal)}</div>
                </div>
            )}

            {phase.kind === 'building' && (
                <div style={styles.centered}>Building cluster LOD hierarchy from {vg.sourceGlbPath}…</div>
            )}
            {phase.kind === 'error' && (
                <div style={styles.centered} role="alert">
                    <div style={styles.errorBox}>
                        <div style={{ fontWeight: 600, marginBottom: 4 }}>Virtual geometry viewport unavailable</div>
                        <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{phase.message}</div>
                    </div>
                </div>
            )}
        </div>
    );
};
