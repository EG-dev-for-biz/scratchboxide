/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { GooglePhotorealistic3DTilesLayer, type TilesLoadFailure } from '../../services/GooglePhotorealistic3DTilesLayer';
import { TerrainManager } from '../../services/TerrainManager';
import { resolveMapsApiKey } from '../../services/google-maps-service';
import type { RendererStack, Scene3DRenderMode, TilesLayerHandle } from './types';
import type { GroundTileMode } from '../../canvas-types';
import { checkLiveTilesAnchor, type LiveTilesAnchorInput } from './liveTilesAnchor';
import { liveTilesWindowRecorder, NO_MAPS_KEY_MESSAGE, type LiveTilesWindowRecorder } from './liveTilesStatus';

export interface TilesLayerInput {
    has3DTiles: boolean;
    /** Numbers, or numeric strings as some saved scenes hold them. */
    geoAnchor?: LiveTilesAnchorInput | null;
    renderMode: Scene3DRenderMode;
    groundTileMode?: GroundTileMode;
}

// Where the tiles go and whether that place is usable is decided in liveTilesAnchor.ts, which the mount tool shares.
export { liveTilesAnchor } from './liveTilesAnchor';

export interface TilesLayerCallbacks {
    onTileLoaded?: (terrainManager: TerrainManager) => void;
    /** The live layer exists and is placed at the anchor; it may arrive after syncTilesLayer returns (geoid lookup). */
    onLayerReady?: (tilesLayer: any, terrainManager: TerrainManager) => void;
    /**
     * The live layer was asked for but cannot be shown (no Maps key, a tileset Google refused or did not answer), or
     * cannot be placed; the message says why and, where the user can, how to fix it.
     */
    onError?: (message: string) => void;
    /** A placement problem reported through onError was resolved (the ground was measured after all). */
    onRecovered?: () => void;
}

export interface TilesLayerDeps {
    createLayer?: (options: ConstructorParameters<typeof GooglePhotorealistic3DTilesLayer>[0]) => any;
    /** EGM96 undulation (ellipsoid height minus sea level) at a point, in metres. Rejects when it cannot be looked up. */
    fetchGeoidUndulation?: (lat: number, lng: number) => Promise<number>;
    /** The window's Maps key for the tiles; '' when it has none. Defaults to the key Settings or the build holds. */
    mapsApiKey?: () => string;
    /** Where tileset outcomes are recorded for the chat (liveTilesStatus.ts). */
    windowStatus?: LiveTilesWindowRecorder;
}

