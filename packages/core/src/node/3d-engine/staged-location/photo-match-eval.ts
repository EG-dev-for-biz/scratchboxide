/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The photo-match evaluator: does a build look like the real place, judged against real photos it never saw?
 *
 * Inputs are held-out views (a real photo and its registered pinhole pose, in the tile frame) and arms (the GLB layers one
 * pipeline variant produced, in the same frame). For every view:
 *  - each arm is rendered from exactly the photo's pose, at the photo's resolution and field of view, by a software
 *    rasterizer (perspective-correct UVs, mip-mapped bilinear base colour, z-buffer, 2x2 supersampling). Every arm gets the
 *    same neutral light (a camera headlight term over a flat ambient) on the same flat grey background, so lighting is never
 *    what separates two arms;
 *  - a vision model is shown the photo and the arm renders in shuffled order, unlabelled, and scores each render 1-10 on
 *    shape, materials, detail, errors (10 = nothing wrong or invented) and overall. Each judgement runs `repeats` times with
 *    the order reshuffled; the scores are mapped back to the arms and reported as mean and spread;
 *  - secondary numbers inside the building mask (the reference arm's coverage, by default the raw scan): luminance SSIM,
 *    the symmetric structural-edge chamfer (texture-fit-metric.ts's edges and truncation) and the mean CIEDE2000 of the
 *    blurred colours, plus how much of the mask the arm covers;
 *  - a grid image: the photo beside every arm render, labelled, for a person to look at.
 * Regions (`regions` in renderTriangles, triangleRegions, regionMasks, regionScores): every triangle carries a label from
 * geometry alone (ground when it lies on the measured terrain, else the target, a tree crown the run measured, or a neighbour),
 * the z-buffer gives each pixel the label of the surface its ray hits (sky where none), and the same secondary numbers are
 * measured over the whole frame and per region (ground, neighbours, the band where standing geometry meets the sky), so the
 * place around the building is scored as well as the building. Colour and brightness never decide a label.
 * The clay arm (`clay` in renderTriangles, `judgeViewClay`) renders every arm again from the same pose in one uniform clay,
 * its street in a lighter clay, under a raised key light behind the camera, and the judge scores shape only (massing,
 * openings, surface relief): geometry changes that the photo texture hides (measured relief, reveals) can be scored there.
 *
 * Lit (`lit` in renderTriangles, PHOTO_MATCH_LIT, off by default): every arm under one sun with cast shadows (a two-cascade
 * shadow map of all arm and context triangles) and a sky term darkened by screen-space ambient occlusion, in place of the
 * headlight (and the clay key light). Under the headlight a proud pilaster, a reveal or a cornice the wall's own colour is
 * invisible; lit, it casts a shadow, so a judge can score relief. The headlight stays the default so older reports compare.
 *
 * Specular (`specular` in renderTriangles, the manifest's `"specular": true`, off by default): the neutral light above stays
 * the diffuse term, and every surface also reflects one fixed environment (a street canyon: dark street below the horizon,
 * facades of the far side up to ~14 degrees, a sky gradient above) through a Schlick Fresnel term with F0 = 0.04 for a
 * dielectric (the albedo for a metal), blurred towards the environment's irradiance by roughness squared. A rough wall
 * (roughness 0.85 to 1) changes by a few percent; glass (0.05) shows the street and the sky as a window does. Roughness and
 * metalness come from each arm's glTF material (factors and metallicRoughness texture; loadArmLayer `pbr`), so an arm
 * without material channels is drawn by the same term at its own factors: the same light for every arm.
 *
 * Trees (`loadArmLayer`, `armMeshesForView`, tree-lod-view.ts): a trees GLB of the tree LOD contract holds every level of every
 * tree and instanced leaves the viewport resolves at run time; with `treeLod` (on by default) each view draws one level per tree,
 * chosen by the viewport's rule for that camera (on-screen size and place in the frame), with its leaf instances expanded.
 * `treeLod: false` draws every level at once (the old behaviour, for comparison). Leaves and crown cards are alpha-tested as the
 * viewport's materials test them (tree-lod-view.ts cut-outs): the cards' leaf spray in both renders, a textured tree's leaves
 * cut out of its library leaf set in the textured render. Their colour stays the GLB's (the library's colour and tints are
 * not drawn).
 *
 * Orthographic views (`OrthoCamera`, texture-pass-contracts.ts; ortho-reference.ts builds one from a Static Maps satellite
 * crop): renderTriangles takes a pinhole or an ortho camera. Under an ortho camera every pixel looks along `fwd`, a pixel is
 * `pixelM` metres on the ground, depth is the distance along `fwd`, and the headlight is `fwd` itself; textures, clay, the
 * context, cut-outs, lit and specular all render unchanged, so the judge can see the real satellite crop beside each arm's
 * top-down render at the same scale. A satellite image is a second opinion and carries no capture date.
 *
 * Nothing here knows a place or a pipeline; the arms are whatever GLBs the caller names. The photos must not have been used
 * to texture or register any arm: the caller holds them out (the bake-off driver checks the pano ids).
 */

import { isOrthoCamera, type DecodedImage, type OrthoCamera, type PinholeCamera, type RenderCamera } from '../../../common/spatial/texture-pass-contracts';
import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { sunDirectionFromAngles } from '../../../common/coordinate/solarPosition';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../common/spatial/photogrammetric-delight';
import { distanceTransform, gaussianBlur } from '../../spatial/StreetViewPoseRegistrar';
import { chamferMean, FIT_CHAMFER_TRUNCATION_PX, reducedLuminance, structuralEdges } from './texture-fit-metric';
import { deltaE00, linearToLab } from './texel-exposure';
import { encodePng } from './png-encode';
import { readTileTriangles, type CutoutAlphaMap, type CutoutKind, type TileTriangles } from './tile-texture-transfer';
import { readTreesLodGlb, treesForView, type TreesForView, type TreesLodGlb } from './tree-lod-view';
import type { TreeLodViewInput } from '../../../common/spatial/tree-lod-math';

// =============================================================================
// Rendering
// =============================================================================

/** Flat background of every render (sRGB). */
export const PHOTO_MATCH_BACKGROUND: Vec3 = [128, 128, 128];
/** The neutral light: ambient share, the rest from a headlight (|n . view|). */
export const PHOTO_MATCH_AMBIENT = 0.72;
/** Nearest depth rendered (m). */
export const PHOTO_MATCH_NEAR_M = 0.25;
/** The clay renders: the arm's clay, its street's (lighter, so the target reads against it), the background and the light. */
export const PHOTO_MATCH_CLAY: { albedo: Vec3; contextAlbedo: Vec3; background: Vec3; ambient: number } = {
    albedo: [150, 152, 156], contextAlbedo: [206, 204, 198], background: [222, 226, 232], ambient: 0.34
};

export interface ArmRender {
    width: number;
    height: number;
    /** sRGB8 RGBA, background where nothing renders. */
    rgba: Uint8Array;
    /** 0..1 share of each pixel's samples that hit the arm (never its context). */
    coverage: Float32Array;
    /** With `regions` in renderTriangles: per pixel the REGION label most of its samples hit (REGION.sky where none did). */
    regions?: Uint8Array;
    triangles: number;
    ms: number;
}

/**
 * The region labels (what a ray hits). `standing` labels (target, neighbours, trees) are what can meet the sky in a skyline;
 * the ground and the sky cannot. Labels are measurement partitions for scoring, assigned from geometry (triangleRegions).
 */
export const REGION = { sky: 0, ground: 1, neighbours: 2, target: 3, trees: 4 } as const;
export const REGION_COUNT = 5;
/** Majority ties go to the first of these (a pixel half building, half sky counts as building). */
const REGION_TIE_ORDER = [REGION.target, REGION.trees, REGION.neighbours, REGION.ground, REGION.sky];
const isStanding = (l: number) => l === REGION.target || l === REGION.neighbours || l === REGION.trees;

interface MipLevel { width: number; height: number; linear: Float32Array }
const mipCache = new WeakMap<object, MipLevel[]>();

function mipChain(tex: TileTriangles['textures'][number]): MipLevel[] {
    let chain = mipCache.get(tex);
    if (chain) return chain;
    chain = [{ width: tex.width, height: tex.height, linear: tex.linear }];
    for (let k = 0; k < 12; k++) {
        const p = chain[chain.length - 1];
        if (p.width <= 1 && p.height <= 1) break;
        const w = Math.max(1, p.width >> 1), h = Math.max(1, p.height >> 1);
        const out = new Float32Array(w * h * 3);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            for (let c = 0; c < 3; c++) {
                let s = 0, n = 0;
                for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
                    const xx = Math.min(p.width - 1, x * 2 + dx), yy = Math.min(p.height - 1, y * 2 + dy);
                    s += p.linear[(yy * p.width + xx) * 3 + c]; n++;
                }
                out[(y * w + x) * 3 + c] = s / n;
            }
        }
        chain.push({ width: w, height: h, linear: out });
    }
    mipCache.set(tex, chain);
    return chain;
}

function sampleBilinear(m: MipLevel, u: number, v: number, repeatS: boolean, repeatT: boolean, out: Float64Array): void {
    // glTF UV: (0, 0) is the top-left of the image
    const x = u * m.width - 0.5, y = v * m.height - 0.5;
    const wrap = (i: number, n: number, rep: boolean) => (rep ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const xa = wrap(x0, m.width, repeatS), xb = wrap(x0 + 1, m.width, repeatS), ya = wrap(y0, m.height, repeatT), yb = wrap(y0 + 1, m.height, repeatT);
    for (let c = 0; c < 3; c++) {
        const a = m.linear[(ya * m.width + xa) * 3 + c], b = m.linear[(ya * m.width + xb) * 3 + c];
        const d = m.linear[(yb * m.width + xa) * 3 + c], e = m.linear[(yb * m.width + xb) * 3 + c];
        out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
    }
}

/** One vertex in camera space with its UV. */
interface CamVertex { x: number; y: number; z: number; u: number; v: number }

/** Clips a camera-space polygon to z >= near (Sutherland-Hodgman, one plane). */
function clipNear(poly: CamVertex[], near: number): CamVertex[] {
    const out: CamVertex[] = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const ina = a.z >= near, inb = b.z >= near;
        if (ina) out.push(a);
        if (ina !== inb) {
            const t = (near - a.z) / (b.z - a.z);
            out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: near, u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t });
        }
    }
    return out;
}

/** Bilinear alpha of one mip level at (u, v), clamped (row 0 at v = 0). */
function alphaBilinear(m: CutoutAlphaMap['mips'][number], u: number, v: number): number {
    const x = u * m.width - 0.5, y = v * m.height - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const xa = Math.max(0, Math.min(m.width - 1, x0)), xb = Math.max(0, Math.min(m.width - 1, x0 + 1));
    const ya = Math.max(0, Math.min(m.height - 1, y0)), yb = Math.max(0, Math.min(m.height - 1, y0 + 1));
    const a = m.alpha;
    return (a[ya * m.width + xa] * (1 - fx) + a[ya * m.width + xb] * fx) * (1 - fy) + (a[yb * m.width + xa] * (1 - fx) + a[yb * m.width + xb] * fx) * fy;
}

/** A cut-out's atlas coordinates at a triangle's TEXCOORD_0 (u, v), or undefined outside a leaf's cell. */
function cutoutUv(k: CutoutKind, u: number, v: number, out: Float64Array): boolean {
    const L = k.leaf;
    if (!L) { out[0] = u; out[1] = v; return true; }
    const s = 0.5 + (u - 0.5) * L.ks, t = 0.5 + (v * L.kt - 0.5) / L.zoom;
    if (s < 0 || s > 1 || t < 0 || t > 1) return false;
    out[0] = L.origin[0] + t * L.along[0] + s * L.across[0];
    out[1] = L.origin[1] + t * L.along[1] + s * L.across[1];
    return true;
}

/**
 * Whether what stands in front (its camera z, `occluderZ`; >= 1e8 where nothing) hides a surface at camera z `z`: it is
 * nearer by more than 0.25 m plus 2 percent of `z`. renderTriangles' `occluderDepth` and the splat arm's (splat-arm-render.ts)
 * hide by this one rule.
 */
export function occluderHides(occluderZ: number, z: number): boolean {
    return occluderZ < 1e8 && occluderZ < z - (0.25 + 0.02 * z);
}

/**
 * Renders triangle soups (readTileTriangles: tile frame, linear textures) from a pinhole or an orthographic camera at the
 * camera's own resolution. `supersample` samples per pixel side (2 = 4 samples). Both faces of a triangle render (scan meshes have mixed
 * winding); the nearest surface wins; `occluderDepth` hides what the real place hides. A soup's `cutout` (tree leaves and
 * crown cards) is alpha-tested per sample as the viewport's material does it, the clay or the textured cut-out by the
 * render: a sample whose alpha (mip-filtered at the triangle's footprint, raised per mip level, times the gain) is under 0.5
 * is not drawn and does not hide what is behind it.
 */
