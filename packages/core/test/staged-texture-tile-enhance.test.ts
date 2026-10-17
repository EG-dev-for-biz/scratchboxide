/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Task D, 'tile-photo-enhanced': model enhancement of the tile transfer, gated against the transferred original.
 * The model client is a replay: each chart label maps to a recorded answer computed in code from the request's own
 * crop; any other call throws, so a missing recording fails the test and no real (billed) model is ever reached.
 */

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import { unpackConfidenceTexel, type UvAtlas } from '../src/common/spatial/texture-pass-contracts';
import { describeModelUsed, IMAGE_MODEL_ASPECT_RATIOS, IMAGE_MODEL_PRIORITY, nearestImageAspectRatio } from '../src/common/media-generation-protocol';
import { MediaModelUnavailableError } from '../src/common/errors/pipeline-errors';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { decodeImageInMemory, transferTilePhotoFromGlb, type RgbaImage8 } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import {
    enhancementGate, enhanceTransferredAtlas, resizeRgba, type EnhanceModelAnswer, type EnhanceModelClient, type EnhanceModelRequest
} from '../src/node/3d-engine/staged-location/texture-enhance';
import { facadeAlbedo, facadeAtlas, facadeViews } from './helpers/texture-pass-fixtures';
import { buildTileGlb, facadeTileSheet } from './helpers/tile-photo-glb';
import { planePanel, saveStrip } from './helpers/texture-tile-shots';

const SIDE = 128;

/** Facade photo with structure: the analytic albedo with dark openings on a 2.5 m x 2 m bay grid. */
const withOpenings = (u: number, v: number): Vec3 => {
    const c = facadeAlbedo(u, v);
    const bu = ((u - 0.6) % 2.5 + 2.5) % 2.5, bv = ((v - 0.5) % 2 + 2) % 2;
    return bu < 1.2 && bv < 1.3 ? [c[0] * 0.25, c[1] * 0.25, c[2] * 0.25] : c;
};

/** The facade atlas split into two charts: left half (map 0) and right half (map 1). */
function twoChartAtlas(): UvAtlas {
    const a = facadeAtlas(SIDE);
    a.maps = [
        { ...a.maps[0], nodeName: 'facade_left', chartId: 's00', atlasRect: [0, 0, 0.5, 1] },
        { ...a.maps[0], nodeName: 'facade_right', chartId: 's01', atlasRect: [0.5, 0, 1, 1] }
    ];
    for (let i = 0; i < SIDE * SIDE; i++) a.texels.mapIndex[i] = (i % SIDE) < SIDE / 2 ? 0 : 1;
    return a;
}

async function transferred(atlas: UvAtlas) {
    return (await transferTilePhotoFromGlb(buildTileGlb([facadeTileSheet(0.05, withOpenings)]), { atlas, maxDistanceM: 0.25 })).planes;
}

// ---- image edits the replay answers with (computed from the request's crop) ----------------------------------

function unsharp(img: RgbaImage8, amount: number, sigma = 1): RgbaImage8 {
    const { width: W, height: H } = img, out = new Uint8Array(img.rgba.length);
    const r = Math.ceil(3 * sigma), k: number[] = [];
    for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
    const ks = k.reduce((s, x) => s + x, 0);
    for (let c = 0; c < 4; c++) {
        const src = new Float32Array(W * H), tmp = new Float32Array(W * H), bl = new Float32Array(W * H);
        for (let i = 0; i < W * H; i++) src[i] = img.rgba[i * 4 + c];
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let d = -r; d <= r; d++) s += k[d + r] * src[y * W + Math.min(W - 1, Math.max(0, x + d))]; tmp[y * W + x] = s / ks; }
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let d = -r; d <= r; d++) s += k[d + r] * tmp[Math.min(H - 1, Math.max(0, y + d)) * W + x]; bl[y * W + x] = s / ks; }
        for (let i = 0; i < W * H; i++) out[i * 4 + c] = c === 3 ? 255 : Math.max(0, Math.min(255, Math.round(src[i] + amount * (src[i] - bl[i]))));
    }
    return { width: W, height: H, rgba: out };
}
function shift(img: RgbaImage8, dx: number, dy: number): RgbaImage8 {
    const { width: W, height: H } = img, out = new Uint8Array(img.rgba.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const sx = Math.min(W - 1, Math.max(0, x - dx)), sy = Math.min(H - 1, Math.max(0, y - dy));
        out.set(img.rgba.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (y * W + x) * 4);
    }
    return { width: W, height: H, rgba: out };
}
function addStructure(img: RgbaImage8): RgbaImage8 {
    const out = Uint8Array.from(img.rgba), W = img.width;
    // A hallucinated feature: dark diagonal bars across the crop where the original is plain wall.
    for (let y = 0; y < img.height; y++) for (let x = 0; x < W; x++) if (((x + y) % 24) < 3) out.set([20, 20, 20, 255], (y * W + x) * 4);
    return { width: W, height: img.height, rgba: out };
}
function tint(img: RgbaImage8, k: Vec3): RgbaImage8 {
    const out = Uint8Array.from(img.rgba);
    for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.round(out[i + c] * k[c]));
    return { width: img.width, height: img.height, rgba: out };
}
const toPng = (img: RgbaImage8) => new Uint8Array(encodePng(img.width, img.height, Buffer.from(img.rgba)));

