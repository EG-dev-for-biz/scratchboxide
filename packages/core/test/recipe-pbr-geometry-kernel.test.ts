import { describe, it, expect } from 'vitest';
import {
  buildRecipeSubmeshGeometry,
  buildGroundHeightField,
  computeVoxelAmbientOcclusion,
  packRecipeMask,
  generateTileableDetailMap,
  encodeCompactRecipeAttributes,
  decodeCompactEdgeDistances,
  octDecode
} from '../src/node/3d-engine/recipe-pbr-geometry-kernel';

// Two triangles folded 90° along the Y axis edge (0,0,0)-(0,1,0).
// T0 lies in the XY plane (normal +Z), T1 lies in the YZ plane (normal +X).
function foldedPair() {
  const positions = new Float32Array([
    0, 0, 0, 0, 1, 0, -1, 0, 0,
    0, 0, 0, 0, 0, -1, 0, 1, 0
  ]);
  const uvs = new Float32Array([0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1]);
  const indices = new Uint16Array([0, 1, 2, 3, 4, 5]);
  return { positions, uvs, indices };
}

function interpolateCorner(arr: Float32Array | Int8Array, verts: number[], w: number[], stride: number, c: number) {
  return w[0] * arr[verts[0] * stride + c] + w[1] * arr[verts[1] * stride + c] + w[2] * arr[verts[2] * stride + c];
}

