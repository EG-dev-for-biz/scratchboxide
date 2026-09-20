/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_GEOSPATIAL_HPP
#define SCRATCHBOX_GEOSPATIAL_HPP

#include "scratchbox_math.hpp"
#include <vector>
#include <unordered_map>
#include <cmath>
#include <cstdint>
#include <algorithm>

namespace scratchbox {
namespace geospatial {

using math::Vec3;
using math::PI;
using math::DEG_TO_RAD;
using math::RAD_TO_DEG;

// ============================================================================
// WGS-84 Geodetic & Coordinate Transformations
// ============================================================================
namespace wgs84 {
    constexpr double A = 6378137.0;            // Semi-major axis (meters)
    constexpr double F_RECIP = 298.257223563;  // Reciprocal flattening (1/f)
    constexpr double F = 1.0 / F_RECIP;
    constexpr double B = A * (1.0 - F);        // Semi-minor axis (meters)
    constexpr double E2 = (A * A - B * B) / (A * A); // First eccentricity squared
    constexpr double E_PRIME2 = (A * A - B * B) / (B * B); // Second eccentricity squared

    struct GeodeticCoord {
        double latDeg{0.0};
        double lngDeg{0.0};
        double altitudeMeters{0.0};
    };

    /**
     * Convert Geodetic (Lat, Lng, Alt) to Earth-Centered, Earth-Fixed (ECEF) coordinates in meters.
     */
    inline Vec3 geodeticToECEF(double latDeg, double lngDeg, double altMeters) {
        double latRad = latDeg * DEG_TO_RAD;
        double lngRad = lngDeg * DEG_TO_RAD;

        double sinLat = std::sin(latRad);
        double cosLat = std::cos(latRad);
        double sinLng = std::sin(lngRad);
        double cosLng = std::cos(lngRad);

        // Prime vertical radius of curvature
        double N = A / std::sqrt(1.0 - E2 * sinLat * sinLat);

        double x = (N + altMeters) * cosLat * cosLng;
        double y = (N + altMeters) * cosLat * sinLng;
        double z = (N * (1.0 - E2) + altMeters) * sinLat;

        return Vec3(static_cast<float>(x), static_cast<float>(y), static_cast<float>(z));
    }

    /**
     * Convert ECEF coordinates back to Geodetic (Bowring's algorithm).
     */
    inline GeodeticCoord ecefToGeodetic(const Vec3& ecef) {
        double x = static_cast<double>(ecef.x);
        double y = static_cast<double>(ecef.y);
        double z = static_cast<double>(ecef.z);

        double p = std::sqrt(x * x + y * y);
        double theta = std::atan2(z * A, p * B);

        double sinTheta = std::sin(theta);
        double cosTheta = std::cos(theta);

        double latRad = std::atan2(
            z + E_PRIME2 * B * sinTheta * sinTheta * sinTheta,
            p - E2 * A * cosTheta * cosTheta * cosTheta
        );

        double lngRad = std::atan2(y, x);

        double sinLat = std::sin(latRad);
        double N = A / std::sqrt(1.0 - E2 * sinLat * sinLat);
        double alt = p / std::cos(latRad) - N;

        return GeodeticCoord{
            .latDeg = latRad * RAD_TO_DEG,
            .lngDeg = lngRad * RAD_TO_DEG,
            .altitudeMeters = alt
        };
    }

    /**
     * Transform ECEF vector to Local Tangent Plane (ENU - East, North, Up) relative to a reference coordinate.
     */
    inline Vec3 ecefToENU(const Vec3& ecefPoint, const Vec3& ecefOrigin, double refLatDeg, double refLngDeg) {
        double latRad = refLatDeg * DEG_TO_RAD;
        double lngRad = refLngDeg * DEG_TO_RAD;

        double sinLat = std::sin(latRad);
        double cosLat = std::cos(latRad);
        double sinLng = std::sin(lngRad);
        double cosLng = std::cos(lngRad);

        double dx = static_cast<double>(ecefPoint.x - ecefOrigin.x);
        double dy = static_cast<double>(ecefPoint.y - ecefOrigin.y);
        double dz = static_cast<double>(ecefPoint.z - ecefOrigin.z);

        // Rotation matrix from ECEF to ENU
        double east  = -sinLng * dx + cosLng * dy;
        double north = -sinLat * cosLng * dx - sinLat * sinLng * dy + cosLat * dz;
        double up    =  cosLat * cosLng * dx + cosLat * sinLng * dy + sinLat * dz;

        return Vec3(static_cast<float>(east), static_cast<float>(north), static_cast<float>(up));
    }

