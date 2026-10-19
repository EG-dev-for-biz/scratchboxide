/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The tree texture library (assets/textures/trees):
 * - the index loads and validates, every file it names exists (and nothing else is in the folder), within the size budget;
 * - its descriptors are sane: colours, leaf sizes, bark relief and real-world size in physical ranges;
 * - every leaf cell lies on a leaf of its atlas (the opacity map is opaque inside it), and a card's coordinates map into
 *   its cell with the leaf's base at the card's base (leafAtlasUv, the mapping the viewport's shader runs);
 * - nothing names where the textures came from: no source or vendor name in the paths, the index, the docs or the code
 *   that reads them, and no text, ICC or EXIF metadata in the images.
 */

import { describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { decodePng, encodePng } from '../src/node/texture-processing';
import { leafAtlasUv, leafCellIndex, treeTextureFiles, validateTreeTextureIndex, type TreeTextureIndex } from '../src/common/spatial/tree-texture-library';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const LIB = path.join(REPO, 'assets/textures/trees');
const SHOTS = path.join(REPO, 'test-results/screenshots/tree_textures');
const index = JSON.parse(fs.readFileSync(path.join(LIB, 'index.json'), 'utf8')) as TreeTextureIndex;

function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
}

describe('tree texture library: index and files', () => {
    it('loads, validates, and names exactly the files in the folder', () => {
        expect(validateTreeTextureIndex(index)).toEqual([]);
        const named = treeTextureFiles(index).map(f => path.join(LIB, f)).sort();
        for (const f of named) expect(fs.statSync(f).size, f).toBeGreaterThan(1000);
        const present = walk(LIB).filter(f => path.basename(f) !== 'index.json').sort();
        expect(present).toEqual(named);
        const bytes = walk(LIB).reduce((a, f) => a + fs.statSync(f).size, 0);
        expect(bytes).toBeLessThan(40 * 1024 * 1024);
        expect(index.leaves.length).toBeGreaterThanOrEqual(8);
        expect(index.bark.length).toBeGreaterThanOrEqual(6);
        // neutral names of our own
        for (const e of [...index.leaves, ...index.bark]) expect(e.id).toMatch(/^(leaves|bark)_\d{2}$/);
        for (const f of treeTextureFiles(index)) expect(f).toMatch(/^(leaves|bark)\/(leaves|bark)_\d{2}\/(color|opacity|normal|roughness|ao)\.(jpg|png)$/);
    });

    it('has physically sane descriptors', () => {
        for (const e of [...index.leaves, ...index.bark]) {
            for (const c of e.colour.meanLinearRgb) expect(c).toBeGreaterThanOrEqual(0), expect(c).toBeLessThanOrEqual(1);
            expect(e.colour.meanLab[0]).toBeGreaterThan(5);
            expect(e.colour.meanLab[0]).toBeLessThan(95);
            expect(e.appearance.length).toBeGreaterThan(20);
            expect(e.provenance).toBe('library');
        }
        for (const e of index.leaves) {
            expect(e.leaf.lengthM).toBeGreaterThan(0.03);
            expect(e.leaf.lengthM).toBeLessThan(0.5);
            expect(e.leaf.widthM).toBeGreaterThan(0.01);
            expect(e.leaf.aspect).toBeCloseTo(e.leaf.widthM / e.leaf.lengthM, 1);
            expect(e.leaf.lengthRangeM[0]).toBeLessThanOrEqual(e.leaf.lengthM);
            expect(e.leaf.lengthRangeM[1]).toBeGreaterThanOrEqual(e.leaf.lengthM);
            expect(e.coverage).toBeGreaterThan(0.05);
            expect(e.coverage).toBeLessThan(0.9);
        }
        // the set spans narrow to broad leaves, and green to autumn colours
        const aspects = index.leaves.map(e => e.leaf.aspect);
        expect(Math.min(...aspects)).toBeLessThan(0.35);
        expect(Math.max(...aspects)).toBeGreaterThan(1.0);
        const hueOf = (c: number[]) => Math.atan2(Math.sqrt(3) * (c[1] - c[2]), 2 * c[0] - c[1] - c[2]) * 180 / Math.PI;
        const hues = index.leaves.map(e => hueOf(e.colour.meanLinearRgb));
        expect(Math.max(...hues) - Math.min(...hues)).toBeGreaterThan(60);
        for (const e of index.bark) {
            expect(e.realSizeM[0]).toBeGreaterThan(0.2);
            expect(e.realSizeM[1]).toBeGreaterThan(0.2);
            expect(e.bark.reliefIndex).toBeGreaterThanOrEqual(0);
            expect(e.bark.reliefIndex).toBeLessThan(1);
            expect(e.bark.furrowDepthM).toBeLessThan(0.05);
            expect(e.bark.ridgeSpacingM).toBeGreaterThanOrEqual(0.015);
            expect(e.bark.ridgeSpacingM).toBeLessThanOrEqual(0.25);
            expect(e.colour.meanLuminance).toBeGreaterThan(0.02);
        }
        // smooth to deeply furrowed
        const relief = index.bark.map(e => e.bark.reliefIndex);
        expect(Math.max(...relief) / Math.max(1e-6, Math.min(...relief))).toBeGreaterThan(8);
    });
});

describe('tree texture library: leaf cells', () => {
    it('puts every cell on a leaf, and maps a card into its cell base first', () => {
        fs.mkdirSync(SHOTS, { recursive: true });
        const tiles: Array<{ w: number; h: number; px: Buffer }> = [];
        for (const e of index.leaves) {
            const op = decodePng(fs.readFileSync(path.join(LIB, e.maps.opacity)));
            const at = (u: number, v: number) => op.data[(Math.min(op.height - 1, Math.max(0, Math.floor((1 - v) * op.height))) * op.width + Math.min(op.width - 1, Math.max(0, Math.floor(u * op.width)))) * 4] / 255;
            let opaqueCentres = 0;
            const viz = Buffer.alloc(256 * 256 * 4);
            for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
                const a = at((x + 0.5) / 256, 1 - (y + 0.5) / 256);
                viz.set([40 + 80 * a, 40 + 80 * a, 40 + 80 * a, 255], (y * 256 + x) * 4);
            }
            e.atlas.cells.forEach((c, i) => {
                // the middle of the blade is on the leaf, and a good share of the cell's box is
                if ([0.4, 0.45, 0.5, 0.55, 0.6].some(s => { const m = leafAtlasUv([0.5 + (s - 0.5) * c.widthM / c.lengthM, 0.5], c, 10, 1); return at(m.uv[0], m.uv[1]) > 0.5; })) opaqueCentres++;
                let opaque = 0;
                for (let a = 0; a < 9; a++) for (let b = 0; b < 9; b++) {
                    const s = (a + 0.5) / 9, t = (b + 0.5) / 9;
                    if (at(c.origin[0] + t * c.along[0] + s * c.across[0], c.origin[1] + t * c.along[1] + s * c.across[1]) > 0.5) opaque++;
                }
                expect(opaque / 81, `${e.id} cell ${i}`).toBeGreaterThan(0.3);
                // the card's base and tip map to the cell's base and tip midpoints when the leaf fits the card
                const base = leafAtlasUv([0.5, 0], c, 10, 1);
                expect(base.uv[0]).toBeCloseTo(c.origin[0] + 0.5 * c.across[0], 6);
                expect(base.uv[1]).toBeCloseTo(c.origin[1] + 0.5 * c.across[1], 6);
                // a grid over the card: inside points lie in the cell's box, outside points are flagged
                for (let gu = 0; gu <= 10; gu++) for (let gv = 0; gv <= 10; gv++) {
                    const r = leafAtlasUv([0.5 - 0.35 + 0.07 * gu, gv / 10], c, 0.7);
                    const ins = r.st[0] >= 0 && r.st[0] <= 1 && r.st[1] >= 0 && r.st[1] <= 1;
                    expect(r.inside).toBe(ins);
                    if (r.inside) {
                        expect(r.uv[0]).toBeGreaterThan(-0.01); expect(r.uv[0]).toBeLessThan(1.01);
                        expect(r.uv[1]).toBeGreaterThan(-0.01); expect(r.uv[1]).toBeLessThan(1.01);
                        const px = Math.floor(r.uv[0] * 256), py = Math.floor((1 - r.uv[1]) * 256);
                        if (px >= 0 && px < 256 && py >= 0 && py < 256) viz.set([255, 200, 0, 255], (py * 256 + px) * 4);
                    }
                }
                const b = leafAtlasUv([0.5, 0], c, 0.7);
                const bx = Math.floor(b.uv[0] * 256), by = Math.floor((1 - b.uv[1]) * 256);
                for (let d = -2; d <= 2; d++) for (const [x, y] of [[bx + d, by], [bx, by + d]]) if (x >= 0 && x < 256 && y >= 0 && y < 256) viz.set([0, 255, 255, 255], (y * 256 + x) * 4);
                expect(leafCellIndex((i + 0.5) / e.atlas.cells.length, e.atlas.cells.length)).toBe(i);
            });
            expect(opaqueCentres / e.atlas.cells.length, e.id).toBeGreaterThanOrEqual(0.75);
            tiles.push({ w: 256, h: 256, px: viz });
        }
        // contact sheet: each atlas's opacity, the card grid mapped into its cells (orange), each leaf's base (cyan)
        const cols = 4, rows = Math.ceil(tiles.length / cols), W = cols * 256, H = rows * 256;
        const sheet = Buffer.alloc(W * H * 4);
        tiles.forEach((t, i) => { for (let y = 0; y < 256; y++) t.px.copy(sheet, ((Math.floor(i / cols) * 256 + y) * W + (i % cols) * 256) * 4, y * 256 * 4, (y + 1) * 256 * 4); });
        const png = encodePng(W, H, sheet);
        fs.writeFileSync(path.join(SHOTS, 'library_leaf_cells.png'), png);
        expect(png.readUInt32BE(0)).toBe(0x89504e47);
    });
});

