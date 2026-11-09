/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The drive registration as a step of the Street View pose path (pano-registration-run.ts), after the edge and joint
 * registration: the panoramas tied to each other by learned photo-to-photo matches, moved as one body onto learned matches
 * against the tiles' texture, refined jointly (street-view-drive-registration.ts). It replaces the poses in force only
 * when the path's own held-out fit (heldOutFitOfFrames, scan points of the held-out cells, which the drive's scan matches
 * never use) is better (fitIsBetter), as every other step of the path is judged.
 *
 * Why: the edge and joint registration search a metre and a degree about the box pose; at 7th Ave & W 32nd St (2026-11-09)
 * Google's positions of one drive's panoramas were off by 7-9 m across the avenue (the panoramas' own link graph and
 * headings show a car in the left-turn lane; Google placed them on the other drive's line), beyond that reach. The drive
 * fit moved them into one lane with nothing told about lanes, and their views toward the facades then fitted within 2-3 px.
 *
 * Photos stay in memory: they go to the matcher inline (LearnedFeatureMatcherService).
 */

import type { RenderMesh3D } from '../../spatial/HeadlessMeshSilhouetteRenderer';
import { frameCamera, loadTexturedScene, PLATE_EMPTY_DEPTH, ZERO_CORRECTION, type FrameCamera, type PoseCorrection, type TexturedPrimitive } from '../../spatial/StreetViewPoseRegistrar';
import { renderForMatching } from '../../spatial/StreetViewFeatureRegistrar';
import type { LearnedMatcher, MatchImage, MatchPairRequest } from '../../spatial/LearnedFeatureMatcherService';
import {
    posedCamera, registerDriveOnScan, rotationFromVector, scanResidualsByView, triangulateTies, vectorFromRotation,
    type DrivePano, type DrivePose, type DriveRegistrationOptions, type DriveScanMatch, type DriveTie, type DriveView, type V3
} from '../../spatial/street-view-drive-registration';
import { castCamera } from './survey-casting';
import { downscaleRgba, EDGE_REG_MIN_FOV_DEG, EDGE_RESIDUAL_FLOOR_M, type EdgeRegFrame } from './pano-edge-registration';
import { fitIsBetter, heldOutFitOfFrames, trainCell, type PoseFit } from './pano-joint-registration';
import type { Registration } from './pano-registration';
import { encodePng } from './png-encode';

/** Photos and renders are matched at this width at most (the 7th Ave run: 640 px). */
export const DRIVE_MATCH_WIDTH_PX = 640;
/** A tie is a seen point only when it reprojects within this (px) in both photos and its rays meet at this angle at least (degrees). */
export const SEEN_POINT_MAX_PX = 2;
export const SEEN_POINT_MIN_ANGLE_DEG = 3;

/** A point both photos see, with the two cameras that see it (the poses in force after the step); tile frame. */
export interface SeenPoint { X: V3; eyes: [V3, V3]; panos: [string, string] }

/** Bottom share of each photo left out of the matching (the Street View watermark strip: 32 of 640 px). */
export const DRIVE_IGNORE_BOTTOM = 0.05;
/** A view pair between two panoramas is matched when this share of each one's scan surface is seen by the other. */
export const DRIVE_MIN_COVISIBILITY = 0.15;
/** At most this many view pairs per pair of panoramas, and only panoramas this close (m). */
export const DRIVE_MAX_PAIRS_PER_PANO_PAIR = 10;
export const DRIVE_MAX_PANO_DISTANCE_M = 70;
/** Scan points further than this from the camera are not used to choose pairs (m). */
export const DRIVE_COVIS_MAX_DEPTH_M = 60;

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------------------------------------------------
// Poses <-> the path's corrections
// ---------------------------------------------------------------------------------------------------------------------

/** The rotation (row-major) a correction applies to a pano's nominal camera axes (frameCamera's convention). */
export function correctionRotation(corr: PoseCorrection, referenceHeadingDeg: number): number[] {
    const a = frameCamera([0, 0, 0], 0, 0, 90, 64, 64, ZERO_CORRECTION, 0);
    const b = frameCamera([0, 0, 0], 0, 0, 90, 64, 64, { ...corr, dx: 0, dy: 0, dz: 0 }, corr.referenceHeadingDeg ?? referenceHeadingDeg);
    // R = B A^T with A, B the axis matrices (columns right, up, fwd)
    const A = [a.right, a.up, a.fwd], B = [b.right, b.up, b.fwd];
    const R = new Array(9).fill(0);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) R[i * 3 + j] += B[k][i] * A[k][j];
    return R;
}

