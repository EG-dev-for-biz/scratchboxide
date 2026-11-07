/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The 3D viewport's Map data view: a staged place shown as map data, drawn over (or in place of) the scene.
 *
 * - Blob groups: the scan split into blobs (docs/research/2026-11-06-blob-graph-plan.md), each triangle coloured by its
 *   blob's group. Groups are open-vocabulary labels: their colours come from a palette in the order the groups arrive
 *   (largest area first), and nothing here or in the viewport branches on a group's name.
 * - Google vector map data (vectortiles.featuretiles through vector-footprints.ts): road centrelines and the carriageways
 *   measured kerb to kerb on the scan (road-surfaces.ts), building footprints as outlines, areas (water, land cover, land
 *   use) and rail lines, and points of interest with their names. Type codes are labels and legend filters only.
 * - Google's 2D roadmap (Map Tiles API), draped on the measured ground.
 *
 * Every position is in the scan frame of the place's origin: x east, y up, z south, metres (LocalTangentPlane, the frame
 * the staged builds and the scene share). This module holds the wire contracts and the pure helpers both sides use.
 */

import { LocalTangentPlane } from '../coordinate/LocalTangentPlane';

export type MapVec2 = [number, number];

// ------------------------------------------------------------------------------------------------ the scene's setting

/** The view's layers: display layers of the overlay, not kinds of place. */
export const MAP_DATA_LAYERS = ['blobs', 'roads', 'footprints', 'areas', 'rails', 'pois', 'roadmap'] as const;
export type MapDataLayer = typeof MAP_DATA_LAYERS[number];

/** Scene3DData.mapDataView: whether the view is on, which layers show, and which legend rows are hidden. */
export interface MapDataViewConfig {
    on: boolean;
    /** Layer switches; a layer left out takes MAP_DATA_LAYER_DEFAULTS. */
    layers?: Partial<Record<MapDataLayer, boolean>>;
    /** Legend rows switched off: blob group labels and area type codes (open vocabulary, matched exactly). */
    hidden?: string[];
    /** The blob graph (prototype's blob_graph.json) inside the workspace; else one is looked for beside the scene's models. */
    blobGraphPath?: string;
    /** Radius of the vector data around the place's origin (m). Default MAP_DATA_DEFAULT_RADIUS_M. */
    radiusM?: number;
    /** Roadmap opacity, 0..1. Default 0.7. */
    roadmapOpacity?: number;
    /** While the blob groups show, the scene's own meshes are hidden (they are the same surface). Default true. */
    hideSceneUnderBlobs?: boolean;
}

export const MAP_DATA_LAYER_DEFAULTS: Record<MapDataLayer, boolean> = {
    blobs: true, roads: true, footprints: true, areas: true, rails: true, pois: true, roadmap: false
};

export const MAP_DATA_DEFAULT_RADIUS_M = 200;

export function layerOn(cfg: MapDataViewConfig | undefined, layer: MapDataLayer): boolean {
    return !!cfg?.on && (cfg.layers?.[layer] ?? MAP_DATA_LAYER_DEFAULTS[layer]);
}

// ------------------------------------------------------------------------------------------------ palette

/**
 * A qualitative palette (Okabe-Ito first, then distinct extensions), handed out in order. Labels get colours by their
 * position in the list the caller gives (the server orders groups by area), so the same graph colours the same way.
 */
export const MAP_PALETTE = [
    '#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7',
    '#8C6BB1', '#66C2A5', '#FC8D62', '#A6D854', '#E5C494', '#B3B3B3', '#1B9E77', '#E7298A', '#7570B3'
] as const;

export function assignColours(labels: string[], palette: readonly string[] = MAP_PALETTE): Map<string, string> {
    const out = new Map<string, string>();
    for (const l of labels) if (!out.has(l)) out.set(l, palette[out.size % palette.length]);
    return out;
}

