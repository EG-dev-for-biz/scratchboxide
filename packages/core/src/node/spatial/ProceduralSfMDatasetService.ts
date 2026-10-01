/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';

export type Vector3Tuple = [number, number, number];

export interface ProceduralPinholeIntrinsics {
  width: number;
  height: number;
  fx: number;
  fy: number;
  cx: number;
  cy: number;
  fovHorizontalDeg: number;
  fovVerticalDeg: number;
}

export interface ProceduralCameraPose {
  id: number;
  name: string;
  position: Vector3Tuple;
  target: Vector3Tuple;
  up: Vector3Tuple;
  intrinsics: ProceduralPinholeIntrinsics;

  // 4x4 row-major matrices
  c2wMatrixNerfstudio: number[]; // OpenGL convention (+X right, +Y up, -Z viewing)
  c2wMatrixOpenCv: number[];     // OpenCV convention (+X right, +Y down, +Z viewing)
  w2cMatrixOpenCv: number[];     // COLMAP convention (inverse of c2w OpenCV)

  // COLMAP images.txt representation
  colmapQuaternion: { w: number; x: number; y: number; z: number };
  colmapTranslation: Vector3Tuple;
}

export interface ProceduralPoint3D {
  id: number;
  position: Vector3Tuple;
  normal: Vector3Tuple;
  color: [number, number, number]; // [0, 255] RGB integers
  error: number;
  visibleCameraIds?: number[];
  roughness?: number; // [0, 1] PBR physical roughness
  metallic?: number;  // [0, 1] PBR physical metallicity
  uv?: [number, number]; // [u, v] surface coordinates
}

export interface ProceduralDatasetOptions {
  trajectory?: 'orbital_fibonacci' | 'turntable' | 'dome_spiral';
  numViews?: number;
  target?: Vector3Tuple;
  radius?: number;
  altitudeRange?: [number, number]; // [minAlt, maxAlt]
  resolution?: [number, number];     // [width, height], default [1920, 1080]
  fovDegrees?: number;              // default 60
  pointDensity?: number;            // number of points to sample, default 5000
}

export interface ProceduralSfMBundle {
  camerasText: string;
  imagesText: string;
  points3DText: string;
  transformsJson: string;
  sparsePcdPly: string;
  poses: ProceduralCameraPose[];
  points: ProceduralPoint3D[];
}

/**
 * Service to procedurally generate ground-truth COLMAP and Nerfstudio datasets
 * from mathematical shapes, procedural meshes, or analytical trajectories.
 */
export class ProceduralSfMDatasetService {
  private static readonly DEG2RAD = Math.PI / 180;
  private static readonly RAD2DEG = 180 / Math.PI;

  /**
   * Vector math utilities.
   */
  public static normalize(v: Vector3Tuple): Vector3Tuple {
    const len = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  }

  public static cross(a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  }

  public static dot(a: Vector3Tuple, b: Vector3Tuple): number {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  }

  /**
   * Calculates pinhole intrinsics from horizontal FOV and image dimensions.
   */
  public static calculateIntrinsics(
    width: number,
    height: number,
    fovHorizontalDeg: number
  ): ProceduralPinholeIntrinsics {
    const fx = width / (2 * Math.tan((fovHorizontalDeg / 2) * this.DEG2RAD));
    const fy = fx;
    const cx = width / 2;
    const cy = height / 2;
    const fovVerticalDeg = 2 * Math.atan(height / (2 * fy)) * this.RAD2DEG;

    return {
      width,
      height,
      fx,
      fy,
      cx,
      cy,
      fovHorizontalDeg,
      fovVerticalDeg
    };
  }

