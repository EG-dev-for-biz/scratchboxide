/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Blueprint lofts: a sweep straight along the object's length whose sections come from its blueprint (the side, plan
 * and front outlines object_blueprint_outlines reads). The section at each station is the slice of the three drawings'
 * hull there: between the side outline's bottom and top, no wider than the plan's half width at that station, and at
 * each height no wider than the front outline's half width at that height. Lofted station by station, the part follows
 * the drawings by construction instead of by profile keys a reader has to choose.
 *
 * A spec keeps the outlines once (spec.blueprint) and each such part as a short fromBlueprint block (a height band, a
 * span along the length, an inset, circles its underside is lifted over); expandBlueprintParts turns those blocks into
 * explicit rings (sweep.sections) only for the build, so the stored spec stays small and editable.
 */

export type Vec3 = [number, number, number];

export interface SideStation { z: number; top: number; bottom: number }
export interface PlanStation { z: number; halfWidth: number }
export interface FrontStation { y: number; halfWidth: number }

/** An object's outlines in the object build frame (+Y up from the ground, +Z its front, origin at mid length and width). */
export interface ObjectOutlines {
    /** [width X, height Y, length Z] the outlines are scaled to (a blueprint) or measure (a build). */
    sizeMeters: Vec3;
    side: SideStation[];
    plan: PlanStation[];
    front: FrontStation[];
    /** Runs along Z where the side bottom line touches the ground, front first. */
    groundContacts: Array<{ zFrom: number; zTo: number; zCentre: number }>;
    /** Where the drawn surface sinks inside the outline (blueprint-depth.ts), photo-inferred: front and side grids. */
    relief?: { front?: ReliefGrid; side?: ReliefGrid; model?: string };
}

/**
 * A view's sinks over its silhouette's box: cols x rows cells, row-major from the top, 0 flush to -1 the deepest.
 * The front view's columns run from the viewer's left (the object's +X side) to its right; the side view's from the
 * object's rear to its front.
 */
export interface ReliefGrid {
    cols: number;
    rows: number;
    values: number[];
}

/** The deepest a blueprint's relief is laid into a lofted surface, metres. */
export const MAX_RELIEF_METERS = 0.05;

/** A circle (in the side view) the part's underside is lifted over: a wheel arch around a hub, a tunnel, an opening. */
export interface LoftClearance {
    zMeters: number;
    yMeters: number;
    radiusMeters: number;
}

/** Which slice of the blueprint's hull a part takes; every bound is optional. */
export interface BlueprintLoft {
    /** Keep only heights from yFromMeters up to yToMeters. */
    yFromMeters?: number;
    yToMeters?: number;
    /** Keep only heights within this many metres of the side outline's top at each station (a roof panel). */
    fromTopMeters?: number;
    /** Stop this many metres under the side outline's top at each station (glass under a roof panel lofted above it). */
    clearTopMeters?: number;
    /** Keep only stations from zFromMeters to zToMeters along the length. */
    zFromMeters?: number;
    zToMeters?: number;
    /** Shrink the half width by this much (negative grows it, e.g. a panel laid just outside another). */
    insetMeters?: number;
    /** Circles the underside is lifted over. */
    clearances?: LoftClearance[];
    /** Lay the blueprint's relief into the part's front- and side-facing surface, its deepest sinks this deep. */
    reliefMeters?: number;
}

/** One ring of a loft: closed, in the plane at z, [x, y] in object metres, the same count in every ring. */
export interface LoftSection {
    z: number;
    points: Array<[number, number]>;
}

/** Points on every ring, and how many heights each side of a section is sampled at. */
export const LOFT_RING_POINTS = 48;
const SIDE_LEVELS = 16;
/** A station whose slice is thinner or narrower than this is left out. */
const MIN_SLICE_METERS = 0.01;
export const MAX_LOFT_SECTIONS = 128;

// + 0 turns -0 into 0, as Python's rounding gives (object_spec.py lofts the same rings)
const round4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

function interpolate<T>(stations: T[], at: number, key: (s: T) => number, value: (s: T) => number): number | undefined {
    if (!stations.length) return undefined;
    const sorted = [...stations].sort((a, b) => key(a) - key(b));
    if (at <= key(sorted[0])) return value(sorted[0]);
    if (at >= key(sorted[sorted.length - 1])) return value(sorted[sorted.length - 1]);
    for (let i = 1; i < sorted.length; i++) {
        const a = sorted[i - 1], b = sorted[i];
        if (at <= key(b)) {
            const w = (at - key(a)) / ((key(b) - key(a)) || 1);
            return value(a) + (value(b) - value(a)) * w;
        }
    }
    return undefined;
}

