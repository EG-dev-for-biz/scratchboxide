/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Small staged-location GLBs built to the contracts (§3.5), for viewport tests before the native staged writer lands:
 * node extras (`extras.sb`, validated with validateContract), `_REVEAL` (VEC2 UNSIGNED_SHORT normalised), `_DISP`
 * (VEC3 float), tile_refine's `_RECTIFY_DISPLACEMENT` / `_PROUD_BLOCK` / `_RELIEF_HEIGHT`, LINES with COLOR_0, and the
 * L1 download-order sidecar. The geometry is a synthetic segmental-arch structure (piers, a segmental vault, a cornice
 * band, an attic) on a ground patch with a few trees: a noisy "scan" split into leaf tiles, its clean remesh, the
 * fitted surfaces with outlines, coffers, a molding and a relief panel, and SB-Veggie-style trees whose `_REVEAL.y`
 * follows each tree's node creation order. Each layer's build order is the order its generator would produce.
 */

import { validateContract, PROVENANCE, type ProvenanceRecord, type StagedBuildState, type StagedLayer, type StagedNodeExtras, type StageSummary, type DegradationRecord } from '../../src/common/spatial/staged-location-contracts';

type V3 = [number, number, number];

export interface PrimSpec {
    /** 4 = TRIANGLES, 1 = LINES. */
    mode: 4 | 1;
    positions: number[];
    normals?: number[];
    colors?: number[];
    indices?: number[];
    /** Custom attributes by glTF name (with the leading underscore). */
    attributes?: Record<string, { itemSize: 1 | 2 | 3; data: number[]; u16n?: boolean }>;
}

export interface NodeSpec {
    name: string;
    prims: PrimSpec[];
    extras?: unknown;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Deterministic value noise in [-1, 1]. */
export function noise3(x: number, y: number, z: number): number {
    const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
    const t = Math.sin(x * 3.1 + z * 1.7) * 0.5 + Math.sin(y * 2.3 + x * 0.9) * 0.5;
    return 0.6 * (s - Math.floor(s) - 0.5) * 2 * 0.5 + 0.5 * t;
}

/** Accumulates one triangle primitive with optional per-vertex attributes. */
export class MeshBuilder {
    positions: number[] = [];
    normals: number[] = [];
    indices: number[] = [];
    attrs: Record<string, { itemSize: 1 | 2 | 3; data: number[]; u16n?: boolean }> = {};

    constructor(attrSpec: Record<string, { itemSize: 1 | 2 | 3; u16n?: boolean }> = {}) {
        for (const [k, v] of Object.entries(attrSpec)) this.attrs[k] = { ...v, data: [] };
    }

    get vertexCount(): number { return this.positions.length / 3; }

    vertex(p: V3, n: V3, attr: Record<string, number | number[]> = {}): number {
        this.positions.push(...p);
        this.normals.push(...n);
        for (const [k, a] of Object.entries(this.attrs)) {
            const v = attr[k];
            const vals = v === undefined ? new Array(a.itemSize).fill(0) : Array.isArray(v) ? v : [v];
            a.data.push(...vals);
        }
        return this.vertexCount - 1;
    }

    /**
     * A grid patch origin + s·u + t·v (s, t ∈ [0, 1]), `nu` × `nv` cells, facing `n`. `offset(s, t)` displaces along
     * n; `attr(s, t, p)` gives the vertex's attributes. Faces whose `keep(s, t)` is false are skipped (openings).
     */
    grid(origin: V3, u: V3, v: V3, nu: number, nv: number, opts: { offset?: (s: number, t: number, p: V3) => number; attr?: (s: number, t: number, p: V3) => Record<string, number | number[]>; keep?: (s: number, t: number) => boolean; flip?: boolean } = {}): void {
        const n = norm(opts.flip ? cross(v, u) : cross(u, v));
        const base = this.vertexCount;
        for (let j = 0; j <= nv; j++) {
            for (let i = 0; i <= nu; i++) {
                const s = i / nu, t = j / nv;
                let p = add(origin, add(mul(u, s), mul(v, t)));
                const off = opts.offset?.(s, t, p) ?? 0;
                p = add(p, mul(n, off));
                this.vertex(p, n, opts.attr?.(s, t, p) ?? {});
            }
        }
        for (let j = 0; j < nv; j++) {
            for (let i = 0; i < nu; i++) {
                if (opts.keep && !opts.keep((i + 0.5) / nu, (j + 0.5) / nv)) continue;
                const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
                if (opts.flip) this.indices.push(a, c, b, b, c, d);
                else this.indices.push(a, b, c, b, d, c);
            }
        }
    }

    /** An axis-aligned box with every face gridded at about `cell` metres. */
    box(min: V3, max: V3, cell: number, opts: { offset?: (s: number, t: number, p: V3) => number; attr?: (s: number, t: number, p: V3) => Record<string, number | number[]>; skipBottom?: boolean } = {}): void {
        const [x0, y0, z0] = min, [x1, y1, z1] = max;
        const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
        const c = (d: number) => Math.max(1, Math.round(d / cell));
        this.grid([x0, y0, z1], [dx, 0, 0], [0, dy, 0], c(dx), c(dy), opts);           // +z (south face)
        this.grid([x1, y0, z0], [-dx, 0, 0], [0, dy, 0], c(dx), c(dy), opts);          // -z
        this.grid([x1, y0, z1], [0, 0, -dz], [0, dy, 0], c(dz), c(dy), opts);          // +x
        this.grid([x0, y0, z0], [0, 0, dz], [0, dy, 0], c(dz), c(dy), opts);           // -x
        this.grid([x0, y1, z1], [dx, 0, 0], [0, 0, -dz], c(dx), c(dz), opts);          // top
        if (!opts.skipBottom) this.grid([x0, y0, z0], [dx, 0, 0], [0, 0, dz], c(dx), c(dz), opts); // bottom
    }

