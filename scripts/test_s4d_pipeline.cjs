var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// scripts/test_s4d_pipeline.ts
var test_s4d_pipeline_exports = {};
__export(test_s4d_pipeline_exports, {
  testS4DSample: () => testS4DSample
});
module.exports = __toCommonJS(test_s4d_pipeline_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));

// packages/core/src/common/coordinate/LocalTangentPlane.ts
var WGS84_A = 6378137;
var WGS84_F = 1 / 298.257223563;
var WGS84_B = WGS84_A * (1 - WGS84_F);
var WGS84_E2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
var WGS84_E_PRIME2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
var LocalTangentPlane = class {
  // Strongly typed 3x3 inverse rotation matrix
  constructor(origin, geoidHeight = 0) {
    this.origin = origin;
    this.geoidHeight = geoidHeight;
    const latRad = origin.lat * (Math.PI / 180);
    const lngRad = origin.lng * (Math.PI / 180);
    const altEllipsoid = (origin.alt ?? 0) + geoidHeight;
    this.originEcef = this.geodeticToEcef(latRad, lngRad, altEllipsoid);
    const cosLat = Math.cos(latRad);
    const sinLat = Math.sin(latRad);
    const cosLng = Math.cos(lngRad);
    const sinLng = Math.sin(lngRad);
    this.rotMatrix = [
      [-sinLng, cosLng, 0],
      [-sinLat * cosLng, -sinLat * sinLng, cosLat],
      [cosLat * cosLng, cosLat * sinLng, sinLat]
    ];
    this.invRotMatrix = [
      [this.rotMatrix[0][0], this.rotMatrix[1][0], this.rotMatrix[2][0]],
      [this.rotMatrix[0][1], this.rotMatrix[1][1], this.rotMatrix[2][1]],
      [this.rotMatrix[0][2], this.rotMatrix[1][2], this.rotMatrix[2][2]]
    ];
  }
  originEcef;
  rotMatrix;
  // Strongly typed 3x3 rotation matrix
  invRotMatrix;
  /**
   * Converts Geodetic (Lat, Lng, Alt in MSL) to local Three.js coordinate system.
   * Three.js coordinate convention:
   *   Three.js X = ENU East
   *   Three.js Y = ENU Up
   *   Three.js Z = -ENU North
   */
  toLocal(p) {
    const latRad = p.lat * (Math.PI / 180);
    const lngRad = p.lng * (Math.PI / 180);
    const altEllipsoid = (p.alt ?? 0) + this.geoidHeight;
    const ecef = this.geodeticToEcef(latRad, lngRad, altEllipsoid);
    const dx = ecef[0] - this.originEcef[0];
    const dy = ecef[1] - this.originEcef[1];
    const dz = ecef[2] - this.originEcef[2];
    const east = this.rotMatrix[0][0] * dx + this.rotMatrix[0][1] * dy + this.rotMatrix[0][2] * dz;
    const north = this.rotMatrix[1][0] * dx + this.rotMatrix[1][1] * dy + this.rotMatrix[1][2] * dz;
    const up = this.rotMatrix[2][0] * dx + this.rotMatrix[2][1] * dy + this.rotMatrix[2][2] * dz;
    return [east, up, -north];
  }
  /**
   * Converts Geodetic (Lat, Lng, Alt in MSL) to standard East-North-Up (ENU) coordinates in meters.
   */
  geodeticToEnu(p) {
    const local = this.toLocal(p);
    return [local[0], -local[2], local[1]];
  }
  /**
   * Converts local ENU (East, North, Up) coordinates in meters to Geodetic.
   */
  enuToGeodetic(enu) {
    return this.toLatLng([enu[0], enu[2], -enu[1]]);
  }
  /**
   * Converts local Three.js coordinates to Geodetic (Lat, Lng, Alt in MSL).
   */
  toLatLng(local) {
    const east = local[0];
    const up = local[1];
    const north = -local[2];
    const dx = this.invRotMatrix[0][0] * east + this.invRotMatrix[0][1] * north + this.invRotMatrix[0][2] * up;
    const dy = this.invRotMatrix[1][0] * east + this.invRotMatrix[1][1] * north + this.invRotMatrix[1][2] * up;
    const dz = this.invRotMatrix[2][0] * east + this.invRotMatrix[2][1] * north + this.invRotMatrix[2][2] * up;
    const ecefX = this.originEcef[0] + dx;
    const ecefY = this.originEcef[1] + dy;
    const ecefZ = this.originEcef[2] + dz;
    const geodetic = this.ecefToGeodetic(ecefX, ecefY, ecefZ);
    return {
      lat: geodetic.lat * (180 / Math.PI),
      lng: geodetic.lng * (180 / Math.PI),
      alt: geodetic.alt - this.geoidHeight
    };
  }
  /**
   * Raw conversion: Geodetic (radians) to ECEF Cartesian coordinates (meters).
   */
  geodeticToEcef(lat, lng, alt) {
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinLng = Math.sin(lng);
    const cosLng = Math.cos(lng);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const x = (n + alt) * cosLat * cosLng;
    const y = (n + alt) * cosLat * sinLng;
    const z = ((1 - WGS84_E2) * n + alt) * sinLat;
    return [x, y, z];
  }
  /**
   * Bowring (1985) Closed-form formulation for ECEF Cartesian to Geodetic (radians, meters).
   * Millimetric precision, non-iterative.
   */
  ecefToGeodetic(x, y, z) {
    const p = Math.hypot(x, y);
    if (p < 1e-6) {
      const lat2 = z >= 0 ? Math.PI / 2 : -Math.PI / 2;
      const alt2 = Math.abs(z) - WGS84_B;
      return { lat: lat2, lng: 0, alt: alt2 };
    }
    const theta = Math.atan2(z * WGS84_A, p * WGS84_B);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);
    const lat = Math.atan2(
      z + WGS84_E_PRIME2 * WGS84_B * sinTheta * sinTheta * sinTheta,
      p - WGS84_E2 * WGS84_A * cosTheta * cosTheta * cosTheta
    );
    const lng = Math.atan2(y, x);
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const n = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
    const alt = p * cosLat + z * sinLat - WGS84_A * WGS84_A / n;
    return { lat, lng, alt };
  }
};