export function renderTriangles(meshes: TileTriangles[], camera: RenderCamera, options: {
    supersample?: number; background?: Vec3; ambient?: number;
    /**
     * What stands in front in the real place (e.g. the full tile mesh: neighbours, trees, the street): its depth from the same
     * camera (camera z, metres, at the camera's resolution; Infinity or >= 1e8 where nothing). An arm surface farther than it
     * (by 0.25 m + 2 percent) is hidden, as the photo hides it, so every arm is seen through the same occluders.
     */
    occluderDepth?: Float32Array;
    /**
     * The place around the arm (e.g. the photo-textured tile with the target cut out, identical for every arm): drawn with
     * the arm, depth-tested against it and lit the same, so the arm is seen in its street as the photo shows it. `coverage`
     * still counts the arm's samples only, so the metrics' mask stays the target.
     */
    context?: TileTriangles[];
    /**
     * Render untextured: every arm triangle in one clay albedo and the context in a lighter one (sRGB; PHOTO_MATCH_CLAY by
     * default), lit by a key light raised behind the camera (each facet's normal turned to face the camera, then max(0, n . L))
     * over an ambient share, so relief shows as shading: soffits darker, reveals' sides apart. No texture is sampled.
     */
    clay?: boolean | { albedo?: Vec3; contextAlbedo?: Vec3 };
    /** Add the fixed environment's specular reflection (see the file comment); ignored with `clay`. */
    specular?: boolean;
    /**
     * The lit mode (see PHOTO_MATCH_LIT): a sun with cast shadows (a two-cascade shadow map of every arm and context
     * triangle) over a sky term darkened by screen-space ambient occlusion, in place of the headlight (and of the clay key
     * light: a clay render is lit by the same sun). Relief that matches the wall's colour shows as shadow and occlusion.
     */
    lit?: LitOptions;
    /**
     * Region labels (REGION values) per mesh, one for the whole mesh or one per triangle: `meshes` for the arm's, `context`
     * for the context's, in the order passed. With it the render returns `regions`, the label of the nearest surface each
     * sample hits (REGION.sky where none, or where `occluderDepth` hid it), the most common per pixel.
     */
    regions?: { meshes: Array<number | Uint8Array>; context?: Array<number | Uint8Array> };
} = {}): ArmRender {
    const t0 = Date.now();
    const ss = Math.max(1, Math.round(options.supersample ?? 2));
    const W = camera.width * ss, H = camera.height * ss;
    // an ortho camera: fx, fy are samples per metre and the projection has no divide by depth
    const ortho = isOrthoCamera(camera);
    const fx = ortho ? ss / camera.pixelM : camera.fx * ss, fy = ortho ? ss / camera.pixelM : camera.fy * ss, cx = camera.cx * ss, cy = camera.cy * ss;
    const depth = new Float32Array(W * H).fill(Infinity);
    const mesh = new Int32Array(W * H).fill(-1), tri = new Int32Array(W * H).fill(-1);
    const bu = new Float32Array(W * H), bv = new Float32Array(W * H);
    const levelOf = new Map<number, Float32Array>(); // per mesh: mip level per triangle
    const { eye, right, up, fwd } = camera;
    let drawn = 0;
    const armMeshes = meshes.length;
    if (options.context?.length) meshes = [...meshes, ...options.context];
    const cutUv = new Float64Array(2);
    meshes.forEach((m, mi) => {
        const nt = m.texture.length;
        const levels = new Float32Array(nt);
        levelOf.set(mi, levels);
        const P = m.positions, UV = m.uvs;
        const cuts = m.cutout ? (options.clay ? m.cutout.clay : m.cutout.textured) : undefined;
        for (let t = 0; t < nt; t++) {
            const poly: CamVertex[] = [];
            for (let k = 0; k < 3; k++) {
                const o = t * 9 + k * 3;
                const dx = P[o] - eye[0], dy = P[o + 1] - eye[1], dz = P[o + 2] - eye[2];
                poly.push({ x: dx * right[0] + dy * right[1] + dz * right[2], y: dx * up[0] + dy * up[1] + dz * up[2], z: dx * fwd[0] + dy * fwd[1] + dz * fwd[2], u: UV[t * 6 + k * 2], v: UV[t * 6 + k * 2 + 1] });
            }
            if (poly[0].z < PHOTO_MATCH_NEAR_M && poly[1].z < PHOTO_MATCH_NEAR_M && poly[2].z < PHOTO_MATCH_NEAR_M) continue;
            const clipped = poly[0].z < PHOTO_MATCH_NEAR_M || poly[1].z < PHOTO_MATCH_NEAR_M || poly[2].z < PHOTO_MATCH_NEAR_M ? clipNear(poly, PHOTO_MATCH_NEAR_M) : poly;
            if (clipped.length < 3) continue;
            const sx = ortho ? clipped.map(p => cx + fx * p.x) : clipped.map(p => cx + (fx * p.x) / p.z);
            const sy = ortho ? clipped.map(p => cy - fy * p.y) : clipped.map(p => cy - (fy * p.y) / p.z);
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let i = 0; i < sx.length; i++) { minX = Math.min(minX, sx[i]); maxX = Math.max(maxX, sx[i]); minY = Math.min(minY, sy[i]); maxY = Math.max(maxY, sy[i]); }
            if (maxX < 0 || maxY < 0 || minX >= W || minY >= H) continue;
            // mip level: texels per screen sample over the original triangle (area ratio)
            const ti = m.texture[t];
            if (ti >= 0) {
                const tex = m.textures[ti];
                const ua = (UV[t * 6 + 2] - UV[t * 6]) * tex.width, va = (UV[t * 6 + 3] - UV[t * 6 + 1]) * tex.height;
                const ub = (UV[t * 6 + 4] - UV[t * 6]) * tex.width, vb = (UV[t * 6 + 5] - UV[t * 6 + 1]) * tex.height;
                const texArea = Math.abs(ua * vb - ub * va) / 2;
                let scrArea = 0;
                for (let i = 1; i + 1 < sx.length; i++) scrArea += Math.abs((sx[i] - sx[0]) * (sy[i + 1] - sy[0]) - (sx[i + 1] - sx[0]) * (sy[i] - sy[0])) / 2;
                levels[t] = scrArea > 1e-9 ? Math.max(0, 0.5 * Math.log2(texArea / scrArea)) : 0;
            }
            // an alpha-tested triangle: its cut-out, the mip level the GPU would read at its footprint (per output pixel,
            // anisotropic up to the map's limit) and the alpha's lift by the larger of fwidth(uv) x size, as the shaders take it
            let cutK: CutoutKind | undefined, cutM: CutoutAlphaMap | undefined, cutLod = 0, cutLift = 1;
            if (cuts && cuts[t] >= 0) {
                cutK = m.cutout!.kinds[cuts[t]]; cutM = m.cutout!.maps[cutK.map];
                const mw = cutM.mips[0].width, mh = cutM.mips[0].height;
                // the atlas map is affine in TEXCOORD_0 (leafAtlasUv): the derivatives of TEXCOORD_0, then the map's linear part
                const du1 = clipped[1].u - clipped[0].u, dv1 = clipped[1].v - clipped[0].v, du2 = clipped[2].u - clipped[0].u, dv2 = clipped[2].v - clipped[0].v;
                const L = cutK.leaf;
                // d(atlas)/d(TEXCOORD_0): s = 0.5 + (u - 0.5) ks, t = 0.5 + (v kt - 0.5) / zoom, atlas = origin + t along + s across
                const aUu = L ? L.ks * L.across[0] : 1, aUv = L ? (L.kt / L.zoom) * L.along[0] : 0, aVu = L ? L.ks * L.across[1] : 0, aVv = L ? (L.kt / L.zoom) * L.along[1] : 1;
                const U1 = (aUu * du1 + aUv * dv1) * mw, U2 = (aUu * du2 + aUv * dv2) * mw, V1 = (aVu * du1 + aVv * dv1) * mh, V2 = (aVu * du2 + aVv * dv2) * mh;
                const x1 = (sx[1] - sx[0]) / ss, y1 = (sy[1] - sy[0]) / ss, x2 = (sx[2] - sx[0]) / ss, y2 = (sy[2] - sy[0]) / ss;
                const det = x1 * y2 - x2 * y1;
                if (Math.abs(det) > 1e-12) {
                    const dUdx = (U1 * y2 - U2 * y1) / det, dUdy = (U2 * x1 - U1 * x2) / det;
                    const dVdx = (V1 * y2 - V2 * y1) / det, dVdy = (V2 * x1 - V1 * x2) / det;
                    const lenX = Math.hypot(dUdx, dVdx), lenY = Math.hypot(dUdy, dVdy), pMax = Math.max(lenX, lenY), pMin = Math.max(1e-9, Math.min(lenX, lenY));
                    const nAniso = Math.min(Math.ceil(pMax / pMin), cutM.maxAnisotropy);
                    cutLod = Math.max(0, Math.log2(Math.max(1e-9, pMax / nAniso)));
                    const lift = Math.max(0, Math.log2(Math.max(1e-6, Math.abs(dUdx) + Math.abs(dUdy), Math.abs(dVdx) + Math.abs(dVdy))));
                    cutLift = (1 + lift * cutK.mipScale) * cutK.gain;
                } else { cutLod = cutM.mips.length - 1; cutLift = cutK.gain; }
            }
            // fan triangulation of the clipped polygon
            for (let f = 1; f + 1 < clipped.length; f++) {
                const ids = [0, f, f + 1];
                const X = ids.map(i => sx[i]), Y = ids.map(i => sy[i]), Z = ids.map(i => clipped[i]);
                const area = (X[1] - X[0]) * (Y[2] - Y[0]) - (X[2] - X[0]) * (Y[1] - Y[0]);
                if (Math.abs(area) < 1e-12) continue;
                const x0 = Math.max(0, Math.floor(Math.min(X[0], X[1], X[2]))), x1 = Math.min(W - 1, Math.ceil(Math.max(X[0], X[1], X[2])));
                const y0 = Math.max(0, Math.floor(Math.min(Y[0], Y[1], Y[2]))), y1 = Math.min(H - 1, Math.ceil(Math.max(Y[0], Y[1], Y[2])));
                const iz = Z.map(p => 1 / p.z);
                for (let py = y0; py <= y1; py++) {
                    const yc = py + 0.5;
                    for (let px = x0; px <= x1; px++) {
                        const xc = px + 0.5;
                        const w0 = ((X[1] - xc) * (Y[2] - yc) - (X[2] - xc) * (Y[1] - yc)) / area;
                        const w1 = ((X[2] - xc) * (Y[0] - yc) - (X[0] - xc) * (Y[2] - yc)) / area;
                        const w2 = 1 - w0 - w1;
                        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                        // perspective-correct interpolation (1/z weights); affine under an ortho camera
                        const izp = ortho ? 1 : w0 * iz[0] + w1 * iz[1] + w2 * iz[2];
                        const z = ortho ? w0 * Z[0].z + w1 * Z[1].z + w2 * Z[2].z : 1 / izp;
                        const i = py * W + px;
                        if (z >= depth[i]) continue;
                        const pu = ortho ? w0 * Z[0].u + w1 * Z[1].u + w2 * Z[2].u : (w0 * Z[0].u * iz[0] + w1 * Z[1].u * iz[1] + w2 * Z[2].u * iz[2]) / izp;
                        const pv = ortho ? w0 * Z[0].v + w1 * Z[1].v + w2 * Z[2].v : (w0 * Z[0].v * iz[0] + w1 * Z[1].v * iz[1] + w2 * Z[2].v * iz[2]) / izp;
                        if (cutK) {
                            // the alpha test: outside a leaf's cell, or under 0.5 after the lift, the sample is not drawn
                            if (!cutoutUv(cutK, pu, pv, cutUv)) continue;
                            const mips = cutM!.mips, l0 = Math.min(mips.length - 1, Math.floor(cutLod)), l1 = Math.min(mips.length - 1, l0 + 1), lf = cutLod - Math.floor(cutLod);
                            let a = alphaBilinear(mips[l0], cutUv[0], cutUv[1]);
                            if (l1 !== l0 && lf > 0.01) a = a * (1 - lf) + alphaBilinear(mips[l1], cutUv[0], cutUv[1]) * lf;
                            if (a * cutLift < 0.5) continue;
                        }
                        depth[i] = z;
                        mesh[i] = mi; tri[i] = t;
                        bu[i] = pu;
                        bv[i] = pv;
                    }
                }
            }
            if (mi < armMeshes) drawn++;
        }
    });
    // shade the samples, then box-reduce to the camera's resolution
    const clay = options.clay ? { ...PHOTO_MATCH_CLAY, ...(typeof options.clay === 'object' ? options.clay : {}) } : undefined;
    const amb = options.ambient ?? (clay ? clay.ambient : PHOTO_MATCH_AMBIENT);
    const bg = options.background ?? (clay ? clay.background : PHOTO_MATCH_BACKGROUND);
    const clayLin = clay ? clay.albedo.map(c => SRGB8_TO_LINEAR[c]) : undefined;
    const clayCtxLin = clay ? clay.contextAlbedo.map(c => SRGB8_TO_LINEAR[c]) : undefined;
    // the clay key light: behind the camera, raised and a little to its left (world up is +y in the tile frame)
    let key: [number, number, number] = [0, 0, 0];
    if (clay) {
        const k = [0, 1, 2].map(a => -0.55 * fwd[a] + (a === 1 ? 0.7 : 0) - 0.35 * right[a]);
        const kl = Math.hypot(k[0], k[1], k[2]) || 1;
        key = [k[0] / kl, k[1] / kl, k[2] / kl];
    }
    const bgLin = bg.map(c => SRGB8_TO_LINEAR[c]);
    const lit = options.lit ? { ...PHOTO_MATCH_LIT, ...options.lit } : undefined;
    let sunVis: Float32Array | undefined, ao: Float32Array | undefined;
    if (lit) {
        const sl = Math.hypot(lit.sunDir[0], lit.sunDir[1], lit.sunDir[2]) || 1;
        lit.sunDir = [lit.sunDir[0] / sl, lit.sunDir[1] / sl, lit.sunDir[2] / sl];
        const g: SampleBuffers = { W, H, fx, fy, cx, cy, ortho, camera, depth, mesh, tri, meshes };
        sunVis = lit.shadows ? sunVisibility(g, lit) : undefined;
        ao = lit.ao ? screenSpaceAo(g, lit) : undefined;
    }
    const outW = camera.width, outH = camera.height;
    const acc = new Float64Array(outW * outH * 3), cov = new Float32Array(outW * outH);
    const col = new Float64Array(3), envSample = new Float64Array(3);
    // region labels per mesh in draw order (the arm's, then the context's) and a count per label per pixel
    let regionOf: Array<number | Uint8Array> | undefined, regionCounts: Uint8Array | undefined;
    if (options.regions) {
        const ctxLabels = options.context?.length ? options.regions.context ?? [] : [];
        if (options.regions.meshes.length !== armMeshes || ctxLabels.length !== meshes.length - armMeshes) {
            throw new Error(`renderTriangles: regions name ${options.regions.meshes.length} + ${ctxLabels.length} meshes for ${armMeshes} + ${meshes.length - armMeshes}`);
        }
        regionOf = [...options.regions.meshes, ...ctxLabels];
        regionCounts = new Uint8Array(outW * outH * REGION_COUNT);
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const o = (Math.floor(y / ss) * outW + Math.floor(x / ss));
        let mi = mesh[i];
        if (mi >= 0 && options.occluderDepth && occluderHides(options.occluderDepth[Math.floor(y / ss) * camera.width + Math.floor(x / ss)], depth[i])) mi = -1;
        if (regionCounts) {
            const r = mi < 0 ? REGION.sky : regionOf![mi];
            regionCounts[o * REGION_COUNT + (typeof r === 'number' ? r : r[tri[i]])]++;
        }
        if (mi < 0) { acc[o * 3] += bgLin[0]; acc[o * 3 + 1] += bgLin[1]; acc[o * 3 + 2] += bgLin[2]; continue; }
        const m = meshes[mi], t = tri[i], ti = m.texture[t];
        if (clay) {
            const c = mi < armMeshes ? clayLin! : clayCtxLin!;
            col[0] = c[0]; col[1] = c[1]; col[2] = c[2];
        } else if (ti >= 0) {
            const tex = m.textures[ti], chain = mipChain(tex);
            const lv = levelOf.get(mi)![t];
            const l0 = Math.min(chain.length - 1, Math.floor(lv)), l1 = Math.min(chain.length - 1, l0 + 1), f = Math.min(1, lv - l0);
            sampleBilinear(chain[l0], bu[i], bv[i], tex.repeatS, tex.repeatT, col);
            if (f > 0.01 && l1 !== l0) {
                const a0 = col[0], a1 = col[1], a2 = col[2];
                sampleBilinear(chain[l1], bu[i], bv[i], tex.repeatS, tex.repeatT, col);
                col[0] = a0 * (1 - f) + col[0] * f; col[1] = a1 * (1 - f) + col[1] * f; col[2] = a2 * (1 - f) + col[2] * f;
            }
        } else {
            col[0] = m.flatLinear[t * 3]; col[1] = m.flatLinear[t * 3 + 1]; col[2] = m.flatLinear[t * 3 + 2];
        }
        // the neutral light: ambient plus a headlight on the facet normal (the view ray; under an ortho camera, fwd itself)
        const xc = ortho ? 0 : (x + 0.5 - cx) / fx, yc = ortho ? 0 : -(y + 0.5 - cy) / fy;
        const spec = options.specular && !clay;
        const dx = right[0] * xc + up[0] * yc + fwd[0], dy = right[1] * xc + up[1] * yc + fwd[1], dz = right[2] * xc + up[2] * yc + fwd[2];
        const dl = Math.hypot(dx, dy, dz);
        const n = t * 3;
        const nv = (m.normals[n] * dx + m.normals[n + 1] * dy + m.normals[n + 2] * dz) / dl;
        let shade: number;
        if (lit) {
            // the sun (shadowed) over the sky (occluded), on the facet's normal turned towards the camera
            const sgn = nv > 0 ? -1 : 1;
            const nl = sgn * (m.normals[n] * lit.sunDir[0] + m.normals[n + 1] * lit.sunDir[1] + m.normals[n + 2] * lit.sunDir[2]);
            const nUp = sgn * m.normals[n + 1];
            shade = lit.sun * Math.max(0, nl) * (sunVis ? sunVis[i] : 1) + lit.sky * (ao ? ao[i] : 1) * (1 - lit.skyUpShare * (0.5 - 0.5 * nUp));
        } else if (clay) {
            // the facet's normal turned towards the camera (scan normals are not reliably outward), then the key light
            const sgn = nv > 0 ? -1 : 1;
            const nl = sgn * (m.normals[n] * key[0] + m.normals[n + 1] * key[1] + m.normals[n + 2] * key[2]);
            shade = amb + (1 - amb) * Math.max(0, nl);
        } else {
            shade = amb + (1 - amb) * Math.abs(nv);
        }
        if (spec) {
            const { roughness, metalness } = pbrAt(m, t, bu[i], bv[i]);
            // the normal turned towards the camera, the mirror direction of the view ray about it
            const sgn = nv > 0 ? -1 : 1;
            const Nx = sgn * m.normals[n], Ny = sgn * m.normals[n + 1], Nz = sgn * m.normals[n + 2];
            const ux = dx / dl, uy = dy / dl, uz = dz / dl;
            const dn = ux * Nx + uy * Ny + uz * Nz, cosV = Math.max(0, -dn);
            specularEnvironment(ux - 2 * dn * Nx, uy - 2 * dn * Ny, uz - 2 * dn * Nz, Ny, roughness, envSample);
            const fw = Math.pow(1 - cosV, 5);
            for (let c = 0; c < 3; c++) {
                const f0 = 0.04 * (1 - metalness) + col[c] * metalness;
                const F = f0 + (Math.max(1 - roughness, f0) - f0) * fw;
                acc[o * 3 + c] += col[c] * shade * (1 - metalness) * (1 - F) + F * envSample[c];
            }
            if (mi < armMeshes) cov[o] += 1;
            continue;
        }
        acc[o * 3] += col[0] * shade; acc[o * 3 + 1] += col[1] * shade; acc[o * 3 + 2] += col[2] * shade;
        if (mi < armMeshes) cov[o] += 1;
    }
    const k = ss * ss;
    const rgba = new Uint8Array(outW * outH * 4);
    for (let o = 0; o < outW * outH; o++) {
        rgba[o * 4] = linearToSrgb255(acc[o * 3] / k); rgba[o * 4 + 1] = linearToSrgb255(acc[o * 3 + 1] / k); rgba[o * 4 + 2] = linearToSrgb255(acc[o * 3 + 2] / k); rgba[o * 4 + 3] = 255;
        cov[o] /= k;
    }
    let regions: Uint8Array | undefined;
    if (regionCounts) {
        regions = new Uint8Array(outW * outH);
        for (let o = 0; o < outW * outH; o++) {
            let best: number = REGION.sky, bestN = -1;
            for (const l of REGION_TIE_ORDER) { const nl = regionCounts[o * REGION_COUNT + l]; if (nl > bestN) { bestN = nl; best = l; } }
            regions[o] = best;
        }
    }
    return { width: outW, height: outH, rgba, coverage: cov, ...(regions ? { regions } : {}), triangles: drawn, ms: Date.now() - t0 };
}

