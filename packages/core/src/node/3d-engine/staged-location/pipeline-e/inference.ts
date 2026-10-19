/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Pipeline E, step 4: inference, each step verified and labelled photo-inferred (or generated), in the background after
 * the clean textured massing stands.
 *
 *   (a) roof (roof-infer.ts), (b) bands (band-infer.ts), (c) windows (the facade grammar, facade-grammar.ts, read from the
 *   walls' orthos and carved as recesses at the depth the scan's ortho depth measures), then the solid is built again with
 *   them; on the textures: (g) occluder masks (occluders.ts), (d) averaged bays (bay-average.ts), the occluder fill (other
 *   facades, then Nano Banana Lite), (e) the straightened texture (straighten.ts), (f) colour from Street View
 *   (colour-transfer.ts). Every step records what it proposed, accepted and rejected, and why.
 *
 * Steps that need a vision model or Street View are skipped (and say so) without them; the rest still run.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProjectionView } from '../../../../common/spatial/texture-pass-contracts';
import type { Vec2 } from '../../../../common/spatial/staged-location-contracts';
import type { VisionModelChain } from '../../../gemini/vision-model-chain';
import { renderFrameDepth } from '../../../spatial/StreetViewPoseRegistrar';
import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import { grammarCells, runFacadeGrammarPass, type FacadeGrammar, type GrammarFacadeOutcome } from '../facade-grammar';
import { encodePng } from '../png-encode';
import { averageBays, bayGroups } from './bay-average';
import { bandProfile, bandPrompt, decideBands, parapetProfile, parseBandReply, type BandDecision } from './band-infer';
import { colourPairs, transferColour, type ColourResult } from './colour-transfer';
import { baseLegend, fillNearest, SRC } from './face-textures';
import { dilate, medianOf } from './image-ops';
import type { Massing, MassingPart, OpeningItem, SweepItem } from './massing-spec';
import type { FaceTexture, TexelSource } from './massing-glb';
import { readFaceOrtho, type MassingFace, type MassingRun } from './native-massing';
import { boxMask, crownMask, fillFromOtherFacades, holeRects, inpaintFace, occluderPrompt, parseOccluderReply, type Crown } from './occluders';
import { plainTextures, runNativeMassing, writeMassingLayer, LOW_COVERAGE, type MassingLayerFiles } from './pipeline-e';
import { decideRoof, parseRoofReply, roofPrompt, PARAPET_THICKNESS_M, type RoofDecision } from './roof-infer';
import { straighten, type StraightenResult } from './straighten';
import type { EnhanceModelClient } from '../texture-enhance';
import { decodeOrtho, checkAgainstScan, readReliefOrthos } from '../facade-grammar';
import { enhanceOrder, enhanceWall, ENHANCE_CONCURRENCY, TEXTURE_PLATE_PROMPT_ID, type EnhanceWallRecord, type PlateModelClient } from './enhance';

export interface StepRecord { step: string; proposed: number; accepted: number; rejected: number; skipped?: string; notes: string[]; ms: number }

export interface InferenceInput {
    massing: Massing;
    run: MassingRun;
    textures: Map<number, FaceTexture>;
    tilePath: string;
    isolateGlb: string;
    dir: string;
    stage: string;
    stageKey: string;
    chain?: VisionModelChain<string>;
    /** The Street View photos of the structure with their ownership and occluder masks (streetview-ownership.ts). */
    streetViews?: (structure: RenderMesh3D) => Promise<ProjectionView[]>;
    /** The massing as a render mesh (the depth the colour pairs are checked against). */
    structureMesh?: RenderMesh3D;
    crowns?: Crown[];
    inpaint?: { client: EnhanceModelClient; models: string[]; maxRects?: number };
    solar?: Array<{ pitchDeg: number; areaM2: number; x: number; z: number }>;
    anchor?: { x: number; z: number };
    /** Enhanced mode (opt-in): each large wall redrawn once by an image model (enhance.ts), gated on edge alignment. */
    enhance?: { client: PlateModelClient; models: string[]; locationName: string; maxWalls?: number };
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
}

export interface InferenceOutcome {
    files: MassingLayerFiles;
    run: MassingRun;
    steps: StepRecord[];
    legend: TexelSource[];
    grammars: FacadeGrammar[];
    timingsMs: Record<string, number>;
    /** Enhanced mode: per wall redrawn, accepted or not and why. */
    enhanced: EnhanceWallRecord[];
}

/** Legend entries the inference adds after the base ones (face-textures.ts). */
export function inferenceLegend(base: TexelSource[]): { legend: TexelSource[]; BAY: number; OTHER: number; GENERATED: number; COLOURED: number } {
    const legend = [...base];
    const add = (e: TexelSource) => { legend.push(e); return legend.length - 1; };
    const BAY = add({ source: 'averaged-bay', label: 'photo-inferred', method: 'the robust median of the facade grammar\'s repeated bays (co-registered tile photo texels), with this bay\'s own low-frequency colour', rung: 2, weight: 0.4 });
    const OTHER = add({ source: 'other-facade', label: 'photo-inferred', method: 'an occluded texel filled from the same wall a bay pitch along, or from another facade of the building at the same height', rung: 2, weight: 0.25 });
    const GENERATED = add({ source: 'generated-inpaint', label: 'generated', method: 'an occluded texel no real view shows, inpainted by Nano Banana Lite and kept only where it reproduced and joined the real texels around it', rung: 4, weight: 0.1 });
    const COLOURED = add({ source: 'tile-ortho+street-view-colour', label: 'photo-inferred', method: 'the tile ortho with a whole-facade colour map fitted to Street View (pixels the ownership and occluder masks keep), checked held out', rung: 1, weight: 0.5 });
    return { legend, BAY, OTHER, GENERATED, COLOURED };
}