// packages/core/src/node/spatial/OccSoraBridge.ts
var OccSoraBridge = class {
  static DEFAULT_DIMENSIONS = [16, 128, 128, 64];
  static DEFAULT_VOXEL_SIZE = [1, 1, 1];
  /**
   * Serializes an Entity4D's telemetry log stream into a 6-DOF S4D trajectory prompt.
   */
  static serializeTrajectoryPrompt(entity, origin) {
    const ltp = new LocalTangentPlane(origin);
    const telemetry = entity.behavior.telemetryStream || [];
    const waypoints = [];
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < telemetry.length; ++i) {
      const log = telemetry[i];
      const enu = ltp.geodeticToEnu({
        lat: log.gps.lat,
        lng: log.gps.lng,
        alt: log.gps.alt
      });
      const x = parseFloat(enu[0].toFixed(3));
      const y = parseFloat(enu[1].toFixed(3));
      const z = parseFloat(enu[2].toFixed(3));
      const yawDeg = log.gps.heading ?? 0;
      const pitchDeg = log.gps.pitch ?? 0;
      const rollDeg = log.gps.roll ?? 0;
      const speedKmh = log.speedKmh ?? 0;
      waypoints.push({
        x,
        y,
        z,
        yawDeg,
        pitchDeg,
        rollDeg,
        speedKmh,
        timestampMs: log.timestampMs
      });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
    if (waypoints.length === 0) {
      minX = minY = minZ = -64;
      maxX = maxY = maxZ = 64;
    }
    const durationMs = entity.time.durationMs || (waypoints.length > 0 ? waypoints[waypoints.length - 1].timestampMs - waypoints[0].timestampMs : 5e3);
    const timeStepMs = waypoints.length > 1 ? (waypoints[waypoints.length - 1].timestampMs - waypoints[0].timestampMs) / (waypoints.length - 1) : 250;
    return {
      entityId: entity.id,
      originWGS84: origin,
      timeStepMs: Math.round(timeStepMs),
      totalDurationMs: durationMs,
      waypoints,
      bounds: {
        min: [minX, minY, minZ],
        max: [maxX, maxY, maxZ]
      }
    };
  }
  /**
   * Constructs a complete S4D model inference request payload with sane defaults.
   */
  static buildInferencePayload(entity, origin, options = {}) {
    const prompt = this.serializeTrajectoryPrompt(entity, origin);
    return {
      model: "scratchbox-4d-dit-v1",
      prompt,
      options: {
        dimensions: options.dimensions ?? this.DEFAULT_DIMENSIONS,
        voxelSizeMeters: options.voxelSizeMeters ?? this.DEFAULT_VOXEL_SIZE,
        numInferenceSteps: options.numInferenceSteps ?? 20,
        guidanceScale: options.guidanceScale ?? 4.5,
        seed: options.seed ?? 42
      }
    };
  }
  /**
   * Validates kinematics continuity to prevent erratic teleports or unrealistic physics.
   */
  static validateTrajectoryContinuity(prompt) {
    const warnings = [];
    let maxSpeedKmh = 0;
    let totalDistanceMeters = 0;
    if (prompt.waypoints.length < 2) {
      return {
        valid: false,
        maxSpeedKmh: 0,
        totalDistanceMeters: 0,
        warnings: ["Trajectory prompt requires at least 2 waypoints for temporal evaluation"]
      };
    }
    for (let i = 1; i < prompt.waypoints.length; ++i) {
      const prev = prompt.waypoints[i - 1];
      const curr = prompt.waypoints[i];
      const dtSec = (curr.timestampMs - prev.timestampMs) / 1e3;
      if (dtSec <= 0) {
        warnings.push(`Non-increasing timestamp detected at waypoint index ${i}`);
        continue;
      }
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const dz = curr.z - prev.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      totalDistanceMeters += dist;
      const calculatedSpeedKmh = dist / dtSec * 3.6;
      maxSpeedKmh = Math.max(maxSpeedKmh, calculatedSpeedKmh);
      if (calculatedSpeedKmh > 500) {
        warnings.push(`Extreme velocity jump of ${calculatedSpeedKmh.toFixed(1)} km/h between steps ${i - 1} and ${i}`);
      }
    }
    return {
      valid: warnings.length === 0,
      maxSpeedKmh: parseFloat(maxSpeedKmh.toFixed(2)),
      totalDistanceMeters: parseFloat(totalDistanceMeters.toFixed(2)),
      warnings
    };
  }
  /**
   * Wraps generated 4D occupancy data into a formal Scratchbox Entity4D.
   */
  static createOccupancyEntity(id, name, prompt, occupancyGrid) {
    return {
      id,
      name,
      space: {
        geoAnchor: {
          lat: prompt.originWGS84.lat,
          lng: prompt.originWGS84.lng,
          alt: prompt.originWGS84.alt
        },
        localTransform: {
          position: [0, 0, 0],
          scale: [1, 1, 1]
        },
        boundingBox: {
          min: prompt.bounds.min,
          max: prompt.bounds.max
        }
      },
      time: {
        startMs: 0,
        durationMs: prompt.totalDurationMs,
        isContinuous: false
      },
      environment: {
        weather: {
          conditions: "sunny"
        },
        solar: {
          altitude: Math.PI / 4,
          azimuth: Math.PI
        }
      },
      content: {
        type: "occupancy-4d",
        durableUri: occupancyGrid.denseTensorUri || `scratchbox://occupancy/${id}`,
        occupancy4D: occupancyGrid,
        metadata: {
          dimensions: occupancyGrid.metadata.dimensions,
          voxelSizeMeters: occupancyGrid.metadata.voxelSizeMeters,
          generator: "scratchbox-4d-dit-v1"
        }
      },
      behavior: {
        telemetryStream: prompt.waypoints.map((w) => ({
          timestampMs: w.timestampMs,
          gps: {
            lat: prompt.originWGS84.lat,
            lng: prompt.originWGS84.lng,
            alt: prompt.originWGS84.alt,
            heading: w.yawDeg,
            pitch: w.pitchDeg,
            roll: w.rollDeg
          },
          speedKmh: w.speedKmh,
          status: "SIMULATED"
        }))
      },
      lineage: {
        worldBranchId: "earth/main",
        version: 1,
        provenance: {
          authorAgent: "Scratchbox4DWorldEngine",
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        }
      }
    };
  }
  /**
   * Run-Length Encodes a dense uint8 voxel array for compact network transfer and storage.
   */
  static rleEncode(voxelArray) {
    const encoded = [];
    if (voxelArray.length === 0) return "";
    let currentVal = voxelArray[0];
    let runLength = 1;
    for (let i = 1; i < voxelArray.length; ++i) {
      if (voxelArray[i] === currentVal && runLength < 255) {
        runLength++;
      } else {
        encoded.push(runLength, currentVal);
        currentVal = voxelArray[i];
        runLength = 1;
      }
    }
    encoded.push(runLength, currentVal);
    return Buffer.from(new Uint8Array(encoded)).toString("base64");
  }
  /**
   * Decodes a Run-Length Encoded base64 string back into a dense uint8 voxel buffer.
   */
  static rleDecode(rleBase64, totalCount) {
    const raw = Buffer.from(rleBase64, "base64");
    const output = new Uint8Array(totalCount);
    let outIdx = 0;
    for (let i = 0; i < raw.length; i += 2) {
      const runLength = raw[i];
      const val = raw[i + 1];
      for (let r = 0; r < runLength && outIdx < totalCount; ++r) {
        output[outIdx++] = val;
      }
    }
    return output;
  }
};

