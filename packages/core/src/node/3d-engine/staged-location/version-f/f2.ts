/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F round 2 (experiment; SCRATCHBOX_STAGED_GEOMETRY=f with pipeline E, in the grammar stage's slot): version F's
 * geometry with pipeline E's enhanced texturing on it.
 *
 *   1. The Street View survey enhanced mode runs anyway (registered, cut out) is awaited first; its two best photos join the
 *      version F reading (with the round-2 shape vocabulary: arch heads, bands of openings, per-wall storeys).
 *   2. planVersionF: read, generate (residual off), check, adjust.
 *   3. Pipeline E's enhanced redraw (enhance.ts: Nano Banana Lite plates, buildTexturePlatePrompt, the identity gate, the
 *      region audit, Street View guidance, the unseen walls) on the massing's walls, which version F shares one to one (its
 *      faces are the same planes and frames), each redraw also shown F's planned structure of that wall (openings dark,
 *      bands and piers light) as a guide. Accepted texels are `generated`.
 *   4. Agreement: each accepted plate is compared with F's openings on that wall (window NCC on the plate, edge distance).
 *      F is then let follow the plate (per wall: bay pitch and phase and storey lines searched against the plate) and the
 *      two are compared against the tile from the same cameras; the one closer to the tile is the layer, the other is
 *      written beside it (`version_f2_alt_*`) so it can be judged too.
 *
 * Pipeline E's other texture repairs (occluder fill, averaged bays, straightening, Street View colour) are not run here.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { ProvenanceRecord } from '../../../../common/spatial/staged-location-contracts';
import { nearestImageAspectRatio } from '../../../../common/media-generation-protocol';
import { generateImageWithModels } from '../../../google-media-generation-service';
import { renderFrameDepth } from '../../../spatial/StreetViewPoseRegistrar';
import { encodePng } from '../png-encode';
import { readTileTriangles } from '../tile-texture-transfer';
import { baseLegend, medianColour, SRC } from '../pipeline-e/face-textures';
import type { FaceTexture, TexelSource } from '../pipeline-e/massing-glb';
import { readFaceOrtho, runMassing, type MassingFace, type MassingNode, type MassingRun } from '../pipeline-e/native-massing';
import { massingSpecText } from '../pipeline-e/massing-spec';
import { plainTextures, writeMassingLayer, LOW_COVERAGE } from '../pipeline-e/pipeline-e';
import { enhanceOrder, enhanceWall, ENHANCE_CONCURRENCY, MAX_UNSEEN_WALLS, MIN_ENHANCE_AREA_M2, MIN_UNSEEN_EXPOSED_SHARE, TEXTURE_PLATE_PROMPT_ID, TEXTURE_PLATE_STREET_VIEW_PROMPT_ID, TEXTURE_PLATE_UNSEEN_PROMPT_ID, type EnhanceWallRecord, type PlateModelClient, type WallStreetView } from '../pipeline-e/enhance';
import { exposedShare, solidGrid } from '../pipeline-e/exposure';
import { labPlanes } from '../pipeline-e/plate-audit';
import { bestStreetViewForWall, rectifiedReference, type GuideView } from '../pipeline-e/plate-streetview';
import { visionFacadeCounter } from '../pipeline-e/plate-identity';
import { parentFace, reframe, writeEnhanceDiagnostic, type InferenceInput, type InferenceOutcome, type StepRecord } from '../pipeline-e/inference';
import { evaluate } from './adjust';
import { facadeProgram, LABEL, type WallLatticeAdjust } from './facade-program';
import { compareWall, downsampleWallTile, programWallOffset, renderedWallOffset, nodesToSoup, wallEvidence, wallTileFromOrtho, type WallCompare } from './render-compare';
import { check, planSummary, planVersionF, structureGuidePng, versionFProvenance, VERSION_F_NATIVE_PARAMS, ADJUST_PIXEL_M, type CheckNumbers, type StreetViewPhoto, type VersionFPlan } from './version-f';

