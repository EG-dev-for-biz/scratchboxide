/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { SplatData, PhotorealGaussianSplatMesh } from './PhotorealGaussianSplatMesh';

export interface SplatCalibrationTransformState {
  position: [number, number, number];
  rotationEuler: [number, number, number]; // Radians [x, y, z]
  scale: [number, number, number];
  cropBox?: {
    min: [number, number, number];
    max: [number, number, number];
  };
}

export type SplatGizmoMode = 'translate' | 'rotate' | 'scale' | 'crop';

/**
 * Interactive 6-DoF Calibration & Spatial Cropping Gizmo for 3D Gaussian Splats.
 * Enables sub-millimeter coordinate alignment with Google 3D Tiles, fine-tuning of
 * translation, rotation, and anisotropic scale, plus real-time GPU bounding-box
 * cropping and destructive CPU dataset filtering.
 */
export class SpatialSplatCalibrationGizmo extends THREE.Group {
  public targetObject: THREE.Object3D | null = null;
  public cropBox: THREE.Box3 = new THREE.Box3(
    new THREE.Vector3(-10, -10, -10),
    new THREE.Vector3(10, 10, 10)
  );

  private mode: SplatGizmoMode = 'translate';
  private cropBoxHelper?: THREE.LineSegments;
  private cropHandlesGroup: THREE.Group = new THREE.Group();
  private isCroppingEnabled: boolean = false;

  constructor(target?: THREE.Object3D) {
    super();
    this.name = 'SpatialSplatCalibrationGizmo';
    this.add(this.cropHandlesGroup);

    this.buildCropBoxVisuals();

    if (target) {
      this.attach(target);
    }
  }

  /**
   * Attaches the gizmo to a target Object3D or PhotorealGaussianSplatMesh.
   */
  public override attach(target: THREE.Object3D): this {
    this.targetObject = target;
    this.position.copy(target.position);
    this.rotation.copy(target.rotation);
    this.scale.copy(target.scale);
    this.visible = true;

    // If target has bounds, initialize crop box from them
    const splatMesh = target as any;
    if (splatMesh.splatData?.bounds) {
      const b = splatMesh.splatData.bounds;
      this.cropBox.min.set(b.min[0], b.min[1], b.min[2]);
      this.cropBox.max.set(b.max[0], b.max[1], b.max[2]);
      this.updateCropBoxVisuals();
    }
    return this;
  }

  /**
   * Detaches the gizmo from the current target.
   */
  public detach(): void {
    if (this.targetObject && this.isCroppingEnabled) {
      if (typeof (this.targetObject as any).setClipBox === 'function') {
        (this.targetObject as any).setClipBox(null);
      }
    }
    this.targetObject = null;
    this.visible = false;
  }

  /**
   * Sets the active manipulation mode.
   */
  public setMode(mode: SplatGizmoMode): void {
    this.mode = mode;
    this.cropHandlesGroup.visible = (mode === 'crop');
    if (this.cropBoxHelper) {
      this.cropBoxHelper.visible = (mode === 'crop' || this.isCroppingEnabled);
    }
  }

  public getMode(): SplatGizmoMode {
    return this.mode;
  }

  /**
   * Enables or disables real-time GPU bounding-box clipping on the attached target.
   */
  public enableCropping(enabled: boolean): void {
    this.isCroppingEnabled = enabled;
    if (this.cropBoxHelper) {
      this.cropBoxHelper.visible = enabled || this.mode === 'crop';
    }

    if (this.targetObject && typeof (this.targetObject as any).setClipBox === 'function') {
      (this.targetObject as any).setClipBox(enabled ? this.cropBox : null);
    }
  }

  public isCropping(): boolean {
    return this.isCroppingEnabled;
  }

  /**
   * Sets the bounding box for spatial cropping.
   */
  public setCropBox(min: [number, number, number] | THREE.Vector3, max: [number, number, number] | THREE.Vector3): void {
    if (Array.isArray(min)) {
      this.cropBox.min.set(min[0], min[1], min[2]);
    } else {
      this.cropBox.min.copy(min);
    }

    if (Array.isArray(max)) {
      this.cropBox.max.set(max[0], max[1], max[2]);
    } else {
      this.cropBox.max.copy(max);
    }

    this.updateCropBoxVisuals();

    if (this.isCroppingEnabled && this.targetObject && typeof (this.targetObject as any).setClipBox === 'function') {
      (this.targetObject as any).setClipBox(this.cropBox);
    }
  }

  public getCropBox(): THREE.Box3 {
    return this.cropBox.clone();
  }

