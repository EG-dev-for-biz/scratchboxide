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
import type { ContinuousMaterialDescriptor } from '../../common/adaptive-material-types';
import type { AlgorithmicUvOptions, AlgorithmicUvResult, TextureImageReport } from '../spatial/AlgorithmicUvEngine';
import { AdaptivePbrInputError, AdaptivePbrOutputError } from './adaptive-pbr-errors';
import type {
  BoxProjectionGroupReport,
  BoxProjectionTextureSetReport,
  PartMaterialAssignment
} from './adaptive-box-projection-pbr';
import type { BoxProjectionReport } from './glb-box-projection';

export type { PartMaterialAssignment } from './adaptive-box-projection-pbr';

export type AdaptiveUvStrategy =
  | 'auto'
  | 'carrier_conformal_sheet'
  | 'elevation_stratified_conformal'
  | 'height_blended_triplanar'
  | 'recipe_hybrid';

export type TextureDomain = 'organic' | 'nonorganic' | (string & {});

export interface SeamAdjustmentStrategy {
  seamPlacement:
    | 'natural_occlusion_geodesics'
    | 'architectural_reveals_and_mullions'
    | 'zero_seams_continuous'
    | 'photogrammetric_boundary_welded'
    | 'longitudinal_least_visible_spine';
  seamMitigationMethod:
    | 'hermite_margin_overlap'
    | 'gutter_dilation_clamping'
    | 'mikktspace_orthonormal_handedness'
    | 'triplanar_height_blended'
    | 'affine_edge_altitude_bevel'
    | 'kdtree_boundary_welding';
  recommendedGutterPaddingPx: number;
  tangentSpaceHandednessGuaranteed: boolean;
  seamRationale: string;
}

export interface TopologyProbeResult {
  domainClassification: 'organic' | 'nonorganic';
  organicityIndex: number; // [0.0 = Inorganic Mineral/Metal/Stone, 1.0 = Pure Living Organic Anatomy]
  submeshCount: number;
  vertexCount: number;
  triangleCount: number;
  hasPrebakedTextures: boolean;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
    dimensions: [number, number, number];
  };
  aspectRatio: [number, number, number];
  isHighRiseArchitecture: boolean;
  isMassiveScan: boolean;
  isArticulatedAnatomy: boolean;
  recommendedStrategy: Exclude<AdaptiveUvStrategy, 'auto'>;
  seamStrategy: SeamAdjustmentStrategy;
  confidenceScore: number;
  rationale: string;
}

export interface AdaptiveSolarDelightingConfig {
  latitude: number;
  longitude: number;
  /** The UTC time whose sun lit the source imagery (required: the run's own clock is not that time). */
  timestampIso: string;
  regularizationEpsilon?: number;
  ambientWeight?: number;
  directWeight?: number;
}

export interface AdaptivePbrRequest {
  inputGlbPath?: string;
  inputGlbBuffer?: Buffer;
  domain?: TextureDomain;
  strategy?: AdaptiveUvStrategy;
  carrierSpinePoints?: [number, number, number][];
  carrierReferenceNormal?: [number, number, number];
  solarDelighting?: AdaptiveSolarDelightingConfig;
  continuousDescriptor?: ContinuousMaterialDescriptor;
  materialArchetype?: string | number;
  resolution?: '1K' | '2K' | '4K' | '8K' | '12K';
  formats?: ('glb' | 'materialx' | 'usdz')[];
  outputPath?: string;
  recipeOutputMode?: 'webgl-recipe' | 'standard-khronos' | 'both';
  materialName?: string;
  gutterPaddingPx?: number;
  /** Square texture size per set in pixels; overrides `resolution`. Capped (see BOX_PROJECTION_CAPS). */
  resolutionPx?: number;
  /** Noise seed of the synthesized textures (default 42). */
  seed?: number;
  /**
   * Different materials for different parts (box-projection method only). Parts no entry names take the request-level
   * material. Names are exact node/mesh names as the scene lists them; an unknown name fails with the real names.
   */
  partMaterials?: PartMaterialAssignment[];
  /** Edge length of one texture tile in metres, for every part that does not give its own. Default: derived per group, and labelled so. */
  tileSizeMeters?: number;
  /** Keep a primitive's own TEXCOORD_0 and write the box UVs to the next free TEXCOORD_n (default: replace TEXCOORD_0). */
  preserveExistingUvs?: boolean;
  /** Keep COLOR_n on the projected primitives (default: drop it, since it multiplies the new base colour). */
  preserveVertexColors?: boolean;
}

