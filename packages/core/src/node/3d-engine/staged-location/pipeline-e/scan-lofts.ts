/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A structure's massing lofted through the scan's own sections (scan-sections.ts slices): each section's pieces are
 * followed up through the slices while one piece overlaps exactly one piece above it by at least `linkIoU` (a run);
 * where pieces split or join (legs meeting a core) a run ends and new ones begin. Each run's outlines are resampled to
 * the same point count, started at the same bearing from their centre and wound the same way, then the slices a
 * straight blend of their kept neighbours explains within `keepTolM` are dropped, and the rest are skinned into a
 * closed solid by the native Loft3D (scripts/sb_loft_sections.cpp). Tapers, flares and leaning legs come out as
 * sloped walls, not stacked steps. Everything is read off the scan; nothing here names a structure type.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from '../../native-build-cache';
import { findTileRefineRepoRoot } from '../../tile-refine-service';
import { cellsFootprint, type MassingMesh } from './massing-spec';
import type { ScanSlice } from './scan-sections';

export const SCAN_LOFT_PARAMS = {
    /** Least overlap (IoU) of a piece with the one above it for the run to continue... */
    linkIoU: 0.35,
    /** ...or, for pieces that barely overlap (a leaning leg), the most their centres may move per slice, as a share of the piece's own width (sqrt of its area), and at least linkMinStepM. */
    linkStepShare: 0.6, linkMinStepM: 0.6,
    /** Points on every resampled ring. */
    ringPoints: 48,
    /** A slice is kept when the blend of its kept neighbours misses its ring by more than this (m). */
    keepTolM: 0.4,
    /** Least area of a piece followed (m2). */
    minPieceM2: 0.5
};

interface Piece { slice: number; cells: Set<string>; ring: Vec2[]; centre: Vec2 }
export interface LoftRun { y0: number; y1: number; rings: Array<{ y: number; pts: Vec2[] }> }

const key = (i: number, k: number) => `${i},${k}`;

function pieces(slice: ScanSlice, s: number, cellM: number, minCells: number): Piece[] {
    const seen = new Set<string>(), out: Piece[] = [];
    for (const c of slice.cells) {
        if (seen.has(c)) continue;
        const comp = new Set([c]), stack = [c];
        seen.add(c);
        while (stack.length) {
            const [i, k] = stack.pop()!.split(',').map(Number);
            for (const n of [key(i + 1, k), key(i - 1, k), key(i, k + 1), key(i, k - 1)]) if (slice.cells.has(n) && !seen.has(n)) { seen.add(n); comp.add(n); stack.push(n); }
        }
        if (comp.size < minCells) continue;
        const loop = cellsFootprint(comp);
        if (!loop) continue;
        const ring = loop.map(([i, k]) => [i * cellM, k * cellM] as Vec2);
        let cx = 0, cz = 0;
        for (const cc of comp) { const [i, k] = cc.split(',').map(Number); cx += (i + 0.5) * cellM; cz += (k + 0.5) * cellM; }
        out.push({ slice: s, cells: comp, ring, centre: [cx / comp.size, cz / comp.size] });
    }
    return out;
}

function iou(a: Set<string>, b: Set<string>): number {
    let inter = 0;
    for (const c of a) if (b.has(c)) inter++;
    return inter / (a.size + b.size - inter || 1);
}