    /**
     * Convert Local Tangent Plane (ENU) to Three.js coordinates (X=East, Y=Up, Z=-North).
     */
    inline Vec3 enuToThreeJS(const Vec3& enu) {
        return Vec3(enu.x, enu.z, -enu.y);
    }
} // namespace wgs84

// ============================================================================
// Google Street View Depth Map Decoder & Point Cloud Reconstruction
// ============================================================================
struct DepthPlane {
    Vec3 normal{0.0f, 1.0f, 0.0f}; // Plane normal equation: n.x * X + n.y * Y + n.z * Z + d = 0
    float distance{0.0f};          // Signed distance from camera origin
};

struct GeoPoint3D {
    Vec3 position{0.0f, 0.0f, 0.0f};
    Vec3 color{1.0f, 1.0f, 1.0f};
    Vec3 normal{0.0f, 1.0f, 0.0f};
};

class StreetViewDepthUnprojector {
public:
    /**
     * Unproject an equirectangular panorama into a metric 3D point cloud using plane indices.
     *
     * @param planes Array of decoded DepthPlanes (plane 0 is typically sky/background)
     * @param planeIndices Array of width*height uint8/uint16 indices pointing into planes
     * @param rgbPixels Optional interleaved RGB color buffer (3 bytes per pixel)
     * @param width Image width in pixels (e.g. 512)
     * @param height Image height in pixels (e.g. 256)
     * @param maxRange Maximum distance cutoff in meters
     */
    static std::vector<GeoPoint3D> unprojectEquirectangular(
        const std::vector<DepthPlane>& planes,
        const uint8_t* planeIndices,
        const uint8_t* rgbPixels,
        int width,
        int height,
        float maxRange = 60.0f
    ) {
        std::vector<GeoPoint3D> points;
        points.reserve(width * height / 2);

        for (int y = 0; y < height; ++y) {
            float pitch = (0.5f - static_cast<float>(y) / static_cast<float>(height)) * PI; // -PI/2 to +PI/2
            float cosPitch = std::cos(pitch);
            float sinPitch = std::sin(pitch);

            for (int x = 0; x < width; ++x) {
                float yaw = (static_cast<float>(x) / static_cast<float>(width) * 2.0f - 1.0f) * PI; // -PI to +PI

                // Ray direction in camera coordinate frame (X=Right/East, Y=Up, Z=-Forward/North)
                Vec3 rayDir(
                    std::sin(yaw) * cosPitch,
                    sinPitch,
                    -std::cos(yaw) * cosPitch
                );

                int idx = y * width + x;
                uint8_t planeIdx = planeIndices[idx];
                if (planeIdx == 0 || planeIdx >= planes.size()) continue;

                const auto& plane = planes[planeIdx];
                float denom = plane.normal.dot(rayDir);
                if (std::abs(denom) < 1e-4f) continue;

                float dist = -plane.distance / denom;
                if (dist <= 0.5f || dist > maxRange) continue;

                Vec3 pos = rayDir * dist;

                Vec3 col(1.0f, 1.0f, 1.0f);
                if (rgbPixels) {
                    int pIdx = idx * 3;
                    col = Vec3(
                        rgbPixels[pIdx + 0] / 255.0f,
                        rgbPixels[pIdx + 1] / 255.0f,
                        rgbPixels[pIdx + 2] / 255.0f
                    );
                }

                points.push_back({
                    .position = pos,
                    .color = col,
                    .normal = plane.normal
                });
            }
        }

        return points;
    }
};

// ============================================================================
// High-Speed Spatial Point Cloud Filtering (Voxel Grid & Decimation)
// ============================================================================
class PointCloudFilter {
private:
    struct VoxelKey {
        int64_t x, y, z;
        bool operator==(const VoxelKey& other) const {
            return x == other.x && y == other.y && z == other.z;
        }
    };

    struct VoxelHash {
        std::size_t operator()(const VoxelKey& k) const {
            // FNV-1a 64-bit spatial hash
            uint64_t h = 14695981039346656037ull;
            h = (h ^ static_cast<uint64_t>(k.x)) * 1099511628211ull;
            h = (h ^ static_cast<uint64_t>(k.y)) * 1099511628211ull;
            h = (h ^ static_cast<uint64_t>(k.z)) * 1099511628211ull;
            return static_cast<std::size_t>(h);
        }
    };

    struct VoxelAccumulator {
        Vec3 posSum{0.0f, 0.0f, 0.0f};
        Vec3 colSum{0.0f, 0.0f, 0.0f};
        Vec3 normSum{0.0f, 0.0f, 0.0f};
        uint32_t count{0};
    };

public:
    /**
     * Voxel grid spatial decimation: reduces point cloud density uniformly.
     */
    static std::vector<GeoPoint3D> voxelGridDownsample(const std::vector<GeoPoint3D>& input, float voxelSize = 0.25f) {
        if (input.empty() || voxelSize <= 1e-4f) return input;

        float invVoxel = 1.0f / voxelSize;
        std::unordered_map<VoxelKey, VoxelAccumulator, VoxelHash> grid;
        grid.reserve(input.size() / 2);

        for (const auto& pt : input) {
            VoxelKey key{
                .x = static_cast<int64_t>(std::floor(pt.position.x * invVoxel)),
                .y = static_cast<int64_t>(std::floor(pt.position.y * invVoxel)),
                .z = static_cast<int64_t>(std::floor(pt.position.z * invVoxel))
            };

            auto& acc = grid[key];
            acc.posSum += pt.position;
            acc.colSum += pt.color;
            acc.normSum += pt.normal;
            acc.count++;
        }

        std::vector<GeoPoint3D> result;
        result.reserve(grid.size());

        for (const auto& [_, acc] : grid) {
            float invCount = 1.0f / static_cast<float>(acc.count);
            result.push_back({
                .position = acc.posSum * invCount,
                .color = acc.colSum * invCount,
                .normal = (acc.normSum * invCount).normalized()
            });
        }

        return result;
    }
};

} // namespace geospatial
} // namespace scratchbox

#endif // SCRATCHBOX_GEOSPATIAL_HPP
