/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/
/**
 * Pipeline E: real Street View texels on the walls.
 *
 * The scan's photo is aerial (about 20 px/m on a wall, melted at street level); a registered Street View photo sees the
 * lower storeys at 60-150 px/m. Until this step Street View only guided and checked the enhanced redraw (plate-streetview.ts)
 * and corrected the wall's colour (colour-transfer.ts): no photo pixel reached a texel, so the texel share of Street View was
 * 0 in every build. Here, once the plates are decided, each wall takes the photo where the photo truly sees it better:
 *
 *   - the views are the survey's, registered against the tile mesh (edges, then jointly) and cut out by the ownership and
 *     occluder masks (streetview-registered-views.ts); a nominal pose (about ±2 m) is never projected;
 *   - rectifyViewOntoWall (plate-streetview.ts) projects every wall texel into the photo through its pose and warp; a texel
 *     is taken only where the pixel is owned (the structure, nothing in front), the massing is the nearest surface there
 *     and the photo resolves the wall at least MIN_SHARPER times the tile ortho's pixel pitch at an incidence within
 *     MAX_INCIDENCE_DEG (a grazing photo smears);
 *   - the valid region is eroded by ERODE_M (the mask's own edge) and feathered over FEATHER_M; several views blend by their
 *     feather, so no seam is cut between them;
 *   - the photo must agree with the wall it lands on: its band-passed luma against the wall's existing texels (the tile
 *     ortho or the plate), NCC over the overlap at the best shift within MAX_SHIFT_M, at least MIN_AGREEMENT_NCC; a pose
 *     the registration called good but that projects another bay, a blank wall or the sky onto the wall (the Bradbury's
 *     two 'edges' poses did, at the 0.25 m residual floor) fails here and gives nothing; the shift found is applied;
 *   - the photo's exposure is matched to the wall's existing texels (the median linear ratio per channel over the overlap,
 *     within GAIN_RANGE, as the tile transfer does): the colour family stays the wall's, the detail is the photo's.
 *
 * Every texel written is labelled photo-inferred: rung 'street-view single view' (one photo), or 'street-view multi-view
 * blend' where two photos both see the texel and agree (CIE76 within AGREE_DELTA_E after the gains). Nothing is invented: a
 * texel no photo sees keeps what it had.
 */
import { SRGB8_TO_LINEAR } from '../../../../common/spatial/photogrammetric-delight';
import { TEXTURE_LADDER_RUNGS } from '../../../../common/spatial/texture-pass-contracts';
import { linearToSrgb8, project } from './colour-transfer';
import type { FaceTexture, TexelSource } from './massing-glb';
import type { MassingFace } from './native-massing';
import { DEPTH_TOLERANCE_M, type GuideView } from './plate-streetview';
import { bandPass, labPlanes } from './plate-audit';

/** The photo must resolve the wall at least this many times finer than the tile ortho's pixel pitch (1 / face.pixel). */
export const MIN_SHARPER = 1.5;
/** Beyond this incidence (degrees from the wall's normal) a photo pixel smears over the wall and is not taken. */
export const MAX_INCIDENCE_DEG = 70;
/** The valid region is eroded by this much (the ownership mask's edge, the texel's own blur), metres. */
export const ERODE_M = 0.15;
/** ... and feathered over this much into what it replaces, metres. */
export const FEATHER_M = 0.4;
/** The exposure gain (photo -> wall) must be within this range, else the photo is a different surface, not a different light. */
export const GAIN_RANGE: [number, number] = [0.5, 2];
/** Pairs needed to fit the gain; fewer and the photo keeps its own exposure. */
export const MIN_GAIN_PAIRS = 200;
/** Two photos agree on a texel within this CIE76 distance (after the gains): the multi-view rung. */
export const AGREE_DELTA_E = 15;
/** A wall takes the photo only when at least this many texels qualify (a few texels are not a texture). */
export const MIN_TEXELS = 400;
/**
 * The rectified photo's band-passed luma must correlate at least this well with the wall's own texels where both exist
 * (plate-streetview's SUPPORT_NCC). Measured: the Haughwout's right poses 0.39-0.59, its grazing upward view 0.16; the
 * Bradbury's two wrong 'edges' poses 0.14 and 0.21-0.23 (a blank sunlit wall and a triangle of sky put on the wall).
 */
