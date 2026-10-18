/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Exact 3D convex hull (Quickhull, Barber/Dobkin/Huhdanpaa 1996).
 *
 * Input is a flat xyz array. Output is the hull's own vertex list (only points
 * that lie on the hull) and outward-facing CCW triangles indexing into it.
 * Coplanar hull faces come out triangulated.
 */

export type HullVec3 = [number, number, number];

export interface ConvexHull3D {
  vertices: HullVec3[];
  /** Triangle indices into `vertices`, counter-clockwise seen from outside. */
  indices: number[];
  /** Index of each hull vertex in the input point array. */
  sourceIndices: number[];
}

/** Raised when the input spans fewer than three dimensions (all points collinear or coplanar). */
export class DegenerateConvexHullError extends Error {
  readonly code = 'CONVEX_HULL_DEGENERATE';
  constructor(message: string) {
    super(message);
    this.name = 'DegenerateConvexHullError';
  }
}

interface HullFace {
  a: number;
  b: number;
  c: number;
  nx: number;
  ny: number;
  nz: number;
  d: number;
  outside: number[];
  alive: boolean;
}

export function computeConvexHull3D(points: ArrayLike<number>): ConvexHull3D {
  const n = Math.floor(points.length / 3);
  if (n < 4) {
    throw new DegenerateConvexHullError(`A 3D convex hull needs at least 4 points; got ${n}.`);
  }
  const px = (i: number) => points[i * 3];
  const py = (i: number) => points[i * 3 + 1];
  const pz = (i: number) => points[i * 3 + 2];

  // Extreme points along each axis.
  const minIdx = [0, 0, 0];
  const maxIdx = [0, 0, 0];
  for (let i = 1; i < n; i++) {
    for (let k = 0; k < 3; k++) {
      const v = points[i * 3 + k];
      if (v < points[minIdx[k] * 3 + k]) minIdx[k] = i;
      if (v > points[maxIdx[k] * 3 + k]) maxIdx[k] = i;
    }
  }
  let span = 0;
  for (let k = 0; k < 3; k++) {
    span = Math.max(span, Math.abs(points[maxIdx[k] * 3 + k]), Math.abs(points[minIdx[k] * 3 + k]));
  }
  // Tolerance scaled to the coordinate magnitude (float32 mesh data).
  const eps = Math.max(span, 1e-12) * 1e-7 * 3;

  // Initial simplex: farthest extreme pair, then farthest from that line, then from that plane.
  let i0 = minIdx[0], i1 = maxIdx[0], best = -1;
  for (let k = 0; k < 3; k++) {
    const d = Math.hypot(px(maxIdx[k]) - px(minIdx[k]), py(maxIdx[k]) - py(minIdx[k]), pz(maxIdx[k]) - pz(minIdx[k]));
    if (d > best) { best = d; i0 = minIdx[k]; i1 = maxIdx[k]; }
  }
  if (best <= eps) {
    throw new DegenerateConvexHullError('All points coincide; no 3D convex hull exists.');
  }
  const lx = px(i1) - px(i0), ly = py(i1) - py(i0), lz = pz(i1) - pz(i0);
  let i2 = -1; best = -1;
  for (let i = 0; i < n; i++) {
    const vx = px(i) - px(i0), vy = py(i) - py(i0), vz = pz(i) - pz(i0);
    const cx = ly * vz - lz * vy, cy = lz * vx - lx * vz, cz = lx * vy - ly * vx;
    const d = Math.hypot(cx, cy, cz) / lengthOrOne(lx, ly, lz);
    if (d > best) { best = d; i2 = i; }
  }
  if (best <= eps) {
    throw new DegenerateConvexHullError('All points are collinear; no 3D convex hull exists.');
  }
  const ax = px(i2) - px(i0), ay = py(i2) - py(i0), az = pz(i2) - pz(i0);
  let pnx = ly * az - lz * ay, pny = lz * ax - lx * az, pnz = lx * ay - ly * ax;
  const pl = Math.hypot(pnx, pny, pnz);
  pnx /= pl; pny /= pl; pnz /= pl;
  let i3 = -1; best = -1;
  for (let i = 0; i < n; i++) {
    const d = Math.abs((px(i) - px(i0)) * pnx + (py(i) - py(i0)) * pny + (pz(i) - pz(i0)) * pnz);
    if (d > best) { best = d; i3 = i; }
  }
  if (best <= eps) {
    throw new DegenerateConvexHullError('All points are coplanar; no 3D convex hull exists (the hull is a flat polygon).');
  }

  const faces: HullFace[] = [];
  const makeFace = (a: number, b: number, c: number): HullFace => {
    const ux = px(b) - px(a), uy = py(b) - py(a), uz = pz(b) - pz(a);
    const vx = px(c) - px(a), vy = py(c) - py(a), vz = pz(c) - pz(a);
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    return { a, b, c, nx, ny, nz, d: nx * px(a) + ny * py(a) + nz * pz(a), outside: [], alive: true };
  };
  const dist = (f: HullFace, i: number) => f.nx * px(i) + f.ny * py(i) + f.nz * pz(i) - f.d;

  // Orient the tetrahedron so every face normal points away from the fourth vertex.
  const tet = [i0, i1, i2, i3];
  const tetFaces: [number, number, number, number][] = [
    [i0, i1, i2, i3], [i0, i3, i1, i2], [i0, i2, i3, i1], [i1, i3, i2, i0]
  ];
  for (const [a, b, c, opp] of tetFaces) {
    let f = makeFace(a, b, c);
    if (dist(f, opp) > 0) f = makeFace(a, c, b);
    faces.push(f);
  }

  const assign = (candidates: Iterable<number>, targets: HullFace[]) => {
    for (const i of candidates) {
      let bestFace: HullFace | null = null;
      let bestD = eps;
      for (const f of targets) {
        const d = dist(f, i);
        if (d > bestD) { bestD = d; bestFace = f; }
      }
      if (bestFace) bestFace.outside.push(i);
    }
  };
  const tetSet = new Set(tet);
  const initial: number[] = [];
  for (let i = 0; i < n; i++) if (!tetSet.has(i)) initial.push(i);
  assign(initial, faces);

  // Directed edge (u -> v) of a live face -> that face. The neighbour across an
  // edge is the face holding the reverse edge (v -> u).
  const edgeKey = (u: number, v: number) => u * n + v;
  const edgeOwner = new Map<number, HullFace>();
  const linkFace = (f: HullFace) => {
    edgeOwner.set(edgeKey(f.a, f.b), f);
    edgeOwner.set(edgeKey(f.b, f.c), f);
    edgeOwner.set(edgeKey(f.c, f.a), f);
  };
  faces.forEach(linkFace);
  const pending: HullFace[] = faces.filter(f => f.outside.length > 0);

  while (pending.length > 0) {
    const face = pending.pop()!;
    if (!face.alive || face.outside.length === 0) continue;

    let eye = face.outside[0];
    let eyeD = dist(face, eye);
    for (const i of face.outside) {
      const d = dist(face, i);
      if (d > eyeD) { eyeD = d; eye = i; }
    }

    // Flood the connected set of faces the eye point can see; collect the horizon.
    const visible = new Set<HullFace>([face]);
    const stack: HullFace[] = [face];
    const horizon: [number, number][] = [];
    while (stack.length > 0) {
      const f = stack.pop()!;
      for (const [u, v] of [[f.a, f.b], [f.b, f.c], [f.c, f.a]] as [number, number][]) {
        const g = edgeOwner.get(edgeKey(v, u));
        if (!g || visible.has(g)) continue;
        if (dist(g, eye) > eps) {
          visible.add(g);
          stack.push(g);
        } else {
          horizon.push([u, v]);
        }
      }
    }

    const orphans: number[] = [];
    for (const f of visible) {
      f.alive = false;
      for (const i of f.outside) if (i !== eye) orphans.push(i);
      f.outside = [];
      edgeOwner.delete(edgeKey(f.a, f.b));
      edgeOwner.delete(edgeKey(f.b, f.c));
      edgeOwner.delete(edgeKey(f.c, f.a));
    }
    const created: HullFace[] = [];
    for (const [u, v] of horizon) {
      const nf = makeFace(u, v, eye);
      faces.push(nf);
      created.push(nf);
      linkFace(nf);
    }
    assign(orphans, created);
    for (const nf of created) if (nf.outside.length > 0) pending.push(nf);
  }

  const remap = new Map<number, number>();
  const vertices: HullVec3[] = [];
  const sourceIndices: number[] = [];
  const indices: number[] = [];
  for (const f of faces) {
    if (!f.alive) continue;
    for (const i of [f.a, f.b, f.c]) {
      let j = remap.get(i);
      if (j === undefined) {
        j = vertices.length;
        remap.set(i, j);
        vertices.push([px(i), py(i), pz(i)]);
        sourceIndices.push(i);
      }
      indices.push(j);
    }
  }
  return { vertices, indices, sourceIndices };
}

function lengthOrOne(x: number, y: number, z: number): number {
  return Math.hypot(x, y, z) || 1;
}
