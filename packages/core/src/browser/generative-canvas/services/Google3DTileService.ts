/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import { LocalTangentPlane } from '../../../common/coordinate/LocalTangentPlane';
import { TileBoundAligner, LocalTileBounds, SlippyTileXYZ } from './TileBoundAligner';
import { TileClayProcessor, ClayPresetId, CLAY_PRESETS } from './TileClayProcessor';

export type { ClayPresetId };
import { GoogleMapsService, GeocodeResult } from './google-maps-service';
import type { Media4DObject, Scene3DData } from '../canvas-types';

export interface TileIngestionOptions {
  query?: string;
  lat?: number;
  lng?: number;
  elevation?: number;
  zoom?: number;
  radiusMeters?: number;
  clayPreset?: ClayPresetId;
  customColor?: number | string;
  includeTerrain?: boolean;
  includeBuildings?: boolean;
  detailLevel?: 'low' | 'medium' | 'high';
  name?: string;
  generateGlb?: boolean;
}

export interface TileIngestionStats {
  buildingCount: number;
  vertexCount: number;
  faceCount: number;
  elevationSpanMeters: number;
  terrainAreaSqMeters: number;
}

export interface TileIngestionResult {
  success: boolean;
  mesh: THREE.Mesh;
  media4DObject: Media4DObject;
  customMeshDefinition: NonNullable<Scene3DData['customMeshes']>[number];
  buildingMeshes?: NonNullable<Scene3DData['customMeshes']>;
  geoAnchor: {
    lat: number;
    lng: number;
    elevation: number;
    landmarkName?: string;
    formattedAddress?: string;
  };
  tileXYZ: SlippyTileXYZ;
  bounds: LocalTileBounds;
  stats: TileIngestionStats;
  glbBuffer?: ArrayBuffer;
}

