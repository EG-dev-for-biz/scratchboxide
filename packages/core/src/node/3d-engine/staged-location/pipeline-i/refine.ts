/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline I + H (prototype, SCRATCHBOX_PIPELINE_I_REFINE=1): pipeline I's kept Trellis model refined with pipeline H's
 * measured evidence.
 *   1. Pipeline I's pose (turn and handedness from the silhouette against the sheet) shifted on a 0.25 m grid onto the
 *      scan-led massing's walls, so the model's walls land on the walls H measures. The fit to the massing footprint alone
 *      is reported for comparison: on a near-rectangular footprint it can pick a half-turned pose (Puck, 2026-10-24).
 *   2. Pipeline G's survey stations are rendered twice: from the photo tile (the wall plates H reads) and from the fitted
 *      model, onto the same metric plates.
 *   3. Each facade is scored with the check's own edge machinery (check.ts photoEdges, distanceTo): the model plate's
 *      edges against the scan plate's within CHECK_TOL_M, on texels both saw, and how far the model's wall stands off the
 *      massing's plane (relief).
 *   4. Where a model wall lies on its plane (the gate below), the scan plate's colours are projected into the model's
 *      texture (UV space, texel by texel), labelled photo-inferred; the rest of the texture stays the model's own,
 *      generated. The projected model is surveyed and scored again.
 * Nothing is clipped or moved past the fit; every number is reported. Nothing here names a kind of building.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GeodeticAnchor } from '../../../../common/spatial/colmap-vector-reference-types';
import { HeadlessMeshSilhouetteRenderer } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import type { GroundModel } from '../../../spatial/StreetViewSurveyPlanner';
import { decodeImageToRgbaSync } from '../../../image-codec-ffmpeg';
import { encodePng } from '../../../texture-processing';
import type { StructurePickResult } from '../extraction-sizing';
import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from '../glb-bytes';
import type { MassingFace, MassingReport } from '../pipeline-e/native-massing';
import { readGlbScene, sceneToRenderMesh } from '../../../spatial/StreetViewPoseRegistrar';
import { CHECK_TOL_M, distanceTo, photoEdges } from '../pipeline-g/check';
import { groupFacades } from '../pipeline-g/facades';
import { PLATE_PIXEL_M, platePng, surveyPlates, type Plate } from '../pipeline-g/plates';
import { onFace, planStations, type V3 } from '../pipeline-g/stations';
import { applyRootTransform, registerToFootprint, stripMaterials, type FootprintTarget, type RegistrationFit } from './register';
import { colourMatchGlb, type Swatch } from './swatch';
import { infillModelTextureHoles, type ModelTextureInfillResult } from './texture-holes';
import { buildFacadeTextureFromImage } from '../facade-texture/facade-texture';
import type { PlateModelClient } from '../pipeline-e/enhance';
import type { FacadeCounter } from '../pipeline-e/plate-identity';
import type { EnhanceModelClient } from '../texture-enhance';

export const PIPELINE_I_REFINE_VERSION = 'pipeline-i-refine/1';
/** A model wall is projected onto when at least this share of its plate was seen by both surveys... */
export const PROJECT_MIN_OVERLAP = 0.25;
/** ...and the model's surface stands within this many metres of the massing's plane (median over those texels). */
export const PROJECT_MAX_RELIEF_M = 0.5;
/** A model texel takes the plate's colour when its point lies within this slab of the plane. */
export const PROJECT_SLAB_M = 0.75;
/** A model triangle's normal must lie this close to the face's normal axis (|cosine|, either winding). */
export const PROJECT_MIN_NORMAL_COS = 0.6;

/** Whether the prototype runs (off by default). */
export function pipelineIRefineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_PIPELINE_I_REFINE === '1';
}

