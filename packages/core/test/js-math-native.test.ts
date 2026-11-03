/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The native kernels' JavaScript arithmetic (scratchbox_js_math.hpp) against this V8, bit for bit: a probe compiled
 * through the native build cache (with the kernels' flags) runs Math.log, Math.exp, Math.cbrt, Math.hypot, Math.round
 * and the typed-array stores over a million arguments (ordinary, tiny, huge, negative, the special values), and every
 * result must be the one V8 gives, -0 and NaN included; and String(n), Math.min and Math.max over signed zeros, and
 * Array.prototype.sort((x, y) => x - y) over 3000 arrays holding NaN and repeats, element for element.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { compileNativeCached, defaultNativeFlags } from '../src/node/3d-engine/native-build-cache';

const PROBE = `#include "scratchbox_js_math.hpp"
#include <cstdio>
#include <vector>
using namespace scratchbox;
int main() {
    std::vector<double> x;
    double v;
    while (std::fread(&v, 8, 1, stdin) == 1) x.push_back(v);
    const size_t n = x.size();
    std::vector<double> out(n * 9);
    for (size_t i = 0; i < n; ++i) {
        const double a = x[i], b = x[(i + 1) % n], c = x[(i + 2) % n];
        double* o = &out[i * 9];
        o[0] = js::log(a); o[1] = js::exp(a); o[2] = js::cbrt(a); o[3] = js::hypot({a, b}); o[4] = js::hypot({a, b, c});
        o[5] = js::round(a); o[6] = js::toUint8(a); o[7] = js::toInt16(a); o[8] = js::toInt32(a);
    }
    std::fwrite(out.data(), 8, out.size(), stdout);
}
`;

const SORT_PROBE = `#include "scratchbox_js_math.hpp"
#include <cstdio>
#include <string>
#include <vector>
using namespace scratchbox;
int main() {
    uint32_t nx, nz;
    std::fread(&nx, 4, 1, stdin); std::fread(&nz, 4, 1, stdin);
    std::vector<double> x(nx), z(nz);
    std::fread(x.data(), 8, nx, stdin); std::fread(z.data(), 8, nz, stdin);
    std::string text;
    for (size_t i = 0; i < nx; ++i) { if (i) text += '\\n'; text += js::toString(x[i]); }
    std::fwrite(text.data(), 1, text.size(), stdout);
    std::fputc(0, stdout);
    for (double a : z) for (double b : z) { const double m[2] = {js::min(a, b), js::max(a, b)}; std::fwrite(m, 8, 2, stdout); }
    uint32_t n;
    while (std::fread(&n, 4, 1, stdin) == 1) {
        std::vector<double> v(n);
        if (n) std::fread(v.data(), 8, n, stdin);
        js::sort(v, [](double a, double b) { return a - b; });
        std::fwrite(v.data(), 8, n, stdout);
    }
}
`;

function argumentsToTry(n: number): Float64Array {
    const xs = new Float64Array(n);
    let s = 0x9e3779b9;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
    const special = [0, -0, 1, -1, 0.5, -0.5, 1.5, 2.5, -2.5, 0.49999999999999994, 255.5, 256, -256.5, 32767.5, 65535.5, 2 ** 31, -(2 ** 31) - 0.5, 2 ** 52 + 1, Number.MIN_VALUE, Number.MAX_VALUE, Infinity, -Infinity, NaN, Math.E, Math.LN2, 709.78, -745.13, 1e-310];
    for (let i = 0; i < n; i++) {
        const k = i % 6;
        xs[i] = i < special.length ? special[i]
            : k === 0 ? rnd() * 12 - 2                          // around the photo and log-colour range
            : k === 1 ? (rnd() - 0.5) * 80                      // exp's range
            : k === 2 ? Math.exp((rnd() - 0.5) * 1400)          // tiny to huge
            : k === 3 ? Math.round(rnd() * 600) - 300 + (rnd() < 0.5 ? 0.5 : rnd()) // halves and stores
            : k === 4 ? rnd() * 1.2                             // the Lab cube root's range
            : -rnd() * 1e6;
    }
    return xs;
}

describe('scratchbox_js_math.hpp: JavaScript arithmetic, bit for bit with this V8', () => {
    it('Math.log, exp, cbrt, hypot and round, and the typed-array stores', async () => {
        const repo = path.resolve(__dirname, '../../..');
        const built = await compileNativeCached({ sourceCode: PROBE, includeDirs: [path.join(repo, 'packages/core/src/native/3d-engine/include')], flags: defaultNativeFlags(['-ffp-contract=off']), name: 'js_math_probe', timeoutMs: 300_000 });
        const xs = argumentsToTry(1_000_000), n = xs.length;
        const raw = execFileSync(built.binaryPath, { input: Buffer.from(xs.buffer), maxBuffer: n * 9 * 8 + 1024 });
        const got = new Float64Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
        expect(got.length).toBe(n * 9);
        const u8 = new Uint8Array(1), i16 = new Int16Array(1);
        const names = ['log', 'exp', 'cbrt', 'hypot2', 'hypot3', 'round', 'toUint8', 'toInt16', 'toInt32'];
        const differ = names.map(() => 0), first: Array<string | undefined> = names.map(() => undefined);
        for (let i = 0; i < n; i++) {
            const a = xs[i], b = xs[(i + 1) % n], c = xs[(i + 2) % n];
            u8[0] = a; i16[0] = a;
            const want = [Math.log(a), Math.exp(a), Math.cbrt(a), Math.hypot(a, b), Math.hypot(a, b, c), Math.round(a), u8[0], i16[0], a | 0];
            for (let k = 0; k < 9; k++) if (!Object.is(want[k], got[i * 9 + k])) { differ[k]++; first[k] ??= `${names[k]}(${a}): V8 ${want[k]}, native ${got[i * 9 + k]}`; }
        }
        expect(first.filter(Boolean)).toEqual([]);
        expect(differ).toEqual(names.map(() => 0));
    }, 300_000);

    it('String(n), Math.min and Math.max with signed zeros, and Array.prototype.sort over values holding NaN', async () => {
        const repo = path.resolve(__dirname, '../../..');
        const built = await compileNativeCached({ sourceCode: SORT_PROBE, includeDirs: [path.join(repo, 'packages/core/src/native/3d-engine/include')], flags: defaultNativeFlags(['-ffp-contract=off']), name: 'js_sort_probe', timeoutMs: 300_000 });
        // numbers to print and compare: the arguments above, and the zeros both ways round
        const xs = argumentsToTry(20_000), zeros = [0, -0, -0, 0, 0, 0, -0, -0, 1, -0];
        // arrays to sort with (x, y) => x - y: every length to 300 and longer ones (V8's runs and merges), NaN and repeats
        let s = 0x2545f491;
        const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
        const arrays = Array.from({ length: 3000 }, (_, t) => {
            const n = t < 300 ? t : Math.floor(rnd() * 900), nanShare = [0, 0.02, 0.1, 0.4, 0.9][t % 5], repeats = t % 3 === 0;
            const a = Array.from({ length: n }, () => (rnd() < nanShare ? NaN : repeats ? Math.floor(rnd() * 8) : rnd() * 100));
            if (t % 7 === 0) a.sort((x, y) => x - y);
            if (t % 11 === 0) a.reverse();
            return a;
        });
        const head = Buffer.alloc(8);
        head.writeUInt32LE(xs.length, 0); head.writeUInt32LE(zeros.length, 4);
        const parts = [head, Buffer.from(xs.buffer), Buffer.from(Float64Array.from(zeros).buffer)];
        for (const a of arrays) { const n = Buffer.alloc(4); n.writeUInt32LE(a.length); parts.push(n, Buffer.from(Float64Array.from(a).buffer)); }
        const raw = execFileSync(built.binaryPath, { input: Buffer.concat(parts), maxBuffer: 1 << 28 });
        let o = 0;
        const strings = raw.toString('utf8', 0, raw.indexOf(0)).split('\n');
        o = raw.indexOf(0) + 1;
        expect(strings.filter((v, i) => v !== String(xs[i]))).toEqual([]);
        const mm = new Float64Array(raw.buffer.slice(raw.byteOffset + o, raw.byteOffset + o + zeros.length * zeros.length * 2 * 8));
        o += mm.byteLength;
        for (let i = 0; i < zeros.length; i++) for (let j = 0; j < zeros.length; j++) {
            expect(Object.is(mm[(i * zeros.length + j) * 2], Math.min(zeros[i], zeros[j]))).toBe(true);
            expect(Object.is(mm[(i * zeros.length + j) * 2 + 1], Math.max(zeros[i], zeros[j]))).toBe(true);
        }
        const sorted = new Float64Array(raw.buffer.slice(raw.byteOffset + o));
        let at = 0, differ = 0;
        for (const a of arrays) {
            const want = [...a].sort((x, y) => x - y);
            if (want.some((v, i) => !Object.is(v, sorted[at + i]))) differ++;
            at += a.length;
        }
        expect(at).toBe(sorted.length);
        expect(differ).toBe(0);
    }, 300_000);
});
