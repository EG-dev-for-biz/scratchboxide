/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Revolution fit, the Node half (the native half: scratchbox_revolution_fit.hpp, scripts/revolution_fit.cpp): the parts of
 * a scan that are solids of revolution about a vertical axis (found from the scan's horizontal sections being circles about
 * one centre, never from what the part is called), fitted with one smooth profile first and departures second (rings
 * where the sections step, stacked revolutions above the cap, K-periodic ribs or facets where the angular residual shows
 * them), and rebuilt clean natively.
 *
 * Here: running the tool, reading its report and meshes, taking the rebuilt parts' volume out of other layers'
 * triangles (`cutRevolutionsFromNodes`), and writing the rebuilt parts as a staged GLB with honest provenance: the surface
 * is an estimate (`generated`) whose axis and profile were fitted to the measured scan, with the fit's residual alongside.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileNativeCached, defaultNativeFlags, NativeBuildError } from '../native-build-cache';
import { findTileRefineRepoRoot } from '../tile-refine-service';
import { assembleGlb, nodeWorldMatrices, parseGlbBytes, readAccessor, transformPoint } from './glb-bytes';
import { encodePng } from './png-encode';
import { writeStagedGlbFile, type StagedGlbNode } from './staged-glb-writer';
import { buildTileSurface, readTileTriangles, selectTriangles, type TileTextureSurface } from './tile-texture-transfer';
import { renderTopDownPhoto, topDownJpeg } from './top-down-photo';

export const REVOLUTION_FIT_VERSION = 'revolution-fit/2';

const CLI_SOURCE = path.join('scripts', 'revolution_fit.cpp');
const INCLUDE_DIR = path.join('packages', 'core', 'src', 'native', '3d-engine', 'include');

/** The tool's parameters (scratchbox_revolution_fit.hpp Params); every one optional. */
export interface RevolutionFitParams {
    cellM?: number; peakWindowM?: number; minRiseM?: number; levelStepM?: number; maxRadiusM?: number; minRadiusM?: number; minStackM?: number;
    maxContourSpread?: number; centreDrift?: number; density?: number; sliceM?: number; minSectorShare?: number; maxSliceRmsRel?: number; minSlices?: number;
    ringStepM?: number; ringStepRel?: number; minBandM?: number; stackRiseM?: number; stackMinAreaM2?: number; maxStacks?: number;
    ribSignificance?: number; ribMinAmpM?: number; departureM?: number; departureMinAreaM2?: number; angularSegments?: number; sinkM?: number;
}

export interface RevolutionModulation {
    /** Period count of the kept modulation (0: none kept). */
    K: number; ampRel: number; ampM: number; significance: number; phaseAgreeDeg: number; floorRel: number;
    /** The strongest period count tested and its significance, kept or not. */
    bestK: number; bestSignificance: number;
    /**
     * The period's shape over phi = K (theta - theta0) in [-pi, pi): offset + cosAmp cos(phi) + bumpAmp g(phi - bumpCentre)
     * + facetAmp (P(phi) - mean P), g(x) = exp(-|x / (bumpWidth pi)|^bumpExponent), P the radius of a K-gon's flat facets
     * with corners at phi = 0. Only the family that fits the folded residual carries an amplitude.
     */
    shape: { theta0: number; offset: number; cosAmp: number; bumpAmp: number; bumpWidth: number; bumpExponent: number; bumpCentre: number; facetAmp: number; rmsRel: number; explained: number };
    /** (k, a, b): m(theta) = sum a cos(k theta) + b sin(k theta), relative to the radius. */
    harmonics: Array<[number, number, number]>;
}

export interface RevolutionStack {
    yBottom: number; yTop: number; points: number; rmsM: number; rmsTruncM: number;
    /** Bands only, no cap: a thin part (a mast) measured as straight sections. */
    bandsOnly: boolean;
    /** The cap is cut flat where a mast (the next stack) stands on it. */
    mastAbove: boolean;
    /** Height over radius of the topmost run of thin sections (0: none). */
    slenderness: number;
    bands: Array<{ y0: number; y1: number; r: number; slices: number }>;
    /** r(t) = R0 (1 - t^q)^(1/p) (1 + b 4 t (1 - t)), t = (y - y0) / H. */
    cap: { y0: number; R0: number; H: number; p: number; q: number; b: number; cut: number | null } | null;
    bandModulation: RevolutionModulation;
    capModulation: RevolutionModulation;
    /** The unmodulated meridian (r, y), bottom axis -> out -> up -> top axis. */
    meridian: Array<[number, number]>;
}

export interface RevolutionRecord {
    id: number;
    accepted: boolean;
    reason: string;
    plan: { x: number; z: number; r: number; peakY: number; baseY: number; levels: number; spread: number };
    axis: { x: number; z: number; errM: number; tiltDeg: number; slices: number; slicesOk: number; sliceRmsRelMedian: number; sectorShareMedian: number };
    fit: { points: number; rmsM: number; rmsTruncM: number; within25cm: number };
    stacks: RevolutionStack[];
    departures: Array<{ areaM2: number; meanM: number; thetaDeg: [number, number]; y: [number, number]; cells: number }>;
    /** (y, the largest radius of the rebuilt solid at y, modulation included). */
    envelope: Array<[number, number]>;
    /** Per slice: [y, cx, cz, r, rmsRel, sectorShare, points, counted]. */
    slices: Array<[number, number, number, number, number, number, number, number]>;
    mesh: { offset: number; vertices: number; indices: number };
}

