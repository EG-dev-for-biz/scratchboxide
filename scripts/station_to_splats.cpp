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

static int runFuse(const std::string& listPath, float voxelSize, float cropRadius, bool dropFoliage, bool excludeUnderside, float minGroundY, float normalPruneCos, const std::string& outSplat, const std::string& outSpz, bool emitJson) {
    auto t0 = std::chrono::high_resolution_clock::now();
    std::ifstream listFile(listPath);
    if (!listFile.is_open()) {
        std::cerr << "ERROR: Failed to open fuse list: " << listPath << std::endl;
        return 1;
    }
    struct StationEntry {
        std::string path;
        float altitude;
    };
    std::vector<StationEntry> splatEntries;
    std::string line;
    while (std::getline(listFile, line)) {
        while (!line.empty() && (line.back() == '\r' || line.back() == ' ' || line.back() == '\t')) line.pop_back();
        size_t s = 0;
        while (s < line.size() && (line[s] == ' ' || line[s] == '\t')) ++s;
        if (s < line.size() && line[s] != '#') {
            std::string rem = line.substr(s);
            std::istringstream iss(rem);
            std::string p;
            float alt = 50.0f;
            iss >> p;
            if (iss >> alt) {
                splatEntries.push_back({p, alt});
            } else {
                splatEntries.push_back({p, 50.0f});
            }
        }
    }
    if (splatEntries.empty()) {
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

    struct VoxelEntry {
        GaussianSplat splat;
        float wGround = 0.0f;
        bool isGround = false;
        Vec3 normal{0.0f, 1.0f, 0.0f};
        float sigma = 0.05f;
    };
    std::unordered_map<VoxelKey, VoxelEntry, VoxelKeyHash> grid;
    float invVoxel = 1.0f / std::max(0.001f, voxelSize);
    size_t totalInputSplats = 0;
    size_t normalPruned = 0;

    for (const auto& entry : splatEntries) {
        std::vector<uint8_t> bytes = readAll(entry.path);
        if (bytes.empty()) continue;
        std::vector<GaussianSplat> stationSplats = SplatCodec::decode(bytes.data(), bytes.size());
        totalInputSplats += stationSplats.size();
        const float wGround = 1.0f / (entry.altitude + 1.0f);

        for (const auto& s : stationSplats) {
            float distH = std::hypot(s.position.x, s.position.z);
            if (cropRadius > 0.0f && distH > cropRadius) continue;
            if (excludeUnderside && s.position.y < minGroundY) continue;

            if (dropFoliage) {
                const float rVal = s.color.x;
                const float gVal = s.color.y;
                const float bVal = s.color.z;
                const float sumRgb = rVal + gVal + bVal + 1e-5f;
                const float gn = gVal / sumRgb;
                const float exg = 2.0f * gVal - rVal - bVal;
                const bool isDarkGreen = (rVal * 255.0f < 70.0f && gVal * 255.0f > 65.0f && bVal * 255.0f < 60.0f);
                const bool isOrganic = (gn > 0.38f && gVal > rVal + 0.02f && gVal > bVal + 0.02f) || (exg > 0.08f) || isDarkGreen;
                // Also drop non-structural dark sludge outside the focal landmark ring
                const bool isDarkSludge = (distH > 95.0f) && (rVal < 0.28f && gVal < 0.28f && bVal < 0.28f);
                if (isOrganic || isDarkSludge) continue;
            }

            int64_t vx = static_cast<int64_t>(std::floor(s.position.x * invVoxel));
            int64_t vy = static_cast<int64_t>(std::floor(s.position.y * invVoxel));
            int64_t vz = static_cast<int64_t>(std::floor(s.position.z * invVoxel));
            VoxelKey key{vx, vy, vz};

            // Compute splat normal from quaternion
            const Quat& q = s.rotation;
            const Vec3 sNormal = Vec3(
                2.0f * (q.x * q.z + q.w * q.y),
                2.0f * (q.y * q.z - q.w * q.x),
                1.0f - 2.0f * (q.x * q.x + q.y * q.y)
            ).normalized();
            const float ny = sNormal.y;
            const bool isGround = (std::fabs(ny) > 0.85f);

            float sa = std::max(s.scale.x, s.scale.y) / std::max(1e-6f, std::min(s.scale.x, s.scale.y));
            float sSigma = std::max(s.scale.x, s.scale.y);

            auto it = grid.find(key);
            if (it == grid.end()) {
                grid[key] = {s, wGround, isGround, sNormal, sSigma};
            } else {
                auto& existing = it->second;
                // Voxel Normal Consensus Check / Prune
                const float normalDot = sNormal.dot(existing.normal);
                if (normalDot < normalPruneCos) {
                    // Conflicting normal orientations across views
                    // The view with smaller scale / higher sharpness / higher weight wins, outlier is pruned
                    if (sSigma < existing.sigma * 0.85f || wGround > existing.wGround * 1.25f) {
                        existing = {s, wGround, isGround, sNormal, sSigma};
                    }
                    normalPruned++;
                    continue;
                }

                if (isGround && existing.isGround) {
                    // Multi-Scale Ground Paver Resolution weighting:
                    // Street-level ground splats (w_ground = 1.0 / (altitude + 1.0)) override low-res aerial splats
                    if (wGround > existing.wGround * 1.15f) {
                        existing = {s, wGround, isGround, sNormal, sSigma};
                    } else if (wGround >= existing.wGround * 0.85f) {
                        float ea = std::max(existing.splat.scale.x, existing.splat.scale.y) / std::max(1e-6f, std::min(existing.splat.scale.x, existing.splat.scale.y));
                        if (sa < ea * 0.9f) {
                            existing = {s, wGround, isGround, sNormal, sSigma};
                        } else if (sa <= ea * 1.1f) {
                            existing.splat.color = (existing.splat.color + s.color) * 0.5f;
                        }
                    }
                } else {
                    float ea = std::max(existing.splat.scale.x, existing.splat.scale.y) / std::max(1e-6f, std::min(existing.splat.scale.x, existing.splat.scale.y));
                    if (sa < ea * 0.9f) {
                        existing = {s, wGround, isGround, sNormal, sSigma};
                    } else if (sa <= ea * 1.1f) {
                        existing.splat.color = (existing.splat.color + s.color) * 0.5f;
                    }
                }
            }
        }
    }

    std::vector<GaussianSplat> fused;
    fused.reserve(grid.size());
    Vec3 bMin(1e9f, 1e9f, 1e9f), bMax(-1e9f, -1e9f, -1e9f);
    for (auto& pair : grid) {
        const auto& s = pair.second.splat;
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
                  << ",\"normalPruned\":" << normalPruned
                  << ",\"splatBytes\":" << splatBytes
                  << ",\"spzBytes\":" << spzBytes
                  << ",\"medianSigma\":" << medianSigma
                  << ",\"bounds\":{\"min\":[" << bMin.x << "," << bMin.y << "," << bMin.z << "],\"max\":[" << bMax.x << "," << bMax.y << "," << bMax.z << "]}"
                  << ",\"durationMs\":" << ms << "}" << std::endl;
    } else {
        std::cout << "[Fuse] " << totalInputSplats << " input splats -> " << fused.size() << " fused splats (pruned " << normalPruned << " normal-conflicted splats) in " << ms << " ms" << std::endl;
    }
    return 0;
}

// Computes hybrid micro-depth displacement: Depth = Z_mesh + DeltaZ_neural
// DeltaZ = z_neural - z_mesh_smooth
// Recovers sharp columns, arches, window insets, and crisp architectural relief
static std::vector<float> computeEffectiveDepth(
    int W, int H,
    const float* depth,
    const uint8_t* rgb,
    int channels,
    float maxDepth,
    const std::string& neuralDepthPath,
    bool enablePhotometricMicroDepth,
    float neuralDepthWeight,
    float maxDeltaZ,
    int smoothRadius,
    float cavityDepth,
    float cavityLum,
    size_t& microDisplacedCount
) {
    std::vector<float> eff(W * H);
    for (int i = 0; i < W * H; ++i) eff[i] = depth[i];

    bool hasNeural = !neuralDepthPath.empty();
    if (!hasNeural && !enablePhotometricMicroDepth && cavityDepth <= 0.0f) {
        return eff;
    }

    // 1. Compute separable low-pass smoothed mesh depth (z_mesh_smooth)
    std::vector<float> tempSmooth(W * H, 0.0f);
    std::vector<float> meshSmooth(W * H, 0.0f);
    int R = std::max(3, std::min(smoothRadius, 45));

    // Horizontal sliding window
    for (int y = 0; y < H; ++y) {
        float sum = 0.0f;
        int count = 0;
        int rowStart = y * W;
        for (int x = -R; x <= R; ++x) {
            if (x >= 0 && x < W) {
                float d = depth[rowStart + x];
                if (d > 0.05f && d < maxDepth && d < 1e8f) {
                    sum += d;
                    count++;
                }
            }
        }
        for (int x = 0; x < W; ++x) {
            tempSmooth[rowStart + x] = count > 0 ? (sum / count) : depth[rowStart + x];
            int xOut = x - R;
            if (xOut >= 0 && xOut < W) {
                float dOut = depth[rowStart + xOut];
                if (dOut > 0.05f && dOut < maxDepth && dOut < 1e8f) {
                    sum -= dOut;
                    count--;
                }
            }
            int xIn = x + R + 1;
            if (xIn >= 0 && xIn < W) {
                float dIn = depth[rowStart + xIn];
                if (dIn > 0.05f && dIn < maxDepth && dIn < 1e8f) {
                    sum += dIn;
                    count++;
                }
            }
        }
    }

    // Vertical sliding window
    for (int x = 0; x < W; ++x) {
        float sum = 0.0f;
        int count = 0;
        for (int y = -R; y <= R; ++y) {
            if (y >= 0 && y < H) {
                float d = tempSmooth[y * W + x];
                if (d > 0.05f && d < maxDepth && d < 1e8f) {
                    sum += d;
                    count++;
                }
            }
        }
        for (int y = 0; y < H; ++y) {
            meshSmooth[y * W + x] = count > 0 ? (sum / count) : tempSmooth[y * W + x];
            int yOut = y - R;
            if (yOut >= 0 && yOut < H) {
                float dOut = tempSmooth[yOut * W + x];
                if (dOut > 0.05f && dOut < maxDepth && dOut < 1e8f) {
                    sum -= dOut;
                    count--;
                }
            }
            int yIn = y + R + 1;
            if (yIn >= 0 && yIn < H) {
                float dIn = tempSmooth[yIn * W + x];
                if (dIn > 0.05f && dIn < maxDepth && dIn < 1e8f) {
                    sum += dIn;
                    count++;
                }
            }
        }
    }

    std::vector<float> neuralRaw;
    if (hasNeural) {
        std::vector<uint8_t> nBytes = readAll(neuralDepthPath);
        if (nBytes.size() >= static_cast<size_t>(W * H * 4)) {
            const float* ptr = reinterpret_cast<const float*>(nBytes.data());
            neuralRaw.assign(ptr, ptr + (W * H));
        } else if (nBytes.size() >= static_cast<size_t>(W * H * 2)) {
            const uint16_t* ptr = reinterpret_cast<const uint16_t*>(nBytes.data());
            neuralRaw.resize(W * H);
            for (size_t i = 0; i < static_cast<size_t>(W * H); ++i) neuralRaw[i] = ptr[i] / 65535.0f;
        } else if (nBytes.size() >= static_cast<size_t>(W * H)) {
            neuralRaw.resize(W * H);
            for (size_t i = 0; i < static_cast<size_t>(W * H); ++i) neuralRaw[i] = nBytes[i] / 255.0f;
        }
    }

    // If neuralRaw is present, fit affine scale s* and shift t* to mesh depth
    float sScale = 1.0f, tShift = 0.0f;
    if (!neuralRaw.empty()) {
        double sumN = 0.0, sumM = 0.0;
        int validCount = 0;
        for (int i = 0; i < W * H; ++i) {
            float dm = depth[i], dn = neuralRaw[i];
            if (dm > 0.05f && dm < maxDepth && dm < 1e8f && dn > 1e-4f && dn < 1e8f) {
                sumN += dn;
                sumM += dm;
                validCount++;
            }
        }
        if (validCount > 100) {
            double meanN = sumN / validCount;
            double meanM = sumM / validCount;
            double num = 0.0, den = 0.0;
            for (int i = 0; i < W * H; ++i) {
                float dm = depth[i], dn = neuralRaw[i];
                if (dm > 0.05f && dm < maxDepth && dm < 1e8f && dn > 1e-4f && dn < 1e8f) {
                    num += (dn - meanN) * (dm - meanM);
                    den += (dn - meanN) * (dn - meanN);
                }
            }
            if (den > 1e-6) {
                sScale = static_cast<float>(num / den);
                tShift = static_cast<float>(meanM - sScale * meanN);
            }
        }
    }

    // Photometric smoothing for luminance detail
    std::vector<float> lumSmooth(W * H, 0.0f);
    if (enablePhotometricMicroDepth || neuralRaw.empty()) {
        std::vector<float> lum(W * H, 0.0f);
        for (int y = 0; y < H; ++y) {
            for (int x = 0; x < W; ++x) {
                size_t ci = (static_cast<size_t>(y) * W + x) * channels;
                lum[y * W + x] = 0.2126f * (rgb[ci] / 255.0f) + 0.7152f * (rgb[ci + 1] / 255.0f) + 0.0722f * (rgb[ci + 2] / 255.0f);
            }
        }
        // Horizontal lum blur
        std::vector<float> tempLum(W * H, 0.0f);
        int Rlum = 9;
        for (int y = 0; y < H; ++y) {
            float sum = 0.0f;
            int count = 0;
            int rowStart = y * W;
            for (int x = -Rlum; x <= Rlum; ++x) {
                if (x >= 0 && x < W) { sum += lum[rowStart + x]; count++; }
            }
            for (int x = 0; x < W; ++x) {
                tempLum[rowStart + x] = sum / std::max(1, count);
                int xOut = x - Rlum; if (xOut >= 0 && xOut < W) { sum -= lum[rowStart + xOut]; count--; }
                int xIn = x + Rlum + 1; if (xIn >= 0 && xIn < W) { sum += lum[rowStart + xIn]; count++; }
            }
        }
        // Vertical lum blur
        for (int x = 0; x < W; ++x) {
            float sum = 0.0f;
            int count = 0;
            for (int y = -Rlum; y <= Rlum; ++y) {
                if (y >= 0 && y < H) { sum += tempLum[y * W + x]; count++; }
            }
            for (int y = 0; y < H; ++y) {
                lumSmooth[y * W + x] = sum / std::max(1, count);
                int yOut = y - Rlum; if (yOut >= 0 && yOut < H) { sum -= tempLum[yOut * W + x]; count--; }
                int yIn = y + Rlum + 1; if (yIn >= 0 && yIn < H) { sum += tempLum[yIn * W + x]; count++; }
            }
        }
    }

    // Calculate Delta Z for each pixel
    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x) {
            int idx = y * W + x;
            float dMesh = depth[idx];
            if (dMesh <= 0.05f || dMesh >= maxDepth || dMesh >= 1e8f) continue;

            float deltaZ = 0.0f;
            if (!neuralRaw.empty()) {
                float zNeuralMetric = sScale * neuralRaw[idx] + tShift;
                deltaZ = zNeuralMetric - meshSmooth[idx];
            } else if (enablePhotometricMicroDepth) {
                size_t ci = static_cast<size_t>(idx) * channels;
                float r = rgb[ci] / 255.0f, g = rgb[ci + 1] / 255.0f, b = rgb[ci + 2] / 255.0f;
                float L = 0.2126f * r + 0.7152f * g + 0.0722f * b;
                float dL = L - lumSmooth[idx];
                // Micro-relief: bright flutes/cornices project forward (-Z), dark insets recede (+Z)
                float relief = -dL * 0.45f;
                // Archway cavity pull
                float cav = 0.0f;
                if (cavityDepth > 0.0f && L < cavityLum) {
                    float factor = std::clamp((cavityLum - L) / cavityLum, 0.0f, 1.0f);
                    cav = cavityDepth * factor;
                }
                deltaZ = relief + cav;
            }

            deltaZ = std::clamp(deltaZ, -maxDeltaZ, maxDeltaZ);
            if (std::fabs(deltaZ) > 0.005f) {
                microDisplacedCount++;
            }
            eff[idx] = std::max(0.05f, dMesh + neuralDepthWeight * deltaZ);
        }
    }

    return eff;
}

