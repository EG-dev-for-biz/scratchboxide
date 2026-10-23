#include "scratchbox_engine.hpp"
#include <cassert>
#include <iostream>
#include <map>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::shaper;

namespace {

int countBoundaryEdges(const ScratchboxMesh& mesh) {
    std::map<std::pair<uint32_t, uint32_t>, int> edgeCount;
    auto key = [](uint32_t a, uint32_t b) { return a < b ? std::make_pair(a, b) : std::make_pair(b, a); };
    for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
        uint32_t a = mesh.indices[i], b = mesh.indices[i + 1], c = mesh.indices[i + 2];
        edgeCount[key(a, b)]++; edgeCount[key(b, c)]++; edgeCount[key(c, a)]++;
    }
    int boundary = 0;
    for (auto& [e, cnt] : edgeCount) if (cnt == 1) ++boundary;
    return boundary;
}

void testSweep3DFrames() {
    std::cout << "[Test Shaper] Sweep3D rotation-minimizing frames...\n";

    std::vector<Vec3> helix;
    for (int i = 0; i <= 40; ++i) {
        float t = static_cast<float>(i) / 40.0f;
        helix.push_back(Vec3(std::sin(t * TWO_PI) * 2.0f, t * 5.0f, std::cos(t * TWO_PI) * 2.0f));
    }
    auto helixFrames = Sweep3D::rotationMinimizingFrames(helix);
    for (size_t i = 1; i < helixFrames.size(); ++i) {
        assert(helixFrames[i].normal.dot(helixFrames[i - 1].normal) > 0.9f);
    }

    std::vector<Vec3> straight;
    for (int i = 0; i <= 20; ++i) straight.push_back(Vec3(0, static_cast<float>(i), 0));
    auto straightFrames = Sweep3D::rotationMinimizingFrames(straight);
    for (const auto& f : straightFrames) assert(!std::isnan(f.normal.x) && !std::isnan(f.binormal.x));

    std::vector<Vec3> corner = { {0, 0, 0}, {0, 1, 0}, {0, 2, 0}, {1, 2, 0}, {2, 2, 0} };
    for (const auto& f : Sweep3D::rotationMinimizingFrames(corner)) assert(!std::isnan(f.normal.x));

    std::vector<Vec2> profile = { {0.1f, 0.0f}, {0.0f, 0.1f}, {-0.1f, 0.0f}, {0.0f, -0.1f} };
    auto swept = Sweep3D::sweep(helix, profile, PI, 1.0f, 0.5f, true);
    assert(swept.vertices.size() == helix.size() * profile.size() + 2);
    assert(swept.indices.size() / 3 > 0);

    std::cout << "  - OK (" << swept.vertices.size() << " verts, no frame flips)\n";
}

void testLathe3DWatertight() {
    std::cout << "[Test Shaper] Lathe3D::revolve seam weld + partial-sweep caps...\n";

    std::vector<Vec2> tube = { {0.5f, 0.0f}, {1.0f, 0.0f}, {1.0f, 2.0f}, {0.5f, 2.0f} };

    auto full = Lathe3D::revolve(tube, 24, TWO_PI);
    assert(full.vertices.size() == 24 * tube.size()); // seam ring welded, not duplicated
    int dup = 0;
    for (size_t i = 0; i < full.vertices.size(); ++i)
        for (size_t j = i + 1; j < full.vertices.size(); ++j)
            if ((full.vertices[i].position - full.vertices[j].position).lengthSq() < 1e-10f) ++dup;
    assert(dup == 0);

    auto half = Lathe3D::revolve(tube, 24, PI);
    // Same radialSegments means the same number of side quads either way; half adds 2 fan
    // triangles per open end (pts=4 profile -> 2 cap triangles x 2 ends = 4 extra).
    assert(half.indices.size() / 3 == full.indices.size() / 3 + 4);

    // `tube`'s first and last points both sit off-axis (radius 0.5, not 0), so a full sweep
    // (capEnds's default, false) leaves the top and bottom rings open: 24 boundary edges each.
    assert(countBoundaryEdges(full) == 24 * 2);

    // capEnds=true closes both: watertight, like the partial sweep's own end caps.
    auto fullCapped = Lathe3D::revolve(tube, 24, TWO_PI, {0.8f, 0.85f, 0.9f, 1.0f}, true);
    assert(countBoundaryEdges(fullCapped) == 0);
    assert(fullCapped.vertices.size() == full.vertices.size() + 2); // one axis-center vertex per capped end

    // A profile whose ends already touch the axis needs no cap; capEnds must be a no-op (same topology) —
    // regardless of whatever boundary-edge count that profile's pole already has on its own.
    std::vector<Vec2> dome = { {0.0f, 0.0f}, {1.0f, 0.3f}, {0.6f, 1.0f}, {0.0f, 1.2f} };
    auto domeUncapped = Lathe3D::revolve(dome, 16, TWO_PI);
    auto domeCapped = Lathe3D::revolve(dome, 16, TWO_PI, {0.8f, 0.85f, 0.9f, 1.0f}, true);
    assert(domeCapped.vertices.size() == domeUncapped.vertices.size());
    assert(domeCapped.indices.size() == domeUncapped.indices.size());
    assert(countBoundaryEdges(domeCapped) == countBoundaryEdges(domeUncapped));

    std::cout << "  - OK (full: " << full.vertices.size() << " verts, 0 seam duplicates, "
              << countBoundaryEdges(full) << " open boundary edges; "
              << "full+capEnds: " << countBoundaryEdges(fullCapped) << " open boundary edges; "
              << "half: " << half.indices.size() / 3 << " tris incl. end caps)\n";
}

