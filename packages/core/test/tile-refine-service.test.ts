/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * TileRefineService: cache, path confinement, timeout and publishing, each against a throwaway workspace root.
 * The first three cases run a tiny stand-in executable (a shell script that copies the input) so they take
 * milliseconds; the last case runs the real native pipeline on the photogrammetric test tile through the service,
 * cold then cached, and keeps its thumbnails in test-results/screenshots/tile_refine_service/ (gitignored).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TileRefineService, TileRefineError, summarizeTileRefineStats } from '../src/node/3d-engine/tile-refine-service';
import { PathTraversalError } from '../src/node/security/path-guard';

const REPO = path.resolve(__dirname, '../../..');
const TILE = path.join(REPO, 'public/tiles/scan_studio_tile_esb_77197_98526.glb');
const SHOTS = path.join(REPO, 'test-results/screenshots/tile_refine_service');

let root: string;
let fakeBin: string;
let hangBin: string;
let counter: string;

function runs(): number {
    return fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0;
}

beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-refine-svc-'));
    fs.mkdirSync(path.join(root, 'public/tiles'), { recursive: true });
    fs.writeFileSync(path.join(root, 'public/tiles/a.glb'), Buffer.concat([Buffer.from('glTF'), Buffer.alloc(64, 7)]));
    counter = path.join(root, 'runs.log');
    // stand-in for build/3d-native/tile_refine: textured = input bytes, clay = the argument list, stats = JSON
    fakeBin = path.join(root, 'fake_tile_refine');
    fs.writeFileSync(fakeBin, [
        '#!/bin/sh',
        'ARGS="$*"',
        'while [ $# -gt 0 ]; do case "$1" in',
        '  --input) IN="$2"; shift 2;; --out-textured) T="$2"; shift 2;; --out-clay) C="$2"; shift 2;;',
        '  --stats) S="$2"; shift 2;; --out-raw-clay) R="$2"; shift 2;; *) shift;; esac; done',
        'cp "$IN" "$T"; printf "%s" "$ARGS" > "$C"; if [ -n "$R" ]; then cp "$IN" "$R"; fi',
        'printf \'{"ok":true,"totalMs":1,"outputs":{"triangles":3}}\' > "$S"',
        `echo run >> "${counter}"`,
        ''
    ].join('\n'), { mode: 0o755 });
    hangBin = path.join(root, 'hang_tile_refine');
    fs.writeFileSync(hangBin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
});

afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
});

