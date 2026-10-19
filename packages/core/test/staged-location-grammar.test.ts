/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The facade grammar stage in the staged build (SCRATCHBOX_FACADE_GRAMMAR=1), with stand-ins for the native stages, the
 * vision model (the simulated reader of helpers/facade-grammar-reader.ts) and the vector footprints. Two facades come out
 * of the remesh's orthophoto export: one the reader reads truly, one it reads half a storey off. The true grammar is
 * accepted, passed to tile_refine as the facade's lattice and committed as a layer over the remesh, labelled
 * photo-inferred with its confidence, with the footprints agreeing; the wrong one is dropped with a grammar_rejected
 * degradation saying why, and only the accepted facade is in the grammar file. No network, no billed call.
 */

import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runStagedLocation, type StagedLocationDeps } from '../src/node/3d-engine/staged-location/orchestrator';
import { StageCache } from '../src/node/3d-engine/staged-location/stage-cache';
import { validateContract, type StageEvent } from '../src/common/spatial/staged-location-contracts';
import type { VisionGenAIClient } from '../src/node/gemini/vision-model-chain';
import type { TileRefineRequest } from '../src/node/3d-engine/tile-refine-service';
import { fakeNative, type WorldSpec } from './helpers/staged-synthetic-world';
import { encodePng } from './helpers/synthetic-scan-glb';
import { promptImage, simulatedReply, type TrueOpening } from './helpers/facade-grammar-reader';
import type { ReliefOrthoFacade } from '../src/node/3d-engine/staged-location/facade-grammar';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-staged-grammar-')));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const PARK: WorldSpec = { ground: 80, buildings: [[30, 44, 30, 40, 9]], trees: [] };

/** A 40 x 30 m facade at 10 cm: five storeys of six windows (1.4 x 2.2 m) on a wall, grain, two dark blotches. */
function facadeOf(id: number, centroid: [number, number, number]): { meta: ReliefOrthoFacade; png: Buffer; truth: TrueOpening[] } {
    const W = 400, H = 300, px = 0.1;
    const truth: TrueOpening[] = [];
    for (let k = 0; k < 5; k++) for (let j = 0; j < 6; j++) {
        const sc = -15 + j * 6, tb = -8 + k * 5.2;
        truth.push({ s0: sc - 0.7, s1: sc + 0.7, t0: tb, t1: tb + 2.2 });
    }
    const rgb = new Uint8Array(W * H * 3);
    let seed = id * 31 + 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = -20 + (x + 0.5) * px, t = 20 - (y + 0.5) * px;
        let v = 165;
        for (const o of truth) if (s >= o.s0 && s <= o.s1 && t >= o.t0 && t <= o.t1) v = 70;
        if (Math.hypot(s - 2.5, t - 4) < 0.5 || Math.hypot(s + 8.5, t - 12) < 0.5) v = 70;
        v += (rnd() - 0.5) * 30;
        for (let c = 0; c < 3; c++) rgb[(y * W + x) * 3 + c] = Math.max(0, Math.min(255, Math.round(v + (c === 0 ? 12 : 0))));
    }
    const meta: ReliefOrthoFacade = {
        facadeId: id, planeIndex: id, image: `facade_${id}.png`, area_m2: 1200, centroid, normal: [1, 0, 0], axisS: [0, 0, -1], axisT: [0, 1, 0],
        sMin: -20, sMax: 20, tMin: -10, tMax: 20, pixel: px, texel: 0.2, width: W, height: H, orthoSMin: -20, orthoTMax: 20, coverage: 1,
        pattern: 'cells', latticeConfirmation: 0.3, latticeRejected: true,
        // the relief's own measurement: three of the thirty windows, and a blotch
        cells: [[-15.6, -14.4, -7.9, -5.9, -0.2, 1, 0.3], [-3.6, -2.4, 2.3, 4.3, -0.2, 1, 0.3], [2.0, 3.0, 3.5, 4.5, -0.2, 1, 0.3], [8.4, 9.6, 7.5, 9.5, -0.2, 1, 0.3]]
    };
    return { meta, png: encodePng(W, H, rgb), truth };
}