void testReplicator3DAlongCurve() {
    std::cout << "[Test Shaper] Replicator3D::alongCurve bolt circle + merge-by-distance weld...\n";

    std::vector<Vec2> square = { {-0.1f, -0.1f}, {0.1f, -0.1f}, {0.1f, 0.1f}, {-0.1f, 0.1f} };
    ScratchboxMesh seed = Lathe3D::revolve(square, 4, TWO_PI);
    assert(!seed.vertices.empty());

    std::vector<Vec3> circle;
    const int n = 64;
    for (int i = 0; i <= n; ++i) {
        float a = static_cast<float>(i) / n * TWO_PI;
        circle.push_back(Vec3(std::cos(a) * 3.0f, 0.0f, std::sin(a) * 3.0f));
    }
    float pitch = (TWO_PI * 3.0f) / 12.0f;
    auto bolts = Replicator3D::alongCurve(seed, circle, pitch);
    assert(!bolts.vertices.empty());
    assert(bolts.vertices.size() % seed.vertices.size() == 0);

    // 11 touching unit cubes along a straight carrier: merge-by-distance must weld the 10
    // shared-face interfaces (4 verts each), matching exactly 8*11 - 4*10.
    ScratchboxMesh cube;
    std::vector<Vec3> cv = {
        {-0.5f, -0.5f, -0.5f}, {0.5f, -0.5f, -0.5f}, {0.5f, 0.5f, -0.5f}, {-0.5f, 0.5f, -0.5f},
        {-0.5f, -0.5f, 0.5f}, {0.5f, -0.5f, 0.5f}, {0.5f, 0.5f, 0.5f}, {-0.5f, 0.5f, 0.5f}
    };
    for (auto& p : cv) cube.addVertex({p});
    uint32_t cf[6][4] = { {0,1,2,3}, {4,5,6,7}, {0,1,5,4}, {1,2,6,5}, {2,3,7,6}, {3,0,4,7} };
    for (auto& f : cf) { cube.addTriangle(f[0], f[1], f[2]); cube.addTriangle(f[0], f[2], f[3]); }

    std::vector<Vec3> line = { {0, 0, 0}, {0, 10, 0} };
    auto noWeld = Replicator3D::alongCurve(cube, line, 1.0f, 0.0f, false);
    auto welded = Replicator3D::alongCurve(cube, line, 1.0f, 0.02f, false);
    assert(noWeld.vertices.size() == 11 * 8);
    assert(welded.vertices.size() == 11 * 8 - 10 * 4);

    std::cout << "  - OK (bolt circle: " << bolts.vertices.size() << " verts; "
              << "weld: " << noWeld.vertices.size() << " -> " << welded.vertices.size() << ")\n";
}

void testReplicator3DOnGrid() {
    std::cout << "[Test Shaper] Replicator3D::onGrid lattice with row offset...\n";

    std::vector<Vec2> square = { {-0.1f, -0.1f}, {0.1f, -0.1f}, {0.1f, 0.1f}, {-0.1f, 0.1f} };
    ScratchboxMesh seed = Lathe3D::revolve(square, 4, TWO_PI);

    auto grid = Replicator3D::onGrid(seed, 5, 3, 0.3f, 0.3f, 0.15f, true);
    assert(grid.vertices.size() == seed.vertices.size() * 15);
    assert(grid.indices.size() == seed.indices.size() * 15);

    std::cout << "  - OK (" << grid.vertices.size() << " verts across 15 instances)\n";
}

} // namespace

int main() {
    testSweep3DFrames();
    testLathe3DWatertight();
    testReplicator3DAlongCurve();
    testReplicator3DOnGrid();
    std::cout << "[Test Shaper] All sweep/revolve/replicate tests passed.\n";
    return 0;
}
