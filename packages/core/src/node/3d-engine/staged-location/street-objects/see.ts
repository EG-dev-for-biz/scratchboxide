/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects, step 2 (see): which Street View captures look at each family's members clear, and the views to ask the
 * grounding API for.
 *
 * - Candidates: the Google panoramas within reach of a member (found on the free metadata endpoint around the families).
 * - Clear: seen from the pano's nominal eye (2.5 m over the street), the share of the member's own scan points that lie in
 *   front of the rest of the scan (the full tile mesh, trees included: they block a photo too). Free: no image is asked
 *   for a view the scan says is blocked.
 * - Aim: the heading to the member's axis, the elevation to its mid-height, and a field of view that makes it fill
 *   `fillShare` of the image's height (the grounding frame is 1280 px tall at any aspect; the requested fov is over its
 *   1920 px width), a portrait crop for a tall object.
 * - Choice per family: its members with the best views (nearest, clearest, largest in the frame), the best view of each,
 *   then the best view from another side (at least sideSeparationDeg around the object), at most viewsPerFamily; the
 *   district's images are capped at maxImages, families in order of how much of the street they take up.
 * - Registration: each pano used also gets one wide level view toward its first object (the registration poses the pano
 *   against the tile mesh from it; the narrow views share its pose).
 *
 * Images are not fetched here: this plans the requests (streetview-evidence.ts `fetchViews` asks for them, in memory).
 */

import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import { groundingFocalPx, projectToFrame, renderFrameDepth } from '../../../spatial/StreetViewPoseRegistrar';
import type { GroundingAspectRatio } from '../../../spatial/StreetViewGroundingImageService';
import { castCamera } from '../survey-casting';
import { bearingDeg, STREET_VIEW_EYE_HEIGHT_M, type PanoCandidate, type SelectedView } from '../streetview-evidence';
import type { StreetObjectFamily, StreetObjectMember, V3 } from './families';

export const SEE_PARAMS = {
    minRangeM: 3,
    maxRangeM: 25,
    /** The object fills about this share of the image's height. */
    fillShare: 0.55,
    minFovDeg: 10,
    maxFovDeg: 80,
    /** A member at least this many times taller than wide is framed in a portrait (3:4) crop. */
    portraitAspect: 1.3,
    membersPerFamily: 2,
    viewsPerFamily: 3,
    sideSeparationDeg: 45,
    /** A view counts when at least this share of the member's scan points stands in front of the rest of the scan. */
    minClearShare: 0.6,
    /** A point counts as in front when its depth is within this of the scan's depth at its pixel. */
    depthTolM: 0.15,
    /** And when the member spans at least this many pixels of the frame's height. */
    minPixelHeight: 80,
    /** The depth image the clear check renders (pixels wide). */
    depthWidthPx: 320,
    /** Each member's clear check looks from its nearest this many panos in range (each check renders the tile's depth). */
    candidatePanos: 8,
    /** The district's images. Raised from 160 on 2026-11-08: at Penn the 160 reached 3 of 4 families' clusters' turn
     * at most (369 clusters past the budget), and about half went to registration views. */
    maxImages: 400,
    /** A view from a pano already registered costs one image, not two (no new wide view): its score is worth this much more. */
    reusedPanoBonus: 1.5,
    /** The wide view each pano is registered from. */
    contextFovDeg: 90
};
export type SeeParams = typeof SEE_PARAMS;

/** Where a view's camera stands: a pano's position at the eye height over the street. */
export function panoEye(p: PanoCandidate, groundAt: (x: number, z: number) => number): V3 {
    const g = groundAt(p.x, p.z);
    return [p.x, (Number.isFinite(g) ? g : 0) + STREET_VIEW_EYE_HEIGHT_M, p.z];
}

const DEG = Math.PI / 180;
const r1 = (v: number) => Math.round(v * 10) / 10;

export interface PlannedView extends SelectedView {
    familyId: string;
    clusterId: number;
    /** Plan distance from the eye to the member's axis, and the pixels its height spans in the delivered frame. */
    rangeM: number;
    pixelHeight: number;
    /** Share of the member's scan points the scan says the view sees. */
    clearShare: number;
    /** The heading from the object toward the camera (which side of it the view shows). */
    sideDeg: number;
    /** A wide view of the pano for its registration (no object read from it). */
    context?: boolean;
}

