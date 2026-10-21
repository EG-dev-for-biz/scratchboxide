/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F round 3 (experiment; SCRATCHBOX_STAGED_GEOMETRY=f with pipeline E, the default round; SCRATCHBOX_VERSION_F_ROUND=2
 * runs round 2's f2.ts instead): version F's procedural geometry with pipeline E's AI wall redraw, scheduled as a graph.
 *
 *   survey ─────────────────────────────┐
 *   read (one call per wall, at once) ─ generate ─ check ─ adjust (native, every wall at once) ─ [clay shape shown] ─┤
 *                                                                                                                  ├─ Street View refinement of the lattices ─ structure guides ─ redraw every wall at once, best of 3 ─ [textures streamed per wall] ─ unseen walls ─ layer
 *
 *   1. The Street View survey enhanced mode runs (registered, cut out) starts at once and is not awaited until the redraw
 *      needs its crops; the reading does not wait for it (it sees the tile's pictures; the survey's photos join the reading
 *      only when the survey was already in, e.g. from the cache).
 *   2. planVersionF3 (version-f.ts): read per wall, generate, check, adjust on the native kernel. The clay shape is handed to
 *      `onLayer` as soon as it exists (the orchestrator commits it; the plates replace its textured twin as they land).
 *   3. Where a registered photo covers a wall, its crop is the wall's luminance evidence and that wall's lattice is searched
 *      again (refineWithStreetView); the solid is rebuilt when a wall moved.
 *   4. Every seen wall is redrawn at once (f3-redraw.ts: 3 plates per wall, the local gates, the image-call governor's 429
 *      back-off), then the unseen walls with a finished wall as their reference. Accepted texels are `generated`.
 *   5. Agreement: each accepted plate is compared with F's openings (window NCC on the plate, edge distance), recorded. The
 *      plate follows F: round 2 built F following the plates as well and chose by render-compare; F as planned won 3 of 4
 *      places and tied the fourth (0.449 against 0.447), so the second build is gone.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ProvenanceRecord } from '../../../../common/spatial/staged-location-contracts';
import { reviewUnknownCodes } from '../../../../common/spatial/sb-feature-types';
import { renderFrameDepth } from '../../../spatial/StreetViewPoseRegistrar';
import { encodePng } from '../png-encode';
import { readTileTriangles } from '../tile-texture-transfer';
import { baseLegend, medianColour, SRC } from '../pipeline-e/face-textures';
import type { FaceTexture, TexelSource } from '../pipeline-e/massing-glb';
import { readFaceOrtho, type MassingFace, type MassingNode, type MassingRun } from '../pipeline-e/native-massing';
import { plainTextures, writeMassingLayer, LOW_COVERAGE, type MassingLayerFiles } from '../pipeline-e/pipeline-e';
import { enhanceOrder, MAX_UNSEEN_WALLS, MIN_ENHANCE_AREA_M2, MIN_UNSEEN_EXPOSED_SHARE, TEXTURE_PLATE_PROMPT_ID, TEXTURE_PLATE_STREET_VIEW_PROMPT_ID, TEXTURE_PLATE_UNSEEN_PROMPT_ID, type WallStreetView } from '../pipeline-e/enhance';
import { exposedShare, solidGrid } from '../pipeline-e/exposure';
import { labPlanes } from '../pipeline-e/plate-audit';
import { bestStreetViewForWall, rectifiedReference, type GuideView } from '../pipeline-e/plate-streetview';
import { visionFacadeCounter } from '../pipeline-e/plate-identity';
import { parentFace, reframe, writeEnhanceDiagnostic, type InferenceOutcome, type StepRecord } from '../pipeline-e/inference';
import type { F2Input, PlateAgreement } from './f2';
import { STRUCTURE_GUIDE_SENTENCE, structureGuidedPlateClient } from './f2';
import { ImageCallGovernor, redrawWallBestOf, SAMPLES, type RedrawWallRecord } from './f3-redraw';
import { featureRegionsOnWall, STRONG_FIT_NCC } from './local-gate';
import { compareWall, wallEvidence, wallTileFromOrtho } from './render-compare';
import { planSummary, planVersionF3, refineWithStreetView, structureGuidePng, versionFProvenance, type StreetViewRefinement, type VersionFPlan3 } from './version-f';
import type { ProgramInput } from './facade-program';
import type { BuildingParameters } from './facade-parameters';

