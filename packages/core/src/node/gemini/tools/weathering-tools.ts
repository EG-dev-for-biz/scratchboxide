/*
 * Weathering Tools: Procedural aging and patina texture synthesis
 * Generates 4K weathering textures (color, normal, roughness, metallic)
 * for aged materials based on material type, age in years, climate zone, and exposure.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ToolDeclaration, ToolHandler, ToolHandlerOutcome, ToolResultPayload } from './types';
import { WeatheringService } from '../../3d-engine/weathering-service';
import { weatheringPbrIntegration } from '../../3d-engine/weathering-pbr-integration';

function asString(val: unknown): string | undefined {
  return typeof val === 'string' && val.trim().length > 0 ? val.trim() : undefined;
}

function asNumber(val: unknown): number | undefined {
  return typeof val === 'number' && !isNaN(val) ? val : undefined;
}

const weatheringService = new WeatheringService();

/**
 * Tool: weather_mesh
 * Bakes real procedural aging textures onto a target GLB's materials, optionally pitting its geometry first via
 * the native engine's stochastic relief displacement. Unlike synthesize_weathering_textures (which only writes
 * standalone map files), this reads, patches and re-exports a real .glb.
 */
async function weatherMesh(params: {
  targetMeshPath?: string;
  material?: string;
  ageYears?: number;
  climateZone?: string;
  exposureType?: string;
  resolution?: string | number;
  blendMode?: 'overlay' | 'multiply' | 'blend';
  blendFactor?: number;
  outputPath?: string;
  pitDepthFraction?: number;
  pitScaleMeters?: number;
  pitSeed?: number;
}): Promise<ToolResultPayload> {
  const targetMeshPath = asString(params.targetMeshPath);
  if (!targetMeshPath) {
    return { success: false, error: 'targetMeshPath is required; this tool patches a real GLB, it does not build a stand-in mesh' };
  }
  const material = asString(params.material) || 'cast_iron';
  const ageYears = asNumber(params.ageYears) ?? 60;
  const climateZone = asString(params.climateZone) || 'urban';
  const exposureType = asString(params.exposureType) || 'exposed';

  let width = 2048, height = 2048;
  if (typeof params.resolution === 'string') {
    const map: Record<string, number> = { '1K': 1024, '2K': 2048, '4K': 4096, '8K': 8192 };
    const norm = map[params.resolution.toUpperCase()];
    if (norm) width = height = norm;
  } else if (typeof params.resolution === 'number') {
    width = height = Math.round(params.resolution);
  }

  const pitDepthFraction = asNumber(params.pitDepthFraction);
  const pitScaleMeters = asNumber(params.pitScaleMeters);

  const result = await weatheringPbrIntegration.applyWeatheringToPbr({
    targetMeshPath,
    material,
    ageYears,
    climateZone,
    exposureType,
    textureWidth: width,
    textureHeight: height,
    blendMode: params.blendMode,
    blendFactor: asNumber(params.blendFactor),
    outputPath: asString(params.outputPath),
    pitting: pitDepthFraction !== undefined ? {
      depthFraction: pitDepthFraction,
      scaleMeters: pitScaleMeters ?? 0.02,
      seed: asNumber(params.pitSeed)
    } : undefined
  });

  return { ...result };
}

/**
 * Tool: synthesize_weathering_textures
 * Generates procedural aging textures for a material based on age and climate.
 */
