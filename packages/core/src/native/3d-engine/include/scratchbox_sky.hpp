/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SKY_HPP
#define SCRATCHBOX_SKY_HPP

#include "scratchbox_atmosphere_lut.hpp"
#include "scratchbox_math.hpp"
#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <vector>

namespace scratchbox {
namespace sky {

using math::Vec3;

/**
 * Physical atmosphere controls. Densities are multipliers on the sea-level reference profile,
 * so 1.0 is a clear standard atmosphere; raise dustDensity for haze or pollution.
 */
struct AtmosphereParams {
    float observerAltitudeMeters{0.0f};
    float airDensity{1.0f};
    float dustDensity{1.0f};
    float ozoneDensity{1.0f};
    float sunAngularDiameterDeg{0.545f};
    float sunIntensity{1.0f};
    /** Lambertian albedo of the ground under the atmosphere, which the higher scattering orders bounce off. */
    float groundAlbedo{0.1f};
};

namespace detail {

constexpr double kPi = 3.14159265358979323846;
constexpr double kLimbDarkening = 0.6;
// Sea-level coefficients (1/m) at 440, 550 and 680 nm (Hillaire 2020's Earth, Bruneton's three wavelengths).
constexpr double kRayleighScattering[3] = {33.1e-6, 13.558e-6, 5.802e-6};
constexpr double kMieScattering = 3.996e-6;
constexpr double kMieExtinction = 4.440e-6;
constexpr double kOzoneAbsorption[3] = {0.085e-6, 1.881e-6, 0.650e-6};

} // namespace detail

/**
 * Earth's atmosphere with the controls applied as continuous multipliers: Rayleigh 8 km and Mie 1.2 km scale heights,
 * an ozone tent 25 +- 15 km, Mie g 0.8, radii 6360 and 6420 km. The solar irradiance is 1 at every wavelength, so the
 * tables hold radiance per unit of top-of-atmosphere irradiance; PhysicalSky scales it by sunIntensity.
 */
inline atmosphere_lut::SpectralAtmosphere earthAtmosphere(const AtmosphereParams& p) {
    using namespace atmosphere_lut;
    SpectralAtmosphere m;
    m.wavelengths = {440, 550, 680};
    m.solar_irradiance = {1, 1, 1};
    for (int c = 0; c < 3; ++c) {
        m.rayleigh_scattering.push_back(detail::kRayleighScattering[c] * std::max(0.0f, p.airDensity));
        m.mie_scattering.push_back(detail::kMieScattering * std::max(0.0f, p.dustDensity));
        m.mie_extinction.push_back(detail::kMieExtinction * std::max(0.0f, p.dustDensity));
        m.absorption_extinction.push_back(detail::kOzoneAbsorption[c] * std::max(0.0f, p.ozoneDensity));
        m.ground_albedo.push_back(std::clamp(static_cast<double>(p.groundAlbedo), 0.0, 1.0));
    }
    m.sun_angular_radius = 0.5 * p.sunAngularDiameterDeg * detail::kPi / 180.0;
    m.bottom_radius = 6360e3;
    m.top_radius = 6420e3;
    m.rayleigh_density.layers[1] = {0, 1, -1.0 / 8000.0, 0, 0};
    m.mie_density.layers[1] = {0, 1, -1.0 / 1200.0, 0, 0};
    m.absorption_density.layers[0] = {25000, 0, 0, 1.0 / 15000.0, 1.0 - 25000.0 / 15000.0};
    m.absorption_density.layers[1] = {0, 0, 0, -1.0 / 15000.0, 1.0 + 25000.0 / 15000.0};
    m.mie_phase_function_g = 0.8;
    m.mu_s_min = -0.5;
    return m;
}

/**
 * Three wavelengths (680, 550, 440 nm as red, green, blue), four orders of scattering. SCRATCHBOX_SKY_SCATTERING_ORDERS
 * sets the orders (1-16): the test suite sets 1, a 0.2 s precompute instead of 25 s, outside SCRATCHBOX_HEAVY_TESTS.
 */
inline atmosphere_lut::PrecomputeOptions earthPrecompute() {
    atmosphere_lut::PrecomputeOptions o;
    o.batches.push_back(atmosphere_lut::WavelengthBatch{});
    o.scattering_orders = 4;
    if (const char* orders = std::getenv("SCRATCHBOX_SKY_SCATTERING_ORDERS"); orders && *orders) {
        o.scattering_orders = std::clamp(std::atoi(orders), 1, 16);
    }
    return o;
}

/**
 * Clear sky over a spherical planet with every order of scattering, read from Bruneton's precomputed tables
 * (scratchbox_atmosphere_lut.hpp; precomputed once per medium and cached). The view-dependent radiance is resampled
 * into an equirectangular table relative to the sun azimuth, which skyRadiance interpolates and the Metal tracer
 * uploads. Radiance is relative to a top-of-atmosphere solar irradiance of `sunIntensity` per channel.
 * World frame: +Y up, +X east, +Z south; the planet centre is straight below the observer.
 */
class PhysicalSky {
public:
    explicit PhysicalSky(const Vec3& sunDirection, const AtmosphereParams& params = {},
                         int azimuthResolution = 256, int elevationResolution = 128)
        : params_(params), azimuthRes_(std::max(azimuthResolution, 8)), elevationRes_(std::max(elevationResolution, 8)) {
        sunDir_ = sunDirection.normalized();
        if (sunDir_.lengthSquared() < 0.5f) sunDir_ = Vec3(0, 1, 0);
        float halfAngle = 0.5f * params_.sunAngularDiameterDeg * math::DEG_TO_RAD;
        sunCosHalfAngle_ = std::cos(halfAngle);
        sunSolidAngle_ = static_cast<float>(2.0 * detail::kPi * (1.0 - static_cast<double>(sunCosHalfAngle_)));
        buildSunBasis();

        atmosphere_ = atmosphere_lut::cachedAtmosphere(earthAtmosphere(params_), earthPrecompute());
        const atmosphere_lut::AtmosphereParameters& a = atmosphere_->parameters;
        const double h = std::max(0.0f, params_.observerAltitudeMeters);
        camera_ = {0.0, a.bottom_radius + h, 0.0};
        const double r = camera_.y;
        const double muS = std::clamp(static_cast<double>(sunDir_.y), -1.0, 1.0);
        const atmosphere_lut::Spec t = atmosphere_lut::GetTransmittanceToSun(a, atmosphere_->tables.transmittance, std::min(r, a.top_radius), muS);
        sunTransmittance_ = toVec3(t);
        skyIrradiance_ = toVec3(atmosphere_lut::GetIrradiance(a, atmosphere_->tables.irradiance, std::min(r, a.top_radius), muS)) * params_.sunIntensity;

        const double rayleigh = atmosphere_lut::GetProfileDensity(a.rayleigh_density, h);
        const double mie = atmosphere_lut::GetProfileDensity(a.mie_density, h);
        const double ozone = atmosphere_lut::GetProfileDensity(a.absorption_density, h);
        for (int c = 0; c < 3; ++c) {
            haze_[c] = static_cast<float>(a.rayleigh_scattering[c] * rayleigh + a.mie_extinction[c] * mie + a.absorption_extinction[c] * ozone);
        }

        buildLut();
    }

