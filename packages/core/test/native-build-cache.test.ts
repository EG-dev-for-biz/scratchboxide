/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The shared native build cache, with the real clang++ behind a wrapper that logs every compile:
 * - a change to a header included only through another header (two levels down) rebuilds; a touch does not;
 * - NativeCppCompilerService.compileSource hits the cache under a different output name, writes no .cpp on a hit,
 *   and stages each call's assets in its own directory, so concurrent calls never run against another call's assets;
 * - two different sources built concurrently under one name get their own binaries;
 * - another process reuses a build (a child process compiles nothing);
 * - the sky, de-lighting and groom services compile once and then run their one binary with new parameters;
 * - the PCH path follows header content; field remesh gets no -march=native unless SCRATCHBOX_NATIVE_ARCH=1;
 * - the Python module fingerprint is memoised (no source read when nothing changed) and still follows edits.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'module';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';
import { NativeCppCompilerService } from '../src/node/3d-engine/native-compiler-service';
import { NativeSkyService } from '../src/node/3d-engine/native-sky-service';
import { NativeTileLightingService } from '../src/node/3d-engine/native-tile-lighting-service';
import { AnalyticalGroomSplatService } from '../src/node/3d-engine/AnalyticalGroomSplatService';
import { FieldAlignedQuadRemeshService } from '../src/node/3d-engine/field-remesh-service';
import { NativePythonRunnerService } from '../src/node/3d-engine/native-python-runner-service';

let dir: string;
let log: string;
const saved = { cxx: process.env.CXX, cache: process.env.SCRATCHBOX_NATIVE_BUILD_CACHE, arch: process.env.SCRATCHBOX_NATIVE_ARCH };
const repoRoot = path.resolve(__dirname, '../../..');

/** Compiles of translation units the wrapper saw (a precompiled-header build is not one). */
function compileLines(): string[] {
    return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(l => l && !l.includes('c++-header')) : [];
}

