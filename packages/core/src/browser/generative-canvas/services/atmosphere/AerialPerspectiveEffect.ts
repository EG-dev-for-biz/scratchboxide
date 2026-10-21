/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

import * as THREE from 'three';
import {
    AerialPerspectiveOptions,
    DiurnalLightingProfile
} from './atmosphere-types';

export const AERIAL_PERSPECTIVE_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
varying vec3 vViewRay;

uniform mat4 uInverseProjectionMatrix;

void main() {
    vUv = uv;
    // Compute view-space ray direction from clip coordinates
    vec4 clipPos = vec4(position.xy, 1.0, 1.0);
    vec4 viewPos = uInverseProjectionMatrix * clipPos;
    vViewRay = vec3(viewPos.xy / viewPos.w, viewPos.z / viewPos.w);
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const AERIAL_PERSPECTIVE_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tDepth;

uniform mat4 uInverseProjectionMatrix;
uniform mat4 uInverseViewMatrix;
uniform vec3 uCameraPosition;
uniform float uCameraNear;
uniform float uCameraFar;

uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uZenithColor;
uniform vec3 uHorizonColor;

uniform float uRayleigh;
uniform float uMie;
uniform float uTurbidity;
uniform float uMieDirectionalG;

uniform float uInscatteringIntensity;
uniform float uAerialPerspectiveRange;
uniform float uAerialAlbedoBoost;

uniform bool uCloudShadowsEnabled;
uniform float uCloudShadowIntensity;
uniform float uCloudShadowScale;
uniform float uAtmosphereShadowLength;
uniform float uCloudAltitude;
uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform vec2 uWindVector;
uniform float uTime;

uniform bool uIsNight;
uniform bool uIsGoldenHour;
uniform bool uIsTwilight;

varying vec2 vUv;
varying vec3 vViewRay;

// -------------------------------------------------------------
// Noise Primitives for Ground Cloud Shadows
// -------------------------------------------------------------
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise2D(vec2 v) {
    const vec4 C = vec4(0.211324865405187,  // (3.0-sqrt(3.0))/6.0
                        0.366025403784439,  // 0.5*(sqrt(3.0)-1.0)
                       -0.577350269189626,  // -1.0 + 2.0 * C.x
                        0.024390243902439); // 1.0 / 41.0
    vec2 i  = floor(v + dot(v, C.yy));
    vec2 x0 = v - i + dot(i, C.xx);
    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    vec4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289(i);
    vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                           + i.x + vec3(0.0, i1.x, 1.0));
    vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
    m = m * m;
    m = m * m;
    vec3 x = 2.0 * fract(p * C.www) - 1.0;
    vec3 h = abs(x) - 0.5;
    vec3 ox = floor(x + 0.5);
    vec3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
    vec3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}

// 2D Fractional Brownian Motion
float fBm2D(vec2 p) {
    float val = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 4; i++) {
        val += amp * snoise2D(p * freq);
        freq *= 2.05;
        amp *= 0.5;
    }
    return val * 0.5 + 0.5;
}

// Henyey-Greenstein Phase Function
float henyeyGreenstein(float cosAngle, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265359 * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
}

// Linear view depth from depth buffer
float readLinearDepth(float depth) {
    float z_ndc = depth * 2.0 - 1.0;
    return (2.0 * uCameraNear * uCameraFar) / (uCameraFar + uCameraNear - z_ndc * (uCameraFar - uCameraNear));
}

// Reconstruct 3D World Position from fragment screen coords & depth
vec3 reconstructWorldPosition(vec2 uv, float linearZ) {
    vec4 clip = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
    vec4 viewRay = uInverseProjectionMatrix * clip;
    vec3 viewPos = (viewRay.xyz / viewRay.w) * (linearZ / abs(viewRay.z / viewRay.w));
    vec4 worldPos = uInverseViewMatrix * vec4(viewPos, 1.0);
    return worldPos.xyz;
}