    /** Sky radiance excluding the solar disc (bilinear lookup). */
    Vec3 skyRadiance(const Vec3& direction) const {
        Vec3 d = direction.normalized();
        float elevation = std::asin(std::clamp(d.y, -1.0f, 1.0f));
        float rowF = std::sqrt(std::max(elevation, 0.0f) / static_cast<float>(detail::kPi * 0.5)) * elevationRes_ - 0.5f;
        float colF = relativeAzimuth(d) / static_cast<float>(detail::kPi) * azimuthRes_ - 0.5f;
        rowF = std::clamp(rowF, 0.0f, static_cast<float>(elevationRes_ - 1));
        colF = std::clamp(colF, 0.0f, static_cast<float>(azimuthRes_ - 1));
        int r0 = static_cast<int>(rowF), c0 = static_cast<int>(colF);
        int r1 = std::min(r0 + 1, elevationRes_ - 1), c1 = std::min(c0 + 1, azimuthRes_ - 1);
        float fr = rowF - r0, fc = colF - c0;
        auto at = [&](int r, int c) { return lut_[static_cast<size_t>(r) * azimuthRes_ + c]; };
        Vec3 top = at(r0, c0) * (1.0f - fc) + at(r0, c1) * fc;
        Vec3 bottom = at(r1, c0) * (1.0f - fc) + at(r1, c1) * fc;
        return top * (1.0f - fr) + bottom * fr;
    }