export const MIN_AGREEMENT_NCC = 0.3;
/** The rectified photo may move this far against the wall before the comparison (the registered pose's residual), metres. */
export const MAX_SHIFT_M = 1;
/** Texels the agreement is measured over, at least. */
export const MIN_AGREEMENT_TEXELS = 1500;
export const STREET_VIEW_TEXEL_SOURCE = 'street-view-rectified';
export const STREET_VIEW_TEXEL_SOURCE_MULTI = 'street-view-rectified-multi';

export interface StreetViewTexelRecord {
    face: number;
    /** Photos that gave texels, with the texels each gave (its own and those blended). */
    panos: Array<{ panoId: string; method: string; residualM: number | null; texels: number; pxPerM: number; gain: [number, number, number] | null; /** Structural agreement with the wall (NCC) and the shift applied, texels. */ agreement: number; shiftPx: [number, number] }>;
    /** Photos refused for not agreeing with the wall (the pose projects something else onto it). */
    refused: Array<{ panoId: string; method: string; agreement: number | null; why: string }>;
    /** Texels written (single-view rung + multi-view rung), the wall's texels, and the share of the wall. */
    texels: number; multiTexels: number; wallTexels: number; share: number;
    /** Texels of the wall's street-level band (rows >= bandTop) written, and the band's texels. */
    bandTexels: number; bandAll: number;
    why: string;
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export function erode(mask: Uint8Array, W: number, H: number, r: number): Uint8Array {
    if (r <= 0) return mask.slice();
    const tmp = new Uint8Array(W * H).fill(1), out = new Uint8Array(W * H).fill(1);
    for (let y = 0; y < H; y++) {
        let last = -Infinity;
        for (let x = 0; x < W; x++) { if (!mask[y * W + x]) last = x; if (x - last <= r) tmp[y * W + x] = 0; }
        last = Infinity;
        for (let x = W - 1; x >= 0; x--) { if (!mask[y * W + x]) last = x; if (last - x <= r) tmp[y * W + x] = 0; }
    }
    for (let x = 0; x < W; x++) {
        let last = -Infinity;
        for (let y = 0; y < H; y++) { if (!tmp[y * W + x]) last = y; if (y - last <= r) out[y * W + x] = 0; }
        last = Infinity;
        for (let y = H - 1; y >= 0; y--) { if (!tmp[y * W + x]) last = y; if (last - y <= r) out[y * W + x] = 0; }
    }
    // the frame's own border is not an edge of the region
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mask[y * W + x] && (x < r || y < r || x >= W - r || y >= H - r)) out[y * W + x] = 1;
    return out;
}

/** Distance (texels, chessboard) of each texel of `mask` to its nearest texel outside it, capped at `cap`. */
export function insideDistance(mask: Uint8Array, W: number, H: number, cap: number): Float32Array {
    const d = new Float32Array(W * H).fill(0);
    for (let i = 0; i < W * H; i++) d[i] = mask[i] ? cap : 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!mask[i]) continue;
        let m = d[i];
        if (x > 0) m = Math.min(m, d[i - 1] + 1); else m = Math.min(m, cap);
        if (y > 0) m = Math.min(m, d[i - W] + 1); else m = Math.min(m, cap);
        d[i] = m;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        if (!mask[i]) continue;
        let m = d[i];
        if (x < W - 1) m = Math.min(m, d[i + 1] + 1);
        if (y < H - 1) m = Math.min(m, d[i + W] + 1);
        d[i] = m;
    }
    return d;
}

interface Rectified { view: GuideView; rgba: Uint8Array; valid: Uint8Array; weight: Float32Array; pxPerM: Float32Array }

function shiftedPlane<T extends Uint8Array | Float32Array>(a: T, W: number, H: number, dx: number, dy: number, ch: number): T {
    const out = new (a.constructor as new (n: number) => T)(a.length);
    for (let y = 0; y < H; y++) {
        const sy = y - dy;
        if (sy < 0 || sy >= H) continue;
        for (let x = 0; x < W; x++) {
            const sx = x - dx;
            if (sx < 0 || sx >= W) continue;
            for (let c = 0; c < ch; c++) out[(y * W + x) * ch + c] = a[(sy * W + sx) * ch + c];
        }
    }
    return out;
}

/**
 * How well the rectified photo's structure matches the wall's where both exist: band-passed luma NCC over the overlap at the
 * best shift within MAX_SHIFT_M (searched coarse to fine). null when the overlap is under MIN_AGREEMENT_TEXELS.
 */
