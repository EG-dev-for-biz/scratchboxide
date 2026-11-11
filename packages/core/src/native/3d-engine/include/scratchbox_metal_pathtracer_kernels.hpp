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
 * next-event estimation, sky dome, haze and Russian roulette, and the scene lights' next-event estimation
 * with its light tree and power-heuristic weights (scratchbox_light_tree.hpp, ported below), so a GPU render
 * and a CPU render of the same geometry agree to sampling noise. Change the two together.
 *
 * The structs below are mirrored by the C++ side as plain 4-byte scalars so both agree on layout.
 * Textures are bindless: a buffer of Metal resource ids, one per decoded glTF image.
 */

#include <algorithm>
#include <cstdint>
#include <vector>

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
    float hazeExtinction[3]{0, 0, 0}, hazeScaleHeight{0};
    float albedo[3]{0.5f, 0.5f, 0.5f}, hazeBaseY{0};
    uint32_t seedLo{0}, seedHi{0};
    /** 0: one uniform material (albedo, roughness, metallic above); 1: the material table and per-triangle ids. */
    uint32_t useMaterials{0};
    /** Index of the default material record, used by triangles without a glTF material. */
    uint32_t defaultMaterial{0};
    /** 1: bounce and shadow rays trace the coarser bounce geometry (buffers 9-11) instead of the primary cut. */
    uint32_t useBounceAccel{0};
    /** World error of the bounce cut per unit of distance (threshold px / lod scale): rays start that far from the surface. */
    float bounceErrorPerDistance{0.0f};
    /** 0: PCG32 per pixel (the CPU tracer's stream); 1: per-pixel Owen-scrambled Halton. */
    uint32_t sampler{0};
    /** 1: the first hit comes from the visibility texture (rasterized triangle id) when the jittered ray still meets that triangle. */
    uint32_t usePrimaryRaster{0};
    /** With useBounceAccel: 1 traces shadow rays against the bounce geometry too, 0 keeps them on the primary cut. */
    uint32_t bounceShadowRays{1};
    /**
     * Sky lighting at the first hit from a per-pixel ReSTIR reservoir (buffers 14-15) instead of the BSDF path:
     * 1 keeps the reservoir across the frame's passes (temporal reuse), 2 starts it fresh every pass.
     */
    uint32_t restir{0};
    /** Sky directions proposed per pixel per pass, and neighbours combined by the spatial pass. */
    uint32_t restirCandidates{8}, restirSpatial{3};
    /**
     * 1: one sky sample per first hit is drawn from the pixel's visibility histogram (buffer 18: 32 equal-area
     * world-space bins of shadow-ray outcomes, learned over the passes) and combined with the BSDF ray by MIS.
     */
    uint32_t guided{0};
    /** Pixels per side of the tile that shares one histogram (1: per pixel). */
    uint32_t guideTile{8};
    /** Histogram resolution: bands of equal solid angle in elevation times sectors of azimuth (at most kGuideMaxBins). */
    uint32_t guideBands{4}, guideSectors{8};
    /** Guided sky samples per first hit (multi-sample MIS against the one BSDF ray). */
    uint32_t guideSamples{1};
    /**
     * 1: ReSTIR GI (buffers 20-21): everything a path gathers past its first hit becomes a sample (the second
     * hit with its outgoing radiance), resampled with `giSpatial` neighbours' samples from the previous pass.
     */
    uint32_t restirGi{0}, giSpatial{3};
    uint32_t pad13{0};
    /**
     * The scene's lights (render::lights::LightSet, buffers 22-24): local lights in the tree, then distant ones.
     * The emissive triangles are those of the geometry bounce rays trace (the bounce cut when there is one).
     */
    uint32_t localLights{0}, distantLights{0};
    /** 1 when some material is alpha-masked: closest-hit and shadow rays then test the cut-out (intersection queries). */
    uint32_t alphaTested{0};
    uint32_t pad15{0};
};
static_assert(sizeof(Uniforms) == 4 * 76, "Uniforms must stay a flat array of 4-byte scalars");

/** A ReSTIR GI sample: a path's second hit (or escape direction) with the radiance it sent back to the first hit. */
struct GiSample {
    float x1[3], depth;      // the first hit it was gathered for
    float n1[3];
    uint32_t flags;          // bit 0 valid, bit 1 escaped (x2 is a direction)
    float x2[3], pdf;        // second hit (or direction) and its solid-angle pdf at x1
    float n2[3], pad;
    float radiance[3], pad2; // outgoing radiance from x2 toward x1 (clamped as the path clamps indirect light)
};
static_assert(sizeof(GiSample) == 80, "GiSample layout is shared with the kernels");
constexpr uint32_t kGuideMaxBins = 1024;

/** One pixel's ReSTIR reservoir over sky directions: the chosen direction, its target value and the resampling weights. */
struct Reservoir {
    float dir[3];
    float wSum;
    float W;
    float pHat;
    uint32_t M;
    uint32_t pad;
};
static_assert(sizeof(Reservoir) == 32, "Reservoir layout is shared with the kernels");

/** The first hit of a pixel's latest sample, kept so the spatial pass can re-evaluate a neighbour's direction here. */
struct PrimarySurface {
    float position[3], depth;
    float shadingNormal[3], metallic;
    float baseColor[3], roughness;
    float geometricNormal[3];
    uint32_t valid;
};
static_assert(sizeof(PrimarySurface) == 64, "PrimarySurface layout is shared with the kernels");

/**
 * Sobol direction vectors (32 words per dimension, first digit in the high bit) for `dims` dimensions:
 * dimension 0 is the van der Corput sequence, the rest come from Joe and Kuo's primitive polynomials and
 * initial values (new-joe-kuo-6.21201), of which the first 31 are kept here.
 */
inline std::vector<uint32_t> sobolDirectionVectors(uint32_t dims) {
    struct Dim { uint32_t s, a; uint32_t m[8]; };
    static const Dim table[] = {
        {1, 0, {1}}, {2, 1, {1, 3}}, {3, 1, {1, 3, 1}}, {3, 2, {1, 1, 1}}, {4, 1, {1, 1, 3, 3}}, {4, 4, {1, 3, 5, 13}},
        {5, 2, {1, 1, 5, 5, 17}}, {5, 4, {1, 1, 5, 5, 5}}, {5, 7, {1, 1, 7, 11, 19}}, {5, 11, {1, 1, 5, 1, 1}}, {5, 13, {1, 1, 1, 3, 11}},
        {5, 14, {1, 3, 5, 5, 31}}, {6, 1, {1, 3, 3, 9, 7, 49}}, {6, 13, {1, 1, 1, 15, 21, 21}}, {6, 16, {1, 3, 1, 13, 27, 49}},
        {6, 19, {1, 1, 1, 15, 7, 5}}, {6, 22, {1, 3, 1, 15, 13, 25}}, {6, 25, {1, 1, 5, 5, 19, 61}}, {7, 1, {1, 3, 7, 11, 23, 15, 103}},
        {7, 4, {1, 3, 7, 13, 13, 15, 69}}, {7, 7, {1, 1, 3, 13, 7, 35, 63}}, {7, 8, {1, 1, 5, 9, 1, 25, 53}}, {7, 14, {1, 1, 1, 13, 9, 35, 107}},
        {7, 19, {1, 1, 1, 5, 27, 61, 31}}, {7, 21, {1, 1, 5, 11, 19, 41, 61}}, {7, 28, {1, 1, 5, 3, 3, 13, 69}}, {7, 31, {1, 1, 7, 13, 25, 41, 43}},
        {7, 32, {1, 1, 3, 7, 5, 37, 29}}, {7, 37, {1, 1, 7, 7, 13, 17, 65}}, {7, 41, {1, 3, 5, 1, 9, 61, 59}}, {7, 42, {1, 1, 7, 7, 21, 35, 57}}
    };
    const uint32_t available = 1 + static_cast<uint32_t>(sizeof(table) / sizeof(table[0]));
    dims = std::min(dims, available);
    std::vector<uint32_t> out(static_cast<size_t>(dims) * 32, 0);
    for (uint32_t k = 0; k < 32; ++k) out[k] = 1u << (31 - k);
    for (uint32_t d = 1; d < dims; ++d) {
        const Dim& t = table[d - 1];
        uint32_t* v = out.data() + static_cast<size_t>(d) * 32;
        for (uint32_t i = 0; i < 32; ++i) {
            if (i < t.s) {
                v[i] = t.m[i] << (31 - i);
            } else {
                uint32_t x = v[i - t.s] ^ (v[i - t.s] >> t.s);
                for (uint32_t k = 1; k < t.s; ++k) {
                    if ((t.a >> (t.s - 1 - k)) & 1u) x ^= v[i - k];
                }
                v[i] = x;
            }
        }
    }
    return out;
}

/** Camera for the visibility pass: the same basis as Uniforms plus the depth range. */
struct RasterUniforms {
    float camPos[3], tanHalf;
    float forward[3], aspect;
    float right[3], near;
    float up[3], far;
};
static_assert(sizeof(RasterUniforms) == 4 * 16, "RasterUniforms must stay a flat array of 4-byte scalars");

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
    int32_t occlusionImage{-1}, emissiveImage{-1}, emissiveWrapS{10497}, emissiveWrapT{10497};
    /** glTF alphaMode MASK (1) and its cutoff: the surface is there where baseColor.w times the texture's alpha reaches it. */
    float alphaCutoff{0.5f};
    int32_t alphaMask{0}, pad3{0}, pad4{0};
};
static_assert(sizeof(MaterialRecord) == 112, "MaterialRecord layout is shared with the Metal kernels");

/** What pt_display reads: the frame's size and samples, whether to show the denoised colour, and the exposure scale. */
struct DisplayUniforms {
    uint32_t width{0}, height{0}, spp{1}, fromDenoised{0};
    float scale{1.0f}, pad0{0}, pad1{0}, pad2{0};
};
static_assert(sizeof(DisplayUniforms) == 32, "DisplayUniforms layout is shared with the Metal kernels");

/** Denoiser settings and the two views temporal reuse reprojects between (mirrors denoise::DenoiseSettings). */
struct DenoiseUniforms {
    uint32_t width{0}, height{0}, spp{1}, step{1};
    float sigmaNormal{128.0f}, sigmaDepth{1.0f}, sigmaLuminance{4.0f}, albedoFloor{1e-3f};
    /** 1 when the history buffer holds a previous view to reproject from. */
    uint32_t useHistory{0}, historyCap{32}, prevWidth{0}, prevHeight{0};
    float camPos[3]{0, 0, 0}, tanHalf{1.0f};
    float forward[3]{0, 0, -1}, aspect{1.0f};
    float right[3]{1, 0, 0}, pad0{0};
    float up[3]{0, 1, 0}, pad1{0};
    float prevCamPos[3]{0, 0, 0}, prevTanHalf{1.0f};
    float prevForward[3]{0, 0, -1}, prevAspect{1.0f};
    float prevRight[3]{1, 0, 0}, pad2{0};
    float prevUp[3]{0, 1, 0}, pad3{0};
};
static_assert(sizeof(DenoiseUniforms) == 4 * 44, "DenoiseUniforms must stay a flat array of 4-byte scalars");

/** Demodulated illumination and guides of one pixel, the a-trous working set. */
struct DenoisePixel {
    float illum[3];
    float variance;
    float normal[3];
    float depth;
    float gradX, gradY;
    uint32_t mask, pad;
};
static_assert(sizeof(DenoisePixel) == 48, "DenoisePixel layout is shared with the Metal kernels");

