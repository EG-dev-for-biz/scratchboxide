/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#ifndef SCRATCHBOX_360_GAUSSIAN_HPP
#define SCRATCHBOX_360_GAUSSIAN_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_spz.hpp"
#include <vector>
#include <cmath>
#include <algorithm>
#include <cstdint>
#include <string>
#include <iostream>

namespace scratchbox {
namespace gaussian360 {

using math::Vec2;
using math::Vec3;
using math::Quat;
using spz::GaussianSplat;
using spz::SplatCodec;

constexpr float PI = 3.14159265358979323846f;
constexpr float TWO_PI = 6.28318530717958647692f;
constexpr float HALF_PI = 1.57079632679489661923f;

/**
 * 1. Spherical Equirectangular Coordinates & Ray Calculations
 */
inline Vec3 equirectangularToRay(float yaw, float pitch) {
    float cosPitch = std::cos(pitch);
    return Vec3(
        std::sin(yaw) * cosPitch,
        std::sin(pitch),
        -std::cos(yaw) * cosPitch
    ).normalized();
}

inline Vec2 rayToEquirectangular(const Vec3& r) {
    Vec3 n = r.normalized();
    float pitch = std::asin(std::clamp(n.y, -1.0f, 1.0f));
    float yaw = std::atan2(n.x, -n.z);
    return Vec2(yaw, pitch);
}

/**
 * Compute rotation quaternion aligning unit +Z (0, 0, 1) to target surface normal
 */
inline Quat rotationFromNormal(const Vec3& normal) {
    Vec3 v0(0.0f, 0.0f, 1.0f);
    Vec3 v1 = normal.normalized();
    float dot = v0.dot(v1);

    if (dot >= 0.9999f) {
        return Quat(0.0f, 0.0f, 0.0f, 1.0f);
    }
    if (dot <= -0.9999f) {
        return Quat(0.0f, 1.0f, 0.0f, 0.0f);
    }

    Vec3 axis = v0.cross(v1);
    float s = std::sqrt((1.0f + dot) * 2.0f);
    float invs = 1.0f / s;
    return Quat(axis.x * invs, axis.y * invs, axis.z * invs, s * 0.5f).normalized();
}

/**
 * 2. World Enclosure Surface Evaluator for 360-Degree Piazza San Marco
 */
struct RayHit360 {
    Vec3 position;
    Vec3 normal;
    Vec3 color;
    Vec3 scale;
    float opacity{1.0f};
    bool valid{true};
};

inline RayHit360 evaluateSanMarco360(const Vec3& ray, const Vec3& origin = Vec3(0.0f, 1.7f, 0.0f)) {
    RayHit360 hit;

    float yaw = std::atan2(ray.x, -ray.z); // -PI to +PI (0 = North, PI/2 = East, -PI/2 = West)
    float pitch = std::asin(std::clamp(ray.y, -1.0f, 1.0f));

    // A. Ground Plaza Intersection (y = 0)
    if (ray.y < -0.01f) {
        float tGround = (0.0f - origin.y) / ray.y;
        if (tGround > 0.0f) {
            Vec3 pGround = origin + ray * tGround;
            // Ground extends out to surrounding facades (~36m radius)
            float rDist = std::sqrt(pGround.x * pGround.x + pGround.z * pGround.z);
            if (rDist < 36.0f) {
                hit.position = pGround;
                hit.normal = Vec3(0.0f, 1.0f, 0.0f);

                // Piazza San Marco classical geometric marble pavement pattern
                float gridX = std::fmod(std::abs(pGround.x) + 100.0f, 3.2f);
                float gridZ = std::fmod(std::abs(pGround.z) + 100.0f, 3.2f);
                bool isWhiteMarbleBand = (gridX < 0.45f || gridZ < 0.45f);

                // Radial cobblestone micro-relief
                float radialNoise = std::sin(rDist * 4.0f) * 0.04f;
                hit.position.y += radialNoise;

                if (isWhiteMarbleBand) {
                    hit.color = Vec3(0.88f, 0.86f, 0.80f); // White Istrian stone
                } else {
                    hit.color = Vec3(0.35f, 0.33f, 0.31f); // Dark volcanic trachyte tiles
                }

                float splatSize = std::max(0.035f, tGround * 0.009f);
                hit.scale = Vec3(splatSize * 1.4f, splatSize * 1.4f, splatSize * 0.35f);
                return hit;
            }
        }
    }

    // B. Central Parallax Foreground Element: Classical Marble Fountain & Pedestals
    // Central fountain centered at (x=0, z=-6.0), radius=1.6m, height=1.6m
    Vec3 fCenter(0.0f, 0.8f, -6.0f);
    Vec3 toF = fCenter - origin;
    float proj = toF.dot(ray);
    if (proj > 0.0f) {
        Vec3 closest = origin + ray * proj;
        float dF = (closest - fCenter).length();
        if (dF < 1.6f && closest.y >= 0.0f && closest.y <= 1.8f) {
            hit.position = closest;
            hit.normal = (closest - fCenter).normalized();
            hit.color = Vec3(0.82f, 0.78f, 0.72f); // Carved Verona marble
            hit.scale = Vec3(0.04f, 0.04f, 0.02f);
            return hit;
        }
    }

    // C. Surrounding Cardinal Sectors
    // 1. North Sector: St. Mark's Basilica (z = -28.0m, x in [-24, 24])
    if (yaw >= -PI * 0.28f && yaw <= PI * 0.28f && ray.z < -0.05f) {
        float tNorth = (-28.0f - origin.z) / ray.z;
        if (tNorth > 0.0f) {
            Vec3 p = origin + ray * tNorth;
            if (p.x >= -24.0f && p.x <= 24.0f && p.y >= 0.0f && p.y <= 38.0f) {
                hit.position = p;
                hit.normal = Vec3(0.0f, 0.0f, 1.0f);

                // Five arched portal recesses
                float archX = std::fmod(std::abs(p.x) + 24.0f, 9.6f) - 4.8f;
                float archH = 12.0f - (archX * archX) * 0.35f;
                bool insideArch = (p.y <= archH && archH > 3.0f);

                // Byzantine Cupola Domes (y > 22m)
                bool isDome = (p.y > 22.0f);

                if (insideArch && p.y < 11.0f) {
                    hit.position.z -= 1.8f; // Recessed portal portico
                    hit.color = Vec3(0.92f, 0.78f, 0.35f); // Golden Byzantine mosaic lunette
                } else if (isDome) {
                    hit.position.z -= std::sin((p.y - 22.0f) * 0.18f) * 3.5f;
                    hit.color = Vec3(0.42f, 0.62f, 0.54f); // Aged copper patina domes
                } else {
                    // Classical marble facade with colonnade relief
                    float columnRelief = std::sin(p.x * 6.0f) * 0.25f;
                    hit.position.z += columnRelief;
                    hit.color = Vec3(0.82f, 0.77f, 0.70f); // Warm Istrian limestone
                }

                float splatSize = tNorth * 0.008f;
                hit.scale = Vec3(splatSize * 1.5f, splatSize * 1.5f, splatSize * 0.3f);
                return hit;
            }
        }
    }

    // 2. East Sector: St. Mark's Campanile Belltower (x = +24.0m, z in [-18, 2], height up to 62m)
    if (yaw >= PI * 0.20f && yaw <= PI * 0.65f && ray.x > 0.05f) {
        float tEast = (24.0f - origin.x) / ray.x;
        if (tEast > 0.0f) {
            Vec3 p = origin + ray * tEast;
            if (p.z >= -16.0f && p.z <= 4.0f && p.y >= 0.0f && p.y <= 62.0f) {
                hit.position = p;
                hit.normal = Vec3(-1.0f, 0.0f, 0.0f);

                if (p.y > 48.0f) {
                    // Belfry pyramid spire & golden angel
                    hit.color = Vec3(0.55f, 0.68f, 0.60f); // Verdigris roof
                } else if (p.y > 38.0f) {
                    // Open marble belfry arcade
                    hit.color = Vec3(0.90f, 0.88f, 0.84f); // White marble arches
                } else {
                    // Tower shaft: fluted red terracotta brick
                    float brickGroove = std::sin(p.z * 12.0f) * 0.15f;
                    hit.position.x += brickGroove;
                    hit.color = Vec3(0.72f, 0.38f, 0.28f); // Terracotta brick
                }

                float splatSize = tEast * 0.008f;
                hit.scale = Vec3(splatSize * 1.5f, splatSize * 1.5f, splatSize * 0.3f);
                return hit;
            }
        }
    }

    // 3. South Sector: Doge's Palace & Piazzetta Opening to Lagoon (z = +26.0m)
    if ((yaw >= PI * 0.65f || yaw <= -PI * 0.65f) && ray.z > 0.05f) {
        float tSouth = (26.0f - origin.z) / ray.z;
        if (tSouth > 0.0f) {
            Vec3 p = origin + ray * tSouth;
            if (p.x >= -24.0f && p.x <= 24.0f && p.y >= 0.0f && p.y <= 32.0f) {
                hit.position = p;
                hit.normal = Vec3(0.0f, 0.0f, -1.0f);

                // Venetian Gothic Palace: two-tiered open arcades & pink Verona diamond pattern
                if (p.y <= 8.0f) {
                    // Ground Gothic portico arcade
                    hit.position.z += 1.2f;
                    hit.color = Vec3(0.85f, 0.82f, 0.76f);
                } else if (p.y <= 16.0f) {
                    // Loggia arches with quatrefoil tracery
                    hit.color = Vec3(0.88f, 0.85f, 0.80f);
                } else {
                    // Upper wall: pink Verona marble and white Istrian diamond diaper pattern
                    float diaper = std::sin((p.x + p.y) * 4.0f) * std::sin((p.x - p.y) * 4.0f);
                    if (diaper > 0.0f) {
                        hit.color = Vec3(0.86f, 0.64f, 0.62f); // Venetian pink marble
                    } else {
                        hit.color = Vec3(0.92f, 0.90f, 0.86f); // White Istrian stone
                    }
                }

                float splatSize = tSouth * 0.008f;
                hit.scale = Vec3(splatSize * 1.5f, splatSize * 1.5f, splatSize * 0.3f);
                return hit;
            }
        }
    }

    // 4. West Sector: Procuratie Vecchie Classical Arcade (x = -24.0m)
    if (yaw >= -PI * 0.65f && yaw <= -PI * 0.20f && ray.x < -0.05f) {
        float tWest = (-24.0f - origin.x) / ray.x;
        if (tWest > 0.0f) {
            Vec3 p = origin + ray * tWest;
            if (p.z >= -30.0f && p.z <= 26.0f && p.y >= 0.0f && p.y <= 24.0f) {
                hit.position = p;
                hit.normal = Vec3(1.0f, 0.0f, 0.0f);

                // 3 stories of uniform renaissance arches with outdoor café awnings
                if (p.y <= 5.5f) {
                    // Ground covered walkway arcade with warm café lights
                    hit.position.x -= 1.4f;
                    hit.color = Vec3(0.95f, 0.72f, 0.40f); // Warm incandescent café lantern glow
                } else {
                    // Upper classical pilasters and cornices
                    float pilaster = std::sin(p.z * 5.0f) * 0.2f;
                    hit.position.x += pilaster;
                    hit.color = Vec3(0.84f, 0.81f, 0.76f); // Renaissance limestone
                }

                float splatSize = tWest * 0.008f;
                hit.scale = Vec3(splatSize * 1.5f, splatSize * 1.5f, splatSize * 0.3f);
                return hit;
            }
        }
    }

    // D. Celestial Sky Dome (r = 90.0m - 120.0m)
    float skyDist = 95.0f + std::max(0.0f, ray.y) * 25.0f;
    hit.position = origin + ray * skyDist;
    hit.normal = -ray; // Normal faces inward to observer

    // Azure sky gradient with warm horizon and gentle clouds
    float sunDot = std::max(0.0f, ray.dot(Vec3(0.45f, 0.65f, -0.60f).normalized()));
    float skyT = std::clamp(ray.y, 0.0f, 1.0f);

    Vec3 zenithColor(0.25f, 0.48f, 0.88f);  // Deep Venetian sky
    Vec3 horizonColor(0.82f, 0.88f, 0.94f); // Soft atmospheric haze
    Vec3 skyBase = horizonColor * (1.0f - skyT) + zenithColor * skyT;

    // Cumulus clouds in upper sky
    float cloudNoise = std::sin(ray.x * 14.0f) * std::cos(ray.z * 14.0f);
    if (ray.y > 0.18f && cloudNoise > 0.35f) {
        skyBase = skyBase * 0.4f + Vec3(0.96f, 0.97f, 1.0f) * 0.6f;
    }

    // Solar disk glow
    skyBase = skyBase + Vec3(1.0f, 0.92f, 0.70f) * std::pow(sunDot, 16.0f) * 0.85f;

    hit.color = skyBase;
    float splatSize = skyDist * 0.016f;
    hit.scale = Vec3(splatSize * 1.6f, splatSize * 1.6f, splatSize * 0.4f);

    return hit;
}

/**
 * 3. Procedural 360 Generator Core Class
 */
class Gaussian360Generator {
public:
    /**
     * Generates a dense, omnidirectional 360-degree Gaussian splat world
     * with numYaw azimuthal divisions and numPitch elevation divisions.
     */
    static std::vector<GaussianSplat> generateSanMarcoWorld(size_t numYaw = 1024, size_t numPitch = 512) {
        std::vector<GaussianSplat> splats;
        splats.reserve(numYaw * numPitch / 2);

        Vec3 eyePos(0.0f, 1.7f, 0.0f);

        for (size_t py = 0; py < numPitch; ++py) {
            // Elevation pitch from -85 deg (-1.48 rad) to +85 deg (+1.48 rad)
            float v = static_cast<float>(py) / static_cast<float>(numPitch - 1);
            float pitch = (0.5f - v) * PI * 0.94f; // Top to bottom

            for (size_t px = 0; px < numYaw; ++px) {
                // Azimuth yaw from -PI to +PI
                float u = static_cast<float>(px) / static_cast<float>(numYaw);
                float yaw = (u * 2.0f - 1.0f) * PI;

                Vec3 ray = equirectangularToRay(yaw, pitch);
                RayHit360 hit = evaluateSanMarco360(ray, eyePos);
                if (!hit.valid) continue;

                GaussianSplat s;
                s.position = hit.position;
                s.scale = hit.scale;
                s.rotation = rotationFromNormal(hit.normal);
                s.color = hit.color;
                s.opacity = hit.opacity;

                splats.push_back(s);
            }
        }

        return splats;
    }

