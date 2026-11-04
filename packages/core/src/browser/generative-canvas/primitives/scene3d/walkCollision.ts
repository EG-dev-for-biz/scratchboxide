/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Collision queries for the viewport's walk mode (walkMode.ts): rays for the ground under the walker and the contacts of
 * a capsule with the surfaces around it, against whatever triangles the scene draws.
 *
 * Each geometry gets a bounding volume hierarchy over its triangles in its own frame (TriangleBvh), built the first time
 * a query comes near it and kept until its positions, index or draw range change. A frame first gathers the meshes whose
 * world boxes overlap the walker's reach (`gather`), so its queries meet a few hundred triangles however large the scene.
 * Instanced meshes are tested instance by instance, against one hierarchy of their shared geometry.
 *
 * Nothing here reads what a mesh is called or what it shows: a surface is a triangle, its slope is its normal. A mesh
 * takes part when it is drawn (visible all the way up, a material that draws) and is plain triangles in its own frame;
 * the caller vetoes viewport plumbing (cursors, gizmos, helpers) with its own predicate.
 */

import * as THREE from 'three';

/** Triangles per leaf of the hierarchy. */
const LEAF_SIZE = 8;
/** Deeper than this a node is a leaf whatever its size (coincident centroids never split). */
const MAX_DEPTH = 48;
const EPS = 1e-12;

/**
 * A bounding volume hierarchy over a triangle soup in its own frame. Nodes are depth first: an inner node's left child
 * is the next node and `links` holds its right child; a leaf holds its first triangle and its count. Leaf triangles are
 * stored contiguously, in leaf order, so a leaf reads one run of `triangles`.
 */
export class TriangleBvh {
    /** Vertex positions, 3 floats a vertex. */
    readonly vertices: Float32Array;
    /** Vertex indices, 3 a triangle, in leaf order (zero-area triangles dropped). */
    readonly triangles: Uint32Array;
    /** Per node: min x, y, z, max x, y, z. */
    readonly bounds: Float32Array;
    /** Per node: [first triangle, count] for a leaf (count > 0), [right child, 0] for an inner node. */
    readonly links: Uint32Array;
    readonly nodeCount: number;
    readonly triangleCount: number;