describe('the facade grammar stage', () => {
    it('commits the grammar that passes the scan and held-out checks as a photo-inferred lattice, and drops the one that does not, saying why', async () => {
        const prev = process.env.SCRATCHBOX_FACADE_GRAMMAR;
        process.env.SCRATCHBOX_FACADE_GRAMMAR = '1';
        try {
            const root = path.join(TMP, 'ws');
            fs.mkdirSync(root, { recursive: true });
            const native = fakeNative(path.join(root, 'native'), PARK);
            const good = facadeOf(3, [20, 10, 0]), bad = facadeOf(5, [-20, 10, 0]);
            const refineCalls: TileRefineRequest[] = [];
            let grammarFile = '';
            const refine = {
                refine: async (req: TileRefineRequest) => {
                    refineCalls.push(req);
                    const r = await native.deps.refine.refine(req);
                    if (req.reliefOrthos) {
                        const dir = path.join(path.dirname(r.clayGlb), 'relief_orthos');
                        fs.mkdirSync(dir, { recursive: true });
                        for (const f of [good, bad]) fs.writeFileSync(path.join(dir, f.meta.image), f.png);
                        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ schema: 'scratchbox.relief-orthos/1', facades: [good.meta, bad.meta] }));
                        return { ...r, reliefOrthosDir: dir };
                    }
                    if (req.facadeGrammar) {
                        grammarFile = fs.readFileSync(req.facadeGrammar, 'utf8');
                        return { ...r, cacheKey: `${r.cacheKey}g`, stats: { relief: { grammar: [{ facadeId: 3, applied: true, overObserved: 3, inferred: 27, contradicted: 0 }], lattices: [] } } };
                    }
                    return r;
                }
            };
            const vision: VisionGenAIClient = {
                models: {
                    generateContent: async (params: any) => {
                        const img = promptImage(params);
                        // the reader knows which facade by its pixels: facade 5's is read half a storey off
                        const which = [good, bad].find(f => { try { simulatedReply(f.meta, f.png, img, []); return true; } catch { return false; } })!;
                        const text = simulatedReply(which.meta, which.png, img, which.truth, which === bad ? { tierShiftM: 2.6 } : {});
                        return { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001` } as any;
                    }
                }
            };
            const deps: StagedLocationDeps = {
                cache: new StageCache({ workspaceRoot: root }),
                geocode: async q => ({ lat: 40.72471, lng: -73.99536, formattedAddress: `${q}, New York, NY`, placeId: 'p' }),
                extract: native.deps.extract, vegetation: native.deps.vegetation, refine,
                vision: { client: vision, candidates: ['gemini-4-argon'] },
                // facade 3's building: an edge along its plane (x = 20, z -20..20), 30 m tall (its top storey ends 28.2 m up)
                footprints: async () => ({ buildings: [{ id: 'b1/e0', buildingId: 'b1', ring: [[20, -20], [20, 20], [40, 20], [40, -20]], heightM: 30, heightSource: 'vector' }], note: '1 extruded building footprint (stand-in)' }),
                newRunId: () => 'a1b2c3d4', sleep: async () => undefined
            };
            const events: StageEvent[] = [];
            const { result } = await runStagedLocation({ query: 'Puck Building', isolate: false, trees: false }, deps, { emitStage: e => events.push(e) });

            // the remesh was asked for the facades' orthophotos, and the relief was run again with the accepted grammar only
            expect(refineCalls[0].reliefOrthos).toBe(true);
            expect(grammarFile).toMatch(/^facade 3 /m);
            expect(grammarFile).not.toMatch(/^facade 5 /m);
            expect(grammarFile.match(/^tier /gm)!.length).toBe(5);

            const stage = result.stages.find(s => s.stage === 'grammar')!;
            expect(stage.status).toBe('degraded');
            expect(stage.source).toMatch(/1 of 2 facades took a photo-inferred grammar/);
            expect(stage.source).toMatch(/agreed by vector footprints/);
            const layers: any[] = (result.artifact as any).data.stagedBuild.layers;
            const layer = layers.find(l => l.layer === 'l2g')!;
            const l2 = layers.find(l => l.layer === 'l2')!;
            expect(layer.provenanceLabels).toEqual(['remeshed', 'photo-inferred']);
            expect(layer.provenance.measuredGeometry).toBe(false);
            expect(layer.provenance.confidence).toBeGreaterThan(0.5);
            expect(layer.provenance.inferred).toMatchObject({ grammarFacades: 1, grammarCells: 30 });
            expect(layer.supersedes).toEqual([l2.objectId]);

            const rec = result.degradations.find(d => d.reasonCode === 'grammar_rejected')!;
            expect(rec).toMatchObject({ stage: 'grammar', fellTo: "the relief's own window lattice on that facade", provenanceAfter: 'remeshed', transient: false });
            expect(rec.part.description).toMatch(/facade 5/);
            expect(rec.reason).toMatch(/^the grammar read from the tile photo was not used: (scan|held-out): /);
            expect(validateContract('StagedLocationResult', result)).toEqual([]);
            expect(events.filter(e => e.stage === 'grammar').map(e => e.status)).toEqual(['running', 'degraded']);
        } finally {
            if (prev === undefined) delete process.env.SCRATCHBOX_FACADE_GRAMMAR; else process.env.SCRATCHBOX_FACADE_GRAMMAR = prev;
        }
    }, 300_000);

    it('textures the grammar layer even when it commits after the rest of the build has settled (an uncached first build)', async () => {
        // live (bake-off, Haughwout and Jefferson Market, first builds): the grammar's vision reading took longer than the
        // rebuild, so l2g committed after the texture stage had stopped listening for late layers, and showed in clay
        const prev = process.env.SCRATCHBOX_FACADE_GRAMMAR;
        process.env.SCRATCHBOX_FACADE_GRAMMAR = '1';
        try {
            const root = path.join(TMP, 'ws-late');
            fs.mkdirSync(root, { recursive: true });
            const native = fakeNative(path.join(root, 'native'), { ground: 40, buildings: [[-13, 13, -6, 5, 22]], trees: [] });
            const good = facadeOf(3, [20, 10, 0]);
            const refine = {
                refine: async (req: TileRefineRequest) => {
                    const r = await native.deps.refine.refine(req);
                    if (req.reliefOrthos) {
                        const dir = path.join(path.dirname(r.clayGlb), 'relief_orthos');
                        fs.mkdirSync(dir, { recursive: true });
                        fs.writeFileSync(path.join(dir, good.meta.image), good.png);
                        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ schema: 'scratchbox.relief-orthos/1', facades: [good.meta] }));
                        return { ...r, reliefOrthosDir: dir };
                    }
                    if (req.facadeGrammar) return { ...r, cacheKey: `${r.cacheKey}g`, stats: { relief: { grammar: [{ facadeId: 3, applied: true, overObserved: 3, inferred: 27, contradicted: 0 }], lattices: [] } } };
                    return r;
                }
            };
            let textureStageDone = false;
            const vision: VisionGenAIClient = {
                models: {
                    generateContent: async (params: any) => {
                        const img = promptImage(params);
                        // the reading is slow: it answers only once the texture stage has textured everything else
                        for (let i = 0; i < 6000 && !textureStageDone; i++) await new Promise(r => setTimeout(r, 10));
                        const text = simulatedReply(good.meta, good.png, img, good.truth);
                        return { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], modelVersion: `${params.model}-001` } as any;
                    }
                }
            };
            const deps: StagedLocationDeps = {
                cache: new StageCache({ workspaceRoot: root }),
                geocode: async q => ({ lat: 40.72181, lng: -73.99949, formattedAddress: `${q}, New York, NY`, placeId: 'p' }),
                extract: native.deps.extract, vegetation: native.deps.vegetation, refine,
                vision: { client: vision, candidates: ['gemini-4-argon'] },
                footprints: async () => ({ buildings: [{ id: 'b1/e0', buildingId: 'b1', ring: [[20, -20], [20, 20], [40, 20], [40, -20]], heightM: 30, heightSource: 'vector' }], note: '1 extruded building footprint (stand-in)' }),
                newRunId: () => 'a1b2c3d5', sleep: async () => undefined,
                textures: { maxDensityTexelsPerMeter: 4, maxSide: 256 }
            };
            const events: StageEvent[] = [];
            const { result } = await runStagedLocation({ query: 'Haughwout Building', isolate: true, trees: false }, deps, {
                emitStage: e => {
                    events.push(e);
                    // the first layers' textures are done: from here on the grammar's reading may answer
                    if (e.stage === 'textures' && /l2 textured/.test(String((e as any).message ?? ''))) textureStageDone = true;
                }
            });
            const layers: any[] = (result.artifact as any).data.stagedBuild.layers;
            const l2g = layers.find(l => l.layer === 'l2g');
            expect(l2g, JSON.stringify(result.stages.map(s => [s.stage, s.status, s.reason]))).toBeDefined();
            // committed after the l2 texture, and still textured
            const grammarCommit = events.find(e => e.stage === 'grammar' && (e.status === 'committed' || e.status === 'degraded'))!.seq;
            const l2Textured = events.find(e => e.stage === 'textures' && /l2 textured/.test(String((e as any).message ?? '')))!.seq;
            expect(grammarCommit).toBeGreaterThan(l2Textured);
            expect(l2g.textured, 'l2g has no textured variant').toBeDefined();
            expect(l2g.textured.url).not.toBe(l2g.url);
            expect(l2g.textured.rungShares.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1, 3);
            expect(result.texturePass!.layers.map(l => l.layerKey)).toContain('l2g');
        } finally {
            if (prev === undefined) delete process.env.SCRATCHBOX_FACADE_GRAMMAR; else process.env.SCRATCHBOX_FACADE_GRAMMAR = prev;
        }
    }, 300_000);
});