    /**
     * Cyber Shibuya 360 Crossroads Generator
     */
    static std::vector<GaussianSplat> generateCyberShibuyaWorld(size_t numYaw = 1024, size_t numPitch = 512) {
        std::vector<GaussianSplat> splats;
        splats.reserve(numYaw * numPitch / 2);

        Vec3 eyePos(0.0f, 1.7f, 0.0f);

        for (size_t py = 0; py < numPitch; ++py) {
            float v = static_cast<float>(py) / static_cast<float>(numPitch - 1);
            float pitch = (0.5f - v) * PI * 0.94f;

            for (size_t px = 0; px < numYaw; ++px) {
                float u = static_cast<float>(px) / static_cast<float>(numYaw);
                float yaw = (u * 2.0f - 1.0f) * PI;

                Vec3 ray = equirectangularToRay(yaw, pitch);

                GaussianSplat s;
                s.opacity = 1.0f;

                // Wet asphalt ground
                if (ray.y < -0.02f) {
                    float t = (0.0f - eyePos.y) / ray.y;
                    if (t < 40.0f) {
                        s.position = eyePos + ray * t;
                        s.rotation = rotationFromNormal(Vec3(0, 1, 0));

                        // Shibuya famous scramble crosswalk stripes
                        bool isCrosswalk = (std::fmod(std::abs(s.position.x) + 20.0f, 3.0f) < 1.4f &&
                                            std::abs(s.position.z) < 18.0f);
                        if (isCrosswalk) {
                            s.color = Vec3(0.92f, 0.92f, 0.96f);
                        } else {
                            // Wet dark asphalt with cyan/magenta neon reflection
                            s.color = Vec3(0.08f, 0.12f, 0.16f);
                        }
                        float sz = std::max(0.04f, t * 0.008f);
                        s.scale = Vec3(sz * 1.4f, sz * 1.4f, sz * 0.35f);
                        splats.push_back(s);
                        continue;
                    }
                }

                // 4 Corner Towers with Curved LED Billboards
                float cornerDist = 22.0f;
                float tTower = cornerDist / std::sqrt(ray.x * ray.x + ray.z * ray.z);
                Vec3 p = eyePos + ray * tTower;

                if (p.y >= 0.0f && p.y <= 65.0f) {
                    s.position = p;
                    Vec3 wallNormal = Vec3(-ray.x, 0.0f, -ray.z).normalized();
                    s.rotation = rotationFromNormal(wallNormal);

                    // Massive Cyber LED screens
                    if (p.y >= 8.0f && p.y <= 38.0f) {
                        float billboardWave = std::sin(yaw * 8.0f + p.y * 0.5f);
                        if (billboardWave > 0.0f) {
                            s.color = Vec3(0.15f, 0.85f, 0.98f); // Cyber Cyan
                        } else {
                            s.color = Vec3(0.98f, 0.18f, 0.65f); // Neon Magenta
                        }
                    } else {
                        // Dark glass curtain wall with glowing window grid
                        s.color = Vec3(0.12f, 0.16f, 0.22f);
                        if (std::fmod(p.y, 2.4f) < 0.4f) {
                            s.color = s.color + Vec3(0.4f, 0.5f, 0.6f);
                        }
                    }
                    float sz = tTower * 0.008f;
                    s.scale = Vec3(sz * 1.5f, sz * 1.5f, sz * 0.3f);
                    splats.push_back(s);
                    continue;
                }

                // Night sky with cyberpunk smog and searchlight beams
                float skyDist = 85.0f;
                s.position = eyePos + ray * skyDist;
                s.rotation = rotationFromNormal(-ray);
                s.color = Vec3(0.04f, 0.06f, 0.12f); // Deep indigo night sky
                float sz = skyDist * 0.015f;
                s.scale = Vec3(sz * 1.5f, sz * 1.5f, sz * 0.4f);
                splats.push_back(s);
            }
        }

        return splats;
    }
};

} // namespace gaussian360
} // namespace scratchbox

#endif // SCRATCHBOX_360_GAUSSIAN_HPP
