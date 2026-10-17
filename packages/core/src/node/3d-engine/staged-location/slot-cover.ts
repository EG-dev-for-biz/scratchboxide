/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Where a slot's own free space is taken by another fitted primitive.
 *
 * A slot is a face or an edge of ONE primitive, measured over the whole of it. The fit stacks prisms: a plinth stands against the foot of a
 * pier wall, a slab overhangs the top of it, an upper prism stands on the top edge of a band. Where a neighbour fills the space in front of
 * (or above) the slot, nothing built there can stand free of the solid, and the native builder rejects it as "sinking into the fitted solid"
 * (the reading was never told, so it placed an element there). This module finds those parts from the fitted solid itself:
 *   - a surface slot: a grid over its region, each cell covered when its point a hand's breadth off the face lies inside another shell;
 *   - an edge slot: stations along the carrier, each blocked when any of the outer corners of its envelope (out and up of the crease) lies inside a shell.
 * The reading is told the covered parts, the anchoring clips what it can into the open part and sends back what it cannot.
 */

import type { FittedSurface, OrnamentSlot, StructureFit, Vec2, Vec3 } from '../../../common/spatial/staged-location-contracts';
import { chartNormal, chartPoint } from './slot-projection';
import { insideSolid, type FittedShells } from './fitted-solid';

/** How far off a surface slot's face the covered test looks (a shallow and a mid-depth probe: an element's vertices stand anywhere in between). */
export const COVER_OFFSETS_M = [0.004, 0.03, 0.15] as const;
/** The first probe off the crease: inside the builder's 5 mm tolerance of the host face, so a neighbour standing a centimetre proud of the wall is found. */
const SKIN_M = 0.003;
const MAX_CELLS = 24;
const CELL_M = 0.5;

export interface SurfaceCover { kind: 'surface'; u0: number; v0: number; du: number; dv: number; nu: number; nv: number; covered: Uint8Array; inRegion: Uint8Array; share: number }
export interface EdgeCover { kind: 'edge'; lengthM: number; n: number; blocked: Uint8Array; share: number }
export type SlotCover = SurfaceCover | EdgeCover;

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

function inPolygon(u: number, v: number, poly: Vec2[]): boolean {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [ui, vi] = poly[i], [uj, vj] = poly[j];
        if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
    }
    return inside;
}

/** The frame of an edge at a point along its carrier: along, out of the host face, up. Same convention as the native edge frame and slot-projection. */
function edgeFrame(a: Vec3, b: Vec3, outward: Vec3): { t: Vec3; out: Vec3; up: Vec3 } {
    const t = unit(sub(b, a));
    const out = unit(sub(outward, scale(t, dot(outward, t))));
    let up = cross(t, out);
    if (up[1] < 0) up = scale(up, -1);
    return { t, out, up };
}

export function computeSlotCover(slot: OrnamentSlot, fit: Pick<StructureFit, 'surfaces'>, solid: FittedShells): SlotCover | undefined {
    const surfaces = new Map<string, FittedSurface>(fit.surfaces.map(s => [s.id, s]));
    const host = slot.host;
    if ('surface' in host) {
        const surface = surfaces.get(host.surface.surfaceId);
        if (!surface) return undefined;
        const poly = host.surface.regionUv;
        const us = poly.map(p => p[0]), vs = poly.map(p => p[1]);
        const u0 = Math.min(...us), u1 = Math.max(...us), v0 = Math.min(...vs), v1 = Math.max(...vs);
        const nu = Math.max(1, Math.min(MAX_CELLS, Math.ceil((u1 - u0) / CELL_M))), nv = Math.max(1, Math.min(MAX_CELLS, Math.ceil((v1 - v0) / CELL_M)));
        const du = (u1 - u0) / nu, dv = (v1 - v0) / nv;
        const covered = new Uint8Array(nu * nv), inRegion = new Uint8Array(nu * nv);
        let n = 0, c = 0;
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
            const u = u0 + du * (i + 0.5), v = v0 + dv * (j + 0.5);
            if (!inPolygon(u, v, poly)) continue;
            inRegion[j * nu + i] = 1;
            n++;
            const depths = COVER_OFFSETS_M.map(d => Math.min(d, Math.max(0.004, slot.bounds.maxProudM * 0.5)));
            if (depths.some(d => insideSolid(solid, chartPoint(surface.chart, u, v, d)))) { covered[j * nu + i] = 1; c++; }
        }
        return { kind: 'surface', u0, v0, du, dv, nu, nv, covered, inRegion, share: n ? c / n : 0 };
    }
    const e = host.edge;
    const pts = e.carrier.points as Vec3[];
    if (pts.length < 2) return undefined;
    const surface = surfaces.get(e.surfaceIds[0]);
    const outward: Vec3 = surface ? chartNormal(surface.chart, 0) : [0, 0, 1];
    const outMax = Math.max(...e.envelope.map(p => p[0])), upMax = Math.max(...e.envelope.map(p => p[1]));
    const segLen: number[] = [];
    for (let i = 0; i < pts.length - 1; i++) segLen.push(Math.hypot(...sub(pts[i + 1], pts[i])));
    const L = e.carrier.lengthM || segLen.reduce((a, b) => a + b, 0);
    const n = Math.max(4, Math.min(96, Math.ceil(L / 0.2)));
    const blocked = new Uint8Array(n);
    let b = 0;
    for (let k = 0; k < n; k++) {
        const s = ((k + 0.5) / n) * segLen.reduce((a, c) => a + c, 0);
        let acc = 0, seg = 0;
        while (seg < segLen.length - 1 && acc + segLen[seg] < s) { acc += segLen[seg]; seg++; }
        const f = segLen[seg] > 0 ? (s - acc) / segLen[seg] : 0;
        const p = add(pts[seg], scale(sub(pts[seg + 1], pts[seg]), f));
        const fr = edgeFrame(pts[seg], pts[seg + 1], outward);
        // the whole outward quadrant of the section: a profile stands attached to the crease, so anything of it at out > 0 or up > 0 needs
        // free space from the crease out (a neighbour flush with the wall a few centimetres back already makes a profile rooted at the crease sink)
        const at = (o: number, u: number): Vec3 => add(add(p, scale(fr.out, o)), scale(fr.up, u));
        const outs = outMax > 0.03 ? [SKIN_M, outMax * 0.35, outMax * 0.9] : [];
        const ups = upMax > 0.03 ? [SKIN_M, upMax * 0.35, upMax * 0.9] : [];
        const probes: Vec3[] = [];
        for (const o of outs) for (const u of ups) probes.push(at(o, u));
        for (const o of outs) probes.push(at(o, SKIN_M));
        for (const u of ups) probes.push(at(SKIN_M, u));
        if (probes.some(q => insideSolid(solid, q))) { blocked[k] = 1; b++; }
    }
    return { kind: 'edge', lengthM: L, n, blocked, share: b / n };
}

