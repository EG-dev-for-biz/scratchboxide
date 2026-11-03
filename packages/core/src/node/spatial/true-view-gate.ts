/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
/**
 * Which surfaces a station's photo truly sees (user decision, 2026-11-03: "colour from true views").
 *
 * A station sees a surface of the scan when the surface is in its view and unoccluded, and its photo agrees the surface
 * is there. The second test is the one pipeline E's Street View texels use (pipeline-e/street-view-texels.ts
 * structuralAgreement): the photo's band-passed luma against the scan's own photo texture of that surface, NCC at the
 * best shift within MAX_SHIFT_M, at least MIN_AGREEMENT_NCC over at least MIN_AGREEMENT_TEXELS, and refused when the best
 * shift lies at the search's limit or the overlap is too small to tell. Here both sides are read in the station's own
 * image: the scan's photo texture is drawn from the station's camera (renderTriangles, unlit), and the surface is cut
 * into blocks of space (TRUE_VIEW_BLOCK_M, facing one of 14 ways, as the splat builder's patches are) from the scan's
 * depth in that camera, each block tested on its own at its own metric band. A block that passes is seen there; the
 * rest of the station's scan pixels are not, whatever its capture date: on 7th Ave the Street View photos facing Penn
 * Station show open plaza and Penn Station's facade where the tiles keep an older wall 8 m away, and the splat builder
 * painted that plaza onto the wall.
 *
 * The scan is kept (the structure stays the tiles'); what the gate decides is only which photo may colour it.
 */

import { renderTriangles } from '../3d-engine/staged-location/photo-match-eval';
import { MAX_SHIFT_M, MIN_AGREEMENT_NCC, MIN_AGREEMENT_TEXELS, structuralAgreement } from '../3d-engine/staged-location/pipeline-e/street-view-texels';
import type { TileTriangles } from '../3d-engine/staged-location/tile-texture-transfer';
import type { RenderMesh3D } from './HeadlessMeshSilhouetteRenderer';
import { renderFrameDepth, type FrameCamera } from './StreetViewPoseRegistrar';
import { resampleRgba } from '../texture-processing';

/** A block of surface the agreement is measured over: a cell of space this size (m), facing one of 14 ways. */
export const TRUE_VIEW_BLOCK_M = 8;
/** The gate reads each station at this width at most (the structure band is metric: 0.08 to 0.8 m). */
export const TRUE_VIEW_MAX_WIDTH_PX = 1400;
/** Neighbouring depths differing by more than this share are a depth edge: no normal there, and the pixel is in no block. */
const DEPTH_EDGE_REL = 0.03;
const EMPTY_DEPTH = 1e8;

/** A station's camera as station_to_splats bakes it (pose.json). */
export interface StationCamera { fx: number; fy: number; cx: number; cy: number; eye: number[]; right: number[]; up: number[]; forward: number[] }

export interface TrueViewReport {
    /** Blocks with any scan pixel in the station's view, those it truly sees, and why the others are refused. */
    blocks: number;
    passed: number;
    refused: { tooSmall: number; disagree: number; atLimit: number };
    /** Share of the station's scan pixels (not sky, not a depth edge) lying in blocks it truly sees. */
    seenShare: number;
    /** Median agreement (NCC) of the blocks measured, and of those passed; median shift of the passed ones (m). */
    medianNcc: number | null;
    medianShiftM: number | null;
    /** Working size the gate read the station at. */
    width: number; height: number;
    ms: number;
    /** Set when the station's picture was refused before the gate (its reason): it sees nothing. */
    pictureRefused?: string;
}

/** Which of 14 ways a normal faces: up, down, or one of 12 compass bins of its horizontal part (scratchbox_surface_splats.hpp facingBin). */
export function facingBin(nx: number, ny: number, nz: number): number {
    if (ny > 0.7) return 12;
    if (ny < -0.7) return 13;
    const az = Math.atan2(nx, nz);
    return ((Math.round((az / (2 * Math.PI)) * 12) % 12) + 12) % 12;
}

