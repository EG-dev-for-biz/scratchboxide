/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Facade grammar (facade-grammar.ts + tile_refine --facade-grammar), on a synthetic 40 m tower whose +x facade is painted
 * with a known grammar: a ground tier of three tall openings (3.8 m) and eight upper tiers of paired windows (bays in pairs:
 * 1.2 m windows 2 m apart, pairs 7 m apart), on a photo as unhelpful as a tile's (soft, grainy, glass from dark to
 * sky-bright behind a glazing bar, a stain, blotches, shopfront glass barely darker than the wall). The model's reading is simulated (the true openings in the image it is shown, a few centimetres off, only what that
 * image shows); everything else is the real pipeline: tile_refine's orthophoto export, the fit, both gates, and the relief
 * with the accepted grammar.
 *  - the grammar is recovered: every true opening comes out carved within 10 cm of its place and size, on one lattice;
 *    tile_refine's own lattice (the relief without a grammar) misses the tall ground tier;
 *  - the accepted grammar is labelled photo-inferred with a confidence (_LATTICE_CELL 3/4, asset.extras.scratchbox.facadeGrammar);
 *  - a reading put half a storey off is not used: the held-out check rejects it, with its reason.
 * Clay renders go to test-results/screenshots/facade_grammar/ (gitignored).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { HeadlessMeshSilhouetteRenderer } from '../src/node/spatial/HeadlessMeshSilhouetteRenderer';
import { type Chunk, quad, flat, writeGlb, readGlb, encodePng, buildTileRefine } from './helpers/synthetic-scan-glb';
import {
    decodeOrtho, grammarFileText, readReliefOrthos, runFacadeGrammarPass, writeOverlay, grammarCells, type ReliefOrthoFacade
} from '../src/node/3d-engine/staged-location/facade-grammar';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';

const REPO = path.resolve(__dirname, '../../..');
const WORK = path.join(REPO, 'test-results/facade-grammar');
const SHOTS = path.join(REPO, 'test-results/screenshots/facade_grammar');
const BIN = path.join(WORK, 'tile_refine');

/** A true opening in texture coordinates: s from the facade's z = 15 end (s = 15 - z), t = y. */
interface Opening { s0: number; s1: number; t0: number; t1: number }
const TRUTH: Opening[] = [];
for (const c of [5, 15, 25]) TRUTH.push({ s0: c - 2.0, s1: c + 2.0, t0: 0.8, t1: 4.6 });
for (let k = 0; k < 8; k++)
    for (const c of [2.5, 4.5, 9.5, 11.5, 16.5, 18.5, 23.5, 25.5]) TRUTH.push({ s0: c - 0.6, s1: c + 0.6, t0: 6.0 + 3.6 * k, t1: 8.0 + 3.6 * k });

/**
 * The scan's photo of the facade: 600 x 800 px over 30 x 40 m (5 cm), then blurred over 15 cm as a tile texture is. The
 * openings are where the grammar puts them; the photo is as unhelpful as a real tile's: a darkish wall (150), each window
 * in a light frame (215, 8 cm) around glass anywhere from dark to sky-bright (60 to 230), a dark stain running down the
 * facade (a fire escape's shadow), dark blotches on the wall, grain, and a ground tier of shopfront glass close to the
 * wall's own brightness.
 */
