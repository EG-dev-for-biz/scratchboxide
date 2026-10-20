/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The shape program trial (SCRATCHBOX_STAGED_SHAPE_PROGRAM, off by default): the program language, its validation, the
 * native spec it compiles to, and the native tool (scripts/shape_program.cpp, scratchbox_shape_program.hpp).
 *
 * A program is a list of elements in the building frame (u along the dominant wall direction, v across, h metres above
 * the street). Each element is one continuous geometric operator, chosen by which field it carries (never by a name):
 *   - `prism`: a plan outline (a polygon, an axis-aligned rectangle, or the measured outline inset by a distance) extruded
 *     between two heights, its roof given by a rise, a ridge direction and a hip share (0: gable ends .. 1: fully hipped);
 *   - `revolve`: a radial profile r(h) about a vertical axis, with a side count, K harmonic lobes of an amplitude and a twist;
 *   - `sweep`: a planar profile (points with optional DXF bulges for arcs) swept along a 3D carrier polyline, scaled and
 *     twisted along it;
 *   - `relief`: a band of a prism's walls displaced outward along their normal between two heights;
 * and any element may carry `repeat` (an affine replicator: count and step vector). `label` is free text for people; no
 * execution reads it.
 *
 * Every element compiles to a fixed vector of handles (side offsets, scales, heights) with bounds and steps, which the native
 * fit snaps to the scan; the fitted handles are written back into the program (`applyHandles`).
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError, placeCachedBinary } from '../../native-build-cache';
import { findTileRefineRepoRoot } from '../../tile-refine-service';

/** SCRATCHBOX_STAGED_SHAPE_PROGRAM: `tiers` (height-map tiers, no model), `1` / `program` (shape program + fit); off by default. */
export function stagedShapeProgram(env: NodeJS.ProcessEnv = process.env): 'tiers' | 'program' | undefined {
    const v = (env.SCRATCHBOX_STAGED_SHAPE_PROGRAM ?? '').trim().toLowerCase();
    if (!v || v === '0' || v === 'off' || v === 'false') return undefined;
    return v === 'tiers' ? 'tiers' : 'program';
}

export type UV = [number, number];

export interface ProgramOutline {
    /** Plan polygon (u, v) in metres. */
    polygon?: UV[];
    /** Axis-aligned rectangle in the frame. */
    rect?: { centerU: number; centerV: number; lengthU: number; widthV: number };
    /** The measured outline (the contact sheet's white loop) moved inward by this many metres (negative: outward). */
    measuredOutlineInsetM?: number;
}
export interface ProgramPrism { outline: ProgramOutline; baseM: number; topM: number; roofRiseM?: number; roofRidgeAngleDeg?: number; roofHipShare?: number }
export interface ProgramRevolve { centerU: number; centerV: number; baseM: number; profile: Array<[number, number]>; sides?: number; lobes?: number; lobeAmplitude?: number; twistDeg?: number }
export interface ProgramSweep { path: Array<[number, number, number]>; profile: number[][]; scaleEnd?: number; twistDeg?: number; closedPath?: boolean }
export interface ProgramRelief { targetElement: number; fromM: number; toM: number; outM: number }
export interface ProgramRepeat { count: number; stepU?: number; stepV?: number; stepH?: number }
export interface ProgramElement {
    label: string;
    prism?: ProgramPrism;
    revolve?: ProgramRevolve;
    sweep?: ProgramSweep;
    relief?: ProgramRelief;
    repeat?: ProgramRepeat;
}
export interface ShapeProgram { summary?: string; elements: ProgramElement[] }

const num = { type: 'number' };
const pair = { type: 'array', items: num, minItems: 2, maxItems: 2 };
const triple = { type: 'array', items: num, minItems: 3, maxItems: 3 };