async function fetchGeoidUndulationFromServer(lat: number, lng: number): Promise<number> {
    const r = await fetch(`/api/geo/geoid?lat=${lat}&lng=${lng}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (typeof j?.undulationMeters !== 'number') throw new Error('the response has no undulationMeters');
    return j.undulationMeters;
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** What a failed tiles load means for the user, from the HTTP status Google answered with (none: no answer). */
export function tilesLoadFailureMessage(failure: TilesLoadFailure): string {
    const subject = failure.root ? 'Google 3D Tiles did not load' : 'Some Google 3D Tiles did not load';
    const missing = failure.root ? '' : ', so parts of the place are missing';
    const status = failure.status;
    if (status === undefined) return `${subject}${missing}: Google could not be reached (${failure.detail}).`;
    // Google answers the root tileset 400 for a key that is not valid (API_KEY_INVALID), 403 for one not allowed the
    // Map Tiles API; the root request carries nothing else that could be invalid.
    const keyRefused = status === 401 || status === 403 || (status === 400 && failure.root);
    const why = keyRefused
        ? 'the Maps key was refused. Check in Settings > MCP Tools > Maps API Key that it is the right key, that the Map Tiles API is enabled for its project and that its restrictions allow this app'
        : status === 429 ? 'the Maps key\'s Map Tiles quota is used up for now'
        : status >= 500 ? 'Google\'s tiles service failed; it may work again later' : '';
    return `${subject} (HTTP ${status} from Google)${missing}${why ? `: ${why}` : ''}.`;
}

/** Ground below the origin is re-measured until it sits within this distance of y = 0. */
const GROUND_TOLERANCE_M = 0.25;
/** Each finer level of detail can move the measured ground; stop re-placing after this many corrections. */
const MAX_GROUND_CORRECTIONS = 12;
/**
 * The ground probe starts above any land on Earth (Everest is 8849 m) and reaches below any (the Dead Sea shore is
 * about -430 m), since with no elevation the layer starts at sea level and the ground can be anywhere in that range.
 * The terrain manager's default probe (from y = 2000 m) misses ground above it, such as La Paz at about 3600 m.
 */
const GROUND_PROBE_TOP_M = 9000;
const GROUND_PROBE_REACH_M = 10000;
/** Tile loads with no ground found under the origin before the unmeasured placement is reported. */
const GROUND_MISS_LIMIT = 32;

/**
 * Creates (or tears down) the Google Photorealistic 3D Tiles layer and the TerrainManager used for ground snapping.
 *
 * The layer is placed only at the scene's geoAnchor, and only once the geoid undulation there is known: the tiles are
 * in ellipsoid heights while the anchor elevation is above sea level, and the offset between them varies by up to
 * ~190 m worldwide. A missing, non-numeric, out-of-range or (0, 0) anchor, or a failed lookup, is reported through
 * onError and no tiles are shown. So is a window with no Maps key: no renderer is started that Google can only refuse.
 * A tileset Google refuses or does not answer is reported with its HTTP status, and nothing is drawn in its place.
 * When the anchor has no elevation, none is assumed: the ground under the origin is measured on the loaded tiles and
 * the layer is re-placed so that ground sits at y = 0.
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
                    tilesLayer.onLoadError = undefined;
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
    const check = checkLiveTilesAnchor(anchor);
    if (!check.ok) {
        callbacks.onError?.(check.missing
            ? 'Live 3D Tiles need the scene\'s geoAnchor (lat/lng), and this scene has none, so no tiles are shown.'
            : `Live 3D Tiles are not shown: ${check.reason}.`);
        return handle;
    }
    const { lat, lng, elevation } = check;
    const apiKey = (deps.mapsApiKey ?? resolveMapsApiKey)().trim();
    if (!apiKey) {
        callbacks.onError?.(NO_MAPS_KEY_MESSAGE);
        return handle;
    }
    const windowStatus = deps.windowStatus ?? liveTilesWindowRecorder;
    // With no elevation the layer starts at sea level and is re-placed on the measured ground (see measureGround).
    const origin = { lat, lng, alt: elevation ?? 0 };
    const isClay = mode === 'photoreal-clay' || (mode !== 'photoreal-textured' && input.renderMode === 'clay');
    const createLayer = deps.createLayer ?? (options => new GooglePhotorealistic3DTilesLayer(options));

    let groundCorrections = 0;
    let groundFound = false;
    let groundMisses = 0;
    let groundMissReported = false;
    /** A load failure was reported: it stands, and no placement report replaces or clears it. */
    let loadFailed = false;
    let tileLoaded = false;
    /** Ground height under the origin on the loaded tiles, probing from above any land; null when nothing is hit. */
    const sampleOriginGround = (layer: any): number | null => {
        const terrain = typeof layer.getTerrainManager === 'function' ? layer.getTerrainManager(scene) : undefined;
        const h = typeof terrain?.sampleGroundHeight === 'function'
            ? terrain.sampleGroundHeight(0, 0, 4, GROUND_PROBE_TOP_M, GROUND_PROBE_REACH_M)
            : typeof layer.sampleGroundHeight === 'function' ? layer.sampleGroundHeight(0, 0) : null;
        return typeof h === 'number' && Number.isFinite(h) ? h : null;
    };
    const measureGround = (layer: any, geoidHeight: number) => {
        if (elevation !== undefined || groundCorrections >= MAX_GROUND_CORRECTIONS || loadFailed) return;
        const h = sampleOriginGround(layer);
        if (h === null) {
            // No elevation and no ground found yet: the tiles' height is unknown. Said once, not assumed.
            if (!groundFound && ++groundMisses >= GROUND_MISS_LIMIT && !groundMissReported) {
                groundMissReported = true;
                callbacks.onError?.(`Google 3D Tiles are placed at sea level: the scene's geoAnchor has no elevation and no ground was found under ${lat.toFixed(5)}, ${lng.toFixed(5)} on the loaded tiles, so they may sit above or below the camera.`);
            }
            return;
        }
        groundFound = true;
        if (groundMissReported) {
            groundMissReported = false;
            callbacks.onRecovered?.();
        }
        if (Math.abs(h) <= GROUND_TOLERANCE_M) return;
        origin.alt += h;
        groundCorrections++;
        layer.updateOrigin?.({ ...origin }, geoidHeight);
    };

    const place = (geoidHeight: number) => {
        if (disposed) return;
        try {
            const layer = createLayer({ apiKey, origin: { ...origin }, renderMode: isClay ? 'clay' : 'textured', clayPreset: 'studio-grey', geoidHeight });
            tilesLayer = layer;
            handle.tilesLayer = layer;
            scene.add(layer.group);
            const terrainManager: TerrainManager = layer.getTerrainManager(scene);
            handle.terrainManager = terrainManager;
            layer.onTileLoaded = () => {
                if (!tileLoaded) {
                    tileLoaded = true;
                    windowStatus.loaded();
                }
                measureGround(layer, geoidHeight);
                callbacks.onTileLoaded?.(terrainManager);
            };
            // The first failure is reported (a refused key fails every request alike); the root's also tells the chat.
            layer.onLoadError = (failure: TilesLoadFailure) => {
                if (disposed || loadFailed) return;
                loadFailed = true;
                const message = tilesLoadFailureMessage(failure);
                if (failure.root) windowStatus.failed(apiKey, message);
                callbacks.onError?.(message);
            };
            callbacks.onLayerReady?.(layer, terrainManager);
        } catch (err) {
            callbacks.onError?.(`Google 3D Tiles could not start: ${errorText(err)}`);
        }
    };

    const knownUndulation = anchor?.geoidUndulationMeters;
    if (typeof knownUndulation === 'number') {
        place(knownUndulation);
    } else {
        (deps.fetchGeoidUndulation ?? fetchGeoidUndulationFromServer)(origin.lat, origin.lng)
            .then(undulation => place(undulation))
            .catch(err => {
                if (!disposed) callbacks.onError?.(`Google 3D Tiles are not shown: the geoid height at ${origin.lat.toFixed(5)}, ${origin.lng.toFixed(5)} could not be looked up (${errorText(err)}), so tile heights are unknown.`);
            });
    }
    return handle;
}
