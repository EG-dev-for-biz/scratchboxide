/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The district's aerial paint (SCRATCHBOX_STAGED_DISTRICT_PAINT=1, off by default): the rebuilt massing's atlas
 * repainted from the air, after CityPaint's method (arXiv 2610.27564) on our own image model (IMAGE_MODEL_PRIORITY)
 * and our own evidence. From the air most of what shows is the district, and its massing carries the tile photo at
 * 15 cm, smeared where the photo did not reach and one flat colour on walls it hardly saw.
 *
 *   sweep      cameras in strips over the district, one strip set per grid heading, each camera at the smoothed
 *              height of the massing beneath it plus a margin (CityPaint's height-aware cameras), looking down at
 *              pitchDeg with hfovDeg;
 *   top K      before any image is asked for, each planar face's views are scored by its visible projected area
 *              (depth-tested against the massing itself) and only its best K views, each at least rho of its best,
 *              may write it (CityPaint's face-wise top-K bake; averaging every view is what blurs);
 *   per view   in order, two images go to the image model: the massing as its atlas stands now (atlas feedback:
 *              every face an earlier view painted shows painted; texels no photo reached show in a key colour), and
 *              the tile scan from the same camera, the evidence of what is there. The answer is kept only when the
 *              texture-enhance gate passes over everything that is not key colour (edges stay put, nothing new,
 *              the layout and hue kept: RECREATE_GATE, which lets the light change) and no key colour is left;
 *   bake       each accepted view writes the faces it is among the best K of, by its incidence (cos squared), into
 *              the texels the photo did not set: a texel the tile photo set keeps the photo's colour below lowBandM
 *              and takes the image model's detail above it; a texel filled from the nearest photo texel, a flat
 *              facade median or anything generated takes the painted colour; a repeat fill is replaced only where
 *              the painted low band agrees with it.
 *
 * Every texel it writes is labelled generated in the confidence channel (its own provenance entries, added after the
 * stage's legend), with the views and models that answered in the report; a face with no accepted view keeps its
 * texels and the report says why. Image bytes stay in memory; the views' renders and answers are written beside the
 * layer for review.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { parseGlbBytes, replaceGlbImages, type ParsedGlb } from './glb-bytes';
import { readGlbScene, renderTexturedView, PLATE_EMPTY_DEPTH, type FrameCamera, type TexturedPrimitive } from '../../spatial/StreetViewPoseRegistrar';
import { decodeImageInMemory, type RgbaImage8 } from './tile-texture-transfer';
import { enhancementGate, resizeRgba, RECREATE_GATE, type EnhanceGateMetrics, type EnhanceGateThresholds } from './texture-enhance';
import { generateImageWithModels } from '../../google-media-generation-service';
import { IMAGE_MODEL_PRIORITY, nearestImageAspectRatio, type SkippedMediaModel } from '../../../common/media-generation-protocol';
import { EVEN_LIGHT_SENTENCE } from '../../../browser/generative-canvas/services/location-beautify-service';
import { TEXTURE_LADDER_RUNGS } from '../../../common/spatial/texture-pass-contracts';
import { encodePng } from '../../texture-processing';
import { blur1 } from '../../spatial/StreetViewStage3Metrics';
import { PHOTO_JPEG_QUALITY, type TexelSource } from './pipeline-e/massing-glb';

export const DISTRICT_PAINT_VERSION = 'district-aerial-paint/1';

/** The aerial paint runs on a district's rebuilt massing only when SCRATCHBOX_STAGED_DISTRICT_PAINT=1. */
export function districtPaintEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_DISTRICT_PAINT?.trim() === '1';
}

export const DISTRICT_PAINT_PARAMS = {
    /** CityPaint's sweep camera: looking down this far below the horizon, with this horizontal field of view. */
    pitchDeg: 48, hfovDeg: 40,
    /** The render and the answer, px (16:9, the image model's 1K frame). */
    width: 1344, height: 768, imageSize: '1K' as '1K' | '2K' | '4K',
    /** Height-aware cameras: the massing's highest point per cellM cell, averaged over smoothM, lifted by marginM; never under the highest point within clearRadiusM plus clearM. */
    cellM: 4, smoothM: 40, marginM: 60, clearRadiusM: 30, clearM: 25,
    /** Neighbouring views overlap by this share of their ground footprint, across and along a strip. */
    overlap: 0.4,
    /** At most this many views; a larger sweep is spread wider to fit. */
    maxViews: 120,
    /** Top K: a face is written by at most K views, each scoring at least rho of its best and at least minScorePx visible pixels. */
    topK: 2, rho: 0.25, minScorePx: 400,
    /** Samples per face for its view scores (spread by area). */
    scoreSamples: 160,
    /** Views seen more edge-on than this |cos| do not write a texel. */
    minCos: 0.12,
    /** Depth test: a texel is seen when it lies within max(depthTolM, depthTolRel x depth) of the massing's own depth there. */
    depthTolM: 0.35, depthTolRel: 0.01,
    /** Texels no photo reached are drawn in this colour in the view sent to the model. */
    key: [255, 0, 255] as [number, number, number],
    /**
     * A key pixel is left when the answer is within this RGB distance of the key; at most maxKeyLeft of the key pixels may
     * be, and none of them is baked (bakeFace skips an answer pixel near the key).
     */
    keyDistance: 70, maxKeyLeft: 0.1,
    /**
     * A view more than this share empty (nothing of the district in it: its edge) is not asked for: the model fills the
     * empty with invented buildings (a view at Penn's edge, 2026-11-02, came back a whole new block).
     */
    maxEmptyShare: 0.2,
    /**
     * The texture-enhance gate's measures over the non-key pixels (texture-enhance.ts), reported for every answer; of them
     * only the hue (lowBandChromaDeltaE, at most maxLowBandChromaDeltaE) decides. Its edge and layout measures cannot
     * tell a moved frame from a restyled one: the first real answers at Penn (run of 2026-11-02) kept every street in
     * place, relit everything evenly as asked and redrew the soft facades' windows, and scored edge NCC 0.66 to 0.88 and
     * low-band SSIM 0.6 to 0.7 at any blur from 6 to 16 px. Registration is judged block by block instead (`registration`).
     */
    gate: { ...RECREATE_GATE, edgeScaleSigmaPx: 6, maxNewEdgeDistPx: 6, minEdgeNcc: 0.9, maxNewEdgeShare: 0.15, minSharpnessGain: 0 } as EnhanceGateThresholds,
    /**
     * Registration, block by block (registrationCheck): the frame in blockPx blocks; each block with enough edge in the
     * view is matched against the answer over shifts up to searchPx, and counts as matched when its best edge NCC is at
     * least minNcc. A block the model redrew matches nowhere and is not counted against the answer; a moved, zoomed or
     * turned frame matches at a shift. The answer is registered when at least minMatchedShare of the textured blocks
     * matched, and at least minInPlaceShare of those matched within maxShiftPx of where they were.
     */
    registration: { blockPx: 96, searchPx: 24, edgeSigmaPx: 1.5, minEdge: 4, minNcc: 0.45, maxShiftPx: 2, minMatchedShare: 0.25, minInPlaceShare: 0.8 },
    /**
     * The answer's own warp (fitAnswerWarp): the image model returns the view slightly moved and rescaled (the first ten
     * views at Penn, 2026-11-02: 1 to 7 px and up to 0.8%, one affine explaining every matched block to 0.5 to 0.8 px).
     * An affine is fitted to the matched blocks (Huber-reweighted) and the answer warped back onto the view when at
     * least minMatchedShare of the textured blocks matched, the median residual is at most maxResidualPx with at least
     * minInlierShare within inlierPx, and the warp is near the identity (scale within maxScaleChange, turn within
     * maxTurnDeg). An answer that redrew the scene matches few blocks, or matches them with no one warp, and is not kept.
     */
    warp: { minMatchedShare: 0.5, maxResidualPx: 1.0, inlierPx: 2, minInlierShare: 0.75, maxScaleChange: 0.03, maxTurnDeg: 1 },
    /**
     * Where the photo set a texel, the answer's detail is taken only where it agrees with the photo's own detail there
     * (detailAgreement: the local NCC of the two high bands, over a window of windowPx, at least minNcc): a window the
     * model drew where the photo has none is not laid over the photo. Texels no photo reached take the answer as it is.
     */
    detail: { highBandSigmaPx: 3, windowPx: 15, minNcc: 0.3 },
    /**
     * Pixels within this many px of a key pixel or of empty background are not gated (the fill's own new edges), and
     * never fewer than 3 x the gate's edge blur: inside that reach the blurred key edge still differs from the painted one.
     */
    gateErodePx: 3,
    /** An answer is judged only when at least this share of the frame can be gated; else it cannot be checked and is not kept. */
    minGateShare: 0.05,
    /** The massing shows over the scan where it lies no farther than this behind it (m, and share of the depth): the massing is fitted to the scan. */
    massingWinsM: 3, massingWinsRel: 0.03,
    /** Asks per view before it is given up (the first plus rerolls). */
    attempts: 2,
    /** Where the photo set a texel: its colour below this scale (m), the answer's detail above it. */
    lowBandM: 1.0,
    /** The atlas's texel edge (m): the district massing's DISTRICT_TEXEL_M. */
    texelM: 0.15,
    /** A repeat-filled texel is repainted only where the painted low band is within this CIE76 of the repeat's. */
    repeatMaxDeltaE: 12,
    /** Estimated price of one answer (USD), for the run's cost estimate; the model's bill is the record. */
    usdPerImage: 0.07
};
export type DistrictPaintParams = typeof DISTRICT_PAINT_PARAMS;

const DEG = Math.PI / 180;
type V3 = [number, number, number];

// =============================================================================
// Model client (injected)
// =============================================================================

export interface PaintModelRequest {
    label: string;
    models: string[];
    prompt: string;
    /** The massing as its atlas stands, from this camera (PNG). */
    view: { bytes: Uint8Array; width: number; height: number };
    /** The tile scan from the same camera (PNG). */
    reference: { bytes: Uint8Array };
    imageSize?: string;
    signal?: AbortSignal;
}

export interface PaintModelAnswer {
    bytes: Uint8Array;
    mimeType: string;
    modelUsed: string;
    skippedModels?: SkippedMediaModel[];
    modelNote?: string;
}

export type PaintModelClient = (request: PaintModelRequest) => Promise<PaintModelAnswer>;

/** The production client: a Google Gen AI SDK client through generateImageWithModels. */
export function genAiPaintClient(genai: unknown): PaintModelClient {
    return async request => {
        const parts: any[] = [  // eslint-disable-line @typescript-eslint/no-explicit-any
            { text: request.prompt },
            { text: 'Image 1 (the district model, to return repainted):' },
            { inlineData: { mimeType: 'image/png', data: Buffer.from(request.view.bytes).toString('base64') } },
            { text: 'Image 2 (the photogrammetry scan from the same camera, evidence only):' },
            { inlineData: { mimeType: 'image/png', data: Buffer.from(request.reference.bytes).toString('base64') } }
        ];
        const answer = await generateImageWithModels(genai, {
            models: request.models, contents: [{ role: 'user', parts }],
            imageConfig: { aspectRatio: nearestImageAspectRatio(request.view.width, request.view.height), ...(request.imageSize ? { imageSize: request.imageSize } : {}) },
            signal: request.signal
        });
        return {
            bytes: new Uint8Array(answer.data.buffer, answer.data.byteOffset, answer.data.byteLength), mimeType: answer.mimeType,
            modelUsed: answer.modelUsed, skippedModels: answer.skippedModels, modelNote: answer.modelNote
        };
    };
}

export function paintPrompt(width: number, height: number, pitchDeg: number): string {
    return [
        `Image 1 is a ${width} x ${height} px aerial view of a city district, seen from above, looking ${pitchDeg} degrees down. Most buildings are rebuilt as clean solids whose walls and roofs carry a texture taken from aerial photogrammetry, so they look soft and smeared; the streets and anything not rebuilt are the photogrammetry itself. Surfaces drawn in flat magenta are walls or roofs no photo reached.`,
        'Image 2 is the photogrammetry scan alone, from the same camera: the true appearance of the place, with melted geometry.',
        `Return image 1, ${width} x ${height} px, as a sharp, believable aerial photograph of the same buildings. Keep every building edge, roofline, corner and wall exactly where image 1 has it, at the same size, and keep each surface's colour and material as image 1 shows it.`,
        'Restore crisp fine detail - windows, mullions, cornices, roof equipment, paving joints - where image 1 and image 2 agree there is such detail.',
        'Paint every magenta surface as the rest of the same building: continue its own facade or roof, its window rhythm, materials and colour, using image 2 as evidence of what is there. No magenta may remain.',
        EVEN_LIGHT_SENTENCE,
        'Do not add trees, vehicles, people, signs, text or buildings; leave any black background black; no crop, zoom, rotation or border.'
    ].join(' ');
}

// =============================================================================
// The target: the massing's atlas pages and the primitives drawn with them
// =============================================================================

/** What a texel of the atlas is, read from its confidence ladder rung: what the paint may do with it. */
export const TEXEL = { none: 0, photo: 1, repeat: 2, fill: 3 } as const;
const RUNG_PHOTO_MAX = TEXTURE_LADDER_RUNGS.indexOf('tile photo transfer');
const RUNG_REPEAT = TEXTURE_LADDER_RUNGS.indexOf('repeated same-plane fill');

const RUNG_CLAY = TEXTURE_LADDER_RUNGS.length - 1;

/**
 * The paint's class of an atlas texel from its confidence RGBA (A 255 where a source produced it; B the ladder rung).
 * A face texel no source produced is packed with A 0 and the clay rung (massing-glb.ts packFaces) and renders black:
 * it is fill, the paint's to draw; A 0 with any other rung is page the packer never used.
 */
export function texelClassOf(conf: ArrayLike<number>, i: number): number {
    if (conf[i * 4 + 3] !== 255) return conf[i * 4 + 2] === RUNG_CLAY ? TEXEL.fill : TEXEL.none;
    const rung = conf[i * 4 + 2];
    return rung <= RUNG_PHOTO_MAX ? TEXEL.photo : rung === RUNG_REPEAT ? TEXEL.repeat : TEXEL.fill;
}

interface PaintPage {
    albedoImage: number; confImage: number; mime: string;
    width: number; height: number;
    albedo: Uint8Array; conf: Uint8Array; cls: Uint8Array;
    /** What the renders show: the albedo, key colour on fill texels not painted yet, painted colour once they are. */
    display: Buffer;
    /** The painted colour (running weighted mean) and its weight, allocated when a view first writes the page. */
    paint?: Float32Array; weight?: Float32Array;
}

interface PaintPrim { positions: Float32Array; indices: Uint32Array; uvs: Float32Array | null; page: number | null; image: RgbaImage8 | null }

/** A planar face of one primitive: its triangles, normal and area. */
export interface PaintFace { prim: number; tris: number[]; normal: V3; areaM2: number }

export interface PaintTarget { glb: ParsedGlb; prims: PaintPrim[]; pages: PaintPage[]; faces: PaintFace[] }

const asBuffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

/** Reads a massing layer (pipeline-e/massing-glb.ts): its atlas pages with their confidence, and every primitive. */
export function loadPaintTarget(glbPath: string, P: DistrictPaintParams = DISTRICT_PAINT_PARAMS): PaintTarget {
    const glb = parseGlbBytes(fs.readFileSync(glbPath));
    const json = glb.json;
    const imageOfTexture = (t: number | undefined) => (t === undefined ? undefined : json.textures?.[t]?.source as number | undefined);
    const imageBytes = (im: number) => { const v = json.bufferViews[json.images[im].bufferView]; return glb.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength); };
    const pages: PaintPage[] = [];
    const pageOfMaterial = new Map<number, number>();
    (json.materials ?? []).forEach((m: any, mi: number) => {  // eslint-disable-line @typescript-eslint/no-explicit-any
        const albedoImage = imageOfTexture(m.pbrMetallicRoughness?.baseColorTexture?.index), confImage = imageOfTexture(m.extras?.sbTexture?.confidenceTexture);
        if (albedoImage === undefined || confImage === undefined || !/^page_\d+_albedo$/.test(json.images[albedoImage].name ?? '')) return;
        const a = decodeImageInMemory(imageBytes(albedoImage)), c = decodeImageInMemory(imageBytes(confImage));
        if (a.width !== c.width || a.height !== c.height) throw new Error(`${path.basename(glbPath)}: page ${json.images[albedoImage].name} and its confidence differ in size`);
        const N = a.width * a.height, cls = new Uint8Array(N), display = Buffer.from(a.rgba);
        for (let i = 0; i < N; i++) {
            cls[i] = texelClassOf(c.rgba, i);
            if (cls[i] === TEXEL.fill) display.set(P.key, i * 4);
        }
        pageOfMaterial.set(mi, pages.length);
        pages.push({ albedoImage, confImage, mime: json.images[albedoImage].mimeType ?? 'image/png', width: a.width, height: a.height, albedo: a.rgba, conf: c.rgba, cls, display });
    });
    const prims: PaintPrim[] = readGlbScene(glbPath).map(p => ({
        positions: p.positions, indices: p.indices, uvs: p.uvs,
        page: p.materialIndex !== null && pageOfMaterial.has(p.materialIndex) ? pageOfMaterial.get(p.materialIndex)! : null,
        image: p.materialIndex !== null && pageOfMaterial.has(p.materialIndex) ? null : (p.image ? decodeImageInMemory(p.image) : null)
    }));
    return { glb, prims, pages, faces: planarFaces(prims) };
}

/** The planar faces of the paged primitives: triangles of one primitive grouped by plane (normal to 0.05, offset to 0.25 m). */
export function planarFaces(prims: Array<Pick<PaintPrim, 'positions' | 'indices' | 'page'>>): PaintFace[] {
    const faces: PaintFace[] = [];
    prims.forEach((p, pi) => {
        if (p.page === null) return;
        const byKey = new Map<string, PaintFace>();
        const P = p.positions, I = p.indices;
        for (let t = 0; t < I.length / 3; t++) {
            const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
            const ex = P[b] - P[a], ey = P[b + 1] - P[a + 1], ez = P[b + 2] - P[a + 2], gx = P[c] - P[a], gy = P[c + 1] - P[a + 1], gz = P[c + 2] - P[a + 2];
            let nx = ey * gz - ez * gy, ny = ez * gx - ex * gz, nz = ex * gy - ey * gx;
            const len = Math.hypot(nx, ny, nz);
            if (len < 1e-9) continue;
            nx /= len; ny /= len; nz /= len;
            const d = nx * P[a] + ny * P[a + 1] + nz * P[a + 2];
            const key = `${Math.round(nx * 20)},${Math.round(ny * 20)},${Math.round(nz * 20)},${Math.round(d * 4)}`;
            let f = byKey.get(key);
            if (!f) { f = { prim: pi, tris: [], normal: [nx, ny, nz], areaM2: 0 }; byKey.set(key, f); faces.push(f); }
            f.tris.push(t); f.areaM2 += len / 2;
        }
    });
    return faces;
}

// =============================================================================
// The sweep
// =============================================================================

export interface AerialView { id: number; headingDeg: number; strip: number; eye: V3; lookAt: V3; camera: FrameCamera }

/** A frame camera at `eye`, heading clockwise from north (-z in the tile frame), pitched down by pitchDeg. */
export function aerialCamera(eye: V3, headingDeg: number, pitchDeg: number, hfovDeg: number, width: number, height: number): FrameCamera {
    const th = headingDeg * DEG, ph = pitchDeg * DEG;
    const fwd: V3 = [Math.sin(th) * Math.cos(ph), -Math.sin(ph), -Math.cos(th) * Math.cos(ph)];
    const rl = Math.hypot(fwd[2], fwd[0]);
    const right: V3 = [-fwd[2] / rl, 0, fwd[0] / rl];
    const up: V3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const fx = width / 2 / Math.tan((hfovDeg * DEG) / 2);
    return { eye, right, up, fwd, fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

/** The highest point of the primitives per cell (x0, z0 the grid's corner). */
export interface HeightGrid { x0: number; z0: number; cell: number; nx: number; nz: number; h: Float32Array }

export function heightGrid(prims: Array<Pick<PaintPrim, 'positions' | 'indices'>>, cell: number): HeightGrid {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const p of prims) for (let v = 0; v < p.positions.length; v += 3) {
        x0 = Math.min(x0, p.positions[v]); x1 = Math.max(x1, p.positions[v]); z0 = Math.min(z0, p.positions[v + 2]); z1 = Math.max(z1, p.positions[v + 2]);
    }
    const nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 1), nz = Math.max(1, Math.ceil((z1 - z0) / cell) + 1);
    const h = new Float32Array(nx * nz).fill(-Infinity);
    for (const p of prims) {
        const P = p.positions, I = p.indices;
        for (let t = 0; t < I.length; t += 3) {
            const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
            const top = Math.max(P[a + 1], P[b + 1], P[c + 1]);
            const i0 = Math.floor((Math.min(P[a], P[b], P[c]) - x0) / cell), i1 = Math.floor((Math.max(P[a], P[b], P[c]) - x0) / cell);
            const k0 = Math.floor((Math.min(P[a + 2], P[b + 2], P[c + 2]) - z0) / cell), k1 = Math.floor((Math.max(P[a + 2], P[b + 2], P[c + 2]) - z0) / cell);
            for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) if (h[k * nx + i] < top) h[k * nx + i] = top;
        }
    }
    return { x0, z0, cell, nx, nz, h };
}

