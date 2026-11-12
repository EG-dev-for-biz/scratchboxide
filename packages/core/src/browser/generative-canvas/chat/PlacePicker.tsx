/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    PLACE_PICKER_MAX_RADIUS_M,
    PLACE_PICKER_MAX_ZOOM,
    PLACE_PICKER_MIN_RADIUS_M,
    PLACE_PICKER_MIN_ZOOM,
    PLACE_PICKER_PLACE_ZOOM,
    PLACE_PICKER_TILE_PX,
    PLACE_PICKER_WORLD_ZOOM,
    lngLatToViewport,
    metersPerPixel,
    panView,
    tilesForView,
    viewportToLngLat,
    zoomView,
    type MapView,
    type PlacePick,
    type PlacePickerRequest
} from '../../../common/spatial/place-picker';

/**
 * The map in the chat's question card: Google's 2D roadmap (the app's own tile route), dragged to pan, scrolled or
 * buttoned to zoom, clicked to drop the pin. A search box centres it on a place name or address. With a radius in the
 * request the pick is an area, drawn as a circle the slider resizes. The arithmetic is common/spatial/place-picker.ts.
 */

export interface PlacePickerProps {
    request: PlacePickerRequest;
    /** The pick so far (undefined until the user clicks the map or a search lands). */
    value: PlacePick | undefined;
    onChange: (pick: PlacePick | undefined) => void;
    /** A submitted card shows its pick and takes no input. */
    readOnly?: boolean;
}

const MAP_HEIGHT_PX = 300;
/** A press that moves less than this is a click (drop the pin), more is a drag (pan). */
const CLICK_SLOP_PX = 4;

const fieldStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    padding: '6px 10px',
    fontSize: '12px',
    borderRadius: '6px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    background: 'rgba(255, 255, 255, 0.04)',
    color: 'var(--sb-text-label, #f4f4f5)',
    outline: 'none'
};
const smallButton: React.CSSProperties = {
    padding: '6px 10px',
    fontSize: '11px',
    fontWeight: 600,
    borderRadius: '6px',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'rgba(255, 255, 255, 0.12)',
    background: 'rgba(255, 255, 255, 0.06)',
    color: 'var(--sb-text-label, #f4f4f5)',
    cursor: 'pointer'
};

