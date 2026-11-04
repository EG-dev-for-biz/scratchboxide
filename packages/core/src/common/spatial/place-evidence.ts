/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Evidence that piles up per subject in a place's store (step 5 of the district run-over-run plan,
 * docs/research/2026-11-03-district-run-over-run-plan.md), so a wall or an object one run could not see is filled when a
 * later run sees it. This module is the record's shape and its merge rule; the place store's side (storing, merging and
 * serving records to the next run's stages) comes later. Every lane that observes something about a place writes these
 * records: the street objects, kerbs, gutters and steps, the K lane's Street View fusion, the facade reader.
 *
 * **One record is one observation**: one measurement of one subject from one source in one run.
 *   - `subject`: what it is about, by the key the place store keys objects by, without the frame (the place gives it):
 *     `building/<Google vector feature id>`, `street-object/<id>`, or a part of one by its own id under it,
 *     `building/<id>/facade/<facadeId>`, `building/<id>/plane/<planeId>`. Kinds are open labels.
 *   - `measure`: what was measured, an open dotted label (`wall.visibleShare`, `window.pitchM`, `height.m`,
 *     `colour.lab`); execution reads the numbers, never branches on the label.
 *   - `value`: numbers only, a scalar, a vector or a grid (`shape`), with its unit; `where` places it (district
 *     frame metres, x east, y up, z south; or a facade's own s, t metres).
 *   - `source`: what it was observed from: its kind (`scan`, `tile-photo`, `street-view`, `model-reading`, `vector`, or
 *     any other label) and a stable id (a tile leaf or extraction key, a Street View pano id, a reading key
 *     `<kind>/<sha256>`, a vector feature id), with when it was captured and, for a camera, where it stood.
 *   - `provenance`: the label the build already uses (`measured`, `vector-modelled`, `photo-inferred`, `generated`) and a
 *     confidence in [0, 1].
 *   - `run`: the run that observed it, the code version, when.
 *
 * **Never image bytes.** Street View images are held in memory only (by rule), and no record carries pixels: values
 * are finite numbers, every string is a short id or label (checkEvidence refuses anything that looks like encoded
 * data), and a source names its image by id, never by content.
 *
 * **Merging across runs: union by source, never erasing.** A record's identity is its subject, measure, source (kind
 * and id) and run (evidenceKey). Merging two sets keeps every record of both: a second source for the same measure is
 * one more record beside the first; a later run's view of the same source is one more record beside the earlier one;
 * the same record seen twice is kept once (the copy written first stands). Nothing is ever removed by a merge. Which
 * records a stage trusts (the newest, the most confident, an average) is the reader's choice (pickEvidence gives the
 * common one), not the store's.
 */

export const PLACE_EVIDENCE_SCHEMA = 'scratchbox.place-evidence/1';

/** What an observation was made from. */
export interface EvidenceSource {
    /** Open label: 'scan', 'tile-photo', 'street-view', 'model-reading', 'vector', ... */
    kind: 'scan' | 'tile-photo' | 'street-view' | 'model-reading' | 'vector' | (string & {});
    /** Stable id: a tile leaf id or extraction key, a Street View pano id, a reading key (`<kind>/<sha256>`), a vector feature id. */
    id: string;
    /** When the source was captured (not read): ISO date, to the month for a pano ('2023-07'). */
    capturedAt?: string;
    /** For a camera: where it stood and looked, in the district frame (metres, degrees). */
    pose?: { position: [number, number, number]; headingDeg?: number; pitchDeg?: number; fovDeg?: number };
    /** For a model reading: the model asked, as its readings are keyed (model-readings.ts). */
    model?: string;
}

export interface EvidenceRecord {
    schema: typeof PLACE_EVIDENCE_SCHEMA;
    /** `building/<id>`, `street-object/<id>`, `building/<id>/facade/<facadeId>`, ...: the place store's object key without its frame. */
    subject: string;
    /** Open dotted label of what was measured. */
    measure: string;
    /** Numbers only: a scalar, a vector, or a grid of `shape` (row-major). */
    value: number | number[];
    shape?: number[];
    /** 'm', 'deg', 'share', 'lab', ... */
    unit?: string;
    /** Where on the place or the subject: a box (or a point, min alone). */
    where?: { frame: 'district' | 'facade-st' | (string & {}); min: number[]; max?: number[] };
    source: EvidenceSource;
    provenance: { label: 'measured' | 'vector-modelled' | 'photo-inferred' | 'generated' | (string & {}); confidence: number };
    run: { runId: string; code: { commit?: string; modules?: Record<string, string> }; atMs: number; host?: string };
}

