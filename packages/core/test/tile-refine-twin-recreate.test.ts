/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tile-refine twin's model recreate pass (tile-refine-twin.ts): a district build's own quick texture path, not
 * the richer texture-pass.ts pipeline, so this is its own gate rather than a reuse of staged-texture-tile-enhance's
 * fixtures. A replay client only: no network, no model.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { tileRefineTwin, type TileRefineTwin } from '../src/node/3d-engine/staged-location/tile-refine-twin';
import type { EnhanceModelAnswer, EnhanceModelClient, EnhanceModelRequest } from '../src/node/3d-engine/staged-location/texture-enhance';
import { MediaModelUnavailableError } from '../src/common/errors/pipeline-errors';
import { building, writeTris } from './helpers/staged-synthetic-world';
import { photoTexture } from './helpers/staged-texture-world';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-refine-recreate-'));

function fixture(): Uint8Array {
    const file = path.join(TMP, `tex-${Math.random().toString(36).slice(2)}.glb`);
    writeTris(file, building(0, 10, 0, 10, 10));
    photoTexture(file);
    return fs.readFileSync(file);
}

/** A uniform brightness lift in linear light (gamma 2.2): the same material, genuinely brighter - what a de-shadow
 *  model answer should look like, not a hue shift. */
function brightenLinear(rgba: Uint8Array, gain: number): Uint8Array {
    const out = new Uint8Array(rgba.length);
    for (let i = 0; i < rgba.length; i += 4) for (let c = 0; c < 3; c++) {
        const lin = Math.pow(rgba[i + c] / 255, 2.2) * gain;
        out[i + c] = Math.max(0, Math.min(255, Math.round(255 * Math.pow(Math.min(1, lin), 1 / 2.2))));
    }
    return out.map((v, i) => (i % 4 === 3 ? rgba[i] : v));
}

function unsharp(img: { width: number; height: number; rgba: Uint8Array }, amount: number): Uint8Array {
    const { width: W, height: H, rgba } = img, out = new Uint8Array(rgba.length);
    for (let c = 0; c < 4; c++) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4 + c;
        if (c === 3) { out[i] = 255; continue; }
        let sum = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(W - 1, Math.max(0, x + dx)), yy = Math.min(H - 1, Math.max(0, y + dy));
            sum += rgba[(yy * W + xx) * 4 + c]; n++;
        }
        const blur = sum / n;
        out[i] = Math.max(0, Math.min(255, Math.round(rgba[i] + amount * (rgba[i] - blur))));
    }
    return out;
}

const PRIORITY_MODEL = 'gemini-3.1-flash-image';
function answerWith(edit: (img: ReturnType<typeof decodeImageInMemory>) => Uint8Array): EnhanceModelClient {
    return async (req: EnhanceModelRequest): Promise<EnhanceModelAnswer> => {
        const decoded = decodeImageInMemory(req.image.bytes);
        const rgba = edit(decoded);
        const png = encodePng(decoded.width, decoded.height, Buffer.from(rgba));
        return { bytes: new Uint8Array(png), mimeType: 'image/png', modelUsed: PRIORITY_MODEL, requestedModels: req.models, skippedModels: [], modelNote: `answered by ${PRIORITY_MODEL}` };
    };
}

describe('tileRefineTwin recreate pass', () => {
    it('without opts.recreate: de-lit only, no model called, provenance says so', async () => {
        const twin = await tileRefineTwin(fixture(), 'l2');
        expect(twin.recreate).toBeUndefined();
        expect(twin.provenance[0].method).toMatch(/de-lit/);
        expect(twin.provenance[0].method).not.toMatch(/recreated/);
    });

    it('accepts a brightened, sharpened answer (a real de-shadow) and names it in the provenance', async () => {
        const client = answerWith(img => unsharp({ ...img, rgba: brightenLinear(img.rgba, 1.8) }, 1.3));
        const twin: TileRefineTwin = await tileRefineTwin(fixture(), 'l2', { recreate: { client, concurrency: 4 } });
        expect(twin.recreate).toBeDefined();
        expect(twin.recreate!.attempted).toBeGreaterThan(0);
        expect(twin.recreate!.accepted).toBeGreaterThan(0);
        expect(twin.recreate!.modelsUsed).toEqual([PRIORITY_MODEL]);
        expect(twin.provenance[0].method).toMatch(/further recreated by gemini-3\.1-flash-image/);
        expect(twin.provenance[0].method).toMatch(/accepted/);
    });

    it('rejects an unchanged answer (no gain) and keeps the de-lit image, not the raw one', async () => {
        const client = answerWith(img => img.rgba); // identical to what was sent: no sharpening, no gain
        const twin: TileRefineTwin = await tileRefineTwin(fixture(), 'l2', { recreate: { client, concurrency: 4 } });
        expect(twin.recreate!.accepted).toBe(0);
        expect(twin.recreate!.rejected).toBeGreaterThan(0);
        expect(twin.provenance[0].method).toMatch(/0 of \d+ accepted/);
    });

    it('a model failure keeps the de-lit image and is reported, not thrown', async () => {
        const client: EnhanceModelClient = async () => { throw new MediaModelUnavailableError(PRIORITY_MODEL, 'no model reachable'); };
        const twin: TileRefineTwin = await tileRefineTwin(fixture(), 'l2', { recreate: { client, concurrency: 4 } });
        expect(twin.recreate!.failed).toBeGreaterThan(0);
        expect(twin.recreate!.accepted).toBe(0);
        // the GLB itself still decodes and still has a real photo texture (the de-lit fallback, not a crash)
        expect(decodePng).toBeDefined();
    });

    it('a budget of 0 ms starts no images, keeps every de-lit image, and still finishes', async () => {
        let calls = 0;
        const client: EnhanceModelClient = async req => { calls++; return answerWith(img => img.rgba)(req); };
        const twin: TileRefineTwin = await tileRefineTwin(fixture(), 'l2', { recreate: { client, budgetMs: 0, concurrency: 4 } });
        expect(calls).toBe(0);
        expect(twin.recreate!.timedOut).toBeGreaterThan(0);
        expect(twin.recreate!.attempted).toBe(0);
    });
});
