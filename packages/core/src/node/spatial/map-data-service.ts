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

/** Where a blob graph's labels and mesh are: labels in split/labels.bin (or beside it), the mesh beside it (its source's name, else welded.glb), else its source. */
export function blobGraphFiles(blobGraphPath: string, graph: BlobGraphFile): { labels: string; mesh: string } {
    const dir = path.dirname(blobGraphPath);
    const labels = [path.join(dir, 'split', 'labels.bin'), path.join(dir, 'labels.bin')].find(p => fs.existsSync(p));
    if (!labels) throw new Error(`No per-triangle labels beside the blob graph (looked for split/labels.bin and labels.bin in ${dir}).`);
    const named = graph.source?.welded;
    // the graph's own folder first (a graph copied with its mesh reads its copy), then the path it names
    const mesh = [named ? path.join(dir, path.basename(named)) : undefined, path.join(dir, 'welded.glb'), named && fs.existsSync(named) ? named : undefined]
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

/**
 * A building's plan outline: a single extruded part's own loops; several parts (storeys stepping back, plan pieces that
 * overlap) or modelled volumes are drawn as the outline of their union, so the overlaps' inner edges are not drawn.
 */
export function footprintLoops(b: VectorBuilding): MapVec2[][] {
    if (b.extruded?.length === 1 && !b.volumes?.length) return b.extruded[0].loops;
    if (b.extruded?.length) return planUnionOutline(b.extruded.map(e => e.loops), FOOTPRINT_OUTLINE_CELL_M);
    // the parts of a volume-only building are its triangles seen from above (roofs at several levels overlap, walls are
    // slivers): their union is rasterised and its boundary traced as cell edges, joined into runs along rows and columns
    return planUnionOutline(b.parts, FOOTPRINT_OUTLINE_CELL_M);
}

/** Cell size the union outline of a volume-only building is traced at (m). */
export const FOOTPRINT_OUTLINE_CELL_M = 0.5;

/** The outline of the union of plan parts (each part's loops even-odd): traced on a `cell` grid, linked into closed loops and simplified to within 1.5 cells. */
export function planUnionOutline(parts: MapVec2[][][], cell: number): MapVec2[][] {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const part of parts) for (const p of part) for (const [x, z] of p) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    if (!Number.isFinite(x0)) return [];
    x0 -= cell; z0 -= cell;
    const nx = Math.ceil((x1 - x0) / cell) + 2, nz = Math.ceil((z1 - z0) / cell) + 2;
    if (nx * nz > 16_000_000) return [];
    const fill = new Uint8Array(nx * nz);
    const xs: number[] = [];
    // each part filled even-odd across its own loops (a courtyard stays open), the parts unioned
    for (const part of parts) {
        const loops = part.filter(l => l.length >= 3);
        if (!loops.length) continue;
        let pz0 = Infinity, pz1 = -Infinity;
        for (const l of loops) for (const [, z] of l) { pz0 = Math.min(pz0, z); pz1 = Math.max(pz1, z); }
        for (let k = Math.max(0, Math.floor((pz0 - z0) / cell)); k <= Math.min(nz - 1, Math.ceil((pz1 - z0) / cell)); k++) {
            const cz = z0 + (k + 0.5) * cell;
            xs.length = 0;
            for (const p of loops) for (let i = 0; i < p.length; i++) {
                const [ax, az] = p[i], [bx, bz] = p[(i + 1) % p.length];
                if ((az <= cz) !== (bz <= cz)) xs.push(ax + ((cz - az) / (bz - az)) * (bx - ax));
            }
            xs.sort((a, c) => a - c);
            for (let j = 0; j + 1 < xs.length; j += 2) {
                for (let i = Math.max(0, Math.ceil((xs[j] - x0) / cell - 0.5)); i <= Math.min(nx - 1, Math.floor((xs[j + 1] - x0) / cell - 0.5)); i++) fill[k * nx + i] = 1;
            }
        }
    }
    const at = (i: number, k: number) => (i < 0 || k < 0 || i >= nx || k >= nz ? 0 : fill[k * nx + i]);
    const segs: MapVec2[][] = [];
    // horizontal edges (between rows k-1 and k), joined along x
    for (let k = 0; k <= nz; k++) {
        let start = -1;
        for (let i = 0; i <= nx; i++) {
            const edge = i < nx && at(i, k - 1) !== at(i, k);
            if (edge && start < 0) start = i;
            if (!edge && start >= 0) { segs.push([[x0 + start * cell, z0 + k * cell], [x0 + i * cell, z0 + k * cell]]); start = -1; }
        }
    }
    // vertical edges (between columns i-1 and i), joined along z
    for (let i = 0; i <= nx; i++) {
        let start = -1;
        for (let k = 0; k <= nz; k++) {
            const edge = k < nz && at(i - 1, k) !== at(i, k);
            if (edge && start < 0) start = k;
            if (!edge && start >= 0) { segs.push([[x0 + i * cell, z0 + start * cell], [x0 + i * cell, z0 + k * cell]]); start = -1; }
        }
    }
    // specks (a modelled volume's wall slivers seen from above) and pinholes are left out
    const area = (l: MapVec2[]) => Math.abs(l.reduce((n, p, i) => { const q = l[(i + 1) % l.length]; return n + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    return simplifyLoops(linkSegments(segs).filter(l => area(l) >= OUTLINE_MIN_LOOP_M2), cell * 1.5);
}

/** A traced outline loop (or hole) smaller than this is left out (m²). */
export const OUTLINE_MIN_LOOP_M2 = 10;

/** Axis-aligned boundary runs linked end to end into closed loops (a corner shared by two loops is left by any unused run). */
export function linkSegments(segs: MapVec2[][]): MapVec2[][] {
    const key = (p: MapVec2) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
    const at = new Map<string, number[]>();
    segs.forEach((s, i) => { for (const p of s) (at.get(key(p)) ?? at.set(key(p), []).get(key(p))!).push(i); });
    const used = new Uint8Array(segs.length);
    const loops: MapVec2[][] = [];
    for (let s0 = 0; s0 < segs.length; s0++) {
        if (used[s0]) continue;
        used[s0] = 1;
        const loop: MapVec2[] = [segs[s0][0]];
        let end = segs[s0][1];
        for (let guard = 0; guard < segs.length; guard++) {
            if (key(end) === key(loop[0])) break;
            loop.push(end);
            const next = (at.get(key(end)) ?? []).find(i => !used[i]);
            if (next === undefined) break;
            used[next] = 1;
            end = key(segs[next][0]) === key(end) ? segs[next][1] : segs[next][0];
        }
        loops.push(loop);
    }
    return loops;
}

/** Douglas-Peucker on each closed loop (split at its farthest pair), so a 0.5 m staircase reads as the slanted wall it traces. */
export function simplifyLoops(loops: MapVec2[][], tolM: number): MapVec2[][] {
    const dp = (pts: MapVec2[]): MapVec2[] => {
        if (pts.length < 3) return pts;
        const [a, b] = [pts[0], pts[pts.length - 1]];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
        let worst = -1, wd = 0;
        for (let i = 1; i + 1 < pts.length; i++) {
            const d = Math.abs((b[0] - a[0]) * (a[1] - pts[i][1]) - (a[0] - pts[i][0]) * (b[1] - a[1])) / L;
            if (d > wd) { wd = d; worst = i; }
        }
        if (wd <= tolM) return [a, b];
        const left = dp(pts.slice(0, worst + 1)), right = dp(pts.slice(worst));
        return [...left.slice(0, -1), ...right];
    };
    return loops.map(loop => {
        if (loop.length < 4) return loop;
        let far = 0, fd = 0;
        for (let i = 1; i < loop.length; i++) { const d = Math.hypot(loop[i][0] - loop[0][0], loop[i][1] - loop[0][1]); if (d > fd) { fd = d; far = i; } }
        const first = dp(loop.slice(0, far + 1)), second = dp([...loop.slice(far), loop[0]]);
        return [...first.slice(0, -1), ...second.slice(0, -1)];
    });
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
        // from the stations themselves (road-surfaces.ts's own share is over the whole road, so a road split into runs reads above 1)
        measuredKerbShare: r.stations.length ? Math.round((1000 * r.stations.reduce((n, s) => n + (s.left.kerb === 'measured' ? 1 : 0) + (s.right.kerb === 'measured' ? 1 : 0), 0)) / (2 * r.stations.length)) / 1000 : 0,
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
    const stations = out.carriageways.reduce((n, c) => n + c.stations.length, 0);
    const share = stations ? out.carriageways.reduce((n, c) => n + c.measuredKerbShare * c.stations.length, 0) / stations : 0;
    out.provenance.widths = roads.length
        ? `carriageways measured kerb to kerb on the scan (road-surfaces.ts): ${roads.length} runs, ${stations} stations, ${Math.round(share * 100)} % of their kerbs measured (a stretch with no kerb on the scan is left out, its centreline still drawn)`
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
