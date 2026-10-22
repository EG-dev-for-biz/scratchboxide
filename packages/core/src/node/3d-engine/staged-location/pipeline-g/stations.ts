/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G, step 1: where the survey cameras stand. The staged survey's own placement (face-survey.ts surveyCandidates /
 * selectSurveyViews, view-match.ts planRingViews), with candidate eyes on the scan's walkable street instead of Street View
 * panos: every face's best eye by the share of it seen over the surface model, its angle off the face normal and its fit to
 * the standoff that frames it, then up to RING_VIEWS more 4 m apart and spread in bearing. A synthetic camera can also rise:
 * each street eye gets a twin at the face's mid-height on the same spot. Every station is then measured from its own depth
 * (a clay render of the tile): kept only when at least MIN_ON_FACE of its frame lies on its face and under MAX_BLOCKED is
 * closer than BLOCKED_M (a camera inside or against a neighbour). Nothing here knows what the structure is.
 */

import { stationFromLookAt } from '../../../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose, GeodeticAnchor } from '../../../../common/spatial/colmap-vector-reference-types';
import { SurveyStationRenderService } from '../../../spatial/SurveyStationRenderService';
import { HeadlessMeshSilhouetteRenderer, type RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import type { GroundModel } from '../../../spatial/StreetViewSurveyPlanner';
import type { StructurePickResult } from '../extraction-sizing';
import { selectSurveyViews, surveyCandidates, type SurveyFaceTarget } from '../face-survey';
import { planRingViews } from '../view-match';
import type { MassingFace } from '../pipeline-e/native-massing';

export type V3 = [number, number, number];

/** Further views per face after its best one (planRingViews). */
export const RING_VIEWS = 4;
/** Candidate eyes on the walkable street, this far apart and within this radius of the structure. */
export const CANDIDATE_STEP_M = 2;
export const CANDIDATE_RADIUS_M = 45;
/** A face is surveyed when it is at least this large. */
export const MIN_FACE_AREA_M2 = 40;
/** Visibility gate from the station's own depth. */
export const MIN_ON_FACE = 0.15;
export const MAX_BLOCKED = 0.05;
export const BLOCKED_M = 1.5;
/** Station optics: a 24 mm lens on full frame, 16:9. */
export const STATION_OPTICS = { focalLengthMm: 24, sensorWidthMm: 36, aspectRatio: 16 / 9 };

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const faceAt = (f: Pick<MassingFace, 'origin' | 'axisS' | 'axisT'>, s: number, t: number): V3 =>
    [f.origin[0] + f.axisS[0] * s + f.axisT[0] * t, f.origin[1] + f.axisS[1] * s + f.axisT[1] * t, f.origin[2] + f.axisS[2] * s + f.axisT[2] * t];

/** A camera pose and depth in the shape stations render to (camera-z depth). */
export interface DepthView { cameraPose: { x: number; y: number; z: number; targetX: number; targetY: number; targetZ: number; up?: V3 }; intrinsics: { verticalFovDegrees: number }; depth: Float32Array }

/** Calls back with the world point, unit ray and range of every pixel with depth. */
export function eachPoint(v: DepthView, w: number, h: number, fn: (i: number, p: V3, ray: V3, range: number) => void): void {
    const pos: V3 = [v.cameraPose.x, v.cameraPose.y, v.cameraPose.z];
    const fwd = norm(sub([v.cameraPose.targetX, v.cameraPose.targetY, v.cameraPose.targetZ], pos));
    const right = norm(cross(fwd, v.cameraPose.up ?? [0, 1, 0])), up = cross(right, fwd);
    const fy = (h / 2) / Math.tan((v.intrinsics.verticalFovDegrees * Math.PI / 180) / 2), fx = fy;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, z = v.depth[i];
        if (!(z < 1e8)) continue;
        const u = (x + 0.5 - w / 2) / fx, q = (y + 0.5 - h / 2) / fy;
        const dir: V3 = [fwd[0] + u * right[0] - q * up[0], fwd[1] + u * right[1] - q * up[1], fwd[2] + u * right[2] - q * up[2]];
        fn(i, [pos[0] + dir[0] * z, pos[1] + dir[1] * z, pos[2] + dir[2] * z], norm(dir), z * Math.hypot(1, u, q));
    }
}

/** Whether a world point lies on face `f` (within `slab` of its plane and inside its s, t extent), with its (s, t, offset). */
export function onFace(f: Pick<MassingFace, 'origin' | 'axisS' | 'axisT' | 'normal' | 'sMin' | 'sMax' | 'tMin' | 'tMax'>, p: V3, back = 1.5, front = 2.0): { s: number; t: number; off: number } | undefined {
    const rel = sub(p, f.origin as V3), off = dot(rel, f.normal as V3);
    if (off < -back || off > front) return undefined;
    const s = dot(rel, f.axisS as V3), t = dot(rel, f.axisT as V3);
    return s < f.sMin || s >= f.sMax || t < f.tMin || t >= f.tMax ? undefined : { s, t, off };
}

export interface GStation { station: ColmapCameraPose; face: number; row: 'street' | 'mid'; distanceM: number; onFace: number }
export interface StationPlan { stations: GStation[]; faces: number[]; candidates: number; skipped: Array<{ face: string; reason: string }>; dropped: Array<{ name: string; onFace: number; blocked: number }> }