function facadeTexture(): Buffer {
    const TW = 600, TH = 800, PX = 0.05;
    const lum = new Float32Array(TW * TH);
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const glass = TRUTH.map((_, i) => (i < 3 ? 135 : 60 + 170 * (((i * 37) % 11) / 10)));
    const blotches = [[7.2, 13.1], [14.0, 20.4], [21.3, 27.0], [27.8, 9.2], [1.2, 30.5]];
    for (let y = 0; y < TH; y++)
        for (let x = 0; x < TW; x++) {
            const s = (x + 0.5) * PX, t = 40 - (y + 0.5) * PX;
            let v = 150;
            TRUTH.forEach((p, i) => {
                if (s < p.s0 - 0.08 || s > p.s1 + 0.08 || t < p.t0 - 0.08 || t > p.t1 + 0.08) return;
                v = s < p.s0 || s > p.s1 || t < p.t0 || t > p.t1 ? 215 : glass[i];
            });
            if (s > 12.6 && s < 14.2 && t > 5) v -= 60;                              // a stain down the facade
            for (const [bs, bt] of blotches) if (Math.hypot(s - bs, t - bt) < 0.45) v = 80;  // dark blotches on the wall
            lum[y * TW + x] = v + (rnd() - 0.5) * 50;
        }
    // the tile texture's own softness: a 3 x 3 box twice (about 15 cm)
    let a = lum, b = new Float32Array(TW * TH);
    for (let pass = 0; pass < 2; pass++) {
        for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
            let sum = 0, n = 0;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < TW && yy < TH) { sum += a[yy * TW + xx]; n++; } }
            b[y * TW + x] = sum / n;
        }
        [a, b] = [b, a];
    }
    const rgb = new Uint8Array(TW * TH * 3);
    for (let i = 0; i < TW * TH; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = Math.max(0, Math.min(255, Math.round(a[i] + (c === 0 ? 10 : 0))));
    return encodePng(TW, TH, rgb);
}

/** The world point (x = 10) of texture coordinates (s, t). */
const world = (s: number, t: number): [number, number, number] => [10, t, 15 - s];

/**
 * A simulated reading: the true openings whose centre the image shows, in its per-mille coordinates, a few per-mille
 * off (deterministic, up to 3), with every tier moved by `tierShiftM` (a wrong reading). The image's place in the ortho is found by
 * matching its pixels against the full orthophoto (the reading is told nothing else).
 */
function fakeChain(f: ReliefOrthoFacade, fullPng: Buffer, opts: { tierShiftM?: number } = {}) {
    const full = decodeImageInMemory(fullPng);
    const toS = (w: [number, number, number]) => (w[0] - f.centroid[0]) * f.axisS[0] + (w[1] - f.centroid[1]) * f.axisS[1] + (w[2] - f.centroid[2]) * f.axisS[2];
    const toT = (w: [number, number, number]) => (w[0] - f.centroid[0]) * f.axisT[0] + (w[1] - f.centroid[1]) * f.axisT[1] + (w[2] - f.centroid[2]) * f.axisT[2];
    let calls = 0;
    return {
        calls: () => calls,
        chain: {
            generate: async (params: any) => {
                calls++;
                const png = Buffer.from(params.contents[0].parts[0].inlineData.data, 'base64');
                const img = decodeImageInMemory(png);
                // the crop's place in the full ortho (a band of columns or of rows, same pixels)
                let x0 = -1, y0 = -1;
                const same = (ox: number, oy: number) => {
                    for (let y = 0; y < img.height; y += 7) for (let x = 0; x < img.width; x += 13)
                        for (let c = 0; c < 3; c++) if (img.rgba[(y * img.width + x) * 4 + c] !== full.rgba[((y + oy) * full.width + x + ox) * 4 + c]) return false;
                    return true;
                };
                if (img.height === full.height) { for (let off = 0; off + img.width <= full.width && x0 < 0; off++) if (same(off, 0)) { x0 = off; y0 = 0; } }
                else if (img.width === full.width) { for (let off = 0; off + img.height <= full.height && y0 < 0; off++) if (same(0, off)) { x0 = 0; y0 = off; } }
                if (x0 < 0 || y0 < 0) throw new Error('the simulated reader could not place the image');
                const sMin = f.orthoSMin + x0 * f.pixel, sMax = sMin + img.width * f.pixel, tMax = f.orthoTMax - y0 * f.pixel, H = img.height * f.pixel;
                const tiers = new Map<number, Array<[number, number]>>();
                const bands = new Map<number, [number, number]>();
                let k = 0;
                for (const o of TRUTH) {
                    const a = world(o.s0, o.t0), b = world(o.s1, o.t1);
                    const s0 = Math.min(toS(a), toS(b)), s1 = Math.max(toS(a), toS(b));
                    const t0 = Math.min(toT(a), toT(b)) + (opts.tierShiftM ?? 0), t1 = Math.max(toT(a), toT(b)) + (opts.tierShiftM ?? 0);
                    const sc = 0.5 * (s0 + s1), tc = 0.5 * (t0 + t1);
                    if (sc < sMin || sc > sMax || tc > tMax || tc < tMax - H) continue;
                    const j = ((k++ * 5) % 7) - 3;  // -3..3 per-mille
                    const key = Math.round(t0 * 10);
                    bands.set(key, [Math.max(0, ((tMax - t1) / H) * 1000 + j), Math.min(1000, ((tMax - t0) / H) * 1000 - j)]);
                    const cols = tiers.get(key) ?? [];
                    // an opening the image cuts is read to the image's edge
                    cols.push([Math.max(0, ((s0 - sMin) / (sMax - sMin)) * 1000 - j), Math.min(1000, ((s1 - sMin) / (sMax - sMin)) * 1000 + j)]);
                    tiers.set(key, cols);
                }
                const reply = { tiers: [...tiers.keys()].sort((a, b) => b - a).map(key => ({ y: bands.get(key)!.map(v => Math.round(v)), cols: tiers.get(key)!.map(c => c.map(v => Math.round(v))) })), conf: 80, notes: 'simulated' };
                return { response: { candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] }, model: 'simulated-reader', ms: 1, remember: () => undefined };
            }
        } as any
    };
}

