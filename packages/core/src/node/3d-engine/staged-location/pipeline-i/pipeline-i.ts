/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline I/J: the isolated structure's scan, rendered from its tile photos at four planned stations
 * (sheet-stations.ts), made into one building-survey character sheet (one 4K Nano Banana 2 image, every panel checked
 * against the scan: building-character-sheet.ts), its four panels sent together to its `ModelClient` (input.model:
 * Meshy 7.1 multi by default, fal-meshy.ts; or Trellis multi, fal-trellis.ts, when the caller asks for it) once per
 * seed, every model fitted onto the scan's footprint and height (register.ts) and scored against the sheet
 * (seed-score.ts), and the best one's textures colour-matched to the structure's swatch measured from the views
 * (swatch.ts). The model is generated content: it is labelled so, its fit to the scan is reported, and nothing of it
 * is clipped (fit and report). Any failure throws, so the stage degrades to the massing with the real reason.
 *
 * Pipeline J (Meshy, the 3D Building default since 2026-10-25, user decision; `input.seeds`/`input.skipColourMatch`
 * trimmed by the orchestrator): Meshy's own output is already texture-complete, so it runs with one seed instead of
 * six (no best-of-N selection) and skips the swatch colour match that was tuned for Trellis's colour drift.
 *
 * Pipeline I (Trellis like the Puck test "D", user decision 2026-10-24; the 3D Building default from 2026-10-24 until
 * pipeline J superseded it on 2026-10-25): best of six seeds by silhouette and plan fit, then the swatch colour match.
 * Kept selectable as an alternative generator over the same character sheet, not a second pipeline.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GeodeticAnchor } from '../../../../common/spatial/colmap-vector-reference-types';
import { SurveyStationRenderService } from '../../../spatial/SurveyStationRenderService';
import type { StationImageGenerator } from '../../../spatial/BeautifyStationService';
import { beautifyCharacterSheet, type CharacterSheetPanel } from '../../../spatial/building-character-sheet';
import { readGlbScene, sceneToRenderMesh } from '../../../spatial/StreetViewPoseRegistrar';
import { decodePng, encodePng } from '../../../texture-processing';
import { planSheetStations, type SheetStationPlan } from './sheet-stations';
import { applyRootTransform, registerToFootprint, stripMaterials, type FootprintTarget, type RegistrationFit } from './register';
import type { ModelClient, ModelResult } from './fal-trellis';
import { scoreCandidate, panelMask, type CandidateScore } from './seed-score';
import { colourMatchGlb, measureSwatch, type Swatch } from './swatch';
import { infillModelTextureHoles, type ModelTextureInfillResult } from './texture-holes';
import type { EnhanceModelClient } from '../texture-enhance';

export const PIPELINE_I_VERSION = 'pipeline-i/2';
/** Square size of each view sent to the model. */
export const MODEL_VIEW_PX = 1024;
/** The seeds of one build, run in parallel; the best fitted model is kept. */
export const TRELLIS_SEEDS = [7, 11, 23, 41, 59, 73];
/** A sheet may go on to the model with at most this many panels failing their checks (the failure is reported). */
export const MAX_FAILED_PANELS = 1;
/**
 * Share of the scan's footprint the fitted model must cover before it is allowed to supersede (hide) the measured
 * remeshed scan in the viewport. Interim safeguard until a real photo-match judge exists (the natural replacement,
 * comparing both against real photos the way pipeline E relief's does) -- until then this is the only thing stopping
 * a poorly-fit generated model from silently hiding a much better measured layer. Found on the Empire State Building
 * (2026-10-25): even after register.ts's scale-search fix, a correctly-proportioned-everywhere-else Trellis model
 * covered only 19% of the real footprint (its mesh was too simple to carry the setbacks) and still unconditionally
 * superseded the textured remesh for display. Below this bar the grammar stage degrades instead of committing, the
 * same way a real pipeline-i failure does.
 */
export const MIN_FOOTPRINT_COVERAGE_TO_SUPERSEDE = 0.5;

export interface PipelineIStep { step: string; proposed: number; accepted: number; rejected: number; notes: string[]; ms: number }

export interface PipelineIInput {
    /** The isolated structure's scan with its tile photos (the sheet's reference renders) and as clay (station planning). */
    texturedGlb: string;
    clayGlb: string;
    footprint: FootprintTarget;
    anchor: GeodeticAnchor;
    place: string;
    dir: string;
    generator: StationImageGenerator;
    model: ModelClient;
    /** Seeds to run (default TRELLIS_SEEDS). */
    seeds?: number[];
    /** Skip the Trellis-tuned CIELAB colour match to the swatch (pipeline J: Meshy's own texture colour is kept). */
    skipColourMatch?: boolean;
    /** Time left for the whole pipeline; the model gets what the sheet leaves. */
    budgetMs: number;
    /** Width of one sheet panel (default 1920, the station renders' width). */
    panelWidth?: number;
    /** Reference renders from the tile photos (default) or clay. */
    renderMode?: 'textured' | 'clay';
    /** Fills the kept model's own black texture holes (texture-holes.ts) before it is written; skipped without a client. */
    infill?: { client: EnhanceModelClient; models: string[] };
    signal?: AbortSignal;
    onProgress?: (msg: string) => void;
    now?: () => number;
}

