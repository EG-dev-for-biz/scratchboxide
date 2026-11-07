/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_SKY_MS_HPP
#define SCRATCHBOX_SKY_MS_HPP

// Method: F. García Liñán, "Spectral sky with multiple scattering" (Master's thesis, 2022; fgarlin.com/posts/2024-12-06-spectral_sky), as Blender's Multiple Scattering sky uses it.

/**
 * The scene weather's clear sky: four spectral samples (630, 560, 490, 430 nm) ray-marched through air, ozone and an
 * aerosol layer over a spherical Earth. Every order of scattering past the first comes from a fit to a spectral path
 * tracer (isotropic, falling with the sun below the horizon) plus the second order off a grey ground. At a low sun those
 * higher orders set the colour of the sky and of its light.
 *
 * computeSkyViewTable samples it into the viewer's sky-view table (physical-sky.ts's layout: azimuth from the sun across
 * 0..pi in `azimuthResolution` columns, elevation rows spaced by sqrt(elevation) from the horizon to the zenith), in
 * linear sRGB (D65) per unit of top-of-atmosphere solar luminance, with the irradiance the table puts on a level surface
 * and the direct-beam transmittance to the sun.
 *
 * Frame: +Z up through the observer, lengths in km, the sun in the X-Z plane at azimuth 0.
 */

#include "scratchbox_atmosphere_lut.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstddef>
#include <vector>

