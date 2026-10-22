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

export const REVOLUTION_FIT_VERSION = 'revolution-fit/1';

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
    /** (k, a, b): m(theta) = sum a cos(k theta) + b sin(k theta), relative to the radius. */
    harmonics: Array<[number, number, number]>;
}

export interface RevolutionStack {
    yBottom: number; yTop: number; points: number; rmsM: number; rmsTruncM: number;
    bands: Array<{ y0: number; y1: number; r: number; slices: number }>;
    /** r(t) = R0 (1 - t^q)^(1/p) (1 + b 4 t (1 - t)), t = (y - y0) / H. */
    cap: { y0: number; R0: number; H: number; p: number; q: number; b: number } | null;
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

/** One line of what was fitted, for provenance notes and run notes. */
export function describeRevolution(r: RevolutionRecord): string {
    const s0 = r.stacks[0];
    const parts: string[] = [];
    const cap = s0?.cap;
    if (cap) parts.push(`cap R0 ${cap.R0.toFixed(2)} m, H ${cap.H.toFixed(2)} m, p ${cap.p.toFixed(2)}, q ${cap.q.toFixed(2)}, bulge ${cap.b.toFixed(2)}`);
    if (s0?.bands.length) parts.push(`${s0.bands.length} band${s0.bands.length === 1 ? '' : 's'} below it`);
    if (r.stacks.length > 1) parts.push(`${r.stacks.length - 1} stacked revolution${r.stacks.length > 2 ? 's' : ''} above`);
    const mods = r.stacks.flatMap(s => [s.bandModulation, s.capModulation]).filter(m => m.K > 0);
    if (mods.length) parts.push(`periodic modulation K ${mods.map(m => `${m.K} (${(m.ampM * 100).toFixed(0)} cm)`).join(', ')}`);
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
 * The district's revolution parts rebuilt: the fit on the (tree-stripped, photo-textured) scan, the rebuilt parts
 * coloured from the same scan's photo and written to `<outDir>/revolutions.glb`. Returns the run (for cutting the parts
 * out of other layers) and a summary, or the summary alone when nothing was accepted.
 */
export async function buildRevolutionLayer(input: { scanGlb: string; outDir: string; within?: (x: number, z: number) => boolean; params?: RevolutionFitParams; signal?: AbortSignal }): Promise<{ summary: RevolutionLayerSummary; run: RevolutionFitRun; file?: string }> {
    const t0 = Date.now();
    const bytes = fs.readFileSync(input.scanGlb);
    let tris = readTileTriangles(bytes);
    if (input.within) {
        const keep = new Uint8Array(tris.texture.length);
        for (let t = 0; t < keep.length; t++) keep[t] = input.within((tris.positions[t * 9] + tris.positions[t * 9 + 3] + tris.positions[t * 9 + 6]) / 3, (tris.positions[t * 9 + 2] + tris.positions[t * 9 + 5] + tris.positions[t * 9 + 8]) / 3) ? 1 : 0;
        tris = selectTriangles(tris, keep);
    }
    const run = await runRevolutionFit({ positions: tris.positions }, path.join(input.outDir, 'revolution_fit'), input.params ?? {}, input.signal ? { signal: input.signal } : {});
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
export async function reviseForRevolutions(input: { dir: string; scanGlb: string; within?: (x: number, z: number) => boolean; cutFiles: string[]; signal?: AbortSignal }): Promise<RevolutionLayerSummary & { cut: Record<string, number> }> {
    const { summary, run, file } = await buildRevolutionLayer({ scanGlb: input.scanGlb, outDir: input.dir, ...(input.within ? { within: input.within } : {}), ...(input.signal ? { signal: input.signal } : {}) });
    const cut: Record<string, number> = {};
    if (file) for (const f of input.cutFiles) {
        if (!fs.existsSync(f)) continue;
        const r = cutRevolutionsFromGlb(fs.readFileSync(f), run.report.revolutions);
        if (r.removedTriangles) fs.writeFileSync(f, r.glb);
        cut[path.basename(f)] = r.removedTriangles;
    }
    return { ...summary, cut };
}
