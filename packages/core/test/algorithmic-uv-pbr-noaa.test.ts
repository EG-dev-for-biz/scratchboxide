import { describe, it, expect } from 'vitest';
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
  it('prioritizes fast draft models including nano-banana-lite in draft fidelity mode', () => {
    expect(IMAGE_MODEL_PRIORITY_DRAFT).toBeDefined();
    expect(IMAGE_MODEL_PRIORITY_DRAFT[0]).toBe('nano-banana-lite');
    expect(IMAGE_MODEL_PRIORITY_DRAFT).toContain('gemini-2.5-flash-image');
  });
});
