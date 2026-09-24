/**
 * Pure TypeScript mathematical solver for computing 3D Oriented Bounding Boxes (OBB)
 * from 3D vertex clouds using Principal Component Analysis (PCA) and ground-constrained
 * covariance analysis.
 */

export interface BoundingBox3DAABB {
  min: [number, number, number];
  max: [number, number, number];
  dimensions: [number, number, number];
  centroid: [number, number, number];
  volumeM3: number;
}

export interface OrientedBoundingBox3D {
  center: [number, number, number];
  dimensions: [number, number, number]; // [width, height, depth] in local rotated space
  halfExtents: [number, number, number];
  yawDeg: number;
  yawRad: number;
  quaternion: [number, number, number, number]; // [x, y, z, w]
  rotationMatrix3x3: [
    [number, number, number],
    [number, number, number],
    [number, number, number]
  ];
  volumeM3: number;
  tightnessGainPercent: number; // Percentage volume reduction compared to loose AABB
}

export interface DualBoundingBoxResult {
  aabb: BoundingBox3DAABB;
  obb: OrientedBoundingBox3D;
  vertexCount: number;
}

export interface Vertex3D {
  x: number;
  y: number;
  z: number;
}

export class OrientedBoundingBoxSolver {
  /**
   * Computes both Axis-Aligned (AABB) and Ground-Constrained Oriented (OBB)
   * bounding boxes for an array of 3D vertices.
   */
  public static compute(
    vertices: Float32Array | [number, number, number][] | Vertex3D[]
  ): DualBoundingBoxResult {
    let N = 0;
    const isFloatArray = vertices instanceof Float32Array;

    if (isFloatArray) {
      N = vertices.length / 3;
    } else {
      N = (vertices as any[]).length;
    }

    if (N === 0) {
      const zeroAABB: BoundingBox3DAABB = {
        min: [0, 0, 0],
        max: [0, 0, 0],
        dimensions: [0, 0, 0],
        centroid: [0, 0, 0],
        volumeM3: 0
      };
      const zeroOBB: OrientedBoundingBox3D = {
        center: [0, 0, 0],
        dimensions: [0, 0, 0],
        halfExtents: [0, 0, 0],
        yawDeg: 0,
        yawRad: 0,
        quaternion: [0, 0, 0, 1],
        rotationMatrix3x3: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1]
        ],
        volumeM3: 0,
        tightnessGainPercent: 0
      };
      return { aabb: zeroAABB, obb: zeroOBB, vertexCount: 0 };
    }

    // Helper to read vertex i
    const getV = (i: number): [number, number, number] => {
      if (isFloatArray) {
        const fa = vertices as Float32Array;
        return [fa[i * 3], fa[i * 3 + 1], fa[i * 3 + 2]];
      }
      const item = (vertices as any[])[i];
      if (Array.isArray(item)) return item as [number, number, number];
      return [item.x, item.y, item.z];
    };

    // 1. Compute Centroid and AABB bounds
    let sumX = 0, sumY = 0, sumZ = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < N; i++) {
      const [x, y, z] = getV(i);
      sumX += x; sumY += y; sumZ += z;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    const meanX = sumX / N;
    const meanY = sumY / N;
    const meanZ = sumZ / N;

    const aabbDims: [number, number, number] = [
      Math.max(0.01, maxX - minX),
      Math.max(0.01, maxY - minY),
      Math.max(0.01, maxZ - minZ)
    ];
    const aabbCentroid: [number, number, number] = [
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2
    ];
    const aabbVolume = aabbDims[0] * aabbDims[1] * aabbDims[2];

    const aabb: BoundingBox3DAABB = {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      dimensions: aabbDims,
      centroid: aabbCentroid,
      volumeM3: aabbVolume
    };

    if (N < 3) {
      // Degenerate vertex set, return AABB as OBB
      return {
        aabb,
        obb: {
          center: aabbCentroid,
          dimensions: aabbDims,
          halfExtents: [aabbDims[0] / 2, aabbDims[1] / 2, aabbDims[2] / 2],
          yawDeg: 0,
          yawRad: 0,
          quaternion: [0, 0, 0, 1],
          rotationMatrix3x3: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1]
          ],
          volumeM3: aabbVolume,
          tightnessGainPercent: 0
        },
        vertexCount: N
      };
    }

    // 2. Compute 2D Covariance on (X, Z) ground plane with gravity alignment (+Y up)
    let covXX = 0, covXZ = 0, covZZ = 0;
    for (let i = 0; i < N; i++) {
      const [x, , z] = getV(i);
      const dx = x - meanX;
      const dz = z - meanZ;
      covXX += dx * dx;
      covXZ += dx * dz;
      covZZ += dz * dz;
    }
    covXX /= N;
    covXZ /= N;
    covZZ /= N;

    // 3. Eigenvector yaw angle calculation
    const theta = 0.5 * Math.atan2(2 * covXZ, covXX - covZZ);
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    const yawDeg = Math.round((theta * 180) / Math.PI * 100) / 100;

    // 4. Project vertices onto rotated local coordinate axes:
    // u = (x - meanX) * cosT + (z - meanZ) * sinT
    // w = -(x - meanX) * sinT + (z - meanZ) * cosT
    let minU = Infinity, maxU = -Infinity;
    let minW = Infinity, maxW = -Infinity;

    for (let i = 0; i < N; i++) {
      const [x, , z] = getV(i);
      const dx = x - meanX;
      const dz = z - meanZ;
      const u = dx * cosT + dz * sinT;
      const w = -dx * sinT + dz * cosT;
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (w < minW) minW = w; if (w > maxW) maxW = w;
    }

    const obbWidth = Math.max(0.01, maxU - minU);
    const obbHeight = aabbDims[1];
    const obbDepth = Math.max(0.01, maxW - minW);

    // Compute center of rotated box in world coordinates
    const midU = (minU + maxU) / 2;
    const midW = (minW + maxW) / 2;

    const obbCenterX = meanX + midU * cosT - midW * sinT;
    const obbCenterY = aabbCentroid[1];
    const obbCenterZ = meanZ + midU * sinT + midW * cosT;

    const obbVolume = obbWidth * obbHeight * obbDepth;
    const tightnessGain = aabbVolume > 0
      ? Math.max(0, Math.round(((aabbVolume - obbVolume) / aabbVolume) * 1000) / 10)
      : 0;

    // Quaternion for rotation about +Y axis
    const halfTheta = theta / 2;
    const qY = Math.sin(halfTheta);
    const qW = Math.cos(halfTheta);

    const obb: OrientedBoundingBox3D = {
      center: [obbCenterX, obbCenterY, obbCenterZ],
      dimensions: [obbWidth, obbHeight, obbDepth],
      halfExtents: [obbWidth / 2, obbHeight / 2, obbDepth / 2],
      yawDeg: yawDeg,
      yawRad: theta,
      quaternion: [0, qY, 0, qW],
      rotationMatrix3x3: [
        [cosT, 0, sinT],
        [0, 1, 0],
        [-sinT, 0, cosT]
      ],
      volumeM3: obbVolume,
      tightnessGainPercent: tightnessGain
    };

    return { aabb, obb, vertexCount: N };
  }
}
