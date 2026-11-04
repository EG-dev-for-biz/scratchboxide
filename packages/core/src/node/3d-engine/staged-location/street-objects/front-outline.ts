/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects, step 4 for a flat or long object (a bench, a barrier, a board on legs, a kiosk): its front outline from
 * the registered view that sees its long side most squarely, extruded through the scan's plan depth.
 *
 * Each mask row's runs are cast from the view's camera onto the vertical plane through the scan's plan axis (the cluster's
 * long axis through its centre): metres along the axis and height on it. The outline is re-centred on the scan's own centre
 * and scaled to the scan's height (the photo's shape, the scan's size and place, as the profiles are). Rows are binned by
 * height; neighbouring bins whose runs agree become one box (an interval along the axis over a height range), so a bench
 * comes out as its legs, its seat and its back. Each box is a straight sweep of a square-cornered section through the plan
 * depth (operator 1), its material the vision read's band at its height.
 */

import type { FrameCamera } from '../../../spatial/StreetViewPoseRegistrar';
import type { ObjectBuildSpec, ObjectPartSpec, PartMaterial, Vec3 } from '../../../../common/spatial/object-build-spec';
import { OBJECT_SPEC_LIMITS } from '../../../../common/spatial/object-build-spec';
import { pixelRay } from '../survey-casting';
import type { StreetObjectFamily, V2, V3 } from './families';
import { planAxis } from './split';
import { cleanBands, planHeadingOf, srgbToLinear, type NumberProvenance, type ObjectLook, type StreetObjectSpec } from './object-spec';
import type { ViewSilhouette } from './silhouette-profile';

export const FRONT_PARAMS = {
    /** A view counts as seeing the long side when its plan direction is within this of square to it. */
    maxObliqueDeg: 35,
    /** Height bins of the outline. */
    bins: 24,
    /** Two bins' runs agree when each end is within this (metres, or this share of the object's length, the larger). */
    endTolM: 0.05,
    endTolShare: 0.05,
    /** Runs narrower than this (metres) are not kept (below what a box can be). */
    minRunM: 0.03,
    /** At most this many boxes (the rest merged into their neighbours by dropping the narrowest). */
    maxBoxes: 24,
    /** Boxes this close (metres) touch: one body. */
    touchM: 0.03,
    /** The section's squareness. */
    exponent: 8
};

export interface OutlineBox { s0: number; s1: number; z0: number; z1: number }

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

/** How squarely a camera sees the long side of a plan axis: |cos| of the angle between its plan view direction and the side's normal. */
export function squareness(cam: FrameCamera, axisDir: V2): number {
    const f = [cam.fwd[0], cam.fwd[2]], L = Math.hypot(f[0], f[1]) || 1;
    return Math.abs((f[0] * -axisDir[1] + f[1] * axisDir[0]) / L);
}