export interface PipelineIOutcome {
    files: { texturedGlb: string; clayGlb: string; modelGlb: string; sheetPng: string; sheetReferencePng: string; views: string[] };
    plan: Pick<SheetStationPlan, 'axisDeg' | 'wallAreaM2' | 'pair' | 'heightM'>;
    sheet: { accepted: boolean; attempts: number; modelUsed?: string; panels: Array<{ stationId: number; passed: boolean; reason?: string; overflow?: number; underfill?: number }> };
    model: { model: string; requestId: string; seconds: number; seed?: number };
    /** Every seed tried: its score, or why it failed. */
    candidates: Array<{ seed?: number; requestId?: string; score?: CandidateScore; fit?: Pick<RegistrationFit, 'planIoU' | 'overflowShare' | 'coverage'>; error?: string }>;
    swatch: Swatch & { before: Swatch[] };
    fit: RegistrationFit;
    /** The kept model's own texture holes (texture-holes.ts), when `input.infill` was given. */
    holes?: ModelTextureInfillResult;
    steps: PipelineIStep[];
    timingsMs: Record<string, number>;
}

/**
 * One panel as the model's view: everything farther than a small margin from the scan's outline set to white (no stray
 * lines, no background), cropped square around the outline with a margin, resampled to MODEL_VIEW_PX.
 */
export function panelToModelView(panel: CharacterSheetPanel, size = MODEL_VIEW_PX): Buffer {
    const img = decodePng(panel.imagePng), sil = panel.blockout.silhouette, W = img.width, H = img.height;
    const bw = panel.blockout.width, bh = panel.blockout.height;
    const silAt = (x: number, y: number) => sil[Math.min(bh - 1, Math.floor(y * bh / H)) * bw + Math.min(bw - 1, Math.floor(x * bw / W))] !== 0;
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (silAt(x, y)) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (x1 < 0) throw new Error(`station ${panel.station.id}: the scan does not appear in its panel`);
    // near-outline mask: dilate the silhouette by a margin (separable square max on a coarse grid)
    const r = Math.max(2, Math.round(0.02 * W)), near = new Uint8Array(W * H), tmp = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { let last = -1e9; for (let x = 0; x < W; x++) { if (silAt(x, y)) last = x; tmp[y * W + x] = x - last <= r ? 1 : 0; } last = 1e9; for (let x = W - 1; x >= 0; x--) { if (silAt(x, y)) last = x; if (last - x <= r) tmp[y * W + x] = 1; } }
    for (let x = 0; x < W; x++) { let last = -1e9; for (let y = 0; y < H; y++) { if (tmp[y * W + x]) last = y; near[y * W + x] = y - last <= r ? 1 : 0; } last = 1e9; for (let y = H - 1; y >= 0; y--) { if (tmp[y * W + x]) last = y; if (last - y <= r) near[y * W + x] = 1; } }
    const side = Math.max(x1 - x0, y1 - y0) * 1.12, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, out = Buffer.alloc(size * size * 4, 255);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        // bilinear sample of the panel; white outside the frame or away from the outline
        const sx = cx - side / 2 + (x + 0.5) * side / size - 0.5, sy = cy - side / 2 + (y + 0.5) * side / size - 0.5;
        const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy, o = (y * size + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
            let acc = 0;
            for (const [dx, dy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]] as Array<[number, number, number]>) {
                const px = ix + dx, py = iy + dy;
                acc += w * (px >= 0 && py >= 0 && px < W && py < H && near[py * W + px] ? img.rgba[(py * W + px) * 4 + ch] : 255);
            }
            out[o + ch] = Math.round(acc);
        }
        out[o + 3] = 255;
    }
    return encodePng(size, size, out);
}