    /** A tube along `path` with radius per point and `sides` sides; `attr(i, j)` per ring point. */
    tube(path: V3[], radius: (i: number) => number, sides: number, attr?: (i: number, j: number) => Record<string, number | number[]>): void {
        const base = this.vertexCount;
        for (let i = 0; i < path.length; i++) {
            const tdir = norm(sub(path[Math.min(path.length - 1, i + 1)], path[Math.max(0, i - 1)]));
            const ref: V3 = Math.abs(tdir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
            const a = norm(cross(tdir, ref)), b = norm(cross(tdir, a));
            for (let j = 0; j < sides; j++) {
                const th = (j / sides) * Math.PI * 2;
                const n = add(mul(a, Math.cos(th)), mul(b, Math.sin(th)));
                this.vertex(add(path[i], mul(n, radius(i))), n, attr?.(i, j) ?? {});
            }
        }
        for (let i = 0; i < path.length - 1; i++) {
            for (let j = 0; j < sides; j++) {
                const a = base + i * sides + j, b = base + i * sides + ((j + 1) % sides);
                const c = a + sides, d = b + sides;
                this.indices.push(a, b, c, b, d, c);   // outward: (along the path) × (around the ring) points out
            }
        }
    }

    prim(): PrimSpec {
        return { mode: 4, positions: this.positions, normals: this.normals, indices: this.indices, attributes: this.attrs };
    }
}

/** Segmental arch (rise below a semicircle): height of the soffit at x between the piers. */
export const ARCH = { span: 9.8, springY: 9, crownY: 12.6, depth: 8, pierW: 3.8, atticY0: 13.6, atticY1: 17, groundHalf: 26 } as const;
export function soffitY(x: number): number {
    const half = ARCH.span / 2, rise = ARCH.crownY - ARCH.springY;
    const R = (half * half + rise * rise) / (2 * rise);
    const cy = ARCH.crownY - R;
    return cy + Math.sqrt(Math.max(0, R * R - x * x));
}

/** The structure's surfaces in their fitter build order: one entry per fitted surface. */
interface SurfaceDef { id: string; primitiveId: string; build: (m: MeshBuilder, opts: SurfaceBuildOpts) => void; rmsM: number; unobserved?: boolean }
interface SurfaceBuildOpts { cell: number; offset?: (s: number, t: number, p: V3) => number; attr?: (s: number, t: number, p: V3) => Record<string, number | number[]> }

const H = ARCH.span / 2;
const P0 = H + ARCH.pierW;
const Z = ARCH.depth / 2;

function surfaces(): SurfaceDef[] {
    const pier = (sign: 1 | -1, id: string, prim: string, rms: number): SurfaceDef => ({
        id, primitiveId: prim, rmsM: rms,
        build: (m, o) => m.box(sign < 0 ? [-P0, 0, -Z] : [H, 0, -Z], sign < 0 ? [-H, ARCH.atticY0, Z] : [P0, ARCH.atticY0, Z], o.cell, { offset: o.offset, attr: o.attr, skipBottom: true })
    });
    return [
        { id: 's-ground', primitiveId: 'p-ground', rmsM: 0.012, build: (m, o) => m.grid([-ARCH.groundHalf, 0, ARCH.groundHalf], [ARCH.groundHalf * 2, 0, 0], [0, 0, -ARCH.groundHalf * 2], Math.round(ARCH.groundHalf * 2 / o.cell), Math.round(ARCH.groundHalf * 2 / o.cell), { offset: o.offset, attr: o.attr, keep: (s, t) => { const x = -ARCH.groundHalf + s * 2 * ARCH.groundHalf, z = ARCH.groundHalf - t * 2 * ARCH.groundHalf; return !(Math.abs(x) < P0 && Math.abs(z) < Z); } }) },
        pier(-1, 's-pier-w', 'p-pier-w', 0.028),
        pier(1, 's-pier-e', 'p-pier-e', 0.031),
        {
            id: 's-soffit', primitiveId: 'p-vault', rmsM: 0.044,
            build: (m, o) => {
                const nu = Math.max(4, Math.round(ARCH.span / o.cell)), nv = Math.max(2, Math.round(ARCH.depth / o.cell));
                const base = m.vertexCount;
                for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
                    const x = -H + (i / nu) * ARCH.span, z = -Z + (j / nv) * ARCH.depth;
                    const y = soffitY(x);
                    const p: V3 = [x, y, z];
                    const n = norm([x / 6, -1, 0]);
                    const off = o.offset?.(i / nu, j / nv, p) ?? 0;
                    m.vertex(add(p, mul(n, off)), n, o.attr?.(i / nu, j / nv, p) ?? {});
                }
                for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
                    const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
                    m.indices.push(a, b, c, b, d, c);   // facing down, out of the vault
                }
            }
        },
        ...([1, -1] as const).map((side): SurfaceDef => ({
            id: side > 0 ? 's-spandrel-s' : 's-spandrel-n', primitiveId: 'p-vault', rmsM: side > 0 ? 0.036 : 0.052, unobserved: side < 0,
            build: (m, o) => {
                const nu = Math.max(4, Math.round(ARCH.span / o.cell));
                const nv = Math.max(2, Math.round((ARCH.atticY0 - ARCH.springY) / o.cell));
                const base = m.vertexCount;
                const n: V3 = [0, 0, side];
                for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
                    const x = -H + (i / nu) * ARCH.span;
                    const y0 = soffitY(x);
                    const y = y0 + (j / nv) * (ARCH.atticY0 - y0);
                    const p: V3 = [x, y, side * Z];
                    const off = o.offset?.(i / nu, j / nv, p) ?? 0;
                    m.vertex(add(p, mul(n, off)), n, o.attr?.(i / nu, j / nv, p) ?? {});
                }
                for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
                    const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
                    if (side > 0) m.indices.push(a, b, c, b, d, c); else m.indices.push(a, c, b, b, c, d);
                }
            }
        })),
        { id: 's-cornice', primitiveId: 'p-cornice', rmsM: 0.022, build: (m, o) => m.box([-P0 - 0.5, ARCH.atticY0 - 0.2, -Z - 0.5], [P0 + 0.5, ARCH.atticY0 + 0.4, Z + 0.5], o.cell / 2, { offset: o.offset, attr: o.attr }) },
        { id: 's-attic', primitiveId: 'p-attic', rmsM: 0.026, build: (m, o) => m.box([-P0, ARCH.atticY0 + 0.4, -Z], [P0, ARCH.atticY1, Z], o.cell, { offset: o.offset, attr: o.attr, skipBottom: true }) }
    ];
}