describe('Recipe PBR geometry kernel', () => {
  it('encodes exact distance to a sharp edge as a linearly interpolable per-corner attribute', () => {
    const geo = buildRecipeSubmeshGeometry(foldedPair());
    expect(geo.sharpEdgeCount).toBe(1);

    const t0 = [geo.indices[0], geo.indices[1], geo.indices[2]];
    // Point on T0 at barycentric (0.2, 0.5, 0.3) -> world (-0.3, 0.5, 0); true distance to Y axis edge = 0.3
    const w = [0.2, 0.5, 0.3];
    const dists = [0, 1, 2].map(c => interpolateCorner(geo.edgeDistances, t0, w, 3, c));
    expect(Math.min(...dists)).toBeCloseTo(0.3, 5);
    // The two non-sharp edges carry the sentinel and never win the min
    expect(dists.filter(d => d > 100).length).toBe(2);
  });

  it('stores the neighbouring face normal for the sharp edge so the shader can form the chamfer', () => {
    const geo = buildRecipeSubmeshGeometry(foldedPair());
    const t0 = [geo.indices[0], geo.indices[1], geo.indices[2]];
    const dists = [0, 1, 2].map(c => geo.edgeDistances[t0[c] * 3 + c]);
    // Sharp edge of T0 is the one whose opposite corner has a finite altitude
    const sharpEdge = dists.findIndex(d => d > 0 && d < 100);
    expect(sharpEdge).toBeGreaterThanOrEqual(0);
    const nbr = geo.neighborNormals[sharpEdge];
    const v = t0[0];
    expect(nbr[v * 4] / 127).toBeCloseTo(1, 2);
    expect(nbr[v * 4 + 1] / 127).toBeCloseTo(0, 2);
    expect(nbr[v * 4 + 2] / 127).toBeCloseTo(0, 2);
    // w channel flags a valid neighbour
    expect(nbr[v * 4 + 3]).toBe(127);
  });

  it('keeps face normals on hard 90° corners (split normals)', () => {
    const geo = buildRecipeSubmeshGeometry(foldedPair());
    const t0 = [geo.indices[0], geo.indices[1], geo.indices[2]];
    const t1 = [geo.indices[3], geo.indices[4], geo.indices[5]];
    for (const v of t0) expect(geo.normals[v * 3 + 2]).toBeCloseTo(1, 4);
    for (const v of t1) expect(geo.normals[v * 3]).toBeCloseTo(1, 4);
  });

  it('smooths shallow curvature and shares vertices when no sharp edges exist', () => {
    const step = (15 * Math.PI) / 180;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    for (let s = 0; s <= 3; s++) {
      pos.push(Math.sin(s * step), 0, Math.cos(s * step), Math.sin(s * step), 1, Math.cos(s * step));
      uv.push(s / 3, 0, s / 3, 1);
    }
    for (let s = 0; s < 3; s++) {
      const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, c, d, b);
    }
    const geo = buildRecipeSubmeshGeometry({ positions: new Float32Array(pos), uvs: new Float32Array(uv), indices: new Uint16Array(idx) });

    expect(geo.sharpEdgeCount).toBe(0);
    expect(geo.positions.length / 3).toBe(8);
    // Interior vertex (s=1 bottom, source index 2) normal is the bisector of its two adjacent facets, not a facet normal
    const v = Array.from(geo.vertexSourceIndex).indexOf(2);
    const nx = geo.normals[v * 3], nz = geo.normals[v * 3 + 2];
    expect(Math.atan2(nx, nz)).toBeCloseTo(step, 1);
  });

  it('never moves a vertex (0.000 mm geometry lock)', () => {
    const src = foldedPair();
    const geo = buildRecipeSubmeshGeometry(src);
    for (let i = 0; i < geo.vertexSourceIndex.length; i++) {
      const s = geo.vertexSourceIndex[i];
      for (let c = 0; c < 3; c++) expect(geo.positions[i * 3 + c]).toBe(src.positions[s * 3 + c]);
      for (let c = 0; c < 2; c++) expect(geo.uvs[i * 2 + c]).toBe(src.uvs[s * 2 + c]);
    }
  });

  it('computes lower ambient occlusion for a floor enclosed by walls than for an open floor', () => {
    const quad = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
    const floorOpen = quad([20, 0, -2], [20, 0, 2], [24, 0, 2], [24, 0, -2]);
    const floorBox = quad([-2, 0, -2], [-2, 0, 2], [2, 0, 2], [2, 0, -2]);
    const walls = [
      ...quad([-2, 0, -2], [-2, 4, -2], [2, 4, -2], [2, 0, -2]),
      ...quad([-2, 0, 2], [2, 0, 2], [2, 4, 2], [-2, 4, 2]),
      ...quad([-2, 0, -2], [-2, 0, 2], [-2, 4, 2], [-2, 4, -2]),
      ...quad([2, 0, -2], [2, 4, -2], [2, 4, 2], [2, 0, 2])
    ];
    const toMesh = (p: number[]) => {
      const positions = new Float32Array(p);
      const geo = buildRecipeSubmeshGeometry({ positions, uvs: new Float32Array((p.length / 3) * 2) });
      return geo;
    };
    const meshes = [toMesh(floorOpen), toMesh(floorBox), toMesh(walls)];
    const ao = computeVoxelAmbientOcclusion(meshes, { cellSize: 0.25, maxDistance: 8, rayCount: 24 });

    const mean = (a: Float32Array) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(mean(ao[0])).toBeGreaterThan(0.9);
    expect(mean(ao[1])).toBeLessThan(mean(ao[0]) - 0.2);
    for (const arr of ao) for (const x of arr) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
  });

  it('derives ground height from the lowest upward-facing surfaces without a hardcoded datum', () => {
    const positions = new Float32Array([
      0, 10, 0, 0, 10, 4, 4, 10, 0,     // ground at y=10
      0, 25, 0, 4, 25, 0, 0, 25, 4      // roof-like surface above (downward wound)
    ]);
    const geo = buildRecipeSubmeshGeometry({ positions, uvs: new Float32Array(12) });
    const field = buildGroundHeightField([geo], 6);
    expect(field.sample(1, 1)).toBeCloseTo(10, 5);
    expect(field.sample(40, 40)).toBeCloseTo(10, 5); // falls back to nearest known ground
  });

  it('packs AO and height above ground into an 8-bit RGBA mask', () => {
    const mask = packRecipeMask(new Float32Array([1, 0.5]), new Float32Array([0, 4]), 8);
    expect(Array.from(mask)).toEqual([255, 0, 0, 255, 128, 128, 0, 255]);
  });

  it('stores edge flags in the mask alpha channel when provided', () => {
    const mask = packRecipeMask(new Float32Array([1]), new Float32Array([0]), 8, new Uint8Array([22]));
    expect(mask[3]).toBe(22);
  });

  it('compact encoding reproduces the exact per-corner edge distances', () => {
    // Folded pair plus a smooth neighbour so both sharp and shared corners are covered
    const positions = new Float32Array([
      0, 0, 0, 0, 1, 0, -1, 0, 0,
      0, 0, 0, 0, 0, -1, 0, 1, 0,
      -1, 0, 0, 0, 1, 0, -1, 1, 0.05
    ]);
    const geo = buildRecipeSubmeshGeometry({ positions, uvs: new Float32Array(18).fill(0.5) });
    const compact = encodeCompactRecipeAttributes(geo);
    const n = geo.positions.length / 3;
    for (let v = 0; v < n; v++) {
      const d = decodeCompactEdgeDistances(compact.edgeAltitude[v], compact.edgeFlags[v]);
      for (let c = 0; c < 3; c++) expect(d[c]).toBeCloseTo(geo.edgeDistances[v * 3 + c], 5);
    }
  });

  it('compact encoding keeps neighbour normals within 2 degrees and quantizes normals/UVs', () => {
    const geo = buildRecipeSubmeshGeometry(foldedPair());
    const compact = encodeCompactRecipeAttributes(geo);
    const n = geo.positions.length / 3;
    for (let v = 0; v < n; v++) {
      for (let e = 0; e < 3; e++) {
        const src = geo.neighborNormals[e];
        if (src[v * 4 + 3] === 0) continue;
        const ref = [src[v * 4] / 127, src[v * 4 + 1] / 127, src[v * 4 + 2] / 127];
        const oct = e < 2 ? compact.neighborOctA : compact.neighborOctB;
        const off = e === 1 ? 2 : 0;
        const dec = octDecode(oct[v * 4 + off] / 127, oct[v * 4 + off + 1] / 127);
        const len = Math.hypot(ref[0], ref[1], ref[2]);
        const cos = (dec[0] * ref[0] + dec[1] * ref[1] + dec[2] * ref[2]) / len;
        expect(Math.acos(Math.min(1, cos)) * 180 / Math.PI).toBeLessThan(2);
      }
      // int8 normals padded to 4 bytes
      expect(compact.normals[v * 4 + 2] / 127).toBeCloseTo(geo.normals[v * 3 + 2], 1);
    }
    expect(compact.uvs).toBeInstanceOf(Uint16Array);
    expect(compact.uvs![1] / 65535).toBeCloseTo(geo.uvs[1], 4);
  });

  it('falls back to float UVs when coordinates leave the unit square', () => {
    const src = foldedPair();
    src.uvs[0] = 1.5;
    const compact = encodeCompactRecipeAttributes(buildRecipeSubmeshGeometry(src));
    expect(compact.uvs).toBeNull();
  });

  it('generates seamless, deterministic, unit-length tileable detail normal maps', () => {
    const a = generateTileableDetailMap('stone', 128);
    const b = generateTileableDetailMap('stone', 128);
    expect(Buffer.from(a.rgba).equals(Buffer.from(b.rgba))).toBe(true);
    expect(a.tileMeters).toBeGreaterThan(0);

    const n = 128;
    const h = (x: number, y: number) => a.rgba[(y * n + x) * 4 + 3];
    let seam = 0, interior = 0;
    for (let y = 0; y < n; y++) {
      seam += Math.abs(h(n - 1, y) - h(0, y));
      interior += Math.abs(h(n / 2, y) - h(n / 2 + 1, y));
    }
    expect(seam).toBeLessThan(interior * 2.5);

    for (let i = 0; i < n * n; i += 97) {
      const x = a.rgba[i * 4] / 127.5 - 1, y = a.rgba[i * 4 + 1] / 127.5 - 1, z = a.rgba[i * 4 + 2] / 127.5 - 1;
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 1);
      expect(z).toBeGreaterThan(0);
    }
  });
});