/** CityPaint's H+: the grid averaged over a box of smoothM, lifted by marginM, and never under the local top plus clearM. */
export function cameraHeightAt(g: HeightGrid, groundY: number, P: Pick<DistrictPaintParams, 'smoothM' | 'marginM' | 'clearRadiusM' | 'clearM'>): (x: number, z: number) => number {
    const at = (i: number, k: number) => (i < 0 || k < 0 || i >= g.nx || k >= g.nz || g.h[k * g.nx + i] === -Infinity ? groundY : g.h[k * g.nx + i]);
    const rs = Math.max(0, Math.round(P.smoothM / 2 / g.cell)), rc = Math.max(0, Math.round(P.clearRadiusM / g.cell));
    return (x, z) => {
        const ci = Math.floor((x - g.x0) / g.cell), ck = Math.floor((z - g.z0) / g.cell);
        let s = 0, n = 0, top = groundY;
        for (let k = ck - rs; k <= ck + rs; k++) for (let i = ci - rs; i <= ci + rs; i++) { s += at(i, k); n++; }
        for (let k = ck - rc; k <= ck + rc; k++) for (let i = ci - rc; i <= ci + rc; i++) top = Math.max(top, at(i, k));
        return Math.max(s / n + P.marginM, top + P.clearM);
    };
}

