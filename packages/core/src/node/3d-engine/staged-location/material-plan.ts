/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The material plan: one material per element of the structure (structure-intent.ts), read from the photogrammetry
 * texture, for the infill and the procedural build to draw from instead of the nearest texel or a generic set.
 *
 *  1. Elements. Each facade's intent gives its elements in the straightened photo's pixels: every window's glass (its
 *     rectangle inset by frameM) and frame (the ring), the piers, the spandrels between stacked windows, and the bare
 *     wall of each region (the rest of its band). An element's group is its role and what it shares a design with (a
 *     facade's window family, its piers, a region's wall), so repeats, mirrors and twins share their source's material.
 *  2. Materials. Each group's colour is read from the photo over its usable texels (the photo reached them unblocked and
 *     not as a smear); groups of one role whose colours agree (CIELAB, chroma relative to lightness: shade reads as one
 *     material lit differently) are one material; a material too small to stand joins its nearest; a group the photo
 *     never reached takes its role's largest material (generated).
 *  3. Exemplars and measures. Each material's cleanest patches (fully usable, nearest its mean colour, from several
 *     elements and facades) are cut from the photos at their real texel size into an atlas; from them its colour (mean
 *     and spread, as captured: the orthos are not de-lit), its repeat unit (luma autocorrelation at real scale, reported
 *     only where the patches agree on one, and never finer than the photo resolves), its grain (luma energy in three
 *     bands of real size), its finish (pipeline K's finish read of the nearest class, when the run has one) and the
 *     nearest library sets by colour, finish and real tile size.
 * Every value says where it came from: photo-inferred (measured on the photo), generated (assumed for want of photo).
 */

import type { StructureIntent } from './structure-intent';

type Rect = [number, number, number, number];
type Lab = [number, number, number];

export interface PlanPhoto { rgba: ArrayLike<number>; width: number; height: number; valid: Uint8Array; occluded?: Uint8Array; featureless?: Uint8Array }
export interface PlanFacadeInput { facadeId: number; frame: { pixel: number; width: number; height: number }; photo?: PlanPhoto }
/** Pipeline K's material classes for the run (pipeline_k_materials.json classes): colour, chosen set and finish read. */
export interface KClass { meanLab: number[]; /** Read inside the window openings (pipeline K splits the classes there from the wall's). */ openings?: boolean; set?: string; choice?: { by?: string; seen?: string; conf?: number }; finish?: { read?: { roughness: number; metalness: number; conf: number; seen?: string }; roughness?: number; metallic?: number } }
/** The texture library's measured stats (assets/textures/library/stats.json sets) and estimated real widths (estimated-sizes.json). */
export interface LibraryStats { sets: Record<string, { colour?: { meanLab?: number[] }; roughnessMean?: number; metallic?: number }>; widthM?: Record<string, { widthM: number; conf?: number }> }

export interface MaterialPlanEntry {
    id: number; role: string;
    elements: number; groups: number; areaM2: number; usableM2: number;
    colour?: { lab: Lab; spreadLab: Lab; srgb: [number, number, number]; captured: true };
    repeat?: { xM?: number; yM?: number; strength: number; resolvableM: number };
    grain?: { bandsM: Array<[number, number]>; /** Per band; null where the exemplars are too small to hold the band. */ energy: Array<number | null> };
    finish?: { roughness: number; metalness: number; conf: number; seen?: string; from: 'pipeline K'; kClass: number; deltaE: number; kSet?: string };
    library?: Array<{ set: string; deltaE: number; widthM?: number; roughness?: number; score: number; /** Pipeline K's pick for the nearest class (by its vision model's look at the patches). */ byLook?: boolean }>;
    exemplars: Array<{ facadeId: number; rect: Rect; texelM: number; usable: number; deltaE: number; atlas: Rect }>;
    provenance: 'photo-inferred' | 'generated';
    reason: string;
}
export interface MaterialPlan {
    version: string; params: MaterialPlanParams;
    materials: MaterialPlanEntry[];
    facades: Array<{ facadeId: number; elements: Array<{ role: string; rect: Rect; material: number }> }>;
    atlas?: { width: number; height: number; cellPx: number };
}

export const MATERIAL_PLAN_PARAMS = {
    /** A window's frame this wide (m) around its glass; a spandrel between stacked windows spandrelMinM..spandrelMaxM apart, inset spandrelInsetM. */
    frameM: 0.08, spandrelMinM: 0.4, spandrelMaxM: 3, spandrelInsetM: 0.15,
    /** Material distance: lightness weight against chroma taken relative to lightness; groups within matDeltaE (matDeltaESurface for wall) are one material; one under matMinShare of its role's usable area joins its nearest. */
    matLightWeight: 0.15, matDeltaE: 6, matDeltaESurface: 7, matMinShare: 0.03,
    /** Exemplars: patches at most patchM square, at least patchUsable usable, up to exemplars per material and exemplarsPerFacade from one facade; each laid in the atlas at cellPx. */
    patchM: 1.2, patchUsable: 0.9, exemplars: 8, exemplarsPerFacade: 3, cellPx: 96,
    /** The element's own texels must fill patchOwn of a patch (patchOwnThin for a frame's ring). */
    patchOwn: 0.8, patchOwnThin: 0.15,
    /** A repeat stands when the exemplars' luma autocorrelation peaks at repeatMinAc or more at one lag (within repeatLagTol) on most of them; never finer than two texels. */
    repeatMinAc: 0.3, repeatLagTol: 0.15,
    /** Grain bands (m): luma energy between box blurs of these sizes. */
    grainBandsM: [[0, 0.15], [0.15, 0.5], [0.5, 1.2]] as Array<[number, number]>,
    /** Finish from pipeline K's nearest class (on the same side of the window openings) within kDeltaE (K's colours are the de-lit twin's, these the captured photo's, so the distance is reported); library candidates by colour, finish (roughness weighted libRoughW) and a known real width in libWidthM. */
    kDeltaE: 15, libRoughW: 20, libWidthM: [0.2, 8] as [number, number], libTop: 3
};
export type MaterialPlanParams = typeof MATERIAL_PLAN_PARAMS;
export const MATERIAL_PLAN_VERSION = 'material-plan/1';

const srgbLin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const LUT = Array.from({ length: 256 }, (_, i) => srgbLin(i));
export function rgbToLab(r: number, g: number, b: number): Lab {
    const R = LUT[r], G = LUT[g], B = LUT[b];
    const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * B, z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
function labToSrgb(L: number, a: number, b: number): [number, number, number] {
    const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200, inv = (t: number) => (t ** 3 > 216 / 24389 ? t ** 3 : (116 * t - 16) / (24389 / 27));
    const x = inv(fx) * 0.95047, y = inv(fy), z = inv(fz) * 1.08883;
    const lin = [3.2406 * x - 1.5372 * y - 0.4986 * z, -0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.204 * y + 1.057 * z];
    return lin.map(c => Math.round(255 * Math.min(1, Math.max(0, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)))) as [number, number, number];
}
const deltaE = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const med = (v: number[]) => { const a = [...v].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };

/** The elements of one facade's intent in its photo's pixels, in paint order (later over earlier): wall bands, piers, spandrels, frames, glass. */
export function facadeElements(fi: StructureIntent['facades'][number], frame: { pixel: number; width: number; height: number }, P: MaterialPlanParams = MATERIAL_PLAN_PARAMS): Array<{ role: string; key: string; rect: Rect }> {
    const out: Array<{ role: string; key: string; rect: Rect }> = [], px = frame.pixel;
    // the wall: each region's band, from halfway to the band above to halfway to the band below, the facade's width
    const regs = fi.regions.map((r, k) => ({ r, k })).sort((a, b) => a.r.y0 - b.r.y0);
    if (!regs.length) out.push({ role: 'wall', key: `${fi.facadeId}.all`, rect: [0, 0, frame.width, frame.height] });
    regs.forEach(({ r, k }, j) => {
        const top = j === 0 ? 0 : (regs[j - 1].r.y1 + r.y0) / 2, bot = j === regs.length - 1 ? frame.height : (r.y1 + regs[j + 1].r.y0) / 2;
        if (bot > top) out.push({ role: 'wall', key: `${fi.facadeId}.r${k}`, rect: [0, Math.max(0, top), frame.width, Math.min(frame.height, bot)] });
    });
    for (const p of fi.structure?.piers ?? []) out.push({ role: 'pier', key: `${fi.facadeId}`, rect: [p[0], p[1], p[2], p[3]] });
    // spandrels: between a window and the nearest one below it in its column
    const ws = fi.windows.map(w => ({ r: w.rect, fam: w.family }));
    for (const a of ws) {
        let below: typeof a | undefined;
        for (const b of ws) {
            if (b === a || b.r[1] < a.r[3]) continue;
            const ov = Math.min(a.r[2], b.r[2]) - Math.max(a.r[0], b.r[0]);
            if (ov < 0.5 * Math.min(a.r[2] - a.r[0], b.r[2] - b.r[0])) continue;
            if (!below || b.r[1] < below.r[1]) below = b;
        }
        if (!below) continue;
        const gap = (below.r[1] - a.r[3]) * px;
        if (gap < P.spandrelMinM || gap > P.spandrelMaxM) continue;
        const ins = P.spandrelInsetM / px, s: Rect = [Math.max(a.r[0], below.r[0]) + ins, a.r[3] + ins, Math.min(a.r[2], below.r[2]) - ins, below.r[1] - ins];
        if (s[2] - s[0] > 2 && s[3] - s[1] > 2) out.push({ role: 'spandrel', key: `${fi.facadeId}.${a.fam}`, rect: s });
    }
    const fr = P.frameM / px;
    for (const w of fi.windows) {
        const r = w.rect, f = Math.min(fr, (r[2] - r[0]) / 4, (r[3] - r[1]) / 4);
        out.push({ role: 'frame', key: `${fi.facadeId}.${w.family}`, rect: [r[0], r[1], r[2], r[3]] });
        out.push({ role: 'glass', key: `${fi.facadeId}.${w.family}`, rect: [r[0] + f, r[1] + f, r[2] - f, r[3] - f] });
    }
    return out;
}

/** Box blur of a luma patch (radius r px) by summed areas. */
function boxBlur(L: Float32Array, W: number, H: number, r: number): Float32Array {
    if (r < 1) return L;
    const S = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += L[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
        out[y * W + x] = (S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
    return out;
}

/** The strongest autocorrelation peak of a luma patch along one axis, over lags lo..hi px: lag and normalised value. */
function acPeak(L: Float32Array, W: number, H: number, axis: 'x' | 'y', lo: number, hi: number): { lag: number; ac: number } | undefined {
    let mean = 0; for (const v of L) mean += v; mean /= L.length;
    let v0 = 0; for (const v of L) v0 += (v - mean) ** 2;
    if (!(v0 > 1e-9)) return undefined;
    let best: { lag: number; ac: number } | undefined, prev = Infinity, rising = false;
    const n = axis === 'x' ? W : H;
    for (let lag = Math.max(1, lo); lag <= Math.min(hi, n - 2); lag++) {
        let s = 0, c = 0;
        for (let y = 0; y < H - (axis === 'y' ? lag : 0); y++) for (let x = 0; x < W - (axis === 'x' ? lag : 0); x++) { const i = y * W + x, j = axis === 'x' ? i + lag : i + lag * W; s += (L[i] - mean) * (L[j] - mean); c++; }
        const ac = (s / c) / (v0 / L.length);
        // a peak: the value turns down after rising
        if (rising && ac < prev && (!best || prev > best.ac)) best = { lag: lag - 1, ac: prev };
        rising = ac > prev; prev = ac;
    }
    return best;
}

/**
 * The material plan of a structure (see the module comment). `facades`: each facade's frame and straightened photo with
 * its masks; `kClasses`: pipeline K's material classes for the run; `library`: the texture library's stats and widths.
 */
export function buildMaterialPlan(intent: StructureIntent, facades: PlanFacadeInput[], opts: { kClasses?: KClass[]; library?: LibraryStats } = {}, P: MaterialPlanParams = MATERIAL_PLAN_PARAMS): { plan: MaterialPlan; atlas?: { width: number; height: number; rgb: Uint8Array } } {
    const byId = new Map(facades.map(f => [f.facadeId, f]));
    // 1. elements, painted per facade so each texel belongs to the element drawn last over it
    type Group = { role: string; key: string; elements: number; texels: number; usable: number; L: number; A: number; B: number; L2: number; A2: number; B2: number; px: number };
    const groups = new Map<string, Group>();
    const facadeEls: Array<{ facadeId: number; els: Array<{ role: string; key: string; rect: Rect }>; label?: Int32Array }> = [];
    for (const fi of intent.facades) {
        const fc = byId.get(fi.facadeId); if (!fc) continue;
        const els = facadeElements(fi, fc.frame, P), W = fc.frame.width, H = fc.frame.height;
        for (const e of els) { const k = `${e.role}:${e.key}`; const g = groups.get(k) ?? { role: e.role, key: k, elements: 0, texels: 0, usable: 0, L: 0, A: 0, B: 0, L2: 0, A2: 0, B2: 0, px: fc.frame.pixel }; g.elements++; groups.set(k, g); }
        const ph = fc.photo && fc.photo.width === W && fc.photo.height === H ? fc.photo : undefined;
        const label = new Int32Array(W * H).fill(-1);
        els.forEach((e, i) => { for (let y = Math.max(0, Math.floor(e.rect[1])); y < Math.min(H, Math.ceil(e.rect[3])); y++) for (let x = Math.max(0, Math.floor(e.rect[0])); x < Math.min(W, Math.ceil(e.rect[2])); x++) label[y * W + x] = i; });
        for (let i = 0; i < W * H; i++) {
            const e = label[i]; if (e < 0) continue;
            const g = groups.get(`${els[e].role}:${els[e].key}`)!; g.texels++;
            if (!ph || !ph.valid[i] || ph.occluded?.[i] || ph.featureless?.[i]) continue;
            const lab = rgbToLab(ph.rgba[4 * i], ph.rgba[4 * i + 1], ph.rgba[4 * i + 2]);
            g.usable++; g.L += lab[0]; g.A += lab[1]; g.B += lab[2]; g.L2 += lab[0] ** 2; g.A2 += lab[1] ** 2; g.B2 += lab[2] ** 2;
        }
        facadeEls.push({ facadeId: fi.facadeId, els, ...(ph ? { label } : {}) });
    }
    // 2. materials: one role's groups merged by colour (leader pass, then closest pairs), small ones into their nearest, unlit ones into the role's largest
    const rel = (c: number, L: number) => (c * 60) / Math.max(15, L);
    const dist = (a: Lab, b: Lab) => Math.hypot(P.matLightWeight * (a[0] - b[0]), rel(a[1], a[0]) - rel(b[1], b[0]), rel(a[2], a[0]) - rel(b[2], b[0]));
    type Mat = { role: string; lab: Lab; w: number; groups: Group[] };
    const mats: Mat[] = [], matOf = new Map<string, Mat>();
    for (const role of [...new Set([...groups.values()].map(g => g.role))]) {
        const thr = role === 'wall' ? P.matDeltaESurface : P.matDeltaE;
        const mine = [...groups.values()].filter(g => g.role === role), lit = mine.filter(g => g.usable >= Math.max(20, 0.2 * g.texels)).sort((a, b) => b.usable - a.usable);
        const rm: Mat[] = [];
        for (const g of lit) {
            const c: Lab = [g.L / g.usable, g.A / g.usable, g.B / g.usable];
            let best: Mat | undefined, bd = Infinity; for (const m of rm) { const d = dist(m.lab, c); if (d < bd) { bd = d; best = m; } }
            if (!best || bd > thr) { best = { role, lab: c, w: 0, groups: [] }; rm.push(best); }
            const w = g.usable; best.lab = best.lab.map((v, i) => (v * best!.w + c[i] * w) / (best!.w + w)) as Lab; best.w += w; best.groups.push(g);
        }
        for (;;) {
            let bi = -1, bj = -1, bd = thr;
            for (let i = 0; i < rm.length; i++) for (let j = i + 1; j < rm.length; j++) { const d = dist(rm[i].lab, rm[j].lab); if (d < bd) { bd = d; bi = i; bj = j; } }
            if (bi < 0) break;
            const a = rm[bi], b = rm[bj]; a.lab = a.lab.map((v, i) => (v * a.w + b.lab[i] * b.w) / (a.w + b.w)) as Lab; a.w += b.w; a.groups.push(...b.groups); rm.splice(bj, 1);
        }
        const total = rm.reduce((s, m) => s + m.w, 0);
        for (let i = rm.length - 1; i >= 0; i--) if (rm.length > 1 && rm[i].w < P.matMinShare * total) {
            const m = rm[i]; rm.splice(i, 1);
            let best = rm[0], bd = Infinity; for (const o of rm) { const d = dist(o.lab, m.lab); if (d < bd) { bd = d; best = o; } }
            best.lab = best.lab.map((v, k) => (v * best.w + m.lab[k] * m.w) / (best.w + m.w)) as Lab; best.w += m.w; best.groups.push(...m.groups);
        }
        let unlitMat: Mat | undefined;
        for (const g of mine) if (!lit.includes(g)) {
            const target = rm.length ? rm.reduce((a, b) => (b.w > a.w ? b : a)) : (unlitMat ??= { role, lab: [NaN, NaN, NaN], w: 0, groups: [] });
            target.groups.push(g);
            if (!rm.length && !rm.includes(target)) rm.push(target);
        }
        for (const m of rm) { mats.push(m); for (const g of m.groups) matOf.set(g.key, m); }
    }
    mats.sort((a, b) => a.role.localeCompare(b.role) || b.w - a.w);
    const idOf = new Map(mats.map((m, i) => [m, i + 1]));

    // 3. exemplars: candidate patches (an element's rectangle, at most patchM square, the wall cut into patchM squares), fully usable and of this element, nearest the material's colour
    type Cand = { mat: Mat; facadeId: number; rect: Rect; usable: number; lab: Lab; ei: number };
    const cands = new Map<Mat, Cand[]>();
    for (const fe of facadeEls) {
        const fc = byId.get(fe.facadeId)!, ph = fc.photo, label = fe.label; if (!ph || !label) continue;
        const W = fc.frame.width, H = fc.frame.height, side = Math.max(4, Math.round(P.patchM / fc.frame.pixel));
        fe.els.forEach((e, ei) => {
            const m = matOf.get(`${e.role}:${e.key}`); if (!m || !Number.isFinite(m.lab[0])) return;
            const tiles: Rect[] = [];
            const ew = e.rect[2] - e.rect[0], eh = e.rect[3] - e.rect[1];
            if (ew <= side && eh <= side) tiles.push(e.rect);
            else for (let y = e.rect[1]; y + Math.min(side, eh) <= e.rect[3] + 0.5; y += Math.min(side, eh)) for (let x = e.rect[0]; x + Math.min(side, ew) <= e.rect[2] + 0.5; x += Math.min(side, ew)) tiles.push([x, y, x + Math.min(side, ew), y + Math.min(side, eh)]);
            for (const t of tiles) {
                const x0 = Math.max(0, Math.floor(t[0])), x1 = Math.min(W, Math.ceil(t[2])), y0 = Math.max(0, Math.floor(t[1])), y1 = Math.min(H, Math.ceil(t[3]));
                if (x1 - x0 < 3 || y1 - y0 < 3) continue;
                let n = 0, own = 0, u = 0, L = 0, A = 0, B = 0;
                for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
                    const i = y * W + x; n++;
                    if (label[i] !== ei) continue;
                    own++;
                    if (!ph.valid[i] || ph.occluded?.[i] || ph.featureless?.[i]) continue;
                    const lab = rgbToLab(ph.rgba[4 * i], ph.rgba[4 * i + 1], ph.rgba[4 * i + 2]); u++; L += lab[0]; A += lab[1]; B += lab[2];
                }
                // judged on the element's own texels (a frame is a thin ring: most of its window's rectangle is glass), which must fill enough of the patch to show it
                if (!own || own < (e.role === 'frame' ? P.patchOwnThin : P.patchOwn) * n || u / own < P.patchUsable) continue;
                (cands.get(m) ?? cands.set(m, []).get(m)!).push({ mat: m, facadeId: fe.facadeId, rect: [x0, y0, x1, y1], usable: u / own, lab: [L / u, A / u, B / u], ei });
            }
        });
    }
    const cell = P.cellPx, rows = mats.length, atlasW = cell * P.exemplars, atlasH = cell * Math.max(1, rows);
    const atlas = new Uint8Array(atlasW * atlasH * 3).fill(255);
    const lib = opts.library;
    const entries: MaterialPlanEntry[] = mats.map((m, mi) => {
        const id = idOf.get(m)!, lit = Number.isFinite(m.lab[0]);
        const elements = m.groups.reduce((s, g) => s + g.elements, 0), areaM2 = m.groups.reduce((s, g) => s + g.texels * g.px * g.px, 0), usableM2 = m.groups.reduce((s, g) => s + g.usable * g.px * g.px, 0);
        const e: MaterialPlanEntry = { id, role: m.role, elements, groups: m.groups.length, areaM2: Math.round(areaM2), usableM2: Math.round(usableM2), exemplars: [], provenance: lit ? 'photo-inferred' : 'generated', reason: lit ? `${m.groups.length} element groups of role ${m.role} whose photo colours agree (shade read as one material lit differently)` : `the photo never reached these ${m.role} elements: one material assumed for them` };
        if (!lit) return e;
        const U = m.groups.reduce((s, g) => s + g.usable, 0), sp = [m.groups.reduce((s, g) => s + g.L2, 0) / U - m.lab[0] ** 2, m.groups.reduce((s, g) => s + g.A2, 0) / U - m.lab[1] ** 2, m.groups.reduce((s, g) => s + g.B2, 0) / U - m.lab[2] ** 2].map(v => Math.sqrt(Math.max(0, v)));
        e.colour = { lab: m.lab.map(v => Math.round(v * 10) / 10) as Lab, spreadLab: sp.map(v => Math.round(v * 10) / 10) as Lab, srgb: labToSrgb(m.lab[0], m.lab[1], m.lab[2]), captured: true };
        // the exemplars: nearest the material's colour, from several facades
        const cs = (cands.get(m) ?? []).map(c => ({ ...c, d: deltaE(c.lab, m.lab) })).sort((a, b) => a.d - b.d), picked: typeof cs = [], perFacade = new Map<number, number>();
        for (const c of cs) { if (picked.length >= P.exemplars) break; const n = perFacade.get(c.facadeId) ?? 0; if (n >= P.exemplarsPerFacade && cs.length > P.exemplars) continue; perFacade.set(c.facadeId, n + 1); picked.push(c); }
        const lumas: Array<{ L: Float32Array; W: number; H: number; texel: number }> = [];
        const labelOf = new Map(facadeEls.map(fe => [fe.facadeId, fe.label]));
        picked.forEach((c, k) => {
            const fc = byId.get(c.facadeId)!, ph = fc.photo!, W = fc.frame.width, pw = c.rect[2] - c.rect[0], phh = c.rect[3] - c.rect[1], lab = labelOf.get(c.facadeId)!;
            // only this element's texels: another element's (a window inside a wall patch) greyed in the atlas and given the material's mean in the measures
            const mine = (i: number) => lab[i] === c.ei;
            // into the atlas (nearest neighbour, the patch fitted to the cell at its own aspect)
            const s = cell / Math.max(pw, phh), ax = k * cell, ay = mi * cell;
            for (let y = 0; y < Math.floor(phh * s); y++) for (let x = 0; x < Math.floor(pw * s); x++) { const sx = c.rect[0] + Math.min(pw - 1, Math.floor(x / s)), sy = c.rect[1] + Math.min(phh - 1, Math.floor(y / s)), i = sy * W + sx, o = ((ay + y) * atlasW + ax + x) * 3; if (!mine(i)) { atlas[o] = atlas[o + 1] = atlas[o + 2] = 225; continue; } atlas[o] = ph.rgba[4 * i]; atlas[o + 1] = ph.rgba[4 * i + 1]; atlas[o + 2] = ph.rgba[4 * i + 2]; }
            const L = new Float32Array(pw * phh).fill(NaN);
            let sum = 0, n = 0;
            for (let y = 0; y < phh; y++) for (let x = 0; x < pw; x++) { const i = (c.rect[1] + y) * W + c.rect[0] + x; if (!mine(i)) continue; const v = 0.2126 * LUT[ph.rgba[4 * i]] + 0.7152 * LUT[ph.rgba[4 * i + 1]] + 0.0722 * LUT[ph.rgba[4 * i + 2]]; L[y * pw + x] = v; sum += v; n++; }
            for (let i = 0; i < L.length; i++) if (Number.isNaN(L[i])) L[i] = n ? sum / n : 0;
            lumas.push({ L, W: pw, H: phh, texel: fc.frame.pixel });
            e.exemplars.push({ facadeId: c.facadeId, rect: c.rect, texelM: fc.frame.pixel, usable: Math.round(c.usable * 100) / 100, deltaE: Math.round(c.d * 10) / 10, atlas: [ax, ay, ax + Math.floor(pw * s), ay + Math.floor(phh * s)] });
        });
        if (lumas.length) {
            // grain: luma energy between box blurs of the bands' sizes, the median over the exemplars
            const energy = P.grainBandsM.map(([a, b]) => med(lumas.map(({ L, W, H, texel }) => { const ra = Math.round(a / texel / 2), rb = Math.max(ra + 1, Math.round(b / texel / 2)); if (rb * 2 >= Math.min(W, H)) return NaN; const A = boxBlur(L, W, H, ra), B = boxBlur(L, W, H, rb); let s = 0; for (let i = 0; i < L.length; i++) s += (A[i] - B[i]) ** 2; return Math.sqrt(s / L.length); }).filter(Number.isFinite)));
            e.grain = { bandsM: P.grainBandsM, energy: energy.map(v => (Number.isFinite(v) && v > 0 ? Math.round(v * 1e4) / 1e4 : null)) };
            // the repeat: on most exemplars one autocorrelation peak at one lag (each axis), at least two texels
            const texel = lumas[0].texel, rep: MaterialPlanEntry['repeat'] = { strength: 0, resolvableM: Math.round(2 * texel * 100) / 100 };
            for (const axis of ['x', 'y'] as const) {
                const peaks = lumas.map(l => acPeak(l.L, l.W, l.H, axis, 2, Math.floor(0.6 * (axis === 'x' ? l.W : l.H)))).filter((p): p is { lag: number; ac: number } => !!p && p.ac >= P.repeatMinAc).map(p => ({ m: p.lag * texel, ac: p.ac }));
                if (peaks.length < Math.max(2, Math.ceil(0.5 * lumas.length))) continue;
                const lag = med(peaks.map(p => p.m)), agree = peaks.filter(p => Math.abs(p.m - lag) <= P.repeatLagTol * lag);
                if (agree.length < Math.max(2, Math.ceil(0.5 * lumas.length))) continue;
                rep[axis === 'x' ? 'xM' : 'yM'] = Math.round(lag * 100) / 100; rep.strength = Math.max(rep.strength, Math.round(med(agree.map(p => p.ac)) * 100) / 100);
            }
            if (rep.xM || rep.yM) e.repeat = rep;
        }
        // finish: pipeline K's nearest class
        let kBest = -1, kd = Infinity;
        // among K's classes read on the same side of the window openings as this role (glass and frames inside them, the rest outside), when K split them
        const inOpening = m.role === 'glass' || m.role === 'frame';
        const pool = (opts.kClasses ?? []).map((k, i) => ({ k, i })).filter(({ k }) => k.meanLab?.length === 3);
        const side = pool.some(({ k }) => k.openings !== undefined) ? pool.filter(({ k }) => !!k.openings === inOpening) : pool;
        for (const { k, i } of side) { const d = deltaE(k.meanLab, m.lab); if (d < kd) { kd = d; kBest = i; } }
        if (kBest >= 0 && kd <= P.kDeltaE) {
            const k = opts.kClasses![kBest], read = k.finish?.read;
            if (read || k.finish?.roughness !== undefined) e.finish = { roughness: read?.roughness ?? k.finish!.roughness!, metalness: read?.metalness ?? k.finish?.metallic ?? 0, conf: read?.conf ?? 0, ...(read?.seen ? { seen: read.seen } : {}), from: 'pipeline K', kClass: kBest, deltaE: Math.round(kd * 10) / 10, ...(k.set ? { kSet: k.set } : {}) };
        }
        // the library: nearest sets by colour, finish and a known real width, only with a finish read (the photo's colour is as captured, the library's an albedo: colour alone cannot tell glass from steel); pipeline K's own pick, chosen by look, first
        if (lib && e.finish) {
            const rough = e.finish?.roughness;
            e.library = Object.entries(lib.sets).filter(([id, st]) => st.colour?.meanLab?.length === 3 && (!lib.widthM || (lib.widthM[id] && lib.widthM[id].widthM >= P.libWidthM[0] && lib.widthM[id].widthM <= P.libWidthM[1])))
                .map(([id, st]) => { const d = deltaE(st.colour!.meanLab!, m.lab); return { set: id, deltaE: Math.round(d * 10) / 10, ...(lib.widthM?.[id] ? { widthM: lib.widthM[id].widthM } : {}), ...(st.roughnessMean !== undefined ? { roughness: Math.round(st.roughnessMean * 100) / 100 } : {}), score: Math.round((d + (rough !== undefined && st.roughnessMean !== undefined ? P.libRoughW * Math.abs(st.roughnessMean - rough) : 0)) * 10) / 10 }; })
                .sort((a, b) => a.score - b.score).slice(0, P.libTop);
            const kSet = e.finish.kSet;
            if (kSet && lib.sets[kSet]) e.library = [{ set: kSet, deltaE: Math.round(deltaE(lib.sets[kSet].colour?.meanLab ?? m.lab, m.lab) * 10) / 10, ...(lib.widthM?.[kSet] ? { widthM: lib.widthM[kSet].widthM } : {}), score: 0, byLook: true }, ...e.library.filter(l => l.set !== kSet)].slice(0, P.libTop);
        }
        return e;
    });
    const plan: MaterialPlan = {
        version: MATERIAL_PLAN_VERSION, params: P, materials: entries,
        facades: facadeEls.map(fe => ({ facadeId: fe.facadeId, elements: fe.els.map(e => ({ role: e.role, rect: e.rect.map(v => Math.round(v * 10) / 10) as Rect, material: idOf.get(matOf.get(`${e.role}:${e.key}`)!) ?? 0 })) })),
        atlas: { width: atlasW, height: atlasH, cellPx: cell }
    };
    return { plan, atlas: { width: atlasW, height: atlasH, rgb: atlas } };
}