/** A type code as words for a legend: 'FEATURE_TYPE_PARKING_LOT' -> 'parking lot'; an unknown shape is shown as it is. */
export function codeWords(code: string): string {
    const m = /^(?:FEATURE_TYPE|SB_FEATURE_TYPE)_(.+)$/.exec(code);
    return m ? m[1].toLowerCase().replace(/_/g, ' ') : code;
}

/** The legend key of a feature: its most specific type code (codes run general to specific), or the catch-all. */
export function featureKey(types: string[] | undefined): string {
    return types && types.length ? types[types.length - 1] : 'SB_FEATURE_TYPE_OBJECT';
}

// ------------------------------------------------------------------------------------------------ blob groups

export const BLOB_GROUPS_SCHEMA = 'scratchbox.blob-groups/1';

/** One blob as the viewport shows it: its id, its group (a label), and the reading's words and confidence when read. */
export interface BlobLabel {
    id: string;
    group: string;
    confidence?: number;
    description?: string;
    /** Google vector feature id the blob was matched to (buildings), when any. */
    featureId?: string;
    triangles: number;
}

export interface BlobGroupSummary { label: string; blobs: number; triangles: number; areaM2: number }

export interface BlobGroupsHeader {
    schema: typeof BLOB_GROUPS_SCHEMA;
    source: { blobGraph: string; mesh: string; vertices: number; triangles: number; anchor?: { lat: number; lng: number } };
    /** Largest area first: the palette order. */
    groups: BlobGroupSummary[];
    /** Index = the blob index triBlob refers to. */
    blobs: BlobLabel[];
    unassignedTriangles: number;
}

/** The decoded payload: the scan mesh (scan frame) and each triangle's blob index (-1 unassigned). */
export interface BlobGroupsPayload {
    header: BlobGroupsHeader;
    positions: Float32Array;
    indices: Uint32Array;
    triBlob: Int32Array;
}

const BLOB_MAGIC = 0x47425342; // 'SBBG' little-endian

/** One binary body: magic, header length, header JSON (padded to 4), positions, indices, triangle blobs. */
export function encodeBlobGroups(p: BlobGroupsPayload): Uint8Array {
    const json = new TextEncoder().encode(JSON.stringify(p.header));
    const pad = (4 - (json.length % 4)) % 4;
    const headLen = json.length + pad;
    const total = 8 + headLen + p.positions.byteLength + p.indices.byteLength + p.triBlob.byteLength;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, BLOB_MAGIC, true);
    dv.setUint32(4, headLen, true);
    out.set(json, 8);
    out.fill(0x20, 8 + json.length, 8 + headLen);
    let o = 8 + headLen;
    out.set(new Uint8Array(p.positions.buffer, p.positions.byteOffset, p.positions.byteLength), o); o += p.positions.byteLength;
    out.set(new Uint8Array(p.indices.buffer, p.indices.byteOffset, p.indices.byteLength), o); o += p.indices.byteLength;
    out.set(new Uint8Array(p.triBlob.buffer, p.triBlob.byteOffset, p.triBlob.byteLength), o);
    return out;
}

export function decodeBlobGroups(bytes: ArrayBuffer | Uint8Array): BlobGroupsPayload {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (u8.byteLength < 8) throw new Error('blob groups: body too short');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, true) !== BLOB_MAGIC) throw new Error('blob groups: not a blob groups body (bad magic)');
    const headLen = dv.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + headLen))) as BlobGroupsHeader;
    if (header.schema !== BLOB_GROUPS_SCHEMA) throw new Error(`blob groups: schema ${String(header.schema)} is not ${BLOB_GROUPS_SCHEMA}`);
    const nv = header.source.vertices, nt = header.source.triangles;
    const need = 8 + headLen + nv * 12 + nt * 16;
    if (u8.byteLength !== need) throw new Error(`blob groups: body is ${u8.byteLength} bytes, the header says ${need}`);
    // copy into aligned buffers (the body's own offset may not be 4-aligned)
    const at = 8 + headLen;
    const positions = new Float32Array(u8.slice(at, at + nv * 12).buffer);
    const indices = new Uint32Array(u8.slice(at + nv * 12, at + nv * 12 + nt * 12).buffer);
    const triBlob = new Int32Array(u8.slice(at + nv * 12 + nt * 12, need).buffer);
    return { header, positions, indices, triBlob };
}

