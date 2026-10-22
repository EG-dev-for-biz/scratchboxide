/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Library materials for rebuilt surfaces (user direction, 2026-10-22: rebuild from scratch in the scan's likeness, never
 * the scan's photo draped on; always rebuilt textures, so no baked sun or shadow reaches a rebuilt surface).
 *
 * Per surface:
 *   1. its colour is measured from the tile photo, lit texels only (litColour): a measurement, the photo's texels are not used;
 *   2. the surface library (surface-texture-library.ts, in the durable asset store) is ranked by that colour, and the
 *      vision model picks among the leaders from an image of the surface (open vocabulary: the model reads the entries'
 *      own appearance text; nothing here names a material class);
 *   3. the chosen entry is tinted to the measured colour (surfaceTint) and laid on with world-scale UVs from its realSizeM,
 *      its normal and roughness maps embedded with it; a low-frequency colour field (COLOR_0) and a hex-tiling flag
 *      (extras.sbStochasticTiling, rendered by the viewport) break up the repeat.
 * Every such surface is labelled 'generated' with the entry id and the measured colour and how it was measured.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { rankSurfaceTextures, surfaceTint, validateSurfaceTextureIndex, type SurfaceTextureEntry, type SurfaceTextureIndex } from '../../../common/spatial/surface-texture-library';
import { SRGB8_TO_LINEAR, linearToSrgb255 } from '../../../common/spatial/photogrammetric-delight';
import type { VisionModelChain } from '../../gemini/vision-model-chain';
import { defaultDurableAssetStore, type DurableAssetStore } from '../../asset-store/durable-asset-store';
import { linearToLab } from './texel-exposure';
import { decodeImageInMemory } from './tile-texture-transfer';
import { encodePng } from './png-encode';
import type { StagedGlbImage, StagedGlbMaterial } from './staged-glb-writer';
import type { TopDownFrame, TopDownPhoto } from './top-down-photo';

export const SURFACE_MATERIALS_VERSION = 'surface-materials/1';
/** Where the library lives in the durable asset store (scripts/generate_surface_textures.ts writes it). */
export const SURFACE_LIBRARY_SERVED_DIR = '/models/surfaces';

// =============================================================================
// The library
// =============================================================================

export interface SurfaceLibrary {
    index: SurfaceTextureIndex;
    /** Where it was read from (for the labels). */
    source: string;
    readMap(entry: SurfaceTextureEntry, map: 'color' | 'normal' | 'roughness'): Buffer;
    entry(id: string): SurfaceTextureEntry | undefined;
}

function libraryOf(index: SurfaceTextureIndex, source: string, read: (rel: string) => Buffer): SurfaceLibrary {
    const problems = validateSurfaceTextureIndex(index);
    if (problems.length) throw new Error(`the surface library at ${source} is not usable: ${problems.slice(0, 3).join('; ')}`);
    const byId = new Map(index.surfaces.map(e => [e.id, e]));
    return { index, source, readMap: (e, m) => read(e.maps[m]!), entry: id => byId.get(id) };
}

/** The library from the durable asset store; throws an actionable error when it was never generated. */
export function loadSurfaceLibrary(store: DurableAssetStore | undefined = defaultDurableAssetStore()): SurfaceLibrary {
    if (!store) throw new Error('the durable asset store is off (SCRATCHBOX_ASSET_STORE=0), so the surface library cannot be read');
    const idx = store.lookup(`${SURFACE_LIBRARY_SERVED_DIR}/index.json`);
    if (!idx) throw new Error(`no surface library in the asset store (${SURFACE_LIBRARY_SERVED_DIR}/index.json): run npx tsx scripts/generate_surface_textures.ts`);
    const index = JSON.parse(fs.readFileSync(idx.file, 'utf8')) as SurfaceTextureIndex;
    return libraryOf(index, `asset store ${SURFACE_LIBRARY_SERVED_DIR}/index.json (sha256 ${idx.sha256.slice(0, 12)})`, rel => {
        const f = store.lookup(`${SURFACE_LIBRARY_SERVED_DIR}/${rel}`);
        if (!f) throw new Error(`the surface library names ${rel}, but the asset store has no bytes for it`);
        return fs.readFileSync(f.file);
    });
}

/** A library from a folder holding index.json and its maps (tests, a checked-out set). */
export function surfaceLibraryFromDir(dir: string): SurfaceLibrary {
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')) as SurfaceTextureIndex;
    return libraryOf(index, dir, rel => fs.readFileSync(path.join(dir, rel)));
}

// =============================================================================
// Measuring a surface's colour, shadow-robust
// =============================================================================

export interface MeasuredColour {
    linearRgb: [number, number, number];
    lab: [number, number, number];
    /** Texels the mean was taken over, and how many the surface had. */
    texels: number;
    of: number;
    /** Whether the texels split into a shadowed and a lit population (the lit one kept). */
    shadowSplit: boolean;
    method: string;
}

export const LIT_COLOUR_PARAMS = {
    /** Lit over shadowed mean luminance at least this for the texels to count as two populations (sun vs shade on one material). */
    shadowRatio: 1.6,
    /** The lit population must hold at least this share of the texels. */
    minLitShare: 0.08,
    /** Without a split: the luminance percentiles kept (the darker part and specular highlights left out). */
    keepFrom: 0.4,
    keepTo: 0.95,
    /** With a split: the lit population's top share left out (highlights). */
    trimTop: 0.05
};

export const LIT_COLOUR_METHOD = 'tile photo texels of the surface, lit ones only: an Otsu split of log luminance separates sun from shade when the two differ by 1.6x or more (the lit side kept, its top 5% dropped as highlights), else the 40th-95th luminance percentiles; averaged in linear sRGB. A measurement only: no photo texel is drawn on the surface';

/**
 * The colour of a surface's lit texels (sRGB8 RGBA, alpha 0 = not the surface). `keep(i)` restricts further (pixel index).
 * Undefined when fewer than `minTexels` remain.
 */
export function litColour(rgba: Uint8Array, opts: { keep?: (i: number) => boolean; stride?: number; minTexels?: number } = {}, P = LIT_COLOUR_PARAMS): MeasuredColour | undefined {
    const n = rgba.length >> 2, stride = Math.max(1, opts.stride ?? 1);
    const idx: number[] = [], lum: number[] = [];
    for (let i = 0; i < n; i += stride) {
        if (rgba[i * 4 + 3] < 128 || (opts.keep && !opts.keep(i))) continue;
        const r = SRGB8_TO_LINEAR[rgba[i * 4]], g = SRGB8_TO_LINEAR[rgba[i * 4 + 1]], b = SRGB8_TO_LINEAR[rgba[i * 4 + 2]];
        idx.push(i); lum.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
    }
    if (idx.length < (opts.minTexels ?? 16)) return undefined;
    const order = idx.map((_, k) => k).sort((a, b) => lum[a] - lum[b]);
    // Otsu on log luminance over the sorted texels
    const L = order.map(k => Math.log(Math.max(1e-4, lum[k])));
    const total = L.reduce((a, b) => a + b, 0);
    let best = -1, cut = -1, acc = 0;
    for (let k = 1; k < L.length; k++) {
        acc += L[k - 1];
        const w0 = k / L.length, w1 = 1 - w0, m0 = acc / k, m1 = (total - acc) / (L.length - k);
        const between = w0 * w1 * (m1 - m0) * (m1 - m0);
        if (between > best) { best = between; cut = k; }
    }
    let from: number, to: number, split = false;
    if (cut > 0) {
        const m0 = order.slice(0, cut).reduce((a, k) => a + lum[k], 0) / cut;
        const m1 = order.slice(cut).reduce((a, k) => a + lum[k], 0) / (order.length - cut);
        split = m1 / Math.max(1e-6, m0) >= P.shadowRatio && (order.length - cut) / order.length >= P.minLitShare;
    }
    if (split) { from = cut; to = Math.max(cut + 1, Math.round(order.length - (order.length - cut) * P.trimTop)); }
    else { from = Math.floor(order.length * P.keepFrom); to = Math.max(from + 1, Math.ceil(order.length * P.keepTo)); }
    const sum = [0, 0, 0];
    for (let k = from; k < to; k++) { const i = idx[order[k]]; for (let c = 0; c < 3; c++) sum[c] += SRGB8_TO_LINEAR[rgba[i * 4 + c]]; }
    const cnt = to - from;
    const linearRgb = sum.map(v => v / cnt) as [number, number, number];
    const lab = linearToLab(...linearRgb) as [number, number, number];
    return { linearRgb: linearRgb.map(r4) as [number, number, number], lab: lab.map(v => Math.round(v * 10) / 10) as [number, number, number], texels: cnt, of: idx.length, shadowSplit: split, method: LIT_COLOUR_METHOD };
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** The colour of several measurements together, weighted by their texels. */
export function poolColours(cs: Array<MeasuredColour | undefined>): MeasuredColour | undefined {
    const ok = cs.filter((c): c is MeasuredColour => !!c && c.texels > 0);
    if (!ok.length) return undefined;
    const w = ok.reduce((a, c) => a + c.texels, 0);
    const linearRgb = [0, 1, 2].map(k => r4(ok.reduce((a, c) => a + c.linearRgb[k] * c.texels, 0) / w)) as [number, number, number];
    return { linearRgb, lab: linearToLab(...linearRgb).map(v => Math.round(v * 10) / 10) as [number, number, number], texels: w, of: ok.reduce((a, c) => a + c.of, 0), shadowSplit: ok.some(c => c.shadowSplit), method: ok[0].method };
}

// =============================================================================
// Choosing an entry
// =============================================================================

/** One surface to choose a material for. `view` is free text telling the model what the image shows. */
export interface SurfaceSubject {
    key: string;
    view: string;
    image: { bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png'; widthM: number; heightM: number };
    measured: MeasuredColour;
}

export interface SurfaceChoice {
    key: string;
    entryId: string;
    by: 'vision' | 'colour-rank';
    /** The leaders by colour the choice was made among (nearest first). */
    candidates: string[];
    model?: string;
    confidence?: number;
    why?: string;
    /** Why the vision model did not choose (the colour ranking's leader stands in, labelled). */
    reason?: string;
    measured: MeasuredColour;
}

/**
 * candidates: how many of the colour ranking's leaders the model chooses among. The whole library by default: a ranking
 * on chroma alone left a lawn's own entry out of a lawn's list and paving in a wall's (Federation Square, 2026-10-22);
 * the ranking orders the list, the model reads every entry's appearance.
 */
export const SURFACE_CHOICE_PARAMS = { candidates: 64, perCall: 4, concurrency: 6, deadlineMs: 120_000 };

export function surfaceChoicePrompt(subjects: Array<Pick<SurfaceSubject, 'view' | 'image'> & { candidates: SurfaceTextureEntry[] }>): string {
    const lines = [
        'You are choosing tileable surface materials for a 3D rebuild of a real place. Each image shows one surface, cut from an aerial photogrammetry photo (sun and shadow are baked into it, and it is blurry): judge what the surface is made of, its pattern and the size of its units, not the lighting.',
        'For each surface choose one material from that surface\'s own candidate list only (listed nearest in measured colour first). The material will be tinted to the colour measured on the surface, so weigh what the surface is, its pattern, unit size and texture above hue. Choose what would be built there: a wall material for a wall, a ground or road surface for the ground, a roofing material for a roof, unless the image clearly shows otherwise.',
        'Answer JSON only: {"choices":[{"surface":<number>,"id":"<candidate id>","confidence":<0..1>,"why":"<a few words>"}]}',
        ''
    ];
    subjects.forEach((s, i) => {
        lines.push(`Surface ${i + 1} (image ${i + 1}): ${s.view}. The image spans ${s.image.widthM.toFixed(1)} x ${s.image.heightM.toFixed(1)} m.`);
        lines.push('Candidates:');
        for (const e of s.candidates) lines.push(`- ${e.id}: ${e.appearance} (one tile spans ${e.realSizeM[0]} x ${e.realSizeM[1]} m)`);
        lines.push('');
    });
    return lines.join('\n');
}

export function parseSurfaceChoices(text: string, count: number): Map<number, { id: string; confidence?: number; why?: string }> {
    const out = new Map<number, { id: string; confidence?: number; why?: string }>();
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return out;
    let doc: any;  // eslint-disable-line @typescript-eslint/no-explicit-any
    try { doc = JSON.parse(m[0]); } catch { return out; }
    for (const c of Array.isArray(doc?.choices) ? doc.choices : []) {
        const s = Number(c?.surface);
        if (!Number.isInteger(s) || s < 1 || s > count || typeof c?.id !== 'string') continue;
        out.set(s - 1, { id: c.id.trim(), ...(Number.isFinite(Number(c.confidence)) ? { confidence: Math.max(0, Math.min(1, Number(c.confidence))) } : {}), ...(typeof c.why === 'string' ? { why: c.why.slice(0, 200) } : {}) });
    }
    return out;
}

const responseText = (r: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }> }) => r.candidates?.[0]?.content?.parts?.filter(p => !p.thought).map(p => p.text ?? '').join('') ?? '';

/**
 * Chooses an entry per subject: the colour ranking's leaders, then the vision model's pick among them (several subjects
 * per call). Without a model, or where its answer names no candidate, the ranking's leader stands, with the reason.
 */
export async function chooseSurfaceMaterials(input: {
    library: SurfaceTextureIndex; subjects: SurfaceSubject[]; chain?: Pick<VisionModelChain<string>, 'generate'>; unavailable?: string;
    signal?: AbortSignal; onProgress?: (m: string) => void;
}, P = SURFACE_CHOICE_PARAMS): Promise<SurfaceChoice[]> {
    const byId = new Map(input.library.surfaces.map(e => [e.id, e]));
    const ranked = input.subjects.map(s => rankSurfaceTextures(input.library, { meanLab: s.measured.lab }).slice(0, P.candidates).map(r => r.id));
    const out: SurfaceChoice[] = input.subjects.map((s, i) => ({ key: s.key, entryId: ranked[i][0], by: 'colour-rank', candidates: ranked[i], measured: s.measured, reason: input.chain ? 'not answered' : `no vision model (${input.unavailable ?? 'none configured'}): the nearest entry by measured colour` }));
    if (!input.chain || !input.subjects.length) return out;
    const batches: number[][] = [];
    for (let i = 0; i < input.subjects.length; i += P.perCall) batches.push(input.subjects.slice(i, i + P.perCall).map((_, k) => i + k));
    let next = 0, done = 0;
    const worker = async () => {
        while (next < batches.length) {
            const batch = batches[next++];
            if (input.signal?.aborted) return;
            const subs = batch.map(i => ({ ...input.subjects[i], candidates: ranked[i].map(id => byId.get(id)!) }));
            try {
                const r = await input.chain!.generate({
                    contents: [{ role: 'user', parts: [...subs.map(s => ({ inlineData: { mimeType: s.image.mimeType, data: Buffer.from(s.image.bytes).toString('base64') } })), { text: surfaceChoicePrompt(subs) }] }],
                    config: { responseMimeType: 'application/json', temperature: 0 }
                }, { stage: 'surface-materials', deadlineMs: P.deadlineMs, valid: res => parseSurfaceChoices(responseText(res), subs.length).size > 0 });
                const picks = parseSurfaceChoices(responseText(r.response), subs.length);
                let usable = 0;
                batch.forEach((i, k) => {
                    const p = picks.get(k);
                    if (p && ranked[i].includes(p.id)) { out[i] = { ...out[i], entryId: p.id, by: 'vision', model: r.model, ...(p.confidence !== undefined ? { confidence: p.confidence } : {}), ...(p.why ? { why: p.why } : {}) }; delete out[i].reason; usable++; }
                    else out[i] = { ...out[i], reason: p ? `the model named ${p.id}, not a candidate: the nearest entry by measured colour` : 'the model gave no choice for it: the nearest entry by measured colour' };
                });
                if (usable) r.remember();
            } catch (err) {
                for (const i of batch) out[i] = { ...out[i], reason: `the vision call failed (${err instanceof Error ? err.message : String(err)}): the nearest entry by measured colour` };
            }
            done += batch.length;
            input.onProgress?.(`materials chosen for ${done} of ${input.subjects.length} surfaces`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(P.concurrency, batches.length) }, worker));
    return out;
}

// =============================================================================
// The materials
// =============================================================================

/**
 * The low-frequency colour field laid over a library surface (COLOR_0, which multiplies the base colour): two octaves of
 * value noise in world space, so a long road or a wide plaza does not read as one tile repeated. Its mean is `mean`; the
 * tint is divided by it, so the measured colour is kept on average.
 */
export const VARIATION_PARAMS = { mean: 0.9, luminanceAmp: 0.09, chromaAmp: 0.025, wavelengthsM: [41, 13] as [number, number] };

function hash3(x: number, y: number, z: number, s: number): number {
    let h = (x * 374761393 + y * 668265263 + z * 2147483647 + s * 1274126177) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x: number, y: number, z: number, seed: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const f = (t: number) => t * t * (3 - 2 * t);
    const fx = f(x - xi), fy = f(y - yi), fz = f(z - zi);
    let v = 0;
    for (let c = 0; c < 8; c++) {
        const dx = c & 1, dy = (c >> 1) & 1, dz = (c >> 2) & 1;
        v += hash3(xi + dx, yi + dy, zi + dz, seed) * (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
    }
    return v * 2 - 1;
}

/** The colour field at a world point: a multiplier per channel around VARIATION_PARAMS.mean (never above 1). */
export function variationAt(x: number, y: number, z: number, seed = 0, P = VARIATION_PARAMS): [number, number, number] {
    const [w0, w1] = P.wavelengthsM;
    const n = 0.65 * valueNoise(x / w0, y / w0, z / w0, seed) + 0.35 * valueNoise(x / w1, y / w1, z / w1, seed + 1);
    const hue = valueNoise(x / w0 + 17.3, y / w0, z / w0 - 5.1, seed + 2);
    const l = P.mean + P.luminanceAmp * n;
    return [l * (1 + P.chromaAmp * hue), l, l * (1 - P.chromaAmp * hue)].map(v => Math.min(1, Math.max(0, v))) as [number, number, number];
}

export function variationColors(positions: Float32Array, seed = 0): Float32Array {
    const out = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) out.set(variationAt(positions[i], positions[i + 1], positions[i + 2], seed), i);
    return out;
}

/**
 * Per triangle-soup vertex: world-scale UVs. Up-facing surfaces (|n_y| >= wallBelow) are planar from above (u east, v south);
 * steeper ones planar on their own vertical plane (u along the face to the viewer's right, v down the image = up the
 * wall), so neither is mirrored. Metres, divided by the tile size later. `normalOf(t)` is the triangle's unit normal.
 */
export function worldUvMetres(positions: Float32Array, indices: Uint32Array, wallBelow = 0.6): Float32Array {
    const uv = new Float32Array((positions.length / 3) * 2);
    for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
        const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
        const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
        const h = Math.hypot(nx, nz);
        for (const i of [indices[t], indices[t + 1], indices[t + 2]]) {
            const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
            if (Math.abs(ny) >= wallBelow || h < 1e-6) { uv[i * 2] = x; uv[i * 2 + 1] = z; }
            else { uv[i * 2] = (x * nz - z * nx) / h; uv[i * 2 + 1] = -y; }
        }
    }
    return uv;
}

