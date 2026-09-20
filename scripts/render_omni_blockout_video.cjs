var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// scripts/render_omni_blockout_video.ts
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_http = __toESM(require("node:http"));
var import_node_child_process = require("node:child_process");

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
  static rleDecode(rleBase642, totalCount) {
    const raw = Buffer.from(rleBase642, "base64");
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

// scripts/render_omni_blockout_video.ts
var PORT = 8089;
var TOTAL_FRAMES = 72;
var STORYBOARD_BEATS = 8;
var FRAMES_DIR = import_node_path.default.resolve("public/videos/frames");
var STORYBOARDS_DIR = import_node_path.default.resolve("public/storyboards");
var VIDEOS_DIR = import_node_path.default.resolve("public/videos");
import_node_fs.default.mkdirSync(FRAMES_DIR, { recursive: true });
import_node_fs.default.mkdirSync(STORYBOARDS_DIR, { recursive: true });
import_node_fs.default.mkdirSync(VIDEOS_DIR, { recursive: true });
var promptRaw = JSON.parse(import_node_fs.default.readFileSync("data/test_sample_prompt.json", "utf8"));
var rleBase64 = import_node_fs.default.readFileSync("data/test_sample_tensor.rle", "utf8");
var expectedVoxels = 16 * 64 * 64 * 32;
var decompressed = OccSoraBridge.rleDecode(rleBase64, expectedVoxels);
var frameStride = 64 * 64 * 32;
var timeIndices = [0, 2, 4, 6, 8, 10, 12, 15];
var framesData = [];
for (const t of timeIndices) {
  const off = t * frameStride;
  const vox = [];
  for (let z = 0; z < 32; z += 2) {
    for (let y = 0; y < 64; y += 2) {
      for (let x = 0; x < 64; x += 2) {
        const idx = off + (z * 64 * 64 + y * 64 + x);
        const cls = decompressed[idx];
        if (cls !== GeospatialSemanticClass.FREE_SPACE && cls !== GeospatialSemanticClass.SKY) {
          vox.push([x - 32, y - 32, z, cls]);
        }
      }
    }
  }
  framesData.push({ time: t, voxels: vox });
}
var waypointsData = promptRaw.prompt.waypoints;
var htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>S4D Blockout Reference Video Recorder</title>
  <style>
    body { margin: 0; background: #070a12; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; color: #fff; }
    #canvas { width: 1280px; height: 720px; display: block; }
    #status { position: absolute; bottom: 16px; left: 16px; background: rgba(11, 15, 25, 0.9); backdrop-filter: blur(8px); padding: 8px 16px; border-radius: 8px; font-size: 13px; z-index: 100; border: 1px solid rgba(56, 189, 248, 0.3); box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
    #hud { position: absolute; top: 16px; left: 16px; z-index: 90; display: flex; gap: 8px; }
    .badge { background: rgba(56, 189, 248, 0.15); border: 1px solid #38bdf8; color: #38bdf8; font-size: 11px; font-weight: bold; padding: 5px 12px; border-radius: 4px; letter-spacing: 0.05em; text-transform: uppercase; }
    .badge-gold { background: rgba(245, 158, 11, 0.15); border: 1px solid #f59e0b; color: #f59e0b; }
    .badge-purple { background: rgba(168, 85, 247, 0.15); border: 1px solid #a855f7; color: #c084fc; }
  </style>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head>
<body>
  <div id="hud">
    <div class="badge">SCRATCHBOX-4D SPATIAL ENGINE</div>
    <div class="badge badge-gold">&lt;VIDEO_REF_0&gt; 3D BLOCKOUT</div>
    <div class="badge badge-purple">4D TRAJECTORY CONDITIONING</div>
  </div>
  <div id="status">Initializing 3D Blockout Renderer...</div>
  <canvas id="canvas" width="1280" height="720"></canvas>

  <script>
    const framesData = ${JSON.stringify(framesData)};
    const waypointsData = ${JSON.stringify(waypointsData)};
    const TOTAL_FRAMES = ${TOTAL_FRAMES};
    const statusEl = document.getElementById('status');
    const canvas = document.getElementById('canvas');

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x070a12, 0.007);

    const camera = new THREE.PerspectiveCamera(54, 1280 / 720, 0.1, 1000);
    camera.up.set(0, 0, 1);

    const renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(1280, 720);
    renderer.setClearColor(0x070a12, 1);
    renderer.shadowMap.enabled = true;

    // Dynamic cinematic lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfef08a, 1.7);
    sunLight.position.set(70, -50, 90);
    scene.add(sunLight);

    const fillLight = new THREE.DirectionalLight(0x38bdf8, 0.9);
    fillLight.position.set(-60, 50, 30);
    scene.add(fillLight);

    const classColors = {
      1: 0x22c55e, // Ground
      2: 0x475569, // Road
      3: 0x38bdf8, // Buildings
      4: 0x16a34a, // Vegetation
      5: 0xef4444, // Vehicles
      6: 0xf97316, // Pedestrians
      8: 0x0284c7, // Water
      9: 0x9333ea  // Infrastructure
    };

    // Trajectory spline
    const curvePoints = waypointsData.map(w => new THREE.Vector3(w.x, w.y, w.z));
    const curve = new THREE.CatmullRomCurve3(curvePoints);
    const tubeGeo = new THREE.TubeGeometry(curve, 100, 0.75, 8, false);
    const tubeMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xd97706,
      emissiveIntensity: 0.9,
      roughness: 0.2,
      metalness: 0.8
    });
    scene.add(new THREE.Mesh(tubeGeo, tubeMat));

    // Trajectory waypoint markers
    curvePoints.forEach((p, idx) => {
      const dotGeo = new THREE.SphereGeometry(1.0, 12, 12);
      const dotMat = new THREE.MeshBasicMaterial({ color: idx === 0 ? 0x22c55e : (idx === curvePoints.length - 1 ? 0xef4444 : 0xfef08a) });
      const dot = new THREE.Mesh(dotGeo, dotMat);
      dot.position.copy(p);
      scene.add(dot);
    });

    // Drone / Camera flight head indicator
    const droneGeo = new THREE.SphereGeometry(1.5, 16, 16);
    const droneMat = new THREE.MeshStandardMaterial({ color: 0x06b6d4, emissive: 0x0284c7, emissiveIntensity: 1.0, roughness: 0.1 });
    const droneMesh = new THREE.Mesh(droneGeo, droneMat);
    scene.add(droneMesh);

    let instancedVoxelMesh = null;
    const boxGeometry = new THREE.BoxGeometry(1.82, 1.82, 1.82);

    function renderTimeFrame(frameIdx) {
      if (instancedVoxelMesh) {
        scene.remove(instancedVoxelMesh);
        instancedVoxelMesh.geometry.dispose();
      }
      const frame = framesData[frameIdx];
      const voxels = frame.voxels;
      const count = voxels.length;

      const material = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.15 });
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

      instancedVoxelMesh.instanceMatrix.needsUpdate = true;
      if (instancedVoxelMesh.instanceColor) instancedVoxelMesh.instanceColor.needsUpdate = true;
      scene.add(instancedVoxelMesh);
    }

    async function recordAllFrames() {
      statusEl.innerText = "Starting 3D Blockout Recording (72 frames)...";
      
      for (let i = 0; i < TOTAL_FRAMES; i++) {
        const u = i / (TOTAL_FRAMES - 1);
        const timeIdx = Math.min(framesData.length - 1, Math.floor(u * (framesData.length - 1)));
        renderTimeFrame(timeIdx);

        // Position animated drone mesh along the flight trajectory
        const dronePos = curve.getPointAt(u);
        droneMesh.position.copy(dronePos);

        // Smooth cinematic orbital sweep over the Manhattan Canyon blockout
        // Sweeps azimuth from -75 deg to -35 deg, descending slightly to reveal skyscrapers
        const theta = -Math.PI * 0.45 + u * 0.65;
        const radius = 78 - 14 * Math.sin(u * Math.PI);
        const camX = radius * Math.cos(theta);
        const camY = radius * Math.sin(theta);
        const camZ = 46 - 10 * u;

        camera.position.set(camX, camY, camZ);
        // Track between the city center and the active drone
        camera.lookAt(dronePos.x * 0.4, dronePos.y * 0.4, 12);

        renderer.render(scene, camera);

        const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
        statusEl.innerText = "Recording frame " + (i + 1) + "/" + TOTAL_FRAMES + " (t=" + (u * 3.0).toFixed(2) + "s)";

        await fetch('/upload-frame', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ index: i, total: TOTAL_FRAMES, dataUrl: dataUrl, u: u })
        });
      }

      statusEl.innerText = "All frames captured! Transferring to encoder...";
      await fetch('/done', { method: 'POST' });
    }

    setTimeout(recordAllFrames, 500);
  </script>
