/**
 * paletteFill (texture-pass.ts): when a tall structure's survey carries several palettes at the same heading, one per
 * height band (footprintSurveyFaces splits a heading into bands for anything tall enough), the fallback fill must pick
 * the band whose height actually covers the texel — not whichever same-heading band happens to iterate last. Found on
 * the Empire State Building (2026-10-24): granite-base and steel-crown palettes bleeding onto mid-shaft limestone
 * texels, visible as patches breaking the window grid.
 */
import { describe, expect, it } from 'vitest';
import { paletteFill, type PaletteFace } from '../src/node/3d-engine/staged-location/texture-pass';
import type { BakedTexturePlanes } from '../src/common/spatial/texture-pass-contracts';

/** A 1x3 atlas, one texel per row, all facing heading 180 (headingOf([nx,nz]) = atan2(nx,-nz): (0,0,1) is 180), at
 *  ground/mid/crown heights. */
function atlasAt(ys: number[]): any {
    const n = ys.length;
    const covered = new Uint8Array(n).fill(1), gutter = new Uint8Array(n);
    const normal = new Float32Array(n * 3), position = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
        normal[i * 3] = 0; normal[i * 3 + 1] = 0; normal[i * 3 + 2] = 1; // heading 180
        position[i * 3] = 0; position[i * 3 + 1] = ys[i]; position[i * 3 + 2] = 0;
    }
    return { layerKey: 'l', width: n, height: 1, texels: { covered, gutter, normal, position } };
}

function uncoveredBase(n: number): BakedTexturePlanes {
    return { layerKey: 'l', width: n, height: 1, albedo: new Uint8Array(n * 4), confidence: { width: n, height: 1, data: new Uint8Array(n * 4) }, provenance: [], degradations: [] };
}

describe('paletteFill: height-banded palettes at the same heading', () => {
    it('picks the band whose height actually covers the texel, not whichever same-heading band iterates last', () => {
        const faces: PaletteFace[] = [
            { headingDeg: 180, centreY: 10, heightM: 20, colours: [{ srgb: [120, 110, 100], share: 1 }] },  // base: granite-ish, y 0-20
            { headingDeg: 180, centreY: 50, heightM: 20, colours: [{ srgb: [210, 200, 180], share: 1 }] },  // shaft: limestone, y 40-60
            { headingDeg: 180, centreY: 90, heightM: 20, colours: [{ srgb: [200, 205, 210], share: 1 }] }   // crown: steel, y 80-100
        ];
        const atlas = atlasAt([10, 50, 90]);
        const out = paletteFill(atlas, uncoveredBase(3), faces);
        expect([out.albedo[0], out.albedo[1], out.albedo[2]]).toEqual([120, 110, 100]);
        expect([out.albedo[4], out.albedo[5], out.albedo[6]]).toEqual([210, 200, 180]);
        expect([out.albedo[8], out.albedo[9], out.albedo[10]]).toEqual([200, 205, 210]);
    });

    it('falls back to nearest heading when no band contains the texel height (a gap between bands)', () => {
        const faces: PaletteFace[] = [
            { headingDeg: 180, centreY: 10, heightM: 10, colours: [{ srgb: [120, 110, 100], share: 1 }] },
            { headingDeg: 170, centreY: 50, heightM: 10, colours: [{ srgb: [210, 200, 180], share: 1 }] }
        ];
        // y=30 falls in neither band's range; neither is in-band, so nearest heading wins: 180 (0 deg off) over 170 (10 deg off)
        const atlas = atlasAt([30]);
        const out = paletteFill(atlas, uncoveredBase(1), faces);
        expect([out.albedo[0], out.albedo[1], out.albedo[2]]).toEqual([120, 110, 100]);
    });

    it('keeps the ordinary single-palette-per-heading behaviour unchanged (no centreY/heightM given)', () => {
        const faces: PaletteFace[] = [{ headingDeg: 180, colours: [{ srgb: [182, 170, 150], share: 0.7 }, { srgb: [90, 80, 70], share: 0.3 }] }];
        const atlas = atlasAt([5]);
        const out = paletteFill(atlas, uncoveredBase(1), faces);
        expect([out.albedo[0], out.albedo[1], out.albedo[2]]).toEqual([182, 170, 150]);
    });
});
