/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects, automatic: the same two-phase read the chat-facing `location_street_objects` tool runs by hand
 * (blob-reader.ts's cheap read first, Street View only for what it leaves unsure), called from a district build itself
 * (orchestrator.ts's scene-inventory step) instead of waiting for someone to ask for it. Gated off by default
 * (staged-switches.ts streetObjectsAuto): until a real district build has been judged by eye, nothing here runs.
 *
 * Budget: at most `maxFamilies` families (the largest first, as run.ts already sorts them) go to Street View and the
 * vision model in one call. The cheap read itself asks no Street View and costs one vision call per contact sheet of
 * blobs (blob-reader.ts's own batching), whatever the switch.
 *
 * Mirrors the tool's own unsure-selection logic (location-evidence/street-objects.ts) rather than importing it: the two
 * call sites differ enough in their surrounding state (one is a hand-run tool over files on disk with scanGlbs/tileGlbs
 * and freshRead, the other a build step with the district's own deps and cache already resolved) that sharing the
 * handful of lines risked a wrong abstraction more than it saved; keep them in step by eye if blob-reader.ts's unsure
 * rule changes.
 */

import type { ResidualAuditResult } from '../residual-audit';
import type { EvidenceLookup, VectorEvidence } from '../vector-footprints';
import type { GeodeticOrigin } from '../../../spatial/StreetViewSurveyPlanner';
import type { StreetViewEvidenceDeps } from '../streetview-evidence';
import { missingCredentials } from '../streetview-evidence';
import type { VisionModelChain } from '../../../gemini/vision-model-chain';
import type { ModelReadingStore } from '../pipeline-k/model-readings';
import { readTileTriangles } from '../tile-texture-transfer';
import { BLOB_READ_PARAMS, readBlobs, type BlobReadReport } from './blob-reader';
import { rebuildStreetObjects, type StreetObjectsReport } from './run';
import * as fs from 'fs';
import * as path from 'path';

/** At most this many families go to Street View and the vision model in one automatic call, unless the build asks for fewer. */
export const STREET_OBJECTS_AUTO_DEFAULT_MAX_FAMILIES = 12;

/** Bumped whenever the automatic pass's own logic changes (not run.ts's or blob-reader.ts's own versions, which are in their keys already). */
export const STREET_OBJECTS_AUTO_VERSION = 'street-objects-auto/1';

export interface StreetObjectsAutoInput {
    origin: GeodeticOrigin;
    /** The district residual audit (scene-inventory's own `auditDistrict` call). */
    audit: ResidualAuditResult;
    /** The tree-stripped scan the audit read. */
    scanGlb: string;
    /** The full textured tile (trees in: a photo sees them too), for the cheap read's orthophoto and, if it runs, Street View's registration and occlusion. */
    tileGlb: string;
    vector: Pick<VectorEvidence, 'buildings' | 'roads'>;
    look: Pick<EvidenceLookup, 'buildingAt' | 'roadAt' | 'landuseAt'>;
    /** Absent or missing credentials: the cheap read still runs, Street View does not. */
    streetView?: StreetViewEvidenceDeps;
    vision: VisionModelChain<string>;
    /** Where the cheap read's blob labels are kept between builds, so a rerun over the same district does not pay for the same reads twice. */
    store?: ModelReadingStore;
    outDir: string;
    /** At most this many families go to Street View (the largest first); STREET_OBJECTS_AUTO_DEFAULT_MAX_FAMILIES by default. */
    maxFamilies?: number;
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
}

export interface StreetObjectsAutoResult {
    blobs: BlobReadReport;
    /** Absent when nothing read as unsure needed Street View, or Street View/vision were not available (see `skipped`). */
    objects?: StreetObjectsReport;
    /** Why Street View was not asked, when it was not: no service, missing credentials, no vision model, or nothing unsure. */
    skipped?: string;
}

/**
 * The clusters the cheap read leaves unsure and worth asking Street View about: standing up off the ground, not read as
 * a scan fault, and under the confident bar — plus every cluster the cheap read did not reach at all (left out of no
 * sheet, excluded by neither a building-part nor an artefact reason). The same rule location-evidence/street-objects.ts
 * applies by hand.
 */
export function unsureClusters(blobs: BlobReadReport): number[] {
    const labelled = new Set(blobs.labels.map(l => l.clusterId));
    const out = new Set(blobs.leftOut.map(o => o.clusterId));
    return [
        ...blobs.labels.filter(l => l.confidence < BLOB_READ_PARAMS.confidentAt && l.standing >= 0.5 && l.scanFault < 0.5).map(l => l.clusterId),
        ...blobs.evidence.filter(e => !labelled.has(e.clusterId) && !out.has(e.clusterId)).map(e => e.clusterId)
    ];
}

/**
 * The cheap read over the whole audit, then (only for what it leaves unsure, capped at `maxFamilies`) Street View and the
 * native rebuild, each kept only where it beats the scan's blob on the photos (street-objects/run.ts judgeFamily). Never
 * removes or changes anything the build already has: report-only, exactly as the hand-run tool is, so a caller decides
 * what to do with a kept family's GLB (`objects.layerGlb`).
 */
export async function autoRebuildStreetObjects(input: StreetObjectsAutoInput): Promise<StreetObjectsAutoResult> {
    fs.mkdirSync(input.outDir, { recursive: true });
    const progress = input.onProgress ?? (() => undefined);
    const tile = readTileTriangles(fs.readFileSync(input.tileGlb));
    progress(`reading the district's street clusters from the scan, the map and the tile photo (no Street View yet)`);
    const blobs = await readBlobs({
        audit: input.audit, look: input.look, vector: input.vector, tile, vision: input.vision, ...(input.store ? { store: input.store } : {}),
        onSheet: (i, jpeg) => fs.writeFileSync(path.join(input.outDir, `blob_sheet_${String(i).padStart(3, '0')}.jpg`), jpeg),
        ...(input.signal ? { signal: input.signal } : {}), onProgress: progress
    });
    fs.writeFileSync(path.join(input.outDir, 'blob_read.json'), JSON.stringify(blobs));
    const unsure = unsureClusters(blobs);
    if (!unsure.length) return { blobs, skipped: 'the cheap read left nothing unsure: no cluster needed Street View' };
    if (!input.streetView) return { blobs, skipped: 'no Street View service is configured' };
    const missing = missingCredentials(input.streetView);
    if (missing) return { blobs, skipped: `Street View credentials: ${missing}` };
    const maxFamilies = input.maxFamilies ?? STREET_OBJECTS_AUTO_DEFAULT_MAX_FAMILIES;
    progress(`${unsure.length} cluster${unsure.length === 1 ? '' : 's'} left unsure by the cheap read; asking Street View for at most ${maxFamilies} families`);
    const objects = await rebuildStreetObjects({
        origin: input.origin, audit: input.audit, scanGlb: input.scanGlb, tileGlb: input.tileGlb,
        streetView: { ...input.streetView, refusedPanos: input.streetView.refusedPanos ?? new Map<string, string>() },
        vision: input.vision, outDir: input.outDir, maxFamilies, only: unsure,
        ...(input.signal ? { signal: input.signal } : {}), onProgress: progress
    });
    return { blobs, objects };
}
