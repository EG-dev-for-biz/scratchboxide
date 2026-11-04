/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects (staged-location/street-objects/) without the network or a model:
 * - families and placements from synthetic audit clusters (a bollard row with a member missing, lamps, a bench, an
 *   uneven line of planters, an artefact);
 * - profiles from synthetic silhouettes: known solids rendered into a pinhole camera by marching each pixel's ray
 *   through the exact solid, then read back (widths, the pose's lateral error, the scan's height scale, a hidden foot,
 *   an off-axis panel, round against flat from two sides);
 * - the spec those measures make, through the spec validator;
 * - the view aim, the read's masks and reply, the keep rule, and the instanced layer GLB;
 * - a melted row (one scan ridge) split into members by the pieces a registered view shows;
 * - a long object's front outline (a bench) read into boxes and built through its depth.
 */

import { describe, expect, it } from 'vitest';
import { memberOf, readPitch, streetObjectFamilies, type MemberCluster } from '../src/node/3d-engine/staged-location/street-objects/families';
import { combineProfiles, heightOnAxis, meridianOf, profileFromSilhouette, type SilhouetteProfile, type ViewSilhouette } from '../src/node/3d-engine/staged-location/street-objects/silhouette-profile';
import { cleanBands, offAxisRuns, planHeadingOf, srgbToLinear, streetObjectSpec } from '../src/node/3d-engine/staged-location/street-objects/object-spec';
import { validateObjectBuildSpec } from '../src/common/spatial/object-build-spec';
import type { FrameCamera } from '../src/node/spatial/StreetViewPoseRegistrar';
import { aimAt } from '../src/node/3d-engine/staged-location/street-objects/see';
import { maskFromReply, parseFamilyReading } from '../src/node/3d-engine/staged-location/street-objects/read';
import { iou, judgeFamily } from '../src/node/3d-engine/staged-location/street-objects/check';
import { instancedLayer } from '../src/node/3d-engine/staged-location/street-objects/run';
import { splitMember } from '../src/node/3d-engine/staged-location/street-objects/split';
import { bodiesOf, frontOutline, frontSpec } from '../src/node/3d-engine/staged-location/street-objects/front-outline';
import { encodePng } from '../src/node/3d-engine/staged-location/png-encode';
import { assembleGlb, parseGlbBytes } from '../src/node/3d-engine/staged-location/glb-bytes';

type V3 = [number, number, number];

// ------------------------------------------------------------------------------------------------ synthetic clusters

/** A cluster standing on the ground at (x, z): an upright of plan L x W (L along headingDeg), height h, optionally round. */
function cluster(id: number, x: number, z: number, h: number, L: number, W: number, opts: { headingDeg?: number; round?: boolean; verdict?: MemberCluster['verdict']; groundY?: number } = {}): MemberCluster {
    const g = opts.groundY ?? 0;
    const hd = ((opts.headingDeg ?? 0) * Math.PI) / 180;
    const xAxis: V3 = [Math.sin(hd), 0, -Math.cos(hd)], zAxis: V3 = [Math.cos(hd), 0, Math.sin(hd)];
    const half = Math.max(L, W) / 2;
    // the frame's origin is off the true centre by a few cm (the blob is lumpy); round clusters carry slice centres on the true one
    const slices = opts.round ? Array.from({ length: 4 }, (_, k) => ({ y: g + 0.1 + k * 0.25, cx: x, cz: z, r: L / 2, rmsRel: 0.05, sectors: 8, size: 20, points: 20 })) : [];
    return {
        id, triangles: 12, lo: [x - half, g, z - half], hi: [x + half, g + h, z + half], verdict: opts.verdict ?? 'real-object',
        frame: { origin: [x + (opts.round ? 0.03 : 0), g, z - (opts.round ? 0.02 : 0)], xAxis, yAxis: [0, 1, 0], zAxis, extentsM: [L, h, W] },
        attachment: { supportY: g, topAboveSupportM: h, baseAboveSupportM: 0 } as MemberCluster['attachment'],
        symmetry: { radialSymmetry: opts.round ? 0.8 : 0.1, radiusMedianM: L / 2, slicesUsed: slices.length, crossSectionConstancy: 0.8, periodicity: 0, periodM: 0 },
        slices
    };
}

/** A small deterministic jitter. */
const jit = (k: number, a: number) => a * Math.sin(k * 12.9898 + 78.233);

