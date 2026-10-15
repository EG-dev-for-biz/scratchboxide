/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  WebXRGeospatialAnchorBridge,
  DeviceSensorSample,
  WebXRViewerPose
} from '../src/browser/generative-canvas/services/xr/WebXRGeospatialAnchorBridge';
import { GeoFrame } from '../src/common/coordinate/GeoFrame';
import { DeploymentManifestCompiler } from '../src/node/spatial/DeploymentManifestCompiler';
import {
  Entity4D,
  GeoAnchorDeploymentContract
} from '../src/common/geospatial-4d-protocol';
import { GoogleVectorMappingService } from '../src/browser/generative-canvas/services/google-vector-mapping-service';

/** A surveyed test anchor (Empire State Building): test data only; the service has no built-in places. */
const ESB_GOOGLE_GEODETIC_ANCHOR = {
  lat: 40.7484405,
  lng: -73.9856644,
  elevation: 18.53,
  placeId: 'ChIJh9828XNZwokR_3A0K2N46j8',
  formattedAddress: 'Empire State Building, 20 W 34th St, New York, NY 10001, USA'
};

describe('WebXRGeospatialAnchorBridge (Geodetic GPS <-> WebXR Metric Space)', () => {
  let bridge: WebXRGeospatialAnchorBridge;

  beforeEach(() => {
    bridge = new WebXRGeospatialAnchorBridge({
      origin: {
        lat: ESB_GOOGLE_GEODETIC_ANCHOR.lat,
        lng: ESB_GOOGLE_GEODETIC_ANCHOR.lng,
        alt: ESB_GOOGLE_GEODETIC_ANCHOR.elevation
      }
    });
    bridge.calibrateAnchorOrigin(0);
  });

  it('1. should place anchor origin at WebXR (0, 0, 0) and roundtrip with sub-millimeter precision', () => {
    const originPos = bridge.geodeticToWebXR({
      lat: ESB_GOOGLE_GEODETIC_ANCHOR.lat,
      lng: ESB_GOOGLE_GEODETIC_ANCHOR.lng,
      alt: ESB_GOOGLE_GEODETIC_ANCHOR.elevation
    });

    expect(originPos.x).toBeCloseTo(0, 3);
    expect(originPos.y).toBeCloseTo(0, 3);
    expect(originPos.z).toBeCloseTo(0, 3);

    const roundtripGeo = bridge.webXRToGeodetic(originPos);
    expect(roundtripGeo.lat).toBeCloseTo(ESB_GOOGLE_GEODETIC_ANCHOR.lat, 6);
    expect(roundtripGeo.lng).toBeCloseTo(ESB_GOOGLE_GEODETIC_ANCHOR.lng, 6);
    expect(roundtripGeo.alt).toBeCloseTo(ESB_GOOGLE_GEODETIC_ANCHOR.elevation, 3);
  });

  it('2. should accurately convert offset positions (100m East, 25m Up, 50m North)', () => {
    const esbGeoFrame = new GeoFrame(
      {
        lat: ESB_GOOGLE_GEODETIC_ANCHOR.lat,
        lng: ESB_GOOGLE_GEODETIC_ANCHOR.lng,
        alt: ESB_GOOGLE_GEODETIC_ANCHOR.elevation
      },
      1.0 // 1 unit = 1 meter
    );

    // Three.js convention: +X = East, +Y = Up, -Z = North
    const targetGeo = esbGeoFrame.toGeo({ x: 100, y: 25, z: -50 });

    const webXrPos = bridge.geodeticToWebXR({
      lat: targetGeo.lat,
      lng: targetGeo.lng,
      alt: targetGeo.alt
    });

    expect(webXrPos.x).toBeCloseTo(100, 2);
    expect(webXrPos.y).toBeCloseTo(25, 2);
    expect(webXrPos.z).toBeCloseTo(-50, 2);

    const invertedGeo = bridge.webXRToGeodetic(webXrPos);
    expect(invertedGeo.lat).toBeCloseTo(targetGeo.lat, 6);
    expect(invertedGeo.lng).toBeCloseTo(targetGeo.lng, 6);
    expect(invertedGeo.alt).toBeCloseTo(targetGeo.alt ?? 0, 2);
  });

  it('3. should map cardinal compass headings to correct WebXR Quaternions', () => {
    // 0 deg True North -> forward vector is (0, 0, -1)
    const qNorth = bridge.geodeticHeadingToWebXRQuaternion(0);
    const vNorth = new THREE.Vector3(0, 0, -1).applyQuaternion(qNorth);
    expect(vNorth.x).toBeCloseTo(0, 4);
    expect(vNorth.z).toBeCloseTo(-1, 4);
    expect(bridge.webXRQuaternionToGeodeticHeading(qNorth)).toBeCloseTo(0, 2);

    // 90 deg True East -> forward vector is (1, 0, 0)
    const qEast = bridge.geodeticHeadingToWebXRQuaternion(90);
    const vEast = new THREE.Vector3(0, 0, -1).applyQuaternion(qEast);
    expect(vEast.x).toBeCloseTo(1, 4);
    expect(vEast.z).toBeCloseTo(0, 4);
    expect(bridge.webXRQuaternionToGeodeticHeading(qEast)).toBeCloseTo(90, 2);

    // 180 deg True South -> forward vector is (0, 0, 1)
    const qSouth = bridge.geodeticHeadingToWebXRQuaternion(180);
    const vSouth = new THREE.Vector3(0, 0, -1).applyQuaternion(qSouth);
    expect(vSouth.x).toBeCloseTo(0, 4);
    expect(vSouth.z).toBeCloseTo(1, 4);
    expect(bridge.webXRQuaternionToGeodeticHeading(qSouth)).toBeCloseTo(180, 2);

    // 270 deg True West -> forward vector is (-1, 0, 0)
    const qWest = bridge.geodeticHeadingToWebXRQuaternion(270);
    const vWest = new THREE.Vector3(0, 0, -1).applyQuaternion(qWest);
    expect(vWest.x).toBeCloseTo(-1, 4);
    expect(vWest.z).toBeCloseTo(0, 4);
    expect(bridge.webXRQuaternionToGeodeticHeading(qWest)).toBeCloseTo(270, 2);
  });

  it('4. should autonomously calibrate coordinate alignment using device GPS + compass + WebXR pose', () => {
    const geoFrame = new GeoFrame(
      {
        lat: ESB_GOOGLE_GEODETIC_ANCHOR.lat,
        lng: ESB_GOOGLE_GEODETIC_ANCHOR.lng,
        alt: ESB_GOOGLE_GEODETIC_ANCHOR.elevation
      },
      1.0
    );

    // Device is physically located 40m East (+X), 20m South (+Z), elevation 20.0m ASL
    const deviceGeo = geoFrame.toGeo({ x: 40, y: 1.47, z: 20 });
    const sensorSample: DeviceSensorSample = {
      lat: deviceGeo.lat,
      lng: deviceGeo.lng,
      alt: deviceGeo.alt,
      accuracyMeters: 2.1,
      headingDeg: 90 // Device is pointing East
    };

    // In WebXR, the device is currently at local position (0, 1.6, 0) and facing along -Z
    const viewerPose: WebXRViewerPose = {
      position: [0, 1.6, 0],
      quaternion: [0, 0, 0, 1] // identity (facing -Z)
    };

    const state = bridge.calibrateSensors(sensorSample, viewerPose);
    expect(state.isAligned).toBe(true);
    expect(state.calibrationSource).toBe('sensor');
    expect(state.accuracyMeters).toBe(2.1);

    // After calibration, the device's physical GPS location must project to the viewer's WebXR position
    const devProjected = bridge.geodeticToWebXR({
      lat: sensorSample.lat,
      lng: sensorSample.lng,
      alt: sensorSample.alt
    });
    expect(devProjected.x).toBeCloseTo(0, 2);
    expect(devProjected.y).toBeCloseTo(1.6, 2);
    expect(devProjected.z).toBeCloseTo(0, 2);
  });

  it('5. should support manual pin calibration to eliminate GPS drift', async () => {
    const esbGeoFrame = new GeoFrame({
      lat: ESB_GOOGLE_GEODETIC_ANCHOR.lat,
      lng: ESB_GOOGLE_GEODETIC_ANCHOR.lng,
      alt: ESB_GOOGLE_GEODETIC_ANCHOR.elevation
    });

    const entity: Entity4D = {
      id: 'target-monument-01',
      name: 'Physical Entrance Monument',
      space: {
        localTransform: {
          position: [15 * esbGeoFrame.scaleFactor, 0, -10 * esbGeoFrame.scaleFactor]
        }
      },
      time: { startMs: 0, durationMs: 0 },
      environment: {},
      content: { type: 'mesh-glb', durableUri: 'https://vault.scratchbox.dev/monument.glb' },
      behavior: {},
      lineage: { worldBranchId: 'earth/main', version: 1 }
    };

    const contract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [entity],
      weather: false
    });

    bridge.loadContract(contract);

    // Suppose user points reticle in WebXR at measured position (14.8, -0.2, -9.7)
    const measuredPos = new THREE.Vector3(14.8, -0.2, -9.7);
    const calState = bridge.calibrateManualPin('target-monument-01', measuredPos);

    expect(calState.isAligned).toBe(true);
    expect(calState.calibrationSource).toBe('manual-pin');

    // Transformed position of target monument now matches measured position exactly
    const placement = contract.placements[0];
    const transform = bridge.createPlacementTransform(placement);
    expect(transform.position.x).toBeCloseTo(14.8, 2);
    expect(transform.position.y).toBeCloseTo(-0.2, 2);
    expect(transform.position.z).toBeCloseTo(-9.7, 2);
  });

  it('6. should synchronize contract placements and support proximity radius queries', async () => {
    const esbGeoFrame = new GeoFrame({
      lat: ESB_GOOGLE_GEODETIC_ANCHOR.lat,
      lng: ESB_GOOGLE_GEODETIC_ANCHOR.lng,
      alt: ESB_GOOGLE_GEODETIC_ANCHOR.elevation
    });

    const closeEntity: Entity4D = {
      id: 'entity-close',
      name: 'Nearby Coffee Stand',
      space: { localTransform: { position: [10 * esbGeoFrame.scaleFactor, 0, 0] } },
      time: { startMs: 0, durationMs: 0 },
      environment: {},
      content: { type: 'mesh-glb' },
      behavior: {},
      lineage: { worldBranchId: 'earth/main', version: 1 }
    };

    const farEntity: Entity4D = {
      id: 'entity-far',
      name: 'Distant Skyscraper Observation Deck',
      space: { localTransform: { position: [600 * esbGeoFrame.scaleFactor, 100 * esbGeoFrame.scaleFactor, 0] } },
      time: { startMs: 0, durationMs: 0 },
      environment: {},
      content: { type: 'mesh-glb' },
      behavior: {},
      lineage: { worldBranchId: 'earth/main', version: 1 }
    };

    const contract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [closeEntity, farEntity],
      weather: false
    });

    bridge.loadContract(contract);

    // Synchronize to scene group
    const group = new THREE.Group();
    const objectMap = bridge.syncScenePlacements(group);
    expect(objectMap.size).toBe(2);
    expect(group.children.length).toBe(2);

    // Proximity query: within 50 meters
    const nearby = bridge.getPlacementsInRadius(50, new THREE.Vector3(0, 0, 0));
    expect(nearby.length).toBe(1);
    expect(nearby[0].placement.entityId).toBe('entity-close');
    expect(nearby[0].distanceFromViewerMeters).toBeCloseTo(10, 1);

    // Proximity query: within 1000 meters
    const all = bridge.getPlacementsInRadius(1000, new THREE.Vector3(0, 0, 0));
    expect(all.length).toBe(2);
  });

  it('7. should project road corridors and parcel geofences into WebXR lines and extruded meshes', () => {
    // Vector data comes from the caller (the service has no built-in Midtown dataset): two streets and one building.
    const at = (dx: number, dy: number): [number, number] => [ESB_GOOGLE_GEODETIC_ANCHOR.lng + dx, ESB_GOOGLE_GEODETIC_ANCHOR.lat + dy];
    const midtownData = GoogleVectorMappingService.ingestGeoJsonFeatures({
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [at(-0.001, 0), at(0.001, 0)] }, properties: { name: 'W 34th St', width: 18, lanes: 4 } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [at(0, -0.001), at(0, 0.001)] }, properties: { name: '5th Ave', width: 30, lanes: 5 } },
        { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[at(-0.0002, -0.0002), at(0.0002, -0.0002), at(0.0002, 0.0002), at(-0.0002, 0.0002), at(-0.0002, -0.0002)]] }, properties: { name: 'Tower', height: 443.2 } }
      ]
    }, ESB_GOOGLE_GEODETIC_ANCHOR) as { roads: any[]; parcels: any[] };
    expect(midtownData.roads).toHaveLength(2);
    expect(midtownData.parcels).toHaveLength(1);

    // Project road corridors
    const roadLines = bridge.projectRoadCorridorsToWebXR(midtownData.roads);
    expect(roadLines.length).toBe(midtownData.roads.length);
    expect(roadLines[0]).toBeInstanceOf(THREE.Line);
    expect(roadLines[0].geometry.attributes.position.count).toBeGreaterThanOrEqual(2);

    // Project parcel envelopes
    const parcelGroup = bridge.projectParcelsToWebXR(midtownData.parcels);
    expect(parcelGroup.children.length).toBe(midtownData.parcels.length);
    expect(parcelGroup.children[0]).toBeInstanceOf(THREE.Mesh);
  });

  it('8. should update and export deployment contract with new geodetic coordinates after object dragging', async () => {
    const esbGeoFrame = new GeoFrame({
      lat: ESB_GOOGLE_GEODETIC_ANCHOR.lat,
      lng: ESB_GOOGLE_GEODETIC_ANCHOR.lng,
      alt: ESB_GOOGLE_GEODETIC_ANCHOR.elevation
    });

    const entity: Entity4D = {
      id: 'movable-asset-01',
      name: 'Movable Kiosk',
      space: { localTransform: { position: [0, 0, 0] } },
      time: { startMs: 0, durationMs: 0 },
      environment: {},
      content: { type: 'mesh-glb' },
      behavior: {},
      lineage: { worldBranchId: 'earth/main', version: 1 }
    };

    const contract = await DeploymentManifestCompiler.compile({
      geoFrame: esbGeoFrame,
      scene: [entity],
      weather: false
    });

    bridge.loadContract(contract);

    const group = new THREE.Group();
    bridge.syncScenePlacements(group);

    // Simulate user dragging the object in WebXR by 30 meters East (+X)
    const obj = group.getObjectByName('movable-asset-01')!;
    obj.position.x = 30;

    const exported = bridge.exportUpdatedContract(group);
    expect(exported.placements[0].targetGeodetic.longitude).not.toBe(
      contract.placements[0].targetGeodetic.longitude
    );

    // Converting exported geodetic position back to WebXR should yield exactly 30 meters
    const reProjected = bridge.geodeticToWebXR({
      lat: exported.placements[0].targetGeodetic.latitude,
      lng: exported.placements[0].targetGeodetic.longitude,
      alt: ESB_GOOGLE_GEODETIC_ANCHOR.elevation
    });
    expect(reProjected.x).toBeCloseTo(30, 1);
  });
});
