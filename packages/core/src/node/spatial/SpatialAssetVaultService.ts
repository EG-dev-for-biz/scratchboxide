/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { ContentRepresentation4D } from '../../common/geospatial-4d-protocol';
import { LatLngAlt } from '../../common/coordinate/LocalTangentPlane';

export interface VaultMetadata {
  id: string;
  geohashToken: string;
  branchId: string;
  representation: ContentRepresentation4D;
  timestamp: string;
  bounds: {
    minLat: number; maxLat: number;
    minLng: number; maxLng: number;
  };
}

export class SpatialAssetVaultService {
  private vaultStore: Map<string, VaultMetadata> = new Map();

  constructor() {
    this.seedDefaultPresetCaches();
  }

  /**
   * Computes a standard 10-character geohash representing a coordinate bounding region.
   */
  public static computeGeohash(lat: number, lng: number, precision: number = 10): string {
    const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
    let minLat = -90.0, maxLat = 90.0;
    let minLng = -180.0, maxLng = 180.0;
    let geohash = '';
    let isEven = true;
    let bit = 0;
    let ch = 0;

    while (geohash.length < precision) {
      if (isEven) {
        const mid = (minLng + maxLng) / 2.0;
        if (lng > mid) {
          ch |= (1 << (4 - bit));
          minLng = mid;
        } else {
          maxLng = mid;
        }
      } else {
        const mid = (minLat + maxLat) / 2.0;
        if (lat > mid) {
          ch |= (1 << (4 - bit));
          minLat = mid;
        } else {
          maxLat = mid;
        }
      }

      isEven = !isEven;
      if (bit < 4) {
        bit++;
      } else {
        geohash += base32[ch];
        bit = 0;
        ch = 0;
      }
    }
    return geohash;
  }