// =============================================================================
// The lit mode: sun, cast shadows, sky occlusion
// =============================================================================

/**
 * The lit mode's light. Every arm of a view gets the same sun and sky, so light still never separates two arms; but relief
 * now shows: a proud pilaster casts a shadow on its wall, a reveal shades its window, a cornice its frieze, whatever their
 * colour. Linear multipliers of the albedo: a facet facing the sun at angle a gets `sun` x cos a where the shadow map sees
 * the sun, and every facet the sky's `sky`, darkened by screen-space ambient occlusion and by `skyUpShare` towards facets
 * that face down (an up-facing facet sees the whole sky, a wall about 1 - skyUpShare / 2 of it).
 */
export const PHOTO_MATCH_LIT = {
    sun: 1.0,
    sky: 0.42,
    skyUpShare: 0.4,
    shadows: true,
    /** Shadow-map side (texels) of each of the two cascades: the near half of the visible samples, then all of them. */
    shadowMapPx: 3072,
    /** Depth bias in shadow-map texels, plus the slope term (2 texels x tan of the sun's incidence, the tan at most 8). */
    shadowBiasTexels: 1.5,
    ao: true,
    /** Occlusion radius: the larger of this (m) and `aoRadiusPerM` x the sample's distance. */
    aoRadiusM: 1.0,
    aoRadiusPerM: 0.004,
    aoSamples: 12,
    /** How much of the sky the occlusion may take away (1 = all of it where fully occluded). */
    aoStrength: 0.85
};

export interface LitOptions extends Partial<Omit<typeof PHOTO_MATCH_LIT, 'sunDir'>> {
    /** Unit vector towards the sun, tile frame (x east, y up, z south); see sunDirection. */
    sunDir: Vec3;
}

/** The direction towards the sun (tile frame: x east, y up, z south) from its azimuth (degrees clockwise from north) and elevation. */
export function sunDirection(azimuthDeg: number, elevationDeg: number): Vec3 {
    return sunDirectionFromAngles(elevationDeg, azimuthDeg);
}

/**
 * A default sun for a place at `latDeg`: 55 degrees up, 35 degrees round from the equator-facing direction (north in the
 * southern hemisphere, south in the northern): a late-morning sun that rakes the facades facing it and still reaches most
 * street floors (at 40 degrees a CBD street of 25-45 m buildings lies wholly in shadow, which hides its relief again).
 */
export function defaultSunForLatitude(latDeg: number): { azimuthDeg: number; elevationDeg: number } {
    return { azimuthDeg: latDeg < 0 ? 35 : 215, elevationDeg: 55 };
}

interface SampleBuffers {
    W: number; H: number; fx: number; fy: number; cx: number; cy: number;
    /** An ortho camera: fx, fy are samples per metre, every ray is `fwd`. */
    ortho: boolean; camera: RenderCamera;
    depth: Float32Array; mesh: Int32Array; tri: Int32Array; meshes: TileTriangles[];
}

/** World position of a sample (its camera depth along the ray through the sample's centre). */
function sampleWorld(g: SampleBuffers, x: number, y: number, out: Float64Array): void {
    const z = g.depth[y * g.W + x];
    const xc = (x + 0.5 - g.cx) / g.fx, yc = -(y + 0.5 - g.cy) / g.fy;
    const { eye, right, up, fwd } = g.camera;
    if (g.ortho) for (let a = 0; a < 3; a++) out[a] = eye[a] + right[a] * xc + up[a] * yc + z * fwd[a];
    else for (let a = 0; a < 3; a++) out[a] = eye[a] + z * (right[a] * xc + up[a] * yc + fwd[a]);
}

interface ShadowCascade { a0: number; b0: number; texel: number; n: number; map: Float32Array }

/**
 * Per sample, the share of the sun it sees (0..1): two orthographic shadow maps along the sun (the nearer half of the visible
 * samples, then all of them), each storing the highest sun-ward depth of any arm or context triangle (both faces; alpha-tested
 * leaves do not cast), read with a slope-scaled bias and 3 x 3 percentage-closer filtering.
 */
function sunVisibility(g: SampleBuffers, lit: typeof PHOTO_MATCH_LIT & { sunDir: Vec3 }): Float32Array {
    const L = lit.sunDir;
    // the sun frame: A and B across the sun, d towards it
    const ref = Math.abs(L[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let A = [L[1] * ref[2] - L[2] * ref[1], L[2] * ref[0] - L[0] * ref[2], L[0] * ref[1] - L[1] * ref[0]];
    const al = Math.hypot(A[0], A[1], A[2]); A = A.map(v => v / al);
    const B = [L[1] * A[2] - L[2] * A[1], L[2] * A[0] - L[0] * A[2], L[0] * A[1] - L[1] * A[0]];
    const n = g.W * g.H;
    const sa = new Float32Array(n), sb = new Float32Array(n), sd = new Float32Array(n);
    const zs: number[] = [];
    const p = new Float64Array(3);
    for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
        const i = y * g.W + x;
        if (g.mesh[i] < 0) continue;
        sampleWorld(g, x, y, p);
        sa[i] = p[0] * A[0] + p[1] * A[1] + p[2] * A[2]; sb[i] = p[0] * B[0] + p[1] * B[1] + p[2] * B[2]; sd[i] = p[0] * L[0] + p[1] * L[1] + p[2] * L[2];
        if ((i & 7) === 0) zs.push(g.depth[i]);
    }
    const vis = new Float32Array(n).fill(1);
    if (!zs.length) return vis;
    zs.sort((u, v) => u - v);
    const zNear = zs[Math.floor(zs.length * 0.5)];
    const cascade = (zMax: number): ShadowCascade | undefined => {
        let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
        for (let i = 0; i < n; i++) {
            if (g.mesh[i] < 0 || g.depth[i] > zMax) continue;
            a0 = Math.min(a0, sa[i]); a1 = Math.max(a1, sa[i]); b0 = Math.min(b0, sb[i]); b1 = Math.max(b1, sb[i]);
        }
        if (!(a1 >= a0)) return undefined;
        const size = lit.shadowMapPx;
        const texel = Math.max(1e-3, Math.max(a1 - a0, b1 - b0) / (size - 4));
        const c: ShadowCascade = { a0: a0 - 2 * texel, b0: b0 - 2 * texel, texel, n: size, map: new Float32Array(size * size).fill(-Infinity) };
        for (const m of g.meshes) rasterizeCasters(m, A, B, L, c);
        return c;
    };
    const cascades = [cascade(zNear), cascade(Infinity)].filter((c): c is ShadowCascade => !!c);
    for (let i = 0; i < n; i++) {
        const mi = g.mesh[i];
        if (mi < 0) continue;
        const m = g.meshes[mi], t = g.tri[i];
        const cosI = Math.abs(m.normals[t * 3] * L[0] + m.normals[t * 3 + 1] * L[1] + m.normals[t * 3 + 2] * L[2]);
        const tanI = Math.min(8, Math.sqrt(Math.max(0, 1 - cosI * cosI)) / Math.max(1e-3, cosI));
        for (const c of cascades) {
            const fu = (sa[i] - c.a0) / c.texel, fv = (sb[i] - c.b0) / c.texel;
            if (fu < 1 || fv < 1 || fu > c.n - 2 || fv > c.n - 2) continue;
            // the filter reads up to 1.5 texels away, where the surface itself is tanI per texel nearer the sun
            const bias = c.texel * (lit.shadowBiasTexels + 2 * tanI);
            const iu = Math.floor(fu), iv = Math.floor(fv);
            let lightTaps = 0;
            for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) if (c.map[(iv + dv) * c.n + iu + du] <= sd[i] + bias) lightTaps++;
            vis[i] = lightTaps / 9;
            break;
        }
    }
    return vis;
}