/** A pano's drive pose under a correction (eye = stated eye + shift; rotation of its views about the eye). */
export function poseFromCorrection(statedEye: V3, corr: PoseCorrection | undefined, referenceHeadingDeg: number): DrivePose {
    const c = corr ?? ZERO_CORRECTION;
    return { eye: [statedEye[0] + c.dx, statedEye[1] + c.dy, statedEye[2] + c.dz], omega: vectorFromRotation(correctionRotation(c, referenceHeadingDeg)) };
}

/**
 * The correction (rotations stated about heading 0) that puts a pano at a drive pose. frameCamera turns the axes by
 * Ry(-dyaw) Rx(dpitch) Rz(-droll) at reference heading 0 (pitch about east, roll about north): a YXZ decomposition.
 */
export function correctionFromPose(statedEye: V3, pose: DrivePose): PoseCorrection {
    const R = rotationFromVector(pose.omega);
    const b = Math.asin(Math.max(-1, Math.min(1, -R[5])));
    const a = Math.atan2(R[2], R[8]);
    const c = Math.atan2(R[3], R[4]);
    return { dx: pose.eye[0] - statedEye[0], dy: pose.eye[1] - statedEye[1], dz: pose.eye[2] - statedEye[2], dyawDeg: -a / DEG, dpitchDeg: b / DEG, drollDeg: -c / DEG, referenceHeadingDeg: 0 };
}

// ---------------------------------------------------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------------------------------------------------

export interface DriveStepInput {
    frames: EdgeRegFrame[];
    /** GLB files of the full tile mesh, with their photo texture (the scan matches are made against it). */
    meshFiles: string[];
    /** The same mesh, for the held-out fit. */
    mesh: RenderMesh3D;
    /** The registration in force (its corrections are the drive's start). */
    current?: Registration;
    matcher: LearnedMatcher;
    options?: Partial<DriveRegistrationOptions>;
    log?: (m: string) => void;
}

export interface DriveStepPano {
    panoId: string;
    /** Move of the eye from the registration in force, m, and the turn, degrees. */
    moveM: number; turnDeg: number;
    /** Scan matches within 3 px at the start and under the drive poses. */
    scanWithin3px: { start: number; drive: number; of: number };
}

export interface DriveStepResult {
    status: 'accepted' | 'kept-current' | 'skipped';
    reason: string;
    registration?: Registration;
    panos: DriveStepPano[];
    viewPairs: number;
    ties: number;
    tiesUsed: number;
    scanMatches: number;
    fit: { current: PoseFit | null; drive: PoseFit | null };
    /**
     * Points two registered photos both see (ties within SEEN_POINT_MAX_PX, rays at SEEN_POINT_MIN_ANGLE_DEG or more), under
     * the poses in force after the step: what the photos measure of the street (seen-through.ts reads which scan surfaces
     * they look through). Absent when the step skipped.
     */
    seenPoints?: SeenPoint[];
    ms: number;
}

interface Prepared {
    frame: EdgeRegFrame;
    pano: number;
    view: number;
    photo: Buffer;
    render: Buffer;
    cam: FrameCamera;
    depth: Float32Array;
    width: number; height: number;
}

const skipped = (reason: string, t0: number): DriveStepResult => ({ status: 'skipped', reason, panos: [], viewPairs: 0, ties: 0, tiesUsed: 0, scanMatches: 0, fit: { current: null, drive: null }, ms: Date.now() - t0 });

function asFrameCamera(c: ReturnType<typeof posedCamera>): FrameCamera {
    return { eye: c.eye, right: c.right, up: c.up, fwd: c.fwd, fx: c.fx, fy: c.fy, cx: c.cx, cy: c.cy, width: c.width, height: c.height };
}

function rgbaToPng(rgba: Uint8Array | Buffer, w: number, h: number): Buffer {
    return encodePng(w, h, rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba), 4);
}