/** The outline's boxes from one view (re-centred on the scan's centre, scaled to its height), or why it cannot be read. */
export function frontOutline(view: ViewSilhouette, member: { foot: V3; heightM: number; planM: V2; planHeadingDeg: number }, P = FRONT_PARAMS): { boxes: OutlineBox[]; lengthM: number; photoHeightM: number; scale: number; squareness: number } | { failed: string } {
    const dir = planAxis(member.planHeadingDeg);
    const sq = squareness(view.cam, dir);
    if (sq < Math.cos((P.maxObliqueDeg * Math.PI) / 180)) return { failed: `the view sees the long side ${Math.round((Math.acos(Math.min(1, sq)) * 180) / Math.PI)} deg off square` };
    const n: V3 = [-dir[1], 0, dir[0]];
    const F = member.foot;
    const cast = (px: number, py: number): { s: number; z: number } | undefined => {
        const r = pixelRay(view.cam, px, py);
        const dn = r.dir[0] * n[0] + r.dir[2] * n[2];
        if (Math.abs(dn) < 1e-6) return undefined;
        const t = ((F[0] - r.origin[0]) * n[0] + (F[2] - r.origin[2]) * n[2]) / dn;
        if (!(t > 0)) return undefined;
        const p = [r.origin[0] + r.dir[0] * t, r.origin[1] + r.dir[1] * t, r.origin[2] + r.dir[2] * t];
        return { s: (p[0] - F[0]) * dir[0] + (p[2] - F[2]) * dir[1], z: p[1] - F[1] };
    };
    const W = view.width, H = view.height;
    const rows: Array<{ z: number; runs: Array<[number, number]> }> = [];
    for (let y = 0; y < H; y++) {
        const runs: Array<[number, number]> = [];
        let x0 = -1;
        for (let x = 0; x <= W; x++) {
            const on = x < W && view.mask[y * W + x];
            if (on && x0 < 0) x0 = x;
            if (!on && x0 >= 0) {
                const a = cast(x0, y + 0.5), b = cast(x, y + 0.5);
                if (a && b) runs.push([Math.min(a.s, b.s), Math.max(a.s, b.s)]);
                x0 = -1;
            }
        }
        if (runs.length) { const c = cast(W / 2, y + 0.5); if (c) rows.push({ z: c.z, runs }); }
    }
    if (rows.length < 8) return { failed: `only ${rows.length} mask rows land on the plane of its long side` };
    const zs = rows.map(r => r.z), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const s0 = Math.min(...rows.flatMap(r => r.runs.map(q => q[0]))), s1 = Math.max(...rows.flatMap(r => r.runs.map(q => q[1])));
    const photoH = z1 - z0;
    if (!(photoH > 0.05)) return { failed: 'the outline has no height' };
    const k = member.heightM / photoH, mid = (s0 + s1) / 2;
    // per height bin: the union of its rows' runs, scan-scaled, centred on the scan's own centre
    const bins: Array<Array<[number, number]>> = Array.from({ length: P.bins }, () => []);
    for (const r of rows) {
        const b = Math.min(P.bins - 1, Math.max(0, Math.floor(((r.z - z0) / photoH) * P.bins)));
        for (const q of r.runs) bins[b].push([(q[0] - mid) * k, (q[1] - mid) * k]);
    }
    const lengthM = (s1 - s0) * k;
    const tol = Math.max(P.endTolM, P.endTolShare * lengthM);
    const unionOf = (xs: Array<[number, number]>) => {
        const s = xs.slice().sort((a, b) => a[0] - b[0]);
        const out: Array<[number, number]> = [];
        for (const q of s) { const l = out[out.length - 1]; if (l && q[0] <= l[1] + tol / 2) l[1] = Math.max(l[1], q[1]); else out.push([q[0], q[1]]); }
        return out.filter(q => q[1] - q[0] >= P.minRunM);
    };
    const binRuns = bins.map(unionOf);
    const same = (a: Array<[number, number]>, b: Array<[number, number]>) => a.length === b.length && a.every((q, i) => Math.abs(q[0] - b[i][0]) <= tol && Math.abs(q[1] - b[i][1]) <= tol);
    const boxes: OutlineBox[] = [];
    const binH = member.heightM / P.bins;
    for (let i = 0; i < P.bins;) {
        if (!binRuns[i].length) { i++; continue; }
        let j = i;
        while (j + 1 < P.bins && binRuns[j + 1].length && same(binRuns[i], binRuns[j + 1])) j++;
        const group = binRuns.slice(i, j + 1);
        for (let q = 0; q < binRuns[i].length; q++) boxes.push({ s0: r3(median(group.map(g => g[q][0]))), s1: r3(median(group.map(g => g[q][1]))), z0: r3(i * binH), z1: r3((j + 1) * binH) });
        i = j + 1;
    }
    while (boxes.length > P.maxBoxes) {
        // the shortest box joins the one below it
        let w = 0;
        for (let i = 1; i < boxes.length; i++) if (boxes[i].z1 - boxes[i].z0 < boxes[w].z1 - boxes[w].z0) w = i;
        const b = boxes.splice(w, 1)[0];
        const below = boxes.filter(x => Math.abs(x.z1 - b.z0) < 1e-6 && x.s0 <= b.s1 && x.s1 >= b.s0)[0] ?? boxes[Math.max(0, w - 1)];
        below.z1 = Math.max(below.z1, b.z1);
    }
    return { boxes, lengthM: r3(lengthM), photoHeightM: r3(photoH), scale: r3(k), squareness: r3(sq) };
}

/** How many bodies the boxes make (boxes that overlap or touch, within touchM, are one). */
export function bodiesOf(boxes: OutlineBox[], P = FRONT_PARAMS): number {
    const parent = boxes.map((_, i) => i);
    const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.s0 <= b.s1 + P.touchM && b.s0 <= a.s1 + P.touchM && a.z0 <= b.z1 + P.touchM && b.z0 <= a.z1 + P.touchM) parent[find(i)] = find(j);
    }
    return new Set(boxes.map((_, i) => find(i))).size;
}