export async function runPipelineI(input: PipelineIInput): Promise<PipelineIOutcome> {
    const now = input.now ?? Date.now, t0 = now(), timingsMs: Record<string, number> = {}, steps: PipelineIStep[] = [];
    fs.mkdirSync(input.dir, { recursive: true });
    const progress = (m: string) => input.onProgress?.(m);

    // 1. four stations around the structure, from its scan
    let t = now();
    progress('Pipeline I: planning the four views of the structure');
    const plan = planSheetStations(sceneToRenderMesh(readGlbScene(input.clayGlb)), input.footprint.groundY, input.anchor);
    timingsMs.stations = now() - t;
    steps.push({ step: 'stations', proposed: 4, accepted: 4, rejected: 0, ms: timingsMs.stations,
        notes: [`facade axis ${plan.axisDeg.toFixed(1)} deg; scanned wall per side ${plan.wallAreaM2.join(' / ')} m2; faces ${plan.pair + 1} and ${(plan.pair + 1) % 4 + 1}, their corner and an aerial; framed ${plan.heightM.toFixed(1)} m street to roof`] });

    // 2. the character sheet: one 4K image of the four views, every panel checked against the scan
    t = now();
    progress('Pipeline I: drawing the character sheet (one 4K image of the four views)');
    const renderer = new SurveyStationRenderService();
    await renderer.loadMesh(input.texturedGlb);
    const stations = renderer.enrichStations(plan.stations, {});
    const sheet = await beautifyCharacterSheet(renderer, input.generator, stations, input.place, { glbPath: input.texturedGlb, renderMode: input.renderMode ?? 'textured', maxRerolls: 2, signal: input.signal, ...(input.panelWidth ? { panelWidth: input.panelWidth } : {}) });
    timingsMs.sheet = now() - t;
    const sheetPng = path.join(input.dir, 'sheet.png'), sheetReferencePng = path.join(input.dir, 'sheet_reference.png');
    fs.writeFileSync(sheetPng, sheet.sheetPng); fs.writeFileSync(sheetReferencePng, sheet.inputPng);
    const failed = sheet.panels.filter(p => !p.qc.passed);
    steps.push({ step: 'character sheet', proposed: 4, accepted: 4 - failed.length, rejected: failed.length, ms: timingsMs.sheet,
        notes: [`${sheet.attempts} attempt(s), ${sheet.modelUsed ?? 'image model'}`, ...failed.map(p => `station ${p.station.id}: ${p.qc.reason}`)] });
    if (failed.length > MAX_FAILED_PANELS) throw new Error(`the character sheet did not hold to the scan after ${sheet.attempts} attempts: ${failed.map(p => `station ${p.station.id}: ${p.qc.reason}`).join('; ')}`);

    // 3. Trellis, all four views in one request, once per seed in parallel; each model fitted onto the scan and scored
    t = now();
    const views = sheet.panels.map((p, i) => { const f = path.join(input.dir, `view_${i + 1}.png`); fs.writeFileSync(f, panelToModelView(p)); return f; });
    const viewPngs = views.map(f => fs.readFileSync(f));
    const masks = sheet.panels.map(p => panelMask(p.imagePng));
    const seeds = input.seeds ?? TRELLIS_SEEDS;
    progress(`Pipeline I: building ${seeds.length} models with ${input.model.model} (one per seed)`);
    const timeoutMs = Math.max(60_000, input.budgetMs - (now() - t0) - 30_000);
    type Built = { ok: true; seed: number; result: ModelResult; raw: string; fit: RegistrationFit; score: CandidateScore };
    type Failed = { ok: false; seed: number; error: string };
    const candidates: Array<Built | Failed> = await Promise.all(seeds.map(async (seed): Promise<Built | Failed> => {
        try {
            const r = await input.model.generate(viewPngs, { signal: input.signal, timeoutMs, seed, onProgress: m => progress(`Pipeline I: seed ${seed}: ${m}`) });
            const raw = path.join(input.dir, `model_seed${seed}.glb`);
            fs.writeFileSync(raw, r.glb);
            const mesh = sceneToRenderMesh(readGlbScene(raw));
            const fit = registerToFootprint(mesh.vertices, input.footprint);
            const m = fit.matrix, v = mesh.vertices, world = new Float64Array(v.length);
            for (let i = 0; i < v.length; i += 3) {
                world[i] = m[0] * v[i] + m[4] * v[i + 1] + m[8] * v[i + 2] + m[12];
                world[i + 1] = m[1] * v[i] + m[5] * v[i + 1] + m[9] * v[i + 2] + m[13];
                world[i + 2] = m[2] * v[i] + m[6] * v[i + 1] + m[10] * v[i + 2] + m[14];
            }
            return { ok: true, seed, result: r, raw, fit, score: scoreCandidate(world, mesh.indices, stations, masks, fit.planIoU) };
        } catch (err) {
            if (input.signal?.aborted) throw err;
            return { ok: false, seed, error: err instanceof Error ? err.message : String(err) };
        }
    }));
    timingsMs.model = now() - t;
    const ok = candidates.filter((c): c is Built => c.ok);
    if (!ok.length) throw new Error(`no ${input.model.model} model came back: ${candidates.map(c => `seed ${c.seed}: ${c.ok ? 'ok' : c.error}`).join('; ')}`);
    const best = ok.reduce((a, b) => (b.score.score > a.score.score ? b : a));
    steps.push({ step: 'model', proposed: seeds.length, accepted: ok.length, rejected: seeds.length - ok.length, ms: timingsMs.model,
        notes: [`${input.model.model}; kept seed ${best.seed} (score ${best.score.score.toFixed(3)}: silhouette ${best.score.meanSilhouetteIoU.toFixed(3)} against the sheet, plan IoU ${best.score.planIoU.toFixed(3)})`,
            ...candidates.map(c => (c.ok ? `seed ${c.seed}: ${c.score.score.toFixed(3)}` : `seed ${c.seed} failed: ${c.error}`))] });

    // 4. the kept model's textures colour-matched to the structure's swatch (skippable: pipeline J keeps Meshy's own colour), then placed on the scan
    t = now();
    const swatch = measureSwatch(viewPngs);
    const matched = input.skipColourMatch ? { glb: best.result.glb, before: [] as Swatch[] } : colourMatchGlb(best.result.glb, swatch);
    timingsMs.fit = now() - t;
    const fit = best.fit;
    steps.push({ step: 'colour and fit', proposed: 1, accepted: 1, rejected: 0, ms: timingsMs.fit,
        notes: [input.skipColourMatch ? 'colour match skipped; the model keeps its own generated texture colour' :
            `textures moved onto the swatch (Lab ${swatch.mean.map(x => x.toFixed(1)).join(' / ')}) from ${matched.before.map(b => b.mean.map(x => x.toFixed(1)).join(' / ')).join(', ') || 'no texture'}`,
            `plan IoU ${fit.planIoU.toFixed(2)} with the scan footprint; ${(fit.overflowShare * 100).toFixed(0)}% of the model's plan outside it (reported, not clipped); covers ${(fit.coverage * 100).toFixed(0)}% of the footprint; yaw ${fit.yawDeg.toFixed(1)} deg${fit.mirrored ? ', mirrored' : ''}, scale ${fit.scale.toFixed(2)}`] });

    // 5. the model's own texture holes filled (surfaces its four input views never saw, baked flat black by the model
    //    itself): believability-first, so a hole is a plausible generated fill, never a black gap left in the build
    t = now();
    let holes: ModelTextureInfillResult | undefined;
    let painted = matched.glb;
    if (input.infill) {
        const filled = await infillModelTextureHoles(matched.glb, { ...input.infill, ...(input.signal ? { signal: input.signal } : {}) });
        holes = filled.result;
        painted = filled.glb;
    }
    timingsMs.holes = now() - t;
    if (holes) steps.push({
        step: 'texture holes', proposed: holes.images, accepted: holes.decision === 'accepted' ? 1 : 0,
        rejected: holes.decision === 'accepted' || holes.decision === 'no_holes' || holes.decision === 'no_images' ? 0 : 1, ms: timingsMs.holes,
        notes: [holes.holePixels
            ? `${holes.holePixels} black texel${holes.holePixels === 1 ? '' : 's'} the model's own generation never covered: ${holes.decision === 'accepted' ? `${holes.filledPixels} filled by ${holes.modelUsed} (generated)` : `left as the model built them (${holes.reason ?? holes.decision})`}`
            : 'no black holes in the model\'s own texture']
    });

    const fitted = applyRootTransform(painted, best.fit.matrix);
    const texturedGlb = path.join(input.dir, 'pipeline_i_textured.glb'), clayGlb = path.join(input.dir, 'pipeline_i_clay.glb');
    fs.writeFileSync(texturedGlb, fitted); fs.writeFileSync(clayGlb, stripMaterials(fitted));
    timingsMs.total = now() - t0;
    return {
        files: { texturedGlb, clayGlb, modelGlb: best.raw, sheetPng, sheetReferencePng, views },
        plan: { axisDeg: plan.axisDeg, wallAreaM2: plan.wallAreaM2, pair: plan.pair, heightM: plan.heightM },
        sheet: { accepted: sheet.accepted, attempts: sheet.attempts, modelUsed: sheet.modelUsed, panels: sheet.panels.map(p => ({ stationId: p.station.id, passed: p.qc.passed, reason: p.qc.reason, overflow: p.qc.outline?.overflow, underfill: p.qc.outline?.underfill })) },
        model: { model: best.result.model, requestId: best.result.requestId, seconds: best.result.seconds, seed: best.seed },
        ...(holes ? { holes } : {}),
        candidates: candidates.map(c => (c.ok ? { seed: c.seed, requestId: c.result.requestId, score: c.score, fit: { planIoU: c.fit.planIoU, overflowShare: c.fit.overflowShare, coverage: c.fit.coverage } } : { seed: c.seed, error: c.error })),
        swatch: { ...swatch, before: matched.before },
        fit, steps, timingsMs
    };
}
