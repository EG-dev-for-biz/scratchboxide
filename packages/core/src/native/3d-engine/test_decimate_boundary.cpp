// QuadricDecimator: preserveBoundary (default true) pins an open mesh's outline on its own, without preserveCreases;
// turning it off lets the outline erode. Build: clang++ -std=c++20 -O2 -I include test_decimate_boundary.cpp
#include "scratchbox_engine.hpp"
#include <cassert>
#include <cmath>
#include <cstdio>

using namespace scratchbox;
using namespace scratchbox::geometry;

// how far the decimated mesh's open-boundary vertices sit off the original 10 x 10 square outline (worst case)
static float outlineDrift(const ScratchboxMesh& m) {
    std::map<std::pair<uint32_t, uint32_t>, int> edges;
    for (size_t t = 0; t + 2 < m.indices.size(); t += 3)
        for (int e = 0; e < 3; ++e) {
            uint32_t a = m.indices[t + e], b = m.indices[t + (e + 1) % 3];
            ++edges[{std::min(a, b), std::max(a, b)}];
        }
    float worst = 0.0f;
    for (auto& [k, n] : edges) {
        if (n != 1) continue;
        for (uint32_t v : {k.first, k.second}) {
            const Vec3& p = m.vertices[v].position;
            float d = std::min({std::abs(std::abs(p.x) - 5.0f), std::abs(std::abs(p.z) - 5.0f)});
            worst = std::max(worst, d);
        }
    }
    return worst;
}

int main() {
    // a 10 x 10 open plane with a bumpy surface, so collapsing edges has real error to trade off against the outline
    ScratchboxMesh plane = GeometryBuilder::createPlane(10.0f, 10.0f, 40, 40);
    for (auto& v : plane.vertices) v.position.y = 0.4f * std::sin(v.position.x * 1.7f) * std::cos(v.position.z * 1.3f);
    std::printf("[Test Decimate] input %zu tris, outline drift %.4f\n", plane.indices.size() / 3, outlineDrift(plane));

    processing::DecimateOptions keep;
    keep.targetRatio = 0.08f;
    ScratchboxMesh pinned = processing::QuadricDecimator::decimate(plane, keep);

    processing::DecimateOptions loose = keep;
    loose.preserveBoundary = false;
    ScratchboxMesh eroded = processing::QuadricDecimator::decimate(plane, loose);

    float dPinned = outlineDrift(pinned), dEroded = outlineDrift(eroded);
    std::printf("  preserveBoundary=true : %zu tris, outline drift %.4f m\n", pinned.indices.size() / 3, dPinned);
    std::printf("  preserveBoundary=false: %zu tris, outline drift %.4f m\n", eroded.indices.size() / 3, dEroded);
    assert(dPinned < 0.01f && "the default must keep every open-boundary vertex on the original outline");
    assert(dEroded > dPinned && "without it the outline is free to move (the flag must change something)");
    std::printf("[PASS] preserveBoundary pins the open outline\n");
    return 0;
}
