/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_METAL_PATHTRACER_KERNELS_HPP
#define SCRATCHBOX_METAL_PATHTRACER_KERNELS_HPP

/**
 * Metal Shading Language source of the GPU path tracer, compiled at run time by
 * scratchbox_metal_pathtracer.hpp. It is a port of render::PathTracer::tracePath and ::shade
 * (scratchbox_pathtracer.hpp) over Metal's hardware ray intersector: same camera, same PCG32 sample
 * stream per pixel, same glTF metallic-roughness materials (bilinear texture reads with the glTF wrap
 * modes, sRGB decode for colour maps only, tangents from uv derivatives), same GGX BSDF, solar
 * next-event estimation, sky dome, haze and Russian roulette, so a GPU render and a CPU render of the
 * same geometry agree to sampling noise. Change the two together.
 *
 * The structs below are mirrored by the C++ side as plain 4-byte scalars so both agree on layout.
 * Textures are bindless: a buffer of Metal resource ids, one per decoded glTF image.
 */

#include <cstdint>

namespace scratchbox {
namespace metalpt {

struct Uniforms {
    uint32_t width{0}, height{0}, maxBounces{4}, lighting{0};  // lighting: 0 studio dome, 1 physical sun and sky
    float clampIndirect{10.0f};
    uint32_t sunVisible{0}, azimuthRes{0}, elevationRes{0};
    float camPos[3]{0, 0, 0}, tanHalf{1.0f};
    float forward[3]{0, 0, -1}, aspect{1.0f};
    float right[3]{1, 0, 0}, apertureRadius{0.0f};
    float up[3]{0, 1, 0}, focusDistance{1.0f};
    float studioRadiance[3]{1, 1, 1}, roughness{1.0f};
    float sunDir[3]{0, 1, 0}, sunCosHalfAngle{1.0f};
    float sunTangent[3]{1, 0, 0}, sunSolidAngle{0.0f};
    float sunBitangent[3]{0, 0, 1}, metallic{0.0f};
    float sunIrradiance[3]{0, 0, 0}, limbDarkening{0.6f};
    float hazeExtinction[3]{0, 0, 0}, pad0{0};
    float albedo[3]{0.5f, 0.5f, 0.5f}, pad1{0};
    uint32_t seedLo{0}, seedHi{0};
    /** 0: one uniform material (albedo, roughness, metallic above); 1: the material table and per-triangle ids. */
    uint32_t useMaterials{0};
    /** Index of the default material record, used by triangles without a glTF material. */
    uint32_t defaultMaterial{0};
};
static_assert(sizeof(Uniforms) == 4 * 56, "Uniforms must stay a flat array of 4-byte scalars");

/** Per-pixel accumulation and sample stream; one sample pass adds to it. */
struct PixelState {
    float color[3];
    float albedo[3];
    float normal[3];
    float depth;
    float lum;
    float lumSq;
    uint32_t hits;
    uint32_t rays;
    uint32_t nan;
    uint32_t pad;
    uint64_t rngState;
    uint64_t rngInc;
};
static_assert(sizeof(PixelState) == 80, "PixelState layout is shared with the Metal kernels");

struct Vertex {
    float position[3];
    float normal[3];
    float uv[2];
};
static_assert(sizeof(Vertex) == 32, "Vertex layout is shared with the acceleration structure descriptor");

/** One glTF metallic-roughness material (gltf::SceneMaterial); image fields index the texture table, -1 for none. */
struct MaterialRecord {
    float baseColor[4]{1, 1, 1, 1};
    float metallic{1.0f}, roughness{1.0f}, normalScale{1.0f}, occlusionStrength{1.0f};
    float emissive[3]{0, 0, 0};
    int32_t baseColorImage{-1};
    int32_t wrapS{10497}, wrapT{10497}, normalImage{-1}, normalWrapS{10497};
    int32_t normalWrapT{10497}, mrImage{-1}, mrWrapS{10497}, mrWrapT{10497};
    int32_t occlusionImage{-1}, pad0{0}, pad1{0}, pad2{0};
};
static_assert(sizeof(MaterialRecord) == 96, "MaterialRecord layout is shared with the Metal kernels");

inline const char* const kKernelSource = R"METAL(
#include <metal_stdlib>
#include <metal_raytracing>
using namespace metal;
using namespace metal::raytracing;

constant float kPi = 3.14159265358979323846f;
constant float kRayEpsilon = 2e-3f;
constant uint kNoMaterial = 0xFFFFFFFFu;

struct Uniforms {
    uint width, height, maxBounces, lighting;
    float clampIndirect;
    uint sunVisible, azimuthRes, elevationRes;
    float camPos[3], tanHalf;
    float forward[3], aspect;
    float right[3], apertureRadius;
    float up[3], focusDistance;
    float studioRadiance[3], roughness;
    float sunDir[3], sunCosHalfAngle;
    float sunTangent[3], sunSolidAngle;
    float sunBitangent[3], metallic;
    float sunIrradiance[3], limbDarkening;
    float hazeExtinction[3], pad0;
    float albedo[3], pad1;
    uint seedLo, seedHi, useMaterials, defaultMaterial;
};

struct PixelState {
    float color[3];
    float albedo[3];
    float normal[3];
    float depth;
    float lum;
    float lumSq;
    uint hits;
    uint rays;
    uint nan;
    uint pad;
    ulong rngState;
    ulong rngInc;
};

struct Vertex {
    float position[3];
    float normal[3];
    float uv[2];
};

struct MaterialRecord {
    float baseColor[4];
    float metallic, roughness, normalScale, occlusionStrength;
    float emissive[3];
    int baseColorImage;
    int wrapS, wrapT, normalImage, normalWrapS;
    int normalWrapT, mrImage, mrWrapS, mrWrapT;
    int occlusionImage, pad0, pad1, pad2;
};

struct TextureRef {
    texture2d<float> tex;
};

inline float3 f3(constant float* a) { return float3(a[0], a[1], a[2]); }
inline float3 f3(device const float* a) { return float3(a[0], a[1], a[2]); }
inline float2 f2(device const float* a) { return float2(a[0], a[1]); }
inline float luminance(float3 c) { return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z; }
inline float maxComponent(float3 v) { return max(v.x, max(v.y, v.z)); }
inline bool finite3(float3 v) { return isfinite(v.x) && isfinite(v.y) && isfinite(v.z); }
inline float lengthSquared(float3 v) { return dot(v, v); }

// ---- PCG32, bit-for-bit the CPU tracer's stream ----------------------------------------------
struct Pcg32 { ulong state; ulong inc; };

inline uint pcgNext(thread Pcg32& r) {
    ulong old = r.state;
    r.state = old * 6364136223846793005UL + r.inc;
    uint xorshifted = (uint)(((old >> 18) ^ old) >> 27);
    uint rot = (uint)(old >> 59);
    return (xorshifted >> rot) | (xorshifted << ((32u - rot) & 31u));
}

inline float pcgFloat(thread Pcg32& r) { return (float)(pcgNext(r) >> 8) * (1.0f / 16777216.0f); }

inline Pcg32 pcgSeed(ulong seed, ulong stream) {
    Pcg32 r;
    r.inc = (stream << 1) | 1;
    r.state = 0;
    pcgNext(r);
    r.state += seed;
    pcgNext(r);
    return r;
}

inline float tentSample(float u) {
    float r = 2.0f * u;
    return r < 1.0f ? sqrt(r) - 1.0f : 1.0f - sqrt(2.0f - r);
}

inline float2 concentricDisk(float u1, float u2) {
    float a = 2.0f * u1 - 1.0f, b = 2.0f * u2 - 1.0f;
    if (a == 0.0f && b == 0.0f) return float2(0.0f, 0.0f);
    float r, phi;
    if (abs(a) > abs(b)) { r = a; phi = (kPi / 4.0f) * (b / a); }
    else { r = b; phi = (kPi / 2.0f) - (kPi / 4.0f) * (a / b); }
    return float2(r * cos(phi), r * sin(phi));
}

inline void orthonormalBasis(float3 n, thread float3& t, thread float3& b) {
    float sign = copysign(1.0f, n.z);
    float a = -1.0f / (sign + n.z);
    float c = n.x * n.y * a;
    t = float3(1.0f + sign * n.x * n.x * a, sign * c, -sign * n.x);
    b = float3(c, sign + n.y * n.y * a, -n.y);
}

// ---- Textures (port of detail::sampleTexture: glTF wrap modes, bilinear in the decoded space) ---
inline int wrapCoordinate(int i, int n, int mode) {
    if (mode == 33071) return clamp(i, 0, n - 1);
    if (mode == 33648) {
        int period = 2 * n;
        int m = ((i % period) + period) % period;
        return m < n ? m : period - 1 - m;
    }
    return ((i % n) + n) % n;
}

inline float srgbDecode(float encoded) {
    float v = clamp(encoded, 0.0f, 1.0f);
    return v <= 0.04045f ? v / 12.92f : pow((v + 0.055f) / 1.055f, 2.4f);
}

inline float3 sampleTexture(texture2d<float> img, float2 uv, int wrapS, int wrapT, bool srgb) {
    int w = (int)img.get_width(), h = (int)img.get_height();
    if (w <= 0 || h <= 0) return float3(1.0f);
    float fx = clamp(uv.x, -1e5f, 1e5f) * (float)w - 0.5f;
    float fy = clamp(uv.y, -1e5f, 1e5f) * (float)h - 0.5f;
    if (!isfinite(fx) || !isfinite(fy)) return float3(0.0f);
    float x0f = floor(fx), y0f = floor(fy);
    float tx = fx - x0f, ty = fy - y0f;
    int x0 = (int)x0f, y0 = (int)y0f;
    int xa = wrapCoordinate(x0, w, wrapS), xb = wrapCoordinate(x0 + 1, w, wrapS);
    int ya = wrapCoordinate(y0, h, wrapT), yb = wrapCoordinate(y0 + 1, h, wrapT);
    float3 c00 = img.read(uint2(xa, ya)).rgb, c10 = img.read(uint2(xb, ya)).rgb;
    float3 c01 = img.read(uint2(xa, yb)).rgb, c11 = img.read(uint2(xb, yb)).rgb;
    if (srgb) {
        c00 = float3(srgbDecode(c00.x), srgbDecode(c00.y), srgbDecode(c00.z));
        c10 = float3(srgbDecode(c10.x), srgbDecode(c10.y), srgbDecode(c10.z));
        c01 = float3(srgbDecode(c01.x), srgbDecode(c01.y), srgbDecode(c01.z));
        c11 = float3(srgbDecode(c11.x), srgbDecode(c11.y), srgbDecode(c11.z));
    }
    float3 top = c00 * (1.0f - tx) + c10 * tx;
    float3 bottom = c01 * (1.0f - tx) + c11 * tx;
    return top * (1.0f - ty) + bottom * ty;
}

// ---- Sky (port of sky::PhysicalSky lookups) --------------------------------------------------
inline float relativeAzimuth(constant Uniforms& u, float3 d) {
    float3 sunFlat = float3(u.sunDir[0], 0.0f, u.sunDir[2]);
    float3 dirFlat = float3(d.x, 0.0f, d.z);
    if (lengthSquared(sunFlat) < 1e-10f || lengthSquared(dirFlat) < 1e-10f) return 0.0f;
    float c = clamp(dot(normalize(sunFlat), normalize(dirFlat)), -1.0f, 1.0f);
    return acos(c);
}

inline float3 skyRadiance(constant Uniforms& u, device const float* lut, float3 direction) {
    float3 d = normalize(direction);
    float elevation = asin(clamp(d.y, -1.0f, 1.0f));
    float rowF = sqrt(max(elevation, 0.0f) / (kPi * 0.5f)) * (float)u.elevationRes - 0.5f;
    float colF = relativeAzimuth(u, d) / kPi * (float)u.azimuthRes - 0.5f;
    rowF = clamp(rowF, 0.0f, (float)(u.elevationRes - 1));
    colF = clamp(colF, 0.0f, (float)(u.azimuthRes - 1));
    int r0 = (int)rowF, c0 = (int)colF;
    int r1 = min(r0 + 1, (int)u.elevationRes - 1), c1 = min(c0 + 1, (int)u.azimuthRes - 1);
    float fr = rowF - (float)r0, fc = colF - (float)c0;
    float3 a00 = f3(lut + (r0 * u.azimuthRes + c0) * 3);
    float3 a01 = f3(lut + (r0 * u.azimuthRes + c1) * 3);
    float3 a10 = f3(lut + (r1 * u.azimuthRes + c0) * 3);
    float3 a11 = f3(lut + (r1 * u.azimuthRes + c1) * 3);
    float3 top = a00 * (1.0f - fc) + a01 * fc;
    float3 bottom = a10 * (1.0f - fc) + a11 * fc;
    return top * (1.0f - fr) + bottom * fr;
}

inline float3 sunDiscRadiance(constant Uniforms& u, float3 direction) {
    float3 d = normalize(direction);
    float cosTheta = dot(d, f3(u.sunDir));
    if (cosTheta < u.sunCosHalfAngle) return float3(0.0f);
    float halfAngle = acos(u.sunCosHalfAngle);
    float theta = acos(min(cosTheta, 1.0f));
    float r = halfAngle > 0.0f ? min(theta / halfAngle, 1.0f) : 0.0f;
    float mu = sqrt(max(0.0f, 1.0f - r * r));
    float profile = (1.0f - u.limbDarkening * (1.0f - mu)) / (1.0f - u.limbDarkening / 3.0f);
    return f3(u.sunIrradiance) * (profile / u.sunSolidAngle);
}

inline float3 sampleSunDirection(constant Uniforms& u, float u1, float u2) {
    float cosTheta = 1.0f - u1 * (1.0f - u.sunCosHalfAngle);
    float sinTheta = sqrt(max(0.0f, 1.0f - cosTheta * cosTheta));
    float phi = 2.0f * kPi * u2;
    return normalize(f3(u.sunDir) * cosTheta + (f3(u.sunTangent) * cos(phi) + f3(u.sunBitangent) * sin(phi)) * sinTheta);
}

inline float3 horizonRadiance(constant Uniforms& u, device const float* lut, float3 direction) {
    float3 flat = float3(direction.x, 0.0f, direction.z);
    if (lengthSquared(flat) < 1e-8f) flat = float3(1.0f, 0.0f, 0.0f);
    return skyRadiance(u, lut, normalize(flat));
}

// ---- glTF metallic-roughness BSDF (port of detail::MetallicRoughnessBsdf) ---------------------
struct Bsdf {
    float3 n, t, b;
    float3 base;
    float3 f0;
    float3 wo;
    float metallic;
    float alpha;
    float a2;
    float specularProbability;
};

inline float3 schlickFresnel(float3 f0, float cosTheta) {
    float m = 1.0f - clamp(cosTheta, 0.0f, 1.0f);
    float m5 = m * m * m * m * m;
    return f0 + (float3(1.0f) - f0) * m5;
}

inline float ggxDistribution(float cosH, float a2) {
    float d = cosH * cosH * (a2 - 1.0f) + 1.0f;
    return a2 / (kPi * d * d);
}

inline float smithG1(float cosX, float a2) {
    return 2.0f * cosX / (cosX + sqrt(a2 + (1.0f - a2) * cosX * cosX));
}

inline float smithVisibilityCorrelated(float cosV, float cosL, float a2) {
    float gv = cosL * sqrt(cosV * cosV * (1.0f - a2) + a2);
    float gl = cosV * sqrt(cosL * cosL * (1.0f - a2) + a2);
    return 0.5f / (gv + gl);
}

inline float3 toLocal(thread const Bsdf& s, float3 v) { return float3(dot(v, s.t), dot(v, s.b), dot(v, s.n)); }
inline float3 toWorld(thread const Bsdf& s, float3 v) { return s.t * v.x + s.b * v.y + s.n * v.z; }

inline Bsdf makeBsdf(float3 shadingNormal, float3 baseColor, float metallic, float roughness, float3 woWorld) {
    Bsdf s;
    s.n = shadingNormal;
    orthonormalBasis(s.n, s.t, s.b);
    s.base = baseColor;
    s.metallic = metallic;
    float alpha = max(roughness * roughness, 0.002f);
    s.alpha = alpha;
    s.a2 = alpha * alpha;
    s.f0 = float3(0.04f) * (1.0f - metallic) + baseColor * metallic;
    s.wo = toLocal(s, woWorld);
    float cosV = max(s.wo.z, 1e-4f);
    float specularWeight = luminance(schlickFresnel(s.f0, cosV));
    float diffuseWeight = (1.0f - metallic) * luminance(baseColor);
    s.specularProbability = clamp(specularWeight / max(specularWeight + diffuseWeight, 1e-6f), 0.1f, 0.9f);
    return s;
}

inline float3 bsdfEval(thread const Bsdf& s, float3 wiWorld) {
    float3 l = toLocal(s, wiWorld);
    if (l.z <= 0.0f || s.wo.z <= 0.0f) return float3(0.0f);
    float3 h = normalize(s.wo + l);
    float3 f = schlickFresnel(s.f0, max(dot(s.wo, h), 0.0f));
    float3 specular = f * (ggxDistribution(h.z, s.a2) * smithVisibilityCorrelated(s.wo.z, l.z, s.a2));
    float3 diffuse = s.base * ((1.0f - s.metallic) / kPi) * (float3(1.0f) - f);
    return diffuse + specular;
}

inline float bsdfPdf(thread const Bsdf& s, float3 wiWorld) {
    float3 l = toLocal(s, wiWorld);
    if (l.z <= 0.0f || s.wo.z <= 0.0f) return 0.0f;
    float3 h = normalize(s.wo + l);
    float specularPdf = smithG1(s.wo.z, s.a2) * ggxDistribution(h.z, s.a2) / (4.0f * s.wo.z);
    float diffusePdf = l.z / kPi;
    return s.specularProbability * specularPdf + (1.0f - s.specularProbability) * diffusePdf;
}

inline float3 sampleVisibleNormal(thread const Bsdf& s, float u1, float u2) {
    float3 vh = normalize(float3(s.alpha * s.wo.x, s.alpha * s.wo.y, s.wo.z));
    float lensq = vh.x * vh.x + vh.y * vh.y;
    float3 t1 = lensq > 0.0f ? float3(-vh.y, vh.x, 0.0f) / sqrt(lensq) : float3(1.0f, 0.0f, 0.0f);
    float3 t2 = cross(vh, t1);
    float r = sqrt(u1);
    float phi = 2.0f * kPi * u2;
    float p1 = r * cos(phi);
    float p2 = r * sin(phi);
    float sv = 0.5f * (1.0f + vh.z);
    p2 = (1.0f - sv) * sqrt(max(0.0f, 1.0f - p1 * p1)) + sv * p2;
    float3 nh = t1 * p1 + t2 * p2 + vh * sqrt(max(0.0f, 1.0f - p1 * p1 - p2 * p2));
    return normalize(float3(s.alpha * nh.x, s.alpha * nh.y, max(1e-6f, nh.z)));
}

inline bool bsdfSample(thread const Bsdf& s, thread Pcg32& rng, thread float3& wiWorld, thread float3& weight) {
    if (s.wo.z <= 0.0f) return false;
    float choice = pcgFloat(rng);
    float u1 = pcgFloat(rng);
    float u2 = pcgFloat(rng);
    float3 l;
    if (choice < s.specularProbability) {
        float3 h = sampleVisibleNormal(s, u1, u2);
        l = h * (2.0f * dot(s.wo, h)) - s.wo;
    } else {
        float r = sqrt(u1), phi = 2.0f * kPi * u2;
        l = float3(r * cos(phi), r * sin(phi), sqrt(max(0.0f, 1.0f - u1)));
    }
    if (l.z <= 0.0f) return false;
    wiWorld = toWorld(s, l);
    float p = bsdfPdf(s, wiWorld);
    if (p <= 1e-8f) return false;
    weight = bsdfEval(s, wiWorld) * (l.z / p);
    return finite3(weight);
}

// ---- Surface (port of PathTracer::shade) -----------------------------------------------------
struct Surface {
    float3 position;
    float3 geometricNormal;
    float3 shadingNormal;
    float3 baseColor;
    float3 emission;
    float metallic;
    float roughness;
};

inline Surface shade(constant Uniforms& u, device const Vertex* verts, device const uint* idx, device const uint* triMaterials,
                     device const MaterialRecord* materials, device const TextureRef* textures,
                     uint tri, float2 bary, float3 origin, float3 dir, float t) {
    uint i0 = idx[tri * 3], i1 = idx[tri * 3 + 1], i2 = idx[tri * 3 + 2];
    float3 p0 = f3(verts[i0].position), p1 = f3(verts[i1].position), p2 = f3(verts[i2].position);
    float3 n0 = f3(verts[i0].normal), n1 = f3(verts[i1].normal), n2 = f3(verts[i2].normal);
    float bu = bary.x, bv = bary.y, bw = 1.0f - bu - bv;
    Surface s;
    s.position = origin + dir * t;
    float3 interpolated = normalize(n0 * bw + n1 * bu + n2 * bv);
    float3 ng = normalize(cross(p1 - p0, p2 - p0));
    if (!(lengthSquared(ng) >= 0.5f)) ng = interpolated;
    s.geometricNormal = ng;
    s.shadingNormal = lengthSquared(interpolated) > 0.5f ? interpolated : ng;
    s.emission = float3(0.0f);
    if (u.useMaterials == 0u) {
        s.baseColor = f3(u.albedo);
        s.metallic = u.metallic;
        s.roughness = u.roughness;
    } else {
        uint matId = triMaterials[tri];
        if (matId == kNoMaterial) matId = u.defaultMaterial;
        device const MaterialRecord& m = materials[matId];
        float2 uv0 = f2(verts[i0].uv), uv1 = f2(verts[i1].uv), uv2 = f2(verts[i2].uv);
        float2 uv = uv0 * bw + uv1 * bu + uv2 * bv;
        float3 base = float3(m.baseColor[0], m.baseColor[1], m.baseColor[2]);
        if (m.baseColorImage >= 0) base = base * sampleTexture(textures[m.baseColorImage].tex, uv, m.wrapS, m.wrapT, true);
        s.metallic = clamp(m.metallic, 0.0f, 1.0f);
        s.roughness = clamp(m.roughness, 0.02f, 1.0f);
        s.emission = f3(m.emissive);
        if (m.mrImage >= 0) {
            float3 mr = sampleTexture(textures[m.mrImage].tex, uv, m.mrWrapS, m.mrWrapT, false);
            s.roughness = clamp(s.roughness * mr.y, 0.02f, 1.0f);
            s.metallic = clamp(s.metallic * mr.z, 0.0f, 1.0f);
        }
        if (m.occlusionImage >= 0) {
            float3 occ = sampleTexture(textures[m.occlusionImage].tex, uv, 10497, 10497, false);
            float ao = 1.0f + m.occlusionStrength * (occ.x - 1.0f);
            base = base * clamp(ao, 0.05f, 1.0f);
        }
        if (m.normalImage >= 0) {
            float3 ns = sampleTexture(textures[m.normalImage].tex, uv, m.normalWrapS, m.normalWrapT, false);
            float3 tanNormal = normalize(float3((2.0f * ns.x - 1.0f) * m.normalScale, (2.0f * ns.y - 1.0f) * m.normalScale, 2.0f * ns.z - 1.0f));
            float3 N = s.shadingNormal;
            // The cut carries no tangents: derive one from the uv derivatives, as the CPU tracer does.
            float3 dp1 = p1 - p0, dp2 = p2 - p0;
            float2 duv1 = uv1 - uv0, duv2 = uv2 - uv0;
            float det = duv1.x * duv2.y - duv2.x * duv1.y;
            float3 T;
            if (abs(det) > 1e-7f) T = normalize((dp1 * duv2.y - dp2 * duv1.y) * (1.0f / det));
            else T = normalize(cross(abs(N.y) < 0.99f ? float3(0.0f, 1.0f, 0.0f) : float3(1.0f, 0.0f, 0.0f), N));
            T = normalize(T - N * dot(N, T));
            if (lengthSquared(T) > 0.5f) {
                float3 B = cross(N, T);
                s.shadingNormal = normalize(T * tanNormal.x + B * tanNormal.y + N * tanNormal.z);
            }
        }
        s.baseColor = base;
    }
    float3 wo = -dir;
    if (dot(s.geometricNormal, wo) < 0.0f) s.geometricNormal = -s.geometricNormal;
    if (dot(s.shadingNormal, s.geometricNormal) < 0.0f) s.shadingNormal = -s.shadingNormal;
    if (dot(s.shadingNormal, wo) <= 1e-4f) s.shadingNormal = s.geometricNormal;
    return s;
}

inline void accumulate(thread float3& radiance, float3 contribution, uint bounce, float clampIndirect) {
    if (bounce >= 1 && clampIndirect > 0.0f) {
        float l = luminance(contribution);
        if (l > clampIndirect) contribution = contribution * (clampIndirect / l);
    }
    radiance += contribution;
}

struct PathResult {
    float3 radiance;
    float3 albedo;
    float3 normal;
    float depth;
    bool hitGeometry;
};

inline PathResult tracePath(float3 origin, float3 dir, thread Pcg32& rng, constant Uniforms& u,
                            device const Vertex* verts, device const uint* idx, device const float* lut,
                            primitive_acceleration_structure accel, device const uint* triMaterials,
                            device const MaterialRecord* materials, device const TextureRef* textures, thread uint& rays) {
    PathResult result;
    result.radiance = float3(0.0f);
    result.albedo = float3(0.0f);
    result.normal = float3(0.0f);
    result.depth = 0.0f;
    result.hitGeometry = false;
    float3 radiance = float3(0.0f);
    float3 throughput = float3(1.0f);
    const bool sky = u.lighting == 1u;

    intersector<triangle_data> closest;
    closest.assume_geometry_type(geometry_type::triangle);
    closest.force_opacity(forced_opacity::opaque);
    intersector<triangle_data> any;
    any.assume_geometry_type(geometry_type::triangle);
    any.force_opacity(forced_opacity::opaque);
    any.accept_any_intersection(true);

    for (uint bounce = 0;; ++bounce) {
        ++rays;
        ray r(origin, dir, 1e-4f, 1e9f);
        intersection_result<triangle_data> hit = closest.intersect(r, accel);
        if (hit.type == intersection_type::none) {
            float3 skyLight = sky ? skyRadiance(u, lut, dir) : f3(u.studioRadiance);
            if (sky && bounce == 0) skyLight += sunDiscRadiance(u, dir);
            accumulate(radiance, throughput * skyLight, bounce, u.clampIndirect);
            break;
        }
        Surface surface = shade(u, verts, idx, triMaterials, materials, textures, hit.primitive_id, hit.triangle_barycentric_coord, origin, dir, hit.distance);
        if (bounce == 0) {
            result.hitGeometry = true;
            result.albedo = surface.baseColor;
            result.normal = surface.shadingNormal;
            result.depth = hit.distance;
        }
        if (sky) {
            float3 opticalDepth = f3(u.hazeExtinction) * hit.distance;
            float3 transmittance = float3(exp(-opticalDepth.x), exp(-opticalDepth.y), exp(-opticalDepth.z));
            accumulate(radiance, throughput * (horizonRadiance(u, lut, dir) * (float3(1.0f) - transmittance)), bounce, u.clampIndirect);
            throughput = throughput * transmittance;
        }
        radiance += throughput * surface.emission;

        const float3 wo = -dir;
        Bsdf bsdf = makeBsdf(surface.shadingNormal, surface.baseColor, surface.metallic, surface.roughness, wo);
        if (sky && u.sunVisible != 0u) {
            float s1 = pcgFloat(rng);
            float s2 = pcgFloat(rng);
            float3 wi = sampleSunDirection(u, s1, s2);
            float cosShading = dot(surface.shadingNormal, wi);
            if (cosShading > 0.0f && dot(surface.geometricNormal, wi) > 0.0f) {
                ++rays;
                ray shadow(surface.position + surface.geometricNormal * kRayEpsilon, wi, 1e-4f, 1e9f);
                intersection_result<triangle_data> blocker = any.intersect(shadow, accel);
                if (blocker.type == intersection_type::none) {
                    accumulate(radiance, throughput * bsdfEval(bsdf, wi) * f3(u.sunIrradiance) * cosShading, bounce, u.clampIndirect);
                }
            }
        }

        if (bounce >= u.maxBounces) break;
        float3 wi, weight;
        if (!bsdfSample(bsdf, rng, wi, weight) || dot(surface.geometricNormal, wi) <= 0.0f) break;
        throughput = throughput * weight;
        if (bounce >= 2) {
            float q = min(0.95f, maxComponent(throughput));
            if (q <= 0.0f || pcgFloat(rng) > q) break;
            throughput = throughput / q;
        }
        origin = surface.position + surface.geometricNormal * kRayEpsilon;
        dir = wi;
    }
    result.radiance = radiance;
    return result;
}

kernel void pt_init(device PixelState* pixels [[buffer(0)]], constant Uniforms& u [[buffer(1)]],
                    uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= u.width || gid.y >= u.height) return;
    uint pixel = gid.y * u.width + gid.x;
    ulong seed = ((ulong)u.seedHi << 32) | (ulong)u.seedLo;
    Pcg32 rng = pcgSeed(seed, (ulong)pixel);
    PixelState p;
    for (int i = 0; i < 3; ++i) { p.color[i] = 0.0f; p.albedo[i] = 0.0f; p.normal[i] = 0.0f; }
    p.depth = 0.0f; p.lum = 0.0f; p.lumSq = 0.0f;
    p.hits = 0u; p.rays = 0u; p.nan = 0u; p.pad = 0u;
    p.rngState = rng.state;
    p.rngInc = rng.inc;
    pixels[pixel] = p;
}

kernel void pt_sample(device PixelState* pixels [[buffer(0)]], constant Uniforms& u [[buffer(1)]],
                      device const Vertex* verts [[buffer(2)]], device const uint* idx [[buffer(3)]],
                      device const float* lut [[buffer(4)]], primitive_acceleration_structure accel [[buffer(5)]],
                      device const uint* triMaterials [[buffer(6)]], device const MaterialRecord* materials [[buffer(7)]],
                      device const TextureRef* textures [[buffer(8)]],
                      uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= u.width || gid.y >= u.height) return;
    uint pixel = gid.y * u.width + gid.x;
    device PixelState* p = pixels + pixel;
    Pcg32 rng;
    rng.state = p->rngState;
    rng.inc = p->rngInc;

