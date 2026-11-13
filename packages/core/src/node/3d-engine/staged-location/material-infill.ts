/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Infill from the material plan: a texel the photo never reached takes its own element's material, never the nearest
 * real texel across an element boundary (which bleeds a window into the wall beside it, or the wall into a window).
 *
 * The facade's design intent says which element every texel belongs to (a window's glass, its frame, a spandrel, a
 * pier, a wall band: facadeElements, the material plan's paint order), holes included: an inferred window over a hole
 * is still a window. Each hole texel is then filled, in this order:
 *   1. peer: the texel at the same place inside another element of the same design (same role and family, same size
 *      within peerSizeTol): the median-luma one of the peers that show it. A hidden window takes its siblings' glass,
 *      mullions and frame where they are;
 *   2. lattice: for what has no peer (the wall between the windows), the texel one or more bays across or storeys up
 *      or down that is real and of the same material: the wall's coursing and stains continue at the design's pitch
 *      (the facade's lattice, else its repeating region's, else the photo's own period);
 *   3. exemplar: the material's cleanest patches (the plan's exemplars), tiled mirrored at their real texel size and
 *      shifted to the mean colour of the material's real texels near the hole, so the light stays continuous;
 *   4. flat: the material's measured colour, where it has no exemplar.
 * A texel of no planned material is left as it was. Every filled texel is generated; `source` says which step filled
 * it (INFILL_SOURCE), for the labels and the report.
 */

import { facadeElements, MATERIAL_PLAN_PARAMS, type MaterialPlan, type MaterialPlanParams, type PlanPhoto } from './material-plan';
import type { StructureIntent } from './structure-intent';

type Rect = [number, number, number, number];

export const MATERIAL_INFILL_PARAMS = {
    /** Peers: elements of one design whose width and height are within peerSizeTol of the element's; at most maxPeers, the nearest first. */
    peerSizeTol: 0.15, maxPeers: 12,
    /** Lattice: up to latticeSteps bays across and storeys up or down. */
    latticeSteps: 4,
    /** Tone: an exemplar fill is shifted to the mean colour of its material's real texels in cells of toneCellM, searched toneRings cells out; each channel moved at most toneMaxShift (0..255). */
    toneCellM: 3, toneRings: 3, toneMaxShift: 60
};
export type MaterialInfillParams = typeof MATERIAL_INFILL_PARAMS;
export const MATERIAL_INFILL_VERSION = 'material-infill/1';
/** What filled a texel: 0 the photo (not a hole), then the steps above; left: a hole of no planned material. */
export const INFILL_SOURCE = { real: 0, peer: 1, lattice: 2, exemplar: 3, flat: 4, left: 5 } as const;

export interface InfillStats { holes: number; peer: number; lattice: number; exemplar: number; flat: number; left: number; byRole: Record<string, number> }
export interface InfillResult { rgba: Uint8Array; source: Uint8Array; material: Int32Array; stats: InfillStats }

/**
 * One facade's holes filled from its elements' materials. `hole` is 1 where the photo has nothing to show (uncovered,
 * occluded or a smear); `photos` gives the plan's exemplars their pixels (the facades they were cut from).
 */