export const VERSION_F3_ID = 'version-f/v3';
/** The textured twin is written again for the walls accepted so far at most this often while the redraw runs. */
export const STREAM_INTERVAL_MS = 12_000;

/** Which round runs under SCRATCHBOX_STAGED_GEOMETRY=f: 3 (default) or 2. */
export function versionFRound(env: NodeJS.ProcessEnv = process.env): 2 | 3 {
    return (env.SCRATCHBOX_VERSION_F_ROUND ?? '').trim() === '2' ? 2 : 3;
}

export interface F3Input extends F2Input {
    /** Told of the layer files as they exist: the clay shape right after the adjustment, then the textured twin as walls land, then the final layer. */
    onLayer?: (files: MassingLayerFiles, phase: 'shape' | 'textures' | 'final', note: string) => void;
    /** Real objects the residual audit found on the roof (plan boxes), for the raised volumes. */
    roofClusters?: ProgramInput['roofClusters'];
    /** Skip the reading and use these parameters (tests, replays). */
    reading?: BuildingParameters;
}

export interface F3Outcome extends InferenceOutcome {
    versionF: ReturnType<typeof planSummary> & { reading: VersionFPlan3['reading']; plan: VersionFPlan3['timingsMs']; adjustNative: VersionFPlan3['adjustNative'] };
    redraw: RedrawWallRecord[];
    agreement: PlateAgreement[];
    streetViewRefinement?: StreetViewRefinement;
    gates: { lattice: { walls: number; accepted: number; rejected: number }; vision: { walls: number; accepted: number; rejected: number }; features: { regions: number; wallsRejected: number; lost: string[] }; audit: { rejected: number }; samplesDrawn: number; samplesEligible: number };
    images: ImageCallGovernor['counts'];
    /** The schedule: milestones in ms from the start. */
    schedule: Array<{ atMs: number; event: string }>;
    unknownFeatureCodes: string[];
}

const now = () => Date.now();