  /**
   * Filters a SplatData dataset, keeping only splats whose coordinates lie inside the specified crop box.
   * If invert is true, keeps splats that lie outside.
   */
  public static filterSplats(splatData: SplatData, cropBox: THREE.Box3, invert = false): SplatData {
    const minX = cropBox.min.x;
    const minY = cropBox.min.y;
    const minZ = cropBox.min.z;
    const maxX = cropBox.max.x;
    const maxY = cropBox.max.y;
    const maxZ = cropBox.max.z;

    const count = splatData.count;
    const srcPos = splatData.positions;
    const keepIndices: number[] = [];

    for (let i = 0; i < count; i++) {
      const px = srcPos[i * 3 + 0];
      const py = srcPos[i * 3 + 1];
      const pz = srcPos[i * 3 + 2];

      const inside = (
        px >= minX && px <= maxX &&
        py >= minY && py <= maxY &&
        pz >= minZ && pz <= maxZ
      );

      if (invert ? !inside : inside) {
        keepIndices.push(i);
      }
    }

    const newCount = keepIndices.length;
    const positions = new Float32Array(newCount * 3);
    const scales = new Float32Array(newCount * 3);
    const colors = new Float32Array(newCount * 3);
    const opacities = new Float32Array(newCount);
    const quats = new Float32Array(newCount * 4);

    let sh: Float32Array | undefined;
    let shDim = 0;
    if (splatData.sh && splatData.sh.length > 0) {
      shDim = Math.floor(splatData.sh.length / Math.max(1, count));
      sh = new Float32Array(newCount * shDim);
    }

    let positionsHigh: Float32Array | undefined;
    let positionsLow: Float32Array | undefined;
    if (splatData.positionsHigh && splatData.positionsLow) {
      positionsHigh = new Float32Array(newCount * 3);
      positionsLow = new Float32Array(newCount * 3);
    }

    let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
    let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;
    let sumX = 0, sumY = 0, sumZ = 0;

    for (let j = 0; j < newCount; j++) {
      const orig = keepIndices[j];

      const px = srcPos[orig * 3 + 0];
      const py = srcPos[orig * 3 + 1];
      const pz = srcPos[orig * 3 + 2];

      positions[j * 3 + 0] = px;
      positions[j * 3 + 1] = py;
      positions[j * 3 + 2] = pz;

      if (px < bMinX) bMinX = px;
      if (py < bMinY) bMinY = py;
      if (pz < bMinZ) bMinZ = pz;
      if (px > bMaxX) bMaxX = px;
      if (py > bMaxY) bMaxY = py;
      if (pz > bMaxZ) bMaxZ = pz;
      sumX += px;
      sumY += py;
      sumZ += pz;

      scales[j * 3 + 0] = splatData.scales[orig * 3 + 0];
      scales[j * 3 + 1] = splatData.scales[orig * 3 + 1];
      scales[j * 3 + 2] = splatData.scales[orig * 3 + 2];

      colors[j * 3 + 0] = splatData.colors[orig * 3 + 0];
      colors[j * 3 + 1] = splatData.colors[orig * 3 + 1];
      colors[j * 3 + 2] = splatData.colors[orig * 3 + 2];

      opacities[j] = splatData.opacities[orig];

      quats[j * 4 + 0] = splatData.quats[orig * 4 + 0];
      quats[j * 4 + 1] = splatData.quats[orig * 4 + 1];
      quats[j * 4 + 2] = splatData.quats[orig * 4 + 2];
      quats[j * 4 + 3] = splatData.quats[orig * 4 + 3];

      if (sh && splatData.sh && shDim > 0) {
        for (let k = 0; k < shDim; k++) {
          sh[j * shDim + k] = splatData.sh[orig * shDim + k];
        }
      }

      if (positionsHigh && positionsLow && splatData.positionsHigh && splatData.positionsLow) {
        positionsHigh[j * 3 + 0] = splatData.positionsHigh[orig * 3 + 0];
        positionsHigh[j * 3 + 1] = splatData.positionsHigh[orig * 3 + 1];
        positionsHigh[j * 3 + 2] = splatData.positionsHigh[orig * 3 + 2];

        positionsLow[j * 3 + 0] = splatData.positionsLow[orig * 3 + 0];
        positionsLow[j * 3 + 1] = splatData.positionsLow[orig * 3 + 1];
        positionsLow[j * 3 + 2] = splatData.positionsLow[orig * 3 + 2];
      }
    }

    return {
      count: newCount,
      positions,
      scales,
      colors,
      opacities,
      quats,
      sh,
      positionsHigh,
      positionsLow,
      bounds: newCount > 0 ? { min: [bMinX, bMinY, bMinZ], max: [bMaxX, bMaxY, bMaxZ] } : undefined,
      centroid: newCount > 0 ? [sumX / newCount, sumY / newCount, sumZ / newCount] : undefined
    };
  }

