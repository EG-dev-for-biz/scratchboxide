/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * The district completeness audit (docs/research/2026-11-03-district-run-over-run-plan.md, section 5.2): what a built
 * district leaves incomplete, per building, measured on the layers as the viewer draws them (each layer's textured twin
 * where it has one, else its clay). Deterministic: no model, no render; the same files give the same numbers.
 *
 * Every triangle belongs to the building whose footprint (Google's vector outline, within `buildingMarginM`) holds its
 * middle in plan; one in none belongs to a scan component when it lies on a separate piece large enough to be a
 * structure, else to the ground. Per building:
 *   - **The edge.** The district's grown edge is the disc of `radiusM` grown by whole footprints (the buildings the plan
 *     keeps whole). A footprint is sampled (its corners, along its sides every `footprintStepM`, and inside on that grid):
 *     wholly inside the edge, wholly out, or straddling it. Independently, open edges lying within `edgeBandM` of the
 *     disc's line (outside every grown footprint) are the mark a cut leaves: their length is `cutAtEdgeM`.
 *   - **Open edges and holes.** Vertices are welded within `weldM` per layer; an edge used by one triangle is open, by
 *     three or more non-manifold. Open edges are joined into loops: a loop mostly on the edge's line is the cut, one
 *     whose every vertex lies within `baseBandM` of its owner's lowest point is the base standing on the ground, and any
 *     other is a hole (one shorter than `minHolePerimeterM` is counted apart as small).
 *   - **Black and untextured texels.** Each triangle is sampled at a fixed low-discrepancy pattern, one sample per
 *     `texelSampleAreaM2` (at most `maxSamplesPerTriangle`), at the nearest texel of its base-colour texture; a texel no
 *     channel of which passes `blackMax` is black. A triangle drawn without a texture (no base-colour texture, or no
 *     TEXCOORD_0) is untextured. Both are shares of the owner's surface area.
 *   - **Overlapping coplanar surfaces** (z-fighting). Three points of every triangle are tested against the triangles
 *     near them, of any layer: another triangle that shares no vertex with it, lies in its plane (normals within
 *     `overlapAngleDeg`, the point within `overlapPlaneM` of its plane, either facing) and covers the point covers that
 *     third of it. The covered area is halved (each pair counted from both sides).
 *   - **Floating pieces.** A piece (connected through welded vertices) other than the largest of its layer that comes
 *     within `contactM` of no other piece's triangle, in any layer: it stands on nothing.
 * Per tree (a node carrying `sbTree` in a layer whose pieces are kept whole, else each piece): whether its crown is whole
 * at the edge. A crown whose envelope (sbTree.crown, else its own extent toward the district's middle) crosses the disc's
 * line is whole when its geometry reaches past the line at least `crownWholeShare` of the way the envelope does; a cut
 * crown stops at the line.
 *
 * A check over its limit is a failure, in words, with the measure; the measures go to the place store (place-store.ts),
 * where a building that fails is the next run's first work.
 */

import type { Vec2 } from '../../../common/spatial/staged-location-contracts';
import { nodeWorldMatrices, parseGlbBytes, readAccessor, type Mat4, type ParsedGlb } from './glb-bytes';
import { districtBuildingIndex, type DistrictFootprint } from './pipeline-k/district-buildings';
import { decodeImageInMemory, type RgbaImage8 } from './tile-texture-transfer';

/* eslint-disable @typescript-eslint/no-explicit-any -- glTF JSON is untyped */

export const DISTRICT_AUDIT_VERSION = 'district-audit/1';

export const DISTRICT_AUDIT_PARAMS = {
    /** Positions within this are one vertex (m). */
    weldM: 0.001,
    /** A triangle whose middle lies this close outside a footprint still belongs to it (m; district-buildings.ts). */
    buildingMarginM: 1.5,
    /** The footprint's sampling step along its sides and inside (m). */
    footprintStepM: 1,
    /** Open edges this close to the disc's line are on the edge (m): a triangle's size plus the chunks' seam band. */
    edgeBandM: 4,
    /** A loop with at least this share of its length on the edge is the edge's cut. */
    edgeLoopShare: 0.5,
    /** A loop whose every vertex is this close above its owner's lowest point is its base (m). */
    baseBandM: 0.5,
    /** A hole whose perimeter is shorter is counted as small (m). */
    minHolePerimeterM: 2,
    /** One texel sample per this much surface (m²), at most this many per triangle. */
    texelSampleAreaM2: 0.25,
    maxSamplesPerTriangle: 16,
    /** A texel none of whose channels exceeds this (0..255) is black. */
    blackMax: 6,
    /** Coplanar: normals within this angle (degrees), the point within this distance of the other's plane (m). */
    overlapAngleDeg: 2,
    overlapPlaneM: 0.02,
    /** A piece this close to another piece's triangle touches it (m). */
    contactM: 0.05,
    /** The neighbour grid's cell (m), and the most cells one triangle is filed in before it is checked everywhere. */
    gridCellM: 2,
    maxCellsPerTriangle: 512,
    /** A separate piece in no footprint is its own scan component from this area (m²) and height (m). */
    scanComponentMinAreaM2: 25,
    scanComponentMinHeightM: 3,
    /** A crown crossing the line is whole when it reaches past the line this share of the way its envelope does. */
    crownWholeShare: 0.8,
    /** Failure limits. */
    maxCutAtEdgeM: 0.5,
    maxHoles: 0,
    maxBlackShare: 0.005,
    maxUntexturedShare: 0.01,
    maxOverlapM2: 1,
    maxFloatingM2: 0.5
};
export type DistrictAuditParams = typeof DISTRICT_AUDIT_PARAMS;

/** A layer to audit: its GLB as drawn (the textured twin where there is one), its provenance label, and whether its pieces are whole objects (trees). */
export interface AuditLayer {
    id: string;
    /** The GLB's bytes, read when the layer's turn comes (one layer in memory at a time). */
    read: () => Uint8Array;
    label?: string;
    /** Each connected piece (or `sbTree` node) is one object, kept whole: audited as trees, not as surfaces. */
    wholePieces?: boolean;
}

/** The district's grown edge: the disc of `radiusM` around the frame's origin, grown by these whole footprints. */
export interface DistrictEdge { radiusM: number; grownBy: DistrictFootprint[] }

export type EdgeState = 'inside' | 'outside' | 'straddles';

/** The checks of one owner of surface: a building, a scan component or the ground. */
export interface SurfaceAudit {
    id: string;
    /** A label: 'building' (a footprint), 'scan-component', 'ground'. */
    kind: string;
    /** Buildings only: the footprint against the grown edge. */
    edge?: { state: EdgeState; insideShare: number };
    /** Length of open edges lying on the disc's line (m). */
    cutAtEdgeM: number;
    triangles: number;
    areaM2: number;
    openEdgeM: number;
    nonManifoldEdges: number;
    holes: number;
    holePerimeterM: number;
    smallHoles: number;
    /** Shares of the surface whose texel is black, or that is drawn untextured; absent when no texture could be read. */
    blackShare: number;
    untexturedShare: number;
    /** Surface whose texture could not be decoded (not counted in the shares), m². */
    undecodedAreaM2: number;
    overlapAreaM2: number;
    floatingPieces: number;
    floatingAreaM2: number;
    /** Share of the surface per layer provenance label. */
    provenance: Record<string, number>;
    /** The layers holding it. */
    layers: string[];
    /** Plan middle (m), area-weighted. */
    centre?: Vec2;
    /** The checks over their limits: which (a label) and in words. */
    failures: Array<{ check: string; detail: string }>;
}

export interface TreeAudit {
    id: string;
    layer: string;
    centre: Vec2;
    /** The crown crosses the disc's line. */
    straddles: boolean;
    /** How far the geometry reaches past its centre toward the line and away from it (m), and how far its envelope says it should. */
    reachOutM: number;
    reachInM: number;
    expectedOutM: number;
    whole: boolean;
}

export interface DistrictAudit {
    version: string;
    radiusM: number;
    surfaces: SurfaceAudit[];
    trees: { count: number; straddling: number; cut: number; list: TreeAudit[] };
    layers: Array<{ id: string; triangles: number; textures: number; error?: string }>;
    ms: number;
}

// =============================================================================
// Reading a layer
// =============================================================================

interface LayerSoup {
    n: number;
    /** 9 floats per triangle, world frame. */
    pos: Float32Array;
    /** 6 floats per triangle (0 where the primitive has none). */
    uv: Float32Array;
    /** glTF texture of the base colour, -1 when drawn untextured. */
    tex: Int32Array;
    /** The `sbTree` node above the triangle's node, -1 when none. */
    tree: Int32Array;
    glb: ParsedGlb;
    world: Mat4[];
}

function mul(a: Mat4, b: Mat4): Mat4 {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
    }
    return o;
}