/**
 * The measured colour layer under a ground or street material (COLOR_0): at each vertex the lit colour of the tile photo
 * in a small window around it, relative to its surface's own measured colour, so the surface carries the place's own
 * non-repeating tone (worn paths, patching, stains, a lawn's dry patches) at scene scale under the library's micro-detail.
 * A window in a cast shadow (darker and bluer than its surface) or without enough texels takes the surface's colour:
 * no shadow is baked in. `headroom` leaves room above the surface's colour (COLOR_0 cannot exceed 1); the material's
 * factor is raised by it (buildLibraryMaterials' variationMean = 1 / headroom).
 */
export const COLOUR_FIELD_PARAMS = { windowM: 2.5, headroom: 1.3, shadowDarkerL: 10, shadowBluerB: 2.5, minTexels: 12 };

export const COLOUR_FIELD_METHOD = 'per vertex: the lit colour (litColour) of the top-down tile photo in a 2.5 m window, divided by its surface\'s measured colour; windows in a cast shadow or unmeasured keep the surface colour';

export function measuredColourField(photo: TopDownPhoto, frame: TopDownFrame, positions: Float32Array, referenceOf: (vertex: number) => MeasuredColour, P = COLOUR_FIELD_PARAMS): { colors: Float32Array; measured: number; shadowed: number; unmeasured: number } {
    const n = positions.length / 3, colors = new Float32Array(n * 3);
    const half = Math.max(1, Math.round(P.windowM / photo.texelM / 2)), side = 2 * half + 1;
    const step = Math.max(1, Math.round(side / 16));
    const buf = new Uint8Array(Math.ceil(side / step) ** 2 * 4);
    let measured = 0, shadowed = 0, unmeasured = 0;
    for (let v = 0; v < n; v++) {
        const ref = referenceOf(v);
        const cx = Math.floor((positions[v * 3] - frame.x0) / photo.texelM), cy = Math.floor((positions[v * 3 + 2] - frame.z0) / photo.texelM);
        let q = 0;
        for (let y = -half; y <= half; y += step) for (let x = -half; x <= half; x += step, q++) {
            const sx = cx + x, sy = cy + y;
            if (sx < 0 || sy < 0 || sx >= photo.width || sy >= photo.height) { buf[q * 4 + 3] = 0; continue; }
            buf.set(photo.rgba.subarray((sy * photo.width + sx) * 4, (sy * photo.width + sx) * 4 + 3), q * 4);
            buf[q * 4 + 3] = 255;
        }
        const c = litColour(buf.subarray(0, q * 4), { minTexels: P.minTexels });
        let rgb = ref.linearRgb;
        if (!c) unmeasured++;
        else if (c.lab[0] < ref.lab[0] - P.shadowDarkerL && c.lab[2] < ref.lab[2] - P.shadowBluerB) shadowed++;
        else { rgb = c.linearRgb; measured++; }
        for (let k = 0; k < 3; k++) colors[v * 3 + k] = Math.min(1, Math.max(0, rgb[k] / Math.max(1e-4, ref.linearRgb[k] * P.headroom)));
    }
    return { colors, measured, shadowed, unmeasured };
}

