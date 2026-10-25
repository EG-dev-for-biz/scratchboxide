/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Snaps a noisy footprint ring's edges toward right angles (optionally also 45 degrees) around its own dominant
 * direction, found from a length-weighted histogram of its edge azimuths. Reimplemented (not transliterated) from the
 * geometric idea in DPIRD-DMA/Building-Regulariser (MIT): find the building's real orientation from its longest, most
 * common edge directions, snap every edge to the nearest allowed offset from it, re-intersect perpendicular neighbours
 * and merge-or-bridge parallel ones, then iterate a short angle-enforcement pass to clean up what reconnection perturbed.
 *
 * This is a `measured` -> `vector-modelled` fill (AGENTS.md §4 "Believability first, honestly labelled"): a scan- or
 * hull-derived footprint keeps the real polygon's size, position and dominant orientation (what's known), while this
 * straightens the wobble a real building's actual right angles wouldn't have (what a believable fill covers). Callers
 * must label the result's provenance `vector-modelled` (or similar), never claim it is `measured`, and must not use
 * this on a tool whose whole job is to report ground truth as the direct answer (AGENTS.md §4's "still real-data only,
 * no filling" list: location_building_shape, location_isolate_structure, location_split_block, location_residual_audit,
 * streetview_survey, photo_match_evaluate) -- only on a footprint already on its way into a displayed build.
 *
 * All parameters are continuous; nothing here branches on a building type or category.
 */

import type { Vec2 } from './staged-location-contracts';

export interface RegularizeFootprintOptions {
    /** Distance (m) under which two parallel edges snap together into one instead of getting a short bridge segment. */
    parallelThresholdM?: number;
    /** Allow edges at 45 degrees from the dominant direction, not just 0/90. */
    allow45?: boolean;
    /** Degrees subtracted from the 45-degree snap zone's half-width, making diagonal edges less likely to be chosen. */
    diagonalThresholdReductionDeg?: number;
    /** Degrees of tolerance before the angle-enforcement pass bothers rotating a vertex. */
    angleToleranceDeg?: number;
    /** Passes of the angle-enforcement cleanup (reconnection can perturb a neighbour's angle by a little). */
    maxIterations?: number;
    /**
     * How far a perpendicular-neighbour line intersection may land from the original (pre-rotation) shared vertex,
     * as a multiple of the longer of the two edges meeting there. A near-parallel pair misclassified as perpendicular
     * (common on a dense stairstep outline) gives a poorly-conditioned intersection that can land tens of metres from
     * the real corner, slicing a stray edge across the ring; past this multiple the corner falls back to the midpoint
     * of the two edges' own (already-rotated) endpoints instead.
     */
    maxCornerShiftFactor?: number;
}

export interface RegularizeFootprintResult {
    /** The regularized ring, open (no duplicated closing point), same winding as the input. */
    ring: Vec2[];
    /** The dominant direction found (degrees, 0-90, the ring's edges' azimuth mod 90, length-weighted). */
    mainDirectionDeg: number;
}

const DEFAULTS: Required<RegularizeFootprintOptions> = {
    parallelThresholdM: 1.0,
    allow45: false,
    diagonalThresholdReductionDeg: 5,
    angleToleranceDeg: 0.1,
    maxIterations: 2,
    maxCornerShiftFactor: 4
};

function hypot(dx: number, dy: number): number { return Math.sqrt(dx * dx + dy * dy); }

function azimuthDeg(a: Vec2, b: Vec2): number {
    return (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI + 360) % 360;
}

/** Shortest signed difference target - source, in (-180, 180]. */
function angleDiff(target: number, source: number): number {
    return ((target - source + 180) % 360 + 360) % 360 - 180;
}