/** What a view leaves for the next one: its combined illumination, how many samples it stands for, and where it was. */
struct HistoryPixel {
    float illum[3];
    float samples;
    float normal[3];
    float depth;
};
static_assert(sizeof(HistoryPixel) == 32, "HistoryPixel layout is shared with the Metal kernels");

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
    float hazeExtinction[3], hazeScaleHeight;
    float albedo[3], hazeBaseY;
    uint seedLo, seedHi, useMaterials, defaultMaterial;
    uint useBounceAccel;
    float bounceErrorPerDistance;
    uint sampler, usePrimaryRaster;
    uint bounceShadowRays, restir, restirCandidates, restirSpatial;
    uint guided, guideTile, guideBands, guideSectors;
    uint guideSamples, restirGi, giSpatial, pad13;
    uint localLights, distantLights, alphaTested, pad15;
};

struct GiSample {
    float x1[3], depth;
    float n1[3];
    uint flags;
    float x2[3], pdf;
    float n2[3], pad;
    float radiance[3], pad2;
};

struct RasterUniforms {
    float camPos[3], tanHalf;
    float forward[3], aspect;
    float right[3], nearZ;
    float up[3], farZ;
};

struct Reservoir {
    float dir[3];
    float wSum;
    float W;
    float pHat;
    uint M;
    uint pad;
};

struct PrimarySurface {
    float position[3], depth;
    float shadingNormal[3], metallic;
    float baseColor[3], roughness;
    float geometricNormal[3];
    uint valid;
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
    int occlusionImage, emissiveImage, emissiveWrapS, emissiveWrapT;
    float alphaCutoff;
    int alphaMask, pad3, pad4;
};

// ---- Scene lights (port of scratchbox_light_tree.hpp) -------------------------------------------
constant uint kNoLight = 0xFFFFFFFFu;
constant uint kTriangleLight = 0u;
constant uint kPointLight = 1u;

struct LightRecord {
    float p0[3];
    uint kind;
    float e1[3];
    float area;
    float e2[3];
    uint triangle;
    float intensity[3];
    float energy;
    float range, cosInner, cosOuter;
    uint leaf;
};

struct LightNode {
    float bmin[3];
    float energy;
    float bmax[3];
    float thetaO;
    float axis[3];
    float thetaE;
    int child0, child1, parent;
    uint pad;
};

/** The light tables a path samples, with the per-triangle light of the geometry bounce rays trace. */
struct Lights {
    device const LightRecord* records;
    device const LightNode* nodes;
    device const uint* triangleLight;
    uint localCount, distantCount;
};

struct TextureRef {
    texture2d<float> tex;
};

inline float3 f3(constant float* a) { return float3(a[0], a[1], a[2]); }
inline float3 f3(device const float* a) { return float3(a[0], a[1], a[2]); }
inline float3 f3(thread const float* a) { return float3(a[0], a[1], a[2]); }
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

// ---- Sample stream: PCG32 (the CPU tracer's) or per-pixel scrambled Halton -------------------------
struct PassUniforms {
    uint sampleIndex, sobolDims, pad1, pad2;
};

constant uint kPrimes[40] = {2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53, 59, 61, 67, 71,
                             73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173};

inline uint hashU32(uint x) {
    x ^= x >> 16; x *= 0x7feb352du; x ^= x >> 15; x *= 0x846ca68bu; x ^= x >> 16;
    return x;
}

/**
 * Nested uniform scramble (Burley 2020) of an index whose first radical-inverse digit is the low bit:
 * every multiplier is even or applied as a plain multiply, so each step is a bijection and bit i only
 * ever depends on bits below it, which is what makes it an Owen scramble in base 2.
 */
inline uint owenScramble2(uint x, uint seed) {
    x ^= x * 0x3d20adeau;
    x += seed;
    x *= (seed >> 16) | 1u;
    x ^= x * 0x05526c56u;
    x ^= x * 0x53a22864u;
    return x;
}

/**
 * Radical inverse of `index` in base `b` with Owen (nested) scrambling: each digit's permutation is
 * drawn from the scrambled digits before it, so the first samples of a high base are stratified
 * rather than a shifted lattice. Digits past the index are random, which jitters within the stratum.
 */
inline float scrambledRadicalInverse(uint index, uint b, uint seed) {
    const float invBase = 1.0f / (float)b;
    float invBaseN = 1.0f, result = 0.0f;
    uint prefix = seed;
    uint n = index;
    for (uint digitIndex = 0u; digitIndex < 24u && invBaseN > 1e-8f; ++digitIndex) {
        uint digit = n % b;
        uint perm = hashU32(prefix ^ (digitIndex * 0x9e3779b9u)) % b;
        uint scrambled = (digit + perm) % b;
        invBaseN *= invBase;
        result += (float)scrambled * invBaseN;
        prefix = hashU32(prefix ^ ((scrambled + 1u) * 0x85ebca6bu));
        n /= b;
    }
    return min(result, 0.99999994f);
}

struct Sampler {
    uint mode;        // 0 pcg, 1 owen-scrambled sobol
    Pcg32 rng;
    uint index;       // sample index of this pixel
    uint dim;         // next sobol dimension
    uint pixelHash;
    device const uint* sobol; // direction vectors, 32 per dimension
    uint sobolDims;
};

/**
 * Mode 1: Owen-scrambled Sobol. Each dimension has its own direction matrix (Joe-Kuo, uploaded as 32
 * words per dimension), so no dimension is a function of another, and a per-pixel, per-dimension
 * nested scramble decorrelates pixels. Past the table's dimensions the stream falls back to PCG32.
 * (Measured on the way here: Halton with higher primes is worse below 64 samples, and base-2 radical
 * inverses with independent scrambles per dimension stall, since every dimension is then the same
 * sequence re-permuted and a pixel's samples lie on a curve.) The scramble mixes from the low bits up,
 * so the Sobol value, first digit in the high bit, is reversed before it and back after.
 */
inline float nextSample(thread Sampler& s) {
    if (s.mode == 0u) return pcgFloat(s.rng);
    const uint dim = s.dim++;
    if (dim >= s.sobolDims) return pcgFloat(s.rng);
    uint v = 0u;
    device const uint* dirs = s.sobol + dim * 32u;
    for (uint i = s.index, k = 0u; i != 0u; i >>= 1u, ++k) {
        if (i & 1u) v ^= dirs[k];
    }
    const uint seed = hashU32(s.pixelHash ^ (dim * 0x85ebca6bu));
    v = reverse_bits(v);
    v = owenScramble2(v, seed);
    v = reverse_bits(v);
    return min((float)v * (1.0f / 4294967296.0f), 0.99999994f);
}

/**
 * Dimensions are laid out per bounce so every bounce's lobe gets its own well-stratified pair: 6 a bounce (sun,
 * BSDF, roulette), 9 when the scene has lights (their pick and point too).
 */
inline void startBounceDimensions(thread Sampler& s, uint bounce, uint stride) {
    if (s.mode != 0u) s.dim = 4u + bounce * stride;
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

// Mean haze density along a segment between heights y0 and y1 (render::detail::hazeColumnFactor, the same expression).
inline float hazeColumn(float t) { return t <= 0.0f ? t : 1.0f - exp(-t); }
inline float hazeColumnFactor(float y0, float y1, float scaleHeight, float base) {
    if (scaleHeight <= 0.0f) return 1.0f;
    float a = (y0 - base) / scaleHeight, b = (y1 - base) / scaleHeight;
    float span = b - a;
    if (abs(span) < 1e-4f) return a <= 0.0f ? 1.0f : exp(-a);
    return (hazeColumn(b) - hazeColumn(a)) / span;
}

inline float3 horizonRadiance(constant Uniforms& u, device const float* lut, float3 direction) {
    float3 flat = float3(direction.x, 0.0f, direction.z);
    if (lengthSquared(flat) < 1e-8f) flat = float3(1.0f, 0.0f, 0.0f);
    return skyRadiance(u, lut, normalize(flat));
}


inline float nodeImportance(device const LightNode& node, float3 x, float3 n) {
    if (!(node.energy > 0.0f)) return 0.0f;
    float3 bmin = float3(node.bmin[0], node.bmin[1], node.bmin[2]), bmax = float3(node.bmax[0], node.bmax[1], node.bmax[2]);
    float3 center = (bmin + bmax) * 0.5f;
    float3 v = center - x;
    float d2 = dot(v, v);
    float3 ext = bmax - bmin;
    float r2 = 0.25f * dot(ext, ext);
    if (d2 <= r2) return node.energy / max(r2, 1e-12f);
    float d = sqrt(d2);
    float3 w = v / d;
    float thetaU = asin(min(sqrt(r2 / d2), 1.0f));
    float thetaI = acos(clamp(dot(n, w), -1.0f, 1.0f));
    float thetaIp = max(thetaI - thetaU, 0.0f);
    if (thetaIp >= 0.5f * kPi) return 0.0f;
    float3 axis = float3(node.axis[0], node.axis[1], node.axis[2]);
    float theta = acos(clamp(-dot(axis, w), -1.0f, 1.0f));
    float thetaP = max(theta - node.thetaO - thetaU, 0.0f);
    if (thetaP > 0.0f && thetaP >= node.thetaE) return 0.0f;
    return node.energy * cos(thetaIp) * cos(min(thetaP, 0.5f * kPi)) / d2;
}

inline float distantImportance(device const LightRecord& light, float3 n) {
    return light.energy * max(0.0f, -dot(float3(light.e1[0], light.e1[1], light.e1[2]), n));
}

inline float pointFalloff(device const LightRecord& light, float3 towardLight, float distance) {
    float f = 1.0f;
    if (light.cosOuter > -1.0f) {
        float scale = 1.0f / max(0.001f, light.cosInner - light.cosOuter);
        float cd = -dot(float3(light.e1[0], light.e1[1], light.e1[2]), towardLight);
        float s = clamp(cd * scale - light.cosOuter * scale, 0.0f, 1.0f);
        f *= s * s;
    }
    if (light.range > 0.0f) {
        float q = distance / light.range;
        float w = clamp(1.0f - q * q * q * q, 0.0f, 1.0f);
        f *= w * w;
    }
    return f;
}

inline float topImportance(thread const Lights& L, float3 x, float3 n, thread float& rootImportance) {
    rootImportance = L.localCount > 0u ? nodeImportance(L.nodes[0], x, n) : 0.0f;
    float sum = rootImportance;
    for (uint j = 0u; j < L.distantCount; ++j) sum += distantImportance(L.records[L.localCount + j], n);
    return sum;
}

inline float pickLight(thread const Lights& L, float3 x, float3 n, float u, thread uint& light) {
    float rootImportance;
    float sum = topImportance(L, x, n, rootImportance);
    if (!(sum > 0.0f)) return 0.0f;
    u = min(u, 0.99999994f) * sum;
    if (u >= rootImportance) {
        u -= rootImportance;
        float acc = 0.0f;
        for (uint j = 0u; j < L.distantCount; ++j) {
            float w = distantImportance(L.records[L.localCount + j], n);
            acc += w;
            if (u < acc || j + 1u == L.distantCount) {
                if (!(w > 0.0f)) return 0.0f;
                light = L.localCount + j;
                return w / sum;
            }
        }
        return 0.0f;
    }
    float prob = rootImportance / sum;
    u /= rootImportance;
    int node = 0;
    while (L.nodes[node].child0 >= 0) {
        device const LightNode& nd = L.nodes[node];
        float i0 = nodeImportance(L.nodes[nd.child0], x, n);
        float i1 = nodeImportance(L.nodes[nd.child1], x, n);
        float s = i0 + i1;
        if (!(s > 0.0f)) return 0.0f;
        float p0 = i0 / s;
        if (u < p0) {
            u = min(u / p0, 0.99999994f);
            node = nd.child0;
            prob *= p0;
        } else {
            u = min((u - p0) / (1.0f - p0), 0.99999994f);
            node = nd.child1;
            prob *= 1.0f - p0;
        }
    }
    light = (uint)(-1 - L.nodes[node].child0);
    return prob;
}

inline float selectPdf(thread const Lights& L, float3 x, float3 n, uint light) {
    if (light >= L.localCount + L.distantCount) return 0.0f;
    float rootImportance;
    float sum = topImportance(L, x, n, rootImportance);
    if (!(sum > 0.0f)) return 0.0f;
    device const LightRecord& rec = L.records[light];
    if (light >= L.localCount) return distantImportance(rec, n) / sum;
    float prob = rootImportance / sum;
    int node = (int)rec.leaf;
    while (L.nodes[node].parent >= 0) {
        device const LightNode& parent = L.nodes[L.nodes[node].parent];
        int sibling = parent.child0 == node ? parent.child1 : parent.child0;
        float own = nodeImportance(L.nodes[node], x, n);
        float other = nodeImportance(L.nodes[sibling], x, n);
        float s = own + other;
        if (!(s > 0.0f)) return 0.0f;
        prob *= own / s;
        node = L.nodes[node].parent;
    }
    return prob;
}

inline float powerHeuristic(float a, float b) {
    float a2 = a * a, b2 = b * b;
    return a2 + b2 > 0.0f ? a2 / (a2 + b2) : 0.0f;
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
    /** Multiple-scattering compensation of the specular lobe (Turquin 2019): 1 + f0 (1 / Ess - 1). */
    float3 msScale;
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

// Directional albedo of the specular lobe at F = 1; its table and definition are appended by the host
// (render::detail::ggxEssMetalSource), the same numbers the CPU tracer reads.
float ggxEss(float cosV, float roughness);

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
    // The specular lobe is chosen in proportion to its directional albedo (Lazarov's fit of the GGX
    // environment BRDF), not to Fresnel alone: a rough dielectric's lobe returns little and reflects below
    // the horizon most of the time, so Fresnel-weighted selection spent 21% of first-hit samples on nothing.
    // Any mixture weight is unbiased (the weight divides by the mixture pdf); this one measured 5-11% less
    // error per sample. The CPU tracer's MetallicRoughnessBsdf must stay identical for parity.
    float4 c0 = float4(-1.0f, -0.0275f, -0.572f, 0.022f), c1 = float4(1.0f, 0.0425f, 1.04f, -0.04f);
    float4 r = roughness * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28f * cosV)) * r.x + r.y;
    float2 AB = float2(a004 * -1.04f + r.z, a004 * 1.04f + r.w);
    // Single-scatter GGX loses the light that bounces between microfacets (most on a rough metal); scaling the
    // lobe by 1 + f0 (1 / Ess - 1), Ess its directional albedo, returns it (Turquin 2019), so rough metals and
    // rough glossy paint stop going dark.
    float ess = clamp(ggxEss(cosV, roughness), 0.05f, 1.0f);
    s.msScale = float3(1.0f) + s.f0 * (1.0f / ess - 1.0f);
    float specularWeight = luminance(s.msScale * (s.f0 * AB.x + float3(AB.y)));
    float diffuseWeight = (1.0f - metallic) * luminance(baseColor);
    s.specularProbability = clamp(specularWeight / max(specularWeight + diffuseWeight, 1e-6f), 0.02f, 0.9f);
    return s;
}