// Compute Dynamic Terrain Cloud Shadow Factor
float computeCloudShadow(vec3 worldPos) {
    if (!uCloudShadowsEnabled || uCloudCoverage < 0.02) return 0.0;

    float sunH = max(0.08, uSunDirection.y);
    float tCloud = max(0.0, uCloudAltitude - worldPos.y) / sunH;
    vec2 shadowCoord = (worldPos.xz + uSunDirection.xz * tCloud) * uCloudShadowScale;
    shadowCoord += uWindVector * uTime;

    float noiseVal = fBm2D(shadowCoord);
    float threshold = 1.0 - clamp(uCloudCoverage, 0.0, 0.98) * 0.85;
    float cloudDensityVal = smoothstep(threshold - 0.22, threshold + 0.22, noiseVal) * uCloudDensity;

    float shadowFactor = clamp(cloudDensityVal * uCloudShadowIntensity * uAtmosphereShadowLength, 0.0, 0.88);
    return shadowFactor;
}

// Physical Beer-Lambert Exponential Transmittance & Inscattering
void computeAerialPerspective(
    vec3 worldPos,
    float dist,
    vec3 viewDir,
    out vec3 transmittance,
    out vec3 inscattering
) {
    float normalizedDist = dist / max(10.0, uAerialPerspectiveRange);

    // Multi-wavelength Rayleigh scattering coefficients with physical chromatic dispersion
    vec3 betaR = vec3(5.8e-4, 13.5e-4, 33.1e-4) * uRayleigh * (100.0 / max(10.0, uAerialPerspectiveRange));
    vec3 betaM = vec3(4.0e-3) * uMie * uTurbidity * (100.0 / max(10.0, uAerialPerspectiveRange));
    vec3 betaExt = betaR + betaM;

    // Optical depth
    vec3 opticalDepth = betaExt * dist * 0.85;
    transmittance = exp(-opticalDepth);

    // Phase function
    float cosTheta = dot(viewDir, uSunDirection);
    float rayleighPhase = (3.0 / (16.0 * 3.14159265)) * (1.0 + cosTheta * cosTheta);
    float miePhase = henyeyGreenstein(cosTheta, uMieDirectionalG);

    // Sun alignment and diurnal horizon color
    float sunAlignment = max(0.0, cosTheta);
    vec3 sunLightRadiance = uSunColor * uSunIntensity * (rayleighPhase * betaR * 12.0 + miePhase * betaM * 35.0);

    // Zenith to horizon gradient based on view elevation
    float upFactor = max(0.0, viewDir.y);
    vec3 skyHorizon = mix(uHorizonColor, uZenithColor, pow(upFactor, 0.6));

    if (uIsGoldenHour) {
        skyHorizon = mix(skyHorizon, vec3(1.0, 0.55, 0.22), 0.45);
    } else if (uIsTwilight) {
        skyHorizon = mix(skyHorizon, vec3(0.55, 0.35, 0.65), 0.50);
    }

    // Integrated inscattering along ray path
    vec3 inscatterFactor = vec3(1.0) - transmittance;
    float meanInscatter = (inscatterFactor.r + inscatterFactor.g + inscatterFactor.b) / 3.0;

    vec3 ambientInscatter = skyHorizon * meanInscatter;
    vec3 directInscatter = sunLightRadiance * meanInscatter * (uIsNight ? 0.0 : 1.0);

    inscattering = (ambientInscatter + directInscatter * (0.35 + 0.65 * pow(sunAlignment, 3.0)))
                   * uInscatteringIntensity * uAerialAlbedoBoost;
}