/** The JSON schema the model answers in (structured output). */
export const SHAPE_PROGRAM_JSON_SCHEMA = {
    type: 'object',
    properties: {
        summary: { type: 'string', description: 'One or two sentences on the overall form as you read it.' },
        elements: {
            type: 'array',
            description: 'The solids whose union is the structure. Each element carries exactly one of prism, revolve, sweep, relief.',
            items: {
                type: 'object',
                properties: {
                    label: { type: 'string', description: 'Free text for a person; never read by the builder.' },
                    prism: {
                        type: 'object',
                        properties: {
                            outline: {
                                type: 'object',
                                description: 'Exactly one of polygon, rect, measuredOutlineInsetM.',
                                properties: {
                                    polygon: { type: 'array', items: pair, description: '[u, v] metres, at least 3 points, no repeat of the first.' },
                                    rect: { type: 'object', properties: { centerU: num, centerV: num, lengthU: num, widthV: num }, required: ['centerU', 'centerV', 'lengthU', 'widthV'] },
                                    measuredOutlineInsetM: { type: 'number', description: 'The measured outline moved inward by this many metres (0: as measured).' }
                                }
                            },
                            baseM: { type: 'number', description: 'Bottom of the solid, metres above the street (0 on the ground).' },
                            topM: { type: 'number', description: 'Top of the walls (the eaves when the roof rises), metres above the street.' },
                            roofRiseM: { type: 'number', description: 'How far the roof rises above topM at its ridge (0: flat).' },
                            roofRidgeAngleDeg: { type: 'number', description: 'Direction of the ridge, degrees from +u toward +v.' },
                            roofHipShare: { type: 'number', description: '0: vertical gable ends; 1: the ends slope the whole half length (a pyramid on a square).' }
                        },
                        required: ['outline', 'baseM', 'topM']
                    },
                    revolve: {
                        type: 'object',
                        properties: {
                            centerU: num, centerV: num,
                            baseM: { type: 'number', description: 'Height of the profile\'s zero, metres above the street.' },
                            profile: { type: 'array', items: pair, description: '[height above baseM, radius] pairs from the bottom up (radius 0 at a point).' },
                            sides: { type: 'integer', description: 'Polygon sides (4 square, 8 octagonal, 32 or more round).' },
                            lobes: { type: 'integer', description: 'Harmonic lobes around the axis (0: none).' },
                            lobeAmplitude: { type: 'number', description: 'Lobe depth as a share of the radius (0..0.5).' },
                            twistDeg: { type: 'number', description: 'Twist from bottom to top, degrees.' }
                        },
                        required: ['centerU', 'centerV', 'baseM', 'profile']
                    },
                    sweep: {
                        type: 'object',
                        properties: {
                            path: { type: 'array', items: triple, description: '[u, v, h] carrier points, metres.' },
                            profile: { type: 'array', items: { type: 'array', items: num, minItems: 2, maxItems: 3 }, description: '[x across the path (horizontal), y up, optional bulge to the next point: tan(arc angle / 4), positive counter-clockwise] - a closed simple polygon, metres.' },
                            scaleEnd: { type: 'number', description: 'Profile scale at the end of the path (1 at the start).' },
                            twistDeg: num,
                            closedPath: { type: 'boolean' }
                        },
                        required: ['path', 'profile']
                    },
                    relief: {
                        type: 'object',
                        properties: {
                            targetElement: { type: 'integer', description: 'Index (from 0) of the prism whose walls carry the band.' },
                            fromM: num, toM: num,
                            outM: { type: 'number', description: 'How far the band stands out of the walls, metres.' }
                        },
                        required: ['targetElement', 'fromM', 'toM', 'outM']
                    },
                    repeat: {
                        type: 'object',
                        properties: { count: { type: 'integer' }, stepU: num, stepV: num, stepH: num },
                        required: ['count']
                    }
                },
                required: ['label']
            }
        }
    },
    required: ['elements']
} as const;

// ------------------------------------------------------------------------------------------------
// validation
// ------------------------------------------------------------------------------------------------

