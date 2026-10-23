/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G, step 3: each surveyed wall's plate read as a facade program in metres, and the program as the native tool's
 * openings and face sweeps. The vision model reads rows of openings (with their arch rise), horizontal profiles (cornices,
 * bands, sills) and vertical members (piers, pilasters, colonnettes) with their cross-sections, and the colours; where the
 * wall is unseen it continues the wall's own repeats and says so (filledCols / filledU). What it read is photo-inferred, what
 * it continued is generated: the two are kept apart in the build and in provenance. Nothing here names a kind of building or
 * element; a row is two heights and a list of intervals, a profile is pairs of numbers.
 */

import type { VisionModelChain } from '../../../gemini/vision-model-chain';
import type { FaceSweepItem, OpeningItem } from '../pipeline-e/massing-spec';
import type { MassingFace } from '../pipeline-e/native-massing';
import { PLATE_PIXEL_M, platePng, reliefPng, type Plate } from './plates';

export const PIPELINE_G_READ_VERSION = 'pipeline-g-read/v2';
/** A plate is read when at least this share of it was seen. */
export const MIN_READ_COVERAGE = 0.35;
export const READ_MAX_OUTPUT_TOKENS = 16000;
export const READ_TIMEOUT_MS = 180_000;
/** A taller wall has more storeys to read: READ_TIMEOUT_MS up to 30 m, then this much more per metre, up to READ_TIMEOUT_MAX_MS. */
export const READ_TIMEOUT_PER_M_MS = 4_000;
export const READ_TIMEOUT_MAX_MS = 420_000;
/** The read deadline for a plate `heightM` tall. */
export const readTimeoutMs = (heightM: number): number => Math.min(READ_TIMEOUT_MAX_MS, READ_TIMEOUT_MS + Math.max(0, heightM - 30) * READ_TIMEOUT_PER_M_MS);
/** Confidence of what the model read off the plate, and of what it continued into unseen parts. */
export const READ_CONFIDENCE = 0.5;
export const FILLED_CONFIDENCE = 0.3;

export interface FacadeProgram {
    wallColour?: string;
    openings?: Array<{
        h0: number; h1: number; archRise?: number; depth?: number; colour?: string; cols?: number[][]; filledCols?: number[][];
        /** The glazing's divisions: panes across and up, the bar and frame widths, their colour. */
        panes?: { cols?: number; rows?: number; bar?: number; frame?: number; colour?: string };
        /** A projecting sill under each opening of the row. */
        sill?: { out?: number; height?: number; overhang?: number; colour?: string };
        /** A raised surround (architrave) round each opening of the row. */
        surround?: { width?: number; out?: number; colour?: string };
    }>;
    horizontal?: Array<{ h: number; u0: number; u1: number; colour?: string; profile?: number[][] }>;
    vertical?: Array<{ u?: number[]; filledU?: number[]; h0: number; h1: number; colour?: string; profile?: number[][] }>;
    notes?: string;
}

