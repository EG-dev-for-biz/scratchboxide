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
 * result must be the one V8 gives, -0 and NaN included.
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
});
