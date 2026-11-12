/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A real place as a reference for an imagined environment: what Google's vector data says about the ground around it
 * (street centrelines, building footprints and heights, land-use and water areas, rails, points of interest), in the
 * metres of a local frame, with the proportions a builder needs measured from it: building heights and footprint
 * areas, how much of the ground is built, the street grid's bearing, and each street's width from building front to
 * building front (the vector data carries centrelines, not widths). A script reads it as sb.reference() and sizes an
 * imagined scene from real proportions; nothing is staged at the place (google_3d_tiles_get_clay does that).
 *
 * Everything here is vector-modelled (Google's outlines and heights) or measured on those outlines (the front-to-front
 * widths); type codes are labels for the script to read, never something this code branches on.
 */

import * as path from 'path';
import type { MapVectorOverlay, MapVec2 } from '../../common/spatial/map-data-view';
import { buildMapVectorOverlay } from '../spatial/map-data-service';
import { GoogleVectorTileService } from '../spatial/GoogleVectorTileService';
import { GoogleMapsService } from '../../browser/generative-canvas/services/google-maps-service';

export interface Spread { p10: number; p50: number; p90: number; max: number; count: number }

export interface ReferenceStreet {
    id: string;
    types: string[];
    points: MapVec2[];
    lengthM: number;
    /** Median width between the building fronts either side, where both sides have a building within reach. */
    frontageWidthM?: number;
    /** Stations where both sides met a building front. */
    frontageSamples: number;
    /** Median distance from the centreline to the front on each side (left of the street's drawing direction first). */
    frontageLeftM?: number;
    frontageRightM?: number;
}

export interface ReferencePlace {
    place: { query: string; resolvedAs: string; lat: number; lng: number };
    frame: string;
    radiusM: number;
    streets: ReferenceStreet[];
    buildings: Array<{ id: string; loops: MapVec2[][]; heightM?: number; areaM2: number; centroid: MapVec2 }>;
    areas: Array<{ types: string[]; loops: MapVec2[][] }>;
    rails: MapVec2[][];
    pois: Array<{ x: number; z: number; types: string[]; name?: string }>;
    stats: {
        buildings: number;
        buildingsWithHeight: number;
        heightM?: Spread;
        footprintAreaM2?: Spread;
        /** Share of the disk of radiusM that building footprints cover. */
        builtShare: number;
        streetFrontageWidthM?: Spread;
        streetLengthM: number;
        /** The street grid's dominant bearing, degrees clockwise from north, folded into [0, 90): its streets run along it and at right angles. */
        gridBearingDeg?: number;
    };
    provenance: { vector: string; widths: string; heights: string };
}

/** The frame every coordinate is in. */
export const REFERENCE_FRAME = 'x east, z south, metres from the place point; heights in metres above the ground';
/** How far from a centreline a building front is looked for. */
const FRONTAGE_REACH_M = 60;
/** Spacing of the stations along each street where the fronts are measured. */
const FRONTAGE_STEP_M = 10;

function spread(values: number[]): Spread | undefined {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length) return undefined;
    const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
    const r = (x: number) => Math.round(x * 100) / 100;
    return { p10: r(q(0.1)), p50: r(q(0.5)), p90: r(q(0.9)), max: r(v[v.length - 1]), count: v.length };
}

function median(values: number[]): number | undefined {
    return spread(values)?.p50;
}

/** Signed area (shoelace) and centroid of a closed loop. */
function loopArea(loop: MapVec2[]): { area: number; cx: number; cz: number } {
    let a = 0, cx = 0, cz = 0;
    for (let i = 0; i < loop.length; i++) {
        const [x0, z0] = loop[i], [x1, z1] = loop[(i + 1) % loop.length];
        const c = x0 * z1 - x1 * z0;
        a += c; cx += (x0 + x1) * c; cz += (z0 + z1) * c;
    }
    a /= 2;
    return Math.abs(a) < 1e-9 ? { area: 0, cx: loop[0]?.[0] ?? 0, cz: loop[0]?.[1] ?? 0 } : { area: a, cx: cx / (6 * a), cz: cz / (6 * a) };
}

