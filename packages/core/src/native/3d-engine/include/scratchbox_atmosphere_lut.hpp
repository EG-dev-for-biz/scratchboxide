/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/*
 * Portions of this file are a C++ port of Eric Bruneton's "Precomputed Atmospheric Scattering"
 * (https://github.com/ebruneton/precomputed_atmospheric_scattering, atmosphere/functions.glsl,
 * atmosphere/model.cc and atmosphere/reference/model.cc), distributed under this licence:
 *
 * Copyright (c) 2017 Eric Bruneton
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 * 3. Neither the name of the copyright holders nor the names of its
 *    contributors may be used to endorse or promote products derived from
 *    this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF
 * THE POSSIBILITY OF SUCH DAMAGE.
 */

/**
 * Precomputed atmospheric scattering (Bruneton & Neyret 2008, the 2017 reference implementation) on the CPU:
 * transmittance, direct irradiance, single Rayleigh and Mie scattering, then for each further order the scattering
 * density, the indirect irradiance and the multiple scattering, accumulated into the tables a renderer samples.
 *
 * The tables keep Bruneton's layout, which three-geospatial ships too (transmittance 256 x 64; scattering 256 x 128 x 32,
 * that is NU 8 x MU_S 32 by MU 128 by R 32; irradiance 64 x 16), so a GLSL port of his runtime functions reads them as
 * they are. Every input is a continuous physical quantity: radii, layered density profiles, per-wavelength scattering
 * and absorption coefficients, the Mie asymmetry, the solar spectrum and the ground albedo. Nothing names a planet.
 *
 * Wavelengths are precomputed three at a time, as Bruneton's GPU model does. Each batch carries a 3 x 3 matrix taking
 * its three spectral radiances to the output channels: the identity stores radiance at three wavelengths, and a
 * colour-matching matrix (times each bin's width) integrates many bins into linear sRGB. Within a batch everything is
 * computed at its own wavelengths; only the accumulated outputs are converted. The transmittance table is computed
 * last at its own three wavelengths. All arithmetic is double precision; the arithmetic is Bruneton's, line for line.
 */

#ifndef SCRATCHBOX_ATMOSPHERE_LUT_HPP
#define SCRATCHBOX_ATMOSPHERE_LUT_HPP

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>

