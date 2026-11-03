/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/*
 * The cases of Eric Bruneton's atmosphere/reference/functions_test.cc, ported to scratchbox_atmosphere_lut.hpp:
 * the same synthetic atmosphere (a 1000 km planet under a 500 km atmosphere), the same calls and the same expected
 * values and tolerances. Each check prints one JSON record; atmosphere-lut.test.ts asserts every one.
 *
 * Copyright (c) 2017 Eric Bruneton. All rights reserved. Redistribution and use in source and binary forms, with or
 * without modification, are permitted under the BSD 3-clause licence reproduced in scratchbox_atmosphere_lut.hpp.
 */

#include "scratchbox_atmosphere_lut.hpp"

#include <cstdio>
#include <string>
#include <vector>

using namespace scratchbox::atmosphere_lut;

namespace {

constexpr double km = 1000.0;
constexpr double kEpsilon = 1e-3;
constexpr double kSolarIrradiance = 123.0;
constexpr double kBottomRadius = 1000.0 * km;
constexpr double kTopRadius = 1500.0 * km;
constexpr double kRayleighScaleHeight = 60.0 * km;
constexpr double kMieScaleHeight = 30.0 * km;
constexpr double kRayleighScattering = 0.001 / km;
constexpr double kMieScattering = 0.0015 / km;
constexpr double kMieExtinction = 0.002 / km;
constexpr double kGroundAlbedo = 0.1;

std::string current;
bool firstRecord = true;

void record(const char* check, double expected, double actual, double tolerance, bool pass) {
    std::printf("%s{\"test\":\"%s\",\"check\":\"%s\",\"expected\":%.12g,\"actual\":%.12g,\"tolerance\":%.6g,\"pass\":%s}", firstRecord ? "" : ",\n",
                current.c_str(), check, expected, actual, tolerance, pass ? "true" : "false");
    firstRecord = false;
}
void ExpectNear(double expected, double actual, double tolerance) { record("near", expected, actual, tolerance, std::abs(expected - actual) <= tolerance); }
void ExpectNotNear(double expected, double actual, double tolerance) { record("notNear", expected, actual, tolerance, std::abs(expected - actual) > tolerance); }
void ExpectEquals(double expected, double actual) { record("equals", expected, actual, 0, expected == actual); }
void ExpectTrue(bool v) { record("true", 1, v ? 1 : 0, 0, v); }
void ExpectFalse(bool v) { record("false", 0, v ? 1 : 0, 0, !v); }

double CosineOfHorizonZenithAngle(double r) { return -std::sqrt(1.0 - (kBottomRadius / r) * (kBottomRadius / r)); }

/** A 3D table whose texels are computed on first use (Bruneton's Lazy*Texture). */
template <typename Compute>
struct LazyTexture3D {
    Compute compute;
    mutable std::vector<Spec> value;
    mutable std::vector<char> done;
    explicit LazyTexture3D(Compute c)
        : compute(c), value(static_cast<size_t>(SCATTERING_TEXTURE_WIDTH) * SCATTERING_TEXTURE_HEIGHT * SCATTERING_TEXTURE_DEPTH),
          done(value.size(), 0) {}
    const Spec& get(int i, int j, int k) const {
        size_t index = i + SCATTERING_TEXTURE_WIDTH * (j + static_cast<size_t>(SCATTERING_TEXTURE_HEIGHT) * k);
        if (!done[index]) { value[index] = compute(i, j, k); done[index] = 1; }
        return value[index];
    }
    Spec sample(double u, double v, double w) const {
        return sampleTrilinear(SCATTERING_TEXTURE_WIDTH, SCATTERING_TEXTURE_HEIGHT, SCATTERING_TEXTURE_DEPTH, u, v, w,
                               [this](int i, int j, int k) -> const Spec& { return get(i, j, k); });
    }
};
template <typename Compute>
LazyTexture3D<Compute> lazy(Compute c) { return LazyTexture3D<Compute>(c); }

TransmittanceTexture computeTransmittance(const AtmosphereParameters& a) {
    TransmittanceTexture t = makeTransmittanceTexture();
    RunJobs([&](int j) {
        for (int i = 0; i < TRANSMITTANCE_TEXTURE_WIDTH; ++i) t.at(i, j) = ComputeTransmittanceToTopAtmosphereBoundaryTexture(a, {i + 0.5, j + 0.5});
    }, TRANSMITTANCE_TEXTURE_HEIGHT, 0);
    return t;
}

AtmosphereParameters base() {
    AtmosphereParameters a;
    a.solar_irradiance = Spec(kSolarIrradiance, 0, 0);
    a.bottom_radius = kBottomRadius;
    a.top_radius = kTopRadius;
    a.rayleigh_density.layers[1] = {0.0, 1.0, -1.0 / kRayleighScaleHeight, 0.0, 0.0};
    a.rayleigh_scattering = Spec(kRayleighScattering, 0, 0);
    a.mie_density.layers[1] = {0.0, 1.0, -1.0 / kMieScaleHeight, 0.0, 0.0};
    a.mie_scattering = Spec(kMieScattering, 0, 0);
    a.mie_extinction = Spec(kMieExtinction, 0, 0);
    a.ground_albedo = Spec(kGroundAlbedo, 0, 0);
    a.mu_s_min = -1.0;
    return a;
}
void SetUniformAtmosphere(AtmosphereParameters& a) {
    a.rayleigh_density.layers[0] = DensityProfileLayer();
    a.rayleigh_density.layers[1] = {0.0, 0.0, 0.0, 0.0, 1.0};
    a.mie_density.layers[0] = DensityProfileLayer();
    a.mie_density.layers[1] = {0.0, 0.0, 0.0, 0.0, 1.0};
    a.absorption_density.layers[0] = DensityProfileLayer();
    a.absorption_density.layers[1] = DensityProfileLayer();
}
void RemoveAerosols(AtmosphereParameters& a) {
    a.mie_scattering[0] = 0.0;
    a.mie_extinction[0] = 0.0;
}

void TestDistanceToTopAtmosphereBoundary(AtmosphereParameters a) {
    constexpr double r = kBottomRadius * 0.2 + kTopRadius * 0.8;
    ExpectNear(kTopRadius - r, DistanceToTopAtmosphereBoundary(a, r, 1.0), 1.0);
    ExpectNear(std::sqrt(kTopRadius * kTopRadius - r * r), DistanceToTopAtmosphereBoundary(a, r, 0.0), 1.0);
}

void TestRayIntersectsGround(AtmosphereParameters a) {
    constexpr double r = kBottomRadius * 0.9 + kTopRadius * 0.1;
    double mu_horizon = CosineOfHorizonZenithAngle(r);
    ExpectFalse(RayIntersectsGround(a, r, 1.0));
    ExpectFalse(RayIntersectsGround(a, r, mu_horizon + kEpsilon));
    ExpectTrue(RayIntersectsGround(a, r, mu_horizon - kEpsilon));
    ExpectTrue(RayIntersectsGround(a, r, -1.0));
}

void TestComputeOpticalLengthToTopAtmosphereBoundary(AtmosphereParameters a) {
    constexpr double r = kBottomRadius * 0.2 + kTopRadius * 0.8;
    constexpr double h_r = r - kBottomRadius;
    constexpr double h_top = kTopRadius - kBottomRadius;
    ExpectNear(kRayleighScaleHeight * (std::exp(-h_r / kRayleighScaleHeight) - std::exp(-h_top / kRayleighScaleHeight)),
               ComputeOpticalLengthToTopAtmosphereBoundary(a, a.rayleigh_density, r, 1.0), 1.0);
    SetUniformAtmosphere(a);
    ExpectNear(std::sqrt(kTopRadius * kTopRadius - r * r), ComputeOpticalLengthToTopAtmosphereBoundary(a, a.rayleigh_density, r, 0.0), 1.0);
}

void TestGetProfileDensity(AtmosphereParameters) {
    DensityProfile profile;
    profile.layers[1] = {0.0, 1.0, -1.0 / km, 0.0, 0.0};
    ExpectEquals(std::exp(-2.0), GetProfileDensity(profile, 2.0 * km));
    profile.layers[1] = {0.0, 0.0, 0.0, -0.5 / km, 1.0};
    ExpectEquals(1.0, GetProfileDensity(profile, 0.0 * km));
    ExpectEquals(0.5, GetProfileDensity(profile, 1.0 * km));
    ExpectEquals(0.0, GetProfileDensity(profile, 3.0 * km));
    profile.layers[0] = {25.0 * km, 0.0, 0.0, 1.0 / (15.0 * km), -2.0 / 3.0};
    profile.layers[1] = {0.0 * km, 0.0, 0.0, -1.0 / (15.0 * km), 8.0 / 3.0};
    ExpectEquals(0.0, GetProfileDensity(profile, 0.0 * km));
    ExpectNear(0.0, GetProfileDensity(profile, 10.0 * km), kEpsilon);
    ExpectNear(1.0, GetProfileDensity(profile, 25.0 * km), kEpsilon);
    ExpectNear(0.0, GetProfileDensity(profile, 40.0 * km), kEpsilon);
    ExpectEquals(0.0, GetProfileDensity(profile, 50.0 * km));
}

void TestComputeTransmittanceToTopAtmosphereBoundary(AtmosphereParameters a) {
    constexpr double r = kBottomRadius * 0.2 + kTopRadius * 0.8;
    constexpr double h_r = r - kBottomRadius;
    constexpr double h_top = kTopRadius - kBottomRadius;
    double rayleigh_optical_depth = kRayleighScattering * kRayleighScaleHeight * (std::exp(-h_r / kRayleighScaleHeight) - std::exp(-h_top / kRayleighScaleHeight));
    double mie_optical_depth = kMieExtinction * kMieScaleHeight * (std::exp(-h_r / kMieScaleHeight) - std::exp(-h_top / kMieScaleHeight));
    ExpectNear(std::exp(-(rayleigh_optical_depth + mie_optical_depth)), ComputeTransmittanceToTopAtmosphereBoundary(a, r, 1.0)[0], kEpsilon);
    a.rayleigh_density.layers[1] = DensityProfileLayer();
    a.mie_density.layers[1] = DensityProfileLayer();
    a.absorption_density.layers[0] = {25.0 * km, 0.0, 0.0, 1.0 / (15.0 * km), -2.0 / 3.0};
    a.absorption_density.layers[1] = {0.0 * km, 0.0, 0.0, -1.0 / (15.0 * km), 8.0 / 3.0};
    a.absorption_extinction[0] = 0.02 / km;
    ExpectNear(std::exp(-0.02 * 15.0), ComputeTransmittanceToTopAtmosphereBoundary(a, kBottomRadius, 1.0)[0], kEpsilon);
    SetUniformAtmosphere(a);
    RemoveAerosols(a);
    ExpectNear(std::exp(-kRayleighScattering * std::sqrt(kTopRadius * kTopRadius - r * r)), ComputeTransmittanceToTopAtmosphereBoundary(a, r, 0.0)[0], kEpsilon);
}

void TestGetTextureCoordFromUnitRange(AtmosphereParameters) {
    ExpectNear(0.5 / 10.0, GetTextureCoordFromUnitRange(0.0, 10), kEpsilon);
    ExpectNear(9.5 / 10.0, GetTextureCoordFromUnitRange(1.0, 10), kEpsilon);
    ExpectNear(0.0, GetUnitRangeFromTextureCoord(0.5 / 10.0, 10), kEpsilon);
    ExpectNear(1.0, GetUnitRangeFromTextureCoord(9.5 / 10.0, 10), kEpsilon);
    ExpectNear(1.0 / 3.0, GetUnitRangeFromTextureCoord(GetTextureCoordFromUnitRange(1.0 / 3.0, 10), 10), kEpsilon);
}

void TestGetTransmittanceTextureUvFromRMu(AtmosphereParameters a) {
    Vec2d uv = GetTransmittanceTextureUvFromRMu(a, kTopRadius, 1.0);
    ExpectNear(0.5 / TRANSMITTANCE_TEXTURE_WIDTH, uv.x, kEpsilon);
    ExpectNear(1.0 - 0.5 / TRANSMITTANCE_TEXTURE_HEIGHT, uv.y, kEpsilon);
    double top_mu_horizon = CosineOfHorizonZenithAngle(kTopRadius);
    uv = GetTransmittanceTextureUvFromRMu(a, kTopRadius, top_mu_horizon);
    ExpectNear(1.0 - 0.5 / TRANSMITTANCE_TEXTURE_WIDTH, uv.x, kEpsilon);
    ExpectNear(1.0 - 0.5 / TRANSMITTANCE_TEXTURE_HEIGHT, uv.y, kEpsilon);
    uv = GetTransmittanceTextureUvFromRMu(a, kBottomRadius, 1.0);
    ExpectNear(0.5 / TRANSMITTANCE_TEXTURE_WIDTH, uv.x, kEpsilon);
    ExpectNear(0.5 / TRANSMITTANCE_TEXTURE_HEIGHT, uv.y, kEpsilon);
    uv = GetTransmittanceTextureUvFromRMu(a, kBottomRadius, 0.0);
    ExpectNear(1.0 - 0.5 / TRANSMITTANCE_TEXTURE_WIDTH, uv.x, kEpsilon);
    ExpectNear(0.5 / TRANSMITTANCE_TEXTURE_HEIGHT, uv.y, kEpsilon);
}

void TestGetRMuFromTransmittanceTextureUv(AtmosphereParameters a) {
    double r, mu;
    GetRMuFromTransmittanceTextureUv(a, {0.5 / TRANSMITTANCE_TEXTURE_WIDTH, 1.0 - 0.5 / TRANSMITTANCE_TEXTURE_HEIGHT}, r, mu);
    ExpectNear(kTopRadius, r, 1.0);
    ExpectNear(1.0, mu, kEpsilon);
    GetRMuFromTransmittanceTextureUv(a, {1.0 - 0.5 / TRANSMITTANCE_TEXTURE_WIDTH, 1.0 - 0.5 / TRANSMITTANCE_TEXTURE_HEIGHT}, r, mu);
    ExpectNear(kTopRadius, r, 1.0);
    ExpectNear(CosineOfHorizonZenithAngle(kTopRadius), mu, kEpsilon);
    GetRMuFromTransmittanceTextureUv(a, {0.5 / TRANSMITTANCE_TEXTURE_WIDTH, 0.5 / TRANSMITTANCE_TEXTURE_HEIGHT}, r, mu);
    ExpectNear(kBottomRadius, r, 1.0);
    ExpectNear(1.0, mu, kEpsilon);
    GetRMuFromTransmittanceTextureUv(a, {1.0 - 0.5 / TRANSMITTANCE_TEXTURE_WIDTH, 0.5 / TRANSMITTANCE_TEXTURE_HEIGHT}, r, mu);
    ExpectNear(kBottomRadius, r, 1.0);
    ExpectNear(0.0, mu, kEpsilon);
    GetRMuFromTransmittanceTextureUv(a, GetTransmittanceTextureUvFromRMu(a, kBottomRadius * 0.2 + kTopRadius * 0.8, 0.25), r, mu);
    ExpectNear(kBottomRadius * 0.2 + kTopRadius * 0.8, r, 1.0);
    ExpectNear(0.25, mu, kEpsilon);
}

void TestGetTransmittanceToTopAtmosphereBoundary(AtmosphereParameters a) {
    TransmittanceTexture t = computeTransmittance(a);
    const double r = kBottomRadius * 0.2 + kTopRadius * 0.8;
    const double mu = 0.4;
    ExpectNear(ComputeTransmittanceToTopAtmosphereBoundary(a, r, mu)[0], GetTransmittanceToTopAtmosphereBoundary(a, t, r, mu)[0], kEpsilon);
}

void TestComputeAndGetTransmittance(AtmosphereParameters a) {
    SetUniformAtmosphere(a);
    RemoveAerosols(a);
    TransmittanceTexture t = computeTransmittance(a);
    const double r = kBottomRadius * 0.2 + kTopRadius * 0.8;
    const double d = (kTopRadius - kBottomRadius) * 0.1;
    ExpectNear(std::exp(-kRayleighScattering * d), GetTransmittance(a, t, kBottomRadius, 0.0, d, false)[0], kEpsilon);
    ExpectNear(std::exp(-kRayleighScattering * d), GetTransmittance(a, t, r, 0.7, d, false)[0], kEpsilon);
    ExpectNear(std::exp(-kRayleighScattering * d), GetTransmittance(a, t, r, -0.7, d, RayIntersectsGround(a, r, -0.7))[0], kEpsilon);
}

void TestComputeSingleScatteringIntegrand(AtmosphereParameters a) {
    TransmittanceTexture t = computeTransmittance(a);
    const double h_top = kTopRadius - kBottomRadius;
    const double h = h_top / 2.0;
    Spec rayleigh, mie;
    ComputeSingleScatteringIntegrand(a, t, kBottomRadius, 1.0, 1.0, 1.0, h, false, rayleigh, mie);
    double rayleigh_optical_depth = kRayleighScattering * kRayleighScaleHeight * (1.0 - std::exp(-h_top / kRayleighScaleHeight));
    double mie_optical_depth = kMieExtinction * kMieScaleHeight * (1.0 - std::exp(-h_top / kMieScaleHeight));
    ExpectNear(std::exp(-rayleigh_optical_depth - mie_optical_depth) * std::exp(-h / kRayleighScaleHeight), rayleigh[0], kEpsilon);
    ExpectNear(std::exp(-rayleigh_optical_depth - mie_optical_depth) * std::exp(-h / kMieScaleHeight), mie[0], kEpsilon);
    ComputeSingleScatteringIntegrand(a, t, kTopRadius, -1.0, 1.0, -1.0, h, true, rayleigh, mie);
    rayleigh_optical_depth = 2.0 * kRayleighScattering * kRayleighScaleHeight * (std::exp(-h / kRayleighScaleHeight) - std::exp(-h_top / kRayleighScaleHeight));
    mie_optical_depth = 2.0 * kMieExtinction * kMieScaleHeight * (std::exp(-h / kMieScaleHeight) - std::exp(-h_top / kMieScaleHeight));
    ExpectNear(std::exp(-rayleigh_optical_depth - mie_optical_depth) * std::exp(-h / kRayleighScaleHeight), rayleigh[0], kEpsilon);
    ExpectNear(std::exp(-rayleigh_optical_depth - mie_optical_depth) * std::exp(-h / kMieScaleHeight), mie[0], kEpsilon);
    SetUniformAtmosphere(a);
    RemoveAerosols(a);
    t = computeTransmittance(a);
    ComputeSingleScatteringIntegrand(a, t, kBottomRadius, 0.0, 0.0, 1.0, 50.0 * km, false, rayleigh, mie);
    rayleigh_optical_depth = kRayleighScattering * std::sqrt(kTopRadius * kTopRadius - kBottomRadius * kBottomRadius);
    ExpectNear(std::exp(-rayleigh_optical_depth), rayleigh[0], kEpsilon);
}

void TestDistanceToNearestAtmosphereBoundary(AtmosphereParameters a) {
    constexpr double r = kBottomRadius * 0.2 + kTopRadius * 0.8;
    ExpectNear(kTopRadius - r, DistanceToNearestAtmosphereBoundary(a, r, 1.0, RayIntersectsGround(a, r, 1.0)), 1.0);
    ExpectNear(std::sqrt(kTopRadius * kTopRadius - r * r), DistanceToNearestAtmosphereBoundary(a, r, 0.0, RayIntersectsGround(a, r, 0.0)), 1.0);
    ExpectNear(r - kBottomRadius, DistanceToNearestAtmosphereBoundary(a, r, -1.0, RayIntersectsGround(a, r, -1.0)), 1.0);
}

void TestComputeSingleScattering(AtmosphereParameters a) {
    TransmittanceTexture t = computeTransmittance(a);
    const double h_top = kTopRadius - kBottomRadius;
    Spec rayleigh, mie;
    ComputeSingleScattering(a, t, kBottomRadius, 1.0, 1.0, 1.0, false, rayleigh, mie);
    double rayleigh_optical_depth = kRayleighScattering * kRayleighScaleHeight * (1.0 - std::exp(-h_top / kRayleighScaleHeight));
    double mie_optical_depth = kMieExtinction * kMieScaleHeight * (1.0 - std::exp(-h_top / kMieScaleHeight));
    ExpectNear(1.0, rayleigh[0] / (kSolarIrradiance * rayleigh_optical_depth * std::exp(-rayleigh_optical_depth - mie_optical_depth)), 10.0 * kEpsilon);
    ExpectNear(1.0, mie[0] / (kSolarIrradiance * mie_optical_depth * kMieScattering / kMieExtinction * std::exp(-rayleigh_optical_depth - mie_optical_depth)),
               10.0 * kEpsilon);
    RemoveAerosols(a);
    t = computeTransmittance(a);
    ComputeSingleScattering(a, t, kTopRadius, -1.0, 1.0, -1.0, true, rayleigh, mie);
    ExpectNear(1.0,
               rayleigh[0] / (kSolarIrradiance * 0.5 * (1.0 - std::exp(-2.0 * kRayleighScaleHeight * kRayleighScattering * (1.0 - std::exp(-h_top / kRayleighScaleHeight))))),
               2.0 * kEpsilon);
    ExpectNear(0.0, mie[0], kEpsilon);
}

void TestPhaseFunctions(AtmosphereParameters) {
    double rayleigh_integral = 0.0, mie_integral = 0.0;
    const unsigned int N = 100;
    for (unsigned int i = 0; i < N; ++i) {
        double theta = (i + 0.5) * kPi / N;
        double domega = std::sin(theta) * (kPi / N) * (2.0 * kPi);
        rayleigh_integral += RayleighPhaseFunction(std::cos(theta)) * domega;
        mie_integral += MiePhaseFunction(0.8, std::cos(theta)) * domega;
    }
    ExpectNear(1.0, rayleigh_integral, 2.0 * kEpsilon);
    ExpectNear(1.0, mie_integral, 2.0 * kEpsilon);
}

void TestGetScatteringTextureUvwzFromRMuMuSNu(AtmosphereParameters a) {
    ExpectNear(0.5 / SCATTERING_TEXTURE_R_SIZE, GetScatteringTextureUvwzFromRMuMuSNu(a, kBottomRadius, 0.0, 0.0, 0.0, false).w, kEpsilon);
    ExpectNear(1.0 - 0.5 / SCATTERING_TEXTURE_R_SIZE, GetScatteringTextureUvwzFromRMuMuSNu(a, kTopRadius, 0.0, 0.0, 0.0, false).w, kEpsilon);
    const double r = (kTopRadius + kBottomRadius) / 2.0;
    const double mu = CosineOfHorizonZenithAngle(r);
    ExpectNear(0.5 / SCATTERING_TEXTURE_MU_SIZE, GetScatteringTextureUvwzFromRMuMuSNu(a, r, mu, 0.0, 0.0, true).z, kEpsilon);
    ExpectNear(1.0 - 0.5 / SCATTERING_TEXTURE_MU_SIZE, GetScatteringTextureUvwzFromRMuMuSNu(a, r, mu, 0.0, 0.0, false).z, kEpsilon);
    ExpectTrue(GetScatteringTextureUvwzFromRMuMuSNu(a, r, -1.0, 0.0, 0.0, true).z < 0.5);
    ExpectTrue(GetScatteringTextureUvwzFromRMuMuSNu(a, r, 1.0, 0.0, 0.0, false).z > 0.5);
    ExpectNear(0.5 / SCATTERING_TEXTURE_MU_S_SIZE, GetScatteringTextureUvwzFromRMuMuSNu(a, kBottomRadius, 0.0, -1.0, 0.0, false).y, kEpsilon);
    ExpectNear(1.0 - 0.5 / SCATTERING_TEXTURE_MU_S_SIZE, GetScatteringTextureUvwzFromRMuMuSNu(a, kBottomRadius, 0.0, 1.0, 0.0, false).y, kEpsilon);
    ExpectNear(0.5 / SCATTERING_TEXTURE_MU_S_SIZE, GetScatteringTextureUvwzFromRMuMuSNu(a, kTopRadius, 0.0, -1.0, 0.0, false).y, kEpsilon);
    ExpectNear(1.0 - 0.5 / SCATTERING_TEXTURE_MU_S_SIZE, GetScatteringTextureUvwzFromRMuMuSNu(a, kTopRadius, 0.0, 1.0, 0.0, false).y, kEpsilon);
    ExpectNear(0.0, GetScatteringTextureUvwzFromRMuMuSNu(a, kBottomRadius, 0.0, 0.0, -1.0, false).x, kEpsilon);
    ExpectNear(1.0, GetScatteringTextureUvwzFromRMuMuSNu(a, kBottomRadius, 0.0, 0.0, 1.0, false).x, kEpsilon);
}

void TestGetRMuMuSNuFromScatteringTextureUvwz(AtmosphereParameters a) {
    double r, mu, mu_s, nu;
    bool ground;
    const double s = 0.5 / SCATTERING_TEXTURE_MU_S_SIZE, m = 0.5 / SCATTERING_TEXTURE_MU_SIZE, rr = 0.5 / SCATTERING_TEXTURE_R_SIZE;
    GetRMuMuSNuFromScatteringTextureUvwz(a, {0.0, s, m, rr}, r, mu, mu_s, nu, ground);
    ExpectNear(kBottomRadius, r, 1.0);
    GetRMuMuSNuFromScatteringTextureUvwz(a, {0.0, s, m, 1.0 - rr}, r, mu, mu_s, nu, ground);
    ExpectNear(kTopRadius, r, 1.0);
    GetRMuMuSNuFromScatteringTextureUvwz(a, {0.0, s, m + kEpsilon, 0.5}, r, mu, mu_s, nu, ground);
    const double mu_horizon = CosineOfHorizonZenithAngle(r);
    ExpectNear(mu_horizon, mu, kEpsilon);
    ExpectTrue(mu <= mu_horizon);
    ExpectTrue(ground);
    GetRMuMuSNuFromScatteringTextureUvwz(a, {0.0, s, 1.0 - m - kEpsilon, 0.5}, r, mu, mu_s, nu, ground);
    ExpectNear(mu_horizon, mu, 5.0 * kEpsilon);
    ExpectTrue(mu >= mu_horizon);
    ExpectFalse(ground);
    GetRMuMuSNuFromScatteringTextureUvwz(a, {0.0, s, m, rr}, r, mu, mu_s, nu, ground);
    ExpectNear(-1.0, mu_s, kEpsilon);
    GetRMuMuSNuFromScatteringTextureUvwz(a, {0.0, 1.0 - s, m, rr}, r, mu, mu_s, nu, ground);
    ExpectNear(1.0, mu_s, kEpsilon);
    GetRMuMuSNuFromScatteringTextureUvwz(a, {0.0, s, m, rr}, r, mu, mu_s, nu, ground);
    ExpectNear(-1.0, nu, kEpsilon);
    GetRMuMuSNuFromScatteringTextureUvwz(a, {1.0, s, m, rr}, r, mu, mu_s, nu, ground);
    ExpectNear(1.0, nu, kEpsilon);
    GetRMuMuSNuFromScatteringTextureUvwz(a, GetScatteringTextureUvwzFromRMuMuSNu(a, kBottomRadius, -1.0, 1.0, -1.0, true), r, mu, mu_s, nu, ground);
    ExpectNear(kBottomRadius, r, 1.0);
    ExpectNear(-1.0, mu, kEpsilon);
    ExpectNear(1.0, mu_s, kEpsilon);
    ExpectNear(-1.0, nu, kEpsilon);
    ExpectTrue(ground);
    GetRMuMuSNuFromScatteringTextureUvwz(a, GetScatteringTextureUvwzFromRMuMuSNu(a, kTopRadius, -1.0, 1.0, -1.0, true), r, mu, mu_s, nu, ground);
    ExpectNear(kTopRadius, r, 1.0);
    ExpectNear(-1.0, mu, kEpsilon);
    ExpectNear(1.0, mu_s, kEpsilon);
    ExpectNear(-1.0, nu, kEpsilon);
    ExpectTrue(ground);
    GetRMuMuSNuFromScatteringTextureUvwz(a, GetScatteringTextureUvwzFromRMuMuSNu(a, (kBottomRadius + kTopRadius) / 2.0, 0.2, 0.3, 0.4, false), r, mu, mu_s, nu,
                                         ground);
    ExpectNear((kBottomRadius + kTopRadius) / 2.0, r, 1.0);
    ExpectNear(0.2, mu, kEpsilon);
    ExpectNear(0.3, mu_s, kEpsilon);
    ExpectNear(0.4, nu, kEpsilon);
    ExpectFalse(ground);
}

void TestComputeAndGetSingleScattering(AtmosphereParameters a) {
    TransmittanceTexture t = computeTransmittance(a);
    auto single = [&](bool rayleighChannel) {
        return lazy([&a, &t, rayleighChannel](int i, int j, int k) {
            Spec rayleigh, mie;
            ComputeSingleScatteringTexture(a, t, i + 0.5, j + 0.5, k + 0.5, rayleigh, mie);
            return rayleighChannel ? rayleigh : mie;
        });
    };
    auto single_rayleigh = single(true);
    auto single_mie = single(false);
    auto check = [&](double r, double mu, double mu_s, double nu, bool ground, double tolerance) {
        Spec rayleigh = GetScattering(a, single_rayleigh, r, mu, mu_s, nu, ground);
        Spec mie = GetScattering(a, single_mie, r, mu, mu_s, nu, ground);
        Spec expected_rayleigh, expected_mie;
        ComputeSingleScattering(a, t, r, mu, mu_s, nu, ground, expected_rayleigh, expected_mie);
        ExpectNear(1.0, rayleigh[0] / expected_rayleigh[0], tolerance);
        ExpectNear(1.0, mie[0] / expected_mie[0], tolerance);
    };
    check(kBottomRadius, 1.0, 1.0, 1.0, false, kEpsilon);
    check(kTopRadius, -1.0, 1.0, -1.0, true, kEpsilon);
    // Bruneton: "The relative error is quite large in this case, i.e. between 6 to 8%."
    check(kBottomRadius, 0.0, 0.0, 0.0, false, 1e-1);
    double mu = CosineOfHorizonZenithAngle(kTopRadius);
    check(kTopRadius, mu, 1.0, mu, false, kEpsilon);
}

void TestComputeScatteringDensity(AtmosphereParameters a) {
    const double kRadiance = 13.0;
    TransmittanceTexture full_transmittance = makeTransmittanceTexture(Spec(1.0));
    ReducedScatteringTexture no_single_scattering = makeScatteringTexture(Spec(0.0));
    ScatteringTexture uniform_multiple_scattering = makeScatteringTexture(Spec(kRadiance));
    IrradianceTexture no_irradiance = makeIrradianceTexture(Spec(0.0));
    Spec density = ComputeScatteringDensity(a, full_transmittance, no_single_scattering, no_single_scattering, uniform_multiple_scattering, no_irradiance,
                                            kBottomRadius, 0.0, 0.0, 1.0, 3);
    ExpectNear(1.0, density[0] / ((kRayleighScattering + kMieScattering) * kRadiance), 2.0 * kEpsilon);
    const double kIrradiance = 13.0;
    IrradianceTexture uniform_irradiance = makeIrradianceTexture(Spec(kIrradiance));
    ScatteringTexture no_multiple_scattering = makeScatteringTexture(Spec(0.0));
    density = ComputeScatteringDensity(a, full_transmittance, no_single_scattering, no_single_scattering, no_multiple_scattering, uniform_irradiance, kBottomRadius,
                                       0.0, 0.0, 1.0, 3);
    ExpectNear(1.0, density[0] / ((kRayleighScattering + kMieScattering) * kGroundAlbedo / (2.0 * kPi) * kIrradiance), 2.0 * kEpsilon);
}

void TestComputeMultipleScattering(AtmosphereParameters a) {
    const double kRadianceDensity = 0.17;
    TransmittanceTexture full_transmittance = makeTransmittanceTexture(Spec(1.0));
    ScatteringDensityTexture uniform_density = makeScatteringTexture(Spec(kRadianceDensity));
    double r = kBottomRadius * 0.2 + kTopRadius * 0.8;
    double distance_to_ground = r - kBottomRadius;
    ExpectNear(kRadianceDensity * distance_to_ground, ComputeMultipleScattering(a, full_transmittance, uniform_density, r, -1.0, 1.0, -1.0, true)[0],
               kRadianceDensity * distance_to_ground * kEpsilon);
    double mu = CosineOfHorizonZenithAngle(kTopRadius);
    double distance_to_horizon = std::sqrt(kTopRadius * kTopRadius - kBottomRadius * kBottomRadius);
    ExpectNear(kRadianceDensity * distance_to_horizon, ComputeMultipleScattering(a, full_transmittance, uniform_density, kTopRadius, mu, 1.0, mu, true)[0],
               kRadianceDensity * distance_to_horizon * kEpsilon);
}

void TestComputeAndGetScatteringDensity(AtmosphereParameters a) {
    const double kRadiance = 13.0;
    TransmittanceTexture full_transmittance = makeTransmittanceTexture(Spec(1.0));
    ReducedScatteringTexture no_single_scattering = makeScatteringTexture(Spec(0.0));
    ScatteringTexture uniform_multiple_scattering = makeScatteringTexture(Spec(kRadiance));
    IrradianceTexture no_irradiance = makeIrradianceTexture(Spec(0.0));
    auto density1 = lazy([&](int i, int j, int k) {
        return ComputeScatteringDensityTexture(a, full_transmittance, no_single_scattering, no_single_scattering, uniform_multiple_scattering, no_irradiance, i + 0.5,
                                               j + 0.5, k + 0.5, 3);
    });
    Spec density = GetScattering(a, density1, kBottomRadius, 0.0, 0.0, 1.0, false);
    ExpectNear(1.0, density[0] / ((kRayleighScattering + kMieScattering) * kRadiance), 2.0 * kEpsilon);
    const double kIrradiance = 13.0;
    IrradianceTexture uniform_irradiance = makeIrradianceTexture(Spec(kIrradiance));
    ScatteringTexture no_multiple_scattering = makeScatteringTexture(Spec(0.0));
    auto density2 = lazy([&](int i, int j, int k) {
        return ComputeScatteringDensityTexture(a, full_transmittance, no_single_scattering, no_single_scattering, no_multiple_scattering, uniform_irradiance, i + 0.5,
                                               j + 0.5, k + 0.5, 3);
    });
    density = GetScattering(a, density2, kBottomRadius, 0.0, 0.0, 1.0, false);
    ExpectNear(1.0, density[0] / ((kRayleighScattering + kMieScattering) * kGroundAlbedo / (2.0 * kPi) * kIrradiance), 2.0 * kEpsilon);
}

void TestComputeAndGetMultipleScattering(AtmosphereParameters a) {
    const double kRadianceDensity = 0.17;
    TransmittanceTexture full_transmittance = makeTransmittanceTexture(Spec(1.0));
    ScatteringDensityTexture uniform_density = makeScatteringTexture(Spec(kRadianceDensity));
    auto multiple = lazy([&](int i, int j, int k) {
        double nu;
        return ComputeMultipleScatteringTexture(a, full_transmittance, uniform_density, i + 0.5, j + 0.5, k + 0.5, nu);
    });
    double r = kBottomRadius * 0.2 + kTopRadius * 0.8;
    double distance_to_ground = r - kBottomRadius;
    ExpectNear(kRadianceDensity * distance_to_ground, GetScattering(a, multiple, r, -1.0, 1.0, -1.0, true)[0], kRadianceDensity * distance_to_ground * kEpsilon);
    double mu = CosineOfHorizonZenithAngle(kTopRadius);
    double distance_to_horizon = std::sqrt(kTopRadius * kTopRadius - kBottomRadius * kBottomRadius);
    ExpectNear(kRadianceDensity * distance_to_horizon, GetScattering(a, multiple, kTopRadius, mu, 1.0, mu, true)[0], kRadianceDensity * distance_to_horizon * kEpsilon);
}

void TestComputeIndirectIrradiance(AtmosphereParameters a) {
    ReducedScatteringTexture no_single_scattering = makeScatteringTexture(Spec(0.0));
    ScatteringTexture uniform_multiple_scattering = makeScatteringTexture(Spec(1.0));
    Spec irradiance = ComputeIndirectIrradiance(a, no_single_scattering, no_single_scattering, uniform_multiple_scattering, kBottomRadius, 1.0, 2);
    ExpectNear(kPi, irradiance[0], 10.0 * kEpsilon);
}

void TestGetIrradianceTextureUvFromRMuS(AtmosphereParameters a) {
    ExpectNear(0.5 / IRRADIANCE_TEXTURE_HEIGHT, GetIrradianceTextureUvFromRMuS(a, kBottomRadius, 0.0).y, kEpsilon);
    ExpectNear(1.0 - 0.5 / IRRADIANCE_TEXTURE_HEIGHT, GetIrradianceTextureUvFromRMuS(a, kTopRadius, 0.0).y, kEpsilon);
    ExpectNear(0.5 / IRRADIANCE_TEXTURE_WIDTH, GetIrradianceTextureUvFromRMuS(a, kBottomRadius, -1.0).x, kEpsilon);
    ExpectNear(1.0 - 0.5 / IRRADIANCE_TEXTURE_WIDTH, GetIrradianceTextureUvFromRMuS(a, kBottomRadius, 1.0).x, kEpsilon);
}

void TestGetRMuSFromIrradianceTextureUv(AtmosphereParameters a) {
    double r, mu_s;
    GetRMuSFromIrradianceTextureUv(a, {0.5 / IRRADIANCE_TEXTURE_WIDTH, 0.5 / IRRADIANCE_TEXTURE_HEIGHT}, r, mu_s);
    ExpectNear(kBottomRadius, r, 1.0);
    GetRMuSFromIrradianceTextureUv(a, {0.5 / IRRADIANCE_TEXTURE_WIDTH, 1.0 - 0.5 / IRRADIANCE_TEXTURE_HEIGHT}, r, mu_s);
    ExpectNear(kTopRadius, r, 1.0);
    GetRMuSFromIrradianceTextureUv(a, {0.5 / IRRADIANCE_TEXTURE_WIDTH, 0.5 / IRRADIANCE_TEXTURE_HEIGHT}, r, mu_s);
    ExpectNear(-1.0, mu_s, kEpsilon);
    GetRMuSFromIrradianceTextureUv(a, {1.0 - 0.5 / IRRADIANCE_TEXTURE_WIDTH, 0.5 / IRRADIANCE_TEXTURE_HEIGHT}, r, mu_s);
    ExpectNear(1.0, mu_s, kEpsilon);
}

void TestComputeAndGetIrradiance(AtmosphereParameters a) {
    ReducedScatteringTexture no_single_scattering = makeScatteringTexture(Spec(0.0));
    ScatteringTexture fake_multiple_scattering = makeScatteringTexture();
    for (int x = 0; x < fake_multiple_scattering.width; ++x)
        for (int y = 0; y < fake_multiple_scattering.height; ++y)
            for (int z = 0; z < fake_multiple_scattering.depth; ++z)
                fake_multiple_scattering.at(x, y, z) = Spec(z + fake_multiple_scattering.depth * (y + fake_multiple_scattering.height * static_cast<double>(x)));
    double r = kBottomRadius * 0.8 + kTopRadius * 0.2;
    double mu_s = 0.25;
    int order = 2;
    IrradianceTexture irradiance = makeIrradianceTexture();
    RunJobs([&](int j) {
        for (int i = 0; i < IRRADIANCE_TEXTURE_WIDTH; ++i)
            irradiance.at(i, j) = ComputeIndirectIrradianceTexture(a, no_single_scattering, no_single_scattering, fake_multiple_scattering, {i + 0.5, j + 0.5}, order);
    }, IRRADIANCE_TEXTURE_HEIGHT, 0);
    ExpectNear(1.0, GetIrradiance(a, irradiance, r, mu_s)[0] / ComputeIndirectIrradiance(a, no_single_scattering, no_single_scattering, fake_multiple_scattering, r, mu_s, order)[0],
               kEpsilon);
    ExpectNotNear(1.0, GetIrradiance(a, irradiance, r, mu_s)[0] / ComputeIndirectIrradiance(a, no_single_scattering, no_single_scattering, fake_multiple_scattering, r, 0.5, order)[0],
                  kEpsilon);
}

} // namespace