function trs(t: ArrayLike<number> | undefined, q: ArrayLike<number> | undefined, s: ArrayLike<number> | undefined): Mat4 {
    let x = q ? q[0] : 0, y = q ? q[1] : 0, z = q ? q[2] : 0, w = q ? q[3] : 1;
    const l = Math.hypot(x, y, z, w) || 1;
    x /= l; y /= l; z /= l; w /= l;
    const sx = s ? s[0] : 1, sy = s ? s[1] : 1, sz = s ? s[2] : 1;
    const m = new Float64Array(16);
    m[0] = (1 - 2 * (y * y + z * z)) * sx; m[1] = 2 * (x * y + z * w) * sx; m[2] = 2 * (x * z - y * w) * sx;
    m[4] = 2 * (x * y - z * w) * sy; m[5] = (1 - 2 * (x * x + z * z)) * sy; m[6] = 2 * (y * z + x * w) * sy;
    m[8] = 2 * (x * z + y * w) * sz; m[9] = 2 * (y * z - x * w) * sz; m[10] = (1 - 2 * (x * x + y * y)) * sz;
    m[12] = t ? t[0] : 0; m[13] = t ? t[1] : 0; m[14] = t ? t[2] : 0; m[15] = 1;
    return m;
}

const NORMALISED_MAX: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** Every triangle of a GLB in the world frame (node transforms and EXT_mesh_gpu_instancing applied), with its UVs and base-colour texture. */
function readLayer(bytes: Uint8Array): LayerSoup {
    const glb = parseGlbBytes(bytes);
    const json = glb.json;
    const nodes: any[] = json.nodes ?? [];
    const world = nodeWorldMatrices(json);
    const parent = new Int32Array(nodes.length).fill(-1);
    nodes.forEach((n, i) => { for (const c of n.children ?? []) parent[c] = i; });
    const treeOf = (i: number): number => { for (let k = i; k >= 0; k = parent[k]) if (nodes[k]?.extras?.sbTree) return k; return -1; };
    const cache = new Map<number, Float64Array>();
    const acc = (i: number): Float64Array => {
        let d = cache.get(i);
        if (!d) {
            d = readAccessor(glb, i).data;
            const a = json.accessors[i];
            if (a.normalized && NORMALISED_MAX[a.componentType]) { const m = NORMALISED_MAX[a.componentType]; d = d.map(v => Math.max(-1, v / m)); }
            cache.set(i, d);
        }
        return d;
    };
    type Draw = { node: number; m: Mat4; prim: any };
    const draws: Draw[] = [];
    let n = 0;
    nodes.forEach((node, ni) => {
        if (node.mesh === undefined || !json.meshes?.[node.mesh]) return;
        const inst = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
        let placements: Mat4[] = [world[ni]];
        if (inst) {
            const T = inst.TRANSLATION !== undefined ? acc(inst.TRANSLATION) : undefined;
            const R = inst.ROTATION !== undefined ? acc(inst.ROTATION) : undefined;
            const S = inst.SCALE !== undefined ? acc(inst.SCALE) : undefined;
            const count = T ? T.length / 3 : R ? R.length / 4 : S ? S.length / 3 : 0;
            placements = Array.from({ length: count }, (_, i) => mul(world[ni], trs(T?.subarray(i * 3, i * 3 + 3), R?.subarray(i * 4, i * 4 + 4), S?.subarray(i * 3, i * 3 + 3))));
        }
        for (const prim of json.meshes[node.mesh].primitives ?? []) {
            if ((prim.mode ?? 4) !== 4 || prim.attributes?.POSITION === undefined) continue;
            const count = prim.indices !== undefined ? json.accessors[prim.indices].count : json.accessors[prim.attributes.POSITION].count;
            for (const m of placements) { draws.push({ node: ni, m, prim }); n += Math.floor(count / 3); }
        }
    });
    const pos = new Float32Array(n * 9), uv = new Float32Array(n * 6), tex = new Int32Array(n), tree = new Int32Array(n);
    let t = 0;
    for (const { node, m, prim } of draws) {
        const P = acc(prim.attributes.POSITION);
        const nv = P.length / 3;
        const I = prim.indices !== undefined ? acc(prim.indices) : undefined;
        const UV = prim.attributes.TEXCOORD_0 !== undefined ? acc(prim.attributes.TEXCOORD_0) : undefined;
        const info = prim.material !== undefined ? json.materials?.[prim.material]?.pbrMetallicRoughness?.baseColorTexture : undefined;
        const ti = UV && info && (info.texCoord ?? 0) === 0 && json.textures?.[info.index] ? info.index : -1;
        const tr = treeOf(node);
        const W = new Float64Array(nv * 3);
        for (let v = 0; v < nv; v++) {
            const x = P[v * 3], y = P[v * 3 + 1], z = P[v * 3 + 2];
            W[v * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
            W[v * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            W[v * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
        }
        const count = I ? I.length : nv;
        for (let k = 0; k + 2 < count; k += 3, t++) {
            for (let c = 0; c < 3; c++) {
                const v = I ? I[k + c] : k + c;
                pos[t * 9 + c * 3] = W[v * 3]; pos[t * 9 + c * 3 + 1] = W[v * 3 + 1]; pos[t * 9 + c * 3 + 2] = W[v * 3 + 2];
                if (UV) { uv[t * 6 + c * 2] = UV[v * 2]; uv[t * 6 + c * 2 + 1] = UV[v * 2 + 1]; }
            }
            tex[t] = ti;
            tree[t] = tr;
        }
    }
    return { n, pos, uv, tex, tree, glb, world };
}

/** The base-colour image of a glTF texture, decoded, with its wrap modes; undefined when it cannot be read in memory. */
function textureImage(glb: ParsedGlb, index: number): { img: RgbaImage8; repeatS: boolean; repeatT: boolean } | undefined {
    const tex = glb.json.textures?.[index];
    const image = tex !== undefined ? glb.json.images?.[tex.source] : undefined;
    if (image?.bufferView === undefined) return undefined;
    const view = glb.json.bufferViews[image.bufferView];
    try {
        const img = decodeImageInMemory(glb.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
        const sampler = tex.sampler !== undefined ? glb.json.samplers?.[tex.sampler] : undefined;
        return { img, repeatS: (sampler?.wrapS ?? 10497) !== 33071, repeatT: (sampler?.wrapT ?? 10497) !== 33071 };
    } catch {
        return undefined;
    }
}

// =============================================================================
// Welding, edges, pieces
// =============================================================================

const nextPow2 = (v: number) => 2 ** Math.ceil(Math.log2(Math.max(2, v)));

/** Welded vertex ids, three per triangle, and how many distinct vertices there are. */
function weld(pos: Float32Array, n: number, q: number): { ids: Int32Array; vertices: number; at: Float32Array } {
    const size = nextPow2(n * 3 * 1.5), mask = size - 1;
    const slot = new Int32Array(size).fill(-1);
    const keys = new Int32Array(size * 3);
    const ids = new Int32Array(n * 3);
    const at: number[] = [];
    let count = 0;
    for (let i = 0; i < n * 3; i++) {
        const x = Math.round(pos[i * 3] / q), y = Math.round(pos[i * 3 + 1] / q), z = Math.round(pos[i * 3 + 2] / q);
        let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
        for (;;) {
            if (slot[h] < 0) {
                slot[h] = count; keys[h * 3] = x; keys[h * 3 + 1] = y; keys[h * 3 + 2] = z;
                at.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
                ids[i] = count++;
                break;
            }
            if (keys[h * 3] === x && keys[h * 3 + 1] === y && keys[h * 3 + 2] === z) { ids[i] = slot[h]; break; }
            h = (h + 1) & mask;
        }
    }
    return { ids, vertices: count, at: Float32Array.from(at) };
}

/** Each undirected edge of the welded triangles once: its ends, how many triangles use it, and the first one with its direction. */
function edgeTable(ids: Int32Array, n: number): { a: Int32Array; b: Int32Array; uses: Uint8Array; tri: Int32Array; edges: number } {
    const size = nextPow2(n * 3 * 1.5), mask = size - 1;
    const slot = new Int32Array(size).fill(-1);
    const a = new Int32Array(n * 3), b = new Int32Array(n * 3), uses = new Uint8Array(n * 3), tri = new Int32Array(n * 3);
    let edges = 0;
    for (let t = 0; t < n; t++) {
        for (let k = 0; k < 3; k++) {
            const u = ids[t * 3 + k], v = ids[t * 3 + ((k + 1) % 3)];
            if (u === v) continue;
            const lo = Math.min(u, v), hi = Math.max(u, v);
            let h = (Math.imul(lo, 73856093) ^ Math.imul(hi, 19349663)) & mask;
            for (;;) {
                const e = slot[h];
                if (e < 0) {
                    slot[h] = edges; a[edges] = u; b[edges] = v; uses[edges] = 1; tri[edges] = t; edges++;
                    break;
                }
                if (Math.min(a[e], b[e]) === lo && Math.max(a[e], b[e]) === hi) { if (uses[e] < 255) uses[e]++; break; }
                h = (h + 1) & mask;
            }
        }
    }
    return { a, b, uses, tri, edges };
}

/** Connected pieces through welded vertices: the piece of each triangle (0-based, dense). */
function pieces(ids: Int32Array, n: number, vertices: number): { piece: Int32Array; count: number } {
    const parent = new Int32Array(vertices);
    for (let i = 0; i < vertices; i++) parent[i] = i;
    const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (let t = 0; t < n; t++) {
        const r = find(ids[t * 3]);
        parent[find(ids[t * 3 + 1])] = r;
        parent[find(ids[t * 3 + 2])] = r;
    }
    const dense = new Map<number, number>();
    const piece = new Int32Array(n);
    for (let t = 0; t < n; t++) {
        const r = find(ids[t * 3]);
        let p = dense.get(r);
        if (p === undefined) dense.set(r, p = dense.size);
        piece[t] = p;
    }
    return { piece, count: dense.size };
}

// =============================================================================
// Plan geometry
// =============================================================================

function insideLoops(x: number, z: number, loops: Vec2[][]): boolean {
    for (const loop of loops) {
        let inside = false;
        for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
            const [xi, zi] = loop[i], [xj, zj] = loop[j];
            if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
        }
        if (inside) return true;
    }
    return false;
}

/** A footprint against the edge: the share of its samples (corners, sides every step, inside on the step's grid) inside it. */
export function footprintEdgeState(loops: Vec2[][], inEdge: (x: number, z: number) => boolean, stepM = DISTRICT_AUDIT_PARAMS.footprintStepM): { state: EdgeState; insideShare: number } {
    let inside = 0, total = 0;
    const test = (x: number, z: number) => { total++; if (inEdge(x, z)) inside++; };
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const loop of loops) for (let i = 0; i < loop.length; i++) {
        const [ax, az] = loop[i], [bx, bz] = loop[(i + 1) % loop.length];
        x0 = Math.min(x0, ax); z0 = Math.min(z0, az); x1 = Math.max(x1, ax); z1 = Math.max(z1, az);
        const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / stepM));
        for (let s = 0; s < steps; s++) test(ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps);
    }
    for (let x = Math.ceil(x0 / stepM) * stepM; x < x1; x += stepM) for (let z = Math.ceil(z0 / stepM) * stepM; z < z1; z += stepM) if (insideLoops(x, z, loops)) test(x, z);
    const insideShare = total ? inside / total : 0;
    return { state: inside === total ? 'inside' : inside === 0 ? 'outside' : 'straddles', insideShare };
}