/** The grid's heading (deg, 0..90): the walls' area-weighted facing, folded to a quarter turn. */
export function gridHeadingDeg(faces: PaintFace[]): number {
    const bins = new Float64Array(90);
    for (const f of faces) {
        if (Math.abs(f.normal[1]) > 0.3) continue;
        const a = ((Math.atan2(f.normal[0], -f.normal[2]) / DEG) % 90 + 90) % 90;
        bins[Math.floor(a) % 90] += f.areaM2;
    }
    let best = 0, bestV = -1;
    for (let b = 0; b < 90; b++) {
        let v = 0;
        for (let d = -2; d <= 2; d++) v += bins[(b + d + 90) % 90] * (3 - Math.abs(d));
        if (v > bestV) { bestV = v; best = b; }
    }
    return best + 0.5;
}

/** The ground footprint of one view at altitude A above the ground: its width at the centre and its depth (m). */
export function viewFootprint(A: number, P: Pick<DistrictPaintParams, 'pitchDeg' | 'hfovDeg' | 'width' | 'height'>): { widthM: number; depthM: number } {
    const ph = P.pitchDeg * DEG, half = Math.atan(Math.tan((P.hfovDeg * DEG) / 2) * (P.height / P.width));
    const near = A / Math.tan(Math.min(89 * DEG, ph + half)), far = A / Math.tan(Math.max(5 * DEG, ph - half));
    return { widthM: 2 * (A / Math.sin(ph)) * Math.tan((P.hfovDeg * DEG) / 2), depthM: far - near };
}

/**
 * The sweep: for each of the four grid headings, look-at points on a grid over the disc of radiusM about the origin
 * (strips across the heading, serpentine), each camera placed back along the heading at the height H+ gives it.
 */
export function aerialSweep(input: { faces: PaintFace[]; heights: HeightGrid; groundY: number; radiusM: number }, P: DistrictPaintParams = DISTRICT_PAINT_PARAMS): AerialView[] {
    const Hp = cameraHeightAt(input.heights, input.groundY, P);
    const tanP = Math.tan(P.pitchDeg * DEG);
    const grid = gridHeadingDeg(input.faces);
    // the nominal altitude: H+ at the disc's centre and halfway out, median
    const probe: number[] = [];
    for (let k = 0; k < 16; k++) for (const r of [0, 0.5, 0.9]) probe.push(Hp(Math.cos(k * Math.PI / 8) * r * input.radiusM, Math.sin(k * Math.PI / 8) * r * input.radiusM) - input.groundY);
    probe.sort((a, b) => a - b);
    const fp = viewFootprint(probe[probe.length >> 1], P);
    const plan = (spread: number) => {
        const across = fp.widthM * (1 - P.overlap) * spread, along = fp.depthM * (1 - P.overlap) * spread;
        const views: AerialView[] = [];
        const reach = input.radiusM + Math.min(across, along) / 2;
        for (let q = 0; q < 4; q++) {
            const heading = (grid + q * 90) % 360, th = heading * DEG;
            const a: V3 = [Math.sin(th), 0, -Math.cos(th)], b: V3 = [Math.cos(th), 0, Math.sin(th)];
            const nj = Math.ceil(reach / across), ni = Math.ceil(reach / along);
            for (let j = -nj; j <= nj; j++) {
                const row: AerialView[] = [];
                for (let i = -ni; i <= ni; i++) {
                    const gx = a[0] * i * along + b[0] * j * across, gz = a[2] * i * along + b[2] * j * across;
                    if (Math.hypot(gx, gz) > reach) continue;
                    let A = Hp(gx, gz) - input.groundY, ex = gx, ez = gz;
                    for (let it = 0; it < 3; it++) { ex = gx - a[0] * A / tanP; ez = gz - a[2] * A / tanP; A = Hp(ex, ez) - input.groundY; }
                    const eye: V3 = [ex, input.groundY + A, ez];
                    row.push({ id: 0, headingDeg: heading, strip: q * 1000 + j, eye, lookAt: [gx, input.groundY, gz], camera: aerialCamera(eye, heading, P.pitchDeg, P.hfovDeg, P.width, P.height) });
                }
                if ((j + nj) % 2) row.reverse();
                views.push(...row);
            }
        }
        return views;
    };
    let spread = 1, views = plan(spread);
    while (views.length > P.maxViews) { spread *= Math.sqrt(views.length / P.maxViews) * 1.02; views = plan(spread); }
    views.forEach((v, i) => { v.id = i; });
    return views;
}

// =============================================================================
// Top K
// =============================================================================

interface Projected { x: number; y: number; z: number }

function project(cam: FrameCamera, px: number, py: number, pz: number, out: Projected): boolean {
    const dx = px - cam.eye[0], dy = py - cam.eye[1], dz = pz - cam.eye[2];
    const z = dx * cam.fwd[0] + dy * cam.fwd[1] + dz * cam.fwd[2];
    if (z < 0.5) return false;
    out.x = cam.cx + (cam.fx * (dx * cam.right[0] + dy * cam.right[1] + dz * cam.right[2])) / z;
    out.y = cam.cy - (cam.fy * (dx * cam.up[0] + dy * cam.up[1] + dz * cam.up[2])) / z;
    out.z = z;
    return out.x >= 0 && out.y >= 0 && out.x < cam.width && out.y < cam.height;
}

function seenAt(cam: FrameCamera, depth: Float32Array, p: Projected, P: Pick<DistrictPaintParams, 'depthTolM' | 'depthTolRel'>): boolean {
    const d = depth[(p.y | 0) * cam.width + (p.x | 0)];
    return d !== PLATE_EMPTY_DEPTH && p.z <= d + Math.max(P.depthTolM, P.depthTolRel * d);
}

function incidence(cam: FrameCamera, n: V3, px: number, py: number, pz: number): number {
    const dx = px - cam.eye[0], dy = py - cam.eye[1], dz = pz - cam.eye[2], l = Math.hypot(dx, dy, dz);
    return Math.abs((n[0] * dx + n[1] * dy + n[2] * dz) / l);
}