function smoothHistogram(hist: Float64Array): Float64Array {
    const out = new Float64Array(hist.length);
    for (let i = 1; i < hist.length - 1; i++) out[i] = (2 * hist[i] + hist[i - 1] + hist[i + 1]) / 4;
    out[0] = (2 * hist[0] + hist[1]) / 3;
    out[hist.length - 1] = (2 * hist[hist.length - 1] + hist[hist.length - 2]) / 3;
    return out;
}

/** The bin index maximizing hist[i] averaged with its mirror (hist reversed), tie-broken toward the larger raw bin. */
function bestSymmetricBin(hist: Float64Array): number {
    let bestI = 0, bestV = -Infinity;
    for (let i = 0; i < hist.length; i++) {
        const mirrored = (hist[i] + hist[hist.length - 1 - i]) / 2;
        if (mirrored > bestV || (mirrored === bestV && hist[i] > hist[bestI])) { bestV = mirrored; bestI = i; }
    }
    return bestI;
}

/** The dominant edge direction (degrees, 0-90) of an open ring, weighted by edge length; coarse-then-fine histogram. */
export function findMainDirection(ring: Vec2[], coarseBinDeg = 5, fineBinDeg = 1): number {
    const n = ring.length;
    if (n < 3) return 0;
    const angles: number[] = [], lengths: number[] = [];
    for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        const len = hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-9) continue;
        angles.push(((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI) % 180 + 180) % 180 % 90);
        lengths.push(len);
    }
    if (!angles.length) return 0;
    const coarseBins = new Float64Array(Math.round(90 / coarseBinDeg));
    for (let i = 0; i < angles.length; i++) coarseBins[Math.min(Math.floor(angles[i] / coarseBinDeg), coarseBins.length - 1)] += lengths[i];
    if (coarseBins.reduce((s, v) => s + v, 0) === 0) return 0;
    const coarseSmoothed = smoothHistogram(coarseBins);
    const mainBin = bestSymmetricBin(coarseSmoothed);
    const fineStart = mainBin * coarseBinDeg, fineEnd = fineStart + coarseBinDeg;
    const fineBins = new Float64Array(90);
    for (let i = 0; i < angles.length; i++) fineBins[Math.min(Math.floor(angles[i] / fineBinDeg), 89)] += lengths[i];
    const fineSmoothed = smoothHistogram(fineBins);
    const window = fineSmoothed.slice(fineStart, fineEnd);
    const refinedBin = bestSymmetricBin(window);
    const center = fineStart + refinedBin + fineBinDeg / 2;
    if (refinedBin === 0) return Math.floor(center);
    if (refinedBin === fineEnd - fineStart - 1) return Math.ceil(center);
    return fineSmoothed[fineStart + refinedBin + 1] > fineSmoothed[fineStart + refinedBin - 1] ? Math.ceil(center) : Math.floor(center);
}

/**
 * Whether `diffAngle` is closer to 0/180 (parallel or anti-parallel) than to 90/-90 (perpendicular). Checking only
 * `abs(diffAngle) < 45` (as the library this was reimplemented from does) misses genuinely anti-parallel edges near
 * +-180 degrees, which a closed ring's opposite sides always have, misclassifying them as perpendicular.
 */
function closerToParallelThanPerpendicular(diffAngle: number): boolean {
    const mod180 = ((diffAngle % 180) + 180) % 180;
    const distTo0 = Math.min(mod180, 180 - mod180);
    const distTo90 = Math.abs(mod180 - 90);
    return distTo0 <= distTo90;
}

