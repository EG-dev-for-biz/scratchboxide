/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline G: the isolated structure rebuilt procedurally from a survey of the photo tile, in pipeline E's grammar slot
 * (request.procedural, set for every isolated building unless the caller passes procedural false; or SCRATCHBOX_STAGED_GEOMETRY=g everywhere). E's massing stands as built (the vector footprint, its
 * walls on the facades the scan measures); G then
 *   0. groups the walls of a footprint that traces piers or bays into the facades they make (facades.ts), surveyed and read
 *      whole, what is read laid back onto the walls,
 *   1. places survey stations by the staged survey's own rules (stations.ts),
 *   2. path-traces them from the tile with metric depth and lays them onto metric wall plates (plates.ts),
 *   3. reads every well-seen plate as a facade program in metres (read.ts), checks each reading against its plate (check.ts)
 *      and reads a wall again when its reading does not fit, keeping the reading that fits better,
 *   4. builds it natively on the massing, with what stands on the roof built from the scan's measures (roof-objects.ts:
 *      skylights, bulkheads, penthouses, tanks as parts with their outlines, heights and fitted roof planes), (scratchbox_staged_massing.hpp: arched openings with their frames, mullions and
 *      transoms, sills and surrounds, swept bands, members) with no tile
 *      texture and no scanned residual, and
 *   5. paints each face from its own reading: wall colour, glazing in its openings, band and member colours on their
 *      footprints; a wall nobody read takes the read walls' median colour.
 * Everything read is photo-inferred, everything continued into unseen parts and every unread wall generated; the measured
 * massing stays vector-modelled. Measured on the Haughwout Building (2026-10-22): arched arcades on both street walls, piers
 * and colonnettes, bands and cornice, shop fronts to the pavement, about 44,000 vertices.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TEXTURE_LADDER_RUNGS } from '../../../../common/spatial/texture-pass-contracts';
import type { GeodeticAnchor } from '../../../../common/spatial/colmap-vector-reference-types';
import { HeadlessMeshSilhouetteRenderer } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import type { GroundModel } from '../../../spatial/StreetViewSurveyPlanner';
import type { VisionModelChain } from '../../../gemini/vision-model-chain';
import type { StructurePickResult } from '../extraction-sizing';
import type { FaceTexture, TexelSource } from '../pipeline-e/massing-glb';
import { massingSpecText, type FaceSweepItem, type Massing, type OpeningItem } from '../pipeline-e/massing-spec';
import { runMassing, type MassingFace, type MassingRun } from '../pipeline-e/native-massing';
import { writeMassingLayer } from '../pipeline-e/pipeline-e';
import type { InferenceOutcome, StepRecord } from '../pipeline-e/inference';
import { ENHANCE_CONCURRENCY, TEXTURE_PLATE_PROMPT_ID, type EnhanceWallRecord, type PlateModelClient } from '../pipeline-e/enhance';
import { visionFacadeCounter } from '../pipeline-e/plate-identity';
import { buildFacadeTexture, repeatFill } from '../facade-texture/facade-texture';
import type { EnhanceModelClient } from '../texture-enhance';
import { planStations } from './stations';
import { platePng, reliefPng, surveyPlates, type Plate } from './plates';
import { MIN_READ_COVERAGE, PIPELINE_G_READ_VERSION, programItems, readPlate, type FacadeProgram, type ProgramItems } from './read';
import { checkPlate, checkReading, type ReadingCheck } from './check';
import { groupFacades, layBack } from './facades';
import { roofObjects } from './roof-objects';

export const PIPELINE_G_VERSION = `pipeline-g/v3+${PIPELINE_G_READ_VERSION}`;
/** Native build parameters: the massing only, nothing baked from the tile, no scanned residual. */
export const G_BUILD_PARAMS = { bake: 0, residual: 0, sections: 0, topdown: 0 } as const;
/** Plates read at once. */
export const READ_POOL = 4;

