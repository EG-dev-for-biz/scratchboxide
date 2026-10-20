/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

export * from './atmosphere-types';
export * from './kelvin';
export * from './solar-position';
export * from './diurnal-lighting';
export * from './AtmosphericSkyDome';
export * from './AerialPerspectiveEffect';
export * from './TerrainCloudShadows';
export * from './VolumetricGodRays';
export * from './volumetric-participating-media';
export * from './AtmosphereService';
export * from './AtmosphereImageEstimationService';
export * from './LocationObjectLightingService';
export * from './sky-photometry';
export {
    spectralSun,
    spectralBeamTransmittance,
    extraterrestrialSolarIrradiance,
    blackbodyLinearRgbSpectral,
    correlatedColorTemperature,
    cieColorMatching,
    kastenYoungAirMass,
    ozoneAbsorption
} from './spectral-sun';
export type { SpectralSun, SpectralSunOptions } from './spectral-sun';
export { resolveCloudShellLayers, MAX_CLOUD_SHELL_LAYERS, MAX_SHELLS_PER_LAYER } from './cloud-shell-layers';
export type { PackedCloudShellLayer } from './cloud-shell-layers';
