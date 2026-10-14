/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street View Static billing safety (StreetViewSurveyPlanner.fetchFrames) with an injected fetch: the hard cap holds
 * for any requested value (NaN, Infinity, > cap), the ledger is shared across cache directories, legacy per-cache
 * ledgers are merged once, cached frames are keyed safely (a cached frame of another size is never returned), and
 * the API key never reaches a written file, a cache file name or an error message.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    fetchFrames, effectiveBillingCap, mergeLegacyLedger, readLedger, frameKey, STREETVIEW_BILLING_HARD_CAP,
    type CandidateFrame, type PanoRecord
} from '../src/node/spatial/StreetViewSurveyPlanner';
import { encodeRgbaToJpeg, resolveFfmpegPath } from '../src/node/image-codec-ffmpeg';
import { findBinary, HOW_TO, withReason, type Requirement } from './helpers/requirements';

/** encodeRgbaToJpeg spawns resolveFfmpegPath() (FFMPEG_PATH, else `ffmpeg` on PATH). */
const ffmpeg: Requirement = findBinary(resolveFfmpegPath()) !== null
    ? { ok: true, reason: '' }
    : { ok: false, reason: `\`${resolveFfmpegPath()}\` not found (set FFMPEG_PATH or ${HOW_TO.ffmpeg})` };

const KEY = 'TESTKEY_zq81mv03xx7';

