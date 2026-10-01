/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import {
  FoliageClass,
  FoliageSegmentationResult,
  FoliageSegmentationStats,
  GeoTiffRasterMetadata,
  SolarDataLayersBundle,
  SolarFoliageClassifierOptions,
  FOLIAGE_CLASS_COLORS
} from '../../common/spatial/GoogleSolarDataLayersTypes';
import { GeoTiffRasterParser } from './GeoTiffRasterParser';

/**
 * High-precision Multi-Class Foliage Classifier powered by Google Maps Platform Solar API (dataLayers).
 *
 * Couples sub-meter (0.1m) Digital Surface Model (DSM), building masks, and RGB orthophotos to
 * segment:
 * - Turf Grass / Ground Cover (nDSM < 0.25m)
 * - Bushes, Hedges & Shrubs (0.25m <= nDSM < 2.50m)
 * - Tree Canopies (nDSM >= 2.50m)
 * - Buildings & Hardscape
 */
export class GoogleSolarFoliageClassifier {
  private readonly options: Required<SolarFoliageClassifierOptions>;

  constructor(options?: SolarFoliageClassifierOptions) {
    this.options = {
      grassMaxHeightMeters: options?.grassMaxHeightMeters ?? 0.35,
      shrubMaxHeightMeters: options?.shrubMaxHeightMeters ?? 2.50,
      minVegetationExG: options?.minVegetationExG ?? 10.0,
      minVegetationGLI: options?.minVegetationGLI ?? 0.04,
      dtmFilterRadiusMeters: options?.dtmFilterRadiusMeters ?? 2.5
    };
  }

