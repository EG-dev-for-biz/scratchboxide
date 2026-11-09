/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline K: a picture of what the facade ortho straightening (ortho-rectify.ts) read, written beside each rectified ortho
 * as `<ortho>_lines.png` so a pier that did not straighten can be seen, not guessed at. Diagnostic only: nothing reads it.
 *
 *   left   the input ortho (dimmed; tile_refine's blocked texels tinted blue) with every traced line: piers and jambs
 *          yellow, storey lines cyan, brighter where the edge was stronger; samples inside a segment that found no edge
 *          of the line's polarity red; the straight position each segment was warped to green; peaks the trace dropped as a dashed
 *          tick at the border (orange: too near the border, red: no edge, grey: no segment long and supported enough);
 *   right  the result (straightened when the warp was kept, else only levelled), the straight positions green and the
 *          lines measured again on the warped ortho: white within a pixel of straight, magenta beyond. A kept warp has a
 *          green frame, a refused one a red frame.
 *   header the counts, the straightness before and after, and the warp's verdict, from the report.
 */

import type { Vec3 } from '../../../../common/spatial/staged-location-contracts';
import { drawText } from '../photo-match-eval';
import type { OrthoRectifyReport, OrthoRectifyResult, RejectedPeak, Rgba, TracedLine } from './ortho-rectify';

/** The overlay file beside a rectified ortho. */
export const rectifyOverlayName = (image: string) => image.replace(/\.png$/i, '') + '_lines.png';

const C = {
    v: [255, 214, 0] as Vec3, h: [0, 214, 255] as Vec3, noEdge: [235, 45, 45] as Vec3, straight: [60, 235, 90] as Vec3,
    onLine: [255, 255, 255] as Vec3, offLine: [255, 60, 210] as Vec3, border: [255, 150, 0] as Vec3, noSegment: [150, 150, 150] as Vec3,
    kept: [60, 235, 90] as Vec3, refused: [235, 45, 45] as Vec3, text: [235, 235, 235] as Vec3, header: [24, 24, 28] as Vec3
};

interface Canvas { W: number; H: number; rgb: Uint8Array }

function put(c: Canvas, x: number, y: number, col: Vec3, a = 1): void {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= c.W || y >= c.H) return;
    const o = (y * c.W + x) * 3;
    for (let k = 0; k < 3; k++) c.rgb[o + k] = Math.round(c.rgb[o + k] * (1 - a) + col[k] * a);
}

function dot(c: Canvas, x: number, y: number, r: number, col: Vec3, a = 1): void {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) put(c, x + dx, y + dy, col, a);
}

function segment(c: Canvas, x0: number, y0: number, x1: number, y1: number, r: number, col: Vec3, a = 1, dash = 0): void {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= n; i++) {
        if (dash && Math.floor(i / dash) % 2) continue;
        dot(c, x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, r, col, a);
    }
}

/** (x, y) in the panel of a line's sample: 'v' lines run down the rows at an x, 'h' lines along the columns at a y. */
const xy = (l: TracedLine, along: number, across: number): [number, number] => (l.axis === 'v' ? [across, along] : [along, across]);

/** The traced path of a line, sample to sample, coloured by the edge's strength; samples with no edge red. */
function drawTrace(c: Canvas, ox: number, oy: number, l: TracedLine, r: number): void {
    const col = l.axis === 'v' ? C.v : C.h;
    for (let k = 0; k < l.along.length; k++) {
        const [x, y] = xy(l, l.along[k], l.across[k]);
        if (l.weight[k] > 0) {
            if (k + 1 < l.along.length && l.weight[k + 1] > 0) {
                const [x1, y1] = xy(l, l.along[k + 1], l.across[k + 1]);
                segment(c, ox + x, oy + y, ox + x1, oy + y1, r, col, 0.45 + 0.55 * l.weight[k]);
            } else dot(c, ox + x, oy + y, r, col, 0.45 + 0.55 * l.weight[k]);
        } else if (Number.isFinite(l.straight[k])) dot(c, ox + x, oy + y, r, C.noEdge, 0.8); // a gap inside a segment (outside every segment the line was never claimed)
    }
}