/** Fake Maps endpoint: metadata JSON and a JPEG of the requested size; counts billed image requests. */
function fakeFetch(counter: { images: number; urls: string[] }, failImages = false): typeof fetch {
    return (async (input: any) => {
        const url = String(input);
        counter.urls.push(url);
        const q = new URL(url).searchParams;
        if (url.includes('/streetview/metadata')) {
            return new Response(JSON.stringify({ status: 'OK', pano_id: q.get('pano'), date: '2026-04', location: { lat: 1, lng: 2 }, copyright: '© Google' }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        counter.images++;
        if (failImages) throw new Error(`network down while fetching ${url}`);
        const [w, h] = (q.get('size') ?? '8x8').split('x').map(Number);
        const jpg = await encodeRgbaToJpeg(Buffer.alloc(w * h * 4, 128), w, h);
        return new Response(new Uint8Array(jpg), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }) as unknown as typeof fetch;
}

const pano: PanoRecord = { panoId: 'PANO_A', lat: 40.7, lng: -73.9, x: 0, z: 0, streetY: 0, eye: [0, 2.5, 0], distanceToHeroMeters: 10 };
const panos = new Map([[pano.panoId, pano]]);
const frame = (h: number, size = 16): CandidateFrame => ({ panoId: pano.panoId, headingDeg: h, pitchDeg: 10, fovDeg: 60, width: size, height: size });

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-billing-')); });

function allFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...allFiles(p)); else out.push(p);
    }
    return out;
}

describe('Street View billing cap and ledger', () => {
    it('effectiveBillingCap never exceeds the hard cap and treats non-finite values as the hard cap', () => {
        expect(STREETVIEW_BILLING_HARD_CAP).toBe(80);
        expect(effectiveBillingCap(undefined)).toBe(80);
        expect(effectiveBillingCap(NaN)).toBe(80);
        expect(effectiveBillingCap(Infinity)).toBe(80);
        expect(effectiveBillingCap(500)).toBe(80);
        expect(effectiveBillingCap(2.7)).toBe(2);
        expect(effectiveBillingCap(-3)).toBe(0);
    });

    it('makes no billed request once the ledger is at the cap, whatever cap is requested (NaN included)', async () => {
        const ledgerPath = path.join(root, 'ledger.json');
        fs.writeFileSync(ledgerPath, JSON.stringify({ billedImageRequests: 80, keys: [] }));
        for (const cap of [undefined, 80, 500, NaN, Infinity]) {
            const counter = { images: 0, urls: [] as string[] };
            const res = await fetchFrames([frame(cap === undefined ? 1 : 2), frame(3)], panos, { apiKey: KEY, cacheDir: path.join(root, 'cache'), ledgerPath, maxBilledRequests: cap, fetchImpl: fakeFetch(counter) });
            expect(counter.images).toBe(0);
            expect(res.billed).toBe(0);
            expect(res.skippedForCap).toBe(2);
        }
        expect(readLedger(ledgerPath).billedImageRequests).toBe(80);
    });

    it.skipIf(!ffmpeg.ok)(withReason('counts billed requests in one ledger shared by every cache directory', ffmpeg), async () => {
        const ledgerPath = path.join(root, 'shared', 'ledger.json');
        const c1 = { images: 0, urls: [] as string[] };
        const r1 = await fetchFrames([frame(10), frame(20), frame(30)], panos, { apiKey: KEY, cacheDir: path.join(root, 'outA'), ledgerPath, maxBilledRequests: 2, fetchImpl: fakeFetch(c1) });
        expect(r1.billed).toBe(2);
        expect(r1.skippedForCap).toBe(1);
        expect(c1.images).toBe(2);
        // another --out directory: the cap is already used up
        const c2 = { images: 0, urls: [] as string[] };
        const r2 = await fetchFrames([frame(40), frame(50)], panos, { apiKey: KEY, cacheDir: path.join(root, 'outB'), ledgerPath, maxBilledRequests: 2, fetchImpl: fakeFetch(c2) });
        expect(c2.images).toBe(0);
        expect(r2.skippedForCap).toBe(2);
        // cached frames cost nothing and are returned
        const c3 = { images: 0, urls: [] as string[] };
        const r3 = await fetchFrames([frame(10), frame(20)], panos, { apiKey: KEY, cacheDir: path.join(root, 'outA'), ledgerPath, maxBilledRequests: 2, fetchImpl: fakeFetch(c3) });
        expect(c3.images).toBe(0);
        expect(r3.frames.filter(f => f.fromCache).length).toBe(2);
        expect(readLedger(ledgerPath)).toEqual({ billedImageRequests: 2, keys: [frameKey(frame(10)), frameKey(frame(20))] });
    });

    it('counts a request that failed after it was sent, and redacts the API key from the error', async () => {
        const ledgerPath = path.join(root, 'ledger.json');
        const counter = { images: 0, urls: [] as string[] };
        let message = '';
        try {
            await fetchFrames([frame(5)], panos, { apiKey: KEY, cacheDir: path.join(root, 'out'), ledgerPath, fetchImpl: fakeFetch(counter, true) });
        } catch (e: any) { message = String(e?.message ?? e); }
        expect(message).toMatch(/fetch failed/);
        expect(message).toContain('<redacted>');
        expect(message).not.toContain(KEY);
        expect(counter.urls.some(u => u.includes(KEY))).toBe(true); // the key is only ever in the request itself
        expect(readLedger(ledgerPath).billedImageRequests).toBe(1);
    });

    it('merges a legacy per-cache ledger exactly once', () => {
        const ledgerPath = path.join(root, 'ledger.json');
        const cacheDir = path.join(root, 'legacy');
        fs.mkdirSync(cacheDir);
        fs.writeFileSync(path.join(cacheDir, 'fetch_ledger.json'), JSON.stringify({ billedImageRequests: 4, keys: ['a', 'b', 'c'] }));
        fs.writeFileSync(ledgerPath, JSON.stringify({ billedImageRequests: 2, keys: ['a', 'z'] }));
        const merged = mergeLegacyLedger(ledgerPath, cacheDir);
        // b and c are new (+2), one legacy request had no key (+1); a was already counted
        expect(merged.billedImageRequests).toBe(5);
        expect(merged.keys.sort()).toEqual(['a', 'b', 'c', 'z']);
        expect(mergeLegacyLedger(ledgerPath, cacheDir).billedImageRequests).toBe(5); // idempotent
        expect(readLedger(ledgerPath).billedImageRequests).toBe(5);
    });

    it.skipIf(!ffmpeg.ok)(withReason('never returns a cached frame of another size (the cache key has no size)', ffmpeg), async () => {
        const ledgerPath = path.join(root, 'ledger.json');
        const cacheDir = path.join(root, 'out');
        const counter = { images: 0, urls: [] as string[] };
        await fetchFrames([frame(7, 16)], panos, { apiKey: KEY, cacheDir, ledgerPath, fetchImpl: fakeFetch(counter) });
        await expect(fetchFrames([frame(7, 32)], panos, { apiKey: KEY, cacheDir, ledgerPath, fetchImpl: fakeFetch(counter) })).rejects.toThrow(/16x16, requested 32x32/);
        expect(counter.images).toBe(1);
    });

    it.skipIf(!ffmpeg.ok)(withReason('writes no file and no file name containing the API key', ffmpeg), async () => {
        const ledgerPath = path.join(root, 'ledger.json');
        const counter = { images: 0, urls: [] as string[] };
        await fetchFrames([frame(1), frame(2)], panos, { apiKey: KEY, cacheDir: path.join(root, 'out'), ledgerPath, fetchImpl: fakeFetch(counter) });
        expect(counter.images).toBe(2);
        for (const f of allFiles(root)) {
            expect(f.includes(KEY)).toBe(false);
            expect(fs.readFileSync(f).includes(Buffer.from(KEY))).toBe(false);
        }
    });
});
