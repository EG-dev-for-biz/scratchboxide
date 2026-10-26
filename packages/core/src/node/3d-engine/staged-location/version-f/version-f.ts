/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Version F (experiment, not wired into the app): a procedural-first rebuild of a real building that uses the Google tile
 * only as a reference to check against, never as geometry.
 *
 *   1. READ (facade-parameters.ts): the tile seen from above, the large walls through their own orthographic cameras (with
 *      a metric ruler), two obliques of the tile and Street View photos the build already used, read once by the vision
 *      model into continuous parameters.
 *   2. GENERATE (facade-program.ts): the measured massing (pipeline E's vector footprint and heights, walls moved onto the
 *      scanned facade) given the program's openings, sweeps, piers, roof planes and raised volumes, built by the native
 *      solid builder (scratchbox_staged_massing.hpp, compiled at run time through the native build cache) with its scan
 *      residual OFF: no scan triangle reaches the output.
 *   3. CHECK (render-compare.ts): the model and the tile from the same cameras.
 *   4. ADJUST (adjust.ts): a bounded search on the parameters against that disagreement, then one silhouette check on the
 *      parapet height with real builds.
 *   Texture: option (a), pipeline E's own bake: every face of F's solid is the tile photo rendered orthographically through
 *   a thin slab about it (the native tool's bake); walls the tile hardly sees take the read wall colour with the read
 *   glazing colour in their openings, labelled `generated`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProvenanceRecord } from '../../../../common/spatial/staged-location-contracts';
import type { PinholeCamera } from '../../../../common/spatial/texture-pass-contracts';
import type { VisionModelChain } from '../../../gemini/vision-model-chain';
import { encodePng } from '../png-encode';
import { readTileTriangles, type TileTriangles } from '../tile-texture-transfer';
import { drawText, renderTriangles } from '../photo-match-eval';
import { massingSpecText, type Massing, type MassingPart } from '../pipeline-e/massing-spec';
import { readFaceOrtho, runMassing, faceToPixel, type MassingFace, type MassingNode, type MassingRun } from '../pipeline-e/native-massing';
import { MASSING_PARAMS, plainTextures, writeMassingLayer, type MassingLayerFiles } from '../pipeline-e/pipeline-e';
import type { TexelSource } from '../pipeline-e/massing-glb';
import { facadeParametersPrompt, parseFacadeParameters, FACADE_PARAMETERS_PROMPT_ID, FACADE_PARAMETERS_PROMPT_ID_V2, FACADE_PARAMETERS_PROMPT_ID_V3, type BuildingParameters, type ReadFeature, type ReadingPictureNote, type WallStoreys } from './facade-parameters';
import { facadeProgram, LABEL, SEEN_COVERAGE, type FacadeProgram, type ProgramInput, type TopDown, type WallLatticeAdjust } from './facade-program';
import { compareSilhouette, compareWall, comparisonCameras, downsampleWallTile, nodesToSoup, renderedWallOffset, soupBounds, summariseWalls, wallEvidence, wallTileFromOrtho, type SilhouetteCompare, type WallCompare, type WallEvidence } from './render-compare';
import { adjustParameters, adjustParametersNative, refineWallsNative, type AdjustRound } from './adjust';
import { NativeCompare } from './native-compare';
import { bestStreetViewForWall, type GuideView } from '../pipeline-e/plate-streetview';

export const VERSION_F_ID = 'version-f/v1';
/** The adjustment's comparison pixel (m). */
export const ADJUST_PIXEL_M = 0.15;

/** The native tool's parameters for F: pipeline E's, with the scan residual (and its ground apron) off. */
export const VERSION_F_NATIVE_PARAMS: Record<string, number> = { ...MASSING_PARAMS, residual: 0, sections: 0 };

export interface StreetViewPhoto { bytes: Uint8Array; caption: string; mimeType?: string }

export interface VersionFInput {
    place: string;
    massing: Pick<Massing, 'parts' | 'meshes' | 'check'>;
    /** The photo tile (devegetated where trees were measured): the reading's pictures, the neighbours, the texture bake. */
    tilePath: string;
    /** The isolated scan (tile_refine's raw clay): where the walls stand, and the silhouette reference. */
    isolateGlb: string;
    outDir: string;
    chain?: VisionModelChain<string>;
    streetViewPhotos?: StreetViewPhoto[];
    /** Skip the reading and use these parameters (tests, replays). */
    reading?: BuildingParameters;
    rounds?: number;
    onProgress?: (m: string) => void;
}

export interface CheckNumbers { silhouettes: SilhouetteCompare[]; walls: WallCompare[]; summary: { silhouetteIou: number; topIou: number; obliqueDepthMedianM: number; windowNcc: number; edgeDistM: number; wallDepthMaeM: number; wallDepthWithin015: number; seenWalls: number } }

/** Round 3: one wall's own reading (its call, in parallel with the others'). */
export interface WallReadingNote { face: number; key: string; areaM2: number; model?: string; ms: number; defaulted: string[]; failed?: string; raw?: string; features: number }

export interface VersionFResult {
    files: MassingLayerFiles;
    reading: { params: BuildingParameters; defaulted: string[]; model?: string; promptId: string; pictures: ReadingPictureNote[]; raw?: string; walls?: WallReadingNote[] };
    adjusted: BuildingParameters;
    perWall: Array<{ face: number; pitchScale: number; phaseM: number; storeyShiftM?: number; storeyScale?: number }>;
    program: Pick<FacadeProgram, 'notes' | 'walls' | 'pitchedParts' | 'volumeParts'> & { openings: number; sweeps: number; faceSweeps: number; rejectedOpenings: number; rejectedSweeps: number };
    before: CheckNumbers;
    after: CheckNumbers;
    rounds: AdjustRound[];
    silhouetteRound?: { tried: Array<{ parapetM: number; silhouetteIou: number }>; kept: number };
    nodes: { total: number; byLabel: Record<string, number>; residual: number; vertices: number; triangles: number };
    timingsMs: Record<string, number>;
}

const srgb = (c: number) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));

/** The native run of F's solid (residual off). */
async function build(input: VersionFInput, parts: MassingPart[], prog: Partial<Pick<FacadeProgram, 'openings' | 'sweeps' | 'faceSweeps'>>, dir: string, extra: Record<string, number> = {}): Promise<MassingRun> {
    const text = massingSpecText({ parts, meshes: input.massing.meshes }, {
        outDir: dir, tile: input.tilePath, isolate: input.isolateGlb, params: { ...VERSION_F_NATIVE_PARAMS, ...extra },
        openings: prog.openings ?? [], sweeps: prog.sweeps ?? [], faceSweeps: prog.faceSweeps ?? [], provenance: LABEL.vector
    });
    // runMassing's own default (180 s) was sized for pipeline E's plain use (one call); version F calls it several
    // times a round (native_before, native_parapet_N trials, native, native0, native_sv) and the grammar stage's own
    // budget already gives the whole thing up to 900 s for exactly that - a single call needs more room than 180 s on
    // a building with an unusually large or complex massing spec (measured live: the Flatiron's spec alone is 397 KB,
    // and its native massing call outran 180 s without erroring, just still working). The orchestrator's stage-level
    // deadline is still the real outer bound against a runaway; this only stops one call starving itself early.
    return runMassing(text, dir, { timeoutMs: 300_000 });
}

