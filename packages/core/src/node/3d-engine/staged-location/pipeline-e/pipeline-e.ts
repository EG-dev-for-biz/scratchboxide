/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Staged-location pipeline E (the default for an isolated building; SCRATCHBOX_STAGED_PIPELINE=d or 0 turns it off): fast
 * clean lines from Google's vector massing.
 *
 *   1. Massing (massing-spec.ts): the vector footprint and heights, Solar roof facets, the modelled volume where one exists,
 *      checked against the scan; a massing that disagrees falls back to the current pipeline, with the numbers.
 *   2. The native tool (scratchbox_staged_massing.hpp) extrudes the clean solid, moves walls onto the facades the scan
 *      measures, keeps what the scan shows clearly proud of or cut into it as scanned detail, and bakes every face's texture
 *      as an orthographic render of the photo tile through a thin slab about it.
 *   3. The layer: clay GLB and its textured twin. Inference (inference.ts) runs after, in the background, and replaces it.
 */

import { FOOTPRINT_MODEL_TOKEN, FOOTPRINT_MODEL_VERSION } from '../footprint-model';
import * as fs from 'fs';
import * as path from 'path';
import type { ProvenanceRecord } from '../../../../common/spatial/staged-location-contracts';
import { TEXTURE_LADDER_RUNGS } from '../../../../common/spatial/texture-pass-contracts';
import type { VectorBuilding } from '../vector-footprints';
import { buildMassing, HEIGHT_AGREEMENT_M, massingSpecText, type FaceSweepItem, type Massing, type OpeningItem, type SweepItem } from './massing-spec';
import * as jpegJs from 'jpeg-js';
import { PHOTO_JPEG_QUALITY, writeMassingClayGlb, writeMassingTexturedGlb, type FaceTexture, type TexelSource } from './massing-glb';
import { decodeImageInMemory } from '../tile-texture-transfer';
import { readFaceOrtho, runMassing, type MassingFace, type MassingNode, type MassingRun } from './native-massing';
import { baseLegend, fillNearest, medianColour, SRC, textureFromOrtho } from './face-textures';
import { repeatFillFace } from './face-texture-repeat';
import { facadeMaterialsEnabled } from '../facade-material-evidence';
import { auditMassingRun, UNSURE_PROVENANCE } from './residual-audit-e';
import { delightTileImageBytes } from './residual-tile-delight';
import { RESIDUAL_SHAPE_TOKEN } from './residual-shape-fit';

/** Below this share of its texels covered by the tile, a face is filled with one median colour. */
export const LOW_COVERAGE = 0.35;
/**
 * Below this share, a face is taken as hardly seeing the tile at all (a party wall, the inside of the block) and filled
 * with one flat colour. Above it (and below LOW_COVERAGE, which a different, unrelated use of this module reads to
 * decide whether a wall is eligible for enhanced mode's "unseen" continuation drawing — inference.ts), fillNearest's
 * finer, spatially-varying breadth-first fill is used instead, the same as a well-covered face already gets: a face at,
 * say, 20% coverage has real photo detail over a fifth of it, and flattening the whole face to one colour discarded
 * that real detail outside a narrow near-zero-coverage band, not just the genuinely blind cases the comment describes.
 */
export const FACE_HARDLY_SEEN_SHARE = 0.02;
import type { SolarRoofSegment } from './solar-roof';

/** The stage version; the material channels (massing-materials.ts) change every E layer's textured twin. */
export const PIPELINE_E_VERSION = `pipeline-e/v2${facadeMaterialsEnabled() ? '+mat1' : ''}`;
/** Provenance tokens of the shape program trial's parts (passed through the native tool to the nodes). */
export const SHAPE_TIERS_TOKEN = 'shape-tiers-measured';
export const SHAPE_PROGRAM_TOKEN = 'shape-program-inferred';
/** The provenance token of a part extruded from the scan's own convex outline (orchestrator.ts's scanDerivedFootprint),
 *  used instead of Google's vector footprint when there is none at the place: a real measurement of the scan, simplified
 *  to its hull, not a guess, so it is labelled 'measured' rather than falling through to 'vector-massing'. */
