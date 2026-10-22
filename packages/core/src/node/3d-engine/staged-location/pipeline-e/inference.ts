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
import { grammarCells, MIN_PHOTO_COVERAGE, runFacadeGrammarPass, type FacadeGrammar, type GrammarFacadeOutcome } from '../facade-grammar';
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
import { decodeOrtho, checkAgainstScan, readReliefOrthos, readGrammar, fitGrammar, onFacade } from '../facade-grammar';
import { enhanceOrder, enhanceWall, ENHANCE_CONCURRENCY, MAX_UNSEEN_WALLS, MIN_ENHANCE_AREA_M2, MIN_UNSEEN_EXPOSED_SHARE, TEXTURE_PLATE_PROMPT_ID, TEXTURE_PLATE_STREET_VIEW_PROMPT_ID, TEXTURE_PLATE_UNSEEN_PROMPT_ID, type EnhanceWallRecord, type PlateModelClient, type WallStreetView } from './enhance';
import { exposedShare, solidGrid } from './exposure';
import { labPlanes } from './plate-audit';
import { medianColour } from './face-textures';
import { bestStreetViewForWall, rectifiedReference, streetBandTop, type GuideView } from './plate-streetview';
import { applyStreetViewTexels, type StreetViewTexelRecord } from './street-view-texels';
import { visionFacadeCounter } from './plate-identity';
import { refitLatticeToPlate, plateLatticeOpenings } from './plate-lattice';
import type { AuditedCluster } from '../residual-audit';

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
    /** Enhanced mode: each large wall redrawn once by an image model (enhance.ts), gated on identity (plate-identity.ts). */
    enhance?: {
        client: PlateModelClient; models: string[]; locationName: string; maxWalls?: number;
        /** The invention and erasure check and the Street View guidance (default on; enhance.ts enhanceGuards). */
        guards?: boolean;
        /** The Street View survey's views of the structure, registered against the tile mesh and cut out (streetview-registered-views.ts). */
        streetViews?: () => Promise<GuideView[]>;
        /** Where the model's answers are cached per wall (enhance.ts cachedPlate). */
        cacheDir?: string;
    };
    /** The most walls the facade grammar reads (default MAX_GRAMMAR_FACADES, sized for one building; a district reads more). */
    maxFacades?: number;
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
    /** What the layer was built from (the relief stage builds on it): parts, sweeps and openings as given to the native tool. */
    build: { parts: MassingPart[]; sweeps: SweepItem[]; openings: OpeningItem[] };
    /** The layer's face textures, by face index of `run`. */
    textures: Map<number, FaceTexture>;
    /** Per face of the input run (its ortho frame): texels an occluder took (uncovered, behind a tree crown, a box the vision model marked). */
    occluderMasks: Map<number, Uint8Array>;
    /** The Street View photos the colour step had (with their registered cameras), when it had any. */
    streetViews?: ProjectionView[];
    /** Real Street View texels written on the walls (street-view-texels.ts), per wall. */
    streetViewTexels?: StreetViewTexelRecord[];
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
export function writeWallOrthoIndex(run: MassingRun, minAreaM2 = 80, minCoverage = MIN_PHOTO_COVERAGE): string {
    // walls the photo hardly covers (party walls, the inside of a block) are not offered: they would take a grammar reading's place
    const facades = run.report.faces.filter(f => f.kind === 'wall' && f.width > 0 && f.area >= minAreaM2 && (f.coverage ?? 0) >= minCoverage && fs.existsSync(path.join(run.dir, `ortho_${f.index}.png`))).map(f => ({
        facadeId: f.index, planeIndex: f.index, image: `ortho_${f.index}.png`, area_m2: f.area,
        centroid: [f.origin[0] + f.axisS[0] * (f.sMin + f.sMax) / 2, (f.tMin + f.tMax) / 2, f.origin[2] + f.axisS[2] * (f.sMin + f.sMax) / 2],
        normal: f.normal, axisS: f.axisS, axisT: f.axisT, sMin: f.sMin, sMax: f.sMax, tMin: f.tMin, tMax: f.tMax,
        pixel: f.pixel, texel: f.pixel, width: f.width, height: f.height, orthoSMin: f.orthoSMin, orthoTMax: f.orthoTMax, coverage: f.coverage,
        pattern: '', latticeConfirmation: 0, latticeRejected: false, cells: []
    }));
    fs.writeFileSync(path.join(run.dir, 'facades.json'), JSON.stringify({ schema: 'scratchbox.relief-orthos/1', facades }));
    return run.dir;
}

/**
 * The face of the first solid a face of a rebuilt solid comes from: the same key, or the longest key it extends (the native
 * solid splits a wall in pieces `<key>:0`, `<key>:1` when a changed roof or a raised block cuts it; the pieces lie in its
 * plane and take its texture).
 */
/**
 * A real object round in plan (radial symmetry at least this, residual-audit.ts) is not a prism. Open space below alone is
 * not enough: the hollow, ragged scan of a box reads open where its sides are torn (Little Singer Building, live).
 */
export const BLOCK_NOT_PRISM = { radialSymmetry: 0.5, planOverlap: 0.5 };

