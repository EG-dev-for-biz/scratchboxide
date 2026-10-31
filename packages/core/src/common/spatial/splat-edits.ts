/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Brush edits on a loaded splat (the viewport's Edit Splats tool). An edit is a stroke: a path of points in the splat's
 * own frame swept by a sphere of `radius` metres. Strokes are kept in the scene's data (Scene3DData.splatEdits) and
 * replayed in order over the splat as it was built, which is never rewritten: undo drops a stroke, a rebuilt world takes
 * the same strokes (they name places, not splat indices), and a saved world is its base file plus its strokes.
 *
 * Colours and opacities are the viewer's RGBA8 per splat (PhotorealGaussianSplatMesh's colour texture).
 */

/** What a stroke does to the splats it sweeps: hides them, brings back what the base splat had, or paints toward a colour. */
export type SplatEditOp = 'erase' | 'restore' | 'paint';

export interface SplatEditStroke {
    op: SplatEditOp;
    /** The stroke's path in the splat's frame: x, y, z per point. */
    points: number[];
    /** Brush radius, metres. */
    radius: number;
    /** Paint colour, 0..1 RGB as the splat file stores it. */
    color?: [number, number, number];
    /** How far one pass of paint moves a splat's colour toward `color` at the brush's centre, 0..1. Default 1. */
    strength?: number;
    /** The splat object the stroke edits (a scene object id); absent for the scene's own splat (splatUrl). */
    target?: string;
}

/** The splat's own scene object id when it comes from splatUrl (Scene3DPrimitive's primary-location-splat). */
export const PRIMARY_SPLAT_TARGET = 'primary-location-splat';

/** Grid over splat centres for sphere and ray queries: splats sorted by cell, with each cell's start offset. */
export class SplatEditIndex {
    readonly cell: number;
    readonly min: [number, number, number];
    readonly dims: [number, number, number];
    /** Splat indices ordered by cell. */
    readonly order: Uint32Array;
    /** order[starts[c] .. starts[c + 1]) are the splats in cell c. */
    readonly starts: Uint32Array;