/** Trees: trunk then branches in creation order (what space colonisation appends), at measured crown positions. */
interface TreeDef { crownId: number; at: V3; height: number; spread: number }
export const TREES: TreeDef[] = [
    { crownId: 11, at: [-16, 0, 13], height: 9, spread: 4.2 },
    { crownId: 12, at: [15, 0, 14], height: 10, spread: 4.8 },
    { crownId: 17, at: [-18, 0, -12], height: 8, spread: 3.8 },
    { crownId: 19, at: [17, 0, -13], height: 9.5, spread: 4.4 },
    { crownId: 23, at: [0, 0, 19], height: 7.5, spread: 3.5 }
];
/** A crown strip could not regrow: kept as scanned, outlined by a ring. */
export const KEPT_CROWN: TreeDef = { crownId: 31, at: [-2, 0, -19], height: 8, spread: 4 };

interface Segment { from: V3; to: V3; r0: number; r1: number; created: number }

function growTree(t: TreeDef): Segment[] {
    const segs: Segment[] = [];
    let created = 0;
    const trunkTop: V3 = [t.at[0], t.height * 0.42, t.at[2]];
    segs.push({ from: t.at, to: trunkTop, r0: 0.32, r1: 0.24, created: created++ });
    // Scaffolds, then each iteration's new nodes: breadth-first, the order the colonisation appends them.
    let tips: Array<{ p: V3; dir: V3; r: number }> = [];
    const scaffolds = 4;
    for (let k = 0; k < scaffolds; k++) {
        const a = (k / scaffolds) * Math.PI * 2 + t.crownId;
        const dir = norm([Math.cos(a), 1.1, Math.sin(a)]);
        const to = add(trunkTop, mul(dir, t.spread * 0.45));
        segs.push({ from: trunkTop, to, r0: 0.18, r1: 0.12, created: created++ });
        tips.push({ p: to, dir, r: 0.12 });
    }
    for (let gen = 0; gen < 3; gen++) {
        const next: typeof tips = [];
        for (const tip of tips) {
            for (let b = 0; b < 2; b++) {
                const jitter: V3 = [noise3(tip.p[0], gen, b) * 0.8, 0.5 + 0.3 * b, noise3(tip.p[2], b, gen) * 0.8];
                const dir = norm(add(tip.dir, jitter));
                const to = add(tip.p, mul(dir, t.spread * (0.32 - gen * 0.06)));
                const r1 = tip.r * 0.62;
                segs.push({ from: tip.p, to, r0: tip.r, r1, created: created++ });
                next.push({ p: to, dir, r: r1 });
            }
        }
        tips = next;
    }
    return segs;
}

function nodeExtras(sb: Omit<StagedNodeExtras['sb'], 'schema'>): StagedNodeExtras {
    const extras: StagedNodeExtras = { sb: { schema: 'scratchbox.staged-node/2', ...sb } };
    const problems = validateContract('StagedNodeExtras', extras);
    if (problems.length > 0) throw new Error(`fixture node extras violate the contract: ${problems.join('; ')}`);
    return extras;
}

function measured(label: string, method: string, extra: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
    return { label, measuredGeometry: true, method, sources: [{ kind: 'stage-output', id: `fixture:${label}` }], ...extra };
}

function inferred(label: string, confidence: number, method: string): ProvenanceRecord {
    return { label, measuredGeometry: false, method, confidence, sources: [{ kind: 'tile-ortho', id: 'ortho:fixture' }] };
}

const cividisStops: V3[] = [[0, 32, 76], [60, 74, 107], [117, 117, 117], [176, 165, 114], [255, 233, 69]];
function cividis01(t: number): V3 {
    const x = Math.min(1, Math.max(0, t)) * (cividisStops.length - 1);
    const i = Math.min(cividisStops.length - 2, Math.floor(x)), k = x - i;
    return [0, 1, 2].map(c => (cividisStops[i][c] + (cividisStops[i + 1][c] - cividisStops[i][c]) * k) / 255) as V3;
}

export interface StagedFixtureGlbs {
    /** Layer GLB bytes by layer id (l1 … l5, l5x). */
    glbs: Record<string, Buffer>;
    /** L1 download order sidecar {leafId: rank}. */
    sidecar: Record<string, number>;
    counts: Record<string, { vertices: number; triangles: number; nodes: number }>;
}

const SCAN_NOISE_M = 0.09;