namespace scratchbox {
namespace sky_ms {

struct SkyMsParams {
    /** Sun elevation above the horizon, degrees (below it too: the Earth's shadow is in the model). */
    float sunElevationDeg{20.0f};
    /** Aerosol optical depth at 550 nm (a clear urban day ~0.1-0.3, thick haze ~1). */
    float aerosolOpticalDepth550{0.2f};
    /** Multiplier on the standard air (Rayleigh) density. */
    float airDensity{1.0f};
    /** Multiplier on the mean ozone column (334.5 DU). */
    float ozoneDensity{1.0f};
    /** Observer height above the ground, metres (held to 1 m - 99 999 m). */
    float observerAltitudeMeters{1.0f};
    int azimuthResolution{64};
    int elevationResolution{48};
};

struct SkyMsTable {
    /** RGB radiance, row-major [elevationRow][azimuthCol]; col 0 toward the sun, last away; row 0 at the horizon. */
    std::vector<float> rgb;
    int azimuthResolution{0};
    int elevationResolution{0};
    /** Irradiance the sky alone (no sun disc) puts on a level surface, RGB. */
    float horizontalIrradiance[3]{0, 0, 0};
    /** Direct-beam transmittance from the observer to the sun's centre, RGB, as the sun's colour shifts (0 below). */
    float sunTransmittance[3]{0, 0, 0};
    /** The aerosol number-density multiplier the optical depth mapped to (1 = the reference urban layer). */
    float aerosolDensity{0};
};

/** One value per spectral sample: 630, 560, 490, 430 nm. */
struct Spectrum4 {
    std::array<double, 4> v{0, 0, 0, 0};
    static Spectrum4 all(double x) { return {{x, x, x, x}}; }
    double operator[](int i) const { return v[static_cast<size_t>(i)]; }
    Spectrum4 operator+(const Spectrum4& o) const { Spectrum4 r; for (int i = 0; i < 4; ++i) r.v[i] = v[i] + o.v[i]; return r; }
    Spectrum4 operator-(const Spectrum4& o) const { Spectrum4 r; for (int i = 0; i < 4; ++i) r.v[i] = v[i] - o.v[i]; return r; }
    Spectrum4 operator*(const Spectrum4& o) const { Spectrum4 r; for (int i = 0; i < 4; ++i) r.v[i] = v[i] * o.v[i]; return r; }
    Spectrum4 operator/(const Spectrum4& o) const { Spectrum4 r; for (int i = 0; i < 4; ++i) r.v[i] = v[i] / o.v[i]; return r; }
    Spectrum4 operator*(double s) const { Spectrum4 r; for (int i = 0; i < 4; ++i) r.v[i] = v[i] * s; return r; }
    Spectrum4& operator+=(const Spectrum4& o) { for (int i = 0; i < 4; ++i) v[i] += o.v[i]; return *this; }
    Spectrum4& operator*=(const Spectrum4& o) { for (int i = 0; i < 4; ++i) v[i] *= o.v[i]; return *this; }
    Spectrum4 exp() const { Spectrum4 r; for (int i = 0; i < 4; ++i) r.v[i] = std::exp(v[i]); return r; }
};

namespace detail {

constexpr double kPi = 3.14159265358979323846;
constexpr double kEarthRadiusKm = 6371.0;
constexpr double kAtmosphereKm = 100.0;
constexpr double kTopRadiusKm = kEarthRadiusKm + kAtmosphereKm;
constexpr double kGroundAlbedo = 0.3;
constexpr double kAerosolG = 0.8;
constexpr int kMarchSteps = 64;
constexpr int kTransmittanceMu = 256;
constexpr int kTransmittanceAlt = 64;

// The method's measured data at the four samples (urban solar spectrum, cross-sections in cm^2, coefficients in 1/km).
const Spectrum4 kSolarIrradiance{{1.679, 1.828, 1.986, 1.307}};
const Spectrum4 kMolecularScatteringSeaLevel{{6.605e-3, 1.067e-2, 1.842e-2, 3.156e-2}};
const Spectrum4 kOzoneCrossSection{{3.472e-25, 3.914e-25, 1.349e-25, 11.03e-27}};
constexpr double kOzoneDobson = 334.5;
const Spectrum4 kAerosolAbsorptionCrossSection{{2.8722e-24, 4.6168e-24, 7.9706e-24, 1.3578e-23}};
const Spectrum4 kAerosolScatteringCrossSection{{1.5908e-22, 1.7711e-22, 2.0942e-22, 2.4033e-22}};
constexpr double kAerosolSeaLevelDensity = 1.3681e20;
constexpr double kAerosolBackgroundDensity = 2e6;
constexpr double kAerosolScaleHeightKm = 0.73;
/** Spectral sample -> CIE XYZ weights (rows: the four samples). */
constexpr double kSampleToXyz[4][3] = {
    {53.386917738564668, 22.981337506691025, 0.0},
    {43.904844466369358, 71.347795700053394, 0.102506867965741},
    {1.6137278251608962, 18.422960591455485, 31.742921188390806},
    {20.762668673810577, 2.3614213523314369, 110.48009643252140},
};
/** Higher orders of scattering, isotropic: the method's fit, scaled by the sun's height above the local horizon. */
const Spectrum4 kHigherOrderTint{{0.217, 0.347, 0.594, 1.0}};

struct Vec3d {
    double x{0}, y{0}, z{0};
    Vec3d operator+(const Vec3d& o) const { return {x + o.x, y + o.y, z + o.z}; }
    Vec3d operator*(double s) const { return {x * s, y * s, z * s}; }
    double dot(const Vec3d& o) const { return x * o.x + y * o.y + z * o.z; }
    double length() const { return std::sqrt(dot(*this)); }
};

/** Distance from `o` along unit `d` to the sphere of radius r about the planet centre; -1 when it is never reached ahead. */
inline double distanceToSphere(const Vec3d& o, const Vec3d& d, double r) {
    const double b = o.dot(d), c = o.dot(o) - r * r, disc = b * b - c;
    if (disc < 0.0) return -1.0;
    const double s = std::sqrt(disc);
    if (-b - s >= 0.0) return -b - s;
    return -b + s >= 0.0 ? -b + s : -1.0;
}

inline std::array<double, 3> toXyz(const Spectrum4& s) {
    std::array<double, 3> xyz{0, 0, 0};
    for (int i = 0; i < 4; ++i)
        for (int c = 0; c < 3; ++c) xyz[c] += kSampleToXyz[i][c] * s[i];
    return xyz;
}

inline std::array<double, 3> xyzToLinearSrgb(const std::array<double, 3>& c) {
    return {3.2404542 * c[0] - 1.5371385 * c[1] - 0.4985314 * c[2],
            -0.9692660 * c[0] + 1.8760108 * c[1] + 0.0415560 * c[2],
            0.0556434 * c[0] - 0.2040259 * c[1] + 1.0572252 * c[2]};
}

/** Aerosol extinction cross-section at 550 nm, Angstrom-interpolated between the 560 and 490 nm samples. */
inline double aerosolExtinction550() {
    const double e560 = kAerosolAbsorptionCrossSection[1] + kAerosolScatteringCrossSection[1];
    const double e490 = kAerosolAbsorptionCrossSection[2] + kAerosolScatteringCrossSection[2];
    const double alpha = -std::log(e490 / e560) / std::log(490.0 / 560.0);
    return e560 * std::pow(550.0 / 560.0, -alpha);
}

/** Vertical aerosol column of the reference layer (unit density multiplier) up to the top of the atmosphere. */
inline double aerosolColumn() {
    const double H = kAerosolScaleHeightKm;
    return kAerosolSeaLevelDensity * H * (1.0 - std::exp(-kAtmosphereKm / H)) + kAerosolBackgroundDensity * kAtmosphereKm;
}

} // namespace detail

/** The aerosol density multiplier giving an optical depth `tau550` at 550 nm. */
inline float aerosolDensityForOpticalDepth(float tau550) {
    return static_cast<float>(std::max(0.0, static_cast<double>(tau550)) / (detail::aerosolExtinction550() * detail::aerosolColumn()));
}

/** The medium and its precomputed transmittance to the top of the atmosphere. */
class MultipleScatteringAtmosphere {
public:
    MultipleScatteringAtmosphere(double airDensity, double aerosolDensity, double ozoneDensity)
        : air_(std::max(0.0, airDensity)), aerosol_(std::max(0.0, aerosolDensity)), ozone_(std::max(0.0, ozoneDensity)),
          table_(static_cast<size_t>(detail::kTransmittanceMu) * detail::kTransmittanceAlt) {
        atmosphere_lut::RunJobs([this](int j) {
            const double altFrac = static_cast<double>(j) / (detail::kTransmittanceAlt - 1);
            for (int i = 0; i < detail::kTransmittanceMu; ++i) {
                const double mu = 2.0 * i / (detail::kTransmittanceMu - 1) - 1.0;
                table_[static_cast<size_t>(j) * detail::kTransmittanceMu + i] = marchTransmittance(mu, altFrac);
            }
        }, detail::kTransmittanceAlt, 0);
    }