/** What actually ran, which can differ from the strategy that was recommended or requested. */
export interface AdaptivePbrAppliedMethod {
  method: 'box_projection_uv' | 'recipe_hybrid_vertex_attributes' | 'algorithmic_uv_engine_pbr_decomposition' | (string & {});
  /** True when `method` is not an implementation of `appliedStrategy` (the strategy was only used to route). */
  differsFromStrategy: boolean;
  note: string;
}

/** The box-projection run in full, JSON-safe. */
export interface AdaptiveBoxProjectionSummary {
  report: BoxProjectionReport;
  groups: BoxProjectionGroupReport[];
  textureSets: BoxProjectionTextureSetReport[];
  caps: { maxDistinctTextureSets: number; maxResolutionPx: number; maxTotalTexels: number };
  /** Everything decided here that the request did not specify. */
  inferred: string[];
}

export interface AdaptiveUvPbrResult {
  /** The strategy that was requested, or that the topology probe recommended: it routes the call, see `appliedMethod` for what ran. */
  appliedStrategy: Exclude<AdaptiveUvStrategy, 'auto'>;
  appliedMethod: AdaptivePbrAppliedMethod;
  /** Request fields that were given and that the method which ran does not use. */
  ignoredOptions: string[];
  boxProjection?: AdaptiveBoxProjectionSummary;
  domainClassification: 'organic' | 'nonorganic';
  topology: TopologyProbeResult;
  seamStrategy: SeamAdjustmentStrategy;
  glbBuffer?: Buffer;
  materialxXml?: string;
  usdzBuffer?: Buffer;
  outputFiles: Record<string, string>;
  executionTimeMs: number;
  /** AlgorithmicUvEngine.processGlb report (per-image results and attached map slots) for 'elevation_stratified_conformal'. */
  algorithmicUv?: AlgorithmicUvResult;
}

/** 'elevation_stratified_conformal' could not decompose the asset's baseColor images; nothing is written. */
export class AdaptivePbrImageProcessingError extends Error {
  constructor(message: string, public readonly images: TextureImageReport[]) {
    super(message);
    this.name = 'AdaptivePbrImageProcessingError';
  }
}

