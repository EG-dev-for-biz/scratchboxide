/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tile refine (scratchbox_tile_refine.hpp + scripts/tile_refine.cpp) end to end on the real test tile: the CLI is
 * compiled with clang++ and run once. Checks: wall time, zero flips, no increase in open edges, and the textured
 * output keeps every input image byte-identical. Thumbnails (raw vs output, textured and clay) are written to
 * test-results/screenshots/tile_refine/ (gitignored). The --isolate run (one structure under the anchor) writes its
 * thumbnails to test-results/screenshots/tile_refine_isolate/. Skipped when the tile is not present.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO = path.resolve(__dirname, '../../..');
const TILE = path.join(REPO, 'public/tiles/scan_studio_tile_esb_77197_98526.glb');
const WORK = path.join(REPO, 'test-results/tile-refine');
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_refine');
const BIN = path.join(WORK, 'tile_refine');

interface Glb {
    json: any;
    bin: Buffer;
}

function readGlb(file: string): Glb {
    const b = fs.readFileSync(file);
    expect(b.readUInt32LE(0)).toBe(0x46546c67);
    const jsonLen = b.readUInt32LE(12);
    expect(b.readUInt32LE(16)).toBe(0x4e4f534a);
    const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
    const binHeader = 20 + jsonLen;
    const binLen = b.readUInt32LE(binHeader);
    expect(b.readUInt32LE(binHeader + 4)).toBe(0x004e4942);
    return { json, bin: b.subarray(binHeader + 8, binHeader + 8 + binLen) };
}

function imageBytes(g: Glb): Buffer[] {
    return (g.json.images ?? []).map((im: any) => {
        const v = g.json.bufferViews[im.bufferView];
        return g.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
    });
}

const haveTile = fs.existsSync(TILE);

