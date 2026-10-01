/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { getSolarPosition } from '../../../../common/coordinate/solarPosition';
import type { SpatialGeodeticAnchor } from '../../../../common/spatial/spatial-generative-protocol';

export type DiurnalPhase =
  | 'astronomical_night'
  | 'nautical_twilight'
  | 'civil_twilight'
  | 'dawn'
  | 'golden_hour'
  | 'morning'
  | 'solar_noon'
  | 'afternoon'
  | 'sunset'
  | 'dusk';

export interface RadiometricState {
  solarVector: THREE.Vector3;
  solarAzimuthDeg: number;
  solarElevationDeg: number;
  diurnalPhase: DiurnalPhase;
  sunColor: THREE.Color;
  sunIntensity: number;
  skyAmbientColor: THREE.Color;
  skyAmbientIntensity: number;
  kelvinTemperature: number;
}

/**
 * GLSL Shader Chunk to lift baked-in high-noon shadows on Google Photorealistic 3D Tiles.
 */
export const TILE_DE_LIGHTING_SHADER_CHUNK = /* glsl */ `
#ifdef USE_DE_LIGHTING
  uniform float uShadowLiftGain;      // 0.0 to 1.5 (default ~0.6)
  uniform float uShadowThresholdLow;  // luminance low bound (default ~0.15)
  uniform float uShadowThresholdHigh; // luminance high bound (default ~0.45)
  uniform vec3 uTargetSunColor;       // Color of active target sun
  uniform float uTargetSunIntensity;

  vec3 applyShadowLiftAndRelighting(vec3 baseColor, vec3 normal) {
    // Rec. 709 linear luminance
    float lum = dot(baseColor, vec3(0.2126, 0.7152, 0.0722));
    
    // Detect dark shadow regions
    float shadowMask = 1.0 - smoothstep(uShadowThresholdLow, uShadowThresholdHigh, lum);
    
    // Lift dynamic range in shadow crevices
    vec3 liftedColor = baseColor * (1.0 + shadowMask * uShadowLiftGain);

    // Subtle re-tint with target sun color
    liftedColor = mix(liftedColor, liftedColor * uTargetSunColor, 0.25 * uTargetSunIntensity);
    return liftedColor;
  }
#endif
`;

/**
 * Coordinates physical solar ephemeris, atmospheric scattering, and GLSL de-lighting
 * to unify Google 3D Tiles and generative media under identical radiometric conditions.
 */
export class RadiometricSolarHarmonizer {
  private anchor: SpatialGeodeticAnchor;
  private targetDate: Date;
  private shadowLiftGain: number = 0.6;
  private shadowThresholdLow: number = 0.12;
  private shadowThresholdHigh: number = 0.40;

  // Scene lighting primitives
  private directionalSun: THREE.DirectionalLight;
  private ambientSky: THREE.HemisphereLight;

  constructor(anchor: SpatialGeodeticAnchor, initialDate?: Date) {
    this.anchor = { ...anchor };
    this.targetDate = initialDate ?? new Date();

    this.directionalSun = new THREE.DirectionalLight(0xffffff, 1.0);
    this.directionalSun.castShadow = true;
    this.ambientSky = new THREE.HemisphereLight(0x87ceeb, 0x3d3d3d, 0.6);

    this.updateLighting();
  }

  public setAnchor(anchor: SpatialGeodeticAnchor): void {
    this.anchor = { ...anchor };
    this.updateLighting();
  }

  public setDate(date: Date): void {
    this.targetDate = date;
    this.updateLighting();
  }

  public setShadowLiftParameters(gain: number, lowThresh: number = 0.12, highThresh: number = 0.40): void {
    this.shadowLiftGain = Math.max(0, Math.min(2.0, gain));
    this.shadowThresholdLow = Math.max(0.01, lowThresh);
    this.shadowThresholdHigh = Math.max(this.shadowThresholdLow + 0.05, highThresh);
  }

  /**
   * Attaches the unified sun and ambient sky lights to the target Three.js scene.
   */
  public attachToScene(scene: THREE.Scene): void {
    scene.add(this.directionalSun);
    scene.add(this.ambientSky);
  }

  /**
   * Computes the current radiometric state and updates directional & ambient lights.
   */
  public updateLighting(): RadiometricState {
    const solar = getSolarPosition(this.targetDate, this.anchor.latitude, this.anchor.longitude);
    const solarAzimuthDeg = solar.azimuthDegrees ?? (solar.azimuth * 180) / Math.PI;
    const solarElevationDeg = solar.altitudeDegrees ?? (solar.altitude * 180) / Math.PI;

    // Convert to Three.js coordinates (+X East, +Y Up, -Z North)
    const azRad = (solarAzimuthDeg * Math.PI) / 180;
    const elRad = (solarElevationDeg * Math.PI) / 180;
    const sunDir = new THREE.Vector3(
      Math.cos(elRad) * Math.sin(azRad),
      Math.sin(elRad),
      -Math.cos(elRad) * Math.cos(azRad)
    ).normalize();

    const phase = RadiometricSolarHarmonizer.classifyDiurnalPhase(solarElevationDeg);
    const { kelvin, intensity, skyIntensity } = RadiometricSolarHarmonizer.getDiurnalPhotometrics(solarElevationDeg);

    const sunColor = RadiometricSolarHarmonizer.kelvinToRGB(kelvin);
    const skyAmbientColor = new THREE.Color(0.53, 0.81, 0.98); // Skylight blue

    // Update Three.js lights
    this.directionalSun.position.copy(sunDir.clone().multiplyScalar(500));
    this.directionalSun.color.copy(sunColor);
    this.directionalSun.intensity = intensity;

    this.ambientSky.color.copy(skyAmbientColor);
    this.ambientSky.intensity = skyIntensity;

    return {
      solarVector: sunDir,
      solarAzimuthDeg,
      solarElevationDeg,
      diurnalPhase: phase,
      sunColor,
      sunIntensity: intensity,
      skyAmbientColor,
      skyAmbientIntensity: skyIntensity,
      kelvinTemperature: kelvin
    };
  }

