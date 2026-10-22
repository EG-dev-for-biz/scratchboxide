/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The replica scorecard: how close is a procedural rebuild of a district to Google's photogrammetry tiles of it?
 *
 * The reference is the raw photo-textured tile mesh; the arms are whatever GLB layers a procedural build produced (and the
 * same geometry in clay). A fixed set of cameras (data, `ReplicaCameraSet`: street level, oblique aerial, facade close-ups,
 * all in the tile frame) is rendered for every arm by photo-match-eval.ts's software rasterizer: same pose, resolution,
 * neutral light and grey background for every arm, so only the build separates two renders. Per view:
 *  - the structure mask: the reference's own pixels that show raised structure (a triangle whose plan cell stands at least
 *    `minHeightM` over the measured terrain, the terrain and tops from the caller's ground model). Pavements, roads, water
 *    and parked things under the threshold are left out; walls, roofs, bridges are in;
 *  - inside that mask, photo-match-eval's secondary numbers against the reference render: luminance SSIM, structural-edge
 *    chamfer and the CIEDE2000 of the blurred colours, plus how much of the mask the arm covers;
 *  - a blind vision judgement (the reference first, the arm renders shuffled and unlabelled, `repeats` times): shape,
 *    materials, detail, errors, overall (1-10) as a replica of the reference, and the most visible defects of each render;
 *  - a believability judgement of each render alone, the reference included and nothing else shown: could this be a
 *    photograph of a real city (1-10), and what gives it away.
 * Nothing here knows a place or a pipeline; the cameras and the arms are the caller's.
 */

import type { PinholeCamera } from '../../../common/spatial/texture-pass-contracts';
import type { Vec3 } from '../../../common/spatial/staged-location-contracts';
import { selectTriangles, type TileTriangles } from './tile-texture-transfer';
import { coverageMask, renderTriangles, seededShuffle, type ArmRender, type JudgeClient } from './photo-match-eval';

export const REPLICA_CAMERAS_SCHEMA = 'scratchbox.replica-cameras/1';

/** One fixed view. `kind` is a free label (street, aerial, facade, ...); nothing branches on it. */
export interface ReplicaView {
    id: string;
    kind: string;
    label: string;
    /** Tile frame (x east, y up, z south), metres. */
    eye: Vec3;
    target: Vec3;
    hfovDeg: number;
    note?: string;
}

export interface ReplicaCameraSet {
    schema: typeof REPLICA_CAMERAS_SCHEMA;
    place: string;
    frame: { description: string; geoAnchor: { lat: number; lng: number }; originEllipsoidalHeightM: number };
    width: number;
    height: number;
    views: ReplicaView[];
}

/** Checks a camera set read from JSON; throws with every problem found. */
export function validateCameraSet(j: unknown): ReplicaCameraSet {
    const s = j as ReplicaCameraSet;
    const problems: string[] = [];
    const vec = (v: unknown) => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === 'number' && Number.isFinite(x));
    if (s?.schema !== REPLICA_CAMERAS_SCHEMA) problems.push(`schema is ${String(s?.schema)}, expected ${REPLICA_CAMERAS_SCHEMA}`);
    if (!(s?.width >= 16 && s?.height >= 16)) problems.push('width and height must be at least 16 px');
    if (!Array.isArray(s?.views) || !s.views.length) problems.push('no views');
    const ids = new Set<string>();
    for (const v of s?.views ?? []) {
        if (!v.id || ids.has(v.id)) problems.push(`view id ${String(v.id)} is missing or repeated`);
        ids.add(v.id);
        if (!vec(v.eye) || !vec(v.target)) problems.push(`${v.id}: eye and target must be three finite numbers`);
        else if (Math.hypot(v.target[0] - v.eye[0], v.target[1] - v.eye[1], v.target[2] - v.eye[2]) < 0.5) problems.push(`${v.id}: the target is within 0.5 m of the eye`);
        else if (Math.hypot(v.target[0] - v.eye[0], v.target[2] - v.eye[2]) < 1e-3) problems.push(`${v.id}: a camera looking straight up or down has no defined right axis`);
        if (!(v.hfovDeg > 5 && v.hfovDeg < 150)) problems.push(`${v.id}: hfovDeg ${v.hfovDeg} is outside 5..150`);
    }
    if (problems.length) throw new Error(`replica cameras: ${problems.join('; ')}`);
    return s;
}