describe('TileRefineService', () => {
    it('serves a repeat request from the cache and publishes copies with backups', async () => {
        const svc = new TileRefineService({ workspaceRoot: root, binaryPath: fakeBin });
        const first = await svc.refine({ tilePath: 'public/tiles/a.glb', roiRadius: 30 });
        expect(first.cached).toBe(false);
        expect(runs()).toBe(1);
        expect(Buffer.compare(fs.readFileSync(first.texturedGlb), fs.readFileSync(path.join(root, 'public/tiles/a.glb')))).toBe(0);
        expect(fs.readFileSync(first.clayGlb, 'utf8')).toContain('--roi-radius 30');
        expect(first.stats.outputs.triangles).toBe(3);
        expect(first.texturedGlb.startsWith(path.join(fs.realpathSync(root), '.scratchbox/cache/tile_refine', first.cacheKey))).toBe(true);

        const again = await svc.refine({ glbPath: 'public/tiles/a.glb', roiRadius: 30, publishAs: 'demo' });
        expect(again.cached).toBe(true);
        expect(again.cacheKey).toBe(first.cacheKey);
        expect(again.texturedGlb).toBe(first.texturedGlb);
        expect(again.ms).toBeLessThan(1000);
        expect(runs()).toBe(1);
        expect(again.published?.textured).toBe(path.join('public', 'models', 'demo_refined.glb'));
        expect(again.published?.urls.clay).toBe('/models/demo_refined_clay.glb');
        expect(again.published?.backups).toEqual([]);

        // different parameters -> a new run; publishing over the earlier, different clay backs it up first
        const noRelief = await svc.refine({ tilePath: 'public/tiles/a.glb', roiRadius: 30, relief: false, publishAs: 'demo' });
        expect(noRelief.cached).toBe(false);
        expect(noRelief.cacheKey).not.toBe(first.cacheKey);
        expect(runs()).toBe(2);
        expect(fs.readFileSync(path.join(root, 'public/models/demo_refined_clay.glb'), 'utf8')).toContain('--no-relief');
        expect(noRelief.published?.backups).toHaveLength(1); // textured bytes are identical, clay differs
        const backup = path.join(root, noRelief.published!.backups[0]);
        expect(backup).toContain(path.join('.scratchbox', 'backup', 'pre_tile_refine'));
        expect(fs.readFileSync(backup, 'utf8')).not.toContain('--no-relief');
    });

    it('rejects paths that leave the workspace root without running anything', async () => {
        const svc = new TileRefineService({ workspaceRoot: root, binaryPath: fakeBin });
        const before = runs();
        expect(() => svc.resolveRequest({ tilePath: '../../etc/passwd.glb' })).toThrow(PathTraversalError);
        await expect(svc.refine({ tilePath: '/etc/hosts' })).rejects.toBeInstanceOf(PathTraversalError);
        const outside = path.join(os.tmpdir(), `tile-refine-outside-${process.pid}.glb`);
        fs.writeFileSync(outside, 'glTF');
        try {
            fs.symlinkSync(outside, path.join(root, 'public/tiles/escape.glb'));
            await expect(svc.refine({ tilePath: 'public/tiles/escape.glb' })).rejects.toBeInstanceOf(PathTraversalError);
        } finally {
            fs.rmSync(outside, { force: true });
        }
        await expect(svc.refine({ tilePath: 'public/tiles/a.glb', publishAs: '../../evil' })).rejects.toMatchObject({ code: 'bad_request' });
        await expect(svc.refine({ tilePath: 'public/tiles/a.glb', publishAs: { clay: '../x.glb' } })).rejects.toMatchObject({ code: 'bad_request' });
        await expect(svc.refine({ tilePath: 'public/tiles/missing.glb' })).rejects.toMatchObject({ code: 'not_found' });
        expect(runs()).toBe(before);
    });

    it('isolate: passes --isolate, keys the cache on it and publishes the raw clay as well', async () => {
        const svc = new TileRefineService({ workspaceRoot: root, binaryPath: fakeBin });
        const plain = await svc.refine({ tilePath: 'public/tiles/a.glb' });
        expect(plain.rawClayGlb).toBeUndefined();
        expect(fs.readFileSync(plain.clayGlb, 'utf8')).not.toContain('--isolate');
        const iso = await svc.refine({
            tilePath: 'public/tiles/a.glb',
            isolate: { apron: 6 },
            publishAs: { textured: 'iso_s3.glb', clay: 'iso_s2.glb', rawClay: 'iso_s1.glb' }
        });
        expect(iso.cached).toBe(false);
        expect(iso.cacheKey).not.toBe(plain.cacheKey);
        expect(fs.readFileSync(iso.clayGlb, 'utf8')).toContain('--isolate --apron 6');
        expect(iso.rawClayGlb).toBeDefined();
        expect(iso.published?.urls).toEqual({ textured: '/models/iso_s3.glb', clay: '/models/iso_s2.glb', rawClay: '/models/iso_s1.glb' });
        expect(Buffer.compare(fs.readFileSync(path.join(root, 'public/models/iso_s1.glb')), fs.readFileSync(iso.rawClayGlb!))).toBe(0);
        const again = await svc.refine({ tilePath: 'public/tiles/a.glb', isolate: { apron: 6 } });
        expect(again.cached).toBe(true);
        expect(again.rawClayGlb).toBe(iso.rawClayGlb);
        const before = runs();
        await expect(svc.refine({ tilePath: 'public/tiles/a.glb', publishAs: { rawClay: 'x.glb' } })).rejects.toMatchObject({ code: 'bad_request' });
        await expect(svc.refine({ tilePath: 'public/tiles/a.glb', isolate: { apron: -1 } })).rejects.toMatchObject({ code: 'bad_request' });
        expect(runs()).toBe(before);
    });

    it('facadeFlatten: false passes --no-flatten, a band passes --flatten-band, and both key the cache', async () => {
        const svc = new TileRefineService({ workspaceRoot: root, binaryPath: fakeBin });
        expect(svc.resolveRequest({ tilePath: 'public/tiles/a.glb' }).cliArgs).not.toContain('--no-flatten');
        expect(svc.resolveRequest({ tilePath: 'public/tiles/a.glb', facadeFlatten: true }).cliArgs).toEqual([]);
        const off = svc.resolveRequest({ tilePath: 'public/tiles/a.glb', facadeFlatten: false });
        expect(off.cliArgs).toEqual(['--no-flatten']);
        expect(off.keyParams).toEqual({ facadeFlatten: false });
        const band = svc.resolveRequest({ tilePath: 'public/tiles/a.glb', facadeFlatten: { band: 0.06 } });
        expect(band.cliArgs).toEqual(['--flatten-band', '0.06']);
        expect(band.keyParams).toEqual({ flattenBand: 0.06 });
        expect(() => svc.resolveRequest({ tilePath: 'public/tiles/a.glb', facadeFlatten: { band: 2 } })).toThrow(/facadeFlatten.band/);
        expect(() => svc.resolveRequest({ tilePath: 'public/tiles/a.glb', facadeFlatten: { band: 0 } })).toThrow(/facadeFlatten.band/);
        const plain = await svc.refine({ tilePath: 'public/tiles/a.glb' });
        const flatOff = await svc.refine({ tilePath: 'public/tiles/a.glb', facadeFlatten: false });
        expect(flatOff.cached).toBe(false);
        expect(flatOff.cacheKey).not.toBe(plain.cacheKey);
        expect(fs.readFileSync(flatOff.clayGlb, 'utf8')).toContain('--no-flatten');
    });

    it('summarizes relief with its provenance, and leaves it out when relief is off', () => {
        const on = summarizeTileRefineStats({
            relief: { enabled: true, provenance: 'inferred', regionsTreated: 3, recessArea_m2: 41.5, proudArea_m2: 2, heightMin_m: -0.2, heightMax_m: 0.1, latticesRejected: 1, proudClampedDropped: 2 }
        });
        expect(on.relief).toEqual({
            provenance: 'inferred', facadesTreated: 3, recessArea_m2: 41.5, proudArea_m2: 2, heightMin_m: -0.2, heightMax_m: 0.1, latticesRejected: 1, proudClampedDropped: 2
        });
        expect(summarizeTileRefineStats({ relief: { enabled: false } }).relief).toBeUndefined();
    });

    it('kills a hung run at the timeout and leaves no cache entry', async () => {
        const cacheDir = path.join('.scratchbox', 'cache', 'tile_refine_timeout');
        const svc = new TileRefineService({ workspaceRoot: root, binaryPath: hangBin, cacheDir });
        const t0 = Date.now();
        const err = await svc.refine({ tilePath: 'public/tiles/a.glb', timeoutMs: 300 }).catch(e => e);
        expect(err).toBeInstanceOf(TileRefineError);
        expect(err.code).toBe('timeout');
        expect(Date.now() - t0).toBeLessThan(5000);
        expect(fs.readdirSync(path.join(root, cacheDir))).toEqual([]);
    });
});

