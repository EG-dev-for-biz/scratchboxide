/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport's Map data view: a tool strip button and its panel (the camera settings' panel styles). The scene as
 * map data: the blob graph's groups coloured by group, Google vector data (roads with their measured carriageways,
 * footprints, areas, rail, POIs) and Google's 2D roadmap, each layer switchable, with a legend whose rows switch groups
 * and area codes on and off. The setting lives in the scene (Scene3DData.mapDataView); the drawing in mapDataLayer.ts.
 */

import * as React from 'react';
import * as THREE from 'three';
import type { Scene3DData } from '../../canvas-types';
import type { RendererStack } from './types';
import {
    decodeBlobGroups, groundSampler, layerOn, MAP_DATA_DEFAULT_RADIUS_M, MAP_DATA_LAYER_DEFAULTS, MAP_DATA_LAYERS,
    type BlobGroupsHeader, type MapDataLayer as LayerKey, type MapDataViewConfig, type MapVectorOverlay
} from '../../../../common/spatial/map-data-view';
import { MapDataLayer, MAP_OVERLAY_COLOURS, type MapLegendRow } from './mapDataLayer';

type Mutate = (mutator: (prev: Scene3DData) => Scene3DData, opInfo?: { operator: string; params?: any }, options?: { history?: false }) => void;