    constructor(vertices: Float32Array, triangles: Uint32Array) {
        this.vertices = vertices;
        const all = Math.floor(triangles.length / 3);
        const kept = new Uint32Array(all);
        let n = 0;
        for (let t = 0; t < all; t++) {
            const a = triangles[3 * t] * 3, b = triangles[3 * t + 1] * 3, c = triangles[3 * t + 2] * 3;
            const abx = vertices[b] - vertices[a], aby = vertices[b + 1] - vertices[a + 1], abz = vertices[b + 2] - vertices[a + 2];
            const acx = vertices[c] - vertices[a], acy = vertices[c + 1] - vertices[a + 1], acz = vertices[c + 2] - vertices[a + 2];
            const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
            // a collapsed triangle (a hidden merged part: all three corners one vertex) is no surface
            if (nx * nx + ny * ny + nz * nz > EPS * EPS) kept[n++] = t;
        }
        this.triangleCount = n;
        const box = new Float32Array(n * 6);
        const cen = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
            const t = kept[i];
            for (let k = 0; k < 3; k++) {
                const a = vertices[triangles[3 * t] * 3 + k], b = vertices[triangles[3 * t + 1] * 3 + k], c = vertices[triangles[3 * t + 2] * 3 + k];
                const lo = Math.min(a, b, c), hi = Math.max(a, b, c);
                box[6 * i + k] = lo;
                box[6 * i + 3 + k] = hi;
                cen[3 * i + k] = (lo + hi) / 2;
            }
        }
        const order = new Uint32Array(n);
        for (let i = 0; i < n; i++) order[i] = i;
        const maxNodes = Math.max(1, 2 * n);
        const bounds = new Float32Array(maxNodes * 6);
        const links = new Uint32Array(maxNodes * 2);
        let count = 0;
        const build = (start: number, end: number, depth: number): number => {
            const node = count++;
            let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
            let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
            for (let i = start; i < end; i++) {
                const o = order[i] * 6, c = order[i] * 3;
                if (box[o] < x0) x0 = box[o];
                if (box[o + 1] < y0) y0 = box[o + 1];
                if (box[o + 2] < z0) z0 = box[o + 2];
                if (box[o + 3] > x1) x1 = box[o + 3];
                if (box[o + 4] > y1) y1 = box[o + 4];
                if (box[o + 5] > z1) z1 = box[o + 5];
                if (cen[c] < cx0) cx0 = cen[c];
                if (cen[c] > cx1) cx1 = cen[c];
                if (cen[c + 1] < cy0) cy0 = cen[c + 1];
                if (cen[c + 1] > cy1) cy1 = cen[c + 1];
                if (cen[c + 2] < cz0) cz0 = cen[c + 2];
                if (cen[c + 2] > cz1) cz1 = cen[c + 2];
            }
            bounds[6 * node] = x0; bounds[6 * node + 1] = y0; bounds[6 * node + 2] = z0;
            bounds[6 * node + 3] = x1; bounds[6 * node + 4] = y1; bounds[6 * node + 5] = z1;
            const len = end - start;
            const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
            if (len <= LEAF_SIZE || depth >= MAX_DEPTH || Math.max(ex, ey, ez) <= 0) {
                links[2 * node] = start;
                links[2 * node + 1] = len;
                return node;
            }
            // split at the middle of the centroids' longest extent; a side left empty splits the run in half instead
            const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
            const mid = axis === 0 ? (cx0 + cx1) / 2 : axis === 1 ? (cy0 + cy1) / 2 : (cz0 + cz1) / 2;
            let i = start, j = end - 1;
            while (i <= j) {
                if (cen[order[i] * 3 + axis] < mid) i++;
                else { const tmp = order[i]; order[i] = order[j]; order[j] = tmp; j--; }
            }
            const split = i <= start || i >= end ? (start + end) >>> 1 : i;
            build(start, split, depth + 1);
            const right = build(split, end, depth + 1);
            links[2 * node] = right;
            links[2 * node + 1] = 0;
            return node;
        };
        if (n > 0) build(0, n, 0);
        this.nodeCount = count;
        this.bounds = bounds.slice(0, count * 6);
        this.links = links.slice(0, count * 2);
        const tris = new Uint32Array(n * 3);
        for (let k = 0; k < n; k++) {
            const t = kept[order[k]];
            tris[3 * k] = triangles[3 * t];
            tris[3 * k + 1] = triangles[3 * t + 1];
            tris[3 * k + 2] = triangles[3 * t + 2];
        }
        this.triangles = tris;
    }

    /**
     * The nearest crossing of the segment o + s d (s in [0, 1]) with a triangle, from either side: s, or Infinity when
     * it crosses none. `out.triangle` is the crossed triangle's position in `triangles` (its first index / 3).
     */
    segmentHit(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, out: { triangle: number }): number {
        if (this.nodeCount === 0) return Infinity;
        const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
        const B = this.bounds, L = this.links, V = this.vertices, T = this.triangles;
        const stack = STACK;
        let top = 0;
        stack[top++] = 0;
        let best = Infinity;
        while (top > 0) {
            const node = stack[--top];
            const o = node * 6;
            // slab test against [0, best); a NaN (an origin on a slab with a zero direction) leaves that axis open
            let t0 = 0, t1 = best;
            let a = (B[o] - ox) * ix, b = (B[o + 3] - ox) * ix;
            if (a > b) { const s = a; a = b; b = s; }
            if (a > t0) t0 = a;
            if (b < t1) t1 = b;
            a = (B[o + 1] - oy) * iy; b = (B[o + 4] - oy) * iy;
            if (a > b) { const s = a; a = b; b = s; }
            if (a > t0) t0 = a;
            if (b < t1) t1 = b;
            a = (B[o + 2] - oz) * iz; b = (B[o + 5] - oz) * iz;
            if (a > b) { const s = a; a = b; b = s; }
            if (a > t0) t0 = a;
            if (b < t1) t1 = b;
            if (t0 > t1 || t0 > 1) continue;
            const count = L[2 * node + 1];
            if (count === 0) {
                stack[top++] = L[2 * node];
                stack[top++] = node + 1;
                continue;
            }
            const first = L[2 * node];
            for (let k = first; k < first + count; k++) {
                const p = T[3 * k] * 3, q = T[3 * k + 1] * 3, r = T[3 * k + 2] * 3;
                // Moller-Trumbore, two-sided
                const e1x = V[q] - V[p], e1y = V[q + 1] - V[p + 1], e1z = V[q + 2] - V[p + 2];
                const e2x = V[r] - V[p], e2y = V[r + 1] - V[p + 1], e2z = V[r + 2] - V[p + 2];
                const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
                const det = e1x * px + e1y * py + e1z * pz;
                if (det > -EPS && det < EPS) continue;
                const inv = 1 / det;
                const tx = ox - V[p], ty = oy - V[p + 1], tz = oz - V[p + 2];
                const u = (tx * px + ty * py + tz * pz) * inv;
                if (u < 0 || u > 1) continue;
                const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
                const v = (dx * qx + dy * qy + dz * qz) * inv;
                if (v < 0 || u + v > 1) continue;
                const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
                if (s >= 0 && s <= 1 && s < best) { best = s; out.triangle = k; }
            }
        }
        return best;
    }

    /** Calls `visit` with the position in `triangles` of every triangle in a leaf whose bounds overlap the box. */
    trianglesInBox(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, visit: (triangle: number) => void): void {
        if (this.nodeCount === 0) return;
        const B = this.bounds, L = this.links;
        const stack = STACK;
        let top = 0;
        stack[top++] = 0;
        while (top > 0) {
            const node = stack[--top];
            const o = node * 6;
            if (B[o] > x1 || B[o + 3] < x0 || B[o + 1] > y1 || B[o + 4] < y0 || B[o + 2] > z1 || B[o + 5] < z0) continue;
            const count = L[2 * node + 1];
            if (count === 0) {
                stack[top++] = L[2 * node];
                stack[top++] = node + 1;
                continue;
            }
            const first = L[2 * node];
            for (let k = first; k < first + count; k++) visit(k);
        }
    }
}