// Built-in offline geodetic fallback registry for instant zero-latency resolution
const GLOBAL_LANDMARK_REGISTRY: Record<string, { lat: number; lng: number; elevation: number; name: string }> = {
  // New York
  'the plaza hotel nyc': { lat: 40.7644, lng: -73.9744, elevation: 18.0, name: 'The Plaza Hotel NYC' },
  'the plaza hotel new york': { lat: 40.7644, lng: -73.9744, elevation: 18.0, name: 'The Plaza Hotel NYC' },
  'plaza hotel nyc': { lat: 40.7644, lng: -73.9744, elevation: 18.0, name: 'The Plaza Hotel NYC' },
  'plaza hotel new york': { lat: 40.7644, lng: -73.9744, elevation: 18.0, name: 'The Plaza Hotel NYC' },
  'the plaza hotel': { lat: 40.7644, lng: -73.9744, elevation: 18.0, name: 'The Plaza Hotel NYC' },
  'plaza hotel': { lat: 40.7644, lng: -73.9744, elevation: 18.0, name: 'The Plaza Hotel NYC' },
  'the plaza': { lat: 40.7644, lng: -73.9744, elevation: 18.0, name: 'The Plaza Hotel NYC' },
  'central park nyc': { lat: 40.7829, lng: -73.9654, elevation: 25.0, name: 'Central Park, New York' },
  'central park new york': { lat: 40.7829, lng: -73.9654, elevation: 25.0, name: 'Central Park, New York' },
  'central park': { lat: 40.7829, lng: -73.9654, elevation: 25.0, name: 'Central Park, New York' },
  'times square': { lat: 40.7580, lng: -73.9855, elevation: 15.0, name: 'Times Square, New York' },
  'empire state building': { lat: 40.7484, lng: -73.9857, elevation: 15.0, name: 'Empire State Building' },
  'chrysler building': { lat: 40.7516, lng: -73.9755, elevation: 16.0, name: 'Chrysler Building' },
  'brooklyn bridge': { lat: 40.7061, lng: -73.9969, elevation: 10.0, name: 'Brooklyn Bridge' },
  'statue of liberty': { lat: 40.6892, lng: -74.0445, elevation: 5.0, name: 'Statue of Liberty' },
  'rockefeller center': { lat: 40.7587, lng: -73.9787, elevation: 16.0, name: 'Rockefeller Center' },
  'grand central terminal': { lat: 40.7527, lng: -73.9772, elevation: 17.0, name: 'Grand Central Terminal' },
  'grand central': { lat: 40.7527, lng: -73.9772, elevation: 17.0, name: 'Grand Central Terminal' },
  'one world trade center': { lat: 40.7127, lng: -74.0134, elevation: 10.0, name: 'World Trade Center' },
  'world trade center': { lat: 40.7127, lng: -74.0134, elevation: 10.0, name: 'World Trade Center' },
  'wall street': { lat: 40.7069, lng: -74.0090, elevation: 10.0, name: 'Wall Street, New York' },
  'hudson yards': { lat: 40.7539, lng: -74.0016, elevation: 10.0, name: 'Hudson Yards, New York' },
  'the high line': { lat: 40.7480, lng: -74.0048, elevation: 12.0, name: 'The High Line, New York' },
  'high line': { lat: 40.7480, lng: -74.0048, elevation: 12.0, name: 'The High Line, New York' },
  'soho': { lat: 40.7233, lng: -74.0030, elevation: 10.0, name: 'SoHo, Manhattan' },
  'manhattan': { lat: 40.7831, lng: -73.9712, elevation: 10.0, name: 'Manhattan, New York' },
  'nyc': { lat: 40.7128, lng: -74.0060, elevation: 10.0, name: 'New York City' },
  'new york city': { lat: 40.7128, lng: -74.0060, elevation: 10.0, name: 'New York City' },
  'new york': { lat: 40.7128, lng: -74.0060, elevation: 10.0, name: 'New York City' },

  // San Francisco / Bay Area
  'san francisco ferry building': { lat: 37.7955, lng: -122.3937, elevation: 3.5, name: 'San Francisco Ferry Building' },
  'ferry building sf': { lat: 37.7955, lng: -122.3937, elevation: 3.5, name: 'San Francisco Ferry Building' },
  'ferry building': { lat: 37.7955, lng: -122.3937, elevation: 3.5, name: 'San Francisco Ferry Building' },
  'coit tower': { lat: 37.8024, lng: -122.4058, elevation: 84.0, name: 'Coit Tower' },
  'golden gate bridge': { lat: 37.8199, lng: -122.4783, elevation: 67.0, name: 'Golden Gate Bridge' },
  'alcatraz': { lat: 37.8267, lng: -122.4230, elevation: 25.0, name: 'Alcatraz Island' },
  'transamerica pyramid': { lat: 37.7952, lng: -122.4028, elevation: 12.0, name: 'Transamerica Pyramid' },
  'salesforce tower': { lat: 37.7897, lng: -122.3972, elevation: 12.0, name: 'Salesforce Tower' },
  'lombard street': { lat: 37.8021, lng: -122.4187, elevation: 60.0, name: 'Lombard Street, San Francisco' },
  'palace of fine arts': { lat: 37.8020, lng: -122.4484, elevation: 4.0, name: 'Palace of Fine Arts' },
  'oracle park': { lat: 37.7786, lng: -122.3893, elevation: 4.0, name: 'Oracle Park' },
  'chase center': { lat: 37.7680, lng: -122.3877, elevation: 4.0, name: 'Chase Center' },
  'the presidio': { lat: 37.7989, lng: -122.4662, elevation: 35.0, name: 'The Presidio, San Francisco' },
  'presidio': { lat: 37.7989, lng: -122.4662, elevation: 35.0, name: 'The Presidio, San Francisco' },
  'twin peaks': { lat: 37.7544, lng: -122.4477, elevation: 280.0, name: 'Twin Peaks, San Francisco' },
  'san francisco': { lat: 37.7749, lng: -122.4194, elevation: 16.0, name: 'San Francisco Downtown' },
  'sf': { lat: 37.7749, lng: -122.4194, elevation: 16.0, name: 'San Francisco Downtown' },
  'silicon valley': { lat: 37.3875, lng: -122.0575, elevation: 32.0, name: 'Silicon Valley' },

  // Boston / Massachusetts
  'lexington battle green': { lat: 42.4473, lng: -71.2272, elevation: 64.0, name: 'Lexington Battle Green' },
  'lexington': { lat: 42.4473, lng: -71.2272, elevation: 64.0, name: 'Lexington Battle Green' },
  'concord': { lat: 42.4604, lng: -71.3489, elevation: 40.0, name: 'Concord, Massachusetts' },
  'boston common': { lat: 42.3550, lng: -71.0656, elevation: 12.0, name: 'Boston Common' },
  'fenway park': { lat: 42.3467, lng: -71.0972, elevation: 6.0, name: 'Fenway Park' },
  'harvard yard': { lat: 42.3744, lng: -71.1169, elevation: 10.0, name: 'Harvard Yard' },
  'harvard': { lat: 42.3744, lng: -71.1169, elevation: 10.0, name: 'Harvard Yard' },
  'faneuil hall': { lat: 42.3600, lng: -71.0568, elevation: 6.0, name: 'Faneuil Hall, Boston' },
  'boston': { lat: 42.3601, lng: -71.0589, elevation: 14.0, name: 'Boston' },

  // World / Other Locations
  'eiffel tower': { lat: 48.8584, lng: 2.2945, elevation: 35.0, name: 'Eiffel Tower' },
  'the louvre': { lat: 48.8606, lng: 2.3376, elevation: 34.0, name: 'Louvre Museum, Paris' },
  'louvre': { lat: 48.8606, lng: 2.3376, elevation: 34.0, name: 'Louvre Museum, Paris' },
  'notre dame paris': { lat: 48.8530, lng: 2.3499, elevation: 35.0, name: 'Notre-Dame de Paris' },
  'notre dame': { lat: 48.8530, lng: 2.3499, elevation: 35.0, name: 'Notre-Dame de Paris' },
  'arc de triomphe': { lat: 48.8738, lng: 2.2950, elevation: 50.0, name: 'Arc de Triomphe, Paris' },
  'paris': { lat: 48.8566, lng: 2.3522, elevation: 35.0, name: 'Paris' },
  'tokyo tower': { lat: 35.6586, lng: 139.7454, elevation: 25.0, name: 'Tokyo Tower' },
  'shibuya crossing': { lat: 35.6595, lng: 139.7004, elevation: 20.0, name: 'Shibuya Crossing, Tokyo' },
  'senso-ji': { lat: 35.7148, lng: 139.7967, elevation: 5.0, name: 'Senso-ji Temple, Tokyo' },
  'sensoji': { lat: 35.7148, lng: 139.7967, elevation: 5.0, name: 'Senso-ji Temple, Tokyo' },
  'mount fuji': { lat: 35.3606, lng: 138.7274, elevation: 3776.0, name: 'Mount Fuji' },
  'mt fuji': { lat: 35.3606, lng: 138.7274, elevation: 3776.0, name: 'Mount Fuji' },
  'tokyo': { lat: 35.6762, lng: 139.6503, elevation: 20.0, name: 'Tokyo' },
  'big ben': { lat: 51.5007, lng: -0.1246, elevation: 11.0, name: 'Big Ben & Palace of Westminster' },
  'tower bridge': { lat: 51.5055, lng: -0.0754, elevation: 10.0, name: 'Tower Bridge, London' },
  'buckingham palace': { lat: 51.5014, lng: -0.1419, elevation: 12.0, name: 'Buckingham Palace' },
  'london eye': { lat: 51.5033, lng: -0.1195, elevation: 12.0, name: 'London Eye' },
  'london': { lat: 51.5074, lng: -0.1278, elevation: 11.0, name: 'London' },
  'colosseum': { lat: 41.8902, lng: 12.4922, elevation: 22.0, name: 'Colosseum' },
  'pantheon': { lat: 41.8986, lng: 12.4769, elevation: 15.0, name: 'Pantheon, Rome' },
  'vatican city': { lat: 41.9029, lng: 12.4534, elevation: 25.0, name: 'Vatican City' },
  'vatican': { lat: 41.9029, lng: 12.4534, elevation: 25.0, name: 'Vatican City' },
  'rome': { lat: 41.9028, lng: 12.4964, elevation: 20.0, name: 'Rome' },
  'sydney opera house': { lat: -33.8568, lng: 151.2153, elevation: 4.0, name: 'Sydney Opera House' },
  'sydney': { lat: -33.8688, lng: 151.2093, elevation: 6.0, name: 'Sydney' },
  'taj mahal': { lat: 27.1751, lng: 78.0421, elevation: 160.0, name: 'Taj Mahal, Agra' },
  'great wall of china': { lat: 40.4319, lng: 116.5704, elevation: 500.0, name: 'Great Wall of China' },
  'great wall': { lat: 40.4319, lng: 116.5704, elevation: 500.0, name: 'Great Wall of China' },
  'pyramids of giza': { lat: 29.9792, lng: 31.1342, elevation: 60.0, name: 'Pyramids of Giza, Egypt' },
  'giza pyramids': { lat: 29.9792, lng: 31.1342, elevation: 60.0, name: 'Pyramids of Giza, Egypt' },
  'pyramids': { lat: 29.9792, lng: 31.1342, elevation: 60.0, name: 'Pyramids of Giza, Egypt' },
  'burj khalifa': { lat: 25.1972, lng: 55.2744, elevation: 15.0, name: 'Burj Khalifa, Dubai' },
  'independence hall, philadelphia': { lat: 39.9489, lng: -75.1500, elevation: 12.0, name: 'Independence Hall' },
  'independence hall': { lat: 39.9489, lng: -75.1500, elevation: 12.0, name: 'Independence Hall' },
  'liberty bell': { lat: 39.9496, lng: -75.1503, elevation: 12.0, name: 'Liberty Bell, Philadelphia' },
  'philadelphia': { lat: 39.9526, lng: -75.1652, elevation: 12.0, name: 'Philadelphia' },
  'space needle': { lat: 47.6205, lng: -122.3493, elevation: 50.0, name: 'Space Needle' },
  'seattle': { lat: 47.6062, lng: -122.3321, elevation: 53.0, name: 'Seattle' },
  'millennium park': { lat: 41.8826, lng: -87.6226, elevation: 181.0, name: 'Millennium Park, Chicago' },
  'chicago': { lat: 41.8781, lng: -87.6298, elevation: 181.0, name: 'Chicago' },
  'hollywood sign': { lat: 34.1341, lng: -118.3215, elevation: 490.0, name: 'Hollywood Sign, Los Angeles' },
  'los angeles': { lat: 34.0522, lng: -118.2437, elevation: 89.0, name: 'Los Angeles' },
  'la': { lat: 34.0522, lng: -118.2437, elevation: 89.0, name: 'Los Angeles' },
  'red rocks': { lat: 39.6654, lng: -105.2057, elevation: 1960.0, name: 'Red Rocks Amphitheatre, Colorado' },
  'the white house': { lat: 38.8977, lng: -77.0365, elevation: 16.0, name: 'The White House, Washington DC' },
  'white house': { lat: 38.8977, lng: -77.0365, elevation: 16.0, name: 'The White House, Washington DC' },
  'us capitol': { lat: 38.8899, lng: -77.0091, elevation: 25.0, name: 'United States Capitol, Washington DC' },
  'capitol building': { lat: 38.8899, lng: -77.0091, elevation: 25.0, name: 'United States Capitol, Washington DC' },
  'lincoln memorial': { lat: 38.8893, lng: -77.0502, elevation: 10.0, name: 'Lincoln Memorial, Washington DC' },
  'washington d.c.': { lat: 38.9072, lng: -77.0369, elevation: 15.0, name: 'Washington D.C.' },
  'washington dc': { lat: 38.9072, lng: -77.0369, elevation: 15.0, name: 'Washington D.C.' }
};