type Loop = Array<[number, number]>;

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const median = (v: number[]) => { if (!v.length) return NaN; const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function inLoops(loops: Loop[], x: number, z: number): boolean {
    // even-odd over every loop of the part: holes subtract
    let inside = false;
    for (const loop of loops) for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const [xi, zi] = loop[i], [xj, zj] = loop[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
}

/** The massing's footprint as the fit's target: 1 m cells whose centres lie in a part, its height the tallest part's top over the ground. */
export function footprintFromParts(parts: MassingReport['parts'], groundY: number): FootprintTarget {
    const cells = new Set<string>();
    let top = -Infinity;
    for (const p of parts) {
        top = Math.max(top, p.topY);
        const pts = p.loops.flat();
        if (!pts.length) continue;
        const x0 = Math.floor(Math.min(...pts.map(q => q[0]))), x1 = Math.ceil(Math.max(...pts.map(q => q[0])));
        const z0 = Math.floor(Math.min(...pts.map(q => q[1]))), z1 = Math.ceil(Math.max(...pts.map(q => q[1])));
        for (let x = x0; x < x1; x++) for (let z = z0; z < z1; z++) if (inLoops(p.loops, x + 0.5, z + 0.5)) cells.add(`${x},${z}`);
    }
    if (!cells.size) throw new Error('the massing has no footprint to fit to');
    return { cells, groundY, heightM: top - groundY };
}

/** Points this far or more from every wall line count as interior (roof) and do not pull the shift. */
export const WALL_SNAP_CAP_M = 1.5;

/**
 * The fit moved by the shift (on a 0.25 m grid, within 1 m) that brings the model's raised plan points closest to the
 * massing's wall lines (mean distance, capped at WALL_SNAP_CAP_M): the 1 m fit leaves walls up to half a metre off the
 * massing's planes. Returns the shifted fit and the median distance of the near-wall points before and after, metres.
 */
export function fineShiftToParts(positions: ArrayLike<number>, fit: RegistrationFit, parts: MassingReport['parts']): { fit: RegistrationFit; shift: [number, number]; wallDistanceM: [number, number] } {
    const STEP = 0.25, m = fit.matrix;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < positions.length; i += 3) { minY = Math.min(minY, positions[i]); maxY = Math.max(maxY, positions[i]); }
    const raised = minY + 0.1 * (maxY - minY);
    const stride = Math.max(1, Math.floor(positions.length / 3 / 20000));
    const xs: number[] = [], zs: number[] = [];
    for (let i = 0; i < positions.length; i += 3 * stride) {
        if (positions[i + 1] <= raised) continue;
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        xs.push(m[0] * x + m[4] * y + m[8] * z + m[12]); zs.push(m[2] * x + m[6] * y + m[10] * z + m[14]);
    }
    const segs: Array<[number, number, number, number]> = [];
    for (const p of parts) for (const loop of p.loops) for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        segs.push([a[0], a[1], b[0], b[1]]);
    }
    const dist = (x: number, z: number) => {
        let best = WALL_SNAP_CAP_M;
        for (const [ax, az, bx, bz] of segs) {
            const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
            const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
            if (d < best) best = d;
        }
        return best;
    };
    const meanAt = (sx: number, sz: number) => { let a = 0; for (let i = 0; i < xs.length; i++) a += dist(xs[i] + sx, zs[i] + sz); return xs.length ? a / xs.length : WALL_SNAP_CAP_M; };
    const before = meanAt(0, 0);
    let best = { sx: 0, sz: 0, d: before };
    for (let sx = -1; sx <= 1.0001; sx += STEP) for (let sz = -1; sz <= 1.0001; sz += STEP) {
        const d = meanAt(sx, sz);
        if (d < best.d - 1e-9) best = { sx, sz, d };
    }
    // reported: the median distance of the points near a wall line (the roof's interior points say nothing about the walls)
    const nearWall = (sx: number, sz: number) => median(xs.map((x, i) => dist(x + sx, zs[i] + sz)).filter(d => d < WALL_SNAP_CAP_M));
    const matrix = [...m];
    matrix[12] += best.sx; matrix[14] += best.sz;
    return { fit: { ...fit, matrix }, shift: [best.sx, best.sz], wallDistanceM: [r3(nearWall(0, 0)), r3(nearWall(best.sx, best.sz))] };
}

export interface FacadeScore {
    face: number;
    key: string;
    widthM: number;
    heightM: number;
    /** Share of the plate the tile survey saw, the model survey saw, and both. */
    scanSeen: number;
    modelSeen: number;
    overlap: number;
    /** Median |offset| of the model's surface from the massing's plane over the texels both saw, metres (NaN: none). */
    modelReliefM: number;
    /** Median |model relief - scan relief| over those texels, metres. */
    reliefAgreementM: number;
    /** The model's edges against the photo's (check.ts machinery, CHECK_TOL_M), over the texels both saw. */
    precision: number;
    recall: number;
    f: number;
    /** The plate was projected onto the model. */
    projected?: boolean;
}