/** Whether a triangle faces up or down more than sideways (a roof, a floor) rather than a wall. */
export function triangleIsLevel(positions: Float32Array, indices: Uint32Array, t: number, wallBelow = 0.6): boolean {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ux = positions[b] - positions[a], uy = positions[b + 1] - positions[a + 1], uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a], vy = positions[c + 1] - positions[a + 1], vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    return l > 0 && Math.abs(ny) / l >= wallBelow;
}

/** The hex-tiling flag a library material carries (renderer-agnostic; the viewport's adapter renders it). */
export const STOCHASTIC_TILING = {
    schema: 'scratchbox.stochastic-tiling/1',
    method: 'hex-tiling: three hexagonal cells per texel, each with its own random offset and rotation, blended with contrast-preserving weights (Mikkelsen 2022, JCGT 11(2); after Heitz and Neyret 2018)',
    /** Hex cells per texture tile (larger: smaller cells). */
    cellsPerTile: 1.6,
    /** Random rotation per cell, radians either way (0: offsets only). */
    rotation: 0.6,
    /** How much the blend favours the brighter of the three samples (0: plain barycentric). */
    luminanceFalloff: 0.6,
    /** Sharpening exponent of the barycentric weights. */
    weightExponent: 7
};

/** One use of a library entry: the surface it is laid on, the tint to its measured colour, and the extras to label it with. */
export interface LibraryMaterialUse {
    name: string;
    entryId: string;
    /** Per-channel linear gain taking the entry's mean colour to the measured one. */
    tint: [number, number, number];
    extras: Record<string, unknown>;
    /** The mean of the COLOR_0 layer this use's surface carries (default: the call's). */
    variationMean?: number;
}