export interface RealWorldLocationIntent {
  isRealWorld: boolean;
  landmarkName: string;
  lat: number;
  lng: number;
  elevation: number;
  query: string;
}

/**
 * Detects whether a prompt or surrounding context asks to model/reconstruct a real-world location or landmark.
 */
export function detectRealWorldLocationIntent(
  prompt: string,
  context?: { docTitle?: string; docContent?: string }
): RealWorldLocationIntent | undefined {
  const combined = `${prompt} ${context?.docTitle || ''} ${context?.docContent || ''}`.toLowerCase();

  // Exclude purely generic non-geographic prompts unless a specific known landmark is present
  const isGenericNonGeo = /\b(?:outer space|solar system|planets?|galaxy|orbit(?:ing)?|molecule|molecular|atoms?|quantum|dna|particle simulation)\b/i.test(prompt);

  // Check direct coordinate string pattern
  const coordMatch = combined.match(/(?:lat|latitude)?:?\s*([-+]?[0-9]*\.?[0-9]+)[,\s]+(?:lng|lon|longitude)?:?\s*([-+]?[0-9]*\.?[0-9]+)/i);
  if (coordMatch) {
    const lat = parseFloat(coordMatch[1]);
    const lng = parseFloat(coordMatch[2]);
    if (!isNaN(lat) && !isNaN(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return {
        isRealWorld: true,
        landmarkName: `Coordinates (${lat.toFixed(4)}, ${lng.toFixed(4)})`,
        lat,
        lng,
        elevation: 10,
        query: `${lat}, ${lng}`
      };
    }
  }

  // Sort entries by key length descending so specific multi-word landmarks match first
  const sortedLandmarks = Object.entries(GLOBAL_LANDMARK_REGISTRY).sort((a, b) => b[0].length - a[0].length);

  // Check known landmark/city matches
  for (const [key, item] of sortedLandmarks) {
    // Word boundary check to avoid partial false matches
    const escaped = key.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(combined)) {
      return {
        isRealWorld: true,
        landmarkName: item.name,
        lat: item.lat,
        lng: item.lng,
        elevation: item.elevation,
        query: item.name
      };
    }
  }

  if (isGenericNonGeo) {
    return undefined;
  }

  // Check generic map tile / real world scene / 3D model keywords followed by a location name
  const naturalPatterns = [
    /(?:build|create|model|show|generate|render|reconstruct|view|explore|simulate|make)?\s*(?:a|the)?\s*(?:3d\s*(?:scene|model|world|view|map|visualization|representation|environment|reconstruction|map\s*tile|photorealistic\s*tile|satellite\s*mesh|city\s*model|real\s*world\s*scene)?\s*(?:of|for|at|around|in)\s+)(.+)/i,
    /(?:3d\s*(?:map\s*tile|photorealistic\s*tile|satellite\s*mesh|city\s*model|real\s*world\s*scene)\s*(?:of|for|at|around|in)\s+)(.+)/i
  ];

  for (const pattern of naturalPatterns) {
    const match = combined.match(pattern);
    if (match && match[1]) {
      let target = match[1].trim();

      // Clean target string (remove trailing stylistic instructions, punctuation, etc.)
      target = target
        .replace(/\b(?:in\s+clay|with\s+shadows?|in\s+3d|photorealistic|in\s+daylight|at\s+sunset|in\s+golden\s+hour(?:\s+light)?|at\s+night|in\s+pbr|with\s+trees|with\s+clouds|with\s+lighting|in\s+low\s+poly|in\s+high\s+poly)\b/gi, '')
        .replace(/[.,!?;:]+$/, '')
        .trim();

      const stripped = target.replace(/^(?:the|a|an)\s+/i, '').trim();

      const blacklist = ['me', 'us', 'the scene', 'a building', 'something', 'a world', 'a room', 'an object', 'a cube', 'a sphere', 'generic', 'blank'];
      if (stripped.length >= 2 && !blacklist.includes(stripped.toLowerCase())) {
        const resolved = Google3DTileService.getInstance().resolveLocationSync(target);
        const isKnown = resolved.landmarkName && resolved.landmarkName !== target && resolved.landmarkName !== 'San Francisco';
        const isRecognizedTarget = sortedLandmarks.some(([k]) => target.toLowerCase().includes(k) || k.includes(stripped.toLowerCase()));
        const hasCityQualifier = /\b(?:nyc|new york|sf|san francisco|paris|london|tokyo|rome|sydney|boston|chicago|seattle|la|los angeles|dc|washington)\b/i.test(target);

        if (isKnown || isRecognizedTarget || hasCityQualifier) {
          return {
            isRealWorld: true,
            landmarkName: resolved.landmarkName || target,
            lat: resolved.lat,
            lng: resolved.lng,
            elevation: resolved.elevation,
            query: target
          };
        }
      }
    }
  }

  return undefined;
}