export function infillFacade(
    fi: StructureIntent['facades'][number], frame: { pixel: number; width: number; height: number }, photo: Pick<PlanPhoto, 'rgba' | 'width' | 'height'>, hole: Uint8Array,
    plan: MaterialPlan, photos: Map<number, Pick<PlanPhoto, 'rgba' | 'width' | 'height'>>, P: MaterialInfillParams = MATERIAL_INFILL_PARAMS, PP: MaterialPlanParams = MATERIAL_PLAN_PARAMS,
    opts: {
        /** The photo's own column and row periods (m), for a facade whose intent carries no pitch (no lattice, no repeating region). */
        photoPeriod?: { colM?: number; rowM?: number };
        /** Fill only these hole texels (1); the other holes stay holes, and are never a source. For filling what another fill left. */
        only?: Uint8Array;
    } = {}
): InfillResult {
    const photoPeriod = opts.photoPeriod ?? {};
    const W = frame.width, H = frame.height, N = W * H, px = frame.pixel;
    const out = new Uint8Array(N * 4); for (let i = 0; i < N * 4; i++) out[i] = photo.rgba[i];
    const source = new Uint8Array(N), material = new Int32Array(N);
    const stats: InfillStats = { holes: 0, peer: 0, lattice: 0, exemplar: 0, flat: 0, left: 0, byRole: {} };
    const els = facadeElements(fi, frame, PP), planEls = plan.facades.find(f => f.facadeId === fi.facadeId)?.elements ?? [];
    const matOfEl = els.map((_, k) => planEls[k]?.material ?? 0);
    // every texel's element: the one painted last over it
    const label = new Int32Array(N).fill(-1);
    els.forEach((e, k) => { for (let y = Math.max(0, Math.floor(e.rect[1])); y < Math.min(H, Math.ceil(e.rect[3])); y++) for (let x = Math.max(0, Math.floor(e.rect[0])); x < Math.min(W, Math.ceil(e.rect[2])); x++) label[y * W + x] = k; });
    for (let i = 0; i < N; i++) material[i] = label[i] >= 0 ? matOfEl[label[i]] : 0;
    const luma = (j: number) => 0.2126 * photo.rgba[4 * j] + 0.7152 * photo.rgba[4 * j + 1] + 0.0722 * photo.rgba[4 * j + 2];
    const write = (i: number, r: number, g: number, b: number, s: number) => { out[4 * i] = r; out[4 * i + 1] = g; out[4 * i + 2] = b; out[4 * i + 3] = 255; source[i] = s; };
    const copy = (i: number, j: number, s: number) => write(i, photo.rgba[4 * j], photo.rgba[4 * j + 1], photo.rgba[4 * j + 2], s);

    // 1. peers: elements of one design and size
    const byDesign = new Map<string, number[]>();
    els.forEach((e, k) => { const key = `${e.role}:${e.key}`; (byDesign.get(key) ?? byDesign.set(key, []).get(key)!).push(k); });
    const peersOf = new Map<number, number[]>();
    const peers = (k: number): number[] => {
        let p = peersOf.get(k); if (p) return p;
        const e = els[k].rect, ew = e[2] - e[0], eh = e[3] - e[1], cx = (e[0] + e[2]) / 2, cy = (e[1] + e[3]) / 2;
        p = els[k].role === 'wall' ? [] : (byDesign.get(`${els[k].role}:${els[k].key}`) ?? []).filter(o => {
            if (o === k) return false;
            const r = els[o].rect; return Math.abs(r[2] - r[0] - ew) <= P.peerSizeTol * ew && Math.abs(r[3] - r[1] - eh) <= P.peerSizeTol * eh;
        }).map(o => ({ o, d: Math.hypot((els[o].rect[0] + els[o].rect[2]) / 2 - cx, (els[o].rect[1] + els[o].rect[3]) / 2 - cy) })).sort((a, b) => a.d - b.d).slice(0, P.maxPeers).map(v => v.o);
        peersOf.set(k, p); return p;
    };
    const cand: Array<{ j: number; l: number }> = [];
    const pick = (i: number, s: number): boolean => { if (!cand.length) return false; cand.sort((a, b) => a.l - b.l); copy(i, cand[cand.length >> 1].j, s); return true; };
    // the facade's pitches, for the lattice step: its top-down lattice, else its repeating regions'
    const lat = fi.lattice?.accepted ? fi.lattice : undefined;
    const reg = fi.regions.find(r => r.decision === 'repeat' && r.pitchPx);
    const bayPx = lat ? lat.bayM / px : reg?.pitchPx?.[0] ?? (photoPeriod.colM ? photoPeriod.colM / px : undefined);
    const rowPx = lat && lat.rowPitchM > 0 ? lat.rowPitchM / px : reg?.pitchPx?.[1] ?? (photoPeriod.rowM ? photoPeriod.rowM / px : undefined);
    const pending: number[] = [];
    for (let i = 0; i < N; i++) {
        if (!hole[i] || (opts.only && !opts.only[i])) continue;
        stats.holes++;
        const k = label[i], m = material[i];
        if (k < 0 || !m) { source[i] = INFILL_SOURCE.left; stats.left++; continue; }
        stats.byRole[els[k].role] = (stats.byRole[els[k].role] ?? 0) + 1;
        const x = i % W, y = (i - x) / W, e = els[k].rect, u = (x + 0.5 - e[0]) / (e[2] - e[0]), v = (y + 0.5 - e[1]) / (e[3] - e[1]);
        cand.length = 0;
        for (const o of peers(k)) {
            const r = els[o].rect, xx = Math.floor(r[0] + u * (r[2] - r[0])), yy = Math.floor(r[1] + v * (r[3] - r[1]));
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            const j = yy * W + xx;
            if (!hole[j] && label[j] === o) cand.push({ j, l: luma(j) });
        }
        if (pick(i, INFILL_SOURCE.peer)) { stats.peer++; continue; }
        // 2. the lattice: the same material a whole number of bays or storeys away
        for (let s = 1; s <= P.latticeSteps; s++) for (const sg of [-1, 1]) {
            if (bayPx && bayPx > 2) { const xx = Math.round(x + sg * s * bayPx); if (xx >= 0 && xx < W) { const j = y * W + xx; if (!hole[j] && material[j] === m) cand.push({ j, l: luma(j) }); } }
            if (rowPx && rowPx > 2) { const yy = Math.round(y + sg * s * rowPx); if (yy >= 0 && yy < H) { const j = yy * W + x; if (!hole[j] && material[j] === m) cand.push({ j, l: luma(j) }); } }
        }
        if (pick(i, INFILL_SOURCE.lattice)) { stats.lattice++; continue; }
        pending.push(i);
    }
    if (!pending.length) return { rgba: out, source, material, stats };

    // 3. exemplars, tone-matched to the material's real texels near the hole
    const cell = Math.max(4, Math.round(P.toneCellM / px)), gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
    const tone = new Map<number, Float64Array>();
    const toneOf = (m: number): Float64Array => {
        let t = tone.get(m); if (t) return t;
        t = new Float64Array(gw * gh * 4);
        for (let i = 0; i < N; i++) if (!hole[i] && material[i] === m) { const x = i % W, c = (Math.floor((i - x) / W / cell) * gw + Math.floor(x / cell)) * 4; t[c] += photo.rgba[4 * i]; t[c + 1] += photo.rgba[4 * i + 1]; t[c + 2] += photo.rgba[4 * i + 2]; t[c + 3]++; }
        tone.set(m, t); return t;
    };
    const localMean = (m: number, x: number, y: number): [number, number, number] | undefined => {
        const t = toneOf(m), cx = Math.floor(x / cell), cy = Math.floor(y / cell);
        for (let r = 0; r <= P.toneRings; r++) {
            let R = 0, G = 0, B = 0, n = 0;
            for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                const gx = cx + dx, gy = cy + dy; if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
                const c = (gy * gw + gx) * 4; R += t[c]; G += t[c + 1]; B += t[c + 2]; n += t[c + 3];
            }
            if (n >= 30) return [R / n, G / n, B / n];
        }
        return undefined;
    };
    type Ex = { rgba: ArrayLike<number>; W: number; x0: number; y0: number; w: number; h: number; scale: number; mean: [number, number, number] };
    const exOf = new Map<number, Ex | null>();
    const exemplar = (m: number): Ex | null => {
        const got = exOf.get(m); if (got !== undefined) return got;
        const entry = plan.materials.find(e => e.id === m);
        // this facade's own exemplar first (its light and texel size), else the largest of another facade
        const list = [...(entry?.exemplars ?? [])].sort((a, b) => Number(b.facadeId === fi.facadeId) - Number(a.facadeId === fi.facadeId) || (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1]) - (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1]));
        let ex: Ex | null = null;
        for (const c of list) {
            const ph = c.facadeId === fi.facadeId ? photo : photos.get(c.facadeId); if (!ph) continue;
            const x0 = Math.max(0, Math.floor(c.rect[0])), y0 = Math.max(0, Math.floor(c.rect[1])), w = Math.min(ph.width, Math.ceil(c.rect[2])) - x0, h = Math.min(ph.height, Math.ceil(c.rect[3])) - y0;
            if (w < 2 || h < 2) continue;
            let R = 0, G = 0, B = 0; for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const j = (y * ph.width + x) * 4; R += ph.rgba[j]; G += ph.rgba[j + 1]; B += ph.rgba[j + 2]; }
            ex = { rgba: ph.rgba, W: ph.width, x0, y0, w, h, scale: px / c.texelM, mean: [R / (w * h), G / (w * h), B / (w * h)] }; break;
        }
        exOf.set(m, ex); return ex;
    };
    // mirrored tiling: 0..n-1, n-1..0, ... so a tile's edges meet themselves
    const reflect = (t: number, n: number) => { const p = ((Math.floor(t) % (2 * n)) + 2 * n) % (2 * n); return p < n ? p : 2 * n - 1 - p; };
    const clampShift = (v: number) => Math.max(-P.toneMaxShift, Math.min(P.toneMaxShift, v));
    const c8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
    for (const i of pending) {
        const m = material[i], x = i % W, y = (i - x) / W, ex = exemplar(m);
        if (ex) {
            const j = ((ex.y0 + reflect(y * ex.scale, ex.h)) * ex.W + ex.x0 + reflect(x * ex.scale, ex.w)) * 4, t = localMean(m, x, y);
            const s = t ? [clampShift(t[0] - ex.mean[0]), clampShift(t[1] - ex.mean[1]), clampShift(t[2] - ex.mean[2])] : [0, 0, 0];
            write(i, c8(ex.rgba[j] + s[0]), c8(ex.rgba[j + 1] + s[1]), c8(ex.rgba[j + 2] + s[2]), INFILL_SOURCE.exemplar); stats.exemplar++;
            continue;
        }
        // 4. the material's measured colour, else the local mean of its real texels
        const flat = plan.materials.find(e => e.id === m)?.colour?.srgb ?? localMean(m, x, y);
        if (flat) { write(i, c8(flat[0]), c8(flat[1]), c8(flat[2]), INFILL_SOURCE.flat); stats.flat++; }
        else { source[i] = INFILL_SOURCE.left; stats.left++; }
    }
    return { rgba: out, source, material, stats };
}