export interface ProgramBounds { minU: number; maxU: number; minV: number; maxV: number; maxH: number }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Checks a model's program: each element must carry exactly one operator with finite, plausible numbers. Bad elements are dropped and said. */
export function validateProgram(raw: unknown, b: ProgramBounds): { program?: ShapeProgram; problems: string[] } {
    const problems: string[] = [];
    const doc = raw as { summary?: unknown; elements?: unknown };
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.elements)) return { problems: ['the answer has no elements array'] };
    const reach = 20;
    const inU = (u: number) => u >= b.minU - reach && u <= b.maxU + reach, inV = (v: number) => v >= b.minV - reach && v <= b.maxV + reach;
    const inH = (h: number) => h >= -1 && h <= b.maxH + reach;
    const out: ProgramElement[] = [];
    const indexMap = new Map<number, number>();
    (doc.elements as unknown[]).forEach((e0, i) => {
        const e = e0 as ProgramElement;
        const say = (m: string) => problems.push(`element ${i}${e?.label ? ` (${String(e.label).slice(0, 40)})` : ''}: ${m}`);
        if (!e || typeof e !== 'object') return say('not an object');
        const ops = (['prism', 'revolve', 'sweep', 'relief'] as const).filter(k => e[k] !== undefined && e[k] !== null);
        if (ops.length !== 1) return say(`carries ${ops.length} operators (exactly one needed)`);
        const el: ProgramElement = { label: typeof e.label === 'string' ? e.label : '' };
        if (e.prism) {
            const p = e.prism;
            if (!finite(p.baseM) || !finite(p.topM) || !inH(p.baseM) || !inH(p.topM) || p.topM <= p.baseM + 0.1) return say(`heights ${p.baseM}..${p.topM} m are not usable`);
            const o = p.outline ?? {};
            const kinds = [o.polygon !== undefined, o.rect !== undefined, o.measuredOutlineInsetM !== undefined].filter(Boolean).length;
            if (kinds !== 1) return say('the outline must give exactly one of polygon, rect, measuredOutlineInsetM');
            if (o.polygon && (!Array.isArray(o.polygon) || o.polygon.length < 3 || !o.polygon.every(q => Array.isArray(q) && finite(q[0]) && finite(q[1]) && inU(q[0]) && inV(q[1])))) return say('the polygon needs at least 3 finite points within the site');
            if (o.rect && !(finite(o.rect.centerU) && finite(o.rect.centerV) && finite(o.rect.lengthU) && finite(o.rect.widthV) && o.rect.lengthU > 0.1 && o.rect.widthV > 0.1 && inU(o.rect.centerU) && inV(o.rect.centerV))) return say('the rectangle is not usable');
            if (o.measuredOutlineInsetM !== undefined && !(finite(o.measuredOutlineInsetM) && Math.abs(o.measuredOutlineInsetM) < 30)) return say('the inset is not usable');
            const rise = finite(p.roofRiseM) ? Math.max(0, p.roofRiseM) : 0;
            if (!inH(p.topM + rise)) return say('the roof rises out of the site');
            el.prism = {
                outline: o.polygon ? { polygon: o.polygon.map(q => [q[0], q[1]] as UV) } : o.rect ? { rect: { ...o.rect } } : { measuredOutlineInsetM: o.measuredOutlineInsetM },
                baseM: p.baseM, topM: p.topM, roofRiseM: rise,
                roofRidgeAngleDeg: finite(p.roofRidgeAngleDeg) ? p.roofRidgeAngleDeg : 0,
                roofHipShare: finite(p.roofHipShare) ? Math.max(0, Math.min(1, p.roofHipShare)) : 0
            };
        } else if (e.revolve) {
            const r = e.revolve;
            if (!finite(r.centerU) || !finite(r.centerV) || !finite(r.baseM) || !inU(r.centerU) || !inV(r.centerV) || !inH(r.baseM)) return say('the axis is not usable');
            if (!Array.isArray(r.profile) || r.profile.length < 2 || !r.profile.every(q => Array.isArray(q) && finite(q[0]) && finite(q[1]) && q[1] >= 0 && q[1] < 60)) return say('the profile needs at least 2 [height, radius >= 0] pairs');
            const prof = r.profile.map(q => [q[0], q[1]] as [number, number]).sort((a, c) => a[0] - c[0]);
            if (prof[prof.length - 1][0] - prof[0][0] < 0.1 || !inH(r.baseM + prof[prof.length - 1][0])) return say('the profile has no usable height');
            el.revolve = {
                centerU: r.centerU, centerV: r.centerV, baseM: r.baseM, profile: prof,
                sides: Math.max(3, Math.min(96, Math.round(finite(r.sides) ? r.sides : 32))), lobes: Math.max(0, Math.min(48, Math.round(finite(r.lobes) ? r.lobes : 0))),
                lobeAmplitude: finite(r.lobeAmplitude) ? Math.max(0, Math.min(0.5, r.lobeAmplitude)) : 0, twistDeg: finite(r.twistDeg) ? r.twistDeg : 0
            };
        } else if (e.sweep) {
            const s = e.sweep;
            if (!Array.isArray(s.path) || s.path.length < 2 || !s.path.every(q => Array.isArray(q) && finite(q[0]) && finite(q[1]) && finite(q[2]) && inU(q[0]) && inV(q[1]) && inH(q[2]))) return say('the path needs at least 2 finite [u, v, h] points within the site');
            if (!Array.isArray(s.profile) || s.profile.length < 3 || !s.profile.every(q => Array.isArray(q) && finite(q[0]) && finite(q[1]) && Math.abs(q[0]) < 60 && Math.abs(q[1]) < 80 && (q[2] === undefined || (finite(q[2]) && Math.abs(q[2]) <= 2)))) return say('the profile needs at least 3 finite points');
            el.sweep = {
                path: s.path.map(q => [q[0], q[1], q[2]] as [number, number, number]), profile: s.profile.map(q => [q[0], q[1], finite(q[2]) ? q[2] : 0]),
                scaleEnd: finite(s.scaleEnd) && s.scaleEnd > 0 ? Math.min(5, s.scaleEnd) : 1, twistDeg: finite(s.twistDeg) ? s.twistDeg : 0, closedPath: !!s.closedPath
            };
        } else if (e.relief) {
            const r = e.relief;
            if (!Number.isInteger(r.targetElement) || !finite(r.fromM) || !finite(r.toM) || !finite(r.outM) || r.toM <= r.fromM || r.outM <= 0 || r.outM > 5) return say('the band is not usable');
            el.relief = { targetElement: r.targetElement, fromM: r.fromM, toM: r.toM, outM: r.outM };
        }
        if (e.repeat) {
            const rp = e.repeat;
            if (!Number.isInteger(rp.count) || rp.count < 1 || rp.count > 80) say(`repeat count ${rp.count} ignored (1..80)`);
            else el.repeat = { count: rp.count, stepU: finite(rp.stepU) ? rp.stepU : 0, stepV: finite(rp.stepV) ? rp.stepV : 0, stepH: finite(rp.stepH) ? rp.stepH : 0 };
        }
        indexMap.set(i, out.length);
        out.push(el);
    });
    // relief targets: renumbered to the kept elements; a band whose prism was dropped is dropped
    const kept: ProgramElement[] = [];
    const renum = new Map<number, number>();
    out.forEach((el, k) => {
        if (el.relief) {
            const t = indexMap.get(el.relief.targetElement);
            if (t === undefined || !out[t]?.prism) { problems.push(`a relief band targets element ${el.relief.targetElement}, which is not a kept prism: dropped`); return; }
            el.relief = { ...el.relief, targetElement: t };
        }
        renum.set(k, kept.length);
        kept.push(el);
    });
    for (const el of kept) if (el.relief) el.relief.targetElement = renum.get(el.relief.targetElement)!;
    if (!kept.length) return { problems: [...problems, 'no element survived validation'] };
    return { program: { ...(typeof doc.summary === 'string' ? { summary: doc.summary } : {}), elements: kept }, problems };
}

