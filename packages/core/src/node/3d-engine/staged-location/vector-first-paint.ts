/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The staged build's first paint: Google's own building data (vectortiles.featuretiles, vector-footprints.ts) for the
 * whole requested area, extruded natively (the staged massing tool, scratchbox_staged_massing.hpp, with no tile: no
 * bake, no residual) into a light clay massing layer the viewport shows while the 3D Tiles stream.
 *
 *   - Each building is its footprint parts (outer rings and holes) extruded from minHeightMeters to heightMeters above its
 *     base, and Google's modelled 3D volume where it has one (its triangles as given). A part without a height is not
 *     drawn: nothing is guessed. The counts left out are reported.
 *   - A building's base is the Google Elevation API's terrain height at its centroid, relative to the frame's street level:
 *     before the tiles, the elevation at the geocoded point (the tiles' own origin is the street there, so the two agree to
 *     about a metre); after them, the frame's own height (geoAnchor.elevation). Without elevations every base is the
 *     street level at the place, and the record says so.
 *   - Everything is labelled vector-modelled (Google's modelled footprints and heights, carried unchanged; not scan
 *     measurement). The tiles supersede it where they arrive; where they do not (a district past the leaf-tile cap) the
 *     buildings the tiles do not cover are kept as their own layer, labelled.
 *
 * No building is named or classified: a building is loops, heights and triangles.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProvenanceRecord, StagedNodeExtras, Vec2 } from '../../../common/spatial/staged-location-contracts';
import { scanToGeodetic } from '../../spatial/StreetViewSurveyPlanner';
import { parseGlbNodes } from './glb-nodes';
import { massingSpecText, ringArea, simplifyRing, type MassingMesh, type MassingPart } from './pipeline-e/massing-spec';
import { runMassing, type MassingNode } from './pipeline-e/native-massing';
import { writeStagedGlbFile, type StagedGlbNode } from './staged-glb-writer';
import type { VectorBuilding, VectorEvidence } from './vector-footprints';

export const VECTOR_MASSING_VERSION = 'vector-massing/v1';
/** The label of every vector-massing triangle (AGENTS.md §4: measured, vector-modelled, photo-inferred, generated). */
export const VECTOR_MODELLED_LABEL = 'vector-modelled';
/** An isolated structure's first paint covers this far around the place (the structure is not known before the tiles). */
export const VECTOR_ISOLATE_RADIUS_M = 40;
/** A building is kept beside the tiles when at most this share of its footprint lies where the tiles reach. */
export const VECTOR_OUTER_MAX_COVERED_SHARE = 0.5;
/** The tiles' plan coverage is measured on cells this large (any tile vertex in a cell covers it). */
export const VECTOR_COVERAGE_CELL_M = 4;
/** Elevation API requests carry at most this many points (the API takes 512; this keeps the URL short). */
export const ELEVATION_CHUNK = 200;
/** The native tool's parameters for the first paint: no tile, so no snap, bake, residual, sections or top-down. */
export const VECTOR_MASSING_PARAMS = { snapMaxM: 0, bake: 0, residual: 0, sections: 0, topdown: 0 };

export interface LatLng { lat: number; lng: number }
/** Terrain heights above mean sea level, one per point, in order (the Google Elevation API). */
export type ElevationLookup = (points: LatLng[], signal?: AbortSignal) => Promise<number[]>;

/** One building as the first paint draws it: heights are metres above the building's own base. */
export interface PaintBuilding {
    id: string;
    centroid: Vec2;
    /** Plan area of its outer rings, m². */
    areaM2: number;
    parts: Array<{ loops: Vec2[][]; minH: number; topH: number }>;
    volumes: Array<{ vertices: Array<[number, number, number]>; indices: number[] }>;
}

export interface PaintSelection {
    buildings: PaintBuilding[];
    /** Footprint parts with no height in the vector data (not drawn). */
    partsWithoutHeight: number;
    /** Buildings with nothing to draw (every part without a height, no volume). */
    buildingsWithoutHeight: number;
    /** Buildings whose centroid lies beyond the requested radius (the vector tiles are whole tiles). */
    outsideRadius: number;
}

function outerArea(b: VectorBuilding): { area: number; cx: number; cz: number } {
    let area = 0, cx = 0, cz = 0;
    for (const part of b.parts) {
        const ring = part[0];
        if (!ring || ring.length < 3) continue;
        const a = Math.abs(ringArea(ring));
        if (!(a > 0)) continue;
        let sx = 0, sz = 0;
        for (const [x, z] of ring) { sx += x; sz += z; }
        area += a; cx += (sx / ring.length) * a; cz += (sz / ring.length) * a;
    }
    return area > 0 ? { area, cx: cx / area, cz: cz / area } : { area: 0, cx: NaN, cz: NaN };
}

