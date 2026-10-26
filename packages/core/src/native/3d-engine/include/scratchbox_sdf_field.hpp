/********************************************************************************
 * Scratchbox SDF Field Graphs
 *
 * A signed distance field as an immutable expression graph (primitives, transforms, sharp or
 * smooth booleans, surface modifiers and domain warps) that native code evaluates in bulk, so
 * scripts can describe a shape once and mesh it at any resolution without per-point calls back
 * into Python. Negative is inside. Warps and displacement are not exact distances, so meshing
 * projects vertices along the gradient rather than trusting the value as a distance.
 ********************************************************************************/

#ifndef SCRATCHBOX_SDF_FIELD_HPP
#define SCRATCHBOX_SDF_FIELD_HPP

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_sdf.hpp"
#include <memory>
#include <functional>
#include <algorithm>
#include <cmath>
#include <string>
#include <stdexcept>

namespace scratchbox {
namespace sdf {

class Field {
public:
    using Eval = std::function<float(const Vec3&)>;

    Field() : eval_(std::make_shared<Eval>([](const Vec3&) { return 1e9f; })) {}
    explicit Field(Eval eval) : eval_(std::make_shared<Eval>(std::move(eval))) {}

    float operator()(const Vec3& p) const { return (*eval_)(p); }

    // Primitives (sizes are full extents unless named as radii).
    static Field sphere(float radius) { return Field([radius](const Vec3& p) { return sdSphere(p, radius); }); }
    static Field box(const Vec3& size) {
        Vec3 h = size * 0.5f;
        return Field([h](const Vec3& p) { return sdBox(p, h); });
    }
    static Field roundBox(const Vec3& size, float radius) {
        Vec3 h = size * 0.5f - Vec3(radius, radius, radius);
        return Field([h, radius](const Vec3& p) { return sdRoundBox(p, h, radius); });
    }
    static Field torus(float majorRadius, float minorRadius) {
        return Field([majorRadius, minorRadius](const Vec3& p) { return sdTorus(p, majorRadius, minorRadius); });
    }
    static Field cylinder(float radius, float height) {
        return Field([radius, height](const Vec3& p) { return sdCylinder(p, radius, height); });
    }
    static Field capsule(const Vec3& a, const Vec3& b, float radius) {
        return Field([a, b, radius](const Vec3& p) { return sdCapsule(p, a, b, radius); });
    }
    static Field ellipsoid(const Vec3& radii) {
        // Bound-preserving approximation (Quilez): exact on the axes, close elsewhere.
        return Field([radii](const Vec3& p) {
            float k0 = Vec3(p.x / radii.x, p.y / radii.y, p.z / radii.z).length();
            float k1 = Vec3(p.x / (radii.x * radii.x), p.y / (radii.y * radii.y), p.z / (radii.z * radii.z)).length();
            return k1 > 1e-8f ? k0 * (k0 - 1.0f) / k1 : -std::min({radii.x, radii.y, radii.z});
        });
    }
    static Field plane(const Vec3& normal, float offset) {
        Vec3 n = normal.normalized();
        return Field([n, offset](const Vec3& p) { return p.dot(n) - offset; });
    }
    static Field gyroid(float scale, float thickness) {
        return Field([scale, thickness](const Vec3& p) { return sdGyroid(p, scale, thickness); });
    }

    // Booleans; k > 0 blends over that distance.
    Field unite(const Field& o, float k = 0.0f) const {
        Field a = *this, b = o;
        return Field([a, b, k](const Vec3& p) { return k > 0.0f ? opSmoothUnion(a(p), b(p), k) : opUnion(a(p), b(p)); });
    }
    Field subtract(const Field& o, float k = 0.0f) const {
        Field a = *this, b = o;
        // scratchbox::sdf's subtraction removes its first argument from its second.
        return Field([a, b, k](const Vec3& p) { return k > 0.0f ? opSmoothSubtraction(b(p), a(p), k) : opSubtraction(b(p), a(p)); });
    }
    Field intersect(const Field& o, float k = 0.0f) const {
        Field a = *this, b = o;
        return Field([a, b, k](const Vec3& p) { return k > 0.0f ? opSmoothIntersection(a(p), b(p), k) : opIntersection(a(p), b(p)); });
    }

    // Transforms of the shape (applied as inverse transforms of the query point).
    Field translate(const Vec3& t) const {
        Field a = *this;
        return Field([a, t](const Vec3& p) { return a(p - t); });
    }
    Field rotate(const Vec3& axis, float degrees) const {
        Field a = *this;
        math::Quat inv = math::Quat::fromAxisAngle(axis.normalized(), -degrees * math::DEG_TO_RAD);
        return Field([a, inv](const Vec3& p) { return a(inv.rotate(p)); });
    }
    Field scale(float s) const {
        if (!(s > 0.0f) || !std::isfinite(s)) throw std::invalid_argument("sdf scale factor must be a positive number, got " + std::to_string(s));
        Field a = *this;
        return Field([a, s](const Vec3& p) { return a(p / s) * s; });
    }

