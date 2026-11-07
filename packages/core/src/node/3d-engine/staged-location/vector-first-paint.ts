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
 *     base, and Google's modelled 3D volume where it has one (its triangles as given).
 *   - A part with no height in the vector data (AGENTS.md §4 "Believability first, honestly labelled"): its measured
 *     footprint is still drawn, extruded to the height the place's own measured footprints make plausible for it
 *     (height-norm.ts: a kernel estimate over plan distance, footprint area and compactness, fitted per place by
 *     leave-one-out; SCRATCHBOX_HEIGHT_NORM=0 off), else, with too few measured footprints to fit, PLAUSIBLE_DEFAULT_HEIGHT_M,
 *     so the first paint shows a believable building instead of a gap. One building takes one estimate (its largest unmeasured
 *     part's, held under the place's own slenderness), so its fragments stand at one height. A building whose every part needed this is labelled `generated` (the height is a plausible guess,
 *     not Google's data); one where only some parts did keeps `vector-modelled` (the building overall is measured). The
 *     counts of parts and buildings given the default height are reported, same as the share left out for falling
 *     outside the requested radius.
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
import { estimateHeights, fitHeightNorm, footprintNumbers, HEIGHT_NORM_MIN_M, HEIGHT_NORM_VERSION, type HeightEstimate, type HeightNormModel, type NormFootprint, type NormSample } from './height-norm';

/** The place's height norm for unmeasured footprints (height-norm.ts): on unless SCRATCHBOX_HEIGHT_NORM=0. */
export function heightNormEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_HEIGHT_NORM !== '0';
}

export const VECTOR_MASSING_VERSION = `vector-massing/v1${heightNormEnabled() ? `+${HEIGHT_NORM_VERSION}` : ''}`;
/** The label of every vector-massing triangle (AGENTS.md §4: measured, vector-modelled, photo-inferred, generated). */
export const VECTOR_MODELLED_LABEL = 'vector-modelled';
/** An isolated structure's first paint covers this far around the place (the structure is not known before the tiles). */
export const VECTOR_ISOLATE_RADIUS_M = 40;
/** A building is kept beside the tiles when at most this share of its footprint lies where the tiles reach. */
export const VECTOR_OUTER_MAX_COVERED_SHARE = 0.5;
/**
 * A footprint part or building with no measured height in the vector data still gets drawn, at this height above its
 * base when the place has too few measured footprints for a norm of its own (height-norm.ts HEIGHT_NORM_MIN_SAMPLES), so
 * the first paint is a believable building rather than a gap (AGENTS.md §4). About 4 storeys at 3 m each: dense
 * enough to read as a building at street scale without claiming to know a real one's actual height. Never shown as
 * `vector-modelled`: a guessed height is always labelled `generated`.
 */
export const PLAUSIBLE_DEFAULT_HEIGHT_M = 12;
/** The label of a building whose height (not its footprint) is a plausible default, not Google's data. */
export const GENERATED_HEIGHT_LABEL = 'generated';
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
    parts: Array<{ loops: Vec2[][]; minH: number; topH: number; heightGuessed?: boolean }>;
    volumes: Array<{ vertices: Array<[number, number, number]>; indices: number[] }>;
    /** True when no part's height is Google's data (every part guessed, no volume): the building node is labelled `generated`. */
    heightGuessed?: boolean;
    /** The place norm's estimate its guessed parts were raised to (absent when the plain default was used). */
    heightEstimate?: HeightEstimate;
}

/** The place's height norm as the selection used it: what it was fitted on and how far off it was when tested. */
export interface PaintHeightNorm {
    version: string;
    /** Measured footprints it was fitted on. */
    samples: number;
    sigma: HeightNormModel['sigma'];
    medianM: number;
    /** Leave-one-out mean absolute error over measured footprints: the norm, and the plain default it replaces. */
    looMaeM: number;
    looMaeConstM: number;
    looByBand: HeightNormModel['looByBand'];
    /** Height over the square root of plan area that 95% of the place's measured buildings stay under: the estimates' cap. */
    maxSlenderness: number;
    /** Guessed buildings the cap lowered. */
    capped: number;
}