// =============================================================================
// A grid of triangles, for neighbours in 3D
// =============================================================================

/** Triangles filed by every cell of their box (grown by `padM`), hashed into buckets; a triangle too large to file is checked everywhere. */
class TriangleGrid {
    private readonly start: Int32Array;
    private readonly items: Int32Array;
    private readonly big: Int32Array;
    private readonly mask: number;

    constructor(pos: Float32Array, n: number, private readonly cellM: number, padM: number, maxCells: number, include: (t: number) => boolean) {
        const buckets = nextPow2(n), mask = buckets - 1;
        this.mask = mask;
        const counts = new Int32Array(buckets + 1);
        const big: number[] = [];
        const cells = (t: number, visit: (h: number) => void): boolean => {
            let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
            for (let c = 0; c < 3; c++) {
                const x = pos[t * 9 + c * 3], y = pos[t * 9 + c * 3 + 1], z = pos[t * 9 + c * 3 + 2];
                x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z); x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
            }
            const i0 = Math.floor((x0 - padM) / cellM), i1 = Math.floor((x1 + padM) / cellM);
            const j0 = Math.floor((y0 - padM) / cellM), j1 = Math.floor((y1 + padM) / cellM);
            const k0 = Math.floor((z0 - padM) / cellM), k1 = Math.floor((z1 + padM) / cellM);
            if ((i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1) > maxCells) return false;
            for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) visit(this.hash(i, j, k));
            return true;
        };
        for (let t = 0; t < n; t++) if (include(t) && !cells(t, h => { counts[h + 1]++; })) big.push(t);
        for (let h = 0; h < buckets; h++) counts[h + 1] += counts[h];
        const items = new Int32Array(counts[buckets]);
        const fill = counts.slice(0, buckets);
        for (let t = 0; t < n; t++) if (include(t)) cells(t, h => { items[fill[h]++] = t; });
        this.start = counts;
        this.items = items;
        this.big = Int32Array.from(big);
    }

    private hash(i: number, j: number, k: number): number {
        return (Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791)) & this.mask;
    }

    /** Calls `visit` with every triangle filed at the point's cell (and every large one) until it returns true. */
    some(x: number, y: number, z: number, visit: (t: number) => boolean): boolean {
        const h = this.hash(Math.floor(x / this.cellM), Math.floor(y / this.cellM), Math.floor(z / this.cellM));
        for (let i = this.start[h]; i < this.start[h + 1]; i++) if (visit(this.items[i])) return true;
        for (let i = 0; i < this.big.length; i++) if (visit(this.big[i])) return true;
        return false;
    }
}