/** The pinhole camera of a view (square pixels, principal point at the centre, image y down, world up +y). */
export function replicaCamera(v: Pick<ReplicaView, 'eye' | 'target' | 'hfovDeg'>, width: number, height: number): PinholeCamera {
    const d = [v.target[0] - v.eye[0], v.target[1] - v.eye[1], v.target[2] - v.eye[2]];
    const dl = Math.hypot(d[0], d[1], d[2]);
    const fwd: Vec3 = [d[0] / dl, d[1] / dl, d[2] / dl];
    // right = fwd x up(0, 1, 0)
    const r = [-fwd[2], 0, fwd[0]], rl = Math.hypot(r[0], r[2]);
    const right: Vec3 = [r[0] / rl, 0, r[2] / rl];
    const up: Vec3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const fx = (width / 2) / Math.tan((v.hfovDeg * Math.PI) / 360);
    return { eye: [...v.eye] as Vec3, right, up, fwd, fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

// =============================================================================
// The structure mask
// =============================================================================

/** The plan grids a structure test reads (StreetViewSurveyPlanner's GroundModel has this shape). */
export interface PlanGrids { cellMeters: number; x0: number; z0: number; nx: number; nz: number; top: Float32Array; ground: Float32Array }

export const STRUCTURE_PARAMS = {
    /** A plan cell is structure when its top stands at least this over the terrain (m). */
    minHeightM: 3,
    /** Cells of dilation, so a wall's foot (whose own cell may be the street's) still counts. */
    dilateCells: 1,
    /** A triangle whose centroid is lower than this over the terrain is street, even in a structure cell (m). */
    footM: 0.5
};

/** Per triangle, 1 when it belongs to raised structure (STRUCTURE_PARAMS), from its centroid and the plan grids. */
export function classifyStructure(tris: TileTriangles, g: PlanGrids, P = STRUCTURE_PARAMS): Uint8Array {
    const { nx, nz } = g;
    const raised = new Uint8Array(nx * nz);
    for (let c = 0; c < nx * nz; c++) if (g.top[c] === g.top[c] && g.ground[c] === g.ground[c] && g.top[c] - g.ground[c] >= P.minHeightM) raised[c] = 1;
    const near = new Uint8Array(nx * nz);
    const r = P.dilateCells;
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
        if (!raised[k * nx + i]) continue;
        for (let dk = -r; dk <= r; dk++) for (let di = -r; di <= r; di++) {
            const kk = k + dk, ii = i + di;
            if (kk >= 0 && kk < nz && ii >= 0 && ii < nx) near[kk * nx + ii] = 1;
        }
    }
    const n = tris.texture.length, out = new Uint8Array(n), P9 = tris.positions;
    for (let t = 0; t < n; t++) {
        const x = (P9[t * 9] + P9[t * 9 + 3] + P9[t * 9 + 6]) / 3, y = (P9[t * 9 + 1] + P9[t * 9 + 4] + P9[t * 9 + 7]) / 3, z = (P9[t * 9 + 2] + P9[t * 9 + 5] + P9[t * 9 + 8]) / 3;
        const i = Math.floor((x - g.x0) / g.cellMeters), k = Math.floor((z - g.z0) / g.cellMeters);
        if (i < 0 || k < 0 || i >= nx || k >= nz) continue;
        const c = k * nx + i, gy = g.ground[c];
        if (near[c] && gy === gy && y - gy >= P.footM) out[t] = 1;
    }
    return out;
}

/** The reference split by `classifyStructure`: the raised structure and everything else (textures shared). */
export function splitStructure(tris: TileTriangles, flags: Uint8Array): { structure: TileTriangles; rest: TileTriangles } {
    const inv = new Uint8Array(flags.length);
    for (let i = 0; i < flags.length; i++) inv[i] = flags[i] ? 0 : 1;
    return { structure: selectTriangles(tris, flags), rest: selectTriangles(tris, inv) };
}

/** The view's structure mask: pixels where the reference's front-most surface is structure (at least half the samples). */
export function structureMask(split: { structure: TileTriangles; rest: TileTriangles }, camera: PinholeCamera): Uint8Array {
    return coverageMask(renderTriangles([split.structure], camera, { context: [split.rest], supersample: 2 }));
}

/** The mask drawn over a render (structure tinted, the rest darkened), for the contact sheet. */
export function maskOverlay(render: { width: number; height: number; rgba: Uint8Array }, mask: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
    const rgba = new Uint8Array(render.rgba.length);
    for (let i = 0; i < mask.length; i++) {
        const o = i * 4;
        if (mask[i]) { rgba[o] = Math.round(render.rgba[o] * 0.5 + 127); rgba[o + 1] = Math.round(render.rgba[o + 1] * 0.5 + 60); rgba[o + 2] = Math.round(render.rgba[o + 2] * 0.5); }
        else { rgba[o] = render.rgba[o] >> 2; rgba[o + 1] = render.rgba[o + 1] >> 2; rgba[o + 2] = render.rgba[o + 2] >> 2; }
        rgba[o + 3] = 255;
    }
    return { width: render.width, height: render.height, rgba };
}

// =============================================================================
// Judging
// =============================================================================

export const REPLICA_CRITERIA = ['shape', 'materials', 'detail', 'errors', 'overall'] as const;
/** With search-grounded references beside the tiles, two more: realism (could it be a photograph) and identity (is it this place). */
export const REPLICA_GROUNDED_CRITERIA = [...REPLICA_CRITERIA, 'realism', 'identity'] as const;
export type ReplicaCriterion = typeof REPLICA_GROUNDED_CRITERIA[number];
export interface ReplicaDefect { what: string; where: string; severity: number }
export type ReplicaScores = Record<typeof REPLICA_CRITERIA[number], number> & Partial<Record<'realism' | 'identity', number>> & { defects: ReplicaDefect[]; note: string };

/**
 * How the renders of a judgement were made and what the judge is shown beside the tiles.
 * `lit`: the renders carry the lit mode's sun, cast shadows and sky occlusion (photo-match-eval PHOTO_MATCH_LIT) instead of
 * the flat headlight. `grounded`: that many search-grounded reference images of the real place (search-grounded-reference.ts)
 * follow the tiles: generated, not photographs, roughly from the same viewpoint; the judge reads the real place's materials,
 * detail and distinctive features from them, and scores realism and identity too.
 */
export interface ReplicaJudgeContext { lit?: boolean; grounded?: number }

const lightSentence = (lit?: boolean) => lit
    ? 'all lit by the same sun and sky (one fixed sun direction, cast shadows and ambient occlusion computed from each render\'s own geometry) on the same flat grey background (there is no sky in any image). '
    : 'all with the same flat neutral light on the same flat grey background (there is no sky in any image). ';
export interface BelievabilityScore { believability: number; defects: ReplicaDefect[]; note: string }

export function replicaJudgePrompt(place: string, count: number, ctx: ReplicaJudgeContext = {}): { preamble: string; closing: string } {
    const g = ctx.grounded ?? 0;
    return {
        preamble: `You are judging procedural 3D rebuilds of a real city district: ${place}. Image 0 is the reference: a render of Google's photogrammetry 3D tiles of the district ` +
            '(measured geometry with its aerial photo texture; it carries the scan\'s own artefacts: melted vehicles and trees, blobby street furniture, baked-in shadows, smeared undersides). ' +
            `Images 1 to ${count} are renders of rebuilds of the same district made from scratch, each from exactly the reference's camera, field of view and resolution, ` +
            lightSentence(ctx.lit) + 'Some renders may be untextured grey clay. ' +
            (g ? `After the reference come ${g} search-grounded reference image${g > 1 ? 's' : ''} (labelled G1${g > 1 ? ` to G${g}` : ''}): drawn by an image model from real photographs Google Search found of the same place, ` +
                'roughly from the same viewpoint. They are generated, not photographs, and their framing is not exact: use them for what the real place looks like (materials, colours, ornament, ' +
                'window rhythm, distinctive features), use the tiles (image 0) for the layout and the camera. Where they disagree with each other, trust neither. ' : '') +
            'The renders are in no particular order and come from different methods.',
        closing: `Is each render a believable replica of the reference? Score every render 1-10 (10 best) against the reference on ${g ? 'seven' : 'five'} criteria:\n` +
            '- shape: massing, silhouettes, rooflines, setbacks, openings, the street and ground levels and the structures (bridges, canopies, towers, domes) in the right places and sizes;\n' +
            '- materials: the facade, roof and ground materials and their colours (an untextured clay render scores 1);\n' +
            '- detail: windows, cornices, ornament, mullions, kerbs, markings at a believable density and sharpness (finer and cleaner than the scan is better, not worse);\n' +
            '- errors: wrong or invented content, 10 = none (missing buildings or structures, floating or sunken parts, melted or broken geometry, stretched, smeared, repeated or doubled textures, baked shadows, holes);\n' +
            '- overall: how believably the render replicates the district in the reference.\n' +
            (g ? '- realism: could the render be a photograph of a real city (convincing materials, sharpness, surface detail, light behaviour), whatever place it shows;\n' +
                '- identity: would someone who knows this place recognise it (massing, window rhythm, materials, colour, distinctive features as the grounded references show them).\n' : '') +
            'Do not penalise a rebuild for leaving out the scan\'s own artefacts (melted cars, blob trees, baked shadows); do penalise real structure that is missing or wrong.\n' +
            'For every render also list its most visible defects, most severe first (at most 6), each with what is wrong, where in the image (e.g. "left foreground", "centre skyline") and a severity from 0 (cosmetic) to 1 (breaks the replica).\n' +
            `Reply with JSON only: {"renders":[{"image":1,"shape":n,"materials":n,"detail":n,"errors":n,"overall":n,${g ? '"realism":n,"identity":n,' : ''}"defects":[{"what":"...","where":"...","severity":0.0}],"note":"at most 25 words on what decides it"}, ...]} with one entry for each of images 1 to ${count}.`
    };
}

export function believabilityPrompt(lit?: boolean): string {
    return (lit
        ? 'This image is a render of a 3D model of a city, lit by a computed sun and sky (cast shadows, ambient occlusion) on a flat grey background where the sky would be. ' +
            'Ignore the grey background (every render has it). Could the city in this image be a photograph of a real city? '
        : 'This image is a render of a 3D model of a city, drawn with a flat neutral light on a flat grey background where the sky would be. ' +
            'Ignore the grey background and the flat, shadowless light (every render has them). Could the city in this image be a photograph of a real city? ') +
        'Score its believability 1-10 (10 = indistinguishable from a photograph of a real place apart from the sky and light; 1 = obviously synthetic or broken), ' +
        'judging geometry, materials, surface detail, sharpness and anything melted, smeared, repeated, floating, missing or invented. ' +
        'List what most gives it away, most severe first (at most 6), each with what, where in the image, and a severity 0..1. ' +
        'Reply with JSON only: {"believability":n,"defects":[{"what":"...","where":"...","severity":0.0}],"note":"at most 25 words"}';
}

function readJson(text: string): Record<string, unknown> | undefined {
    try {
        const s = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '');
        return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1));
    } catch {
        return undefined;
    }
}

