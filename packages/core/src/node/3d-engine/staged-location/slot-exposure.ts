/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Which fitted slots can carry visible detail at all, before the reading is asked about any.
 *
 * The fit is a stack of closed prisms that share faces. A slot on a face one prism shares with another (or one a neighbour
 * covers) is inside the union of the fitted solid: no photograph shows it and nothing built on it could stand free of the
 * solid. Two tests:
 *   - EXPOSED: samples a hand's breadth off the slot, along its outward direction, must lie outside every fitted
 *     primitive's closed shell (the same union the native builder tests penetration against: each primitive is its own
 *     shell, a point is inside the union when any shell holds it);
 *   - SHOWN: at least one evidence image shows the slot at MIN_SLOT_VISIBLE_FRACTION or more (the projection already
 *     ray-tests the samples against the fitted model and the scan).
 * Only slots passing both are offered to the model, with the images that show them. A slot failing either is not an error:
 * it is just not asked about.
 */

import * as fs from 'fs';
import { readGlbScene } from '../../spatial/StreetViewPoseRegistrar';
import type { EvidenceImageRef, OrnamentSlot, StructureFit, Vec3 } from '../../../common/spatial/staged-location-contracts';
import { slotPoints, chartPoint } from './slot-projection';

/** A slot is offered when at least this share of its samples lies in open air. */
export const MIN_EXPOSED_SHARE = 0.3;
/** How far off the slot the open-air samples are taken. */
export const EXPOSURE_OFFSET_M = 0.08;
/** Mirrors ornament-vision's MIN_SLOT_VISIBLE_FRACTION (kept here to avoid a cycle). */
export const MIN_SHOWN_FRACTION = 0.3;

export interface Shell { id: string; positions: Float32Array; indices: Uint32Array; min: Vec3; max: Vec3 }

/** The fitted solid: one closed shell per primitive. */
export interface FittedShells { shells: Shell[] }

function glbNodeNames(file: string): string[] {
    const buf = fs.readFileSync(file);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + buf.readUInt32LE(12)));
    return (json.nodes ?? []).filter((n: { mesh?: number }) => n.mesh !== undefined).map((n: { name?: string }) => n.name ?? '');
}

/**
 * The fitted solid read from the fit's own GLB (one named node per fitted surface), grouped by primitive. Undefined when the
 * nodes cannot be matched to surfaces (then exposure is unknown, and the caller says so).
 */
export function readFittedShells(fit: Pick<StructureFit, 'surfaces' | 'outputs'>): FittedShells | undefined {
    const file = fit.outputs.fittedGlb;
    if (!file || !fs.existsSync(file)) return undefined;
    const names = glbNodeNames(file);
    const prims = readGlbScene(file);
    if (names.length !== prims.length) return undefined;
    const primitiveOf = new Map(fit.surfaces.map(s => [s.id, s.primitiveId || s.id]));
    const groups = new Map<string, Array<{ positions: Float32Array; indices: Uint32Array }>>();
    prims.forEach((p, i) => {
        const key = primitiveOf.get(names[i]);
        if (!key) return;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(p);
    });
    if (!groups.size) return undefined;
    const shells: Shell[] = [];
    for (const [id, parts] of groups) {
        const nv = parts.reduce((n, p) => n + p.positions.length, 0), ni = parts.reduce((n, p) => n + p.indices.length, 0);
        const positions = new Float32Array(nv), indices = new Uint32Array(ni);
        let ov = 0, oi = 0;
        for (const p of parts) {
            positions.set(p.positions, ov);
            for (let k = 0; k < p.indices.length; k++) indices[oi + k] = p.indices[k] + ov / 3;
            ov += p.positions.length; oi += p.indices.length;
        }
        const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < positions.length; k += 3) for (let c = 0; c < 3; c++) { min[c] = Math.min(min[c], positions[k + c]); max[c] = Math.max(max[c], positions[k + c]); }
        shells.push({ id, positions, indices, min, max });
    }
    return { shells };
}

const DIRS: Vec3[] = [[0.267, 0.535, 0.802], [-0.702, 0.302, 0.644], [0.12, -0.97, 0.21]].map(d => {
    const l = Math.hypot(d[0], d[1], d[2]);
    return [d[0] / l, d[1] / l, d[2] / l] as Vec3;
});

/** Triangles a ray from `o` along `d` crosses (Möller-Trumbore, both sides). */
function crossings(shell: Shell, o: Vec3, d: Vec3): number {
    const P = shell.positions, I = shell.indices;
    let n = 0;
    for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
        const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
        const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (Math.abs(det) < 1e-12) continue;
        const inv = 1 / det;
        const tx = o[0] - P[a], ty = o[1] - P[a + 1], tz = o[2] - P[a + 2];
        const u = (tx * px + ty * py + tz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
        const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (s > 1e-6) n++;
    }
    return n;
}