/** The aim, field of view and crop that frame a member from an eye. */
export function aimAt(eye: V3, m: Pick<StreetObjectMember, 'foot' | 'heightM' | 'planM'>, P: SeeParams = SEE_PARAMS): { headingDeg: number; pitchDeg: number; fovDeg: number; aspectRatio: GroundingAspectRatio; rangeM: number; pixelHeight: number } {
    const dx = m.foot[0] - eye[0], dz = m.foot[2] - eye[2];
    const d = Math.max(0.5, Math.hypot(dx, dz));
    const headingDeg = ((Math.atan2(dx, -dz) / DEG) % 360 + 360) % 360;
    const a0 = Math.atan2(m.foot[1] - eye[1], d), a1 = Math.atan2(m.foot[1] + m.heightM - eye[1], d);
    const pitchDeg = ((a0 + a1) / 2) / DEG;
    const span = a1 - a0;
    // vertical half-angle of the frame: atan(640 / fx), fx = 960 / tan(fov / 2) at the 1280 px frame height
    const halfV = Math.min(Math.PI / 2 - 0.01, span / (2 * P.fillShare));
    const fovDeg = Math.max(P.minFovDeg, Math.min(P.maxFovDeg, (2 * Math.atan((960 / 640) * Math.tan(halfV))) / DEG));
    const portrait = m.heightM >= P.portraitAspect * Math.max(m.planM[0], m.planM[1], 0.05);
    const aspectRatio: GroundingAspectRatio = portrait ? 'RATIO_3X4' : 'RATIO_4X3';
    const [w, h] = portrait ? [960, 1280] : [1707, 1280];
    const fx = groundingFocalPx(fovDeg, w, h);
    const pixelHeight = fx * (Math.tan(a1 - pitchDeg * DEG) - Math.tan(a0 - pitchDeg * DEG));
    return { headingDeg: r1(headingDeg), pitchDeg: r1(pitchDeg), fovDeg: r1(fovDeg), aspectRatio, rangeM: Math.round(d * 100) / 100, pixelHeight: Math.round(pixelHeight) };
}

/**
 * The share of `member`'s visible surface the scan says a camera sees. The member's own triangles (`memberTriangles`:
 * x, y, z per corner, three corners a triangle) are drawn into a depth image, and so is the tile mesh; a pixel of the
 * member counts as seen when nothing in the tile stands in front of the member's nearest surface there (within depthTolM).
 * Only the member's near side is tested: its far side is hidden by the member itself, not by anything in front of it
 * (testing every corner, as before 2026-11-08, capped any object deeper than depthTolM at about half seen, so most of a
 * district's street clusters were planned as blocked).
 */
export function clearShare(eye: V3, aim: { headingDeg: number; pitchDeg: number; fovDeg: number }, memberTriangles: Float32Array, tileMesh: RenderMesh3D, P: SeeParams = SEE_PARAMS): number {
    const W = P.depthWidthPx, H = Math.round((W * 3) / 4);
    const cam = castCamera({ eye, headingDeg: aim.headingDeg, pitchDeg: aim.pitchDeg, fovDeg: aim.fovDeg, widthPx: W, heightPx: H });
    const depth = renderFrameDepth(tileMesh, cam);
    const n = Math.floor(memberTriangles.length / 9) * 3;
    const own = renderFrameDepth({ vertices: memberTriangles.subarray(0, n * 3), indices: Uint32Array.from({ length: n }, (_, i) => i) }, cam);
    let seen = 0, px = 0;
    for (let i = 0; i < own.length; i++) {
        const dm = own[i];
        if (!(dm < 1e8)) continue;
        px++;
        const dz = depth[i];
        if (!(dz < 1e8) || dm <= dz + P.depthTolM) seen++;
    }
    if (px) return seen / px;
    // the member covers no pixel (smaller than one at this range): its corners, each against the tile's depth
    let s = 0, k = 0;
    for (let i = 0; i + 2 < n * 3; i += 3) {
        const p = projectToFrame(cam, memberTriangles, i);
        if (!p || p[0] < 0 || p[1] < 0 || p[0] >= W || p[1] >= H) continue;
        k++;
        const dz = depth[Math.floor(p[1]) * W + Math.floor(p[0])];
        if (!(dz < 1e8) || p[2] <= dz + P.depthTolM) s++;
    }
    return k ? s / k : 0;
}

const angleBetween = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

export interface FamilyViewPlan {
    familyId: string;
    views: PlannedView[];
    /** Why the family got fewer views than it could, or none. */
    notes: string[];
    /** Candidate views the scan judged blocked (not asked for). */
    blocked: number;
}

export interface ViewPlan {
    families: FamilyViewPlan[];
    /** One wide view per pano used, for its registration. */
    context: PlannedView[];
    images: number;
    /** Families left without a view because the district's image budget ran out. */
    overBudget: string[];
}

/**
 * The views of every family: members and sides chosen as above, the district's budget spent on the families that take
 * up the most of the street first (height times plan, times members).
 */