export interface RevolutionFitReport {
    schema: 'scratchbox.revolution-fit/1';
    triangles: number;
    dsm: { cellM: number; nx: number; nz: number };
    summits: number;
    candidates: number;
    revolutions: RevolutionRecord[];
}

export interface RevolutionMesh { id: number; positions: Float32Array; normals: Float32Array; indices: Uint32Array }

export interface RevolutionFitRun { dir: string; report: RevolutionFitReport; meshes: RevolutionMesh[]; ms: number }

let building: Promise<string> | undefined;

/** Builds the tool through the native build cache (rebuilt when its source or a header changes; a failed build throws). */
export function ensureRevolutionBinary(repoRoot = findTileRefineRepoRoot()): Promise<string> {
    if (process.env.SCRATCHBOX_REVOLUTION_FIT_BIN) return Promise.resolve(process.env.SCRATCHBOX_REVOLUTION_FIT_BIN);
    building ??= (async () => {
        try {
            const built = await compileNativeCached({ sourcePath: path.join(repoRoot, CLI_SOURCE), includeDirs: [path.join(repoRoot, INCLUDE_DIR)], flags: defaultNativeFlags(), name: 'revolution_fit', timeoutMs: 300_000 });
            return built.binaryPath;
        } catch (err) {
            throw new Error(`could not build revolution_fit: ${err instanceof NativeBuildError ? err.compilerOutput.slice(-1500) : String(err)}`);
        }
    })().finally(() => { building = undefined; });
    return building;
}

/** The SBRV input: "SBRV" u32 1, u32 nTri, nTri * 9 f32. `indices` omitted: consecutive triples. */
export function encodeRevolutionInput(positions: Float32Array, indices?: Uint32Array): Buffer {
    const nt = indices ? indices.length / 3 : positions.length / 9;
    const buf = Buffer.alloc(12 + nt * 36);
    buf.write('SBRV', 0, 'ascii');
    buf.writeUInt32LE(1, 4);
    buf.writeUInt32LE(nt, 8);
    const f = new Float32Array(buf.buffer, buf.byteOffset + 12, nt * 9);
    for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) {
        const v = indices ? indices[t * 3 + k] : t * 3 + k;
        f[t * 9 + k * 3] = positions[v * 3]; f[t * 9 + k * 3 + 1] = positions[v * 3 + 1]; f[t * 9 + k * 3 + 2] = positions[v * 3 + 2];
    }
    return buf;
}

/** Runs the tool on a triangle mesh (tile frame) in `dir` (created); throws with the tool's own error. */
export async function runRevolutionFit(mesh: { positions: Float32Array; indices?: Uint32Array }, dir: string, params: RevolutionFitParams = {}, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RevolutionFitRun> {
    const binary = await ensureRevolutionBinary();
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, 'input.sbrv');
    fs.writeFileSync(input, encodeRevolutionInput(mesh.positions, mesh.indices));
    const args = [input, dir, ...Object.entries(params).filter(([, v]) => v !== undefined && Number.isFinite(v)).map(([k, v]) => `${k}=${v}`)];
    const t0 = Date.now();
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile(binary, args, { timeout: opts.timeoutMs ?? 300_000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, ...(opts.signal ? { signal: opts.signal } : {}) }, (err, out, errOut) => {
            if (err) {
                const tail = String(out || errOut || err.message).trim().split('\n').pop() ?? err.message;
                let msg = tail;
                try { msg = JSON.parse(tail).error ?? tail; } catch { /* not JSON */ }
                reject(new Error(`revolution_fit failed: ${msg}`));
            } else resolve(String(out));
        });
    });
    const head = JSON.parse(stdout.trim().split('\n').pop() ?? '{}');
    if (!head.ok) throw new Error(`revolution_fit failed: ${head.error ?? 'no answer'}`);
    fs.rmSync(input, { force: true });
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')) as RevolutionFitReport;
    const bin = fs.readFileSync(path.join(dir, 'mesh.bin'));
    const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
    const meshes: RevolutionMesh[] = report.revolutions.filter(r => r.accepted && r.mesh.vertices > 0).map(r => {
        const o = r.mesh.offset, nv = r.mesh.vertices;
        return {
            id: r.id,
            positions: new Float32Array(ab.slice(o, o + nv * 12)),
            normals: new Float32Array(ab.slice(o + nv * 12, o + nv * 24)),
            indices: new Uint32Array(ab.slice(o + nv * 24, o + nv * 24 + r.mesh.indices * 4))
        };
    });
    return { dir, report, meshes, ms: Date.now() - t0 };
}

/** Is (x, y, z) inside an accepted revolution's rebuilt solid grown by `marginM` (above its own base by `aboveBaseM`)? */
export function revolutionContains(r: RevolutionRecord, x: number, y: number, z: number, marginM = 0.6, aboveBaseM = 0.3): boolean {
    const env = r.envelope;
    if (!env.length) return false;
    const base = r.stacks.length ? r.stacks[0].yBottom : env[0][0];
    if (y < base + aboveBaseM || y > env[env.length - 1][0] + marginM) return false;
    const k = Math.min(env.length - 1, Math.max(0, Math.round((y - env[0][0]) / 0.1)));
    // the widest radius within the margin above and below (a horizontal step's edge)
    let rad = 0;
    const span = Math.ceil(marginM / 0.1);
    for (let j = Math.max(0, k - span); j <= Math.min(env.length - 1, k + span); j++) rad = Math.max(rad, env[j][1]);
    return Math.hypot(x - r.axis.x, z - r.axis.z) <= rad + marginM;
}