// ------------------------------------------------------------------------------------------------
// compilation to the native spec
// ------------------------------------------------------------------------------------------------

/** Handle vectors per operator (scratchbox_shape_program.hpp: PR_*, RV_*, SW_*, RL_*), each followed by the replicator's step scale. */
export const HANDLE_NAMES = {
    prism: ['minUOffsetM', 'maxUOffsetM', 'minVOffsetM', 'maxVOffsetM', 'baseM', 'topM', 'roofRiseM'],
    revolve: ['du', 'dv', 'baseM', 'heightScale', 'radiusScale'],
    sweep: ['du', 'dv', 'dh', 'pathScale', 'profileScale'],
    relief: ['fromM', 'toM', 'outM']
} as const;

export interface Handle { value: number; lo: number; hi: number; step: number }

/** Plain polygon offset (mitred, limited), positive outward, for a closed ring in (u, v). */
export function offsetRing(r: UV[], d: number): UV[] {
    const n = r.length;
    if (n < 3 || Math.abs(d) < 1e-9) return r.map(p => [p[0], p[1]] as UV);
    let a = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) a += r[j][0] * r[i][1] - r[i][0] * r[j][1];
    const sgn = a > 0 ? 1 : -1;
    return r.map((q, i) => {
        const p = r[(i + n - 1) % n], s = r[(i + 1) % n];
        const l1 = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, l2 = Math.hypot(s[0] - q[0], s[1] - q[1]) || 1;
        const n1 = [sgn * (q[1] - p[1]) / l1, -sgn * (q[0] - p[0]) / l1], n2 = [sgn * (s[1] - q[1]) / l2, -sgn * (s[0] - q[0]) / l2];
        let mu = n1[0] + n2[0], mv = n1[1] + n2[1];
        const ml = Math.hypot(mu, mv);
        if (ml < 1e-9) return [q[0] + n1[0] * d, q[1] + n1[1] * d] as UV;
        mu /= ml; mv /= ml;
        const k = Math.min(3, 1 / Math.max(1e-3, mu * n1[0] + mv * n1[1]));
        return [q[0] + mu * d * k, q[1] + mv * d * k] as UV;
    });
}

