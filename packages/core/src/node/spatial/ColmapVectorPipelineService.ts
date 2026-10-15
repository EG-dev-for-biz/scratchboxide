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
import { ColmapVectorPipeline } from '../../browser/generative-canvas/services/colmap-vector-pipeline';
import {
  ColmapVectorPipelineRequest,
  ColmapVectorPipelineResult,
  ColmapClay3DObjectMetadata
} from '../../common/spatial/colmap-vector-reference-types';
import { getGoogle3DTilesClay } from './Google3DTileBlockoutPipelineService';

export interface ColmapNodeExecutionOptions {
  sparseDir?: string;
  outputDir?: string;
  saveFiles?: boolean;
  baseFileName?: string;
}

/**
 * Node.js Service for the Universal COLMAP Vector Reference Pipeline.
 * Integrates filesystem I/O, sparse directory ingestion, and disk export.
 */
export class ColmapVectorPipelineService {
  private pipeline: ColmapVectorPipeline;

  constructor() {
    this.pipeline = ColmapVectorPipeline.getInstance();
  }

  /**
   * Reads an API key from environment, config files, or secrets.
   */
  public getApiKey(): string | undefined {
    if (process.env.GOOGLE_MAPS_API_KEY) return process.env.GOOGLE_MAPS_API_KEY;

    try {
      const configPath = path.resolve(process.cwd(), 'public/data/google_maps_config.json');
      if (fs.existsSync(configPath)) {
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (cfg.apiKey) return cfg.apiKey;
      }
    } catch {}

    try {
      const secretsPath = path.resolve(process.cwd(), 'secrets.json');
      if (fs.existsSync(secretsPath)) {
        const sec = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
        if (sec.GOOGLE_MAPS_API_KEY) return sec.GOOGLE_MAPS_API_KEY;
        if (sec.google_maps_api_key) return sec.google_maps_api_key;
      }
    } catch {}

    return undefined;
  }

  /**
   * Executes the pipeline with filesystem options.
   */
  public async execute(
    request: ColmapVectorPipelineRequest,
    options?: ColmapNodeExecutionOptions
  ): Promise<ColmapVectorPipelineResult & { exportedFilePaths?: Record<string, string> }> {
    // If sparseDir provided, load cameras.txt and images.txt from disk
    if (options?.sparseDir) {
      const sparsePath = path.resolve(process.cwd(), options.sparseDir);
      const camerasPath = path.join(sparsePath, 'cameras.txt');
      const imagesPath = path.join(sparsePath, 'images.txt');

      if (fs.existsSync(camerasPath) && fs.existsSync(imagesPath)) {
        request.colmapFiles = {
          camerasText: fs.readFileSync(camerasPath, 'utf8'),
          imagesText: fs.readFileSync(imagesPath, 'utf8')
        };
      } else {
        throw new Error(`COLMAP sparse files not found at: ${sparsePath} (expected cameras.txt and images.txt)`);
      }
    }

    // Attach API key if not specified
    if (!request.apiKey) {
      request.apiKey = this.getApiKey();
    }

    const outDir = path.resolve(process.cwd(), options?.outputDir || 'public/data/colmap_vector_export');
    const prefix = options?.baseFileName || 'colmap_vector';

    // Dedicated Studio Grey Clay 3D Object (.glb) Ingestion via getGoogle3DTilesClay. Requested unless
    // clayOptions.enabled is false; a failed extraction fails the call instead of returning without the clay.
    let clayObject: ColmapClay3DObjectMetadata | undefined;
    if (request.clayOptions?.enabled !== false) {
      {
        if (!fs.existsSync(outDir)) {
          fs.mkdirSync(outDir, { recursive: true });
        }
        const targetGlbPath = request.clayOptions?.outputGlbPath || path.join(outDir, `${prefix}_clay.glb`);

        // Resolve anchor first to obtain exact geodetic coordinates
        const anchor = await this.pipeline.resolveAnchor(request);

        const clayRes = await getGoogle3DTilesClay(
          {
            lat: anchor.lat,
            lng: anchor.lng,
            elevation: anchor.elevationMeters,
            landmarkName: anchor.formattedAddress || (request.anchor as any)?.label || request.query
          },
          {
            outputGlbPath: targetGlbPath,
            apiKey: request.apiKey,
            offlineMock: request.clayOptions?.offlineMock,
            lodQuality: request.clayOptions?.lodQuality || {
              errorTarget: 0.5,
              virtualSseWidth: 3840,
              virtualSseHeight: 2160
            }
          }
        );

        if (clayRes && clayRes.success) {
          clayObject = {
            glbPath: clayRes.glbPath,
            glbBuffer: clayRes.glbBuffer,
            meshStats: clayRes.mesh,
            quality: {
              source: clayRes.quality.source,
              errorTarget: clayRes.quality.errorTarget,
              resolution: clayRes.quality.resolution,
              asynchronousSettle: clayRes.quality.asynchronousSettle,
              leafLodSettled: clayRes.quality.leafLodSettled
            }
          };

          // Scale synthetic survey bounding radius to encompass the real clay 3D mesh
          if (request.surveyConfig && clayRes.mesh?.boundingSphere?.radius) {
            const meshRadius = clayRes.mesh.boundingSphere.radius;
            if (!request.surveyConfig.targetRadiusMeters || request.surveyConfig.targetRadiusMeters < meshRadius) {
              request.surveyConfig.targetRadiusMeters = Number((meshRadius * 1.35).toFixed(1));
            }
          }
        }
      }
    }

    const result = await this.pipeline.execute(request);
    if (clayObject) {
      result.clayObject = clayObject;
    }

    // Save files if requested or if outputDir provided
    const exportedFilePaths: Record<string, string> = {};
    if (clayObject?.glbPath && fs.existsSync(clayObject.glbPath)) {
      exportedFilePaths.clayGlb = clayObject.glbPath;
    }

    if (options?.saveFiles || options?.outputDir) {
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }

      // 1. GeoJSON
      const geoJsonPath = path.join(outDir, `${prefix}_stations.geojson`);
      fs.writeFileSync(geoJsonPath, JSON.stringify(result.geoJson, null, 2), 'utf8');
      exportedFilePaths.geoJson = geoJsonPath;

      // 2. cameras.txt
      const camerasOutPath = path.join(outDir, `${prefix}_cameras.txt`);
      fs.writeFileSync(camerasOutPath, result.colmapExport.camerasText, 'utf8');
      exportedFilePaths.camerasText = camerasOutPath;

      // 3. images.txt
      const imagesOutPath = path.join(outDir, `${prefix}_images.txt`);
      fs.writeFileSync(imagesOutPath, result.colmapExport.imagesText, 'utf8');
      exportedFilePaths.imagesText = imagesOutPath;

      // 4. Full result JSON
      const resultPath = path.join(outDir, `${prefix}_bundle.json`);
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
      exportedFilePaths.bundle = resultPath;
    }

    return {
      ...result,
      exportedFilePaths
    };
  }
}
