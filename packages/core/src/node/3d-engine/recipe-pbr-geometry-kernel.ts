/**
 * Recipe PBR Geometry Kernel
 *
 * Moves everything the baked 1K PBR suite derived from geometry out of per-mesh
 * textures and into standard/app-specific vertex attributes, so the runtime shader
 * can evaluate it at full resolution:
 *
 * - NORMAL: angle-weighted smooth normals split at the sharp-edge threshold
 *   (replaces the anti-faceting normal bake; standard glTF, no shader needed).
 * - Per-corner distance to each triangle edge. Distance to a line is affine inside a
 *   triangle, so linear interpolation reproduces the exact metric distance to every sharp
 *   edge per fragment. Stored compactly as _SBEDGEH (altitude to the opposite edge) plus
 *   corner/sharp flags; the vertex shader rebuilds the three distances.
 * - _SBNBRA/_SBNBRB: octahedral neighbouring face normal across each edge (chamfer = n_face + n_nbr).
 * - _SBMASK: R = voxel ambient occlusion, G = height above ground, A = edge flags.
 *
 * Plus seamless, metric-scale detail maps shared by every mesh (replaces the
 * aliased procedural micro-detail baked into each atlas).
 */

export interface RecipeSubmeshInput {
  positions: Float32Array;
  uvs: Float32Array;
  indices?: Uint16Array | Uint32Array | null;
}

export interface RecipeKernelOptions {
  sharpAngleDeg?: number;
  weldEpsilon?: number;
  edgeSentinel?: number;
}

export interface RecipeSubmeshGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  edgeDistances: Float32Array;
  neighborNormals: [Int8Array, Int8Array, Int8Array];
  indices: Uint32Array;
  vertexSourceIndex: Uint32Array;
  /** Corner slot (0..2) of each vertex within its triangle; only meaningful for sharp-triangle corners. */
  cornerIndex: Uint8Array;
  /** Distance from the vertex to its opposite edge; only meaningful for sharp-triangle corners. */
  cornerAltitude: Float32Array;
  /** Bits 0-2: which of the triangle's edges are sharp (edge e is opposite corner e). */
  sharpEdgeBits: Uint8Array;
  sharpEdgeCount: number;
  smoothEdgeCount: number;
  sharpTriangleCount: number;
}

export const RECIPE_EDGE_SENTINEL = 1000;

function readTri(indices: RecipeSubmeshInput['indices'], t: number, k: number): number {
  return indices ? indices[t * 3 + k] : t * 3 + k;
}

