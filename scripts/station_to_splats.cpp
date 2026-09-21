/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

// Bakes one beautified station image onto the mesh depth of that station as oriented Gaussian
// splats in the world (Scratchbox local ENU) frame.
//
//   station_to_splats --rgb <raw rgb24> --depth <f32 camera-z, EMPTY >= 1e8> --width W --height H
//                     --pose <json: fx fy cx cy eye right up forward> --out-splat <file>
//                     [--stride 1] [--sigma-scale 0.95] [--tau 0.08] [--max-depth 400] [--json]
//
// Geometry: pixel (u,v) with camera-z depth z is X = (u+0.5-cx)/fx*z (right), Y = -(v+0.5-cy)/fy*z (up),
// Z = z (forward); world = eye + right*X + up*Y + forward*Z. Normals come from the depth gradient
// (4-neighbour, world space); splats are thin discs in the tangent plane with sigma = 0.95 x the
// pixel footprint (calibrated against gaussian-splat-lite), elongated up to 2x at grazing incidence.
// Edge severance: neighbours whose relative depth jump exceeds tau are not used for normals and the
// splat is shrunk, so silhouettes stay crisp instead of smearing between foreground and background.

#include "scratchbox_engine.hpp"
#include "scratchbox_spz.hpp"
#include "scratchbox_depth_to_gaussian.hpp"
#include <fstream>
#include <iostream>
#include <string>
#include <vector>
#include <chrono>
#include <cmath>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::spz;

static std::vector<uint8_t> readAll(const std::string& p) {
    std::ifstream f(p, std::ios::binary | std::ios::ate);
    if (!f.is_open()) return {};
    std::streamsize n = f.tellg(); f.seekg(0);
    std::vector<uint8_t> b(static_cast<size_t>(n));
    f.read(reinterpret_cast<char*>(b.data()), n);
    return b;
}

// Tiny JSON number extractor for the flat pose file (keys are unique, values numeric or arrays of 3)
static bool jsonNumber(const std::string& s, const std::string& key, float& out) {
    size_t k = s.find("\"" + key + "\"");
    if (k == std::string::npos) return false;
    size_t c = s.find(':', k);
    out = std::stof(s.substr(c + 1));
    return true;
}
static bool jsonVec3(const std::string& s, const std::string& key, Vec3& out) {
    size_t k = s.find("\"" + key + "\"");
    if (k == std::string::npos) return false;
    size_t a = s.find('[', k), b = s.find(']', a);
    std::string inner = s.substr(a + 1, b - a - 1);
    float v[3]; size_t pos = 0;
    for (int i = 0; i < 3; ++i) { size_t next; v[i] = std::stof(inner.substr(pos), &next); pos += next; size_t comma = inner.find(',', pos); pos = (comma == std::string::npos) ? inner.size() : comma + 1; }
    out = Vec3(v[0], v[1], v[2]);
    return true;
}

