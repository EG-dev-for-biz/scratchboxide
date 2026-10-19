/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The support a measured tree stands on (scratchbox_tile_vegetation.hpp detail::supportCluster), compiled with clang++:
 * the lowest height cluster holding a quarter of the surrounding samples, and, when the samples spread over more clusters
 * than that (none holding a quarter), the largest one. Before the fallback such a crown had an empty cluster and strip
 * read past an empty vector (a segfault on the Washington Square Park district tile, so the staged build fell back to
 * the scan's own trees).
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const INCLUDE = path.resolve(__dirname, '../src/native/3d-engine/include');

describe('tile_vegetation support cluster', () => {
    it('picks the lowest cluster holding a quarter, else the largest, never an empty one', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-support-'));
        const src = path.join(dir, 'main.cpp');
        fs.writeFileSync(src, `#include "scratchbox_tile_vegetation.hpp"
#include <cstdio>
using scratchbox::tile_vegetation::detail::supportCluster;
static void show(std::vector<float> y) { auto [lo, n] = supportCluster(y, 0.25); std::printf("%zu %zu\\n", lo, n); }
int main() {
    show({0.0f, 0.1f, 0.2f, 3.0f, 3.1f, 3.2f, 3.3f, 3.4f});            // lowest cluster (3 of 8) holds a quarter
    show({0.0f, 1.0f, 2.0f, 2.1f, 4.0f, 6.0f, 8.0f, 10.0f, 12.0f});     // 8 clusters, none a quarter: the largest (2.0, 2.1)
    show({0.0f, 1.0f, 2.0f, 3.0f, 4.0f, 5.0f});                         // all single: the lowest
    show({});                                                           // none
    return 0;
}
`);
        const bin = path.join(dir, 'main');
        const cc = spawnSync(process.env.CXX || 'clang++', ['-std=c++20', '-O1', '-pthread', `-I${INCLUDE}`, src, '-lz', '-o', bin], { encoding: 'utf8' });
        expect(cc.status, cc.stderr).toBe(0);
        const run = spawnSync(bin, { encoding: 'utf8' });
        expect(run.status).toBe(0);
        expect(run.stdout.trim().split('\n')).toEqual(['0 3', '2 2', '0 1', '0 0']);
        fs.rmSync(dir, { recursive: true, force: true });
    }, 180_000);
});
