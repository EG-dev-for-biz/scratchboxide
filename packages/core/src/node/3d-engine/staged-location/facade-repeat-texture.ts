/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A facade's photo redrawn from its own repeats (pipeline K, on the window fit). The tile photo is soft (8-15 cm texels),
 * blotched from photo to photo and dotted with reflections, but a facade repeats: every window of one size is the same window,
 * every spandrel between two windows of a strip the same spandrel. So:
 *  - the repeats: each fitted window, and each spandrel between two windows standing one above the other in a strip, grouped
 *    by size (within sizeTol), at least minRepeats to a group;
 *  - the consensus: each member resampled onto the group's median size, edge to edge (so the fitted edges line up), and the
 *    per-texel median taken over the members the photo covered there;
 *  - crisp edges: in the window consensus, a band of edgeM inside and outside each edge takes the median colour of the next
 *    band in on its own side, so a window's outline is a step, not the photo's blur;
 *  - each member drawn back as the consensus plus keepShade of its own mean colour's offset from the consensus's, at most
 *    maxShade a channel, so the facade keeps its weathering from window to window but not a reflection or a lit room.
 * Piers and walls outside the repeats stay as photographed. Everything drawn is generated (a fill from the facade's own
 * repeats), reported with what it covered.
 */

export const REPEAT_TEXTURE_VERSION = 'repeat-texture/1';

export const REPEAT_TEXTURE = {
    /** Repeats differ in width and height by at most this share of the larger. */
    sizeTol: 0.15,
    /** A group needs this many members. */
    minRepeats: 3,
    /** The snapped band at each window edge (m), at least one texel. */
    edgeM: 0.08,
    /** How much of each member's own mean colour offset is kept (weathering), at most maxShade (0-255) a channel. */
    keepShade: 0.5, maxShade: 16,
    /** Windows of one strip stand at most this far apart (m) for the gap between them to be a spandrel. */
    maxSpandrelM: 2.5,
    /** Repeats smaller than this (texels) on a side are left as photographed. */
    minSidePx: 3
};
export type RepeatTextureParams = typeof REPEAT_TEXTURE;

export interface RepeatTextureReport {
    version: string;
    groups: number; windows: number; spandrels: number;
    /** Texels redrawn, and of them those the photo never covered (filled from the repeats). */
    texels: number; filled: number;
    label: 'generated'; method: string;
}

type Rect = [number, number, number, number];

const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/** Groups by size: each rect joins the first group whose median size it matches within tol. */
function sizeGroups(rects: Rect[], tol: number): number[][] {
    const groups: Array<{ w: number; h: number; members: number[] }> = [];
    rects.forEach((r, i) => {
        const w = r[2] - r[0], h = r[3] - r[1];
        const g = groups.find(x => Math.abs(x.w - w) <= tol * Math.max(x.w, w) && Math.abs(x.h - h) <= tol * Math.max(x.h, h));
        if (g) { g.members.push(i); g.w = median(g.members.map(k => rects[k][2] - rects[k][0])); g.h = median(g.members.map(k => rects[k][3] - rects[k][1])); }
        else groups.push({ w, h, members: [i] });
    });
    return groups.map(g => g.members);
}

/**
 * The facade photo redrawn from its repeats. `windows` and `strips` in texels ([x0, y0, x1, y1], y down); `uncovered` 1 where
 * the photo never reached. Returns a new image (the input is left as it is) and what was drawn.
 */
