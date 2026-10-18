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
 * program compiled with the real clang++ through a logging wrapper, over the shared native build cache: a binary is
 * rebuilt only when the content of a file it was compiled from changes (not when an unrelated header in the include
 * directory does, nor when a used one is only touched), concurrent builds compile once
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
import { defaultNativeFlags, nativeBuildKey } from '../src/node/3d-engine/native-build-cache';
import { TileVegetationService } from '../src/node/3d-engine/tile-vegetation-service';

let dir: string;
let log: string;
const savedCxx = process.env.CXX;
const savedCache = process.env.SCRATCHBOX_NATIVE_BUILD_CACHE;

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
    fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then exec ${savedCxx || 'clang++'} --version; fi\necho "$$" >> "${log}"\nif [ -n "$NB_SWAP_LOCK" ]; then printf '%s' "$NB_SWAP_HOLDER" > "$NB_SWAP_LOCK"; fi\nexec ${savedCxx || 'clang++'} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    process.env.CXX = wrapper;
    process.env.SCRATCHBOX_NATIVE_BUILD_CACHE = path.join(dir, 'cache');
});

afterAll(() => {
    if (savedCxx === undefined) delete process.env.CXX;
    else process.env.CXX = savedCxx;
    if (savedCache === undefined) delete process.env.SCRATCHBOX_NATIVE_BUILD_CACHE;
    else process.env.SCRATCHBOX_NATIVE_BUILD_CACHE = savedCache;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildNativeIfStale', () => {
    const spec = () => ({ source: path.join(dir, 'prog.cpp'), binary: path.join(dir, 'build', 'prog'), includeDir: path.join(dir, 'include') });
    /** The cache entry the current sources of spec() build into. */
    const entry = () => path.join(dir, 'cache', nativeBuildKey({ sourcePath: spec().source, includeDirs: [spec().includeDir], flags: defaultNativeFlags(), name: 'prog' }).key);
    const lockOf = () => path.join(entry(), 'bin.lock');

    it('compiles once for concurrent callers, and the binary runs', async () => {
        const [a, b, c] = await Promise.all([buildNativeIfStale(spec()), buildNativeIfStale(spec()), buildNativeIfStale(spec())]);
        expect(new Set([a, b, c]).size).toBe(1);
        expect(compiles()).toBe(1);
        expect(execFileSync(a, { encoding: 'utf8' }).trim()).toBe('42');
        // the build key covers the header it includes, not the other one in the directory
        const { files } = nativeBuildKey({ sourcePath: spec().source, includeDirs: [spec().includeDir], flags: defaultNativeFlags(), name: 'prog' });
        expect(files.map(f => path.basename(f))).toEqual(['used.hpp']);
        expect(fs.existsSync(lockOf())).toBe(false);
        // the placed binary is the cache entry itself (a hard link), not a copy
        expect(fs.statSync(a).ino).toBe(fs.statSync(path.join(entry(), 'bin')).ino);
    }, 300_000);

    it('does not rebuild for an unrelated header or a touch, does for an edit of one it was compiled from, and reuses the old build when the edit is undone', async () => {
        const before = compiles();
        touchLater(path.join(dir, 'include', 'unrelated.hpp'), 60);
        touchLater(path.join(dir, 'include', 'used.hpp'), 60);
        touchLater(path.join(dir, 'prog.cpp'), 60);
        expect(nativeBinaryIsFresh(spec())).toBe(true);
        await buildNativeIfStale(spec());
        expect(compiles()).toBe(before);

        fs.writeFileSync(path.join(dir, 'include', 'used.hpp'), 'inline int answer() { return 43; }\n');
        expect(nativeBinaryIsFresh(spec())).toBe(false);
        await buildNativeIfStale(spec());
        expect(compiles()).toBe(before + 1);
        expect(execFileSync(spec().binary, { encoding: 'utf8' }).trim()).toBe('43');

        // an edit undone (with an older mtime, as a restore would leave it) goes back to the first build, compiling nothing
        fs.writeFileSync(path.join(dir, 'include', 'used.hpp'), 'inline int answer() { return 42; }\n');
        const old = new Date(Date.now() - 3600_000);
        fs.utimesSync(path.join(dir, 'include', 'used.hpp'), old, old);
        await buildNativeIfStale(spec());
        expect(compiles()).toBe(before + 1);
        expect(execFileSync(spec().binary, { encoding: 'utf8' }).trim()).toBe('42');
    }, 300_000);

    it('takes over a lock left by a dead process and removes the temp files a killed build left', async () => {
        const { binary } = spec();
        fs.writeFileSync(path.join(dir, 'include', 'used.hpp'), 'inline int answer() { return 44; }\n');
        // a pid that cannot be alive, holding the entry's lock, with half-written binaries of its own (in the entry and placed)
        fs.mkdirSync(entry(), { recursive: true });
        fs.writeFileSync(lockOf(), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
        fs.writeFileSync(path.join(entry(), `bin.tmp-${2 ** 22 + 12345}-1`), 'partial');
        fs.writeFileSync(`${binary}.tmp-${2 ** 22 + 12345}-1`, 'partial');
        await buildNativeIfStale(spec());
        expect(execFileSync(binary, { encoding: 'utf8' }).trim()).toBe('44');
        expect(fs.readdirSync(path.dirname(binary)).filter(f => f.includes('.tmp-'))).toEqual([]);
        expect(fs.readdirSync(entry()).filter(f => f.includes('.tmp-'))).toEqual([]);
        expect(fs.existsSync(lockOf())).toBe(false);
    }, 300_000);

    it('does not take over a fresh lock it cannot read yet, and builds once it is released', async () => {
        const { binary } = spec();
        fs.writeFileSync(path.join(dir, 'include', 'used.hpp'), 'inline int answer() { return 45; }\n');
        // a lock another process has just created (its holder record not readable yet)
        const lock = lockOf();
        fs.mkdirSync(path.dirname(lock), { recursive: true });
        fs.writeFileSync(lock, '');
        const before = compiles();
        const build = buildNativeIfStale(spec());
        await new Promise(resolve => setTimeout(resolve, 1500));
        expect(compiles()).toBe(before);
        expect(fs.existsSync(lock)).toBe(true);
        fs.rmSync(lock);
        await build;
        expect(compiles()).toBe(before + 1);
        expect(execFileSync(binary, { encoding: 'utf8' }).trim()).toBe('45');
    }, 300_000);

    it('never removes a lock another process holds when it finishes', async () => {
        const { binary } = spec();
        const other = JSON.stringify({ pid: process.ppid, at: Date.now(), token: 'another-process' });
        fs.writeFileSync(path.join(dir, 'include', 'used.hpp'), 'inline int answer() { return 46; }\n');
        const lock = lockOf();
        process.env.NB_SWAP_LOCK = lock;
        process.env.NB_SWAP_HOLDER = other;
        try {
            await buildNativeIfStale(spec());
        } finally {
            delete process.env.NB_SWAP_LOCK;
            delete process.env.NB_SWAP_HOLDER;
        }
        expect(execFileSync(binary, { encoding: 'utf8' }).trim()).toBe('46');
        expect(fs.readFileSync(lock, 'utf8')).toBe(other);
        fs.rmSync(lock);
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