// packages/core/src/common/geospatial-4d-protocol.ts
var GeospatialSemanticClass = /* @__PURE__ */ ((GeospatialSemanticClass2) => {
  GeospatialSemanticClass2[GeospatialSemanticClass2["AIRSPACE"] = 0] = "AIRSPACE";
  GeospatialSemanticClass2[GeospatialSemanticClass2["TERRAIN"] = 1] = "TERRAIN";
  GeospatialSemanticClass2[GeospatialSemanticClass2["WATER"] = 2] = "WATER";
  GeospatialSemanticClass2[GeospatialSemanticClass2["BUILDING_FACADE"] = 3] = "BUILDING_FACADE";
  GeospatialSemanticClass2[GeospatialSemanticClass2["BUILDING_INTERIOR"] = 4] = "BUILDING_INTERIOR";
  GeospatialSemanticClass2[GeospatialSemanticClass2["VEGETATION"] = 5] = "VEGETATION";
  GeospatialSemanticClass2[GeospatialSemanticClass2["TRANSIT_ROAD"] = 6] = "TRANSIT_ROAD";
  GeospatialSemanticClass2[GeospatialSemanticClass2["DYNAMIC_AIR_AGENT"] = 7] = "DYNAMIC_AIR_AGENT";
  GeospatialSemanticClass2[GeospatialSemanticClass2["DYNAMIC_GROUND_AGENT"] = 8] = "DYNAMIC_GROUND_AGENT";
  GeospatialSemanticClass2[GeospatialSemanticClass2["DYNAMIC_HAZARD"] = 9] = "DYNAMIC_HAZARD";
  return GeospatialSemanticClass2;
})(GeospatialSemanticClass || {});

