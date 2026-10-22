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
 *   1. places survey stations by the staged survey's own rules (stations.ts),
 *   2. path-traces them from the tile with metric depth and lays them onto metric wall plates (plates.ts),
 *   3. reads every well-seen plate as a facade program in metres (read.ts),
 *   4. builds it natively on the massing (scratchbox_staged_massing.hpp: arched openings, swept bands, members) with no tile
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
import { buildFacadeTexture } from '../facade-texture/facade-texture';
import { planStations } from './stations';
import { platePng, reliefPng, surveyPlates, type Plate } from './plates';
import { MIN_READ_COVERAGE, PIPELINE_G_READ_VERSION, programItems, readPlate, type FacadeProgram, type ProgramItems } from './read';

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
        { source: 'pipeline-g-enhanced', label: 'generated', method: `pipeline G: AI-enhanced from the survey plate of this wall by the facade texture builder (${TEXTURE_PLATE_PROMPT_ID}), kept through its identity gate and region audit`, rung: rung('generated tileable PBR'), weight: 0.25 }
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
    enhance?: { client: PlateModelClient; models: string[]; guards?: boolean; cacheDir?: string };
}

export interface PipelineGOutcome extends InferenceOutcome {
    plates: Array<{ face: string; coverage: number; read: boolean; model?: string; notes?: string; counts?: ProgramItems['counts'] }>;
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
        }
        textures.set(f.index, { width: f.width, height: f.height, rgba, source });
    }
    return textures;
}

/**
 * A built face's texture for the facade texture builder: the survey plate of its wall resampled into the face's raster
 * through world space (the plate is in the surveyed face's frame), over the painted texture where the plate saw nothing.
 * `use` marks the texels a station saw. Undefined when the plate covers none of the face.
 */