/** The ring resampled to `n` points by arc length, counter-clockwise (x east, z south seen from above), from the bearing +x. */
export function resampleRing(ring: Vec2[], centre: Vec2, n: number): Vec2[] {
    let a2 = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a2 += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    const r = a2 < 0 ? ring.slice().reverse() : ring.slice();
    // start where the ray from the centre along +x crosses the ring (the crossing farthest out)
    let start = 0, best = -Infinity;
    for (let i = 0; i < r.length; i++) {
        const [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length];
        if ((az - centre[1]) * (bz - centre[1]) > 0 || az === bz) continue;
        const t = (centre[1] - az) / (bz - az), x = ax + t * (bx - ax);
        if (x > centre[0] && x > best) { best = x; start = i + t; }
    }
    const seg: number[] = [0];
    for (let i = 0; i < r.length; i++) seg.push(seg[i] + Math.hypot(r[(i + 1) % r.length][0] - r[i][0], r[(i + 1) % r.length][1] - r[i][1]));
    const L = seg[r.length];
    const at = (d: number): Vec2 => {
        d = ((d % L) + L) % L;
        let i = 0;
        while (i < r.length - 1 && seg[i + 1] < d) i++;
        const t = (d - seg[i]) / ((seg[i + 1] - seg[i]) || 1), [ax, az] = r[i], [bx, bz] = r[(i + 1) % r.length];
        return [ax + t * (bx - ax), az + t * (bz - az)];
    };
    const i0 = Math.floor(start), d0 = seg[i0] + (start - i0) * (seg[i0 + 1] - seg[i0]);
    return Array.from({ length: n }, (_, k) => at(d0 + (k * L) / n));
}

/** The runs of the slices (see the module note), their rings thinned to the ones the loft needs. */
export function loftRuns(slices: ScanSlice[], cellM: number, P = SCAN_LOFT_PARAMS): LoftRun[] {
    const minCells = Math.ceil(P.minPieceM2 / (cellM * cellM));
    const per = slices.map((s, i) => pieces(s, i, cellM, minCells));
    const next = new Map<Piece, Piece>(), hasPrev = new Set<Piece>();
    // how well a links to b above: overlap when they overlap enough, else nearness of their centres within the step
    const affinity = (a: Piece, b: Piece): number => {
        const o = iou(a.cells, b.cells);
        if (o >= P.linkIoU) return 1 + o;
        const step = Math.max(P.linkMinStepM, P.linkStepShare * Math.sqrt(Math.min(a.cells.size, b.cells.size) * cellM * cellM));
        const d = Math.hypot(a.centre[0] - b.centre[0], a.centre[1] - b.centre[1]);
        const sizeRatio = Math.min(a.cells.size, b.cells.size) / Math.max(a.cells.size, b.cells.size);
        return d <= step && sizeRatio >= 0.35 ? 1 - d / step : 0;
    };
    // mutual best: a's best above is b and b's best below is a (a join or a split continues its best match; the rest start runs)
    for (let s = 0; s + 1 < per.length; s++) {
        const best = (p: Piece, cands: Piece[], up: boolean) => {
            let bp: Piece | undefined, bv = 0;
            for (const q of cands) { const v = up ? affinity(p, q) : affinity(q, p); if (v > bv) { bv = v; bp = q; } }
            return bp;
        };
        for (const a of per[s]) {
            const b = best(a, per[s + 1], true);
            if (b && best(b, per[s], false) === a) { next.set(a, b); hasPrev.add(b); }
        }
    }
    const runs: LoftRun[] = [];
    for (const layer of per) for (const head of layer) {
        if (hasPrev.has(head)) continue;
        const chain: Piece[] = [head];
        while (next.has(chain[chain.length - 1])) chain.push(next.get(chain[chain.length - 1])!);
        const ys = (p: Piece, i: number) => i === 0 ? slices[p.slice].y0 : i === chain.length - 1 ? slices[p.slice].y1 : (slices[p.slice].y0 + slices[p.slice].y1) / 2;
        let rings = chain.map((p, i) => ({ y: ys(p, i), pts: resampleRing(p.ring, p.centre, P.ringPoints) }));
        if (chain.length === 1) rings = [{ y: slices[head.slice].y0, pts: rings[0].pts }, { y: slices[head.slice].y1, pts: rings[0].pts }];
        runs.push({ y0: rings[0].y, y1: rings[rings.length - 1].y, rings: thin(rings, P.keepTolM) });
    }
    return runs;
}

