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
 * store, `<kind>/<sha256>` (`facade-reading/…`, `material-choice/…`): the place store
 * (docs/research/2026-11-03-district-run-over-run-plan.md, section 4) can hold the same records under the same names.
 * Here they are files beside the stage caches (MODEL_READINGS_DIR under the staged-location cache).
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** The store's directory under the staged-location cache (StageCache.dir). */
export const MODEL_READINGS_DIR = 'model_readings';

/** Records by key. A record that cannot be read is absent; one that cannot be written is asked for again next time. */
export interface ModelReadingStore {
    get<T>(key: string): T | undefined;
    put(key: string, value: unknown): void;
}

const KEY = /^[a-z][a-z0-9-]*\/[0-9a-f]{64}$/;

/** A record's key: its kind and the sha256 of what it answers. */
export function readingKey(kind: string, parts: unknown[]): string {
    const h = crypto.createHash('sha256').update(`${kind}\0`);
    for (const p of parts) h.update(typeof p === 'string' ? p : Buffer.isBuffer(p) || p instanceof Uint8Array ? p : JSON.stringify(p) ?? 'undefined').update('\0');
    return `${kind}/${h.digest('hex')}`;
}

/** The store as files: `<dir>/<kind>/<first two hex>/<sha256>.json`, each written whole (a temp file renamed). */
export function fileReadingStore(dir: string): ModelReadingStore {
    const fileOf = (key: string) => {
        if (!KEY.test(key)) throw new Error(`not a reading key: ${key}`);
        const [kind, hex] = key.split('/');
        return path.join(dir, kind, hex.slice(0, 2), `${hex}.json`);
    };
    return {
        get: <T>(key: string) => {
            try { return JSON.parse(fs.readFileSync(fileOf(key), 'utf8')) as T; } catch { return undefined; }
        },
        put: (key, value) => {
            try {
                const file = fileOf(key), tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(tmp, JSON.stringify(value));
                fs.renameSync(tmp, file);
            } catch { /* not kept: asked again next time */ }
        }
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