  /**
   * Applies the shadow-lift de-lighting chunk to a Google 3D Tiles material.
   */
  public applyDeLightingToTileMaterial(material: THREE.Material): void {
    if (!(material as any).isMeshStandardMaterial && !(material as any).isMeshBasicMaterial) return;

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uShadowLiftGain = { value: this.shadowLiftGain };
      shader.uniforms.uShadowThresholdLow = { value: this.shadowThresholdLow };
      shader.uniforms.uShadowThresholdHigh = { value: this.shadowThresholdHigh };
      shader.uniforms.uTargetSunColor = { value: this.directionalSun.color };
      shader.uniforms.uTargetSunIntensity = { value: this.directionalSun.intensity };

      shader.fragmentShader = `#define USE_DE_LIGHTING 1\n` + TILE_DE_LIGHTING_SHADER_CHUNK + shader.fragmentShader;

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        #ifdef USE_DE_LIGHTING
          diffuseColor.rgb = applyShadowLiftAndRelighting(diffuseColor.rgb, vNormal);
        #endif
        `
      );
    };

    material.needsUpdate = true;
  }

  /**
   * Classifies the 10 diurnal lighting phases based on solar elevation in degrees.
   */
  public static classifyDiurnalPhase(elevationDeg: number): DiurnalPhase {
    if (elevationDeg < -18) return 'astronomical_night';
    if (elevationDeg < -12) return 'nautical_twilight';
    if (elevationDeg < -6) return 'civil_twilight';
    if (elevationDeg < 0) return 'dawn';
    if (elevationDeg < 12) return 'golden_hour';
    if (elevationDeg < 35) return 'morning';
    if (elevationDeg < 65) return 'solar_noon';
    if (elevationDeg >= 65) return 'solar_noon';
    return 'afternoon';
  }

  /**
   * Computes photometric intensity and blackbody Kelvin color temperature for an elevation.
   */
  public static getDiurnalPhotometrics(elevationDeg: number): { kelvin: number; intensity: number; skyIntensity: number } {
    if (elevationDeg <= -12) {
      return { kelvin: 40000, intensity: 0.02, skyIntensity: 0.05 }; // Deep night
    }
    if (elevationDeg <= 0) {
      // Twilight transition
      const t = (elevationDeg + 12) / 12;
      return {
        kelvin: 2500 + t * 500,
        intensity: 0.05 + t * 0.2,
        skyIntensity: 0.1 + t * 0.3
      };
    }
    if (elevationDeg <= 12) {
      // Golden Hour
      const t = elevationDeg / 12;
      return {
        kelvin: 3000 + t * 1500,
        intensity: 0.25 + t * 0.6,
        skyIntensity: 0.4 + t * 0.3
      };
    }
    // Midday / Daylight
    const t = Math.min(1.0, (elevationDeg - 12) / 48);
    return {
      kelvin: 4500 + t * 2000, // 4,500K -> 6,500K
      intensity: 0.85 + t * 0.35,
      skyIntensity: 0.7 + t * 0.3
    };
  }

  /**
   * Converts a Planckian blackbody Kelvin temperature (1,000K to 40,000K) to linear RGB.
   */
  public static kelvinToRGB(kelvin: number): THREE.Color {
    const temp = Math.max(1000, Math.min(40000, kelvin)) / 100;
    let r = 0;
    let g = 0;
    let b = 0;

    // Red
    if (temp <= 66) {
      r = 255;
    } else {
      r = temp - 60;
      r = 329.698727446 * Math.pow(r, -0.1332047592);
      r = Math.max(0, Math.min(255, r));
    }

    // Green
    if (temp <= 66) {
      g = temp;
      g = 99.4708025861 * Math.log(g) - 161.1195681661;
      g = Math.max(0, Math.min(255, g));
    } else {
      g = temp - 60;
      g = 288.1221695283 * Math.pow(g, -0.0755148492);
      g = Math.max(0, Math.min(255, g));
    }

    // Blue
    if (temp >= 66) {
      b = 255;
    } else if (temp <= 19) {
      b = 0;
    } else {
      b = temp - 10;
      b = 138.5177312231 * Math.log(b) - 305.0447927307;
      b = Math.max(0, Math.min(255, b));
    }

    return new THREE.Color(r / 255, g / 255, b / 255);
  }

  public dispose(): void {
    this.directionalSun.dispose();
  }
}
