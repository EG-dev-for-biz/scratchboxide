/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * ScanFitService and the scan_fit CLI behind it, as the orchestrator uses them (§3.10, §4.7):
 *
 * - progress reaches the caller in order, and a listener that throws does not stop the run;
 * - a run that times out or is stopped is a transient error, kills its process, leaves nothing in the cache and does not stop the
 *   next call from succeeding; two identical calls at once leave one cache entry and no temp directory;
 * - what the caller got wrong never reaches the binary: a missing, mistyped or out-of-workspace path, a non-finite anchor, no limit;
 * - what the binary does wrong is named, with whether a retry may help (the contract's transient flags): output that does not
 *   validate, files it did not write, a crash, its own failure line, an input it cannot read; a permanent failure is remembered
 *   (the binary is not run twice for it), a transient one is not;
 * - the CLI refuses what it cannot parse with its own failure line and a non-zero exit, and works in a directory whose name has a
 *   quote and a space in it (it used to call a shell to make it).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ScanFitError, ScanFitService } from '../src/node/3d-engine/scan-fit-service';
import { PathTraversalError } from '../src/node/security/path-guard';
import { SCAN_FIT_ERROR_TRANSIENT } from '../src/common/spatial/staged-location-contracts';
import * as S from './helpers/synthetic-structure-scan';

const REPO = fs.realpathSync(path.resolve(__dirname, '../../..'));
const LIMITS = { leafGeometricErrorM: 2.0064, meshEdgeP50M: 0.69, meshResolvableM: 0.69, texelM: 0.155, photoResolvableM: 0.31 };

let work: string;
let svc: ScanFitService;
let bin: string;
let scan: string;
const rel = (f: string) => path.relative(work, f);
const req = (extra: Record<string, unknown> = {}) => ({ scanGlb: scan, anchor: { x: 0, z: 0 }, sourceLimits: LIMITS, ...extra });
const cacheEntries = (s: ScanFitService) => (fs.existsSync(s.cacheDir) ? fs.readdirSync(s.cacheDir) : []);

/** A stand-in binary: a script that counts how often it is run and then does `body` (DIR is the --out-dir it was given). */
function fake(name: string, body: string): { service: ScanFitService; runs: () => number } {
    fs.mkdirSync(path.join(work, 'fake'), { recursive: true });
    const file = path.join(work, 'fake', name);
    const counter = `${file}.count`;
    fs.writeFileSync(file, `#!/bin/bash\necho x >> '${counter}'\nDIR=""\nwhile [ $# -gt 0 ]; do if [ "$1" = "--out-dir" ]; then DIR="$2"; fi; shift; done\n${body}\n`, { mode: 0o755 });
    const service = new ScanFitService({ workspaceRoot: work, repoRoot: REPO, binaryPath: file, cacheDir: `.cache-${name}` });
    return { service, runs: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean).length : 0) };
}

beforeAll(async () => {
    work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scan-fit-service-')));
    svc = new ScanFitService({ workspaceRoot: work, repoRoot: REPO });
    bin = await svc.ensureBinary();
    const dir = path.join(work, 'scenes');
    fs.mkdirSync(dir);
    scan = rel(S.lPlan(dir).glb);
}, 900_000);

afterAll(() => {
    if (work) fs.rmSync(work, { recursive: true, force: true });
});