export function readPrompt(place: string, p: Pick<Plate, 'w' | 'h' | 'widthM' | 'heightM'>): string {
    const W = p.widthM.toFixed(2), H = p.heightM.toFixed(2);
    return `You are reading one exterior wall of ${place} so it can be rebuilt procedurally in exact metres.
Image 1 is a rectified, metric elevation of that wall, assembled from survey camera renders of Google's photorealistic 3D tiles: ${p.w} x ${p.h} px at 0.05 m per pixel, so the wall is ${W} m wide and ${H} m tall. Flat mid-grey means no camera saw that part. Tick marks every metre run along all four edges (long ticks every 5 m).
Image 2 is the measured relief of the same wall in the same frame: warm = standing proud of the wall plane, cool = set back into it (full colour at 1 m), black = not seen. The scan is coarse (up to ~2 m geometric error), so use it for where things project and recede, and the colour image for exact positions and sizes.
Coordinates: u = metres from the LEFT edge of the image, h = metres up from the BOTTOM edge.

Describe the wall as a procedural program. Return JSON only:
{
 "wallColour": "#rrggbb",
 "openings": [ { "h0": n, "h1": n, "archRise": n, "depth": n, "colour": "#rrggbb", "cols": [[u0, u1], ...], "filledCols": [[u0, u1], ...],
   "panes": { "cols": n, "rows": n, "bar": n, "frame": n, "colour": "#rrggbb" }, "sill": { "out": n, "height": n, "overhang": n, "colour": "#rrggbb" }, "surround": { "width": n, "out": n, "colour": "#rrggbb" } } ],
 "horizontal": [ { "h": n, "u0": n, "u1": n, "colour": "#rrggbb", "profile": [[dh, out], ...] } ],
 "vertical": [ { "u": [n, ...], "filledU": [n, ...], "h0": n, "h1": n, "colour": "#rrggbb", "profile": [[du, out], ...] } ],
 "notes": "one or two sentences: what you saw, what you were unsure of"
}
- openings: one entry per row of openings that share a bottom and top (windows, doors, shop fronts); cols lists every opening in that row, left to right. depth is how far the glass sits behind the wall face (0.1 - 0.6 m). colour is the glazing / opening colour. h1 is the very top of the opening (the crown of an arch); archRise is how far the head rises above the point where it springs from the jambs: 0 for a flat head, half the opening width for a round (semicircular) arch, less for a segmental arch.
- panes, sill, surround (optional, per row; leave a key out when the image does not show it): panes is how the glazing of each opening in the row is divided: cols panes across and rows panes up (1 and 1 for undivided glass), bar the width of the mullions and transoms between panes (0.03 - 0.15 m), frame the width of the frame round the glass (0.03 - 0.2 m), colour the frames' colour. sill is a projecting sill under each opening: out how far it stands proud of the wall (0.03 - 0.3 m), height its thickness (0.04 - 0.3 m), overhang how far it runs past each side of the opening (0 - 0.3 m). surround is a raised band framing each opening (architrave, moulded casing): width its face width (0.05 - 0.6 m), out how far it stands proud (0.02 - 0.3 m). Read each row's own: shop fronts, arched windows and plain windows differ.
- horizontal: every horizontal projecting element (cornice, belt course, sill band, entablature, string course, balcony slab) running from u0 to u1 at height h; profile is its cross-section as [dh, out] pairs, dh = metres above (+) or below (-) h in increasing order, out = metres it stands proud of the wall (>= 0; 0 at both ends).
- vertical: every vertical projecting element (pilaster, engaged column, pier, mullion between openings). Give each distinct kind as its own entry: the broad piers between bays, and separately the slender colonnettes (thin engaged columns, often in pairs) that flank or divide the openings within a bay, each colonnette listed by its own centre u, with a rounded profile; u is the centre of each repeat, from h0 to h1; profile is its cross-section across its width as [du, out] pairs, du = metres left (-) / right (+) of its centre in increasing order, out >= 0 with 0 at both ends.
- Be exhaustive in what is shown: every window, every door and shop front at street level (a ground-floor opening that reaches the pavement has h0 = 0), every band, every pilaster and colonnette. Where part of the wall is unseen or hidden (grey, or behind a fire escape, scaffolding, a tree, a vehicle), continue the wall's own repeats into it (the bay rhythm, the storey rows, the ground-floor openings) so no part of the wall is left blank: put the openings you continued, not saw, in filledCols, and the members in filledU; never invent a feature that no visible part of the wall shows. Keep within 0 <= u <= ${W}, 0 <= h <= ${H}.`;
}

export function parseProgram(text: string): FacadeProgram {
    const body = text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const v = JSON.parse(body) as FacadeProgram;
    if (!v || typeof v !== 'object') throw new Error('the reply is not a JSON object');
    return v;
}

export const hexColour = (h: string | undefined, fallback: [number, number, number]): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec((h ?? '').trim());
    if (!m) return fallback;
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};
const clamp = (v: unknown, a: number, b: number) => Math.max(a, Math.min(b, Number(v) || 0));
const profileOf = (raw: number[][] | undefined): Array<[number, number]> =>
    (raw ?? []).filter(q => Array.isArray(q) && q.length >= 2 && Number.isFinite(+q[0]) && Number.isFinite(+q[1])).map(([d, o]) => [clamp(o, 0, 1.5), +d] as [number, number]).sort((a, b) => a[1] - b[1]);

/** What a program becomes on its face: openings and face sweeps (native frame), each with its colour for the paint. */
export interface ProgramItems {
    openings: OpeningItem[];
    faceSweeps: FaceSweepItem[];
    wallColour: [number, number, number];
    colours: Map<string, [number, number, number]>;
    counts: { openings: number; filledOpenings: number; horizontal: number; vertical: number; filledVertical: number; paned: number; sills: number; surrounds: number };
}

/** How far the glazing bars stand proud of the glass (at most 80% of the opening's depth). */
export const PANE_DEPTH_M = 0.06;