export const SCAN_FOOTPRINT_TOKEN = 'scan-footprint-measured';

/**
 * On by default for an isolated structure (2026-10-21, the round-3 bake-off: E-enhanced scored highest of every arm on
 * the places it reached, and a massing or roof gate failure already falls back to the current pipeline with the reason
 * recorded, so turning this on changes nothing on a building E cannot handle). SCRATCHBOX_STAGED_PIPELINE=d (or 0) goes
 * back to the current pipeline; =e is still accepted, now a no-op. District builds never read this (orchestrator.ts
 * gates pipeline E on request.isolate).
 */
export function stagedPipelineE(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = (env.SCRATCHBOX_STAGED_PIPELINE ?? '').trim().toLowerCase();
    return v !== 'd' && v !== '0';
}
/** SCRATCHBOX_STAGED_PIPELINE_E_INFERENCE=0: pipeline E without its inferred steps (the bake-off's E-minus-inference arm). */
export function pipelineEInference(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_PIPELINE_E_INFERENCE !== '0';
}

/**
 * The native tool's parameters for E (the defaults of scratchbox_staged_massing.hpp, said here so they are in the key).
 * snapMaxM 0: the footprint is the source of truth (user decision, 2026-10-22), so no wall is moved onto the scan.
 */
export const MASSING_PARAMS = {
    pixel: 0.05, slabBack: 1.5, slabFront: 0.8, protrusionReach: 2.5, snapMaxM: 0, snapMinSupport: 0.15,
    residualProud: 0.6, residualCut: 0.6, residualClear: 1.5, residualOpen: 2.0, residualMinArea: 2.0, apronHeight: 0.8, attachReach: 1.5,
    reslabBelow: 0.35, reslabReach: 4.0
};

export interface MassingStageInput {
    /** Mass from footprints over Google's modelled volumes (MassingInputs.preferExtrusion): pipeline G's request. */
    preferExtrusion?: boolean;
    /** false: no residual audit of the native run (a procedural-only build: the scan residue is not part of it). */
    audit?: boolean;
    /** The tile the faces are textured from (the devegetated tile when the trees were measured). */
    tilePath: string;
    /** The isolated scan (tile_refine's raw clay). */
    isolateGlb: string;
    buildings: VectorBuilding[];
    groundY: number;
    scanTop: (x: number, z: number) => number;
    cells: ReadonlySet<string>;
    solar?: Array<SolarRoofSegment & { x: number; z: number; y: number }>;
    outDir: string;
    signal?: AbortSignal;
    /** A massing made elsewhere (the shape program trial): used instead of the vector massing, with its own check. */
    massing?: Massing;
}

export interface MassingLayerFiles {
    clayGlb: string; texturedGlb: string; texturedShares: number[];
    /** The legend the textured twin was packed with: the caller's, and closeUnsourcedTexels' entries when it filled any. */
    legend?: TexelSource[];
    /** What closeUnsourcedTexels filled, when anything reached the layer without a source. */
    unsourced?: UnsourcedClosure;
}

/** What closeUnsourcedTexels filled: the faces it touched and the texels by how. */
export interface UnsourcedClosure { faces: number; repeat: number; nearest: number; median: number }

export interface MassingStageResult {
    massing: Massing;
    /** Present when the massing passed its check. */
    run?: MassingRun;
    textures?: Map<number, FaceTexture>;
    legend?: TexelSource[];
    files?: MassingLayerFiles;
    timingsMs: Record<string, number>;
}