async function askJson<T>(chain: VisionModelChain<string>, png: Buffer, prompt: string, parse: (t: string) => T): Promise<{ value: T; model: string }> {
    const r = await chain.generate({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: png.toString('base64') } }, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0 } }, { stage: 'grammar' });
    const text = r.response.candidates?.[0]?.content?.parts?.map(p => p.text ?? '').join('') ?? '';
    const value = parse(text);
    r.remember();
    return { value, model: r.model };
}

/** Writes the walls' orthos as a relief-orthos index (facade-grammar.ts reads it). */
export function writeWallOrthoIndex(run: MassingRun, minAreaM2 = 80): string {
    const facades = run.report.faces.filter(f => f.kind === 'wall' && f.width > 0 && f.area >= minAreaM2 && fs.existsSync(path.join(run.dir, `ortho_${f.index}.png`))).map(f => ({
        facadeId: f.index, planeIndex: f.index, image: `ortho_${f.index}.png`, area_m2: f.area,
        centroid: [f.origin[0] + f.axisS[0] * (f.sMin + f.sMax) / 2, (f.tMin + f.tMax) / 2, f.origin[2] + f.axisS[2] * (f.sMin + f.sMax) / 2],
        normal: f.normal, axisS: f.axisS, axisT: f.axisT, sMin: f.sMin, sMax: f.sMax, tMin: f.tMin, tMax: f.tMax,
        pixel: f.pixel, texel: f.pixel, width: f.width, height: f.height, orthoSMin: f.orthoSMin, orthoTMax: f.orthoTMax, coverage: f.coverage,
        pattern: '', latticeConfirmation: 0, latticeRejected: false, cells: []
    }));
    fs.writeFileSync(path.join(run.dir, 'facades.json'), JSON.stringify({ schema: 'scratchbox.relief-orthos/1', facades }));
    return run.dir;
}

/** A face texture moved from one frame to another (same face key): nearest sampling by (s, t). */
export function reframe(t: FaceTexture, a: MassingFace, b: MassingFace): FaceTexture {
    if (a.width === b.width && a.height === b.height && Math.abs(a.orthoSMin - b.orthoSMin) < 1e-6 && Math.abs(a.orthoTMax - b.orthoTMax) < 1e-6 && a.pixel === b.pixel) return t;
    const out: FaceTexture = { width: b.width, height: b.height, rgba: new Uint8Array(b.width * b.height * 4), source: new Uint8Array(b.width * b.height).fill(255) };
    for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
        const s = b.orthoSMin + (x + 0.5) * b.pixel, tt = b.orthoTMax - (y + 0.5) * b.pixel;
        const xa = Math.floor((s - a.orthoSMin) / a.pixel), ya = Math.floor((a.orthoTMax - tt) / a.pixel);
        if (xa < 0 || ya < 0 || xa >= a.width || ya >= a.height) continue;
        const i = y * b.width + x, j = ya * a.width + xa;
        out.rgba.set(t.rgba.subarray(j * 4, j * 4 + 4), i * 4);
        out.source[i] = t.source[j];
    }
    fillNearest(out);
    return out;
}

/** Pixel rectangles of a grammar's openings per tier, in a face's ortho. */
function latticePixels(g: FacadeGrammar, f: MassingFace): Array<Array<{ x0: number; x1: number; y0: number; y1: number }>> {
    return g.tiers.map(t => t.cols.map(([s0, s1]) => ({ x0: (s0 - f.orthoSMin) / f.pixel, x1: (s1 - f.orthoSMin) / f.pixel, y0: (f.orthoTMax - t.t1) / f.pixel, y1: (f.orthoTMax - t.t0) / f.pixel })));
}

const now = () => Date.now();

