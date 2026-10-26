/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A structure's massing read from the scan's own horizontal sections: the scan is cut into slices `sliceM` thick, each
 * slice's occupied plan cells are filled (a shell of walls reads as the solid it bounds) and closed over small gaps, and
 * neighbouring slices are merged into one band while each new slice's section overlaps the band's by at least
 * `mergeIoU`. A band is a prism between its lowest and highest slice, its outline the cells most of its slices share.
 * `mergeIoU` is the one dial, continuous: near 0 every slice joins one band (a single block, the plan extruded); near 1
 * each change of section starts a new band (setbacks, a shaft and its deck, a drum and its dome as stacked tiers). Which
 * setting a structure wants is decided by measuring each against the scan (surface-agreement.ts), not by its type.
 */

import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import { cellsFootprint, type MassingPart } from './massing-spec';

export const SCAN_SECTION_PARAMS = {
    sliceM: 1,
    cellM: 1,
    /** Gaps in a slice's shell closed before filling (cells). */
    closeCells: 1,
    /** Least area of a section component kept (m2). */
    minComponentM2: 6,
    /** Douglas-Peucker tolerance on a band's outline (m): the cell staircase straightened. */
    simplifyM: 0.75
};

export interface ScanSlice { y0: number; y1: number; cells: Set<string>; areaM2: number }
export interface ScanBand { y0: number; y1: number; cells: Set<string>; areaM2: number; slices: number }

const key = (i: number, k: number) => `${i},${k}`;

/** The filled, closed plan section of each slice of the samples (x, y, z triples) from `baseY` up. */
export function scanSlices(samples: Float32Array, baseY: number, P = SCAN_SECTION_PARAMS): ScanSlice[] {
    let top = -Infinity;
    for (let i = 1; i < samples.length; i += 3) top = Math.max(top, samples[i]);
    const n = Math.max(0, Math.ceil((top - baseY) / P.sliceM));
    const raw: Array<Set<string>> = Array.from({ length: n }, () => new Set());
    for (let i = 0; i < samples.length; i += 3) {
        const s = Math.floor((samples[i + 1] - baseY) / P.sliceM);
        if (s < 0 || s >= n) continue;
        raw[s].add(key(Math.floor(samples[i] / P.cellM), Math.floor(samples[i + 2] / P.cellM)));
    }
    return raw.map((cells, s) => {
        const filled = fillSection(closeCells(cells, P.closeCells));
        return { y0: baseY + s * P.sliceM, y1: baseY + (s + 1) * P.sliceM, cells: filled, areaM2: filled.size * P.cellM * P.cellM };
    });
}

/** `cells` grown by `r` then shrunk by `r` (a closing): one-cell gaps in a sampled shell are bridged. */
function closeCells(cells: Set<string>, r: number): Set<string> {
    if (r <= 0 || !cells.size) return cells;
    const grown = new Set<string>();
    for (const c of cells) { const [i, k] = c.split(',').map(Number); for (let di = -r; di <= r; di++) for (let dk = -r; dk <= r; dk++) grown.add(key(i + di, k + dk)); }
    const out = new Set<string>();
    for (const c of grown) {
        const [i, k] = c.split(',').map(Number);
        let all = true;
        for (let di = -r; di <= r && all; di++) for (let dk = -r; dk <= r; dk++) if (!grown.has(key(i + di, k + dk))) { all = false; break; }
        if (all) out.add(c);
    }
    return out;
}

/** The cells plus every cell they enclose (flood fill of the outside over the bounding box with a one-cell margin). */
function fillSection(cells: Set<string>): Set<string> {
    if (!cells.size) return cells;
    let i0 = Infinity, i1 = -Infinity, k0 = Infinity, k1 = -Infinity;
    for (const c of cells) { const [i, k] = c.split(',').map(Number); i0 = Math.min(i0, i); i1 = Math.max(i1, i); k0 = Math.min(k0, k); k1 = Math.max(k1, k); }
    i0--; k0--; i1++; k1++;
    const W = i1 - i0 + 1, H = k1 - k0 + 1;
    const outside = new Uint8Array(W * H);
    const stack = [0];
    outside[0] = 1;
    while (stack.length) {
        const p = stack.pop()!, i = p % W, k = (p / W) | 0;
        for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const ii = i + di, kk = k + dk;
            if (ii < 0 || kk < 0 || ii >= W || kk >= H) continue;
            const q = kk * W + ii;
            if (outside[q] || cells.has(key(ii + i0, kk + k0))) continue;
            outside[q] = 1;
            stack.push(q);
        }
    }
    const out = new Set<string>();
    for (let k = 0; k < H; k++) for (let i = 0; i < W; i++) if (!outside[k * W + i]) out.add(key(i + i0, k + k0));
    return out;
}

function iou(a: Set<string>, b: Set<string>): number {
    if (!a.size && !b.size) return 1;
    let inter = 0;
    for (const c of a) if (b.has(c)) inter++;
    return inter / (a.size + b.size - inter);
}