/** The real object of the run's residual audit that covers at least half of a raised block's plan box and is not a prism, if any. */
export function objectUnderBlock(run: Pick<MassingRun, 'audit'>, loop: Vec2[]): AuditedCluster | undefined {
    const a = run.audit;
    if (!a || 'error' in a) return undefined;
    const xs = loop.map(p => p[0]), zs = loop.map(p => p[1]);
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), bz0 = Math.min(...zs), bz1 = Math.max(...zs);
    const area = Math.max(1e-6, (bx1 - bx0) * (bz1 - bz0));
    return a.clusters.find(c => {
        if (c.verdict !== 'real-object') return false;
        if (c.symmetry.radialSymmetry < BLOCK_NOT_PRISM.radialSymmetry) return false;
        const ox = Math.max(0, Math.min(bx1, c.hi[0]) - Math.max(bx0, c.lo[0])), oz = Math.max(0, Math.min(bz1, c.hi[2]) - Math.max(bz0, c.lo[2]));
        return (ox * oz) / area >= BLOCK_NOT_PRISM.planOverlap;
    });
}

export function parentFace<F extends { key: string }>(faces: F[], key: string): F | undefined {
    let best: F | undefined;
    for (const f of faces) if ((key === f.key || key.startsWith(`${f.key}:`)) && (!best || f.key.length > best.key.length)) best = f;
    return best;
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

/** The lattice diagnostic: the wall's final texture with the tile's openings (red) and the openings read from the plate (green). */
export function writeLatticeDiagnostic(file: string, rgba: Uint8Array, f: MassingFace, tileG: FacadeGrammar, plateG: FacadeGrammar): void {
    const W = f.width, H = f.height, rgb = new Uint8Array(W * H * 3);
    for (let i = 0; i < W * H; i++) rgb.set(rgba.subarray(i * 4, i * 4 + 3), i * 3);
    const box = (g: FacadeGrammar, c: [number, number, number], inset: number) => {
        for (const cell of latticePixels(g, f).flat()) {
            const x0 = Math.round(cell.x0) + inset, x1 = Math.round(cell.x1) - inset, y0 = Math.round(cell.y0) + inset, y1 = Math.round(cell.y1) - inset;
            const put = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < W && y < H) rgb.set(c, (y * W + x) * 3); };
            for (let x = x0; x <= x1; x++) { put(x, y0); put(x, y1); }
            for (let y = y0; y <= y1; y++) { put(x0, y); put(x1, y); }
        }
    };
    box(tileG, [255, 40, 40], 0);
    box(plateG, [40, 255, 80], 1);
    fs.writeFileSync(file, encodePng(W, H, Buffer.from(rgb), 3));
}
/** The enhanced plates' grammar (up to 2 walls, about a minute) starts only this long into the stage (its limit is 420 s). */
export const PLATE_GRAMMAR_LATEST_MS = 310_000;

/**
 * The enhanced-mode diagnostic: the input | the aligned plate | the guarded plate with the flagged cells tinted (magenta
 * replaced, cyan erased, yellow retoned, red contradicts the photo; green finer detail kept) | the rectified Street View photo, when there is one.
 */