describe.skipIf(!fs.existsSync(TILE))('TileRefineService on the photogrammetric test tile', () => {
    it('refines the tile with the native pipeline, then answers the repeat from the cache', async () => {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-refine-real-'));
        try {
            fs.mkdirSync(path.join(work, 'public/tiles'), { recursive: true });
            fs.copyFileSync(TILE, path.join(work, 'public/tiles/tile.glb'));
            const svc = new TileRefineService({ workspaceRoot: work, repoRoot: REPO });
            const cold = await svc.refine({ tilePath: 'public/tiles/tile.glb', thumbnails: true });
            expect(cold.cached).toBe(false);
            for (const glb of [cold.texturedGlb, cold.clayGlb]) {
                const head = fs.readFileSync(glb).subarray(0, 4).toString('ascii');
                expect(head).toBe('glTF');
            }
            expect(cold.stats.rectify.flips).toBe(0);
            expect(cold.stats.relief.flips).toBe(0);
            expect(cold.stats.outputs.triangles).toBeGreaterThanOrEqual(cold.stats.triangles.kept);
            expect(cold.thumbnailsDir).toBeDefined();
            fs.mkdirSync(SHOTS, { recursive: true });
            for (const f of fs.readdirSync(cold.thumbnailsDir!)) fs.copyFileSync(path.join(cold.thumbnailsDir!, f), path.join(SHOTS, f));
            expect(fs.readdirSync(SHOTS)).toEqual(expect.arrayContaining(['aerial.png', 'hero_facade.png', 'street.png']));

            const warm = await svc.refine({ tilePath: 'public/tiles/tile.glb', thumbnails: true });
            expect(warm.cached).toBe(true);
            expect(warm.texturedGlb).toBe(cold.texturedGlb);
            expect(warm.ms).toBeLessThan(1000);
            console.log(`[tile-refine-service] cold ${cold.ms} ms (binary ${cold.binary.built ? `built in ${cold.binary.buildMs} ms` : 'up to date'}), cached ${warm.ms} ms`);
        } finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    }, 900_000);
});
