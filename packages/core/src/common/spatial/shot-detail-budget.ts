/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The screen-space detail budget of a shot: how many pixels a size in metres covers at a point, and how much of a
 * model's geometry is smaller than the shot can show.
 *
 * A shot is a camera described by measurements only (position, target, lens, frame). A triangle whose longest edge
 * covers fewer pixels than the budget (2 by default) in every declared shot adds nothing to the picture; the report
 * says how many there are and which parts hold them, so a build can move that detail to where the lens is.
 * The Python side of the same maths is scratchbox/shot_plan.py (sb.shot).
 */

export type Vec3 = [number, number, number];

/** One camera a scene is built for. Lengths in metres (y up), the lens in millimetres, the frame in pixels. */
export interface ShotCamera {
    name: string;
    position: Vec3;
    target: Vec3;
    focalMm: number;
    sensorWidthMm: number;
    /** Frame width over height. */
    aspect: number;
    widthPx: number;
    /** The smallest size, in pixels, that counts as seen. */
    detailPx: number;
}

export interface ShotBasis { right: Vec3; up: Vec3; forward: Vec3 }

const finitePositive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));

/** The shots a script wrote beside its GLB (shot_plan.py), keeping only the complete ones. */
export function parseShotPlan(json: unknown): ShotCamera[] {
    const list = (json as { shots?: unknown } | null)?.shots;
    if (!Array.isArray(list)) return [];
    const shots: ShotCamera[] = [];
    for (const raw of list as Array<Record<string, unknown>>) {
        if (!raw || !isVec3(raw.position) || !isVec3(raw.target)) continue;
        if (raw.position.every((v, i) => v === (raw.target as Vec3)[i])) continue;
        if (![raw.focalMm, raw.sensorWidthMm, raw.aspect, raw.widthPx, raw.detailPx].every(finitePositive)) continue;
        shots.push({
            name: typeof raw.name === 'string' && raw.name ? raw.name : `shot ${shots.length + 1}`,
            position: raw.position, target: raw.target,
            focalMm: raw.focalMm as number, sensorWidthMm: raw.sensorWidthMm as number, aspect: raw.aspect as number,
            widthPx: Math.round(raw.widthPx as number), detailPx: raw.detailPx as number
        });
    }
    return shots;
}

/** Focal length in pixels: a 1 m object 1 m in front of the lens covers this many pixels. */
export function focalPx(shot: ShotCamera): number {
    return shot.focalMm / shot.sensorWidthMm * shot.widthPx;
}

export function heightPx(shot: ShotCamera): number {
    return Math.max(1, Math.round(shot.widthPx / shot.aspect));
}

export function verticalFovDeg(shot: ShotCamera): number {
    return 2 * Math.atan(shot.sensorWidthMm / shot.aspect / (2 * shot.focalMm)) * 180 / Math.PI;
}

/** The camera's axes; looking straight up or down has no horizon, so the frame's right is then world +x. */
export function shotBasis(shot: ShotCamera): ShotBasis {
    const f: Vec3 = [shot.target[0] - shot.position[0], shot.target[1] - shot.position[1], shot.target[2] - shot.position[2]];
    const n = Math.hypot(f[0], f[1], f[2]);
    const forward: Vec3 = [f[0] / n, f[1] / n, f[2] / n];
    const rn = Math.hypot(forward[2], forward[0]);
    const right: Vec3 = rn > 1e-6 ? [-forward[2] / rn, 0, forward[0] / rn] : [1, 0, 0];
    const up: Vec3 = [
        right[1] * forward[2] - right[2] * forward[1],
        right[2] * forward[0] - right[0] * forward[2],
        right[0] * forward[1] - right[1] * forward[0]
    ];
    return { right, up, forward };
}

/** Pixels a size in metres covers at a point, facing the camera; 0 behind the lens. */
export function projectedPixels(shot: ShotCamera, sizeM: number, at: Vec3, basis: ShotBasis = shotBasis(shot)): number {
    const z = (at[0] - shot.position[0]) * basis.forward[0] + (at[1] - shot.position[1]) * basis.forward[1] + (at[2] - shot.position[2]) * basis.forward[2];
    return z > 1e-6 ? sizeM * focalPx(shot) / z : 0;
}