function readDefects(v: unknown): ReplicaDefect[] {
    if (!Array.isArray(v)) return [];
    return v.filter(d => d && typeof d === 'object' && typeof (d as ReplicaDefect).what === 'string').slice(0, 6).map(d => {
        const s = Number((d as ReplicaDefect).severity);
        return { what: String((d as ReplicaDefect).what), where: typeof (d as ReplicaDefect).where === 'string' ? (d as ReplicaDefect).where : '', severity: Number.isFinite(s) ? Math.max(0, Math.min(1, s)) : 0.5 };
    });
}

export function parseReplicaReply(text: string, count: number, criteria: readonly ReplicaCriterion[] = REPLICA_CRITERIA): { scores: ReplicaScores[]; problems: string[] } {
    const j = readJson(text) as { renders?: Array<Record<string, unknown>> } | undefined;
    if (!j) return { scores: [], problems: ['the reply is not JSON'] };
    const problems: string[] = [], scores: ReplicaScores[] = [];
    for (let k = 1; k <= count; k++) {
        const r = j.renders?.find(x => Number(x.image) === k);
        if (!r) { problems.push(`no entry for image ${k}`); continue; }
        const sc = {} as Record<ReplicaCriterion, number>;
        let ok = true;
        for (const c of criteria) {
            const v = Number(r[c]);
            if (!Number.isFinite(v) || v < 1 || v > 10) { problems.push(`image ${k}: ${c} is ${String(r[c])}`); ok = false; break; }
            sc[c] = v;
        }
        if (ok) scores[k - 1] = { ...(sc as Record<typeof REPLICA_CRITERIA[number], number>), defects: readDefects(r.defects), note: typeof r.note === 'string' ? r.note : '' };
    }
    return { scores, problems };
}