function scan(): string {
    const facade: Chunk = quad([10, 0, 15], [0, 0, -30], [0, 40, 0], 10, 10);
    facade.uvs = [];
    for (let i = 0; i < facade.positions.length; i += 3) facade.uvs.push((15 - facade.positions[i + 2]) / 30, 1 - facade.positions[i + 1] / 40);
    facade.image = 0;
    const chunks: Chunk[] = [
        flat(-70, 70, -70, 70, 0, 20), facade,
        quad([-10, 0, -15], [0, 0, 30], [0, 40, 0], 6, 6), quad([-10, 0, 15], [20, 0, 0], [0, 40, 0], 6, 6),
        quad([10, 0, -15], [-20, 0, 0], [0, 40, 0], 6, 6), flat(-10, 10, -15, 15, 40, 6)
    ];
    const input = path.join(WORK, 'tower.glb');
    writeGlb(input, chunks, [facadeTexture()]);
    return input;
}

function refine(input: string, name: string, extra: string[]): { clay: string; stats: any } {
    const clay = path.join(WORK, `${name}_clay.glb`), stats = path.join(WORK, `${name}_stats.json`);
    execFileSync(BIN, ['--input', input, '--isolate', '--apron', '8', '--out-clay', clay, '--stats', stats, '--threads', '4', ...extra], { stdio: 'pipe', timeout: 300_000 });
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(clay);
    const pose = { x: 46, y: 20, z: 6, targetX: 10, targetY: 20, targetZ: 0, fov: 55 };
    const img = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, pose, 900, 900, { clipNearPlane: true, clayColor: [200, 200, 196], bgColor: [40, 44, 52, 255], lightDir: [0.7, 0.5, 0.5] });
    HeadlessMeshSilhouetteRenderer.exportPngToFile(path.join(SHOTS, `synthetic_${name}_clay.png`), 900, 900, img.rgba);
    return { clay, stats: JSON.parse(fs.readFileSync(stats, 'utf8')) };
}

