/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K's texture harmonisation: the photos of one textured building (Google's leaf-tile photos and K's straightened
 * facade orthos, all de-lit by the same curve) brought to one colour, so no patch stands out because its photo was
 * exposed or processed differently from its neighbour's.
 *
 *  1. Samples: every textured triangle sampled about every sampleM, each sample with its 3D position, normal, photo and
 *     colour (linear RGB, in logs).
 *  2. Colour match: the samples grouped by the side they face (sideBins compass bins of the horizontal normal; up and
 *     down apart) and by height band (bandM above the ground). Each group's reference is the area-weighted median of its
 *     photos' mean colours; each photo gets one gain per channel toward the references of the groups it covers (least
 *     squares, bounded by maxGainLog). A photo alone in its groups keeps its colour.
 *  3. Seam levelling (Lempitsky and Ivanov 2007, "Seamless mosaicing of image-based texture maps"): each photo gets a
 *     smooth low-resolution offset field over its UV square. Where two photos cover the same patch of surface (a seamM
 *     cell of space, facing the same way), their mean colours there must agree after their fields: a patch is a
 *     low-frequency difference, so patch means are compared, never single texels (whose window-or-pier detail no gain can
 *     match). A smoothness term joins neighbouring field nodes, and a weak pull holds them near zero. Solved per channel by
 *     conjugate gradients. Matching in space, not by shared vertices, reaches the seams between a rebuilt facade and the
 *     scan around it, which share no vertex.
 *
 * Verified: the result is kept only when the seams' mean patch difference (the same patches, measured again after) falls;
 * the report gives both. Only gains and smooth offsets are applied: no texel is moved or drawn.
 */

import { readAccessor, type ParsedGlb } from '../glb-bytes';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../../common/spatial/photogrammetric-delight';
import type { RgbaImage8 } from '../tile-texture-transfer';
import { Rows, solveLeastSquares } from './ortho-rectify';

export const TEXTURE_HARMONIZE_VERSION = 'texture-harmonize/1';

export const TEXTURE_HARMONIZE_PARAMS = {
    /** Sample spacing over the triangles (m), and at most this many samples a triangle. */
    sampleM: 0.6, maxSamplesPerTriangle: 64,
    /** Groups: compass bins of a wall's facing, height bands (m); a normal steeper than this |y| is up or down. */
    sideBins: 8, bandM: 15, flatNy: 0.7,
    /** A photo's gain is bounded (natural log, per channel), and scaled by this before the seams are levelled. */
    maxGainLog: Math.log(1.8), gainScale: 0.5,
    /** Seams: the patch of surface two photos are compared over (a cell of space, m), within one of seamFacingBins facings. */
    seamM: 1.5, seamFacingBins: 12,
    /** The offset field: a node about every fieldPx texels, at most maxField a side; smoothness and pull-to-zero weights. */
    fieldPx: 64, maxField: 24, wSmooth: 0.15, wAnchor: 0.01,
    /** Offsets are bounded (natural log). */
    maxOffsetLog: Math.log(1.6)
};
export type TextureHarmonizeParams = typeof TEXTURE_HARMONIZE_PARAMS;

export interface TextureHarmonizeReport {
    images: number; samples: number; groups: number;
    gains: { meanAbsLog: number; maxAbsLog: number };
    seams: { pairs: number; before: number; afterMatch: number; after: number };
    kept: boolean; why: string; ms: number;
}

interface Sample { x: number; y: number; z: number; nx: number; ny: number; nz: number; img: number; u: number; v: number; w: number; c: [number, number, number] }

const LOG_EPS = 1e-3;

/** Bilinear linear-RGB colour of an image at a UV (wrapped, glTF origin at the top left). */
function sampleLinear(img: RgbaImage8, u: number, v: number): [number, number, number] {
    const W = img.width, H = img.height;
    const fx = ((u % 1) + 1) % 1 * W - 0.5, fy = ((v % 1) + 1) % 1 * H - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), a = fx - x0, b = fy - y0;
    const at = (x: number, y: number, c: number) => SRGB8_TO_LINEAR[img.rgba[(((y + H) % H) * W + ((x + W) % W)) * 4 + c]];
    const out: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) out[c] = (1 - a) * (1 - b) * at(x0, y0, c) + a * (1 - b) * at(x0 + 1, y0, c) + (1 - a) * b * at(x0, y0 + 1, c) + a * b * at(x0 + 1, y0 + 1, c);
    return out;
}

