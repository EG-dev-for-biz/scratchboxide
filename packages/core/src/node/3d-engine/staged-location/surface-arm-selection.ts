/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Per-surface arm selection: for each rebuilt surface (a wall, a roof, a ground cell), which of several treatments of it
 * (the arms: e.g. the tile photo transfer on rebuilt planes, a scan-conditioned painting, the painting on grammar geometry,
 * the raw scan) should the build keep?
 *
 * Every arm is a set of GLB layers in the tile frame. A surface is found in an arm by its node names (`nodePrefixes`: the
 * staged writers name every part) or, where the arm has no such node (a scan, a hand-made soup), by an oriented box around
 * it. For each view that sees the surface, every arm's version of it is rendered in place, inside the same scene (the base
 * arm with that surface removed, plus the shared context), from the same camera and light; the views are cropped to the
 * surface. A blind judge (arms shuffled and unlabelled, repeated) sees the reference tiles' crop (layout) and any
 * search-grounded references of the surface (the real place's look; generated, never measurements), and scores each crop's
 * realism, identity and errors 1-10.
 *
 * The rule (decideSurfaceArm) keeps the base arm (the safety net) unless another arm raises realism clearly (by at least
 * `minRealismRise` and at least `seMultiple` standard errors of the difference) while identity does not fall (by more than
 * `identityTolerance`) and errors do not rise (by more than `errorsTolerance`); of the arms that pass, the most realistic wins.
 * Every arm's verdict carries its reason. Nothing here knows a place, a surface kind or a pipeline.
 */

import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { coverageMask, seededShuffle, type ArmRender, type JudgeClient } from './photo-match-eval';
import { stat, type Stat } from './replica-scorecard';
import { readGlbChunks, readTileTriangles, selectTriangles, type TileTriangles } from './tile-texture-transfer';

export const SURFACE_ARMS_SCHEMA = 'scratchbox.surface-arms/1';

/** An oriented box: a centre, three orthonormal axes (default the tile frame's) and the half-size along each. */
export interface OrientedBox { center: Vec3; axes?: [Vec3, Vec3, Vec3]; halfSize: Vec3 }

export interface SurfaceSpec {
    id: string;
    /** Words for a search-grounded reference of this surface ("the Flinders Street facade of Flinders Street Station"). */
    subject?: string;
    /** Node-name prefixes of the surface's parts in arms whose GLBs name them. */
    nodePrefixes?: string[];
    /** Where the surface is, for arms with no node of it (by triangle centroid). */
    box?: OrientedBox;
    /** Restrict to these camera views (ids). */
    views?: string[];
}

export interface SurfaceArmManifest {
    schema: typeof SURFACE_ARMS_SCHEMA;
    place: string;
    /** The safety-net arm: kept unless another arm passes the rule. */
    base: string;
    arms: Record<string, { glbs: string[]; label?: string }>;
    surfaces: SurfaceSpec[];
    /** Layers every render shares (ground, roads, trees). */
    context?: string[];
}

/** Checks a manifest read from JSON; throws with every problem found. */
export function validateSurfaceArmManifest(j: unknown): SurfaceArmManifest {
    const m = j as SurfaceArmManifest;
    const problems: string[] = [];
    const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x));
    if (m?.schema !== SURFACE_ARMS_SCHEMA) problems.push(`schema is ${String(m?.schema)}, expected ${SURFACE_ARMS_SCHEMA}`);
    if (!m?.arms || typeof m.arms !== 'object' || Object.keys(m.arms).length < 2) problems.push('at least two arms are needed');
    else {
        if (!m.arms[m.base]) problems.push(`the base arm ${String(m.base)} is not among the arms`);
        for (const [id, a] of Object.entries(m.arms)) if (!Array.isArray(a?.glbs) || !a.glbs.length) problems.push(`arm ${id} has no glbs`);
    }
    const ids = new Set<string>();
    if (!Array.isArray(m?.surfaces) || !m.surfaces.length) problems.push('no surfaces');
    for (const s of m?.surfaces ?? []) {
        if (!s.id || ids.has(s.id)) problems.push(`surface id ${String(s.id)} is missing or repeated`);
        ids.add(s.id);
        if (!s.nodePrefixes?.length && !s.box) problems.push(`${s.id}: give nodePrefixes, a box, or both`);
        if (s.box && (!vec(s.box.center) || !vec(s.box.halfSize) || (s.box.axes && !(s.box.axes.length === 3 && s.box.axes.every(vec))))) problems.push(`${s.id}: the box needs a centre, a half-size and (optionally) three axes`);
    }
    if (problems.length) throw new Error(`surface arms: ${problems.join('; ')}`);
    return m;
}

