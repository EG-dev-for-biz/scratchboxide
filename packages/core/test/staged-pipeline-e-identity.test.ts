/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E enhanced mode, round 5, on synthetic walls (no network, no model): the identity gate that replaced the 2.2 px
 * alignment gate (a crisp redraw whose windows drift a few decimetres passes and reports its chamfer; a wall with other bays,
 * another colour family, garbage or the wrong aspect does not), the region audit's tolerance of that drift, and the carved
 * openings following the plate (the lattice read again from the plate's edges). The storey and bay counter is a stand-in for
 * the vision model that counts the synthetic wall's dark window runs. Screenshots under
 * test-results/screenshots/version_e/identity/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodeImageInMemory } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { enhanceWall, ENHANCE_MODEL_DEFAULT, type PlateRequest } from '../src/node/3d-engine/staged-location/pipeline-e/enhance';
import { auditPlate } from '../src/node/3d-engine/staged-location/pipeline-e/plate-audit';
import { countPrompt, parseCountReply, type FacadeCounter } from '../src/node/3d-engine/staged-location/pipeline-e/plate-identity';
import { refitLatticeToPlate } from '../src/node/3d-engine/staged-location/pipeline-e/plate-lattice';
import type { FacadeGrammar } from '../src/node/3d-engine/staged-location/facade-grammar';
import type { MassingFace } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';

const SHOTS = path.resolve(__dirname, '../../../test-results/screenshots/version_e/identity');
const PX = 0.05;
const W = 360, H = 240; // 18 m x 12 m: 6 bays of 3 m, 4 storeys of 3 m
type Rgb = [number, number, number];

interface WallSpec { bays?: number; storeys?: number; brick?: Rgb; glass?: Rgb; dx?: (bay: number) => number; dy?: (storey: number) => number; noise?: number; blur?: number; seed?: number }

/** A synthetic wall; window k of storey r sits at its lattice place plus dx(k), dy(r) metres (right, up). */
function wall(o: WallSpec = {}): Uint8Array {
    const bays = o.bays ?? 6, storeys = o.storeys ?? 4, brick = o.brick ?? [178, 92, 70], glass = o.glass ?? [38, 46, 60];
    const bw = 18 / bays, sh = 12 / storeys;
    let s = o.seed ?? 5;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff - 0.5; };
    const out = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const xm = (x + 0.5) * PX, ym = (H - y - 0.5) * PX;
        let c: Rgb = brick;
        for (let r = 0; r < storeys && c === brick; r++) for (let k = 0; k < bays; k++) {
            const x0 = k * bw + 0.3 * bw + (o.dx?.(k) ?? 0), y0 = r * sh + 0.25 * sh + (o.dy?.(r) ?? 0);
            if (xm >= x0 && xm < x0 + 0.4 * bw && ym >= y0 && ym < y0 + 0.5 * sh) { c = glass; break; }
        }
        out.set([...c.map(v => Math.max(0, Math.min(255, Math.round(v + (o.noise ?? 0) * rnd())))), 255], (y * W + x) * 4);
    }
    return o.blur ? boxBlur(out, o.blur) : out;
}

function boxBlur(src: Uint8Array, r: number): Uint8Array {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const acc = [0, 0, 0];
        let n = 0;
        for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const xx = Math.max(0, Math.min(W - 1, x + dx)), yy = Math.max(0, Math.min(H - 1, y + dy));
            for (let c = 0; c < 3; c++) acc[c] += src[(yy * W + xx) * 4 + c];
            n++;
        }
        for (let c = 0; c < 3; c++) out[(y * W + x) * 4 + c] = Math.round(acc[c] / n);
        out[(y * W + x) * 4 + 3] = 255;
    }
    return out;
}

const all = () => new Uint8Array(W * H).fill(1);

function face(): MassingFace {
    return {
        index: 4, key: 'w4', kind: 'wall', part: 'p', loop: 0, edge: 0, wall: true, normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0], origin: [0, 0, 0],
        sMin: 0, sMax: W * PX, tMin: 0, tMax: H * PX, tBottom: 0, area: W * H * PX * PX, pixel: PX, orthoSMin: 0, orthoTMax: H * PX, width: W, height: H, coverage: 1, openings: [], top: []
    } as MassingFace;
}

/** The plate centred in the model's padded frame (as padToModelAspect places the wall), or stretched to `aspect` when given. */
function answer(plate: Uint8Array, r: PlateRequest, aspect?: number): Uint8Array {
    const w = aspect ? Math.round(r.height * aspect) : r.width, h = r.height;
    const out = new Uint8Array(w * h * 4).fill(128);
    if (aspect) {
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const sx = Math.min(W - 1, Math.floor((x / w) * W)), sy = Math.min(H - 1, Math.floor((y / h) * H)); out.set(plate.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (y * w + x) * 4); }
    } else {
        const ox = Math.floor((w - W) / 2), oy = Math.floor((h - H) / 2);
        for (let y = 0; y < H; y++) out.set(plate.subarray(y * W * 4, (y + 1) * W * 4), ((y + oy) * w + ox) * 4);
    }
    return new Uint8Array(encodePng(w, h, Buffer.from(out), 4));
}

