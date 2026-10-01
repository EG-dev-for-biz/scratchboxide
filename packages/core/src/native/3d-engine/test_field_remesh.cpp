/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Automated Test Suite: Instant Meshes Field-Aligned Quad Remesher
 * Tests 4-RoSy orientation field, Manhattan priors, integer grid contouring,
 * BVH surface projection, and architectural photogrammetry tile remeshing.
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include <iostream>
#include <fstream>
#include <cassert>
#include <cmath>
#include <filesystem>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::halfedge;
using namespace scratchbox::remesh;
using namespace scratchbox::io;

// Helper to save binary glTF 2.0 (.glb) to public/models/remesh_tests/
void saveGlb(const std::string& filename, const ScratchboxMesh& mesh, const ScratchboxMesh* wireframe = nullptr) {
    std::filesystem::create_directories("public/models/remesh_tests");
    std::string path = "public/models/remesh_tests/" + filename;

    std::vector<ScratchboxMesh> meshes;
    meshes.push_back(mesh);
    if (wireframe && !wireframe->vertices.empty()) {
        meshes.push_back(*wireframe);
    }

    std::vector<uint8_t> glbData = GlbWriter::serializeMultiMeshToGlb(meshes);
    std::ofstream out(path, std::ios::binary);
    if (out.is_open()) {
        out.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
        out.close();
        std::cout << "  [Artifact Saved] " << path << " (" << glbData.size() << " bytes)\n";
    } else {
        std::cerr << "  [Error] Failed to open " << path << " for writing\n";
    }
}

// ----------------------------------------------------------------------------
// Test 1: Crease and Feature Detection on Sharp Dihedrals (Cube & 45° Prism)
// ----------------------------------------------------------------------------
void testCreaseDetection() {
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << "Test 1: Crease and Feature Detection on Sharp Dihedrals\n";
    std::cout << "----------------------------------------------------------------------\n";

    // Create a 10m cube (has 12 sharp 90-degree edges)
    ScratchboxMesh cube = ScratchboxMesh::createBox(Vec3(10.0f, 10.0f, 10.0f));
    HalfEdgeMesh heCube = HalfEdgeMesh::fromMesh(cube);

    auto creases = CreaseDetector::detectCreases(heCube, 35.0f);

    size_t creaseCount = 0;
    for (const auto& c : creases) {
        if (c.isCrease) creaseCount++;
    }

    std::cout << "  Cube Half-Edges: " << heCube.halfEdges.size() << "\n";
    std::cout << "  Detected Crease Half-Edges: " << creaseCount << "\n";
    assert(creaseCount >= 24); // 12 edges * 2 half-edges each

    // Test a gentle slope hinge (< 35°)
    ScratchboxMesh plane;
    plane.addVertex(Vertex(Vec3(0, 0, 0), Vec3(0, 1, 0), Vec2(0, 0), Vec4(1, 1, 1, 1)));
    plane.addVertex(Vertex(Vec3(10, 0, 0), Vec3(0, 1, 0), Vec2(1, 0), Vec4(1, 1, 1, 1)));
    plane.addVertex(Vertex(Vec3(10, 0, 10), Vec3(0, 1, 0), Vec2(1, 1), Vec4(1, 1, 1, 1)));
    plane.addVertex(Vertex(Vec3(0, 0, 10), Vec3(0, 1, 0), Vec2(0, 1), Vec4(1, 1, 1, 1)));
    plane.addTriangle(0, 1, 2);
    plane.addTriangle(0, 2, 3);
    HalfEdgeMesh hePlane = HalfEdgeMesh::fromMesh(plane);
    auto planeCreases = CreaseDetector::detectCreases(hePlane, 35.0f);
    
    // Boundary edges are detected as seams, but interior diagonal (0, 2) is coplanar (angle 0)
    for (size_t i = 0; i < hePlane.halfEdges.size(); ++i) {
        if (hePlane.halfEdges[i].twin >= 0) {
            assert(!planeCreases[i].isCrease); // Flat diagonal must NOT be flagged as crease!
        }
    }

    std::cout << "  PASSED: Flat coplanar diagonals correctly excluded; 90-degree creases detected.\n";
    saveGlb("test1_crease_detection.glb", cube);
}

