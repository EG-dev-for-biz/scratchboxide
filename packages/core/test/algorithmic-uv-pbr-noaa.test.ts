import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { encodePng } from '../src/node/texture-processing';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { calculateNOAASolarPosition, calculateENUSunVector } from '../src/browser/generative-canvas/services/atmosphere/solar-position';
import { IMAGE_MODEL_PRIORITY_DRAFT } from '../src/common/media-generation-protocol';

describe('Algorithmic UV PBR Pipeline: NOAA Solar De-Lighting, Toksvig AA & Material Extensions', () => {
  // --------------------------------------------------------------------------
  // 1. NOAA Solar Ephemeris & Sun Vector Accuracy
  // --------------------------------------------------------------------------
  it('accurately computes NOAA solar ephemeris and ENU sun vector for Manhattan coordinates', () => {
    // Empire State Building, Midtown Manhattan (40.74844° N, -73.98566° W)
    const lat = 40.74844;
    const lng = -73.98566;
    // June 21, 2024 at 17:00:00 UTC (1:00 PM EDT solar noon window)
    const date = new Date('2024-06-21T17:00:00Z');

    const pos = calculateNOAASolarPosition(date, lat, lng);
    expect(pos.elevationDeg).toBeGreaterThan(55.0); // High summer sun
    expect(pos.elevationDeg).toBeLessThan(75.0);

    const sunVector = calculateENUSunVector(pos.altitudeRad, pos.azimuthRad);
    // +Y is Up in ENU coordinates
    expect(sunVector.y).toBeGreaterThan(0.80);
    // Vector must be normalized unit length
    const len = Math.sqrt(sunVector.x * sunVector.x + sunVector.y * sunVector.y + sunVector.z * sunVector.z);
    expect(len).toBeCloseTo(1.0, 5);
  });

  // --------------------------------------------------------------------------
  // 2. Analytical Solar Irradiance E(N) & Inverse De-Lighting
  // --------------------------------------------------------------------------
  it('computes analytical diffuse solar irradiance E(N) with Ramamoorthi SH9 ambient', () => {
    const sunVector: [number, number, number] = [0.0, 0.92, -0.38];
    const shCoeffs: [number, number, number][] = [
      [0.65, 0.72, 0.85],
      [0.20, 0.28, 0.40],
      [0.15, 0.20, 0.30],
      [0.10, 0.15, 0.25],
      [0.05, 0.08, 0.12],
      [0.04, 0.06, 0.10],
      [0.08, 0.12, 0.18],
      [0.03, 0.05, 0.08],
      [0.02, 0.04, 0.06]
    ];

    // Upward-facing roof normal receives direct sunlight + peak sky dome irradiance
    const roofNormal: [number, number, number] = [0.0, 1.0, 0.0];
    const roofIrradiance = AlgorithmicUvEngine.computeSolarIrradiance(
      roofNormal,
      sunVector,
      shCoeffs,
      0.65,
      0.35,
      0.18
    );

    // North-facing facade in deep shadow receives no direct sunlight, only ambient
    const shadowNormal: [number, number, number] = [0.0, 0.0, 1.0];
    const shadowIrradiance = AlgorithmicUvEngine.computeSolarIrradiance(
      shadowNormal,
      sunVector,
      shCoeffs,
      0.65,
      0.35,
      0.18
    );

    expect(roofIrradiance).toBeGreaterThan(shadowIrradiance);
    expect(shadowIrradiance).toBeGreaterThanOrEqual(0.18); // Enforces regularization epsilon floor
    expect(roofIrradiance).toBeLessThanOrEqual(1.8);
  });

  it('performs intrinsic solar inverse de-lighting in decomposePbr', async () => {
    // Synthetic 16x16 test patch with baked directional shading
    const w = 16;
    const h = 16;
    const testAlbedo = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        // Half in bright light (val 220), half in shadow (val 80)
        const val = x < 8 ? 80 : 220;
        testAlbedo[idx]     = val;
        testAlbedo[idx + 1] = val;
        testAlbedo[idx + 2] = val;
        testAlbedo[idx + 3] = 255;
      }
    }

    const res = await AlgorithmicUvEngine.decomposePbr(
      testAlbedo,
      {
        enableAlbedoDeLighting: true,
        enableSolarInverseDelighting: true,
        solarDelighting: {
          latitude: 40.74844,
          longitude: -73.98566,
          timestampIso: '2024-06-21T17:00:00Z',
          regularizationEpsilon: 0.18
        }
      },
      w,
      h
    );

    expect(res.albedo).toBeDefined();
    // Verify shadow region has been de-lighted / lifted
    const shadowPixelLum = res.albedo[0];
    expect(shadowPixelLum).toBeGreaterThan(80); // Shadow was lifted
  });

  // --------------------------------------------------------------------------
  // 3. Custom Toksvig MIP Pyramid Pre-Filtering
  // --------------------------------------------------------------------------
  it('refuses solar de-lighting without a sun: no default place or date stands in for it', async () => {
    const albedo = new Uint8Array(8 * 8 * 4).fill(180);
    for (const solarDelighting of [{}, { latitude: 40.7, longitude: -74.0 }, { latitude: 40.7, timestampIso: '2026-06-21T17:00:00Z' }]) {
      await expect(AlgorithmicUvEngine.decomposePbr(albedo, { enableSolarInverseDelighting: true, solarDelighting }, 8, 8))
        .rejects.toThrow(/Solar de-lighting needs solarDelighting\.sunVector, or latitude, longitude and a UTC timestampIso/);
    }
  });

  it('generates multi-scale Toksvig MIP pyramid folding normal variance into roughness', () => {
    const w = 16;
    const h = 16;
    const rough = new Uint8Array(w * h * 4);
    const norm = new Uint8Array(w * h * 4);

    // Initial smooth surface (roughness = 0.20) with high-frequency micro-facets in normal map
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        rough[idx] = 51; // 0.20 * 255
        rough[idx + 1] = 51;
        rough[idx + 2] = 51;
        rough[idx + 3] = 255;

        // Perturb normal directions to induce variance
        const perturbX = (x % 2 === 0 ? 0.3 : -0.3);
        const perturbY = (y % 2 === 0 ? 0.3 : -0.3);
        norm[idx]     = Math.round((perturbX * 0.5 + 0.5) * 255);
        norm[idx + 1] = Math.round((perturbY * 0.5 + 0.5) * 255);
        norm[idx + 2] = 230; // Z pointing out
        norm[idx + 3] = 255;
      }
    }

    const levels = AlgorithmicUvEngine.computeToksvigMipPyramid(rough, norm, w, h, 3);
    expect(levels.length).toBe(4); // Base (level 0) + 3 downsampled levels

    // Level 0 invariants
    expect(levels[0].level).toBe(0);
    expect(levels[0].width).toBe(16);
    expect(levels[0].height).toBe(16);

    // Downsampled levels: resolution halves each level
    expect(levels[1].width).toBe(8);
    expect(levels[2].width).toBe(4);
    expect(levels[3].width).toBe(2);

    // Roughness must monotonically increase across coarser MIP levels as normal variance is folded in
    const r0 = levels[0].roughness[0] / 255.0;
    const r1 = levels[1].roughness[0] / 255.0;
    const r2 = levels[2].roughness[0] / 255.0;

    expect(r1).toBeGreaterThanOrEqual(r0);
    expect(r2).toBeGreaterThanOrEqual(r1);
    expect(levels[1].addedRoughnessVariance).toBeGreaterThan(0.0);
  });

  // --------------------------------------------------------------------------
  // 4. Multi-Tile Seamless Boundary Seam Welding
  // --------------------------------------------------------------------------
  it('discovers and welds coincident boundary vertices and synchronizes normals across tiles', () => {
    // Tile A vertices: edge at X = 10.002
    const tileAVerts = new Float32Array([
      10.002, 5.0, 0.0,
      10.001, 10.0, 0.0,
      0.0, 0.0, 0.0
    ]);
    const tileANorms = new Float32Array([
      0.95, 0.31, 0.0,
      0.90, 0.43, 0.0,
      0.0, 1.0, 0.0
    ]);

    // Tile B vertices: matching edge at X = 9.998 (within 0.05m tolerance)
    const tileBVerts = new Float32Array([
      9.998, 5.0, 0.0,
      9.999, 10.0, 0.0,
      20.0, 0.0, 0.0
    ]);
    const tileBNorms = new Float32Array([
      1.0, 0.0, 0.0,
      1.0, 0.0, 0.0,
      0.0, 1.0, 0.0
    ]);

    const weldResult = AlgorithmicUvEngine.weldTileBoundarySeams(
      [tileAVerts, tileBVerts],
      [tileANorms, tileBNorms],
      0.05 // 5cm tolerance
    );

    expect(weldResult.weldedBoundaryPairs).toBe(2);
    expect(weldResult.weldedVertexCount).toBe(4); // 2 vertices in Tile A + 2 in Tile B
    expect(weldResult.maxDisplacementMeters).toBeLessThan(0.05);

    // Verify welded positions match exactly
    expect(tileAVerts[0]).toBeCloseTo(10.000, 3);
    expect(tileBVerts[0]).toBeCloseTo(10.000, 3);

    // Verify welded normals are unified
    expect(tileANorms[0]).toBeCloseTo(tileBNorms[0], 4);
    expect(tileANorms[1]).toBeCloseTo(tileBNorms[1], 4);
  });

  // --------------------------------------------------------------------------
  // 5. Khronos Material Extension Injection (KHR_materials_*)
  // --------------------------------------------------------------------------
  it('correctly injects KHR_materials_transmission, ior, anisotropy, and clearcoat into GLB', async () => {
    // Minimal valid glTF binary containing 1 material
    const mockGlb = {
      json: {
        asset: { version: '2.0' },
        materials: [
          {
            name: 'Manhattan_Glazing_Window',
            pbrMetallicRoughness: {
              roughnessFactor: 0.10,
              metallicFactor: 0.05
            }
          },
          {
            name: 'Empire_State_Spire_Metal',
            pbrMetallicRoughness: {
              roughnessFactor: 0.20,
              metallicFactor: 0.90
            }
          }
        ],
        meshes: [],
        images: [],
        bufferViews: []
      },
      bin: Buffer.alloc(16)
    };

    const dummyGlb = (AlgorithmicUvEngine as any).serializeGlb(mockGlb.json, mockGlb.bin);

    const result = await AlgorithmicUvEngine.processGlb({
      inputGlbBuffer: dummyGlb,
      khrMaterials: {
        enableKhrMaterialsExtensions: true,
        enableTransmission: true,
        transmissionFactor: 0.95,
        ior: 1.52,
        enableAnisotropy: true,
        anisotropyStrength: 0.85,
        enableClearcoat: true,
        clearcoatFactor: 0.88
      }
    });

    expect(result.success).toBe(true);
    expect(result.khrExtensionsInjected).toBeDefined();
    expect(result.khrExtensionsInjected).toContain('KHR_materials_transmission');
    expect(result.khrExtensionsInjected).toContain('KHR_materials_ior');
    expect(result.khrExtensionsInjected).toContain('KHR_materials_anisotropy');
    expect(result.khrExtensionsInjected).toContain('KHR_materials_clearcoat');
  });

  // --------------------------------------------------------------------------
  // 6. Draft Fidelity Mode Routing Contract
  // --------------------------------------------------------------------------
  it('prioritizes the fast gemini-2.5-flash-image model in draft fidelity mode', () => {
    expect(IMAGE_MODEL_PRIORITY_DRAFT).toBeDefined();
    expect(IMAGE_MODEL_PRIORITY_DRAFT[0]).toBe('gemini-2.5-flash-image');
    expect(IMAGE_MODEL_PRIORITY_DRAFT).toContain('gemini-2.5-flash-image');
  });
});