/** Deterministic sample points over a face, spread by triangle area (barycentric lattice). */
export function faceSamples(prim: Pick<PaintPrim, 'positions' | 'indices'>, face: PaintFace, count: number): { points: Float64Array; weightM2: number } {
    const P = prim.positions, I = prim.indices, pts: number[] = [];
    for (const t of face.tris) {
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const area = 0.5 * Math.hypot((P[b + 1] - P[a + 1]) * (P[c + 2] - P[a + 2]) - (P[b + 2] - P[a + 2]) * (P[c + 1] - P[a + 1]), (P[b + 2] - P[a + 2]) * (P[c] - P[a]) - (P[b] - P[a]) * (P[c + 2] - P[a + 2]), (P[b] - P[a]) * (P[c + 1] - P[a + 1]) - (P[b + 1] - P[a + 1]) * (P[c] - P[a]));
        const n = Math.max(1, Math.round((count * area) / Math.max(face.areaM2, 1e-9)));
        const m = Math.max(1, Math.ceil((Math.sqrt(8 * n + 1) - 1) / 2));
        for (let i = 0; i < m; i++) for (let j = 0; j < m - i; j++) {
            const w1 = (i + 1 / 3) / m, w2 = (j + 1 / 3) / m, w0 = 1 - w1 - w2;
            pts.push(w0 * P[a] + w1 * P[b] + w2 * P[c], w0 * P[a + 1] + w1 * P[b + 1] + w2 * P[c + 1], w0 * P[a + 2] + w1 * P[b + 2] + w2 * P[c + 2]);
        }
    }
    return { points: Float64Array.from(pts), weightM2: face.areaM2 / Math.max(1, pts.length / 3) };
}

/** Each face's visible projected area (px) in one view: its samples seen (depth-tested) times their footprint in pixels. */
export function scoreView(target: Pick<PaintTarget, 'prims' | 'faces'>, samples: Array<{ points: Float64Array; weightM2: number }>, cam: FrameCamera, depth: Float32Array, P: DistrictPaintParams): Float64Array {
    const out = new Float64Array(target.faces.length), q: Projected = { x: 0, y: 0, z: 0 };
    target.faces.forEach((f, fi) => {
        const s = samples[fi];
        let score = 0;
        for (let k = 0; k < s.points.length; k += 3) {
            if (!project(cam, s.points[k], s.points[k + 1], s.points[k + 2], q) || !seenAt(cam, depth, q, P)) continue;
            const cos = incidence(cam, f.normal, s.points[k], s.points[k + 1], s.points[k + 2]);
            if (cos < P.minCos) continue;
            score += (s.weightM2 * cos * cam.fx * cam.fy) / (q.z * q.z);
        }
        out[fi] = score;
    });
    return out;
}

/** Per face: its eligible views, best first (each at least rho of the best and minScorePx). */
export function rankViews(scores: Float64Array[], faces: number, P: Pick<DistrictPaintParams, 'rho' | 'minScorePx'>): number[][] {
    const ranked: number[][] = [];
    for (let f = 0; f < faces; f++) {
        let best = 0;
        for (const s of scores) best = Math.max(best, s[f]);
        const list = scores.map((s, v) => ({ v, s: s[f] })).filter(e => e.s >= P.minScorePx && e.s >= P.rho * best).sort((a, b) => b.s - a.s || a.v - b.v);
        ranked.push(list.map(e => e.v));
    }
    return ranked;
}

/**
 * Whether view `v` writes a face now: it is within the face's first K + (failed views ranked before it) eligible views,
 * and fewer than K views have written the face.
 */
export function writesFace(ranked: number[], v: number, failed: ReadonlySet<number>, written: number, K: number): boolean {
    const pos = ranked.indexOf(v);
    if (pos < 0 || written >= K) return false;
    let failedBefore = 0;
    for (let k = 0; k < pos; k++) if (failed.has(ranked[k])) failedBefore++;
    return pos < K + failedBefore;
}

// =============================================================================
// Rendering, gating and baking one view
// =============================================================================

function renderPrims(target: PaintTarget): TexturedPrimitive[] {
    return target.prims.map(p => ({
        positions: p.positions, indices: p.indices, uvs: p.uvs, image: null, imageSize: null, materialIndex: null,
        rgba: p.page !== null
            ? { width: target.pages[p.page].width, height: target.pages[p.page].height, rgba: target.pages[p.page].display }
            : p.image ? { width: p.image.width, height: p.image.height, rgba: asBuffer(p.image.rgba) } : null
    }));
}

/**
 * The view sent to the model: the massing over the scan, the massing shown wherever it lies no farther than
 * massingWinsM (or massingWinsRel of the depth) behind the scan (it is fitted to the scan), the scan elsewhere (the
 * streets, whatever was not rebuilt, whatever stands in front). `bakeDepth` is the massing's depth where it shows and 0
 * where it does not, so a texel the scan hides is never written from this view.
 */
export function compositeView(massing: { rgba: Buffer; depth: Float32Array }, scan: { rgba: Buffer; depth: Float32Array }, P: Pick<DistrictPaintParams, 'massingWinsM' | 'massingWinsRel'>): { rgba: Buffer; depth: Float32Array; bakeDepth: Float32Array; massingPx: number } {
    const n = massing.depth.length, rgba = Buffer.from(scan.rgba), depth = new Float32Array(n), bakeDepth = new Float32Array(n);
    let massingPx = 0;
    for (let i = 0; i < n; i++) {
        const dm = massing.depth[i], ds = scan.depth[i];
        const wins = dm !== PLATE_EMPTY_DEPTH && (ds === PLATE_EMPTY_DEPTH || dm <= ds + Math.max(P.massingWinsM, P.massingWinsRel * ds));
        if (wins) { massing.rgba.copy(rgba, i * 4, i * 4, i * 4 + 4); depth[i] = dm; bakeDepth[i] = dm; massingPx++; }
        else depth[i] = ds;
    }
    return { rgba, depth, bakeDepth, massingPx };
}

/** Key pixels (the fill not painted yet) and the gate's pixels (anything drawn, not near key or empty background). */
export function viewMasks(rgba: Uint8Array, depth: Float32Array, W: number, H: number, P: Pick<DistrictPaintParams, 'key' | 'keyDistance' | 'gateErodePx' | 'gate'>): { key: Uint8Array; gate: Uint8Array; keyPx: number; gatePx: number } {
    const key = new Uint8Array(W * H), bad = new Uint8Array(W * H);
    let keyPx = 0;
    for (let i = 0; i < W * H; i++) {
        const d = Math.hypot(rgba[i * 4] - P.key[0], rgba[i * 4 + 1] - P.key[1], rgba[i * 4 + 2] - P.key[2]);
        if (d < P.keyDistance) { key[i] = 1; keyPx++; }
        if (key[i] || depth[i] === PLATE_EMPTY_DEPTH) bad[i] = 1;
    }
    const gate = new Uint8Array(W * H), r = Math.max(P.gateErodePx, Math.ceil(3 * P.gate.edgeScaleSigmaPx));
    let gatePx = 0;
    // erosion of the good pixels by r (separable max of `bad`)
    const rowMax = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let m = 0;
        for (let d = -r; d <= r && !m; d++) { const xx = x + d; if (xx < 0 || xx >= W || bad[y * W + xx]) m = 1; }
        rowMax[y * W + x] = m;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        let m = 0;
        for (let d = -r; d <= r && !m; d++) { const yy = y + d; if (yy < 0 || yy >= H || rowMax[yy * W + x]) m = 1; }
        if (!m) { gate[y * W + x] = 1; gatePx++; }
    }
    return { key, gate, keyPx, gatePx };
}

/** Share of the key pixels the answer left within keyDistance of the key colour. */
export function keyLeftShare(answer: Uint8Array, key: Uint8Array, P: Pick<DistrictPaintParams, 'key' | 'keyDistance'>): number {
    let n = 0, left = 0;
    for (let i = 0; i < key.length; i++) {
        if (!key[i]) continue;
        n++;
        if (Math.hypot(answer[i * 4] - P.key[0], answer[i * 4 + 1] - P.key[1], answer[i * 4 + 2] - P.key[2]) < P.keyDistance) left++;
    }
    return n ? left / n : 0;
}

