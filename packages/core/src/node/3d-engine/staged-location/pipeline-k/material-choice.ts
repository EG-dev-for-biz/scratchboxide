/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The library set of each appearance class chosen by how it looks (user ask, 2026-10-30: the colour ranking alone gave
 * limestone a sand beach and a pavement). The library search (material-sets.ts) shortlists the sets nearest the class in
 * colour, finish, relief and real tile size; a vision model is then shown, row by row, patches of the class from the
 * building's photos (classSwatchSheet) beside each candidate drawn at the same real size and recoloured to the class's
 * mean colour, so only the surface itself (grain, relief, joints, pattern, how its tone varies) tells them apart, and
 * picks the candidate that would pass for the same surface. The words it gives are labels; nothing branches on them.
 * A row it answers with none, or a reply that fails, keeps the ranking's nearest. The set is generated either way.
 */

import { encodePng } from '../png-encode';
import type { RgbaImage8 } from '../tile-texture-transfer';

export const MATERIAL_CHOICE_VERSION = 'material-choice/1';

/** Candidates shown a class (the ranking's nearest), and the cell each is drawn in, pixels. */
export const CHOICE_CANDIDATES = 10;
const CELL = 96, GAP = 8;
/** The span drawn when the swatches' real size is unknown: a facade's dressed units, a metre or two. */
export const CHOICE_SPAN_M = 1.5;

export interface ChoiceCandidate { id: string; realSizeM: [number, number]; preview: RgbaImage8 }
export interface ChoiceRow { meanLinear: [number, number, number]; candidates: ChoiceCandidate[] }

const toLinear = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const toByte = (l: number) => { const c = Math.max(0, Math.min(1, l)); return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055) * 255); };

/**
 * One candidate as a CELL-square patch spanning `spanM` metres of its surface (the tile repeated where the span is the
 * larger), each channel scaled in linear light so the patch's mean is the class's.
 */
export function candidatePatch(c: ChoiceCandidate, spanM: number, meanLinear: [number, number, number], cell = CELL): Uint8Array {
    const { preview: p } = c, sx = (spanM / c.realSizeM[0]) * p.width / cell, sy = (spanM / c.realSizeM[1]) * p.height / cell;
    const lin = new Float32Array(cell * cell * 3), sum = [0, 0, 0];
    for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) {
        const q = ((Math.floor(y * sy) % p.height) * p.width + (Math.floor(x * sx) % p.width)) * 4, o = (y * cell + x) * 3;
        for (let k = 0; k < 3; k++) { const v = toLinear(p.rgba[q + k]); lin[o + k] = v; sum[k] += v; }
    }
    const gain = sum.map((s, k) => (s > 0 ? meanLinear[k] / (s / (cell * cell)) : 0));
    const out = new Uint8Array(cell * cell * 4);
    for (let i = 0; i < cell * cell; i++) { for (let k = 0; k < 3; k++) out[i * 4 + k] = toByte(lin[i * 3 + k] * gain[k]); out[i * 4 + 3] = 255; }
    return out;
}

/** The candidates as a picture: one row a class (in the classes' order), its candidates left to right, on white. */
export function candidateSheet(rows: ChoiceRow[], spanM: number, cell = CELL): { width: number; height: number; rgba: Uint8Array } {
    const per = Math.max(1, ...rows.map(r => r.candidates.length)), W = per * (cell + GAP) + GAP, H = rows.length * (cell + GAP) + GAP;
    const out = new Uint8Array(W * H * 4).fill(255);
    rows.forEach((row, r) => row.candidates.forEach((c, k) => {
        const patch = candidatePatch(c, spanM, row.meanLinear, cell);
        for (let y = 0; y < cell; y++) out.set(patch.subarray(y * cell * 4, (y + 1) * cell * 4), ((GAP + r * (cell + GAP) + y) * W + GAP + k * (cell + GAP)) * 4);
    }));
    return { width: W, height: H, rgba: out };
}

/** The candidate sheet as PNG bytes, for the chooser. */
export function candidateSheetPng(rows: ChoiceRow[], spanM: number): Buffer {
    const sheet = candidateSheet(rows, spanM);
    return Buffer.from(encodePng(sheet.width, sheet.height, sheet.rgba, 4));
}

export function choicePrompt(rows: ChoiceRow[], spanM: number, ctx: { building?: string; brief?: string } = {}): string {
    const span = spanM >= 1 ? `${Math.round(spanM * 10) / 10} m` : `${Math.round(spanM * 100)} cm`;
    return [
        `Image 1: each row is one appearance class of the outside of ${ctx.building ?? 'a building'}, patches of its photographed surfaces (straightened, de-lit photos), each about ${span} across.`,
        `Image 2: row k holds candidate surfaces for image 1's row k, numbered 1 to n from the left, each a patch ${span} across, recoloured to that class's mean colour, so the colour tells them nothing: judge the surface itself, its grain, relief, joints, pattern and how its tone varies.`,
        ...(ctx.brief ? [`The building, as an architect described it from its photos: ${ctx.brief}`] : []),
        'For each row give "pick": the candidate that would pass for the same surface as the class seen on the building, or 0 when none would; "seen": what the class looks like in a few words; and "conf" (0..100).',
        `There are ${rows.length} rows, with ${rows.map(r => r.candidates.length).join(', ')} candidates. Answer with JSON only: {"rows":[{"row":1,"pick":1,"seen":"...","conf":0}]}`
    ].join('\n');
}

export interface SetChoice { pick: number; seen?: string; conf: number }

/** The reply: per row, the 1-based candidate picked (0: none), in row order; a row left out or out of range gets none. Throws on anything malformed. */
export function parseChoices(text: string, rows: ChoiceRow[]): Array<SetChoice | undefined> {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(j?.rows)) throw new Error('the reply has no "rows" list');
    const out: Array<SetChoice | undefined> = new Array(rows.length).fill(undefined);
    for (const r of j.rows) {
        if (typeof r?.row !== 'number' || typeof r.pick !== 'number') throw new Error('a row without a "row" or "pick"');
        const k = Math.round(r.row) - 1, pick = Math.round(r.pick);
        if (k < 0 || k >= rows.length || pick < 0 || pick > rows[k].candidates.length) continue;
        out[k] = { pick, ...(typeof r.seen === 'string' && r.seen.trim() ? { seen: r.seen.trim().slice(0, 80) } : {}), conf: typeof r.conf === 'number' && Number.isFinite(r.conf) ? Math.max(0, Math.min(100, r.conf)) : 50 };
    }
    return out;
}