export function parseBelievabilityReply(text: string): { score?: BelievabilityScore; problems: string[] } {
    const j = readJson(text);
    if (!j) return { problems: ['the reply is not JSON'] };
    const b = Number(j.believability);
    if (!Number.isFinite(b) || b < 1 || b > 10) return { problems: [`believability is ${String(j.believability)}`] };
    return { score: { believability: b, defects: readDefects(j.defects), note: typeof j.note === 'string' ? j.note : '' }, problems: [] };
}

const pngPart = (png: Uint8Array) => ({ inlineData: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } });

async function askJson<T>(client: JudgeClient, parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>, stage: string,
    parse: (text: string) => { value?: T; problems: string[] }, opts: { thinkingBudget?: number; temperature?: number }): Promise<{ value: T; model: string }> {
    let last: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
        const res = await client.generate({
            contents: [{ role: 'user', parts: attempt ? [...parts, { text: `(Attempt ${attempt + 1}: reply with the JSON object only.)` }] : parts }],
            config: { responseMimeType: 'application/json', temperature: opts.temperature ?? 1 }
        }, { stage, thinkingBudget: opts.thinkingBudget ?? 16_384 });
        const text = (res.response.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('');
        const p = parse(text);
        if (p.value !== undefined && !p.problems.length) { res.remember?.(); return { value: p.value, model: res.model }; }
        last = p.problems;
    }
    throw new Error(`replica judge (${stage}): the reply could not be read (${last.slice(0, 3).join('; ')})`);
}