/** The plan outline of a prism (frame), before handles. */
export function resolveOutline(o: ProgramOutline, measured: UV[]): UV[] {
    if (o.polygon) return o.polygon;
    if (o.rect) {
        const { centerU: cu, centerV: cv, lengthU: L, widthV: W } = o.rect;
        return [[cu - L / 2, cv - W / 2], [cu + L / 2, cv - W / 2], [cu + L / 2, cv + W / 2], [cu - L / 2, cv + W / 2]];
    }
    return offsetRing(measured, -(o.measuredOutlineInsetM ?? 0));
}

/** The handles of an element as given (offsets 0, scales 1) with their bounds and steps (step 0: held fixed). */
export function elementHandles(e: ProgramElement, fit: boolean): Handle[] {
    const H = (value: number, lo: number, hi: number, step: number): Handle => ({ value, lo: Math.min(lo, value), hi: Math.max(hi, value), step: fit ? step : 0 });
    const rep = e.repeat && e.repeat.count > 1 ? H(1, 0.85, 1.15, 0.02) : H(1, 1, 1, 0);
    if (e.prism) {
        const p = e.prism, onGround = p.baseM < 0.3, rise = p.roofRiseM ?? 0;
        const measured = p.outline.measuredOutlineInsetM !== undefined;
        const side = () => H(0, -3, 3, measured ? 0.25 : 0.5);
        return [side(), side(), side(), side(),
            onGround ? H(p.baseM, p.baseM, p.baseM, 0) : H(p.baseM, Math.max(0, p.baseM - 3), p.baseM + 3, 0.5),
            H(p.topM, p.baseM + 0.5, p.topM + 8, 1), H(rise, 0, Math.max(8, 2 * rise), rise > 0 ? 0.75 : 0), rep];
    }
    if (e.revolve) {
        const r = e.revolve;
        return [H(0, -2, 2, 0.25), H(0, -2, 2, 0.25), H(r.baseM, Math.max(0, r.baseM - 4), r.baseM + 4, 0.75), H(1, 0.6, 1.5, 0.05), H(1, 0.6, 1.6, 0.05), rep];
    }
    if (e.sweep) return [H(0, -2, 2, 0.25), H(0, -2, 2, 0.25), H(0, -2, 2, 0.25), H(1, 0.8, 1.2, 0.03), H(1, 0.6, 1.6, 0.05), rep];
    const r = e.relief!;
    return [H(r.fromM, r.fromM - 1.5, r.fromM + 1.5, 0.25), H(r.toM, r.toM - 1.5, r.toM + 1.5, 0.25), H(r.outM, 0.02, Math.max(1, 2 * r.outM), 0.1), rep];
}

const f6 = (v: number) => (Number.isFinite(v) ? Number(v.toFixed(5)).toString() : '0');

export interface ScanTargets {
    dir: string;
    frame: { ox: number; oz: number; theta: number; groundY: number };
    grid: { u0: number; v0: number; cell: number; nu: number; nv: number };
    cameras: Array<{ eye: number[]; fwd: number[]; right: number[]; up: number[]; focal: number; W: number; H: number }>;
    buildingH: number;
}