describe('street object families (synthetic clusters)', () => {
    const dir: [number, number] = [Math.sin((29 * Math.PI) / 180), -Math.cos((29 * Math.PI) / 180)]; // along 7th Ave: 29 deg east of north
    const lat: [number, number] = [-dir[1], dir[0]];
    const truth: Array<{ id: number; x: number; z: number }> = [];
    const clusters: MemberCluster[] = [];
    for (let k = 0; k < 12; k++) {
        if (k === 7) continue; // a bollard the scan does not have
        const along = k * 1.5 + jit(k, 0.03), off = jit(k + 40, 0.02);
        const x = 10 + dir[0] * along + lat[0] * off, z = 20 + dir[1] * along + lat[1] * off;
        truth.push({ id: 100 + k, x, z });
        clusters.push(cluster(100 + k, x, z, 0.95 + jit(k + 7, 0.03), 0.34, 0.33, { round: true }));
    }
    clusters.push(cluster(200, -5, 0, 8.2, 0.5, 0.5, { round: true }), cluster(201, -5, 25, 8.0, 0.5, 0.45, { round: true }));
    clusters.push(cluster(300, 3, -6, 0.82, 1.9, 0.6, { headingDeg: 119 }));
    clusters.push(cluster(400, 20, -10, 0.9, 1.2, 1.2), cluster(401, 22, -10, 0.92, 1.2, 1.15), cluster(402, 25, -10, 0.88, 1.25, 1.2));
    clusters.push(cluster(500, 0, 5, 3.0, 0.1, 2.0, { verdict: 'scan-artefact' }));
    const fams = streetObjectFamilies(clusters);

    it('finds the bollard row with its members where the scan put them, and its gap', () => {
        const rows = fams.families.filter(f => f.row);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.members).toHaveLength(11);
        expect(row.row!.pitchM).toBeGreaterThan(1.47);
        expect(row.row!.pitchM).toBeLessThan(1.53);
        expect(row.row!.regularity).toBeGreaterThan(0.9);
        expect(row.row!.lateralRmsM).toBeLessThan(0.03);
        // each member at its measured centre (the round clusters' slice centres, not their lumpy frame origin)
        for (const m of row.members) {
            const t = truth.find(q => q.id === m.clusterId)!;
            expect(Math.hypot(m.foot[0] - t.x, m.foot[2] - t.z)).toBeLessThan(0.002);
            expect(m.foot[1]).toBe(0);
        }
        // the gap reported at the missing member's place, nothing added
        expect(row.row!.missing).toHaveLength(1);
        const gone = { x: 10 + dir[0] * 10.5, z: 20 + dir[1] * 10.5 };
        expect(Math.hypot(row.row!.missing[0].at[0] - gone.x, row.row!.missing[0].at[1] - gone.z)).toBeLessThan(0.06);
        expect(row.row!.missing[0].alongM).toBeGreaterThan(10.4);
        expect(row.row!.missing[0].alongM).toBeLessThan(10.6);
        expect(row.heightM).toBeGreaterThan(0.92);
        expect(row.heightM).toBeLessThan(0.98);
    });

    it('keeps lamps far apart, the bench and an uneven line of planters (gaps 2 m and 3 m: no whole-number pitch) as families of one, and skips the artefact', () => {
        const single = fams.families.filter(f => !f.row).map(f => f.members[0].clusterId).sort((a, b) => a - b);
        expect(single).toEqual([200, 201, 300, 400, 401, 402]);
        expect(fams.skipped.map(s => s.clusterId)).toEqual([500]);
        const bench = fams.families.find(f => f.id === 'one/300')!.members[0];
        expect(bench.planHeadingDeg).toBeCloseTo(119, 0);
        expect(bench.planM).toEqual([1.9, 0.6]);
    });

    it('reads a pitch through gaps of whole pitches and breaks at a gap that is not one', () => {
        const p = readPitch([0, 1.5, 3.02, 6.0, 7.49, 11.2]);
        expect(p.pitchM).toBeCloseTo(1.5, 1);
        expect(p.steps.slice(0, 4)).toEqual([1, 1, 2, 1]);
        expect(p.breaks).toEqual([4]);
    });

    it('measures a member from what supports it, not from the lowest scan point', () => {
        const m = memberOf({ ...cluster(9, 0, 0, 1, 0.3, 0.3, { groundY: 2 }), lo: [-0.15, 1.7, -0.15] });
        expect('skip' in m).toBe(false);
        if (!('skip' in m)) { expect(m.foot[1]).toBe(2); expect(m.heightM).toBeCloseTo(1, 6); }
    });
});

// ------------------------------------------------------------------------------------------------ synthetic silhouettes

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };

/** A level-ish pinhole at `eye` looking at `target` with this horizontal field of view. */
function lookAt(eye: V3, target: V3, fovDeg = 20, width = 1024, height = 768): FrameCamera {
    const fwd = unit(sub(target, eye));
    const right = unit(cross(fwd, [0, 1, 0]));
    const up = cross(right, fwd);
    const fx = width / 2 / Math.tan((fovDeg * Math.PI) / 360);
    return { eye, fwd, right, up, fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

/** Inside-test of a solid in world metres. */
type Solid = (p: V3) => boolean;

/** A revolved solid standing at `foot`: radius r(z) for 0 <= z <= h. */
const revolved = (foot: V3, h: number, r: (z: number) => number): Solid => p => { const z = p[1] - foot[1]; return z >= 0 && z <= h && Math.hypot(p[0] - foot[0], p[2] - foot[2]) <= r(z); };
/** An axis-aligned box. */
const box = (lo: V3, hi: V3): Solid => p => p[0] >= lo[0] && p[0] <= hi[0] && p[1] >= lo[1] && p[1] <= hi[1] && p[2] >= lo[2] && p[2] <= hi[2];
const union = (...s: Solid[]): Solid => p => s.some(f => f(p));

/** The mask of `solid` in `cam`: each pixel inside `bounds`' projection marched along its ray through the bounds (2 mm steps). */
function render(cam: FrameCamera, solid: Solid, bounds: { lo: V3; hi: V3 }, hide?: (px: number, py: number) => boolean): ViewSilhouette {
    const mask = new Uint8Array(cam.width * cam.height);
    const corners: V3[] = [];
    for (const x of [bounds.lo[0], bounds.hi[0]]) for (const y of [bounds.lo[1], bounds.hi[1]]) for (const z of [bounds.lo[2], bounds.hi[2]]) corners.push([x, y, z]);
    const proj = corners.map(c => { const d = sub(c, cam.eye); const zc = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2]; return { u: cam.cx + (cam.fx * (d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2])) / zc, v: cam.cy - (cam.fy * (d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2])) / zc, zc }; });
    const u0 = Math.max(0, Math.floor(Math.min(...proj.map(p => p.u))) - 1), u1 = Math.min(cam.width - 1, Math.ceil(Math.max(...proj.map(p => p.u))) + 1);
    const v0 = Math.max(0, Math.floor(Math.min(...proj.map(p => p.v))) - 1), v1 = Math.min(cam.height - 1, Math.ceil(Math.max(...proj.map(p => p.v))) + 1);
    const zmin = Math.min(...proj.map(p => p.zc)) - 0.05, zmax = Math.max(...proj.map(p => p.zc)) + 0.05;
    for (let py = v0; py <= v1; py++) for (let px = u0; px <= u1; px++) {
        if (hide?.(px, py)) continue;
        const xc = (px + 0.5 - cam.cx) / cam.fx, yc = -(py + 0.5 - cam.cy) / cam.fy;
        const d: V3 = [cam.right[0] * xc + cam.up[0] * yc + cam.fwd[0], cam.right[1] * xc + cam.up[1] * yc + cam.fwd[1], cam.right[2] * xc + cam.up[2] * yc + cam.fwd[2]];
        for (let zc = zmin; zc <= zmax; zc += 0.002) {
            if (solid([cam.eye[0] + d[0] * zc, cam.eye[1] + d[1] * zc, cam.eye[2] + d[2] * zc])) { mask[py * cam.width + px] = 1; break; }
        }
    }
    return { mask, width: cam.width, height: cam.height, cam };
}

/** A bollard: a 0.15 m radius shaft to 0.8 m, a dome to 1.0 m. */
const bollardR = (z: number) => (z <= 0.8 ? 0.15 : 0.15 * Math.sqrt(Math.max(0, 1 - ((z - 0.8) / 0.2) ** 2)));
const at = (p: SilhouetteProfile, t: number) => p.samples.reduce((b, s) => (Math.abs(s.t - t) < Math.abs(b.t - t) ? s : b));

