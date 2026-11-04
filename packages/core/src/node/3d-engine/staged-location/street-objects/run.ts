/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Street objects over one district, report-only: the district residual audit's street clusters rebuilt from Street View
 * and the scan, each rebuild checked against the photos, nothing in the build changed.
 *
 *   1. find (families.ts) -> 2. see (see.ts: panos found on the free metadata endpoint, views planned where the scan says
 *   the member is clear) -> fetch through the Maps Imagery Grounding API (streetview-evidence.ts `fetchViews`: the
 *   service account, Google captures only; the bytes held in memory, never written, logged or re-encoded) -> register
 *   (pano-registration-run.ts, against the tile mesh; the nominal pose stands when it cannot) -> 3. read (read.ts, one
 *   vision call per family) -> 4. measure (silhouette-profile.ts) -> 5. build (object-spec.ts, then the native interpreter
 *   through reference-object-builder.ts `buildObjectFromSpec`) -> 6. check (check.ts) -> 7. era: a member the scan has and
 *   no view shows is reported (presence follows the scan).
 *
 * Families run as a pool (`concurrency` at a time); the vision calls share the app's model-call budget through the chain.
 * Written to `outDir`: the report (numbers, words, provenance, the decisions), each family's GLB and spec, and the kept
 * rebuilds placed at their members' feet as one GLB in the tile frame (glTF instancing: one mesh, a node per member).
 * Nothing written holds a Street View pixel.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { RenderMesh3D } from '../../../spatial/HeadlessMeshSilhouetteRenderer';
import { projectToFrame, readGlbScene, sceneToRenderMesh, type FrameCamera, type PoseCorrection } from '../../../spatial/StreetViewPoseRegistrar';
import { buildGroundModel, loadScanMesh, type GeodeticOrigin, type ScanMesh } from '../../../spatial/StreetViewSurveyPlanner';
import type { VisionModelChain } from '../../../gemini/vision-model-chain';
import { buildObjectFromSpec, type ReferenceObjectBuilderDeps } from '../../reference-object-builder';
import { castCamera } from '../survey-casting';
import { discoverPanosAt, fetchViews, type EvidenceImage, type StreetViewEvidenceDeps } from '../streetview-evidence';
import { runPanoRegistrationOffThread, type PanoRegistrationJob, type PanoRegistrationOutcome } from '../pano-registration-run';
import type { HeldImage } from '../pano-edge-registration';
import { decodeImageInMemory, readTileTriangles, selectTriangles, type TileTriangles } from '../tile-texture-transfer';
import { parseGlbBytes, assembleGlb } from '../glb-bytes';
import type { AuditedCluster, ResidualAuditResult } from '../residual-audit';
import { SB_FEATURE_PREFIX } from '../../../../common/spatial/sb-feature-types';
import { streetObjectFamilies, STREET_OBJECTS_VERSION, type StreetObjectFamily, type StreetObjectMember, type V3 } from './families';
import { discoveryPoints, planFamilyViews, SEE_PARAMS, type PlannedView, type SeeParams } from './see';
import { familyReadPrompt, parseFamilyReading, READ_PARAMS, type FamilyReading } from './read';
import { combineProfiles, profileFromSilhouette, type SilhouetteProfile } from './silhouette-profile';
import { planHeadingOf, streetObjectSpec, type StreetObjectSpec } from './object-spec';
import { frontOutline, frontSpec, squareness } from './front-outline';
import { CHECK_PARAMS, checkView, judgeFamily, overlayOutlines, scaledCamera, type FamilyCheck, type ViewCheck } from './check';
import { castPiece, planAxis, splitMember } from './split';
import { renderTriangles } from '../photo-match-eval';
import { encodePng } from '../png-encode';

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is untyped */

/**
 * The registration's time: three times the staged build's (90 s edges, 120 s joint). Narrow views of street objects give
 * the edge search little to hold, and a loaded machine ran the joint fit out of its own budget (Penn, 2026-11-03).
 */
export const REGISTRATION_BUDGET_MS = { edges: 270_000, joint: 360_000 };

/** A plan this many times longer than deep (and about as long as tall, or more) is built from its front outline. */
export const FRONT_LONG_ASPECT = 1.6;

export interface StreetObjectsInput {
    origin: GeodeticOrigin;
    /** The district residual audit (district_audit.json's `audit`). */
    audit: ResidualAuditResult;
    /** The tree-stripped scan the audit read (its triangles are the clusters'), and the full textured tile (the photos see trees too). */
    scanGlb: string;
    tileGlb: string;
    streetView: StreetViewEvidenceDeps;
    vision: VisionModelChain<string>;
    outDir: string;
    /** At most this many families (largest first); all by default. */
    maxFamilies?: number;
    /** Only these families or clusters (ids as in the report, or cluster ids). */
    only?: Array<string | number>;
    concurrency?: number;
    /** Also write, per checked view, an overlay PNG of the three outlines on the tile's own render (no photo pixel). */
    overlays?: boolean;
    see?: Partial<SeeParams>;
    builder?: ReferenceObjectBuilderDeps;
    register?: (job: PanoRegistrationJob, opts: { signal?: AbortSignal; log?: (m: string) => void }) => Promise<PanoRegistrationOutcome>;
    /** Cuts an object's mask out of a photo held in memory, from the read's box (default: the app's segmenter, in memory). */
    segment?: PhotoSegmenter;
    signal?: AbortSignal;
    onProgress?: (m: string) => void;
}

/** A photo's encoded bytes and a box (0..1000, [ymin, xmin, ymax, xmax]) in; the object's mask (one byte a pixel, 1: it) out. */
export type PhotoSegmenter = (bytes: Buffer, box: [number, number, number, number], signal?: AbortSignal) => Promise<Uint8Array>;

/**
 * The app's open-vocabulary segmenter (ObjectSegmenterService: MediaPipe interactive + GrabCut) on a photo held in memory,
 * prompted by the box and points down its vertical middle (a pole is thin: its middle is on it). The image is decoded inside
 * the segmenter's worker from the bytes as given; nothing is written.
 */
