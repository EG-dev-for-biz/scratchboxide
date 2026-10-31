/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The toolstrip's Edit Splats control: switches the splat brush on (splatEditTool.ts) and sets it, lists the scene's
 * strokes, and saves the scene, its strokes included, as a new version of the world in the cloud (/api/worlds).
 */

import * as React from 'react';
import type { Scene3DData } from '../../canvas-types';
import type { SplatEditOp } from '../../../../common/spatial/splat-edits';
import type { SplatBrush } from './splatEditTool';

export interface SplatEditControlProps {
    sceneData: Scene3DData;
    mutateSceneData: (mutator: (prev: Scene3DData) => Scene3DData, opInfo?: { operator: string; params?: any }, options?: { history?: { label?: string } | false }) => void;
    /** Whether the splat brush is the viewport's tool now. */
    active: boolean;
    onActive: (on: boolean) => void;
    brush: SplatBrush;
    onBrush: (brush: SplatBrush) => void;
    /** The scene as it is now (what Save sends). */
    currentScene: () => Scene3DData;
}

const OPS: Array<{ op: SplatEditOp; label: string; title: string }> = [
    { op: 'erase', label: 'Erase', title: 'Hide the splats under the brush' },
    { op: 'restore', label: 'Restore', title: 'Bring back the splats as they were built' },
    { op: 'paint', label: 'Paint', title: 'Move the splats\' colour toward the paint colour' }
];