/** Traversal stack shared by every query (queries never nest). Depth first holds at most MAX_DEPTH + 2 entries. */
const STACK = new Uint32Array(MAX_DEPTH * 2 + 8);

const versionOf = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | null | undefined): number =>
    !a ? -1 : (a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as THREE.InterleavedBufferAttribute).data.version : (a as THREE.BufferAttribute).version;

interface CachedBvh { bvh: TriangleBvh; position: number; index: number; drawStart: number; drawCount: number }
const bvhCache = new WeakMap<THREE.BufferGeometry, CachedBvh>();

/** The hierarchy of a geometry's drawn triangles, from the cache while its positions, index and draw range are unchanged. */
export function triangleBvhOf(geometry: THREE.BufferGeometry, onBuild?: (ms: number, triangles: number) => void): TriangleBvh | null {
    const pos = geometry.getAttribute('position');
    if (!pos || pos.itemSize < 3) return null;
    const index = geometry.index;
    const cached = bvhCache.get(geometry);
    const pv = versionOf(pos), iv = versionOf(index);
    if (cached && cached.position === pv && cached.index === iv && cached.drawStart === geometry.drawRange.start && cached.drawCount === geometry.drawRange.count) return cached.bvh;
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const vertices = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
        vertices[3 * i] = pos.getX(i);
        vertices[3 * i + 1] = pos.getY(i);
        vertices[3 * i + 2] = pos.getZ(i);
    }
    const total = index ? index.count : pos.count;
    const first = Math.max(0, geometry.drawRange.start);
    let last = Math.min(total, first + geometry.drawRange.count);
    last -= (last - first) % 3;
    const tris = new Uint32Array(Math.max(0, last - first));
    for (let i = first; i < last; i++) tris[i - first] = index ? index.getX(i) : i;
    const bvh = new TriangleBvh(vertices, tris);
    bvhCache.set(geometry, { bvh, position: pv, index: iv, drawStart: geometry.drawRange.start, drawCount: geometry.drawRange.count });
    onBuild?.((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0, bvh.triangleCount);
    return bvh;
}

/**
 * Whether a mesh is a surface a walker meets: plain triangles in its own frame with a material that draws. Multi-draw
 * batches and instanced-attribute geometry are drawn from per-instance data the CPU does not hold as triangles.
 */
export function isDrawnSurface(object: THREE.Object3D): object is THREE.Mesh {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || (mesh as unknown as { isBatchedMesh?: boolean }).isBatchedMesh) return false;
    const g = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!g || (g as THREE.InstancedBufferGeometry).isInstancedBufferGeometry || !g.getAttribute('position')) return false;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    return materials.some(m => !!m && m.visible !== false);
}

const visibleAllTheWay = (o: THREE.Object3D | null): boolean => {
    for (let cur = o; cur; cur = cur.parent) if (!cur.visible) return false;
    return true;
};