/**
 * A stand-in for the vision model's count: the runs of dark (window) columns across the wall and of dark rows up it. It
 * reads the PNG it is given, like the model.
 */
const counter: FacadeCounter = async png => {
    const img = decodeImageInMemory(png);
    const { width: w, height: h, rgba } = img;
    const dark = (i: number) => 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2] < 80;
    const runs = (n: number, share: (k: number) => number) => { let c = 0, on = false; for (let k = 0; k < n; k++) { const v = share(k) > 0.12; if (v && !on) c++; on = v; } return c; };
    const col = (x: number) => { let d = 0; for (let y = 0; y < h; y++) if (dark(y * w + x)) d++; return d / h; };
    const row = (y: number) => { let d = 0; for (let x = 0; x < w; x++) if (dark(y * w + x)) d++; return d / w; };
    return { storeys: runs(h, row), bays: runs(w, col), conf: 90 };
};

async function redraw(plate: Uint8Array, opts: { aspect?: number } = {}) {
    const t = { width: W, height: H, rgba: wall({ noise: 18, blur: 3 }), source: new Uint8Array(W * H) };
    const client = async (r: PlateRequest) => ({ bytes: answer(plate, r, opts.aspect), modelUsed: 'fake-lite' });
    const r = await enhanceWall(face(), t, all(), { client, models: ['fake-lite'], locationName: 'X', source: 3, counter });
    return { r, t };
}

const shot = (name: string, panels: Uint8Array[]) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    const OW = panels.length * (W + 6), out = new Uint8Array(OW * H * 4);
    panels.forEach((p, j) => { for (let y = 0; y < H; y++) out.set(p.subarray(y * W * 4, (y + 1) * W * 4), (y * OW + j * (W + 6)) * 4); });
    for (let i = 3; i < out.length; i += 4) out[i] = 255;
    fs.writeFileSync(path.join(SHOTS, name), encodePng(OW, H, Buffer.from(out), 4));
};

// windows laid a little off the tile's: each bay 0.15-0.3 m sideways, each storey 0.1-0.25 m up or down
const driftX = (k: number) => [0.25, -0.2, 0.3, -0.15, 0.2, -0.3][k % 6];
const driftY = (r: number) => [0.15, -0.25, 0.1, -0.2][r % 4];

describe('enhanced mode: the identity gate', () => {
    it('makes Nano Banana Lite the default model', () => {
        expect(ENHANCE_MODEL_DEFAULT).toBe('gemini-3.1-flash-lite-image');
    });

    it('accepts a crisp redraw whose windows drift a few decimetres, and reports the chamfer it no longer gates on', async () => {
        const plate = wall({ dx: driftX, dy: driftY });
        const { r, t } = await redraw(plate);
        expect(r.accepted).toBe(true);
        // beyond the old gate (2.2 px or 15 % of edges lost), reported, within the gross bound
        expect((r.chamferPx ?? 0) > 2.2 || (r.lostShare ?? 0) > 0.15).toBe(true);
        expect(r.identity!.storeys).toMatchObject({ tile: 4, plate: 4, measured: true, passed: true });
        expect(r.identity!.bays).toMatchObject({ tile: 6, plate: 6, measured: true, passed: true });
        expect(r.why).toMatch(/reported/);
        // the audit does not take the drifted windows for replaced elements
        expect(r.audit!.regions.filter(x => x.kind === 'replaced')).toEqual([]);
        expect(Array.from(t.source).filter(v => v === 3).length).toBeGreaterThan(0.9 * W * H);
        shot('identity_drifted_redraw_accepted.png', [wall({ noise: 18, blur: 3 }), plate, t.rgba]);
    });

    it('rejects a redraw with other bays, another colour family, garbage, or the wrong aspect', async () => {
        const fewer = await redraw(wall({ bays: 4 }));
        expect(fewer.r.accepted).toBe(false);
        expect(fewer.r.identity!.bays).toMatchObject({ tile: 6, plate: 4, passed: false });
        const stone = await redraw(wall({ brick: [214, 208, 196], glass: [38, 46, 60] }));
        expect(stone.r.accepted).toBe(false);
        expect(stone.r.identity!.colourPassed).toBe(false);
        let s = 9;
        const noise = new Uint8Array(W * H * 4).map((_, i) => (i % 4 === 3 ? 255 : ((s = (s * 1103515245 + 12345) & 0x7fffffff) >> 8) & 255));
        const garbage = await redraw(noise);
        expect(garbage.r.accepted).toBe(false);
        const flat = await redraw(new Uint8Array(W * H * 4).fill(150));
        expect(flat.r.accepted).toBe(false);
        expect(flat.r.identity!.grossPassed).toBe(false);
        const squashed = await redraw(wall(), { aspect: 1 });
        expect(squashed.r.accepted).toBe(false);
        expect(squashed.r.identity!.aspectDrift).toBeGreaterThan(0.03);
        // nothing of a rejected wall is labelled generated
        for (const x of [fewer, stone, garbage, flat, squashed]) expect(Array.from(x.t.source).every(v => v === 0)).toBe(true);
        shot('identity_rejected.png', [wall({ bays: 4 }), wall({ brick: [214, 208, 196] }), noise]);
    });

    it('does not hold a wall to counts nobody could read, and says so', async () => {
        const t = { width: W, height: H, rgba: wall({ noise: 18, blur: 3 }), source: new Uint8Array(W * H) };
        const plate = wall({ dx: driftX });
        const r = await enhanceWall(face(), t, all(), { client: async (q: PlateRequest) => ({ bytes: answer(plate, q), modelUsed: 'fake' }), models: ['fake'], locationName: 'X', source: 3, counter: async () => { throw new Error('quota'); } });
        expect(r.accepted).toBe(true);
        expect(r.identity!.storeys.measured).toBe(false);
        expect(r.why).toMatch(/storeys: not counted \(the count could not be read: quota\)/);
    });

    it('asks for storeys and bays in one JSON reply and refuses a reply without them', () => {
        expect(countPrompt(18, 12)).toMatch(/"storeys"/);
        expect(parseCountReply('```json\n{"storeys": 6, "bays": 9, "conf": 80}\n```')).toEqual({ storeys: 6, bays: 9, conf: 80 });
        expect(() => parseCountReply('{"floors": 3}')).toThrow(/no storeys or bays/);
    });

    it('audits a drifted redraw against the tile without reverting its windows', () => {
        const input = wall({ noise: 18, blur: 3 });
        const plate = wall({ dx: driftX, dy: driftY });
        const tolerant = auditPlate(input, plate, W, H, all(), PX);
        const strict = auditPlate(input, plate, W, H, all(), PX, 0);
        const mean = (v: Float32Array) => { let t = 0, n = 0; for (const x of v) if (Number.isFinite(x)) { t += x; n++; } return t / n; };
        // the windows found where the plate drew them: the structure correlates better within the drift than in place
        expect(mean(tolerant.features.nccIn)).toBeGreaterThan(mean(strict.features.nccIn) + 0.05);
        expect(tolerant.flaggedAreaM2).toBeLessThanOrEqual(strict.flaggedAreaM2);
        expect(tolerant.regions.filter(x => x.kind === 'replaced')).toEqual([]);
    });
});

