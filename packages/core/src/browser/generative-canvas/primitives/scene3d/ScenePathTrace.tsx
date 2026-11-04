/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport's path-traced view: a toolstrip toggle, and a layer over the viewport that captures what the
 * viewport shows (pathTraceSnapshot.ts), has the server build it for the Metal path tracer, and draws the
 * progressive frames as the camera moves, with a HUD, "Re-capture" (after the scene changed) and "Render still".
 * macOS with a ray tracing GPU only: anywhere else the server's reason is shown, and the viewport is unchanged.
 */

import * as React from 'react';
import type * as THREE from 'three';
import { startPathTraceOverlay, type PathTraceOverlayHandle, type PathTraceStatus } from '../../services/virtual-geometry/path-trace-client';
import { PathTraceStillButton } from './PathTraceStillButton';
import { pathTraceLightingOf, pathTraceViewOf, snapshotSceneForPathTrace, type PathTraceSnapshotStats } from './pathTraceSnapshot';

export function ScenePathTraceButton({ active, onToggle }: { active: boolean; onToggle: () => void }): React.ReactElement {
    return (
        <button
            type="button"
            className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${active ? 'sb-3d-toolstrip-btn-active' : ''}`}
            onClick={onToggle}
            title="Path traced: the scene as the Metal path tracer lights it (macOS)"
            aria-label="Path traced"
            aria-pressed={active}
            data-testid="scene-path-trace-toggle"
        >
            <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l2.5 2.5M16.5 16.5L19 19M5 19l2.5-2.5M16.5 7.5L19 5" />
            </svg>
        </button>
    );
}

export interface ScenePathTraceLayerProps {
    active: boolean;
    scene: () => THREE.Scene | null;
    camera: () => THREE.PerspectiveCamera | null;
    /** Objects drawn over the scene that are not part of it (gizmos, brush cursor, selection box). */
    exclude: () => Array<THREE.Object3D | null | undefined>;
    title?: string;
    /** True while a path-traced frame covers the viewport, so the viewport may stop drawing its own. */
    onShowing: (showing: boolean) => void;
    targetSpp?: number;
}

const hud: React.CSSProperties = {
    position: 'absolute', left: 12, bottom: 12, zIndex: 31, padding: '8px 12px', borderRadius: 6, background: 'rgba(0,0,0,0.65)',
    color: 'rgba(255,255,255,0.92)', fontSize: 11, lineHeight: '18px', fontVariantNumeric: 'tabular-nums', maxWidth: 520
};
const chip: React.CSSProperties = {
    padding: '3px 8px', borderRadius: 5, border: 'none', background: 'rgba(255,255,255,0.14)', color: '#fff', fontSize: 11, cursor: 'pointer'
};
const fmt = (n: number) => n.toLocaleString();

function skippedNote(s: PathTraceSnapshotStats): string {
    const parts: string[] = [];
    if (s.skipped.points) parts.push(`${s.skipped.points} point/sprite object${s.skipped.points === 1 ? '' : 's'} (splats)`);
    if (s.skipped.lines) parts.push(`${s.skipped.lines} line object${s.skipped.lines === 1 ? '' : 's'}`);
    if (s.skipped.shaderMaterials) parts.push(`${s.skipped.shaderMaterials} mesh${s.skipped.shaderMaterials === 1 ? '' : 'es'} with custom shaders`);
    if (s.skipped.instancesOverCap) parts.push(`${fmt(s.skipped.instancesOverCap)} instances past the 30M-triangle cap`);
    return parts.length ? `Not traced: ${parts.join(', ')}.` : '';
}

export function ScenePathTraceLayer({ active, scene, camera, exclude, title, onShowing, targetSpp = 256 }: ScenePathTraceLayerProps): React.ReactElement | null {
    const overlayRef = React.useRef<HTMLCanvasElement | null>(null);
    const handleRef = React.useRef<PathTraceOverlayHandle | null>(null);
    const [capture, setCapture] = React.useState(0);
    const [stage, setStage] = React.useState<string | null>(null);
    const [error, setError] = React.useState<string | null>(null);
    const [snapshot, setSnapshot] = React.useState<{ stats: PathTraceSnapshotStats; cached: boolean; lighting: string; at: Date } | null>(null);
    const [status, setStatus] = React.useState<PathTraceStatus | null>(null);
    const latest = React.useRef({ scene, camera, exclude, onShowing });
    latest.current = { scene, camera, exclude, onShowing };

    React.useEffect(() => {
        const overlay = overlayRef.current;
        if (!active || !overlay) return;
        let cancelled = false;
        let handle: PathTraceOverlayHandle | null = null;
        setError(null);
        setStatus(null);
        setSnapshot(null);
        (async () => {
            try {
                const s = latest.current.scene();
                if (!s || !latest.current.camera()) throw new Error('the viewport has no scene to trace yet');
                setStage('Capturing the scene…');
                const snap = await snapshotSceneForPathTrace(s, latest.current.exclude());
                if (cancelled) return;
                if (snap.stats.meshes === 0) throw new Error(`nothing in the viewport can be path traced. ${skippedNote(snap.stats)}`.trim());
                setStage(`Building ${fmt(snap.stats.triangles)} triangles for the path tracer…`);
                const res = await fetch('/3d/path-trace/snapshot', { method: 'POST', headers: { 'Content-Type': 'model/gltf-binary' }, body: snap.glb });
                const built = await res.json().catch(() => ({}));
                if (!res.ok || !built.success) throw new Error(built.error || `snapshot failed (HTTP ${res.status})`);
                if (cancelled) return;
                const lighting = pathTraceLightingOf(s);
                setSnapshot({
                    stats: snap.stats, cached: !!built.cached, at: new Date(),
                    lighting: 'sun' in lighting ? `sun ${lighting.sun.elevationDeg.toFixed(0)}° up, azimuth ${lighting.sun.azimuthDeg.toFixed(0)}°` : 'studio dome'
                });
                setStage(null);
                const origin = built.origin as [number, number, number];
                handle = startPathTraceOverlay({
                    overlay,
                    open: { sbvgUrl: built.sbvgUrl, snapshotId: built.snapshotId, lighting },
                    getView: () => {
                        const cam = latest.current.camera();
                        return cam ? pathTraceViewOf(cam, origin) : null;
                    },
                    targetSpp,
                    onStatus: st => {
                        if (cancelled) return;
                        setStatus(st);
                        if (st.spp > 0) latest.current.onShowing(true);
                    }
                });
                handleRef.current = handle;
            } catch (err: any) {
                if (!cancelled) {
                    setStage(null);
                    setError(err?.message ?? String(err));
                }
            }
        })();
        return () => {
            cancelled = true;
            handle?.stop();
            handleRef.current = null;
            latest.current.onShowing(false);
        };
    }, [active, capture, targetSpp]);

    if (!active) return null;
    const showingFrame = !!status && status.spp > 0;
    return (
        <>
            <canvas
                ref={overlayRef}
                data-testid="path-trace-overlay"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none', zIndex: 30, visibility: showingFrame ? 'visible' : 'hidden' }}
            />
            <div style={hud} data-testid="scene-path-trace-hud">
                <div style={{ fontWeight: 600, color: '#fff' }}>Metal path tracer{status?.device ? ` · ${status.device}` : ''}</div>
                {stage && <div>{stage}</div>}
                {error && <div style={{ color: '#fcd34d', whiteSpace: 'pre-wrap' }}>{error}</div>}
                {status?.message && <div style={{ color: '#fcd34d', whiteSpace: 'pre-wrap' }}>{status.message}</div>}
                {status && !status.message && (
                    <>
                        <div>
                            {status.spp} of {status.targetSpp} spp · {status.width}×{status.height}
                            {status.renderWidth > 0 && (status.renderWidth !== status.width || status.renderHeight !== status.height) ? ` (traced at ${status.renderWidth}×${status.renderHeight}, MetalFX)` : ''}
                            {status.gpuMs > 0 ? ` · ${(status.rays / status.gpuMs / 1000).toFixed(1)} M rays/s` : ''}
                        </div>
                        <div>Cut: {fmt(status.triangles)} triangles · {status.materials}{status.denoised ? ' · denoised' : ''}</div>
                    </>
                )}
                {snapshot && (
                    <div style={{ color: 'rgba(255,255,255,0.75)' }}>
                        Scene captured {snapshot.at.toLocaleTimeString()}: {fmt(snapshot.stats.meshes)} meshes, {fmt(snapshot.stats.triangles)} triangles
                        {snapshot.stats.instancesExpanded ? ` (${fmt(snapshot.stats.instancesExpanded)} instances)` : ''}, {(snapshot.stats.bytes / 1048576).toFixed(1)} MB
                        {snapshot.cached ? ', build reused' : ''} · {snapshot.lighting}. {skippedNote(snapshot.stats)}
                    </div>
                )}
                <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'flex-start' }}>
                    <button type="button" className="sb-path-trace-recapture" style={chip} onClick={() => setCapture(c => c + 1)} title="Capture the scene again after it changed" data-testid="scene-path-trace-recapture">
                        Re-capture
                    </button>
                    {showingFrame && (
                        <PathTraceStillButton
                            handle={() => handleRef.current}
                            aspect={() => (overlayRef.current && overlayRef.current.clientHeight > 0 ? overlayRef.current.clientWidth / overlayRef.current.clientHeight : NaN)}
                            {...(title ? { name: title } : {})}
                            style={chip}
                        />
                    )}
                </div>
            </div>
        </>
    );
}