describe('progress, time and stopping', () => {
    it('reports progress in order up to done, and a listener that throws does not stop the run', async () => {
        const events: Array<[number, string]> = [];
        let thrown = 0;
        const r = await svc.fit(req({
            anchor: { x: 5, z: 1 },
            onProgress: (f: number, m: string) => { events.push([f, m]); if (events.length === 2) { thrown++; throw new Error('a listener that fails'); } }
        }));
        expect(r.cached).toBe(false);
        expect(thrown).toBe(1);
        expect(events.length).toBeGreaterThanOrEqual(6);
        for (let i = 1; i < events.length; i++) expect(events[i][0], `${events[i - 1][1]} then ${events[i][1]}`).toBeGreaterThanOrEqual(events[i - 1][0]);
        expect(events[0][0]).toBeLessThan(0.1);
        expect(events[events.length - 1]).toEqual([1, 'done']);
        expect(events.every(([f, m]) => f >= 0 && f <= 1 && m.length > 0)).toBe(true);
        expect(events.map(e => e[1])).toEqual(expect.arrayContaining(['reading the scan', 'planes']));
        // a cached call has no run to report
        const again: number[] = [];
        const hit = await svc.fit(req({ anchor: { x: 5, z: 1 }, onProgress: (f: number) => again.push(f) }));
        expect(hit.cached).toBe(true);
        expect(again).toEqual([]);
    }, 120_000);

    it('a timeout kills the run, is transient, leaves no temp directory and no remembered failure, and the next call succeeds', async () => {
        const before = cacheEntries(svc).length;
        const err = await svc.fit(req({ anchor: { x: 6, z: 1 }, timeoutMs: 1 })).catch(e => e);
        expect(err).toBeInstanceOf(ScanFitError);
        expect(err.code).toBe('timeout');
        expect(err.transient).toBe(true);
        expect(cacheEntries(svc).filter(n => n.includes('.tmp-') || n.endsWith('.failed.json'))).toEqual([]);
        expect(cacheEntries(svc).length).toBe(before);
        const ok = await svc.fit(req({ anchor: { x: 6, z: 1 } }));
        expect(ok.value.accepted).toBe(true);
    }, 120_000);

    it('stopping a run that has started kills its process, is transient, and leaves the cache as it was', async () => {
        const ac = new AbortController();
        const before = cacheEntries(svc).length;
        const t0 = Date.now();
        const err = await svc.fit(req({ anchor: { x: 7, z: 1 }, signal: ac.signal, onProgress: (f: number) => { if (f >= 0.01) ac.abort(); } })).catch(e => e);
        expect(err).toBeInstanceOf(ScanFitError);
        expect(err.code).toBe('aborted');
        expect(err.transient).toBe(true);
        expect(Date.now() - t0).toBeLessThan(10_000);
        // the process is gone: none of the binary's arguments for this anchor is left running
        const ps = spawnSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).stdout;
        expect(ps.split('\n').filter(l => l.includes(bin) && l.includes('--anchor 7,1'))).toEqual([]);
        expect(cacheEntries(svc).filter(n => n.includes('.tmp-') || n.endsWith('.failed.json'))).toEqual([]);
        expect(cacheEntries(svc).length).toBe(before);
        const ok = await svc.fit(req({ anchor: { x: 7, z: 1 } }));
        expect(ok.value.accepted).toBe(true);
    }, 120_000);

    it('two identical calls at once both succeed and leave one cache entry and no temp directory', async () => {
        const before = new Set(cacheEntries(svc));
        const [a, b] = await Promise.all([svc.fit(req({ anchor: { x: 8, z: 2 } })), svc.fit(req({ anchor: { x: 8, z: 2 } }))]);
        expect(a.key).toBe(b.key);
        expect(a.value.buildingId).toBe(b.value.buildingId);
        expect(fs.existsSync(a.value.outputs.fittedGlb)).toBe(true);
        const added = cacheEntries(svc).filter(n => !before.has(n));
        expect(added).toEqual([a.key]);
    }, 120_000);
});

describe('what the caller got wrong never reaches the binary', () => {
    it('refuses a missing file, a mistyped one, a path outside the workspace, a non-finite anchor and no limit, without running anything', async () => {
        const { service, runs } = fake('refuse.sh', 'exit 0');
        const code = async (p: Promise<unknown>) => { const e = await p.catch(x => x); expect(e, 'it was refused').toBeInstanceOf(Error); return e; };
        const missing = await code(service.fit(req({ scanGlb: 'scenes/nothing_here.glb' })));
        expect(missing).toBeInstanceOf(ScanFitError);
        expect(missing.code).toBe('input_unreadable');
        const typed = await code(service.fit(req({ scanGlb: 'scenes/synthetic_lplan.json' })));
        expect(typed.code).toBe('input_unreadable');
        expect(typed.message).toMatch(/\.glb/);
        const outside = await code(service.fit(req({ scanGlb: '../../etc/hosts.glb' })));
        expect(outside).toBeInstanceOf(PathTraversalError);
        const absolute = await code(service.fit(req({ scanGlb: path.join(os.tmpdir(), 'elsewhere.glb') })));
        expect(absolute).toBeInstanceOf(PathTraversalError);
        const anchor = await code(service.fit(req({ anchor: { x: NaN, z: 0 } })));
        expect(anchor.code).toBe('input_unreadable');
        const limit = await code(service.fit(req({ sourceLimits: { ...LIMITS, leafGeometricErrorM: 0 } })));
        expect(limit.code).toBe('input_unreadable');
        const textured = await code(service.fit(req({ texturedGlb: 'scenes/nothing_here.glb' })));
        expect(textured.code).toBe('input_unreadable');
        expect(runs()).toBe(0);
        // the same for the other calls
        await expect(service.flatten({ inputGlb: 'scenes/nothing_here.glb' })).rejects.toMatchObject({ code: 'input_unreadable' });
        await expect(service.refit({ fitPath: 'scenes/nothing_here.json', scanGlb: scan, set: [] })).rejects.toMatchObject({ code: 'input_unreadable' });
        await expect(service.ornament({ fitPath: 'scenes/nothing_here.json', texturedGlb: scan, spec: {} as any })).rejects.toMatchObject({ code: 'input_unreadable' });
        expect(runs()).toBe(0);
    });

    it('refuses an ornament spec that is not an OrnamentSpec, naming where, and a fit with no fitted.glb beside it', async () => {
        const f = await svc.fit(req({ anchor: { x: 9, z: 0 } }));
        const bad = await svc.ornament({ fitPath: rel(f.path), texturedGlb: scan, spec: { schema: 'scratchbox.ornament-spec/2', elements: [{ id: 'x' }] } as any }).catch(e => e);
        expect(bad).toBeInstanceOf(ScanFitError);
        expect(bad.code).toBe('input_unreadable');
        expect(bad.message).toMatch(/OrnamentSpec/);
        fs.mkdirSync(path.join(work, 'alone'));
        fs.copyFileSync(f.path, path.join(work, 'alone', 'structure_fit.json'));
        const lonely = await svc.ornament({ fitPath: 'alone/structure_fit.json', texturedGlb: scan, spec: {} as any }).catch(e => e);
        expect(lonely.code).toBe('input_unreadable');
    }, 120_000);
});

