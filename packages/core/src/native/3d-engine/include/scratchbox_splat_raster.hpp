/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * A software renderer for Gaussian splats, so a splat world can be judged from exactly the poses and in the same neutral
 * light as the photo-match judge's triangle arms (photo-match-eval.ts renderTriangles), with no browser or GPU.
 *
 * - Projection: the app's EWA projection (common/spatial/splat-ewa-projection.ts, the viewer's sbEwaProject) in the same
 *   order: Σ' = J W R S Sᵀ Rᵀ Wᵀ Jᵀ with the Jacobian at the centre (x/z and y/z clamped to EWA_FRUSTUM_GUARD times the
 *   half-frustum), a 0.3 px² dilation, the opacity compensated by sqrt(det Σ' / det Σ''), splats under 1/255 culled, the
 *   footprint cut at 3 sigma and each fragment's alpha min(0.99, α exp(-r²/2)), dropped under 1/255.
 * - The camera is the judge's pinhole: pixel x = cx + fx * (d.right) / z, y = cy - fy * (d.up) / z with z = d.fwd, pixel
 *   centres at +0.5; nothing nearer than `near`.
 * - Light, as renderTriangles: textured, each splat's colour (sRGB) in linear light times ambient + (1 - ambient) |n . v|
 *   (n the splat's local +Z, the flattened axis of a surfel; v the view ray to its centre); clay, one albedo times
 *   ambient + (1 - ambient) max(0, n . key) with n turned to face the camera and the judge's key light (behind the
 *   camera, raised, a little to its left). Splats are composited front to back (sorted by camera z) over the background,
 *   in linear light, then written as sRGB8.
 * - Outputs per view: RGBA8; coverage, the share of each pixel the splats cover (1 - transmittance); and, with labels per
 *   splat, the label of the splat that takes each pixel past half coverage (`skyLabel` where none does).
 */

#pragma once

#include "scratchbox_math.hpp"
#include "scratchbox_spz.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <numeric>
#include <vector>

namespace scratchbox {
namespace splatraster {

using math::Vec3;

constexpr float EWA_DILATION_PX2 = 0.3f;
constexpr float EWA_CUTOFF_SIGMA = 3.0f;
constexpr float EWA_FRUSTUM_GUARD = 1.3f;

struct Camera {
    int width = 0, height = 0;
    float fx = 1, fy = 1, cx = 0, cy = 0;
    Vec3 eye, right, up, fwd;
};

struct Light {
    /** Textured: ambient share and the background (sRGB8). */
    float ambient = 0.72f;
    std::array<float, 3> background{128, 128, 128};
    /** Clay: one albedo (sRGB8), its ambient share and background. */
    bool clay = false;
    std::array<float, 3> clayAlbedo{150, 152, 156};
    float clayAmbient = 0.34f;
    std::array<float, 3> clayBackground{222, 226, 232};
    float nearM = 0.25f;
};

struct Render {
    int width = 0, height = 0;
    std::vector<uint8_t> rgba;
    std::vector<float> coverage;
    std::vector<uint8_t> regions;
    /** With labels: per pixel the camera z of the splat that labelled it (1e9 where none did). */
    std::vector<float> regionDepth;
    size_t drawn = 0;
};

inline float srgbToLinear(float c) { c = c / 255.0f; return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
inline uint8_t linearToSrgb8(float c) {
    c = std::clamp(c, 0.0f, 1.0f);
    const float s = c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f;
    return static_cast<uint8_t>(std::lround(std::clamp(s, 0.0f, 1.0f) * 255.0f));
}

/** One splat projected: its centre and inverse dilated covariance in pixels, alpha, linear colour, camera z, extent. */
struct Projected {
    float u, v, ia, ib, ic, opacity, z;
    float r, g, b;
    int x0, x1, y0, y1;
    uint32_t index;
};

/**
 * Projects `s` into `cam`; false when it is culled. The covariance is formed as A Aᵀ with A = J T, T the splat's
 * scaled axes in the camera frame (right, up, fwd), so it is positive semi-definite for flattened surfels.
 */
inline bool projectSplat(const spz::GaussianSplat& s, const Camera& cam, float nearM, Projected& out) {
    const Vec3 d = s.position - cam.eye;
    const float x = d.dot(cam.right), y = d.dot(cam.up), z = d.dot(cam.fwd);
    if (z <= nearM) return false;
    float qx = s.rotation.x, qy = s.rotation.y, qz = s.rotation.z, qw = s.rotation.w;
    const float ql = std::sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (ql > 1e-8f) { qx /= ql; qy /= ql; qz /= ql; qw /= ql; } else { qx = qy = qz = 0; qw = 1; }
    const float xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
    const Vec3 c0 = Vec3(1 - 2 * (yy + zz), 2 * (xy + wz), 2 * (xz - wy)) * s.scale.x;
    const Vec3 c1 = Vec3(2 * (xy - wz), 1 - 2 * (xx + zz), 2 * (yz + wx)) * s.scale.y;
    const Vec3 c2 = Vec3(2 * (xz + wy), 2 * (yz - wx), 1 - 2 * (xx + yy)) * s.scale.z;
    // the Jacobian of (cx + fx x / z, cy - fy y / z) at the centre, x/z and y/z guarded as the viewer guards them
    const float limX = EWA_FRUSTUM_GUARD * (0.5f * cam.width) / cam.fx, limY = EWA_FRUSTUM_GUARD * (0.5f * cam.height) / cam.fy;
    const float tx = std::clamp(x / z, -limX, limX) * z, ty = std::clamp(y / z, -limY, limY) * z;
    const float j00 = cam.fx / z, j02 = -cam.fx * tx / (z * z), j11 = -cam.fy / z, j12 = cam.fy * ty / (z * z);
    float a0[3], a1[3];
    const Vec3 cols[3] = {c0, c1, c2};
    for (int k = 0; k < 3; ++k) {
        const float px = cols[k].dot(cam.right), py = cols[k].dot(cam.up), pz = cols[k].dot(cam.fwd);
        a0[k] = j00 * px + j02 * pz;
        a1[k] = j11 * py + j12 * pz;
    }
    float s00 = a0[0] * a0[0] + a0[1] * a0[1] + a0[2] * a0[2];
    const float s01 = a0[0] * a1[0] + a0[1] * a1[1] + a0[2] * a1[2];
    float s11 = a1[0] * a1[0] + a1[1] * a1[1] + a1[2] * a1[2];
    const float det0 = std::max(s00 * s11 - s01 * s01, 0.0f);
    s00 += EWA_DILATION_PX2; s11 += EWA_DILATION_PX2;
    const float det1 = s00 * s11 - s01 * s01;
    out.opacity = s.opacity * std::sqrt(det0 / det1);
    if (out.opacity < 1.0f / 255.0f) return false;
    out.u = cam.cx + cam.fx * x / z;
    out.v = cam.cy - cam.fy * y / z;
    out.z = z;
    out.ia = s11 / det1; out.ib = -s01 / det1; out.ic = s00 / det1;
    // the 3-sigma box of the dilated covariance, capped as the viewer caps its quad
    const float maxR = 2.0f * std::max(cam.width, cam.height);
    const float ex = std::min(EWA_CUTOFF_SIGMA * std::sqrt(s00), maxR), ey = std::min(EWA_CUTOFF_SIGMA * std::sqrt(s11), maxR);
    out.x0 = std::max(0, static_cast<int>(std::floor(out.u - ex))); out.x1 = std::min(cam.width - 1, static_cast<int>(std::ceil(out.u + ex)));
    out.y0 = std::max(0, static_cast<int>(std::floor(out.v - ey))); out.y1 = std::min(cam.height - 1, static_cast<int>(std::ceil(out.v + ey)));
    return out.x0 <= out.x1 && out.y0 <= out.y1;
}

/** Renders `splats` from `cam` in `light`; `labels` (one per splat, or empty) give the regions. */
inline Render render(const std::vector<spz::GaussianSplat>& splats, const std::vector<uint8_t>& labels, uint8_t skyLabel, const Camera& cam, const Light& light) {
    Render out;
    out.width = cam.width; out.height = cam.height;
    const size_t N = static_cast<size_t>(cam.width) * cam.height;
    std::vector<Projected> list;
    list.reserve(splats.size() / 2);
    // the clay key light: behind the camera, raised and a little to its left (world up is +y)
    Vec3 key = cam.fwd * -0.55f + Vec3(0, 0.7f, 0) - cam.right * 0.35f;
    key = key.normalized();
    const float amb = light.clay ? light.clayAmbient : light.ambient;
    const float albedo[3] = {srgbToLinear(light.clayAlbedo[0]), srgbToLinear(light.clayAlbedo[1]), srgbToLinear(light.clayAlbedo[2])};
    for (size_t i = 0; i < splats.size(); ++i) {
        const auto& s = splats[i];
        Projected p;
        if (!projectSplat(s, cam, light.nearM, p)) continue;
        p.index = static_cast<uint32_t>(i);
        const float qx = s.rotation.x, qy = s.rotation.y, qz = s.rotation.z, qw = s.rotation.w;
        Vec3 n(2 * (qx * qz + qw * qy), 2 * (qy * qz - qw * qx), 1 - 2 * (qx * qx + qy * qy));
        n = n.lengthSq() > 1e-8f ? n.normalized() : Vec3(0, 0, 1);
        const Vec3 view = (s.position - cam.eye).normalized();
        const float nv = n.dot(view);
        if (light.clay) {
            const Vec3 nf = nv > 0 ? n * -1.0f : n;
            const float shade = amb + (1 - amb) * std::max(0.0f, nf.dot(key));
            p.r = albedo[0] * shade; p.g = albedo[1] * shade; p.b = albedo[2] * shade;
        } else {
            const float shade = amb + (1 - amb) * std::fabs(nv);
            p.r = srgbToLinear(s.color.x * 255.0f) * shade; p.g = srgbToLinear(s.color.y * 255.0f) * shade; p.b = srgbToLinear(s.color.z * 255.0f) * shade;
        }
        list.push_back(p);
    }
    out.drawn = list.size();
    std::sort(list.begin(), list.end(), [](const Projected& a, const Projected& b) { return a.z < b.z; });
    std::vector<float> T(N, 1.0f), acc(N * 3, 0.0f);
    if (!labels.empty()) { out.regions.assign(N, skyLabel); out.regionDepth.assign(N, 1e9f); }
    std::vector<uint8_t> labelled(labels.empty() ? 0 : N, 0);
    for (const auto& p : list) {
        for (int y = p.y0; y <= p.y1; ++y) {
            const float dy = y + 0.5f - p.v;
            for (int x = p.x0; x <= p.x1; ++x) {
                const size_t k = static_cast<size_t>(y) * cam.width + x;
                if (T[k] < 1e-4f) continue;
                const float dx = x + 0.5f - p.u;
                const float r2 = p.ia * dx * dx + 2 * p.ib * dx * dy + p.ic * dy * dy;
                if (r2 > EWA_CUTOFF_SIGMA * EWA_CUTOFF_SIGMA) continue;
                const float a = std::min(0.99f, p.opacity * std::exp(-0.5f * r2));
                if (a < 1.0f / 255.0f) continue;
                const float w = T[k] * a;
                acc[k * 3] += w * p.r; acc[k * 3 + 1] += w * p.g; acc[k * 3 + 2] += w * p.b;
                T[k] -= w;
                if (!labelled.empty() && !labelled[k] && T[k] <= 0.5f) { out.regions[k] = labels[p.index]; out.regionDepth[k] = p.z; labelled[k] = 1; }
            }
        }
    }
    const auto& bgS = light.clay ? light.clayBackground : light.background;
    const float bg[3] = {srgbToLinear(bgS[0]), srgbToLinear(bgS[1]), srgbToLinear(bgS[2])};
    out.rgba.resize(N * 4);
    out.coverage.resize(N);
    for (size_t k = 0; k < N; ++k) {
        for (int c = 0; c < 3; ++c) out.rgba[k * 4 + c] = linearToSrgb8(acc[k * 3 + c] + T[k] * bg[c]);
        out.rgba[k * 4 + 3] = 255;
        out.coverage[k] = 1.0f - T[k];
    }
    return out;
}

} // namespace splatraster
} // namespace scratchbox
