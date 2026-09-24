/**
 * Virtual Specular Bevel & Curvature Anti-Faceting Normal Kernel
 *
 * Implements Phase 3 SOTA geometric normal synthesis for standard glTF 2.0 PBR:
 * 1. 5mm Virtual Specular Bevel: Smoothly rounds sharp dihedral edges (>45°)
 *    within 5mm to produce continuous specular highlight glints along stone cornices.
 * 2. Curvature Anti-Faceting: Smooths low-poly facet banding across Roman arches,
 *    vaults, and circular columns using an angle-weighted smooth normal field.
 *
 * Enforces:
 * - 0.000 mm geometric drift lock (zero mesh geometry modification).
 * - Standard glTF 2.0 PBR tangent-space normal map compliance.
 * - Zero custom runtime shaders required (works in Three.js, Unreal, Unity, WebXR).
 */

export interface EdgeAdjacencyRecord {
  v0Key: string;
  v1Key: string;
  p0: [number, number, number];
  p1: [number, number, number];
  triangles: Array<{
    triIdx: number;
    edgeIdx: number;
  }>;
  dihedralAngleDeg: number;
  cosDihedral: number;
  isSharp: boolean;      // dihedralAngleDeg > 45°
  isSmooth: boolean;     // dihedralAngleDeg <= 45°
  chamferNormal: [number, number, number];
}

export interface TriangleGeometricFrame {
  triIdx: number;
  normal: [number, number, number];
  tangent: [number, number, number];
  bitangent: [number, number, number];
  v0: [number, number, number];
  v1: [number, number, number];
  v2: [number, number, number];
  v0Key: string;
  v1Key: string;
  v2Key: string;
  hasSharpEdge: boolean;
  sharpEdges: EdgeAdjacencyRecord[];
  isCurvedSurface: boolean;
}

export interface SubmeshAdjacencyGraph {
  triangles: TriangleGeometricFrame[];
  sharpEdgeCount: number;
  smoothEdgeCount: number;
  boundaryEdgeCount: number;
  vertexSmoothNormals: Map<string, [number, number, number]>;
}

export interface GeometricNormalResult {
  tangentNormal: [number, number, number]; // [nx, ny, nz] in tangent space (where [0,0,1] is flat)
  worldNormal: [number, number, number];
  isBevel: boolean;
  bevelWeight: number;
  bevelDistanceMeters: number;
  isAntiFaceted: boolean;
  roughnessModifier: number; // e.g. -0.08 on sharp bevel for edge burnishing
  aoModifier: number;
}

/**
 * Builds topology and dihedral edge adjacency graph for a submesh.
 */
