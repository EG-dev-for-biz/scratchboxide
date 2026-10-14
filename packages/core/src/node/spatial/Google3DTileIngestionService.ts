/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { LatLngAlt } from '../../common/coordinate/LocalTangentPlane';
import { ContentRepresentation4D } from '../../common/geospatial-4d-protocol';
import { SpatialAssetVaultService, VaultMetadata } from './SpatialAssetVaultService';
import { geocode3DTilesAddress } from './Google3DTileBlockoutPipelineService';
import { MissingInputError } from '../../common/errors/pipeline-errors';
import { assertUsableCoordinates } from '../../common/coordinate/parse-coordinates';

export interface NodeTileIngestionRequest {
  branchId?: string;
  locationQuery?: string;
  coords?: LatLngAlt;
  clayPreset?: string;
  radiusMeters?: number;
  zoom?: number;
  tags?: string[];
}

export interface NodeTileIngestionResponse {
  success: boolean;
  vaultId: string;
  geohash: string;
  geoAnchor: LatLngAlt;
  representation: ContentRepresentation4D & { clayPreset?: string };
  timestamp: string;
}

export class Google3DTileIngestionService {
  private vaultService: SpatialAssetVaultService;

  constructor(vaultService?: SpatialAssetVaultService) {
    this.vaultService = vaultService || new SpatialAssetVaultService();
  }

  /**
   * Resolves the place to store: explicit coordinates as given, otherwise one Google Places Text Search call
   * (geocode3DTilesAddress). There is no built-in place table and no default location; an unresolvable or
   * missing place throws. `alt` is present only when an elevation was stated; it is never guessed.
   */
  public async resolveCoordinates(queryOrCoords?: string | LatLngAlt): Promise<LatLngAlt> {
    if (typeof queryOrCoords === 'object' && queryOrCoords !== null) {
      assertUsableCoordinates(queryOrCoords.lat, queryOrCoords.lng, `${queryOrCoords.lat}, ${queryOrCoords.lng}`);
      return { lat: queryOrCoords.lat, lng: queryOrCoords.lng, ...(queryOrCoords.alt !== undefined ? { alt: queryOrCoords.alt } : {}) };
    }
    const query = typeof queryOrCoords === 'string' ? queryOrCoords.trim() : '';
    if (!query) {
      throw new MissingInputError('Google3DTileIngestionService', 'coords or locationQuery');
    }
    const anchor = await geocode3DTilesAddress(query);
    return { lat: anchor.lat, lng: anchor.lng, ...(anchor.elevation !== undefined ? { alt: anchor.elevation } : {}) };
  }

  /**
   * Ingests a 3D tile region, synthesizes durable representation, and stores it in the asset vault.
   */
  public async ingestAndStoreTileAsset(
    req: NodeTileIngestionRequest
  ): Promise<NodeTileIngestionResponse> {
    const branchId = req.branchId || 'main';
    const coords = await this.resolveCoordinates(req.coords || req.locationQuery);
    const radiusMeters = req.radiusMeters || 150;
    const clayPreset = req.clayPreset || 'warm-clay';
    const zoom = req.zoom || 17;

    const geohash = SpatialAssetVaultService.computeGeohash(coords.lat, coords.lng, 10);
    const durableUri = `map-3d://google-tiles/${coords.lat.toFixed(5)}_${coords.lng.toFixed(5)}?zoom=${zoom}&radius=${radiusMeters}&preset=${clayPreset}`;

    const representation: ContentRepresentation4D & { clayPreset?: string } = {
      type: 'map-3d',
      durableUri,
      mimeType: 'model/gltf-binary',
      clayPreset,
      metadata: {
        locationQuery: req.locationQuery,
        radiusMeters,
        zoom,
        clayPreset,
        ingestionEngine: 'Google3DTileIngestionService',
        tags: req.tags || ['3d-tiles', 'photorealistic', 'clay-shader']
      }
    };

    const vaultMeta: VaultMetadata = this.vaultService.storeAsset(
      branchId,
      coords,
      representation,
      radiusMeters
    );

    return {
      success: true,
      vaultId: vaultMeta.id,
      geohash,
      geoAnchor: coords,
      representation,
      timestamp: vaultMeta.timestamp
    };
  }
}
