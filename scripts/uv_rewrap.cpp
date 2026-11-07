/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Pipe CLI for scratchbox_uv_rewrap.hpp: unwrap + pack ('SBUW') and texture rebake ('SBRB'). One request on stdin, one
// reply on stdout, no files. Built and run by packages/core/src/node/spatial/UvAtlasRewrap.ts.
//
// Build:  clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/uv_rewrap.cpp -o build/3d-native/uv_rewrap
//
// SBUW (little endian): u32 version=1|2, u32 V, u32 T, f64[15] params (chartNormalToleranceDeg, minIslandAreaM2,
//        maxAngleStretch, maxAreaDistortion, splitToleranceFactor, minToleranceDeg, conformal, lscmMaxIterations,
//        lscmRelTolerance, texelsPerMeter, atlasWidth, atlasHeight, maxSide, gutter, allowRotation),
//        version 2 only: f64[6] (segmentation, parameterization, packing, abf, slimIterations, packRotations);
//        version 1 runs the original normal-cluster / LSCM / skyline path,
//        f32[3V] positions, u32[3T] indices, u32[T] group
//   -> 'SBUO' u32 version (as requested), outV, T, C, W, H, lscmAttempts, lscmAccepted, splits,
//        version 2 only: u32 abfAccepted, slimAccepted, grownCharts,
//        f64 texelsPerMeter, requestedTexelsPerMeter, utilisation, overlappingPairs, msCharts, msPack,
//        u32[outV] sourceVertex, f32[2 outV] uv, u32[3T] indices, u32[T] chart, f64[24 C] chart records
//        (version 2: f64[26 C], adding abfIterations, slimIterations)
//
// SBRB: u32 version=1, W, H, gutter, transfer, S, M (materials), I (images), threads; f64 edgeTexels, maxDistance,
//        maxNormalAngleDeg; u32[S] slot kind (0 linear, 1 sRGB, 2 tangent-space normal);
//        target: u32 Vt, Tt, hasNormals, hasTangents; f32[2Vt] uv (texels), f32[3Vt] pos, f32[3Vt] nrm?, f32[4Vt] tan?,
//                u32[3Tt] idx;
//        source (transfer): u32 Vs, Ts, hasNormals, hasTangents; f32[3Vs] pos, f32[3Vs] nrm?, f32[4Vs] tan?,
//                f32[S 2Vs] uv, u32[3Ts] idx, u32[Ts] material
//        source (same mesh): u32 hasTangents; f32[4Vt] tan?, f32[S 2Vt] uv, u32[Tt] material
//        materials: (i32 image, u32 wrapS, u32 wrapT, f32[4] factor) per material per slot
//        images: u32 w, u32 h, u8[4wh] each
//   -> 'SBRO' u32 version, S, W, H; u64 interior, edge, dilated, empty, unresolved;
//        f64 meanTransferDistance, maxTransferDistance, msRaster, msShade, msDilate, msBvh; u8[4WH] per slot

#include "scratchbox_uv_rewrap.hpp"

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
template <typename T> void writeOne(T v) { std::fwrite(&v, sizeof(T), 1, stdout); }

void checkIndices(const std::vector<uint32_t>& idx, size_t V, const char* what) {
    for (uint32_t i : idx) if (i >= V) throw std::runtime_error(std::string(what) + ": index out of range");
}
void checkFinite(const std::vector<float>& a, const char* what) {
    for (float f : a) if (!std::isfinite(f)) throw std::runtime_error(std::string(what) + ": non-finite value");
}