  /**
   * Builds camera basis and transforms for a given eye and target.
   */
  public static buildCameraPose(
    id: number,
    name: string,
    eye: Vector3Tuple,
    target: Vector3Tuple,
    intrinsics: ProceduralPinholeIntrinsics,
    worldUp: Vector3Tuple = [0, 1, 0]
  ): ProceduralCameraPose {
    // 1. Forward direction (eye to target)
    const forward = this.normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    let right = this.cross(forward, worldUp);
    if (Math.hypot(right[0], right[1], right[2]) < 1e-6) {
      right = [1, 0, 0];
    }
    right = this.normalize(right);
    const up = this.normalize(this.cross(right, forward));

    // 2. Camera-to-World for OpenGL / Nerfstudio:
    // +X is Right, +Y is Up, -Z is Viewing Direction (Forward)
    // C2W columns are [Right, Up, -Forward, Eye]
    const c2wNerf: number[] = [
      right[0], up[0], -forward[0], eye[0],
      right[1], up[1], -forward[1], eye[1],
      right[2], up[2], -forward[2], eye[2],
      0, 0, 0, 1
    ];

    // 3. Camera-to-World for OpenCV:
    // +X is Right, +Y is Down, +Z is Viewing Direction (Forward)
    // C2W columns are [Right, -Up, Forward, Eye]
    const c2wCv: number[] = [
      right[0], -up[0], forward[0], eye[0],
      right[1], -up[1], forward[1], eye[1],
      right[2], -up[2], forward[2], eye[2],
      0, 0, 0, 1
    ];

    // 4. World-to-Camera for COLMAP (W2C = inverse of C2W OpenCV):
    // R_w2c rows are [Right, -Up, Forward]
    // t_w2c = -R_w2c * Eye
    const R_rows: [Vector3Tuple, Vector3Tuple, Vector3Tuple] = [
      right,
      [-up[0], -up[1], -up[2]],
      forward
    ];

    const tx = -this.dot(R_rows[0], eye);
    const ty = -this.dot(R_rows[1], eye);
    const tz = -this.dot(R_rows[2], eye);

    const w2cCv: number[] = [
      R_rows[0][0], R_rows[0][1], R_rows[0][2], tx,
      R_rows[1][0], R_rows[1][1], R_rows[1][2], ty,
      R_rows[2][0], R_rows[2][1], R_rows[2][2], tz,
      0, 0, 0, 1
    ];

    // Convert R_w2c to quaternion [qw, qx, qy, qz]
    const quat = this.quaternionFromRotationMatrix(R_rows);

    return {
      id,
      name,
      position: eye,
      target,
      up,
      intrinsics,
      c2wMatrixNerfstudio: c2wNerf,
      c2wMatrixOpenCv: c2wCv,
      w2cMatrixOpenCv: w2cCv,
      colmapQuaternion: quat,
      colmapTranslation: [tx, ty, tz]
    };
  }