export interface WalkSurfaceHit {
    point: THREE.Vector3;
    /** Unit normal of the surface, facing the ray. */
    normal: THREE.Vector3;
    distance: number;
}

/** One mesh, or one instance of an instanced mesh, placed in the world. */
interface Collider {
    geometry: THREE.BufferGeometry;
    matrix: THREE.Matrix4;
    inverse: THREE.Matrix4;
    box: THREE.Box3;
}

interface Entry {
    mesh: THREE.Mesh;
    /** The mesh's world matrix when the boxes were measured. */
    seen: THREE.Matrix4;
    instanceVersion: number;
    /** World box of the mesh (all of its instances for an instanced mesh); empty until measured. */
    box: THREE.Box3;
    colliders: Collider[];
}

export interface WalkCollisionStats {
    /** Meshes the walker can meet in the scene. */
    meshes: number;
    /** Meshes or instances near the walker this frame. */
    near: number;
    /** Triangles tested since the last gather. */
    trianglesTested: number;
    bvhBuilds: number;
    bvhTriangles: number;
    bvhBuildMs: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _o = new THREE.Vector3();
const _e = new THREE.Vector3();
const _segPoint = new THREE.Vector3();
const _triPoint = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _box = new THREE.Box3();
const _instance = new THREE.Matrix4();
const _hitOut = { triangle: -1 };

/** The scene's triangles as the walker meets them. */
export class WalkCollisionWorld {
    private readonly entries = new Map<THREE.Mesh, Entry>();
    private near: Collider[] = [];
    private gathered = false;
    readonly stats: WalkCollisionStats = { meshes: 0, near: 0, trianglesTested: 0, bvhBuilds: 0, bvhTriangles: 0, bvhBuildMs: 0 };

    /**
     * @param root what the walker walks in (the viewport's scene)
     * @param include vetoes objects that are not scene content (the viewport's cursors and helpers); called with each
     *   drawn mesh and decides by flags and identity, never by names or kinds of things
     */
    constructor(private readonly root: THREE.Object3D, private readonly include: (mesh: THREE.Mesh) => boolean = () => true) {
        this.refresh();
    }

    /** Whether the walker meets this object: a drawn surface, visible all the way up, not vetoed. */
    meets(object: THREE.Object3D): boolean {
        return isDrawnSurface(object) && visibleAllTheWay(object) && this.include(object);
    }

    /** Re-reads the scene's drawn meshes (meshes added since, a layer shown): the walker calls this twice a second. */
    refresh(): void {
        const seen = new Set<THREE.Mesh>();
        this.root.traverseVisible(o => {
            if (!isDrawnSurface(o) || !this.include(o)) return;
            seen.add(o);
            if (!this.entries.has(o)) this.entries.set(o, { mesh: o, seen: new THREE.Matrix4().set(NaN, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0), instanceVersion: -1, box: new THREE.Box3(), colliders: [] });
        });
        for (const mesh of this.entries.keys()) if (!seen.has(mesh)) this.entries.delete(mesh);
        this.stats.meshes = this.entries.size;
    }

    /** Re-measures a mesh's world boxes when it moved, its instances changed or its geometry was replaced. */
    private measure(e: Entry): void {
        const mesh = e.mesh;
        const inst = (mesh as THREE.InstancedMesh).isInstancedMesh ? (mesh as THREE.InstancedMesh) : null;
        const version = inst ? inst.instanceMatrix.version * 1e6 + inst.count : 0;
        if (e.seen.equals(mesh.matrixWorld) && e.instanceVersion === version && e.colliders[0]?.geometry === mesh.geometry) return;
        e.seen.copy(mesh.matrixWorld);
        e.instanceVersion = version;
        const geometry = mesh.geometry as THREE.BufferGeometry;
        if (!geometry.boundingBox) geometry.computeBoundingBox();
        const local = geometry.boundingBox!;
        const count = inst ? inst.count : 1;
        while (e.colliders.length > count) e.colliders.pop();
        e.box.makeEmpty();
        for (let i = 0; i < count; i++) {
            const c = e.colliders[i] ?? (e.colliders[i] = { geometry, matrix: new THREE.Matrix4(), inverse: new THREE.Matrix4(), box: new THREE.Box3() });
            c.geometry = geometry;
            if (inst) { inst.getMatrixAt(i, _instance); c.matrix.multiplyMatrices(mesh.matrixWorld, _instance); } else c.matrix.copy(mesh.matrixWorld);
            c.inverse.copy(c.matrix).invert();
            c.box.copy(local).applyMatrix4(c.matrix);
            e.box.union(c.box);
        }
    }