export function repeatTexture(img: { rgba: Uint8Array; width: number; height: number }, pixelM: number, windows: Rect[], strips: Rect[], uncovered?: Uint8Array, P: RepeatTextureParams = REPEAT_TEXTURE): { rgba: Uint8Array; report: RepeatTextureReport } {
    const { width: W, height: H } = img, src = img.rgba, out = new Uint8Array(src);
    const covered = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && src[(y * W + x) * 4 + 3] > 0 && !(uncovered && uncovered[y * W + x]);
    // the spandrels: between windows standing one above the other in a strip, the strip's width
    const spandrels: Rect[] = [];
    for (const st of strips) {
        const inside = windows.filter(w => (w[0] + w[2]) / 2 > st[0] && (w[0] + w[2]) / 2 < st[2] && w[1] >= st[1] - 1 && w[3] <= st[3] + 1).sort((a, b) => a[1] - b[1]);
        for (let i = 0; i + 1 < inside.length; i++) {
            const top = inside[i][3], bottom = inside[i + 1][1];
            if (bottom - top >= P.minSidePx && (bottom - top) * pixelM <= P.maxSpandrelM) spandrels.push([st[0], top, st[2], bottom]);
        }
    }
    const report: RepeatTextureReport = { version: REPEAT_TEXTURE_VERSION, groups: 0, windows: 0, spandrels: 0, texels: 0, filled: 0, label: 'generated', method: '' };
    const edge = Math.max(1, Math.round(P.edgeM / pixelM));
    const draw = (rects: Rect[], snap: boolean, kind: 'windows' | 'spandrels') => {
        const usable = rects.filter(r => r[2] - r[0] >= P.minSidePx && r[3] - r[1] >= P.minSidePx);
        for (const members of sizeGroups(usable, P.sizeTol)) {
            if (members.length < P.minRepeats) continue;
            const rs = members.map(i => usable[i]);
            // the template: the group's median size, the members resampled onto it edge to edge
            const tw = Math.max(P.minSidePx, Math.round(median(rs.map(r => r[2] - r[0])))), th = Math.max(P.minSidePx, Math.round(median(rs.map(r => r[3] - r[1]))));
            const at = (r: Rect, u: number, v: number) => [Math.floor(r[0] + ((u + 0.5) / tw) * (r[2] - r[0])), Math.floor(r[1] + ((v + 0.5) / th) * (r[3] - r[1]))];
            const tpl = new Float32Array(tw * th * 3).fill(NaN);
            const vals: number[][] = [[], [], []];
            for (let v = 0; v < th; v++) for (let u = 0; u < tw; u++) {
                vals[0].length = vals[1].length = vals[2].length = 0;
                for (const r of rs) { const [x, y] = at(r, u, v); if (covered(x, y)) { const i = (y * W + x) * 4; vals[0].push(src[i]); vals[1].push(src[i + 1]); vals[2].push(src[i + 2]); } }
                if (vals[0].length) for (let c = 0; c < 3; c++) tpl[(v * tw + u) * 3 + c] = median(vals[c]);
            }
            // crisp edges: each side of each window edge takes the median of the next band in on its own side
            if (snap && tw > 4 * edge && th > 4 * edge) {
                const bandMedian = (u0: number, u1: number, v0: number, v1: number) => [0, 1, 2].map(c => { const a: number[] = []; for (let v = v0; v < v1; v++) for (let u = u0; u < u1; u++) { const x = tpl[(v * tw + u) * 3 + c]; if (Number.isFinite(x)) a.push(x); } return median(a); });
                const fill = (u0: number, u1: number, v0: number, v1: number, col: number[]) => { if (col.every(Number.isFinite)) for (let v = v0; v < v1; v++) for (let u = u0; u < u1; u++) for (let c = 0; c < 3; c++) tpl[(v * tw + u) * 3 + c] = col[c]; };
                // inside the window: its rim (one band wide) from the band inside it
                fill(0, edge, 0, th, bandMedian(edge, 2 * edge, 0, th));
                fill(tw - edge, tw, 0, th, bandMedian(tw - 2 * edge, tw - edge, 0, th));
                fill(0, tw, 0, edge, bandMedian(0, tw, edge, 2 * edge));
                fill(0, tw, th - edge, th, bandMedian(0, tw, th - 2 * edge, th - edge));
            }
            // each member: the consensus, shaded by its own mean colour's offset
            for (const r of rs) {
                const mean = (pick: (u: number, v: number) => number[] | undefined) => { const s = [0, 0, 0]; let n = 0; for (let v = 0; v < th; v++) for (let u = 0; u < tw; u++) { const p = pick(u, v); if (p) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; n++; } } return n ? s.map(x => x / n) : undefined; };
                const own = mean((u, v) => { const [x, y] = at(r, u, v); if (!covered(x, y)) return undefined; const i = (y * W + x) * 4; return [src[i], src[i + 1], src[i + 2]]; });
                const cons = mean((u, v) => { const k = (v * tw + u) * 3; return Number.isFinite(tpl[k]) ? [tpl[k], tpl[k + 1], tpl[k + 2]] : undefined; });
                const shade = own && cons ? own.map((x, c) => Math.max(-P.maxShade, Math.min(P.maxShade, P.keepShade * (x - cons[c])))) : [0, 0, 0];
                for (let y = Math.max(0, Math.floor(r[1])); y < Math.min(H, Math.ceil(r[3])); y++) for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(W, Math.ceil(r[2])); x++) {
                    const u = Math.min(tw - 1, Math.max(0, Math.floor(((x + 0.5 - r[0]) / (r[2] - r[0])) * tw))), v = Math.min(th - 1, Math.max(0, Math.floor(((y + 0.5 - r[1]) / (r[3] - r[1])) * th)));
                    const k = (v * tw + u) * 3;
                    if (!Number.isFinite(tpl[k])) continue;
                    const i = (y * W + x) * 4;
                    for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round(tpl[k + c] + shade[c])));
                    out[i + 3] = 255;
                    report.texels++;
                    if (!covered(x, y)) report.filled++;
                }
            }
            report.groups++;
            report[kind] += rs.length;
        }
    };
    // the spandrels first, then the windows over them (their edges are the windows' own)
    draw(spandrels, false, 'spandrels');
    draw(windows, true, 'windows');
    report.method = `each fitted window (${report.windows}) and each spandrel between two windows of a strip (${report.spandrels}) drawn as the per-texel median of its ${report.groups} size group(s) (at least ${P.minRepeats} repeats within ${Math.round(P.sizeTol * 100)}%), window edges snapped over ${edge} texel(s), ${Math.round(P.keepShade * 100)}% of each repeat's own shade kept (at most ${P.maxShade} levels)`;
    return { rgba: out, report };
}