export function memorySegmenter(): PhotoSegmenter {
    let svc: { segmentBytes(i: { bytes: Buffer; box?: [number, number, number, number]; positive?: Array<[number, number]>; refine?: boolean; signal?: AbortSignal }): Promise<{ mask: Uint8Array }> } | undefined;
    return async (bytes, box, signal) => {
        if (!svc) {
            const { ObjectSegmenterService } = await import('../../../video/ObjectSegmenterService');
            svc = new ObjectSegmenterService();
        }
        const [y0, x0, y1, x1] = box.map(v => v / 1000);
        const cx = (x0 + x1) / 2;
        const positive: Array<[number, number]> = [0.25, 0.5, 0.75].map(t => [cx, y0 + t * (y1 - y0)]);
        return (await svc.segmentBytes({ bytes, box: [x0, y0, x1, y1], positive, refine: true, ...(signal ? { signal } : {}) })).mask;
    };
}

export interface FamilyReport {
    id: string;
    members: StreetObjectFamily['members'];
    row?: StreetObjectFamily['row'];
    reason: string;
    views: Array<{ id: string; panoId: string; captureMonth?: string; clusterId: number; headingDeg: number; fovDeg: number; rangeM: number; clearShare: number; registration: string; widthPx?: number; heightPx?: number; fetched: boolean; error?: string }>;
    /** What Street View saw, in the model's words and numbers. */
    seen?: { description: string; permanent: boolean; membersAlike?: boolean; pieceCount?: number; markings: string[]; confidence?: number; perView: Array<{ id: string; visible: boolean; sameObject: boolean; footVisible: boolean; hiddenShare: number; maskPixels?: number; pieces?: number; member?: number; note?: string }> };
    /** A long or flat object built from its front outline (front-outline.ts): the view, the boxes, its length and depth. */
    frontOutline?: { view: string; boxes: number; lengthM: number; depthM: number; squareness: number; scale: number };
    /** A scan ridge the photos showed as several alike pieces, split into members along the scan's line (split.ts). */
    split?: { clusterId: number; pieces: number; reason: string };
    profiles?: Array<Omit<SilhouetteProfile, 'samples'> & { halfWidthsM: number[] }>;
    profileFailures?: string[];
    spec?: StreetObjectSpec;
    glb?: string;
    buildError?: string;
    check?: FamilyCheck;
    /** Overlay PNGs (overlays: true), per checked view. */
    overlays?: string[];
    /** With overlays: the scan and the scan with the rebuild in it, from 1.6 m eye height (walk mode's), as PNGs. */
    eyeLevel?: { before: string; after: string; eye: V3; target: V3 };
    /** The scan has it, the views planned to see it do not show it (a different era, or a thing since moved). */
    era?: string;
    decision: 'rebuilt' | 'scan-kept' | 'not-seen' | 'temporary';
    decisionReason: string;
    ms: number;
}