    /** Scattering and extinction at an altitude (km). */
    struct Medium { Spectrum4 molecularScattering, aerosolScattering, extinction; };
    Medium mediumAt(double hKm) const {
        using namespace detail;
        const Spectrum4 molScat = kMolecularScatteringSeaLevel * (std::exp(-0.07771971 * std::pow(hKm, 1.16364243)) * air_);
        // ozone: a log-normal fit of its number density with altitude
        const double lh = std::log(std::max(hKm, 1e-4));
        const double ozoneN = 3.78547397e20 * std::exp(-(lh - 3.22261) * (lh - 3.22261) * 5.55555555 - lh);
        const Spectrum4 ozoneAbs = kOzoneCrossSection * (kOzoneDobson * ozoneN * ozone_);
        const double aerosolN = (kAerosolSeaLevelDensity * std::exp(-hKm / kAerosolScaleHeightKm) + kAerosolBackgroundDensity) * aerosol_;
        const Spectrum4 aerScat = kAerosolScatteringCrossSection * aerosolN;
        const Spectrum4 aerAbs = kAerosolAbsorptionCrossSection * aerosolN;
        return {molScat, aerScat, molScat + aerScat + ozoneAbs + aerAbs};
    }

    /** Transmittance to the top of the atmosphere from a fraction of its height, at sun zenith cosine mu (bilinear). */
    Spectrum4 transmittance(double mu, double altFrac) const {
        const double x = std::clamp(mu * 0.5 + 0.5, 0.0, 1.0) * (detail::kTransmittanceMu - 1);
        const double y = std::clamp(altFrac, 0.0, 1.0) * (detail::kTransmittanceAlt - 1);
        const int x0 = static_cast<int>(x), y0 = static_cast<int>(y);
        const int x1 = std::min(x0 + 1, detail::kTransmittanceMu - 1), y1 = std::min(y0 + 1, detail::kTransmittanceAlt - 1);
        const double fx = x - x0, fy = y - y0;
        auto at = [&](int i, int j) { return table_[static_cast<size_t>(j) * detail::kTransmittanceMu + i]; };
        const Spectrum4 lo = at(x0, y0) * (1 - fx) + at(x1, y0) * fx;
        const Spectrum4 hi = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
        return lo * (1 - fy) + hi * fy;
    }