    // Surface modifiers.
    Field round(float radius) const {
        Field a = *this;
        return Field([a, radius](const Vec3& p) { return a(p) - radius; });
    }
    Field shell(float thickness) const {
        Field a = *this;
        return Field([a, thickness](const Vec3& p) { return std::abs(a(p)) - thickness * 0.5f; });
    }
    Field displace(float amplitude, float frequency, uint32_t seed = 7) const {
        Field a = *this;
        return Field([a, amplitude, frequency, seed](const Vec3& p) {
            float n = math::FastNoise3D::perlin(p.x * frequency, p.y * frequency, p.z * frequency, seed) +
                      0.5f * math::FastNoise3D::perlin(p.x * frequency * 2.0f, p.y * frequency * 2.0f, p.z * frequency * 2.0f, seed + 1);
            return a(p) + amplitude * n;
        });
    }

    // Domain warps.
    Field twist(float radiansPerUnit) const {
        Field a = *this;
        return Field([a, radiansPerUnit](const Vec3& p) { return a(opTwist(p, radiansPerUnit)); });
    }
    Field bend(float radiansPerUnit) const {
        Field a = *this;
        return Field([a, radiansPerUnit](const Vec3& p) { return a(opBend(p, radiansPerUnit)); });
    }
    Field repeat(const Vec3& period) const {
        Field a = *this;
        return Field([a, period](const Vec3& p) {
            auto wrap = [](float x, float c) { return c > 0.0f ? x - c * std::round(x / c) : x; };
            return a(Vec3(wrap(p.x, period.x), wrap(p.y, period.y), wrap(p.z, period.z)));
        });
    }
    Field mirror(const Vec3& normal) const {
        Field a = *this;
        Vec3 n = normal.normalized();
        return Field([a, n](const Vec3& p) {
            float d = p.dot(n);
            return a(d < 0.0f ? p - n * (2.0f * d) : p);
        });
    }

    /**
     * Mesh the surface inside [boundsMin, boundsMax] with cubic cells: `resolution` cells along the
     * longest side. The field is intersected with the bounds box, so a shape the bounds cut is capped
     * exactly on the bounds (the grid is padded by two cells so the cap is inside the sampled volume).
     * Hard booleans make mathematically sharp creases, which any grid mesher can only staircase; blend
     * them (k > 0) for clean edges. Features thinner than a cell cannot be meshed: `droppedCells`
     * receives how many cells held one, and an empty result throws.
     */
    geometry::ScratchboxMesh toMesh(const Vec3& boundsMin, const Vec3& boundsMax, int resolution = 128,
                                    int projectionSteps = 2, const std::string& name = "SdfMesh",
                                    int* droppedCells = nullptr, float* cellSize = nullptr) const {
        Vec3 size = boundsMax - boundsMin;
        if (!(size.x > 0.0f) || !(size.y > 0.0f) || !(size.z > 0.0f)) throw std::invalid_argument("to_mesh bounds must have bounds_min < bounds_max on every axis");
        float longest = std::max({size.x, size.y, size.z, 1e-6f});
        int res = std::clamp(resolution, 8, 1024);
        float cell = longest / res;
        Vec3 lo = boundsMin - Vec3(cell, cell, cell) * 2.0f, hi = boundsMax + Vec3(cell, cell, cell) * 2.0f;
        Vec3 padded = hi - lo;
        int nx = std::max(1, static_cast<int>(std::ceil(padded.x / cell)));
        int ny = std::max(1, static_cast<int>(std::ceil(padded.y / cell)));
        int nz = std::max(1, static_cast<int>(std::ceil(padded.z / cell)));
        hi = lo + Vec3(nx * cell, ny * cell, nz * cell);
        if (cellSize) *cellSize = cell;
        Field f = *this;
        const Vec3 centre = (boundsMin + boundsMax) * 0.5f, half = size * 0.5f;
        auto clipped = [f, centre, half](const Vec3& p) { return std::max(f(p), sdBox(p - centre, half)); };
        geometry::ScratchboxMesh mesh = geometry::IsosurfaceExtractor::extract(clipped, math::AABB(lo, hi), nx, ny, nz,
                                              0.0f, projectionSteps, true, math::Vec4(0.8f, 0.8f, 0.8f, 1.0f), name, droppedCells);
        if (mesh.indices.empty()) {
            throw std::runtime_error("to_mesh produced no surface: no grid point of the " + std::to_string(nx) + " x " + std::to_string(ny) + " x " +
                std::to_string(nz) + " grid (cell " + std::to_string(cell) + " m) is inside the field within the bounds; the shape is outside "
                "the bounds or thinner than a cell (raise resolution)");
        }
        return mesh;
    }

private:
    std::shared_ptr<Eval> eval_;
};

} // namespace sdf
} // namespace scratchbox

#endif // SCRATCHBOX_SDF_FIELD_HPP