/** An arm layer with each triangle's node name (from the GLB's node tags). */
export interface NamedTriangles { tris: TileTriangles; nodeName: (t: number) => string }

export function readNamedTriangles(glb: Uint8Array): NamedTriangles {
    const tris = readTileTriangles(glb, { nodeTags: true });
    const names: string[] = (readGlbChunks(glb).json.nodes ?? []).map((n: { name?: string }) => n?.name ?? '');
    return { tris, nodeName: t => names[tris.node[t]] ?? '' };
}

function insideBox(b: OrientedBox, x: number, y: number, z: number): boolean {
    const axes = b.axes ?? [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const d = [x - b.center[0], y - b.center[1], z - b.center[2]];
    for (let k = 0; k < 3; k++) if (Math.abs(d[0] * axes[k][0] + d[1] * axes[k][1] + d[2] * axes[k][2]) > b.halfSize[k]) return false;
    return true;
}

/**
 * Per triangle of a layer, 1 where it belongs to the surface: by node-name prefix when the layer has any node of the
 * surface, else by centroid inside the box (or nothing, without a box).
 */
export function surfaceFlags(layer: NamedTriangles, s: SurfaceSpec): Uint8Array {
    const n = layer.tris.texture.length, out = new Uint8Array(n);
    const prefixes = s.nodePrefixes ?? [];
    if (prefixes.length) {
        let any = false;
        for (let t = 0; t < n; t++) { const nm = layer.nodeName(t); if (prefixes.some(p => nm.startsWith(p))) { out[t] = 1; any = true; } }
        if (any) return out;
    }
    if (!s.box) return out;
    const P = layer.tris.positions;
    for (let t = 0; t < n; t++) {
        const o = t * 9;
        if (insideBox(s.box, (P[o] + P[o + 3] + P[o + 6]) / 3, (P[o + 1] + P[o + 4] + P[o + 7]) / 3, (P[o + 2] + P[o + 5] + P[o + 8]) / 3)) out[t] = 1;
    }
    return out;
}

/** A layer split into the surface and the rest. */
export function splitSurface(layer: NamedTriangles, s: SurfaceSpec): { surface: TileTriangles; rest: TileTriangles; count: number } {
    const f = surfaceFlags(layer, s);
    const inv = new Uint8Array(f.length);
    let count = 0;
    for (let i = 0; i < f.length; i++) { inv[i] = f[i] ? 0 : 1; count += f[i]; }
    return { surface: selectTriangles(layer.tris, f), rest: selectTriangles(layer.tris, inv), count };
}

// =============================================================================
// Crops
// =============================================================================

export interface PixelBox { x0: number; y0: number; x1: number; y1: number }

/**
 * The crop that shows a surface in a view: the bounding box of the union of the arms' coverage masks, padded by `pad` of its
 * size and grown to at least `minSide` px, kept inside the image. Undefined when the union covers fewer than `minPixels`.
 */
export function surfaceCrop(renders: ArmRender[], options: { pad?: number; minSide?: number; minPixels?: number } = {}): { box: PixelBox; pixels: number } | undefined {
    if (!renders.length) return undefined;
    const { width: W, height: H } = renders[0];
    const masks = renders.map(r => coverageMask(r));
    let x0 = W, y0 = H, x1 = -1, y1 = -1, pixels = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!masks.some(m => m[i])) continue;
        pixels++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (pixels < (options.minPixels ?? 1500)) return undefined;
    const pad = options.pad ?? 0.12, minSide = options.minSide ?? 192;
    const grow = (a: number, b: number, n: number): [number, number] => {
        const len = b - a + 1, want = Math.max(minSide, Math.round(len * (1 + 2 * pad)));
        let lo = Math.round((a + b) / 2 - want / 2), hi = lo + want - 1;
        if (lo < 0) { hi -= lo; lo = 0; }
        if (hi > n - 1) { lo -= hi - (n - 1); hi = n - 1; }
        return [Math.max(0, lo), Math.min(n - 1, hi)];
    };
    const [gx0, gx1] = grow(x0, x1, W), [gy0, gy1] = grow(y0, y1, H);
    return { box: { x0: gx0, y0: gy0, x1: gx1, y1: gy1 }, pixels };
}

