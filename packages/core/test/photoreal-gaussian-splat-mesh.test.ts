/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  PhotorealGaussianSplatMesh,
  type SplatData
} from '../src/browser/generative-canvas/services/spatial/PhotorealGaussianSplatMesh';
import { SpatialGenerativeRuntime } from '../src/browser/generative-canvas/services/spatial/SpatialGenerativeRuntime';
import { computeSceneGeometryBounds } from '../src/browser/generative-canvas/primitives/scene3d/autoFraming';

function createMockSplatBuffer(count: number): ArrayBuffer {
  const buffer = new ArrayBuffer(count * 32);
  const view = new DataView(buffer);
  for (let i = 0; i < count; i++) {
    const off = i * 32;
    // Position (x, y, z)
    view.setFloat32(off + 0, (i - count / 2) * 2.0, true);
    view.setFloat32(off + 4, i * 0.5, true);
    view.setFloat32(off + 8, i * 3.0, true);

    // Scale (sx, sy, sz)
    view.setFloat32(off + 12, 0.1, true);
    view.setFloat32(off + 16, 0.1, true);
    view.setFloat32(off + 20, 0.1, true);

    // Color (r, g, b, a)
    view.setUint8(off + 24, 255);
    view.setUint8(off + 25, 128);
    view.setUint8(off + 26, 64);
    view.setUint8(off + 27, 200);

    // Quaternion (qx, qy, qz, qw)
    view.setUint8(off + 28, 128); // 0.0
    view.setUint8(off + 29, 128); // 0.0
    view.setUint8(off + 30, 128); // 0.0
    view.setUint8(off + 31, 255); // 1.0
  }
  return buffer;
}