export function writeEnhanceDiagnostic(file: string, input: Uint8Array, plate: Uint8Array, guarded: Uint8Array | undefined, labels: string[] | undefined, grid: { cw: number; cellPx: number } | undefined, photo: Uint8Array | undefined, photoValid: Uint8Array | undefined, W: number, H: number): void {
    const tint: Record<string, [number, number, number]> = { replaced: [255, 0, 255], erased: [0, 255, 255], retoned: [255, 230, 0], 'contradicts-photo': [255, 0, 0], 'invented-detail': [0, 200, 0] };
    const panels: Uint8Array[] = [input, plate];
    if (guarded) {
        const g = guarded.slice();
        if (labels && grid) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const c = tint[labels[Math.floor(y / grid.cellPx) * grid.cw + Math.floor(x / grid.cellPx)]];
            if (!c) continue;
            const i = (y * W + x) * 4;
            for (let k = 0; k < 3; k++) g[i + k] = Math.round(0.6 * g[i + k] + 0.4 * c[k]);
        }
        panels.push(g);
    }
    if (photo && photoValid) {
        const p = photo.slice();
        for (let i = 0; i < W * H; i++) if (!photoValid[i]) { p[i * 4] = 40; p[i * 4 + 1] = 40; p[i * 4 + 2] = 40; }
        panels.push(p);
    }
    const OW = panels.length * (W + 8) - 8, rgb = new Uint8Array(OW * H * 3);
    panels.forEach((img, j) => { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgb.set(img.subarray((y * W + x) * 4, (y * W + x) * 4 + 3), (y * OW + j * (W + 8) + x) * 3); });
    fs.writeFileSync(file, encodePng(OW, H, Buffer.from(rgb), 3));
}

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
    const grammarRead = chain ? runFacadeGrammarPass({ orthosDir: writeWallOrthoIndex(run), chain, ...(input.maxFacades ? { maxFacades: input.maxFacades } : {}), ...(input.anchor ? { anchor: input.anchor } : {}), ...(input.signal ? { signal: input.signal } : {}), onProgress: m => progress(m), overlayDir: path.join(input.dir, 'grammar_overlays') }).catch(e => e as Error) : undefined;
    const svRead = input.streetViews && input.structureMesh ? input.streetViews(input.structureMesh).catch(e => e as Error) : undefined;
    const guideRead = input.enhance && input.enhance.guards !== false && input.enhance.streetViews ? input.enhance.streetViews().catch(e => e as Error) : undefined;

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
                            if (keys.length) sweeps.push({ id: `parapet_${p.id}_${li}`, confidence: conf, provenance: 'photo-inferred', profile: parapetProfile(d.parapet.heightM!, PARAPET_THICKNESS_M), relativeToTop: true, faces: keys });
                        }
                    } else roofStep.rejected++;
                    roofStep.notes.push(`part ${p.id} parapet: ${d.parapet.accepted ? 'kept' : 'not kept'}: ${d.parapet.why}`);
                }
                for (const [k, b] of d.blocks.entries()) {
                    roofStep.proposed++;
                    // a box stands in for a block only when the scan there is box-like: where the residual audit measured a real
                    // object round in plan (a prism would misrepresent it), the scan stays as scanned
                    const scanned = b.accepted && b.loop ? objectUnderBlock(run, b.loop) : undefined;
                    if (scanned) { b.accepted = false; b.why += `; left as scanned: the residual audit measured a real object there (cluster ${scanned.id}: radial symmetry ${scanned.symmetry.radialSymmetry.toFixed(2)}, open below ${Math.round(scanned.attachment.openBelowShare * 100)}%), round in plan, which a box would misrepresent`; }
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
    if (rejectedOpenings.size) {
        // a modelled volume's facets are not extruded walls: the native tool cuts openings only into extruded walls
        const facetKeys = new Set(faces.filter(f => !f.wall).map(f => f.key));
        const onFacets = openings.filter(o => rejectedOpenings.has(o.id) && facetKeys.has(o.face)).length;
        const misfit = rejectedOpenings.size - onFacets;
        if (onFacets) winStep.notes.push(`${onFacets} openings lie on facets of a modelled volume, which the native tool does not cut openings into (only extruded walls): left out, the wall stays flat`);
        if (misfit) winStep.notes.push(`${misfit} openings did not fit inside their wall and were left out`);
    }
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
        // uncovered on a face the tile sees (a hole in it): an occluder took its surface. A repeat-filled texel
        // (SRC.repeatFill, face-texture-repeat.ts) is not real tile-ortho either, but it is already a gated resample of
        // this same face's own real texels at a confirmed pitch - trusted enough not to be re-masked and handed to the
        // occluder fill (other-facade copy, bay average, or Nano Banana inpainting) below it in the trust order; it is
        // still excluded from `clean` just below, so it is never read back as a measured texel by grammar or bay fit.
        if (f.coverage >= LOW_COVERAGE) for (let i = 0; i < N; i++) if (tex.source[i] !== SRC.tileOrtho && tex.source[i] !== SRC.repeatFill) { mask[i] = 1; uncoveredTexels++; }
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
    let svViews: ProjectionView[] | undefined;
    /** The registered views the enhanced redraws were guided by, for the texel step below. */
    let guideAll: GuideView[] = [];
    if (!svRead) colStep.skipped = input.streetViews ? 'no massing mesh to check visibility against' : 'no Street View source';
    else {
        const views = await svRead;
        if (views instanceof Error) colStep.skipped = `the Street View photos could not be had (${views.message.slice(0, 160)})`;
        else if (!views.length) colStep.skipped = 'no Street View photo of the structure';
        else {
            svViews = views;
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

    // ------------------------------------------------------------------ enhanced mode (the default within E): each large wall redrawn once, gated
    let runOut = run2;
    const enhanced: EnhanceWallRecord[] = [];
    const latticeRefits: Array<Record<string, unknown>> = [];
    const enhancedOpenings: OpeningItem[] = [];
    if (input.enhance) {
        t = now();
        const enhStep = rec('enhance');
        const ENH = legend.length;
        legend.push({ source: 'ai-enhanced', label: 'generated', method: `AI-enhanced from tile (${input.enhance.models.join(', ')}, ${TEXTURE_PLATE_PROMPT_ID})`, rung: 4, weight: 0.2 });
        // the largest walls (at most maxWalls), the first alone so the rest have a finished reference; then ENHANCE_CONCURRENCY at once
        const order = enhanceOrder(faces, textures, LOW_COVERAGE).sort((p, q) => q.area - p.area).slice(0, input.enhance.maxWalls ?? 8);
        // walls the tile hardly sees (behind trees, against a neighbour) are drawn too, after the walls it sees (realism first:
        // generated detail where no source covers a surface), when they face open air (not a partition inside the volume)
        const UNSEEN = legend.length;
        legend.push({ source: 'ai-generated-unseen', label: 'generated', method: `drawn by an image model where the tile has no photo of the wall (hidden behind trees, against a neighbour or in the scan's gaps), continuing the wall's visible part and the adjacent finished wall (${input.enhance.models.join(', ')}, ${TEXTURE_PLATE_UNSEEN_PROMPT_ID})`, rung: 4, weight: 0.1 });
        const unseenOrder: MassingFace[] = [];
        {
            const grid = solidGrid(run.nodes);
            const cands = faces.filter(f => f.kind === 'wall' && f.width > 0 && textures.has(f.index) && f.area >= MIN_ENHANCE_AREA_M2 && f.coverage < LOW_COVERAGE)
                .map(f => ({ f, exposed: exposedShare(f, grid, run.dir) }));
            const inner = cands.filter(c => c.exposed < MIN_UNSEEN_EXPOSED_SHARE);
            const open = cands.filter(c => c.exposed >= MIN_UNSEEN_EXPOSED_SHARE).sort((a, b) => b.f.area * b.exposed - a.f.area * a.exposed);
            unseenOrder.push(...open.slice(0, MAX_UNSEEN_WALLS).map(c => c.f));
            if (cands.length) enhStep.notes.push(`walls the tile hardly sees (under ${100 * LOW_COVERAGE}% covered, at least ${MIN_ENHANCE_AREA_M2} m2): ${cands.length}; ${inner.length} face another part of the solid (partitions inside the volume: not drawn); ${open.length} face open air, the ${Math.min(open.length, MAX_UNSEEN_WALLS)} largest drawn as they continue${open.length > MAX_UNSEEN_WALLS ? ` (at most ${MAX_UNSEEN_WALLS}; walls ${open.slice(MAX_UNSEEN_WALLS).map(c => c.f.index).join(', ')} keep their filled colour)` : ''}`);
        }
        // the building's facade colour (CIELAB): the colour family of a plate on a wall the tile sees too little of to have one
        const facadeRgb = medianColour(faces.filter(f => f.kind === 'wall' && f.coverage >= LOW_COVERAGE).map(f => textures.get(f.index)).filter((x): x is FaceTexture => !!x));
        const familyLab = facadeRgb ? (() => { const [L, A, B] = labPlanes(new Uint8Array([...facadeRgb, 255]), 1); return [L[0], A[0], B[0]] as [number, number, number]; })() : undefined;
        const done: MassingFace[] = [];
        const plates = new Map<number, { plate: Uint8Array; use: Uint8Array; unseen: boolean }>();
        const guards = input.enhance.guards !== false;
        // the registered Street View views (enhanced mode's own survey), each with its depth of the massing
        let guide: GuideView[] = [];
        let noGuide: string | undefined = guards ? (input.enhance.streetViews ? undefined : 'no Street View source') : undefined;
        if (guideRead) {
            const tg = now();
            const got = await guideRead;
            if (got instanceof Error) noGuide = `the Street View survey failed (${got.message.slice(0, 160)})`;
            else {
                guide = input.structureMesh ? got.map(v => ({ ...v, depth: renderFrameDepth(input.structureMesh!, v.camera as never) })) : got;
                guideAll = guide;
                const reg = guide.filter(v => v.registration && v.registration.method !== 'nominal').length, owned = guide.filter(v => v.ownerMask?.some(x => x)).length;
                enhStep.notes.push(`Street View guidance: ${guide.length} photos, ${reg} with a registered pose, ${owned} with owned pixels${guide.length ? ` (${guide.map(v => `${v.panoId} ${v.registration?.method ?? 'nominal'}`).join(', ')})` : ''}`);
                if (!guide.length) noGuide = 'no Street View photo of the structure';
            }
            timingsMs.enhanceStreetView = now() - tg;
        }
        const svSource = new Map<string, number>();
        const sourceForPano = (panoId: string): number => {
            let k = svSource.get(panoId);
            if (k === undefined) {
                k = legend.length;
                legend.push({ source: 'ai-enhanced+street-view', label: 'generated', method: `AI-enhanced from tile, guided by Street View ${panoId} (${input.enhance!.models.join(', ')}, ${TEXTURE_PLATE_STREET_VIEW_PROMPT_ID})`, rung: 4, weight: 0.25 });
                svSource.set(panoId, k);
            }
            return k;
        };
        // the wall's own polygon in its ortho frame (the native tool's mask), when it wrote one of the frame's size
        const insideOf = (f: MassingFace): Uint8Array | undefined => {
            try { const b = fs.readFileSync(path.join(run.dir, `face_${f.index}.inside`)); return b.length === f.width * f.height ? new Uint8Array(b) : undefined; } catch { return undefined; }
        };
        const enhanceOne = async (f: MassingFace, unseen = false) => {
            const tex = textures.get(f.index)!;
            const use = new Uint8Array(tex.width * tex.height);
            for (let i = 0; i < use.length; i++) use[i] = tex.source[i] === SRC.tileOrtho || tex.source[i] === BAY || tex.source[i] === OTHER || tex.source[i] === COLOURED ? 1 : 0;
            // the reference: a finished wall next to this one round the plan, else the first finished
            // (`done` holds only the walls of earlier rounds, so the reference, and with it the cached answer, does not depend on timing)
            const ref = done.find(d => d.part === f.part && d.loop === f.loop && Math.abs(d.edge - f.edge) === 1) ?? done[0];
            const refTex = ref ? textures.get(ref.index)! : undefined;
            // the Street View photo that shows most of the wall's street-level band
            let sv: WallStreetView | undefined, noSv = noGuide;
            if (guards && guide.length) {
                const best = bestStreetViewForWall(f, guide);
                if (best.view && best.rect) sv = { view: best.view, rect: best.rect, crop: rectifiedReference(best.rect, tex.width, tex.height), why: best.why };
                else noSv = best.why;
            }
            progress(`enhanced mode: ${unseen ? 'drawing the unseen wall' : 'redrawing wall'} ${f.index} (${Math.round(f.area)} m2)${sv ? `, guided by Street View ${sv.view.panoId}` : ''}`);
            const before = { width: tex.width, height: tex.height, rgba: tex.rgba.slice() };
            const r = await enhanceWall(f, tex, use, {
                client: input.enhance!.client, models: input.enhance!.models, locationName: input.enhance!.locationName, ...(refTex ? { reference: refTex } : {}), source: ENH,
                guards, ...(input.enhance!.cacheDir ? { cacheDir: input.enhance!.cacheDir } : {}), ...(sv ? { streetView: sv, streetViewSource: sourceForPano(sv.view.panoId) } : {}), ...(noSv ? { noStreetView: noSv } : {}),
                ...(chain ? { counter: visionFacadeCounter(chain) } : {}), ...(input.signal ? { signal: input.signal } : {}),
                ...(unseen ? { unseen: { source: UNSEEN, ...(familyLab ? { familyLab } : {}), ...(insideOf(f) ? { inside: insideOf(f)! } : {}) } } : {})
            });
            enhanced.push({ ...r, ...(ref ? { referenceFace: ref.index } : {}), plate: undefined, guarded: undefined, labels: undefined, grid: undefined } as EnhanceWallRecord);
            enhStep.proposed++;
            if (r.accepted) {
                enhStep.accepted++; finished.push(f);
                // the wall's own provenance entry: the generic one with this wall's alignment numbers (reported, not gated)
                const used = new Set<number>(), svIdx = r.streetView ? svSource.get(r.streetView.panoId) : undefined;
                for (let i = 0; i < tex.source.length; i++) if (tex.source[i] === ENH || tex.source[i] === svIdx || tex.source[i] === UNSEEN) used.add(tex.source[i]);
                for (const k of used) {
                    const own = legend.length;
                    legend.push({ ...legend[k], source: `${legend[k].source}:wall-${f.index}`, method: `${legend[k].method}; wall ${f.index}: edge chamfer ${r.chamferPx?.toFixed(2)} px (${((r.chamferPx ?? 0) * f.pixel).toFixed(2)} m), ${Math.round(100 * (r.lostShare ?? 0))}% of the tile's edges with no plate edge within 0.3 m (reported, not gated)${r.identity ? `; storeys ${r.identity.storeys.tile ?? '-'} / ${r.identity.storeys.plate ?? '-'}, bays ${r.identity.bays.tile ?? '-'} / ${r.identity.bays.plate ?? '-'} (tile / plate), wall colour ${r.identity.colourDe} dE00` : ''}`, chamferPx: r.chamferPx, lostShare: r.lostShare });
                    for (let i = 0; i < tex.source.length; i++) if (tex.source[i] === k) tex.source[i] = own;
                }
                if (r.plate) plates.set(f.index, { plate: tex.rgba.slice(), use, unseen });
            } else enhStep.rejected++;
            enhStep.notes.push(`wall ${f.index}: ${r.accepted ? (unseen ? 'drawn (generated where the tile does not see it)' : 'enhanced') : unseen ? 'keeps its filled colour' : 'kept its tile texture'}: ${r.why}${r.model ? ` (${r.model})` : ''}${ref ? `; reference wall ${ref.index}` : ''}${sv ? `; ${sv.why}${r.streetView?.guidedRejected ? ` (the redraw with it failed the identity gate: ${r.streetView.guidedRejected}; redrawn without it, then checked against it)` : ''}` : guards && noSv ? `; no Street View guidance: ${noSv}` : ''}`);
            try {
                if (r.plate) writeEnhanceDiagnostic(path.join(input.dir, `wall_${f.index}_tile_vs_enhanced.png`), before.rgba, r.plate, r.guarded, r.labels, r.grid, sv?.rect.rgba, sv?.rect.valid, tex.width, tex.height);
            } catch { /* diagnostics only */ }
        };
        // in rounds: the largest wall alone, then ENHANCE_CONCURRENCY at a time, each round referencing the walls finished in the
        // rounds before it (never one finishing alongside), so a rebuild sends the model the same images and gets the cached plates
        const finished: MassingFace[] = [];
        for (let k = 0; k < order.length;) {
            const round = order.slice(k, k === 0 ? 1 : k + ENHANCE_CONCURRENCY);
            k += round.length;
            await Promise.all(round.map(f => enhanceOne(f)));
            done.push(...order.filter(f => finished.includes(f) && !done.includes(f)));
        }
        // then the unseen walls, ENHANCE_CONCURRENCY at a time, each referencing the walls finished before them
        for (let k = 0; k < unseenOrder.length;) {
            const round = unseenOrder.slice(k, k + ENHANCE_CONCURRENCY);
            k += round.length;
            await Promise.all(round.map(f => enhanceOne(f, true)));
            done.push(...unseenOrder.filter(f => finished.includes(f) && !done.includes(f)));
        }
        // the carved openings follow the plate: on a wall whose openings came from the tile's lattice, the lattice is read again
        // from the accepted plate (its windows may lie a few decimetres off the melted tile's), within the same massing
        const latStep = rec('enhance-lattice');
        let refitChanged = false;
        for (const g of grammars) {
            const pl = plates.get(g.facadeId);
            if (!pl) continue;
            const f = faces[g.facadeId], tex = textures.get(f.index)!;
            const r = refitLatticeToPlate(g, f, tex.rgba, pl.use);
            latStep.proposed++;
            if (r.moved) {
                latStep.accepted++; refitChanged = true;
                const prefix = `win_${f.index}_`;
                const keep = openings.filter(o => !o.id.startsWith(prefix));
                openings.length = 0;
                openings.push(...keep, ...openingsFromGrammar(run, f, r.grammar, `win_${f.index}`).openings);
                latticeRefits.push({ face: f.index, ...r, grammar: undefined, tiles: g.tiers, plate: r.grammar.tiers });
            } else latStep.rejected++;
            latStep.notes.push(`wall ${f.index}: ${r.why}`);
            try { writeLatticeDiagnostic(path.join(input.dir, `wall_${f.index}_lattice_refit.png`), tex.rgba, f, g, r.grammar); } catch { /* diagnostics only */ }
        }
        if (!latStep.proposed) latStep.skipped = grammars.length ? 'no enhanced wall has openings carved from the tile\'s lattice' : 'no facade grammar was accepted on the tile';

        // the grammar read from the enhanced plates, used only where it passes the grammar's own gates and the scan/tile check
        const plateStep = rec('enhance-grammar');
        const extra: OpeningItem[] = [];
        /** The plates' own grammars the pass read but did not use (held-out or tile check): the plate-lattice step's readings. */
        const plateReadings = new Map<number, FacadeGrammar>();
        const elapsed = now() - tRead;
        if (chain && plates.size && elapsed > PLATE_GRAMMAR_LATEST_MS) plateStep.skipped = `no time left in the stage (${Math.round(elapsed / 1000)} s spent; the plates' grammar starts only before ${PLATE_GRAMMAR_LATEST_MS / 1000} s)`;
        else if (chain && plates.size) {
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
                const pass = await runFacadeGrammarPass({ orthosDir: pdir, chain, maxFacades: 2, ...(input.signal ? { signal: input.signal } : {}), onProgress: m => progress(`enhanced plates: ${m}`) });
                for (const o of pass.facades) {
                    if (!o.grammar) continue;
                    plateStep.proposed++;
                    const rf = index.find(r => r.facadeId === o.facadeId)!;
                    const tileCheck = o.accepted ? checkAgainstScan(o.grammar, rf, decodeOrtho(fs.readFileSync(path.join(run.dir, rf.image)))) : undefined;
                    if (o.accepted && tileCheck?.passed) {
                        plateStep.accepted++;
                        // the openings come from a generated plate (checked against the tile): generated, not photo-inferred
                        extra.push(...openingsFromGrammar(run, faces[o.facadeId], o.grammar, `plate_${o.facadeId}`, 'generated').openings);
                        plateStep.notes.push(`wall ${o.facadeId}: the plate's grammar is used: ${o.reason.slice(0, 160)}; on the tile ortho: ${tileCheck.why.slice(0, 120)}`);
                    } else { plateStep.rejected++; plateReadings.set(o.facadeId, o.grammar); plateStep.notes.push(`wall ${o.facadeId}: not used: ${o.accepted ? `on the tile ortho: ${tileCheck?.why}` : o.reason.slice(0, 200)}`); }
                }
            }
        } else plateStep.skipped = chain ? 'no wall was enhanced' : noVision;
        // (realism first) a wall with an accepted plate whose openings are not carved from any grammar that passed (the tile's or
        // the plate's) takes the lattice the plate itself shows, each opening kept where the plate's edges and contrast show it,
        // labelled generated; walls the tile hardly sees are not cut (nothing real says where their openings are)
        const latOpStep = rec('enhance-plate-openings');
        const cutWalls = new Set<number>([...grammars.map(g => g.facadeId), ...extra.map(o => Number(/^plate_(\d+)_/.exec(o.id)?.[1] ?? NaN))]);
        const facetWalls = [...plates.keys()].filter(fi => !faces[fi].wall && !plates.get(fi)!.unseen && !cutWalls.has(fi));
        if (facetWalls.length) latOpStep.notes.push(`walls ${facetWalls.join(', ')}: facets of a modelled volume, which the native tool does not cut openings into: not read`);
        const want = [...plates.entries()].filter(([fi, pl]) => !pl.unseen && !cutWalls.has(fi) && faces[fi].wall);
        const skippedUnseen = [...plates.entries()].filter(([, pl]) => pl.unseen).map(([fi]) => fi);
        if (skippedUnseen.length) latOpStep.notes.push(`walls ${skippedUnseen.join(', ')}: drawn where the tile does not see them; not cut (nothing real places their openings)`);
        if (!want.length) latOpStep.skipped = plates.size ? 'no enhanced extruded wall the tile sees is without openings carved from a grammar that passed' : 'no wall was enhanced';
        else if (!chain) latOpStep.skipped = noVision;
        else if (now() - tRead > PLATE_GRAMMAR_LATEST_MS) latOpStep.skipped = `no time left in the stage (${Math.round((now() - tRead) / 1000)} s spent; the plates' lattice is read only before ${PLATE_GRAMMAR_LATEST_MS / 1000} s)`;
        else {
            const tileIdx = readReliefOrthos(run.dir);
            const fdir = path.join(input.dir, 'plates_full');
            fs.mkdirSync(fdir, { recursive: true });
            const results = await Promise.all(want.map(async ([fi, pl]) => {
                const rf = tileIdx.find(r => r.facadeId === fi);
                if (!rf) return { fi, why: 'the wall has no ortho record to read on' };
                let grammar = plateReadings.get(fi);
                let how = 'the reading the plates\' grammar pass made';
                if (!grammar) {
                    const rgb = new Uint8Array(rf.width * rf.height * 3);
                    for (let i = 0; i < rf.width * rf.height; i++) { for (let c = 0; c < 3; c++) rgb[i * 3 + c] = pl.plate[i * 4 + c]; if (rgb[i * 3] === 128 && rgb[i * 3 + 1] === 128 && rgb[i * 3 + 2] === 128) rgb[i * 3] = 129; }
                    const png = encodePng(rf.width, rf.height, Buffer.from(rgb), 3);
                    fs.writeFileSync(path.join(fdir, rf.image), png);
                    const o = decodeOrtho(new Uint8Array(png));
                    try {
                        const rd = await readGrammar(chain, rf, o, { x0: 0, x1: o.width, y0: 0, y1: o.height });
                        if (!rd.tiers.length) return { fi, why: 'the model read no openings on the plate' };
                        grammar = onFacade(fitGrammar(rd.tiers, rf, { confidence: rd.reply.conf / 100, source: 'enhanced-plate', ...(rd.reply.notes ? { label: rd.reply.notes } : {}) }), rf).grammar;
                        how = `one reading of the plate (${rd.model}${rd.cached ? ', replayed' : ''})`;
                    } catch (err) {
                        if (input.signal?.aborted) throw err;
                        return { fi, why: `the plate's reading failed (${(err as Error).message.slice(0, 160)})` };
                    }
                }
                const f = faces[fi];
                const r = plateLatticeOpenings(grammar, f, pl.plate);
                return { fi, why: `${how}: ${r.why}`, r };
            }));
            for (const x of results) {
                latOpStep.proposed++;
                if (x.r?.grammar) {
                    latOpStep.accepted++;
                    const ops = openingsFromGrammar(run, faces[x.fi], x.r.grammar, `platelat_${x.fi}`, 'generated');
                    extra.push(...ops.openings);
                    latOpStep.notes.push(`wall ${x.fi}: ${ops.openings.length} openings cut from the plate's own lattice (generated: no window grammar passed on the scan; ${ops.measured} recessed at the depth the scan's ortho measures, ${ops.assumed} at 0.12 m): ${x.why}`);
                    try { writeLatticeDiagnostic(path.join(input.dir, `wall_${x.fi}_plate_openings.png`), plates.get(x.fi)!.plate, faces[x.fi], x.r.grammar, x.r.grammar); } catch { /* diagnostics only */ }
                } else { latOpStep.rejected++; latOpStep.notes.push(`wall ${x.fi}: left flat: ${x.why}`); }
            }
        }
        if (extra.length || refitChanged) {
            enhancedOpenings.push(...extra);
            progress('enhanced mode: building the solid again with the plates\' openings');
            runOut = await runNativeMassing({ parts: allParts, meshes: massing.meshes }, { tilePath: input.tilePath, isolateGlb: input.isolateGlb, dir: path.join(input.dir, 'native3'), sweeps, openings: [...openings, ...extra], params: { snapMaxM: 0, sections: 0, topdown: 0 }, ...(input.signal ? { signal: input.signal } : {}) });
        }
        enhStep.ms = now() - t;
        timingsMs.enhance = now() - t;
    }

    // ------------------------------------------------------------------ (h) real Street View texels on the walls
    // (street-view-texels.ts): once the plates are decided, each wall takes the registered, owned photo where it sees the wall
    // sharper than the tile ortho; labelled photo-inferred. Before this step no Street View pixel reached a texel in pipeline E.
    // Off by default (user decision, 2026-10-21, reaffirmed): texturing infers from the 3D photo tiles themselves
    // (tile-ortho projection + the photo-tier texture pass, texture-pass.ts) rather than pulling in a second,
    // separately-registered photo source. This also matches the one held-out bake-off run so far (Haughwout),
    // where baking real, correctly gated Street View texels lowered the overall and realism judge scores against
    // not baking them at all (see docs/processes/streetview_value.md). SCRATCHBOX_STREETVIEW_TEXELS=1 opts back in.
    t = now();
    const svtStep = rec('street-view-texels');
    const streetViewTexels: StreetViewTexelRecord[] = [];
    if (process.env.SCRATCHBOX_STREETVIEW_TEXELS !== '1') {
        svtStep.skipped = 'disabled by default (SCRATCHBOX_STREETVIEW_TEXELS=1 opts in): texturing infers from the 3D photo tiles instead';
    } else {
        const pool = new Map<string, GuideView>();
        const add = (v: ProjectionView & { registration?: GuideView['registration']; depth?: Float32Array }) => {
            const k = `${v.panoId}:${v.camera.fx.toFixed(1)}:${v.camera.eye.map(x => x.toFixed(2)).join(',')}:${v.camera.fwd.map(x => x.toFixed(4)).join(',')}`;
            if (!pool.has(k)) pool.set(k, v.depth || !input.structureMesh ? v : { ...v, depth: renderFrameDepth(input.structureMesh, v.camera as never) });
        };
        for (const v of guideAll) add(v);
        for (const v of svViews ?? []) add(v as GuideView);
        const views = [...pool.values()];
        if (!views.length) svtStep.skipped = input.enhance?.streetViews || input.streetViews ? 'no Street View photo of the structure' : 'no Street View source';
        else {
            for (const f of faces) {
                const tex = textures.get(f.index);
                if (!tex || f.kind !== 'wall' || !f.width) continue;
                const use = new Uint8Array(tex.width * tex.height);
                for (let i = 0; i < use.length; i++) use[i] = tex.source[i] !== 255 && tex.source[i] !== SRC.nearestFill && tex.source[i] !== SRC.facadeMedian ? 1 : 0;
                const before = tex.rgba.slice();
                const r = applyStreetViewTexels(f, tex, use, views, legend, streetBandTop(f));
                streetViewTexels.push(r);
                if (r.texels) {
                    // diagnostics: the wall before | after | where the photo texels went (white: two photos agree)
                    try {
                        const svIdx = new Set(legend.map((l, k) => (l.source === 'street-view-rectified' || l.source === 'street-view-rectified-multi' ? k : -1)).filter(k => k >= 0));
                        const Wd = tex.width, Hd = tex.height, OW = 3 * Wd + 16, rgb = new Uint8Array(OW * Hd * 3);
                        for (let y = 0; y < Hd; y++) for (let x = 0; x < Wd; x++) {
                            const i = y * Wd + x;
                            rgb.set(before.subarray(i * 4, i * 4 + 3), (y * OW + x) * 3);
                            rgb.set(tex.rgba.subarray(i * 4, i * 4 + 3), (y * OW + Wd + 8 + x) * 3);
                            const v = svIdx.has(tex.source[i]) ? (legend[tex.source[i]].source === 'street-view-rectified-multi' ? 255 : 170) : 40;
                            rgb.set([v, v, v], (y * OW + 2 * Wd + 16 + x) * 3);
                        }
                        fs.writeFileSync(path.join(input.dir, `wall_${f.index}_street_view_texels.png`), encodePng(OW, Hd, Buffer.from(rgb), 3));
                    } catch { /* diagnostics only */ }
                }
                svtStep.proposed++;
                if (r.texels) svtStep.accepted++; else svtStep.rejected++;
                svtStep.notes.push(`wall ${f.index}: ${r.texels ? 'Street View texels' : 'no Street View texel'}: ${r.why}`);
            }
            if (!svtStep.proposed) svtStep.skipped = 'no wall to texture';
        }
    }
    svtStep.ms = now() - t;
    timingsMs.streetViewTexels = svtStep.ms;

    // ------------------------------------------------------------------ the layer
    t = now();
    const tex2 = new Map<number, FaceTexture>();
    const plain2 = plainTextures(runOut).textures;
    for (const f2 of runOut.report.faces) {
        const f1 = parentFace(faces, f2.key);
        const t1 = f1 ? textures.get(f1.index) : undefined;
        if (t1 && f1 && f2.width) tex2.set(f2.index, reframe(t1, f1, f2));
        else if (plain2.has(f2.index)) tex2.set(f2.index, plain2.get(f2.index)!);
    }
    const files = writeMassingLayer(runOut, massing, tex2, legend, input.dir, input.stage, input.stageKey, input.enhance ? 'massing_enhanced' : 'massing_inferred');
    timingsMs.glb = now() - t;
    fs.writeFileSync(path.join(input.dir, 'inference.json'), JSON.stringify({ steps, enhanced, latticeRefits, roof: roofDecisions, grammars: grammarOutcomes.map(o => ({ facadeId: o.facadeId, accepted: o.accepted, reason: o.reason })), colour, straightened: straightened.map(s => ({ ...s, texture: undefined })), streetViewTexels, timingsMs }, null, 1));
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
    return { files, run: runOut, steps, legend, grammars, timingsMs, enhanced, build: { parts: allParts, sweeps, openings: [...openings, ...enhancedOpenings] }, textures: tex2, occluderMasks: masks, ...(svViews ? { streetViews: svViews } : {}), streetViewTexels };
}

/** Recessed openings of a grammar on a wall: the recess the scan's ortho depth measures (inside against the frame), else 0.12 m. */
export function openingsFromGrammar(run: MassingRun, f: MassingFace, g: FacadeGrammar, idPrefix: string, provenance = 'photo-inferred'): { openings: OpeningItem[]; measured: number; assumed: number } {
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
        openings.push({ id: `${idPrefix}_${k}`, face: f.key, s0: c.s0, s1: c.s1, t0: c.t0, t1: c.t1, depth: ok ? Math.min(0.6, Math.max(0.08, depth)) : 0.12, scanned: false, confidence: g.confidence, provenance });
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