export interface MapDataViewState {
    config: MapDataViewConfig | undefined;
    blobGraphPath?: string;
    blobs: { status: 'idle' | 'loading' | 'ready' | 'error'; error?: string; legend: MapLegendRow[]; header?: BlobGroupsHeader };
    vector: { status: 'idle' | 'loading' | 'ready' | 'error'; error?: string; areas: MapLegendRow[]; overlay?: MapVectorOverlay; cached?: boolean };
    roadmap: { status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'; reason?: string; tiles?: number; attribution?: string };
    picked?: { index: number; id: string; group: string; description?: string; confidence?: number; featureId?: string; triangles: number };
    anchor?: { lat: number; lng: number };
}

const LAYER_TITLES: Record<LayerKey, string> = {
    blobs: 'Blob groups', roads: 'Roads', footprints: 'Building footprints', areas: 'Areas (water, green, land use)', rails: 'Rail', pois: 'Points of interest', roadmap: 'Google roadmap'
};

function setConfig(prev: Scene3DData, patch: Partial<MapDataViewConfig>): Scene3DData {
    const cur = prev.mapDataView ?? { on: false };
    return { ...prev, mapDataView: { ...cur, ...patch, ...(patch.layers ? { layers: { ...cur.layers, ...patch.layers } } : {}) } };
}

/** The model paths a blob graph may sit beside (the scene's loaded models). */
function modelUris(scene: Scene3DData): string[] {
    return (scene.objects ?? []).map(o => o.content?.durableUri).filter((u): u is string => typeof u === 'string' && /\.glb(\?|#|$)/i.test(u));
}

/**
 * Loads and draws the map data for the scene while the view is on. `sceneRoots` are the scene's own drawn roots (models,
 * generated geometry), hidden while the blob groups draw the same surface.
 */
export function useMapDataView(opts: { stackRef: React.MutableRefObject<RendererStack | null>; sceneData: Scene3DData; sceneRoots: () => THREE.Object3D[]; /** Changes when the scene's models load or unload. */ sceneRootsKey?: string }): MapDataViewState {
    const { stackRef, sceneData, sceneRoots, sceneRootsKey } = opts;
    const cfg = sceneData.mapDataView;
    const on = !!cfg?.on;
    const layerRef = React.useRef<MapDataLayer | null>(null);
    const [blobs, setBlobs] = React.useState<MapDataViewState['blobs']>({ status: 'idle', legend: [] });
    const [vector, setVector] = React.useState<MapDataViewState['vector']>({ status: 'idle', areas: [] });
    const [roadmap, setRoadmap] = React.useState<MapDataViewState['roadmap']>({ status: 'idle' });
    const [discovered, setDiscovered] = React.useState<string | undefined>();
    const [picked, setPicked] = React.useState<MapDataViewState['picked']>();
    const blobGraphPath = cfg?.blobGraphPath || discovered;
    const anchor = sceneData.geoAnchor?.lat !== undefined && sceneData.geoAnchor?.lng !== undefined
        ? { lat: sceneData.geoAnchor.lat, lng: sceneData.geoAnchor.lng }
        : blobs.header?.source.anchor;
    const radiusM = cfg?.radiusM ?? MAP_DATA_DEFAULT_RADIUS_M;
    const vectorWanted = on && (['roads', 'footprints', 'areas', 'rails', 'pois'] as LayerKey[]).some(l => layerOn(cfg, l));
    const blobsWanted = on && layerOn(cfg, 'blobs');
    const roadmapWanted = on && layerOn(cfg, 'roadmap');
    const sceneKey = modelUris(sceneData).join('|');

    // the layer exists while the view is on
    React.useEffect(() => {
        if (!on) return;
        const stack = stackRef.current;
        if (!stack) return;
        const layer = new MapDataLayer(stack.scene);
        layerRef.current = layer;
        return () => { layer.dispose(); layerRef.current = null; setBlobs({ status: 'idle', legend: [] }); setVector({ status: 'idle', areas: [] }); setRoadmap({ status: 'idle' }); setPicked(undefined); };
    }, [on, stackRef]);

    // a blob graph beside one of the scene's models, when the setting names none
    React.useEffect(() => {
        if (!on || cfg?.blobGraphPath) return;
        let cancelled = false;
        (async () => {
            for (const uri of modelUris(sceneData)) {
                const model = uri.startsWith('/models/') ? `public${uri.split(/[?#]/)[0]}` : uri.split(/[?#]/)[0];
                const r = await fetch(`/api/map-data/discover?model=${encodeURIComponent(model)}`).then(x => x.json()).catch(() => null) as { blobGraphPath?: string | null } | null;
                if (cancelled) return;
                if (r?.blobGraphPath) { setDiscovered(r.blobGraphPath); return; }
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [on, cfg?.blobGraphPath, sceneKey]);

    // blob groups
    React.useEffect(() => {
        if (!blobsWanted || !blobGraphPath) return;
        const layer = layerRef.current;
        if (!layer) return;
        let cancelled = false;
        setBlobs(b => ({ ...b, status: 'loading', error: undefined }));
        (async () => {
            try {
                const res = await fetch(`/api/map-data/blob-groups?path=${encodeURIComponent(blobGraphPath)}`);
                if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
                const payload = decodeBlobGroups(await res.arrayBuffer());
                if (cancelled || layerRef.current !== layer) return;
                const legend = layer.setBlobs(payload);
                setBlobs({ status: 'ready', legend, header: payload.header });
            } catch (err) {
                if (!cancelled) setBlobs({ status: 'error', error: (err as Error).message, legend: [] });
            }
        })();
        return () => { cancelled = true; };
    }, [blobsWanted, blobGraphPath, on]);

    // vector data, measured on the blob graph's scan when there is one (waits for its header so the widths are measured)
    const scan = blobs.header?.source.mesh;
    const waitForScan = !!blobGraphPath && blobsWanted && blobs.status === 'loading';
    React.useEffect(() => {
        if (!vectorWanted || !anchor || waitForScan) return;
        const layer = layerRef.current, stack = stackRef.current;
        if (!layer || !stack) return;
        let cancelled = false;
        setVector(v => ({ ...v, status: 'loading', error: undefined }));
        (async () => {
            try {
                const q = new URLSearchParams({ lat: String(anchor.lat), lng: String(anchor.lng), radiusM: String(radiusM), ...(scan ? { scan } : {}) });
                const r = await fetch(`/api/map-data/vector?${q}`).then(x => x.json()) as { success: boolean; error?: string; overlay?: MapVectorOverlay; cached?: boolean };
                if (!r.success || !r.overlay) throw new Error(r.error || 'no overlay returned');
                if (cancelled || layerRef.current !== layer) return;
                const size = stack.renderer.getSize(new THREE.Vector2());
                const areas = layer.setVector(r.overlay, groundSampler(r.overlay.ground), size);
                setVector({ status: 'ready', areas, overlay: r.overlay, cached: r.cached });
            } catch (err) {
                if (!cancelled) setVector({ status: 'error', error: (err as Error).message, areas: [] });
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [vectorWanted, anchor?.lat, anchor?.lng, radiusM, scan, waitForScan, on]);

    // the roadmap, draped on the measured ground once the vector overlay brought it
    const ground = vector.overlay?.ground;
    React.useEffect(() => {
        if (!roadmapWanted || !anchor) return;
        if (vectorWanted && vector.status === 'loading') return;
        const layer = layerRef.current;
        if (!layer) return;
        let cancelled = false;
        setRoadmap({ status: 'loading' });
        (async () => {
            try {
                const q = new URLSearchParams({ lat: String(anchor.lat), lng: String(anchor.lng), radiusM: String(radiusM) });
                const r = await fetch(`/api/map-data/roadmap?${q}`).then(x => x.json()) as { success: boolean; error?: string; available?: boolean; reason?: string; tiles?: any[]; attribution?: string };
                if (!r.success) throw new Error(r.error || 'roadmap failed');
                if (cancelled || layerRef.current !== layer) return;
                if (!r.available) { setRoadmap({ status: 'unavailable', reason: r.reason }); return; }
                layer.setRoadmap(r.tiles ?? [], groundSampler(ground), sceneData.mapDataView?.roadmapOpacity ?? 0.7);
                setRoadmap({ status: 'ready', tiles: r.tiles?.length ?? 0, attribution: r.attribution });
            } catch (err) {
                if (!cancelled) setRoadmap({ status: 'error', reason: (err as Error).message });
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [roadmapWanted, anchor?.lat, anchor?.lng, radiusM, ground, on]);

    React.useEffect(() => { layerRef.current?.setRoadmapOpacity(cfg?.roadmapOpacity ?? 0.7); }, [cfg?.roadmapOpacity, roadmap.status]);

    // layer switches, legend rows, and the scene hidden under the blob groups
    const hiddenKey = (cfg?.hidden ?? []).join('|');
    const layersKey = MAP_DATA_LAYERS.map(l => (layerOn(cfg, l) ? 1 : 0)).join('');
    React.useEffect(() => {
        const layer = layerRef.current;
        if (!layer) return;
        const layers = Object.fromEntries(MAP_DATA_LAYERS.map(l => [l, layerOn(cfg, l)])) as Record<LayerKey, boolean>;
        layer.applyVisibility(layers, new Set(cfg?.hidden ?? []));
        const hide = layers.blobs && blobs.status === 'ready' && (cfg?.hideSceneUnderBlobs ?? true);
        layer.hideSceneRoots(hide ? sceneRoots() : [], hide);
        layer.setBlobDepthBias(layers.blobs && !hide);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [on, layersKey, hiddenKey, blobs.status, vector.status, roadmap.status, cfg?.hideSceneUnderBlobs, sceneKey, sceneRootsKey]);

    // line widths follow the canvas size
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!on || !stack) return;
        const ro = new ResizeObserver(() => { const s = stack.renderer.getSize(new THREE.Vector2()); layerRef.current?.setResolution(s.x, s.y); });
        ro.observe(stack.renderer.domElement);
        return () => ro.disconnect();
    }, [on, stackRef]);

    // a click (not a drag) on a blob reads it out in the panel
    const header = blobs.header;
    React.useEffect(() => {
        const stack = stackRef.current;
        if (!on || !stack || !header) return;
        const el = stack.renderer.domElement;
        let down: { x: number; y: number } | null = null;
        const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY }; };
        const onUp = (e: PointerEvent) => {
            if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down = null; return; }
            down = null;
            const rect = el.getBoundingClientRect();
            const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
            const ray = new THREE.Raycaster();
            ray.setFromCamera(ndc, stack.camera);
            const hit = layerRef.current?.pickBlob(ray);
            if (!hit) return;
            const b = header.blobs[hit.blobIndex];
            if (b) setPicked({ index: hit.blobIndex, ...b });
        };
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointerup', onUp);
        return () => { el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointerup', onUp); };
    }, [on, stackRef, header]);

    return { config: cfg, ...(blobGraphPath ? { blobGraphPath } : {}), blobs, vector, roadmap, ...(picked ? { picked } : {}), ...(anchor ? { anchor } : {}) };
}

export interface MapDataControlProps {
    state: MapDataViewState;
    mutateSceneData: Mutate;
}

function Swatch({ colour, line, dashed }: { colour: string; line?: boolean; dashed?: boolean }): React.ReactElement {
    return line
        ? <span aria-hidden style={{ width: 14, height: 0, borderTop: `3px ${dashed ? 'dashed' : 'solid'} ${colour}`, flexShrink: 0, alignSelf: 'center' }} />
        : <span aria-hidden style={{ width: 11, height: 11, borderRadius: 2, background: colour, flexShrink: 0, alignSelf: 'center' }} />;
}

export function MapDataControl({ state, mutateSceneData }: MapDataControlProps): React.ReactElement {
    const [open, setOpen] = React.useState(false);
    const cfg = state.config;
    const on = !!cfg?.on;
    const set = (patch: Partial<MapDataViewConfig>, op = 'set_map_data_view') => mutateSceneData(prev => setConfig(prev, patch), { operator: op, params: patch });
    const toggleLayer = (l: LayerKey) => set({ layers: { [l]: !(cfg?.layers?.[l] ?? MAP_DATA_LAYER_DEFAULTS[l]) } });
    const hidden = new Set(cfg?.hidden ?? []);
    const toggleRow = (key: string) => {
        const next = new Set(hidden);
        if (next.has(key)) next.delete(key); else next.add(key);
        set({ hidden: [...next] });
    };
    const row = (r: MapLegendRow) => (
        <li key={r.key}>
            <button type="button" className="sb-map-legend-row" aria-pressed={!hidden.has(r.key)} onClick={() => toggleRow(r.key)} title={hidden.has(r.key) ? `Show ${r.label}` : `Hide ${r.label}`}
                style={{ display: 'flex', gap: 6, alignItems: 'flex-start', width: '100%', background: 'none', border: 0, padding: '1px 0', color: 'inherit', cursor: 'pointer', textAlign: 'left', opacity: hidden.has(r.key) ? 0.4 : 1, font: 'inherit' }}>
                <Swatch colour={r.colour} />
                <span>{r.label}{r.detail ? <span style={{ color: '#a1a1aa' }}>{` · ${r.detail}`}</span> : r.count !== undefined ? <span style={{ color: '#a1a1aa' }}>{` · ${r.count}`}</span> : null}</span>
            </button>
        </li>
    );
    const layerSwitch = (l: LayerKey) => {
        const v = layerOn({ on: true, layers: cfg?.layers }, l);
        return (
            <div className="sb-cam-row" key={l} style={{ justifyContent: 'space-between' }}>
                <span className="sb-cam-label" style={{ flex: 1, whiteSpace: 'nowrap', width: 'auto' }}>{LAYER_TITLES[l]}</span>
                <button type="button" role="switch" aria-checked={v} aria-label={LAYER_TITLES[l]} data-testid={`sb-map-layer-${l}`}
                    className={`sb-cam-switch ${v ? 'sb-cam-switch-on' : ''}`} onClick={() => toggleLayer(l)}><span className="sb-cam-switch-knob" /></button>
            </div>
        );
    };
    const status = (s: { status: string; error?: string; reason?: string }, ready: string) =>
        s.status === 'loading' ? 'Loading…' : s.status === 'error' ? `Could not load: ${s.error ?? s.reason}` : s.status === 'unavailable' ? `Not available: ${s.reason}` : s.status === 'ready' ? ready : '';
    const ov = state.vector.overlay;

    return (
        <div className="sb-3d-camera-control sb-3d-map-data-control">
            <button
                type="button"
                className={`sb-3d-toolstrip-btn relative group flex items-center justify-center w-5 h-5 rounded-md transition-all ${open || on ? 'sb-3d-toolstrip-btn-active' : ''}`}
                onClick={() => setOpen(v => !v)}
                title="Map data: blob groups, roads, footprints, places and the roadmap over the scene"
                aria-label="Map data"
                aria-pressed={open}
                data-testid="sb-map-data-button"
            >
                <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2z" /><path d="M9 4v14M15 6v14" />
                </svg>
            </button>
            {open && (
                <div className="sb-3d-camera-panel sb-3d-map-data-panel" role="dialog" aria-label="Map data" data-testid="sb-map-data-panel" style={{ maxHeight: '70vh', overflowY: 'auto', width: 300 }}>
                    <div className="sb-cam-header">
                        <span>Map data</span>
                        <div className="sb-cam-row">
                            <button type="button" role="switch" aria-checked={on} aria-label="Map data view on" data-testid="sb-map-data-switch"
                                className={`sb-cam-switch ${on ? 'sb-cam-switch-on' : ''}`} onClick={() => set({ on: !on }, on ? 'clear_map_data_view' : 'set_map_data_view')}
                                title={on ? 'Turn the map data view off' : 'Show the scene as map data'}><span className="sb-cam-switch-knob" /></button>
                            <button type="button" className="sb-cam-close" onClick={() => setOpen(false)} aria-label="Close map data">×</button>
                        </div>
                    </div>
                    {!on && <div className="sb-cam-note">Shows the place as map data: the blob graph's groups, Google's roads, footprints, areas and places, and the roadmap. Switch it on.</div>}
                    {on && !state.anchor && <div className="sb-cam-note">This scene has no place (no geoAnchor and no blob graph anchor), so no map data can be placed.</div>}
                    <div className="sb-cam-section">{MAP_DATA_LAYERS.map(layerSwitch)}</div>
                    {on && (
                        <>
                            <div className="sb-cam-section" data-testid="sb-map-legend-blobs">
                                <div className="sb-cam-readout"><span>Blob groups</span><span className="sb-cam-value">{state.blobs.header ? `${state.blobs.header.blobs.length.toLocaleString('en-US')} blobs` : ''}</span></div>
                                {!state.blobGraphPath && <div className="sb-cam-note">No blob graph for this scene (none set, none beside its models).</div>}
                                {state.blobGraphPath && <div className="sb-cam-note">{status(state.blobs, `From ${state.blobGraphPath.split('/').slice(-2).join('/')}. Click a blob to read it; click a row to hide a group.`)}</div>}
                                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{state.blobs.legend.map(row)}</ul>
                                {state.picked && (
                                    <div className="sb-cam-note" data-testid="sb-map-picked-blob" style={{ marginTop: 6, color: '#e4e4e7' }}>
                                        <div><b>{state.picked.group}</b> · {state.picked.id}</div>
                                        {state.picked.description && <div>{state.picked.description}{state.picked.confidence !== undefined ? ` (confidence ${state.picked.confidence.toFixed(2)})` : ''}</div>}
                                        <div style={{ color: '#a1a1aa' }}>{state.picked.triangles.toLocaleString('en-US')} triangles{state.picked.featureId ? ` · vector feature ${state.picked.featureId}` : ''}{state.picked.description ? '' : ' · not read'}</div>
                                    </div>
                                )}
                            </div>
                            <div className="sb-cam-section" data-testid="sb-map-legend-vector">
                                <div className="sb-cam-readout"><span>Google vector data</span><span className="sb-cam-value">{ov ? `${ov.tiles} tiles${state.vector.cached ? ' · cached' : ''}` : ''}</span></div>
                                <div className="sb-cam-note">{status(state.vector, ov ? `${ov.roads.length} roads, ${ov.footprints.length} footprints, ${ov.areas.length} areas, ${ov.rails.length} rail lines, ${ov.pois.length} places within ${Math.round(ov.radiusM)} m.` : '')}</div>
                                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                                    <li style={{ display: 'flex', gap: 6 }}><Swatch colour={MAP_OVERLAY_COLOURS.centreline} line /><span>road centreline</span></li>
                                    <li style={{ display: 'flex', gap: 6 }}><Swatch colour={MAP_OVERLAY_COLOURS.carriagewayMeasured} /><span>carriageway, kerb measured on the scan</span></li>
                                    <li style={{ display: 'flex', gap: 6 }}><Swatch colour={MAP_OVERLAY_COLOURS.carriagewayDefaulted} /><span>carriageway, width defaulted (no kerb measured)</span></li>
                                    <li style={{ display: 'flex', gap: 6 }}><Swatch colour={MAP_OVERLAY_COLOURS.footprint} line /><span>building footprint</span></li>
                                    <li style={{ display: 'flex', gap: 6 }}><Swatch colour={MAP_OVERLAY_COLOURS.rail} line dashed /><span>rail</span></li>
                                </ul>
                                {state.vector.areas.length > 0 && <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0 }}>{state.vector.areas.map(row)}</ul>}
                                {ov && <div className="sb-cam-note" style={{ marginTop: 4 }}>{ov.provenance.widths}. {ov.provenance.ground}.</div>}
                            </div>
                            <div className="sb-cam-section" data-testid="sb-map-legend-roadmap">
                                <div className="sb-cam-readout"><span>Roadmap</span><span className="sb-cam-value">{Math.round((cfg?.roadmapOpacity ?? 0.7) * 100)}%</span></div>
                                <input type="range" min={0} max={1} step={0.05} value={cfg?.roadmapOpacity ?? 0.7} aria-label="Roadmap opacity" className="sb-cam-range"
                                    onChange={e => mutateSceneData(prev => setConfig(prev, { roadmapOpacity: Number(e.target.value) }), { operator: 'set_map_data_view' }, { history: false })} />
                                <div className="sb-cam-note">{layerOn(cfg, 'roadmap') ? status(state.roadmap, `${state.roadmap.tiles} Google Map Tiles (2D roadmap) draped on the measured ground. ${state.roadmap.attribution ?? ''}`) : 'Switch the roadmap layer on to drape Google\'s 2D roadmap on the ground.'}</div>
                            </div>
                            <div className="sb-cam-row" style={{ justifyContent: 'space-between' }}>
                                <span className="sb-cam-label" style={{ flex: 1, width: 'auto' }}>Hide the scene under the blob groups</span>
                                <button type="button" role="switch" aria-checked={cfg?.hideSceneUnderBlobs ?? true} aria-label="Hide the scene under the blob groups"
                                    className={`sb-cam-switch ${(cfg?.hideSceneUnderBlobs ?? true) ? 'sb-cam-switch-on' : ''}`} onClick={() => set({ hideSceneUnderBlobs: !(cfg?.hideSceneUnderBlobs ?? true) })}><span className="sb-cam-switch-knob" /></button>
                            </div>
                            <div className="sb-cam-note">Map data ©Google. Outlines and centrelines are vector-modelled; carriageway widths and ground heights are measured on the scan where it shows them.</div>
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