inline float3 bsdfEval(thread const Bsdf& s, float3 wiWorld) {
    float3 l = toLocal(s, wiWorld);
    if (l.z <= 0.0f || s.wo.z <= 0.0f) return float3(0.0f);
    float3 h = normalize(s.wo + l);
    float3 f = schlickFresnel(s.f0, max(dot(s.wo, h), 0.0f));
    float3 specular = s.msScale * f * (ggxDistribution(h.z, s.a2) * smithVisibilityCorrelated(s.wo.z, l.z, s.a2));
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

inline bool bsdfSample(thread const Bsdf& s, thread Sampler& smp, thread float3& wiWorld, thread float3& weight) {
    if (s.wo.z <= 0.0f) return false;
    float choice = nextSample(smp);
    float u1 = nextSample(smp);
    float u2 = nextSample(smp);
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
        if (m.emissiveImage >= 0 && luminance(s.emission) > 0.0f) {
            s.emission = s.emission * sampleTexture(textures[m.emissiveImage].tex, uv, m.emissiveWrapS, m.emissiveWrapT, true);
        }
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
    uint giCandidates; // ReSTIR GI: samples resampled at the first hit (own plus accepted neighbours), 0 when off
};

/** Geometry a ray set traces: the acceleration structure with the index and material buffers it was built from. */
struct Geometry {
    primitive_acceleration_structure accel;
    device const uint* idx;
    device const uint* triMaterials;
};

/** Emitted radiance of a triangle of `g` at barycentrics (bu, bv): its material's factor times its emissive texture. */
inline float3 triangleEmission(constant Uniforms& u, device const Vertex* verts, Geometry g, device const MaterialRecord* materials,
                               device const TextureRef* textures, uint tri, float bu, float bv) {
    if (u.useMaterials == 0u) return float3(0.0f);
    uint matId = g.triMaterials[tri];
    if (matId == kNoMaterial) matId = u.defaultMaterial;
    device const MaterialRecord& m = materials[matId];
    float3 e = f3(m.emissive);
    if (!(luminance(e) > 0.0f)) return float3(0.0f);
    if (m.emissiveImage >= 0) {
        uint i0 = g.idx[tri * 3], i1 = g.idx[tri * 3 + 1], i2 = g.idx[tri * 3 + 2];
        float2 uv = f2(verts[i0].uv) * (1.0f - bu - bv) + f2(verts[i1].uv) * bu + f2(verts[i2].uv) * bv;
        e = e * sampleTexture(textures[m.emissiveImage].tex, uv, m.emissiveWrapS, m.emissiveWrapT, true);
    }
    return e;
}

/** Bilinear lookup of a texture's alpha (port of detail::sampleAlpha; textures without alpha read 1). */
inline float sampleAlpha(texture2d<float> img, float2 uv, int wrapS, int wrapT) {
    int w = (int)img.get_width(), h = (int)img.get_height();
    if (w <= 0 || h <= 0) return 1.0f;
    float fx = clamp(uv.x, -1e5f, 1e5f) * (float)w - 0.5f;
    float fy = clamp(uv.y, -1e5f, 1e5f) * (float)h - 0.5f;
    if (!isfinite(fx) || !isfinite(fy)) return 1.0f;
    float x0f = floor(fx), y0f = floor(fy);
    float tx = fx - x0f, ty = fy - y0f;
    int x0 = (int)x0f, y0 = (int)y0f;
    int xa = wrapCoordinate(x0, w, wrapS), xb = wrapCoordinate(x0 + 1, w, wrapS);
    int ya = wrapCoordinate(y0, h, wrapT), yb = wrapCoordinate(y0 + 1, h, wrapT);
    float top = img.read(uint2(xa, ya)).a * (1.0f - tx) + img.read(uint2(xb, ya)).a * tx;
    float bottom = img.read(uint2(xa, yb)).a * (1.0f - tx) + img.read(uint2(xb, yb)).a * tx;
    return top * (1.0f - ty) + bottom * ty;
}

/** Port of PathTracer::surfaceAt: false where an alpha-masked triangle's base colour is cut out. */
inline bool surfaceAt(constant Uniforms& u, device const Vertex* verts, Geometry g, device const MaterialRecord* materials,
                      device const TextureRef* textures, uint tri, float2 bary) {
    if (u.alphaTested == 0u || u.useMaterials == 0u) return true;
    uint matId = g.triMaterials[tri];
    if (matId == kNoMaterial) matId = u.defaultMaterial;
    device const MaterialRecord& m = materials[matId];
    if (m.alphaMask == 0) return true;
    float alpha = m.baseColor[3];
    if (m.baseColorImage >= 0) {
        uint i0 = g.idx[tri * 3], i1 = g.idx[tri * 3 + 1], i2 = g.idx[tri * 3 + 2];
        float2 uv = f2(verts[i0].uv) * (1.0f - bary.x - bary.y) + f2(verts[i1].uv) * bary.x + f2(verts[i2].uv) * bary.y;
        alpha *= sampleAlpha(textures[m.baseColorImage].tex, uv, m.wrapS, m.wrapT);
    }
    return alpha >= m.alphaCutoff;
}

/** What an alpha test reads: the vertex, material and texture tables. */
struct SceneTables {
    device const Vertex* verts;
    device const MaterialRecord* materials;
    device const TextureRef* textures;
};

/**
 * The nearest surface along a ray. With alpha-masked materials in the scene the geometry is non-opaque and an
 * intersection query commits only candidates that are there (surfaceAt), so the ray passes cut-out texels; without
 * them the plain intersector runs, as before.
 */
inline intersection_result<triangle_data> traceClosest(constant Uniforms& u, ray r, Geometry g, thread intersector<triangle_data>& closest, SceneTables t) {
    if (u.alphaTested == 0u) return closest.intersect(r, g.accel);
    intersection_params params;
    params.assume_geometry_type(geometry_type::triangle);
    intersection_query<triangle_data> q(r, g.accel, params);
    while (q.next()) {
        if (q.get_candidate_intersection_type() == intersection_type::triangle
            && surfaceAt(u, t.verts, g, t.materials, t.textures, q.get_candidate_primitive_id(), q.get_candidate_triangle_barycentric_coord())) {
            q.commit_triangle_intersection();
        }
    }
    intersection_result<triangle_data> hit;
    hit.type = q.get_committed_intersection_type();
    if (hit.type == intersection_type::triangle) {
        hit.distance = q.get_committed_distance();
        hit.primitive_id = q.get_committed_primitive_id();
        hit.triangle_barycentric_coord = q.get_committed_triangle_barycentric_coord();
    }
    return hit;
}

/** Whether a shadow ray meets a surface that is there (cut-out texels let the light through). */
inline bool occludedRay(constant Uniforms& u, ray r, Geometry g, thread intersector<triangle_data>& any, SceneTables t) {
    if (u.alphaTested == 0u) return any.intersect(r, g.accel).type != intersection_type::none;
    intersection_params params;
    params.assume_geometry_type(geometry_type::triangle);
    params.accept_any_intersection(true);
    intersection_query<triangle_data> q(r, g.accel, params);
    while (q.next()) {
        if (q.get_candidate_intersection_type() == intersection_type::triangle
            && surfaceAt(u, t.verts, g, t.materials, t.textures, q.get_candidate_primitive_id(), q.get_candidate_triangle_barycentric_coord())) {
            q.commit_triangle_intersection();
        }
    }
    return q.get_committed_intersection_type() != intersection_type::none;
}

/**
 * One light sample at a vertex (port of PathTracer::sampleLight): a light picked from the tree, a point on it,
 * and the contribution before its shadow ray, weighted against the BSDF when the path goes on (`mis`).
 * Returns false when there is nothing to trace; else `wi` and `tMax` give the shadow ray.
 */
inline bool sampleLight(constant Uniforms& u, thread const Lights& L, device const Vertex* verts, Geometry lightGeo,
                        device const MaterialRecord* materials, device const TextureRef* textures,
                        thread const Surface& surface, thread const Bsdf& bsdf, float3 throughput, float uSelect, float u1, float u2, bool mis,
                        thread float3& contribution, thread float3& wi, thread float& tMax) {
    uint index = kNoLight;
    float select = pickLight(L, surface.position, surface.shadingNormal, uSelect, index);
    if (!(select > 0.0f)) return false;
    device const LightRecord& light = L.records[index];
    float3 incident;
    float distance = 1e9f, lightPdf = 0.0f;
    if (index >= L.localCount) {
        wi = -float3(light.e1[0], light.e1[1], light.e1[2]);
        incident = float3(light.intensity[0], light.intensity[1], light.intensity[2]) / select;
    } else if (light.kind == kTriangleLight) {
        float su = sqrt(u1);
        float bu = su * (1.0f - u2), bv = su * u2;
        float3 e1 = float3(light.e1[0], light.e1[1], light.e1[2]), e2 = float3(light.e2[0], light.e2[1], light.e2[2]);
        float3 y = float3(light.p0[0], light.p0[1], light.p0[2]) + e1 * bu + e2 * bv;
        float3 v = y - surface.position;
        float d2 = dot(v, v);
        if (!(d2 > 1e-12f)) return false;
        distance = sqrt(d2);
        wi = v / distance;
        float cosLight = abs(dot(normalize(cross(e1, e2)), wi));
        if (cosLight < 1e-6f) return false;
        float3 emitted = triangleEmission(u, verts, lightGeo, materials, textures, light.triangle, bu, bv);
        if (!(luminance(emitted) > 0.0f)) return false;
        lightPdf = select * d2 / (light.area * cosLight);
        incident = emitted / lightPdf;
    } else {
        float3 v = float3(light.p0[0], light.p0[1], light.p0[2]) - surface.position;
        float d2 = dot(v, v);
        if (!(d2 > 1e-12f)) return false;
        distance = sqrt(d2);
        wi = v / distance;
        incident = float3(light.intensity[0], light.intensity[1], light.intensity[2]) * (pointFalloff(light, wi, distance) / (d2 * select));
    }
    float cosShading = dot(surface.shadingNormal, wi);
    if (cosShading <= 0.0f || dot(surface.geometricNormal, wi) <= 0.0f) return false;
    float3 f = bsdfEval(bsdf, wi);
    float weight = mis && lightPdf > 0.0f ? powerHeuristic(lightPdf, bsdfPdf(bsdf, wi)) : 1.0f;
    contribution = throughput * f * incident * (cosShading * weight);
    if (!(maxComponent(contribution) > 0.0f)) return false;
    tMax = distance < 1e9f ? max(distance - 2.0f * kRayEpsilon, 1e-4f) : 1e9f;
    return true;
}

/** Moller-Trumbore against one triangle, both faces, with the intersector's barycentric convention (u for v1, v for v2). */
inline bool intersectTriangle(device const Vertex* verts, device const uint* idx, uint tri, float3 origin, float3 dir,
                              thread float& t, thread float& u, thread float& v) {
    float3 p0 = f3(verts[idx[tri * 3]].position), p1 = f3(verts[idx[tri * 3 + 1]].position), p2 = f3(verts[idx[tri * 3 + 2]].position);
    float3 e1 = p1 - p0, e2 = p2 - p0;
    float3 pv = cross(dir, e2);
    float det = dot(e1, pv);
    if (abs(det) < 1e-12f) return false;
    float inv = 1.0f / det;
    float3 tv = origin - p0;
    u = dot(tv, pv) * inv;
    if (u < 0.0f || u > 1.0f) return false;
    float3 qv = cross(tv, e1);
    v = dot(dir, qv) * inv;
    if (v < 0.0f || u + v > 1.0f) return false;
    t = dot(e2, qv) * inv;
    return t > 1e-4f;
}

// ---- ReSTIR over sky directions at the first hit ----------------------------------------------
/** Resampling keeps at most this many candidates' worth of history per pixel, so a reservoir still adapts. */
constant uint kRestirHistoryFactor = 20u;

/** The target function: luminance of the sky lit, cosine-weighted BSDF response in direction wi at this surface. */
inline float restirTarget(constant Uniforms& u, device const float* lut, thread const Bsdf& bsdf, float3 geometricNormal, float3 wi) {
    float cosShading = dot(bsdf.n, wi);
    if (cosShading <= 0.0f || dot(geometricNormal, wi) <= 0.0f) return 0.0f;
    return luminance(bsdfEval(bsdf, wi) * skyRadiance(u, lut, wi) * cosShading);
}

inline void restirClamp(thread Reservoir& r, uint maxM) {
    if (r.M > maxM) {
        r.wSum *= (float)maxM / (float)r.M;
        r.M = maxM;
    }
}

/**
 * Proposes sky directions for the first hit, resamples them into the pixel's reservoir (kept across passes),
 * and shades the chosen one with a visibility ray. An occluded choice is dropped from the reservoir so it
 * does not spread to neighbours (visibility reuse). Returns the sky radiance estimate for this pass.
 */
inline float3 restirSkyLighting(constant Uniforms& u, device const float* lut, thread Sampler& smp, thread const Bsdf& bsdf,
                                thread const Surface& surface, Geometry shadowGeo, thread intersector<triangle_data>& any,
                                device Reservoir* reservoir, device const Reservoir* prevReservoirs, device const PrimarySurface* prevSurfaces,
                                uint2 gid, float depth, thread uint& rays) {
    Reservoir r = *reservoir;
    if (u.restir == 2u) {
        // Fresh per pass: resampling within the pass and across neighbours' previous pass, so passes stay independent.
        r.wSum = 0.0f; r.W = 0.0f; r.pHat = 0.0f; r.M = 0u;
    }
    float3 chosen = f3(r.dir);
    // Candidates draw from the pixel's PCG stream, not the Sobol dimensions the path's bounces use.
    for (uint c = 0u; c < u.restirCandidates; ++c) {
        float u1 = pcgFloat(smp.rng);
        float u2 = pcgFloat(smp.rng);
        float rr = sqrt(u1), phi = 2.0f * kPi * u2;
        float3 l = float3(rr * cos(phi), rr * sin(phi), sqrt(max(0.0f, 1.0f - u1)));
        float pdf = l.z / kPi;
        float3 wi = toWorld(bsdf, l);
        float pHat = pdf > 1e-8f ? restirTarget(u, lut, bsdf, surface.geometricNormal, wi) : 0.0f;
        float w = pdf > 1e-8f ? pHat / pdf : 0.0f;
        r.wSum += w;
        r.M += 1u;
        if (w > 0.0f && pcgFloat(smp.rng) * r.wSum < w) {
            chosen = wi;
            r.pHat = pHat;
        }
    }
    if (u.restir == 2u && u.restirSpatial > 0u) {
        // Neighbours' reservoirs from the previous pass, re-evaluated at this surface.
        const float radius = 16.0f;
        for (uint k = 0u; k < u.restirSpatial; ++k) {
            float2 d = concentricDisk(pcgFloat(smp.rng), pcgFloat(smp.rng)) * radius;
            int qx = (int)gid.x + (int)round(d.x), qy = (int)gid.y + (int)round(d.y);
            if (qx < 0 || qy < 0 || qx >= (int)u.width || qy >= (int)u.height) continue;
            uint q = (uint)qy * u.width + (uint)qx;
            PrimarySurface sq = prevSurfaces[q];
            if (sq.valid == 0u) continue;
            if (dot(f3(sq.shadingNormal), bsdf.n) < 0.9f) continue;
            if (abs(sq.depth - depth) > 0.1f * max(depth, 1e-3f)) continue;
            Reservoir nr = prevReservoirs[q];
            if (nr.M == 0u || nr.W <= 0.0f) continue;
            float3 wi = f3(nr.dir);
            float pHatHere = restirTarget(u, lut, bsdf, surface.geometricNormal, wi);
            float w = pHatHere * nr.W * (float)nr.M;
            r.wSum += w;
            r.M += nr.M;
            if (w > 0.0f && pcgFloat(smp.rng) * r.wSum < w) {
                chosen = wi;
                r.pHat = pHatHere;
            }
        }
    }
    restirClamp(r, kRestirHistoryFactor * max(u.restirCandidates, 1u));
    r.W = r.pHat > 0.0f ? r.wSum / ((float)r.M * r.pHat) : 0.0f;
    float3 estimate = float3(0.0f);
    if (r.W > 0.0f) {
        // Re-evaluate at this pass's surface: the chosen direction may come from a neighbour or an earlier pass.
        float cosShading = dot(bsdf.n, chosen);
        float3 f = restirTarget(u, lut, bsdf, surface.geometricNormal, chosen) > 0.0f ? bsdfEval(bsdf, chosen) * skyRadiance(u, lut, chosen) * cosShading : float3(0.0f);
        if (maxComponent(f) > 0.0f) {
            ++rays;
            ray shadow(surface.position + surface.geometricNormal * kRayEpsilon, chosen, 1e-4f, 1e9f);
            intersection_result<triangle_data> blocker = any.intersect(shadow, shadowGeo.accel);
            if (blocker.type == intersection_type::none) {
                estimate = f * r.W;
            } else {
                r.W = 0.0f;
                r.wSum = 0.0f;
                r.pHat = 0.0f;
            }
        } else {
            r.W = 0.0f;
            r.wSum = 0.0f;
            r.pHat = 0.0f;
        }
    }
    r.dir[0] = chosen.x; r.dir[1] = chosen.y; r.dir[2] = chosen.z;
    *reservoir = r;
    return estimate;
}

// ---- Visibility-guided sky sampling at the first hit ----------------------------------------------
// Each tile of pixels keeps equal-area world-space bins (bands by direction.y times azimuth sectors) of
// how many rays it sent that way and how many reached the sky (tries, then hits, as counters updated
// atomically). Guided directions are drawn in proportion to the estimated visibility times the cosine
// at the bin centre; the BSDF ray stays as the other strategy and the two are combined by the balance
// heuristic with the weights a sample was drawn with, so the estimate is unbiased whatever the
// histogram says, and the histogram only decides how fast it converges. Bin weights are recomputed on
// demand (only their sum is kept) so a fine histogram costs no thread memory.
struct GuideFrame {
    /** The committed counters a pass reads (frozen for the pass) and the pending ones it adds to. */
    device const uint* hist;
    device atomic_uint* pending;
    uint bands, sectors, bins;
    float3 n;
    float sum;
    float binSolidAngle;
};

inline uint guideBin(thread const GuideFrame& g, float3 d) {
    uint band = min((uint)((clamp(d.y, -1.0f, 1.0f) + 1.0f) * 0.5f * (float)g.bands), g.bands - 1u);
    float phi = atan2(d.z, d.x);
    if (phi < 0.0f) phi += 2.0f * kPi;
    uint sector = min((uint)(phi / (2.0f * kPi) * (float)g.sectors), g.sectors - 1u);
    return band * g.sectors + sector;
}

inline float3 guideDirection(thread const GuideFrame& g, uint bin, float u2, float u3) {
    float y = -1.0f + ((float)(bin / g.sectors) + u2) * (2.0f / (float)g.bands);
    float phi = ((float)(bin % g.sectors) + u3) * (2.0f * kPi / (float)g.sectors);
    float r = sqrt(max(0.0f, 1.0f - y * y));
    return float3(r * cos(phi), y, r * sin(phi));
}

/** Estimated chance that a ray into a bin reaches the sky, from its counters. */
inline float guideVisibility(uint tries, uint hits) {
    return ((float)hits + 0.5f) / ((float)tries + 1.0f);
}

inline void guideRecord(thread const GuideFrame& g, uint bin, bool reachedSky) {
    atomic_fetch_add_explicit(g.pending + bin, 1u, memory_order_relaxed);
    if (reachedSky) atomic_fetch_add_explicit(g.pending + g.bins + bin, 1u, memory_order_relaxed);
}

inline float guideWeight(thread const GuideFrame& g, uint bin) {
    float cosine = dot(g.n, guideDirection(g, bin, 0.5f, 0.5f));
    if (cosine <= 0.0f) return 0.0f;
    return cosine * guideVisibility(g.hist[bin], g.hist[g.bins + bin]);
}

inline GuideFrame guideBegin(constant Uniforms& u, device const uint* hist, device atomic_uint* pending, float3 n) {
    GuideFrame g;
    g.hist = hist;
    g.pending = pending;
    g.bands = max(u.guideBands, 1u);
    g.sectors = max(u.guideSectors, 1u);
    g.bins = g.bands * g.sectors;
    g.n = n;
    g.binSolidAngle = 4.0f * kPi / (float)g.bins;
    g.sum = 0.0f;
    for (uint b = 0u; b < g.bins; ++b) g.sum += guideWeight(g, b);
    return g;
}

inline float guidePdf(thread const GuideFrame& g, float3 d) {
    if (g.sum <= 0.0f) return 0.0f;
    return guideWeight(g, guideBin(g, d)) / (g.sum * g.binSolidAngle);
}

inline float3 guideSample(thread const GuideFrame& g, float u1, float u2, float u3, thread float& pdf) {
    float pick = u1 * g.sum, acc = 0.0f, w = 0.0f;
    uint bin = g.bins - 1u;
    for (uint b = 0u; b < g.bins; ++b) {
        w = guideWeight(g, b);
        acc += w;
        if (pick < acc) { bin = b; break; }
    }
    pdf = w / (g.sum * g.binSolidAngle);
    return guideDirection(g, bin, u2, u3);
}

// ---- ReSTIR GI over second hits -------------------------------------------------------------------
// A path's own second hit with the radiance it sends back is one sample (weight 1/pdf); neighbours' samples
// from the previous pass are resampled into it after reconnection to this first hit (Jacobian of the
// solid-angle pdf between the two first hits; escaped samples are directions and need none), the choice is
// shaded after one visibility ray. Passes stay independent since only the previous pass is read.
struct GiCandidate {
    float3 fCos;      // BSDF times cosine at this first hit toward the sample
    float3 radiance;
    float3 dir;
    float distance;   // to the point, or 0 for a direction
    float pHat;
};

/** Reconnects sample `y` (gathered at another first hit) to this first hit; false when it cannot contribute here. */
inline bool giReconnect(thread const Bsdf& bsdf, float3 x1, float3 ng1, device const GiSample& y, thread GiCandidate& c, thread float& w) {
    float3 radiance = float3(y.radiance[0], y.radiance[1], y.radiance[2]);
    float jacobian = 1.0f;
    if ((y.flags & 2u) != 0u) {
        c.dir = float3(y.x2[0], y.x2[1], y.x2[2]);
        c.distance = 0.0f;
    } else {
        float3 x2 = float3(y.x2[0], y.x2[1], y.x2[2]);
        float3 n2 = float3(y.n2[0], y.n2[1], y.n2[2]);
        float3 v = x2 - x1;
        float dr2 = dot(v, v);
        if (dr2 < 1e-8f) return false;
        c.distance = sqrt(dr2);
        c.dir = v / c.distance;
        float3 x1q = float3(y.x1[0], y.x1[1], y.x1[2]);
        float3 vq = x2 - x1q;
        float dq2 = dot(vq, vq);
        if (dq2 < 1e-8f) return false;
        float cosR = abs(dot(n2, -c.dir));
        float cosQ = abs(dot(n2, -vq / sqrt(dq2)));
        if (cosQ < 1e-4f) return false;
        // The sample's solid-angle pdf here is the neighbour's divided by this: p_r = p_q * (cosQ / cosR) * (dr2 / dq2).
        jacobian = (cosR / cosQ) * (dq2 / dr2);
        // Where the two first hits see the point very differently the weights explode into fireflies; such
        // samples are left out (a rejection, hence a small bias, measured in the process doc).
        if (jacobian < 0.2f || jacobian > 5.0f) return false;
    }
    float cosShading = dot(bsdf.n, c.dir);
    if (cosShading <= 0.0f || dot(ng1, c.dir) <= 0.0f) return false;
    c.fCos = bsdfEval(bsdf, c.dir) * cosShading;
    c.radiance = radiance;
    c.pHat = luminance(c.fCos * radiance);
    if (!(c.pHat > 0.0f) || !(y.pdf > 0.0f)) return false;
    w = c.pHat * jacobian / y.pdf;
    return isfinite(w);
}

inline PathResult tracePath(float3 origin, float3 dir, thread Sampler& smp, constant Uniforms& u,
                            device const Vertex* verts, device const float* lut, Geometry primary, Geometry bounceGeo,
                            device const MaterialRecord* materials, device const TextureRef* textures, uint visibleTriangle, thread uint& rays,
                            device Reservoir* reservoir, device PrimarySurface* primarySurface,
                            device const Reservoir* prevReservoirs, device const PrimarySurface* prevSurfaces, uint2 gid,
                            device const uint* guideHist, device atomic_uint* guidePending,
                            device GiSample* giOut, device const GiSample* giPrev, thread const Lights& lights) {
    PathResult result;
    result.radiance = float3(0.0f);
    result.albedo = float3(0.0f);
    result.normal = float3(0.0f);
    result.depth = 0.0f;
    result.hitGeometry = false;
    result.giCandidates = 0u;
    float3 radiance = float3(0.0f);
    float3 throughput = float3(1.0f);
    const bool sky = u.lighting == 1u;
    const bool restir = u.restir != 0u && sky;
    // With ReSTIR the first hit's sky light is resampled, so its BSDF ray must not count the sky again.
    bool skyCountedByRestir = false;
    // With guiding, the first hit's BSDF ray shares the sky with the guided sample by MIS and teaches the histogram.
    const bool guided = u.guided != 0u && sky && !restir;
    bool guideActive = false;
    GuideFrame guide;
    float firstBsdfPdf = 0.0f;
    // ReSTIR GI: past the first hit the path gathers into giRadiance with throughput reset to one, so the
    // sample's radiance is what arrives at the first hit per unit of BSDF response.
    const bool gi = u.restirGi != 0u && !restir && !guided;
    bool giActive = false;
    float3 giRadiance = float3(0.0f);
    float giPdf = 0.0f;
    float3 giFCos = float3(0.0f);
    GiSample own;
    own.flags = 0u;
    Bsdf bsdf1;
    float3 x1 = float3(0.0f), ng1 = float3(0.0f);
    const bool sampleLights = lights.localCount + lights.distantCount > 0u;
    // Emissive triangles are those of the geometry bounce rays trace; light samples read their materials there.
    const Geometry lightGeo = u.useBounceAccel != 0u ? bounceGeo : primary;
    const SceneTables tables{verts, materials, textures};
    const uint dimStride = sampleLights ? 9u : 6u;
    // The previous vertex, for weighting emission a BSDF ray finds against the light sample taken there.
    float3 prevPosition = float3(0.0f), prevNormal = float3(0.0f, 1.0f, 0.0f);
    float prevBsdfPdf = 0.0f;

    intersector<triangle_data> closest;
    closest.assume_geometry_type(geometry_type::triangle);
    closest.force_opacity(forced_opacity::opaque);
    intersector<triangle_data> any;
    any.assume_geometry_type(geometry_type::triangle);
    any.force_opacity(forced_opacity::opaque);
    any.accept_any_intersection(true);

    // After the first hit, rays may trace the coarser bounce cut; they start past its error bound to miss its own surface.
    float rayStart = 1e-4f;
    for (uint bounce = 0;; ++bounce) {
        startBounceDimensions(smp, bounce, dimStride);
        const bool coarse = u.useBounceAccel != 0u && bounce > 0u;
        const Geometry geo = coarse ? bounceGeo : primary;
        intersection_result<triangle_data> hit;
        bool resolved = false;
        if (bounce == 0u && visibleTriangle != kNoMaterial) {
            // The pixel's rasterized triangle, met exactly by this sample's jittered ray; at its edges the ray may
            // miss it and is traced like any other.
            float t, bu, bv;
            if (intersectTriangle(verts, primary.idx, visibleTriangle, origin, dir, t, bu, bv)) {
                hit.type = intersection_type::triangle;
                hit.distance = t;
                hit.primitive_id = visibleTriangle;
                hit.triangle_barycentric_coord = float2(bu, bv);
                resolved = true;
            }
        }
        if (!resolved) {
            ++rays;
            ray r(origin, dir, rayStart, 1e9f);
            hit = traceClosest(u, r, geo, closest, tables);
        }
        if (hit.type == intersection_type::none) {
            float3 skyLight = sky ? skyRadiance(u, lut, dir) : f3(u.studioRadiance);
            if (sky && bounce == 0) skyLight += sunDiscRadiance(u, dir);
            if (bounce == 1u && skyCountedByRestir) skyLight = float3(0.0f);
            if (bounce == 1u && guideActive) {
                // Balance heuristic against the guided strategy for this direction; the ray reached the sky.
                float pg = guidePdf(guide, dir);
                skyLight = skyLight * (firstBsdfPdf / max(firstBsdfPdf + (float)max(u.guideSamples, 1u) * pg, 1e-12f));
                guideRecord(guide, guideBin(guide, dir), true);
            }
            if (giActive) {
                if (bounce == 1u) {
                    own.flags = 3u;
                    own.x2[0] = dir.x; own.x2[1] = dir.y; own.x2[2] = dir.z;
                }
                accumulate(giRadiance, throughput * skyLight, bounce, u.clampIndirect);
            } else {
                accumulate(radiance, throughput * skyLight, bounce, u.clampIndirect);
            }
            break;
        }
        if (bounce == 1u && guideActive) guideRecord(guide, guideBin(guide, dir), false);
        Surface surface = shade(u, verts, geo.idx, geo.triMaterials, materials, textures, hit.primitive_id, hit.triangle_barycentric_coord, origin, dir, hit.distance);
        if (giActive && bounce == 1u) {
            own.flags = 1u;
            own.x2[0] = surface.position.x; own.x2[1] = surface.position.y; own.x2[2] = surface.position.z;
            own.n2[0] = surface.geometricNormal.x; own.n2[1] = surface.geometricNormal.y; own.n2[2] = surface.geometricNormal.z;
        }
        if (bounce == 0) {
            result.hitGeometry = true;
            result.albedo = surface.baseColor;
            result.normal = surface.shadingNormal;
            result.depth = hit.distance;
            if (restir) {
                PrimarySurface ps;
                ps.position[0] = surface.position.x; ps.position[1] = surface.position.y; ps.position[2] = surface.position.z;
                ps.depth = hit.distance;
                ps.shadingNormal[0] = surface.shadingNormal.x; ps.shadingNormal[1] = surface.shadingNormal.y; ps.shadingNormal[2] = surface.shadingNormal.z;
                ps.metallic = surface.metallic;
                ps.baseColor[0] = surface.baseColor.x; ps.baseColor[1] = surface.baseColor.y; ps.baseColor[2] = surface.baseColor.z;
                ps.roughness = surface.roughness;
                ps.geometricNormal[0] = surface.geometricNormal.x; ps.geometricNormal[1] = surface.geometricNormal.y; ps.geometricNormal[2] = surface.geometricNormal.z;
                ps.valid = 1u;
                *primarySurface = ps;
            }
        }
        if (sky) {
            float column = hazeColumnFactor(origin.y, origin.y + dir.y * hit.distance, u.hazeScaleHeight, u.hazeBaseY);
            float3 opticalDepth = f3(u.hazeExtinction) * (hit.distance * column);
            float3 transmittance = float3(exp(-opticalDepth.x), exp(-opticalDepth.y), exp(-opticalDepth.z));
            float3 inScatter = throughput * (horizonRadiance(u, lut, dir) * (float3(1.0f) - transmittance));
            if (giActive) accumulate(giRadiance, inScatter, bounce, u.clampIndirect);
            else accumulate(radiance, inScatter, bounce, u.clampIndirect);
            throughput = throughput * transmittance;
        }
        const uint emitter = bounce > 0u && sampleLights ? lights.triangleLight[hit.primitive_id] : kNoLight;
        if (emitter == kNoLight) {
            if (giActive) giRadiance += throughput * surface.emission;
            else radiance += throughput * surface.emission;
        } else {
            // Found by the BSDF ray of the previous vertex, which also sampled the lights: weight the two.
            float cosLight = abs(dot(surface.geometricNormal, dir));
            float lightPdf = cosLight > 1e-6f
                ? selectPdf(lights, prevPosition, prevNormal, emitter) * hit.distance * hit.distance / (lights.records[emitter].area * cosLight)
                : 0.0f;
            float3 emitted = throughput * surface.emission * powerHeuristic(prevBsdfPdf, lightPdf);
            if (giActive) accumulate(giRadiance, emitted, bounce, u.clampIndirect);
            else accumulate(radiance, emitted, bounce, u.clampIndirect);
        }

        const float3 wo = -dir;
        Bsdf bsdf = makeBsdf(surface.shadingNormal, surface.baseColor, surface.metallic, surface.roughness, wo);
        // Distance from the camera path so far, which bounds how far the bounce cut's surface may sit from this one.
        // Rays into the coarse geometry start that far out along the normal, not along their own direction:
        // a grazing ray would otherwise skip a long way across the surface and through nearby walls.
        const float hitDistance = length(surface.position - f3(u.camPos));
        const float coarseOffset = u.useBounceAccel != 0u ? max(kRayEpsilon, u.bounceErrorPerDistance * hitDistance) : kRayEpsilon;
        if (sky && u.sunVisible != 0u) {
            float s1 = nextSample(smp);
            float s2 = nextSample(smp);
            float3 wi = sampleSunDirection(u, s1, s2);
            float cosShading = dot(surface.shadingNormal, wi);
            if (cosShading > 0.0f && dot(surface.geometricNormal, wi) > 0.0f) {
                ++rays;
                const bool coarseShadow = u.useBounceAccel != 0u && u.bounceShadowRays != 0u;
                const Geometry shadowGeo = coarseShadow ? bounceGeo : primary;
                ray shadow(surface.position + surface.geometricNormal * (coarseShadow ? coarseOffset : kRayEpsilon), wi, 1e-4f, 1e9f);
                if (!occludedRay(u, shadow, shadowGeo, any, tables)) {
                    float3 sunLight = throughput * bsdfEval(bsdf, wi) * f3(u.sunIrradiance) * cosShading;
                    if (giActive) accumulate(giRadiance, sunLight, bounce, u.clampIndirect);
                    else accumulate(radiance, sunLight, bounce, u.clampIndirect);
                }
            }
        }
        if (sampleLights) {
            float uSelect = nextSample(smp);
            float l1 = nextSample(smp);
            float l2 = nextSample(smp);
            float3 contribution, wi;
            float tMax;
            if (sampleLight(u, lights, verts, lightGeo, materials, textures, surface, bsdf, throughput, uSelect, l1, l2, bounce < u.maxBounces,
                            contribution, wi, tMax)) {
                ++rays;
                const bool coarseShadow = u.useBounceAccel != 0u && u.bounceShadowRays != 0u;
                const Geometry shadowGeo = coarseShadow ? bounceGeo : primary;
                ray shadow(surface.position + surface.geometricNormal * (coarseShadow ? coarseOffset : kRayEpsilon), wi, 1e-4f, tMax);
                if (!occludedRay(u, shadow, shadowGeo, any, tables)) {
                    if (giActive) accumulate(giRadiance, contribution, bounce, u.clampIndirect);
                    else accumulate(radiance, contribution, bounce, u.clampIndirect);
                }
            }
        }
        if (restir && bounce == 0u) {
            radiance += throughput * restirSkyLighting(u, lut, smp, bsdf, surface, primary, any, reservoir, prevReservoirs, prevSurfaces, gid, hit.distance, rays);
            skyCountedByRestir = true;
        }
        if (guided && bounce == 0u) {
            guide = guideBegin(u, guideHist, guidePending, surface.shadingNormal);
            if (guide.sum > 0.0f) {
                guideActive = true;
                const uint K = max(u.guideSamples, 1u);
                for (uint k = 0u; k < K; ++k) {
                    float pg;
                    float3 wi = guideSample(guide, pcgFloat(smp.rng), pcgFloat(smp.rng), pcgFloat(smp.rng), pg);
                    float cosShading = dot(surface.shadingNormal, wi);
                    if (pg > 0.0f && cosShading > 0.0f && dot(surface.geometricNormal, wi) > 0.0f) {
                        float3 f = bsdfEval(bsdf, wi) * cosShading;
                        if (maxComponent(f) > 0.0f) {
                            ++rays;
                            ray shadow(surface.position + surface.geometricNormal * kRayEpsilon, wi, 1e-4f, 1e9f);
                            intersection_result<triangle_data> blocker = any.intersect(shadow, primary.accel);
                            const bool reachedSky = blocker.type == intersection_type::none;
                            if (reachedSky) {
                                // Multi-sample balance heuristic: K guided samples against one BSDF sample.
                                float pb = bsdfPdf(bsdf, wi);
                                radiance += throughput * f * skyRadiance(u, lut, wi) * (1.0f / ((float)K * pg + pb));
                            }
                            guideRecord(guide, guideBin(guide, wi), reachedSky);
                        }
                    }
                }
            }
        }

        if (bounce >= u.maxBounces) break;
        float3 wi, weight;
        if (!bsdfSample(bsdf, smp, wi, weight) || dot(surface.geometricNormal, wi) <= 0.0f) break;
        prevPosition = surface.position;
        prevNormal = surface.shadingNormal;
        prevBsdfPdf = bsdfPdf(bsdf, wi);
        if (bounce == 0u && guideActive) firstBsdfPdf = bsdfPdf(bsdf, wi);
        if (gi && bounce == 0u) {
            giActive = true;
            giPdf = bsdfPdf(bsdf, wi);
            giFCos = bsdfEval(bsdf, wi) * dot(surface.shadingNormal, wi);
            bsdf1 = bsdf;
            x1 = surface.position;
            ng1 = surface.geometricNormal;
            own.x1[0] = x1.x; own.x1[1] = x1.y; own.x1[2] = x1.z;
            own.depth = hit.distance;
            own.n1[0] = surface.shadingNormal.x; own.n1[1] = surface.shadingNormal.y; own.n1[2] = surface.shadingNormal.z;
            own.pdf = giPdf;
            weight = float3(1.0f);
        }
        throughput = throughput * weight;
        if (bounce >= 2) {
            float q = min(0.95f, maxComponent(throughput));
            if (q <= 0.0f || nextSample(smp) > q) break;
            throughput = throughput / q;
        }
        origin = surface.position + surface.geometricNormal * coarseOffset;
        dir = wi;
        rayStart = 1e-4f;
    }
    if (gi) {
        if (giActive && (own.flags & 1u) != 0u && giPdf > 0.0f) {
            own.radiance[0] = giRadiance.x; own.radiance[1] = giRadiance.y; own.radiance[2] = giRadiance.z;
            // Resample: the path's own sample, then neighbours' samples of the previous pass reconnected here.
            GiCandidate chosen;
            chosen.fCos = giFCos;
            chosen.radiance = giRadiance;
            chosen.distance = 0.0f;
            chosen.pHat = luminance(giFCos * giRadiance);
            float wSum = chosen.pHat / giPdf;
            uint M = 1u;
            bool chosenIsOwn = true;
            const float radius = 16.0f;
            for (uint k = 0u; k < u.giSpatial; ++k) {
                float2 d = concentricDisk(pcgFloat(smp.rng), pcgFloat(smp.rng)) * radius;
                int qx = (int)gid.x + (int)round(d.x), qy = (int)gid.y + (int)round(d.y);
                if (qx < 0 || qy < 0 || qx >= (int)u.width || qy >= (int)u.height) continue;
                uint q = (uint)qy * u.width + (uint)qx;
                device const GiSample& y = giPrev[q];
                if ((y.flags & 1u) == 0u) continue;
                if (dot(float3(y.n1[0], y.n1[1], y.n1[2]), bsdf1.n) < 0.9f) continue;
                if (abs(y.depth - own.depth) > 0.1f * max(own.depth, 1e-3f)) continue;
                GiCandidate c;
                float w;
                if (!giReconnect(bsdf1, x1, ng1, y, c, w)) continue;
                wSum += w;
                M += 1u;
                if (pcgFloat(smp.rng) * wSum < w) {
                    chosen = c;
                    chosenIsOwn = false;
                }
            }
            result.giCandidates = M;
            if (chosen.pHat > 0.0f && wSum > 0.0f) {
                float W = wSum / ((float)M * chosen.pHat);
                bool visible = true;
                if (!chosenIsOwn) {
                    ++rays;
                    ray shadow(x1 + ng1 * kRayEpsilon, chosen.dir, 1e-4f, chosen.distance > 0.0f ? max(chosen.distance - 2.0f * kRayEpsilon, 1e-4f) : 1e9f);
                    intersection_result<triangle_data> blocker = any.intersect(shadow, primary.accel);
                    visible = blocker.type == intersection_type::none;
                }
                if (visible) accumulate(radiance, chosen.fCos * chosen.radiance * W, 1u, u.clampIndirect);
            }
        } else if (giActive) {
            // The path ended at the first hit: nothing past it, and no sample for the neighbours.
            own.flags = 0u;
        }
        *giOut = own;
    }
    result.radiance = radiance;
    return result;
}

// ---- Visibility pass: the triangle under each pixel centre, rasterized -----------------------------
struct VisVertexOut {
    float4 position [[position]];
};

vertex VisVertexOut vis_vertex(uint vid [[vertex_id]], device const Vertex* verts [[buffer(0)]], device const uint* idx [[buffer(1)]],
                               constant RasterUniforms& r [[buffer(2)]]) {
    float3 p = f3(verts[idx[vid]].position) - f3(r.camPos);
    float x = dot(p, f3(r.right)), y = dot(p, f3(r.up)), z = dot(p, f3(r.forward));
    VisVertexOut o;
    // Clip x, y as the camera rays are generated (Uniforms), depth [0, 1] from nearZ to farZ.
    o.position = float4(x / (r.tanHalf * r.aspect), y / r.tanHalf, r.farZ * (z - r.nearZ) / (r.farZ - r.nearZ), z);
    return o;
}

fragment uint vis_fragment(VisVertexOut in [[stage_in]], uint primitiveId [[primitive_id]]) {
    return primitiveId;
}

kernel void pt_init(device PixelState* pixels [[buffer(0)]], constant Uniforms& u [[buffer(1)]],
                    device Reservoir* reservoirs [[buffer(2)]], device PrimarySurface* surfaces [[buffer(3)]],
                    device Reservoir* reservoirsB [[buffer(4)]], device PrimarySurface* surfacesB [[buffer(5)]],
                    device uint* guideHistograms [[buffer(6)]], device uint* guidePending [[buffer(7)]],
                    device GiSample* giA [[buffer(8)]], device GiSample* giB [[buffer(9)]],
                    uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= u.width || gid.y >= u.height) return;
    uint pixel = gid.y * u.width + gid.x;
    if (u.restirGi != 0u) {
        giA[pixel].flags = 0u;
        giB[pixel].flags = 0u;
    }
    if (u.guided != 0u) {
        // The first pixel of each tile clears the tile's counters.
        uint tile = max(u.guideTile, 1u);
        if (gid.x % tile == 0u && gid.y % tile == 0u) {
            uint tilesX = (u.width + tile - 1u) / tile;
            uint words = 2u * max(u.guideBands, 1u) * max(u.guideSectors, 1u);
            uint base = ((gid.y / tile) * tilesX + gid.x / tile) * words;
            for (uint b = 0u; b < words; ++b) { guideHistograms[base + b] = 0u; guidePending[base + b] = 0u; }
        }
    }
    if (u.restir != 0u) {
        Reservoir r;
        r.dir[0] = 0.0f; r.dir[1] = 1.0f; r.dir[2] = 0.0f;
        r.wSum = 0.0f; r.W = 0.0f; r.pHat = 0.0f; r.M = 0u; r.pad = 0u;
        reservoirs[pixel] = r;
        reservoirsB[pixel] = r;
        surfaces[pixel].valid = 0u;
        surfacesB[pixel].valid = 0u;
    }
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
                      primitive_acceleration_structure bounceAccel [[buffer(9)]], device const uint* bounceIdx [[buffer(10)]],
                      device const uint* bounceMaterials [[buffer(11)]],
                      texture2d<uint, access::read> visibility [[texture(0)]], constant PassUniforms& pass [[buffer(12)]],
                      device const uint* sobol [[buffer(13)]],
                      device Reservoir* reservoirs [[buffer(14)]], device PrimarySurface* surfaces [[buffer(15)]],
                      device const Reservoir* prevReservoirs [[buffer(16)]], device const PrimarySurface* prevSurfaces [[buffer(17)]],
                      device const uint* guideHistograms [[buffer(18)]], device atomic_uint* guidePending [[buffer(19)]],
                      device GiSample* giOut [[buffer(20)]], device const GiSample* giPrev [[buffer(21)]],
                      device const LightRecord* lightRecords [[buffer(22)]], device const LightNode* lightNodes [[buffer(23)]],
                      device const uint* triangleLight [[buffer(24)]],
                      uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= u.width || gid.y >= u.height) return;
    uint pixel = gid.y * u.width + gid.x;
    device PixelState* p = pixels + pixel;
    if (u.restir != 0u) surfaces[pixel].valid = 0u;
    uint guideIndex = 0u;
    if (u.guided != 0u) {
        uint tile = max(u.guideTile, 1u);
        uint tilesX = (u.width + tile - 1u) / tile;
        guideIndex = ((gid.y / tile) * tilesX + gid.x / tile) * (2u * max(u.guideBands, 1u) * max(u.guideSectors, 1u));
    }
    Sampler smp;
    smp.mode = u.sampler;
    smp.rng.state = p->rngState;
    smp.rng.inc = p->rngInc;
    smp.index = pass.sampleIndex;
    smp.dim = 0u;
    smp.pixelHash = hashU32(pixel ^ u.seedLo ^ (u.seedHi * 0x9e3779b9u));
    smp.sobol = sobol;
    smp.sobolDims = pass.sobolDims;
    const Geometry primary{accel, idx, triMaterials};
    const Geometry bounceGeo{bounceAccel, bounceIdx, bounceMaterials};
    const uint visibleTriangle = u.usePrimaryRaster != 0u ? visibility.read(gid).x : kNoMaterial;

    const float3 camPos = f3(u.camPos), forward = f3(u.forward), right = f3(u.right), upv = f3(u.up);
    float sx = ((float)gid.x + 0.5f + tentSample(nextSample(smp))) / (float)u.width;
    float sy = ((float)gid.y + 0.5f + tentSample(nextSample(smp))) / (float)u.height;
    float3 dir = normalize(forward + right * ((2.0f * sx - 1.0f) * u.tanHalf * u.aspect) + upv * ((1.0f - 2.0f * sy) * u.tanHalf));
    float3 origin = camPos;
    if (u.apertureRadius > 0.0f) {
        float l1 = nextSample(smp);
        float l2 = nextSample(smp);
        float2 lens = concentricDisk(l1, l2);
        float3 focusPoint = camPos + dir * (u.focusDistance / max(dot(dir, forward), 1e-4f));
        origin = camPos + (right * lens.x + upv * lens.y) * u.apertureRadius;
        dir = normalize(focusPoint - origin);
    }
    uint rays = 0u;
    const Lights lights{lightRecords, lightNodes, triangleLight, u.localLights, u.distantLights};
    PathResult s = tracePath(origin, dir, smp, u, verts, lut, primary, bounceGeo, materials, textures, visibleTriangle, rays,
                             reservoirs + pixel, surfaces + pixel, prevReservoirs, prevSurfaces, gid,
                             guideHistograms + guideIndex, guidePending + guideIndex,
                             giOut + (u.restirGi != 0u ? pixel : 0u), giPrev, lights);
    p->rays += rays;
    p->pad += s.giCandidates;
    p->rngState = smp.rng.state;
    p->rngInc = smp.rng.inc;
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