/** One facade's model plate scored against its scan plate (same face, same stations). */
export function compareFacade(scan: Plate, model: Plate): FacadeScore {
    const { w, h } = scan;
    if (model.w !== w || model.h !== h) throw new Error(`compareFacade: plates of ${scan.key} differ in size`);
    const n = w * h, both = new Uint8Array(n);
    let sSeen = 0, mSeen = 0, nb = 0;
    const off: number[] = [], agree: number[] = [];
    for (let i = 0; i < n; i++) {
        const s = !Number.isNaN(scan.relief[i]), m = !Number.isNaN(model.relief[i]);
        if (s) sSeen++;
        if (m) mSeen++;
        if (s && m) { both[i] = 1; nb++; off.push(Math.abs(model.relief[i])); agree.push(Math.abs(model.relief[i] - scan.relief[i])); }
    }
    const eS = photoEdges({ w, h, rgb: scan.rgb, seen: both }), eM = photoEdges({ w, h, rgb: model.rgb, seen: both });
    const dS = distanceTo(eS, w, h), dM = distanceTo(eM, w, h), tol = CHECK_TOL_M / PLATE_PIXEL_M + 1e-6;
    let np = 0, hp = 0, nr = 0, hr = 0;
    for (let i = 0; i < n; i++) {
        if (eM[i]) { np++; if (dS[i] <= tol) hp++; }
        if (eS[i]) { nr++; if (dM[i] <= tol) hr++; }
    }
    const precision = np ? hp / np : 0, recall = nr ? hr / nr : 0;
    return {
        face: scan.face, key: scan.key, widthM: r3(scan.widthM), heightM: r3(scan.heightM), scanSeen: r3(sSeen / n), modelSeen: r3(mSeen / n), overlap: r3(nb / n),
        modelReliefM: r3(median(off)), reliefAgreementM: r3(median(agree)),
        precision: r3(precision), recall: r3(recall), f: r3(precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0)
    };
}

/** Whether a facade's plate may be projected onto the model (its wall lies on the massing's plane). */
export function projectable(s: Pick<FacadeScore, 'overlap' | 'modelReliefM'>): boolean {
    return s.overlap >= PROJECT_MIN_OVERLAP && s.modelReliefM <= PROJECT_MAX_RELIEF_M;
}

/**
 * The scan plates' colours baked into the model's base-colour textures: every texel of every textured triangle whose point
 * lies within PROJECT_SLAB_M of a projected face's plane (normals agreeing), on a texel the tile survey saw, takes that
 * plate texel's colour. The GLB's node transforms are applied (the fitted model). Returns the GLB and the texels changed.
 */
