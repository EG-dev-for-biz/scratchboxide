/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { LatLngAlt } from '../../common/coordinate/LocalTangentPlane';
import { ContentRepresentation4D } from '../../common/geospatial-4d-protocol';
import { SpatialAssetVaultService, VaultMetadata } from './SpatialAssetVaultService';

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

const BUILTIN_COORDINATES: Record<string, LatLngAlt> = {
  'san francisco ferry building': { lat: 37.7955, lng: -122.3937, alt: 3.5 },
  'coit tower': { lat: 37.8024, lng: -122.4058, alt: 84.0 },
  'golden gate bridge': { lat: 37.8199, lng: -122.4783, alt: 67.0 },
  'independence hall': { lat: 39.9489, lng: -75.1500, alt: 12.0 },
  'eiffel tower': { lat: 48.8584, lng: 2.2945, alt: 35.0 },
  'tokyo tower': { lat: 35.6586, lng: 139.7454, alt: 25.0 },
  'san francisco': { lat: 37.7749, lng: -122.4194, alt: 16.0 }
};

export class Google3DTileIngestionService {
  private vaultService: SpatialAssetVaultService;

  constructor(vaultService?: SpatialAssetVaultService) {
    this.vaultService = vaultService || new SpatialAssetVaultService();
  }

  /**
   * Resolves geodetic coordinates for a query or coordinates object.
   */
  public resolveCoordinates(queryOrCoords?: string | LatLngAlt): LatLngAlt {
    if (typeof queryOrCoords === 'object' && queryOrCoords !== null) {
      return {
        lat: queryOrCoords.lat,
        lng: queryOrCoords.lng,
        alt: queryOrCoords.alt ?? 0
      };
    }

    const q = (queryOrCoords || 'san francisco').toLowerCase().trim();

    // Check direct comma separated numbers
    const coordMatch = q.match(/^([-+]?[0-9]*\.?[0-9]+)[,\s]+([-+]?[0-9]*\.?[0-9]+)(?:[,\s]+([-+]?[0-9]*\.?[0-9]+))?$/);
    if (coordMatch) {
      return {
        lat: parseFloat(coordMatch[1]),
        lng: parseFloat(coordMatch[2]),
        alt: coordMatch[3] ? parseFloat(coordMatch[3]) : 0
      };
    }

    for (const [key, coords] of Object.entries(BUILTIN_COORDINATES)) {
      if (q === key || q.includes(key) || key.includes(q)) {
        return coords;
      }
    }

    return { lat: 37.7749, lng: -122.4194, alt: 10.0 };
  }

  /**
   * Ingests a 3D tile region, synthesizes durable representation, and stores it in the asset vault.
   */
  public async ingestAndStoreTileAsset(
    req: NodeTileIngestionRequest
  ): Promise<NodeTileIngestionResponse> {
    const branchId = req.branchId || 'main';
    const coords = req.coords || this.resolveCoordinates(req.locationQuery);
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
