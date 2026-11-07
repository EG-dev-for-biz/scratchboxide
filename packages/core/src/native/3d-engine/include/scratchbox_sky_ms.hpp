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

/**
 * The multiple-scattering clear sky of Fernando García Liñán (Blender's "Multiple Scattering" sky
 * model; vendored unchanged but for its includes in third_party/blender-sky/, MIT, see VENDORED.md):
 * four spectral samples (630, 560, 490, 430 nm) ray-marched through air, ozone and an urban aerosol
 * layer over a spherical Earth, with every higher order of scattering from a fit to a spectral path
 * tracer and the second order off the ground. At a low sun the higher orders set the colour of the
 * sky and of its light, which is why the scene weather draws it.
 *
 * This adapter samples it into the viewer's sky-view table (physical-sky.ts's layout: azimuth from
 * the sun across 0..pi in `azimuthResolution` columns, elevation rows spaced by sqrt(elevation) from
 * the horizon to the zenith), in linear sRGB (D65) per unit of top-of-atmosphere solar luminance,
 * with the irradiance the table puts on a level surface and the direct-beam transmittance to the sun.
 *
 * Include this header in one translation unit only: the vendored file defines non-inline functions.
 */

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <memory>
#include <thread>
#include <vector>

namespace scratchbox {
namespace sky_ms {
namespace blender_impl {
#include "../third_party/blender-sky/sky_multiple_scattering.cpp"
} // namespace blender_impl

struct SkyMsParams {
    /** Sun elevation above the horizon, degrees (below the horizon too: the Earth's shadow is in the model). */
    float sunElevationDeg{20.0f};
    /** Aerosol optical depth at 550 nm (a clear urban day ~0.1-0.3, thick haze ~1). */
    float aerosolOpticalDepth550{0.2f};
    /** Multiplier on the standard air (Rayleigh) density. */
    float airDensity{1.0f};
    /** Multiplier on the mean ozone column (334.5 DU). */
    float ozoneDensity{1.0f};
    /** Observer height above the ground, metres (the model clamps to 1 m - 99 999 m). */
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
    /** The aerosol density multiplier the optical depth mapped to (1 = the model's own urban layer). */
    float aerosolDensity{0};
};

namespace detail {

constexpr double kPi = 3.14159265358979323846;

inline void xyzToLinearSrgb(const blender_impl::float3& c, float out[3]) {
    out[0] = 3.2404542f * c.x - 1.5371385f * c.y - 0.4985314f * c.z;
    out[1] = -0.9692660f * c.x + 1.8760108f * c.y + 0.0415560f * c.z;
    out[2] = 0.0556434f * c.x - 0.2040259f * c.y + 1.0572252f * c.z;
}

/** Luminance (CIE Y) of the top-of-atmosphere sun in the model's own units. */
inline float solarLuminance() {
    return blender_impl::spectral_to_xyz(blender_impl::SUN_SPECTRAL_IRRADIANCE).y;
}

} // namespace detail

/**
 * The aerosol density multiplier that gives an optical depth `tau550` at 550 nm: the model's aerosol
 * extinction cross-section at 550 nm (Angstrom-interpolated between its 560 and 490 nm samples) over
 * its vertical density column up to the top of its atmosphere.
 */
inline float aerosolDensityForOpticalDepth(float tau550) {
    using namespace blender_impl;
    const double ext560 = static_cast<double>(AEROSOL_ABSORPTION_CROSS_SECTION[1]) + AEROSOL_SCATTERING_CROSS_SECTION[1];
    const double ext490 = static_cast<double>(AEROSOL_ABSORPTION_CROSS_SECTION[2]) + AEROSOL_SCATTERING_CROSS_SECTION[2];
    const double alpha = -std::log(ext490 / ext560) / std::log(490.0 / 560.0);
    const double ext550 = ext560 * std::pow(550.0 / 560.0, -alpha);
    const double H = AEROSOL_HEIGHT_SCALE, top = ATMOSPHERE_THICKNESS;
    const double column = AEROSOL_BASE_DENSITY * H * (1.0 - std::exp(-top / H)) + AEROSOL_BACKGROUND_DENSITY * top;
    const double perUnit = ext550 * column;
    return static_cast<float>(std::max(0.0, static_cast<double>(tau550)) / perUnit);
}

/** Elevation (radians) of sky-view row `i` of `rows`, row 0 at the horizon: (u^2) * 90 degrees, u = (i + 0.5) / rows. */
inline double rowElevation(int i, int rows) {
    const double u = (i + 0.5) / rows;
    return u * u * detail::kPi * 0.5;
}

/** The sky-view table for one sun (see the file comment). */
inline SkyMsTable computeSkyViewTable(const SkyMsParams& p) {
    using namespace blender_impl;
    const int W = std::max(4, p.azimuthResolution), H = std::max(4, p.elevationResolution);
    SkyMsTable out;
    out.azimuthResolution = W;
    out.elevationResolution = H;
    out.aerosolDensity = aerosolDensityForOpticalDepth(p.aerosolOpticalDepth550);
    out.rgb.assign(static_cast<size_t>(W) * H * 3, 0.0f);

    auto sms = std::make_unique<SkyMultipleScattering>(std::max(0.0f, p.airDensity), out.aerosolDensity, std::max(0.0f, p.ozoneDensity));
    sms->precompute_lut();

    // the model's frame: +Z up, km, the sun at azimuth 0 in the X-Z plane (as its own precompute_texture)
    const float altitudeKm = clamp(p.observerAltitudeMeters, 1.0f, 99999.0f) / 1000.0f;
    const float sunEl = static_cast<float>(p.sunElevationDeg * detail::kPi / 180.0);
    const float3 sunDir = sun_direction(std::cos(M_PI_2_F - sunEl));
    const float3 origin = make_float3(0.0f, 0.0f, EARTH_RADIUS + altitudeKm);
    const float norm = 1.0f / detail::solarLuminance();

    SKY_parallel_for(0, static_cast<size_t>(H), 1, [&](size_t begin, size_t end) {
        for (size_t i = begin; i < end; ++i) {
            const double el = rowElevation(static_cast<int>(i), H);
            for (int j = 0; j < W; ++j) {
                const double az = detail::kPi * (j + 0.5) / W;
                const float3 dir = make_float3(static_cast<float>(std::cos(el) * std::cos(az)), static_cast<float>(std::cos(el) * std::sin(az)),
                                               static_cast<float>(std::sin(el)));
                const float atmos = ray_sphere_intersection(origin, dir, ATMOSPHERE_RADIUS);
                const float ground = ray_sphere_intersection(origin, dir, EARTH_RADIUS);
                const float tD = ground < 0.0f ? atmos : ground;
                const float3 xyz = spectral_to_xyz(sms->get_inscattering(sunDir, origin, dir, tD)) * norm;
                float rgb[3];
                detail::xyzToLinearSrgb(xyz, rgb);
                float* dst = &out.rgb[(i * static_cast<size_t>(W) + j) * 3];
                for (int c = 0; c < 3; ++c) dst[c] = std::max(0.0f, rgb[c]);
            }
        }
    });

    // level-surface irradiance: both halves of the sky (azimuth +-), the cell's solid angle times cos(zenith)
    for (int i = 0; i < H; ++i) {
        const double u0 = static_cast<double>(i) / H, u1 = static_cast<double>(i + 1) / H;
        const double band = std::sin(u1 * u1 * detail::kPi / 2) - std::sin(u0 * u0 * detail::kPi / 2);
        const double w = band * (detail::kPi / W) * 2.0 * std::sin(rowElevation(i, H));
        for (int j = 0; j < W; ++j)
            for (int c = 0; c < 3; ++c) out.horizontalIrradiance[c] += static_cast<float>(out.rgb[(static_cast<size_t>(i) * W + j) * 3 + c] * w);
    }

    // the sun's beam: its transmitted spectrum against the unattenuated one, per sRGB channel
    if (p.sunElevationDeg > -1.0f) {
        const float4 t = sms->get_transmittance(std::cos(M_PI_2_F - sunEl), altitudeKm / ATMOSPHERE_THICKNESS);
        float through[3], full[3];
        detail::xyzToLinearSrgb(spectral_to_xyz(SUN_SPECTRAL_IRRADIANCE * t), through);
        detail::xyzToLinearSrgb(spectral_to_xyz(SUN_SPECTRAL_IRRADIANCE), full);
        for (int c = 0; c < 3; ++c) out.sunTransmittance[c] = p.sunElevationDeg < 0.0f ? 0.0f : std::max(0.0f, through[c] / full[c]);
    }
    return out;
}

} // namespace sky_ms
} // namespace scratchbox

#endif // SCRATCHBOX_SKY_MS_HPP