export function buildRecipeSubmeshGeometry(input: RecipeSubmeshInput, options: RecipeKernelOptions = {}): RecipeSubmeshGeometry {
  const sharpCos = Math.cos(((options.sharpAngleDeg ?? 45) * Math.PI) / 180);
  const invEps = 1 / (options.weldEpsilon ?? 0.001);
  const sentinel = options.edgeSentinel ?? RECIPE_EDGE_SENTINEL;
  const { positions, uvs, indices } = input;
  const numTris = indices ? indices.length / 3 : positions.length / 9;
  const numSrcVerts = positions.length / 3;

  // Weld vertices spatially so UV seams do not break adjacency.
  const weldId = new Int32Array(numSrcVerts);
  const weldMap = new Map<string, number>();
  for (let v = 0; v < numSrcVerts; v++) {
    const key = `${Math.round(positions[v * 3] * invEps)},${Math.round(positions[v * 3 + 1] * invEps)},${Math.round(positions[v * 3 + 2] * invEps)}`;
    let id = weldMap.get(key);
    if (id === undefined) { id = weldMap.size; weldMap.set(key, id); }
    weldId[v] = id;
  }

  const faceN = new Float32Array(numTris * 3);
  const cornerAngle = new Float32Array(numTris * 3);
  const altitude = new Float32Array(numTris * 3);
  for (let t = 0; t < numTris; t++) {
    const p = [0, 1, 2].map(k => {
      const i = readTri(indices, t, k);
      return [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
    });
    const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
    const e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
    let nx = e1[1] * e2[2] - e1[2] * e2[1];
    let ny = e1[2] * e2[0] - e1[0] * e2[2];
    let nz = e1[0] * e2[1] - e1[1] * e2[0];
    const twiceArea = Math.hypot(nx, ny, nz);
    const inv = twiceArea > 0 ? 1 / twiceArea : 0;
    nx *= inv; ny *= inv; nz *= inv;
    faceN[t * 3] = nx; faceN[t * 3 + 1] = ny; faceN[t * 3 + 2] = nz;

    for (let k = 0; k < 3; k++) {
      const a = p[k], b = p[(k + 1) % 3], c = p[(k + 2) % 3];
      const d1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const d2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const l1 = Math.hypot(d1[0], d1[1], d1[2]) || 1;
      const l2 = Math.hypot(d2[0], d2[1], d2[2]) || 1;
      cornerAngle[t * 3 + k] = Math.acos(Math.max(-1, Math.min(1, (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) / (l1 * l2))));
      // Altitude from corner k to its opposite edge (b, c)
      const oppLen = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
      altitude[t * 3 + k] = oppLen > 0 ? twiceArea / oppLen : 0;
    }
  }

  // Edge adjacency on welded ids. Edge k of a triangle is opposite corner k.
  const edgeMap = new Map<string, number[]>();
  for (let t = 0; t < numTris; t++) {
    for (let k = 0; k < 3; k++) {
      const a = weldId[readTri(indices, t, (k + 1) % 3)];
      const b = weldId[readTri(indices, t, (k + 2) % 3)];
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      let list = edgeMap.get(key);
      if (!list) { list = []; edgeMap.set(key, list); }
      list.push(t * 3 + k);
    }
  }

  const edgeNeighbor = new Int32Array(numTris * 3).fill(-1);
  const edgeSharp = new Uint8Array(numTris * 3);
  let sharpEdgeCount = 0;
  let smoothEdgeCount = 0;
  for (const list of edgeMap.values()) {
    if (list.length !== 2) continue;
    const [ea, eb] = list;
    const ta = (ea / 3) | 0, tb = (eb / 3) | 0;
    const dot = faceN[ta * 3] * faceN[tb * 3] + faceN[ta * 3 + 1] * faceN[tb * 3 + 1] + faceN[ta * 3 + 2] * faceN[tb * 3 + 2];
    edgeNeighbor[ea] = tb;
    edgeNeighbor[eb] = ta;
    if (dot < sharpCos) {
      edgeSharp[ea] = 1;
      edgeSharp[eb] = 1;
      sharpEdgeCount++;
    } else {
      smoothEdgeCount++;
    }
  }

  // Faces incident to each welded vertex, for auto-smooth normals.
  const vertFaces: number[][] = Array.from({ length: weldMap.size }, () => []);
  for (let t = 0; t < numTris; t++) {
    for (let k = 0; k < 3; k++) vertFaces[weldId[readTri(indices, t, k)]].push(t * 3 + k);
  }

  const outPos: number[] = [];
  const outNrm: number[] = [];
  const outUv: number[] = [];
  const outEdge: number[] = [];
  const outNbr: [number[], number[], number[]] = [[], [], []];
  const outSrc: number[] = [];
  const outCorner: number[] = [];
  const outAltitude: number[] = [];
  const outSharpBits: number[] = [];
  const outIdx = new Uint32Array(numTris * 3);
  const dedupe = new Map<string, number>();
  let sharpTriangleCount = 0;

  for (let t = 0; t < numTris; t++) {
    const fnx = faceN[t * 3], fny = faceN[t * 3 + 1], fnz = faceN[t * 3 + 2];
    const triSharp = edgeSharp[t * 3] | edgeSharp[t * 3 + 1] | edgeSharp[t * 3 + 2];
    if (triSharp) sharpTriangleCount++;

    const nbr: number[][] = [0, 1, 2].map(e => {
      const nt = edgeNeighbor[t * 3 + e];
      if (!edgeSharp[t * 3 + e] || nt < 0) return [0, 0, 0, 0];
      return [
        Math.round(faceN[nt * 3] * 127),
        Math.round(faceN[nt * 3 + 1] * 127),
        Math.round(faceN[nt * 3 + 2] * 127),
        127
      ];
    });

    for (let k = 0; k < 3; k++) {
      const src = readTri(indices, t, k);
      let sx = 0, sy = 0, sz = 0;
      for (const corner of vertFaces[weldId[src]]) {
        const ft = (corner / 3) | 0;
        const gx = faceN[ft * 3], gy = faceN[ft * 3 + 1], gz = faceN[ft * 3 + 2];
        if (gx * fnx + gy * fny + gz * fnz < sharpCos) continue;
        const w = cornerAngle[corner];
        sx += gx * w; sy += gy * w; sz += gz * w;
      }
      const sl = Math.hypot(sx, sy, sz);
      if (sl > 0) { sx /= sl; sy /= sl; sz /= sl; } else { sx = fnx; sy = fny; sz = fnz; }

      const edge = [0, 1, 2].map(e => (edgeSharp[t * 3 + e] ? (e === k ? altitude[t * 3 + k] : 0) : sentinel));

      // Corners of triangles with sharp edges are unique; smooth corners share by source vertex + normal.
      const key = triSharp
        ? `s${t}:${k}`
        : `${src}:${Math.round(sx * 1e4)},${Math.round(sy * 1e4)},${Math.round(sz * 1e4)}`;
      let vi = dedupe.get(key);
      if (vi === undefined) {
        vi = outSrc.length;
        dedupe.set(key, vi);
        outSrc.push(src);
        outPos.push(positions[src * 3], positions[src * 3 + 1], positions[src * 3 + 2]);
        outUv.push(uvs[src * 2] ?? 0, uvs[src * 2 + 1] ?? 0);
        outNrm.push(sx, sy, sz);
        outEdge.push(edge[0], edge[1], edge[2]);
        for (let e = 0; e < 3; e++) outNbr[e].push(...nbr[e]);
        outCorner.push(triSharp ? k : 0);
        outAltitude.push(triSharp ? altitude[t * 3 + k] : 0);
        outSharpBits.push(edgeSharp[t * 3] | (edgeSharp[t * 3 + 1] << 1) | (edgeSharp[t * 3 + 2] << 2));
      }
      outIdx[t * 3 + k] = vi;
    }
  }

  return {
    positions: new Float32Array(outPos),
    normals: new Float32Array(outNrm),
    uvs: new Float32Array(outUv),
    edgeDistances: new Float32Array(outEdge),
    neighborNormals: [new Int8Array(outNbr[0]), new Int8Array(outNbr[1]), new Int8Array(outNbr[2])],
    indices: outIdx,
    vertexSourceIndex: new Uint32Array(outSrc),
    cornerIndex: new Uint8Array(outCorner),
    cornerAltitude: new Float32Array(outAltitude),
    sharpEdgeBits: new Uint8Array(outSharpBits),
    sharpEdgeCount,
    smoothEdgeCount,
    sharpTriangleCount
  };
}

type GeometryLike = Pick<RecipeSubmeshGeometry, 'positions' | 'normals' | 'indices'>;

export interface GroundHeightField {
  cellSize: number;
  sample(x: number, z: number): number;
}

/** Lowest upward-facing surface per XZ cell; empty cells borrow from the nearest known cell. */
export function buildGroundHeightField(meshes: GeometryLike[], cellSize = 6, upwardCos = 0.7): GroundHeightField {
  const grid = new Map<string, number>();
  let globalMin = Infinity;
  for (const m of meshes) {
    const P = m.positions, I = m.indices;
    for (let t = 0; t < I.length / 3; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
      const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const len = Math.hypot(nx, ny, nz);
      if (len === 0 || ny / len < upwardCos) continue;
      const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
      const key = `${Math.floor(cx / cellSize)},${Math.floor(cz / cellSize)}`;
      const cur = grid.get(key);
      if (cur === undefined || cy < cur) grid.set(key, cy);
      if (cy < globalMin) globalMin = cy;
    }
  }
  if (!Number.isFinite(globalMin)) globalMin = 0;

  const cells = [...grid.entries()].map(([k, y]) => {
    const [gx, gz] = k.split(',').map(Number);
    return { gx, gz, y };
  });
  const cache = new Map<string, number>();

  return {
    cellSize,
    sample(x: number, z: number): number {
      const gx = Math.floor(x / cellSize), gz = Math.floor(z / cellSize);
      const key = `${gx},${gz}`;
      const direct = grid.get(key);
      if (direct !== undefined) return direct;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      let best = globalMin, bestD = Infinity;
      for (const c of cells) {
        const d = (c.gx - gx) ** 2 + (c.gz - gz) ** 2;
        if (d < bestD || (d === bestD && c.y < best)) { bestD = d; best = c.y; }
      }
      cache.set(key, best);
      return best;
    }
  };
}

export interface VoxelAoOptions {
  cellSize?: number;
  maxDistance?: number;
  rayCount?: number;
  maxGridDim?: number;
}

/** Hemisphere ambient occlusion against a voxelized copy of every mesh (cosine-weighted, distance-attenuated). */
export function computeVoxelAmbientOcclusion(meshes: GeometryLike[], options: VoxelAoOptions = {}): Float32Array[] {
  const maxDistance = options.maxDistance ?? 12;
  const rayCount = options.rayCount ?? 16;
  const maxGridDim = options.maxGridDim ?? 640;

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      const x = m.positions[i], y = m.positions[i + 1], z = m.positions[i + 2];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const cell = Math.max(options.cellSize ?? 0.5, extent / (maxGridDim - 4));
  const ox = minX - 2 * cell, oy = minY - 2 * cell, oz = minZ - 2 * cell;
  const nx = Math.ceil((maxX - ox) / cell) + 3, ny = Math.ceil((maxY - oy) / cell) + 3, nz = Math.ceil((maxZ - oz) / cell) + 3;
  const vox = new Uint8Array(nx * ny * nz);
  const mark = (x: number, y: number, z: number) => {
    const ix = Math.floor((x - ox) / cell), iy = Math.floor((y - oy) / cell), iz = Math.floor((z - oz) / cell);
    vox[(iy * nz + iz) * nx + ix] = 1;
  };

  for (const m of meshes) {
    const P = m.positions, I = m.indices;
    for (let t = 0; t < I.length / 3; t++) {
      const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
      const longest = Math.max(
        Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]),
        Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]),
        Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2])
      );
      const steps = Math.max(1, Math.ceil((longest / cell) * 2));
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps - i; j++) {
          const u = i / steps, v = j / steps, w = 1 - u - v;
          mark(
            w * P[a] + u * P[b] + v * P[c],
            w * P[a + 1] + u * P[b + 1] + v * P[c + 1],
            w * P[a + 2] + u * P[b + 2] + v * P[c + 2]
          );
        }
      }
    }
  }

  // Cosine-distributed hemisphere directions around +Z (Fibonacci spiral).
  const dirs: number[][] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < rayCount; i++) {
    const r = Math.sqrt((i + 0.5) / rayCount);
    const phi = i * golden;
    dirs.push([r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - r * r)]);
  }

  const step = cell * 0.5;
  const occupied = (x: number, y: number, z: number) => {
    const ix = Math.floor((x - ox) / cell), iy = Math.floor((y - oy) / cell), iz = Math.floor((z - oz) / cell);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return false;
    return vox[(iy * nz + iz) * nx + ix] === 1;
  };

  return meshes.map(m => {
    const count = m.positions.length / 3;
    const ao = new Float32Array(count);
    for (let v = 0; v < count; v++) {
      const px = m.positions[v * 3], py = m.positions[v * 3 + 1], pz = m.positions[v * 3 + 2];
      const n = [m.normals[v * 3], m.normals[v * 3 + 1], m.normals[v * 3 + 2]];
      const helper = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      let tx = helper[1] * n[2] - helper[2] * n[1], ty = helper[2] * n[0] - helper[0] * n[2], tz = helper[0] * n[1] - helper[1] * n[0];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      const bx = n[1] * tz - n[2] * ty, by = n[2] * tx - n[0] * tz, bz = n[0] * ty - n[1] * tx;
      const sx = px + n[0] * cell, sy = py + n[1] * cell, sz = pz + n[2] * cell;

      let occlusion = 0;
      for (const d of dirs) {
        const rx = tx * d[0] + bx * d[1] + n[0] * d[2];
        const ry = ty * d[0] + by * d[1] + n[1] * d[2];
        const rz = tz * d[0] + bz * d[1] + n[2] * d[2];
        for (let s = step; s <= maxDistance; s += step) {
          if (occupied(sx + rx * s, sy + ry * s, sz + rz * s)) {
            occlusion += 1 - s / maxDistance;
            break;
          }
        }
      }
      ao[v] = Math.max(0, Math.min(1, 1 - occlusion / rayCount));
    }
    return ao;
  });
}

