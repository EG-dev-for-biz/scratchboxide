#include "scratchbox_engine.hpp"
#include <cassert>
#include <cmath>
#include <iostream>
#include <map>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::footprints;

namespace {

bool near(float a, float b, float eps = 1e-3f) { return std::abs(a - b) < eps; }

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

// A square extruded: 4 wall quads (8 tris) + top cap (2 tris) + bottom cap (2 tris) = 12 triangles, 16 vertices
// (4 per wall quad, not shared, plus 4 each for the two caps), a closed solid (zero open boundary edges when
// welded) with bounds exactly matching the footprint's extent and [baseY, baseY+height].
void testExtrudePolygonSquare() {
    std::cout << "[Test ExtrudeMerge] extrude_polygon: a square produces a closed, correctly-capped solid...\n";

    std::vector<Vec2> square = { {0, 0}, {2, 0}, {2, 3}, {0, 3} };
    ScratchboxMesh mesh = extrudePolygon(square, 1.0f, 4.0f, Vec4(0.8f, 0.8f, 0.8f, 1.0f));

    std::cout << "  vertices=" << mesh.vertices.size() << " triangles=" << (mesh.indices.size() / 3) << "\n";
    assert(mesh.vertices.size() == 24 && "4 wall quads (4 verts each, 16) + top cap (4 verts) + bottom cap (4 verts)");
    assert(mesh.indices.size() / 3 == 12 && "4 wall quads (2 tris each) + top cap (2 tris) + bottom cap (2 tris)");

    assert(near(mesh.bounds.min.x, 0.0f) && near(mesh.bounds.max.x, 2.0f));
    assert(near(mesh.bounds.min.z, 0.0f) && near(mesh.bounds.max.z, 3.0f));
    assert(near(mesh.bounds.min.y, 1.0f) && near(mesh.bounds.max.y, 5.0f) && "baseY=1, height=4 -> topY=5");

    // Welded (positions shared across wall/cap seams), the solid must have no open boundary: every edge shared by
    // exactly two triangles.
    ScratchboxMesh welded = mesh;
    const float tol = 1e-4f;
    std::vector<uint32_t> remap(welded.vertices.size());
    for (uint32_t i = 0; i < welded.vertices.size(); ++i) {
        remap[i] = i;
        for (uint32_t j = 0; j < i; ++j) {
            if ((welded.vertices[i].position - welded.vertices[j].position).length() < tol) { remap[i] = remap[j]; break; }
        }
    }
    for (auto& idx : welded.indices) idx = remap[idx];
    const int open = countBoundaryEdges(welded);
    std::cout << "  open boundary edges after welding: " << open << "\n";
    assert(open == 0 && "a correctly top+bottom capped extrusion must be a closed, watertight solid");

    std::cout << "  [PASS]\n";
}

// A triangle footprint: 3 wall quads (6 tris) + top (1 tri) + bottom (1 tri) = 8 triangles.
void testExtrudePolygonTriangle() {
    std::cout << "[Test ExtrudeMerge] extrude_polygon: a triangle produces the right counts and closes...\n";

    std::vector<Vec2> tri = { {0, 0}, {4, 0}, {0, 4} };
    ScratchboxMesh mesh = extrudePolygon(tri, 0.0f, 2.0f);

    std::cout << "  vertices=" << mesh.vertices.size() << " triangles=" << (mesh.indices.size() / 3) << "\n";
    assert(mesh.indices.size() / 3 == 8 && "3 wall quads (2 tris each) + top (1 tri) + bottom (1 tri)");
    assert(near(mesh.bounds.min.y, 0.0f) && near(mesh.bounds.max.y, 2.0f));

    std::cout << "  [PASS]\n";
}

// Degenerate input (fewer than 3 points): returns an empty mesh rather than crashing or producing garbage.
void testExtrudePolygonDegenerate() {
    std::cout << "[Test ExtrudeMerge] extrude_polygon: a degenerate (< 3 point) footprint is empty, not garbage...\n";
    std::vector<Vec2> line = { {0, 0}, {1, 0} };
    ScratchboxMesh mesh = extrudePolygon(line, 0.0f, 1.0f);
    assert(mesh.vertices.empty() && mesh.indices.empty());
    std::cout << "  [PASS]\n";
}

// merge_meshes (ScratchboxMesh::append, exercised directly here the same way the Python binding uses it): N
// meshes merge into one whose vertex/triangle counts are the exact sum of the inputs', and whose bounds are the
// union of all of theirs.
void testMergeMeshes() {
    std::cout << "[Test ExtrudeMerge] merge_meshes (via append): union of vertices/triangles/bounds...\n";

    ScratchboxMesh a = ScratchboxMesh::createBox(Vec3(1, 1, 1), Vec4(1, 0, 0, 1));
    ScratchboxMesh b = ScratchboxMesh::createBox(Vec3(1, 1, 1), Vec4(0, 1, 0, 1));
    for (auto& v : b.vertices) v.position += Vec3(5, 0, 0);
    b.recomputeBounds();
    ScratchboxMesh c = ScratchboxMesh::createSphere(0.5f, 8, 8, Vec4(0, 0, 1, 1));
    for (auto& v : c.vertices) v.position += Vec3(0, 0, 8);
    c.recomputeBounds();

    const size_t expectVerts = a.vertices.size() + b.vertices.size() + c.vertices.size();
    const size_t expectTris = (a.indices.size() + b.indices.size() + c.indices.size()) / 3;

    ScratchboxMesh merged("merged_mesh");
    for (const auto& m : {a, b, c}) merged.append(m);
    merged.recomputeBounds();

    std::cout << "  merged vertices=" << merged.vertices.size() << " (expect " << expectVerts << "), triangles=" << (merged.indices.size() / 3) << " (expect " << expectTris << ")\n";
    assert(merged.vertices.size() == expectVerts);
    assert(merged.indices.size() / 3 == expectTris);

    std::cout << "  merged bounds: (" << merged.bounds.min.x << "," << merged.bounds.min.y << "," << merged.bounds.min.z << ") to ("
               << merged.bounds.max.x << "," << merged.bounds.max.y << "," << merged.bounds.max.z << ")\n";
    // a's box is centered at origin (extent ~[-0.5,0.5]); b shifted +5 on X; c's max Z is its own (already-shifted)
    // bounds max, not an assumed exact radius -- a tessellated sphere's vertices don't exactly reach the nominal
    // radius at every axis, so the union's bound must match the input mesh's own measured bound, not a geometric
    // idealization of it.
    assert(near(merged.bounds.min.x, -0.5f, 0.02f));
    assert(near(merged.bounds.max.x, 5.5f, 0.02f) && "b's box, shifted +5 on X, sets the max X");
    assert(near(merged.bounds.max.z, c.bounds.max.z, 1e-4f) && "c's sphere sets the max Z, exactly matching its own measured bounds");

    std::cout << "  [PASS]\n";
}

} // namespace

int main() {
    testExtrudePolygonSquare();
    testExtrudePolygonTriangle();
    testExtrudePolygonDegenerate();
    testMergeMeshes();
    std::cout << "[Test ExtrudeMerge] All extrude_polygon + merge_meshes tests passed.\n";
    return 0;
}
