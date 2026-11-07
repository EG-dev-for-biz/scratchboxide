/**
 * Blob graph prototype (dev tool, not shipped), step 2 and 3: split the welded district scan into blobs and measure them
 * (docs/research/2026-11-06-blob-graph-plan.md §5.1-5.2).
 *
 *   node -r ts-node/register scripts/dev/blob-graph/split.ts --out <dir>      (reads <dir>/welded.glb, canopy.json, vector.json)
 *
 * Writes <dir>/split/labels.bin (Int32 blob index per triangle, -1 unassigned, loadScanMesh numbering) and
 * <dir>/split/blobs.json (blobs, edges, measures, the split's counts).
 *
 * The split claims triangles in the plan's order, each stage only from what is left:
 *   ground   - the measured walkable terrain (GroundModel): triangles wholly within the apron height above it that face up
 *              or sideways-down (|ny| >= 0.5), anywhere; one blob;
 *   building - the rest whose centroid falls in a Google vector footprint (0.5 m raster, grown 1.5 m to take the
 *              footprint's error); one blob per footprint feature;
 *   tree     - the rest whose centroid falls in a canopy cell of the tree strip's own classifier, one blob per connected
 *              piece (buildings already won where both claim a cell);
 *   on-building - inside each building: large planes found by region growing (normals within 15 degrees, offset within
 *              0.25 m, at least 20 m2); what is left splits into connected pieces, and a piece standing more than 0.3 m
 *              off the nearest large plane, with at least 1 m2 of surface, is a child blob (roof object above an up-facing
 *              plane, wall attachment beside a vertical one); the rest stays in the shell;
 *   transient candidate / on-ground - the rest splits into connected pieces: a piece on a vehicle-sized proud lump of the
 *              street (vehicle-removal.ts vehicleCandidates, geometry only: 4-40 m2, 1.2-4.5 m tall, mostly on a road) is a
 *              transient candidate, the others are ground objects; a piece touching a building above 2.5 m is that
 *              building's attachment;
 *   unassigned - pieces under 0.05 m2 or 3 triangles touching nothing claimed, and anything else no stage took.
 * Every number here is measured; no name decides anything.
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadScanMesh, buildGroundModel, type ScanMesh, type GroundModel } from '../../../packages/core/src/node/spatial/StreetViewSurveyPlanner';
import { readTileTriangles } from '../../../packages/core/src/node/3d-engine/staged-location/tile-texture-transfer';
import { vehicleCandidates } from '../../../packages/core/src/node/3d-engine/staged-location/vehicle-removal';
import { decodeCanopyMask } from '../../../packages/core/src/node/3d-engine/tile-vegetation-service';
import type { VectorEvidence } from '../../../packages/core/src/node/3d-engine/staged-location/vector-footprints';
import { BUILDING_PART_MIN } from '../../../packages/core/src/node/3d-engine/staged-location/residual-audit';
import { APRON_HEIGHT_M } from '../../../packages/core/src/node/3d-engine/staged-location/pipeline-e/residual-audit-e';

export const SPLIT_PARAMS = {
    apronM: APRON_HEIGHT_M,
    footprintCellM: 0.5,
    footprintGrowM: 1.5,
    /** What is left and connected to a building joins it up to this far (plan) outside its footprint. */
    footprintReachM: 6,
    planeAngleDeg: 15,
    planeOffsetM: 0.25,
    planeMinAreaM2: 20,
    proudMinM: 0.3,
    childMinAreaM2: 1,
    /** A piece holding more than this share of its building's area stays shell (a curved wall is not an attachment). */
    childMaxShare: 0.2,
    attachMinAboveGroundM: 2.5,
    debrisMaxAreaM2: 0.05,
    debrisMaxTriangles: 3,
    vehicle: { minAreaM2: 4, maxAreaM2: 40, minHeightM: 1.2, maxHeightM: 4.5, minRoadShare: 0.5 }
};

export type BlobGroup = 'ground' | 'building' | 'roof-object' | 'wall-attachment' | 'tree' | 'transient-candidate' | 'ground-object';

export interface BlobRecord {
    index: number;
    id: string;
    group: BlobGroup;
    /** Google vector feature id (buildings). */
    featureId?: string;
    triangles: number;
    parent?: number;
    restsOn?: number;
    attachedTo?: number;
    measures: Record<string, number | number[]>;
    /** Why the split put it here (measured values). */
    because: string;
}

function arg(name: string, fallback?: string): string {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : fallback;
    if (v === undefined) throw new Error(`--${name} is required`);
    return v;
}

// ---------------------------------------------------------------------------------------------- vertex groups / adjacency

/** Positions quantised to 1 cm; triangles sharing a quantised position are neighbours (the weld made shared positions exact). */
function vertexGroups(scan: ScanMesh): { triGroups: Int32Array; groupTris: { start: Int32Array; list: Int32Array }; groups: number } {
    const V = scan.mesh.vertices as Float32Array, I = scan.mesh.indices as Uint32Array;
    const nv = V.length / 3;
    const ofVertex = new Int32Array(nv);
    const map = new Map<number, number>();
    for (let v = 0; v < nv; v++) {
        const qx = Math.round(V[v * 3] * 100) + 32768, qy = Math.round(V[v * 3 + 1] * 100) + 32768, qz = Math.round(V[v * 3 + 2] * 100) + 32768;
        const key = (qx * 65536 + qy) * 65536 + qz;
        let g = map.get(key);
        if (g === undefined) { g = map.size; map.set(key, g); }
        ofVertex[v] = g;
    }
    const nt = I.length / 3, groups = map.size;
    const triGroups = new Int32Array(nt * 3);
    for (let k = 0; k < nt * 3; k++) triGroups[k] = ofVertex[I[k]];
    const count = new Int32Array(groups + 1);
    for (let k = 0; k < nt * 3; k++) count[triGroups[k] + 1]++;
    for (let g = 0; g < groups; g++) count[g + 1] += count[g];
    const start = count.slice();
    const fill = count.slice(0, groups);
    const list = new Int32Array(nt * 3);
    for (let t = 0; t < nt; t++) for (let j = 0; j < 3; j++) list[fill[triGroups[t * 3 + j]]++] = t;
    return { triGroups, groupTris: { start, list }, groups };
}