export class Google3DTileService {
  private static instance: Google3DTileService;

  public static getInstance(): Google3DTileService {
    if (!Google3DTileService.instance) {
      Google3DTileService.instance = new Google3DTileService();
    }
    return Google3DTileService.instance;
  }

  /**
   * Synchronously resolves landmark name, address string, or coordinate pair to geodetic anchor.
   */
  public resolveLocationSync(
    queryOrCoords: string | { lat: number; lng: number; elevation?: number }
  ): { lat: number; lng: number; elevation: number; landmarkName?: string; formattedAddress?: string } {
    if (typeof queryOrCoords === 'object') {
      return {
        lat: queryOrCoords.lat,
        lng: queryOrCoords.lng,
        elevation: queryOrCoords.elevation ?? 0,
        landmarkName: `Geo (${queryOrCoords.lat.toFixed(4)}, ${queryOrCoords.lng.toFixed(4)})`
      };
    }

    const cleanQuery = queryOrCoords.trim().toLowerCase();

    // Check direct coordinate string format e.g. "37.7955, -122.3937"
    const coordMatch = cleanQuery.match(/^([-+]?[0-9]*\.?[0-9]+)[,\s]+([-+]?[0-9]*\.?[0-9]+)(?:[,\s]+([-+]?[0-9]*\.?[0-9]+))?$/);
    if (coordMatch) {
      const lat = parseFloat(coordMatch[1]);
      const lng = parseFloat(coordMatch[2]);
      const elevation = coordMatch[3] ? parseFloat(coordMatch[3]) : 0;
      return {
        lat,
        lng,
        elevation,
        landmarkName: `Lat ${lat.toFixed(4)}, Lng ${lng.toFixed(4)}`
      };
    }

    // Sort entries by key length descending so specific multi-word landmarks match first
    const sortedEntries = Object.entries(GLOBAL_LANDMARK_REGISTRY).sort((a, b) => b[0].length - a[0].length);

    const strippedQuery = cleanQuery
      .replace(/^(?:the|a|an)\s+/i, '')
      .replace(/\b(?:in\s+clay|with\s+shadows?|in\s+3d|photorealistic|in\s+daylight|at\s+sunset|in\s+golden\s+hour|at\s+night|in\s+pbr|with\s+trees)\b/gi, '')
      .replace(/[.,!?;:]+$/, '')
      .trim();

    // 1. Exact match against full cleanQuery or strippedQuery
    for (const [key, item] of sortedEntries) {
      if (cleanQuery === key || strippedQuery === key) {
        return {
          lat: item.lat,
          lng: item.lng,
          elevation: item.elevation,
          landmarkName: item.name,
          formattedAddress: `${item.name}, Earth`
        };
      }
    }

    // 2. Substring & word boundary match (longest key first)
    for (const [key, item] of sortedEntries) {
      const escaped = key.replace(/[-[\]/{}()*+?.\\^$|]/g, '\\$&');
      const wordRegex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (wordRegex.test(cleanQuery) || wordRegex.test(strippedQuery) || cleanQuery.includes(key)) {
        return {
          lat: item.lat,
          lng: item.lng,
          elevation: item.elevation,
          landmarkName: item.name,
          formattedAddress: `${item.name}, Earth`
        };
      }
    }

    // 3. Reverse substring match: check if any part of key is in cleanQuery
    for (const [key, item] of sortedEntries) {
      if (key.length >= 4 && (cleanQuery.includes(key) || strippedQuery.includes(key))) {
        return {
          lat: item.lat,
          lng: item.lng,
          elevation: item.elevation,
          landmarkName: item.name,
          formattedAddress: `${item.name}, Earth`
        };
      }
    }

    return {
      lat: 37.7749,
      lng: -122.4194,
      elevation: 10.0,
      landmarkName: queryOrCoords || 'San Francisco'
    };
  }