export async function runInferenceE(input: InferenceInput): Promise<InferenceOutcome> {
    const { run, massing } = input;
    const faces = run.report.faces;
    const progress = (m: string) => input.onProgress?.(`pipeline E: ${m}`);
    const steps: StepRecord[] = [];
    const timingsMs: Record<string, number> = {};
    const rec = (step: string): StepRecord => { const r: StepRecord = { step, proposed: 0, accepted: 0, rejected: 0, notes: [], ms: 0 }; steps.push(r); return r; };
    const chain = input.chain;
    const noVision = 'no vision model is configured';
    fs.mkdirSync(input.dir, { recursive: true });

    // ------------------------------------------------------------------ vision readings, all at once
    const tRead = now();
    const topdown = run.report.topdown;
    const roofRead = chain && topdown ? askJson(chain, fs.readFileSync(path.join(run.dir, topdown.image)), roofPrompt(topdown.width * topdown.pixel, topdown.rows * topdown.pixel), parseRoofReply).catch(e => e as Error) : undefined;
    const bandReads = chain ? run.report.sections.map(sec => askJson(chain, fs.readFileSync(path.join(run.dir, sec.image)), bandPrompt(sec), parseBandReply).catch(e => e as Error)) : [];
    const wallFaces = faces.filter(f => f.kind === 'wall' && f.width > 0 && f.area >= 80 && f.coverage >= LOW_COVERAGE);
    const occReads = chain ? wallFaces.map(f => askJson(chain, fs.readFileSync(path.join(run.dir, `ortho_${f.index}.png`)), occluderPrompt(f.width * f.pixel, f.height * f.pixel), parseOccluderReply).catch(e => e as Error)) : [];
    const grammarRead = chain ? runFacadeGrammarPass({ orthosDir: writeWallOrthoIndex(run), chain, ...(input.anchor ? { anchor: input.anchor } : {}), ...(input.signal ? { signal: input.signal } : {}), onProgress: m => progress(m), overlayDir: path.join(input.dir, 'grammar_overlays') }).catch(e => e as Error) : undefined;
    const svRead = input.streetViews && input.structureMesh ? input.streetViews(input.structureMesh).catch(e => e as Error) : undefined;

    // ------------------------------------------------------------------ (a) roof
    let t = now();
    const roofStep = rec('roof');
    const parts: MassingPart[] = massing.parts.map(p => {
        const snapped = run.report.parts.find(q => q.id === p.id);
        return { ...p, loops: snapped ? snapped.loops.map(l => l.map(([x, z]) => [x, z] as Vec2)) : p.loops };
    });
    const sweeps: SweepItem[] = [];
    const extraParts: MassingPart[] = [];
    const roofDecisions: RoofDecision[] = [];
    if (!roofRead) roofStep.skipped = chain ? 'no top-down render' : noVision;
    else {
        const rr = await roofRead;
        if (rr instanceof Error) roofStep.skipped = `the roof reading failed (${rr.message.slice(0, 160)})`;
        else {
            const td = topdown!;
            const H = new Float32Array((() => { const b = fs.readFileSync(path.join(run.dir, td.height)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); })());
            const top = (x: number, z: number) => { const i = Math.floor((x - td.x0) / td.pixel), k = Math.floor((z - td.z0) / td.pixel); return i < 0 || k < 0 || i >= td.width || k >= td.rows ? NaN : H[k * td.width + i]; };
            const toPlan = (px: number, py: number): Vec2 => [td.x0 + (px / 1000) * td.width * td.pixel, td.z0 + (py / 1000) * td.rows * td.pixel];
            roofStep.notes.push(`read: pitch ${rr.value.pitchDeg} deg, ridge ${rr.value.ridgeAzimuthDeg} deg, ${rr.value.hipped ? 'hipped' : 'gabled or flat'}, parapet ${rr.value.parapetM} m, ${rr.value.blocks.length} raised blocks (conf ${rr.value.conf}, ${rr.value.notes ?? ''})`);
            for (const p of parts) {
                const inside = (input.solar ?? []).filter(s => s.pitchDeg >= 10 && p.loops.length && p.loops[0].length && inLoopsLocal(s.x, s.z, p.loops));
                const d = decideRoof(p, rr.value, top, inside, toPlan);
                roofDecisions.push(d);
                const conf = Math.max(0.05, Math.min(1, rr.value.conf / 100));
                if (d.pitch.proposed) { roofStep.proposed++; if (d.pitch.accepted) { roofStep.accepted++; p.planes = d.pitch.planes!; p.topY = d.pitch.topY!; p.provenance = 'massing-roof-photo-inferred'; } else roofStep.rejected++; roofStep.notes.push(`part ${p.id} pitch: ${d.pitch.accepted ? 'kept' : 'not kept'}: ${d.pitch.why}`); }
                if (d.parapet.proposed) {
                    roofStep.proposed++;
                    if (d.parapet.accepted) {
                        roofStep.accepted++;
                        for (const [li] of p.loops.entries()) {
                            const keys = faces.filter(f => f.wall && f.part === p.id && f.loop === li).sort((a, b) => a.edge - b.edge || a.key.localeCompare(b.key)).map(f => f.key);
                            if (keys.length) sweeps.push({ id: `parapet_${p.id}_${li}`, confidence: conf, provenance: 'photo-inferred', profile: parapetProfile(p.topY, d.parapet.heightM!, PARAPET_THICKNESS_M), faces: keys });
                        }
                    } else roofStep.rejected++;
                    roofStep.notes.push(`part ${p.id} parapet: ${d.parapet.accepted ? 'kept' : 'not kept'}: ${d.parapet.why}`);
                }
                for (const [k, b] of d.blocks.entries()) {
                    roofStep.proposed++;
                    if (b.accepted) { roofStep.accepted++; extraParts.push({ id: `${p.id}/block${k}`, baseY: b.baseY!, topY: b.topY!, loops: [b.loop!], planes: [], heightSource: 'photo-inferred', heights: {}, provenance: 'photo-inferred' }); }
                    else roofStep.rejected++;
                    roofStep.notes.push(`part ${p.id} raised block ${k}: ${b.accepted ? 'kept' : 'not kept'}: ${b.why}`);
                }
            }
        }
    }
    roofStep.ms = now() - t;

    // ------------------------------------------------------------------ (b) bands
    t = now();
    const bandStep = rec('bands');
    if (!chain) bandStep.skipped = noVision;
    else {
        const accepted: Array<{ face: MassingFace; d: BandDecision; conf: number }> = [];
        for (const [k, sec] of run.report.sections.entries()) {
            const r = await bandReads[k];
            if (r instanceof Error) { bandStep.notes.push(`wall ${sec.key}: the reading failed (${r.message.slice(0, 120)})`); continue; }
            for (const d of decideBands(sec, r.value)) {
                bandStep.proposed++;
                if (d.accepted) { bandStep.accepted++; accepted.push({ face: faces[sec.face], d, conf: Math.max(0.05, r.value.conf / 100) }); } else bandStep.rejected++;
                bandStep.notes.push(`wall ${sec.face}: band ${d.accepted ? 'kept' : 'not kept'}: ${d.why}`);
            }
        }
        // chains of consecutive walls of one plan loop showing the same band (heights within 0.4 m); a small wall between two that do joins
        const used = new Set<number>();
        for (const a of accepted) {
            if (used.has(accepted.indexOf(a))) continue;
            const same = accepted.filter((b, j) => !used.has(j) && b.face.part === a.face.part && b.face.loop === a.face.loop && Math.abs(b.d.t0! - a.d.t0!) < 0.4 && Math.abs(b.d.t1! - a.d.t1!) < 0.4);
            same.forEach(b => used.add(accepted.indexOf(b)));
            const loopWalls = faces.filter(f => f.wall && f.part === a.face.part && f.loop === a.face.loop).sort((p, q) => p.edge - q.edge || p.key.localeCompare(q.key));
            const has = new Set(same.map(b => b.face.index));
            const inBand = loopWalls.map((w, i) => has.has(w.index) || (!run.report.sections.some(s => s.face === w.index) && has.has(loopWalls[(i + loopWalls.length - 1) % loopWalls.length].index) && has.has(loopWalls[(i + 1) % loopWalls.length].index)));
            const t0 = medianOf(same.map(b => b.d.t0!)), t1 = medianOf(same.map(b => b.d.t1!)), depth = medianOf(same.map(b => b.d.depthM!)), conf = medianOf(same.map(b => b.conf));
            // runs (wrapping)
            const n = loopWalls.length;
            const start = inBand.every(Boolean) ? 0 : inBand.findIndex((v, i) => v && !inBand[(i + n - 1) % n]);
            let run_: string[] = [], k = 0;
            for (let i = 0; i < n; i++) {
                const idx = (start + i) % n;
                if (inBand[idx]) run_.push(loopWalls[idx].key);
                else if (run_.length) { sweeps.push({ id: `band_${a.face.index}_${k++}`, confidence: conf, provenance: 'photo-inferred', profile: bandProfile(t0, t1, depth), faces: run_ }); run_ = []; }
            }
            if (run_.length) sweeps.push({ id: `band_${a.face.index}_${k++}`, confidence: conf, provenance: 'photo-inferred', profile: bandProfile(t0, t1, depth), faces: run_ });
        }
    }
    bandStep.ms = now() - t;

    // ------------------------------------------------------------------ (c) windows
    t = now();
    const winStep = rec('windows');
    const openings: OpeningItem[] = [];
    const grammars: FacadeGrammar[] = [];
    let grammarOutcomes: GrammarFacadeOutcome[] = [];
    if (!grammarRead) winStep.skipped = noVision;
    else {
        const g = await grammarRead;
        if (g instanceof Error) winStep.skipped = `the grammar reading failed (${g.message.slice(0, 160)})`;
        else {
            grammarOutcomes = g.facades;
            for (const o of g.facades) {
                if (!o.grammar) continue;
                winStep.proposed++;
                if (!o.accepted) { winStep.rejected++; winStep.notes.push(`wall ${o.facadeId}: not used: ${o.reason.slice(0, 200)}`); continue; }
                winStep.accepted++;
                grammars.push(o.grammar);
                const f = faces[o.facadeId];
                const made = openingsFromGrammar(run, f, o.grammar, `win_${f.index}`);
                openings.push(...made.openings);
                const measured = made.measured, assumed = made.assumed;
                winStep.notes.push(`wall ${o.facadeId}: ${grammarCells(o.grammar).length} openings (recess measured on ${measured}, ${assumed} at 0.12 m): ${o.reason.slice(0, 160)}`);
            }
        }
    }
    winStep.ms = now() - t;
    timingsMs.readings = now() - tRead;

    // ------------------------------------------------------------------ the solid again, with what was kept
    t = now();
    progress('building the solid again with the inferred roof, bands and openings');
    const allParts = [...parts, ...extraParts];
    const run2 = await runNativeMassing({ parts: allParts, meshes: massing.meshes }, { tilePath: input.tilePath, isolateGlb: input.isolateGlb, dir: path.join(input.dir, 'native2'), sweeps, openings, params: { snapMaxM: 0, sections: 0, topdown: 0 }, ...(input.signal ? { signal: input.signal } : {}) });
    timingsMs.native2 = now() - t;
    const rejectedOpenings = new Set(run2.report.rejectedOpenings);
    if (rejectedOpenings.size) winStep.notes.push(`${rejectedOpenings.size} openings did not fit inside their wall and were left out`);
    if (run2.report.rejectedSweeps.length) bandStep.notes.push(`${run2.report.rejectedSweeps.length} sweeps found no wall and were left out`);

    // ------------------------------------------------------------------ textures: (g) masks, (d) bays, fill, (e) straighten, (f) colour
    t = now();
    const { legend, BAY, OTHER, GENERATED, COLOURED } = inferenceLegend(baseLegend());
    const textures = new Map<number, FaceTexture>();
    for (const [k, v] of input.textures) textures.set(k, { width: v.width, height: v.height, rgba: new Uint8Array(v.rgba), source: new Uint8Array(v.source) });
    const occStep = rec('occluders');
    const masks = new Map<number, Uint8Array>();
    const cleanOf = new Map<number, Uint8Array>();
    let crownTexels = 0, boxTexels = 0, uncoveredTexels = 0;
    const boxesByFace = new Map<number, Array<[number, number, number, number]>>();
    for (const [k, f] of wallFaces.entries()) {
        const r = k < occReads.length ? await occReads[k] : undefined;
        if (r && !(r instanceof Error)) boxesByFace.set(f.index, r.value.map(b => b.box));
        else if (r instanceof Error) occStep.notes.push(`wall ${f.index}: the occluder reading failed (${r.message.slice(0, 120)})`);
    }
    for (const f of faces) {
        const tex = textures.get(f.index);
        if (!tex || f.kind !== 'wall') continue;
        const N = tex.width * tex.height;
        const mask = new Uint8Array(N);
        // uncovered on a face the tile sees (a hole in it): an occluder took its surface
        if (f.coverage >= LOW_COVERAGE) for (let i = 0; i < N; i++) if (tex.source[i] !== SRC.tileOrtho) { mask[i] = 1; uncoveredTexels++; }
        const cm = crownMask(f, input.crowns ?? []);
        for (let i = 0; i < N; i++) if (cm.mask[i] && !mask[i]) { mask[i] = 1; crownTexels++; }
        if (cm.crowns.length) occStep.notes.push(`wall ${f.index}: ${cm.crowns.length} tree crowns stand in front of it`);
        const boxes = boxesByFace.get(f.index) ?? [];
        if (boxes.length) {
            const bm = boxMask(boxes, tex.width, tex.height);
            for (let i = 0; i < N; i++) if (bm[i] && !mask[i]) { mask[i] = 1; boxTexels++; }
        }
        const dm = dilate(mask, tex.width, tex.height, 2);
        masks.set(f.index, dm);
        const clean = new Uint8Array(N);
        for (let i = 0; i < N; i++) clean[i] = tex.source[i] === SRC.tileOrtho && !dm[i] ? 1 : 0;
        cleanOf.set(f.index, clean);
    }
    occStep.notes.push(`masked: ${uncoveredTexels} uncovered, ${crownTexels} behind measured tree crowns, ${boxTexels} in boxes the vision model marked`);
    if (!chain) occStep.notes.push('no vision model: only the uncovered and tree-crown texels are masked');

    // the occluder regions as masked before any fill: each is judged, after the fills, by how much real or generated fill it took
    const regions = new Map<number, Array<{ x: number; y: number; width: number; height: number; texels: number }>>();
    for (const [fi, m] of masks) regions.set(fi, holeRects(m, textures.get(fi)!.width, textures.get(fi)!.height, 0, 64));

    // (d) averaged bays
    const bayStep = rec('bays');
    const pitchPx = new Map<number, number>();
    const latticeRows = new Map<number, [number, number]>();
    if (!grammars.length) bayStep.skipped = 'no facade grammar was accepted';
    for (const g of grammars) {
        const f = faces[g.facadeId], tex = textures.get(f.index), clean = cleanOf.get(f.index);
        if (!tex || !clean) continue;
        const groups = bayGroups(latticePixels(g, f));
        const r = averageBays(tex, groups, clean, BAY);
        bayStep.proposed += r.groups.length;
        bayStep.accepted += r.groups.filter(x => x.accepted).length;
        bayStep.rejected += r.groups.filter(x => !x.accepted).length;
        for (const x of r.groups) bayStep.notes.push(`wall ${f.index}: ${x.accepted ? 'kept' : 'not kept'}: ${x.why}`);
        const pitches = g.openings.map(o => o.bayPitchM).filter(p => p > 0);
        if (pitches.length) pitchPx.set(f.index, medianOf(pitches) / f.pixel);
        const lp = latticePixels(g, f).flat();
        if (lp.length) latticeRows.set(f.index, [Math.max(0, Math.floor(Math.min(...lp.map(c => c.y0)))), Math.ceil(Math.max(...lp.map(c => c.y1)))]);
        // texels the bays replaced are no longer masked
        const m = masks.get(f.index)!;
        for (let i = 0; i < m.length; i++) if (tex.source[i] === BAY) m[i] = 0;
    }

    // (g) the fill: other bays and facades, then Nano Banana Lite
    let otherFilled = 0, generated = 0, inpaintRects = 0, inpaintAccepted = 0;
    let rectsLeft = input.inpaint?.maxRects ?? 6;
    for (const f of faces) {
        const m = masks.get(f.index), tex = textures.get(f.index);
        if (!m || !tex) continue;
        const r = fillFromOtherFacades(f.index, faces, textures, cleanOf, m, OTHER, { ...(pitchPx.get(f.index) ? { pitchPx: pitchPx.get(f.index)! } : {}), ...(latticeRows.get(f.index) ? { rows: latticeRows.get(f.index)! } : {}) });
        otherFilled += r.filled;
        if (r.filled) occStep.notes.push(`wall ${f.index}: ${r.filled} texels from ${r.sources.map(s => `${s.how === 'bay-shift' ? 'its own bays' : `wall ${s.face}`} (${s.texels})`).join(', ')}`);
        if (input.inpaint && rectsLeft > 0 && m.some(v => v)) {
            try {
                const ip = await inpaintFace(tex, m, `e_face_${f.index}`, input.inpaint.client, input.inpaint.models, GENERATED, { maxRects: Math.min(2, rectsLeft), ...(input.signal ? { signal: input.signal } : {}) });
                rectsLeft -= ip.records.filter(x => x.decision !== 'skipped').length;
                inpaintRects += ip.records.length; inpaintAccepted += ip.records.filter(x => x.decision === 'accepted').length;
                generated += ip.filled;
            } catch (err) {
                if (input.signal?.aborted) throw err;
                occStep.notes.push(`wall ${f.index}: inpainting failed (${(err as Error).message.slice(0, 120)})`);
            }
        }
        // the regions: filled (at most a tenth of it left to the nearest-texel smear) or not
        for (const r of regions.get(f.index) ?? []) {
            let leftN = 0, all = 0;
            for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) { const i = y * tex.width + x; if (tex.source[i] === BAY || tex.source[i] === OTHER || tex.source[i] === GENERATED || m[i]) { all++; if (m[i]) leftN++; } }
            occStep.proposed++;
            if (all && leftN <= 0.1 * all) occStep.accepted++; else occStep.rejected++;
        }
        // what is left: the nearest real texel
        for (let i = 0; i < m.length; i++) if (m[i]) tex.source[i] = 255;
        fillNearest(tex);
    }
    occStep.notes.push(`filled: ${otherFilled} from other bays or facades (photo-inferred), ${generated} generated by Nano Banana Lite (${inpaintAccepted} of ${inpaintRects} rects kept), the rest from the nearest real texel`);

    // (e) straightened texture
    const strStep = rec('straighten');
    const straightened: StraightenResult[] = [];
    if (!grammars.length) strStep.skipped = 'no facade grammar was accepted';
    for (const g of grammars) {
        const f = faces[g.facadeId], tex = textures.get(f.index);
        if (!tex) continue;
        const xs: Array<{ at: number; y0: number; y1: number }> = [], ys: Array<{ at: number; x0: number; x1: number }> = [];
        for (const tier of latticePixels(g, f)) {
            if (!tier.length) continue;
            const xa = Math.min(...tier.map(c => c.x0)), xb = Math.max(...tier.map(c => c.x1));
            ys.push({ at: tier[0].y0, x0: xa, x1: xb }, { at: tier[0].y1, x0: xa, x1: xb });
            for (const c of tier) xs.push({ at: c.x0, y0: c.y0, y1: c.y1 }, { at: c.x1, y0: c.y0, y1: c.y1 });
        }
        const r = straighten(tex, { xs, ys }, f.pixel);
        straightened.push(r);
        strStep.proposed++;
        if (r.accepted && r.texture) { strStep.accepted++; textures.set(f.index, r.texture); } else strStep.rejected++;
        strStep.notes.push(`wall ${f.index}: ${r.accepted ? 'kept' : 'not kept'}: ${r.why}`);
    }

    // (f) colour from Street View
    const colStep = rec('colour');
    const colour: ColourResult[] = [];
    if (!svRead) colStep.skipped = input.streetViews ? 'no massing mesh to check visibility against' : 'no Street View source';
    else {
        const views = await svRead;
        if (views instanceof Error) colStep.skipped = `the Street View photos could not be had (${views.message.slice(0, 160)})`;
        else if (!views.length) colStep.skipped = 'no Street View photo of the structure';
        else {
            const withDepth = views.map(v => ({ ...v, depth: renderFrameDepth(input.structureMesh!, v.camera as never) }));
            colStep.notes.push(`${views.length} Street View photos, ${views.filter(v => v.ownerMask?.some(x => x)).length} with owned pixels`);
            for (const f of faces) {
                const tex = textures.get(f.index), clean = cleanOf.get(f.index);
                if (!tex || !clean || f.kind !== 'wall' || f.coverage < LOW_COVERAGE) continue;
                // the clean texels after the fills: real or averaged, never generated
                const use = new Uint8Array(clean.length);
                for (let i = 0; i < use.length; i++) use[i] = tex.source[i] === SRC.tileOrtho || tex.source[i] === BAY ? 1 : 0;
                const pairs = colourPairs(f, tex, use, withDepth);
                if (pairs.pairs.length < 20) continue;
                const r = transferColour(f, tex, pairs.pairs, pairs.views);
                colour.push(r);
                colStep.proposed++;
                if (r.accepted) { colStep.accepted++; for (let i = 0; i < tex.source.length; i++) if (tex.source[i] === SRC.tileOrtho) tex.source[i] = COLOURED; } else colStep.rejected++;
                colStep.notes.push(`wall ${f.index}: ${r.accepted ? 'kept' : 'not kept'}: ${r.why} (${r.pairs} pairs from ${r.views} photos)`);
            }
            if (!colStep.proposed) colStep.notes.push('no wall had enough clean pixels in the photos');
        }
    }
    timingsMs.textures = now() - t;

    // ------------------------------------------------------------------ enhanced mode (opt-in): each large wall redrawn once, gated
    let runOut = run2;
    const enhanced: EnhanceWallRecord[] = [];
    if (input.enhance) {
        t = now();
        const enhStep = rec('enhance');
        const ENH = legend.length;
        legend.push({ source: 'ai-enhanced', label: 'generated', method: `AI-enhanced from tile (${input.enhance.models.join(', ')}, ${TEXTURE_PLATE_PROMPT_ID})`, rung: 4, weight: 0.2 });
        // the largest walls (at most maxWalls), the first alone so the rest have a finished reference; then ENHANCE_CONCURRENCY at once
        const order = enhanceOrder(faces, textures, LOW_COVERAGE).sort((p, q) => q.area - p.area).slice(0, input.enhance.maxWalls ?? 8);
        const done: MassingFace[] = [];
        const plates = new Map<number, { plate: Uint8Array; use: Uint8Array }>();
        const enhanceOne = async (f: MassingFace) => {
            const tex = textures.get(f.index)!;
            const use = new Uint8Array(tex.width * tex.height);
            for (let i = 0; i < use.length; i++) use[i] = tex.source[i] === SRC.tileOrtho || tex.source[i] === BAY || tex.source[i] === OTHER || tex.source[i] === COLOURED ? 1 : 0;
            // the reference: a finished wall next to this one round the plan, else the first finished
            const ref = done.find(d => d.part === f.part && d.loop === f.loop && Math.abs(d.edge - f.edge) === 1) ?? done[0];
            const refTex = ref ? textures.get(ref.index)! : undefined;
            progress(`enhanced mode: redrawing wall ${f.index} (${Math.round(f.area)} m2)`);
            const before = { width: tex.width, height: tex.height, rgba: tex.rgba.slice() };
            const r = await enhanceWall(f, tex, use, { client: input.enhance!.client, models: input.enhance!.models, locationName: input.enhance!.locationName, ...(refTex ? { reference: refTex } : {}), source: ENH, ...(input.signal ? { signal: input.signal } : {}) });
            enhanced.push({ ...r, ...(ref ? { referenceFace: ref.index } : {}), plate: undefined } as EnhanceWallRecord);
            enhStep.proposed++;
            if (r.accepted) { enhStep.accepted++; done.push(f); if (r.plate) plates.set(f.index, { plate: r.plate, use }); } else enhStep.rejected++;
            enhStep.notes.push(`wall ${f.index}: ${r.accepted ? 'enhanced' : 'kept its tile texture'}: ${r.why}${r.model ? ` (${r.model})` : ''}${ref ? `; reference wall ${ref.index}` : ''}`);
            try {
                if (r.plate) {
                    const W2 = tex.width * 2 + 8, rgb = new Uint8Array(W2 * tex.height * 3);
                    for (let y = 0; y < tex.height; y++) for (let x = 0; x < tex.width; x++) {
                        rgb.set(before.rgba.subarray((y * tex.width + x) * 4, (y * tex.width + x) * 4 + 3), (y * W2 + x) * 3);
                        rgb.set(r.plate.subarray((y * tex.width + x) * 4, (y * tex.width + x) * 4 + 3), (y * W2 + x + tex.width + 8) * 3);
                    }
                    fs.writeFileSync(path.join(input.dir, `wall_${f.index}_tile_vs_enhanced.png`), encodePng(W2, tex.height, Buffer.from(rgb), 3));
                }
            } catch { /* diagnostics only */ }
        };
        if (order.length) await enhanceOne(order[0]);
        let nextE = 1;
        await Promise.all(Array.from({ length: Math.min(ENHANCE_CONCURRENCY, Math.max(0, order.length - 1)) }, async () => { for (let k; (k = nextE++) < order.length;) await enhanceOne(order[k]); }));
        // the grammar read from the enhanced plates, used only where it passes the grammar's own gates and the scan/tile check
        const plateStep = rec('enhance-grammar');
        if (chain && plates.size) {
            const pdir = path.join(input.dir, 'plates');
            fs.mkdirSync(pdir, { recursive: true });
            const tileIdx = readReliefOrthos(run.dir);
            const index = tileIdx.filter(r => plates.has(r.facadeId) && !grammars.some(g => g.facadeId === r.facadeId));
            for (const r of index) {
                const { plate, use } = plates.get(r.facadeId)!;
                const rgb = new Uint8Array(r.width * r.height * 3).fill(128);
                for (let i = 0; i < r.width * r.height; i++) if (use[i]) { for (let c = 0; c < 3; c++) rgb[i * 3 + c] = plate[i * 4 + c]; if (rgb[i * 3] === 128 && rgb[i * 3 + 1] === 128 && rgb[i * 3 + 2] === 128) rgb[i * 3] = 129; }
                fs.writeFileSync(path.join(pdir, r.image), encodePng(r.width, r.height, Buffer.from(rgb), 3));
            }
            fs.writeFileSync(path.join(pdir, 'facades.json'), JSON.stringify({ schema: 'scratchbox.relief-orthos/1', facades: index }));
            if (index.length) {
                const pass = await runFacadeGrammarPass({ orthosDir: pdir, chain, ...(input.signal ? { signal: input.signal } : {}), onProgress: m => progress(`enhanced plates: ${m}`) });
                const extra: OpeningItem[] = [];
                for (const o of pass.facades) {
                    if (!o.grammar) continue;
                    plateStep.proposed++;
                    const rf = index.find(r => r.facadeId === o.facadeId)!;
                    const tileCheck = o.accepted ? checkAgainstScan(o.grammar, rf, decodeOrtho(fs.readFileSync(path.join(run.dir, rf.image)))) : undefined;
                    if (o.accepted && tileCheck?.passed) {
                        plateStep.accepted++;
                        extra.push(...openingsFromGrammar(run, faces[o.facadeId], o.grammar, `plate_${o.facadeId}`).openings);
                        plateStep.notes.push(`wall ${o.facadeId}: the plate's grammar is used: ${o.reason.slice(0, 160)}; on the tile ortho: ${tileCheck.why.slice(0, 120)}`);
                    } else { plateStep.rejected++; plateStep.notes.push(`wall ${o.facadeId}: not used: ${o.accepted ? `on the tile ortho: ${tileCheck?.why}` : o.reason.slice(0, 200)}`); }
                }
                if (extra.length) {
                    progress('enhanced mode: building the solid again with the plates\' openings');
                    runOut = await runNativeMassing({ parts: allParts, meshes: massing.meshes }, { tilePath: input.tilePath, isolateGlb: input.isolateGlb, dir: path.join(input.dir, 'native3'), sweeps, openings: [...openings, ...extra], params: { snapMaxM: 0, sections: 0, topdown: 0 }, ...(input.signal ? { signal: input.signal } : {}) });
                }
            }
        } else plateStep.skipped = chain ? 'no wall was enhanced' : noVision;
        enhStep.ms = now() - t;
        timingsMs.enhance = now() - t;
    }

    // ------------------------------------------------------------------ the layer
    t = now();
    const tex2 = new Map<number, FaceTexture>();
    const plain2 = plainTextures(runOut).textures;
    for (const f2 of runOut.report.faces) {
        const f1 = faces.find(f => f.key === f2.key);
        const t1 = f1 ? textures.get(f1.index) : undefined;
        if (t1 && f1 && f2.width) tex2.set(f2.index, reframe(t1, f1, f2));
        else if (plain2.has(f2.index)) tex2.set(f2.index, plain2.get(f2.index)!);
    }
    const files = writeMassingLayer(runOut, massing, tex2, legend, input.dir, input.stage, input.stageKey, input.enhance ? 'massing_enhanced' : 'massing_inferred');
    timingsMs.glb = now() - t;
    fs.writeFileSync(path.join(input.dir, 'inference.json'), JSON.stringify({ steps, enhanced, roof: roofDecisions, grammars: grammarOutcomes.map(o => ({ facadeId: o.facadeId, accepted: o.accepted, reason: o.reason })), colour, straightened: straightened.map(s => ({ ...s, texture: undefined })), timingsMs }, null, 1));
    // the overlays: each wall's final texture beside its plain one (diagnostics)
    try {
        for (const g of grammars) {
            const f = faces[g.facadeId], a = input.textures.get(f.index), b = textures.get(f.index);
            if (!a || !b) continue;
            const W = a.width + b.width + 8, H = Math.max(a.height, b.height), rgb = new Uint8Array(W * H * 3);
            for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
                const src = x < a.width ? (y < a.height ? a.rgba.subarray((y * a.width + x) * 4) : undefined) : x >= a.width + 8 && y < b.height ? b.rgba.subarray((y * b.width + x - a.width - 8) * 4) : undefined;
                if (src) rgb.set(src.subarray(0, 3), (y * W + x) * 3);
            }
            fs.writeFileSync(path.join(input.dir, `wall_${f.index}_before_after.png`), encodePng(W, H, Buffer.from(rgb), 3));
        }
    } catch { /* diagnostics only */ }
    return { files, run: runOut, steps, legend, grammars, timingsMs, enhanced };
}

