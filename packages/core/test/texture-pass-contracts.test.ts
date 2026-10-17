/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/** Texture pass contracts: the schema accepts the valid records and rejects the dishonest ones; the replay rig is self-consistent. */

import { describe, expect, it } from 'vitest';
import { validateContract } from '../src/common/spatial/staged-location-contracts';
import {
    TEXTURE_LADDER_RUNGS, TEXTURE_RUNG_CLAY, packConfidenceTexel, unpackConfidenceTexel
} from '../src/common/spatial/texture-pass-contracts';
import {
    FACADE, emptyConfidencePlane, facadeAlbedo, facadeAtlas, facadeViews, projectPoint, textureLayerBundle, texturePassRecord
} from './helpers/texture-pass-fixtures';

describe('texture pass schema', () => {
    it('accepts the valid bundle and record', () => {
        expect(validateContract('TextureLayerBundle', textureLayerBundle())).toEqual([]);
        expect(validateContract('TexturePassRecord', texturePassRecord())).toEqual([]);
    });

    it('accepts a source and label the code has never seen (open literals)', () => {
        const b = textureLayerBundle();
        b.provenance[0] = { ...b.provenance[0], source: 'lidar-colour-sweep', label: 'sensor-inferred' };
        expect(validateContract('TextureLayerBundle', b)).toEqual([]);
    });

    it.each([
        ['empty provenance list', (b: any) => { b.provenance = []; }],
        ['coverage above 1', (b: any) => { b.provenance[0].coverage = 1.2; }],
        ['empty label', (b: any) => { b.provenance[0].label = ''; }],
        ['atlas rect with three numbers', (b: any) => { b.uv[0].atlasRect = [0, 0, 1]; }],
        ['zero texel density', (b: any) => { b.uv[0].texelsPerMeter = 0; }],
        ['missing confidence plane ref', (b: any) => { delete b.confidence; }],
        ['negative rung', (b: any) => { b.ladderRung = -1; }]
    ])('rejects %s with a message', (_t, mutate) => {
        const b: any = textureLayerBundle();
        mutate(b);
        expect(validateContract('TextureLayerBundle', b).length).toBeGreaterThan(0);
    });

    it('rejects a degradation without a real reason', () => {
        const r: any = texturePassRecord();
        r.degradations[0].reason = '';
        expect(validateContract('TexturePassRecord', r).length).toBeGreaterThan(0);
    });
});

describe('texture pass shared helpers', () => {
    it('round-trips a confidence texel', () => {
        const plane = emptyConfidencePlane(4, 4);
        packConfidenceTexel(plane, 5, 2, 0.5, 3);
        expect(unpackConfidenceTexel(plane, 5)).toEqual({ provenanceIndex: 2, weight01: 128 / 255, rung: 3, covered: true });
        expect(unpackConfidenceTexel(plane, 6).covered).toBe(false);
    });

    it('ends the ladder at clay', () => {
        expect(TEXTURE_LADDER_RUNGS[TEXTURE_RUNG_CLAY]).toBe('clay');
    });
});

describe('replay rig (synthesised, no image bytes committed)', () => {
    it('is deterministic', () => {
        const a = facadeViews()[0].image.rgba, b = facadeViews()[0].image.rgba;
        expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    });

    it('projects every atlas texel to the colour the analytic albedo has, in every view that sees it', () => {
        const atlas = facadeAtlas(16);
        for (const view of facadeViews()) {
            let checked = 0;
            for (let i = 0; i < atlas.width * atlas.height; i++) {
                const p: [number, number, number] = [atlas.texels.position[i * 3], atlas.texels.position[i * 3 + 1], atlas.texels.position[i * 3 + 2]];
                const { x, y, depth } = projectPoint(view.camera, p);
                if (depth <= 0 || x < 1 || y < 1 || x > view.camera.width - 2 || y > view.camera.height - 2) continue;
                const px = Math.floor(x), py = Math.floor(y);
                const o = (py * view.camera.width + px) * 4;
                const truth = facadeAlbedo(p[0] - FACADE.origin[0], p[1] - FACADE.origin[1]);
                // a pixel spans well under a metre here and the albedo gradient is at most 15 per metre
                const pixelM = (depth / view.camera.fx) * 1.5;
                for (let c = 0; c < 3; c++) expect(Math.abs(view.image.rgba[o + c] - truth[c])).toBeLessThanOrEqual(20 * pixelM + 1);
                checked++;
            }
            expect(checked, view.panoId).toBeGreaterThan(100);
        }
    });
});