beforeAll(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-build-cache-')));
    log = path.join(dir, 'compiles.log');
    const wrapper = path.join(dir, 'cxx.sh');
    fs.writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "--version" ]; then exec ${saved.cxx || 'clang++'} --version; fi\necho "$*" >> "${log}"\nexec ${saved.cxx || 'clang++'} "$@"\n`);
    fs.chmodSync(wrapper, 0o755);
    process.env.CXX = wrapper;
    process.env.SCRATCHBOX_NATIVE_BUILD_CACHE = path.join(dir, 'cache');
    delete process.env.SCRATCHBOX_NATIVE_ARCH;
});

afterAll(() => {
    for (const [name, value] of [['CXX', saved.cxx], ['SCRATCHBOX_NATIVE_BUILD_CACHE', saved.cache], ['SCRATCHBOX_NATIVE_ARCH', saved.arch]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('native build cache', () => {
    it('rebuilds when a header included through another header changes, and not when it is only touched', async () => {
        const inc = path.join(dir, 'inc1');
        fs.mkdirSync(path.join(inc, 'sub'), { recursive: true });
        fs.writeFileSync(path.join(inc, 'top.hpp'), '#pragma once\n#include "sub/deep.hpp"\ninline int top() { return deep() + 1; }\n');
        fs.writeFileSync(path.join(inc, 'sub', 'deep.hpp'), '#pragma once\ninline int deep() { return 10; }\n');
        fs.writeFileSync(path.join(inc, 'unrelated.hpp'), 'inline int z() { return 0; }\n');
        const source = path.join(dir, 'deep.cpp');
        fs.writeFileSync(source, '#include <cstdio>\n#include "top.hpp"\nint main() { std::printf("%d\\n", top()); return 0; }\n');
        const spec = { sourcePath: source, includeDirs: [inc], flags: defaultNativeFlags(), name: 'deep' };

        const before = compileLines().length;
        const first = await compileNativeCached(spec);
        expect(first.cacheHit).toBe(false);
        expect(execFileSync(first.binaryPath, { encoding: 'utf8' }).trim()).toBe('11');

        const later = new Date(Date.now() + 120_000);
        for (const f of ['top.hpp', 'sub/deep.hpp', 'unrelated.hpp']) fs.utimesSync(path.join(inc, f), later, later);
        fs.writeFileSync(path.join(inc, 'unrelated.hpp'), 'inline int z() { return 1; }\n');
        const touched = await compileNativeCached(spec);
        expect(touched.cacheHit).toBe(true);
        expect(touched.binaryPath).toBe(first.binaryPath);

        fs.writeFileSync(path.join(inc, 'sub', 'deep.hpp'), '#pragma once\ninline int deep() { return 20; }\n');
        const edited = await compileNativeCached(spec);
        expect(edited.cacheHit).toBe(false);
        expect(edited.key).not.toBe(first.key);
        expect(execFileSync(edited.binaryPath, { encoding: 'utf8' }).trim()).toBe('21');
        // the first build is untouched by the second (entries are never rewritten)
        expect(execFileSync(first.binaryPath, { encoding: 'utf8' }).trim()).toBe('11');
        expect(compileLines().length - before).toBe(2);
    }, 120_000);

    it('builds two different sources concurrently under one name into their own binaries', async () => {
        const make = (n: number) => ({ sourceCode: `#include <cstdio>\nint main() { std::printf("${n}\\n"); return 0; }\n`, includeDirs: [], flags: defaultNativeFlags(), name: 'same_name' });
        const [a, b] = await Promise.all([compileNativeCached(make(1)), compileNativeCached(make(2))]);
        expect(a.binaryPath).not.toBe(b.binaryPath);
        expect(execFileSync(a.binaryPath, { encoding: 'utf8' }).trim()).toBe('1');
        expect(execFileSync(b.binaryPath, { encoding: 'utf8' }).trim()).toBe('2');
    }, 120_000);

    it('compileSource: a hit under another output name compiles nothing and writes no .cpp', async () => {
        const compiler = new NativeCppCompilerService();
        const out = path.join(dir, 'cs');
        const src = '#include <cstdio>\nint main() { std::printf("cached\\n"); return 0; }\n';
        const before = compileLines().length;
        const first = await compiler.compileSource(src, { outputDir: out, outputBinaryName: 'first', optimization: '-O0' });
        expect(first.success).toBe(true);
        const second = await compiler.compileSource(src, { outputDir: out, outputBinaryName: 'second', optimization: '-O0' });
        expect(second.success).toBe(true);
        expect(second.cacheHit).toBe(true);
        expect(second.compilerOutput).toContain('Hit compilation cache');
        expect(second.binaryPath).toBe(path.join(out, 'second'));
        expect(compileLines().length - before).toBe(1);
        expect(fs.readdirSync(out).filter(f => f.endsWith('.cpp'))).toEqual([]);
        expect(execFileSync(second.binaryPath!, { encoding: 'utf8' }).trim()).toBe('cached');
    }, 120_000);

    it('compileSource: concurrent calls with assets each run against their own assets', async () => {
        const compiler = new NativeCppCompilerService();
        const cwd = process.cwd();
        process.chdir(dir); // the default output directory is <cwd>/build/3d-native
        try {
            const src = '#include <cstdio>\n#include <fstream>\n#include <string>\nint main() { std::ifstream in("payload.txt"); std::string s; std::getline(in, s); std::printf("%s\\n", s.c_str()); return 0; }\n';
            const [a, b] = await Promise.all(['alpha', 'beta'].map(v => compiler.compileSource(src, { optimization: '-O0', assets: [{ name: 'payload.txt', content: v, encoding: 'utf8' }] })));
            expect(a.success && b.success).toBe(true);
            const [ra, rb] = await Promise.all([compiler.executeBinary(a.binaryPath!), compiler.executeBinary(b.binaryPath!)]);
            expect(ra.stdout.trim()).toBe('alpha');
            expect(rb.stdout.trim()).toBe('beta');
        } finally {
            process.chdir(cwd);
        }
    }, 120_000);

    it('another process reuses a build: the child compiles nothing', async () => {
        const src = '#include <cstdio>\nint main() { std::printf("shared\\n"); return 0; }\n';
        const spec = { sourceCode: src, includeDirs: [], flags: defaultNativeFlags(), name: 'shared' };
        const parent = await compileNativeCached(spec);
        const before = compileLines().length;
        const script = path.join(dir, 'child.js');
        fs.writeFileSync(script, `require(${JSON.stringify(path.join(repoRoot, 'node_modules/ts-node'))}).register({ transpileOnly: true, compilerOptions: { module: 'commonjs' } });
const { compileNativeCached, defaultNativeFlags } = require(${JSON.stringify(path.join(repoRoot, 'packages/core/src/node/3d-engine/native-build-cache.ts'))});
compileNativeCached({ sourceCode: ${JSON.stringify(src)}, includeDirs: [], flags: defaultNativeFlags(), name: 'shared' })
  .then(r => { process.stdout.write(JSON.stringify(r)); }, e => { console.error(e); process.exit(1); });\n`);
        const child = JSON.parse(execFileSync(process.execPath, [script], { encoding: 'utf8', cwd: repoRoot, env: process.env }));
        expect({ key: child.key, hit: child.cacheHit }).toEqual({ key: parent.key, hit: true });
        expect(child.binaryPath).toBe(parent.binaryPath);
        expect(compileLines().length).toBe(before);
    }, 120_000);
});

