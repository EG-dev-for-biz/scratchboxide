/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A second, independent source for a facade grammar: Google's vector building footprints (vectortiles.featuretiles,
 * extruded areas with their modeled height), optionally with the building heights the Solar API DSM measures
 * (building-shape-fusion.ts). They say two things a facade photo does not measure:
 *  - which part of a wall plane belongs to which building: a footprint edge lying on the plane is one building's
 *    stretch of the facade, so the grammar's side-by-side sections should end where the buildings do;
 *  - how tall each building is: its top storey should reach about its roof.
 * Nothing here is a gate on its own: the grammar is read from the tile photo and gated on the scan and held-out photo
 * evidence; this says whether an independent source agrees, and the outcome reports it per facade.
 */

import type { FacadeGrammar, ReliefOrthoFacade } from './facade-grammar';

export type LngLat = [number, number];

/** A building's footprint in the tile frame (x east, z south, metres from the place) and its height above ground. */
export interface FootprintBuilding {
    /** The piece (one extruded area) and the building it belongs to. */
    id: string;
    buildingId: string;
    ring: Array<[number, number]>;
    heightM?: number;
    /** Where the height came from ('vector', 'dsm', open). */
    heightSource: 'vector' | 'dsm' | (string & {});
}

export interface FootprintSource {
    buildings: FootprintBuilding[];
    /** What was used, in words (shown with the outcome). */
    note: string;
}

const M_PER_DEG_LAT = 111_320;

/** Vector footprints (lng, lat) to the tile frame of a place: x east, z south, metres. */
export function toTileFrame(ring: LngLat[], place: { lat: number; lng: number }): Array<[number, number]> {
    const kx = M_PER_DEG_LAT * Math.cos((place.lat * Math.PI) / 180);
    return ring.map(([lng, lat]) => [(lng - place.lng) * kx, -(lat - place.lat) * M_PER_DEG_LAT]);
}

/** One building's stretch of a facade: [s0, s1] along the facade's s axis, and its height. */
export interface FacadeBuildingPart { id: string; buildingId: string; s0: number; s1: number; heightM?: number }

/**
 * The buildings whose footprint edges lie on a facade's plane (within `offsetM` of it, within `angleDeg` of its
 * s axis), each with its stretch along s (clipped to the facade). Stretches of one building are merged.
 */
export function facadeBuildingParts(f: Pick<ReliefOrthoFacade, 'centroid' | 'normal' | 'axisS' | 'sMin' | 'sMax'>, buildings: FootprintBuilding[], opts: { offsetM?: number; angleDeg?: number } = {}): FacadeBuildingPart[] {
    const offset = opts.offsetM ?? 2.0, cosA = Math.cos(((opts.angleDeg ?? 12) * Math.PI) / 180);
    const n = [f.normal[0], f.normal[2]], nl = Math.hypot(n[0], n[1]) || 1;
    const sx = [f.axisS[0], f.axisS[2]], sl = Math.hypot(sx[0], sx[1]) || 1;
    const out = new Map<string, FacadeBuildingPart>();
    for (const b of buildings) {
        const r = b.ring;
        for (let i = 0; i < r.length; i++) {
            const p = r[i], q = r[(i + 1) % r.length];
            const dx = q[0] - p[0], dz = q[1] - p[1], len = Math.hypot(dx, dz);
            if (len < 1) continue;
            if (Math.abs((dx * sx[0] + dz * sx[1]) / (len * sl)) < cosA) continue;
            const off = (x: number, z: number) => ((x - f.centroid[0]) * n[0] + (z - f.centroid[2]) * n[1]) / nl;
            if (Math.abs(off(p[0], p[1])) > offset || Math.abs(off(q[0], q[1])) > offset) continue;
            const s = (x: number, z: number) => ((x - f.centroid[0]) * sx[0] + (z - f.centroid[2]) * sx[1]) / sl;
            let s0 = Math.min(s(p[0], p[1]), s(q[0], q[1])), s1 = Math.max(s(p[0], p[1]), s(q[0], q[1]));
            s0 = Math.max(s0, f.sMin); s1 = Math.min(s1, f.sMax);
            if (s1 - s0 < 1) continue;
            const prev = out.get(b.id);
            out.set(b.id, prev ? { ...prev, s0: Math.min(prev.s0, s0), s1: Math.max(prev.s1, s1) } : { id: b.id, buildingId: b.buildingId, s0, s1, ...(b.heightM !== undefined ? { heightM: b.heightM } : {}) });
        }
    }
    return [...out.values()].sort((a, b) => a.s0 - b.s0);
}