/** The native spec of a program (mode program), with the scan's targets when given. */
export function programSpecText(prog: ShapeProgram, opts: { outDir: string; measuredOutline: UV[]; scan: ScanTargets; fit: { passes: number; maxEvals: number } | null; handles?: Handle[][] }): string {
    const { scan } = opts;
    const L = ['mode program', `out ${opts.outDir}`, `ground ${f6(scan.frame.groundY)}`, `frame ${f6(scan.frame.ox)} ${f6(scan.frame.oz)} ${f6(scan.frame.theta)}`,
        `grid ${f6(scan.grid.u0)} ${f6(scan.grid.v0)} ${f6(scan.grid.cell)} ${scan.grid.nu} ${scan.grid.nv}`, `target_height ${path.join(scan.dir, 'height.f32')}`, `buildingH ${f6(scan.buildingH)}`,
        `fit ${opts.fit ? opts.fit.passes : 0} ${opts.fit ? opts.fit.maxEvals : 0}`];
    scan.cameras.forEach((c, k) => L.push(`camera ${[...c.eye, ...c.fwd, ...c.right, ...c.up].map(f6).join(' ')} ${f6(c.focal)} ${c.W} ${c.H} ${path.join(scan.dir, `v${k}.depth.f32`)}`));
    prog.elements.forEach((e, i) => {
        const rep = e.repeat ?? { count: 1 };
        const rp = `${rep.count} ${f6(rep.stepU ?? 0)} ${f6(rep.stepV ?? 0)} ${f6(rep.stepH ?? 0)}`;
        const id = `e${i}`;
        if (e.prism) {
            const o = resolveOutline(e.prism.outline, opts.measuredOutline);
            L.push(`prism ${id} ${f6(e.prism.roofRidgeAngleDeg ?? 0)} ${f6(e.prism.roofHipShare ?? 0)} ${rp} ${o.length} ${o.map(q => `${f6(q[0])} ${f6(q[1])}`).join(' ')}`);
        } else if (e.revolve) {
            const r = e.revolve;
            L.push(`revolve ${id} ${f6(r.centerU)} ${f6(r.centerV)} ${r.sides ?? 32} ${r.lobes ?? 0} ${f6(r.lobeAmplitude ?? 0)} ${f6(r.twistDeg ?? 0)} ${rp} ${r.profile.length} ${r.profile.map(q => `${f6(q[0])} ${f6(q[1])}`).join(' ')}`);
        } else if (e.sweep) {
            const s = e.sweep;
            L.push(`sweep ${id} ${f6(s.scaleEnd ?? 1)} ${f6(s.twistDeg ?? 0)} ${s.closedPath ? 1 : 0} ${rp} ${s.path.length} ${s.path.map(q => `${f6(q[0])} ${f6(q[2])} ${f6(q[1])}`).join(' ')} ${s.profile.length} ${s.profile.map(q => `${f6(q[0])} ${f6(q[1])} ${f6(q[2] ?? 0)}`).join(' ')}`);
        } else if (e.relief) {
            L.push(`relief ${id} ${e.relief.targetElement} ${rp}`);
        }
        for (const h of opts.handles?.[i] ?? elementHandles(e, !!opts.fit)) L.push(`h ${f6(h.value)} ${f6(h.lo)} ${f6(h.hi)} ${f6(opts.fit ? h.step : 0)}`);
    });
    return L.join('\n') + '\n';
}

/** Per parameter of the fitted program: its value and where it came from. */
export interface ParameterRecord { element: number; name: string; before: number; after: number; provenance: 'measured' | 'photo-inferred' }