/** Every layer of the synthetic staged build. */
export function buildStagedFixture(): StagedFixtureGlbs {
    const glbs: Record<string, Buffer> = {};
    const counts: StagedFixtureGlbs['counts'] = {};
    const surfs = surfaces();
    const scanOffset = (_s: number, _t: number, p: V3) => SCAN_NOISE_M * noise3(p[0] * 0.7, p[1] * 0.7, p[2] * 0.7);

    // L1 tiles: the noisy scan (structure, ground, scanned canopy), split into a 3 × 3 grid of leaf tiles.
    const scan = new MeshBuilder();
    for (const s of surfs) s.build(scan, { cell: 0.7, offset: scanOffset });
    for (const t of [...TREES, KEPT_CROWN]) blob(scan, [t.at[0], t.height * 0.68, t.at[2]], t.spread, t.height * 0.36);
    const leaves = splitIntoLeaves(scan, 3, ARCH.groundHalf);
    const leafNodes: NodeSpec[] = leaves.map((leaf, i) => ({
        name: leaf.id,
        prims: [leaf.prim],
        extras: nodeExtras({
            stage: 'tiles', provenance: measured(PROVENANCE.asScanned, 'Google Photorealistic 3D Tiles, leaf LOD'),
            buildOrder: i, buildCount: leaves.length, revealKind: 'appear',
            reveal: { attribute: null, displacement: null, durationShare: 1 / leaves.length },
            ids: { leafId: leaf.id }, counts: { vertices: leaf.prim.positions.length / 3, triangles: (leaf.prim.indices?.length ?? 0) / 3 }
        })
    }));
    // The download order is not the build (distance) order: leaves arrive as the network delivers them.
    const sidecar: Record<string, number> = {};
    const arrival = [4, 1, 7, 3, 5, 0, 8, 2, 6];
    leaves.forEach((leaf, i) => { sidecar[leaf.id] = arrival.indexOf(i) >= 0 ? arrival.indexOf(i) : i; });
    glbs.l1 = writeGlb(leafNodes, { sceneExtras: rootExtras('tiles', '5d6c8812') });

    // L2 remesh: tile_refine's output has no node extras, one node, and per-vertex provenance attributes.
    const remesh = new MeshBuilder({ _RECTIFY_DISPLACEMENT: { itemSize: 1 }, _PROUD_BLOCK: { itemSize: 1 }, _RELIEF_HEIGHT: { itemSize: 1 } });
    for (const s of surfs) {
        s.build(remesh, {
            cell: 0.7,
            offset: (_s, _t, p) => (isReliefPanel(p) ? -0.06 : 0),
            attr: (_s, _t, p) => ({
                _RECTIFY_DISPLACEMENT: p[1] < 0.05 ? 0.0004 : Math.abs(scanOffset(0, 0, p)),
                _PROUD_BLOCK: isKeystone(p) ? 1 : isSnappedBlock(p) ? 2 : 0,
                _RELIEF_HEIGHT: isReliefPanel(p) ? -0.06 : 0
            })
        });
    }
    glbs.l2 = writeGlb([{ name: 'remesh', prims: [remesh.prim()] }], {
        assetExtras: {
            scratchbox: {
                attributes: {
                    _RECTIFY_DISPLACEMENT: 'm the scan surface was moved by rectify and facade flatten',
                    _PROUD_BLOCK: '1 = block kept as scanned, 2 = block snapped at its own level, 0 = not a block',
                    _RELIEF_HEIGHT: 'm along the facade normal carved by photometric relief (inferred)'
                },
                relief: { provenance: 'inferred', source: 'photometric relief', attribute: '_RELIEF_HEIGHT', units: 'm', displacedVertices: 0, maxAbsHeight_m: 0.06 }
            }
        }
    });

    // L3a outlines: one LINES primitive per fitted primitive, COLOR_0 = local fit error (cividis 0–10 cm).
    const prims = [...new Set(surfs.map(s => s.primitiveId))];
    const outlineNodes: NodeSpec[] = prims.map((pid, rank) => {
        const own = surfs.filter(s => s.primitiveId === pid);
        const edges = new MeshBuilder();
        for (const s of own) s.build(edges, { cell: 3 });
        const lines = trianglesToEdges(edges, own[0].rmsM);
        const x = rank / Math.max(1, prims.length - 1);
        lines.attributes = { _REVEAL: { itemSize: 2, u16n: true, data: new Array(lines.positions.length / 3).fill(0).flatMap(() => [x, 0]) } };
        return {
            name: `outline-${pid}`, prims: [lines],
            extras: nodeExtras({
                stage: 'fit', provenance: measured(PROVENANCE.fitted, 'scan_fit outlines'), buildOrder: rank, buildCount: prims.length, revealKind: 'outline',
                reveal: { attribute: '_REVEAL', displacement: null, durationShare: 1 },
                ids: { primitiveId: pid }, counts: { vertices: lines.positions.length / 3, triangles: 0, lines: lines.positions.length / 6 }
            })
        };
    });
    glbs.l3a = writeGlb(outlineNodes, { sceneExtras: rootExtras('fit', '7c1e04aa') });

    // L3b fitted body: one node per fitted surface, in the fitter's order.
    const bodyNodes: NodeSpec[] = surfs.map((s, i) => {
        const m = new MeshBuilder();
        s.build(m, { cell: 1.0 });
        const residual = { rmsM: s.rmsM, p50M: s.rmsM * 0.8, p95M: s.rmsM * 2, maxM: s.rmsM * 3, samples: 400, areaM2: 40 };
        const provenance = s.unobserved
            ? { label: PROVENANCE.fittedUnobserved, measuredGeometry: false, method: 'scan_fit: face placed without scan samples', confidence: 0.35, sources: [{ kind: 'stage-output', id: 'fit:7c1e04aa' }] }
            : measured(PROVENANCE.fitted, 'scan_fit: region-grown plane, LS refine', { residual });
        return {
            name: s.id, prims: [m.prim()],
            extras: nodeExtras({
                stage: 'fit', provenance, buildOrder: i, buildCount: surfs.length, revealKind: 'crossfade',
                reveal: { attribute: null, displacement: null, durationShare: 1 / surfs.length },
                ids: { surfaceId: s.id, primitiveId: s.primitiveId }, fitError: residual,
                counts: { vertices: m.vertexCount, triangles: m.indices.length / 3 }
            })
        };
    });
    glbs.l3b = writeGlb(bodyNodes, { sceneExtras: rootExtras('fit', '7c1e04aa') });

    glbs.l4 = writeGlb(detailNodes(), { sceneExtras: rootExtras('detail', 'b3d1e9c0') });

    // L5 trees: one node per tree, _REVEAL.x = plant rank, .y = node creation index; a ring for the kept crown.
    const treeNodes: NodeSpec[] = TREES.map((t, rank) => {
        const m = new MeshBuilder({ _REVEAL: { itemSize: 2, u16n: true } });
        const segs = growTree(t);
        const x = rank / Math.max(1, TREES.length - 1);
        for (const sg of segs) {
            const y = sg.created / Math.max(1, segs.length - 1);
            m.tube([sg.from, sg.to], i => (i === 0 ? sg.r0 : sg.r1), 6, () => ({ _REVEAL: [x, y] }));
        }
        return {
            name: `tree-${t.crownId}`, prims: [m.prim()],
            extras: nodeExtras({
                stage: 'trees',
                provenance: measured(PROVENANCE.grownToMeasuredCrown, 'SB-Veggie space colonisation grown to the measured crown', { inferred: { crownBaseRatio: 0.32, trunkRadiusM: 0.24 } }),
                buildOrder: rank, buildCount: TREES.length, revealKind: 'grow',
                reveal: { attribute: '_REVEAL', displacement: null, durationShare: 1 },
                ids: { crownId: t.crownId }, counts: { vertices: m.vertexCount, triangles: m.indices.length / 3 }
            })
        };
    });
    const ring = ringLines(KEPT_CROWN.at, KEPT_CROWN.spread, 0.15, 48);
    treeNodes.push({
        name: `kept-crown-${KEPT_CROWN.crownId}`, prims: [ring],
        extras: nodeExtras({
            stage: 'trees', provenance: measured(PROVENANCE.asScanned, 'crown kept as scanned: strip could not regrow it'),
            buildOrder: TREES.length, buildCount: TREES.length + 1, revealKind: 'outline',
            reveal: { attribute: null, displacement: null, durationShare: 1 / (TREES.length + 1) },
            ids: { crownId: KEPT_CROWN.crownId }, counts: { vertices: ring.positions.length / 3, triangles: 0, lines: ring.positions.length / 6 }
        })
    });
    glbs.l5 = writeGlb(treeNodes, { sceneExtras: rootExtras('trees', '788091ab') });

    // L5x: a failed tree stage puts the scanned crowns back, as scanned.
    const scanned = new MeshBuilder();
    for (const t of TREES) blob(scanned, [t.at[0], t.height * 0.68, t.at[2]], t.spread, t.height * 0.36);
    glbs.l5x = writeGlb([{
        name: 'scanned-crowns', prims: [scanned.prim()],
        extras: nodeExtras({
            stage: 'trees', provenance: measured(PROVENANCE.asScanned, 'the scanned crowns strip removed, put back as downloaded'),
            buildOrder: 0, buildCount: 1, revealKind: 'appear', reveal: { attribute: null, displacement: null, durationShare: 1 },
            ids: {}, counts: { vertices: scanned.vertexCount, triangles: scanned.indices.length / 3 }
        })
    }], { sceneExtras: rootExtras('trees', '788091ab') });

    for (const [k, buf] of Object.entries(glbs)) counts[k] = glbCounts(buf);
    return { glbs, sidecar, counts };
}

