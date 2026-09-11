/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import * as THREE from 'three';
import {
    AtmosphericScatteringConfig,
    AtmosphericSkyDomeModule,
    TimeOfDayPreset
} from './atmosphere-types';
import { kelvinToRGB } from './kelvin';
import {
    computeDiurnalLightingProfile,
    getDiurnalLightingState,
    getPresetLightingState
} from './diurnal-lighting';
import { getSunVectorFromAngles } from './solar-position';

export const ATMOSPHERE_VERTEX_SHADER = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vNormal;

void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

export const ATMOSPHERE_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;

// Multi-order Rayleigh & Mie topColor (zenith) and bottomColor (horizon) gradient palettes
uniform vec3 topColor;
uniform vec3 bottomColor;

uniform float uTurbidity;
uniform float uRayleigh;
uniform float uMieCoefficient;
uniform float uMieDirectionalG;

uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudAltitude;
uniform float uTime;

uniform bool uIsNight;
uniform bool uIsGoldenHour;
uniform bool uIsTwilight;

varying vec3 vWorldPosition;
varying vec3 vNormal;

// 4x4 Screen-Space Bayer Dithering Matrix for smooth dither noise
float bayer4x4(vec2 screenPos) {
    mat4 bayer = mat4(
        0.0 / 16.0,  8.0 / 16.0,  2.0 / 16.0, 10.0 / 16.0,
        12.0 / 16.0,  4.0 / 16.0, 14.0 / 16.0,  6.0 / 16.0,
        3.0 / 16.0, 11.0 / 16.0,  1.0 / 16.0,  9.0 / 16.0,
        15.0 / 16.0,  7.0 / 16.0, 13.0 / 16.0,  5.0 / 16.0
    );
    ivec2 idx = ivec2(mod(screenPos, 4.0));
    return bayer[idx.x][idx.y];
}

// Earth curvature atmospheric shell distance calculation
float getAtmosphereDistance(vec3 rayDir, float alt) {
    float R = 6371000.0;
    float b = R * rayDir.y;
    float c = 2.0 * R * alt + alt * alt;
    return -b + sqrt(max(0.0, b * b + c));
}

// 3D Simplex Noise for Volumetric Clouds
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);

    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);

    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;

    i = mod289(i);
    vec4 p = permute(permute(permute(
                i.z + vec4(0.0, i1.z, i2.z, 1.0))
                + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                + i.x + vec4(0.0, i1.x, i2.x, 1.0));

    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;

    vec4 j = p - 49.0 * floor(p * ns.z);

    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);

    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);

    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);

    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));

    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);

    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x;
    p1 *= norm.y;
    p2 *= norm.z;
    p3 *= norm.w;

    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

// 4-octave 3D Fractional Brownian Motion (fBm)
float fBm3D(vec3 p) {
    float val = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 4; i++) {
        val += amp * snoise(p * freq);
        freq *= 2.05;
        amp *= 0.5;
    }
    return val * 0.5 + 0.5;
}

// 3D Worley (Cellular) Noise Function
vec3 hash33(vec3 p) {
    p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
             dot(p, vec3(269.5, 183.3, 246.1)),
             dot(p, vec3(113.5, 271.9, 124.6)));
    return fract(sin(p) * 43758.5453123);
}

float worley3D(vec3 p) {
    vec3 id = floor(p);
    vec3 fd = fract(p);
    float minDist = 1.0;
    for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
            for (int z = -1; z <= 1; z++) {
                vec3 offset = vec3(float(x), float(y), float(z));
                vec3 pt = hash33(id + offset);
                vec3 r = offset + pt - fd;
                float d = dot(r, r);
                minDist = min(minDist, d);
            }
        }
    }
    return sqrt(minDist);
}

