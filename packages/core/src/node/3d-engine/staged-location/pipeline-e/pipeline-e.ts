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
import { buildMassing, massingSpecText, type Massing, type OpeningItem, type SweepItem } from './massing-spec';
import { writeMassingClayGlb, writeMassingTexturedGlb, type FaceTexture, type TexelSource } from './massing-glb';
import { readFaceOrtho, runMassing, type MassingNode, type MassingRun } from './native-massing';
import { baseLegend, fillNearest, medianColour, SRC, textureFromOrtho } from './face-textures';

/** Below this share of its texels covered by the tile, a face is filled with one median colour. */
export const LOW_COVERAGE = 0.35;
import type { SolarRoofSegment } from './solar-roof';

export const PIPELINE_E_VERSION = 'pipeline-e/v1';

/** SCRATCHBOX_STAGED_PIPELINE=e turns pipeline E on (off by default). */
export function stagedPipelineE(env: NodeJS.ProcessEnv = process.env): boolean {
    return (env.SCRATCHBOX_STAGED_PIPELINE ?? '').trim().toLowerCase() === 'e';
}
/** SCRATCHBOX_STAGED_PIPELINE_E_INFERENCE=0: pipeline E without its inferred steps (the bake-off's E-minus-inference arm). */
export function pipelineEInference(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_PIPELINE_E_INFERENCE !== '0';
}

/** The native tool's parameters for E (the defaults of scratchbox_staged_massing.hpp, said here so they are in the key). */
export const MASSING_PARAMS = {
    pixel: 0.05, slabBack: 1.5, slabFront: 0.8, protrusionReach: 2.5, snapMaxM: 4.0, snapMinSupport: 0.15,
    residualProud: 0.6, residualCut: 0.6, residualClear: 1.5, residualOpen: 2.0, residualMinArea: 2.0, apronHeight: 0.8, attachReach: 1.5
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
    if (node.kind === 'residual') return { label: 'as-scanned', measuredGeometry: true, method: 'scan triangles the clean massing does not explain (clearly proud of it, cut into it, or the ground apron), kept with their tile photo', sources: [{ kind: 'tile-extraction', id: 'isolate' }] };
    if (node.provenance === 'photo-inferred' || (node.kind === 'roof' && node.provenance.includes('photo-inferred'))) return { label: 'photo-inferred', measuredGeometry: false, confidence: Math.max(0, Math.min(1, node.confidence ?? 0.5)), method: `pipeline E inference: ${node.kind} read from the tile's photo and kept where the scan agrees`, sources: [{ kind: 'stage-output', id: 'pipeline-e-inference' }] };
    return {
        label: 'vector-massing', measuredGeometry: false, confidence: Math.max(0, Math.min(1, massing.check.iou)),
        method: 'pipeline E: Google vector footprint and heights (Solar roof facets, the modelled volume where one exists) extruded to a clean solid; walls moved onto the facade the scan measures',
        sources: [{ kind: 'vector-data', id: 'google-vectortiles' }], note: `plan IoU with the scan ${massing.check.iou}, roof ${massing.check.heightErrMedianM} m off the scan (median)`
    };
}

/** Runs the native tool on the massing (and, when given, the inferred openings and sweeps). */
export async function runNativeMassing(m: Pick<Massing, 'parts' | 'meshes'>, opts: { tilePath: string; isolateGlb: string; dir: string; sweeps?: SweepItem[]; openings?: OpeningItem[]; params?: Record<string, number>; signal?: AbortSignal }): Promise<MassingRun> {
    const text = massingSpecText(m, { outDir: opts.dir, tile: opts.tilePath, isolate: opts.isolateGlb, params: { ...MASSING_PARAMS, ...(opts.params ?? {}) }, sweeps: opts.sweeps, openings: opts.openings });
    return runMassing(text, opts.dir, { signal: opts.signal });
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
export function writeMassingLayer(run: MassingRun, massing: Pick<Massing, 'check'>, textures: Map<number, FaceTexture>, legend: TexelSource[], dir: string, stage: string, stageKey: string, name = 'massing'): MassingLayerFiles {
    const tileImages = new Map<number, { bytes: Uint8Array; mimeType: string }>();
    for (const im of run.report.images) {
        const f = path.join(run.dir, im.file);
        if (fs.existsSync(f)) tileImages.set(im.image, { bytes: fs.readFileSync(f), mimeType: im.mimeType || 'image/jpeg' });
    }
    const input = {
        nodes: run.nodes, faces: run.report.faces, stage, stageKey, textures, legend, tileImages, tileLegendIndex: 0,
        provenanceOf: (n: MassingNode) => massingProvenance(n, massing)
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
    const massing = buildMassing({ buildings: input.buildings, groundY: input.groundY, scanTop: input.scanTop, cells: input.cells, ...(input.solar ? { solar: input.solar } : {}) });
    timingsMs.massing = Date.now() - t;
    fs.mkdirSync(input.outDir, { recursive: true });
    fs.writeFileSync(path.join(input.outDir, 'massing.json'), JSON.stringify(massing, null, 1));
    if (!massing.check.ok) return { massing, timingsMs };
    t = Date.now();
    const run = await runNativeMassing(massing, { tilePath: input.tilePath, isolateGlb: input.isolateGlb, dir: path.join(input.outDir, 'native'), ...(input.signal ? { signal: input.signal } : {}) });
    timingsMs.native = Date.now() - t;
    t = Date.now();
    const { textures, legend } = plainTextures(run);
    timingsMs.textures = Date.now() - t;
    t = Date.now();
    const files = writeMassingLayer(run, massing, textures, legend, input.outDir, stage, stageKey);
    timingsMs.glb = Date.now() - t;
    return { massing, run, textures, legend, files, timingsMs };
}