export interface StreetObjectsReport {
    schema: 'scratchbox.street-objects/1';
    version: string;
    origin: GeodeticOrigin;
    families: FamilyReport[];
    plan: { panos: number; images: number; overBudget: string[]; contextViews: number };
    /** How each pano was posed: the edge registration's choice and reason, and the joint fit's verdict. */
    registration?: { panos: Array<{ panoId: string; chosen: string; reason: string }>; joint?: { chosen: string; reason: string }; error?: string };
    stats: { families: number; rows: number; members: number; seen: number; rebuilt: number; scanKept: number; notSeen: number; temporary: number; images: number; fetched: number; registered: number; visionCalls: number; cachedCalls: number; metadataCalls: number };
    layerGlb?: string;
    notes: string[];
    elapsedMs: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** The street clusters of a district audit: real objects, and unsure ones the street context labels as standing furniture. */
export function streetClusters(audit: ResidualAuditResult): AuditedCluster[] {
    return audit.clusters.filter(c => c.verdict === 'real-object' || (c.verdict === 'unsure' && c.feature.types.some(t => t === `${SB_FEATURE_PREFIX}STREET_FURNITURE` || t === `${SB_FEATURE_PREFIX}POLE`)))
        .filter(c => !c.feature.types.includes(`${SB_FEATURE_PREFIX}BUILDING_PART`));
}

const cellKey = (P: ArrayLike<number>, o: number, cell = 0.02) => `${Math.round((P[o] + P[o + 3] + P[o + 6]) / 3 / cell)},${Math.round((P[o + 1] + P[o + 4] + P[o + 7]) / 3 / cell)},${Math.round((P[o + 2] + P[o + 5] + P[o + 8]) / 3 / cell)}`;

/** The triangles of a soup whose centroid key passes `keep`, as a new soup (selectTriangles keeps every per-triangle field). */
export function subsetTriangles(t: TileTriangles, keep: (key: string, i: number) => boolean): TileTriangles {
    const flags = new Uint8Array(t.texture.length);
    for (let i = 0; i < flags.length; i++) flags[i] = keep(cellKey(t.positions, i * 9), i) ? 1 : 0;
    return selectTriangles(t, flags);
}

/** Soups as one (texture indices offset onto the joined texture list). */
export function mergeSoups(soups: TileTriangles[]): TileTriangles {
    if (soups.length === 1) return soups[0];
    const cat = (f: (t: TileTriangles) => Float32Array) => { const n = soups.reduce((s, t) => s + f(t).length, 0), o = new Float32Array(n); let at = 0; for (const t of soups) { o.set(f(t), at); at += f(t).length; } return o; };
    const textures: TileTriangles['textures'] = [];
    const tex = new Int32Array(soups.reduce((s, t) => s + t.texture.length, 0));
    let at = 0;
    for (const t of soups) { const base = textures.length; textures.push(...t.textures); for (let i = 0; i < t.texture.length; i++) tex[at + i] = t.texture[i] >= 0 ? t.texture[i] + base : -1; at += t.texture.length; }
    return { positions: cat(t => t.positions), uvs: cat(t => t.uvs), normals: cat(t => t.normals), flatLinear: cat(t => t.flatLinear), texture: tex, textures };
}

/** A soup moved by `d` (the rebuilt object, built about its foot, placed at a member). */
export function translated(t: TileTriangles, d: V3): TileTriangles {
    const p = Float32Array.from(t.positions);
    for (let i = 0; i < p.length; i += 3) { p[i] += d[0]; p[i + 1] += d[1]; p[i + 2] += d[2]; }
    return { ...t, positions: p };
}

/** A render mesh's triangles with a corner within `reachM` (plan) of any of `centres`. */
export function meshNear(m: RenderMesh3D, centres: Array<[number, number]>, reachM: number): RenderMesh3D {
    const cell = reachM, grid = new Set<string>();
    for (const [x, z] of centres) for (let i = -1; i <= 1; i++) for (let k = -1; k <= 1; k++) grid.add(`${Math.floor(x / cell) + i},${Math.floor(z / cell) + k}`);
    const near = (x: number, z: number) => grid.has(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) && centres.some(c => Math.hypot(c[0] - x, c[1] - z) <= reachM);
    const V = m.vertices, I = m.indices, kept: number[] = [];
    for (let t = 0; t + 2 < I.length; t += 3) {
        if ([0, 1, 2].some(j => near(V[I[t + j] * 3], V[I[t + j] * 3 + 2]))) kept.push(I[t], I[t + 1], I[t + 2]);
    }
    return { vertices: V, indices: Uint32Array.from(kept) };
}

/** A render mesh without the triangles whose centroid keys are in `drop`. */
function meshWithout(m: RenderMesh3D, drop: Set<string>): RenderMesh3D {
    const V = m.vertices, I = m.indices, kept: number[] = [];
    const tri = new Float32Array(9);
    for (let t = 0; t + 2 < I.length; t += 3) {
        for (let k = 0; k < 3; k++) { tri[k * 3] = V[I[t + k] * 3]; tri[k * 3 + 1] = V[I[t + k] * 3 + 1]; tri[k * 3 + 2] = V[I[t + k] * 3 + 2]; }
        if (!drop.has(cellKey(tri, 0))) kept.push(I[t], I[t + 1], I[t + 2]);
    }
    return { vertices: V, indices: Uint32Array.from(kept) };
}

/**
 * The kept rebuilds as one GLB: each family's GLB once (its meshes, materials and buffers), and per member a node at its foot
 * whose children copy the family's node tree (glTF instancing: the copies share the meshes).
 */
export function instancedLayer(families: Array<{ glb: Buffer; feet: V3[]; id: string; extras: Record<string, unknown> }>): Buffer {
    const json: any = { asset: { version: '2.0', generator: STREET_OBJECTS_VERSION }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], materials: [], accessors: [], bufferViews: [], buffers: [{ byteLength: 0 }], textures: [], images: [], samplers: [] };
    const bins: Buffer[] = [];
    let offset = 0;
    for (const f of families) {
        const g = parseGlbBytes(f.glb);
        const j = g.json;
        const base = { mesh: json.meshes.length, material: json.materials.length, accessor: json.accessors.length, view: json.bufferViews.length, node: json.nodes.length, texture: json.textures.length, image: json.images.length, sampler: json.samplers.length };
        const bin = Buffer.from(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
        for (const v of j.bufferViews ?? []) json.bufferViews.push({ ...v, buffer: 0, byteOffset: (v.byteOffset ?? 0) + offset });
        for (const a of j.accessors ?? []) json.accessors.push({ ...a, ...(a.bufferView !== undefined ? { bufferView: a.bufferView + base.view } : {}) });
        for (const s of j.samplers ?? []) json.samplers.push(s);
        for (const im of j.images ?? []) json.images.push({ ...im, ...(im.bufferView !== undefined ? { bufferView: im.bufferView + base.view } : {}) });
        for (const t of j.textures ?? []) json.textures.push({ ...t, ...(t.source !== undefined ? { source: t.source + base.image } : {}), ...(t.sampler !== undefined ? { sampler: t.sampler + base.sampler } : {}) });
        const retex = (o: any): any => (o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, k === 'index' && typeof v === 'number' ? v + base.texture : retex(v)])) : o);
        for (const m of j.materials ?? []) json.materials.push(retex(m));
        for (const m of j.meshes ?? []) json.meshes.push({ ...m, primitives: m.primitives.map((p: any) => ({ ...p, attributes: Object.fromEntries(Object.entries(p.attributes).map(([k, v]) => [k, (v as number) + base.accessor])), ...(p.indices !== undefined ? { indices: p.indices + base.accessor } : {}), ...(p.material !== undefined ? { material: p.material + base.material } : {}) })) });
        const roots: number[] = j.scenes?.[j.scene ?? 0]?.nodes ?? [];
        const srcNodes: any[] = j.nodes ?? [];
        f.feet.forEach((foot, k) => {
            const at = json.nodes.length;
            const copy = srcNodes.map((n: any) => ({ ...n, ...(n.mesh !== undefined ? { mesh: n.mesh + base.mesh } : {}), ...(n.children ? { children: n.children.map((c: number) => c + at + 1) } : {}) }));
            json.nodes.push({ name: `${f.id}#${k}`, translation: foot.map(r3), children: roots.map(r => r + at + 1), extras: { ...f.extras, member: k } });
            json.nodes.push(...copy);
            json.scenes[0].nodes.push(at);
        });
        bins.push(bin);
        offset += bin.length;
        const pad = (4 - (offset % 4)) % 4;
        if (pad) { bins.push(Buffer.alloc(pad)); offset += pad; }
        void base.node;
    }
    for (const k of ['textures', 'images', 'samplers', 'materials'] as const) if (!json[k].length) delete json[k];
    const bin = Buffer.concat(bins);
    json.buffers[0].byteLength = bin.length;
    return assembleGlb(json, bin);
}

/** A level-ish pinhole at `eye` looking at `target` (horizontal field of view `fovDeg`). */
export function lookAtCamera(eye: V3, target: V3, fovDeg: number, width: number, height: number): FrameCamera {
    const f = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]], fl = Math.hypot(f[0], f[1], f[2]);
    const fwd: V3 = [f[0] / fl, f[1] / fl, f[2] / fl];
    const rx = -fwd[2], rz = fwd[0], rl = Math.hypot(rx, rz) || 1;
    const right: V3 = [rx / rl, 0, rz / rl];
    const up: V3 = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
    const fx = width / 2 / Math.tan((fovDeg * Math.PI) / 360);
    return { eye, fwd, right, up, fx, fy: fx, cx: width / 2, cy: height / 2, width, height };
}

const median2 = (ps: Array<[number, number]>): [number, number] => { const m = (k: number) => { const v = ps.map(p => p[k]).sort((a, b) => a - b); return v[v.length >> 1]; }; return [m(0), m(1)]; };