describe('profiles from synthetic silhouettes', () => {
    const foot: V3 = [0, 0, 0];
    const bollard = revolved(foot, 1.0, bollardR);
    const bounds = { lo: [-0.2, 0, -0.2] as V3, hi: [0.2, 1.0, 0.2] as V3 };
    const cam = lookAt([0.5, 2.5, 12], [0, 0.5, 0]);

    it('finds the height on the axis where a pixel ray passes it', () => {
        const top = [0, 1, 0] as V3;
        const d = sub(top, cam.eye);
        const zc = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
        const u = cam.cx + (cam.fx * (d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2])) / zc, v = cam.cy - (cam.fy * (d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2])) / zc;
        const h = heightOnAxis(cam, u, v, foot);
        expect(h.z).toBeCloseTo(1, 4);
        expect(h.depth).toBeCloseTo(zc, 4);
    });

    it('reads the radius along the height of a revolved bollard (within 1 cm), from a view 12 m away', () => {
        const p = profileFromSilhouette(render(cam, bollard, bounds), { foot, heightM: 1.0, planM: [0.3, 0.3] });
        expect('failed' in p).toBe(false);
        if ('failed' in p) return;
        expect(p.footVisible).toBe(true);
        expect(p.scale).toBeGreaterThan(0.97);
        expect(p.scale).toBeLessThan(1.03);
        for (const t of [0.1, 0.4, 0.7]) expect(Math.abs(at(p, t).halfWidthM - 0.15)).toBeLessThan(0.01);
        expect(Math.abs(at(p, 0.9).halfWidthM - bollardR(0.9))).toBeLessThan(0.015);
        expect(at(p, 0.99).halfWidthM).toBeLessThan(0.08);
        expect(p.coverage).toBeGreaterThan(0.95);
        expect(p.pixelHeight).toBeGreaterThan(200);
    });

    it('takes up the pose\'s lateral error: the scan\'s axis 0.25 m beside the object', () => {
        const off: V3 = [0.25 * cam.right[0], 0, 0.25 * cam.right[2]];
        const p = profileFromSilhouette(render(cam, bollard, bounds), { foot: off, heightM: 1.0 });
        if ('failed' in p) throw new Error(p.failed);
        expect(p.lateralShiftM).toBeLessThan(-0.2);
        expect(p.lateralShiftM).toBeGreaterThan(-0.3);
        for (const t of [0.1, 0.4, 0.7]) expect(Math.abs(at(p, t).halfWidthM - 0.15)).toBeLessThan(0.015);
    });

    it('keeps the photo\'s shape at the scan\'s height: an object 10% larger than the scan says is scaled back', () => {
        const big = revolved(foot, 1.1, z => 1.1 * bollardR(z / 1.1));
        const p = profileFromSilhouette(render(cam, big, { lo: [-0.2, 0, -0.2], hi: [0.2, 1.1, 0.2] }), { foot, heightM: 1.0 });
        if ('failed' in p) throw new Error(p.failed);
        expect(p.photoHeightM).toBeGreaterThan(1.07);
        expect(p.photoHeightM).toBeLessThan(1.13);
        expect(p.scale).toBeCloseTo(1 / 1.1, 1);
        expect(Math.abs(at(p, 0.4).halfWidthM - 0.15)).toBeLessThan(0.01);
    });

    it('reads a bollard whose foot is hidden (the lower 30% behind something) from the heights it sees, and says so', () => {
        const full = render(cam, bollard, bounds);
        let ys = Infinity, ye = -Infinity;
        for (let i = 0; i < full.mask.length; i++) if (full.mask[i]) { const y = Math.floor(i / full.width); ys = Math.min(ys, y); ye = Math.max(ye, y); }
        const cut = ye - 0.3 * (ye - ys);
        const p = profileFromSilhouette(render(cam, bollard, bounds, (_x, y) => y > cut), { foot, heightM: 1.0 });
        if ('failed' in p) throw new Error(p.failed);
        expect(p.footVisible).toBe(false);
        expect(Number.isNaN(at(p, 0.1).halfWidthM)).toBe(true);
        expect(Math.abs(at(p, 0.6).halfWidthM - 0.15)).toBeLessThan(0.01);
        expect(p.photoHeightM).toBeGreaterThan(0.96);
        expect(p.photoHeightM).toBeLessThan(1.04);
    });

    it('finds a panel standing off a post, at its height and offset', () => {
        // a 4 cm post 2.5 m tall, a 0.6 m panel from the post to 0.6 m to the camera's right, 1.9-2.35 m up
        const cam2 = lookAt([0, 1.8, 10], [0, 1.4, 0]);
        const r = cam2.right;
        const post = revolved(foot, 2.5, () => 0.04);
        const panel: Solid = p => { const s = p[0] * r[0] + p[2] * r[2]; const n = p[0] * cam2.fwd[0] + p[2] * cam2.fwd[2]; return s >= -0.02 && s <= 0.6 && Math.abs(n) <= 0.015 && p[1] >= 1.9 && p[1] <= 2.35; };
        const v = render(cam2, union(post, panel), { lo: [-0.1, 0, -0.1], hi: [0.65, 2.5, 0.1] });
        const p = profileFromSilhouette(v, { foot, heightM: 2.5, planM: [0.1, 0.1] });
        if ('failed' in p) throw new Error(p.failed);
        expect(Math.abs(at(p, 0.3).halfWidthM - 0.04)).toBeLessThan(0.01);
        const c = combineProfiles([p]);
        const runs = offAxisRuns(c, 0.04);
        expect(runs).toHaveLength(1);
        expect(runs[0].fromT * 2.5).toBeGreaterThan(1.83);
        expect(runs[0].toT * 2.5).toBeLessThan(2.42);
        expect(runs[0].offsetM).toBeGreaterThan(0.26);
        expect(runs[0].offsetM).toBeLessThan(0.33);
        expect(runs[0].offsetM + runs[0].halfWidthM).toBeGreaterThan(0.57);
        expect(runs[0].offsetM + runs[0].halfWidthM).toBeLessThan(0.65);
    });

    it('tells a round object from a flat one by the widths two sides show', () => {
        const side1 = lookAt([0, 2.5, 12], [0, 0.5, 0]), side2 = lookAt([12, 2.5, 0], [0, 0.5, 0]);
        const roundViews = [side1, side2].map(c => profileFromSilhouette(render(c, bollard, bounds), { foot, heightM: 1.0 }) as SilhouetteProfile);
        const r = combineProfiles(roundViews);
        expect(r.distinctSides).toBe(2);
        expect(r.viewSpread).toBeLessThan(0.08);
        const planter = box([-0.6, 0, -0.2], [0.6, 0.9, 0.2]);
        const flatViews = [side1, side2].map(c => profileFromSilhouette(render(c, planter, { lo: [-0.6, 0, -0.2], hi: [0.6, 0.9, 0.2] }), { foot, heightM: 0.9, planM: [1.2, 0.4] }) as SilhouetteProfile);
        const f = combineProfiles(flatViews);
        expect(f.viewSpread).toBeGreaterThan(0.6);
    });
});