/** The program read off face `f`'s plate (u from its sMin, h from its tMin) in the face's (s, t). */
export function programItems(prog: FacadeProgram, f: Pick<MassingFace, 'key' | 'sMin' | 'sMax' | 'tMin' | 'tMax'>, idPrefix: string): ProgramItems {
    const W = f.sMax - f.sMin, H = f.tMax - f.tMin;
    const S = (u: number) => f.sMin + clamp(u, 0, W), T = (h: number) => f.tMin + clamp(h, 0, H);
    const out: ProgramItems = { openings: [], faceSweeps: [], wallColour: hexColour(prog.wallColour, [150, 145, 140]), colours: new Map(), counts: { openings: 0, filledOpenings: 0, horizontal: 0, vertical: 0, filledVertical: 0, paned: 0, sills: 0, surrounds: 0 } };
    for (const [ti, row] of (prog.openings ?? []).entries()) {
        if (!(Number(row.h1) > Number(row.h0))) continue;
        const cols = [...(row.cols ?? []).map(c => ({ c, filled: false })), ...(row.filledCols ?? []).map(c => ({ c, filled: true }))];
        for (const [ci, { c, filled }] of cols.entries()) {
            const u0 = Number(c?.[0]), u1 = Number(c?.[1]);
            if (!(u1 > u0)) continue;
            const id = `${idPrefix}o${ti}_${ci}`;
            out.openings.push({
                id, face: f.key, s0: S(u0), s1: S(u1), t0: T(row.h0), t1: T(row.h1), depth: clamp(row.depth ?? 0.25, 0.08, 0.6), scanned: false,
                confidence: filled ? FILLED_CONFIDENCE : READ_CONFIDENCE, provenance: filled ? 'generated' : 'photo-inferred', archRiseM: clamp(row.archRise ?? 0, 0, (u1 - u0) / 2)
            });
            out.colours.set(id, hexColour(row.colour, [40, 44, 50]));
            out.counts.openings++;
            if (filled) out.counts.filledOpenings++;
        }
        const rowOpenings = out.openings.filter(o => o.id.startsWith(`${idPrefix}o${ti}_`));
        if (!rowOpenings.length) continue;
        const paneCols = Math.round(Number(row.panes?.cols)), paneRows = Math.round(Number(row.panes?.rows));
        const bar = clamp(row.panes?.bar ?? 0.06, 0.02, 0.2), frame = clamp(row.panes?.frame ?? 0.06, 0, 0.25);
        if (row.panes && paneCols >= 1 && paneRows >= 1 && (paneCols > 1 || paneRows > 1 || frame > 0)) {
            for (const o of rowOpenings) {
                o.panes = { cols: Math.min(paneCols, 16), rows: Math.min(paneRows, 16), barM: bar, frameM: Math.min(frame, (o.s1 - o.s0) / 4, (o.t1 - o.t0) / 4), depthM: Math.min(PANE_DEPTH_M, 0.8 * o.depth) };
                out.colours.set(`${o.id}:frame`, hexColour(row.panes.colour, [30, 30, 32]));
            }
            out.counts.paned += rowOpenings.length;
        }
        // a sill and a surround are swept along the face, one item per row with a placement per opening
        const prov = (o: OpeningItem) => o.provenance === 'generated';
        const rowSeen = rowOpenings.filter(o => !prov(o)), rowFilled = rowOpenings.filter(prov);
        const both = [['', rowSeen], ['f', rowFilled]] as const;
        if (row.sill && Number(row.sill.out) > 0) {
            const outM = clamp(row.sill.out, 0.02, 0.4), hM = clamp(row.sill.height ?? 0.1, 0.03, 0.4), ov = clamp(row.sill.overhang ?? 0.05, 0, 0.4);
            // the sill's top at the opening's bottom, its body below it
            const profile: Array<[number, number]> = [[0, -hM], [outM, -hM + 0.005], [outM, -0.005], [0, 0]];
            for (const [suffix, list] of both) {
                if (!list.length) continue;
                const id = `${idPrefix}o${ti}s${suffix}`;
                out.faceSweeps.push({ id, confidence: suffix ? FILLED_CONFIDENCE : READ_CONFIDENCE, provenance: suffix ? 'generated' : 'photo-inferred', face: f.key, axis: 0, profile, placements: list.map(o => [o.s0 - ov, o.s1 + ov, o.t0] as [number, number, number]) });
                out.colours.set(id, hexColour(row.sill.colour, out.wallColour));
                out.counts.sills += list.length;
            }
        }
        if (row.surround && Number(row.surround.width) > 0 && Number(row.surround.out) > 0) {
            const wM = clamp(row.surround.width, 0.03, 0.8), outM = clamp(row.surround.out, 0.01, 0.4);
            const colour = hexColour(row.surround.colour, out.wallColour);
            // jambs outside each side up to the springing line, and a head above a flat-headed opening (an arch keeps its jambs)
            const left: Array<[number, number]> = [[0, -wM], [outM, -wM + 0.005], [outM, -0.005], [0, 0]];
            const right: Array<[number, number]> = [[0, 0], [outM, 0.005], [outM, wM - 0.005], [0, wM]];
            for (const [suffix, list] of both) {
                if (!list.length) continue;
                const conf = suffix ? FILLED_CONFIDENCE : READ_CONFIDENCE, p = suffix ? 'generated' : 'photo-inferred';
                const spring = (o: OpeningItem) => o.t1 - (o.archRiseM ?? 0);
                const items: FaceSweepItem[] = [
                    { id: `${idPrefix}o${ti}jl${suffix}`, confidence: conf, provenance: p, face: f.key, axis: 1, profile: left, placements: list.map(o => [o.t0, spring(o), o.s0] as [number, number, number]) },
                    { id: `${idPrefix}o${ti}jr${suffix}`, confidence: conf, provenance: p, face: f.key, axis: 1, profile: right, placements: list.map(o => [o.t0, spring(o), o.s1] as [number, number, number]) }
                ];
                const flat = list.filter(o => (o.archRiseM ?? 0) < 0.01);
                if (flat.length) items.push({ id: `${idPrefix}o${ti}hd${suffix}`, confidence: conf, provenance: p, face: f.key, axis: 0, profile: right, placements: flat.map(o => [o.s0 - wM, o.s1 + wM, o.t1] as [number, number, number]) });
                for (const it of items) { out.faceSweeps.push(it); out.colours.set(it.id, colour); }
                out.counts.surrounds += list.length;
            }
        }
    }
    for (const [k, b] of (prog.horizontal ?? []).entries()) {
        const prof = profileOf(b.profile);
        if (prof.length < 2 || !(Number(b.u1) > Number(b.u0))) continue;
        const id = `${idPrefix}h${k}`;
        out.faceSweeps.push({ id, confidence: READ_CONFIDENCE, provenance: 'photo-inferred', face: f.key, axis: 0, profile: prof, placements: [[S(b.u0), S(b.u1), T(b.h)]] });
        out.colours.set(id, hexColour(b.colour, out.wallColour));
        out.counts.horizontal++;
    }
    for (const [k, v] of (prog.vertical ?? []).entries()) {
        const prof = profileOf(v.profile);
        if (prof.length < 2 || !(Number(v.h1) > Number(v.h0))) continue;
        for (const [part, list] of [['seen', v.u], ['filled', v.filledU]] as const) {
            const us = (list ?? []).map(Number).filter(u => Number.isFinite(u) && u >= 0 && u <= W);
            if (!us.length) continue;
            const filled = part === 'filled';
            const id = `${idPrefix}v${k}${filled ? 'f' : ''}`;
            out.faceSweeps.push({ id, confidence: filled ? FILLED_CONFIDENCE : READ_CONFIDENCE, provenance: filled ? 'generated' : 'photo-inferred', face: f.key, axis: 1, profile: prof, placements: us.map(u => [T(v.h0), T(v.h1), S(u)] as [number, number, number]) });
            out.colours.set(id, hexColour(v.colour, out.wallColour));
            out.counts.vertical += us.length;
            if (filled) out.counts.filledVertical += us.length;
        }
    }
    return out;
}

/**
 * Reads one plate with the vision chain. `again` is appended to the prompt when a first reading failed the check
 * (check.ts): what it measured, so the second reading looks again rather than repeating the first.
 */
export async function readPlate(chain: Pick<VisionModelChain<string>, 'generate'>, place: string, plate: Plate, signal?: AbortSignal, again?: string): Promise<{ program: FacadeProgram; model: string; ms: number }> {
    const res = await chain.generate({
        contents: [{ role: 'user', parts: [{ text: readPrompt(place, plate) + (again ? `\n\n${again}` : '') }, { inlineData: { mimeType: 'image/png', data: platePng(plate).toString('base64') } }, { inlineData: { mimeType: 'image/png', data: reliefPng(plate).toString('base64') } }] }],
        config: { responseMimeType: 'application/json', maxOutputTokens: READ_MAX_OUTPUT_TOKENS, ...(signal ? { abortSignal: signal } : {}) }
    }, { stage: 'grammar', deadlineMs: readTimeoutMs(plate.h * PLATE_PIXEL_M) });
    return { program: parseProgram(res.response.text ?? ''), model: res.model, ms: res.ms };
}
