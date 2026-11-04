/**
 * Every texel a pipeline E layer is written with has a source (pipeline-e.ts `closeUnsourcedTexels`, run by
 * writeMassingLayer). Before it, a texel no stage wrote reached packFaces with source 255: packed as the clay rung over
 * whatever RGB it held, black where nothing wrote it (relief's reframeTexture gaps, inference's reframe of a face its
 * parent does not reach), the masked photo where an occluder mask covered a whole wall (inference's last fillNearest had
 * nothing to grow from). Synthetic face textures only (no network, no model, no native build).
 */
import { describe, expect, it } from 'vitest';
import { baseLegend, SRC, textureFromOrtho } from '../src/node/3d-engine/staged-location/pipeline-e/face-textures';
import { packFaces, type FaceTexture, type TexelSource } from '../src/node/3d-engine/staged-location/pipeline-e/massing-glb';
import type { FaceOrtho, MassingFace, MassingRun } from '../src/node/3d-engine/staged-location/pipeline-e/native-massing';
import { closeUnsourcedTexels, UNSOURCED_LEGEND } from '../src/node/3d-engine/staged-location/pipeline-e/pipeline-e';

const PIXEL_M = 0.1;

function runOf(faces: Array<Pick<MassingFace, 'index' | 'kind' | 'part'>>): MassingRun {
    return { report: { faces: faces.map(f => ({ ...f, pixel: PIXEL_M, width: 1, height: 1, coverage: 1 })) } } as unknown as MassingRun;
}

/** A face every texel of which has source `source` and colour `rgb`. */
function flat(width: number, height: number, rgb: [number, number, number], source: number): FaceTexture {
    const t: FaceTexture = { width, height, rgba: new Uint8Array(width * height * 4), source: new Uint8Array(width * height).fill(source) };
    for (let i = 0; i < width * height; i++) t.rgba.set([...rgb, 255], i * 4);
    return t;
}

/** A banded ortho (rows alternate dark and light at `pitchRows`), the rows in `drop` uncovered (alpha 0). */
function bandedOrtho(width: number, height: number, pitchRows: number, drop: Set<number>): FaceOrtho {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        if (drop.has(y)) continue;
        const grey = Math.floor(y / (pitchRows / 2)) % 2 === 0 ? 40 : 200;
        for (let x = 0; x < width; x++) rgba.set([grey, grey, grey, 255], (y * width + x) * 4);
    }
    return { width, height, rgba, depth: new Float32Array(width * height), prot: new Float32Array(width * height) };
}

const unsourcedCount = (t: FaceTexture, legend: TexelSource[]) => t.source.reduce((n, s) => n + (s >= legend.length ? 1 : 0), 0);