function isKeystone(p: V3): boolean { return Math.abs(p[0]) < 0.7 && p[1] > ARCH.crownY - 0.2 && p[1] < ARCH.atticY0 && Math.abs(Math.abs(p[2]) - Z) < 0.05; }
function isSnappedBlock(p: V3): boolean { return p[1] > ARCH.atticY1 - 0.05 && Math.abs(p[0] - 4) < 1.2 && Math.abs(p[2]) < 1.2; }
function isReliefPanel(p: V3): boolean { return Math.abs(p[2] - Z) < 0.05 && Math.abs(p[0]) < 4 && p[1] > ARCH.atticY0 + 1 && p[1] < ARCH.atticY1 - 0.8; }

function rootExtras(stage: string, key: string): unknown {
    const extras = { sb: { schema: 'scratchbox.staged-glb/2', stage, stageKey: key, buildingId: '3fa9c2d1e07b5a44', frame: 'tile-enu' } };
    const problems = validateContract('StagedGlbRootExtras', extras);
    if (problems.length > 0) throw new Error(problems.join('; '));
    return extras;
}

/** A noisy crown blob (the scan's canopy). */
function blob(m: MeshBuilder, c: V3, r: number, ry: number): void {
    const nu = 16, nv = 10;
    const base = m.vertexCount;
    for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
        const th = (i / nu) * Math.PI * 2, ph = (j / nv) * Math.PI;
        const n: V3 = [Math.sin(ph) * Math.cos(th), Math.cos(ph), Math.sin(ph) * Math.sin(th)];
        const k = 1 + 0.18 * noise3(n[0] * 3 + c[0], n[1] * 3, n[2] * 3 + c[2]);
        m.vertex([c[0] + n[0] * r * k, c[1] + n[1] * ry * k, c[2] + n[2] * r * k], n);
    }
    for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
        const a = base + j * (nu + 1) + i, b = a + 1, cc = a + nu + 1, d = cc + 1;
        m.indices.push(a, b, cc, b, d, cc);
    }
}

/** Splits a triangle soup into k × k leaf tiles by triangle centroid; leaves ordered by distance from the anchor. */
function splitIntoLeaves(m: MeshBuilder, k: number, half: number): Array<{ id: string; prim: PrimSpec }> {
    const cells: Array<{ id: string; d: number; b: MeshBuilder; map: Map<number, number> }> = [];
    for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) {
        const cx = -half + (c + 0.5) * (2 * half / k), cz = -half + (r + 0.5) * (2 * half / k);
        cells.push({ id: `leaf-${r}${c}`, d: Math.hypot(cx, cz), b: new MeshBuilder(), map: new Map() });
    }
    for (let t = 0; t < m.indices.length; t += 3) {
        const ids = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        const cx = ids.reduce((a, i) => a + m.positions[i * 3], 0) / 3;
        const cz = ids.reduce((a, i) => a + m.positions[i * 3 + 2], 0) / 3;
        const c = Math.min(k - 1, Math.max(0, Math.floor((cx + half) / (2 * half / k))));
        const r = Math.min(k - 1, Math.max(0, Math.floor((cz + half) / (2 * half / k))));
        const cell = cells[r * k + c];
        for (const i of ids) {
            let j = cell.map.get(i);
            if (j === undefined) {
                j = cell.b.vertex([m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]], [m.normals[i * 3], m.normals[i * 3 + 1], m.normals[i * 3 + 2]]);
                cell.map.set(i, j);
            }
            cell.b.indices.push(j);
        }
    }
    return cells.filter(c => c.b.indices.length > 0).sort((a, b) => a.d - b.d).map(c => ({ id: c.id, prim: c.b.prim() }));
}

/** Feature edges of a gridded surface (its boundary) as LINES coloured by a local fit error. */
function trianglesToEdges(m: MeshBuilder, rms: number): PrimSpec {
    const count = new Map<string, number>();
    const key = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
    for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
        for (const [x, y] of [[a, b], [b, c], [c, a]]) count.set(key(x, y), (count.get(key(x, y)) ?? 0) + 1);
    }
    const positions: number[] = [];
    const colors: number[] = [];
    for (const [k, n] of count) {
        if (n !== 1) continue;
        const [a, b] = k.split('_').map(Number);
        for (const i of [a, b]) {
            positions.push(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]);
            const local = rms * (0.6 + 0.8 * Math.abs(noise3(m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2])));
            colors.push(...cividis01(local / 0.1));
        }
    }
    return { mode: 1, positions, colors };
}