/** Between passes: the outcomes a pass recorded join the committed histograms, so the next pass reads a frozen guide. */
kernel void guide_commit(device uint* hist [[buffer(0)]], device uint* pending [[buffer(1)]], constant uint& words [[buffer(2)]],
                         uint id [[thread_position_in_grid]]) {
    if (id >= words) return;
    hist[id] += pending[id];
    pending[id] = 0u;
}

/**
 * ReSTIR spatial pass: each pixel's reservoir takes in those of a few random neighbours whose first hit
 * faces the same way at a similar depth, re-evaluating the neighbour's direction at this pixel's surface.
 * Runs between sample passes; the next pass shades the combined choice.
 */
kernel void restir_spatial(device const Reservoir* in [[buffer(0)]], device Reservoir* out [[buffer(1)]],
                           device const PrimarySurface* surfaces [[buffer(2)]], constant Uniforms& u [[buffer(3)]],
                           device const float* lut [[buffer(4)]], constant PassUniforms& pass [[buffer(5)]],
                           uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= u.width || gid.y >= u.height) return;
    uint pixel = gid.y * u.width + gid.x;
    Reservoir r = in[pixel];
    PrimarySurface s = surfaces[pixel];
    if (s.valid == 0u || u.restirSpatial == 0u) { out[pixel] = r; return; }
    float3 position = f3(s.position), n = f3(s.shadingNormal), ng = f3(s.geometricNormal);
    float3 wo = normalize(f3(u.camPos) - position);
    Bsdf bsdf = makeBsdf(n, f3(s.baseColor), s.metallic, s.roughness, wo);
    Pcg32 rng = pcgSeed(((ulong)u.seedHi << 32) | (ulong)u.seedLo, ((ulong)pixel << 20) ^ (ulong)(pass.sampleIndex * 7919u + 1u));
    const float radius = 16.0f;
    float3 chosen = f3(r.dir);
    for (uint k = 0u; k < u.restirSpatial; ++k) {
        float2 d = concentricDisk(pcgFloat(rng), pcgFloat(rng)) * radius;
        int qx = (int)gid.x + (int)round(d.x), qy = (int)gid.y + (int)round(d.y);
        if (qx < 0 || qy < 0 || qx >= (int)u.width || qy >= (int)u.height) continue;
        uint q = (uint)qy * u.width + (uint)qx;
        if (q == pixel) continue;
        PrimarySurface sq = surfaces[q];
        if (sq.valid == 0u) continue;
        if (dot(f3(sq.shadingNormal), n) < 0.9f) continue;
        if (abs(sq.depth - s.depth) > 0.1f * max(s.depth, 1e-3f)) continue;
        Reservoir nr = in[q];
        if (nr.M == 0u) continue;
        float3 wi = f3(nr.dir);
        float pHatHere = nr.W > 0.0f ? restirTarget(u, lut, bsdf, ng, wi) : 0.0f;
        float w = pHatHere * nr.W * (float)nr.M;
        r.wSum += w;
        r.M += nr.M;
        if (w > 0.0f && pcgFloat(rng) * r.wSum < w) {
            chosen = wi;
            r.pHat = pHatHere;
        }
    }
    restirClamp(r, kRestirHistoryFactor * max(u.restirCandidates, 1u));
    r.W = r.pHat > 0.0f ? r.wSum / ((float)r.M * r.pHat) : 0.0f;
    r.dir[0] = chosen.x; r.dir[1] = chosen.y; r.dir[2] = chosen.z;
    out[pixel] = r;
}