// ------------------------------------------------------------------------------------------------ the spec

describe('the spec the measures make', () => {
    const foot: V3 = [0, 0, 0];
    const cam = lookAt([0.5, 2.5, 12], [0, 0.5, 0]), cam2 = lookAt([12, 2.5, 1], [0, 0.5, 0]);
    const views = [cam, cam2].map(c => profileFromSilhouette(render(c, revolved(foot, 1.0, bollardR), { lo: [-0.2, 0, -0.2], hi: [0.2, 1.0, 0.2] }), { foot, heightM: 1.0 }) as SilhouetteProfile);
    const prof = combineProfiles(views);
    const family = { id: 'row/1', heightM: 1.0, planM: [0.32, 0.31] as [number, number], reason: '3 alike members', members: [1, 2, 3].map(k => ({ clusterId: k, foot: [k * 1.5, 0, 0] as V3, heightM: 1, planM: [0.32, 0.31] as [number, number], planHeadingDeg: 29, triangles: 10, radialSymmetry: 0.7, radiusMedianM: 0.16 })) };

    it('builds a round family as a revolve through the measured meridian, in colour bands, and the validator accepts it', () => {
        const look = { description: 'a steel bollard with a reflective band', sectionExponent: 2.1, bands: [{ fromT: 0, toT: 0.7, srgb: [60, 60, 62] as [number, number, number], roughness: 0.4, metalness: 0.9 }, { fromT: 0.7, toT: 0.78, srgb: [230, 230, 225] as [number, number, number], roughness: 0.3, metalness: 0 }, { fromT: 0.78, toT: 1, srgb: [62, 61, 63] as [number, number, number], roughness: 0.4, metalness: 0.9 }], confidence: 0.8 };
        const s = streetObjectSpec({ family, profile: prof, look });
        expect(s.operator).toBe('revolve');
        expect(validateObjectBuildSpec(s.spec)).toEqual([]);
        expect(s.spec.parts).toHaveLength(3);
        const m0 = s.spec.parts[0].revolve!.meridian;
        expect(m0[0]).toEqual([0, 0]);
        expect(m0[m0.length - 1][1]).toBe(0);
        expect(Math.abs(m0[1][1] - 0.15)).toBeLessThan(0.012);
        expect(s.spec.parts[1].parentId).toBe('band0');
        expect(s.spec.parts[0].material!.baseColor[0]).toBeCloseTo(srgbToLinear(60), 3);
        expect(s.spec.parts[0].material!.metalness).toBe(0.9);
        expect(s.placements.map(p => p.foot[0])).toEqual([1.5, 3, 4.5]);
        expect(s.provenance.find(p => p.field === 'height')!.label).toBe('measured');
        expect(s.provenance.find(p => p.field === 'profile')!.label).toBe('photo-inferred');
        expect(s.provenance.find(p => p.field === 'materials')!.label).toBe('photo-inferred');
    });

    it('builds a square section as a vertical sweep turned onto the plan heading, and labels a colour it could not read as generated', () => {
        const s = streetObjectSpec({ family, profile: prof, look: { description: 'a square concrete bollard', sectionExponent: 6 } });
        expect(s.operator).toBe('sweep');
        expect(validateObjectBuildSpec(s.spec)).toEqual([]);
        const sw = s.spec.parts[0].sweep!;
        expect(sw.twistDegAlong).toEqual([[0, 61], [1, 61]]);
        expect(sw.profile[0].exponent).toBe(6);
        expect(s.provenance.find(p => p.field === 'materials')!.label).toBe('generated');
    });

    it('merges neighbouring bands of one colour, and averages headings across the 0/180 wrap', () => {
        const b = cleanBands([{ fromT: 0, toT: 0.5, srgb: [100, 100, 100], roughness: 0.5, metalness: 0 }, { fromT: 0.5, toT: 1, srgb: [102, 101, 99], roughness: 0.5, metalness: 0 }]);
        expect(b).toHaveLength(1);
        expect(b[0].toT).toBe(1);
        expect(planHeadingOf([179, 1])).toBeCloseTo(0, 5);
        expect(planHeadingOf([29, 31])).toBeCloseTo(30, 5);
    });

    it('simplifies a meridian to the points that carry its shape', () => {
        const half = Array.from({ length: 48 }, (_, k) => bollardR(((k + 0.5) / 48) * 1.0));
        const m = meridianOf(half, 1.0);
        expect(m.length).toBeLessThan(20);
        expect(m.length).toBeGreaterThan(5);
        expect(m[0]).toEqual([0, 0]);
        expect(m[m.length - 1]).toEqual([1, 0]);
    });
});