export interface ReplicaJudgeRun { order: string[]; scores: Record<string, ReplicaScores>; model: string }

/**
 * The replica judgement of one view, `repeats` times: the reference render, then the arm renders shuffled per repeat
 * (seeded), unlabelled; scores mapped back to the arm ids.
 */
export async function judgeReplicaView(input: {
    client: JudgeClient; place: string; reference: Uint8Array; renders: Array<{ armId: string; png: Uint8Array }>; repeats?: number; seed: string; thinkingBudget?: number; temperature?: number;
    /** The renders are lit (PHOTO_MATCH_LIT) rather than headlit: the prompt says so. */
    lit?: boolean;
    /** Search-grounded reference images of the place (generated; shown after the tiles as G1..Gn; adds realism and identity). */
    grounded?: Array<{ bytes: Uint8Array; mimeType: string }>;
}): Promise<ReplicaJudgeRun[]> {
    const runs: ReplicaJudgeRun[] = [];
    const g = input.grounded ?? [];
    const criteria = g.length ? REPLICA_GROUNDED_CRITERIA : REPLICA_CRITERIA;
    for (let r = 0; r < (input.repeats ?? 2); r++) {
        const order = seededShuffle(input.renders, `${input.seed}#${r}`);
        const { preamble, closing } = replicaJudgePrompt(input.place, order.length, { lit: input.lit, grounded: g.length });
        const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: preamble }, { text: 'Image 0: the reference (photogrammetry tiles).' }, pngPart(input.reference)];
        g.forEach((img, k) => parts.push({ text: `Image G${k + 1}: a search-grounded reference (generated from photographs of the real place; not a render, not scored).` }, { inlineData: { mimeType: img.mimeType, data: Buffer.from(img.bytes).toString('base64') } }));
        order.forEach((o, k) => parts.push({ text: `Image ${k + 1}: a rebuild.` }, pngPart(o.png)));
        parts.push({ text: closing });
        const stage = g.length ? 'replica-judge-grounded' : 'replica-judge';
        const { value, model } = await askJson(input.client, parts, stage, t => { const p = parseReplicaReply(t, order.length, criteria); return { value: p.problems.length ? undefined : p.scores, problems: p.problems }; }, input);
        const scores: Record<string, ReplicaScores> = {};
        order.forEach((o, k) => { scores[o.armId] = value[k]; });
        runs.push({ order: order.map(o => o.armId), scores, model });
    }
    return runs;
}