/**
 * Takes the triangles of `nodes` whose centroid lies inside a rebuilt revolution (grown by `marginM`) out of them: the
 * scan's dented copy and any massing block standing where the rebuilt solid now stands. Returns the triangles removed.
 * Nodes are { positions, indices } with per-vertex arrays of any width beside them, handled by `compact`.
 */
export function revolutionCutMask(revs: RevolutionRecord[], positions: Float32Array, indices: Uint32Array, marginM = 0.6): Uint8Array {
    const keep = new Uint8Array(indices.length / 3).fill(1);
    const acc = revs.filter(r => r.accepted);
    if (!acc.length) return keep;
    for (let t = 0; t < indices.length / 3; t++) {
        const a = indices[t * 3] * 3, b = indices[t * 3 + 1] * 3, c = indices[t * 3 + 2] * 3;
        const x = (positions[a] + positions[b] + positions[c]) / 3, y = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3, z = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
        for (const r of acc) if (revolutionContains(r, x, y, z, marginM)) { keep[t] = 0; break; }
    }
    return keep;
}

/** A layer's provenance confidence for a revolution: high when the scan sits close to the clean surface. */
export function revolutionConfidence(r: RevolutionRecord): number {
    const c = r.fit.within25cm * Math.min(1, r.axis.sectorShareMedian) * Math.max(0, 1 - r.axis.errM / Math.max(0.5, r.plan.r));
    return Math.round(Math.max(0, Math.min(1, c)) * 1000) / 1000;
}

/** The period's fitted shape in words (from its continuous numbers). */
export function modulationShapeText(m: RevolutionModulation): string {
    const sh = m.shape;
    if (sh.facetAmp) return 'flat facets with sharp corners';
    if (sh.cosAmp) return 'a sinusoidal swing';
    if (sh.bumpAmp) return `${sh.bumpAmp > 0 === (sh.bumpCentre === 0) ? 'raised ribs' : 'grooves'} ${(sh.bumpWidth * 50).toFixed(0)}% of the period wide, edge exponent ${sh.bumpExponent}`;
    return 'none';
}

/** One line of what was fitted, for provenance notes and run notes. */
export function describeRevolution(r: RevolutionRecord): string {
    const s0 = r.stacks[0];
    const parts: string[] = [];
    const cap = s0?.cap;
    if (cap) parts.push(`cap R0 ${cap.R0.toFixed(2)} m, H ${cap.H.toFixed(2)} m, p ${cap.p.toFixed(2)}, q ${cap.q.toFixed(2)}, bulge ${cap.b.toFixed(2)}`);
    if (s0?.bands.length) parts.push(`${s0.bands.length} band${s0.bands.length === 1 ? '' : 's'} below it`);
    if (r.stacks.length > 1) parts.push(`${r.stacks.length - 1} stacked revolution${r.stacks.length > 2 ? 's' : ''} above`);
    const mods = r.stacks.flatMap(s => [s.bandModulation, s.capModulation]).filter(m => m.K > 0);
    if (mods.length) parts.push(`periodic modulation ${mods.map(m => `K ${m.K}, ${(m.ampM * 100).toFixed(0)} cm, ${modulationShapeText(m)}`).join('; ')}`);
    const masts = r.stacks.filter(s => s.bandsOnly);
    if (masts.length) parts.push(masts.map(s => `a mast to ${s.yTop.toFixed(1)} m at r ${(s.bands.reduce((a, b) => a + (b.r0 + b.r1) / 2, 0) / Math.max(1, s.bands.length)).toFixed(2)} m (slenderness ${s.slenderness.toFixed(0)}), no cap on it`).join('; '));
    return `axis at (${r.axis.x.toFixed(2)}, ${r.axis.z.toFixed(2)}) +- ${r.axis.errM.toFixed(2)} m; ${parts.join('; ')}; scan RMS ${r.fit.rmsM.toFixed(2)} m (truncated at 0.5 m: ${r.fit.rmsTruncM.toFixed(2)} m), ${Math.round(r.fit.within25cm * 100)}% within 25 cm; ${r.departures.length} local departure${r.departures.length === 1 ? '' : 's'} reported, not rebuilt`;
}

/** The node extras of a rebuilt revolution (staged provenance: an estimate fitted to the measured scan). */
export function revolutionNodeExtras(r: RevolutionRecord): Record<string, unknown> {
    return {
        provenance: 'generated',
        confidence: revolutionConfidence(r),
        method: `${REVOLUTION_FIT_VERSION}: a solid of revolution whose vertical axis and smooth profile were fitted to the measured scan's horizontal sections, with rings, stacked revolutions and periodic ribs only where the scan's residual shows them; the scan's dents are not kept`,
        reason: 'the scan of this part is a dented, faceted copy of a surface its own sections show to be uniform about one axis',
        fit: { axis: r.axis, rmsM: r.fit.rmsM, rmsTruncM: r.fit.rmsTruncM, within25cm: r.fit.within25cm, points: r.fit.points },
        profile: r.stacks.map(s => ({ bands: s.bands, cap: s.cap, bandModulation: { K: s.bandModulation.K, ampM: s.bandModulation.ampM }, capModulation: { K: s.capModulation.K, ampM: s.capModulation.ampM } })),
        departures: r.departures,
        summary: describeRevolution(r)
    };
}