/** Drops every ring a straight blend of its kept neighbours explains within `tol` (greedy, bottom up). */
function thin(rings: LoftRun['rings'], tol: number): LoftRun['rings'] {
    if (rings.length <= 2) return rings;
    const kept = [rings[0]];
    let anchor = 0;
    for (let i = 2; i < rings.length; i++) {
        const a = rings[anchor], b = rings[i];
        let ok = true;
        for (let j = anchor + 1; j < i && ok; j++) {
            const t = (rings[j].y - a.y) / (b.y - a.y || 1);
            for (let k = 0; k < a.pts.length; k++) {
                const x = a.pts[k][0] + t * (b.pts[k][0] - a.pts[k][0]), z = a.pts[k][1] + t * (b.pts[k][1] - a.pts[k][1]);
                if (Math.hypot(x - rings[j].pts[k][0], z - rings[j].pts[k][1]) > tol) { ok = false; break; }
            }
        }
        if (!ok) { kept.push(rings[i - 1]); anchor = i - 1; }
    }
    kept.push(rings[rings.length - 1]);
    return kept;
}

const CLI_SOURCE = path.join('scripts', 'sb_loft_sections.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'sb_loft_sections');

/** Builds build/3d-native/sb_loft_sections through the native build cache when its sources changed. */
export async function ensureLoftBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    const bin = path.join(repoRoot, BINARY);
    try {
        const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags([]), libs: [], name: 'sb_loft_sections', timeoutMs: 600_000 });
        placeCachedBinary(built.binaryPath, bin);
        return bin;
    } catch (err) {
        throw new Error(`could not build sb_loft_sections: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
    }
}

/** The runs skinned by the native loft: one closed solid per run, as massing meshes (x, y, z vertices). */
export async function loftMeshes(runs: LoftRun[], dir: string, idPrefix: string, opts: { binary?: string; signal?: AbortSignal } = {}): Promise<MassingMesh[]> {
    const usable = runs.filter(r => r.rings.length >= 2);
    if (!usable.length) return [];
    const binary = opts.binary ?? await ensureLoftBinary();
    fs.mkdirSync(dir, { recursive: true });
    const inFile = path.join(dir, 'rings.txt'), outFile = path.join(dir, 'lofts.bin');
    const lines = [`runs ${usable.length}`];
    for (const r of usable) {
        lines.push(`run ${r.rings.length} ${r.rings[0].pts.length}`);
        for (const ring of r.rings) lines.push(ring.pts.map(([x, z]) => `${x.toFixed(3)} ${ring.y.toFixed(3)} ${z.toFixed(3)}`).join(' '));
    }
    fs.writeFileSync(inFile, lines.join('\n') + '\n');
    await new Promise<void>((resolve, reject) => execFile(binary, [inFile, outFile], { timeout: 120_000, ...(opts.signal ? { signal: opts.signal } : {}) }, (err, out) => {
        const head = (() => { try { return JSON.parse(String(out).trim().split('\n').pop() ?? '{}'); } catch { return {}; } })();
        if (err || !head.ok) reject(new Error(`sb_loft_sections failed: ${head.error ?? err?.message ?? 'no answer'}`)); else resolve();
    }));
    const buf = fs.readFileSync(outFile);
    const meshes: MassingMesh[] = [];
    let o = 0;
    usable.forEach((_, i) => {
        const nv = buf.readUInt32LE(o), ni = buf.readUInt32LE(o + 4);
        o += 8;
        const vertices: Array<[number, number, number]> = [];
        for (let v = 0; v < nv; v++, o += 12) vertices.push([buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)]);
        const indices: number[] = [];
        for (let k = 0; k < ni; k++, o += 4) indices.push(buf.readUInt32LE(o));
        meshes.push({ id: `${idPrefix}/loft${i}`, vertices, indices });
    });
    return meshes;
}
