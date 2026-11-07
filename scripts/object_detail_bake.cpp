/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Pipe CLI for scratchbox_object_detail.hpp: per-part weathering and decals ('SBOD'). One request on stdin, one reply
// on stdout, no files. Built and run by packages/core/src/node/3d-engine/object-detail-pass.ts.
//
// Build:  clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/object_detail_bake.cpp -o build/3d-native/object_detail_bake -pthread
//
// SBOD (little endian): u32 version=2, u32 A (atlases), S (surfaces), G (parts), D (decals), O (occluder triangles),
//        flags (1 masks, 2 ground), threads; f64[32] wear (edgeWear, grime, streaks, dust, sunFade, variation,
//        edgeWidthM, creaseWidthM, aoRadiusM, streakReachM, streakColumnM, patchScaleM, chipScaleM, chipNoise,
//        openEdgeAngle, grimeColor[3], streakColor[3], dustColor[3], grimeRoughness, streakRoughness, dustRoughness,
//        aoSamples, groundY, weldM, rayEpsM, seed); f64[7] mesh maps (curvatureRadiusM, cavityRadiusM, thinM,
//        curvatureWear, cavityGrime, thinLight, thicknessSamples);
//        per atlas: u32 W, H, gutter, hasBase, hasMr; f32 baseFactor[4], roughness, metalness, transmission, texelM;
//                   u8[4WH] base?, u8[4WH] mr?
//        per part: f32 edgeWear, grime, streaks, dust, sunFade; u32 hasEdgeColor; f32 edgeColor[3], edgeRoughness, edgeMetalness
//        per surface: u32 atlas, part, V, T, hasNormals; f32[3V] pos, f32[3V] nrm?, f32[2V] uv (texels), u32[3T] idx
//        occluders: f32[9O]
//        per decal: u32 n; u32[n] parts; f32 center[3], normal[3], up[3], width, height, depth, opacity, maxAngleDeg,
//                   roughness, metalness, finishMix; u32 w, h; u8[4wh]
//   -> 'SBOO' u32 version=2, A, G, D, convexEdges, concaveEdges, openEdges; f64 msEdges, msBvh, msMasks, msComposite, msDilate,
//        curvatureRadiusM, cavityRadiusM (as read);
//        per atlas: u32 W, H, hasMasks; f64[9] stats (texels, edge, grime, streak, dust, exposure, decal, cavity, thin);
//                   u8[4WH] base, u8[4WH] mr, masks?: u8[4WH] edge/grime/streak/dust, u8[4WH] exposure/decal/occlusion/convexity,
//                   u8[4WH] curvature/cavity/thickness/ao
//        per part: f64[9] stats; per decal: f64 texels

#include "scratchbox_object_detail.hpp"

#include <cstdio>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <vector>

