/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E inference (g): what stands in front of a wall in its ortho texture, masked and filled.
 *
 * Masked: texels the tile does not cover (the scan has no facade surface there, as behind a tree the strip took out); the
 * silhouettes of the measured tree crowns standing in front of the wall (the strip's crowns, projected along the wall's
 * normal: crown ellipse plus stem), so a tree is never fused into the facade it stood before; and, when a vision model is
 * given, the boxes it marks on the ortho as standing in front of the facade (open vocabulary, no class list).
 *
 * Filled, in order, real pixels first: the averaged bay (bay-average.ts, which replaces masked texels inside its bays);
 * then the same wall one or more bay pitches along, or another facade of the building (the opposite face first) at the same
 * height, where that facade's band at that height matches this one's (photo-inferred); then generative inpainting by Nano
 * Banana Lite through texture-inpaint.ts's detail lock (labelled generated); what is left takes the nearest real texel.
 */

import { TEXTURE_LADDER_RUNGS, packConfidenceTexel, type BakedTexturePlanes } from '../../../../common/spatial/texture-pass-contracts';
import { inpaintMaskedTexels, type InpaintRectRecord } from '../texture-inpaint';
import type { EnhanceModelClient } from '../texture-enhance';
import type { LaidOutUvAtlas } from '../texture-uv';
import { dilate } from './image-ops';
import type { FaceTexture } from './massing-glb';
import type { MassingFace } from './native-massing';

/** A measured tree crown in the tile frame. */
export interface Crown { id: number; x: number; z: number; radius: number; baseY: number; topY: number }

/** Crowns standing further than this in front of a wall do not hide it in the tile photo's slab. */
export const CROWN_REACH_M = 10;
export const STEM_HALF_WIDTH_M = 0.35;

/** The crowns of a tile_vegetation strip (crowns.json): every measured crown that is a tree, with its extent. */
export function crownsFromStrip(json: unknown): Crown[] {
    const list = (json as { crowns?: unknown[] })?.crowns ?? [];
    const out: Crown[] = [];
    for (const c of list as Array<Record<string, any>>) {  // eslint-disable-line @typescript-eslint/no-explicit-any
        // a crown kept as scanned (on a roof, not regrowable) is part of the scan the massing kept; it hides no wall texel
        if (c?.status === 'not_regrowable') continue;
        const apex = c?.apex, stem = c?.stem;
        if (!Array.isArray(apex) || !Array.isArray(stem)) continue;
        const radii = Array.isArray(c.sectorRadii) ? (c.sectorRadii as number[]).filter(Number.isFinite) : [];
        const r = radii.length ? Math.max(...radii) : Math.sqrt(Math.max(1, Number(c.areaM2) || 1) / Math.PI);
        const base = Number.isFinite(c.supportY) ? Number(c.supportY) : Number(c.terrainY ?? apex[1] - 8);
        out.push({ id: Number(c.id), x: Number(stem[0]), z: Number(stem[1]), radius: r, baseY: base, topY: Number(apex[1]) });
    }
    return out;
}

/** Texels of a vertical face hidden by crowns standing in front of it (ellipse of the crown, the stem below). */
export function crownMask(face: Pick<MassingFace, 'normal' | 'axisS' | 'origin' | 'orthoSMin' | 'orthoTMax' | 'pixel' | 'width' | 'height' | 'sMin' | 'sMax'>, crowns: Crown[]): { mask: Uint8Array; crowns: number[] } {
    const W = face.width, H = face.height, mask = new Uint8Array(W * H);
    const hit: number[] = [];
    if (Math.abs(face.normal[1]) > 0.3) return { mask, crowns: hit };
    for (const c of crowns) {
        const dx = c.x - face.origin[0], dz = c.z - face.origin[2];
        const h = dx * face.normal[0] + dz * face.normal[2];
        if (h < -0.5 || h > CROWN_REACH_M + c.radius) continue;
        const s = dx * face.axisS[0] + dz * face.axisS[2];
        if (s + c.radius < face.sMin || s - c.radius > face.sMax) continue;
        // the crown: an ellipse from a third of the way up to the apex; the stem a strip below it
        const crownBase = c.baseY + 0.33 * (c.topY - c.baseY);
        const ct = 0.5 * (crownBase + c.topY), rt = Math.max(0.5, 0.5 * (c.topY - crownBase));
        let any = false;
        for (let y = 0; y < H; y++) {
            const t = face.orthoTMax - (y + 0.5) * face.pixel;
            for (let x = 0; x < W; x++) {
                const ss = face.orthoSMin + (x + 0.5) * face.pixel;
                const e = ((ss - s) / c.radius) ** 2 + ((t - ct) / rt) ** 2;
                const stem = t >= c.baseY && t < ct && Math.abs(ss - s) <= STEM_HALF_WIDTH_M;
                if (e <= 1 || stem) { mask[y * W + x] = 1; any = true; }
            }
        }
        if (any) hit.push(c.id);
    }
    return { mask, crowns: hit };
}

