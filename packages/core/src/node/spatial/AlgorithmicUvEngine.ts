/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { MaxRectsAtlasPacker, TextureAtlasPacker, TextureItem, AtlasResult, AtlasPackerOptions } from './TextureAtlasPacker';
import { calculateNOAASolarPosition, calculateENUSunVector } from '../../browser/generative-canvas/services/atmosphere/solar-position';
import { SphericalHarmonics9 } from '../../browser/generative-canvas/services/atmosphere/volumetric-participating-media';
import { decodeImageToRgba, encodeRgbaToJpeg, readImageDimensions, sniffImageFormat, type RgbaImage } from '../image-codec-ffmpeg';
import { encodePng } from '../texture-processing';
import { readAccessor, nodeWorldMatrices, type Mat4 } from '../3d-engine/staged-location/glb-bytes';

// ============================================================================
// Public Interfaces & Options Contracts
// ============================================================================

export type UvEngineMode = 'preserve-100-lock' | 'conformal-reparameterize';

/**
 * Open profile identifier string supporting flexible prompts or lithology keywords.
 * Complies with Adaptive Domain Architecture: Zero closed enums or static material catalogs.
 */
export type LithologyProfile = string;

/**
 * Open schema contract for biophysical PBR materials.
 * Complies with Adaptive Domain Architecture: Zero closed enums or preset libraries.
 * Parameters are driven continuously by caller specifications, latent prompt reasoning,
 * or automatic mathematical signal induction.
 */
export interface BiophysicalMaterialContract {
  roughness?: number;             // [0..1] base microfacet roughness
  metalness?: number;             // [0..1] metallic reflectance
  normalStrength?: number;        // [0..10] multi-frequency relief depth
  cavitationDepthPower?: number;  // [0..100] micro-pore cavitation
  strataFrequency?: number;       // mineral striation density
  laplacianBurnishFactor?: number;// [0..1] edge polish weight on convex ridges (kappa > 0)
  laplacianCavityGritFactor?: number; // [0..1] soot/dirt accumulation in crevices (kappa < 0)
  toksvigVarianceScale?: number;  // [0..1] anti-aliasing grazing-angle compensation
  hbaoRadius?: number;            // [1..16] micro-cavity horizon search radius
  hbaoIntensity?: number;         // [0..2] micro-cavity shadow strength
  subsurfaceAlbedo?: [number, number, number]; // target linear RGB reflectance
  sharpVerticalMullions?: boolean;
  planarNormals?: boolean;
}

export interface LithologyConfig {
  cavitationDepthPower: number;
  strataFrequency: number;
  defaultStoneRoughness: number;
  metalness: number;
  poreScale: 'macropore' | 'micropore' | 'none';
  sharpVerticalMullions?: boolean;
  planarNormals?: boolean;
}

export interface TextureSpatialProfile {
  dominantPeriodPxX: number;
  dominantPeriodPxY: number;
  correlationLengthPxX: number;
  correlationLengthPxY: number;
  aspectRatio: number;
  isPeriodic: boolean;
  physicalModuleWidthMeters: number;
  physicalModuleHeightMeters: number;
  recommendedRepeatX: number;
  recommendedRepeatY: number;
}

export interface TexelDensityMetrics {
  meanTexelsPerMeter: number;
  minTexelsPerMeter: number;
  maxTexelsPerMeter: number;
  varianceRatio: number;
  totalWorldAreaSqMeters: number;
  normalizedChartsCount: number;
}

/**
 * processGlb reads only `lithologyProfile` and `biophysicalContract` from this object (per-part contracts
 * come from `submeshCategoryMap` / material `extras.category` with `enablePartAwarePbr`). No cavitation,
 * calcite-strata, road/marking/foliage protection or gutter-dilation pass is implemented, so the other
 * fields have no effect on the output.
 */
export interface DetailSynthesisOptions {
  lithologyProfile?: LithologyProfile;
  biophysicalContract?: BiophysicalMaterialContract;
  enableCavitation?: boolean;
  cavitationDepthPower?: number; // default 52.0 (travertine) or 42.0 (limestone)
  enableCalciteStrata?: boolean;
  strataFrequency?: number;      // default 85.0 (travertine) or 140.0 (limestone)
  protectRoads?: boolean;
  protectRoadMarkings?: boolean; // default true (edge exclusion mask on traffic stripes)
  protectFoliage?: boolean;
  gutterDilationPixels?: number; // default 4
  partCategory?: string;         // Part-aware category override (e.g. 'foliage', 'road', 'architecture')
}

export interface SolarDelightingConfig {
  latitude?: number;              // e.g. 40.74844 (ESB, NYC)
  longitude?: number;             // e.g. -73.98566
  timestampIso?: string;          // acquisition timestamp, e.g. '2024-06-21T14:30:00Z'
  sunVector?: [number, number, number]; // direct sun vector (+X East, +Y Up, -Z North)
  skyShCoeffs?: [number, number, number][]; // 9 RGB Ramamoorthi order-3 SH coefficients
  regularizationEpsilon?: number; // default 0.18 (prevents noise explosion in deep shadow)
  ambientWeight?: number;         // default 0.35
  directWeight?: number;          // default 0.65
}

export interface KhrMaterialsConfig {
  enableKhrMaterialsExtensions?: boolean;
  enableTransmission?: boolean;   // KHR_materials_transmission (glass curtain walls)
  enableAnisotropy?: boolean;     // KHR_materials_anisotropy (brushed metal spires)
  enableClearcoat?: boolean;      // KHR_materials_clearcoat (polished architectural surfaces)
  ior?: number;                   // default 1.52 (architectural soda-lime glass)
  transmissionFactor?: number;    // default 0.92
  anisotropyStrength?: number;    // default 0.85
  clearcoatFactor?: number;       // default 0.85
}

export interface ToksvigMipLevel {
  level: number;
  width: number;
  height: number;
  roughness: Uint8Array;
  normal: Uint8Array;
  meanNormalLength: number;
  addedRoughnessVariance: number;
}

export interface BoundarySeamWeldResult {
  weldedVertexCount: number;
  weldedBoundaryPairs: number;
  maxDisplacementMeters: number;
}

export interface PbrDecompositionOptions {
  enableAlbedoDeLighting?: boolean;
  enableHeightStratifiedDeLighting?: boolean; // elevation-aware urban canyon shadow lift
  enableSolarInverseDelighting?: boolean;    // NOAA ephemeris + Ramamoorthi SH9 inverse irradiance
  solarDelighting?: SolarDelightingConfig;
  canyonFloorY?: number;                     // bottom elevation of canyon
  canyonCeilingY?: number;                   // top elevation of canyon
  normalizedElevationY?: number;             // [0..1] when decomposing a single submesh chart
  bilateralSpatialRadius?: number;           // default 4
  bilateralRangeSigma?: number;              // default 0.15
  generateNormalMaps?: boolean;
  normalStrength?: number;                   // default 3.2
  generateRoughnessMaps?: boolean;
  defaultStoneRoughness?: number;            // default 0.85
  generateAoMaps?: boolean;
  skyDomeAoIntensity?: number;               // default 1.0
  packOrm?: boolean;                         // default true (glTF ORM: R=AO, G=Roughness, B=Metalness)
  biophysicalContract?: BiophysicalMaterialContract;
  enableMultiFrequencyNormals?: boolean;     // default true (Macro, Meso-Scharr, Micro-Grit with RNM)
  enableBiophysicalRoughness?: boolean;      // default true (Laplacian kappa curvature edge burnish & cavity dirt)
  enableHbaoMicroCavity?: boolean;           // default true (Image-space 8-dir horizon raymarching)
  enableToksvigFiltering?: boolean;          // default true (Toksvig specular anti-aliasing)
  enableToksvigMipPyramid?: boolean;         // custom Toksvig multi-scale variance-folded MIP pyramid
  toksvigMipLevels?: number;                 // default 4
  metricTexelDensityMap?: Float32Array;
  viewVarianceMap?: Float32Array;
  worldPositionsMap?: Float32Array;
  worldNormalsMap?: Float32Array;
}

export interface AlgorithmicUvOptions {
  inputGlbPath?: string;
  inputGlbBuffer?: Buffer;
  outputGlbPath?: string;
  mode?: UvEngineMode;
  lithologyProfile?: LithologyProfile;
  biophysicalContract?: BiophysicalMaterialContract;
  autoInducePeriodicity?: boolean;           // 1D spatial autocorrelation to auto-deduce texture repeat scale
  enableTexelDensityNormalization?: boolean;
  targetTexelsPerMeter?: number;             // default 100
  enableMicroDetailTiling?: boolean;         // KHR_texture_transform micro-normal tiling
  microDetailScale?: number;                 // default 32.0 (or auto from autocorrelation)
  detailSynthesis?: DetailSynthesisOptions;
  pbrDecomposition?: PbrDecompositionOptions;
  atlasPacking?: AtlasPackerOptions & { algorithm?: 'maxrects' | 'shelf' };
  preferNativeCpp?: boolean;
  khrMaterials?: KhrMaterialsConfig;
  enableBoundarySeamWelding?: boolean;       // multi-tile KD-tree seam welding
  boundaryToleranceMeters?: number;          // default 0.05
  submeshCategoryMap?: Record<number, string>;
  enablePartAwarePbr?: boolean;              // Dispatches biophysical material contracts per submesh part
}

export interface PbrDecompositionResult {
  albedo: Uint8Array;
  normal?: Uint8Array;
  roughness?: Uint8Array;
  ao?: Uint8Array;
  orm?: Uint8Array;
  width: number;
  height: number;
  toksvigMipPyramid?: ToksvigMipLevel[];
  /** Present when solar inverse de-lighting ran: texels divided by E(N) and painted texels left as they were (no geometry normal). */
  solarDelighting?: { sunVector: [number, number, number]; delitTexels: number; paintedTexelsWithoutNormal: number };
  /** Where each output map comes from. The normal, roughness and AO maps are estimated from the image itself, not measured. */
  mapProvenance: PbrMapProvenance;
}

/** Source of each map decomposePbr writes. */
export interface PbrMapProvenance {
  normal: string;
  roughness: string;
  ao: string;
  metalness: string;
}

/**
 * The normal, roughness and AO maps are image heuristics: they read luminance gradients, Laplacian curvature and colour
 * thresholds of the albedo, so they guess surface relief and gloss from brightness. None of them is a measurement.
 */
export const IMAGE_DERIVED_MAP_PROVENANCE: PbrMapProvenance = Object.freeze({
  normal: 'heuristic: luminance gradient of the albedo (image-derived, not geometry)',
  roughness: 'heuristic: base roughness from the contract, varied by albedo luminance curvature and colour thresholds (not measured)',
  ao: 'heuristic: horizon/cavity estimate from the image-derived normal or luminance (not ray-traced against geometry)',
  metalness: 'constant from the material contract (not measured)'
});

/** Thrown when solar inverse de-lighting is asked for without a geometry normal per texel. */
export class SolarDelightingNormalsError extends Error {
  readonly code = 'SOLAR_DELIGHT_NEEDS_GEOMETRY_NORMALS';
  constructor(message: string) {
    super(message);
    this.name = 'SolarDelightingNormalsError';
  }
}

/** One triangle primitive that samples a baseColor image, and which UV set it samples it with. */
export interface UvPrimitiveRef {
  meshIndex: number;
  primitive: any;
  texCoord: number;
  textureTransformed: boolean;
}

/** Texture periodicity measured by 1D autocorrelation of one decoded baseColor image (pixel units only). */
export interface MeasuredSpatialProfile {
  sourceImageIndex: number;
  isPeriodic: boolean;
  dominantPeriodPxX: number;  // 0 when no period was found
  dominantPeriodPxY: number;
}

/** What processGlb did with one baseColor image (or a baseColor texture with no usable source image). */
export interface TextureImageReport {
  textureIndex: number;
  imageIndex?: number;
  status: 'processed' | 'failed';
  sourceMimeType?: string;
  width?: number;              // decoded pixel size
  height?: number;
  texels?: number;
  albedoRewritten?: boolean;   // baseColor image bytes replaced with the de-lit albedo
  normalMapGenerated?: boolean;
  metallicRoughnessGenerated?: boolean;
  occlusionGenerated?: boolean;
  /** Solar de-lighting of this image: texels divided by E(N) from the mesh normals rasterized into its UV space. */
  solarDelighting?: {
    applied: boolean;
    /** Why it did not run (no rasterizable geometry normals for this image). */
    skippedReason?: string;
    normalSource?: 'vertex-normals' | 'face-normals-from-positions' | 'mixed';
    texelsWithGeometryNormal?: number;
    /** Texels that several triangles map to with disagreeing normals (tiled or shared UVs); left unlit-corrected. */
    texelsWithConflictingNormals?: number;
    delitTexels?: number;
    paintedTexelsWithoutNormal?: number;
  };
  /** Where the generated maps come from (the normal, roughness and AO maps are image heuristics). */
  mapProvenance?: PbrMapProvenance;
  error?: string;
}

/** Texture slots the rebuilt GLB filled on its materials. */
export interface MaterialMapAttachments {
  normalTextures: number;
  metallicRoughnessTextures: number;
  occlusionTextures: number;
  unlitRemoved: number;        // materials whose KHR_materials_unlit was dropped so the new maps are shaded
}

/** Maps derived from one source image, written into the rebuilt GLB. */
export interface GlbImageRewrite {
  /** Replaces the source image bytes (e.g. the de-lit baseColor). */
  replacement?: { data: Buffer; mimeType: string };
  /** Tangent-space normal map (PNG), attached as `normalTexture`. */
  normalPng?: Buffer;
  /** PNG read as glTF metallicRoughness (G = roughness, B = metalness). */
  metallicRoughnessPng?: Buffer;
  /** PNG read as glTF occlusion (R channel). With ORM packing this is the same Buffer as metallicRoughnessPng. */
  occlusionPng?: Buffer;
}