/**
 * Where an upright of `heightM` stands (plan x, z) whose mask is this, when its foot is hidden: the ray through the mask's
 * top middle, at the distance its height in the photo says (the focal length over the rows it spans, times the height).
 */
export function alongRayByHeight(cam: FrameCamera, mask: Uint8Array, W: number, H: number, heightM: number): [number, number] | undefined {
    let y0 = -1, y1 = -1;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { const y = (i - (i % W)) / W; if (y0 < 0) y0 = y; y1 = y; }
    if (y0 < 0 || y1 <= y0) return undefined;
    const xs: number[] = [];
    for (let x = 0; x < W; x++) if (mask[y0 * W + x]) xs.push(x);
    const d = (heightM * cam.fy) / (y1 - y0 + 1);
    const xc = (xs[xs.length >> 1] + 0.5 - cam.cx) / cam.fx, yc = -(y0 + 0.5 - cam.cy) / cam.fy;
    const dir = [cam.right[0] * xc + cam.up[0] * yc + cam.fwd[0], cam.right[2] * xc + cam.up[2] * yc + cam.fwd[2]];
    return [cam.eye[0] + dir[0] * d, cam.eye[2] + dir[1] * d];
}

async function pool<T>(xs: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
    let i = 0;
    await Promise.all(Array.from({ length: Math.max(1, Math.min(n, xs.length)) }, async () => { for (let k; (k = i++) < xs.length;) await fn(xs[k], k); }));
}

/** The box (0..1000) a member's scan points make in a camera. */
function projectedBox(cam: FrameCamera, pts: Float32Array): [number, number, number, number] | undefined {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i + 2 < pts.length; i += 3) { const p = projectToFrame(cam, pts, i); if (!p) continue; x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    if (!(x1 > x0 && y1 > y0)) return undefined;
    const c = (v: number, n: number) => Math.max(0, Math.min(1000, (v / n) * 1000));
    return [c(y0, cam.height), c(x0, cam.width), c(y1, cam.height), c(x1, cam.width)];
}