/** Boxes a vision model marked (per-mille [x0, y0, x1, y1] of the ortho) as a mask. */
export function boxMask(boxes: Array<[number, number, number, number]>, W: number, H: number): Uint8Array {
    const m = new Uint8Array(W * H);
    for (const [a, b, c, d] of boxes) {
        const x0 = Math.max(0, Math.floor((Math.min(a, c) / 1000) * W)), x1 = Math.min(W, Math.ceil((Math.max(a, c) / 1000) * W));
        const y0 = Math.max(0, Math.floor((Math.min(b, d) / 1000) * H)), y1 = Math.min(H, Math.ceil((Math.max(b, d) / 1000) * H));
        for (let y = y0; y < y1; y++) m.fill(1, y * W + x0, y * W + x1);
    }
    return m;
}

export function occluderPrompt(widthM: number, heightM: number): string {
    return [
        `This is a fronto-parallel orthophoto of one wall of a building, ${widthM.toFixed(1)} m wide and ${heightM.toFixed(1)} m tall, resampled from a photogrammetric scan's photo texture. Up is up. Flat mid-grey areas are not covered by the scan.`,
        'Mark everything that stands IN FRONT of the wall and is not part of the building itself: anything between the camera and the wall surface that hides the wall (whatever it is). Do not mark the building\'s own windows, doors, ornament, signs fixed flat to the wall, balconies or fire escapes.',
        'Give each as a box [x0, y0, x1, y1] in per-mille of the image (0..1000, x right, y down) with a few words of label. If nothing stands in front, return an empty list.',
        'Answer with JSON only: {"boxes":[{"box":[x0,y0,x1,y1],"label":"..."}]}'
    ].join('\n');
}

export function parseOccluderReply(text: string): Array<{ box: [number, number, number, number]; label: string }> {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('the reply holds no JSON object');
    const j = JSON.parse(text.slice(a, b + 1));
    const out: Array<{ box: [number, number, number, number]; label: string }> = [];
    for (const e of Array.isArray(j?.boxes) ? j.boxes : []) {
        const bx = e?.box;
        if (!Array.isArray(bx) || bx.length !== 4 || !bx.every((v: unknown) => typeof v === 'number' && Number.isFinite(v))) continue;
        const c = bx.map((v: number) => Math.max(0, Math.min(1000, v))) as [number, number, number, number];
        if (Math.abs(c[2] - c[0]) < 2 || Math.abs(c[3] - c[1]) < 2) continue;
        out.push({ box: c, label: typeof e.label === 'string' ? e.label.slice(0, 60) : '' });
    }
    return out;
}

export interface OtherFacadeFill { filled: number; sources: Array<{ face: number; texels: number; how: 'bay-shift' | 'other-facade' }> }

/** Mean colour of the clean texels in each row band of `bandPx` rows (NaN where none). */
function rowBands(t: FaceTexture, clean: Uint8Array, bandPx: number): Float32Array[] {
    const n = Math.ceil(t.height / bandPx);
    const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], cnt = new Float32Array(n);
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
        const i = y * t.width + x;
        if (!clean[i]) continue;
        const b = Math.floor(y / bandPx);
        for (let c = 0; c < 3; c++) out[c][b] += t.rgba[i * 4 + c];
        cnt[b]++;
    }
    for (let b = 0; b < n; b++) for (let c = 0; c < 3; c++) out[c][b] = cnt[b] > 20 ? out[c][b] / cnt[b] : NaN;
    return out;
}