describe.skipIf(!haveTile)('tile_refine on the photogrammetric test tile', () => {
    let stats: any;
    let wallMs = 0;
    const textured = path.join(WORK, 'refined_textured.glb');
    const clay = path.join(WORK, 'refined_clay.glb');

    beforeAll(() => {
        fs.mkdirSync(WORK, { recursive: true });
        fs.mkdirSync(SHOTS, { recursive: true });
        // (re)compile only when the CLI or an engine header is newer than the test's binary
        const include = path.join(REPO, 'packages/core/src/native/3d-engine/include');
        const sources = [path.join(REPO, 'scripts/tile_refine.cpp'), ...fs.readdirSync(include).map(f => path.join(include, f))];
        const newest = Math.max(...sources.map(f => fs.statSync(f).mtimeMs));
        if (!fs.existsSync(BIN) || fs.statSync(BIN).mtimeMs < newest) {
            execFileSync(process.env.CXX || 'clang++', [
                '-std=c++20', '-O3', '-pthread', '-I', include,
                path.join(REPO, 'scripts/tile_refine.cpp'), '-o', BIN, '-lz',
            ], { stdio: 'pipe', timeout: 600_000 });
        }
        const statsPath = path.join(WORK, 'refined_stats.json');
        const t0 = Date.now();
        execFileSync(BIN, [
            '--input', TILE, '--out-textured', textured, '--out-clay', clay, '--stats', statsPath,
            '--threads', '10', '--thumbs', SHOTS,
        ], { stdio: 'pipe', timeout: 600_000 });
        wallMs = Date.now() - t0;
        stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    }, 900_000);

    it('finishes in under 60 s and reports every stage', () => {
        expect(wallMs).toBeLessThan(60_000);
        for (const stage of ['load', 'visibility', 'rectify', 'relief', 'write', 'final_checks']) {
            expect(typeof stats.stagesMs[stage]).toBe('number');
        }
        expect(stats.triangles.kept).toBeGreaterThan(0.5 * stats.triangles.input);
        expect(stats.outputs.triangles).toBeGreaterThanOrEqual(stats.triangles.kept);
    });

    it('flips no triangle', () => {
        // rectifier: kept triangles against their input normals; relief: folds of the height field over each treated
        // region (untreated output triangles against the rectified triangle they were cut from)
        expect(stats.rectify.flips).toBe(0);
        expect(stats.relief.flips).toBe(0);
        expect(stats.relief.flipChecked).toBeGreaterThan(0);
    });

    it('does not increase the open edges', () => {
        const e = stats.openEdges;
        expect(e.final.boundaryEdges).toBeLessThanOrEqual(e.rawInput.boundaryEdges);
        expect(e.rectified.boundaryEdges).toBeLessThanOrEqual(e.rawKept.boundaryEdges);
        // the relief keeps region borders in place: no output boundary edge lies off a rectified boundary edge, and
        // splitting borders adds edges but no open length
        expect(e.final.newBoundaryEdges).toBe(0);
        expect(e.final.boundaryLength_m).toBeLessThanOrEqual(e.rectified.boundaryLength_m + 1e-3);
        expect(e.rectified.boundaryLength_m).toBeLessThanOrEqual(e.rawKept.boundaryLength_m + 1e-3);
    });

    it('keeps the 70 input images byte-identical in the textured output', () => {
        const input = imageBytes(readGlb(TILE));
        const output = imageBytes(readGlb(textured));
        expect(input.length).toBe(70);
        expect(output.length).toBe(input.length);
        for (let i = 0; i < input.length; i++) expect(Buffer.compare(output[i], input[i])).toBe(0);
        const clayGlb = readGlb(clay);
        expect(clayGlb.json.materials[0].pbrMetallicRoughness.baseColorFactor.slice(0, 3)).toEqual([0.55, 0.57, 0.6]);
        expect(fs.statSync(textured).size).toBeLessThanOrEqual(60 * 1024 * 1024);
    });

    it('writes the raw-vs-output thumbnails', () => {
        expect(stats.thumbnails.shots.map((s: any) => s.name)).toEqual(['aerial', 'hero_facade', 'street']);
        for (const shot of stats.thumbnails.shots) {
            const png = fs.readFileSync(path.join(SHOTS, `${shot.name}.png`));
            expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
        }
    });

    // --isolate: only the structure under the anchor (whole) plus a ground apron, for a seconds-scale test loop.
    describe('--isolate (the structure under the anchor only)', () => {
        const isoShots = path.join(REPO, 'test-results/screenshots/tile_refine_isolate');
        const isoTextured = path.join(WORK, 'isolated_textured.glb');
        const isoClay = path.join(WORK, 'isolated_clay.glb');
        const isoRawClay = path.join(WORK, 'isolated_raw_clay.glb');
        let iso: any;
        let isoWallMs = 0;

        beforeAll(() => {
            fs.rmSync(isoShots, { recursive: true, force: true });
            const statsPath = path.join(WORK, 'isolated_stats.json');
            const t0 = Date.now();
            execFileSync(BIN, [
                '--input', TILE, '--isolate', '--out-textured', isoTextured, '--out-clay', isoClay, '--out-raw-clay', isoRawClay,
                '--stats', statsPath, '--thumbs', isoShots,
            ], { stdio: 'pipe', timeout: 120_000 });
            isoWallMs = Date.now() - t0;
            iso = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            console.log(`[tile-refine --isolate] wall ${isoWallMs} ms, stages ${JSON.stringify(iso.stagesMs)}`);
        }, 180_000);

        it('keeps one whole structure: a small share of the tile, uncapped in height, plus its apron', () => {
            const t = iso.isolate.triangles;
            expect(iso.isolate.enabled).toBe(true);
            expect(t.input).toBe(stats.triangles.input);
            // scan triangles kept, plus the ground rebuilt on the terrain, plus what clipping at street level split or removed
            expect(t.kept).toBe(t.core + t.closure + t.apron + t.ground + t.belowGroundDelta);
            expect(t.kept).toBeGreaterThan(1000);
            expect(t.kept).toBeLessThan(0.25 * t.input);
            expect(iso.triangles.input).toBe(t.kept);
            // the anchor's structure is the tallest in this test tile: nothing above it was cut
            expect(iso.isolate.boundsMax[1]).toBeCloseTo(stats.input.boundsMax[1], 3);
            expect(iso.roi.enabled).toBe(false);
            expect(iso.roi.wholeIsolatedStructure).toBe(true);
        });

        it('runs every stage on the subset, fast, without flips or new open edges', () => {
            expect(isoWallMs).toBeLessThan(15_000);
            for (const stage of ['load', 'isolate', 'write_raw_clay', 'visibility', 'rectify', 'relief', 'write', 'final_checks', 'thumbnails']) {
                expect(typeof iso.stagesMs[stage]).toBe('number');
            }
            expect(iso.rectify.flips).toBe(0);
            expect(iso.relief.flips).toBe(0);
            // the relief splits border edges where it cuts (more edges, no more open length) and opens none of its own
            const e = iso.openEdges;
            expect(e.final.newBoundaryEdges).toBe(0);
            expect(e.final.boundaryLength_m).toBeLessThanOrEqual(e.rectified.boundaryLength_m + 1e-3);
            expect(e.rectified.boundaryLength_m).toBeLessThanOrEqual(e.rawKept.boundaryLength_m + 1e-3);
            expect(e.rawKept.boundaryLength_m).toBeLessThanOrEqual(e.rawInput.boundaryLength_m + 1e-3);
        });

        it('writes the raw clay, refined clay and refined textured GLBs; the textured one embeds only the images it uses, byte-identical', () => {
            const raw = readGlb(isoRawClay);
            const rawTris = raw.json.meshes[0].primitives.reduce((n: number, p: any) => n + raw.json.accessors[p.indices].count / 3, 0);
            expect(rawTris).toBe(iso.isolate.triangles.kept);
            expect(raw.json.materials[0].pbrMetallicRoughness.baseColorFactor.slice(0, 3)).toEqual([0.55, 0.57, 0.6]);
            expect(readGlb(isoClay).json.meshes).toHaveLength(1);
            const input = imageBytes(readGlb(TILE));
            const output = imageBytes(readGlb(isoTextured));
            expect(output.length).toBe(iso.isolate.images.kept);
            expect(output.length).toBeGreaterThan(0);
            expect(output.length).toBeLessThan(input.length);
            for (const img of output) expect(input.some(i => Buffer.compare(i, img) === 0)).toBe(true);
            expect(new Set(output.map(b => b.toString('base64'))).size).toBe(output.length);
        });

        it('writes one thumbnail per side at mid height and one aerial', () => {
            const names: string[] = iso.thumbnails.shots.map((s: any) => s.name);
            expect(names.filter(n => /^side_\d{3}$/.test(n))).toHaveLength(4);
            expect(names).toContain('aerial');
            for (const n of names) {
                const png = fs.readFileSync(path.join(isoShots, `${n}.png`));
                expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
            }
        });
    });
});
