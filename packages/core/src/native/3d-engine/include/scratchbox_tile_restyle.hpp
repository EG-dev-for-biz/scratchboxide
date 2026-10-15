/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_TILE_RESTYLE_HPP
#define SCRATCHBOX_TILE_RESTYLE_HPP

/**
 * Restyles a real photogrammetric tile from continuous fields only.
 *
 * There are no style names. A restyle is two lists of numbers:
 *
 *  - Fields edit the tile's own vertices inside a radius with a smooth falloff: raise or sink,
 *    pull toward a level, quantise into terraces, and isoparametric normal relief (a travelling
 *    wave of amplitude A and wavelength L along a heading). Positions change in world space; the
 *    caller writes them back with the texture-preserving GLB patcher, so photo textures survive.
 *  - Forms add new geometry built from three of the universal operators, with the fourth
 *    (affine replication) applicable to any of them:
 *      revolve   harmonic solid of revolution: radial profile r(z), K lobes of relative amplitude a,
 *                helical twist in turns over the height
 *      sweep     a circular profile swept along a polyline with linear radius taper and twist
 *      replicate copies the form around a ring (count, radius) or along a segment (count, step)
 *    Forms are placed on the tile's top surface unless told otherwise.
 *
 * Horizontal placement uses tile-normalised coordinates (u, v) in [-1, 1] across the tile's XZ
 * bounds, so the caller does not need the tile's absolute frame. Heights are metres above the
 * local surface. Every parameter is a continuous quantity; nothing branches on a name.
 */

#include "scratchbox_engine.hpp"
#include "scratchbox_gltf_scene.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <string>
#include <vector>

namespace scratchbox {
namespace restyle {

using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::PbrMaterial;
using geometry::ScratchboxMesh;
using geometry::Vertex;

struct Field {
    Vec2 center{0.0f, 0.0f};          // tile-normalised (u, v)
    float radiusMeters{10.0f};
    float blendMeters{4.0f};           // falloff width outside the radius
    float offsetMeters{0.0f};          // +raise / -sink
    bool hasLevel{false};
    float levelMeters{0.0f};           // target height above the tile datum
    float levelWeight{1.0f};           // 0..1 pull toward levelMeters
    float terraceStepMeters{0.0f};     // 0 = off
    float reliefAmplitudeMeters{0.0f}; // 0 = off
    float reliefWavelengthMeters{2.0f};
    float reliefHeadingDeg{0.0f};      // wave travel direction, clockwise from +Z
};

struct Replication {
    int count{1};
    float ringRadiusMeters{0.0f};      // > 0: around a ring centred on the form
    Vec2 stepMeters{0.0f, 0.0f};       // otherwise: straight row with this XZ step
};

struct FormMaterial {
    Vec3 albedo{0.62f, 0.60f, 0.57f};
    float roughness{0.8f};
    float metalness{0.0f};
    Vec3 emissive{0.0f, 0.0f, 0.0f};
};

/** The seed is a sweep when `path` has two or more points, otherwise a revolve of `profile`. */
struct Form {
    Vec2 center{0.0f, 0.0f};           // tile-normalised placement of the seed origin
    float baseOffsetMeters{0.0f};      // above the surface (or above the datum when !groundSnap)
    bool groundSnap{true};
    float rotationYDeg{0.0f};
    // revolve
    std::vector<Vec2> profile;         // (radius m, height m), bottom to top
    int segments{48};
    int lobes{0};
    float lobeAmplitude{0.0f};         // relative radius modulation
    float helixTurns{0.0f};
    // sweep (path in metres relative to the seed origin)
    std::vector<Vec3> path;
    float radiusStartMeters{0.3f};
    float radiusEndMeters{0.3f};
    int sides{12};
    float twistTurns{0.0f};
    Replication replicate;
    FormMaterial material;
};

struct Config {
    std::vector<Field> fields;
    std::vector<Form> forms;
};

struct Stats {
    size_t vertexCount{0};
    size_t movedVertices{0};
    float maxDisplacementMeters{0.0f};
    size_t formMeshes{0};
    size_t formVertices{0};
    size_t formTriangles{0};
    float datumY{0.0f};
    math::AABB bounds;
};

/** Top-surface height lookup over a regular XZ grid (max Y per cell, holes filled outward). */
class SurfaceGrid {
public:
    SurfaceGrid(const std::vector<float>& xyz, const math::AABB& b, float cellMeters) : bounds(b) {
        cell = std::max(0.25f, cellMeters);
        nx = std::max(1, static_cast<int>(std::ceil((b.max.x - b.min.x) / cell)));
        nz = std::max(1, static_cast<int>(std::ceil((b.max.z - b.min.z) / cell)));
        top.assign(static_cast<size_t>(nx) * nz, -std::numeric_limits<float>::infinity());
        for (size_t i = 0; i + 2 < xyz.size(); i += 3) {
            const int cx = clampX(xyz[i]), cz = clampZ(xyz[i + 2]);
            float& t = top[static_cast<size_t>(cz) * nx + cx];
            t = std::max(t, xyz[i + 1]);
        }
        // Fill empty cells from filled neighbours so placement never reads -inf.
        for (int pass = 0; pass < nx + nz; ++pass) {
            bool changed = false;
            std::vector<float> next = top;
            for (int z = 0; z < nz; ++z) for (int x = 0; x < nx; ++x) {
                float& t = next[static_cast<size_t>(z) * nx + x];
                if (std::isfinite(t)) continue;
                float best = -std::numeric_limits<float>::infinity();
                for (int dz = -1; dz <= 1; ++dz) for (int dx = -1; dx <= 1; ++dx) {
                    const int xx = x + dx, zz = z + dz;
                    if (xx < 0 || zz < 0 || xx >= nx || zz >= nz) continue;
                    best = std::max(best, top[static_cast<size_t>(zz) * nx + xx]);
                }
                if (std::isfinite(best)) { t = best; changed = true; }
            }
            top.swap(next);
            if (!changed) break;
        }
    }