/** Calls fn for every texel centre of a triangle in its page, with the texel's world position. */
function forEachTexel(prim: PaintPrim, page: PaintPage, t: number, fn: (i: number, x: number, y: number, z: number) => void): void {
    const I = prim.indices, P = prim.positions, UV = prim.uvs!;
    const ia = I[t * 3], ib = I[t * 3 + 1], ic = I[t * 3 + 2];
    const ax = UV[ia * 2] * page.width, ay = UV[ia * 2 + 1] * page.height, bx = UV[ib * 2] * page.width, by = UV[ib * 2 + 1] * page.height, cx = UV[ic * 2] * page.width, cy = UV[ic * 2 + 1] * page.height;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (Math.abs(area) < 1e-12) return;
    const inv = 1 / area;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(page.width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(page.height - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
        if (w0 < -1e-9) continue;
        const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
        if (w1 < -1e-9) continue;
        const w2 = 1 - w0 - w1;
        if (w2 < -1e-9) continue;
        fn(y * page.width + x, w0 * P[ia * 3] + w1 * P[ib * 3] + w2 * P[ic * 3], w0 * P[ia * 3 + 1] + w1 * P[ib * 3 + 1] + w2 * P[ic * 3 + 1], w0 * P[ia * 3 + 2] + w1 * P[ib * 3 + 2] + w2 * P[ic * 3 + 2]);
    }
}

/** Writes one accepted view into a face's texels (cos-squared weighted running mean); returns the texels written. */
export function bakeFace(target: PaintTarget, face: PaintFace, cam: FrameCamera, depth: Float32Array, answer: RgbaImage8, P: DistrictPaintParams, detailAgrees?: Uint8Array): number {
    const prim = target.prims[face.prim], page = target.pages[prim.page!];
    if (!prim.uvs) return 0;
    const N = page.width * page.height;
    page.paint ??= new Float32Array(N * 3);
    page.weight ??= new Float32Array(N);
    const q: Projected = { x: 0, y: 0, z: 0 }, A = answer.rgba, AW = answer.width, AH = answer.height;
    let written = 0;
    for (const t of face.tris) forEachTexel(prim, page, t, (i, x, y, z) => {
        if (page.cls[i] === TEXEL.none) return;
        if (!project(cam, x, y, z, q) || !seenAt(cam, depth, q, P)) return;
        const cos = incidence(cam, face.normal, x, y, z);
        if (cos < P.minCos) return;
        // a photo texel takes this view's detail only where it agrees with the photo's own (detailAgreement)
        if (detailAgrees && page.cls[i] === TEXEL.photo && !detailAgrees[(q.y | 0) * cam.width + (q.x | 0)]) return;
        const w = cos * cos;
        const u = Math.min(AW - 1, Math.max(0, (q.x * AW) / cam.width - 0.5)), v = Math.min(AH - 1, Math.max(0, (q.y * AH) / cam.height - 0.5));
        const ix = u | 0, iy = v | 0, fx = u - ix, fy = v - iy, ix1 = Math.min(AW - 1, ix + 1), iy1 = Math.min(AH - 1, iy + 1);
        const k = (Math.round(v) * AW + Math.round(u)) * 4;
        if (Math.hypot(A[k] - P.key[0], A[k + 1] - P.key[1], A[k + 2] - P.key[2]) < P.keyDistance) return;
        const w0 = page.weight![i], tot = w0 + w;
        for (let c = 0; c < 3; c++) {
            const s = (A[(iy * AW + ix) * 4 + c] * (1 - fx) + A[(iy * AW + ix1) * 4 + c] * fx) * (1 - fy) + (A[(iy1 * AW + ix) * 4 + c] * (1 - fx) + A[(iy1 * AW + ix1) * 4 + c] * fx) * fy;
            page.paint![i * 3 + c] = (page.paint![i * 3 + c] * w0 + s * w) / tot;
        }
        page.weight![i] = tot;
        if (page.cls[i] === TEXEL.fill) for (let c = 0; c < 3; c++) page.display[i * 4 + c] = Math.round(page.paint![i * 3 + c]);
        written++;
    });
    return written;
}

const lumaF = (img: RgbaImage8): Float32Array => {
    const n = img.width * img.height, out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = 0.2126 * img.rgba[i * 4] + 0.7152 * img.rgba[i * 4 + 1] + 0.0722 * img.rgba[i * 4 + 2];
    return out;
};

function sobel(L: Float32Array, W: number, H: number): Float32Array {
    const out = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = L[i - W + 1] + 2 * L[i + 1] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - 1] - L[i + W - 1];
        const gy = L[i + W - 1] + 2 * L[i + W] + L[i + W + 1] - L[i - W - 1] - 2 * L[i - W] - L[i - W + 1];
        out[i] = Math.hypot(gx, gy);
    }
    return out;
}

/** Box sum over a (2r+1)^2 window (summed-area table), each pixel's own. */
function boxSum(src: Float32Array, W: number, H: number, r: number): Float32Array {
    const S = new Float64Array((W + 1) * (H + 1));
    for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += src[y * W + x]; S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + row; } }
    const out = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const x0 = Math.max(0, x - r), y0 = Math.max(0, y - r), x1 = Math.min(W, x + r + 1), y1 = Math.min(H, y + r + 1);
        out[y * W + x] = S[y1 * (W + 1) + x1] - S[y0 * (W + 1) + x1] - S[y1 * (W + 1) + x0] + S[y0 * (W + 1) + x0];
    }
    return out;
}

export interface RegistrationCheck {
    /** Blocks with enough edge in the view to be matched, those that matched somewhere, and those that matched in place. */
    textured: number; matched: number; inPlace: number;
    /** Median shift (px) of the matched blocks. */
    medianShiftPx: number;
    pass: boolean; reason: string;
    /** Each matched block: its centre in the view and where it lies in the answer (px). */
    matches: Array<{ x: number; y: number; dx: number; dy: number; ncc: number }>;
}

/**
 * Whether the answer stands where the view does, block by block: each textured block of the view's edges (blurred
 * edgeSigmaPx) is matched against the answer's over shifts up to searchPx (a coarse pass at half resolution, refined at
 * full); see DISTRICT_PAINT_PARAMS.registration.
 */
export function registrationCheck(view: RgbaImage8, answer: RgbaImage8, mask: Uint8Array, P: Pick<DistrictPaintParams, 'registration'>): RegistrationCheck {
    const R = P.registration, W = view.width, H = view.height;
    const Ev = sobel(blur1(lumaF(view), W, H, R.edgeSigmaPx), W, H), Ea = sobel(blur1(lumaF(answer), W, H, R.edgeSigmaPx), W, H);
    const B = R.blockPx, S = R.searchPx;
    const ncc = (x0: number, y0: number, dx: number, dy: number, step: number): number => {
        let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
        for (let y = y0; y < y0 + B; y += step) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let x = x0; x < x0 + B; x += step) {
                const xx = x + dx;
                if (xx < 0 || xx >= W || !mask[y * W + x]) continue;
                const a = Ev[y * W + x], b = Ea[yy * W + xx];
                sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; n++;
            }
        }
        if (n < 16) return -1;
        const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
        return va > 1e-9 && vb > 1e-9 ? (sab - (sa * sb) / n) / Math.sqrt(va * vb) : -1;
    };
    let textured = 0, matched = 0, inPlace = 0;
    const shifts: number[] = [];
    const matches: RegistrationCheck['matches'] = [];
    for (let y0 = S; y0 + B + S <= H; y0 += B) for (let x0 = S; x0 + B + S <= W; x0 += B) {
        let m = 0, e = 0;
        for (let y = y0; y < y0 + B; y++) for (let x = x0; x < x0 + B; x++) if (mask[y * W + x]) { m++; e += Ev[y * W + x]; }
        if (m < 0.7 * B * B || e / m < R.minEdge) continue;
        textured++;
        let best = -2, bx = 0, by = 0;
        for (let dy = -S; dy <= S; dy += 2) for (let dx = -S; dx <= S; dx += 2) { const c = ncc(x0, y0, dx, dy, 2); if (c > best) { best = c; bx = dx; by = dy; } }
        const cx = bx, cy = by;
        for (let dy = cy - 1; dy <= cy + 1; dy++) for (let dx = cx - 1; dx <= cx + 1; dx++) { const c = ncc(x0, y0, dx, dy, 1); if (c > best) { best = c; bx = dx; by = dy; } }
        if (best < R.minNcc) continue;
        matched++;
        matches.push({ x: x0 + B / 2, y: y0 + B / 2, dx: bx, dy: by, ncc: Math.round(best * 1000) / 1000 });
        const sh = Math.hypot(bx, by);
        shifts.push(sh);
        if (sh <= R.maxShiftPx) inPlace++;
    }
    shifts.sort((a, b) => a - b);
    const medianShiftPx = shifts.length ? shifts[shifts.length >> 1] : 0;
    const matchedShare = textured ? matched / textured : 0, inPlaceShare = matched ? inPlace / matched : 0;
    const pass = textured > 0 && matchedShare >= R.minMatchedShare && inPlaceShare >= R.minInPlaceShare;
    const reason = !textured ? 'no block of the view has enough edge to check the answer against'
        : matchedShare < R.minMatchedShare ? `only ${matched} of ${textured} textured blocks match the answer anywhere (at least ${Math.round(R.minMatchedShare * 100)}%): the answer is not this view`
        : inPlaceShare < R.minInPlaceShare ? `${matched - inPlace} of ${matched} matched blocks moved more than ${R.maxShiftPx} px (median ${medianShiftPx.toFixed(1)} px; at most ${Math.round((1 - R.minInPlaceShare) * 100)}% may): the answer is shifted, zoomed or turned`
        : `${inPlace} of ${matched} matched blocks in place (median shift ${medianShiftPx.toFixed(1)} px), ${matched} of ${textured} textured blocks matched`;
    return { textured, matched, inPlace, medianShiftPx: Math.round(medianShiftPx * 10) / 10, pass, reason, matches };
}

/** Per pixel: whether the answer's detail (high band) agrees with the view's there (local NCC at least P.detail.minNcc). */
export function detailAgreement(view: RgbaImage8, answer: RgbaImage8, P: Pick<DistrictPaintParams, 'detail'>): Uint8Array {
    const D = P.detail, W = view.width, H = view.height, n = W * H;
    const hb = (img: RgbaImage8) => { const L = lumaF(img), lo = blur1(L, W, H, D.highBandSigmaPx); for (let i = 0; i < n; i++) L[i] -= lo[i]; return L; };
    const a = hb(view), b = hb(answer), ab = new Float32Array(n), aa = new Float32Array(n), bb = new Float32Array(n);
    for (let i = 0; i < n; i++) { ab[i] = a[i] * b[i]; aa[i] = a[i] * a[i]; bb[i] = b[i] * b[i]; }
    const r = D.windowPx >> 1, Sa = boxSum(a, W, H, r), Sb = boxSum(b, W, H, r), Sab = boxSum(ab, W, H, r), Saa = boxSum(aa, W, H, r), Sbb = boxSum(bb, W, H, r), Sn = boxSum(new Float32Array(n).fill(1), W, H, r);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const k = Sn[i], va = Saa[i] - (Sa[i] * Sa[i]) / k, vb = Sbb[i] - (Sb[i] * Sb[i]) / k;
        if (va <= 1e-6 || vb <= 1e-6) continue;
        if ((Sab[i] - (Sa[i] * Sb[i]) / k) / Math.sqrt(va * vb) >= D.minNcc) out[i] = 1;
    }
    return out;
}

export interface AnswerWarp {
    /** The answer's position of a view pixel: (a0 x + a1 y + a2, a3 x + a4 y + a5). */
    affine: [number, number, number, number, number, number];
    scale: number; turnDeg: number; shiftPx: number;
    residualMedianPx: number; inlierShare: number; matchedShare: number;
    pass: boolean; reason: string;
}