/** The family's spec from its front outline: one straight sweep per box through the plan depth, in the tile frame's axes. */
export function frontSpec(input: { family: StreetObjectFamily; boxes: OutlineBox[]; depthM: number; look?: ObjectLook; viewId: string; params?: Partial<typeof FRONT_PARAMS> }): StreetObjectSpec {
    const P = { ...FRONT_PARAMS, ...(input.params ?? {}) };
    const fam = input.family, look = input.look;
    const dir = planAxis(planHeadingOf(fam.members.map(m => m.planHeadingDeg)));
    const n: V2 = [-dir[1], dir[0]];
    const bands = look?.bands?.length ? cleanBands(look.bands) : [];
    const H = fam.heightM;
    const mat = (zMid: number): PartMaterial => {
        const b = bands.find(x => zMid / H >= x.fromT && zMid / H < x.toT) ?? bands[bands.length - 1];
        return b ? { baseColor: b.srgb.map(v => r3(srgbToLinear(v))) as Vec3, roughness: r3(b.roughness), metalness: r3(b.metalness), transmission: 0, ...(b.label ? { description: b.label } : {}) }
            : { baseColor: [0.18, 0.18, 0.18], roughness: 0.6, metalness: 0, transmission: 0, description: 'no colour read (generated mid grey)' };
    };
    const D = Math.max(0.02, input.depthM);
    const parts: ObjectPartSpec[] = input.boxes.slice(0, OBJECT_SPEC_LIMITS.maxParts).map((b, i) => {
        const sm = (b.s0 + b.s1) / 2, zm = (b.z0 + b.z1) / 2;
        const c: Vec3 = [dir[0] * sm, zm, dir[1] * sm];
        return {
            id: `box${i}`, label: `outline box ${i}`, material: mat(zm),
            sweep: {
                controlPoints: [[r3(c[0] - n[0] * D / 2), r3(c[1]), r3(c[2] - n[1] * D / 2)], [r3(c[0] + n[0] * D / 2), r3(c[1]), r3(c[2] + n[1] * D / 2)]], closedLoop: false, smoothing: 0,
                profile: [0, 1].map(t => ({ t, widthMeters: r3(Math.max(0.01, b.s1 - b.s0)), heightMeters: r3(Math.max(0.01, b.z1 - b.z0)), exponent: P.exponent }))
            }
        };
    });
    const sMin = Math.min(...input.boxes.map(b => b.s0)), sMax = Math.max(...input.boxes.map(b => b.s1));
    const ext = [Math.abs(dir[0]) * (sMax - sMin) + Math.abs(n[0]) * D, Math.abs(dir[1]) * (sMax - sMin) + Math.abs(n[1]) * D];
    const provenance: NumberProvenance[] = [
        { field: 'height', label: 'measured', source: 'scan: the members\' tops above their support' },
        { field: 'placement', label: 'measured', source: 'scan: each member\'s plan centre on its support' },
        { field: 'plan depth and heading', label: 'measured', source: `scan: the cluster's plan, ${r3(D)} m deep` },
        { field: 'front outline', label: 'photo-inferred', source: `Street View view ${input.viewId}: its mask's rows cast onto the vertical plane through the scan's long axis, scaled to the scan's height, ${input.boxes.length} boxes` },
        bands.length ? { field: 'materials', label: 'photo-inferred', source: `vision read: ${bands.length} band${bands.length === 1 ? '' : 's'}` } : { field: 'materials', label: 'generated', source: 'mid grey, roughness 0.6', reason: 'no colour was read' }
    ];
    const spec: ObjectBuildSpec = {
        subject: look?.description ?? `street object ${fam.id}`, boundingMeters: [r3(Math.max(0.02, ext[0])), r3(H), r3(Math.max(0.02, ext[1]))],
        expectedBodies: bodiesOf(input.boxes, P), observations: [fam.reason, 'front outline extruded through the plan depth'], parts
    };
    return { spec, operator: 'sweep', operatorReason: `flat or long: the front outline seen square-on (${input.boxes.length} boxes) extruded through the scan's ${r3(D)} m depth`, provenance, placements: fam.members.map(m => ({ clusterId: m.clusterId, foot: m.foot })) };
}
