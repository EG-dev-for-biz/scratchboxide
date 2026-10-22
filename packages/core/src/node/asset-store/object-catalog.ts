/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The "everything in a tile" object catalog (user decision, 2026-10-21): every staged-location build that discovers
 * a real-world object - a tree, a residual-audit cluster kept as a real object, anything a future classifier adds -
 * records it in the durable asset store's `objects` table (asset-db.ts) with its type, bounding box (WGS-84) and the
 * time it was first discovered, instead of that classification staying transient per-build JSON.
 *
 * Re-discovering the same object on a later build (a rebuild of the same place, an overlapping district) must not
 * create a duplicate row: `recordDiscoveredObject` looks for an existing object of the same type within
 * `dedupRadiusM` of the new one's centroid first. A match refreshes its last-seen time and bounding box (the new
 * measurement, usually the better one); no match inserts a new row with a fresh id.
 *
 * Deliberately a thin layer over asset-db.ts: no new storage mechanism, the same SQLite file every other durable
 * asset already lives in, through the same `defaultDurableAssetStore()` instance. Like the rest of that store, a
 * missing or unavailable database is never a build-breaking error - just informative (events(), objectsNear()).
 */

import * as crypto from 'crypto';
import { type AssetDb, type ObjectRow } from './asset-db';
import { defaultDurableAssetStore } from './durable-asset-store';

export interface DiscoveredObjectInput {
    /** An SB_FEATURE_TYPE_* code (sb-feature-types.ts); open vocabulary - any string is accepted and kept. */
    type: string;
    /** The reason/description a classifier gave it, if any (e.g. a residual-audit AuditedCluster's `reason`). */
    label?: string;
    confidence?: number;
    /** WGS-84 centroid. */
    lat: number;
    lng: number;
    /** WGS-84 axis-aligned bounding box; `alt` is ellipsoidal height in metres, same convention as the tile's own geoAnchor. */
    bboxLo: { lat: number; lng: number; alt: number };
    bboxHi: { lat: number; lng: number; alt: number };
    /** What found it: 'residual-audit' | 'tree-crown' | ... (open). */
    source: string;
    runId?: string;
    workspace?: string;
    /** An existing object of the same type within this many metres of the new centroid is the same object. Default 3 m. */
    dedupRadiusM?: number;
}

export interface DiscoveredObjectResult { id: string; isNew: boolean }

const DEG_PER_M_LAT = 1 / 111_320;
const degPerMLng = (lat: number) => 1 / (111_320 * Math.max(0.01, Math.cos((lat * Math.PI) / 180)));

/** Great-circle-ish planar distance (metres), good enough at the scale (metres to tens of metres) this dedup needs. */
function distanceM(aLat: number, aLng: number, bLat: number, bLng: number): number {
    const dLat = (aLat - bLat) / DEG_PER_M_LAT, dLng = (aLng - bLng) / degPerMLng((aLat + bLat) / 2);
    return Math.hypot(dLat, dLng);
}

/** The nearest existing object of `type` within `radiusM` of (lat, lng), or undefined. */
function nearestExisting(db: AssetDb, type: string, lat: number, lng: number, radiusM: number): ObjectRow | undefined {
    const deg0 = Math.max(DEG_PER_M_LAT, degPerMLng(lat)) * radiusM;
    const candidates = db.objectsNear(lat, lng, deg0, type);
    let best: ObjectRow | undefined, bestD = Infinity;
    for (const c of candidates) {
        const d = distanceM(lat, lng, c.lat, c.lng);
        if (d <= radiusM && d < bestD) { best = c; bestD = d; }
    }
    return best;
}

/**
 * Records a discovered object, deduplicated by proximity (see module doc). Returns its id and whether this was a
 * first discovery. A no-op (`isNew: false`, a synthetic id) when the durable asset store is unavailable (opted out,
 * or node:sqlite missing) - never throws, the same "informative only" shape as the rest of that store.
 */
export function recordDiscoveredObject(input: DiscoveredObjectInput): DiscoveredObjectResult {
    const store = defaultDurableAssetStore();
    if (!store) return { id: `unrecorded:${crypto.randomUUID()}`, isNew: false };
    const radiusM = input.dedupRadiusM ?? 3;
    const existing = nearestExisting(store.db, input.type, input.lat, input.lng, radiusM);
    const id = existing?.id ?? `${input.source}:${input.type}:${crypto.randomUUID()}`;
    store.db.upsertObject({
        id, type: input.type, label: input.label ?? null, confidence: input.confidence ?? null, lat: input.lat, lng: input.lng,
        bboxLoLat: input.bboxLo.lat, bboxLoLng: input.bboxLo.lng, bboxLoAlt: input.bboxLo.alt,
        bboxHiLat: input.bboxHi.lat, bboxHiLng: input.bboxHi.lng, bboxHiAlt: input.bboxHi.alt,
        source: input.source, runId: input.runId ?? null, workspace: input.workspace ?? null,
        ...(existing ? { discoveredAtMs: existing.discoveredAtMs } : {})
    });
    if (!existing) store.db.addEvent('object.discovered', id, null, { type: input.type, lat: input.lat, lng: input.lng, source: input.source });
    return { id, isNew: !existing };
}

/** Records several discovered objects in one pass; never throws per-item (a bad one is skipped, not fatal to the rest). */
export function recordDiscoveredObjects(inputs: DiscoveredObjectInput[]): { recorded: number; new: number } {
    let recorded = 0, isNew = 0;
    for (const input of inputs) {
        try {
            const r = recordDiscoveredObject(input);
            recorded++;
            if (r.isNew) isNew++;
        } catch { /* one bad object never costs the rest of the catalog pass */ }
    }
    return { recorded, new: isNew };
}