    float heightAt(float x, float z) const {
        const float h = top[static_cast<size_t>(clampZ(z)) * nx + clampX(x)];
        return std::isfinite(h) ? h : bounds.min.y;
    }

private:
    math::AABB bounds;
    float cell{1.0f};
    int nx{1}, nz{1};
    std::vector<float> top;
    int clampX(float x) const { return std::clamp(static_cast<int>((x - bounds.min.x) / cell), 0, nx - 1); }
    int clampZ(float z) const { return std::clamp(static_cast<int>((z - bounds.min.z) / cell), 0, nz - 1); }
};

class TileRestyler {
public:
    /** Maps tile-normalised (u, v) to world XZ. */
    static Vec2 toWorldXZ(const math::AABB& b, const Vec2& uv) {
        const float cx = 0.5f * (b.min.x + b.max.x), cz = 0.5f * (b.min.z + b.max.z);
        return Vec2(cx + uv.x * 0.5f * (b.max.x - b.min.x), cz + uv.y * 0.5f * (b.max.z - b.min.z));
    }

    /** Ground datum: the 5th-percentile vertex height, robust to stray low points. */
    static float datum(const std::vector<float>& xyz) {
        std::vector<float> ys;
        ys.reserve(xyz.size() / 3);
        for (size_t i = 1; i < xyz.size(); i += 3) ys.push_back(xyz[i]);
        if (ys.empty()) return 0.0f;
        const size_t k = ys.size() / 20;
        std::nth_element(ys.begin(), ys.begin() + static_cast<long>(k), ys.end());
        return ys[k];
    }

    /**
     * Applies every field to world-space positions `xyz` (with per-vertex normals `nrm`, same
     * layout) in place. Fields compose in order.
     */
    static void applyFields(std::vector<float>& xyz, const std::vector<float>& nrm, const math::AABB& b,
                            float datumY, const std::vector<Field>& fields, Stats& stats) {
        const std::vector<float> original = xyz;
        for (const Field& f : fields) {
            const Vec2 c = toWorldXZ(b, f.center);
            const float reach = f.radiusMeters + std::max(0.0f, f.blendMeters);
            const float headingRad = f.reliefHeadingDeg * static_cast<float>(M_PI) / 180.0f;
            const Vec2 dir(std::sin(headingRad), std::cos(headingRad));
            const float k = (f.reliefWavelengthMeters > 1e-3f) ? 2.0f * static_cast<float>(M_PI) / f.reliefWavelengthMeters : 0.0f;
            for (size_t i = 0; i + 2 < xyz.size(); i += 3) {
                const float dx = xyz[i] - c.x, dz = xyz[i + 2] - c.y;
                const float d = std::sqrt(dx * dx + dz * dz);
                if (d >= reach) continue;
                const float w = weight(d, f.radiusMeters, f.blendMeters);
                if (w <= 0.0f) continue;

                float y = xyz[i + 1];
                if (f.hasLevel) {
                    const float target = datumY + f.levelMeters;
                    y += (target - y) * std::clamp(f.levelWeight, 0.0f, 1.0f) * w;
                }
                if (f.terraceStepMeters > 1e-3f) {
                    const float rel = y - datumY;
                    const float stepped = datumY + std::floor(rel / f.terraceStepMeters) * f.terraceStepMeters;
                    y += (stepped - y) * w;
                }
                y += f.offsetMeters * w;
                xyz[i + 1] = y;

                if (f.reliefAmplitudeMeters != 0.0f && k > 0.0f && i + 2 < nrm.size()) {
                    const float phase = k * (xyz[i] * dir.x + xyz[i + 2] * dir.y);
                    const float h = f.reliefAmplitudeMeters * std::sin(phase) * w;
                    xyz[i] += nrm[i] * h;
                    xyz[i + 1] += nrm[i + 1] * h;
                    xyz[i + 2] += nrm[i + 2] * h;
                }
            }
        }
        for (size_t i = 0; i + 2 < xyz.size(); i += 3) {
            const float dx = xyz[i] - original[i], dy = xyz[i + 1] - original[i + 1], dz = xyz[i + 2] - original[i + 2];
            const float m = std::sqrt(dx * dx + dy * dy + dz * dz);
            if (m > 1e-5f) {
                ++stats.movedVertices;
                stats.maxDisplacementMeters = std::max(stats.maxDisplacementMeters, m);
            }
        }
    }