describe('PhotorealGaussianSplatMesh & Spatial Engine Integration', () => {
  it('parses 32-byte standard .splat binary buffer accurately', () => {
    const count = 100;
    const buf = createMockSplatBuffer(count);
    const splatData = PhotorealGaussianSplatMesh.parseSplatBuffer(buf);

    expect(splatData.count).toBe(count);
    expect(splatData.positions.length).toBe(count * 3);
    expect(splatData.scales.length).toBe(count * 3);
    expect(splatData.colors.length).toBe(count * 3);
    expect(splatData.opacities.length).toBe(count);
    expect(splatData.quats.length).toBe(count * 4);

    expect(splatData.bounds).toBeDefined();
    expect(splatData.bounds?.min[1]).toBe(0);
    expect(splatData.bounds?.max[1]).toBeCloseTo((count - 1) * 0.5, 3);
    expect(splatData.centroid).toBeDefined();
  });

  it('a small splat object frames by its splats: real geometry bounds, and a contact shadow its own size kept out of framing', () => {
    // 200 splats on a 0.1 m sphere centred 0.2 m up (a groomed coat's scale)
    const count = 200;
    const buffer = new ArrayBuffer(count * 32);
    const view = new DataView(buffer);
    for (let i = 0; i < count; i++) {
      const y = 1 - (2 * (i + 0.5)) / count, r = Math.sqrt(1 - y * y), a = i * 2.399963;
      const off = i * 32;
      view.setFloat32(off, 0.1 * r * Math.cos(a), true);
      view.setFloat32(off + 4, 0.2 + 0.1 * y, true);
      view.setFloat32(off + 8, 0.1 * r * Math.sin(a), true);
      for (let k = 0; k < 3; k++) view.setFloat32(off + 12 + 4 * k, 0.003, true);
      view.setUint8(off + 24, 200); view.setUint8(off + 25, 120); view.setUint8(off + 26, 60); view.setUint8(off + 27, 255);
      view.setUint8(off + 28, 128); view.setUint8(off + 29, 128); view.setUint8(off + 30, 128); view.setUint8(off + 31, 255);
    }
    const splatData = PhotorealGaussianSplatMesh.parseSplatBuffer(buffer);
    const mesh = new PhotorealGaussianSplatMesh(splatData, { contactShadow: true });
    const scene = new THREE.Scene();
    scene.add(mesh);
    const bounds = computeSceneGeometryBounds(scene);
    expect(bounds.hasGeometry).toBe(true);
    // the sphere's own bound (0.1 m radius, a little more for the box corners), not the unit quad's 0.71 m or the shadow's metres
    expect(bounds.sphere.radius).toBeGreaterThan(0.09);
    expect(bounds.sphere.radius).toBeLessThan(0.2);
    expect(bounds.sphere.center.y).toBeCloseTo(0.2, 2);
    const shadow = mesh.children.find(c => c.name === 'sb-splat-contact-shadow') as THREE.Mesh;
    shadow.geometry.computeBoundingSphere();
    // a long directional shadow, but scaled by the object (its plane is 2.5 x the splats' width and depth + height)
    expect(shadow.geometry.boundingSphere!.radius).toBeLessThan(0.6);
    expect(shadow.position.y).toBeCloseTo(0.1, 2);
  });

  it('constructs instanced geometry and production shader material', () => {
    const count = 20;
    const buf = createMockSplatBuffer(count);
    const splatData = PhotorealGaussianSplatMesh.parseSplatBuffer(buf);

    const splatMesh = new PhotorealGaussianSplatMesh(splatData, {
      splatScale: 1.2,
      focalLengthMm: 35.0,
      apertureFStop: 1.8,
      dofStrength: 0.5,
      contactAO: 0.8,
      contactShadow: true
    });

    expect(splatMesh.isPhotorealGaussianSplatMesh).toBe(true);
    expect(splatMesh.splatCount).toBe(count);
    expect(splatMesh.children.length).toBeGreaterThanOrEqual(1);

    // Verify contact shadow mesh exists
    const shadowChild = splatMesh.children.find((c) => c.renderOrder === -1);
    expect(shadowChild).toBeDefined();

    splatMesh.dispose();
  });

  it('sorts splats back-to-front along camera viewing direction', () => {
    const count = 5;
    const buf = createMockSplatBuffer(count);
    const splatData = PhotorealGaussianSplatMesh.parseSplatBuffer(buf);

    const splatMesh = new PhotorealGaussianSplatMesh(splatData, {
      enableDepthSort: true,
      sortFrequencyFrames: 1
    });

    const camera = new THREE.PerspectiveCamera(60, 1.0, 0.1, 1000);
    camera.position.set(0, 0, -10);
    camera.lookAt(0, 0, 100); // looking towards +Z
    camera.updateMatrixWorld();

    splatMesh.updateDepthSort(camera, true);

    // With texture-based splat data, sorting writes original splat indices into sortOrder.
    // Verify the first draw slot maps to the spatially furthest splat and the last to the closest.
    const sortAttr = (splatMesh.children[0] as THREE.Mesh).geometry.getAttribute(
      'sortOrder'
    ) as THREE.InstancedBufferAttribute;
    const firstOrigIdx = sortAttr.getX(0);       // draw slot 0 → furthest splat
    const lastOrigIdx  = sortAttr.getX(count - 1); // draw slot N-1 → closest splat

    const z0    = splatData.positions[firstOrigIdx * 3 + 2];
    const zLast = splatData.positions[lastOrigIdx  * 3 + 2];

    expect(z0).toBeGreaterThan(zLast);

    splatMesh.dispose();
  });

  it('tunes Soft-Z, solar lighting, and optical DoF parameters dynamically', () => {
    const count = 10;
    const buf = createMockSplatBuffer(count);
    const splatData = PhotorealGaussianSplatMesh.parseSplatBuffer(buf);
    const splatMesh = new PhotorealGaussianSplatMesh(splatData);

    // Tune Soft-Z
    splatMesh.setSoftZUniforms({
      near: 0.5,
      far: 500.0,
      epsilon: 0.12,
      enabled: true
    });

    // Tune Lighting
    splatMesh.setLightingUniforms({
      sunDir: new THREE.Vector3(1, 1, 0),
      sunIntensity: 1.5,
      sunColor: new THREE.Color(1.0, 0.9, 0.8)
    });

    // Tune Camera Optics
    splatMesh.setCameraOptics(85.0, 1.4, 3.5, 0.9);

    const mat = (splatMesh.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
    expect(mat.uniforms.uSoftZEpsilon.value).toBe(0.12);
    expect(mat.uniforms.uSoftZEnabled.value).toBe(1.0);
    expect(mat.uniforms.uFocalLength.value).toBe(85.0);
    expect(mat.uniforms.uAperture.value).toBe(1.4);
    expect(mat.uniforms.uFocusDist.value).toBe(3.5);
    expect(mat.uniforms.uDofStrength.value).toBe(0.9);

    splatMesh.dispose();
  });

  it('integrates seamlessly with SpatialGenerativeRuntime anchorGenerativeMedia', async () => {
    const runtime = new SpatialGenerativeRuntime();
    const count = 50;
    const buf = createMockSplatBuffer(count);

    const anchorGroup = await runtime.anchorGenerativeMedia({
      id: 'test_splat_entity',
      sourceType: 'gaussian-splat-splat',
      buffer: buf,
      anchor: { latitude: 40.7484, longitude: -73.9857, altitudeMsl: 15.0 },
      enableSoftZ: true,
      softZEpsilonMeters: 0.15
    });

    expect(anchorGroup).toBeDefined();
    expect(anchorGroup.name).toBe('GenerativeMedia_test_splat_entity');

    const splatChild = anchorGroup.children.find((c) => (c as any).isPhotorealGaussianSplatMesh);
    expect(splatChild).toBeDefined();

    // Verify per-frame update executes sorting and lighting sync
    const metrics = runtime.update(performance.now());
    expect(metrics.fps).toBeGreaterThan(0);

    // Teardown
    runtime.removeGenerativeMedia('test_splat_entity');
    expect(runtime.getAllGenerativeMedia().length).toBe(0);
    runtime.dispose();
  });
});
