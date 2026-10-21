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
    AtmosphericScatteringConfig,
    AtmosphericSkyDomeModule,
    DiurnalLightingProfile,
    TimeOfDayPreset
} from './atmosphere-types';
import { kelvinToRGB } from './kelvin';
import {
    computeDiurnalLightingProfile,
    getDiurnalLightingState,
    skyLightColorHex,
    getPresetLightingState
} from './diurnal-lighting';
import { getSunVectorFromAngles } from './solar-position';
import { buildPhysicalSkyLut } from './physical-sky';
import { SunGlare } from './SunGlare';
import { cloudShellUniformArrays, cloudShellWindSpeeds, MAX_CLOUD_SHELL_LAYERS, resolveCloudShellLayers } from './cloud-shell-layers';
import { InvalidInputError, MissingInputError } from '../../../../common/errors/pipeline-errors';

export const ATMOSPHERE_VERTEX_SHADER = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vNormal;

void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    // the view direction from the dome's own centre (the dome follows the camera), not from the scene origin
    vWorldPosition = worldPosition.xyz - (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
`;

/** Cube-map face size the sky is baked at (texels per 90°: ~0.09° per texel). */
export const SKY_BAKE_RESOLUTION = 1024;
/** While clouds drift, how often (seconds of scene time) the bake starts another one-face-per-frame refresh. */
export const SKY_REFRESH_SECONDS = 0.5;

/** The visible dome: the baked sky looked up by view direction, then the renderer's tone mapping and colour space. */
export const SKY_CUBE_DISPLAY_FRAGMENT_SHADER = /* glsl */ `
uniform samplerCube uSkyCube;
varying vec3 vWorldPosition;
void main() {
    gl_FragColor = vec4(textureCube(uSkyCube, normalize(vWorldPosition)).rgb, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
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

// Physical sky (physical-sky.ts): radiance over (azimuth from the sun / pi, sqrt(elevation / 90°)), scaled so its
// light on a level surface equals the scene's sky light. uPhysicalSkyWeight fades to the night palette below -6°.
uniform sampler2D uSkyLut;
uniform float uSkyScale;
uniform float uPhysicalSkyWeight;

// Shell cloud decks (CloudShellLayer), highest first. A: base, thickness, coverage, optical depth.
// B: feature size, elongation, heading (rad), HG g. C: albedo rgb, shell count.
#define MAX_CLOUD_SHELL_LAYERS 4
uniform int uShellLayerCount;
uniform vec4 uShellA[MAX_CLOUD_SHELL_LAYERS];
uniform vec4 uShellB[MAX_CLOUD_SHELL_LAYERS];
uniform vec4 uShellC[MAX_CLOUD_SHELL_LAYERS];
uniform float uShellWind[MAX_CLOUD_SHELL_LAYERS];

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

    vec4 j = p - 49.0 * floor(p * ns.z * ns.z); // mod(p, 49); the missing ns.z blew snoise up to ~1e5

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
// Sine-free hash (Hoskins): fract(sin(x) * 43758) loses its precision on GPUs once the cloud coordinates reach the
// thousands, collapsing whole regions of cells to one value (a smooth dome and lens-shaped blobs in the cumulus).
vec3 hash33(vec3 p) {
    vec3 p3 = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
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

// Cheap 2D value-noise fBm for the shell decks (sine-free hash, quintic fade, rotated octaves), in [0, 1] with mean 0.5.
// Each shell samples it once or twice per pixel, so it must stay far cheaper than the 3D simplex used by the cumulus.
float shellHash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float shellValueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    return mix(mix(shellHash(i), shellHash(i + vec2(1.0, 0.0)), u.x),
               mix(shellHash(i + vec2(0.0, 1.0)), shellHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float shellFbm(vec2 p, float octaves) {
    const mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    float sum = 0.0, amp = 0.5, norm = 0.0;
    for (int o = 0; o < 6; o++) {
        float w = clamp(octaves - float(o), 0.0, 1.0);
        sum += amp * w * shellValueNoise(p);
        norm += amp * w;
        p = rot * p * 2.03 + vec2(17.1, 9.7);
        amp *= 0.5;
    }
    return sum / max(norm, 1e-4);
}


#define CUMULUS_THICKNESS 1800.0
// Inverse CDF of perlinWorley3D, measured on the GPU: 0-90% in 10% steps, then 95%, and the tail to 100%.
float perlinWorleyQuantile(float q) {
    q = clamp(q, 0.0, 1.0);
    if (q >= 0.95) return mix(0.6705, 0.80, (q - 0.95) / 0.05);
    if (q >= 0.9) return mix(0.6301, 0.6705, (q - 0.9) / 0.05);
    float x = q * 10.0;
    int i = int(min(floor(x), 8.0));
    float f = x - float(i);
    float a = 0.0759, b = 0.3328;
    if (i == 1) { a = 0.3328; b = 0.3828; } else if (i == 2) { a = 0.3828; b = 0.4198; } else if (i == 3) { a = 0.4198; b = 0.4516; }
    else if (i == 4) { a = 0.4516; b = 0.4815; } else if (i == 5) { a = 0.4815; b = 0.5115; } else if (i == 6) { a = 0.5115; b = 0.5435; }
    else if (i == 7) { a = 0.5435; b = 0.5803; } else if (i == 8) { a = 0.5803; b = 0.6301; }
    return mix(a, b, f);
}
float remapClamped(float v, float l0, float h0, float l1, float h1) {
    return clamp(l1 + (v - l0) * (h1 - l1) / max(h0 - l0, 1e-4), min(l1, h1), max(l1, h1));
}
// Cumulus density at world point p (metres from the observer); h is the normalised height in the layer.
// detail 0-1: the erosion's weight (fades with distance, where it would only alias; 0 for the light march).
float cumulusDensity(vec3 p, float detail, float ramp, out float h) {
    float alt = length(p + vec3(0.0, 6371000.0, 0.0)) - 6371000.0;
    h = (alt - uCloudAltitude) / CUMULUS_THICKNESS;
    if (h <= 0.0 || h >= 1.0) return 0.0;
    vec3 drift = vec3(uTime * 8.0, 0.0, uTime * 3.0);
    vec3 w = p + drift;
    // Coverage -> threshold through the base noise's measured quantiles, so cloudCoverage is the cloud fraction of
    // the layer. Weather (fields ~6 km across) shifts the threshold so the sky is patchy; the threshold rises with
    // height so towers narrow and close at the top.
    float weather = fBm3D(vec3(w.x * 0.00016, h * 0.6, w.z * 0.00016));
    float baseThreshold = perlinWorleyQuantile(1.0 - uCloudCoverage) - (weather - 0.5) * 0.6;
    float topThreshold = perlinWorleyQuantile(1.0 - uCloudCoverage * 0.12) + 0.06;
    float threshold = mix(baseThreshold, topThreshold, smoothstep(0.1, 1.0, h));
    float base = perlinWorley3D(vec3(w.x, w.y * 1.6, w.z) * 0.0006, uTime);
    // ramp: the shape's edge width, crisp close by and wider far away (cumulusEdgeRamp), so distant cloud merges into
    // a soft bank instead of speckling along the horizon. The light march passes the view sample's ramp.
    float shape = remapClamped(base, threshold, threshold + ramp, 0.0, 1.0) * smoothstep(0.0, 0.04, h);
    if (detail <= 0.0 || shape <= 0.0) return shape;
    // Erosion: wispy (worley) at the base, billowy (inverted worley: cauliflower puffs) toward the tops.
    float wf = worley3D(w * 0.0035) * 0.625 + worley3D(w * 0.0081) * 0.25 + worley3D(w * 0.017) * 0.125;
    float erode = mix(wf, 1.0 - wf, smoothstep(0.1, 0.6, h));
    return remapClamped(shape, erode * 0.55 * detail, 1.0, 0.0, 1.0);
}

// Composites the shell cloud decks over the sky colour, back to front. Each shell is a sphere concentric with the Earth,
// so a deck converges on the horizon instead of running to infinity. A shell's radiance is single scattering of the
// sun that reaches it through the deck above (Beer-Lambert, two-lobe Henyey-Greenstein phase), the diffuse sunlight a
// two-stream slab passes on, (1 / (1 + 0.75 (1 - g) tau) - direct), and the sky light around it.
// Shapes are domain-warped fBm with an eroding detail octave; where a feature shrinks toward a pixel (the view ray's
// angular footprint times distance, over the feature size) the detail and then the shapes fade to the mean coverage.
vec3 compositeCloudShells(vec3 sky, vec3 rayDir, float cosViewSun, vec3 ambient) {
    if (uShellLayerCount <= 0 || rayDir.y < -0.01) return sky;
    float sunMu = max(uSunDirection.y, 0.03);
    vec3 sunIrradiance = uSunColor * uSunIntensity;
    vec3 cloudAmbient = mix(ambient, vec3(dot(ambient, vec3(0.2126, 0.7152, 0.0722))), 0.5);
    // Angle one pixel spans; smooth across the dome's triangles, unlike derivatives of the projected coordinates.
    float pixelAngle = length(fwidth(rayDir));
    for (int L = 0; L < MAX_CLOUD_SHELL_LAYERS; L++) {
        if (L >= uShellLayerCount) break;
        vec4 A = uShellA[L];
        vec4 B = uShellB[L];
        vec4 C = uShellC[L];
        float shells = C.w;
        float g = B.w;
        float phase = mix(henyeyGreenstein(cosViewSun, g), henyeyGreenstein(cosViewSun, -0.2), 0.25);
        vec2 along = vec2(sin(B.z), cos(B.z));
        vec2 across = vec2(cos(B.z), -sin(B.z));
        float threshold = mix(0.72, 0.28, A.z);
        for (int s = 7; s >= 0; s--) {
            if (float(s) >= shells) continue;
            float f = (float(s) + 0.5) / shells;
            float h = A.x + A.y * f;
            float t = getAtmosphereDistance(rayDir, h);
            vec3 p = rayDir * t;
            vec3 n = normalize(p + vec3(0.0, 6371000.0, 0.0));
            float mu = max(dot(rayDir, n), 0.02);
            vec2 en = vec2(p.x, -p.z);
            vec2 q = vec2(dot(en, along) - uShellWind[L] * uTime, dot(en, across)) / vec2(B.x * B.y, B.x);
            float footprint = pixelAngle * t / (mu * B.x);
            vec2 seed = vec2(float(L) * 37.1 + f * 3.3, float(L) * 11.7 - f * 5.9);
            // Octaves finer than ~2 pixels are dropped (footprint is in feature units; each octave halves the size).
            float octaves = clamp(log2(0.5 / max(footprint, 1e-4)) + 1.0, 1.0, 6.0);
            vec2 warp = vec2(shellFbm(q * 0.5 + seed, 3.0), shellFbm(q * 0.5 + seed.yx + 5.2, 3.0)) - 0.5;
            float shape = shellFbm(q + warp * 1.2 + seed, octaves);
            float detail = shellFbm(q * 3.7 + warp * 2.0 + seed + 3.0, octaves - 2.0);
            float erosion = mix(mix(0.45, 1.0, smoothstep(0.3, 0.7, detail)), 1.0, smoothstep(0.08, 0.3, footprint));
            // Density starts at the threshold (no faint veil below it, which slant views near the horizon turned into cloud).
            float density = smoothstep(threshold, threshold + 0.25, shape) * erosion;
            density = mix(density, A.z, smoothstep(0.25, 1.0, footprint));
            if (density <= 0.001) continue;
            float trans = exp(-A.w / shells * density / mu);
            float tauAbove = A.w * density * (1.0 - f);
            float direct = exp(-tauAbove / sunMu);
            float diffuseTrans = 1.0 / (1.0 + 0.75 * (1.0 - g) * tauAbove);
            float diffuse = max(0.0, diffuseTrans - direct);
            // The dome's sky colours are display-referred, about pi brighter than radiometric radiance next to the sun
            // term, so diffuse light carries E mu_s (not E mu_s / pi) to sit on the same scale as the sky behind it.
            // Sky light inside the deck is as attenuated as the sun's diffuse part and loses most of its blue.
            vec3 inscatter = C.rgb * (sunIrradiance * (direct * phase + diffuse * sunMu) + cloudAmbient * diffuseTrans);
            vec3 lit = sky * trans + (1.0 - trans) * inscatter;
            // Distant shells fade into the sky behind them (aerial perspective, ~150 km e-folding).
            sky = mix(lit, sky, 1.0 - exp(-t / 150000.0));
        }
    }
    return sky;
}

vec3 physicalSkyRadiance(vec3 dir) {
    vec2 flatSun = uSunDirection.xz;
    vec2 flatDir = dir.xz;
    float relAz = (length(flatSun) > 1e-4 && length(flatDir) > 1e-4) ? acos(clamp(dot(normalize(flatSun), normalize(flatDir)), -1.0, 1.0)) : 1.5707963;
    float el = asin(clamp(dir.y, 0.0, 1.0));
    vec2 uv = vec2(relAz / 3.14159265, sqrt(el / 1.5707963));
    return texture2D(uSkyLut, uv).rgb * uSkyScale;
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
    // The palette was authored as display colours (the dome used to skip tone mapping); convert to scene-referred
    // values that display the same through ACES: sRGB to linear, over ACES's slope near black (~0.172).
    zenithColor = pow(max(zenithColor, 0.0), vec3(2.2)) / 0.172;
    horizonColor = pow(max(horizonColor, 0.0), vec3(2.2)) / 0.172;
    vec3 skyColor = mix(zenithColor, horizonColor, skyGradient);

    // Physical sky: replaces the palette (and its zenith/horizon colours, which light the clouds) while the sun is
    // within 6° below the horizon; deeper night keeps the palette.
    if (uPhysicalSkyWeight > 0.0) {
        vec3 side = normalize(vec3(-uSunDirection.z, 0.0, uSunDirection.x) + vec3(1e-4, 0.0, 0.0));
        zenithColor = mix(zenithColor, physicalSkyRadiance(vec3(0.0, 1.0, 0.0)), uPhysicalSkyWeight);
        horizonColor = mix(horizonColor, physicalSkyRadiance(normalize(side + vec3(0.0, 0.05, 0.0))), uPhysicalSkyWeight);
        skyColor = mix(skyColor, physicalSkyRadiance(rayDir), uPhysicalSkyWeight);
    }

    // Low-sun directional horizon glow (the physical sky has its own)
    if (uPhysicalSkyWeight < 1.0 && sunH > -0.05 && sunH < 0.28) {
        float sunGlow = pow(max(0.0, cosViewSun), 6.0) * pow(1.0 - max(0.0, upFactor), 2.0);
        skyColor += uSunColor * sunGlow * 0.4;
    }

    // --- 2. EXACT SINGLE PHYSICAL SUN ---
    float sunVisibility = smoothstep(-0.06, 0.02, sunH);

    if (!uIsNight && sunVisibility > 0.0) {
        // Solar disc: 0.267° angular radius (0.53° across), with a 0.05° anti-aliased edge. (It was cos 0.99988, a 0.89°
        // radius with a soft edge to 1.56°: a disc over three times the sun's size.)
        float sunDisc = smoothstep(cos(radians(0.267 + 0.05)), cos(radians(0.267)), cosViewSun);

        // Forward Mie scattering solar corona aureole
        float miePhase = henyeyGreenstein(cosViewSun, uMieDirectionalG);
        float softGlare = pow(max(0.0, cosViewSun), 128.0) * 1.2 + pow(max(0.0, cosViewSun), 16.0) * 0.25;

        vec3 directSunRadiance = uSunColor * uSunIntensity * sunVisibility;
        // The physical sky already holds the aureole; the palette sky draws its own glare.
        float glare = (softGlare + miePhase * uMieCoefficient * 25.0) * (1.0 - uPhysicalSkyWeight);
        vec3 physicalSun = (sunDisc * 12.0 + glare) * directSunRadiance;

        skyColor += physicalSun;
    }

    // --- 2b. SHELL CLOUD DECKS (behind the volumetric layer; they dim the sun disc they cross) ---
    skyColor = compositeCloudShells(skyColor, rayDir, cosViewSun, mix(zenithColor, horizonColor, 0.5) * 0.9);

    // --- 3. VOLUMETRIC CUMULUS ---
    // Raymarched cumulus layer (after Schneider's Nubis): a weather field decides where cloud fields form, a cumulus
    // height profile (flat base, rounded taper) on the curved Earth shapes them, worley detail erodes the edges.
    // Light: a short march toward the sun (Beer-Lambert), Wrenninge's multiple-scattering octaves over a two-lobe
    // phase, and the physical sky's light from above. Energy-conserving step integration; distant cloud fades into haze.
    if (uCloudCoverage > 0.01 && rayDir.y > 0.01) {
        float tStart = getAtmosphereDistance(rayDir, uCloudAltitude);
        float tEnd = min(getAtmosphereDistance(rayDir, uCloudAltitude + CUMULUS_THICKNESS), tStart + 30000.0);
        if (tStart < 90000.0) {
            // About one step per 40 m of path (32-80 steps, affordable since the sky is baked; double steps through clear air), jittered per pixel by interleaved gradient noise so
            // the steps do not show as striations.
            float pathLen = tEnd - tStart;
            int steps = int(clamp(pathLen / 40.0, 32.0, 80.0));
            float dt = pathLen / float(steps);
            float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
            float t = tStart + dt * ign;
            // Extinction: 0.25/m at density 1, 0.11/m at the default 0.45 (cumulus: 1.5 LWC / (rho_w r_eff) with
            // 0.5-1 g/m^3 of liquid water in ~10 um droplets gives 0.05-0.15/m).
            float sigmaT = 0.25 * uCloudDensity;
            vec3 sunE = uSunColor * uSunIntensity * smoothstep(-0.02, 0.04, uSunDirection.y);
            vec3 L = vec3(0.0);
            float T = 1.0;
            bool skipped = false;
            // Back-ups after a skipped stride use iterations but not steps, so the loop has headroom.
            for (int i = 0; i < 112; i++) {
                if (t > tEnd) break;
                vec3 p = rayDir * t;
                float h;
                float detailW = 1.0 - smoothstep(8000.0, 25000.0, t);
                float ramp = mix(0.25, 0.07, detailW);
                float d = cumulusDensity(p, detailW, ramp, h);
                if (d > 0.002 && skipped) {
                    // A double stride landed inside cloud: back up half of it once so the cloud's edge is not stepped over.
                    skipped = false;
                    t -= dt;
                    continue;
                }
                if (d > 0.002) {
                    // Optical depth toward the sun over ~3.8 km (6 doubling steps, shape only): deep enough that a
                    // backlit cloud's core goes dark while its thin rim stays bright.
                    float od = 0.0, ls = 60.0, lt = 0.0;
                    for (int k = 0; k < 6; k++) {
                        lt += ls;
                        float hh;
                        od += cumulusDensity(p + uSunDirection * lt, 0.0, ramp, hh) * ls;
                        ls *= 2.0;
                    }
                    // Direct beam (single scattering, two-lobe phase) plus the multiply scattered light that diffuses
                    // through the cloud (two-stream transmission, isotropic re-scatter; gain 3 makes a deep cloud
                    // reflect ~80% of the sun like a white surface, as sunlit cumulus does).
                    float tauSun = sigmaT * od;
                    float ph = mix(henyeyGreenstein(cosViewSun, 0.8), henyeyGreenstein(cosViewSun, -0.3), 0.3);
                    float diffuseT = 1.0 / (1.0 + 0.75 * (1.0 - 0.85) * tauSun);
                    // Multiply scattered light keeps part of the droplets' forward bias (Wrenninge: g halves per octave),
                    // but only near the sunlit surface: a few optical depths in, the light has scattered many times and
                    // is isotropic, so a thick backlit cloud is dark with a bright thin rim.
                    float forwardBias = 0.5 * exp(-tauSun / 8.0);
                    float msPhase = mix(1.0, henyeyGreenstein(cosViewSun, 0.4) * 12.566371, forwardBias);
                    vec3 sunL = sunE * (exp(-tauSun) * ph + diffuseT * msPhase * 3.0 / 12.566371);
                    // Sky light: the zenith's on the tops, the darker horizon/ground light under the base.
                    // A cloud sees the sky, other cloud and the ground, so its ambient light is half desaturated.
                    vec3 skyAmb = mix(horizonColor * 0.5, zenithColor * 1.2, h);
                    vec3 ambient = mix(skyAmb, vec3(dot(skyAmb, vec3(0.2126, 0.7152, 0.0722))), 0.5) * mix(0.6, 1.0, diffuseT);
                    float sT = sigmaT * d;
                    vec3 S = sT * (sunL + ambient);
                    float stepT = exp(-sT * dt);
                    L += T * (S - S * stepT) / max(sT, 1e-6);
                    T *= stepT;
                    if (T < 0.01) break;
                    t += dt;
                } else {
                    // Clear air: stride twice as far until cloud is met.
                    t += dt * 2.0;
                    skipped = true;
                }
            }
            vec3 clouded = skyColor * T + L;
            // Aerial perspective: distant cloud sinks into the haze (e-folding 25 km), forming a soft horizon bank.
            skyColor = mix(clouded, skyColor, 1.0 - exp(-tStart / 25000.0));
        }
    }

    gl_FragColor = vec4(skyColor, 1.0);
    // Scene-referred like every other material: the renderer's tone mapping and output colour space apply here too.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}
`;

/**
 * Instantiates the complete physical Atmospheric Scattering Sky Dome,
 * solar directional lighting, hemisphere bounce light, and dynamic time-of-day solver.
 */
/** latitude/longitude for a time-of-day sun; a typed error when either is missing (no assumed location). */
export function requireLocation(tool: string, latitude: number | undefined, longitude: number | undefined): [number, number] {
    if (typeof latitude !== 'number' || !Number.isFinite(latitude) || typeof longitude !== 'number' || !Number.isFinite(longitude)) {
        throw new MissingInputError(tool, 'latitude and longitude', 'a time of day only places the sun at a location; give one, or give sunElevation/sunAzimuth');
    }
    return [latitude, longitude];
}

/**
 * The hemisphere light's ground colour by day: light bounced off the ground, the profile's ground albedo times the
 * irradiance reaching the ground (the sun on a level surface plus the sky) relative to the sky light the hemisphere is
 * scaled by. A navy ground colour (the old daytime value) lit every wall from below in blue and left clay scenes dark.
 * Golden hour and night keep their own tints.
 */
export function groundBounceColor(profile: { isGoldenHour: boolean; isNight: boolean; sunIntensity: number; skyLightIntensity: number; groundAlbedoLinear?: number[] }, elevationDeg: number): THREE.Color {
    if (profile.isGoldenHour) return new THREE.Color(0x431407);
    if (profile.isNight) return new THREE.Color(0x050811);
    const albedo = profile.groundAlbedoLinear ?? [0.18, 0.18, 0.18];
    const level = Math.max(0, Math.sin((elevationDeg * Math.PI) / 180));
    const gain = (profile.sunIntensity * level + profile.skyLightIntensity) / Math.max(1e-3, profile.skyLightIntensity);
    return new THREE.Color().setRGB(Math.min(1, albedo[0] * gain), Math.min(1, albedo[1] * gain), Math.min(1, albedo[2] * gain), THREE.LinearSRGBColorSpace);
}

/**
 * The direct sun's colour. A `kelvinTemperature` in the config is a chosen colour and keeps the phase-tinted blackbody;
 * otherwise, while the disc is up, it is the profile's spectral beam (blackbody sun through Rayleigh, aerosol and ozone).
 * After sunset the phase tint stands in for the sky light that is left.
 */
export function directSunColor(profile: DiurnalLightingProfile, config: AtmosphericScatteringConfig, warm: boolean): THREE.Color {
    if (config.kelvinTemperature === undefined && profile.sunIlluminanceLux !== undefined && profile.sunLinearRgb) {
        const [r, g, b] = profile.sunLinearRgb;
        return new THREE.Color().setRGB(r, g, b, THREE.LinearSRGBColorSpace);
    }
    const kelvin = config.kelvinTemperature || (warm ? 3200 : (profile.isNight ? 12000 : 6500));
    const tint = new THREE.Color(
        profile.isGoldenHour
            ? '#ffb355'
            : profile.isTwilight
            ? '#5c7ab3'
            : profile.isNight
            ? '#1a243d'
            : '#fffdf0'
    );
    return tint.multiply(kelvinToRGB(kelvin));
}

/**
 * Sky cover seen from the ground (15-85° up) for each plan coverage of the cumulus layer, measured on this renderer
 * (suns 25/45/65°, four cloud positions; sd <= 0.06). Cloud sides fill sky, so a little plan cover shows as a lot.
 */
const CUMULUS_SKY_COVER: Array<[number, number]> = [
    [0, 0], [0.01, 0.032], [0.025, 0.235], [0.05, 0.392], [0.075, 0.452], [0.1, 0.512], [0.15, 0.586], [0.2, 0.657],
    [0.3, 0.757], [0.4, 0.829], [0.5, 0.873], [0.6, 0.908], [0.7, 0.938], [0.8, 0.963], [0.9, 0.984], [1, 1]
];

/** Plan coverage of the cumulus layer that shows as `skyCover` of the sky (the measured table, inverted). */
export function layerCoverageForSkyCover(skyCover: number): number {
    const f = Math.min(1, Math.max(0, skyCover));
    for (let i = 1; i < CUMULUS_SKY_COVER.length; i++) {
        const [l0, f0] = CUMULUS_SKY_COVER[i - 1], [l1, f1] = CUMULUS_SKY_COVER[i];
        if (f <= f1) return l0 + ((l1 - l0) * (f - f0)) / Math.max(1e-9, f1 - f0);
    }
    return 1;
}

export function createAtmosphericSkyDome(
    scene: THREE.Scene,
    isSunset: boolean = false,
    config: AtmosphericScatteringConfig = {},
    options: { sphereRadius?: number; distanceOffset?: number; bakeResolution?: number } = {}
): AtmosphericSkyDomeModule {
    const radius = options.sphereRadius || 280;

    // Resolve initial solar elevation / azimuth
    // A time of day only fixes the sun at a place: it is used with the config's latitude/longitude, never an assumed one.
    const timedSun = config.timeOfDay !== undefined && (config.sunElevation === undefined || config.sunAzimuth === undefined) && !isSunset
        ? getDiurnalLightingState(...requireLocation('createAtmosphericSkyDome', config.latitude, config.longitude), config.timeOfDay, { turbidity: config.turbidity })
        : undefined;
    let initialElev = config.sunElevation !== undefined
        ? config.sunElevation
        : (isSunset ? 4.5 : (timedSun ? timedSun.sunElevation : 52.0));
    let initialAzim = config.sunAzimuth !== undefined
        ? config.sunAzimuth
        : (isSunset ? 260.0 : (timedSun ? timedSun.sunAzimuth : 180.0));

    // The lighting assumes the same cloud cover the dome draws.
    const beamOptions = { turbidity: config.turbidity, cloudCoverage: config.cloudCoverage ?? (config.volumetricClouds === true ? 0.35 : 0) };
    let diurnalProfile = timedSun ?? computeDiurnalLightingProfile(initialElev, beamOptions);
    let sunDirection = getSunVectorFromAngles(initialElev, initialAzim);
    const effectiveSunColor = directSunColor(diurnalProfile, config, isSunset);

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

        // Zero Default Clouds: Only render clouds if explicitly enabled or coverage is passed
        // cloudCoverage is the sky cover an observer sees; the layer's own (plan) coverage is lower because cloud
        // sides fill sky too (measured table, layerCoverageForSkyCover).
        uCloudCoverage: { value: layerCoverageForSkyCover(config.cloudCoverage ?? (config.volumetricClouds === true ? 0.35 : 0.0)) },
        uCloudDensity: { value: config.cloudDensity ?? (config.volumetricClouds === true ? 0.45 : 0.0) },
        uCloudAltitude: { value: config.cloudAltitude ?? 1200.0 },
        uTime: { value: 0.0 },

        uShellLayerCount: { value: 0 },
        uShellA: { value: Array.from({ length: MAX_CLOUD_SHELL_LAYERS }, () => new THREE.Vector4()) },
        uShellB: { value: Array.from({ length: MAX_CLOUD_SHELL_LAYERS }, () => new THREE.Vector4()) },
        uShellC: { value: Array.from({ length: MAX_CLOUD_SHELL_LAYERS }, () => new THREE.Vector4()) },
        uShellWind: { value: new Array<number>(MAX_CLOUD_SHELL_LAYERS).fill(0) },

        uIsNight: { value: diurnalProfile.isNight },
        uIsGoldenHour: { value: diurnalProfile.isGoldenHour || isSunset },
        uIsTwilight: { value: diurnalProfile.isTwilight },

        uSkyLut: { value: null as THREE.DataTexture | null },
        uSkyScale: { value: 0 },
        uPhysicalSkyWeight: { value: 0 }
    };

    // The physical sky for the current sun, scaled so the dome lights a level surface as the scene's sky light does.
    let skyLutTexture: THREE.DataTexture | undefined;
    const applyPhysicalSky = (elevDeg: number) => {
        const weight = THREE.MathUtils.smoothstep(elevDeg, -10, -6);
        uniforms.uPhysicalSkyWeight.value = weight;
        if (weight <= 0) return;
        const lut = buildPhysicalSkyLut({ sunElevationDeg: elevDeg, turbidity: config.turbidity ?? diurnalProfile.turbidity ?? 2 });
        const W = lut.azimuthResolution, H = lut.elevationResolution;
        const rgba = new Float32Array(W * H * 4);
        for (let i = 0; i < W * H; i++) { rgba[i * 4] = lut.data[i * 3]; rgba[i * 4 + 1] = lut.data[i * 3 + 1]; rgba[i * 4 + 2] = lut.data[i * 3 + 2]; rgba[i * 4 + 3] = 1; }
        if (!skyLutTexture || skyLutTexture.image.width !== W || skyLutTexture.image.height !== H) {
            skyLutTexture?.dispose();
            skyLutTexture = new THREE.DataTexture(rgba, W, H, THREE.RGBAFormat, THREE.FloatType);
            skyLutTexture.magFilter = THREE.LinearFilter;
            skyLutTexture.minFilter = THREE.LinearFilter;
            skyLutTexture.wrapS = THREE.ClampToEdgeWrapping;
            skyLutTexture.wrapT = THREE.ClampToEdgeWrapping;
        } else {
            (skyLutTexture.image.data as Float32Array).set(rgba);
        }
        skyLutTexture.needsUpdate = true;
        uniforms.uSkyLut.value = skyLutTexture;
        const e = lut.horizontalIrradiance;
        const skyLightLevel = diurnalProfile.skyLightIntensity * hemiLight.color.r * 0.2126 + diurnalProfile.skyLightIntensity * hemiLight.color.g * 0.7152 + diurnalProfile.skyLightIntensity * hemiLight.color.b * 0.0722;
        uniforms.uSkyScale.value = skyLightLevel / Math.max(1e-12, 0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2]);
    };

    const applyCloudLayers = (layers: unknown) => {
        const resolved = resolveCloudShellLayers(layers, 'createAtmosphericSkyDome');
        const packed = cloudShellUniformArrays(resolved);
        uniforms.uShellLayerCount.value = packed.count;
        packed.a.forEach((v, i) => uniforms.uShellA.value[i].fromArray(v));
        packed.b.forEach((v, i) => uniforms.uShellB.value[i].fromArray(v));
        packed.c.forEach((v, i) => uniforms.uShellC.value[i].fromArray(v));
        uniforms.uShellWind.value = cloudShellWindSpeeds(resolved);
    };
    applyCloudLayers(config.cloudLayers);

    const skyGeo = new THREE.SphereGeometry(radius, 32, 24);
    const skyMat = new THREE.ShaderMaterial({
        vertexShader: ATMOSPHERE_VERTEX_SHADER,
        fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
        uniforms,
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true
    });

    // The sky is a function of view direction only, so the expensive shader (physical sky, clouds) is baked into a cube
    // map off-screen and the visible dome just looks it up. It re-bakes in full when any input changes (uniforms are
    // compared each frame, so direct uniform writes count), and while clouds drift it refreshes a strip per frame.
    const bakeScene = new THREE.Scene();
    const bakeDome = new THREE.Mesh(skyGeo, skyMat);
    bakeDome.frustumCulled = false;
    bakeScene.add(bakeDome);
    const bakeSize = Math.max(64, Math.round(options.bakeResolution ?? SKY_BAKE_RESOLUTION));
    const bakeTarget = new THREE.WebGLCubeRenderTarget(bakeSize, { type: THREE.HalfFloatType, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const bakeCamera = new THREE.CubeCamera(1, radius * 4, bakeTarget);
    let disposed = false;
    bakeScene.add(bakeCamera);
    const displayMat = new THREE.ShaderMaterial({
        vertexShader: ATMOSPHERE_VERTEX_SHADER,
        fragmentShader: SKY_CUBE_DISPLAY_FRAGMENT_SHADER,
        uniforms: { uSkyCube: { value: bakeTarget.texture } },
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: true
    });
    const skyDome = new THREE.Mesh(skyGeo, displayMat);
    skyDome.name = 'AtmosphericSkyDome';
    skyDome.renderOrder = -1000;
    scene.add(skyDome);

    let bakedSignature = '';
    let bakedTime = -Infinity;
    let refreshFace = -1;
    const uniformSignature = () => {
        const parts: string[] = [];
        for (const [name, u] of Object.entries(uniforms as Record<string, { value: unknown }>)) {
            if (name === 'uTime') continue;
            const v = u.value as any;
            if (v && typeof v === 'object' && 'isTexture' in v) parts.push(`${name}:${v.uuid}:${v.version}`);
            else if (Array.isArray(v)) parts.push(`${name}:${v.map((x: any) => (x && x.toArray ? x.toArray().join(',') : String(x))).join(';')}`);
            else if (v && typeof v === 'object' && typeof v.toArray === 'function') parts.push(`${name}:${v.toArray().join(',')}`);
            else parts.push(`${name}:${String(v)}`);
        }
        return parts.join('|');
    };
    // Clouds and wind-driven decks move with uTime; a clear sky does not.
    const skyMoves = () => uniforms.uCloudCoverage.value > 0.0 || (uniforms.uShellWind.value as number[]).some((w, i) => i < uniforms.uShellLayerCount.value && w !== 0);
    // A refresh while clouds drift goes one strip (an eighth of a face) per frame, so no frame carries a whole face.
    const STRIPS = 8;
    const savedScissor = new THREE.Vector4();
    const renderFace = (renderer: THREE.WebGLRenderer, face: number, strip = -1) => {
        if (bakeCamera.coordinateSystem !== renderer.coordinateSystem) {
            bakeCamera.coordinateSystem = renderer.coordinateSystem;
            bakeCamera.updateCoordinateSystem();
        }
        const target = renderer.getRenderTarget(), activeFace = renderer.getActiveCubeFace(), level = renderer.getActiveMipmapLevel();
        const xr = renderer.xr.enabled, scissorTest = renderer.getScissorTest();
        renderer.getScissor(savedScissor);
        renderer.xr.enabled = false;
        renderer.setRenderTarget(bakeTarget, face);
        if (strip >= 0) {
            const h = Math.ceil(bakeSize / STRIPS);
            bakeTarget.scissor.set(0, strip * h, bakeSize, h);
            bakeTarget.scissorTest = true;
            renderer.setRenderTarget(bakeTarget, face);
        }
        renderer.render(bakeScene, bakeCamera.children[face] as THREE.Camera);
        if (strip >= 0) {
            bakeTarget.scissorTest = false;
            bakeTarget.scissor.set(0, 0, bakeSize, bakeSize);
        }
        renderer.setRenderTarget(target, activeFace, level);
        renderer.setScissor(savedScissor);
        renderer.setScissorTest(scissorTest);
        renderer.xr.enabled = xr;
    };
    skyDome.onBeforeRender = (renderer) => {
        const signature = uniformSignature();
        if (signature !== bakedSignature) {
            // Inputs changed: the whole sky at once, so no frame shows a mix of old and new.
            for (let face = 0; face < 6; face++) renderFace(renderer as THREE.WebGLRenderer, face);
            bakedSignature = signature;
            bakedTime = uniforms.uTime.value;
            refreshFace = -1;
            return;
        }
        if (refreshFace < 0 && skyMoves() && Math.abs(uniforms.uTime.value - bakedTime) >= SKY_REFRESH_SECONDS) {
            refreshFace = 0;
            bakedTime = uniforms.uTime.value;
        }
        if (refreshFace >= 0) {
            // refreshFace counts strips: face = floor(n / STRIPS), strip = n % STRIPS
            renderFace(renderer as THREE.WebGLRenderer, Math.floor(refreshFace / STRIPS), refreshFace % STRIPS);
            refreshFace = refreshFace === 6 * STRIPS - 1 ? -1 : refreshFace + 1;
        }
    };

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
    // The dome's shader draws the disc; this mesh stays as the sun's position marker (read by the viewport) but is
    // not drawn: at display brightness it showed as a grey dot in the middle of the sun.
    sunMesh.visible = false;
    scene.add(sunMesh);

    // Veiling glare round the sun (SunGlare.ts): measured strength 1 by default whenever this atmosphere has a sun.
    const glareStrength = config.sunGlare ?? 1;
    if (!(Number.isFinite(glareStrength) && glareStrength >= 0)) {
        throw new InvalidInputError('createAtmosphericSkyDome', `sunGlare ${glareStrength}`, 'must be a number >= 0 (1 is the measured camera/eye glare, 0 none)');
    }
    const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const sunGlare: SunGlare = new SunGlare({
        sunDirection: () => sunDirection,
        sunIrradiance: () => sunLight.color.clone().multiplyScalar(sunLight.intensity),
        sunElevationDeg: () => initialElev,
        skyCube: () => bakeTarget.texture,
        // the disc term the dome's shader adds before cloud: 12 x the sun's colour x intensity (smoothstep visibility at the horizon)
        clearDiscLuminance: () => 12 * lum(uniforms.uSunColor.value as THREE.Color) * uniforms.uSunIntensity.value * THREE.MathUtils.smoothstep(sunDirection.y, -0.06, 0.02),
        skyObjects: (): THREE.Object3D[] => [skyDome, sunMesh, sunGlare.mesh]
    }, glareStrength);
    scene.add(sunGlare.mesh);

    // Dynamic Hemisphere Sky & Ground Ambient Bounce Light
    const hemiLight = new THREE.HemisphereLight(
        skyLightColorHex(diurnalProfile),
        groundBounceColor(diurnalProfile, initialElev),
        diurnalProfile.skyLightIntensity
    );
    hemiLight.name = 'AtmosphericHemisphereLight';
    scene.add(hemiLight);
    applyPhysicalSky(initialElev);

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
        diurnalProfile = customProfile || computeDiurnalLightingProfile(elevDeg, beamOptions);
        sunDirection = getSunVectorFromAngles(elevDeg, azimDeg);
        const effSun = directSunColor(diurnalProfile, config, diurnalProfile.isGoldenHour);

        uniforms.uSunDirection.value.copy(sunDirection);
        uniforms.uSunColor.value.copy(effSun);
        uniforms.uSunIntensity.value = diurnalProfile.sunIntensity;
        uniforms.uIsNight.value = diurnalProfile.isNight;
        uniforms.uIsGoldenHour.value = diurnalProfile.isGoldenHour;
        uniforms.uIsTwilight.value = diurnalProfile.isTwilight;

        sunMesh.position.copy(sunDirection).multiplyScalar(sunDistance);
        (sunMesh.material as THREE.MeshBasicMaterial).color.copy(effSun);
        (sunMesh.material as THREE.MeshBasicMaterial).opacity = diurnalProfile.isNight ? 0.0 : 0.95;

        // the light's own position along the sun direction (the disc may sit around the camera; see followCamera)
        sunLight.position.copy(sunDirection).multiplyScalar(sunDistance);
        sunLight.color.copy(effSun);
        sunLight.intensity = diurnalProfile.sunIntensity;
        sunLight.castShadow = diurnalProfile.castShadows;

        hemiLight.intensity = diurnalProfile.skyLightIntensity;
        hemiLight.color.set(skyLightColorHex(diurnalProfile));
        hemiLight.groundColor.copy(groundBounceColor(diurnalProfile, elevDeg));
        applyPhysicalSky(elevDeg);
    };

    return {
        skyDome,
        skyMaterial: skyMat,
        sunMesh,
        hemiLight,
        sunLight,
        get sunDirection() {
            return sunDirection;
        },
        sunGlare,
        get diurnalProfile() {
            return diurnalProfile;
        },
        update: (time: number, _delta: number) => {
            uniforms.uTime.value = time;
        },
        followCamera: (camera: THREE.Camera) => {
            const far = (camera as THREE.PerspectiveCamera).far;
            const scale = Number.isFinite(far) && far > 0 ? (far * 0.9) / radius : 1;
            skyDome.position.copy(camera.position);
            skyDome.scale.setScalar(scale);
            sunMesh.position.copy(camera.position).addScaledVector(sunDirection, sunDistance * scale);
            sunMesh.scale.setScalar(scale);
        },
        setSunCoordinates: (elevDeg: number, azimDeg: number) => {
            applySolarState(elevDeg, azimDeg);
        },
        setTimeOfDay: (timeHours: number, lat: number, lng: number) => {
            const diurnalState = getDiurnalLightingState(...requireLocation('setTimeOfDay', lat, lng), timeHours, beamOptions);
            applySolarState(diurnalState.sunElevation, diurnalState.sunAzimuth, diurnalState);
        },
        setPreset: (preset: TimeOfDayPreset) => {
            const presetState = getPresetLightingState(preset, beamOptions);
            applySolarState(presetState.elevationDeg, presetState.azimuthDeg, presetState);
        },
        setCloudLayers: (layers) => applyCloudLayers(layers),
        dispose: () => {
            if (disposed) return;
            disposed = true;
            scene.remove(skyDome);
            scene.remove(sunMesh);
            scene.remove(hemiLight);
            scene.remove(sunLight);
            scene.remove(sunGlare.mesh);
            sunGlare.dispose();
            skyGeo.dispose();
            skyMat.dispose();
            displayMat.dispose();
            // three's WebGLCubeRenderTarget dispose reads the renderer's per-face framebuffers, which do not exist
            // when the dome goes before its first bake (a scene closed at once) or after the renderer was disposed;
            // it then throws "Cannot read properties of undefined (reading '0')" out of a React cleanup
            try {
                bakeTarget.dispose();
            } catch {
                bakeTarget.texture.dispose();
            }
            skyLutTexture?.dispose();
            sunGeo.dispose();
            sunMat.dispose();
        }
    };
}