export function structuralAgreement(photo: Uint8Array, valid: Uint8Array, wall: Uint8Array, use: Uint8Array, W: number, H: number, pixelM: number): { ncc: number; dx: number; dy: number; texels: number } | null {
    const bp = bandPass(labPlanes(photo, W * H)[0], valid, W, H, pixelM), bw = bandPass(labPlanes(wall, W * H)[0], use, W, H, pixelM);
    const corr = (dx: number, dy: number): { ncc: number; n: number } => {
        let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
        for (let y = 0; y < H; y += 2) {
            const sy = y - dy;
            if (sy < 0 || sy >= H) continue;
            for (let x = 0; x < W; x += 2) {
                const sx = x - dx;
                if (sx < 0 || sx >= W) continue;
                const i = y * W + x, j = sy * W + sx;
                if (!use[i] || !valid[j]) continue;
                const a = bw[i], b = bp[j];
                n++; sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b;
            }
        }
        if (n * 4 < MIN_AGREEMENT_TEXELS) return { ncc: -1, n: n * 4 };
        const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
        return { ncc: va > 1e-6 && vb > 1e-6 ? (sab / n - (sa / n) * (sb / n)) / Math.sqrt(va * vb) : -1, n: n * 4 };
    };
    const R = Math.max(1, Math.round(MAX_SHIFT_M / pixelM));
    let best = { dx: 0, dy: 0, ...corr(0, 0) };
    if (best.n < MIN_AGREEMENT_TEXELS) return null;
    for (const step of [Math.max(1, Math.round(R / 4)), Math.max(1, Math.round(R / 16)), 1]) {
        const c = { ...best };
        const span = step === 1 ? 2 : step * 4;
        for (let dy = c.dy - span; dy <= c.dy + span; dy += step) for (let dx = c.dx - span; dx <= c.dx + span; dx += step) {
            if (Math.abs(dx) > R || Math.abs(dy) > R) continue;
            const r = corr(dx, dy);
            if (r.ncc > best.ncc + 1e-6) best = { dx, dy, ...r };
        }
    }
    return { ncc: Math.round(best.ncc * 1000) / 1000, dx: best.dx, dy: best.dy, texels: best.n };
}

