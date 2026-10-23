#include "scratchbox_engine.hpp"
#include "scratchbox_mesh_edit.hpp"
#include <cassert>
#include <cmath>
#include <iostream>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::footprints;
using namespace scratchbox::mesh_edit;

namespace {

bool near(float a, float b, float eps = 1e-3f) { return std::abs(a - b) < eps; }

// Mirrors the boolean_mesh Python binding exactly (python_bindings.cpp): same conversion, same eps derivation
// (from the larger operand's own diagonal), same T-junction close after the boolean.
ScratchboxMesh booleanMesh(const ScratchboxMesh& a, const ScratchboxMesh& b, BooleanOp op) {
    std::vector<CsgPolygon> pa = meshToPolygons(a), pb = meshToPolygons(b);
    const DBox ba = boxOf(pa), bb = boxOf(pb);
    const double extent = std::max((ba.hi - ba.lo).length(), (bb.hi - bb.lo).length());
    const double eps = std::max(1e-9, 1e-7 * std::max(extent, 1e-3));
    std::vector<CsgPolygon> result = booleanPolygons(std::move(pa), std::move(pb), op, eps);
    closeTJunctions(result, eps * 10);
    ScratchboxMesh out = polygonsToMesh(result, "boolean_mesh");
    out.recomputeBounds();
    return out;
}

ScratchboxMesh box(float x0, float y0, float z0, float x1, float y1, float z1) {
    std::vector<Vec2> footprint = {{x0, z0}, {x1, z0}, {x1, z1}, {x0, z1}};
    return extrudePolygon(footprint, y0, y1 - y0);
}

// Subtracting a "tunnel" that pokes all the way through a block (the real motivating case: an arch or window
// opening cut through a wall) opens a watertight hole clear through it: more triangles than the block alone (the
// tunnel's own side walls become the opening's walls), the block's outer bounds unchanged (the tunnel doesn't
// exceed them on X/Y), closed, and the tunnel's own footprint no longer solid at its centre.
void testSubtractCutsAWatertightTunnel() {
    std::cout << "[Test BooleanCSG] subtract: a through-tunnel opens a watertight hole in a block...\n";

    ScratchboxMesh block = box(0, 0, 0, 10, 10, 10);
    ScratchboxMesh tunnel = box(3, 3, -1, 7, 7, 11); // pokes out past the block on both ends along Z
    const size_t blockTris = block.indices.size() / 3;
    assert(blockTris == 12 && "a box extrusion is 12 triangles (2 per face x 6)");

    ScratchboxMesh result = booleanMesh(block, tunnel, BooleanOp::Subtract);
    const size_t resultTris = result.indices.size() / 3;
    const uint32_t open = openEdges(result, 1e-4f);
    std::cout << "  result triangles=" << resultTris << " (block alone=" << blockTris << "), open edges=" << open << "\n";
    std::cout << "  bounds: (" << result.bounds.min.x << "," << result.bounds.min.y << "," << result.bounds.min.z << ") to ("
               << result.bounds.max.x << "," << result.bounds.max.y << "," << result.bounds.max.z << ")\n";

    assert(resultTris > blockTris && "a through-tunnel needs its own wall triangles: more than the block alone");
    assert(open == 0 && "a tunnel that exits both ends must leave the block watertight, not an open-ended pipe");
    assert(near(result.bounds.min.x, 0.0f) && near(result.bounds.max.x, 10.0f) && "the block's X/Y bounds are unchanged by a tunnel that doesn't exceed them");
    assert(near(result.bounds.min.y, 0.0f) && near(result.bounds.max.y, 10.0f));
    assert(near(result.bounds.min.z, 0.0f) && near(result.bounds.max.z, 10.0f) && "the tunnel pokes out past Z, but the result's Z bounds stay the block's own (nothing of the tunnel itself remains)");

    std::cout << "  [PASS]\n";
}

// Union of two boxes that do not touch at all: booleanPolygons' own Union branch passes disjoint (non-"near")
// geometry straight through unchanged, so the result is exactly the concatenation of both, each still watertight.
void testUnionOfDisjointBoxesConcatenates() {
    std::cout << "[Test BooleanCSG] union: two disjoint boxes concatenate, each staying closed...\n";

    ScratchboxMesh a = box(0, 0, 0, 5, 5, 5);
    ScratchboxMesh c = box(10, 0, 0, 15, 5, 5);
    const size_t aTris = a.indices.size() / 3, cTris = c.indices.size() / 3;

    ScratchboxMesh result = booleanMesh(a, c, BooleanOp::Union);
    const size_t resultTris = result.indices.size() / 3;
    const uint32_t open = openEdges(result, 1e-4f);
    std::cout << "  result triangles=" << resultTris << " (expect " << (aTris + cTris) << "), open edges=" << open << "\n";
    std::cout << "  bounds: (" << result.bounds.min.x << "," << result.bounds.min.y << "," << result.bounds.min.z << ") to ("
               << result.bounds.max.x << "," << result.bounds.max.y << "," << result.bounds.max.z << ")\n";

    assert(resultTris == aTris + cTris && "disjoint boxes union to the exact sum of their own triangles");
    assert(open == 0 && "each disjoint solid stays watertight on its own after the union");
    assert(near(result.bounds.min.x, 0.0f) && near(result.bounds.max.x, 15.0f) && "the union's bounds span both boxes");

    std::cout << "  [PASS]\n";
}

// Intersect of two overlapping boxes: the result is exactly their shared region, smaller than either input and
// still watertight.
void testIntersectIsTheSharedRegion() {
    std::cout << "[Test BooleanCSG] intersect: two overlapping boxes intersect to their shared region...\n";

    ScratchboxMesh a = box(0, 0, 0, 10, 10, 10);
    ScratchboxMesh d = box(5, 5, 5, 15, 15, 15);

    ScratchboxMesh result = booleanMesh(a, d, BooleanOp::Intersect);
    const uint32_t open = openEdges(result, 1e-4f);
    std::cout << "  bounds: (" << result.bounds.min.x << "," << result.bounds.min.y << "," << result.bounds.min.z << ") to ("
               << result.bounds.max.x << "," << result.bounds.max.y << "," << result.bounds.max.z << "), open edges=" << open << "\n";

    assert(open == 0 && "an intersection of two closed solids must stay watertight");
    assert(near(result.bounds.min.x, 5.0f) && near(result.bounds.max.x, 10.0f) && "the intersection is exactly the overlap, (5,5,5) to (10,10,10)");
    assert(near(result.bounds.min.y, 5.0f) && near(result.bounds.max.y, 10.0f));
    assert(near(result.bounds.min.z, 5.0f) && near(result.bounds.max.z, 10.0f));

    std::cout << "  [PASS]\n";
}

} // namespace

int main() {
    testSubtractCutsAWatertightTunnel();
    testUnionOfDisjointBoxesConcatenates();
    testIntersectIsTheSharedRegion();
    std::cout << "[Test BooleanCSG] All boolean_mesh (union/subtract/intersect) tests passed.\n";
    return 0;
}