// ------------------------------------------------------------------------------------------------ aim, read, check, layer

describe('the view aim, the read\'s masks, the keep rule and the instanced layer', () => {
    it('frames a member so it fills about fillShare of the 1280 px frame, aimed at its mid-height', () => {
        const a = aimAt([0, 2.5, 0], { foot: [0, 0, -10], heightM: 1, planM: [0.3, 0.3] });
        expect(a.headingDeg).toBeCloseTo(0, 5);
        expect(a.pitchDeg).toBeLessThan(-8);
        expect(a.aspectRatio).toBe('RATIO_3X4');
        expect(a.pixelHeight).toBeGreaterThan(0.45 * 1280);
        expect(a.pixelHeight).toBeLessThan(0.65 * 1280);
        const lamp = aimAt([0, 2.5, 0], { foot: [12, 0, 0], heightM: 8, planM: [0.4, 0.4] });
        expect(lamp.headingDeg).toBeCloseTo(90, 5);
        expect(lamp.fovDeg).toBeGreaterThan(40);
    });

    it('decodes a Gemini mask PNG over its box into a full-size mask', () => {
        const w = 40, h = 80, px = new Uint8Array(w * h);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = Math.hypot(x - 19.5, (y - 39.5) / 2) < 15 ? 255 : 0;
        const b64 = encodePng(w, h, px, 1).toString('base64');
        const m = maskFromReply(`data:image/png;base64,${b64}`, [250, 400, 750, 600], 1000, 800);
        expect(m).toBeDefined();
        // the disc covers pi * 15 * 30 / (40 * 80) of the box; the box is 200 x 400 px of the image
        const expected = (Math.PI * 15 * 30) / (40 * 80) * 200 * 400;
        expect(Math.abs(m!.pixels - expected) / expected).toBeLessThan(0.08);
        expect(m!.mask[400 * 1000 + 500]).toBe(1);
        expect(m!.mask[100 * 1000 + 100]).toBe(0);
    });

    it('parses the family read: per-view masks and the look\'s numbers, words kept as labels', () => {
        const b64 = encodePng(4, 4, new Uint8Array(16).fill(255), 1).toString('base64');
        const text = JSON.stringify({
            views: [{ image: 1, visible: true, box_2d: [100, 100, 900, 300], mask: b64, footVisible: true, hiddenShare: 0.1, sameObject: true }, { image: 2, visible: false, sameObject: false }],
            description: 'black steel bollard', permanent: true, sectionExponent: 2.2, sectionAspect: 1, bands: [{ fromT: 0, toT: 1, label: 'painted steel', srgb: [30, 30, 32], roughness: 0.5, metalness: 0.2 }], markings: ['yellow reflective band'], confidence: 0.85
        });
        const r = parseFamilyReading(`\`\`\`json\n${text}\n\`\`\``, [{ width: 100, height: 100 }, { width: 100, height: 100 }]);
        if ('error' in r) throw new Error(r.error);
        expect(r.views[0].maskPixels).toBe(80 * 20);
        expect(r.views[1].visible).toBe(false);
        expect(r.look.sectionExponent).toBe(2.2);
        expect(r.look.bands![0].srgb).toEqual([30, 30, 32]);
        expect(r.look.markings).toEqual(['yellow reflective band']);
        expect(parseFamilyReading('not json', [])).toHaveProperty('error');
    });

    it('keeps a rebuild only when its silhouette beats the scan\'s and its colour is no further', () => {
        const v = (iouRebuild: number, iouScan: number, dR: number, dS: number) => ({ view: 'v', photoPixels: 1000, iouRebuild, iouScan, deltaERebuild: dR, deltaEScan: dS });
        expect(judgeFamily([v(0.8, 0.5, 6, 9), v(0.7, 0.55, 7, 8)]).keep).toBe(true);
        expect(judgeFamily([v(0.4, 0.5, 6, 9)]).keep).toBe(false);
        const c = judgeFamily([v(0.8, 0.5, 20, 9)]);
        expect(c.keep).toBe(false);
        expect(c.reason).toMatch(/colour/);
        expect(judgeFamily([]).keep).toBe(false);
        const a = new Uint8Array([1, 1, 0, 0]), b = new Uint8Array([1, 0, 1, 0]);
        expect(iou(a, b)).toBeCloseTo(1 / 3, 6);
    });

    it('places one family mesh at every member (glTF instancing: a node per member, the mesh shared)', () => {
        const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
        const bin = Buffer.from(pos.buffer);
        const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, children: [1] }, { mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }], buffers: [{ byteLength: bin.length }] };
        const glb = assembleGlb(json, bin);
        const out = instancedLayer([{ glb, feet: [[1, 0, 2], [3, 0, 4], [5, 0, 6]], id: 'row/1', extras: { a: 1 } }, { glb, feet: [[9, 0, 9]], id: 'one/2', extras: {} }]);
        expect(out.subarray(0, 4).toString('ascii')).toBe('glTF');
        const g = parseGlbBytes(out);
        expect(g.json.scenes[0].nodes).toHaveLength(4);
        expect(g.json.meshes).toHaveLength(2);
        expect(g.json.nodes).toHaveLength(4 * 3);
        const roots = g.json.scenes[0].nodes.map((i: number) => g.json.nodes[i]);
        expect(roots.map((n: { translation: number[] }) => n.translation)).toEqual([[1, 0, 2], [3, 0, 4], [5, 0, 6], [9, 0, 9]]);
        // each copy's tree points at its own copied nodes, the meshes are the family's
        const first = g.json.nodes[g.json.scenes[0].nodes[0]];
        expect(g.json.nodes[first.children[0]].mesh).toBe(0);
        expect(g.json.nodes[g.json.nodes[first.children[0]].children[0]].mesh).toBe(0);
        expect(g.json.nodes[g.json.nodes[g.json.scenes[0].nodes[3]].children[0]].mesh).toBe(1);
        expect(g.bin.byteLength).toBeGreaterThanOrEqual(2 * bin.length);
    });
});

