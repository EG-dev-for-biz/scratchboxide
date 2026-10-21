/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Staged-location pipeline E (off by default; SCRATCHBOX_STAGED_PIPELINE=e): fast clean lines from Google's vector massing.
 *
 *   1. Massing (massing-spec.ts): the vector footprint and heights, Solar roof facets, the modelled volume where one exists,
 *      checked against the scan; a massing that disagrees falls back to the current pipeline, with the numbers.
 *   2. The native tool (scratchbox_staged_massing.hpp) extrudes the clean solid, moves walls onto the facades the scan
 *      measures, keeps what the scan shows clearly proud of or cut into it as scanned detail, and bakes every face's texture
 *      as an orthographic render of the photo tile through a thin slab about it.
 *   3. The layer: clay GLB and its textured twin. Inference (inference.ts) runs after, in the background, and replaces it.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProvenanceRecord } from '../../../../common/spatial/staged-location-contracts';
import type { VectorBuilding } from '../vector-footprints';
import { buildMassing, massingSpecText, type FaceSweepItem, type Massing, type OpeningItem, type SweepItem } from './massing-spec';
import { writeMassingClayGlb, writeMassingTexturedGlb, type FaceTexture, type TexelSource } from './massing-glb';
import { readFaceOrtho, runMassing, type MassingNode, type MassingRun } from './native-massing';
import { baseLegend, fillNearest, medianColour, SRC, textureFromOrtho } from './face-textures';
import { facadeMaterialsEnabled } from '../facade-material-evidence';
import { auditMassingRun, UNSURE_PROVENANCE } from './residual-audit-e';
import { delightTileImageBytes } from './residual-tile-delight';

/** Below this share of its texels covered by the tile, a face is filled with one median colour. */
export const LOW_COVERAGE = 0.35;
import type { SolarRoofSegment } from './solar-roof';

/** The stage version; the material channels (massing-materials.ts) change every E layer's textured twin. */
export const PIPELINE_E_VERSION = `pipeline-e/v2${facadeMaterialsEnabled() ? '+mat1' : ''}`;
/** Provenance tokens of the shape program trial's parts (passed through the native tool to the nodes). */
export const SHAPE_TIERS_TOKEN = 'shape-tiers-measured';
export const SHAPE_PROGRAM_TOKEN = 'shape-program-inferred';

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

/** The native tool's parameters for E (the defaults of scratchbox_staged_massing.hpp, said here so they are in the key). */
export const MASSING_PARAMS = {
    pixel: 0.05, slabBack: 1.5, slabFront: 0.8, protrusionReach: 2.5, snapMaxM: 4.0, snapMinSupport: 0.15,
    residualProud: 0.6, residualCut: 0.6, residualClear: 1.5, residualOpen: 2.0, residualMinArea: 2.0, apronHeight: 0.8, attachReach: 1.5,
    reslabBelow: 0.35, reslabReach: 4.0
};

export interface MassingStageInput {
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

export interface MassingLayerFiles { clayGlb: string; texturedGlb: string; texturedShares: number[] }

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
        if (o) textures.set(f.index, textureFromOrtho(o));
    }
    const walls = run.report.faces.filter(f => f.kind === 'wall').map(f => textures.get(f.index)).filter((t): t is FaceTexture => !!t);
    const median = medianColour(walls) ?? medianColour([...textures.values()]) ?? [150, 150, 150];
    for (const [index, t] of textures) {
        const face = run.report.faces.find(f => f.index === index);
        // a face the tile hardly sees (a party wall, the inside of the block) takes one flat colour, not a smear of a few texels
        if ((face?.coverage ?? 0) < LOW_COVERAGE) {
            const own = (face?.coverage ?? 0) >= 0.02 ? medianColour([t]) : undefined;
            for (let i = 0; i < t.width * t.height; i++) if (t.source[i] === 255) { t.rgba.set(own ?? median, i * 4); t.rgba[i * 4 + 3] = 255; t.source[i] = SRC.facadeMedian; }
        } else fillNearest(t, undefined, median);
    }
    return { textures, legend: baseLegend() };
}

/** Writes the clay layer and its textured twin into `dir`. */
export function writeMassingLayer(run: MassingRun, massing: Pick<Massing, 'check'>, textures: Map<number, FaceTexture>, legend: TexelSource[], dir: string, stage: string, stageKey: string, name = 'massing', provenanceOf?: (n: MassingNode) => ProvenanceRecord | undefined): MassingLayerFiles {
    // de-lit (residual-tile-delight.ts): every other texel in the scene is de-lit on its way in, but a residual
    // ("as-scanned") cluster renders straight off this shared image, its own native UV, nothing else touching it
    const tileImages = new Map<number, { bytes: Uint8Array; mimeType: string }>();
    for (const im of run.report.images) {
        const f = path.join(run.dir, im.file);
        if (fs.existsSync(f)) tileImages.set(im.image, { bytes: delightTileImageBytes(fs.readFileSync(f)), mimeType: 'image/png' });
    }
    const input = {
        nodes: run.nodes, faces: run.report.faces, stage, stageKey, textures, legend, tileImages, tileLegendIndex: 0,
        provenanceOf: (n: MassingNode) => provenanceOf?.(n) ?? massingProvenance(n, massing)
    };
    const clayGlb = path.join(dir, `${name}_clay.glb`), texturedGlb = path.join(dir, `${name}_textured.glb`);
    fs.writeFileSync(clayGlb, writeMassingClayGlb(input));
    const tex = writeMassingTexturedGlb(input);
    fs.writeFileSync(texturedGlb, tex.glb);
    return { clayGlb, texturedGlb, texturedShares: tex.shares };
}

/** Step 1 and 2: the massing, its check, the native solid with orthos and residual, the plain layer files. */
export async function runMassingStage(input: MassingStageInput, stage = 'remesh', stageKey = 'pipeline-e'): Promise<MassingStageResult> {
    const timingsMs: Record<string, number> = {};
    let t = Date.now();
    const massing = input.massing ?? buildMassing({ buildings: input.buildings, groundY: input.groundY, scanTop: input.scanTop, cells: input.cells, ...(input.solar ? { solar: input.solar } : {}) });
    timingsMs.massing = Date.now() - t;
    fs.mkdirSync(input.outDir, { recursive: true });
    fs.writeFileSync(path.join(input.outDir, 'massing.json'), JSON.stringify(massing, null, 1));
    if (!massing.check.ok) return { massing, timingsMs };
    t = Date.now();
    const run = await runNativeMassing(massing, { tilePath: input.tilePath, isolateGlb: input.isolateGlb, dir: path.join(input.outDir, 'native'), groundY: input.groundY, ...(input.signal ? { signal: input.signal } : {}) });
    timingsMs.native = Date.now() - t;
    t = Date.now();
    const { textures, legend } = plainTextures(run);
    timingsMs.textures = Date.now() - t;
    t = Date.now();
    const files = writeMassingLayer(run, massing, textures, legend, input.outDir, stage, stageKey);
    timingsMs.glb = Date.now() - t;
    return { massing, run, textures, legend, files, timingsMs };
}