/** The full tile's top (max y) on a 0.5 m grid round the building: what stands just outside each wall. */
export function neighbourTopFn(tile: Pick<TileTriangles, 'positions'>, faces: MassingFace[], groundY: number): (f: MassingFace, s: number) => number {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const f of faces) if (f.kind === 'wall') for (const s of [f.sMin, f.sMax]) { const x = f.origin[0] + f.axisS[0] * s, z = f.origin[2] + f.axisS[2] * s; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    if (!Number.isFinite(x0)) return () => -Infinity;
    const cell = 0.5, pad = 8;
    x0 -= pad; z0 -= pad; x1 += pad; z1 += pad;
    const W = Math.ceil((x1 - x0) / cell), H = Math.ceil((z1 - z0) / cell);
    const top = new Float32Array(W * H).fill(-Infinity);
    const P = tile.positions;
    for (let t = 0; t + 8 < P.length; t += 9) {
        // the triangle's height at each cell centre inside it (a melted facade's long sloping triangles must not lend their
        // top to every cell of their bounding box)
        const ax = P[t], az = P[t + 2], bx = P[t + 3], bz = P[t + 5], cx = P[t + 6], cz = P[t + 8];
        const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
        if (Math.abs(det) < 1e-9) continue;
        const ca = Math.max(0, Math.floor((Math.min(ax, bx, cx) - x0) / cell)), cb = Math.min(W - 1, Math.floor((Math.max(ax, bx, cx) - x0) / cell));
        const ra = Math.max(0, Math.floor((Math.min(az, bz, cz) - z0) / cell)), rb = Math.min(H - 1, Math.floor((Math.max(az, bz, cz) - z0) / cell));
        for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) {
            const x = x0 + (c + 0.5) * cell, z = z0 + (r + 0.5) * cell;
            const l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det, l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det, l3 = 1 - l1 - l2;
            if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
            const y = l1 * P[t + 1] + l2 * P[t + 4] + l3 * P[t + 7];
            if (y > top[r * W + c]) top[r * W + c] = y;
        }
    }
    const at = (x: number, z: number) => { const c = Math.floor((x - x0) / cell), r = Math.floor((z - z0) / cell); return c < 0 || r < 0 || c >= W || r >= H ? -Infinity : top[r * W + c]; };
    return (f, s) => {
        const bx = f.origin[0] + f.axisS[0] * s, bz = f.origin[2] + f.axisS[2] * s;
        // the lowest of three samples 3-6 m out: a neighbour's roof is high at all three; a pole, a lamp, a fire escape or
        // the facade's own melted bulge at most at one
        let m = Infinity;
        for (const d of [3, 4.5, 6]) m = Math.min(m, at(bx + f.normal[0] * d, bz + f.normal[2] * d));
        return m > groundY + 2.5 ? m : -Infinity;
    };
}

/** A wall ortho with a metric ruler at its left (a tick every metre above the ground, long every 5 m). */
export function wallWithRuler(rgba: Uint8Array, f: Pick<MassingFace, 'width' | 'height' | 'orthoTMax' | 'pixel'>, groundY: number): { png: Buffer; width: number; height: number } {
    const M = 56, W = f.width + M, H = f.height;
    const rgb = new Uint8Array(W * H * 3).fill(40);
    for (let y = 0; y < H; y++) for (let x = 0; x < f.width; x++) {
        const s = (y * f.width + x) * 4, o = (y * W + x + M) * 3;
        const a = rgba[s + 3] / 255;
        for (let k = 0; k < 3; k++) rgb[o + k] = Math.round(rgba[s + k] * a + 128 * (1 - a));
    }
    for (let m = 0; m < 400; m++) {
        const y = Math.round((f.orthoTMax - (groundY + m)) / f.pixel);
        if (y < 0) break;
        if (y >= H) continue;
        const len = m % 5 === 0 ? 22 : 10;
        for (let x = M - len; x < M; x++) for (let dy = 0; dy < 2 && y + dy < H; dy++) { const o = ((y + dy) * W + x) * 3; rgb[o] = rgb[o + 1] = rgb[o + 2] = 255; }
        if (m % 5 === 0) drawText(rgb, W, H, 2, Math.max(0, y - 8), String(m), 2, [255, 255, 255]);
    }
    return { png: encodePng(W, H, rgb, 3), width: W, height: H };
}