// ---- Display (port of view::toDisplayImage: exposure, then the AgX view transform) -------------------
struct DisplayUniforms {
    uint width, height, spp, fromDenoised;
    float scale, pad0, pad1, pad2;
};

inline float agxContrast(float x) {
    float x2 = x * x;
    float x4 = x2 * x2;
    return 15.5f * x4 * x2 - 40.14f * x4 * x + 31.96f * x4 - 6.868f * x2 * x + 0.4298f * x2 + 0.1191f * x - 0.00232f;
}

inline float3 agxDisplay(float3 rgb) {
    const float minEv = -12.47393f, maxEv = 4.026069f;
    float3 v = float3(0.842479062253094f * rgb.x + 0.0784335999999992f * rgb.y + 0.0792237451477643f * rgb.z,
                      0.0423282422610123f * rgb.x + 0.878468636469772f * rgb.y + 0.0791661274605434f * rgb.z,
                      0.0423756549057051f * rgb.x + 0.0784336f * rgb.y + 0.879142973793104f * rgb.z);
    for (int c = 0; c < 3; ++c) {
        float x = log2(max(v[c], 1e-10f));
        x = (clamp(x, minEv, maxEv) - minEv) / (maxEv - minEv);
        v[c] = agxContrast(x);
    }
    float3 o = float3(1.19687900512017f * v.x - 0.0980208811401368f * v.y - 0.0990297440797205f * v.z,
                      -0.0528968517574562f * v.x + 1.15190312990417f * v.y - 0.0989611768448433f * v.z,
                      -0.0529716355144438f * v.x - 0.0980434501171241f * v.y + 1.15107367264116f * v.z);
    return clamp(o, 0.0f, 1.0f);
}