/** Squared distance from a point to a triangle (Ericson, Real-Time Collision Detection 5.1.5). */
function pointTriangleDist2(px: number, py: number, pz: number, P: Float32Array, t: number): number {
    const ax = P[t * 9], ay = P[t * 9 + 1], az = P[t * 9 + 2];
    const bx = P[t * 9 + 3], by = P[t * 9 + 4], bz = P[t * 9 + 5];
    const cx = P[t * 9 + 6], cy = P[t * 9 + 7], cz = P[t * 9 + 8];
    const abx = bx - ax, aby = by - ay, abz = bz - az, acx = cx - ax, acy = cy - ay, acz = cz - az;
    const apx = px - ax, apy = py - ay, apz = pz - az;
    const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
    const d = (qx: number, qy: number, qz: number) => (px - qx) ** 2 + (py - qy) ** 2 + (pz - qz) ** 2;
    if (d1 <= 0 && d2 <= 0) return d(ax, ay, az);
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) return d(bx, by, bz);
    const vc = d1 * d4 - d3 * d2;
    if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return d(ax + v * abx, ay + v * aby, az + v * abz); }
    const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
    const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
    if (d6 >= 0 && d5 <= d6) return d(cx, cy, cz);
    const vb = d5 * d2 - d1 * d6;
    if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return d(ax + w * acx, ay + w * acy, az + w * acz); }
    const va = d3 * d6 - d5 * d4;
    if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + (d5 - d6)); return d(bx + w * (cx - bx), by + w * (cy - by), bz + w * (cz - bz)); }
    const den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
    return d(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

// =============================================================================
// The audit
// =============================================================================

interface Owner {
    id: string; kind: string; edge?: { state: EdgeState; insideShare: number };
    triangles: number; area: number; cx: number; cz: number;
    openEdgeM: number; nonManifold: number; holes: number; holePerimeterM: number; smallHoles: number; cutAtEdgeM: number;
    blackArea: number; untexturedArea: number; undecodedArea: number;
    overlapArea: number; floatingPieces: number; floatingArea: number;
    provenance: Map<string, number>; layers: Set<string>;
}

const newOwner = (id: string, kind: string): Owner => ({
    id, kind, triangles: 0, area: 0, cx: 0, cz: 0, openEdgeM: 0, nonManifold: 0, holes: 0, holePerimeterM: 0, smallHoles: 0, cutAtEdgeM: 0,
    blackArea: 0, untexturedArea: 0, undecodedArea: 0, overlapArea: 0, floatingPieces: 0, floatingArea: 0, provenance: new Map(), layers: new Set()
});

/** The surface kept from every layer for the checks that look across layers (overlaps, floating pieces). */
interface Kept { pos: Float32Array[]; ids: Int32Array[]; owner: Int32Array[]; piece: Int32Array[]; largest: Int32Array[]; area: Float32Array[] }

const R2_A1 = 0.7548776662466927, R2_A2 = 0.5698402909980532;

/** Audits a district's layers against its grown edge and its buildings' footprints. Reads each layer once, in order. */
export async function auditDistrict(input: { layers: AuditLayer[]; buildings: DistrictFootprint[]; edge: DistrictEdge; signal?: AbortSignal; progress?: (m: string) => void }, P: DistrictAuditParams = DISTRICT_AUDIT_PARAMS): Promise<DistrictAudit> {
    const t0 = Date.now();
    const R = input.edge.radiusM;
    // a hair of margin: a footprint's own side, sampled, is inside its footprint however it rounds
    const grown = districtBuildingIndex(input.edge.grownBy, { marginM: 0.01, cellM: 20 });
    const inEdge = (x: number, z: number) => Math.hypot(x, z) <= R || grown(x, z) >= 0;
    const onEdgeLine = (x: number, z: number) => Math.abs(Math.hypot(x, z) - R) <= P.edgeBandM && grown(x, z) < 0;
    const ownerOfPoint = districtBuildingIndex(input.buildings, { marginM: P.buildingMarginM, cellM: 20 });

    const owners: Owner[] = input.buildings.map(b => ({ ...newOwner(b.id, 'building'), edge: footprintEdgeState(b.loops, inEdge, P.footprintStepM) }));
    const byId = new Map<string, number>();
    const ownerNamed = (id: string, kind: string): number => {
        let k = byId.get(id);
        if (k === undefined) { k = owners.length; owners.push(newOwner(id, kind)); byId.set(id, k); }
        return k;
    };
    const ground = ownerNamed('ground', 'ground');
    const kept: Kept = { pos: [], ids: [], owner: [], piece: [], largest: [], area: [] };
    const trees: TreeAudit[] = [];
    const layerReport: DistrictAudit['layers'] = [];
    const cosOverlap = Math.cos((P.overlapAngleDeg * Math.PI) / 180);
    let vertexBase = 0, pieceBase = 0;

    for (const layer of input.layers) {
        if (input.signal?.aborted) throw input.signal.reason ?? new Error('stopped');
        input.progress?.(`auditing layer ${layer.id}`);
        let soup: LayerSoup;
        try {
            soup = readLayer(layer.read());
        } catch (err) {
            layerReport.push({ id: layer.id, triangles: 0, textures: 0, error: (err as Error).message });
            continue;
        }
        const { n, pos } = soup;
        const w = weld(pos, n, P.weldM);
        const pc = pieces(w.ids, n, w.vertices);
        const area = new Float32Array(n);
        for (let t = 0; t < n; t++) {
            const ax = pos[t * 9], ay = pos[t * 9 + 1], az = pos[t * 9 + 2];
            const ux = pos[t * 9 + 3] - ax, uy = pos[t * 9 + 4] - ay, uz = pos[t * 9 + 5] - az, vx = pos[t * 9 + 6] - ax, vy = pos[t * 9 + 7] - ay, vz = pos[t * 9 + 8] - az;
            area[t] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
        }
        layerReport.push({ id: layer.id, triangles: n, textures: soup.glb.json.textures?.length ?? 0 });

        if (layer.wholePieces) {
            trees.push(...auditTrees(layer.id, soup, pc, area, R, P));
            await new Promise(r => setImmediate(r));
            continue;
        }

        // pieces: their area, height and middle, and the largest of the layer
        const pArea = new Float64Array(pc.count), pMinY = new Float64Array(pc.count).fill(Infinity), pMaxY = new Float64Array(pc.count).fill(-Infinity), pX = new Float64Array(pc.count), pZ = new Float64Array(pc.count);
        for (let t = 0; t < n; t++) {
            const p = pc.piece[t];
            pArea[p] += area[t];
            pX[p] += area[t] * (pos[t * 9] + pos[t * 9 + 3] + pos[t * 9 + 6]) / 3;
            pZ[p] += area[t] * (pos[t * 9 + 2] + pos[t * 9 + 5] + pos[t * 9 + 8]) / 3;
            for (let c = 0; c < 3; c++) { const y = pos[t * 9 + c * 3 + 1]; if (y < pMinY[p]) pMinY[p] = y; if (y > pMaxY[p]) pMaxY[p] = y; }
        }
        let largest = 0;
        for (let p = 1; p < pc.count; p++) if (pArea[p] > pArea[largest]) largest = p;
        // owners: the footprint holding the middle; else a separate structure-sized piece; else the ground
        const owner = new Int32Array(n);
        for (let t = 0; t < n; t++) {
            const b = ownerOfPoint((pos[t * 9] + pos[t * 9 + 3] + pos[t * 9 + 6]) / 3, (pos[t * 9 + 2] + pos[t * 9 + 5] + pos[t * 9 + 8]) / 3);
            if (b >= 0) { owner[t] = b; continue; }
            const p = pc.piece[t];
            if (p !== largest && pArea[p] >= P.scanComponentMinAreaM2 && pMaxY[p] - pMinY[p] >= P.scanComponentMinHeightM && pArea[p] > 0) {
                const x = pX[p] / pArea[p], z = pZ[p] / pArea[p];
                owner[t] = ownerNamed(`scan-${x >= 0 ? 'e' : 'w'}${Math.abs(Math.round(x))}-${z >= 0 ? 's' : 'n'}${Math.abs(Math.round(z))}`, 'scan-component');
            } else owner[t] = ground;
        }
        const minY = new Float64Array(owners.length).fill(Infinity);
        for (let t = 0; t < n; t++) {
            const o = owners[owner[t]];
            o.triangles++; o.area += area[t];
            o.cx += area[t] * (pos[t * 9] + pos[t * 9 + 3] + pos[t * 9 + 6]) / 3; o.cz += area[t] * (pos[t * 9 + 2] + pos[t * 9 + 5] + pos[t * 9 + 8]) / 3;
            o.layers.add(layer.id);
            const label = layer.label ?? 'unlabelled';
            o.provenance.set(label, (o.provenance.get(label) ?? 0) + area[t]);
            for (let c = 0; c < 3; c++) minY[owner[t]] = Math.min(minY[owner[t]], pos[t * 9 + c * 3 + 1]);
        }

        // open and non-manifold edges, then the loops the open ones make
        const E = edgeTable(w.ids, n);
        const at = w.at;
        const len = (e: number) => Math.hypot(at[E.a[e] * 3] - at[E.b[e] * 3], at[E.a[e] * 3 + 1] - at[E.b[e] * 3 + 1], at[E.a[e] * 3 + 2] - at[E.b[e] * 3 + 2]);
        const open: number[] = [];
        for (let e = 0; e < E.edges; e++) {
            if (E.uses[e] === 1) open.push(e);
            else if (E.uses[e] > 2) owners[owner[E.tri[e]]].nonManifold++;
        }
        const head = new Int32Array(w.vertices).fill(-1), nextOut = new Int32Array(open.length).fill(-1);
        const onLine = new Uint8Array(open.length);
        open.forEach((e, k) => {
            const o = owners[owner[E.tri[e]]], l = len(e);
            o.openEdgeM += l;
            if (onEdgeLine((at[E.a[e] * 3] + at[E.b[e] * 3]) / 2, (at[E.a[e] * 3 + 2] + at[E.b[e] * 3 + 2]) / 2)) { onLine[k] = 1; o.cutAtEdgeM += l; }
            nextOut[k] = head[E.a[e]];
            head[E.a[e]] = k;
        });
        const used = new Uint8Array(open.length);
        for (let s = 0; s < open.length; s++) {
            if (used[s]) continue;
            let perimeter = 0, lineM = 0, maxY = -Infinity;
            const share = new Map<number, number>();
            for (let k = s; k >= 0;) {
                used[k] = 1;
                const e = open[k], l = len(e);
                perimeter += l;
                if (onLine[k]) lineM += l;
                share.set(owner[E.tri[e]], (share.get(owner[E.tri[e]]) ?? 0) + l);
                maxY = Math.max(maxY, at[E.a[e] * 3 + 1], at[E.b[e] * 3 + 1]);
                // the next open edge leaving where this one ends
                let nk = head[E.b[e]];
                while (nk >= 0 && used[nk]) nk = nextOut[nk];
                k = nk;
            }
            let o = ground, best = -1;
            for (const [k, l] of share) if (l > best) { best = l; o = k; }
            if (lineM >= P.edgeLoopShare * perimeter) continue; // the edge's cut, counted above
            if (maxY - minY[o] <= P.baseBandM) continue; // the base, standing on the ground
            if (perimeter >= P.minHolePerimeterM) { owners[o].holes++; owners[o].holePerimeterM += perimeter; } else owners[o].smallHoles++;
        }

        // texels: the triangles of one texture at a time, so one image is decoded at once
        const byTexture = new Map<number, number[]>();
        for (let t = 0; t < n; t++) {
            if (soup.tex[t] < 0) { owners[owner[t]].untexturedArea += area[t]; continue; }
            const list = byTexture.get(soup.tex[t]);
            if (list) list.push(t); else byTexture.set(soup.tex[t], [t]);
        }
        for (const [ti, tris] of byTexture) sampleTexels(soup, ti, tris, area, t => owners[owner[t]], P);

        // kept for the checks across layers, with ids and pieces made unique across them
        const ids = new Int32Array(n * 3);
        for (let i = 0; i < n * 3; i++) ids[i] = w.ids[i] + vertexBase;
        const piece = new Int32Array(n);
        for (let t = 0; t < n; t++) piece[t] = pc.piece[t] + pieceBase;
        kept.pos.push(pos); kept.ids.push(ids); kept.owner.push(owner); kept.piece.push(piece); kept.largest.push(Int32Array.of(largest + pieceBase)); kept.area.push(area);
        vertexBase += w.vertices; pieceBase += pc.count;
        await new Promise(r => setImmediate(r));
    }

    if (kept.pos.length) {
        input.progress?.('auditing overlaps and floating pieces across the layers');
        acrossLayers(kept, owners, cosOverlap, P);
    }

    const surfaces = owners.map(o => finishOwner(o, P));
    const straddling = trees.filter(t => t.straddles);
    return {
        version: DISTRICT_AUDIT_VERSION, radiusM: R, surfaces,
        trees: { count: trees.length, straddling: straddling.length, cut: trees.filter(t => !t.whole).length, list: straddling },
        layers: layerReport, ms: Date.now() - t0
    };
}

/** Black texels of one texture's triangles, at each triangle's fixed sample pattern (R2 sequence folded into the triangle). */
function sampleTexels(soup: LayerSoup, ti: number, tris: number[], area: Float32Array, ownerOf: (t: number) => Owner, P: DistrictAuditParams): void {
    const image = textureImage(soup.glb, ti);
    for (const t of tris) {
        const o = ownerOf(t);
        if (!image) { o.undecodedArea += area[t]; continue; }
        const k = Math.max(1, Math.min(P.maxSamplesPerTriangle, Math.ceil(area[t] / P.texelSampleAreaM2)));
        const { img, repeatS, repeatT } = image;
        let black = 0;
        for (let j = 0; j < k; j++) {
            let u = (0.5 + j * R2_A1) % 1, v = (0.5 + j * R2_A2) % 1;
            if (u + v > 1) { u = 1 - u; v = 1 - v; }
            const b0 = 1 - u - v;
            let s = b0 * soup.uv[t * 6] + u * soup.uv[t * 6 + 2] + v * soup.uv[t * 6 + 4];
            let r = b0 * soup.uv[t * 6 + 1] + u * soup.uv[t * 6 + 3] + v * soup.uv[t * 6 + 5];
            s = repeatS ? s - Math.floor(s) : Math.min(1, Math.max(0, s));
            r = repeatT ? r - Math.floor(r) : Math.min(1, Math.max(0, r));
            const px = Math.min(img.width - 1, Math.floor(s * img.width)), py = Math.min(img.height - 1, Math.floor(r * img.height));
            const i = (py * img.width + px) * 4;
            if (img.rgba[i] <= P.blackMax && img.rgba[i + 1] <= P.blackMax && img.rgba[i + 2] <= P.blackMax) black++;
        }
        o.blackArea += (area[t] * black) / k;
    }
}

/** Overlapping coplanar surfaces and floating pieces, over every surface layer at once. */
function acrossLayers(kept: Kept, owners: Owner[], cosOverlap: number, P: DistrictAuditParams): void {
    const total = kept.pos.reduce((s, p) => s + p.length / 9, 0);
    const pos = new Float32Array(total * 9), ids = new Int32Array(total * 3), owner = new Int32Array(total), piece = new Int32Array(total), area = new Float32Array(total);
    let o = 0;
    for (let l = 0; l < kept.pos.length; l++) {
        const n = kept.pos[l].length / 9;
        pos.set(kept.pos[l], o * 9); ids.set(kept.ids[l], o * 3); owner.set(kept.owner[l], o); piece.set(kept.piece[l], o); area.set(kept.area[l], o);
        o += n;
    }
    const largest = new Set<number>(kept.largest.map(a => a[0]));
    const normal = new Float32Array(total * 3);
    for (let t = 0; t < total; t++) {
        const ux = pos[t * 9 + 3] - pos[t * 9], uy = pos[t * 9 + 4] - pos[t * 9 + 1], uz = pos[t * 9 + 5] - pos[t * 9 + 2];
        const vx = pos[t * 9 + 6] - pos[t * 9], vy = pos[t * 9 + 7] - pos[t * 9 + 1], vz = pos[t * 9 + 8] - pos[t * 9 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
        normal[t * 3] = nx / l; normal[t * 3 + 1] = ny / l; normal[t * 3 + 2] = nz / l;
    }
    const grid = new TriangleGrid(pos, total, P.gridCellM, Math.max(P.contactM, P.overlapPlaneM), P.maxCellsPerTriangle, t => area[t] > 0);
    // corners two triangles share: one or two make them neighbours (never an overlap), three the same triangle twice
    const shared = (t: number, u: number) => {
        let s = 0;
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if (ids[t * 3 + i] === ids[u * 3 + j]) { s++; break; }
        return s;
    };
    const covers = (u: number, px: number, py: number, pz: number) => {
        const nx = normal[u * 3], ny = normal[u * 3 + 1], nz = normal[u * 3 + 2];
        if (Math.abs(nx * (px - pos[u * 9]) + ny * (py - pos[u * 9 + 1]) + nz * (pz - pos[u * 9 + 2])) > P.overlapPlaneM) return false;
        // inside: the point's projection on the same side of every edge as the triangle
        for (let k = 0; k < 3; k++) {
            const a = k * 3, b = ((k + 1) % 3) * 3;
            const ex = pos[u * 9 + b] - pos[u * 9 + a], ey = pos[u * 9 + b + 1] - pos[u * 9 + a + 1], ez = pos[u * 9 + b + 2] - pos[u * 9 + a + 2];
            const qx = px - pos[u * 9 + a], qy = py - pos[u * 9 + a + 1], qz = pz - pos[u * 9 + a + 2];
            if (nx * (ey * qz - ez * qy) + ny * (ez * qx - ex * qz) + nz * (ex * qy - ey * qx) < 0) return false;
        }
        return true;
    };
    for (let t = 0; t < total; t++) {
        if (!(area[t] > 0)) continue;
        let covered = 0;
        for (let k = 0; k < 3; k++) {
            // a point two thirds of the way from each corner to the middle of the opposite side
            const wa = k === 0 ? 2 / 3 : 1 / 6, wb = k === 1 ? 2 / 3 : 1 / 6, wc = k === 2 ? 2 / 3 : 1 / 6;
            const px = wa * pos[t * 9] + wb * pos[t * 9 + 3] + wc * pos[t * 9 + 6];
            const py = wa * pos[t * 9 + 1] + wb * pos[t * 9 + 4] + wc * pos[t * 9 + 7];
            const pz = wa * pos[t * 9 + 2] + wb * pos[t * 9 + 5] + wc * pos[t * 9 + 8];
            if (grid.some(px, py, pz, u => {
                if (u === t || Math.abs(normal[t * 3] * normal[u * 3] + normal[t * 3 + 1] * normal[u * 3 + 1] + normal[t * 3 + 2] * normal[u * 3 + 2]) < cosOverlap) return false;
                const s = shared(t, u);
                return s === 3 || (s === 0 && covers(u, px, py, pz));
            })) covered++;
        }
        if (covered) owners[owner[t]].overlapArea += (area[t] * covered) / 3 / 2;
    }
    // floating: every piece but each layer's largest, lowest triangles first, until one corner touches another piece
    const byPiece = new Map<number, number[]>();
    for (let t = 0; t < total; t++) {
        if (largest.has(piece[t])) continue;
        const list = byPiece.get(piece[t]);
        if (list) list.push(t); else byPiece.set(piece[t], [t]);
    }
    const c2 = P.contactM * P.contactM;
    for (const [p, tris] of byPiece) {
        const low = (t: number) => Math.min(pos[t * 9 + 1], pos[t * 9 + 4], pos[t * 9 + 7]);
        tris.sort((a, b) => low(a) - low(b));
        let touches = false;
        for (const t of tris) {
            for (let c = 0; c < 3 && !touches; c++) {
                const px = pos[t * 9 + c * 3], py = pos[t * 9 + c * 3 + 1], pz = pos[t * 9 + c * 3 + 2];
                touches = grid.some(px, py, pz, u => piece[u] !== p && pointTriangleDist2(px, py, pz, pos, u) <= c2);
            }
            if (touches) break;
        }
        if (touches) continue;
        const counted = new Set<number>();
        for (const t of tris) {
            owners[owner[t]].floatingArea += area[t];
            if (!counted.has(owner[t])) { counted.add(owner[t]); owners[owner[t]].floatingPieces++; }
        }
    }
}

/** The trees of a layer whose pieces are kept whole: each `sbTree` node's triangles, else each piece, against the disc's line. */
function auditTrees(layerId: string, soup: LayerSoup, pc: { piece: Int32Array; count: number }, area: Float32Array, R: number, P: DistrictAuditParams): TreeAudit[] {
    const groups = new Map<string, { node: number; tris: number[] }>();
    for (let t = 0; t < soup.n; t++) {
        const key = soup.tree[t] >= 0 ? `n${soup.tree[t]}` : `p${pc.piece[t]}`;
        const g = groups.get(key);
        if (g) g.tris.push(t); else groups.set(key, { node: soup.tree[t], tris: [t] });
    }
    const out: TreeAudit[] = [];
    for (const [key, g] of groups) {
        const P3 = soup.pos;
        let a = 0, cx = 0, cz = 0;
        for (const t of g.tris) { a += area[t]; cx += area[t] * (P3[t * 9] + P3[t * 9 + 3] + P3[t * 9 + 6]) / 3; cz += area[t] * (P3[t * 9 + 2] + P3[t * 9 + 5] + P3[t * 9 + 8]) / 3; }
        if (a > 0) { cx /= a; cz /= a; }
        // the crown's envelope, when the tree carries one (in the tree node's frame)
        let envelope: number | undefined;
        const crown = g.node >= 0 ? soup.glb.json.nodes[g.node]?.extras?.sbTree?.crown : undefined;
        if (crown && Array.isArray(crown.centre) && Array.isArray(crown.radii)) {
            const m = soup.world[g.node];
            const [x, y, z] = crown.centre;
            cx = m[0] * x + m[4] * y + m[8] * z + m[12];
            cz = m[2] * x + m[6] * y + m[10] * z + m[14];
            envelope = Math.max(crown.radii[0], crown.radii[2]) * Math.hypot(m[0], m[1], m[2]);
        }
        const rc = Math.hypot(cx, cz);
        const ux = rc > 1e-6 ? cx / rc : 1, uz = rc > 1e-6 ? cz / rc : 0;
        let lo = Infinity, hi = -Infinity;
        for (const t of g.tris) for (let c = 0; c < 3; c++) {
            const s = P3[t * 9 + c * 3] * ux + P3[t * 9 + c * 3 + 2] * uz;
            if (s < lo) lo = s;
            if (s > hi) hi = s;
        }
        const reachOutM = hi - rc, reachInM = rc - lo;
        const expectedOutM = envelope ?? reachInM;
        const straddles = rc - Math.max(reachInM, expectedOutM) < R && rc + expectedOutM > R;
        const whole = !straddles || (rc + reachOutM > R + 1e-6 && reachOutM >= P.crownWholeShare * expectedOutM);
        out.push({ id: `${layerId}:${key}`, layer: layerId, centre: [cx, cz], straddles, reachOutM, reachInM, expectedOutM, whole });
    }
    return out;
}

function finishOwner(o: Owner, P: DistrictAuditParams): SurfaceAudit {
    const drawn = o.area - o.undecodedArea;
    const blackShare = drawn > 0 ? o.blackArea / drawn : 0, untexturedShare = drawn > 0 ? o.untexturedArea / drawn : 0;
    const failures: SurfaceAudit['failures'] = [];
    const fail = (check: string, detail: string) => failures.push({ check, detail });
    const m = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
    const pct = (v: number) => `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`;
    if (o.edge?.state === 'straddles') fail('edge-straddle', `straddles the district's edge (${pct(o.edge.insideShare)} of its footprint inside)`);
    if (o.kind === 'building' && o.edge?.state === 'inside' && !o.triangles) fail('missing', 'no geometry in the district');
    if (o.kind !== 'ground' && o.cutAtEdgeM > P.maxCutAtEdgeM) fail('edge-cut', `cut at the district's edge (${m(o.cutAtEdgeM)} m of open edge along it)`);
    if (o.holes > P.maxHoles) fail('holes', `${o.holes} hole${o.holes === 1 ? '' : 's'} (${m(o.holePerimeterM)} m of edge around them)`);
    if (blackShare > P.maxBlackShare) fail('black-texels', `${pct(blackShare)} of its surface black`);
    if (untexturedShare > P.maxUntexturedShare) fail('untextured', `${pct(untexturedShare)} of its surface untextured`);
    if (o.overlapArea > P.maxOverlapM2) fail('overlap', `${m(o.overlapArea)} m² of overlapping coplanar surface`);
    if (o.floatingArea > P.maxFloatingM2) fail('floating', `${o.floatingPieces} floating piece${o.floatingPieces === 1 ? '' : 's'} (${m(o.floatingArea)} m²)`);
    const provenance: Record<string, number> = {};
    for (const [label, a] of o.provenance) provenance[label] = o.area > 0 ? a / o.area : 0;
    return {
        id: o.id, kind: o.kind, ...(o.edge ? { edge: o.edge } : {}), cutAtEdgeM: o.cutAtEdgeM, triangles: o.triangles, areaM2: o.area,
        openEdgeM: o.openEdgeM, nonManifoldEdges: o.nonManifold, holes: o.holes, holePerimeterM: o.holePerimeterM, smallHoles: o.smallHoles,
        blackShare, untexturedShare, undecodedAreaM2: o.undecodedArea, overlapAreaM2: o.overlapArea, floatingPieces: o.floatingPieces, floatingAreaM2: o.floatingArea,
        provenance, layers: [...o.layers], ...(o.area > 0 ? { centre: [o.cx / o.area, o.cz / o.area] as Vec2 } : {}), failures
    };
}
