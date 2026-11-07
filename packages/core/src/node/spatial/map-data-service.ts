/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What the viewport's Map data view reads (common/spatial/map-data-view.ts), served by the desktop app's map data routes:
 *
 * - blob groups: a blob graph's per-triangle blob labels with the scan mesh they index (loadScanMesh numbering, the
 *   numbering the blob split wrote them in), so the triangle order is the split's by construction;
 * - the vector overlay: Google vector data around the place (vector-footprints.ts fetchVectorEvidence, first-party),
 *   with the carriageways measured kerb to kerb on the scan (road-surfaces.ts) and the measured ground to drape on
 *   (buildGroundModel) when a scan is given; cached per place and scan on disk;
 * - the 2D roadmap: Google Map Tiles API roadmap tiles, through one session, cached on disk.
 *
 * Type codes pass through as labels. Nothing here chooses geometry by a code.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    BLOB_GROUPS_SCHEMA, MAP_VECTOR_SCHEMA, blobGroupsHeaderOf, encodeFloat32B64, roadmapTilesFor,
    type BlobGraphFile, type BlobGroupsPayload, type MapVec2, type MapVectorOverlay, type RoadmapTilePlacement
} from '../../common/spatial/map-data-view';
import { evidenceLookup, fetchVectorEvidence, type VectorBuilding, type VectorEvidence } from '../3d-engine/staged-location/vector-footprints';
import { measureRoadSurfaces } from '../3d-engine/staged-location/road-surfaces';
import { buildGroundModel, loadScanMesh, surfaceModel } from './StreetViewSurveyPlanner';

export const MAP_DATA_VERSION = 'map-data/v1';

// ------------------------------------------------------------------------------------------------ blob groups

/** Where a blob graph's labels and mesh are: labels in split/labels.bin (or beside it), the mesh its source, else welded.glb beside. */
export function blobGraphFiles(blobGraphPath: string, graph: BlobGraphFile): { labels: string; mesh: string } {
    const dir = path.dirname(blobGraphPath);
    const labels = [path.join(dir, 'split', 'labels.bin'), path.join(dir, 'labels.bin')].find(p => fs.existsSync(p));
    if (!labels) throw new Error(`No per-triangle labels beside the blob graph (looked for split/labels.bin and labels.bin in ${dir}).`);
    const named = graph.source?.welded;
    const mesh = [named && fs.existsSync(named) ? named : undefined, named ? path.join(dir, path.basename(named)) : undefined, path.join(dir, 'welded.glb')]
        .find((p): p is string => !!p && fs.existsSync(p));
    if (!mesh) throw new Error(`The blob graph's mesh was not found (${named ?? 'no source.welded'}; nor welded.glb in ${dir}).`);
    return { labels, mesh };
}

const blobCache = new Map<string, { key: string; payload: BlobGroupsPayload }>();

/**
 * The blob groups of a blob graph: its scan mesh and one blob index per triangle. `guard` resolves a path the graph
 * names (the mesh) and throws when it is outside what the caller may read.
 */
export function loadBlobGroups(blobGraphPath: string, guard: (p: string) => string = p => p): BlobGroupsPayload {
    const graph = JSON.parse(fs.readFileSync(blobGraphPath, 'utf8')) as BlobGraphFile;
    if (!Array.isArray(graph.blobs)) throw new Error(`${blobGraphPath} is not a blob graph (no blobs array).`);
    const files = blobGraphFiles(blobGraphPath, graph);
    const mesh = guard(files.mesh), labels = guard(files.labels);
    const key = [blobGraphPath, mesh, labels].map(p => `${p}:${fs.statSync(p).mtimeMs}:${fs.statSync(p).size}`).join('|');
    const hit = blobCache.get(blobGraphPath);
    if (hit && hit.key === key) return hit.payload;
    const scan = loadScanMesh(mesh);
    const lb = fs.readFileSync(labels);
    const triBlob = new Int32Array(lb.buffer.slice(lb.byteOffset, lb.byteOffset + lb.byteLength));
    if (triBlob.length !== scan.triCount) {
        throw new Error(`The blob labels (${triBlob.length} triangles) do not match the mesh ${path.basename(mesh)} (${scan.triCount} triangles): they were written for another extraction.`);
    }
    const positions = scan.mesh.vertices instanceof Float32Array ? scan.mesh.vertices : new Float32Array(scan.mesh.vertices as ArrayLike<number>);
    const indices = scan.mesh.indices instanceof Uint32Array ? scan.mesh.indices : new Uint32Array(scan.mesh.indices as ArrayLike<number>);
    const header = blobGroupsHeaderOf(graph, triBlob, { path: mesh, vertices: positions.length / 3, triangles: scan.triCount }, blobGraphPath);
    const payload: BlobGroupsPayload = { header, positions, indices, triBlob };
    blobCache.set(blobGraphPath, { key, payload });
    return payload;
}