/** The believability of one render alone (no reference shown), `repeats` times. */
export async function judgeBelievability(input: { client: JudgeClient; png: Uint8Array; repeats?: number; thinkingBudget?: number; temperature?: number; lit?: boolean }): Promise<Array<BelievabilityScore & { model: string }>> {
    const out: Array<BelievabilityScore & { model: string }> = [];
    for (let r = 0; r < (input.repeats ?? 2); r++) {
        const { value, model } = await askJson(input.client, [pngPart(input.png), { text: believabilityPrompt(input.lit) }], 'replica-believability', t => { const p = parseBelievabilityReply(t); return { value: p.score, problems: p.problems }; }, input);
        out.push({ ...value, model });
    }
    return out;
}

export interface Stat { mean: number; sd: number; n: number }
export function stat(values: number[]): Stat {
    const v = values.filter(Number.isFinite);
    if (!v.length) return { mean: NaN, sd: NaN, n: 0 };
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    const sd = Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length);
    return { mean: Math.round(mean * 100) / 100, sd: Math.round(sd * 100) / 100, n: v.length };
}

/** Each arm's mean and spread per criterion over the runs. */
export function aggregateReplicaRuns(runs: ReplicaJudgeRun[], armIds: string[]): Record<string, Record<ReplicaCriterion, Stat>> {
    const out: Record<string, Record<ReplicaCriterion, Stat>> = {};
    const grounded = runs.some(r => Object.values(r.scores).some(s => typeof s?.realism === 'number'));
    for (const a of armIds) {
        out[a] = {} as Record<ReplicaCriterion, Stat>;
        for (const c of grounded ? REPLICA_GROUNDED_CRITERIA : REPLICA_CRITERIA) out[a][c] = stat(runs.map(r => r.scores[a]?.[c]).filter((x): x is number => typeof x === 'number'));
    }
    return out;
}

/** A render's pixels as the DecodedImage the metrics take. */
export function asImage(r: ArmRender): { width: number; height: number; rgba: Uint8Array } {
    return { width: r.width, height: r.height, rgba: r.rgba };
}

