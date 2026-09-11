/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

export const FLATTEN_MAX_VERTICES = 32;
export const FLATTEN_DEFAULT_GRID = 32;
export const FLATTEN_DEFAULT_MARGIN = 0.8;

export type FlattenFootprintPoint = { x: number; z: number };

/** Environment patch applied when a flatten region is active. */
export type FlattenRegionPatch = {
  flattenActive: boolean;
  flattenPolygon?: [number, number][];
  flattenBoundsMin?: [number, number];
  flattenBoundsMax?: [number, number];
  flattenHeightfield?: number[];
  flattenGridSize?: number;
  flattenMargin?: number;
  flattenExcavateDepth?: number;
};

export const FLATTEN_REGION_DEFAULTS: FlattenRegionPatch = {
  flattenActive: false,
  flattenMargin: FLATTEN_DEFAULT_MARGIN,
  flattenExcavateDepth: 0.0,
};

export function computeFlattenBounds(
  polygon: FlattenFootprintPoint[],
  padM = 2
): { min: [number, number]; max: [number, number] } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const p of polygon) {
    minX = Math.min(minX, p.x);
    minZ = Math.min(minZ, p.z);
    maxX = Math.max(maxX, p.x);
    maxZ = Math.max(maxZ, p.z);
  }
  return {
    min: [minX - padM, minZ - padM],
    max: [maxX + padM, maxZ + padM],
  };
}

export function bakeFlattenHeightfield(
  sampleGround: (x: number, z: number) => number | null,
  boundsMin: [number, number],
  boundsMax: [number, number],
  gridSize: number
): { heightfield: number[]; gridSize: number; avgGroundY?: number } {
  const data: number[] = [];
  const [xMin, zMin] = boundsMin;
  const [xMax, zMax] = boundsMax;
  const centerX = (xMin + xMax) / 2;
  const centerZ = (zMin + zMax) / 2;
  const fallbackY = sampleGround(centerX, centerZ) ?? 0;

  for (let j = 0; j < gridSize; j++) {
    for (let i = 0; i < gridSize; i++) {
      const t = gridSize === 1 ? 0.5 : i / (gridSize - 1);
      const s = gridSize === 1 ? 0.5 : j / (gridSize - 1);
      const x = xMin + t * (xMax - xMin);
      const z = zMin + s * (zMax - zMin);
      const h = sampleGround(x, z);
      data.push(h ?? fallbackY);
    }
  }

  const sum = data.reduce((acc, v) => acc + v, 0);
  const avgGroundY = data.length > 0 ? sum / data.length : fallbackY;

  return { heightfield: data, gridSize, avgGroundY };
}

export function isPointInPolygon(
  pOrX: { x: number; z: number } | number,
  polyOrZ: FlattenFootprintPoint[] | number,
  polyArg?: FlattenFootprintPoint[]
): boolean {
  let px: number;
  let pz: number;
  let poly: FlattenFootprintPoint[];

  if (typeof pOrX === 'number') {
    px = pOrX;
    pz = polyOrZ as number;
    poly = polyArg as FlattenFootprintPoint[];
  } else {
    px = pOrX.x;
    pz = pOrX.z;
    poly = polyOrZ as FlattenFootprintPoint[];
  }

  if (!poly || poly.length < 3) return false;

  let inside = false;
  const n = poly.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = poly[i] as FlattenFootprintPoint;
    const b = poly[j] as FlattenFootprintPoint;
    if ((a.z > pz) !== (b.z > pz)) {
      const dz = b.z - a.z;
      if (Math.abs(dz) > 1e-6) {
        const xIntersect = ((b.x - a.x) * (pz - a.z)) / dz + a.x;
        if (px < xIntersect) inside = !inside;
      }
    }
  }
  return inside;
}

export function buildFlattenRegionFromPolygon(
  sampleGroundHeight: (x: number, z: number) => number | null,
  polygon: FlattenFootprintPoint[],
  opts?: { margin?: number; gridSize?: number; excavateDepth?: number }
): FlattenRegionPatch {
  if (polygon.length < 3) {
    throw new Error("Flatten polygon requires at least 3 vertices");
  }

  const gridSize = Math.min(
    64,
    Math.max(4, Math.floor(opts?.gridSize ?? FLATTEN_DEFAULT_GRID))
  );
  const margin = opts?.margin ?? FLATTEN_DEFAULT_MARGIN;
  const excavateDepth = opts?.excavateDepth ?? 0.0;
  const trimmed = polygon.slice(0, FLATTEN_MAX_VERTICES);
  const bounds = computeFlattenBounds(trimmed);
  const { heightfield } = bakeFlattenHeightfield(
    sampleGroundHeight,
    bounds.min,
    bounds.max,
    gridSize
  );

  return {
    flattenActive: true,
    flattenPolygon: trimmed.map((p) => [p.x, p.z]),
    flattenBoundsMin: bounds.min,
    flattenBoundsMax: bounds.max,
    flattenHeightfield: heightfield,
    flattenGridSize: gridSize,
    flattenMargin: margin,
    flattenExcavateDepth: excavateDepth,
  };
}
