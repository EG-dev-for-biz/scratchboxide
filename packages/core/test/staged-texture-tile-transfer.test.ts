/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Task D, tier 2: tile photo transfer onto the atlas (staged_location_texture_pass_design.md section 5). Analytic
 * fixtures only: a textured tile GLB synthesised in code over the fixture facade; no network, no model.
 */

import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import { packConfidenceTexel, unpackConfidenceTexel, type BakedTexturePlanes } from '../src/common/spatial/texture-pass-contracts';
import { delightLinearRgb, linearToSrgb255, SRGB8_TO_LINEAR } from '../src/common/spatial/photogrammetric-delight';
import {
    loadTileSurface, mergeBakedPlanes, TILE_CONFIDENCE_CAP, TILE_TRANSFER_RUNG, transferTilePhoto, transferTilePhotoFromGlb
} from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { emptyConfidencePlane, FACADE, facadeAlbedo, facadeAtlas } from './helpers/texture-pass-fixtures';
import { analyticTexture, buildTileGlb, facadeTileSheet } from './helpers/tile-photo-glb';
import { planePanel, saveStrip, scalarPanel } from './helpers/texture-tile-shots';

const SIDE = 64;
const texelUv = (i: number): [number, number] => {
    const x = i % SIDE, y = (i / SIDE) | 0;
    return [((x + 0.5) / SIDE) * FACADE.widthM, (1 - (y + 0.5) / SIDE) * FACADE.heightM];
};
const delit255 = (rgb: Vec3): Vec3 => {
    const l = delightLinearRgb(SRGB8_TO_LINEAR[Math.round(rgb[0])], SRGB8_TO_LINEAR[Math.round(rgb[1])], SRGB8_TO_LINEAR[Math.round(rgb[2])]);
    return [linearToSrgb255(l[0]), linearToSrgb255(l[1]), linearToSrgb255(l[2])];
};
const truthPanel = (colour: (u: number, v: number) => Vec3): Uint8Array => {
    const rgba = new Uint8Array(SIDE * SIDE * 4);
    for (let i = 0; i < SIDE * SIDE; i++) { const c = colour(...texelUv(i)); rgba.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], i * 4); }
    return rgba;
};