// sha256 (first 16 hex digits) of names that must never appear: the textures' source and its vendor. Kept as hashes so
// that this test does not name them either.
const FORBIDDEN = new Set(['233e892fb6eec70f', '38286db48c22a2c8', '1f88d4953294e117', '9c1205c2c37403ee', 'cdc6d9165433cfe3', 'aab03789086aa417', '9f78333c28df9352', 'dc6af1b2e43f35ab']);
const h16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

/**
 * Hashed tokens of a text: within each whitespace-separated word, its lowercase alphanumeric runs (trailing digits also
 * dropped) and their joins of two and three (so a name written with underscores, dashes or dots is found too).
 */
function forbiddenIn(text: string): string[] {
    const hits: string[] = [];
    for (const word of text.toLowerCase().split(/\s+/)) {
        const tokens = word.split(/[^a-z0-9]+/).filter(Boolean);
        for (let i = 0; i < tokens.length; i++) {
            for (const n of [1, 2, 3]) {
                if (i + n > tokens.length) continue;
                const joined = tokens.slice(i, i + n).join('');
                for (const cand of [joined, joined.replace(/\d+$/, '')]) if (FORBIDDEN.has(h16(cand))) hits.push(word);
            }
        }
    }
    return hits;
}

describe('tree texture library: no trace of its source', () => {
    it('names no source or vendor in the paths, the index, the docs and the code that reads them', () => {
        const texts: Array<[string, string]> = [['paths', walk(LIB).map(f => path.relative(REPO, f)).join('\n')], ['index.json', fs.readFileSync(path.join(LIB, 'index.json'), 'utf8')]];
        const files = [
            'packages/core/src/common/spatial/tree-texture-library.ts',
            'packages/core/src/browser/generative-canvas/primitives/scene3d/treeLod/treeTextureMaterials.ts',
            'packages/core/src/native/3d-engine/include/scratchbox_tree_textures.hpp',
            'packages/core/src/native/3d-engine/include/scratchbox_tile_vegetation.hpp',
            'AGENTS.md',
            ...fs.readdirSync(path.join(REPO, 'docs/processes')).filter(f => /tree_texture/.test(f)).map(f => `docs/processes/${f}`)
        ];
        for (const f of files) texts.push([f, fs.readFileSync(path.join(REPO, f), 'utf8')]);
        for (const [name, text] of texts) expect(forbiddenIn(text), name).toEqual([]);
        // the check itself finds a planted name
        expect(forbiddenIn('x LEAFSET010 y').length).toBeGreaterThan(0);
    });

    it('carries no metadata in its images (no text, time, ICC or EXIF chunks; no APP1/APP2/APP13/COM segments)', () => {
        for (const f of walk(LIB)) {
            const b = fs.readFileSync(f);
            if (f.endsWith('.png')) {
                const chunks: string[] = [];
                for (let o = 8; o < b.length;) { const n = b.readUInt32BE(o); chunks.push(b.toString('ascii', o + 4, o + 8)); o += 12 + n; }
                expect(chunks.filter(c => !['IHDR', 'IDAT', 'IEND', 'PLTE', 'tRNS'].includes(c)), f).toEqual([]);
            } else if (f.endsWith('.jpg')) {
                expect(b.readUInt16BE(0)).toBe(0xffd8);
                const markers: number[] = [];
                for (let o = 2; o < b.length && b[o] === 0xff;) { const m = b[o + 1]; if (m === 0xda) break; markers.push(m); o += 2 + b.readUInt16BE(o + 2); }
                expect(markers.filter(m => [0xe1, 0xe2, 0xed, 0xfe].includes(m)), f).toEqual([]);
            }
        }
    });
});