/** The prototype's blob_graph.json, as far as this view reads it (scripts/dev/blob-graph/assemble.ts). */
export interface BlobGraphFile {
    schema?: string;
    source?: { welded?: string; triangles?: number; anchor?: { lat: number; lng: number } };
    blobs: Array<{
        index: number; id: string; group: string; triangles?: number; featureId?: string;
        measures?: { areaM2?: number };
        reading?: { description?: string; confidence?: number };
    }>;
}

/**
 * The header for a blob graph: one label per blob, groups summed and ordered by area (largest first). Group names are
 * carried as they are; a blob without a group string is put under the catch-all code.
 */
export function blobGroupsHeaderOf(graph: BlobGraphFile, triBlob: Int32Array, mesh: { path: string; vertices: number; triangles: number }, blobGraphPath: string): BlobGroupsHeader {
    const blobs: BlobLabel[] = [];
    const sums = new Map<string, BlobGroupSummary>();
    for (const b of graph.blobs) {
        const group = typeof b.group === 'string' && b.group.trim() ? b.group.trim() : 'SB_FEATURE_TYPE_OBJECT';
        const r = b.reading;
        blobs[b.index] = {
            id: b.id, group, triangles: 0,
            ...(typeof r?.confidence === 'number' ? { confidence: r.confidence } : {}),
            ...(typeof r?.description === 'string' && r.description ? { description: r.description } : {}),
            ...(b.featureId ? { featureId: b.featureId } : {})
        };
        const s = sums.get(group) ?? { label: group, blobs: 0, triangles: 0, areaM2: 0 };
        s.blobs++;
        s.areaM2 += b.measures?.areaM2 ?? 0;
        sums.set(group, s);
    }
    for (let i = 0; i < blobs.length; i++) if (!blobs[i]) blobs[i] = { id: `blob/${i}`, group: 'SB_FEATURE_TYPE_OBJECT', triangles: 0 };
    let unassigned = 0;
    for (let t = 0; t < triBlob.length; t++) {
        const b = triBlob[t];
        if (b < 0 || b >= blobs.length) { unassigned++; continue; }
        blobs[b].triangles++;
        sums.get(blobs[b].group)!.triangles++;
    }
    const groups = [...sums.values()].map(g => ({ ...g, areaM2: Math.round(g.areaM2 * 10) / 10 })).sort((a, b) => b.areaM2 - a.areaM2 || b.triangles - a.triangles);
    return {
        schema: BLOB_GROUPS_SCHEMA,
        source: { blobGraph: blobGraphPath, mesh: mesh.path, vertices: mesh.vertices, triangles: mesh.triangles, ...(graph.source?.anchor ? { anchor: graph.source.anchor } : {}) },
        groups, blobs, unassignedTriangles: unassigned
    };
}

/**
 * Index lists per group: the triangles of every blob of a group in one list, so the viewport draws one mesh per group
 * (a district's thousand blobs are a handful of draw calls). Unassigned triangles are in no list.
 */