namespace {

template <typename T> void readN(std::vector<T>& v, size_t n, const char* what) {
    v.resize(n);
    if (n && std::fread(v.data(), sizeof(T), n, stdin) != n) throw std::runtime_error(std::string("truncated input reading ") + what);
}
template <typename T> T readOne(const char* what) {
    T v;
    if (std::fread(&v, sizeof(T), 1, stdin) != 1) throw std::runtime_error(std::string("truncated input reading ") + what);
    return v;
}
template <typename T> void writeN(const T* p, size_t n) { if (n) std::fwrite(p, sizeof(T), n, stdout); }

void checkFinite(const std::vector<float>& a, const char* what) {
    for (float f : a) if (!std::isfinite(f)) throw std::runtime_error(std::string(what) + ": non-finite value");
}

void writeStats(const scratchbox::object_detail::MaskStats& s) {
    const double v[9] = {s.texels, s.edge, s.grime, s.streak, s.dust, s.exposure, s.decal, s.cavity, s.thin};
    writeN(v, 9);
}

int run() {
    using namespace scratchbox::object_detail;
    using scratchbox::math::Vec3;
    if (readOne<uint32_t>("version") != 2) throw std::runtime_error("unsupported SBOD version");
    const uint32_t A = readOne<uint32_t>("A"), S = readOne<uint32_t>("S"), G = readOne<uint32_t>("G"), D = readOne<uint32_t>("D"), O = readOne<uint32_t>("O");
    const uint32_t flags = readOne<uint32_t>("flags");
    DetailInput in;
    in.threads = readOne<uint32_t>("threads");
    in.wantMasks = (flags & 1u) != 0;
    std::vector<double> w;
    readN(w, 39, "wear");
    for (double x : w) if (!std::isfinite(x)) throw std::runtime_error("wear: non-finite value");
    WearParams& P = in.wear;
    P.edgeWear = float(w[0]); P.grime = float(w[1]); P.streaks = float(w[2]); P.dust = float(w[3]); P.sunFade = float(w[4]); P.variation = float(w[5]);
    P.edgeWidthM = float(w[6]); P.creaseWidthM = float(w[7]); P.aoRadiusM = float(w[8]); P.streakReachM = float(w[9]); P.streakColumnM = float(w[10]);
    P.patchScaleM = float(w[11]); P.chipScaleM = float(w[12]); P.chipNoise = float(w[13]); P.openEdgeAngle = float(w[14]);
    P.grimeColor = Vec3(float(w[15]), float(w[16]), float(w[17]));
    P.streakColor = Vec3(float(w[18]), float(w[19]), float(w[20]));
    P.dustColor = Vec3(float(w[21]), float(w[22]), float(w[23]));
    P.grimeRoughness = float(w[24]); P.streakRoughness = float(w[25]); P.dustRoughness = float(w[26]);
    P.aoSamples = static_cast<int>(std::clamp(w[27], 4.0, 256.0));
    P.groundY = float(w[28]); P.weldM = float(w[29]); P.rayEpsM = float(w[30]); P.seed = static_cast<uint32_t>(w[31]);
    P.curvatureRadiusM = float(w[32]); P.cavityRadiusM = float(w[33]); P.thinM = float(w[34]);
    P.curvatureWear = float(w[35]); P.cavityGrime = float(w[36]); P.thinLight = float(w[37]); P.thicknessSamples = static_cast<int>(std::clamp(w[38], 0.0, 64.0));
    P.ground = (flags & 2u) != 0;
    if (!(P.edgeWidthM > 0) || !(P.creaseWidthM > 0) || !(P.aoRadiusM > 0) || !(P.streakReachM > 0) || !(P.curvatureRadiusM > 0) || !(P.cavityRadiusM > 0) || !(P.thinM > 0)) throw std::runtime_error("wear widths and radii must be positive");

    in.atlases.resize(A);
    for (auto& at : in.atlases) {
        at.width = readOne<uint32_t>("W");
        at.height = readOne<uint32_t>("H");
        at.gutter = readOne<uint32_t>("gutter");
        const uint32_t hasBase = readOne<uint32_t>("hasBase"), hasMr = readOne<uint32_t>("hasMr");
        for (float& f : at.baseFactor) f = readOne<float>("baseFactor");
        at.roughness = readOne<float>("roughness");
        at.metalness = readOne<float>("metalness");
        at.transmission = readOne<float>("transmission");
        at.texelM = readOne<float>("texelM");
        if (!at.width || !at.height || size_t(at.width) * at.height > size_t(8192) * 8192) throw std::runtime_error("bad atlas size");
        if (hasBase) readN(at.base, size_t(at.width) * at.height * 4, "base colour");
        if (hasMr) readN(at.mr, size_t(at.width) * at.height * 4, "metallic-roughness");
    }
    in.parts.resize(G);
    for (auto& p : in.parts) {
        p.edgeWear = readOne<float>("part edgeWear");
        p.grime = readOne<float>("part grime");
        p.streaks = readOne<float>("part streaks");
        p.dust = readOne<float>("part dust");
        p.sunFade = readOne<float>("part sunFade");
        p.hasEdgeColor = readOne<uint32_t>("part hasEdgeColor") != 0;
        const float r = readOne<float>("edge r"), g = readOne<float>("edge g"), b = readOne<float>("edge b");
        p.edgeColor = Vec3(r, g, b);
        p.edgeRoughness = readOne<float>("part edgeRoughness");
        p.edgeMetalness = readOne<float>("part edgeMetalness");
    }
    in.surfaces.resize(S);
    for (auto& s : in.surfaces) {
        s.atlas = readOne<uint32_t>("surface atlas");
        s.part = readOne<uint32_t>("surface part");
        const uint32_t V = readOne<uint32_t>("V"), T = readOne<uint32_t>("T"), hasN = readOne<uint32_t>("hasNormals");
        if (s.atlas >= A) throw std::runtime_error("surface atlas out of range");
        if (s.part >= G) throw std::runtime_error("surface part out of range");
        readN(s.pos, size_t(V) * 3, "surface positions");
        if (hasN) readN(s.nrm, size_t(V) * 3, "surface normals");
        readN(s.uvPx, size_t(V) * 2, "surface uv");
        readN(s.idx, size_t(T) * 3, "surface indices");
        for (uint32_t i : s.idx) if (i >= V) throw std::runtime_error("surface index out of range");
        checkFinite(s.pos, "surface positions");
        checkFinite(s.uvPx, "surface uv");
    }
    readN(in.occluders, size_t(O) * 9, "occluders");
    checkFinite(in.occluders, "occluders");
    in.decals.resize(D);
    for (auto& d : in.decals) {
        const uint32_t n = readOne<uint32_t>("decal parts");
        readN(d.parts, n, "decal part list");
        for (uint32_t p : d.parts) if (p >= G) throw std::runtime_error("decal part out of range");
        float f[17];
        for (float& x : f) { x = readOne<float>("decal"); if (!std::isfinite(x)) throw std::runtime_error("decal: non-finite value"); }
        d.center = Vec3(f[0], f[1], f[2]); d.normal = Vec3(f[3], f[4], f[5]); d.up = Vec3(f[6], f[7], f[8]);
        d.widthM = f[9]; d.heightM = f[10]; d.depthM = f[11]; d.opacity = f[12]; d.maxAngleDeg = f[13];
        d.roughness = f[14]; d.metalness = f[15]; d.finishMix = f[16];
        if (!(d.widthM > 0) || !(d.heightM > 0) || !(d.depthM > 0) || d.normal.length() < 1e-6f) throw std::runtime_error("decal: size, depth and normal must be positive");
        d.width = readOne<uint32_t>("decal width");
        d.height = readOne<uint32_t>("decal height");
        if (!d.width || !d.height || size_t(d.width) * d.height > size_t(8192) * 8192) throw std::runtime_error("bad decal image size");
        readN(d.rgba, size_t(d.width) * d.height * 4, "decal pixels");
    }

    const DetailOutput r = bake(in);

    std::fwrite("SBOO", 1, 4, stdout);
    const uint32_t head[7] = {2, A, G, D, r.convexEdges, r.concaveEdges, r.openEdges};
    writeN(head, 7);
    const double ms[7] = {r.msEdges, r.msBvh, r.msMasks, r.msComposite, r.msDilate, r.curvatureRadiusM, r.cavityRadiusM};
    writeN(ms, 7);
    for (const auto& at : r.atlases) {
        const uint32_t ah[3] = {at.width, at.height, in.wantMasks ? 1u : 0u};
        writeN(ah, 3);
        writeStats(at.stats);
        writeN(at.base.data(), at.base.size());
        writeN(at.mr.data(), at.mr.size());
        if (in.wantMasks) { writeN(at.masksA.data(), at.masksA.size()); writeN(at.masksB.data(), at.masksB.size()); writeN(at.maps.data(), at.maps.size()); }
    }
    for (const auto& p : r.parts) writeStats(p);
    for (uint64_t t : r.decalTexels) { const double v = double(t); writeN(&v, 1); }
    std::fflush(stdout);
    return 0;
}

}  // namespace

int main() {
    try {
        char magic[4];
        if (std::fread(magic, 1, 4, stdin) != 4) throw std::runtime_error("no request");
        if (std::memcmp(magic, "SBOD", 4) != 0) throw std::runtime_error("unknown request magic");
        return run();
    } catch (const std::exception& e) {
        std::cerr << "object_detail_bake: " << e.what() << "\n";
        return 2;
    }
}