/** An image's crop, resampled (bilinear) to `width` px wide (aspect kept). */
export function cropImage(img: { width: number; height: number; rgba: Uint8Array }, b: PixelBox, width?: number): { width: number; height: number; rgba: Uint8Array } {
    const cw = b.x1 - b.x0 + 1, ch = b.y1 - b.y0 + 1;
    const ow = Math.max(1, Math.round(width ?? cw)), oh = Math.max(1, Math.round((ch * ow) / cw));
    const out = new Uint8Array(ow * oh * 4);
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        const sx = b.x0 + ((x + 0.5) * cw) / ow - 0.5, sy = b.y0 + ((y + 0.5) * ch) / oh - 0.5;
        const ix = Math.max(b.x0, Math.min(b.x1 - 1, Math.floor(sx))), iy = Math.max(b.y0, Math.min(b.y1 - 1, Math.floor(sy)));
        const fx = Math.max(0, Math.min(1, sx - ix)), fy = Math.max(0, Math.min(1, sy - iy));
        const ix1 = Math.min(img.width - 1, ix + 1), iy1 = Math.min(img.height - 1, iy + 1);
        for (let c = 0; c < 4; c++) {
            const a = img.rgba[(iy * img.width + ix) * 4 + c], bb = img.rgba[(iy * img.width + ix1) * 4 + c];
            const cc = img.rgba[(iy1 * img.width + ix) * 4 + c], d = img.rgba[(iy1 * img.width + ix1) * 4 + c];
            out[(y * ow + x) * 4 + c] = Math.round((a * (1 - fx) + bb * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy);
        }
    }
    return { width: ow, height: oh, rgba: out };
}

// =============================================================================
// Judging
// =============================================================================

export const SURFACE_CRITERIA = ['realism', 'identity', 'errors'] as const;
export type SurfaceCriterion = typeof SURFACE_CRITERIA[number];
export type SurfaceScores = Record<SurfaceCriterion, number> & { note: string };
export interface SurfaceJudgeRun { view: string; order: string[]; scores: Record<string, SurfaceScores>; model: string }

export function surfaceJudgePrompt(place: string, count: number, ctx: { lit?: boolean; grounded?: number } = {}): { preamble: string; closing: string } {
    const g = ctx.grounded ?? 0;
    return {
        preamble: `You are choosing between treatments of one surface of a 3D rebuild of a real place: ${place}. Image 0 is the reference: the same crop of Google's photogrammetry 3D tiles ` +
            '(measured geometry with its aerial photo texture; it carries the scan\'s own artefacts: blur, melted edges, baked-in shadows, smeared vehicles). ' +
            (g ? `Then ${g} search-grounded reference image${g > 1 ? 's' : ''} (G1${g > 1 ? ` to G${g}` : ''}): drawn by an image model from real photographs Google Search found of this surface; ` +
                'generated, not photographs, framing not exact; use them for what the real surface looks like (materials, colours, ornament, openings, distinctive features). Where they disagree, trust neither. ' : '') +
            `Images 1 to ${count} show the same crop, from exactly the reference's camera, with the surface at the centre of the crop treated in different ways; everything around it is identical. ` +
            (ctx.lit ? 'All share one computed sun and sky (cast shadows, ambient occlusion). ' : 'All share the same flat neutral light. ') +
            'The images are in no particular order and come from different methods.',
        closing: `Judge only the surface at the centre of the crop. Score every image 1-10 (10 best):\n` +
            '- realism: could the surface be a photograph of a real building or street (convincing materials, sharpness, surface detail, no smear, no visible repetition, no baked shadow that disagrees with the light);\n' +
            '- identity: would someone who knows this place recognise this surface (its layout of openings and bays, materials, colour, distinctive features as the references show them), whether or not finer detail is exact;\n' +
            '- errors: wrong or invented content, 10 = none (features that are not there, real features erased or moved, stretched, doubled or repeated textures, holes).\n' +
            'Do not penalise a treatment for leaving out the scan\'s own artefacts. ' +
            `Reply with JSON only: {"images":[{"image":1,"realism":n,"identity":n,"errors":n,"note":"at most 20 words"}, ...]} with one entry for each of images 1 to ${count}.`
    };
}

