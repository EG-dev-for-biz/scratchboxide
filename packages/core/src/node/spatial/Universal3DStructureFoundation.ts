/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import {
  MetricBoundingBox,
  UniversalSurfaceMesh,
  UniversalCollisionHull,
  VideoDiffusionCameraBlockout,
  Target3DFormat,
  Universal3DStructureInitOptions,
  MultiFormatExportResult
} from '../../common/spatial/universal-3d-structure-types';
import {
  ProceduralSfMDatasetService,
  ProceduralCameraPose,
  ProceduralPoint3D,
  Vector3Tuple
} from './ProceduralSfMDatasetService';
import { GeodeticAnchor } from '../../common/spatial/colmap-vector-reference-types';
import { LocalTangentPlane } from '../../common/coordinate/LocalTangentPlane';

/**
 * Universal 3D Structure Foundation
 *
 * The single canonical source of truth for 3D spatial structure.
 * Maintains metric ground-truth geometry, surface constellations, and calibrated camera rigs,
 * with deterministic adapters projecting into any downstream 3D format:
 * - GLB / glTF 2.0 (Viewports, Three.js, Unreal, Blender)
 * - COLMAP (Photogrammetry, GLOMAP, bundle adjustment)
 * - Nerfstudio (3D Gaussian Splatting, NeRF, Splatfacto)
 * - Video Diffusion Blockouts (<VIDEO_REF_0>, Google Omni 1.1, Veo, Sora)
 * - Collision & Navigation Hulls (Physics engines, obstacle avoidance)
 * - WGS-84 RFC 7946 GeoJSON (GIS, Google Maps Platform)
 */
export class Universal3DStructureFoundation {
  public readonly id: string;
  public readonly name: string;
  public readonly anchor?: GeodeticAnchor;
  public readonly mesh: UniversalSurfaceMesh;
  public readonly points: ProceduralPoint3D[];
  public readonly cameras: ProceduralCameraPose[];
  public readonly boundingBox: MetricBoundingBox;
  public readonly collisionHull: UniversalCollisionHull;
  public readonly tags: string[];
  public readonly metadata: Record<string, any>;