  /**
   * Converts a 3x3 rotation matrix (as rows) to a normalized quaternion [qw, qx, qy, qz].
   */
  public static quaternionFromRotationMatrix(
    R: [Vector3Tuple, Vector3Tuple, Vector3Tuple]
  ): { w: number; x: number; y: number; z: number } {
    const trace = R[0][0] + R[1][1] + R[2][2];
    let qw = 1, qx = 0, qy = 0, qz = 0;

    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1.0);
      qw = 0.25 / s;
      qx = (R[2][1] - R[1][2]) * s;
      qy = (R[0][2] - R[2][0]) * s;
      qz = (R[1][0] - R[0][1]) * s;
    } else if (R[0][0] > R[1][1] && R[0][0] > R[2][2]) {
      const s = 2.0 * Math.sqrt(1.0 + R[0][0] - R[1][1] - R[2][2]);
      qw = (R[2][1] - R[1][2]) / s;
      qx = 0.25 * s;
      qy = (R[0][1] + R[1][0]) / s;
      qz = (R[0][2] + R[2][0]) / s;
    } else if (R[1][1] > R[2][2]) {
      const s = 2.0 * Math.sqrt(1.0 + R[1][1] - R[0][0] - R[2][2]);
      qw = (R[0][2] - R[2][0]) / s;
      qx = (R[0][1] + R[1][0]) / s;
      qy = 0.25 * s;
      qz = (R[1][2] + R[2][1]) / s;
    } else {
      const s = 2.0 * Math.sqrt(1.0 + R[2][2] - R[0][0] - R[1][1]);
      qw = (R[1][0] - R[0][1]) / s;
      qx = (R[0][2] + R[2][0]) / s;
      qy = (R[1][2] + R[2][1]) / s;
      qz = 0.25 * s;
    }

    const mag = Math.hypot(qw, qx, qy, qz) || 1;
    return { w: qw / mag, x: qx / mag, y: qy / mag, z: qz / mag };
  }

  /**
   * Generates a procedural camera trajectory.
   */
  public static generateTrajectory(options?: ProceduralDatasetOptions): ProceduralCameraPose[] {
    const numViews = options?.numViews ?? 24;
    const trajectory = options?.trajectory ?? 'orbital_fibonacci';
    const target = options?.target ?? [0, 0, 0];
    const radius = options?.radius ?? 4.0;
    const res = options?.resolution ?? [1920, 1080];
    const fov = options?.fovDegrees ?? 60.0;
    const intrinsics = this.calculateIntrinsics(res[0], res[1], fov);

    const poses: ProceduralCameraPose[] = [];

    if (trajectory === 'turntable') {
      const alt = options?.altitudeRange ? (options.altitudeRange[0] + options.altitudeRange[1]) / 2 : 1.5;
      for (let i = 0; i < numViews; i++) {
        const theta = (2 * Math.PI * i) / numViews;
        const eye: Vector3Tuple = [
          target[0] + radius * Math.cos(theta),
          target[1] + alt,
          target[2] + radius * Math.sin(theta)
        ];
        const name = `view_${String(i).padStart(3, '0')}.png`;
        poses.push(this.buildCameraPose(i + 1, name, eye, target, intrinsics));
      }
    } else if (trajectory === 'dome_spiral') {
      const minAlt = options?.altitudeRange ? options.altitudeRange[0] : 0.5;
      const maxAlt = options?.altitudeRange ? options.altitudeRange[1] : radius * 0.9;
      for (let i = 0; i < numViews; i++) {
        const progress = i / Math.max(1, numViews - 1);
        const theta = progress * Math.PI * 4; // 2 full revolutions
        const currentAlt = minAlt + (maxAlt - minAlt) * progress;
        const currentRadius = Math.sqrt(Math.max(0.1, radius * radius - currentAlt * currentAlt));
        const eye: Vector3Tuple = [
          target[0] + currentRadius * Math.cos(theta),
          target[1] + currentAlt,
          target[2] + currentRadius * Math.sin(theta)
        ];
        const name = `view_${String(i).padStart(3, '0')}.png`;
        poses.push(this.buildCameraPose(i + 1, name, eye, target, intrinsics));
      }
    } else {
      // Default: Spherical Fibonacci on Upper Hemisphere
      const phi = (1 + Math.sqrt(5)) / 2; // Golden ratio
      for (let i = 0; i < numViews; i++) {
        // Map i to upper hemisphere (y >= 0.1 to avoid underground)
        const y = 0.15 + 0.80 * (i / Math.max(1, numViews - 1));
        const rSub = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = (2 * Math.PI * i) / phi;

        const eye: Vector3Tuple = [
          target[0] + radius * rSub * Math.cos(theta),
          target[1] + radius * y,
          target[2] + radius * rSub * Math.sin(theta)
        ];
        const name = `view_${String(i).padStart(3, '0')}.png`;
        poses.push(this.buildCameraPose(i + 1, name, eye, target, intrinsics));
      }
    }

    return poses;
  }

  /**
   * Generates procedural 3D surface points (e.g., for testing or seeding).
   * Supports standard primitives: box, sphere, cylinder, torus, or custom procedural generator.
   */
  public static sampleProceduralGeometry(
    shape: 'box' | 'sphere' | 'cylinder' | 'torus',
    count: number = 5000,
    scale: number = 1.0,
    center: Vector3Tuple = [0, 0, 0]
  ): ProceduralPoint3D[] {
    const points: ProceduralPoint3D[] = [];

    for (let i = 0; i < count; i++) {
      let pos: Vector3Tuple = [0, 0, 0];
      let norm: Vector3Tuple = [0, 1, 0];
      let color: [number, number, number] = [200, 200, 200];

      if (shape === 'sphere') {
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        const nx = Math.sin(phi) * Math.cos(theta);
        const ny = Math.cos(phi);
        const nz = Math.sin(phi) * Math.sin(theta);
        pos = [center[0] + nx * scale, center[1] + ny * scale, center[2] + nz * scale];
        norm = [nx, ny, nz];
        color = [
          Math.floor(128 + 127 * nx),
          Math.floor(128 + 127 * ny),
          Math.floor(128 + 127 * nz)
        ];
      } else if (shape === 'torus') {
        const R = scale;
        const r = scale * 0.35;
        const u = Math.random() * 2 * Math.PI;
        const v = Math.random() * 2 * Math.PI;
        const x = (R + r * Math.cos(v)) * Math.cos(u);
        const y = r * Math.sin(v);
        const z = (R + r * Math.cos(v)) * Math.sin(u);
        pos = [center[0] + x, center[1] + y, center[2] + z];
        norm = this.normalize([Math.cos(v) * Math.cos(u), Math.sin(v), Math.cos(v) * Math.sin(u)]);
        color = [
          Math.floor((u / (2 * Math.PI)) * 255),
          Math.floor(180),
          Math.floor((v / (2 * Math.PI)) * 255)
        ];
      } else if (shape === 'cylinder') {
        const u = Math.random() * 2 * Math.PI;
        const h = (Math.random() - 0.5) * 2 * scale;
        const nx = Math.cos(u);
        const nz = Math.sin(u);
        pos = [center[0] + nx * scale, center[1] + h, center[2] + nz * scale];
        norm = [nx, 0, nz];
        color = [210, 170, 130];
      } else {
        // Box
        const face = Math.floor(Math.random() * 6);
        const u = (Math.random() - 0.5) * 2 * scale;
        const v = (Math.random() - 0.5) * 2 * scale;
        switch (face) {
          case 0: pos = [scale, u, v]; norm = [1, 0, 0]; color = [220, 80, 80]; break;
          case 1: pos = [-scale, u, v]; norm = [-1, 0, 0]; color = [80, 220, 80]; break;
          case 2: pos = [u, scale, v]; norm = [0, 1, 0]; color = [80, 80, 220]; break;
          case 3: pos = [u, -scale, v]; norm = [0, -1, 0]; color = [220, 220, 80]; break;
          case 4: pos = [u, v, scale]; norm = [0, 0, 1]; color = [220, 80, 220]; break;
          case 5: default: pos = [u, v, -scale]; norm = [0, 0, -1]; color = [80, 220, 220]; break;
        }
        pos = [center[0] + pos[0], center[1] + pos[1], center[2] + pos[2]];
      }

      points.push({
        id: i + 1,
        position: pos,
        normal: norm,
        color,
        error: 0.0
      });
    }

    return points;
  }

  /**
   * Serializes the procedural dataset into a complete bundle (COLMAP text + Nerfstudio).
   */
  public static serializeBundle(
    poses: ProceduralCameraPose[],
    points: ProceduralPoint3D[]
  ): ProceduralSfMBundle {
    // 1. COLMAP cameras.txt
    const firstCam = poses[0].intrinsics;
    const camerasLines: string[] = [
      '# Camera list with one line of data per camera:',
      '#   CAMERA_ID, MODEL, WIDTH, HEIGHT, PARAMS[]',
      `1 PINHOLE ${firstCam.width} ${firstCam.height} ${firstCam.fx.toFixed(6)} ${firstCam.fy.toFixed(6)} ${firstCam.cx.toFixed(2)} ${firstCam.cy.toFixed(2)}`
    ];
    const camerasText = camerasLines.join('\n') + '\n';

    // 2. COLMAP images.txt
    const imagesLines: string[] = [
      '# Image list with two lines of data per image:',
      '#   IMAGE_ID, QW, QX, QY, QZ, TX, TY, TZ, CAMERA_ID, NAME',
      '#   POINTS2D[] as (X, Y, POINT3D_ID)',
      `# Number of images: ${poses.length}`
    ];

    for (const pose of poses) {
      const q = pose.colmapQuaternion;
      const t = pose.colmapTranslation;
      imagesLines.push(
        `${pose.id} ${q.w.toFixed(8)} ${q.x.toFixed(8)} ${q.y.toFixed(8)} ${q.z.toFixed(8)} ${t[0].toFixed(6)} ${t[1].toFixed(6)} ${t[2].toFixed(6)} 1 ${pose.name}`
      );
      // Second line: 2D points observations (empty for synthetic ground truth)
      imagesLines.push('');
    }
    const imagesText = imagesLines.join('\n') + '\n';

    // 3. COLMAP points3D.txt
    const pointsLines: string[] = [
      '# 3D point list with one line of data per point:',
      '#   POINT3D_ID, X, Y, Z, R, G, B, ERROR, TRACK[] as (IMAGE_ID, POINT2D_IDX)',
      `# Number of points: ${points.length}`
    ];

    for (const pt of points) {
      const [x, y, z] = pt.position;
      const [r, g, b] = pt.color;
      pointsLines.push(
        `${pt.id} ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)} ${r} ${g} ${b} ${pt.error.toFixed(4)}`
      );
    }
    const points3DText = pointsLines.join('\n') + '\n';

    // 4. Nerfstudio transforms.json
    const nerfFrames = poses.map(pose => {
      // 4x4 matrix row-major to 2D array
      const m = pose.c2wMatrixNerfstudio;
      const mat4x4 = [
        [m[0], m[1], m[2], m[3]],
        [m[4], m[5], m[6], m[7]],
        [m[8], m[9], m[10], m[11]],
        [m[12], m[13], m[14], m[15]]
      ];
      return {
        file_path: `./images/${pose.name}`,
        transform_matrix: mat4x4
      };
    });

    const transformsObj = {
      camera_model: 'PINHOLE',
      fl_x: firstCam.fx,
      fl_y: firstCam.fy,
      cx: firstCam.cx,
      cy: firstCam.cy,
      w: firstCam.width,
      h: firstCam.height,
      camera_angle_x: (firstCam.fovHorizontalDeg * Math.PI) / 180,
      camera_angle_y: (firstCam.fovVerticalDeg * Math.PI) / 180,
      frames: nerfFrames
    };
    const transformsJson = JSON.stringify(transformsObj, null, 2);

    // 5. Nerfstudio sparse_pcd.ply
    const plyLines: string[] = [
      'ply',
      'format ascii 1.0',
      `element vertex ${points.length}`,
      'property float x',
      'property float y',
      'property float z',
      'property float nx',
      'property float ny',
      'property float nz',
      'property uchar red',
      'property uchar green',
      'property uchar blue',
      'end_header'
    ];

    for (const pt of points) {
      const [x, y, z] = pt.position;
      const [nx, ny, nz] = pt.normal;
      const [r, g, b] = pt.color;
      plyLines.push(
        `${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)} ${nx.toFixed(4)} ${ny.toFixed(4)} ${nz.toFixed(4)} ${r} ${g} ${b}`
      );
    }
    const sparsePcdPly = plyLines.join('\n') + '\n';

    return {
      camerasText,
      imagesText,
      points3DText,
      transformsJson,
      sparsePcdPly,
      poses,
      points
    };
  }

  /**
   * Exports the complete procedural SfM dataset to disk.
   */
  public static async exportToDisk(
    bundle: ProceduralSfMBundle,
    outputDir: string,
    format: 'colmap' | 'nerfstudio' | 'both' = 'both'
  ): Promise<{
    colmapDir?: string;
    nerfstudioTransformsPath?: string;
    sparsePcdPlyPath?: string;
    imagesDir: string;
  }> {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const imagesDir = path.join(outputDir, 'images');
    if (!fs.existsSync(imagesDir)) {
      fs.mkdirSync(imagesDir, { recursive: true });
    }

    let colmapDir: string | undefined;
    if (format === 'colmap' || format === 'both') {
      colmapDir = path.join(outputDir, 'sparse', '0');
      fs.mkdirSync(colmapDir, { recursive: true });
      fs.writeFileSync(path.join(colmapDir, 'cameras.txt'), bundle.camerasText, 'utf8');
      fs.writeFileSync(path.join(colmapDir, 'images.txt'), bundle.imagesText, 'utf8');
      fs.writeFileSync(path.join(colmapDir, 'points3D.txt'), bundle.points3DText, 'utf8');
    }

    let nerfstudioTransformsPath: string | undefined;
    let sparsePcdPlyPath: string | undefined;
    if (format === 'nerfstudio' || format === 'both') {
      nerfstudioTransformsPath = path.join(outputDir, 'transforms.json');
      sparsePcdPlyPath = path.join(outputDir, 'sparse_pcd.ply');
      fs.writeFileSync(nerfstudioTransformsPath, bundle.transformsJson, 'utf8');
      fs.writeFileSync(sparsePcdPlyPath, bundle.sparsePcdPly, 'utf8');
    }

    return {
      colmapDir,
      nerfstudioTransformsPath,
      sparsePcdPlyPath,
      imagesDir
    };
  }
}
