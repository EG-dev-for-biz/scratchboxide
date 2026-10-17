/**
 * Integration fixes between the projection bake (C) and the tile transfer (D):
 *  - C's pose-uncertainty term saturates on the surface instead of underflowing in image pixels, so a single-view
 *    Street View texel at the live ~1.3 m registration residual keeps a usable confidence;
 *  - D keeps a Street View texel unless the tile is BOTH more confident AND sharper there.
 */
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../src/common/spatial/staged-location-contracts';
import { packConfidenceTexel, unpackConfidenceTexel, type BakedTexturePlanes } from '../src/common/spatial/texture-pass-contracts';
import { bakeStreetViewProjection, poseSigmaTerm, POSE_SIGMA_SCALE_M } from '../src/node/3d-engine/staged-location/texture-projection';
import { linearToSrgb255, SRGB8_TO_LINEAR } from '../src/common/spatial/photogrammetric-delight';
import { depthForMesh, poseQualityFromResidual } from '../src/node/3d-engine/staged-location/texture-projection-views';
import { loadTileSurface, TILE_CONFIDENCE_CAP, transferTilePhoto } from '../src/node/3d-engine/staged-location/tile-texture-transfer';
import { emptyConfidencePlane, FACADE, facadeAlbedo, facadeAtlas, facadeViews } from './helpers/texture-pass-fixtures';
import { buildTileGlb, facadeTileSheet } from './helpers/tile-photo-glb';

const SIDE = 64;
const texelUv = (i: number): [number, number] => {
    const x = i % SIDE, y = (i / SIDE) | 0;
    return [((x + 0.5) / SIDE) * FACADE.widthM, (1 - (y + 0.5) / SIDE) * FACADE.heightM];
};

describe('pose sigma term', () => {
    it('measures the pose error on the surface and saturates instead of underflowing', () => {
        const fx = 1663; // 1920 px at 60 degrees
        const residualM = 1.3;
        for (const z of [8, 20, 40]) {
            const gsd = z / fx; // frontal
            // the old image-pixel form exp(-(fx r / z / 3)^2) is ~0 at every one of these distances
            expect(Math.exp(-(((fx * residualM / z) / 3) ** 2))).toBeLessThan(1e-12);
            // the surface form: ~1 / (1 + (1.3 / 2)^2) = 0.70 at any distance, frontal
            expect(poseSigmaTerm(fx * residualM, z, gsd)).toBeCloseTo(1 / (1 + (residualM / POSE_SIGMA_SCALE_M) ** 2), 6);
        }
        // oblique (cos 0.5): twice the shift on the surface, lower but not collapsed
        expect(poseSigmaTerm(fx * residualM, 20, 20 / (fx * 0.5))).toBeCloseTo(1 / (1 + (2.6 / 2) ** 2), 6);
        // monotone in the error, never zero for a finite error
        expect(poseSigmaTerm(fx * 4, 20, 20 / fx)).toBeLessThan(poseSigmaTerm(fx * 1.3, 20, 20 / fx));
        expect(poseSigmaTerm(fx * 20, 20, 20 / fx)).toBeGreaterThan(0);
        expect(poseSigmaTerm(0, 20, 20 / fx)).toBe(1);
        // a frontal single-view texel at the live residual sits above the tile's cap
        expect(poseQualityFromResidual(residualM) * poseSigmaTerm(fx * residualM, 20, 20 / fx)).toBeGreaterThan(TILE_CONFIDENCE_CAP);
    });
});

describe('tile fusion keeps Street View unless the tile is more confident AND sharper', () => {
    it('keeps confident soft texels, replaces near-zero-weight soft ones where the tile is sharper, keeps near-zero-weight sharp ones', async () => {
        const atlas = facadeAtlas(SIDE);
        const surface = loadTileSurface(buildTileGlb([facadeTileSheet(0.05)]));
        const liveWeight = poseQualityFromResidual(1.3) * poseSigmaTerm(1663 * 1.3, 20, 20 / 1663);
        // columns 0..21: soft (flat) single view at the live weight; 22..42: soft single view at weight 0.01;
        // 43..63: sharp (4-texel checker, high contrast) single view at weight 0.01
        const existing: BakedTexturePlanes = {
            layerKey: 'fit', width: SIDE, height: SIDE, albedo: new Uint8Array(SIDE * SIDE * 4), confidence: emptyConfidencePlane(SIDE, SIDE),
            provenance: [{ source: 'street-view-projection', label: 'photo-inferred', method: 'synthetic single view', panoIds: ['p'], coverage: 1 }],
            degradations: []
        };
        for (let i = 0; i < SIDE * SIDE; i++) {
            const x = i % SIDE, y = (i / SIDE) | 0;
            const c: Vec3 = x < 43 ? [120, 120, 120] : ((((x >> 1) + (y >> 1)) & 1) ? [235, 235, 235] : [15, 15, 15]);
            existing.albedo.set([c[0], c[1], c[2], 255], i * 4);
            packConfidenceTexel(existing.confidence, i, 0, x < 22 ? liveWeight : 0.01, 1);
        }
        const tile = await transferTilePhoto({ atlas, tileSample: surface.sample, maxDistanceM: 0.25, existing });
        let keptLive = 0, liveN = 0, replacedSoft = 0, softN = 0, keptSharp = 0, sharpN = 0;
        for (let i = 0; i < SIDE * SIDE; i++) {
            const x = i % SIDE, y = (i / SIDE) | 0;
            if (x < 1 || y < 1 || x > SIDE - 2 || y > SIDE - 2) continue;
            const took = tile.albedo[i * 4 + 3] === 255;
            if (x < 21) { liveN++; if (!took) keptLive++; }
            else if (x > 23 && x < 41) { softN++; if (took) replacedSoft++; }
            else if (x > 44) { sharpN++; if (!took) keptSharp++; }
        }
        // the live-residual weight beats the tile's cap: never replaced
        expect(keptLive).toBe(liveN);
        // a near-zero-weight flat texel gives way where the tile has detail (the facade pattern)
        expect(replacedSoft / softN).toBeGreaterThan(0.2);
        // a near-zero-weight but sharper Street View texel is kept: the tile is more confident but not sharper there
        expect(keptSharp / sharpN).toBeGreaterThan(0.95);
        for (let i = 0; i < SIDE * SIDE; i++) if (tile.albedo[i * 4 + 3]) expect(unpackConfidenceTexel(tile.confidence, i).weight01).toBeLessThanOrEqual(TILE_CONFIDENCE_CAP + 1e-9);
    });
});