/** Pipeline G for this request: asked for (procedural), or SCRATCHBOX_STAGED_GEOMETRY=g. */
export function stagedPipelineG(request: { procedural?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
    return request.procedural === true || (env.SCRATCHBOX_STAGED_GEOMETRY ?? '').trim().toLowerCase() === 'g';
}

const rung = (name: (typeof TEXTURE_LADDER_RUNGS)[number]) => TEXTURE_LADDER_RUNGS.indexOf(name);
/** Texel sources of G's paint (indices into the legend). */
export const G_SRC = { read: 0, continued: 1, enhanced: 2 } as const;
export function gLegend(): TexelSource[] {
    return [
        { source: 'pipeline-g-read', label: 'photo-inferred', method: 'pipeline G: a flat colour the vision model read off the survey plate of this wall (station renders of the photo tile laid onto the wall in metres), painted on the wall, its openings, bands and members', rung: rung('generated tileable PBR'), weight: 0.3 },
        { source: 'pipeline-g-continued', label: 'generated', method: "pipeline G: a part the survey did not see (an opening or member the reading continued from the wall's own repeats, or a wall nobody read, given the read walls' median colour)", rung: rung('generated tileable PBR'), weight: 0.15 },
        { source: 'pipeline-g-enhanced', label: 'generated', method: `pipeline G: AI-enhanced from the survey plate of this wall by the facade texture builder (${TEXTURE_PLATE_PROMPT_ID}), kept through its identity gate and quality score, what the score faulted redrawn by generative infill`, rung: rung('generated tileable PBR'), weight: 0.25 }
    ];
}

export interface PipelineGInput {
    massing: Massing;
    /** Pipeline E's native run of the massing: its walls are the faces surveyed. */
    run: MassingRun;
    /** The photo tile the stations are rendered from (devegetated where the strip ran). */
    tilePath: string;
    dir: string;
    stage: string;
    stageKey: string;
    chain: Pick<VisionModelChain<string>, 'generate'>;
    place: string;
    structure: Pick<StructurePickResult, 'cells' | 'groundY' | 'centroid'>;
    ground: GroundModel;
    anchor: GeodeticAnchor;
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
    /** The facade texture builder's image model (absent: the walls keep their painted colours). */
    enhance?: { client: PlateModelClient; models: string[]; cacheDir?: string;
        /** Generative infill of what the quality score faults (a survey plate is worse than its redraw: never reverted to). */
        infill?: { client: EnhanceModelClient; models: string[] };
        /** The models for a wall with unseen areas (the facade texture builder's unseenModels). */
        unseenModels?: string[] };
}

export interface PipelineGOutcome extends InferenceOutcome {
    plates: Array<{ face: string; coverage: number; read: boolean; model?: string; notes?: string; counts?: ProgramItems['counts']; check?: ReadingCheck; reread?: 'first' | 'second' }>;
    stations: { kept: number; dropped: number; candidates: number; skipped: Array<{ face: string; reason: string }> };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

/** Whether (s, t) is inside an opening's outline (the rectangle to its springing line and its arch above). */
export function inOpening(o: Pick<OpeningItem, 's0' | 's1' | 't0' | 't1' | 'archRiseM'>, s: number, t: number): boolean {
    if (s < o.s0 || s > o.s1 || t < o.t0 || t > o.t1) return false;
    const half = (o.s1 - o.s0) / 2, rise = Math.min(o.archRiseM ?? 0, half, 0.95 * (o.t1 - o.t0));
    if (rise < 0.01 || t <= o.t1 - rise) return true;
    const r = (half * half + rise * rise) / (2 * rise), cx = (o.s0 + o.s1) / 2, cy = o.t1 - r;
    return (s - cx) ** 2 + (t - cy) ** 2 <= r * r;
}

/**
 * Whether (s, t) lies on an opening's divided glazing (OpeningItem panes): within frameM of its outline, or on one of its
 * evenly spaced mullions or transoms (scratchbox_staged_massing.hpp emitPanes lays them the same way).
 */
export function onPaneBar(o: OpeningItem, s: number, t: number): boolean {
    const p = o.panes;
    if (!p || !inOpening(o, s, t)) return false;
    const fw = p.frameM;
    if (fw > 0 && !inOpening({ s0: o.s0 + fw, s1: o.s1 - fw, t0: o.t0 + fw, t1: o.t1 - fw, archRiseM: Math.max(0, (o.archRiseM ?? 0) - fw) }, s, t)) return true;
    const half = p.barM / 2;
    for (let k = 1; k < p.cols; k++) if (Math.abs(s - (o.s0 + ((o.s1 - o.s0) * k) / p.cols)) <= half) return true;
    for (let k = 1; k < p.rows; k++) if (Math.abs(t - (o.t0 + ((o.t1 - o.t0) * k) / p.rows)) <= half) return true;
    return false;
}

/** The (s, t) footprint of a face sweep on its face: [s0, s1, t0, t1] per placement. */
export function sweepFootprints(w: FaceSweepItem): Array<[number, number, number, number]> {
    // the whole profile's span: its ends sit on the face at offset 0 and it stands proud between them
    const cs = w.profile.map(([, c]) => c);
    if (cs.length < 2 || !w.profile.some(([o]) => o > 0.005)) return [];
    const lo = Math.min(...cs), hi = Math.max(...cs);
    return w.placements.map(([a0, a1, dc]) => (w.axis === 0 ? [a0, a1, dc + lo, dc + hi] : [dc + lo, dc + hi, a0, a1]) as [number, number, number, number]);
}

/** Paint resolution, metres per texel, and the largest raster side (a larger face is painted coarser). */
export const PAINT_PIXEL_M = 0.05;
export const PAINT_MAX_SIDE = 2048;

/**
 * Gives a face built without the tile bake (G_BUILD_PARAMS: no ortho) its own raster frame over its (s, t) extent, the
 * frame the layer writer maps its vertices through. A face that has one (a baked build) keeps it.
 */
export function ensurePaintFrame(f: MassingFace): void {
    if (f.width > 0 && f.height > 0 && f.pixel > 0) return;
    if (!(f.sMax > f.sMin) || !(f.tMax > f.tMin)) return;
    const pixel = Math.max(PAINT_PIXEL_M, (f.sMax - f.sMin) / PAINT_MAX_SIDE, (f.tMax - f.tMin) / PAINT_MAX_SIDE);
    f.pixel = pixel;
    f.orthoSMin = f.sMin;
    f.orthoTMax = f.tMax;
    f.width = Math.max(1, Math.ceil((f.sMax - f.sMin) / pixel));
    f.height = Math.max(1, Math.ceil((f.tMax - f.tMin) / pixel));
}

/** The paint: per face of the built run, its raster in the face's ortho frame (given one when it was built without). */
export function paintFaces(faces: MassingFace[], items: Map<string, ProgramItems>, fallback: [number, number, number]): Map<number, FaceTexture> {
    const textures = new Map<number, FaceTexture>();
    for (const f of faces) {
        if (f.kind === 'base') continue;
        ensurePaintFrame(f);
        if (!f.width || !f.height) continue;
        const own = items.get(f.key) ?? [...items.entries()].find(([k]) => f.key.startsWith(k + ':'))?.[1];
        const wallC = own?.wallColour ?? (f.kind === 'roof' ? fallback.map(c => Math.round(c * 0.6)) as [number, number, number] : fallback);
        const wallSrc = own ? G_SRC.read : G_SRC.continued;
        const rgba = new Uint8Array(f.width * f.height * 4), source = new Uint8Array(f.width * f.height).fill(wallSrc);
        for (let i = 0; i < f.width * f.height; i++) rgba.set([wallC[0], wallC[1], wallC[2], 255], i * 4);
        if (own) {
            const put = (s0: number, s1: number, t0: number, t1: number, c: [number, number, number], src: number, inside?: (s: number, t: number) => boolean) => {
                const x0 = Math.max(0, Math.floor((s0 - f.orthoSMin) / f.pixel)), x1 = Math.min(f.width - 1, Math.ceil((s1 - f.orthoSMin) / f.pixel));
                const y0 = Math.max(0, Math.floor((f.orthoTMax - t1) / f.pixel)), y1 = Math.min(f.height - 1, Math.ceil((f.orthoTMax - t0) / f.pixel));
                for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
                    const s = f.orthoSMin + (x + 0.5) * f.pixel, t = f.orthoTMax - (y + 0.5) * f.pixel;
                    if (inside && !inside(s, t)) continue;
                    rgba.set([c[0], c[1], c[2], 255], (y * f.width + x) * 4);
                    source[y * f.width + x] = src;
                }
            };
            for (const w of own.faceSweeps) for (const [s0, s1, t0, t1] of sweepFootprints(w)) put(s0, s1, t0, t1, own.colours.get(w.id) ?? wallC, w.provenance === 'generated' ? G_SRC.continued : G_SRC.read);
            for (const o of own.openings) put(o.s0, o.s1, o.t0, o.t1, own.colours.get(o.id) ?? [40, 44, 50], o.provenance === 'generated' ? G_SRC.continued : G_SRC.read, (s, t) => inOpening(o, s, t));
            // divided glazing: the frame and bars in their own colour (the native build stands them proud of the glass there)
            for (const o of own.openings) {
                if (!o.panes) continue;
                const fc = own.colours.get(`${o.id}:frame`) ?? [30, 30, 32];
                put(o.s0, o.s1, o.t0, o.t1, fc, o.provenance === 'generated' ? G_SRC.continued : G_SRC.read, (s, t) => onPaneBar(o, s, t));
            }
        }
        textures.set(f.index, { width: f.width, height: f.height, rgba, source });
    }
    return textures;
}

/**
 * The band of a wall above the street, metres, where the tile melts what stands at the kerb into the facade (vehicles, vans,
 * people, street furniture): not in front of the wall, so PLATE_PROUD_M does not see it, and pipeline G does not run the
 * vehicle removal. It is never taken as seen: it is sent as the painted reading (the read shopfront openings), and the model is
 * told it is the street level to draw as the ground floor.
 */
export const STREET_CLUTTER_M = 2.5;

/** A seen-through hole larger than this is not an opening (a part of the wall no station reached). */
export const MAX_OPENING_M2 = 20;

/** The holes of `mask` that are openings: connected regions not touching the frame's edge and under MAX_OPENING_M2. */
export function enclosedHoles(mask: Uint8Array, W: number, H: number, pixelM: number): Uint8Array {
    const out = new Uint8Array(W * H), seen = new Uint8Array(W * H), maxPx = MAX_OPENING_M2 / (pixelM * pixelM);
    for (let s = 0; s < W * H; s++) {
        if (!mask[s] || seen[s]) continue;
        const region: number[] = [], stack = [s];
        seen[s] = 1;
        let edge = false;
        while (stack.length) {
            const i = stack.pop()!;
            region.push(i);
            const x = i % W, y = (i - x) / W;
            if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
            for (const j of [i - 1, i + 1, i - W, i + W]) {
                if (j < 0 || j >= W * H || Math.abs((j % W) - x) > 1 || seen[j] || !mask[j]) continue;
                seen[j] = 1; stack.push(j);
            }
        }
        if (!edge && region.length <= maxPx) for (const i of region) out[i] = 1;
    }
    return out;
}

/**
 * A plate texel standing further than this in front of the wall's own surface (the median offset of the plate's texels from
 * the massing plane: the melted scan sits off the plane as a whole) is something in front of the wall: a car, a person, a
 * pole, melted into the tile.
 */
export const PLATE_PROUD_M = 0.6;

/**
 * A built face's texture for the facade texture builder: the survey plate of its wall resampled into the face's raster
 * through world space (the plate is in the surveyed face's frame), over the painted texture where the plate saw nothing.
 * `use` marks the texels a station saw of the wall itself: not the plate's unseen mid-grey, and not what stands more than
 * PLATE_PROUD_M in front of the wall's surface (the street clutter melted into the tile before the ground floor). The builder draws the
 * rest as the wall continues. Undefined when the plate covers none of the face.
 */
export function plateOntoFace(f: MassingFace, painted: FaceTexture, pl: Plate, pf: MassingFace): { tex: FaceTexture; use: Uint8Array; covered: number; openings: Uint8Array; street: Uint8Array } | undefined {
    const rgba = painted.rgba.slice(), use = new Uint8Array(painted.width * painted.height);
    // the street band texels the plate covers: never seen (see STREET_CLUTTER_M)
    const street = new Uint8Array(painted.width * painted.height);
    // what the stations saw through (no surface within the plate's slab): the openings, once only enclosed holes are kept
    const through = new Uint8Array(painted.width * painted.height);
    let covered = 0;
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const plPix = pl.widthM / pl.w;
    // the wall's own surface: the median offset of what the stations saw
    const offs: number[] = [];
    for (let j = 0; j < pl.relief.length; j += 7) if (!Number.isNaN(pl.relief[j])) offs.push(pl.relief[j]);
    offs.sort((a, b) => a - b);
    const surface = offs.length ? offs[Math.floor(offs.length / 2)] : 0;
    for (let y = 0; y < painted.height; y++) for (let x = 0; x < painted.width; x++) {
        const s = f.orthoSMin + (x + 0.5) * f.pixel, t = f.orthoTMax - (y + 0.5) * f.pixel;
        const inBand = t - f.tBottom < STREET_CLUTTER_M;
        const p = [0, 1, 2].map(k => f.origin[k] + s * f.axisS[k] + t * f.axisT[k]);
        const d = [0, 1, 2].map(k => p[k] - pf.origin[k]);
        const ps = dot(d, pf.axisS as number[]), pt = dot(d, pf.axisT as number[]);
        const px = Math.floor((ps - pf.sMin) / plPix), py = Math.floor((pf.tMax - pt) / plPix);
        if (px < 0 || py < 0 || px >= pl.w || py >= pl.h) continue;
        const j = py * pl.w + px;
        if (Number.isNaN(pl.relief[j])) { if (!inBand) through[y * painted.width + x] = 1; continue; }
        if (pl.relief[j] - surface > PLATE_PROUD_M) continue;
        if (Math.abs(pl.rgb[j * 3] - 128) <= 4 && Math.abs(pl.rgb[j * 3 + 1] - 128) <= 4 && Math.abs(pl.rgb[j * 3 + 2] - 128) <= 4) continue;
        const i = y * painted.width + x;
        rgba[i * 4] = pl.rgb[j * 3]; rgba[i * 4 + 1] = pl.rgb[j * 3 + 1]; rgba[i * 4 + 2] = pl.rgb[j * 3 + 2]; rgba[i * 4 + 3] = 255;
        // the street band: laid on (so it is drawn over it) but never taken as seen
        if (inBand) { street[i] = 1; continue; }
        use[i] = 1; covered++;
    }
    return covered ? { tex: { width: painted.width, height: painted.height, rgba, source: painted.source.slice() }, use, covered: covered / use.length, openings: enclosedHoles(through, painted.width, painted.height, f.pixel), street } : undefined;
}

/** Runs `fn` over `xs` with at most `n` in flight. */
async function pool<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(xs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (next < xs.length) { const i = next++; out[i] = await fn(xs[i]); } }));
    return out;
}