/** Connected pieces of the triangles where `inSet[t]` (vertex adjacency). Returns a piece id per triangle (-1 outside) and the pieces. */
function components(inSet: (t: number) => boolean, nt: number, adj: ReturnType<typeof vertexGroups>): { comp: Int32Array; pieces: number[][] } {
    const comp = new Int32Array(nt).fill(-1);
    const pieces: number[][] = [];
    const stack: number[] = [];
    for (let s = 0; s < nt; s++) {
        if (comp[s] >= 0 || !inSet(s)) continue;
        const id = pieces.length, piece: number[] = [];
        comp[s] = id; stack.push(s);
        while (stack.length) {
            const t = stack.pop()!;
            piece.push(t);
            for (let j = 0; j < 3; j++) {
                const g = adj.triGroups[t * 3 + j];
                for (let k = adj.groupTris.start[g]; k < adj.groupTris.start[g + 1]; k++) {
                    const u = adj.groupTris.list[k];
                    if (comp[u] < 0 && inSet(u)) { comp[u] = id; stack.push(u); }
                }
            }
        }
        pieces.push(piece);
    }
    return { comp, pieces };
}

/** Blob labels of the triangles touching `piece` (vertex adjacency), with the number of contacts each. */
function touching(piece: number[], labels: Int32Array, adj: ReturnType<typeof vertexGroups>): Map<number, number> {
    const out = new Map<number, number>();
    const self = new Set(piece);
    for (const t of piece) for (let j = 0; j < 3; j++) {
        const g = adj.triGroups[t * 3 + j];
        for (let k = adj.groupTris.start[g]; k < adj.groupTris.start[g + 1]; k++) {
            const u = adj.groupTris.list[k];
            if (self.has(u)) continue;
            const l = labels[u];
            if (l >= 0) out.set(l, (out.get(l) ?? 0) + 1);
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------- footprints raster

function rasterFootprints(ev: VectorEvidence, x0: number, z0: number, nx: number, nz: number, cell: number, growM: number): { id: Int32Array; ids: string[] } {
    const id = new Int32Array(nx * nz).fill(-1);
    const ids: string[] = [];
    ev.buildings.forEach(b => {
        const bi = ids.length;
        let any = false;
        for (const part of b.parts) {
            // even-odd scanline fill of the part's loops at the cell centres
            let zMin = Infinity, zMax = -Infinity;
            for (const loop of part) for (const p of loop) { zMin = Math.min(zMin, p[1]); zMax = Math.max(zMax, p[1]); }
            const k0 = Math.max(0, Math.floor((zMin - z0) / cell)), k1 = Math.min(nz - 1, Math.ceil((zMax - z0) / cell));
            for (let k = k0; k <= k1; k++) {
                const z = z0 + (k + 0.5) * cell;
                const xs: number[] = [];
                for (const loop of part) for (let i = 0; i < loop.length; i++) {
                    const a = loop[i], c = loop[(i + 1) % loop.length];
                    if ((a[1] <= z) !== (c[1] <= z)) xs.push(a[0] + ((z - a[1]) / (c[1] - a[1])) * (c[0] - a[0]));
                }
                xs.sort((p, q) => p - q);
                for (let m = 0; m + 1 < xs.length; m += 2) {
                    const i0 = Math.max(0, Math.ceil((xs[m] - x0) / cell - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[m + 1] - x0) / cell - 0.5));
                    for (let i = i0; i <= i1; i++) { id[k * nx + i] = bi; any = true; }
                }
            }
        }
        ids.push(b.id);
        void any;
    });
    // grow each footprint outward by growM (multi-source BFS, nearest footprint wins)
    const steps = Math.round(growM / cell);
    let frontier: number[] = [];
    for (let c = 0; c < id.length; c++) if (id[c] >= 0) frontier.push(c);
    for (let s = 0; s < steps; s++) {
        const next: number[] = [];
        for (const c of frontier) {
            const i = c % nx, k = (c - i) / nx;
            for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const a = i + di, b = k + dk;
                if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
                const d = b * nx + a;
                if (id[d] < 0) { id[d] = id[c]; next.push(d); }
            }
        }
        frontier = next;
    }
    return { id, ids };
}

// ---------------------------------------------------------------------------------------------- planes

interface Plane { n: [number, number, number]; d: number; area: number; tris: number[]; lo: number[]; hi: number[] }

/** Region growing over vertex-adjacent triangles: unsigned normals within angleDeg of the region's, centroid within offsetM of its plane. */
function growPlanes(tris: number[], scan: ScanMesh, adj: ReturnType<typeof vertexGroups>, angleDeg: number, offsetM: number): { planeOf: Map<number, number>; planes: Plane[] } {
    const N = scan.triNormal, C = scan.triCentroid, A = scan.triArea;
    const V = scan.mesh.vertices as Float32Array, I = scan.mesh.indices as Uint32Array;
    const inSet = new Set(tris);
    const planeOf = new Map<number, number>();
    const planes: Plane[] = [];
    const cosT = Math.cos((angleDeg * Math.PI) / 180);
    const order = tris.slice().sort((a, b) => A[b] - A[a]);
    for (const seed of order) {
        if (planeOf.has(seed) || A[seed] <= 0) continue;
        let nx = N[seed * 3], ny = N[seed * 3 + 1], nz = N[seed * 3 + 2];
        if (ny < 0 || (ny === 0 && nx < 0)) { nx = -nx; ny = -ny; nz = -nz; }
        // accumulate an area-weighted normal (sign-aligned) and centroid
        let sx = 0, sy = 0, sz = 0, cx = 0, cy = 0, cz = 0, area = 0;
        let pn: [number, number, number] = [nx, ny, nz];
        let pd = nx * C[seed * 3] + ny * C[seed * 3 + 1] + nz * C[seed * 3 + 2];
        const id = planes.length, members: number[] = [];
        const queue = [seed];
        planeOf.set(seed, id);
        let qi = 0;
        while (qi < queue.length) {
            const t = queue[qi++];
            members.push(t);
            let tx = N[t * 3], ty = N[t * 3 + 1], tz = N[t * 3 + 2];
            if (tx * pn[0] + ty * pn[1] + tz * pn[2] < 0) { tx = -tx; ty = -ty; tz = -tz; }
            const a = A[t];
            sx += tx * a; sy += ty * a; sz += tz * a; cx += C[t * 3] * a; cy += C[t * 3 + 1] * a; cz += C[t * 3 + 2] * a; area += a;
            if (members.length % 64 === 0) {
                const l = Math.hypot(sx, sy, sz) || 1;
                pn = [sx / l, sy / l, sz / l];
                pd = (pn[0] * cx + pn[1] * cy + pn[2] * cz) / area;
            }
            for (let j = 0; j < 3; j++) {
                const g = adj.triGroups[t * 3 + j];
                for (let k = adj.groupTris.start[g]; k < adj.groupTris.start[g + 1]; k++) {
                    const u = adj.groupTris.list[k];
                    if (planeOf.has(u) || !inSet.has(u)) continue;
                    const dot = Math.abs(N[u * 3] * pn[0] + N[u * 3 + 1] * pn[1] + N[u * 3 + 2] * pn[2]);
                    if (dot < cosT) continue;
                    const off = Math.abs(pn[0] * C[u * 3] + pn[1] * C[u * 3 + 1] + pn[2] * C[u * 3 + 2] - pd);
                    if (off > offsetM) continue;
                    planeOf.set(u, id);
                    queue.push(u);
                }
            }
        }
        const l = Math.hypot(sx, sy, sz) || 1;
        pn = [sx / l, sy / l, sz / l];
        pd = (pn[0] * cx + pn[1] * cy + pn[2] * cz) / Math.max(area, 1e-12);
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const t of members) for (let j = 0; j < 3; j++) { const v = I[t * 3 + j] * 3; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], V[v + k]); hi[k] = Math.max(hi[k], V[v + k]); } }
        planes.push({ n: pn, d: pd, area, tris: members, lo, hi });
    }
    return { planeOf, planes };
}