/** A blob graph beside a model: blob_graph.json in the model's folder whose mesh is that model. */
export function discoverBlobGraph(modelPath: string): string | undefined {
    const candidate = path.join(path.dirname(modelPath), 'blob_graph.json');
    if (!fs.existsSync(candidate)) return undefined;
    try {
        const graph = JSON.parse(fs.readFileSync(candidate, 'utf8')) as BlobGraphFile;
        if (!Array.isArray(graph.blobs)) return undefined;
        return path.resolve(blobGraphFiles(candidate, graph).mesh) === path.resolve(modelPath) ? candidate : undefined;
    } catch {
        return undefined;
    }
}

export { BLOB_GROUPS_SCHEMA };

// ------------------------------------------------------------------------------------------------ vector overlay

/** A building's plan outlines: its extruded parts' loops, else the outer edges of its modelled volumes seen from above. */
export function footprintLoops(b: VectorBuilding): MapVec2[][] {
    if (b.extruded?.length) return b.extruded.flatMap(e => e.loops);
    // the parts of a volume-only building are its plan triangles: their boundary edges (edges used once) are the outline
    const key = (p: MapVec2) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`;
    const edges = new Map<string, { a: MapVec2; b: MapVec2; n: number }>();
    for (const part of b.parts) for (const loop of part) {
        for (let i = 0; i < loop.length; i++) {
            const a = loop[i], c = loop[(i + 1) % loop.length];
            const ka = key(a), kc = key(c);
            if (ka === kc) continue;
            const k = ka < kc ? `${ka}|${kc}` : `${kc}|${ka}`;
            const e = edges.get(k);
            if (e) e.n++; else edges.set(k, { a, b: c, n: 1 });
        }
    }
    return [...edges.values()].filter(e => e.n === 1).map(e => [e.a, e.b]);
}

export interface MapVectorOptions {
    lat: number; lng: number; radiusM: number;
    /** The scan (a staged extraction or its weld) in the same frame: the carriageways and the ground are measured on it. */
    scanPath?: string;
    fetchTile: Parameters<typeof fetchVectorEvidence>[0]['fetchTile'];
    /** Where overlays are cached (one JSON per place, radius and scan). */
    cacheDir?: string;
}

export function mapVectorCacheKey(o: Pick<MapVectorOptions, 'lat' | 'lng' | 'radiusM' | 'scanPath'>): string {
    const scan = o.scanPath && fs.existsSync(o.scanPath) ? `${path.resolve(o.scanPath)}:${fs.statSync(o.scanPath).size}:${fs.statSync(o.scanPath).mtimeMs}` : 'no-scan';
    return crypto.createHash('sha256').update([MAP_DATA_VERSION, o.lat.toFixed(6), o.lng.toFixed(6), Math.round(o.radiusM), scan].join('|')).digest('hex').slice(0, 20);
}

/** The overlay from vector evidence already fetched (the testable part): outlines, areas, rails, POIs, and with a scan the measurements. */
export function overlayFromEvidence(ev: VectorEvidence, o: Pick<MapVectorOptions, 'lat' | 'lng' | 'radiusM' | 'scanPath'>): MapVectorOverlay {
    const out: MapVectorOverlay = {
        schema: MAP_VECTOR_SCHEMA,
        origin: { lat: o.lat, lng: o.lng },
        radiusM: o.radiusM,
        zoom: ev.zoom,
        tiles: ev.tiles,
        roads: ev.roads.map((points, i) => ({ points, types: ev.roadTypes?.[i] ?? [] })),
        carriageways: [],
        footprints: ev.buildings.map(b => ({ id: b.id, loops: footprintLoops(b), ...(b.heightM !== undefined ? { heightM: b.heightM } : {}) })).filter(f => f.loops.length > 0),
        areas: [
            ...ev.water.map(loops => ({ loops, types: ['FEATURE_TYPE_NATURAL', 'FEATURE_TYPE_WATER'] })),
            ...(ev.landuse ?? []).map(a => ({ loops: a.loops, types: a.types }))
        ],
        rails: ev.rails ?? [],
        pois: ev.pois ?? [],
        provenance: {
            vector: `Google vector data (vectortiles.featuretiles), zoom ${ev.zoom}, ${ev.tiles} tiles: outlines and centrelines are vector-modelled`,
            widths: 'no scan given: road centrelines only, no widths',
            ground: 'no scan given: drawn at the origin\'s ground level'
        }
    };
    if (!o.scanPath) return out;
    const scan = loadScanMesh(o.scanPath);
    const look = evidenceLookup(ev, o.radiusM);
    const ground = buildGroundModel(scan, { cellMeters: 1, water: look.waterAt, road: look.roadAt });
    const { min, max } = scan.bounds;
    const within = (x: number, z: number) => x >= min[0] && x <= max[0] && z >= min[2] && z <= max[2];
    const centrelines = ev.roads.filter(l => l.some(([x, z]) => within(x, z)));
    const roads = centrelines.length ? measureRoadSurfaces({ roads: centrelines, grid: { ...surfaceModel(scan, 0.5), cellM: 0.5 }, within, buildingAt: look.buildingAt, groundAt: ground.groundAt }) : [];
    out.carriageways = roads.map(r => ({
        id: r.id,
        measuredKerbShare: Math.round(r.measuredKerbShare * 1000) / 1000,
        stations: r.stations.map(s => ({
            x: s.x, z: s.z, nx: s.nx, nz: s.nz, y: s.profile[2],
            left: s.left.halfWidthM, right: s.right.halfWidthM,
            leftMeasured: s.left.kerb === 'measured', rightMeasured: s.right.kerb === 'measured'
        }))
    }));
    // the terrain at 2 m (every other 1 m cell): what the overlay drapes on
    const step = 2, gnx = Math.ceil(ground.nx / step), gnz = Math.ceil(ground.nz / step);
    const h = new Float32Array(gnx * gnz);
    for (let k = 0; k < gnz; k++) for (let i = 0; i < gnx; i++) h[k * gnx + i] = ground.ground[Math.min(ground.nz - 1, k * step) * ground.nx + Math.min(ground.nx - 1, i * step)];
    out.ground = { x0: ground.x0, z0: ground.z0, nx: gnx, nz: gnz, cellM: ground.cellMeters * step, heightsB64: encodeFloat32B64(h), method: ground.terrainMethod };
    const stations = roads.reduce((n, r) => n + r.stations.length, 0);
    const share = stations ? roads.reduce((n, r) => n + r.measuredKerbShare * r.stations.length, 0) / stations : 0;
    out.provenance.widths = roads.length
        ? `carriageways measured kerb to kerb on the scan (road-surfaces.ts): ${roads.length} streets, ${stations} stations, ${Math.round(share * 100)} % of kerbs measured, the rest defaulted`
        : 'no carriageway could be measured on the scan: centrelines only';
    out.provenance.ground = `measured terrain of the scan (${ground.terrainMethod}), 2 m grid`;
    return out;
}

/** The overlay for a place, from the disk cache when the same place, radius and scan were read before. */
export async function buildMapVectorOverlay(o: MapVectorOptions): Promise<{ overlay: MapVectorOverlay; cached: boolean; cacheFile?: string }> {
    const key = mapVectorCacheKey(o);
    const cacheFile = o.cacheDir ? path.join(o.cacheDir, `vector-${key}.json`) : undefined;
    if (cacheFile && fs.existsSync(cacheFile)) {
        try { return { overlay: JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as MapVectorOverlay, cached: true, cacheFile }; } catch { /* rebuilt below */ }
    }
    const ev = await fetchVectorEvidence({ lat: o.lat, lng: o.lng, radiusM: o.radiusM, fetchTile: o.fetchTile });
    const overlay = overlayFromEvidence(ev, o);
    if (cacheFile) {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(overlay));
    }
    return { overlay, cached: false, ...(cacheFile ? { cacheFile } : {}) };
}

// ------------------------------------------------------------------------------------------------ roadmap (Map Tiles API 2D)

export const ROADMAP_ZOOM = 18;

export interface RoadmapManifest {
    available: boolean;
    reason?: string;
    zoom: number;
    tiles: Array<RoadmapTilePlacement & { url: string }>;
    attribution: string;
}

/**
 * Google's 2D roadmap tiles (Map Tiles API: createSession, then /v1/2dtiles/z/x/y), one session reused until it expires,
 * each tile cached on disk. The key never leaves the server: the viewport reads tiles through the route.
 */
export class RoadmapTileService {
    private session?: { id: string; expiresAt: number };
    /** Tiles fetched from Google (billed) since the server started, and served from the cache. */
    public readonly counts = { fetched: 0, cached: 0, sessions: 0 };

    constructor(private readonly opts: { apiKey: () => string; cacheDir: string; fetchImpl?: typeof fetch }) {}

    private get fetch(): typeof fetch { return this.opts.fetchImpl ?? fetch; }

    private async sessionId(): Promise<string> {
        if (this.session && this.session.expiresAt > Date.now() + 60_000) return this.session.id;
        const key = this.opts.apiKey();
        if (!key) throw new Error('No Google Maps API key is configured (MAP_TILES_API_KEY or GOOGLE_MAPS_API_KEY), so the roadmap cannot be read.');
        const res = await this.fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(key)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mapType: 'roadmap', language: 'en-US', region: 'US', scale: 'scaleFactor2x', highDpi: true })
        });
        const body = await res.json().catch(() => ({})) as { session?: string; expiry?: string; error?: { message?: string; status?: string } };
        if (!res.ok || !body.session) {
            throw new Error(`Google refused a Map Tiles API roadmap session (HTTP ${res.status}${body.error?.status ? `, ${body.error.status}` : ''}): ${(body.error?.message ?? 'no session returned').slice(0, 240)}`);
        }
        this.counts.sessions++;
        const expiry = Number(body.expiry);
        this.session = { id: body.session, expiresAt: Number.isFinite(expiry) ? expiry * 1000 : Date.now() + 3_600_000 };
        return body.session;
    }

    /** The tiles covering the place, placed in its scan frame; unavailable (with Google's reason) when the key is refused. */
    async manifest(origin: { lat: number; lng: number }, radiusM: number, zoom = ROADMAP_ZOOM): Promise<RoadmapManifest> {
        const tiles = roadmapTilesFor(origin, radiusM, zoom).map(t => ({ ...t, url: `/api/map-data/roadmap/tile/${t.z}/${t.x}/${t.y}` }));
        try {
            await this.sessionId();
        } catch (err) {
            return { available: false, reason: (err as Error).message, zoom, tiles: [], attribution: '' };
        }
        let attribution = 'Map data ©Google';
        try {
            const d = 111_320, dl = radiusM / d, dg = radiusM / (d * Math.cos((origin.lat * Math.PI) / 180));
            const q = new URLSearchParams({ session: this.session!.id, key: this.opts.apiKey(), zoom: String(zoom), north: String(origin.lat + dl), south: String(origin.lat - dl), east: String(origin.lng + dg), west: String(origin.lng - dg) });
            const res = await this.fetch(`https://tile.googleapis.com/tile/v1/viewport?${q}`);
            const v = await res.json().catch(() => ({})) as { copyright?: string };
            if (res.ok && v.copyright) attribution = v.copyright;
        } catch { /* the default attribution stands */ }
        return { available: true, zoom, tiles, attribution };
    }

    /** One tile's image (PNG), from the cache or Google. */
    async tile(z: number, x: number, y: number): Promise<{ bytes: Buffer; contentType: string; cached: boolean }> {
        if (![z, x, y].every(Number.isInteger) || z < 0 || z > 22 || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) throw new Error(`Not a tile: ${z}/${x}/${y}`);
        const file = path.join(this.opts.cacheDir, 'roadmap', String(z), String(x), `${y}.png`);
        if (fs.existsSync(file)) { this.counts.cached++; return { bytes: fs.readFileSync(file), contentType: 'image/png', cached: true }; }
        const session = await this.sessionId();
        const res = await this.fetch(`https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${encodeURIComponent(session)}&key=${encodeURIComponent(this.opts.apiKey())}`);
        if (!res.ok) throw new Error(`Google roadmap tile ${z}/${x}/${y} failed (HTTP ${res.status})`);
        const bytes = Buffer.from(await res.arrayBuffer());
        this.counts.fetched++;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, bytes);
        return { bytes, contentType: res.headers.get('content-type') || 'image/png', cached: false };
    }
}