export async function runPipelineG(input: PipelineGInput): Promise<PipelineGOutcome> {
    const timingsMs: Record<string, number> = {};
    const steps: StepRecord[] = [];
    const progress = (m: string) => input.onProgress?.(m);
    fs.mkdirSync(path.join(input.dir, 'plates'), { recursive: true });
    const faces = input.run.report.faces;
    // the walls grouped into the facades the survey sees (facades.ts): a footprint tracing piers or bays is surveyed and read
    // a street front at a time, and what is read laid back onto its walls
    const grouping = groupFacades(faces);
    const surveyFaces = grouping.surveyFaces;
    if (grouping.groups.length) steps.push({ step: 'facades', proposed: grouping.groups.reduce((a, g) => a + g.members.length, 0), accepted: grouping.groups.length, rejected: 0, notes: grouping.groups.map(g => `${g.face.key}: ${g.members.length} walls read as one facade ${(g.face.sMax - g.face.sMin).toFixed(1)} m wide`), ms: 0 });

    // 1. stations
    let t = Date.now();
    progress('pipeline G: placing the survey stations on the street');
    const tileMesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(input.tilePath);
    const plan = planStations({ allFaces: surveyFaces, structure: input.structure, ground: input.ground, tileMesh, anchor: input.anchor });
    timingsMs.stations = Date.now() - t;
    steps.push({ step: 'survey stations', proposed: plan.stations.length + plan.dropped.length, accepted: plan.stations.length, rejected: plan.dropped.length, notes: [`${plan.candidates} candidate eyes on the walkable street`, ...plan.skipped.map(s => `${s.face}: ${s.reason}`)], ms: timingsMs.stations });
    // the plan on disk before anything can fail, so a failed run still shows where its cameras stood
    fs.writeFileSync(path.join(input.dir, 'stations.json'), JSON.stringify({ candidates: plan.candidates, stations: plan.stations.map(s => ({ name: s.station.name, face: s.face, row: s.row, distanceM: s.distanceM, onFace: s.onFace })), dropped: plan.dropped, skipped: plan.skipped }, null, 1));
    if (!plan.stations.length) throw new Error(`no survey station sees a wall of the structure (${plan.candidates} candidate eyes on the walkable street; ${plan.skipped.map(s => s.reason).join('; ') || 'every placed station was blocked'})`);

    // 2. plates
    t = Date.now();
    // every surveyed wall gets a plate: an aerial lays onto walls no street station reached
    const faceIdx = [...new Set([...plan.stations.map(s => s.face), ...(plan.stations.some(s => s.row === 'aerial') ? plan.faces : [])])];
    const { plates } = await surveyPlates({ stations: plan.stations, faces: surveyFaces, faceIdx, tileGlb: input.tilePath, ...(input.signal ? { signal: input.signal } : {}), onProgress: progress });
    for (const pl of plates) {
        fs.writeFileSync(path.join(input.dir, 'plates', `face_${pl.face}_colour.png`), platePng(pl, false));
        fs.writeFileSync(path.join(input.dir, 'plates', `face_${pl.face}_relief.png`), reliefPng(pl));
    }
    timingsMs.plates = Date.now() - t;
    const readable = plates.filter(p => p.coverage >= MIN_READ_COVERAGE);
    steps.push({ step: 'wall plates', proposed: plates.length, accepted: readable.length, rejected: plates.length - readable.length, notes: plates.map(p => `${p.key}: ${Math.round(p.coverage * 100)}% seen from ${p.stations.length} stations`), ms: timingsMs.plates });
    if (!readable.length) throw new Error(`no wall was seen well enough to read (best ${Math.round(Math.max(...plates.map(p => p.coverage)) * 100)}% of a wall; at least ${Math.round(MIN_READ_COVERAGE * 100)}% is needed)`);

    // 3. read (cached by the plate's pixels and the prompt version: a rerun on the same tile never bills twice)
    t = Date.now();
    progress(`pipeline G: reading ${readable.length} wall${readable.length === 1 ? '' : 's'} as facade programs`);
    const readings = await pool(readable, READ_POOL, async (pl: Plate) => {
        const hash = crypto.createHash('sha256').update(PIPELINE_G_READ_VERSION).update(input.place).update(pl.rgb).update(Buffer.from(pl.relief.buffer)).digest('hex').slice(0, 24);
        const read = async (file: string, again?: string) => {
            const cached = path.join(input.dir, 'plates', file);
            if (fs.existsSync(cached)) return { ...(JSON.parse(fs.readFileSync(cached, 'utf8')) as { program: FacadeProgram; model: string; ms: number }), cached: true };
            const r = await readPlate(input.chain, input.place, pl, input.signal, again);
            fs.writeFileSync(cached, JSON.stringify(r, null, 1));
            return { ...r, cached: false };
        };
        try {
            // the check (check.ts): a reading that explains little of its plate, or no more than its own displaced copies, is
            // read once more with what was measured, and the reading that explains more is kept
            const cp = checkPlate(pl);
            const first = await read(`reading_${hash}.json`);
            const c1 = checkReading(cp, first.program);
            if (!c1.weak) return { pl, ...first, check: c1 };
            const again = `A first reading of this wall was checked against the image and did not fit it: drawn back onto Image 1, its openings and members account for ${Math.round(c1.explained * 100)}% of the wall's light and dark variation, about ${c1.lift}x what the same reading moved half a bay out of place does. Look again: measure each row's bottom and top and each opening's left and right edges off the tick marks, and list only what the image shows.`;
            try {
                const second = await read(`reading_${hash}_again.json`, again);
                const c2 = checkReading(cp, second.program);
                return c2.explained > c1.explained ? { pl, ...second, check: c2, reread: { kept: 'second' as const, first: c1 } } : { pl, ...first, check: c1, reread: { kept: 'first' as const, second: c2 } };
            } catch (err) {
                if (input.signal?.aborted) throw err;
                return { pl, ...first, check: c1, reread: { kept: 'first' as const, error: err instanceof Error ? err.message : String(err) } };
            }
        } catch (err) {
            if (input.signal?.aborted) throw err;
            return { pl, error: err instanceof Error ? err.message : String(err) };
        }
    });
    timingsMs.read = Date.now() - t;
    const items = new Map<string, ProgramItems>();
    for (const r of readings) if ('program' in r && r.program) items.set(r.pl.key, programItems(r.program, surveyFaces[r.pl.face], `g${r.pl.face}_`));
    const checkNote = (c: ReadingCheck) => `explains ${Math.round(c.explained * 100)}% of the plate (${c.lift}x its displaced copies), edges P ${c.precision} R ${c.recall}, opening contrast ${c.openingContrast}`;
    steps.push({ step: 'facade reading', proposed: readable.length, accepted: items.size, rejected: readable.length - items.size, notes: readings.map(r => ('error' in r && r.error) ? `${r.pl.key}: not read (${r.error})` : `${r.pl.key}: ${'model' in r ? r.model : ''}${'cached' in r && r.cached ? ' (cached)' : ''}${'check' in r && r.check ? `; ${checkNote(r.check)}` : ''}${'reread' in r && r.reread ? `; read again (${r.reread.kept} reading kept${'first' in r.reread && r.reread.first ? `, the first ${checkNote(r.reread.first)}` : ''}${'second' in r.reread && r.reread.second ? `, the second ${checkNote(r.reread.second)}` : ''}${'error' in r.reread && r.reread.error ? `, the second failed: ${r.reread.error}` : ''})` : ''}`), ms: timingsMs.read });
    if (!items.size) throw new Error(`no wall could be read (${readings.map(r => ('error' in r && r.error) || '').filter(Boolean).join('; ')})`);

    // what was read on a grouped facade laid back onto its walls (facades.ts); a wall read on its own keeps its reading
    const built = new Map<string, ProgramItems>();
    const dropped: string[] = [];
    for (const [key, it] of items) {
        const group = grouping.groups.find(g => g.face.key === key);
        if (!group) { built.set(key, it); continue; }
        const laid = layBack(group, it);
        for (const [k, v] of laid.byMember) built.set(k, v);
        dropped.push(...laid.droppedOpenings);
    }

    // 4. build
    t = Date.now();
    progress('pipeline G: building the facades natively on the massing');
    const openings = [...built.values()].flatMap(x => x.openings);
    const faceSweeps = [...built.values()].flatMap(x => x.faceSweeps);
    // what stands on the roof, built from what the scan measures there (roof-objects.ts)
    let roofParts: Massing['parts'] = [];
    try {
        const ro = await roofObjects(input.run, input.massing.parts, { groundY: input.structure.groundY, dir: input.dir, ...(input.signal ? { signal: input.signal } : {}) });
        roofParts = ro.parts;
        steps.push({ step: 'roof objects', proposed: ro.audit?.clusters.length ?? 0, accepted: ro.parts.length, rejected: (ro.audit?.clusters.length ?? 0) - ro.parts.length, notes: ro.notes, ms: Date.now() - t });
    } catch (err) {
        if (input.signal?.aborted) throw err;
        steps.push({ step: 'roof objects', proposed: 0, accepted: 0, rejected: 0, skipped: `the residual audit failed (${err instanceof Error ? err.message : String(err)}); the roof stays flat`, notes: [], ms: Date.now() - t });
    }
    const buildDir = path.join(input.dir, 'build');
    const run = await runMassing(massingSpecText({ ...input.massing, parts: [...input.massing.parts, ...roofParts] }, { outDir: buildDir, tile: input.tilePath, params: { ...G_BUILD_PARAMS }, openings, faceSweeps }), buildDir, { ...(input.signal ? { signal: input.signal } : {}) });
    timingsMs.build = Date.now() - t;
    const c = [...built.values()].reduce((a, x) => ({ o: a.o + x.counts.openings, fo: a.fo + x.counts.filledOpenings, h: a.h + x.counts.horizontal, v: a.v + x.counts.vertical, fv: a.fv + x.counts.filledVertical, pn: a.pn + x.counts.paned, sl: a.sl + x.counts.sills, sr: a.sr + x.counts.surrounds }), { o: 0, fo: 0, h: 0, v: 0, fv: 0, pn: 0, sl: 0, sr: 0 });
    steps.push({ step: 'native build', proposed: openings.length + faceSweeps.length, accepted: openings.length + faceSweeps.length - run.report.rejectedOpenings.length - run.report.rejectedSweeps.length, rejected: run.report.rejectedOpenings.length + run.report.rejectedSweeps.length, notes: [`${c.o} openings (${c.fo} continued into unseen parts; ${c.pn} with divided glazing, ${c.sl} with sills, ${c.sr} with surrounds), ${c.h} horizontal profiles, ${c.v} vertical members (${c.fv} continued)`, ...run.report.rejectedOpenings.map(id => `opening ${id} rejected by the native tool`), ...(dropped.length ? [`${dropped.length} openings read on a grouped facade lay across walls and were not built (${dropped.slice(0, 8).join(', ')}${dropped.length > 8 ? ', ...' : ''})`] : [])], ms: timingsMs.build });

    // 5. paint
    t = Date.now();
    const walls = [...items.values()].map(x => x.wallColour);
    const fallback: [number, number, number] = [0, 1, 2].map(k => Math.round(median(walls.map(w => w[k])))) as [number, number, number];
    const textures = paintFaces(run.report.faces, built, fallback);
    const legend = gLegend();
    timingsMs.paint = Date.now() - t;
    steps.push({ step: 'paint', proposed: textures.size, accepted: textures.size, rejected: 0, notes: [`${[...built.keys()].length} walls painted from their own reading or their facade's, ${textures.size - built.size} faces from the read walls' median colour (generated)`], ms: timingsMs.paint });

    // 6. facade textures: each read wall's survey plate redrawn by the facade texture builder, over its paint where accepted
    const enhanced: EnhanceWallRecord[] = [];
    if (input.enhance) {
        t = Date.now();
        const e = input.enhance;
        const step: StepRecord = { step: 'facade textures', proposed: 0, accepted: 0, rejected: 0, notes: [], ms: 0 };
        const plateOf = (f: MassingFace) => plates.find(p => p.key === f.key || f.key.startsWith(p.key + ':') || p.key === grouping.groupOf.get(f.key));
        const walls = run.report.faces.filter(f => f.kind === 'wall' && textures.has(f.index) && plateOf(f) && items.has(plateOf(f)!.key)).sort((a, b) => b.area - a.area);
        const done: FaceTexture[] = [];
        const one = async (f: MassingFace) => {
            const pl = plateOf(f)!;
            const on = plateOntoFace(f, textures.get(f.index)!, pl, surveyFaces[pl.face]);
            if (!on) return;
            progress(`pipeline G: drawing the facade texture of wall ${f.index} (${Math.round(f.area)} m2)`);
            const r = await buildFacadeTexture(f, on.tex, on.use, {
                client: e.client, models: e.models, locationName: input.place, source: G_SRC.enhanced,
                // a survey plate is the melted tile: the region audit reads its blobs as elements the redraw erased, so G keeps the
                // identity gate and lets the quality score (with infill of what it faults) judge the texture itself
                guards: false,
                ...(done[0] ? { reference: done[0] } : {}), ...(e.cacheDir ? { cacheDir: e.cacheDir } : {}),
                counter: visionFacadeCounter(input.chain as VisionModelChain<string>), ...(input.signal ? { signal: input.signal } : {}),
                ...(e.infill ? { infill: e.infill } : {}), ...(e.unseenModels ? { unseenModels: e.unseenModels } : {}), quality: true,
                // what no station saw of the wall itself is drawn as the wall continues (never the melt)
                // sent as a fill feathered in: never as grey holes, whose outlines the model paints, nor flat paint, which it keeps flat
                // the median of the storey row's bays at the same place in the bay, the painted reading where too few bays vote;
                // the street band is the painted reading (its read shopfront openings), described to the model as the street
                // level to draw (the median of its melted clutter came back as rows of odd panels)
                unseen: { source: G_SRC.enhanced, fill: repeatFill(on.tex.rgba, on.use, on.tex.width, on.tex.height, f.pixel, textures.get(f.index)!.rgba) }, openings: on.openings,
                streetBandM: STREET_CLUTTER_M
            });
            step.proposed++;
            enhanced.push({ ...r, plate: undefined, guarded: undefined, labels: undefined, grid: undefined } as EnhanceWallRecord);
            if (r.accepted) { step.accepted++; textures.set(f.index, on.tex); done.push(on.tex); }
            else step.rejected++;
            step.notes.push(`wall ${f.index}: ${r.accepted ? 'textured' : 'keeps its painted colours'}: ${r.why}${r.model ? ` (${r.model})` : ''}`);
        };
        // the largest wall alone, then ENHANCE_CONCURRENCY at a time, each referencing the first finished wall
        for (let k = 0; k < walls.length;) {
            const round = walls.slice(k, k === 0 ? 1 : k + ENHANCE_CONCURRENCY);
            k += round.length;
            await Promise.all(round.map(one));
        }
        step.ms = timingsMs.facadeTextures = Date.now() - t;
        steps.push(step);
    }
    const files = writeMassingLayer(run, input.massing, textures, legend, input.dir, input.stage, input.stageKey, 'pipeline_g');

    return {
        files, run, steps, legend, grammars: [], timingsMs, enhanced,
        build: { parts: [...input.massing.parts, ...roofParts], sweeps: [], openings },
        textures, occluderMasks: new Map(),
        plates: plates.map(p => {
            const r = readings.find(x => x.pl.key === p.key);
            return { face: p.key, coverage: +p.coverage.toFixed(3), read: items.has(p.key), ...(r && 'model' in r ? { model: r.model, notes: r.program?.notes } : {}), ...(items.get(p.key) ? { counts: items.get(p.key)!.counts } : {}), ...(r && 'check' in r && r.check ? { check: r.check } : {}), ...(r && 'reread' in r && r.reread ? { reread: r.reread.kept } : {}) };
        }),
        stations: { kept: plan.stations.length, dropped: plan.dropped.length, candidates: plan.candidates, skipped: plan.skipped }
    };
}