// =============================================================================
// Comparing two scorecards
// =============================================================================

/** One judged block of a view as report.json stores it (the headlight block is the view itself; the lit block is `view.lit`). */
export interface JudgedBlock {
    replica?: { stats?: Record<string, Partial<Record<ReplicaCriterion, Stat>>> };
    believability?: Record<string, { stat?: Stat }>;
}

export interface ScoreDelta { baseline: Stat; current: Stat; delta: number; /** Standard error of the delta from both spreads. */ se: number; /** |delta| at least twice its standard error and at least 0.5. */ clear: boolean }

/**
 * Per view, per arm, the change of every judged criterion (and believability) from a baseline scorecard to the current one,
 * with the delta's standard error from both runs' spreads (population sd over n repeats). A delta is `clear` when it is at
 * least 0.5 and at least twice its standard error; anything less is within the judge's own noise.
 */
export function compareJudgedBlocks(baseline: Array<{ id: string } & JudgedBlock>, current: Array<{ id: string } & JudgedBlock>): Array<{ view: string; arm: string; criterion: string; d: ScoreDelta }> {
    const out: Array<{ view: string; arm: string; criterion: string; d: ScoreDelta }> = [];
    const delta = (b: Stat, c: Stat): ScoreDelta => {
        const se = Math.sqrt((b.sd ** 2) / Math.max(1, b.n - 1) + (c.sd ** 2) / Math.max(1, c.n - 1));
        const d = Math.round((c.mean - b.mean) * 100) / 100;
        return { baseline: b, current: c, delta: d, se: Math.round(se * 100) / 100, clear: Math.abs(d) >= 0.5 && Math.abs(d) >= 2 * se };
    };
    for (const cv of current) {
        const bv = baseline.find(v => v.id === cv.id);
        if (!bv) continue;
        for (const [arm, cs] of Object.entries(cv.replica?.stats ?? {})) {
            const bs = bv.replica?.stats?.[arm];
            if (!bs) continue;
            for (const c of REPLICA_GROUNDED_CRITERIA) {
                const b = bs[c], x = cs[c];
                if (b?.n && x?.n) out.push({ view: cv.id, arm, criterion: c, d: delta(b, x) });
            }
        }
        for (const [arm, cb] of Object.entries(cv.believability ?? {})) {
            const b = bv.believability?.[arm]?.stat, x = cb.stat;
            if (b?.n && x?.n) out.push({ view: cv.id, arm, criterion: 'believability', d: delta(b, x) });
        }
    }
    return out;
}

/** Words of the view a search-grounded reference is asked to show it from, read from the camera's geometry (no labels). */
export function groundedViewPhrase(v: Pick<ReplicaView, 'eye' | 'target' | 'hfovDeg'>, groundY?: number): string {
    const d = [v.target[0] - v.eye[0], v.target[1] - v.eye[1], v.target[2] - v.eye[2]];
    const horiz = Math.hypot(d[0], d[2]);
    const pitch = (Math.atan2(d[1], horiz) * 180) / Math.PI;
    // compass heading of the view: x east, z south
    const heading = ((Math.atan2(d[0], -d[2]) * 180) / Math.PI + 360) % 360;
    const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
    const dir = names[Math.round(heading / 45) % 8];
    const height = groundY === undefined ? undefined : v.eye[1] - groundY;
    const where = height === undefined ? '' : height < 3 ? 'at eye level from the ground, ' : `from about ${Math.round(height)} m above the ground, `;
    const tilt = Math.abs(pitch) < 4 ? 'looking level' : pitch < 0 ? `looking down about ${Math.round(-pitch)} degrees` : `looking up about ${Math.round(pitch)} degrees`;
    return `${where}facing ${dir} (heading ${Math.round(heading)} degrees), ${tilt}, with a horizontal field of view of about ${Math.round(v.hfovDeg)} degrees`;
}