int runUnwrap() {
    using namespace scratchbox::uv_rewrap;
    const uint32_t version = readOne<uint32_t>("version");
    if (version != 1 && version != 2) throw std::runtime_error("unsupported SBUW version");
    const uint32_t V = readOne<uint32_t>("V"), T = readOne<uint32_t>("T");
    std::vector<double> p;
    readN(p, version == 2 ? 21 : 15, "params");
    UnwrapParams prm;
    prm.chartNormalToleranceDeg = p[0];
    prm.minIslandAreaM2 = p[1];
    prm.maxAngleStretch = p[2];
    prm.maxAreaDistortion = p[3];
    prm.splitToleranceFactor = std::clamp(p[4], 0.05, 0.95);
    prm.minToleranceDeg = std::max(0.01, p[5]);
    prm.conformal = p[6] != 0;
    prm.lscmMaxIterations = static_cast<int>(p[7]);
    prm.lscmRelTolerance = p[8];
    prm.texelsPerMeter = p[9];
    prm.atlasWidth = static_cast<uint32_t>(p[10]);
    prm.atlasHeight = static_cast<uint32_t>(p[11]);
    prm.maxSide = static_cast<uint32_t>(p[12]);
    prm.gutter = static_cast<uint32_t>(p[13]);
    prm.allowRotation = p[14] != 0;
    if (version == 2) {
        prm.segmentation = p[15] != 0 ? 1 : 0;
        prm.parameterization = p[16] != 0 ? 1 : 0;
        prm.packing = p[17] != 0 ? 1 : 0;
        prm.abf = p[18] != 0;
        prm.slimIterations = static_cast<int>(std::clamp(p[19], 0.0, 1000.0));
        prm.packRotations = p[20] >= 4 ? 4 : p[20] >= 2 ? 2 : 1;
    } else {
        prm.segmentation = 0; prm.parameterization = 0; prm.packing = 0;
    }
    std::vector<float> pos;
    std::vector<uint32_t> idx, grp;
    readN(pos, size_t(V) * 3, "positions");
    readN(idx, size_t(T) * 3, "indices");
    readN(grp, T, "groups");
    checkIndices(idx, V, "indices");
    checkFinite(pos, "positions");
    if (T == 0) throw std::runtime_error("no triangles");

    auto r = unwrap(pos.data(), V, idx.data(), T, grp.data(), prm);

    std::fwrite("SBUO", 1, 4, stdout);
    const uint32_t C = static_cast<uint32_t>(r.charts.size());
    const uint32_t head[9] = {version, static_cast<uint32_t>(r.sourceVertex.size()), T, C, r.width, r.height, r.lscmAttempts, r.lscmAccepted, r.splits};
    writeN(head, 9);
    if (version == 2) { const uint32_t more[3] = {r.abfAccepted, r.slimAccepted, r.grownCharts}; writeN(more, 3); }
    const double stats[6] = {r.texelsPerMeter, r.requestedTexelsPerMeter, r.utilisation, double(r.overlappingPairs), r.msCharts, r.msPack};
    writeN(stats, 6);
    writeN(r.sourceVertex.data(), r.sourceVertex.size());
    writeN(r.uv.data(), r.uv.size());
    writeN(r.indices.data(), r.indices.size());
    writeN(r.triangleChart.data(), r.triangleChart.size());
    std::vector<double> rec;
    const size_t per = version == 2 ? 26 : 24;
    rec.reserve(size_t(C) * per);
    for (const auto& c : r.charts) {
        const double v[24] = {double(c.method), double(c.group), double(c.triangles), double(c.splitDepth), double(c.overThreshold), double(c.lscmIterations),
                              c.orthoDistortion.stretchRms, c.orthoDistortion.stretchMax, c.orthoDistortion.areaRms, c.orthoDistortion.areaMax, double(c.orthoDistortion.flipped),
                              c.distortion.stretchRms, c.distortion.stretchMax, c.distortion.areaRms, c.distortion.areaMax, double(c.distortion.flipped), c.distortion.area3D,
                              c.widthM, c.heightM, double(c.x), double(c.y), double(c.w), double(c.h), double(c.rotated)};
        rec.insert(rec.end(), v, v + 24);
        if (version == 2) { rec.push_back(double(c.abfIterations)); rec.push_back(double(c.slimIterations)); }
    }
    writeN(rec.data(), rec.size());
    std::fflush(stdout);
    return 0;
}

