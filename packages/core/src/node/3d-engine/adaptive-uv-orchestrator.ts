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
import { enumerateSceneTriangles, parseGlb, readSceneGeometry, type GlbDocument, type SkippedScenePrimitive } from './glb-geometry-patcher';

export type { PartMaterialAssignment } from './adaptive-box-projection-pbr';

export type AdaptiveUvStrategy =
  | 'auto'
  | 'carrier_conformal_sheet'
  | 'elevation_stratified_conformal'
  | 'height_blended_triplanar'
  | 'recipe_hybrid';

export type TextureDomain = 'organic' | 'nonorganic' | (string & {});

/**
 * What `probeTopology` measured, and which strategy its routing rule picks from those measurements. Every number is
 * measured from the GLB; the classification and the recommendation are the outcome of the threshold rules named in
 * `routingRule`, not of any shape analysis. There is no confidence score because nothing estimates one.
 */
export interface TopologyProbeResult {
  /** 'organic' when the caller said so or the elongated-untextured rule fired; otherwise 'nonorganic'. */
  domainClassification: 'organic' | 'nonorganic';
  /** Whether `domainClassification` came from the caller's `domain` or from the routing rules. */
  domainSource: 'caller' | 'routing_rule';
  /** glTF meshes, their primitives, and the rendered triangle-primitive instances (a mesh used by two nodes counts twice). */
  submeshCount: number;
  primitiveCount: number;
  renderedInstances: number;
  /** Vertices and triangles of the rendered triangle primitives (instanced meshes counted per instance). */
  vertexCount: number;
  triangleCount: number;
  /** Primitives left out of the counts because they are not triangle lists (lines, points, strips, fans) or have no readable POSITION. */
  skippedPrimitives: number;
  imageCount: number;
  hasPrebakedTextures: boolean;
  /** Primitives whose material samples a baseColorTexture. */
  texturedPrimitives: number;
  bounds: {
    min: [number, number, number];
    max: [number, number, number];
    dimensions: [number, number, number];
  };
  /**
   * 'world': node transforms applied to every vertex. 'accessor_local': POSITION accessor min/max without node transforms
   * (positions were not readable float32). 'mesh_local_unplaced': no node places any mesh, so each mesh was measured once
   * at its own coordinates. 'none': no triangle geometry with positions was found (bounds are zero).
   */
  boundsSpace: 'world' | 'accessor_local' | 'mesh_local_unplaced' | 'none';
  /** Dimensions divided by the larger horizontal (X / Z) extent. */
  aspectRatio: [number, number, number];
  /** Outcome of each routing rule on the measured values. */
  rules: {
    /** height >= 35 m and height / larger horizontal extent >= 1.5 */
    tallSlender: boolean;
    /** >= 10 meshes, embedded images, and not tallSlender */
    manyTexturedMeshes: boolean;
    /** height / smaller horizontal extent >= 3, no embedded images, and not tallSlender */
    elongatedUntextured: boolean;
  };
  recommendedStrategy: Exclude<AdaptiveUvStrategy, 'auto'>;
  /** The rule that picked `recommendedStrategy`, with the measured values it compared. */
  routingRule: string;
  /** What `applyAdaptivePbr` runs for `recommendedStrategy`, and what that does about UV seams. */
  methodThatRuns: string;
  seams: string;
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

export class AdaptiveUvOrchestrator {
  /**
   * Measures the mesh (counts, world bounds, embedded textures) and applies the routing rules to pick a strategy.
   * Only measured quantities are reported; the classification is the rule outcome and says which rule fired.
   */
  public static probeTopology(input: string | Buffer, userDomain?: TextureDomain): TopologyProbeResult {
    const rawBuffer = typeof input === 'string' ? fs.readFileSync(input) : input;
    let doc: GlbDocument;
    try {
      doc = parseGlb(rawBuffer);
    } catch (err) {
      throw new AdaptivePbrInputError(`Cannot read the GLB to probe it: ${(err as Error).message}`);
    }
    const json = doc.json;
    const meshes = json.meshes ?? [];
    const materials = (json.materials ?? []) as Array<{ pbrMetallicRoughness?: { baseColorTexture?: unknown } }>;
    const primitiveCount = meshes.reduce((n, m) => n + (m.primitives?.length ?? 0), 0);
    const texturedPrimitives = meshes.reduce((n, m) => n + (m.primitives ?? []).filter(p => p.material !== undefined && !!materials[p.material]?.pbrMetallicRoughness?.baseColorTexture).length, 0);
    const imageCount = (json.images ?? []).length;
    let skipped: SkippedScenePrimitive[] = [];
    let layout = enumerateSceneTriangles(doc, skipped);
    let meshesPlacedByNodes = true;
    if (layout.instances.length === 0 && meshes.length > 0 && !(json.nodes ?? []).some(n => n.mesh !== undefined)) {
      // No node places any mesh, so the scene renders nothing; measure each mesh once at its own coordinates instead
      meshesPlacedByNodes = false;
      const placed: GlbDocument = { ...doc, json: { ...json, nodes: meshes.map((_, i) => ({ mesh: i })), scenes: [{ nodes: meshes.map((_, i) => i) }], scene: 0 } };
      skipped = [];
      layout = enumerateSceneTriangles(placed, skipped);
      doc = placed;
    }

    let min: [number, number, number] = [Infinity, Infinity, Infinity];
    let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let boundsSpace: TopologyProbeResult['boundsSpace'] = 'world';
    try {
      const { positions } = readSceneGeometry(doc, layout);
      for (let i = 0; i < positions.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const v = positions[i + k];
          if (v < min[k]) min[k] = v;
          if (v > max[k]) max[k] = v;
        }
      }
    } catch {
      boundsSpace = 'accessor_local';
      const accessors = (json.accessors ?? []) as Array<{ min?: number[]; max?: number[] }>;
      for (const inst of layout.instances) {
        const acc = accessors[inst.positionAccessor];
        if (!acc?.min || !acc?.max) continue;
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k], acc.min[k]);
          max[k] = Math.max(max[k], acc.max[k]);
        }
      }
    }
    if (!Number.isFinite(min[0])) {
      // Nothing measurable; the method that runs reports what exactly is missing
      boundsSpace = 'none';
      min = [0, 0, 0];
      max = [0, 0, 0];
    } else if (!meshesPlacedByNodes && boundsSpace === 'world') {
      boundsSpace = 'mesh_local_unplaced';
    }

    const dims: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const [dimX, dimY, dimZ] = dims;
    const maxHoriz = Math.max(dimX, dimZ, 1e-9);
    const minHoriz = Math.max(Math.min(dimX, dimZ), 1e-9);
    const hasPrebakedTextures = imageCount > 0;
    const heightOverMaxHoriz = dimY / maxHoriz;
    const heightOverMinHoriz = dimY / minHoriz;

    const tallSlender = dimY >= 35.0 && heightOverMaxHoriz >= 1.5;
    const manyTexturedMeshes = meshes.length >= 10 && hasPrebakedTextures && !tallSlender;
    const elongatedUntextured = heightOverMinHoriz >= 3.0 && !tallSlender && !hasPrebakedTextures;

    const domainSource: TopologyProbeResult['domainSource'] = userDomain === 'organic' || userDomain === 'nonorganic' ? 'caller' : 'routing_rule';
    const domainClassification: 'organic' | 'nonorganic' = userDomain === 'organic' || (userDomain !== 'nonorganic' && elongatedUntextured) ? 'organic' : 'nonorganic';

    const m = (v: number) => v.toPrecision(4);
    let recommendedStrategy: Exclude<AdaptiveUvStrategy, 'auto'>;
    let routingRule: string;
    if (domainClassification === 'organic') {
      recommendedStrategy = 'carrier_conformal_sheet';
      routingRule = domainSource === 'caller'
        ? `domain 'organic' given by the caller -> carrier_conformal_sheet`
        : `height / smaller horizontal extent = ${m(heightOverMinHoriz)} >= 3, no embedded images, not tall-slender -> organic -> carrier_conformal_sheet`;
    } else if (manyTexturedMeshes) {
      recommendedStrategy = 'recipe_hybrid';
      routingRule = `${meshes.length} meshes >= 10 with ${imageCount} embedded image(s), not tall-slender -> recipe_hybrid`;
    } else if (tallSlender) {
      recommendedStrategy = 'elevation_stratified_conformal';
      routingRule = `height ${m(dimY)} m >= 35 and height / larger horizontal extent = ${m(heightOverMaxHoriz)} >= 1.5 -> elevation_stratified_conformal`;
    } else {
      recommendedStrategy = 'height_blended_triplanar';
      routingRule = `no other rule fired (height ${m(dimY)} m, height / larger horizontal ${m(heightOverMaxHoriz)}, height / smaller horizontal ${m(heightOverMinHoriz)}, ${meshes.length} meshes, ${imageCount} images) -> height_blended_triplanar`;
    }
    const { methodThatRuns, seams } = AdaptiveUvOrchestrator.describeMethod(recommendedStrategy);

    return {
      domainClassification,
      domainSource,
      submeshCount: meshes.length,
      primitiveCount,
      renderedInstances: layout.instances.length,
      vertexCount: layout.vertexCount,
      triangleCount: layout.triangleCount,
      skippedPrimitives: skipped.length,
      imageCount,
      hasPrebakedTextures,
      texturedPrimitives,
      bounds: { min, max, dimensions: dims },
      boundsSpace,
      aspectRatio: [dimX / maxHoriz, dimY / maxHoriz, dimZ / maxHoriz],
      rules: { tallSlender, manyTexturedMeshes, elongatedUntextured },
      recommendedStrategy,
      routingRule,
      methodThatRuns,
      seams,
      rationale: `${boundsSpace === 'none' ? 'No triangle geometry with readable positions was found. ' : ''}Measured ${layout.triangleCount} triangles in ${layout.instances.length} rendered primitive instance(s), ${boundsSpace} extent ${dims.map(m).join(' x ')}. Rule: ${routingRule}. It runs ${methodThatRuns}.`
    };
  }

  /** What applyAdaptivePbr really runs for a strategy, and its effect on UV seams. */
  public static describeMethod(strategy: Exclude<AdaptiveUvStrategy, 'auto'>): { methodThatRuns: string; seams: string } {
    switch (strategy) {
      case 'recipe_hybrid':
        return { methodThatRuns: 'recipe_hybrid_vertex_attributes (per-vertex recipe attributes over the mesh\'s own UVs and textures)', seams: 'Unchanged: the mesh keeps its own UVs, so its seams are those of its existing atlas.' };
      case 'elevation_stratified_conformal':
        return { methodThatRuns: 'algorithmic_uv_engine_pbr_decomposition (the embedded baseColor images are decomposed into albedo / normal / ORM)', seams: 'Unchanged: the decomposed maps follow the mesh\'s existing UVs and atlas.' };
      default:
        return { methodThatRuns: 'box_projection_uv (per-triangle dominant-axis box projection onto synthesized, REPEAT-sampled textures; the named triplanar / conformal technique is not implemented)', seams: 'A UV seam wherever adjacent triangles project on different axes (vertices are split there); no gutter padding, since repeating textures have no islands.' };
    }
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
      this.rejectMaterialChoicesThisMethodCannotHonor(request, 'recipe_hybrid');
      noteIgnored('solarDelighting', 'carrierSpinePoints', 'carrierReferenceNormal', 'resolution', 'resolutionPx', 'gutterPaddingPx');
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
      this.rejectMaterialChoicesThisMethodCannotHonor(request, 'elevation_stratified_conformal');
      noteIgnored('carrierSpinePoints', 'carrierReferenceNormal', 'resolution', 'resolutionPx', 'gutterPaddingPx', 'recipeOutputMode');
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
      glbBuffer: finalGlbBuffer,
      materialxXml,
      usdzBuffer,
      outputFiles,
      executionTimeMs: Date.now() - t0,
      algorithmicUv
    };
  }

  /**
   * Which material goes where is chosen by these fields; only the box-projection method synthesizes a material and places
   * it. A method that works from the asset's own images or geometry cannot honour them, and says so instead of ignoring them.
   */
  private static rejectMaterialChoicesThisMethodCannotHonor(request: AdaptivePbrRequest, strategy: string): void {
    const choices: Array<keyof AdaptivePbrRequest> = ['partMaterials', 'materialArchetype', 'continuousDescriptor', 'tileSizeMeters', 'preserveExistingUvs', 'preserveVertexColors'];
    const given = choices.filter(name => {
      const v = request[name];
      return v !== undefined && v !== null && v !== false && !(Array.isArray(v) && v.length === 0);
    });
    if (given.length) {
      throw new AdaptivePbrInputError(
        `${given.join(', ')} choose the material or how it is mapped; strategy '${strategy}' works from the asset's own images or geometry and does not synthesize or place a material, so it cannot honour them. Use strategy 'height_blended_triplanar' or 'carrier_conformal_sheet' to texture this mesh with a synthesized material (it replaces the mesh's current textures).`,
        { given, strategy }
      );
    }
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
