/**
 * The repeat-fill rung ported onto pipeline E's own, simpler texture ladder (face-textures.ts: tile-ortho ->
 * nearest-fill -> facade-median, docs/processes/texture_repeat_inference.md section 5). `repeatFillFace`
 * (face-texture-repeat.ts) wraps a single FaceTexture as the UvAtlas/BakedTexturePlanes contracts `texture-repeat.ts`
 * already runs for texture-pass.ts, so the same gated statistics decide whether to fill - not a reimplementation.
 * Synthetic face textures only (no network, no model, no native build).
 */
import { describe, expect, it } from 'vitest';
import { TEXTURE_LADDER_RUNGS } from '../src/common/spatial/texture-pass-contracts';
import { SRC, textureFromOrtho } from '../src/node/3d-engine/staged-location/pipeline-e/face-textures';
import { repeatFillFace, RUNG_REPEATED } from '../src/node/3d-engine/staged-location/pipeline-e/face-texture-repeat';
import type { FaceTexture } from '../src/node/3d-engine/staged-location/pipeline-e/massing-glb';
import type { FaceOrtho } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';

const PIXEL_M = 0.1; // 10 texels/metre

/** A square-wave banded ortho (width x height), with the given rows dropped (alpha 0, as the native tool leaves an uncovered texel). */
function bandedOrtho(width: number, height: number, pitchRows: number, dropRows: Set<number>): FaceOrtho {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const grey = Math.floor(y / (pitchRows / 2)) % 2 === 0 ? 40 : 200;
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (dropRows.has(y)) continue; // alpha stays 0: textureFromOrtho reads this as uncovered
            rgba.set([grey, grey, grey, 255], i * 4);
        }
    }
    return { width, height, rgba, depth: new Float32Array(width * height), prot: new Float32Array(width * height) };
}

/** A pseudo-random, non-periodic ortho (the Jefferson Market cautionary case, reproduced synthetically). */
function noisyOrtho(width: number, height: number, dropRows: Set<number>): FaceOrtho {
    const rgba = new Uint8Array(width * height * 4);
    let seed = 7;
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (dropRows.has(y)) continue;
            const grey = Math.floor(rand() * 220) + 20;
            rgba.set([grey, grey, grey, 255], i * 4);
        }
    }
    return { width, height, rgba, depth: new Float32Array(width * height), prot: new Float32Array(width * height) };
}

describe('face-texture-repeat.ts: the rung ported onto pipeline E\'s own ladder', () => {
    it('fills same-plane texels a FaceTexture never covered, from a genuinely periodic face, labelled with the ladder\'s repeat rung', () => {
        const width = 24, height = 60, pitchRows = 10;
        const dropped = new Set<number>();
        for (let y = 20; y < 25; y++) dropped.add(y); // 5 consecutive rows the tile ortho never saw
        const t = textureFromOrtho(bandedOrtho(width, height, pitchRows, dropped), PIXEL_M);
        expect([...dropped].every(y => Array.from({ length: width }, (_, x) => t.source[y * width + x] === 255).every(Boolean))).toBe(true);

        const r = repeatFillFace(t, PIXEL_M);
        expect(r.filled).toBeGreaterThan(0);
        expect(r.filled).toBe(width * dropped.size);
        for (const y of dropped) for (let x = 0; x < width; x++) {
            const i = y * width + x;
            expect(t.source[i]).toBe(SRC.repeatFill);
            expect(t.rgba[i * 4 + 3]).toBe(255);
        }
        // never SRC.tileOrtho: a filled texel must never be read back downstream as a real, measured photo texel
        expect([...dropped].some(y => t.source[y * width] === SRC.tileOrtho)).toBe(false);
    });

    it('refuses on a genuinely irregular (non-periodic) face, leaving the gap for fillNearest/facadeMedian', () => {
        const width = 24, height = 60;
        const dropped = new Set<number>();
        for (let y = 20; y < 25; y++) dropped.add(y);
        const t = textureFromOrtho(noisyOrtho(width, height, dropped), PIXEL_M);
        const r = repeatFillFace(t, PIXEL_M);
        expect(r.filled).toBe(0);
        expect(r.degradations.length).toBeGreaterThan(0);
        expect(r.degradations[0].reasonCode).toBe('repeat_not_detected');
        for (const y of dropped) for (let x = 0; x < width; x++) expect(t.source[y * width + x]).toBe(255); // still open for the next rung
    });

    it('never fills a texel the tile ortho already covered (idempotent, never overwrites real data)', () => {
        const width = 24, height = 60, pitchRows = 10;
        const t = textureFromOrtho(bandedOrtho(width, height, pitchRows, new Set()), PIXEL_M);
        const before = t.rgba.slice();
        const r = repeatFillFace(t, PIXEL_M);
        expect(r.filled).toBe(0);
        expect(t.rgba).toEqual(before);
    });

    it('RUNG_REPEATED matches the shared ladder\'s "repeated same-plane fill" index (same rung texture-pass.ts uses)', () => {
        expect(RUNG_REPEATED).toBe(TEXTURE_LADDER_RUNGS.indexOf('repeated same-plane fill'));
        expect(RUNG_REPEATED).toBeGreaterThan(TEXTURE_LADDER_RUNGS.indexOf('tile photo transfer'));
        expect(RUNG_REPEATED).toBeLessThan(TEXTURE_LADDER_RUNGS.indexOf('measured palette colour'));
    });
});
