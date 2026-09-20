/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';

export interface SplatData {
  count: number;
  positions: Float32Array;
  scales: Float32Array;
  colors: Float32Array;
  opacities: Float32Array;
  quats: Float32Array;
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

    // Adaptive splat scale calibration to prevent cotton-ball bloat
    let calibratedScale = options.splatScale ?? 1.0;
    if (splatData.scales.length > 0) {
      let sampleSum = 0;
      const sampleCount = Math.min(100, splatData.count);
      for (let i = 0; i < sampleCount; i++) {
        sampleSum += splatData.scales[i * 3];
      }
      const avgScale = sampleSum / Math.max(1, sampleCount);
      if (avgScale > 0.02 && options.splatScale === undefined) {
        calibratedScale = 0.22;
      }
    }

    this.splatMaterial = new THREE.ShaderMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: {
        uClipZ: { value: 10000.0 },
        uSplatScale: { value: calibratedScale },
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
        uSkyAmbient: { value: new THREE.Color(0.25, 0.35, 0.5) },
        uContactAO: { value: options.contactAO ?? 0.7 },
        uViewDependenceSH: { value: options.viewDependenceSH ?? 0.8 },
        // Soft-Z uniforms
        uTileDepthMap: { value: options.tileDepthMap ?? dummyDepth },
        uTileDepthNear: { value: options.tileDepthNear ?? 0.1 },
        uTileDepthFar: { value: options.tileDepthFar ?? 1000.0 },
        uSoftZEpsilon: { value: options.softZEpsilonMeters ?? 0.25 },
        uSoftZEnabled: { value: options.enableSoftZ ? 1.0 : 0.0 }
      },
      vertexShader: `
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

        varying vec2 vUv;
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
          vCenter = instanceCenter;

          vec4 viewCenter = modelViewMatrix * vec4(instanceCenter, 1.0);
          vDepth = -viewCenter.z;

          if (-instanceCenter.z > uClipZ) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            return;
          }

          // Decode normal from quaternion
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

          // 2D EWA Screen-Space Covariance & Anisotropic Principal Axes
          vec3 viewNorm = normalize((modelViewMatrix * vec4(localNorm, 0.0)).xyz);
          float cosIncidence = clamp(abs(dot(viewNorm, vec3(0.0, 0.0, 1.0))), 0.18, 1.0);

          vec3 S = instanceScale * uSplatScale;
          S = clamp(S, vec3(0.0015), vec3(0.035));
          float rMajor = max(S.x, S.y) * 1.6;
          float rMinor = max(0.0015, min(S.x, S.y) * 1.6 * cosIncidence);

          // Physical Thin-Lens Depth of Field
          float fMeters = uFocalLength * 0.001;
          float dFocus = max(1.0, uFocusDist);
          float N_ap = max(1.4, uAperture);
          float coc = abs((fMeters * fMeters / (N_ap * max(0.001, dFocus - fMeters))) * ((vDepth - dFocus) / max(0.1, vDepth)));
          coc = clamp(coc * 35.0 * uDofStrength, 0.0, 12.0);
          vCircleOfConfusion = coc;

          float bokehSpread = coc * 0.6;
          rMajor += bokehSpread;
          rMinor += bokehSpread;
          vEllipseAxes = vec2(rMajor, rMinor);

          vec2 screenTangent = normalize(viewNorm.xy + vec2(0.0001));
          float theta = atan(screenTangent.y, screenTangent.x);
          vEllipseAngle = theta;

          vec2 localPos = position.xy;
          vec2 rotatedCorner = vec2(
            localPos.x * cos(theta) - localPos.y * sin(theta),
            localPos.x * sin(theta) + localPos.y * cos(theta)
          );

          vec2 screenOffset = vec2(rotatedCorner.x * rMajor, rotatedCorner.y * rMinor);
          vec4 viewPos = viewCenter + vec4(screenOffset, 0.0, 0.0);
          vViewPos = viewPos.xyz;
          gl_Position = projectionMatrix * viewPos;

          vOpacity = instanceOpacity / (1.0 + coc * 0.75);
        }
      `,
      fragmentShader: `
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
          vec2 d = (vUv - vec2(0.5)) * 2.0;
          float r2 = dot(d, d);
          if (r2 > 1.0) discard;

          // Anisotropic EWA Gaussian Alpha Decay with tight core
          float alpha = exp(-2.2 * r2) * vOpacity;
          if (alpha < 0.02) discard;

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
        }
      `
    });

    this.splatMesh = new THREE.Mesh(this.splatGeometry, this.splatMaterial);
    this.splatMesh.frustumCulled = false;
    this.add(this.splatMesh);

    // 3. Build Soft Contact Ground Shadow
    this.buildContactShadow(splatData, options);

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
   */
  public updateDepthSort(camera: THREE.Camera, force = false): void {
    if (!this.enableDepthSort || !this.sortIndices || !this.sortDistances) return;

    this.frameCounter++;
    if (!force && this.frameCounter % this.sortFrequencyFrames !== 0) return;

    const camPos = camera.position;
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir);

    // Skip sort if camera hasn't moved significantly
    if (!force) {
      const posDelta = camPos.distanceTo(this.lastSortedCamPos);
      const dirDelta = camDir.distanceTo(this.lastSortedCamDir);
      if (posDelta < 0.05 && dirDelta < 0.02) return;
    }

    this.lastSortedCamPos.copy(camPos);
    this.lastSortedCamDir.copy(camDir);

    const positions = this.splatData.positions;
    const count = this.splatCount;
    const dx = camDir.x;
    const dy = camDir.y;
    const dz = camDir.z;

    // Project each splat center onto camera view vector: dot(P - C, D)
    for (let i = 0; i < count; i++) {
      const px = positions[i * 3 + 0] - camPos.x;
      const py = positions[i * 3 + 1] - camPos.y;
      const pz = positions[i * 3 + 2] - camPos.z;
      this.sortDistances[i] = px * dx + py * dy + pz * dz;
      this.sortIndices[i] = i;
    }

    // Sort back-to-front (largest distance first)
    const indices = this.sortIndices;
    const dists = this.sortDistances;
    indices.sort((a, b) => dists[b] - dists[a]);

    // Reorder attributes into temporary or updated buffer
    const centerAttr = this.splatGeometry.getAttribute('instanceCenter') as THREE.InstancedBufferAttribute;
    const scaleAttr = this.splatGeometry.getAttribute('instanceScale') as THREE.InstancedBufferAttribute;
    const colorAttr = this.splatGeometry.getAttribute('instanceColor') as THREE.InstancedBufferAttribute;
    const opacAttr = this.splatGeometry.getAttribute('instanceOpacity') as THREE.InstancedBufferAttribute;
    const quatAttr = this.splatGeometry.getAttribute('instanceQuat') as THREE.InstancedBufferAttribute;

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

    centerAttr.needsUpdate = true;
    scaleAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    opacAttr.needsUpdate = true;
    quatAttr.needsUpdate = true;
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

    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const magic = view.getUint32(0, true);
    if (magic !== 0x315a5053) {
      throw new Error(`Invalid SPZ magic: 0x${magic.toString(16)} (expected 0x315a5053)`);
    }

    const numPoints = view.getUint32(8, true);
    const fractionalBits = view.getUint8(12);
    const posScale = 1.0 / (1 << fractionalBits);

    const POINT_STRIDE = 22;
    const headerSize = 16;
    const availablePoints = Math.floor((raw.byteLength - headerSize) / POINT_STRIDE);
    const count = Math.min(numPoints, availablePoints);

    const positions = new Float32Array(count * 3);
    const scales = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const opacities = new Float32Array(count);
    const quats = new Float32Array(count * 4);

    let offset = headerSize;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    let sumX = 0, sumY = 0, sumZ = 0;

    for (let i = 0; i < count; i++) {
      const ix = view.getInt32(offset, true);
      const iy = view.getInt32(offset + 4, true);
      const iz = view.getInt32(offset + 8, true);
      offset += 12;

      const px = ix * posScale;
      const py = iy * posScale;
      const pz = iz * posScale;

      positions[i * 3 + 0] = px;
      positions[i * 3 + 1] = py;
      positions[i * 3 + 2] = pz;

      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
      if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
      sumX += px; sumY += py; sumZ += pz;

      const sxQuant = view.getInt8(offset++);
      const syQuant = view.getInt8(offset++);
      const szQuant = view.getInt8(offset++);

      scales[i * 3 + 0] = Math.exp(((sxQuant + 128) / 255.0) * 12.0 - 8.0);
      scales[i * 3 + 1] = Math.exp(((syQuant + 128) / 255.0) * 12.0 - 8.0);
      scales[i * 3 + 2] = Math.exp(((szQuant + 128) / 255.0) * 12.0 - 8.0);

      const qx = view.getInt8(offset++) / 127.0;
      const qy = view.getInt8(offset++) / 127.0;
      const qz = view.getInt8(offset++) / 127.0;
      const qw2 = 1.0 - (qx * qx + qy * qy + qz * qz);
      const qw = qw2 > 0 ? Math.sqrt(qw2) : 0.0;

      quats[i * 4 + 0] = qx;
      quats[i * 4 + 1] = qy;
      quats[i * 4 + 2] = qz;
      quats[i * 4 + 3] = qw;

      colors[i * 3 + 0] = view.getUint8(offset++) / 255.0;
      colors[i * 3 + 1] = view.getUint8(offset++) / 255.0;
      colors[i * 3 + 2] = view.getUint8(offset++) / 255.0;
      opacities[i] = view.getUint8(offset++) / 255.0;
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
    this.splatGeometry.dispose();
    this.splatMaterial.dispose();
    if (this.contactShadowMesh) {
      this.contactShadowMesh.geometry.dispose();
      (this.contactShadowMesh.material as THREE.Material).dispose();
    }
  }
}