    /**
     * Gathers the meshes and instances whose world boxes overlap `box` for the queries that follow; the walker calls it
     * once a frame with its reach. Until the first gather, queries meet every mesh.
     */
    gather(box: THREE.Box3): void {
        this.near = [];
        this.gathered = true;
        this.stats.trianglesTested = 0;
        for (const e of this.entries.values()) {
            if (!visibleAllTheWay(e.mesh)) continue;
            this.measure(e);
            if (!e.box.intersectsBox(box)) continue;
            for (const c of e.colliders) if (c.box.intersectsBox(box)) this.near.push(c);
        }
        this.stats.near = this.near.length;
    }

    private candidates(box: THREE.Box3, everywhere: boolean): Collider[] {
        if (this.gathered && !everywhere) return this.near;
        const out: Collider[] = [];
        for (const e of this.entries.values()) {
            if (!visibleAllTheWay(e.mesh)) continue;
            this.measure(e);
            if (!e.box.intersectsBox(box)) continue;
            for (const c of e.colliders) if (c.box.intersectsBox(box)) out.push(c);
        }
        return out;
    }

    private bvh(c: Collider): TriangleBvh | null {
        return triangleBvhOf(c.geometry, (ms, triangles) => {
            this.stats.bvhBuilds++;
            this.stats.bvhTriangles += triangles;
            this.stats.bvhBuildMs += ms;
        });
    }

    /**
     * The nearest surface along a ray within `maxDistance` (`direction` a unit vector). Meets the gathered meshes, or with
     * `everywhere` every mesh the ray's box reaches (one-off rays: the drop point, the void check).
     */
    raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDistance: number, everywhere = false): WalkSurfaceHit | null {
        _e.copy(origin).addScaledVector(direction, maxDistance);
        _box.makeEmpty().expandByPoint(origin).expandByPoint(_e);
        let best = Infinity;
        let bestCollider: Collider | null = null;
        let bestTriangle = -1;
        let bestBvh: TriangleBvh | null = null;
        for (const c of this.candidates(_box, everywhere)) {
            if (!c.box.intersectsBox(_box)) continue;
            const bvh = this.bvh(c);
            if (!bvh) continue;
            // the segment in the collider's frame: its parameter is the same in both frames (affine maps keep ratios)
            _o.copy(origin).applyMatrix4(c.inverse);
            _a.copy(_e).applyMatrix4(c.inverse).sub(_o);
            const s = bvh.segmentHit(_o.x, _o.y, _o.z, _a.x, _a.y, _a.z, _hitOut);
            if (s * maxDistance < best) { best = s * maxDistance; bestCollider = c; bestTriangle = _hitOut.triangle; bestBvh = bvh; }
        }
        if (!bestCollider || !bestBvh) return null;
        const V = bestBvh.vertices, T = bestBvh.triangles;
        _a.fromArray(V, T[3 * bestTriangle] * 3).applyMatrix4(bestCollider.matrix);
        _b.fromArray(V, T[3 * bestTriangle + 1] * 3).applyMatrix4(bestCollider.matrix);
        _c.fromArray(V, T[3 * bestTriangle + 2] * 3).applyMatrix4(bestCollider.matrix);
        const normal = new THREE.Vector3().subVectors(_c, _b).cross(_a.sub(_b)).normalize();
        if (normal.dot(direction) > 0) normal.negate();
        return { point: origin.clone().addScaledVector(direction, best), normal, distance: best };
    }