/** The textured triangles of a GLB sampled over their area: position, normal, photo (image index), UV and colour. */
function samplesOf(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, P: TextureHarmonizeParams): Sample[] {
    const out: Sample[] = [];
    for (const mesh of json.meshes ?? []) for (const prim of mesh.primitives ?? []) {
        if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined || prim.material === undefined) continue;
        const tex = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture;
        if (!tex) continue;
        const source = json.textures?.[tex.index]?.source, img = source !== undefined ? images.get(source) : undefined;
        const uvAcc = prim.attributes[`TEXCOORD_${tex.texCoord ?? 0}`];
        if (!img || uvAcc === undefined) continue;
        const pos = readAccessor(g, prim.attributes.POSITION).data, uv = readAccessor(g, uvAcc).data;
        const idx = prim.indices !== undefined ? readAccessor(g, prim.indices).data : undefined;
        const n = idx ? idx.length : pos.length / 3;
        for (let t = 0; t + 2 < n; t += 3) {
            const ia = idx ? idx[t] : t, ib = idx ? idx[t + 1] : t + 1, ic = idx ? idx[t + 2] : t + 2;
            if (ia === ib || ib === ic || ia === ic) continue;
            const ux = pos[ib * 3] - pos[ia * 3], uy = pos[ib * 3 + 1] - pos[ia * 3 + 1], uz = pos[ib * 3 + 2] - pos[ia * 3 + 2];
            const vx = pos[ic * 3] - pos[ia * 3], vy = pos[ic * 3 + 1] - pos[ia * 3 + 1], vz = pos[ic * 3 + 2] - pos[ia * 3 + 2];
            let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
            const area2 = Math.hypot(nx, ny, nz);
            if (!(area2 > 1e-9)) continue;
            nx /= area2; ny /= area2; nz /= area2;
            const steps = Math.max(1, Math.min(Math.floor(Math.sqrt(2 * P.maxSamplesPerTriangle)) - 1, Math.ceil(Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz)) / P.sampleM)));
            const count = ((steps + 1) * (steps + 2)) / 2, w = (0.5 * area2) / count;
            for (let p = 0; p <= steps; p++) for (let q = 0; p + q <= steps; q++) {
                // the sample points sit off the corners (a corner is shared with the next triangle's photo)
                const a = (p + 1 / 3) / (steps + 1), b = (q + 1 / 3) / (steps + 1);
                if (a + b > 1) continue;
                const su = uv[ia * 2] + (uv[ib * 2] - uv[ia * 2]) * a + (uv[ic * 2] - uv[ia * 2]) * b;
                const sv = uv[ia * 2 + 1] + (uv[ib * 2 + 1] - uv[ia * 2 + 1]) * a + (uv[ic * 2 + 1] - uv[ia * 2 + 1]) * b;
                const lin = sampleLinear(img, su, sv);
                out.push({
                    x: pos[ia * 3] + ux * a + vx * b, y: pos[ia * 3 + 1] + uy * a + vy * b, z: pos[ia * 3 + 2] + uz * a + vz * b, nx, ny, nz,
                    img: source, u: su, v: sv, w, c: [Math.log(lin[0] + LOG_EPS), Math.log(lin[1] + LOG_EPS), Math.log(lin[2] + LOG_EPS)]
                });
            }
        }
    }
    return out;
}

const weightedMedian = (v: number[], w: number[]): number => {
    const idx = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
    const total = w.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (const i of idx) { acc += w[i]; if (acc >= total / 2) return v[i]; }
    return v[idx[idx.length - 1]];
};

/** The offset field of one photo: nodes over its UV square. */
interface Field { nx: number; ny: number; base: number }

/** Bilinear weights of a UV in a photo's field: node indices (global) and weights. */
function fieldWeights(f: Field, u: number, v: number): [number[], number[]] {
    const fx = (((u % 1) + 1) % 1) * (f.nx - 1), fy = (((v % 1) + 1) % 1) * (f.ny - 1);
    const i = Math.min(f.nx - 2, Math.floor(fx)), j = Math.min(f.ny - 2, Math.floor(fy)), a = fx - i, b = fy - j;
    const at = (ii: number, jj: number) => f.base + jj * f.nx + ii;
    return [[at(i, j), at(i + 1, j), at(i, j + 1), at(i + 1, j + 1)], [(1 - a) * (1 - b), a * (1 - b), (1 - a) * b, a * b]];
}

/**
 * Harmonises the photos in `images` (image index -> de-lit photo) of the textured GLB `g` (its JSON `json`) in place:
 * colour matched per side and height band, seams levelled. `groundY` is the ground the bands are measured from.
 */
