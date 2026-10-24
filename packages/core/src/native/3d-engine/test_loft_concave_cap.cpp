#include "scratchbox_engine.hpp"
#include <cassert>
#include <cmath>
#include <iostream>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::shaper;

namespace {

/** Ray-casting point-in-polygon (XZ plane), correct for a concave loop. */
bool pointInPolygonXZ(float x, float z, const std::vector<Vec3>& poly) {
    bool inside = false;
    for (size_t i = 0, j = poly.size() - 1; i < poly.size(); j = i++) {
        const float xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
        if (((zi > z) != (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
}

// A classic L-shape (a 4x4 square with its own 3x3 corner removed) whose vertex-average centroid sits in the
// removed notch: the exact failure mode of a centroid-fan cap (every fan triangle reaches toward a point outside
// the polygon). A correct ear-clipping triangulation never produces a triangle with its centroid outside the loop.
std::vector<Vec3> lShape(float y) {
    return {
        Vec3(0, y, 0), Vec3(4, y, 0), Vec3(4, y, 1),
        Vec3(1, y, 1), Vec3(1, y, 4), Vec3(0, y, 4)
    };
}

void testConcaveLoftCapStaysInsidePolygon() {
    std::cout << "[Test Loft] Loft3D::skin: a concave (L-shaped) cap triangulates inside the polygon...\n";

    std::vector<std::vector<Vec3>> slices = { lShape(0.0f), lShape(2.0f) };
    ScratchboxMesh mesh = Loft3D::skin(slices, true);

    // The vertex-average "centroid" a fan would have used sits in the removed notch, outside the L: confirms this
    // test shape actually exercises the bug (not a vacuously-convex case).
    float cx = 0, cz = 0;
    for (const auto& p : slices[0]) { cx += p.x; cz += p.z; }
    cx /= slices[0].size(); cz /= slices[0].size();
    bool centroidOutside = !pointInPolygonXZ(cx, cz, slices[0]);
    std::cout << "  vertex-average centroid (" << cx << ", " << cz << ") outside the L: " << centroidOutside << "\n";
    assert(centroidOutside && "this L-shape must put the naive centroid outside the polygon, or the test proves nothing");

    // Every cap triangle (both at y=0 and y=2, since the mesh is flat/axis-aligned at its ends) must have its
    // centroid strictly inside the polygon loop: a hallmark of a real ear-clipping triangulation. A centroid fan
    // from an outside apex would put several triangle centroids outside the polygon, in the removed notch.
    int capTriangles = 0, outside = 0;
    for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
        const Vec3& a = mesh.vertices[mesh.indices[i]].position;
        const Vec3& b = mesh.vertices[mesh.indices[i + 1]].position;
        const Vec3& c = mesh.vertices[mesh.indices[i + 2]].position;
        // A cap triangle: all three vertices share the same Y (the side walls span between y=0 and y=2, so they don't).
        if (std::abs(a.y - b.y) > 1e-4f || std::abs(a.y - c.y) > 1e-4f) continue;
        capTriangles++;
        float tx = (a.x + b.x + c.x) / 3.0f, tz = (a.z + b.z + c.z) / 3.0f;
        if (!pointInPolygonXZ(tx, tz, slices[0])) outside++;
    }
    std::cout << "  cap triangles=" << capTriangles << ", with centroid outside the polygon: " << outside << "\n";
    // A hexagonal (6-point) simple polygon triangulates into exactly 4 triangles per cap (n-2), x2 caps = 8.
    assert(capTriangles == 8 && "an L-shaped (6-point) polygon must triangulate into n-2=4 triangles per cap");
    assert(outside == 0 && "every cap triangle must stay inside the polygon -- a centroid fan from outside the shape would fail this");

    std::cout << "  [PASS]\n";
}

// A simple convex loft (a square) must still close exactly as before: no vertex/triangle-count regression for the
// common case the old fan already handled correctly.
void testConvexLoftStillCloses() {
    std::cout << "[Test Loft] Loft3D::skin: a convex (square) cap is unaffected...\n";

    std::vector<Vec3> square0 = { Vec3(0, 0, 0), Vec3(2, 0, 0), Vec3(2, 0, 2), Vec3(0, 0, 2) };
    std::vector<Vec3> square1 = { Vec3(0, 3, 0), Vec3(2, 3, 0), Vec3(2, 3, 2), Vec3(0, 3, 2) };
    ScratchboxMesh mesh = Loft3D::skin({ square0, square1 }, true);

    // 4-point loop -> 2 triangles per cap, x2 caps = 4; + the side-wall strip (4 quads x 2 tris = 8) = 12 total.
    size_t triCount = mesh.indices.size() / 3;
    std::cout << "  triangles=" << triCount << " (expect 12)\n";
    assert(triCount == 12);

    std::cout << "  [PASS]\n";
}

} // namespace

int main() {
    testConcaveLoftCapStaysInsidePolygon();
    testConvexLoftStillCloses();
    std::cout << "[Test Loft] All loft concave-cap tests passed.\n";
    return 0;
}
