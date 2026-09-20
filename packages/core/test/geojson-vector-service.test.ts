import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  projectWgs84ToEnu,
  getHighwayWidthMeters,
  buildRoadRibbonGeometry,
  buildBuildingPolygonMesh,
  parseGeoJsonToThreeGroup,
  GeoJsonFeatureCollection
} from '../src/browser/generative-canvas/services/geojson-vector-service';

describe('GeoJsonVectorService', () => {
  const ESB_ORIGIN = { lat: 40.7484405, lng: -73.9856644 };

  describe('projectWgs84ToEnu', () => {
    it('projects the origin coordinate to (0, 0)', () => {
      const [x, z] = projectWgs84ToEnu(ESB_ORIGIN.lng, ESB_ORIGIN.lat, ESB_ORIGIN.lng, ESB_ORIGIN.lat);
      expect(Math.abs(x)).toBeLessThan(1e-6);
      expect(Math.abs(z)).toBeLessThan(1e-6);
    });

    it('projects East longitude to positive X', () => {
      const eastLng = ESB_ORIGIN.lng + 0.001;
      const [x, z] = projectWgs84ToEnu(eastLng, ESB_ORIGIN.lat, ESB_ORIGIN.lng, ESB_ORIGIN.lat);
      expect(x).toBeGreaterThan(50); // ~84 meters
      expect(Math.abs(z)).toBeLessThan(1e-6);
    });

    it('projects North latitude to negative Z (Three.js standard)', () => {
      const northLat = ESB_ORIGIN.lat + 0.001;
      const [x, z] = projectWgs84ToEnu(ESB_ORIGIN.lng, northLat, ESB_ORIGIN.lng, ESB_ORIGIN.lat);
      expect(Math.abs(x)).toBeLessThan(1e-6);
      expect(z).toBeLessThan(-100); // ~ -111 meters
    });
  });

  describe('getHighwayWidthMeters', () => {
    it('maps avenue and primary corridors to 24m', () => {
      expect(getHighwayWidthMeters('primary')).toBe(24);
      expect(getHighwayWidthMeters('trunk')).toBe(24);
    });

    it('maps secondary streets to 18m', () => {
      expect(getHighwayWidthMeters('secondary')).toBe(18);
    });

    it('maps residential cross streets to 10m', () => {
      expect(getHighwayWidthMeters('residential')).toBe(10);
    });

    it('maps pedestrian plazas to 4.5m', () => {
      expect(getHighwayWidthMeters('pedestrian')).toBe(4.5);
      expect(getHighwayWidthMeters('footway')).toBe(4.5);
    });
  });

  describe('buildRoadRibbonGeometry', () => {
    it('creates an indexed buffer geometry with quads for road segments', () => {
      const points: [number, number][] = [
        [0, 0],
        [100, 0]
      ];
      const geo = buildRoadRibbonGeometry(points, 20, 0.05);
      expect(geo).not.toBeNull();
      if (!geo) return;

      const posAttr = geo.getAttribute('position');
      const normalAttr = geo.getAttribute('normal');
      const indexAttr = geo.getIndex();

      expect(posAttr.count).toBe(4); // 2 points * 2 sides
      expect(normalAttr.count).toBe(4);
      expect(indexAttr?.count).toBe(6); // 2 triangles

      // Check normals point straight up (0, 1, 0)
      expect(normalAttr.getY(0)).toBe(1);
    });
  });

  describe('buildBuildingPolygonMesh', () => {
    it('creates an extruded 3D mesh from a closed polygon ring', () => {
      const ring: [number, number][] = [
        [100, 100],
        [150, 100],
        [150, 150],
        [100, 150],
        [100, 100]
      ];
      const mesh = buildBuildingPolygonMesh(ring, 45, 0);
      expect(mesh).not.toBeNull();
      expect(mesh?.isMesh).toBe(true);
    });
  });

  describe('parseGeoJsonToThreeGroup', () => {
    it('converts GeoJSON features into Three.js hierarchy and filters center anchor plot', () => {
      const sampleGeoJson: GeoJsonFeatureCollection = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {
              type: 'road',
              osmId: 101,
              name: '5th Avenue',
              highway: 'primary'
            },
            geometry: {
              type: 'LineString',
              coordinates: [
                [ESB_ORIGIN.lng, ESB_ORIGIN.lat - 0.001],
                [ESB_ORIGIN.lng, ESB_ORIGIN.lat + 0.001]
              ]
            }
          },
          {
            type: 'Feature',
            properties: {
              type: 'building',
              osmId: 201,
              name: 'Empire State Building',
              levels: 102
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [ESB_ORIGIN.lng - 0.0001, ESB_ORIGIN.lat - 0.0001],
                [ESB_ORIGIN.lng + 0.0001, ESB_ORIGIN.lat - 0.0001],
                [ESB_ORIGIN.lng + 0.0001, ESB_ORIGIN.lat + 0.0001],
                [ESB_ORIGIN.lng - 0.0001, ESB_ORIGIN.lat + 0.0001],
                [ESB_ORIGIN.lng - 0.0001, ESB_ORIGIN.lat - 0.0001]
              ]]
            }
          },
          {
            type: 'Feature',
            properties: {
              type: 'building',
              osmId: 202,
              name: 'Adjacent Block Building',
              levels: 20
            },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [ESB_ORIGIN.lng + 0.002, ESB_ORIGIN.lat + 0.002],
                [ESB_ORIGIN.lng + 0.003, ESB_ORIGIN.lat + 0.002],
                [ESB_ORIGIN.lng + 0.003, ESB_ORIGIN.lat + 0.003],
                [ESB_ORIGIN.lng + 0.002, ESB_ORIGIN.lat + 0.003],
                [ESB_ORIGIN.lng + 0.002, ESB_ORIGIN.lat + 0.002]
              ]]
            }
          }
        ]
      };

      const result = parseGeoJsonToThreeGroup(sampleGeoJson, {
        origin: ESB_ORIGIN,
        excludeCenterRadius: 50.0
      });

      expect(result.roadCount).toBe(1);
      // Building 201 is within 50m of ESB origin and should be skipped; building 202 is outside and included
      expect(result.buildingCount).toBe(1);
      expect(result.group.children.length).toBe(2);
    });
  });
});