/** The buildings within `radiusM` of the place that have something to draw, and what was left out. */
export function selectPaintBuildings(ev: VectorEvidence, radiusM: number): PaintSelection {
    const out: PaintBuilding[] = [];
    let partsWithoutHeight = 0, buildingsWithoutHeight = 0, outsideRadius = 0;
    for (const b of ev.buildings) {
        const { area, cx, cz } = outerArea(b);
        const volumes = (b.volumes ?? []).filter(v => v.vertices.length >= 4 && v.indices.length >= 12);
        let centroid: Vec2 = [cx, cz];
        if (!Number.isFinite(cx) && volumes.length) {
            const vs = volumes.flatMap(v => v.vertices);
            centroid = [vs.reduce((s, v) => s + v[0], 0) / vs.length, vs.reduce((s, v) => s + v[2], 0) / vs.length];
        }
        if (!Number.isFinite(centroid[0])) continue;
        if (Math.hypot(centroid[0], centroid[1]) > radiusM) { outsideRadius++; continue; }
        // a plan-only part (a 2D footprint) has no height; one of a building Google also models in 3D is that volume's plan
        const extruded = (b.extruded ?? []).filter(p => !(p.planOnly && volumes.length > 0));
        const parts: PaintBuilding['parts'] = [];
        for (const p of extruded) {
            if (!(p.heightM !== undefined && p.heightM > (p.minHeightM ?? 0))) { partsWithoutHeight++; continue; }
            const loops = p.loops.map(l => simplifyRing(l)).filter(l => l.length >= 3 && Math.abs(ringArea(l)) >= 1);
            if (!loops.length) continue;
            parts.push({ loops, minH: p.minHeightM ?? 0, topH: p.heightM });
        }
        if (!parts.length && !volumes.length) { buildingsWithoutHeight++; continue; }
        out.push({ id: b.id, centroid, areaM2: area, parts, volumes: volumes.map(v => ({ vertices: v.vertices.map(q => [q[0], q[1], q[2]] as [number, number, number]), indices: v.indices.slice() })) });
    }
    out.sort((a, b) => Math.hypot(a.centroid[0], a.centroid[1]) - Math.hypot(b.centroid[0], b.centroid[1]) || (a.id < b.id ? -1 : 1));
    return { buildings: out, partsWithoutHeight, buildingsWithoutHeight, outsideRadius };
}

/** Geodetic position of a frame point (x east, z south) of the place. */
export function frameToLatLng(place: LatLng, p: Vec2): LatLng {
    const g = scanToGeodetic({ lat: place.lat, lng: place.lng, heightMeters: 0 }, p[0], 0, p[1]);
    return { lat: g.lat, lng: g.lng };
}

/** The Google Elevation API: `points` in chunks of ELEVATION_CHUNK, the chunks in parallel. Throws on any status but OK. */
export async function fetchElevations(points: LatLng[], apiKey: string, opts: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {}): Promise<number[]> {
    if (!apiKey) throw new Error('no Google Maps API key is set for the Elevation API');
    const f = opts.fetchImpl ?? fetch;
    const chunks: LatLng[][] = [];
    for (let i = 0; i < points.length; i += ELEVATION_CHUNK) chunks.push(points.slice(i, i + ELEVATION_CHUNK));
    const answers = await Promise.all(chunks.map(async chunk => {
        const locations = chunk.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
        const res = await f(`https://maps.googleapis.com/maps/api/elevation/json?locations=${encodeURIComponent(locations)}&key=${encodeURIComponent(apiKey)}`, opts.signal ? { signal: opts.signal } : {});
        if (!res.ok) throw new Error(`the Elevation API answered HTTP ${res.status}`);
        const json = await res.json() as { status?: string; error_message?: string; results?: Array<{ elevation: number }> };
        if (json.status !== 'OK' || !Array.isArray(json.results) || json.results.length !== chunk.length) {
            throw new Error(`the Elevation API answered ${json.status ?? 'nothing'}${json.error_message ? `: ${json.error_message}` : ''}`);
        }
        return json.results.map(r => Number(r.elevation));
    }));
    const flat = answers.flat();
    if (flat.some(v => !Number.isFinite(v))) throw new Error('the Elevation API returned a height that is not a number');
    return flat;
}

