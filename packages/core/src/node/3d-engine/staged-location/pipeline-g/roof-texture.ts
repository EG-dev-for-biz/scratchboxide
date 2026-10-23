/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G's roof texture: the roof surveyed from above and redrawn, never the tile photo itself. The street and aerial
 * stations are planned for walls and see a roof at a glancing angle, or not at all where taller neighbours stand in the
 * way; a camera above the roof looking down (ROOF_TILT_DEG off vertical: the station's up is the world's) sees all of it
 * and nothing can stand between. Each roof face of the massing gets a metric plate from it (plates.ts, as the walls do);
 * the plate is resampled onto the built roof (what stands more than PLATE_PROUD_M above it is not the roof: those objects
 * are built as parts, roof-objects.ts) and redrawn by the image model as a clean orthographic texture of the same roof,
 * the AI Beautify texture-plate rules for a roof: same layout, every edge and object footprint where it is, what no camera
 * saw continued as the roof continues, even overcast light. It is kept when its edges stay on the plate's (the alignment
 * gate pipeline E's redraws use) and labelled generated; otherwise the roof keeps its painted colour, with the reason.
 */

import { IMAGE_MODEL_PRIORITY } from '../../../../common/media-generation-protocol';
import { stationFromLookAt } from '../../../../common/spatial/SurveySynthesisEngine';
import type { ColmapCameraPose, GeodeticAnchor } from '../../../../common/spatial/colmap-vector-reference-types';
import { encodePng } from '../png-encode';
import { decodeImageInMemory, type RgbaImage8 } from '../tile-texture-transfer';
import { padToModelAspect, resizeRgba } from '../texture-enhance';
import type { FaceTexture } from '../pipeline-e/massing-glb';
import { alignPlate, cachedPlate, type PlateModelClient } from '../pipeline-e/enhance';
import type { MassingFace } from '../pipeline-e/native-massing';
import type { Plate } from './plates';
import { STATION_OPTICS } from './stations';

type V3 = [number, number, number];

/** The roof camera's tilt off straight down (a station's up is the world's, so straight down has no frame). */
export const ROOF_TILT_DEG = 10;
/** The roof fills its frame with this margin. */
export const ROOF_MARGIN = 1.2;
/** A redraw is kept when its edges stay within this of the plate's (pixels) and it loses no more than this share of them. */
export const ROOF_MAX_CHAMFER_PX = 6;
export const ROOF_MAX_LOST_SHARE = 0.6;
/** The longest side sent to the image model. */
export const ROOF_MAX_SIDE = 1536;
export const ROOF_PLATE_PROMPT_ID = 'roof-plate/v1';

const corners = (f: MassingFace): V3[] => [[f.sMin, f.tMin], [f.sMax, f.tMin], [f.sMax, f.tMax], [f.sMin, f.tMax]].map(([s, t]) => [0, 1, 2].map(k => f.origin[k] + s * f.axisS[k] + t * f.axisT[k]) as V3);

/**
 * One station above each group of roof faces: looking down ROOF_TILT_DEG off vertical at the faces' centre, high enough
 * that their plan extent fills the frame with ROOF_MARGIN. Faces that face downward (soffits) are not roofs.
 */
export function roofStations(roofs: MassingFace[], anchor: GeodeticAnchor, firstId: number): Array<{ station: ColmapCameraPose; faces: number[] }> {
    const up = roofs.map((f, i) => ({ f, i })).filter(x => x.f.normal[1] > 0.3);
    if (!up.length) return [];
    let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
    for (const { f } of up) for (const p of corners(f)) { lo = [0, 1, 2].map(k => Math.min(lo[k], p[k])) as V3; hi = [0, 1, 2].map(k => Math.max(hi[k], p[k])) as V3; }
    const centre: V3 = [(lo[0] + hi[0]) / 2, hi[1], (lo[2] + hi[2]) / 2];
    // the frame is 16:9: the plan's larger side against the horizontal field, the smaller against the vertical
    const hfov = 2 * Math.atan(STATION_OPTICS.sensorWidthMm / (2 * STATION_OPTICS.focalLengthMm)), vfov = 2 * Math.atan(Math.tan(hfov / 2) / STATION_OPTICS.aspectRatio);
    const a = Math.max(hi[0] - lo[0], hi[2] - lo[2]), b = Math.min(hi[0] - lo[0], hi[2] - lo[2]);
    const dist = ROOF_MARGIN * Math.max(a / 2 / Math.tan(hfov / 2), b / 2 / Math.tan(vfov / 2));
    const tilt = (ROOF_TILT_DEG * Math.PI) / 180;
    // the eye above the centre, set back along the plan's shorter axis so the longer one runs across the frame
    const along: V3 = hi[0] - lo[0] >= hi[2] - lo[2] ? [0, 0, 1] : [1, 0, 0];
    const eye: V3 = [centre[0] + along[0] * dist * Math.sin(tilt), centre[1] + dist * Math.cos(tilt), centre[2] + along[2] * dist * Math.sin(tilt)];
    return [{ station: stationFromLookAt(firstId, eye, centre, STATION_OPTICS, anchor, { name: 'G_roof_0' }), faces: up.map(x => x.i) }];
}