export function parseSurfaceReply(text: string, count: number): { scores: SurfaceScores[]; problems: string[] } {
    let j: { images?: Array<Record<string, unknown>> };
    try {
        const s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
        j = JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    } catch {
        return { scores: [], problems: ['the reply is not JSON'] };
    }
    const scores: SurfaceScores[] = [], problems: string[] = [];
    for (let k = 1; k <= count; k++) {
        const r = j.images?.find(x => Number(x.image) === k);
        if (!r) { problems.push(`no entry for image ${k}`); continue; }
        const sc = {} as Record<SurfaceCriterion, number>;
        let ok = true;
        for (const c of SURFACE_CRITERIA) {
            const v = Number(r[c]);
            if (!Number.isFinite(v) || v < 1 || v > 10) { problems.push(`image ${k}: ${c} is ${String(r[c])}`); ok = false; break; }
            sc[c] = v;
        }
        if (ok) scores[k - 1] = { ...sc, note: typeof r.note === 'string' ? r.note : '' };
    }
    return { scores, problems };
}

const b64 = (bytes: Uint8Array, mimeType: string) => ({ inlineData: { mimeType, data: Buffer.from(bytes).toString('base64') } });

/** The judgement of one surface in one view, `repeats` times, the arms shuffled per repeat (seeded) and mapped back. */
export async function judgeSurfaceView(input: {
    client: JudgeClient; place: string; view: string; reference: Uint8Array; renders: Array<{ armId: string; png: Uint8Array }>;
    grounded?: Array<{ bytes: Uint8Array; mimeType: string }>; lit?: boolean; repeats?: number; seed: string; thinkingBudget?: number; temperature?: number;
}): Promise<SurfaceJudgeRun[]> {
    const runs: SurfaceJudgeRun[] = [];
    const g = input.grounded ?? [];
    for (let r = 0; r < (input.repeats ?? 3); r++) {
        const order = seededShuffle(input.renders, `${input.seed}#${r}`);
        const { preamble, closing } = surfaceJudgePrompt(input.place, order.length, { lit: input.lit, grounded: g.length });
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: preamble }, { text: 'Image 0: the reference (photogrammetry tiles).' }, b64(input.reference, 'image/png')];
        g.forEach((img, k) => parts.push({ text: `Image G${k + 1}: a search-grounded reference (generated; not scored).` }, b64(img.bytes, img.mimeType)));
        order.forEach((o, k) => parts.push({ text: `Image ${k + 1}: a treatment.` }, b64(o.png, 'image/png')));
        parts.push({ text: closing });
        let parsed: ReturnType<typeof parseSurfaceReply> | undefined, model = '';
        for (let attempt = 0; attempt < 2; attempt++) {
            const res = await input.client.generate({
                contents: [{ role: 'user', parts: attempt ? [...parts, { text: `(Attempt ${attempt + 1}: reply with the JSON object only.)` }] : parts }],
                config: { responseMimeType: 'application/json', temperature: input.temperature ?? 1 }
            }, { stage: 'surface-arm-judge', thinkingBudget: input.thinkingBudget ?? 16_384 });
            model = res.model;
            parsed = parseSurfaceReply((res.response.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join(''), order.length);
            if (!parsed.problems.length) { res.remember?.(); break; }
        }
        if (!parsed || parsed.problems.length) throw new Error(`surface arm judge: the reply could not be read (${parsed?.problems.slice(0, 3).join('; ')})`);
        const scores: Record<string, SurfaceScores> = {};
        order.forEach((o, k) => { scores[o.armId] = parsed!.scores[k]; });
        runs.push({ view: input.view, order: order.map(o => o.armId), scores, model });
    }
    return runs;
}

