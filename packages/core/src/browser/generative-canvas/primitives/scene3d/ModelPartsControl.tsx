/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport's Parts view: a tool strip button and its panel (the camera settings' panel styles). The loaded
 * models as the parts they are made of, grouped by what identifies them (modelParts.ts), each drawn in its own colour
 * over the model; a row hides or shows its part, "only" shows it alone, hovering a row or clicking a part in the
 * viewport highlights it and reads out what the model says about it (provenance, confidence, what it was built from).
 * The setting lives in the scene (Scene3DData.partsView).
 */

import * as React from 'react';
import * as THREE from 'three';
import type { Scene3DData } from '../../canvas-types';
import type { RendererStack } from './types';
import { PARTS_VIEW_CLEAR_OPERATOR, PARTS_VIEW_OPERATOR, partShown, partsTintOn, type ModelPartsViewConfig } from '../../../../common/spatial/model-parts-view';
import { applyModelPartsView, collectModelParts, ModelPartsOverlay, partByKey, pickModelPart, restoreModelParts, type ModelPart, type ModelPartGroup } from './modelParts';

type Mutate = (mutator: (prev: Scene3DData) => Scene3DData, opInfo?: { operator: string; params?: any }, options?: { history?: false }) => void;

export interface ModelPartsState {
    config: ModelPartsViewConfig | undefined;
    groups: ModelPartGroup[];
    /** The part under the pointer in the list or clicked in the viewport. */
    highlight?: string;
    setHighlight: (key: string | undefined) => void;
    picked?: ModelPart;
    /** Rebuilds the list from the models as loaded now (after a load the key did not see). */
    refresh: () => void;
}

function setConfig(prev: Scene3DData, patch: Partial<ModelPartsViewConfig>): Scene3DData {
    const cur = prev.partsView ?? { on: false };
    return { ...prev, partsView: { ...cur, ...patch } };
}

const CLICK_PX = 4;

/**
 * Reads the parts of the models while the view is on, draws the overlay, applies the hidden and solo parts, and picks
 * on a click without a drag. `roots` are the scene's loaded roots (models, generated geometry); `rootsKey` changes when
 * they load or unload.
 */
export function useModelPartsView(opts: { stackRef: React.MutableRefObject<RendererStack | null>; sceneData: Scene3DData; roots: () => THREE.Object3D[]; rootsKey: string }): ModelPartsState {
    const { stackRef, sceneData, roots, rootsKey } = opts;
    const cfg = sceneData.partsView;
    const on = !!cfg?.on;
    const tint = partsTintOn(cfg);
    const [groups, setGroups] = React.useState<ModelPartGroup[]>([]);
    const [highlight, setHighlight] = React.useState<string | undefined>();
    const [picked, setPicked] = React.useState<ModelPart | undefined>();
    const [tick, setTick] = React.useState(0);
    const overlayRef = React.useRef<ModelPartsOverlay | null>(null);
    const groupsRef = React.useRef(groups);
    groupsRef.current = groups;

    // the parts, read when the view goes on and whenever the models change
    React.useEffect(() => {
        if (!on) { setGroups([]); setPicked(undefined); setHighlight(undefined); return; }
        // the models seat and prepare themselves a frame after they load
        const id = window.setTimeout(() => setGroups(collectModelParts(roots())), 50);
        return () => window.clearTimeout(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [on, rootsKey, tick]);

    // the overlay exists while the view is on
    React.useEffect(() => {
        if (!on) return;
        const stack = stackRef.current;
        if (!stack) return;
        const overlay = new ModelPartsOverlay(stack.scene);
        overlayRef.current = overlay;
        return () => { overlay.dispose(); overlayRef.current = null; };
    }, [on, stackRef]);

    // the parts hidden and shown as the setting says; every part shown again when the view goes off
    React.useEffect(() => {
        if (!groups.length) return;
        applyModelPartsView(groups, on ? cfg : undefined);
        overlayRef.current?.sync(groups, { tint, cfg, highlight });
        return () => { restoreModelParts(groups); };
    }, [groups, on, cfg?.hidden, cfg?.solo, tint, highlight]); // eslint-disable-line react-hooks/exhaustive-deps

    // a click without a drag picks the part under the pointer
    React.useEffect(() => {
        if (!on) return;
        const stack = stackRef.current;
        if (!stack) return;
        const el = stack.renderer.domElement;
        let down: { x: number; y: number } | undefined;
        const raycaster = new THREE.Raycaster();
        const onDown = (e: PointerEvent) => { if (e.button === 0) down = { x: e.clientX, y: e.clientY }; };
        const onUp = (e: PointerEvent) => {
            if (!down) return;
            const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
            down = undefined;
            if (moved > CLICK_PX) return;
            const r = el.getBoundingClientRect();
            raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), stack.camera);
            const part = pickModelPart(raycaster, groupsRef.current);
            setPicked(part);
            setHighlight(part?.key);
        };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointerup', onUp);
        return () => { el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp); };
    }, [on, stackRef]);

    const refresh = React.useCallback(() => setTick(t => t + 1), []);
    return { config: cfg, groups, highlight, setHighlight, picked, refresh };
}