export function groupIndexLists(p: BlobGroupsPayload): Map<string, Uint32Array> {
    const groupOfBlob = p.header.blobs.map(b => b.group);
    const counts = new Map<string, number>();
    for (let t = 0; t < p.triBlob.length; t++) {
        const g = groupOfBlob[p.triBlob[t]];
        if (g !== undefined) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
    const lists = new Map<string, Uint32Array>();
    const fill = new Map<string, number>();
    for (const [g, n] of counts) { lists.set(g, new Uint32Array(n * 3)); fill.set(g, 0); }
    for (let t = 0; t < p.triBlob.length; t++) {
        const g = groupOfBlob[p.triBlob[t]];
        if (g === undefined) continue;
        const arr = lists.get(g)!, o = fill.get(g)!;
        arr[o] = p.indices[t * 3]; arr[o + 1] = p.indices[t * 3 + 1]; arr[o + 2] = p.indices[t * 3 + 2];
        fill.set(g, o + 3);
    }
    return lists;
}

// ------------------------------------------------------------------------------------------------ vector overlay

export const MAP_VECTOR_SCHEMA = 'scratchbox.map-vector/1';

/** A carriageway station measured on the scan: centre, left normal, half-widths to each kerb and the level. */
export interface CarriagewayStation {
    x: number; z: number; nx: number; nz: number;
    /** Carriageway level at the centre (y, scan frame). */
    y: number;
    left: number; right: number;
    /** Whether each kerb was measured on the scan (else the half-width is road-surfaces.ts's default). */
    leftMeasured: boolean; rightMeasured: boolean;
}

/** A measured height grid of the open ground (StreetViewSurveyPlanner.buildGroundModel's terrain), row-major z then x. */
export interface MapGroundGrid {
    x0: number; z0: number; nx: number; nz: number; cellM: number;
    /** Float32 heights, base64 (NaN where nothing was measured). */
    heightsB64: string;
    method: string;
}

export interface MapVectorOverlay {
    schema: typeof MAP_VECTOR_SCHEMA;
    origin: { lat: number; lng: number };
    radiusM: number;
    zoom: number;
    tiles: number;
    roads: Array<{ points: MapVec2[]; types: string[] }>;
    /** Carriageways measured kerb to kerb on the scan (only with a scan); their widths are the scan's, else defaulted and marked. */
    carriageways: Array<{ id: string; stations: CarriagewayStation[]; measuredKerbShare: number }>;
    footprints: Array<{ id: string; loops: MapVec2[][]; heightM?: number }>;
    /** Water, land cover and land use areas, boundary loops even-odd, with their codes as received. */
    areas: Array<{ loops: MapVec2[][]; types: string[] }>;
    rails: MapVec2[][];
    pois: Array<{ x: number; z: number; types: string[]; name?: string }>;
    ground?: MapGroundGrid;
    /** Where the widths, levels and outlines came from, for the legend. */
    provenance: { vector: string; widths: string; ground: string };
}

export function encodeFloat32B64(a: Float32Array): string {
    const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
}

export function decodeFloat32B64(b64: string): Float32Array {
    let u8: Uint8Array;
    if (typeof Buffer !== 'undefined') u8 = new Uint8Array(Buffer.from(b64, 'base64'));
    else { const s = atob(b64); u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); }
    return new Float32Array(u8.slice().buffer);
}

/**
 * The ground height at (x, z): bilinear over the grid's measured cells; where a cell is unmeasured the nearest measured
 * cell within `reachCells` rings, else `fallback` (the grid's median, so the overlay never drops to the origin's 0).
 */
export function groundSampler(ground: MapGroundGrid | undefined, fallback = 0, reachCells = 6): (x: number, z: number) => number {
    if (!ground) return () => fallback;
    const h = decodeFloat32B64(ground.heightsB64);
    const { x0, z0, nx, nz, cellM } = ground;
    const finite = Array.from(h).filter(v => v === v).sort((a, b) => a - b);
    const med = finite.length ? finite[Math.floor(finite.length / 2)] : fallback;
    const cell = (i: number, k: number) => (i < 0 || k < 0 || i >= nx || k >= nz ? NaN : h[k * nx + i]);
    const near = (i: number, k: number): number => {
        for (let r = 1; r <= reachCells; r++) {
            let best = NaN, bd = Infinity;
            for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
                if (Math.max(Math.abs(di), Math.abs(dk)) !== r) continue;
                const v = cell(i + di, k + dk);
                if (v === v && di * di + dk * dk < bd) { bd = di * di + dk * dk; best = v; }
            }
            if (best === best) return best;
        }
        return med;
    };
    return (x, z) => {
        const fx = (x - x0) / cellM - 0.5, fz = (z - z0) / cellM - 0.5;
        const i = Math.floor(fx), k = Math.floor(fz), u = fx - i, v = fz - k;
        const a = cell(i, k), b = cell(i + 1, k), c = cell(i, k + 1), d = cell(i + 1, k + 1);
        if (a === a && b === b && c === c && d === d) return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
        const own = cell(Math.round(fx), Math.round(fz));
        return own === own ? own : near(Math.round(fx), Math.round(fz));
    };
}