/**
 * The colour of each rebuilt revolution, uniform about its axis as its shape is: per height, the median of the de-lit
 * tile photo sampled around the rebuilt surface (72 directions, the nearest scan surface within `reachM` facing the same
 * way). A height no sample reached takes its nearest sampled height's colour. One 4-texel-wide column per revolution, side
 * by side in one atlas; a vertex reads its column at its own height.
 */
export function revolutionColourAtlas(run: Pick<RevolutionFitRun, 'report' | 'meshes'>, surface: Pick<TileTextureSurface, 'sample'>, opts: { rows?: number; reachM?: number; smoothRows?: number } = {}): { width: number; height: number; rgb: Uint8Array; uv: Map<number, Float32Array>; sampledShare: number } {
    const rows = opts.rows ?? 256, reach = opts.reachM ?? 1.5, colW = 4;
    const byId = new Map(run.report.revolutions.map(r => [r.id, r]));
    const width = colW * Math.max(1, run.meshes.length), height = rows;
    const rgb = new Uint8Array(width * height * 3);
    const uv = new Map<number, Float32Array>();
    let sampled = 0, total = 0;
    run.meshes.forEach((m, col) => {
        const r = byId.get(m.id)!;
        let y0 = Infinity, y1 = -Infinity;
        for (let v = 1; v < m.positions.length; v += 3) { y0 = Math.min(y0, m.positions[v]); y1 = Math.max(y1, m.positions[v]); }
        const span = Math.max(1e-6, y1 - y0);
        const rowColour: Array<[number, number, number] | undefined> = [];
        for (let k = 0; k < rows; k++) {
            const y = y1 - ((k + 0.5) / rows) * span;
            // the widest stack at this height, and the slope of its meridian there for the normal
            let rad = 0, dr = 0;
            for (const s of r.stacks) {
                const at = (yy: number) => meridianRadius(s, yy);
                const rr = at(y);
                if (rr > rad) { rad = rr; dr = (at(y + 0.05) - at(y - 0.05)) / 0.1; }
            }
            total++;
            if (rad < 0.05) { rowColour.push(undefined); continue; }
            const cs: number[][] = [[], [], []];
            for (let a = 0; a < 72; a++) {
                const th = -Math.PI + (2 * Math.PI * (a + 0.5)) / 72;
                const p: [number, number, number] = [r.axis.x + rad * Math.cos(th), y, r.axis.z + rad * Math.sin(th)];
                const nl = Math.hypot(1, dr);
                const n: [number, number, number] = [Math.cos(th) / nl, -dr / nl, Math.sin(th) / nl];
                const smp = surface.sample(p, n, reach);
                if (!smp) continue;
                for (let c = 0; c < 3; c++) cs[c].push(smp.rgb[c]);
            }
            if (cs[0].length < 6) { rowColour.push(undefined); continue; }
            sampled++;
            rowColour.push(cs.map(v => { v.sort((p, q) => p - q); return v[v.length >> 1]; }) as [number, number, number]);
        }
        // fill unsampled heights from the nearest sampled one, then a running median over `smoothRows` rows (a row is 72
        // samples of a photo whose texels are coarser than a row: row-to-row flicker is the photo's noise, not the surface)
        const filled: Array<[number, number, number]> = [];
        for (let k = 0; k < rows; k++) {
            let c = rowColour[k];
            for (let d = 1; !c && d < rows; d++) c = rowColour[k - d] ?? rowColour[k + d];
            filled.push(c ?? [150, 150, 150]);
        }
        const half = Math.max(0, Math.floor((opts.smoothRows ?? 9) / 2));
        for (let k = 0; k < rows; k++) {
            const win = filled.slice(Math.max(0, k - half), Math.min(rows, k + half + 1));
            const px = [0, 1, 2].map(c => { const v = win.map(w => w[c]).sort((p, q) => p - q); return v[v.length >> 1]; });
            for (let i = 0; i < colW; i++) { const o = (k * width + col * colW + i) * 3; rgb[o] = px[0]; rgb[o + 1] = px[1]; rgb[o + 2] = px[2]; }
        }
        const u = (col * colW + colW / 2) / width;
        const t = new Float32Array((m.positions.length / 3) * 2);
        for (let v = 0; v < m.positions.length / 3; v++) { t[v * 2] = u; t[v * 2 + 1] = Math.min(1 - 0.5 / rows, Math.max(0.5 / rows, (y1 - m.positions[v * 3 + 1]) / span)); }
        uv.set(m.id, t);
    });
    return { width, height, rgb, uv, sampledShare: total ? sampled / total : 0 };
}

/** A stack's unmodulated radius at height y, from its meridian polyline (the outermost crossing). */
function meridianRadius(s: RevolutionStack, y: number): number {
    const m = s.meridian;
    let best = 0;
    for (let i = 0; i + 1 < m.length; i++) {
        const [r0, y0] = m[i], [r1, y1] = m[i + 1];
        if ((y < Math.min(y0, y1)) || (y > Math.max(y0, y1))) continue;
        const r = Math.abs(y1 - y0) < 1e-9 ? Math.max(r0, r1) : r0 + ((y - y0) / (y1 - y0)) * (r1 - r0);
        best = Math.max(best, r);
    }
    return best;
}