async function synthesizeWeatheringTextures(params: {
  material?: string;
  ageYears?: number;
  climateZone?: string;
  exposureType?: string;
  resolution?: string | number;
  outputDir?: string;
  outputFileName?: string;
  bakeIntoMesh?: boolean;
  targetMeshPath?: string;
}): Promise<ToolResultPayload> {
  try {
    const startTime = Date.now();

    // Parse inputs
    const material = asString(params.material) || 'cast_iron';
    const ageYears = asNumber(params.ageYears) ?? 60;
    const climateZone = asString(params.climateZone) || 'urban';
    const exposureType = asString(params.exposureType) || 'exposed';
    const outputDir = asString(params.outputDir) || os.tmpdir();
    const outputFileName = asString(params.outputFileName) || `weathering_${material}_${ageYears}y`;

    // Parse resolution
    let width = 4096;
    let height = 4096;
    if (typeof params.resolution === 'string') {
      const norm = params.resolution.toUpperCase();
      const map: Record<string, number> = {
        '1K': 1024,
        '2K': 2048,
        '4K': 4096,
        '8K': 8192
      };
      if (map[norm]) {
        width = height = map[norm];
      }
    } else if (typeof params.resolution === 'number') {
      width = height = Math.round(params.resolution);
    }

    // Ensure directory exists
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Synthesize weathering textures
    const weathering = await weatheringService.synthesizeWeathering({
      material,
      ageYears,
      climateZone,
      exposureType,
      textureWidth: width,
      textureHeight: height
    });

    // Write PNG files
    const writeMapFile = (name: string, data: Uint8Array) => {
      const outPath = path.join(outputDir, `${outputFileName}_${name}.bin`);
      fs.writeFileSync(outPath, Buffer.from(data));
      return outPath;
    };

    const colorPath = writeMapFile('albedo', weathering.colorMap);
    const normalPath = writeMapFile('normal', weathering.normalMap);
    const roughnessPath = writeMapFile('roughness', weathering.roughnessMap);
    const metallicPath = weathering.metallicMap ? writeMapFile('metallic', weathering.metallicMap) : undefined;

    const elapsedMs = Date.now() - startTime;

    return {
      success: true,
      outputFiles: {
        colorMap: colorPath,
        normalMap: normalPath,
        roughnessMap: roughnessPath,
        metallicMap: metallicPath
      },
      textureInfo: {
        width,
        height,
        channels: 'RGB/RGB/R/R'
      },
      metadata: weathering.metadata,
      timingMs: elapsedMs,
      message: `Generated ${width}x${height} weathering textures for ${material} (${ageYears} years, ${climateZone} climate). ${weathering.metadata.notes}`
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: msg
    };
  }
}

/**
 * Tool: list_weathering_materials
 * Returns available material calibrations for weathering synthesis.
 */
async function listWeatheringMaterials(): Promise<ToolResultPayload> {
  try {
    const materials = weatheringService.getAvailableMaterials();
    const entries = materials.map(m => {
      const calib = weatheringService.getMaterialCalibration(m);
      return {
        id: m,
        name: calib?.name || m,
        baseColor: calib?.baseColor,
        climates: Object.keys(calib?.climateModifiers || {}).filter(c => c !== undefined)
      };
    });

    return {
      success: true,
      materials: entries,
      message: `${materials.length} material families available for weathering synthesis.`
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: msg
    };
  }
}