/** Points along a polyline no more than `stepM` apart (the corners kept), so a draped line follows the ground. */
export function densify(points: MapVec2[], stepM: number): MapVec2[] {
    if (points.length < 2) return points.slice();
    const out: MapVec2[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const [ax, az] = points[i - 1], [bx, bz] = points[i];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / stepM));
        for (let s = 1; s <= n; s++) out.push([ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n]);
    }
    return out;
}

/**
 * A carriageway as a triangle strip over its measured stations: two vertices per station (left kerb, right kerb), at the
 * carriageway's measured level plus `liftM`. A display surface for the measured widths, not geometry for the build.
 */
export function carriagewayStrip(stations: CarriagewayStation[], liftM: number): { positions: Float32Array; indices: Uint32Array } {
    const n = stations.length;
    const positions = new Float32Array(n * 6);
    for (let i = 0; i < n; i++) {
        const s = stations[i];
        positions.set([s.x + s.nx * s.left, s.y + liftM, s.z + s.nz * s.left, s.x - s.nx * s.right, s.y + liftM, s.z - s.nz * s.right], i * 6);
    }
    const indices = new Uint32Array(Math.max(0, n - 1) * 6);
    for (let i = 0; i + 1 < n; i++) indices.set([i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2], i * 6);
    return { positions, indices };
}

// ------------------------------------------------------------------------------------------------ roadmap tiles

/** Web Mercator tile (x, y) holding (lat, lng) at `zoom`. */
export function tileXY(lat: number, lng: number, zoom: number): { x: number; y: number } {
    const n = 2 ** zoom, r = (lat * Math.PI) / 180;
    return { x: Math.floor(((lng + 180) / 360) * n), y: Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n) };
}

/** The north-west corner of tile (x, y) at `zoom` as lat/lng. */
export function tileCornerLatLng(x: number, y: number, zoom: number): { lat: number; lng: number } {
    const n = 2 ** zoom;
    return { lng: (x / n) * 360 - 180, lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI };
}

/** A geodetic point in the scan frame of `origin` (x east, z south), through LocalTangentPlane like the staged builds. */
export function geoToScan(origin: { lat: number; lng: number }, lat: number, lng: number): MapVec2 {
    const p = new LocalTangentPlane({ lat: origin.lat, lng: origin.lng, alt: 0 }).toLocal({ lat, lng, alt: 0 });
    return [p[0], p[2]];
}

export interface RoadmapTilePlacement {
    z: number; x: number; y: number;
    /** Corners in the scan frame: north-west, north-east, south-east, south-west. */
    corners: [MapVec2, MapVec2, MapVec2, MapVec2];
}

/** Every roadmap tile at `zoom` covering a square of half-side radiusM around the origin, with its corners placed. */
export function roadmapTilesFor(origin: { lat: number; lng: number }, radiusM: number, zoom: number): RoadmapTilePlacement[] {
    const dLat = radiusM / 111_320, dLng = radiusM / (111_320 * Math.cos((origin.lat * Math.PI) / 180));
    const a = tileXY(origin.lat + dLat, origin.lng - dLng, zoom), b = tileXY(origin.lat - dLat, origin.lng + dLng, zoom);
    const ltp = new LocalTangentPlane({ lat: origin.lat, lng: origin.lng, alt: 0 });
    const at = (x: number, y: number): MapVec2 => { const c = tileCornerLatLng(x, y, zoom); const p = ltp.toLocal({ lat: c.lat, lng: c.lng, alt: 0 }); return [p[0], p[2]]; };
    const out: RoadmapTilePlacement[] = [];
    for (let y = a.y; y <= b.y; y++) for (let x = a.x; x <= b.x; x++) out.push({ z: zoom, x, y, corners: [at(x, y), at(x + 1, y), at(x + 1, y + 1), at(x, y + 1)] });
    return out;
}