/** Writes the highest sun-ward depth of every triangle of `m` (both faces) into the cascade's texels it covers. */
function rasterizeCasters(m: TileTriangles, A: number[], B: number[], L: Vec3, c: ShadowCascade): void {
    const P = m.positions, nt = m.texture.length;
    const leafT = m.cutout?.textured, leafC = m.cutout?.clay;
    const u = [0, 0, 0], v = [0, 0, 0], d = [0, 0, 0];
    for (let t = 0; t < nt; t++) {
        if ((leafT && leafT[t] >= 0) || (leafC && leafC[t] >= 0)) continue;
        for (let k = 0; k < 3; k++) {
            const o = t * 9 + k * 3;
            u[k] = (P[o] * A[0] + P[o + 1] * A[1] + P[o + 2] * A[2] - c.a0) / c.texel;
            v[k] = (P[o] * B[0] + P[o + 1] * B[1] + P[o + 2] * B[2] - c.b0) / c.texel;
            d[k] = P[o] * L[0] + P[o + 1] * L[1] + P[o + 2] * L[2];
        }
        const x0 = Math.max(0, Math.floor(Math.min(u[0], u[1], u[2]))), x1 = Math.min(c.n - 1, Math.ceil(Math.max(u[0], u[1], u[2])));
        const y0 = Math.max(0, Math.floor(Math.min(v[0], v[1], v[2]))), y1 = Math.min(c.n - 1, Math.ceil(Math.max(v[0], v[1], v[2])));
        if (x0 > x1 || y0 > y1) continue;
        const area = (u[1] - u[0]) * (v[2] - v[0]) - (u[2] - u[0]) * (v[1] - v[0]);
        if (Math.abs(area) < 1e-9) {
            // edge-on to the sun (a wall under a sun in its plane) or sub-texel: its corners still cast
            for (let k = 0; k < 3; k++) {
                const xi = Math.round(u[k]), yi = Math.round(v[k]);
                if (xi >= 0 && yi >= 0 && xi < c.n && yi < c.n && d[k] > c.map[yi * c.n + xi]) c.map[yi * c.n + xi] = d[k];
            }
            continue;
        }
        for (let py = y0; py <= y1; py++) {
            const yc = py + 0.5;
            for (let px = x0; px <= x1; px++) {
                const xc = px + 0.5;
                // conservative: a texel the triangle touches anywhere (half-texel slack) is covered
                let w0 = ((u[1] - xc) * (v[2] - yc) - (u[2] - xc) * (v[1] - yc)) / area;
                let w1 = ((u[2] - xc) * (v[0] - yc) - (u[0] - xc) * (v[2] - yc)) / area;
                let w2 = 1 - w0 - w1;
                const slack = -0.5 / Math.sqrt(Math.abs(area));
                if (w0 < slack || w1 < slack || w2 < slack) continue;
                w0 = Math.max(0, w0); w1 = Math.max(0, w1); w2 = Math.max(0, w2);
                const s = w0 + w1 + w2;
                const dz = (w0 * d[0] + w1 * d[1] + w2 * d[2]) / s;
                const i = py * c.n + px;
                if (dz > c.map[i]) c.map[i] = dz;
            }
        }
    }
}

/**
 * Per sample, the sky's share after ambient occlusion (1 = open): a normal-oriented hemisphere of `aoSamples` points within
 * the radius around the sample's surface point (rotated per pixel in a 4 x 4 pattern), each occluded when the depth buffer
 * holds something in front of it within the radius; then a 5 x 5 depth-aware blur removes the pattern.
 */
function screenSpaceAo(g: SampleBuffers, lit: typeof PHOTO_MATCH_LIT & { sunDir: Vec3 }): Float32Array {
    const { W, H, fx, fy, cx, cy, ortho, camera, depth, mesh, tri, meshes } = g;
    const n = W * H, raw = new Float32Array(n).fill(1);
    const K = Math.max(4, Math.round(lit.aoSamples));
    // the kernel: a Fibonacci hemisphere (z up), lengths growing towards the radius
    const kern: number[][] = [];
    for (let k = 0; k < K; k++) {
        const zc = 1 - (k + 0.5) / K, r = Math.sqrt(1 - zc * zc), ph = k * 2.399963229728653;
        const s = 0.15 + 0.85 * ((k + 1) / K) ** 2;
        kern.push([r * Math.cos(ph) * s, r * Math.sin(ph) * s, Math.max(0.1, zc) * s]);
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, mi = mesh[i];
        if (mi < 0) continue;
        const m = meshes[mi], t = tri[i];
        const z = depth[i];
        const xc = (x + 0.5 - cx) / fx, yc = -(y + 0.5 - cy) / fy;
        // the sample in camera coordinates (x right, y up, z along the view; under an ortho camera x and y do not scale with z)
        const Px = ortho ? xc : xc * z, Py = ortho ? yc : yc * z, Pz = z;
        // the facet normal in camera coordinates, turned towards the camera
        const wn = [m.normals[t * 3], m.normals[t * 3 + 1], m.normals[t * 3 + 2]];
        let Nx = wn[0] * camera.right[0] + wn[1] * camera.right[1] + wn[2] * camera.right[2];
        let Ny = wn[0] * camera.up[0] + wn[1] * camera.up[1] + wn[2] * camera.up[2];
        let Nz = wn[0] * camera.fwd[0] + wn[1] * camera.fwd[1] + wn[2] * camera.fwd[2];
        if (Nx * Px + Ny * Py + Nz * Pz > 0) { Nx = -Nx; Ny = -Ny; Nz = -Nz; }
        const R = Math.max(lit.aoRadiusM, lit.aoRadiusPerM * z);
        // tangent frame rotated per pixel (4 x 4 pattern)
        const ang = (((x & 3) * 4 + (y & 3)) * 2.399963229728653);
        let Tx = Math.cos(ang), Ty = Math.sin(ang), Tz = 0.3;
        const dn = Tx * Nx + Ty * Ny + Tz * Nz;
        Tx -= dn * Nx; Ty -= dn * Ny; Tz -= dn * Nz;
        let tl = Math.hypot(Tx, Ty, Tz);
        if (tl < 1e-6) { Tx = 1; Ty = 0; Tz = 0; const d2 = Nx; Tx -= d2 * Nx; Ty -= d2 * Ny; Tz -= d2 * Nz; tl = Math.hypot(Tx, Ty, Tz) || 1; }
        Tx /= tl; Ty /= tl; Tz /= tl;
        const Bx = Ny * Tz - Nz * Ty, By = Nz * Tx - Nx * Tz, Bz = Nx * Ty - Ny * Tx;
        let occ = 0;
        for (const [kx, ky, kz] of kern) {
            const Sx = Px + R * (Tx * kx + Bx * ky + Nx * kz), Sy = Py + R * (Ty * kx + By * ky + Ny * kz), Sz = Pz + R * (Tz * kx + Bz * ky + Nz * kz);
            if (Sz <= PHOTO_MATCH_NEAR_M) continue;
            const qx = Math.floor(ortho ? cx + fx * Sx : cx + (fx * Sx) / Sz), qy = Math.floor(ortho ? cy - fy * Sy : cy - (fy * Sy) / Sz);
            if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
            const qz = depth[qy * W + qx];
            if (!(qz < Sz - 0.02 * R)) continue;
            // range check: an occluder far in front of the sample (a different surface) counts less
            const gap = Sz - qz;
            occ += gap < R ? 1 : Math.max(0, 1 - (gap - R) / R);
        }
        raw[i] = 1 - lit.aoStrength * (occ / K);
    }
    // depth-aware 5 x 5 blur
    const out = new Float32Array(n).fill(1);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (mesh[i] < 0) continue;
        const z = depth[i], tol = 0.05 * z + 0.1;
        let s = 0, w = 0;
        for (let dy = -2; dy <= 2; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -2; dx <= 2; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= W) continue;
                const j = yy * W + xx;
                if (mesh[j] < 0 || Math.abs(depth[j] - z) > tol) continue;
                s += raw[j]; w++;
            }
        }
        out[i] = w ? s / w : raw[i];
    }
    return out;
}

/** The fixed environment of the specular term (linear RGB): the street below the horizon, the far side's facades, the sky. */
export const PHOTO_MATCH_ENVIRONMENT: { ground: Vec3; facades: Vec3; horizon: Vec3; zenith: Vec3; facadeTopRad: number } = {
    ground: [0.09, 0.09, 0.085], facades: [0.2, 0.2, 0.21], horizon: [0.72, 0.77, 0.84], zenith: [0.3, 0.45, 0.75], facadeTopRad: 0.25
};

function environmentAt(ry: number, out: Float64Array): void {
    const E = PHOTO_MATCH_ENVIRONMENT;
    const e = Math.asin(Math.max(-1, Math.min(1, ry)));
    if (e < 0) { out[0] = E.ground[0]; out[1] = E.ground[1]; out[2] = E.ground[2]; return; }
    if (e < E.facadeTopRad) {
        // the far side's facades, giving way to the sky over their last few degrees
        const k = Math.max(0, (e - 0.8 * E.facadeTopRad) / (0.2 * E.facadeTopRad));
        for (let c = 0; c < 3; c++) out[c] = E.facades[c] * (1 - k) + E.horizon[c] * k;
        return;
    }
    const k = Math.min(1, (e - E.facadeTopRad) / (Math.PI / 2 - E.facadeTopRad));
    for (let c = 0; c < 3; c++) out[c] = E.horizon[c] * (1 - Math.sqrt(k)) + E.zenith[c] * Math.sqrt(k);
}

const envTmp = new Float64Array(3);
/** The environment seen along (rx, ry, rz), blurred towards its irradiance at a normal with up component `ny` by roughness squared. */
function specularEnvironment(_rx: number, ry: number, _rz: number, ny: number, roughness: number, out: Float64Array): void {
    environmentAt(ry, out);
    const E = PHOTO_MATCH_ENVIRONMENT;
    // irradiance: the lower hemisphere's street and facades against the upper's sky, by how far the normal looks up
    const up = 0.5 + 0.5 * ny;
    const w = Math.min(1, roughness * roughness);
    for (let c = 0; c < 3; c++) {
        envTmp[c] = (0.5 * (E.ground[c] + E.facades[c])) * (1 - up) + (0.5 * (E.horizon[c] + E.zenith[c]) * 0.7 + 0.3 * E.facades[c]) * up;
        out[c] = out[c] * (1 - w) + envTmp[c] * w;
    }
}

/** Roughness and metalness of triangle `t` at (u, v): its material's factors times its texture (nearest), or 1 and 0. */
function pbrAt(m: TileTriangles, t: number, u: number, v: number): { roughness: number; metalness: number } {
    const k = m.pbr?.material[t] ?? -1;
    if (k < 0) return { roughness: 1, metalness: 0 };
    const mat = m.pbr!.materials[k];
    let r = mat.roughnessFactor, me = mat.metallicFactor;
    const map = mat.map;
    if (map) {
        let fu = u - (map.repeatS ? Math.floor(u) : 0), fv = v - (map.repeatT ? Math.floor(v) : 0);
        fu = Math.min(1, Math.max(0, fu)); fv = Math.min(1, Math.max(0, fv));
        const px = Math.min(map.width - 1, Math.floor(fu * map.width)), py = Math.min(map.height - 1, Math.floor(fv * map.height));
        r *= map.roughness[py * map.width + px] / 255;
        me *= map.metalness[py * map.width + px] / 255;
    }
    return { roughness: Math.max(0.02, Math.min(1, r)), metalness: Math.max(0, Math.min(1, me)) };
}

// =============================================================================
// Arm layers: fixed triangles, or trees resolved per view
// =============================================================================

/** One GLB of an arm: its triangles as drawn from every pose, or a trees GLB whose level per tree follows each view. */
export interface ArmLayer { fixed?: TileTriangles; trees?: TreesLodGlb }

/**
 * Reads one arm GLB. With `treeLod` (default true) a trees GLB of the tree LOD contract is kept for per-view level selection;
 * with `treeLod: false`, or for any other GLB, its triangles are fixed (a trees GLB then draws every level at once).
 */
export function loadArmLayer(glb: Uint8Array, options: { treeLod?: boolean; pbr?: boolean } = {}): ArmLayer {
    if (options.treeLod !== false) {
        const trees = readTreesLodGlb(glb);
        if (trees) return { trees };
    }
    return { fixed: readTileTriangles(glb, options.pbr ? { pbr: true } : {}) };
}

/** Triangles a layer holds before view selection (a trees layer: every level). */
export function armLayerTriangles(l: ArmLayer): number {
    return l.fixed ? l.fixed.texture.length : l.trees ? l.trees.all.texture.length : 0;
}

/**
 * The meshes of an arm's layers as the viewport would draw them from `camera`, and what each trees layer chose. The tree
 * level rule is written for a pinhole; an ortho camera is given to it as the pinhole at the same eye whose focal length
 * puts one pixel at `pixelM` metres at the eye's height above the frame origin (the same on-screen tree size at the ground).
 */
export function armMeshesForView(layers: ArmLayer[], camera: RenderCamera, view?: TreeLodViewInput | null): { meshes: TileTriangles[]; trees: TreesForView[] } {
    const meshes: TileTriangles[] = [], trees: TreesForView[] = [];
    const lodCamera: PinholeCamera = isOrthoCamera(camera) ? orthoLodPinhole(camera) : camera;
    for (const l of layers) {
        if (l.fixed) meshes.push(l.fixed);
        else if (l.trees) { const t = treesForView(l.trees, lodCamera, view); trees.push(t); meshes.push(t.triangles); }
    }
    return { meshes, trees };
}

function orthoLodPinhole(c: OrthoCamera): PinholeCamera {
    const h = Math.max(1, Math.abs(c.eye[0] * c.fwd[0] + c.eye[1] * c.fwd[1] + c.eye[2] * c.fwd[2]));
    const f = h / c.pixelM;
    return { eye: c.eye, right: c.right, up: c.up, fwd: c.fwd, fx: f, fy: f, cx: c.cx, cy: c.cy, width: c.width, height: c.height };
}

