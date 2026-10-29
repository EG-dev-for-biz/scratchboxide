/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's occlusion masks downstream of tile_refine (pipeline-k/occlusion.ts): read at the threshold, carried through
 * the straightening warp with the photo, left unread by the wall grammar's evidence, and, where two facades of one wall
 * overlap, the sheet takes the member that saw a texel clear.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyWarp, applyWarpMask, type MeshWarp } from '../src/node/3d-engine/staged-location/pipeline-k/ortho-rectify';
import { OCCLUSION_PARAMS, readOccluded, unreadMask } from '../src/node/3d-engine/staged-location/pipeline-k/occlusion';
import { wallEvidence, type GrammarFacade } from '../src/node/3d-engine/staged-location/wall-grammar';
import { buildWallSheets } from '../src/node/3d-engine/staged-location/wall-sheets';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { decodePng } from '../src/node/texture-processing';

const dec = (b: Buffer) => { const d = decodePng(b); return { rgba: d.rgba, width: d.width, height: d.height }; };

const facade = (facadeId: number, cx: number, z: number, width: number, y0: number, y1: number): GrammarFacade => ({
    facadeId, image: `f${facadeId}.png`, centroid: [cx, (y0 + y1) / 2, z], normal: [0, 0, 1], axisS: [1, 0, 0], axisT: [0, 1, 0],
    sMin: -width / 2, sMax: width / 2, tMin: -(y1 - y0) / 2, tMax: (y1 - y0) / 2, pixel: 0.1, width: width * 10, height: (y1 - y0) * 10, orthoSMin: -width / 2, orthoTMax: (y1 - y0) / 2
});

/** Writes a facade's photo (one colour where `cover(x)`, uncovered grey elsewhere), its uncovered mask and, when given, its occlusion mask. */
function writeFacade(dir: string, f: GrammarFacade, colour: number[], cover: (x: number) => boolean, occ?: (x: number) => number): GrammarFacade {
    const W = f.width, H = f.height, rgba = new Uint8Array(W * H * 4), unc = new Uint8Array(W * H), o = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const k = y * W + x;
        rgba.set(cover(x) ? [...colour, 255] : [128, 128, 128, 255], k * 4);
        unc[k] = cover(x) ? 0 : 255;
        o[k] = occ ? occ(x) : 0;
    }
    const out = { ...f, uncoveredMask: `f${f.facadeId}_u.png`, ...(occ ? { occludedMask: `f${f.facadeId}_occluded.png` } : {}) };
    fs.writeFileSync(path.join(dir, f.image), encodePng(W, H, Buffer.from(rgba), 4));
    fs.writeFileSync(path.join(dir, out.uncoveredMask), encodePng(W, H, Buffer.from(unc), 1));
    if (occ) fs.writeFileSync(path.join(dir, out.occludedMask!), encodePng(W, H, Buffer.from(o), 1));
    return out;
}

