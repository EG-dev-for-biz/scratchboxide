/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import { decodeSpz, isGzip } from '../../../../common/splat-spz-codec';
import { CameraRelativeRTC } from '../../../../common/coordinate/CameraRelativeRTC';
import { SplatRadixSorter } from './SplatRadixSorter';
import { EWA_CUTOFF_SIGMA, EWA_SPLAT_GLSL } from '../../../../common/spatial/splat-ewa-projection';

export interface SplatData {
  count: number;
  positions: Float32Array;
  scales: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
  quats: Float32Array;
  positionsHigh?: Float32Array;
  positionsLow?: Float32Array;
  sh?: Float32Array;
  bounds?: {
    min: [number, number, number];
    max: [number, number, number];
  };
  centroid?: [number, number, number];
}

export interface PhotorealSplatOptions {
  splatScale?: number;
  focalLengthMm?: number;
  apertureFStop?: number;
  focusDistMeters?: number;
  dofStrength?: number;
  exposureEV?: number;
  viewDependenceSH?: number;
  contactAO?: number;
  enableSoftZ?: boolean;
  softZEpsilonMeters?: number;
  tileDepthMap?: THREE.Texture | null;
  tileDepthNear?: number;
  tileDepthFar?: number;
  enableDepthSort?: boolean;
  sortFrequencyFrames?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  depthInterleaveMode?: 'hardware' | 'soft-z' | 'none';
  useLogarithmicDepth?: boolean;
  enableRTC?: boolean;
  enableAsyncWorkerSort?: boolean;
  contactShadow?: boolean;
}

/**
 * Production-grade Photoreal 3D Gaussian Splatting Mesh for Scratchbox IDE.
 * Integrates 2D EWA Screen-Space Ellipse Covariance, Thin-Lens Optical Bokeh (DoF),
 * Degree-1 Spherical Harmonics Radiance, Radix/Depth Sorting, and Continuous
 * Volumetric Soft-Z Depth Interleaving against Google Photorealistic 3D Tiles.
 */
export class PhotorealGaussianSplatMesh extends THREE.Group {
  public readonly isPhotorealGaussianSplatMesh = true;
  public readonly splatCount: number;
  public readonly splatData: SplatData;

  private splatMesh: THREE.Mesh;
  private splatGeometry: THREE.InstancedBufferGeometry;
  private splatMaterial: THREE.ShaderMaterial;
  private contactShadowMesh?: THREE.Mesh;

  private enableDepthSort: boolean;
  private sortFrequencyFrames: number;
  private frameCounter = 0;
  private lastSortedCamPos = new THREE.Vector3(Infinity, Infinity, Infinity);
  private lastSortedCamDir = new THREE.Vector3(0, 0, 0);

  // High-performance radix sorter with Web Worker support
  private radixSorter: SplatRadixSorter;

  // Depth sorting working buffers
  private sortIndices?: Uint32Array;
  private sortDistances?: Float32Array;