/** Writes the accepted revolutions as one staged GLB (one node each), coloured from `atlas` when given. */
export function writeRevolutionsGlb(file: string, run: Pick<RevolutionFitRun, 'report' | 'meshes'>, atlas?: ReturnType<typeof revolutionColourAtlas>): { path: string; bytes: number; nodes: number } {
    const byId = new Map(run.report.revolutions.map(r => [r.id, r]));
    const nodes: StagedGlbNode[] = run.meshes.map(m => ({
        name: `revolution_${m.id}`, positions: m.positions, normals: m.normals, indices: m.indices,
        ...(atlas?.uv.get(m.id) ? { uv: atlas.uv.get(m.id)! } : {}),
        extras: { ...revolutionNodeExtras(byId.get(m.id)!), ...(atlas ? { colour: 'per height, the median of the de-lit tile photo sampled around the rebuilt surface (photo-inferred, uniform about the axis as the shape is)' } : {}) }
    }));
    const out = writeStagedGlbFile(file, nodes, {
        rootExtras: { sbRevolutionFit: { version: REVOLUTION_FIT_VERSION, accepted: nodes.length, candidates: run.report.candidates } },
        generator: 'scratchbox staged-location revolution-fit',
        ...(atlas ? { texture: { bytes: encodePng(atlas.width, atlas.height, atlas.rgb, 3), mimeType: 'image/png' as const }, textureMaterial: { roughness: 0.7 } } : {})
    });
    return { ...out, nodes: nodes.length };
}

/**
 * Takes the triangles whose centroid lies inside an accepted revolution's rebuilt solid (grown by `marginM`) out of every
 * mesh of a GLB (node transforms applied): the scan's dented copy of the part and any massing block standing there.
 */
export function cutRevolutionsFromGlb(bytes: Uint8Array, revs: RevolutionRecord[], marginM = 0.6): { glb: Buffer; removedTriangles: number } {
    const acc = revs.filter(r => r.accepted);
    if (!acc.length) return { glb: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), removedTriangles: 0 };
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const world = nodeWorldMatrices(json);
    const extra: Uint8Array[] = [];
    let binLength = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    let removed = 0;
    const done = new Set<number>();
    (json.nodes ?? []).forEach((node: any, ni: number) => {
        if (node.mesh === undefined || done.has(node.mesh)) return;
        done.add(node.mesh);
        for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const pos = readAccessor(glb, prim.attributes.POSITION).data;
            const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : undefined;
            const count = idx ? idx.length : pos.length / 3;
            const keep: number[] = [];
            let cut = 0;
            for (let t = 0; t + 2 < count; t += 3) {
                const v = [idx ? idx[t] : t, idx ? idx[t + 1] : t + 1, idx ? idx[t + 2] : t + 2];
                const w = transformPoint(world[ni], (pos[v[0] * 3] + pos[v[1] * 3] + pos[v[2] * 3]) / 3, (pos[v[0] * 3 + 1] + pos[v[1] * 3 + 1] + pos[v[2] * 3 + 1]) / 3, (pos[v[0] * 3 + 2] + pos[v[1] * 3 + 2] + pos[v[2] * 3 + 2]) / 3);
                if (acc.some(r => revolutionContains(r, w[0], w[1], w[2], marginM))) { cut++; continue; }
                keep.push(v[0], v[1], v[2]);
            }
            if (!cut) continue;
            removed += cut;
            const data = new Uint8Array(new Uint32Array(keep).buffer);
            json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: data.byteLength, target: 34963 });
            json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5125, count: keep.length, type: 'SCALAR' });
            prim.indices = json.accessors.length - 1;
            extra.push(data);
            binLength += data.byteLength;
        }
    });
    if (!removed) return { glb: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), removedTriangles: 0 };
    const bin = new Uint8Array(binLength);
    bin.set(glb.bin, 0);
    let o = glb.bin.byteLength + ((4 - (glb.bin.byteLength % 4)) % 4);
    for (const e of extra) { bin.set(e, o); o += e.byteLength; }
    if (json.buffers?.[0]) json.buffers[0].byteLength = binLength;
    return { glb: assembleGlb(json, bin), removedTriangles: removed };
}

/** The revolution fit in a staged district runs unless SCRATCHBOX_STAGED_REVOLUTION_FIT=0. */
export function revolutionFitEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env.SCRATCHBOX_STAGED_REVOLUTION_FIT !== '0';
}

export interface RevolutionLayerSummary {
    version: string;
    candidates: number;
    accepted: number;
    /** Why each candidate that was not rebuilt was not (counted by reason). */
    rejected: Record<string, number>;
    revolutions: Array<{ id: number; axis: RevolutionRecord['axis']; fit: RevolutionRecord['fit']; confidence: number; stacks: number; modulationK: number[]; departures: number; summary: string }>;
    colourSampledShare: number;
    ms: number;
}

/**
 * Planes first (user, 2026-10-22: square Gothic towers rebuilt as cylinders with cone hats were absurd): a part the fit
 * accepted is kept only when its scan sections are not clearly a few-sided polygon. Each horizontal section gives an outline: the outer surface's distance from the axis in angular bins (the 90th
 * percentile of the points in each bin), every section from its base to its top. A circle (the bins' mean) and the best regular polygon with POLYGON_SIDES sides at
 * any rotation are fitted; a section is polygonal when the polygon leaves under `maxRatio` of the circle's residual and
 * the outline swings by more than `minSwing` of its radius. A part most of whose tested sections are polygonal is
 * returned with why; the plane-first massing stands there instead.
 */