describe('decomposePbr de-lighting: brightness kept, shadows lifted, detail and charts intact', () => {
  type Img = { rgba: Uint8Array; w: number; h: number };
  const luma = (b: Uint8Array, i: number) => 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2];
  const stats = (img: Img, pred: (x: number, y: number) => boolean) => {
    let s = 0, s2 = 0, n = 0;
    for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
      const i = (y * img.w + x) * 4;
      if (img.rgba[i + 3] === 0 || !pred(x, y)) continue;
      const v = luma(img.rgba, i); s += v; s2 += v * v; n++;
    }
    return { mean: s / n, std: Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)), n };
  };
  const nearWhite = (img: Img) => {
    let w = 0, n = 0;
    for (let i = 0; i < img.rgba.length; i += 4) if (img.rgba[i + 3]) { n++; if (luma(img.rgba, i) > 235) w++; }
    return w / n;
  };
  const make = (w: number, h: number, value: (x: number, y: number) => number | null): Img => {
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = value(x, y);
      if (v === null) continue;
      const i = (y * w + x) * 4;
      rgba[i] = Math.round(v); rgba[i + 1] = Math.round(v * 0.95); rgba[i + 2] = Math.round(v * 0.88); rgba[i + 3] = 255;
    }
    return { rgba, w, h };
  };
  const delight = async (img: Img, opts: Record<string, unknown> = { enableAlbedoDeLighting: true }): Promise<Img> => {
    const res = await AlgorithmicUvEngine.decomposePbr(img.rgba, { ...opts, generateNormalMaps: false, generateRoughnessMaps: false, generateAoMaps: false }, img.w, img.h);
    return { rgba: res.albedo, w: img.w, h: img.h };
  };
  const shot = (name: string, before: Img, after: Img) => {
    const dir = path.resolve(__dirname, '../../../test-results/screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const { w, h } = before, strip = Buffer.alloc(w * 2 * h * 4);
    for (let y = 0; y < h; y++) {
      Buffer.from(before.rgba.buffer, before.rgba.byteOffset + y * w * 4, w * 4).copy(strip, y * w * 8);
      Buffer.from(after.rgba.buffer, after.rgba.byteOffset + y * w * 4, w * 4).copy(strip, y * w * 8 + w * 4);
    }
    for (let i = 3; i < strip.length; i += 4) strip[i] = 255;
    fs.writeFileSync(path.join(dir, `algorithmic_uv_delighting_${name}.png`), encodePng(w * 2, h, strip));
  };

  // Facade: light stone (200) with dark windows (60), a soft shadow band over the left part, 16 px alpha-0 gutter
  const isWindow = (x: number, y: number) => x % 24 >= 8 && x % 24 < 16 && y % 32 >= 8 && y % 32 < 20;
  const facade = (w: number, shadowEnd: number, gutter = 16) => make(w, w, (x, y) => {
    if (x < gutter || y < gutter || x >= w - gutter || y >= w - gutter) return null;
    return (isWindow(x, y) ? 60 : 200) * (1 - 0.55 / (1 + Math.exp((x - shadowEnd) / 6)));
  });

  for (const [label, opts] of [
    ['albedo', { enableAlbedoDeLighting: true }],
    ['albedo_and_noaa_solar', {
      enableAlbedoDeLighting: true, enableSolarInverseDelighting: true,
      solarDelighting: { latitude: 40.7411, longitude: -73.9897, timestampIso: '2026-10-14T17:17:00Z' }
    }]
  ] as const) {
    it(`${label}: same mean brightness, shadow band lifted to the lit stone, window contrast kept, gutter untouched`, async () => {
      const input = facade(256, 0.4 * 256);
      const out = await delight(input, opts);
      shot(`facade_${label}`, input, out);
      const litStone = (x: number, y: number) => x > 0.6 * 256 && !isWindow(x, y);
      const shadedStone = (x: number, y: number) => x < 0.3 * 256 && !isWindow(x, y);
      const all = () => true;
      expect(Math.abs(stats(out, all).mean - stats(input, all).mean) / stats(input, all).mean).toBeLessThan(0.08);
      expect(stats(out, shadedStone).mean).toBeGreaterThan(0.85 * stats(out, litStone).mean);
      const contrast = (img: Img) => stats(img, litStone).mean - stats(img, (x, y) => x > 0.6 * 256 && isWindow(x, y)).mean;
      expect(contrast(out)).toBeGreaterThan(0.7 * contrast(input));
      expect(nearWhite(out)).toBeLessThan(0.05);
      for (let i = 0; i < out.rgba.length; i += 4) if (!input.rgba[i + 3]) expect(out.rgba[i] | out.rgba[i + 1] | out.rgba[i + 2] | out.rgba[i + 3]).toBe(0);
    });
  }

  it('a hard shadow edge inside a cell leaves no dark band on the shadow side and no bright band on the lit side', async () => {
    // 512 px (32 px cells); the edge at x = 250 falls inside a cell
    const input = make(512, 512, (x, y) => (200 + ((x * 7 + y * 13) % 5) - 2) * (x < 250 ? 0.45 : 1));
    const out = await delight(input);
    shot('hard_edge', input, out);
    const lit = stats(out, x => x >= 330).mean;
    expect(stats(out, x => x < 170).mean).toBeGreaterThan(0.9 * lit);
    expect(stats(out, x => x >= 234 && x < 246).mean).toBeGreaterThan(0.85 * lit); // half a cell before the edge
    const litNearEdge = stats(out, x => x >= 254 && x < 266).mean;
    expect(litNearEdge).toBeLessThan(1.08 * lit);
    expect(litNearEdge).toBeGreaterThan(0.92 * lit);
  });

  it('neighbouring UV charts do not bleed into each other: the gain is constant inside each flat chart', async () => {
    // Two flat charts (no shading) separated by a 2 px gutter, boundaries off the 32 px grid
    const input = make(512, 512, (x, y) => (y < 8 || y >= 504 ? null : x >= 8 && x < 301 ? 180 : x >= 303 && x < 504 ? 90 : null));
    const out = await delight(input);
    shot('two_charts', input, out);
    expect(stats(out, x => x >= 8 && x < 301).std).toBeLessThan(2);
    expect(stats(out, x => x >= 303 && x < 504).std).toBeLessThan(2);
  });

  it('a partial grid cell at the image edge does not divide away a narrow dark border or clip the stone beside it', async () => {
    // 1000 px: 62 px cells, the last column of cells is 8 px wide and holds only the border
    const input = make(1000, 1000, x => (x >= 992 ? 40 : 200));
    const out = await delight(input);
    shot('partial_cell', input, out);
    expect(nearWhite(out)).toBeLessThan(0.005);
    expect(stats(out, x => x >= 992).mean).toBeLessThan(1.3 * stats(input, x => x >= 992).mean);
    const far = stats(out, x => x < 800).mean;
    expect(Math.abs(stats(out, x => x >= 960 && x < 992).mean - far) / far).toBeLessThan(0.08);
  });

  it('a large bright non-surface region (blank background, sky) does not brighten the rest of the image', async () => {
    // Facade on the left 60%, a flat near-white background on the right 40%
    const input = make(512, 512, (x, y) => (x >= 307 ? 228 : isWindow(x, y) ? 60 : 160));
    const out = await delight(input);
    shot('bright_background', input, out);
    const facadeStone = (x: number, y: number) => x < 280 && !isWindow(x, y);
    const all = () => true;
    expect(Math.abs(stats(out, all).mean - stats(input, all).mean) / stats(input, all).mean).toBeLessThan(0.08);
    // The darker facade lifts somewhat toward the background (brightness can't tell material from shadow: about
    // +15% here); a reference set by the bright region instead would lift it by about +45% and wash it out.
    expect(stats(out, facadeStone).mean).toBeLessThan(1.25 * stats(input, facadeStone).mean);
    expect(nearWhite(out)).toBeLessThan(0.45);
  });
});