/** The photo resampled onto the wall where it qualifies (see the file comment): per texel its colour, the resolution and the weight cos x sharpness. */
export function rectifyQualifying(face: MassingFace, v: GuideView): Rectified & { rejected: { facing: number; frame: number; owner: number; depth: number; coarse: number } } {
    const W = face.width, H = face.height, cam = v.camera, img = v.image;
    const rgba = new Uint8Array(W * H * 4), valid = new Uint8Array(W * H), weight = new Float32Array(W * H), pxPerM = new Float32Array(W * H);
    const rej = { facing: 0, frame: 0, owner: 0, depth: 0, coarse: 0 };
    const minCos = Math.cos((MAX_INCIDENCE_DEG * Math.PI) / 180), tilePpm = 1 / face.pixel;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const s = face.orthoSMin + (x + 0.5) * face.pixel, t = face.orthoTMax - (y + 0.5) * face.pixel;
        const p: [number, number, number] = [face.origin[0] + face.axisS[0] * s + face.axisT[0] * t, face.origin[1] + face.axisS[1] * s + face.axisT[1] * t, face.origin[2] + face.axisS[2] * s + face.axisT[2] * t];
        const toCam = [cam.eye[0] - p[0], cam.eye[1] - p[1], cam.eye[2] - p[2]];
        const dist = Math.hypot(toCam[0], toCam[1], toCam[2]);
        const cos = (toCam[0] * face.normal[0] + toCam[1] * face.normal[1] + toCam[2] * face.normal[2]) / dist;
        if (cos < minCos) { rej.facing++; continue; }
        const q = project(cam, p);
        if (!q) { rej.frame++; continue; }
        let u = q.u, w = q.v;
        if (u < 1 || w < 1 || u >= cam.width - 2 || w >= cam.height - 2) { rej.frame++; continue; }
        const pi = Math.floor(w) * cam.width + Math.floor(u);
        if (!v.ownerMask || !v.ownerMask[pi]) { rej.owner++; continue; }
        if (v.depth && !(Math.abs(v.depth[pi] - q.z) < DEPTH_TOLERANCE_M)) { rej.depth++; continue; }
        const ppm = (cam.fx / q.z) * cos;
        if (ppm < MIN_SHARPER * tilePpm) { rej.coarse++; continue; }
        if (v.warp) {
            const g = v.warp, fx = Math.max(0, Math.min(g.gw - 1, (u / cam.width) * (g.gw - 1))), fy = Math.max(0, Math.min(g.gh - 1, (w / cam.height) * (g.gh - 1)));
            const i0 = Math.min(g.gw - 2, Math.floor(fx)), j0 = Math.min(g.gh - 2, Math.floor(fy)), a = fx - i0, b = fy - j0;
            const at = (arr: Float32Array, i: number, j: number) => arr[j * g.gw + i];
            const lerp = (arr: Float32Array) => (1 - a) * (1 - b) * at(arr, i0, j0) + a * (1 - b) * at(arr, i0 + 1, j0) + (1 - a) * b * at(arr, i0, j0 + 1) + a * b * at(arr, i0 + 1, j0 + 1);
            u = Math.max(0, Math.min(cam.width - 1.001, u + lerp(g.dx))); w = Math.max(0, Math.min(cam.height - 1.001, w + lerp(g.dy)));
        }
        const x0 = Math.floor(u), y0 = Math.floor(w), fx = u - x0, fy = w - y0, iw = img.width;
        const i = y * W + x;
        for (let c = 0; c < 3; c++) {
            const val = (1 - fx) * (1 - fy) * img.rgba[(y0 * iw + x0) * 4 + c] + fx * (1 - fy) * img.rgba[(y0 * iw + x0 + 1) * 4 + c] + (1 - fx) * fy * img.rgba[((y0 + 1) * iw + x0) * 4 + c] + fx * fy * img.rgba[((y0 + 1) * iw + x0 + 1) * 4 + c];
            rgba[i * 4 + c] = Math.round(val);
        }
        rgba[i * 4 + 3] = 255;
        valid[i] = 1;
        pxPerM[i] = ppm;
        weight[i] = cos * Math.min(1, ppm / 60);
    }
    return { view: v, rgba, valid, weight, pxPerM, rejected: rej };
}

/** Per-channel linear gain photo -> wall: the median ratio over the texels both hold (sRGB decoded to linear). */
export function exposureGain(photo: Uint8Array, valid: Uint8Array, wall: Uint8Array, use: Uint8Array): [number, number, number] | null {
    const ratios: number[][] = [[], [], []];
    const N = valid.length, step = Math.max(1, Math.floor(N / 20000));
    for (let i = 0; i < N; i += step) {
        if (!valid[i] || !use[i]) continue;
        for (let c = 0; c < 3; c++) {
            const p = SRGB8_TO_LINEAR[photo[i * 4 + c]], w = SRGB8_TO_LINEAR[wall[i * 4 + c]];
            if (p > 0.02 && w > 0.02) ratios[c].push(w / p);
        }
    }
    if (ratios[0].length < MIN_GAIN_PAIRS) return null;
    const med = (a: number[]) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
    const g = ratios.map(med) as [number, number, number];
    if (g.some(x => x < GAIN_RANGE[0] || x > GAIN_RANGE[1])) return null;
    return g;
}

/**
 * Writes the qualifying Street View texels of `views` into the wall's texture (in place), adding the legend entries it
 * needs. `use` marks the wall's real texels the gain is fitted against (the tile's and the plate's; not the filled ones).
 */
