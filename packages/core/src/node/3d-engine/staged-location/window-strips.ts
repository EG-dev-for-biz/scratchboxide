/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The window strips and bays a facade's windows make (moved from facade-lattice.ts, 2026-11-07, so the wall grammar can
 * read them too): what the lattice recesses whole between the piers, and what the wall grammar's column vote needs when
 * the openings come as single windows (the facade reader's) rather than the window fit's full-height strips.
 */

/**
 * Window strips (pipeline K with a window fit): the fitted windows grouped into columns (windows whose spans along s overlap by
 * at least `overlap` of the narrower), each column split where its windows stand more than `maxGapM` apart up the wall (a
 * band, a setback), and every run of at least `minWindows` windows, or one at least `minStripM` tall (a fit that reads the column as one
 * opening), drawn as one strip from its lowest window's sill to its
 * highest window's head, at the column's median edges. Then bays: side by side (overlapping up the wall by half), two strips
 * are one bay when the gap between them is under `mullionRatio` of the gaps beside it in their row (the narrower of the two
 * neighbours: a mullion stands between two piers, a pier between two mullions, and a wide gap at a corner or a setback
 * makes no pier a mullion); a row of equal gaps stays one strip per column. The bay is recessed whole (its
 * spandrels and mullions with it) between the piers that stay on the wall (the structure, STRUCTURE), and its windows a
 * further `windowInsetM`. Photo-inferred, read from the facade's own fit.
 */
const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

export const WINDOW_STRIPS = { overlap: 0.5, maxGapM: 2.5, minWindows: 2, minStripM: 5, mullionRatio: 0.6, windowInsetM: 0.05 };


export function windowStrips(windows: Array<[number, number, number, number]>, R = WINDOW_STRIPS): Array<[number, number, number, number]> {
    const n = windows.length, parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = windows[i], b = windows[j], ov = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
        if (ov >= R.overlap * Math.min(a[2] - a[0], b[2] - b[0])) parent[find(i)] = find(j);
    }
    const cols = new Map<number, Array<[number, number, number, number]>>();
    windows.forEach((w, i) => { const r = find(i); cols.set(r, [...(cols.get(r) ?? []), w]); });
    const out: Array<[number, number, number, number]> = [];
    for (const col of cols.values()) {
        col.sort((a, b) => a[1] - b[1]);
        let run: Array<[number, number, number, number]> = [];
        const close = () => {
            if (run.length >= R.minWindows || (run.length && Math.max(...run.map(w => w[3])) - Math.min(...run.map(w => w[1])) >= R.minStripM)) out.push([median(run.map(w => w[0])), Math.min(...run.map(w => w[1])), median(run.map(w => w[2])), Math.max(...run.map(w => w[3]))]);
            run = [];
        };
        for (const w of col) {
            if (run.length && w[1] - Math.max(...run.map(x => x[3])) > R.maxGapM) close();
            run.push(w);
        }
        close();
    }
    return windowBays(out.sort((a, b) => a[0] - b[0] || a[1] - b[1]), R);
}

/** Strips side by side joined into bays across their mullions (WINDOW_STRIPS.mullionRatio); see windowStrips. */
export function windowBays(strips: Array<[number, number, number, number]>, R = WINDOW_STRIPS): Array<[number, number, number, number]> {
    const tOverlap = (a: number[], b: number[]) => Math.min(a[3], b[3]) - Math.max(a[1], b[1]) >= R.overlap * Math.min(a[3] - a[1], b[3] - b[1]);
    const out: Array<[number, number, number, number]> = [];
    const used = new Set<number>();
    for (let i = 0; i < strips.length; i++) {
        if (used.has(i)) continue;
        // the row: every strip standing beside this one up the wall, left to right
        const row = strips.map((x, k) => [x, k] as const).filter(([x, k]) => !used.has(k) && tOverlap(x, strips[i])).sort((a, b) => a[0][0] - b[0][0]);
        row.forEach(([, k]) => used.add(k));
        const gaps = row.slice(1).map(([x], j) => x[0] - row[j][0][2]);
        // a gap against the narrower of its neighbours (none: it stays)
        const beside = (j: number) => Math.min(j > 0 ? gaps[j - 1] : Infinity, j + 1 < gaps.length ? gaps[j + 1] : Infinity);
        let bay: [number, number, number, number] = [...row[0][0]];
        row.slice(1).forEach(([x], j) => {
            if (Number.isFinite(beside(j)) && gaps[j] < R.mullionRatio * beside(j)) bay = [bay[0], Math.min(bay[1], x[1]), x[2], Math.max(bay[3], x[3])];
            else { out.push(bay); bay = [...x]; }
        });
        out.push(bay);
    }
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}
