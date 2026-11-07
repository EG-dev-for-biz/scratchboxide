/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * meshoptimizer (third_party/meshoptimizer, MIT, vendored unchanged) on the engine's ScratchboxMesh.
 *
 * - simplify: quadric edge collapse to a triangle target and/or an absolute error bound in metres, aware of normals,
 *   UVs and colours (meshopt_simplifyWithAttributes). UV seams, hard edges and colour edges are kept as meshoptimizer
 *   finds them (vertices at one position with different attributes), so seams do not crack. The bound and the
 *   reported error are meshoptimizer's quadric estimate (distance from each kept vertex to the planes of the
 *   triangles it absorbed), in metres, not a Hausdorff guarantee: the input surface's measured largest distance to
 *   the result runs up to about 1.7x it (1.55-1.65x on the test torus, see native-third-party.test.ts).
 * - optimizeVertexCache / optimizeVertexFetch: triangle order for the post-transform cache, then vertices in first-use
 *   order (unused ones dropped). simplify runs both on its result unless told not to.
 * - cacheMissRatio: the ACMR of a mesh for a given cache size (meshopt_analyzeVertexCache).
 *
 * Link it: compileSource(code, { vendored: ['meshoptimizer'] }), or buildVendoredLibrary('meshoptimizer') into a
 * NativeCompileSpec's libs (native-third-party.ts). The include below resolves through the third_party include root.
 */

#ifndef SCRATCHBOX_MESHOPT_HPP
#define SCRATCHBOX_MESHOPT_HPP