/** orientationCode: 0 parallel/anti-parallel to mainDirection, 1 perpendicular, 2/3 diagonal (45-family, allow45 only). */
function orientationAndRotation(diffAngle: number, mainDirectionDeg: number, azimuth: number, allow45: boolean, diagonalReductionDeg: number): { orientationCode: number; rotationDeg: number } {
    let targetOffset = 0, orientationCode = 0;
    if (allow45) {
        const mod180 = ((diffAngle % 180) + 180) % 180;
        const distTo45 = Math.min(Math.abs(mod180 - 45), Math.abs(mod180 - 135));
        if (distTo45 <= 22.5 - diagonalReductionDeg) {
            const angleMod = ((diffAngle % 90) + 90) % 90;
            targetOffset = angleMod < 45 ? Math.floor(diffAngle / 90) * 90 + 45 : Math.floor(diffAngle / 90 + 1) * 90 - 45;
            const normalized = ((mainDirectionDeg + targetOffset) % 180 + 180) % 180;
            orientationCode = normalized < 90 ? 2 : 3;
        } else {
            if (closerToParallelThanPerpendicular(diffAngle)) {
                targetOffset = Math.round(diffAngle / 180) * 180;
                orientationCode = 0;
            } else {
                targetOffset = Math.round(diffAngle / 90) * 90;
                if (Math.abs(((targetOffset % 180) + 180) % 180) < 1e-9) targetOffset = diffAngle > 0 ? 90 : -90;
                orientationCode = 1;
            }
        }
    } else if (closerToParallelThanPerpendicular(diffAngle)) {
        targetOffset = Math.round(diffAngle / 180) * 180;
        orientationCode = 0;
    } else {
        targetOffset = Math.round(diffAngle / 90) * 90;
        if (Math.abs(((targetOffset % 180) + 180) % 180) < 1e-9) targetOffset = diffAngle > 0 ? 90 : -90;
        orientationCode = 1;
    }
    const rotationDeg = ((mainDirectionDeg + targetOffset - azimuth + 180) % 360 + 360) % 360 - 180;
    return { orientationCode, rotationDeg };
}

function rotateAbout(p: Vec2, center: Vec2, deg: number): Vec2 {
    const rad = deg * Math.PI / 180, dx = p[0] - center[0], dy = p[1] - center[1];
    const c = Math.cos(rad), s = Math.sin(rad);
    return [center[0] + dx * c - dy * s, center[1] + dx * s + dy * c];
}

/** Line through two points as (A, B, C) with Ax + By + C = 0. */
function lineEq(p: Vec2, q: Vec2): [number, number, number] {
    const A = p[1] - q[1], B = q[0] - p[0];
    return [A, B, -(p[0] * q[1] - q[0] * p[1])];
}

function lineIntersect(l1: [number, number, number], l2: [number, number, number]): Vec2 | null {
    const d = l1[0] * l2[1] - l1[1] * l2[0];
    if (Math.abs(d) < 1e-12) return null;
    return [(l1[2] * l2[1] - l1[1] * l2[2]) / -d, (l1[0] * l2[2] - l1[2] * l2[0]) / -d];
}

function projectOnto(p: Vec2, a: Vec2, b: Vec2): Vec2 {
    const dx = b[0] - a[0], dy = b[1] - a[1], denom = dx * dx + dy * dy || 1e-10;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denom;
    return [a[0] + t * dx, a[1] + t * dy];
}

function parallelLineDistance(l1: [number, number, number], l2: [number, number, number]): number {
    const eps = 1e-10;
    const nA2 = 1, nB2 = l2[1] / (l2[0] + eps), nC2 = l2[2] / (l2[0] + eps);
    const nC1 = l1[2] / (l1[0] + eps);
    return Math.abs(nC1 - nC2) / Math.sqrt(nA2 * nA2 + nB2 * nB2);
}

/**
 * Snaps `ring`'s edges to its own dominant direction (0/90, optionally also 45), re-intersecting or merging/bridging
 * neighbours as needed, then cleans up remaining angle drift. `ring` is open (no duplicated closing point); the result
 * is too. Degenerate input (fewer than 3 usable points, or a result that collapses) is returned unchanged with
 * `mainDirectionDeg: 0` rather than thrown -- callers decide whether to fall back to the raw hull.
 */