export function projectPlatesOntoGlb(glb: Buffer, targets: Array<{ face: MassingFace; plate: Plate }>): { glb: Buffer; texels: number; perFace: Record<string, number> } {
    const parsed = parseGlbBytes(glb);
    const { json, bin } = parsed;
    const worlds = nodeWorldMatrices(json);
    const images = new Map<number, { width: number; height: number; rgba: Uint8Array; changed: number }>();
    const perFace: Record<string, number> = {};
    let texels = 0;
    const imageOf = (idx: number) => {
        let im = images.get(idx);
        if (!im) {
            const bv = json.bufferViews[json.images[idx].bufferView], off = bv.byteOffset ?? 0;
            const d = decodeImageToRgbaSync(Buffer.from(bin.buffer, bin.byteOffset + off, bv.byteLength));
            im = { width: d.width, height: d.height, rgba: Uint8Array.from(d.rgba), changed: 0 };
            images.set(idx, im);
        }
        return im;
    };
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined) return;
        const W = worlds[ni];
        for (const prim of json.meshes[node.mesh].primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.TEXCOORD_0 === undefined) continue;
            const tex = json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture;
            const src = tex !== undefined ? json.textures?.[tex.index]?.source : undefined;
            if (src === undefined || json.images?.[src]?.bufferView === undefined) continue;
            const im = imageOf(src);
            const pos = readAccessor(parsed, prim.attributes.POSITION).data, uv = readAccessor(parsed, prim.attributes.TEXCOORD_0).data;
            const idx = prim.indices !== undefined ? readAccessor(parsed, prim.indices).data : Float64Array.from({ length: pos.length / 3 }, (_, i) => i);
            const P = (k: number): V3 => transformPoint(W, pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]);
            for (let t = 0; t + 2 < idx.length; t += 3) {
                const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
                const a = P(ia), b = P(ib), c = P(ic);
                const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
                const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
                const nl = Math.hypot(nx, ny, nz);
                if (!(nl > 0)) continue;
                // either winding: a generated mesh's triangles may face inward, and the surface nearest the plane wins below
                const cand = targets.filter(x => Math.abs(nx * x.face.normal[0] + ny * x.face.normal[1] + nz * x.face.normal[2]) / nl >= PROJECT_MIN_NORMAL_COS);
                if (!cand.length) continue;
                const ua = uv[ia * 2] * im.width, va = uv[ia * 2 + 1] * im.height, ub = uv[ib * 2] * im.width, vb = uv[ib * 2 + 1] * im.height, uc = uv[ic * 2] * im.width, vc = uv[ic * 2 + 1] * im.height;
                const den = (vb - vc) * (ua - uc) + (uc - ub) * (va - vc);
                if (Math.abs(den) < 1e-12) continue;
                const x0 = Math.max(0, Math.floor(Math.min(ua, ub, uc))), x1 = Math.min(im.width - 1, Math.ceil(Math.max(ua, ub, uc)));
                const y0 = Math.max(0, Math.floor(Math.min(va, vb, vc))), y1 = Math.min(im.height - 1, Math.ceil(Math.max(va, vb, vc)));
                for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                    const px = x + 0.5, py = y + 0.5;
                    const l1 = ((vb - vc) * (px - uc) + (uc - ub) * (py - vc)) / den, l2 = ((vc - va) * (px - uc) + (ua - uc) * (py - vc)) / den, l3 = 1 - l1 - l2;
                    if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
                    const p: V3 = [l1 * a[0] + l2 * b[0] + l3 * c[0], l1 * a[1] + l2 * b[1] + l3 * c[1], l1 * a[2] + l2 * b[2] + l3 * c[2]];
                    let hit: { plate: Plate; key: string; j: number; off: number } | undefined;
                    for (const { face, plate } of cand) {
                        const at = onFace(face, p, PROJECT_SLAB_M, PROJECT_SLAB_M);
                        if (!at) continue;
                        const j = Math.min(plate.h - 1, Math.floor((face.tMax - at.t) / PLATE_PIXEL_M)) * plate.w + Math.min(plate.w - 1, Math.floor((at.s - face.sMin) / PLATE_PIXEL_M));
                        if (Number.isNaN(plate.relief[j])) continue;
                        if (!hit || Math.abs(at.off) < Math.abs(hit.off)) hit = { plate, key: face.key, j, off: at.off };
                    }
                    if (!hit) continue;
                    const o = (y * im.width + x) * 4;
                    im.rgba[o] = hit.plate.rgb[hit.j * 3]; im.rgba[o + 1] = hit.plate.rgb[hit.j * 3 + 1]; im.rgba[o + 2] = hit.plate.rgb[hit.j * 3 + 2];
                    im.changed++; texels++; perFace[hit.key] = (perFace[hit.key] ?? 0) + 1;
                }
            }
        }
    });
    let extra = Buffer.alloc(0);
    const base = bin.byteLength + ((4 - (bin.byteLength % 4)) % 4);
    for (const [idx, im] of images) {
        if (!im.changed) continue;
        const png = encodePng(im.width, im.height, Buffer.from(im.rgba));
        json.bufferViews.push({ buffer: 0, byteOffset: base + extra.length, byteLength: png.length });
        json.images[idx].bufferView = json.bufferViews.length - 1; json.images[idx].mimeType = 'image/png';
        extra = Buffer.concat([extra, png, Buffer.alloc((4 - (png.length % 4)) % 4)]);
    }
    const all = Buffer.concat([Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength), Buffer.alloc(base - bin.byteLength), extra]);
    json.buffers = [{ ...(json.buffers?.[0] ?? {}), byteLength: all.length }];
    return { glb: assembleGlb(json, all), texels, perFace };
}

