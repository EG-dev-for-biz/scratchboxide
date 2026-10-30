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

import { SplatEditIndex, applySplatStroke, replaySplatEdits, type SplatEditStroke } from '../../../../common/spatial/splat-edits';
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
 *
 * Per-splat data (positions, scales, colors, quats) is stored in GPU DataTextures
 * indexed by a single sortOrder instance attribute. Depth-sorting therefore only
 * uploads one 4-byte-per-splat index buffer per sort event instead of rewriting
 * all five attribute arrays — roughly 14× less GPU bandwidth per sort.
 */
export class PhotorealGaussianSplatMesh extends THREE.Group {
/** The largest footprint a splat is picked by, metres (pickEditPoint). */
const PICK_MAX_FOOTPRINT_M = 0.6;

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

  // GPU DataTextures — per-splat data lives here, not in instance attributes
  private _posTex!: THREE.DataTexture;
  private _scaleTex!: THREE.DataTexture;
  private _colorOpacityTex!: THREE.DataTexture;
  private _quatTex!: THREE.DataTexture;
  private _posHighTex!: THREE.DataTexture;
  private _posLowTex!: THREE.DataTexture;
  private _texWidth = 1;

  /** The colour and opacity bytes as built (splat-edits.ts replays strokes over them); made on the first edit. */
  private _baseColorOpacity: Uint8Array | null = null;
  private _editIndex: SplatEditIndex | null = null;
  /** The bytes as drawn when the stroke being painted began (previewEditStroke redraws the whole stroke over them). */
  private _previewStart: Uint8Array | null = null;
  private static readonly _dummyRgbaF32 = (() => {
    const t = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  })();