export function packRecipeMask(ao: Float32Array, heightAboveGround: Float32Array, maxHeight = 8, edgeFlags?: Uint8Array): Uint8Array {
  const out = new Uint8Array(ao.length * 4);
  for (let i = 0; i < ao.length; i++) {
    out[i * 4] = Math.round(Math.max(0, Math.min(1, ao[i])) * 255);
    out[i * 4 + 1] = Math.round(Math.max(0, Math.min(1, heightAboveGround[i] / maxHeight)) * 255);
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = edgeFlags ? edgeFlags[i] : 255;
  }
  return out;
}

export function octEncode(x: number, y: number, z: number): [number, number] {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let px = x / l1, py = y / l1;
  if (z < 0) {
    const ox = (1 - Math.abs(py)) * (px >= 0 ? 1 : -1);
    const oy = (1 - Math.abs(px)) * (py >= 0 ? 1 : -1);
    px = ox; py = oy;
  }
  return [px, py];
}

export function octDecode(px: number, py: number): [number, number, number] {
  let x = px, y = py;
  const z = 1 - Math.abs(x) - Math.abs(y);
  const t = Math.max(-z, 0);
  x += x >= 0 ? -t : t;
  y += y >= 0 ? -t : t;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

export interface CompactRecipeAttributes {
  /** int8 normalized, 4 bytes per vertex (xyz + pad) for 4-byte vertex alignment. */
  normals: Int8Array;
  /** uint16 normalized UVs, or null when any coordinate leaves [0, 1]. */
  uvs: Uint16Array | null;
  edgeAltitude: Float32Array;
  /** Bits 0-1: corner slot, bits 2-4: sharp flags for edges 0..2. */
  edgeFlags: Uint8Array;
  /** int8 normalized octahedral neighbour normals: (edge0.xy, edge1.xy). */
  neighborOctA: Int8Array;
  /** int8 normalized octahedral neighbour normals: (edge2.xy, 0, 0). */
  neighborOctB: Int8Array;
}

export function encodeCompactRecipeAttributes(geo: RecipeSubmeshGeometry): CompactRecipeAttributes {
  const n = geo.positions.length / 3;
  const normals = new Int8Array(n * 4);
  const edgeFlags = new Uint8Array(n);
  const neighborOctA = new Int8Array(n * 4);
  const neighborOctB = new Int8Array(n * 4);
  const q = (v: number) => Math.max(-127, Math.min(127, Math.round(v * 127)));

  for (let v = 0; v < n; v++) {
    for (let c = 0; c < 3; c++) normals[v * 4 + c] = q(geo.normals[v * 3 + c]);
    edgeFlags[v] = (geo.cornerIndex[v] & 3) | ((geo.sharpEdgeBits[v] & 7) << 2);
    for (let e = 0; e < 3; e++) {
      const src = geo.neighborNormals[e];
      if (src[v * 4 + 3] === 0) continue;
      const [ox, oy] = octEncode(src[v * 4], src[v * 4 + 1], src[v * 4 + 2]);
      const dst = e < 2 ? neighborOctA : neighborOctB;
      const off = e === 1 ? 2 : 0;
      dst[v * 4 + off] = q(ox);
      dst[v * 4 + off + 1] = q(oy);
    }
  }

  let uvs: Uint16Array | null = new Uint16Array(n * 2);
  for (let i = 0; i < geo.uvs.length; i++) {
    const u = geo.uvs[i];
    if (!(u >= 0 && u <= 1)) { uvs = null; break; }
    uvs[i] = Math.round(u * 65535);
  }

  return { normals, uvs, edgeAltitude: geo.cornerAltitude, edgeFlags, neighborOctA, neighborOctB };
}

/** Mirrors the vertex-shader reconstruction of the per-corner edge distance vector. */
export function decodeCompactEdgeDistances(altitude: number, flags: number, sentinel = RECIPE_EDGE_SENTINEL): [number, number, number] {
  const k = flags & 3;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const sharp = (flags >> (2 + c)) & 1;
    out[c] = sharp ? (c === k ? altitude : 0) : sentinel;
  }
  return out;
}