int main() {
    struct Case { const char* name; void (*fn)(AtmosphereParameters); };
    const Case cases[] = {
        {"DistanceToTopAtmosphereBoundary", TestDistanceToTopAtmosphereBoundary},
        {"RayIntersectsGround", TestRayIntersectsGround},
        {"GetProfileDensity", TestGetProfileDensity},
        {"ComputeOpticalLengthToTopAtmosphereBoundary", TestComputeOpticalLengthToTopAtmosphereBoundary},
        {"ComputeTransmittanceToTopAtmosphereBoundary", TestComputeTransmittanceToTopAtmosphereBoundary},
        {"GetTextureCoordFromUnitRange", TestGetTextureCoordFromUnitRange},
        {"GetTransmittanceTextureUvFromRMu", TestGetTransmittanceTextureUvFromRMu},
        {"GetRMuFromTransmittanceTextureUv", TestGetRMuFromTransmittanceTextureUv},
        {"GetTransmittanceToTopAtmosphereBoundary", TestGetTransmittanceToTopAtmosphereBoundary},
        {"ComputeAndGetTransmittance", TestComputeAndGetTransmittance},
        {"ComputeSingleScatteringIntegrand", TestComputeSingleScatteringIntegrand},
        {"DistanceToNearestAtmosphereBoundary", TestDistanceToNearestAtmosphereBoundary},
        {"ComputeSingleScattering", TestComputeSingleScattering},
        {"PhaseFunctions", TestPhaseFunctions},
        {"GetScatteringTextureUvwzFromRMuMuSNu", TestGetScatteringTextureUvwzFromRMuMuSNu},
        {"GetRMuMuSNuFromScatteringTextureUvwz", TestGetRMuMuSNuFromScatteringTextureUvwz},
        {"ComputeAndGetSingleScattering", TestComputeAndGetSingleScattering},
        {"ComputeScatteringDensity", TestComputeScatteringDensity},
        {"ComputeMultipleScattering", TestComputeMultipleScattering},
        {"ComputeAndGetScatteringDensity", TestComputeAndGetScatteringDensity},
        {"ComputeAndGetMultipleScattering", TestComputeAndGetMultipleScattering},
        {"ComputeIndirectIrradiance", TestComputeIndirectIrradiance},
        {"GetIrradianceTextureUvFromRMuS", TestGetIrradianceTextureUvFromRMuS},
        {"GetRMuSFromIrradianceTextureUv", TestGetRMuSFromIrradianceTextureUv},
        {"GetComputeAndGetIrradiance", TestComputeAndGetIrradiance},
    };
    std::printf("[\n");
    for (const auto& c : cases) {
        current = c.name;
        c.fn(base());
    }
    std::printf("\n]\n");
    return 0;
}