export interface PaintSelection {
    buildings: PaintBuilding[];
    /** Footprint parts with no height in the vector data, drawn at the norm's estimate (else PLAUSIBLE_DEFAULT_HEIGHT_M) instead. */
    partsGivenDefaultHeight: number;
    /** Buildings with no measured height anywhere (every part, no volume), drawn at the estimate and labelled `generated`. */
    buildingsGivenDefaultHeight: number;
    /** The place norm used for the guessed heights; absent when off or with too few measured footprints (the plain default then). */
    heightNorm?: PaintHeightNorm;
    /** Why the plain default was used instead of the norm, when there were guessed parts. */
    heightNormSkipped?: string;
    /** Buildings with no footprint shape and no Google volume at all: no evidence one exists here, so nothing is drawn. */
    buildingsWithNoFootprint: number;
    /** Buildings whose centroid lies beyond the requested radius (the vector tiles are whole tiles). */
    outsideRadius: number;
    /** 2D-only buildings left out because another feature's modelled volume already stands over them (VECTOR_VOLUME_DUPLICATE_SHARE). */
    buildingsUnderOtherVolume: number;
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

/**
 * A 2D-only building at least this share of whose plan lies under another feature's modelled 3D volume is that volume's
 * own footprint published again under another id (at Penn, 2026-11-07: 85 of the 96 height-less buildings of 30 m² or more
 * lay under one 81-89 m volume): it is not drawn, since the volume already draws the building at its measured height.
 */
export const VECTOR_VOLUME_DUPLICATE_SHARE = 0.5;

/** Leaving out 2D-only footprints under another feature's modelled volume: on unless SCRATCHBOX_VECTOR_VOLUME_DEDUP=0. */
export function volumeDedupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_VECTOR_VOLUME_DEDUP !== '0';
}

/** Plan triangles of every modelled volume, bucketed on a 4 m grid, with the building that owns each. */
function volumePlanIndex(ev: VectorEvidence): (x: number, z: number, notOwner: string) => boolean {
    const C = 4, grid = new Map<string, Array<{ t: number[]; owner: string }>>();
    for (const b of ev.buildings) for (const v of b.volumes ?? []) {
        for (let i = 0; i + 2 < v.indices.length; i += 3) {
            const a = v.vertices[v.indices[i]], c = v.vertices[v.indices[i + 1]], d = v.vertices[v.indices[i + 2]];
            const t = [a[0], a[2], c[0], c[2], d[0], d[2]];
            const den = (t[3] - t[5]) * (t[0] - t[4]) + (t[4] - t[2]) * (t[1] - t[5]);
            if (Math.abs(den) < 1e-6) continue;
            const x0 = Math.floor(Math.min(t[0], t[2], t[4]) / C), x1 = Math.floor(Math.max(t[0], t[2], t[4]) / C);
            const z0 = Math.floor(Math.min(t[1], t[3], t[5]) / C), z1 = Math.floor(Math.max(t[1], t[3], t[5]) / C);
            for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
                const k = `${gx},${gz}`;
                const l = grid.get(k) ?? [];
                l.push({ t, owner: b.id });
                grid.set(k, l);
            }
        }
    }
    return (x, z, notOwner) => {
        for (const { t, owner } of grid.get(`${Math.floor(x / C)},${Math.floor(z / C)}`) ?? []) {
            if (owner === notOwner) continue;
            const den = (t[3] - t[5]) * (t[0] - t[4]) + (t[4] - t[2]) * (t[1] - t[5]);
            const l1 = ((t[3] - t[5]) * (x - t[4]) + (t[4] - t[2]) * (z - t[5])) / den;
            const l2 = ((t[5] - t[1]) * (x - t[4]) + (t[0] - t[4]) * (z - t[5])) / den;
            if (l1 >= 0 && l2 >= 0 && l1 + l2 <= 1) return true;
        }
        return false;
    };
}

