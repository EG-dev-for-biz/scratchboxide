/**
 * WeatheringService Test: Validates material aging synthesis
 * Specifically tests the fire hydrant case: M&H 1964 cast iron, 62 years urban exposure
 */

import { describe, it, expect } from 'vitest';
import { WeatheringService } from '../src/node/3d-engine/weathering-service';

describe('WeatheringService', () => {
  const service = new WeatheringService();

  it('should list available materials', () => {
    const materials = service.getAvailableMaterials();
    expect(materials).toContain('cast_iron');
    expect(materials).toContain('copper');
    expect(materials).toContain('limestone');
    expect(materials.length).toBeGreaterThan(0);
  });

  it('should retrieve material calibration', () => {
    const calib = service.getMaterialCalibration('cast_iron');
    expect(calib).toBeDefined();
    expect(calib?.name).toBe('Cast Iron');
    expect(calib?.climateModifiers.urban).toBeDefined();
    expect(calib?.exposureMultipliers.exposed).toBe(1.0);
  });

  it('should synthesize weathering textures for hydrant (M&H 1964)', async () => {
    const result = await service.synthesizeWeathering({
      material: 'cast_iron',
      ageYears: 62, // 1964 + 62 = 2026
      climateZone: 'urban',
      exposureType: 'exposed',
      textureWidth: 2048, // Use 2K for test speed
      textureHeight: 2048
    });

    // Verify output structure
    expect(result.colorMap).toBeDefined();
    expect(result.colorMap.length).toBe(2048 * 2048 * 3); // RGB
    expect(result.normalMap).toBeDefined();
    expect(result.normalMap.length).toBe(2048 * 2048 * 3);
    expect(result.roughnessMap).toBeDefined();
    expect(result.roughnessMap.length).toBe(2048 * 2048);
    expect(result.metallicMap).toBeDefined();
    expect(result.metallicMap.length).toBe(2048 * 2048);

    // Verify metadata
    expect(result.metadata.material).toBe('Cast Iron');
    expect(result.metadata.ageYears).toBe(62);
    expect(result.metadata.climate).toBe('urban');
    expect(result.metadata.exposure).toBe('exposed');
    expect(result.metadata.confidence).toBeGreaterThan(0.8); // Well-calibrated

    // Verify age progression: 62 years should be dark rust
    // Color should skew toward rust brown [0.45, 0.28, 0.20]
    // Check first pixel as a sample
    const colorR = result.colorMap[0];
    const colorG = result.colorMap[1];
    const colorB = result.colorMap[2];

    // Rust colors are darker and more brown—R > G > B with lower absolute values
    expect(colorR).toBeLessThan(200); // Darkened from fresh [217, 148, 102]
    expect(colorR).toBeGreaterThan(colorG); // Red channel dominates
    expect(colorG).toBeGreaterThan(colorB); // Green > Blue

    // Roughness should be high (heavy oxidation)
    const roughness = result.roughnessMap[0] / 255;
    expect(roughness).toBeGreaterThan(0.70);

    // Metallic should be low (heavily oxidized, not bare metal)
    const metallic = result.metallicMap![0] / 255;
    expect(metallic).toBeLessThan(0.3);
  });

  it('should respect climate modifiers', async () => {
    // Generate two scenarios: marine vs desert
    const marine = await service.synthesizeWeathering({
      material: 'cast_iron',
      ageYears: 30,
      climateZone: 'marine',
      exposureType: 'exposed',
      textureWidth: 1024,
      textureHeight: 1024
    });

    const desert = await service.synthesizeWeathering({
      material: 'cast_iron',
      ageYears: 30,
      climateZone: 'desert',
      exposureType: 'exposed',
      textureWidth: 1024,
      textureHeight: 1024
    });

    // Marine should be darker/more corroded (higher rust rate)
    // Desert should retain more color (lower rust rate)
    const marineAvgColor =
      (marine.colorMap[0] + marine.colorMap[1] + marine.colorMap[2]) / 3;
    const desertAvgColor =
      (desert.colorMap[0] + desert.colorMap[1] + desert.colorMap[2]) / 3;

    expect(marineAvgColor).toBeLessThan(desertAvgColor); // Marine darker
    expect(marine.metadata.notes).toContain('1.8'); // 1.8x rust rate
    expect(desert.metadata.notes).toContain('0.6'); // 0.6x rust rate
  });

  it('should respect exposure multipliers', async () => {
    const exposed = await service.synthesizeWeathering({
      material: 'cast_iron',
      ageYears: 40,
      climateZone: 'urban',
      exposureType: 'exposed',
      textureWidth: 1024,
      textureHeight: 1024
    });

    const sheltered = await service.synthesizeWeathering({
      material: 'cast_iron',
      ageYears: 40,
      climateZone: 'urban',
      exposureType: 'sheltered',
      textureWidth: 1024,
      textureHeight: 1024
    });

    // Exposed should be more weathered than sheltered
    const exposedAvgRoughness =
      Array.from(exposed.roughnessMap).reduce((a, b) => a + b) /
      exposed.roughnessMap.length /
      255;
    const shelteredAvgRoughness =
      Array.from(sheltered.roughnessMap).reduce((a, b) => a + b) /
      sheltered.roughnessMap.length /
      255;

    expect(exposedAvgRoughness).toBeGreaterThan(shelteredAvgRoughness);
  });

  it('should handle age progression smoothly', async () => {
    // Young, middle-aged, and old
    const young = await service.synthesizeWeathering({
      material: 'cast_iron',
      ageYears: 5,
      climateZone: 'urban',
      exposureType: 'exposed',
      textureWidth: 512,
      textureHeight: 512
    });

    const middleAged = await service.synthesizeWeathering({
      material: 'cast_iron',
      ageYears: 50,
      climateZone: 'urban',
      exposureType: 'exposed',
      textureWidth: 512,
      textureHeight: 512
    });

    const old = await service.synthesizeWeathering({
      material: 'cast_iron',
      ageYears: 150,
      climateZone: 'urban',
      exposureType: 'exposed',
      textureWidth: 512,
      textureHeight: 512
    });

    const youngColor =
      (young.colorMap[0] + young.colorMap[1] + young.colorMap[2]) / 3;
    const middleColor =
      (middleAged.colorMap[0] + middleAged.colorMap[1] + middleAged.colorMap[2]) /
      3;
    const oldColor =
      (old.colorMap[0] + old.colorMap[1] + old.colorMap[2]) / 3;

    // Should darken monotonically with age
    expect(youngColor).toBeGreaterThan(middleColor);
    expect(middleColor).toBeGreaterThan(oldColor);
  });

  it('should return valid confidence scores', async () => {
    const result = await service.synthesizeWeathering({
      material: 'cast_iron',
      ageYears: 40,
      climateZone: 'urban',
      exposureType: 'exposed',
      textureWidth: 1024,
      textureHeight: 1024
    });

    expect(result.metadata.confidence).toBeGreaterThanOrEqual(0);
    expect(result.metadata.confidence).toBeLessThanOrEqual(1);
  });

  it('should fallback gracefully for unknown materials', async () => {
    const result = await service.synthesizeWeathering({
      material: 'unknown_material_xyz',
      ageYears: 50,
      climateZone: 'urban',
      exposureType: 'exposed',
      textureWidth: 512,
      textureHeight: 512
    });

    expect(result.success ?? true).toBe(true); // Should not crash
    expect(result.colorMap).toBeDefined();
    expect(result.metadata.confidence).toBeLessThan(0.8); // Lower confidence for unknown
  });
});
