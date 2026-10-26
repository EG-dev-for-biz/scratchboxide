/*
 * WeatheringPbrIntegration: wires WeatheringService's aged PBR texture synthesis, and optionally the native
 * engine's geometric relief pitting (NativeMeshEditService's `relief` operation with no direction — stochastic
 * noise displacement rather than a periodic band), onto a real target GLB.
 *
 * Previously `applyWeatheringToPbr` only computed an output path string; no GLB was ever read or written (see the
 * removed placeholder comments). This now actually parses the target GLB, optionally pits its geometry, bakes the
 * synthesized albedo/normal/roughness/metallic maps into its materials (blended against whatever texture was
 * already there, or used directly when there was none), and writes a real .glb.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as jpegJs from 'jpeg-js';
import { WeatheringService, type WeatheringParams } from './weathering-service';
import { NativeMeshEditService } from './native-mesh-edit-service';
import { parseGlbBytes, assembleGlb, type ParsedGlb } from './staged-location/glb-bytes';
import { decodePng, encodePng, resampleRgba, blendNormalsRNM } from '../texture-processing';

export interface WeatheringPbrPitting {
  /** Pit depth as a fraction of the mesh's bounding-box diagonal (mesh_edit relief's `amplitude` convention), negative values dig in. Given as a positive depth; applied as -depthFraction. */
  depthFraction: number;
  /** Pit/pocket cell size in metres (relief's `noiseScale`). */
  scaleMeters: number;
  seed?: number;
}

export interface WeatheringPbrRequest extends WeatheringParams {
  targetMeshPath: string;
  blendMode?: 'overlay' | 'multiply' | 'blend';
  blendFactor?: number; // 0-1, intensity of the weathering effect
  outputPath?: string; // where to save the weathered GLB
  /** Geometric pitting/erosion applied before texturing (requires an untextured, single-material/clay input mesh). */
  pitting?: WeatheringPbrPitting;
}

export interface WeatheringPbrResult {
  success: boolean;
  outputMeshPath?: string;
  message: string;
  textureInfo?: {
    width: number;
    height: number;
    blendFactor: number;
  };
  pitting?: {
    applied: boolean;
    outputTriangles?: number;
    outputVertices?: number;
  };
}

interface DecodedImage { width: number; height: number; rgba: Buffer }

function decodeImage(bytes: Uint8Array, mime: string): DecodedImage {
  if (mime === 'image/jpeg') {
    const j = jpegJs.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048, maxResolutionInMP: 400 });
    return { width: j.width, height: j.height, rgba: Buffer.from(j.data.buffer, j.data.byteOffset, j.data.byteLength) };
  }
  if (mime === 'image/png') {
    const p = decodePng(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { width: p.width, height: p.height, rgba: p.rgba };
  }
  throw new Error(`weathering bake: ${mime} is not decoded here`);
}

function viewBytes(glb: ParsedGlb, view: number): Uint8Array {
  const v = glb.json.bufferViews[view];
  const o = v.byteOffset ?? 0;
  return glb.bin.subarray(o, o + v.byteLength);
}

/** Blends two RGBA buffers of the same size with the composer's blend modes, writing only the RGB channels. */
function blendRgb(base: Buffer, overlay: Buffer, width: number, height: number, mode: 'overlay' | 'multiply' | 'blend', factor: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const b = base[o + c] / 255;
      const w = overlay[o + c] / 255;
      let blended: number;
      switch (mode) {
        case 'multiply':
          blended = b * w * factor + b * (1 - factor);
          break;
        case 'overlay':
          blended = w < 0.5
            ? 2 * b * w * factor + b * (1 - factor)
            : (1 - 2 * (1 - b) * (1 - w)) * factor + b * (1 - factor);
          break;
        case 'blend':
        default:
          blended = b * (1 - factor) + w * factor;
          break;
      }
      out[o + c] = Math.round(Math.max(0, Math.min(1, blended)) * 255);
    }
    out[o + 3] = 255;
  }
  return out;
}