/** The recessed windows of the clay (connected faces facing +x behind the facade), as boxes in texture (s, t). */
function carved(file: string): Opening[] {
    const mesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(file), P = mesh.vertices, T = mesh.indices;
    const key = (i: number) => `${P[3 * i].toFixed(4)},${P[3 * i + 1].toFixed(4)},${P[3 * i + 2].toFixed(4)}`;
    const ids = new Map<string, number>(), parent: number[] = [];
    const id = (i: number) => { const k = key(i); if (!ids.has(k)) { ids.set(k, parent.length); parent.push(parent.length); } return ids.get(k)!; };
    const find = (x: number): number => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
    const faces: Array<{ a: number; vs: number[] }> = [];
    for (let t = 0; t < T.length / 3; t++) {
        const [a, b, c] = [T[3 * t], T[3 * t + 1], T[3 * t + 2]];
        if (!(P[3 * a] < 9.95 && P[3 * b] < 9.95 && P[3 * c] < 9.95 && P[3 * a] > 9.5)) continue;
        const e1 = [0, 1, 2].map(k => P[3 * b + k] - P[3 * a + k]), e2 = [0, 1, 2].map(k => P[3 * c + k] - P[3 * a + k]);
        const nx = e1[1] * e2[2] - e1[2] * e2[1], area = 0.5 * Math.hypot(nx, e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]);
        if (area < 1e-6 || nx / (2 * area) < 0.9) continue;
        const [ia, ib, ic] = [id(a), id(b), id(c)];
        parent[find(ib)] = find(ia); parent[find(ic)] = find(ia);
        faces.push({ a: ia, vs: [a, b, c] });
    }
    const box = new Map<number, Opening>();
    for (const f of faces) {
        const r = find(f.a), e = box.get(r) ?? { s0: Infinity, s1: -Infinity, t0: Infinity, t1: -Infinity };
        for (const v of f.vs) { const s = 15 - P[3 * v + 2], t = P[3 * v + 1]; e.s0 = Math.min(e.s0, s); e.s1 = Math.max(e.s1, s); e.t0 = Math.min(e.t0, t); e.t1 = Math.max(e.t1, t); }
        box.set(r, e);
    }
    return [...box.values()].filter(b => b.s1 - b.s0 > 0.3 && b.t1 - b.t0 > 0.3);
}

/** True openings with a carved window within `tol` of each edge (the carved floor is inset by the 2 cm jamb). */
function recovered(cut: Opening[], tol = 0.1): number {
    let n = 0;
    for (const o of TRUTH) if (cut.some(c => Math.abs(c.s0 - o.s0) <= tol && Math.abs(c.s1 - o.s1) <= tol && Math.abs(c.t0 - o.t0) <= tol && Math.abs(c.t1 - o.t1) <= tol)) n++;
    return n;
}