    /** Sky radiance read from the 4D tables directly, without the equirectangular resampling. */
    Vec3 skyRadianceDirect(const Vec3& direction) const {
        Vec3 d = direction.normalized();
        d.y = std::max(d.y, 0.0f);
        return tableRadiance(d.normalized());
    }

    /** Limb-darkened solar disc radiance; zero outside the disc. */
    Vec3 sunDiscRadiance(const Vec3& direction) const {
        Vec3 d = direction.normalized();
        float cosTheta = d.dot(sunDir_);
        if (cosTheta < sunCosHalfAngle_) return Vec3(0, 0, 0);
        float halfAngle = std::acos(sunCosHalfAngle_);
        float theta = std::acos(std::min(cosTheta, 1.0f));
        float r = halfAngle > 0.0f ? std::min(theta / halfAngle, 1.0f) : 0.0f;
        float mu = std::sqrt(std::max(0.0f, 1.0f - r * r));
        const float u = static_cast<float>(detail::kLimbDarkening);
        float profile = (1.0f - u * (1.0f - mu)) / (1.0f - u / 3.0f);
        return sunIrradiance() * (profile / sunSolidAngle_);
    }

    /** Uniformly samples a direction inside the solar cone (pdf = 1 / sunSolidAngle()). */
    Vec3 sampleSunDirection(float u1, float u2) const {
        float cosTheta = 1.0f - u1 * (1.0f - sunCosHalfAngle_);
        float sinTheta = std::sqrt(std::max(0.0f, 1.0f - cosTheta * cosTheta));
        float phi = static_cast<float>(2.0 * detail::kPi) * u2;
        return (sunDir_ * cosTheta + (sunTangent_ * std::cos(phi) + sunBitangent_ * std::sin(phi)) * sinTheta).normalized();
    }

    /** Direct solar irradiance at the observer on a surface facing the sun. */
    Vec3 sunIrradiance() const { return sunTransmittance_ * params_.sunIntensity; }
    /** Transmittance to the sun, with the share of the disc above the horizon (Bruneton's GetTransmittanceToSun). */
    Vec3 sunTransmittance() const { return sunTransmittance_; }
    /** Sky radiance at the horizon with the same azimuth as `direction`: the color distant haze converges to. */
    Vec3 horizonRadiance(const Vec3& direction) const {
        Vec3 flat(direction.x, 0.0f, direction.z);
        if (flat.lengthSquared() < 1e-8f) flat = Vec3(1, 0, 0);
        return skyRadiance(flat.normalized());
    }
    /** Extinction coefficient (1/m) of the air at the observer altitude. */
    Vec3 hazeExtinction() const { return Vec3(haze_[0], haze_[1], haze_[2]); }
    /** Irradiance on an upward-facing surface from the sky dome alone (solar disc excluded), from the irradiance table. */
    Vec3 skyIrradianceHorizontal() const { return skyIrradiance_; }