export type DetailMapKind = 'stone' | 'asphalt' | 'foliage';

export interface TileableDetailMap {
  kind: DetailMapKind;
  size: number;
  tileMeters: number;
  /** RGB = tangent-space normal, A = height (0..255). */
  rgba: Uint8Array;
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(x: number, y: number, period: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const w = (v: number) => ((v % period) + period) % period;
  const a = hash2(w(ix), w(iy), seed), b = hash2(w(ix + 1), w(iy), seed);
  const c = hash2(w(ix), w(iy + 1), seed), d = hash2(w(ix + 1), w(iy + 1), seed);
  return (a * (1 - ux) + b * ux) * (1 - uy) + (c * (1 - ux) + d * ux) * uy;
}

function periodicFbm(x: number, y: number, period: number, octaves: number, seed: number): number {
  let v = 0, amp = 0.5, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const f = 1 << o;
    v += amp * periodicValueNoise(x * f, y * f, period * f, seed + o * 17);
    norm += amp;
    amp *= 0.5;
  }
  return v / norm;
}

/** F1 and F2 Worley distances on a grid that repeats every periodX × periodY cells. */
function periodicWorley(x: number, y: number, periodX: number, periodY: number, seed: number): { f1: number; f2: number } {
  const ix = Math.floor(x), iy = Math.floor(y);
  let f1 = 9, f2 = 9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy;
      const wx = ((cx % periodX) + periodX) % periodX, wy = ((cy % periodY) + periodY) % periodY;
      const px = cx + hash2(wx, wy, seed) - x;
      const py = cy + hash2(wx, wy, seed + 101) - y;
      const d = Math.hypot(px, py);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return { f1, f2 };
}