export const VERSION_F2_ID = 'version-f/v2';

/** SCRATCHBOX_STAGED_GEOMETRY=f: pipeline E's grammar stage builds version F's geometry instead of E's inference (experiment). */
export function stagedGeometryF(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env.SCRATCHBOX_STAGED_GEOMETRY ?? '').trim().toLowerCase() === 'f';
}

/** The sentence the redraw is given with F's structure picture. */
export const STRUCTURE_GUIDE_SENTENCE = 'Last image: the procedural model of this same wall in the same frame (dark: its window and door openings, light: its projecting bands, cornices and piers, black: outside the wall). It shows shape only: take no colour, tone or material from it. Keep the first image\'s openings where it shows them; where it is smeared, unclear or missing, place the openings, bands and piers as this model does.';

/** The plate client with F's structure picture appended (the production client's parts, then the structure). */
export function structureGuidedPlateClient(genai: unknown, structurePng: Uint8Array): PlateModelClient {
    return async r => {
        const parts: unknown[] = [{ text: `${r.prompt}\n${STRUCTURE_GUIDE_SENTENCE}` }, { inlineData: { mimeType: 'image/png', data: Buffer.from(r.image).toString('base64') } }];
        if (r.reference) parts.push({ text: 'Second image: the adjacent wall, already finished (reference for materials only).' }, { inlineData: { mimeType: 'image/png', data: Buffer.from(r.reference).toString('base64') } });
        if (r.streetView) parts.push({ text: `${r.reference ? 'Third' : 'Second'} image: a street-level photograph of this wall (Google Street View), resampled onto the first image's frame; grey where it does not show the wall.` }, { inlineData: { mimeType: 'image/png', data: Buffer.from(r.streetView).toString('base64') } });
        parts.push({ text: 'Last image: the procedural model of this wall (structure guide: shape only, no colours).' }, { inlineData: { mimeType: 'image/png', data: Buffer.from(structurePng).toString('base64') } });
        const a = await generateImageWithModels(genai, { models: r.models, contents: [{ role: 'user', parts }], imageConfig: { aspectRatio: nearestImageAspectRatio(r.width, r.height) }, ...(r.signal ? { signal: r.signal } : {}) } as never);
        return { bytes: new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength), modelUsed: a.modelUsed };
    };
}

export interface F2Input extends InferenceInput {
    place: string;
    /** The Gen AI client the plates are drawn with (the structure-guided client wraps it). */
    genai: unknown;
}

export interface PlateAgreement { face: number; key: string; plateNcc: number; plateEdgeDistM: number; followNcc: number; followEdgeDistM: number; follow?: WallLatticeAdjust }

export interface F2Outcome extends InferenceOutcome {
    versionF: ReturnType<typeof planSummary> & { reading: VersionFPlan['reading']; plan: VersionFPlan['timingsMs'] };
    agreement: PlateAgreement[];
    choice: { chosen: 'plate-follows-F' | 'F-follows-plate'; why: string; againstTile: { plateFollowsF: CheckNumbers['summary']; fFollowsPlate?: CheckNumbers['summary'] } };
    altFiles?: { clayGlb: string; texturedGlb: string };
}

const now = () => Date.now();