// ---------------------------------------------------------------------------------------------- measures

const srgb = (l: number) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
function linToLab(r: number, g: number, b: number): [number, number, number] {
    const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

function symEig3(m: number[]): number[] {
    // eigenvalues of a symmetric 3x3 (Smith's method), descending
    const [a, b, c, d, e, f] = m; // xx, yy, zz, xy, yz, xz
    const p1 = d * d + f * f + e * e;
    if (p1 < 1e-18) return [a, b, c].sort((x, y) => y - x);
    const q = (a + b + c) / 3;
    const p2 = (a - q) ** 2 + (b - q) ** 2 + (c - q) ** 2 + 2 * p1;
    const p = Math.sqrt(p2 / 6);
    const B = [(a - q) / p, (b - q) / p, (c - q) / p, d / p, e / p, f / p];
    const detB = B[0] * (B[1] * B[2] - B[4] * B[4]) - B[3] * (B[3] * B[2] - B[4] * B[5]) + B[5] * (B[3] * B[4] - B[1] * B[5]);
    const r = Math.max(-1, Math.min(1, detB / 2));
    const phi = Math.acos(r) / 3;
    const e1 = q + 2 * p * Math.cos(phi), e3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
    return [e1, 3 * q - e1 - e3, e3];
}

function measureBlob(tris: number[], scan: ScanMesh, colour: Float32Array, support: number, adj: ReturnType<typeof vertexGroups>): Record<string, number | number[]> {
    const V = scan.mesh.vertices as Float32Array, I = scan.mesh.indices as Uint32Array, N = scan.triNormal, C = scan.triCentroid, A = scan.triArea;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    let area = 0, vert = 0, up = 0, mx = 0, my = 0, mz = 0;
    for (const t of tris) {
        const a = A[t]; area += a;
        vert += a * (1 - Math.abs(N[t * 3 + 1]));
        up += a * Math.abs(N[t * 3 + 1]);
        mx += C[t * 3] * a; my += C[t * 3 + 1] * a; mz += C[t * 3 + 2] * a;
        for (let j = 0; j < 3; j++) { const v = I[t * 3 + j] * 3; for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], V[v + k]); hi[k] = Math.max(hi[k], V[v + k]); } }
    }
    const W = Math.max(area, 1e-12);
    mx /= W; my /= W; mz /= W;
    // area-weighted covariance of the centroids: PCA extents
    let xx = 0, yy = 0, zz = 0, xy = 0, yz = 0, xz = 0;
    for (const t of tris) {
        const a = A[t], dx = C[t * 3] - mx, dy = C[t * 3 + 1] - my, dz = C[t * 3 + 2] - mz;
        xx += a * dx * dx; yy += a * dy * dy; zz += a * dz * dz; xy += a * dx * dy; yz += a * dy * dz; xz += a * dx * dz;
    }
    const ev = symEig3([xx / W, yy / W, zz / W, xy / W, yz / W, xz / W]).map(l => Math.sqrt(Math.max(0, l)));
    // extent along each principal axis ~ 2 * sqrt(3) * sigma for a uniform spread
    const ext = ev.map(s => 2 * Math.sqrt(3) * s);
    // planarity: share of area on its three largest planes (same region growing as the split)
    let planarity = 0;
    if (tris.length <= 60000) {
        const { planes } = growPlanes(tris, scan, adj, 12, 0.12);
        const top = planes.map(p => p.area).sort((a, b) => b - a).slice(0, 3).reduce((s, a) => s + a, 0);
        planarity = top / W;
    }
    // axial symmetry about the vertical axis through the area centroid: per 0.5 m (or 1/12 height) slice, 1 - CV of radii
    const h = hi[1] - lo[1];
    const slice = Math.max(0.25, h / 12);
    const slices = new Map<number, number[]>();
    for (const t of tris) {
        const k = Math.floor((C[t * 3 + 1] - lo[1]) / slice);
        const r = Math.hypot(C[t * 3] - mx, C[t * 3 + 2] - mz);
        let s = slices.get(k); if (!s) slices.set(k, s = []);
        s.push(r);
        // coverage of angles: a full ring has samples all round
    }
    let symW = 0, sym = 0, ringCover = 0;
    for (const [, rs] of slices) {
        if (rs.length < 6) continue;
        const m = rs.reduce((s, r) => s + r, 0) / rs.length;
        const sd = Math.sqrt(rs.reduce((s, r) => s + (r - m) ** 2, 0) / rs.length);
        sym += rs.length * Math.max(0, 1 - sd / Math.max(m, 1e-6)); symW += rs.length;
    }
    // angular coverage (share of 16 sectors holding surface) about the same axis, area-weighted
    const sectors = new Float64Array(16);
    for (const t of tris) { const ang = Math.atan2(C[t * 3 + 2] - mz, C[t * 3] - mx); sectors[Math.min(15, Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 16))] += A[t]; }
    for (let s = 0; s < 16; s++) if (sectors[s] > W / 64) ringCover++;
    // colour: area-weighted mean and spread of the photo at the triangle centroids (linear -> Lab)
    let L = 0, a = 0, b = 0, L2 = 0, chroma = 0, cw = 0;
    for (const t of tris) {
        const r = colour[t * 3]; if (r !== r) continue;
        const lab = linToLab(colour[t * 3], colour[t * 3 + 1], colour[t * 3 + 2]);
        const w = A[t];
        L += lab[0] * w; a += lab[1] * w; b += lab[2] * w; L2 += lab[0] * lab[0] * w; chroma += Math.hypot(lab[1], lab[2]) * w; cw += w;
    }
    const cW = Math.max(cw, 1e-12);
    const meanL = L / cW;
    // mean sRGB of the area (for the sheet)
    let R = 0, G = 0, B = 0;
    for (const t of tris) { if (colour[t * 3] !== colour[t * 3]) continue; R += colour[t * 3] * A[t]; G += colour[t * 3 + 1] * A[t]; B += colour[t * 3 + 2] * A[t]; }
    const r4 = (x: number) => Math.round(x * 1e3) / 1e3;
    return {
        boundsMin: lo.map(r4), boundsMax: hi.map(r4),
        sizeM: [r4(hi[0] - lo[0]), r4(hi[1] - lo[1]), r4(hi[2] - lo[2])],
        areaM2: r4(area), triangles: tris.length,
        heightAboveSupportM: r4(lo[1] - support), topAboveSupportM: r4(hi[1] - support),
        pcaExtentsM: ext.map(r4),
        /** The thinnest principal extent: a thickness estimate for compact blobs (a shell's would be its depth). */
        thicknessEstimateM: r4(ext[2]),
        planarity: r4(planarity), verticality: r4(vert / W), upFacing: r4(up / W),
        axialSymmetry: r4(symW ? sym / symW : 0), angularCoverage: r4(ringCover / 16),
        elongation: r4(ext[0] > 0 ? 1 - ext[1] / ext[0] : 0), slenderness: r4(ext[2] > 1e-3 ? ext[0] / ext[2] : 0),
        colourLab: [r4(meanL), r4(a / cW), r4(b / cW)], lightnessSd: r4(Math.sqrt(Math.max(0, L2 / cW - meanL * meanL))), chroma: r4(chroma / cW),
        meanSrgb: [R, G, B].map(x => Math.round(255 * srgb(Math.max(0, x / W)))),
        centroid: [r4(mx), r4(my), r4(mz)]
    };
}