/**
 * Fills masked texels of face `fi` from real texels elsewhere: the same wall shifted by whole bay pitches (when `pitchPx`
 * is known, only within the lattice's `rows`), then other walls at the same height (the opposite face first) whose row bands
 * match this wall's within `maxBandDelta` (mean absolute RGB difference over shared clean bands). Only holes up to
 * `maxRegionM2` are filled so (one occluder's; a hole the size of most of a wall is not a facade elsewhere). Filled texels
 * get `source` and leave `masked`.
 */
export function fillFromOtherFacades(fi: number, faces: MassingFace[], textures: Map<number, FaceTexture>, cleanOf: Map<number, Uint8Array>, masked: Uint8Array, source: number, opts: { pitchPx?: number; maxBandDelta?: number; rows?: [number, number]; maxRegionM2?: number } = {}): OtherFacadeFill {
    const f = faces.find(x => x.index === fi)!, t = textures.get(fi)!, clean = cleanOf.get(fi)!;
    const W = t.width, H = t.height;
    const res: OtherFacadeFill = { filled: 0, sources: [] };
    const maxTex = (opts.maxRegionM2 ?? 30) / (f.pixel * f.pixel);
    const work = new Uint8Array(masked.length);
    let left = 0;
    for (const r of holeRects(masked, W, H, 0, 1)) {
        if (r.texels > maxTex) continue;
        for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) if (masked[y * W + x] && !work[y * W + x]) { work[y * W + x] = 1; left++; }
    }
    const take = (i: number, rgba: Uint8Array, j: number) => {
        t.rgba[i * 4] = rgba[j * 4]; t.rgba[i * 4 + 1] = rgba[j * 4 + 1]; t.rgba[i * 4 + 2] = rgba[j * 4 + 2]; t.rgba[i * 4 + 3] = 255;
        t.source[i] = source; masked[i] = 0; work[i] = 0; left--;
    };
    if (!left) return res;
    if (opts.pitchPx && opts.pitchPx >= 4) {
        let n = 0;
        for (let y = 0; y < H; y++) {
            if (opts.rows && (y < opts.rows[0] || y > opts.rows[1])) continue;
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!work[i]) continue;
                search: for (let k = 1; k <= 6; k++) for (const sgn of [1, -1]) {
                    const xx = Math.round(x + sgn * k * opts.pitchPx);
                    if (xx < 0 || xx >= W) continue;
                    const j = y * W + xx;
                    if (!clean[j] || masked[j]) continue;
                    take(i, t.rgba, j); n++;
                    break search;
                }
            }
        }
        if (n) res.sources.push({ face: fi, texels: n, how: 'bay-shift' });
        res.filled += n;
    }
    if (!left) return res;
    const band = Math.max(4, Math.round(1 / f.pixel));
    const mine = rowBands(t, clean, band);
    const others = faces.filter(o => o.index !== fi && o.wall && textures.has(o.index) && cleanOf.has(o.index) && Math.abs(o.pixel - f.pixel) < 1e-6)
        .sort((a, b) => (a.normal[0] * f.normal[0] + a.normal[2] * f.normal[2]) - (b.normal[0] * f.normal[0] + b.normal[2] * f.normal[2]) || b.coverage - a.coverage);
    for (const o of others) {
        const ot = textures.get(o.index)!, oc = cleanOf.get(o.index)!;
        const theirs = rowBands(ot, oc, band);
        let diff = 0, shared = 0;
        for (let b = 0; b < mine[0].length; b++) {
            const t0 = f.orthoTMax - b * band * f.pixel;
            const ob = Math.floor((o.orthoTMax - t0) / o.pixel / band);
            if (ob < 0 || ob >= theirs[0].length) continue;
            if (!Number.isFinite(mine[0][b]) || !Number.isFinite(theirs[0][ob])) continue;
            diff += (Math.abs(mine[0][b] - theirs[0][ob]) + Math.abs(mine[1][b] - theirs[1][ob]) + Math.abs(mine[2][b] - theirs[2][ob])) / 3;
            shared++;
        }
        if (shared < 3 || diff / shared > (opts.maxBandDelta ?? 18)) continue;
        let n = 0;
        for (let y = 0; y < H; y++) {
            const tt = f.orthoTMax - (y + 0.5) * f.pixel;
            const oy = Math.floor((o.orthoTMax - tt) / o.pixel);
            if (oy < 0 || oy >= ot.height) continue;
            for (let x = 0; x < W; x++) {
                const i = y * W + x;
                if (!work[i]) continue;
                const rel = (x / W) * ot.width;
                for (let k = 0; k < 8; k++) {
                    const ox = Math.floor((rel + k * 37) % ot.width);
                    const j = oy * ot.width + ox;
                    if (!oc[j]) continue;
                    take(i, ot.rgba, j); n++;
                    break;
                }
            }
        }
        if (n) res.sources.push({ face: o.index, texels: n, how: 'other-facade' });
        res.filled += n;
        if (!left) break;
    }
    return res;
}