/** Distance along the ray (ox, oz) + t (dx, dz) to segment (a, b), or Infinity. */
function rayHit(ox: number, oz: number, dx: number, dz: number, a: MapVec2, b: MapVec2): number {
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) return Infinity;
    const wx = a[0] - ox, wz = a[1] - oz;
    const t = (wx * ez - wz * ex) / den, u = (wx * dz - wz * dx) / den;
    return t > 1e-6 && u >= 0 && u <= 1 ? t : Infinity;
}

/** Even-odd point in loops. */
function insideLoops(x: number, z: number, loops: MapVec2[][]): boolean {
    let inside = false;
    for (const loop of loops) for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [xi, zi] = loop[i], [xj, zj] = loop[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/** Share of the disk of `radiusM` that any footprint covers, sampled on a grid of `cellM` (overlapping parts once). */
function coveredShare(footprints: MapVec2[][][], radiusM: number, cellM: number): number {
    const n = Math.ceil((2 * radiusM) / cellM);
    const covered = new Uint8Array(n * n);
    for (const loops of footprints) {
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const l of loops) for (const [x, z] of l) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
        const i0 = Math.max(0, Math.floor((x0 + radiusM) / cellM)), i1 = Math.min(n - 1, Math.floor((x1 + radiusM) / cellM));
        const k0 = Math.max(0, Math.floor((z0 + radiusM) / cellM)), k1 = Math.min(n - 1, Math.floor((z1 + radiusM) / cellM));
        for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) {
            if (covered[k * n + i]) continue;
            const x = -radiusM + (i + 0.5) * cellM, z = -radiusM + (k + 0.5) * cellM;
            if (insideLoops(x, z, loops)) covered[k * n + i] = 1;
        }
    }
    let disk = 0, built = 0;
    for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
        const x = -radiusM + (i + 0.5) * cellM, z = -radiusM + (k + 0.5) * cellM;
        if (x * x + z * z > radiusM * radiusM) continue;
        disk++;
        if (covered[k * n + i]) built++;
    }
    return disk ? built / disk : 0;
}

/**
 * The reference derived from a vector overlay (the testable part). Streets are measured front to front at stations
 * every FRONTAGE_STEP_M: the nearest footprint edge along the centreline's normal on each side, within FRONTAGE_REACH_M.
 */