describe('a melted row split by what the photos show', () => {
    it('puts each piece where its foot lands on the scan\'s line, and reads their spacing as a row', () => {
        const cam = lookAt([0.3, 2.5, 10], [0, 0.5, 0], 40);
        const xs = [-2, -1, 0, 1, 2];
        const pieces = xs.map(x => render(cam, revolved([x, 0, 0], 1, () => 0.1), { lo: [x - 0.12, 0, -0.12], hi: [x + 0.12, 1, 0.12] }));
        const ridge = { clusterId: 7, foot: [0.05, 0, 0.08] as V3, heightM: 1, planM: [4.4, 0.5] as [number, number], planHeadingDeg: 90, triangles: 40, radialSymmetry: 0, radiusMedianM: 0 };
        const sp = splitMember(ridge, cam, pieces);
        expect(sp).toBeDefined();
        expect(sp!.members).toHaveLength(5);
        sp!.members.forEach((m, i) => {
            expect(Math.abs(m.foot[0] - xs[i])).toBeLessThan(0.06);
            // on the scan's line (its centre's z), not wherever the cast landed
            expect(m.foot[2]).toBeCloseTo(0.08, 6);
            expect(m.piece).toBe(i);
            expect(m.clusterId).toBe(7);
            expect(m.heightM).toBe(1);
            expect(Math.abs(m.planM[0] - 0.2)).toBeLessThan(0.04);
        });
        expect(sp!.row).toBeDefined();
        expect(Math.abs(sp!.row!.pitchM - 1)).toBeLessThan(0.03);
        expect(sp!.reason).toMatch(/5 separate pieces/);
        // one piece is not a split
        expect(splitMember(ridge, cam, pieces.slice(0, 1))).toBeUndefined();
    });
});