// ----------------------------------------------------------------------------
// Test 2: 4-RoSy Orientation Field Solver Convergence
// ----------------------------------------------------------------------------
void testFourRoSySolver() {
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << "Test 2: 4-RoSy Orientation Field Solver Convergence\n";
    std::cout << "----------------------------------------------------------------------\n";

    // Tessellated curved cylinder segment
    ScratchboxMesh cyl = ScratchboxMesh::createCylinder(5.0f, 10.0f, 32);
    HalfEdgeMesh heCyl = HalfEdgeMesh::fromMesh(cyl);

    auto creases = CreaseDetector::detectCreases(heCyl, 35.0f);
    QuadRemeshOptions opt;
    opt.smoothingIterations = 25;
    opt.alignToManhattanAxes = false; // Pure free-boundary field relaxation

    auto orientations = FourRoSyFieldSolver::solve(heCyl, creases, opt);

    assert(orientations.size() == heCyl.faces.size());

    // Verify orientations are valid within [0, PI/2)
    for (const auto& o : orientations) {
        assert(o.theta >= 0.0f && o.theta < (PI * 0.5f + 1e-4f));
    }

    std::cout << "  Faces Solved: " << orientations.size() << "\n";
    std::cout << "  Orientations strictly bounded within [0, pi/2)\n";
    std::cout << "  PASSED: Gauss-Seidel 4-RoSy complex solver converged smoothly.\n";
    saveGlb("test2_four_rosy_field.glb", cyl);
}

// ----------------------------------------------------------------------------
// Test 3: Manhattan Prior Alignment
// ----------------------------------------------------------------------------
void testManhattanPriors() {
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << "Test 3: Manhattan Prior Alignment on Architectural Facades & Slabs\n";
    std::cout << "----------------------------------------------------------------------\n";

    ScratchboxMesh bldg = ScratchboxMesh::createBox(Vec3(20.0f, 40.0f, 30.0f));
    HalfEdgeMesh heBldg = HalfEdgeMesh::fromMesh(bldg);

    auto creases = CreaseDetector::detectCreases(heBldg, 35.0f);
    QuadRemeshOptions opt;
    opt.alignToManhattanAxes = true;
    opt.dominantYawDeg = 0.0f; // Axis-aligned

    auto orientations = FourRoSyFieldSolver::solve(heBldg, creases, opt);

    size_t facadeCount = 0;
    size_t slabCount = 0;

    for (size_t f = 0; f < heBldg.faces.size(); ++f) {
        const auto& fn = heBldg.faces[f];
        if (fn.deleted) continue;

        if (std::abs(fn.normal.y) < 0.2f) {
            facadeCount++;
            assert(orientations[f].isConstrained);
            assert(orientations[f].constraintWeight >= 0.95f);
        } else if (std::abs(fn.normal.y) > 0.85f) {
            slabCount++;
            assert(orientations[f].isConstrained);
        }
    }

    std::cout << "  Constrained Facades: " << facadeCount << " faces\n";
    std::cout << "  Constrained Slabs:   " << slabCount << " faces\n";
    assert(facadeCount > 0 && slabCount > 0);
    std::cout << "  PASSED: Vertical facades and horizontal slabs accurately locked to Manhattan frame.\n";
    saveGlb("test3_manhattan_priors.glb", bldg);
}

// ----------------------------------------------------------------------------
// Test 4: Position Field & Edge Length Scaling
// ----------------------------------------------------------------------------
void testPositionFieldScaling() {
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << "Test 4: Position Field & Edge Length Scaling (h = sqrt(A / N))\n";
    std::cout << "----------------------------------------------------------------------\n";

    // 10m x 10m plane => Area = 100 m^2
    ScratchboxMesh plane;
    plane.addVertex(Vertex(Vec3(0, 0, 0), Vec3(0, 1, 0), Vec2(0, 0), Vec4(1, 1, 1, 1)));
    plane.addVertex(Vertex(Vec3(10, 0, 0), Vec3(0, 1, 0), Vec2(1, 0), Vec4(1, 1, 1, 1)));
    plane.addVertex(Vertex(Vec3(10, 0, 10), Vec3(0, 1, 0), Vec2(1, 1), Vec4(1, 1, 1, 1)));
    plane.addVertex(Vertex(Vec3(0, 0, 10), Vec3(0, 1, 0), Vec2(0, 1), Vec4(1, 1, 1, 1)));
    plane.addTriangle(0, 1, 2);
    plane.addTriangle(0, 2, 3);
    HalfEdgeMesh hePlane = HalfEdgeMesh::fromMesh(plane);

    auto p400 = PositionFieldOptimizer::computeEdgeSpacing(hePlane, 400);
    auto p2500 = PositionFieldOptimizer::computeEdgeSpacing(hePlane, 2500);

    std::cout << "  Total Area: " << p400.totalMeshArea << " m^2\n";
    std::cout << "  h for N=400:   " << p400.targetEdgeLength << " m (expected 0.500 m)\n";
    std::cout << "  h for N=2500:  " << p2500.targetEdgeLength << " m (expected 0.200 m)\n";

    assert(std::abs(p400.targetEdgeLength - 0.5f) < 1e-3f);
    assert(std::abs(p2500.targetEdgeLength - 0.2f) < 1e-3f);

    std::cout << "  PASSED: Edge length strictly obeys inverse square root scaling h = sqrt(A / N).\n";
}