describe('pipeline K occlusion masks', () => {
    it('reads a texel as occluded at the threshold, and not a mask of another size', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'occ-'));
        const at = Math.round(OCCLUSION_PARAMS.minBlocked * 255);
        fs.writeFileSync(path.join(dir, 'm.png'), encodePng(4, 1, Buffer.from([0, at - 1, at, 255]), 1));
        expect(Array.from(readOccluded(dir, { occludedMask: 'm.png' }, 4, 1)!)).toEqual([0, 0, 1, 1]);
        expect(readOccluded(dir, { occludedMask: 'm.png' }, 2, 2)).toBeUndefined();
        expect(readOccluded(dir, {}, 4, 1)).toBeUndefined();
        expect(Array.from(unreadMask([1, 0, 0, 0], [0, 0, 1, 0], 4))).toEqual([1, 0, 1, 0]);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('carries the mask through the straightening warp onto the same texels as the photo', () => {
        // a 64 x 64 ortho with red dots every 8 px, the mask set on the dots; a warp that bends the columns (shift grows with y)
        const W = 64, H = 64, rgba = new Uint8Array(W * H * 4), mask = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const k = y * W + x, dot = x % 8 === 4 && y % 8 === 4;
            rgba.set(dot ? [220, 20, 20, 255] : [90, 90, 90, 255], k * 4);
            mask[k] = dot ? 255 : 0;
        }
        const G = 16, nx = 5, ny = 5, sx = new Float64Array(nx * ny), sy = new Float64Array(nx * ny);
        for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) { sx[j * nx + i] = Math.min(W - 1, i * G) + j; sy[j * nx + i] = Math.min(H - 1, j * G); }
        const warp: MeshWarp = { G, nx, ny, sx, sy };
        const img = applyWarp({ width: W, height: H, rgba }, warp), m = applyWarpMask(mask, W, H, warp);
        let set = 0, onRed = 0;
        for (let k = 0; k < W * H; k++) if (m[k]) { set++; if (img.rgba[k * 4] > 150) onRed++; }
        expect(set).toBeGreaterThan(30);
        expect(onRed / set).toBeGreaterThan(0.95);
        // and the warp moved them: the warped mask is not the original
        expect(m.some((v, k) => v !== mask[k])).toBe(true);
    });

    it("leaves a facade's occluded texels out of its wall's evidence", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'occ-wall-'));
        const f = writeFacade(dir, facade(1, 0, 0, 20, 0, 10), [180, 120, 100], () => true, x => (x < 100 ? 255 : 0));
        const e = wallEvidence(dir, [f], new Map(), [1, 0, 0], -10, 0, 10, 10, dec);
        let left = 0, right = 0;
        for (let y = 0; y < e.ny; y++) for (let x = 0; x < e.nu; x++) if (e.covered[y * e.nu + x]) { if (x * e.cellM < 10) left++; else right++; }
        expect(left).toBe(0);
        expect(right).toBeGreaterThan(0);
        // without its mask the whole facade is evidence
        const plain = wallEvidence(dir, [{ ...f, occludedMask: undefined }], new Map(), [1, 0, 0], -10, 0, 10, 10, dec);
        expect(Array.from(plain.covered).filter(v => v).length).toBeGreaterThan(left + right);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('lays the member that saw a texel clear on the sheet, and marks what only an occluded member saw', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'occ-sheet-'));
        // facade 1 (s -10..10, covers it all, ranks first) has something in front of it over s -10..5; facade 2 (s 0..20,
        // 0.3 m behind) saw s 0..20 clear: the sheet takes facade 2 over s 0..5, and facade 1 (marked occluded) over s -10..0
        const f1 = writeFacade(dir, facade(1, 0, 0, 20, 0, 20), [200, 40, 40], () => true, x => (x < 150 ? 255 : 0));
        const f2 = writeFacade(dir, facade(2, 10, -0.3, 20, 0, 20), [40, 40, 200], () => true);
        fs.writeFileSync(path.join(dir, 'facades.json'), JSON.stringify({ facades: [{ ...f1, coverage: 1, wallCoverage: 1 }, { ...f2, coverage: 1, wallCoverage: 0.9 }] }));
        const grammar = { version: 'v', params: {} as never, facades: {}, walls: [{ wallId: 4, facades: [1, 2], normal: [0, 0, 1], axisU: [1, 0, 0], offset: 0, u0: -10, u1: 20, y0: 0, y1: 20, coverage: 1, tier: 0, bays: [] }] };
        const { sheets } = buildWallSheets(dir, grammar as never, undefined, dec);
        expect(sheets).toHaveLength(1);
        const sh = sheets[0].facade, img = decodePng(fs.readFileSync(path.join(dir, sh.image)));
        expect(sh.occludedMask).toBeDefined();
        const occ = decodePng(fs.readFileSync(path.join(dir, sh.occludedMask!)));
        const at = (s: number) => { const x = Math.floor((s - sh.orthoSMin) / sh.pixel), k = 100 * img.width + x; return { r: img.rgba[k * 4], b: img.rgba[k * 4 + 2], occ: occ.rgba[k * 4] }; };
        // s 2.5 m: both saw it, facade 1 through something: facade 2's blue, not occluded
        expect(at(2.5)).toMatchObject({ b: 200, occ: 0 });
        // s -5 m: only facade 1 saw it: its red, occluded
        expect(at(-5)).toMatchObject({ r: 200, occ: 255 });
        // s 8 m: facade 1 saw it clear: its red, not occluded
        expect(at(8)).toMatchObject({ r: 200, occ: 0 });
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