/** A pinhole camera at `eye` looking at `target`. */
function lookAt(eye: [number, number, number], target: [number, number, number], width: number, height: number, hfovDeg: number): PinholeCamera {
    const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
    const fl = Math.hypot(f[0], f[1], f[2]);
    const fwd: [number, number, number] = [f[0] / fl, f[1] / fl, f[2] / fl];
    const r = [fwd[1] * 0 - fwd[2] * 1, fwd[2] * 0 - fwd[0] * 0, fwd[0] * 1 - fwd[1] * 0];
    const rl = Math.hypot(r[0], r[1], r[2]) || 1;
    const right: [number, number, number] = [r[0] / rl, r[1] / rl, r[2] / rl];
    const up: [number, number, number] = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const fx = width / 2 / Math.tan((hfovDeg * Math.PI) / 360);
    return { eye, right, up, fwd, fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

/** Step 1: the pictures and the one reading. */
async function read(input: VersionFInput, run0: MassingRun, tile: TileTriangles, groundY: number, dir: string, shapes = false): Promise<VersionFResult['reading']> {
    const pictures: ReadingPictureNote[] = [];
    /** The face key of each picture (by position), for walls; undefined for the others. */
    const wallKeys: Array<string | undefined> = [];
    const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
    const add = (png: Buffer | Uint8Array, mime: string, note: ReadingPictureNote, file: string) => {
        parts.push({ inlineData: { mimeType: mime, data: Buffer.from(png).toString('base64') } });
        pictures.push(note);
        wallKeys.push(undefined);
        fs.writeFileSync(path.join(dir, file), png);
    };
    const td = run0.report.topdown;
    if (td) add(fs.readFileSync(path.join(run0.dir, td.image)), 'image/png', { role: 'top-down', caption: `The building's scan seen straight down (north up), ${(td.width * td.pixel).toFixed(1)} m wide and ${(td.rows * td.pixel).toFixed(1)} m tall; grey is outside the scan.` }, 'read_topdown.png');
    const walls = run0.report.faces.filter(f => f.kind === 'wall' && f.width > 0 && f.coverage >= 0.5).sort((a, b) => b.area - a.area).slice(0, 4);
    for (const f of walls) {
        const o = readFaceOrtho(run0.dir, f);
        if (!o) continue;
        const r = wallWithRuler(o.rgba, f, groundY);
        const az = ((Math.atan2(f.normal[0], -f.normal[2]) * 180) / Math.PI + 360) % 360;
        add(r.png, 'image/png', { role: 'wall', caption: `An orthographic picture of one wall (facing compass ${az.toFixed(0)} deg), ${(f.sMax - f.sMin).toFixed(1)} m wide, from ${(f.tBottom - groundY).toFixed(1)} m to ${(f.tMax - groundY).toFixed(1)} m above the street, ruler at the left; grey is where the scan has no photo.` }, `read_wall_${f.index}.png`);
        wallKeys[wallKeys.length - 1] = f.key;
    }
    // two obliques of the photo tile towards the two largest seen walls
    const all = nodesToSoup(run0.nodes);
    const b = soupBounds(all);
    const c: [number, number, number] = [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2];
    const radius = Math.hypot(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) / 2;
    for (const f of walls.slice(0, 2)) {
        const d = radius * 2.2;
        const eye: [number, number, number] = [c[0] + f.normal[0] * d * 0.8, c[1] + d * 0.6, c[2] + f.normal[2] * d * 0.8];
        const cam = lookAt(eye, c, 768, 576, 50);
        const r = renderTriangles([tile], cam, { supersample: 1 });
        add(encodePng(r.width, r.height, r.rgba, 4), 'image/png', { role: 'oblique', caption: 'An oblique view of the photogrammetric tile (the building in the middle, its street around it), looking down at about 35 deg.' }, `read_oblique_${f.index}.png`);
    }
    (input.streetViewPhotos ?? []).slice(0, 2).forEach((p, k) => add(p.bytes, p.mimeType ?? 'image/jpeg', { role: 'street view', caption: p.caption }, `read_streetview_${k}.${p.mimeType === 'image/png' ? 'png' : 'jpg'}`));
    const prompt = facadeParametersPrompt(input.place, pictures, { shapes });
    fs.writeFileSync(path.join(dir, 'read_prompt.txt'), prompt);
    if (input.reading) return { params: { ...input.reading, facadeBands: input.reading.facadeBands ?? [], wallStoreys: input.reading.wallStoreys ?? [] }, defaulted: [], promptId: FACADE_PARAMETERS_PROMPT_ID, pictures };
    if (!input.chain) throw new Error('version F needs a vision model to read the parameters (none configured)');
    const r = await input.chain.generate({ contents: [{ role: 'user', parts: [...parts, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0 } }, { stage: 'grammar' });
    const text = r.response.candidates?.[0]?.content?.parts?.map(q => q.text ?? '').join('') ?? '';
    const parsed = parseFacadeParameters(text);
    r.remember();
    // a wall's own storeys name the picture they were read from: tie them to that wall
    parsed.params.wallStoreys = parsed.params.wallStoreys.map(w => ({ ...w, ...(wallKeys[w.picture - 1] ? { faceKey: wallKeys[w.picture - 1] } : {}) })).filter(w => w.faceKey);
    return { ...parsed, model: r.model, promptId: shapes ? FACADE_PARAMETERS_PROMPT_ID_V2 : FACADE_PARAMETERS_PROMPT_ID, pictures, raw: text };
}

/** Render-compare of one built solid. */
export function check(run: MassingRun, isoSoup: Float32Array, evidence: WallEvidence[]): CheckNumbers {
    const model = nodesToSoup(run.nodes);
    const cams = comparisonCameras(soupBounds(isoSoup));
    const silhouettes = cams.map(c => compareSilhouette(c.id, model, isoSoup, c.cam));
    // the evidence keeps the first run's face frames (the rebuilt solid's walls stand where they did)
    const walls = evidence.map(ev => compareWall(ev, renderedWallOffset(model, ev.tile.face)));
    const s = summariseWalls(walls);
    const obl = silhouettes.filter(x => x.id.startsWith('oblique'));
    const mean = (v: number[]) => (v.length ? v.reduce((a, x) => a + x, 0) / v.length : NaN);
    return {
        silhouettes, walls,
        summary: { silhouetteIou: mean(obl.map(x => x.iou)), topIou: silhouettes.find(x => x.id === 'top')?.iou ?? NaN, obliqueDepthMedianM: mean(obl.map(x => x.depthMedianM)), windowNcc: s.windowNcc, edgeDistM: s.edgeDistM, wallDepthMaeM: s.depthMaeM, wallDepthWithin015: s.depthWithin015, seenWalls: s.walls }
    };
}

/** F's provenance per node (open labels). */
export function versionFProvenance(node: Pick<MassingNode, 'kind' | 'name' | 'provenance' | 'confidence'>, ctx: { pitchedParts: Set<string>; volumeParts: Set<string>; partHeightSource: Map<string, string>; iou: number }): ProvenanceRecord {
    const conf = Math.max(0.05, Math.min(1, node.confidence ?? 0.5));
    if (node.kind === 'residual') return { label: 'as-scanned', measuredGeometry: true, method: 'scan triangles (version F never keeps any; this would be a fault)', sources: [{ kind: 'tile-extraction', id: 'isolate' }] };
    if (node.kind === 'opening' || node.kind === 'sweep' || node.kind === 'facesweep') {
        const generated = node.provenance === LABEL.generated;
        return {
            label: generated ? LABEL.generated : LABEL.inferred, measuredGeometry: false, confidence: conf,
            method: generated
                ? `version F: ${node.kind} placed by the building's read facade rules on a wall the tile hardly sees (no photo of it); the same storey heights, bay spacing and profiles as the seen walls`
                : `version F: ${node.kind} from one vision reading of the building's facade system as continuous dimensions (storey heights, bay spacing, opening sizes, profiles), adjusted against the tile's renders from the same cameras`,
            sources: [{ kind: 'stage-output', id: VERSION_F_ID }]
        };
    }
    // face keys are '<kind letter>:<part id>:...' (part ids hold no ':')
    const part = node.name.split(':')[1];
    if (part !== undefined && ctx.volumeParts.has(part)) return { label: LABEL.inferred, measuredGeometry: false, confidence: conf, method: 'version F: a raised roof volume at the footprint the vision reading gave, its height the scan\'s where the scan shows it', sources: [{ kind: 'stage-output', id: VERSION_F_ID }] };
    if (part !== undefined && node.kind === 'roof' && ctx.pitchedParts.has(part)) return { label: LABEL.inferred, measuredGeometry: false, confidence: conf, method: 'version F: roof planes at the read pitch and ridge direction, from the eave height the scan measures', sources: [{ kind: 'stage-output', id: VERSION_F_ID }] };
    const measured = part !== undefined && ctx.partHeightSource.get(part) === 'scan';
    return {
        label: measured ? LABEL.measured : LABEL.vector, measuredGeometry: false, confidence: Math.max(0.05, Math.min(1, ctx.iou)),
        method: measured ? 'version F: footprint from Google vector data, height measured on the scan; walls moved onto the facade the scan measures' : 'version F: Google vector footprint and heights (Solar roof facets, the modelled volume where one exists), walls moved onto the facade the scan measures',
        sources: [{ kind: 'vector-data', id: 'google-vectortiles' }]
    };
}

/** What planning version F needs beyond the input: the first massing run (its orthos are the walls' reference frames). */
export interface VersionFPlanInput extends VersionFInput {
    run0: MassingRun;
    /** Round 1's program exactly (legacy program, parapet kept on any gain). */
    legacy?: boolean;
}

export interface VersionFPlan {
    reading: VersionFResult['reading'];
    params: BuildingParameters;
    perWall: Map<number, WallLatticeAdjust>;
    prog: FacadeProgram;
    runB: MassingRun;
    before: CheckNumbers;
    after: CheckNumbers;
    rounds: AdjustRound[];
    silhouetteRound: NonNullable<VersionFResult['silhouetteRound']>;
    ctx: { pitchedParts: Set<string>; volumeParts: Set<string>; partHeightSource: Map<string, string>; iou: number };
    evidence: WallEvidence[];
    base: ProgramInput;
    groundY: number;
    timingsMs: Record<string, number>;
}

/** A silhouette change must raise the obliques' and top view's mean IoU by this much to replace the read parapet. */
export const MIN_SILHOUETTE_GAIN = 0.01;

/** Steps 1-4: read, generate, check, adjust; the final solid (bake on). No textures. */
export async function planVersionF(input: VersionFPlanInput): Promise<VersionFPlan> {
    const T: Record<string, number> = {};
    const progress = input.onProgress ?? (() => undefined);
    const run0 = input.run0;
    fs.mkdirSync(input.outDir, { recursive: true });
    const groundY = Math.min(...input.massing.parts.map(p => p.baseY), ...input.massing.meshes.flatMap(m => m.vertices.map(v => v[1])));
    let t = Date.now();
    const tile = readTileTriangles(fs.readFileSync(input.tilePath));
    const iso = readTileTriangles(fs.readFileSync(input.isolateGlb));
    T.load = Date.now() - t;
    t = Date.now();
    progress('version F: reading the facade system');
    const reading = await read(input, run0, tile, groundY, input.outDir, !input.legacy);
    T.read = Date.now() - t;
    const td0 = run0.report.topdown;
    let topdown: TopDown | undefined;
    if (td0) { const b = fs.readFileSync(path.join(run0.dir, td0.height)); topdown = { x0: td0.x0, z0: td0.z0, pixel: td0.pixel, width: td0.width, rows: td0.rows, height: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }; }
    const base: ProgramInput = { faces: run0.report.faces, parts: input.massing.parts, groundY, params: reading.params, neighbourTop: neighbourTopFn(tile, run0.report.faces, groundY), ...(topdown ? { topdown } : {}), ...(input.legacy ? { legacy: true } : {}) };
    // the seen walls' evidence and the plain wall masks (the first run's scan residual, when it has one, is not the massing)
    t = Date.now();
    const baseSoup = nodesToSoup(run0.nodes, n => n.kind !== 'residual');
    const evidence: WallEvidence[] = [], coarseEvidence: WallEvidence[] = [];
    const inside = new Map<number, Uint8Array>();
    for (const f of run0.report.faces) {
        if (f.kind !== 'wall' || !f.width || f.coverage < 0.5 || f.area < 30) continue;
        if (base.neighbourTop && base.neighbourTop(f, (f.sMin + f.sMax) / 2) > (f.tBottom + f.tMax) / 2) continue;
        const o = readFaceOrtho(run0.dir, f);
        if (!o) continue;
        const full = wallTileFromOrtho(f, o.rgba, o.depth);
        evidence.push(wallEvidence(full));
        // the adjustment compares at 0.1-0.2 m (a step then costs milliseconds); the checks at the ortho's own pixel
        const coarse = downsampleWallTile(full, Math.max(1, Math.round(ADJUST_PIXEL_M / f.pixel)));
        coarseEvidence.push(wallEvidence(coarse));
        const off = renderedWallOffset(baseSoup, coarse.face);
        inside.set(f.index, Uint8Array.from(off, v => (Number.isFinite(v) ? 1 : 0)));
    }
    T.evidence = Date.now() - t;
    t = Date.now();
    progress('version F: generating the building from the read parameters');
    const prog0 = facadeProgram(base);
    const runA = await build(input, prog0.parts, prog0, path.join(input.outDir, 'native_before'), { bake: 0, topdown: 0 });
    T.generate = Date.now() - t;
    t = Date.now();
    const isoSoup = iso.positions;
    const before = check(runA, isoSoup, evidence);
    T.check = Date.now() - t;
    t = Date.now();
    progress('version F: adjusting the parameters against the tile');
    const adj = adjustParameters(base, coarseEvidence, inside, input.rounds ?? 3, { shapes: !input.legacy });
    let params = adj.params;
    // the silhouette round: the parapet height against the obliques and the top view, with real builds; round 2 keeps the read
    // height unless another raises the mean IoU by MIN_SILHOUETTE_GAIN (round 1 took any gain: a 2 m parapet for 0.001)
    let silhouetteRound: VersionFPlan['silhouetteRound'];
    {
        const h = params.parapet.heightM;
        const tries = [...new Set([h, h + 0.5, Math.max(0, h - 0.5)].map(v => Math.round(v * 100) / 100))];
        const tried: Array<{ parapetM: number; silhouetteIou: number }> = [];
        for (const v of tries) {
            const pv = { ...params, parapet: { heightM: v } };
            const pr = facadeProgram({ ...base, params: pv, perWall: adj.perWall });
            const rr = await build(input, pr.parts, pr, path.join(input.outDir, `native_parapet_${v}`), { bake: 0, topdown: 0 });
            const model = nodesToSoup(rr.nodes);
            const cams = comparisonCameras(soupBounds(isoSoup));
            const iou = cams.map(c => compareSilhouette(c.id, model, isoSoup, c.cam).iou).reduce((a, x) => a + x, 0) / cams.length;
            tried.push({ parapetM: v, silhouetteIou: iou });
            fs.rmSync(rr.dir, { recursive: true, force: true });
        }
        const read0 = tried.find(x => x.parapetM === Math.round(h * 100) / 100)!;
        let best = read0;
        for (const x of tried) if (x.silhouetteIou > best.silhouetteIou + (input.legacy ? 1e-4 : MIN_SILHOUETTE_GAIN)) best = x;
        params = { ...params, parapet: { heightM: best.parapetM } };
        silhouetteRound = { tried, kept: best.parapetM };
    }
    T.adjust = Date.now() - t;
    t = Date.now();
    progress('version F: the adjusted building');
    const prog = facadeProgram({ ...base, params, perWall: adj.perWall });
    const runB = await build(input, prog.parts, prog, path.join(input.outDir, 'native'), { topdown: 0 });
    T.generateFinal = Date.now() - t;
    t = Date.now();
    const after = check(runB, isoSoup, evidence);
    T.checkFinal = Date.now() - t;
    fs.rmSync(runA.dir, { recursive: true, force: true });
    const ctx = { pitchedParts: new Set(prog.pitchedParts), volumeParts: new Set(prog.volumeParts), partHeightSource: new Map(prog.parts.map(p => [p.id, String(p.heightSource)])), iou: input.massing.check.iou };
    return { reading, params, perWall: adj.perWall, prog, runB, before, after, rounds: adj.rounds, silhouetteRound, ctx, evidence, base, groundY, timingsMs: T };
}

/**
 * The structure guide of one wall for the image model: the planned model's surface in the wall's own frame (mid grey wall,
 * dark openings, light projecting bands and piers, black outside the wall), PNG.
 */
export function structureGuidePng(plan: Pick<VersionFPlan, 'runB'>, f: MassingFace): { png: Buffer; offset: Float32Array } {
    const off = renderedWallOffset(nodesToSoup(plan.runB.nodes), f);
    const rgb = new Uint8Array(f.width * f.height * 3);
    for (let i = 0; i < off.length; i++) {
        const v = off[i];
        const g = !Number.isFinite(v) ? 0 : v < -0.05 ? 45 : v > 0.05 ? 215 : 140;
        rgb[i * 3] = rgb[i * 3 + 1] = rgb[i * 3 + 2] = g;
    }
    return { png: encodePng(f.width, f.height, rgb, 3), offset: off };
}

/** Summary numbers of a plan and its final solid. */
export function planSummary(plan: VersionFPlan): Pick<VersionFResult, 'adjusted' | 'perWall' | 'program' | 'before' | 'after' | 'rounds' | 'silhouetteRound' | 'nodes'> {
    const byLabel: Record<string, number> = {};
    let vertices = 0, triangles = 0;
    for (const n of plan.runB.nodes) { const l = versionFProvenance(n, plan.ctx).label; byLabel[l] = (byLabel[l] ?? 0) + 1; vertices += n.positions.length / 3; triangles += n.indices.length / 3; }
    const prog = plan.prog;
    return {
        adjusted: plan.params, perWall: [...plan.perWall].map(([face, a]) => ({ face, pitchScale: a.pitchScale, phaseM: a.phaseM, ...(a.storeyShiftM !== undefined ? { storeyShiftM: a.storeyShiftM } : {}), ...(a.storeyScale !== undefined ? { storeyScale: a.storeyScale } : {}) })),
        program: { notes: prog.notes, walls: prog.walls, pitchedParts: prog.pitchedParts, volumeParts: prog.volumeParts, openings: prog.openings.length, sweeps: prog.sweeps.length, faceSweeps: prog.faceSweeps.length, rejectedOpenings: plan.runB.report.rejectedOpenings.length, rejectedSweeps: plan.runB.report.rejectedSweeps.length },
        before: plan.before, after: plan.after, rounds: plan.rounds, silhouetteRound: plan.silhouetteRound,
        nodes: { total: plan.runB.nodes.length, byLabel, residual: plan.runB.nodes.filter(n => n.kind === 'residual').length, vertices, triangles }
    };
}

/** Runs version F for one building with option (a) textures (the dev driver; round 1's F, or `legacy`). */
export async function runVersionF(input: VersionFInput & { legacy?: boolean }): Promise<VersionFResult> {
    const progress = input.onProgress ?? (() => undefined);
    fs.mkdirSync(input.outDir, { recursive: true });
    let t = Date.now();
    progress('version F: the measured massing and the tile\'s orthographic cameras');
    const run0 = await build(input, input.massing.parts, {}, path.join(input.outDir, 'native0'), { topdown: 1 });
    const massingMs = Date.now() - t;
    const plan = await planVersionF({ ...input, run0 });
    const T: Record<string, number> = { massing: massingMs, ...plan.timingsMs };
    t = Date.now();
    const { runB, prog, params } = plan;
    const { textures, legend } = plainTextures(runB);
    const READ = legend.length;
    const legendF: TexelSource[] = [...legend, { source: 'version-f-read-colour', label: LABEL.generated, method: 'a wall the tile hardly sees: the wall colour the vision reading gave, the read glazing colour in its openings', rung: 3, weight: 0.1 }];
    const wallRgb = params.materials.wall.linearRgb.map(srgb), glassRgb = params.materials.glazing.linearRgb.map(srgb);
    for (const f of runB.report.faces) {
        if (f.kind !== 'wall' || f.coverage >= SEEN_COVERAGE) continue;
        const tx = textures.get(f.index);
        if (!tx) continue;
        for (let i = 0; i < tx.width * tx.height; i++) { tx.rgba[i * 4] = wallRgb[0]; tx.rgba[i * 4 + 1] = wallRgb[1]; tx.rgba[i * 4 + 2] = wallRgb[2]; tx.rgba[i * 4 + 3] = 255; tx.source[i] = READ; }
        for (const o of prog.openings) if (o.face === f.key) {
            const [xa, ya] = faceToPixel(f, o.s0, o.t1), [xb, yb] = faceToPixel(f, o.s1, o.t0);
            for (let y = Math.max(0, Math.round(ya)); y < Math.min(tx.height, Math.round(yb)); y++) for (let x = Math.max(0, Math.round(xa)); x < Math.min(tx.width, Math.round(xb)); x++) { const i = y * tx.width + x; tx.rgba[i * 4] = glassRgb[0]; tx.rgba[i * 4 + 1] = glassRgb[1]; tx.rgba[i * 4 + 2] = glassRgb[2]; }
        }
    }
    const files = writeMassingLayer(runB, input.massing, textures, legendF, input.outDir, 'remesh', VERSION_F_ID, 'version_f', n => versionFProvenance(n, plan.ctx));
    T.texture = Date.now() - t;
    T.total = Object.values(T).reduce((a, x) => a + x, 0);
    return { files, reading: plan.reading, ...planSummary(plan), timingsMs: T };
}

// ---------------------------------------------------------------------------------------------------------------------
// Round 3
// ---------------------------------------------------------------------------------------------------------------------

/** The seen walls the reading and the adjustment work on (the same rule as the evidence's). */
export function readableWalls(run0: MassingRun, maxWalls = 6): MassingFace[] {
    return run0.report.faces.filter(f => f.kind === 'wall' && f.width > 0 && f.coverage >= 0.5 && f.area >= 30).sort((a, b) => b.area - a.area).slice(0, maxWalls);
}

/**
 * Round 3, step 1: one reading per seen wall, every call at once. Each call shows the scan from above, THAT wall through
 * its orthographic camera with the ruler, the two obliques and the Street View photos, and asks for the wall's own numbers
 * and must-keep features. The building's parameters are the largest wall's; every other wall keeps its own storeys, bays,
 * families and bands (`wallStoreys`), and the features of every wall are tied to it. A wall whose reading fails keeps the
 * building's numbers, and the note says so; the reading fails only when no wall could be read.
 */
export async function readPerWall(input: VersionFInput, run0: MassingRun, tile: TileTriangles, groundY: number, dir: string): Promise<VersionFResult['reading']> {
    const shared: Array<{ part: { inlineData: { mimeType: string; data: string } }; note: ReadingPictureNote }> = [];
    const addShared = (png: Buffer | Uint8Array, mime: string, note: ReadingPictureNote, file: string) => {
        shared.push({ part: { inlineData: { mimeType: mime, data: Buffer.from(png).toString('base64') } }, note });
        fs.writeFileSync(path.join(dir, file), png);
    };
    const td = run0.report.topdown;
    if (td) addShared(fs.readFileSync(path.join(run0.dir, td.image)), 'image/png', { role: 'top-down', caption: `The building's scan seen straight down (north up), ${(td.width * td.pixel).toFixed(1)} m wide and ${(td.rows * td.pixel).toFixed(1)} m tall; grey is outside the scan.` }, 'read_topdown.png');
    const walls = readableWalls(run0);
    const all = nodesToSoup(run0.nodes);
    const b = soupBounds(all);
    const c: [number, number, number] = [(b.lo[0] + b.hi[0]) / 2, (b.lo[1] + b.hi[1]) / 2, (b.lo[2] + b.hi[2]) / 2];
    const radius = Math.hypot(b.hi[0] - b.lo[0], b.hi[1] - b.lo[1], b.hi[2] - b.lo[2]) / 2;
    const obliques: typeof shared = [];
    for (const f of walls.slice(0, 2)) {
        const d = radius * 2.2;
        const eye: [number, number, number] = [c[0] + f.normal[0] * d * 0.8, c[1] + d * 0.6, c[2] + f.normal[2] * d * 0.8];
        const r = renderTriangles([tile], lookAt(eye, c, 768, 576, 50), { supersample: 1 });
        const png = encodePng(r.width, r.height, r.rgba, 4);
        fs.writeFileSync(path.join(dir, `read_oblique_${f.index}.png`), png);
        obliques.push({ part: { inlineData: { mimeType: 'image/png', data: Buffer.from(png).toString('base64') } }, note: { role: 'oblique', caption: 'An oblique view of the photogrammetric tile (the building in the middle, its street around it), looking down at about 35 deg.' } });
    }
    const photos: typeof shared = (input.streetViewPhotos ?? []).slice(0, 2).map((p, k) => {
        fs.writeFileSync(path.join(dir, `read_streetview_${k}.${p.mimeType === 'image/png' ? 'png' : 'jpg'}`), p.bytes);
        return { part: { inlineData: { mimeType: p.mimeType ?? 'image/jpeg', data: Buffer.from(p.bytes).toString('base64') } }, note: { role: 'street view', caption: p.caption } };
    });
    if (input.reading) {
        const params = { ...input.reading, facadeBands: input.reading.facadeBands ?? [], wallStoreys: input.reading.wallStoreys ?? [], featureRegions: input.reading.featureRegions ?? [] };
        return { params, defaulted: [], promptId: FACADE_PARAMETERS_PROMPT_ID_V3, pictures: shared.map(x => x.note) };
    }
    if (!input.chain) throw new Error('version F needs a vision model to read the parameters (none configured)');
    if (!walls.length) throw new Error('version F: no wall of the massing is seen well enough to read (coverage under 0.5 or under 30 m2)');
    const chain = input.chain;
    const one = async (f: MassingFace): Promise<{ f: MassingFace; parsed?: ReturnType<typeof parseFacadeParameters>; model?: string; raw?: string; failed?: string; ms: number; pictures: ReadingPictureNote[] }> => {
        const t0 = Date.now();
        const o = readFaceOrtho(run0.dir, f);
        if (!o) return { f, failed: 'no orthographic picture of the wall', ms: 0, pictures: [] };
        const r = wallWithRuler(o.rgba, f, groundY);
        fs.writeFileSync(path.join(dir, `read_wall_${f.index}.png`), r.png);
        const az = ((Math.atan2(f.normal[0], -f.normal[2]) * 180) / Math.PI + 360) % 360;
        const wallPic = { part: { inlineData: { mimeType: 'image/png', data: r.png.toString('base64') } }, note: { role: 'wall', caption: `An orthographic picture of THIS wall (facing compass ${az.toFixed(0)} deg), ${(f.sMax - f.sMin).toFixed(1)} m wide, from ${(f.tBottom - groundY).toFixed(1)} m to ${(f.tMax - groundY).toFixed(1)} m above the street, ruler at the left; grey is where the scan has no photo.` } };
        const pics = [...shared, wallPic, ...obliques, ...photos];
        const wallPicture = shared.length + 1;
        const prompt = facadeParametersPrompt(input.place, pics.map(x => x.note), { shapes: true, wall: { picture: wallPicture } });
        fs.writeFileSync(path.join(dir, `read_prompt_wall_${f.index}.txt`), prompt);
        try {
            const res = await chain.generate({ contents: [{ role: 'user', parts: [...pics.map(x => x.part), { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0 } }, { stage: 'grammar' });
            const text = res.response.candidates?.[0]?.content?.parts?.map(q => q.text ?? '').join('') ?? '';
            const parsed = parseFacadeParameters(text);
            res.remember();
            // everything read on the wall picture is this wall's
            parsed.params.wallStoreys = parsed.params.wallStoreys.filter(w => w.picture === wallPicture).map(w => ({ ...w, faceKey: f.key }));
            parsed.params.featureRegions = (parsed.params.featureRegions ?? []).filter(x => x.picture === wallPicture).map(x => ({ ...x, faceKey: f.key }));
            return { f, parsed, model: res.model, raw: text, ms: Date.now() - t0, pictures: pics.map(x => x.note) };
        } catch (err) {
            return { f, failed: (err as Error).message.slice(0, 200), ms: Date.now() - t0, pictures: pics.map(x => x.note) };
        }
    };
    const results = await Promise.all(walls.map(one));
    const ok = results.filter(r => r.parsed);
    if (!ok.length) throw new Error(`version F: no wall could be read (${results.map(r => `wall ${r.f.index}: ${r.failed}`).join('; ')})`);
    const main = ok[0];
    const params: BuildingParameters = JSON.parse(JSON.stringify(main.parsed!.params));
    const toOwn = (r: typeof ok[number]): WallStoreys => {
        const p = r.parsed!.params;
        const own = p.wallStoreys[0];
        return { picture: 2, faceKey: r.f.key, groundStoreyM: own?.groundStoreyM ?? p.groundStoreyM, upperStoreysM: own?.upperStoreysM ?? p.upperStoreysM, bayWidthM: own?.bayWidthM ?? p.bayWidthM, edgeMarginM: own?.edgeMarginM ?? p.edgeMarginM, window: own?.window ?? p.window, groundOpening: own?.groundOpening ?? p.groundOpening, facadeBands: own?.facadeBands ?? p.facadeBands };
    };
    // the largest wall's own entry is the building's numbers: no entry for it; every other read wall keeps its own
    params.wallStoreys = ok.slice(1).map(toOwn);
    const features: ReadFeature[] = [];
    for (const r of ok) features.push(...(r.parsed!.params.featureRegions ?? []));
    params.featureRegions = features;
    params.features = [...new Set(ok.flatMap(r => r.parsed!.params.features))].slice(0, 24);
    // raised volumes: the main reading's, plus another wall's that overlap none of them
    for (const r of ok.slice(1)) for (const v of r.parsed!.params.rooftopVolumes) {
        const overlaps = params.rooftopVolumes.some(u => Math.min(u.box[2], v.box[2]) - Math.max(u.box[0], v.box[0]) > 0 && Math.min(u.box[3], v.box[3]) - Math.max(u.box[1], v.box[1]) > 0);
        if (!overlaps && params.rooftopVolumes.length < 16) params.rooftopVolumes.push(v);
    }
    const wallsNote: WallReadingNote[] = results.map(r => ({ face: r.f.index, key: r.f.key, areaM2: Math.round(r.f.area), ...(r.model ? { model: r.model } : {}), ms: r.ms, defaulted: r.parsed?.defaulted ?? [], ...(r.failed ? { failed: r.failed } : {}), ...(r.raw ? { raw: r.raw } : {}), features: r.parsed?.params.featureRegions?.length ?? 0 }));
    return { params, defaulted: main.parsed!.defaulted, model: main.model, promptId: FACADE_PARAMETERS_PROMPT_ID_V3, pictures: main.pictures, raw: main.raw, walls: wallsNote };
}

export interface VersionFPlan3 extends VersionFPlan {
    adjustNative: { ms: number; evaluations: number; batches: number; sentJobs: number; keptJobs: number };
    /** The coarse evidence (the adjustment's) per seen wall, kept for the Street View refinement. */
    coarse: WallEvidence[];
    inside: Map<number, Uint8Array>;
}

/** Round 3: read per wall at once, generate, check, adjust on the native kernel; the final solid. No textures. */
export async function planVersionF3(input: VersionFPlanInput & { roofClusters?: ProgramInput['roofClusters'] }): Promise<VersionFPlan3> {
    const T: Record<string, number> = {};
    const progress = input.onProgress ?? (() => undefined);
    const run0 = input.run0;
    fs.mkdirSync(input.outDir, { recursive: true });
    const groundY = Math.min(...input.massing.parts.map(p => p.baseY), ...input.massing.meshes.flatMap(m => m.vertices.map(v => v[1])));
    let t = Date.now();
    const tile = readTileTriangles(fs.readFileSync(input.tilePath));
    const iso = readTileTriangles(fs.readFileSync(input.isolateGlb));
    T.load = Date.now() - t;
    t = Date.now();
    progress('version F: reading each seen wall (all at once)');
    const reading = await readPerWall(input, run0, tile, groundY, input.outDir);
    T.read = Date.now() - t;
    const td0 = run0.report.topdown;
    let topdown: TopDown | undefined;
    if (td0) { const b = fs.readFileSync(path.join(run0.dir, td0.height)); topdown = { x0: td0.x0, z0: td0.z0, pixel: td0.pixel, width: td0.width, rows: td0.rows, height: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }; }
    const base: ProgramInput = { faces: run0.report.faces, parts: input.massing.parts, groundY, params: reading.params, neighbourTop: neighbourTopFn(tile, run0.report.faces, groundY), ...(topdown ? { topdown } : {}), ...(input.roofClusters?.length ? { roofClusters: input.roofClusters } : {}) };
    t = Date.now();
    const baseSoup = nodesToSoup(run0.nodes, n => n.kind !== 'residual');
    const evidence: WallEvidence[] = [], coarseEvidence: WallEvidence[] = [];
    const inside = new Map<number, Uint8Array>();
    for (const f of run0.report.faces) {
        if (f.kind !== 'wall' || !f.width || f.coverage < 0.5 || f.area < 30) continue;
        if (base.neighbourTop && base.neighbourTop(f, (f.sMin + f.sMax) / 2) > (f.tBottom + f.tMax) / 2) continue;
        const o = readFaceOrtho(run0.dir, f);
        if (!o) continue;
        const full = wallTileFromOrtho(f, o.rgba, o.depth);
        evidence.push(wallEvidence(full));
        const coarse = downsampleWallTile(full, Math.max(1, Math.round(ADJUST_PIXEL_M / f.pixel)));
        coarseEvidence.push(wallEvidence(coarse));
        const off = renderedWallOffset(baseSoup, coarse.face);
        inside.set(f.index, Uint8Array.from(off, v => (Number.isFinite(v) ? 1 : 0)));
    }
    T.evidence = Date.now() - t;
    t = Date.now();
    progress('version F: generating the building from the read parameters');
    const prog0 = facadeProgram(base);
    const runA = await build(input, prog0.parts, prog0, path.join(input.outDir, 'native_before'), { bake: 0, topdown: 0 });
    T.generate = Date.now() - t;
    t = Date.now();
    const isoSoup = iso.positions;
    const before = check(runA, isoSoup, evidence);
    T.check = Date.now() - t;
    t = Date.now();
    progress('version F: adjusting the parameters against the tile (native, every wall at once)');
    const compare = await NativeCompare.open(path.join(input.outDir, 'compare'), coarseEvidence, inside);
    let adj;
    try { adj = await adjustParametersNative(base, coarseEvidence, compare, input.rounds ?? 3, { shapes: true, onProgress: m => progress(`version F: ${m}`) }); } finally { compare.close(); }
    let params = adj.params;
    const silhouetteRound = await silhouetteParapet(input, base, params, adj.perWall, isoSoup);
    params = { ...params, parapet: { heightM: silhouetteRound.kept } };
    T.adjust = Date.now() - t;
    t = Date.now();
    progress('version F: the adjusted building');
    const prog = facadeProgram({ ...base, params, perWall: adj.perWall });
    const runB = await build(input, prog.parts, prog, path.join(input.outDir, 'native'), { topdown: 0 });
    T.generateFinal = Date.now() - t;
    t = Date.now();
    const after = check(runB, isoSoup, evidence);
    T.checkFinal = Date.now() - t;
    fs.rmSync(runA.dir, { recursive: true, force: true });
    const ctx = { pitchedParts: new Set(prog.pitchedParts), volumeParts: new Set(prog.volumeParts), partHeightSource: new Map(prog.parts.map(p => [p.id, String(p.heightSource)])), iou: input.massing.check.iou };
    return { reading, params, perWall: adj.perWall, prog, runB, before, after, rounds: adj.rounds, silhouetteRound, ctx, evidence, base, groundY, timingsMs: T, adjustNative: { ms: adj.ms, evaluations: adj.evaluations, batches: adj.batches, sentJobs: adj.sentJobs, keptJobs: adj.keptJobs }, coarse: coarseEvidence, inside };
}

/** The silhouette round: the parapet height against the obliques and the top view, with real builds (round 2's rule). */
async function silhouetteParapet(input: VersionFInput, base: ProgramInput, params: BuildingParameters, perWall: Map<number, WallLatticeAdjust>, isoSoup: Float32Array): Promise<NonNullable<VersionFResult['silhouetteRound']>> {
    const h = params.parapet.heightM;
    const tries = [...new Set([h, h + 0.5, Math.max(0, h - 0.5)].map(v => Math.round(v * 100) / 100))];
    const cams = comparisonCameras(soupBounds(isoSoup));
    // the three builds at once (independent)
    const tried = await Promise.all(tries.map(async v => {
        const pr = facadeProgram({ ...base, params: { ...params, parapet: { heightM: v } }, perWall });
        const rr = await build(input, pr.parts, pr, path.join(input.outDir, `native_parapet_${v}`), { bake: 0, topdown: 0 });
        const model = nodesToSoup(rr.nodes);
        const iou = cams.map(c => compareSilhouette(c.id, model, isoSoup, c.cam).iou).reduce((a, x) => a + x, 0) / cams.length;
        fs.rmSync(rr.dir, { recursive: true, force: true });
        return { parapetM: v, silhouetteIou: iou };
    }));
    const read0 = tried.find(x => x.parapetM === Math.round(h * 100) / 100)!;
    let best = read0;
    for (const x of tried) if (x.silhouetteIou > best.silhouetteIou + MIN_SILHOUETTE_GAIN) best = x;
    return { tried, kept: best.parapetM };
}

export interface StreetViewRefinement {
    walls: Array<{ face: number; panoId: string; bandCover: number; pxPerM: number; validShare: number; moved?: string; before?: number; after?: number }>;
    rebuilt: boolean;
    ms: number;
}

/**
 * Round 3, step 8: where a registered Street View photo covers a seen wall, its rectified crop replaces the tile photo as the
 * wall's luminance evidence (the depth stays the tile's) and that wall's lattice and storeys are searched again on it; the
 * solid is rebuilt when any wall moved. The plan is updated in place (perWall, prog, runB, after).
 */
export async function refineWithStreetView(input: VersionFInput, plan: VersionFPlan3, guide: GuideView[], isoSoup: Float32Array, onProgress?: (m: string) => void): Promise<StreetViewRefinement> {
    const t0 = Date.now();
    const out: StreetViewRefinement = { walls: [], rebuilt: false, ms: 0 };
    const evidence: WallEvidence[] = [];
    const inside = new Map<number, Uint8Array>();
    for (const ev of plan.coarse) {
        const f = plan.evidence.find(e => e.tile.face.index === ev.tile.face.index)?.tile.face;
        if (!f) continue;
        const best = bestStreetViewForWall(f, guide);
        if (!best.view || !best.rect) continue;
        // the full-resolution luma: the photo where it shows the wall, the tile elsewhere; then the adjustment's coarse pixel
        const n = f.width * f.height, luma = new Float32Array(n);
        let valid = 0;
        const fullEv = plan.evidence.find(e => e.tile.face.index === f.index)!;
        for (let i = 0; i < n; i++) {
            if (best.rect.valid[i]) { luma[i] = 0.2126 * best.rect.rgba[i * 4] + 0.7152 * best.rect.rgba[i * 4 + 1] + 0.0722 * best.rect.rgba[i * 4 + 2]; valid++; }
            else luma[i] = fullEv.tile.luma[i];
        }
        const coarse = downsampleWallTile({ face: f, luma, depth: fullEv.tile.depth }, Math.max(1, Math.round(ADJUST_PIXEL_M / f.pixel)));
        evidence.push(wallEvidence(coarse));
        inside.set(f.index, plan.inside.get(f.index)!);
        out.walls.push({ face: f.index, panoId: best.view.panoId, bandCover: Math.round(best.rect.bandCover * 1000) / 1000, pxPerM: Math.round(best.rect.pxPerM * 10) / 10, validShare: Math.round((valid / n) * 1000) / 1000 });
    }
    if (!evidence.length) { out.ms = Date.now() - t0; return out; }
    onProgress?.(`version F: ${evidence.length} walls' lattices searched again on their Street View crops`);
    const compare = await NativeCompare.open(path.join(input.outDir, 'compare_sv'), evidence, inside);
    let ref;
    try { ref = await refineWallsNative(plan.base, plan.params, plan.perWall, evidence, compare); } finally { compare.close(); }
    for (const m of ref.moved) { const w = out.walls.find(x => x.face === m.face); if (w) { w.moved = m.what; w.before = Math.round(m.before * 1000) / 1000; w.after = Math.round(m.after * 1000) / 1000; } }
    if (ref.moved.length) {
        plan.perWall = ref.perWall;
        plan.prog = facadeProgram({ ...plan.base, params: plan.params, perWall: plan.perWall });
        const old = plan.runB.dir;
        plan.runB = await build(input, plan.prog.parts, plan.prog, path.join(input.outDir, 'native_sv'), { topdown: 0 });
        plan.after = check(plan.runB, isoSoup, plan.evidence);
        plan.ctx = { ...plan.ctx, pitchedParts: new Set(plan.prog.pitchedParts), volumeParts: new Set(plan.prog.volumeParts), partHeightSource: new Map(plan.prog.parts.map(p => [p.id, String(p.heightSource)])) };
        fs.rmSync(old, { recursive: true, force: true });
        out.rebuilt = true;
    }
    out.ms = Date.now() - t0;
    return out;
}
