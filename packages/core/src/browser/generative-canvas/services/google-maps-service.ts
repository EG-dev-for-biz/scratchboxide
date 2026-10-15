/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { LocationUnresolvedError, MissingInputError } from '../../../common/errors/pipeline-errors';
import { assertUsableCoordinates, formatCoordinates, parseCoordinateText } from '../../../common/coordinate/parse-coordinates';

export type GoogleMapType = 'roadmap' | 'satellite' | 'terrain' | 'hybrid';

/** Google Places API (New) Text Search: the one geocoder for place names and addresses. */
export const PLACES_TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
export const PLACES_TEXT_SEARCH_FIELD_MASK = 'places.displayName,places.formattedAddress,places.location,places.viewport,places.types';

/**
 * The Maps Platform key for a call, from the same sources the rest of the app reads, in this order: a key
 * passed by the caller, the key saved in Settings (GoogleMapsService, which also reads the build-time
 * GOOGLE_MAPS_API_KEY / MAP_TILES_API_KEY), then the process environment at call time (on the server the
 * secrets file is loaded into GOOGLE_MAPS_API_KEY / MAP_TILES_API_KEY after this module may have loaded).
 * Returns '' when there is none.
 */
export function resolveMapsApiKey(explicit?: string): string {
    const fromEnv = typeof process !== 'undefined' && process.env
        ? process.env.GOOGLE_MAPS_API_KEY || process.env.MAP_TILES_API_KEY || ''
        : '';
    return (explicit || GoogleMapsService.getInstance().getApiKey() || fromEnv || '').trim();
}

/**
 * Why a Places API (New) request was refused, for the error the user sees. Google's own message is always included.
 * A 403 / PERMISSION_DENIED has several causes that only the key's owner can fix; the structured reason Google
 * returns in error.details picks the advice, and without one every cause is listed (it is not always the API).
 */
function describePlacesRefusal(operation: string, status: number, body: any): string {
    const apiStatus = typeof body?.error?.status === 'string' ? body.error.status : '';
    const message = typeof body?.error?.message === 'string' ? body.error.message : '';
    const base = `${operation} returned HTTP ${status}${apiStatus ? ` ${apiStatus}` : ''}${message ? `: ${message}` : ''}`;
    if (status !== 403 && apiStatus !== 'PERMISSION_DENIED') return base;
    const details: any[] = Array.isArray(body?.error?.details) ? body.error.details : [];
    const reason: string = details.map(d => (typeof d?.reason === 'string' ? d.reason : '')).find(Boolean) || '';
    const advice: Record<string, string> = {
        SERVICE_DISABLED: 'enable "Places API (New)" (places.googleapis.com) in the key\'s Google Cloud project',
        API_KEY_SERVICE_BLOCKED: 'the key\'s API restrictions leave out "Places API (New)"; add it to them',
        BILLING_DISABLED: 'enable billing on the key\'s Google Cloud project',
        API_KEY_HTTP_REFERRER_BLOCKED: 'the key only allows certain websites (HTTP referrers), so this caller is blocked; use a key whose application restrictions allow it',
        API_KEY_IP_ADDRESS_BLOCKED: 'the key only allows certain IP addresses, so this caller is blocked; allow this machine\'s address or use another key',
        API_KEY_ANDROID_APP_BLOCKED: 'the key is restricted to Android apps; use a key whose application restrictions allow this caller',
        API_KEY_IOS_APP_BLOCKED: 'the key is restricted to iOS apps; use a key whose application restrictions allow this caller'
    };
    const fix = advice[reason] || 'check that "Places API (New)" (places.googleapis.com) is enabled in the key\'s Google Cloud project and allowed by the key\'s API restrictions, that billing is enabled, and that the key\'s application restrictions (websites, IP addresses) allow this caller';
    return `${base}. Google refused this Maps key${reason ? ` (${reason})` : ''}: ${fix}.`;
}

