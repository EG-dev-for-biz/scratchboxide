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

// scripts/run_s4d_dataset_pipeline.ts
var run_s4d_dataset_pipeline_exports = {};
__export(run_s4d_dataset_pipeline_exports, {
  runS4DDatasetPipeline: () => runS4DDatasetPipeline
});
module.exports = __toCommonJS(run_s4d_dataset_pipeline_exports);
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));

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

// packages/core/src/node/spatial/TemporalSimulationSolver.ts
var TemporalSimulationSolver = class {
  /**
   * Evaluates the Catmull-Rom spline at interpolation parameter t (0.0 to 1.0)
   * given four 3D control points.
   */
  static evaluateCatmullRom(p0, p1, p2, p3, t) {
    const t2 = t * t;
    const t3 = t2 * t;
    const f0 = -0.5 * t3 + t2 - 0.5 * t;
    const f1 = 1.5 * t3 - 2.5 * t2 + 1;
    const f2 = -1.5 * t3 + 2 * t2 + 0.5 * t;
    const f3 = 0.5 * t3 - 0.5 * t2;
    return [
      p0[0] * f0 + p1[0] * f1 + p2[0] * f2 + p3[0] * f3,
      p0[1] * f0 + p1[1] * f1 + p2[1] * f2 + p3[1] * f3,
      p0[2] * f0 + p1[2] * f1 + p2[2] * f2 + p3[2] * f3
    ];
  }
  /**
   * Simulates the 4D timeline trajectory of a dynamic entity (like a drone or vehicle).
   * Calculates precise spatial transforms, velocity, and appends telemetry logs over time steps.
   */
  static simulateSplineTrack(entity, origin, splinePoints, timeStepMs = 250) {
    const ltp = new LocalTangentPlane(origin);
    const simulatedEntity = { ...entity };
    const telemetry = [];
    const durationMs = entity.time.durationMs || 5e3;
    const steps = Math.floor(durationMs / timeStepMs);
    if (splinePoints.length < 4) {
      return simulatedEntity;
    }
    let prevPosLocal = splinePoints[1];
    for (let s = 0; s <= steps; s++) {
      const timeMs = s * timeStepMs;
      const progress = timeMs / durationMs;
      const numSegments = splinePoints.length - 3;
      const val = progress * numSegments;
      const segmentIndex = Math.min(numSegments - 1, Math.floor(val));
      const segmentT = val - segmentIndex;
      const p0 = splinePoints[segmentIndex];
      const p1 = splinePoints[segmentIndex + 1];
      const p2 = splinePoints[segmentIndex + 2];
      const p3 = splinePoints[segmentIndex + 3];
      const localPos = this.evaluateCatmullRom(p0, p1, p2, p3, segmentT);
      const terrainHeight = -1.5 + Math.sin(localPos[0] * 0.1) * 0.4;
      if (localPos[1] < terrainHeight) {
        localPos[1] = terrainHeight + 3;
      }
      const geoPos = ltp.toLatLng(localPos);
      const dx = localPos[0] - prevPosLocal[0];
      const dy = localPos[1] - prevPosLocal[1];
      const dz = localPos[2] - prevPosLocal[2];
      const distanceMeters = Math.hypot(dx, dy, dz);
      const speedMps = distanceMeters / (timeStepMs / 1e3);
      const speedKmh = Math.min(120, speedMps * 3.6);
      const heading = Math.atan2(dx, -dz) * 180 / Math.PI;
      telemetry.push({
        timestampMs: timeMs,
        gps: {
          lat: geoPos.lat,
          lng: geoPos.lng,
          alt: geoPos.alt,
          heading: (heading + 360) % 360
        },
        speedKmh: s === 0 ? 0 : parseFloat(speedKmh.toFixed(1)),
        status: s === 0 ? "STARTING" : s === steps ? "COMPLETED" : "FLYING"
      });
      if (s === 0) {
        simulatedEntity.space.localTransform = {
          position: localPos,
          rotationQuaternion: [0, 0, 0, 1],
          scale: [1, 1, 1]
        };
        simulatedEntity.space.geoAnchor = {
          lat: geoPos.lat,
          lng: geoPos.lng,
          alt: geoPos.alt,
          heading: (heading + 360) % 360
        };
      }
      prevPosLocal = localPos;
    }
    simulatedEntity.behavior.telemetryStream = telemetry;
    return simulatedEntity;
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

// packages/core/src/node/spatial/Synthetic4DDataGenerator.ts
var Synthetic4DDataGenerator = class {
  /**
   * Synthesizes a paired 4D training sequence with static terrain, buildings, and a dynamic moving agent.
   */
  static generateSequence(config) {
    const dimensions = config.dimensions || [16, 64, 64, 32];
    const voxelSize = config.voxelSizeMeters || [2, 2, 2];
    const [T, dimX, dimY, dimZ] = dimensions;
    const [vx, vy, vz] = voxelSize;
    const timeStepMs = config.timeStepMs || 250;
    const terrainBase = config.terrainBaseElevation ?? 0;
    const baseEntity = {
      id: `synthetic_agent_${Date.now()}`,
      name: "Synthetic Drone Flight Track",
      space: {
        geoAnchor: config.origin,
        localTransform: {
          position: [0, 0, 0],
          scale: [1, 1, 1]
        }
      },
      time: {
        startMs: 0,
        durationMs: T * timeStepMs,
        isContinuous: false
      },
      environment: {
        weather: {
          conditions: "sunny"
        }
      },
      content: { type: "mesh-glb", durableUri: "" },
      behavior: {},
      lineage: { worldBranchId: "earth/main", version: 1 }
    };
    const simulatedEntity = TemporalSimulationSolver.simulateSplineTrack(
      baseEntity,
      config.origin,
      config.splinePoints,
      timeStepMs
    );
    const prompt = OccSoraBridge.serializeTrajectoryPrompt(simulatedEntity, config.origin);
    const totalVoxelsPerTimeStep = dimX * dimY * dimZ;
    const totalVoxels = T * totalVoxelsPerTimeStep;
    const grid = new Uint8Array(totalVoxels);
    const classHistogram = {};
    const halfX = dimX * vx / 2;
    const halfY = dimY * vy / 2;
    const minZ = terrainBase - 4 * vz;
    const getVoxelIndex = (t, x, y, z) => {
      return t * (dimX * dimY * dimZ) + x * (dimY * dimZ) + y * dimZ + z;
    };
    const buildings = config.buildings || [];
    for (let x = 0; x < dimX; ++x) {
      const posX = -halfX + (x + 0.5) * vx;
      for (let y = 0; y < dimY; ++y) {
        const posY = -halfY + (y + 0.5) * vy;
        let inBuilding = false;
        let buildingMaxZ = terrainBase;
        for (const b of buildings) {
          const dx = Math.abs(posX - b.centerENU[0]);
          const dy = Math.abs(posY - b.centerENU[1]);
          if (dx <= b.width / 2 && dy <= b.depth / 2) {
            inBuilding = true;
            buildingMaxZ = terrainBase + b.height;
            break;
          }
        }
        for (let z = 0; z < dimZ; ++z) {
          const posZ = minZ + (z + 0.5) * vz;
          let semanticClass = 0 /* AIRSPACE */;
          if (posZ <= terrainBase) {
            semanticClass = 1 /* TERRAIN */;
          } else if (inBuilding && posZ <= buildingMaxZ) {
            semanticClass = posZ >= buildingMaxZ - vz ? 3 /* BUILDING_FACADE */ : 4 /* BUILDING_INTERIOR */;
          }
          if (semanticClass !== 0 /* AIRSPACE */) {
            for (let t = 0; t < T; ++t) {
              const idx = getVoxelIndex(t, x, y, z);
              grid[idx] = semanticClass;
            }
          }
        }
      }
    }
    const agentSemantic = config.agentType === "ground" ? 8 /* DYNAMIC_GROUND_AGENT */ : 7 /* DYNAMIC_AIR_AGENT */;
    const waypoints = prompt.waypoints;
    for (let t = 0; t < T; ++t) {
      if (t >= waypoints.length) break;
      const wp = waypoints[t];
      const gx = Math.floor((wp.x + halfX) / vx);
      const gy = Math.floor((wp.y + halfY) / vy);
      const gz = Math.floor((wp.z - minZ) / vz);
      for (let dx = -1; dx <= 0; ++dx) {
        for (let dy = -1; dy <= 0; ++dy) {
          for (let dz = -1; dz <= 0; ++dz) {
            const ax = gx + dx;
            const ay = gy + dy;
            const az = gz + dz;
            if (ax >= 0 && ax < dimX && ay >= 0 && ay < dimY && az >= 0 && az < dimZ) {
              const idx = getVoxelIndex(t, ax, ay, az);
              grid[idx] = agentSemantic;
            }
          }
        }
      }
    }
    for (let i = 0; i < grid.length; ++i) {
      const cls = grid[i];
      classHistogram[cls] = (classHistogram[cls] || 0) + 1;
    }
    const sparseRle = OccSoraBridge.rleEncode(grid);
    const metadata = {
      dimensions,
      voxelSizeMeters: voxelSize,
      originENU: [0, 0, terrainBase],
      classes: {
        [0 /* AIRSPACE */]: "Airspace",
        [1 /* TERRAIN */]: "Terrain",
        [2 /* WATER */]: "Water",
        [3 /* BUILDING_FACADE */]: "Building Facade",
        [4 /* BUILDING_INTERIOR */]: "Building Interior",
        [5 /* VEGETATION */]: "Vegetation",
        [6 /* TRANSIT_ROAD */]: "Transit Road",
        [7 /* DYNAMIC_AIR_AGENT */]: "Dynamic Air Agent",
        [8 /* DYNAMIC_GROUND_AGENT */]: "Dynamic Ground Agent",
        [9 /* DYNAMIC_HAZARD */]: "Dynamic Hazard"
      },
      timeStepMs
    };
    return {
      id: `s4d_item_${Date.now()}`,
      prompt,
      occupancyGrid: {
        metadata,
        sparseRleBytes: sparseRle
      },
      classHistogram
    };
  }
};

// scripts/run_s4d_dataset_pipeline.ts
var DISTRICT_PROFILES = [
  {
    name: "San Francisco Financial District",
    origin: { lat: 37.7937, lng: -122.3965, alt: 12 },
    terrainBase: 12,
    buildingCount: 6,
    maxBuildingHeight: 70,
    defaultAgentType: "air"
  },
  {
    name: "Manhattan Midtown Canyon",
    origin: { lat: 40.7484, lng: -73.9857, alt: 15 },
    terrainBase: 15,
    buildingCount: 8,
    maxBuildingHeight: 90,
    defaultAgentType: "air"
  },
  {
    name: "Tokyo Shibuya Commercial",
    origin: { lat: 35.6595, lng: 139.7004, alt: 18 },
    terrainBase: 18,
    buildingCount: 7,
    maxBuildingHeight: 50,
    defaultAgentType: "ground"
  },
  {
    name: "Alpine Mountain Ridge",
    origin: { lat: 45.9763, lng: 7.7491, alt: 1600 },
    terrainBase: 0,
    buildingCount: 2,
    maxBuildingHeight: 20,
    defaultAgentType: "air"
  },
  {
    name: "Dubai Marina Waterfront",
    origin: { lat: 25.0805, lng: 55.1403, alt: 5 },
    terrainBase: 5,
    buildingCount: 5,
    maxBuildingHeight: 80,
    defaultAgentType: "air"
  }
];
async function runS4DDatasetPipeline(totalSamples = 20, outputDir) {
  const taskIndex = parseInt(process.env.CLOUD_RUN_TASK_INDEX || "0", 10);
  const taskCount = parseInt(process.env.CLOUD_RUN_TASK_COUNT || "1", 10);
  const defaultRoot = process.env.OUTPUT_DIR || (fs.existsSync("/mnt/gcs") ? "/mnt/gcs/s4d_dataset" : path.join(process.cwd(), "data", "s4d_dataset"));
  const baseDir = outputDir || path.join(defaultRoot, `task_${taskIndex}`);
  fs.mkdirSync(baseDir, { recursive: true });
  console.log(`
======================================================`);
  console.log(`  \u{1F680} Scratchbox-4D (S4D) Spatiotemporal Dataset Pipeline`);
  console.log(`  Task Index: ${taskIndex} / ${taskCount}`);
  console.log(`  Target Sequence Count: ${totalSamples}`);
  console.log(`  Output Shard Directory: ${baseDir}`);
  console.log(`======================================================
`);
  const manifest = [];
  const startTime = Date.now();
  for (let i = 0; i < totalSamples; i++) {
    const district = DISTRICT_PROFILES[(i + taskIndex) % DISTRICT_PROFILES.length];
    const buildings = [];
    for (let b = 0; b < district.buildingCount; b++) {
      const angle = b / district.buildingCount * Math.PI * 2 + (Math.random() * 0.4 - 0.2);
      const dist = 15 + Math.random() * 35;
      buildings.push({
        centerENU: [Math.cos(angle) * dist, Math.sin(angle) * dist],
        width: 12 + Math.random() * 16,
        depth: 12 + Math.random() * 16,
        height: 15 + Math.random() * (district.maxBuildingHeight - 15)
      });
    }
    const altitudeOffset = district.defaultAgentType === "air" ? 25 + Math.random() * 30 : 4;
    const splinePoints = [
      [-45 + Math.random() * 10, -45 + Math.random() * 10, altitudeOffset],
      [-15 + Math.random() * 10, 5 + Math.random() * 10, altitudeOffset + (Math.random() * 15 - 7)],
      [15 + Math.random() * 10, 25 + Math.random() * 10, altitudeOffset + (Math.random() * 15 - 7)],
      [45 + Math.random() * 10, 45 + Math.random() * 10, altitudeOffset]
    ];
    const datasetItem = Synthetic4DDataGenerator.generateSequence({
      origin: district.origin,
      splinePoints,
      dimensions: [16, 64, 64, 32],
      // Standard S4D training tensor shape
      voxelSizeMeters: [2, 2, 2],
      terrainBaseElevation: district.terrainBase,
      buildings,
      agentType: district.defaultAgentType,
      timeStepMs: 250
    });
    const promptPath = path.join(baseDir, `${datasetItem.id}_prompt.json`);
    const tensorPath = path.join(baseDir, `${datasetItem.id}_tensor.rle`);
    fs.writeFileSync(
      promptPath,
      JSON.stringify(
        {
          id: datasetItem.id,
          district: district.name,
          prompt: datasetItem.prompt,
          metadata: datasetItem.occupancyGrid.metadata,
          histogram: datasetItem.classHistogram
        },
        null,
        2
      )
    );
    fs.writeFileSync(tensorPath, datasetItem.occupancyGrid.sparseRleBytes || "", "utf-8");
    manifest.push({
      id: datasetItem.id,
      promptFile: path.basename(promptPath),
      tensorFile: path.basename(tensorPath),
      district: district.name
    });
    if ((i + 1) % 5 === 0 || i === totalSamples - 1) {
      const elapsedSec = ((Date.now() - startTime) / 1e3).toFixed(1);
      console.log(`[Batch Progress] Generated ${i + 1}/${totalSamples} sequences (${elapsedSec}s elapsed)`);
    }
  }
  const manifestPath = path.join(baseDir, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        taskIndex,
        taskCount,
        totalItems: manifest.length,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        items: manifest
      },
      null,
      2
    )
  );
  console.log(`
\u2705 Shard generation complete! Manifest written to: ${manifestPath}`);
  return { manifestPath, count: manifest.length };
}
var isDirectCli = process.argv.some((arg) => arg.includes("run_s4d_dataset_pipeline"));
if (isDirectCli) {
  const count = parseInt(process.env.BATCH_SIZE || process.argv.find((arg) => /^\d+$/.test(arg)) || "10", 10);
  runS4DDatasetPipeline(count).catch((err) => {
    console.error("Fatal batch pipeline error:", err);
    process.exit(1);
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  runS4DDatasetPipeline
});
