/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The warm-up builds the engines in the request's order, one after the other, logs each, never throws, and can be
 * turned off. The scan fitter is found when this build has it and is reported as absent, with the reason, when not.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { nativeWarmupSteps, warmNativeEngine, type WarmupStep } from '../src/node/3d-engine/native-warmup';
import { loadScanFit } from '../src/node/3d-engine/scan-fit-loader';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';
import { TileRefineService } from '../src/node/3d-engine/tile-refine-service';
import { ScanFitService } from '../src/node/3d-engine/scan-fit-service';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';
import { NativeSkyService } from '../src/node/3d-engine/native-sky-service';
import { NativeSkyMsService } from '../src/node/3d-engine/native-sky-ms-service';

afterEach(() => vi.restoreAllMocks());

const tick = () => new Promise<void>(r => setTimeout(r, 1));

describe('warmNativeEngine', () => {
    it('builds the real engines in the request path\'s order, each after the one before, and logs each with its time', async () => {
        const events: string[] = [];
        let active = 0, maxActive = 0;
        const track = (name: string, ms: number) => async () => {
            events.push(`start ${name}`);
            active++; maxActive = Math.max(maxActive, active);
            await new Promise(r => setTimeout(r, ms));
            active--;
            events.push(`end ${name}`);
        };
        vi.spyOn(TileVegetationService.prototype, 'ensureBinary').mockImplementation(async () => { await track('tile_vegetation', 15)(); return '/bin/tv'; });
        vi.spyOn(TileRefineService.prototype, 'ensureBinary').mockImplementation(async () => { await track('tile_refine', 5)(); return { path: '/bin/tr', built: false }; });
        vi.spyOn(ScanFitService.prototype, 'ensureBinary').mockImplementation(async () => { await track('scan_fit', 5)(); return '/bin/sf'; });
        vi.spyOn(NativePythonRunnerService.prototype, 'ensureNativeModule').mockImplementation(async () => { await track('python', 1)(); return null; });
        vi.spyOn(NativeSkyService.prototype, 'warmDefaultSky').mockImplementation(track('sky', 1));
        vi.spyOn(NativeSkyMsService.prototype, 'warm').mockImplementation(track('weather sky', 1));
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-warm-'));
        // the staged massing tool (the vector first paint) as a built binary: nothing is compiled here
        const prevMassing = process.env.SCRATCHBOX_STAGED_MASSING_BIN;
        process.env.SCRATCHBOX_STAGED_MASSING_BIN = '/bin/staged_massing';
        try {
            const lines: string[] = [];
            const report = await warmNativeEngine(root, { log: m => lines.push(m), env: {} });
            expect(report.steps.map(s => s.name)).toEqual(['tile_vegetation', 'tile_refine', 'staged_massing', 'scan_fit', 'scratchbox_native (Python module)', 'sky tables (default medium)', 'weather sky (multiple scattering)']);
            expect(report.steps.map(s => s.ok)).toEqual([true, true, true, true, true, true, true]);
            // the fitter is part of this build: it is built in its place in the order, with no note
            expect(report.steps[3].note).toBeUndefined();
            expect(events).toEqual(['start tile_vegetation', 'end tile_vegetation', 'start tile_refine', 'end tile_refine', 'start scan_fit', 'end scan_fit', 'start python', 'end python', 'start sky', 'end sky', 'start weather sky', 'end weather sky']);
            expect(maxActive).toBe(1);
            expect(lines).toHaveLength(7);
            expect(lines[0]).toMatch(/\[native warm-up\] tile_vegetation: ready \(\d+\.\d s\)/);
            expect(lines[4]).toMatch(/scratchbox_native \(Python module\): ready/);
        } finally {
            if (prevMassing === undefined) delete process.env.SCRATCHBOX_STAGED_MASSING_BIN; else process.env.SCRATCHBOX_STAGED_MASSING_BIN = prevMassing;
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('logs a failed step and goes on to the next; it never throws', async () => {
        const ran: string[] = [];
        const steps: WarmupStep[] = [
            { name: 'a', run: async () => { ran.push('a'); throw new Error('clang: error: no such file'); } },
            { name: 'b', run: async () => { ran.push('b'); } },
            { name: 'c', run: async () => { ran.push('c'); return 'not part of this build'; } }
        ];
        const lines: string[] = [];
        const report = await warmNativeEngine('/unused', { steps, log: m => lines.push(m), env: {} });
        expect(ran).toEqual(['a', 'b', 'c']);
        expect(report.steps.map(s => [s.name, s.ok])).toEqual([['a', false], ['b', true], ['c', true]]);
        expect(report.steps[0].error).toBe('clang: error: no such file');
        expect(report.steps[2].note).toBe('not part of this build');
        expect(lines[0]).toMatch(/a failed after .* s: clang: error: no such file/);
    });

    it('does nothing when SCRATCHBOX_NATIVE_WARMUP is 0 (the isolated self-test instance)', async () => {
        const run = vi.fn(async () => undefined);
        const lines: string[] = [];
        const report = await warmNativeEngine('/unused', { steps: [{ name: 'a', run }], log: m => lines.push(m), env: { SCRATCHBOX_NATIVE_WARMUP: '0' } });
        expect(run).not.toHaveBeenCalled();
        expect(report).toEqual({ skipped: 'SCRATCHBOX_NATIVE_WARMUP=0', steps: [] });
        expect(lines[0]).toMatch(/off/);
    });

    it('times each step with the clock it is given', async () => {
        let t = 1000;
        const report = await warmNativeEngine('/unused', {
            steps: [{ name: 'slow', run: async () => { t += 42_500; } }],
            now: () => t, log: () => undefined, env: {}
        });
        expect(report.steps[0].ms).toBe(42_500);
    });

    it('lists the engines the object builder and the staged build share: nothing is built twice', () => {
        const names = nativeWarmupSteps('/unused').map(s => s.name);
        expect(new Set(names).size).toBe(names.length);
    });
});

describe('loadScanFit', () => {
    it('says the fitter is not part of this build, with no stack, when the service module is absent', async () => {
        const r = await loadScanFit('/unused-root-a', './scan-fit-service-that-does-not-exist');
        expect(r.service).toBeUndefined();
        expect(r.unavailable).toBe('the scan fitter (scan-fit-service) is not part of this build of the app');
    });

    it('returns the service when the module exports getScanFitService, once per workspace', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-scanfit-'));
        try {
            const mod = path.join(dir, 'fake-scan-fit-service.mjs');
            fs.writeFileSync(mod, `
                const made = [];
                export function getScanFitService(root) { const s = { root, fit: async () => 1, refit: async () => 2, ornament: async () => 3, flatten: async () => 4, ensureBinary: async () => 'ok' }; made.push(s); return s; }
            `);
            const first = await loadScanFit('/ws', mod);
            expect(first.unavailable).toBeUndefined();
            expect((first.service as any).root).toBe('/ws');
            await expect(first.service!.fit({} as any)).resolves.toBe(1);
            const again = await loadScanFit('/ws', mod);
            expect(again.service).toBe(first.service);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('reports a module that loads but exports no service, and a module that throws while loading', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-scanfit-'));
        try {
            const empty = path.join(dir, 'empty.mjs');
            fs.writeFileSync(empty, 'export const x = 1;');
            expect((await loadScanFit('/ws', empty)).unavailable).toMatch(/does not export getScanFitService or ScanFitService/);
            const broken = path.join(dir, 'broken.mjs');
            fs.writeFileSync(broken, 'throw new Error("clang not found");');
            expect((await loadScanFit('/ws', broken)).unavailable).toMatch(/could not be loaded: clang not found/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

void tick;
