/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Geospatial Tile Extraction Bridge
 * Bridges Google Maps Photorealistic 3D Tiles with Universal3DObjectSeparationService
 * and the Scratchbox Python 3D Engine. Automatically streams leaf-LOD 3D tiles,
 * separates them into discrete spatial shapes (terrain, architecture, vegetation clusters),
 * and exposes them as structured anchors and manifests for procedural population (e.g. SB-Veggie).
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { getGoogle3DTilesFullTexture, getGoogle3DTilesClay, GeoAnchor } from './Google3DTileBlockoutPipelineService';
import { Universal3DObjectSeparationService, UniversalSeparatedScene, UniversalSeparatedObject } from './Universal3DObjectSeparationService';

export interface ExtractedVegetationAnchor {
  id: string;
  name: string;
  centroid: [number, number, number];
  dimensions: [number, number, number];
  radius: number;
  height: number;
  seed: number;
}

export interface ExtractedLocationManifest {
  query: string;
  resolvedAddress: string;
  lat: number;
  lng: number;
  altitudeMeters: number;
  tileGlbPath: string;
  totalVertices: number;
  totalTriangles: number;
  overallBoundingBox: {
    min: [number, number, number];
    max: [number, number, number];
    centroid: [number, number, number];
    dimensions: [number, number, number];
  };
  architectureCount: number;
  terrainCount: number;
  vegetationCount: number;
  vegetationAnchors: ExtractedVegetationAnchor[];
  objects: Array<{
    id: string;
    name: string;
    category: string;
    routingRecommendation?: string;
    centroid: [number, number, number];
    dimensions: [number, number, number];
    vertexCount: number;
  }>;
}

export interface LocationExtractionResult {
  success: boolean;
  manifest: ExtractedLocationManifest;
  manifestPath: string;
  glbPath: string;
  error?: string;
}

export class GeospatialTileExtractionBridge {
  private static instance?: GeospatialTileExtractionBridge;

  public static getInstance(): GeospatialTileExtractionBridge {
    if (!GeospatialTileExtractionBridge.instance) {
      GeospatialTileExtractionBridge.instance = new GeospatialTileExtractionBridge();
    }
    return GeospatialTileExtractionBridge.instance;
  }

  /**
   * Ingest real-world location tiles and run shape extraction pipeline.
   * Supports both query string and explicit WGS-84 GeoAnchor geodetic coordinates.
   */
  public async ingestAndExtract(
    queryOrCoords: string | GeoAnchor,
    options: {
      outputDir?: string;
      mode?: 'full_texture' | 'clay';
      mockExecution?: boolean;
    } = {}
  ): Promise<LocationExtractionResult> {
    const outputDir = options.outputDir || path.resolve(process.cwd(), 'build/3d-geospatial');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const querySlug = typeof queryOrCoords === 'string'
      ? queryOrCoords
      : `${(queryOrCoords as any).formattedAddress || queryOrCoords.landmarkName || 'geo'}_${queryOrCoords.lat.toFixed(4)}_${queryOrCoords.lng.toFixed(4)}`;
    const safeSlug = querySlug.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
    const tileGlbPath = path.join(outputDir, `${safeSlug}_tiles.glb`);
    const manifestPath = path.join(outputDir, `${safeSlug}_manifest.json`);

    // Check disk cache for already extracted 3D tile GLB and manifest
    if (fs.existsSync(tileGlbPath) && fs.existsSync(manifestPath)) {
      try {
        const cachedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return {
          success: true,
          manifest: cachedManifest,
          manifestPath,
          glbPath: tileGlbPath
        };
      } catch {
        // Corrupted cache, re-fetch
      }
    }

    // 1. Fetch 3D tiles (using full texture or studio grey clay)
    let tileResult;
    if (options.mode === 'clay') {
      tileResult = await getGoogle3DTilesClay(queryOrCoords, {
        outputGlbPath: tileGlbPath,
        offlineMock: options.mockExecution
      });
    } else {
      tileResult = await getGoogle3DTilesFullTexture(queryOrCoords, {
        outputGlbPath: tileGlbPath,
        offlineMock: options.mockExecution
      });
    }

    if (!tileResult.success || !tileResult.glbPath || !fs.existsSync(tileResult.glbPath)) {
      const targetDesc = typeof queryOrCoords === 'string' ? queryOrCoords : `lat: ${queryOrCoords.lat}, lng: ${queryOrCoords.lng}`;
      throw new Error(`Failed to ingest 3D tiles for "${targetDesc}"`);
    }

    // 2. Separate shapes via Universal3DObjectSeparationService
    const separation: UniversalSeparatedScene = Universal3DObjectSeparationService.separate3DMesh(tileResult.glbPath, {
      autoDetectSemanticCategories: true,
      enableVertexClustering: true,
      granularity: 'all'
    });

    // 3. Extract vegetation anchors (centroids, bounding radii, heights for SB-Veggie)
    const vegetationAnchors: ExtractedVegetationAnchor[] = [];
    let archCount = 0;
    let terrainCount = 0;

    for (let i = 0; i < separation.objects.length; ++i) {
      const obj = separation.objects[i];
      if (obj.category === 'foliage' || obj.category === 'foliage_trees') {
        const radius = Math.max(0.5, Math.max(obj.boundingBox.dimensions[0], obj.boundingBox.dimensions[2]) * 0.5);
        const height = Math.max(1.0, obj.boundingBox.dimensions[1]);
        const seed = Math.abs((obj.id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) * 1103515245) % 2147483647);

        vegetationAnchors.push({
          id: obj.id,
          name: obj.name,
          centroid: obj.boundingBox.centroid,
          dimensions: obj.boundingBox.dimensions,
          radius,
          height,
          seed
        });
      } else if (obj.category === 'architecture' || obj.category === 'landmark') {
        archCount++;
      } else if (obj.category === 'terrain') {
        terrainCount++;
      }
    }

    const queryString = typeof queryOrCoords === 'string'
      ? queryOrCoords
      : (queryOrCoords.landmarkName || `${queryOrCoords.lat}, ${queryOrCoords.lng}`);

    const manifest: ExtractedLocationManifest = {
      query: queryString,
      resolvedAddress: tileResult.resolvedAddress || queryString,
      lat: tileResult.geoAnchor.lat,
      lng: tileResult.geoAnchor.lng,
      altitudeMeters: tileResult.geoAnchor.elevation ?? 0,
      tileGlbPath: tileResult.glbPath,
      totalVertices: tileResult.mesh.vertexCount,
      totalTriangles: tileResult.mesh.triangleCount,
      overallBoundingBox: {
        min: separation.overallBoundingBox.min,
        max: separation.overallBoundingBox.max,
        centroid: separation.overallBoundingBox.centroid,
        dimensions: separation.overallBoundingBox.dimensions
      },
      architectureCount: archCount,
      terrainCount,
      vegetationCount: vegetationAnchors.length,
      vegetationAnchors,
      objects: separation.objects.map(o => ({
        id: o.id,
        name: o.name,
        category: o.category,
        routingRecommendation: o.routingRecommendation,
        centroid: o.boundingBox.centroid,
        dimensions: o.boundingBox.dimensions,
        vertexCount: o.vertexCount
      }))
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return {
      success: true,
      manifest,
      manifestPath,
      glbPath: tileResult.glbPath
    };
  }
}
