/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as React from 'react';
import type { SceneContentKind } from './types';
import type { GeneratorRunError } from './generatorRun';

export interface ViewportNoticeEntry {
    kind: 'webgl-error' | 'generator-error' | 'tiles-error' | 'object-load-error' | 'reconnecting' | 'undrawable-objects' | 'optics' | 'focus' | 'empty' | 'asset-recovery' | 'beautify-error';
    title: string;
    detail?: string;
    /** 0..1 of a running step, when known. */
    fraction?: number;
    /** A button under the detail (Cancel on a running recovery). */
    action?: { label: string; onClick: () => void };
}

/** A recovery of files that failed to load (asset-recovery-client.ts), running or just ended. */
export interface ViewportRecoveryNotice {
    running: boolean;
    message: string;
    fraction?: number;
    files: number;
    onCancel: () => void;
    /** Why files could not be recovered, one line per distinct reason with its count (a finished job). */
    reasons?: string[];
    /** Offered when the scene knows its place: rebuild the lost files from it. */
    onRebuild?: () => void;
}

export interface ViewportNoticeInput {
    webglError: string | null;
    generatorError: GeneratorRunError | null;
    tilesError: string | null;
    contentKind: SceneContentKind;
    /**
     * Content drawn by slices outside the focal-content classification (vector roadmap underlay, WASM wave mesh,
     * procedural biome terrain).
     */
    hasAuxiliaryContent?: boolean;
    /** Declared objects whose model or splat file failed to download or parse. */
    objectLoadErrors?: Array<{ id: string; error: string }>;
    /** Model files whose load could not reach the server and is being retried (Scene3DPrimitive, load-failure.ts). */
    reconnecting?: number;
    /** Declared objects the loader skips (not a model or splat file); see undrawableSceneObjects. */
    undrawableObjects?: Array<{ id: string; reason: string }>;
    /** Lens values in camera.lens the viewport does not draw, and why (ViewportOpticsChain status). */
    opticsIssues?: string[];
    assetRecovery?: ViewportRecoveryNotice;
    /** The tool rail's quick AI Beautify failed (QuickBeautifyButton.tsx): its reason, until dismissed or run again. */
    beautifyError?: { message: string; onDismiss: () => void };
}

const listOf = (items: string[]) => items.slice(0, 6).join('\n') + (items.length > 6 ? `\n… and ${items.length - 6} more` : '');

/**
 * What the viewport must say about its own state. Failures are reported as they are, and a scene whose data
 * declares nothing to draw says so: the viewport never draws stand-in geometry or a 2D imitation of the scene.
 */
export function resolveViewportNotice(input: ViewportNoticeInput): ViewportNoticeEntry[] {
    if (input.webglError) {
        return [{ kind: 'webgl-error', title: '3D viewport unavailable', detail: input.webglError }];
    }
    const notices: ViewportNoticeEntry[] = [];
    if (input.generatorError) {
        notices.push({ kind: 'generator-error', title: 'Model build failed', detail: input.generatorError.message });
    }
    if (input.tilesError) {
        notices.push({ kind: 'tiles-error', title: '3D Tiles unavailable', detail: input.tilesError });
    }
    const recovery = input.assetRecovery;
    if (recovery) {
        notices.push({
            kind: 'asset-recovery',
            title: recovery.running
                ? `Recovering ${recovery.files === 1 ? 'a missing file' : `${recovery.files} missing files`}`
                : `Recovery finished: ${recovery.message}`,
            detail: recovery.running
                ? recovery.message
                : [...(recovery.reasons ?? []), ...(recovery.onRebuild ? ['The scene knows the place it was built from, so the lost files can be built again from it.'] : [])].join('\n') || 'Rebuilt files are marked "rebuilt" in the model list.',
            ...(recovery.running && recovery.fraction !== undefined ? { fraction: recovery.fraction } : {}),
            ...(recovery.running ? { action: { label: 'Cancel', onClick: recovery.onCancel } }
                : recovery.onRebuild ? { action: { label: 'Rebuild this location', onClick: recovery.onRebuild } } : {})
        });
    }
    if (input.beautifyError) {
        notices.push({ kind: 'beautify-error', title: 'AI Beautify failed', detail: input.beautifyError.message, action: { label: 'Dismiss', onClick: input.beautifyError.onDismiss } });
    }
    const loadErrors = input.objectLoadErrors || [];
    if (loadErrors.length > 0) {
        notices.push({
            kind: 'object-load-error',
            title: loadErrors.length === 1 ? 'A model failed to load' : `${loadErrors.length} models failed to load`,
            detail: listOf(loadErrors.map(e => `${e.id}: ${e.error}`))
        });
    }
    // loads that could not reach the server are being tried again (load-failure.ts): a quiet status, not an alert
    if (input.reconnecting) {
        notices.push({
            kind: 'reconnecting',
            title: 'Waiting for the server',
            detail: `${input.reconnecting === 1 ? 'A model file' : `${input.reconnecting} model files`} could not be fetched; trying again (the server may be restarting).`
        });
    }
    const undrawable = input.undrawableObjects || [];
    if (undrawable.length > 0) {
        notices.push({
            kind: 'undrawable-objects',
            title: undrawable.length === 1 ? 'An object cannot be drawn' : `${undrawable.length} objects cannot be drawn`,
            detail: listOf(undrawable.map(o => `${o.id}: ${o.reason}`))
        });
    }
    // focus notices ('focus: ...', viewportFocus.ts) are not missing optics: depth of field is drawn at a held distance
    const allOptics = input.opticsIssues || [];
    const optics = allOptics.filter(i => !i.startsWith('focus: '));
    if (optics.length > 0) {
        notices.push({ kind: 'optics', title: 'Lens optics not fully drawn', detail: listOf(optics) });
    }
    // a lost tracked point is said over the viewport; auto focus looking at the sky shows on the reticle and the panel only
    const held = allOptics.filter(i => i.startsWith('focus: ') && !i.startsWith('focus: auto focus')).map(i => i.slice('focus: '.length));
    if (held.length > 0) {
        notices.push({ kind: 'focus', title: 'Focus held', detail: listOf(held) });
    }
    if (notices.length === 0 && input.contentKind === 'empty' && !input.hasAuxiliaryContent) {
        notices.push({ kind: 'empty', title: 'No geometry', detail: 'This scene has no models, meshes, generator or script to draw.' });
    }
    return notices;
}