export const POLYGON_SIDES = [4, 5, 6];
export const PLANES_FIRST_VETO = { bins: 72, minBinShare: 0.5, maxRatio: 0.7, minSwing: 0.03, polygonalShare: 0.5, sliceM: 1, minSections: 3, sampleM: 0.15 };

/** `positions`: the scan as triangle soup (nine floats a triangle). */
export function polygonalSections(r: Pick<RevolutionRecord, 'axis' | 'stacks' | 'envelope'>, positions: Float32Array, P = PLANES_FIRST_VETO): { tested: number; polygonal: number; sides: number | null; reason?: string } {
    if (!r.stacks.length) return { tested: 0, polygonal: 0, sides: null };
    // every section from the part's base to its top (a tower fitted as one tapering cap has no straight band to test)
    const y0 = Math.min(...r.stacks.map(s => s.yBottom)), y1 = Math.max(...r.stacks.map(s => s.yTop));
    const rMax = Math.max(1, ...r.envelope.filter(([y]) => y >= y0 && y <= y1).map(([, rr]) => rr)) * 1.4;
    const n = Math.max(1, Math.floor((y1 - y0) / P.sliceM));
    const sections: number[][][] = Array.from({ length: n }, () => Array.from({ length: P.bins }, () => []));
    const add = (x: number, y: number, z: number) => {
        if (y < y0 || y >= y1) return;
        const dx = x - r.axis.x, dz = z - r.axis.z, d = Math.hypot(dx, dz);
        if (d > rMax) return;
        const k = Math.min(n - 1, Math.floor((y - y0) / P.sliceM));
        const b = Math.min(P.bins - 1, Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * P.bins));
        sections[k][b].push(d);
    };
    // a scan's vertices are too sparse for an outline per section: points are sampled over its triangles (triangle soup,
    // nine floats each) at about `sampleM` apart
    for (let t = 0; t + 8 < positions.length; t += 9) {
        const ax = positions[t], ay = positions[t + 1], az = positions[t + 2], bx = positions[t + 3], by = positions[t + 4], bz = positions[t + 5], cx = positions[t + 6], cy = positions[t + 7], cz = positions[t + 8];
        if (Math.max(ay, by, cy) < y0 || Math.min(ay, by, cy) >= y1) continue;
        if (Math.min(Math.hypot(ax - r.axis.x, az - r.axis.z), Math.hypot(bx - r.axis.x, bz - r.axis.z), Math.hypot(cx - r.axis.x, cz - r.axis.z)) > rMax) continue;
        const steps = Math.min(40, Math.max(1, Math.ceil(Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - ax, cy - ay, cz - az)) / P.sampleM)));
        for (let i = 0; i <= steps; i++) for (let j = 0; i + j <= steps; j++) {
            const u = i / steps, w = j / steps;
            add(ax + (bx - ax) * u + (cx - ax) * w, ay + (by - ay) * u + (cy - ay) * w, az + (bz - az) * u + (cz - az) * w);
        }
    }
    let tested = 0, polygonal = 0;
    const sideVotes = new Map<number, number>();
    for (const sec of sections) {
        const prof: Array<[number, number]> = [];
        sec.forEach((ds, b) => { if (ds.length >= 3) { ds.sort((a, c) => a - c); prof.push([((b + 0.5) / P.bins) * 2 * Math.PI - Math.PI, ds[Math.floor(ds.length * 0.9)]]); } });
        if (prof.length < P.bins * P.minBinShare) continue;
        tested++;
        const mean = prof.reduce((a, [, d]) => a + d, 0) / prof.length;
        const circle = Math.sqrt(prof.reduce((a, [, d]) => a + (d - mean) ** 2, 0) / prof.length);
        if (circle / mean < P.minSwing) continue;
        let best = Infinity, bestSides = 0;
        for (const ns of POLYGON_SIDES) {
            const alpha = (2 * Math.PI) / ns;
            for (let phi = 0; phi < alpha; phi += Math.PI / 90) {
                const shape = prof.map(([t]) => { const u = ((((t - phi) % alpha) + alpha) % alpha) - alpha / 2; return Math.cos(Math.PI / ns) / Math.cos(u); });
                let num = 0, den = 0;
                prof.forEach(([, d], i) => { num += d * shape[i]; den += shape[i] * shape[i]; });
                const a = num / den;
                const rms = Math.sqrt(prof.reduce((acc, [, d], i) => acc + (d - a * shape[i]) ** 2, 0) / prof.length);
                if (rms < best) { best = rms; bestSides = ns; }
            }
        }
        if (best < P.maxRatio * circle) { polygonal++; sideVotes.set(bestSides, (sideVotes.get(bestSides) ?? 0) + 1); }
    }
    const sides = [...sideVotes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const veto = tested >= P.minSections && polygonal >= tested * P.polygonalShare;
    return { tested, polygonal, sides, ...(veto ? { reason: `planes first: ${polygonal} of ${tested} sections of its body are a ${sides}-sided polygon rather than a circle (the polygon leaves under ${Math.round(P.maxRatio * 100)}% of the circle's residual), so it stays plane-first massing` } : {}) };
}