export interface GeocodeOptions {
    /** Maps Platform key; defaults to the configured key. */
    apiKey?: string;
    /** Injected for tests; defaults to the global fetch. */
    fetchImpl?: typeof fetch;
}

export interface GeocodeResult {
    lat: number;
    lng: number;
    /** Google's formatted address for a place, or the exact coordinates for a coordinate query. */
    formattedAddress: string;
    /** Google's display name for the place (Places Text Search), when the query was a place name. */
    name?: string;
    placeId?: string;
    /** How the location was obtained: 'COORDINATES' or 'PLACES_TEXT_SEARCH'. */
    locationType?: string;
    /** Metres above sea level, only when the query stated it. Places results carry no elevation. */
    elevation?: number;
    zoom?: number;
    /** Places types of the matched place (e.g. "tourist_attraction"). */
    types?: string[];
    bounds?: {
        north: number;
        south: number;
        east: number;
        west: number;
    };
}

export interface GooglePlaceFeature {
    id: string;
    displayName: string;
    primaryType: string;
    lat: number;
    lng: number;
    formattedAddress?: string;
    rating?: number;
}

export interface StaticMapMarker {
    lat: number;
    lng: number;
    color?: string;
    size?: 'tiny' | 'mid' | 'small' | 'normal';
    label?: string;
    iconUrl?: string;
}

export interface StaticMapPath {
    points: Array<{ lat: number; lng: number }>;
    color?: string; // e.g. 0x00ff88ff or 0xff0000ff
    weight?: number; // pixel width
    fillcolor?: string;
    geodesic?: boolean;
}

export interface StaticMapOptions {
    center?: string | { lat: number; lng: number };
    zoom?: number;
    size?: { width: number; height: number };
    scale?: 1 | 2;
    maptype?: GoogleMapType;
    format?: 'png' | 'png8' | 'png32' | 'gif' | 'jpg' | 'jpg-baseline';
    markers?: StaticMapMarker[];
    paths?: StaticMapPath[];
    style?: string[];
    mapId?: string;
    apiKey?: string;
}

/**
 * Official Google Cloud-Based Map Styling JSON to suppress all labels across the entire map
 * (POIs, road names, transit, cities/boundaries, and natural features) while preserving crisp vector geometry.
 */
export const GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE = {
    variant: 'light',
    styles: [
        {
            id: 'political',
            label: {
                visible: false
            }
        },
        {
            id: 'pointOfInterest',
            label: {
                visible: false
            }
        },
        {
            id: 'infrastructure',
            label: {
                visible: false
            }
        },
        {
            id: 'natural',
            label: {
                visible: false
            }
        }
    ]
} as const;

/**
 * Equivalent legacy / Static Maps API style URL parameters to hide all labels across the map.
 */
export const STATIC_MAPS_NO_LABELS_STYLES: string[] = [
    'feature:all|element:labels|visibility:off'
];

export interface EmbedMapOptions {
    mode?: 'place' | 'view' | 'directions' | 'streetview' | 'search';
    q?: string;
    center?: { lat: number; lng: number };
    zoom?: number;
    maptype?: 'roadmap' | 'satellite';
    origin?: string | { lat: number; lng: number };
    destination?: string | { lat: number; lng: number };
    waypoints?: Array<string | { lat: number; lng: number }>;
    avoid?: string;
    fov?: number;
    heading?: number;
    pitch?: number;
    apiKey?: string;
}

export interface Photorealistic3DTilesConfig {
    rootTilesetUrl: string;
    sessionToken?: string;
    apiKey?: string;
    center: {
        lat: number;
        lng: number;
        elevation?: number;
    };
    defaultCamera: {
        heading: number;
        pitch: number;
        range: number;
    };
}

export interface GoogleMapsState {
    apiKey: string;
    status: 'ready' | 'missing_key' | 'loading' | 'error';
    vectorRoadmapMapId?: string;
    lastQuery?: string;
    lastResolvedPlace?: GeocodeResult;
    error?: string;
    staticMapCount: number;
    embedMapCount: number;
}

