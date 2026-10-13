import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { MaxRectsAtlasPacker } from '../src/node/spatial/TextureAtlasPacker';
import { AlgorithmicUvEngine } from '../src/node/spatial/AlgorithmicUvEngine';
import { TaskCapabilityResolver } from '../src/node/agent/task-capability-resolver';
import { createDefaultToolRegistry } from '../src/node/gemini/tool-registry';

describe('Algorithmic UV Unwrap & Rewrap Engine', () => {
  it('correctly calculates 2D affine determinant and inverse barycentric weights', () => {
    // 3D Triangle
    const v0 = [0, 0, 0];
    const v1 = [10, 0, 0];
    const v2 = [0, 10, 0];

    // UV Triangle
    const u0 = [0.1, 0.1];
    const u1 = [0.9, 0.1];
    const u2 = [0.1, 0.9];

    const det = (u1[1] - u2[1]) * (u0[0] - u2[0]) + (u2[0] - u1[0]) * (u0[1] - u2[1]);
    expect(det).not.toBe(0);

    // Test centroid in UV space
    const puv = [(u0[0] + u1[0] + u2[0]) / 3, (u0[1] + u1[1] + u2[1]) / 3];

    const l0 = ((u1[1] - u2[1]) * (puv[0] - u2[0]) + (u2[0] - u1[0]) * (puv[1] - u2[1])) / det;
    const l1 = ((u2[1] - u0[1]) * (puv[0] - u2[0]) + (u0[0] - u2[0]) * (puv[1] - u2[1])) / det;
    const l2 = 1.0 - l0 - l1;

    expect(l0).toBeCloseTo(1 / 3, 4);
    expect(l1).toBeCloseTo(1 / 3, 4);
    expect(l2).toBeCloseTo(1 / 3, 4);

    // Reconstruct 3D position
    const pWorld = [
      l0 * v0[0] + l1 * v1[0] + l2 * v2[0],
      l0 * v0[1] + l1 * v1[1] + l2 * v2[1],
      l0 * v0[2] + l1 * v1[2] + l2 * v2[2],
    ];

    expect(pWorld[0]).toBeCloseTo(10 / 3, 4);
    expect(pWorld[1]).toBeCloseTo(10 / 3, 4);
    expect(pWorld[2]).toBeCloseTo(0, 4);
  });

  it('correctly discriminates asphalt roadway vs tree canopy vs travertine stone', () => {
    function classifyMaterial(r: number, g: number, b: number, wy: number, absNy: number) {
      if (g > r + 3 && g > b + 3 && g > 45) {
        return 'foliage';
      }
      if (wy < 73.5 || (absNy > 0.70 && wy < 80.0)) {
        return 'asphalt';
      }
      const isWarmLimestone = r > g && g >= b && r - b >= 14 && r > 90;
      if (isWarmLimestone && wy >= 73.5) {
        return 'travertine';
      }
      return 'stucco';
    }

    // Asphalt test (elevation 70m, grey color)
    expect(classifyMaterial(50, 52, 55, 68.0, 0.95)).toBe('asphalt');

    // Foliage test (green color)
    expect(classifyMaterial(40, 80, 42, 75.0, 0.3)).toBe('foliage');

    // Travertine test (warm limestone color, elevation 85m on facade wall)
    expect(classifyMaterial(170, 150, 130, 85.0, 0.15)).toBe('travertine');

    // Upper walkway test (elevation 78m, horizontal normal absNy > 0.70)
    expect(classifyMaterial(160, 155, 150, 78.0, 0.88)).toBe('asphalt');
  });

  it('validates scene-wide repacked GLB model integrity across all 79 submeshes', () => {
    const glbPath = path.resolve(__dirname, '../../../public/models/colosseum_rome_shape_grounded.glb');
    expect(fs.existsSync(glbPath)).toBe(true);

    const glb = fs.readFileSync(glbPath);
    expect(glb.length).toBeGreaterThan(15 * 1024 * 1024); // > 15MB

    const magic = glb.readUInt32LE(0);
    expect(magic).toBe(0x46546c67); // 'glTF'

    const jsonLen = glb.readUInt32LE(12);
    const gltf = JSON.parse(glb.toString('utf8', 20, 20 + jsonLen));

    // Verify all 79 meshes, materials, and textures exist
    expect(gltf.meshes.length).toBe(79);
    expect(gltf.materials.length).toBe(79);
    expect(gltf.textures.length).toBe(79);
    expect(gltf.images.length).toBe(79);

    // Verify all images have valid JPEG headers (0xFF, 0xD8)
    const binBuffer = glb.subarray(20 + jsonLen + 8);
    for (let i = 0; i < gltf.images.length; i++) {
      const img = gltf.images[i];
      const bv = gltf.bufferViews[img.bufferView];
      const bytes = binBuffer.subarray(bv.byteOffset, bv.byteOffset + bv.byteLength);
      expect(bytes[0]).toBe(0xFF);
      expect(bytes[1]).toBe(0xD8);
    }
  });

  it('packs texture charts with MaxRectsAtlasPacker achieving high fill efficiency with 90-degree rotations', () => {
    const packer = new MaxRectsAtlasPacker({
      padding: 2,
      allowRotation: true
    });

    // Add diverse non-square rectangles
    packer.addTexture({ id: 'facade_long', width: 256, height: 64 });
    packer.addTexture({ id: 'facade_tall', width: 64, height: 256 });
    packer.addTexture({ id: 'archway_square', width: 128, height: 128 });
    packer.addTexture({ id: 'cornice_strip', width: 256, height: 32 });
    packer.addTexture({ id: 'column_strip', width: 32, height: 256 });
    packer.addTexture({ id: 'entablature', width: 128, height: 64 });
    packer.addTexture({ id: 'keystone', width: 64, height: 64 });

    const result = packer.pack();

    expect(result.width).toBeGreaterThanOrEqual(256);
    expect(result.height).toBeGreaterThanOrEqual(256);
    expect(result.rectList.length).toBe(7);
    expect(result.tightFillRate).toBeGreaterThan(0.60); // Significant density boost
    // Verify no overlapping charts
    for (let i = 0; i < result.rectList.length; i++) {
      for (let j = i + 1; j < result.rectList.length; j++) {
        const a = result.rectList[i];
        const b = result.rectList[j];
        const noOverlap =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(noOverlap).toBe(true);
      }
    }
  });

  it('decomposes intrinsic albedo and synthesizes complete PBR material suite', async () => {
    const width = 64;
    const height = 64;
    const rgba = new Uint8Array(width * height * 4);

    // Warm limestone travertine pattern with a gradient
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const val = 150 + Math.sin(x * 0.2) * 20;
        rgba[idx] = Math.min(255, val + 20); // R
        rgba[idx + 1] = Math.min(255, val); // G
        rgba[idx + 2] = Math.min(255, val - 20); // B
        rgba[idx + 3] = 255;
      }
    }

    const pbr = await AlgorithmicUvEngine.decomposePbr(rgba, {
      enableAlbedoDeLighting: true,
      normalStrength: 3.0,
      defaultStoneRoughness: 0.85,
      skyDomeAoIntensity: 1.0,
      packOrm: true
    }, width, height);

    expect(pbr.width).toBe(width);
    expect(pbr.height).toBe(height);
    expect(pbr.albedo).toBeDefined();
    expect(pbr.normal).toBeDefined();
    expect(pbr.roughness).toBeDefined();
    expect(pbr.ao).toBeDefined();
    expect(pbr.orm).toBeDefined();

    // Check normal map validity (blue channel dominant >= 128 for unit Z normal)
    if (pbr.normal) {
      for (let i = 0; i < width * height; i++) {
        const b = pbr.normal[i * 4 + 2];
        expect(b).toBeGreaterThanOrEqual(120);
      }
    }

    // Check ORM channels: Red = AO (>= 0), Green = Roughness (~216 for 0.85), Blue = Metallic (0)
    if (pbr.orm) {
      const g = pbr.orm[1]; // Roughness channel of first pixel
      expect(g).toBeGreaterThan(150); // High roughness for travertine
      const b = pbr.orm[2]; // Metallic channel of first pixel
      expect(b).toBe(0); // Dielectric stone is non-metallic
    }
  });

  it('resolves algorithmic UV and PBR tasks natively in TaskCapabilityResolver', () => {
    const result = TaskCapabilityResolver.resolveTaskCapability('Perform algorithmic UV unwrap and rewrap with travertine cavitation pores and PBR decomposition');

    expect(result.canSolveNatively).toBe(true);
    expect(result.tier1Assessment.canSolveNatively).toBe(true);
    expect(result.tier1Assessment.primaryNativeEngine).toBe('cpp-3d-engine');
    expect(result.tier1Assessment.nativeCapabilitiesUsed).toContain('Algorithmic UV Unwrap & Rewrap Engine (AlgorithmicUvEngine)');
  });

  it('provides registered Gemini agent tools for Algorithmic UV unwrapping and packing', async () => {
    const registry = createDefaultToolRegistry();

    expect(registry.has('algorithmic_uv_unwrap_rewrap')).toBe(true);
    expect(registry.has('pbr_material_decompose')).toBe(true);
    expect(registry.has('atlas_maxrects_pack')).toBe(true);

    // Test atlas_maxrects_pack via dispatch
    const outcome = await registry.dispatch('atlas_maxrects_pack', {
      rectangles: [
        { id: 'tile1', width: 128, height: 64 },
        { id: 'tile2', width: 64, height: 128 },
        { id: 'tile3', width: 64, height: 64 }
      ],
      padding: 2,
      allowRotation: true
    }, { sessionId: 'test', cancellationToken: { isCancellationRequested: false } as any });

    expect(outcome.exec.status).toBe('completed');
    expect(outcome.exec.summaryResult).toContain('MaxRects Atlas Packing complete');
    const payload = outcome.resultPayload as any;
    expect(payload.success).toBe(true);
    expect(payload.rectCount).toBe(3);
  });

  it('computes texel density metrics and detects variance across submeshes', () => {
    const colosseumPath = path.resolve(__dirname, '../../../public/models/colosseum_rome_shape_grounded.glb');
    const buffer = fs.readFileSync(colosseumPath);
    const metrics = AlgorithmicUvEngine.computeTexelDensity(buffer, 512);

    expect(metrics.meanTexelsPerMeter).toBeGreaterThan(0);
    expect(metrics.minTexelsPerMeter).toBeGreaterThan(0);
    expect(metrics.maxTexelsPerMeter).toBeGreaterThanOrEqual(metrics.minTexelsPerMeter);
    expect(metrics.varianceRatio).toBeGreaterThanOrEqual(1.0);
    expect(metrics.totalWorldAreaSqMeters).toBeGreaterThan(0);
    expect(metrics.normalizedChartsCount).toBeGreaterThan(0);
  });

  it('provides specialized lithology presets for classical stone, limestone, and modern curtain walls', () => {
    const travertine = AlgorithmicUvEngine.getLithologyPreset('classical-travertine');
    expect(travertine.cavitationDepthPower).toBe(52.0);
    expect(travertine.poreScale).toBe('macropore');
    expect(travertine.metalness).toBe(0.0);

    const limestone = AlgorithmicUvEngine.getLithologyPreset('bedford-limestone');
    expect(limestone.cavitationDepthPower).toBe(42.0);
    expect(limestone.poreScale).toBe('micropore');
    expect(limestone.sharpVerticalMullions).toBe(true);

    const curtainWall = AlgorithmicUvEngine.getLithologyPreset('modern-curtain-wall');
    expect(curtainWall.cavitationDepthPower).toBe(0.0);
    expect(curtainWall.poreScale).toBe('none');
    expect(curtainWall.metalness).toBe(0.65);
    expect(curtainWall.planarNormals).toBe(true);
  });

  it('applies height-stratified shadow lift in deep street canyons', async () => {
    const width = 16;
    const height = 16;
    const darkPixels = new Uint8Array(width * height * 4);
    // Dark shadow area (luminance ~0.2)
    darkPixels.fill(50);
    for (let i = 3; i < darkPixels.length; i += 4) darkPixels[i] = 255;

    // Ground floor street level (normalizedElevationY = 0.0) with stratified de-lighting
    const groundFloorRes = await AlgorithmicUvEngine.decomposePbr(darkPixels, {
      enableAlbedoDeLighting: true,
      enableHeightStratifiedDeLighting: true,
      normalizedElevationY: 0.0
    }, width, height);

    // Sky deck observation level (normalizedElevationY = 1.0) with stratified de-lighting
    const skyDeckRes = await AlgorithmicUvEngine.decomposePbr(darkPixels, {
      enableAlbedoDeLighting: true,
      enableHeightStratifiedDeLighting: true,
      normalizedElevationY: 1.0
    }, width, height);

    // Ground floor should receive higher canyon shadow lift than the sky deck
    const groundSample = groundFloorRes.albedo[0];
    const skySample = skyDeckRes.albedo[0];
    expect(groundSample).toBeGreaterThan(skySample);
  });

  it('injects KHR_texture_transform for scale-invariant micro-detail tiling', async () => {
    const colosseumPath = path.resolve(__dirname, '../../../public/models/colosseum_rome_shape_grounded.glb');
    const result = await AlgorithmicUvEngine.processGlb({
      inputGlbPath: colosseumPath,
      enableMicroDetailTiling: true,
      microDetailScale: 32.0,
      mode: 'preserve-100-lock'
    });

    expect(result.success).toBe(true);
    expect(result.microDetailTilingInjected).toBe(true);

    // Verify KHR_texture_transform in output GLB
    const parsed = (AlgorithmicUvEngine as any).parseGlb(result.outputGlbBuffer);
    expect(parsed.json.extensionsUsed).toContain('KHR_texture_transform');
    const firstMat = parsed.json.materials[0];
    const ext = firstMat?.pbrMetallicRoughness?.baseColorTexture?.extensions?.KHR_texture_transform;
    expect(ext).toBeDefined();
    expect(ext.scale).toEqual([32.0, 32.0]);
  });

  it('dispatches uv_analyze_texel_density and algorithmic_uv_unwrap_rewrap with lithologyProfile via Gemini agent tool registry', async () => {
    const registry = createDefaultToolRegistry();
    const colosseumPath = path.resolve(__dirname, '../../../public/models/colosseum_rome_shape_grounded.glb');

    expect(registry.has('uv_analyze_texel_density')).toBe(true);

    const outcomeDensity = await registry.dispatch('uv_analyze_texel_density', {
      inputGlbPath: colosseumPath,
      defaultTexSize: 512
    }, { sessionId: 'test', cancellationToken: { isCancellationRequested: false } as any });

    expect(outcomeDensity.exec.status).toBe('completed');
    expect(outcomeDensity.exec.summaryResult).toContain('Texel Density Analysis complete');
    const densityPayload = outcomeDensity.resultPayload as any;
    expect(densityPayload.metrics.meanTexelsPerMeter).toBeGreaterThan(0);

    const outcomeUv = await registry.dispatch('algorithmic_uv_unwrap_rewrap', {
      inputGlbPath: colosseumPath,
      mode: 'preserve-100-lock',
      lithologyProfile: 'bedford-limestone',
      enableHeightStratifiedDeLighting: true,
      enableMicroDetailTiling: true,
      microDetailScale: 32.0
    }, { sessionId: 'test', cancellationToken: { isCancellationRequested: false } as any });

    expect(outcomeUv.exec.status).toBe('completed');
    expect(outcomeUv.exec.summaryResult).toContain('Algorithmic UV Unwrap & Rewrap Engine completed');
    const uvPayload = outcomeUv.resultPayload as any;
    expect(uvPayload.lithologyProfile).toBe('bedford-limestone');
    expect(uvPayload.microDetailTilingInjected).toBe(true);
    expect(uvPayload.texelDensityMetrics).toBeDefined();
  });

  describe('Adaptive Domain Biophysical PBR & Signal Induction Suite', () => {
    it('resolves biophysical material contracts dynamically with zero closed taxonomies', () => {
      // 1. Direct continuous contract parameterization
      const customContract = AlgorithmicUvEngine.resolveBiophysicalContract({
        roughness: 0.42,
        metalness: 0.95,
        normalStrength: 4.8,
        hbaoIntensity: 1.5,
        laplacianBurnishFactor: 0.6
      });
      expect(customContract.roughness).toBe(0.42);
      expect(customContract.metalness).toBe(0.95);
      expect(customContract.normalStrength).toBe(4.8);
      expect(customContract.hbaoIntensity).toBe(1.5);
      expect(customContract.laplacianBurnishFactor).toBe(0.6);

      // 2. Open descriptive prompt extraction (zero closed enums)
      const metalPrompt = AlgorithmicUvEngine.resolveBiophysicalContract('patinated bronze statuary with polished copper trim');
      expect(metalPrompt.metalness).toBeGreaterThan(0.7);
      expect(metalPrompt.roughness).toBeLessThan(0.7);

      const vegetationPrompt = AlgorithmicUvEngine.resolveBiophysicalContract('overgrown climbing ivy and leafy tree canopy');
      expect(vegetationPrompt.roughness).toBeLessThan(0.6);
      expect(vegetationPrompt.metalness).toBe(0.0);

      const ashlarPrompt = AlgorithmicUvEngine.resolveBiophysicalContract('ancient travertine monumental facade');
      expect(ashlarPrompt.roughness).toBeGreaterThan(0.75);
      expect(ashlarPrompt.cavitationDepthPower).toBeGreaterThan(1.0);
    });

    it('blends normal vectors using Reoriented Normal Mapping (RNM) preserving unit length', () => {
      const baseNormal: [number, number, number] = [0, 0, 1];
      const detailNormal: [number, number, number] = [0.2, -0.3, 0.9327]; // normalized

      const blended = AlgorithmicUvEngine.blendNormalsRNM(baseNormal, detailNormal);
      const len = Math.sqrt(blended[0] * blended[0] + blended[1] * blended[1] + blended[2] * blended[2]);

      expect(len).toBeCloseTo(1.0, 4);
      expect(blended[0]).toBeCloseTo(detailNormal[0], 2);
      expect(blended[1]).toBeCloseTo(detailNormal[1], 2);
      expect(blended[2]).toBeGreaterThan(0.8);

      // Non-trivial base normal blend
      const n1: [number, number, number] = [0.3, 0.1, 0.9487];
      const n2: [number, number, number] = [-0.1, 0.4, 0.9110];
      const b2 = AlgorithmicUvEngine.blendNormalsRNM(n1, n2);
      const len2 = Math.sqrt(b2[0] * b2[0] + b2[1] * b2[1] + b2[2] * b2[2]);
      expect(len2).toBeCloseTo(1.0, 4);
      expect(b2[2]).toBeGreaterThan(0.5);
    });

    it('synthesizes multi-frequency normal maps using Scharr gradients and RNM blending', () => {
      const w = 64;
      const h = 64;
      const lum = new Float32Array(w * h);

      // Generate synthetic checker / stepped relief
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const macroStep = (x > 32 ? 0.3 : 0.0) + (y > 32 ? 0.2 : 0.0);
          const microNoise = Math.sin(x * 0.8) * Math.cos(y * 0.8) * 0.05;
          lum[y * w + x] = 0.5 + macroStep + microNoise;
        }
      }

      const normalMap = AlgorithmicUvEngine.computeMultiFrequencyNormalMap(lum, w, h, 3.2);
      expect(normalMap.length).toBe(w * h * 4);

      // Check alpha channel is 255 and vectors point outward (Z >= 128)
      let nonFlatCount = 0;
      for (let i = 0; i < w * h; i++) {
        const idx = i * 4;
        expect(normalMap[idx + 3]).toBe(255);
        expect(normalMap[idx + 2]).toBeGreaterThanOrEqual(120); // Z pointing out
        if (Math.abs(normalMap[idx] - 128) > 2 || Math.abs(normalMap[idx + 1] - 128) > 2) {
          nonFlatCount++;
        }
      }
      expect(nonFlatCount).toBeGreaterThan(100);
    });

    it('models biophysical Laplacian curvature roughness (burnish vs cavity dirt)', () => {
      const w = 32;
      const h = 32;
      const lum = new Float32Array(w * h).fill(0.5);

      // Create a sharp ridge at (10, 10) (convex, center > neighbors)
      lum[10 * w + 10] = 0.9;
      // Create a deep crevice at (20, 20) (concave, center < neighbors)
      lum[20 * w + 20] = 0.1;

      const baseRough = 0.80;
      const roughness = AlgorithmicUvEngine.computeBiophysicalRoughness(
        lum, w, h, baseRough, 0.0, 0.4, 0.4
      );

      const ridgeRough = roughness[(10 * w + 10) * 4] / 255.0;
      const creviceRough = roughness[(20 * w + 20) * 4] / 255.0;

      // Ridge is burnished (lower roughness than base)
      expect(ridgeRough).toBeLessThan(baseRough);
      // Crevice has micro-grit/dirt (higher roughness than base)
      expect(creviceRough).toBeGreaterThan(baseRough);
    });

    it('applies Toksvig specular anti-aliasing to fold grazing normal variance into roughness', () => {
      const w = 16;
      const h = 16;
      const roughness = new Uint8Array(w * h * 4).fill(Math.round(0.3 * 255));
      const normals = new Uint8Array(w * h * 4);

      // Populate alternating normals (high variance)
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 4;
          const sign = (x + y) % 2 === 0 ? 1 : -1;
          normals[idx] = Math.round((sign * 0.5 * 0.5 + 0.5) * 255);
          normals[idx + 1] = 128;
          normals[idx + 2] = Math.round((0.866 * 0.5 + 0.5) * 255);
          normals[idx + 3] = 255;
        }
      }

      const filtered = AlgorithmicUvEngine.applyToksvigAntiAliasing(roughness, normals, w, h, 0.8);
      const filteredRough = filtered[(8 * w + 8) * 4] / 255.0;
      // Roughness should increase due to normal variance
      expect(filteredRough).toBeGreaterThan(0.3);
    });

    it('computes 8-directional radial horizon HBAO micro-cavity occlusion', () => {
      const w = 32;
      const h = 32;
      const normals = new Uint8Array(w * h * 4).fill(128);
      for (let i = 0; i < w * h; i++) {
        normals[i * 4 + 2] = 255; // flat upward normal
        normals[i * 4 + 3] = 255;
      }

      // Create a vertical groove with converging normals
      for (let y = 0; y < h; y++) {
        normals[(y * w + 15) * 4] = 200; // slope down
        normals[(y * w + 17) * 4] = 50;  // slope up
      }

      const ao = AlgorithmicUvEngine.computeHbaoMicroCavityAo(normals, w, h, 6, 1.2);
      const cavityAo = ao[(16 * w + 16) * 4] / 255.0;
      const flatAo = ao[(4 * w + 4) * 4] / 255.0;

      // The groove has stronger occlusion (lower AO value) than flat terrain
      expect(cavityAo).toBeLessThan(flatAo);
      expect(cavityAo).toBeLessThan(0.95);
    });

    it('auto-induces unit cell periodicity and module aspect ratio from 1D spatial autocorrelation', () => {
      const w = 128;
      const h = 128;
      const lum = new Float32Array(w * h);

      // Synthesize periodic ashlar masonry (width 32px, height 16px)
      const periodX = 32;
      const periodY = 16;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const modX = x % periodX === 0 ? 0.2 : 0.8;
          const modY = y % periodY === 0 ? 0.2 : 0.8;
          lum[y * w + x] = modX * modY;
        }
      }

      const profile = AlgorithmicUvEngine.analyzeTextureSpatialProfile(lum, w, h, 2.0);
      expect(profile.isPeriodic).toBe(true);
      expect(profile.dominantPeriodPxX).toBe(periodX);
      expect(profile.dominantPeriodPxY).toBe(periodY);
      expect(profile.aspectRatio).toBeCloseTo(periodX / periodY, 1);
      expect(profile.recommendedRepeatX).toBeGreaterThan(1.0);
      expect(profile.recommendedRepeatY).toBeGreaterThan(1.0);
    });

    it('executes processGlb with auto-induced periodicity and biophysical contract', async () => {
      const colosseumPath = path.resolve(__dirname, '../../../public/models/colosseum_rome_shape_grounded.glb');
      const result = await AlgorithmicUvEngine.processGlb({
        inputGlbPath: colosseumPath,
        mode: 'preserve-100-lock',
        autoInducePeriodicity: true,
        biophysicalContract: {
          roughness: 0.78,
          normalStrength: 3.5,
          hbaoIntensity: 1.1,
          laplacianBurnishFactor: 0.4
        }
      });

      expect(result.success).toBe(true);
      expect(result.biophysicalContract).toBeDefined();
      expect(result.biophysicalContract?.roughness).toBe(0.78);
      expect(result.inducedSpatialProfile).toBeDefined();
      expect(result.microDetailTilingInjected).toBe(true);
    });
  });
});