describe('enhanced mode: the carved openings follow the plate', () => {
    it('reads the lattice again from the plate: every line moves onto the drifted windows', () => {
        // the tile's grammar: 6 bays x 4 storeys at the lattice places
        const tiers = [0, 1, 2, 3].map(r => ({ t0: r * 3 + 0.75, t1: r * 3 + 0.75 + 1.5, cols: [0, 1, 2, 3, 4, 5].map(k => [k * 3 + 0.9, k * 3 + 0.9 + 1.2] as [number, number]) }));
        const g: FacadeGrammar = { schema: 'scratchbox.facade-grammar/1', facadeId: 4, normal: [0, 0, 1], centroid: [9, 6, 0], tiers, storeyHeightsM: [3, 3, 3], openings: tiers.map(() => ({ widthM: 1.2, heightM: 1.5, sillM: 0.75, bayPitchM: 3, count: 6 })), confidence: 0.7, source: 'tiles' };
        const plate = wall({ dx: driftX, dy: driftY });
        const r = refitLatticeToPlate(g, face(), plate, all());
        expect(r.moved).toBe(r.lines);
        expect(r.afterPx).toBeLessThan(1.2);
        expect(r.beforePx).toBeGreaterThan(2);
        for (const [ri, t] of r.grammar.tiers.entries()) {
            expect(Math.abs(t.t0 - (ri * 3 + 0.75 + driftY(ri)))).toBeLessThanOrEqual(PX + 1e-9);
            for (const [k, [s0, s1]] of t.cols.entries()) {
                expect(Math.abs(s0 - (k * 3 + 0.9 + driftX(k)))).toBeLessThanOrEqual(PX + 1e-9);
                expect(Math.abs(s1 - s0 - 1.2)).toBeLessThanOrEqual(2 * PX + 1e-9);
            }
        }
        expect(r.grammar.source).toBe('tiles+enhanced-plate');
        // nothing moves on a plate that keeps the tile's lattice
        const same = refitLatticeToPlate(g, face(), wall(), all());
        expect(same.moved).toBe(0);
        // the shot: the plate with the tile's openings (red) and the refit (green)
        const draw = (img: Uint8Array, gg: FacadeGrammar, c: Rgb, inset: number) => {
            for (const t of gg.tiers) for (const [s0, s1] of t.cols) {
                const x0 = Math.round(s0 / PX) + inset, x1 = Math.round(s1 / PX) - inset, y0 = Math.round((12 - t.t1) / PX) + inset, y1 = Math.round((12 - t.t0) / PX) - inset;
                for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) img.set([...c, 255], (y * W + x) * 4);
                for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) img.set([...c, 255], (y * W + x) * 4);
            }
            return img;
        };
        shot('lattice_refit.png', [draw(plate.slice(), g, [255, 40, 40], 0), draw(plate.slice(), r.grammar, [40, 255, 80], 0)]);
    });
});
