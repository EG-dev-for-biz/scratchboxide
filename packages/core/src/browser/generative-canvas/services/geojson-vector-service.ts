import * as THREE from 'three';

export interface GeoJsonCoordinates {
  lng: number;
  lat: number;
}

export interface GeoJsonFeatureProperties {
  type: 'road' | 'building' | string;
  osmId?: number | string;
  name?: string | null;
  highway?: string;
  oneway?: string;
  lanes?: number | null;
  layer?: number;
  building?: string;
  levels?: number | null;
  height?: number | null;
  [key: string]: unknown;
}

export interface GeoJsonFeature {
  type: 'Feature';
  id?: string;
  properties: GeoJsonFeatureProperties;
  geometry: {
    type: 'LineString' | 'Polygon' | 'MultiPolygon' | string;
    coordinates: any;
  };
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  metadata?: Record<string, unknown>;
  features: GeoJsonFeature[];
}

export interface VectorMeshGenerationOptions {
  origin: GeoJsonCoordinates;
  roadElevation?: number;
  buildingHeightScale?: number;
  defaultBuildingHeight?: number;
  excludeCenterRadius?: number; // In meters, e.g. 75m to clear ESB parcel
  roadPalette?: {
    primary?: number | string;
    secondary?: number | string;
    residential?: number | string;
    pedestrian?: number | string;
  };
  buildingPalette?: {
    wallColor?: number | string;
    roofColor?: number | string;
    edgeColor?: number | string;
  };
}

const EARTH_RADIUS_METERS = 6378137.0;

/**
 * Projects a geodetic WGS84 coordinate [lng, lat] into local Cartesian East-North-Up (ENU) coordinates in meters.
 * In Three.js:
 *   +X is East
 *   +Y is Up
 *   -Z is North
 */
export function projectWgs84ToEnu(
  lng: number,
  lat: number,
  originLng: number,
  originLat: number
): [number, number] {
  const dLngRad = ((lng - originLng) * Math.PI) / 180.0;
  const dLatRad = ((lat - originLat) * Math.PI) / 180.0;
  const originLatRad = (originLat * Math.PI) / 180.0;

  const x = dLngRad * EARTH_RADIUS_METERS * Math.cos(originLatRad);
  const z = -dLatRad * EARTH_RADIUS_METERS; // North is -Z in Three.js standard
  return [x, z];
}

/**
 * Determines physical road width in meters based on highway classification.
 */
export function getHighwayWidthMeters(highwayType?: string): number {
  switch (highwayType) {
    case 'motorway':
    case 'trunk':
    case 'primary':
      return 24.0; // E.g., 5th Ave, 6th Ave, 34th St, Broadway
    case 'secondary':
      return 18.0; // E.g., Madison Ave, 7th Ave
    case 'tertiary':
      return 14.0; // E.g., Lexington Ave
    case 'residential':
      return 10.0; // E.g., 31st - 39th crosstown streets
    case 'service':
    case 'unclassified':
      return 7.0;
    case 'pedestrian':
    case 'footway':
    case 'cycleway':
    case 'path':
    case 'steps':
      return 4.5;
    default:
      return 10.0;
  }
}

/**
 * Generates an extruded 3D ribbon mesh for a road polyline.
 */