describe('a long object\'s front outline', () => {
    it('reads a bench seen square-on as its legs, seat and back, scaled to the scan, and builds it through its depth', () => {
        // a 1.8 m bench along x: legs 0.1 m wide at each end to 0.42 m, a seat 0.42-0.48 m, a back 0.55-0.9 m; 0.5 m deep
        const bench = union(
            box([-0.9, 0, -0.25], [-0.8, 0.42, 0.25]), box([0.8, 0, -0.25], [0.9, 0.42, 0.25]),
            box([-0.9, 0.42, -0.25], [0.9, 0.48, 0.25]), box([-0.9, 0.55, 0.15], [0.9, 0.9, 0.25])
        );
        const cam = lookAt([0.2, 1.6, 7], [0, 0.45, 0], 30);
        const v = render(cam, bench, { lo: [-0.9, 0, -0.25], hi: [0.9, 0.9, 0.25] });
        const member = { foot: [0.04, 0, 0.02] as V3, heightM: 0.9, planM: [1.8, 0.5] as [number, number], planHeadingDeg: 90 };
        const fo = frontOutline(v, member);
        if ('failed' in fo) throw new Error(fo.failed);
        expect(fo.squareness).toBeGreaterThan(0.95);
        expect(Math.abs(fo.lengthM - 1.8)).toBeLessThan(0.08);
        // two legs low down, one full-length run at the seat
        const low = fo.boxes.filter(b => b.z1 <= 0.42);
        expect(low.length).toBeGreaterThanOrEqual(2);
        expect(low.some(b => b.s1 < -0.6) && low.some(b => b.s0 > 0.6)).toBe(true);
        const seat = fo.boxes.find(b => b.z0 <= 0.45 && b.z1 >= 0.45 && b.s1 - b.s0 > 1.6);
        expect(seat).toBeDefined();
        expect(fo.boxes.some(b => b.z1 >= 0.85 && b.s1 - b.s0 > 1.6)).toBe(true);
        const fam = { id: 'one/9', heightM: 0.9, planM: [1.8, 0.5] as [number, number], reason: 'no alike member repeats beside it', members: [{ clusterId: 9, foot: [0, 0, 0] as V3, heightM: 0.9, planM: [1.8, 0.5] as [number, number], planHeadingDeg: 90, triangles: 20, radialSymmetry: 0, radiusMedianM: 0 }] };
        const s = frontSpec({ family: fam, boxes: fo.boxes, depthM: 0.5, look: { description: 'a wooden park bench', bands: [{ fromT: 0, toT: 1, srgb: [110, 80, 50], roughness: 0.7, metalness: 0 }] }, viewId: 'synthetic' });
        expect(validateObjectBuildSpec(s.spec)).toEqual([]);
        expect(s.spec.expectedBodies).toBe(bodiesOf(fo.boxes));
        // each box's carrier runs through the plan depth (z here), its section across the long axis (x)
        const cp = s.spec.parts[0].sweep!.controlPoints;
        expect(Math.abs(cp[1][2] - cp[0][2])).toBeCloseTo(0.5, 3);
        expect(Math.abs(cp[1][0] - cp[0][0])).toBeLessThan(1e-6);
        expect(s.provenance.find(p => p.field === 'front outline')!.label).toBe('photo-inferred');
    });

    it('will not read an outline from a view that sees the object end-on', () => {
        const cam = lookAt([7, 1.6, 0.2], [0, 0.45, 0], 30);
        const v = render(cam, box([-0.9, 0, -0.25], [0.9, 0.9, 0.25]), { lo: [-0.9, 0, -0.25], hi: [0.9, 0.9, 0.25] });
        expect(frontOutline(v, { foot: [0, 0, 0], heightM: 0.9, planM: [1.8, 0.5], planHeadingDeg: 90 })).toHaveProperty('failed');
    });
});