describe('facade grammar: a noisy scanned facade with a known grammar', () => {
    let input = '';
    let before: { clay: string; stats: any };
    let facade: ReliefOrthoFacade;
    let png: Buffer;
    const orthos = path.join(WORK, 'orthos');

    beforeAll(() => {
        fs.rmSync(WORK, { recursive: true, force: true });
        fs.mkdirSync(WORK, { recursive: true });
        fs.mkdirSync(SHOTS, { recursive: true });
        buildTileRefine(REPO, BIN);
        input = scan();
        before = refine(input, 'relief_only', ['--relief-orthos', orthos]);
        facade = readReliefOrthos(orthos).find(f => Math.abs(f.normal[0]) > 0.9 && f.centroid[0] > 9)!;
        png = fs.readFileSync(path.join(orthos, facade.image));
    }, 620_000);

    it('recovers the grammar: every true opening carved within 10 cm, where the relief alone misses the tall ground tier', async () => {
        expect(facade).toBeDefined();
        const reader = fakeChain(facade, png);
        const pass = await runFacadeGrammarPass({ orthosDir: orthos, chain: reader.chain, overlayDir: SHOTS });
        expect(reader.calls()).toBe(5);   // the whole facade and each half alone (left, right, top, bottom)
        const out = pass.facades.find(f => f.facadeId === facade.facadeId)!;
        expect(out.accepted, out.reason).toBe(true);
        expect(out.scan!.passed).toBe(true);
        expect(out.heldOut!.after.chamferPx).toBeLessThan(out.heldOut!.before.chamferPx);
        // the continuous fields: a tall ground tier, eight 3.6 m storeys above it, paired bays 7 m apart
        const g = out.grammar!;
        expect(g.tiers.length).toBe(9);
        const near = (v: number, want: number, tol = 0.1) => expect(Math.abs(v - want), `${v} against ${want}`).toBeLessThanOrEqual(tol);
        near(g.openings[0].heightM, 3.8);
        for (const o of g.openings.slice(1)) { near(o.heightM, 2.0); expect(o.count).toBe(8); near(o.widthM, 1.2); }
        for (const h of g.storeyHeightsM.slice(1)) near(h, 3.6);
        const file = path.join(WORK, 'grammar.txt');
        fs.writeFileSync(file, grammarFileText(pass.accepted));
        const after = refine(input, 'with_grammar', ['--facade-grammar', file]);
        writeOverlay(path.join(SHOTS, 'synthetic_grammar_overlay.png'), decodeOrtho(png), facade, [], grammarCells(g));

        const cutBefore = carved(before.clay), cutAfter = carved(after.clay);
        const ground = TRUTH.slice(0, 3);
        expect(recovered(cutAfter)).toBeGreaterThanOrEqual(TRUTH.length - 1);
        expect(recovered(cutBefore)).toBeLessThan(TRUTH.length - 3);
        expect(ground.filter(o => cutBefore.some(c => Math.abs(c.t1 - o.t1) <= 0.1 && Math.abs(c.t0 - o.t0) <= 0.1)).length).toBe(0);
        // one lattice: the upper windows' carved centres share rows and columns exactly
        const upper = cutAfter.filter(c => c.t0 > 5);
        const rows = new Set(upper.map(c => (0.5 * (c.t0 + c.t1)).toFixed(2))), cols = new Set(upper.map(c => (0.5 * (c.s0 + c.s1)).toFixed(2)));
        expect(rows.size).toBe(8);
        expect(cols.size).toBe(8);

        // labelled: per vertex (3 over an observed window, 4 inferred) and in the file
        const glb = readGlb(after.clay);
        const extras = glb.json.asset.extras.scratchbox.facadeGrammar;
        expect(extras.provenance).toBe('photo-inferred');
        expect(extras.facades[0].confidence).toBeGreaterThan(0);
        expect(extras.facades[0].source).toBe('tiles');
        const [cell] = glb.attribute('_LATTICE_CELL'), [height] = glb.attribute('_RELIEF_HEIGHT');
        const codes = new Set<number>();
        for (let i = 0; i < cell.length; i++) if (height[i] < 0) codes.add(cell[i]);
        expect([...codes].every(c => c === 3 || c === 4)).toBe(true);
        const applied = after.stats.relief.grammar.find((x: any) => x.facadeId === facade.facadeId);
        expect(applied.applied).toBe(true);
        expect(applied.overObserved + applied.inferred).toBeGreaterThanOrEqual(TRUTH.length - 1);
    }, 300_000);

    it('does not use a reading half a storey off: the held-out check rejects it and says why', async () => {
        const reader = fakeChain(facade, png, { tierShiftM: 1.8 });
        const pass = await runFacadeGrammarPass({ orthosDir: orthos, chain: reader.chain });
        const out = pass.facades.find(f => f.facadeId === facade.facadeId)!;
        expect(out.accepted).toBe(false);
        expect(pass.accepted.length).toBe(0);
        expect(out.reason).toMatch(/^(scan|held-out): /);
        // the scan (the windows the relief measured are not in its openings) or the held-out photo says no
        expect(!out.scan!.passed || !out.heldOut!.passed).toBe(true);
    }, 300_000);
});