  /**
   * Saves a baked 4D spatial representation into the vault.
   */
  public storeAsset(
    branchId: string,
    coords: LatLngAlt,
    asset: ContentRepresentation4D,
    boundingRadiusMeters: number = 50.0
  ): VaultMetadata {
    const lat = coords.lat;
    const lng = coords.lng;
    const geohashToken = SpatialAssetVaultService.computeGeohash(lat, lng, 10);
    const branchKey = branchId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const id = `vault-${branchKey}-${asset.type}-${geohashToken}-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    // Compute coordinate bbox delta (approx degrees from meters)
    const degDeltaLat = boundingRadiusMeters / 111000.0;
    const degDeltaLng = boundingRadiusMeters / (111000.0 * Math.cos((lat * Math.PI) / 180.0));

    const meta: VaultMetadata = {
      id,
      geohashToken,
      branchId,
      representation: asset,
      timestamp: new Date().toISOString(),
      bounds: {
        minLat: lat - degDeltaLat,
        maxLat: lat + degDeltaLat,
        minLng: lng - degDeltaLng,
        maxLng: lng + degDeltaLng
      }
    };

    this.vaultStore.set(id, meta);
    return meta;
  }

  /**
   * Retrieves an asset from the vault matching coordinates, radius, and multiverse branch ID.
   */
  public queryCachedAsset(
    branchId: string,
    coords: LatLngAlt,
    assetType?: ContentRepresentation4D['type']
  ): VaultMetadata | null {
    const lat = coords.lat;
    const lng = coords.lng;

    // Filter vault entries matching bounding box containment & branch constraints
    const matches = Array.from(this.vaultStore.values()).filter(meta => {
      if (meta.branchId !== branchId) return false;
      if (assetType && meta.representation.type !== assetType) return false;

      const b = meta.bounds;
      return lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng;
    });

    if (matches.length === 0) return null;

    // Return the latest matched record
    return matches.sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  }

  /**
   * Returns all stored asset records in the vault.
   */
  public getAllAssets(): VaultMetadata[] {
    return Array.from(this.vaultStore.values());
  }

  /**
   * Alias for getAllAssets()
   */
  public listAssets(): VaultMetadata[] {
    return this.getAllAssets();
  }

  /**
   * Seed static photorealistic assets into the vault.
   */
  private seedDefaultPresetCaches(): void {
    // 1. San Francisco Financial District real-world baseline
    this.storeAsset(
      'earth/main',
      { lat: 37.7940, lng: -122.4010, alt: 15.0 },
      {
        type: 'map-3d-tile',
        durableUri: 'https://tile.googleapis.com/v1/3dtiles/root.json',
        metadata: { title: 'Google Photorealistic 3D Tiles SF' }
      },
      500.0
    );

    // 2. Cyberpunk restyled baked splat
    this.storeAsset(
      'earth/cyberpunk',
      { lat: 37.7940, lng: -122.4010, alt: 15.0 },
      {
        type: 'gaussian-splat',
        durableUri: 'vault://splats/sf_fin_district_cyberpunk.spz',
        metadata: { pointCount: 1500000, title: 'Baked Cyberpunk Volumetric Radiance Field' }
      },
      150.0
    );

    // 3. Trained 4DGS Humanoid Characters (Cloud Run Trained)
    this.storeAsset(
      'humanoids/2785536',
      { lat: 37.7940, lng: -122.4010, alt: 0.0 },
      {
        type: 'gaussian-splat',
        durableUri: 'vault://humanoid/2785536',
        metadata: {
          title: 'Performer 4DGS Humanoid 2785536 (Stage Choreography)',
          splatCount: 121942,
          splatUri: '/models/humanoid_2785536.splat',
          glbUri: '/models/humanoid_2785536.glb',
          plyUri: '/models/performer_4dgs/demos/2785536/human_4dgs.ply',
          canonicalFrame: '/models/performer_4dgs/demos/2785536/canonical_frame.jpg'
        }
      },
      50.0
    );

    this.storeAsset(
      'humanoids/10331522',
      { lat: 37.7940, lng: -122.4010, alt: 0.0 },
      {
        type: 'gaussian-splat',
        durableUri: 'vault://humanoid/10331522',
        metadata: {
          title: 'Performer 4DGS Humanoid 10331522 (Performer Motion)',
          splatCount: 121944,
          splatUri: '/models/humanoid_10331522.splat',
          glbUri: '/models/humanoid_10331522.glb',
          plyUri: '/models/performer_4dgs/demos/10331522/human_4dgs.ply',
          canonicalFrame: '/models/performer_4dgs/demos/10331522/canonical_frame.jpg'
        }
      },
      50.0
    );

    this.storeAsset(
      'humanoids/5435720',
      { lat: 37.7940, lng: -122.4010, alt: 0.0 },
      {
        type: 'gaussian-splat',
        durableUri: 'vault://humanoid/5435720',
        metadata: {
          title: 'Performer 4DGS Humanoid 5435720 (Extended Motion)',
          splatCount: 121862,
          splatUri: '/models/humanoid_5435720.splat',
          glbUri: '/models/humanoid_5435720.glb',
          plyUri: '/models/performer_4dgs/demos/5435720/human_4dgs.ply',
          canonicalFrame: '/models/performer_4dgs/demos/5435720/canonical_frame.jpg'
        }
      },
      50.0
    );

    // 4. SB-Human Parametric Humanoid Body Models (Canonical .sbhuman v2 Standard)
    this.storeAsset(
      'body_models/sbhuman',
      { lat: 0.0, lng: 0.0, alt: 0.0 },
      {
        type: 'mesh-glb',
        durableUri: 'vault://body_models/sbhuman/neutral',
        metadata: {
          title: 'SB-Human Parametric Body Model',
          neutralUri: '/models/sbhuman_neutral.sbhuman',
          maleUri: '/models/sbhuman_male.sbhuman',
          femaleUri: '/models/sbhuman_female.sbhuman',
          numVertices: 10475
        }
      },
      10.0
    );

  }
}