/** The affine taking view pixels to answer pixels, fitted to the matched blocks (Huber-reweighted least squares). */
export function fitAnswerWarp(reg: RegistrationCheck, P: Pick<DistrictPaintParams, 'warp'>): AnswerWarp {
    const Wp = P.warp, m = reg.matches;
    const matchedShare = reg.textured ? reg.matched / reg.textured : 0;
    const fail = (reason: string): AnswerWarp => ({ affine: [1, 0, 0, 0, 1, 0], scale: 1, turnDeg: 0, shiftPx: 0, residualMedianPx: Infinity, inlierShare: 0, matchedShare, pass: false, reason });
    if (m.length < 6 || matchedShare < Wp.minMatchedShare) return fail(`only ${reg.matched} of ${reg.textured} textured blocks match the answer anywhere (at least ${Math.round(Wp.minMatchedShare * 100)}%): the answer redrew the view`);
    const solve3 = (N: number[][], b: number[]): number[] => {
        for (let i = 0; i < 3; i++) {
            let piv = i;
            for (let r = i + 1; r < 3; r++) if (Math.abs(N[r][i]) > Math.abs(N[piv][i])) piv = r;
            [N[i], N[piv]] = [N[piv], N[i]]; [b[i], b[piv]] = [b[piv], b[i]];
            for (let r = i + 1; r < 3; r++) { const f = N[r][i] / N[i][i]; for (let c = i; c < 3; c++) N[r][c] -= f * N[i][c]; b[r] -= f * b[i]; }
        }
        const x = [0, 0, 0];
        for (let i = 2; i >= 0; i--) { let v = b[i]; for (let c = i + 1; c < 3; c++) v -= N[i][c] * x[c]; x[i] = v / N[i][i]; }
        return x;
    };
    const fit = (w: number[]) => {
        const N = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
        m.forEach((p, i) => {
            const v = [p.x, p.y, 1];
            for (let r = 0; r < 3; r++) { bx[r] += w[i] * v[r] * (p.x + p.dx); by[r] += w[i] * v[r] * (p.y + p.dy); for (let c = 0; c < 3; c++) N[r][c] += w[i] * v[r] * v[c]; }
        });
        return [...solve3(N.map(r => [...r]), bx), ...solve3(N.map(r => [...r]), by)] as AnswerWarp['affine'];
    };
    const resid = (A: AnswerWarp['affine'], p: { x: number; y: number; dx: number; dy: number }) => Math.hypot(A[0] * p.x + A[1] * p.y + A[2] - p.x - p.dx, A[3] * p.x + A[4] * p.y + A[5] - p.y - p.dy);
    let w = m.map(() => 1), A = fit(w);
    for (let it = 0; it < 6; it++) { w = m.map(p => { const e = resid(A, p); return e <= Wp.inlierPx * 0.75 ? 1 : (Wp.inlierPx * 0.75) / e; }); A = fit(w); }
    const res = m.map(p => resid(A, p)).sort((a, b) => a - b);
    const residualMedianPx = res[res.length >> 1], inlierShare = res.filter(e => e <= Wp.inlierPx).length / res.length;
    const scale = Math.sqrt(Math.abs(A[0] * A[4] - A[1] * A[3])), turnDeg = (Math.atan2(A[3], A[0]) * 180) / Math.PI;
    const cx = 0.5 * (Math.max(...m.map(p => p.x)) + Math.min(...m.map(p => p.x))), cy = 0.5 * (Math.max(...m.map(p => p.y)) + Math.min(...m.map(p => p.y)));
    const shiftPx = Math.hypot(A[0] * cx + A[1] * cy + A[2] - cx, A[3] * cx + A[4] * cy + A[5] - cy);
    const out = { affine: A, scale: Math.round(scale * 1e4) / 1e4, turnDeg: Math.round(turnDeg * 100) / 100, shiftPx: Math.round(shiftPx * 10) / 10, residualMedianPx: Math.round(residualMedianPx * 100) / 100, inlierShare: Math.round(inlierShare * 1000) / 1000, matchedShare: Math.round(matchedShare * 1000) / 1000 };
    if (residualMedianPx > Wp.maxResidualPx || inlierShare < Wp.minInlierShare) return { ...out, pass: false, reason: `no one warp places the answer on the view (median block residual ${residualMedianPx.toFixed(2)} px, at most ${Wp.maxResidualPx}; ${Math.round(inlierShare * 100)}% within ${Wp.inlierPx} px, at least ${Math.round(Wp.minInlierShare * 100)}%): the answer moved its parts apart` };
    if (Math.abs(scale - 1) > Wp.maxScaleChange || Math.abs(turnDeg) > Wp.maxTurnDeg) return { ...out, pass: false, reason: `the answer is the view rescaled by ${((scale - 1) * 100).toFixed(1)}% and turned ${turnDeg.toFixed(2)} degrees (at most ${Wp.maxScaleChange * 100}% and ${Wp.maxTurnDeg} degrees): it reframed the view` };
    return { ...out, pass: true, reason: `the answer is the view moved ${shiftPx.toFixed(1)} px, rescaled ${((scale - 1) * 100).toFixed(2)}% and turned ${turnDeg.toFixed(2)} degrees; warped back, its blocks sit within ${residualMedianPx.toFixed(2)} px (median)` };
}

/** The answer resampled into the view's frame through its warp (bilinear; outside the answer, the view's own pixel). */
export function warpAnswerToView(answer: RgbaImage8, view: RgbaImage8, A: AnswerWarp['affine']): RgbaImage8 {
    const W = view.width, H = view.height, out = new Uint8Array(W * H * 4), S = answer.rgba, AW = answer.width, AH = answer.height;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const px = x + 0.5, py = y + 0.5, u = A[0] * px + A[1] * py + A[2] - 0.5, v = A[3] * px + A[4] * py + A[5] - 0.5, o = (y * W + x) * 4;
        if (u < 0 || v < 0 || u > AW - 1 || v > AH - 1) { out.set(view.rgba.subarray(o, o + 4), o); continue; }
        const ix = u | 0, iy = v | 0, fx = u - ix, fy = v - iy, ix1 = Math.min(AW - 1, ix + 1), iy1 = Math.min(AH - 1, iy + 1);
        for (let c = 0; c < 4; c++) out[o + c] = Math.round((S[(iy * AW + ix) * 4 + c] * (1 - fx) + S[(iy * AW + ix1) * 4 + c] * fx) * (1 - fy) + (S[(iy1 * AW + ix) * 4 + c] * (1 - fx) + S[(iy1 * AW + ix1) * 4 + c] * fx) * fy);
    }
    return { width: W, height: H, rgba: out };
}

// =============================================================================
// Composing the final atlas
// =============================================================================

/** Each paged texel's face (-1 where no triangle covers its centre: gutters and unused page). */
function faceMap(target: PaintTarget, pageIndex: number): Int32Array {
    const page = target.pages[pageIndex], map = new Int32Array(page.width * page.height).fill(-1);
    target.faces.forEach((f, fi) => {
        const prim = target.prims[f.prim];
        if (prim.page !== pageIndex || !prim.uvs) return;
        for (const t of f.tris) forEachTexel(prim, page, t, i => { map[i] = fi; });
    });
    return map;
}

/** Box mean of `src` (3 channels) over radius r, counting only texels of the same face where `valid` (separable). */
export function sameFaceLowPass(src: Float32Array, valid: Uint8Array, face: Int32Array, W: number, H: number, r: number): Float32Array {
    const tmp = new Float32Array(W * H * 4), out = new Float32Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, f = face[i];
        if (f < 0) continue;
        let s0 = 0, s1 = 0, s2 = 0, n = 0;
        for (let d = -r; d <= r; d++) {
            const xx = x + d;
            if (xx < 0 || xx >= W) continue;
            const j = y * W + xx;
            if (face[j] !== f || !valid[j]) continue;
            s0 += src[j * 3]; s1 += src[j * 3 + 1]; s2 += src[j * 3 + 2]; n++;
        }
        tmp[i * 4] = s0; tmp[i * 4 + 1] = s1; tmp[i * 4 + 2] = s2; tmp[i * 4 + 3] = n;
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, f = face[i];
        if (f < 0) continue;
        let s0 = 0, s1 = 0, s2 = 0, n = 0;
        for (let d = -r; d <= r; d++) {
            const yy = y + d;
            if (yy < 0 || yy >= H) continue;
            const j = yy * W + x;
            if (face[j] !== f) continue;
            s0 += tmp[j * 4]; s1 += tmp[j * 4 + 1]; s2 += tmp[j * 4 + 2]; n += tmp[j * 4 + 3];
        }
        if (n) { out[i * 3] = s0 / n; out[i * 3 + 1] = s1 / n; out[i * 3 + 2] = s2 / n; }
    }
    return out;
}