    /** Transmittance by ray march (no table), for the sun's beam at the observer. */
    Spectrum4 marchTransmittance(double mu, double altFrac) const {
        using namespace detail;
        const Vec3d o{0, 0, kEarthRadiusKm + altFrac * kAtmosphereKm};
        const Vec3d d{std::sqrt(std::max(0.0, 1.0 - mu * mu)), 0, mu};
        const double dt = distanceToSphere(o, d, kTopRadiusKm) / kMarchSteps;
        Spectrum4 depth;
        for (int s = 0; s < kMarchSteps; ++s) {
            // a path below the horizon runs through the ground, where the densest air stands in for it: the Earth's shadow
            const double h = std::max((o + d * ((s + 0.5) * dt)).length() - kEarthRadiusKm, 0.0);
            depth += mediumAt(h).extinction * dt;
        }
        return (depth * -1.0).exp();
    }

    /** Light scattered toward the observer along a ray of length tKm (single scattering plus the higher orders' fit). */
    Spectrum4 inscattered(const detail::Vec3d& origin, const detail::Vec3d& dir, const detail::Vec3d& sun, double tKm) const {
        using namespace detail;
        const double cosSun = dir.dot(sun);
        const double rayleighPhase = 3.0 / (16.0 * kPi) * (1.0 + cosSun * cosSun);
        const double g2 = kAerosolG * kAerosolG, den = 1.0 + g2 - 2.0 * kAerosolG * cosSun;
        const double aerosolPhase = (1.0 - g2) / (4.0 * kPi * den * std::sqrt(den));
        const double dt = tKm / kMarchSteps;
        Spectrum4 radiance, throughput = Spectrum4::all(1.0);
        for (int s = 0; s < kMarchSteps; ++s) {
            const Vec3d p = origin + dir * ((s + 0.5) * dt);
            const double r = p.length();
            const double h = std::max(r - kEarthRadiusKm, 0.0);
            const double muSun = p.dot(sun) / r;
            const Medium m = mediumAt(h);
            const Spectrum4 toSun = transmittance(muSun, h / kAtmosphereKm);
            const Spectrum4 multi = higherOrders(muSun, h / kAtmosphereKm, r);
            const Spectrum4 source = kSolarIrradiance * (m.molecularScattering * (toSun * rayleighPhase + multi) +
                                                         m.aerosolScattering * (toSun * aerosolPhase + multi));
            const Spectrum4 stepT = (m.extinction * -dt).exp();
            // the source integrated exactly over the step under its own extinction (Hillaire 2020)
            for (int i = 0; i < 4; ++i) {
                const double e = std::max(m.extinction[i], 1e-7);
                radiance.v[i] += throughput[i] * source[i] * (1.0 - stepT[i]) / e;
            }
            throughput *= stepT;
        }
        return radiance;
    }

private:
    /** Orders past the first at a point: the method's isotropic fit, plus the second order off the ground. */
    Spectrum4 higherOrders(double muSun, double altFrac, double rKm) const {
        using namespace detail;
        const double planetSolidAngle = 2.0 * kPi * (1.0 - std::sqrt(std::max(0.0, 1.0 - (kEarthRadiusKm / rKm) * (kEarthRadiusKm / rKm))));
        const Spectrum4 sunAtGround = transmittance(muSun, 0.0);
        // ground -> point = (ground -> sun) / (point -> sun), both read straight up the table
        const Spectrum4 groundToPoint = transmittance(1.0, 0.0) / transmittance(1.0, altFrac);
        const Spectrum4 ground = sunAtGround * groundToPoint * (planetSolidAngle * (kGroundAlbedo / kPi) * muSun / (4.0 * kPi));
        const Spectrum4 fit = kHigherOrderTint * (0.02 / (1.0 + 5.0 * std::exp(-17.92 * muSun)));
        return fit + ground;
    }