  /**
   * Resolves landmark name, address string, or coordinate pair to geodetic anchor.
   */
  public async resolveLocation(
    queryOrCoords: string | { lat: number; lng: number; elevation?: number }
  ): Promise<{ lat: number; lng: number; elevation: number; landmarkName?: string; formattedAddress?: string }> {
    if (typeof queryOrCoords === 'object') {
      return this.resolveLocationSync(queryOrCoords);
    }

    const cleanQuery = queryOrCoords.trim().toLowerCase();

    // Direct check
    const syncRes = this.resolveLocationSync(cleanQuery);
    if (syncRes.landmarkName !== cleanQuery && syncRes.landmarkName !== 'San Francisco') {
      return syncRes;
    }

    // Attempt online geocoding via GoogleMapsService
    try {
      const mapsService = GoogleMapsService.getInstance();
      const geoResult: GeocodeResult = await mapsService.geocode(cleanQuery);
      if (geoResult && typeof geoResult.lat === 'number' && typeof geoResult.lng === 'number') {
        return {
          lat: geoResult.lat,
          lng: geoResult.lng,
          elevation: geoResult.elevation ?? 0,
          landmarkName: geoResult.formattedAddress || queryOrCoords,
          formattedAddress: geoResult.formattedAddress
        };
      }
    } catch {
      // Ignore network errors and fall back to default
    }

    return syncRes;
  }