const minOf = (a: number[], f: (t: number) => number) => { let m = Infinity; for (const t of a) { const v = f(t); if (v < m) m = v; } return m; };

// ---------------------------------------------------------------------------------------------- main

async function main(): Promise<void> {
    const out = path.resolve(arg('out'));
    const P = SPLIT_PARAMS;
    const t0 = Date.now();
    const welded = path.join(out, 'welded.glb');
    const scan = loadScanMesh(welded);
    const nt = scan.triCount;
    const V = scan.mesh.vertices as Float32Array, I = scan.mesh.indices as Uint32Array, N = scan.triNormal, C = scan.triCentroid, A = scan.triArea;
    console.log(`scan: ${nt} triangles, ${(A.reduce((s, a) => s + a, 0) / 1e3).toFixed(1)}k m2 (${Date.now() - t0} ms)`);

    // per-triangle photo colour at the centroid (linear), from the same file's soup; the soup's order is checked against the scan's
    const soup = readTileTriangles(fs.readFileSync(welded));
    if (soup.texture.length !== nt) throw new Error(`soup has ${soup.texture.length} triangles, scan ${nt}`);
    for (const t of [0, nt >> 1, nt - 1]) {
        const cx = (soup.positions[t * 9] + soup.positions[t * 9 + 3] + soup.positions[t * 9 + 6]) / 3;
        if (Math.abs(cx - C[t * 3]) > 1e-3) throw new Error(`soup and scan triangle order differ at ${t}`);
    }
    const colour = new Float32Array(nt * 3).fill(NaN);
    for (let t = 0; t < nt; t++) {
        const ti = soup.texture[t];
        if (ti < 0) { colour.set(soup.flatLinear.subarray(t * 3, t * 3 + 3), t * 3); continue; }
        const tex = soup.textures[ti];
        let u = (soup.uvs[t * 6] + soup.uvs[t * 6 + 2] + soup.uvs[t * 6 + 4]) / 3, v = (soup.uvs[t * 6 + 1] + soup.uvs[t * 6 + 3] + soup.uvs[t * 6 + 5]) / 3;
        u = u - Math.floor(u); v = v - Math.floor(v);
        const x = Math.min(tex.width - 1, Math.floor(u * tex.width)), y = Math.min(tex.height - 1, Math.floor(v * tex.height));
        const o = (y * tex.width + x) * 3;
        colour[t * 3] = tex.linear[o]; colour[t * 3 + 1] = tex.linear[o + 1]; colour[t * 3 + 2] = tex.linear[o + 2];
    }

    const ev: VectorEvidence & { origin: { lat: number; lng: number } } = JSON.parse(fs.readFileSync(path.join(out, 'vector.json'), 'utf8'));
    const canopyMask = JSON.parse(fs.readFileSync(path.join(out, 'canopy.json'), 'utf8'));
    const canopy = decodeCanopyMask(canopyMask);
    const canopyAt = (x: number, z: number) => {
        const i = Math.floor((x - canopyMask.x0) / canopyMask.cellM), k = Math.floor((z - canopyMask.z0) / canopyMask.cellM);
        return i >= 0 && k >= 0 && i < canopyMask.nx && k < canopyMask.nz && canopy[k * canopyMask.nx + i] === 1;
    };
    // footprints raster over the scan's plan
    const fc = P.footprintCellM;
    const fx0 = Math.floor(scan.bounds.min[0]) - 2, fz0 = Math.floor(scan.bounds.min[2]) - 2;
    const fnx = Math.ceil((scan.bounds.max[0] - fx0 + 2) / fc), fnz = Math.ceil((scan.bounds.max[2] - fz0 + 2) / fc);
    const fp = rasterFootprints(ev, fx0, fz0, fnx, fnz, fc, P.footprintGrowM);
    const footprintAt = (x: number, z: number) => {
        const i = Math.floor((x - fx0) / fc), k = Math.floor((z - fz0) / fc);
        return i < 0 || k < 0 || i >= fnx || k >= fnz ? -1 : fp.id[k * fnx + i];
    };
    // the unGrown raster for the road/building lookups the ground and vehicle code take
    const fpTight = rasterFootprints(ev, fx0, fz0, fnx, fnz, fc, 0);
    const buildingAt = (x: number, z: number) => { const i = Math.floor((x - fx0) / fc), k = Math.floor((z - fz0) / fc); return i < 0 || k < 0 || i >= fnx || k >= fnz ? 0 : fpTight.id[k * fnx + i] >= 0 ? 1 : 0; };
    const roadCells = new Uint8Array(fnx * fnz);
    for (const r of ev.roads) for (let i = 1; i < r.length; i++) {
        const a = r[i - 1], b = r[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(L / 0.5));
        for (let s = 0; s <= n; s++) {
            const x = a[0] + ((b[0] - a[0]) * s) / n, z = a[1] + ((b[1] - a[1]) * s) / n;
            for (let dz = -3; dz <= 3; dz += 0.5) for (let dx = -3; dx <= 3; dx += 0.5) {
                if (dx * dx + dz * dz > 9) continue;
                const ci = Math.floor((x + dx - fx0) / fc), ck = Math.floor((z + dz - fz0) / fc);
                if (ci >= 0 && ck >= 0 && ci < fnx && ck < fnz) roadCells[ck * fnx + ci] = 1;
            }
        }
    }
    const roadAt = (x: number, z: number) => { const i = Math.floor((x - fx0) / fc), k = Math.floor((z - fz0) / fc); return i >= 0 && k >= 0 && i < fnx && k < fnz && roadCells[k * fnx + i] === 1; };

    const ground: GroundModel = buildGroundModel(scan, { cellMeters: 1, road: roadAt, exclude: canopyAt });
    console.log(`ground: ${ground.terrainMethod} (${Date.now() - t0} ms)`);
    const adj = vertexGroups(scan);
    console.log(`adjacency: ${adj.groups} positions (${Date.now() - t0} ms)`);

    const labels = new Int32Array(nt).fill(-1);
    const blobs: BlobRecord[] = [];
    const tris: number[][] = [];
    const newBlob = (group: BlobGroup, members: number[], because: string, extra: Partial<BlobRecord> = {}): number => {
        const index = blobs.length;
        blobs.push({ index, id: '', group, triangles: members.length, measures: {}, because, ...extra });
        tris.push(members);
        for (const t of members) labels[t] = index;
        return index;
    };
    const top = (t: number) => Math.max(V[I[t * 3] * 3 + 1], V[I[t * 3 + 1] * 3 + 1], V[I[t * 3 + 2] * 3 + 1]);
    const bottom = (t: number) => Math.min(V[I[t * 3] * 3 + 1], V[I[t * 3 + 1] * 3 + 1], V[I[t * 3 + 2] * 3 + 1]);
    const gAt = (t: number) => ground.groundAt(C[t * 3], C[t * 3 + 2]);

    // 1. ground
    const groundTris: number[] = [];
    for (let t = 0; t < nt; t++) {
        const g = gAt(t);
        if (g !== g) continue;
        if (top(t) <= g + P.apronM && (Math.abs(N[t * 3 + 1]) >= 0.5 || footprintAt(C[t * 3], C[t * 3 + 2]) < 0)) groundTris.push(t);
    }
    const groundBlob = newBlob('ground', groundTris, `wholly within ${P.apronM} m above the measured walkable terrain, facing up (|ny| >= 0.5) or outside every footprint (kerbs)`);

    // 2. buildings by footprint
    const byFootprint = new Map<number, number[]>();
    for (let t = 0; t < nt; t++) {
        if (labels[t] >= 0) continue;
        const f = footprintAt(C[t * 3], C[t * 3 + 2]);
        if (f < 0) continue;
        let a = byFootprint.get(f); if (!a) byFootprint.set(f, a = []);
        a.push(t);
    }
    const buildingOf = new Map<number, number>();
    for (const [f, members] of [...byFootprint.entries()].sort((a, b) => b[1].length - a[1].length)) {
        const area = members.reduce((s, t) => s + A[t], 0);
        if (area < 2) continue; // a footprint edge grazing a few triangles: left to the later stages
        const bi = newBlob('building', members, `centroid inside Google vector footprint ${fp.ids[f]} (grown ${P.footprintGrowM} m)`, { featureId: fp.ids[f], restsOn: groundBlob });
        buildingOf.set(bi, f);
    }
    console.log(`buildings: ${buildingOf.size} (${Date.now() - t0} ms)`);

    // 3. trees: canopy cells, one blob per connected piece
    const treeSet = new Uint8Array(nt);
    for (let t = 0; t < nt; t++) if (labels[t] < 0 && canopyAt(C[t * 3], C[t * 3 + 2])) treeSet[t] = 1;
    const treePieces = components(t => treeSet[t] === 1, nt, adj).pieces;
    for (const piece of treePieces) {
        const area = piece.reduce((s, t) => s + A[t], 0);
        if (area < 0.5) { for (const t of piece) treeSet[t] = 0; continue; }
        newBlob('tree', piece, `in the tree strip's canopy cells (its colour and roughness classifier), connected piece of ${area.toFixed(1)} m2`, { restsOn: groundBlob });
    }

    // 4b. the footprint's error: what is left and connected to a building, within reachM (plan) of its footprint, joins it
    {
        const reach = rasterFootprints(ev, fx0, fz0, fnx, fnz, fc, P.footprintReachM);
        const featureBlob = new Map<number, number>();
        for (const [bi, f] of buildingOf) featureBlob.set(f, bi);
        const reachBlob = (t: number) => { const i = Math.floor((C[t * 3] - fx0) / fc), k = Math.floor((C[t * 3 + 2] - fz0) / fc); const f = i < 0 || k < 0 || i >= fnx || k >= fnz ? -1 : reach.id[k * fnx + i]; return f < 0 ? -1 : featureBlob.get(f) ?? -1; };
        const queue: number[] = [];
        for (const bi of buildingOf.keys()) for (const t of tris[bi]) queue.push(t);
        let joined = 0;
        for (let qi = 0; qi < queue.length; qi++) {
            const t = queue[qi], l = labels[t];
            for (let j = 0; j < 3; j++) {
                const g = adj.triGroups[t * 3 + j];
                for (let k = adj.groupTris.start[g]; k < adj.groupTris.start[g + 1]; k++) {
                    const u = adj.groupTris.list[k];
                    if (labels[u] >= 0 || reachBlob(u) !== l) continue;
                    labels[u] = l; tris[l].push(u); blobs[l].triangles++; queue.push(u); joined++;
                }
            }
        }
        console.log(`footprint reach: ${joined} triangles joined their building`);
    }
    // 4c. a building the vector data misses: a left piece at least BUILDING_PART_MIN tall and wide (residual-audit.ts)
    for (const piece of components(t => labels[t] < 0, nt, adj).pieces) {
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const t of piece) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], C[t * 3 + k]); hi[k] = Math.max(hi[k], C[t * 3 + k]); }
        const planM2 = (hi[0] - lo[0]) * (hi[2] - lo[2]);
        if (hi[1] - lo[1] >= BUILDING_PART_MIN.heightM && planM2 >= BUILDING_PART_MIN.planM2) {
            newBlob('building', piece, `no vector footprint; a connected piece ${(hi[1] - lo[1]).toFixed(0)} m tall over ${planM2.toFixed(0)} m2 of plan (residual-audit BUILDING_PART_MIN)`, { restsOn: groundBlob });
        }
    }
    // 4. things on buildings: large planes removed, proud pieces split off
    const buildingIdx = blobs.filter(b => b.group === 'building').map(b => b.index);
    for (const bi of buildingIdx) {
        const members = tris[bi];
        const bArea = members.reduce((s, t) => s + A[t], 0);
        const { planeOf, planes } = growPlanes(members, scan, adj, P.planeAngleDeg, P.planeOffsetM);
        const large = planes.map((p, i) => (p.area >= P.planeMinAreaM2 ? i : -1)).filter(i => i >= 0);
        const isLarge = new Set(large);
        const rest = new Set(members.filter(t => !isLarge.has(planeOf.get(t)!)));
        const pieces = components(t => rest.has(t), nt, adj).pieces;
        const keep: number[] = [];
        for (const piece of pieces) {
            const area = piece.reduce((s, t) => s + A[t], 0);
            if (area < P.childMinAreaM2 || area > P.childMaxShare * bArea) continue;
            // proudness: per vertex, distance to the nearest large plane whose box (grown 1.5 m) holds it; the piece's 90th percentile
            const ds: number[] = [];
            const votes = new Map<number, number>();
            for (const t of piece) for (let j = 0; j < 3; j++) {
                const v = I[t * 3 + j] * 3, x = V[v], y = V[v + 1], z = V[v + 2];
                let best = Infinity, bp = -1;
                for (const pi of large) {
                    const p = planes[pi];
                    if (x < p.lo[0] - 1.5 || x > p.hi[0] + 1.5 || y < p.lo[1] - 1.5 || y > p.hi[1] + 1.5 || z < p.lo[2] - 1.5 || z > p.hi[2] + 1.5) continue;
                    const d = Math.abs(p.n[0] * x + p.n[1] * y + p.n[2] * z - p.d);
                    if (d < best) { best = d; bp = pi; }
                }
                ds.push(best);
                if (bp >= 0) votes.set(bp, (votes.get(bp) ?? 0) + 1);
            }
            ds.sort((a, b) => a - b);
            const proud = ds[Math.floor(ds.length * 0.9)];
            if (!(proud >= P.proudMinM) || !Number.isFinite(proud)) continue;
            const minY = minOf(piece, bottom);
            const g = gAt(piece[0]);
            if (g === g && minY < g + 1) continue; // standing on the street: part of the building's base
            const host = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
            const roof = host !== undefined && Math.abs(planes[host].n[1]) > 0.7 && planes[host].n[1] !== 0;
            keep.push(newBlob(roof ? 'roof-object' : 'wall-attachment', piece,
                `${(proud).toFixed(2)} m proud (90th percentile) of the building's ${roof ? 'up-facing' : 'vertical'} fitted plane (${planes[host ?? 0]?.area.toFixed(0)} m2), ${area.toFixed(1)} m2`,
                { parent: bi, ...(roof ? { restsOn: bi } : { attachedTo: bi }) }));
        }
        if (keep.length) {
            const moved = new Set(keep.flatMap(k => tris[k]));
            tris[bi] = members.filter(t => !moved.has(t));
            blobs[bi].triangles = tris[bi].length;
            blobs[bi].measures.largePlanes = large.length;
        }
    }
    console.log(`on-building: ${blobs.filter(b => b.group === 'roof-object' || b.group === 'wall-attachment').length} (${Date.now() - t0} ms)`);

    // 5. what is left: vehicle-sized proud lumps of the street, ground objects, attachments, debris
    const vc = vehicleCandidates(scan, ground, { buildingAt, roadAt });
    const vehicleCell = new Int32Array(vc.grid.nx * vc.grid.nz).fill(-1);
    for (const c of vc.candidates) {
        const V2 = P.vehicle;
        if (c.areaM2 < V2.minAreaM2 || c.areaM2 > V2.maxAreaM2 || c.heightM < V2.minHeightM || c.heightM > V2.maxHeightM || c.onRoadShare < V2.minRoadShare) continue;
        for (const cell of c.cells) vehicleCell[cell] = c.id;
    }
    const vehicleAt = (x: number, z: number) => {
        const i = Math.floor((x - vc.grid.x0) / vc.grid.cellM), k = Math.floor((z - vc.grid.z0) / vc.grid.cellM);
        return i < 0 || k < 0 || i >= vc.grid.nx || k >= vc.grid.nz ? -1 : vehicleCell[k * vc.grid.nx + i];
    };
    const leftPieces = components(t => labels[t] < 0, nt, adj).pieces;
    { const big = leftPieces.map(p => p.reduce((s, t) => s + A[t], 0)).sort((a, b) => b - a).slice(0, 5); console.log(`left pieces, largest m2: ${big.map(a => a.toFixed(0)).join(', ')}`); }
    let debrisJoined = 0, debrisLeft = 0;
    const unassigned: number[] = [];
    for (const piece of leftPieces.sort((a, b) => b.length - a.length)) {
        const area = piece.reduce((s, t) => s + A[t], 0);
        const touch = touching(piece, labels, adj);
        if (area < P.debrisMaxAreaM2 || piece.length <= P.debrisMaxTriangles) {
            // debris: joins the blob it touches most (a doubtful split joins the larger blob), else unassigned
            const best = [...touch.entries()].sort((a, b) => b[1] - a[1])[0];
            if (best) { for (const t of piece) tris[best[0]].push(t); for (const t of piece) labels[t] = best[0]; blobs[best[0]].triangles += piece.length; debrisJoined++; }
            else { for (const t of piece) unassigned.push(t); debrisLeft++; }
            continue;
        }
        const minY = minOf(piece, bottom);
        let cx = 0, cz = 0; for (const t of piece) { cx += C[t * 3] * A[t]; cz += C[t * 3 + 2] * A[t]; } cx /= area; cz /= area;
        const g = ground.groundAt(cx, cz);
        const above = g === g ? minY - g : NaN;
        // vehicle-sized lump: share of the piece's area over candidate cells
        let onVehicle = 0; const vids = new Map<number, number>();
        for (const t of piece) { const v = vehicleAt(C[t * 3], C[t * 3 + 2]); if (v >= 0) { onVehicle += A[t]; vids.set(v, (vids.get(v) ?? 0) + 1); } }
        const touchedBuildings = [...touch.entries()].filter(([l]) => blobs[l].group === 'building').sort((a, b) => b[1] - a[1]);
        if (onVehicle / area >= 0.5) {
            newBlob('transient-candidate', piece, `${Math.round((100 * onVehicle) / area)}% over a vehicle-sized proud lump of the street (vehicleCandidates: 4-40 m2, 1.2-4.5 m tall, on a road)`, { restsOn: groundBlob });
        } else if (touchedBuildings.length && (above >= P.attachMinAboveGroundM || !(above === above))) {
            const host = touchedBuildings[0][0];
            newBlob('wall-attachment', piece, `touches building ${host}, its lowest point ${above.toFixed(1)} m above the street, outside the footprint`, { parent: host, attachedTo: host });
        } else {
            const restsOn = [...touch.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? groundBlob;
            newBlob('ground-object', piece, `connected piece left after ground, buildings, trees and roof objects; lowest point ${above.toFixed(2)} m above the street`, { restsOn });
        }
    }
    console.log(`left: ${leftPieces.length} pieces, debris joined ${debrisJoined}, unassigned ${debrisLeft} (${Date.now() - t0} ms)`);

    // ids and measures
    const crypto = await import('crypto');
    const totalArea = A.reduce((s, a) => s + a, 0);
    for (const b of blobs) {
        const members = tris[b.index];
        b.triangles = members.length;
        // support height: the street under its centroid, or the roof plane (its host building's top under it) for roof objects
        let cx = 0, cz = 0, ar = 0; for (const t of members) { cx += C[t * 3] * A[t]; cz += C[t * 3 + 2] * A[t]; ar += A[t]; }
        cx /= ar || 1; cz /= ar || 1;
        let support = ground.groundAt(cx, cz);
        if (b.group === 'roof-object' && b.parent !== undefined) {
            // the host's surface just under the piece: the highest host triangle below the piece's bottom within its plan box
            const lo = minOf(members, bottom);
            let best = -Infinity;
            const bx0 = minOf(members, t => C[t * 3]) - 1, bx1 = -minOf(members, t => -C[t * 3]) + 1;
            const bz0 = minOf(members, t => C[t * 3 + 2]) - 1, bz1 = -minOf(members, t => -C[t * 3 + 2]) + 1;
            for (const t of tris[b.parent]) { const x = C[t * 3], z = C[t * 3 + 2], y = C[t * 3 + 1]; if (x >= bx0 && x <= bx1 && z >= bz0 && z <= bz1 && y <= lo + 0.3 && y > best) best = y; }
            if (best > -Infinity) support = best;
        }
        if (support !== support) support = scan.bounds.min[1];
        b.measures = { ...b.measures, ...measureBlob(members, scan, colour, support, adj) };
        if (b.featureId) b.id = `building/${b.featureId}`;
        else {
            // geometry hash: the members' centroids rounded to 5 cm, sorted
            const keys = members.map(t => `${Math.round(C[t * 3] * 20)},${Math.round(C[t * 3 + 1] * 20)},${Math.round(C[t * 3 + 2] * 20)}`).sort();
            b.id = `blob/${crypto.createHash('sha256').update(keys.join(';')).digest('hex').slice(0, 16)}`;
        }
    }
    const groups: Record<string, { blobs: number; triangles: number; areaM2: number }> = {};
    for (const b of blobs) {
        const g = (groups[b.group] ??= { blobs: 0, triangles: 0, areaM2: 0 });
        g.blobs++; g.triangles += b.triangles; g.areaM2 += Number(b.measures.areaM2);
    }
    for (const t of unassigned) labels[t] = -1;
    const unassignedArea = unassigned.reduce((s, t) => s + A[t], 0);
    let claimed = 0; for (let t = 0; t < nt; t++) if (labels[t] >= 0) claimed++;
    const edges = blobs.flatMap(b => [
        ...(b.parent !== undefined ? [{ from: b.index, to: b.parent, kind: 'parent' }] : []),
        ...(b.restsOn !== undefined ? [{ from: b.index, to: b.restsOn, kind: 'rests_on' }] : []),
        ...(b.attachedTo !== undefined ? [{ from: b.index, to: b.attachedTo, kind: 'attached_to' }] : [])
    ]);
    const report = {
        schema: 'scratchbox.blob-graph-prototype/1',
        source: { welded, triangles: nt, areaM2: Math.round(totalArea), anchor: ev.origin },
        params: P,
        counts: {
            groups, blobs: blobs.length, claimedTriangles: claimed, unassignedTriangles: unassigned.length,
            unassignedAreaM2: Math.round(unassignedArea * 100) / 100, unassignedShare: unassignedArea / totalArea,
            everyTriangleOnce: claimed + unassigned.length === nt
        },
        ms: Date.now() - t0,
        blobs, edges
    };
    fs.mkdirSync(path.join(out, 'split'), { recursive: true });
    fs.writeFileSync(path.join(out, 'split', 'labels.bin'), Buffer.from(labels.buffer));
    fs.writeFileSync(path.join(out, 'split', 'blobs.json'), JSON.stringify(report, null, 1));
    console.log(JSON.stringify(report.counts, null, 1));
    console.log(`done in ${Date.now() - t0} ms`);
}

main().catch(err => { console.error(err); process.exit(1); });