/** A plate texel no station hit, with seen texels this close on two opposite sides, is filled from them. */
export const GAP_RADIUS_PX = 2;

/**
 * Closes the gaps a distant station leaves in a plate: its pixels are coarser than the plate's texels, so what it saw lands
 * as a grid of dots. A texel no station hit takes the inverse-distance mean colour and relief of the seen texels within
 * GAP_RADIUS_PX when they lie on two opposite sides of it, left and right or above and below (a gap inside what was seen;
 * the edge of what was not has them on one side only); the plate's coverage is recounted. Returns the number of texels filled.
 */
export function closePlateGaps(pl: Plate, radius = GAP_RADIUS_PX): number {
    const { w, h } = pl;
    const seen = (j: number) => !Number.isNaN(pl.relief[j]);
    const fill: Array<{ j: number; rgb: [number, number, number]; relief: number }> = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const j = y * w + x;
        if (seen(j)) continue;
        const sides = [false, false, false, false];
        let sw = 0, r = 0, g = 0, b = 0, rel = 0;
        for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const k = yy * w + xx;
            if (!seen(k)) continue;
            if (dx < 0) sides[0] = true; if (dx > 0) sides[1] = true; if (dy < 0) sides[2] = true; if (dy > 0) sides[3] = true;
            const wt = 1 / Math.hypot(dx, dy);
            sw += wt; r += wt * pl.rgb[k * 3]; g += wt * pl.rgb[k * 3 + 1]; b += wt * pl.rgb[k * 3 + 2]; rel += wt * pl.relief[k];
        }
        if (((sides[0] && sides[1]) || (sides[2] && sides[3])) && sw > 0) fill.push({ j, rgb: [Math.round(r / sw), Math.round(g / sw), Math.round(b / sw)], relief: rel / sw });
    }
    for (const f of fill) { pl.rgb.set(f.rgb, f.j * 3); pl.relief[f.j] = f.relief; }
    let cov = 0;
    for (let j = 0; j < w * h; j++) if (seen(j)) cov++;
    pl.coverage = cov / (w * h);
    return fill.length;
}

export function roofPlatePrompt(o: { locationName: string; widthM: number; heightM: number; widthPx: number; heightPx: number }): string {
    return `Transform this orthographic texture plate of the roof of ${o.locationName} (a flat view straight down onto the roof, ${o.widthM.toFixed(1)} m by ${o.heightM.toFixed(1)} m, resampled from a photorealistic 3D tiles scan) into a clean, photorealistic texture plate of the same roof. CRITICAL RULES — non-negotiable: (1) It stays a flat orthographic view straight down: no perspective, no camera tilt, no depth of field, no haze. (2) Keep every edge, parapet, joint, drain, hatch and the footprint of every object on the roof exactly where it is, at the same size and orientation. (3) The flat mid-grey areas are parts of this same roof that the survey could not see, or the footprints of objects standing on it: fill each as the roof around it continues, with the same surface, colour and joint pattern, and add no objects, lettering or features that the plate does not show. (4) Give it crisp, realistic roofing materials (membrane, gravel, metal, tiles, glass or whatever the plate shows), free of scan blur and smears. (5) Light it evenly, as under a bright overcast sky: no cast shadows, no sun hot spots. Answer with the full plate at ${o.widthPx} x ${o.heightPx} px.`;
}