void main() {
    vec4 sceneColor = texture2D(tColor, vUv);
    float depthVal = texture2D(tDepth, vUv).r;

    // Preserve sky dome without overfogging background dome
    if (depthVal >= 0.9999) {
        gl_FragColor = sceneColor;
        return;
    }

    float linearZ = readLinearDepth(depthVal);
    vec3 worldPos = reconstructWorldPosition(vUv, linearZ);
    vec3 toCamera = uCameraPosition - worldPos;
    float dist = length(toCamera);
    vec3 viewDir = normalize(-toCamera);

    // 1. Terrain Cloud Shadows Modulation
    float shadowFactor = computeCloudShadow(worldPos);
    vec3 litColor = sceneColor.rgb * (1.0 - shadowFactor);

    // 2. Aerial Perspective Transmittance & Depth Inscattering
    vec3 transmittance, inscattering;
    computeAerialPerspective(worldPos, dist, viewDir, transmittance, inscattering);

    // Composite final surface color
    vec3 finalColor = litColor * transmittance + inscattering;

    gl_FragColor = vec4(finalColor, sceneColor.a);
}
`;

/**
 * Pure function: Computes Beer-Lambert exponential transmittance attenuation vector across RGB wavelengths.
 */
export function computeBeerLambertTransmittance(
    distance: number,
    rayleigh: number = 0.5,
    mie: number = 0.002,
    turbidity: number = 1.5,
    maxRange: number = 250.0
): THREE.Color {
    const d = Math.max(0.0, distance);
    const rangeScale = 100.0 / Math.max(10.0, maxRange);

    const betaR = new THREE.Vector3(5.8e-4, 13.5e-4, 33.1e-4).multiplyScalar(rayleigh * rangeScale);
    const betaM = 4.0e-3 * mie * turbidity * rangeScale;

    const trR = Math.exp(-(betaR.x + betaM) * d * 0.85);
    const trG = Math.exp(-(betaR.y + betaM) * d * 0.85);
    const trB = Math.exp(-(betaR.z + betaM) * d * 0.85);

    return new THREE.Color(
        Math.min(1.0, Math.max(0.0, trR)),
        Math.min(1.0, Math.max(0.0, trG)),
        Math.min(1.0, Math.max(0.0, trB))
    );
}

/**
 * Pure function: Evaluates physical inscattered atmospheric radiance.
 */
export function computeInscatteringRadiance(
    distance: number,
    viewDir: THREE.Vector3,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    sunIntensity: number,
    horizonColor: THREE.Color,
    zenithColor: THREE.Color,
    rayleigh: number = 0.5,
    mie: number = 0.002,
    mieG: number = 0.82,
    inscatteringIntensity: number = 1.0,
    diurnalProfile?: DiurnalLightingProfile,
    maxRange: number = 250.0
): THREE.Color {
    const trans = computeBeerLambertTransmittance(distance, rayleigh, mie, 1.5, maxRange);
    const v = viewDir.clone().normalize();
    const s = sunDir.clone().normalize();
    const cosTheta = Math.max(-1.0, Math.min(1.0, v.dot(s)));

    // Rayleigh & Mie Phase
    const rayleighPhase = (3.0 / (16.0 * Math.PI)) * (1.0 + cosTheta * cosTheta);
    const g2 = mieG * mieG;
    const miePhase = (1.0 - g2) / (4.0 * Math.PI * Math.pow(1.0 + g2 - 2.0 * mieG * cosTheta, 1.5));

    const upFactor = Math.max(0.0, v.y);
    const skyHaze = horizonColor.clone().lerp(zenithColor, Math.pow(upFactor, 0.6));

    if (diurnalProfile?.isGoldenHour) {
        skyHaze.lerp(new THREE.Color(1.0, 0.55, 0.22), 0.45);
    } else if (diurnalProfile?.isTwilight) {
        skyHaze.lerp(new THREE.Color(0.55, 0.35, 0.65), 0.50);
    }

    const sunAlign = Math.max(0.0, cosTheta);
    const directRadiance = sunColor.clone().multiplyScalar(
        sunIntensity * (rayleighPhase * rayleigh * 0.05 + miePhase * mie * 2.5) * (diurnalProfile?.isNight ? 0.0 : 1.0)
    );

    const albedoBoost = diurnalProfile?.aerialAlbedoBoost ?? 1.1;

    const inscatterFactor = 1.0 - (trans.r + trans.g + trans.b) / 3.0;
    const inscatterR = (skyHaze.r * inscatterFactor + directRadiance.r * inscatterFactor * (0.35 + 0.65 * Math.pow(sunAlign, 3))) * inscatteringIntensity * albedoBoost;
    const inscatterG = (skyHaze.g * inscatterFactor + directRadiance.g * inscatterFactor * (0.35 + 0.65 * Math.pow(sunAlign, 3))) * inscatteringIntensity * albedoBoost;
    const inscatterB = (skyHaze.b * inscatterFactor + directRadiance.b * inscatterFactor * (0.35 + 0.65 * Math.pow(sunAlign, 3))) * inscatteringIntensity * albedoBoost;

    return new THREE.Color(
        Math.min(1.0, Math.max(0.0, inscatterR)),
        Math.min(1.0, Math.max(0.0, inscatterG)),
        Math.min(1.0, Math.max(0.0, inscatterB))
    );
}

/**
 * Pure function: Blends surface color with aerial perspective transmittance and inscattering.
 */
export function evaluateAerialPerspective(
    surfaceColor: THREE.Color,
    distance: number,
    viewDir: THREE.Vector3,
    sunDir: THREE.Vector3,
    sunColor: THREE.Color,
    sunIntensity: number,
    horizonColor: THREE.Color,
    zenithColor: THREE.Color,
    config: { rayleigh?: number; mie?: number; turbidity?: number; inscatteringIntensity?: number; aerialPerspectiveRange?: number },
    diurnalProfile?: DiurnalLightingProfile
): THREE.Color {
    const range = config.aerialPerspectiveRange ?? 250.0;
    const trans = computeBeerLambertTransmittance(distance, config.rayleigh, config.mie, config.turbidity, range);
    const inscatter = computeInscatteringRadiance(
        distance, viewDir, sunDir, sunColor, sunIntensity, horizonColor, zenithColor,
        config.rayleigh, config.mie, 0.82, config.inscatteringIntensity ?? 1.0, diurnalProfile, range
    );

    return new THREE.Color(
        surfaceColor.r * trans.r + inscatter.r,
        surfaceColor.g * trans.g + inscatter.g,
        surfaceColor.b * trans.b + inscatter.b
    );
}

/**
 * Pure function: Calculates projected 2D cloud shadow texture coordinates $(U, V)$ given world position, sun direction, and wind drift.
 */
export function projectCloudShadowCoordinates(
    worldPos: THREE.Vector3,
    sunDir: THREE.Vector3,
    cloudAltitude: number = 1200.0,
    shadowScale: number = 0.015,
    windVector: [number, number] = [0.05, 0.02],
    time: number = 0.0
): { u: number; v: number } {
    const sunH = Math.max(0.08, sunDir.y);
    const tCloud = Math.max(0.0, cloudAltitude - worldPos.y) / sunH;

    const u = (worldPos.x + sunDir.x * tCloud) * shadowScale + windVector[0] * time;
    const v = (worldPos.z + sunDir.z * tCloud) * shadowScale + windVector[1] * time;

    return { u, v };
}

// 2D Hash & Value Noise for CPU Shadow Factor calculations
function hash2D(x: number, y: number): number {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123;
    return n - Math.floor(n);
}

function noise2D(x: number, y: number): number {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = x - i;
    const fy = y - j;
    const ux = fx * fx * (3.0 - 2.0 * fx);
    const uy = fy * fy * (3.0 - 2.0 * fy);

    const a = hash2D(i, j);
    const b = hash2D(i + 1, j);
    const c = hash2D(i, j + 1);
    const d = hash2D(i + 1, j + 1);

    return a * (1 - ux) * (1 - uy) + b * ux * (1 - uy) + c * (1 - ux) * uy + d * ux * uy;
}

function fBm2DCPU(x: number, y: number): number {
    let val = 0.0;
    let amp = 0.5;
    let freq = 1.0;
    for (let o = 0; o < 4; o++) {
        val += amp * noise2D(x * freq, y * freq);
        freq *= 2.05;
        amp *= 0.5;
    }
    return val;
}

/**
 * Pure function: Evaluates dynamic cloud shadow density factor $\sigma \in [0, 1]$.
 */
export function computeCloudShadowFactor(
    shadowCoord: THREE.Vector2,
    _time: number = 0.0,
    cloudCoverage: number = 0.35,
    cloudDensity: number = 0.45,
    cloudShadowIntensity: number = 0.65,
    atmosphereShadowLength: number = 1.0
): number {
    if (cloudCoverage < 0.02) return 0.0;

    const n = fBm2DCPU(shadowCoord.x, shadowCoord.y);
    const threshold = 1.0 - Math.min(0.98, Math.max(0.0, cloudCoverage)) * 0.85;

    const edge0 = threshold - 0.22;
    const edge1 = threshold + 0.22;
    const t = Math.min(1.0, Math.max(0.0, (n - edge0) / (edge1 - edge0)));
    const smoothT = t * t * (3.0 - 2.0 * t);
    const rawDensity = smoothT * cloudDensity;

    const shadowFactor = Math.min(0.88, Math.max(0.0, rawDensity * cloudShadowIntensity * atmosphereShadowLength));
    return shadowFactor;
}

/**
 * Complete WebGL Post-Processing Aerial Perspective & Cloud Shadows Effect Module.
 */
export class AerialPerspectiveEffect {
    public readonly renderTarget: THREE.WebGLRenderTarget;
    public readonly material: THREE.ShaderMaterial;
    private readonly quadScene: THREE.Scene;
    private readonly quadCamera: THREE.OrthographicCamera;
    private readonly quadMesh: THREE.Mesh;
    private width: number;
    private height: number;

    constructor(options: AerialPerspectiveOptions = {}, width: number = 1024, height: number = 768) {
        this.width = width;
        this.height = height;

        // Depth texture setup
        const depthTexture = new THREE.DepthTexture(width, height);
        depthTexture.format = THREE.DepthFormat;
        depthTexture.type = THREE.UnsignedShortType;

        this.renderTarget = new THREE.WebGLRenderTarget(width, height, {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            depthTexture
        });

        // Uniform initialization
        const uniforms = {
            tColor: { value: this.renderTarget.texture },
            tDepth: { value: depthTexture },

            uInverseProjectionMatrix: { value: new THREE.Matrix4() },
            uInverseViewMatrix: { value: new THREE.Matrix4() },
            uCameraPosition: { value: new THREE.Vector3() },
            uCameraNear: { value: 0.1 },
            uCameraFar: { value: 1000.0 },

            uSunDirection: { value: options.sunDirection?.clone() || new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
            uSunColor: { value: options.sunColor?.clone() || new THREE.Color(1.0, 0.98, 0.92) },
            uSunIntensity: { value: options.sunIntensity ?? 1.45 },
            uZenithColor: { value: options.topColor?.clone() || new THREE.Color(0.12, 0.38, 0.85) },
            uHorizonColor: { value: options.bottomColor?.clone() || new THREE.Color(0.75, 0.88, 0.98) },

            uRayleigh: { value: options.rayleigh ?? 0.5 },
            uMie: { value: options.mie ?? 0.002 },
            uTurbidity: { value: options.turbidity ?? 1.5 },
            uMieDirectionalG: { value: options.mieDirectionalG ?? 0.82 },

            uInscatteringIntensity: { value: options.inscatteringIntensity ?? 1.0 },
            uAerialPerspectiveRange: { value: options.aerialPerspectiveRange ?? 220.0 },
            uAerialAlbedoBoost: { value: options.albedoScale ?? 1.1 },

            uCloudShadowsEnabled: { value: options.cloudShadowsEnabled ?? true },
            uCloudShadowIntensity: { value: options.cloudShadowIntensity ?? 0.65 },
            uCloudShadowScale: { value: options.cloudShadowScale ?? 0.015 },
            uAtmosphereShadowLength: { value: options.atmosphereShadowLength ?? 1.0 },
            uCloudAltitude: { value: options.cloudAltitude ?? 2200.0 },
            uCloudCoverage: { value: options.cloudCoverage ?? 0.35 },
            uCloudDensity: { value: options.cloudDensity ?? 0.45 },
            uWindVector: { value: new THREE.Vector2(options.windVector?.[0] ?? 0.05, options.windVector?.[1] ?? 0.02) },
            uTime: { value: 0.0 },

            uIsNight: { value: false },
            uIsGoldenHour: { value: false },
            uIsTwilight: { value: false }
        };

        this.material = new THREE.ShaderMaterial({
            vertexShader: AERIAL_PERSPECTIVE_VERTEX_SHADER,
            fragmentShader: AERIAL_PERSPECTIVE_FRAGMENT_SHADER,
            uniforms,
            depthTest: false,
            depthWrite: false
        });

        this.quadScene = new THREE.Scene();
        this.quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        this.quadMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.quadScene.add(this.quadMesh);
    }

    public update(time: number, _delta: number = 0.016): void {
        this.material.uniforms.uTime.value = time;
    }

    public setSize(width: number, height: number): void {
        if (width === this.width && height === this.height) return;
        this.width = Math.max(1, width);
        this.height = Math.max(1, height);
        this.renderTarget.setSize(this.width, this.height);
    }

    public render(
        renderer: THREE.WebGLRenderer,
        scene: THREE.Scene,
        camera: THREE.PerspectiveCamera,
        sunDirection?: THREE.Vector3,
        diurnalProfile?: DiurnalLightingProfile,
        skyDomeModule?: any,
        options: AerialPerspectiveOptions = {}
    ): void {
        const u = this.material.uniforms;

        // Camera matrices
        camera.updateMatrixWorld();
        camera.updateProjectionMatrix();

        u.uInverseProjectionMatrix.value.copy(camera.projectionMatrixInverse);
        u.uInverseViewMatrix.value.copy(camera.matrixWorld);
        u.uCameraPosition.value.copy(camera.position);
        u.uCameraNear.value = camera.near;
        u.uCameraFar.value = camera.far;

        // Solar and atmospheric updates
        if (sunDirection) {
            u.uSunDirection.value.copy(sunDirection);
        }
        if (skyDomeModule?.sunLight) {
            u.uSunColor.value.copy(skyDomeModule.sunLight.color);
            u.uSunIntensity.value = skyDomeModule.sunLight.intensity;
        }

        if (diurnalProfile) {
            u.uIsNight.value = diurnalProfile.isNight;
            u.uIsGoldenHour.value = diurnalProfile.isGoldenHour;
            u.uIsTwilight.value = diurnalProfile.isTwilight;
            u.uAerialAlbedoBoost.value = diurnalProfile.aerialAlbedoBoost;

            if (diurnalProfile.isGoldenHour) {
                u.uHorizonColor.value.set(0xf97316);
                u.uZenithColor.value.set(0x311042);
            } else if (diurnalProfile.isNight) {
                u.uHorizonColor.value.set(0x0a1428);
                u.uZenithColor.value.set(0x050a18);
            } else {
                u.uHorizonColor.value.set(0xe0f2fe);
                u.uZenithColor.value.set(0x0369a1);
            }
        }

        if (options.inscatteringIntensity !== undefined) {
            u.uInscatteringIntensity.value = options.inscatteringIntensity;
        }
        if (options.aerialPerspectiveRange !== undefined) {
            u.uAerialPerspectiveRange.value = options.aerialPerspectiveRange;
        }
        if (options.cloudShadowsEnabled !== undefined) {
            u.uCloudShadowsEnabled.value = options.cloudShadowsEnabled;
        }
        if (options.cloudShadowIntensity !== undefined) {
            u.uCloudShadowIntensity.value = options.cloudShadowIntensity;
        }
        if (options.atmosphereShadowLength !== undefined) {
            u.uAtmosphereShadowLength.value = options.atmosphereShadowLength;
        }

        // 1. Render main scene to color + depth target
        const currentRenderTarget = renderer.getRenderTarget();
        renderer.setRenderTarget(this.renderTarget);
        renderer.render(scene, camera);

        // 2. Render full-screen post-pass to original target/screen
        renderer.setRenderTarget(currentRenderTarget);
        renderer.render(this.quadScene, this.quadCamera);
    }

    public dispose(): void {
        this.renderTarget.dispose();
        this.material.dispose();
        this.quadMesh.geometry.dispose();
    }
}

export function createAerialPerspectiveEffect(
    options: AerialPerspectiveOptions = {},
    width: number = 1024,
    height: number = 768
): AerialPerspectiveEffect {
    return new AerialPerspectiveEffect(options, width, height);
}