// =============================================================================
// Perceptual metrics (secondary)
// =============================================================================

/** Working width of the metrics (px): the fit metric's scale. */
export const PHOTO_MATCH_METRIC_WIDTH_PX = 640;

export interface PerceptualScores {
    /** Share of the building mask the arm covers. */
    coverage: number;
    /** Mean luminance SSIM over the mask (Gaussian window, sigma 1.5 px at the working width). */
    ssim: number | null;
    /** Symmetric structural-edge chamfer inside the mask (px at the working width, truncated). Lower is better. */
    edgeChamferPx: number | null;
    /** Mean CIEDE2000 of the colours blurred at sigma 3 px, over the mask. Lower is better. */
    colourDeltaE: number | null;
    maskPixels: number;
}

function resizeRgbaBox(img: { width: number; height: number; rgba: Uint8Array }, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    const sx = img.width / w, sy = img.height / h;
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
            const s = [0, 0, 0, 0];
            let n = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const k = (yy * img.width + xx) * 4; s[0] += img.rgba[k]; s[1] += img.rgba[k + 1]; s[2] += img.rgba[k + 2]; s[3] += img.rgba[k + 3]; n++; }
            for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = Math.round(s[c] / Math.max(1, n));
        }
    }
    return out;
}

function resizeField(f: Float32Array, W: number, H: number, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    const sx = W / w, sy = H / h;
    for (let y = 0; y < h; y++) {
        const y0 = Math.floor(y * sy), y1 = Math.min(H, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
        for (let x = 0; x < w; x++) {
            const x0 = Math.floor(x * sx), x1 = Math.min(W, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
            let s = 0, n = 0;
            for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += f[yy * W + xx]; n++; }
            out[y * w + x] = n ? s / n : 0;
        }
    }
    return out;
}

/** Per-pixel SSIM of two luminance images (0..255) (Gaussian window of `sigma` px). */
function ssimMap(a: Float32Array, b: Float32Array, w: number, h: number, sigma = 1.5): Float64Array {
    const n = w * h;
    const ab = new Float32Array(n), aa = new Float32Array(n), bb = new Float32Array(n);
    for (let i = 0; i < n; i++) { ab[i] = a[i] * b[i]; aa[i] = a[i] * a[i]; bb[i] = b[i] * b[i]; }
    const ma = gaussianBlur(a, w, h, sigma), mb = gaussianBlur(b, w, h, sigma);
    const saa = gaussianBlur(aa, w, h, sigma), sbb = gaussianBlur(bb, w, h, sigma), sab = gaussianBlur(ab, w, h, sigma);
    const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const va = Math.max(0, saa[i] - ma[i] * ma[i]), vb = Math.max(0, sbb[i] - mb[i] * mb[i]), cab = sab[i] - ma[i] * mb[i];
        out[i] = ((2 * ma[i] * mb[i] + C1) * (2 * cab + C2)) / ((ma[i] * ma[i] + mb[i] * mb[i] + C1) * (va + vb + C2));
    }
    return out;
}

function meanOverMask(map: Float64Array, mask: Uint8Array): number | null {
    let s = 0, k = 0;
    for (let i = 0; i < map.length; i++) {
        if (!mask[i]) continue;
        s += map[i];
        k++;
    }
    return k >= 200 ? s / k : null;
}

/** Mean SSIM of two luminance images (0..255) over a mask. */
export function maskedSsim(a: Float32Array, b: Float32Array, w: number, h: number, mask: Uint8Array, sigma = 1.5): number | null {
    return meanOverMask(ssimMap(a, b, w, h, sigma), mask);
}

/** What the secondary numbers of one render against its photo share between masks, at PHOTO_MATCH_METRIC_WIDTH_PX wide. */
interface PerceptualPair {
    W: number; H: number; w: number; h: number;
    lp: Float32Array; lr: Float32Array; cov: Float32Array; ssim: Float64Array;
    /** CIEDE2000 of the blurred colours at every second pixel (rows and columns), NaN elsewhere. */
    de: Float64Array;
}

function perceptualPair(photo: DecodedImage, render: ArmRender): PerceptualPair {
    const W = photo.width, H = photo.height;
    const w = Math.min(W, PHOTO_MATCH_METRIC_WIDTH_PX), h = Math.max(1, Math.round((H * w) / W));
    const cov = resizeField(render.coverage, W, H, w, h);
    const lp = reducedLuminance(photo, w, h), lr = reducedLuminance({ width: render.width, height: render.height, rgba: render.rgba }, w, h);
    // colour: blurred linear RGB -> Lab, CIEDE2000, every second pixel
    const rp = resizeRgbaBox(photo, w, h), rr = resizeRgbaBox(render, w, h);
    const chan = (src: Uint8Array, c: number) => { const f = new Float32Array(w * h); for (let i = 0; i < f.length; i++) f[i] = SRGB8_TO_LINEAR[src[i * 4 + c]]; return gaussianBlur(f, w, h, 3); };
    const P = [0, 1, 2].map(c => chan(rp, c)), R = [0, 1, 2].map(c => chan(rr, c));
    const de = new Float64Array(w * h).fill(NaN);
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
        const i = y * w + x;
        de[i] = deltaE00(linearToLab(P[0][i], P[1][i], P[2][i]), linearToLab(R[0][i], R[1][i], R[2][i]));
    }
    return { W, H, w, h, lp, lr, cov, ssim: ssimMap(lp, lr, w, h), de };
}

const r3n = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);

/** The mask (photo resolution) at the working width: a working pixel is in it when at least half its area is. */
function workingMask(p: Pick<PerceptualPair, 'W' | 'H' | 'w' | 'h'>, mask: Uint8Array): { region: Uint8Array; pixels: number } {
    const m = resizeField(Float32Array.from(mask), p.W, p.H, p.w, p.h);
    const region = new Uint8Array(p.w * p.h);
    let pixels = 0;
    for (let i = 0; i < region.length; i++) if (m[i] >= 0.5) { region[i] = 1; pixels++; }
    return { region, pixels };
}

function perceptualOnMask(p: PerceptualPair, mask: Uint8Array): PerceptualScores {
    const { w, h, lp, lr, cov } = p;
    const { region, pixels: maskPixels } = workingMask(p, mask);
    let covered = 0;
    for (let i = 0; i < region.length; i++) if (region[i] && cov[i] >= 0.5) covered++;
    const ssim = meanOverMask(p.ssim, region);
    // structural edges both ways inside the mask (the photo's found around it, so a mask edge does not cut its segments)
    const near = new Uint8Array(w * h);
    const dtMask = distanceTransform(region, w, h, 8);
    for (let i = 0; i < near.length; i++) if (dtMask[i] <= 6) near[i] = 1;
    const eP = structuralEdges(lp, w, h, near), eR = structuralEdges(lr, w, h, near);
    const dtP = distanceTransform(eP, w, h, FIT_CHAMFER_TRUNCATION_PX + 1), dtR = distanceTransform(eR, w, h, FIT_CHAMFER_TRUNCATION_PX + 1);
    const ca = chamferMean(eR, dtP, region), cb = chamferMean(eP, dtR, region);
    const edgeChamferPx = ca !== null && cb !== null ? (ca + cb) / 2 : ca ?? cb;
    let de = 0, nd = 0;
    for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
        const i = y * w + x;
        if (!region[i]) continue;
        de += p.de[i];
        nd++;
    }
    return { coverage: maskPixels ? r3n(covered / maskPixels)! : 0, ssim: r3n(ssim), edgeChamferPx: r3n(edgeChamferPx), colourDeltaE: nd >= 50 ? r3n(de / nd) : null, maskPixels };
}

/**
 * The secondary numbers of one arm render against the photo, inside `mask` (photo resolution, 1 = the building).
 * Everything is computed at PHOTO_MATCH_METRIC_WIDTH_PX wide.
 */
export function perceptualScores(photo: DecodedImage, render: ArmRender, mask: Uint8Array): PerceptualScores {
    return perceptualOnMask(perceptualPair(photo, render), mask);
}

/** The building mask of a view: pixels the reference render covers at least half. */
export function coverageMask(render: ArmRender): Uint8Array {
    const m = new Uint8Array(render.width * render.height);
    for (let i = 0; i < m.length; i++) if (render.coverage[i] >= 0.5) m[i] = 1;
    return m;
}

// =============================================================================
// Regions: what each pixel's ray hits, from geometry
// =============================================================================

/** The terrain under a point (tile frame, metres), NaN where it is not measured; StreetViewSurveyPlanner's GroundModel is one. */
export interface TerrainLookup { groundAt(x: number, z: number): number }

/** A triangle is ground when none of its vertices stands more than this above the terrain under it (the base cleanup's street band). */
export const PHOTO_MATCH_GROUND_BAND_M = 0.6;
/** Off the measured terrain (the far field), a triangle is ground when its normal is within 60 degrees of vertical. */
export const PHOTO_MATCH_OFF_TERRAIN_UP = 0.5;
/** Half-width of the skyline band as a share of the image width (8 px at 640), at least 2 px. */
export const PHOTO_MATCH_SKYLINE_BAND_SHARE = 0.0125;

/**
 * Region labels per triangle, from geometry alone: REGION.ground when no vertex stands more than PHOTO_MATCH_GROUND_BAND_M
 * above the terrain under it (a vertex off the terrain is not counted; a triangle wholly off it is ground when it faces within
 * 60 degrees of up), else `standing`: one label for the whole mesh, or a function of the triangle and its centroid's (x, z)
 * (the target's footprint, a matched crown).
 */
export function triangleRegions(t: TileTriangles, terrain: TerrainLookup, standing: number | ((tri: number, x: number, z: number) => number)): Uint8Array {
    const n = t.texture.length, P = t.positions;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        let known = 0, high = false;
        for (let k = 0; k < 3 && !high; k++) {
            const o = i * 9 + k * 3;
            const g = terrain.groundAt(P[o], P[o + 2]);
            if (g !== g) continue;
            known++;
            if (P[o + 1] - g > PHOTO_MATCH_GROUND_BAND_M) high = true;
        }
        const ground = known ? !high : Math.abs(t.normals[i * 3 + 1]) >= PHOTO_MATCH_OFF_TERRAIN_UP;
        if (ground) out[i] = REGION.ground;
        else out[i] = typeof standing === 'number' ? standing : standing(i, (P[i * 9] + P[i * 9 + 3] + P[i * 9 + 6]) / 3, (P[i * 9 + 2] + P[i * 9 + 5] + P[i * 9 + 8]) / 3);
    }
    return out;
}

/** The terrain grid a plan outline is drawn on (StreetViewSurveyPlanner's GroundModel is one). */
export interface TerrainGrid extends TerrainLookup { x0: number; z0: number; nx: number; nz: number; cellMeters: number; cellIndex(x: number, z: number): number }

/**
 * A cell is in a plan outline when its centre lies within this (m) of a standing triangle in plan: a wall on a cell boundary
 * takes the cells on both sides, and a wall rebuilt up to half a metre outside the scanned one (K clips at 0.3 m) stays inside.
 */
export const PHOTO_MATCH_OUTLINE_REACH_M = 1;

/**
 * The plan outline of a mesh on the terrain grid, from geometry alone: 1 for every cell whose centre lies within
 * PHOTO_MATCH_OUTLINE_REACH_M in plan of one of its standing triangles (standing as triangleRegions decides: a roof by its
 * area, a wall by its foot line), and for every cell those enclose (not 4-connected to the grid's edge through cells outside:
 * a courtyard, a gap in the roof).
 */
export function planOutlineCells(t: TileTriangles, terrain: TerrainGrid, reachM = PHOTO_MATCH_OUTLINE_REACH_M): Uint8Array {
    const { x0, z0, nx, nz, cellMeters: cell } = terrain;
    const out = new Uint8Array(nx * nz);
    const labels = triangleRegions(t, terrain, REGION.target);
    const P = t.positions, r2 = reachM * reachM;
    const segDist2 = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
        const dx = bx - ax, dz = bz - az, l = dx * dx + dz * dz;
        const s = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l)) : 0;
        const ex = ax + s * dx - px, ez = az + s * dz - pz;
        return ex * ex + ez * ez;
    };
    for (let i = 0; i < labels.length; i++) {
        if (labels[i] !== REGION.target) continue;
        const o = i * 9, ax = P[o], az = P[o + 2], bx = P[o + 3], bz = P[o + 5], cx = P[o + 6], cz = P[o + 8];
        const area2 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
        const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - reachM - x0) / cell)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) + reachM - x0) / cell));
        const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - reachM - z0) / cell)), k1 = Math.min(nz - 1, Math.floor((Math.max(az, bz, cz) + reachM - z0) / cell));
        for (let k = k0; k <= k1; k++) for (let j = i0; j <= i1; j++) {
            const c = k * nx + j;
            if (out[c]) continue;
            const px = x0 + (j + 0.5) * cell, pz = z0 + (k + 0.5) * cell;
            let inside = false;
            if (Math.abs(area2) > 1e-9) {
                const w0 = (bx - px) * (cz - pz) - (bz - pz) * (cx - px), w1 = (cx - px) * (az - pz) - (cz - pz) * (ax - px), w2 = (ax - px) * (bz - pz) - (az - pz) * (bx - px);
                inside = area2 > 0 ? w0 >= 0 && w1 >= 0 && w2 >= 0 : w0 <= 0 && w1 <= 0 && w2 <= 0;
            }
            if (inside || Math.min(segDist2(px, pz, ax, az, bx, bz), segDist2(px, pz, bx, bz, cx, cz), segDist2(px, pz, cx, cz, ax, az)) <= r2) out[c] = 1;
        }
    }
    // the cells outside: 4-connected to the grid's edge through cells not in the outline; the rest are enclosed by it
    const outside = new Uint8Array(nx * nz), stack: number[] = [];
    const seed = (c: number) => { if (!out[c] && !outside[c]) { outside[c] = 1; stack.push(c); } };
    for (let j = 0; j < nx; j++) { seed(j); seed((nz - 1) * nx + j); }
    for (let k = 0; k < nz; k++) { seed(k * nx); seed(k * nx + nx - 1); }
    while (stack.length) {
        const c = stack.pop()!, j = c % nx, k = (c - j) / nx;
        if (j > 0) seed(c - 1);
        if (j + 1 < nx) seed(c + 1);
        if (k > 0) seed(c - nx);
        if (k + 1 < nz) seed(c + nx);
    }
    for (let c = 0; c < out.length; c++) if (!outside[c]) out[c] = 1;
    return out;
}