const STORAGE_KEY = 'scratchbox_google_maps_api_key_v1';

export class GoogleMapsService {
    private static instance: GoogleMapsService;

    private elevationCache: Map<string, number> = new Map();

    private state: GoogleMapsState = {
        apiKey: '',
        status: 'missing_key',
        staticMapCount: 0,
        embedMapCount: 0
    };

    private listeners: Set<(state: GoogleMapsState) => void> = new Set();

    private constructor() {
        this.initializeKeyResolution();
    }

    public static getInstance(): GoogleMapsService {
        if (!GoogleMapsService.instance) {
            GoogleMapsService.instance = new GoogleMapsService();
        }
        return GoogleMapsService.instance;
    }

    private initializeKeyResolution(): void {
        let resolvedKey = '';

        // 1. Check environment variables
        if (typeof process !== 'undefined' && process.env) {
            // Only the browser-safe Maps/Tiles key is compiled into the bundle (see desktop-app/vite.config.ts `define`).
            resolvedKey = process.env.GOOGLE_MAPS_API_KEY ||
                          process.env.MAP_TILES_API_KEY ||
                          process.env.VITE_GOOGLE_MAPS_API_KEY ||
                          process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
                          '';
        }

        // 2. Check localStorage (Browser context)
        if (!resolvedKey && typeof window !== 'undefined' && window.localStorage) {
            try {
                const storedKey = window.localStorage.getItem(STORAGE_KEY) ||
                                  window.localStorage.getItem('GOOGLE_MAPS_API_KEY') ||
                                  window.localStorage.getItem('sb_google_maps_key');
                if (storedKey && storedKey.trim()) {
                    resolvedKey = storedKey.trim();
                }
            } catch (e) {
                // Ignore localStorage errors
            }
        }

        let resolvedMapId = '';
        if (typeof process !== 'undefined' && process.env) {
            resolvedMapId = process.env.GOOGLE_MAPS_MAP_ID ||
                            process.env.VITE_GOOGLE_MAPS_MAP_ID ||
                            '';
        }
        if (!resolvedMapId && typeof window !== 'undefined' && window.localStorage) {
            try {
                const storedMapId = window.localStorage.getItem('scratchbox_vector_roadmap_map_id');
                if (storedMapId && storedMapId.trim()) {
                    resolvedMapId = storedMapId.trim();
                }
            } catch (e) {
                // Ignore localStorage errors
            }
        }

        this.state = {
            apiKey: resolvedKey,
            status: resolvedKey ? 'ready' : 'missing_key',
            vectorRoadmapMapId: resolvedMapId || undefined,
            staticMapCount: 0,
            embedMapCount: 0
        };
    }

    public getVectorRoadmapMapId(): string | undefined {
        return this.state.vectorRoadmapMapId;
    }

    public setVectorRoadmapMapId(mapId: string): void {
        const trimmed = (mapId || '').trim();
        this.state.vectorRoadmapMapId = trimmed || undefined;
        if (typeof window !== 'undefined' && window.localStorage) {
            try {
                if (trimmed) {
                    window.localStorage.setItem('scratchbox_vector_roadmap_map_id', trimmed);
                } else {
                    window.localStorage.removeItem('scratchbox_vector_roadmap_map_id');
                }
            } catch (e) {
                // Ignore localStorage errors
            }
        }
        this.notifyListeners();
    }

    public getState(): GoogleMapsState {
        return { ...this.state };
    }

    public getApiKey(): string {
        return this.state.apiKey;
    }

    public hasApiKey(): boolean {
        return Boolean(this.state.apiKey && this.state.apiKey.trim().length > 0);
    }

    public getStatus(): 'ready' | 'missing_key' | 'loading' | 'error' {
        return this.state.status;
    }

