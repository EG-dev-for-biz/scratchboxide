/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#ifndef SCRATCHBOX_LIGHT_TREE_HPP
#define SCRATCHBOX_LIGHT_TREE_HPP

/**
 * The scene's lights for next-event estimation, shared by render::PathTracer and the Metal kernels: the emissive
 * triangles of the traced geometry and the glTF punctual lights (KHR_lights_punctual). Local lights (triangles,
 * points, spots) sit in a bounding tree of power and orientation (Estevez and Kulla 2018, "Importance Sampling of
 * Many Lights with Adaptive Tree Splitting", the scheme Cycles' light tree follows); distant lights are chosen beside
 * its root. One light is picked per shading point by walking the tree with one random number, each child in
 * proportion to its importance there, so the probability of any light at any point can be recomputed (selectPdf) for
 * multiple importance sampling against the BSDF.
 *
 * The records and nodes are plain 4-byte scalars so they upload to the GPU as they are. The Metal kernels mirror
 * nodeImportance, distantImportance, pickLight, selectPdf and the point-light falloff in MSL
 * (scratchbox_metal_pathtracer_kernels.hpp): change the two together.
 */

#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_math.hpp"
#include "scratchbox_texture.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

namespace scratchbox {
namespace render {
namespace lights {

using math::AABB;
using math::Vec3;

constexpr uint32_t kNoLight = 0xFFFFFFFFu;
/** LightRecord::kind. A point light with a cone is a spot; a distant light is at infinity. */
constexpr uint32_t kTriangleLight = 0u;
constexpr uint32_t kPointLight = 1u;
constexpr uint32_t kDistantLight = 2u;

constexpr float kPi = 3.14159265358979323846f;

struct LightRecord {
    float p0[3]{0, 0, 0};
    uint32_t kind{kTriangleLight};
    /** Triangle: p1 - p0. Point and distant: the unit direction the light travels (a spot's axis). */
    float e1[3]{0, 0, 0};
    float area{0.0f};
    /** Triangle: p2 - p0, and the triangle's index in the traced index buffer (its material gives the emission). */
    float e2[3]{0, 0, 0};
    uint32_t triangle{0};
    /** Point: intensity (candela times colour). Distant: irradiance (lux times colour). Triangle: unused. */
    float intensity[3]{0, 0, 0};
    float energy{0.0f};
    /** Point: the glTF range (0: none) and the spot cone; cosOuter -1 is no cone (a point light). */
    float range{0.0f};
    float cosInner{-1.0f};
    float cosOuter{-1.0f};
    /** Local lights: the tree leaf that holds the light. */
    uint32_t leaf{0};
};
static_assert(sizeof(LightRecord) == 80, "LightRecord layout is shared with the Metal kernels");

struct LightNode {
    float bmin[3]{0, 0, 0};
    float energy{0.0f};
    float bmax[3]{0, 0, 0};
    /** Spread of the emitters' axes about `axis` (theta_o), radians. */
    float thetaO{0.0f};
    float axis[3]{0, 1, 0};
    /** Spread of emission about each emitter's axis (theta_e), radians. */
    float thetaE{0.0f};
    /** Child node indices; a leaf has child0 = -1 - light and child1 = -1. */
    int32_t child0{-1};
    int32_t child1{-1};
    int32_t parent{-1};
    uint32_t pad{0};
};
static_assert(sizeof(LightNode) == 64, "LightNode layout is shared with the Metal kernels");

struct LightSet {
    /** Local lights first (localCount of them, the tree over them at nodes[0]), then the distant lights. */
    std::vector<LightRecord> records;
    std::vector<LightNode> nodes;
    /** Per triangle of the traced index buffer: its light, or kNoLight. */
    std::vector<uint32_t> triangleLight;
    uint32_t localCount{0};
    uint32_t distantCount{0};
    uint32_t triangleLights{0};
    uint32_t pointLights{0};
    bool empty() const { return localCount + distantCount == 0; }
};

inline float luminance(const Vec3& c) { return 0.2126f * c.x + 0.7152f * c.y + 0.0722f * c.z; }
inline Vec3 vec(const float* a) { return Vec3(a[0], a[1], a[2]); }
inline void put(float* dst, const Vec3& v) { dst[0] = v.x; dst[1] = v.y; dst[2] = v.z; }

/**
 * Importance of a tree node for a shading point x with shading normal n: energy times the bounded cosines at the
 * receiver and at the emitters, over the squared distance (Estevez and Kulla's measure). Conservative: zero only
 * where no light under the node can reach the point's upper hemisphere.
 */
inline float nodeImportance(const LightNode& node, const Vec3& x, const Vec3& n) {
    if (!(node.energy > 0.0f)) return 0.0f;
    const Vec3 bmin = vec(node.bmin), bmax = vec(node.bmax);
    const Vec3 center = (bmin + bmax) * 0.5f;
    const Vec3 v = center - x;
    const float d2 = v.lengthSquared();
    const float r2 = 0.25f * (bmax - bmin).lengthSquared();
    // Inside the node's bounding sphere every direction is possible.
    if (d2 <= r2) return node.energy / std::max(r2, 1e-12f);
    const float d = std::sqrt(d2);
    const Vec3 w = v / d;
    const float thetaU = std::asin(std::min(std::sqrt(r2 / d2), 1.0f));
    const float thetaI = std::acos(std::clamp(n.dot(w), -1.0f, 1.0f));
    const float thetaIp = std::max(thetaI - thetaU, 0.0f);
    if (thetaIp >= 0.5f * kPi) return 0.0f;
    const float theta = std::acos(std::clamp(-vec(node.axis).dot(w), -1.0f, 1.0f));
    const float thetaP = std::max(theta - node.thetaO - thetaU, 0.0f);
    // Past the emission spread nothing under the node shines this way (a point light's spread is 0, its axes everywhere).
    if (thetaP > 0.0f && thetaP >= node.thetaE) return 0.0f;
    return node.energy * std::cos(thetaIp) * std::cos(std::min(thetaP, 0.5f * kPi)) / d2;
}

/** Importance of a distant light: its irradiance on the point's upper hemisphere. */
inline float distantImportance(const LightRecord& light, const Vec3& n) {
    return light.energy * std::max(0.0f, -vec(light.e1).dot(n));
}

/** glTF punctual falloff: the spot cone (KHR_lights_punctual's smooth attenuation) and the range window. */
inline float pointFalloff(const LightRecord& light, const Vec3& towardLight, float distance) {
    float f = 1.0f;
    if (light.cosOuter > -1.0f) {
        const float scale = 1.0f / std::max(0.001f, light.cosInner - light.cosOuter);
        const float cd = -vec(light.e1).dot(towardLight);
        const float s = std::clamp(cd * scale - light.cosOuter * scale, 0.0f, 1.0f);
        f *= s * s;
    }
    if (light.range > 0.0f) {
        const float q = distance / light.range;
        const float w = std::clamp(1.0f - q * q * q * q, 0.0f, 1.0f);
        f *= w * w;
    }
    return f;
}

/** Sum of the root's and the distant lights' importances: zero means no light can reach the point. */
inline float topImportance(const LightSet& set, const Vec3& x, const Vec3& n, float& rootImportance) {
    rootImportance = set.localCount > 0 ? nodeImportance(set.nodes[0], x, n) : 0.0f;
    float sum = rootImportance;
    for (uint32_t j = 0; j < set.distantCount; ++j) sum += distantImportance(set.records[set.localCount + j], n);
    return sum;
}

/** Picks a light for the point with one uniform number; returns its selection probability (0: none picked). */
inline float pickLight(const LightSet& set, const Vec3& x, const Vec3& n, float u, uint32_t& light) {
    float rootImportance;
    const float sum = topImportance(set, x, n, rootImportance);
    if (!(sum > 0.0f)) return 0.0f;
    u = std::min(u, 0.99999994f) * sum;
    if (u >= rootImportance) {
        u -= rootImportance;
        float acc = 0.0f;
        for (uint32_t j = 0; j < set.distantCount; ++j) {
            const float w = distantImportance(set.records[set.localCount + j], n);
            acc += w;
            if (u < acc || j + 1 == set.distantCount) {
                if (!(w > 0.0f)) return 0.0f;
                light = set.localCount + j;
                return w / sum;
            }
        }
        return 0.0f;
    }
    float prob = rootImportance / sum;
    u /= rootImportance;
    int32_t node = 0;
    while (set.nodes[static_cast<size_t>(node)].child0 >= 0) {
        const LightNode& nd = set.nodes[static_cast<size_t>(node)];
        const float i0 = nodeImportance(set.nodes[static_cast<size_t>(nd.child0)], x, n);
        const float i1 = nodeImportance(set.nodes[static_cast<size_t>(nd.child1)], x, n);
        const float s = i0 + i1;
        if (!(s > 0.0f)) return 0.0f;
        const float p0 = i0 / s;
        if (u < p0) {
            u = std::min(u / p0, 0.99999994f);
            node = nd.child0;
            prob *= p0;
        } else {
            u = std::min((u - p0) / (1.0f - p0), 0.99999994f);
            node = nd.child1;
            prob *= 1.0f - p0;
        }
    }
    light = static_cast<uint32_t>(-1 - set.nodes[static_cast<size_t>(node)].child0);
    return prob;
}

/** The probability pickLight gives `light` at the point (walked up from its leaf with the same importances). */
inline float selectPdf(const LightSet& set, const Vec3& x, const Vec3& n, uint32_t light) {
    if (light >= set.localCount + set.distantCount) return 0.0f;
    float rootImportance;
    const float sum = topImportance(set, x, n, rootImportance);
    if (!(sum > 0.0f)) return 0.0f;
    const LightRecord& rec = set.records[light];
    if (rec.kind == kDistantLight) return distantImportance(rec, n) / sum;
    float prob = rootImportance / sum;
    int32_t node = static_cast<int32_t>(rec.leaf);
    while (set.nodes[static_cast<size_t>(node)].parent >= 0) {
        const LightNode& parent = set.nodes[static_cast<size_t>(set.nodes[static_cast<size_t>(node)].parent)];
        const int32_t sibling = parent.child0 == node ? parent.child1 : parent.child0;
        const float own = nodeImportance(set.nodes[static_cast<size_t>(node)], x, n);
        const float other = nodeImportance(set.nodes[static_cast<size_t>(sibling)], x, n);
        const float s = own + other;
        if (!(s > 0.0f)) return 0.0f;
        prob *= own / s;
        node = set.nodes[static_cast<size_t>(node)].parent;
    }
    return prob;
}

/** Power heuristic (beta 2) weight of the strategy with pdf `a` against one with pdf `b`. */
inline float powerHeuristic(float a, float b) {
    const float a2 = a * a, b2 = b * b;
    return a2 + b2 > 0.0f ? a2 / (a2 + b2) : 0.0f;
}

namespace detail {

struct Cone {
    Vec3 axis{0, 1, 0};
    float thetaO{0.0f};
    float thetaE{0.0f};
};

inline Vec3 rotateToward(const Vec3& a, const Vec3& b, float angle) {
    Vec3 k = a.cross(b);
    const float len = k.length();
    if (len < 1e-7f) return a;
    k = k / len;
    // Rodrigues' rotation of a about k by `angle`.
    return (a * std::cos(angle) + k.cross(a) * std::sin(angle) + k * (k.dot(a) * (1.0f - std::cos(angle)))).normalized();
}

/** The smallest cone holding both (Estevez and Kulla, Algorithm 1). */
inline Cone unionCone(Cone a, Cone b) {
    if (a.thetaO < b.thetaO) std::swap(a, b);
    const float thetaD = std::acos(std::clamp(a.axis.dot(b.axis), -1.0f, 1.0f));
    const float thetaE = std::max(a.thetaE, b.thetaE);
    if (std::min(thetaD + b.thetaO, kPi) <= a.thetaO) return Cone{a.axis, a.thetaO, thetaE};
    const float thetaO = 0.5f * (a.thetaO + thetaD + b.thetaO);
    if (thetaO >= kPi) return Cone{a.axis, kPi, thetaE};
    return Cone{rotateToward(a.axis, b.axis, thetaO - a.thetaO), thetaO, thetaE};
}

/** Orientation measure M_Omega of a cone (Estevez and Kulla, eq. 1), the SAOH's angular term. */
inline float orientationMeasure(const Cone& c) {
    const float thetaW = std::min(c.thetaO + c.thetaE, kPi);
    return 2.0f * kPi * (1.0f - std::cos(c.thetaO))
        + 0.5f * kPi * (2.0f * thetaW * std::sin(c.thetaO) - std::cos(c.thetaO - 2.0f * thetaW) - 2.0f * c.thetaO * std::sin(c.thetaO) + std::cos(c.thetaO));
}

struct Item {
    AABB bounds;
    Vec3 centroid;
    Cone cone;
    float energy{0.0f};
    uint32_t light{0};
};

struct Builder {
    std::vector<Item>& items;
    std::vector<LightNode>& nodes;