describe('what the binary does wrong is named, and remembered only when a retry cannot help', () => {
    it('output that does not validate, and files it did not write, are invalid_output and permanent: the binary is not run twice for them', async () => {
        const junk = fake('junk.sh', 'echo \'{"schema":"nope"}\' > "$DIR/structure_fit.json"; : > "$DIR/fitted.glb"; : > "$DIR/outlines.glb"; echo \'{"ok":true}\'');
        const e1 = await junk.service.fit(req()).catch(e => e);
        expect(e1).toBeInstanceOf(ScanFitError);
        expect(e1.code).toBe('invalid_output');
        expect(e1.message).toMatch(/StructureFit/);
        expect(e1.transient).toBe(false);
        const e2 = await junk.service.fit(req()).catch(e => e);
        expect(e2.code).toBe('invalid_output');
        expect(junk.runs()).toBe(1);
        const empty = fake('empty.sh', 'echo \'{"ok":true}\'');
        const e3 = await empty.service.fit(req()).catch(e => e);
        expect(e3.code).toBe('invalid_output');
        expect(e3.message).toMatch(/did not write/);
        expect(cacheEntries(empty.service).filter(n => n.includes('.tmp-'))).toEqual([]);
    });

    it('its own failure line gives its own code; a crash is a crash; neither leaves a cache entry, and the permanent one is remembered', async () => {
        const own = fake('own.sh', 'echo \'{"ok":false,"code":"no_structure","message":"the scan is all ground"}\'; exit 2');
        const e1 = await own.service.fit(req()).catch(e => e);
        expect(e1.code).toBe('no_structure');
        expect(e1.message).toBe('the scan is all ground');
        expect(e1.transient).toBe(false);
        await own.service.fit(req()).catch(() => undefined);
        expect(own.runs()).toBe(1);
        const crash = fake('crash.sh', 'kill -SEGV $$');
        const e2 = await crash.service.fit(req()).catch(e => e);
        expect(e2.code).toBe('crashed');
        expect(e2.message).toMatch(/SEGV|signal|killed/i);
        const exit3 = fake('exit3.sh', 'echo "something broke" >&2; exit 3');
        const e3 = await exit3.service.fit(req()).catch(e => e);
        expect(e3.code).toBe('crashed');
        expect(e3.detail).toContain('something broke');
        // a code it has not heard of is transient: never remembered
        const alien = fake('alien.sh', 'echo \'{"ok":false,"code":"a_code_from_the_future","message":"?"}\'; exit 2');
        const e4 = await alien.service.fit(req()).catch(e => e);
        expect(e4.code).toBe('a_code_from_the_future');
        expect(e4.transient).toBe(true);
        await alien.service.fit(req()).catch(() => undefined);
        expect(alien.runs()).toBe(2);
        for (const c of Object.keys(SCAN_FIT_ERROR_TRANSIENT)) expect(new ScanFitError(c, 'x').transient).toBe((SCAN_FIT_ERROR_TRANSIENT as Record<string, boolean>)[c]);
    });

    it('a binary that is not there is build_failed (a later build may fix it), and is never remembered', async () => {
        const gone = new ScanFitService({ workspaceRoot: work, repoRoot: REPO, binaryPath: path.join(work, 'fake', 'not_built'), cacheDir: '.cache-gone' });
        const e = await gone.fit(req()).catch(x => x);
        expect(e).toBeInstanceOf(ScanFitError);
        expect(e.code).toBe('build_failed');
        expect(e.transient).toBe(true);
        expect(cacheEntries(gone)).toEqual([]);
    });

    it('a scan the binary cannot read is input_unreadable and permanent: a corrupt and a truncated GLB, and one with nothing in it', async () => {
        const real = fs.readFileSync(path.join(work, scan));
        fs.writeFileSync(path.join(work, 'scenes', 'garbage.glb'), Buffer.from('this is not a glb at all, just text '.repeat(40)));
        fs.writeFileSync(path.join(work, 'scenes', 'truncated.glb'), real.subarray(0, Math.floor(real.length / 3)));
        fs.writeFileSync(path.join(work, 'scenes', 'zero.glb'), Buffer.alloc(0));
        for (const name of ['garbage', 'truncated', 'zero']) {
            const e = await svc.fit(req({ scanGlb: `scenes/${name}.glb` })).catch(x => x);
            expect(e, name).toBeInstanceOf(ScanFitError);
            expect(e.code, `${name}: ${e.message}`).toBe('input_unreadable');
            expect(e.transient).toBe(false);
        }
        // and the second call for the same bytes is answered from memory of the failure
        const t0 = Date.now();
        const again = await svc.fit(req({ scanGlb: 'scenes/garbage.glb' })).catch(x => x);
        expect(again.code).toBe('input_unreadable');
        expect(Date.now() - t0).toBeLessThan(300);
    }, 120_000);
});