/** Blends a single scalar channel (0..255) the same way `blendRgb` blends color, in place over a width*height buffer. */
function blendScalar(base: Uint8Array, overlay: Uint8Array, factor: number, mode: 'overlay' | 'multiply' | 'blend'): Uint8Array {
  const out = new Uint8Array(base.length);
  for (let i = 0; i < base.length; i++) {
    const b = base[i] / 255;
    const w = overlay[i] / 255;
    let blended: number;
    switch (mode) {
      case 'multiply': blended = b * w * factor + b * (1 - factor); break;
      case 'overlay': blended = w < 0.5 ? 2 * b * w * factor + b * (1 - factor) : (1 - 2 * (1 - b) * (1 - w)) * factor + b * (1 - factor); break;
      case 'blend': default: blended = b * (1 - factor) + w * factor; break;
    }
    out[i] = Math.round(Math.max(0, Math.min(1, blended)) * 255);
  }
  return out;
}

/** Tangent-space-blends an existing normal map with a generated one (Reoriented Normal Mapping), weighted by factor. */
function blendNormalMap(base: Buffer, overlay: Buffer, width: number, height: number, factor: number): Buffer {
  const out = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const n1: [number, number, number] = [base[o] / 127.5 - 1, base[o + 1] / 127.5 - 1, base[o + 2] / 127.5 - 1];
    const n2: [number, number, number] = [overlay[o] / 127.5 - 1, overlay[o + 1] / 127.5 - 1, overlay[o + 2] / 127.5 - 1];
    const blended = blendNormalsRNM(n1, [n2[0] * factor, n2[1] * factor, n2[2] * (1 - factor) + factor]);
    out[o] = Math.round((blended[0] * 0.5 + 0.5) * 255);
    out[o + 1] = Math.round((blended[1] * 0.5 + 0.5) * 255);
    out[o + 2] = Math.round((blended[2] * 0.5 + 0.5) * 255);
    out[o + 3] = 255;
  }
  return out;
}

export class WeatheringPbrIntegration {
  private weatheringService: WeatheringService;
  private meshEditService: NativeMeshEditService;

  constructor() {
    this.weatheringService = new WeatheringService();
    this.meshEditService = new NativeMeshEditService();
  }

  /**
   * Applies procedural aging to a target mesh's materials, optionally pitting its geometry first, and writes a
   * real textured (and, with `pitting`, eroded) GLB — never a placeholder path.
   */
  async applyWeatheringToPbr(request: WeatheringPbrRequest): Promise<WeatheringPbrResult> {
    try {
      if (!request.targetMeshPath || !fs.existsSync(request.targetMeshPath)) {
        return { success: false, message: `targetMeshPath ${request.targetMeshPath || '(none)'} does not exist` };
      }

      const blendMode = request.blendMode ?? 'blend';
      const blendFactor = request.blendFactor ?? 0.7;
      const width = request.textureWidth || 2048;
      const height = request.textureHeight || 2048;

      let meshPath = request.targetMeshPath;
      let pittingReport: WeatheringPbrResult['pitting'];

      // Step 1: geometric pitting, before any texture is touched (mesh_edit's native reader keeps one
      // material and no textures, so this runs against the input and the input's own material is carried
      // over by NativeMeshEditService — texturing happens afterwards, onto the pitted result).
      if (request.pitting) {
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-weathering-pit-'));
        const pittedPath = path.join(scratch, 'pitted.glb');
        try {
          const editResult = await this.meshEditService.edit({
            inputGlbPath: request.targetMeshPath,
            outputGlbPath: pittedPath,
            operations: [{
              type: 'relief',
              amplitude: -Math.abs(request.pitting.depthFraction),
              roughness: 1,
              noiseScale: request.pitting.scaleMeters,
              seed: request.pitting.seed
            }]
          });
          meshPath = editResult.outputGlbPath;
          pittingReport = { applied: true, outputTriangles: editResult.outputTriangles, outputVertices: editResult.outputVertices };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, message: `Pitting failed before weathering could be baked: ${msg}` };
        }
      }

      // Step 2: synthesize aged albedo/normal/roughness/metallic maps
      const weathering = await this.weatheringService.synthesizeWeathering({
        material: request.material,
        ageYears: request.ageYears,
        climateZone: request.climateZone,
        exposureType: request.exposureType,
        textureWidth: width,
        textureHeight: height,
        baseColor: request.baseColor
      });
      const genColorRgba = Buffer.alloc(width * height * 4);
      const genNormalRgba = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        genColorRgba[i * 4] = weathering.colorMap[i * 3];
        genColorRgba[i * 4 + 1] = weathering.colorMap[i * 3 + 1];
        genColorRgba[i * 4 + 2] = weathering.colorMap[i * 3 + 2];
        genColorRgba[i * 4 + 3] = 255;
        genNormalRgba[i * 4] = weathering.normalMap[i * 3];
        genNormalRgba[i * 4 + 1] = weathering.normalMap[i * 3 + 1];
        genNormalRgba[i * 4 + 2] = weathering.normalMap[i * 3 + 2];
        genNormalRgba[i * 4 + 3] = 255;
      }