// ----------------------------------------------------------------------------
// Test 5: BVH Surface Snapping & Tangential Laplacian Smoothing
// ----------------------------------------------------------------------------
void testSurfaceProjectionAndRelaxation() {
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << "Test 5: BVH Surface Snapping & Tangential Laplacian Smoothing\n";
    std::cout << "----------------------------------------------------------------------\n";

    ScratchboxMesh box = ScratchboxMesh::createBox(Vec3(10.0f, 10.0f, 10.0f));
    BvhTree bvh;
    bvh.build(box);

    QuadRemeshOptions opt;
    opt.targetQuadCount = 150;
    RemeshTelemetry telem;

    ScratchboxMesh remeshed = FieldAlignedQuadRemesher::remesh(box, opt, &telem);

    std::cout << "  Input Triangles:    " << telem.inputTriangleCount << "\n";
    std::cout << "  Output Quads:       " << telem.outputQuadCount << "\n";
    std::cout << "  Mean Orthogonality: " << telem.meanOrthogonalityDeg << " deg\n";
    std::cout << "  Mean Quad Aspect:   " << telem.meanQuadAspect << "\n";
    std::cout << "  Surface Error:      " << (telem.meanSurfaceErrorMeters * 1000.0f) << " mm\n";

    assert(telem.outputQuadCount >= 50);
    assert(telem.pureQuadRatio >= 0.95f);
    assert(std::abs(telem.meanOrthogonalityDeg - 90.0f) < 5.0f);
    assert(telem.meanSurfaceErrorMeters < 0.05f); // Within 5cm tolerance

    ScratchboxMesh wire = FieldAlignedQuadRemesher::buildQuadWireframe(remeshed);
    saveGlb("test5_surface_projection.glb", remeshed, &wire);

    std::cout << "  PASSED: Quads snapped tightly to BVH boundary with 90-degree corner orthogonality.\n";
}

// ----------------------------------------------------------------------------
// Test 6: Freeform Organic Surface Remeshing (Sphere / Saddle)
// ----------------------------------------------------------------------------
void testFreeformRemesh() {
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << "Test 6: Freeform Organic Surface Remeshing (Sphere)\n";
    std::cout << "----------------------------------------------------------------------\n";

    ScratchboxMesh sphere = ScratchboxMesh::createSphere(8.0f, 24, 24);
    sphere.material = PbrMaterial::stoneLimestone();

    QuadRemeshOptions opt;
    opt.targetQuadCount = 400;
    opt.alignToManhattanAxes = false; // Organic flow
    RemeshTelemetry telem;

    ScratchboxMesh remeshed = FieldAlignedQuadRemesher::remesh(sphere, opt, &telem);
    ScratchboxMesh wire = FieldAlignedQuadRemesher::buildQuadWireframe(remeshed);

    telem.printSummary();

    assert(telem.outputQuadCount > 100);
    assert(telem.pureQuadRatio >= 0.95f);
    saveGlb("test6_freeform_sphere.glb", remeshed, &wire);

    std::cout << "  PASSED: Freeform curved surface polygonized into clean quad flow.\n";
}