static int runFuse(const std::string& listPath, float voxelSize, float cropRadius, bool dropFoliage, const std::string& outSplat, const std::string& outSpz, bool emitJson) {
    auto t0 = std::chrono::high_resolution_clock::now();
    std::ifstream listFile(listPath);
    if (!listFile.is_open()) {
        std::cerr << "ERROR: Failed to open fuse list: " << listPath << std::endl;
        return 1;
    }
    std::vector<std::string> splatPaths;
    std::string line;
    while (std::getline(listFile, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) line.pop_back();
        size_t s = 0;
        while (s < line.size() && (line[s] == ' ' || line[s] == '\t')) ++s;
        if (s < line.size() && line[s] != '#') {
            splatPaths.push_back(line.substr(s));
        }
    }
    if (splatPaths.empty()) {
        std::cerr << "ERROR: No valid splat paths found in fuse list" << std::endl;
        return 1;
    }

    struct VoxelKey {
        int64_t x, y, z;
        bool operator==(const VoxelKey& o) const { return x == o.x && y == o.y && z == o.z; }
    };
    struct VoxelKeyHash {
        size_t operator()(const VoxelKey& k) const {
            size_t h = 14695981039346656037ULL;
            h = (h ^ static_cast<size_t>(k.x * 73856093)) * 1099511628211ULL;
            h = (h ^ static_cast<size_t>(k.y * 19349663)) * 1099511628211ULL;
            h = (h ^ static_cast<size_t>(k.z * 83492791)) * 1099511628211ULL;
            return h;
        }
    };

    std::unordered_map<VoxelKey, GaussianSplat, VoxelKeyHash> grid;
    float invVoxel = 1.0f / std::max(0.001f, voxelSize);
    size_t totalInputSplats = 0;

    for (const auto& sp : splatPaths) {
        std::vector<uint8_t> bytes = readAll(sp);
        if (bytes.empty()) continue;
        std::vector<GaussianSplat> stationSplats = SplatCodec::decode(bytes.data(), bytes.size());
        totalInputSplats += stationSplats.size();

        for (const auto& s : stationSplats) {
            float distH = std::hypot(s.position.x, s.position.z);
            if (cropRadius > 0.0f && distH > cropRadius) continue;

            if (dropFoliage) {
                const float rVal = s.color.x;
                const float gVal = s.color.y;
                const float bVal = s.color.z;
                const float sumRgb = rVal + gVal + bVal + 1e-5f;
                const float gn = gVal / sumRgb;
                const float exg = 2.0f * gVal - rVal - bVal;
                const bool isOrganic = (gn > 0.38f && gVal > rVal + 0.02f && gVal > bVal + 0.02f) || (exg > 0.10f);
                // Also drop non-structural dark sludge outside the focal landmark ring
                const bool isDarkSludge = (distH > 95.0f) && (rVal < 0.28f && gVal < 0.28f && bVal < 0.28f);
                if (isOrganic || isDarkSludge) continue;
            }

            int64_t vx = static_cast<int64_t>(std::floor(s.position.x * invVoxel));
            int64_t vy = static_cast<int64_t>(std::floor(s.position.y * invVoxel));
            int64_t vz = static_cast<int64_t>(std::floor(s.position.z * invVoxel));
            VoxelKey key{vx, vy, vz};

            float sa = std::max(s.scale.x, s.scale.y) / std::max(1e-6f, std::min(s.scale.x, s.scale.y));

            auto it = grid.find(key);
            if (it == grid.end()) {
                grid[key] = s;
            } else {
                float ea = std::max(it->second.scale.x, it->second.scale.y) / std::max(1e-6f, std::min(it->second.scale.x, it->second.scale.y));
                if (sa < ea * 0.9f) {
                    it->second = s;
                } else if (sa <= ea * 1.1f) {
                    it->second.color = (it->second.color + s.color) * 0.5f;
                }
            }
        }
    }

    std::vector<GaussianSplat> fused;
    fused.reserve(grid.size());
    Vec3 bMin(1e9f, 1e9f, 1e9f), bMax(-1e9f, -1e9f, -1e9f);
    for (auto& pair : grid) {
        const auto& s = pair.second;
        bMin.x = std::min(bMin.x, s.position.x);
        bMin.y = std::min(bMin.y, s.position.y);
        bMin.z = std::min(bMin.z, s.position.z);
        bMax.x = std::max(bMax.x, s.position.x);
        bMax.y = std::max(bMax.y, s.position.y);
        bMax.z = std::max(bMax.z, s.position.z);
        fused.push_back(s);
    }
    if (fused.empty()) {
        bMin = Vec3(0, 0, 0);
        bMax = Vec3(0, 0, 0);
    }

    // Median sigma from stride
    float medianSigma = 0.05f;
    if (!fused.empty()) {
        size_t step = std::max(size_t(1), fused.size() / 5000);
        std::vector<float> sigmas;
        sigmas.reserve(fused.size() / step + 1);
        for (size_t i = 0; i < fused.size(); i += step) {
            sigmas.push_back(std::max(fused[i].scale.x, fused[i].scale.y));
        }
        std::sort(sigmas.begin(), sigmas.end());
        medianSigma = sigmas[sigmas.size() / 2];
    }

    size_t splatBytes = 0, spzBytes = 0;
    if (!outSplat.empty()) {
        std::vector<uint8_t> bytes = SplatCodec::encode(fused);
        std::ofstream o(outSplat, std::ios::binary);
        o.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        splatBytes = bytes.size();
    }
    if (!outSpz.empty()) {
        std::vector<uint8_t> bytes = SpzCodec::encode(fused);
        std::ofstream o(outSpz, std::ios::binary);
        o.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        spzBytes = bytes.size();
    }

    double ms = std::chrono::duration<double, std::milli>(std::chrono::high_resolution_clock::now() - t0).count();
    if (emitJson) {
        std::cout << "{\"success\":true,\"totalInputSplats\":" << totalInputSplats
                  << ",\"fusedSplatCount\":" << fused.size()
                  << ",\"splatBytes\":" << splatBytes
                  << ",\"spzBytes\":" << spzBytes
                  << ",\"medianSigma\":" << medianSigma
                  << ",\"bounds\":{\"min\":[" << bMin.x << "," << bMin.y << "," << bMin.z << "],\"max\":[" << bMax.x << "," << bMax.y << "," << bMax.z << "]}"
                  << ",\"durationMs\":" << ms << "}" << std::endl;
    } else {
        std::cout << "[Fuse] " << totalInputSplats << " input splats -> " << fused.size() << " fused splats in " << ms << " ms" << std::endl;
    }
    return 0;
}