describe('the CLI', () => {
    const run = (args: string[]) => spawnSync(bin, args, { encoding: 'utf8' });
    const failure = (r: ReturnType<typeof run>) => JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop()!);

    it('says what it cannot parse as its own failure line with a non-zero exit, and what it was not given', () => {
        const none = run([]);
        expect(none.status).not.toBe(0);
        expect(`${none.stdout}${none.stderr}`).toMatch(/fit|usage/i);
        const unknown = run(['paint', '--scan', 'x.glb']);
        expect(unknown.status).not.toBe(0);
        expect(failure(unknown)).toMatchObject({ ok: false, code: 'bad_request' });
        const missing = run(['fit', '--scan', 'x.glb']);
        expect(missing.status).not.toBe(0);
        expect(failure(missing)).toMatchObject({ ok: false, code: 'bad_request' });
        expect(failure(missing).message).toMatch(/--anchor|--out-dir/);
        const anchor = run(['fit', '--scan', 'x.glb', '--anchor', '12', '--out-dir', path.join(work, 'cli-out')]);
        expect(failure(anchor)).toMatchObject({ ok: false, code: 'bad_request' });
        const nan = run(['fit', '--scan', 'x.glb', '--anchor', 'a,b', '--out-dir', path.join(work, 'cli-out')]);
        expect(failure(nan).code).toBe('bad_request');
        const positional = run(['fit', 'x.glb']);
        expect(failure(positional)).toMatchObject({ ok: false, code: 'bad_request' });
        const dangling = run(['fit', '--scan']);
        expect(failure(dangling)).toMatchObject({ ok: false, code: 'bad_request' });
        const unreadable = run(['fit', '--scan', path.join(work, 'nothing.glb'), '--anchor', '0,0', '--out-dir', path.join(work, 'cli-out')]);
        expect(failure(unreadable)).toMatchObject({ ok: false, code: 'input_unreadable' });
        const flat = run(['flatten', '--input', path.join(work, 'nothing.glb'), '--out', path.join(work, 'f.glb'), '--stats', path.join(work, 'f.json')]);
        expect(failure(flat)).toMatchObject({ ok: false, code: 'input_unreadable' });
    });

    it('writes into a directory whose name has a quote and a space in it', async () => {
        const odd = path.join(work, "it's a dir (with a space)");
        fs.mkdirSync(odd);
        fs.copyFileSync(path.join(work, scan), path.join(odd, 'scan.glb'));
        const service = new ScanFitService({ workspaceRoot: odd, repoRoot: REPO });
        const r = await service.fit({ scanGlb: 'scan.glb', anchor: { x: 5, z: 0 }, sourceLimits: LIMITS });
        expect(r.value.accepted).toBe(true);
        expect(fs.existsSync(r.value.outputs.fittedGlb)).toBe(true);
        expect(r.dir.startsWith(odd)).toBe(true);
        // no stray file from a shell that read the quote as the end of a word
        expect(fs.readdirSync(odd).filter(n => n !== 'scan.glb' && n !== '.scratchbox')).toEqual([]);
    }, 120_000);
});