/** A closed polyline resampled to `count` points evenly by arc length, starting at its first point. */
function resampleRing(points: Array<[number, number]>, count: number): Array<[number, number]> {
    const closed = [...points, points[0]];
    const acc = [0];
    for (let i = 1; i < closed.length; i++) acc.push(acc[i - 1] + Math.hypot(closed[i][0] - closed[i - 1][0], closed[i][1] - closed[i - 1][1]));
    const total = acc[acc.length - 1];
    const out: Array<[number, number]> = [];
    let seg = 1;
    for (let k = 0; k < count; k++) {
        const s = total * k / count;
        while (seg < acc.length - 1 && acc[seg] < s) seg++;
        const w = (s - acc[seg - 1]) / ((acc[seg] - acc[seg - 1]) || 1);
        out.push([round4(closed[seg - 1][0] + (closed[seg][0] - closed[seg - 1][0]) * w), round4(closed[seg - 1][1] + (closed[seg][1] - closed[seg - 1][1]) * w)]);
    }
    return out;
}

/**
 * The rings of a blueprint loft, rear to front. Each ring starts at the bottom of its centre line and runs to the
 * object's right (+X), up that side, across the top and down the left, so rings correspond point by point.
 */
export function loftSections(outlines: ObjectOutlines, loft: BlueprintLoft = {}): LoftSection[] {
    const front = outlines.front;
    const frontHalf = (y: number) => interpolate(front, y, s => s.y, s => s.halfWidth) ?? 0;
    const sections: LoftSection[] = [];
    const stations = [...outlines.side].sort((a, b) => a.z - b.z);
    for (const s of stations) {
        if (loft.zFromMeters !== undefined && s.z < loft.zFromMeters - 1e-9) continue;
        if (loft.zToMeters !== undefined && s.z > loft.zToMeters + 1e-9) continue;
        const plan = interpolate(outlines.plan, s.z, p => p.z, p => p.halfWidth) ?? 0;
        let lo = s.bottom, hi = s.top;
        if (loft.yFromMeters !== undefined) lo = Math.max(lo, loft.yFromMeters);
        if (loft.yToMeters !== undefined) hi = Math.min(hi, loft.yToMeters);
        if (loft.fromTopMeters !== undefined) lo = Math.max(lo, s.top - loft.fromTopMeters);
        if (loft.clearTopMeters !== undefined) hi = Math.min(hi, s.top - loft.clearTopMeters);
        for (const c of loft.clearances ?? []) {
            const dz = s.z - c.zMeters;
            if (Math.abs(dz) < c.radiusMeters) lo = Math.max(lo, c.yMeters + Math.sqrt(c.radiusMeters * c.radiusMeters - dz * dz));
        }
        if (hi - lo < MIN_SLICE_METERS) continue;
        const inset = loft.insetMeters ?? 0;
        const half = (y: number) => Math.min(plan, frontHalf(y)) - inset;
        const ys = Array.from({ length: SIDE_LEVELS }, (_, i) => lo + (hi - lo) * i / (SIDE_LEVELS - 1));
        const halves = ys.map(half);
        if (Math.max(...halves) < MIN_SLICE_METERS) continue;
        const h = halves.map(v => Math.max(v, MIN_SLICE_METERS / 2));
        const ring: Array<[number, number]> = [[0, lo]];
        ys.forEach((y, i) => ring.push([h[i], y]));
        ring.push([0, hi]);
        for (let i = ys.length - 1; i >= 0; i--) ring.push([-h[i], ys[i]]);
        sections.push({ z: round4(s.z), points: resampleRing(ring, LOFT_RING_POINTS) });
    }
    // more stations than a loft takes: keep evenly spaced ones, always the two ends
    if (sections.length > MAX_LOFT_SECTIONS) {
        const keep = Array.from({ length: MAX_LOFT_SECTIONS }, (_, i) => Math.round(i * (sections.length - 1) / (MAX_LOFT_SECTIONS - 1)));
        return [...new Set(keep)].map(i => sections[i]);
    }
    return sections;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Problems with a fromBlueprint block (empty when it can be lofted). */
export function validateBlueprintLoft(loft: unknown, where: string): string[] {
    const errors: string[] = [];
    if (typeof loft !== 'object' || loft === null || Array.isArray(loft)) return [`${where}: sweep.fromBlueprint must be an object`];
    const l = loft as Record<string, unknown>;
    for (const k of ['yFromMeters', 'yToMeters', 'fromTopMeters', 'clearTopMeters', 'zFromMeters', 'zToMeters', 'insetMeters']) {
        if (l[k] !== undefined && !isNum(l[k])) errors.push(`${where}: sweep.fromBlueprint.${k} must be a number of metres`);
    }
    if (isNum(l.yFromMeters) && isNum(l.yToMeters) && l.yToMeters <= l.yFromMeters) errors.push(`${where}: sweep.fromBlueprint.yToMeters must be above yFromMeters`);
    if (isNum(l.zFromMeters) && isNum(l.zToMeters) && l.zToMeters <= l.zFromMeters) errors.push(`${where}: sweep.fromBlueprint.zToMeters must be ahead of zFromMeters`);
    if (isNum(l.fromTopMeters) && l.fromTopMeters <= 0) errors.push(`${where}: sweep.fromBlueprint.fromTopMeters must be greater than 0`);
    if (isNum(l.clearTopMeters) && l.clearTopMeters <= 0) errors.push(`${where}: sweep.fromBlueprint.clearTopMeters must be greater than 0`);
    if (l.reliefMeters !== undefined && (!isNum(l.reliefMeters) || l.reliefMeters < 0 || l.reliefMeters > MAX_RELIEF_METERS)) {
        errors.push(`${where}: sweep.fromBlueprint.reliefMeters must be 0 to ${MAX_RELIEF_METERS} metres`);
    }
    if (l.clearances !== undefined) {
        if (!Array.isArray(l.clearances) || l.clearances.length > 16) {
            errors.push(`${where}: sweep.fromBlueprint.clearances must be at most 16 circles`);
        } else {
            l.clearances.forEach((c, i) => {
                const r = c as Record<string, unknown>;
                if (!r || !isNum(r.zMeters) || !isNum(r.yMeters) || !isNum(r.radiusMeters) || r.radiusMeters <= 0) {
                    errors.push(`${where}: sweep.fromBlueprint.clearances[${i}] needs zMeters, yMeters and a radiusMeters above 0`);
                }
            });
        }
    }
    return errors;
}

/** Problems with a spec's stored blueprint outlines (empty when they can be lofted from). */
export function validateOutlines(o: unknown): string[] {
    if (typeof o !== 'object' || o === null) return ['blueprint must be the outlines object_blueprint_outlines returned'];
    const r = o as Record<string, unknown>;
    const okStations = (a: unknown, keys: string[]) => Array.isArray(a) && a.length >= 2 && a.every(s => typeof s === 'object' && s !== null && keys.every(k => isNum((s as Record<string, unknown>)[k])));
    const errors: string[] = [];
    if (!okStations(r.side, ['z', 'top', 'bottom'])) errors.push('blueprint.side must be at least two {z, top, bottom} stations');
    if (!okStations(r.plan, ['z', 'halfWidth'])) errors.push('blueprint.plan must be at least two {z, halfWidth} stations');
    if (!okStations(r.front, ['y', 'halfWidth'])) errors.push('blueprint.front must be at least two {y, halfWidth} stations');
    const relief = r.relief as Record<string, unknown> | undefined;
    for (const view of ['front', 'side'] as const) {
        const g = relief?.[view] as Record<string, unknown> | undefined;
        if (g === undefined) continue;
        if (!g || !Number.isInteger(g.cols) || !Number.isInteger(g.rows) || !Array.isArray(g.values) || g.values.length !== (g.cols as number) * (g.rows as number) || !g.values.every(v => isNum(v) && v <= 0 && v >= -1)) {
            errors.push(`blueprint.relief.${view} must be cols x rows values from -1 to 0`);
        }
    }
    return errors;
}

interface SpecLike {
    blueprint?: ObjectOutlines;
    parts: Array<{ id: string; sweep?: { fromBlueprint?: BlueprintLoft; sections?: LoftSection[] } }>;
}

/**
 * The spec with every fromBlueprint sweep turned into explicit rings (sweep.sections), for the build only. Throws,
 * naming the part, when a part's slice of the blueprint leaves fewer than two rings.
 */
export function expandBlueprintParts<T extends SpecLike>(spec: T): T {
    if (!spec.parts.some(p => p.sweep?.fromBlueprint)) return spec;
    if (!spec.blueprint) throw new Error('The spec has parts with sweep.fromBlueprint but no blueprint outlines to loft them from.');
    const blueprint = spec.blueprint;
    return {
        ...spec,
        parts: spec.parts.map(p => {
            if (!p.sweep?.fromBlueprint) return p;
            const sections = loftSections(blueprint, p.sweep.fromBlueprint);
            if (sections.length < 2) throw new Error(`Part "${p.id}": its slice of the blueprint (sweep.fromBlueprint) leaves fewer than two sections; widen its height band or span.`);
            const { fromBlueprint: _from, ...rest } = p.sweep;
            return { ...p, sweep: { ...rest, sections } };
        }) as T['parts']
    };
}