describe('services compile once and pass parameters at run time', () => {
    it('sky: the second sky (another sun) compiles nothing and differs', async () => {
        const sky = new NativeSkyService();
        const before = compileLines().length;
        const a = await sky.generatePhysicalSkyEquirectangular({ sunDirection: [0.3, 0.5, 0.81], width: 32, height: 16 });
        const b = await sky.generatePhysicalSkyEquirectangular({ sunDirection: [0.1, 0.9, 0.42], width: 32, height: 16 });
        expect(a.success && b.success).toBe(true);
        expect(compileLines().length - before).toBe(1);
        expect(b.compilationTimeMs).toBe(0);
        expect(Buffer.from(a.rgbFloats.buffer).equals(Buffer.from(b.rgbFloats.buffer))).toBe(false);
    }, 180_000);

    it('de-lighting: a second call with other weights compiles nothing', async () => {
        const lighting = new NativeTileLightingService();
        const mesh = { vertices: [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1], indices: [0, 1, 2, 0, 2, 3], uvs: [0, 0, 1, 0, 1, 1, 0, 1], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0] };
        const tex = { width: 16, height: 16, rgbBytes: Buffer.alloc(16 * 16 * 3, 120) };
        const before = compileLines().length;
        await lighting.delightTextureAndRelight(mesh, tex, [0.3, 0.8, 0.2], { epsilonClamp: 0.1 });
        await lighting.delightTextureAndRelight(mesh, tex, [0.5, 0.6, 0.1], { epsilonClamp: 0.2, rtaoSamplesPerVertex: 4 });
        expect(compileLines().length - before).toBe(1);
    }, 180_000);

    it('groom: the second groom (another contract) compiles nothing and leaves no binary or source in its output', async () => {
        const groom = AnalyticalGroomSplatService.getInstance();
        const mk = (id: string, length: number) => groom.buildContract({
            id,
            surface: { baseRadius: 0.5, harmonicFrequency: 5, harmonicAmplitude: 0.4 },
            groom: { length, eumelanin: 0.1, pheomelanin: 0.3, guideCount: 8, strandCount: 32, segmentsPerStrand: 6 },
            splat: { exportFormat: 'all' }
        });
        const before = compileLines().length;
        const a = await groom.executeGroomSplat(mk('cache_groom_a', 0.15), { outputDir: path.join(dir, 'groom_a') });
        const b = await groom.executeGroomSplat(mk('cache_groom_b', 0.25), { outputDir: path.join(dir, 'groom_b') });
        expect(a.error).toBeUndefined();
        expect(a.success && b.success).toBe(true);
        expect(compileLines().length - before).toBe(1);
        expect(b.compilationTimeMs).toBe(0);
        expect(fs.readdirSync(path.join(dir, 'groom_b')).sort()).toEqual(['cache_groom_b.glb', 'cache_groom_b.ply', 'cache_groom_b.spz']);
        // the GLB export (surfel mesh) is a real glTF binary
        expect(fs.readFileSync(b.glbPath!).readUInt32LE(0)).toBe(0x46546c67);
        expect(fs.readFileSync(a.plyPath!).equals(fs.readFileSync(b.plyPath!))).toBe(false);
    }, 180_000);
});