    /** Builds every form (with replication), placed in world space on the tile. */
    static std::vector<ScratchboxMesh> buildForms(const std::vector<Form>& forms, const math::AABB& b,
                                                  const SurfaceGrid& surface, float datumY, Stats& stats) {
        std::vector<ScratchboxMesh> out;
        for (size_t fi = 0; fi < forms.size(); ++fi) {
            const Form& form = forms[fi];
            ScratchboxMesh seed = form.path.size() >= 2 ? sweep(form) : revolve(form);
            if (seed.vertices.empty()) continue;
            seed.material = toPbr(form.material);

            const Vec2 origin = toWorldXZ(b, form.center);
            const int count = std::max(1, std::min(form.replicate.count, 512));
            ScratchboxMesh placed;
            placed.name = "restyle_form_" + std::to_string(fi);
            placed.material = seed.material;
            for (int r = 0; r < count; ++r) {
                Vec2 at = origin;
                float yaw = form.rotationYDeg * static_cast<float>(M_PI) / 180.0f;
                if (count > 1 && form.replicate.ringRadiusMeters > 0.0f) {
                    const float a = 2.0f * static_cast<float>(M_PI) * static_cast<float>(r) / static_cast<float>(count);
                    at = Vec2(origin.x + form.replicate.ringRadiusMeters * std::sin(a), origin.y + form.replicate.ringRadiusMeters * std::cos(a));
                    yaw += a;
                } else if (count > 1) {
                    at = Vec2(origin.x + form.replicate.stepMeters.x * r, origin.y + form.replicate.stepMeters.y * r);
                }
                const float baseY = (form.groundSnap ? surface.heightAt(at.x, at.y) : datumY) + form.baseOffsetMeters;
                const float cy = std::cos(yaw), sy = std::sin(yaw);
                ScratchboxMesh copy = seed;
                for (auto& v : copy.vertices) {
                    const Vec3 p = v.position, n = v.normal;
                    v.position = Vec3(at.x + p.x * cy + p.z * sy, baseY + p.y, at.y - p.x * sy + p.z * cy);
                    v.normal = Vec3(n.x * cy + n.z * sy, n.y, -n.x * sy + n.z * cy);
                }
                placed.append(copy);
            }
            placed.recomputeBounds();
            stats.formVertices += placed.vertices.size();
            stats.formTriangles += placed.indices.size() / 3;
            out.push_back(std::move(placed));
        }
        stats.formMeshes = out.size();
        return out;
    }

private:
    /** 1 inside the radius, smoothstep to 0 across the blend band. */
    static float weight(float d, float radius, float blend) {
        if (d <= radius) return 1.0f;
        if (blend <= 1e-4f) return 0.0f;
        const float t = std::clamp(1.0f - (d - radius) / blend, 0.0f, 1.0f);
        return t * t * (3.0f - 2.0f * t);
    }

    static PbrMaterial toPbr(const FormMaterial& m) {
        PbrMaterial p;
        p.name = "restyle_form";
        p.baseColorFactor = Vec4(m.albedo.x, m.albedo.y, m.albedo.z, 1.0f);
        p.roughnessFactor = std::clamp(m.roughness, 0.02f, 1.0f);
        p.metallicFactor = std::clamp(m.metalness, 0.0f, 1.0f);
        p.emissiveFactor = m.emissive;
        return p;
    }