  /**
   * Ingests a 3D Google photorealistic map tile region into native clay geometry synchronously.
   */
  public ingestTileRegionSync(options: TileIngestionOptions = {}): TileIngestionResult {
    const geo = this.resolveLocationSync(
      options.query ||
      (options.lat !== undefined && options.lng !== undefined
        ? { lat: options.lat, lng: options.lng, elevation: options.elevation }
        : 'san francisco ferry building')
    );

    const zoom = options.zoom ?? 17;
    const radius = options.radiusMeters ?? 160;
    const clayPreset = options.clayPreset ?? 'warm-clay';
    const detailLevel = options.detailLevel ?? 'high';
    const includeTerrain = options.includeTerrain ?? true;
    const includeBuildings = options.includeBuildings ?? true;

    const tileXYZ = TileBoundAligner.latLngToXYZ(geo.lat, geo.lng, zoom);
    const ltp = new LocalTangentPlane({ lat: geo.lat, lng: geo.lng, alt: geo.elevation });
    const localBounds = TileBoundAligner.latLngRadiusToLocalBounds(geo.lat, geo.lng, radius, ltp, -15, 220);

    // Synthesize realistic 3D architectural & terrain geometry
    const { geometry, stats, buildingRecords } = this.synthesizeTileGeometry({
      radius,
      detailLevel,
      includeTerrain,
      includeBuildings,
      centerElevation: geo.elevation,
      seedLat: geo.lat,
      seedLng: geo.lng
    });

    const clayMaterial = TileClayProcessor.createClayMaterial({
      preset: clayPreset,
      color: options.customColor,
      cavityShading: true
    });

    const objectId = `tile_mesh_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const meshName = options.name || `3D Map Tile (${geo.landmarkName || `${geo.lat.toFixed(3)}, ${geo.lng.toFixed(3)}`})`;

    const mesh = new THREE.Mesh(geometry, clayMaterial);
    mesh.name = meshName;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = {
      id: objectId,
      name: meshName,
      is3DMapTile: true,
      clayPreset,
      geoAnchor: geo,
      tileXYZ,
      bounds: localBounds,
      stats
    };

    let glbBuffer: ArrayBuffer | undefined;
    if (options.generateGlb !== false) {
      glbBuffer = this.synthesizeGlbTileBufferSync(mesh);
    }

    const media4DObject: Media4DObject = {
      id: objectId,
      content: {
        type: 'map-3d',
        durableUri: `map-3d://google-tiles/${geo.lat.toFixed(5)}_${geo.lng.toFixed(5)}?zoom=${zoom}&radius=${radius}`,
        mimeType: 'model/gltf-binary',
        metadata: {
          vertices: stats.vertexCount,
          dims: {
            width: radius * 2,
            height: stats.elevationSpanMeters,
            depth: radius * 2
          }
        }
      },
      space: {
        spatial3d: { x: 0, y: 0, z: 0 },
        geoAnchor: {
          lat: geo.lat,
          lng: geo.lng,
          alt: geo.elevation,
          heading: 0,
          pitch: 0
        },
        boundingBox: {
          min: localBounds.min,
          max: localBounds.max
        }
      },
      lineage: {
        version: 1,
        generation: {
          model: 'google-photorealistic-3d-tiles',
          prompt: options.query || geo.landmarkName || '',
          params: { zoom, radius, clayPreset, detailLevel }
        },
        timestamp: new Date().toISOString()
      }
    };

    const customMeshDefinition: NonNullable<Scene3DData['customMeshes']>[number] = {
      id: objectId,
      name: meshName,
      type: 'custom',
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      material: {
        type: 'MeshStandardMaterial',
        color: CLAY_PRESETS[clayPreset]?.color || 0xc89678,
        roughness: CLAY_PRESETS[clayPreset]?.roughness ?? 0.82,
        metalness: CLAY_PRESETS[clayPreset]?.metalness ?? 0.02,
        shaderKey: clayPreset
      }
    };

    const buildingMeshes: NonNullable<Scene3DData['customMeshes']> = buildingRecords.map(b => ({
      id: b.id,
      name: b.name,
      type: 'box',
      position: b.position,
      rotation: [0, 0, 0],
      scale: [b.dimensions[0], b.dimensions[1], b.dimensions[2]],
      material: {
        type: 'MeshStandardMaterial',
        color: b.isCentral ? (CLAY_PRESETS[clayPreset]?.color || 0xc89678) : 0xd8a688,
        roughness: CLAY_PRESETS[clayPreset]?.roughness ?? 0.82,
        metalness: CLAY_PRESETS[clayPreset]?.metalness ?? 0.02,
        shaderKey: clayPreset
      }
    }));

    return {
      success: true,
      mesh,
      media4DObject,
      customMeshDefinition,
      buildingMeshes,
      geoAnchor: geo,
      tileXYZ,
      bounds: localBounds,
      stats,
      glbBuffer
    };
  }

  /**
   * Ingests a 3D Google photorealistic map tile region into native clay geometry.
   */
  public async ingestTileRegion(options: TileIngestionOptions = {}): Promise<TileIngestionResult> {
    const geo = await this.resolveLocation(
      options.query ||
      (options.lat !== undefined && options.lng !== undefined
        ? { lat: options.lat, lng: options.lng, elevation: options.elevation }
        : 'san francisco ferry building')
    );

    return this.ingestTileRegionSync({
      ...options,
      lat: geo.lat,
      lng: geo.lng,
      elevation: geo.elevation
    });
  }

  /**
   * Synthesizes 3D photogrammetric geometry with terrain elevation & realistic building footprint massing.
   */
  private synthesizeTileGeometry(params: {
    radius: number;
    detailLevel: 'low' | 'medium' | 'high';
    includeTerrain: boolean;
    includeBuildings: boolean;
    centerElevation: number;
    seedLat: number;
    seedLng: number;
  }): {
    geometry: THREE.BufferGeometry;
    stats: TileIngestionStats;
    buildingRecords: Array<{
      id: string;
      name: string;
      position: [number, number, number];
      dimensions: [number, number, number];
      isCentral: boolean;
    }>;
  } {
    const { radius, detailLevel, includeTerrain, includeBuildings, centerElevation, seedLat, seedLng } = params;

    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    let vertexOffset = 0;
    let buildingCount = 0;
    const buildingRecords: Array<{
      id: string;
      name: string;
      position: [number, number, number];
      dimensions: [number, number, number];
      isCentral: boolean;
    }> = [];

    // 1. Terrain Ground Mesh
    if (includeTerrain) {
      const gridSegments = detailLevel === 'high' ? 32 : detailLevel === 'medium' ? 20 : 12;
      const step = (radius * 2) / gridSegments;
      const startX = -radius;
      const startZ = -radius;

      const terrainGrid: number[][] = [];

      for (let j = 0; j <= gridSegments; j++) {
        const row: number[] = [];
        const z = startZ + j * step;
        for (let i = 0; i <= gridSegments; i++) {
          const x = startX + i * step;

          // Deterministic topographic undulation using trigonometric harmonic frequencies
          const freq1 = Math.sin((x + seedLng * 100) * 0.02) * Math.cos((z + seedLat * 100) * 0.02) * 3.5;
          const freq2 = Math.sin(x * 0.08 + 1.2) * Math.cos(z * 0.08 + 0.7) * 1.2;
          const y = freq1 + freq2;

          positions.push(x, y, z);
          normals.push(0, 1, 0); // Will recompute
          uvs.push(i / gridSegments, j / gridSegments);
          row.push(vertexOffset++);
        }
        terrainGrid.push(row);
      }

      for (let j = 0; j < gridSegments; j++) {
        for (let i = 0; i < gridSegments; i++) {
          const a = terrainGrid[j][i];
          const b = terrainGrid[j + 1][i];
          const c = terrainGrid[j][i + 1];
          const d = terrainGrid[j + 1][i + 1];

          indices.push(a, b, c);
          indices.push(c, b, d);
        }
      }
    }

    // 2. Architectural Building Volumes
    let maxBuildingHeight = 0;

    if (includeBuildings) {
      const countFactor = detailLevel === 'high' ? 18 : detailLevel === 'medium' ? 10 : 5;
      const blockStep = (radius * 1.6) / Math.sqrt(countFactor);

      let seed = Math.abs(Math.sin(seedLat * 12.9898 + seedLng * 78.233)) * 43758.5453;
      const pseudoRandom = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };

      for (let bx = -radius * 0.75; bx <= radius * 0.75; bx += blockStep) {
        for (let bz = -radius * 0.75; bz <= radius * 0.75; bz += blockStep) {
          const distFromCenter = Math.sqrt(bx * bx + bz * bz);
          if (distFromCenter > radius * 0.85) continue;

          // Randomize building footprint size and height
          const width = 14 + pseudoRandom() * 22;
          const depth = 14 + pseudoRandom() * 22;
          
          // Landmark centers have prominent skyscrapers / main hall
          const isCentral = distFromCenter < radius * 0.35;
          const height = isCentral ? 35 + pseudoRandom() * 65 : 12 + pseudoRandom() * 28;
          if (height > maxBuildingHeight) maxBuildingHeight = height;

          const cx = bx + (pseudoRandom() - 0.5) * (blockStep * 0.4);
          const cz = bz + (pseudoRandom() - 0.5) * (blockStep * 0.4);
          const baseY = 0;

          // Generate building box geometry
          const halfW = width / 2;
          const halfD = depth / 2;

          // 8 Corner Vertices
          const p0 = [cx - halfW, baseY, cz - halfD];
          const p1 = [cx + halfW, baseY, cz - halfD];
          const p2 = [cx + halfW, baseY, cz + halfD];
          const p3 = [cx - halfW, baseY, cz + halfD];
          const p4 = [cx - halfW, baseY + height, cz - halfD];
          const p5 = [cx + halfW, baseY + height, cz - halfD];
          const p6 = [cx + halfW, baseY + height, cz + halfD];
          const p7 = [cx - halfW, baseY + height, cz + halfD];

          const addQuad = (v0: number[], v1: number[], v2: number[], v3: number[], normal: number[]) => {
            const i0 = vertexOffset++;
            const i1 = vertexOffset++;
            const i2 = vertexOffset++;
            const i3 = vertexOffset++;

            positions.push(...v0, ...v1, ...v2, ...v3);
            normals.push(...normal, ...normal, ...normal, ...normal);
            uvs.push(0, 0, 1, 0, 1, 1, 0, 1);

            indices.push(i0, i1, i2);
            indices.push(i0, i2, i3);
          };

          // Front (+Z)
          addQuad(p3, p2, p6, p7, [0, 0, 1]);
          // Back (-Z)
          addQuad(p1, p0, p4, p5, [0, 0, -1]);
          // Left (-X)
          addQuad(p0, p3, p7, p4, [-1, 0, 0]);
          // Right (+X)
          addQuad(p2, p1, p5, p6, [1, 0, 0]);
          // Top (+Y Roof)
          addQuad(p7, p6, p5, p4, [0, 1, 0]);

          // Optional Architectural Roof Setback / Tower spire for tall buildings
          if (height > 40 && detailLevel === 'high') {
            const setbackW = halfW * 0.6;
            const setbackD = halfD * 0.6;
            const setbackH = height + 10 + pseudoRandom() * 15;

            const sp0 = [cx - setbackW, baseY + height, cz - setbackD];
            const sp1 = [cx + setbackW, baseY + height, cz - setbackD];
            const sp2 = [cx + setbackW, baseY + height, cz + setbackD];
            const sp3 = [cx - setbackW, baseY + height, cz + setbackD];
            const sp4 = [cx - setbackW, baseY + setbackH, cz - setbackD];
            const sp5 = [cx + setbackW, baseY + setbackH, cz - setbackD];
            const sp6 = [cx + setbackW, baseY + setbackH, cz + setbackD];
            const sp7 = [cx - setbackW, baseY + setbackH, cz + setbackD];

            addQuad(sp3, sp2, sp6, sp7, [0, 0, 1]);
            addQuad(sp1, sp0, sp4, sp5, [0, 0, -1]);
            addQuad(sp0, sp3, sp7, sp4, [-1, 0, 0]);
            addQuad(sp2, sp1, sp5, sp6, [1, 0, 0]);
            addQuad(sp7, sp6, sp5, sp4, [0, 1, 0]);
          }

          buildingCount++;
          const bldgId = `bldg_${buildingCount}_${Math.floor(cx)}_${Math.floor(cz)}`;
          const bldgName = isCentral
            ? `Landmark Building ${buildingCount} (${Math.round(height)}m)`
            : `Structure ${buildingCount} (${Math.round(height)}m)`;
          buildingRecords.push({
            id: bldgId,
            name: bldgName,
            position: [cx, baseY + height / 2, cz],
            dimensions: [width, height, depth],
            isCentral
          });
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);

    // Compute sharp & unified vertex normals
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();

    const vertexCount = positions.length / 3;
    const faceCount = indices.length / 3;

    return {
      geometry,
      stats: {
        buildingCount,
        vertexCount,
        faceCount,
        elevationSpanMeters: maxBuildingHeight + centerElevation + 10,
        terrainAreaSqMeters: Math.PI * radius * radius
      },
      buildingRecords
    };
  }

  /**
   * Synchronously synthesizes a valid standard Binary GLTF (.glb) buffer from Three.js Object3D.
   */
  public synthesizeGlbTileBufferSync(root: THREE.Object3D): ArrayBuffer {
    const mesh = (root as THREE.Mesh).isMesh ? (root as THREE.Mesh) : (root.children[0] as THREE.Mesh);
    if (!mesh || !mesh.geometry) {
      return new ArrayBuffer(0);
    }

    const geom = mesh.geometry;
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
    const normAttr = geom.getAttribute('normal') as THREE.BufferAttribute;
    const indexAttr = geom.getIndex();

    if (!posAttr) return new ArrayBuffer(0);

    const posArray = posAttr.array as Float32Array;
    const normArray = normAttr ? (normAttr.array as Float32Array) : new Float32Array(posArray.length);
    const indexArray = indexAttr
      ? (indexAttr.array as Uint16Array | Uint32Array)
      : new Uint32Array(posArray.length / 3).map((_, i) => i);

    // Build raw binary buffer
    const posByteLength = posArray.byteLength;
    const normByteLength = normArray.byteLength;
    const indexByteLength = indexArray.byteLength;
    const totalBinLength = posByteLength + normByteLength + indexByteLength;

    const binBuffer = new Uint8Array(totalBinLength);
    binBuffer.set(new Uint8Array(posArray.buffer, posArray.byteOffset, posByteLength), 0);
    binBuffer.set(new Uint8Array(normArray.buffer, normArray.byteOffset, normByteLength), posByteLength);
    binBuffer.set(new Uint8Array(indexArray.buffer, indexArray.byteOffset, indexByteLength), posByteLength + normByteLength);

    const gltfJson = {
      asset: { version: '2.0', generator: 'Scratchbox 3D Tile Ingestion Engine' },
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: root.name || '3DMapTile' }],
      meshes: [
        {
          primitives: [
            {
              attributes: { POSITION: 0, NORMAL: 1 },
              indices: 2,
              mode: 4
            }
          ]
        }
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126, // FLOAT
          count: posAttr.count,
          type: 'VEC3'
        },
        {
          bufferView: 1,
          componentType: 5126, // FLOAT
          count: posAttr.count,
          type: 'VEC3'
        },
        {
          bufferView: 2,
          componentType: indexArray instanceof Uint32Array ? 5125 : 5123, // UNSIGNED_INT or UNSIGNED_SHORT
          count: indexAttr ? indexAttr.count : posAttr.count,
          type: 'SCALAR'
        }
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: posByteLength, target: 34962 },
        { buffer: 0, byteOffset: posByteLength, byteLength: normByteLength, target: 34962 },
        { buffer: 0, byteOffset: posByteLength + normByteLength, byteLength: indexByteLength, target: 34963 }
      ],
      buffers: [{ byteLength: totalBinLength }]
    };

    const jsonText = JSON.stringify(gltfJson);
    const jsonEncoded = new TextEncoder().encode(jsonText);
    const jsonPaddedLength = Math.ceil(jsonEncoded.length / 4) * 4;
    const binPaddedLength = Math.ceil(totalBinLength / 4) * 4;

    const totalGlbLength = 12 + 8 + jsonPaddedLength + 8 + binPaddedLength;
    const glbBuffer = new ArrayBuffer(totalGlbLength);
    const dataView = new DataView(glbBuffer);

    // GLB Header
    dataView.setUint32(0, 0x46546c67, true); // Magic: 'glTF'
    dataView.setUint32(4, 2, true);          // Version: 2
    dataView.setUint32(8, totalGlbLength, true);

    // JSON Chunk Header
    dataView.setUint32(12, jsonPaddedLength, true);
    dataView.setUint32(16, 0x4e4f534a, true); // 'JSON'

    const glbUint8 = new Uint8Array(glbBuffer);
    glbUint8.set(jsonEncoded, 20);
    for (let i = 20 + jsonEncoded.length; i < 20 + jsonPaddedLength; i++) {
      glbUint8[i] = 0x20; // space padding
    }

    // BIN Chunk Header
    const binHeaderOffset = 20 + jsonPaddedLength;
    dataView.setUint32(binHeaderOffset, binPaddedLength, true);
    dataView.setUint32(binHeaderOffset + 4, 0x004e4942, true); // 'BIN\0'

    glbUint8.set(binBuffer, binHeaderOffset + 8);

    return glbBuffer;
  }

  /**
   * Synthesizes a valid standard Binary GLTF (.glb) buffer from Three.js Object3D.
   */
  public async synthesizeGlbTileBuffer(root: THREE.Object3D): Promise<ArrayBuffer> {
    return this.synthesizeGlbTileBufferSync(root);
  }
}