function ringLines(c: V3, r: number, y: number, n: number): PrimSpec {
    const positions: number[] = [];
    for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        positions.push(c[0] + Math.cos(a0) * r, y, c[2] + Math.sin(a0) * r, c[0] + Math.cos(a1) * r, y, c[2] + Math.sin(a1) * r);
    }
    return { mode: 1, positions };
}

/** Ornament: coffers in the soffit (cells, sinking), the archivolt molding (sweeps along t), a relief panel (rises). */
function detailNodes(): NodeSpec[] {
    const nodes: NodeSpec[] = [];
    const elements = 3;
    // e001: coffer lattice, a recut of the soffit: 5 × 3 cells, each recessed 0.22 m, appearing cell by cell.
    {
        const m = new MeshBuilder({ _REVEAL: { itemSize: 2, u16n: true }, _DISP: { itemSize: 3 } });
        const cu = 5, cv = 3, sub = 4;
        const nu = cu * sub, nv = cv * sub;
        const base = m.vertexCount;
        const rank = 0;
        for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
            const x = -H + (i / nu) * ARCH.span, z = -Z + (j / nv) * ARCH.depth;
            const ci = Math.min(cu - 1, Math.floor(i / sub)), cj = Math.min(cv - 1, Math.floor(j / sub));
            const inCell = i % sub !== 0 && j % sub !== 0;
            const inst = cj * cu + ci;
            const n = norm([x / 6, -1, 0]);
            const depth = inCell ? 0.22 : 0;
            const disp = mul(n, -depth);
            const p = add([x, soffitY(x), z], disp);
            m.vertex(p, n, { _REVEAL: [(rank + inst / (cu * cv)) / elements, 0], _DISP: inCell ? disp : [0, 0, 0] });
        }
        for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
            const a = base + j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
            m.indices.push(a, b, c, b, d, c);
        }
        nodes.push({
            name: 'e001-coffers', prims: [m.prim()],
            extras: nodeExtras({
                stage: 'detail', provenance: inferred(PROVENANCE.photoInferred, 0.62, 'ornament: replicate lattice of relief cells'),
                buildOrder: 0, buildCount: elements, revealKind: 'cells',
                reveal: { attribute: '_REVEAL', displacement: '_DISP', durationShare: 0.6 },
                ids: { elementId: 'e001', slotId: 'S03', surfaceId: 's-soffit' }, replacesSurfaceIds: ['s-soffit'],
                counts: { vertices: m.vertexCount, triangles: m.indices.length / 3 }
            })
        });
    }
    // e002: archivolt molding swept along the south arch edge, t = arc length.
    {
        const m = new MeshBuilder({ _REVEAL: { itemSize: 2, u16n: true } });
        const steps = 48;
        const path: V3[] = [];
        for (let i = 0; i <= steps; i++) { const x = -H + (i / steps) * ARCH.span; path.push([x, soffitY(x) + 0.25, Z + 0.18]); }
        m.tube(path, () => 0.24, 8, i => ({ _REVEAL: [1 / elements, i / steps] }));
        nodes.push({
            name: 'e002-archivolt', prims: [m.prim()],
            extras: nodeExtras({
                stage: 'detail', provenance: inferred(PROVENANCE.photoInferred, 0.81, 'ornament: sweep along the slot crease'),
                buildOrder: 1, buildCount: elements, revealKind: 'sweep',
                reveal: { attribute: '_REVEAL', displacement: null, durationShare: 0.6 },
                sweep: { carrierLengthM: 13.4, closed: false, tAttribute: '_REVEAL.y' },
                ids: { elementId: 'e002', slotId: 'S07' }, counts: { vertices: m.vertexCount, triangles: m.indices.length / 3 }
            })
        });
    }
    // e003: relief panel on the attic's south face, rising 0.14 m (low confidence: dotted in provenance mode).
    {
        const m = new MeshBuilder({ _REVEAL: { itemSize: 2, u16n: true }, _DISP: { itemSize: 3 } });
        const rise = 0.14;
        const x0 = -3.6, x1 = 3.6, y0 = ARCH.atticY0 + 1.2, y1 = ARCH.atticY1 - 0.9;
        const n: V3 = [0, 0, 1];
        const disp = mul(n, rise);
        m.grid([x0, y0, Z + rise], [x1 - x0, 0, 0], [0, y1 - y0, 0], 18, 4, { attr: () => ({ _REVEAL: [2 / elements, 0], _DISP: disp }) });
        for (const [o, u] of [[[x0, y0, Z], [x1 - x0, 0, 0]], [[x1, y1, Z], [x0 - x1, 0, 0]]] as Array<[V3, V3]>) {
            m.grid(o, u, [0, 0, rise], 18, 1, { attr: (_s, t) => ({ _REVEAL: [2 / elements, 0], _DISP: mul(disp, t) }) });
        }
        nodes.push({
            name: 'e003-panel', prims: [m.prim()],
            extras: nodeExtras({
                stage: 'detail', provenance: inferred(PROVENANCE.photoInferred, 0.38, 'ornament: normal relief panel'),
                buildOrder: 2, buildCount: elements, revealKind: 'rise',
                reveal: { attribute: '_REVEAL', displacement: '_DISP', durationShare: 0.6 },
                ids: { elementId: 'e003', slotId: 'S11' }, counts: { vertices: m.vertexCount, triangles: m.indices.length / 3 }
            })
        });
    }
    return nodes;
}

// ---------------------------------------------------------------------------------------------------------------
// GLB writer
// ---------------------------------------------------------------------------------------------------------------