export function planFamilyViews(input: {
    families: StreetObjectFamily[]; panos: PanoCandidate[]; groundAt: (x: number, z: number) => number; tileMesh: RenderMesh3D;
    /** Each member's scan points (x, y, z triples), by cluster id. */
    memberPoints: Map<number, Float32Array>; params?: Partial<SeeParams>;
}): ViewPlan {
    const P = { ...SEE_PARAMS, ...(input.params ?? {}) };
    const size = (f: StreetObjectFamily) => f.heightM * Math.max(0.1, f.planM[0] * f.planM[1]) * f.members.length;
    const order = input.families.slice().sort((a, b) => size(b) - size(a));
    const out: FamilyViewPlan[] = [];
    const contextByPano = new Map<string, PlannedView>();
    const overBudget: string[] = [];
    let images = 0;
    for (const fam of order) {
        const notes: string[] = [];
        let blocked = 0;
        // every candidate view of every member, scored
        const cands: PlannedView[] = [];
        for (const m of fam.members) {
            const pts = input.memberPoints.get(m.clusterId);
            if (!pts?.length) continue;
            const near = input.panos.map(p => ({ p, d: Math.hypot(m.foot[0] - p.x, m.foot[2] - p.z) })).filter(x => x.d >= P.minRangeM && x.d <= P.maxRangeM).sort((a, b) => a.d - b.d).slice(0, P.candidatePanos);
            for (const { p } of near) {
                const eye = panoEye(p, input.groundAt);
                const aim = aimAt(eye, m, P);
                if (aim.pixelHeight < P.minPixelHeight) continue;
                const clear = clearShare(eye, aim, pts, input.tileMesh, P);
                if (clear < P.minClearShare) { blocked++; continue; }
                cands.push({
                    panoId: p.panoId, ...(p.date ? { date: p.date } : {}), ...(p.copyright ? { copyright: p.copyright } : {}), eye, facadeHeadingDeg: 0,
                    headingDeg: aim.headingDeg, pitchDeg: aim.pitchDeg, fovDeg: aim.fovDeg, aspectRatio: aim.aspectRatio, distanceM: aim.rangeM, rangeM: aim.rangeM, pixelHeight: aim.pixelHeight,
                    score: clear * Math.min(1, aim.pixelHeight / 400) / (1 + aim.rangeM / 15), familyId: fam.id, clusterId: m.clusterId, clearShare: Math.round(clear * 1000) / 1000,
                    sideDeg: r1(bearingDeg(m.foot[0], m.foot[2], eye[0], eye[2]))
                });
            }
        }
        if (!cands.length) { out.push({ familyId: fam.id, views: [], notes: [blocked ? `every one of ${blocked} candidate views is blocked in the scan` : `no Google panorama within ${P.maxRangeM} m frames it at ${P.minPixelHeight} px or more`], blocked }); continue; }
        // members with the best views first; each member's best view, then other sides
        // a pano already in the plan costs no wide registration view: its views are preferred by reusedPanoBonus
        const worth = (c: PlannedView) => c.score * (contextByPano.has(c.panoId) ? P.reusedPanoBonus : 1);
        const bestOf = new Map<number, PlannedView>();
        for (const c of cands) if (!bestOf.has(c.clusterId) || worth(c) > worth(bestOf.get(c.clusterId)!)) bestOf.set(c.clusterId, c);
        const members = [...bestOf.values()].sort((a, b) => worth(b) - worth(a)).slice(0, P.membersPerFamily).map(v => v.clusterId);
        const picked: PlannedView[] = [];
        for (const id of members) { const v = bestOf.get(id)!; picked.push(v); }
        const rest = cands.filter(c => members.includes(c.clusterId) && !picked.includes(c)).sort((a, b) => worth(b) - worth(a));
        for (const c of rest) {
            if (picked.length >= P.viewsPerFamily) break;
            const sides = picked.filter(p => p.clusterId === c.clusterId).map(p => p.sideDeg);
            if (sides.every(s => angleBetween(s, c.sideDeg) >= P.sideSeparationDeg) && !picked.some(p => p.panoId === c.panoId && p.clusterId === c.clusterId)) picked.push(c);
        }
        if (picked.length < 2) notes.push('seen from one side only');
        // the budget: these views plus the context views of panos not yet used
        const newPanos = [...new Set(picked.map(v => v.panoId))].filter(id => !contextByPano.has(id));
        if (images + picked.length + newPanos.length > P.maxImages) { overBudget.push(fam.id); out.push({ familyId: fam.id, views: [], notes: [`the district's budget of ${P.maxImages} images was spent on larger families`], blocked }); continue; }
        for (const id of newPanos) {
            const v = picked.find(x => x.panoId === id)!;
            contextByPano.set(id, { ...v, pitchDeg: 0, fovDeg: P.contextFovDeg, aspectRatio: 'RATIO_3X2', context: true, pixelHeight: 0, score: 0 });
        }
        images += picked.length + newPanos.length;
        out.push({ familyId: fam.id, views: picked, notes, blocked });
    }
    return { families: out, context: [...contextByPano.values()], images, overBudget };
}

/** Points on a ring around the families, for pano discovery: every `spacingM` over the discs of radius `reachM` round each member, deduplicated on that grid. */
export function discoveryPoints(families: StreetObjectFamily[], reachM: number, spacingM = 11): Array<{ x: number; z: number }> {
    const seen = new Set<string>();
    const out: Array<{ x: number; z: number }> = [];
    for (const f of families) for (const m of f.members) {
        const r = Math.ceil(reachM / spacingM);
        for (let i = -r; i <= r; i++) for (let k = -r; k <= r; k++) {
            const gx = Math.round(m.foot[0] / spacingM) + i, gz = Math.round(m.foot[2] / spacingM) + k;
            const x = gx * spacingM, z = gz * spacingM;
            if (Math.hypot(x - m.foot[0], z - m.foot[2]) > reachM + spacingM / 2) continue;
            const key = `${gx},${gz}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ x, z });
        }
    }
    return out;
}