export interface ModelPartsControlProps {
    state: ModelPartsState;
    mutateSceneData: Mutate;
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function ModelPartsControl({ state, mutateSceneData }: ModelPartsControlProps): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const [collapsed, setCollapsed] = React.useState<Set<string>>(() => new Set());
    const cfg = state.config;
    const on = !!cfg?.on;
    const tint = partsTintOn(cfg);
    const set = (patch: Partial<ModelPartsViewConfig>, op = PARTS_VIEW_OPERATOR) => mutateSceneData(prev => setConfig(prev, patch), { operator: op, params: patch });
    const hidden = new Set(cfg?.hidden ?? []);
    const toggle = (key: string) => {
        const next = new Set(hidden);
        if (next.has(key)) next.delete(key); else next.add(key);
        set({ hidden: [...next], solo: undefined });
    };
    const toggleGroup = (g: ModelPartGroup) => {
        const allHidden = g.parts.every(p => hidden.has(p.key));
        const next = new Set(hidden);
        for (const p of g.parts) { if (allHidden) next.delete(p.key); else next.add(p.key); }
        set({ hidden: [...next], solo: undefined });
    };
    const solo = (key: string) => set({ solo: cfg?.solo === key ? undefined : key });
    const showAll = () => set({ hidden: [], solo: undefined });
    const total = state.groups.reduce((a, g) => a + g.parts.length, 0), triangles = state.groups.reduce((a, g) => a + g.triangles, 0);
    const hiddenCount = state.groups.reduce((a, g) => a + g.parts.filter(p => !partShown(cfg, p.key)).length, 0);
    const picked = state.picked ?? partByKey(state.groups, state.highlight);