/**
 * The stations for `faces` (indices into `allFaces`, walls of the massing run), placed by the staged survey's rules on the
 * walkable street around the structure and kept by their measured view of their face.
 */
export function planStations(opts: {
    allFaces: MassingFace[]; structure: Pick<StructurePickResult, 'cells' | 'groundY' | 'centroid'>; ground: Pick<GroundModel, 'cellIndex' | 'groundAt' | 'top' | 'walkable' | 'open'>;
    tileMesh: RenderMesh3D; anchor: GeodeticAnchor; maxFaces?: number
}): StationPlan {
    const { allFaces, structure, ground } = opts;
    const walls = allFaces.map((f, i) => ({ f, i })).filter(x => x.f.kind === 'wall' && x.f.area >= MIN_FACE_AREA_M2).sort((a, b) => b.f.area - a.f.area).slice(0, opts.maxFaces ?? 6);
    const targets: SurveyFaceTarget[] = walls.map(({ f }) => ({
        faceId: f.key, headingDeg: ((Math.atan2(f.normal[0], -f.normal[2]) * 180 / Math.PI) + 360) % 360, source: 'footprint',
        centre: faceAt(f, (f.sMin + f.sMax) / 2, (f.tMin + f.tMax) / 2), outward: f.normal as V3, widthM: f.sMax - f.sMin, heightM: f.tMax - f.tMin
    }));
    const c = structure.centroid;
    const panos: Array<{ panoId: string; lat: number; lng: number; x: number; z: number }> = [];
    for (let x = c.x - CANDIDATE_RADIUS_M; x <= c.x + CANDIDATE_RADIUS_M; x += CANDIDATE_STEP_M) for (let z = c.z - CANDIDATE_RADIUS_M; z <= c.z + CANDIDATE_RADIUS_M; z += CANDIDATE_STEP_M) {
        const i = ground.cellIndex(x, z);
        if (i < 0 || structure.cells.has(`${Math.floor(x)},${Math.floor(z)}`)) continue;
        if (ground.walkable ? ground.walkable[i] : ground.open[i]) panos.push({ panoId: `g${panos.length}`, lat: 0, lng: 0, x, z });
    }
    const plan = selectSurveyViews(panos, targets, structure, ground, ground.top, targets.length);
    const cands = surveyCandidates(panos, targets, structure, ground, ground.top);
    const ring = planRingViews(targets, cands, { faces: plan.views.map(v => ({ faceId: v.faceId, skipped: false, elements: [] })), read: plan.views.map(v => ({ view: v })) } as never, RING_VIEWS, false);
    const stations: GStation[] = [];
    const dropped: StationPlan['dropped'] = [];
    let id = 1;
    for (const v of [...plan.views, ...ring]) {
        const w = walls.find(x => x.f.key === v.faceId);
        if (!w) continue;
        const f = w.f, h = f.tMax - f.tMin;
        const s = Math.max(f.sMin + 1, Math.min(f.sMax - 1, dot(sub(v.eye as V3, f.origin as V3), f.axisS as V3)));
        const rows: Array<['street' | 'mid', number, number]> = [['street', v.eye[1], f.tMin + Math.min(8, h / 2)], ['mid', f.tMin + h / 2, f.tMin + h / 2]];
        for (const [row, eyeY, lookT] of rows) {
            const eye: V3 = [v.eye[0], eyeY, v.eye[2]];
            const st = stationFromLookAt(id, eye, faceAt(f, s, lookT), STATION_OPTICS, opts.anchor, { name: `G_${w.i}_${row}_${v.panoId}` });
            const seen = probe(opts.tileMesh, st, f);
            if (seen.onFace < MIN_ON_FACE || seen.blocked > MAX_BLOCKED) { dropped.push({ name: st.name, onFace: +seen.onFace.toFixed(3), blocked: +seen.blocked.toFixed(3) }); continue; }
            stations.push({ station: st, face: w.i, row, distanceM: v.distanceM, onFace: +seen.onFace.toFixed(3) });
            id++;
        }
    }
    return { stations, faces: walls.map(x => x.i), candidates: panos.length, skipped: plan.skipped.map(s => ({ face: s.faceId, reason: s.reason })), dropped };
}

/** The share of a station's frame on face `f`, and closer than BLOCKED_M, from a 320 x 180 clay depth of the tile. */
export function probe(mesh: RenderMesh3D, st: ColmapCameraPose, f: MassingFace): { onFace: number; blocked: number } {
    const W = 320, H = 180;
    const { pose, intrinsics } = SurveyStationRenderService.stationToCameraPose6DOF(st, W, H);
    const out = HeadlessMeshSilhouetteRenderer.renderShadedMesh(mesh, pose, W, H, { clipNearPlane: true });
    let on = 0, blocked = 0;
    eachPoint({ cameraPose: pose as DepthView['cameraPose'], intrinsics, depth: out.depthBuffer }, W, H, (_i, p, _ray, range) => {
        if (range < BLOCKED_M) blocked++;
        if (onFace(f, p)) on++;
    });
    return { onFace: on / (W * H), blocked: blocked / (W * H) };
}