    const float3 camPos = f3(u.camPos), forward = f3(u.forward), right = f3(u.right), upv = f3(u.up);
    float sx = ((float)gid.x + 0.5f + tentSample(pcgFloat(rng))) / (float)u.width;
    float sy = ((float)gid.y + 0.5f + tentSample(pcgFloat(rng))) / (float)u.height;
    float3 dir = normalize(forward + right * ((2.0f * sx - 1.0f) * u.tanHalf * u.aspect) + upv * ((1.0f - 2.0f * sy) * u.tanHalf));
    float3 origin = camPos;
    if (u.apertureRadius > 0.0f) {
        float l1 = pcgFloat(rng);
        float l2 = pcgFloat(rng);
        float2 lens = concentricDisk(l1, l2);
        float3 focusPoint = camPos + dir * (u.focusDistance / max(dot(dir, forward), 1e-4f));
        origin = camPos + (right * lens.x + upv * lens.y) * u.apertureRadius;
        dir = normalize(focusPoint - origin);
    }
    uint rays = 0u;
    PathResult s = tracePath(origin, dir, rng, u, verts, idx, lut, accel, triMaterials, materials, textures, rays);
    p->rays += rays;
    p->rngState = rng.state;
    p->rngInc = rng.inc;
    if (!finite3(s.radiance)) {
        p->nan += 1u;
        return;
    }
    p->color[0] += s.radiance.x; p->color[1] += s.radiance.y; p->color[2] += s.radiance.z;
    float l = luminance(s.radiance);
    p->lum += l;
    p->lumSq += l * l;
    if (s.hitGeometry) {
        p->hits += 1u;
        p->albedo[0] += s.albedo.x; p->albedo[1] += s.albedo.y; p->albedo[2] += s.albedo.z;
        p->normal[0] += s.normal.x; p->normal[1] += s.normal.y; p->normal[2] += s.normal.z;
        p->depth += s.depth;
    }
}
)METAL";

} // namespace metalpt
} // namespace scratchbox

#endif // SCRATCHBOX_METAL_PATHTRACER_KERNELS_HPP