/** The masks the secondary numbers are measured over: the whole frame, the target (building), the ground, the neighbours, the measured tree crowns and the skyline band. */
export const PHOTO_MATCH_REGIONS = ['frame', 'building', 'ground', 'neighbours', 'trees', 'skyline'] as const;
export type PhotoMatchRegion = typeof PHOTO_MATCH_REGIONS[number];

export interface RegionMasks {
    width: number; height: number;
    /** Per region, 1 = in it (photo resolution). The skyline band overlaps the others. */
    masks: Record<PhotoMatchRegion, Uint8Array>;
    /** Pixels per label and in the skyline band (photo resolution). */
    pixels: { sky: number; ground: number; neighbours: number; target: number; trees: number; skyline: number };
    /** The band's half-width (px). */
    bandPx: number;
}

export function skylineBandPx(width: number): number {
    return Math.max(2, Math.round(width * PHOTO_MATCH_SKYLINE_BAND_SHARE));
}

/**
 * The region masks of a label image (REGION per pixel): one per label, and the skyline band, every pixel within `bandPx`
 * of a pixel where standing geometry (target, neighbours, trees) and the sky are 4-neighbours, on either side of it.
 */
export function regionMasks(labels: Uint8Array, width: number, height: number, bandPx = skylineBandPx(width)): RegionMasks {
    const n = width * height;
    const masks = Object.fromEntries(PHOTO_MATCH_REGIONS.map(r => [r, new Uint8Array(n)])) as Record<PhotoMatchRegion, Uint8Array>;
    masks.frame.fill(1);
    const pixels = { sky: 0, ground: 0, neighbours: 0, target: 0, trees: 0, skyline: 0 };
    const edge = new Uint8Array(n);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x, l = labels[i];
        if (l === REGION.sky) pixels.sky++;
        else if (l === REGION.ground) { pixels.ground++; masks.ground[i] = 1; }
        else if (l === REGION.neighbours) { pixels.neighbours++; masks.neighbours[i] = 1; }
        else if (l === REGION.target) { pixels.target++; masks.building[i] = 1; }
        else if (l === REGION.trees) { pixels.trees++; masks.trees[i] = 1; }
        // the skyline's own pixels: standing beside sky, and sky beside standing (4-neighbours)
        const s = isStanding(l), sky = l === REGION.sky;
        if (!s && !sky) continue;
        const meets = (j: number) => (s ? labels[j] === REGION.sky : isStanding(labels[j]));
        if ((x > 0 && meets(i - 1)) || (x + 1 < width && meets(i + 1)) || (y > 0 && meets(i - width)) || (y + 1 < height && meets(i + width))) edge[i] = 1;
    }
    const dt = distanceTransform(edge, width, height, bandPx + 1);
    for (let i = 0; i < n; i++) if (dt[i] <= bandPx) { masks.skyline[i] = 1; pixels.skyline++; }
    return { width, height, masks, pixels, bandPx };
}

export interface RegionScore extends Omit<PerceptualScores, 'coverage'> {
    /** Share of the frame the region holds. */
    share: number;
    /**
     * Share of the region where the arm's render shows what the reference shows (its label; in the skyline band whether it
     * shows standing geometry, ground or sky), null without the arm's region labels.
     */
    agreement: number | null;
}

/** Ground, standing geometry or sky: what the skyline band's agreement compares. */
const skylineClass = (l: number) => (l === REGION.sky ? 0 : l === REGION.ground ? 1 : 2);

/**
 * The secondary numbers of one arm render against the photo in every region of the reference's masks (PHOTO_MATCH_REGIONS),
 * and how far the arm's own labels agree with the reference's there. A region with no pixels has null numbers.
 */
export function regionScores(photo: DecodedImage, render: ArmRender, regions: RegionMasks, reference: Uint8Array): Record<PhotoMatchRegion, RegionScore> {
    const pair = perceptualPair(photo, render);
    const total = regions.width * regions.height;
    const out = {} as Record<PhotoMatchRegion, RegionScore>;
    for (const r of PHOTO_MATCH_REGIONS) {
        const mask = regions.masks[r];
        let inside = 0, agree = 0;
        for (let i = 0; i < total; i++) {
            if (!mask[i]) continue;
            inside++;
            if (render.regions && (r === 'skyline' ? skylineClass(render.regions[i]) === skylineClass(reference[i]) : render.regions[i] === reference[i])) agree++;
        }
        const agreement = render.regions && inside ? r3n(agree / inside) : null;
        if (!inside) { out[r] = { share: 0, agreement: null, ssim: null, edgeChamferPx: null, colourDeltaE: null, maskPixels: 0 }; continue; }
        const { coverage: _coverage, ...s } = perceptualOnMask(pair, mask);
        out[r] = { share: r3n(inside / total)!, agreement, ...s };
    }
    return out;
}

/** The overlay colours of the regions (sRGB); the sky is left as it is. */
export const PHOTO_MATCH_REGION_COLOURS: { target: Vec3; neighbours: Vec3; ground: Vec3; trees: Vec3; skyline: Vec3 } = {
    target: [235, 64, 52], neighbours: [56, 116, 240], ground: [64, 196, 84], trees: [196, 72, 220], skyline: [255, 214, 32]
};
/** The overlay's legend, for a grid label (the colours by name). */
export const PHOTO_MATCH_REGION_LEGEND = ['RED TARGET BLUE NEIGHBOURS GREEN GROUND', 'PURPLE TREES YELLOW SKYLINE'] as const;

/** `image` tinted by region (REGION labels at its resolution), the skyline band (when given) drawn over the rest. */
export function regionOverlay(image: { width: number; height: number; rgba: Uint8Array }, labels: Uint8Array, skyline?: Uint8Array, alpha = 0.45): { width: number; height: number; rgba: Uint8Array } {
    const C = PHOTO_MATCH_REGION_COLOURS;
    const byLabel: Array<Vec3 | undefined> = [];
    byLabel[REGION.target] = C.target; byLabel[REGION.neighbours] = C.neighbours; byLabel[REGION.ground] = C.ground; byLabel[REGION.trees] = C.trees;
    const rgba = Uint8Array.from(image.rgba);
    for (let i = 0; i < labels.length; i++) {
        const band = skyline?.[i];
        const c = band ? C.skyline : byLabel[labels[i]];
        if (!c) continue;
        const a = band ? 0.55 : alpha;
        for (let k = 0; k < 3; k++) rgba[i * 4 + k] = Math.round(rgba[i * 4 + k] * (1 - a) + c[k] * a);
    }
    return { width: image.width, height: image.height, rgba };
}

// =============================================================================
// Per view, before any score is read: the regions in the frame, where the tile ends, where the target stands
// =============================================================================

/**
 * A region the judge scores must hold at least this share of the frame in the reference's masks. Below it the region is not in
 * the view: the judge is not asked about it, its score is null and no mean or bar reads it.
 */
export const PHOTO_MATCH_REGION_MIN_SHARE = 0.01;

/** The region criteria a view can be judged on: those whose region holds at least `minShare` of the frame. */
export function regionsInFrame(pixels: RegionMasks['pixels'], total: number, minShare = PHOTO_MATCH_REGION_MIN_SHARE): JudgeRegionCriterion[] {
    return JUDGE_REGION_CRITERIA.filter(c => pixels[c] / Math.max(1, total) >= minShare);
}

/** The tile's surfaces on a plan grid (StreetViewSurveyPlanner's GroundModel is one): the highest per cell, NaN where it has none. */
export interface TileTopGrid { x0: number; z0: number; nx: number; nz: number; cellMeters: number; top: ArrayLike<number> }

/** How far round the point where a ray leaves the tile its surfaces are read (m): the place goes on past the edge about as tall. */
export const PHOTO_MATCH_TILE_EDGE_REACH_M = 20;
/** A view whose frame holds at least this share of sky pixels past the tile's edge is flagged (its regions are not judged). */
export const PHOTO_MATCH_TILE_EDGE_MIN_SHARE = 0.01;

export interface TileEdgeReading {
    /** Share of the frame labelled sky whose ray leaves the tile lower than its surfaces stand round the point it leaves. */
    share: number;
    flagged: boolean;
    /** Pixels sampled (every `stride`-th, rows and columns), and how many of them lie past the edge. */
    samples: number; pastEdge: number;
}

const nearTopCache = new WeakMap<object, { reach: number; near: Float32Array; max: number }>();

/** Per cell, the highest surface within `reachM` (a square window), -Infinity where none; and the highest of all. */
function nearTop(grid: TileTopGrid, reachM: number): { near: Float32Array; max: number } {
    const hit = nearTopCache.get(grid.top as object);
    if (hit && hit.reach === reachM) return hit;
    const { nx, nz, top } = grid, r = Math.max(1, Math.ceil(reachM / grid.cellMeters));
    const rows = new Float32Array(nx * nz), near = new Float32Array(nx * nz);
    let max = -Infinity;
    for (let k = 0; k < nz; k++) for (let j = 0; j < nx; j++) {
        let m = -Infinity;
        for (let jj = Math.max(0, j - r); jj <= Math.min(nx - 1, j + r); jj++) { const v = top[k * nx + jj]; if (v > m) m = v; }
        rows[k * nx + j] = m;
        const v = top[k * nx + j];
        if (v > max) max = v;
    }
    for (let k = 0; k < nz; k++) for (let j = 0; j < nx; j++) {
        let m = -Infinity;
        for (let kk = Math.max(0, k - r); kk <= Math.min(nz - 1, k + r); kk++) { const v = rows[kk * nx + j]; if (v > m) m = v; }
        near[k * nx + j] = m;
    }
    const out = { reach: reachM, near, max };
    nearTopCache.set(grid.top as object, out);
    return out;
}

/**
 * Where the reference tile ends inside the frame, from geometry alone: of the pixels the reference labels sky (no surface hit),
 * those whose ray leaves the tile (its last cell with a surface, else the eye when it never crosses one) lower than the tile's
 * highest surface within PHOTO_MATCH_TILE_EDGE_REACH_M of that point. The photo shows whatever stands past that edge there,
 * the masks show sky. A ray that climbs above the tile's highest surface before it leaves is the sky. Read before any score.
 */
export function tileEdgeInFrame(labels: Uint8Array, camera: PinholeCamera, grid: TileTopGrid, options: { stride?: number; reachM?: number; minShare?: number } = {}): TileEdgeReading {
    const stride = options.stride ?? 4, minShare = options.minShare ?? PHOTO_MATCH_TILE_EDGE_MIN_SHARE;
    const { near, max } = nearTop(grid, options.reachM ?? PHOTO_MATCH_TILE_EDGE_REACH_M);
    const { x0, z0, nx, nz, cellMeters: cell, top } = grid;
    const xEnd = x0 + nx * cell, zEnd = z0 + nz * cell;
    const [ex, ey, ez] = camera.eye;
    const cellAt = (x: number, z: number) => {
        const j = Math.floor((x - x0) / cell), k = Math.floor((z - z0) / cell);
        return j < 0 || k < 0 || j >= nx || k >= nz ? -1 : k * nx + j;
    };
    // past the farthest corner of the grid no ray meets a cell
    const tMax = Math.max(...[[x0, z0], [xEnd, z0], [x0, zEnd], [xEnd, zEnd]].map(([x, z]) => Math.hypot(x - ex, z - ez))) + cell;
    let samples = 0, pastEdge = 0;
    for (let py = Math.floor(stride / 2); py < camera.height; py += stride) for (let px = Math.floor(stride / 2); px < camera.width; px += stride) {
        samples++;
        if (labels[py * camera.width + px] !== REGION.sky) continue;
        const xc = (px + 0.5 - camera.cx) / camera.fx, yc = -(py + 0.5 - camera.cy) / camera.fy;
        const d = [0, 1, 2].map(i => camera.right[i] * xc + camera.up[i] * yc + camera.fwd[i]);
        const h = Math.hypot(d[0], d[2]);
        if (h < 1e-9) { if (d[1] < 0) pastEdge++; continue; }
        const ux = d[0] / h, uz = d[2] / h, slope = d[1] / h;
        // march in plan, a cell at a time, until the ray leaves the grid (it cannot come back) or climbs past every surface
        let last = -1, sky = false, inside = false;
        for (let t = 0; t <= tMax; t += cell) {
            if (slope >= 0 && ey + slope * t > max) { sky = true; break; }
            const c = cellAt(ex + ux * t, ez + uz * t);
            if (c < 0) { if (inside) break; continue; }
            inside = true;
            if (top[c] === top[c]) last = t;
        }
        if (sky) continue;
        const te = Math.max(0, last), c = cellAt(ex + ux * te, ez + uz * te);
        const standing = c >= 0 && near[c] > -Infinity ? near[c] : max;
        if (ey + slope * te < standing) pastEdge++;
    }
    const share = samples ? pastEdge / samples : 0;
    return { share: Math.round(share * 1000) / 1000, flagged: share >= minShare, samples, pastEdge };
}

/** Shifts up to this (px at the metric width) are tried when placing a build's target on the photo's silhouette. */
export const PHOTO_MATCH_PLACEMENT_SEARCH_PX = 40;
/** Distances from the photo's silhouette to a build's outline count up to this (px at the metric width). */
export const PHOTO_MATCH_PLACEMENT_TRUNCATION_PX = 24;
/**
 * The photo's silhouette of the target: its structural edges within this (px at the metric width) of the reference's target
 * outline (the scan, registered on the photo to an edge residual of at most 5 px).
 */