export function applyStreetViewTexels(face: MassingFace, tex: FaceTexture, use: Uint8Array, views: GuideView[], legend: TexelSource[], bandTop: number): StreetViewTexelRecord {
    const W = face.width, H = face.height, N = W * H;
    const base: StreetViewTexelRecord = { face: face.index, panos: [], refused: [], texels: 0, multiTexels: 0, wallTexels: N, share: 0, bandTexels: 0, bandAll: W * Math.max(0, H - bandTop), why: '' };
    const registered = views.filter(v => v.registration && v.registration.method !== 'nominal' && v.ownerMask?.some(x => x));
    if (!views.length) return { ...base, why: 'no Street View photo of the structure' };
    if (!registered.length) return { ...base, why: `none of the ${views.length} Street View photos has a registered pose and an ownership mask` };
    const erodePx = Math.max(1, Math.round(ERODE_M / face.pixel)), featherPx = Math.max(1, Math.round(FEATHER_M / face.pixel));
    const rects: Array<Rectified & { gain: [number, number, number] | null; feather: Float32Array; own: number; agreement: number; shiftPx: [number, number] }> = [];
    const refused: StreetViewTexelRecord['refused'] = [];
    for (const v of registered) {
        const r0 = rectifyQualifying(face, v);
        let valid = erode(r0.valid, W, H, erodePx);
        let n = 0;
        for (let i = 0; i < N; i++) n += valid[i];
        if (n < MIN_TEXELS) continue;
        // the photo must show this wall: its structure against the wall's own, at the best shift
        const ag = structuralAgreement(r0.rgba, valid, tex.rgba, use, W, H, face.pixel);
        const R = Math.max(1, Math.round(MAX_SHIFT_M / face.pixel));
        const atLimit = !!ag && (Math.abs(ag.dx) >= R || Math.abs(ag.dy) >= R);
        if (!ag || ag.ncc < MIN_AGREEMENT_NCC || atLimit) {
            refused.push({ panoId: v.panoId, method: v.registration!.method, agreement: ag ? ag.ncc : null, why: !ag ? `too little overlap with the wall's own texels to check it against them (under ${MIN_AGREEMENT_TEXELS})` : atLimit ? `its best agreement with the wall (${ag.ncc.toFixed(2)}) lies at the ${MAX_SHIFT_M} m limit of the shift search (${ag.dx}, ${ag.dy} px): the pose is further off than a shift can mend` : `its structure correlates ${ag.ncc.toFixed(2)} with the wall's over ${ag.texels} texels (at least ${MIN_AGREEMENT_NCC} needed): the pose puts something else on this wall` });
            continue;
        }
        const r: Rectified = ag.dx || ag.dy ? { view: v, rgba: shiftedPlane(r0.rgba, W, H, ag.dx, ag.dy, 4), valid: shiftedPlane(r0.valid, W, H, ag.dx, ag.dy, 1), weight: shiftedPlane(r0.weight, W, H, ag.dx, ag.dy, 1), pxPerM: shiftedPlane(r0.pxPerM, W, H, ag.dx, ag.dy, 1) } : r0;
        if (ag.dx || ag.dy) valid = shiftedPlane(valid, W, H, ag.dx, ag.dy, 1);
        const gain = exposureGain(r.rgba, valid, tex.rgba, use);
        if (gain) for (let i = 0; i < N; i++) if (valid[i]) for (let c = 0; c < 3; c++) r.rgba[i * 4 + c] = linearToSrgb8(SRGB8_TO_LINEAR[r.rgba[i * 4 + c]] * gain[c]);
        const d = insideDistance(valid, W, H, featherPx);
        const feather = new Float32Array(N);
        for (let i = 0; i < N; i++) feather[i] = valid[i] ? Math.min(1, d[i] / featherPx) : 0;
        rects.push({ ...r, valid, gain, feather, own: n, agreement: ag.ncc, shiftPx: [ag.dx, ag.dy] });
    }
    if (!rects.length) return { ...base, refused, why: refused.length ? `${refused.length} registered photo${refused.length === 1 ? '' : 's'} refused: ${refused.map(x => `${x.panoId} (${x.method} pose): ${x.why}`).join('; ')}` : `no registered photo resolves the wall at least ${MIN_SHARPER}x finer than the tile (${Math.round(1 / face.pixel)} px/m) over ${MIN_TEXELS} owned texels within ${MAX_INCIDENCE_DEG} degrees of its normal` };
    const single = legendIndex(legend, STREET_VIEW_TEXEL_SOURCE, false, rects.map(r => r.view));
    const multi = legendIndex(legend, STREET_VIEW_TEXEL_SOURCE_MULTI, true, rects.map(r => r.view));
    const counts = rects.map(() => 0);
    let texels = 0, multiTexels = 0, band = 0;
    const acc = [0, 0, 0];
    for (let i = 0; i < N; i++) {
        let wsum = 0, k0 = -1, k1 = -1;
        acc[0] = acc[1] = acc[2] = 0;
        for (let k = 0; k < rects.length; k++) {
            const r = rects[k];
            if (!r.valid[i]) continue;
            const w = r.feather[i] * r.weight[i];
            if (!(w > 0)) continue;
            wsum += w;
            for (let c = 0; c < 3; c++) acc[c] += w * r.rgba[i * 4 + c];
            if (k0 < 0) k0 = k; else if (k1 < 0) k1 = k;
        }
        if (!(wsum > 0)) continue;
        // the feather: at the region's edge the photo fades into what the texel had
        let f = 0;
        for (let k = 0; k < rects.length; k++) if (rects[k].valid[i]) f = Math.max(f, rects[k].feather[i]);
        for (let c = 0; c < 3; c++) tex.rgba[i * 4 + c] = Math.round(f * (acc[c] / wsum) + (1 - f) * tex.rgba[i * 4 + c]);
        tex.rgba[i * 4 + 3] = 255;
        let agree = false;
        if (k1 >= 0) {
            const a = rects[k0].rgba, b = rects[k1].rgba;
            const dl = lum(a[i * 4], a[i * 4 + 1], a[i * 4 + 2]) - lum(b[i * 4], b[i * 4 + 1], b[i * 4 + 2]);
            const dr = a[i * 4] - b[i * 4], dg = a[i * 4 + 1] - b[i * 4 + 1], db = a[i * 4 + 2] - b[i * 4 + 2];
            // CIE76 is about 0.4 of the sRGB distance for the mid tones; the limit is set in those terms
            agree = Math.sqrt(dr * dr + dg * dg + db * db) * 0.4 <= AGREE_DELTA_E && Math.abs(dl) * 0.4 <= AGREE_DELTA_E;
        }
        tex.source[i] = agree ? multi : single;
        texels++;
        if (agree) multiTexels++;
        if (Math.floor(i / W) >= bandTop) band++;
        counts[k0]++;
    }
    const panos = rects.map((r, k) => {
        const ppm: number[] = [];
        for (let i = 0; i < N; i += 17) if (r.valid[i]) ppm.push(r.pxPerM[i]);
        ppm.sort((a, b) => a - b);
        return { panoId: r.view.panoId, method: r.view.registration!.method, residualM: r.view.registration!.residualM, texels: counts[k], pxPerM: Math.round(ppm.length ? ppm[ppm.length >> 1] : 0), gain: r.gain ? r.gain.map(g => Math.round(g * 100) / 100) as [number, number, number] : null, agreement: r.agreement, shiftPx: r.shiftPx };
    });
    return {
        ...base, panos, refused, texels, multiTexels, share: N ? texels / N : 0, bandTexels: band,
        why: `${texels} texels (${(100 * (N ? texels / N : 0)).toFixed(0)}% of the wall, ${base.bandAll ? Math.round((100 * band) / base.bandAll) : 0}% of its street-level band) from ${panos.filter(p => p.texels).map(p => `${p.panoId} (${p.method} pose, agreement ${p.agreement.toFixed(2)} at shift ${p.shiftPx.join(',')} px, ${p.pxPerM} px/m${p.gain ? `, gain ${p.gain.join('/')}` : ', own exposure'})`).join(', ')}; ${multiTexels} where two photos agree${refused.length ? `; refused ${refused.map(x => `${x.panoId} (${x.why})`).join('; ')}` : ''}`
    };
}

function legendIndex(legend: TexelSource[], source: string, multi: boolean, views: GuideView[]): number {
    const k = legend.findIndex(l => l.source === source);
    if (k >= 0) return k;
    const poses = [...new Set(views.map(v => `${v.registration?.method ?? 'nominal'} pose${v.registration?.residualM !== null && v.registration?.residualM !== undefined ? ` (${v.registration.residualM.toFixed(2)} m)` : ''}`))].join(', ');
    legend.push({
        source, label: 'photo-inferred',
        method: `${multi ? 'two registered Street View photos that agree (CIE76 within ' + AGREE_DELTA_E + ')' : 'a registered Street View photo'} projected onto the wall through the pose registered against the tile mesh (${poses}), only where the photo pixel is owned (the structure, nothing in front), the massing is the nearest surface and the photo resolves the wall at least ${MIN_SHARPER}x finer than the tile ortho within ${MAX_INCIDENCE_DEG} degrees of its normal; exposure matched to the wall by a per-channel linear gain, feathered over ${FEATHER_M} m`,
        rung: TEXTURE_LADDER_RUNGS.indexOf(multi ? 'street-view multi-view blend' : 'street-view single view'), weight: multi ? 0.8 : 0.6
    });
    return legend.length - 1;
}