export interface RefineInput {
    /** Pipeline I's kept model as Trellis returned it (not fitted, not colour-matched). */
    rawModelGlb: string;
    swatch: Swatch;
    /** Pipeline I's own fit to the scan cells, for the comparison. */
    scanFit: RegistrationFit;
    scanFootprint: FootprintTarget;
    /** Pipeline H's massing run: its parts (the fit target) and faces (the plates). */
    massing: Pick<MassingReport, 'faces' | 'parts'>;
    /** The photo tile the plates are rendered from. */
    tileGlb: string;
    structure: Pick<StructurePickResult, 'cells' | 'groundY' | 'centroid'>;
    ground: GroundModel;
    anchor: GeodeticAnchor;
    dir: string;
    /** Fills the model's own black texture holes (texture-holes.ts) before it is surveyed or projected onto; skipped without a client. */
    infill?: { client: EnhanceModelClient; models: string[] };
    /**
     * The facade texture builder (facade_texture_build's buildFacadeTextureFromImage): each projectable plate is redrawn by the
     * image model and kept only through the identity gate and the quality score, then projected in place of the raw plate (the
     * melted tile's shadows and blur stay out of the model). A plate the gate refuses is not projected. Absent: raw plates.
     */
    clean?: { client: PlateModelClient; models: string[]; locationName: string; infill?: { client: EnhanceModelClient; models: string[] }; unseenModels?: string[]; counter?: FacadeCounter; cacheDir?: string };
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
}

/** One projectable plate through the facade texture builder: accepted with its redraw, or refused with why. */
export interface PlateClean { key: string; accepted: boolean; why: string; model?: string; identity?: unknown }

/**
 * A survey plate redrawn by the facade texture builder. Accepted: the plate with the redraw's colours, every texel counting
 * as seen (the builder drew the unseen ones as the wall continues), so the projection covers the whole wall.
 */
export async function cleanPlate(pl: Plate, clean: NonNullable<RefineInput['clean']>, signal?: AbortSignal): Promise<{ plate?: Plate; record: PlateClean }> {
    const n = pl.w * pl.h, rgba = new Uint8Array(n * 4), unseen = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        rgba[i * 4] = pl.rgb[i * 3]; rgba[i * 4 + 1] = pl.rgb[i * 3 + 1]; rgba[i * 4 + 2] = pl.rgb[i * 3 + 2]; rgba[i * 4 + 3] = 255;
        if (Number.isNaN(pl.relief[i])) unseen[i] = 1;
    }
    const r = await buildFacadeTextureFromImage({
        image: { width: pl.w, height: pl.h, rgba }, widthM: pl.widthM, heightM: pl.heightM, unseenMask: unseen, locationName: clean.locationName,
        client: clean.client, models: clean.models, ...(clean.infill ? { infill: clean.infill } : {}), ...(clean.unseenModels ? { unseenModels: clean.unseenModels } : {}),
        ...(clean.counter ? { counter: clean.counter } : {}), ...(clean.cacheDir ? { cacheDir: clean.cacheDir } : {}), ...(signal ? { signal } : {})
    });
    const record: PlateClean = { key: pl.key, accepted: !!(r.accepted && r.texture), why: r.why, ...(r.model ? { model: r.model } : {}), ...(r.identity ? { identity: r.identity } : {}) };
    if (!record.accepted || !r.texture) return { record };
    const rgb = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { rgb[i * 3] = r.texture.rgba[i * 4]; rgb[i * 3 + 1] = r.texture.rgba[i * 4 + 1]; rgb[i * 3 + 2] = r.texture.rgba[i * 4 + 2]; }
    return { plate: { ...pl, rgb, relief: Float32Array.from(pl.relief, v => (Number.isNaN(v) ? 0 : v)), coverage: 1 }, record };
}