/** The massing parts and meshes of `buildings`, each on its own base Y in the tile frame. */
export function paintMassing(buildings: PaintBuilding[], baseY: (b: PaintBuilding, index: number) => number): { parts: MassingPart[]; meshes: MassingMesh[] } {
    const parts: MassingPart[] = [];
    const meshes: MassingMesh[] = [];
    buildings.forEach((b, i) => {
        const y0 = baseY(b, i);
        b.parts.forEach((p, k) => parts.push({ id: `${b.id}/e${k}`, baseY: y0 + p.minH, topY: y0 + p.topH, loops: p.loops, planes: [], heightSource: 'vector', heights: { vectorY: y0 + p.topH } }));
        b.volumes.forEach((v, k) => meshes.push({ id: `${b.id}/v${k}`, vertices: v.vertices.map(([x, h, z]) => [x, y0 + h, z]), indices: v.indices }));
    });
    return { parts, meshes };
}

export interface PaintGlb {
    /** The clay GLB (one node per massing node, each with its provenance in extras.sb). */
    glb: string;
    counts: { vertices: number; triangles: number };
    nodes: number;
    nativeMs: number;
    /** Buildings the native tool refused, by chunk (with its error); the rest were drawn. */
    refused: Array<{ buildings: string[]; error: string }>;
}

/**
 * Extrudes `buildings` natively into `dir`/vector_massing.glb. One run for all; if the tool refuses it, the buildings are
 * run again in chunks and a chunk it still refuses is left out and reported (never replaced by anything).
 */
export async function writePaintGlb(buildings: PaintBuilding[], baseY: (b: PaintBuilding, index: number) => number, opts: {
    dir: string; stage: string; stageKey: string; provenance: ProvenanceRecord; signal?: AbortSignal; chunk?: number;
}): Promise<PaintGlb> {
    fs.mkdirSync(opts.dir, { recursive: true });
    const index = new Map(buildings.map((b, i) => [b, i]));
    const runOn = async (list: PaintBuilding[], sub: string) => {
        const m = paintMassing(list, b => baseY(b, index.get(b)!));
        const runDir = path.join(opts.dir, sub);
        return runMassing(massingSpecText(m, { outDir: runDir, params: VECTOR_MASSING_PARAMS, provenance: VECTOR_MODELLED_LABEL }), runDir, { ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: 120_000 });
    };
    const t0 = Date.now();
    const refused: PaintGlb['refused'] = [];
    let runs: Awaited<ReturnType<typeof runOn>>[];
    try {
        runs = [await runOn(buildings, 'native')];
    } catch (err) {
        if (opts.signal?.aborted) throw err;
        const size = opts.chunk ?? 25;
        const groups: PaintBuilding[][] = [];
        for (let i = 0; i < buildings.length; i += size) groups.push(buildings.slice(i, i + size));
        const settled = await Promise.allSettled(groups.map((g, k) => runOn(g, `native_${k}`)));
        runs = [];
        settled.forEach((s, k) => {
            if (s.status === 'fulfilled') runs.push(s.value);
            else refused.push({ buildings: groups[k].map(b => b.id), error: s.reason instanceof Error ? s.reason.message : String(s.reason) });
        });
        if (!runs.length) throw err;
    }
    const nativeMs = Date.now() - t0;
    // one node per building (the tool writes one per face: tens of thousands on a district, most of the file their extras)
    const merged = mergeByBuilding(runs.flatMap(r => r.nodes));
    const file = path.join(opts.dir, 'vector_massing.glb');
    const nodes: StagedGlbNode[] = merged.map((m, i) => ({
        name: m.id, positions: m.positions, normals: m.normals, indices: m.indices,
        extras: {
            sb: {
                schema: 'scratchbox.staged-node/2', stage: opts.stage, provenance: opts.provenance, buildOrder: i, buildCount: merged.length, revealKind: 'rise',
                reveal: { attribute: null, displacement: null, durationShare: 1 / Math.max(1, merged.length) }, ids: { surfaceId: m.id },
                counts: { vertices: m.positions.length / 3, triangles: m.indices.length / 3 }
            }
        } satisfies StagedNodeExtras
    }));
    writeStagedGlbFile(file, nodes, { rootExtras: { sb: { schema: 'scratchbox.staged-glb/2', stage: opts.stage, stageKey: opts.stageKey, frame: 'tile frame: x east, y up, z south (metres)' } }, copyright: 'Google' });
    const triangles = merged.reduce((s, n) => s + n.indices.length / 3, 0);
    const vertices = merged.reduce((s, n) => s + n.positions.length / 3, 0);
    return { glb: file, counts: { vertices, triangles }, nodes: merged.length, nativeMs, refused };
}