describe('build flags and fingerprints', () => {
    it('the PCH path follows the engine headers (content, and mtime, which clang checks a PCH against)', () => {
        const inc = path.join(dir, 'pch_inc');
        fs.mkdirSync(inc, { recursive: true });
        fs.writeFileSync(path.join(inc, 'scratchbox_engine.hpp'), '#include "scratchbox_part.hpp"\n');
        fs.writeFileSync(path.join(inc, 'scratchbox_part.hpp'), 'inline int part() { return 1; }\n');
        const compiler = new NativeCppCompilerService(inc);
        const a = compiler.getPchPath();
        expect(compiler.getPchPath()).toBe(a);
        const later = new Date(Date.now() + 60_000);
        fs.utimesSync(path.join(inc, 'scratchbox_part.hpp'), later, later);
        const b = compiler.getPchPath();
        expect(b).not.toBe(a);
        fs.writeFileSync(path.join(inc, 'scratchbox_part.hpp'), 'inline int part() { return 2; }\n');
        fs.utimesSync(path.join(inc, 'scratchbox_part.hpp'), later, later);
        expect(compiler.getPchPath()).not.toBe(b);
    });

    it('field remesh builds through the cache without -march=native unless SCRATCHBOX_NATIVE_ARCH=1', async () => {
        const cwd = process.cwd();
        const work = path.join(dir, 'remesh');
        fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
        fs.copyFileSync(path.join(repoRoot, 'scripts/run_field_remesh_pipeline.cpp'), path.join(work, 'scripts/run_field_remesh_pipeline.cpp'));
        process.chdir(work);
        try {
            const before = compileLines().length;
            const bin = await new FieldAlignedQuadRemeshService().ensureBinary();
            const lines = compileLines().slice(before);
            expect(lines.length).toBe(1);
            expect(lines[0]).toContain('run_field_remesh_pipeline.cpp');
            expect(lines[0]).not.toContain('-march=native');
            expect(fs.statSync(bin).isFile()).toBe(true);
        } finally {
            process.chdir(cwd);
        }
    }, 300_000);

    it('the Python module fingerprint reads no source when nothing changed and follows an edit', () => {
        const engine = path.join(dir, 'engine');
        fs.mkdirSync(path.join(engine, 'include'), { recursive: true });
        fs.writeFileSync(path.join(engine, 'CMakeLists.txt'), 'project(x)\n');
        fs.writeFileSync(path.join(engine, 'include', 'a.hpp'), 'int a();\n');
        const runner = NativePythonRunnerService.getInstance() as any;
        const first = runner.computeNativeSourceFingerprint(engine);
        // count reads through the CommonJS fs object, propagated to the ESM bindings the service imported
        const cjsFs = createRequire(__filename)('fs') as typeof fs;
        const real = cjsFs.readFileSync;
        const reads: string[] = [];
        (cjsFs as any).readFileSync = (...args: any[]) => { reads.push(String(args[0])); return (real as any)(...args); };
        syncBuiltinESMExports();
        try {
            expect(runner.computeNativeSourceFingerprint(engine)).toBe(first);
        } finally {
            (cjsFs as any).readFileSync = real;
            syncBuiltinESMExports();
        }
        expect(reads.filter(f => f.startsWith(engine))).toEqual([]);
        fs.writeFileSync(path.join(engine, 'include', 'a.hpp'), 'int b();\n');
        expect(runner.computeNativeSourceFingerprint(engine)).not.toBe(first);
    });
});
