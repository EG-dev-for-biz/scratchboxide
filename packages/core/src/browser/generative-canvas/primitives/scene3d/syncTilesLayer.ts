/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { GooglePhotorealistic3DTilesLayer } from '../../services/GooglePhotorealistic3DTilesLayer';
import { TerrainManager } from '../../services/TerrainManager';
import type { RendererStack, Scene3DRenderMode, TilesLayerHandle } from './types';
import type { GroundTileMode } from '../../canvas-types';

export interface TilesLayerInput {
    has3DTiles: boolean;
    geoAnchor?: { lat: number; lng: number; elevation?: number; geoidUndulationMeters?: number } | null;
    renderMode: Scene3DRenderMode;
    groundTileMode?: GroundTileMode;
}

export interface TilesLayerCallbacks {
    onTileLoaded?: (terrainManager: TerrainManager) => void;
    /** The live layer exists and is placed at the anchor; it may arrive after syncTilesLayer returns (geoid lookup). */
    onLayerReady?: (tilesLayer: any, terrainManager: TerrainManager) => void;
    /** The live layer was asked for but cannot be shown; the message says why. */
    onError?: (message: string) => void;
}

export interface TilesLayerDeps {
    createLayer?: (options: ConstructorParameters<typeof GooglePhotorealistic3DTilesLayer>[0]) => any;
    /** EGM96 undulation (ellipsoid height minus sea level) at a point, in metres. Rejects when it cannot be looked up. */
    fetchGeoidUndulation?: (lat: number, lng: number) => Promise<number>;
}

async function fetchGeoidUndulationFromServer(lat: number, lng: number): Promise<number> {
    const r = await fetch(`/api/geo/geoid?lat=${lat}&lng=${lng}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (typeof j?.undulationMeters !== 'number') throw new Error('the response has no undulationMeters');
    return j.undulationMeters;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Creates (or tears down) the Google Photorealistic 3D Tiles layer and the TerrainManager used for ground snapping.
 *
 * The layer is placed only at the scene's geoAnchor, and only once the geoid undulation there is known: the tiles are
 * in ellipsoid heights while the anchor elevation is above sea level, and the offset between them varies by up to
 * ~190 m worldwide. A missing anchor or a failed lookup is reported through onError and no tiles are shown.
 * A scene-local TerrainManager always exists so callers have something to sample ground height from.
 */
export function syncTilesLayer(
    stack: RendererStack,
    input: TilesLayerInput,
    callbacks: TilesLayerCallbacks = {},
    deps: TilesLayerDeps = {}
): TilesLayerHandle {
    const { scene } = stack;
    let tilesLayer: any | null = null;
    let disposed = false;
    const handle: TilesLayerHandle = {
        tilesLayer: null,
        terrainManager: new TerrainManager({ scene }),
        dispose: () => {
            disposed = true;
            if (tilesLayer) {
                try {
                    tilesLayer.onTileLoaded = undefined;
                    if (tilesLayer.group) scene.remove(tilesLayer.group);
                    tilesLayer.dispose?.();
                } catch (e) {
                    console.warn('[Google 3D Tiles Layer Dispose Warning]:', e);
                }
            }
        }
    };

    const mode = input.groundTileMode;
    const isSuppressed = mode === 'none' || mode === 'vector-roadmap-blueprint' || mode === 'vector-world-clay';
    if (!input.has3DTiles || isSuppressed) return handle;

    const anchor = input.geoAnchor;
    if (!anchor || !Number.isFinite(anchor.lat) || !Number.isFinite(anchor.lng)) {
        callbacks.onError?.('Live 3D Tiles need the scene\'s geoAnchor (lat/lng), and this scene has none, so no tiles are shown.');
        return handle;
    }
    const origin = { lat: anchor.lat, lng: anchor.lng, alt: anchor.elevation ?? 0 };
    const isClay = mode === 'photoreal-clay' || (mode !== 'photoreal-textured' && input.renderMode === 'clay');
    const createLayer = deps.createLayer ?? (options => new GooglePhotorealistic3DTilesLayer(options));

    const place = (geoidHeight: number) => {
        if (disposed) return;
        try {
            const layer = createLayer({ origin, renderMode: isClay ? 'clay' : 'textured', clayPreset: 'studio-grey', geoidHeight });
            tilesLayer = layer;
            handle.tilesLayer = layer;
            scene.add(layer.group);
            const terrainManager: TerrainManager = layer.getTerrainManager(scene);
            handle.terrainManager = terrainManager;
            layer.onTileLoaded = () => callbacks.onTileLoaded?.(terrainManager);
            callbacks.onLayerReady?.(layer, terrainManager);
        } catch (err) {
            callbacks.onError?.(`Google 3D Tiles could not start: ${errorText(err)}`);
        }
    };

    if (typeof anchor.geoidUndulationMeters === 'number') {
        place(anchor.geoidUndulationMeters);
    } else {
        (deps.fetchGeoidUndulation ?? fetchGeoidUndulationFromServer)(origin.lat, origin.lng)
            .then(undulation => place(undulation))
            .catch(err => {
                if (!disposed) callbacks.onError?.(`Google 3D Tiles are not shown: the geoid height at ${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)} could not be looked up (${errorText(err)}), so tile heights are unknown.`);
            });
    }
    return handle;
}