#include "scratchbox_geometry.hpp"
#include "meshoptimizer/src/meshoptimizer.h"

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace scratchbox {
namespace meshopt {

using geometry::ScratchboxMesh;

struct SimplifyOptions {
    /** Triangle goal; 0 uses targetRatio. */
    size_t targetTriangles{0};
    /** Share of triangles to keep when targetTriangles is 0 (clamped to [0, 1]). */
    float targetRatio{0.5f};
    /** Error bound in metres (meshoptimizer's quadric estimate, see the file comment); < 0 means none (the triangle
     * goal alone stops it). targetRatio 0 with a bound simplifies as far as the bound allows. */
    float maxErrorMeters{-1.0f};
    /** Weigh normals, UVs and colours into the collapse cost (meshopt_simplifyWithAttributes). */
    bool attributes{true};
    /** Attribute weights, in meshoptimizer's units (an attribute change of 1/w costs about as much as a deviation of
     * the mesh's extent); 0 leaves an attribute out. */
    float normalWeight{0.5f};
    float uvWeight{0.5f};
    float colorWeight{0.25f};
    /** Keep the open border (outline) where it is. */
    bool lockBorder{false};
    /** Remove small disconnected pieces whose removal costs less than the error bound (meshopt_SimplifyPrune). */
    bool prune{false};
    /** Prefer even triangles over the fewest-error placement (meshopt_SimplifyRegularize). */
    bool regularize{false};
    /** Allow collapses across attribute seams when it lowers the error (meshopt_SimplifyPermissive). */
    bool permissive{false};
    /** Re-order the result for the vertex cache and vertex fetch, dropping unused vertices. */
    bool optimize{true};
};

struct SimplifyResult {
    ScratchboxMesh mesh;
    size_t trianglesBefore{0};
    size_t trianglesAfter{0};
    /** meshoptimizer's quadric estimate of the deviation from the input surface, metres (not a Hausdorff bound). */
    float estimatedErrorMeters{0.0f};
};

namespace detail {

inline std::vector<float> positionsOf(const ScratchboxMesh& m) {
    std::vector<float> p(m.vertices.size() * 3);
    for (size_t i = 0; i < m.vertices.size(); ++i) {
        p[i * 3 + 0] = m.vertices[i].position.x;
        p[i * 3 + 1] = m.vertices[i].position.y;
        p[i * 3 + 2] = m.vertices[i].position.z;
    }
    return p;
}

/** Interleaved attribute streams (normal, uv, rgb) with their weights; weight 0 streams are left out. */
inline size_t attributesOf(const ScratchboxMesh& m, const SimplifyOptions& o, std::vector<float>& attrs, std::vector<float>& weights) {
    weights.clear();
    if (o.normalWeight > 0) weights.insert(weights.end(), 3, o.normalWeight);
    if (o.uvWeight > 0) weights.insert(weights.end(), 2, o.uvWeight);
    if (o.colorWeight > 0) weights.insert(weights.end(), 3, o.colorWeight);
    const size_t n = weights.size();
    attrs.assign(m.vertices.size() * n, 0.0f);
    for (size_t i = 0; i < m.vertices.size(); ++i) {
        const auto& v = m.vertices[i];
        float* a = attrs.data() + i * n;
        if (o.normalWeight > 0) { *a++ = v.normal.x; *a++ = v.normal.y; *a++ = v.normal.z; }
        if (o.uvWeight > 0) { *a++ = v.uv.x; *a++ = v.uv.y; }
        if (o.colorWeight > 0) { *a++ = v.color.x; *a++ = v.color.y; *a++ = v.color.z; }
    }
    return n;
}

} // namespace detail

/** Triangle order for the post-transform vertex cache (meshopt_optimizeVertexCache), in place. */
inline void optimizeVertexCache(ScratchboxMesh& m) {
    if (m.indices.size() < 3) return;
    meshopt_optimizeVertexCache(m.indices.data(), m.indices.data(), m.indices.size(), m.vertices.size());
}

/** Vertices in first-use order, unused ones dropped (meshopt_optimizeVertexFetchRemap), in place. */
inline void optimizeVertexFetch(ScratchboxMesh& m) {
    if (m.indices.empty()) { m.vertices.clear(); m.bounds = geometry::AABB(); return; }
    std::vector<unsigned int> remap(m.vertices.size());
    const size_t unique = meshopt_optimizeVertexFetchRemap(remap.data(), m.indices.data(), m.indices.size(), m.vertices.size());
    std::vector<geometry::Vertex> out(unique);
    for (size_t i = 0; i < m.vertices.size(); ++i) {
        if (remap[i] != ~0u) out[remap[i]] = m.vertices[i];
    }
    for (auto& idx : m.indices) idx = remap[idx];
    m.vertices = std::move(out);
    m.bounds = geometry::AABB();
    for (const auto& v : m.vertices) m.bounds.expand(v.position);
}

/** Average cache miss ratio (vertex shader invocations per triangle) for a FIFO cache of cacheSize. */
inline float cacheMissRatio(const ScratchboxMesh& m, unsigned cacheSize = 16) {
    if (m.indices.size() < 3) return 0.0f;
    return meshopt_analyzeVertexCache(m.indices.data(), m.indices.size(), m.vertices.size(), cacheSize, 0, 0).acmr;
}

/** Simplifies `input` (see SimplifyOptions); the input is not changed. */
inline SimplifyResult simplify(const ScratchboxMesh& input, const SimplifyOptions& o = {}) {
    SimplifyResult r;
    r.trianglesBefore = input.indices.size() / 3;
    r.mesh = input;
    if (input.vertices.empty() || input.indices.size() < 3) { r.trianglesAfter = r.trianglesBefore; return r; }

    size_t target = o.targetTriangles;
    if (target == 0) target = static_cast<size_t>(std::floor(r.trianglesBefore * std::clamp(o.targetRatio, 0.0f, 1.0f)));
    target = std::min(target, r.trianglesBefore);

    const std::vector<float> pos = detail::positionsOf(input);
    unsigned options = meshopt_SimplifyErrorAbsolute;
    if (o.lockBorder) options |= meshopt_SimplifyLockBorder;
    if (o.prune) options |= meshopt_SimplifyPrune;
    if (o.regularize) options |= meshopt_SimplifyRegularize;
    if (o.permissive) options |= meshopt_SimplifyPermissive;
    // with ErrorAbsolute the bound and the result are in the positions' units (metres); no bound = any error
    const float bound = o.maxErrorMeters >= 0 ? o.maxErrorMeters : 3.0e38f;

    std::vector<unsigned int> out(input.indices.size());
    float err = 0.0f;
    size_t count;
    std::vector<float> attrs, weights;
    const size_t nAttr = o.attributes ? detail::attributesOf(input, o, attrs, weights) : 0;
    if (nAttr > 0) {
        count = meshopt_simplifyWithAttributes(out.data(), input.indices.data(), input.indices.size(), pos.data(), input.vertices.size(),
            sizeof(float) * 3, attrs.data(), sizeof(float) * nAttr, weights.data(), nAttr, nullptr, target * 3, bound, options, &err);
    } else {
        count = meshopt_simplify(out.data(), input.indices.data(), input.indices.size(), pos.data(), input.vertices.size(),
            sizeof(float) * 3, target * 3, bound, options, &err);
    }
    out.resize(count);
    r.mesh.indices.assign(out.begin(), out.end());
    r.mesh.name = input.name + "_simplified";
    if (o.optimize) {
        optimizeVertexCache(r.mesh);
        optimizeVertexFetch(r.mesh);
    }
    r.trianglesAfter = r.mesh.indices.size() / 3;
    r.estimatedErrorMeters = err;
    return r;
}

} // namespace meshopt
} // namespace scratchbox

#endif // SCRATCHBOX_MESHOPT_HPP