    LightNode makeNode(size_t begin, size_t end) const {
        AABB box;
        Cone cone = items[begin].cone;
        float energy = 0.0f;
        for (size_t i = begin; i < end; ++i) {
            box.expand(items[i].bounds);
            if (i > begin) cone = unionCone(cone, items[i].cone);
            energy += items[i].energy;
        }
        LightNode node;
        put(node.bmin, box.min);
        put(node.bmax, box.max);
        put(node.axis, cone.axis);
        node.thetaO = cone.thetaO;
        node.thetaE = cone.thetaE;
        node.energy = energy;
        return node;
    }

    static float cost(const AABB& box, const Cone& cone, float energy) {
        // A point's box has no area: its length scale stands in so co-located lights still split by orientation.
        return energy * std::max(box.surfaceArea(), 1e-6f) * orientationMeasure(cone);
    }

    int32_t build(size_t begin, size_t end, int32_t parent, std::vector<LightRecord>& records, int depth = 0) {
        const int32_t index = static_cast<int32_t>(nodes.size());
        nodes.push_back(makeNode(begin, end));
        nodes[static_cast<size_t>(index)].parent = parent;
        if (end - begin == 1) {
            nodes[static_cast<size_t>(index)].child0 = -1 - static_cast<int32_t>(items[begin].light);
            records[items[begin].light].leaf = static_cast<uint32_t>(index);
            return index;
        }
        AABB centroids;
        for (size_t i = begin; i < end; ++i) centroids.expand(items[i].centroid);
        const Vec3 extent = centroids.size();
        size_t mid = begin + (end - begin) / 2;
        int axis = extent.x >= extent.y && extent.x >= extent.z ? 0 : (extent.y >= extent.z ? 1 : 2);
        // Past 40 levels the split is the median, so a lopsided set of lights cannot make the tree deep.
        if (extent[axis] > 0.0f && depth >= 40) {
            std::nth_element(items.begin() + static_cast<std::ptrdiff_t>(begin), items.begin() + static_cast<std::ptrdiff_t>(mid),
                             items.begin() + static_cast<std::ptrdiff_t>(end),
                             [&](const Item& a, const Item& b) { return a.centroid[axis] < b.centroid[axis]; });
        } else if (extent[axis] > 0.0f) {
            // Binned SAOH (surface area orientation heuristic) along the widest centroid axis.
            constexpr int kBins = 12;
            struct Bin { AABB box; Cone cone; float energy{0.0f}; size_t count{0}; };
            std::array<Bin, kBins> bins;
            auto binOf = [&](const Item& it) {
                const int b = static_cast<int>(kBins * (it.centroid[axis] - centroids.min[axis]) / extent[axis]);
                return std::clamp(b, 0, kBins - 1);
            };
            for (size_t i = begin; i < end; ++i) {
                Bin& b = bins[static_cast<size_t>(binOf(items[i]))];
                b.box.expand(items[i].bounds);
                b.cone = b.count == 0 ? items[i].cone : unionCone(b.cone, items[i].cone);
                b.energy += items[i].energy;
                ++b.count;
            }
            float best = INFINITY;
            int split = -1;
            for (int s = 1; s < kBins; ++s) {
                AABB lb, rb;
                Cone lc, rc;
                float le = 0.0f, re = 0.0f;
                size_t ln = 0, rn = 0;
                for (int k = 0; k < kBins; ++k) {
                    const Bin& b = bins[static_cast<size_t>(k)];
                    if (b.count == 0) continue;
                    if (k < s) { lb.expand(b.box); lc = ln == 0 ? b.cone : unionCone(lc, b.cone); le += b.energy; ln += b.count; }
                    else { rb.expand(b.box); rc = rn == 0 ? b.cone : unionCone(rc, b.cone); re += b.energy; rn += b.count; }
                }
                if (ln == 0 || rn == 0) continue;
                const float c = cost(lb, lc, le) + cost(rb, rc, re);
                if (c < best) { best = c; split = s; }
            }
            if (split > 0) {
                auto it = std::partition(items.begin() + static_cast<std::ptrdiff_t>(begin), items.begin() + static_cast<std::ptrdiff_t>(end),
                                         [&](const Item& item) { return binOf(item) < split; });
                mid = static_cast<size_t>(it - items.begin());
            }
            if (split <= 0 || mid == begin || mid == end) {
                mid = begin + (end - begin) / 2;
                std::nth_element(items.begin() + static_cast<std::ptrdiff_t>(begin), items.begin() + static_cast<std::ptrdiff_t>(mid),
                                 items.begin() + static_cast<std::ptrdiff_t>(end),
                                 [&](const Item& a, const Item& b) { return a.centroid[axis] < b.centroid[axis]; });
            }
        }
        // Every centroid in one place: the halves are split by the order the lights came in.
        const int32_t c0 = build(begin, mid, index, records, depth + 1);
        const int32_t c1 = build(mid, end, index, records, depth + 1);
        nodes[static_cast<size_t>(index)].child0 = c0;
        nodes[static_cast<size_t>(index)].child1 = c1;
        return index;
    }
};

} // namespace detail

/**
 * Builds the light set over a traced triangle list: `position(i)` gives vertex i in the tracer's coordinates,
 * `emittedAt(t, u, v)` the radiance triangle t emits at barycentrics (u, v) exactly as the tracer shades it
 * (zero where it emits nothing), and `punctual` the scene's punctual lights already in the tracer's
 * coordinates. A triangle's power is its emission read at seven points times its area; one that reads zero
 * everywhere is left out (a textured emitter whose lit texels miss those points is then found by BSDF rays
 * alone, counted in full, so leaving it out is never wrong). With `triangles` false only the punctual lights
 * are kept (the uniform clay material emits nothing).
 */
template <class PositionFn, class EmissionFn>
LightSet buildLightSet(PositionFn position, const std::vector<uint32_t>& indices, EmissionFn emittedAt,
                       const std::vector<gltf::SceneLight>& punctual, bool triangles) {
    LightSet set;
    const size_t triCount = indices.size() / 3;
    set.triangleLight.assign(triCount, kNoLight);
    std::vector<detail::Item> items;
    std::vector<LightRecord> local, distant;
    // Centroid, three points toward the corners and the three edge midpoints, as (u, v).
    static constexpr float kProbe[7][2] = {{1.0f / 3, 1.0f / 3}, {0.2f, 0.2f}, {0.6f, 0.2f}, {0.2f, 0.6f}, {0.5f, 0.0f}, {0.0f, 0.5f}, {0.5f, 0.5f}};
    if (triangles) {
        for (size_t t = 0; t < triCount; ++t) {
            float emitted = luminance(emittedAt(t, kProbe[0][0], kProbe[0][1]));
            for (int k = 1; k < 7; ++k) emitted += luminance(emittedAt(t, kProbe[k][0], kProbe[k][1]));
            emitted /= 7.0f;
            if (!(emitted > 0.0f)) continue;
            const Vec3 p0 = position(indices[t * 3]), p1 = position(indices[t * 3 + 1]), p2 = position(indices[t * 3 + 2]);
            const Vec3 cr = (p1 - p0).cross(p2 - p0);
            const float twiceArea = cr.length();
            if (!(twiceArea > 1e-12f)) continue;
            LightRecord r;
            r.kind = kTriangleLight;
            put(r.p0, p0);
            put(r.e1, p1 - p0);
            put(r.e2, p2 - p0);
            r.area = 0.5f * twiceArea;
            r.triangle = static_cast<uint32_t>(t);
            // Intensity along the normal: radiance times area. Emission is two-sided, as the tracers shade it.
            r.energy = emitted * r.area;
            detail::Item item;
            item.bounds.expand(p0);
            item.bounds.expand(p1);
            item.bounds.expand(p2);
            item.centroid = (p0 + p1 + p2) / 3.0f;
            item.cone = detail::Cone{cr / twiceArea, kPi, 0.5f * kPi};
            item.energy = r.energy;
            item.light = static_cast<uint32_t>(local.size());
            items.push_back(item);
            local.push_back(r);
            ++set.triangleLights;
        }
    }
    for (const gltf::SceneLight& l : punctual) {
        const float lum = luminance(l.intensity);
        if (!(lum > 0.0f)) continue;
        LightRecord r;
        put(r.e1, l.direction.normalized());
        put(r.intensity, l.intensity);
        r.energy = lum;
        if (l.distant) {
            r.kind = kDistantLight;
            distant.push_back(r);
            continue;
        }
        r.kind = kPointLight;
        put(r.p0, l.position);
        r.range = std::max(0.0f, l.range);
        const bool cone = l.outerConeAngle < kPi;
        r.cosOuter = cone ? std::cos(std::clamp(l.outerConeAngle, 0.0f, 0.5f * kPi)) : -1.0f;
        r.cosInner = cone ? std::cos(std::clamp(l.innerConeAngle, 0.0f, std::clamp(l.outerConeAngle, 0.0f, 0.5f * kPi))) : -1.0f;
        detail::Item item;
        item.bounds.expand(l.position);
        item.centroid = l.position;
        item.cone = cone ? detail::Cone{l.direction.normalized(), 0.0f, std::clamp(l.outerConeAngle, 0.0f, 0.5f * kPi)}
                         : detail::Cone{Vec3(0, 1, 0), kPi, 0.0f};
        item.energy = lum;
        item.light = static_cast<uint32_t>(local.size());
        items.push_back(item);
        local.push_back(r);
        ++set.pointLights;
    }
    set.localCount = static_cast<uint32_t>(local.size());
    set.distantCount = static_cast<uint32_t>(distant.size());
    set.records = std::move(local);
    if (!items.empty()) {
        detail::Builder builder{items, set.nodes};
        set.nodes.reserve(items.size() * 2);
        builder.build(0, items.size(), -1, set.records);
    }
    for (uint32_t i = 0; i < set.localCount; ++i) {
        if (set.records[i].kind == kTriangleLight) set.triangleLight[set.records[i].triangle] = i;
    }
    set.records.insert(set.records.end(), distant.begin(), distant.end());
    return set;
}

} // namespace lights
} // namespace render
} // namespace scratchbox

#endif // SCRATCHBOX_LIGHT_TREE_HPP