    constructor(readonly positions: Float32Array, readonly count: number, cellM?: number) {
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let i = 0; i < count; i++) {
            const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
            if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        if (!count) { x0 = y0 = z0 = 0; x1 = y1 = z1 = 0; }
        // about 8 splats a cell on average, at least 5 cm, at most 2 m, and never more than 16 M cells
        const volume = Math.max(1e-6, (x1 - x0) * (y1 - y0) * (z1 - z0));
        let cell = cellM ?? Math.min(2, Math.max(0.05, Math.cbrt((volume * 8) / Math.max(1, count))));
        const dimsFor = (c: number): [number, number, number] => [Math.floor((x1 - x0) / c) + 1, Math.floor((y1 - y0) / c) + 1, Math.floor((z1 - z0) / c) + 1];
        let dims = dimsFor(cell);
        while (dims[0] * dims[1] * dims[2] > 16_000_000) { cell *= 1.25; dims = dimsFor(cell); }
        this.cell = cell;
        this.min = [x0, y0, z0];
        this.dims = dims;
        const cells = dims[0] * dims[1] * dims[2];
        const cellOf = new Uint32Array(count);
        const starts = new Uint32Array(cells + 1);
        for (let i = 0; i < count; i++) {
            const c = this.cellIndex(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
            cellOf[i] = c;
            starts[c + 1]++;
        }
        for (let c = 0; c < cells; c++) starts[c + 1] += starts[c];
        const fill = starts.slice(0, cells);
        const order = new Uint32Array(count);
        for (let i = 0; i < count; i++) order[fill[cellOf[i]]++] = i;
        this.order = order;
        this.starts = starts;
    }

    private clampAxis(v: number, axis: 0 | 1 | 2): number {
        return Math.min(this.dims[axis] - 1, Math.max(0, Math.floor((v - this.min[axis]) / this.cell)));
    }

    private cellIndex(x: number, y: number, z: number): number {
        return (this.clampAxis(z, 2) * this.dims[1] + this.clampAxis(y, 1)) * this.dims[0] + this.clampAxis(x, 0);
    }

    /** Calls `visit(i, distance²)` for every splat whose centre is within `r` of (x, y, z). */
    forEachInSphere(x: number, y: number, z: number, r: number, visit: (i: number, d2: number) => void): void {
        const r2 = r * r, p = this.positions;
        const cx0 = this.clampAxis(x - r, 0), cx1 = this.clampAxis(x + r, 0);
        const cy0 = this.clampAxis(y - r, 1), cy1 = this.clampAxis(y + r, 1);
        const cz0 = this.clampAxis(z - r, 2), cz1 = this.clampAxis(z + r, 2);
        for (let cz = cz0; cz <= cz1; cz++) for (let cy = cy0; cy <= cy1; cy++) {
            const row = (cz * this.dims[1] + cy) * this.dims[0];
            for (let k = this.starts[row + cx0], end = this.starts[row + cx1 + 1]; k < end; k++) {
                const i = this.order[k];
                const dx = p[i * 3] - x, dy = p[i * 3 + 1] - y, dz = p[i * 3 + 2] - z;
                const d2 = dx * dx + dy * dy + dz * dz;
                if (d2 <= r2) visit(i, d2);
            }
        }
    }

    /**
     * The nearest visible splat along a ray (origin, unit direction, both in the splat's frame): the first splat, by
     * distance along the ray, whose centre lies within `tolerance(t)` of it, or within its own footprint
     * `splatRadius(i)` (at most `maxSplatRadius`), and whose opacity in `rgba` is above zero. Returns its index and
     * the distance along the ray, or undefined when nothing within `maxT` is hit.
     */
    pick(
        origin: [number, number, number], dir: [number, number, number], rgba: Uint8Array, maxT: number, tolerance: (t: number) => number,
        splatRadius?: (i: number) => number, maxSplatRadius = 0
    ): { index: number; t: number } | undefined {
        const p = this.positions;
        // only the stretch of the ray inside the grid's box (slab test), walked a cell at a time
        let t0 = 0, t1 = maxT;
        for (let a = 0; a < 3; a++) {
            const lo = this.min[a] - this.cell, hi = this.min[a] + this.dims[a] * this.cell + this.cell;
            if (Math.abs(dir[a]) < 1e-12) {
                if (origin[a] < lo || origin[a] > hi) return undefined;
                continue;
            }
            let ta = (lo - origin[a]) / dir[a], tb = (hi - origin[a]) / dir[a];
            if (ta > tb) [ta, tb] = [tb, ta];
            t0 = Math.max(t0, ta);
            t1 = Math.min(t1, tb);
        }
        if (t0 > t1) return undefined;
        const step = this.cell;
        let best: { index: number; t: number } | undefined;
        const seen = new Set<number>();
        for (let t = t0; t <= t1 + step; t += step) {
            if (best && t > best.t + this.cell * 2) break;
            const x = origin[0] + dir[0] * t, y = origin[1] + dir[1] * t, z = origin[2] + dir[2] * t;
            // a sphere reaching half a step either way along the ray, plus the hit tolerance across it
            const r = Math.max(tolerance(t), maxSplatRadius) + step * 0.6;
            this.forEachInSphere(x, y, z, r, i => {
                if (seen.has(i) || rgba[i * 4 + 3] === 0) return;
                seen.add(i);
                const ox = p[i * 3] - origin[0], oy = p[i * 3 + 1] - origin[1], oz = p[i * 3 + 2] - origin[2];
                const along = ox * dir[0] + oy * dir[1] + oz * dir[2];
                if (along <= 0) return;
                const perp2 = ox * ox + oy * oy + oz * oz - along * along;
                const tol = Math.max(tolerance(along), splatRadius ? Math.min(maxSplatRadius, splatRadius(i)) : 0);
                if (perp2 <= tol * tol && (!best || along < best.t)) best = { index: i, t: along };
            });
        }
        return best;
    }
}

/**
 * Splat indices a stroke reaches, with the brush weight at each: the sphere swept along the path (a capsule per
 * segment), 1 on the path falling to 0 at the radius, the largest weight where segments overlap.
 */
export function strokeWeights(index: SplatEditIndex, stroke: SplatEditStroke): Map<number, number> {
    const weights = new Map<number, number>();
    const r = Math.max(1e-4, stroke.radius), r2 = r * r, pts = stroke.points, p = index.positions;
    const keep = (i: number, d2: number) => {
        const u = 1 - d2 / r2;
        const w = u * u;
        if (w > (weights.get(i) ?? 0)) weights.set(i, w);
    };
    const n = Math.floor(pts.length / 3);
    if (n === 1) index.forEachInSphere(pts[0], pts[1], pts[2], r, keep);
    for (let k = 0; k + 1 < n; k++) {
        const ax = pts[k * 3], ay = pts[k * 3 + 1], az = pts[k * 3 + 2];
        const dx = pts[k * 3 + 3] - ax, dy = pts[k * 3 + 4] - ay, dz = pts[k * 3 + 5] - az;
        const len2 = dx * dx + dy * dy + dz * dz, half = Math.sqrt(len2) / 2;
        // every splat within r of the segment lies within r + half of its midpoint
        index.forEachInSphere(ax + dx / 2, ay + dy / 2, az + dz / 2, r + half, i => {
            const px = p[i * 3] - ax, py = p[i * 3 + 1] - ay, pz = p[i * 3 + 2] - az;
            const t = len2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy + pz * dz) / len2)) : 0;
            const ex = px - dx * t, ey = py - dy * t, ez = pz - dz * t;
            const d2 = ex * ex + ey * ey + ez * ez;
            if (d2 <= r2) keep(i, d2);
        });
    }
    return weights;
}