/** A record's identity: subject, measure, source and run. Two records with the same key are the same observation. */
export function evidenceKey(r: Pick<EvidenceRecord, 'subject' | 'measure' | 'source' | 'run'>): string {
    return [r.subject, r.measure, r.source.kind, r.source.id, r.run.runId].join('\u0000');
}

/** Longest string a record may hold: ids and labels, never encoded data. */
export const EVIDENCE_MAX_STRING = 512;

/** What is wrong with a record, in words; empty when it may be kept. */
export function checkEvidence(r: EvidenceRecord): string[] {
    const errors: string[] = [];
    if (r.schema !== PLACE_EVIDENCE_SCHEMA) errors.push(`schema is not ${PLACE_EVIDENCE_SCHEMA}`);
    for (const [name, v] of [['subject', r.subject], ['measure', r.measure], ['source.kind', r.source?.kind], ['source.id', r.source?.id], ['run.runId', r.run?.runId]] as const) {
        if (typeof v !== 'string' || !v) errors.push(`${name} is missing`);
    }
    const values = Array.isArray(r.value) ? r.value : [r.value];
    if (!values.length || values.some(v => typeof v !== 'number' || !Number.isFinite(v))) errors.push('value holds something other than finite numbers');
    if (r.shape && r.shape.reduce((a, b) => a * b, 1) !== values.length) errors.push(`shape ${r.shape.join('x')} does not match ${values.length} values`);
    const c = r.provenance?.confidence;
    if (typeof c !== 'number' || !(c >= 0 && c <= 1)) errors.push('provenance.confidence is not in [0, 1]');
    if (r.source?.kind === 'street-view' && !r.source.capturedAt) errors.push('a Street View source names no capture date');
    // ids and labels only: a long string, or one shaped like base64 or a data URL, is data that does not belong here
    const walk = (v: unknown, at: string): void => {
        if (typeof v === 'string') {
            if (v.length > EVIDENCE_MAX_STRING || /^data:/i.test(v) || /^[A-Za-z0-9+/=]{200,}$/.test(v)) errors.push(`${at} holds data, not an id or label`);
        } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
        else if (v && typeof v === 'object') {
            if (v instanceof Uint8Array) errors.push(`${at} holds bytes`);
            else for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k);
        }
    };
    walk(r, '');
    return errors;
}

/**
 * Two sets of records as one (see the module doc): the union by evidenceKey, the copy first written standing, nothing
 * removed. Ordered by subject, measure, then when each was observed.
 */
export function mergeEvidence(a: readonly EvidenceRecord[], b: readonly EvidenceRecord[]): EvidenceRecord[] {
    const byKey = new Map<string, EvidenceRecord>();
    for (const r of [...a, ...b]) if (!byKey.has(evidenceKey(r))) byKey.set(evidenceKey(r), r);
    return [...byKey.values()].sort((x, y) => x.subject.localeCompare(y.subject) || x.measure.localeCompare(y.measure) || x.run.atMs - y.run.atMs);
}

/**
 * The common choice of a subject's measure among its records: per source, its newest record; of those, the most
 * confident (ties to the newest). Undefined when there is none.
 */
export function pickEvidence(records: readonly EvidenceRecord[], subject: string, measure: string): EvidenceRecord | undefined {
    const newest = new Map<string, EvidenceRecord>();
    for (const r of records) {
        if (r.subject !== subject || r.measure !== measure) continue;
        const k = `${r.source.kind}\u0000${r.source.id}`, had = newest.get(k);
        if (!had || r.run.atMs > had.run.atMs) newest.set(k, r);
    }
    return [...newest.values()].sort((x, y) => y.provenance.confidence - x.provenance.confidence || y.run.atMs - x.run.atMs)[0];
}