/** Share of `loops`' plan (sampled on a grid of at most about 400 points) that lies under another building's volume. */
function shareUnderOtherVolume(parts: Array<{ loops: Vec2[][] }>, owner: string, under: (x: number, z: number, notOwner: string) => boolean): number {
    const xs = parts.flatMap(p => p.loops[0] ?? []);
    if (!xs.length) return 0;
    const x0 = Math.min(...xs.map(q => q[0])), x1 = Math.max(...xs.map(q => q[0])), z0 = Math.min(...xs.map(q => q[1])), z1 = Math.max(...xs.map(q => q[1]));
    const step = Math.max(0.5, Math.sqrt(((x1 - x0) * (z1 - z0)) / 400));
    let n = 0, hit = 0;
    for (let x = x0 + step / 2; x < x1; x += step) for (let z = z0 + step / 2; z < z1; z += step) {
        if (!parts.some(p => inLoopsEvenOdd(x, z, p.loops))) continue;
        n++;
        if (under(x, z, owner)) hit++;
    }
    return n ? hit / n : 0;
}

/** The buildings within `radiusM` of the place that have something to draw, and what was left out. */
export function selectPaintBuildings(ev: VectorEvidence, radiusM: number, opts: { heightNorm?: boolean; volumeDedup?: boolean } = {}): PaintSelection {
    const out: PaintBuilding[] = [];
    let partsGivenDefaultHeight = 0, buildingsGivenDefaultHeight = 0, buildingsWithNoFootprint = 0, outsideRadius = 0, buildingsUnderOtherVolume = 0;
    const under = (opts.volumeDedup ?? volumeDedupEnabled()) && ev.buildings.some(b => b.volumes?.length) ? volumePlanIndex(ev) : undefined;
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
            const loops = p.loops.map(l => simplifyRing(l)).filter(l => l.length >= 3 && Math.abs(ringArea(l)) >= 1);
            if (!loops.length) continue;
            const minH = p.minHeightM ?? 0;
            const measured = p.heightM !== undefined && p.heightM > minH;
            const heightGuessed = !measured;
            if (heightGuessed) partsGivenDefaultHeight++;
            parts.push({ loops, minH, topH: measured ? p.heightM! : minH + PLAUSIBLE_DEFAULT_HEIGHT_M, heightGuessed });
        }
        // no footprint shape and no Google volume at all: genuinely nothing to draw, nothing is guessed about a building
        // whose existence and extent we have no evidence for (distinct from one whose extent is known but height is not).
        if (!parts.length && !volumes.length) { buildingsWithNoFootprint++; continue; }
        const heightGuessed = parts.length > 0 && parts.every(p => p.heightGuessed) && !volumes.length;
        // a 2D-only footprint under another feature's modelled volume is that volume's plan again: the volume draws it, measured
        if (heightGuessed && under && shareUnderOtherVolume(parts, b.id, under) >= VECTOR_VOLUME_DUPLICATE_SHARE) {
            buildingsUnderOtherVolume++;
            partsGivenDefaultHeight -= parts.length;
            continue;
        }
        if (heightGuessed) buildingsGivenDefaultHeight++;
        out.push({ id: b.id, centroid, areaM2: area, parts, volumes: volumes.map(v => ({ vertices: v.vertices.map(q => [q[0], q[1], q[2]] as [number, number, number]), indices: v.indices.slice() })), heightGuessed });
    }
    out.sort((a, b) => Math.hypot(a.centroid[0], a.centroid[1]) - Math.hypot(b.centroid[0], b.centroid[1]) || (a.id < b.id ? -1 : 1));
    const norm = partsGivenDefaultHeight ? applyHeightNorm(ev, out, opts.heightNorm ?? heightNormEnabled()) : {};
    return { buildings: out, partsGivenDefaultHeight, buildingsGivenDefaultHeight, buildingsWithNoFootprint, outsideRadius, buildingsUnderOtherVolume, ...norm };
}