/** The tool's nodes ("<kind>:<building>/<e|v><k>:...") merged into one mesh per building, in the order they first appear. */
export function mergeByBuilding(nodes: Array<Pick<MassingNode, 'name' | 'positions' | 'normals' | 'indices'>>): Array<{ id: string; positions: Float32Array; normals: Float32Array; indices: Uint32Array }> {
    const groups = new Map<string, Array<Pick<MassingNode, 'positions' | 'normals' | 'indices'>>>();
    for (const n of nodes) {
        const part = n.name.split(':')[1] ?? n.name;
        const id = part.replace(/\/[ev]\d+$/, '');
        const g = groups.get(id) ?? [];
        g.push(n);
        groups.set(id, g);
    }
    return [...groups].map(([id, list]) => {
        const nv = list.reduce((a, n) => a + n.positions.length / 3, 0), ni = list.reduce((a, n) => a + n.indices.length, 0);
        const positions = new Float32Array(nv * 3), normals = new Float32Array(nv * 3), indices = new Uint32Array(ni);
        let v = 0, k = 0;
        for (const n of list) {
            positions.set(n.positions, v * 3);
            normals.set(n.normals, v * 3);
            for (let i = 0; i < n.indices.length; i++) indices[k + i] = n.indices[i] + v;
            v += n.positions.length / 3;
            k += n.indices.length;
        }
        return { id, positions, normals, indices };
    });
}

/** Where the tiles reach in plan: the cells (VECTOR_COVERAGE_CELL_M) any vertex of the tile GLB falls in. */
export interface PlanCoverage { cellM: number; cells: Set<string>; has(x: number, z: number): boolean }

export function tilePlanCoverage(glbFile: string, cellM = VECTOR_COVERAGE_CELL_M): PlanCoverage {
    const cells = new Set<string>();
    for (const n of parseGlbNodes(fs.readFileSync(glbFile))) {
        const p = n.positions;
        for (let i = 0; i + 2 < p.length; i += 3) cells.add(`${Math.floor(p[i] / cellM)},${Math.floor(p[i + 2] / cellM)}`);
    }
    return { cellM, cells, has: (x, z) => cells.has(`${Math.floor(x / cellM)},${Math.floor(z / cellM)}`) };
}

function inLoopsEvenOdd(x: number, z: number, loops: Vec2[][]): boolean {
    let inside = false;
    for (const r of loops) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            const [xi, zi] = r[i], [xj, zj] = r[j];
            if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        }
    }
    return inside;
}

/** Share of a building's plan (sampled every 2 m, its volumes' vertices when it has no part) that the tiles cover. */
export function coveredShare(b: PaintBuilding, coverage: PlanCoverage, stepM = 2): number {
    let n = 0, hit = 0;
    for (const p of b.parts) {
        const xs = p.loops.flat();
        const x0 = Math.min(...xs.map(q => q[0])), x1 = Math.max(...xs.map(q => q[0])), z0 = Math.min(...xs.map(q => q[1])), z1 = Math.max(...xs.map(q => q[1]));
        for (let x = x0 + stepM / 2; x < x1; x += stepM) for (let z = z0 + stepM / 2; z < z1; z += stepM) {
            if (!inLoopsEvenOdd(x, z, p.loops)) continue;
            n++;
            if (coverage.has(x, z)) hit++;
        }
    }
    if (!n) for (const v of b.volumes.flatMap(m => m.vertices)) { n++; if (coverage.has(v[0], v[2])) hit++; }
    if (!n) return coverage.has(b.centroid[0], b.centroid[1]) ? 1 : 0;
    return hit / n;
}

/** The provenance record of a first-paint layer (one per layer; every node carries it). */
export function paintProvenance(note: string, sourceId: string): ProvenanceRecord {
    return {
        label: VECTOR_MODELLED_LABEL, measuredGeometry: false, confidence: 1,
        method: 'Google vector feature tiles (vectortiles.featuretiles): building footprints extruded to their heights, and the modelled 3D volume where Google has one, carried unchanged and built natively (staged_massing); not scan measurement',
        sources: [{ kind: 'vector-data', id: sourceId }], note
    };
}