    /** Harmonic solid of revolution around +Y with K lobes and helical twist. */
    static ScratchboxMesh revolve(const Form& f) {
        ScratchboxMesh mesh("revolve");
        const size_t rows = f.profile.size();
        const int segs = std::clamp(f.segments, 3, 256);
        if (rows < 2) return mesh;
        const float h0 = f.profile.front().y, h1 = f.profile.back().y;
        const float span = std::max(1e-4f, h1 - h0);
        for (size_t r = 0; r < rows; ++r) {
            const float t = (f.profile[r].y - h0) / span;
            const float twist = 2.0f * static_cast<float>(M_PI) * f.helixTurns * t;
            for (int s = 0; s <= segs; ++s) {
                const float a = 2.0f * static_cast<float>(M_PI) * static_cast<float>(s) / static_cast<float>(segs);
                const float lobe = 1.0f + f.lobeAmplitude * std::cos(static_cast<float>(f.lobes) * (a - twist));
                const float rad = std::max(0.0f, f.profile[r].x) * lobe;
                Vertex v;
                v.position = Vec3(rad * std::sin(a), f.profile[r].y, rad * std::cos(a));
                v.normal = Vec3(std::sin(a), 0.0f, std::cos(a));
                v.uv = Vec2(static_cast<float>(s) / segs, t);
                mesh.addVertex(v);
            }
        }
        const uint32_t ring = static_cast<uint32_t>(segs + 1);
        for (uint32_t r = 0; r + 1 < rows; ++r) {
            for (uint32_t s = 0; s < static_cast<uint32_t>(segs); ++s) {
                const uint32_t a = r * ring + s, b = a + 1, c = a + ring, d = c + 1;
                mesh.addTriangle(a, c, b);
                mesh.addTriangle(b, c, d);
            }
        }
        capRing(mesh, 0, segs, f.profile.front().y, false);
        capRing(mesh, static_cast<uint32_t>((rows - 1) * ring), segs, f.profile.back().y, true);
        mesh.recomputeSmoothNormals();
        return mesh;
    }

    /** Circular profile swept along a polyline with radius taper and twist (parallel-transport frames). */
    static ScratchboxMesh sweep(const Form& f) {
        ScratchboxMesh mesh("sweep");
        const size_t n = f.path.size();
        const int sides = std::clamp(f.sides, 3, 64);
        if (n < 2) return mesh;
        std::vector<float> arc(n, 0.0f);
        for (size_t i = 1; i < n; ++i) arc[i] = arc[i - 1] + (f.path[i] - f.path[i - 1]).length();
        const float total = std::max(1e-4f, arc.back());

        Vec3 tangent = (f.path[1] - f.path[0]).normalized();
        Vec3 normal = std::fabs(tangent.y) < 0.9f ? tangent.cross(Vec3(0, 1, 0)).normalized() : tangent.cross(Vec3(1, 0, 0)).normalized();
        for (size_t i = 0; i < n; ++i) {
            const Vec3 next = (i + 1 < n) ? (f.path[i + 1] - f.path[i]).normalized() : tangent;
            const Vec3 tNew = (i == 0 || i + 1 == n) ? next : (tangent + next).normalized();
            // Parallel transport: rotate the frame by the change in tangent.
            normal = (normal - tNew * normal.dot(tNew)).normalized();
            tangent = tNew;
            const Vec3 binormal = tangent.cross(normal).normalized();
            const float t = arc[i] / total;
            const float radius = f.radiusStartMeters + (f.radiusEndMeters - f.radiusStartMeters) * t;
            const float twist = 2.0f * static_cast<float>(M_PI) * f.twistTurns * t;
            for (int s = 0; s <= sides; ++s) {
                const float a = twist + 2.0f * static_cast<float>(M_PI) * static_cast<float>(s) / static_cast<float>(sides);
                const Vec3 dir = normal * std::cos(a) + binormal * std::sin(a);
                Vertex v;
                v.position = f.path[i] + dir * std::max(0.0f, radius);
                v.normal = dir;
                v.uv = Vec2(static_cast<float>(s) / sides, t);
                mesh.addVertex(v);
            }
        }
        const uint32_t ring = static_cast<uint32_t>(sides + 1);
        for (uint32_t i = 0; i + 1 < n; ++i) {
            for (uint32_t s = 0; s < static_cast<uint32_t>(sides); ++s) {
                const uint32_t a = i * ring + s, b = a + 1, c = a + ring, d = c + 1;
                mesh.addTriangle(a, b, c);
                mesh.addTriangle(b, d, c);
            }
        }
        mesh.recomputeSmoothNormals();
        return mesh;
    }

    static void capRing(ScratchboxMesh& mesh, uint32_t first, int segs, float y, bool up) {
        Vertex c;
        c.position = Vec3(0.0f, y, 0.0f);
        c.normal = Vec3(0.0f, up ? 1.0f : -1.0f, 0.0f);
        const uint32_t ci = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex(c);
        for (int s = 0; s < segs; ++s) {
            const uint32_t a = first + static_cast<uint32_t>(s), b = a + 1;
            if (up) mesh.addTriangle(ci, b, a); else mesh.addTriangle(ci, a, b);
        }
    }
};

} // namespace restyle
} // namespace scratchbox

#endif // SCRATCHBOX_TILE_RESTYLE_HPP
