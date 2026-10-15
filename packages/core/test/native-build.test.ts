/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * native-build (used by SbVeggieService, BotanicalVegetationService and TileVegetationService) on a tiny real C++
 * program compiled with the real clang++ through a logging wrapper: a binary is rebuilt only when a file it was
 * compiled from changes (not when an unrelated header in the include directory does), concurrent builds compile once
 * (two TileVegetationService instances, as two processes would, too), a lock left by a dead process is taken over but
 * a fresh one that cannot be read yet is not, a build never removes a lock it does not hold, temp files a killed build
 * left behind are removed, and a failed build throws without keeping a stale binary in use.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildNativeIfStale, nativeBinaryIsFresh } from '../src/node/3d-engine/native-build';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';

let dir: string;
let log: string;
const savedCxx = process.env.CXX;

function compiles(): number {
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0;
}

function touchLater(file: string, seconds: number): void {
    const t = new Date(Date.now() + seconds * 1000);
    fs.utimesSync(file, t, t);
}

beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-build-')));
    fs.mkdirSync(path.join(dir, 'include'));
    fs.writeFileSync(path.join(dir, 'include', 'used.hpp'), 'inline int answer() { return 42; }\n');
    fs.writeFileSync(path.join(dir, 'include', 'unrelated.hpp'), 'inline int other() { return 7; }\n');
    fs.writeFileSync(path.join(dir, 'prog.cpp'), '#include "used.hpp"\n#include <cstdio>\nint main() { std::printf("%d\\n", answer()); return 0; }\n');
    // a compiler wrapper that logs every compile, so the test can count them
    log = path.join(dir, 'compiles.log');
    const wrapper = path.join(dir, 'cxx.sh');
    // NB_SWAP_LOCK: while compiling, another process takes the lock over (its holder record replaces the file)
    fs.writeFileSync(wrapper, `#!/bin/sh\necho "$$" >> "${log}"\nif [ -n "$NB_SWAP_LOCK" ]; then printf '%s' "$NB_SWAP_HOLDER" > "$NB_SWAP_LOCK"; fi\nexec ${savedCxx || 'clang++'} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    process.env.CXX = wrapper;
});

afterAll(() => {
    if (savedCxx === undefined) delete process.env.CXX;
    else process.env.CXX = savedCxx;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildNativeIfStale', () => {
    const spec = () => ({ source: path.join(dir, 'prog.cpp'), binary: path.join(dir, 'build', 'prog'), includeDir: path.join(dir, 'include') });

    it('compiles once for concurrent callers, and the binary runs', async () => {
        const [a, b, c] = await Promise.all([buildNativeIfStale(spec()), buildNativeIfStale(spec()), buildNativeIfStale(spec())]);
        expect(new Set([a, b, c]).size).toBe(1);
        expect(compiles()).toBe(1);
        expect(execFileSync(a, { encoding: 'utf8' }).trim()).toBe('42');
        // its dependency list names the header it includes, not the other one in the directory
        const deps = fs.readFileSync(`${a}.d`, 'utf8');
        expect(deps).toContain('used.hpp');
        expect(deps).not.toContain('unrelated.hpp');
        expect(fs.existsSync(`${a}.lock`)).toBe(false);
    }, 300_000);

    it('does not rebuild for an unrelated header, and does for one it was compiled from', async () => {
        const before = compiles();
        touchLater(path.join(dir, 'include', 'unrelated.hpp'), 60);
        expect(nativeBinaryIsFresh(spec().binary)).toBe(true);
        await buildNativeIfStale(spec());
        expect(compiles()).toBe(before);

        fs.writeFileSync(path.join(dir, 'include', 'used.hpp'), 'inline int answer() { return 43; }\n');
        touchLater(path.join(dir, 'include', 'used.hpp'), 120);
        expect(nativeBinaryIsFresh(spec().binary)).toBe(false);
        await buildNativeIfStale(spec());
        expect(compiles()).toBe(before + 1);
        expect(execFileSync(spec().binary, { encoding: 'utf8' }).trim()).toBe('43');
    }, 300_000);

    it('takes over a lock left by a dead process and removes the temp files a killed build left', async () => {
        const { binary } = spec();
        // a pid that cannot be alive, holding the lock, with a half-written binary of its own
        fs.writeFileSync(`${binary}.lock`, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
        fs.writeFileSync(`${binary}.tmp-${2 ** 22 + 12345}-1`, 'partial');
        fs.writeFileSync(path.join(dir, 'include', 'used.hpp'), 'inline int answer() { return 44; }\n');
        touchLater(path.join(dir, 'include', 'used.hpp'), 180);
        await buildNativeIfStale(spec());
        expect(execFileSync(binary, { encoding: 'utf8' }).trim()).toBe('44');
        expect(fs.readdirSync(path.dirname(binary)).filter(f => f.includes('.tmp-'))).toEqual([]);
        expect(fs.existsSync(`${binary}.lock`)).toBe(false);
    }, 300_000);

    it('does not take over a fresh lock it cannot read yet, and builds once it is released', async () => {
        const { binary } = spec();
        // a lock another process has just created (its holder record not readable yet)
        fs.writeFileSync(`${binary}.lock`, '');
        fs.writeFileSync(path.join(dir, 'include', 'used.hpp'), 'inline int answer() { return 45; }\n');
        touchLater(path.join(dir, 'include', 'used.hpp'), 240);
        const before = compiles();
        const build = buildNativeIfStale(spec());
        await new Promise(resolve => setTimeout(resolve, 1500));
        expect(compiles()).toBe(before);
        expect(fs.existsSync(`${binary}.lock`)).toBe(true);
        fs.rmSync(`${binary}.lock`);
        await build;
        expect(compiles()).toBe(before + 1);
        expect(execFileSync(binary, { encoding: 'utf8' }).trim()).toBe('45');
    }, 300_000);

    it('never removes a lock another process holds when it finishes', async () => {
        const { binary } = spec();
        const other = JSON.stringify({ pid: process.ppid, at: Date.now(), token: 'another-process' });
        fs.writeFileSync(path.join(dir, 'include', 'used.hpp'), 'inline int answer() { return 46; }\n');
        touchLater(path.join(dir, 'include', 'used.hpp'), 300);
        process.env.NB_SWAP_LOCK = `${binary}.lock`;
        process.env.NB_SWAP_HOLDER = other;
        try {
            await buildNativeIfStale(spec());
        } finally {
            delete process.env.NB_SWAP_LOCK;
            delete process.env.NB_SWAP_HOLDER;
        }
        expect(execFileSync(binary, { encoding: 'utf8' }).trim()).toBe('46');
        expect(fs.readFileSync(`${binary}.lock`, 'utf8')).toBe(other);
        fs.rmSync(`${binary}.lock`);
    }, 300_000);

    it('TileVegetationService builds through it: two services (as two processes) compile once, and a killed build\'s temp is removed', async () => {
        const repo = path.join(dir, 'repo');
        const include = path.join(repo, 'packages', 'core', 'src', 'native', '3d-engine', 'include');
        fs.mkdirSync(include, { recursive: true });
        fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(repo, 'build', '3d-native'), { recursive: true });
        fs.writeFileSync(path.join(include, 'tv.hpp'), 'inline int tv() { return 7; }\n');
        fs.writeFileSync(path.join(repo, 'scripts', 'tile_vegetation.cpp'), '#include "tv.hpp"\n#include <cstdio>\nint main() { std::printf("%d\\n", tv()); return 0; }\n');
        const orphan = path.join(repo, 'build', '3d-native', `tile_vegetation.tmp-${2 ** 22 + 4321}.deadbeef`);
        fs.writeFileSync(orphan, 'partial');
        const before = compiles();
        const a = new TileVegetationService({ workspaceRoot: dir, repoRoot: repo, cacheDir: 'cache_a' });
        const b = new TileVegetationService({ workspaceRoot: dir, repoRoot: repo, cacheDir: 'cache_b' });
        const [binA, binB] = await Promise.all([a.ensureBinary(), b.ensureBinary()]);
        expect(binA).toBe(binB);
        expect(compiles()).toBe(before + 1);
        expect(execFileSync(binA, { encoding: 'utf8' }).trim()).toBe('7');
        expect(fs.existsSync(orphan)).toBe(false);
        expect(fs.existsSync(`${binA}.lock`)).toBe(false);
    }, 300_000);

    it('fails with the compiler output when the source does not compile, and keeps no lock or temp file', async () => {
        fs.writeFileSync(path.join(dir, 'broken.cpp'), 'int main() { return undefined_name; }\n');
        const binary = path.join(dir, 'build', 'broken');
        const err = await buildNativeIfStale({ source: path.join(dir, 'broken.cpp'), binary, includeDir: path.join(dir, 'include') }).catch(e => e);
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toContain('could not build broken');
        expect(err.message).toContain('undefined_name');
        expect(fs.existsSync(binary)).toBe(false);
        expect(fs.readdirSync(path.dirname(binary)).filter(f => f.startsWith('broken.'))).toEqual([]);
    }, 300_000);
});