export function referenceFromOverlay(overlay: MapVectorOverlay, place: ReferencePlace['place']): ReferencePlace {
    const buildings = overlay.footprints.map(f => {
        let area = 0, cx = 0, cz = 0;
        for (const loop of f.loops) {
            const l = loopArea(loop);
            area += l.area; cx += l.cx * l.area; cz += l.cz * l.area;
        }
        const a = Math.abs(area);
        const centroid: MapVec2 = Math.abs(area) > 1e-9 ? [cx / area, cz / area] : (f.loops[0]?.[0] ?? [0, 0]);
        return { id: f.id, loops: f.loops, ...(f.heightM !== undefined ? { heightM: f.heightM } : {}), areaM2: Math.round(a * 10) / 10, centroid };
    });
    // every footprint edge once, with a coarse grid to look edges up near a ray
    const edges: Array<[MapVec2, MapVec2]> = [];
    for (const f of overlay.footprints) for (const loop of f.loops) for (let i = 0; i < loop.length; i++) edges.push([loop[i], loop[(i + 1) % loop.length]]);
    const cell = 20, grid = new Map<string, number[]>();
    edges.forEach(([a, b], i) => {
        const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
        const z0 = Math.floor(Math.min(a[1], b[1]) / cell), z1 = Math.floor(Math.max(a[1], b[1]) / cell);
        for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
            const k = `${gx},${gz}`;
            (grid.get(k) ?? grid.set(k, []).get(k)!).push(i);
        }
    });
    const nearestFront = (ox: number, oz: number, dx: number, dz: number): number => {
        const seen = new Set<number>();
        let best = Infinity;
        // walk the ray's cells to the reach
        for (let s = 0; s <= FRONTAGE_REACH_M; s += cell / 2) {
            const gx = Math.floor((ox + dx * s) / cell), gz = Math.floor((oz + dz * s) / cell);
            for (let ix = gx - 1; ix <= gx + 1; ix++) for (let iz = gz - 1; iz <= gz + 1; iz++) {
                for (const e of grid.get(`${ix},${iz}`) ?? []) {
                    if (seen.has(e)) continue;
                    seen.add(e);
                    const t = rayHit(ox, oz, dx, dz, edges[e][0], edges[e][1]);
                    if (t < best) best = t;
                }
            }
            if (best <= s) break;
        }
        return best <= FRONTAGE_REACH_M ? best : Infinity;
    };

    const allWidths: number[] = [];
    const bearings: Array<{ deg: number; w: number }> = [];
    const streets: ReferenceStreet[] = overlay.roads.map((r, ri) => {
        let lengthM = 0;
        const widths: number[] = [], lefts: number[] = [], rights: number[] = [];
        let carry = 0;
        for (let i = 0; i + 1 < r.points.length; i++) {
            const [x0, z0] = r.points[i], [x1, z1] = r.points[i + 1];
            const len = Math.hypot(x1 - x0, z1 - z0);
            if (len < 1e-6) continue;
            lengthM += len;
            const tx = (x1 - x0) / len, tz = (z1 - z0) / len;
            // bearing clockwise from north (-z), folded to the grid's quarter turn
            bearings.push({ deg: ((Math.atan2(tx, -tz) * 180 / Math.PI) % 90 + 90) % 90, w: len });
            // left of the drawing direction, in a frame with x east and z south (looking down from +y): (tz, -tx)
            const lx = tz, lz = -tx;
            for (let s = carry; s < len; s += FRONTAGE_STEP_M) {
                const ox = x0 + tx * s, oz = z0 + tz * s;
                const left = nearestFront(ox, oz, lx, lz), right = nearestFront(ox, oz, -lx, -lz);
                if (Number.isFinite(left) && Number.isFinite(right)) { widths.push(left + right); lefts.push(left); rights.push(right); }
            }
            carry = ((carry - len) % FRONTAGE_STEP_M + FRONTAGE_STEP_M) % FRONTAGE_STEP_M;
        }
        allWidths.push(...widths);
        const w = median(widths), l = median(lefts), rr = median(rights);
        return {
            id: `road_${ri}`, types: r.types, points: r.points, lengthM: Math.round(lengthM * 10) / 10,
            ...(w !== undefined ? { frontageWidthM: w, frontageLeftM: l, frontageRightM: rr } : {}), frontageSamples: widths.length
        };
    });
    // the grid's bearing: the length-weighted circular mean of the folded bearings (period 90 degrees)
    let sx = 0, sy = 0;
    for (const b of bearings) { const a = (b.deg * 4) * Math.PI / 180; sx += b.w * Math.cos(a); sy += b.w * Math.sin(a); }
    const gridBearingDeg = bearings.length && Math.hypot(sx, sy) > 1e-6 ? Math.round((((Math.atan2(sy, sx) * 180 / Math.PI) / 4) % 90 + 90) % 90 * 10) / 10 : undefined;
    // the spreads and the built share are of what stands inside the radius: the tiles reach past it, and Google stacks a
    // building's parts as overlapping footprints, so the share is of the ground covered (a 2 m grid, overlaps once)
    const inside = buildings.filter(b => Math.hypot(b.centroid[0], b.centroid[1]) <= overlay.radiusM);
    const builtShare = coveredShare(overlay.footprints.map(f => f.loops), overlay.radiusM, 2);
    const heights = inside.filter(b => b.heightM !== undefined).map(b => b.heightM as number);
    return {
        place, frame: REFERENCE_FRAME, radiusM: overlay.radiusM,
        streets, buildings, areas: overlay.areas, rails: overlay.rails, pois: overlay.pois,
        stats: {
            buildings: inside.length,
            buildingsWithHeight: heights.length,
            ...(spread(heights) ? { heightM: spread(heights) } : {}),
            ...(spread(inside.map(b => b.areaM2)) ? { footprintAreaM2: spread(inside.map(b => b.areaM2)) } : {}),
            builtShare: Math.round(builtShare * 1000) / 1000,
            ...(spread(allWidths) ? { streetFrontageWidthM: spread(allWidths) } : {}),
            streetLengthM: Math.round(streets.reduce((n, s) => n + s.lengthM, 0)),
            ...(gridBearingDeg !== undefined ? { gridBearingDeg } : {})
        },
        provenance: {
            vector: overlay.provenance.vector,
            widths: `street widths measured building front to building front on the vector footprints, every ${FRONTAGE_STEP_M} m within ${FRONTAGE_REACH_M} m of the centreline (vector-modelled; a station with no building on one side is left out)`,
            heights: `${heights.length} of the ${inside.length} footprints inside the radius carry a height in Google's vector data (vector-modelled; a building's parts are separate footprints); the rest have none`
        }
    };
}