export const PHOTO_MATCH_PLACEMENT_BAND_PX = 8;
/** Added to the cost per pixel of shift, so a direction the silhouette leaves free (a long straight edge) resolves to no shift. */
const PLACEMENT_SHIFT_COST = 0.02;
/** Least silhouette and outline pixels a placement is read from. */
const PLACEMENT_MIN_PX = 60;

/** The photo's structural edges at the metric width (texture-fit-metric's: straight segments of at least 22 px). */
export interface PhotoEdgeField { w: number; h: number; edges: Uint8Array; edgePx: number }

export function photoEdgeField(photo: DecodedImage): PhotoEdgeField {
    const w = Math.min(photo.width, PHOTO_MATCH_METRIC_WIDTH_PX), h = Math.max(1, Math.round((photo.height * w) / photo.width));
    const edges = structuralEdges(reducedLuminance(photo, w, h), w, h, new Uint8Array(w * h).fill(1));
    let edgePx = 0;
    for (let i = 0; i < edges.length; i++) edgePx += edges[i];
    return { w, h, edges, edgePx };
}

export interface TargetPlacement {
    /**
     * The placement error: the mean distance (px at the metric width, truncated at PHOTO_MATCH_PLACEMENT_TRUNCATION_PX) from the
     * photo's silhouette of the target to the build's outline as drawn. Lower is better; it grows with a move and with a wrong shape.
     */
    errorPx: number;
    /** errorPx as an angle (degrees across the frame). */
    errorDeg: number;
    /** The image shift (px, x right, y down) that brings the build's outline closest to the silhouette, its length, and the error left at it. */
    shiftPx: [number, number]; shiftLengthPx: number; residualPx: number;
    /** The photo's silhouette pixels read, and the build's outline pixels. */
    silhouettePx: number; outlinePx: number;
}

/**
 * The target's outline in a label image at the metric width (REGION per pixel): target pixels with a 4-neighbour that is not
 * the target, at least 2 px from the frame's edge (where the frame, not the target, ends the region).
 */
export function targetOutline(labels: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h);
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        if (labels[i] !== REGION.target) continue;
        if (labels[i - 1] !== REGION.target || labels[i + 1] !== REGION.target || labels[i - w] !== REGION.target || labels[i + w] !== REGION.target) out[i] = 1;
    }
    return out;
}

/**
 * The target with its holes filled (REGION per pixel): every pixel that is not the target and that the frame's border cannot
 * reach (through 4-neighbours) without crossing the target becomes the target, so the target's only outline is its outer
 * boundary. A hole in the scan, a courtyard or an arch's opening seen through is not a silhouette.
 */
export function targetFilled(labels: Uint8Array, w: number, h: number): Uint8Array {
    const T = REGION.target, out = Uint8Array.from(labels), reached = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let top = 0;
    const push = (i: number) => { if (!reached[i] && labels[i] !== T) { reached[i] = 1; stack[top++] = i; } };
    for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (top) {
        const i = stack[--top], x = i % w;
        if (x > 0) push(i - 1);
        if (x < w - 1) push(i + 1);
        if (i >= w) push(i - w);
        if (i < (h - 1) * w) push(i + w);
    }
    for (let i = 0; i < out.length; i++) if (out[i] !== T && !reached[i]) out[i] = T;
    return out;
}

/**
 * Where a build's target is drawn against where the photo shows it, from edges alone (never a vision score). The photo's
 * silhouette of the target is its structural edges within PHOTO_MATCH_PLACEMENT_BAND_PX of the reference's target outline
 * (`reference`: the scan's target drawn alone from the registered pose, at the metric width, labelled as the raw scan arm is;
 * the evaluator restricts it to the building's footprint and draws it, and every arm, behind the reference's street).
 * The placement error is the mean distance from that silhouette to the build's outline (`arm`: the build drawn alone from the
 * same pose), truncated at PHOTO_MATCH_PLACEMENT_TRUNCATION_PX. Both outlines are outer boundaries (targetFilled): a hole's
 * border is never read, in the scan or in a build, so a build that fills the scan's hole loses nothing by it. Beside it, the
 * image shift within PHOTO_MATCH_PLACEMENT_SEARCH_PX that brings the outline closest (plus PLACEMENT_SHIFT_COST per pixel of
 * shift), searched every 2 px, then to the pixel, and the error left there: a move shows as a shift, a wrong shape as error no
 * shift removes. The photo's other edges (windows, signs, the street) are never read, so a facade's repeats cannot pull it.
 * Null with too few silhouette or outline pixels.
 */
export function targetPlacement(field: PhotoEdgeField, reference: Uint8Array, arm: Uint8Array, degPerPx: number): TargetPlacement | null {
    const { w, h, edges } = field;
    const nearRef = distanceTransform(targetOutline(targetFilled(reference, w, h), w, h), w, h, PHOTO_MATCH_PLACEMENT_BAND_PX + 1);
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < edges.length; i++) if (edges[i] && nearRef[i] <= PHOTO_MATCH_PLACEMENT_BAND_PX) { xs.push(i % w); ys.push((i - (i % w)) / w); }
    const n = xs.length;
    const outline = targetOutline(targetFilled(arm, w, h), w, h);
    let outlinePx = 0;
    for (let i = 0; i < outline.length; i++) outlinePx += outline[i];
    if (n < PLACEMENT_MIN_PX || outlinePx < PLACEMENT_MIN_PX) return null;
    const T = PHOTO_MATCH_PLACEMENT_TRUNCATION_PX;
    const dt = distanceTransform(outline, w, h, T + 1);
    // the build moved by (dx, dy): its outline's distance from each silhouette pixel is the distance at the pixel moved back
    const cost = (dx: number, dy: number) => {
        let s = 0, k = 0;
        for (let p = 0; p < n; p++) {
            const x = xs[p] - dx, y = ys[p] - dy;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            s += Math.min(T, dt[y * w + x]); k++;
        }
        return k >= 0.6 * n ? s / k : Infinity;
    };
    const S = PHOTO_MATCH_PLACEMENT_SEARCH_PX;
    const c0 = cost(0, 0);
    let best = { dx: 0, dy: 0, c: c0, j: c0 };
    const consider = (dx: number, dy: number) => {
        const c = cost(dx, dy), j = c + PLACEMENT_SHIFT_COST * Math.hypot(dx, dy);
        if (j < best.j) best = { dx, dy, c, j };
    };
    for (let dy = -S; dy <= S; dy += 2) for (let dx = -S; dx <= S; dx += 2) consider(dx, dy);
    const cx = best.dx, cy = best.dy;
    for (let dy = cy - 2; dy <= cy + 2; dy++) for (let dx = cx - 2; dx <= cx + 2; dx++) if (Math.abs(dx) <= S && Math.abs(dy) <= S) consider(dx, dy);
    if (!Number.isFinite(c0)) return null;
    return {
        errorPx: Math.round(c0 * 100) / 100, errorDeg: Math.round(c0 * degPerPx * 1000) / 1000,
        shiftPx: [best.dx, best.dy], shiftLengthPx: Math.round(Math.hypot(best.dx, best.dy) * 100) / 100, residualPx: Math.round(best.c * 100) / 100,
        silhouettePx: n, outlinePx
    };
}

// =============================================================================
// Blind judging
// =============================================================================

/**
 * The judge's criteria. The first five are required in every reply; `realism` (does the render look like a real
 * photograph) and `identity` (would someone who knows the place recognise it) were added later and are read when present,
 * so older replies and callers that read only the first five still work.
 */
export const JUDGE_CRITERIA = ['shape', 'materials', 'detail', 'errors', 'overall', 'realism', 'identity'] as const;
export const JUDGE_REQUIRED_CRITERIA = ['shape', 'materials', 'detail', 'errors', 'overall'] as const;
export type JudgeCriterion = typeof JUDGE_CRITERIA[number];
/**
 * The place around the building, scored only when a judgement asks for it (`regions`): the ground, the neighbours and the
 * skyline. The renders stay shuffled and unlabelled; the building's criteria above are asked the same way either way.
 */
export const JUDGE_REGION_CRITERIA = ['ground', 'neighbours', 'skyline'] as const;
export type JudgeRegionCriterion = typeof JUDGE_REGION_CRITERIA[number];
export type JudgeScores = Record<typeof JUDGE_REQUIRED_CRITERIA[number], number> & Partial<Record<'realism' | 'identity' | JudgeRegionCriterion, number>>;

/** The part of a vision chain the judge calls (VisionModelChain.generate). */
export interface JudgeClient {
    generate(params: { contents: Array<{ role: string; parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> }>; config?: Record<string, unknown> },
        opts: { stage: string; thinkingBudget?: number }): Promise<{ response: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> }; finishReason?: string }> }; model: string; remember?: () => void }>;
}

export interface JudgeRun<S = JudgeScores> { order: string[]; scores: Record<string, S>; notes: Record<string, string>; model: string }

/** The clay judge's one criterion: shape (geometry only: the renders carry no texture). */
export const CLAY_JUDGE_CRITERIA = ['shape'] as const;
export type ClayJudgeScores = { shape: number };