function srgbToLab(r: number, g: number, b: number): [number, number, number] {
    const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const R = lin(r), G = lin(g), B = lin(b);
    const X = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, Y = 0.2126 * R + 0.7152 * G + 0.0722 * B, Z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

export interface ComposeCounts { photoDetail: number; fill: number; repeatReplaced: number; repeatKept: number; fillUnreached: number; gutter: number }

/**
 * The page's final texels: photo texels keep their own low band and take the painted high band; fill texels take the
 * paint; repeat texels take it where the painted low band agrees. Gutter texels copy a changed neighbour. Written texels
 * get the paint's legend indices in the confidence channel.
 */
export function composePage(target: PaintTarget, pageIndex: number, legend: { detail: number; fill: number }, P: DistrictPaintParams): ComposeCounts {
    const page = target.pages[pageIndex], W = page.width, H = page.height, N = W * H;
    const counts: ComposeCounts = { photoDetail: 0, fill: 0, repeatReplaced: 0, repeatKept: 0, fillUnreached: 0, gutter: 0 };
    for (let i = 0; i < N; i++) if (page.cls[i] === TEXEL.fill && !(page.weight && page.weight[i] > 0)) counts.fillUnreached++;
    if (!page.paint || !page.weight) return counts;
    const face = faceMap(target, pageIndex);
    const painted = new Uint8Array(N), photoValid = new Uint8Array(N), photo = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        if (page.weight[i] > 0) painted[i] = 1;
        if (page.cls[i] === TEXEL.photo || page.cls[i] === TEXEL.repeat) photoValid[i] = 1;
        photo[i * 3] = page.albedo[i * 4]; photo[i * 3 + 1] = page.albedo[i * 4 + 1]; photo[i * 3 + 2] = page.albedo[i * 4 + 2];
    }
    const r = Math.max(1, Math.round(P.lowBandM / P.texelM / 2));
    const lowPaint = sameFaceLowPass(page.paint, painted, face, W, H, r), lowPhoto = sameFaceLowPass(photo, photoValid, face, W, H, r);
    const changed = new Uint8Array(N);
    const writeConf = (i: number, index: number, rung: number, weight: number) => {
        page.conf[i * 4] = index; page.conf[i * 4 + 1] = Math.round(255 * weight); page.conf[i * 4 + 2] = rung; page.conf[i * 4 + 3] = 255;
    };
    const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    for (let i = 0; i < N; i++) {
        if (!painted[i] || face[i] < 0) continue;
        const cls = page.cls[i];
        if (cls === TEXEL.photo) {
            for (let c = 0; c < 3; c++) page.albedo[i * 4 + c] = clamp(lowPhoto[i * 3 + c] + page.paint[i * 3 + c] - lowPaint[i * 3 + c]);
            writeConf(i, legend.detail, RUNG_PHOTO_MAX, PAINT_LEGEND_DETAIL.weight);
            counts.photoDetail++;
        } else if (cls === TEXEL.fill) {
            for (let c = 0; c < 3; c++) page.albedo[i * 4 + c] = clamp(page.paint[i * 3 + c]);
            writeConf(i, legend.fill, PAINT_LEGEND_FILL.rung, PAINT_LEGEND_FILL.weight);
            counts.fill++;
        } else if (cls === TEXEL.repeat) {
            const a = srgbToLab(lowPaint[i * 3], lowPaint[i * 3 + 1], lowPaint[i * 3 + 2]), b = srgbToLab(lowPhoto[i * 3], lowPhoto[i * 3 + 1], lowPhoto[i * 3 + 2]);
            if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > P.repeatMaxDeltaE) { counts.repeatKept++; continue; }
            for (let c = 0; c < 3; c++) page.albedo[i * 4 + c] = clamp(page.paint[i * 3 + c]);
            writeConf(i, legend.fill, PAINT_LEGEND_FILL.rung, PAINT_LEGEND_FILL.weight);
            counts.repeatReplaced++;
        } else continue;
        changed[i] = 1;
    }
    // the packer's gutters (2 texels) repeat their face's edge: copy a changed neighbour's texel into them
    for (let pass = 0; pass < 2; pass++) {
        const next = changed.slice();
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const i = y * W + x;
            if (face[i] >= 0 || changed[i] || page.conf[i * 4 + 3] !== 255) continue;
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const xx = x + dx, yy = y + dy;
                if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
                const j = yy * W + xx;
                if (!changed[j]) continue;
                page.albedo.copyWithin(i * 4, j * 4, j * 4 + 3);
                page.conf.copyWithin(i * 4, j * 4, j * 4 + 4);
                next[i] = 1; counts.gutter++;
                break;
            }
        }
        changed.set(next);
    }
    return counts;
}

export const PAINT_LEGEND_DETAIL: TexelSource = {
    source: 'aerial-paint-detail', label: 'generated', rung: RUNG_PHOTO_MAX, weight: 0.4,
    method: "the tile photo's own colour below about 1 m, the image model's detail above it, from the best aerial views of the face (district-aerial-paint.ts: height-following sweep, face-wise top K, the view repainted from the massing and the tile scan seen from the same camera)"
};
export const PAINT_LEGEND_FILL: TexelSource = {
    source: 'aerial-paint', label: 'generated', rung: TEXTURE_LADDER_RUNGS.indexOf('generated tileable PBR'), weight: 0.2,
    method: 'a texel no tile photo reached (or a repeat fill the paint agreed with), painted by the image model from the best aerial views of the face, the tile scan from the same camera as its evidence (district-aerial-paint.ts)'
};

// =============================================================================
// The run
// =============================================================================

export interface PaintViewRecord {
    id: number; headingDeg: number; eye: V3; faces: number; paintablePx: number; keyPx: number; gatePx: number;
    decision: 'accepted' | 'rejected' | 'model_failed' | 'skipped';
    reasonCode?: string; reason?: string; attempts: number;
    metrics?: EnhanceGateMetrics & { keyLeft: number; registration: Omit<RegistrationCheck, 'matches'>; warp: AnswerWarp; aligned?: Omit<RegistrationCheck, 'matches'> };
    modelUsed?: string; texelsWritten?: number; ms: number;
}

export interface DistrictPaintReport {
    version: string;
    params: DistrictPaintParams;
    gridHeadingDeg: number;
    views: { planned: number; withWork: number; asked: number; accepted: number; rejected: number; failed: number };
    faces: { total: number; withViews: number; written: number; withoutAcceptedView: number };
    texels: ComposeCounts;
    legend: Array<TexelSource & { index: number }>;
    models: string[];
    imagesAsked: number;
    costUsdEstimate: number;
    perView: PaintViewRecord[];
    timingsMs: Record<string, number>;
    files: { glb: string; views: string };
}

export interface DistrictPaintInput {
    /** The massing layer to paint (district_massing_textured.glb). */
    massingGlb: string;
    /** The tile scan (trees stripped), the evidence each view is shown. */
    referenceGlb: string;
    outGlb: string;
    /** Where each view's render, evidence and answer are written. */
    viewsDir: string;
    client: PaintModelClient;
    models?: string[];
    /** The district's covered radius about the tile frame's origin (m). */
    radiusM: number;
    /** The ground's height (m); default the 2nd percentile of the massing's vertex heights. */
    groundY?: number;
    params?: Partial<DistrictPaintParams>;
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
}

const jpeg = (rgba: Uint8Array, width: number, height: number) => jpegJs.encode({ data: asBuffer(rgba), width, height }, 85).data;

function lowPercentileY(target: PaintTarget, q: number): number {
    const ys: number[] = [];
    for (const p of target.prims) if (p.page !== null) for (let v = 1; v < p.positions.length; v += 3 * 7) ys.push(p.positions[v]);
    ys.sort((a, b) => a - b);
    return ys.length ? ys[Math.floor(q * (ys.length - 1))] : 0;
}