export function regularizeFootprint(ring: Vec2[], opts: RegularizeFootprintOptions = {}): RegularizeFootprintResult {
    const o = { ...DEFAULTS, ...opts };
    const pts = ring.filter((p, i) => i === 0 || hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]) > 1e-7);
    if (pts.length > 1 && hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-7) pts.pop();
    if (pts.length < 3) return { ring, mainDirectionDeg: 0 };

    const mainDirectionDeg = findMainDirection(pts);
    const n = pts.length;

    // orient each edge: rotate it about its own midpoint onto the nearest allowed azimuth
    const orientedEdges: Array<[Vec2, Vec2]> = [];
    const orientationCodes: number[] = [];
    for (let i = 0; i < n; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        if (hypot(b[0] - a[0], b[1] - a[1]) < 1e-9) { orientedEdges.push([a, b]); orientationCodes.push(0); continue; }
        const azimuth = azimuthDeg(a, b);
        const diffAngle = angleDiff(azimuth, mainDirectionDeg);
        const { orientationCode, rotationDeg } = orientationAndRotation(diffAngle, mainDirectionDeg, azimuth, o.allow45, o.diagonalThresholdReductionDeg);
        const mid: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        orientedEdges.push(rotationDeg === 0 ? [a, b] : [rotateAbout(a, mid, rotationDeg), rotateAbout(b, mid, rotationDeg)]);
        orientationCodes.push(orientationCode);
    }

    // reconnect: perpendicular neighbours meet at their line intersection; parallel neighbours merge or get a short bridge
    const connected: Vec2[] = [];
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [curA, curB] = orientedEdges[i];
        let [nextA, nextB] = orientedEdges[j];
        if (orientationCodes[i] !== orientationCodes[j]) {
            const p = lineIntersect(lineEq(curA, curB), lineEq(nextA, nextB));
            const origCorner = pts[j];
            const localScale = Math.max(hypot(curB[0] - curA[0], curB[1] - curA[1]), hypot(nextB[0] - nextA[0], nextB[1] - nextA[1]), 1e-6);
            const bridge: Vec2 = [(curB[0] + nextA[0]) / 2, (curB[1] + nextA[1]) / 2];
            connected.push(p && hypot(p[0] - origCorner[0], p[1] - origCorner[1]) <= o.maxCornerShiftFactor * localScale ? p : bridge);
        } else {
            const l1 = lineEq(curA, curB), l2 = lineEq(nextA, nextB);
            if (parallelLineDistance(l1, l2) < o.parallelThresholdM) {
                const projA = projectOnto(nextA, curA, curB), projB = projectOnto(nextB, curA, curB);
                connected.push(projA);
                orientedEdges[j] = [projA, projB];
            } else {
                const midpoint: Vec2 = [(curB[0] + nextA[0]) / 2, (curB[1] + nextA[1]) / 2];
                connected.push(projectOnto(midpoint, curA, curB), projectOnto(midpoint, nextA, nextB));
            }
        }
    }
    if (connected.length < 3) return { ring, mainDirectionDeg: 0 };

    // angle-enforcement cleanup: reconnecting one corner can nudge its neighbour's angle slightly off-target
    let working = connected;
    for (let iter = 0; iter < o.maxIterations; iter++) {
        let changed = false;
        const m = working.length;
        for (let i = 0; i < m; i++) {
            const j = (i + 1) % m;
            const p1 = working[i], p2 = working[j];
            if (hypot(p2[0] - p1[0], p2[1] - p1[1]) < 1e-7) continue;
            const azimuth = azimuthDeg(p1, p2);
            const diffAngle = angleDiff(azimuth, mainDirectionDeg);
            const { rotationDeg } = orientationAndRotation(diffAngle, mainDirectionDeg, azimuth, o.allow45, o.diagonalThresholdReductionDeg);
            if (Math.abs(rotationDeg) > o.angleToleranceDeg) { working[j] = rotateAbout(p2, p1, rotationDeg); changed = true; }
        }
        if (!changed) break;
    }
    if (working.length < 3) return { ring, mainDirectionDeg: 0 };
    return { ring: working, mainDirectionDeg };
}