/** Resolves the place (coordinates as given, else one Google Places text search) and reads its reference. */
export async function measureReferencePlace(query: string, opts: { workspaceRoot: string; radiusM?: number; signal?: AbortSignal }): Promise<ReferencePlace> {
    const radiusM = Math.max(50, Math.min(1000, opts.radiusM ?? 250));
    const coords = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(query);
    let place: ReferencePlace['place'];
    if (coords) {
        place = { query, resolvedAs: `${Number(coords[1]).toFixed(6)}, ${Number(coords[2]).toFixed(6)}`, lat: Number(coords[1]), lng: Number(coords[2]) };
    } else {
        const key = GoogleVectorTileService.resolveApiKey();
        if (!key) throw new Error(`No Google Maps API key is configured, so "${query}" cannot be looked up (add the key in Settings, or give "lat, lng").`);
        const g = await GoogleMapsService.getInstance().geocode(query, { apiKey: key });
        const name = g.name && !g.formattedAddress.startsWith(g.name) ? `${g.name}, ${g.formattedAddress}` : g.formattedAddress;
        place = { query, resolvedAs: name, lat: g.lat, lng: g.lng };
    }
    if (opts.signal?.aborted) throw new Error('Stopped.');
    const { overlay } = await buildMapVectorOverlay({
        lat: place.lat, lng: place.lng, radiusM,
        fetchTile: (x, y, z) => GoogleVectorTileService.fetchVectorTile(x, y, z, '') as never,
        cacheDir: path.join(opts.workspaceRoot, '.scratchbox', 'cache', 'map-data')
    });
    return referenceFromOverlay(overlay, place);
}

/** One line for the builder: what the reference holds and its main proportions. */
export function describeReference(r: ReferencePlace): string {
    const s = r.stats;
    const fmt = (sp: Spread | undefined, unit: string) => (sp ? `${sp.p10}-${sp.p90} ${unit} (median ${sp.p50})` : 'not available');
    return `Reference place ${r.place.resolvedAs} (radius ${r.radiusM} m): ${s.buildings} footprints, ${s.buildingsWithHeight} with heights ${fmt(s.heightM, 'm')}; `
        + `street widths front to front ${fmt(s.streetFrontageWidthM, 'm')}; ${Math.round(s.builtShare * 100)}% of the ground built`
        + `${s.gridBearingDeg !== undefined ? `; street grid at ${s.gridBearingDeg} deg from north` : ''}. Read it in the script with sb.reference().`;
}