describe('tile photo transfer (tier 2)', () => {
    it('transfers an analytic textured plane onto the atlas within tolerance, labelled photo-inferred at rung 2, weight capped', async () => {
        const atlas = facadeAtlas(SIDE);
        const glb = buildTileGlb([facadeTileSheet(0.05)]);
        const raw = await transferTilePhotoFromGlb(glb, { atlas, maxDistanceM: 0.25 }, { delight: false });
        const delit = await transferTilePhotoFromGlb(glb, { atlas, maxDistanceM: 0.25 });
        let maxErrRaw = 0, maxErrDelit = 0;
        for (let i = 0; i < SIDE * SIDE; i++) {
            const t = facadeAlbedo(...texelUv(i));
            const d = delit255(t);
            for (let k = 0; k < 3; k++) {
                maxErrRaw = Math.max(maxErrRaw, Math.abs(raw.planes.albedo[i * 4 + k] - t[k]));
                maxErrDelit = Math.max(maxErrDelit, Math.abs(delit.planes.albedo[i * 4 + k] - d[k]));
            }
            const c = unpackConfidenceTexel(delit.planes.confidence, i);
            expect(c.covered).toBe(true);
            expect(c.rung).toBe(TILE_TRANSFER_RUNG);
            expect(c.weight01).toBeLessThanOrEqual(TILE_CONFIDENCE_CAP + 1e-9);
            expect(c.weight01).toBeGreaterThan(0.3);
        }
        expect(maxErrRaw).toBeLessThanOrEqual(2);
        expect(maxErrDelit).toBeLessThanOrEqual(2);
        expect(delit.planes.provenance).toHaveLength(1);
        expect(delit.planes.provenance[0]).toMatchObject({ source: 'tile-photo-transfer', label: 'photo-inferred', coverage: 1 });
        expect(delit.planes.provenance[0].method).toMatch(/de-lit \(shadowLift 0\.6, highlightCompress 0\.45\)/);
        expect(delit.planes.degradations).toEqual([]);
        expect(delit.surface.texelSizeM).toBeCloseTo(10 / 65, 3);
        saveStrip('transfer_analytic_plane', [planePanel(SIDE, SIDE, truthPanel(facadeAlbedo)), planePanel(SIDE, SIDE, raw.planes.albedo), planePanel(SIDE, SIDE, delit.planes.albedo),
            scalarPanel(SIDE, SIDE, i => unpackConfidenceTexel(delit.planes.confidence, i).weight01 / TILE_CONFIDENCE_CAP)]);
    });

    it('rejects back faces: a tile sheet wound away from the atlas normal colours nothing and is recorded', async () => {
        const atlas = facadeAtlas(SIDE);
        const sheet = { ...facadeTileSheet(0.05), facing: [0, 0, 1] as Vec3 };
        const { planes } = await transferTilePhotoFromGlb(buildTileGlb([sheet]), { atlas, maxDistanceM: 0.25 });
        let covered = 0;
        for (let i = 0; i < SIDE * SIDE; i++) if (unpackConfidenceTexel(planes.confidence, i).covered || planes.albedo[i * 4 + 3]) covered++;
        expect(covered).toBe(0);
        expect(planes.degradations).toHaveLength(1);
        expect(planes.degradations[0]).toMatchObject({ reasonCode: 'tile_surface_out_of_range', fromRung: 2, toRung: 3, texelShare: 1 });
        expect(planes.degradations[0].reason).toMatch(/4096 texels had no tile surface within 0.25 m facing the same way/);
    });

    it('takes the facing skin of a thin wall even when the far skin is nearer, and the angle gate is what decides', async () => {
        const atlas = facadeAtlas(SIDE);
        const red = (): Vec3 => [220, 20, 20];
        // Outer skin 0.08 m toward the street (faces the street, true photo); inner skin 0.03 m behind (faces in, red).
        const inner = { ...facadeTileSheet(-0.03, red), facing: [0, 0, 1] as Vec3 };
        const glb = buildTileGlb([facadeTileSheet(0.08), inner]);
        const gated = await transferTilePhotoFromGlb(glb, { atlas, maxDistanceM: 0.25 }, { delight: false });
        const ungated = await transferTilePhotoFromGlb(glb, { atlas, maxDistanceM: 0.25 }, { delight: false, maxNormalAngleDeg: 180 });
        let wrongGated = 0, wrongUngated = 0;
        for (let i = 0; i < SIDE * SIDE; i++) {
            if (gated.planes.albedo[i * 4] > 200 && gated.planes.albedo[i * 4 + 1] < 40) wrongGated++;
            if (ungated.planes.albedo[i * 4] > 200 && ungated.planes.albedo[i * 4 + 1] < 40) wrongUngated++;
            const t = facadeAlbedo(...texelUv(i));
            expect(Math.abs(gated.planes.albedo[i * 4 + 1] - t[1])).toBeLessThanOrEqual(2);
        }
        expect(wrongGated).toBe(0);
        expect(wrongUngated).toBe(SIDE * SIDE); // without the normal gate the nearer, wrong skin answers
        saveStrip('transfer_thin_wall', [planePanel(SIDE, SIDE, gated.planes.albedo), planePanel(SIDE, SIDE, ungated.planes.albedo)]);
    });

    it('de-lighting lifts known shadowed texels by the shared formula and leaves mid tones alone', async () => {
        const atlas = facadeAtlas(SIDE);
        // A baked shadow: the lower 2 m of the facade at 30 percent of the light.
        const lit = (u: number, v: number): Vec3 => { const c = facadeAlbedo(u, v); const k = v < 2 ? 0.3 : 1; return [c[0] * k, c[1] * k, c[2] * k]; };
        const glb = buildTileGlb([facadeTileSheet(0.05, lit)]);
        const raw = await transferTilePhotoFromGlb(glb, { atlas, maxDistanceM: 0.25 }, { delight: false });
        const delit = await transferTilePhotoFromGlb(glb, { atlas, maxDistanceM: 0.25 });
        const lumaLin = (a: Uint8Array, i: number) => 0.299 * SRGB8_TO_LINEAR[a[i * 4]] + 0.587 * SRGB8_TO_LINEAR[a[i * 4 + 1]] + 0.114 * SRGB8_TO_LINEAR[a[i * 4 + 2]];
        let shadowed = 0, mid = 0;
        for (let i = 0; i < SIDE * SIDE; i++) {
            const [, v] = texelUv(i);
            if (Math.abs(v - 2) < 0.3) continue; // bilinear blend across the shadow edge
            const rawL = lumaLin(raw.planes.albedo, i), outL = lumaLin(delit.planes.albedo, i);
            const expected = delit255([raw.planes.albedo[i * 4], raw.planes.albedo[i * 4 + 1], raw.planes.albedo[i * 4 + 2]]);
            for (let k = 0; k < 3; k++) expect(Math.abs(delit.planes.albedo[i * 4 + k] - expected[k])).toBeLessThanOrEqual(2);
            if (v < 2) { shadowed++; expect(outL - rawL).toBeGreaterThan(0.02); }
            if (rawL >= 1 / 2.2 + 0.01 && rawL <= 0.59) { mid++; for (let k = 0; k < 3; k++) expect(Math.abs(delit.planes.albedo[i * 4 + k] - raw.planes.albedo[i * 4 + k])).toBeLessThanOrEqual(1); }
        }
        expect(shadowed).toBeGreaterThan(500);
        expect(mid).toBeGreaterThan(100);
        saveStrip('transfer_delight_shadow', [planePanel(SIDE, SIDE, raw.planes.albedo), planePanel(SIDE, SIDE, delit.planes.albedo)]);
    });

    it('fusion with tier 1 never softens: sharp or multi-view texels stay byte-identical, the tile fills holes and soft low-weight texels', async () => {
        const atlas = facadeAtlas(SIDE);
        const surface = loadTileSurface(buildTileGlb([facadeTileSheet(0.05)]));
        // Tier 1: columns 0..15 sharp single view (2-texel stripes, weight 0.2), 16..31 soft single view (flat, 0.2),
        // 32..47 multi-view (flat, weight 0.1), 48..63 uncovered.
        const existing: BakedTexturePlanes = {
            layerKey: 'fit', width: SIDE, height: SIDE, albedo: new Uint8Array(SIDE * SIDE * 4), confidence: emptyConfidencePlane(SIDE, SIDE),
            provenance: [{ source: 'street-view-projection', label: 'photo-inferred', method: 'synthetic tier 1', panoIds: ['pano-front'], coverage: 0.75 }],
            degradations: []
        };
        for (let i = 0; i < SIDE * SIDE; i++) {
            const x = i % SIDE, y = (i / SIDE) | 0;
            if (x >= 48) continue;
            const t = facadeAlbedo(...texelUv(i));
            const c: Vec3 = x < 16 ? (((x >> 1) & 1) ? t.map(c => Math.min(255, c + 40)) as Vec3 : t.map(c => Math.max(0, c - 40)) as Vec3) : [120, 120, 120];
            existing.albedo.set([c[0], c[1], c[2], 255], i * 4);
            packConfidenceTexel(existing.confidence, i, 0, x < 32 ? 0.2 : 0.1, x < 32 ? 1 : 0);
        }
        const tile = await transferTilePhoto({ atlas, tileSample: surface.sample, maxDistanceM: 0.25, existing });
        const merged = mergeBakedPlanes(existing, tile);
        const lum = (a: Uint8Array, i: number) => 0.2126 * a[i * 4] + 0.7152 * a[i * 4 + 1] + 0.0722 * a[i * 4 + 2];
        const sobel = (a: Uint8Array, i: number) => {
            const x = i % SIDE, y = (i / SIDE) | 0; if (x < 1 || y < 1 || x >= SIDE - 1 || y >= SIDE - 1) return 0;
            const L = (dx: number, dy: number) => lum(a, (y + dy) * SIDE + x + dx);
            const gx = L(1, -1) + 2 * L(1, 0) + L(1, 1) - L(-1, -1) - 2 * L(-1, 0) - L(-1, 1), gy = L(-1, 1) + 2 * L(0, 1) + L(1, 1) - L(-1, -1) - 2 * L(0, -1) - L(1, -1);
            return gx * gx + gy * gy;
        };
        let sharpBefore = 0, sharpAfter = 0;
        for (let i = 0; i < SIDE * SIDE; i++) {
            const x = i % SIDE;
            const before = Array.from(existing.albedo.subarray(i * 4, i * 4 + 4)), after = Array.from(merged.albedo.subarray(i * 4, i * 4 + 4));
            const m = unpackConfidenceTexel(merged.confidence, i);
            if (x < 16 || (x >= 32 && x < 48)) { expect(after).toEqual(before); expect(m.provenanceIndex).toBe(0); }
            if (x >= 18 && x < 30) { expect(tile.albedo[i * 4 + 3]).toBe(255); expect(m.provenanceIndex).toBe(1); expect(m.rung).toBe(TILE_TRANSFER_RUNG); }
            if (x >= 48) { expect(m.covered).toBe(true); expect(m.provenanceIndex).toBe(1); }
            if (x >= 2 && x < 14) { sharpBefore += sobel(existing.albedo, i); sharpAfter += sobel(merged.albedo, i); }
        }
        expect(sharpAfter).toBe(sharpBefore);
        expect(merged.provenance.map(p => p.source)).toEqual(['street-view-projection', 'tile-photo-transfer']);
        expect(Math.abs(merged.provenance[0].coverage - 0.5)).toBeLessThanOrEqual(3 / 64 + 1e-9);
        expect(merged.provenance[0].coverage + merged.provenance[1].coverage).toBeCloseTo(1, 6);
        saveStrip('transfer_fusion_never_softens', [planePanel(SIDE, SIDE, existing.albedo), planePanel(SIDE, SIDE, tile.albedo), planePanel(SIDE, SIDE, merged.albedo),
            scalarPanel(SIDE, SIDE, i => unpackConfidenceTexel(merged.confidence, i).provenanceIndex, i => unpackConfidenceTexel(merged.confidence, i).covered)]);
    });

    it('is deterministic: identical bytes over two runs, and independent of tile triangle order', async () => {
        const atlas = facadeAtlas(SIDE);
        const sheetA = facadeTileSheet(0.05);
        const sheetB = { ...facadeTileSheet(0.06, () => [10, 10, 10] as Vec3), origin: [0, 0, -0.06] as Vec3, widthM: 3, heightM: 3, texture: analyticTexture(3, 3, 0.154, () => [10, 10, 10]) };
        const hash = (p: BakedTexturePlanes) => createHash('sha256').update(p.albedo).update(p.confidence.data).update(JSON.stringify(p.provenance)).digest('hex');
        const a = await transferTilePhotoFromGlb(buildTileGlb([sheetA, sheetB]), { atlas, maxDistanceM: 0.25 });
        const b = await transferTilePhotoFromGlb(buildTileGlb([sheetA, sheetB]), { atlas, maxDistanceM: 0.25 });
        const c = await transferTilePhotoFromGlb(buildTileGlb([sheetB, sheetA]), { atlas, maxDistanceM: 0.25 });
        expect(hash(a.planes)).toBe(hash(b.planes));
        expect(Buffer.from(c.planes.albedo).equals(Buffer.from(a.planes.albedo))).toBe(true);
    });

    it('stops on an aborted signal', async () => {
        const surface = loadTileSurface(buildTileGlb([facadeTileSheet(0.05)]));
        const ctl = new AbortController(); ctl.abort();
        await expect(transferTilePhoto({ atlas: facadeAtlas(SIDE), tileSample: surface.sample, maxDistanceM: 0.25, signal: ctl.signal })).rejects.toThrow();
    });
});