export const WEATHERING_TOOL_DECLARATIONS: ToolDeclaration[] = [
  {
    name: 'synthesize_weathering_textures',
    description:
      'Generates 4K procedural weathering and aging textures (albedo color, tangent normal, roughness, metallic) for a material based on age in years, climate zone (marine/urban/alpine/desert/temperate), and exposure type (exposed/semi_sheltered/sheltered). Maps physical aging—rust bloom, patina, corrosion pitting, salt deposits, UV fading—using calibrated material families (cast iron, copper, limestone, weathering steel, etc.). Returns separate texture map files (.bin binary format, width×height×channels). Use to age any generated or photorealistic object, or to match historical/weathered reference photos.',
    parameters: {
      type: 'OBJECT',
      properties: {
        material: {
          type: 'STRING',
          description:
            'Material family: "cast_iron", "copper", "limestone", "weathering_steel", "metal_generic", etc. Unknown materials default to metal_generic. Use list_weathering_materials to see all calibrated families.'
        },
        ageYears: {
          type: 'NUMBER',
          description: 'Age in years (0–200+). Determines color and roughness progression. Default: 60 (typical street hydrant).'
        },
        climateZone: {
          type: 'STRING',
          description:
            'Environmental exposure zone: "marine" (coastal salt), "urban" (pollution, rain), "alpine" (UV, frost), "desert" (UV, minimal moisture), "temperate" (moderate). Affects oxidation rate, pitting, and bloom. Default: "urban".'
        },
        exposureType: {
          type: 'STRING',
          description:
            'Degree of weather exposure: "exposed" (full weather), "semi_sheltered" (some protection), "sheltered" (minimal). Modulates weathering intensity. Default: "exposed".'
        },
        resolution: {
          type: 'STRING',
          description: 'Texture resolution: "1K", "2K", "4K" (default), "8K". Larger sizes capture finer corrosion detail.'
        },
        outputDir: {
          type: 'STRING',
          description:
            'Directory to save texture map files. Defaults to system temp directory. Directory is created if it does not exist.'
        },
        outputFileName: {
          type: 'STRING',
          description:
            'Base filename prefix for output maps (e.g., "fire_hydrant_1964"). Default: "weathering_<material>_<age>y".'
        }
      }
    }
  },
  {
    name: 'list_weathering_materials',
    description:
      'Returns all available material families for weathering synthesis, with base colors and supported climate zones. Use to discover what materials can be aged.',
    parameters: {
      type: 'OBJECT',
      properties: {}
    }
  },
  {
    name: 'weather_mesh',
    description:
      'Ages a real mesh: bakes synthesized albedo, tangent-space normal, roughness and metallic maps directly onto a target GLB\'s materials (blended against whatever texture is already there, or used directly when there is none), and writes a real weathered .glb — unlike synthesize_weathering_textures, which only writes standalone map files. Optionally pits the geometry first with stochastic relief displacement (irregular pockmarks/corrosion pitting, not periodic grooves) before texturing — set pitDepthFraction to enable this; it requires an untextured, single-material (clay) input mesh, since the native relief pass strips textures. It gives every material of the GLB the same material family\'s maps, so it is for a single-material mesh: a generated object with parts (build_3d_object_from_reference, a scripted object) is weathered part by part, each on its own material, by object_detail_pass. For raw ground terrain erosion use erode_terrain instead.',
    parameters: {
      type: 'OBJECT',
      properties: {
        targetMeshPath: { type: 'STRING', description: 'Path to the input .glb to weather. Required.' },
        material: { type: 'STRING', description: 'Material family: "cast_iron", "copper", "limestone", "weathering_steel", "metal_generic", etc. Default "cast_iron".' },
        ageYears: { type: 'NUMBER', description: 'Age in years (0-200+). Default 60.' },
        climateZone: { type: 'STRING', description: '"marine", "urban", "alpine", "desert" or "temperate". Default "urban".' },
        exposureType: { type: 'STRING', description: '"exposed", "semi_sheltered" or "sheltered". Default "exposed".' },
        resolution: { type: 'STRING', description: 'Texture resolution: "1K", "2K" (default), "4K", "8K".' },
        blendMode: { type: 'STRING', description: 'How the generated maps combine with whatever texture is already there: "overlay", "multiply" or "blend" (default). Ignored where no prior texture exists — the generated map is used directly.' },
        blendFactor: { type: 'NUMBER', description: 'Blend intensity, 0..1. Default 0.7.' },
        outputPath: { type: 'STRING', description: 'Where to write the weathered .glb. Defaults to "<targetMeshPath>_weathered.glb".' },
        pitDepthFraction: { type: 'NUMBER', description: 'Enables geometric pitting before texturing: pit depth as a fraction of the mesh\'s bounding-box diagonal. Requires an untextured, single-material (clay) input mesh. Omit to skip pitting and only bake textures.' },
        pitScaleMeters: { type: 'NUMBER', description: 'Pit/pocket cell size in metres. Default 0.02 (fine pockmarks). Larger values give broader pitting.' },
        pitSeed: { type: 'NUMBER', description: 'Random seed for pit placement.' }
      },
      required: ['targetMeshPath']
    }
  }
];

const toOutcome = (resultPayload: ToolResultPayload): ToolHandlerOutcome =>
  resultPayload.success === false ? { resultPayload, status: 'failed' } : { resultPayload };

export const WEATHERING_TOOL_HANDLERS: Record<string, ToolHandler> = {
  synthesize_weathering_textures: async (params) => toOutcome(await synthesizeWeatheringTextures(params)),
  list_weathering_materials: async () => toOutcome(await listWeatheringMaterials()),
  weather_mesh: async (params) => toOutcome(await weatherMesh(params))
};