/** Connected components of a mask, as bounding rectangles grown by `pad` (clamped), largest first. */
export function holeRects(mask: Uint8Array, W: number, H: number, pad: number, minTexels: number): Array<{ x: number; y: number; width: number; height: number; texels: number }> {
    const seen = new Uint8Array(W * H), out: Array<{ x: number; y: number; width: number; height: number; texels: number }> = [];
    const q: number[] = [];
    for (let s = 0; s < W * H; s++) {
        if (!mask[s] || seen[s]) continue;
        let x0 = W, y0 = H, x1 = 0, y1 = 0, n = 0;
        q.length = 0; q.push(s); seen[s] = 1;
        while (q.length) {
            const i = q.pop()!, x = i % W, y = (i / W) | 0;
            n++; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
            for (const j of [i - 1, i + 1, i - W, i + W]) {
                if (j < 0 || j >= W * H || seen[j] || !mask[j]) continue;
                if ((j === i - 1 && x === 0) || (j === i + 1 && x === W - 1)) continue;
                seen[j] = 1; q.push(j);
            }
        }
        if (n < minTexels) continue;
        const xa = Math.max(0, x0 - pad), ya = Math.max(0, y0 - pad), xb = Math.min(W, x1 + 1 + pad), yb = Math.min(H, y1 + 1 + pad);
        out.push({ x: xa, y: ya, width: xb - xa, height: yb - ya, texels: n });
    }
    return out.sort((a, b) => b.texels - a.texels);
}

/**
 * The last real-pixel-free rung: Nano Banana Lite inpainting of the masked texels, per hole rectangle, through the texture
 * pass's detail lock (texture-inpaint.ts). Accepted texels get `source` (generated). At most `maxRects` rectangles.
 */
export async function inpaintFace(t: FaceTexture, masked: Uint8Array, key: string, client: EnhanceModelClient, models: string[], source: number, opts: { maxRects?: number; signal?: AbortSignal } = {}): Promise<{ filled: number; target: number; records: InpaintRectRecord[] }> {
    const W = t.width, H = t.height, N = W * H;
    const rects = holeRects(dilate(masked, W, H, 0), W, H, 24, 64).slice(0, opts.maxRects ?? 4);
    if (!rects.length) return { filled: 0, target: 0, records: [] };
    const covered = new Uint8Array(N).fill(1), gutter = new Uint8Array(N);
    const atlas = { layerKey: key, width: W, height: H, texels: { covered, gutter }, layout: { rects: rects.map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })) } } as unknown as LaidOutUvAtlas;
    const albedo = new Uint8Array(N * 4);
    const confidence = { width: W, height: H, data: new Uint8Array(N * 4) };
    for (let i = 0; i < N; i++) {
        if (masked[i]) continue;
        albedo.set(t.rgba.subarray(i * 4, i * 4 + 3), i * 4); albedo[i * 4 + 3] = 255;
        packConfidenceTexel(confidence, i, 0, 0.5, TEXTURE_LADDER_RUNGS.indexOf('tile photo transfer'));
    }
    const planes: BakedTexturePlanes = { layerKey: key, width: W, height: H, albedo, confidence, provenance: [], degradations: [] };
    const r = await inpaintMaskedTexels({ atlas, planes, masked, client, models, concurrency: 2, ...(opts.signal ? { signal: opts.signal } : {}) });
    let filled = 0;
    if (r.planes) for (let i = 0; i < N; i++) {
        if (r.planes.albedo[i * 4 + 3] !== 255) continue;
        t.rgba.set(r.planes.albedo.subarray(i * 4, i * 4 + 3), i * 4); t.rgba[i * 4 + 3] = 255; t.source[i] = source; masked[i] = 0; filled++;
    }
    return { filled, target: r.targetTexels, records: r.records };
}