const toHex = (c: [number, number, number]) => `#${c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const fromHex = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

type SaveState = { phase: 'idle' } | { phase: 'saving' } | { phase: 'saved'; version: string; savedAt: string } | { phase: 'failed'; error: string };

export function SplatEditControl({ sceneData, mutateSceneData, active, onActive, brush, onBrush, currentScene }: SplatEditControlProps): React.ReactElement {
    const [save, setSave] = React.useState<SaveState>({ phase: 'idle' });
    const strokes = sceneData.splatEdits ?? [];
    const slug = sceneData.world?.slug;

    const counts = strokes.reduce((acc, s) => ({ ...acc, [s.op]: (acc[s.op] ?? 0) + 1 }), {} as Record<string, number>);
    const clearAll = () => mutateSceneData(prev => {
        const out = { ...prev };
        delete out.splatEdits;
        return out;
    }, { operator: 'splat_edit_clear', params: { strokes: strokes.length } }, { history: { label: 'Clear splat edits' } });

    const saveToCloud = async () => {
        if (!slug) return;
        setSave({ phase: 'saving' });
        try {
            const res = await fetch(`/api/worlds/${encodeURIComponent(slug)}/scene`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: currentScene() })
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || !body.success) throw new Error(body.error || `HTTP ${res.status}`);
            setSave({ phase: 'saved', version: body.version, savedAt: body.savedAt });
            mutateSceneData(prev => ({ ...prev, world: { slug, version: body.version, savedAt: body.savedAt } }), { operator: 'world_save', params: { version: body.version } }, { history: false });
        } catch (err) {
            setSave({ phase: 'failed', error: err instanceof Error ? err.message : String(err) });
        }
    };

    return (
        <div className="sb-3d-camera-control sb-3d-splat-edit-control">
            <button
                type="button"
                className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${
                    active
                        ? 'sb-3d-toolstrip-btn-active bg-blue-600/30 text-blue-300 border border-blue-500/50 shadow-md shadow-blue-900/30'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-white/5 border border-transparent'
                }`}
                onClick={() => onActive(!active)}
                title="Edit splats: erase, restore or paint the splats with a brush"
                aria-label="Edit splats"
                aria-pressed={active}
            >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="7" r="1.5" fill="currentColor" />
                    <circle cx="11" cy="4" r="1" fill="currentColor" />
                    <circle cx="4" cy="12" r="1" fill="currentColor" />
                    <path d="M20.5 3.5a2.1 2.1 0 0 1 0 3L11 16l-4 1 1-4 9.5-9.5a2.1 2.1 0 0 1 3 0z" />
                </svg>
            </button>
            {active && (
                <div className="sb-3d-camera-panel sb-3d-splat-edit-panel" role="dialog" aria-label="Edit splats">
                    <div className="sb-cam-header">
                        <span>Edit splats</span>
                        <div className="sb-cam-row">
                            <button type="button" className="sb-cam-close" onClick={() => onActive(false)} aria-label="Close edit splats">×</button>
                        </div>
                    </div>
                    <div className="sb-cam-section">
                        <div className="sb-cam-chips">
                            {OPS.map(o => (
                                <button
                                    key={o.op} type="button" title={o.title}
                                    className={`sb-cam-chip ${brush.op === o.op ? 'sb-cam-chip-on' : ''}`}
                                    onClick={() => onBrush({ ...brush, op: o.op })}
                                >{o.label}</button>
                            ))}
                        </div>
                    </div>
                    <div className="sb-cam-section">
                        <div className="sb-cam-readout"><span>Brush radius</span><span className="sb-cam-value">{brush.radius < 1 ? `${Math.round(brush.radius * 100)} cm` : `${brush.radius.toFixed(1)} m`}</span></div>
                        <input
                            type="range" min={0.05} max={4} step={0.05} value={brush.radius} aria-label="Brush radius" className="sb-cam-range"
                            onChange={e => onBrush({ ...brush, radius: Number(e.target.value) })}
                        />
                    </div>
                    {brush.op === 'paint' && (
                        <div className="sb-cam-section">
                            <div className="sb-cam-readout">
                                <span>Colour</span>
                                <input type="color" value={toHex(brush.color)} aria-label="Paint colour" onChange={e => onBrush({ ...brush, color: fromHex(e.target.value) })} />
                            </div>
                            <div className="sb-cam-readout"><span>Strength</span><span className="sb-cam-value">{Math.round(brush.strength * 100)}%</span></div>
                            <input
                                type="range" min={0.05} max={1} step={0.05} value={brush.strength} aria-label="Paint strength" className="sb-cam-range"
                                onChange={e => onBrush({ ...brush, strength: Number(e.target.value) })}
                            />
                        </div>
                    )}
                    <div className="sb-cam-section">
                        <div className="sb-cam-readout">
                            <span>{strokes.length ? `${strokes.length} stroke${strokes.length === 1 ? '' : 's'}${Object.keys(counts).length ? ` (${OPS.filter(o => counts[o.op]).map(o => `${counts[o.op]} ${o.label.toLowerCase()}`).join(', ')})` : ''}` : 'No edits yet'}</span>
                            {strokes.length > 0 && <button type="button" className="sb-cam-chip" onClick={clearAll} title="Remove every stroke (undoable)">Clear</button>}
                        </div>
                    </div>
                    <div className="sb-cam-note">Drag on the splats to edit them; right-drag looks around. The built splat is never changed: undo removes a stroke.</div>
                    {slug ? (
                        <div className="sb-cam-section">
                            <button type="button" className="sb-cam-chip sb-cam-chip-on" disabled={save.phase === 'saving'} onClick={() => void saveToCloud()} title="Save this scene, its splat edits included, as a new version in the world cache">
                                {save.phase === 'saving' ? 'Saving...' : 'Save world to cloud'}
                            </button>
                            <div className="sb-cam-note">
                                {save.phase === 'saved' ? `Saved as version ${save.version}` :
                                    save.phase === 'failed' ? `Not saved: ${save.error}` :
                                        sceneData.world?.version ? `Opened version ${sceneData.world.version}` : 'Opened as built (no saved version yet)'}
                            </div>
                        </div>
                    ) : (
                        <div className="sb-cam-note">This scene is not a cached world, so its edits stay in this chat.</div>
                    )}
                </div>
            )}
        </div>
    );
}
