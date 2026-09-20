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

int main(int argc, char** argv) {
    std::string rgbPath, depthPath, posePath, outSplat, outSpz;
    int W = 0, H = 0, stride = 1;
    float sigmaScale = 0.95f, tau = 0.08f, maxDepth = 400.0f, minCosIncidence = 0.12f;
    bool emitJson = false;
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto next = [&](std::string& dst) { if (i + 1 < argc) dst = argv[++i]; };
        if (a == "--rgb") next(rgbPath);
        else if (a == "--depth") next(depthPath);
        else if (a == "--pose") next(posePath);
        else if (a == "--out-splat") next(outSplat);
        else if (a == "--out-spz") next(outSpz);
        else if (a == "--width" && i + 1 < argc) W = std::stoi(argv[++i]);
        else if (a == "--height" && i + 1 < argc) H = std::stoi(argv[++i]);
        else if (a == "--stride" && i + 1 < argc) stride = std::max(1, std::stoi(argv[++i]));
        else if (a == "--sigma-scale" && i + 1 < argc) sigmaScale = std::stof(argv[++i]);
        else if (a == "--tau" && i + 1 < argc) tau = std::stof(argv[++i]);
        else if (a == "--max-depth" && i + 1 < argc) maxDepth = std::stof(argv[++i]);
        else if (a == "--min-cos-incidence" && i + 1 < argc) minCosIncidence = std::stof(argv[++i]);
        else if (a == "--json") emitJson = true;
    }
    if (rgbPath.empty() || depthPath.empty() || posePath.empty() || (outSplat.empty() && outSpz.empty()) || W <= 0 || H <= 0) {
        std::cerr << "Usage: station_to_splats --rgb rgb24.raw --depth depth.f32 --width W --height H --pose pose.json --out-splat out.splat [--out-spz out.spz] [--stride 1] [--sigma-scale 0.95] [--tau 0.08] [--min-cos-incidence 0.12] [--json]" << std::endl;
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
    size_t severed = 0, grazing = 0;
    for (int v = 0; v < H; v += stride) {
        for (int u = 0; u < W; u += stride) {
            if (!valid(u, v)) continue;
            const float z = depth[v * W + u];
            const size_t ci = (static_cast<size_t>(v) * W + u) * channels;
            if (channels == 4 && rgb[ci + 3] < 16) continue;

            const Vec3 p = world(u, v);
            // Neighbours for the tangent plane, respecting edge severance (relative depth jump > tau)
            auto pick = [&](int du, int dv, Vec3& out) -> bool {
                int uu = u + du, vv = v + dv;
                if (!valid(uu, vv)) return false;
                float zn = depth[vv * W + uu];
                if (std::fabs(zn - z) / z > tau) return false;
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
                  << ",\"splatBytes\":" << splatBytes << ",\"spzBytes\":" << spzBytes << ",\"durationMs\":" << ms << "}" << std::endl;
    } else {
        std::cout << "[StationSplats] " << splats.size() << " splats (" << severed << " edge-severed) in " << ms << " ms" << std::endl;
    }
    return 0;
}