  /**
   * Process decoded Solar dataLayers bundle into a full multi-class segmentation result.
   */
  public segmentFoliage(bundle: SolarDataLayersBundle): FoliageSegmentationResult {
    const { width, height } = bundle.metadata;
    const numPixels = width * height;

    const dsm = bundle.dsm;
    const mask = bundle.mask;
    const { r, g, b } = bundle.rgb;

    // 1. Derive bare-earth Digital Terrain Model (DTM)
    const dtm = this.extractBareEarthDtm(dsm, mask, bundle.rgb, bundle.metadata);

    // 2. Compute Normalized DSM (nDSM) = DSM - DTM (height above terrain)
    const ndsm = new Float32Array(numPixels);
    const noData = bundle.metadata.noDataValue ?? -9999;

    for (let i = 0; i < numPixels; i++) {
      const dsmVal = dsm[i];
      if (dsmVal <= noData + 1 || isNaN(dsmVal)) {
        ndsm[i] = 0.0;
      } else {
        ndsm[i] = Math.max(0.0, dsmVal - dtm[i]);
      }
    }

    // 3. Compute Excess Green (ExG) and GLI spectral indices
    const exgMap = new Float32Array(numPixels);
    const classificationMap = new Uint8Array(numPixels);

    let treeCanopyPixels = 0;
    let shrubBushPixels = 0;
    let turfGrassPixels = 0;
    let buildingPixels = 0;
    let hardscapePixels = 0;

    let treeHeightSum = 0;
    let maxTreeHeight = 0;
    let shrubHeightSum = 0;

    for (let i = 0; i < numPixels; i++) {
      const red = r[i];
      const green = g[i];
      const blue = b[i];

      // Excess Green: ExG = 2G - R - B
      const exg = 2.0 * green - red - blue;
      exgMap[i] = exg;

      // GLI: (2G - R - B) / (2G + R + B + eps)
      const denom = 2.0 * green + red + blue + 0.0001;
      const gli = exg / denom;

      const isBuilding = mask[i] > 0;
      const isVegetation = !isBuilding && exg >= this.options.minVegetationExG && gli >= this.options.minVegetationGLI;
      const heightAboveGround = ndsm[i];

      if (isBuilding) {
        classificationMap[i] = FoliageClass.ARCHITECTURE_BUILDING;
        buildingPixels++;
      } else if (!isVegetation) {
        classificationMap[i] = FoliageClass.HARDSCAPE_PAVEMENT;
        hardscapePixels++;
      } else {
        // Vegetation branch: discriminate by nDSM height
        if (heightAboveGround < this.options.grassMaxHeightMeters) {
          classificationMap[i] = FoliageClass.TURF_GRASS;
          turfGrassPixels++;
        } else if (heightAboveGround < this.options.shrubMaxHeightMeters) {
          classificationMap[i] = FoliageClass.BUSH_SHRUB;
          shrubBushPixels++;
          shrubHeightSum += heightAboveGround;
        } else {
          classificationMap[i] = FoliageClass.TREE_CANOPY;
          treeCanopyPixels++;
          treeHeightSum += heightAboveGround;
          if (heightAboveGround > maxTreeHeight) {
            maxTreeHeight = heightAboveGround;
          }
        }
      }
    }

    // 4. Calculate spatial resolution and physical area metrics
    const pixelResX = bundle.metadata.pixelScale.scaleX;
    const pixelResY = bundle.metadata.pixelScale.scaleY;

    // If pixel scale is in degrees (approx 1e-5), convert to meters at the latitude
    const lat = bundle.metadata.tiePoint.y;
    const metersPerDegreeLat = 111000.0;
    const metersPerDegreeLng = 111000.0 * Math.cos((lat * Math.PI) / 180.0);

    const isDegreeScale = pixelResX < 0.001;
    const pixelWidthMeters = isDegreeScale ? pixelResX * metersPerDegreeLng : pixelResX;
    const pixelHeightMeters = isDegreeScale ? pixelResY * metersPerDegreeLat : pixelResY;
    const pixelAreaM2 = Math.max(0.001, pixelWidthMeters * pixelHeightMeters);

    const totalAreaM2 = numPixels * pixelAreaM2;
    const treeAreaM2 = treeCanopyPixels * pixelAreaM2;
    const shrubAreaM2 = shrubBushPixels * pixelAreaM2;
    const grassAreaM2 = turfGrassPixels * pixelAreaM2;
    const buildingAreaM2 = buildingPixels * pixelAreaM2;
    const hardscapeAreaM2 = hardscapePixels * pixelAreaM2;
    const vegetationAreaM2 = treeAreaM2 + shrubAreaM2 + grassAreaM2;

    const meanTreeHeight = treeCanopyPixels > 0 ? treeHeightSum / treeCanopyPixels : 0;
    const meanShrubHeight = shrubBushPixels > 0 ? shrubHeightSum / shrubBushPixels : 0;

    // Estimate discrete tree count via 8-connected cluster analysis
    const totalTreeCountEstimate = this.estimateTreeCount(classificationMap, width, height, pixelAreaM2);

    const stats: FoliageSegmentationStats = {
      totalAreaM2: Number(totalAreaM2.toFixed(2)),
      pixelResolutionMeters: Number(pixelWidthMeters.toFixed(3)),
      vegetationAreaM2: Number(vegetationAreaM2.toFixed(2)),
      treeCanopyAreaM2: Number(treeAreaM2.toFixed(2)),
      shrubBushAreaM2: Number(shrubAreaM2.toFixed(2)),
      turfGrassAreaM2: Number(grassAreaM2.toFixed(2)),
      buildingAreaM2: Number(buildingAreaM2.toFixed(2)),
      hardscapeAreaM2: Number(hardscapeAreaM2.toFixed(2)),
      canopyCoveragePercent: Number(((treeAreaM2 / totalAreaM2) * 100.0).toFixed(2)),
      shrubCoveragePercent: Number(((shrubAreaM2 / totalAreaM2) * 100.0).toFixed(2)),
      grassCoveragePercent: Number(((grassAreaM2 / totalAreaM2) * 100.0).toFixed(2)),
      meanTreeHeightMeters: Number(meanTreeHeight.toFixed(2)),
      maxTreeHeightMeters: Number(maxTreeHeight.toFixed(2)),
      meanShrubHeightMeters: Number(meanShrubHeight.toFixed(2)),
      totalTreeCountEstimate
    };

    const metadata = bundle.metadata;

    return {
      classificationMap,
      ndsm,
      dtm,
      exgMap,
      width,
      height,
      metadata,
      stats,

      classifyLatLng: (latitude: number, longitude: number): FoliageClass => {
        return this.queryPixelClass(latitude, longitude, metadata, classificationMap);
      },

      classifyPoint3D: (
        worldPos: { x: number; y: number; z: number },
        anchorGeo: { latitude: number; longitude: number }
      ): FoliageClass => {
        if (metadata.pixelScale.scaleX >= 0.001) {
          // Direct metric mapping when pixel scale is in meters:
          // In Three.js: +X is East (u), +Z is South (v), -Z is North
          const u = Math.round(worldPos.x / metadata.pixelScale.scaleX);
          const v = Math.round(worldPos.z / metadata.pixelScale.scaleY);
          if (u < 0 || u >= metadata.width || v < 0 || v >= metadata.height) {
            return FoliageClass.UNKNOWN;
          }
          return classificationMap[v * metadata.width + u] as FoliageClass;
        } else {
          const dEast = worldPos.x;
          const dNorth = -worldPos.z;
          const cosLat = Math.cos((anchorGeo.latitude * Math.PI) / 180.0);
          const lat = anchorGeo.latitude + dNorth / 111000.0;
          const lng = anchorGeo.longitude + dEast / (111000.0 * (cosLat || 1.0));
          return this.queryPixelClass(lat, lng, metadata, classificationMap);
        }
      },

      getHeightAboveGround: (latitude: number, longitude: number): number => {
        return this.queryPixelFloat(latitude, longitude, metadata, ndsm);
      }
    };
  }