/**
 * Planes first from the vector data: where a Google vector part of comparable size (its area within OUTLINE_VETO.areaRange
 * of the fitted plan circle's) stands under a fitted part's axis and is a few-sided polygon (at most `maxSides` corners
 * after merging near-collinear ones, or an isoperimetric quotient under `minRoundness`), the part is that polygon, not a
 * revolution: a photogrammetric scan melts a square tower's corners round (St Paul's Cathedral, Melbourne, 2026-10-22: two
 * of its 23 sections read as square, the vector parts are squares), while a round building's outline comes as many sides.
 */
export const OUTLINE_VETO = { areaRange: [0.35, 2.8] as [number, number], maxSides: 8, minRoundness: 0.86, collinearDeg: 12 };

export function vectorOutlineVeto(r: Pick<RevolutionRecord, 'axis' | 'plan'>, outlines: Array<Array<[number, number]>>, P = OUTLINE_VETO): string | undefined {
    const circle = Math.PI * r.plan.r * r.plan.r;
    for (const loop of outlines) {
        if (loop.length < 3) continue;
        let inside = false, area = 0, perim = 0;
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            const [xi, zi] = loop[i], [xj, zj] = loop[j];
            if ((zi > r.axis.z) !== (zj > r.axis.z) && r.axis.x < ((xj - xi) * (r.axis.z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
            area += xj * zi - xi * zj; perim += Math.hypot(xi - xj, zi - zj);
        }
        area = Math.abs(area) / 2;
        if (!inside || area < P.areaRange[0] * circle || area > P.areaRange[1] * circle) continue;
        // corners: vertices where the outline turns by more than collinearDeg
        let corners = 0;
        for (let i = 0; i < loop.length; i++) {
            const a = loop[(i + loop.length - 1) % loop.length], b = loop[i], c = loop[(i + 1) % loop.length];
            const t1 = Math.atan2(b[1] - a[1], b[0] - a[0]), t2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
            let turn = Math.abs(t2 - t1) * 180 / Math.PI; if (turn > 180) turn = 360 - turn;
            if (turn > P.collinearDeg) corners++;
        }
        const roundness = (4 * Math.PI * area) / (perim * perim);
        if (corners <= P.maxSides || roundness < P.minRoundness) return `planes first: the vector footprint under it is a ${corners}-cornered outline (roundness ${roundness.toFixed(2)}, ${Math.round(area)} m² against the fitted circle's ${Math.round(circle)} m²), so it stays plane-first massing`;
    }
    return undefined;
}

/**
 * The plan-view check, when the scan and the vector data cannot tell (a photogrammetric scan melts a square tower round;
 * a tower inside a larger building has no vector part of its own): the vision model is shown the tile photo straight down
 * around the part and says whether the structure at the centre is circular in plan or a polygon, and how many sides.
 * A polygon of at most 6 sides vetoes the revolution (planes first); an octagon is a faceted revolution (the fit's 8-fold
 * modulation: on Flinders Street the dome, a cupola and a skylight all read octagonal, St Paul's tower square), and
 * anything else, or no answer, keeps it.
 */
export function revolutionPlanPrompt(radiusM: number, spanM: number): string {
    return `This is a photograph taken straight down from above, ${Math.round(spanM)} m across, centred on a tall structure about `
        + `${Math.round(radiusM * 2)} m wide (a tower, spire, dome, drum or turret). Look only at the structure at the centre. Is its outline in plan `
        + 'a circle (round, or so many sides it reads round) or a polygon with straight sides and corners (a square, rectangular, hexagonal '
        + 'or octagonal tower or spire)? Reply with JSON only: {"plan": "circle" | "polygon", "sides": number of sides if a polygon, '
        + '"confidence": 0..1, "what": "a few words on what you see"}.';
}

export function parseRevolutionPlan(text: string): { plan: 'circle' | 'polygon'; sides?: number; confidence: number; what: string } | undefined {
    try {
        const j = JSON.parse(text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
        if (j?.plan !== 'circle' && j?.plan !== 'polygon') return undefined;
        const sides = typeof j.sides === 'number' && Number.isFinite(j.sides) ? Math.round(j.sides) : undefined;
        const confidence = typeof j.confidence === 'number' ? Math.max(0, Math.min(1, j.confidence)) : 0.5;
        return { plan: j.plan, ...(sides !== undefined ? { sides } : {}), confidence, what: typeof j.what === 'string' ? j.what : '' };
    } catch { return undefined; }
}

/** Why a plan-view reply vetoes the revolution, or undefined when it keeps it. */
export function planVetoReason(reply: ReturnType<typeof parseRevolutionPlan>): string | undefined {
    if (!reply || reply.plan !== 'polygon' || reply.confidence < 0.5) return undefined;
    const sides = reply.sides ?? 4;
    if (sides > 6) return undefined;
    return `planes first: seen straight down on the tile photo it is a ${sides}-sided polygon (${reply.what}; vision confidence ${reply.confidence}), so it stays plane-first massing`;
}

/** A vision call: an image and a prompt in, the reply's text out. */
export type PlanJudge = (image: { bytes: Uint8Array; mimeType: string }, prompt: string) => Promise<string>;

/**
 * The district's revolution parts rebuilt: the fit on the (tree-stripped, photo-textured) scan, the rebuilt parts
 * coloured from the same scan's photo and written to `<outDir>/revolutions.glb`. Returns the run (for cutting the parts
 * out of other layers) and a summary, or the summary alone when nothing was accepted.
 */
export async function buildRevolutionLayer(input: { scanGlb: string; outDir: string; within?: (x: number, z: number) => boolean; params?: RevolutionFitParams; signal?: AbortSignal; /** Vector footprint outlines (x, z): a few-sided one under a part vetoes it (vectorOutlineVeto). */ outlines?: Array<Array<[number, number]>>; /** The plan-view check (revolutionPlanPrompt). */ judgePlan?: PlanJudge }): Promise<{ summary: RevolutionLayerSummary; run: RevolutionFitRun; file?: string }> {
    const t0 = Date.now();
    const bytes = fs.readFileSync(input.scanGlb);
    let tris = readTileTriangles(bytes);
    if (input.within) {
        const keep = new Uint8Array(tris.texture.length);
        for (let t = 0; t < keep.length; t++) keep[t] = input.within((tris.positions[t * 9] + tris.positions[t * 9 + 3] + tris.positions[t * 9 + 6]) / 3, (tris.positions[t * 9 + 2] + tris.positions[t * 9 + 5] + tris.positions[t * 9 + 8]) / 3) ? 1 : 0;
        tris = selectTriangles(tris, keep);
    }
    const run = await runRevolutionFit({ positions: tris.positions }, path.join(input.outDir, 'revolution_fit'), input.params ?? {}, input.signal ? { signal: input.signal } : {});
    // planes first: a part whose sections are clearly a few-sided polygon is not a revolution
    for (const r of run.report.revolutions.filter(x => x.accepted)) {
        let why = (input.outlines ? vectorOutlineVeto(r, input.outlines) : undefined) ?? polygonalSections(r, tris.positions).reason;
        if (!why && input.judgePlan) {
            // straight down on the tile photo, three radii each way
            const span = Math.max(12, r.plan.r * 6);
            try {
                const photo = renderTopDownPhoto(tris, { x0: r.axis.x - span / 2, z0: r.axis.z - span / 2, widthM: span, heightM: span }, { texelM: Math.max(0.05, span / 768), maxPx: 1024 });
                why = planVetoReason(parseRevolutionPlan(await input.judgePlan({ bytes: topDownJpeg(photo), mimeType: 'image/jpeg' }, revolutionPlanPrompt(r.plan.r, span))));
            } catch (err) {
                if (input.signal?.aborted) throw err;
                // no answer: the part keeps its fit (the scan and vector checks passed)
            }
        }
        if (why) { r.accepted = false; r.reason = why; }
    }
    run.meshes = run.meshes.filter(m => run.report.revolutions.some(r => r.id === m.id && r.accepted));
    const acc = run.report.revolutions.filter(r => r.accepted);
    const rejected: Record<string, number> = {};
    for (const r of run.report.revolutions.filter(x => !x.accepted)) { const k = r.reason.replace(/[\d.]+/g, 'N'); rejected[k] = (rejected[k] ?? 0) + 1; }
    const summary: RevolutionLayerSummary = {
        version: REVOLUTION_FIT_VERSION, candidates: run.report.candidates, accepted: acc.length, rejected,
        revolutions: acc.map(r => ({ id: r.id, axis: r.axis, fit: r.fit, confidence: revolutionConfidence(r), stacks: r.stacks.length, modulationK: r.stacks.flatMap(s => [s.bandModulation.K, s.capModulation.K]).filter(k => k > 0), departures: r.departures.length, summary: describeRevolution(r) })),
        colourSampledShare: 0, ms: 0
    };
    if (!acc.length) { summary.ms = Date.now() - t0; return { summary, run }; }
    const atlas = revolutionColourAtlas(run, buildTileSurface(tris));
    summary.colourSampledShare = Math.round(atlas.sampledShare * 1000) / 1000;
    const file = path.join(input.outDir, 'revolutions.glb');
    writeRevolutionsGlb(file, run, atlas);
    summary.ms = Date.now() - t0;
    return { summary, run, file };
}

/**
 * The district hook: the revolution parts of `scanGlb` rebuilt into `<dir>/revolutions.glb`, and their volume cut out of
 * each of `cutFiles` (in place: the scan's dented copy and any massing block standing where a rebuilt part now stands).
 * Returns the summary with the triangles cut per file.
 */
export async function reviseForRevolutions(input: { dir: string; scanGlb: string; within?: (x: number, z: number) => boolean; cutFiles: string[]; signal?: AbortSignal; outlines?: Array<Array<[number, number]>>; judgePlan?: PlanJudge }): Promise<RevolutionLayerSummary & { cut: Record<string, number> }> {
    const { summary, run, file } = await buildRevolutionLayer({ scanGlb: input.scanGlb, outDir: input.dir, ...(input.within ? { within: input.within } : {}), ...(input.signal ? { signal: input.signal } : {}), ...(input.outlines ? { outlines: input.outlines } : {}), ...(input.judgePlan ? { judgePlan: input.judgePlan } : {}) });
    const cut: Record<string, number> = {};
    if (file) for (const f of input.cutFiles) {
        if (!fs.existsSync(f)) continue;
        const r = cutRevolutionsFromGlb(fs.readFileSync(f), run.report.revolutions);
        if (r.removedTriangles) fs.writeFileSync(f, r.glb);
        cut[path.basename(f)] = r.removedTriangles;
    }
    return { ...summary, cut };
}
