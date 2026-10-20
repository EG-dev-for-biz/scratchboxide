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
import { facadeParametersPrompt, parseFacadeParameters, FACADE_PARAMETERS_PROMPT_ID, type BuildingParameters, type ReadingPictureNote } from './facade-parameters';
import { facadeProgram, LABEL, SEEN_COVERAGE, type FacadeProgram, type ProgramInput, type TopDown } from './facade-program';
import { compareSilhouette, compareWall, comparisonCameras, downsampleWallTile, nodesToSoup, renderedWallOffset, soupBounds, summariseWalls, wallEvidence, wallTileFromOrtho, type SilhouetteCompare, type WallCompare, type WallEvidence } from './render-compare';
import { adjustParameters, type AdjustRound } from './adjust';

export const VERSION_F_ID = 'version-f/v1';
/** The adjustment's comparison pixel (m). */
export const ADJUST_PIXEL_M = 0.15;

/** The native tool's parameters for F: pipeline E's, with the scan residual (and its ground apron) off. */
export const VERSION_F_NATIVE_PARAMS: Record<string, number> = { ...MASSING_PARAMS, residual: 0, sections: 0 };

export interface StreetViewPhoto { bytes: Uint8Array; caption: string }

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

export interface VersionFResult {
    files: MassingLayerFiles;
    reading: { params: BuildingParameters; defaulted: string[]; model?: string; promptId: string; pictures: ReadingPictureNote[]; raw?: string };
    adjusted: BuildingParameters;
    perWall: Array<{ face: number; pitchScale: number; phaseM: number }>;
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
    return runMassing(text, dir);
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
async function read(input: VersionFInput, run0: MassingRun, tile: TileTriangles, groundY: number, dir: string): Promise<VersionFResult['reading']> {
    const pictures: ReadingPictureNote[] = [];
    const parts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
    const add = (png: Buffer | Uint8Array, mime: string, note: ReadingPictureNote, file: string) => {
        parts.push({ inlineData: { mimeType: mime, data: Buffer.from(png).toString('base64') } });
        pictures.push(note);
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
    (input.streetViewPhotos ?? []).slice(0, 2).forEach((p, k) => add(p.bytes, 'image/jpeg', { role: 'street view', caption: p.caption }, `read_streetview_${k}.jpg`));
    const prompt = facadeParametersPrompt(input.place, pictures);
    fs.writeFileSync(path.join(dir, 'read_prompt.txt'), prompt);
    if (input.reading) return { params: input.reading, defaulted: [], promptId: FACADE_PARAMETERS_PROMPT_ID, pictures };
    if (!input.chain) throw new Error('version F needs a vision model to read the parameters (none configured)');
    const r = await input.chain.generate({ contents: [{ role: 'user', parts: [...parts, { text: prompt }] }], config: { responseMimeType: 'application/json', temperature: 0 } }, { stage: 'grammar' });
    const text = r.response.candidates?.[0]?.content?.parts?.map(q => q.text ?? '').join('') ?? '';
    const parsed = parseFacadeParameters(text);
    r.remember();
    return { ...parsed, model: r.model, promptId: FACADE_PARAMETERS_PROMPT_ID, pictures, raw: text };
}

/** Render-compare of one built solid. */
function check(run: MassingRun, isoSoup: Float32Array, evidence: WallEvidence[]): CheckNumbers {
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

/** Runs version F for one building. */
export async function runVersionF(input: VersionFInput): Promise<VersionFResult> {
    const T: Record<string, number> = {};
    const progress = input.onProgress ?? (() => undefined);
    fs.mkdirSync(input.outDir, { recursive: true });
    const groundY = Math.min(...input.massing.parts.map(p => p.baseY), ...input.massing.meshes.flatMap(m => m.vertices.map(v => v[1])));
    let t = Date.now();
    progress('version F: the measured massing and the tile\'s orthographic cameras');
    const run0 = await build(input, input.massing.parts, {}, path.join(input.outDir, 'native0'), { topdown: 1 });
    T.massing = Date.now() - t;
    t = Date.now();
    const tile = readTileTriangles(fs.readFileSync(input.tilePath));
    const iso = readTileTriangles(fs.readFileSync(input.isolateGlb));
    T.load = Date.now() - t;
    t = Date.now();
    progress('version F: reading the facade system');
    const reading = await read(input, run0, tile, groundY, input.outDir);
    T.read = Date.now() - t;
    const td0 = run0.report.topdown;
    let topdown: TopDown | undefined;
    if (td0) { const b = fs.readFileSync(path.join(run0.dir, td0.height)); topdown = { x0: td0.x0, z0: td0.z0, pixel: td0.pixel, width: td0.width, rows: td0.rows, height: new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) }; }
    const base: ProgramInput = { faces: run0.report.faces, parts: input.massing.parts, groundY, params: reading.params, neighbourTop: neighbourTopFn(tile, run0.report.faces, groundY), ...(topdown ? { topdown } : {}) };
    // the seen walls' evidence and the plain wall masks
    t = Date.now();
    const baseSoup = nodesToSoup(run0.nodes);
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
    const adj = adjustParameters(base, coarseEvidence, inside, input.rounds ?? 3);
    let params = adj.params;
    // the silhouette round: the parapet height against the obliques and the top view, with real builds
    let silhouetteRound: VersionFResult['silhouetteRound'];
    {
        const h = params.parapet.heightM;
        const tries = [...new Set([h, h + 0.5, Math.max(0, h - 0.5)].map(v => Math.round(v * 100) / 100))];
        const tried: Array<{ parapetM: number; silhouetteIou: number }> = [];
        let best = h, bestIou = -1;
        for (const v of tries) {
            const pv = { ...params, parapet: { heightM: v } };
            const pr = facadeProgram({ ...base, params: pv, perWall: adj.perWall });
            const rr = await build(input, pr.parts, pr, path.join(input.outDir, `native_parapet_${v}`), { bake: 0, topdown: 0 });
            const model = nodesToSoup(rr.nodes);
            const cams = comparisonCameras(soupBounds(isoSoup));
            const iou = cams.map(c => compareSilhouette(c.id, model, isoSoup, c.cam).iou).reduce((a, x) => a + x, 0) / cams.length;
            tried.push({ parapetM: v, silhouetteIou: iou });
            if (iou > bestIou + 1e-4) { bestIou = iou; best = v; }
            fs.rmSync(rr.dir, { recursive: true, force: true });
        }
        params = { ...params, parapet: { heightM: best } };
        silhouetteRound = { tried, kept: best };
    }
    T.adjust = Date.now() - t;
    t = Date.now();
    progress('version F: the adjusted building, textured from the tile photo');
    const prog = facadeProgram({ ...base, params, perWall: adj.perWall });
    const runB = await build(input, prog.parts, prog, path.join(input.outDir, 'native'), { topdown: 0 });
    T.generateFinal = Date.now() - t;
    t = Date.now();
    const after = check(runB, isoSoup, evidence);
    T.checkFinal = Date.now() - t;
    t = Date.now();
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
    const ctx = { pitchedParts: new Set(prog.pitchedParts), volumeParts: new Set(prog.volumeParts), partHeightSource: new Map(prog.parts.map(p => [p.id, String(p.heightSource)])), iou: input.massing.check.iou };
    const files = writeMassingLayer(runB, input.massing, textures, legendF, input.outDir, 'remesh', VERSION_F_ID, 'version_f', n => versionFProvenance(n, ctx));
    T.texture = Date.now() - t;
    const byLabel: Record<string, number> = {};
    let vertices = 0, triangles = 0;
    for (const n of runB.nodes) { const l = versionFProvenance(n, ctx).label; byLabel[l] = (byLabel[l] ?? 0) + 1; vertices += n.positions.length / 3; triangles += n.indices.length / 3; }
    // the first run (the massing and its orthos: the walls' reference frames) is kept for inspection; the untextured trial goes
    fs.rmSync(runA.dir, { recursive: true, force: true });
    T.total = Object.values(T).reduce((a, x) => a + x, 0);
    return {
        files, reading, adjusted: params, perWall: [...adj.perWall].map(([face, a]) => ({ face, ...a })),
        program: { notes: prog.notes, walls: prog.walls, pitchedParts: prog.pitchedParts, volumeParts: prog.volumeParts, openings: prog.openings.length, sweeps: prog.sweeps.length, faceSweeps: prog.faceSweeps.length, rejectedOpenings: runB.report.rejectedOpenings.length, rejectedSweeps: runB.report.rejectedSweeps.length },
        before, after, rounds: adj.rounds, silhouetteRound,
        nodes: { total: runB.nodes.length, byLabel, residual: runB.nodes.filter(n => n.kind === 'residual').length, vertices, triangles },
        timingsMs: T
    };
}