    /**
     * Every surface within `radius` of the segment a-b (a capsule): `visit` gets the unit push from the surface to the
     * capsule and the depth to push it out by. A segment that crosses a triangle reports the triangle's normal (facing a)
     * and the full radius.
     */
    capsuleContacts(a: THREE.Vector3, b: THREE.Vector3, radius: number, visit: (push: THREE.Vector3, depth: number) => void): void {
        _box.makeEmpty().expandByPoint(a).expandByPoint(b).expandByScalar(radius);
        const r2 = radius * radius;
        for (const c of this.candidates(_box, false)) {
            if (!c.box.intersectsBox(_box)) continue;
            const bvh = this.bvh(c);
            if (!bvh) continue;
            const local = _localBox.copy(_box).applyMatrix4(c.inverse);
            const V = bvh.vertices, T = bvh.triangles, m = c.matrix;
            bvh.trianglesInBox(local.min.x, local.min.y, local.min.z, local.max.x, local.max.y, local.max.z, k => {
                this.stats.trianglesTested++;
                _ta.fromArray(V, T[3 * k] * 3).applyMatrix4(m);
                _tb.fromArray(V, T[3 * k + 1] * 3).applyMatrix4(m);
                _tc.fromArray(V, T[3 * k + 2] * 3).applyMatrix4(m);
                const d2 = closestSegmentTriangle(a, b, _ta, _tb, _tc, _segPoint, _triPoint);
                if (d2 >= r2) return;
                if (d2 > EPS) {
                    const d = Math.sqrt(d2);
                    _normal.subVectors(_segPoint, _triPoint).divideScalar(d);
                    visit(_normal, radius - d);
                } else {
                    _normal.subVectors(_tc, _tb).cross(_ta.clone().sub(_tb)).normalize();
                    if (_normal.dot(_o.subVectors(a, _triPoint)) < 0) _normal.negate();
                    visit(_normal, radius);
                }
            });
        }
    }
}

const _localBox = new THREE.Box3();
const _ta = new THREE.Vector3();
const _tb = new THREE.Vector3();
const _tc = new THREE.Vector3();
const _tri = new THREE.Triangle();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _r = new THREE.Vector3();

/** Squared distance between segments p1-q1 and p2-q2; the closest points into c1, c2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function closestSegmentSegment(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3, c1: THREE.Vector3, c2: THREE.Vector3): number {
    _d1.subVectors(q1, p1);
    _d2.subVectors(q2, p2);
    _r.subVectors(p1, p2);
    const a = _d1.dot(_d1), e = _d2.dot(_d2), f = _d2.dot(_r);
    let s = 0, t = 0;
    if (a <= EPS && e <= EPS) { s = 0; t = 0; } else if (a <= EPS) { t = THREE.MathUtils.clamp(f / e, 0, 1); } else {
        const c = _d1.dot(_r);
        if (e <= EPS) { s = THREE.MathUtils.clamp(-c / a, 0, 1); } else {
            const b = _d1.dot(_d2), denom = a * e - b * b;
            s = denom > EPS ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
        }
    }
    c1.copy(p1).addScaledVector(_d1, s);
    c2.copy(p2).addScaledVector(_d2, t);
    return c1.distanceToSquared(c2);
}

/**
 * Squared distance between segment p-q and triangle a-b-c; the closest points into onSegment, onTriangle. 0 when the
 * segment crosses the triangle (both points at the crossing).
 */
export function closestSegmentTriangle(p: THREE.Vector3, q: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, onSegment: THREE.Vector3, onTriangle: THREE.Vector3): number {
    _tri.set(a, b, c);
    // the segment crosses the triangle's plane inside the triangle
    _tri.getNormal(_normal);
    const dp = _normal.dot(_p1.subVectors(p, a)), dq = _normal.dot(_p2.subVectors(q, a));
    if ((dp <= 0 && dq >= 0) || (dp >= 0 && dq <= 0)) {
        const den = dp - dq;
        const s = Math.abs(den) > EPS ? dp / den : 0;
        _p1.copy(p).lerp(q, s);
        if (_tri.containsPoint(_p1)) { onSegment.copy(_p1); onTriangle.copy(_p1); return 0; }
    }
    // otherwise the closest pair has an end of the segment against the triangle or the segment against an edge
    let best = Infinity;
    _tri.closestPointToPoint(p, _p2);
    let d = p.distanceToSquared(_p2);
    if (d < best) { best = d; onSegment.copy(p); onTriangle.copy(_p2); }
    _tri.closestPointToPoint(q, _p2);
    d = q.distanceToSquared(_p2);
    if (d < best) { best = d; onSegment.copy(q); onTriangle.copy(_p2); }
    for (const [u, v] of EDGES) {
        d = closestSegmentSegment(p, q, u === 0 ? a : u === 1 ? b : c, v === 0 ? a : v === 1 ? b : c, _e, _p2);
        if (d < best) { best = d; onSegment.copy(_e); onTriangle.copy(_p2); }
    }
    return best;
}

const EDGES: Array<[number, number]> = [[0, 1], [1, 2], [2, 0]];