export async function paintDistrictAerial(input: DistrictPaintInput): Promise<DistrictPaintReport> {
    const P: DistrictPaintParams = { ...DISTRICT_PAINT_PARAMS, ...(input.params ?? {}) };
    const models = input.models ?? IMAGE_MODEL_PRIORITY;
    const timingsMs: Record<string, number> = {};
    const say = (m: string) => input.onProgress?.(m);
    const abort = () => { if (input.signal?.aborted) throw Object.assign(new Error('The aerial paint was stopped'), { name: 'AbortError' }); };
    let t0 = Date.now();
    const target = loadPaintTarget(input.massingGlb, P);
    const groundY = input.groundY ?? lowPercentileY(target, 0.02);
    // primitives sharing an image share its decoded pixels
    const decoded = new Map<string, { width: number; height: number; rgba: Buffer }>();
    const reference: TexturedPrimitive[] = readGlbScene(input.referenceGlb).map(p => {
        if (!p.image) return { ...p, rgba: null };
        const key = `${p.image.byteOffset}:${p.image.byteLength}`;
        let rgba = decoded.get(key);
        if (!rgba) { const d = decodeImageInMemory(p.image); rgba = { width: d.width, height: d.height, rgba: asBuffer(d.rgba) }; decoded.set(key, rgba); }
        return { ...p, rgba };
    });
    timingsMs.load = Date.now() - t0;
    if (!target.pages.length) throw new Error(`${path.basename(input.massingGlb)} has no atlas pages to paint (no material with a page_N_albedo texture and its confidence)`);

    t0 = Date.now();
    const views = aerialSweep({ faces: target.faces, heights: heightGrid(target.prims, P.cellM), groundY, radiusM: input.radiusM }, P);
    const prims = renderPrims(target);
    const samples = target.faces.map(f => faceSamples(target.prims[f.prim], f, P.scoreSamples));
    const scores: Float64Array[] = [];
    for (const v of views) {
        abort();
        scores.push(scoreView(target, samples, v.camera, renderTexturedView(prims, v.camera).depth, P));
    }
    const ranked = rankViews(scores, target.faces.length, P);
    timingsMs.plan = Date.now() - t0;
    const failed = new Set<number>(), written = new Int32Array(target.faces.length);
    const facesOf = (v: number) => { const out: number[] = []; for (let f = 0; f < ranked.length; f++) if (writesFace(ranked[f], v, failed, written[f], P.topK)) out.push(f); return out; };
    const withWork = views.filter(v => facesOf(v.id).length).length;
    say(`aerial paint: ${views.length} views planned over ${Math.round(input.radiusM)} m, ${withWork} with faces to write; ${target.faces.length} faces, ${ranked.filter(r => r.length).length} seen well enough by some view`);

    fs.mkdirSync(input.viewsDir, { recursive: true });
    const perView: PaintViewRecord[] = [];
    const usedModels = new Set<string>();
    let asked = 0;
    t0 = Date.now();
    for (const v of views) {
        abort();
        const ts = Date.now();
        const faces = facesOf(v.id);
        const rec: PaintViewRecord = { id: v.id, headingDeg: Math.round(v.headingDeg * 10) / 10, eye: v.eye.map(x => Math.round(x * 10) / 10) as V3, faces: faces.length, paintablePx: 0, keyPx: 0, gatePx: 0, decision: 'skipped', attempts: 0, ms: 0 };
        perView.push(rec);
        if (!faces.length) { rec.reasonCode = 'paint_no_faces'; rec.reason = 'no face counts this view among its best views'; rec.ms = Date.now() - ts; continue; }
        const W = P.width, H = P.height;
        const evidence = renderTexturedView(reference, v.camera);
        const view = compositeView(renderTexturedView(prims, v.camera), evidence, P);
        const masks = viewMasks(view.rgba, view.depth, W, H, P);
        rec.paintablePx = view.massingPx;
        rec.keyPx = masks.keyPx; rec.gatePx = masks.gatePx;
        let empty = 0;
        for (let i = 0; i < W * H; i++) if (view.depth[i] === PLATE_EMPTY_DEPTH) empty++;
        if (empty > P.maxEmptyShare * W * H) {
            failed.add(v.id); rec.decision = 'skipped'; rec.reasonCode = 'paint_view_empty';
            rec.reason = `${(100 * empty / (W * H)).toFixed(0)}% of the view is empty (at most ${Math.round(100 * P.maxEmptyShare)}%): the model would fill it with invented buildings, so none is asked for`;
            rec.ms = Date.now() - ts; continue;
        }
        if (masks.gatePx < P.minGateShare * W * H) {
            failed.add(v.id); rec.decision = 'rejected'; rec.reasonCode = 'paint_unverifiable';
            rec.reason = `only ${(100 * masks.gatePx / (W * H)).toFixed(1)}% of the frame can be checked (at least ${(100 * P.minGateShare).toFixed(0)}%): an answer here could move without the gate seeing it, so none is asked for`;
            rec.ms = Date.now() - ts; continue;
        }
        const tag = `v${String(v.id).padStart(3, '0')}`;
        fs.writeFileSync(path.join(input.viewsDir, `${tag}_view.jpg`), jpeg(view.rgba, W, H));
        fs.writeFileSync(path.join(input.viewsDir, `${tag}_evidence.jpg`), jpeg(evidence.rgba, W, H));
        const source: RgbaImage8 = { width: W, height: H, rgba: view.rgba };
        let accepted: RgbaImage8 | undefined;
        for (let attempt = 1; attempt <= P.attempts && !accepted; attempt++) {
            abort();
            rec.attempts = attempt;
            let answer: PaintModelAnswer;
            try {
                asked++;
                answer = await input.client({ label: tag, models, prompt: paintPrompt(W, H, P.pitchDeg), view: { bytes: encodePng(W, H, view.rgba), width: W, height: H }, reference: { bytes: encodePng(W, H, evidence.rgba) }, imageSize: P.imageSize, signal: input.signal });
            } catch (err: any) {  // eslint-disable-line @typescript-eslint/no-explicit-any
                if (err?.name === 'AbortError') throw err;
                rec.decision = 'model_failed'; rec.reasonCode = 'paint_model_failed'; rec.reason = String(err?.message ?? err);
                break;
            }
            rec.modelUsed = answer.modelUsed; usedModels.add(answer.modelUsed);
            let image: RgbaImage8;
            try { image = resizeRgba(decodeImageInMemory(answer.bytes), W, H); } catch (err: any) {  // eslint-disable-line @typescript-eslint/no-explicit-any
                rec.decision = 'rejected'; rec.reasonCode = 'paint_answer_undecodable'; rec.reason = `${answer.modelUsed} answered with an image that could not be decoded (${err?.message ?? err})`;
                continue;
            }
            fs.writeFileSync(path.join(input.viewsDir, `${tag}_answer${attempt}.jpg`), jpeg(image.rgba, W, H));
            // the answer's own warp, fitted from its matched blocks and undone, before anything is judged or baked
            const reg = registrationCheck(source, image, masks.gate, P);
            const warp = fitAnswerWarp(reg, P);
            const { matches: _m, ...regSummary } = reg;
            if (!warp.pass) { rec.metrics = { ...enhancementGate(source, image, masks.gate, P.gate).metrics, keyLeft: keyLeftShare(image.rgba, masks.key, P), registration: regSummary, warp: { ...warp } }; rec.decision = 'rejected'; rec.reasonCode = 'paint_not_registered'; rec.reason = `${answer.modelUsed}: ${warp.reason}`; continue; }
            image = warpAnswerToView(image, source, warp.affine);
            fs.writeFileSync(path.join(input.viewsDir, `${tag}_answer${attempt}_aligned.jpg`), jpeg(image.rgba, W, H));
            const verdict = enhancementGate(source, image, masks.gate, P.gate);
            const keyLeft = keyLeftShare(image.rgba, masks.key, P);
            const { matches: _a, ...after } = registrationCheck(source, image, masks.gate, P);
            rec.metrics = { ...verdict.metrics, keyLeft: Math.round(keyLeft * 1e4) / 1e4, registration: regSummary, warp: { ...warp }, aligned: after };
            const hue = verdict.metrics.lowBandChromaDeltaE ?? 0;
            if (hue > (P.gate.maxLowBandChromaDeltaE ?? Infinity)) { rec.decision = 'rejected'; rec.reasonCode = 'paint_hue_changed'; rec.reason = `${answer.modelUsed} changed the surfaces' hue, not just their light (low-band hue/chroma CIEDE2000 ${hue.toFixed(1)} > ${P.gate.maxLowBandChromaDeltaE})`; continue; }
            if (keyLeft > P.maxKeyLeft) { rec.decision = 'rejected'; rec.reasonCode = 'paint_key_left'; rec.reason = `${answer.modelUsed} left ${(100 * keyLeft).toFixed(1)}% of the unreached surface in the key colour (at most ${(100 * P.maxKeyLeft).toFixed(1)}%)`; continue; }
            accepted = image;
        }
        if (!accepted) { failed.add(v.id); rec.ms = Date.now() - ts; say(`aerial paint: view ${v.id + 1} of ${views.length} ${rec.decision} (${rec.reasonCode})`); continue; }
        rec.decision = 'accepted'; delete rec.reasonCode; delete rec.reason;
        const agrees = detailAgreement(source, accepted, P);
        let texels = 0;
        for (const f of faces) {
            const n = bakeFace(target, target.faces[f], v.camera, view.bakeDepth, accepted, P, agrees);
            if (n) { written[f]++; texels += n; }
        }
        rec.texelsWritten = texels;
        rec.ms = Date.now() - ts;
        say(`aerial paint: view ${v.id + 1} of ${views.length} accepted, ${faces.length} faces, ${texels} texels`);
    }
    timingsMs.views = Date.now() - t0;

    t0 = Date.now();
    let maxIndex = 0;
    for (const page of target.pages) for (let i = 0; i < page.width * page.height; i++) if (page.conf[i * 4 + 3] === 255) maxIndex = Math.max(maxIndex, page.conf[i * 4]);
    const legend = { detail: maxIndex + 1, fill: maxIndex + 2 };
    if (legend.fill > 254) throw new Error(`the massing's confidence channel has no room for the paint's provenance entries (index ${maxIndex} in use)`);
    const texels: ComposeCounts = { photoDetail: 0, fill: 0, repeatReplaced: 0, repeatKept: 0, fillUnreached: 0, gutter: 0 };
    const replaced = new Map<number, { bytes: Uint8Array; mime: string }>();
    target.pages.forEach((page, k) => {
        const c = composePage(target, k, legend, P);
        for (const key of Object.keys(texels) as Array<keyof ComposeCounts>) texels[key] += c[key];
        if (!page.paint) return;
        replaced.set(page.albedoImage, page.mime === 'image/jpeg'
            ? { bytes: new Uint8Array(jpegJs.encode({ data: asBuffer(page.albedo), width: page.width, height: page.height }, PHOTO_JPEG_QUALITY).data), mime: 'image/jpeg' }
            : { bytes: new Uint8Array(encodePng(page.width, page.height, asBuffer(page.albedo))), mime: 'image/png' });
        replaced.set(page.confImage, { bytes: new Uint8Array(encodePng(page.width, page.height, asBuffer(page.conf))), mime: 'image/png' });
    });
    const legendOut = [{ ...PAINT_LEGEND_DETAIL, index: legend.detail }, { ...PAINT_LEGEND_FILL, index: legend.fill }];
    const json = target.glb.json;
    const root = json.nodes?.[json.scenes?.[json.scene ?? 0]?.nodes?.[0] ?? 0];
    const record = { version: DISTRICT_PAINT_VERSION, texelSourcesAdded: legendOut, models: [...usedModels] };
    if (root) { root.extras ??= {}; root.extras.sb ??= {}; root.extras.sb.districtPaint = record; } else { json.extras ??= {}; json.extras.districtPaint = record; }
    fs.writeFileSync(input.outGlb, replaceGlbImages(target.glb, replaced));
    timingsMs.compose = Date.now() - t0;

    const accepted = perView.filter(r => r.decision === 'accepted').length;
    const report: DistrictPaintReport = {
        version: DISTRICT_PAINT_VERSION, params: P, gridHeadingDeg: Math.round(gridHeadingDeg(target.faces) * 10) / 10,
        views: { planned: views.length, withWork, asked: perView.filter(r => r.attempts > 0).length, accepted, rejected: perView.filter(r => r.decision === 'rejected').length, failed: perView.filter(r => r.decision === 'model_failed').length },
        faces: { total: target.faces.length, withViews: ranked.filter(r => r.length).length, written: Array.from(written).filter(n => n > 0).length, withoutAcceptedView: ranked.filter((r, f) => r.length && !written[f]).length },
        texels, legend: legendOut, models: [...usedModels], imagesAsked: asked, costUsdEstimate: Math.round(asked * P.usdPerImage * 100) / 100,
        perView, timingsMs, files: { glb: input.outGlb, views: input.viewsDir }
    };
    fs.writeFileSync(path.join(path.dirname(input.outGlb), 'district_paint.json'), JSON.stringify(report, null, 1));
    return report;
}
