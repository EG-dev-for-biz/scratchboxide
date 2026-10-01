/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_EPHEMERIS_HPP
#define SCRATCHBOX_EPHEMERIS_HPP

#include "scratchbox_math.hpp"
#include <cmath>
#include <ctime>
#include <algorithm>

namespace scratchbox {
namespace ephemeris {

using math::Vec3;
using math::PI;
using math::DEG_TO_RAD;
using math::RAD_TO_DEG;

struct SolarAngles {
    float elevationRad{0.0f};  // Altitude/Elevation in radians (-PI/2 to PI/2)
    float elevationDeg{0.0f};  // Altitude/Elevation in degrees (-90 to 90)
    float azimuthRad{0.0f};    // Azimuth in radians clockwise from true North (0 to 2*PI)
    float azimuthDeg{0.0f};    // Azimuth in degrees clockwise from true North (0 to 360)
    float zenithRad{0.0f};     // Zenith angle in radians (PI/2 - elevationRad)
    float zenithDeg{0.0f};     // Zenith angle in degrees (90 - elevationDeg)
};

struct EphemerisResult {
    float latitude{0.0f};
    float longitude{0.0f};
    int64_t unixTimestamp{0};
    SolarAngles angles;

    bool isDay{false};
    bool isNight{false};
    bool isGoldenHour{false};
    bool isBlueHour{false};
    bool isTwilight{false};

    float colorTemperatureK{5500.0f};
    Vec3 sunColorRgb{1.0f, 0.95f, 0.88f}; // Normalized linear sRGB
    float directSunIntensity{1.0f};
    float atmosphericAirmass{1.0f};

    Vec3 sunDirectionThreeJS{0.0f, 1.0f, 0.0f}; // X=East, Y=Up, Z=-North
    Vec3 sunDirectionENU{0.0f, 0.0f, 1.0f};     // East, North, Up
};

class EphemerisService {
public:
    /**
     * Convert Kelvin blackbody temperature to approximate sRGB color.
     * Based on Planckian locus approximations (Tanner Helland / Kang et al.).
     */
    static Vec3 kelvinToRgb(float kelvin) {
        float temp = std::clamp(kelvin, 1000.0f, 40000.0f) / 100.0f;
        float r = 0.0f, g = 0.0f, b = 0.0f;

        // Red
        if (temp <= 66.0f) {
            r = 1.0f;
        } else {
            r = 329.698727446f * std::pow(temp - 60.0f, -0.1332047592f) / 255.0f;
            r = std::clamp(r, 0.0f, 1.0f);
        }

        // Green
        if (temp <= 66.0f) {
            g = (99.4708025861f * std::log(temp) - 161.1195681661f) / 255.0f;
        } else {
            g = 288.1221695283f * std::pow(temp - 60.0f, -0.0755148492f) / 255.0f;
        }
        g = std::clamp(g, 0.0f, 1.0f);

        // Blue
        if (temp >= 66.0f) {
            b = 1.0f;
        } else if (temp <= 19.0f) {
            b = 0.0f;
        } else {
            b = (138.5177312231f * std::log(temp - 10.0f) - 305.0447927307f) / 255.0f;
            b = std::clamp(b, 0.0f, 1.0f);
        }

        return Vec3(r, g, b);
    }

    /**
     * Compute exact Julian Day from Unix Epoch Timestamp (seconds).
     */
    static double unixTimeToJulianDay(int64_t unixSeconds) {
        return (static_cast<double>(unixSeconds) / 86400.0) + 2440587.5;
    }