export interface AlgorithmicUvResult {
  /** False when any baseColor image could not be decoded or processed (see `images`). */
  success: boolean;
  mode: UvEngineMode;
  lithologyProfile: LithologyProfile;
  biophysicalContract?: BiophysicalMaterialContract;
  inducedSpatialProfile?: MeasuredSpatialProfile;
  submeshesProcessed: number;
  trianglesProcessed: number;
  verticesProcessed: number;
  /** Sum of decoded width * height over the images that were processed. */
  texelsProcessed: number;
  imagesProcessed: number;
  imagesFailed: number;
  images: TextureImageReport[];
  attachments: MaterialMapAttachments;
  texelDensityMetrics?: TexelDensityMetrics;
  outputGlbPath?: string;
  outputGlbBuffer?: Buffer;
  executionTimeMs: number;
  /** True when at least one normal, metallicRoughness or occlusion texture was attached. */
  pbrSuiteGenerated: boolean;
  microDetailTilingInjected?: boolean;
  backend: 'native-cpp' | 'node-pure';
  /** True when at least one baseColor image was rewritten by solar inverse de-lighting. */
  solarDelightingApplied?: boolean;
  /** Sun vector (+X East, +Y Up, -Z North) the solar de-lighting divided by. */
  solarSunVector?: [number, number, number];
  khrExtensionsInjected?: string[];
  boundaryWeldingResult?: BoundarySeamWeldResult;
}

/**
 * Resolves a biophysical material contract dynamically from an object or open prompt string.
 * Adheres strictly to Adaptive Domain Architecture: Zero closed enums or static preset libraries.
 */
export function resolveBiophysicalContract(
  input?: BiophysicalMaterialContract | string
): Required<BiophysicalMaterialContract> {
  const defaults: Required<BiophysicalMaterialContract> = {
    roughness: 0.82,
    metalness: 0.0,
    normalStrength: 3.2,
    cavitationDepthPower: 45.0,
    strataFrequency: 95.0,
    laplacianBurnishFactor: 0.35,
    laplacianCavityGritFactor: 0.40,
    toksvigVarianceScale: 0.5,
    hbaoRadius: 10,
    hbaoIntensity: 1.2,
    subsurfaceAlbedo: [0.82, 0.78, 0.72],
    sharpVerticalMullions: false,
    planarNormals: false
  };

  if (!input) return defaults;

  if (typeof input === 'object') {
    return {
      roughness: input.roughness ?? defaults.roughness,
      metalness: input.metalness ?? defaults.metalness,
      normalStrength: input.normalStrength ?? defaults.normalStrength,
      cavitationDepthPower: input.cavitationDepthPower ?? defaults.cavitationDepthPower,
      strataFrequency: input.strataFrequency ?? defaults.strataFrequency,
      laplacianBurnishFactor: input.laplacianBurnishFactor ?? defaults.laplacianBurnishFactor,
      laplacianCavityGritFactor: input.laplacianCavityGritFactor ?? defaults.laplacianCavityGritFactor,
      toksvigVarianceScale: input.toksvigVarianceScale ?? defaults.toksvigVarianceScale,
      hbaoRadius: input.hbaoRadius ?? defaults.hbaoRadius,
      hbaoIntensity: input.hbaoIntensity ?? defaults.hbaoIntensity,
      subsurfaceAlbedo: input.subsurfaceAlbedo ?? defaults.subsurfaceAlbedo,
      sharpVerticalMullions: input.sharpVerticalMullions ?? defaults.sharpVerticalMullions,
      planarNormals: input.planarNormals ?? defaults.planarNormals
    };
  }

  // Open entity-driven latent inference from prompt/identifier (Adaptive Domain Architecture)
  const query = input.toLowerCase();
  const res = { ...defaults };

  if (query.includes('glass') || query.includes('curtain') || query.includes('window') || query.includes('glaz')) {
    res.roughness = 0.18;
    res.metalness = 0.65;
    res.cavitationDepthPower = 0.0;
    res.strataFrequency = 0.0;
    res.sharpVerticalMullions = true;
    res.planarNormals = true;
    res.subsurfaceAlbedo = [0.12, 0.16, 0.20];
  } else if (query.includes('metal') || query.includes('steel') || query.includes('bronze') || query.includes('titanium') || query.includes('copper')) {
    res.roughness = 0.32;
    res.metalness = 0.88;
    res.cavitationDepthPower = 0.0;
    res.planarNormals = true;
  } else if (query.includes('limestone') || query.includes('ashlar') || query.includes('bedford')) {
    res.roughness = 0.82;
    res.metalness = 0.0;
    res.cavitationDepthPower = 42.0;
    res.strataFrequency = 140.0;
    res.sharpVerticalMullions = true;
    res.planarNormals = false;
  } else if (query.includes('travertine')) {
    res.roughness = 0.85;
    res.metalness = 0.0;
    res.cavitationDepthPower = 52.0;
    res.strataFrequency = 85.0;
    res.sharpVerticalMullions = false;
    res.planarNormals = false;
  } else if (query.includes('asphalt') || query.includes('road') || query.includes('pavement')) {
    res.roughness = 0.55;
    res.metalness = 0.0;
    res.cavitationDepthPower = 15.0;
    res.strataFrequency = 0.0;
  } else if (query.includes('foliage') || query.includes('leaf') || query.includes('tree') || query.includes('canopy') || query.includes('ivy') || query.includes('vegetation')) {
    res.roughness = 0.48;
    res.metalness = 0.0;
    res.cavitationDepthPower = 8.0;
    res.subsurfaceAlbedo = [0.25, 0.48, 0.18];
  }

  return res;
}

// ============================================================================
// Algorithmic UV Unwrap & Rewrap Engine
// ============================================================================

export class AlgorithmicUvEngine {
  /**
   * Resolves an open biophysical material contract.
   */
  public static resolveBiophysicalContract = resolveBiophysicalContract;

  /**
   * Returns physical parameters for a specific profile or contract.
   * Adheres to Adaptive Domain Architecture with dynamic schema resolution.
   */
  public static getLithologyPreset(profile: LithologyProfile | BiophysicalMaterialContract = 'classical-travertine'): Required<LithologyConfig> {
    const contract = resolveBiophysicalContract(profile);
    return {
      cavitationDepthPower: contract.cavitationDepthPower,
      strataFrequency: contract.strataFrequency,
      defaultStoneRoughness: contract.roughness,
      metalness: contract.metalness,
      poreScale: contract.cavitationDepthPower > 45 ? 'macropore' : (contract.cavitationDepthPower > 0 ? 'micropore' : 'none'),
      sharpVerticalMullions: contract.sharpVerticalMullions,
      planarNormals: contract.planarNormals
    };
  }

  /**
   * Pixel size of the embedded baseColor image a primitive samples, read from the image header
   * (no decode). Null when the material has no baseColor texture or the image is not embedded / readable.
   */
  private static baseColorImageSize(json: any, bin: Buffer, materialIndex: number | undefined): { width: number; height: number } | null {
    if (materialIndex === undefined) return null;
    const texIndex = json.materials?.[materialIndex]?.pbrMetallicRoughness?.baseColorTexture?.index;
    const imgIndex = texIndex !== undefined ? json.textures?.[texIndex]?.source : undefined;
    const bvIndex = imgIndex !== undefined ? json.images?.[imgIndex]?.bufferView : undefined;
    const bv = bvIndex !== undefined ? json.bufferViews?.[bvIndex] : undefined;
    if (!bv) return null;
    const start = bv.byteOffset || 0;
    return readImageDimensions(bin.subarray(start, start + bv.byteLength));
  }