/** Version F's geometry with pipeline E's enhanced texturing, round 3 (see the file comment). */
export async function runVersionF3(input: F3Input): Promise<F3Outcome> {
    const { run, massing } = input;
    const faces = run.report.faces;
    const t00 = now();
    const schedule: F3Outcome['schedule'] = [];
    const mark = (event: string) => { schedule.push({ atMs: now() - t00, event }); input.onProgress?.(`version F: ${event}`); };
    const steps: StepRecord[] = [];
    const timingsMs: Record<string, number> = {};
    const rec = (step: string): StepRecord => { const r: StepRecord = { step, proposed: 0, accepted: 0, rejected: 0, notes: [], ms: 0 }; steps.push(r); return r; };
    fs.mkdirSync(input.dir, { recursive: true });
    const chain = input.chain;
    const enh = input.enhance;
    const guards = enh ? enh.guards !== false : false;

    // 1. the survey starts now and is awaited only when the redraw needs it
    let noGuide: string | undefined = guards ? (enh?.streetViews ? undefined : 'no Street View source') : undefined;
    let surveyMs = 0;
    const surveyStart = now();
    const surveyP: Promise<GuideView[]> = enh?.streetViews && guards
        ? enh.streetViews().then(got => { surveyMs = now() - surveyStart; mark(`Street View survey in (${got.length} registered views)`); return input.structureMesh ? got.map(v => ({ ...v, depth: renderFrameDepth(input.structureMesh!, v.camera as never) })) : got; },
            err => { if (input.signal?.aborted) throw err; surveyMs = now() - surveyStart; noGuide = `the Street View survey failed (${(err as Error).message.slice(0, 160)})`; mark(noGuide); return [] as GuideView[]; })
        : Promise.resolve([] as GuideView[]);
    surveyP.catch(() => undefined);
    mark('Street View survey started');

    // 2. version F's plan (the reading per wall, the native adjustment); the clay shape is handed over at once
    let t = now();
    const fStep = rec('version-f');
    // the survey's photos join the reading only when the survey is already in (nothing waits for it)
    const early = await Promise.race([surveyP.then(v => v), new Promise<undefined>(r => setTimeout(() => r(undefined), 0))]);
    const photos = (early ?? []).filter(v => v.registration && v.registration.method !== 'nominal').slice(0, 2).map(v => ({ bytes: new Uint8Array(encodePng(v.image.width, v.image.height, Buffer.from(v.image.rgba), 4)), mimeType: 'image/png', caption: 'A Street View photo of the building from its street.' }));
    const plan = await planVersionF3({ place: input.place, massing, tilePath: input.tilePath, isolateGlb: input.isolateGlb, outDir: path.join(input.dir, 'version_f3'), ...(chain ? { chain } : {}), streetViewPhotos: photos, run0: run, rounds: 3, ...(input.reading ? { reading: input.reading } : {}), ...(input.roofClusters ? { roofClusters: input.roofClusters } : {}), onProgress: m => input.onProgress?.(m) });
    timingsMs.versionF = now() - t;
    mark(`shape planned: read ${plan.timingsMs.read} ms (${plan.reading.walls?.length ?? 0} wall readings${photos.length ? ', with Street View photos' : ''}), adjust ${plan.timingsMs.adjust} ms (native ${plan.adjustNative.ms} ms, ${plan.adjustNative.evaluations} evaluations, ${plan.adjustNative.batches} batches)`);
    const unknownFeatureCodes = reviewUnknownCodes([...new Set((plan.reading.params.featureRegions ?? []).flatMap(x => x.types))], code => input.onProgress?.(`version F: feature type code ${code} is not in the catalogue (kept as a label, logged for review)`));
    const summary0 = planSummary(plan);
    fStep.proposed = 1; fStep.accepted = 1; fStep.ms = timingsMs.versionF;
    fStep.notes.push(...summary0.program.notes, `read per wall by ${plan.reading.model ?? 'given parameters'} (${plan.reading.promptId}; ${(plan.reading.walls ?? []).map(w => `wall ${w.face} ${w.failed ? `failed: ${w.failed}` : `${w.ms} ms, ${w.features} features`}`).join(', ')}); window NCC ${plan.before.summary.windowNcc.toFixed(3)} -> ${plan.after.summary.windowNcc.toFixed(3)}, wall depth ${plan.before.summary.wallDepthMaeM.toFixed(3)} -> ${plan.after.summary.wallDepthMaeM.toFixed(3)} m after the native adjustment (${plan.adjustNative.ms} ms)`);

    // the textures: the massing's tile orthos, reframed onto F's faces (the plain tile twin until the plates land)
    const legend: TexelSource[] = [...baseLegend()];
    const textures = new Map<number, FaceTexture>();
    for (const [k, v] of input.textures) textures.set(k, { width: v.width, height: v.height, rgba: new Uint8Array(v.rgba), source: new Uint8Array(v.source) });
    const provenanceOf = (n: MassingNode): ProvenanceRecord => ({ ...versionFProvenance(n, plan.ctx), sources: [{ kind: 'stage-output', id: VERSION_F3_ID }] });
    const layerOf = (r: MassingRun, name: string) => {
        const tex2 = new Map<number, FaceTexture>();
        const plain2 = plainTextures(r).textures;
        for (const f2 of r.report.faces) {
            const f1 = parentFace(faces, f2.key);
            const t1 = f1 ? textures.get(f1.index) : undefined;
            if (t1 && f1 && f2.width) tex2.set(f2.index, reframe(t1, f1, f2));
            else if (plain2.has(f2.index)) tex2.set(f2.index, plain2.get(f2.index)!);
        }
        return { files: writeMassingLayer(r, massing, tex2, legend, input.dir, input.stage, input.stageKey, name, provenanceOf), tex2 };
    };
    t = now();
    const shape = layerOf(plan.runB, 'version_f3');
    timingsMs.shapeLayer = now() - t;
    mark(`clay shape written (${timingsMs.shapeLayer} ms)`);
    input.onLayer?.(shape.files, 'shape', `version F's shape after the native adjustment (window NCC ${plan.after.summary.windowNcc.toFixed(3)}); textures: the tile photo until the walls are redrawn`);

    // 3. the survey, then the Street View refinement of the lattices
    const guide = await surveyP;
    timingsMs.streetView = surveyMs;
    let refinement: StreetViewRefinement | undefined;
    if (guide.length) {
        t = now();
        const isoSoup = readTileTriangles(fs.readFileSync(input.isolateGlb)).positions;
        refinement = await refineWithStreetView({ place: input.place, massing, tilePath: input.tilePath, isolateGlb: input.isolateGlb, outDir: path.join(input.dir, 'version_f3') }, plan, guide, isoSoup, m => input.onProgress?.(m));
        timingsMs.streetViewRefine = now() - t;
        mark(`Street View refinement: ${refinement.walls.length} walls with a crop, ${refinement.walls.filter(w => w.moved).length} moved${refinement.rebuilt ? ', rebuilt' : ''} (${refinement.ms} ms)`);
        fStep.notes.push(...refinement.walls.map(w => `wall ${w.face}: Street View ${w.panoId} covers ${(100 * w.validShare).toFixed(0)}% at ${w.pxPerM} px/m${w.moved ? `; lattice moved: ${w.moved} (objective ${w.before} -> ${w.after})` : '; lattice kept'}`));
    } else if (noGuide) fStep.notes.push(`no Street View refinement: ${noGuide}`);
    const summary = planSummary(plan);

    // 4. the redraw: every seen wall at once, best of SAMPLES, then the unseen walls
    const enhanced: RedrawWallRecord[] = [];
    const plates = new Map<number, { plate: Uint8Array; use: Uint8Array; unseen: boolean }>();
    const enhStep = rec('enhance');
    const governor = new ImageCallGovernor();
    const gates: F3Outcome['gates'] = { lattice: { walls: 0, accepted: 0, rejected: 0 }, vision: { walls: 0, accepted: 0, rejected: 0 }, features: { regions: 0, wallsRejected: 0, lost: [] }, audit: { rejected: 0 }, samplesDrawn: 0, samplesEligible: 0 };
    let streamed = 0, lastStreamAt = 0, streaming: Promise<void> = Promise.resolve(), streamDue = false;
    const guides = new Map<number, { png: Buffer; offset: Float32Array }>();
    const guideOf = (f: MassingFace) => { let g = guides.get(f.index); if (!g) { g = structureGuidePng(plan, f); guides.set(f.index, g); fs.writeFileSync(path.join(input.dir, `wall_${f.index}_structure.png`), g.png); } return g; };
    t = now();
    if (enh) {
        const ENH = legend.length;
        legend.push({ source: 'ai-enhanced', label: 'generated', method: `AI-enhanced from tile, guided by version F's structure, best of ${SAMPLES} (${enh.models.join(', ')}, ${TEXTURE_PLATE_PROMPT_ID})`, rung: 4, weight: 0.2 });
        const UNSEEN = legend.length;
        legend.push({ source: 'ai-generated-unseen', label: 'generated', method: `drawn by an image model where the tile has no photo of the wall, guided by version F's structure (${enh.models.join(', ')}, ${TEXTURE_PLATE_UNSEEN_PROMPT_ID})`, rung: 4, weight: 0.1 });
        const order = enhanceOrder(faces, textures, LOW_COVERAGE).sort((p, q) => q.area - p.area).slice(0, enh.maxWalls ?? 8);
        const unseenOrder: MassingFace[] = [];
        {
            const grid = solidGrid(run.nodes);
            const cands = faces.filter(f => f.kind === 'wall' && f.width > 0 && textures.has(f.index) && f.area >= MIN_ENHANCE_AREA_M2 && f.coverage < LOW_COVERAGE).map(f => ({ f, exposed: exposedShare(f, grid, run.dir) }));
            unseenOrder.push(...cands.filter(c => c.exposed >= MIN_UNSEEN_EXPOSED_SHARE).sort((a, b) => b.f.area * b.exposed - a.f.area * a.exposed).slice(0, MAX_UNSEEN_WALLS).map(c => c.f));
        }
        const facadeRgb = medianColour(faces.filter(f => f.kind === 'wall' && f.coverage >= LOW_COVERAGE).map(f => textures.get(f.index)).filter((x): x is FaceTexture => !!x));
        const familyLab = facadeRgb ? (() => { const [L, A, B] = labPlanes(new Uint8Array([...facadeRgb, 255]), 1); return [L[0], A[0], B[0]] as [number, number, number]; })() : undefined;
        const svSource = new Map<string, number>();
        const sourceForPano = (panoId: string): number => {
            let k = svSource.get(panoId);
            if (k === undefined) { k = legend.length; legend.push({ source: 'ai-enhanced+street-view', label: 'generated', method: `AI-enhanced from tile, guided by Street View ${panoId} and version F's structure (${enh.models.join(', ')}, ${TEXTURE_PLATE_STREET_VIEW_PROMPT_ID})`, rung: 4, weight: 0.25 }); svSource.set(panoId, k); }
            return k;
        };
        const insideOf = (f: MassingFace): Uint8Array | undefined => { try { const b = fs.readFileSync(path.join(run.dir, `face_${f.index}.inside`)); return b.length === f.width * f.height ? new Uint8Array(b) : undefined; } catch { return undefined; } };
        const finished: MassingFace[] = [];
        // the textured twin written again for the walls accepted so far (one write at a time, the latest state, paced)
        const stream = (final = false) => {
            streamDue = true;
            streaming = streaming.then(async () => {
                if (!streamDue) return;
                const wait = final ? 0 : Math.max(0, lastStreamAt + STREAM_INTERVAL_MS - now());
                if (wait) await new Promise(r => setTimeout(r, wait));
                if (!streamDue) return;
                streamDue = false;
                const ts = now();
                const files = layerOf(plan.runB, 'version_f3').files;
                lastStreamAt = now(); streamed++;
                timingsMs.streamWrites = (timingsMs.streamWrites ?? 0) + (lastStreamAt - ts);
                mark(`textured twin written with ${plates.size} walls redrawn (${lastStreamAt - ts} ms)`);
                input.onLayer?.(files, 'textures', `${plates.size} walls redrawn so far`);
            }).catch(err => input.onProgress?.(`version F: a streamed texture write failed (${(err as Error).message})`));
        };
        const redrawOne = async (f: MassingFace, unseen = false) => {
            const tex = textures.get(f.index)!;
            const use = new Uint8Array(tex.width * tex.height);
            for (let i = 0; i < use.length; i++) use[i] = tex.source[i] === SRC.tileOrtho ? 1 : 0;
            // a seen wall is drawn with no finished reference (all at once); an unseen wall references a finished neighbour
            const ref = unseen ? (finished.find(d => d.part === f.part && d.loop === f.loop && Math.abs(d.edge - f.edge) === 1) ?? finished[0]) : undefined;
            const refTex = ref ? textures.get(ref.index)! : undefined;
            let sv: WallStreetView | undefined, noSv = noGuide;
            if (guards && guide.length) {
                const best = bestStreetViewForWall(f, guide);
                if (best.view && best.rect) sv = { view: best.view, rect: best.rect, crop: rectifiedReference(best.rect, tex.width, tex.height), why: best.why };
                else noSv = best.why;
            }
            const structure = guideOf(f);
            const sh = crypto.createHash('sha256').update(structure.png).update(STRUCTURE_GUIDE_SENTENCE).digest('hex').slice(0, 16);
            const wallAfter = plan.after.walls.find(w => w.face === f.index);
            const tileNcc = wallAfter?.windowNcc ?? 0, tileEdgeDistM = wallAfter?.edgeDistM ?? NaN;
            const features = featureRegionsOnWall(plan.reading.params.featureRegions, f);
            gates.features.regions += features.length;
            const before = tex.rgba.slice();
            const r = await redrawWallBestOf(f, tex, use, {
                client: structureGuidedPlateClient(input.genai, structure.png), models: enh.models, locationName: enh.locationName, ...(refTex ? { reference: refTex } : {}), source: ENH,
                guards, ...(enh.cacheDir ? { cacheDir: path.join(enh.cacheDir, `version-f3-${sh}`) } : {}), ...(sv ? { streetView: sv, streetViewSource: sourceForPano(sv.view.panoId) } : {}), ...(noSv ? { noStreetView: noSv } : {}),
                ...(chain ? { counter: visionFacadeCounter(chain) } : {}), ...(input.signal ? { signal: input.signal } : {}), governor,
                ...(unseen ? {} : { fit: { planned: structure.offset, tileNcc, tileEdgeDistM } }), features,
                ...(unseen ? { unseen: { source: UNSEEN, ...(familyLab ? { familyLab } : {}), ...(insideOf(f) ? { inside: insideOf(f)! } : {}) } } : {}),
                onProgress: m => input.onProgress?.(`version F: ${m}`)
            });
            enhanced.push({ ...r, plate: undefined, guarded: undefined, labels: undefined, grid: undefined } as RedrawWallRecord);
            enhStep.proposed++;
            gates.samplesDrawn += r.samples.length; gates.samplesEligible += r.samples.filter(s => !s.rejected).length;
            const g = r.countGate === 'lattice' ? gates.lattice : r.countGate === 'vision' ? gates.vision : undefined;
            if (g) { g.walls++; if (r.accepted) g.accepted++; else g.rejected++; }
            if (!r.accepted && r.samples.every(s => s.features?.some(x => !x.kept))) { gates.features.wallsRejected++; }
            for (const s of r.samples) for (const x of s.features ?? []) if (!x.kept) gates.features.lost.push(`wall ${f.index} sample ${s.sample}: ${x.why}`);
            if (!r.accepted && r.samples.some(s => s.audit && s.audit.flaggedShare > 0.35)) gates.audit.rejected++;
            if (r.accepted) { enhStep.accepted++; finished.push(f); plates.set(f.index, { plate: tex.rgba.slice(), use, unseen }); mark(`wall ${f.index} redrawn (sample ${r.chosen}, ${r.countGate} gate, ${r.ms} ms)`); stream(); } else { enhStep.rejected++; mark(`wall ${f.index} kept its tile texture (${r.countGate} gate)`); }
            enhStep.notes.push(`wall ${f.index}: ${r.accepted ? (unseen ? 'drawn' : 'enhanced') : 'kept its tile texture'}: ${r.why.slice(0, 600)}${r.model ? ` (${r.model})` : ''}`);
            try { if (r.plate) writeEnhanceDiagnostic(path.join(input.dir, `wall_${f.index}_tile_vs_enhanced.png`), before, r.plate, r.guarded, r.labels, r.grid, sv?.rect.rgba, sv?.rect.valid, tex.width, tex.height); } catch { /* diagnostics only */ }
        };
        mark(`redrawing ${order.length} seen walls at once, ${SAMPLES} plates each`);
        await Promise.all(order.map(f => redrawOne(f)));
        if (unseenOrder.length) { mark(`drawing ${unseenOrder.length} unseen walls`); await Promise.all(unseenOrder.map(f => redrawOne(f, true))); }
        streamDue = false;
        await streaming;
    } else enhStep.skipped = 'enhanced mode is off';
    timingsMs.enhance = now() - t;
    enhStep.ms = timingsMs.enhance;
    enhStep.notes.push(`image calls: ${governor.counts.calls}, rate-limited ${governor.counts.rateLimited}, retried ${governor.counts.retried}, waited ${governor.counts.waitedMs} ms, peak in flight ${governor.counts.peakInFlight}`);
    enhStep.notes.push(`gates: lattice (strong fit, NCC >= ${STRONG_FIT_NCC}) ${gates.lattice.accepted}/${gates.lattice.walls} accepted, vision count ${gates.vision.accepted}/${gates.vision.walls}, features ${gates.features.regions} regions on walls, ${gates.features.wallsRejected} walls lost their only eligible plates to a feature; samples ${gates.samplesEligible}/${gates.samplesDrawn} eligible`);

    // 5. agreement of each plate with F's openings (recorded; the plate follows F)
    t = now();
    const agreeStep = rec('plate-agreement');
    const agreement: PlateAgreement[] = [];
    for (const [fi, pl] of plates) {
        const f = faces[fi];
        if (pl.unseen || !plan.prog.walls.some(w => w.face === fi && w.openings > 0)) continue;
        const o = readFaceOrtho(run.dir, f);
        if (!o) continue;
        const plateTile = wallTileFromOrtho(f, Uint8Array.from(pl.plate, (v, i) => (i % 4 === 3 ? 255 : v)), o.depth);
        const c = compareWall(wallEvidence(plateTile), guideOf(f).offset);
        agreement.push({ face: fi, key: f.key, plateNcc: c.windowNcc, plateEdgeDistM: c.edgeDistM, followNcc: c.windowNcc, followEdgeDistM: c.edgeDistM });
        agreeStep.proposed++; agreeStep.accepted++;
        agreeStep.notes.push(`wall ${fi}: F's openings on the plate: window NCC ${c.windowNcc.toFixed(3)}, edge distance ${c.edgeDistM.toFixed(3)} m`);
    }
    agreeStep.notes.push('the plate follows F (round 2: F as planned beat F following the plates on 3 of 4 places and tied the fourth; no second build)');
    agreeStep.ms = now() - t;
    timingsMs.agreement = agreeStep.ms;

    // the layer
    t = now();
    const main = layerOf(plan.runB, 'version_f3');
    timingsMs.glb = now() - t;
    mark('final layer written');
    input.onLayer?.(main.files, 'final', `${plates.size} walls redrawn`);
    const outcome: F3Outcome = {
        files: main.files, run: plan.runB, steps, legend, grammars: [], timingsMs, enhanced: enhanced.map(r => ({ face: r.face, key: r.key, accepted: r.accepted, why: r.why, ...(r.model ? { model: r.model } : {}), ms: r.ms, ...(r.chamferPx !== undefined ? { chamferPx: r.chamferPx } : {}), ...(r.lostShare !== undefined ? { lostShare: r.lostShare } : {}), ...(r.identity ? { identity: r.identity } : {}), ...(r.audit ? { audit: r.audit } : {}), ...(r.streetView ? { streetView: r.streetView } : {}), ...(r.noStreetView ? { noStreetView: r.noStreetView } : {}) })),
        build: { parts: plan.prog.parts, sweeps: plan.prog.sweeps, openings: plan.prog.openings },
        textures: main.tex2, occluderMasks: new Map(),
        versionF: { ...summary, reading: plan.reading, plan: plan.timingsMs, adjustNative: plan.adjustNative }, redraw: enhanced, agreement, ...(refinement ? { streetViewRefinement: refinement } : {}),
        gates, images: governor.counts, schedule, unknownFeatureCodes
    };
    timingsMs.total = now() - t00;
    timingsMs.streamed = streamed;
    fs.writeFileSync(path.join(input.dir, 'version_f3.json'), JSON.stringify({ ...outcome, files: main.files, run: undefined, textures: undefined, occluderMasks: undefined, legend: undefined, redraw: enhanced.map(r => ({ ...r, samples: r.samples.map(s => ({ ...s, lattice: s.lattice ? { ...s.lattice, profiles: undefined } : undefined })) })) }, null, 1));
    return outcome;
}