/** Consecutive slices merged into bands (see the module note); empty slices end a band and start none. */
export function bandsFromSlices(slices: ScanSlice[], mergeIoU: number, P = SCAN_SECTION_PARAMS): ScanBand[] {
    const bands: ScanBand[] = [];
    let cur: { y0: number; y1: number; members: ScanSlice[]; votes: Map<string, number> } | undefined;
    const close = () => {
        if (!cur) return;
        const need = cur.members.length / 2;
        const cells = new Set([...cur.votes].filter(([, v]) => v >= need).map(([c]) => c));
        if (cells.size) bands.push({ y0: cur.y0, y1: cur.y1, cells, areaM2: cells.size * P.cellM * P.cellM, slices: cur.members.length });
        cur = undefined;
    };
    for (const s of slices) {
        if (s.areaM2 < P.minComponentM2) { close(); continue; }
        if (cur) {
            const bandCells = new Set([...cur.votes].filter(([, v]) => v >= cur!.members.length / 2).map(([c]) => c));
            if (iou(bandCells, s.cells) < mergeIoU) close();
        }
        if (!cur) cur = { y0: s.y0, y1: s.y1, members: [], votes: new Map() };
        cur.members.push(s);
        cur.y1 = s.y1;
        for (const c of s.cells) cur.votes.set(c, (cur.votes.get(c) ?? 0) + 1);
    }
    close();
    return bands;
}

/** Separate 4-connected components of a cell set, the small ones dropped. */
function components(cells: Set<string>, minCells: number): Array<Set<string>> {
    const seen = new Set<string>(), out: Array<Set<string>> = [];
    for (const c of cells) {
        if (seen.has(c)) continue;
        const comp = new Set<string>([c]), stack = [c];
        seen.add(c);
        while (stack.length) {
            const [i, k] = stack.pop()!.split(',').map(Number);
            for (const n of [key(i + 1, k), key(i - 1, k), key(i, k + 1), key(i, k - 1)]) if (cells.has(n) && !seen.has(n)) { seen.add(n); comp.add(n); stack.push(n); }
        }
        if (comp.size >= minCells) out.push(comp);
    }
    return out;
}

/** Douglas-Peucker on a closed ring. */
export function simplifyRing(ring: Vec2[], tol: number): Vec2[] {
    if (ring.length <= 4) return ring;
    const dp = (pts: Vec2[]): Vec2[] => {
        if (pts.length < 3) return pts;
        const [ax, az] = pts[0], [bx, bz] = pts[pts.length - 1], L = Math.hypot(bx - ax, bz - az) || 1;
        let best = -1, bi = 0;
        for (let i = 1; i < pts.length - 1; i++) {
            const d = Math.abs((bx - ax) * (az - pts[i][1]) - (ax - pts[i][0]) * (bz - az)) / L;
            if (d > best) { best = d; bi = i; }
        }
        if (best <= tol) return [pts[0], pts[pts.length - 1]];
        return [...dp(pts.slice(0, bi + 1)).slice(0, -1), ...dp(pts.slice(bi))];
    };
    // split the ring at its two farthest-apart points so both halves are open polylines
    let far = 0, fd = -1;
    for (let i = 1; i < ring.length; i++) { const d = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]); if (d > fd) { fd = d; far = i; } }
    const a = dp(ring.slice(0, far + 1)), b = dp([...ring.slice(far), ring[0]]);
    const out = [...a.slice(0, -1), ...b.slice(0, -1)];
    return out.length >= 3 ? out : ring;
}

/** Each band's components as massing parts: flat-topped prisms, the outline straightened, heights from the scan. */
export function partsFromBands(bands: ScanBand[], idPrefix: string, P = SCAN_SECTION_PARAMS): MassingPart[] {
    const parts: MassingPart[] = [];
    bands.forEach((b, bi) => components(b.cells, Math.ceil(P.minComponentM2 / (P.cellM * P.cellM))).forEach((comp, ci) => {
        // traced in cell units (cellsFootprint steps one cell at a time), then scaled to metres
        const loop = cellsFootprint(comp);
        if (!loop) return;
        const ring = loop.map(([i, k]) => [i * P.cellM, k * P.cellM] as Vec2);
        parts.push({
            id: `${idPrefix}/s${bi}${ci ? `.${ci}` : ''}`, baseY: b.y0, topY: b.y1, loops: [simplifyRing(ring, P.simplifyM)], planes: [],
            heightSource: 'scan', heights: { scanY: b.y1 }, roof: { source: 'scan', note: `scan section band ${b.y0.toFixed(1)}-${b.y1.toFixed(1)} m (${b.slices} slices)` }
        });
    }));
    return parts;
}

/**
 * Surface samples of flat-topped prism parts, as sampleSurface spaces them: the walls, and the parts of each top and
 * bottom left exposed (a top where another part stands on it, or a bottom resting on one, lies inside the solid).
 */
export function samplePartsSurface(parts: MassingPart[], spacingM: number): Float32Array {
    const out: number[] = [];
    const covered = (x: number, y: number, z: number, self: MassingPart, above: boolean) => parts.some(q => q !== self
        && Math.abs((above ? q.baseY : q.topY) - y) < 1e-3 && q.loops.some(r => inRing(r, x, z)));
    for (const p of parts) for (const ring of p.loops) {
        const h = p.topY - p.baseY;
        for (let e = 0; e < ring.length; e++) {
            const [ax, az] = ring[e], [bx, bz] = ring[(e + 1) % ring.length], L = Math.hypot(bx - ax, bz - az);
            for (let s = spacingM / 2; s < L; s += spacingM) for (let y = spacingM / 2; y < h; y += spacingM) out.push(ax + (bx - ax) * s / L, p.baseY + y, az + (bz - az) * s / L);
        }
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
        for (let x = x0 + spacingM / 2; x < x1; x += spacingM) for (let z = z0 + spacingM / 2; z < z1; z += spacingM) {
            if (!inRing(ring, x, z)) continue;
            if (!covered(x, p.topY, z, p, true)) out.push(x, p.topY, z);
            if (!covered(x, p.baseY, z, p, false)) out.push(x, p.baseY, z);
        }
    }
    return Float32Array.from(out);
}

function inRing(ring: Vec2[], x: number, z: number): boolean {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i], [xj, zj] = ring[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
}