export async function rebuildStreetObjects(input: StreetObjectsInput): Promise<StreetObjectsReport> {
    const t0 = Date.now();
    const progress = input.onProgress ?? (() => undefined);
    const notes: string[] = [];
    fs.mkdirSync(input.outDir, { recursive: true });
    // ---- 1. find
    const clusters = streetClusters(input.audit);
    const fams = streetObjectFamilies(clusters);
    let families = fams.families.slice().sort((a, b) => b.heightM * b.planM[0] * b.planM[1] * b.members.length - a.heightM * a.planM[0] * a.planM[1] * a.members.length);
    if (input.only?.length) families = families.filter(f => input.only!.some(o => o === f.id || f.members.some(m => m.clusterId === Number(o))));
    if (input.maxFamilies) families = families.slice(0, input.maxFamilies);
    notes.push(`${clusters.length} street clusters in the audit, ${fams.families.length} families (${fams.families.filter(f => f.row).length} rows), ${fams.skipped.length} clusters left out; ${families.length} families taken`);
    // the members' own triangles (scan points for the clear check, centroid keys to take them out of the context)
    progress('reading the scan and the tile mesh');
    const scan: ScanMesh = loadScanMesh(input.scanGlb);
    const source = input.audit.sources[0];
    const byCluster = new Map(clusters.map(c => [c.id, c]));
    const memberPoints = new Map<number, Float32Array>(), memberKeys = new Map<number, Set<string>>();
    const V = scan.mesh.vertices as ArrayLike<number>, I = scan.mesh.indices as ArrayLike<number>;
    for (const f of families) for (const m of f.members) {
        const c = byCluster.get(m.clusterId)!;
        const pts = new Float32Array(c.triangleIds.length * 9), keys = new Set<string>();
        c.triangleIds.forEach((cand, k) => {
            const t = source.localTriangles ? source.localTriangles[cand - source.firstTriangle] : cand - source.firstTriangle;
            for (let j = 0; j < 3; j++) { const v = I[t * 3 + j] * 3; pts[k * 9 + j * 3] = V[v]; pts[k * 9 + j * 3 + 1] = V[v + 1]; pts[k * 9 + j * 3 + 2] = V[v + 2]; }
            keys.add(cellKey(pts, k * 9));
        });
        memberPoints.set(m.clusterId, pts);
        memberKeys.set(m.clusterId, keys);
    }
    // the tile mesh near the families only (the views reach maxRangeM; the clear checks and the checks' occluders need nothing
    // farther): a district's whole tile is millions of triangles, each depth render of it seconds
    const reachM = (input.see?.maxRangeM ?? SEE_PARAMS.maxRangeM) + 20;
    const tileMesh = meshNear(sceneToRenderMesh(readGlbScene(input.tileGlb)), families.flatMap(f => f.members.map(m => [m.foot[0], m.foot[2]] as [number, number])), reachM);
    const ground = buildGroundModel(scan, { cellMeters: 1 });
    // ---- 2. see
    const reach = (input.see?.maxRangeM ?? SEE_PARAMS.maxRangeM) - 3;
    progress('finding the Street View panoramas around the street objects');
    const found = await discoverPanosAt(input.origin, discoveryPoints(families, reach), input.streetView, input.signal, undefined, 400);
    const plan = planFamilyViews({ families, panos: found.panos, groundAt: ground.groundAt, tileMesh, memberPoints, ...(input.see ? { params: input.see } : {}) });
    notes.push(`${found.panos.length} Google panoramas found (${found.metadataCalls} metadata calls, ${found.rejectedNotGoogle} user photospheres left out); ${plan.images} images planned (${plan.context.length} for registration)${plan.overBudget.length ? `; ${plan.overBudget.length} families over the image budget` : ''}`);
    // ---- fetch (in memory) and register
    const all: PlannedView[] = [...plan.context, ...plan.families.flatMap(f => f.views)];
    const images = new Map<PlannedView, EvidenceImage>();
    const fetchErrors = new Map<PlannedView, string>();
    progress(`fetching ${all.length} Street View views through the grounding API`);
    for (let i = 0; i < all.length; i += 12) {
        const batch = all.slice(i, i + 12);
        const got = await fetchViews(batch, input.streetView, input.signal);
        for (const im of got.images) images.set(im.view as PlannedView, im);
        for (const f of got.failures) fetchErrors.set(f.view as PlannedView, f.error);
    }
    let reg: PanoRegistrationOutcome | undefined;
    if (images.size) {
        try {
            const held: HeldImage[] = [...images.values()].map(im => ({ id: im.id, bytes: im.bytes, widthPx: im.widthPx, heightPx: im.heightPx, view: im.view }));
            progress(`registering ${held.length} views against the 3D tiles`);
            reg = await (input.register ?? runPanoRegistrationOffThread)({ images: held, meshFiles: [input.tileGlb], correspondences: [], faces: [], edgeBudgetMs: REGISTRATION_BUDGET_MS.edges, jointBudgetMs: REGISTRATION_BUDGET_MS.joint }, { ...(input.signal ? { signal: input.signal } : {}), log: progress });
        } catch (err) {
            if (input.signal?.aborted) throw err;
            notes.push(`registration failed (${err instanceof Error ? err.message : String(err)}); the nominal poses stand (good to about 2 m and 2 degrees)`);
        }
    }
    const corrections: Map<string, PoseCorrection> | undefined = reg?.registration?.corrections;
    const methodOf = (panoId: string) => reg?.registration?.perPano.find(p => p.panoId === panoId)?.method ?? 'nominal';
    // the scan's textured triangles (the blob as drawn) and the soups the checks draw
    const segment = input.segment ?? memorySegmenter();
    const scanSoup = readTileTriangles(fs.readFileSync(input.scanGlb));
    const tileSoup = input.overlays ? readTileTriangles(fs.readFileSync(input.tileGlb)) : undefined;
    // ---- 3-6 per family
    const reports: FamilyReport[] = [];
    let visionCalls = 0, cachedCalls = 0;
    const kept: Array<{ glb: Buffer; feet: V3[]; id: string; extras: Record<string, unknown> }> = [];
    const eyeJobs: Array<{ rep: FamilyReport; fam: StreetObjectFamily; soup: TileTriangles; side: [number, number] }> = [];
    await pool(families, input.concurrency ?? 4, async fam => {
        const tf = Date.now();
        const fv = plan.families.find(p => p.familyId === fam.id)!;
        const views = fv.views.filter(v => images.has(v));
        const rep: FamilyReport = {
            id: fam.id, members: fam.members, ...(fam.row ? { row: fam.row } : {}), reason: fam.reason,
            views: fv.views.map(v => { const im = images.get(v); return { id: im?.id ?? `${v.panoId}:${v.headingDeg}`, panoId: v.panoId, ...(v.date ? { captureMonth: v.date.slice(0, 7) } : {}), clusterId: v.clusterId, headingDeg: v.headingDeg, fovDeg: v.fovDeg, rangeM: v.rangeM, clearShare: v.clearShare, registration: methodOf(v.panoId), ...(im ? { widthPx: im.widthPx, heightPx: im.heightPx } : {}), fetched: !!im, ...(fetchErrors.has(v) ? { error: fetchErrors.get(v) } : {}) }; }),
            decision: 'not-seen', decisionReason: '', ms: 0
        };
        reports.push(rep);
        if (!views.length) { rep.decisionReason = fv.notes.join('; ') || 'no view of it could be fetched'; rep.ms = Date.now() - tf; return; }
        const cams = views.map(v => { const im = images.get(v)!; const c = corrections?.get(v.panoId); return castCamera({ eye: v.eye, headingDeg: v.headingDeg, pitchDeg: v.pitchDeg, fovDeg: v.fovDeg, widthPx: im.widthPx, heightPx: im.heightPx, ...(c ? { correction: c } : {}) }); });
        const member = (v: PlannedView) => fam.members.find(m => m.clusterId === v.clusterId)!;
        const boxes = views.map((v, k) => projectedBox(cams[k], memberPoints.get(v.clusterId)!) ?? [400, 400, 600, 600] as [number, number, number, number]);
        // ---- 3. read
        let reading: FamilyReading | undefined;
        try {
            progress(`reading ${fam.id} from ${views.length} view${views.length === 1 ? '' : 's'}`);
            const own = new AbortController();
            const timer = setTimeout(() => own.abort(new Error(`the vision call took longer than ${READ_PARAMS.timeoutMs / 1000} s`)), READ_PARAMS.timeoutMs);
            try {
                const prompt = familyReadPrompt(views.map((v, k) => ({ box: boxes[k], heightM: member(v).heightM, rangeM: v.rangeM })), fam.members.length);
                const r = await input.vision.generate({
                    contents: [{ role: 'user', parts: [...views.map(v => { const im = images.get(v)!; return { inlineData: { mimeType: im.mimeType, data: im.bytes.toString('base64') } }; }), { text: prompt }] }],
                    config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: READ_PARAMS.maxOutputTokens, abortSignal: input.signal ? AbortSignal.any([input.signal, own.signal]) : own.signal }
                }, { stage: 'street-objects', thinkingBudget: READ_PARAMS.thinkingBudget });
                visionCalls++;
                if (r.cached) cachedCalls++;
                const text = (r.response.candidates?.[0]?.content?.parts ?? []).filter(p => !(p as { thought?: boolean }).thought).map(p => p.text ?? '').join('');
                const parsed = parseFamilyReading(text, views.map(v => ({ width: images.get(v)!.widthPx, height: images.get(v)!.heightPx })));
                if ('error' in parsed) throw new Error(parsed.error);
                reading = parsed;
                r.remember();
            } finally { clearTimeout(timer); }
        } catch (err) {
            if (input.signal?.aborted) throw err;
            rep.decision = 'scan-kept';
            rep.decisionReason = `the vision read failed (${err instanceof Error ? err.message : String(err)}); the scan stays`;
            rep.ms = Date.now() - tf;
            return;
        }
        rep.seen = {
            description: reading.look.description, permanent: reading.permanent, pieceCount: reading.pieceCount, ...(reading.membersAlike !== undefined ? { membersAlike: reading.membersAlike } : {}), markings: reading.look.markings ?? [], ...(reading.look.confidence !== undefined ? { confidence: reading.look.confidence } : {}),
            perView: reading.views.map((rv, k) => ({ id: images.get(views[k])!.id, visible: rv.visible, sameObject: rv.sameObject, footVisible: rv.footVisible, hiddenShare: rv.hiddenShare, ...(rv.maskPixels ? { maskPixels: rv.maskPixels } : {}), ...(rv.error ? { note: rv.error } : {}) }))
        };
        // the masks: cut from the read's boxes by the segmenter, in memory (the photo's own and each piece's)
        for (let k = 0; k < views.length; k++) {
            const rv = reading.views[k], im = images.get(views[k])!;
            if (!rv.visible || !rv.sameObject || !rv.box) continue;
            try {
                if (!rv.mask) { rv.mask = await segment(im.bytes, rv.box, input.signal); rv.maskPixels = rv.mask.reduce((n, x) => n + x, 0); }
                for (const pc of rv.pieces ?? []) if (!pc.mask) { pc.mask = await segment(im.bytes, pc.box, input.signal); pc.pixels = pc.mask.reduce((n, x) => n + x, 0); }
            } catch (err) {
                if (input.signal?.aborted) throw err;
                rv.error = `the segmenter found no mask in its box (${err instanceof Error ? err.message : String(err)})`;
            }
            rv.pieces = rv.pieces?.filter(pc => pc.mask && pc.pixels);
        }
        // which member each mask is: its foot cast onto the ground from the view's camera (or, when the foot is hidden, as far
        // along the ray as its height in the photo says), the family's member nearest there; a mask standing far from every
        // member is something else (a narrow view along a row sees the nearer members too)
        const assigned = new Map<number, number>();
        for (let k = 0; k < views.length; k++) {
            const rv = reading.views[k], im = images.get(views[k])!;
            if (!rv.mask || !rv.maskPixels) continue;
            const m0 = member(views[k]);
            let at: [number, number] | undefined;
            if (rv.footVisible) at = castPiece(cams[k], { mask: rv.mask, width: im.widthPx, height: im.heightPx }, m0.foot[1])?.at;
            if (!at) at = alongRayByHeight(cams[k], rv.mask, im.widthPx, im.heightPx, m0.heightM);
            if (!at) continue;
            const near = fam.members.map(m => ({ m, d: Math.hypot(m.foot[0] - at![0], m.foot[2] - at![1]) })).sort((a, b) => a.d - b.d)[0];
            const tol = Math.max(1.5, 0.12 * views[k].rangeM);
            if (near.d <= tol) assigned.set(k, near.m.clusterId);
            else { rv.sameObject = false; rv.error = `its mask stands ${Math.round(near.d * 10) / 10} m from the nearest member (over ${Math.round(tol * 10) / 10} m): something else`; }
        }
        const cidOf = (k: number) => assigned.get(k) ?? views[k].clusterId;
        const memberAt = (k: number) => fam.members.find(m => m.clusterId === cidOf(k))!;
        rep.seen.perView = reading.views.map((rv, k) => ({ id: images.get(views[k])!.id, visible: rv.visible, sameObject: rv.sameObject, footVisible: rv.footVisible, hiddenShare: rv.hiddenShare, ...(rv.maskPixels ? { maskPixels: rv.maskPixels } : {}), ...(rv.pieces?.length ? { pieces: rv.pieces.length } : {}), ...(assigned.has(k) && assigned.get(k) !== views[k].clusterId ? { member: assigned.get(k) } : {}), ...(rv.error ? { note: rv.error } : {}) }));
        const usable = reading.views.map((rv, k) => ({ rv, k })).filter(x => x.rv.visible && x.rv.sameObject && x.rv.mask && x.rv.maskPixels);
        if (!usable.length) {
            rep.decision = 'not-seen';
            rep.era = `the scan has ${fam.members.length > 1 ? 'these members' : 'it'}, but none of the ${views.length} view${views.length === 1 ? '' : 's'} planned to see it clear shows it (captures ${[...new Set(views.map(v => v.date?.slice(0, 7)).filter(Boolean))].join(', ') || 'undated'}): a different era, or a thing since moved; presence follows the scan`;
            rep.decisionReason = rep.era;
            rep.ms = Date.now() - tf;
            return;
        }
        // put out for a while (a cone, a barrier for works, luggage): not rebuilt; the splice takes it out and fills the ground
        if (!reading.permanent) {
            rep.decision = 'temporary';
            rep.decisionReason = `Street View reads it as put out for a while ("${reading.look.description}"), not installed: it is not rebuilt; the splice step removes it and fills the ground under it`;
            rep.ms = Date.now() - tf;
            return;
        }

        // ---- a ridge the photos show as several alike pieces: split along the scan's line (split.ts)
        let family = fam;
        const piecesOf = (k: number) => (reading!.views[k].pieces ?? []).filter(pc => pc.mask).map(pc => ({ ...pc, mask: pc.mask!, width: images.get(views[k])!.widthPx, height: images.get(views[k])!.heightPx }));
        if (reading.pieceCount >= 2) {
            const members: StreetObjectMember[] = [];
            const splits: NonNullable<ReturnType<typeof splitMember>>[] = [];
            for (const m of fam.members) {
                const lead = usable.filter(u => cidOf(u.k) === m.clusterId && (u.rv.pieces?.length ?? 0) >= 2).sort((a, b) => b.rv.pieces!.length - a.rv.pieces!.length)[0];
                const sp = lead ? splitMember(m, cams[lead.k], piecesOf(lead.k)) : undefined;
                if (sp) { members.push(...sp.members); splits.push(sp); } else members.push(m);
            }
            if (splits.length) {
                // one ridge split: its pieces are the row; ridges of a row split: the pieces of each, no single pitch
                const row = fam.members.length === 1 ? splits[0].row : undefined;
                family = { ...fam, members, planM: median2(members.map(m => m.planM)), reason: `${fam.reason}; ${splits.map(x => x.reason).join('; ')}` };
                if (row) family.row = row; else delete family.row;
                rep.members = members;
                if (row) rep.row = row; else delete rep.row;
                rep.split = { clusterId: fam.members[0].clusterId, pieces: members.length, reason: splits.map(x => x.reason).join('; ') };
            } else rep.split = { clusterId: fam.members[0].clusterId, pieces: fam.members.length, reason: `the read counted ${reading.pieceCount} pieces, but no view showed two or more of them landing on the scan's line: kept as scanned members` };
        }
        const split = family !== fam;
        // ---- 4. measure: each member's silhouette in each view (a split member: the piece whose foot is nearest its own)
        const profiles: SilhouetteProfile[] = [];
        const failures: string[] = [];
        for (const { rv, k } of usable) {
            const im = images.get(views[k])!;
            const here = family.members.filter(m => m.clusterId === cidOf(k));
            for (const m of here) {
                let mask = rv.mask!;
                if (split) {
                    const pf = projectToFrame(cams[k], m.foot);
                    const pcs = piecesOf(k);
                    if (!pf || !pcs.length) continue;
                    const footX = (pc: { box: [number, number, number, number] }) => ((pc.box[1] + pc.box[3]) / 2000) * im.widthPx;
                    const near = pcs.slice().sort((a, b) => Math.abs(footX(a) - pf[0]) - Math.abs(footX(b) - pf[0]))[0];
                    const tolPx = ((family.row?.pitchM ?? 1) * 0.6 * cams[k].fx) / Math.max(0.5, pf[2]);
                    if (Math.abs(footX(near) - pf[0]) > tolPx) continue;
                    mask = near.mask;
                }
                const p = profileFromSilhouette({ mask, width: im.widthPx, height: im.heightPx, cam: cams[k], id: `${im.id}${m.piece !== undefined ? `#${m.piece}` : ''}` }, { foot: m.foot, heightM: m.heightM, planM: m.planM, planHeadingDeg: m.planHeadingDeg });
                if ('failed' in p) failures.push(`${im.id}${m.piece !== undefined ? ` piece ${m.piece}` : ''}: ${p.failed}`); else profiles.push(p);
            }
        }
        if (failures.length) rep.profileFailures = failures;
        if (!profiles.length) { rep.decision = 'scan-kept'; rep.decisionReason = `no view's mask could be read as a profile (${failures.join('; ')}); the scan stays`; rep.ms = Date.now() - tf; return; }
        rep.profiles = profiles.map(({ samples, ...p }) => ({ ...p, halfWidthsM: samples.map(s => s.halfWidthM) }));
        const combined = combineProfiles(profiles);
        const lead = profiles.slice().sort((a, b) => b.pixelHeight - a.pixelHeight)[0];
        const leadCam = cams[usable.find(u => lead.id?.startsWith(images.get(views[u.k])!.id))?.k ?? usable[0].k];
        // ---- 5. build
        // a long or flat object seen square-on: its front outline through its depth; else a profile solid
        let spec: StreetObjectSpec | undefined;
        const [pl0, pl1] = family.planM;
        const longPlan = Math.max(pl0, pl1) >= FRONT_LONG_ASPECT * Math.max(0.05, Math.min(pl0, pl1)) && Math.max(pl0, pl1) >= family.heightM * 0.8;
        const flatRead = (reading.look.sectionAspect ?? 1) < 0.6;
        if (!split && (longPlan || flatRead)) {
            const axis = planAxis(planHeadingOf(family.members.map(m => m.planHeadingDeg)));
            const best = usable.map(u => ({ u, sq: squareness(cams[u.k], axis) })).sort((a, b) => b.sq - a.sq)[0];
            const im = images.get(views[best.u.k])!, m = memberAt(best.u.k);
            const fo = frontOutline({ mask: best.u.rv.mask!, width: im.widthPx, height: im.heightPx, cam: cams[best.u.k] }, m);
            if ('failed' in fo) (rep.profileFailures ??= []).push(`front outline from ${im.id}: ${fo.failed}`);
            else {
                const depthRead = reading.look.sectionAspect !== undefined && reading.look.sectionAspect < 1;
                const depthM = depthRead ? fo.lengthM * reading.look.sectionAspect! : Math.min(pl0, pl1);
                spec = frontSpec({ family, boxes: fo.boxes, depthM, look: reading.look, viewId: im.id });
                if (depthRead) spec.provenance = spec.provenance.map(p => (p.field === 'plan depth and heading' ? { field: 'plan depth', label: 'photo-inferred', source: `the read's section aspect ${reading!.look.sectionAspect} times the outline's ${fo.lengthM} m length (the scan's blob is wider than the thing it melted); heading from the scan` } : p));
                rep.frontOutline = { view: im.id, boxes: fo.boxes.length, lengthM: fo.lengthM, depthM: Math.round(depthM * 1000) / 1000, squareness: fo.squareness, scale: fo.scale };
            }
        }
        spec ??= streetObjectSpec({ family, profile: combined, look: reading.look, panelRightDir: [leadCam.right[0], leadCam.right[2]], radialSymmetry: fam.members[0].radialSymmetry });
        if (split) spec.provenance = spec.provenance.map(p => (p.field === 'placement' ? { field: 'placement', label: 'photo-inferred', source: 'each piece\'s foot cast from the registered Street View pose onto the scan\'s line through the ridge (the line, its height and its support measured)' } : p));
        rep.spec = spec;
        let glb: Buffer;
        try {
            progress(`building ${fam.id} natively (${spec.operator})`);
            const built = await buildObjectFromSpec(spec.spec, { ...(input.signal ? { signal: input.signal } : {}) }, input.builder ?? {});
            glb = built.glb;
            const file = path.join(input.outDir, `${fam.id.replace(/\//g, '_')}.glb`);
            fs.writeFileSync(file, glb);
            fs.writeFileSync(file.replace(/\.glb$/, '.spec.json'), JSON.stringify(spec, null, 1));
            rep.glb = file;
        } catch (err) {
            if (input.signal?.aborted) throw err;
            rep.buildError = err instanceof Error ? err.message : String(err);
            rep.decision = 'scan-kept';
            rep.decisionReason = `the spec could not be built (${rep.buildError}); the scan stays`;
            rep.ms = Date.now() - tf;
            return;
        }
        // ---- 6. check, at each usable view, against its member's blob
        const rebuiltSoup = readTileTriangles(glb);
        const checks: ViewCheck[] = [];
        for (const { rv, k } of usable) {
            const v = views[k], im = images.get(v)!;
            const here = family.members.filter(m => m.clusterId === cidOf(k));
            const keys = memberKeys.get(cidOf(k))!;
            let mask = rv.mask!;
            if (split && rv.pieces?.length) { mask = new Uint8Array(rv.mask!.length); for (const pc of rv.pieces) if (pc.mask) for (let i = 0; i < mask.length; i++) if (pc.mask[i]) mask[i] = 1; }
            const photo = decodeImageInMemory(im.bytes);
            const vc = checkView({
                id: im.id, cam: cams[k], photo, mask, rebuild: mergeSoups(here.map(m => translated(rebuiltSoup, m.foot))), scan: subsetTriangles(scanSoup, key => keys.has(key)),
                context: meshWithout(tileMesh, keys), axis: { foot: here[0].foot, heightM: here[0].heightM }, bands: reading.look.bands ?? [], keepMasks: !!tileSoup, anchor: rv.footVisible ? 'foot' : 'top'
            });
            if (tileSoup && vc.masks) {
                const bg = renderTriangles([tileSoup], scaledCamera(cams[k], CHECK_PARAMS.renderScale), { supersample: 1 });
                const file = path.join(input.outDir, `${fam.id.replace(/\//g, '_')}_${checks.length}.png`);
                fs.writeFileSync(file, encodePng(vc.masks.width, vc.masks.height, overlayOutlines(bg.rgba, vc.masks), 4));
                (rep.overlays ??= []).push(file);
            }
            checks.push(vc);
        }
        rep.check = judgeFamily(checks);
        if (tileSoup) eyeJobs.push({ rep, fam: family, soup: rebuiltSoup, side: [leadCam.eye[0], leadCam.eye[2]] });
        rep.decision = rep.check.keep ? 'rebuilt' : 'scan-kept';
        rep.decisionReason = rep.check.reason;
        if (rep.check.keep) kept.push({ glb, feet: family.members.map(m => m.foot), id: fam.id, extras: { sbStreetObject: { family: fam.id, provenance: spec.provenance, check: { iouRebuild: rep.check.iouRebuild, iouScan: rep.check.iouScan, deltaERebuild: rep.check.deltaERebuild, deltaEScan: rep.check.deltaEScan } } } });
        rep.ms = Date.now() - tf;
    });
    // ---- the eye-level pairs: the whole family in frame from the side its photos saw it
    if (tileSoup && eyeJobs.length) {
        progress(`drawing ${eyeJobs.length} eye-level before / after pairs`);
        const removeKeys = new Set<string>();
        for (const j of eyeJobs) if (j.rep.decision === 'rebuilt') for (const m of j.fam.members) for (const k of memberKeys.get(m.clusterId)!) removeKeys.add(k);
        const without = subsetTriangles(tileSoup, key => !removeKeys.has(key));
        const placed = eyeJobs.filter(j => j.rep.decision === 'rebuilt').flatMap(j => j.fam.members.map(m => translated(j.soup, m.foot)));
        for (const j of eyeJobs) {
            // from the member nearest the lead view's camera, back toward that camera (the pano stood in the open street), at
            // walk mode's 1.6 m eye height, far enough to see the member whole with what stands beside it
            const m0 = j.fam.members.slice().sort((a, b) => Math.hypot(a.foot[0] - j.side[0], a.foot[2] - j.side[1]) - Math.hypot(b.foot[0] - j.side[0], b.foot[2] - j.side[1]))[0];
            let dx = j.side[0] - m0.foot[0], dz = j.side[1] - m0.foot[2];
            const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
            const dist = Math.min(L, Math.max(3.5, j.fam.heightM * 2.5 + 2));
            const ex = m0.foot[0] + dx * dist, ez = m0.foot[2] + dz * dist;
            const g = ground.groundAt(ex, ez);
            const eye: V3 = [ex, (Number.isFinite(g) ? g : m0.foot[1]) + 1.6, ez];
            const target: V3 = [m0.foot[0], m0.foot[1] + j.fam.heightM * 0.5, m0.foot[2]];
            const cam = lookAtCamera(eye, target, 60, 1280, 720);
            const stem = path.join(input.outDir, `${j.fam.id.replace(/\//g, '_')}_eye`);
            const before = renderTriangles([tileSoup], cam, { supersample: 2 }), after = renderTriangles([without, ...placed], cam, { supersample: 2 });
            fs.writeFileSync(`${stem}_before.png`, encodePng(cam.width, cam.height, before.rgba, 4));
            fs.writeFileSync(`${stem}_after.png`, encodePng(cam.width, cam.height, after.rgba, 4));
            j.rep.eyeLevel = { before: `${stem}_before.png`, after: `${stem}_after.png`, eye: eye.map(r3) as V3, target: target.map(r3) as V3 };
        }
    }
    const fetched = images.size;
    // the images go out of reach here: nothing above kept a reference past its family
    images.clear();
    reports.sort((a, b) => families.findIndex(f => f.id === a.id) - families.findIndex(f => f.id === b.id));
    let layerGlb: string | undefined;
    if (kept.length) {
        layerGlb = path.join(input.outDir, 'street_objects_layer.glb');
        fs.writeFileSync(layerGlb, instancedLayer(kept));
    }
    const report: StreetObjectsReport = {
        schema: 'scratchbox.street-objects/1', version: STREET_OBJECTS_VERSION, origin: input.origin, families: reports,
        plan: { panos: found.panos.length, images: plan.images, overBudget: plan.overBudget, contextViews: plan.context.length },
        ...(reg ? { registration: { panos: (reg.edge?.panos ?? []).map(p => ({ panoId: p.panoId, chosen: p.chosen, reason: p.reason })), ...(reg.joint ? { joint: { chosen: reg.joint.chosen, reason: reg.joint.reason } } : {}) } } : {}),
        stats: {
            families: reports.length, rows: reports.filter(r => r.row).length, members: reports.reduce((s, r) => s + r.members.length, 0), seen: reports.filter(r => r.seen).length,
            rebuilt: reports.filter(r => r.decision === 'rebuilt').length, scanKept: reports.filter(r => r.decision === 'scan-kept').length, notSeen: reports.filter(r => r.decision === 'not-seen').length, temporary: reports.filter(r => r.decision === 'temporary').length,
            images: all.length, fetched, registered: new Set(all.map(v => v.panoId).filter(id => methodOf(id) !== 'nominal')).size,
            visionCalls, cachedCalls, metadataCalls: found.metadataCalls
        },
        ...(layerGlb ? { layerGlb } : {}), notes, elapsedMs: Date.now() - t0
    };
    fs.writeFileSync(path.join(input.outDir, 'street_objects.json'), JSON.stringify(report, null, 1));
    return report;
}