type Recording = (req: EnhanceModelRequest) => EnhanceModelAnswer | Error;

/** Replay client: answers only labels it has a recording for; any other call throws (it would have been billed). */
function replayClient(recordings: Record<string, Recording>, calls: EnhanceModelRequest[] = []): EnhanceModelClient {
    return async req => {
        calls.push(req);
        const rec = recordings[req.label];
        if (!rec) throw new Error(`unrecorded model call for ${req.label}: refusing to reach a real model`);
        const out = rec(req);
        if (out instanceof Error) throw out;
        return out;
    };
}
const answerWith = (edit: (img: RgbaImage8) => RgbaImage8, model = IMAGE_MODEL_PRIORITY[0], skipped: EnhanceModelAnswer['skippedModels'] = []): Recording => req => ({
    bytes: toPng(edit(decodeImageInMemory(req.image.bytes))), mimeType: 'image/png', modelUsed: model,
    requestedModels: req.models, skippedModels: skipped, modelNote: describeModelUsed(model, skipped)
});

const views = () => facadeViews();

describe('tile photo enhancement (tile-photo-enhanced)', () => {
    it('gate: accepts a faithful sharpen, rejects shifted, hallucinated, recoloured and unchanged crops with the real reason', async () => {
        const atlas = facadeAtlas(SIDE);
        const planes = await transferred(atlas);
        const original: RgbaImage8 = { width: SIDE, height: SIDE, rgba: planes.albedo };
        const mask = new Uint8Array(SIDE * SIDE).fill(1);
        const sharp = enhancementGate(original, unsharp(original, 1.2), mask);
        expect(sharp.pass, JSON.stringify(sharp)).toBe(true);
        expect(sharp.metrics.edgeNcc!).toBeGreaterThanOrEqual(0.97);
        expect(sharp.metrics.sharpnessGain).toBeGreaterThan(1.05);
        const moved = enhancementGate(original, unsharp(shift(original, 5, 3), 1.2), mask);
        expect(moved.pass).toBe(false);
        expect(['enhance_edges_moved', 'enhance_new_structure']).toContain(moved.reasonCode);
        const invented = enhancementGate(original, unsharp(addStructure(original), 0.5), mask);
        expect(invented.pass).toBe(false);
        expect(['enhance_edges_moved', 'enhance_new_structure']).toContain(invented.reasonCode);
        const regraded = enhancementGate(original, unsharp(tint(original, [1.25, 0.95, 0.7]), 1.2), mask);
        expect(regraded).toMatchObject({ pass: false, reasonCode: 'enhance_colour_drift' });
        const same = enhancementGate(original, original, mask);
        expect(same).toMatchObject({ pass: false, reasonCode: 'enhance_no_gain' });
        saveStrip('enhance_gate_cases', [
            planePanel(SIDE, SIDE, original.rgba), planePanel(SIDE, SIDE, unsharp(original, 1.2).rgba), planePanel(SIDE, SIDE, unsharp(shift(original, 5, 3), 1.2).rgba),
            planePanel(SIDE, SIDE, unsharp(addStructure(original), 0.5).rgba), planePanel(SIDE, SIDE, unsharp(tint(original, [1.25, 0.95, 0.7]), 1.2).rgba)
        ], 3);
    });

    it('enhances per chart, grounded by real views: a faithful chart is accepted and labelled, a shifted one is rejected and recorded', async () => {
        const atlas = twoChartAtlas();
        const transfer = await transferred(atlas);
        const calls: EnhanceModelRequest[] = [];
        const client = replayClient({
            'facade_left/s00': answerWith(img => unsharp(img, 1.2)),
            'facade_right/s01': answerWith(img => unsharp(shift(img, 6, 0), 1.2))
        }, calls);
        const res = await enhanceTransferredAtlas({ atlas, transfer, views: views(), client });
        expect(calls.map(c => c.label)).toEqual(['facade_left/s00', 'facade_right/s01']);
        for (const c of calls) {
            expect(c.references.length).toBeGreaterThanOrEqual(2);
            expect(c.references.length).toBeLessThanOrEqual(3);
            // the crop (SIDE / 2 x SIDE) is sent padded to the model's nearest supported aspect ratio
            const sentPng = decodePng(Buffer.from(c.image.bytes));
            expect(sentPng.height).toBe(SIDE);
            expect(sentPng.width).toBeGreaterThanOrEqual(SIDE / 2);
            expect(nearestImageAspectRatio(sentPng.width, sentPng.height)).toBe(nearestImageAspectRatio(SIDE / 2, SIDE));
            expect(c.prompt).toMatch(/Keep every feature exactly where it is/);
            expect(c.models).toEqual(IMAGE_MODEL_PRIORITY);
        }
        expect(res.charts.map(c => c.decision)).toEqual(['accepted', 'rejected']);
        expect(res.charts[1].reasonCode).toMatch(/enhance_(edges_moved|new_structure)/);
        expect(res.modelsUsed).toEqual([IMAGE_MODEL_PRIORITY[0]]);
        const prov = res.planes.provenance;
        expect(prov.map(p => p.source)).toEqual(['tile-photo-transfer', 'tile-photo-enhanced']);
        expect(prov[1].label).toBe('photo-inferred');
        expect(prov[1].method).toContain(IMAGE_MODEL_PRIORITY[0]);
        expect(prov[0].coverage + prov[1].coverage).toBeCloseTo(1, 6);
        expect(prov[1].coverage).toBeCloseTo(0.5, 6);
        const deg = res.planes.degradations.find(d => d.stage === 'enhance')!;
        expect(deg).toMatchObject({ layerKey: 'fit', fromRung: 2, toRung: 2 });
        expect(deg.texelShare).toBeCloseTo(0.5, 6);
        expect(deg.reason).toMatch(/enhanced facade_right\/s01 but .*; the transferred texture is kept/);
        let changedLeft = 0;
        for (let i = 0; i < SIDE * SIDE; i++) {
            const left = (i % SIDE) < SIDE / 2, c = unpackConfidenceTexel(res.planes.confidence, i);
            expect(c.provenanceIndex).toBe(left ? 1 : 0);
            expect(c.rung).toBe(2);
            if (left && res.planes.albedo[i * 4] !== transfer.albedo[i * 4]) changedLeft++;
            if (!left) expect(Array.from(res.planes.albedo.subarray(i * 4, i * 4 + 4))).toEqual(Array.from(transfer.albedo.subarray(i * 4, i * 4 + 4)));
        }
        expect(changedLeft).toBeGreaterThan(1000);
        saveStrip('enhance_per_chart_accept_reject', [planePanel(SIDE, SIDE, transfer.albedo), planePanel(SIDE, SIDE, res.planes.albedo)], 3);
    });

    it('pads each crop to the model\'s aspect ratio, so an answer at that ratio lines up with the crop', async () => {
        const atlas = twoChartAtlas();
        const transfer = await transferred(atlas);
        // like the real model: it answers at its own supported aspect ratio nearest the request, recomposed (the picture
        // keeps its proportions and is cropped to that ratio, centred), 1024 px on the long side
        const atModelAspect: Recording = req => {
            const img = decodeImageInMemory(req.image.bytes);
            const name = nearestImageAspectRatio(img.width, img.height), r = IMAGE_MODEL_ASPECT_RATIOS.find(a => a[0] === name)![1];
            const cw = Math.min(img.width, Math.round(img.height * r)), ch = Math.min(img.height, Math.round(img.width / r));
            const cx = Math.floor((img.width - cw) / 2), cy = Math.floor((img.height - ch) / 2);
            const cut = new Uint8Array(cw * ch * 4);
            for (let y = 0; y < ch; y++) cut.set(img.rgba.subarray(((cy + y) * img.width + cx) * 4, ((cy + y) * img.width + cx + cw) * 4), y * cw * 4);
            const out = resizeRgba(unsharp({ width: cw, height: ch, rgba: cut }, 1.2), r >= 1 ? 1024 : Math.round(1024 * r), r >= 1 ? Math.round(1024 / r) : 1024);
            return { bytes: toPng(out), mimeType: 'image/png', modelUsed: IMAGE_MODEL_PRIORITY[0], requestedModels: req.models, skippedModels: [], modelNote: describeModelUsed(IMAGE_MODEL_PRIORITY[0], []) };
        };
        const res = await enhanceTransferredAtlas({ atlas, transfer, views: views(), client: replayClient({ 'facade_left/s00': atModelAspect, 'facade_right/s01': atModelAspect }) });
        expect(res.charts.map(c => c.decision), JSON.stringify(res.charts.map(c => c.metrics))).toEqual(['accepted', 'accepted']);
        for (const c of res.charts) expect(c.metrics!.edgeNcc!).toBeGreaterThan(0.97);
    });

    it('does not send a chart whose texels are scattered fragments the gate cannot judge, and says so', async () => {
        const atlas = twoChartAtlas();
        const transfer = await transferred(atlas);
        // the right chart keeps only scattered single texels (every 7th row and column)
        for (let i = 0; i < SIDE * SIDE; i++) {
            const x = i % SIDE, y = Math.floor(i / SIDE);
            if (x >= SIDE / 2 && (x % 7 || y % 7)) transfer.albedo[i * 4 + 3] = 0;
        }
        const calls: EnhanceModelRequest[] = [];
        const res = await enhanceTransferredAtlas({ atlas, transfer, views: views(), client: replayClient({ 'facade_left/s00': answerWith(img => unsharp(img, 1.2)) }, calls) });
        expect(calls.map(c => c.label)).toEqual(['facade_left/s00']);
        const right = res.charts.find(c => c.label === 'facade_right/s01')!;
        expect(right).toMatchObject({ decision: 'skipped', reasonCode: 'enhance_not_gateable' });
        expect(right.reason).toMatch(/inside its border for the edge gate|fill only/);
    });

    it('keeps the charts already accepted when the time budget runs out, and records the timeout once', async () => {
        const atlas = twoChartAtlas();
        const transfer = await transferred(atlas);
        const budget = new AbortController();
        const fast = replayClient({ 'facade_left/s00': answerWith(img => unsharp(img, 1.2)) });
        // the right chart's model never answers (and ignores the abort): only the budget can end the wait
        const client: EnhanceModelClient = req => req.label === 'facade_left/s00'
            ? fast(req).then(a => { setTimeout(() => budget.abort(new Error('budget')), 5); return a; })
            : new Promise<EnhanceModelAnswer>(() => undefined);
        const res = await enhanceTransferredAtlas({ atlas, transfer, views: views(), client, concurrency: 2, budgetSignal: budget.signal });
        expect(res.charts.map(c => c.decision)).toEqual(['accepted', 'timeout']);
        expect(res.planes.provenance.map(p => p.source)).toEqual(['tile-photo-transfer', 'tile-photo-enhanced']);
        expect(res.planes.provenance[1].coverage).toBeCloseTo(0.5, 6);
        const timeouts = res.planes.degradations.filter(d => d.reasonCode === 'enhance_timeout');
        expect(timeouts).toHaveLength(1);
        expect(timeouts[0].reason).toMatch(/1 of 2 charts unfinished.*1 chart already accepted are kept/);
        expect(timeouts[0].texelShare).toBeCloseTo(0.5, 6);
        // a budget already spent sends nothing and changes nothing
        const calls: EnhanceModelRequest[] = [];
        const none = await enhanceTransferredAtlas({ atlas, transfer, views: views(), client: replayClient({}, calls), budgetSignal: AbortSignal.abort() });
        expect(calls).toHaveLength(0);
        expect(none.charts.every(c => c.decision === 'timeout')).toBe(true);
        expect(Buffer.from(none.planes.albedo).equals(Buffer.from(transfer.albedo))).toBe(true);
    });

    it('records a model failure as a degradation with the real reason and keeps the transfer byte-identical', async () => {
        const atlas = facadeAtlas(SIDE);
        const transfer = await transferred(atlas);
        const client = replayClient({ 'facade/s00': () => new MediaModelUnavailableError(IMAGE_MODEL_PRIORITY[0], 'resource_exhausted: quota exceeded for image generation') });
        const res = await enhanceTransferredAtlas({ atlas, transfer, views: views(), client });
        expect(res.charts[0]).toMatchObject({ decision: 'model_failed', reasonCode: 'enhance_model_failed' });
        expect(Buffer.from(res.planes.albedo).equals(Buffer.from(transfer.albedo))).toBe(true);
        expect(Buffer.from(res.planes.confidence.data).equals(Buffer.from(transfer.confidence.data))).toBe(true);
        expect(res.planes.provenance).toEqual(transfer.provenance);
        expect(res.planes.degradations).toHaveLength(1);
        expect(res.planes.degradations[0]).toMatchObject({ stage: 'enhance', reasonCode: 'enhance_model_failed', fromRung: 2, toRung: 2, texelShare: 1 });
        expect(res.planes.degradations[0].reason).toMatch(/quota exceeded for image generation/);
    });

    it('lets an error that is not a model failure (an unrecorded call) propagate instead of hiding it', async () => {
        const atlas = facadeAtlas(SIDE);
        const transfer = await transferred(atlas);
        await expect(enhanceTransferredAtlas({ atlas, transfer, views: views(), client: replayClient({}) })).rejects.toThrow(/unrecorded model call for facade\/s00/);
    });

    it('makes a model fallback visible: the provenance names the model that answered and why the first was skipped', async () => {
        const atlas = facadeAtlas(SIDE);
        const transfer = await transferred(atlas);
        const skipped = [{ model: IMAGE_MODEL_PRIORITY[0], code: 'unsupported' as const, reason: 'not served: 404 model not found' }];
        const client = replayClient({ 'facade/s00': answerWith(img => unsharp(img, 1.2), IMAGE_MODEL_PRIORITY[1], skipped) });
        const res = await enhanceTransferredAtlas({ atlas, transfer, views: views(), client });
        expect(res.charts[0]).toMatchObject({ decision: 'accepted', modelUsed: IMAGE_MODEL_PRIORITY[1] });
        expect(res.planes.provenance[1].method).toContain(`not the requested ${IMAGE_MODEL_PRIORITY[0]}`);
        expect(res.planes.provenance[1].method).toContain('404 model not found');
    });

    it('does not call the model for a chart no real view sees, and says so', async () => {
        const atlas = facadeAtlas(SIDE);
        const transfer = await transferred(atlas);
        const behind = views().map(v => ({ ...v, camera: { ...v.camera, eye: [v.camera.eye[0], v.camera.eye[1], 14] as Vec3, fwd: [0, 0, 1] as Vec3 } }));
        const calls: EnhanceModelRequest[] = [];
        const res = await enhanceTransferredAtlas({ atlas, transfer, views: behind, client: replayClient({}, calls) });
        expect(calls).toHaveLength(0);
        expect(res.charts[0]).toMatchObject({ decision: 'skipped', reasonCode: 'enhance_no_reference' });
        expect(res.planes.degradations[0].reason).toMatch(/no registered Street View view sees facade\/s00/);
    });

    it('is deterministic for a deterministic client', async () => {
        const atlas = twoChartAtlas();
        const transfer = await transferred(atlas);
        const rec = { 'facade_left/s00': answerWith(img => unsharp(img, 1.2)), 'facade_right/s01': answerWith(img => unsharp(img, 1.0)) };
        const hash = (r: Awaited<ReturnType<typeof enhanceTransferredAtlas>>) => createHash('sha256').update(r.planes.albedo).update(r.planes.confidence.data)
            .update(JSON.stringify([r.planes.provenance, r.planes.degradations, r.charts])).digest('hex');
        const a = await enhanceTransferredAtlas({ atlas, transfer, views: views(), client: replayClient(rec), concurrency: 2 });
        const b = await enhanceTransferredAtlas({ atlas, transfer, views: views(), client: replayClient(rec), concurrency: 1 });
        expect(hash(a)).toBe(hash(b));
    });
});
