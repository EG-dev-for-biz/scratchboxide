/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, expect, it } from 'vitest';
import { ARTIST_FINISH, PBR_ARTIST_RULES, PBR_REFERENCE, pbrReferenceLines } from '../src/common/spatial/pbr-artist-reference';

describe('the texture artist reference', () => {
    it('holds ranges within 0..1, metalness 0 or 1, and a source for every finish', () => {
        for (const e of PBR_REFERENCE) {
            expect(e.roughness[0]).toBeGreaterThanOrEqual(0);
            expect(e.roughness[1]).toBeLessThanOrEqual(1);
            expect(e.roughness[0]).toBeLessThan(e.roughness[1]);
            expect([0, 1]).toContain(e.metalness);
            expect(e.source.length).toBeGreaterThan(10);
        }
    });

    it('keeps exterior masonry rough and glass smooth, and its frames between the two', () => {
        const range = (re: RegExp) => PBR_REFERENCE.find(e => re.test(e.look))!.roughness;
        for (const re of [/limestone/, /concrete/, /render/, /brick/]) expect(range(re)[0]).toBeGreaterThanOrEqual(0.7);
        expect(range(/window glass in place/)[1]).toBeLessThanOrEqual(0.15);
        expect(range(/painted or powder-coated/)[0]).toBe(ARTIST_FINISH.frameRoughness);
        // paint, patina and rust over metal are dielectrics
        for (const re of [/painted or powder-coated/, /patina/, /rust/]) expect(PBR_REFERENCE.find(e => re.test(e.look))!.metalness).toBe(0);
    });

    it('is told as prompt lines: every finish and every rule', () => {
        const lines = pbrReferenceLines();
        expect(lines.length).toBe(PBR_REFERENCE.length + PBR_ARTIST_RULES.length + 2);
        expect(lines).toContain('- dressed limestone or sandstone, weathered ashlar, sawn or tooled stone: roughness 0.7-0.95, metalness 0');
    });
});