export function buildSubmeshAdjacency(
  positions: Float32Array | number[],
  indices?: Uint16Array | Uint32Array | number[] | null,
  uvs?: Float32Array | number[] | null,
  posQuantEpsilon = 0.001 // 1mm spatial welding
): SubmeshAdjacencyGraph {
  const numTriangles = indices ? indices.length / 3 : positions.length / 9;
  const invEps = 1.0 / posQuantEpsilon;

  function quantizeKey(x: number, y: number, z: number): string {
    return `${Math.round(x * invEps)},${Math.round(y * invEps)},${Math.round(z * invEps)}`;
  }

  // 1. Compute face normals, tangent frames, and triangle data
  const triFrames: TriangleGeometricFrame[] = new Array(numTriangles);

  for (let t = 0; t < numTriangles; t++) {
    let i0: number, i1: number, i2: number;
    if (indices) {
      i0 = indices[t * 3];
      i1 = indices[t * 3 + 1];
      i2 = indices[t * 3 + 2];
    } else {
      i0 = t * 3;
      i1 = t * 3 + 1;
      i2 = t * 3 + 2;
    }

    const v0: [number, number, number] = [positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]];
    const v1: [number, number, number] = [positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]];
    const v2: [number, number, number] = [positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]];

    // Edge vectors
    const ax = v1[0] - v0[0], ay = v1[1] - v0[1], az = v1[2] - v0[2];
    const bx = v2[0] - v0[0], by = v2[1] - v0[1], bz = v2[2] - v0[2];

    // Face normal
    let fnx = ay * bz - az * by;
    let fny = az * bx - ax * bz;
    let fnz = ax * by - ay * bx;
    const nLen = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz) || 1.0;
    fnx /= nLen; fny /= nLen; fnz /= nLen;

    // Tangent & bitangent frame
    let tx = 1.0, ty = 0.0, tz = 0.0;
    let bxT = 0.0, byT = 1.0, bzT = 0.0;

    if (uvs && uvs.length >= (Math.max(i0, i1, i2) + 1) * 2) {
      const u0 = uvs[i0 * 2], v0Uv = uvs[i0 * 2 + 1];
      const u1 = uvs[i1 * 2], v1Uv = uvs[i1 * 2 + 1];
      const u2 = uvs[i2 * 2], v2Uv = uvs[i2 * 2 + 1];

      const du1 = u1 - u0, dv1 = v1Uv - v0Uv;
      const du2 = u2 - u0, dv2 = v2Uv - v0Uv;
      const rDet = du1 * dv2 - du2 * dv1;
      if (Math.abs(rDet) > 1e-8) {
        const inv = 1.0 / rDet;
        tx = (ax * dv2 - bx * dv1) * inv;
        ty = (ay * dv2 - by * dv1) * inv;
        tz = (az * dv2 - bz * dv1) * inv;
        bxT = (bx * du1 - ax * du2) * inv;
        byT = (by * du1 - ay * du2) * inv;
        bzT = (bz * du1 - az * du2) * inv;
      }
    }

    // Gram-Schmidt orthonormalize tangent
    const dotNT = fnx * tx + fny * ty + fnz * tz;
    tx -= fnx * dotNT; ty -= fny * dotNT; tz -= fnz * dotNT;
    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tLen > 1e-6) {
      tx /= tLen; ty /= tLen; tz /= tLen;
    } else {
      // Fallback orthogonal tangent
      if (Math.abs(fnx) > 0.9) {
        tx = 0; ty = 1; tz = 0;
      } else {
        tx = 1; ty = 0; tz = 0;
      }
      const d = fnx * tx + fny * ty + fnz * tz;
      tx -= fnx * d; ty -= fny * d; tz -= fnz * d;
      const l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1.0;
      tx /= l; ty /= l; tz /= l;
    }

    // Bitangent via cross product
    bxT = fny * tz - fnz * ty;
    byT = fnz * tx - fnx * tz;
    bzT = fnx * ty - fny * tx;
    const bLen = Math.sqrt(bxT * bxT + byT * byT + bzT * bzT) || 1.0;
    bxT /= bLen; byT /= bLen; bzT /= bLen;

    triFrames[t] = {
      triIdx: t,
      normal: [fnx, fny, fnz],
      tangent: [tx, ty, tz],
      bitangent: [bxT, byT, bzT],
      v0, v1, v2,
      v0Key: quantizeKey(v0[0], v0[1], v0[2]),
      v1Key: quantizeKey(v1[0], v1[1], v1[2]),
      v2Key: quantizeKey(v2[0], v2[1], v2[2]),
      hasSharpEdge: false,
      sharpEdges: [],
      isCurvedSurface: false
    };
  }

  // 2. Build spatial edge map
  interface EdgeRef {
    triIdx: number;
    edgeIdx: number;
    p0: [number, number, number];
    p1: [number, number, number];
  }
  const edgeMap = new Map<string, EdgeRef[]>();

  for (let t = 0; t < numTriangles; t++) {
    const tf = triFrames[t];
    const pairs: Array<[string, string, [number, number, number], [number, number, number], number]> = [
      [tf.v0Key, tf.v1Key, tf.v0, tf.v1, 0],
      [tf.v1Key, tf.v2Key, tf.v1, tf.v2, 1],
      [tf.v2Key, tf.v0Key, tf.v2, tf.v0, 2]
    ];

    for (const [k0, k1, p0, p1, edgeIdx] of pairs) {
      const edgeKey = k0 < k1 ? `${k0}|${k1}` : `${k1}|${k0}`;
      let list = edgeMap.get(edgeKey);
      if (!list) {
        list = [];
        edgeMap.set(edgeKey, list);
      }
      list.push({ triIdx: t, edgeIdx, p0, p1 });
    }
  }

  // 3. Classify edges and calculate dihedral angles & chamfer normals
  let sharpEdgeCount = 0;
  let smoothEdgeCount = 0;
  let boundaryEdgeCount = 0;

  // Track smooth edges connected to vertices for angle-weighted smooth normal field
  const vertexToSmoothFaces = new Map<string, Array<{ triIdx: number; normal: [number, number, number]; angle: number }>>();

  for (const [edgeKey, list] of edgeMap.entries()) {
    if (list.length === 2) {
      const e0 = list[0];
      const e1 = list[1];
      const n0 = triFrames[e0.triIdx].normal;
      const n1 = triFrames[e1.triIdx].normal;

      const dot = Math.max(-1.0, Math.min(1.0, n0[0] * n1[0] + n0[1] * n1[1] + n0[2] * n1[2]));
      const dihedralAngleDeg = Math.acos(dot) * (180.0 / Math.PI);

      // Sharp edge if dihedral angle > 45° (cos < 0.7071)
      const isSharp = dihedralAngleDeg > 45.0;
      const isSmooth = !isSharp;

      // Chamfer normal is normalized sum of face normals
      let cx = n0[0] + n1[0];
      let cy = n0[1] + n1[1];
      let cz = n0[2] + n1[2];
      const cLen = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1.0;
      const chamferNormal: [number, number, number] = [cx / cLen, cy / cLen, cz / cLen];

      const [k0, k1] = edgeKey.split('|');
      const edgeRecord: EdgeAdjacencyRecord = {
        v0Key: k0,
        v1Key: k1,
        p0: e0.p0,
        p1: e0.p1,
        triangles: [
          { triIdx: e0.triIdx, edgeIdx: e0.edgeIdx },
          { triIdx: e1.triIdx, edgeIdx: e1.edgeIdx }
        ],
        dihedralAngleDeg,
        cosDihedral: dot,
        isSharp,
        isSmooth,
        chamferNormal
      };

      if (isSharp) {
        sharpEdgeCount++;
        triFrames[e0.triIdx].hasSharpEdge = true;
        triFrames[e0.triIdx].sharpEdges.push(edgeRecord);
        triFrames[e1.triIdx].hasSharpEdge = true;
        triFrames[e1.triIdx].sharpEdges.push(edgeRecord);
      } else {
        smoothEdgeCount++;
        // If smooth edge has some curvature (e.g. 5° to 45°), mark triangles as curved
        if (dihedralAngleDeg > 4.0) {
          triFrames[e0.triIdx].isCurvedSurface = true;
          triFrames[e1.triIdx].isCurvedSurface = true;
        }
      }
    } else {
      boundaryEdgeCount++;
    }
  }

  // 4. Compute angle-weighted smooth normal field for vertices
  for (let t = 0; t < numTriangles; t++) {
    const tf = triFrames[t];
    // Calculate triangle interior angles at each vertex
    const a = tf.v0, b = tf.v1, c = tf.v2;

    const angleAt = (vCurr: [number, number, number], vA: [number, number, number], vB: [number, number, number]) => {
      const d1x = vA[0] - vCurr[0], d1y = vA[1] - vCurr[1], d1z = vA[2] - vCurr[2];
      const d2x = vB[0] - vCurr[0], d2y = vB[1] - vCurr[1], d2z = vB[2] - vCurr[2];
      const l1 = Math.sqrt(d1x * d1x + d1y * d1y + d1z * d1z) || 1.0;
      const l2 = Math.sqrt(d2x * d2x + d2y * d2y + d2z * d2z) || 1.0;
      const d = (d1x * d2x + d1y * d2y + d1z * d2z) / (l1 * l2);
      return Math.acos(Math.max(-1.0, Math.min(1.0, d)));
    };

    const ang0 = angleAt(a, b, c);
    const ang1 = angleAt(b, c, a);
    const ang2 = angleAt(c, a, b);

    const keys: Array<[string, number]> = [
      [tf.v0Key, ang0],
      [tf.v1Key, ang1],
      [tf.v2Key, ang2]
    ];

    for (const [key, angle] of keys) {
      let list = vertexToSmoothFaces.get(key);
      if (!list) {
        list = [];
        vertexToSmoothFaces.set(key, list);
      }
      list.push({ triIdx: t, normal: tf.normal, angle });
    }
  }

  const vertexSmoothNormals = new Map<string, [number, number, number]>();
  for (const [key, list] of vertexToSmoothFaces.entries()) {
    let sx = 0, sy = 0, sz = 0;
    for (const item of list) {
      sx += item.normal[0] * item.angle;
      sy += item.normal[1] * item.angle;
      sz += item.normal[2] * item.angle;
    }
    const len = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1.0;
    vertexSmoothNormals.set(key, [sx / len, sy / len, sz / len]);
  }

  return {
    triangles: triFrames,
    sharpEdgeCount,
    smoothEdgeCount,
    boundaryEdgeCount,
    vertexSmoothNormals
  };
}

