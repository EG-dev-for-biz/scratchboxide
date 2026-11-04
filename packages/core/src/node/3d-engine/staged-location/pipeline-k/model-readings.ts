/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The vision model's answers kept between builds, so a rebuild or a later run asks only about what changed: the facade
 * reader's readings (facade-reader.ts, keyed by the plane's pixels, its masks, the prompt version and the model) and the
 * material choices (material-choice.ts, keyed by the candidates a class was shown). Each record's key is its name in the
 * store, `<kind>/<sha256>` (`facade-reading/…`, `material-choice/…`): the place store (place-store.ts) holds the
 * records a place's runs used or wrote under the same names, and a district run reads them from there first.
 * Here they are files beside the stage caches (MODEL_READINGS_DIR under the staged-location cache); they go to the cache
 * mirror's bucket with the caches (cache-mirror.ts), and a record this workspace lacks is read back from there before the
 * model is asked (fileReadingStore's `restore`), so a Cloud Run chunk, which starts on an empty disk, asks only about what
 * changed. Keys are the same everywhere.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** The store's directory under the staged-location cache (StageCache.dir). */
export const MODEL_READINGS_DIR = 'model_readings';

/** Records by key. A record that cannot be read is absent; one that cannot be written is asked for again next time. */
export interface ModelReadingStore {
    /** A record kept here comes back at once; one read back from elsewhere first (fileReadingStore's `restore`), through a promise. */
    get<T>(key: string): T | undefined | Promise<T | undefined>;
    put(key: string, value: unknown): void;
}

/** What a run's store did (the `model_readings` run note). */
export interface ModelReadingReport {
    /** Asks answered by a record here, by one read back from elsewhere, and by none; records written. */
    kept: number; restored: number; missed: number; written: number;
    /** Restores that failed (counted as misses), with the first reason. */
    restoreFailed: number; restoreError?: string;
    /** Time spent waiting on `restore`, summed over the records (ms). */
    restoreMs: number;
    /** The keys of the records that answered an ask, and of those written (the place store keeps them, place-store.ts). */
    used: string[]; writtenKeys: string[];
}

const KEY = /^[a-z][a-z0-9-]*\/[0-9a-f]{64}$/;

/** A record's file under the store's directory, '/'-separated: `<kind>/<first two hex>/<sha256>.json`. */
export function readingFileOf(key: string): string {
    if (!KEY.test(key)) throw new Error(`not a reading key: ${key}`);
    const [kind, hex] = key.split('/');
    return `${kind}/${hex.slice(0, 2)}/${hex}.json`;
}

/** A record's key: its kind and the sha256 of what it answers. */
export function readingKey(kind: string, parts: unknown[]): string {
    const h = crypto.createHash('sha256').update(`${kind}\0`);
    for (const p of parts) h.update(typeof p === 'string' ? p : Buffer.isBuffer(p) || p instanceof Uint8Array ? p : JSON.stringify(p) ?? 'undefined').update('\0');
    return `${kind}/${h.digest('hex')}`;
}

/**
 * The store as files: `<dir>/<kind>/<first two hex>/<sha256>.json`, each written whole (a temp file renamed). With
 * `restore`, a record not here is first read back to its file from elsewhere (`rel`, the file's path under `dir`: the cache
 * mirror's bucket, stage-cache.ts restoreFile), once a key: a key asked again while it is read waits for the same read, and
 * one found nowhere is not looked for again until it is written. A restore that fails is a miss.
 */
export function fileReadingStore(dir: string, opts: { restore?: (rel: string) => Promise<boolean> } = {}): ModelReadingStore & { report: () => ModelReadingReport } {
    const relOf = readingFileOf;
    const fileOf = (key: string) => path.join(dir, ...relOf(key).split('/'));
    const read = <T>(key: string): T | undefined => {
        try { return JSON.parse(fs.readFileSync(fileOf(key), 'utf8')) as T; } catch { return undefined; }
    };
    const report: Omit<ModelReadingReport, 'used' | 'writtenKeys'> = { kept: 0, restored: 0, missed: 0, written: 0, restoreFailed: 0, restoreMs: 0 };
    const reading = new Map<string, Promise<unknown>>(), nowhere = new Set<string>(), used = new Set<string>(), written = new Set<string>();
    const restore = opts.restore;
    return {
        get: <T>(key: string): T | undefined | Promise<T | undefined> => {
            const here = read<T>(key);
            if (here !== undefined) { report.kept++; used.add(key); return here; }
            if (!restore || nowhere.has(key)) { report.missed++; return undefined; }
            let pending = reading.get(key) as Promise<T | undefined> | undefined;
            if (!pending) {
                const t0 = Date.now();
                pending = restore(relOf(key)).catch(err => {
                    report.restoreFailed++;
                    report.restoreError ??= err instanceof Error ? err.message : String(err);
                    return false;
                }).then(ok => {
                    report.restoreMs += Date.now() - t0;
                    const got = ok ? read<T>(key) : undefined;
                    if (got === undefined) nowhere.add(key);
                    return got;
                }).finally(() => reading.delete(key));
                reading.set(key, pending);
            }
            return pending.then(got => { if (got === undefined) report.missed++; else { report.restored++; used.add(key); } return got; });
        },
        put: (key, value) => {
            try {
                const file = fileOf(key), tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(tmp, JSON.stringify(value));
                fs.renameSync(tmp, file);
                nowhere.delete(key);
                report.written++;
                written.add(key);
            } catch { /* not kept: asked again next time */ }
        },
        report: () => ({ ...report, used: [...used], writtenKeys: [...written] })
    };
}

/** The store in memory (a run that keeps nothing, tests). */
export function memoryReadingStore(): ModelReadingStore & { size: () => number } {
    const m = new Map<string, string>();
    return { get: <T>(key: string) => { const v = m.get(key); return v === undefined ? undefined : JSON.parse(v) as T; }, put: (key, value) => { m.set(key, JSON.stringify(value)); }, size: () => m.size };
}

/**
 * The sha256 of a plane as the reader sees it: its size, its pixels and the mask of texels it may not read (uncovered or
 * occluded, one byte a texel, set or not); a mask with nothing set is no mask.
 */
export function planePixelsKey(img: { rgba: ArrayLike<number>; width: number; height: number }, unread?: ArrayLike<number>): string {
    const h = crypto.createHash('sha256').update(`plane\0${img.width}x${img.height}\0`);
    h.update(img.rgba instanceof Uint8Array ? img.rgba : Uint8Array.from(img.rgba));
    h.update('\0mask\0');
    const m = unread ? Uint8Array.from(unread, v => (v ? 1 : 0)) : undefined;
    if (m && m.some(v => v)) h.update(m);
    return h.digest('hex');
}
