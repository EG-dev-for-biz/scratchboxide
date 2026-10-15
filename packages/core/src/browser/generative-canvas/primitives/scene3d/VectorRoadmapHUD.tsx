/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React, { useState, useEffect, useMemo } from 'react';
import type { VectorRoadmapConfig } from '../../canvas-types';
import { GoogleMapsService, GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE } from '../../services/google-maps-service';

export interface VectorRoadmapHUDProps {
    config?: VectorRoadmapConfig;
    geoAnchor?: {
        lat: number;
        lng: number;
        elevation?: number;
        elevationSource?: string;
        datum?: string;
        landmarkName?: string;
        active?: boolean;
    } | null;
    cameraHeading?: number;
    onUpdateConfig: (updated: Partial<VectorRoadmapConfig>) => void;
    onResetCameraToAnchor?: () => void;
    isOpen: boolean;
    onToggleOpen: () => void;
}

/** Writes text to the clipboard and says whether it worked (and why not), so the button never claims a failed copy. */
export async function copyTextToClipboard(
    text: string,
    clipboard: Pick<Clipboard, 'writeText'> | undefined = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!clipboard) return { ok: false, error: 'the clipboard is not available here' };
    try {
        await clipboard.writeText(text);
        return { ok: true };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

export const VectorRoadmapHUD: React.FC<VectorRoadmapHUDProps> = ({
    config,
    geoAnchor,
    cameraHeading = 0,
    onUpdateConfig,
    onResetCameraToAnchor,
    isOpen,
    onToggleOpen
}) => {
    const mapsService = useMemo(() => GoogleMapsService.getInstance(), []);
    const [copyState, setCopyState] = useState<{ ok: true } | { ok: false; error: string } | null>(null);
    const [showStyleModal, setShowStyleModal] = useState(false);
    const [inputMapId, setInputMapId] = useState(config?.mapId || mapsService.getVectorRoadmapMapId() || '');
    const [zoomLevel, setZoomLevel] = useState(config?.minimapZoom ?? 17);

    // Sync inputMapId if changed externally
    useEffect(() => {
        if (config?.mapId !== undefined && config.mapId !== inputMapId) {
            setInputMapId(config.mapId);
        }
    }, [config?.mapId]);

    const groundEnabled = config?.groundBlueprint ?? true;
    const blueprintOpacity = config?.groundBlueprintOpacity ?? 0.85;
    const blueprintSize = config?.groundBlueprintSize ?? 500;
    const elevationOffset = config?.groundElevationOffset ?? -0.05;

    // The scene's own anchor or none: no default place is shown as the anchor.
    const anchor = geoAnchor && Number.isFinite(geoAnchor.lat) && Number.isFinite(geoAnchor.lng)
        ? { lat: geoAnchor.lat, lng: geoAnchor.lng }
        : null;
    const elevation = anchor ? geoAnchor?.elevation : undefined;

    // Static preview image for the minimap, at the anchor only.
    const previewUrl = useMemo(() => {
        if (!anchor) return null;
        return mapsService.getVectorRoadmapStaticBlueprintUrl({
            center: anchor,
            zoom: zoomLevel,
            size: { width: 320, height: 220 },
            scale: 2,
            mapId: config?.mapId || mapsService.getVectorRoadmapMapId()
        });
    }, [mapsService, anchor?.lat, anchor?.lng, zoomLevel, config?.mapId]);

    const handleCopyStyleJson = async () => {
        const result = await copyTextToClipboard(JSON.stringify(GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE, null, 2));
        setCopyState(result);
        setTimeout(() => setCopyState(null), result.ok ? 2500 : 6000);
    };

    const handleApplyMapId = () => {
        const trimmed = inputMapId.trim();
        mapsService.setVectorRoadmapMapId(trimmed);
        onUpdateConfig({ mapId: trimmed });
    };

    if (!isOpen) return null;

    return (
        <div className="sb-3d-vector-roadmap-hud absolute top-16 right-4 z-30 w-84 max-h-[88vh] flex flex-col rounded-2xl bg-[#0f1117]/95 backdrop-blur-2xl border border-cyan-500/30 shadow-2xl p-4 animate-fadeIn text-zinc-200 pointer-events-auto select-none overflow-y-auto custom-scrollbar">
            {/* Header */}
            <div className="flex items-center justify-between pb-2.5 border-b border-white/10">
                <div className="flex items-center gap-2">
                    <span className="text-base">🗺️</span>
                    <div>
                        <div className="flex items-center gap-1.5">
                            <h3 className="text-xs font-semibold text-cyan-300 tracking-wide uppercase">Vector Roadmap</h3>
                            <span className="px-1.5 py-0.2 rounded text-[9px] bg-cyan-950/80 text-cyan-400 border border-cyan-700/50 font-mono">
                                NO LABELS
                            </span>
                        </div>
                        <p className="text-[10px] text-zinc-400">Google Cloud-Based Map Styling · Blueprint Underlay</p>
                    </div>
                </div>
                <button
                    type="button"
                    onClick={onToggleOpen}
                    className="sb-btn sb-btn-ghost p-1 rounded-md text-zinc-400 hover:text-white hover:bg-white/10 transition-all text-xs"
                    title="Close Roadmap HUD"
                >
                    ✕
                </button>
            </div>

            {/* Minimap Viewport */}
            <div className="relative mt-3 w-full h-44 rounded-xl overflow-hidden border border-cyan-500/30 bg-zinc-950 shadow-inner group">
                {previewUrl ? (
                    <img
                        src={previewUrl}
                        alt="Vector Roadmap Blueprint Reference"
                        className="w-full h-full object-cover select-none pointer-events-none transition-transform duration-300"
                    />
                ) : (
                    <div data-testid="sb-roadmap-no-anchor" className="w-full h-full flex items-center justify-center p-4 text-center text-[11px] text-zinc-400">
                        This scene has no geoAnchor, so there is no place to show a map of.
                    </div>
                )}

                {/* Compass & Camera Reticle */}
                <div
                    className="absolute inset-0 flex items-center justify-center pointer-events-none"
                    style={{
                        transform: `rotate(${cameraHeading}deg)`,
                        transition: 'transform 0.1s ease-out'
                    }}
                >
                    {/* View Frustum Cone */}
                    <div
                        className="w-0 h-0 border-l-[18px] border-l-transparent border-r-[18px] border-r-transparent border-b-[36px] border-b-cyan-400/40 opacity-70 -translate-y-4 filter drop-shadow-[0_0_6px_rgba(6,182,212,0.8)]"
                    />
                    {/* Center Ring & Crosshair */}
                    <div className="absolute w-4 h-4 rounded-full border-2 border-cyan-300 bg-cyan-500/50 shadow-[0_0_8px_rgba(6,182,212,0.9)]" />
                </div>

                {/* North Heading Indicator */}
                <div className="absolute top-2 left-2 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-md border border-white/10 text-[9px] font-mono text-cyan-300 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                    <span>HDG: {Math.round(cameraHeading)}°</span>
                </div>

                {/* Minimap Zoom Controls */}
                <div className="absolute bottom-2 right-2 flex flex-col gap-1">
                    <button
                        type="button"
                        onClick={() => {
                            const newZ = Math.min(20, zoomLevel + 1);
                            setZoomLevel(newZ);
                            onUpdateConfig({ minimapZoom: newZ });
                        }}
                        className="sb-btn sb-btn-xs w-6 h-6 rounded bg-black/75 hover:bg-zinc-800 border border-white/20 text-white flex items-center justify-center text-xs font-bold transition-all shadow-md active:scale-95"
                        title="Zoom In"
                    >
                        +
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            const newZ = Math.max(12, zoomLevel - 1);
                            setZoomLevel(newZ);
                            onUpdateConfig({ minimapZoom: newZ });
                        }}
                        className="sb-btn sb-btn-xs w-6 h-6 rounded bg-black/75 hover:bg-zinc-800 border border-white/20 text-white flex items-center justify-center text-xs font-bold transition-all shadow-md active:scale-95"
                        title="Zoom Out"
                    >
                        −
                    </button>
                </div>

                {/* Coordinate & Ground Elevation Badge */}
                {anchor && (
                    <div className="absolute bottom-2 left-2 px-2 py-0.5 rounded bg-black/75 backdrop-blur-md border border-white/10 text-[9px] font-mono text-zinc-300 flex items-center gap-1.5">
                        <span>{anchor.lat.toFixed(4)}°, {anchor.lng.toFixed(4)}°</span>
                        {elevation !== undefined && (
                            <span className="text-cyan-400 font-semibold border-l border-white/20 pl-1.5" title={`Anchor elevation (${geoAnchor?.elevationSource || 'source not recorded'})`}>
                                {elevation.toFixed(1)}m MSL
                            </span>
                        )}
                    </div>
                )}
            </div>

            {/* Quick Actions */}
            <div className="mt-2.5 flex items-center gap-2">
                {onResetCameraToAnchor && (
                    <button
                        type="button"
                        onClick={onResetCameraToAnchor}
                        className="sb-btn flex-1 py-1 px-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-cyan-300 hover:text-cyan-200 text-[11px] font-medium flex items-center justify-center gap-1.5 transition-all shadow-sm"
                        title="Align 3D Viewport to Geo-Anchor Coordinates"
                    >
                        <span>🎯</span>
                        <span>Focus Geo-Anchor</span>
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => setShowStyleModal(!showStyleModal)}
                    className="sb-btn py-1 px-2.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-zinc-300 hover:text-white text-[11px] font-medium flex items-center justify-center gap-1 transition-all shadow-sm"
                    title="View Cloud-Based Map Styling JSON & Setup"
                >
                    <span>⚙️</span>
                    <span>Style JSON</span>
                </button>
            </div>

            {/* Ground Blueprint Underlay Controls */}
            <div className="mt-3 pt-3 border-t border-white/10 space-y-2.5">
                <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-zinc-200">
                        <input
                            type="checkbox"
                            checked={groundEnabled}
                            onChange={(e) => onUpdateConfig({ groundBlueprint: e.target.checked })}
                            className="rounded accent-cyan-500 w-3.5 h-3.5"
                        />
                        <span>Ground Blueprint Mesh</span>
                    </label>
                    <span className="text-[10px] text-zinc-400 font-mono">
                        {elevation !== undefined ? `${elevation.toFixed(1)}m MSL (y = ${elevationOffset.toFixed(2)}m)` : `y = ${elevationOffset.toFixed(2)}m`}
                    </span>
                </div>

                {groundEnabled && (
                    <div className="space-y-2 pl-2 border-l border-cyan-500/20 text-[11px]">
                        {/* Opacity Slider */}
                        <div>
                            <div className="flex justify-between text-zinc-400 text-[10px]">
                                <span>Blueprint Opacity</span>
                                <span className="font-mono text-cyan-300">{Math.round(blueprintOpacity * 100)}%</span>
                            </div>
                            <input
                                type="range"
                                min="0.1"
                                max="1.0"
                                step="0.05"
                                value={blueprintOpacity}
                                onChange={(e) => onUpdateConfig({ groundBlueprintOpacity: parseFloat(e.target.value) })}
                                className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                            />
                        </div>

                        {/* Size (Footprint) Slider */}
                        <div>
                            <div className="flex justify-between text-zinc-400 text-[10px]">
                                <span>Ground Footprint Size</span>
                                <span className="font-mono text-cyan-300">{blueprintSize}m</span>
                            </div>
                            <input
                                type="range"
                                min="100"
                                max="2000"
                                step="50"
                                value={blueprintSize}
                                onChange={(e) => onUpdateConfig({ groundBlueprintSize: parseInt(e.target.value, 10) })}
                                className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                            />
                        </div>

                        {/* Elevation Offset Slider */}
                        <div>
                            <div className="flex justify-between text-zinc-400 text-[10px]">
                                <span>Vertical Ground Offset</span>
                                <span className="font-mono text-cyan-300">{elevationOffset.toFixed(2)}m</span>
                            </div>
                            <input
                                type="range"
                                min="-2.0"
                                max="5.0"
                                step="0.05"
                                value={elevationOffset}
                                onChange={(e) => onUpdateConfig({ groundElevationOffset: parseFloat(e.target.value) })}
                                className="w-full h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
                            />
                        </div>
                    </div>
                )}
            </div>

            {/* Google Cloud Vector Map ID Configuration */}
            <div className="mt-3 pt-3 border-t border-white/10 space-y-2">
                <label className="text-[11px] font-semibold text-zinc-300 flex items-center justify-between">
                    <span>Google Cloud Map ID</span>
                    <span className="text-[9px] text-cyan-400/80 font-mono">Vector Styling</span>
                </label>
                <div className="flex gap-1.5">
                    <input
                        type="text"
                        placeholder="e.g. 78a48b32948e30f1"
                        value={inputMapId}
                        onChange={(e) => setInputMapId(e.target.value)}
                        className="flex-1 bg-zinc-900 text-zinc-200 text-[11px] rounded-lg px-2.5 py-1.5 border border-white/10 focus:border-cyan-500/60 focus:outline-none font-mono"
                    />
                    <button
                        type="button"
                        onClick={handleApplyMapId}
                        className="sb-btn px-3 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-medium text-[11px] transition-all shadow-md active:scale-95"
                    >
                        Apply
                    </button>
                </div>
            </div>

            {/* Style JSON Modal / Drawer */}
            {showStyleModal && (
                <div className="mt-3 pt-3 border-t border-cyan-500/30 bg-zinc-950/80 rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] font-semibold text-cyan-300">Cloud-Based Map Styling JSON</span>
                        <button
                            type="button"
                            onClick={handleCopyStyleJson}
                            className="sb-btn sb-btn-xs px-2 py-0.5 rounded bg-cyan-950 hover:bg-cyan-900 border border-cyan-500/40 text-cyan-300 text-[10px] font-medium transition-all"
                        >
                            {copyState?.ok ? '✓ Copied!' : 'Copy JSON'}
                        </button>
                    </div>
                    {copyState && !copyState.ok && (
                        <div role="alert" className="text-[10px] text-red-300">Copy failed: {copyState.error}</div>
                    )}
                    <pre className="text-[9px] font-mono text-zinc-300 bg-black/60 p-2 rounded-lg border border-white/5 overflow-x-auto max-h-36">
                        {JSON.stringify(GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE, null, 2)}
                    </pre>
                    <p className="text-[9px] text-zinc-400 leading-tight">
                        Import this JSON into <strong className="text-zinc-300">Google Cloud Console &gt; Map Management &gt; Map Styles</strong>, associate it with a Vector Map ID, and paste the Map ID above.
                    </p>
                </div>
            )}
        </div>
    );
};