/** The smallest size the shot resolves at a point, in metres; Infinity behind the lens. */
export function minFeatureM(shot: ShotCamera, at: Vec3, basis: ShotBasis = shotBasis(shot)): number {
    const z = (at[0] - shot.position[0]) * basis.forward[0] + (at[1] - shot.position[1]) * basis.forward[1] + (at[2] - shot.position[2]) * basis.forward[2];
    return z > 1e-6 ? shot.detailPx * z / focalPx(shot) : Infinity;
}

/** A named part of a model: world-space positions (xyz per vertex) and three vertex indices per triangle. */
export interface NamedTriangles {
    name: string;
    positions: ArrayLike<number>;
    indices: ArrayLike<number>;
}

export interface PartDetailBudget {
    name: string;
    triangles: number;
    /** Triangles with a corner inside some shot's frame. */
    inFrame: number;
    /** In-frame triangles whose longest edge is under the budget in every shot that sees them. */
    underBudget: number;
    /** Median, over the in-frame triangles, of the longest edge in pixels in the shot that shows it largest. */
    medianEdgePx: number;
    /** Depth of the part's nearest in-frame corner in front of a lens, in metres. */
    nearestM: number;
}

export interface ShotDetailBudgetReport {
    shots: Array<{ name: string; widthPx: number; heightPx: number; verticalFovDeg: number; detailPx: number }>;
    triangles: number;
    inFrame: number;
    outOfFrame: number;
    underBudget: number;
    /** underBudget / inFrame, 0..1 (0 when nothing is in frame). */
    underBudgetShare: number;
    /**
     * Frame pixels per in-frame triangle, in the first shot (0 when nothing is in frame). A detailed frame spends a few
     * pixels a triangle; tens of pixels a triangle is a frame of plain blocks, whatever share is under budget.
     */
    pixelsPerTriangle: number;
    /** Parts holding the most under-budget triangles, heaviest first. */
    heaviest: PartDetailBudget[];
    parts: PartDetailBudget[];
}