      // Step 3: parse the (possibly pitted) GLB and bake the maps into every material
      const glbBytes = fs.readFileSync(meshPath);
      const glb = parseGlbBytes(glbBytes);
      const json = JSON.parse(JSON.stringify(glb.json));
      json.images = json.images ?? [];
      json.textures = json.textures ?? [];
      json.bufferViews = json.bufferViews ?? [];
      const materials: any[] = json.materials ?? [];
      if (!materials.length) {
        return { success: false, message: `${meshPath} has no materials to weather` };
      }

      let binLength = glb.bin.byteLength;
      const extra: Buffer[] = [];
      const appendImage = (png: Buffer): number => {
        const pad = (4 - (binLength % 4)) % 4;
        if (pad) { extra.push(Buffer.alloc(pad)); binLength += pad; }
        json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: png.length });
        extra.push(png);
        binLength += png.length;
        const viewIndex = json.bufferViews.length - 1;
        json.images.push({ bufferView: viewIndex, mimeType: 'image/png' });
        json.textures.push({ source: json.images.length - 1 });
        return json.textures.length - 1;
      };

      for (const mat of materials) {
        mat.pbrMetallicRoughness = mat.pbrMetallicRoughness ?? {};
        const pbr = mat.pbrMetallicRoughness;

        // Base color / albedo
        let colorOut: Buffer = genColorRgba;
        const existingColorTex = pbr.baseColorTexture?.index !== undefined ? json.textures[pbr.baseColorTexture.index] : undefined;
        const existingColorImg = existingColorTex?.source !== undefined ? json.images[existingColorTex.source] : undefined;
        if (existingColorImg?.bufferView !== undefined && ['image/jpeg', 'image/png'].includes(existingColorImg.mimeType)) {
          const decoded = decodeImage(viewBytes(glb, existingColorImg.bufferView), existingColorImg.mimeType);
          const resampledGen = resampleRgba(genColorRgba, width, height, decoded.width, decoded.height);
          colorOut = blendRgb(decoded.rgba, resampledGen, decoded.width, decoded.height, blendMode, blendFactor);
          pbr.baseColorTexture = { index: appendImage(encodePng(decoded.width, decoded.height, colorOut)) };
        } else {
          pbr.baseColorFactor = [1, 1, 1, 1];
          pbr.baseColorTexture = { index: appendImage(encodePng(width, height, colorOut)) };
        }

        // Tangent-space normal
        const existingNormalTex = mat.normalTexture?.index !== undefined ? json.textures[mat.normalTexture.index] : undefined;
        const existingNormalImg = existingNormalTex?.source !== undefined ? json.images[existingNormalTex.source] : undefined;
        if (existingNormalImg?.bufferView !== undefined && ['image/jpeg', 'image/png'].includes(existingNormalImg.mimeType)) {
          const decoded = decodeImage(viewBytes(glb, existingNormalImg.bufferView), existingNormalImg.mimeType);
          const resampledGen = resampleRgba(genNormalRgba, width, height, decoded.width, decoded.height);
          const blended = blendNormalMap(decoded.rgba, resampledGen, decoded.width, decoded.height, blendFactor);
          mat.normalTexture = { index: appendImage(encodePng(decoded.width, decoded.height, blended)) };
        } else {
          mat.normalTexture = { index: appendImage(encodePng(width, height, genNormalRgba)) };
        }

        // Roughness (G) / metallic (B) packed into one metallicRoughness texture
        const existingMrTex = pbr.metallicRoughnessTexture?.index !== undefined ? json.textures[pbr.metallicRoughnessTexture.index] : undefined;
        const existingMrImg = existingMrTex?.source !== undefined ? json.images[existingMrTex.source] : undefined;
        const metallic = weathering.metallicMap ?? new Uint8Array(width * height);
        if (existingMrImg?.bufferView !== undefined && ['image/jpeg', 'image/png'].includes(existingMrImg.mimeType)) {
          const decoded = decodeImage(viewBytes(glb, existingMrImg.bufferView), existingMrImg.mimeType);
          const n = decoded.width * decoded.height;
          const baseRough = new Uint8Array(n), baseMetal = new Uint8Array(n);
          for (let i = 0; i < n; i++) { baseRough[i] = decoded.rgba[i * 4 + 1]; baseMetal[i] = decoded.rgba[i * 4 + 2]; }
          const genRoughAtSize = resampleChannel(weathering.roughnessMap, width, height, decoded.width, decoded.height);
          const genMetalAtSize = resampleChannel(metallic, width, height, decoded.width, decoded.height);
          const blendedRough = blendScalar(baseRough, genRoughAtSize, blendFactor, blendMode);
          const blendedMetal = blendScalar(baseMetal, genMetalAtSize, blendFactor, blendMode);
          const out = Buffer.alloc(n * 4);
          for (let i = 0; i < n; i++) { out[i * 4] = 255; out[i * 4 + 1] = blendedRough[i]; out[i * 4 + 2] = blendedMetal[i]; out[i * 4 + 3] = 255; }
          pbr.metallicRoughnessTexture = { index: appendImage(encodePng(decoded.width, decoded.height, out)) };
          pbr.roughnessFactor = 1;
          pbr.metallicFactor = 1;
        } else {
          const out = Buffer.alloc(width * height * 4);
          for (let i = 0; i < width * height; i++) { out[i * 4] = 255; out[i * 4 + 1] = weathering.roughnessMap[i]; out[i * 4 + 2] = metallic[i]; out[i * 4 + 3] = 255; }
          pbr.metallicRoughnessTexture = { index: appendImage(encodePng(width, height, out)) };
          pbr.roughnessFactor = 1;
          pbr.metallicFactor = 1;
        }

        mat.extras = {
          ...mat.extras,
          sbWeathering: {
            provenance: 'generated',
            material: request.material,
            ageYears: request.ageYears,
            climateZone: request.climateZone,
            exposureType: request.exposureType,
            confidence: weathering.metadata.confidence,
            notes: weathering.metadata.notes
          }
        };
      }

      const bin = extra.length ? new Uint8Array(Buffer.concat([Buffer.from(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength), ...extra])) : glb.bin;
      if (json.buffers?.[0]) json.buffers[0].byteLength = bin.byteLength;
      else json.buffers = [{ byteLength: bin.byteLength }];

      const outputPath = request.outputPath || `${request.targetMeshPath.replace(/\.glb$/, '')}_weathered.glb`;
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, assembleGlb(json, bin));

      return {
        success: true,
        outputMeshPath: outputPath,
        textureInfo: { width, height, blendFactor },
        pitting: pittingReport ?? { applied: false },
        message: `Baked ${width}x${height} weathering maps for ${request.material} (${request.ageYears}y, ${request.climateZone}/${request.exposureType}) onto ${materials.length} material(s) of ${path.basename(request.targetMeshPath)}${pittingReport?.applied ? `, after pitting its geometry (${pittingReport.outputTriangles} triangles)` : ''}. ${weathering.metadata.notes} Output: ${outputPath}`
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Failed to apply weathering to PBR: ${msg}`
      };
    }
  }

  /**
   * Get weathering service for direct access
   */
  getWeatheringService(): WeatheringService {
    return this.weatheringService;
  }
}

/** Nearest-neighbour resample of a single-channel (1 byte/pixel) map — cheap and adequate for noise-based maps. */
function resampleChannel(src: Uint8Array, srcW: number, srcH: number, dstW: number, dstH: number): Uint8Array {
  if (srcW === dstW && srcH === dstH) return src;
  const out = new Uint8Array(dstW * dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y / dstH) * srcH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x / dstW) * srcW));
      out[y * dstW + x] = src[sy * srcW + sx];
    }
  }
  return out;
}

export const weatheringPbrIntegration = new WeatheringPbrIntegration();