/** The frame as the viewer shows it: the denoised colour or the accumulated mean, exposed and AgX-mapped, as RGBA8. */
kernel void pt_display(device const PixelState* pixels [[buffer(0)]], device const float* denoised [[buffer(1)]],
                       constant DisplayUniforms& d [[buffer(2)]], texture2d<float, access::write> out [[texture(0)]],
                       uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= d.width || gid.y >= d.height) return;
    uint i = gid.y * d.width + gid.x;
    float3 c = d.fromDenoised != 0u
        ? float3(denoised[i * 3], denoised[i * 3 + 1], denoised[i * 3 + 2])
        : float3(pixels[i].color[0], pixels[i].color[1], pixels[i].color[2]) / (float)max(d.spp, 1u);
    c = float3(isfinite(c.x) ? c.x : 0.0f, isfinite(c.y) ? c.y : 0.0f, isfinite(c.z) ? c.z : 0.0f);
    out.write(float4(agxDisplay(c * d.scale), 1.0f), gid);
}
)METAL";

/**
 * Port of denoise::denoiseATrous (scratchbox_denoise.hpp) plus temporal reuse: dn_prepare demodulates the
 * frame's mean colour by its albedo, folds in the previous view's reprojected illumination, and writes the
 * guides; dn_blur and dn_atrous are one filter iteration (variance blur, then the edge-avoiding 5x5 tap at
 * the iteration's step); dn_finish remodulates and keeps the history for the next view.
 */