/** The provenance record of a node of E's layer (open labels). */
export function massingProvenance(node: Pick<MassingNode, 'kind' | 'provenance' | 'confidence'>, massing: Pick<Massing, 'check'>): ProvenanceRecord {
    if (node.provenance === RESIDUAL_SHAPE_TOKEN) {
        return {
            label: 'measured', measuredGeometry: true, confidence: Math.max(0, Math.min(1, node.confidence ?? 0.5)),
            method: 'residual audit: a residual cluster measured as confidently radially symmetric (its circle-fit median score, cross-section constancy) fit with a clean solid of revolution from its own measured per-slice radius, instead of its raw, unresolved scan triangles; coloured with its own measured average photo colour',
            sources: [{ kind: 'tile-extraction', id: 'isolate' }]
        };
    }
    if (node.kind === 'residual') {
        const unsure = node.provenance === UNSURE_PROVENANCE;
        return {
            label: 'as-scanned', measuredGeometry: true, method: 'scan triangles the clean massing does not explain (clearly proud of it, cut into it, or the ground apron), kept with their tile photo', sources: [{ kind: 'tile-extraction', id: 'isolate' }],
            ...(unsure ? { note: 'residual audit: unsure (neither a real object nor a scan artefact by its measures); kept as scanned, labelled' } : {})
        };
    }
    // openings cut from an enhanced plate's lattice (or read from a plate and checked on the tile): drawn by an image model
    if (node.provenance === 'generated') return { label: 'generated', measuredGeometry: false, confidence: Math.max(0, Math.min(1, node.confidence ?? 0.5)), method: `pipeline E enhanced mode: ${node.kind} cut where an AI-enhanced wall plate shows it (the plate's own lattice, its lines fitted to the plate's edges); no window grammar of the scan placed it`, sources: [{ kind: 'stage-output', id: 'pipeline-e-enhance' }] };
    // the shape program trial (shape-stage.ts): height-map tiers are measured; a program's structure is read by a vision
    // model from the tree-free scan, its numbers fitted to the scan (the parameters and their labels in the stage's note)
    if (node.provenance === SHAPE_TIERS_TOKEN) return { label: 'measured', measuredGeometry: true, confidence: 0.8, method: 'shape program trial: stacked extrusions at the tree-free scan\'s tier heights (height-map modes), outlines traced from its height map and squared to the dominant wall directions', sources: [{ kind: 'tile-extraction', id: 'isolate' }] };
    if (node.provenance === SHAPE_PROGRAM_TOKEN) return { label: 'photo-inferred', measuredGeometry: false, confidence: 0.6, method: 'shape program trial: the structure read by a vision model from a contact sheet of the tree-free scan (one call, structured output), as continuous geometric operators; every numeric handle fitted to the scan\'s height map and oblique silhouettes (measured)', sources: [{ kind: 'tile-extraction', id: 'isolate' }, { kind: 'stage-output', id: 'shape-program' }] };
    // the footprint model's outline (footprint-model.ts) where Google's footprint was missing, partial or merged the
    // neighbours: read from the photo tiles by a learned model, so photo-inferred; its confidence is the model's mean probability
    if (node.provenance.startsWith(FOOTPRINT_MODEL_TOKEN)) {
        const c = Number(/-c([0-9.]+)$/.exec(node.provenance)?.[1]);
        return { label: 'photo-inferred', measuredGeometry: false, confidence: Number.isFinite(c) ? Math.max(0, Math.min(1, c)) : 0.5, method: `footprint model (${FOOTPRINT_MODEL_VERSION}): the building's outline read from the photo tiles' top-down height and colour by a U-Net (measured on unseen NYC and Amsterdam buildings), where Google's vector footprint was missing, partial or merged the neighbours; extruded to the scan's measured height`, sources: [{ kind: 'tile-extraction', id: 'isolate' }, { kind: 'stage-output', id: 'footprint-model' }], note: `plan IoU with the scan ${massing.check.iou}, roof ${massing.check.heightErrMedianM} m off the scan (median)` };
    }
    // no Google vector footprint at the place: extruded from the scan's own convex outline instead (orchestrator.ts's
    // scanDerivedFootprint) — a real measurement of the scan, simplified to its hull, so 'measured', not 'vector-massing'
    if (node.provenance === SCAN_FOOTPRINT_TOKEN) return { label: 'measured', measuredGeometry: true, confidence: Math.max(0, Math.min(1, massing.check.iou)), method: 'no Google vector footprint at the place: the structure\'s own convex outline on the scan, extruded to its measured height, instead of a vector footprint', sources: [{ kind: 'tile-extraction', id: 'isolate' }], note: `plan IoU with the scan ${massing.check.iou}, roof ${massing.check.heightErrMedianM} m off the scan (median)` };
    // a roof shaped from the modelled volume's planes where the scan agreed (roof-infer.ts decideRoof, the volume's planes as a
    // candidate): vector-modelled, its confidence from the fit's residual against the scan (inference.ts roofVectorModelledToken)
    if (node.kind === 'roof' && node.provenance.includes('vector-modelled')) {
        const residual = Number(/-r([0-9.]+)/.exec(node.provenance)?.[1]);
        const confidence = Number.isFinite(residual) ? Math.max(0.05, Math.min(1, 1 - residual / HEIGHT_AGREEMENT_M)) : 0.5;
        return { label: 'vector-modelled', measuredGeometry: false, confidence, method: 'pipeline E inference: roof planes read from Google\'s modelled 3D volume of the building (its top surface as planes), kept because they lower the roof\'s error against the scan', sources: [{ kind: 'vector-data', id: 'google-vectortiles' }, { kind: 'tile-extraction', id: 'isolate' }], ...(Number.isFinite(residual) ? { note: `roof ${residual.toFixed(2)} m off the scan (median)` } : {}) };
    }
    if (node.provenance === 'photo-inferred' || (node.kind === 'roof' && node.provenance.includes('photo-inferred'))) return { label: 'photo-inferred', measuredGeometry: false, confidence: Math.max(0, Math.min(1, node.confidence ?? 0.5)), method: `pipeline E inference: ${node.kind} read from the tile's photo and kept where the scan agrees`, sources: [{ kind: 'stage-output', id: 'pipeline-e-inference' }] };
    return {
        label: 'vector-massing', measuredGeometry: false, confidence: Math.max(0, Math.min(1, massing.check.iou)),
        method: 'pipeline E: Google vector footprint and heights (Solar roof facets, the modelled volume where one exists) extruded to a clean solid; walls moved onto the facade the scan measures',
        sources: [{ kind: 'vector-data', id: 'google-vectortiles' }], note: `plan IoU with the scan ${massing.check.iou}, roof ${massing.check.heightErrMedianM} m off the scan (median)`
    };
}