export interface LibraryMaterialSet {
    materials: StagedGlbMaterial[];
    /** The confidence image the materials' extras refer to (as '@image:confidence'). */
    extraImages: Record<string, StagedGlbImage>;
    /** Bytes of the embedded maps, per entry. */
    bytesByEntry: Record<string, number>;
}

/** The provenance list index, weight and ladder rung (5: generated tileable PBR) every library texel carries. */
export const LIBRARY_CONFIDENCE_PIXEL = [0, 128, 5, 255];

/**
 * The glTF materials for a set of uses. Each entry's maps are embedded once (its colour map pre-multiplied by the largest
 * tint its uses need, so each use's own factor stays at or under 1), normal and metallic-roughness alongside; each use
 * is one material with its own base colour factor, its labels and the hex-tiling flag. `variationMean` is the mean of
 * the COLOR_0 field the surfaces carry (the factor is divided by it).
 */
export function buildLibraryMaterials(library: SurfaceLibrary, uses: LibraryMaterialUse[], opts: { variationMean?: number; jpegQuality?: number } = {}): LibraryMaterialSet {
    const vm = opts.variationMean ?? VARIATION_PARAMS.mean, q = opts.jpegQuality ?? 90;
    const want = (u: LibraryMaterialUse) => u.tint.map(t => t / (u.variationMean ?? vm)) as [number, number, number];
    const gains = new Map<string, [number, number, number]>();
    for (const u of uses) {
        const g = gains.get(u.entryId) ?? [0, 0, 0];
        gains.set(u.entryId, want(u).map((w, k) => Math.max(g[k], w)) as [number, number, number]);
    }
    const maps = new Map<string, { color: StagedGlbImage; normal: StagedGlbImage; mr: StagedGlbImage }>();
    const bytesByEntry: Record<string, number> = {};
    for (const [id, gain] of gains) {
        const e = library.entry(id);
        if (!e) throw new Error(`the surface library has no entry ${id}`);
        const col = decodeImageInMemory(library.readMap(e, 'color'));
        const tinted = Buffer.alloc(col.width * col.height * 4);
        for (let i = 0; i < col.width * col.height; i++) {
            for (let c = 0; c < 3; c++) tinted[i * 4 + c] = Math.round(linearToSrgb255(Math.min(1, SRGB8_TO_LINEAR[col.rgba[i * 4 + c]] * gain[c])));
            tinted[i * 4 + 3] = 255;
        }
        const rough = decodeImageInMemory(library.readMap(e, 'roughness'));
        const mr = Buffer.alloc(rough.width * rough.height * 4);
        const metal = Math.round(255 * e.surface.metallic);
        for (let i = 0; i < rough.width * rough.height; i++) { mr[i * 4] = 255; mr[i * 4 + 1] = rough.rgba[i * 4 + 1]; mr[i * 4 + 2] = metal; mr[i * 4 + 3] = 255; }
        const color: StagedGlbImage = { bytes: new Uint8Array(jpegJs.encode({ data: tinted, width: col.width, height: col.height }, q).data), mimeType: 'image/jpeg', name: `${id}_color` };
        const normalBytes = library.readMap(e, 'normal');
        const normal: StagedGlbImage = { bytes: new Uint8Array(normalBytes), mimeType: normalBytes[0] === 0x89 ? 'image/png' : 'image/jpeg', name: `${id}_normal` };
        const mrImg: StagedGlbImage = { bytes: new Uint8Array(jpegJs.encode({ data: mr, width: rough.width, height: rough.height }, q).data), mimeType: 'image/jpeg', name: `${id}_metallic_roughness` };
        maps.set(id, { color, normal, mr: mrImg });
        bytesByEntry[id] = color.bytes.length + normal.bytes.length + mrImg.bytes.length;
    }
    const materials: StagedGlbMaterial[] = uses.map(u => {
        const e = library.entry(u.entryId)!, m = maps.get(u.entryId)!, g = gains.get(u.entryId)!;
        const factor = want(u).map((w, k) => Math.min(1, w / Math.max(1e-6, g[k]))) as [number, number, number];
        return {
            name: u.name, baseColor: m.color, normal: m.normal, metallicRoughness: m.mr, baseColorFactor: [factor[0], factor[1], factor[2], 1], roughness: 1, metallic: 1,
            extras: {
                ...u.extras,
                sbTexture: { confidenceTexture: '@image:confidence', confidenceChannels: 'R = index into provenance[], G = weight 0..255, B = ladder rung (TEXTURE_LADDER_RUNGS), A = 255 where a stage produced the texel' },
                sbStochasticTiling: { ...STOCHASTIC_TILING, tileM: e.realSizeM }
            }
        };
    });
    return { materials, extraImages: { confidence: { bytes: new Uint8Array(encodePng(1, 1, Buffer.from(LIBRARY_CONFIDENCE_PIXEL), 4)), mimeType: 'image/png', name: 'library_confidence' } }, bytesByEntry };
}