// Multi-scale 3D Perlin-Worley noise for volumetric cumulus billows
float perlinWorley3D(vec3 p, float time) {
    float perlin = fBm3D(p);
    float worley1 = 1.0 - worley3D(p * 1.8 + vec3(time * 0.004, time * 0.002, 0.0));
    float worley2 = 1.0 - worley3D(p * 3.6 - vec3(0.0, time * 0.003, time * 0.005));
    float worley3 = 1.0 - worley3D(p * 7.2 + vec3(time * 0.002, 0.0, time * 0.004));
    float worleyBillows = worley1 * 0.50 + worley2 * 0.35 + worley3 * 0.15;

    float pw = clamp((perlin - (1.0 - worleyBillows) * 0.45) / 0.55, 0.0, 1.0);
    return clamp(mix(pw, worleyBillows, 0.50), 0.0, 1.0);
}

// Henyey-Greenstein Mie Phase Function
float henyeyGreenstein(float cosAngle, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (4.0 * 3.14159265359 * pow(1.0 + g2 - 2.0 * g * cosAngle, 1.5));
}

void main() {
    vec3 rayDir = normalize(vWorldPosition);
    float cosViewSun = dot(rayDir, uSunDirection);

    // --- 1. PHYSICAL RAYLEIGH & MIE SKY GRADIENT ---
    float sunH = uSunDirection.y;
    float upFactor = max(0.001, rayDir.y);

    // Zenith and Horizon Sky Color Palettes based on Sun Elevation
    vec3 dayZenith = vec3(0.12, 0.38, 0.85); // Pure azure sky overhead
    vec3 dayHorizon = vec3(0.75, 0.88, 0.98); // Soft horizon sky

    vec3 goldenZenith = vec3(0.10, 0.25, 0.65);
    vec3 goldenHorizon = vec3(1.0, 0.55, 0.22); // Warm golden sunset

    vec3 twilightZenith = vec3(0.05, 0.12, 0.38);
    vec3 twilightHorizon = vec3(0.72, 0.35, 0.45);

    vec3 nightZenith = vec3(0.005, 0.01, 0.025);
    vec3 nightHorizon = vec3(0.015, 0.025, 0.05);

    // Smooth diurnal phase blending
    float dayFactor = smoothstep(0.08, 0.30, sunH);
    float goldenFactor = smoothstep(-0.02, 0.12, sunH) * (1.0 - dayFactor);
    float twilightFactor = smoothstep(-0.12, 0.02, sunH) * (1.0 - smoothstep(-0.02, 0.12, sunH));

    if (uIsNight) {
        dayFactor = 0.0; goldenFactor = 0.0; twilightFactor = 0.0;
    } else if (uIsGoldenHour) {
        goldenFactor = 1.0; dayFactor = 0.0; twilightFactor = 0.0;
    } else if (uIsTwilight) {
        twilightFactor = 1.0; dayFactor = 0.0; goldenFactor = 0.0;
    }

    vec3 zenithColor = mix(nightZenith, twilightZenith, twilightFactor);
    zenithColor = mix(zenithColor, goldenZenith, goldenFactor);
    zenithColor = mix(zenithColor, dayZenith, dayFactor);

    vec3 horizonColor = mix(nightHorizon, twilightHorizon, twilightFactor);
    horizonColor = mix(horizonColor, goldenHorizon, goldenFactor);
    horizonColor = mix(horizonColor, dayHorizon, dayFactor);

    // Soft vertical sky gradient
    float skyGradient = pow(1.0 - max(0.0, upFactor), 2.2);
    vec3 skyColor = mix(zenithColor, horizonColor, skyGradient);

    // Low-sun directional horizon glow
    if (sunH > -0.05 && sunH < 0.28) {
        float sunGlow = pow(max(0.0, cosViewSun), 6.0) * pow(1.0 - max(0.0, upFactor), 2.0);
        skyColor += uSunColor * sunGlow * 0.4;
    }

    // --- 2. EXACT SINGLE PHYSICAL SUN ---
    float sunVisibility = smoothstep(-0.06, 0.02, sunH);

    if (!uIsNight && sunVisibility > 0.0) {
        // Solar Disc (~0.53 degree angular diameter)
        float cosSunRadius = 0.99988;
        float sunDisc = smoothstep(cosSunRadius - 0.00025, cosSunRadius, cosViewSun);

        // Forward Mie scattering solar corona aureole
        float miePhase = henyeyGreenstein(cosViewSun, uMieDirectionalG);
        float softGlare = pow(max(0.0, cosViewSun), 128.0) * 1.2 + pow(max(0.0, cosViewSun), 16.0) * 0.25;

        vec3 directSunRadiance = uSunColor * uSunIntensity * sunVisibility;
        vec3 physicalSun = (sunDisc * 12.0 + softGlare + miePhase * uMieCoefficient * 25.0) * directSunRadiance;

        skyColor += physicalSun;
    }

    // --- 3. TRUE 3D VOLUMETRIC CUMULUS BILLOW DOME CLOUDS ---
    if (uCloudCoverage > 0.01 && rayDir.y > 0.005) {
        float skyFade = smoothstep(0.005, 0.18, rayDir.y);

        // Altitude shell bounds: uCloudAltitude to uCloudAltitude + 1800.0m in world/sky space
        float bottomAlt = uCloudAltitude;
        float shellThickness = 1800.0;
        float topAlt = bottomAlt + shellThickness;

        // Ray intersection with spherical sky shell bounds
        float tBottom = getAtmosphereDistance(rayDir, bottomAlt);
        float tTop = getAtmosphereDistance(rayDir, topAlt);

        float rayLength = max(100.0, tTop - tBottom);
        int numSteps = 24;
        float stepSize = rayLength / float(numSteps);

        // Smooth screen-space Bayer matrix dither pattern offset
        float jitter = (bayer4x4(gl_FragCoord.xy) - 0.5) * 0.08;

        float totalAccDensity = 0.0;
        vec3 accCloudColor = vec3(0.0);
        float transmittance = 1.0;

        // Multi-step 3D volumetric raymarching loop
        for (int i = 0; i < 24; i++) {
            float fi = float(i) + jitter;
            float t = tBottom + stepSize * fi;
            vec3 pos = rayDir * t;

            // Normalized height coordinate z in [0, 1] within cloud altitude shell
            float z = clamp((pos.y - bottomAlt) / shellThickness, 0.0, 1.0);

            // Convective Cumulus Height Shaping Function H(z)
            float baseShape = smoothstep(0.02, 0.18, z);
            float topShape = smoothstep(0.98, 0.55, z);
            float heightShaping = baseShape * topShape * (1.0 + 0.3 * sin(z * 3.14159));

            // 3D World-space sampling coordinates with wind drift
            vec3 cloudCoord = pos * 0.00020 + vec3(uTime * 0.004, 0.0, uTime * 0.002);

            // Base multi-scale 3D Perlin-Worley noise evaluation
            float pwNoise = perlinWorley3D(cloudCoord, uTime);

            // Coverage thresholding with smooth transition range
            float threshold = 1.0 - clamp(uCloudCoverage, 0.0, 0.98) * 0.85;
            float rawShape = smoothstep(threshold - 0.22, threshold + 0.22, pwNoise);

            // Apply vertical height shaping H(z)
            float shapedDensity = rawShape * heightShaping;

            // High-octave 3D Worley detail erosion pass forming billowy cumulus cauliflower puffs
            float wLow = worley3D(cloudCoord * 5.0 + vec3(uTime * 0.005, uTime * 0.002, 0.0));
            float wMid = worley3D(cloudCoord * 12.0 - vec3(0.0, uTime * 0.004, uTime * 0.006));
            float wHigh = worley3D(cloudCoord * 24.0 + vec3(uTime * 0.003, uTime * 0.005, uTime * 0.002));
            float detailWorley = wLow * 0.50 + wMid * 0.35 + wHigh * 0.15;

            float edgeModifier = smoothstep(0.0, 0.70, shapedDensity) * (1.0 - shapedDensity);
            float erodedDensity = shapedDensity - (1.0 - detailWorley) * edgeModifier * 0.42;

            float density = max(0.0, erodedDensity) * uCloudDensity;

            if (density > 0.001) {
                // Shadow sample ray towards sun for internal optical depth calculation
                vec3 sunDir = normalize(uSunDirection + vec3(0.0, 0.10, 0.0));
                vec3 shadowPos = cloudCoord + sunDir * 0.15;
                float shadowPW = perlinWorley3D(shadowPos, uTime);
                float shadowRaw = smoothstep(threshold - 0.22, threshold + 0.22, shadowPW);
                float zShadow = clamp((pos.y + sunDir.y * 250.0 - bottomAlt) / shellThickness, 0.0, 1.0);
                float shadowDensity = shadowRaw * (smoothstep(0.02, 0.18, zShadow) * smoothstep(0.98, 0.55, zShadow)) * uCloudDensity;

                // Internal optical depth tau
                float tau = shadowDensity * 4.2;

                // Beer-Lambert extinction & Beer-Powder attenuation
                float beerLambert = exp(-tau * (1.0 + uCloudDensity * 2.2));
                float beerPowder = 2.0 * exp(-tau) * (1.0 - exp(-2.0 * tau));
                float selfShadow = mix(beerLambert, beerPowder, 0.70);

                // Henyey-Greenstein anisotropic phase scattering facing uSunDirection
                float forwardG = uIsGoldenHour ? 0.86 : 0.80;
                float hgForward = henyeyGreenstein(cosViewSun, forwardG);
                float hgBackward = henyeyGreenstein(cosViewSun, -0.25);
                float phase = mix(hgBackward, hgForward, 0.82);

                // Soft forward-scattered silver linings
                float rimFactor = smoothstep(0.02, 0.30, density) * (1.0 - smoothstep(0.30, 0.80, density));
                float goldenGlowBoost = (uIsGoldenHour || sunH < 0.15) ? 2.8 : 1.5;
                float silverLining = rimFactor * pow(max(0.0, cosViewSun * 0.5 + 0.5), 2.5) * hgForward * goldenGlowBoost;

                // Directional solar lighting & soft sky ambient integration
                float skyHeightShading = mix(0.35, 1.0, z);
                vec3 cloudSunLight = uSunColor * uSunIntensity * (selfShadow * 1.25 + silverLining * 1.8 + phase * 0.20);
                vec3 cloudAmbient = mix(zenithColor, horizonColor, 0.40) * skyHeightShading;

                vec3 cloudBaseShade = mix(vec3(0.25, 0.28, 0.38), vec3(0.95, 0.97, 1.0), selfShadow);
                vec3 stepColor = cloudBaseShade * (cloudSunLight + cloudAmbient * 0.90);

                // Step optical integration
                float stepOpticalDepth = density * 1.25;
                float stepAlpha = 1.0 - exp(-stepOpticalDepth);

                accCloudColor += stepColor * stepAlpha * transmittance;
                transmittance *= (1.0 - stepAlpha);
                totalAccDensity += density;

                if (transmittance < 0.02) break;
            }
        }

        float finalDensity = clamp(totalAccDensity, 0.0, 1.0);
        float distanceFade = smoothstep(60000.0, 15000.0, tBottom);
        float cloudAlpha = clamp(pow(max(0.0, finalDensity), 1.4) * skyFade * distanceFade, 0.0, 0.98);

        skyColor = mix(skyColor, accCloudColor, cloudAlpha);
    }

    gl_FragColor = vec4(skyColor, 1.0);
}
`;

/**
 * Instantiates the complete physical Atmospheric Scattering Sky Dome,
 * solar directional lighting, hemisphere bounce light, and dynamic time-of-day solver.
 */
export function createAtmosphericSkyDome(
    scene: THREE.Scene,
    isSunset: boolean = false,
    config: AtmosphericScatteringConfig = {},
    options: { sphereRadius?: number; distanceOffset?: number } = {}
): AtmosphericSkyDomeModule {
    const radius = options.sphereRadius || 280;

    // Resolve initial solar elevation / azimuth
    let initialElev = config.sunElevation !== undefined
        ? config.sunElevation
        : (isSunset ? 4.5 : (config.timeOfDay !== undefined ? (getDiurnalLightingState(config.latitude || 37.77, config.longitude || -122.41, config.timeOfDay).sunElevation) : 52.0));
    let initialAzim = config.sunAzimuth !== undefined
        ? config.sunAzimuth
        : (isSunset ? 260.0 : (config.timeOfDay !== undefined ? (getDiurnalLightingState(config.latitude || 37.77, config.longitude || -122.41, config.timeOfDay).sunAzimuth) : 180.0));

    let diurnalProfile = computeDiurnalLightingProfile(initialElev);
    let sunDirection = getSunVectorFromAngles(initialElev, initialAzim);

    // Compute effective sun color from Kelvin & diurnal phase
    const kelvin = config.kelvinTemperature || (isSunset ? 3200 : (diurnalProfile.isNight ? 12000 : 6500));
    const kelvinCol = kelvinToRGB(kelvin);
    const baseCol = new THREE.Color(
        diurnalProfile.isGoldenHour
            ? '#ffb355'
            : diurnalProfile.isTwilight
            ? '#5c7ab3'
            : diurnalProfile.isNight
            ? '#1a243d'
            : '#fffdf0'
    );
    const effectiveSunColor = baseCol.multiply(kelvinCol);

    // Uniforms initialization
    const uniforms = {
        uSunDirection: { value: sunDirection.clone() },
        uSunColor: { value: effectiveSunColor.clone() },
        uSunIntensity: { value: config.turbidity ? 1.45 : diurnalProfile.sunIntensity },

        topColor: { value: new THREE.Color(isSunset ? 0x311042 : (diurnalProfile.isNight ? 0x050a18 : 0x0369a1)) },
        bottomColor: { value: new THREE.Color(isSunset ? 0xf97316 : (diurnalProfile.isNight ? 0x0a1428 : 0xe0f2fe)) },

        uTurbidity: { value: config.turbidity ?? 1.5 },
        uRayleigh: { value: config.rayleigh ?? 0.5 },
        uMieCoefficient: { value: config.mie ?? 0.002 },
        uMieDirectionalG: { value: config.mieDirectionalG ?? 0.82 },

        uCloudCoverage: { value: config.cloudCoverage ?? (config.volumetricClouds === false ? 0.0 : 0.35) },
        uCloudDensity: { value: config.cloudDensity ?? 0.45 },
        uCloudAltitude: { value: config.cloudAltitude ?? 1200.0 },
        uTime: { value: 0.0 },

        uIsNight: { value: diurnalProfile.isNight },
        uIsGoldenHour: { value: diurnalProfile.isGoldenHour || isSunset },
        uIsTwilight: { value: diurnalProfile.isTwilight }
    };

    const skyGeo = new THREE.SphereGeometry(radius, 32, 24);
    const skyMat = new THREE.ShaderMaterial({
        vertexShader: ATMOSPHERE_VERTEX_SHADER,
        fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
        uniforms,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true
    });

    const skyDome = new THREE.Mesh(skyGeo, skyMat);
    skyDome.name = 'AtmosphericSkyDome';
    skyDome.renderOrder = -1000;
    scene.add(skyDome);

    // Glowing Sun Mesh
    const sunGeo = new THREE.SphereGeometry(Math.max(3, radius * 0.025), 16, 16);
    const sunMat = new THREE.MeshBasicMaterial({
        color: effectiveSunColor,
        transparent: true,
        opacity: diurnalProfile.isNight ? 0.0 : 0.95
    });
    const sunMesh = new THREE.Mesh(sunGeo, sunMat);
    sunMesh.name = 'PhysicalSunDisc';
    const sunDistance = radius * 0.65;
    sunMesh.position.copy(sunDirection).multiplyScalar(sunDistance);
    scene.add(sunMesh);

    // Dynamic Hemisphere Sky & Ground Ambient Bounce Light
    const hemiLight = new THREE.HemisphereLight(
        diurnalProfile.isGoldenHour ? 0xfdba74 : (diurnalProfile.isNight ? 0x1a243d : 0xe0f2fe),
        diurnalProfile.isGoldenHour ? 0x431407 : (diurnalProfile.isNight ? 0x050811 : 0x1e3a8a),
        diurnalProfile.skyLightIntensity
    );
    hemiLight.name = 'AtmosphericHemisphereLight';
    scene.add(hemiLight);

    // Physical Directional Sunlight
    const sunLight = new THREE.DirectionalLight(
        effectiveSunColor.getHex(),
        diurnalProfile.sunIntensity
    );
    sunLight.name = 'AtmosphericSunLight';
    sunLight.position.copy(sunMesh.position);
    sunLight.castShadow = diurnalProfile.castShadows;
    if (sunLight.shadow) {
        sunLight.shadow.bias = -0.0005;
        sunLight.shadow.mapSize.width = 2048;
        sunLight.shadow.mapSize.height = 2048;
    }
    scene.add(sunLight);

    // Update function applying solar angles
    const applySolarState = (elevDeg: number, azimDeg: number, customProfile?: any) => {
        initialElev = elevDeg;
        initialAzim = azimDeg;
        diurnalProfile = customProfile || computeDiurnalLightingProfile(elevDeg);
        sunDirection = getSunVectorFromAngles(elevDeg, azimDeg);

        const currentKelvin = config.kelvinTemperature || (diurnalProfile.isGoldenHour ? 3200 : (diurnalProfile.isNight ? 12000 : 6500));
        const kCol = kelvinToRGB(currentKelvin);
        const bCol = new THREE.Color(
            diurnalProfile.isGoldenHour
                ? '#ffb355'
                : diurnalProfile.isTwilight
                ? '#5c7ab3'
                : diurnalProfile.isNight
                ? '#1a243d'
                : '#fffdf0'
        );
        const effSun = bCol.multiply(kCol);

        uniforms.uSunDirection.value.copy(sunDirection);
        uniforms.uSunColor.value.copy(effSun);
        uniforms.uSunIntensity.value = diurnalProfile.sunIntensity;
        uniforms.uIsNight.value = diurnalProfile.isNight;
        uniforms.uIsGoldenHour.value = diurnalProfile.isGoldenHour;
        uniforms.uIsTwilight.value = diurnalProfile.isTwilight;

        sunMesh.position.copy(sunDirection).multiplyScalar(sunDistance);
        (sunMesh.material as THREE.MeshBasicMaterial).color.copy(effSun);
        (sunMesh.material as THREE.MeshBasicMaterial).opacity = diurnalProfile.isNight ? 0.0 : 0.95;

        sunLight.position.copy(sunMesh.position);
        sunLight.color.copy(effSun);
        sunLight.intensity = diurnalProfile.sunIntensity;
        sunLight.castShadow = diurnalProfile.castShadows;

        hemiLight.intensity = diurnalProfile.skyLightIntensity;
        hemiLight.color.set(diurnalProfile.isGoldenHour ? 0xfdba74 : (diurnalProfile.isNight ? 0x1a243d : 0xe0f2fe));
        hemiLight.groundColor.set(diurnalProfile.isGoldenHour ? 0x431407 : (diurnalProfile.isNight ? 0x050811 : 0x1e3a8a));
    };

    return {
        skyDome,
        sunMesh,
        hemiLight,
        sunLight,
        get sunDirection() {
            return sunDirection;
        },
        get diurnalProfile() {
            return diurnalProfile;
        },
        update: (time: number, _delta: number) => {
            uniforms.uTime.value = time;
        },
        setSunCoordinates: (elevDeg: number, azimDeg: number) => {
            applySolarState(elevDeg, azimDeg);
        },
        setTimeOfDay: (timeHours: number, lat: number = 37.77, lng: number = -122.41) => {
            const diurnalState = getDiurnalLightingState(lat, lng, timeHours);
            applySolarState(diurnalState.sunElevation, diurnalState.sunAzimuth, diurnalState);
        },
        setPreset: (preset: TimeOfDayPreset) => {
            const presetState = getPresetLightingState(preset);
            applySolarState(presetState.elevationDeg, presetState.azimuthDeg, presetState);
        },
        dispose: () => {
            scene.remove(skyDome);
            scene.remove(sunMesh);
            scene.remove(hemiLight);
            scene.remove(sunLight);
            skyGeo.dispose();
            skyMat.dispose();
            sunGeo.dispose();
            sunMat.dispose();
        }
    };
}