/** True when the point lies inside the closed shell of any primitive (parity of three rays, two of three agreeing). */
export function insideSolid(solid: FittedShells, p: Vec3, tolM = 0): boolean {
    for (const sh of solid.shells) {
        if (p[0] < sh.min[0] - tolM || p[0] > sh.max[0] + tolM || p[1] < sh.min[1] - tolM || p[1] > sh.max[1] + tolM || p[2] < sh.min[2] - tolM || p[2] > sh.max[2] + tolM) continue;
        let votes = 0;
        for (const d of DIRS) votes += crossings(sh, p, d) % 2;
        if (votes >= 2) return true;
    }
    return false;
}

/** Open-air test points of a slot: a hand's breadth off the face (surface slot) or off the outer edge of the crease section (edge slot). */
export function exposureSamples(slot: OrnamentSlot, fit: Pick<StructureFit, 'surfaces'>): Vec3[] {
    const surfaces = new Map(fit.surfaces.map(s => [s.id, s]));
    const host = slot.host;
    if ('surface' in host) {
        const surface = surfaces.get(host.surface.surfaceId);
        if (!surface) return [];
        const poly = host.surface.regionUv;
        const us = poly.map(p => p[0]), vs = poly.map(p => p[1]);
        const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
        const inPoly = (u: number, v: number) => {
            let inside = false;
            for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
                const [ui, vi] = poly[i], [uj, vj] = poly[j];
                if ((vi > v) !== (vj > v) && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
            }
            return inside;
        };
        const out: Vec3[] = [];
        for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) {
            const u = u0 + ((u1 - u0) * (i + 0.5)) / 8, v = v0 + ((v1 - v0) * (j + 0.5)) / 8;
            if (inPoly(u, v)) out.push(chartPoint(surface.chart, u, v, EXPOSURE_OFFSET_M));
        }
        return out;
    }
    // an edge slot: the samples slotPoints takes (outside the section's outer face), they are already off the surface
    return slotPoints(slot, surfaces).samples;
}

export interface SlotOfferEntry {
    slotId: string;
    /** Share of the slot's open-air samples outside the fitted solid (1: all open; undefined: not judged). */
    exposedShare?: number;
    /** The evidence images that show it: index and visible share (tile orthos show 1: they are renders of the surface itself). */
    images: Array<{ index: number; visibleFraction: number }>;
    offered: boolean;
    /** Why it is not offered. */
    why?: string;
}

export interface SlotOffer {
    entries: SlotOfferEntry[];
    offeredIds: Set<string>;
    /** Slots left out, by reason. */
    hidden: number;
    unseen: number;
    /** False when the fitted solid could not be read: nothing was judged exposed or hidden, only the images decided. */
    exposureJudged: boolean;
}

export function computeSlotOffer(fit: Pick<StructureFit, 'slots' | 'surfaces' | 'outputs'>, evidence: EvidenceImageRef[], solid: FittedShells | undefined = readFittedShells(fit)): SlotOffer {
    const entries: SlotOfferEntry[] = [];
    let hidden = 0, unseen = 0;
    for (const slot of fit.slots) {
        const images = evidence.flatMap(e => {
            const s = e.slotsShown.find(x => x.slotId === slot.id);
            return s && s.visibleFraction >= MIN_SHOWN_FRACTION ? [{ index: e.index, visibleFraction: s.visibleFraction }] : [];
        });
        let exposedShare: number | undefined;
        if (solid) {
            const samples = exposureSamples(slot, fit);
            if (samples.length) exposedShare = samples.filter(p => !insideSolid(solid, p)).length / samples.length;
            else exposedShare = 0;
        }
        let why: string | undefined;
        if (exposedShare !== undefined && exposedShare < MIN_EXPOSED_SHARE) { why = `on a hidden or interior face (${Math.round(exposedShare * 100)}% of it open to the air)`; hidden++; }
        else if (!images.length) { why = `no image shows it (${MIN_SHOWN_FRACTION * 100}% visible needed)`; unseen++; }
        entries.push({ slotId: slot.id, ...(exposedShare !== undefined ? { exposedShare: Math.round(exposedShare * 100) / 100 } : {}), images, offered: !why, ...(why ? { why } : {}) });
    }
    return { entries, offeredIds: new Set(entries.filter(e => e.offered).map(e => e.slotId)), hidden, unseen, exposureJudged: !!solid };
}

export function describeOffer(offer: SlotOffer, total: number): string {
    return `${offer.offeredIds.size} of ${total} fitted slots offered to the reading (${offer.hidden} on hidden or interior faces, ${offer.unseen} shown by no image${offer.exposureJudged ? '' : '; the fitted solid could not be read, so only the images decided'})`;
}