inline const char* const kDenoiseKernelSource = R"METAL(
struct DenoiseUniforms {
    uint width, height, spp, step;
    float sigmaNormal, sigmaDepth, sigmaLuminance, albedoFloor;
    uint useHistory, historyCap, prevWidth, prevHeight;
    float camPos[3], tanHalf;
    float forward[3], aspect;
    float right[3], pad0;
    float up[3], pad1;
    float prevCamPos[3], prevTanHalf;
    float prevForward[3], prevAspect;
    float prevRight[3], pad2;
    float prevUp[3], pad3;
};

struct DenoisePixel {
    float illum[3];
    float variance;
    float normal[3];
    float depth;
    float gradX, gradY;
    uint mask, pad;
};

struct HistoryPixel {
    float illum[3];
    float samples;
    float normal[3];
    float depth;
};

inline float3 dnAlbedo(device const PixelState& p, float floorValue) {
    float inv = p.hits > 0u ? 1.0f / (float)p.hits : 0.0f;
    return max(float3(p.albedo[0], p.albedo[1], p.albedo[2]) * inv, float3(floorValue));
}

inline bool dnMask(device const PixelState& p, uint spp) { return p.hits * 2u >= spp; }

inline float dnDepth(device const PixelState& p) { return p.hits > 0u ? p.depth / (float)p.hits : 0.0f; }