export function harmonizeTextures(g: ParsedGlb, json: any, images: Map<number, RgbaImage8>, groundY: number, P: TextureHarmonizeParams = TEXTURE_HARMONIZE_PARAMS): TextureHarmonizeReport {
    const t0 = Date.now();
    const samples = samplesOf(g, json, images, P);
    const report: TextureHarmonizeReport = { images: images.size, samples: samples.length, groups: 0, gains: { meanAbsLog: 0, maxAbsLog: 0 }, seams: { pairs: 0, before: 0, afterMatch: 0, after: 0 }, kept: false, why: '', ms: 0 };
    if (samples.length < 100 || images.size < 2) { report.why = 'fewer than two photos or too few samples: nothing to harmonise'; report.ms = Date.now() - t0; return report; }
    // 2. groups and their references
    const groupOf = (s: Sample) => {
        const band = Math.floor((s.y - groundY) / P.bandM);
        if (s.ny > P.flatNy) return `up:${band}`;
        if (s.ny < -P.flatNy) return `down:${band}`;
        const az = Math.atan2(s.nx, s.nz), bin = ((Math.round((az / (2 * Math.PI)) * P.sideBins) % P.sideBins) + P.sideBins) % P.sideBins;
        return `side${bin}:${band}`;
    };
    const stats = new Map<string, Map<number, { w: number; c: [number, number, number] }>>();
    for (const s of samples) {
        const k = groupOf(s);
        let m = stats.get(k); if (!m) stats.set(k, (m = new Map()));
        let e = m.get(s.img); if (!e) m.set(s.img, (e = { w: 0, c: [0, 0, 0] }));
        e.w += s.w; for (let c = 0; c < 3; c++) e.c[c] += s.w * s.c[c];
    }
    report.groups = stats.size;
    const gainNum = new Map<number, [number, number, number]>(), gainDen = new Map<number, number>();
    for (const m of stats.values()) {
        if (m.size < 2) continue;
        const list = [...m.entries()].map(([img, e]) => ({ img, w: e.w, c: e.c.map(v => v / e.w) as [number, number, number] }));
        const ref = [0, 1, 2].map(c => weightedMedian(list.map(x => x.c[c]), list.map(x => x.w)));
        for (const x of list) {
            const num = gainNum.get(x.img) ?? [0, 0, 0];
            for (let c = 0; c < 3; c++) num[c] += x.w * (ref[c] - x.c[c]);
            gainNum.set(x.img, num); gainDen.set(x.img, (gainDen.get(x.img) ?? 0) + x.w);
        }
    }
    const gain = new Map<number, [number, number, number]>();
    let sumAbs = 0, maxAbs = 0;
    for (const [img, num] of gainNum) {
        const d = gainDen.get(img)!, gg = num.map(v => P.gainScale * Math.max(-P.maxGainLog, Math.min(P.maxGainLog, v / d))) as [number, number, number];
        gain.set(img, gg);
        for (const v of gg) { sumAbs += Math.abs(v); maxAbs = Math.max(maxAbs, Math.abs(v)); }
    }
    report.gains = { meanAbsLog: gain.size ? +(sumAbs / (3 * gain.size)).toFixed(4) : 0, maxAbsLog: +maxAbs.toFixed(4) };
    // 3. seam patches: per cell of space and facing, the mean colour and UV of each photo there; a patch two photos share is a seam
    const facingBin = (s: Sample) => (s.ny > P.flatNy ? 'u' : s.ny < -P.flatNy ? 'd' : String(((Math.round((Math.atan2(s.nx, s.nz) / (2 * Math.PI)) * P.seamFacingBins) % P.seamFacingBins) + P.seamFacingBins) % P.seamFacingBins));
    const patches = new Map<string, Map<number, { w: number; c: [number, number, number]; u: number; v: number }>>();
    for (const s of samples) {
        const k = `${Math.floor(s.x / P.seamM)},${Math.floor(s.y / P.seamM)},${Math.floor(s.z / P.seamM)},${facingBin(s)}`;
        let m = patches.get(k); if (!m) patches.set(k, (m = new Map()));
        let e = m.get(s.img); if (!e) m.set(s.img, (e = { w: 0, c: [0, 0, 0], u: 0, v: 0 }));
        e.w += s.w; e.u += s.w * s.u; e.v += s.w * s.v; for (let c = 0; c < 3; c++) e.c[c] += s.w * s.c[c];
    }
    // the pairs: each photo in a shared patch against the patch's largest photo (a star, not every pair)
    const pairs: Array<{ a: { img: number; u: number; v: number; c: [number, number, number] }; b: { img: number; u: number; v: number; c: [number, number, number] }; w: number }> = [];
    for (const m of patches.values()) {
        if (m.size < 2) continue;
        const list = [...m.entries()].map(([img, e]) => ({ img, w: e.w, u: e.u / e.w, v: e.v / e.w, c: e.c.map(x => x / e.w) as [number, number, number] })).sort((x, y) => y.w - x.w);
        for (let k = 1; k < list.length; k++) pairs.push({ a: list[0], b: list[k], w: Math.min(list[0].w, list[k].w) });
    }
    report.seams.pairs = pairs.length;
    const g0 = (img: number, c: number) => gain.get(img)?.[c] ?? 0;
    const seamDiff = (off?: Float64Array[], fields?: Map<number, Field>, useGain = true) => {
        let s = 0, wt = 0;
        for (const { a, b, w } of pairs) {
            for (let c = 0; c < 3; c++) {
                let va = a.c[c] + (useGain ? g0(a.img, c) : 0), vb = b.c[c] + (useGain ? g0(b.img, c) : 0);
                if (off && fields) {
                    const [ka, wa] = fieldWeights(fields.get(a.img)!, a.u, a.v), [kb, wb] = fieldWeights(fields.get(b.img)!, b.u, b.v);
                    for (let q = 0; q < 4; q++) { va += wa[q] * off[c][ka[q]]; vb += wb[q] * off[c][kb[q]]; }
                }
                s += w * Math.abs(va - vb); wt += w;
            }
        }
        return wt > 0 ? s / wt : 0;
    };
    report.seams.before = +seamDiff(undefined, undefined, false).toFixed(4);
    report.seams.afterMatch = +seamDiff().toFixed(4);
    // the fields: one per photo, solved per channel
    const fields = new Map<number, Field>();
    let nodes = 0;
    for (const [img, im] of images) {
        const nx = Math.max(2, Math.min(P.maxField, Math.ceil(im.width / P.fieldPx) + 1)), ny = Math.max(2, Math.min(P.maxField, Math.ceil(im.height / P.fieldPx) + 1));
        fields.set(img, { nx, ny, base: nodes });
        nodes += nx * ny;
    }
    const off: Float64Array[] = [];
    for (let c = 0; c < 3; c++) {
        const rows = new Rows();
        for (const { a, b, w } of pairs) {
            const [ka, wa] = fieldWeights(fields.get(a.img)!, a.u, a.v), [kb, wb] = fieldWeights(fields.get(b.img)!, b.u, b.v);
            // off_a(uv_a) - off_b(uv_b) = (b + gain_b) - (a + gain_a), weighted by the smaller photo's area in the patch (m2)
            rows.add([...ka, ...kb], [...wa, ...wb.map(x => -x)], (b.c[c] + g0(b.img, c)) - (a.c[c] + g0(a.img, c)), Math.min(4, w));
        }
        for (const f of fields.values()) for (let jy = 0; jy < f.ny; jy++) for (let ix = 0; ix < f.nx; ix++) {
            const k = f.base + jy * f.nx + ix;
            rows.add([k], [1], 0, P.wAnchor);
            if (ix + 1 < f.nx) rows.add([k, k + 1], [1, -1], 0, P.wSmooth);
            if (jy + 1 < f.ny) rows.add([k, k + f.nx], [1, -1], 0, P.wSmooth);
        }
        const sol = solveLeastSquares(rows, nodes, new Float64Array(nodes), 400, 1e-6);
        for (let k = 0; k < nodes; k++) sol.u[k] = Math.max(-P.maxOffsetLog, Math.min(P.maxOffsetLog, sol.u[k]));
        off.push(sol.u);
    }
    report.seams.after = +seamDiff(off, fields).toFixed(4);
    if (!(report.seams.after < report.seams.before)) { report.why = `the seams did not get closer (${report.seams.before} -> ${report.seams.after} in log colour)`; report.ms = Date.now() - t0; return report; }
    // apply: per texel, the photo's gain and its field's offset, in linear light
    for (const [img, im] of images) {
        const f = fields.get(img)!, gg = gain.get(img) ?? [0, 0, 0], out = new Uint8Array(im.rgba);
        for (let y = 0; y < im.height; y++) for (let x = 0; x < im.width; x++) {
            const [k, w] = fieldWeights(f, (x + 0.5) / im.width, (y + 0.5) / im.height);
            const p = (y * im.width + x) * 4;
            for (let c = 0; c < 3; c++) {
                let o = gg[c];
                for (let q = 0; q < 4; q++) o += w[q] * off[c][k[q]];
                const lin = SRGB8_TO_LINEAR[im.rgba[p + c]] * Math.exp(o);
                out[p + c] = Math.round(linearToSrgb255(lin));
            }
        }
        images.set(img, { width: im.width, height: im.height, rgba: out });
    }
    report.kept = true;
    report.why = `${images.size} photos matched to ${report.groups} side and height-band references (mean gain ${Math.round((Math.exp(report.gains.meanAbsLog) - 1) * 100)}%), ${pairs.length} shared surface patches levelled: mean patch difference ${report.seams.before} -> ${report.seams.afterMatch} (matched) -> ${report.seams.after} (levelled), in log colour`;
    report.ms = Date.now() - t0;
    return report;
}
