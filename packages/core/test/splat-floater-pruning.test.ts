/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * kNN floater pruning: injected outliers are removed and the surface is kept, in the TypeScript bakes and in the
 * native fusion (scratchbox_splat_floater_prune.hpp, compiled here with clang++), which must agree with each other.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computeFloaterKeepMask, pruneSplatFloaters } from '../src/common/spatial/splat-floater-pruning';
import { SplatService } from '../src/node/3d-engine/splat-service';
import { DepthBoxInferenceService } from '../src/node/3d-engine/depthbox-inference-service';
import { requireBinary, withReason } from './helpers/requirements';

function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/**
 * A depth-image-like surface: a wall whose sample spacing grows with depth (2..52 m) and a ground plane seen at grazing
 * angles, plus floaters: isolated points off the surface and small clusters of 3 (flying-pixel clumps).
 */
function scene(side: number, seed: number) {
    const r = rng(seed);
    const pts: number[] = [];
    for (let i = 0; i < side * side; i++) {
        const x = i % side, y = Math.floor(i / side), d = 2 + 50 * y / side;
        pts.push((x - side / 2) * d * 0.001, 1 + (y / side) * 3, -d);
    }
    // Ground at y = 0 seen from 1.6 m: rows at depths 1.6 / tan(angle), so spacing along depth explodes with distance.
    for (let row = 0; row < side; row++) {
        const ang = (2 + 40 * row / side) * Math.PI / 180, d = Math.min(60, 1.6 / Math.tan(ang));
        for (let c = 0; c < side; c++) pts.push((c - side / 2) * d * 0.0015, 0, -d);
    }
    const surface = pts.length / 3;
    // Floaters sit at least 0.5 m from every surface sample (closer than the surface's own row spacing, which reaches
    // 0.5 m on the far wall, a point is part of the surface as far as any sampling-based test can tell).
    const offSurface = (x: number, y: number, z: number) => {
        for (let j = 0; j < surface; j++) if (Math.hypot(pts[j * 3] - x, pts[j * 3 + 1] - y, pts[j * 3 + 2] - z) < 0.5) return false;
        return true;
    };
    for (let placed = 0; placed < 60; ) {
        const x = (r() - 0.5) * 30, y = 0.5 + r() * 8, z = -3 - r() * 45;
        if (offSurface(x, y, z)) { pts.push(x, y, z); placed++; }
    }
    for (let placed = 0; placed < 15; ) {
        const cx = (r() - 0.5) * 20, cy = 1 + r() * 5, cz = -5 - r() * 30;
        if (!offSurface(cx, cy, cz)) continue;
        for (let k = 0; k < 3; k++) pts.push(cx + (r() - 0.5) * 0.05, cy + (r() - 0.5) * 0.05, cz + (r() - 0.5) * 0.05);
        placed++;
    }
    return { pos: new Float64Array(pts), count: pts.length / 3, surface };
}

describe('kNN floater pruning (TypeScript)', () => {
    it('removes every injected floater and keeps every surface splat', () => {
        const { pos, count, surface } = scene(220, 1);
        const { keep, report } = computeFloaterKeepMask(pos, count);
        let surfaceLost = 0, floatersKept = 0;
        for (let i = 0; i < count; i++) { if (i < surface && !keep[i]) surfaceLost++; if (i >= surface && keep[i]) floatersKept++; }
        console.log(`[floater-prune] ${count} splats: pruned ${report.pruned} in ${report.ms} ms (k=${report.k}, mean r=${report.statMean.toFixed(3)}, std=${report.statStd.toFixed(3)}, tau=${report.threshold.toFixed(2)})`);
        expect(floatersKept).toBe(0);
        expect(surfaceLost).toBe(0);
        expect(report.pruned).toBe(count - surface);
    });

    it('is deterministic and independent of input order', () => {
        const { pos, count } = scene(120, 2);
        const a = computeFloaterKeepMask(pos, count).keep;
        const b = computeFloaterKeepMask(pos, count).keep;
        expect(Array.from(a)).toEqual(Array.from(b));
        const r = rng(9), perm = Array.from({ length: count }, (_, i) => i);
        for (let i = count - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
        const shuffled = new Float64Array(count * 3);
        perm.forEach((src, dst) => shuffled.set(pos.subarray(src * 3, src * 3 + 3), dst * 3));
        const c = computeFloaterKeepMask(shuffled, count).keep;
        perm.forEach((src, dst) => expect(c[dst]).toBe(a[src]));
    });

    it('the absolute (un-normalised) test would cut into the far field; the default does not', () => {
        const { pos, count, surface } = scene(220, 1);
        const abs = computeFloaterKeepMask(pos, count, { normalize: false }).keep;
        let lost = 0;
        for (let i = 0; i < surface; i++) if (!abs[i]) lost++;
        expect(lost).toBeGreaterThan(0);
    });

    it('DepthBox bake: flying pixels at a depth step are pruned, the two surfaces kept, count reported', () => {
        const W = 96, H = 64;
        const depthbox = new DepthBoxInferenceService();
        const rayMap = depthbox.computePinholeRayField(W, H, 60);
        const depths = new Float32Array(W * H);
        const r = rng(4);
        const spikes = new Set<number>();
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) depths[y * W + x] = x < W / 2 ? 6 : 14;
        // Isolated depth spikes (sensor/model noise) in the middle of each surface.
        while (spikes.size < 12) {
            const x = 4 + Math.floor(r() * (W - 8)), y = 4 + Math.floor(r() * (H - 8));
            if (Math.abs(x - W / 2) < 4) continue;
            spikes.add(y * W + x);
        }
        for (const i of spikes) depths[i] = depths[i] * 0.55;
        const rgb = new Uint8Array(W * H * 3).fill(200);
        let report: any;
        const baked = SplatService.generateSplatsFromDepthRayField({ width: W, height: H, rgbPixels: rgb, metricDepths: depths, rayMap, edgeSeveranceTau: 0.5, minDepth: 0.5, onFloaterReport: rep => { report = rep; } });
        const raw = SplatService.generateSplatsFromDepthRayField({ width: W, height: H, rgbPixels: rgb, metricDepths: depths, rayMap, edgeSeveranceTau: 0.5, minDepth: 0.5, floaterPruning: false });
        expect(raw.length).toBe(W * H);
        expect(report.pruned).toBe(spikes.size);
        expect(baked.length).toBe(W * H - spikes.size);
        const kept = new Set(baked.map(s => s.position.join(',')));
        const rawByPixel = raw.map(s => s.position.join(','));
        for (const i of spikes) expect(kept.has(rawByPixel[i])).toBe(false);
    });

    it('fusion prunes after merging stations', () => {
        const { pos, count, surface } = scene(100, 3);
        const splats = Array.from({ length: count }, (_, i) => ({ position: [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]] as [number, number, number], scale: [0.01, 0.01, 0.002] as [number, number, number], colorRgb: [1, 1, 1] as [number, number, number], opacity: 1, quaternion: [0, 0, 0, 1] as [number, number, number, number] }));
        let pruned = -1;
        const fused = SplatService.fuseMultiViewSplats([splats.slice(0, Math.floor(count / 2)), splats.slice(Math.floor(count / 2))], { voxelSize: 1e-4, onFloaterReport: r => { pruned = r.pruned; } });
        expect(pruned).toBe(count - surface);
        expect(fused.length).toBe(surface);
        const { splats: direct } = pruneSplatFloaters(splats);
        expect(direct.length).toBe(surface);
    });
});

