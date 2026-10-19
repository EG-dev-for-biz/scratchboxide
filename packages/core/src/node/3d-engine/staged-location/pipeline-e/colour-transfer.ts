/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E inference (f): whole-facade colour from Street View. The tile photo's colour is the aerial capture's (haze,
 * white balance, sun); a street-level photo shows the facade's own colour. Points on the wall are projected into the Street
 * View photos at their (unrefined, nominal) poses; a pair is kept only where the photo pixel passes the ownership and
 * occluder masks (streetview-ownership.ts) and the wall point is the nearest surface of the massing there. Both sides are
 * blurred (about a metre), so a rough pose costs little. Per wall, one affine colour map per linear-RGB channel
 * (photo = gain * tile, the ratio of the channel medians) is fitted and applied to the whole wall.
 *
 * Verified, held out: the wall's pairs are split into its left and right halves; the map fitted on one half must bring the
 * other half's colours closer to the photos (median CIEDE2000) by at least MIN_GAIN, both ways. Gains outside GAIN_RANGE are
 * refused (that is no colour correction, it is a different surface).
 */

import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import type { PinholeCamera, ProjectionView } from '../../../../common/spatial/texture-pass-contracts';
import { deltaE00, linearToLab } from '../texel-exposure';
import { blurRgb, medianOf } from './image-ops';
import type { FaceTexture } from './massing-glb';
import type { MassingFace } from './native-massing';

export const MIN_PAIRS = 150;
export const MIN_GAIN = 0.1;
export const GAIN_RANGE: [number, number] = [0.45, 2.2];
export const SAMPLE_STEP_M = 0.5;

export interface ColourPair { s: number; tile: [number, number, number]; photo: [number, number, number] }
export interface ChannelMap { gain: number; offset: number }
export interface ColourResult { face: number; pairs: number; views: number; accepted: boolean; why: string; map?: ChannelMap[]; heldOut?: { before: number; after: number } }

const toLinear = (v: number) => SRGB8_TO_LINEAR[Math.max(0, Math.min(255, Math.round(v)))];
export function linearToSrgb8(v: number): number {
    const c = Math.max(0, Math.min(1, v));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
}

function project(cam: PinholeCamera, p: [number, number, number]): { u: number; v: number; z: number } | undefined {
    const d = [p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]];
    const z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
    if (z < 0.5) return undefined;
    const x = d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2], y = d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2];
    return { u: cam.cx + (cam.fx * x) / z, v: cam.cy - (cam.fy * y) / z, z };
}

/** Pairs of (blurred tile texel, blurred photo pixel) for the wall's clean texels the photos see clear. */
export function colourPairs(face: MassingFace, t: FaceTexture, clean: Uint8Array, views: Array<ProjectionView & { depth?: Float32Array }>): { pairs: ColourPair[]; views: number } {
    const W = t.width, H = t.height;
    const tb = blurRgb(t.rgba, clean, W, H, Math.max(2, Math.round(0.5 / face.pixel)));
    const pairs: ColourPair[] = [];
    const used = new Set<string>();
    const step = Math.max(1, Math.round(SAMPLE_STEP_M / face.pixel));
    const blurPhoto = new Map<string, Float32Array[]>();
    for (const v of views) {
        if (!v.ownerMask) continue;
        const cam = v.camera;
        let got = 0;
        for (let y = step >> 1; y < H; y += step) for (let x = step >> 1; x < W; x += step) {
            const i = y * W + x;
            if (!clean[i] || !Number.isFinite(tb[0][i])) continue;
            const s = face.orthoSMin + (x + 0.5) * face.pixel, tt = face.orthoTMax - (y + 0.5) * face.pixel;
            const p: [number, number, number] = [face.origin[0] + face.axisS[0] * s + face.axisT[0] * tt, face.origin[1] + face.axisS[1] * s + face.axisT[1] * tt, face.origin[2] + face.axisS[2] * s + face.axisT[2] * tt];
            // facing the camera
            const toCam = [cam.eye[0] - p[0], cam.eye[1] - p[1], cam.eye[2] - p[2]];
            if (toCam[0] * face.normal[0] + toCam[1] * face.normal[1] + toCam[2] * face.normal[2] <= 0) continue;
            const q = project(cam, p);
            if (!q) continue;
            const u = Math.floor(q.u), w = Math.floor(q.v);
            if (u < 2 || w < 2 || u >= cam.width - 2 || w >= cam.height - 2) continue;
            const pi = w * cam.width + u;
            if (!v.ownerMask[pi]) continue;
            if (v.depth && !(Math.abs(v.depth[pi] - q.z) < 1.5)) continue;
            let pb = blurPhoto.get(v.panoId);
            if (!pb) {
                const r = Math.max(1, Math.round(0.004 * cam.width));
                pb = blurRgb(v.image.rgba, v.ownerMask, cam.width, cam.height, r);
                blurPhoto.set(v.panoId, pb);
            }
            if (!Number.isFinite(pb[0][pi])) continue;
            pairs.push({ s, tile: [tb[0][i], tb[1][i], tb[2][i]], photo: [pb[0][pi], pb[1][pi], pb[2][pi]] });
            got++;
        }
        if (got) used.add(v.panoId);
    }
    return { pairs, views: used.size };
}