/** Share of view a's scan surface (depth grid) that view b sees unoccluded. */
export function covisibility(a: { cam: FrameCamera; depth: Float32Array; width: number; height: number }, b: { cam: FrameCamera; depth: Float32Array; width: number; height: number }, ignoreBottomPx: number, maxDepthM = DRIVE_COVIS_MAX_DEPTH_M, stepPx = 16): number {
    let n = 0, vis = 0;
    const ca = a.cam, cb = b.cam;
    for (let y = stepPx / 2; y < a.height - ignoreBottomPx; y += stepPx) for (let x = stepPx / 2; x < a.width; x += stepPx) {
        const z = a.depth[Math.floor(y) * a.width + Math.floor(x)];
        if (!(z > 0) || z >= PLATE_EMPTY_DEPTH * 0.5 || z > maxDepthM) continue;
        n++;
        const xc = (x - ca.cx) / ca.fx * z, yc = (ca.cy - y) / ca.fy * z;
        const X = [0, 1, 2].map(i => ca.eye[i] + ca.right[i] * xc + ca.up[i] * yc + ca.fwd[i] * z);
        const d = [X[0] - cb.eye[0], X[1] - cb.eye[1], X[2] - cb.eye[2]];
        const zb = d[0] * cb.fwd[0] + d[1] * cb.fwd[1] + d[2] * cb.fwd[2];
        if (zb <= 0.1) continue;
        const u = cb.cx + cb.fx * (d[0] * cb.right[0] + d[1] * cb.right[1] + d[2] * cb.right[2]) / zb;
        const v = cb.cy - cb.fy * (d[0] * cb.up[0] + d[1] * cb.up[1] + d[2] * cb.up[2]) / zb;
        if (u < 0 || v < 0 || u >= b.width || v >= b.height - ignoreBottomPx) continue;
        const zz = b.depth[Math.floor(v) * b.width + Math.floor(u)];
        if (Math.abs(zz - zb) <= 0.05 * zb + 0.3) vis++;
    }
    return n ? vis / n : 0;
}

/** Lifts a render pixel to the scan through the render's depth, off depth steps; null where it cannot. */
export function liftThroughDepth(p: { cam: FrameCamera; depth: Float32Array; width: number; height: number }, ur: number, vr: number): V3 | null {
    const x = Math.floor(ur), y = Math.floor(vr), W = p.width;
    if (x < 1 || y < 1 || x >= W - 1 || y >= p.height - 1) return null;
    const z = p.depth[y * W + x];
    if (!(z > 0) || z >= PLATE_EMPTY_DEPTH * 0.5 || z < 2) return null;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const zz = p.depth[(y + j) * W + x + i];
        if (!(Math.abs(zz - z) <= 0.03 * z)) return null;
    }
    const c = p.cam;
    const xc = (ur - c.cx) / c.fx * z, yc = (c.cy - vr) / c.fy * z;
    return [0, 1, 2].map(i => c.eye[i] + c.right[i] * xc + c.up[i] * yc + c.fwd[i] * z) as V3;
}