    public setApiKey(key: string): void {
        const trimmed = (key || '').trim();
        this.state.apiKey = trimmed;
        this.state.status = trimmed ? 'ready' : 'missing_key';
        this.state.error = undefined;

        // Persist to localStorage if available
        if (typeof window !== 'undefined' && window.localStorage) {
            try {
                if (trimmed) {
                    window.localStorage.setItem(STORAGE_KEY, trimmed);
                } else {
                    window.localStorage.removeItem(STORAGE_KEY);
                }
            } catch (e) {
                // Ignore storage errors
            }
        }

        this.notifyListeners();
    }

    public subscribe(listener: (state: GoogleMapsState) => void): () => void {
        this.listeners.add(listener);
        listener(this.getState());
        return () => {
            this.listeners.delete(listener);
        };
    }

    private notifyListeners(): void {
        const currentState = this.getState();
        this.listeners.forEach(listener => {
            try {
                listener(currentState);
            } catch (e) {
                console.error('Error in GoogleMapsService listener:', e);
            }
        });
    }

    /** The key for a Maps Platform call; see resolveMapsApiKey. */
    private resolveKey(explicit?: string): string {
        return resolveMapsApiKey(explicit);
    }

    /**
     * Resolves a place name, address or coordinate string to one location.
     *
     * Text that is entirely a coordinate pair is used as given. Anything else is one Google Places API (New)
     * Text Search call, and the top result is returned with Google's own formatted address and display name,
     * so callers can show exactly what was resolved. There is no built-in place table and no substring
     * matching: no key, an HTTP error or no result throws LocationUnresolvedError.
     */
    public async geocode(query: string, options: GeocodeOptions = {}): Promise<GeocodeResult> {
        const cleanQuery = (query || '').trim();
        if (!cleanQuery) {
            throw new LocationUnresolvedError('', 'the location query is empty');
        }

        const coords = parseCoordinateText(cleanQuery);
        if (coords) {
            assertUsableCoordinates(coords.lat, coords.lng, cleanQuery);
            return this.remember(cleanQuery, {
                lat: coords.lat,
                lng: coords.lng,
                formattedAddress: formatCoordinates(coords.lat, coords.lng),
                locationType: 'COORDINATES',
                ...(coords.elevation !== undefined ? { elevation: coords.elevation } : {})
            });
        }

        const key = this.resolveKey(options.apiKey);
        if (!key) {
            throw new LocationUnresolvedError(
                cleanQuery,
                'no Google Maps API key is configured, so place names cannot be looked up (add the key in Settings, or give coordinates as "lat, lng")'
            );
        }
        const fetchImpl = options.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
        if (!fetchImpl) {
            throw new LocationUnresolvedError(cleanQuery, 'this runtime has no fetch, so Google Places cannot be called');
        }

        let response: Response;
        try {
            response = await fetchImpl(PLACES_TEXT_SEARCH_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': key,
                    'X-Goog-FieldMask': PLACES_TEXT_SEARCH_FIELD_MASK
                },
                body: JSON.stringify({ textQuery: cleanQuery, pageSize: 1 })
            });
        } catch (err) {
            throw new LocationUnresolvedError(cleanQuery, `the Google Places request failed: ${err instanceof Error ? err.message : String(err)}`);
        }

        const body: any = await response.json().catch(() => undefined);
        if (!response.ok) {
            throw new LocationUnresolvedError(cleanQuery, describePlacesRefusal('Google Places Text Search', response.status, body));
        }
        const place = Array.isArray(body?.places) ? body.places[0] : undefined;
        const lat = place?.location?.latitude;
        const lng = place?.location?.longitude;
        if (typeof lat !== 'number' || typeof lng !== 'number') {
            throw new LocationUnresolvedError(cleanQuery, 'Google Places found no place for this text');
        }

        const name: string | undefined = typeof place.displayName?.text === 'string' ? place.displayName.text : undefined;
        const viewport = place.viewport;
        const result: GeocodeResult = {
            lat,
            lng,
            formattedAddress: typeof place.formattedAddress === 'string' && place.formattedAddress ? place.formattedAddress : (name || formatCoordinates(lat, lng)),
            ...(name ? { name } : {}),
            ...(Array.isArray(place.types) ? { types: place.types } : {}),
            locationType: 'PLACES_TEXT_SEARCH',
            ...(viewport?.low && viewport?.high ? {
                bounds: {
                    north: viewport.high.latitude,
                    south: viewport.low.latitude,
                    east: viewport.high.longitude,
                    west: viewport.low.longitude
                }
            } : {})
        };
        return this.remember(cleanQuery, result);
    }

    private remember(query: string, result: GeocodeResult): GeocodeResult {
        this.state.lastResolvedPlace = result;
        this.state.lastQuery = query;
        this.notifyListeners();
        return result;
    }

    /**
     * Ground elevation (metres above sea level) at a coordinate from the Google Elevation API.
     * Throws when there is no key or the API gives no value; it never estimates one.
     */
    public async getElevation(lat: number, lng: number, options: GeocodeOptions = {}): Promise<number> {
        const cleanLat = Number(lat.toFixed(6));
        const cleanLng = Number(lng.toFixed(6));
        const cacheKey = `${cleanLat.toFixed(4)},${cleanLng.toFixed(4)}`;
        const cached = this.elevationCache.get(cacheKey);
        if (cached !== undefined) return cached;

        const key = this.resolveKey(options.apiKey);
        if (!key) {
            throw new Error(`No Google Maps API key is configured, so the ground elevation at ${formatCoordinates(cleanLat, cleanLng)} cannot be looked up.`);
        }
        const fetchImpl = options.fetchImpl ?? fetch;
        const endpoint = `https://maps.googleapis.com/maps/api/elevation/json?locations=${cleanLat},${cleanLng}&key=${encodeURIComponent(key)}`;
        const response = await fetchImpl(endpoint);
        const data: any = await response.json().catch(() => undefined);
        const value = data?.results?.[0]?.elevation;
        if (!response.ok || typeof value !== 'number') {
            const status = data?.status ? ` ${data.status}` : '';
            throw new Error(`Google Elevation API gave no elevation at ${formatCoordinates(cleanLat, cleanLng)} (HTTP ${response.status}${status}).`);
        }
        const elevation = Number(value.toFixed(2));
        this.elevationCache.set(cacheKey, elevation);
        return elevation;
    }

    /**
     * Query Google Places API (New) nearby search for POIs. Throws when there is no key or the request fails.
     */
    public async fetchNearbyPlaces(
        centerLat: number,
        centerLng: number,
        radiusMeters: number = 500,
        options: GeocodeOptions = {}
    ): Promise<GooglePlaceFeature[]> {
        const key = this.resolveKey(options.apiKey);
        if (!key) {
            throw new Error('No Google Maps API key is configured, so nearby places cannot be looked up.');
        }
        const fetchImpl = options.fetchImpl ?? fetch;
        const response = await fetchImpl('https://places.googleapis.com/v1/places:searchNearby', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': key,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.primaryType,places.formattedAddress,places.rating'
            },
            body: JSON.stringify({
                locationRestriction: {
                    circle: {
                        center: { latitude: centerLat, longitude: centerLng },
                        radius: radiusMeters
                    }
                },
                maxResultCount: 20
            })
        });
        const data: any = await response.json().catch(() => undefined);
        if (!response.ok) {
            throw new Error(describePlacesRefusal('Google Places Nearby Search', response.status, data));
        }
        const places: any[] = Array.isArray(data?.places) ? data.places : [];
        return places
            .filter(p => typeof p?.location?.latitude === 'number' && typeof p?.location?.longitude === 'number')
            .map(p => ({
                id: p.id,
                displayName: p.displayName?.text ?? '',
                primaryType: p.primaryType ?? '',
                lat: p.location.latitude,
                lng: p.location.longitude,
                formattedAddress: p.formattedAddress,
                rating: p.rating
            }));
    }


    /**
     * Generate Google Static Maps URL with markers, paths, and styles
     */
    public getStaticMapUrl(options: StaticMapOptions): string {
        const key = this.resolveKey(options.apiKey);
        const width = options.size?.width || 600;
        const height = options.size?.height || 400;
        const zoom = options.zoom !== undefined ? options.zoom : 15;
        const maptype = options.maptype || 'roadmap';
        const scale = options.scale || 2;

        let centerParam = '';
        if (typeof options.center === 'string') {
            centerParam = encodeURIComponent(options.center);
        } else if (options.center && typeof options.center.lat === 'number') {
            centerParam = `${options.center.lat},${options.center.lng}`;
        } else if (options.markers && options.markers.length > 0) {
            centerParam = `${options.markers[0].lat},${options.markers[0].lng}`;
        } else {
            throw new MissingInputError('getStaticMapUrl', 'center or markers', 'there is no default map location');
        }

        // Without a key the URL carries none and Google answers with its own "missing key" error image; a drawn
        // stand-in map is never returned in its place.

        const params: string[] = [];
        params.push(`center=${centerParam}`);
        params.push(`zoom=${zoom}`);
        params.push(`size=${width}x${height}`);
        params.push(`scale=${scale}`);
        params.push(`maptype=${maptype}`);
        if (options.format) {
            params.push(`format=${options.format}`);
        }

        // Add Markers
        if (options.markers && options.markers.length > 0) {
            options.markers.forEach(m => {
                const parts: string[] = [];
                if (m.color) parts.push(`color:${m.color}`);
                if (m.size) parts.push(`size:${m.size}`);
                if (m.label) parts.push(`label:${m.label}`);
                if (m.iconUrl) parts.push(`icon:${encodeURIComponent(m.iconUrl)}`);
                parts.push(`${m.lat},${m.lng}`);
                params.push(`markers=${encodeURIComponent(parts.join('|'))}`);
            });
        }

        // Add Paths / Splines
        if (options.paths && options.paths.length > 0) {
            options.paths.forEach(p => {
                const parts: string[] = [];
                if (p.color) parts.push(`color:${p.color}`);
                if (p.weight) parts.push(`weight:${p.weight}`);
                if (p.fillcolor) parts.push(`fillcolor:${p.fillcolor}`);
                if (p.geodesic) parts.push('geodesic:true');
                p.points.forEach(pt => parts.push(`${pt.lat},${pt.lng}`));
                params.push(`path=${encodeURIComponent(parts.join('|'))}`);
            });
        }

        // Add Styles
        if (options.style && options.style.length > 0) {
            options.style.forEach(st => params.push(`style=${encodeURIComponent(st)}`));
        }

        // Add Cloud-Based Map Styling Map ID
        if (options.mapId) {
            params.push(`map_id=${encodeURIComponent(options.mapId)}`);
        }

        if (key) {
            params.push(`key=${encodeURIComponent(key)}`);
        }

        this.state.staticMapCount++;
        return `https://maps.googleapis.com/maps/api/staticmap?${params.join('&')}`;
    }

    /**
     * Generate a high-resolution Vector ROADMAP Ground Blueprint URL with all labels suppressed
     * using the Google Maps Static API and Cloud-Based Map Styling / Map ID.
     */
    public getVectorRoadmapStaticBlueprintUrl(options: {
        center: { lat: number; lng: number } | string;
        zoom?: number;
        size?: { width: number; height: number } | number;
        scale?: 1 | 2;
        mapId?: string;
    }): string {
        const sizeObj = typeof options.size === 'number'
            ? { width: options.size, height: options.size }
            : options.size || { width: 1024, height: 1024 };

        const mapId = options.mapId || this.state.vectorRoadmapMapId;

        return this.getStaticMapUrl({
            center: options.center,
            zoom: options.zoom !== undefined ? options.zoom : 17,
            size: sizeObj,
            scale: options.scale || 2,
            maptype: 'roadmap',
            format: 'png',
            mapId,
            // If mapId is not configured yet, fallback to explicit label-off style parameter
            style: mapId ? undefined : STATIC_MAPS_NO_LABELS_STYLES
        });
    }

    /**
     * Return the official Google Cloud-Based Map Styling JSON to suppress all labels across the entire map
     */
    public getCloudMapStylingJson() {
        return GOOGLE_CLOUD_ROADMAP_NO_LABELS_STYLE;
    }


    /**
     * Generate Google Maps Interactive Embed iframe URL
     */
    public getEmbedMapUrl(options: EmbedMapOptions): string {
        const key = this.resolveKey(options.apiKey);
        const mode = options.mode || 'place';
        const params: string[] = [];
        const point = (value: string | { lat: number; lng: number } | undefined, arg: string): string => {
            if (typeof value === 'string' && value.trim()) return value;
            if (value && typeof value === 'object') return `${value.lat},${value.lng}`;
            throw new MissingInputError('getEmbedMapUrl', arg, `the ${mode} embed has no default location`);
        };

        if (mode === 'place') {
            const query = point(options.q || options.center, 'q or center');
            params.push(`q=${encodeURIComponent(query)}`);
            if (options.zoom) params.push(`zoom=${options.zoom}`);
            if (options.maptype) params.push(`maptype=${options.maptype}`);
        } else if (mode === 'view') {
            const center = point(options.center, 'center');
            params.push(`center=${encodeURIComponent(center)}`);
            if (options.zoom) params.push(`zoom=${options.zoom || 14}`);
            if (options.maptype) params.push(`maptype=${options.maptype || 'roadmap'}`);
        } else if (mode === 'directions') {
            const originStr = point(options.origin, 'origin');
            const destStr = point(options.destination, 'destination');
            params.push(`origin=${encodeURIComponent(originStr)}`);
            params.push(`destination=${encodeURIComponent(destStr)}`);
            if (options.waypoints && options.waypoints.length > 0) {
                const wpStr = options.waypoints.map(wp => typeof wp === 'string' ? wp : `${wp.lat},${wp.lng}`).join('|');
                params.push(`waypoints=${encodeURIComponent(wpStr)}`);
            }
        } else if (mode === 'streetview') {
            const loc = point(options.center, 'center');
            params.push(`location=${encodeURIComponent(loc)}`);
            if (options.heading !== undefined) params.push(`heading=${options.heading}`);
            if (options.pitch !== undefined) params.push(`pitch=${options.pitch}`);
            if (options.fov !== undefined) params.push(`fov=${options.fov}`);
        }

        if (key) {
            params.push(`key=${encodeURIComponent(key)}`);
        }

        this.state.embedMapCount++;
        return `https://www.google.com/maps/embed/v1/${mode}?${params.join('&')}`;
    }

    /**
     * Get Photorealistic 3D Tiles configuration datum for 3D Viewport / Cesium
     */
    public getPhotorealistic3DTilesConfig(center: { lat: number; lng: number; elevation?: number }): Photorealistic3DTilesConfig {
        const key = this.state.apiKey;
        return {
            rootTilesetUrl: `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(key || '')}`,
            apiKey: key,
            center: {
                lat: center.lat,
                lng: center.lng,
                elevation: center.elevation || 0
            },
            defaultCamera: {
                heading: 0,
                pitch: -35,
                range: 1200
            }
        };
    }

    /**
     * Get Google Street View Static API image URL
     */
    public getStreetViewStaticUrl(options: {
        location: { lat: number; lng: number } | string;
        size?: { width: number; height: number };
        heading?: number;
        pitch?: number;
        fov?: number;
    }): string {
        const key = this.state.apiKey;
        const width = options.size?.width || 640;
        const height = options.size?.height || 640;
        const loc = typeof options.location === 'string'
            ? options.location
            : `${options.location.lat},${options.location.lng}`;
        const params: string[] = [
            `size=${width}x${height}`,
            `location=${encodeURIComponent(loc)}`,
            `fov=${options.fov ?? 90}`,
            `heading=${options.heading ?? 0}`,
            `pitch=${options.pitch ?? 10}`
        ];
        if (key) params.push(`key=${encodeURIComponent(key)}`);
        return `https://maps.googleapis.com/maps/api/streetview?${params.join('&')}`;
    }

    /**
     * Google Maps Aerial View API video lookup. 'NOT_FOUND' is the API's own answer for a place without a
     * video; a missing key or any other failure throws.
     */
    public async fetchAerialViewVideo(addressOrCoords: string | { lat: number; lng: number }, options: GeocodeOptions = {}): Promise<{
        state: 'PROCESSING' | 'ACTIVE' | 'NOT_FOUND';
        uris?: {
            mp4Medium?: string;
            mp4High?: string;
            hls?: string;
        };
        metadata?: {
            videoId?: string;
            captureDate?: string;
            duration?: string;
        };
    }> {
        const key = this.resolveKey(options.apiKey);
        if (!key) {
            throw new Error('No Google Maps API key is configured, so the Aerial View API cannot be called.');
        }
        const queryParam = typeof addressOrCoords === 'string'
            ? `address=${encodeURIComponent(addressOrCoords)}`
            : `latitude=${addressOrCoords.lat}&longitude=${addressOrCoords.lng}`;
        const fetchImpl = options.fetchImpl ?? fetch;
        const response = await fetchImpl(`https://aerialview.googleapis.com/v1/videos:lookupVideo?${queryParam}&key=${encodeURIComponent(key)}`);
        if (response.status === 404) {
            return { state: 'NOT_FOUND' };
        }
        const data: any = await response.json().catch(() => undefined);
        if (!response.ok) {
            const detail = typeof data?.error?.message === 'string' ? `: ${data.error.message}` : '';
            throw new Error(`Google Aerial View API returned HTTP ${response.status}${detail}`);
        }
        return {
            state: data?.state || 'ACTIVE',
            uris: {
                mp4High: data?.uris?.MP4_HIGH?.landscapeUri || data?.uris?.MP4_HIGH?.portraitUri,
                mp4Medium: data?.uris?.MP4_MEDIUM?.landscapeUri,
                hls: data?.uris?.HLS?.landscapeUri
            },
            metadata: {
                videoId: data?.metadata?.videoId,
                captureDate: data?.metadata?.captureDate,
                duration: data?.metadata?.duration
            }
        };
    }

    /**
     * Google Solar API building insights (roof segments with pitch, azimuth and sunshine) for the building
     * closest to a coordinate. Returns the API's own answer; a missing key, no coverage or any failure throws.
     */
    public async fetchBuildingSolarInsights(coords: { lat: number; lng: number }, options: GeocodeOptions = {}): Promise<{
        name: string;
        center: { latitude: number; longitude: number };
        solarPotential?: {
            maxArrayPanelsCount: number;
            panelCapacityWatts: number;
            roofSegmentStats: Array<{
                pitchDegrees: number;
                azimuthDegrees: number;
                stats: { areaMeters2: number; sunshineQuantiles: number[] };
                center: { latitude: number; longitude: number };
                boundingBox: { sw: { latitude: number; longitude: number }; ne: { latitude: number; longitude: number } };
            }>;
        };
    }> {
        const key = this.resolveKey(options.apiKey);
        if (!key) {
            throw new Error('No Google Maps API key is configured, so the Solar API cannot be called.');
        }
        const params = new URLSearchParams({
            'location.latitude': coords.lat.toFixed(6),
            'location.longitude': coords.lng.toFixed(6),
            key
        });
        const fetchImpl = options.fetchImpl ?? fetch;
        const response = await fetchImpl(`https://solar.googleapis.com/v1/buildingInsights:findClosest?${params}`);
        const data: any = await response.json().catch(() => undefined);
        if (!response.ok || !data?.center) {
            const detail = typeof data?.error?.message === 'string' ? `: ${data.error.message}` : '';
            throw new Error(`Google Solar API gave no building insights at ${formatCoordinates(coords.lat, coords.lng)} (HTTP ${response.status}${detail}).`);
        }
        return data;
    }
}