export const PlacePicker: React.FC<PlacePickerProps> = ({ request, value, onChange, readOnly = false }) => {
    const area = request.radiusMeters !== undefined;
    const known = request.lat !== undefined && request.lng !== undefined;
    const [view, setView] = useState<MapView>(() => value
        ? { lat: value.lat, lng: value.lng, zoom: PLACE_PICKER_PLACE_ZOOM }
        : known
            ? { lat: request.lat!, lng: request.lng!, zoom: PLACE_PICKER_PLACE_ZOOM }
            : { lat: 20, lng: 0, zoom: PLACE_PICKER_WORLD_ZOOM });
    const [width, setWidth] = useState(520);
    const [search, setSearch] = useState(request.query ?? '');
    const [status, setStatus] = useState<string>('');
    const [busy, setBusy] = useState(false);
    const [failedTiles, setFailedTiles] = useState(0);
    const mapRef = useRef<HTMLDivElement>(null);
    const drag = useRef<{ x: number; y: number; moved: number; view: MapView } | null>(null);

    // the map is as wide as its card
    useEffect(() => {
        const el = mapRef.current;
        if (!el) return;
        const measure = () => setWidth(Math.max(200, Math.round(el.getBoundingClientRect().width)));
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const lookUp = useCallback(async (text: string) => {
        const q = text.trim();
        if (!q) return;
        setBusy(true);
        setStatus('Looking it up…');
        try {
            const res = await fetch(`/api/map-data/geocode?q=${encodeURIComponent(q)}`);
            const body = await res.json().catch(() => undefined) as { success?: boolean; lat?: number; lng?: number; formattedAddress?: string; name?: string; error?: string } | undefined;
            if (!res.ok || !body?.success || typeof body.lat !== 'number' || typeof body.lng !== 'number') {
                setStatus(body?.error ? `Not found: ${body.error}` : `Not found (HTTP ${res.status}). Click the map instead.`);
                return;
            }
            const address = [body.name, body.formattedAddress].filter(Boolean).join(', ');
            setView({ lat: body.lat, lng: body.lng, zoom: PLACE_PICKER_PLACE_ZOOM });
            onChange({ lat: body.lat, lng: body.lng, radiusMeters: area ? (value?.radiusMeters ?? request.radiusMeters) : undefined, address });
            setStatus(address);
        } catch (err) {
            setStatus(`The lookup failed: ${(err as Error).message}. Click the map instead.`);
        } finally {
            setBusy(false);
        }
    }, [area, onChange, request.radiusMeters, value?.radiusMeters]);

    // a place the chat named is looked up once, when the card opens and nothing is picked yet
    const lookedUp = useRef(false);
    useEffect(() => {
        if (lookedUp.current || readOnly || value) return;
        lookedUp.current = true;
        if (request.query && !known) void lookUp(request.query);
        else if (known) onChange({ lat: request.lat!, lng: request.lng!, radiusMeters: area ? request.radiusMeters : undefined });
    }, [area, known, lookUp, onChange, readOnly, request.lat, request.lng, request.query, request.radiusMeters, value]);

    const pointAt = (clientX: number, clientY: number) => {
        const rect = mapRef.current!.getBoundingClientRect();
        return { px: clientX - rect.left, py: clientY - rect.top };
    };

    const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, y: e.clientY, moved: 0, view };
    };
    const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        d.moved = Math.max(d.moved, Math.hypot(dx, dy));
        if (d.moved > CLICK_SLOP_PX) setView(panView(d.view, dx, dy));
    };
    const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        const d = drag.current;
        drag.current = null;
        if (!d || d.moved > CLICK_SLOP_PX || readOnly) return;
        const { px, py } = pointAt(e.clientX, e.clientY);
        const p = viewportToLngLat(view, width, MAP_HEIGHT_PX, px, py);
        // a pin moved by hand is no longer the searched address
        onChange({ lat: p.lat, lng: p.lng, radiusMeters: area ? (value?.radiusMeters ?? request.radiusMeters) : undefined });
        setStatus('');
    };
    const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
        const { px, py } = pointAt(e.clientX, e.clientY);
        setView(v => zoomView(v, e.deltaY < 0 ? 1 : -1, width, MAP_HEIGHT_PX, px, py));
    };

    const tiles = tilesForView(view, width, MAP_HEIGHT_PX);
    const pin = value ? lngLatToViewport(view, width, MAP_HEIGHT_PX, value.lng, value.lat) : undefined;
    const radiusPx = value?.radiusMeters ? value.radiusMeters / metersPerPixel(value.lat, Math.round(view.zoom)) : 0;
    const zoom = Math.round(view.zoom);

    return (
        <div className="sb-place-picker" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {request.message && (
                <div style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--sb-text-secondary, #cbd5e1)', overflowWrap: 'anywhere' }}>
                    {request.message}
                </div>
            )}
            {!readOnly && (
                <form
                    onSubmit={e => { e.preventDefault(); void lookUp(search); }}
                    style={{ display: 'flex', gap: '6px' }}
                >
                    <input
                        id="sb-place-picker-search"
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search a place or address, or click the map"
                        aria-label="Search a place or address"
                        style={fieldStyle}
                    />
                    <button type="submit" className="sb-btn sb-btn-xs sb-place-picker-find" disabled={busy || !search.trim()} style={{ ...smallButton, opacity: busy || !search.trim() ? 0.5 : 1 }}>
                        Find
                    </button>
                </form>
            )}

            <div
                ref={mapRef}
                role="application"
                aria-label="Map: drag to move, scroll to zoom, click to place the pin"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => { drag.current = null; }}
                onWheel={onWheel}
                style={{
                    position: 'relative',
                    height: `${MAP_HEIGHT_PX}px`,
                    overflow: 'hidden',
                    borderRadius: '8px',
                    borderWidth: '1px',
                    borderStyle: 'solid',
                    borderColor: 'rgba(255, 255, 255, 0.1)',
                    background: '#1f2937',
                    cursor: readOnly ? 'grab' : 'crosshair',
                    touchAction: 'none',
                    userSelect: 'none'
                }}
            >
                {tiles.map(t => (
                    <img
                        key={`${t.z}/${t.x}/${t.y}/${Math.round(t.left)}`}
                        src={`/api/map-data/roadmap/tile/${t.z}/${t.x}/${t.y}`}
                        alt=""
                        draggable={false}
                        onError={() => setFailedTiles(n => n + 1)}
                        style={{ position: 'absolute', left: `${t.left}px`, top: `${t.top}px`, width: `${PLACE_PICKER_TILE_PX}px`, height: `${PLACE_PICKER_TILE_PX}px`, maxWidth: 'none', pointerEvents: 'none' }}
                    />
                ))}

                {pin && radiusPx > 0 && (
                    <div style={{
                        position: 'absolute',
                        left: `${pin.x - radiusPx}px`,
                        top: `${pin.y - radiusPx}px`,
                        width: `${radiusPx * 2}px`,
                        height: `${radiusPx * 2}px`,
                        borderRadius: '50%',
                        borderWidth: '2px',
                        borderStyle: 'solid',
                        borderColor: '#2563eb',
                        background: 'rgba(37, 99, 235, 0.14)',
                        pointerEvents: 'none'
                    }} />
                )}
                {pin && (
                    <div style={{
                        position: 'absolute',
                        left: `${pin.x - 7}px`,
                        top: `${pin.y - 7}px`,
                        width: '14px',
                        height: '14px',
                        borderRadius: '50%',
                        background: '#ef4444',
                        borderWidth: '2px',
                        borderStyle: 'solid',
                        borderColor: '#ffffff',
                        boxShadow: '0 1px 4px rgba(0, 0, 0, 0.6)',
                        pointerEvents: 'none'
                    }} />
                )}

                <div style={{ position: 'absolute', right: '8px', top: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}
                    onPointerDown={e => e.stopPropagation()} onPointerUp={e => e.stopPropagation()}>
                    <button type="button" className="sb-btn sb-btn-xs sb-place-picker-zoom" aria-label="Zoom in" disabled={zoom >= PLACE_PICKER_MAX_ZOOM}
                        onClick={() => setView(v => zoomView(v, 1, width, MAP_HEIGHT_PX))}
                        style={{ ...smallButton, width: '28px', padding: '4px 0', background: 'rgba(17, 24, 39, 0.85)' }}>+</button>
                    <button type="button" className="sb-btn sb-btn-xs sb-place-picker-zoom" aria-label="Zoom out" disabled={zoom <= PLACE_PICKER_MIN_ZOOM}
                        onClick={() => setView(v => zoomView(v, -1, width, MAP_HEIGHT_PX))}
                        style={{ ...smallButton, width: '28px', padding: '4px 0', background: 'rgba(17, 24, 39, 0.85)' }}>−</button>
                </div>

                {failedTiles > 0 && failedTiles >= tiles.length && (
                    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', textAlign: 'center', fontSize: '12px', color: '#fca5a5', pointerEvents: 'none' }}>
                        The map could not be loaded (Google's map tiles were refused). Type the place or address in the chat instead.
                    </div>
                )}

                <div style={{ position: 'absolute', left: '6px', bottom: '4px', fontSize: '10px', color: '#111827', background: 'rgba(255, 255, 255, 0.75)', padding: '1px 5px', borderRadius: '3px', pointerEvents: 'none' }}>
                    Map data ©Google
                </div>
            </div>

            {area && value && !readOnly && (
                <label htmlFor="sb-place-picker-radius" style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', color: 'var(--sb-text-secondary, #cbd5e1)' }}>
                    <span style={{ flexShrink: 0 }}>Area radius</span>
                    <input
                        id="sb-place-picker-radius"
                        type="range"
                        min={PLACE_PICKER_MIN_RADIUS_M}
                        max={PLACE_PICKER_MAX_RADIUS_M}
                        step={10}
                        value={value.radiusMeters ?? request.radiusMeters}
                        onChange={e => onChange({ ...value, radiusMeters: Number(e.target.value) })}
                        style={{ flex: 1 }}
                    />
                    <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{Math.round(value.radiusMeters ?? request.radiusMeters ?? 0)} m</span>
                </label>
            )}

            <div style={{ fontSize: '11px', color: 'var(--sb-text-secondary, #94a3b8)', minHeight: '15px', overflowWrap: 'anywhere' }}>
                {value
                    ? `${value.lat.toFixed(5)}, ${value.lng.toFixed(5)}${value.radiusMeters ? ` · ${Math.round(value.radiusMeters)} m radius` : ''}${status ? ` · ${status}` : ''}`
                    : status || (readOnly ? '' : 'Nothing picked yet: search above, or drag and zoom the map and click the spot.')}
            </div>
        </div>
    );
};