const PANEL_STYLE: React.CSSProperties = {
    maxWidth: 520,
    padding: '10px 14px',
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'solid',
    fontSize: 12,
    lineHeight: 1.45,
    pointerEvents: 'auto',
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)'
};
const ERROR_STYLE: React.CSSProperties = { background: 'rgba(69, 10, 10, 0.88)', borderColor: 'rgba(248, 113, 113, 0.45)', color: '#fecaca' };
const EMPTY_STYLE: React.CSSProperties = { background: 'rgba(18, 18, 22, 0.72)', borderColor: 'rgba(255, 255, 255, 0.12)', color: '#d4d4d8' };

/** Renders the notices from resolveViewportNotice, centred over the viewport. */
export const ViewportNotice: React.FC<{ notices: ViewportNoticeEntry[] }> = ({ notices }) => {
    if (notices.length === 0) return null;
    return (
        <div
            className="sb-3d-viewport-notices"
            style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '16px 16px 16px 84px', pointerEvents: 'none', zIndex: 15 }}
        >
            {notices.map(n => (
                <div
                    key={n.kind}
                    data-testid="sb-3d-viewport-notice"
                    data-kind={n.kind}
                    role={n.kind === 'empty' || n.kind === 'focus' || n.kind === 'asset-recovery' || n.kind === 'reconnecting' ? 'status' : 'alert'}
                    style={{ ...PANEL_STYLE, ...(n.kind === 'empty' || n.kind === 'focus' || n.kind === 'asset-recovery' || n.kind === 'reconnecting' ? EMPTY_STYLE : ERROR_STYLE) }}
                >
                    <div style={{ fontWeight: 600 }}>{n.title}</div>
                    {n.fraction !== undefined && (
                        <div aria-hidden style={{ height: 3, marginTop: 6, borderRadius: 2, background: 'rgba(255, 255, 255, 0.12)' }}>
                            <div style={{ height: '100%', width: `${Math.round(Math.max(0, Math.min(1, n.fraction)) * 100)}%`, borderRadius: 2, background: '#a5b4fc', transition: 'width 300ms' }} />
                        </div>
                    )}
                    {n.detail && (
                        <div style={{
                            // Error details are tool output (stderr, compiler messages): keep their layout.
                            ...(n.kind === 'empty' || n.kind === 'focus' || n.kind === 'reconnecting' ? {} : { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', whiteSpace: 'pre-wrap' as const }),
                            wordBreak: 'break-word', marginTop: 4, opacity: 0.9
                        }}>{n.detail}</div>
                    )}
                    {n.action && (
                        <button
                            type="button"
                            className="sb-3d-viewport-notice-action"
                            data-testid="sb-3d-viewport-notice-action"
                            onClick={n.action.onClick}
                            style={{ marginTop: 8, padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(255, 255, 255, 0.2)', background: 'rgba(255, 255, 255, 0.08)', color: 'inherit', font: 'inherit', cursor: 'pointer' }}
                        >{n.action.label}</button>
                    )}
                </div>
            ))}
        </div>
    );
};