/** The straight position of each segment of a line, as one run per segment. */
function drawStraight(c: Canvas, ox: number, oy: number, l: TracedLine, r: number, a: number): void {
    let k = 0;
    while (k < l.along.length) {
        if (!Number.isFinite(l.straight[k])) { k++; continue; }
        let e = k;
        while (e + 1 < l.along.length && l.straight[e + 1] === l.straight[k]) e++;
        const [x0, y0] = xy(l, l.along[k], l.straight[k]), [x1, y1] = xy(l, l.along[e], l.straight[k]);
        segment(c, ox + x0, oy + y0, ox + x1, oy + y1, r, C.straight, a);
        k = e + 1;
    }
}

function blitDimmed(c: Canvas, img: Rgba, ox: number, oy: number, dim: number, occluded?: Uint8Array): void {
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
        const i = y * img.width + x, o = ((oy + y) * c.W + ox + x) * 3;
        const blocked = occluded ? occluded[i] / 255 >= 0.65 : false;
        for (let k = 0; k < 3; k++) {
            const v = img.rgba[i * 4 + 3] ? img.rgba[i * 4 + k] * dim : 0;
            c.rgb[o + k] = Math.round(blocked ? v * 0.6 + (k === 2 ? 200 : 40) * 0.4 : v);
        }
    }
}

/**
 * The overlay of one facade's straightening: the input and its traces on the left, the result and its straight lines on
 * the right, a header of the report's figures above. `occluded` is tile_refine's mask in the input's pixels.
 */
export function renderRectifyOverlay(input: Rgba, result: OrthoRectifyResult, occluded?: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
    if (!result.trace) throw new Error('rectify overlay: the result carries no trace');
    const w = input.width, h = input.height, rep = result.report, trace = result.trace;
    // strokes and text grow with the ortho so a tall tower's overlay stays legible when viewed whole
    const r = Math.max(0, Math.round(Math.max(w, h) / 2400)), ts = Math.max(1, Math.round(Math.max(w, 400) / 400));
    const gap = 6 + 2 * r, lineH = 9 * ts;
    const header = headerRows(result.report, trace.rejected, w, ts).rows * lineH + 2 * ts;
    const c: Canvas = { W: 2 * w + gap, H: header + h, rgb: new Uint8Array((2 * w + gap) * (header + h) * 3) };
    for (let i = 0; i < c.W * c.H; i++) c.rgb.set(C.header, i * 3);
    const lx = 0, rx = w + gap, oy = header;
    blitDimmed(c, input, lx, oy, 0.55, occluded);
    blitDimmed(c, result.image, rx, oy, 0.7);

    // left: traces, and the dropped peaks as dashed ticks at the border they would have started from
    const { lines, rejected, after } = trace;
    for (const l of lines) drawStraight(c, lx, oy, l, r, 0.55);
    for (const l of lines) drawTrace(c, lx, oy, l, r);
    const tick = Math.max(12, Math.round(Math.min(w, h) * 0.04));
    for (const p of rejected) {
        const col = p.why === 'border' ? C.border : p.why === 'no-edge' ? C.noEdge : C.noSegment;
        if (p.axis === 'v') { segment(c, lx + p.at, oy, lx + p.at, oy + tick, r, col, 1); segment(c, lx + p.at, oy + h - 1 - tick, lx + p.at, oy + h - 1, r, col, 1); }
        else { segment(c, lx, oy + p.at, lx + tick, oy + p.at, r, col, 1); segment(c, lx + w - 1 - tick, oy + p.at, lx + w - 1, oy + p.at, r, col, 1); }
    }

    // right: the straight positions, and the lines measured again on the warped ortho (meaningful only when it was kept)
    for (const l of lines) drawStraight(c, rx, oy, l, r, 0.8);
    if (after && rep.warp.kept) for (const l of after) for (let k = 0; k < l.along.length; k++) {
        if (!(l.weight[k] > 0) || !Number.isFinite(l.across[k]) || !Number.isFinite(l.straight[k])) continue;
        const [x, y] = xy(l, l.along[k], l.across[k]);
        dot(c, rx + x, oy + y, r, Math.abs(l.across[k] - l.straight[k]) <= 1 ? C.onLine : C.offLine, 0.9);
    }
    const frame = rep.warp.kept ? C.kept : C.refused, fw = Math.max(1, r + 1);
    for (let k = 0; k < fw; k++) {
        segment(c, rx + k, oy + k, rx + w - 1 - k, oy + k, 0, frame); segment(c, rx + k, oy + h - 1 - k, rx + w - 1 - k, oy + h - 1 - k, 0, frame);
        segment(c, rx + k, oy + k, rx + k, oy + h - 1 - k, 0, frame); segment(c, rx + w - 1 - k, oy + k, rx + w - 1 - k, oy + h - 1 - k, 0, frame);
    }

    // header: what each side shows, then the report's figures, wrapped to the panel's width
    const { left, right } = headerRows(rep, trace.rejected, w, ts);
    left.forEach((t, row) => drawText(c.rgb, c.W, c.H, lx + 2 * ts, ts + row * lineH, t, ts, C.text));
    right.forEach((t, row) => drawText(c.rgb, c.W, c.H, rx + 2 * ts, ts + row * lineH, t, ts, row === 0 ? frame : C.text));
    return { width: c.W, height: c.H, rgb: c.rgb };
}