  /**
   * Computes real-world metric texel density statistics across all submeshes:
   * 3D world-space triangle area vs UV area, as texels per linear meter. Each primitive uses the pixel size
   * of the baseColor image it samples; `defaultTexSize` applies only to primitives without a readable
   * embedded image. All fields are 0 when no triangle has measurable UV area.
   */
  public static computeTexelDensity(
    glbInput: { json: any; bin: Buffer } | Buffer,
    defaultTexSize: number = 512
  ): TexelDensityMetrics {
    const glb = Buffer.isBuffer(glbInput) ? this.parseGlb(glbInput) : glbInput;
    const json = glb.json;
    const bin = glb.bin;

    let minDensity = Infinity;
    let maxDensity = 0.0;
    let totalDensitySum = 0.0;
    let measuredTriangles = 0;
    let totalWorldArea = 0.0;
    let chartsCount = 0;

    const meshes = json.meshes || [];
    for (const mesh of meshes) {
      for (const prim of mesh.primitives || []) {
        if (!prim.attributes || prim.attributes.POSITION === undefined) continue;

        // Position accessor
        const posAcc = json.accessors[prim.attributes.POSITION];
        const posBv = json.bufferViews[posAcc.bufferView];
        const posOffset = (posBv.byteOffset || 0) + (posAcc.byteOffset || 0);
        const posStride = posBv.byteStride ? posBv.byteStride / 4 : 3;
        const posFloats = new Float32Array(bin.buffer, bin.byteOffset + posOffset, posAcc.count * posStride);

        // UV accessor
        let uvFloats: Float32Array | null = null;
        let uvStride = 2;
        if (prim.attributes.TEXCOORD_0 !== undefined) {
          const uvAcc = json.accessors[prim.attributes.TEXCOORD_0];
          const uvBv = json.bufferViews[uvAcc.bufferView];
          const uvOffset = (uvBv.byteOffset || 0) + (uvAcc.byteOffset || 0);
          uvStride = uvBv.byteStride ? uvBv.byteStride / 4 : 2;
          uvFloats = new Float32Array(bin.buffer, bin.byteOffset + uvOffset, uvAcc.count * uvStride);
          chartsCount++;
        }

        // Indices accessor
        let indices: number[] | null = null;
        if (prim.indices !== undefined) {
          const idxAcc = json.accessors[prim.indices];
          const idxBv = json.bufferViews[idxAcc.bufferView];
          const idxOffset = (idxBv.byteOffset || 0) + (idxAcc.byteOffset || 0);
          if (idxAcc.componentType === 5123) { // UNSIGNED_SHORT
            const uint16 = new Uint16Array(bin.buffer, bin.byteOffset + idxOffset, idxAcc.count);
            indices = Array.from(uint16);
          } else if (idxAcc.componentType === 5125) { // UNSIGNED_INT
            const uint32 = new Uint32Array(bin.buffer, bin.byteOffset + idxOffset, idxAcc.count);
            indices = Array.from(uint32);
          }
        }

        const triCount = indices ? Math.floor(indices.length / 3) : Math.floor(posAcc.count / 3);
        const imageSize = this.baseColorImageSize(json, bin, prim.material);
        const texW = imageSize?.width ?? defaultTexSize;
        const texH = imageSize?.height ?? defaultTexSize;

        for (let t = 0; t < triCount; t++) {
          const i0 = indices ? indices[t * 3] : t * 3;
          const i1 = indices ? indices[t * 3 + 1] : t * 3 + 1;
          const i2 = indices ? indices[t * 3 + 2] : t * 3 + 2;

          const p0x = posFloats[i0 * posStride];
          const p0y = posFloats[i0 * posStride + 1];
          const p0z = posFloats[i0 * posStride + 2];

          const p1x = posFloats[i1 * posStride];
          const p1y = posFloats[i1 * posStride + 1];
          const p1z = posFloats[i1 * posStride + 2];

          const p2x = posFloats[i2 * posStride];
          const p2y = posFloats[i2 * posStride + 1];
          const p2z = posFloats[i2 * posStride + 2];

          // 3D edge vectors
          const e1x = p1x - p0x;
          const e1y = p1y - p0y;
          const e1z = p1z - p0z;

          const e2x = p2x - p0x;
          const e2y = p2y - p0y;
          const e2z = p2z - p0z;

          // Cross product
          const cx = e1y * e2z - e1z * e2y;
          const cy = e1z * e2x - e1x * e2z;
          const cz = e1x * e2y - e1y * e2x;
          const worldArea = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
          totalWorldArea += worldArea;

          if (uvFloats && worldArea > 1e-6) {
            const u0 = uvFloats[i0 * uvStride];
            const v0 = uvFloats[i0 * uvStride + 1];
            const u1 = uvFloats[i1 * uvStride];
            const v1 = uvFloats[i1 * uvStride + 1];
            const u2 = uvFloats[i2 * uvStride];
            const v2 = uvFloats[i2 * uvStride + 1];

            const uvArea = 0.5 * Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0));
            if (uvArea > 1e-8) {
              const texelCount = uvArea * texW * texH;
              const texelsPerMeter = Math.sqrt(texelCount / worldArea);

              if (isFinite(texelsPerMeter) && texelsPerMeter > 0) {
                if (texelsPerMeter < minDensity) minDensity = texelsPerMeter;
                if (texelsPerMeter > maxDensity) maxDensity = texelsPerMeter;
                totalDensitySum += texelsPerMeter;
                measuredTriangles++;
              }
            }
          }
        }
      }
    }

    const measured = measuredTriangles > 0;
    const meanDensity = measured ? totalDensitySum / measuredTriangles : 0;
    const minMeasured = measured ? minDensity : 0;
    const maxMeasured = measured ? maxDensity : 0;
    const varianceRatio = minMeasured > 0 ? maxMeasured / minMeasured : 0;

    return {
      meanTexelsPerMeter: Math.round(meanDensity * 10) / 10,
      minTexelsPerMeter: Math.round(minMeasured * 10) / 10,
      maxTexelsPerMeter: Math.round(maxMeasured * 10) / 10,
      varianceRatio: Math.round(varianceRatio * 10) / 10,
      totalWorldAreaSqMeters: Math.round(totalWorldArea * 100) / 100,
      normalizedChartsCount: chartsCount
    };
  }

  /**
   * High-level entry point to process any 3D model / scene (.glb) with the
   * Algorithmic UV Unwrap & Rewrap Engine.
   *
   * Geometry and UVs are never modified ('preserve-100-lock' is the only implemented mode). Every embedded
   * baseColor image the materials sample is decoded (image-codec-ffmpeg) and the requested passes run on its
   * pixels: albedo de-lighting rewrites the baseColor image, and normal / roughness / occlusion maps are
   * encoded as PNG and attached to the materials' empty normalTexture, metallicRoughnessTexture and
   * occlusionTexture slots. An image that cannot be decoded is reported in `images` and makes `success` false.
   */
  public static async processGlb(options: AlgorithmicUvOptions): Promise<AlgorithmicUvResult> {
    const startTime = performance.now();
    const mode: UvEngineMode = options.mode ?? 'preserve-100-lock';
    if (mode !== 'preserve-100-lock') {
      throw new Error(`AlgorithmicUvEngine: mode '${mode}' is not implemented (no UV reparameterization or atlas rebake exists); use 'preserve-100-lock'.`);
    }
    const lithologyProfile: LithologyProfile = options.lithologyProfile ?? options.detailSynthesis?.lithologyProfile ?? 'classical-travertine';
    const biophysicalContract = options.biophysicalContract ?? options.pbrDecomposition?.biophysicalContract ?? options.detailSynthesis?.biophysicalContract;
    const resolvedContract = resolveBiophysicalContract(biophysicalContract ?? lithologyProfile);

    let glbBuffer: Buffer;
    if (options.inputGlbBuffer) {
      glbBuffer = options.inputGlbBuffer;
    } else if (options.inputGlbPath && fs.existsSync(options.inputGlbPath)) {
      glbBuffer = fs.readFileSync(options.inputGlbPath);
    } else {
      throw new Error(`AlgorithmicUvEngine: No input GLB provided at '${options.inputGlbPath}'`);
    }

    // Parse binary GLB (Chunk 0 JSON, Chunk 1 BIN)
    const glb = this.parseGlb(glbBuffer);
    const json = glb.json;

    // Compute metric texel density across all submeshes
    const texelDensityMetrics = this.computeTexelDensity(glb);

    const pbr = options.pbrDecomposition ?? {};
    // decomposePbr reads strength / roughness / AO intensity from the contract, so explicit pass options are folded into it.
    const imageContract: Required<BiophysicalMaterialContract> = {
      ...resolvedContract,
      normalStrength: pbr.normalStrength ?? resolvedContract.normalStrength,
      roughness: pbr.defaultStoneRoughness ?? resolvedContract.roughness,
      hbaoIntensity: pbr.skyDomeAoIntensity ?? resolvedContract.hbaoIntensity
    };
    const pbrOpts: PbrDecompositionOptions = {
      ...pbr,
      biophysicalContract: imageContract,
      enableToksvigMipPyramid: false // glTF cannot carry a custom MIP chain, so it is not computed
    };
    const passes = {
      delight: !!(pbr.enableAlbedoDeLighting || pbr.enableSolarInverseDelighting),
      normal: pbr.generateNormalMaps !== false,
      roughness: pbr.generateRoughnessMaps !== false,
      ao: pbr.generateAoMaps !== false,
      packOrm: pbr.packOrm !== false
    };

    const materials: any[] = json.materials || [];
    const textures: any[] = json.textures || [];
    const meshes: any[] = json.meshes || [];

    let submeshesProcessed = 0;
    let trianglesProcessed = 0;
    let verticesProcessed = 0;

    // Each baseColor image, the materials that sample it, and the contract of the first primitive that uses it.
    const imageJobs = new Map<number, { textureIndex: number; materials: Set<number>; contract: Required<BiophysicalMaterialContract>; prims: UvPrimitiveRef[] }>();
    const images: TextureImageReport[] = [];
    const sourcelessTextures = new Set<number>();

    for (let meshIdx = 0; meshIdx < meshes.length; meshIdx++) {
      submeshesProcessed++;

      for (const prim of meshes[meshIdx].primitives || []) {
        if (prim.indices !== undefined) {
          trianglesProcessed += Math.floor(json.accessors[prim.indices].count / 3);
        }
        if (prim.attributes && prim.attributes.POSITION !== undefined) {
          verticesProcessed += json.accessors[prim.attributes.POSITION].count;
        }
        if (prim.material === undefined) continue;

        const mat = materials[prim.material];
        const textureIndex = mat?.pbrMetallicRoughness?.baseColorTexture?.index;
        if (textureIndex === undefined) continue;
        const imageIndex = textures[textureIndex]?.source;
        if (imageIndex === undefined) {
          if (!sourcelessTextures.has(textureIndex)) {
            sourcelessTextures.add(textureIndex);
            images.push({ textureIndex, status: 'failed', error: 'texture has no core `source` image (extension-only image sources are not supported)' });
          }
          continue;
        }

        let job = imageJobs.get(imageIndex);
        if (!job) {
          // Only explicit part categories select a per-part contract; arbitrary material names
          // (e.g. Google tiles 'Material_0') must not override the lithology contract.
          const partCat = options.submeshCategoryMap?.[meshIdx] || mat?.extras?.category;
          const contract = options.enablePartAwarePbr && partCat ? resolveBiophysicalContract(String(partCat)) : imageContract;
          job = { textureIndex, materials: new Set<number>(), contract, prims: [] };
          imageJobs.set(imageIndex, job);
        }
        job.materials.add(prim.material);
        const btex = mat.pbrMetallicRoughness.baseColorTexture;
        job.prims.push({ meshIndex: meshIdx, primitive: prim, texCoord: btex.texCoord ?? 0, textureTransformed: !!btex.extensions?.KHR_texture_transform });
      }
    }

    const imageBytes = (imageIndex: number): Buffer => {
      const imgDef = json.images?.[imageIndex];
      if (!imgDef) throw new Error(`image ${imageIndex} does not exist`);
      if (imgDef.bufferView === undefined) throw new Error('image is not embedded in the GLB binary chunk (uri images are not supported)');
      const bv = json.bufferViews[imgDef.bufferView];
      const start = bv.byteOffset || 0;
      return glb.bin.subarray(start, start + bv.byteLength);
    };

    // Periodicity is measured on the largest baseColor image (by header size).
    let profileImageIndex = -1;
    if (options.autoInducePeriodicity) {
      let largestArea = 0;
      for (const imageIndex of imageJobs.keys()) {
        let dims: { width: number; height: number } | null = null;
        try { dims = readImageDimensions(imageBytes(imageIndex)); } catch { dims = null; }
        const area = dims ? dims.width * dims.height : 0;
        if (area > largestArea) {
          largestArea = area;
          profileImageIndex = imageIndex;
        }
      }
    }

    const rewrites = new Map<number, GlbImageRewrite>();
    let texelsProcessed = 0;
    let inducedSpatialProfile: MeasuredSpatialProfile | undefined;
    let solarDelightingApplied = false;

    const meshNodes = new Map<number, Mat4[]>();
    if (pbr.enableSolarInverseDelighting) {
      // Throws before any image work when no sun vector or place and time was given.
      this.resolveSolarSunVector(pbr.solarDelighting);
      const worlds = nodeWorldMatrices(json);
      (json.nodes ?? []).forEach((n: any, i: number) => {
        if (n.mesh === undefined) return;
        if (!meshNodes.has(n.mesh)) meshNodes.set(n.mesh, []);
        meshNodes.get(n.mesh)!.push(worlds[i]);
      });
    }

    for (const [imageIndex, job] of imageJobs) {
      const users = [...job.materials].map(m => materials[m]);
      // Solar de-lighting divides by E(N) with N from the mesh: the primitives that sample this image are
      // rasterized into its UV space. Without geometry normals for the image it does not run, and the report says why.
      let imageOpts: PbrDecompositionOptions = { ...pbrOpts, biophysicalContract: job.contract };
      let solarReport: TextureImageReport['solarDelighting'];
      if (pbr.enableSolarInverseDelighting) {
        try {
          const dims = readImageDimensions(imageBytes(imageIndex));
          if (!dims) throw new Error('image dimensions could not be read');
          const raster = this.rasterizeGeometryNormalsToUv(glb, job.prims, meshNodes, dims.width, dims.height);
          if (raster.texelsWithNormal === 0) {
            solarReport = { applied: false, skippedReason: raster.reason ?? 'no triangle of the primitives using this image covers a texel' };
            imageOpts = { ...imageOpts, enableSolarInverseDelighting: false };
          } else {
            solarReport = {
              applied: true,
              normalSource: raster.normalSource,
              texelsWithGeometryNormal: raster.texelsWithNormal,
              texelsWithConflictingNormals: raster.texelsConflicting
            };
            imageOpts = { ...imageOpts, worldNormalsMap: raster.normals };
          }
        } catch (err) {
          solarReport = { applied: false, skippedReason: `geometry normals could not be rasterized: ${err instanceof Error ? err.message : String(err)}` };
          imageOpts = { ...imageOpts, enableSolarInverseDelighting: false };
        }
      }
      const want = {
        delight: !!(pbr.enableAlbedoDeLighting || imageOpts.enableSolarInverseDelighting),
        normal: passes.normal && users.some(m => !m.normalTexture),
        roughness: passes.roughness && users.some(m => !m.pbrMetallicRoughness?.metallicRoughnessTexture),
        ao: passes.ao && users.some(m => !m.occlusionTexture),
        profile: imageIndex === profileImageIndex
      };
      if (!want.delight && !want.normal && !want.roughness && !want.ao && !want.profile) {
        if (solarReport) images.push({ textureIndex: job.textureIndex, imageIndex, status: 'processed', albedoRewritten: false, solarDelighting: solarReport });
        continue;
      }

      const report: TextureImageReport = { textureIndex: job.textureIndex, imageIndex, status: 'processed', solarDelighting: solarReport };
      images.push(report);
      try {
        const bytes = imageBytes(imageIndex);
        report.sourceMimeType = json.images[imageIndex].mimeType;
        const out = await this.processTextureBuffer(bytes, imageOpts, want, passes.packOrm);
        if (out.solarDelighting && report.solarDelighting) {
          report.solarDelighting.delitTexels = out.solarDelighting.delitTexels;
          report.solarDelighting.paintedTexelsWithoutNormal = out.solarDelighting.paintedTexelsWithoutNormal;
        }
        if (out.mapProvenance && (out.normalPng || out.metallicRoughnessPng || out.occlusionPng)) report.mapProvenance = out.mapProvenance;

        report.width = out.width;
        report.height = out.height;
        report.texels = out.width * out.height;
        report.albedoRewritten = !!out.albedo;
        report.normalMapGenerated = !!out.normalPng;
        report.metallicRoughnessGenerated = !!out.metallicRoughnessPng;
        report.occlusionGenerated = !!out.occlusionPng;
        texelsProcessed += report.texels;

        if (out.profile) inducedSpatialProfile = { sourceImageIndex: imageIndex, ...out.profile };
        if (out.albedo && out.solarDelighting && out.solarDelighting.delitTexels > 0) solarDelightingApplied = true;
        if (out.albedo || out.normalPng || out.metallicRoughnessPng || out.occlusionPng) {
          rewrites.set(imageIndex, {
            replacement: out.albedo,
            normalPng: out.normalPng,
            metallicRoughnessPng: out.metallicRoughnessPng,
            occlusionPng: out.occlusionPng
          });
        }
      } catch (err) {
        report.status = 'failed';
        report.error = err instanceof Error ? err.message : String(err);
      }
    }
    images.sort((a, b) => (a.imageIndex ?? -1) - (b.imageIndex ?? -1) || a.textureIndex - b.textureIndex);

    const microDetailTilingInjected = !!(options.enableMicroDetailTiling || (options.autoInducePeriodicity && inducedSpatialProfile?.isPeriodic));

    let boundaryResult: BoundarySeamWeldResult | undefined;
    if (options.enableBoundarySeamWelding) {
      const posBuffers: Float32Array[] = [];
      const normBuffers: Float32Array[] = [];

      for (const mesh of meshes) {
        for (const prim of mesh.primitives || []) {
          if (prim.attributes && prim.attributes.POSITION !== undefined) {
            const posAcc = json.accessors[prim.attributes.POSITION];
            const posBv = json.bufferViews[posAcc.bufferView];
            const posOffset = (posBv.byteOffset || 0) + (posAcc.byteOffset || 0);
            const posArray = new Float32Array(glb.bin.buffer, glb.bin.byteOffset + posOffset, posAcc.count * 3);
            posBuffers.push(posArray);

            if (prim.attributes.NORMAL !== undefined) {
              const normAcc = json.accessors[prim.attributes.NORMAL];
              const normBv = json.bufferViews[normAcc.bufferView];
              const normOffset = (normBv.byteOffset || 0) + (normAcc.byteOffset || 0);
              const normArray = new Float32Array(glb.bin.buffer, glb.bin.byteOffset + normOffset, normAcc.count * 3);
              normBuffers.push(normArray);
            }
          }
        }
      }

      if (posBuffers.length > 0) {
        boundaryResult = this.weldTileBoundarySeams(posBuffers, normBuffers, options.boundaryToleranceMeters ?? 0.05);
      }
    }

    // Rebuild binary GLB with the rewritten / added textures, optional micro-detail tiling, and KHR materials
    const rebuildResult = this.rebuildGlbWithTextures(
      glb,
      rewrites,
      {
        enableMicroDetailTiling: microDetailTilingInjected,
        microDetailScale: options.microDetailScale ?? 32.0
      },
      options.khrMaterials
    );
    const outputGlbBuffer = rebuildResult.buffer;

    if (options.outputGlbPath) {
      const dir = path.dirname(options.outputGlbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(options.outputGlbPath, outputGlbBuffer);
    }

    const executionTimeMs = performance.now() - startTime;
    const imagesFailed = images.filter(r => r.status === 'failed').length;
    const attachments = rebuildResult.attachments;

    return {
      success: imagesFailed === 0,
      mode,
      lithologyProfile,
      biophysicalContract: imageContract,
      inducedSpatialProfile,
      submeshesProcessed,
      trianglesProcessed,
      verticesProcessed,
      texelsProcessed,
      imagesProcessed: images.length - imagesFailed,
      imagesFailed,
      images,
      attachments,
      texelDensityMetrics,
      outputGlbPath: options.outputGlbPath,
      outputGlbBuffer,
      executionTimeMs,
      pbrSuiteGenerated: attachments.normalTextures + attachments.metallicRoughnessTextures + attachments.occlusionTextures > 0,
      microDetailTilingInjected,
      khrExtensionsInjected: rebuildResult.injectedExtensions,
      solarDelightingApplied,
      solarSunVector: solarDelightingApplied ? this.resolveSolarSunVector(pbr.solarDelighting) : undefined,
      boundaryWeldingResult: boundaryResult,
      backend: 'node-pure'
    };
  }

  /**
   * Reoriented Normal Mapping (RNM) blending.
   * Blends base and detail normal vectors without flattening or loss of unit length.
   */
  public static blendNormalsRNM(
    n1: [number, number, number],
    n2: [number, number, number]
  ): [number, number, number] {
    const u: [number, number, number] = [n1[0], n1[1], n1[2] + 1.0];
    const t: [number, number, number] = [-n2[0], -n2[1], n2[2]];

    const uDotT = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
    const uz = Math.max(0.0001, u[2]);
    const factor = uDotT / uz;

    const rx = u[0] * factor - t[0];
    const ry = u[1] * factor - t[1];
    const rz = u[2] * factor - t[2];

    const len = Math.sqrt(rx * rx + ry * ry + rz * rz) || 1.0;
    return [rx / len, ry / len, rz / len];
  }

  /**
   * High-accuracy 3x3 Scharr differential normal vector operator.
   */
  public static computeScharrNormal(
    lum: Float32Array,
    w: number,
    h: number,
    x: number,
    y: number,
    bumpStrength: number = 3.5
  ): [number, number, number] {
    const getL = (px: number, py: number) => {
      const cx = Math.max(0, Math.min(w - 1, px));
      const cy = Math.max(0, Math.min(h - 1, py));
      return lum[cy * w + cx];
    };

    const tl = getL(x - 1, y - 1);
    const tc = getL(x,     y - 1);
    const tr = getL(x + 1, y - 1);
    const ml = getL(x - 1, y);
    const mr = getL(x + 1, y);
    const bl = getL(x - 1, y + 1);
    const bc = getL(x,     y + 1);
    const br = getL(x + 1, y + 1);

    const dx = (tr + (10.0 / 3.0) * mr + br - (tl + (10.0 / 3.0) * ml + bl)) / 5.333;
    const dy = (bl + (10.0 / 3.0) * bc + br - (tl + (10.0 / 3.0) * tc + tr)) / 5.333;

    const nx = -dx * bumpStrength;
    const ny = -dy * bumpStrength;
    const nz = 1.0;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
    return [nx / len, ny / len, nz / len];
  }

  /**
   * Multi-frequency normal map synthesis:
   * Decomposes height into Macro (3px structural), Meso (1px Scharr), and Micro (high-pass difference),
   * combined using Reoriented Normal Mapping (RNM) to preserve specular highlights.
   */
  public static computeMultiFrequencyNormalMap(
    lum: Float32Array,
    w: number,
    h: number,
    bumpStrength: number = 3.2,
    macroWeight: number = 0.5,
    mesoWeight: number = 0.35,
    microWeight: number = 0.15
  ): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    const getL = (px: number, py: number) => {
      const cx = Math.max(0, Math.min(w - 1, px));
      const cy = Math.max(0, Math.min(h - 1, py));
      return lum[cy * w + cx];
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // Macro: 3x3 kernel spaced by 3 pixels
        const tl_m = getL(x - 3, y - 3);
        const tr_m = getL(x + 3, y - 3);
        const bl_m = getL(x - 3, y + 3);
        const br_m = getL(x + 3, y + 3);
        const dx_macro = (tr_m + br_m - (tl_m + bl_m)) * 0.5;
        const dy_macro = (bl_m + br_m - (tl_m + tr_m)) * 0.5;
        const mx = -dx_macro * bumpStrength * macroWeight;
        const my = -dy_macro * bumpStrength * macroWeight;
        const mz = 1.0;
        const mLen = Math.sqrt(mx * mx + my * my + mz * mz) || 1.0;
        const n_macro: [number, number, number] = [mx / mLen, my / mLen, mz / mLen];

        // Meso: Standard 1-pixel Scharr kernel
        const n_meso = this.computeScharrNormal(lum, w, h, x, y, bumpStrength * mesoWeight);

        // Micro: High-pass difference
        const center = getL(x, y);
        const avg4 = (getL(x - 1, y) + getL(x + 1, y) + getL(x, y - 1) + getL(x, y + 1)) * 0.25;
        const microDelta = center - avg4;
        const ux = -microDelta * bumpStrength * microWeight * 8.0;
        const uy = -microDelta * bumpStrength * microWeight * 8.0;
        const uz = 1.0;
        const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1.0;
        const n_micro: [number, number, number] = [ux / uLen, uy / uLen, uz / uLen];

        // Blend via RNM
        const n_blend = this.blendNormalsRNM(n_macro, n_meso);
        const n_final = this.blendNormalsRNM(n_blend, n_micro);

        // RNM of strongly tilted layers can rotate past the horizon (z < 0) at hard luminance edges; a
        // tangent-space normal must face out of the surface, so clamp z and keep the xy direction.
        const minZ = 0.1;
        if (n_final[2] < minZ) {
          const xyLen = Math.hypot(n_final[0], n_final[1]) || 1.0;
          const xyScale = Math.sqrt(1.0 - minZ * minZ) / xyLen;
          n_final[0] *= xyScale;
          n_final[1] *= xyScale;
          n_final[2] = minZ;
        }

        const idx = (y * w + x) * 4;
        out[idx]     = Math.round((n_final[0] * 0.5 + 0.5) * 255);
        out[idx + 1] = Math.round((n_final[1] * 0.5 + 0.5) * 255);
        out[idx + 2] = Math.round((n_final[2] * 0.5 + 0.5) * 255);
        out[idx + 3] = 255;
      }
    }
    return out;
  }

  /**
   * Biophysical Laplacian Curvature Roughness:
   * Evaluates discrete surface Laplacian kappa = 4*center - sum(neighbors).
   * - Convex edges (kappa > 0) experience friction & polish (burnishing, lower roughness).
   * - Concave crevices (kappa < 0) collect dust, soot & micro-grit (higher roughness).
   */
  public static computeBiophysicalRoughness(
    lum: Float32Array,
    w: number,
    h: number,
    baseRoughness: number = 0.82,
    varianceScale: number = 1.8,
    edgeWearGain: number = 0.35,
    cavityDirtGain: number = 0.40
  ): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    const getL = (px: number, py: number) => {
      const cx = Math.max(0, Math.min(w - 1, px));
      const cy = Math.max(0, Math.min(h - 1, py));
      return lum[cy * w + cx];
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const center = getL(x, y);
        const nl = getL(x - 1, y);
        const nr = getL(x + 1, y);
        const nt = getL(x, y - 1);
        const nb = getL(x, y + 1);

        const avgNeighbors = (nl + nr + nt + nb) * 0.25;
        const variance = Math.abs(center - avgNeighbors);

        // Discrete Laplacian: kappa = 4*center - sum(neighbors)
        const laplacian = 4.0 * center - (nl + nr + nt + nb);
        const burnish = Math.max(0.0, laplacian) * edgeWearGain;
        const dirt = Math.max(0.0, -laplacian) * cavityDirtGain;

        let r = baseRoughness + variance * varianceScale - burnish + dirt;
        r = Math.max(0.04, Math.min(0.98, r));

        const byteVal = Math.round(r * 255);
        const idx = (y * w + x) * 4;
        out[idx]     = byteVal;
        out[idx + 1] = byteVal;
        out[idx + 2] = byteVal;
        out[idx + 3] = 255;
      }
    }
    return out;
  }

  /**
   * Toksvig Specular Anti-Aliasing:
   * Folds normal variance over local pixel footprint into roughness to eliminate specular shimmering.
   */
  public static applyToksvigAntiAliasing(
    roughnessRgba: Uint8Array,
    normalRgba: Uint8Array,
    w: number,
    h: number,
    varianceScale: number = 0.5
  ): Uint8Array {
    const out = new Uint8Array(roughnessRgba.length);
    out.set(roughnessRgba);

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        let sumNx = 0, sumNy = 0, sumNz = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nidx = ((y + dy) * w + (x + dx)) * 4;
            sumNx += (normalRgba[nidx] / 255.0) * 2.0 - 1.0;
            sumNy += (normalRgba[nidx + 1] / 255.0) * 2.0 - 1.0;
            sumNz += (normalRgba[nidx + 2] / 255.0) * 2.0 - 1.0;
          }
        }
        const meanLen = Math.sqrt(sumNx * sumNx + sumNy * sumNy + sumNz * sumNz) / 9.0;
        const s = Math.max(0.01, Math.min(1.0, meanLen));
        const ft = ((1.0 - s) / s) * varianceScale;

        const idx = (y * w + x) * 4;
        const origAlpha = Math.max(0.01, roughnessRgba[idx] / 255.0);
        const alpha2 = origAlpha * origAlpha;
        const toksvigAlpha = Math.sqrt((alpha2 + ft) / (1.0 + ft));
        const byteVal = Math.round(Math.min(1.0, toksvigAlpha) * 255);
        out[idx]     = byteVal;
        out[idx + 1] = byteVal;
        out[idx + 2] = byteVal;
      }
    }
    return out;
  }

  /**
   * Evaluates Ramamoorthi 9-coefficient order-3 Spherical Harmonics diffuse irradiance:
   * E_ambient(N) = c1 * L22*(x^2 - y^2) + c3 * L20 * z^2 + c4 * L00 - c5 * L20
   *              + 2 * c1 * (L2-2 * x*y + L21 * x*z + L2-1 * y*z)
   *              + 2 * c2 * (L11 * x + L1-1 * y + L10 * z)
   */
  public static evaluateSphericalHarmonicsIrradiance(
    nx: number,
    ny: number,
    nz: number,
    shCoeffs: [number, number, number][]
  ): [number, number, number] {
    const c1 = 0.429043;
    const c2 = 0.511664;
    const c3 = 0.743125;
    const c4 = 0.886227;
    const c5 = 0.247708;

    const out: [number, number, number] = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
      const c = (i: number) => shCoeffs[i][ch];
      const val =
        c(0) * c4 -
        c(6) * c5 +
        c(6) * (c3 * ny * ny) +
        (c(8) * (nx * nx - nz * nz) +
          c(4) * (2.0 * nx * nz) +
          c(7) * (2.0 * nx * ny) +
          c(5) * (2.0 * nz * ny)) * c1 +
        (c(3) * nx + c(1) * ny + c(2) * nz) * (2.0 * c2);
      out[ch] = Math.max(0.0, val);
    }
    return out;
  }

  /**
   * Computes analytical solar irradiance E(N) = direct + ambient:
   *   E(N) = max(0, N dot L_sun) * directWeight + SH_9(N) * ambientWeight
   */
  public static computeSolarIrradiance(
    normal: [number, number, number],
    sunVector: [number, number, number],
    shCoeffs?: [number, number, number][],
    directWeight: number = 0.65,
    ambientWeight: number = 0.35,
    epsilon: number = 0.18
  ): number {
    const nx = normal[0], ny = normal[1], nz = normal[2];
    const nLen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
    const n: [number, number, number] = [nx / nLen, ny / nLen, nz / nLen];

    const sx = sunVector[0], sy = sunVector[1], sz = sunVector[2];
    const sLen = Math.sqrt(sx * sx + sy * sy + sz * sz) || 1.0;
    const s: [number, number, number] = [sx / sLen, sy / sLen, sz / sLen];

    const nDotL = Math.max(0.0, n[0] * s[0] + n[1] * s[1] + n[2] * s[2]);

    let ambient = 0.45;
    if (shCoeffs && shCoeffs.length === 9) {
      const rgb = this.evaluateSphericalHarmonicsIrradiance(n[0], n[1], n[2], shCoeffs);
      ambient = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    }

    const total = nDotL * directWeight + ambient * ambientWeight;
    return Math.max(epsilon, Math.min(1.8, total));
  }

  /**
   * Sun vector used by solar inverse de-lighting: `sunVector` when given, else the NOAA ephemeris at the caller's
   * latitude, longitude and UTC timestampIso. No place or date is assumed: without them this throws.
   */
  public static resolveSolarSunVector(cfg: SolarDelightingConfig = {}): [number, number, number] {
    if (cfg.sunVector) return cfg.sunVector;
    if (!Number.isFinite(cfg.latitude) || !Number.isFinite(cfg.longitude) || !cfg.timestampIso || Number.isNaN(Date.parse(cfg.timestampIso))) {
      throw new Error(`Solar de-lighting needs solarDelighting.sunVector, or latitude, longitude and a UTC timestampIso (got ${cfg.latitude}, ${cfg.longitude}, ${JSON.stringify(cfg.timestampIso)})`);
    }
    const pos = calculateNOAASolarPosition(new Date(cfg.timestampIso), cfg.latitude!, cfg.longitude!);
    const sun = calculateENUSunVector(pos.altitudeRad, pos.azimuthRad);
    return [sun.x, sun.y, sun.z];
  }

  /**
   * Generates custom Toksvig pre-filtered MIP pyramid where each downsampled level folds
   * normal variance sigma_n^2 directly into increased roughness alpha.
   * Completely eliminates specular shimmering and fireflies at extreme camera distance.
   */
  public static computeToksvigMipPyramid(
    roughnessRgba: Uint8Array,
    normalRgba: Uint8Array,
    w: number,
    h: number,
    maxLevels: number = 4
  ): ToksvigMipLevel[] {
    const levels: ToksvigMipLevel[] = [];
    let curW = w;
    let curH = h;
    let curRough = roughnessRgba;
    let curNorm = normalRgba;

    levels.push({
      level: 0,
      width: curW,
      height: curH,
      roughness: curRough,
      normal: curNorm,
      meanNormalLength: 1.0,
      addedRoughnessVariance: 0.0
    });

    for (let lvl = 1; lvl <= maxLevels; lvl++) {
      const nextW = Math.max(1, Math.floor(curW / 2));
      const nextH = Math.max(1, Math.floor(curH / 2));
      const nextRough = new Uint8Array(nextW * nextH * 4);
      const nextNorm = new Uint8Array(nextW * nextH * 4);
      let sumNormalLen = 0;
      let sumAddedVariance = 0;

      for (let y = 0; y < nextH; y++) {
        for (let x = 0; x < nextW; x++) {
          const sx = x * 2;
          const sy = y * 2;

          let avgNx = 0, avgNy = 0, avgNz = 0;
          let avgAlpha = 0;

          for (let dy = 0; dy < 2; dy++) {
            const py = Math.min(curH - 1, sy + dy);
            for (let dx = 0; dx < 2; dx++) {
              const px = Math.min(curW - 1, sx + dx);
              const idx = (py * curW + px) * 4;

              const nx = (curNorm[idx] / 255.0) * 2.0 - 1.0;
              const ny = (curNorm[idx + 1] / 255.0) * 2.0 - 1.0;
              const nz = (curNorm[idx + 2] / 255.0) * 2.0 - 1.0;

              avgNx += nx;
              avgNy += ny;
              avgNz += nz;

              const r = curRough[idx] / 255.0;
              avgAlpha += r * r;
            }
          }

          avgNx *= 0.25; avgNy *= 0.25; avgNz *= 0.25;
          avgAlpha *= 0.25;

          const nLen = Math.sqrt(avgNx * avgNx + avgNy * avgNy + avgNz * avgNz);
          sumNormalLen += nLen;

          const clampedLen = Math.max(0.001, Math.min(1.0, nLen));
          const sigmaSq = (1.0 - clampedLen) / clampedLen;
          sumAddedVariance += sigmaSq;

          const alphaEffSq = (avgAlpha + sigmaSq) / (1.0 + sigmaSq);
          const roughEff = Math.sqrt(Math.min(1.0, Math.max(0.01, alphaEffSq)));

          const outIdx = (y * nextW + x) * 4;
          const rByte = Math.round(roughEff * 255);
          nextRough[outIdx]     = rByte;
          nextRough[outIdx + 1] = rByte;
          nextRough[outIdx + 2] = rByte;
          nextRough[outIdx + 3] = 255;

          const renorm = clampedLen > 0 ? 1.0 / clampedLen : 1.0;
          nextNorm[outIdx]     = Math.round(((avgNx * renorm) * 0.5 + 0.5) * 255);
          nextNorm[outIdx + 1] = Math.round(((avgNy * renorm) * 0.5 + 0.5) * 255);
          nextNorm[outIdx + 2] = Math.round(((avgNz * renorm) * 0.5 + 0.5) * 255);
          nextNorm[outIdx + 3] = 255;
        }
      }

      const totalP = nextW * nextH;
      levels.push({
        level: lvl,
        width: nextW,
        height: nextH,
        roughness: nextRough,
        normal: nextNorm,
        meanNormalLength: sumNormalLen / totalP,
        addedRoughnessVariance: sumAddedVariance / totalP
      });

      curW = nextW;
      curH = nextH;
      curRough = nextRough;
      curNorm = nextNorm;
    }

    return levels;
  }

  /**
   * Multi-Tile Seamless Boundary Seam Welding & Edge Normal Synchronization:
   * Uses spatial coordinate binning to discover co-located vertices across tile boundaries,
   * unifies their position, and averages their vertex normals to eradicate boundary cracks
   * and light-leak artifacts.
   */
  public static weldTileBoundarySeams(
    vertices: Float32Array[],
    normals: Float32Array[],
    toleranceMeters: number = 0.05
  ): BoundarySeamWeldResult {
    let weldedVertexCount = 0;
    let weldedBoundaryPairs = 0;
    let maxDisplacementMeters = 0.0;

    const quant = Math.max(0.001, toleranceMeters);
    const grid = new Map<string, Array<{ tileIdx: number; vertIdx: number }>>();

    for (let t = 0; t < vertices.length; t++) {
      const vBuf = vertices[t];
      const count = Math.floor(vBuf.length / 3);
      for (let i = 0; i < count; i++) {
        const x = vBuf[i * 3];
        const y = vBuf[i * 3 + 1];
        const z = vBuf[i * 3 + 2];

        const gx = Math.round(x / quant);
        const gy = Math.round(y / quant);
        const gz = Math.round(z / quant);
        const key = `${gx}_${gy}_${gz}`;

        let list = grid.get(key);
        if (!list) {
          list = [];
          grid.set(key, list);
        }
        list.push({ tileIdx: t, vertIdx: i });
      }
    }

    for (const [_, list] of grid.entries()) {
      if (list.length < 2) continue;
      const firstTile = list[0].tileIdx;
      const spansTiles = list.some(item => item.tileIdx !== firstTile);
      if (!spansTiles) continue;

      let sumX = 0, sumY = 0, sumZ = 0;
      let sumNx = 0, sumNy = 0, sumNz = 0;

      for (const item of list) {
        const vBuf = vertices[item.tileIdx];
        const nBuf = normals[item.tileIdx];
        sumX += vBuf[item.vertIdx * 3];
        sumY += vBuf[item.vertIdx * 3 + 1];
        sumZ += vBuf[item.vertIdx * 3 + 2];

        if (nBuf && nBuf.length > item.vertIdx * 3 + 2) {
          sumNx += nBuf[item.vertIdx * 3];
          sumNy += nBuf[item.vertIdx * 3 + 1];
          sumNz += nBuf[item.vertIdx * 3 + 2];
        }
      }

      const invCount = 1.0 / list.length;
      const avgX = sumX * invCount;
      const avgY = sumY * invCount;
      const avgZ = sumZ * invCount;

      const nLen = Math.sqrt(sumNx * sumNx + sumNy * sumNy + sumNz * sumNz) || 1.0;
      const avgNx = sumNx / nLen;
      const avgNy = sumNy / nLen;
      const avgNz = sumNz / nLen;

      for (const item of list) {
        const vBuf = vertices[item.tileIdx];
        const nBuf = normals[item.tileIdx];

        const dx = avgX - vBuf[item.vertIdx * 3];
        const dy = avgY - vBuf[item.vertIdx * 3 + 1];
        const dz = avgZ - vBuf[item.vertIdx * 3 + 2];
        const disp = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (disp > maxDisplacementMeters) maxDisplacementMeters = disp;

        vBuf[item.vertIdx * 3]     = avgX;
        vBuf[item.vertIdx * 3 + 1] = avgY;
        vBuf[item.vertIdx * 3 + 2] = avgZ;

        if (nBuf && nBuf.length > item.vertIdx * 3 + 2) {
          nBuf[item.vertIdx * 3]     = avgNx;
          nBuf[item.vertIdx * 3 + 1] = avgNy;
          nBuf[item.vertIdx * 3 + 2] = avgNz;
        }
        weldedVertexCount++;
      }
      weldedBoundaryPairs++;
    }

    return {
      weldedVertexCount,
      weldedBoundaryPairs,
      maxDisplacementMeters
    };
  }

  /**
   * Image-Space Horizon-Based Micro-Cavity Ambient Occlusion (HBAO):
   * Synthesizes micro-cavity contact shadows from normal/height gradients using 8-directional radial horizon raymarching.
   */
  public static computeHbaoMicroCavityAo(
    normalRgba: Uint8Array,
    w: number,
    h: number,
    radiusPixels: number = 10,
    intensity: number = 1.2
  ): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    const virtualHeight = new Float32Array(w * h);

    // Height gradient approximation from normal map
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 4;
        const nx = (normalRgba[idx] / 255.0) * 2.0 - 1.0;
        const ny = (normalRgba[idx + 1] / 255.0) * 2.0 - 1.0;
        virtualHeight[y * w + x] = 0.5 - (nx * 0.5 + ny * 0.5);
      }
    }

    const dirs = 8;
    const angleStep = (2.0 * Math.PI) / dirs;

    // Integer step offsets per (direction, radius): Math.round(x + c) === x + Math.round(c) for integer x.
    const stepsPerDir = radiusPixels >= 2 ? Math.floor(radiusPixels / 2) : 0;
    const stepDx = new Int32Array(dirs * stepsPerDir);
    const stepDy = new Int32Array(dirs * stepsPerDir);
    for (let d = 0; d < dirs; d++) {
      const phi = d * angleStep;
      const dirX = Math.cos(phi);
      const dirY = Math.sin(phi);
      for (let s = 0; s < stepsPerDir; s++) {
        const r = 2 + 2 * s;
        stepDx[d * stepsPerDir + s] = Math.round(dirX * r);
        stepDy[d * stepsPerDir + s] = Math.round(dirY * r);
      }
    }

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const centerH = virtualHeight[y * w + x];
        let totalOcclusion = 0.0;

        for (let d = 0; d < dirs; d++) {
          // sin(atan(t)) = t / sqrt(1 + t^2) is monotonic, so the horizon sine is taken once from the max tangent.
          let maxTan = 0.0;
          for (let s = 0; s < stepsPerDir; s++) {
            const sx = x + stepDx[d * stepsPerDir + s];
            const sy = y + stepDy[d * stepsPerDir + s];
            if (sx < 0 || sx >= w || sy < 0 || sy >= h) break;

            const tanAngle = (virtualHeight[sy * w + sx] - centerH) / (2 + 2 * s);
            if (tanAngle > maxTan) {
              maxTan = tanAngle;
            }
          }
          totalOcclusion += maxTan / Math.sqrt(1.0 + maxTan * maxTan);
        }

        const aoVal = Math.max(0.05, Math.min(1.0, 1.0 - (totalOcclusion / dirs) * intensity * 1.35));
        const byteVal = Math.round(aoVal * 255);
        const outIdx = (y * w + x) * 4;
        out[outIdx]     = byteVal;
        out[outIdx + 1] = byteVal;
        out[outIdx + 2] = byteVal;
        out[outIdx + 3] = 255;
      }
    }
    return out;
  }

  /**
   * 1D Spatial Autocorrelation along horizontal and vertical scanlines.
   * Auto-induces fundamental unit cell periodicity (lambda_x, lambda_y), correlation lengths,
   * aspect ratios, and architectural module repeat scaling directly from texture pixels (zero presets!).
   */
  public static analyzeTextureSpatialProfile(
    lum: Float32Array,
    w: number,
    h: number,
    targetResolutionMeters: number = 2.0
  ): TextureSpatialProfile {
    const maxLagX = Math.min(Math.floor(w / 2), 256);
    const maxLagY = Math.min(Math.floor(h / 2), 256);
    const totalPixels = w * h;

    let sumL = 0;
    let sumL2 = 0;
    for (let i = 0; i < totalPixels; i++) {
      const l = lum[i];
      sumL += l;
      sumL2 += l * l;
    }
    const meanL = sumL / totalPixels;
    const varL = Math.max(1e-7, (sumL2 / totalPixels) - meanL * meanL);

    const autocorrX = new Float32Array(maxLagX);
    for (let lag = 0; lag < maxLagX; lag++) {
      let cov = 0;
      let count = 0;
      for (let y = 0; y < h; y += 4) {
        for (let x = 0; x < w - lag; x += 2) {
          const l1 = lum[y * w + x] - meanL;
          const l2 = lum[y * w + (x + lag)] - meanL;
          cov += l1 * l2;
          count++;
        }
      }
      autocorrX[lag] = count > 0 ? cov / (count * varL) : 0;
    }

    const autocorrY = new Float32Array(maxLagY);
    for (let lag = 0; lag < maxLagY; lag++) {
      let cov = 0;
      let count = 0;
      for (let y = 0; y < h - lag; y += 2) {
        for (let x = 0; x < w; x += 4) {
          const l1 = lum[y * w + x] - meanL;
          const l2 = lum[(y + lag) * w + x] - meanL;
          cov += l1 * l2;
          count++;
        }
      }
      autocorrY[lag] = count > 0 ? cov / (count * varL) : 0;
    }

    const oneOverE = 1.0 / Math.E;
    let corrLenX = 16.0;
    let corrLenY = 16.0;
    for (let lag = 1; lag < maxLagX; lag++) {
      if (autocorrX[lag] < oneOverE) { corrLenX = lag; break; }
    }
    for (let lag = 1; lag < maxLagY; lag++) {
      if (autocorrY[lag] < oneOverE) { corrLenY = lag; break; }
    }

    const findPeak = (ac: Float32Array): number => {
      let passedValley = false;
      let valleyVal = 1.0;
      for (let lag = 2; lag < ac.length - 2; lag++) {
        if (!passedValley) {
          if (ac[lag] < ac[lag - 1] && ac[lag] <= ac[lag + 1]) {
            passedValley = true;
            valleyVal = ac[lag];
          }
        } else {
          if (ac[lag] > ac[lag - 1] && ac[lag] >= ac[lag + 1]) {
            if (ac[lag] - valleyVal > 0.08) {
              return lag;
            }
          }
        }
      }
      return 0;
    };

    const periodX = findPeak(autocorrX);
    const periodY = findPeak(autocorrY);

    if (periodX > 0 && periodY > 0) {
      const aspect = periodX / periodY;
      let modW = 0.60;
      let modH = 0.35;
      if (aspect > 2.8) {
        modW = 0.25; modH = 0.065; // Brick stretcher
      } else if (aspect > 1.4) {
        modW = 0.60; modH = 0.35; // Ashlar block
      } else if (aspect < 0.6) {
        modW = 0.40; modH = 1.20; // Standing seam / mullion
      } else {
        modW = 0.30; modH = 0.30; // Square tile
      }
      return {
        dominantPeriodPxX: periodX,
        dominantPeriodPxY: periodY,
        correlationLengthPxX: corrLenX,
        correlationLengthPxY: corrLenY,
        aspectRatio: Math.round(aspect * 100) / 100,
        isPeriodic: true,
        physicalModuleWidthMeters: modW,
        physicalModuleHeightMeters: modH,
        recommendedRepeatX: Math.round((targetResolutionMeters / modW) * 10) / 10,
        recommendedRepeatY: Math.round((targetResolutionMeters / modH) * 10) / 10
      };
    }

    return {
      dominantPeriodPxX: 0,
      dominantPeriodPxY: 0,
      correlationLengthPxX: corrLenX,
      correlationLengthPxY: corrLenY,
      aspectRatio: 1.0,
      isPeriodic: false,
      physicalModuleWidthMeters: targetResolutionMeters,
      physicalModuleHeightMeters: targetResolutionMeters,
      recommendedRepeatX: 1.0,
      recommendedRepeatY: 1.0
    };
  }

  /**
   * Photometric De-Lighting & True PBR Material Suite Decomposition.
   * Separates intrinsic albedo, computes analytical sky-dome AO, multi-frequency normal maps,
   * biophysical Laplacian curvature roughness, and standard glTF ORM textures.
   */
  public static async decomposePbr(
    albedoRgba: Uint8Array,
    options: PbrDecompositionOptions = {},
    width: number,
    height: number
  ): Promise<PbrDecompositionResult> {
    const contract = resolveBiophysicalContract(options.biophysicalContract ?? {
      roughness: options.defaultStoneRoughness,
      normalStrength: options.normalStrength,
      hbaoIntensity: options.skyDomeAoIntensity
    });

    const normalStrength = contract.normalStrength;
    const defaultRoughness = contract.roughness;
    const aoIntensity = contract.hbaoIntensity;
    const totalPixels = width * height;

    const albedoOut = new Uint8Array(albedoRgba.length);
    albedoOut.set(albedoRgba);

    // 1. Intrinsic Image Decomposition (Albedo A vs Irradiance S separation)
    // Shading is the slowly varying part of luminance, estimated per UV chart (4-connected painted texels, alpha > 0)
    // so neighbouring charts never mix. Each chart's texels in a coarse grid cell (16 cells across the short side)
    // form a node; the edge-aware bilateral smooths node luminance within the chart (bilateralSpatialRadius is in
    // cells, and nodes under half a cell of texels do not centre the range term), and each texel blends the nodes
    // around it weighted by how close their shading is to the texel's local luminance, so hard shadow edges stay
    // sharp. Texels are divided by shading relative to the mean shading, so shadows lift and highlights drop while
    // the image keeps its overall brightness (a high-percentile "lit level" brightens the whole image whenever sky,
    // blank background or another bright non-surface region is present). Because the reference is per image, the
    // same lit surface can come out at different brightness in images with very different shadow fractions. Finer
    // grids treat window-sized detail as shading and divide it away. Charts smaller than one cell are left as they
    // are: there is too little area to tell their lighting from their albedo. Charts come from alpha, so a caller
    // that bleeds texels into its gutters first (SurveyTextureUnprojector does, 4 px) merges charts that sit closer
    // than twice the bleed. A hard shadow edge in the middle of a cell can still leave a faint band.
    if (options.enableAlbedoDeLighting) {
      const spatialR = options.bilateralSpatialRadius ?? 4;
      const rangeSigma = options.bilateralRangeSigma ?? 0.15;
      const normY = options.normalizedElevationY ?? 0.5;
      const heightStratified = options.enableHeightStratifiedDeLighting ?? false;
      // Shadow lift factor: in deep street canyons (normY -> 0), shadow lift is amplified
      const canyonElevationWeight = heightStratified ? Math.pow(1.0 - Math.min(1.0, Math.max(0.0, normY)), 2.0) : 0.0;
      const rangeDenom = 2 * rangeSigma * rangeSigma;

      const lum = new Float32Array(totalPixels);
      for (let i = 0; i < totalPixels; i++) {
        lum[i] = (0.299 * albedoRgba[i * 4] + 0.587 * albedoRgba[i * 4 + 1] + 0.114 * albedoRgba[i * 4 + 2]) / 255.0;
      }

      // Charts: 4-connected components of painted texels (union-find)
      const chart = new Int32Array(totalPixels).fill(-1);
      const parent: number[] = [];
      const find = (a: number): number => {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
      };
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (albedoRgba[i * 4 + 3] === 0) continue;
          const left = x > 0 ? chart[i - 1] : -1;
          const up = y > 0 ? chart[i - width] : -1;
          if (left < 0 && up < 0) {
            chart[i] = parent.length;
            parent.push(parent.length);
          } else if (left >= 0 && up >= 0) {
            const a = find(left), b = find(up);
            if (a !== b) parent[b] = a;
            chart[i] = a;
          } else {
            chart[i] = left >= 0 ? left : up;
          }
        }
      }
      const chartSize = new Int32Array(parent.length);
      for (let i = 0; i < totalPixels; i++) {
        if (chart[i] >= 0) { chart[i] = find(chart[i]); chartSize[chart[i]]++; }
      }

      // Nodes: the texels of one chart inside one coarse cell
      const cell = Math.max(1, Math.floor(Math.min(width, height) / 16));
      const cw = Math.ceil(width / cell);
      const ch = Math.ceil(height / cell);
      const fullCell = cell * cell;
      const nodeKey = (c: number, k: number) => k * cw * ch + c;
      const nodeOf = new Map<number, number>();
      const nodeCell: number[] = [];
      const nodeChart: number[] = [];
      const nodeLum: number[] = [];
      const nodeCount: number[] = [];
      const texelNode = new Int32Array(totalPixels).fill(-1);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const k = chart[i];
          if (k < 0 || chartSize[k] < fullCell) continue;
          const c = Math.floor(y / cell) * cw + Math.floor(x / cell);
          let n = nodeOf.get(nodeKey(c, k));
          if (n === undefined) {
            n = nodeCell.length;
            nodeOf.set(nodeKey(c, k), n);
            nodeCell.push(c); nodeChart.push(k); nodeLum.push(0); nodeCount.push(0);
          }
          nodeLum[n] += lum[i];
          nodeCount[n]++;
          texelNode[i] = n;
        }
      }
      const nodeTotal = nodeCell.length;
      for (let n = 0; n < nodeTotal; n++) nodeLum[n] /= nodeCount[n];

      // Bilateral over each chart's nodes, weighted by texel count; sparse nodes are filled spatially
      const R = Math.max(0, Math.round(spatialR));
      const spatialDenom = 2 * Math.max(0.5, spatialR) * Math.max(0.5, spatialR);
      const nodeShading = new Float32Array(nodeTotal);
      for (let n = 0; n < nodeTotal; n++) {
        const cx = nodeCell[n] % cw, cy = Math.floor(nodeCell[n] / cw);
        const centre = nodeCount[n] >= 0.5 * fullCell ? nodeLum[n] : NaN;
        let sumWeights = 0.0;
        let sumLum = 0.0;
        for (let dy = -R; dy <= R; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= ch) continue;
          for (let dx = -R; dx <= R; dx++) {
            const nx = cx + dx;
            if (nx < 0 || nx >= cw) continue;
            const m = nodeOf.get(nodeKey(ny * cw + nx, nodeChart[n]));
            if (m === undefined) continue;
            const rangeDist = Number.isNaN(centre) ? 0 : (nodeLum[m] - centre) * (nodeLum[m] - centre);
            const weight = nodeCount[m] * Math.exp(-(dx * dx + dy * dy) / spatialDenom - rangeDist / rangeDenom);
            sumLum += nodeLum[m] * weight;
            sumWeights += weight;
          }
        }
        nodeShading[n] = Math.max(0.2, Math.min(1.0, sumLum / sumWeights));
      }

      // Guide: mean luminance of painted texels within a small window (integral images)
      const rg = Math.max(1, Math.round(cell / 8));
      const iw = width + 1;
      const sumImg = new Float64Array(iw * (height + 1));
      const cntImg = new Float64Array(iw * (height + 1));
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const on = albedoRgba[i * 4 + 3] !== 0 ? 1 : 0;
          const o = (y + 1) * iw + x + 1;
          sumImg[o] = lum[i] * on + sumImg[o - iw] + sumImg[o - 1] - sumImg[o - iw - 1];
          cntImg[o] = on + cntImg[o - iw] + cntImg[o - 1] - cntImg[o - iw - 1];
        }
      }

      // Neighbouring nodes of the same chart in the 3x3 cells around each node's cell
      const neighbours: number[][] = new Array(nodeTotal);
      for (let n = 0; n < nodeTotal; n++) {
        const cx = nodeCell[n] % cw, cy = Math.floor(nodeCell[n] / cw);
        const list: number[] = [];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
            const m = nodeOf.get(nodeKey(ny * cw + nx, nodeChart[n]));
            if (m !== undefined) list.push(m);
          }
        }
        neighbours[n] = list;
      }

      const texelShading = new Float32Array(totalPixels);
      let shadingSum = 0.0;
      let shaded = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          const n = texelNode[i];
          if (n >= 0) {
            const x0 = Math.max(0, x - rg), x1 = Math.min(width, x + rg + 1);
            const y0 = Math.max(0, y - rg), y1 = Math.min(height, y + rg + 1);
            const cnt = cntImg[y1 * iw + x1] - cntImg[y0 * iw + x1] - cntImg[y1 * iw + x0] + cntImg[y0 * iw + x0];
            const guide = cnt > 0
              ? (sumImg[y1 * iw + x1] - sumImg[y0 * iw + x1] - sumImg[y1 * iw + x0] + sumImg[y0 * iw + x0]) / cnt
              : lum[i];
            const fx = (x + 0.5) / cell, fy = (y + 0.5) / cell;
            let sw = 0.0, ss = 0.0, sw0 = 0.0, ss0 = 0.0;
            for (const m of neighbours[n]) {
              const ddx = fx - ((nodeCell[m] % cw) + 0.5);
              const ddy = fy - (Math.floor(nodeCell[m] / cw) + 0.5);
              const confidence = Math.min(1.0, nodeCount[m] / (0.5 * fullCell));
              const ws = Math.exp(-(ddx * ddx + ddy * ddy) / 0.5) * confidence;
              const dr = nodeShading[m] - guide;
              const wr = Math.exp(-(dr * dr) / rangeDenom);
              sw += ws * wr; ss += ws * wr * nodeShading[m];
              sw0 += ws; ss0 += ws * nodeShading[m];
            }
            texelShading[i] = sw > 1e-6 * sw0 ? ss / sw : ss0 / sw0;
            shadingSum += texelShading[i];
            shaded++;
          }
        }
      }

      const meanShading = shaded > 0 ? shadingSum / shaded : 1.0;
      for (let i = 0; i < totalPixels; i++) {
        const idx = i * 4;
        if (albedoRgba[idx + 3] === 0) continue;
        // Charts too small to separate lighting from albedo keep their pixels
        const shading = texelNode[i] >= 0 ? texelShading[i] : meanShading;
        // Apply canyon shadow lift: boosts luminance when shading is low in deep street canyons
        const canyonLift = 1.0 + 0.35 * canyonElevationWeight * Math.max(0.0, 0.6 - shading);
        const gain = (meanShading / shading) * canyonLift;
        albedoOut[idx] = Math.min(255, Math.round(albedoRgba[idx] * gain));
        albedoOut[idx + 1] = Math.min(255, Math.round(albedoRgba[idx + 1] * gain));
        albedoOut[idx + 2] = Math.min(255, Math.round(albedoRgba[idx + 2] * gain));
      }
    }

    // 1b. Solar Inverse De-Lighting via NOAA Ephemeris & Ramamoorthi SH9 Irradiance
    let solarDelighting: PbrDecompositionResult['solarDelighting'];
    if (options.enableSolarInverseDelighting) {
      const cfg = options.solarDelighting || {};
      // The sun is the one given (a vector, or a place and time for the NOAA ephemeris); no place or date is assumed.
      const sunVec = this.resolveSolarSunVector(cfg);

      const skyShCoeffs: [number, number, number][] = cfg.skyShCoeffs ?? [
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

      const directWeight = cfg.directWeight ?? 0.65;
      const ambientWeight = cfg.ambientWeight ?? 0.35;
      const eps = cfg.regularizationEpsilon ?? 0.18;

      // E(N) needs the surface normal of each texel. It comes from the geometry (worldNormalsMap, one world-space
      // unit normal per texel in the sun vector's frame), never from the image: a normal estimated from the
      // gradient of the same pixels makes the divisor a function of the texture it divides.
      const normals = options.worldNormalsMap;
      if (!normals || normals.length !== totalPixels * 3) {
        throw new SolarDelightingNormalsError(
          `solar de-lighting needs worldNormalsMap with one geometry normal per texel (${totalPixels * 3} floats for ${width}x${height}); got ${normals ? normals.length : 'none'}`
        );
      }
      const irradianceMap = new Float32Array(totalPixels);
      let irradianceSum = 0.0;
      let delitTexels = 0;
      let paintedWithoutNormal = 0;
      for (let i = 0; i < totalPixels; i++) {
        if (albedoRgba[i * 4 + 3] === 0) continue;
        const nx = normals[i * 3], ny = normals[i * 3 + 1], nz = normals[i * 3 + 2];
        if (!(Math.hypot(nx, ny, nz) > 1e-6)) { paintedWithoutNormal++; continue; }
        const irradiance = this.computeSolarIrradiance([nx, ny, nz], sunVec, skyShCoeffs, directWeight, ambientWeight, eps);
        irradianceMap[i] = irradiance;
        irradianceSum += irradiance;
        delitTexels++;
      }

      // E(N) inverse division relative to the mean irradiance: removes the directional light, keeps the brightness.
      // Texels with no geometry normal keep their pixels.
      const meanIrradiance = delitTexels > 0 ? irradianceSum / delitTexels : 1.0;
      for (let i = 0; i < totalPixels; i++) {
        const idx = i * 4;
        if (albedoRgba[idx + 3] === 0 || irradianceMap[i] === 0) continue;
        const gain = meanIrradiance / irradianceMap[i];
        albedoOut[idx]     = Math.min(255, Math.max(0, Math.round(albedoOut[idx] * gain)));
        albedoOut[idx + 1] = Math.min(255, Math.max(0, Math.round(albedoOut[idx + 1] * gain)));
        albedoOut[idx + 2] = Math.min(255, Math.max(0, Math.round(albedoOut[idx + 2] * gain)));
      }
      solarDelighting = { sunVector: sunVec, delitTexels, paintedTexelsWithoutNormal: paintedWithoutNormal };
    }

    // Build luminance float buffer for differential operators
    const lumFloats = new Float32Array(totalPixels);
    for (let i = 0; i < totalPixels; i++) {
      const idx = i * 4;
      lumFloats[i] = (0.299 * albedoOut[idx] + 0.587 * albedoOut[idx + 1] + 0.114 * albedoOut[idx + 2]) / 255.0;
    }

    // 2. Tangent-Space Normal Map (Multi-Frequency Scharr + RNM or standard Sobel)
    let normalMap: Uint8Array;
    if (options.enableMultiFrequencyNormals !== false) {
      normalMap = this.computeMultiFrequencyNormalMap(lumFloats, width, height, normalStrength);
    } else {
      normalMap = new Uint8Array(totalPixels * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const getLum = (px: number, py: number) => {
            const cx = Math.max(0, Math.min(width - 1, px));
            const cy = Math.max(0, Math.min(height - 1, py));
            return lumFloats[cy * width + cx];
          };

          const tl = getLum(x - 1, y - 1);
          const t  = getLum(x,     y - 1);
          const tr = getLum(x + 1, y - 1);
          const l  = getLum(x - 1, y);
          const r  = getLum(x + 1, y);
          const bl = getLum(x - 1, y + 1);
          const b  = getLum(x,     y + 1);
          const br = getLum(x + 1, y + 1);

          const dx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
          const dy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);

          let nx = -dx * normalStrength;
          let ny = -dy * normalStrength;
          let nz = 1.0;

          const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
          nx /= len;
          ny /= len;
          nz /= len;

          const outIdx = (y * width + x) * 4;
          normalMap[outIdx]     = Math.round((nx * 0.5 + 0.5) * 255);
          normalMap[outIdx + 1] = Math.round((ny * 0.5 + 0.5) * 255);
          normalMap[outIdx + 2] = Math.round((nz * 0.5 + 0.5) * 255);
          normalMap[outIdx + 3] = 255;
        }
      }
    }

    // 3. Sky-Dome Ambient Occlusion (HBAO Horizon Raymarching or standard local cavity)
    let aoMap: Uint8Array;
    if (options.enableHbaoMicroCavity !== false) {
      aoMap = this.computeHbaoMicroCavityAo(normalMap, width, height, contract.hbaoRadius, aoIntensity);
    } else {
      aoMap = new Uint8Array(totalPixels * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const lum = lumFloats[y * width + x];

          const getNeighborLum = (px: number, py: number) => {
            const cx = Math.max(0, Math.min(width - 1, px));
            const cy = Math.max(0, Math.min(height - 1, py));
            return lumFloats[cy * width + cx];
          };

          const avg = (getNeighborLum(x - 1, y) + getNeighborLum(x + 1, y) +
                       getNeighborLum(x, y - 1) + getNeighborLum(x, y + 1)) * 0.25;
          const cavity = Math.max(0.0, avg - lum);
          const aoVal = Math.max(0.15, Math.min(1.0, 1.0 - cavity * aoIntensity * 3.5));

          const byteVal = Math.round(aoVal * 255);
          aoMap[idx]     = byteVal;
          aoMap[idx + 1] = byteVal;
          aoMap[idx + 2] = byteVal;
          aoMap[idx + 3] = 255;
        }
      }
    }

    // 4. Semantic Physical Roughness Map (Biophysical Laplacian Curvature or semantic threshold)
    let roughnessMap: Uint8Array;
    if (options.enableBiophysicalRoughness !== false) {
      roughnessMap = this.computeBiophysicalRoughness(
        lumFloats,
        width,
        height,
        defaultRoughness,
        1.8,
        contract.laplacianBurnishFactor,
        contract.laplacianCavityGritFactor
      );

      // Preserve semantic masks for road and foliage
      for (let i = 0; i < totalPixels; i++) {
        const idx = i * 4;
        const r = albedoOut[idx];
        const g = albedoOut[idx + 1];
        const b = albedoOut[idx + 2];

        if ((g > r + 8 && g > b + 8) || (g > 100 && 2 * g - r - b > 25 && g > r)) {
          const folVal = Math.round(0.40 * 255);
          roughnessMap[idx] = folVal;
          roughnessMap[idx + 1] = folVal;
          roughnessMap[idx + 2] = folVal;
        } else if (r < 140 && Math.abs(r - g) < 15 && Math.abs(g - b) < 15) {
          const aspVal = Math.round(0.55 * 255);
          roughnessMap[idx] = aspVal;
          roughnessMap[idx + 1] = aspVal;
          roughnessMap[idx + 2] = aspVal;
        }
      }
    } else {
      roughnessMap = new Uint8Array(totalPixels * 4);
      for (let i = 0; i < totalPixels; i++) {
        const idx = i * 4;
        const r = albedoOut[idx];
        const g = albedoOut[idx + 1];
        const b = albedoOut[idx + 2];

        let rough = defaultRoughness;
        if ((g > r + 8 && g > b + 8) || (g > 100 && 2 * g - r - b > 25 && g > r)) {
          rough = 0.40;
        } else if (r < 140 && Math.abs(r - g) < 15 && Math.abs(g - b) < 15) {
          rough = 0.55;
        }

        const byteVal = Math.round(rough * 255);
        roughnessMap[idx]     = byteVal;
        roughnessMap[idx + 1] = byteVal;
        roughnessMap[idx + 2] = byteVal;
        roughnessMap[idx + 3] = 255;
      }
    }

    // Apply Toksvig Specular Anti-Aliasing to roughness
    if (options.enableToksvigFiltering !== false) {
      roughnessMap = this.applyToksvigAntiAliasing(roughnessMap, normalMap, width, height, contract.toksvigVarianceScale);
    }

    // 5. glTF Standard ORM Map (R = AO, G = Roughness, B = Metallic)
    const ormMap = new Uint8Array(totalPixels * 4);
    const metalByte = Math.round(Math.max(0.0, Math.min(1.0, contract.metalness)) * 255);
    for (let i = 0; i < totalPixels; i++) {
      const idx = i * 4;
      ormMap[idx]     = aoMap[idx];        // Red: Ambient Occlusion
      ormMap[idx + 1] = roughnessMap[idx]; // Green: Roughness
      ormMap[idx + 2] = metalByte;         // Blue: Metallic
      ormMap[idx + 3] = 255;
    }

    let toksvigMipPyramid: ToksvigMipLevel[] | undefined;
    if (options.enableToksvigMipPyramid) {
      toksvigMipPyramid = this.computeToksvigMipPyramid(
        roughnessMap,
        normalMap,
        width,
        height,
        options.toksvigMipLevels ?? 4
      );
    }

    return {
      albedo: albedoOut,
      normal: normalMap,
      roughness: roughnessMap,
      ao: aoMap,
      orm: ormMap,
      width,
      height,
      toksvigMipPyramid,
      solarDelighting,
      mapProvenance: IMAGE_DERIVED_MAP_PROVENANCE
    };
  }

  /**
   * Packs rectangular texture charts into a high-density atlas using MaxRects.
   */
  public static packAtlasMaxRects(
    items: TextureItem[],
    options: AtlasPackerOptions = {}
  ): AtlasResult {
    const packer = new MaxRectsAtlasPacker(options);
    for (const item of items) {
      packer.addTexture(item);
    }
    return packer.pack();
  }

  // ==========================================================================
  // Internal Texture Processing
  // ==========================================================================

  /** decodePng handles only 8-bit, non-interlaced grey / RGB / RGBA; reject the variants it would silently mis-decode. */
  private static assertDecodablePng(buf: Buffer): void {
    if (buf.length < 29 || buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG has no IHDR chunk');
    const bitDepth = buf[24];
    const colorType = buf[25];
    const interlace = buf[28];
    if (bitDepth !== 8 || ![0, 2, 6].includes(colorType) || interlace !== 0) {
      throw new Error(`unsupported PNG variant (bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}); only 8-bit non-interlaced grey / RGB / RGBA PNGs decode`);
    }
  }

  /**
   * Decodes one baseColor image and runs the requested passes on its pixels. Throws when the image cannot be
   * decoded. Returns only what was computed: `albedo` when de-lighting ran (JPEG sources stay JPEG, others
   * become PNG), and PNG normal / metallicRoughness / occlusion maps at the image's own resolution.
   */
  /**
   * World-space geometry normal of every texel of a width x height image, from the triangle primitives that sample it.
   * Each primitive is rasterized in its texCoord UV space (glTF v down) under every node that instances its mesh.
   * Normals are NORMAL interpolated by barycentrics, or the face normal of the world positions when NORMAL is absent,
   * and are transformed by the node's inverse-transpose. A texel several triangles map to keeps the mean only when the
   * normals agree (mean length >= 0.9); otherwise it gets none. Primitives whose texture has KHR_texture_transform,
   * or that are not triangle lists, are not rasterized, since their texels cannot be placed without guessing.
   */
  public static rasterizeGeometryNormalsToUv(
    glb: { json: any; bin: Uint8Array },
    prims: UvPrimitiveRef[],
    meshNodes: Map<number, Mat4[]>,
    width: number,
    height: number
  ): { normals: Float32Array; texelsWithNormal: number; texelsConflicting: number; normalSource?: 'vertex-normals' | 'face-normals-from-positions' | 'mixed'; reason?: string } {
    const total = width * height;
    const sum = new Float32Array(total * 3);
    const hits = new Uint32Array(total);
    const skipped: string[] = [];
    let usedVertex = false, usedFace = false;
    for (const ref of prims) {
      const prim = ref.primitive;
      if ((prim.mode ?? 4) !== 4) { skipped.push(`mesh ${ref.meshIndex}: primitive mode ${prim.mode} is not a triangle list`); continue; }
      if (ref.textureTransformed) { skipped.push(`mesh ${ref.meshIndex}: baseColorTexture uses KHR_texture_transform`); continue; }
      const uvAcc = prim.attributes?.[`TEXCOORD_${ref.texCoord}`];
      if (uvAcc === undefined) { skipped.push(`mesh ${ref.meshIndex}: no TEXCOORD_${ref.texCoord}`); continue; }
      if (prim.attributes?.POSITION === undefined) { skipped.push(`mesh ${ref.meshIndex}: no POSITION`); continue; }
      const nodes = meshNodes.get(ref.meshIndex);
      if (!nodes || nodes.length === 0) { skipped.push(`mesh ${ref.meshIndex}: no scene node instances it`); continue; }

      const uv = readAccessor(glb, uvAcc);
      const uvDef = glb.json.accessors[uvAcc];
      const uvScale = uvDef.normalized ? (uvDef.componentType === 5121 ? 1 / 255 : uvDef.componentType === 5123 ? 1 / 65535 : 1) : 1;
      const pos = readAccessor(glb, prim.attributes.POSITION);
      const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(glb, prim.attributes.NORMAL) : undefined;
      if (nrm) usedVertex = true; else usedFace = true;
      const idx = prim.indices !== undefined ? readAccessor(glb, prim.indices).data : undefined;
      const triCount = Math.floor((idx ? idx.length : pos.count) / 3);

      for (const m of nodes) {
        // Inverse-transpose of the upper 3x3 (column-major m) via the cofactor matrix, signed by the determinant.
        const a = m[0], b = m[4], c = m[8], d = m[1], e = m[5], f = m[9], g = m[2], h = m[6], k = m[10];
        const C = [e * k - f * h, -(d * k - f * g), d * h - e * g, -(b * k - c * h), a * k - c * g, -(a * h - b * g), b * f - c * e, -(a * f - c * d), a * e - b * d];
        const det = a * C[0] + b * C[1] + c * C[2];
        const sgn = det < 0 ? -1 : 1;
        const xfN = (x: number, y: number, z: number): [number, number, number] => [
          sgn * (C[0] * x + C[1] * y + C[2] * z), sgn * (C[3] * x + C[4] * y + C[5] * z), sgn * (C[6] * x + C[7] * y + C[8] * z)
        ];
        const xfP = (i: number): [number, number, number] => {
          const x = pos.data[i * 3], y = pos.data[i * 3 + 1], z = pos.data[i * 3 + 2];
          return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
        };
        for (let t = 0; t < triCount; t++) {
          const vi = [0, 1, 2].map(j => (idx ? idx[t * 3 + j] : t * 3 + j));
          const px = vi.map(v => uv.data[v * 2] * uvScale * width);
          const py = vi.map(v => uv.data[v * 2 + 1] * uvScale * height);
          const area = (px[1] - px[0]) * (py[2] - py[0]) - (px[2] - px[0]) * (py[1] - py[0]);
          if (!(Math.abs(area) > 1e-12)) continue;
          let vn: [number, number, number][];
          if (nrm) {
            vn = vi.map(v => xfN(nrm.data[v * 3], nrm.data[v * 3 + 1], nrm.data[v * 3 + 2]));
          } else {
            const [p0, p1, p2] = vi.map(xfP);
            const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
            const wx = p2[0] - p0[0], wy = p2[1] - p0[1], wz = p2[2] - p0[2];
            const fn: [number, number, number] = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
            vn = [fn, fn, fn];
          }
          const x0 = Math.max(0, Math.floor(Math.min(px[0], px[1], px[2])));
          const x1 = Math.min(width - 1, Math.ceil(Math.max(px[0], px[1], px[2])));
          const y0 = Math.max(0, Math.floor(Math.min(py[0], py[1], py[2])));
          const y1 = Math.min(height - 1, Math.ceil(Math.max(py[0], py[1], py[2])));
          for (let y = y0; y <= y1; y++) {
            const cy = y + 0.5;
            for (let x = x0; x <= x1; x++) {
              const cx = x + 0.5;
              const w0 = ((px[1] - cx) * (py[2] - cy) - (px[2] - cx) * (py[1] - cy)) / area;
              const w1 = ((px[2] - cx) * (py[0] - cy) - (px[0] - cx) * (py[2] - cy)) / area;
              const w2 = 1 - w0 - w1;
              if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
              let nx = w0 * vn[0][0] + w1 * vn[1][0] + w2 * vn[2][0];
              let ny = w0 * vn[0][1] + w1 * vn[1][1] + w2 * vn[2][1];
              let nz = w0 * vn[0][2] + w1 * vn[1][2] + w2 * vn[2][2];
              const len = Math.hypot(nx, ny, nz);
              if (!(len > 1e-12)) continue;
              nx /= len; ny /= len; nz /= len;
              const ti = y * width + x;
              sum[ti * 3] += nx; sum[ti * 3 + 1] += ny; sum[ti * 3 + 2] += nz;
              hits[ti]++;
            }
          }
        }
      }
    }
    const normals = new Float32Array(total * 3);
    let texelsWithNormal = 0, texelsConflicting = 0;
    for (let i = 0; i < total; i++) {
      if (hits[i] === 0) continue;
      const len = Math.hypot(sum[i * 3], sum[i * 3 + 1], sum[i * 3 + 2]);
      if (len / hits[i] < 0.9) { texelsConflicting++; continue; }
      normals[i * 3] = sum[i * 3] / len; normals[i * 3 + 1] = sum[i * 3 + 1] / len; normals[i * 3 + 2] = sum[i * 3 + 2] / len;
      texelsWithNormal++;
    }
    const normalSource = usedVertex && usedFace ? 'mixed' : usedVertex ? 'vertex-normals' : usedFace ? 'face-normals-from-positions' : undefined;
    const reason = texelsWithNormal === 0
      ? (skipped.length ? skipped.join('; ') : texelsConflicting > 0 ? `all ${texelsConflicting} covered texels have conflicting normals (shared or tiled UVs)` : undefined)
      : undefined;
    return { normals, texelsWithNormal, texelsConflicting, normalSource, reason };
  }

  private static async processTextureBuffer(
    imgBuffer: Buffer,
    pbrOpts: PbrDecompositionOptions,
    want: { delight: boolean; normal: boolean; roughness: boolean; ao: boolean; profile: boolean },
    packOrm: boolean
  ): Promise<{
    width: number;
    height: number;
    albedo?: { data: Buffer; mimeType: string };
    normalPng?: Buffer;
    metallicRoughnessPng?: Buffer;
    occlusionPng?: Buffer;
    profile?: Omit<MeasuredSpatialProfile, 'sourceImageIndex'>;
    solarDelighting?: PbrDecompositionResult['solarDelighting'];
    mapProvenance?: PbrMapProvenance;
  }> {
    const format = sniffImageFormat(imgBuffer);
    if (format === 'png') this.assertDecodablePng(imgBuffer);
    const decoded: RgbaImage = await decodeImageToRgba(imgBuffer);
    const { width, height } = decoded;
    if (!(width > 0 && height > 0) || decoded.rgba.length !== width * height * 4) {
      throw new Error(`decoder returned ${decoded.rgba.length} bytes for a ${width}x${height} image`);
    }
    const rgba = new Uint8Array(decoded.rgba.buffer, decoded.rgba.byteOffset, decoded.rgba.byteLength);
    const out: Awaited<ReturnType<typeof AlgorithmicUvEngine.processTextureBuffer>> = { width, height };

    if (want.profile) {
      const lum = new Float32Array(width * height);
      for (let i = 0; i < lum.length; i++) {
        lum[i] = (0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]) / 255.0;
      }
      const p = this.analyzeTextureSpatialProfile(lum, width, height);
      out.profile = { isPeriodic: p.isPeriodic, dominantPeriodPxX: p.dominantPeriodPxX, dominantPeriodPxY: p.dominantPeriodPxY };
    }

    if (!want.delight && !want.normal && !want.roughness && !want.ao) return out;

    const pbr = await this.decomposePbr(rgba, pbrOpts, width, height);
    out.solarDelighting = pbr.solarDelighting;
    out.mapProvenance = pbr.mapProvenance;
    const asBuffer = (u: Uint8Array) => Buffer.from(u.buffer, u.byteOffset, u.byteLength);

    if (want.delight) {
      out.albedo = format === 'jpeg'
        ? { data: await encodeRgbaToJpeg(pbr.albedo, width, height, { quality: 92 }), mimeType: 'image/jpeg' }
        : { data: encodePng(width, height, asBuffer(pbr.albedo)), mimeType: 'image/png' };
    }
    if (want.normal && pbr.normal) {
      // decomposePbr's normals point +Y toward the image bottom; glTF tangent space has +Y toward the image top.
      const normal = Buffer.from(pbr.normal);
      for (let i = 1; i < normal.length; i += 4) normal[i] = 255 - normal[i];
      out.normalPng = encodePng(width, height, normal);
    }
    if ((want.roughness || want.ao) && pbr.orm) {
      // ORM: R = occlusion, G = roughness, B = metalness. glTF metallicRoughness ignores R and occlusion reads only R.
      const orm = encodePng(width, height, asBuffer(pbr.orm));
      if (want.roughness) out.metallicRoughnessPng = orm;
      if (want.ao) out.occlusionPng = packOrm || !pbr.ao ? orm : encodePng(width, height, asBuffer(pbr.ao));
    }
    return out;
  }

  // ==========================================================================
  // glTF 2.0 Binary (GLB) Parsing & Packing Helpers
  // ==========================================================================

  public static parseGlb(buffer: Buffer): { json: any; bin: Buffer } {
    const magic = buffer.readUInt32LE(0);
    if (magic !== 0x46546c67) {
      throw new Error(`Invalid GLB magic header: 0x${magic.toString(16)}`);
    }

    const version = buffer.readUInt32LE(4);
    const length = buffer.readUInt32LE(8);

    let offset = 12;
    let json: any = null;
    let bin: Buffer = Buffer.alloc(0);

    while (offset < length) {
      const chunkLength = buffer.readUInt32LE(offset);
      const chunkType = buffer.readUInt32LE(offset + 4);
      const chunkData = buffer.subarray(offset + 8, offset + 8 + chunkLength);

      if (chunkType === 0x4e4f534a) { // JSON
        json = JSON.parse(chunkData.toString('utf8'));
      } else if (chunkType === 0x004e4942) { // BIN
        bin = Buffer.from(chunkData);
      }

      offset += 8 + chunkLength;
    }

    if (!json) throw new Error('GLB missing JSON chunk');
    return { json, bin };
  }

  /**
   * Re-serializes a GLB with per-image rewrites applied: replacement bytes for source images, and new
   * normal / metallicRoughness / occlusion textures attached to every material whose baseColor samples a
   * rewritten image (only into empty slots; authored maps are kept). New textures reuse the baseColor's
   * sampler, texCoord and KHR_texture_transform. KHR_materials_unlit is dropped from materials that gain a
   * map, since unlit shading would ignore it. With rewrites the binary chunk is rebuilt compactly.
   */
  public static rebuildGlbWithTextures(
    glb: { json: any; bin: Buffer },
    rewrites: Map<number, GlbImageRewrite>,
    tilingOpts?: { enableMicroDetailTiling?: boolean; microDetailScale?: number },
    khrOpts?: KhrMaterialsConfig
  ): { buffer: Buffer; injectedExtensions: string[]; attachments: MaterialMapAttachments } {
    const injectedExtensions: string[] = [];
    const attachments: MaterialMapAttachments = { normalTextures: 0, metallicRoughnessTextures: 0, occlusionTextures: 0, unlitRemoved: 0 };
    if (rewrites.size === 0 && !tilingOpts?.enableMicroDetailTiling && !khrOpts?.enableKhrMaterialsExtensions) {
      return { buffer: this.serializeGlb(glb.json, glb.bin), injectedExtensions, attachments };
    }

    const newJson = JSON.parse(JSON.stringify(glb.json));
    let currentBin = glb.bin;

    // Images appended by this rebuild, keyed by their PNG buffer (an ORM PNG backs two slots but is stored once).
    const addedImages = new Map<Buffer, number>();
    if (rewrites.size > 0) {
      if (newJson.buffers?.[0]?.uri !== undefined) {
        throw new Error('AlgorithmicUvEngine: GLB buffer 0 is an external uri; only GLBs with an embedded binary chunk can be rewritten');
      }
      newJson.images = newJson.images || [];
      newJson.textures = newJson.textures || [];
      const addedTextures = new Map<string, number>();
      const textureFor = (png: Buffer, sampler: number | undefined): number => {
        let imageIndex = addedImages.get(png);
        if (imageIndex === undefined) {
          imageIndex = newJson.images.push({ mimeType: 'image/png' }) - 1;
          addedImages.set(png, imageIndex);
        }
        const key = `${imageIndex}:${sampler ?? ''}`;
        let textureIndex = addedTextures.get(key);
        if (textureIndex === undefined) {
          textureIndex = newJson.textures.push(sampler !== undefined ? { sampler, source: imageIndex } : { source: imageIndex }) - 1;
          addedTextures.set(key, textureIndex);
        }
        return textureIndex;
      };

      for (const mat of newJson.materials || []) {
        const baseInfo = mat.pbrMetallicRoughness?.baseColorTexture;
        if (!baseInfo || baseInfo.index === undefined) continue;
        const baseTex = newJson.textures[baseInfo.index];
        const rewrite = baseTex?.source !== undefined ? rewrites.get(baseTex.source) : undefined;
        if (!rewrite) continue;

        const textureRef = (png: Buffer): any => {
          const ref: any = { index: textureFor(png, baseTex.sampler) };
          if (baseInfo.texCoord !== undefined) ref.texCoord = baseInfo.texCoord;
          if (baseInfo.extensions?.KHR_texture_transform) {
            ref.extensions = { KHR_texture_transform: JSON.parse(JSON.stringify(baseInfo.extensions.KHR_texture_transform)) };
          }
          return ref;
        };

        let attached = false;
        if (rewrite.normalPng && !mat.normalTexture) {
          mat.normalTexture = textureRef(rewrite.normalPng);
          attachments.normalTextures++;
          attached = true;
        }
        if (rewrite.metallicRoughnessPng && !mat.pbrMetallicRoughness.metallicRoughnessTexture) {
          // The texture holds absolute roughness (G) and metalness (B), so the factors must not scale it.
          mat.pbrMetallicRoughness.metallicRoughnessTexture = textureRef(rewrite.metallicRoughnessPng);
          mat.pbrMetallicRoughness.roughnessFactor = 1.0;
          mat.pbrMetallicRoughness.metallicFactor = 1.0;
          attachments.metallicRoughnessTextures++;
          attached = true;
        }
        if (rewrite.occlusionPng && !mat.occlusionTexture) {
          mat.occlusionTexture = textureRef(rewrite.occlusionPng);
          attachments.occlusionTextures++;
          attached = true;
        }
        if (attached && mat.extensions?.KHR_materials_unlit) {
          delete mat.extensions.KHR_materials_unlit;
          if (Object.keys(mat.extensions).length === 0) delete mat.extensions;
          attachments.unlitRemoved++;
        }
      }

      if (attachments.unlitRemoved > 0 && Array.isArray(newJson.extensionsUsed)) {
        const stillUnlit = (newJson.materials || []).some((m: any) => m.extensions?.KHR_materials_unlit);
        if (!stillUnlit) {
          newJson.extensionsUsed = newJson.extensionsUsed.filter((e: string) => e !== 'KHR_materials_unlit');
          if (newJson.extensionsUsed.length === 0) delete newJson.extensionsUsed;
        }
      }
    }

    if (tilingOpts?.enableMicroDetailTiling) {
      if (!newJson.extensionsUsed) newJson.extensionsUsed = [];
      if (!newJson.extensionsUsed.includes('KHR_texture_transform')) {
        newJson.extensionsUsed.push('KHR_texture_transform');
      }
      injectedExtensions.push('KHR_texture_transform');

      const scaleVal = tilingOpts.microDetailScale ?? 32.0;
      for (const mat of newJson.materials || []) {
        const slots = [
          mat.pbrMetallicRoughness?.baseColorTexture,
          mat.pbrMetallicRoughness?.metallicRoughnessTexture,
          mat.normalTexture,
          mat.occlusionTexture
        ];
        for (const slot of slots) {
          if (slot) {
            slot.extensions = {
              KHR_texture_transform: {
                scale: [scaleVal, scaleVal]
              }
            };
          }
        }
      }
    }

    if (khrOpts?.enableKhrMaterialsExtensions) {
      if (!newJson.extensionsUsed) newJson.extensionsUsed = [];
      // Strip KHR_materials_unlit so modern WebGL/PBR engines evaluate directional sun and PBR maps
      newJson.extensionsUsed = newJson.extensionsUsed.filter((e: string) => e !== 'KHR_materials_unlit');
      for (const mat of newJson.materials || []) {
        if (mat.extensions && mat.extensions.KHR_materials_unlit) {
          delete mat.extensions.KHR_materials_unlit;
        }
      }

      const addExt = (name: string) => {
        if (!newJson.extensionsUsed.includes(name)) {
          newJson.extensionsUsed.push(name);
        }
        if (!injectedExtensions.includes(name)) {
          injectedExtensions.push(name);
        }
      };

      const enableTrans = khrOpts.enableTransmission !== false;
      const enableAniso = khrOpts.enableAnisotropy !== false;
      const enableClear = khrOpts.enableClearcoat !== false;

      if (enableTrans) {
        addExt('KHR_materials_transmission');
        addExt('KHR_materials_ior');
      }
      if (enableAniso) {
        addExt('KHR_materials_anisotropy');
      }
      if (enableClear) {
        addExt('KHR_materials_clearcoat');
      }

      for (const mat of newJson.materials || []) {
        if (!mat.extensions) mat.extensions = {};

        const name = (mat.name || '').toLowerCase();
        const rough = mat.pbrMetallicRoughness?.roughnessFactor ?? 0.5;
        const metal = mat.pbrMetallicRoughness?.metallicFactor ?? 0.0;

        const isGlass = name.includes('glass') || name.includes('window') || name.includes('glaz') ||
          (rough < 0.25 && metal < 0.15);
        const isMetalSpire = name.includes('metal') || name.includes('spire') || name.includes('steel') ||
          name.includes('mast') || (metal > 0.5);

        if (enableTrans && isGlass) {
          mat.extensions.KHR_materials_transmission = {
            transmissionFactor: khrOpts.transmissionFactor ?? 0.92
          };
          mat.extensions.KHR_materials_ior = {
            ior: khrOpts.ior ?? 1.52
          };
        }

        if (enableAniso && (isMetalSpire || !isGlass)) {
          mat.extensions.KHR_materials_anisotropy = {
            anisotropyStrength: khrOpts.anisotropyStrength ?? 0.85,
            anisotropyRotation: 1.5707963 // aligned to architectural vertical axis
          };
        }

        if (enableClear) {
          mat.extensions.KHR_materials_clearcoat = {
            clearcoatFactor: khrOpts.clearcoatFactor ?? 0.85,
            clearcoatRoughnessFactor: 0.05
          };
        }
      }
    }

    if (rewrites.size > 0) {
      // Rebuild buffer 0: every bufferView is copied to a 4-byte aligned offset (replaced images take their
      // new bytes), then the added PNGs are appended as new bufferViews.
      const views: any[] = newJson.bufferViews = newJson.bufferViews || [];
      const viewReplacements = new Map<number, Buffer>();
      for (const [imageIndex, rewrite] of rewrites) {
        const imgDef = newJson.images[imageIndex];
        if (!rewrite.replacement || imgDef?.bufferView === undefined) continue;
        viewReplacements.set(imgDef.bufferView, rewrite.replacement.data);
        imgDef.mimeType = rewrite.replacement.mimeType;
      }

      const chunks: Buffer[] = [];
      let length = 0;
      const place = (data: Buffer): number => {
        const pad = (4 - (length % 4)) % 4;
        if (pad) {
          chunks.push(Buffer.alloc(pad));
          length += pad;
        }
        const offset = length;
        chunks.push(data);
        length += data.length;
        return offset;
      };

      for (let v = 0; v < views.length; v++) {
        const bv = views[v];
        if ((bv.buffer ?? 0) !== 0) continue;
        const start = bv.byteOffset || 0;
        const data = viewReplacements.get(v) ?? glb.bin.subarray(start, start + bv.byteLength);
        bv.byteOffset = place(data);
        bv.byteLength = data.length;
      }
      for (const [png, imageIndex] of addedImages) {
        const byteOffset = place(png);
        newJson.images[imageIndex].bufferView = views.push({ buffer: 0, byteOffset, byteLength: png.length }) - 1;
      }

      currentBin = Buffer.concat(chunks, length);
      if (!newJson.buffers || newJson.buffers.length === 0) newJson.buffers = [{ byteLength: 0 }];
      newJson.buffers[0].byteLength = currentBin.length;
    }

    return { buffer: this.serializeGlb(newJson, currentBin), injectedExtensions, attachments };
  }

  public static serializeGlb(json: any, bin: Buffer): Buffer {
    const jsonStr = JSON.stringify(json);
    const jsonBuffer = Buffer.from(jsonStr, 'utf8');
    const jsonPadding = (4 - (jsonBuffer.length % 4)) % 4;
    const jsonPaddedLength = jsonBuffer.length + jsonPadding;

    const binPadding = (4 - (bin.length % 4)) % 4;
    const binPaddedLength = bin.length + binPadding;

    const totalLength = 12 + 8 + jsonPaddedLength + 8 + binPaddedLength;
    const out = Buffer.alloc(totalLength);

    // Header
    out.writeUInt32LE(0x46546c67, 0); // glTF
    out.writeUInt32LE(2, 4);          // version 2
    out.writeUInt32LE(totalLength, 8);

    // JSON Chunk
    let offset = 12;
    out.writeUInt32LE(jsonPaddedLength, offset);
    out.writeUInt32LE(0x4e4f534a, offset + 4); // JSON
    jsonBuffer.copy(out, offset + 8);
    for (let i = 0; i < jsonPadding; i++) {
      out.writeUInt8(0x20, offset + 8 + jsonBuffer.length + i); // space padding
    }

    // BIN Chunk
    offset += 8 + jsonPaddedLength;
    out.writeUInt32LE(binPaddedLength, offset);
    out.writeUInt32LE(0x004e4942, offset + 4); // BIN
    bin.copy(out, offset + 8);
    for (let i = 0; i < binPadding; i++) {
      out.writeUInt8(0x00, offset + 8 + bin.length + i); // null padding
    }

    return out;
  }
}