/**
 * Robust per-channel gain photo = g * tile in linear RGB: the ratio of the channel medians over the pairs. With a rough
 * pose only the low-frequency colour is trustworthy, and a gain (white balance and exposure) is what it can carry.
 */
export function fitColourMap(pairs: ColourPair[]): ChannelMap[] {
    return [0, 1, 2].map(c => {
        const x = medianOf(pairs.map(p => toLinear(p.tile[c]))), y = medianOf(pairs.map(p => toLinear(p.photo[c])));
        return { gain: x > 1e-4 ? y / x : 1, offset: 0 };
    });
}

const lab8 = (rgb: [number, number, number]) => linearToLab(toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2]));
function mapRgb(m: ChannelMap[], rgb: [number, number, number]): [number, number, number] {
    return [0, 1, 2].map(c => linearToSrgb8(m[c].gain * toLinear(rgb[c]) + m[c].offset)) as [number, number, number];
}
function medianDeltaE(pairs: ColourPair[], m?: ChannelMap[]): number {
    return medianOf(pairs.map(p => deltaE00(lab8(m ? mapRgb(m, p.tile) : p.tile), lab8(p.photo))));
}

/** Fit, check held out (left/right halves), and apply to the whole wall when it passes. */
export function transferColour(face: MassingFace, t: FaceTexture, pairs: ColourPair[], views: number): ColourResult {
    const base = { face: face.index, pairs: pairs.length, views };
    if (pairs.length < MIN_PAIRS) return { ...base, accepted: false, why: `${pairs.length} clean pairs (at least ${MIN_PAIRS} needed)` };
    const sMid = medianOf(pairs.map(p => p.s));
    const left = pairs.filter(p => p.s < sMid), right = pairs.filter(p => p.s >= sMid);
    const check = (fitOn: ColourPair[], testOn: ColourPair[]) => { const m = fitColourMap(fitOn); return { before: medianDeltaE(testOn), after: medianDeltaE(testOn, m) }; };
    const a = check(left, right), b = check(right, left);
    const map = fitColourMap(pairs);
    const heldOut = { before: Math.round(((a.before + b.before) / 2) * 100) / 100, after: Math.round(((a.after + b.after) / 2) * 100) / 100 };
    if (map.some(m => m.gain < GAIN_RANGE[0] || m.gain > GAIN_RANGE[1])) return { ...base, accepted: false, why: `gain ${map.map(m => m.gain.toFixed(2)).join('/')} outside ${GAIN_RANGE.join('..')}`, map, heldOut };
    if (!(a.after <= a.before * (1 - MIN_GAIN) && b.after <= b.before * (1 - MIN_GAIN))) return { ...base, accepted: false, why: `held out: CIEDE2000 ${a.before.toFixed(1)} -> ${a.after.toFixed(1)} and ${b.before.toFixed(1)} -> ${b.after.toFixed(1)} (needs ${Math.round(MIN_GAIN * 100)}% less both ways)`, map, heldOut };
    // the whole wall
    const lut = [0, 1, 2].map(c => Uint8Array.from({ length: 256 }, (_, v) => linearToSrgb8(map[c].gain * toLinear(v) + map[c].offset)));
    for (let i = 0; i < t.width * t.height; i++) for (let c = 0; c < 3; c++) t.rgba[i * 4 + c] = lut[c][t.rgba[i * 4 + c]];
    return { ...base, accepted: true, why: `held out: CIEDE2000 ${heldOut.before} -> ${heldOut.after}`, map, heldOut };
}
