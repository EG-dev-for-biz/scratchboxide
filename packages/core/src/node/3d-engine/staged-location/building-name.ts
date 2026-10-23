/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * What a staged building is called, decided from the evidence at hand and nothing else: Google's named points of interest
 * (vector-footprints.ts, `VectorEvidence.pois`, scan frame) that lie inside the chosen structure's footprint or within
 * POI_NEAR_M of it, and the user's own words for the place (the request query minus whatever of it is the resolved
 * address). A POI inside the footprint names the building; otherwise the request's phrase does. No dictionary of
 * landmarks lives here, and a POI's type codes travel as labels only (AGENTS.md §1): nothing branches on them.
 *
 * The name is what the search-grounded references (pipeline-g/references.ts) look the building up by: "Flatiron Building,
 * New York" finds the facade photographs that "175 5th Ave, New York, NY 10010, USA" does not.
 */

import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { inLoops } from './pipeline-e/massing-spec';

/** How far outside the footprint a named POI may stand and still be a candidate name (a pin dropped on the pavement). */
export const POI_NEAR_M = 5;

export interface BuildingNameCandidate {
    name: string;
    source: 'poi' | 'request';
    /** Metres from the footprint's edge (0 inside it); 0 for the request's phrase, which names the place asked for. */
    distanceM: number;
    /** The POI's Google type codes (labels; empty for the request's phrase). */
    types: string[];
}

export interface BuildingNames {
    /** POIs inside the footprint first, then by distance; the request's own phrase last. */
    names: BuildingNameCandidate[];
    /** The POI name inside the footprint when there is one, else the request's phrase; absent when neither exists. */
    primary?: string;
}

export type Poi = { x: number; z: number; types?: string[]; name?: string };

/** Distance from (x, z) to the nearest edge of any ring, 0 when the point lies inside a part (its loops filled even-odd). */
export function footprintDistanceM(x: number, z: number, parts: Vec2[][][]): number {
    let best = Infinity;
    for (const loops of parts) {
        if (inLoops(x, z, loops)) return 0;
        for (const ring of loops) {
            for (let i = 0; i < ring.length; i++) {
                const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
                const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz;
                const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
                best = Math.min(best, Math.hypot(x - (ax + t * dx), z - (az + t * dz)));
            }
        }
    }
    return best;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The request's own words for the place: the query with every comma- (or "in"/"at"/"near"-) separated part that is a
 * street line (starts with a number) or repeats a part of the resolved address taken out. "Flatiron Building, 175 5th
 * Ave, New York" against "175 5th Ave, New York, NY 10010, USA" leaves "Flatiron Building"; a query that is only the
 * address leaves nothing.
 */
export function requestPhrase(query: string | undefined, address: string | undefined): string | undefined {
    if (!query?.trim()) return undefined;
    const addressWhole = norm(address ?? '');
    const kept = query.split(/,|\s+(?:in|at|near)\s+/i).map(p => p.trim()).filter(p => {
        const n = norm(p);
        return !!n && !/^\d/.test(n) && !(addressWhole && addressWhole.includes(n));
    });
    const phrase = kept.join(', ').trim();
    return phrase || undefined;
}

/**
 * The locality of a formatted address for a search query: the first part after the street line, with postcode and
 * region tokens taken off ("175 5th Ave, New York, NY 10010, USA" → "New York"; "Flinders St, Melbourne VIC 3000,
 * Australia" → "Melbourne"). The whole address when it has no commas to read.
 */
export function localityOf(address: string | undefined): string | undefined {
    if (!address?.trim()) return undefined;
    const parts = address.split(',').map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return parts[0];
    const rest = /\d/.test(parts[0]) || parts.length >= 3 ? parts.slice(1) : parts;
    for (const p of rest) {
        const words = p.split(/\s+/).filter(w => !/^\d[\d-]*$/.test(w) && !/^[A-Z]{2,3}$/.test(w));
        if (words.length) return words.join(' ');
    }
    return rest[0];
}

/** The names the evidence gives the structure whose footprint `parts` is (scan frame). See the module comment. */
export function decideBuildingNames(input: { parts: Vec2[][][]; pois?: readonly Poi[]; query?: string; address?: string }): BuildingNames {
    const names: BuildingNameCandidate[] = [];
    for (const p of input.pois ?? []) {
        const name = p.name?.trim();
        if (!name) continue;
        const distanceM = footprintDistanceM(p.x, p.z, input.parts);
        if (distanceM > POI_NEAR_M) continue;
        names.push({ name, source: 'poi', distanceM: Math.round(distanceM * 100) / 100, types: [...(p.types ?? [])] });
    }
    names.sort((a, b) => a.distanceM - b.distanceM);
    const inside = names.find(n => n.distanceM === 0);
    const phrase = requestPhrase(input.query, input.address);
    if (phrase && !names.some(n => norm(n.name) === norm(phrase))) names.push({ name: phrase, source: 'request', distanceM: 0, types: [] });
    const primary = inside?.name ?? phrase ?? names.find(n => n.source === 'request')?.name;
    return { names, ...(primary ? { primary } : {}) };
}