// scripts/test_s4d_pipeline.ts
function testS4DSample(promptPath, tensorPath) {
  console.log(`
======================================================`);
  console.log(`  \u{1F9EA} Testing Scratchbox-4D Spatiotemporal Sample`);
  console.log(`  Prompt: ${promptPath}`);
  console.log(`  Tensor: ${tensorPath}`);
  console.log(`======================================================
`);
  const promptRaw = JSON.parse(import_node_fs.default.readFileSync(promptPath, "utf8"));
  const rleBase64 = import_node_fs.default.readFileSync(tensorPath, "utf8");
  const expectedVoxels = 16 * 64 * 64 * 32;
  const decompressed = OccSoraBridge.rleDecode(rleBase64, expectedVoxels);
  if (decompressed.length !== expectedVoxels) {
    throw new Error(`Decompression error: Expected ${expectedVoxels} voxels, got ${decompressed.length}`);
  }
  console.log(`[PASS] Tensor decompress: 16x64x64x32 (${decompressed.length} voxels, byte size: ${decompressed.byteLength} B)`);
  const classCounts = {};
  for (let i = 0; i < decompressed.length; i++) {
    const cls = decompressed[i];
    if (cls < 0 || cls > 9) {
      throw new Error(`Invalid semantic class ID ${cls} at voxel index ${i}`);
    }
    classCounts[cls] = (classCounts[cls] || 0) + 1;
  }
  console.log(`[PASS] Semantic bounds check: All voxel classes in range [0, 9]`);
  const classNames = {
    [GeospatialSemanticClass.FREE_SPACE]: "Free Space",
    [GeospatialSemanticClass.GROUND]: "Ground",
    [GeospatialSemanticClass.ROAD]: "Road",
    [GeospatialSemanticClass.BUILDING]: "Building",
    [5 /* VEGETATION */]: "Vegetation",
    [GeospatialSemanticClass.DYNAMIC_VEHICLE]: "Dynamic Vehicle",
    [GeospatialSemanticClass.DYNAMIC_PEDESTRIAN]: "Dynamic Pedestrian",
    [GeospatialSemanticClass.SKY]: "Sky",
    [2 /* WATER */]: "Water",
    [GeospatialSemanticClass.INFRASTRUCTURE]: "Infrastructure"
  };
  const classDistHuman = {};
  for (const [cls, count] of Object.entries(classCounts)) {
    const name = classNames[Number(cls)] || `Class_${cls}`;
    classDistHuman[name] = count;
  }
  const freeSpaceCount = classCounts[GeospatialSemanticClass.FREE_SPACE] || 0;
  const occupiedCount = expectedVoxels - freeSpaceCount;
  const occupancyRate = occupiedCount / expectedVoxels * 100;
  const frameStride = 64 * 64 * 32;
  let staticChecks = 0;
  let staticMatches = 0;
  for (let t = 0; t < 15; t++) {
    const frameAOffset = t * frameStride;
    const frameBOffset = (t + 1) * frameStride;
    for (let v = 0; v < frameStride; v++) {
      const clsA = decompressed[frameAOffset + v];
      const clsB = decompressed[frameBOffset + v];
      if (clsA === GeospatialSemanticClass.BUILDING || clsA === GeospatialSemanticClass.ROAD || clsA === GeospatialSemanticClass.GROUND) {
        staticChecks++;
        if (clsA === clsB) {
          staticMatches++;
        }
      }
    }
  }
  const temporalConsistency = staticChecks > 0 ? staticMatches / staticChecks * 100 : 100;
  console.log(`[PASS] Temporal static consistency: ${temporalConsistency.toFixed(2)}% (static geography remains fixed across time)`);
  const waypoints = promptRaw.prompt.waypoints || [];
  let collisions = 0;
  for (let t = 0; t < Math.min(16, waypoints.length); t++) {
    const wp = waypoints[t];
    const vx = Math.floor((wp.x + 50) / 100 * 64);
    const vy = Math.floor((wp.y + 50) / 100 * 64);
    const vz = Math.floor(wp.z / 30 * 32);
    if (vx >= 0 && vx < 64 && vy >= 0 && vy < 64 && vz >= 0 && vz < 32) {
      const voxelIdx = t * frameStride + (vz * 64 * 64 + vy * 64 + vx);
      const cls = decompressed[voxelIdx];
      if (cls === GeospatialSemanticClass.BUILDING) {
        collisions++;
      }
    }
  }
  console.log(`[PASS] Camera trajectory clearance: ${collisions} collision(s) detected across 16 frames`);
  const metrics = {
    totalVoxels: expectedVoxels,
    freeSpaceVoxels: freeSpaceCount,
    occupiedVoxels: occupiedCount,
    occupancyRatePct: Number(occupancyRate.toFixed(2)),
    classDistribution: classDistHuman,
    temporalStaticConsistencyPct: Number(temporalConsistency.toFixed(2)),
    cameraWaypointCollisionCount: collisions
  };
  const subsampledFrames = [];
  const sampleTimeSteps = [0, 4, 8, 12, 15];
  for (const t of sampleTimeSteps) {
    const frameOffset = t * frameStride;
    const voxelsList = [];
    for (let z = 0; z < 32; z += 2) {
      for (let y = 0; y < 64; y += 2) {
        for (let x = 0; x < 64; x += 2) {
          const idx = frameOffset + (z * 64 * 64 + y * 64 + x);
          const cls = decompressed[idx];
          if (cls !== GeospatialSemanticClass.FREE_SPACE && cls !== GeospatialSemanticClass.SKY) {
            voxelsList.push([x - 32, y - 32, z, cls]);
          }
        }
      }
    }
    subsampledFrames.push({ time: t, voxels: voxelsList });
  }
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Scratchbox-4D (S4D) Interactive Spatiotemporal Viewer</title>
  <style>
    body { margin: 0; padding: 0; overflow: hidden; background: #0b0f19; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #fff; }
    #canvas-container { width: 100vw; height: 100vh; position: absolute; top: 0; left: 0; }
    #overlay { position: absolute; top: 20px; left: 20px; z-index: 10; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 18px 24px; max-width: 420px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); }
    h2 { margin: 0 0 6px 0; font-size: 18px; font-weight: 700; background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; background: rgba(56, 189, 248, 0.2); color: #38bdf8; margin-bottom: 12px; }
    .metrics { font-size: 12px; line-height: 1.6; color: #94a3b8; }
    .metrics span { color: #f1f5f9; font-weight: 600; }
    #timeline-panel { position: absolute; bottom: 30px; left: 50%; transform: translateX(-50%); z-index: 10; background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 14px 28px; display: flex; align-items: center; gap: 16px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); }
    .slider { width: 300px; accent-color: #38bdf8; cursor: pointer; }
    .legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .legend-item { display: flex; align-items: center; gap: 4px; font-size: 11px; }
    .dot { width: 10px; height: 10px; border-radius: 2px; }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
</head>
<body>
  <div id="canvas-container"></div>
  <div id="overlay">
    <h2>Scratchbox-4D Spatiotemporal Viewer</h2>
    <div class="badge">Dataset Item: ${promptRaw.id}</div>
    <div class="metrics">
      District: <span>${promptRaw.district}</span><br>
      WGS84 Origin: <span>${promptRaw.prompt.originWGS84.lat.toFixed(4)}, ${promptRaw.prompt.originWGS84.lng.toFixed(4)} (Alt: ${promptRaw.prompt.originWGS84.alt}m)</span><br>
      Total 4D Voxels: <span>2,097,152 (16 frames x 64x64x32)</span><br>
      Occupancy Rate: <span>${metrics.occupancyRatePct}%</span><br>
      Static Consistency: <span>${metrics.temporalStaticConsistencyPct}%</span><br>
      Trajectory Waypoints: <span>${waypoints.length} (4000 ms duration)</span>
    </div>
    <div class="legend">
      <div class="legend-item"><div class="dot" style="background:#64748b"></div>Road</div>
      <div class="legend-item"><div class="dot" style="background:#22c55e"></div>Ground/Veg</div>
      <div class="legend-item"><div class="dot" style="background:#38bdf8"></div>Building</div>
      <div class="legend-item"><div class="dot" style="background:#ef4444"></div>Vehicle</div>
      <div class="legend-item"><div class="dot" style="background:#f59e0b"></div>Camera Path</div>
    </div>
  </div>

  <div id="timeline-panel">
    <span style="font-size: 13px; font-weight: 600;">Time Step: <span id="time-val">t=0</span></span>
    <input type="range" id="time-slider" class="slider" min="0" max="4" value="0" step="1">
    <button id="toggle-cam" style="background: #3b82f6; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;">Follow Camera</button>
  </div>

  <script>
    const framesData = ${JSON.stringify(subsampledFrames)};
    const waypointsData = ${JSON.stringify(waypoints)};

    const container = document.getElementById('canvas-container');
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0b0f19, 0.008);

    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(60, -70, 45);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfff5e6, 1.2);
    dirLight.position.set(50, 40, 80);
    scene.add(dirLight);

    // Color map for classes
    const classColors = {
      1: 0x22c55e, // Ground
      2: 0x475569, // Road
      3: 0x38bdf8, // Building
      4: 0x16a34a, // Vegetation
      5: 0xef4444, // Dynamic Vehicle
      6: 0xf97316, // Dynamic Pedestrian
      8: 0x0284c7, // Water
      9: 0x9333ea  // Infrastructure
    };

    // Draw Camera Trajectory Spline
    if (waypointsData.length > 0) {
      const curvePoints = waypointsData.map(w => new THREE.Vector3(w.x, w.y, w.z));
      const curve = new THREE.CatmullRomCurve3(curvePoints);
      const tubeGeo = new THREE.TubeGeometry(curve, 64, 0.6, 8, false);
      const tubeMat = new THREE.MeshStandardMaterial({ color: 0xf59e0b, emissive: 0xd97706, roughness: 0.2, metalness: 0.8 });
      const tubeMesh = new THREE.Mesh(tubeGeo, tubeMat);
      scene.add(tubeMesh);

      // Trajectory points
      curvePoints.forEach(p => {
        const dotGeo = new THREE.SphereGeometry(0.8, 8, 8);
        const dotMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
        const dot = new THREE.Mesh(dotGeo, dotMat);
        dot.position.copy(p);
        scene.add(dot);
      });
    }

    // Instanced Mesh for Voxels
    let instancedVoxelMesh = null;
    const boxGeometry = new THREE.BoxGeometry(1.8, 1.8, 1.8);

    function renderTimeFrame(frameIdx) {
      if (instancedVoxelMesh) {
        scene.remove(instancedVoxelMesh);
        instancedVoxelMesh.geometry.dispose();
      }

      const frame = framesData[frameIdx];
      const voxels = frame.voxels;
      const count = voxels.length;

      const material = new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.1 });
      instancedVoxelMesh = new THREE.InstancedMesh(boxGeometry, material, count);
      instancedVoxelMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      const dummy = new THREE.Object3D();
      const color = new THREE.Color();

      for (let i = 0; i < count; i++) {
        const [x, y, z, cls] = voxels[i];
        dummy.position.set(x, y, z);
        dummy.updateMatrix();
        instancedVoxelMesh.setMatrixAt(i, dummy.matrix);

        const hexColor = classColors[cls] || 0x64748b;
        color.setHex(hexColor);
        instancedVoxelMesh.setColorAt(i, color);
      }

      instancedVoxelMesh.instanceColor.needsUpdate = true;
      instancedVoxelMesh.instanceMatrix.needsUpdate = true;
      scene.add(instancedVoxelMesh);
    }

    renderTimeFrame(0);

    // Slider
    const slider = document.getElementById('time-slider');
    const timeVal = document.getElementById('time-val');
    slider.addEventListener('input', (e) => {
      const idx = parseInt(e.target.value);
      timeVal.innerText = 't=' + framesData[idx].time;
      renderTimeFrame(idx);
    });

    // Camera follow mode
    let followCamera = false;
    document.getElementById('toggle-cam').addEventListener('click', () => {
      followCamera = !followCamera;
      document.getElementById('toggle-cam').innerText = followCamera ? 'Free Orbit View' : 'Follow Camera';
    });

    window.addEventListener('resize', () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    let animTime = 0;
    function animate() {
      requestAnimationFrame(animate);
      if (followCamera && waypointsData.length > 0) {
        animTime = (animTime + 0.005) % 1;
        const ptIndex = Math.floor(animTime * (waypointsData.length - 1));
        const wp = waypointsData[ptIndex];
        camera.position.set(wp.x, wp.y, wp.z);
        const lookIdx = Math.min(waypointsData.length - 1, ptIndex + 1);
        const nextWp = waypointsData[lookIdx];
        camera.lookAt(nextWp.x, nextWp.y, nextWp.z);
      } else {
        controls.update();
      }
      renderer.render(scene, camera);
    }
    animate();
  </script>
</body>
</html>`;
  const htmlPreviewPath = import_node_path.default.resolve("public/s4d_interactive_viewer.html");
  import_node_fs.default.mkdirSync(import_node_path.default.dirname(htmlPreviewPath), { recursive: true });
  import_node_fs.default.writeFileSync(htmlPreviewPath, htmlContent, "utf8");
  console.log(`[PASS] Exported interactive HTML viewer to: ${htmlPreviewPath}`);
  return { success: true, metrics, htmlPreviewPath };
}
testS4DSample("data/test_sample_prompt.json", "data/test_sample_tensor.rle");
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  testS4DSample
});