/** Runs the native tool on the massing (and, when given, the inferred openings and sweeps). */
/**
 * Runs the native tool on the massing (and, when given, the inferred openings and sweeps), then the residual audit on its
 * residual (residual-audit-e.ts): scan artefacts removed, unsure clusters labelled, real objects kept as scanned. An audit
 * that fails leaves the residual as the native tool kept it, with the error on `run.audit`.
 */
export async function runNativeMassing(m: Pick<Massing, 'parts' | 'meshes'>, opts: { tilePath: string; isolateGlb: string; dir: string; sweeps?: SweepItem[]; openings?: OpeningItem[]; faceSweeps?: FaceSweepItem[]; params?: Record<string, number>; signal?: AbortSignal; groundY?: number; audit?: boolean }): Promise<MassingRun> {
    const params = { ...MASSING_PARAMS, ...(opts.params ?? {}) } as Record<string, number>;
    const text = massingSpecText(m, { outDir: opts.dir, tile: opts.tilePath, isolate: opts.isolateGlb, params, sweeps: opts.sweeps, openings: opts.openings, faceSweeps: opts.faceSweeps });
    const run = await runMassing(text, opts.dir, { signal: opts.signal });
    if (opts.audit !== false && params.residual !== 0 && run.nodes.some(n => n.kind === 'residual')) {
        try {
            run.audit = await auditMassingRun(run, { ...(opts.groundY !== undefined ? { groundY: opts.groundY } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
        } catch (err) {
            if (opts.signal?.aborted) throw err;
            run.audit = { error: err instanceof Error ? err.message : String(err) };
        }
    }
    return run;
}

/** The plain face textures: each face's ortho, the uncovered texels filled from the nearest covered, unseen faces the median. */
export function plainTextures(run: MassingRun): { textures: Map<number, FaceTexture>; legend: TexelSource[] } {
    const textures = new Map<number, FaceTexture>();
    for (const f of run.report.faces) {
        if (!f.width || f.kind === 'base') continue;
        const o = readFaceOrtho(run.dir, f);
        if (o) textures.set(f.index, textureFromOrtho(o, f.pixel));
    }
    // between the real tile-ortho texels and the nearest-texel/facade-median smear: where a face's real texels show a
    // gated same-plane repeat (texture-repeat.ts, ported onto this ladder by face-texture-repeat.ts), fill the rest of
    // that face from them at the detected pitch instead of dropping straight to the smear. A face with no gated axis
    // is left untouched here and falls through to the branches below exactly as before this rung existed.
    for (const [index, t] of textures) {
        const face = run.report.faces.find(f => f.index === index);
        repeatFillFace(t, face?.pixel || 0.05);
    }
    const walls = run.report.faces.filter(f => f.kind === 'wall').map(f => textures.get(f.index)).filter((t): t is FaceTexture => !!t);
    const median = medianColour(walls) ?? medianColour([...textures.values()]) ?? [150, 150, 150];
    for (const [index, t] of textures) {
        const face = run.report.faces.find(f => f.index === index);
        // a face the tile hardly sees at all (a party wall, the inside of the block) takes one flat colour, not a smear
        // of a few texels; anything with more real coverage than that keeps its real detail, filled in the gaps same as
        // a well-covered face (fillNearest), not flattened over it
        if ((face?.coverage ?? 0) < FACE_HARDLY_SEEN_SHARE) {
            const own = (face?.coverage ?? 0) > 0 ? medianColour([t]) : undefined;
            for (let i = 0; i < t.width * t.height; i++) if (t.source[i] === 255) { t.rgba.set(own ?? median, i * 4); t.rgba[i * 4 + 3] = 255; t.source[i] = SRC.facadeMedian; }
        } else fillNearest(t, undefined, median);
    }
    return { textures, legend: baseLegend() };
}

const UNSOURCED_WHY = 'a texel no earlier stage wrote (every texel of its face masked as an occluder, or a face the re-cut made that its parent face\'s texture does not reach)';
const ladderRung = (name: (typeof TEXTURE_LADDER_RUNGS)[number]) => TEXTURE_LADDER_RUNGS.indexOf(name);
/** closeUnsourcedTexels' legend entries, in its trust order. */
export const UNSOURCED_LEGEND: TexelSource[] = [
    { source: 'unsourced-repeat', label: 'generated', method: `${UNSOURCED_WHY}, filled from its face's own real photo texels at a gated same-plane repeat pitch (texture-repeat.ts)`, rung: ladderRung('repeated same-plane fill'), weight: 0.2 },
    { source: 'unsourced-nearest', label: 'generated', method: `${UNSOURCED_WHY}, given the colour of the nearest texel of its face that has a source`, rung: ladderRung('measured palette colour'), weight: 0.1 },
    { source: 'unsourced-median', label: 'generated', method: `${UNSOURCED_WHY}, on a face none of whose texels has a source, given the median colour of its building's real wall photo texels (else the layer's)`, rung: ladderRung('measured palette colour'), weight: 0.05 }
];

function hasUnsourced(t: FaceTexture, legendLength: number): boolean {
    for (let i = 0; i < t.source.length; i++) if (t.source[i] >= legendLength) return true;
    return false;
}

/**
 * Gives every texel of a layer a source. One whose index the legend does not hold (255: not yet produced) would be packed
 * as clay over whatever RGB it holds, black where nothing wrote it. Each is filled by the believability default on a copy
 * (the callers' textures feed later stages): from its face's own repeats of its real photo texels, else the face's
 * nearest texel with a source, else (no texel of the face has one) its building's median real wall colour, labelled
 * generated with the reason in its legend entry. The entries are appended only when used, so a layer with nothing
 * unsourced is written exactly as before.
 */
export function closeUnsourcedTexels(run: MassingRun, textures: Map<number, FaceTexture>, legend: TexelSource[]): { textures: Map<number, FaceTexture>; legend: TexelSource[]; closed: UnsourcedClosure } {
    const closed: UnsourcedClosure = { faces: 0, repeat: 0, nearest: 0, median: 0 };
    const open = [...textures].filter(([, t]) => hasUnsourced(t, legend.length));
    if (!open.length) return { textures, legend, closed };
    // provisional indices just past the legend, renumbered below to the entries used
    const [REPEAT, NEAREST, MEDIAN] = UNSOURCED_LEGEND.map((_, k) => legend.length + k);
    const real = legend.findIndex(e => e.source === 'tile-ortho');
    const isReal = real >= 0 ? (s: number) => s === real : (s: number) => s < legend.length;
    const faceOf = new Map(run.report.faces.map(f => [f.index, f]));
    const walls = (pick: (f: MassingFace) => boolean) => run.report.faces.filter(f => f.kind === 'wall' && pick(f)).map(f => textures.get(f.index)).filter((t): t is FaceTexture => !!t);
    const partMedian = new Map<string, [number, number, number] | undefined>();
    let layerMedian: [number, number, number] | undefined;
    const out = new Map(textures);
    for (const [index, src] of open) {
        const face = faceOf.get(index);
        const t: FaceTexture = { width: src.width, height: src.height, rgba: new Uint8Array(src.rgba), source: new Uint8Array(src.source) };
        let sourced = 0, reals = 0;
        for (let i = 0; i < t.source.length; i++) {
            if (t.source[i] >= legend.length) { t.source[i] = 255; t.rgba.fill(0, i * 4, i * 4 + 4); } // the repeat fill's targets have alpha 0
            else { sourced++; if (isReal(t.source[i])) reals++; }
        }
        closed.faces++;
        if (sourced) {
            if (real >= 0 && reals) closed.repeat += repeatFillFace(t, face?.pixel || 0.05, { real, fillSource: REPEAT }).filled;
            closed.nearest += fillNearest(t, NEAREST);
        } else {
            const part = face?.part;
            if (part !== undefined && !partMedian.has(part)) partMedian.set(part, medianColour(walls(f => f.part === part), isReal));
            const rgb = (part !== undefined ? partMedian.get(part) : undefined)
                ?? (layerMedian ??= medianColour(walls(() => true), isReal) ?? medianColour([...textures.values()], isReal) ?? [150, 150, 150]);
            for (let i = 0; i < t.source.length; i++) { t.rgba.set(rgb, i * 4); t.rgba[i * 4 + 3] = 255; t.source[i] = MEDIAN; }
            closed.median += t.source.length;
        }
        out.set(index, t);
    }
    const added: TexelSource[] = [];
    const remap = Uint8Array.from({ length: 256 }, (_, k) => k);
    [closed.repeat, closed.nearest, closed.median].forEach((n, k) => { if (n) { remap[legend.length + k] = legend.length + added.length; added.push(UNSOURCED_LEGEND[k]); } });
    for (const [index] of open) { const s = out.get(index)!.source; for (let i = 0; i < s.length; i++) s[i] = remap[s[i]]; }
    return { textures: out, legend: [...legend, ...added], closed };
}

/** Writes the clay layer and its textured twin into `dir`; texels without a source are filled first (closeUnsourcedTexels). */
export function writeMassingLayer(run: MassingRun, massing: Pick<Massing, 'check'>, textures: Map<number, FaceTexture>, legend: TexelSource[], dir: string, stage: string, stageKey: string, name = 'massing', provenanceOf?: (n: MassingNode) => ProvenanceRecord | undefined, opts: { photoJpeg?: boolean } = {}): MassingLayerFiles {
    const closure = closeUnsourcedTexels(run, textures, legend);
    textures = closure.textures;
    legend = closure.legend;
    // de-lit (residual-tile-delight.ts): every other texel in the scene is de-lit on its way in, but a residual
    // ("as-scanned") cluster renders straight off this shared image, its own native UV, nothing else touching it
    const tileImages = new Map<number, { bytes: Uint8Array; mimeType: string }>();
    for (const im of run.report.images) {
        const f = path.join(run.dir, im.file);
        if (!fs.existsSync(f)) continue;
        const delit = delightTileImageBytes(fs.readFileSync(f));
        if (opts.photoJpeg) {
            const d = decodeImageInMemory(delit);
            tileImages.set(im.image, { bytes: new Uint8Array(jpegJs.encode({ data: Buffer.from(d.rgba.buffer, d.rgba.byteOffset, d.rgba.byteLength), width: d.width, height: d.height }, PHOTO_JPEG_QUALITY).data), mimeType: 'image/jpeg' });
        } else tileImages.set(im.image, { bytes: delit, mimeType: 'image/png' });
    }
    const input = {
        nodes: run.nodes, faces: run.report.faces, stage, stageKey, textures, legend, tileImages, tileLegendIndex: 0,
        provenanceOf: (n: MassingNode) => provenanceOf?.(n) ?? massingProvenance(n, massing), ...(opts.photoJpeg ? { albedoJpeg: true } : {}),
        ...(run.flatColours ? { flatColours: run.flatColours } : {})
    };
    const clayGlb = path.join(dir, `${name}_clay.glb`), texturedGlb = path.join(dir, `${name}_textured.glb`);
    fs.writeFileSync(clayGlb, writeMassingClayGlb(input));
    const tex = writeMassingTexturedGlb(input);
    fs.writeFileSync(texturedGlb, tex.glb);
    return { clayGlb, texturedGlb, texturedShares: tex.shares, legend, ...(closure.closed.faces ? { unsourced: closure.closed } : {}) };
}

/** Step 1 and 2: the massing, its check, the native solid with orthos and residual, the plain layer files. */
export async function runMassingStage(input: MassingStageInput, stage = 'remesh', stageKey = 'pipeline-e'): Promise<MassingStageResult> {
    const timingsMs: Record<string, number> = {};
    let t = Date.now();
    const massing = input.massing ?? buildMassing({ buildings: input.buildings, groundY: input.groundY, scanTop: input.scanTop, cells: input.cells, ...(input.solar ? { solar: input.solar } : {}), ...(input.preferExtrusion ? { preferExtrusion: true } : {}) });
    timingsMs.massing = Date.now() - t;
    fs.mkdirSync(input.outDir, { recursive: true });
    fs.writeFileSync(path.join(input.outDir, 'massing.json'), JSON.stringify(massing, null, 1));
    if (!massing.check.ok) return { massing, timingsMs };
    t = Date.now();
    const run = await runNativeMassing(massing, { tilePath: input.tilePath, isolateGlb: input.isolateGlb, dir: path.join(input.outDir, 'native'), groundY: input.groundY, ...(input.audit === false ? { audit: false } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    timingsMs.native = Date.now() - t;
    t = Date.now();
    const { textures, legend } = plainTextures(run);
    timingsMs.textures = Date.now() - t;
    t = Date.now();
    const files = writeMassingLayer(run, massing, textures, legend, input.outDir, stage, stageKey);
    timingsMs.glb = Date.now() - t;
    return { massing, run, textures, legend, files, timingsMs };
}