describe('closeUnsourcedTexels: no texel reaches the layer without a source', () => {
    it('leaves a layer with nothing unsourced exactly as it was (same textures, same legend)', () => {
        const legend = baseLegend();
        const textures = new Map([[0, flat(8, 8, [120, 110, 100], SRC.tileOrtho)], [1, flat(4, 4, [90, 90, 90], SRC.nearestFill)]]);
        const r = closeUnsourcedTexels(runOf([{ index: 0, kind: 'wall', part: 'a' }, { index: 1, kind: 'wall', part: 'a' }]), textures, legend);
        expect(r.textures).toBe(textures);
        expect(r.legend).toBe(legend);
        expect(r.closed).toEqual({ faces: 0, repeat: 0, nearest: 0, median: 0 });
    });

    it('gives a wall whose every texel was masked its own building\'s median wall colour, labelled generated, on a copy', () => {
        const legend = baseLegend();
        // the masked wall keeps its photo (alpha 255) with no source, as inference's occluder fill leaves it
        const masked = flat(10, 6, [30, 160, 40], 255);
        const textures = new Map([
            [0, masked],
            [1, flat(10, 6, [180, 90, 60], SRC.tileOrtho)], // the same building's real wall
            [2, flat(10, 6, [60, 60, 200], SRC.tileOrtho)], // another building's
            [3, flat(10, 6, [60, 60, 200], SRC.tileOrtho)]
        ]);
        const run = runOf([{ index: 0, kind: 'wall', part: 'b1' }, { index: 1, kind: 'wall', part: 'b1' }, { index: 2, kind: 'wall', part: 'b2' }, { index: 3, kind: 'wall', part: 'b2' }]);
        const r = closeUnsourcedTexels(run, textures, legend);
        expect(r.closed).toEqual({ faces: 1, repeat: 0, nearest: 0, median: 60 });
        expect(r.legend).toEqual([...legend, UNSOURCED_LEGEND[2]]);
        expect(r.legend[legend.length].label).toBe('generated');
        const t = r.textures.get(0)!;
        for (let i = 0; i < 60; i++) {
            expect(t.source[i]).toBe(legend.length);
            expect([...t.rgba.subarray(i * 4, i * 4 + 4)]).toEqual([180, 90, 60, 255]);
        }
        // the caller's texture is untouched (it feeds later stages), the other faces are passed through as they were
        expect(masked.source.every(s => s === 255)).toBe(true);
        expect(r.textures.get(1)).toBe(textures.get(1));
    });

    it('fills a face\'s black gap from its own repeats, then its nearest texel, so packFaces packs no clay texel', () => {
        const legend = baseLegend();
        const width = 24, height = 60;
        const drop = new Set<number>();
        for (let y = 20; y < 25; y++) drop.add(y); // inside the periodic part: the repeat rung fills it
        const t = textureFromOrtho(bandedOrtho(width, height, 10, drop), PIXEL_M);
        // and a strip a re-cut face's parent texture never reached: RGB 0, source 255, as reframeTexture leaves it
        for (let x = 0; x < 3; x++) for (let y = 0; y < height; y++) { const i = y * width + x; t.source[i] = 255; t.rgba.fill(0, i * 4, i * 4 + 4); }
        const textures = new Map([[0, t]]);
        const before = packFaces(textures, legend, 256).pages[0];
        let clayBefore = 0, blackBefore = 0;
        for (let i = 0; i < before.conf.length; i += 4) if (before.rgba[i + 3] && !before.conf[i + 3]) { clayBefore++; if (!before.rgba[i] && !before.rgba[i + 1] && !before.rgba[i + 2]) blackBefore++; }
        expect(blackBefore).toBeGreaterThan(0);
        expect(clayBefore).toBe(blackBefore);

        const r = closeUnsourcedTexels(runOf([{ index: 0, kind: 'wall', part: 'a' }]), textures, legend);
        const c = r.textures.get(0)!;
        expect(unsourcedCount(c, r.legend)).toBe(0);
        expect(r.closed.faces).toBe(1);
        expect(r.closed.repeat).toBeGreaterThan(0);
        expect(r.closed.nearest).toBeGreaterThan(0);
        expect(r.closed.repeat + r.closed.nearest).toBe(width * drop.size + 3 * height - 3 * drop.size);
        expect(r.legend).toEqual([...legend, UNSOURCED_LEGEND[0], UNSOURCED_LEGEND[1]]);
        // the repeat rung put the dropped rows' bands back (dark rows dark, light rows light), labelled as the closure's repeat
        for (const y of drop) for (let x = 3; x < width; x++) {
            const i = y * width + x;
            expect(c.source[i]).toBe(legend.length);
            expect(c.rgba[i * 4]).toBe(Math.floor(y / 5) % 2 === 0 ? 40 : 200);
        }
        const after = packFaces(r.textures, r.legend, 256).pages[0];
        let clayAfter = 0, blackAfter = 0;
        for (let i = 0; i < after.conf.length; i += 4) if (after.rgba[i + 3]) { if (!after.conf[i + 3]) clayAfter++; if (!after.rgba[i] && !after.rgba[i + 1] && !after.rgba[i + 2]) blackAfter++; }
        expect(clayAfter).toBe(0);
        expect(blackAfter).toBe(0);
    });

    it('treats a source index the legend does not hold as unsourced, and numbers only the entries it used', () => {
        const legend = baseLegend();
        const t = flat(6, 6, [100, 100, 100], SRC.tileOrtho);
        t.source[7] = legend.length + 5; // an index past the legend: packFaces would pack it as clay
        t.rgba.fill(0, 7 * 4, 8 * 4);
        const blind = flat(6, 6, [0, 0, 0], 255);
        const r = closeUnsourcedTexels(runOf([{ index: 0, kind: 'wall', part: 'a' }, { index: 1, kind: 'roof', part: 'a' }]), new Map([[0, t], [1, blind]]), legend);
        expect(r.closed).toEqual({ faces: 2, repeat: 0, nearest: 1, median: 36 });
        // no repeat was used: nearest and median take the first two indices after the legend
        expect(r.legend).toEqual([...legend, UNSOURCED_LEGEND[1], UNSOURCED_LEGEND[2]]);
        expect(r.textures.get(0)!.source[7]).toBe(legend.length);
        expect([...r.textures.get(0)!.rgba.subarray(28, 32)]).toEqual([100, 100, 100, 255]);
        expect(r.textures.get(1)!.source.every(s => s === legend.length + 1)).toBe(true);
        expect([...r.textures.get(1)!.rgba.subarray(0, 4)]).toEqual([100, 100, 100, 255]);
    });

    it('with a legend that has no tile-ortho entry (pipeline G\'s), skips the repeat and fills from the nearest sourced texel', () => {
        const legend: TexelSource[] = [{ source: 'pipeline-g-read', label: 'photo-inferred', method: 'test', rung: 5, weight: 0.3 }];
        const t = flat(4, 4, [70, 80, 90], 0);
        for (let i = 8; i < 16; i++) { t.source[i] = 255; t.rgba.fill(0, i * 4, i * 4 + 4); }
        const r = closeUnsourcedTexels(runOf([{ index: 0, kind: 'wall', part: 'a' }]), new Map([[0, t]]), legend);
        expect(r.closed).toEqual({ faces: 1, repeat: 0, nearest: 8, median: 0 });
        const c = r.textures.get(0)!;
        for (let i = 8; i < 16; i++) { expect(c.source[i]).toBe(1); expect([...c.rgba.subarray(i * 4, i * 4 + 4)]).toEqual([70, 80, 90, 255]); }
    });
});
