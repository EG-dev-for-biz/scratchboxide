import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CameraRelativeRTC } from '../src/common/coordinate/CameraRelativeRTC';
import {
  SplatRadixSorter,
  PhotorealGaussianSplatMesh,
  DualPayloadOctreeStreamer,
  SpatialSplatCalibrationGizmo,
  SplatData
} from '../src/browser/generative-canvas/services/spatial';

describe('3DGS + Google Maps 3D Tiles Runtime Enhancements', () => {
  describe('Split-64 Relative-to-Center (RTC) GPU Precision', () => {
    it('splits camera position into high and low float32 components', () => {
      // ECEF coordinates near Paris / latitude 48.8, longitude 2.3
      const cx = 4201383.123456789;
      const cy = 171383.987654321;
      const cz = 4779213.555555555;

      const split = CameraRelativeRTC.splitCameraPosition(cx, cy, cz);

      expect(split.high[0]).toBe(Math.fround(cx));
      expect(split.low[0]).toBe(Math.fround(cx - Math.fround(cx)));
      expect(split.high[1]).toBe(Math.fround(cy));
      expect(split.low[1]).toBe(Math.fround(cy - Math.fround(cy)));
      expect(split.high[2]).toBe(Math.fround(cz));
      expect(split.low[2]).toBe(Math.fround(cz - Math.fround(cz)));

      // Reconstructed value must match original within float64 precision
      const reconstructedX = Number(split.high[0]) + Number(split.low[0]);
      expect(Math.abs(reconstructedX - cx)).toBeLessThan(1e-4);
    });

    it('splits bulk coordinate buffers into instanceCenterHigh and instanceCenterLow arrays', () => {
      const positions = new Float64Array([
        6378137.123, 100.456, -500.789,
        -1234567.89, 4567890.12, 3456789.01
      ]);

      const { high, low } = CameraRelativeRTC.getSplit64Attributes(positions);
      expect(high.length).toBe(6);
      expect(low.length).toBe(6);

      for (let i = 0; i < 6; i++) {
        const orig = positions[i];
        const recon = Number(high[i]) + Number(low[i]);
        expect(Math.abs(recon - orig)).toBeLessThan(1e-3);
      }
    });

    it('generates GLSL RTC shader chunk with high/low emulation logic', () => {
      const glsl = CameraRelativeRTC.getVertexShaderRTCChunk();
      expect(glsl).toContain('attribute vec3 instanceCenterHigh;');
      expect(glsl).toContain('attribute vec3 instanceCenterLow;');
      expect(glsl).toContain('uniform vec3 uCameraHigh;');
      expect(glsl).toContain('uniform vec3 uCameraLow;');
      expect(glsl).toContain('vec3 evaluateRtcCenter');
    });
  });

  describe('Fast 16-Bit Radix Sorter', () => {
    it('sorts splat positions back-to-front with single-pass radix sort', () => {
      const count = 5000;
      const positions = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        positions[i * 3 + 0] = (Math.random() - 0.5) * 100;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 100;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 100;
      }

      const camPos = new THREE.Vector3(0, 0, 50);
      const camDir = new THREE.Vector3(0, 0, -1);

      const sorter = new SplatRadixSorter(false);
      let callbackInvoked = false;

      sorter.sort(positions, camPos, camDir, count, (sortedIndices) => {
        callbackInvoked = true;
        expect(sortedIndices.length).toBe(count);

        // Verify back-to-front: first splat should have greater or equal projected distance than last
        const firstIdx = sortedIndices[0];
        const lastIdx = sortedIndices[count - 1];

        const pFirstZ = (positions[firstIdx * 3 + 2] - camPos.z) * camDir.z;
        const pLastZ = (positions[lastIdx * 3 + 2] - camPos.z) * camDir.z;

        expect(pFirstZ).toBeGreaterThanOrEqual(pLastZ - 0.1);
      });

      expect(callbackInvoked).toBe(true);
      sorter.dispose();
    });
  });

  describe('PhotorealGaussianSplatMesh Hardware Depth Interleaving & Shaders', () => {
    function createMockSplatData(count = 50): SplatData {
      const positions = new Float32Array(count * 3);
      const scales = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const opacities = new Float32Array(count);
      const quats = new Float32Array(count * 4);
      const sh = new Float32Array(count * 3); // Degree 1

      for (let i = 0; i < count; i++) {
        positions[i * 3 + 0] = i * 0.1;
        positions[i * 3 + 1] = i * 0.2;
        positions[i * 3 + 2] = -i * 0.5;

        scales[i * 3 + 0] = 0.01;
        scales[i * 3 + 1] = 0.01;
        scales[i * 3 + 2] = 0.001; // Planar surfel

        colors[i * 3 + 0] = 0.8;
        colors[i * 3 + 1] = 0.7;
        colors[i * 3 + 2] = 0.6;

        opacities[i] = 0.95;

        quats[i * 4 + 0] = 0;
        quats[i * 4 + 1] = 0;
        quats[i * 4 + 2] = 0;
        quats[i * 4 + 3] = 1;
      }

      return {
        count,
        positions,
        scales,
        colors,
        opacities,
        quats,
        sh,
        bounds: { min: [0, 0, -25], max: [5, 10, 0] },
        centroid: [2.5, 5, -12.5]
      };
    }

    it('initializes with hardware depth test enabled and depth write disabled', () => {
      const data = createMockSplatData(100);
      const mesh = new PhotorealGaussianSplatMesh(data, {
        depthInterleaveMode: 'hardware',
        enableRTC: true,
        useLogarithmicDepth: true
      });

      const mat = (mesh as any).splatMaterial as THREE.ShaderMaterial;
      expect(mat.depthTest).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(mat.uniforms.uDepthInterleaveMode.value).toBe(0);
      expect(mat.uniforms.uEnableRTC.value).toBe(1.0);

      // Verify logdepthbuf inclusions
      expect(mat.vertexShader).toContain('logdepthbuf_pars_vertex');
      expect(mat.vertexShader).toContain('logdepthbuf_vertex');
      expect(mat.fragmentShader).toContain('logdepthbuf_pars_fragment');
      expect(mat.fragmentShader).toContain('logdepthbuf_fragment');

      mesh.dispose();
    });

    it('switches between hardware, soft-z, and none depth interleaving modes', () => {
      const data = createMockSplatData(50);
      const mesh = new PhotorealGaussianSplatMesh(data);
      const mat = (mesh as any).splatMaterial as THREE.ShaderMaterial;

      mesh.setDepthInterleaveMode('soft-z');
      expect(mat.depthTest).toBe(true);
      expect(mat.uniforms.uSoftZEnabled.value).toBe(1.0);
      expect(mat.uniforms.uDepthInterleaveMode.value).toBe(1);

      mesh.setDepthInterleaveMode('none');
      expect(mat.depthTest).toBe(false);
      expect(mat.uniforms.uDepthInterleaveMode.value).toBe(2);

      mesh.setDepthInterleaveMode('hardware');
      expect(mat.depthTest).toBe(true);
      expect(mat.depthWrite).toBe(false);
      expect(mat.uniforms.uDepthInterleaveMode.value).toBe(0);

      mesh.dispose();
    });

    it('configures camera RTC and spatial clip box uniforms', () => {
      const data = createMockSplatData(50);
      const mesh = new PhotorealGaussianSplatMesh(data);
      const mat = (mesh as any).splatMaterial as THREE.ShaderMaterial;

      mesh.setCameraRtc([6378137.0, 100.0, 200.0]);
      expect(mat.uniforms.uEnableRTC.value).toBe(1.0);
      expect(mat.uniforms.uCameraHigh.value.x).toBeCloseTo(Math.fround(6378137.0));

      const clipBox = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
      mesh.setClipBox(clipBox);
      expect(mat.uniforms.uClipBoxEnabled.value).toBe(1.0);
      expect(mat.uniforms.uClipBoxMin.value.x).toBe(-5);
      expect(mat.uniforms.uClipBoxMax.value.x).toBe(5);

      mesh.setClipBox(null);
      expect(mat.uniforms.uClipBoxEnabled.value).toBe(0.0);

      mesh.dispose();
    });

    it('executes depth sort and applies sorted indices to attributes', () => {
      const data = createMockSplatData(100);
      const mesh = new PhotorealGaussianSplatMesh(data, { enableDepthSort: true });
      const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
      camera.position.set(0, 0, 10);
      camera.lookAt(0, 0, 0);

      expect(() => mesh.updateDepthSort(camera, true)).not.toThrow();
      mesh.dispose();
    });
  });

  describe('DualPayloadOctreeStreamer Cross-Dissolve & OGC 3D Tiles Parsing', () => {
    it('parses OGC 3D Tiles boundingVolume box into THREE.Sphere', () => {
      const boxVolume = {
        box: [
          0, 0, 0,   // Center
          10, 0, 0,  // Axis X
          0, 10, 0,  // Axis Y
          0, 0, 10   // Axis Z
        ]
      };

      const sphere = DualPayloadOctreeStreamer.parseBoundingVolume(boxVolume);
      expect(sphere.center.x).toBe(0);
      expect(sphere.center.y).toBe(0);
      expect(sphere.center.z).toBe(0);
      expect(sphere.radius).toBeCloseTo(Math.sqrt(100 + 100 + 100)); // ~17.32m
    });

    it('loads and constructs node hierarchy from tileset.json', () => {
      const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
      const streamer = new DualPayloadOctreeStreamer({
        camera,
        crossFadeDurationMs: 250
      });

      const mockTileset = {
        asset: { version: '1.1' },
        geometricError: 500,
        root: {
          boundingVolume: { sphere: [0, 0, 0, 500] },
          geometricError: 100,
          content: { uri: 'root.glb' },
          children: [
            {
              boundingVolume: { sphere: [-100, 0, 0, 200] },
              geometricError: 20,
              content: { uri: 'child_0.spz' }
            },
            {
              boundingVolume: { sphere: [100, 0, 0, 200] },
              geometricError: 20,
              content: { uri: 'child_1.glb' }
            }
          ]
        }
      };

      const rootNode = streamer.loadTilesetJson(mockTileset, 'https://storage.googleapis.com/tiles/');
      expect(rootNode).toBeDefined();
      expect(rootNode.meshPayloadUrl).toBe('https://storage.googleapis.com/tiles/root.glb');
      expect(rootNode.children?.length).toBe(2);
      expect(rootNode.children![0].splatPayloadUrl).toBe('https://storage.googleapis.com/tiles/child_0.spz');

      streamer.dispose();
    });

    it('animates cross-dissolve fade in and fade out when refining nodes', async () => {
      const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 1000);
      camera.position.set(0, 0, 50);

      let loadedCount = 0;
      let disposedCount = 0;

      const streamer = new DualPayloadOctreeStreamer({
        camera,
        errorTarget: 2.0,
        crossFadeDurationMs: 200,
        onLoadPayload: async (node) => {
          loadedCount++;
          const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
          return { mesh };
        },
        onDisposePayload: () => {
          disposedCount++;
        }
      });

      const rootNode = {
        id: 'test_root',
        boundingSphere: new THREE.Sphere(new THREE.Vector3(0, 0, 0), 10),
        geometricError: 5.0,
        meshPayloadUrl: 'mock.glb'
      };

      streamer.addRootNode(rootNode);

      // Frame 1: triggers load
      streamer.update(1080, 1000);
      expect(rootNode.isLoaded).toBe(true);

      // Wait a tick for async onLoadPayload promise
      await new Promise((r) => setTimeout(r, 10));

      // Frame 2 at t=1050 (50ms into 200ms fade in)
      streamer.update(1080, 1050);
      expect(rootNode.fadeProgress).toBeCloseTo(0.25, 1);

      // Frame 3 at t=1250 (finished fade in)
      streamer.update(1080, 1250);
      expect(rootNode.fadeProgress).toBe(1.0);
      expect(rootNode.isFading).toBe(false);

      streamer.dispose();
    });
  });

  describe('SpatialSplatCalibrationGizmo & Dataset Filtering', () => {
    function createBoxTestData(): SplatData {
      const count = 100;
      const positions = new Float32Array(count * 3);
      const scales = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const opacities = new Float32Array(count);
      const quats = new Float32Array(count * 4);
      const sh = new Float32Array(count * 3);

      for (let i = 0; i < count; i++) {
        // Points spaced along line from -50 to +50 on X axis
        positions[i * 3 + 0] = -50 + i * (100 / (count - 1));
        positions[i * 3 + 1] = 0;
        positions[i * 3 + 2] = 0;

        scales[i * 3 + 0] = 0.1;
        scales[i * 3 + 1] = 0.1;
        scales[i * 3 + 2] = 0.1;

        colors[i * 3 + 0] = 1.0;
        colors[i * 3 + 1] = 0.5;
        colors[i * 3 + 2] = 0.2;

        opacities[i] = 1.0;

        quats[i * 4 + 3] = 1.0;

        sh[i * 3 + 0] = 0.1 * i;
        sh[i * 3 + 1] = 0.2 * i;
        sh[i * 3 + 2] = 0.3 * i;
      }

      return {
        count,
        positions,
        scales,
        colors,
        opacities,
        quats,
        sh
      };
    }

    it('filters SplatData keeping only splats strictly inside the crop box', () => {
      const data = createBoxTestData();
      // Crop box containing x between -10 and +10 (approx 21 splats)
      const cropBox = new THREE.Box3(new THREE.Vector3(-10, -5, -5), new THREE.Vector3(10, 5, 5));

      const filtered = SpatialSplatCalibrationGizmo.filterSplats(data, cropBox, false);

      expect(filtered.count).toBeGreaterThan(15);
      expect(filtered.count).toBeLessThan(25);
      expect(filtered.positions.length).toBe(filtered.count * 3);
      expect(filtered.colors.length).toBe(filtered.count * 3);
      expect(filtered.sh!.length).toBe(filtered.count * 3);

      // Verify all retained splats are within crop bounds
      for (let i = 0; i < filtered.count; i++) {
        expect(filtered.positions[i * 3 + 0]).toBeGreaterThanOrEqual(-10);
        expect(filtered.positions[i * 3 + 0]).toBeLessThanOrEqual(10);
      }
    });

    it('inverts filter keeping splats strictly outside the crop box', () => {
      const data = createBoxTestData();
      const cropBox = new THREE.Box3(new THREE.Vector3(-10, -5, -5), new THREE.Vector3(10, 5, 5));

      const insideFiltered = SpatialSplatCalibrationGizmo.filterSplats(data, cropBox, false);
      const outsideFiltered = SpatialSplatCalibrationGizmo.filterSplats(data, cropBox, true);

      expect(insideFiltered.count + outsideFiltered.count).toBe(data.count);
    });

    it('serializes and applies 6-DoF transform and crop state', () => {
      const gizmo = new SpatialSplatCalibrationGizmo();
      const dummyTarget = new THREE.Object3D();
      gizmo.attach(dummyTarget);

      const state = {
        position: [12.5, -3.2, 45.0] as [number, number, number],
        rotationEuler: [0.1, 0.2, -0.3] as [number, number, number],
        scale: [1.2, 1.2, 1.2] as [number, number, number],
        cropBox: {
          min: [-5, -5, -5] as [number, number, number],
          max: [5, 5, 5] as [number, number, number]
        }
      };

      gizmo.applyTransformState(state);

      expect(dummyTarget.position.x).toBeCloseTo(12.5);
      expect(dummyTarget.position.y).toBeCloseTo(-3.2);
      expect(dummyTarget.position.z).toBeCloseTo(45.0);
      expect(gizmo.isCropping()).toBe(true);

      const exportedState = gizmo.getTransformState();
      expect(exportedState.position[0]).toBeCloseTo(12.5);
      expect(exportedState.cropBox?.min[0]).toBe(-5);
      expect(exportedState.cropBox?.max[0]).toBe(5);

      gizmo.detach();
    });
  });
});