    const Vec3& sunDirection() const { return sunDir_; }
    float sunCosHalfAngle() const { return sunCosHalfAngle_; }
    float sunSolidAngle() const { return sunSolidAngle_; }
    const AtmosphereParams& params() const { return params_; }
    /** Basis sampleSunDirection spans the solar cone with. */
    const Vec3& sunTangent() const { return sunTangent_; }
    const Vec3& sunBitangent() const { return sunBitangent_; }
    /** The table skyRadiance interpolates: elevationResolution() rows of azimuthResolution() entries. */
    const std::vector<Vec3>& skyLut() const { return lut_; }
    int azimuthResolution() const { return azimuthRes_; }
    int elevationResolution() const { return elevationRes_; }
    /** The medium and precomputed tables this sky reads. */
    const atmosphere_lut::CachedAtmosphere& atmosphere() const { return *atmosphere_; }

private:
    static Vec3 toVec3(const atmosphere_lut::Spec& s) {
        return Vec3(static_cast<float>(s[0]), static_cast<float>(s[1]), static_cast<float>(s[2]));
    }

    void buildSunBasis() {
        Vec3 helper = std::abs(sunDir_.y) < 0.9f ? Vec3(0, 1, 0) : Vec3(1, 0, 0);
        sunTangent_ = helper.cross(sunDir_).normalized();
        sunBitangent_ = sunDir_.cross(sunTangent_);
    }

    Vec3 tableRadiance(const Vec3& d) const {
        atmosphere_lut::Spec transmittance;
        atmosphere_lut::Spec radiance = atmosphere_lut::GetSkyRadiance(atmosphere_->parameters, atmosphere_->tables, camera_, {d.x, d.y, d.z}, 0.0,
                                                                       {sunDir_.x, sunDir_.y, sunDir_.z}, transmittance);
        return toVec3(radiance) * params_.sunIntensity;
    }

    float relativeAzimuth(const Vec3& d) const {
        Vec3 sunFlat(sunDir_.x, 0.0f, sunDir_.z);
        Vec3 dirFlat(d.x, 0.0f, d.z);
        if (sunFlat.lengthSquared() < 1e-10f || dirFlat.lengthSquared() < 1e-10f) return 0.0f;
        float c = std::clamp(sunFlat.normalized().dot(dirFlat.normalized()), -1.0f, 1.0f);
        return std::acos(c);
    }

    Vec3 lutDirection(int row, int col) const {
        double elevation = detail::kPi * 0.5 * std::pow((row + 0.5) / elevationRes_, 2.0);
        double relAz = detail::kPi * (col + 0.5) / azimuthRes_;
        Vec3 sunFlat(sunDir_.x, 0.0f, sunDir_.z);
        if (sunFlat.lengthSquared() < 1e-10f) sunFlat = Vec3(0, 0, -1);
        sunFlat = sunFlat.normalized();
        Vec3 side = Vec3(0, 1, 0).cross(sunFlat).normalized();
        Vec3 flat = sunFlat * static_cast<float>(std::cos(relAz)) + side * static_cast<float>(std::sin(relAz));
        return (flat * static_cast<float>(std::cos(elevation)) + Vec3(0, static_cast<float>(std::sin(elevation)), 0)).normalized();
    }

    void buildLut() {
        lut_.assign(static_cast<size_t>(azimuthRes_) * elevationRes_, Vec3(0, 0, 0));
        atmosphere_lut::RunJobs([this](int row) {
            for (int col = 0; col < azimuthRes_; ++col) lut_[static_cast<size_t>(row) * azimuthRes_ + col] = tableRadiance(lutDirection(row, col));
        }, elevationRes_, 0);
    }

    AtmosphereParams params_;
    int azimuthRes_;
    int elevationRes_;
    Vec3 sunDir_{0, 1, 0};
    Vec3 sunTangent_{1, 0, 0};
    Vec3 sunBitangent_{0, 0, 1};
    float sunCosHalfAngle_{1.0f};
    float sunSolidAngle_{0.0f};
    std::shared_ptr<const atmosphere_lut::CachedAtmosphere> atmosphere_;
    atmosphere_lut::Vec3d camera_;
    Vec3 sunTransmittance_{1, 1, 1};
    float haze_[3] = {0, 0, 0};
    Vec3 skyIrradiance_{0, 0, 0};
    std::vector<Vec3> lut_;
};

} // namespace sky
} // namespace scratchbox

#endif // SCRATCHBOX_SKY_HPP