/** Recessed openings of a grammar on a wall: the recess the scan's ortho depth measures (inside against the frame), else 0.12 m. */
export function openingsFromGrammar(run: MassingRun, f: MassingFace, g: FacadeGrammar, idPrefix: string): { openings: OpeningItem[]; measured: number; assumed: number } {
    const ortho = readFaceOrtho(run.dir, f);
    const openings: OpeningItem[] = [];
    let measured = 0, assumed = 0;
    grammarCells(g).forEach((c, k) => {
        let depth = NaN;
        if (ortho) {
            const inner: number[] = [], ring: number[] = [];
            const x0 = Math.floor((c.s0 - f.orthoSMin) / f.pixel), x1 = Math.ceil((c.s1 - f.orthoSMin) / f.pixel), y0 = Math.floor((f.orthoTMax - c.t1) / f.pixel), y1 = Math.ceil((f.orthoTMax - c.t0) / f.pixel);
            const m = Math.max(2, Math.round(0.3 / f.pixel));
            for (let y = y0 - m; y < y1 + m; y++) for (let x = x0 - m; x < x1 + m; x++) {
                if (x < 0 || y < 0 || x >= f.width || y >= f.height) continue;
                const v = ortho.depth[y * f.width + x];
                if (!Number.isFinite(v)) continue;
                const core = x >= x0 + (x1 - x0) * 0.2 && x < x1 - (x1 - x0) * 0.2 && y >= y0 + (y1 - y0) * 0.2 && y < y1 - (y1 - y0) * 0.2;
                const outside = x < x0 || x >= x1 || y < y0 || y >= y1;
                if (core) inner.push(v); else if (outside) ring.push(v);
            }
            if (inner.length >= 6 && ring.length >= 6) depth = medianOf(ring) - medianOf(inner);
        }
        const ok = Number.isFinite(depth) && depth >= 0.05;
        if (ok) measured++; else assumed++;
        openings.push({ id: `${idPrefix}_${k}`, face: f.key, s0: c.s0, s1: c.s1, t0: c.t0, t1: c.t1, depth: ok ? Math.min(0.6, Math.max(0.08, depth)) : 0.12, scanned: false, confidence: g.confidence, provenance: 'photo-inferred' });
    });
    return { openings, measured, assumed };
}

function inLoopsLocal(x: number, z: number, loops: Vec2[][]): boolean {
    let inside = false;
    for (const r of loops) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
            if ((r[i][1] > z) !== (r[j][1] > z) && x < ((r[j][0] - r[i][0]) * (z - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
        }
    }
    return inside;
}