/** Writes glTF 2.0 binary: one node per NodeSpec (mesh with its primitives, extras), one grey clay material. */
export function writeGlb(nodes: NodeSpec[], opts: { sceneExtras?: unknown; assetExtras?: unknown } = {}): Buffer {
    const chunks: Buffer[] = [];
    let offset = 0;
    const bufferViews: any[] = [];
    const accessors: any[] = [];
    const push = (data: Buffer, target?: number): number => {
        const pad = (4 - (offset % 4)) % 4;
        if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad; }
        bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target ? { target } : {}) });
        chunks.push(data);
        offset += data.length;
        return bufferViews.length - 1;
    };
    const floatAccessor = (data: number[], itemSize: number, withBounds = false): number => {
        const buf = Buffer.alloc(data.length * 4);
        data.forEach((v, i) => buf.writeFloatLE(v, i * 4));
        const view = push(buf, 34962);
        const type = ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][itemSize - 1];
        const acc: any = { bufferView: view, componentType: 5126, count: data.length / itemSize, type };
        if (withBounds) {
            const min = new Array(itemSize).fill(Infinity), max = new Array(itemSize).fill(-Infinity);
            for (let i = 0; i < data.length; i++) { const c = i % itemSize; min[c] = Math.min(min[c], data[i]); max[c] = Math.max(max[c], data[i]); }
            acc.min = min; acc.max = max;
        }
        accessors.push(acc);
        return accessors.length - 1;
    };
    const u16nAccessor = (data: number[], itemSize: number): number => {
        const buf = Buffer.alloc(data.length * 2 + ((data.length * 2) % 4));
        data.forEach((v, i) => buf.writeUInt16LE(Math.round(Math.min(1, Math.max(0, v)) * 65535), i * 2));
        const view = push(buf, 34962);
        accessors.push({ bufferView: view, componentType: 5123, normalized: true, count: data.length / itemSize, type: ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][itemSize - 1] });
        return accessors.length - 1;
    };
    const indexAccessor = (data: number[]): number => {
        const buf = Buffer.alloc(data.length * 4);
        data.forEach((v, i) => buf.writeUInt32LE(v, i * 4));
        const view = push(buf, 34963);
        accessors.push({ bufferView: view, componentType: 5125, count: data.length, type: 'SCALAR' });
        return accessors.length - 1;
    };
    const meshes: any[] = [];
    const gltfNodes: any[] = [];
    for (const n of nodes) {
        const primitives = n.prims.map(p => {
            const attributes: Record<string, number> = { POSITION: floatAccessor(p.positions, 3, true) };
            if (p.normals && p.normals.length === p.positions.length) attributes.NORMAL = floatAccessor(p.normals, 3);
            if (p.colors) attributes.COLOR_0 = floatAccessor(p.colors, 3);
            for (const [name, a] of Object.entries(p.attributes ?? {})) {
                if (a.data.length === 0) continue;
                attributes[name] = a.u16n ? u16nAccessor(a.data, a.itemSize) : floatAccessor(a.data, a.itemSize);
            }
            return { attributes, ...(p.indices ? { indices: indexAccessor(p.indices) } : {}), mode: p.mode, material: 0 };
        });
        meshes.push({ name: n.name, primitives });
        gltfNodes.push({ name: n.name, mesh: meshes.length - 1, ...(n.extras ? { extras: n.extras } : {}) });
    }
    const bin = Buffer.concat(chunks);
    const json = {
        asset: { version: '2.0', generator: 'scratchbox staged-glb-fixture (test)', ...(opts.assetExtras ? { extras: opts.assetExtras } : {}) },
        scene: 0,
        scenes: [{ nodes: gltfNodes.map((_, i) => i), ...(opts.sceneExtras ? { extras: opts.sceneExtras } : {}) }],
        nodes: gltfNodes,
        meshes,
        materials: [{ name: 'clay', pbrMetallicRoughness: { baseColorFactor: [0.69, 0.72, 0.77, 1], metallicFactor: 0.02, roughnessFactor: 0.82 }, doubleSided: true }],
        accessors,
        bufferViews,
        buffers: [{ byteLength: bin.length }]
    };
    let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
    jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);
    const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0);
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binPadded.length, 8);
    const jh = Buffer.alloc(8); jh.writeUInt32LE(jsonBuf.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
    const bh = Buffer.alloc(8); bh.writeUInt32LE(binPadded.length, 0); bh.writeUInt32LE(0x004e4942, 4);
    return Buffer.concat([header, jh, jsonBuf, bh, binPadded]);
}

/** Vertex, triangle and node counts of a GLB (every primitive, LINES count as 0 triangles). */
export function glbCounts(buf: Buffer): { vertices: number; triangles: number; nodes: number } {
    const jsonLen = buf.readUInt32LE(12);
    const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
    let vertices = 0, triangles = 0;
    for (const m of json.meshes ?? []) for (const p of m.primitives) {
        vertices += json.accessors[p.attributes.POSITION].count;
        if ((p.mode ?? 4) === 4) triangles += p.indices !== undefined ? json.accessors[p.indices].count / 3 : json.accessors[p.attributes.POSITION].count / 3;
    }
    return { vertices, triangles, nodes: (json.nodes ?? []).length };
}

// ---------------------------------------------------------------------------------------------------------------
// The staged build state for the fixture layers
// ---------------------------------------------------------------------------------------------------------------

export const FIXTURE_RUN_ID = 'c0ffee42';
const KEY = { l1: '5d6c8812', l2: '90e96133', l3a: '7c1e04aa', l3b: '7c1e04aa', l4: 'b3d1e9c0', l5: '788091ab', l5x: '788091ab' } as const;
export type FixtureLayerId = keyof typeof KEY;
export const objectIdOf = (l: FixtureLayerId): string => `stg-${KEY[l]}-${l}`;