const DETAIL_SPECS: Record<DetailMapKind, { tileMeters: number; bump: number; height: (u: number, v: number) => number }> = {
  // Roman travertine: voids elongated along horizontal bedding, calcite grain, soft undulation.
  stone: {
    tileMeters: 0.8,
    bump: 3.2,
    height: (u, v) => {
      const grain = periodicFbm(u * 16, v * 16, 16, 5, 11);
      const bedding = periodicFbm(u * 2, v * 24, 2, 3, 23);
      const w = periodicWorley(u * 10, v * 40, 10, 40, 37);
      const warp = periodicFbm(u * 8, v * 8, 8, 2, 41);
      // Porosity clusters in horizontal bands rather than covering the block evenly.
      const band = periodicFbm(u * 3, v * 10, 3, 3, 59);
      const poreMask = Math.min(1, Math.max(0, (band - 0.5) / 0.15));
      const pore = Math.max(0, 1 - w.f1 / (0.14 + 0.18 * warp)) * poreMask;
      return 0.35 * bedding + 0.5 * grain - 0.6 * pore * pore;
    }
  },
  // Asphalt: packed aggregate stones with bitumen between.
  asphalt: {
    tileMeters: 0.5,
    bump: 4.0,
    height: (u, v) => {
      const w = periodicWorley(u * 48, v * 48, 48, 48, 53);
      const stones = Math.min(1, (w.f2 - w.f1) * 3.5);
      const fine = periodicFbm(u * 96, v * 96, 96, 2, 71);
      return 0.7 * stones + 0.3 * fine;
    }
  },
  // Foliage: leaf clumps with Voronoi cellular facets and dark gaps.
  foliage: {
    tileMeters: 1.2,
    bump: 3.8,
    height: (u, v) => {
      // 5cm Voronoi leaf cells (24 cells per 1.2m tile)
      const w = periodicWorley(u * 24, v * 24, 24, 24, 89);
      const cellFacet = Math.min(1, (w.f2 - w.f1) * 2.6);
      const leafRipples = periodicFbm(u * 72, v * 72, 72, 3, 97);
      // Cellular planar tilt modulation for dynamic specular leaf flutter
      return 0.55 * cellFacet + 0.45 * leafRipples;
    }
  }
};

