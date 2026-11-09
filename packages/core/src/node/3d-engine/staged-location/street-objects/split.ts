/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects: a member the photos show as several alike pieces. The leaf tiles melt a row of bollards, posts or
 * planters into one ridge; the scan still measures where the row runs (the cluster's plan axis through its centre) and
 * how tall it stands, and a registered view's masks say where along it each piece stands. Each piece's foot (the bottom
 * middle of its mask) is cast from the view's camera onto the ground under the member, then onto the scan's line; the
 * pieces become members there (positions photo-inferred, on a measured line), each as tall as the scan says, each as
 * wide as its mask at mid-height (photo-inferred). Their spacing is read as a row (families.ts readPitch).
 */

import type { FrameCamera } from '../../../spatial/StreetViewPoseRegistrar';
import { pixelRay } from '../survey-casting';
import { readPitch, STREET_FAMILY_PARAMS, type StreetObjectMember, type StreetObjectRow, type V2 } from './families';

export const SPLIT_PARAMS = {
    /** A piece's foot may land this far past either end of the scan's ridge. */
    endSlackM: 0.6,
    /** Two pieces landing closer than this are one. */
    mergeM: 0.2,
    /** A piece's foot is read from its lowest this many rows. */
    footRows: 3
};

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const median = (a: number[]) => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

/** The plan axis of a heading clockwise from north (x east, z south). */
export const planAxis = (headingDeg: number): V2 => { const h = (headingDeg * Math.PI) / 180; return [Math.sin(h), -Math.cos(h)]; };

export interface PieceMask { mask: Uint8Array; width: number; height: number }

/** Where a piece's foot lands on the ground plane under `foot`, and its width (metres) at mid-height, or undefined. */
export function castPiece(cam: FrameCamera, piece: PieceMask, groundY: number, P = SPLIT_PARAMS): { at: V2; widthM: number } | undefined {
    const W = piece.width, H = piece.height;
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < piece.mask.length; i++) if (piece.mask[i]) { const y = (i - (i % W)) / W; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!(y1 >= y0)) return undefined;
    const xsAt = (y: number) => { const xs: number[] = []; for (let x = 0; x < W; x++) if (piece.mask[y * W + x]) xs.push(x); return xs; };
    const low: number[] = [];
    for (let y = Math.max(y0, y1 - P.footRows + 1); y <= y1; y++) low.push(...xsAt(y));
    const fx = median(low);
    const ray = pixelRay(cam, fx + 0.5, y1 + 1);
    if (!(ray.dir[1] < -1e-4)) return undefined;
    const t = (groundY - ray.origin[1]) / ray.dir[1];
    const at: V2 = [ray.origin[0] + ray.dir[0] * t, ray.origin[2] + ray.dir[2] * t];
    const depth = (at[0] - cam.eye[0]) * cam.fwd[0] + (groundY - cam.eye[1]) * cam.fwd[1] + (at[1] - cam.eye[2]) * cam.fwd[2];
    const mid = xsAt(Math.round((y0 + y1) / 2));
    const widthM = mid.length ? ((mid[mid.length - 1] - mid[0] + 1) * depth) / cam.fx : NaN;
    return { at, widthM: widthM > 0 ? widthM : NaN };
}

export interface SplitResult { members: StreetObjectMember[]; row?: StreetObjectRow; reason: string }

/**
 * The member as the pieces one view shows, or undefined when fewer than two land on its line. Each new member keeps the
 * cluster's id and numbers its piece.
 */
export function splitMember(member: StreetObjectMember, cam: FrameCamera, pieces: PieceMask[], P = SPLIT_PARAMS): SplitResult | undefined {
    const dir = planAxis(member.planHeadingDeg);
    const half = member.planM[0] / 2 + P.endSlackM;
    const landed = pieces.map(p => castPiece(cam, p, member.foot[1], P)).filter((x): x is NonNullable<typeof x> => !!x)
        .map(x => ({ s: (x.at[0] - member.foot[0]) * dir[0] + (x.at[1] - member.foot[2]) * dir[1], w: x.widthM }))
        .filter(x => Math.abs(x.s) <= half).sort((a, b) => a.s - b.s);
    const kept: typeof landed = [];
    for (const x of landed) if (!kept.length || x.s - kept[kept.length - 1].s >= P.mergeM) kept.push(x);
    if (kept.length < 2) return undefined;
    const w = median(kept.map(k => k.w));
    const members: StreetObjectMember[] = kept.map((k, i) => ({
        ...member, piece: i, foot: [r3(member.foot[0] + dir[0] * k.s), member.foot[1], r3(member.foot[2] + dir[1] * k.s)],
        planM: [r3(Number.isFinite(w) ? w : member.planM[1]), r3(Number.isFinite(w) ? w : member.planM[1])], alongM: r3(k.s - kept[0].s), lateralM: 0
    }));
    const along = kept.map(k => k.s - kept[0].s);
    const p = readPitch(along, { ...STREET_FAMILY_PARAMS, minPitchM: P.mergeM });
    const steady = Number.isFinite(p.pitchM) && !p.breaks.length && p.regularity >= STREET_FAMILY_PARAMS.minRegularity;
    const row: StreetObjectRow | undefined = steady ? {
        origin: [members[0].foot[0], members[0].foot[2]], direction: [r3(dir[0]), r3(dir[1])], pitchM: r3(p.pitchM), regularity: r3(p.regularity), lateralRmsM: 0, lengthM: r3(along[along.length - 1]),
        missing: p.steps.flatMap((k, i) => Array.from({ length: Math.max(0, k - 1) }, (_, j) => { const s = kept[i].s + (j + 1) * p.pitchM; return { alongM: r3(s - kept[0].s), at: [r3(member.foot[0] + dir[0] * s), r3(member.foot[2] + dir[1] * s)] as V2 }; }))
    } : undefined;
    return {
        members, ...(row ? { row } : {}),
        reason: `the scan's ${r3(member.planM[0])} m ridge (cluster ${member.clusterId}) is ${kept.length} separate pieces in Street View: each piece's foot cast from the registered view onto the scan's line through the ridge${row ? `, a row at ${row.pitchM} m pitch` : ''}; positions photo-inferred, heights the scan's`
    };
}