/** The labels a library surface carries (node and material extras). */
export function surfaceMaterialLabel(choice: SurfaceChoice, library: SurfaceLibrary, entry = library.entry(choice.entryId)!): Record<string, unknown> {
    return {
        sbSurfaceMaterial: {
            schema: 'scratchbox.surface-material/1', version: SURFACE_MATERIALS_VERSION,
            provenance: 'generated', entryId: choice.entryId, entryProvenance: entry.provenance, library: library.source,
            realSizeM: entry.realSizeM,
            chosenBy: choice.by, candidates: choice.candidates, ...(choice.model ? { model: choice.model } : {}), ...(choice.confidence !== undefined ? { confidence: choice.confidence } : {}),
            ...(choice.why ? { why: choice.why } : {}), ...(choice.reason ? { reason: choice.reason } : {}),
            measuredColour: { linearRgb: choice.measured.linearRgb, lab: choice.measured.lab, texels: choice.measured.texels, of: choice.measured.of, shadowSplit: choice.measured.shadowSplit, method: choice.measured.method, label: 'measured' },
            tint: surfaceTint(entry, choice.measured.linearRgb).map(r4),
            note: 'the surface is a generated library texture tinted to the colour measured on the tile photo; no photo texel is drawn on it'
        }
    };
}

/** Divides metre UVs by an entry's tile size (in place). */
export function scaleUv(uvMetres: Float32Array, realSizeM: [number, number]): Float32Array {
    for (let i = 0; i < uvMetres.length; i += 2) { uvMetres[i] /= realSizeM[0]; uvMetres[i + 1] /= realSizeM[1]; }
    return uvMetres;
}