int main(int argc, char** argv) {
    std::string rgbPath, depthPath, posePath, outSplat, outSpz, fuseListPath, neuralDepthPath;
    int W = 0, H = 0, stride = 1, smoothRadius = 15;
    float sigmaScale = 1.15f, tau = 0.08f, maxDepth = 400.0f, minCosIncidence = 0.05f, voxelSize = 0.20f, cropRadius = 0.0f, minGroundY = -0.05f;
    float cavityDepth = 0.0f, cavityLum = 0.18f;
    float cameraAltitude = -1.0f;
    float neuralDepthWeight = 1.0f, maxDeltaZ = 3.5f, normalPruneCos = 0.0f;
    std::string foliageMode = "drop";
    bool emitJson = false, dropFoliage = false, excludeUnderside = true, enableHybridMicroDepth = false, enablePhotometricMicroDepth = false;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&](std::string& dst) { if (i + 1 < argc) dst = argv[++i]; };
        if (a == "--rgb") next(rgbPath);
        else if (a == "--depth") next(depthPath);
        else if (a == "--neural-depth") next(neuralDepthPath);
        else if (a == "--neural-depth-weight" && i + 1 < argc) neuralDepthWeight = std::stof(argv[++i]);
        else if (a == "--max-delta-z" && i + 1 < argc) maxDeltaZ = std::stof(argv[++i]);
        else if (a == "--smooth-radius" && i + 1 < argc) smoothRadius = std::stoi(argv[++i]);
        else if (a == "--photometric-micro-depth") enablePhotometricMicroDepth = true;
        else if (a == "--hybrid-micro-depth") enableHybridMicroDepth = true;
        else if (a == "--normal-prune-cos" && i + 1 < argc) normalPruneCos = std::stof(argv[++i]);
        else if (a == "--pose") next(posePath);
        else if (a == "--out-splat") next(outSplat);
        else if (a == "--out-spz") next(outSpz);
        else if (a == "--fuse-list") next(fuseListPath);
        else if (a == "--voxel-size" && i + 1 < argc) voxelSize = std::stof(argv[++i]);
        else if (a == "--crop-radius" && i + 1 < argc) cropRadius = std::stof(argv[++i]);
        else if (a == "--cavity-depth" && i + 1 < argc) cavityDepth = std::stof(argv[++i]);
        else if (a == "--cavity-lum" && i + 1 < argc) cavityLum = std::stof(argv[++i]);
        else if (a == "--station-altitude" && i + 1 < argc) cameraAltitude = std::stof(argv[++i]);
        else if (a == "--foliage-mode" && i + 1 < argc) foliageMode = argv[++i];
        else if (a == "--width" && i + 1 < argc) W = std::stoi(argv[++i]);
        else if (a == "--height" && i + 1 < argc) H = std::stoi(argv[++i]);
        else if (a == "--stride" && i + 1 < argc) stride = std::max(1, std::stoi(argv[++i]));
        else if (a == "--sigma-scale" && i + 1 < argc) sigmaScale = std::stof(argv[++i]);
        else if (a == "--tau" && i + 1 < argc) tau = std::stof(argv[++i]);
        else if (a == "--max-depth" && i + 1 < argc) maxDepth = std::stof(argv[++i]);
        else if (a == "--min-cos-incidence" && i + 1 < argc) minCosIncidence = std::stof(argv[++i]);
        else if (a == "--drop-foliage") { dropFoliage = true; foliageMode = "drop"; }
        else if (a == "--exclude-underside") excludeUnderside = true;
        else if (a == "--include-underside") excludeUnderside = false;
        else if (a == "--min-y" && i + 1 < argc) minGroundY = std::stof(argv[++i]);
        else if (a == "--json") emitJson = true;
    }

    if (!fuseListPath.empty()) {
        return runFuse(fuseListPath, voxelSize, cropRadius, dropFoliage, excludeUnderside, minGroundY, normalPruneCos, outSplat, outSpz, emitJson);
    }

    if (rgbPath.empty() || depthPath.empty() || posePath.empty() || (outSplat.empty() && outSpz.empty()) || W <= 0 || H <= 0) {
        std::cerr << "Usage: station_to_splats --rgb rgb24.raw --depth depth.f32 --width W --height H --pose pose.json --out-splat out.splat [--out-spz out.spz] [--stride 1] [--sigma-scale 0.35] [--tau 0.08] [--min-cos-incidence 0.15] [--cavity-depth 3.5] [--station-altitude 3.5] [--drop-foliage] [--photometric-micro-depth] [--json]" << std::endl;
        std::cerr << "   or: station_to_splats --fuse-list list.txt --voxel-size 0.20 [--crop-radius 115.0] [--normal-prune-cos 0.35] [--drop-foliage] --out-splat fused.splat [--out-spz fused.spz] [--json]" << std::endl;
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
    if (cameraAltitude < 0.0f) {
        cameraAltitude = eye.y;
    }

    // Hybrid Micro-Depth Displacement: Compute effective depth buffer
    size_t microDisplacedCount = 0;
    std::vector<float> effectiveDepth = computeEffectiveDepth(
        W, H, depth, rgb.data(), channels, maxDepth,
        neuralDepthPath, enablePhotometricMicroDepth || enableHybridMicroDepth,
        neuralDepthWeight, maxDeltaZ, smoothRadius, cavityDepth, cavityLum, microDisplacedCount
    );

    auto valid = [&](int u, int v) -> bool {
        if (u < 0 || v < 0 || u >= W || v >= H) return false;
        float d = effectiveDepth[v * W + u];
        return d > 0.05f && d < maxDepth && d < 1e8f;
    };
    auto world = [&](int u, int v) -> Vec3 {
        float z = effectiveDepth[v * W + u];
        float X = (static_cast<float>(u) + 0.5f - cx) / fx * z;
        float Y = -(static_cast<float>(v) + 0.5f - cy) / fy * z;
        return eye + right * X + up * Y + fwd * z;
    };

    std::vector<GaussianSplat> splats;
    splats.reserve(static_cast<size_t>(W / stride) * (H / stride));
    size_t severed = 0, grazing = 0, foliageDropped = 0, cavitiesCarved = 0;
    for (int v = 0; v < H; v += stride) {
        for (int u = 0; u < W; u += stride) {
            if (!valid(u, v)) continue;
            const float z = effectiveDepth[v * W + u];
            const size_t ci = (static_cast<size_t>(v) * W + u) * channels;
            if (channels == 4 && rgb[ci + 3] < 16) continue;

            const float rVal = rgb[ci] / 255.0f;
            const float gVal = rgb[ci + 1] / 255.0f;
            const float bVal = rgb[ci + 2] / 255.0f;
            const float sumRgb = rVal + gVal + bVal + 1e-5f;
            const float rn = rVal / sumRgb, gn = gVal / sumRgb, bn = bVal / sumRgb;

            Vec3 p = world(u, v);

            // Organic foliage / vegetation detection (Excess Green Index ExG = 2G - R - B)
            // plus secondary Color Distance check for dark green foliage (R < 70, G > 65, B < 60)
            const float exg = 2.0f * gVal - rVal - bVal;
            const bool isDarkGreen = (rgb[ci] < 70 && rgb[ci + 1] > 65 && rgb[ci + 2] < 60);
            const bool isOrganic = (gn > 0.36f && gVal > rVal + 0.015f && gVal > bVal + 0.015f) || (exg > 0.08f) || isDarkGreen;
            if (isOrganic) {
                if (dropFoliage || foliageMode == "drop") {
                    foliageDropped++;
                    continue;
                } else if (foliageMode == "jitter") {
                    // Decoupled spherical volume splats with randomized jitter (+-0.3m) to eliminate melted wax artifacts
                    float jx = (((u * 137 + v * 269) % 100) / 50.0f - 1.0f) * 0.3f;
                    float jy = (((u * 389 + v * 491) % 100) / 50.0f - 1.0f) * 0.3f;
                    float jz = (((u * 503 + v * 617) % 100) / 50.0f - 1.0f) * 0.3f;
                    Vec3 pj = p + Vec3(jx, jy, jz);
                    float volSigma = 0.22f;
                    GaussianSplat s;
                    s.position = pj;
                    s.scale = Vec3(volSigma, volSigma, volSigma);
                    s.rotation = Quat(0, 0, 0, 1);
                    s.color = Vec3(rVal, gVal, bVal);
                    s.opacity = channels == 4 ? rgb[ci + 3] / 255.0f : 1.0f;
                    splats.push_back(s);
                    continue;
                }
            }

            // Neighbours for the tangent plane, respecting edge severance (relative depth jump > tau)
            // On organic foliage, use tighter severance to prevent smooth canopy bridging
            const float localTau = isOrganic ? tau * 0.35f : tau;
            auto pick = [&](int du, int dv, Vec3& out) -> bool {
                int uu = u + du, vv = v + dv;
                if (!valid(uu, vv)) return false;
                float zn = effectiveDepth[vv * W + uu];
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
            // Strict Invariant: Exclude the underside of the model and subsurface ground floor
            // In the ENU tangent plane, +Y is up. A geometric normal pointing downward (n.y < -0.30f)
            // at the ground level (p.y <= minGroundY + 1.0f) represents the bottom cap / baseplate
            // of the 3D tiles mesh. Vaults, arch ceilings, and setbacks (p.y > minGroundY + 1.0f) are preserved!
            if (excludeUnderside && ((n.y < -0.30f && p.y <= minGroundY + 1.0f) || p.y < minGroundY)) continue;
            // Face the camera
            Vec3 toCam = (eye - p).normalized();
            if (n.dot(toCam) < 0.0f) n = -n;
            bool isolated = !(hr || hl) || !(hd || hu);
            if (isolated) severed++;
            // Step 4: Strict Grazing-Angle Rejection Filter
            // Extremely grazing samples (far ground seen almost edge-on) smear into stripes and are
            // always better covered by another station; drop them rather than elongate them.
            if (std::fabs(n.dot(toCam)) < minCosIncidence) { grazing++; continue; }

            // Step 3: Analytical Depth Cavity Inpainting for Arches & Portals
            // (If effectiveDepth already displaced for cavities, account for it; otherwise displace directly)
            const float lum = 0.2126f * rVal + 0.7152f * gVal + 0.0722f * bVal;
            if (!enablePhotometricMicroDepth && !enableHybridMicroDepth && neuralDepthPath.empty()) {
                if (cavityDepth > 0.0f && lum < cavityLum && std::fabs(n.y) < 0.45f && n.dot(toCam) > 0.50f) {
                    const float cavityFactor = std::clamp((cavityLum - lum) / cavityLum, 0.0f, 1.0f);
                    const Vec3 rayDir = (p - eye).normalized();
                    p = p + rayDir * (cavityDepth * cavityFactor);
                    cavitiesCarved++;
                }
            } else if (cavityDepth > 0.0f && lum < cavityLum && std::fabs(n.y) < 0.45f) {
                cavitiesCarved++;
            }

            // Multi-Scale Ground Paver Synthesis for Tier 1 street stations:
            // Tight ground footprint stride (stride = 1) on surfaces where |n.y| > 0.85
            const bool isGround = (std::fabs(n.y) > 0.85f);
            const float effectiveStride = (cameraAltitude <= 10.0f && isGround) ? 1.0f : static_cast<float>(stride);
            const float spacing = z / fx * effectiveStride;
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
            s.scale = Vec3(s1, s2, std::max(0.001f, sigma * 0.12f));
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
                  << ",\"foliageDropped\":" << foliageDropped << ",\"cavitiesCarved\":" << cavitiesCarved
                  << ",\"microDisplaced\":" << microDisplacedCount
                  << ",\"splatBytes\":" << splatBytes << ",\"spzBytes\":" << spzBytes << ",\"durationMs\":" << ms << "}" << std::endl;
    } else {
        std::cout << "[StationSplats] " << splats.size() << " splats (" << severed << " edge-severed, " << grazing << " grazing-dropped, " << foliageDropped << " foliage-dropped, " << cavitiesCarved << " cavities-carved, " << microDisplacedCount << " micro-displaced) in " << ms << " ms" << std::endl;
    }
    return 0;
}