  /**
   * Convenience loader from raw GeoTIFF buffers (DSM, RGB, Building Mask).
   */
  public segmentFromBuffers(
    dsmBuffer: Buffer,
    rgbBuffer: Buffer,
    maskBuffer: Buffer
  ): FoliageSegmentationResult {
    const dsm = GeoTiffRasterParser.decodeFloat32Dsm(dsmBuffer);
    const rgb = GeoTiffRasterParser.decodeRgbOrthophoto(rgbBuffer);
    const mask = GeoTiffRasterParser.decodeBuildingMask(maskBuffer);

    const bundle: SolarDataLayersBundle = {
      dsm: dsm.data,
      rgb: { r: rgb.r, g: rgb.g, b: rgb.b },
      mask: mask.mask,
      metadata: dsm.metadata
    };

    return this.segmentFoliage(bundle);
  }

  /**
   * Extract bare-earth Digital Terrain Model (DTM) from DSM using multi-pass morphological ground filtering.
   * Samples true non-vegetation / non-building ground anchors and invalidates elevated tree canopy clusters
   * to guarantee seamless interpolation under dense foliage crowns without canopy depression artifacts.
   */
  private extractBareEarthDtm(
    dsm: Float32Array,
    mask: Uint8Array,
    rgb: { r: Uint8Array; g: Uint8Array; b: Uint8Array },
    metadata: GeoTiffRasterMetadata
  ): Float32Array {
    const { width, height } = metadata;
    const numPixels = width * height;
    const dtm = new Float32Array(numPixels);
    const noData = metadata.noDataValue ?? -9999;

    const scaleX = metadata.pixelScale.scaleX < 0.001 ? 0.1 : metadata.pixelScale.scaleX;
    const step = Math.max(3, Math.round(this.options.dtmFilterRadiusMeters / scaleX));

    const gridW = Math.ceil(width / step) + 1;
    const gridH = Math.ceil(height / step) + 1;
    const gridGround = new Float32Array(gridW * gridH);
    const gridIsConfidentGround = new Uint8Array(gridW * gridH);

    // Pass 1: Sample minimum elevation for non-building, non-vegetation pixels (pure ground/hardscape)
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const startX = Math.max(0, gx * step - Math.floor(step / 2));
        const endX = Math.min(width, startX + step);
        const startY = Math.max(0, gy * step - Math.floor(step / 2));
        const endY = Math.min(height, startY + step);

        let minBareGround = Infinity;
        let minAnyGround = Infinity;
        let validBareSamples = 0;
        let validAnySamples = 0;

        for (let y = startY; y < endY; y++) {
          const rowOffset = y * width;
          for (let x = startX; x < endX; x++) {
            const idx = rowOffset + x;
            if (mask[idx] === 0) {
              const val = dsm[idx];
              if (val > noData + 1 && !isNaN(val)) {
                if (val < minAnyGround) minAnyGround = val;
                validAnySamples++;

                const exg = 2.0 * rgb.g[idx] - rgb.r[idx] - rgb.b[idx];
                if (exg < this.options.minVegetationExG) {
                  // True bare earth / pavement / hardscape
                  if (val < minBareGround) minBareGround = val;
                  validBareSamples++;
                }
              }
            }
          }
        }

        const gIdx = gy * gridW + gx;
        if (validBareSamples > 0) {
          gridGround[gIdx] = minBareGround;
          gridIsConfidentGround[gIdx] = 1;
        } else if (validAnySamples > 0) {
          // Candidate ground (e.g. lawn or canopy)
          gridGround[gIdx] = minAnyGround;
          gridIsConfidentGround[gIdx] = 0;
        } else {
          gridGround[gIdx] = NaN;
          gridIsConfidentGround[gIdx] = 0;
        }
      }
    }

    // Find global minimum of confident ground
    let globalMinGround = Infinity;
    for (let i = 0; i < gridGround.length; i++) {
      if (gridIsConfidentGround[i] === 1 && gridGround[i] < globalMinGround) {
        globalMinGround = gridGround[i];
      }
    }
    if (globalMinGround === Infinity) {
      for (let i = 0; i < gridGround.length; i++) {
        if (!isNaN(gridGround[i]) && gridGround[i] < globalMinGround) {
          globalMinGround = gridGround[i];
        }
      }
      if (globalMinGround === Infinity) globalMinGround = 0.0;
    }

    // Pass 2: Invalidate candidate cells that are elevated significantly above nearby confident ground
    // (these are elevated tree canopies covering an entire cell)
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const idx = gy * gridW + gx;
        if (gridIsConfidentGround[idx] === 0 && !isNaN(gridGround[idx])) {
          let nearGroundSum = 0;
          let nearGroundCount = 0;

          for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
              const ny = gy + dy;
              const nx = gx + dx;
              if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
                const nIdx = ny * gridW + nx;
                if (gridIsConfidentGround[nIdx] === 1) {
                  nearGroundSum += gridGround[nIdx];
                  nearGroundCount++;
                }
              }
            }
          }

          if (nearGroundCount > 0) {
            const expectedGround = nearGroundSum / nearGroundCount;
            // If cell elevation is > 2.0m above expected ground, it's an elevated canopy, not ground!
            if (gridGround[idx] - expectedGround > 2.0) {
              gridGround[idx] = NaN; // Mark for spatial neighbor interpolation
            }
          }
        }
      }
    }

    // Pass 3: Fill any NaN cells with smooth distance-weighted neighbor interpolation
    for (let gy = 0; gy < gridH; gy++) {
      for (let gx = 0; gx < gridW; gx++) {
        const idx = gy * gridW + gx;
        if (isNaN(gridGround[idx])) {
          let sum = 0;
          let weightSum = 0;
          for (let dy = -3; dy <= 3; dy++) {
            for (let dx = -3; dx <= 3; dx++) {
              const ny = gy + dy;
              const nx = gx + dx;
              if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
                const nVal = gridGround[ny * gridW + nx];
                if (!isNaN(nVal)) {
                  const dist = Math.hypot(dx, dy) || 1.0;
                  const w = 1.0 / dist;
                  sum += nVal * w;
                  weightSum += w;
                }
              }
            }
          }
          gridGround[idx] = weightSum > 0 ? sum / weightSum : globalMinGround;
        }
      }
    }

    // Pass 4: Bilinear interpolation across all pixels to reconstruct smooth DTM
    for (let y = 0; y < height; y++) {
      const gyFloat = y / step;
      const gy0 = Math.floor(gyFloat);
      const gy1 = Math.min(gridH - 1, gy0 + 1);
      const ty = gyFloat - gy0;

      for (let x = 0; x < width; x++) {
        const gxFloat = x / step;
        const gx0 = Math.floor(gxFloat);
        const gx1 = Math.min(gridW - 1, gx0 + 1);
        const tx = gxFloat - gx0;

        const v00 = gridGround[gy0 * gridW + gx0];
        const v10 = gridGround[gy0 * gridW + gx1];
        const v01 = gridGround[gy1 * gridW + gx0];
        const v11 = gridGround[gy1 * gridW + gx1];

        const interp = (1 - ty) * ((1 - tx) * v00 + tx * v10) + ty * ((1 - tx) * v01 + tx * v11);
        dtm[y * width + x] = interp;
      }
    }

    return dtm;
  }

  /**
   * Estimate discrete individual trees by clustering connected canopy pixels.
   */
  private estimateTreeCount(
    classificationMap: Uint8Array,
    width: number,
    height: number,
    pixelAreaM2: number
  ): number {
    const visited = new Uint8Array(width * height);
    let treeCount = 0;

    for (let y = 0; y < height; y++) {
      const rowOffset = y * width;
      for (let x = 0; x < width; x++) {
        const idx = rowOffset + x;
        if (classificationMap[idx] === FoliageClass.TREE_CANOPY && visited[idx] === 0) {
          // Breadth-first search for connected canopy cluster
          let clusterPixelCount = 0;
          const queue: number[] = [idx];
          visited[idx] = 1;

          while (queue.length > 0) {
            const curr = queue.pop()!;
            clusterPixelCount++;
            const cx = curr % width;
            const cy = Math.floor(curr / width);

            // 4-neighborhood
            const neighbors = [
              cx > 0 ? curr - 1 : -1,
              cx < width - 1 ? curr + 1 : -1,
              cy > 0 ? curr - width : -1,
              cy < height - 1 ? curr + width : -1
            ];

            for (const n of neighbors) {
              if (n >= 0 && visited[n] === 0 && classificationMap[n] === FoliageClass.TREE_CANOPY) {
                visited[n] = 1;
                queue.push(n);
              }
            }
          }

          // A valid tree canopy cluster must have at least 4 pixels or 0.25 m^2
          const clusterArea = clusterPixelCount * pixelAreaM2;
          const minClusterArea = Math.min(0.25, 4 * pixelAreaM2);
          if (clusterArea >= minClusterArea) {
            const treesInCluster = Math.max(1, Math.round(clusterArea / 25.0));
            treeCount += treesInCluster;
          }
        }
      }
    }

    return treeCount;
  }

  /**
   * Query pixel class from geodetic coordinates.
   */
  private queryPixelClass(
    lat: number,
    lng: number,
    metadata: GeoTiffRasterMetadata,
    map: Uint8Array
  ): FoliageClass {
    const { u, v } = this.latLngToPixel(lat, lng, metadata);
    if (u < 0 || u >= metadata.width || v < 0 || v >= metadata.height) {
      return FoliageClass.UNKNOWN;
    }
    return map[v * metadata.width + u] as FoliageClass;
  }

  /**
   * Query pixel float value from geodetic coordinates.
   */
  private queryPixelFloat(
    lat: number,
    lng: number,
    metadata: GeoTiffRasterMetadata,
    grid: Float32Array
  ): number {
    const { u, v } = this.latLngToPixel(lat, lng, metadata);
    if (u < 0 || u >= metadata.width || v < 0 || v >= metadata.height) {
      return 0.0;
    }
    return grid[v * metadata.width + u];
  }

  /**
   * Convert geodetic (lat, lng) to pixel (u, v) raster coordinates.
   */
  public latLngToPixel(
    lat: number,
    lng: number,
    metadata: GeoTiffRasterMetadata
  ): { u: number; v: number } {
    const tieX = metadata.tiePoint.x;
    const tieY = metadata.tiePoint.y;
    const scaleX = metadata.pixelScale.scaleX;
    const scaleY = metadata.pixelScale.scaleY;

    if (scaleX >= 0.001) {
      // Pixel scale is in meters; tie point is geodetic WGS-84
      const metersPerDegreeLat = 111000.0;
      const metersPerDegreeLng = 111000.0 * Math.cos((tieY * Math.PI) / 180.0);
      const dEastMeters = (lng - tieX) * metersPerDegreeLng;
      const dNorthMeters = (tieY - lat) * metersPerDegreeLat;
      const u = Math.round(dEastMeters / scaleX);
      const v = Math.round(dNorthMeters / scaleY);
      return { u, v };
    } else {
      // Direct angular degree scale
      const u = Math.round((lng - tieX) / scaleX);
      const v = Math.round((tieY - lat) / scaleY);
      return { u, v };
    }
  }

  /**
   * Generate a semantic RGB buffer for direct visualization or PNG encoding.
   */
  public generateSemanticRgbBuffer(result: FoliageSegmentationResult): Uint8Array {
    const { width, height, classificationMap } = result;
    const rgb = new Uint8Array(width * height * 3);

    for (let i = 0; i < classificationMap.length; i++) {
      const cls = classificationMap[i] as FoliageClass;
      const color = FOLIAGE_CLASS_COLORS[cls] || FOLIAGE_CLASS_COLORS[FoliageClass.UNKNOWN];
      const offset = i * 3;
      rgb[offset] = color[0];
      rgb[offset + 1] = color[1];
      rgb[offset + 2] = color[2];
    }

    return rgb;
  }
}