  constructor(splatData: SplatData, options: PhotorealSplatOptions = {}) {
    super();
    this.name = 'PhotorealGaussianSplatMesh';
    this.splatData = splatData;
    this.splatCount = splatData.count;

    this.enableDepthSort = options.enableDepthSort ?? true;
    this.sortFrequencyFrames = options.sortFrequencyFrames ?? 4;
    this.radixSorter = new SplatRadixSorter(options.enableAsyncWorkerSort ?? false);

    // If Split-64 RTC is requested, ensure high/low position attributes are populated
    if (options.enableRTC && (!splatData.positionsHigh || !splatData.positionsLow)) {
      const split = CameraRelativeRTC.getSplit64Attributes(splatData.positions);
      splatData.positionsHigh = split.high;
      splatData.positionsLow = split.low;
    }

    // 1. Build Instanced Quad Geometry
    const quadGeo = new THREE.PlaneGeometry(1, 1);
    const instancedGeo = new THREE.InstancedBufferGeometry();
    instancedGeo.index = quadGeo.index;
    instancedGeo.attributes.position = quadGeo.attributes.position;
    instancedGeo.attributes.uv = quadGeo.attributes.uv;

    instancedGeo.setAttribute(
      'instanceCenter',
      new THREE.InstancedBufferAttribute(new Float32Array(splatData.positions), 3)
    );
    if (splatData.positionsHigh && splatData.positionsLow) {
      instancedGeo.setAttribute(
        'instanceCenterHigh',
        new THREE.InstancedBufferAttribute(new Float32Array(splatData.positionsHigh), 3)
      );
      instancedGeo.setAttribute(
        'instanceCenterLow',
        new THREE.InstancedBufferAttribute(new Float32Array(splatData.positionsLow), 3)
      );
    } else {
      instancedGeo.setAttribute(
        'instanceCenterHigh',
        new THREE.InstancedBufferAttribute(new Float32Array(splatData.count * 3), 3)
      );
      instancedGeo.setAttribute(
        'instanceCenterLow',
        new THREE.InstancedBufferAttribute(new Float32Array(splatData.count * 3), 3)
      );
    }
    instancedGeo.setAttribute(
      'instanceScale',
      new THREE.InstancedBufferAttribute(new Float32Array(splatData.scales), 3)
    );
    instancedGeo.setAttribute(
      'instanceColor',
      new THREE.InstancedBufferAttribute(new Float32Array(splatData.colors), 3)
    );
    instancedGeo.setAttribute(
      'instanceOpacity',
      new THREE.InstancedBufferAttribute(new Float32Array(splatData.opacities), 1)
    );
    instancedGeo.setAttribute(
      'instanceQuat',
      new THREE.InstancedBufferAttribute(new Float32Array(splatData.quats), 4)
    );

    this.splatGeometry = instancedGeo;

    // 2. Build Production Shader Material
    const vw = options.viewportWidth || 1920;
    const vh = options.viewportHeight || 1080;

    const dummyDepth = new THREE.DataTexture(new Float32Array([1.0]), 1, 1, THREE.RedFormat, THREE.FloatType);
    dummyDepth.needsUpdate = true;

    // Scales are per-axis standard deviations (the .splat / .spz / 3DGS PLY convention) and are drawn as they are;
    // splatScale is an explicit user multiplier only.
    const splatScale = options.splatScale ?? 1.0;

    const interleaveMode = options.depthInterleaveMode ?? (options.enableSoftZ ? 'soft-z' : 'hardware');
    const isHardware = interleaveMode === 'hardware';
    const isSoftZ = interleaveMode === 'soft-z';
    const depthTest = interleaveMode !== 'none';

    this.splatMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: depthTest,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uClipZ: { value: 10000.0 },
        uSplatScale: { value: splatScale },
        uFocalLength: { value: options.focalLengthMm ?? 50.0 },
        uAperture: { value: options.apertureFStop ?? 2.8 },
        uFocusDist: { value: options.focusDistMeters ?? 5.0 },
        uDofStrength: { value: options.dofStrength ?? 0.0 },
        viewport: { value: new THREE.Vector2(vw, vh) },
        uExposureEV: { value: options.exposureEV ?? 0.0 },
        uTonemap: { value: 1 }, // 1: ACES filmic
        uAtmosphere: { value: 0 },
        uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
        uSunColor: { value: new THREE.Color(1.0, 0.95, 0.88) },
        uSunIntensity: { value: 1.2 },
        uSunSpecular: { value: 0.3 },
        uSkyAmbient: { value: new THREE.Color(0.35, 0.33, 0.30) },
        uContactAO: { value: options.contactAO ?? 0.7 },
        uViewDependenceSH: { value: options.viewDependenceSH ?? 0.8 },
        // Soft-Z and hardware depth uniforms
        uTileDepthMap: { value: options.tileDepthMap ?? dummyDepth },
        uTileDepthNear: { value: options.tileDepthNear ?? 0.1 },
        uTileDepthFar: { value: options.tileDepthFar ?? 1000.0 },
        uSoftZEpsilon: { value: options.softZEpsilonMeters ?? 0.25 },
        uSoftZEnabled: { value: isSoftZ ? 1.0 : 0.0 },
        uDepthInterleaveMode: { value: isHardware ? 0 : isSoftZ ? 1 : 2 },
        // Split-64 RTC Uniforms
        uCameraHigh: { value: new THREE.Vector3(0, 0, 0) },
        uCameraLow: { value: new THREE.Vector3(0, 0, 0) },
        uEnableRTC: { value: options.enableRTC ? 1.0 : 0.0 },
        // Spatial Cropping Bounding Box Uniforms
        uClipBoxMin: { value: new THREE.Vector3(-1e9, -1e9, -1e9) },
        uClipBoxMax: { value: new THREE.Vector3(1e9, 1e9, 1e9) },
        uClipBoxEnabled: { value: 0.0 }
      },
      vertexShader: `
        ${CameraRelativeRTC.getVertexShaderRTCChunk()}
        ${options.useLogarithmicDepth ? '#include <logdepthbuf_pars_vertex>' : ''}
        ${EWA_SPLAT_GLSL}

        attribute vec3 instanceCenter;
        attribute vec3 instanceScale;
        attribute vec3 instanceColor;
        attribute float instanceOpacity;
        attribute vec4 instanceQuat;

        uniform float uClipZ;
        uniform float uSplatScale;
        uniform float uFocalLength;
        uniform float uAperture;
        uniform float uFocusDist;
        uniform float uDofStrength;
        uniform vec3 uClipBoxMin;
        uniform vec3 uClipBoxMax;
        uniform float uClipBoxEnabled;
        uniform vec2 viewport;

        varying vec2 vUv;
        varying vec2 vSigmaCoord;
        varying vec3 vColor;
        varying float vOpacity;
        varying float vDepth;
        varying vec3 vCenter;
        varying vec3 vNormal;
        varying vec3 vViewPos;
        varying vec2 vEllipseAxes;
        varying float vEllipseAngle;
        varying float vCircleOfConfusion;

        void main() {
          vUv = uv;
          vColor = instanceColor;
          vec3 effectiveCenter = evaluateRtcCenter(instanceCenter);
          vCenter = effectiveCenter;

          vec4 viewCenter = modelViewMatrix * vec4(effectiveCenter, 1.0);
          vDepth = -viewCenter.z;

          if (-effectiveCenter.z > uClipZ) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }

          if (uClipBoxEnabled > 0.5) {
            if (effectiveCenter.x < uClipBoxMin.x || effectiveCenter.x > uClipBoxMax.x ||
                effectiveCenter.y < uClipBoxMin.y || effectiveCenter.y > uClipBoxMax.y ||
                effectiveCenter.z < uClipBoxMin.z || effectiveCenter.z > uClipBoxMax.z) {
              gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
              return;
            }
          }

          // Normal = the splat's local +Z axis (the flattened axis of a surfel), used by the lighting terms.
          vec4 q = instanceQuat;
          vec3 localNorm = vec3(
            2.0 * (q.x * q.z + q.w * q.y),
            2.0 * (q.y * q.z - q.w * q.x),
            1.0 - 2.0 * (q.x * q.x + q.y * q.y)
          );
          if (dot(localNorm, localNorm) < 0.0001) {
            localNorm = vec3(0.0, 0.0, 1.0);
          }
          vNormal = normalize(localNorm);
          vViewPos = viewCenter.xyz;

          // Physical thin-lens depth of field: sensor-plane CoC diameter (36 mm full-frame width) in pixels, added to
          // the projected covariance as a blur variance (the EWA opacity compensation keeps the energy constant).
          float fMeters = uFocalLength * 0.001;
          float dFocus = max(1.0, uFocusDist);
          float N_ap = max(1.4, uAperture);
          float cocSensor = abs((fMeters * fMeters / (N_ap * max(0.001, dFocus - fMeters))) * ((vDepth - dFocus) / max(0.1, vDepth)));
          float cocPx = clamp(cocSensor / 0.036 * viewport.x * uDofStrength, 0.0, 64.0);
          vCircleOfConfusion = cocPx;
          float blurSigmaPx = 0.25 * cocPx;

          // 2D EWA Screen-Space Covariance: Σ' = J W R S Sᵀ Rᵀ Wᵀ Jᵀ + 0.3 px² low-pass, opacity-compensated.
          vec4 clipCenter;
          vec2 axisMajorPx;
          vec2 axisMinorPx;
          float ewaOpacity;
          bool visible = sbEwaProject(
            viewCenter, instanceScale * uSplatScale, instanceQuat, mat3(modelViewMatrix), projectionMatrix, viewport,
            blurSigmaPx * blurSigmaPx, instanceOpacity, clipCenter, axisMajorPx, axisMinorPx, ewaOpacity
          );
          if (!visible) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }
          vEllipseAxes = vec2(length(axisMajorPx), length(axisMinorPx));
          vEllipseAngle = atan(axisMajorPx.y, axisMajorPx.x);

          // Quad corner in [-1, 1]² spans ±3 sigma along the eigenvectors.
          vec2 corner = position.xy * 2.0;
          vSigmaCoord = corner * ${EWA_CUTOFF_SIGMA.toFixed(1)};
          vec2 offsetPx = corner.x * axisMajorPx + corner.y * axisMinorPx;
          gl_Position = clipCenter + vec4(offsetPx * 2.0 / viewport * clipCenter.w, 0.0, 0.0);

          vOpacity = ewaOpacity;
          ${options.useLogarithmicDepth ? '#include <logdepthbuf_vertex>' : ''}
        }
      `,
      fragmentShader: `
        ${options.useLogarithmicDepth ? '#include <logdepthbuf_pars_fragment>' : ''}
        uniform vec2 viewport;
        uniform float uExposureEV;
        uniform int uTonemap;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uSunIntensity;
        uniform float uSunSpecular;
        uniform vec3 uSkyAmbient;
        uniform float uContactAO;
        uniform float uViewDependenceSH;

        // Soft-Z uniforms
        uniform sampler2D uTileDepthMap;
        uniform float uTileDepthNear;
        uniform float uTileDepthFar;
        uniform float uSoftZEpsilon;
        uniform float uSoftZEnabled;

        varying vec2 vUv;
        varying vec2 vSigmaCoord;
        varying vec3 vColor;
        varying float vOpacity;
        varying float vDepth;
        varying vec3 vCenter;
        varying vec3 vNormal;
        varying vec3 vViewPos;

        vec3 ACESFilm(vec3 x) {
          float a = 2.51;
          float b = 0.03;
          float c = 2.43;
          float d = 0.59;
          float e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        void main() {
          // vSigmaCoord is the fragment's offset in standard deviations along the screen-space eigenvectors, so the
          // squared Mahalanobis distance is its squared length.
          float r2 = dot(vSigmaCoord, vSigmaCoord);
          if (r2 > ${(EWA_CUTOFF_SIGMA * EWA_CUTOFF_SIGMA).toFixed(1)}) discard;
          float alpha = min(0.99, vOpacity * exp(-0.5 * r2));
          if (alpha < 1.0 / 255.0) discard;

          // Continuous Volumetric Soft-Z Depth Interleaving against Tile Mesh
          if (uSoftZEnabled > 0.5) {
            vec2 screenUv = gl_FragCoord.xy / max(vec2(1.0), viewport);
            float tileDepthSample = texture2D(uTileDepthMap, screenUv).r;
            float zTile = (uTileDepthNear * uTileDepthFar) / 
              (uTileDepthFar - tileDepthSample * (uTileDepthFar - uTileDepthNear));
            
            float zSplat = vDepth;
            float deltaZ = zTile - zSplat;
            float eps = max(0.005, uSoftZEpsilon);
            float kappa = clamp((deltaZ + eps) / (2.0 * eps), 0.0, 1.0);
            alpha *= kappa;
            if (alpha < 0.005) discard;
          }

          vec3 color = vColor;

          // PBR Lighting & Degree 1 Spherical Harmonics
          vec3 N = normalize(vNormal);
          vec3 L = normalize(uSunDir);
          vec3 V = normalize(-vViewPos);
          vec3 H = normalize(L + V);

          if (uViewDependenceSH > 0.01) {
            vec3 R = reflect(-V, N);
            float shY = 0.4886025 * R.y;
            float shZ = 0.4886025 * R.z;
            float shX = 0.4886025 * R.x;
            vec3 radianceSheen = vec3(
              0.12 * shX + 0.18 * max(0.0, shY),
              0.14 * shZ + 0.22 * max(0.0, shY),
              0.20 * shX + 0.28 * max(0.0, shY)
            );
            float fresnel = pow(1.0 - max(0.0, dot(N, V)), 4.0);
            color += radianceSheen * fresnel * uViewDependenceSH;
          }

          if (uContactAO > 0.01) {
            float creviceWeight = clamp(0.68 + 0.32 * N.y, 0.45, 1.0);
            color *= mix(1.0, creviceWeight, uContactAO * 0.45);
          }

          float NdotL = max(0.0, dot(N, L));
          float NdotH = max(0.0, dot(N, H));

          vec3 diffuse = uSunColor * NdotL * uSunIntensity;
          float specPower = pow(NdotH, 32.0);
          vec3 specular = uSunColor * specPower * uSunSpecular;

          vec3 litColor = color * (uSkyAmbient + diffuse) + specular;
          litColor *= pow(2.0, uExposureEV);

          if (uTonemap == 1) {
            color = ACESFilm(litColor);
          } else {
            color = clamp(litColor, 0.0, 1.0);
          }

          gl_FragColor = vec4(color, alpha);
          ${options.useLogarithmicDepth ? '#include <logdepthbuf_fragment>' : ''}
        }
      `
    });

    this.splatMesh = new THREE.Mesh(this.splatGeometry, this.splatMaterial);
    this.splatMesh.frustumCulled = false;
    // The EWA projection works in pixels, so keep the viewport uniform equal to the drawing buffer being rendered.
    const drawingBuffer = new THREE.Vector2();
    this.splatMesh.onBeforeRender = (renderer: THREE.WebGLRenderer) => {
      const target = renderer.getRenderTarget();
      if (target) drawingBuffer.set(target.width, target.height);
      else renderer.getDrawingBufferSize(drawingBuffer);
      if (drawingBuffer.x > 0 && drawingBuffer.y > 0) this.splatMaterial.uniforms.viewport.value.copy(drawingBuffer);
    };
    this.add(this.splatMesh);

    // 3. Soft Contact Ground Shadow (disabled by default to honor zero artificial ground plane invariant)
    if (options.contactShadow === true) {
      this.buildContactShadow(splatData, options);
    }

    // 4. Initialize Sort Buffers
    if (this.enableDepthSort) {
      this.sortIndices = new Uint32Array(this.splatCount);
      this.sortDistances = new Float32Array(this.splatCount);
      for (let i = 0; i < this.splatCount; i++) {
        this.sortIndices[i] = i;
      }
    }
  }

  /**
   * Builds an elliptical directional contact shadow under the splat object.
   */
  private buildContactShadow(splatData: SplatData, options: PhotorealSplatOptions = {}): void {
    const bounds = splatData.bounds;
    const width = bounds ? Math.max(0.5, bounds.max[0] - bounds.min[0]) : 1.0;
    const depth = bounds ? Math.max(0.5, bounds.max[2] - bounds.min[2]) : 1.0;
    const height = bounds ? Math.max(1.0, bounds.max[1] - bounds.min[1]) : 1.8;
    const groundY = bounds ? bounds.min[1] + 0.01 : 0.01;

    const shadowGeo = new THREE.PlaneGeometry(width * 2.5, depth * 2.5 + height * 2.5);
    shadowGeo.rotateX(-Math.PI * 0.5);

    const shadowMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uShadowColor: { value: new THREE.Color(0.02, 0.02, 0.04) },
        uShadowOpacity: { value: 0.72 },
        uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uShadowColor;
        uniform float uShadowOpacity;
        uniform vec3 uSunDir;
        varying vec2 vUv;
        void main() {
          vec2 centered = (vUv - vec2(0.5)) * 2.0;

          // 1. Tight contact ambient occlusion under contact points
          float contactR2 = dot(centered * vec2(1.8, 2.2), centered * vec2(1.8, 2.2));
          float contactAO = exp(-5.0 * contactR2) * 0.75;

          // 2. Elongated directional silhouette shadow matching sun direction
          vec2 sunDir2D = normalize(vec2(uSunDir.x, -uSunDir.z) + vec2(0.0001));
          float sunElevation = max(0.18, uSunDir.y);
          float shadowLen = clamp(1.0 / sunElevation, 0.6, 3.5);

          vec2 projCoord = centered - sunDir2D * (shadowLen * 0.35);
          projCoord.x *= 1.8;
          projCoord.y /= max(0.5, shadowLen);
          float projR2 = dot(projCoord, projCoord);
          float directionalShadow = exp(-2.2 * projR2) * 0.6;

          float totalShadow = clamp(contactAO + directionalShadow, 0.0, 1.0);
          if (totalShadow < 0.01) discard;
          gl_FragColor = vec4(uShadowColor, totalShadow * uShadowOpacity);
        }
      `
    });

    const shadowMesh = new THREE.Mesh(shadowGeo, shadowMat);
    shadowMesh.position.set(0, groundY, 0);
    shadowMesh.renderOrder = -1;
    this.add(shadowMesh);
    this.contactShadowMesh = shadowMesh;
  }

  /**
   * Sorts Gaussian splats along the camera viewing ray for mathematically correct alpha blending.
   * Utilizes high-performance O(N) radix sorting, with Web Worker async dispatch when enabled.
   */
  public updateDepthSort(camera: THREE.Camera, force = false): void {
    if (!this.enableDepthSort) return;

    this.frameCounter++;
    if (!force && this.frameCounter % this.sortFrequencyFrames !== 0) return;

    // Splat positions are in this object's local frame: sort against the camera expressed in that frame.
    this.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    const toLocal = new THREE.Matrix4().copy(this.matrixWorld).invert();
    const camPos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld).applyMatrix4(toLocal);
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);
    camDir.transformDirection(toLocal);

    // Skip sort if camera hasn't moved significantly
    if (!force) {
      const posDelta = camPos.distanceTo(this.lastSortedCamPos);
      const dirDelta = camDir.distanceTo(this.lastSortedCamDir);
      if (posDelta < 0.05 && dirDelta < 0.02) return;
    }

    this.lastSortedCamPos.copy(camPos);
    this.lastSortedCamDir.copy(camDir);

    this.radixSorter.sort(
      this.splatData.positions,
      camPos,
      camDir,
      this.splatCount,
      (sortedIndices) => this.applySortedIndices(sortedIndices)
    );
  }

  /**
   * Applies reordered index array to GPU instance buffer attributes.
   */
  public applySortedIndices(indices: Uint32Array): void {
    const centerAttr = this.splatGeometry.getAttribute('instanceCenter') as THREE.InstancedBufferAttribute;
    const scaleAttr = this.splatGeometry.getAttribute('instanceScale') as THREE.InstancedBufferAttribute;
    const colorAttr = this.splatGeometry.getAttribute('instanceColor') as THREE.InstancedBufferAttribute;
    const opacAttr = this.splatGeometry.getAttribute('instanceOpacity') as THREE.InstancedBufferAttribute;
    const quatAttr = this.splatGeometry.getAttribute('instanceQuat') as THREE.InstancedBufferAttribute;
    const centerHighAttr = this.splatGeometry.getAttribute('instanceCenterHigh') as THREE.InstancedBufferAttribute | undefined;
    const centerLowAttr = this.splatGeometry.getAttribute('instanceCenterLow') as THREE.InstancedBufferAttribute | undefined;

    const cArr = centerAttr.array as Float32Array;
    const sArr = scaleAttr.array as Float32Array;
    const colArr = colorAttr.array as Float32Array;
    const oArr = opacAttr.array as Float32Array;
    const qArr = quatAttr.array as Float32Array;

    const srcPos = this.splatData.positions;
    const srcScale = this.splatData.scales;
    const srcCol = this.splatData.colors;
    const srcOpac = this.splatData.opacities;
    const srcQuat = this.splatData.quats;
    const count = this.splatCount;

    for (let i = 0; i < count; i++) {
      const origIdx = indices[i];

      cArr[i * 3 + 0] = srcPos[origIdx * 3 + 0];
      cArr[i * 3 + 1] = srcPos[origIdx * 3 + 1];
      cArr[i * 3 + 2] = srcPos[origIdx * 3 + 2];

      sArr[i * 3 + 0] = srcScale[origIdx * 3 + 0];
      sArr[i * 3 + 1] = srcScale[origIdx * 3 + 1];
      sArr[i * 3 + 2] = srcScale[origIdx * 3 + 2];

      colArr[i * 3 + 0] = srcCol[origIdx * 3 + 0];
      colArr[i * 3 + 1] = srcCol[origIdx * 3 + 1];
      colArr[i * 3 + 2] = srcCol[origIdx * 3 + 2];

      oArr[i] = srcOpac[origIdx];

      qArr[i * 4 + 0] = srcQuat[origIdx * 4 + 0];
      qArr[i * 4 + 1] = srcQuat[origIdx * 4 + 1];
      qArr[i * 4 + 2] = srcQuat[origIdx * 4 + 2];
      qArr[i * 4 + 3] = srcQuat[origIdx * 4 + 3];
    }

    if (centerHighAttr && centerLowAttr && this.splatData.positionsHigh && this.splatData.positionsLow) {
      const chArr = centerHighAttr.array as Float32Array;
      const clArr = centerLowAttr.array as Float32Array;
      const srcHigh = this.splatData.positionsHigh;
      const srcLow = this.splatData.positionsLow;

      for (let i = 0; i < count; i++) {
        const origIdx = indices[i];
        chArr[i * 3 + 0] = srcHigh[origIdx * 3 + 0];
        chArr[i * 3 + 1] = srcHigh[origIdx * 3 + 1];
        chArr[i * 3 + 2] = srcHigh[origIdx * 3 + 2];

        clArr[i * 3 + 0] = srcLow[origIdx * 3 + 0];
        clArr[i * 3 + 1] = srcLow[origIdx * 3 + 1];
        clArr[i * 3 + 2] = srcLow[origIdx * 3 + 2];
      }
      centerHighAttr.needsUpdate = true;
      centerLowAttr.needsUpdate = true;
    }

    centerAttr.needsUpdate = true;
    scaleAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    opacAttr.needsUpdate = true;
    quatAttr.needsUpdate = true;
  }

  /**
   * Configures camera position for Split-64 Relative-to-Center emulation.
   */
  public setCameraRtc(cameraEcef: [number, number, number] | Float64Array | THREE.Vector3): void {
    const cx = 'x' in cameraEcef ? cameraEcef.x : cameraEcef[0];
    const cy = 'y' in cameraEcef ? cameraEcef.y : cameraEcef[1];
    const cz = 'z' in cameraEcef ? cameraEcef.z : cameraEcef[2];
    const split = CameraRelativeRTC.splitCameraPosition(cx, cy, cz);
    const u = this.splatMaterial.uniforms;
    u.uCameraHigh.value.set(split.high[0], split.high[1], split.high[2]);
    u.uCameraLow.value.set(split.low[0], split.low[1], split.low[2]);
    u.uEnableRTC.value = 1.0;
  }

  /**
   * Switches depth interleaving mode between 'hardware', 'soft-z', and 'none'.
   */
  public setDepthInterleaveMode(mode: 'hardware' | 'soft-z' | 'none'): void {
    this.splatMaterial.depthTest = mode !== 'none';
    this.splatMaterial.depthWrite = false;
    const isSoftZ = mode === 'soft-z';
    this.splatMaterial.uniforms.uSoftZEnabled.value = isSoftZ ? 1.0 : 0.0;
    this.splatMaterial.uniforms.uDepthInterleaveMode.value = mode === 'hardware' ? 0 : mode === 'soft-z' ? 1 : 2;
  }

  /**
   * Sets real-time GPU bounding box clipping limits.
   */
  public setClipBox(box: THREE.Box3 | null): void {
    if (!box) {
      this.splatMaterial.uniforms.uClipBoxEnabled.value = 0.0;
    } else {
      this.splatMaterial.uniforms.uClipBoxEnabled.value = 1.0;
      this.splatMaterial.uniforms.uClipBoxMin.value.copy(box.min);
      this.splatMaterial.uniforms.uClipBoxMax.value.copy(box.max);
    }
  }

  /**
   * Sets continuous Soft-Z depth interleaving parameters against the Google 3D Tile G-buffer.
   */
  public setSoftZUniforms(params: {
    depthMap?: THREE.Texture | null;
    near?: number;
    far?: number;
    epsilon?: number;
    enabled?: boolean;
    viewport?: THREE.Vector2;
  }): void {
    const u = this.splatMaterial.uniforms;
    if (params.depthMap !== undefined && params.depthMap !== null) u.uTileDepthMap.value = params.depthMap;
    if (params.near !== undefined) u.uTileDepthNear.value = params.near;
    if (params.far !== undefined) u.uTileDepthFar.value = params.far;
    if (params.epsilon !== undefined) u.uSoftZEpsilon.value = params.epsilon;
    if (params.enabled !== undefined) u.uSoftZEnabled.value = params.enabled ? 1.0 : 0.0;
    if (params.viewport !== undefined) u.viewport.value.copy(params.viewport);
  }

  /**
   * Synchronizes solar and radiometric illumination from RadiometricSolarHarmonizer.
   */
  public setLightingUniforms(params: {
    sunDir?: THREE.Vector3;
    sunColor?: THREE.Color;
    sunIntensity?: number;
    skyAmbient?: THREE.Color;
    exposureEV?: number;
  }): void {
    const u = this.splatMaterial.uniforms;
    if (params.sunDir) {
      u.uSunDir.value.copy(params.sunDir).normalize();
      if (this.contactShadowMesh) {
        (this.contactShadowMesh.material as THREE.ShaderMaterial).uniforms.uSunDir.value.copy(params.sunDir).normalize();
      }
    }
    if (params.sunColor) u.uSunColor.value.copy(params.sunColor);
    if (params.sunIntensity !== undefined) u.uSunIntensity.value = params.sunIntensity;
    if (params.skyAmbient) u.uSkyAmbient.value.copy(params.skyAmbient);
    if (params.exposureEV !== undefined) u.uExposureEV.value = params.exposureEV;
  }

  /**
   * Tunes physical thin-lens optical bokeh depth of field.
   */
  public setCameraOptics(focalLengthMm?: number, apertureFStop?: number, focusDistMeters?: number, dofStrength?: number): void {
    const u = this.splatMaterial.uniforms;
    if (focalLengthMm !== undefined) u.uFocalLength.value = focalLengthMm;
    if (apertureFStop !== undefined) u.uAperture.value = apertureFStop;
    if (focusDistMeters !== undefined) u.uFocusDist.value = focusDistMeters;
    if (dofStrength !== undefined) u.uDofStrength.value = dofStrength;
  }

  /**
   * Parses standard 32-byte .splat binary array buffer into SplatData.
   */
  public static parseSplatBuffer(buffer: ArrayBuffer | Uint8Array): SplatData {
    const arrayBuffer = buffer instanceof Uint8Array ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer;
    const BYTES_PER_SPLAT = 32;
    const count = Math.floor(arrayBuffer.byteLength / BYTES_PER_SPLAT);

    const positions = new Float32Array(count * 3);
    const scales = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const opacities = new Float32Array(count);
    const quats = new Float32Array(count * 4);

    const view = new DataView(arrayBuffer);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let sumX = 0, sumY = 0, sumZ = 0;

    for (let i = 0; i < count; i++) {
      const off = i * BYTES_PER_SPLAT;

      const px = view.getFloat32(off + 0, true);
      const py = view.getFloat32(off + 4, true);
      const pz = view.getFloat32(off + 8, true);

      positions[i * 3 + 0] = px;
      positions[i * 3 + 1] = py;
      positions[i * 3 + 2] = pz;

      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      sumX += px; sumY += py; sumZ += pz;

      scales[i * 3 + 0] = view.getFloat32(off + 12, true);
      scales[i * 3 + 1] = view.getFloat32(off + 16, true);
      scales[i * 3 + 2] = view.getFloat32(off + 20, true);

      colors[i * 3 + 0] = view.getUint8(off + 24) / 255.0;
      colors[i * 3 + 1] = view.getUint8(off + 25) / 255.0;
      colors[i * 3 + 2] = view.getUint8(off + 26) / 255.0;
      opacities[i] = view.getUint8(off + 27) / 255.0;

      quats[i * 4 + 0] = (view.getUint8(off + 28) - 128) / 127.0;
      quats[i * 4 + 1] = (view.getUint8(off + 29) - 128) / 127.0;
      quats[i * 4 + 2] = (view.getUint8(off + 30) - 128) / 127.0;
      quats[i * 4 + 3] = (view.getUint8(off + 31) - 128) / 127.0;
    }

    return {
      count,
      positions,
      scales,
      colors,
      opacities,
      quats,
      bounds: count > 0 ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : undefined,
      centroid: count > 0 ? [sumX / count, sumY / count, sumZ / count] : undefined
    };
  }

  /**
   * Parses .spz (Scaniverse / Niantic compressed format) buffer into SplatData.
   */
  public static async parseSpzBuffer(buffer: ArrayBuffer | Uint8Array): Promise<SplatData> {
    let raw = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

    // If gzip compressed, decompress
    if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(raw as any);
        writer.close();
        const response = new Response(ds.readable);
        const decompressed = await response.arrayBuffer();
        raw = new Uint8Array(decompressed);
      }
    }

    if (isGzip(raw)) throw new Error('SPZ payload is gzip-compressed and DecompressionStream is unavailable');
    const d = decodeSpz(raw);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let sumX = 0, sumY = 0, sumZ = 0;
    for (let i = 0; i < d.count; i++) {
      const px = d.positions[i * 3], py = d.positions[i * 3 + 1], pz = d.positions[i * 3 + 2];
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      sumX += px; sumY += py; sumZ += pz;
    }
    const count = d.count;
    return {
      count,
      positions: d.positions,
      scales: d.scales,
      colors: d.colors,
      opacities: d.opacities,
      quats: d.quats,
      bounds: count > 0 ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : undefined,
      centroid: count > 0 ? [sumX / count, sumY / count, sumZ / count] : undefined
    };
  }

  /**
   * Asynchronously loads a .splat or .spz dataset from URL.
   */
  public static async fromUrl(url: string, options: PhotorealSplatOptions = {}): Promise<PhotorealGaussianSplatMesh> {
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(`Failed to fetch 3D Gaussian Splat asset from ${url}: HTTP ${resp.status}`);
    }
    const buffer = await resp.arrayBuffer();

    let splatData: SplatData;
    if (url.endsWith('.spz')) {
      splatData = await PhotorealGaussianSplatMesh.parseSpzBuffer(buffer);
    } else {
      splatData = PhotorealGaussianSplatMesh.parseSplatBuffer(buffer);
    }

    return new PhotorealGaussianSplatMesh(splatData, options);
  }

  public override dispose(): void {
    this.radixSorter.dispose();
    this.splatGeometry.dispose();
    this.splatMaterial.dispose();
    if (this.contactShadowMesh) {
      this.contactShadowMesh.geometry.dispose();
      (this.contactShadowMesh.material as THREE.Material).dispose();
    }
  }
}