/** The share of a rectangle (chart u0, u1, v0, v1) of a surface slot that lies over covered cells (sampled on a 7 × 7 grid; cells outside the region count as open). */
export function coveredShare(c: SurfaceCover, r: { u0: number; u1: number; v0: number; v1: number }): number {
    let hit = 0, n = 0;
    for (let a = 0; a < 7; a++) for (let b = 0; b < 7; b++) {
        const u = r.u0 + ((r.u1 - r.u0) * (a + 0.5)) / 7, v = r.v0 + ((r.v1 - r.v0) * (b + 0.5)) / 7;
        const i = Math.floor((u - c.u0) / c.du), j = Math.floor((v - c.v0) / c.dv);
        n++;
        if (i < 0 || j < 0 || i >= c.nu || j >= c.nv) continue;
        if (c.covered[j * c.nu + i]) hit++;
    }
    return n ? hit / n : 0;
}

/** True when the chart point (u, v) of a surface slot lies over a covered cell. */
export function coveredAt(c: SurfaceCover, u: number, v: number): boolean {
    const i = Math.floor((u - c.u0) / c.du), j = Math.floor((v - c.v0) / c.dv);
    return i >= 0 && j >= 0 && i < c.nu && j < c.nv && c.covered[j * c.nu + i] === 1;
}

/** True when the station of an edge slot at fraction f (0-1) of its length is blocked. */
export function blockedAt(c: EdgeCover, f: number): boolean {
    const k = Math.floor(f * c.n);
    return k >= 0 && k < c.n && c.blocked[k] === 1;
}

/** The open stretches of an edge slot as [from, to] fractions of its length. */
export function openStretches(c: EdgeCover): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let start = -1;
    for (let k = 0; k <= c.n; k++) {
        const open = k < c.n && !c.blocked[k];
        if (open && start < 0) start = k;
        if (!open && start >= 0) { out.push([start / c.n, k / c.n]); start = -1; }
    }
    return out;
}

/** The covered parts of a surface slot as bounding rectangles of its connected covered cells, largest first (at most four). */
export function coveredBoxes(c: SurfaceCover): Array<{ u0: number; u1: number; v0: number; v1: number; cells: number }> {
    const seen = new Uint8Array(c.nu * c.nv);
    const boxes: Array<{ u0: number; u1: number; v0: number; v1: number; cells: number }> = [];
    for (let j = 0; j < c.nv; j++) for (let i = 0; i < c.nu; i++) {
        if (!c.covered[j * c.nu + i] || seen[j * c.nu + i]) continue;
        const stack = [[i, j]];
        seen[j * c.nu + i] = 1;
        let i0 = i, i1 = i, j0 = j, j1 = j, cells = 0;
        while (stack.length) {
            const [x, y] = stack.pop()!;
            cells++;
            i0 = Math.min(i0, x); i1 = Math.max(i1, x); j0 = Math.min(j0, y); j1 = Math.max(j1, y);
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= c.nu || ny >= c.nv || seen[ny * c.nu + nx] || !c.covered[ny * c.nu + nx]) continue;
                seen[ny * c.nu + nx] = 1;
                stack.push([nx, ny]);
            }
        }
        boxes.push({ u0: c.u0 + i0 * c.du, u1: c.u0 + (i1 + 1) * c.du, v0: c.v0 + j0 * c.dv, v1: c.v0 + (j1 + 1) * c.dv, cells });
    }
    return boxes.sort((a, b) => b.cells - a.cells).slice(0, 4);
}

const f2 = (v: number) => (Math.round(v * 100) / 100).toString();

/** The sentence for the prompt: where the slot's space is taken, and where it is free. Undefined when none of it is covered. */
export function describeCover(c: SlotCover): string | undefined {
    if (c.kind === 'surface') {
        if (c.share <= 0) return undefined;
        const boxes = coveredBoxes(c).map(b => `u ${f2(b.u0)}-${f2(b.u1)} m, v ${f2(b.v0)}-${f2(b.v1)} m`);
        return `${Math.round(c.share * 100)}% of it is covered by another part of the structure (${boxes.join('; ')}): build nowhere in it`;
    }
    if (c.share <= 0) return undefined;
    const open = openStretches(c).map(([a, b]) => `${Math.round(a * 1000)}-${Math.round(b * 1000)}`);
    return `${Math.round(c.share * 100)}% of its length has another part of the structure in the way; free at t (per-mille) ${open.length ? open.join(', ') : 'nowhere'}: build only there`;
}