export interface RoofTextureRecord { face: number; accepted: boolean; why: string; model?: string; chamferPx?: number; lostShare?: number; covered: number }

/**
 * Redraws one built roof face's texture from its survey plate (resampled onto it: `tex`, with `use` marking what a station
 * saw of the roof itself) and writes it over the face's paint when its edges hold. Returns what was done and why.
 */
export async function redrawRoof(f: MassingFace, painted: FaceTexture, on: { tex: FaceTexture; use: Uint8Array; covered: number }, opts: {
    client: PlateModelClient; models?: string[]; locationName: string; source: number; cacheDir?: string; signal?: AbortSignal;
}): Promise<RoofTextureRecord> {
    const W = on.tex.width, H = on.tex.height, N = W * H;
    // what no station saw goes to the model mid-grey, to be continued as the roof
    const sent = on.tex.rgba.slice();
    for (let i = 0; i < N; i++) if (!on.use[i]) { sent[i * 4] = 128; sent[i * 4 + 1] = 128; sent[i * 4 + 2] = 128; sent[i * 4 + 3] = 255; }
    const k = Math.min(1, ROOF_MAX_SIDE / Math.max(W, H));
    const small = resizeRgba({ width: W, height: H, rgba: sent }, Math.max(8, Math.round(W * k)), Math.max(8, Math.round(H * k)));
    const { padded, offset } = padToModelAspect(small);
    const prompt = roofPlatePrompt({ locationName: opts.locationName, widthM: W * f.pixel, heightM: H * f.pixel, widthPx: padded.width, heightPx: padded.height });
    const answer = await cachedPlate(opts.cacheDir, { prompt, image: new Uint8Array(encodePng(padded.width, padded.height, Buffer.from(padded.rgba), 4)), width: padded.width, height: padded.height, models: opts.models ?? [IMAGE_MODEL_PRIORITY[0]], ...(opts.signal ? { signal: opts.signal } : {}) }, opts.client);
    let img: RgbaImage8 = decodeImageInMemory(Buffer.from(answer.bytes));
    // back to the padded frame, the padding cut off, then to the face's raster
    img = resizeRgba(img, padded.width, padded.height);
    const crop = new Uint8Array(small.width * small.height * 4);
    for (let y = 0; y < small.height; y++) crop.set(img.rgba.subarray(((y + offset[1]) * padded.width + offset[0]) * 4, ((y + offset[1]) * padded.width + offset[0] + small.width) * 4), y * small.width * 4);
    const back = resizeRgba({ width: small.width, height: small.height, rgba: crop }, W, H).rgba;
    const g = alignPlate(on.tex.rgba, back, W, H, on.use, f.pixel);
    const rec: RoofTextureRecord = { face: f.index, accepted: false, why: '', model: answer.modelUsed, chamferPx: g.chamferPx, lostShare: g.lostShare, covered: +on.covered.toFixed(3) };
    if (!(g.chamferPx <= ROOF_MAX_CHAMFER_PX) || !(g.lostShare <= ROOF_MAX_LOST_SHARE)) {
        rec.why = `the redraw moved the roof's edges (chamfer ${g.chamferPx.toFixed(2)} px, ${Math.round(100 * g.lostShare)}% of the plate's edges lost; at most ${ROOF_MAX_CHAMFER_PX} px and ${100 * ROOF_MAX_LOST_SHARE}%): the roof keeps its painted colour`;
        return rec;
    }
    for (let i = 0; i < N; i++) {
        painted.rgba[i * 4] = g.aligned[i * 4]; painted.rgba[i * 4 + 1] = g.aligned[i * 4 + 1]; painted.rgba[i * 4 + 2] = g.aligned[i * 4 + 2]; painted.rgba[i * 4 + 3] = 255;
        painted.source[i] = opts.source;
    }
    rec.accepted = true;
    rec.why = `redrawn from its survey plate (${Math.round(100 * on.covered)}% of it seen from above), edges held (chamfer ${g.chamferPx.toFixed(2)} px, ${Math.round(100 * g.lostShare)}% lost)`;
    return rec;
}