namespace scratchbox {
namespace atmosphere_lut {

constexpr double kPi = 3.14159265358979323846;

constexpr int TRANSMITTANCE_TEXTURE_WIDTH = 256;
constexpr int TRANSMITTANCE_TEXTURE_HEIGHT = 64;
constexpr int SCATTERING_TEXTURE_R_SIZE = 32;
constexpr int SCATTERING_TEXTURE_MU_SIZE = 128;
constexpr int SCATTERING_TEXTURE_MU_S_SIZE = 32;
constexpr int SCATTERING_TEXTURE_NU_SIZE = 8;
constexpr int SCATTERING_TEXTURE_WIDTH = SCATTERING_TEXTURE_NU_SIZE * SCATTERING_TEXTURE_MU_S_SIZE;
constexpr int SCATTERING_TEXTURE_HEIGHT = SCATTERING_TEXTURE_MU_SIZE;
constexpr int SCATTERING_TEXTURE_DEPTH = SCATTERING_TEXTURE_R_SIZE;
constexpr int IRRADIANCE_TEXTURE_WIDTH = 64;
constexpr int IRRADIANCE_TEXTURE_HEIGHT = 16;

/** Three spectral (or colour) channels. */
struct Spec {
    double v[3]{0, 0, 0};
    Spec() = default;
    explicit Spec(double s) : v{s, s, s} {}
    Spec(double a, double b, double c) : v{a, b, c} {}
    double& operator[](int i) { return v[i]; }
    double operator[](int i) const { return v[i]; }
    Spec operator+(const Spec& o) const { return {v[0] + o.v[0], v[1] + o.v[1], v[2] + o.v[2]}; }
    Spec operator-(const Spec& o) const { return {v[0] - o.v[0], v[1] - o.v[1], v[2] - o.v[2]}; }
    Spec operator*(const Spec& o) const { return {v[0] * o.v[0], v[1] * o.v[1], v[2] * o.v[2]}; }
    Spec operator/(const Spec& o) const { return {v[0] / o.v[0], v[1] / o.v[1], v[2] / o.v[2]}; }
    Spec operator*(double s) const { return {v[0] * s, v[1] * s, v[2] * s}; }
    Spec& operator+=(const Spec& o) { v[0] += o.v[0]; v[1] += o.v[1]; v[2] += o.v[2]; return *this; }
};
inline Spec operator*(double s, const Spec& a) { return a * s; }
inline Spec exp(const Spec& a) { return {std::exp(a.v[0]), std::exp(a.v[1]), std::exp(a.v[2])}; }
inline Spec min(const Spec& a, const Spec& b) { return {std::min(a.v[0], b.v[0]), std::min(a.v[1], b.v[1]), std::min(a.v[2], b.v[2])}; }

/** Four channels: a combined scattering texel (rgb, single Mie red in alpha). */
struct Spec4 {
    double v[4]{0, 0, 0, 0};
    Spec4() = default;
    Spec4(const Spec& c, double a) : v{c.v[0], c.v[1], c.v[2], a} {}
    Spec rgb() const { return {v[0], v[1], v[2]}; }
    Spec4 operator+(const Spec4& o) const { Spec4 r; for (int i = 0; i < 4; ++i) r.v[i] = v[i] + o.v[i]; return r; }
    Spec4 operator*(double s) const { Spec4 r; for (int i = 0; i < 4; ++i) r.v[i] = v[i] * s; return r; }
};

struct Vec3d {
    double x{0}, y{0}, z{0};
    Vec3d operator+(const Vec3d& o) const { return {x + o.x, y + o.y, z + o.z}; }
    Vec3d operator-(const Vec3d& o) const { return {x - o.x, y - o.y, z - o.z}; }
    Vec3d operator*(double s) const { return {x * s, y * s, z * s}; }
};
inline double dot(const Vec3d& a, const Vec3d& b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
inline double length(const Vec3d& a) { return std::sqrt(dot(a, a)); }
inline Vec3d normalize(const Vec3d& a) { double l = length(a); return l > 0 ? a * (1.0 / l) : a; }

/** 3 x 3 matrix, row-major: out[i] = sum_j m[3i + j] * in[j]. */
struct Mat3 {
    double m[9]{1, 0, 0, 0, 1, 0, 0, 0, 1};
    Spec operator*(const Spec& s) const {
        return {m[0] * s[0] + m[1] * s[1] + m[2] * s[2], m[3] * s[0] + m[4] * s[1] + m[5] * s[2], m[6] * s[0] + m[7] * s[1] + m[8] * s[2]};
    }
};

/** density = exp_term * exp(exp_scale * h) + linear_term * h + constant_term, clamped to [0, 1]; h the altitude (m). */
struct DensityProfileLayer {
    double width{0}, exp_term{0}, exp_scale{0}, linear_term{0}, constant_term{0};
};
/** Two layers, bottom to top; the top layer's width is ignored (it reaches the top of the atmosphere). */
struct DensityProfile {
    DensityProfileLayer layers[2];
};

/** One batch's medium: everything spectral sampled at the batch's three wavelengths. Lengths in metres. */
struct AtmosphereParameters {
    Spec solar_irradiance;
    double sun_angular_radius{0.004675};
    double bottom_radius{0};
    double top_radius{0};
    DensityProfile rayleigh_density;
    Spec rayleigh_scattering;
    DensityProfile mie_density;
    Spec mie_scattering;
    Spec mie_extinction;
    double mie_phase_function_g{0.8};
    DensityProfile absorption_density;
    Spec absorption_extinction;
    Spec ground_albedo;
    double mu_s_min{-1.0};
};

// ---------------------------------------------------------------------------------------------------------------------
// Tables, sampled as OpenGL samples a texture with LINEAR filtering and CLAMP_TO_EDGE.

template <typename T>
struct Texture2D {
    int width{0}, height{0};
    std::vector<T> data;
    Texture2D() = default;
    Texture2D(int w, int h, const T& fill = T()) : width(w), height(h), data(static_cast<size_t>(w) * h, fill) {}
    T& at(int i, int j) { return data[static_cast<size_t>(j) * width + i]; }
    const T& at(int i, int j) const { return data[static_cast<size_t>(j) * width + i]; }
    T sample(double u, double v) const {
        double x = u * width - 0.5, y = v * height - 0.5;
        int i0 = static_cast<int>(std::floor(x)), j0 = static_cast<int>(std::floor(y));
        double fx = x - i0, fy = y - j0;
        int i1 = std::clamp(i0 + 1, 0, width - 1), j1 = std::clamp(j0 + 1, 0, height - 1);
        i0 = std::clamp(i0, 0, width - 1); j0 = std::clamp(j0, 0, height - 1);
        return (at(i0, j0) * (1 - fx) + at(i1, j0) * fx) * (1 - fy) + (at(i0, j1) * (1 - fx) + at(i1, j1) * fx) * fy;
    }
};

/** OpenGL LINEAR + CLAMP_TO_EDGE filtering of a w x h x d table whose texel (i, j, k) is fetch(i, j, k). */
template <typename F>
auto sampleTrilinear(int width, int height, int depth, double u, double v, double w, F fetch) {
    double x = u * width - 0.5, y = v * height - 0.5, z = w * depth - 0.5;
    int i0 = static_cast<int>(std::floor(x)), j0 = static_cast<int>(std::floor(y)), k0 = static_cast<int>(std::floor(z));
    double fx = x - i0, fy = y - j0, fz = z - k0;
    int i1 = std::clamp(i0 + 1, 0, width - 1), j1 = std::clamp(j0 + 1, 0, height - 1), k1 = std::clamp(k0 + 1, 0, depth - 1);
    i0 = std::clamp(i0, 0, width - 1); j0 = std::clamp(j0, 0, height - 1); k0 = std::clamp(k0, 0, depth - 1);
    auto plane = [&](int k) {
        return (fetch(i0, j0, k) * (1 - fx) + fetch(i1, j0, k) * fx) * (1 - fy) + (fetch(i0, j1, k) * (1 - fx) + fetch(i1, j1, k) * fx) * fy;
    };
    return plane(k0) * (1 - fz) + plane(k1) * fz;
}

template <typename T>
struct Texture3D {
    int width{0}, height{0}, depth{0};
    std::vector<T> data;
    Texture3D() = default;
    Texture3D(int w, int h, int d, const T& fill = T()) : width(w), height(h), depth(d), data(static_cast<size_t>(w) * h * d, fill) {}
    T& at(int i, int j, int k) { return data[(static_cast<size_t>(k) * height + j) * width + i]; }
    const T& at(int i, int j, int k) const { return data[(static_cast<size_t>(k) * height + j) * width + i]; }
    T sample(double u, double v, double w) const {
        return sampleTrilinear(width, height, depth, u, v, w, [this](int i, int j, int k) -> const T& { return at(i, j, k); });
    }
};

using TransmittanceTexture = Texture2D<Spec>;
using IrradianceTexture = Texture2D<Spec>;
using ReducedScatteringTexture = Texture3D<Spec>;
using ScatteringTexture = Texture3D<Spec>;
using ScatteringDensityTexture = Texture3D<Spec>;

inline TransmittanceTexture makeTransmittanceTexture(const Spec& fill = Spec()) { return TransmittanceTexture(TRANSMITTANCE_TEXTURE_WIDTH, TRANSMITTANCE_TEXTURE_HEIGHT, fill); }
inline IrradianceTexture makeIrradianceTexture(const Spec& fill = Spec()) { return IrradianceTexture(IRRADIANCE_TEXTURE_WIDTH, IRRADIANCE_TEXTURE_HEIGHT, fill); }
inline ScatteringTexture makeScatteringTexture(const Spec& fill = Spec()) { return ScatteringTexture(SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, SCATTERING_TEXTURE_DEPTH, fill); }

// ---------------------------------------------------------------------------------------------------------------------
// Bruneton's functions (functions.glsl), in his order and with his names.

inline double ClampCosine(double mu) { return std::clamp(mu, -1.0, 1.0); }
inline double ClampDistance(double d) { return std::max(d, 0.0); }
inline double ClampRadius(const AtmosphereParameters& a, double r) { return std::clamp(r, a.bottom_radius, a.top_radius); }
inline double SafeSqrt(double x) { return std::sqrt(std::max(x, 0.0)); }
inline double smoothstep(double e0, double e1, double x) {
    double t = std::clamp((x - e0) / (e1 - e0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

inline double DistanceToTopAtmosphereBoundary(const AtmosphereParameters& a, double r, double mu) {
    double discriminant = r * r * (mu * mu - 1.0) + a.top_radius * a.top_radius;
    return ClampDistance(-r * mu + SafeSqrt(discriminant));
}

inline double DistanceToBottomAtmosphereBoundary(const AtmosphereParameters& a, double r, double mu) {
    double discriminant = r * r * (mu * mu - 1.0) + a.bottom_radius * a.bottom_radius;
    return ClampDistance(-r * mu - SafeSqrt(discriminant));
}

inline bool RayIntersectsGround(const AtmosphereParameters& a, double r, double mu) {
    return mu < 0.0 && r * r * (mu * mu - 1.0) + a.bottom_radius * a.bottom_radius >= 0.0;
}

inline double GetLayerDensity(const DensityProfileLayer& layer, double altitude) {
    double density = layer.exp_term * std::exp(layer.exp_scale * altitude) + layer.linear_term * altitude + layer.constant_term;
    return std::clamp(density, 0.0, 1.0);
}

inline double GetProfileDensity(const DensityProfile& profile, double altitude) {
    return altitude < profile.layers[0].width ? GetLayerDensity(profile.layers[0], altitude) : GetLayerDensity(profile.layers[1], altitude);
}

inline double ComputeOpticalLengthToTopAtmosphereBoundary(const AtmosphereParameters& a, const DensityProfile& profile, double r, double mu) {
    const int SAMPLE_COUNT = 500;
    double dx = DistanceToTopAtmosphereBoundary(a, r, mu) / SAMPLE_COUNT;
    double result = 0.0;
    for (int i = 0; i <= SAMPLE_COUNT; ++i) {
        double d_i = i * dx;
        double r_i = std::sqrt(d_i * d_i + 2.0 * r * mu * d_i + r * r);
        double y_i = GetProfileDensity(profile, r_i - a.bottom_radius);
        double weight_i = i == 0 || i == SAMPLE_COUNT ? 0.5 : 1.0;
        result += y_i * weight_i * dx;
    }
    return result;
}

inline Spec ComputeTransmittanceToTopAtmosphereBoundary(const AtmosphereParameters& a, double r, double mu) {
    return exp(Spec(0.0) - (a.rayleigh_scattering * ComputeOpticalLengthToTopAtmosphereBoundary(a, a.rayleigh_density, r, mu) +
                            a.mie_extinction * ComputeOpticalLengthToTopAtmosphereBoundary(a, a.mie_density, r, mu) +
                            a.absorption_extinction * ComputeOpticalLengthToTopAtmosphereBoundary(a, a.absorption_density, r, mu)));
}

inline double GetTextureCoordFromUnitRange(double x, int texture_size) { return 0.5 / texture_size + x * (1.0 - 1.0 / texture_size); }
inline double GetUnitRangeFromTextureCoord(double u, int texture_size) { return (u - 0.5 / texture_size) / (1.0 - 1.0 / texture_size); }

struct Vec2d { double x{0}, y{0}; };
struct Vec4d { double x{0}, y{0}, z{0}, w{0}; };

inline Vec2d GetTransmittanceTextureUvFromRMu(const AtmosphereParameters& a, double r, double mu) {
    double H = std::sqrt(a.top_radius * a.top_radius - a.bottom_radius * a.bottom_radius);
    double rho = SafeSqrt(r * r - a.bottom_radius * a.bottom_radius);
    double d = DistanceToTopAtmosphereBoundary(a, r, mu);
    double d_min = a.top_radius - r;
    double d_max = rho + H;
    double x_mu = (d - d_min) / (d_max - d_min);
    double x_r = rho / H;
    return {GetTextureCoordFromUnitRange(x_mu, TRANSMITTANCE_TEXTURE_WIDTH), GetTextureCoordFromUnitRange(x_r, TRANSMITTANCE_TEXTURE_HEIGHT)};
}

inline void GetRMuFromTransmittanceTextureUv(const AtmosphereParameters& a, Vec2d uv, double& r, double& mu) {
    double x_mu = GetUnitRangeFromTextureCoord(uv.x, TRANSMITTANCE_TEXTURE_WIDTH);
    double x_r = GetUnitRangeFromTextureCoord(uv.y, TRANSMITTANCE_TEXTURE_HEIGHT);
    double H = std::sqrt(a.top_radius * a.top_radius - a.bottom_radius * a.bottom_radius);
    double rho = H * x_r;
    r = std::sqrt(rho * rho + a.bottom_radius * a.bottom_radius);
    double d_min = a.top_radius - r;
    double d_max = rho + H;
    double d = d_min + x_mu * (d_max - d_min);
    mu = d == 0.0 ? 1.0 : (H * H - rho * rho - d * d) / (2.0 * r * d);
    mu = ClampCosine(mu);
}

inline Spec ComputeTransmittanceToTopAtmosphereBoundaryTexture(const AtmosphereParameters& a, Vec2d frag_coord) {
    double r, mu;
    GetRMuFromTransmittanceTextureUv(a, {frag_coord.x / TRANSMITTANCE_TEXTURE_WIDTH, frag_coord.y / TRANSMITTANCE_TEXTURE_HEIGHT}, r, mu);
    return ComputeTransmittanceToTopAtmosphereBoundary(a, r, mu);
}

inline Spec GetTransmittanceToTopAtmosphereBoundary(const AtmosphereParameters& a, const TransmittanceTexture& t, double r, double mu) {
    Vec2d uv = GetTransmittanceTextureUvFromRMu(a, r, mu);
    return t.sample(uv.x, uv.y);
}

inline Spec GetTransmittance(const AtmosphereParameters& a, const TransmittanceTexture& t, double r, double mu, double d, bool ray_r_mu_intersects_ground) {
    double r_d = ClampRadius(a, std::sqrt(d * d + 2.0 * r * mu * d + r * r));
    double mu_d = ClampCosine((r * mu + d) / r_d);
    if (ray_r_mu_intersects_ground) {
        return min(GetTransmittanceToTopAtmosphereBoundary(a, t, r_d, -mu_d) / GetTransmittanceToTopAtmosphereBoundary(a, t, r, -mu), Spec(1.0));
    }
    return min(GetTransmittanceToTopAtmosphereBoundary(a, t, r, mu) / GetTransmittanceToTopAtmosphereBoundary(a, t, r_d, mu_d), Spec(1.0));
}

inline Spec GetTransmittanceToSun(const AtmosphereParameters& a, const TransmittanceTexture& t, double r, double mu_s) {
    double sin_theta_h = a.bottom_radius / r;
    double cos_theta_h = -std::sqrt(std::max(1.0 - sin_theta_h * sin_theta_h, 0.0));
    return GetTransmittanceToTopAtmosphereBoundary(a, t, r, mu_s) *
           smoothstep(-sin_theta_h * a.sun_angular_radius, sin_theta_h * a.sun_angular_radius, mu_s - cos_theta_h);
}

inline void ComputeSingleScatteringIntegrand(const AtmosphereParameters& a, const TransmittanceTexture& t, double r, double mu, double mu_s, double nu,
                                             double d, bool ray_r_mu_intersects_ground, Spec& rayleigh, Spec& mie) {
    double r_d = ClampRadius(a, std::sqrt(d * d + 2.0 * r * mu * d + r * r));
    double mu_s_d = ClampCosine((r * mu_s + d * nu) / r_d);
    Spec transmittance = GetTransmittance(a, t, r, mu, d, ray_r_mu_intersects_ground) * GetTransmittanceToSun(a, t, r_d, mu_s_d);
    rayleigh = transmittance * GetProfileDensity(a.rayleigh_density, r_d - a.bottom_radius);
    mie = transmittance * GetProfileDensity(a.mie_density, r_d - a.bottom_radius);
}

inline double DistanceToNearestAtmosphereBoundary(const AtmosphereParameters& a, double r, double mu, bool ray_r_mu_intersects_ground) {
    return ray_r_mu_intersects_ground ? DistanceToBottomAtmosphereBoundary(a, r, mu) : DistanceToTopAtmosphereBoundary(a, r, mu);
}

inline void ComputeSingleScattering(const AtmosphereParameters& a, const TransmittanceTexture& t, double r, double mu, double mu_s, double nu,
                                    bool ray_r_mu_intersects_ground, Spec& rayleigh, Spec& mie) {
    const int SAMPLE_COUNT = 50;
    double dx = DistanceToNearestAtmosphereBoundary(a, r, mu, ray_r_mu_intersects_ground) / SAMPLE_COUNT;
    Spec rayleigh_sum(0.0), mie_sum(0.0);
    for (int i = 0; i <= SAMPLE_COUNT; ++i) {
        double d_i = i * dx;
        Spec rayleigh_i, mie_i;
        ComputeSingleScatteringIntegrand(a, t, r, mu, mu_s, nu, d_i, ray_r_mu_intersects_ground, rayleigh_i, mie_i);
        double weight_i = (i == 0 || i == SAMPLE_COUNT) ? 0.5 : 1.0;
        rayleigh_sum += rayleigh_i * weight_i;
        mie_sum += mie_i * weight_i;
    }
    rayleigh = rayleigh_sum * dx * a.solar_irradiance * a.rayleigh_scattering;
    mie = mie_sum * dx * a.solar_irradiance * a.mie_scattering;
}

inline double RayleighPhaseFunction(double nu) {
    double k = 3.0 / (16.0 * kPi);
    return k * (1.0 + nu * nu);
}

inline double MiePhaseFunction(double g, double nu) {
    double k = 3.0 / (8.0 * kPi) * (1.0 - g * g) / (2.0 + g * g);
    return k * (1.0 + nu * nu) / std::pow(1.0 + g * g - 2.0 * g * nu, 1.5);
}

inline Vec4d GetScatteringTextureUvwzFromRMuMuSNu(const AtmosphereParameters& a, double r, double mu, double mu_s, double nu, bool ray_r_mu_intersects_ground) {
    double H = std::sqrt(a.top_radius * a.top_radius - a.bottom_radius * a.bottom_radius);
    double rho = SafeSqrt(r * r - a.bottom_radius * a.bottom_radius);
    double u_r = GetTextureCoordFromUnitRange(rho / H, SCATTERING_TEXTURE_R_SIZE);
    double r_mu = r * mu;
    double discriminant = r_mu * r_mu - r * r + a.bottom_radius * a.bottom_radius;
    double u_mu;
    if (ray_r_mu_intersects_ground) {
        double d = -r_mu - SafeSqrt(discriminant);
        double d_min = r - a.bottom_radius;
        double d_max = rho;
        u_mu = 0.5 - 0.5 * GetTextureCoordFromUnitRange(d_max == d_min ? 0.0 : (d - d_min) / (d_max - d_min), SCATTERING_TEXTURE_MU_SIZE / 2);
    } else {
        double d = -r_mu + SafeSqrt(discriminant + H * H);
        double d_min = a.top_radius - r;
        double d_max = rho + H;
        u_mu = 0.5 + 0.5 * GetTextureCoordFromUnitRange((d - d_min) / (d_max - d_min), SCATTERING_TEXTURE_MU_SIZE / 2);
    }
    double d = DistanceToTopAtmosphereBoundary(a, a.bottom_radius, mu_s);
    double d_min = a.top_radius - a.bottom_radius;
    double d_max = H;
    double aa = (d - d_min) / (d_max - d_min);
    double D = DistanceToTopAtmosphereBoundary(a, a.bottom_radius, a.mu_s_min);
    double A = (D - d_min) / (d_max - d_min);
    double u_mu_s = GetTextureCoordFromUnitRange(std::max(1.0 - aa / A, 0.0) / (1.0 + aa), SCATTERING_TEXTURE_MU_S_SIZE);
    double u_nu = (nu + 1.0) / 2.0;
    return {u_nu, u_mu_s, u_mu, u_r};
}

inline void GetRMuMuSNuFromScatteringTextureUvwz(const AtmosphereParameters& a, Vec4d uvwz, double& r, double& mu, double& mu_s, double& nu,
                                                 bool& ray_r_mu_intersects_ground) {
    double H = std::sqrt(a.top_radius * a.top_radius - a.bottom_radius * a.bottom_radius);
    double rho = H * GetUnitRangeFromTextureCoord(uvwz.w, SCATTERING_TEXTURE_R_SIZE);
    r = std::sqrt(rho * rho + a.bottom_radius * a.bottom_radius);
    if (uvwz.z < 0.5) {
        double d_min = r - a.bottom_radius;
        double d_max = rho;
        double d = d_min + (d_max - d_min) * GetUnitRangeFromTextureCoord(1.0 - 2.0 * uvwz.z, SCATTERING_TEXTURE_MU_SIZE / 2);
        mu = d == 0.0 ? -1.0 : ClampCosine(-(rho * rho + d * d) / (2.0 * r * d));
        ray_r_mu_intersects_ground = true;
    } else {
        double d_min = a.top_radius - r;
        double d_max = rho + H;
        double d = d_min + (d_max - d_min) * GetUnitRangeFromTextureCoord(2.0 * uvwz.z - 1.0, SCATTERING_TEXTURE_MU_SIZE / 2);
        mu = d == 0.0 ? 1.0 : ClampCosine((H * H - rho * rho - d * d) / (2.0 * r * d));
        ray_r_mu_intersects_ground = false;
    }
    double x_mu_s = GetUnitRangeFromTextureCoord(uvwz.y, SCATTERING_TEXTURE_MU_S_SIZE);
    double d_min = a.top_radius - a.bottom_radius;
    double d_max = H;
    double D = DistanceToTopAtmosphereBoundary(a, a.bottom_radius, a.mu_s_min);
    double A = (D - d_min) / (d_max - d_min);
    double aa = (A - x_mu_s * A) / (1.0 + x_mu_s * A);
    double d = d_min + std::min(aa, A) * (d_max - d_min);
    mu_s = d == 0.0 ? 1.0 : ClampCosine((H * H - d * d) / (2.0 * a.bottom_radius * d));
    nu = ClampCosine(uvwz.x * 2.0 - 1.0);
}

inline void GetRMuMuSNuFromScatteringTextureFragCoord(const AtmosphereParameters& a, double fx, double fy, double fz, double& r, double& mu, double& mu_s,
                                                      double& nu, bool& ray_r_mu_intersects_ground) {
    double frag_coord_nu = std::floor(fx / SCATTERING_TEXTURE_MU_S_SIZE);
    double frag_coord_mu_s = std::fmod(fx, static_cast<double>(SCATTERING_TEXTURE_MU_S_SIZE));
    Vec4d uvwz{frag_coord_nu / (SCATTERING_TEXTURE_NU_SIZE - 1), frag_coord_mu_s / SCATTERING_TEXTURE_MU_S_SIZE, fy / SCATTERING_TEXTURE_MU_SIZE,
               fz / SCATTERING_TEXTURE_R_SIZE};
    GetRMuMuSNuFromScatteringTextureUvwz(a, uvwz, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
    nu = std::clamp(nu, mu * mu_s - std::sqrt((1.0 - mu * mu) * (1.0 - mu_s * mu_s)), mu * mu_s + std::sqrt((1.0 - mu * mu) * (1.0 - mu_s * mu_s)));
}

inline void ComputeSingleScatteringTexture(const AtmosphereParameters& a, const TransmittanceTexture& t, double fx, double fy, double fz, Spec& rayleigh,
                                           Spec& mie) {
    double r, mu, mu_s, nu;
    bool ground;
    GetRMuMuSNuFromScatteringTextureFragCoord(a, fx, fy, fz, r, mu, mu_s, nu, ground);
    ComputeSingleScattering(a, t, r, mu, mu_s, nu, ground, rayleigh, mie);
}

/** The two nu-slice lookups of a 4D (nu, mu_s, mu, r) scattering function stored in a 3D table (any type with sample(u, v, w)). */
template <typename Tex>
auto GetScattering(const AtmosphereParameters& a, const Tex& tex, double r, double mu, double mu_s, double nu, bool ray_r_mu_intersects_ground) {
    Vec4d uvwz = GetScatteringTextureUvwzFromRMuMuSNu(a, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
    double tex_coord_x = uvwz.x * (SCATTERING_TEXTURE_NU_SIZE - 1);
    double tex_x = std::floor(tex_coord_x);
    double lerp = tex_coord_x - tex_x;
    double u0 = (tex_x + uvwz.y) / SCATTERING_TEXTURE_NU_SIZE;
    double u1 = (tex_x + 1.0 + uvwz.y) / SCATTERING_TEXTURE_NU_SIZE;
    return tex.sample(u0, uvwz.z, uvwz.w) * (1.0 - lerp) + tex.sample(u1, uvwz.z, uvwz.w) * lerp;
}

inline Spec GetScattering(const AtmosphereParameters& a, const ReducedScatteringTexture& single_rayleigh, const ReducedScatteringTexture& single_mie,
                          const ScatteringTexture& multiple, double r, double mu, double mu_s, double nu, bool ray_r_mu_intersects_ground,
                          int scattering_order) {
    if (scattering_order == 1) {
        Spec rayleigh = GetScattering(a, single_rayleigh, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
        Spec mie = GetScattering(a, single_mie, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
        return rayleigh * RayleighPhaseFunction(nu) + mie * MiePhaseFunction(a.mie_phase_function_g, nu);
    }
    return GetScattering(a, multiple, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
}

inline Vec2d GetIrradianceTextureUvFromRMuS(const AtmosphereParameters& a, double r, double mu_s) {
    double x_r = (r - a.bottom_radius) / (a.top_radius - a.bottom_radius);
    double x_mu_s = mu_s * 0.5 + 0.5;
    return {GetTextureCoordFromUnitRange(x_mu_s, IRRADIANCE_TEXTURE_WIDTH), GetTextureCoordFromUnitRange(x_r, IRRADIANCE_TEXTURE_HEIGHT)};
}

inline void GetRMuSFromIrradianceTextureUv(const AtmosphereParameters& a, Vec2d uv, double& r, double& mu_s) {
    double x_mu_s = GetUnitRangeFromTextureCoord(uv.x, IRRADIANCE_TEXTURE_WIDTH);
    double x_r = GetUnitRangeFromTextureCoord(uv.y, IRRADIANCE_TEXTURE_HEIGHT);
    r = a.bottom_radius + x_r * (a.top_radius - a.bottom_radius);
    mu_s = ClampCosine(2.0 * x_mu_s - 1.0);
}

inline Spec GetIrradiance(const AtmosphereParameters& a, const IrradianceTexture& tex, double r, double mu_s) {
    Vec2d uv = GetIrradianceTextureUvFromRMuS(a, r, mu_s);
    return tex.sample(uv.x, uv.y);
}

inline Spec ComputeScatteringDensity(const AtmosphereParameters& a, const TransmittanceTexture& t, const ReducedScatteringTexture& single_rayleigh,
                                     const ReducedScatteringTexture& single_mie, const ScatteringTexture& multiple, const IrradianceTexture& irradiance,
                                     double r, double mu, double mu_s, double nu, int scattering_order) {
    Vec3d zenith_direction{0.0, 0.0, 1.0};
    Vec3d omega{std::sqrt(1.0 - mu * mu), 0.0, mu};
    double sun_dir_x = omega.x == 0.0 ? 0.0 : (nu - mu * mu_s) / omega.x;
    double sun_dir_y = std::sqrt(std::max(1.0 - sun_dir_x * sun_dir_x - mu_s * mu_s, 0.0));
    Vec3d omega_s{sun_dir_x, sun_dir_y, mu_s};
    const int SAMPLE_COUNT = 16;
    const double dphi = kPi / SAMPLE_COUNT;
    const double dtheta = kPi / SAMPLE_COUNT;
    Spec rayleigh_mie(0.0);
    double rayleigh_density = GetProfileDensity(a.rayleigh_density, r - a.bottom_radius);
    double mie_density = GetProfileDensity(a.mie_density, r - a.bottom_radius);
    for (int l = 0; l < SAMPLE_COUNT; ++l) {
        double theta = (l + 0.5) * dtheta;
        double cos_theta = std::cos(theta);
        double sin_theta = std::sin(theta);
        bool ray_r_theta_intersects_ground = RayIntersectsGround(a, r, cos_theta);
        double distance_to_ground = 0.0;
        Spec transmittance_to_ground(0.0);
        Spec ground_albedo(0.0);
        if (ray_r_theta_intersects_ground) {
            distance_to_ground = DistanceToBottomAtmosphereBoundary(a, r, cos_theta);
            transmittance_to_ground = GetTransmittance(a, t, r, cos_theta, distance_to_ground, true);
            ground_albedo = a.ground_albedo;
        }
        for (int m = 0; m < 2 * SAMPLE_COUNT; ++m) {
            double phi = (m + 0.5) * dphi;
            Vec3d omega_i{std::cos(phi) * sin_theta, std::sin(phi) * sin_theta, cos_theta};
            double domega_i = dtheta * dphi * std::sin(theta);
            double nu1 = dot(omega_s, omega_i);
            Spec incident_radiance = GetScattering(a, single_rayleigh, single_mie, multiple, r, omega_i.z, mu_s, nu1, ray_r_theta_intersects_ground,
                                                   scattering_order - 1);
            Vec3d ground_normal = normalize(zenith_direction * r + omega_i * distance_to_ground);
            Spec ground_irradiance = GetIrradiance(a, irradiance, a.bottom_radius, dot(ground_normal, omega_s));
            incident_radiance += transmittance_to_ground * ground_albedo * (1.0 / kPi) * ground_irradiance;
            double nu2 = dot(omega, omega_i);
            rayleigh_mie += incident_radiance *
                            (a.rayleigh_scattering * rayleigh_density * RayleighPhaseFunction(nu2) +
                             a.mie_scattering * mie_density * MiePhaseFunction(a.mie_phase_function_g, nu2)) *
                            domega_i;
        }
    }
    return rayleigh_mie;
}

inline Spec ComputeMultipleScattering(const AtmosphereParameters& a, const TransmittanceTexture& t, const ScatteringDensityTexture& density, double r,
                                      double mu, double mu_s, double nu, bool ray_r_mu_intersects_ground) {
    const int SAMPLE_COUNT = 50;
    double dx = DistanceToNearestAtmosphereBoundary(a, r, mu, ray_r_mu_intersects_ground) / SAMPLE_COUNT;
    Spec rayleigh_mie_sum(0.0);
    for (int i = 0; i <= SAMPLE_COUNT; ++i) {
        double d_i = i * dx;
        double r_i = ClampRadius(a, std::sqrt(d_i * d_i + 2.0 * r * mu * d_i + r * r));
        double mu_i = ClampCosine((r * mu + d_i) / r_i);
        double mu_s_i = ClampCosine((r * mu_s + d_i * nu) / r_i);
        Spec rayleigh_mie_i = GetScattering(a, density, r_i, mu_i, mu_s_i, nu, ray_r_mu_intersects_ground) *
                              GetTransmittance(a, t, r, mu, d_i, ray_r_mu_intersects_ground) * dx;
        double weight_i = (i == 0 || i == SAMPLE_COUNT) ? 0.5 : 1.0;
        rayleigh_mie_sum += rayleigh_mie_i * weight_i;
    }
    return rayleigh_mie_sum;
}

inline Spec ComputeScatteringDensityTexture(const AtmosphereParameters& a, const TransmittanceTexture& t, const ReducedScatteringTexture& single_rayleigh,
                                            const ReducedScatteringTexture& single_mie, const ScatteringTexture& multiple,
                                            const IrradianceTexture& irradiance, double fx, double fy, double fz, int scattering_order) {
    double r, mu, mu_s, nu;
    bool ground;
    GetRMuMuSNuFromScatteringTextureFragCoord(a, fx, fy, fz, r, mu, mu_s, nu, ground);
    return ComputeScatteringDensity(a, t, single_rayleigh, single_mie, multiple, irradiance, r, mu, mu_s, nu, scattering_order);
}

inline Spec ComputeMultipleScatteringTexture(const AtmosphereParameters& a, const TransmittanceTexture& t, const ScatteringDensityTexture& density,
                                             double fx, double fy, double fz, double& nu) {
    double r, mu, mu_s;
    bool ground;
    GetRMuMuSNuFromScatteringTextureFragCoord(a, fx, fy, fz, r, mu, mu_s, nu, ground);
    return ComputeMultipleScattering(a, t, density, r, mu, mu_s, nu, ground);
}

inline Spec ComputeDirectIrradiance(const AtmosphereParameters& a, const TransmittanceTexture& t, double r, double mu_s) {
    double alpha_s = a.sun_angular_radius;
    double average_cosine_factor = mu_s < -alpha_s ? 0.0 : (mu_s > alpha_s ? mu_s : (mu_s + alpha_s) * (mu_s + alpha_s) / (4.0 * alpha_s));
    return a.solar_irradiance * GetTransmittanceToTopAtmosphereBoundary(a, t, r, mu_s) * average_cosine_factor;
}

inline Spec ComputeIndirectIrradiance(const AtmosphereParameters& a, const ReducedScatteringTexture& single_rayleigh, const ReducedScatteringTexture& single_mie,
                                      const ScatteringTexture& multiple, double r, double mu_s, int scattering_order) {
    const int SAMPLE_COUNT = 32;
    const double dphi = kPi / SAMPLE_COUNT;
    const double dtheta = kPi / SAMPLE_COUNT;
    Spec result(0.0);
    Vec3d omega_s{std::sqrt(1.0 - mu_s * mu_s), 0.0, mu_s};
    for (int j = 0; j < SAMPLE_COUNT / 2; ++j) {
        double theta = (j + 0.5) * dtheta;
        for (int i = 0; i < 2 * SAMPLE_COUNT; ++i) {
            double phi = (i + 0.5) * dphi;
            Vec3d omega{std::cos(phi) * std::sin(theta), std::sin(phi) * std::sin(theta), std::cos(theta)};
            double domega = dtheta * dphi * std::sin(theta);
            double nu = dot(omega, omega_s);
            result += GetScattering(a, single_rayleigh, single_mie, multiple, r, omega.z, mu_s, nu, false, scattering_order) * omega.z * domega;
        }
    }
    return result;
}

inline Spec ComputeDirectIrradianceTexture(const AtmosphereParameters& a, const TransmittanceTexture& t, Vec2d frag_coord) {
    double r, mu_s;
    GetRMuSFromIrradianceTextureUv(a, {frag_coord.x / IRRADIANCE_TEXTURE_WIDTH, frag_coord.y / IRRADIANCE_TEXTURE_HEIGHT}, r, mu_s);
    return ComputeDirectIrradiance(a, t, r, mu_s);
}

inline Spec ComputeIndirectIrradianceTexture(const AtmosphereParameters& a, const ReducedScatteringTexture& single_rayleigh,
                                             const ReducedScatteringTexture& single_mie, const ScatteringTexture& multiple, Vec2d frag_coord,
                                             int scattering_order) {
    double r, mu_s;
    GetRMuSFromIrradianceTextureUv(a, {frag_coord.x / IRRADIANCE_TEXTURE_WIDTH, frag_coord.y / IRRADIANCE_TEXTURE_HEIGHT}, r, mu_s);
    return ComputeIndirectIrradiance(a, single_rayleigh, single_mie, multiple, r, mu_s, scattering_order);
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering from the tables (Bruneton's runtime functions, separate single Mie table).

struct PrecomputedTables {
    TransmittanceTexture transmittance;
    /** rgb: Rayleigh single plus every higher order, divided by the Rayleigh phase; a: single Mie, first channel. */
    Texture3D<Spec4> scattering;
    Texture3D<Spec> single_mie_scattering;
    /** Orders 2 and up alone (divided by the Rayleigh phase), as three-geospatial ships it. */
    Texture3D<Spec> higher_order_scattering;
    /** Sky irradiance alone (no direct sun), on a horizontal surface. */
    IrradianceTexture irradiance;
};

inline Spec GetCombinedScattering(const AtmosphereParameters& a, const PrecomputedTables& tables, double r, double mu, double mu_s, double nu,
                                  bool ray_r_mu_intersects_ground, Spec& single_mie_scattering) {
    Spec4 combined = GetScattering(a, tables.scattering, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
    single_mie_scattering = GetScattering(a, tables.single_mie_scattering, r, mu, mu_s, nu, ray_r_mu_intersects_ground);
    return combined.rgb();
}

/** Sky radiance seen from `camera` (relative to the planet centre, metres) along `view_ray`; transmittance to the top. */
inline Spec GetSkyRadiance(const AtmosphereParameters& a, const PrecomputedTables& tables, Vec3d camera, Vec3d view_ray, double shadow_length,
                           Vec3d sun_direction, Spec& transmittance) {
    double r = length(camera);
    double rmu = dot(camera, view_ray);
    double distance_to_top_atmosphere_boundary = -rmu - std::sqrt(rmu * rmu - r * r + a.top_radius * a.top_radius);
    if (distance_to_top_atmosphere_boundary > 0.0) {
        camera = camera + view_ray * distance_to_top_atmosphere_boundary;
        r = a.top_radius;
        rmu += distance_to_top_atmosphere_boundary;
    } else if (r > a.top_radius) {
        transmittance = Spec(1.0);
        return Spec(0.0);
    }
    double mu = rmu / r;
    double mu_s = dot(camera, sun_direction) / r;
    double nu = dot(view_ray, sun_direction);
    bool ground = RayIntersectsGround(a, r, mu);
    transmittance = ground ? Spec(0.0) : GetTransmittanceToTopAtmosphereBoundary(a, tables.transmittance, r, mu);
    Spec single_mie_scattering, scattering;
    if (shadow_length == 0.0) {
        scattering = GetCombinedScattering(a, tables, r, mu, mu_s, nu, ground, single_mie_scattering);
    } else {
        double d = shadow_length;
        double r_p = ClampRadius(a, std::sqrt(d * d + 2.0 * r * mu * d + r * r));
        double mu_p = (r * mu + d) / r_p;
        double mu_s_p = (r * mu_s + d * nu) / r_p;
        scattering = GetCombinedScattering(a, tables, r_p, mu_p, mu_s_p, nu, ground, single_mie_scattering);
        Spec shadow_transmittance = GetTransmittance(a, tables.transmittance, r, mu, shadow_length, ground);
        scattering = scattering * shadow_transmittance;
        single_mie_scattering = single_mie_scattering * shadow_transmittance;
    }
    return scattering * RayleighPhaseFunction(nu) + single_mie_scattering * MiePhaseFunction(a.mie_phase_function_g, nu);
}

/** Direct sun irradiance on a surface at `point` with `normal`; `sky_irradiance` is the sky's, both from the tables. */
inline Spec GetSunAndSkyIrradiance(const AtmosphereParameters& a, const PrecomputedTables& tables, Vec3d point, Vec3d normal, Vec3d sun_direction,
                                   Spec& sky_irradiance) {
    double r = length(point);
    double mu_s = dot(point, sun_direction) / r;
    sky_irradiance = GetIrradiance(a, tables.irradiance, r, mu_s) * ((1.0 + dot(normal, point) / r) * 0.5);
    return a.solar_irradiance * GetTransmittanceToSun(a, tables.transmittance, r, mu_s) * std::max(dot(normal, sun_direction), 0.0);
}

// ---------------------------------------------------------------------------------------------------------------------
// The spectral medium and the precompute (Bruneton's Algorithm 4.1, model.cc's batches of three wavelengths).

/** Bruneton's Interpolate: piecewise linear over the samples, held at the ends. */
inline double InterpolateSpectrum(const std::vector<double>& wavelengths, const std::vector<double>& values, double wavelength) {
    if (wavelengths.empty() || values.size() != wavelengths.size()) throw std::invalid_argument("spectrum: wavelengths and values differ in length");
    if (wavelength < wavelengths[0]) return values[0];
    for (size_t i = 0; i + 1 < wavelengths.size(); ++i) {
        if (wavelength < wavelengths[i + 1]) {
            double u = (wavelength - wavelengths[i]) / (wavelengths[i + 1] - wavelengths[i]);
            return values[i] * (1.0 - u) + values[i + 1] * u;
        }
    }
    return values.back();
}

/**
 * The atmosphere as spectra sampled at `wavelengths` (nm, increasing), interpolated to whatever wavelengths are
 * precomputed. Coefficients in 1/m at the profile's density 1; solar irradiance in any unit (the tables carry it).
 */
struct SpectralAtmosphere {
    std::vector<double> wavelengths;
    std::vector<double> solar_irradiance;
    std::vector<double> rayleigh_scattering;
    std::vector<double> mie_scattering;
    std::vector<double> mie_extinction;
    std::vector<double> absorption_extinction;
    std::vector<double> ground_albedo;
    double sun_angular_radius{0.004675};
    double bottom_radius{6360e3};
    double top_radius{6420e3};
    DensityProfile rayleigh_density;
    DensityProfile mie_density;
    DensityProfile absorption_density;
    double mie_phase_function_g{0.8};
    double mu_s_min{-0.5};

    void validate() const {
        size_t n = wavelengths.size();
        if (n == 0) throw std::invalid_argument("atmosphere: no wavelengths");
        for (size_t i = 1; i < n; ++i) if (!(wavelengths[i] > wavelengths[i - 1])) throw std::invalid_argument("atmosphere: wavelengths must increase");
        for (const auto* v : {&solar_irradiance, &rayleigh_scattering, &mie_scattering, &mie_extinction, &absorption_extinction, &ground_albedo}) {
            if (v->size() != n) throw std::invalid_argument("atmosphere: every spectrum needs one value per wavelength");
        }
        if (!(bottom_radius > 0) || !(top_radius > bottom_radius)) throw std::invalid_argument("atmosphere: need 0 < bottom_radius < top_radius");
        if (!(mu_s_min >= -1.0 && mu_s_min < 1.0)) throw std::invalid_argument("atmosphere: mu_s_min outside [-1, 1)");
        if (!(std::abs(mie_phase_function_g) < 1.0)) throw std::invalid_argument("atmosphere: |mie_phase_function_g| must be < 1");
        if (!(sun_angular_radius > 0 && sun_angular_radius < 0.1)) throw std::invalid_argument("atmosphere: sun_angular_radius outside (0, 0.1) rad");
    }

    /** The medium at three wavelengths. */
    AtmosphereParameters at(const double lambdas[3]) const {
        AtmosphereParameters p;
        auto spec = [&](const std::vector<double>& v) { return Spec(InterpolateSpectrum(wavelengths, v, lambdas[0]), InterpolateSpectrum(wavelengths, v, lambdas[1]), InterpolateSpectrum(wavelengths, v, lambdas[2])); };
        p.solar_irradiance = spec(solar_irradiance);
        p.sun_angular_radius = sun_angular_radius;
        p.bottom_radius = bottom_radius;
        p.top_radius = top_radius;
        p.rayleigh_density = rayleigh_density;
        p.rayleigh_scattering = spec(rayleigh_scattering);
        p.mie_density = mie_density;
        p.mie_scattering = spec(mie_scattering);
        p.mie_extinction = spec(mie_extinction);
        p.mie_phase_function_g = mie_phase_function_g;
        p.absorption_density = absorption_density;
        p.absorption_extinction = spec(absorption_extinction);
        p.ground_albedo = spec(ground_albedo);
        p.mu_s_min = mu_s_min;
        return p;
    }
};

/** Three precomputed wavelengths and the matrix taking their radiances to the output channels. */
struct WavelengthBatch {
    double lambdas[3]{680, 550, 440};
    Mat3 to_output;
};

struct PrecomputeOptions {
    std::vector<WavelengthBatch> batches;
    /** The transmittance table's three wavelengths (Bruneton's kLambdaR, G, B). */
    double transmittance_lambdas[3]{680, 550, 440};
    /** Scattering orders summed: 1 is single scattering only. */
    int scattering_orders{4};
    /** Worker threads (0: all cores). */
    int threads{0};
};

struct PrecomputeTimings {
    double transmittance_ms{0}, direct_irradiance_ms{0}, single_scattering_ms{0}, scattering_density_ms{0}, indirect_irradiance_ms{0},
        multiple_scattering_ms{0}, total_ms{0};
};

/** Runs job(0..n-1) over `threads` workers (Bruneton's RunJobs). */
inline void RunJobs(const std::function<void(int)>& job, int n, int threads) {
    int workers = threads > 0 ? threads : static_cast<int>(std::max(1u, std::thread::hardware_concurrency()));
    workers = std::min(workers, n);
    std::atomic<int> next{0};
    auto run = [&]() { for (int i = next++; i < n; i = next++) job(i); };
    std::vector<std::thread> pool;
    for (int w = 1; w < workers; ++w) pool.emplace_back(run);
    run();
    for (auto& t : pool) t.join();
}

class Model {
public:
    Model(SpectralAtmosphere atmosphere, PrecomputeOptions options) : atmosphere_(std::move(atmosphere)), options_(std::move(options)) {
        atmosphere_.validate();
        if (options_.batches.empty()) throw std::invalid_argument("precompute: no wavelength batches");
        if (options_.scattering_orders < 1) throw std::invalid_argument("precompute: scattering_orders must be at least 1");
    }

    const PrecomputedTables& tables() const { return tables_; }
    const PrecomputeTimings& timings() const { return timings_; }
    /** The medium at the transmittance wavelengths, which the runtime functions read alongside the tables. */
    AtmosphereParameters outputParameters() const { return atmosphere_.at(options_.transmittance_lambdas); }

    void precompute() {
        using clock = std::chrono::steady_clock;
        auto t0 = clock::now();
        tables_.transmittance = makeTransmittanceTexture();
        tables_.scattering = Texture3D<Spec4>(SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, SCATTERING_TEXTURE_DEPTH);
        tables_.single_mie_scattering = makeScatteringTexture();
        tables_.higher_order_scattering = makeScatteringTexture();
        tables_.irradiance = makeIrradianceTexture();
        for (const auto& batch : options_.batches) precomputeBatch(batch);
        // The batches leave the transmittance of their own wavelengths; the table keeps the output wavelengths'.
        auto t = clock::now();
        computeTransmittance(atmosphere_.at(options_.transmittance_lambdas), tables_.transmittance);
        timings_.transmittance_ms += ms(t);
        timings_.total_ms = ms(t0);
    }

private:
    template <typename T>
    static double ms(T start) { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count(); }

    void computeTransmittance(const AtmosphereParameters& a, TransmittanceTexture& out) const {
        RunJobs([&](int j) {
            for (int i = 0; i < TRANSMITTANCE_TEXTURE_WIDTH; ++i) out.at(i, j) = ComputeTransmittanceToTopAtmosphereBoundaryTexture(a, {i + 0.5, j + 0.5});
        }, TRANSMITTANCE_TEXTURE_HEIGHT, options_.threads);
    }

    void precomputeBatch(const WavelengthBatch& batch) {
        using clock = std::chrono::steady_clock;
        const AtmosphereParameters a = atmosphere_.at(batch.lambdas);
        const Mat3& M = batch.to_output;
        const int threads = options_.threads;
        TransmittanceTexture transmittance = makeTransmittanceTexture();
        IrradianceTexture delta_irradiance = makeIrradianceTexture();
        ReducedScatteringTexture delta_rayleigh = makeScatteringTexture();
        ReducedScatteringTexture delta_mie = makeScatteringTexture();
        ScatteringDensityTexture delta_density = makeScatteringTexture();
        ScatteringTexture delta_multiple = makeScatteringTexture();

        auto t = clock::now();
        computeTransmittance(a, transmittance);
        timings_.transmittance_ms += ms(t);

        // Direct irradiance goes to delta_irradiance only: the irradiance table holds the sky's light, not the sun's.
        t = clock::now();
        RunJobs([&](int j) {
            for (int i = 0; i < IRRADIANCE_TEXTURE_WIDTH; ++i) delta_irradiance.at(i, j) = ComputeDirectIrradianceTexture(a, transmittance, {i + 0.5, j + 0.5});
        }, IRRADIANCE_TEXTURE_HEIGHT, threads);
        timings_.direct_irradiance_ms += ms(t);

        t = clock::now();
        RunJobs([&](int k) {
            for (int j = 0; j < SCATTERING_TEXTURE_HEIGHT; ++j) {
                for (int i = 0; i < SCATTERING_TEXTURE_WIDTH; ++i) {
                    Spec rayleigh, mie;
                    ComputeSingleScatteringTexture(a, transmittance, i + 0.5, j + 0.5, k + 0.5, rayleigh, mie);
                    delta_rayleigh.at(i, j, k) = rayleigh;
                    delta_mie.at(i, j, k) = mie;
                    Spec4& s = tables_.scattering.at(i, j, k);
                    s = s + Spec4(M * rayleigh, (M * mie)[0]);
                    tables_.single_mie_scattering.at(i, j, k) += M * mie;
                }
            }
        }, SCATTERING_TEXTURE_DEPTH, threads);
        timings_.single_scattering_ms += ms(t);

        for (int order = 2; order <= options_.scattering_orders; ++order) {
            t = clock::now();
            RunJobs([&](int k) {
                for (int j = 0; j < SCATTERING_TEXTURE_HEIGHT; ++j) {
                    for (int i = 0; i < SCATTERING_TEXTURE_WIDTH; ++i) {
                        delta_density.at(i, j, k) = ComputeScatteringDensityTexture(a, transmittance, delta_rayleigh, delta_mie, delta_multiple, delta_irradiance,
                                                                                    i + 0.5, j + 0.5, k + 0.5, order);
                    }
                }
            }, SCATTERING_TEXTURE_DEPTH, threads);
            timings_.scattering_density_ms += ms(t);

            t = clock::now();
            RunJobs([&](int j) {
                for (int i = 0; i < IRRADIANCE_TEXTURE_WIDTH; ++i) {
                    Spec delta = ComputeIndirectIrradianceTexture(a, delta_rayleigh, delta_mie, delta_multiple, {i + 0.5, j + 0.5}, order - 1);
                    delta_irradiance.at(i, j) = delta;
                    tables_.irradiance.at(i, j) += M * delta;
                }
            }, IRRADIANCE_TEXTURE_HEIGHT, threads);
            timings_.indirect_irradiance_ms += ms(t);

            t = clock::now();
            RunJobs([&](int k) {
                for (int j = 0; j < SCATTERING_TEXTURE_HEIGHT; ++j) {
                    for (int i = 0; i < SCATTERING_TEXTURE_WIDTH; ++i) {
                        double nu;
                        Spec delta = ComputeMultipleScatteringTexture(a, transmittance, delta_density, i + 0.5, j + 0.5, k + 0.5, nu);
                        delta_multiple.at(i, j, k) = delta;
                        Spec reduced = M * delta * (1.0 / RayleighPhaseFunction(nu));
                        Spec4& s = tables_.scattering.at(i, j, k);
                        s = s + Spec4(reduced, 0.0);
                        tables_.higher_order_scattering.at(i, j, k) += reduced;
                    }
                }
            }, SCATTERING_TEXTURE_DEPTH, threads);
            timings_.multiple_scattering_ms += ms(t);
        }
    }

    SpectralAtmosphere atmosphere_;
    PrecomputeOptions options_;
    PrecomputedTables tables_;
    PrecomputeTimings timings_;
};

// ---------------------------------------------------------------------------------------------------------------------
// Storage: float32 or IEEE 754 binary16, RGBA per texel, rows of `width` texels, then rows, then slices (OpenGL order).

inline uint16_t floatToHalf(float value) {
    uint32_t f;
    std::memcpy(&f, &value, 4);
    uint32_t sign = (f >> 16) & 0x8000u;
    uint32_t exponent = (f >> 23) & 0xffu;
    uint32_t mantissa = f & 0x7fffffu;
    if (exponent == 0xffu) return static_cast<uint16_t>(sign | 0x7c00u | (mantissa ? 0x200u : 0u));
    int e = static_cast<int>(exponent) - 127 + 15;
    if (e >= 0x1f) return static_cast<uint16_t>(sign | 0x7c00u);
    if (e <= 0) {
        if (e < -10) return static_cast<uint16_t>(sign);
        mantissa |= 0x800000u;
        int shift = 14 - e;
        uint32_t half = mantissa >> shift;
        uint32_t rest = mantissa & ((1u << shift) - 1u);
        uint32_t halfway = 1u << (shift - 1);
        if (rest > halfway || (rest == halfway && (half & 1u))) ++half;
        return static_cast<uint16_t>(sign | half);
    }
    uint32_t half = sign | (static_cast<uint32_t>(e) << 10) | (mantissa >> 13);
    uint32_t rest = mantissa & 0x1fffu;
    if (rest > 0x1000u || (rest == 0x1000u && (half & 1u))) ++half;
    return static_cast<uint16_t>(half);
}

inline float halfToFloat(uint16_t h) {
    uint32_t sign = (h & 0x8000u) << 16;
    uint32_t exponent = (h >> 10) & 0x1fu;
    uint32_t mantissa = h & 0x3ffu;
    uint32_t f;
    if (exponent == 0) {
        if (mantissa == 0) {
            f = sign;
        } else {
            int e = -1;
            do { ++e; mantissa <<= 1; } while (!(mantissa & 0x400u));
            f = sign | (static_cast<uint32_t>(127 - 15 - e) << 23) | ((mantissa & 0x3ffu) << 13);
        }
    } else if (exponent == 0x1f) {
        f = sign | 0x7f800000u | (mantissa << 13);
    } else {
        f = sign | ((exponent + 127 - 15) << 23) | (mantissa << 13);
    }
    float out;
    std::memcpy(&out, &f, 4);
    return out;
}

/** RGBA texels: rgb from `rgb(i)`, alpha from `alpha(i)`. */
template <typename Rgb, typename Alpha>
std::vector<uint8_t> encodeRgba(size_t texels, bool half, Rgb rgb, Alpha alpha) {
    std::vector<uint8_t> out(texels * 4 * (half ? 2 : 4));
    for (size_t i = 0; i < texels; ++i) {
        Spec c = rgb(i);
        float v[4] = {static_cast<float>(c[0]), static_cast<float>(c[1]), static_cast<float>(c[2]), static_cast<float>(alpha(i))};
        for (int ch = 0; ch < 4; ++ch) {
            if (half) {
                uint16_t h = floatToHalf(v[ch]);
                std::memcpy(&out[(i * 4 + ch) * 2], &h, 2);
            } else {
                std::memcpy(&out[(i * 4 + ch) * 4], &v[ch], 4);
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tables by medium, cached: once per process, and on disk across processes and runs. The key is every input the
// precompute reads, so a changed medium is a new entry and an unchanged one is a lookup. The directory is
// SCRATCHBOX_ATMOSPHERE_CACHE, else $TMPDIR/scratchbox-atmosphere-cache. Entries are float32, written to a temporary
// name and renamed, so a reader never sees half a file; a file that does not hold its key is recomputed. A medium
// first wanted by several processes at once is precomputed by one of them (an flock beside the entry).

/** What the runtime functions read: the medium at the output wavelengths and the tables (no higher-order table). */
struct CachedAtmosphere {
    AtmosphereParameters parameters;
    PrecomputedTables tables;
    /** True when the tables came from the disk cache rather than a precompute in this process. */
    bool fromDisk{false};
    double precomputeMs{0};
};

/** The cache key: every value the precompute reads, at full precision (worker threads excluded). */
inline std::string atmosphereCacheKey(const SpectralAtmosphere& m, const PrecomputeOptions& o) {
    std::ostringstream k;
    k.precision(17);
    auto list = [&](const char* name, const std::vector<double>& v) { k << name; for (double x : v) k << ' ' << x; k << '\n'; };
    auto profile = [&](const char* name, const DensityProfile& p) {
        k << name;
        for (const auto& l : p.layers) k << ' ' << l.width << ' ' << l.exp_term << ' ' << l.exp_scale << ' ' << l.linear_term << ' ' << l.constant_term;
        k << '\n';
    };
    k << "scratchbox-atmosphere-lut 1 " << TRANSMITTANCE_TEXTURE_WIDTH << 'x' << TRANSMITTANCE_TEXTURE_HEIGHT << ' ' << SCATTERING_TEXTURE_NU_SIZE << 'x'
      << SCATTERING_TEXTURE_MU_S_SIZE << 'x' << SCATTERING_TEXTURE_MU_SIZE << 'x' << SCATTERING_TEXTURE_R_SIZE << ' ' << IRRADIANCE_TEXTURE_WIDTH << 'x'
      << IRRADIANCE_TEXTURE_HEIGHT << '\n';
    list("wavelengths", m.wavelengths);
    list("solar_irradiance", m.solar_irradiance);
    list("rayleigh_scattering", m.rayleigh_scattering);
    list("mie_scattering", m.mie_scattering);
    list("mie_extinction", m.mie_extinction);
    list("absorption_extinction", m.absorption_extinction);
    list("ground_albedo", m.ground_albedo);
    k << "scalars " << m.sun_angular_radius << ' ' << m.bottom_radius << ' ' << m.top_radius << ' ' << m.mie_phase_function_g << ' ' << m.mu_s_min << '\n';
    profile("rayleigh_density", m.rayleigh_density);
    profile("mie_density", m.mie_density);
    profile("absorption_density", m.absorption_density);
    k << "transmittance_lambdas " << o.transmittance_lambdas[0] << ' ' << o.transmittance_lambdas[1] << ' ' << o.transmittance_lambdas[2] << '\n';
    k << "scattering_orders " << o.scattering_orders << '\n';
    for (const auto& b : o.batches) {
        k << "batch " << b.lambdas[0] << ' ' << b.lambdas[1] << ' ' << b.lambdas[2];
        for (double x : b.to_output.m) k << ' ' << x;
        k << '\n';
    }
    return k.str();
}

inline uint64_t fnv1a64(const std::string& s) {
    uint64_t h = 1469598103934665603ull;
    for (unsigned char c : s) { h ^= c; h *= 1099511628211ull; }
    return h;
}

inline std::filesystem::path atmosphereCacheDir() {
    if (const char* dir = std::getenv("SCRATCHBOX_ATMOSPHERE_CACHE"); dir && *dir) return dir;
    const char* tmp = std::getenv("TMPDIR");
    return std::filesystem::path(tmp && *tmp ? tmp : "/tmp") / "scratchbox-atmosphere-cache";
}

namespace cache_detail {

constexpr char kMagic[8] = {'S', 'B', 'A', 'T', 'M', 'L', 'U', 'T'};

template <typename T, size_t N>
void put(std::vector<float>& out, const std::vector<T>& texels, const double* (*channels)(const T&)) {
    for (const T& t : texels) { const double* c = channels(t); for (size_t i = 0; i < N; ++i) out.push_back(static_cast<float>(c[i])); }
}

inline size_t floatCount() {
    const size_t t = static_cast<size_t>(TRANSMITTANCE_TEXTURE_WIDTH) * TRANSMITTANCE_TEXTURE_HEIGHT;
    const size_t s = static_cast<size_t>(SCATTERING_TEXTURE_WIDTH) * SCATTERING_TEXTURE_HEIGHT * SCATTERING_TEXTURE_DEPTH;
    const size_t e = static_cast<size_t>(IRRADIANCE_TEXTURE_WIDTH) * IRRADIANCE_TEXTURE_HEIGHT;
    return t * 3 + s * 4 + s * 3 + e * 3;
}

inline void write(const std::filesystem::path& file, const std::string& key, const PrecomputedTables& t) {
    std::vector<float> f;
    f.reserve(floatCount());
    auto rgb = [](const Spec& c) -> const double* { return c.v; };
    auto rgba = [](const Spec4& c) -> const double* { return c.v; };
    put<Spec, 3>(f, t.transmittance.data, rgb);
    put<Spec4, 4>(f, t.scattering.data, rgba);
    put<Spec, 3>(f, t.single_mie_scattering.data, rgb);
    put<Spec, 3>(f, t.irradiance.data, rgb);
    std::error_code ec;
    std::filesystem::create_directories(file.parent_path(), ec);
    std::filesystem::path partial = file;
    partial += ".partial." + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count());
    {
        std::ofstream out(partial, std::ios::binary);
        if (!out) return;  // an unwritable cache only costs the next process a precompute
        uint32_t keyLength = static_cast<uint32_t>(key.size());
        out.write(kMagic, sizeof kMagic);
        out.write(reinterpret_cast<const char*>(&keyLength), sizeof keyLength);
        out.write(key.data(), static_cast<std::streamsize>(key.size()));
        out.write(reinterpret_cast<const char*>(f.data()), static_cast<std::streamsize>(f.size() * sizeof(float)));
        if (!out) { out.close(); std::filesystem::remove(partial, ec); return; }
    }
    std::filesystem::rename(partial, file, ec);
    if (ec) std::filesystem::remove(partial, ec);
}

/** False when the file is missing, truncated or holds another key. */
inline bool read(const std::filesystem::path& file, const std::string& key, PrecomputedTables& t) {
    std::ifstream in(file, std::ios::binary);
    if (!in) return false;
    char magic[8];
    uint32_t keyLength = 0;
    if (!in.read(magic, sizeof magic) || std::memcmp(magic, kMagic, sizeof magic) != 0) return false;
    if (!in.read(reinterpret_cast<char*>(&keyLength), sizeof keyLength) || keyLength != key.size()) return false;
    std::string stored(keyLength, '\0');
    if (!in.read(stored.data(), keyLength) || stored != key) return false;
    std::vector<float> f(floatCount());
    if (!in.read(reinterpret_cast<char*>(f.data()), static_cast<std::streamsize>(f.size() * sizeof(float)))) return false;
    if (in.peek() != std::char_traits<char>::eof()) return false;
    size_t i = 0;
    t.transmittance = makeTransmittanceTexture();
    for (Spec& c : t.transmittance.data) { c = Spec(f[i], f[i + 1], f[i + 2]); i += 3; }
    t.scattering = Texture3D<Spec4>(SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, SCATTERING_TEXTURE_DEPTH);
    for (Spec4& c : t.scattering.data) { c = Spec4(Spec(f[i], f[i + 1], f[i + 2]), f[i + 3]); i += 4; }
    t.single_mie_scattering = makeScatteringTexture();
    for (Spec& c : t.single_mie_scattering.data) { c = Spec(f[i], f[i + 1], f[i + 2]); i += 3; }
    t.irradiance = makeIrradianceTexture();
    for (Spec& c : t.irradiance.data) { c = Spec(f[i], f[i + 1], f[i + 2]); i += 3; }
    return true;
}

} // namespace cache_detail

/** The tables of `m` under `o`: from this process's cache, else the disk cache, else precomputed (and stored in both). */
inline std::shared_ptr<const CachedAtmosphere> cachedAtmosphere(const SpectralAtmosphere& m, const PrecomputeOptions& o) {
    static std::mutex lock;
    static std::map<std::string, std::shared_ptr<const CachedAtmosphere>> memory;
    const std::string key = atmosphereCacheKey(m, o);
    std::lock_guard<std::mutex> guard(lock);
    if (auto it = memory.find(key); it != memory.end()) return it->second;

    Model model(m, o);
    auto entry = std::make_shared<CachedAtmosphere>();
    entry->parameters = model.outputParameters();
    char name[32];
    std::snprintf(name, sizeof name, "%016llx.bin", static_cast<unsigned long long>(fnv1a64(key)));
    const std::filesystem::path file = atmosphereCacheDir() / name;
    // Processes wanting the same medium take turns on a lock beside the entry: the first precomputes, the rest read.
    std::error_code ec;
    std::filesystem::create_directories(file.parent_path(), ec);
    std::filesystem::path lockPath = file;
    lockPath += ".lock";
    const int lockFd = ::open(lockPath.c_str(), O_CREAT | O_RDWR, 0644);
    if (lockFd >= 0) ::flock(lockFd, LOCK_EX);
    struct Unlock { int fd; ~Unlock() { if (fd >= 0) { ::flock(fd, LOCK_UN); ::close(fd); } } } unlock{lockFd};
    if (cache_detail::read(file, key, entry->tables)) {
        entry->fromDisk = true;
    } else {
        model.precompute();
        entry->tables = model.tables();
        entry->tables.higher_order_scattering = {};
        entry->precomputeMs = model.timings().total_ms;
        cache_detail::write(file, key, entry->tables);
    }
    memory.emplace(key, entry);
    return entry;
}

} // namespace atmosphere_lut
} // namespace scratchbox

#endif // SCRATCHBOX_ATMOSPHERE_LUT_HPP