int main(int argc, char** argv) {
    std::string rgbPath, depthPath, posePath, outSplat, outSpz, fuseListPath;
    int W = 0, H = 0, stride = 1;
    float sigmaScale = 0.95f, tau = 0.08f, maxDepth = 400.0f, minCosIncidence = 0.12f, voxelSize = 0.20f, cropRadius = 0.0f;
    bool emitJson = false, dropFoliage = false;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&](std::string& dst) { if (i + 1 < argc) dst = argv[++i]; };
        if (a == "--rgb") next(rgbPath);
        else if (a == "--depth") next(depthPath);
        else if (a == "--pose") next(posePath);
        else if (a == "--out-splat") next(outSplat);
        else if (a == "--out-spz") next(outSpz);
        else if (a == "--fuse-list") next(fuseListPath);
        else if (a == "--voxel-size" && i + 1 < argc) voxelSize = std::stof(argv[++i]);
        else if (a == "--crop-radius" && i + 1 < argc) cropRadius = std::stof(argv[++i]);
        else if (a == "--width" && i + 1 < argc) W = std::stoi(argv[++i]);
        else if (a == "--height" && i + 1 < argc) H = std::stoi(argv[++i]);
        else if (a == "--stride" && i + 1 < argc) stride = std::max(1, std::stoi(argv[++i]));
        else if (a == "--sigma-scale" && i + 1 < argc) sigmaScale = std::stof(argv[++i]);
        else if (a == "--tau" && i + 1 < argc) tau = std::stof(argv[++i]);
        else if (a == "--max-depth" && i + 1 < argc) maxDepth = std::stof(argv[++i]);
        else if (a == "--min-cos-incidence" && i + 1 < argc) minCosIncidence = std::stof(argv[++i]);
        else if (a == "--drop-foliage") dropFoliage = true;
        else if (a == "--json") emitJson = true;
    }

    if (!fuseListPath.empty()) {
        return runFuse(fuseListPath, voxelSize, cropRadius, dropFoliage, outSplat, outSpz, emitJson);
    }

    if (rgbPath.empty() || depthPath.empty() || posePath.empty() || (outSplat.empty() && outSpz.empty()) || W <= 0 || H <= 0) {
        std::cerr << "Usage: station_to_splats --rgb rgb24.raw --depth depth.f32 --width W --height H --pose pose.json --out-splat out.splat [--out-spz out.spz] [--stride 1] [--sigma-scale 0.95] [--tau 0.08] [--min-cos-incidence 0.12] [--drop-foliage] [--json]" << std::endl;
        std::cerr << "   or: station_to_splats --fuse-list list.txt --voxel-size 0.20 [--crop-radius 115.0] [--drop-foliage] --out-splat fused.splat [--out-spz fused.spz] [--json]" << std::endl;
        return 1;
    }

    auto t0 = std::chrono::high_resolution_clock::now();
    std::vector<uint8_t> rgb = readAll(rgbPath);
    std::vector<uint8_t> depthBytes = readAll(depthPath);
    std::vector<uint8_t> poseBytes = readAll(posePath);
    if (rgb.size() < static_cast<size_t>(W) * H * 3 || depthBytes.size() < static_cast<size_t>(W) * H * 4 || poseBytes.empty()) {
        std::cerr << "ERROR: input sizes do not match width/height (rgb " << rgb.size() << ", depth " << depthBytes.size() << ")" << std::endl;
        return 1;
    }
    const int channels = (rgb.size() >= static_cast<size_t>(W) * H * 4) ? 4 : 3;
    const float* depth = reinterpret_cast<const float*>(depthBytes.data());
    std::string pose(poseBytes.begin(), poseBytes.end());
    float fx, fy, cx, cy; Vec3 eye, right, up, fwd;
    if (!jsonNumber(pose, "fx", fx) || !jsonNumber(pose, "fy", fy) || !jsonNumber(pose, "cx", cx) || !jsonNumber(pose, "cy", cy)
        || !jsonVec3(pose, "eye", eye) || !jsonVec3(pose, "right", right) || !jsonVec3(pose, "up", up) || !jsonVec3(pose, "forward", fwd)) {
        std::cerr << "ERROR: pose json needs fx, fy, cx, cy, eye[3], right[3], up[3], forward[3]" << std::endl;
        return 1;
    }

    auto valid = [&](int u, int v) -> bool {
        if (u < 0 || v < 0 || u >= W || v >= H) return false;
        float d = depth[v * W + u];
        return d > 0.05f && d < maxDepth && d < 1e8f;
    };
    auto world = [&](int u, int v) -> Vec3 {
        float z = depth[v * W + u];
        float X = (static_cast<float>(u) + 0.5f - cx) / fx * z;
        float Y = -(static_cast<float>(v) + 0.5f - cy) / fy * z;
        return eye + right * X + up * Y + fwd * z;
    };

    std::vector<GaussianSplat> splats;
    splats.reserve(static_cast<size_t>(W / stride) * (H / stride));
    size_t severed = 0, grazing = 0, foliageDropped = 0;
    for (int v = 0; v < H; v += stride) {
        for (int u = 0; u < W; u += stride) {
            if (!valid(u, v)) continue;
            const float z = depth[v * W + u];
            const size_t ci = (static_cast<size_t>(v) * W + u) * channels;
            if (channels == 4 && rgb[ci + 3] < 16) continue;

            const float rVal = rgb[ci] / 255.0f;
            const float gVal = rgb[ci + 1] / 255.0f;
            const float bVal = rgb[ci + 2] / 255.0f;
            const float sumRgb = rVal + gVal + bVal + 1e-5f;
            const float rn = rVal / sumRgb, gn = gVal / sumRgb, bn = bVal / sumRgb;

            // Organic foliage / vegetation detection (Excess Green Index ExG = 2G - R - B)
            const float exg = 2.0f * gVal - rVal - bVal;
            const bool isOrganic = (gn > 0.38f && gVal > rVal + 0.02f && gVal > bVal + 0.02f) || (exg > 0.12f);
            if (isOrganic && dropFoliage) {
                foliageDropped++;
                continue;
            }

            const Vec3 p = world(u, v);
            // Neighbours for the tangent plane, respecting edge severance (relative depth jump > tau)
            // On organic foliage, use tighter severance to prevent smooth canopy bridging
            const float localTau = isOrganic ? tau * 0.35f : tau;
            auto pick = [&](int du, int dv, Vec3& out) -> bool {
                int uu = u + du, vv = v + dv;
                if (!valid(uu, vv)) return false;
                float zn = depth[vv * W + uu];
                if (std::fabs(zn - z) / z > localTau) return false;
                out = world(uu, vv);
                return true;
            };
            Vec3 pr, pl, pd, pu;
            bool hr = pick(stride, 0, pr), hl = pick(-stride, 0, pl), hd = pick(0, stride, pd), hu = pick(0, -stride, pu);
            Vec3 tx, ty;
            if (hr && hl) tx = pr - pl; else if (hr) tx = pr - p; else if (hl) tx = p - pl; else tx = right;
            if (hd && hu) ty = pu - pd; else if (hu) ty = pu - p; else if (hd) ty = p - pd; else ty = up;
            Vec3 n = tx.cross(ty);
            if (n.length() < 1e-9f) n = -fwd;
            n = n.normalized();
            // Face the camera
            Vec3 toCam = (eye - p).normalized();
            if (n.dot(toCam) < 0.0f) n = -n;
            bool isolated = !(hr || hl) || !(hd || hu);
            if (isolated) severed++;
            // Extremely grazing samples (far ground seen almost edge-on) smear into stripes and are
            // always better covered by another station; drop them rather than elongate them.
            if (std::fabs(n.dot(toCam)) < minCosIncidence) { grazing++; continue; }

            // Footprint: one sample spacing at this depth, sigma = sigmaScale x spacing
            const float spacing = z / fx * static_cast<float>(stride);
            float sigma = spacing * sigmaScale;
            if (isolated) sigma *= 0.6f;
            if (isOrganic) sigma *= 0.5f;
            // Foreshortening compensation along the steepest direction (cap 2x)
            const float cosInc = std::max(0.5f, std::fabs(n.dot(toCam)));
            const float elong = 1.0f / cosInc;

            // Tangent basis: t1 along the projection of the view-right into the plane, t2 = n x t1
            Vec3 t1 = (right - n * right.dot(n));
            if (t1.length() < 1e-6f) t1 = (up - n * up.dot(n));
            t1 = t1.normalized();
            Vec3 t2 = n.cross(t1).normalized();
            // Steepest foreshortening direction lies along the projection of the view ray into the plane
            Vec3 g = (toCam - n * toCam.dot(n));
            float s1 = sigma, s2 = sigma;
            if (g.length() > 1e-6f) {
                g = g.normalized();
                // Rotate the basis so t1 aligns with g, then elongate along it
                t1 = g; t2 = n.cross(t1).normalized();
                s1 = sigma * elong;
            }

            GaussianSplat s;
            s.position = p;
            s.scale = Vec3(s1, s2, std::max(0.002f, sigma * 0.15f));
            s.rotation = depthbox::DepthToGaussianEngine::quatFromBasis(t1, t2, n).normalized();
            s.color = Vec3(rgb[ci] / 255.0f, rgb[ci + 1] / 255.0f, rgb[ci + 2] / 255.0f);
            s.opacity = channels == 4 ? rgb[ci + 3] / 255.0f : 1.0f;
            splats.push_back(s);
        }
    }

    size_t splatBytes = 0, spzBytes = 0;
    if (!outSplat.empty()) {
        std::vector<uint8_t> bytes = SplatCodec::encode(splats);
        std::ofstream o(outSplat, std::ios::binary); o.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        splatBytes = bytes.size();
    }
    if (!outSpz.empty()) {
        std::vector<uint8_t> bytes = SpzCodec::encode(splats);
        std::ofstream o(outSpz, std::ios::binary); o.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
        spzBytes = bytes.size();
    }
    double ms = std::chrono::duration<double, std::milli>(std::chrono::high_resolution_clock::now() - t0).count();
    if (emitJson) {
        std::cout << "{\"success\":true,\"numSplats\":" << splats.size() << ",\"severedEdges\":" << severed << ",\"grazingDropped\":" << grazing
                  << ",\"foliageDropped\":" << foliageDropped << ",\"splatBytes\":" << splatBytes << ",\"spzBytes\":" << spzBytes << ",\"durationMs\":" << ms << "}" << std::endl;
    } else {
        std::cout << "[StationSplats] " << splats.size() << " splats (" << severed << " edge-severed, " << foliageDropped << " foliage-dropped) in " << ms << " ms" << std::endl;
    }
    return 0;
}