export interface FootprintAgreement {
    /** Buildings whose footprint lies on the facade. */
    buildings: number;
    /** The grammar's side-by-side sections whose span stays inside one building (within the tolerance), of those checked. */
    sectionsInside: number; sectionsChecked: number;
    /** Buildings with a height whose grammar reaches its roof: the top opening within one storey (or 4 m) below it and not above it. */
    heightsAgree: number; heightsChecked: number;
    agrees: boolean;
    why: string;
}

/**
 * Whether the vector footprints agree with a grammar: its sections (their spans along s) do not run across a building
 * boundary (beyond `tolM`), and on each footprint piece whose roof the facade reaches the grammar's top opening is below
 * that roof and within a storey of it. The facade's ground is its lowest measured point (tMin).
 */
export function footprintAgreement(g: FacadeGrammar, sectionSpans: Array<[number, number]>, f: Pick<ReliefOrthoFacade, 'tMin' | 'tMax'>, parts: FacadeBuildingPart[], tolM = 1.5): FootprintAgreement {
    if (!parts.length) return { buildings: 0, sectionsInside: 0, sectionsChecked: 0, heightsAgree: 0, heightsChecked: 0, agrees: false, why: 'no footprint edge lies on this facade' };
    let inside = 0, checked = 0;
    for (const [s0, s1] of sectionSpans) {
        const over = new Set(parts.filter(p => s1 > p.s0 + tolM && s0 < p.s1 - tolM).map(p => p.buildingId));
        if (!over.size) continue;
        checked++;
        if (over.size === 1) inside++;
    }
    const pitch = g.storeyHeightsM.length ? [...g.storeyHeightsM].sort((a, b) => a - b)[g.storeyHeightsM.length >> 1] : 4;
    let hAgree = 0, hChecked = 0;
    for (const p of parts) {
        // a piece whose roof the facade's photo does not reach (a tower set back above it) says nothing about this facade's top
        if (p.heightM === undefined || p.heightM > f.tMax - f.tMin + tolM) continue;
        const cells = g.tiers.flatMap(t => t.cols.filter(([a, b]) => b > p.s0 + tolM && a < p.s1 - tolM).map(() => t.t1));
        if (!cells.length) continue;
        hChecked++;
        const top = Math.max(...cells) - f.tMin, roof = p.heightM;
        if (top <= roof + tolM && top >= roof - Math.max(pitch, 4) - tolM) hAgree++;
    }
    const agrees = (checked === 0 || inside / checked >= 0.75) && (hChecked === 0 || hAgree / hChecked >= 0.5) && checked + hChecked > 0;
    return {
        buildings: parts.length, sectionsInside: inside, sectionsChecked: checked, heightsAgree: hAgree, heightsChecked: hChecked, agrees,
        why: `${parts.length} building footprint${parts.length === 1 ? '' : 's'} on the facade; ${inside} of ${checked} grammar sections inside one building; the top opening reaches the roof in ${hAgree} of ${hChecked} buildings`
    };
}

/** Fetches the extruded building footprints within `radiusM` of a place (zoom 17 feature tiles), in the tile frame. */
export async function fetchFootprints(place: { lat: number; lng: number }, radiusM: number,
    fetchTile: (x: number, y: number, z: number) => Promise<{ buildings: Array<{ id: string; ring: LngLat[]; properties: Record<string, unknown> }> }>): Promise<FootprintSource> {
    const z = 17;
    const n = 2 ** z;
    const tx = (lng: number) => Math.floor(((lng + 180) / 360) * n);
    const ty = (lat: number) => { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n); };
    const dLat = radiusM / M_PER_DEG_LAT, dLng = radiusM / (M_PER_DEG_LAT * Math.cos((place.lat * Math.PI) / 180));
    const xs = [tx(place.lng - dLng), tx(place.lng + dLng)], ys = [ty(place.lat + dLat), ty(place.lat - dLat)];
    const pieces: FootprintBuilding[] = [];
    let tiles = 0;
    for (let x = xs[0]; x <= xs[1]; x++)
        for (let y = ys[0]; y <= ys[1]; y++) {
            const d = await fetchTile(x, y, z);
            tiles++;
            for (const b of d.buildings) {
                if (!b.properties?.extruded || b.ring.length < 3) continue;
                const ring = toTileFrame(b.ring, place);
                if (!ring.some(([px, pz]) => Math.hypot(px, pz) <= radiusM)) continue;
                // a building's pieces (its extruded areas: a podium, a setback tower) each keep their own top
                const h = Number(b.properties.heightMeters);
                pieces.push({ id: b.id, buildingId: b.id.replace(/\/e\d+$/, ''), ring, ...(Number.isFinite(h) && h > 0 ? { heightM: h } : {}), heightSource: 'vector' });
            }
        }
    const buildings = pieces;
    return { buildings, note: `${buildings.length} extruded building footprints within ${Math.round(radiusM)} m (Google vector feature tiles, zoom ${z}, ${tiles} tiles)` };
}