function median(sorted: number[]): number {
    if (!sorted.length) return 0;
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Measures a model against its shots. A triangle is in frame when a corner projects inside some shot's frame; it is
 * under budget when, in every shot that frames it, its longest edge (as drawn, in pixels) is below that shot's budget.
 */
export function evaluateShotDetailBudget(parts: NamedTriangles[], shots: ShotCamera[]): ShotDetailBudgetReport {
    const cams = shots.map(shot => ({ shot, basis: shotBasis(shot), f: focalPx(shot), halfW: shot.widthPx / 2, halfH: heightPx(shot) / 2 }));
    const partReports: PartDetailBudget[] = [];
    const sx = new Float64Array(3), sy = new Float64Array(3);
    for (const part of parts) {
        const P = part.positions, I = part.indices;
        const triangles = Math.floor(I.length / 3);
        let inFrame = 0, underBudget = 0, nearestM = Infinity;
        const edges: number[] = [];
        for (let t = 0; t < triangles; t++) {
            let framed = false, resolved = false, bestPx = 0;
            for (const cam of cams) {
                let visibleCorner = false, allInFront = true;
                for (let k = 0; k < 3; k++) {
                    const o = I[t * 3 + k] * 3;
                    const dx = P[o] - cam.shot.position[0], dy = P[o + 1] - cam.shot.position[1], dz = P[o + 2] - cam.shot.position[2];
                    const z = dx * cam.basis.forward[0] + dy * cam.basis.forward[1] + dz * cam.basis.forward[2];
                    if (z <= 1e-6) { allInFront = false; break; }
                    sx[k] = (dx * cam.basis.right[0] + dy * cam.basis.right[1] + dz * cam.basis.right[2]) * cam.f / z;
                    sy[k] = (dx * cam.basis.up[0] + dy * cam.basis.up[1] + dz * cam.basis.up[2]) * cam.f / z;
                    if (Math.abs(sx[k]) <= cam.halfW && Math.abs(sy[k]) <= cam.halfH) {
                        visibleCorner = true;
                        if (z < nearestM) nearestM = z;
                    }
                }
                // a triangle crossing the lens plane is large in the frame by construction; one wholly outside is not seen
                if (!allInFront || !visibleCorner) continue;
                framed = true;
                const px = Math.max(
                    Math.hypot(sx[0] - sx[1], sy[0] - sy[1]),
                    Math.hypot(sx[1] - sx[2], sy[1] - sy[2]),
                    Math.hypot(sx[2] - sx[0], sy[2] - sy[0]));
                if (px > bestPx) bestPx = px;
                if (px >= cam.shot.detailPx) resolved = true;
            }
            if (!framed) continue;
            inFrame++;
            edges.push(bestPx);
            if (!resolved) underBudget++;
        }
        edges.sort((a, b) => a - b);
        partReports.push({ name: part.name, triangles, inFrame, underBudget, medianEdgePx: median(edges), nearestM: Number.isFinite(nearestM) ? nearestM : 0 });
    }
    const triangles = partReports.reduce((n, p) => n + p.triangles, 0);
    const inFrame = partReports.reduce((n, p) => n + p.inFrame, 0);
    const underBudget = partReports.reduce((n, p) => n + p.underBudget, 0);
    return {
        shots: shots.map(s => ({ name: s.name, widthPx: s.widthPx, heightPx: heightPx(s), verticalFovDeg: verticalFovDeg(s), detailPx: s.detailPx })),
        triangles, inFrame, outOfFrame: triangles - inFrame, underBudget,
        underBudgetShare: inFrame ? underBudget / inFrame : 0,
        pixelsPerTriangle: inFrame && shots.length ? (shots[0].widthPx * heightPx(shots[0])) / inFrame : 0,
        heaviest: partReports.filter(p => p.underBudget > 0).sort((a, b) => b.underBudget - a.underBudget).slice(0, 6),
        parts: partReports
    };
}

/** Share of in-frame triangles under budget above which the build is told to move detail. */
export const UNDER_BUDGET_ADVICE_SHARE = 0.25;
/** Frame pixels per in-frame triangle above which the frame is reported as under-built (a plain block covers thousands). */
export const UNDER_BUILT_PIXELS_PER_TRIANGLE = 16;
/** Share of all triangles outside every shot above which the build is told so. */
export const OUT_OF_FRAME_ADVICE_SHARE = 0.5;

/** What the builder is told about the budget: the measurement, and what to change when detail is being wasted. */
export function describeShotDetailBudget(report: ShotDetailBudgetReport): string {
    if (!report.shots.length || !report.triangles) return '';
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const n = (v: number) => v.toLocaleString('en-US');
    const px = report.shots[0].detailPx;
    const shotNames = report.shots.map(s => `${s.name} (${s.widthPx}x${s.heightPx})`).join(', ');
    let text = `Shot detail budget (${shotNames}): ${n(report.inFrame)} of ${n(report.triangles)} triangles are in frame; `
        + `${n(report.underBudget)} of those (${pct(report.underBudgetShare)}) are under ${px} px on their longest edge.`;
    if (report.underBudgetShare > UNDER_BUDGET_ADVICE_SHARE && report.heaviest.length) {
        text += ` That detail cannot be seen: ${report.heaviest.slice(0, 4).map(p =>
            `${p.name} ${n(p.underBudget)} of ${n(p.inFrame)} (median edge ${p.medianEdgePx.toFixed(1)} px, nearest ${Math.round(p.nearestM)} m)`).join('; ')}. `
            + 'Build those parts coarser (size each detail with shot.min_feature_m(at=...) or skip it when shot.resolves(size, at=...) is false) '
            + 'and spend the triangles on what stands nearest the lens.';
    }
    if (report.pixelsPerTriangle > UNDER_BUILT_PIXELS_PER_TRIANGLE) {
        text += ` The frame is under-built: ${Math.round(report.pixelsPerTriangle)} pixels per in-frame triangle (a detailed frame spends a few). `
            + 'Do not leave a feature out because one of its members is under the budget: ask resolves() about the feature\'s overall size '
            + '(the window opening, the balcony, the tank, the vehicle), then build its thin members at shot.member_m(size, at=...). '
            + 'A recess reads by its opening and the shadow it throws, not by its depth.';
    }
    const outShare = report.outOfFrame / report.triangles;
    if (outShare > OUT_OF_FRAME_ADVICE_SHARE) {
        text += ` ${pct(outShare)} of the triangles are outside every declared shot: declare the other angles the scene must hold up from, or do not build what no shot sees.`;
    }
    return text;
}