export interface RefineOutcome {
    files: { texturedGlb: string; clayGlb: string; unprojectedGlb: string; platesDir: string };
    fit: { massing: RegistrationFit; massingOnly: Pick<RegistrationFit, 'planIoU' | 'yawDeg' | 'mirrored'> & { scanIoU: number }; shift: [number, number]; wallDistanceM: [number, number]; scanIoUOfMassingFit: number; scanFit: Pick<RegistrationFit, 'planIoU' | 'coverage' | 'overflowShare'> };
    stations: number;
    facades: Array<FacadeScore & { after?: Pick<FacadeScore, 'precision' | 'recall' | 'f'> }>;
    projected: { texels: number; perFace: Record<string, number> };
    /** The model's own texture holes (texture-holes.ts), when `input.infill` was given. */
    holes?: ModelTextureInfillResult;
    /** The facade texture builder's verdict per projectable plate (with `clean`). */
    cleaned?: PlateClean[];
    timingsMs: Record<string, number>;
}

/** Plan-cell IoU of a fit's placed model against a footprint (the scan's), for comparing fits made to different targets. */
function iouAgainst(positions: ArrayLike<number>, fit: RegistrationFit, target: FootprintTarget): number {
    const m = fit.matrix;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < positions.length; i += 3) { minY = Math.min(minY, positions[i]); maxY = Math.max(maxY, positions[i]); }
    const cells = new Set<string>();
    for (let i = 0; i < positions.length; i += 3) {
        if (positions[i + 1] <= minY + 0.1 * (maxY - minY)) continue;
        const x = positions[i], y = positions[i + 1], z = positions[i + 2];
        cells.add(`${Math.floor(m[0] * x + m[4] * y + m[8] * z + m[12])},${Math.floor(m[2] * x + m[6] * y + m[10] * z + m[14])}`);
    }
    let inter = 0;
    for (const k of cells) if (target.cells.has(k)) inter++;
    return inter / (cells.size + target.cells.size - inter);
}