/**
 * The guessed parts raised (or lowered) from PLAUSIBLE_DEFAULT_HEIGHT_M to the place norm's estimate: fitted on every
 * measured ground-standing part in the evidence (a part on a podium, minHeightM > 0, is not a height from the ground), one
 * estimate per building from its largest guessed part. Parts are the norm's unit because whole-building samples did worse
 * on the real unmeasured buildings at Penn (docs/research/2026-11-07-architectural-norms.md); but a tower's thin setback
 * parts make small parts look tall, so the estimate is held under the slenderness (height over the square root of the whole
 * plan) that 95% of the place's measured whole buildings stay under: a kiosk-sized footprint is not drawn as a needle.
 * Never below a part's own floor; measured parts are untouched.
 */
function applyHeightNorm(ev: VectorEvidence, buildings: PaintBuilding[], on: boolean): Pick<PaintSelection, 'heightNorm' | 'heightNormSkipped'> {
    if (!on) return { heightNormSkipped: 'the height norm is off (SCRATCHBOX_HEIGHT_NORM=0)' };
    const wholeOf = (parts: Array<{ loops: Vec2[][] }>): NormFootprint | undefined => {
        let largest: NormFootprint | undefined, area = 0;
        for (const p of parts) {
            const f = footprintNumbers(p.loops);
            if (!f) continue;
            area += f.areaM2;
            if (!largest || f.areaM2 > largest.areaM2) largest = f;
        }
        return largest && { ...largest, areaM2: area };
    };
    const samples: NormSample[] = [];
    const slender: number[] = [];
    for (const b of ev.buildings) {
        for (const p of b.extruded ?? []) {
            if (p.planOnly || p.heightM === undefined || (p.minHeightM ?? 0) > 0 || !(p.heightM > 0)) continue;
            const f = footprintNumbers(p.loops);
            if (f) samples.push({ ...f, heightM: p.heightM });
        }
        const ground = (b.extruded ?? []).filter(p => !p.planOnly && !((p.minHeightM ?? 0) > 0));
        if (!ground.length || ground.some(p => !(p.heightM !== undefined && p.heightM > 0))) continue;
        const whole = wholeOf(ground);
        if (whole) slender.push(Math.max(...ground.map(p => p.heightM!)) / Math.sqrt(whole.areaM2));
    }
    const model = fitHeightNorm(samples, { constantM: PLAUSIBLE_DEFAULT_HEIGHT_M });
    if (!model || !slender.length) return { heightNormSkipped: `only ${samples.length} measured footprint${samples.length === 1 ? '' : 's'} nearby to fit a norm on: the plain ${PLAUSIBLE_DEFAULT_HEIGHT_M} m default was used` };
    slender.sort((x, y) => x - y);
    const maxSlender = slender[Math.min(slender.length - 1, Math.floor(slender.length * 0.95))];
    const targets: Array<{ b: PaintBuilding; f: NormFootprint; wholeM2: number }> = [];
    for (const b of buildings) {
        let best: NormFootprint | undefined;
        for (const p of b.parts) {
            if (!p.heightGuessed) continue;
            const f = footprintNumbers(p.loops);
            if (f && (!best || f.areaM2 > best.areaM2)) best = f;
        }
        const whole = wholeOf(b.parts.filter(p => p.heightGuessed));
        if (best && whole) targets.push({ b, f: best, wholeM2: whole.areaM2 });
    }
    const est = estimateHeights(model, targets.map(t => t.f));
    let capped = 0;
    targets.forEach(({ b, wholeM2 }, i) => {
        const cap = Math.max(HEIGHT_NORM_MIN_M, Math.round(maxSlender * Math.sqrt(wholeM2) * 10) / 10);
        const e = est[i].heightM > cap ? { ...est[i], heightM: cap, lowM: Math.min(est[i].lowM, cap), highM: cap } : est[i];
        if (e !== est[i]) capped++;
        b.heightEstimate = e;
        for (const p of b.parts) if (p.heightGuessed) p.topH = Math.max(p.minH + HEIGHT_NORM_MIN_M, e.heightM);
    });
    return { heightNorm: { version: model.version, samples: model.samples.length, sigma: model.sigma, medianM: model.medianM, looMaeM: model.looMaeM, looMaeConstM: model.looMaeConstM, looByBand: model.looByBand, maxSlenderness: Math.round(maxSlender * 100) / 100, capped } };
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
 * run again in chunks and a chunk it still refuses is left out and reported (never replaced by anything). Most nodes carry
 * `opts.provenance`; a building whose height is a plausible guess (`PaintBuilding.heightGuessed`) carries
 * `opts.generatedHeightProvenance` instead, labelled `generated`, not `opts.provenance`'s `vector-modelled`.
 */
export async function writePaintGlb(buildings: PaintBuilding[], baseY: (b: PaintBuilding, index: number) => number, opts: {
    dir: string; stage: string; stageKey: string; provenance: ProvenanceRecord; generatedHeightProvenance?: ProvenanceRecord; signal?: AbortSignal; chunk?: number;
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
    const heightGuessedIds = new Set(buildings.filter(b => b.heightGuessed).map(b => b.id));
    // one node per building (the tool writes one per face: tens of thousands on a district, most of the file their extras)
    const merged = mergeByBuilding(runs.flatMap(r => r.nodes));
    const file = path.join(opts.dir, 'vector_massing.glb');
    const nodes: StagedGlbNode[] = merged.map((m, i) => ({
        name: m.id, positions: m.positions, normals: m.normals, indices: m.indices,
        extras: {
            sb: {
                schema: 'scratchbox.staged-node/2', stage: opts.stage,
                provenance: heightGuessedIds.has(m.id) && opts.generatedHeightProvenance ? opts.generatedHeightProvenance : opts.provenance,
                buildOrder: i, buildCount: merged.length, revealKind: 'rise',
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

/**
 * The provenance record of a first-paint building whose footprint is measured but whose height is a plausible guess: the
 * place norm's estimate when `norm` is given (its tested error in the method), else PLAUSIBLE_DEFAULT_HEIGHT_M.
 */
export function paintGeneratedHeightProvenance(sourceId: string, norm?: PaintHeightNorm): ProvenanceRecord {
    if (norm) return {
        label: GENERATED_HEIGHT_LABEL, measuredGeometry: false, confidence: 0.35,
        method: `the measured footprint extruded to the height the place's own ${norm.samples} measured footprints make plausible for it (${norm.version}: a kernel estimate over plan distance, footprint area and compactness, believability first, AGENTS.md §4); tested by leaving each measured footprint out, it was off by ${norm.looMaeM} m on average where the plain ${PLAUSIBLE_DEFAULT_HEIGHT_M} m default was off by ${norm.looMaeConstM} m`,
        sources: [{ kind: 'vector-data', id: sourceId }],
        note: 'no height in the vector data; shown at an estimate from the measured buildings around it, not measured'
    };
    return {
        label: GENERATED_HEIGHT_LABEL, measuredGeometry: false, confidence: 0.2,
        method: `the measured footprint extruded to a plausible default of ${PLAUSIBLE_DEFAULT_HEIGHT_M} m (believability first, AGENTS.md §4): the vector data has no height for this building`,
        sources: [{ kind: 'vector-data', id: sourceId }],
        note: `no height in the vector data; shown at a plausible ${PLAUSIBLE_DEFAULT_HEIGHT_M} m, not measured`
    };
}