export function buildRoadRibbonGeometry(
  pointsXZ: [number, number][],
  widthMeters: number,
  elevation: number = 0.05
): THREE.BufferGeometry | null {
  if (pointsXZ.length < 2) return null;

  const numPoints = pointsXZ.length;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const halfWidth = widthMeters / 2.0;

  // Compute 2D segment directions and perpendiculars
  const leftPts: [number, number][] = [];
  const rightPts: [number, number][] = [];

  for (let i = 0; i < numPoints; i++) {
    const cur = pointsXZ[i];
    let perpX = 0;
    let perpZ = 0;

    if (i === 0) {
      const next = pointsXZ[1];
      const dx = next[0] - cur[0];
      const dz = next[1] - cur[1];
      const len = Math.hypot(dx, dz) || 1;
      perpX = -dz / len;
      perpZ = dx / len;
    } else if (i === numPoints - 1) {
      const prev = pointsXZ[numPoints - 2];
      const dx = cur[0] - prev[0];
      const dz = cur[1] - prev[1];
      const len = Math.hypot(dx, dz) || 1;
      perpX = -dz / len;
      perpZ = dx / len;
    } else {
      const prev = pointsXZ[i - 1];
      const next = pointsXZ[i + 1];
      const dx = next[0] - prev[0];
      const dz = next[1] - prev[1];
      const len = Math.hypot(dx, dz) || 1;
      perpX = -dz / len;
      perpZ = dx / len;
    }

    leftPts.push([cur[0] + perpX * halfWidth, cur[1] + perpZ * halfWidth]);
    rightPts.push([cur[0] - perpX * halfWidth, cur[1] - perpZ * halfWidth]);
  }

  let totalDist = 0;
  for (let i = 0; i < numPoints; i++) {
    if (i > 0) {
      const dx = pointsXZ[i][0] - pointsXZ[i - 1][0];
      const dz = pointsXZ[i][1] - pointsXZ[i - 1][1];
      totalDist += Math.hypot(dx, dz);
    }

    // Left vertex
    positions.push(leftPts[i][0], elevation, leftPts[i][1]);
    normals.push(0, 1, 0);
    uvs.push(0, totalDist / 20.0);

    // Right vertex
    positions.push(rightPts[i][0], elevation, rightPts[i][1]);
    normals.push(0, 1, 0);
    uvs.push(1, totalDist / 20.0);

    // Indices
    if (i < numPoints - 1) {
      const idx = i * 2;
      // Triangle 1: left_i, right_i, left_i+1
      indices.push(idx, idx + 1, idx + 2);
      // Triangle 2: right_i, right_i+1, left_i+1
      indices.push(idx + 1, idx + 3, idx + 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * Builds a 3D building parcel massing mesh from a polygon coordinate ring.
 */
export function buildBuildingPolygonMesh(
  ringXZ: [number, number][],
  heightMeters: number,
  baseElevation: number = 0
): THREE.Mesh | null {
  if (ringXZ.length < 3) return null;

  // Convert ring to THREE.Vector2 shape points
  const shapePoints: THREE.Vector2[] = [];
  for (let i = 0; i < ringXZ.length - 1; i++) {
    // Exclude redundant closing point if identical
    shapePoints.push(new THREE.Vector2(ringXZ[i][0], -ringXZ[i][1])); // Invert Z for Shape 2D UV coordinate space
  }

  if (shapePoints.length < 3) return null;

  const shape = new THREE.Shape(shapePoints);
  const depth = Math.max(4.0, heightMeters);
  const extrudeSettings: THREE.ExtrudeGeometryOptions = {
    steps: 1,
    depth,
    bevelEnabled: false
  };

  const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  // ExtrudeGeometry extrudes along +Z. Rotate -90 deg on X to align with Three.js world axes (Y up)
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, baseElevation + depth, 0);

  const material = new THREE.MeshStandardMaterial({
    color: '#1e293b',
    roughness: 0.7,
    metalness: 0.2
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Parses a GeoJSON FeatureCollection and converts it into a Three.js Group
 * containing surveyed 3D road ribbons and building parcel meshes.
 */
export function parseGeoJsonToThreeGroup(
  geojson: GeoJsonFeatureCollection,
  options: VectorMeshGenerationOptions
): { group: THREE.Group; roadCount: number; buildingCount: number } {
  const group = new THREE.Group();
  group.name = 'midtown-surveyed-vectors';

  const roadsGroup = new THREE.Group();
  roadsGroup.name = 'surveyed-roads-ribbons';
  group.add(roadsGroup);

  const buildingsGroup = new THREE.Group();
  buildingsGroup.name = 'surveyed-building-parcels';
  group.add(buildingsGroup);

  const roadElevation = options.roadElevation ?? 0.04;
  const excludeRadius = options.excludeCenterRadius ?? 65.0; // Exclude ESB plot

  const roadMaterialPrimary = new THREE.MeshStandardMaterial({
    color: options.roadPalette?.primary ?? '#0ea5e9',
    roughness: 0.65,
    metalness: 0.2,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2
  });

  const roadMaterialSecondary = new THREE.MeshStandardMaterial({
    color: options.roadPalette?.secondary ?? '#334155',
    roughness: 0.8,
    metalness: 0.1,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2
  });

  let roadCount = 0;
  let buildingCount = 0;

  for (const feature of geojson.features) {
    if (!feature.geometry || !feature.geometry.coordinates) continue;

    const props = feature.properties || {};

    if (props.type === 'road' && feature.geometry.type === 'LineString') {
      const coords = feature.geometry.coordinates as [number, number][];
      if (coords.length < 2) continue;

      const pointsXZ: [number, number][] = coords.map(([lng, lat]) =>
        projectWgs84ToEnu(lng, lat, options.origin.lng, options.origin.lat)
      );

      const width = getHighwayWidthMeters(props.highway);
      const isPrimary = ['primary', 'trunk', 'motorway'].includes(props.highway || '');
      const ribbonGeo = buildRoadRibbonGeometry(pointsXZ, width, roadElevation);

      if (ribbonGeo) {
        const roadMesh = new THREE.Mesh(ribbonGeo, isPrimary ? roadMaterialPrimary : roadMaterialSecondary);
        roadMesh.name = `road-${props.osmId || roadCount}`;
        roadMesh.userData = {
          osmId: props.osmId,
          name: props.name || 'Unnamed Street',
          highway: props.highway,
          lanes: props.lanes,
          isPrimary
        };
        roadMesh.receiveShadow = true;
        roadsGroup.add(roadMesh);
        roadCount++;
      }
    } else if (props.type === 'building' && feature.geometry.type === 'Polygon') {
      const rings = feature.geometry.coordinates as [number, number][][];
      if (!rings || rings.length === 0 || rings[0].length < 3) continue;

      const outerRing = rings[0];
      const pointsXZ: [number, number][] = outerRing.map(([lng, lat]) =>
        projectWgs84ToEnu(lng, lat, options.origin.lng, options.origin.lat)
      );

      // Check distance from origin only if excludeCenterRadius is explicitly specified > 0
      if (options.excludeCenterRadius && options.excludeCenterRadius > 0) {
        let minDistFromOrigin = Infinity;
        for (const [px, pz] of pointsXZ) {
          const dist = Math.hypot(px, pz);
          if (dist < minDistFromOrigin) minDistFromOrigin = dist;
        }

        if (minDistFromOrigin < options.excludeCenterRadius) {
          continue;
        }
      }

      let height = props.height ? Number(props.height) : (props.levels ? Number(props.levels) * 3.8 : 28.0);
      if (options.buildingHeightScale) {
        height *= options.buildingHeightScale;
      }

      const buildingMesh = buildBuildingPolygonMesh(pointsXZ, height, 0);
      if (buildingMesh) {
        buildingMesh.name = `building-${props.osmId || buildingCount}`;
        buildingMesh.userData = {
          osmId: props.osmId,
          name: props.name,
          levels: props.levels,
          height
        };
        buildingsGroup.add(buildingMesh);
        buildingCount++;
      }
    }
  }

  return { group, roadCount, buildingCount };
}