  constructor(options: Universal3DStructureInitOptions) {
    this.id = options.id || `struct_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    this.name = options.name || 'Universal_3D_Structure';
    this.anchor = options.anchor;
    this.mesh = options.mesh || {
      vertices: new Float32Array(),
      triangleCount: 0,
      vertexCount: 0
    };
    this.points = options.points || [];
    this.cameras = options.cameras || [];
    this.boundingBox = options.boundingBox || Universal3DStructureFoundation.computeBoundingBox(this.mesh);
    this.collisionHull = options.collisionHull || Universal3DStructureFoundation.computeDefaultCollisionHull(this.boundingBox);
    this.tags = options.tags || ['3d-structure', 'canonical-anchor'];
    this.metadata = options.metadata || {};
  }

  /**
   * Computes the metric axis-aligned bounding box and bounding sphere for a mesh.
   */
  public static computeBoundingBox(mesh: UniversalSurfaceMesh): MetricBoundingBox {
    const v = mesh.vertices;
    if (!v || v.length < 3) {
      return {
        min: [-1, -1, -1],
        max: [1, 1, 1],
        center: [0, 0, 0],
        extents: [2, 2, 2],
        boundingSphereRadius: Math.sqrt(3)
      };
    }

    let minX = v[0], minY = v[1], minZ = v[2];
    let maxX = v[0], maxY = v[1], maxZ = v[2];

    for (let i = 3; i < v.length; i += 3) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }

    const center: Vector3Tuple = [
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2
    ];
    const extents: Vector3Tuple = [
      maxX - minX,
      maxY - minY,
      maxZ - minZ
    ];
    const radius = Math.hypot(extents[0], extents[1], extents[2]) / 2;

    return {
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
      center,
      extents,
      boundingSphereRadius: radius
    };
  }

  /**
   * Computes default collision hull from a bounding box.
   */
  public static computeDefaultCollisionHull(bbox: MetricBoundingBox): UniversalCollisionHull {
    return {
      type: 'box',
      center: bbox.center,
      dimensions: bbox.extents,
      radius: bbox.boundingSphereRadius
    };
  }

  /**
   * Factory: Create structure from procedural geometry.
   */
  public static createFromProcedural(
    shape: 'box' | 'sphere' | 'cylinder' | 'torus',
    options?: {
      name?: string;
      scale?: number;
      center?: Vector3Tuple;
      numViews?: number;
      pointDensity?: number;
      anchor?: GeodeticAnchor;
    }
  ): Universal3DStructureFoundation {
    const scale = options?.scale ?? 1.0;
    const center = options?.center ?? [0, scale, 0];
    const pointDensity = options?.pointDensity ?? 2000;
    const numViews = options?.numViews ?? 24;

    // 1. Procedural Surface Points
    const points = ProceduralSfMDatasetService.sampleProceduralGeometry(shape, pointDensity, scale, center);

    // 2. Procedural Mesh Generation
    const mesh = this.generateProceduralMesh(shape, scale, center);

    // 3. Compute Bounding Box
    const bbox = this.computeBoundingBox(mesh);

    // 4. Procedural Camera Rig (Orbital Fibonacci)
    const cameras = ProceduralSfMDatasetService.generateTrajectory({
      trajectory: 'orbital_fibonacci',
      numViews,
      target: center,
      radius: bbox.boundingSphereRadius * 2.5
    });

    return new Universal3DStructureFoundation({
      name: options?.name || `Procedural_${shape.toUpperCase()}`,
      anchor: options?.anchor,
      mesh,
      points,
      cameras,
      boundingBox: bbox,
      tags: ['procedural', shape, 'canonical-anchor']
    });
  }

  /**
   * Generates analytical triangle mesh for procedural primitives.
   */
  private static generateProceduralMesh(
    shape: 'box' | 'sphere' | 'cylinder' | 'torus',
    scale: number,
    center: Vector3Tuple
  ): UniversalSurfaceMesh {
    if (shape === 'box') {
      const s = scale;
      const [cx, cy, cz] = center;
      // 8 vertices of a cube
      const rawVerts = [
        cx - s, cy - s, cz + s,  cx + s, cy - s, cz + s,  cx + s, cy + s, cz + s,  cx - s, cy + s, cz + s,
        cx - s, cy - s, cz - s,  cx - s, cy + s, cz - s,  cx + s, cy + s, cz - s,  cx + s, cy - s, cz - s
      ];
      // 12 triangles (36 indices)
      const rawIndices = [
        0, 1, 2,  0, 2, 3, // front
        1, 7, 6,  1, 6, 2, // right
        7, 4, 5,  7, 5, 6, // back
        4, 0, 3,  4, 3, 5, // left
        3, 2, 6,  3, 6, 5, // top
        4, 7, 1,  4, 1, 0  // bottom
      ];
      return {
        vertices: new Float32Array(rawVerts),
        indices: new Uint32Array(rawIndices),
        triangleCount: 12,
        vertexCount: 8
      };
    }

    // Sphere / Cylinder / Torus parametric approximation
    const uSegs = 24;
    const vSegs = 16;
    const vertices: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];

    if (shape === 'sphere') {
      for (let j = 0; j <= vSegs; j++) {
        const theta = (j * Math.PI) / vSegs;
        const sinTheta = Math.sin(theta);
        const cosTheta = Math.cos(theta);

        for (let i = 0; i <= uSegs; i++) {
          const phi = (i * 2 * Math.PI) / uSegs;
          const x = Math.cos(phi) * sinTheta;
          const y = cosTheta;
          const z = Math.sin(phi) * sinTheta;

          normals.push(x, y, z);
          vertices.push(center[0] + x * scale, center[1] + y * scale, center[2] + z * scale);
        }
      }

      for (let j = 0; j < vSegs; j++) {
        for (let i = 0; i < uSegs; i++) {
          const first = j * (uSegs + 1) + i;
          const second = first + uSegs + 1;
          indices.push(first, second, first + 1);
          indices.push(second, second + 1, first + 1);
        }
      }
    } else {
      // Cylinder default
      const height = scale * 2;
      for (let j = 0; j <= vSegs; j++) {
        const y = (j / vSegs - 0.5) * height;
        for (let i = 0; i <= uSegs; i++) {
          const phi = (i * 2 * Math.PI) / uSegs;
          const x = Math.cos(phi);
          const z = Math.sin(phi);
          normals.push(x, 0, z);
          vertices.push(center[0] + x * scale, center[1] + y, center[2] + z * scale);
        }
      }
      for (let j = 0; j < vSegs; j++) {
        for (let i = 0; i < uSegs; i++) {
          const first = j * (uSegs + 1) + i;
          const second = first + uSegs + 1;
          indices.push(first, second, first + 1);
          indices.push(second, second + 1, first + 1);
        }
      }
    }

    return {
      vertices: new Float32Array(vertices),
      indices: new Uint32Array(indices),
      normals: new Float32Array(normals),
      triangleCount: indices.length / 3,
      vertexCount: vertices.length / 3
    };
  }

  // ==========================================
  // FORMAT ADAPTERS (Projections Outward)
  // ==========================================

  /**
   * Adapter 1: Standard COLMAP Format
   * Exports cameras.txt, images.txt, points3D.txt.
   */
  public toColmap(): { camerasText: string; imagesText: string; points3DText: string } {
    const bundle = ProceduralSfMDatasetService.serializeBundle(this.cameras, this.points);
    return {
      camerasText: bundle.camerasText,
      imagesText: bundle.imagesText,
      points3DText: bundle.points3DText
    };
  }

  /**
   * Adapter 2: Standard Nerfstudio Format
   * Exports transforms.json and sparse_pcd.ply.
   */
  public toNerfstudio(): { transformsJson: string; sparsePcdPly: string } {
    const bundle = ProceduralSfMDatasetService.serializeBundle(this.cameras, this.points);
    return {
      transformsJson: bundle.transformsJson,
      sparsePcdPly: bundle.sparsePcdPly
    };
  }

  /**
   * Adapter 3: Video Diffusion Camera Blockout (<VIDEO_REF_0>)
   * Exports camera trajectory for Gemini Omni, Veo, Sora.
   */
  public toVideoCameraBlockout(fps: number = 24): VideoDiffusionCameraBlockout {
    const frames = this.cameras.map((cam, idx) => ({
      frameIndex: idx,
      timestampSeconds: Number((idx / fps).toFixed(3)),
      position: cam.position,
      target: cam.target,
      c2wMatrix: cam.c2wMatrixNerfstudio,
      fovDegrees: cam.intrinsics.fovHorizontalDeg
    }));

    const duration = frames.length > 0 ? (frames.length - 1) / fps : 0;

    return {
      videoRef: '<VIDEO_REF_0>',
      fps,
      frameCount: frames.length,
      durationSeconds: Number(duration.toFixed(2)),
      trajectoryType: 'orbit_360',
      startPose: {
        position: this.cameras[0]?.position || [0, 1, 3],
        target: this.cameras[0]?.target || [0, 0, 0],
        fovDegrees: this.cameras[0]?.intrinsics.fovHorizontalDeg || 60
      },
      frames
    };
  }

  /**
   * Adapter 4: Simplified Collision Hull & Navigation Bounds
   */
  public toCollisionHull(): UniversalCollisionHull {
    return this.collisionHull;
  }

  /**
   * Adapter 5: RFC 7946 GeoJSON (WGS-84 GIS projection)
   */
  public toGeoJson(): Record<string, any> {
    const anchor = this.anchor || {
      lat: 41.8902,
      lng: 12.4922,
      elevationMeters: 50.0
    };

    const ltp = new LocalTangentPlane({
      lat: anchor.lat,
      lng: anchor.lng,
      alt: anchor.elevationMeters
    });

    const features: any[] = [];

    // 1. Structure Origin Feature
    features.push({
      type: 'Feature',
      properties: {
        id: this.id,
        name: this.name,
        type: 'structure_origin',
        radiusMeters: this.boundingBox.boundingSphereRadius
      },
      geometry: {
        type: 'Point',
        coordinates: [anchor.lng, anchor.lat, anchor.elevationMeters]
      }
    });

    // 2. Camera Station Points
    for (const cam of this.cameras) {
      const geoPos = ltp.toLatLng(cam.position);
      features.push({
        type: 'Feature',
        properties: {
          id: cam.id,
          name: cam.name,
          type: 'camera_station',
          fov: cam.intrinsics.fovHorizontalDeg
        },
        geometry: {
          type: 'Point',
          coordinates: [
            Number(geoPos.lng.toFixed(7)),
            Number(geoPos.lat.toFixed(7)),
            Number((geoPos.alt ?? anchor.elevationMeters).toFixed(2))
          ]
        }
      });
    }

    return {
      type: 'FeatureCollection',
      features
    };
  }

  /**
   * Adapter 6: Minimal binary glTF 2.0 (.glb) Buffer
   */
  public toGlbBuffer(): Buffer {
    const v = this.mesh.vertices;
    const vertexByteLength = v.length * 4;
    const binBuffer = Buffer.alloc(vertexByteLength);

    for (let i = 0; i < v.length; i++) {
      binBuffer.writeFloatLE(v[i], i * 4);
    }

    const gltfJson = {
      asset: { version: '2.0', generator: 'Scratchbox_Universal3DStructure' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{
        primitives: [{
          attributes: { POSITION: 0 },
          mode: 4 // TRIANGLES
        }]
      }],
      accessors: [{
        bufferView: 0,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: this.mesh.vertexCount,
        type: 'VEC3',
        max: this.boundingBox.max,
        min: this.boundingBox.min
      }],
      bufferViews: [{
        buffer: 0,
        byteOffset: 0,
        byteLength: vertexByteLength,
        target: 34962 // ARRAY_BUFFER
      }],
      buffers: [{
        byteLength: vertexByteLength
      }]
    };

    const jsonText = JSON.stringify(gltfJson);
    const jsonPaddedLength = Math.ceil(jsonText.length / 4) * 4;
    const jsonBuffer = Buffer.alloc(jsonPaddedLength, 0x20); // Pad with spaces
    jsonBuffer.write(jsonText, 'utf8');

    const totalLength = 12 + 8 + jsonPaddedLength + 8 + vertexByteLength;
    const glb = Buffer.alloc(totalLength);

    // GLB Header
    glb.writeUInt32LE(0x46546C67, 0); // magic: 'glTF'
    glb.writeUInt32LE(2, 4);          // version: 2
    glb.writeUInt32LE(totalLength, 8);// total file length

    // JSON Chunk Header
    glb.writeUInt32LE(jsonPaddedLength, 12);
    glb.writeUInt32LE(0x4E4F534A, 16); // 'JSON'
    jsonBuffer.copy(glb, 20);

    // BIN Chunk Header
    const binOffset = 20 + jsonPaddedLength;
    glb.writeUInt32LE(vertexByteLength, binOffset);
    glb.writeUInt32LE(0x004E4942, binOffset + 4); // 'BIN\0'
    binBuffer.copy(glb, binOffset + 8);

    return glb;
  }

  /**
   * Export all formats at once.
   */
  public exportAll(): MultiFormatExportResult {
    const colmap = this.toColmap();
    const nerfstudio = this.toNerfstudio();
    const videoBlockout = this.toVideoCameraBlockout();
    const collisionHull = this.toCollisionHull();
    const geoJson = this.toGeoJson();
    const glbBuffer = this.toGlbBuffer();

    return {
      structureId: this.id,
      name: this.name,
      formatsExported: ['glb', 'colmap', 'nerfstudio', 'video_blockout', 'collision_hull', 'geojson'],
      colmap,
      nerfstudio,
      videoBlockout,
      collisionHull,
      geoJson,
      glbBuffer
    };
  }

  /**
   * Export to disk in target directory.
   */
  public async exportToDisk(
    outputDir: string,
    formats: Target3DFormat[] = ['glb', 'colmap', 'nerfstudio', 'video_blockout', 'geojson']
  ): Promise<MultiFormatExportResult> {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const filesWritten: Record<string, string> = {};
    const result = this.exportAll();

    if (formats.includes('glb')) {
      const glbPath = path.join(outputDir, `${this.name}.glb`);
      fs.writeFileSync(glbPath, result.glbBuffer!);
      filesWritten.glb = glbPath;
    }

    if (formats.includes('colmap')) {
      const colmapDir = path.join(outputDir, 'sparse', '0');
      fs.mkdirSync(colmapDir, { recursive: true });
      const camPath = path.join(colmapDir, 'cameras.txt');
      const imgPath = path.join(colmapDir, 'images.txt');
      const ptsPath = path.join(colmapDir, 'points3D.txt');
      fs.writeFileSync(camPath, result.colmap!.camerasText, 'utf8');
      fs.writeFileSync(imgPath, result.colmap!.imagesText, 'utf8');
      fs.writeFileSync(ptsPath, result.colmap!.points3DText, 'utf8');
      filesWritten.colmapCameras = camPath;
      filesWritten.colmapImages = imgPath;
      filesWritten.colmapPoints = ptsPath;
    }

    if (formats.includes('nerfstudio')) {
      const transPath = path.join(outputDir, 'transforms.json');
      const plyPath = path.join(outputDir, 'sparse_pcd.ply');
      fs.writeFileSync(transPath, result.nerfstudio!.transformsJson, 'utf8');
      fs.writeFileSync(plyPath, result.nerfstudio!.sparsePcdPly, 'utf8');
      filesWritten.nerfTransforms = transPath;
      filesWritten.nerfPcd = plyPath;
    }

    if (formats.includes('video_blockout')) {
      const blockoutPath = path.join(outputDir, `${this.name}_video_blockout.json`);
      fs.writeFileSync(blockoutPath, JSON.stringify(result.videoBlockout, null, 2), 'utf8');
      filesWritten.videoBlockout = blockoutPath;
    }

    if (formats.includes('geojson')) {
      const geoPath = path.join(outputDir, `${this.name}_spatial.geojson`);
      fs.writeFileSync(geoPath, JSON.stringify(result.geoJson, null, 2), 'utf8');
      filesWritten.geoJson = geoPath;
    }

    result.filesWritten = filesWritten;
    return result;
  }
}