/** Writes fitted handles back into the program; every handle the fit was free to move is labelled `measured`. */
export function applyHandles(prog: ShapeProgram, handles: Array<Array<[number, number]>>, free: boolean[][], measuredOutline: UV[]): { program: ShapeProgram; parameters: ParameterRecord[] } {
    const parameters: ParameterRecord[] = [];
    const elements = prog.elements.map((e, i) => {
        const h = handles[i]?.map(x => x[1]) ?? [];
        const names = e.prism ? HANDLE_NAMES.prism : e.revolve ? HANDLE_NAMES.revolve : e.sweep ? HANDLE_NAMES.sweep : HANDLE_NAMES.relief;
        handles[i]?.forEach(([b, a], k) => parameters.push({ element: i, name: k < names.length ? names[k] : 'repeatStepScale', before: b, after: a, provenance: free[i]?.[k] ? 'measured' : 'photo-inferred' }));
        const stepScale = h[names.length] ?? 1;
        const repeat = e.repeat ? { ...e.repeat, stepU: (e.repeat.stepU ?? 0) * stepScale, stepV: (e.repeat.stepV ?? 0) * stepScale, stepH: (e.repeat.stepH ?? 0) * stepScale } : undefined;
        if (e.prism) {
            const o = resolveOutline(e.prism.outline, measuredOutline);
            const u0 = Math.min(...o.map(q => q[0])), u1 = Math.max(...o.map(q => q[0])), v0 = Math.min(...o.map(q => q[1])), v1 = Math.max(...o.map(q => q[1]));
            const polygon = o.map(q => { const tu = (q[0] - u0) / Math.max(1e-6, u1 - u0), tv = (q[1] - v0) / Math.max(1e-6, v1 - v0); return [q[0] + h[0] * (1 - tu) + h[1] * tu, q[1] + h[2] * (1 - tv) + h[3] * tv] as UV; });
            return { ...e, prism: { ...e.prism, outline: { polygon }, baseM: h[4], topM: Math.max(h[5], h[4] + 0.5), roofRiseM: h[6] }, ...(repeat ? { repeat } : {}) };
        }
        if (e.revolve) {
            const r = e.revolve;
            return { ...e, revolve: { ...r, centerU: r.centerU + h[0], centerV: r.centerV + h[1], baseM: h[2], profile: r.profile.map(q => [q[0] * h[3], q[1] * h[4]] as [number, number]) }, ...(repeat ? { repeat } : {}) };
        }
        if (e.sweep) {
            const s = e.sweep;
            const c = [0, 1, 2].map(k => s.path.reduce((acc, q) => acc + q[k], 0) / s.path.length);
            return { ...e, sweep: { ...s, path: s.path.map(q => [c[0] + (q[0] - c[0]) * h[3] + h[0], c[1] + (q[1] - c[1]) * h[3] + h[1], c[2] + (q[2] - c[2]) * h[3] + h[2]] as [number, number, number]), profile: s.profile.map(q => [q[0] * h[4], q[1] * h[4], q[2] ?? 0]) }, ...(repeat ? { repeat } : {}) };
        }
        return { ...e, relief: { ...e.relief!, fromM: h[0], toM: Math.max(h[1], h[0] + 0.1), outM: Math.max(0.02, h[2]) }, ...(repeat ? { repeat } : {}) };
    });
    return { program: { ...prog, elements }, parameters };
}

// ------------------------------------------------------------------------------------------------
// the native tool
// ------------------------------------------------------------------------------------------------

const CLI_SOURCE = path.join('scripts', 'shape_program.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');
const BINARY = path.join('build', '3d-native', 'shape_program');
let building: Promise<{ path: string; built: boolean; buildMs?: number }> | undefined;

export function ensureShapeBinary(repoRoot = findTileRefineRepoRoot()): Promise<{ path: string; built: boolean; buildMs?: number }> {
    if (process.env.SCRATCHBOX_SHAPE_PROGRAM_BIN) return Promise.resolve({ path: process.env.SCRATCHBOX_SHAPE_PROGRAM_BIN, built: false });
    building ??= (async () => {
        const t0 = Date.now();
        const bin = path.join(repoRoot, BINARY);
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), libs: ['-lz'], name: 'shape_program', timeoutMs: 600_000 });
            placeCachedBinary(built.binaryPath, bin);
            return built.cacheHit ? { path: bin, built: false } : { path: bin, built: true, buildMs: Date.now() - t0 };
        } catch (err) {
            throw new Error(`could not build shape_program: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** Runs the native tool on a spec written into `dir`; resolves with its JSON answer line, rejects with its error. */
export async function runShapeTool(specText: string, dir: string, opts: { timeoutMs?: number; signal?: AbortSignal; name?: string } = {}): Promise<{ answer: Record<string, unknown>; ms: number }> {
    const binary = await ensureShapeBinary();
    fs.mkdirSync(dir, { recursive: true });
    const specFile = path.join(dir, opts.name ?? 'spec.txt');
    fs.writeFileSync(specFile, specText);
    const t0 = Date.now();
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile(binary.path, [specFile], { timeout: opts.timeoutMs ?? 120_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, ...(opts.signal ? { signal: opts.signal } : {}) }, (err, out, errOut) => {
            if (err) {
                const tail = String(out || errOut || err.message).trim().split('\n').pop() ?? err.message;
                let msg = tail;
                try { msg = JSON.parse(tail).error ?? tail; } catch { /* not JSON */ }
                reject(new Error(`shape_program failed: ${msg}`));
            } else resolve(String(out));
        });
    });
    const answer = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    if (!answer.ok) throw new Error(`shape_program failed: ${answer.error ?? 'no answer'}`);
    return { answer, ms: Date.now() - t0 };
}

export function readF32(file: string): Float32Array { const b = fs.readFileSync(file); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); }
export function readU8(file: string): Uint8Array { return new Uint8Array(fs.readFileSync(file)); }