    /**
     * Compute solar angles using high-precision NOAA solar algorithm.
     */
    static SolarAngles calculateSolarAngles(float latDeg, float lngDeg, int64_t unixSeconds) {
        double jd = unixTimeToJulianDay(unixSeconds);
        double d = jd - 2451545.0; // Days since J2000.0

        // Mean anomaly of the Sun (degrees)
        double M = std::fmod(357.5291 + 0.98560028 * d, 360.0);
        if (M < 0.0) M += 360.0;
        double mRad = M * DEG_TO_RAD;

        // Mean longitude of the Sun (degrees)
        double L = std::fmod(280.4665 + 0.98564736 * d, 360.0);
        if (L < 0.0) L += 360.0;

        // Ecliptic longitude of the Sun (degrees)
        double lambda = L + 1.915 * std::sin(mRad) + 0.020 * std::sin(2.0 * mRad);
        double lambdaRad = lambda * DEG_TO_RAD;

        // Obliquity of the ecliptic (degrees)
        double epsilon = 23.439 - 0.00000036 * d;
        double epsRad = epsilon * DEG_TO_RAD;

        // Right ascension (alpha) and Declination (delta)
        double sinDelta = std::sin(epsRad) * std::sin(lambdaRad);
        double delta = std::asin(sinDelta); // radians
        double cosDelta = std::cos(delta);

        double alpha = std::atan2(std::cos(epsRad) * std::sin(lambdaRad), std::cos(lambdaRad)); // radians

        // Greenwich Mean Sidereal Time (GMST) in hours
        double gmst = std::fmod(18.697374558 + 24.06570982441908 * d, 24.0);
        if (gmst < 0.0) gmst += 24.0;

        // Local Sidereal Time (LST) in radians
        double lstRad = (gmst + static_cast<double>(lngDeg) / 15.0) * 15.0 * DEG_TO_RAD;

        // Hour angle (H) in radians
        double H = lstRad - alpha;

        double latRad = static_cast<double>(latDeg) * DEG_TO_RAD;
        double sinLat = std::sin(latRad);
        double cosLat = std::cos(latRad);

        // Elevation angle (h)
        double sinElev = sinLat * sinDelta + cosLat * cosDelta * std::cos(H);
        sinElev = std::clamp(sinElev, -1.0, 1.0);
        double elevRad = std::asin(sinElev);
        double elevDeg = elevRad * RAD_TO_DEG;

        // Atmospheric refraction correction near horizon (Saemundsson formula)
        if (elevDeg > -1.0 && elevDeg < 85.0) {
            double r = 1.02 / std::tan((elevDeg + 10.3 / (elevDeg + 5.11)) * DEG_TO_RAD);
            elevDeg += (r / 60.0); // add arcminutes as degrees
            elevRad = elevDeg * DEG_TO_RAD;
        }

        // Azimuth angle (A) clockwise from North
        double cosAz = (sinDelta - sinLat * std::sin(elevRad)) / (cosLat * std::cos(elevRad));
        cosAz = std::clamp(cosAz, -1.0, 1.0);
        double azRad = std::acos(cosAz);
        if (std::sin(H) > 0.0) {
            azRad = 2.0 * PI - azRad;
        }
        double azDeg = azRad * RAD_TO_DEG;

        float zenithRad = static_cast<float>(PI * 0.5 - elevRad);
        float zenithDeg = 90.0f - static_cast<float>(elevDeg);

        return SolarAngles{
            .elevationRad = static_cast<float>(elevRad),
            .elevationDeg = static_cast<float>(elevDeg),
            .azimuthRad = static_cast<float>(azRad),
            .azimuthDeg = static_cast<float>(azDeg),
            .zenithRad = zenithRad,
            .zenithDeg = zenithDeg
        };
    }

    /**
     * Compute full ephemeris state including diurnal phases, color temperature, and vectors.
     */
    static EphemerisResult calculate(float latDeg, float lngDeg, int64_t unixSeconds) {
        SolarAngles angles = calculateSolarAngles(latDeg, lngDeg, unixSeconds);
        EphemerisResult res;
        res.latitude = latDeg;
        res.longitude = lngDeg;
        res.unixTimestamp = unixSeconds;
        res.angles = angles;

        float elev = angles.elevationDeg;

        res.isDay = elev > 0.0f;
        res.isNight = elev <= -18.0f;
        res.isGoldenHour = elev >= -4.0f && elev <= 6.0f;
        res.isBlueHour = elev >= -6.0f && elev < -4.0f;
        res.isTwilight = elev > -18.0f && elev <= 0.0f;

        // Atmospheric airmass (Kasten and Young, 1989)
        float zDeg = angles.zenithDeg;
        if (zDeg < 90.0f) {
            res.atmosphericAirmass = 1.0f / (std::cos(angles.zenithRad) + 0.50572f * std::pow(96.07995f - zDeg, -1.6364f));
        } else {
            res.atmosphericAirmass = 40.0f;
        }

        // Color temperature derivation (Planckian blackbody)
        if (elev > 25.0f) {
            // Midday bright sun (5500K - 6500K)
            float t = std::clamp((elev - 25.0f) / 65.0f, 0.0f, 1.0f);
            res.colorTemperatureK = math::lerp(5500.0f, 6500.0f, t);
            res.directSunIntensity = math::lerp(0.85f, 1.15f, t);
        } else if (elev > 0.0f) {
            // Low sun / sunset / golden hour (2200K - 5500K)
            float t = std::clamp(elev / 25.0f, 0.0f, 1.0f);
            res.colorTemperatureK = math::lerp(2200.0f, 5500.0f, t);
            res.directSunIntensity = math::lerp(0.15f, 0.85f, t);
        } else if (elev >= -6.0f) {
            // Civil twilight & Blue hour (shifting into cool ambient skylight 6500K - 9500K)
            float t = std::clamp((elev + 6.0f) / 6.0f, 0.0f, 1.0f);
            res.colorTemperatureK = math::lerp(9500.0f, 2200.0f, t);
            res.directSunIntensity = math::lerp(0.01f, 0.15f, t);
        } else {
            // Night ambient starlight / moonlight (4000K - 5000K faint ambient)
            res.colorTemperatureK = 4500.0f;
            res.directSunIntensity = 0.001f;
        }

        res.sunColorRgb = kelvinToRgb(res.colorTemperatureK);

        // Direct sunlight vectors
        // In local ENU (East=X, North=Y, Up=Z):
        float cosElev = std::cos(angles.elevationRad);
        float sinElev = std::sin(angles.elevationRad);
        float sinAz = std::sin(angles.azimuthRad);
        float cosAz = std::cos(angles.azimuthRad);

        res.sunDirectionENU = Vec3(
            sinAz * cosElev,
            cosAz * cosElev,
            sinElev
        ).normalized();

        // In Three.js coordinates (X=East, Y=Up, Z=-North):
        res.sunDirectionThreeJS = Vec3(
            sinAz * cosElev,
            sinElev,
            -cosAz * cosElev
        ).normalized();

        return res;
    }
};

} // namespace ephemeris
} // namespace scratchbox

#endif // SCRATCHBOX_EPHEMERIS_HPP