/** Each arm's mean and spread per criterion over all runs (every view and repeat pooled). */
export function aggregateSurfaceRuns(runs: SurfaceJudgeRun[], armIds: string[]): Record<string, Record<SurfaceCriterion, Stat>> {
    return Object.fromEntries(armIds.map(a => [a, Object.fromEntries(SURFACE_CRITERIA.map(c => [c, stat(runs.map(r => r.scores[a]?.[c]).filter((x): x is number => typeof x === 'number'))]))])) as Record<string, Record<SurfaceCriterion, Stat>>;
}

// =============================================================================
// The rule
// =============================================================================

export const SURFACE_SELECTION_RULE = {
    /** The least realism rise (mean, 1-10 scale) that counts. */
    minRealismRise: 0.5,
    /** The rise must also be this many standard errors of the difference. */
    seMultiple: 2,
    /** Identity may not fall by more than this (mean). */
    identityTolerance: 0.25,
    /** Errors (10 = none) may not fall by more than this (mean): an arm that invents or erases content is refused. */
    errorsTolerance: 0.5
};

export interface ArmVerdict { arm: string; accepted: boolean; dRealism: number; seRealism: number; dIdentity: number; dErrors: number; reason: string }
export interface SurfaceDecision { chosen: string; base: string; verdicts: ArmVerdict[]; reason: string }

const r2 = (x: number) => Math.round(x * 100) / 100;
const seDiff = (a: Stat, b: Stat) => Math.sqrt((a.sd ** 2) / Math.max(1, a.n - 1) + (b.sd ** 2) / Math.max(1, b.n - 1));

/**
 * Keeps the base arm unless another raises realism clearly while identity does not fall and errors do not rise (see the
 * file comment); of those that pass, the highest realism, then identity. Every arm's verdict says why.
 */
export function decideSurfaceArm(stats: Record<string, Record<SurfaceCriterion, Stat>>, base: string, rule = SURFACE_SELECTION_RULE): SurfaceDecision {
    const b = stats[base];
    if (!b || !b.realism.n) return { chosen: base, base, verdicts: [], reason: `the base arm ${base} was not judged; kept by default` };
    const verdicts: ArmVerdict[] = [];
    for (const [arm, s] of Object.entries(stats)) {
        if (arm === base) continue;
        if (!s.realism.n) { verdicts.push({ arm, accepted: false, dRealism: NaN, seRealism: NaN, dIdentity: NaN, dErrors: NaN, reason: 'not judged' }); continue; }
        const dR = s.realism.mean - b.realism.mean, se = seDiff(s.realism, b.realism);
        const dI = s.identity.mean - b.identity.mean, dE = s.errors.mean - b.errors.mean;
        const why: string[] = [];
        if (dR < rule.minRealismRise) why.push(`realism ${dR >= 0 ? 'rose only' : 'fell'} ${r2(Math.abs(dR))} (needs +${rule.minRealismRise})`);
        else if (dR < rule.seMultiple * se) why.push(`realism rose ${r2(dR)}, within the judge's noise (${rule.seMultiple} x se ${r2(se)})`);
        if (dI < -rule.identityTolerance) why.push(`identity fell ${r2(-dI)}`);
        if (dE < -rule.errorsTolerance) why.push(`errors rose (score fell ${r2(-dE)}): invented or erased content`);
        verdicts.push({ arm, accepted: !why.length, dRealism: r2(dR), seRealism: r2(se), dIdentity: r2(dI), dErrors: r2(dE), reason: why.length ? why.join('; ') : `realism +${r2(dR)} (se ${r2(se)}), identity ${dI >= 0 ? '+' : ''}${r2(dI)}, errors ${dE >= 0 ? '+' : ''}${r2(dE)}` });
    }
    const passed = verdicts.filter(v => v.accepted).sort((x, y) => (stats[y.arm].realism.mean - stats[x.arm].realism.mean) || (stats[y.arm].identity.mean - stats[x.arm].identity.mean));
    if (passed.length) return { chosen: passed[0].arm, base, verdicts, reason: `${passed[0].arm}: ${passed[0].reason}` };
    return { chosen: base, base, verdicts, reason: verdicts.length ? `kept ${base}: ${verdicts.map(v => `${v.arm} ${v.reason}`).join('; ')}` : `kept ${base}: no other arm` };
}