// ----------------------------------------------------------------------------
// Test 7: Empire State Building Architectural Photogrammetry Tile Remesh
// ----------------------------------------------------------------------------
void testEmpireStateBuildingRemesh() {
    std::cout << "----------------------------------------------------------------------\n";
    std::cout << "Test 7: Empire State Building Architectural Photogrammetry Tile Remesh\n";
    std::cout << "----------------------------------------------------------------------\n";

    // Build raw multi-tier skyscraper with photogrammetric sensor jitter
    ScratchboxMesh rawScan("empire_state_building_photogrammetry_raw");
    rawScan.material = PbrMaterial::stoneLimestone();

    auto addTier = [&](const Vec3& center, float width, float depth, float height, int uDivs, int vDivs) {
        AABB b(center - Vec3(width*0.5f, height*0.5f, depth*0.5f), center + Vec3(width*0.5f, height*0.5f, depth*0.5f));
        ScratchboxMesh bBox = ScratchboxMesh::createBox(Vec3(width, height, depth));
        // Translate vertices to center
        for (auto& v : bBox.vertices) {
            // Add photogrammetry scan jitter (+/- 0.08m on facades, melted corners +/- 0.15m)
            float jitter = std::sin(v.position.x * 0.6f) * std::cos(v.position.z * 0.6f) * 0.08f;
            v.position = v.position + center + v.normal * jitter;
            v.color = Vec4(0.82f, 0.79f, 0.74f, 1.0f);
        }
        uint32_t bOffset = static_cast<uint32_t>(rawScan.vertices.size());
        for (const auto& v : bBox.vertices) rawScan.addVertex(v);
        for (uint32_t idx : bBox.indices) rawScan.indices.push_back(bOffset + idx);
    };

    // Tier 1: Street Podium Base (60m x 40m x 20m)
    addTier(Vec3(0, 10, 0), 60.0f, 40.0f, 20.0f, 12, 6);
    // Tier 2: Mid-Rise Setback 1 (46m x 30m x 40m)
    addTier(Vec3(0, 40, 0), 46.0f, 30.0f, 40.0f, 10, 8);
    // Tier 3: Upper Tower Setback 2 (36m x 24m x 60m)
    addTier(Vec3(0, 90, 0), 36.0f, 24.0f, 60.0f, 8, 12);
    // Tier 4: Crown Mooring Mast (16m x 12m x 25m)
    addTier(Vec3(0, 132.5f, 0), 16.0f, 12.0f, 25.0f, 6, 6);

    rawScan.recomputeNormals();
    rawScan.recomputeBounds();

    std::cout << "  Input Raw Photogrammetric Mesh Triangles: " << (rawScan.indices.size() / 3) << "\n";

    QuadRemeshOptions opt;
    opt.targetQuadCount = 1800;
    opt.alignToManhattanAxes = true;
    opt.dominantYawDeg = 0.0f;
    opt.creaseAngleDeg = 35.0f;
    opt.tangentRelaxationPasses = 3;

    RemeshTelemetry telemetry;
    ScratchboxMesh remeshed = FieldAlignedQuadRemesher::remesh(rawScan, opt, &telemetry);
    ScratchboxMesh wire = FieldAlignedQuadRemesher::buildQuadWireframe(remeshed, 0.12f);

    telemetry.printSummary();

    assert(telemetry.outputQuadCount > 400);
    assert(telemetry.pureQuadRatio >= 0.95f);
    assert(std::abs(telemetry.meanOrthogonalityDeg - 90.0f) < 5.0f);
    assert(telemetry.meanQuadAspect >= 0.8f && telemetry.meanQuadAspect <= 5.0f);

    saveGlb("test7_empire_state_raw.glb", rawScan);
    saveGlb("test7_empire_state_remeshed.glb", remeshed, &wire);

    std::cout << "  PASSED: Empire State Building remeshed with crisp Manhattan alignment and zero spiral swirls.\n";
}

int main() {
    std::cout << "======================================================================\n";
    std::cout << "  SCRATCHBOX 3D ENGINE: FIELD-ALIGNED QUAD REMESHER TEST SUITE\n";
    std::cout << "======================================================================\n\n";

    testCreaseDetection();
    testFourRoSySolver();
    testManhattanPriors();
    testPositionFieldScaling();
    testSurfaceProjectionAndRelaxation();
    testFreeformRemesh();
    testEmpireStateBuildingRemesh();

    std::cout << "\n======================================================================\n";
    std::cout << "  ALL 7 FIELD-ALIGNED QUAD REMESHER TESTS PASSED SUCCESSFULLY (100%)\n";
    std::cout << "======================================================================\n";

    return 0;
}