/** Version F's geometry with pipeline E's enhanced texturing (see the file comment). */
export async function runVersionFEnhanced(input: F2Input): Promise<F2Outcome> {
    const { run, massing } = input;
    const faces = run.report.faces;
    const progress = (m: string) => input.onProgress?.(`version F: ${m}`);
    const steps: StepRecord[] = [];
    const timingsMs: Record<string, number> = {};
    const rec = (step: string): StepRecord => { const r: StepRecord = { step, proposed: 0, accepted: 0, rejected: 0, notes: [], ms: 0 }; steps.push(r); return r; };
    fs.mkdirSync(input.dir, { recursive: true });
    const chain = input.chain;
    const enh = input.enhance;

    // 1. the Street View survey (registered, cut out), then the reading's photos
    let t = now();
    const guards = enh ? enh.guards !== false : false;
    let guide: GuideView[] = [];
    let noGuide: string | undefined = guards ? (enh?.streetViews ? undefined : 'no Street View source') : undefined;
    if (enh?.streetViews && guards) {
        progress('surveying the facades with Street View');
        try {
            const got = await enh.streetViews();
            guide = input.structureMesh ? got.map(v => ({ ...v, depth: renderFrameDepth(input.structureMesh!, v.camera as never) })) : got;
            if (!guide.length) noGuide = 'no Street View photo of the structure';
        } catch (err) { if (input.signal?.aborted) throw err; noGuide = `the Street View survey failed (${(err as Error).message.slice(0, 160)})`; }
    }
    timingsMs.streetView = now() - t;
    const photos: StreetViewPhoto[] = guide.filter(v => v.registration && v.registration.method !== 'nominal').concat(guide.filter(v => !v.registration || v.registration.method === 'nominal')).slice(0, 2)
        .map(v => ({ bytes: new Uint8Array(encodePng(v.image.width, v.image.height, Buffer.from(v.image.rgba), 4)), mimeType: 'image/png', caption: 'A Street View photo of the building from its street.' }));

    // 2. version F's plan on the massing run (its orthos are the walls' frames; the scan residual is not used)
    t = now();
    const fStep = rec('version-f');
    const plan = await planVersionF({ place: input.place, massing, tilePath: input.tilePath, isolateGlb: input.isolateGlb, outDir: path.join(input.dir, 'version_f'), ...(chain ? { chain } : {}), streetViewPhotos: photos, run0: run, rounds: 3, onProgress: m => input.onProgress?.(m) });
    timingsMs.versionF = now() - t;
    const summary = planSummary(plan);
    fStep.proposed = 1; fStep.accepted = 1; fStep.ms = timingsMs.versionF;
    fStep.notes.push(...summary.program.notes, `read by ${plan.reading.model ?? 'given parameters'} (${plan.reading.promptId}); window NCC ${plan.before.summary.windowNcc.toFixed(3)} -> ${plan.after.summary.windowNcc.toFixed(3)}, wall depth ${plan.before.summary.wallDepthMaeM.toFixed(3)} -> ${plan.after.summary.wallDepthMaeM.toFixed(3)} m after adjustment`);

    // 3. the enhanced redraw on the shared walls, guided by F's structure
    const legend: TexelSource[] = [...baseLegend()];
    const textures = new Map<number, FaceTexture>();
    for (const [k, v] of input.textures) textures.set(k, { width: v.width, height: v.height, rgba: new Uint8Array(v.rgba), source: new Uint8Array(v.source) });
    const enhanced: EnhanceWallRecord[] = [];
    const plates = new Map<number, { plate: Uint8Array; use: Uint8Array; unseen: boolean }>();
    const enhStep = rec('enhance');
    t = now();
    if (enh) {
        const ENH = legend.length;
        legend.push({ source: 'ai-enhanced', label: 'generated', method: `AI-enhanced from tile, guided by version F's structure (${enh.models.join(', ')}, ${TEXTURE_PLATE_PROMPT_ID})`, rung: 4, weight: 0.2 });
        const UNSEEN = legend.length;
        legend.push({ source: 'ai-generated-unseen', label: 'generated', method: `drawn by an image model where the tile has no photo of the wall, guided by version F's structure (${enh.models.join(', ')}, ${TEXTURE_PLATE_UNSEEN_PROMPT_ID})`, rung: 4, weight: 0.1 });
        const order = enhanceOrder(faces, textures, LOW_COVERAGE).sort((p, q) => q.area - p.area).slice(0, enh.maxWalls ?? 8);
        const unseenOrder: MassingFace[] = [];
        {
            const grid = solidGrid(run.nodes);
            const cands = faces.filter(f => f.kind === 'wall' && f.width > 0 && textures.has(f.index) && f.area >= MIN_ENHANCE_AREA_M2 && f.coverage < LOW_COVERAGE).map(f => ({ f, exposed: exposedShare(f, grid, run.dir) }));
            const open = cands.filter(c => c.exposed >= MIN_UNSEEN_EXPOSED_SHARE).sort((a, b) => b.f.area * b.exposed - a.f.area * a.exposed);
            unseenOrder.push(...open.slice(0, MAX_UNSEEN_WALLS).map(c => c.f));
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
        const done: MassingFace[] = [], finished: MassingFace[] = [];
        const enhanceOne = async (f: MassingFace, unseen = false) => {
            const tex = textures.get(f.index)!;
            const use = new Uint8Array(tex.width * tex.height);
            for (let i = 0; i < use.length; i++) use[i] = tex.source[i] === SRC.tileOrtho ? 1 : 0;
            const ref = done.find(d => d.part === f.part && d.loop === f.loop && Math.abs(d.edge - f.edge) === 1) ?? done[0];
            const refTex = ref ? textures.get(ref.index)! : undefined;
            let sv: WallStreetView | undefined, noSv = noGuide;
            if (guards && guide.length) {
                const best = bestStreetViewForWall(f, guide);
                if (best.view && best.rect) sv = { view: best.view, rect: best.rect, crop: rectifiedReference(best.rect, tex.width, tex.height), why: best.why };
                else noSv = best.why;
            }
            const structure = structureGuidePng(plan, f);
            fs.writeFileSync(path.join(input.dir, `wall_${f.index}_structure.png`), structure.png);
            // the plate cache is keyed by what the model is sent: the structure picture and its sentence are part of it
            const sh = crypto.createHash('sha256').update(structure.png).update(STRUCTURE_GUIDE_SENTENCE).digest('hex').slice(0, 16);
            progress(`${unseen ? 'drawing the unseen wall' : 'redrawing wall'} ${f.index} (${Math.round(f.area)} m2) with its procedural structure${sv ? `, guided by Street View ${sv.view.panoId}` : ''}`);
            const before = tex.rgba.slice();
            const r = await enhanceWall(f, tex, use, {
                client: structureGuidedPlateClient(input.genai, structure.png), models: enh.models, locationName: enh.locationName, ...(refTex ? { reference: refTex } : {}), source: ENH,
                guards, ...(enh.cacheDir ? { cacheDir: path.join(enh.cacheDir, `version-f-${sh}`) } : {}), ...(sv ? { streetView: sv, streetViewSource: sourceForPano(sv.view.panoId) } : {}), ...(noSv ? { noStreetView: noSv } : {}),
                ...(chain ? { counter: visionFacadeCounter(chain) } : {}), ...(input.signal ? { signal: input.signal } : {}),
                ...(unseen ? { unseen: { source: UNSEEN, ...(familyLab ? { familyLab } : {}), ...(insideOf(f) ? { inside: insideOf(f)! } : {}) } } : {})
            });
            enhanced.push({ ...r, ...(ref ? { referenceFace: ref.index } : {}), plate: undefined, guarded: undefined, labels: undefined, grid: undefined } as EnhanceWallRecord);
            enhStep.proposed++;
            if (r.accepted) { enhStep.accepted++; finished.push(f); plates.set(f.index, { plate: tex.rgba.slice(), use, unseen }); } else enhStep.rejected++;
            enhStep.notes.push(`wall ${f.index}: ${r.accepted ? (unseen ? 'drawn' : 'enhanced') : 'kept its tile texture'}: ${r.why.slice(0, 300)}${r.model ? ` (${r.model})` : ''}`);
            try { if (r.plate) writeEnhanceDiagnostic(path.join(input.dir, `wall_${f.index}_tile_vs_enhanced.png`), before, r.plate, r.guarded, r.labels, r.grid, sv?.rect.rgba, sv?.rect.valid, tex.width, tex.height); } catch { /* diagnostics only */ }
        };
        for (let k = 0; k < order.length;) {
            const round = order.slice(k, k === 0 ? 1 : k + ENHANCE_CONCURRENCY);
            k += round.length;
            await Promise.all(round.map(f => enhanceOne(f)));
            done.push(...order.filter(f => finished.includes(f) && !done.includes(f)));
        }
        for (let k = 0; k < unseenOrder.length;) {
            const round = unseenOrder.slice(k, k + ENHANCE_CONCURRENCY);
            k += round.length;
            await Promise.all(round.map(f => enhanceOne(f, true)));
            done.push(...unseenOrder.filter(f => finished.includes(f) && !done.includes(f)));
        }
    } else enhStep.skipped = 'enhanced mode is off';
    timingsMs.enhance = now() - t;
    enhStep.ms = timingsMs.enhance;

    // 4. agreement of each plate with F's openings, and F let follow the plates
    t = now();
    const agreeStep = rec('plate-agreement');
    const agreement: PlateAgreement[] = [];
    const follow = new Map(plan.perWall);
    for (const [fi, pl] of plates) {
        const f = faces[fi];
        if (pl.unseen || !plan.prog.walls.some(w => w.face === fi && w.openings > 0)) continue;
        const o = readFaceOrtho(run.dir, f);
        if (!o) continue;
        const plateTile = wallTileFromOrtho(f, Uint8Array.from(pl.plate, (v, i) => (i % 4 === 3 ? 255 : v)), o.depth);
        const ev = wallEvidence(plateTile);
        const now0 = compareWall(ev, structureGuidePng(plan, f).offset);
        // the per-wall lattice and storeys searched against the plate (coarse), the rest of the program as planned
        const coarse = wallEvidence(downsampleWallTile(plateTile, Math.max(1, Math.round(ADJUST_PIXEL_M / f.pixel))));
        const inside = new Map([[fi, Uint8Array.from(renderedWallOffset(nodesToSoup(run.nodes, n => n.kind !== 'residual'), coarse.tile.face), v => (Number.isFinite(v) ? 1 : 0))]]);
        const baseIn = { ...plan.base, params: plan.params };
        const a0 = plan.perWall.get(fi) ?? { pitchScale: 1, phaseM: 0 };
        let best = a0, bestJ = evaluate(baseIn, plan.params, follow, [coarse], inside).objective;
        for (let ps = 0.9; ps <= 1.1001; ps += 0.02) for (let q = -6; q < 6; q++) for (const sh of [-0.5, -0.25, 0, 0.25, 0.5]) {
            const a = { ...a0, pitchScale: (a0.pitchScale ?? 1) * ps, phaseM: (a0.phaseM ?? 0) + (q / 12) * plan.params.bayWidthM, storeyShiftM: (a0.storeyShiftM ?? 0) + sh };
            const j = evaluate(baseIn, plan.params, new Map(follow).set(fi, a), [coarse], inside).objective;
            if (j < bestJ - 2e-3) { bestJ = j; best = a; }
        }
        if (best !== a0) follow.set(fi, best);
        const fprog = facadeProgram({ ...baseIn, perWall: follow });
        const after = compareWall(ev, programWallOffset(f, fprog.openings, fprog.sweeps, fprog.faceSweeps, (() => { const s0 = structureGuidePng(plan, f).offset; return Uint8Array.from(s0, v => (Number.isFinite(v) ? 1 : 0)); })()));
        agreement.push({ face: fi, key: f.key, plateNcc: now0.windowNcc, plateEdgeDistM: now0.edgeDistM, followNcc: after.windowNcc, followEdgeDistM: after.edgeDistM, ...(best !== a0 ? { follow: best } : {}) });
        agreeStep.proposed++;
        if (best !== a0) agreeStep.accepted++;
        agreeStep.notes.push(`wall ${fi}: F's openings on the plate: window NCC ${now0.windowNcc.toFixed(3)}, edge distance ${now0.edgeDistM.toFixed(3)} m; F following the plate: ${after.windowNcc.toFixed(3)}, ${after.edgeDistM.toFixed(3)} m`);
    }
    // the two candidates against the tile, from the same cameras
    const isoSoup = readTileTriangles(fs.readFileSync(input.isolateGlb)).positions;
    const againstF = plan.after.summary;
    let runAlt: MassingRun | undefined, againstAlt: CheckNumbers['summary'] | undefined;
    if (agreement.some(a => a.follow)) {
        const fprog = facadeProgram({ ...plan.base, params: plan.params, perWall: follow });
        const dir = path.join(input.dir, 'native_follow');
        runAlt = await runMassing(massingSpecText({ parts: fprog.parts, meshes: massing.meshes }, { outDir: dir, tile: input.tilePath, isolate: input.isolateGlb, params: { ...VERSION_F_NATIVE_PARAMS, topdown: 0 }, openings: fprog.openings, sweeps: fprog.sweeps, faceSweeps: fprog.faceSweeps, provenance: LABEL.vector }), dir);
        againstAlt = check(runAlt, isoSoup, plan.evidence).summary;
    }
    const score = (c: CheckNumbers['summary']) => (1 - c.windowNcc) / 2 + 0.5 * c.wallDepthMaeM;
    const followWins = !!againstAlt && score(againstAlt) < score(againstF) - 1e-3;
    const choice: F2Outcome['choice'] = {
        chosen: followWins ? 'F-follows-plate' : 'plate-follows-F',
        why: againstAlt ? `against the tile (same cameras): F as planned ${score(againstF).toFixed(3)} (window NCC ${againstF.windowNcc.toFixed(3)}, depth ${againstF.wallDepthMaeM.toFixed(3)} m), F following the plates ${score(againstAlt).toFixed(3)} (${againstAlt.windowNcc.toFixed(3)}, ${againstAlt.wallDepthMaeM.toFixed(3)} m): lower is closer` : 'no plate moved F\'s lattice: F as planned',
        againstTile: { plateFollowsF: againstF, ...(againstAlt ? { fFollowsPlate: againstAlt } : {}) }
    };
    agreeStep.notes.push(`chosen: ${choice.chosen}: ${choice.why}`);
    agreeStep.ms = now() - t;
    timingsMs.agreement = agreeStep.ms;

    // the layer (and the other candidate beside it)
    t = now();
    const ctx = plan.ctx;
    const provenanceOf = (n: MassingNode): ProvenanceRecord => versionFProvenance(n, ctx);
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
    const chosenRun = followWins ? runAlt! : plan.runB;
    const main = layerOf(chosenRun, 'version_f2');
    const alt = runAlt ? layerOf(followWins ? plan.runB : runAlt, 'version_f2_alt') : undefined;
    timingsMs.glb = now() - t;
    const outcome: F2Outcome = {
        files: main.files, run: chosenRun, steps, legend, grammars: [], timingsMs, enhanced,
        build: { parts: (followWins ? facadeProgram({ ...plan.base, params: plan.params, perWall: follow }) : plan.prog).parts, sweeps: plan.prog.sweeps, openings: plan.prog.openings },
        textures: main.tex2, occluderMasks: new Map(),
        versionF: { ...summary, reading: plan.reading, plan: plan.timingsMs }, agreement, choice,
        ...(alt ? { altFiles: { clayGlb: alt.files.clayGlb, texturedGlb: alt.files.texturedGlb } } : {})
    };
    fs.writeFileSync(path.join(input.dir, 'version_f2.json'), JSON.stringify({ ...outcome, files: main.files, run: undefined, textures: undefined, occluderMasks: undefined, legend: undefined, perWallFollow: [...follow].map(([face, a]) => ({ face, ...a })) }, null, 1));
    return outcome;
}

export type { WallCompare };