/** Words wrapped to `chars` per row. */
function wrap(text: string, chars: number): string[] {
    const rows: string[] = [];
    let row = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
        if (row && row.length + 1 + word.length > chars) { rows.push(row); row = ''; }
        row = row ? `${row} ${word}` : word.slice(0, chars);
    }
    if (row) rows.push(row);
    return rows;
}

/** The header's rows for each panel (the 5 x 7 font has no '>': arrows are written out). */
function headerRows(rep: OrthoRectifyReport, rejected: RejectedPeak[], w: number, ts: number): { left: string[]; right: string[]; rows: number } {
    const chars = Math.max(8, Math.floor((w - 4 * ts) / (6 * ts)));
    const by = (why: string) => rejected.filter(p => p.why === why).length;
    const left = [
        `INPUT: ${rep.lines.vertical} PIERS (YELLOW), ${rep.lines.horizontal} STOREY LINES (CYAN), ${rep.lines.segments} SEGMENTS.`,
        'RED: NO EDGE INSIDE A SEGMENT. GREEN: STRAIGHT TARGET. BLUE TINT: BLOCKED.',
        `DROPPED PEAKS: ${by('border')} AT BORDER (ORANGE), ${by('no-edge')} NO EDGE (RED), ${by('no-segment')} NO SEGMENT (GREY).`,
        `PIXEL ${Math.round(rep.pixelM * 1000) / 1000} M, PITCH ${rep.periodM ?? '-'} M.`
    ].flatMap(t => wrap(t, chars));
    const right = [
        `RESULT: WARP ${rep.warp.kept ? 'KEPT' : 'REFUSED'}.`,
        `${rep.straightnessPx.before} TO ${rep.straightnessPx.after} PX FROM STRAIGHT, MAX SHIFT ${rep.warp.maxShiftPx} PX.`,
        rep.warp.why.replace(/->/g, 'TO'),
        rep.warp.kept ? 'WHITE: WITHIN 1 PX OF STRAIGHT. MAGENTA: OFF.' : 'GREEN: WHERE THE LINES WOULD GO.'
    ].flatMap(t => wrap(t, chars));
    return { left, right, rows: Math.max(left.length, right.length) };
}
