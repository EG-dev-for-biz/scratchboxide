/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Bridges of a procedural district, rebuilt in the likeness of the scan. Where a Google road or rail centreline crosses
 * Google's water, the crossing is measured along its length (a station a metre apart): the deck's level (the scan's
 * surface at the centreline), its width (how far the scan stays at the deck's level either side) and, on both sides of
 * the deck, its elevation: from the deck down to the water, where the scan is solid and where it is open. Open space under
 * the deck is the soffit (an arch rises and falls with it); solid down to the water is a pier. The bridge is that measured
 * side elevation swept across the measured width (operator 1: a profile along a carrier), with a parapet on each edge; its
 * deck carries planar UVs into the district's top-down photo. Nothing here names a bridge type.
 */

import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import type { ScanMesh } from '../../spatial/StreetViewSurveyPlanner';
import type { RoadMeshPart } from './road-surfaces';
import { selectTriangles, type TileTriangles } from './tile-texture-transfer';
import { renderTriangles } from './photo-match-eval';

export const PROCEDURAL_BRIDGES_VERSION = 'procedural-bridges/1';

export const BRIDGE_PARAMS = {
    stationM: 1,
    /** Over-water stretches of a line closer than this are one crossing (m). */
    joinGapM: 4,
    /** A crossing shorter than this over water is not a bridge (m). */
    minWaterRunM: 8,
    /** Stations measured past the water on each side (the abutments, m). */
    bankM: 10,
    /** A deck stands at least this over the water (m). */
    minClearanceM: 1.5,
    /** The scan counts as the deck within this of its level (m). */
    deckToleranceM: 0.8,
    widthMinM: 5, widthMaxM: 40,
    /** Lateral search for the deck's edges (m). */
    widthSearchM: 30,
    /** Elevation probes: vertical step, and how close to a scan triangle a probe counts as solid (m). */
    probeStepM: 0.25, solidWithinM: 0.45,
    /** Where across the deck's measured edge the elevation is probed (m, outward positive). */
    faceOffsetsM: [-1.5, -0.75, 0, 0.5, 1.0],
    /** An opening under the deck must be at least this tall to be a soffit (m). */
    minOpeningM: 1,
    parapetM: 1.0, parapetThickM: 0.35,
    /** The deck slab where the scan shows no soffit (m). */
    defaultSlabM: 1.2
};

export interface BridgeStation { x: number; z: number; nx: number; nz: number; s: number; overWater: boolean; deckY: number; soffitY: number }
export interface Bridge { id: string; line: number; stations: BridgeStation[]; widthM: number; centreOffsetM: number; waterY: number; lengthM: number; piers: number; measured: { deckStations: number; soffitStations: number } }

const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const smooth = (a: number[], r: number) => a.map((_, i) => median(a.slice(Math.max(0, i - r), i + r + 1)));

/** The scan's triangles binned by plan cell, for "is there scan within d of this point" queries. */
export class ScanProbe {
    private readonly bins = new Map<string, number[]>();
    constructor(private readonly scan: ScanMesh, private readonly cellM = 2) {
        const V = scan.mesh.vertices as ArrayLike<number>, I = scan.mesh.indices as ArrayLike<number>;
        for (let t = 0; t < scan.triCount; t++) {
            let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
            for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; x0 = Math.min(x0, V[v]); x1 = Math.max(x1, V[v]); z0 = Math.min(z0, V[v + 2]); z1 = Math.max(z1, V[v + 2]); }
            if (x1 - x0 > 40 || z1 - z0 > 40) continue;
            for (let i = Math.floor(x0 / cellM); i <= Math.floor(x1 / cellM); i++) for (let k = Math.floor(z0 / cellM); k <= Math.floor(z1 / cellM); k++) {
                const key = `${i},${k}`; const b = this.bins.get(key); if (b) b.push(t); else this.bins.set(key, [t]);
            }
        }
    }
    /** Whether any scan triangle lies within `d` of (x, y, z). */
    near(x: number, y: number, z: number, d: number): boolean {
        const V = this.scan.mesh.vertices as ArrayLike<number>, I = this.scan.mesh.indices as ArrayLike<number>;
        const seen = new Set<number>();
        for (let i = Math.floor((x - d) / this.cellM); i <= Math.floor((x + d) / this.cellM); i++) for (let k = Math.floor((z - d) / this.cellM); k <= Math.floor((z + d) / this.cellM); k++) {
            for (const t of this.bins.get(`${i},${k}`) ?? []) {
                if (seen.has(t)) continue; seen.add(t);
                const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
                if (pointTriangleDistance(x, y, z, V, a, b, c) <= d) return true;
            }
        }
        return false;
    }
}