export function generateTileableDetailMap(kind: DetailMapKind, size = 512): TileableDetailMap {
  const spec = DETAIL_SPECS[kind];
  const h = new Float32Array(size * size);
  let lo = Infinity, hi = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const val = spec.height(x / size, y / size);
      h[y * size + x] = val;
      if (val < lo) lo = val;
      if (val > hi) hi = val;
    }
  }
  const range = hi - lo || 1;
  for (let i = 0; i < h.length; i++) h[i] = (h[i] - lo) / range;

  const rgba = new Uint8Array(size * size * 4);
  const at = (x: number, y: number) => h[(((y + size) % size) * size) + ((x + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * spec.bump * 0.25, ny = -dy * spec.bump * 0.25, nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len; ny /= len; nz /= len;
      const o = (y * size + x) * 4;
      rgba[o] = Math.round((nx * 0.5 + 0.5) * 255);
      rgba[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      rgba[o + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      rgba[o + 3] = Math.round(h[y * size + x] * 255);
    }
  }
  return { kind, size, tileMeters: spec.tileMeters, rgba };
}

export const RecipePbrGeometryKernel = {
  buildRecipeSubmeshGeometry,
  buildGroundHeightField,
  computeVoxelAmbientOcclusion,
  packRecipeMask,
  generateTileableDetailMap
};