export function plateOntoFace(f: MassingFace, painted: FaceTexture, pl: Plate, pf: MassingFace): { tex: FaceTexture; use: Uint8Array; covered: number } | undefined {
    const rgba = painted.rgba.slice(), use = new Uint8Array(painted.width * painted.height);
    let covered = 0;
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const plPix = pl.widthM / pl.w;
    for (let y = 0; y < painted.height; y++) for (let x = 0; x < painted.width; x++) {
        const s = f.orthoSMin + (x + 0.5) * f.pixel, t = f.orthoTMax - (y + 0.5) * f.pixel;
        const p = [0, 1, 2].map(k => f.origin[k] + s * f.axisS[k] + t * f.axisT[k]);
        const d = [0, 1, 2].map(k => p[k] - pf.origin[k]);
        const ps = dot(d, pf.axisS as number[]), pt = dot(d, pf.axisT as number[]);
        const px = Math.floor((ps - pf.sMin) / plPix), py = Math.floor((pf.tMax - pt) / plPix);
        if (px < 0 || py < 0 || px >= pl.w || py >= pl.h) continue;
        const j = py * pl.w + px;
        if (Number.isNaN(pl.relief[j])) continue;
        const i = y * painted.width + x;
        rgba[i * 4] = pl.rgb[j * 3]; rgba[i * 4 + 1] = pl.rgb[j * 3 + 1]; rgba[i * 4 + 2] = pl.rgb[j * 3 + 2]; rgba[i * 4 + 3] = 255;
        use[i] = 1; covered++;
    }
    return covered ? { tex: { width: painted.width, height: painted.height, rgba, source: painted.source.slice() }, use, covered: covered / use.length } : undefined;
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

    // 1. stations
    let t = Date.now();
    progress('pipeline G: placing the survey stations on the street');
    const tileMesh = HeadlessMeshSilhouetteRenderer.loadMeshFromGlb(input.tilePath);
    const plan = planStations({ allFaces: faces, structure: input.structure, ground: input.ground, tileMesh, anchor: input.anchor });
    timingsMs.stations = Date.now() - t;
    steps.push({ step: 'survey stations', proposed: plan.stations.length + plan.dropped.length, accepted: plan.stations.length, rejected: plan.dropped.length, notes: [`${plan.candidates} candidate eyes on the walkable street`, ...plan.skipped.map(s => `${s.face}: ${s.reason}`)], ms: timingsMs.stations });
    // the plan on disk before anything can fail, so a failed run still shows where its cameras stood
    fs.writeFileSync(path.join(input.dir, 'stations.json'), JSON.stringify({ candidates: plan.candidates, stations: plan.stations.map(s => ({ name: s.station.name, face: s.face, row: s.row, distanceM: s.distanceM, onFace: s.onFace })), dropped: plan.dropped, skipped: plan.skipped }, null, 1));
    if (!plan.stations.length) throw new Error(`no survey station sees a wall of the structure (${plan.candidates} candidate eyes on the walkable street; ${plan.skipped.map(s => s.reason).join('; ') || 'every placed station was blocked'})`);

    // 2. plates
    t = Date.now();
    // every surveyed wall gets a plate: an aerial lays onto walls no street station reached
    const faceIdx = [...new Set([...plan.stations.map(s => s.face), ...(plan.stations.some(s => s.row === 'aerial') ? plan.faces : [])])];
    const { plates } = await surveyPlates({ stations: plan.stations, faces, faceIdx, tileGlb: input.tilePath, ...(input.signal ? { signal: input.signal } : {}), onProgress: progress });
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
        const cached = path.join(input.dir, 'plates', `reading_${hash}.json`);
        if (fs.existsSync(cached)) return { pl, ...(JSON.parse(fs.readFileSync(cached, 'utf8')) as { program: FacadeProgram; model: string; ms: number }), cached: true };
        try {
            const r = await readPlate(input.chain, input.place, pl, input.signal);
            fs.writeFileSync(cached, JSON.stringify(r, null, 1));
            return { pl, ...r, cached: false };
        } catch (err) {
            if (input.signal?.aborted) throw err;
            return { pl, error: err instanceof Error ? err.message : String(err) };
        }
    });
    timingsMs.read = Date.now() - t;
    const items = new Map<string, ProgramItems>();
    for (const r of readings) if ('program' in r && r.program) items.set(r.pl.key, programItems(r.program, faces[r.pl.face], `g${r.pl.face}_`));
    steps.push({ step: 'facade reading', proposed: readable.length, accepted: items.size, rejected: readable.length - items.size, notes: readings.map(r => ('error' in r && r.error) ? `${r.pl.key}: not read (${r.error})` : `${r.pl.key}: ${'model' in r ? r.model : ''}${'cached' in r && r.cached ? ' (cached)' : ''}`), ms: timingsMs.read });
    if (!items.size) throw new Error(`no wall could be read (${readings.map(r => ('error' in r && r.error) || '').filter(Boolean).join('; ')})`);

    // 4. build
    t = Date.now();
    progress('pipeline G: building the facades natively on the massing');
    const openings = [...items.values()].flatMap(x => x.openings);
    const faceSweeps = [...items.values()].flatMap(x => x.faceSweeps);
    const buildDir = path.join(input.dir, 'build');
    const run = await runMassing(massingSpecText(input.massing, { outDir: buildDir, tile: input.tilePath, params: { ...G_BUILD_PARAMS }, openings, faceSweeps }), buildDir, { ...(input.signal ? { signal: input.signal } : {}) });
    timingsMs.build = Date.now() - t;
    const c = [...items.values()].reduce((a, x) => ({ o: a.o + x.counts.openings, fo: a.fo + x.counts.filledOpenings, h: a.h + x.counts.horizontal, v: a.v + x.counts.vertical, fv: a.fv + x.counts.filledVertical }), { o: 0, fo: 0, h: 0, v: 0, fv: 0 });
    steps.push({ step: 'native build', proposed: openings.length + faceSweeps.length, accepted: openings.length + faceSweeps.length - run.report.rejectedOpenings.length - run.report.rejectedSweeps.length, rejected: run.report.rejectedOpenings.length + run.report.rejectedSweeps.length, notes: [`${c.o} openings (${c.fo} continued into unseen parts), ${c.h} horizontal profiles, ${c.v} vertical members (${c.fv} continued)`, ...run.report.rejectedOpenings.map(id => `opening ${id} rejected by the native tool`)], ms: timingsMs.build });

    // 5. paint
    t = Date.now();
    const walls = [...items.values()].map(x => x.wallColour);
    const fallback: [number, number, number] = [0, 1, 2].map(k => Math.round(median(walls.map(w => w[k])))) as [number, number, number];
    const textures = paintFaces(run.report.faces, items, fallback);
    const legend = gLegend();
    timingsMs.paint = Date.now() - t;
    steps.push({ step: 'paint', proposed: textures.size, accepted: textures.size, rejected: 0, notes: [`${items.size} walls painted from their own reading, ${textures.size - items.size} faces from the read walls' median colour (generated)`], ms: timingsMs.paint });

    // 6. facade textures: each read wall's survey plate redrawn by the facade texture builder, over its paint where accepted
    const enhanced: EnhanceWallRecord[] = [];
    if (input.enhance) {
        t = Date.now();
        const e = input.enhance;
        const step: StepRecord = { step: 'facade textures', proposed: 0, accepted: 0, rejected: 0, notes: [], ms: 0 };
        const plateOf = (f: MassingFace) => plates.find(p => p.key === f.key || f.key.startsWith(p.key + ':'));
        const walls = run.report.faces.filter(f => f.kind === 'wall' && textures.has(f.index) && plateOf(f) && items.has(plateOf(f)!.key)).sort((a, b) => b.area - a.area);
        const done: FaceTexture[] = [];
        const one = async (f: MassingFace) => {
            const pl = plateOf(f)!;
            const on = plateOntoFace(f, textures.get(f.index)!, pl, faces[pl.face]);
            if (!on) return;
            progress(`pipeline G: drawing the facade texture of wall ${f.index} (${Math.round(f.area)} m2)`);
            const r = await buildFacadeTexture(f, on.tex, on.use, {
                client: e.client, models: e.models, locationName: input.place, source: G_SRC.enhanced, guards: e.guards ?? true,
                ...(done[0] ? { reference: done[0] } : {}), ...(e.cacheDir ? { cacheDir: e.cacheDir } : {}),
                counter: visionFacadeCounter(input.chain as VisionModelChain<string>), ...(input.signal ? { signal: input.signal } : {})
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
        build: { parts: input.massing.parts, sweeps: [], openings },
        textures, occluderMasks: new Map(),
        plates: plates.map(p => {
            const r = readings.find(x => x.pl.key === p.key);
            return { face: p.key, coverage: +p.coverage.toFixed(3), read: items.has(p.key), ...(r && 'model' in r ? { model: r.model, notes: r.program?.notes } : {}), ...(items.get(p.key) ? { counts: items.get(p.key)!.counts } : {}) };
        }),
        stations: { kept: plan.stations.length, dropped: plan.dropped.length, candidates: plan.candidates, skipped: plan.skipped }
    };
}