const cxx = process.env.CXX || 'clang++';
const clang = requireBinary(cxx, 'install Xcode command line tools (clang++)');

describe.skipIf(!clang.ok)(withReason('kNN floater pruning (native C++, agrees with TypeScript)', clang), () => {
    it('prunes the same splats as the TypeScript implementation, and fuseMultiViewSplats prunes after fusion', () => {
        const { pos, count, surface } = scene(160, 5);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-floater-'));
        try {
            const input = path.join(dir, 'points.bin'), output = path.join(dir, 'keep.bin');
            fs.writeFileSync(input, Buffer.from(pos.buffer));
            const src = path.join(dir, 'prune.cpp'), bin = path.join(dir, 'prune');
            fs.writeFileSync(src, `
#include "scratchbox_depth_to_gaussian.hpp"
#include <cstdio>
#include <fstream>
using namespace scratchbox;
int main(int argc, char** argv) {
    std::ifstream in(argv[1], std::ios::binary | std::ios::ate);
    const size_t bytes = in.tellg(); in.seekg(0);
    std::vector<double> pos(bytes / sizeof(double));
    in.read(reinterpret_cast<char*>(pos.data()), bytes);
    splatprune::FloaterPruneReport rep;
    auto keep = splatprune::computeFloaterKeepMask(pos, {}, &rep);
    std::ofstream(argv[2], std::ios::binary).write(reinterpret_cast<const char*>(keep.data()), keep.size());
    // Two stations through the native fusion (tiny voxels so the merge keeps every splat).
    std::vector<std::vector<spz::GaussianSplat>> views(2);
    for (size_t i = 0; i < pos.size() / 3; ++i) {
        spz::GaussianSplat s; s.position = math::Vec3(float(pos[i * 3]), float(pos[i * 3 + 1]), float(pos[i * 3 + 2]));
        views[i % 2].push_back(s);
    }
    splatprune::FloaterPruneReport fusedRep;
    auto fused = depthbox::DepthToGaussianEngine::fuseMultiViewSplats(views, 1e-4f, {}, &fusedRep);
    std::printf("%zu %zu %zu %.4f %zu\\n", rep.pruned, rep.kept, fused.size(), rep.threshold, fusedRep.pruned);
    return 0;
}
`);
            const include = path.resolve(__dirname, '../src/native/3d-engine/include');
            execFileSync(cxx, ['-std=c++20', '-O2', `-I${include}`, src, '-o', bin], { stdio: 'pipe' });
            const out = execFileSync(bin, [input, output], { encoding: 'utf8' }).trim().split(' ');
            const nativeKeep = new Uint8Array(fs.readFileSync(output));
            const ts = computeFloaterKeepMask(pos, count);
            expect(Array.from(nativeKeep)).toEqual(Array.from(ts.keep));
            expect(Number(out[0])).toBe(count - surface);
            expect(Number(out[2])).toBe(surface);
            expect(Number(out[3])).toBeCloseTo(ts.report.threshold, 3);
            expect(Number(out[4])).toBe(count - surface);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});