  constructor(splatData: SplatData, options: PhotorealSplatOptions = {}) {
    super();
    this.name = 'PhotorealGaussianSplatMesh';
    this.splatData = splatData;
    this.splatCount = splatData.count;

    this.enableDepthSort = options.enableDepthSort ?? true;
    this.sortFrequencyFrames = options.sortFrequencyFrames ?? 4;
    this.radixSorter = new SplatRadixSorter(options.enableAsyncWorkerSort ?? true);

    // 1. Build per-splat DataTextures (replaces five scatter-rewritten instance attributes)
    const { w: texW } = this._buildSplatTextures(splatData, options);
    this._texWidth = texW;

    // 2. Build Instanced Quad Geometry with a single sortOrder attribute
    const quadGeo = new THREE.PlaneGeometry(1, 1);
    const instancedGeo = new THREE.InstancedBufferGeometry();
    instancedGeo.index = quadGeo.index;
    instancedGeo.attributes.position = quadGeo.attributes.position;
    instancedGeo.attributes.uv = quadGeo.attributes.uv;

    // sortOrder[i] = original splat index for draw slot i.
    // Sorting rewrites only this array (4 bytes × count) instead of all five attribute
    // arrays (56 bytes × count), reducing per-sort GPU upload by ~14×.
    // Float32 holds every integer index exactly up to 2^24.
    if (splatData.count > 1 << 24) throw new Error(`PhotorealGaussianSplatMesh supports at most ${1 << 24} splats (got ${splatData.count})`);
    const sortOrderArray = new Float32Array(splatData.count);
    for (let i = 0; i < splatData.count; i++) sortOrderArray[i] = i;
    instancedGeo.setAttribute('sortOrder', new THREE.InstancedBufferAttribute(sortOrderArray, 1));

    this.splatGeometry = instancedGeo;

    // 3. Build Production Shader Material
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
        // Splat data textures
        uPosTex:          { value: this._posTex },
        uScaleTex:        { value: this._scaleTex },
        uColorOpacityTex: { value: this._colorOpacityTex },
        uQuatTex:         { value: this._quatTex },
        uPosHighTex:      { value: this._posHighTex },
        uPosLowTex:       { value: this._posLowTex },
        uTexWidth:        { value: texW },
        // Render parameters
        uClipZ:       { value: 10000.0 },
        uSplatScale:  { value: splatScale },
        uFocalLength: { value: options.focalLengthMm ?? 50.0 },
        uAperture:    { value: options.apertureFStop ?? 2.8 },
        uFocusDist:   { value: options.focusDistMeters ?? 5.0 },
        uDofStrength: { value: options.dofStrength ?? 0.0 },
        viewport:     { value: new THREE.Vector2(vw, vh) },
        uExposureEV:  { value: options.exposureEV ?? 0.0 },
        uTonemap:     { value: 1 }, // 1: ACES filmic
        uAtmosphere:  { value: 0 },
        uSunDir:      { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
        uSunColor:    { value: new THREE.Color(1.0, 0.95, 0.88) },
        uSunIntensity:   { value: 1.2 },
        uSunSpecular:    { value: 0.3 },
        uSkyAmbient:     { value: new THREE.Color(0.35, 0.33, 0.30) },
        uContactAO:      { value: options.contactAO ?? 0.7 },
        uViewDependenceSH: { value: options.viewDependenceSH ?? 0.8 },
        // Soft-Z and hardware depth uniforms
        uTileDepthMap:  { value: options.tileDepthMap ?? dummyDepth },
        uTileDepthNear: { value: options.tileDepthNear ?? 0.1 },
        uTileDepthFar:  { value: options.tileDepthFar ?? 1000.0 },
        uSoftZEpsilon:  { value: options.softZEpsilonMeters ?? 0.25 },
        uSoftZEnabled:  { value: isSoftZ ? 1.0 : 0.0 },
        uDepthInterleaveMode: { value: isHardware ? 0 : isSoftZ ? 1 : 2 },
        // Split-64 RTC Uniforms
        uCameraHigh: { value: new THREE.Vector3(0, 0, 0) },
        uCameraLow:  { value: new THREE.Vector3(0, 0, 0) },
        uEnableRTC:  { value: options.enableRTC ? 1.0 : 0.0 },
        // Spatial Cropping Bounding Box Uniforms
        uClipBoxMin:     { value: new THREE.Vector3(-1e9, -1e9, -1e9) },
        uClipBoxMax:     { value: new THREE.Vector3(1e9, 1e9, 1e9) },
        uClipBoxEnabled: { value: 0.0 }
      },
      vertexShader: `
        ${options.useLogarithmicDepth ? '#include <logdepthbuf_pars_vertex>' : ''}
        ${EWA_SPLAT_GLSL}

        // Per-splat data textures — indexed by sortOrder, never rewritten during sorting
        uniform sampler2D uPosTex;
        uniform sampler2D uScaleTex;
        uniform sampler2D uColorOpacityTex;
        uniform sampler2D uQuatTex;
        uniform sampler2D uPosHighTex;
        uniform sampler2D uPosLowTex;
        uniform int uTexWidth;

        // The only per-instance attribute: the original splat index for this draw slot.
        // Depth sorting rewrites only this array (4 bytes/splat vs ~56 bytes/splat before).
        attribute float sortOrder;

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

        // RTC uniforms
        uniform vec3 uCameraHigh;
        uniform vec3 uCameraLow;
        uniform float uEnableRTC;

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

          // Resolve the original splat index for this instance and compute texture coords.
          int origIdx = int(sortOrder + 0.5);
          ivec2 tc = ivec2(origIdx % uTexWidth, origIdx / uTexWidth);

          // Fetch per-splat data from textures (one texelFetch per attribute, zero scatter).
          vec3 instanceCenter  = texelFetch(uPosTex,          tc, 0).xyz;
          vec3 instanceScale   = texelFetch(uScaleTex,        tc, 0).xyz;
          vec4 colorOpacity    = texelFetch(uColorOpacityTex, tc, 0);
          vec4 instanceQuat    = texelFetch(uQuatTex,         tc, 0);

          vColor = colorOpacity.rgb;
          float instanceOpacity = colorOpacity.a;

          // RTC: emulated double precision via split float32 high/low textures
          vec3 effectiveCenter;
          if (uEnableRTC > 0.5) {
            vec3 high = texelFetch(uPosHighTex, tc, 0).xyz;
            vec3 low  = texelFetch(uPosLowTex,  tc, 0).xyz;
            effectiveCenter = (high - uCameraHigh) + (low - uCameraLow);
          } else {
            effectiveCenter = instanceCenter;
          }
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

    // 4. Soft Contact Ground Shadow (disabled by default to honor zero artificial ground plane invariant)
    if (options.contactShadow === true) {
      this.buildContactShadow(splatData, options);
    }
  }

  /**
   * Packs all per-splat arrays into GPU DataTextures and returns the texture dimensions.
   * Using textures instead of instance attributes means depth-sorting only needs to
   * upload one sortOrder index buffer per frame, not all five attribute arrays.
   */
  private _buildSplatTextures(splatData: SplatData, options: PhotorealSplatOptions): { w: number; h: number } {
    const { w, h } = PhotorealGaussianSplatMesh._calcTexDims(splatData.count);
    const texelCount = w * h;

    // RGBA32F: positions (xyz) + pad
    const posData = new Float32Array(texelCount * 4);
    for (let i = 0; i < splatData.count; i++) {
      posData[i * 4 + 0] = splatData.positions[i * 3 + 0];
      posData[i * 4 + 1] = splatData.positions[i * 3 + 1];
      posData[i * 4 + 2] = splatData.positions[i * 3 + 2];
      posData[i * 4 + 3] = 1.0;
    }
    this._posTex = PhotorealGaussianSplatMesh._makeF32Tex(posData, w, h);

    // RGBA32F: scales (xyz) + pad
    const scaleData = new Float32Array(texelCount * 4);
    for (let i = 0; i < splatData.count; i++) {
      scaleData[i * 4 + 0] = splatData.scales[i * 3 + 0];
      scaleData[i * 4 + 1] = splatData.scales[i * 3 + 1];
      scaleData[i * 4 + 2] = splatData.scales[i * 3 + 2];
      scaleData[i * 4 + 3] = 0.0;
    }
    this._scaleTex = PhotorealGaussianSplatMesh._makeF32Tex(scaleData, w, h);

    // RGBA8: color (rgb) + opacity (a) — 4 bytes/splat vs 16 for F32, and precision is sufficient
    const colorData = new Uint8Array(texelCount * 4);
    for (let i = 0; i < splatData.count; i++) {
      colorData[i * 4 + 0] = Math.min(255, Math.max(0, Math.round(splatData.colors[i * 3 + 0] * 255)));
      colorData[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(splatData.colors[i * 3 + 1] * 255)));
      colorData[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(splatData.colors[i * 3 + 2] * 255)));
      colorData[i * 4 + 3] = Math.min(255, Math.max(0, Math.round(splatData.opacities[i] * 255)));
    }
    this._colorOpacityTex = new THREE.DataTexture(colorData, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    this._colorOpacityTex.magFilter = THREE.NearestFilter;
    this._colorOpacityTex.minFilter = THREE.NearestFilter;
    this._colorOpacityTex.generateMipmaps = false;
    this._colorOpacityTex.needsUpdate = true;

    // RGBA32F: quaternions (xyzw)
    const quatData = new Float32Array(texelCount * 4);
    for (let i = 0; i < splatData.count; i++) {
      quatData[i * 4 + 0] = splatData.quats[i * 4 + 0];
      quatData[i * 4 + 1] = splatData.quats[i * 4 + 1];
      quatData[i * 4 + 2] = splatData.quats[i * 4 + 2];
      quatData[i * 4 + 3] = splatData.quats[i * 4 + 3];
    }
    this._quatTex = PhotorealGaussianSplatMesh._makeF32Tex(quatData, w, h);

    // RTC high/low textures — built now when enableRTC is requested, else on the first setCameraRtc call.
    this._posHighTex = PhotorealGaussianSplatMesh._dummyRgbaF32;
    this._posLowTex = PhotorealGaussianSplatMesh._dummyRgbaF32;
    if (options.enableRTC) this._buildRtcTextures(w, h);

    return { w, h };
  }

  /** Split-64 high/low position textures for camera-relative rendering (from splatData.positionsHigh/Low when given). */
  private _buildRtcTextures(w: number, h: number): void {
    const splatData = this.splatData;
    let high = splatData.positionsHigh;
    let low = splatData.positionsLow;
    if (!high || !low) {
      const split = CameraRelativeRTC.getSplit64Attributes(splatData.positions);
      high = split.high;
      low = split.low;
    }
    const posHighData = new Float32Array(w * h * 4);
    const posLowData = new Float32Array(w * h * 4);
    for (let i = 0; i < splatData.count; i++) {
      for (let k = 0; k < 3; k++) {
        posHighData[i * 4 + k] = high[i * 3 + k];
        posLowData[i * 4 + k] = low[i * 3 + k];
      }
    }
    this._posHighTex = PhotorealGaussianSplatMesh._makeF32Tex(posHighData, w, h);
    this._posLowTex = PhotorealGaussianSplatMesh._makeF32Tex(posLowData, w, h);
    const u = this.splatMaterial?.uniforms;
    if (u) {
      u.uPosHighTex.value = this._posHighTex;
      u.uPosLowTex.value = this._posLowTex;
    }
  }

  private static _makeF32Tex(data: Float32Array, w: number, h: number): THREE.DataTexture {
    const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  }

  private static _calcTexDims(count: number): { w: number; h: number } {
    const sqrtN = Math.ceil(Math.sqrt(Math.max(1, count)));
    // Round width up to next power of 2 for broad driver compatibility with texelFetch
    const w = Math.pow(2, Math.ceil(Math.log2(sqrtN)));
    const h = Math.ceil(count / w);
    return { w, h };
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
        uShadowColor:   { value: new THREE.Color(0.02, 0.02, 0.04) },
        uShadowOpacity: { value: 0.72 },
        uSunDir:        { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() }
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

    // A forced sort is applied before returning (callers render right after); otherwise sort off-thread when possible.
    if (force) {
      this.applySortedIndices(this.radixSorter.sortSync(this.splatData.positions, camPos, camDir, this.splatCount));
      return;
    }
    this.radixSorter.sort(
      this.splatData.positions,
      camPos,
      camDir,
      this.splatCount,
      (sortedIndices) => this.applySortedIndices(sortedIndices)
    );
  }

  /**
   * Applies the new draw order by writing sorted original indices into the sortOrder
   * attribute. Only this one buffer is uploaded to the GPU per sort event (~4 bytes/splat),
   * whereas the previous approach rewrote all five attribute arrays (~56 bytes/splat).
   */
  public applySortedIndices(indices: Uint32Array): void {
    const sortAttr = this.splatGeometry.getAttribute('sortOrder') as THREE.InstancedBufferAttribute;
    const arr = sortAttr.array as Float32Array;
    for (let i = 0; i < this.splatCount; i++) {
      arr[i] = indices[i];
    }
    sortAttr.needsUpdate = true;
  }

  /**
   * Configures camera position for Split-64 Relative-to-Center emulation.
   */
  public setCameraRtc(cameraEcef: [number, number, number] | Float64Array | THREE.Vector3): void {
    const cx = 'x' in cameraEcef ? cameraEcef.x : cameraEcef[0];
    const cy = 'y' in cameraEcef ? cameraEcef.y : cameraEcef[1];
    const cz = 'z' in cameraEcef ? cameraEcef.z : cameraEcef[2];
    if (this._posHighTex === PhotorealGaussianSplatMesh._dummyRgbaF32) {
      this._buildRtcTextures(this._texWidth, this._posTex.image.height);
    }
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
    const scales    = new Float32Array(count * 3);
    const colors    = new Float32Array(count * 3);
    const opacities = new Float32Array(count);
    const quats     = new Float32Array(count * 4);

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
      opacities[i]      = view.getUint8(off + 27) / 255.0;

      quats[i * 4 + 0] = (view.getUint8(off + 28) - 128) / 127.0;
      quats[i * 4 + 1] = (view.getUint8(off + 29) - 128) / 127.0;
      quats[i * 4 + 2] = (view.getUint8(off + 30) - 128) / 127.0;
      quats[i * 4 + 3] = (view.getUint8(off + 31) - 128) / 127.0;
    }

    return {
      count, positions, scales, colors, opacities, quats,
      bounds: count > 0 ? { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } : undefined,
      centroid: count > 0 ? [sumX / count, sumY / count, sumZ / count] : undefined
    };
  }

  /**
   * Parses .spz (Scaniverse / Niantic compressed format) buffer into SplatData.
   * Higher-order SH coefficients are not decoded by default — pass decodeSH: true
   * to the codec options if the caller actually needs them.
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
    const d = decodeSpz(raw); // decodeSH defaults to false — saves up to 360 MB for large degree-3 files
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
      scales:    d.scales,
      colors:    d.colors,
      opacities: d.opacities,
      quats:     d.quats,
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
  /** The colour texture's bytes (RGBA8 per splat, as drawn), with the as-built copy taken before the first edit. */
  private _editBuffers(): { base: Uint8Array; rgba: Uint8Array } {
    const rgba = this._colorOpacityTex.image.data as Uint8Array;
    if (!this._baseColorOpacity) this._baseColorOpacity = rgba.slice();
    return { base: this._baseColorOpacity, rgba };
  }

  /** The grid over the splat centres the brush and the pick query (built on first use, a second or so for millions). */
  public get editIndex(): SplatEditIndex {
    if (!this._editIndex) this._editIndex = new SplatEditIndex(this.splatData.positions, this.splatCount);
    return this._editIndex;
  }

  /** Whether any splat is drawn differently from how it was built. */
  public get isEdited(): boolean {
    const base = this._baseColorOpacity;
    if (!base) return false;
    const rgba = this._colorOpacityTex.image.data as Uint8Array;
    for (let i = 0; i < this.splatCount * 4; i++) if (rgba[i] !== base[i]) return true;
    return false;
  }

  /** Draws the splat as built with `strokes` replayed over it, in order. */
  public replayEdits(strokes: readonly SplatEditStroke[]): void {
    if (!strokes.length && !this._baseColorOpacity) return;
    const { base, rgba } = this._editBuffers();
    replaySplatEdits(this.editIndex, base, rgba, strokes);
    this._colorOpacityTex.needsUpdate = true;
  }

  /** Applies one stroke over what is drawn now; returns the splats it changed. */
  public applyEditStroke(stroke: SplatEditStroke): number {
    const { base, rgba } = this._editBuffers();
    const n = applySplatStroke(this.editIndex, base, rgba, stroke);
    if (n) this._colorOpacityTex.needsUpdate = true;
    return n;
  }

  /** Starts previewing a stroke: what is drawn now is kept, so each preview redraws the stroke once over it. */
  public beginEditPreview(): void {
    this._previewStart = this._editBuffers().rgba.slice();
  }

  /**
   * Draws `stroke` (as painted so far) over what was drawn when the preview began. Redrawing it whole, rather than
   * adding each new piece, makes the preview match the stroke's replay: overlapping pieces do not paint twice.
   */
  public previewEditStroke(stroke: SplatEditStroke): void {
    const { base, rgba } = this._editBuffers();
    if (this._previewStart) rgba.set(this._previewStart);
    applySplatStroke(this.editIndex, base, rgba, stroke);
    this._colorOpacityTex.needsUpdate = true;
  }

  /** Ends the preview, keeping what it drew; returns whether the stroke changed any splat. */
  public endEditPreview(): boolean {
    const start = this._previewStart;
    this._previewStart = null;
    if (!start) return false;
    const rgba = this._colorOpacityTex.image.data as Uint8Array;
    for (let i = 0; i < this.splatCount * 4; i++) if (rgba[i] !== start[i]) return true;
    return false;
  }

  /**
   * The nearest drawn splat under a world-space ray: its centre in this splat's frame and in the world, or undefined.
   * A splat counts as hit when the ray passes within its footprint (two sigmas) or a few pixels' width of its centre.
   */
  public pickEditPoint(ray: THREE.Ray, maxDistance = 500, pixelAngle = 0.002): { local: THREE.Vector3; world: THREE.Vector3 } | undefined {
    this.updateWorldMatrix(true, false);
    const inv = this.matrixWorld.clone().invert();
    const o = ray.origin.clone().applyMatrix4(inv);
    const d = ray.origin.clone().add(ray.direction).applyMatrix4(inv).sub(o).normalize();
    const rgba = this._colorOpacityTex.image.data as Uint8Array;
    const index = this.editIndex;
    // a splat is hit within two sigmas of its largest axis (its drawn footprint), capped so a stray giant does not catch every ray
    const sc = this.splatData.scales;
    const footprint = (i: number) => 2 * Math.max(sc[i * 3], sc[i * 3 + 1], sc[i * 3 + 2]);
    const hit = index.pick([o.x, o.y, o.z], [d.x, d.y, d.z], rgba, maxDistance, t => Math.max(0.03, pixelAngle * t), footprint, PICK_MAX_FOOTPRINT_M);
    if (!hit) return undefined;
    const p = this.splatData.positions;
    const local = new THREE.Vector3(p[hit.index * 3], p[hit.index * 3 + 1], p[hit.index * 3 + 2]);
    return { local, world: local.clone().applyMatrix4(this.matrixWorld) };
  }

    this.splatMaterial.dispose();
    this._posTex.dispose();
    this._scaleTex.dispose();
    this._colorOpacityTex.dispose();
    this._quatTex.dispose();
    // Don't dispose the shared static dummy textures
    if (this._posHighTex !== PhotorealGaussianSplatMesh._dummyRgbaF32) this._posHighTex.dispose();
    if (this._posLowTex  !== PhotorealGaussianSplatMesh._dummyRgbaF32) this._posLowTex.dispose();
    if (this.contactShadowMesh) {
      this.contactShadowMesh.geometry.dispose();
      (this.contactShadowMesh.material as THREE.Material).dispose();
    }
  }
}