int runBake() {
    using namespace scratchbox::uv_rewrap;
    if (readOne<uint32_t>("version") != 1) throw std::runtime_error("unsupported SBRB version");
    BakeParams prm;
    prm.width = readOne<uint32_t>("W");
    prm.height = readOne<uint32_t>("H");
    prm.gutter = readOne<uint32_t>("gutter");
    prm.transfer = readOne<uint32_t>("transfer") != 0;
    const uint32_t S = readOne<uint32_t>("S"), M = readOne<uint32_t>("M"), I = readOne<uint32_t>("I");
    prm.threads = readOne<uint32_t>("threads");
    prm.edgeTexels = readOne<double>("edgeTexels");
    prm.maxDistance = readOne<double>("maxDistance");
    prm.maxNormalAngleDeg = readOne<double>("maxNormalAngleDeg");
    readN(prm.slotKind, S, "slot kinds");
    if (!prm.width || !prm.height || size_t(prm.width) * prm.height > size_t(16384) * 16384) throw std::runtime_error("bad atlas size");

    BakeMesh target, source;
    std::vector<float> uvPx;
    const uint32_t Vt = readOne<uint32_t>("Vt"), Tt = readOne<uint32_t>("Tt");
    const uint32_t tHasN = readOne<uint32_t>("target normals flag"), tHasT = readOne<uint32_t>("target tangents flag");
    readN(uvPx, size_t(Vt) * 2, "target uv");
    readN(target.pos, size_t(Vt) * 3, "target positions");
    if (tHasN) readN(target.nrm, size_t(Vt) * 3, "target normals");
    if (tHasT) readN(target.tan, size_t(Vt) * 4, "target tangents");
    readN(target.idx, size_t(Tt) * 3, "target indices");
    checkIndices(target.idx, Vt, "target indices");
    checkFinite(uvPx, "target uv");
    checkFinite(target.pos, "target positions");
    if (prm.transfer) {
        const uint32_t Vs = readOne<uint32_t>("Vs"), Ts = readOne<uint32_t>("Ts");
        const uint32_t sHasN = readOne<uint32_t>("source normals flag"), sHasT = readOne<uint32_t>("source tangents flag");
        readN(source.pos, size_t(Vs) * 3, "source positions");
        if (sHasN) readN(source.nrm, size_t(Vs) * 3, "source normals");
        if (sHasT) readN(source.tan, size_t(Vs) * 4, "source tangents");
        readN(source.uv, size_t(S) * 2 * Vs, "source uv");
        readN(source.idx, size_t(Ts) * 3, "source indices");
        readN(source.triMaterial, Ts, "source materials");
        checkIndices(source.idx, Vs, "source indices");
        checkFinite(source.pos, "source positions");
    } else {
        const uint32_t sHasT = readOne<uint32_t>("source tangents flag");
        source.pos = target.pos;
        source.nrm = target.nrm;
        if (sHasT) readN(source.tan, size_t(Vt) * 4, "source tangents");
        readN(source.uv, size_t(S) * 2 * Vt, "source uv");
        source.idx = target.idx;
        readN(source.triMaterial, Tt, "source materials");
    }
    for (uint32_t m : source.triMaterial) if (m >= M) throw std::runtime_error("triangle material out of range");
    std::vector<std::vector<MaterialSlot>> materials(M, std::vector<MaterialSlot>(S));
    for (uint32_t m = 0; m < M; ++m) for (uint32_t s = 0; s < S; ++s) {
        auto& ms = materials[m][s];
        ms.image = readOne<int32_t>("material image");
        ms.wrapS = readOne<uint32_t>("wrapS");
        ms.wrapT = readOne<uint32_t>("wrapT");
        for (int k = 0; k < 4; ++k) ms.factor[k] = readOne<float>("factor");
        if (ms.image >= int32_t(I)) throw std::runtime_error("material image out of range");
    }
    std::vector<Image> images(I);
    for (uint32_t i = 0; i < I; ++i) {
        images[i].width = readOne<uint32_t>("image width");
        images[i].height = readOne<uint32_t>("image height");
        if (!images[i].width || !images[i].height) throw std::runtime_error("empty image");
        readN(images[i].rgba, size_t(images[i].width) * images[i].height * 4, "image pixels");
    }

    auto r = bake(target, uvPx, source, materials, images, prm);

    std::fwrite("SBRO", 1, 4, stdout);
    const uint32_t head[4] = {1, S, prm.width, prm.height};
    writeN(head, 4);
    const uint64_t counts[5] = {r.interiorTexels, r.edgeTexels, r.dilatedTexels, r.emptyTexels, r.unresolvedTexels};
    writeN(counts, 5);
    const double stats[6] = {r.meanTransferDistance, r.maxTransferDistance, r.msRaster, r.msShade, r.msDilate, r.msBvh};
    writeN(stats, 6);
    for (const auto& s : r.slots) writeN(s.data(), s.size());
    std::fflush(stdout);
    return 0;
}

}  // namespace

int main() {
    try {
        char magic[4];
        if (std::fread(magic, 1, 4, stdin) != 4) throw std::runtime_error("no request");
        if (std::memcmp(magic, "SBUW", 4) == 0) return runUnwrap();
        if (std::memcmp(magic, "SBRB", 4) == 0) return runBake();
        throw std::runtime_error("unknown request magic");
    } catch (const std::exception& e) {
        std::cerr << "uv_rewrap: " << e.what() << "\n";
        return 2;
    }
}