export async function refinePipelineI(input: RefineInput): Promise<RefineOutcome> {
    const timingsMs: Record<string, number> = {}, progress = (m: string) => input.onProgress?.(m);
    const platesDir = path.join(input.dir, 'plates');
    fs.mkdirSync(platesDir, { recursive: true });

    // 1. pipeline I's pose (its turn and handedness chosen with the silhouette against the sheet: a near-rectangular
    //    footprint alone fits a half-turned model almost as well, Puck 2026-10-24), shifted onto the massing's walls. The fit
    //    to the massing footprint alone is still made and reported, never used.
    let t = Date.now();
    progress('Pipeline I + H: shifting the model onto the scan-led massing walls');
    const positions = sceneToRenderMesh(readGlbScene(input.rawModelGlb)).vertices;
    const target = footprintFromParts(input.massing.parts, input.structure.groundY);
    const massingOnly = registerToFootprint(positions, target);
    const fine = fineShiftToParts(positions, input.scanFit, input.massing.parts);
    const raw = fs.readFileSync(input.rawModelGlb);
    const matched = colourMatchGlb(raw, input.swatch).glb;
    timingsMs.fit = Date.now() - t;

    // the model's own texture holes filled before anything is surveyed or projected from it: surfaces its four input
    // views never saw come back flat black from the model itself, which both looks like a tear in the finished build
    // and reads as a spurious sharp edge in the facade scoring below (photoEdges sees black-against-real as an edge)
    t = Date.now();
    let holes: ModelTextureInfillResult | undefined;
    let painted = matched;
    if (input.infill) {
        const filled = await infillModelTextureHoles(matched, { ...input.infill, ...(input.signal ? { signal: input.signal } : {}) });
        holes = filled.result;
        painted = filled.glb;
    }
    timingsMs.holes = Date.now() - t;

    t = Date.now();
    const fitted = applyRootTransform(painted, fine.fit.matrix, 'pipeline_i_refine_fit');
    const unprojectedGlb = path.join(input.dir, 'refine_unprojected.glb');
    fs.writeFileSync(unprojectedGlb, fitted);
    timingsMs.fit += Date.now() - t;

    // 2. pipeline G's stations, rendered from the tile and from the model onto the same plates
    t = Date.now();
    const grouping = groupFacades(input.massing.faces);
    const faces = grouping.surveyFaces;
    const tileMesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(input.tileGlb);
    const plan = planStations({ allFaces: faces, structure: input.structure, ground: input.ground, tileMesh, anchor: input.anchor });
    if (!plan.stations.length) throw new Error(`no survey station sees a wall of the massing (${plan.skipped.map(s => s.reason).join('; ') || 'every station was blocked'})`);
    const faceIdx = [...new Set([...plan.stations.map(s => s.face), ...(plan.stations.some(s => s.row === 'aerial') ? plan.faces : [])])];
    const survey = (glb: string, what: string) => surveyPlates({ stations: plan.stations, faces, faceIdx, tileGlb: glb, ...(input.signal ? { signal: input.signal } : {}), onProgress: m => progress(`Pipeline I + H (${what}): ${m.replace(/^pipeline G: /, '')}`) });
    const scan = await survey(input.tileGlb, 'tile');
    const model = await survey(unprojectedGlb, 'model');
    timingsMs.survey = Date.now() - t;

    // 3. each facade scored; 4. the scan plates projected where the model's wall lies on its plane
    t = Date.now();
    const scores = scan.plates.map((s, k) => compareFacade(s, model.plates[k]));
    let targets = scores.map((s, k) => ({ s, k })).filter(x => projectable(x.s)).map(x => ({ face: faces[scan.plates[x.k].face], plate: scan.plates[x.k] }));
    let cleaned: PlateClean[] | undefined;
    if (input.clean && targets.length) {
        progress(`Pipeline I + H: redrawing ${targets.length} wall plate(s) with the facade texture builder (identity gate)`);
        const outs = await Promise.all(targets.map(x => cleanPlate(x.plate, input.clean!, input.signal)));
        cleaned = outs.map(o => o.record);
        outs.forEach((o, k) => { if (o.plate) fs.writeFileSync(path.join(platesDir, `face_${o.plate.face}_cleaned.png`), platePng(o.plate, false)); });
        targets = targets.flatMap((x, k) => (outs[k].plate ? [{ face: x.face, plate: outs[k].plate! }] : []));
    }
    for (const s of scores) s.projected = targets.some(x => x.plate.key === s.key);
    const proj = targets.length ? projectPlatesOntoGlb(fitted, targets) : { glb: fitted, texels: 0, perFace: {} };
    const texturedGlb = path.join(input.dir, 'refine_textured.glb'), clayGlb = path.join(input.dir, 'refine_clay.glb');
    fs.writeFileSync(texturedGlb, proj.glb); fs.writeFileSync(clayGlb, stripMaterials(proj.glb));
    timingsMs.project = Date.now() - t;

    // the projected model surveyed and scored again
    t = Date.now();
    const after = targets.length ? await survey(texturedGlb, 'projected model') : undefined;
    timingsMs.resurvey = Date.now() - t;
    scan.plates.forEach((s, k) => {
        fs.writeFileSync(path.join(platesDir, `face_${s.face}_scan.png`), platePng(s, false));
        fs.writeFileSync(path.join(platesDir, `face_${s.face}_model.png`), platePng(model.plates[k], false));
        if (after) fs.writeFileSync(path.join(platesDir, `face_${s.face}_projected.png`), platePng(after.plates[k], false));
    });
    const facades = scores.map((s, k) => {
        if (!after || !s.projected) return s;
        const a = compareFacade(scan.plates[k], after.plates[k]);
        return { ...s, after: { precision: a.precision, recall: a.recall, f: a.f } };
    });
    const outcome: RefineOutcome = {
        files: { texturedGlb, clayGlb, unprojectedGlb, platesDir },
        fit: {
            massing: fine.fit, massingOnly: { planIoU: r3(massingOnly.planIoU), yawDeg: massingOnly.yawDeg, mirrored: massingOnly.mirrored, scanIoU: r3(iouAgainst(positions, massingOnly, input.scanFootprint)) },
            shift: fine.shift, wallDistanceM: fine.wallDistanceM,
            scanIoUOfMassingFit: r3(iouAgainst(positions, fine.fit, input.scanFootprint)),
            scanFit: { planIoU: input.scanFit.planIoU, coverage: input.scanFit.coverage, overflowShare: input.scanFit.overflowShare }
        },
        stations: plan.stations.length, facades, projected: { texels: proj.texels, perFace: proj.perFace }, ...(holes ? { holes } : {}), ...(cleaned ? { cleaned } : {}), timingsMs
    };
    fs.writeFileSync(path.join(input.dir, 'refine.json'), JSON.stringify({ version: PIPELINE_I_REFINE_VERSION, ...outcome }, null, 1));
    return outcome;
}