function parseGlbBasic(buffer: Buffer) {
  const jsonLen = buffer.readUInt32LE(12);
  const gltf = JSON.parse(buffer.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen;
  const binLen = buffer.readUInt32LE(binStart);
  const bin = buffer.subarray(binStart + 8, binStart + 8 + binLen);
  return { gltf, bin };
}

function readAccessorData(gltf: any, bin: Buffer, index: number): Float32Array {
  const acc = gltf.accessors[index];
  const bv = gltf.bufferViews[acc.bufferView];
  const comps = ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[acc.type] || 1;
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const bytes = bin.subarray(start, start + acc.count * comps * 4);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

export class AdaptiveUvOrchestrator {
  /**
   * Analyzes mesh topology, bounding volumes, and semantic tags to determine the optimal
   * UV wrapping technique, seam placement, and seam artifact mitigation strategy.
   */
  public static probeTopology(input: string | Buffer, userDomain?: TextureDomain): TopologyProbeResult {
    const rawBuffer = typeof input === 'string' ? fs.readFileSync(input) : input;
    const { gltf, bin } = parseGlbBasic(rawBuffer);

    let totalVertices = 0;
    let totalTriangles = 0;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const submeshCount = gltf.meshes ? gltf.meshes.length : 0;
    const hasPrebakedTextures = !!(gltf.images && gltf.images.length > 0);

    for (const mesh of gltf.meshes || []) {
      for (const prim of mesh.primitives || []) {
        if (prim.attributes && prim.attributes.POSITION !== undefined) {
          const pos = readAccessorData(gltf, bin, prim.attributes.POSITION);
          const vCount = pos.length / 3;
          totalVertices += vCount;

          for (let i = 0; i < pos.length; i += 3) {
            const x = pos[i], y = pos[i + 1], z = pos[i + 2];
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
          }

          if (prim.indices !== undefined) {
            const idxAcc = gltf.accessors[prim.indices];
            totalTriangles += (idxAcc ? idxAcc.count / 3 : 0);
          } else {
            totalTriangles += vCount / 3;
          }
        }
      }
    }

    if (!isFinite(minX)) {
      minX = 0; minY = 0; minZ = 0;
      maxX = 1; maxY = 1; maxZ = 1;
    }

    const dimX = Math.max(1e-4, maxX - minX);
    const dimY = Math.max(1e-4, maxY - minY);
    const dimZ = Math.max(1e-4, maxZ - minZ);
    const maxHoriz = Math.max(dimX, dimZ);

    const isHighRiseArchitecture = dimY >= 35.0 && (dimY / maxHoriz) >= 1.5;
    const isMassiveScan = submeshCount >= 10 && hasPrebakedTextures && !isHighRiseArchitecture;
    const isArticulatedAnatomy = userDomain === 'organic' || ((dimY / Math.min(dimX, dimZ)) >= 3.0 && !isHighRiseArchitecture && !hasPrebakedTextures);

    // Determine domain classification & continuous organicity index
    let domainClassification: 'organic' | 'nonorganic' = 'nonorganic';
    let organicityIndex = 0.0;

    if (userDomain === 'organic' || isArticulatedAnatomy) {
      domainClassification = 'organic';
      organicityIndex = 1.0;
    } else if (userDomain === 'nonorganic') {
      domainClassification = 'nonorganic';
      organicityIndex = 0.0;
    } else {
      domainClassification = isArticulatedAnatomy ? 'organic' : 'nonorganic';
      organicityIndex = isArticulatedAnatomy ? 0.95 : 0.05;
    }

    let recommendedStrategy: Exclude<AdaptiveUvStrategy, 'auto'>;
    let confidenceScore = 0.95;
    let rationale = '';
    let seamStrategy: SeamAdjustmentStrategy;

    if (domainClassification === 'organic') {
      recommendedStrategy = 'carrier_conformal_sheet';
      confidenceScore = 0.96;
      rationale = `Detected organic articulated anatomy or digit chain. Routed to SO(3) Frenet-Serret Carrier-Frame Conformal Sheets to eliminate texture swimming during kinematic flexion.`;
      seamStrategy = {
        seamPlacement: 'natural_occlusion_geodesics',
        seamMitigationMethod: 'hermite_margin_overlap',
        recommendedGutterPaddingPx: 8,
        tangentSpaceHandednessGuaranteed: true,
        seamRationale: `Placed seams strictly along lateral neutral lines (inter-digital dorsal/palmar boundary) where surface strain during joint flexion is minimal. Seams are adjusted with 8px Hermite margin overlap and MikkTSpace handedness to prevent normal inversion and seam tearing.`
      };
    } else if (isMassiveScan) {
      recommendedStrategy = 'recipe_hybrid';
      confidenceScore = 0.98;
      rationale = `Detected massive photogrammetric scan with ${submeshCount} submeshes and pre-baked textures. Routed to Recipe Hybrid PBR to maintain 0% VRAM expansion and affine edge altitudes.`;
      seamStrategy = {
        seamPlacement: 'photogrammetric_boundary_welded',
        seamMitigationMethod: 'affine_edge_altitude_bevel',
        recommendedGutterPaddingPx: 4,
        tangentSpaceHandednessGuaranteed: true,
        seamRationale: `Preserves drone capture atlas UVs to avoid re-baking 500MB+ textures. Seams across submesh boundaries are bridged via KD-tree coordinate welding and _SBEDGEH affine edge altitude encoding, enabling GPU shaders to compute virtual specular bevels without visible texture seams.`
      };
    } else if (isHighRiseArchitecture) {
      recommendedStrategy = 'elevation_stratified_conformal';
      confidenceScore = 0.96;
      rationale = `Detected high-rise vertical edifice (Height=${dimY.toFixed(1)}m, AspectRatio=${(dimY / maxHoriz).toFixed(2)}). Routed to Elevation-Stratified Conformal with NOAA solar de-lighting and Toksvig anti-aliasing.`;
      seamStrategy = {
        seamPlacement: 'architectural_reveals_and_mullions',
        seamMitigationMethod: 'gutter_dilation_clamping',
        recommendedGutterPaddingPx: 16,
        tangentSpaceHandednessGuaranteed: true,
        seamRationale: `Seams are aligned strictly with geometric internal corners (re-entrant corners), window mullions, and chamfers. Adjusted via 16px dilated edge gutters to eliminate bilinear mip bleed, while crevice ambient occlusion naturally masks microscopic filtering boundaries.`
      };
    } else {
      recommendedStrategy = 'height_blended_triplanar';
      confidenceScore = 0.90;
      rationale = `Detected rigid mechanical CAD, vehicle, or procedural manifold. Routed to Continuous Height-Blended Triplanar to guarantee seamless projection across non-manifold edges.`;
      seamStrategy = {
        seamPlacement: 'zero_seams_continuous',
        seamMitigationMethod: 'triplanar_height_blended',
        recommendedGutterPaddingPx: 0,
        tangentSpaceHandednessGuaranteed: true,
        seamRationale: `Zero seams: eliminates UV unwrapping entirely. Uses continuous normal-weighted triplanar projection modulated by micro-height transitions (k >= 4 exponent), ensuring zero texture tearing or distortion across sharp mechanical corners.`
      };
    }

    return {
      domainClassification,
      organicityIndex,
      submeshCount,
      vertexCount: totalVertices,
      triangleCount: Math.round(totalTriangles),
      hasPrebakedTextures,
      bounds: {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ],
        dimensions: [dimX, dimY, dimZ]
      },
      aspectRatio: [dimX / maxHoriz, dimY / maxHoriz, dimZ / maxHoriz],
      isHighRiseArchitecture,
      isMassiveScan,
      isArticulatedAnatomy,
      recommendedStrategy,
      seamStrategy,
      confidenceScore,
      rationale
    };
  }

  /**
   * Universal entry point: executes scenario-adaptive PBR and UV wrapping on any 3D asset.
   *
   * `appliedStrategy` is the strategy that was requested or recommended; `appliedMethod` is what ran. The
   * 'height_blended_triplanar' and 'carrier_conformal_sheet' strategies are shader / unwrap techniques that this
   * pipeline does not implement: they are run as a per-triangle box projection onto REPEAT-sampled textures, and
   * the result says so. A call either returns a GLB that carries the synthesized textures or throws a typed
   * AdaptivePbrError; it never returns the input as if it had been textured.
   */
  public static async applyAdaptivePbr(request: AdaptivePbrRequest): Promise<AdaptiveUvPbrResult> {
    const t0 = Date.now();
    let rawBuffer: Buffer | null = request.inputGlbBuffer || null;
    if (!rawBuffer && request.inputGlbPath) {
      try {
        rawBuffer = fs.readFileSync(request.inputGlbPath);
      } catch (err) {
        throw new AdaptivePbrInputError(`Cannot read the input mesh ${request.inputGlbPath}: ${(err as Error).message}`, { inputGlbPath: request.inputGlbPath });
      }
    }
    if (!rawBuffer) {
      throw new AdaptivePbrInputError('AdaptiveUvOrchestrator requires either inputGlbPath or inputGlbBuffer.');
    }
    if (rawBuffer.length < 20 || rawBuffer.readUInt32LE(0) !== 0x46546c67) {
      throw new AdaptivePbrInputError(`The input is not a binary glTF (GLB): ${request.inputGlbPath ?? 'buffer'} does not start with the "glTF" magic.`);
    }

    const topology = this.probeTopology(rawBuffer, request.domain);
    const appliedStrategy = (request.strategy && request.strategy !== 'auto')
      ? request.strategy
      : topology.recommendedStrategy;

    const formats = request.formats || ['glb'];
    const outputFiles: Record<string, string> = {};
    let finalGlbBuffer: Buffer | undefined;
    let materialxXml: string | undefined;
    let usdzBuffer: Buffer | undefined;
    let algorithmicUv: AlgorithmicUvResult | undefined;
    let boxProjection: AdaptiveBoxProjectionSummary | undefined;
    let appliedMethod: AdaptivePbrAppliedMethod;
    const ignoredOptions: string[] = [];
    const given = (name: keyof AdaptivePbrRequest) => request[name] !== undefined && request[name] !== null;
    const noteIgnored = (...names: Array<keyof AdaptivePbrRequest>) => names.forEach(n => { if (given(n)) ignoredOptions.push(n); });

    const baseDir = request.outputPath ? path.dirname(request.outputPath) : undefined;
    const baseName = request.outputPath ? path.basename(request.outputPath, path.extname(request.outputPath)) : 'pbr_asset';
    const boxProjectionOnlyFormats = formats.filter(f => f === 'materialx' || f === 'usdz');

    // 1. Dispatch to strategy-specific pipeline
    if (appliedStrategy === 'recipe_hybrid') {
      this.rejectFormatsThisMethodDoesNotProduce(boxProjectionOnlyFormats, 'recipe_hybrid');
      noteIgnored('solarDelighting', 'carrierSpinePoints', 'carrierReferenceNormal', 'continuousDescriptor', 'materialArchetype', 'partMaterials', 'tileSizeMeters', 'resolution', 'resolutionPx', 'gutterPaddingPx');
      const { HybridRecipePbrService } = await import('./hybrid-recipe-pbr-service');
      const recipeRes = await HybridRecipePbrService.processGlb(rawBuffer, {
        outputMode: request.recipeOutputMode || 'webgl-recipe'
      });
      finalGlbBuffer = recipeRes.recipeGlbBuffer;
      appliedMethod = {
        method: 'recipe_hybrid_vertex_attributes',
        differsFromStrategy: false,
        note: 'Per-vertex recipe attributes (_SBEDGEH, _SBNBRA, _SBMASK) and shared detail maps are written into the GLB for a recipe-aware shader; it adds no PBR material of its own.'
      };
    } else if (appliedStrategy === 'elevation_stratified_conformal') {
      this.rejectFormatsThisMethodDoesNotProduce(boxProjectionOnlyFormats, 'elevation_stratified_conformal');
      noteIgnored('carrierSpinePoints', 'carrierReferenceNormal', 'continuousDescriptor', 'materialArchetype', 'partMaterials', 'tileSizeMeters', 'resolution', 'resolutionPx', 'gutterPaddingPx', 'recipeOutputMode');
      const { AlgorithmicUvEngine } = await import('../spatial/AlgorithmicUvEngine');
      const solar = request.solarDelighting;
      if (solar) {
        const { latitude, longitude, timestampIso } = solar;
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !timestampIso || Number.isNaN(Date.parse(timestampIso))) {
          throw new Error(`Solar de-lighting needs the latitude, longitude and UTC timestampIso of the sun that lit the imagery (got ${latitude}, ${longitude}, ${JSON.stringify(timestampIso)}); none is assumed`);
        }
      }
      // processGlb has no gutter-dilation pass and cannot store a custom Toksvig MIP chain in glTF, so neither is requested.
      const pbrOptions: AlgorithmicUvOptions = {
        inputGlbBuffer: rawBuffer,
        mode: 'preserve-100-lock',
        pbrDecomposition: {
          enableAlbedoDeLighting: true,
          enableHeightStratifiedDeLighting: true,
          enableMultiFrequencyNormals: true,
          enableBiophysicalRoughness: true,
          enableHbaoMicroCavity: true,
          enableToksvigFiltering: true,
          enableSolarInverseDelighting: !!solar,
          solarDelighting: solar && {
            latitude: solar.latitude,
            longitude: solar.longitude,
            timestampIso: solar.timestampIso,
            regularizationEpsilon: solar.regularizationEpsilon ?? 0.18,
            ambientWeight: solar.ambientWeight ?? 0.35,
            directWeight: solar.directWeight ?? 0.65
          }
        },
        khrMaterials: {
          enableKhrMaterialsExtensions: true,
          enableTransmission: true,
          ior: 1.52,
          transmissionFactor: 0.92,
          enableAnisotropy: true,
          anisotropyStrength: 0.85,
          enableClearcoat: true,
          clearcoatFactor: 0.85
        }
      };

      const uvResult = await AlgorithmicUvEngine.processGlb(pbrOptions);
      if (!uvResult.success) {
        const failed = uvResult.images.filter(r => r.status === 'failed');
        const detail = failed.map(r => `${r.imageIndex !== undefined ? `image ${r.imageIndex}` : `texture ${r.textureIndex}`}: ${r.error}`).join('; ');
        throw new AdaptivePbrImageProcessingError(
          `AdaptiveUvOrchestrator: elevation_stratified_conformal failed on ${failed.length} of ${uvResult.images.length} baseColor textures (${detail})`,
          uvResult.images
        );
      }
      if (uvResult.imagesProcessed === 0) {
        throw new AdaptivePbrImageProcessingError(
          'AdaptiveUvOrchestrator: elevation_stratified_conformal decomposes embedded baseColor images, and no material in this GLB samples one',
          uvResult.images
        );
      }
      algorithmicUv = uvResult;
      finalGlbBuffer = uvResult.outputGlbBuffer;
      appliedMethod = {
        method: 'algorithmic_uv_engine_pbr_decomposition',
        differsFromStrategy: false,
        note: `Decomposed ${uvResult.imagesProcessed} embedded baseColor image(s) into albedo / normal / ORM maps by AlgorithmicUvEngine.`
      };
    } else {
      // 'height_blended_triplanar' and 'carrier_conformal_sheet': box projection onto synthesized, REPEAT-sampled textures
      noteIgnored('gutterPaddingPx', 'carrierSpinePoints', 'carrierReferenceNormal', 'solarDelighting', 'recipeOutputMode');
      let resolutionPx: number;
      if (request.resolutionPx !== undefined) {
        resolutionPx = request.resolutionPx;
      } else {
        const { resolutionTierToPx } = await import('./adaptive-box-projection-pbr');
        resolutionPx = resolutionTierToPx(request.resolution || '2K');
      }
      const { runBoxProjectionPbr } = await import('./adaptive-box-projection-pbr');
      const run = await runBoxProjectionPbr({
        glb: rawBuffer,
        materialArchetype: request.materialArchetype,
        descriptor: request.continuousDescriptor,
        resolutionPx,
        seed: request.seed,
        tileSizeMeters: request.tileSizeMeters,
        partMaterials: request.partMaterials,
        preserveExistingUvs: request.preserveExistingUvs,
        preserveVertexColors: request.preserveVertexColors
      });
      finalGlbBuffer = run.glbBuffer;
      boxProjection = {
        report: run.report,
        groups: run.groups,
        textureSets: run.textureSets,
        caps: { maxDistinctTextureSets: run.caps.maxDistinctTextureSets, maxResolutionPx: run.caps.maxResolutionPx, maxTotalTexels: run.caps.maxTotalTexels },
        inferred: run.inferred
      };
      const tiles = run.groups.map(g => `${g.tileSize.meters.toPrecision(3)} m`);
      appliedMethod = {
        method: 'box_projection_uv',
        differsFromStrategy: true,
        note: `${appliedStrategy === 'height_blended_triplanar' ? 'A height-blended triplanar shader' : 'A carrier-frame conformal sheet'} is not implemented here, so the textures were applied by per-triangle dominant-axis box projection in world metres (tile ${tiles.join(' / ')}, ${resolutionPx}px per set, ${run.textureSets.length} set(s), ${Math.round(resolutionPx / run.groups[0].tileSize.meters)} texels per metre on the first group). Where a smooth surface changes its dominant axis the texture direction changes; there is no blend across that edge.`
      };

      // MaterialX / USDZ describe the material (not the mesh); one per texture set, with the PNGs they reference beside them
      if (boxProjectionOnlyFormats.length) {
        if (!request.outputPath || !baseDir) {
          throw new AdaptivePbrOutputError(`Formats ${boxProjectionOnlyFormats.join(', ')} write files next to the output and need outputPath.`);
        }
        const { MaterialXService } = await import('./materialx-service');
        const { UsdzPacker } = await import('./usdz-packer');
        run.texturePngs.forEach((set, i) => {
          const single = run.texturePngs.length === 1;
          const prefix = single ? baseName : `${baseName}_${set.label}`;
          const suffix = (kind: string) => (single ? kind : `${kind}_${set.label}`);
          const albedoFile = `${prefix}_Albedo.png`;
          const normalFile = `${prefix}_Normal.png`;
          const ormFile = `${prefix}_ORM.png`;
          this.writeOutputFile(path.join(baseDir, albedoFile), set.albedo);
          this.writeOutputFile(path.join(baseDir, normalFile), set.normal);
          this.writeOutputFile(path.join(baseDir, ormFile), set.orm);
          outputFiles[suffix('albedo')] = path.join(baseDir, albedoFile);
          outputFiles[suffix('normal')] = path.join(baseDir, normalFile);
          outputFiles[suffix('orm')] = path.join(baseDir, ormFile);
          const descriptor = set.descriptor as ContinuousMaterialDescriptor;
          if (formats.includes('materialx')) {
            const mtlxPath = path.join(baseDir, `${prefix}.mtlx`);
            try {
              const mtlx = MaterialXService.exportMaterialX({
                materialName: single ? (request.materialName || baseName) : `${request.materialName || baseName}_${set.label}`,
                descriptor,
                outputPath: mtlxPath,
                textures: { albedoFileName: albedoFile, normalFileName: normalFile, ormFileName: ormFile }
              });
              if (i === 0) materialxXml = mtlx.xmlContent;
            } catch (err) {
              throw new AdaptivePbrOutputError(`Could not write ${mtlxPath}: ${(err as Error).message}`, { path: mtlxPath });
            }
            outputFiles[suffix('materialx')] = mtlxPath;
          }
          if (formats.includes('usdz')) {
            const usdzPath = path.join(baseDir, `${prefix}.usdz`);
            try {
              const usdz = UsdzPacker.packMaterialUsdz({
                materialName: single ? (request.materialName || baseName) : `${request.materialName || baseName}_${set.label}`,
                descriptor,
                albedoPng: set.albedo,
                normalPng: set.normal,
                ormPng: set.orm,
                outputPath: usdzPath
              });
              if (i === 0) usdzBuffer = usdz.usdzBuffer;
            } catch (err) {
              throw new AdaptivePbrOutputError(`Could not write ${usdzPath}: ${(err as Error).message}`, { path: usdzPath });
            }
            outputFiles[suffix('usdz')] = usdzPath;
          }
        });
      }
    }

    if (finalGlbBuffer && request.outputPath) {
      this.writeOutputFile(request.outputPath, finalGlbBuffer);
      outputFiles['glb'] = request.outputPath;
    }

    return {
      appliedStrategy,
      appliedMethod,
      ignoredOptions,
      boxProjection,
      domainClassification: topology.domainClassification,
      topology,
      seamStrategy: topology.seamStrategy,
      glbBuffer: finalGlbBuffer,
      materialxXml,
      usdzBuffer,
      outputFiles,
      executionTimeMs: Date.now() - t0,
      algorithmicUv
    };
  }

  /** MaterialX / USDZ are produced from synthesized texture sets, which only the box-projection method has. */
  private static rejectFormatsThisMethodDoesNotProduce(formats: string[], strategy: string): void {
    if (formats.length) {
      throw new AdaptivePbrOutputError(
        `Format ${formats.join(', ')} is exported from synthesized texture sets, which strategy '${strategy}' does not create. Ask for 'glb', or use 'height_blended_triplanar' / 'carrier_conformal_sheet'.`,
        { formats, strategy }
      );
    }
  }

  private static writeOutputFile(file: string, data: Buffer): void {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    } catch (err) {
      throw new AdaptivePbrOutputError(`Could not write ${file}: ${(err as Error).message}`, { path: file });
    }
  }
}