/** Deterministic shuffle (mulberry32 seeded by a string). */
export function seededShuffle<T>(items: T[], seed: string): T[] {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) { h = Math.imul(h ^ seed.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let s = h >>> 0;
    const rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const a = items.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
}

/** The place-around-the-building criteria a judgement asks: every one (`true`), the ones listed, or none. */
function askedRegions(regions: boolean | readonly JudgeRegionCriterion[] | undefined): JudgeRegionCriterion[] {
    return regions === true ? [...JUDGE_REGION_CRITERIA] : Array.isArray(regions) ? JUDGE_REGION_CRITERIA.filter(c => regions.includes(c)) : [];
}

const REGION_NAMES: Record<JudgeRegionCriterion, string> = { ground: 'the ground', neighbours: 'the neighbouring buildings', skyline: 'the skyline' };
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * The textured judgement's prompt. With `regions` (true, or the region criteria in the frame) the same seven building criteria
 * come first, worded as before, and the region criteria asked score the place around the building (JUDGE_REGION_CRITERIA); a
 * region the view does not show is not asked. Without it the prompt is the one older reports used.
 */
export function judgePrompt(place: string, count: number, options: { regions?: boolean | readonly JudgeRegionCriterion[] } = {}): { preamble: string; closing: string } {
    const regions = options.regions === true || Array.isArray(options.regions);
    const asked = askedRegions(options.regions);
    const listed = asked.map(c => REGION_NAMES[c]);
    const more = asked.length
        ? `${COUNT_WORDS[asked.length][0].toUpperCase()}${COUNT_WORDS[asked.length].slice(1)} more judge${asked.length === 1 ? 's' : ''} the place around it: ${listed.length > 1 ? `${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}` : listed[0]}. `
        : '';
    return {
        preamble: `You are judging how closely 3D reconstructions match a real place. Image 0 is a real photograph (Google Street View) of ${place}. ` +
            `Images 1 to ${count} are renders of ${count} different 3D reconstructions of that building, each rendered from exactly the camera position, direction, field of view and resolution of the photograph, ` +
            (regions
                ? 'all with the same flat neutral light on the same flat grey background, which stands where the sky is. Seven criteria judge only the target building the renders show: for them ignore the sky, trees, vehicles, people, street furniture and the neighbouring buildings. ' +
                more
                : 'all with the same flat neutral light on the same flat grey background. Judge only the target building the renders show: ignore the sky, trees, vehicles, people, street furniture and any neighbouring buildings the renders leave out, ') +
            `${regions ? 'Do' : 'and do'} not reward or penalise a render for the absence of sun and shadows (no render has them). The renders are in no particular order and come from different methods.`,
        closing: `Score every render 1-10 (10 best) against the photograph on ${COUNT_WORDS[7 + asked.length]} criteria:\n` +
            '- shape: shape and silhouette match (massing, roofline, setbacks, openings in the right places);\n' +
            '- materials: materials and colour match (the facade materials and their colours as the photograph shows them);\n' +
            '- detail: detail believability (windows, cornices, ornament, storefronts read as the real ones, at a believable sharpness);\n' +
            '- errors: wrong or invented content, 10 = none (melted or broken geometry, smeared or doubled textures, things painted where they are not, content that is not in the photograph);\n' +
            '- overall: how much the render looks like this place in the photograph;\n' +
            '- realism: does the render look like a real photograph of a real building (convincing materials, sharpness and surface detail), whatever place it shows;\n' +
            `- identity: would someone who knows this place recognise it in the render (massing, window rhythm, materials, colour, distinctive features such as towers, fire escapes, signage, the storefront layout), whether or not the finer detail is exact${asked.length ? ';' : '.'}\n` +
            asked.map((c, k) => `${REGION_CRITERION_LINES[c]}${k + 1 < asked.length ? ';' : '.'}\n`).join('') +
            `Use the whole scale and compare the renders with each other. Reply with JSON only: {"renders":[{"image":1,"shape":n,"materials":n,"detail":n,"errors":n,"overall":n,"realism":n,"identity":n,${asked.map(c => `"${c}":n,`).join('')}"note":"at most 20 words on what decides it"}, ...]} with one entry for each of images 1 to ${count}.`
    };
}

/** Each region criterion as the judge is asked it (the line's end is added where it stands in the list). */
const REGION_CRITERION_LINES: Record<JudgeRegionCriterion, string> = {
    ground: '- ground: the ground around the building against the photograph (streets, pavements, kerbs, plazas, lawns and terrain: their layout, levels, materials and colour), 10 = it matches; holes, steps, smears and missing or invented surfaces cost',
    neighbours: '- neighbours: the other buildings and structures around the target against the photograph (massing, heights, rooflines, facade materials and rhythm), 10 = they match; missing, melted or invented neighbours cost',
    skyline: '- skyline: the outline where buildings and trees meet the sky (flat grey in every render) against the photograph\'s outline, 10 = the same outline'
};

/** The clay judgement's prompt: the same pose and blind protocol, every render in untextured clay, shape only. */
export function clayJudgePrompt(place: string, count: number): { preamble: string; closing: string } {
    return {
        preamble: `You are judging how closely the 3D geometry of reconstructions matches a real place. Image 0 is a real photograph (Google Street View) of ${place}. ` +
            `Images 1 to ${count} are renders of ${count} different 3D reconstructions of that building, each rendered from exactly the camera position, direction, field of view and resolution of the photograph, ` +
            'all in the same uniform untextured grey clay (no colour, no texture, no materials) under the same light, with the surrounding street in a lighter clay. ' +
            'Judge only the shape of the target building: ignore colour, materials and texture (no render has any), the sky, trees, vehicles, people, street furniture and the neighbouring buildings. ' +
            'The renders are in no particular order and come from different methods.',
        closing: 'Score every render 1-10 (10 best) against the photograph on one criterion:\n' +
            '- shape: how well the geometry matches the building in the photograph: massing and silhouette, roofline and setbacks, storeys and openings in the right places and sizes, ' +
            'and the surface relief the photograph shows (cornices, string courses, piers, window reveals, projections), with nothing melted, broken or invented.\n' +
            `Use the whole scale and compare the renders with each other. Reply with JSON only: {"renders":[{"image":1,"shape":n,"note":"at most 20 words on what decides it"}, ...]} with one entry for each of images 1 to ${count}.`
    };
}

/** A textured judgement's reply; with `regions` the region criteria asked are required too (a reply without them is retried). */
export function parseJudgeReply(text: string, count: number, options: { regions?: boolean | readonly JudgeRegionCriterion[] } = {}): { scores: Array<JudgeScores & { note: string }>; problems: string[] } {
    const asked = askedRegions(options.regions);
    return parseScores<JudgeScores>(text, count, [...JUDGE_CRITERIA, ...asked], [...JUDGE_REQUIRED_CRITERIA, ...asked]);
}

/** A clay judgement's reply: `shape` in 1-10 for every image. */
export function parseClayJudgeReply(text: string, count: number): { scores: Array<ClayJudgeScores & { note: string }>; problems: string[] } {
    return parseScores<ClayJudgeScores>(text, count, CLAY_JUDGE_CRITERIA, CLAY_JUDGE_CRITERIA);
}

function parseScores<S>(text: string, count: number, criteria: readonly string[], required: readonly string[]): { scores: Array<S & { note: string }>; problems: string[] } {
    const problems: string[] = [];
    let j: { renders?: Array<Record<string, unknown>> };
    try {
        const s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
        j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    } catch {
        return { scores: [], problems: ['the reply is not JSON'] };
    }
    const out: Array<S & { note: string }> = [];
    for (let k = 1; k <= count; k++) {
        const r = j.renders?.find(x => Number(x.image) === k);
        if (!r) { problems.push(`no entry for image ${k}`); continue; }
        const sc = {} as Record<string, number>;
        let ok = true;
        for (const c of criteria) {
            if (!required.includes(c) && r[c] === undefined) continue;
            const v = Number(r[c]);
            if (!Number.isFinite(v) || v < 1 || v > 10) { ok = false; problems.push(`image ${k}: ${c} is ${String(r[c])}`); break; }
            sc[c] = v;
        }
        if (ok) out[k - 1] = { ...(sc as S), note: typeof r.note === 'string' ? r.note : '' };
    }
    return { scores: out, problems };
}

const jpegOrPngB64 = (img: { bytes: Uint8Array; mimeType: string }) => ({ inlineData: { mimeType: img.mimeType, data: Buffer.from(img.bytes).toString('base64') } });

/**
 * One blind judgement of a view, `repeats` times: the photo, then the arm renders in an order shuffled per repeat (seeded by
 * `seed` and the repeat), unlabelled. Returns the scores mapped back to the arm ids. A reply that does not parse is retried once.
 */
export async function judgeView(input: JudgeViewInput): Promise<JudgeRun[]> {
    const regions = input.regions === true || Array.isArray(input.regions) ? input.regions : false;
    return judgeRepeats<JudgeScores>(input, (place, count) => judgePrompt(place, count, { regions }), (text, count) => parseJudgeReply(text, count, { regions }), 'photo-match-judge');
}

/**
 * The clay judgement of a view: the arms' clay renders (renderTriangles with `clay`), the same blind protocol (shuffled per
 * repeat, unlabelled, a reply that does not parse retried once), shape only.
 */
export async function judgeViewClay(input: JudgeViewInput): Promise<Array<JudgeRun<ClayJudgeScores>>> {
    return judgeRepeats<ClayJudgeScores>(input, clayJudgePrompt, parseClayJudgeReply, 'photo-match-judge-clay');
}

export interface JudgeViewInput {
    client: JudgeClient; place: string; photo: { bytes: Uint8Array; mimeType: string };
    renders: Array<{ armId: string; png: Uint8Array }>; repeats?: number; seed: string; thinkingBudget?: number; temperature?: number;
    /**
     * judgeView: also score the place around the building: every region criterion (true), or only those listed (the regions
     * the view shows; none listed asks the building criteria in the same words). Ignored by judgeViewClay.
     */
    regions?: boolean | readonly JudgeRegionCriterion[];
}

async function judgeRepeats<S>(
    input: JudgeViewInput, prompt: (place: string, count: number) => { preamble: string; closing: string },
    parse: (text: string, count: number) => { scores: Array<S & { note: string }>; problems: string[] }, stage: string
): Promise<Array<JudgeRun<S>>> {
    const runs: Array<JudgeRun<S>> = [];
    const repeats = input.repeats ?? 3;
    for (let r = 0; r < repeats; r++) {
        const order = seededShuffle(input.renders, `${input.seed}#${r}`);
        const { preamble, closing } = prompt(input.place, order.length);
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: preamble }, { text: 'Image 0: the real photograph.' }, jpegOrPngB64(input.photo)];
        order.forEach((o, k) => { parts.push({ text: `Image ${k + 1}: a render.` }, jpegOrPngB64({ bytes: o.png, mimeType: 'image/png' })); });
        parts.push({ text: closing });
        let parsed: ReturnType<typeof parse> | undefined;
        let model = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await input.client.generate({
                contents: [{ role: 'user', parts: attempt ? [...parts, { text: `(Attempt ${attempt + 1}: reply with the JSON object only.)` }] : parts }],
                config: { responseMimeType: 'application/json', temperature: input.temperature ?? 1 }
            }, { stage, thinkingBudget: input.thinkingBudget ?? 24_576 });
            model = res.model;
            const text = (res.response.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('');
            parsed = parse(text, order.length);
            if (!parsed.problems.length) { res.remember?.(); break; }
        }
        if (!parsed || parsed.problems.length) throw new Error(`photo-match judge: the reply could not be read (${parsed?.problems.slice(0, 3).join('; ')})`);
        const scores: Record<string, S> = {}, notes: Record<string, string> = {};
        order.forEach((o, k) => { const { note, ...sc } = parsed!.scores[k]; scores[o.armId] = sc as unknown as S; notes[o.armId] = note; });
        runs.push({ order: order.map(o => o.armId), scores, notes, model });
    }
    return runs;
}

export interface CriterionStat { mean: number; sd: number; min: number; max: number }

/** Mean, standard deviation (population) and range of each arm's scores over the runs. */
export function aggregateRuns(runs: Array<JudgeRun<Partial<Record<JudgeCriterion, number>>>>, armIds: string[]): Record<string, Record<JudgeCriterion, CriterionStat>> {
    return aggregateCriteria(runs, armIds, JUDGE_CRITERIA);
}

/** aggregateRuns over the given criteria (e.g. JUDGE_REGION_CRITERIA). */
export function aggregateCriteria<C extends string>(runs: Array<JudgeRun<Partial<Record<C, number>>>>, armIds: string[], criteria: readonly C[]): Record<string, Record<C, CriterionStat>> {
    const out: Record<string, Record<C, CriterionStat>> = {};
    for (const a of armIds) {
        out[a] = {} as Record<C, CriterionStat>;
        for (const c of criteria) {
            const v = runs.map(r => r.scores[a]?.[c]).filter((x): x is number => typeof x === 'number');
            const mean = v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
            const sd = v.length ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length) : NaN;
            out[a][c] = { mean: Math.round(mean * 100) / 100, sd: Math.round(sd * 100) / 100, min: v.length ? Math.min(...v) : NaN, max: v.length ? Math.max(...v) : NaN };
        }
    }
    return out;
}

// =============================================================================
// Grids
// =============================================================================

/** 5 x 7 bitmap glyphs (rows top to bottom, 5 bits each, MSB left) for the labels. */
const GLYPHS: Record<string, number[]> = {
    'A': [14, 17, 17, 31, 17, 17, 17], 'B': [30, 17, 17, 30, 17, 17, 30], 'C': [14, 17, 16, 16, 16, 17, 14], 'D': [30, 17, 17, 17, 17, 17, 30],
    'E': [31, 16, 16, 30, 16, 16, 31], 'F': [31, 16, 16, 30, 16, 16, 16], 'G': [14, 17, 16, 23, 17, 17, 15], 'H': [17, 17, 17, 31, 17, 17, 17],
    'I': [14, 4, 4, 4, 4, 4, 14], 'J': [7, 2, 2, 2, 2, 18, 12], 'K': [17, 18, 20, 24, 20, 18, 17], 'L': [16, 16, 16, 16, 16, 16, 31],
    'M': [17, 27, 21, 21, 17, 17, 17], 'N': [17, 17, 25, 21, 19, 17, 17], 'O': [14, 17, 17, 17, 17, 17, 14], 'P': [30, 17, 17, 30, 16, 16, 16],
    'Q': [14, 17, 17, 17, 21, 18, 13], 'R': [30, 17, 17, 30, 20, 18, 17], 'S': [15, 16, 16, 14, 1, 1, 30], 'T': [31, 4, 4, 4, 4, 4, 4],
    'U': [17, 17, 17, 17, 17, 17, 14], 'V': [17, 17, 17, 17, 17, 10, 4], 'W': [17, 17, 17, 21, 21, 21, 10], 'X': [17, 17, 10, 4, 10, 17, 17],
    'Y': [17, 17, 10, 4, 4, 4, 4], 'Z': [31, 1, 2, 4, 8, 16, 31],
    '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31], '3': [31, 2, 4, 2, 1, 17, 14],
    '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14], '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8],
    '8': [14, 17, 17, 14, 17, 17, 14], '9': [14, 17, 17, 15, 1, 2, 12],
    ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0], '-': [0, 0, 0, 31, 0, 0, 0],
    '+': [0, 4, 4, 31, 4, 4, 0], '/': [1, 1, 2, 4, 8, 16, 16], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8], '=': [0, 0, 31, 0, 31, 0, 0],
    '%': [24, 25, 2, 4, 8, 19, 3], '\'': [4, 4, 8, 0, 0, 0, 0], '#': [10, 10, 31, 10, 31, 10, 10]
};

/** Draws `text` (upper-cased; unknown characters as spaces) into an RGB buffer at (x, y), `scale` px per glyph pixel. */
export function drawText(rgb: Uint8Array, W: number, H: number, x: number, y: number, text: string, scale: number, colour: Vec3): void {
    let cx = x;
    for (const ch of text.toUpperCase()) {
        const g = GLYPHS[ch] ?? GLYPHS[' '];
        for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
            if (!((g[r] >> (4 - c)) & 1)) continue;
            for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
                const px = cx + c * scale + dx, py = y + r * scale + dy;
                if (px < 0 || py < 0 || px >= W || py >= H) continue;
                const o = (py * W + px) * 3;
                rgb[o] = colour[0]; rgb[o + 1] = colour[1]; rgb[o + 2] = colour[2];
            }
        }
        cx += 6 * scale;
    }
}

/**
 * The grid of one view: the photo, then each arm render, side by side at `tileWidth`, each with its label (and an optional
 * second line, e.g. the judge's mean overall score) above it. Wraps after `columns` tiles. PNG bytes.
 */
export function composeGrid(tiles: Array<{ image: { width: number; height: number; rgba: Uint8Array }; label: string; sublabel?: string }>, options: { tileWidth?: number; columns?: number; title?: string } = {}): Buffer {
    const tw = options.tileWidth ?? 480;
    const first = tiles[0].image;
    const th = Math.round((first.height * tw) / first.width);
    const cols = Math.min(tiles.length, options.columns ?? tiles.length);
    const rows = Math.ceil(tiles.length / cols);
    const scale = Math.max(2, Math.round(tw / 240));
    const labelH = 2 * (7 * scale + 6) + 4, titleH = options.title ? 7 * scale + 12 : 0, gap = 6;
    const W = cols * tw + (cols + 1) * gap, H = titleH + rows * (th + labelH) + (rows + 1) * gap;
    const rgb = new Uint8Array(W * H * 3).fill(24);
    if (options.title) drawText(rgb, W, H, gap, 6, options.title, scale, [255, 255, 255]);
    tiles.forEach((t, k) => {
        const c = k % cols, r = Math.floor(k / cols);
        const x0 = gap + c * (tw + gap), y0 = titleH + gap + r * (th + labelH + gap);
        drawText(rgb, W, H, x0 + 2, y0 + 3, t.label, scale, [255, 236, 160]);
        if (t.sublabel) drawText(rgb, W, H, x0 + 2, y0 + 3 + 7 * scale + 6, t.sublabel, scale, [200, 220, 255]);
        const px = resizeRgbaBox(t.image, tw, th);
        for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
            const o = ((y0 + labelH + y) * W + x0 + x) * 3, s = (y * tw + x) * 4;
            rgb[o] = px[s]; rgb[o + 1] = px[s + 1]; rgb[o + 2] = px[s + 2];
        }
    });
    return encodePng(W, H, rgb, 3);
}

/** A render as PNG bytes (what the judge is shown). */
export function renderPng(r: ArmRender): Buffer {
    return encodePng(r.width, r.height, r.rgba, 4);
}
