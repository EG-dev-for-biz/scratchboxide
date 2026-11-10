/**
 * A Street View panorama at its full resolution, from the Map Tiles API (createSession with mapType streetview, then
 * /v1/streetview/metadata and /v1/streetview/tiles/z/x/y). The Street View Static API stops at 640 px a view; the tiles
 * hold the whole equirectangular panorama (16,384 x 8,192 px at zoom 5 for a current capture), halved per zoom below.
 *
 * Everything here stays in memory: the tiles are photographs and are never written, cached or logged.
 */

export interface StreetViewPanoTiles {
    panoId: string;
    zoom: number;
    /** The panorama's size at `zoom`, pixels, and its tiles' size. */
    width: number; height: number; tileSize: number;
    /** The capture's orientation as Google states it, degrees: compass heading of the panorama's centre, tilt (90 is level) and roll. */
    headingDeg: number; tiltDeg: number; rollDeg: number;
    tiles: Array<{ x: number; y: number; image: Buffer }>;
}

/** The zoom whose panorama is at least `minWidth` pixels wide (5 is the full capture). */
export function streetViewTileZoom(fullWidth: number, minWidth: number): number {
    let zoom = 5;
    while (zoom > 0 && (fullWidth >> (5 - (zoom - 1))) >= minWidth) zoom--;
    return zoom;
}

/** The tile grid of a panorama at a zoom: its size there and how many tiles cover it. */
export function streetViewTileGrid(fullWidth: number, fullHeight: number, tileSize: number, zoom: number): { width: number; height: number; nx: number; ny: number } {
    const width = fullWidth >> (5 - zoom), height = fullHeight >> (5 - zoom);
    return { width, height, nx: Math.ceil(width / tileSize), ny: Math.ceil(height / tileSize) };
}

const sessions = new Map<string, { id: string; expiresAt: number }>();

async function streetViewSession(apiKey: string, fetchImpl: typeof fetch): Promise<string> {
    const held = sessions.get(apiKey);
    if (held && held.expiresAt > Date.now() + 60_000) return held.id;
    const res = await fetchImpl(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mapType: 'streetview', language: 'en-US', region: 'US' })
    });
    const body = await res.json().catch(() => ({})) as { session?: string; expiry?: string; error?: { message?: string; status?: string } };
    if (!res.ok || !body.session) throw new Error(`Google refused a Map Tiles API Street View session (HTTP ${res.status}${body.error?.status ? `, ${body.error.status}` : ''})`);
    const expiry = Number(body.expiry);
    sessions.set(apiKey, { id: body.session, expiresAt: Number.isFinite(expiry) ? expiry * 1000 : Date.now() + 3_600_000 });
    return body.session;
}

/** The whole panorama at the zoom that gives at least `minWidth` pixels round the horizon, its tiles in memory. */
export async function fetchStreetViewPanoTiles(query: {
    panoId: string; apiKey: string; minWidth: number; fetchImpl?: typeof fetch; signal?: AbortSignal; concurrency?: number;
}): Promise<StreetViewPanoTiles> {
    const fetchImpl = query.fetchImpl ?? fetch;
    if (!query.apiKey) throw new Error('no Google Maps API key for the Street View tiles');
    const session = await streetViewSession(query.apiKey, fetchImpl);
    const auth = `session=${encodeURIComponent(session)}&key=${encodeURIComponent(query.apiKey)}`;
    const metaRes = await fetchImpl(`https://tile.googleapis.com/v1/streetview/metadata?${auth}&panoId=${encodeURIComponent(query.panoId)}`, { ...(query.signal ? { signal: query.signal } : {}) });
    if (!metaRes.ok) throw new Error(`Street View tile metadata failed: HTTP ${metaRes.status}`);
    const meta = await metaRes.json() as { imageWidth?: number; imageHeight?: number; tileWidth?: number; heading?: number; tilt?: number; roll?: number };
    if (!meta.imageWidth || !meta.imageHeight || !meta.tileWidth) throw new Error('Street View tile metadata names no image size');
    const zoom = streetViewTileZoom(meta.imageWidth, query.minWidth);
    const grid = streetViewTileGrid(meta.imageWidth, meta.imageHeight, meta.tileWidth, zoom);
    const wanted: Array<{ x: number; y: number }> = [];
    for (let y = 0; y < grid.ny; y++) for (let x = 0; x < grid.nx; x++) wanted.push({ x, y });
    const tiles: StreetViewPanoTiles['tiles'] = new Array(wanted.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const k = next++;
            if (k >= wanted.length) return;
            if (query.signal?.aborted) throw query.signal.reason ?? new Error('stopped');
            const { x, y } = wanted[k];
            const res = await fetchImpl(`https://tile.googleapis.com/v1/streetview/tiles/${zoom}/${x}/${y}?${auth}&panoId=${encodeURIComponent(query.panoId)}`, { ...(query.signal ? { signal: query.signal } : {}) });
            if (!res.ok) throw new Error(`Street View tile ${zoom}/${x}/${y} failed: HTTP ${res.status}`);
            tiles[k] = { x, y, image: Buffer.from(await res.arrayBuffer()) };
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(query.concurrency ?? 12, wanted.length)) }, worker));
    return {
        panoId: query.panoId, zoom, width: grid.width, height: grid.height, tileSize: meta.tileWidth,
        headingDeg: meta.heading ?? 0, tiltDeg: meta.tilt ?? 90, rollDeg: meta.roll ?? 0, tiles
    };
}