/**
 * Applies one stroke to `rgba` (the splats as now drawn) in place, reading `base` (the splats as built) for restore.
 * Returns the number of splats it changed.
 */
export function applySplatStroke(index: SplatEditIndex, base: Uint8Array, rgba: Uint8Array, stroke: SplatEditStroke): number {
    let changed = 0;
    const strength = Math.min(1, Math.max(0, stroke.strength ?? 1));
    const c = stroke.color ?? [1, 1, 1];
    const target = [0, 1, 2].map(k => Math.round(Math.min(1, Math.max(0, c[k])) * 255));
    for (const [i, w] of strokeWeights(index, stroke)) {
        const o = i * 4;
        if (stroke.op === 'erase') {
            if (rgba[o + 3] !== 0) { rgba[o + 3] = 0; changed++; }
        } else if (stroke.op === 'restore') {
            if (rgba[o] !== base[o] || rgba[o + 1] !== base[o + 1] || rgba[o + 2] !== base[o + 2] || rgba[o + 3] !== base[o + 3]) {
                rgba[o] = base[o]; rgba[o + 1] = base[o + 1]; rgba[o + 2] = base[o + 2]; rgba[o + 3] = base[o + 3];
                changed++;
            }
        } else {
            const a = strength * w;
            if (a <= 0) continue;
            for (let k = 0; k < 3; k++) rgba[o + k] = Math.round(rgba[o + k] + (target[k] - rgba[o + k]) * a);
            changed++;
        }
    }
    return changed;
}

/** Replays `strokes` over the splats as built: `rgba` is reset from `base`, then every stroke is applied in order. */
export function replaySplatEdits(index: SplatEditIndex, base: Uint8Array, rgba: Uint8Array, strokes: readonly SplatEditStroke[]): number {
    rgba.set(base.subarray(0, Math.min(base.length, rgba.length)));
    let changed = 0;
    for (const s of strokes) changed += applySplatStroke(index, base, rgba, s);
    return changed;
}