export async function registerPanosByDrive(input: DriveStepInput): Promise<DriveStepResult> {
    const t0 = Date.now();
    const log = input.log ?? (() => undefined);
    const wide = input.frames.filter(f => f.view.fovDeg >= EDGE_REG_MIN_FOV_DEG);
    const panoIds = [...new Set(wide.map(f => f.view.panoId))];
    if (panoIds.length < 2) return skipped(`needs wide views of at least two panoramas (${panoIds.length})`, t0);
    let prims: TexturedPrimitive[] = [];
    for (const f of input.meshFiles) prims = prims.concat(loadTexturedScene(f));
    if (!prims.some(p => p.rgba)) return skipped('the tile mesh carries no photo texture to match the photos against', t0);

    // panoramas, their nominal views and the start poses
    const refHeading = new Map<string, number>();
    for (const f of wide) if (!refHeading.has(f.view.panoId)) refHeading.set(f.view.panoId, f.view.headingDeg);
    const panos: DrivePano[] = panoIds.map(id => ({ panoId: id, eye: [...wide.find(f => f.view.panoId === id)!.view.eye] as V3, views: [] }));
    const start: DrivePose[] = panos.map(p => poseFromCorrection(p.eye, input.current?.corrections.get(p.panoId), refHeading.get(p.panoId)!));
    const prepared: Prepared[] = [];
    for (const f of wide) {
        const pi = panoIds.indexOf(f.view.panoId);
        const img = downscaleRgba(f.image, DRIVE_MATCH_WIDTH_PX);
        const c0 = castCamera({ eye: panos[pi].eye, headingDeg: f.view.headingDeg, pitchDeg: f.view.pitchDeg, fovDeg: f.view.fovDeg, widthPx: img.width, heightPx: img.height });
        const view: DriveView = { right: c0.right, up: c0.up, fwd: c0.fwd, fx: c0.fx, fy: c0.fy, cx: c0.cx, cy: c0.cy, width: img.width, height: img.height };
        panos[pi].views.push(view);
        const cam = asFrameCamera(posedCamera(view, start[pi]));
        const rd = renderForMatching(prims, cam, {});
        prepared.push({ frame: f, pano: pi, view: panos[pi].views.length - 1, photo: rgbaToPng(img.rgba, img.width, img.height), render: rgbaToPng(rd.rgba, img.width, img.height), cam, depth: rd.depth, width: img.width, height: img.height });
    }
    const ignoreOf = (p: Prepared) => Math.round(p.height * DRIVE_IGNORE_BOTTOM);
    log(`drive registration: ${panos.length} panoramas, ${prepared.length} views rendered from the poses in force`);

    // scan matches: each photo against the tiles' texture rendered from its pose
    const scan: DriveScanMatch[] = [];
    for (let pi = 0; pi < panos.length; pi++) {
        const mine = prepared.filter(p => p.pano === pi);
        const images: MatchImage[] = mine.flatMap((p, k) => [{ id: `p${k}`, bytes: p.photo }, { id: `r${k}`, bytes: p.render }]);
        const res = await input.matcher.match(images, mine.map((_, k) => ({ a: `p${k}`, b: `r${k}` })), { ignoreBottomPx: ignoreOf(mine[0]) });
        res.forEach((r, k) => {
            const p = mine[k];
            for (let q = 0; q < r.pa.length; q++) {
                const X = liftThroughDepth(p, r.pb[q][0], r.pb[q][1]);
                // the held-out cells are the judge's: the drive fits only scan points of the training cells
                if (X && trainCell(X)) scan.push({ pano: pi, view: p.view, u: r.pa[q][0], v: r.pa[q][1], X });
            }
        });
    }

    // ties: photo-to-photo matches between panoramas, on view pairs that see the same scan surface
    const viewPairs: Array<{ a: Prepared; b: Prepared; c: number }> = [];
    for (let i = 0; i < panos.length; i++) for (let j = i + 1; j < panos.length; j++) {
        const ei = start[i].eye, ej = start[j].eye;
        if (Math.hypot(ei[0] - ej[0], ei[2] - ej[2]) > DRIVE_MAX_PANO_DISTANCE_M) continue;
        const cand: Array<{ a: Prepared; b: Prepared; c: number }> = [];
        for (const a of prepared.filter(p => p.pano === i)) for (const b of prepared.filter(p => p.pano === j)) {
            const c = Math.min(covisibility(a, b, ignoreOf(a)), covisibility(b, a, ignoreOf(b)));
            if (c >= DRIVE_MIN_COVISIBILITY) cand.push({ a, b, c });
        }
        cand.sort((x, y) => y.c - x.c);
        const usedA = new Set<number>(), usedB = new Set<number>(); let kept = 0;
        for (const c of cand) {
            if (kept >= DRIVE_MAX_PAIRS_PER_PANO_PAIR) break;
            if (usedA.has(c.a.view) && usedB.has(c.b.view)) continue;
            usedA.add(c.a.view); usedB.add(c.b.view); viewPairs.push(c); kept++;
        }
    }
    const ties: DriveTie[] = [];
    const byPanoPair = new Map<string, typeof viewPairs>();
    for (const vp of viewPairs) { const k = `${vp.a.pano}-${vp.b.pano}`; if (!byPanoPair.has(k)) byPanoPair.set(k, []); byPanoPair.get(k)!.push(vp); }
    for (const group of byPanoPair.values()) {
        const ids = new Map<Prepared, string>();
        const images: MatchImage[] = [];
        for (const vp of group) for (const p of [vp.a, vp.b]) if (!ids.has(p)) { ids.set(p, `v${ids.size}`); images.push({ id: ids.get(p)!, bytes: p.photo }); }
        const k4 = (p: Prepared): [number, number, number, number] => [p.cam.fx, p.cam.fy, p.cam.cx, p.cam.cy];
        const pairs: MatchPairRequest[] = group.map(vp => ({ a: ids.get(vp.a)!, b: ids.get(vp.b)!, essential: { fa: k4(vp.a), fb: k4(vp.b) } }));
        const res = await input.matcher.match(images, pairs, { ignoreBottomPx: ignoreOf(group[0].a) });
        res.forEach((r, k) => {
            const { a, b } = group[k];
            for (let q = 0; q < r.pa.length; q++) ties.push({ a: { pano: a.pano, view: a.view, u: r.pa[q][0], v: r.pa[q][1] }, b: { pano: b.pano, view: b.view, u: r.pb[q][0], v: r.pb[q][1] } });
        });
    }
    log(`drive registration: ${scan.length} scan matches (training cells), ${ties.length} photo-to-photo matches over ${viewPairs.length} view pairs`);
    if (!ties.length) return { ...skipped('no photo-to-photo matches between the panoramas', t0), viewPairs: viewPairs.length, scanMatches: scan.length };
    if (scan.length < 50) return { ...skipped(`too few scan matches (${scan.length})`, t0), viewPairs: viewPairs.length, ties: ties.length };

    // the drive's stated eyes are the start poses: the priors hold it near the registration in force
    const startPanos: DrivePano[] = panos.map((p, i) => ({ ...p, eye: start[i].eye, views: p.views.map(v => {
        const R = rotationFromVector(start[i].omega);
        const rot = (a: V3): V3 => [R[0] * a[0] + R[1] * a[1] + R[2] * a[2], R[3] * a[0] + R[4] * a[1] + R[5] * a[2], R[6] * a[0] + R[7] * a[1] + R[8] * a[2]];
        return { ...v, right: rot(v.right), up: rot(v.up), fwd: rot(v.fwd) };
    }) }));
    const drive = registerDriveOnScan(startPanos, ties, scan, input.options);
    // back to poses about the nominal views: rotation = drive turn x start rotation
    const poses: DrivePose[] = drive.joint.poses.map((p, i) => {
        const R = rotationFromVector(p.omega), S = rotationFromVector(start[i].omega);
        const M = new Array(9).fill(0);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) M[r * 3 + c] += R[r * 3 + k] * S[k * 3 + c];
        return { eye: p.eye, omega: vectorFromRotation(M) };
    });
    const corrections = new Map<string, PoseCorrection>(panos.map((p, i) => [p.panoId, correctionFromPose(p.eye, poses[i])]));
    const currentCorrs = new Map<string, PoseCorrection>(panos.map((p, i) => [p.panoId, input.current?.corrections.get(p.panoId) ?? ZERO_CORRECTION]));

    const byStart = scanResidualsByView(panos, start, scan), byDrive = scanResidualsByView(panos, poses, scan);
    const count = (pv: Array<{ n: number; within: number }>) => pv.reduce((a, v) => a + (v.n ? Math.round(v.within * v.n) : 0), 0);
    const panoOut: DriveStepPano[] = panos.map((p, i) => {
        const d = [0, 1, 2].map(k => poses[i].eye[k] - start[i].eye[k]);
        const S = rotationFromVector(start[i].omega), R = rotationFromVector(poses[i].omega);
        let tr = 0; for (let k = 0; k < 9; k++) tr += S[k] * R[k];
        return {
            panoId: p.panoId, moveM: Math.round(Math.hypot(d[0], d[1], d[2]) * 100) / 100, turnDeg: Math.round(Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) / DEG * 100) / 100,
            scanWithin3px: { start: count(byStart[i]), drive: count(byDrive[i]), of: byStart[i].reduce((a, v) => a + v.n, 0) }
        };
    });

    // judged by the path's own held-out fit, as every step is
    const fitCurrent = heldOutFitOfFrames(input.frames, input.mesh, currentCorrs);
    const fitDrive = heldOutFitOfFrames(input.frames, input.mesh, corrections);
    const base = { panos: panoOut, viewPairs: viewPairs.length, ties: ties.length, tiesUsed: drive.tiesUsed, scanMatches: scan.length, fit: { current: fitCurrent, drive: fitDrive } };
    const f = (x: PoseFit) => `chamfer ${x.chamferPx ?? 'n/a'} px / NCC ${x.gradNcc ?? 'n/a'}`;
    const seenUnder = (ps: DrivePose[]): SeenPoint[] => {
        const out: SeenPoint[] = [];
        triangulateTies(panos, ps, ties, SEEN_POINT_MIN_ANGLE_DEG).forEach((r, k) => {
            if (!r || r.resPx > SEEN_POINT_MAX_PX) return;
            const t = ties[k];
            out.push({ X: r.X, eyes: [ps[t.a.pano].eye, ps[t.b.pano].eye], panos: [panos[t.a.pano].panoId, panos[t.b.pano].panoId] });
        });
        return out;
    };
    if (!fitIsBetter(fitDrive, fitCurrent)) {
        return { status: 'kept-current', reason: `the held-out fit is not better (in force ${f(fitCurrent)}, drive ${f(fitDrive)})`, ...base, seenPoints: seenUnder(start), ms: Date.now() - t0 };
    }
    // the residual each pano's scan matches leave, at their distance (m), as the path reports it
    const perPanoResidualM = panos.map((p, i) => {
        const cams = p.views.map(v => posedCamera(v, poses[i]));
        const r: number[] = [];
        for (const m of scan) if (m.pano === i) {
            const c = cams[m.view]; const d = [m.X[0] - c.eye[0], m.X[1] - c.eye[1], m.X[2] - c.eye[2]];
            const z = d[0] * c.fwd[0] + d[1] * c.fwd[1] + d[2] * c.fwd[2]; if (z <= 0) continue;
            const u = c.cx + c.fx * (d[0] * c.right[0] + d[1] * c.right[1] + d[2] * c.right[2]) / z, v = c.cy - c.fy * (d[0] * c.up[0] + d[1] * c.up[1] + d[2] * c.up[2]) / z;
            const px = Math.hypot(u - m.u, v - m.v); if (px <= 3) r.push(px * z / c.fx);
        }
        r.sort((a, b) => a - b);
        return Math.max(EDGE_RESIDUAL_FLOOR_M, r.length ? r[r.length >> 1] : EDGE_RESIDUAL_FLOOR_M);
    });
    const current: Registration = input.current ?? { corrections: new Map(), perPano: [], setAside: [], pairs: [], beforeRmsM: 0, afterRmsM: 0, used: 0, rejected: 0 };
    const allCorrections = new Map(current.corrections);
    const perPano = current.perPano.map(p => ({ ...p }));
    panos.forEach((p, i) => {
        const c = corrections.get(p.panoId)!;
        allCorrections.set(p.panoId, c);
        const entry = { panoId: p.panoId, dxM: Math.round(c.dx * 1000) / 1000, dzM: Math.round(c.dz * 1000) / 1000, dyawDeg: Math.round(c.dyawDeg * 100) / 100, dpitchDeg: Math.round(c.dpitchDeg * 100) / 100, method: 'drive' as const, edgeResidualM: perPanoResidualM[i] };
        const k = perPano.findIndex(q => q.panoId === p.panoId);
        if (k >= 0) perPano[k] = { ...perPano[k], ...entry }; else perPano.push({ ...entry, pairs: 0, beforeRmsM: NaN, afterRmsM: NaN });
    });
    const ids = new Set(panoIds);
    // the joint registration's warps were fitted to the poses this replaces
    const { warps: _w, ...rest } = current;
    const registration: Registration = { ...rest, corrections: allCorrections, perPano, setAside: current.setAside.filter(s => !ids.has(s.panoId)) };
    return { status: 'accepted', reason: `the held-out fit is better (in force ${f(fitCurrent)}, drive ${f(fitDrive)})`, registration, ...base, seenPoints: seenUnder(poses), ms: Date.now() - t0 };
}

/** The drive step in words for the stage panel. */
export function describeDriveRegistration(r: DriveStepResult): string {
    if (r.status === 'skipped') return `drive registration skipped: ${r.reason}`;
    const per = r.panos.map(p => `${p.panoId.slice(0, 6)}: moved ${p.moveM} m, turned ${p.turnDeg} deg, scan matches within 3 px ${p.scanWithin3px.start} -> ${p.scanWithin3px.drive} of ${p.scanWithin3px.of}`).join('; ');
    return `drive registration of ${r.panos.length} panoramas (${r.ties} photo-to-photo matches over ${r.viewPairs} view pairs, ${r.scanMatches} scan matches) in ${(r.ms / 1000).toFixed(1)} s: ${r.status === 'accepted' ? 'kept' : 'not kept'}, ${r.reason}. Per pano ${per}`;
}