    double air_, aerosol_, ozone_;
    std::vector<Spectrum4> table_;
};

/** Elevation (radians) of sky-view row `i` of `rows`, row 0 at the horizon: u^2 x 90 degrees, u = (i + 0.5) / rows. */
inline double rowElevation(int i, int rows) {
    const double u = (i + 0.5) / rows;
    return u * u * detail::kPi * 0.5;
}

/** The sky-view table for one sun (see the file comment). */
inline SkyMsTable computeSkyViewTable(const SkyMsParams& p) {
    using namespace detail;
    const int W = std::max(4, p.azimuthResolution), H = std::max(4, p.elevationResolution);
    SkyMsTable out;
    out.azimuthResolution = W;
    out.elevationResolution = H;
    out.aerosolDensity = aerosolDensityForOpticalDepth(p.aerosolOpticalDepth550);
    out.rgb.assign(static_cast<size_t>(W) * H * 3, 0.0f);

    const MultipleScatteringAtmosphere atmosphere(p.airDensity, out.aerosolDensity, p.ozoneDensity);
    const double altKm = std::clamp(static_cast<double>(p.observerAltitudeMeters), 1.0, 99999.0) / 1000.0;
    const double el = p.sunElevationDeg * kPi / 180.0;
    const Vec3d sun{std::cos(el), 0.0, std::sin(el)};
    const Vec3d origin{0.0, 0.0, kEarthRadiusKm + altKm};
    const double perSolarLuminance = 1.0 / toXyz(kSolarIrradiance)[1];

    atmosphere_lut::RunJobs([&](int i) {
        const double rowEl = rowElevation(i, H);
        for (int j = 0; j < W; ++j) {
            const double az = kPi * (j + 0.5) / W;
            const Vec3d dir{std::cos(rowEl) * std::cos(az), std::cos(rowEl) * std::sin(az), std::sin(rowEl)};
            const double toGround = distanceToSphere(origin, dir, kEarthRadiusKm);
            const double length = toGround < 0.0 ? distanceToSphere(origin, dir, kTopRadiusKm) : toGround;
            const auto rgb = xyzToLinearSrgb(toXyz(atmosphere.inscattered(origin, dir, sun, length)));
            float* dst = &out.rgb[(static_cast<size_t>(i) * W + j) * 3];
            for (int c = 0; c < 3; ++c) dst[c] = static_cast<float>(std::max(0.0, rgb[c] * perSolarLuminance));
        }
    }, H, 0);

    // level-surface irradiance: both halves of the sky (azimuth +-), each cell's solid angle times cos(zenith)
    for (int i = 0; i < H; ++i) {
        const double u0 = static_cast<double>(i) / H, u1 = static_cast<double>(i + 1) / H;
        const double band = std::sin(u1 * u1 * kPi / 2) - std::sin(u0 * u0 * kPi / 2);
        const double w = band * (kPi / W) * 2.0 * std::sin(rowElevation(i, H));
        for (int j = 0; j < W; ++j)
            for (int c = 0; c < 3; ++c) out.horizontalIrradiance[c] += static_cast<float>(out.rgb[(static_cast<size_t>(i) * W + j) * 3 + c] * w);
    }

    // the sun's beam: its transmitted spectrum against the unattenuated one, per sRGB channel
    if (p.sunElevationDeg >= 0.0f) {
        const Spectrum4 t = atmosphere.marchTransmittance(std::sin(el), altKm / kAtmosphereKm);
        const auto through = xyzToLinearSrgb(toXyz(kSolarIrradiance * t));
        const auto full = xyzToLinearSrgb(toXyz(kSolarIrradiance));
        for (int c = 0; c < 3; ++c) out.sunTransmittance[c] = static_cast<float>(std::max(0.0, through[c] / full[c]));
    }
    return out;
}

} // namespace sky_ms
} // namespace scratchbox

#endif // SCRATCHBOX_SKY_MS_HPP