/** One StagedLayer per fixture layer, wired as §3.5's table says (order, revealAfter, crossfade, supersedes, stagger). */
export function fixtureLayer(l: FixtureLayerId, counts: StagedFixtureGlbs['counts'], baseUrl: string, extra: Partial<StagedLayer> = {}): StagedLayer {
    const id = objectIdOf(l);
    const common = { objectId: id, layer: l, url: `${baseUrl}/${id}.glb`, bytes: 0, cached: false, builtAtMs: Date.UTC(2026, 9, 15, 12), counts: { vertices: counts[l].vertices, triangles: counts[l].triangles } };
    const t: Record<FixtureLayerId, Omit<StagedLayer, keyof typeof common>> = {
        l1: { stage: 'tiles', order: 1, provenance: measured(PROVENANCE.asScanned, 'Google Photorealistic 3D Tiles, leaf LOD'), provenanceLabels: [PROVENANCE.asScanned], supersedes: [], revealAfter: [], reveal: { durationMs: 800, stagger: 1, crossfadeFrom: [], orderUrl: `${baseUrl}/${id}.order.json` } },
        l2: { stage: 'remesh', order: 2, provenance: measured(PROVENANCE.remeshed, 'tile_refine: rectify, flatten, photometric relief (inferred)', { note: 'rectify moved 61% of vertices over 1 cm (max 0.09 m)' }), provenanceLabels: [PROVENANCE.remeshed, PROVENANCE.asScanned, PROVENANCE.photoInferred], supersedes: [objectIdOf('l1')], revealAfter: [], reveal: { durationMs: 600, stagger: 0, crossfadeFrom: [objectIdOf('l1')] } },
        l3a: { stage: 'fit', order: 3, provenance: measured(PROVENANCE.fitted, 'scan_fit outlines'), provenanceLabels: [PROVENANCE.fitted], supersedes: [], revealAfter: [objectIdOf('l2')], reveal: { durationMs: 600, stagger: 1, crossfadeFrom: [] } },
        l3b: { stage: 'fit', order: 3, provenance: measured(PROVENANCE.fitted, 'scan_fit'), provenanceLabels: [PROVENANCE.fitted, PROVENANCE.fittedUnobserved], supersedes: [objectIdOf('l2')], revealAfter: [objectIdOf('l2'), objectIdOf('l3a')], reveal: { durationMs: 900, stagger: 1, crossfadeFrom: [objectIdOf('l2')] } },
        l4: { stage: 'detail', order: 4, provenance: inferred(PROVENANCE.photoInferred, 0.6, 'ornament'), provenanceLabels: [PROVENANCE.photoInferred], supersedes: [], revealAfter: [objectIdOf('l3b')], reveal: { durationMs: 1200, stagger: 0.5, crossfadeFrom: [] } },
        l5: { stage: 'trees', order: 5, provenance: measured(PROVENANCE.grownToMeasuredCrown, 'SB-Veggie'), provenanceLabels: [PROVENANCE.grownToMeasuredCrown, PROVENANCE.asScanned], supersedes: [], revealAfter: [objectIdOf('l2')], reveal: { durationMs: 1500, stagger: 0.3, crossfadeFrom: [] } },
        l5x: { stage: 'trees', order: 5, provenance: measured(PROVENANCE.asScanned, 'the scanned crowns put back'), provenanceLabels: [PROVENANCE.asScanned], supersedes: [], revealAfter: [objectIdOf('l2')], reveal: { durationMs: 1500, stagger: 0, crossfadeFrom: [] } }
    };
    return { ...common, ...t[l], ...extra } as StagedLayer;
}

const TITLES: Record<string, [string, string, number]> = {
    tiles: ['Google 3D Tiles', '9 leaf tiles around the structure (26 m)', 1],
    remesh: ['Remeshed scan', 'tile_refine: rectify, flatten, relief (inferred)', 2],
    fit: ['Scan-fitted rebuild', 'scan_fit: 6 primitives, 3.2 cm rms', 3],
    vision: ['Reading the photos', 'gemini-4-argon (thinking LOW)', -1],
    detail: ['Facade detail', 'ornament: 3 photo-inferred elements', 4],
    trees: ['Trees', 'SB-Veggie: 5 trees grown to the measured crown', 5]
};

/** A StagedBuildState with the given committed layers; stages after the last committed one are running or pending. */
export function fixtureState(layers: StagedLayer[], opts: { runState?: StagedBuildState['runState']; updatedAtMs?: number; running?: string[]; degradations?: DegradationRecord[]; stageStatus?: Record<string, StageSummary['status']>; stageReason?: Record<string, string>; visionModel?: StagedBuildState['visionModel'] } = {}): StagedBuildState {
    const t0 = (opts.updatedAtMs ?? Date.now()) - 20_000;
    const stages: StageSummary[] = Object.entries(TITLES).map(([stage, [title, source, order]], i) => {
        const own = layers.filter(l => l.stage === stage);
        const status: StageSummary['status'] = opts.stageStatus?.[stage] ?? (own.length > 0 ? 'committed' : opts.running?.includes(stage) ? 'running' : 'pending');
        return {
            stage, order, title, source, status,
            ...(opts.stageReason?.[stage] ? { reason: opts.stageReason[stage] } : status === 'degraded' || status === 'failed' ? { reason: (opts.degradations ?? []).find(d => d.stage === stage)?.reason ?? `${title} ${status}` } : {}),
            layerIds: own.map(l => l.objectId),
            timings: { startedAtMs: t0 + i * 1500, ...(status === 'running' || status === 'pending' ? {} : { endedAtMs: t0 + i * 1500 + 1200, ms: 1200 }), cached: false },
            degradationIds: (opts.degradations ?? []).filter(d => d.stage === stage).map(d => d.id)
        };
    });
    const state: StagedBuildState = {
        schema: 'scratchbox.staged-build/2', runId: FIXTURE_RUN_ID, requestKey: 'synthetic arch|isolate', artifactId: `scene-stg-${FIXTURE_RUN_ID}`,
        place: { query: 'synthetic segmental arch', resolvedAddress: 'test fixture', lat: 40.73114, lng: -73.99707 },
        structure: { buildingId: '3fa9c2d1e07b5a44', seed: [0.4, -1.2], geocodeToStructureM: 6.1, footprintAreaM2: 289.3, extractionRadiusM: 31, containmentRounds: 1, isolateIoU: 0.91 },
        runState: opts.runState ?? 'running', updatedAtMs: opts.updatedAtMs ?? Date.now() + 60_000,
        stages, layers, degradations: opts.degradations ?? [],
        provenanceLegend: [
            { label: PROVENANCE.fitted, color: '#0072B2', pattern: 'solid', description: 'fitted to the scan: 3.2 cm rms over 97% of the visible surface' },
            { label: PROVENANCE.remeshed, color: '#56B4E9', pattern: 'solid', description: 'tile_refine: rectify moved 61% of vertices over 1 cm' },
            { label: PROVENANCE.grownToMeasuredCrown, color: '#009E73', pattern: 'solid', description: 'SB-Veggie trees grown to the measured crown' }
        ],
        ...(opts.visionModel ? { visionModel: opts.visionModel } : {}),
        attribution: ['Map data ©Google'],
        retry: { retryRunId: FIXTURE_RUN_ID, stages: (opts.degradations ?? []).filter(d => d.transient).map(d => d.stage) }
    };
    const problems = validateContract('StagedBuildState', state);
    if (problems.length > 0) throw new Error(`fixture state violates the contract: ${problems.join('; ')}`);
    return state;
}