</body>
</html>`;
import_node_fs.default.writeFileSync("public/s4d_blockout_render.html", htmlContent);
console.log("\u2705 Generated public/s4d_blockout_render.html");
var receivedFrames = 0;
var server = import_node_http.default.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/upload-frame") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        const base64Data = payload.dataUrl.replace(/^data:image\/jpeg;base64,/, "");
        const filename = `frame_${String(payload.index).padStart(4, "0")}.jpg`;
        const filepath = import_node_path.default.join(FRAMES_DIR, filename);
        import_node_fs.default.writeFileSync(filepath, Buffer.from(base64Data, "base64"));
        const beatStep = Math.floor(TOTAL_FRAMES / STORYBOARD_BEATS);
        if (payload.index % beatStep === 0 && Math.floor(payload.index / beatStep) < STORYBOARD_BEATS) {
          const beatIdx = Math.floor(payload.index / beatStep);
          const beatFilename = `beat_${String(beatIdx).padStart(2, "0")}.jpg`;
          import_node_fs.default.writeFileSync(import_node_path.default.join(STORYBOARDS_DIR, beatFilename), Buffer.from(base64Data, "base64"));
          console.log(`\u{1F4F8} Storyboard Beat ${beatIdx + 1}/${STORYBOARD_BEATS} saved: ${beatFilename}`);
        }
        receivedFrames++;
        if (receivedFrames % 12 === 0 || receivedFrames === TOTAL_FRAMES) {
          console.log(`\u{1F39E}\uFE0F  Captured Frame ${receivedFrames}/${TOTAL_FRAMES} (${(receivedFrames / TOTAL_FRAMES * 100).toFixed(0)}%)`);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
      } catch (err) {
        res.writeHead(500);
        res.end(err.message);
      }
    });
  } else if (req.method === "POST" && req.url === "/done") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "complete" }));
    console.log("\u{1F389} All 72 frames successfully transferred to server!");
    compileVideo();
  } else if (req.url === "/s4d_blockout_render.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(htmlContent);
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});
server.listen(PORT, () => {
  console.log(`\u{1F680} Recorder server running on http://127.0.0.1:${PORT}`);
  launchChrome();
});
var chromeProcess = null;
function launchChrome() {
  const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const args = [
    "--headless=new",
    "--user-data-dir=/tmp/chrome_blockout_rec",
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=metal",
    "--window-size=1280,720",
    `http://127.0.0.1:${PORT}/s4d_blockout_render.html`
  ];
  console.log(`\u{1F310} Launching headless Chrome to capture blockout animation...`);
  chromeProcess = (0, import_node_child_process.spawn)(chromePath, args);
  chromeProcess.on("error", (err) => {
    console.error("Failed to launch Chrome:", err);
  });
}
function compileVideo() {
  if (chromeProcess) {
    chromeProcess.kill();
  }
  const mp4Output = import_node_path.default.join(VIDEOS_DIR, "s4d_manhattan_blockout_ref.mp4");
  const webmOutput = import_node_path.default.join(VIDEOS_DIR, "s4d_manhattan_blockout_ref.webm");
  console.log(`\u{1F3AC} Compiling MP4 video via ffmpeg (24fps, H.264, 3.0s)...`);
  const ffmpegCmd = `/opt/homebrew/bin/ffmpeg -y -framerate 24 -i "${FRAMES_DIR}/frame_%04d.jpg" -c:v libx264 -pix_fmt yuv420p -b:v 4M "${mp4Output}" && /opt/homebrew/bin/ffmpeg -y -framerate 24 -i "${FRAMES_DIR}/frame_%04d.jpg" -c:v libvpx-vp9 -b:v 3M "${webmOutput}"`;
  (0, import_node_child_process.exec)(ffmpegCmd, (err, stdout, stderr) => {
    if (err) {
      console.error("\u274C ffmpeg compilation error:", err);
    } else {
      console.log(`\u2705 Successfully generated: ${mp4Output} (${(import_node_fs.default.statSync(mp4Output).size / 1024).toFixed(1)} KB)`);
      console.log(`\u2705 Successfully generated: ${webmOutput} (${(import_node_fs.default.statSync(webmOutput).size / 1024).toFixed(1)} KB)`);
    }
    server.close(() => {
      console.log("\u{1F3C1} Process complete. Exiting.");
      process.exit(0);
    });
  });
}