const median = (v: number[]): number | null => {
    if (!v.length) return null;
    const s = [...v].sort((a, b) => a - b);
    return s[s.length >> 1];
};

/**
 * Per pixel of the station's photo (W x H), 1 where the photo truly sees the scan, 0 elsewhere (sky, nothing, a depth
 * edge, or a block whose structure disagrees with the scan's own texture). `sky` (W x H, nonzero on sky) is left out of
 * the photo's side of the comparison.
 */
export function trueViewMask(input: {
    photo: Uint8Array; width: number; height: number; camera: StationCamera;
    /** The scan with its photo texture (readTileTriangles of the textured extraction), in the camera's frame. */
    tile: TileTriangles;
    /** The same scan for the depth (sceneToRenderMesh). */
    mesh: RenderMesh3D;
    sky?: Uint8Array;
}): { seen: Uint8Array; report: TrueViewReport } {
    const t0 = Date.now();
    const { width: W, height: H, camera: c } = input;
    const s = Math.min(1, TRUE_VIEW_MAX_WIDTH_PX / W);
    const w = Math.max(16, Math.round(W * s)), h = Math.max(16, Math.round(H * s));
    const sx = w / W, sy = h / H;
    const cam: FrameCamera = {
        eye: [c.eye[0], c.eye[1], c.eye[2]], right: [c.right[0], c.right[1], c.right[2]], up: [c.up[0], c.up[1], c.up[2]], fwd: [c.forward[0], c.forward[1], c.forward[2]],
        fx: c.fx * sx, fy: c.fy * sy, cx: c.cx * sx, cy: c.cy * sy, width: w, height: h
    };
    const photo = w === W && h === H ? input.photo : resampleRgba(input.photo, W, H, w, h);
    const tile = renderTriangles([input.tile], cam, { ambient: 1, supersample: 1, background: [0, 0, 0] }).rgba;
    const depth = renderFrameDepth(input.mesh, cam);
    const skyW = new Uint8Array(w * h);
    if (input.sky) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) skyW[y * w + x] = input.sky[Math.min(H - 1, Math.floor(y / sy)) * W + Math.min(W - 1, Math.floor(x / sx))] ? 1 : 0;

    // each scan pixel's point and facing, and its block (a cell of space facing one way)
    const P = new Float32Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x, z = depth[i];
        if (!(z < EMPTY_DEPTH)) continue;
        const a = (x + 0.5 - cam.cx) / cam.fx, b = (y + 0.5 - cam.cy) / cam.fy;
        for (let k = 0; k < 3; k++) P[i * 3 + k] = cam.eye[k] + z * (cam.fwd[k] + cam.right[k] * a - cam.up[k] * b);
    }
    const blockOf = new Int32Array(w * h).fill(-1);
    const keys = new Map<string, number>();
    const members: number[][] = [];
    const near = (i: number, j: number) => depth[j] < EMPTY_DEPTH && Math.abs(depth[i] - depth[j]) <= DEPTH_EDGE_REL * depth[i];
    let scanPixels = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!(depth[i] < EMPTY_DEPTH) || skyW[i]) continue;
        const l = i - 1, r = i + 1, u = i - w, d = i + w;
        if (!near(i, l) || !near(i, r) || !near(i, u) || !near(i, d)) continue;
        const ex = [P[r * 3] - P[l * 3], P[r * 3 + 1] - P[l * 3 + 1], P[r * 3 + 2] - P[l * 3 + 2]];
        const ey = [P[d * 3] - P[u * 3], P[d * 3 + 1] - P[u * 3 + 1], P[d * 3 + 2] - P[u * 3 + 2]];
        let nx = ex[1] * ey[2] - ex[2] * ey[1], ny = ex[2] * ey[0] - ex[0] * ey[2], nz = ex[0] * ey[1] - ex[1] * ey[0];
        const nl = Math.hypot(nx, ny, nz);
        if (nl < 1e-12) continue;
        nx /= nl; ny /= nl; nz /= nl;
        // facing the camera
        const vx = cam.eye[0] - P[i * 3], vy = cam.eye[1] - P[i * 3 + 1], vz = cam.eye[2] - P[i * 3 + 2];
        if (nx * vx + ny * vy + nz * vz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        scanPixels++;
        const key = `${Math.floor(P[i * 3] / TRUE_VIEW_BLOCK_M)},${Math.floor(P[i * 3 + 1] / TRUE_VIEW_BLOCK_M)},${Math.floor(P[i * 3 + 2] / TRUE_VIEW_BLOCK_M)},${facingBin(nx, ny, nz)}`;
        let b = keys.get(key);
        if (b === undefined) { b = members.length; keys.set(key, b); members.push([]); }
        blockOf[i] = b;
        members[b].push(i);
    }

    // each block: the photo's structure against the scan's own texture there, at the block's metric band
    const seenW = new Uint8Array(w * h);
    const refused = { tooSmall: 0, disagree: 0, atLimit: 0 };
    const nccs: number[] = [], shifts: number[] = [];
    let passed = 0, seenPixels = 0;
    for (const px of members) {
        if (px.length < MIN_AGREEMENT_TEXELS) { refused.tooSmall++; continue; }
        const zs: number[] = [];
        let x0 = w, y0 = h, x1 = 0, y1 = 0;
        for (let k = 0; k < px.length; k += Math.max(1, px.length >> 9)) zs.push(depth[px[k]]);
        for (const i of px) { const x = i % w, y = (i - x) / w; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
        const pixelM = median(zs)! / cam.fx;
        const R = Math.max(1, Math.round(MAX_SHIFT_M / pixelM));
        const cx0 = Math.max(0, x0 - R), cy0 = Math.max(0, y0 - R), cx1 = Math.min(w - 1, x1 + R), cy1 = Math.min(h - 1, y1 + R);
        const cw = cx1 - cx0 + 1, ch = cy1 - cy0 + 1;
        const pc = new Uint8Array(cw * ch * 4), tc = new Uint8Array(cw * ch * 4), valid = new Uint8Array(cw * ch), use = new Uint8Array(cw * ch);
        for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
            const j = (cy0 + y) * w + cx0 + x, o = y * cw + x;
            for (let k = 0; k < 4; k++) { pc[o * 4 + k] = photo[j * 4 + k]; tc[o * 4 + k] = tile[j * 4 + k]; }
            valid[o] = skyW[j] ? 0 : 1;
        }
        for (const i of px) { const x = i % w, y = (i - x) / w; use[(y - cy0) * cw + (x - cx0)] = 1; }
        const ag = structuralAgreement(pc, valid, tc, use, cw, ch, pixelM);
        if (!ag) { refused.tooSmall++; continue; }
        nccs.push(ag.ncc);
        if (Math.abs(ag.dx) >= R || Math.abs(ag.dy) >= R) { refused.atLimit++; continue; }
        if (ag.ncc < MIN_AGREEMENT_NCC) { refused.disagree++; continue; }
        passed++;
        shifts.push(Math.hypot(ag.dx, ag.dy) * pixelM);
        for (const i of px) seenW[i] = 1;
        seenPixels += px.length;
    }

    const seen = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        const yy = Math.min(h - 1, Math.floor(y * sy));
        for (let x = 0; x < W; x++) seen[y * W + x] = seenW[yy * w + Math.min(w - 1, Math.floor(x * sx))];
    }
    return {
        seen,
        report: {
            blocks: members.length, passed, refused, seenShare: scanPixels ? seenPixels / scanPixels : 0,
            medianNcc: median(nccs), medianShiftM: median(shifts), width: w, height: h, ms: Date.now() - t0
        }
    };
}