describe('tile exposure match and the observed-surface check', () => {
    it('matches the tile photo exposure to the Street View texels where both cover', async () => {
        const atlas = facadeAtlas(SIDE);
        // the tile photo is 60 percent as bright (linear) as the Street View texels of the same surface
        const dim = (u: number, v: number): Vec3 => facadeAlbedo(u, v).map(c => linearToSrgb255(SRGB8_TO_LINEAR[Math.round(c)] * 0.6)) as Vec3;
        const surface = loadTileSurface(buildTileGlb([facadeTileSheet(0.05, dim)]), { delight: false });
        const existing: BakedTexturePlanes = {
            layerKey: 'fit', width: SIDE, height: SIDE, albedo: new Uint8Array(SIDE * SIDE * 4), confidence: emptyConfidencePlane(SIDE, SIDE),
            provenance: [{ source: 'street-view-projection', label: 'photo-inferred', method: 'synthetic', coverage: 0.5 }], degradations: []
        };
        // Street View holds the left half (multi-view, never replaced); the right half is uncovered for the tile to fill
        for (let i = 0; i < SIDE * SIDE; i++) {
            if (i % SIDE >= SIDE / 2) continue;
            const c = facadeAlbedo(...texelUv(i));
            existing.albedo.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], i * 4);
            packConfidenceTexel(existing.confidence, i, 0, 0.9, 0);
        }
        const run = (matchExposure: boolean) => transferTilePhoto({ atlas, tileSample: surface.sample, surface, maxDistanceM: 0.25, existing, matchExposure } as any);
        const matched = await run(true), raw = await run(false);
        let errMatched = 0, errRaw = 0, n = 0;
        for (let i = 0; i < SIDE * SIDE; i++) {
            if (i % SIDE < SIDE / 2 + 2 || !matched.albedo[i * 4 + 3]) continue;
            const t = facadeAlbedo(...texelUv(i));
            for (let c = 0; c < 3; c++) { errMatched += Math.abs(matched.albedo[i * 4 + c] - t[c]); errRaw += Math.abs(raw.albedo[i * 4 + c] - t[c]); }
            n += 3;
        }
        expect(errRaw / n).toBeGreaterThan(15);
        expect(errMatched / n).toBeLessThan(3);
        expect(matched.provenance[0].method).toMatch(/exposure matched to the Street View texels \(linear gain 1\.6\d\/1\.6\d\/1\.6\d\)/);
    });

    it('drops samples of texels the photo sees past (a face where the scan has no surface)', async () => {
        const atlas = facadeAtlas(32);
        // the texels float 2 m in front of the only scanned surface (the facade at z = 0): an opening the fit closed
        for (let i = 0; i < 32 * 32; i++) atlas.texels.position[i * 3 + 2] -= 2;
        const facade = { vertices: Float32Array.from([0, 0, 0, 10, 0, 0, 10, 6, 0, 0, 6, 0]), indices: Uint32Array.from([0, 2, 1, 0, 3, 2]) };
        const views = facadeViews().map(v => ({ ...v, poseQuality: 1, poseSigmaPx: 0 }));
        const open = await bakeStreetViewProjection({ atlas, views, depthFor: depthForMesh(facade) });
        const checked = await bakeStreetViewProjection({ atlas, views, depthFor: depthForMesh(facade), options: { observedSurface: { baseM: 0.5, perMeter: 0.03 } } });
        expect(open.report.bakedTexels).toBeGreaterThan(200);
        expect(checked.report.bakedTexels).toBe(0);
        // a texel on the scanned surface is kept by the check
        const onSurface = facadeAtlas(32);
        const kept = await bakeStreetViewProjection({ atlas: onSurface, views, depthFor: depthForMesh(facade), options: { observedSurface: { baseM: 0.5, perMeter: 0.03 } } });
        expect(kept.report.bakedTexels).toBeGreaterThan(200);
    });
});