  /**
   * Permanently crops the attached PhotorealGaussianSplatMesh dataset to the current crop box.
   */
  public cropAttachedSplatMesh(invert = false): void {
    if (!this.targetObject) return;
    const target = this.targetObject as any;
    if (!target.splatData) return;

    const filtered = SpatialSplatCalibrationGizmo.filterSplats(target.splatData, this.cropBox, invert);
    target.splatData = filtered;
    target.splatCount = filtered.count;

    // Disable shader clip box since data is permanently filtered
    this.enableCropping(false);

    // Update geometry attributes
    const geo = target.splatGeometry as THREE.InstancedBufferGeometry;
    if (geo) {
      geo.setAttribute('instanceCenter', new THREE.InstancedBufferAttribute(filtered.positions, 3));
      geo.setAttribute('instanceScale', new THREE.InstancedBufferAttribute(filtered.scales, 3));
      geo.setAttribute('instanceColor', new THREE.InstancedBufferAttribute(filtered.colors, 3));
      geo.setAttribute('instanceOpacity', new THREE.InstancedBufferAttribute(filtered.opacities, 1));
      geo.setAttribute('instanceQuat', new THREE.InstancedBufferAttribute(filtered.quats, 4));

      if (filtered.positionsHigh && filtered.positionsLow) {
        geo.setAttribute('instanceCenterHigh', new THREE.InstancedBufferAttribute(filtered.positionsHigh, 3));
        geo.setAttribute('instanceCenterLow', new THREE.InstancedBufferAttribute(filtered.positionsLow, 3));
      }
    }
  }

  /**
   * Serializes current 6-DoF transform and spatial crop state for export.
   */
  public getTransformState(): SplatCalibrationTransformState {
    const obj = this.targetObject || this;
    return {
      position: [obj.position.x, obj.position.y, obj.position.z],
      rotationEuler: [obj.rotation.x, obj.rotation.y, obj.rotation.z],
      scale: [obj.scale.x, obj.scale.y, obj.scale.z],
      cropBox: this.isCroppingEnabled ? {
        min: [this.cropBox.min.x, this.cropBox.min.y, this.cropBox.min.z],
        max: [this.cropBox.max.x, this.cropBox.max.y, this.cropBox.max.z]
      } : undefined
    };
  }

  /**
   * Applies serialized transform and spatial crop state.
   */
  public applyTransformState(state: SplatCalibrationTransformState): void {
    const obj = this.targetObject || this;
    obj.position.set(state.position[0], state.position[1], state.position[2]);
    obj.rotation.set(state.rotationEuler[0], state.rotationEuler[1], state.rotationEuler[2]);
    obj.scale.set(state.scale[0], state.scale[1], state.scale[2]);

    this.position.copy(obj.position);
    this.rotation.copy(obj.rotation);
    this.scale.copy(obj.scale);

    if (state.cropBox) {
      this.setCropBox(state.cropBox.min, state.cropBox.max);
      this.enableCropping(true);
    } else {
      this.enableCropping(false);
    }
  }

  private buildCropBoxVisuals(): void {
    const boxGeo = new THREE.BufferGeometry();
    const mat = new THREE.LineBasicMaterial({ color: 0x00ffff, linewidth: 2, transparent: true, opacity: 0.85 });
    this.cropBoxHelper = new THREE.LineSegments(boxGeo, mat);
    this.cropBoxHelper.visible = false;
    this.add(this.cropBoxHelper);
    this.updateCropBoxVisuals();
  }

  private updateCropBoxVisuals(): void {
    if (!this.cropBoxHelper) return;

    const min = this.cropBox.min;
    const max = this.cropBox.max;

    // 12 edges of a box = 24 points
    const vertices = new Float32Array([
      // Bottom face
      min.x, min.y, min.z,  max.x, min.y, min.z,
      max.x, min.y, min.z,  max.x, min.y, max.z,
      max.x, min.y, max.z,  min.x, min.y, max.z,
      min.x, min.y, max.z,  min.x, min.y, min.z,
      // Top face
      min.x, max.y, min.z,  max.x, max.y, min.z,
      max.x, max.y, min.z,  max.x, max.y, max.z,
      max.x, max.y, max.z,  min.x, max.y, max.z,
      min.x, max.y, max.z,  min.x, max.y, min.z,
      // Vertical pillars
      min.x, min.y, min.z,  min.x, max.y, min.z,
      max.x, min.y, min.z,  max.x, max.y, min.z,
      max.x, min.y, max.z,  max.x, max.y, max.z,
      min.x, min.y, max.z,  min.x, max.y, max.z
    ]);

    this.cropBoxHelper.geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    this.cropBoxHelper.geometry.computeBoundingSphere();
  }
}