function pointTriangleDistance(px: number, py: number, pz: number, V: ArrayLike<number>, a: number, b: number, c: number): number {
    // Ericson's closest point on a triangle
    const ax = V[a], ay = V[a + 1], az = V[a + 2], bx = V[b], by = V[b + 1], bz = V[b + 2], cx = V[c], cy = V[c + 1], cz = V[c + 2];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    const dist = (qx: number, qy: number, qz: number) => Math.hypot(px - qx, py - qy, pz - qz);
    if (d1 <= 0 && d2 <= 0) return dist(ax, ay, az);
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return dist(bx, by, bz);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return dist(ax + v * abx, ay + v * aby, az + v * abz); }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return dist(cx, cy, cz);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return dist(ax + w * acx, ay + w * acy, az + w * acz); }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return dist(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)); }
    const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
    return dist(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

/** Points every `step` metres along a polyline, with the unit normal to the left and the arc length. */
function resample(line: Vec2[], step: number): Array<{ x: number; z: number; nx: number; nz: number; s: number }> {
    const out: Array<{ x: number; z: number; nx: number; nz: number; s: number }> = [];
    let s = 0;
    for (let i = 1; i < line.length; i++) {
        const a = line[i - 1], b = line[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L < 1e-6) continue;
        const tx = (b[0] - a[0]) / L, tz = (b[1] - a[1]) / L;
        for (let d = (out.length ? step - ((s) % step) : 0); d < L; d += step) out.push({ x: a[0] + tx * d, z: a[1] + tz * d, nx: -tz, nz: tx, s: s + d });
        s += L;
    }
    return out;
}

/** The bridges where `lines` cross water, measured on the scan. */
export function measureBridges(input: {
    lines: Vec2[][]; waterAt: (x: number, z: number) => boolean; topAt: (x: number, z: number) => number; groundAt: (x: number, z: number) => number;
    within: (x: number, z: number) => boolean; waterY: number; probe: ScanProbe;
}, P = BRIDGE_PARAMS): Bridge[] {
    const bridges: Bridge[] = [];
    input.lines.forEach((line, li) => {
        const pts = resample(line, P.stationM);
        const wet = pts.map(p => input.waterAt(p.x, p.z) && input.within(p.x, p.z));
        // over-water runs, joined across short gaps
        const runs: Array<[number, number]> = [];
        for (let i = 0; i < pts.length; i++) {
            if (!wet[i]) continue;
            let j = i; while (j + 1 < pts.length && (wet[j + 1] || (j + P.joinGapM < pts.length && wet.slice(j + 1, j + 1 + P.joinGapM).some(Boolean)))) j++;
            runs.push([i, j]); i = j;
        }
        for (const [i0, i1] of runs) {
            if ((i1 - i0 + 1) * P.stationM < P.minWaterRunM) continue;
            const a = Math.max(0, i0 - Math.round(P.bankM / P.stationM)), b = Math.min(pts.length - 1, i1 + Math.round(P.bankM / P.stationM));
            const sts = pts.slice(a, b + 1);
            const over = sts.map((_, k) => wet[a + k]);
            // the deck: the scan's surface at the centreline, standing clear of the water
            const rawDeck = sts.map((p, k) => { const t = input.topAt(p.x, p.z); return over[k] && !(t > input.waterY + P.minClearanceM) ? NaN : t; });
            const deckOver = rawDeck.filter((_, k) => over[k]).filter(Number.isFinite);
            if (deckOver.length < (i1 - i0 + 1) * 0.5) continue;  // no deck over most of the water: not a bridge the scan shows
            const deck = smooth(rawDeck.map((y, k) => (Number.isFinite(y) ? y : median(deckOver))), 3);
            // the width: how far the scan stays at the deck's level either side
            const lefts: number[] = [], rights: number[] = [];
            sts.forEach((p, k) => {
                if (!over[k] || !Number.isFinite(deck[k])) return;
                const reach = (sign: number) => { let d = 0; for (let o = 0.5; o <= P.widthSearchM; o += 0.5) { const t = input.topAt(p.x + p.nx * o * sign, p.z + p.nz * o * sign); if (!(Math.abs(t - deck[k]) <= P.deckToleranceM)) break; d = o; } return d; };
                lefts.push(reach(1)); rights.push(reach(-1));
            });
            const l = median(lefts), r = median(rights);
            const widthM = Math.max(P.widthMinM, Math.min(P.widthMaxM, l + r));
            const centreOffsetM = Math.max(-widthM / 2, Math.min(widthM / 2, (l - r) / 2));
            // the elevation either side: open under the deck is the soffit, solid to the water a pier
            const soffit = sts.map((p, k) => {
                if (!over[k]) return NaN;
                const top = deck[k] - 0.5;
                const side = (sign: number) => {
                    // the bridge's outer face, where its elevation is scanned (photogrammetry sees the faces, not under the deck):
                    // probes straddling the measured edge
                    const solid = (y: number) => P.faceOffsetsM.some(d => {
                        const o = centreOffsetM + sign * (widthM / 2 + d);
                        return input.probe.near(p.x + p.nx * o, y, p.z + p.nz * o, P.solidWithinM);
                    });
                    let gapStart = NaN;
                    for (let y = top; y >= input.waterY; y -= P.probeStepM) {
                        if (solid(y)) { if (Number.isFinite(gapStart) && gapStart - y >= P.minOpeningM) return gapStart; gapStart = NaN; }
                        else if (!Number.isFinite(gapStart)) gapStart = y;
                    }
                    return Number.isFinite(gapStart) && gapStart - input.waterY >= P.minOpeningM ? gapStart : input.waterY;
                };
                return Math.max(side(1), side(-1));
            });
            const soffitSm = smooth(soffit.map((y, k) => (over[k] ? y : NaN)), 1);
            const stations: BridgeStation[] = sts.map((p, k) => {
                const deckY = deck[k];
                const ground = input.groundAt(p.x, p.z);
                const soffitY = over[k] ? Math.min(deckY - 0.3, Number.isFinite(soffitSm[k]) ? soffitSm[k] : deckY - P.defaultSlabM) : (Number.isFinite(ground) ? Math.min(deckY - 0.3, ground) : deckY - P.defaultSlabM);
                return { x: p.x, z: p.z, nx: p.nx, nz: p.nz, s: p.s, overWater: over[k], deckY, soffitY };
            }).filter(st => Number.isFinite(st.deckY));
            let piers = 0, inPier = false;
            for (const st of stations) { const pier = st.overWater && st.soffitY <= input.waterY + 0.05; if (pier && !inPier) piers++; inPier = pier; }
            bridges.push({
                id: `bridge/${li}/${Math.round(sts[0].s)}`, line: li, stations, widthM, centreOffsetM, waterY: input.waterY, lengthM: (sts[sts.length - 1].s - sts[0].s), piers,
                measured: { deckStations: deckOver.length, soffitStations: soffit.filter(Number.isFinite).length }
            });
        }
    });
    // two lines over one deck (a road's two carriageways, a road and a tram line) are one bridge: keep the widest per place
    const kept: Bridge[] = [];
    for (const b of bridges.sort((p, q) => q.widthM - p.widthM)) {
        const mid = b.stations[b.stations.length >> 1];
        if (kept.some(k => k.stations.some(s => Math.hypot(s.x - mid.x, s.z - mid.z) < k.widthM / 2))) continue;
        kept.push(b);
    }
    return kept;
}

/** The bridge's deck (planar UVs into the district photo's frame) and its body (the measured elevation swept across it). */
export function buildBridgeMesh(b: Bridge, uvFrame: { x0: number; z0: number; widthM: number; heightM: number }, P = BRIDGE_PARAMS): { deck: RoadMeshPart; body: { positions: Float32Array; indices: Uint32Array } } {
    const dp: number[] = [], du: number[] = [], di: number[] = [];
    const bp: number[] = [], bi: number[] = [];
    const half = b.widthM / 2, c = b.centreOffsetM;
    const at = (st: BridgeStation, o: number, y: number): [number, number, number] => [st.x + st.nx * (c + o), y, st.z + st.nz * (c + o)];
    const dv = (q: [number, number, number]) => { dp.push(...q); du.push((q[0] - uvFrame.x0) / uvFrame.widthM, (q[2] - uvFrame.z0) / uvFrame.heightM); return dp.length / 3 - 1; };
    const bv = (q: [number, number, number]) => { bp.push(...q); return bp.length / 3 - 1; };
    const quad = (list: number[], a: number, b2: number, c2: number, d: number) => list.push(a, b2, c2, a, c2, d);
    for (let k = 1; k < b.stations.length; k++) {
        const s0 = b.stations[k - 1], s1 = b.stations[k];
        // deck top (between the parapets)
        const inner = half - P.parapetThickM;
        quad(di, dv(at(s0, inner, s0.deckY)), dv(at(s0, -inner, s0.deckY)), dv(at(s1, -inner, s1.deckY)), dv(at(s1, inner, s1.deckY)));
        // the sides: from the soffit to the parapet's top, each face outward
        for (const sign of [1, -1]) {
            const o = sign * half;
            const a = bv(at(s0, o, s0.soffitY)), b2 = bv(at(s1, o, s1.soffitY)), c2 = bv(at(s1, o, s1.deckY + P.parapetM)), d = bv(at(s0, o, s0.deckY + P.parapetM));
            if (sign > 0) quad(bi, a, d, c2, b2); else quad(bi, a, b2, c2, d);
            // the parapet's inner face and its top
            const oi = sign * inner;
            const e = bv(at(s0, oi, s0.deckY)), f = bv(at(s1, oi, s1.deckY)), g = bv(at(s1, oi, s1.deckY + P.parapetM)), h = bv(at(s0, oi, s0.deckY + P.parapetM));
            if (sign > 0) quad(bi, e, f, g, h); else quad(bi, e, h, g, f);
            const t0 = bv(at(s0, o, s0.deckY + P.parapetM)), t1 = bv(at(s1, o, s1.deckY + P.parapetM)), t2 = bv(at(s1, oi, s1.deckY + P.parapetM)), t3 = bv(at(s0, oi, s0.deckY + P.parapetM));
            if (sign > 0) quad(bi, t0, t3, t2, t1); else quad(bi, t0, t1, t2, t3);
        }
        // the underside at the soffit (the arch's intrados, the slab's bottom)
        quad(bi, bv(at(s0, half, s0.soffitY)), bv(at(s1, half, s1.soffitY)), bv(at(s1, -half, s1.soffitY)), bv(at(s0, -half, s0.soffitY)));
    }
    // the two ends, closed
    for (const st of [b.stations[0], b.stations[b.stations.length - 1]]) {
        quad(bi, bv(at(st, half, st.soffitY)), bv(at(st, -half, st.soffitY)), bv(at(st, -half, st.deckY)), bv(at(st, half, st.deckY)));
    }
    return {
        deck: { positions: Float32Array.from(dp), indices: Uint32Array.from(di), uv: Float32Array.from(du) },
        body: { positions: Float32Array.from(bp), indices: Uint32Array.from(bi) }
    };
}

// ------------------------------------------------------------------------------------------------ the reading

/**
 * A side elevation of the bridge rendered from the textured scan, square to its chord, near-orthographic: a reference for
 * reading the bridge's form (the scan drapes a bridge's side shut between deck and water; its photo still shows the
 * openings). Only the scan within the bridge's corridor is drawn, so nothing on the bank hides it. Returns the image and
 * its scale: image x = (s along the chord - s0) / texelM, image y = (topY - y) / texelM.
 */
export function renderBridgeElevation(tile: TileTriangles, b: Bridge, side: 1 | -1, texelM = 0.05): { rgba: Uint8Array; width: number; height: number; texelM: number; s0: number; lengthM: number; topY: number; waterRow: number; reversed: boolean } {
    const first = b.stations[0], last = b.stations[b.stations.length - 1];
    const tx0 = last.x - first.x, tz0 = last.z - first.z, L = Math.hypot(tx0, tz0) || 1, tx = tx0 / L, tz = tz0 / L;
    const nx = -tz, nz = tx;
    const deckTop = Math.max(...b.stations.map(s => s.deckY));
    const topY = deckTop + 6, bottomY = b.waterY - 1;
    const half = b.widthM / 2;
    const cxW = (first.x + last.x) / 2 + nx * b.centreOffsetM, czW = (first.z + last.z) / 2 + nz * b.centreOffsetM;
    const keep = new Uint8Array(tile.positions.length / 9);
    for (let t = 0; t < keep.length; t++) {
        const p = tile.positions;
        const x = (p[t * 9] + p[t * 9 + 3] + p[t * 9 + 6]) / 3, y = (p[t * 9 + 1] + p[t * 9 + 4] + p[t * 9 + 7]) / 3, z = (p[t * 9 + 2] + p[t * 9 + 5] + p[t * 9 + 8]) / 3;
        const along = (x - cxW) * tx + (z - czW) * tz, across = (x - cxW) * nx + (z - czW) * nz;
        keep[t] = Math.abs(along) <= L / 2 + 3 && Math.abs(across) <= half + 5 && y >= bottomY && y <= topY ? 1 : 0;
    }
    const corridor = selectTriangles(tile, keep);
    const width = Math.min(4096, Math.ceil((L + 6) / texelM)), height = Math.min(2048, Math.ceil((topY - bottomY) / texelM));
    const texel = Math.max(texelM, (L + 6) / 4096, (topY - bottomY) / 2048);
    const D = 3000;
    const fwd: [number, number, number] = [-nx * side, 0, -nz * side];
    const up: [number, number, number] = [0, 1, 0];
    const right: [number, number, number] = [fwd[1] * up[2] - fwd[2] * up[1], fwd[2] * up[0] - fwd[0] * up[2], fwd[0] * up[1] - fwd[1] * up[0]];
    const reversed = right[0] * tx + right[2] * tz < 0;
    const midY = (topY + bottomY) / 2;
    const f = D / texel;
    const camera = {
        eye: [cxW + nx * side * D, midY, czW + nz * side * D] as [number, number, number], right, up, fwd,
        fx: f, fy: f, cx: width / 2, cy: height / 2, width, height
    };
    const r = renderTriangles([corridor], camera, { supersample: 1, ambient: 1, background: [200, 210, 220] });
    return { rgba: r.rgba, width: r.width, height: r.height, texelM: texel, s0: -(L + 6) / 2, lengthM: L, topY: midY + (height / 2) * texel, waterRow: Math.round((midY + (height / 2) * texel - b.waterY) / texel), reversed };
}

/** What the vision model reads off the elevation, in metres (continuous quantities; the words are never branched on). */
export interface BridgeReading {
    openings: Array<{ fromM: number; toM: number; springM: number; crownM: number }>;
    fasciaTopM?: number; parapetTopM?: number;
    repeats?: Array<{ what: string; spacingM: number; heightM: number }>;
    colourSrgb?: [number, number, number];
    form?: string;
}

export function bridgeReadingPrompt(e: { width: number; height: number; texelM: number; waterRow: number; lengthM: number }): string {
    return [
        'This image is a side elevation of a bridge over water, rendered orthographically from a photogrammetric scan (blurry, but to scale).',
        `Scale: ${(1 / e.texelM).toFixed(2)} pixels per metre, the same both ways. The image is ${e.width} x ${e.height} px; the water surface is at pixel row ${e.waterRow}.`,
        `Give positions along the bridge in metres from the image's left edge (0 to ${(e.width * e.texelM).toFixed(1)}), heights in metres above the water.`,
        'Read:',
        '- "openings": every opening under the deck (an arch or a span between supports): "fromM" and "toM" (its left and right edges at the water), "springM" (the height where its curve starts at the sides), "crownM" (the height of its top). Leave out nothing; supports are what lies between openings.',
        '- "fasciaTopM": the height of the top of the deck structure (the road level); "parapetTopM": the top of the parapet or railing.',
        '- "repeats": elements repeated along the parapet or deck (lamp posts, pillars, balusters): "what" in a few words, "spacingM", "heightM" above the parapet top.',
        '- "colourSrgb": the main colour of the bridge structure, [r, g, b] 0-255.',
        '- "form": one sentence on its form (materials, how the arches are shaped).',
        'Reply with JSON only: {"openings": [...], "fasciaTopM": n, "parapetTopM": n, "repeats": [...], "colourSrgb": [r, g, b], "form": "..."}'
    ].join('\n');
}

export function parseBridgeReading(text: string): BridgeReading | undefined {
    let j: any;
    try { j = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return undefined; }
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const openings = (Array.isArray(j?.openings) ? j.openings : []).map((o: any) => ({ fromM: n(o?.fromM), toM: n(o?.toM), springM: n(o?.springM), crownM: n(o?.crownM) }))
        .filter((o: any) => o.fromM !== undefined && o.toM !== undefined && o.toM > o.fromM && o.crownM !== undefined)
        .map((o: any) => ({ fromM: o.fromM, toM: o.toM, springM: Math.min(o.springM ?? 0, o.crownM), crownM: o.crownM }));
    const repeats = (Array.isArray(j?.repeats) ? j.repeats : []).map((r: any) => ({ what: String(r?.what ?? '').slice(0, 60), spacingM: n(r?.spacingM), heightM: n(r?.heightM) }))
        .filter((r: any) => r.spacingM && r.spacingM > 0.5 && r.heightM && r.heightM > 0);
    const c = Array.isArray(j?.colourSrgb) && j.colourSrgb.length === 3 && j.colourSrgb.every((v: unknown) => typeof v === 'number') ? j.colourSrgb.map((v: number) => Math.max(0, Math.min(255, v))) as [number, number, number] : undefined;
    return { openings, ...(n(j?.fasciaTopM) !== undefined ? { fasciaTopM: n(j.fasciaTopM) } : {}), ...(n(j?.parapetTopM) !== undefined ? { parapetTopM: n(j.parapetTopM) } : {}), ...(repeats.length ? { repeats } : {}), ...(c ? { colourSrgb: c } : {}), ...(typeof j?.form === 'string' ? { form: j.form.slice(0, 300) } : {}) };
}

/**
 * The reading applied to the measured bridge: each station's soffit from the opening it stands under (an arch's curve
 * between its springing and its crown: half an ellipse over the opening), solid to the water elsewhere (a support). The
 * reading's positions are along the rendered chord; `e` maps them back to the stations.
 */
export function applyBridgeReading(b: Bridge, r: BridgeReading, e: { s0: number; lengthM: number; reversed: boolean }): Bridge {
    const first = b.stations[0], last = b.stations[b.stations.length - 1];
    const tx0 = last.x - first.x, tz0 = last.z - first.z, L = Math.hypot(tx0, tz0) || 1, tx = tx0 / L, tz = tz0 / L;
    const cx = (first.x + last.x) / 2, cz = (first.z + last.z) / 2;
    const imageM = (st: BridgeStation) => { const a = (st.x - cx) * tx + (st.z - cz) * tz; const fromLeft = a - e.s0; return e.reversed ? (e.lengthM + 6) - fromLeft : fromLeft; };
    const stations = b.stations.map(st => {
        if (!st.overWater) return st;
        const m = imageM(st);
        const o = r.openings.find(op => m >= op.fromM && m <= op.toM);
        if (!o) return { ...st, soffitY: b.waterY };
        const half = (o.toM - o.fromM) / 2, mid = (o.fromM + o.toM) / 2;
        const u = Math.min(1, Math.abs(m - mid) / Math.max(0.01, half));
        const h = o.springM + (o.crownM - o.springM) * Math.sqrt(Math.max(0, 1 - u * u));
        return { ...st, soffitY: Math.min(st.deckY - 0.3, b.waterY + h) };
    });
    let piers = 0, inPier = false;
    for (const st of stations) { const pier = st.overWater && st.soffitY <= b.waterY + 0.05; if (pier && !inPier) piers++; inPier = pier; }
    return { ...b, stations, piers };
}