inline float normalWeight(float cosine, float sigma) {
    float x = max(cosine, 0.0f);
    if (sigma == 128.0f) {
        for (int i = 0; i < 7; ++i) x *= x;
        return x;
    }
    return pow(x, sigma);
}

/** Camera ray through the centre of pixel (x, y) of the current view. */
inline float3 dnRayDir(constant DenoiseUniforms& u, uint x, uint y) {
    float sx = ((float)x + 0.5f) / (float)u.width;
    float sy = ((float)y + 0.5f) / (float)u.height;
    return normalize(f3(u.forward) + f3(u.right) * ((2.0f * sx - 1.0f) * u.tanHalf * u.aspect) + f3(u.up) * ((1.0f - 2.0f * sy) * u.tanHalf));
}

kernel void dn_prepare(device const PixelState* pixels [[buffer(0)]], constant DenoiseUniforms& u [[buffer(1)]],
                       device DenoisePixel* out [[buffer(2)]], device const HistoryPixel* history [[buffer(3)]],
                       device uint* historyHits [[buffer(4)]], uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= u.width || gid.y >= u.height) return;
    uint i = gid.y * u.width + gid.x;
    device const PixelState& p = pixels[i];
    DenoisePixel d;
    float3 nsum = float3(p.normal[0], p.normal[1], p.normal[2]);
    float3 n = dot(nsum, nsum) > 0.0f ? normalize(nsum) : float3(0.0f);
    d.normal[0] = n.x; d.normal[1] = n.y; d.normal[2] = n.z;
    d.mask = dnMask(p, u.spp) ? 1u : 0u;
    d.pad = 0u;
    d.gradX = 0.0f; d.gradY = 0.0f;
    d.depth = dnDepth(p);
    const float inv = 1.0f / (float)max(u.spp, 1u);
    float3 color = float3(p.color[0], p.color[1], p.color[2]) * inv;
    if (d.mask == 0u) {
        d.illum[0] = 0.0f; d.illum[1] = 0.0f; d.illum[2] = 0.0f;
        d.variance = 0.0f;
        out[i] = d;
        return;
    }
    float3 a = dnAlbedo(p, u.albedoFloor);
    float3 illum = color / a;
    float la = max(luminance(a), u.albedoFloor);
    float mean = p.lum * inv;
    float var = max(0.0f, p.lumSq * inv - mean * mean) * inv;
    float variance = max(var, 0.0f) / (la * la);
    float samples = (float)u.spp;

    // Temporal reuse: the previous view's illumination at this surface point, when it saw the same surface.
    if (u.useHistory != 0u && u.prevWidth > 0u && u.prevHeight > 0u) {
        float3 world = f3(u.camPos) + dnRayDir(u, gid.x, gid.y) * d.depth;
        float3 v = world - f3(u.prevCamPos);
        float z = dot(v, f3(u.prevForward));
        if (z > 1e-4f) {
            float ndcX = dot(v, f3(u.prevRight)) / (z * u.prevTanHalf * u.prevAspect);
            float ndcY = dot(v, f3(u.prevUp)) / (z * u.prevTanHalf);
            float px = (ndcX + 1.0f) * 0.5f * (float)u.prevWidth;
            float py = (1.0f - ndcY) * 0.5f * (float)u.prevHeight;
            if (px >= 0.0f && py >= 0.0f && px < (float)u.prevWidth && py < (float)u.prevHeight) {
                uint hi = (uint)py * u.prevWidth + (uint)px;
                device const HistoryPixel& h = history[hi];
                float dist = length(v);
                float3 hn = float3(h.normal[0], h.normal[1], h.normal[2]);
                if (h.samples > 0.0f && abs(h.depth - dist) <= 0.02f * max(dist, 1e-3f) && dot(hn, n) > 0.8f) {
                    float hs = min(h.samples, (float)u.historyCap);
                    float3 hillum = float3(h.illum[0], h.illum[1], h.illum[2]);
                    float wc = samples / (samples + hs);
                    illum = hillum * (1.0f - wc) + illum * wc;
                    variance = variance * wc * wc;
                    samples = samples + hs;
                    historyHits[i] = 1u;
                }
            }
        }
    }
    d.illum[0] = illum.x; d.illum[1] = illum.y; d.illum[2] = illum.z;
    d.variance = variance;
    // The sample count rides in pad for dn_finish to carry into the next history.
    d.pad = as_type<uint>(samples);
    out[i] = d;
}

kernel void dn_gradients(device DenoisePixel* px [[buffer(0)]], constant DenoiseUniforms& u [[buffer(1)]],
                         uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= u.width || gid.y >= u.height) return;
    uint i = gid.y * u.width + gid.x;
    if (px[i].mask == 0u) return;
    float z = px[i].depth;
    auto depthAt = [&](int x, int y) {
        if (x < 0 || y < 0 || x >= (int)u.width || y >= (int)u.height) return z;
        uint q = (uint)y * u.width + (uint)x;
        return px[q].mask != 0u ? px[q].depth : z;
    };
    int x = (int)gid.x, y = (int)gid.y;
    px[i].gradX = min(abs(depthAt(x + 1, y) - z), abs(z - depthAt(x - 1, y)));
    px[i].gradY = min(abs(depthAt(x, y + 1) - z), abs(z - depthAt(x, y - 1)));
}

kernel void dn_blur(device const DenoisePixel* px [[buffer(0)]], constant DenoiseUniforms& u [[buffer(1)]],
                    device float* blurred [[buffer(2)]], uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= u.width || gid.y >= u.height) return;
    uint i = gid.y * u.width + gid.x;
    if (px[i].mask == 0u) { blurred[i] = px[i].variance; return; }
    const float gauss3[3] = {0.25f, 0.5f, 0.25f};
    float sum = 0.0f, weight = 0.0f;
    for (int dy = -1; dy <= 1; ++dy) {
        for (int dx = -1; dx <= 1; ++dx) {
            int qx = (int)gid.x + dx, qy = (int)gid.y + dy;
            if (qx < 0 || qy < 0 || qx >= (int)u.width || qy >= (int)u.height) continue;
            uint q = (uint)qy * u.width + (uint)qx;
            if (px[q].mask == 0u) continue;
            float k = gauss3[dx + 1] * gauss3[dy + 1];
            sum += px[q].variance * k;
            weight += k;
        }
    }
    blurred[i] = weight > 0.0f ? sum / weight : px[i].variance;
}

kernel void dn_atrous(device const DenoisePixel* src [[buffer(0)]], constant DenoiseUniforms& u [[buffer(1)]],
                      device const float* blurred [[buffer(2)]], device DenoisePixel* dst [[buffer(3)]],
                      uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= u.width || gid.y >= u.height) return;
    uint p = gid.y * u.width + gid.x;
    DenoisePixel d = src[p];
    if (d.mask == 0u) { dst[p] = d; return; }
    const float kernel5[5] = {1.0f / 16.0f, 1.0f / 4.0f, 3.0f / 8.0f, 1.0f / 4.0f, 1.0f / 16.0f};
    const int step = (int)u.step;
    const float3 ip = float3(d.illum[0], d.illum[1], d.illum[2]);
    const float lp = luminance(ip);
    const float zp = d.depth;
    const float3 np = float3(d.normal[0], d.normal[1], d.normal[2]);
    const float sigmaL = u.sigmaLuminance * sqrt(blurred[p]) + 1e-4f;
    float3 sumColor = float3(0.0f);
    float sumWeight = 0.0f, sumVariance = 0.0f;
    for (int ky = -2; ky <= 2; ++ky) {
        for (int kx = -2; kx <= 2; ++kx) {
            int qx = (int)gid.x + kx * step, qy = (int)gid.y + ky * step;
            if (qx < 0 || qy < 0 || qx >= (int)u.width || qy >= (int)u.height) continue;
            uint q = (uint)qy * u.width + (uint)qx;
            device const DenoisePixel& s = src[q];
            if (s.mask == 0u) continue;
            float wgt = kernel5[kx + 2] * kernel5[ky + 2];
            float3 iq = float3(s.illum[0], s.illum[1], s.illum[2]);
            if (q != p) {
                float wn = normalWeight(dot(np, float3(s.normal[0], s.normal[1], s.normal[2])), u.sigmaNormal);
                float expectedDz = d.gradX * abs((float)(kx * step)) + d.gradY * abs((float)(ky * step));
                float wz = exp(-abs(zp - s.depth) / (u.sigmaDepth * expectedDz + 1e-3f * max(zp, 1.0f)));
                float wl = exp(-abs(lp - luminance(iq)) / sigmaL);
                wgt *= wn * wz * wl;
            }
            sumColor += iq * wgt;
            sumWeight += wgt;
            sumVariance += s.variance * wgt * wgt;
        }
    }
    float3 o = sumColor / sumWeight;
    d.illum[0] = o.x; d.illum[1] = o.y; d.illum[2] = o.z;
    d.variance = sumVariance / (sumWeight * sumWeight);
    dst[p] = d;
}

/** Remodulates by albedo into `color` (3 floats per pixel; background keeps the mean colour) and records the history. */
kernel void dn_finish(device const PixelState* pixels [[buffer(0)]], constant DenoiseUniforms& u [[buffer(1)]],
                      device const DenoisePixel* px [[buffer(2)]], device float* color [[buffer(3)]],
                      device HistoryPixel* history [[buffer(4)]], uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= u.width || gid.y >= u.height) return;
    uint i = gid.y * u.width + gid.x;
    device const PixelState& p = pixels[i];
    const float inv = 1.0f / (float)max(u.spp, 1u);
    float3 c = float3(p.color[0], p.color[1], p.color[2]) * inv;
    HistoryPixel h;
    h.samples = 0.0f;
    h.depth = px[i].depth;
    h.normal[0] = px[i].normal[0]; h.normal[1] = px[i].normal[1]; h.normal[2] = px[i].normal[2];
    h.illum[0] = px[i].illum[0]; h.illum[1] = px[i].illum[1]; h.illum[2] = px[i].illum[2];
    if (px[i].mask != 0u) {
        float3 a = dnAlbedo(p, u.albedoFloor);
        c = float3(px[i].illum[0], px[i].illum[1], px[i].illum[2]) * a;
        h.samples = as_type<float>(px[i].pad);
    }
    color[i * 3] = c.x; color[i * 3 + 1] = c.y; color[i * 3 + 2] = c.z;
    history[i] = h;
}
)METAL";

} // namespace metalpt
} // namespace scratchbox

#endif // SCRATCHBOX_METAL_PATHTRACER_KERNELS_HPP