    const row = (p: ModelPart) => {
        const shown = partShown(cfg, p.key);
        const lit = state.highlight === p.key;
        return (
            <li key={p.key} className={`sb-parts-row ${lit ? 'sb-parts-row-lit' : ''}`} onMouseEnter={() => state.setHighlight(p.key)} onMouseLeave={() => state.setHighlight(undefined)}>
                <button type="button" aria-pressed={shown} onClick={() => toggle(p.key)} title={shown ? `Hide ${p.label}` : `Show ${p.label}`} className="sb-parts-row-main" style={{ opacity: shown ? 1 : 0.4 }}>
                    <span aria-hidden className="sb-parts-swatch" style={{ background: p.colour }} />
                    <span className="sb-parts-label">{p.label}{p.provenance ? <span className="sb-parts-dim">{` · ${p.provenance.label}`}</span> : null}<span className="sb-parts-dim">{` · ${fmt(p.triangles)} tris`}</span></span>
                </button>
                <button type="button" className={`sb-parts-only ${cfg?.solo === p.key ? 'sb-parts-only-on' : ''}`} onClick={() => solo(p.key)} title={cfg?.solo === p.key ? 'Show every part again' : `Show only ${p.label}`} aria-pressed={cfg?.solo === p.key}>only</button>
            </li>
        );
    };
    const section = (g: ModelPartGroup) => {
        const shownCount = g.parts.filter(p => partShown(cfg, p.key)).length;
        const isCollapsed = collapsed.has(g.key);
        return (
            <div className="sb-cam-section" key={g.key} data-testid={`sb-parts-group-${g.key}`}>
                <div className="sb-cam-section-head">
                    <button type="button" className="sb-parts-group-head" onClick={() => setCollapsed(s => { const n = new Set(s); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); return n; })} aria-expanded={!isCollapsed} title={isCollapsed ? 'Expand' : 'Collapse'}>
                        <span aria-hidden className="sb-parts-swatch" style={{ background: g.colour }} />
                        <h3 style={{ color: '#e4e4e7' }}>{g.label}</h3>
                        <span className="sb-parts-dim">{`${shownCount}/${g.parts.length} · ${fmt(g.triangles)} tris`}</span>
                    </button>
                    <button type="button" role="switch" aria-checked={shownCount > 0} aria-label={`${g.label} shown`} className={`sb-cam-switch ${shownCount > 0 ? 'sb-cam-switch-on' : ''}`} onClick={() => toggleGroup(g)} title={shownCount > 0 ? `Hide every ${g.label.toLowerCase()} part` : `Show every ${g.label.toLowerCase()} part`}><span className="sb-cam-switch-knob" /></button>
                </div>
                {!isCollapsed && <ul className="sb-parts-list">{g.parts.map(row)}</ul>}
            </div>
        );
    };

    return (
        <div className="sb-3d-camera-control sb-3d-parts-control">
            <button
                type="button"
                className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${open || on ? 'sb-3d-toolstrip-btn-active' : ''}`}
                onClick={() => setOpen(v => !v)}
                title="Parts: the model as the parts it is made of, each in its own colour, hidden or shown one by one"
                aria-label="Parts"
                aria-pressed={open}
                data-testid="sb-parts-button"
            >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z" /><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" /><path d="M8 5.25l8 4.5" />
                </svg>
            </button>
            {open && (
                <div className="sb-3d-camera-panel sb-3d-parts-panel" role="dialog" aria-label="Parts" data-testid="sb-parts-panel" style={{ maxHeight: 'min(70vh, calc(100vh - 240px))', overflowY: 'auto', width: 320 }}>
                    <div className="sb-cam-header">
                        <span>Parts</span>
                        <div className="sb-cam-row">
                            <button type="button" role="switch" aria-checked={on} aria-label="Parts view on" data-testid="sb-parts-switch"
                                className={`sb-cam-switch ${on ? 'sb-cam-switch-on' : ''}`} onClick={() => set({ on: !on }, on ? PARTS_VIEW_CLEAR_OPERATOR : PARTS_VIEW_OPERATOR)}
                                title={on ? 'Turn the parts view off' : 'Show the model as its parts'}><span className="sb-cam-switch-knob" /></button>
                            <button type="button" className="sb-cam-close" onClick={() => setOpen(false)} aria-label="Close parts">×</button>
                        </div>
                    </div>
                    {!on && <div className="sb-cam-note">Shows a 3D object or building as the parts it is made of: rebuilt facades, base, seal, scan pieces, an object's parts, each with what the model says about it. Switch it on.</div>}
                    {on && (
                        <>
                            <div className="sb-cam-row" style={{ justifyContent: 'space-between' }}>
                                <span className="sb-cam-label" style={{ flex: 1, width: 'auto' }}>Colour each part</span>
                                <button type="button" role="switch" aria-checked={tint} aria-label="Colour each part" data-testid="sb-parts-tint" className={`sb-cam-switch ${tint ? 'sb-cam-switch-on' : ''}`} onClick={() => set({ tint: !tint })}><span className="sb-cam-switch-knob" /></button>
                            </div>
                            <div className="sb-cam-readout"><span>{total ? `${fmt(total)} parts in ${state.groups.length} groups` : 'No parts yet'}</span><span className="sb-cam-value">{total ? `${fmt(triangles)} tris` : ''}</span></div>
                            <div className="sb-cam-row" style={{ gap: 8 }}>
                                <button type="button" className="sb-parts-action" onClick={showAll} disabled={!hiddenCount} data-testid="sb-parts-show-all">{hiddenCount ? `Show all (${hiddenCount} hidden)` : 'All shown'}</button>
                                <button type="button" className="sb-parts-action" onClick={state.refresh} title="Read the parts again from the models as loaded now">Re-read</button>
                            </div>
                            {!total && <div className="sb-cam-note">No model is loaded, or it is still loading. Re-read once it shows.</div>}
                            {picked && (
                                <div className="sb-cam-note" data-testid="sb-parts-picked" style={{ color: '#e4e4e7' }}>
                                    <div><span aria-hidden className="sb-parts-swatch" style={{ background: picked.colour, display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} /><b>{picked.label}</b> <span className="sb-parts-dim">· {state.groups.find(g => g.key === picked.group)?.label ?? picked.group}</span></div>
                                    {picked.provenance && <div>{picked.provenance.label}{picked.provenance.confidence !== undefined ? ` · confidence ${picked.provenance.confidence.toFixed(2)}` : ''}{picked.provenance.method ? ` · ${picked.provenance.method}` : ''}</div>}
                                    {picked.detail && <div className="sb-parts-dim">{picked.detail}</div>}
                                    <div className="sb-parts-dim">{fmt(picked.triangles)} triangles{picked.merged ? ' · in a merged mesh' : ''}</div>
                                </div>
                            )}
                            {total > 0 && <div className="sb-cam-note">Click a part in the viewport to read it; hover a row to see where it is; click a row to hide or show it.</div>}
                            {state.groups.map(section)}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