/**
 * Calculates orthogonal distance from 3D point P to line segment (p0, p1).
 */
export function pointSegmentDistance(
  px: number, py: number, pz: number,
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number
): { dist: number; proj: [number, number, number] } {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dz = z1 - z0;
  const l2 = dx * dx + dy * dy + dz * dz;

  if (l2 < 1e-12) {
    const d = Math.sqrt((px - x0) ** 2 + (py - y0) ** 2 + (pz - z0) ** 2);
    return { dist: d, proj: [x0, y0, z0] };
  }

  let t = ((px - x0) * dx + (py - y0) * dy + (pz - z0) * dz) / l2;
  t = Math.max(0.0, Math.min(1.0, t));

  const projX = x0 + t * dx;
  const projY = y0 + t * dy;
  const projZ = z0 + t * dz;

  const dist = Math.sqrt((px - projX) ** 2 + (py - projY) ** 2 + (pz - projZ) ** 2);
  return { dist, proj: [projX, projY, projZ] };
}

/**
 * Evaluates the 5mm Virtual Specular Bevel and Curvature Anti-Faceting Normal for a texel.
 */
export function evaluateGeometricNormal(
  graph: SubmeshAdjacencyGraph,
  triIdx: number,
  pWorld: [number, number, number],
  barycentric: [number, number, number],
  maxBevelDist = 0.005 // 5 mm default
): GeometricNormalResult {
  const tf = graph.triangles[triIdx];
  const [w0, w1, w2] = barycentric;

  let isBevel = false;
  let bevelWeight = 0.0;
  let minBevelDist = Infinity;
  let bestChamferNormal: [number, number, number] = tf.normal;

  // 1. Evaluate 5mm Virtual Specular Bevel if triangle touches sharp dihedral edges
  if (tf.hasSharpEdge && tf.sharpEdges.length > 0) {
    for (const edge of tf.sharpEdges) {
      const { dist } = pointSegmentDistance(
        pWorld[0], pWorld[1], pWorld[2],
        edge.p0[0], edge.p0[1], edge.p0[2],
        edge.p1[0], edge.p1[1], edge.p1[2]
      );

      if (dist < minBevelDist) {
        minBevelDist = dist;
        bestChamferNormal = edge.chamferNormal;
      }
    }

    if (minBevelDist <= maxBevelDist) {
      isBevel = true;
      const u = minBevelDist / maxBevelDist;
      // Smooth cosine profile: 1.0 at edge (d=0) to 0.0 at maxBevelDist
      bevelWeight = 0.5 * (1.0 + Math.cos(Math.PI * u));
    }
  }

  // 2. Evaluate Curvature Anti-Faceting Normal
  let isAntiFaceted = false;
  let smoothNormalWorld: [number, number, number] = tf.normal;

  if (tf.isCurvedSurface) {
    const n0 = graph.vertexSmoothNormals.get(tf.v0Key) || tf.normal;
    const n1 = graph.vertexSmoothNormals.get(tf.v1Key) || tf.normal;
    const n2 = graph.vertexSmoothNormals.get(tf.v2Key) || tf.normal;

    let sx = w0 * n0[0] + w1 * n1[0] + w2 * n2[0];
    let sy = w0 * n0[1] + w1 * n1[1] + w2 * n2[1];
    let sz = w0 * n0[2] + w1 * n1[2] + w2 * n2[2];
    const sLen = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1.0;
    smoothNormalWorld = [sx / sLen, sy / sLen, sz / sLen];

    // Check if smooth normal deviates noticeably from face normal (>1.5°)
    const dot = tf.normal[0] * smoothNormalWorld[0] + tf.normal[1] * smoothNormalWorld[1] + tf.normal[2] * smoothNormalWorld[2];
    if (dot < 0.9996) {
      isAntiFaceted = true;
    }
  }

  // 3. Combine Anti-Faceting and Virtual Bevel
  // Base normal is either smooth anti-faceting normal or flat face normal
  let baseNx = isAntiFaceted ? smoothNormalWorld[0] : tf.normal[0];
  let baseNy = isAntiFaceted ? smoothNormalWorld[1] : tf.normal[1];
  let baseNz = isAntiFaceted ? smoothNormalWorld[2] : tf.normal[2];

  // If in bevel zone, blend towards chamfer normal
  let outWorldNormal: [number, number, number];
  if (isBevel && bevelWeight > 0.0) {
    let wx = (1.0 - bevelWeight) * baseNx + bevelWeight * bestChamferNormal[0];
    let wy = (1.0 - bevelWeight) * baseNy + bevelWeight * bestChamferNormal[1];
    let wz = (1.0 - bevelWeight) * baseNz + bevelWeight * bestChamferNormal[2];
    const wLen = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1.0;
    outWorldNormal = [wx / wLen, wy / wLen, wz / wLen];
  } else {
    outWorldNormal = [baseNx, baseNy, baseNz];
  }

  // 4. Project World Normal into Triangle's Tangent Frame (T, B, N)
  // tangent space: X = T, Y = B, Z = N
  const tx = tf.tangent[0], ty = tf.tangent[1], tz = tf.tangent[2];
  const bx = tf.bitangent[0], by = tf.bitangent[1], bz = tf.bitangent[2];
  const nx = tf.normal[0], ny = tf.normal[1], nz = tf.normal[2];

  let tanX = outWorldNormal[0] * tx + outWorldNormal[1] * ty + outWorldNormal[2] * tz;
  let tanY = outWorldNormal[0] * bx + outWorldNormal[1] * by + outWorldNormal[2] * bz;
  let tanZ = outWorldNormal[0] * nx + outWorldNormal[1] * ny + outWorldNormal[2] * nz;

  const tanLen = Math.sqrt(tanX * tanX + tanY * tanY + tanZ * tanZ) || 1.0;
  tanX /= tanLen; tanY /= tanLen; tanZ /= tanLen;

  // 5. Roughness & AO modulations
  // Bevel burnish: slightly lower roughness along the edge to intensify the specular glint bead
  const roughnessModifier = isBevel ? -0.08 * bevelWeight : 0.0;
  const aoModifier = isBevel ? (1.0 + 0.10 * bevelWeight) : 1.0;

  return {
    tangentNormal: [tanX, tanY, tanZ],
    worldNormal: outWorldNormal,
    isBevel,
    bevelWeight,
    bevelDistanceMeters: minBevelDist,
    isAntiFaceted,
    roughnessModifier,
    aoModifier
  };
}

export const VirtualBevelKernel = {
  buildSubmeshAdjacency,
  pointSegmentDistance,
  evaluateGeometricNormal
};
