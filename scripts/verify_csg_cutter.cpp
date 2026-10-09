/********************************************************************************
 * Verification suite for Scratchbox C++20 Exact Planar CSG Cutter
 * and 2D Mount Clearance Interval Solver.
 ********************************************************************************/

#include <iostream>
#include <cassert>
#include <vector>
#include <cmath>

#include "scratchbox_csg.hpp"

int main() {
    std::cout << "Testing Scratchbox C++20 CSG & Mount Clearance Engine..." << std::endl;

    using namespace scratchbox;
    using namespace scratchbox::csg;
    using namespace scratchbox::math;

    // 1. Test 2D Mount Clearance Interval Solver
    std::vector<ApertureSpec> obstacles;
    ApertureSpec obs1;
    obs1.centerOffset = Vec2(0.0f, 0.0f);
    obs1.size = Vec2(3.0f, 18.0f);
    obstacles.push_back(obs1);

    ApertureSpec obs2;
    obs2.centerOffset = Vec2(-6.0f, 0.0f);
    obs2.size = Vec2(2.0f, 18.0f);
    obstacles.push_back(obs2);

    auto clearance = solveMountClearanceInterval(
        20.0f, // wall width
        24.0f, // wall height
        obstacles,
        2.5f,  // target attachment width (e.g. fire escape width)
        18.0f, // target attachment height
        0.3f   // safety clearance margin
    );

    assert(clearance.found && "Clearance interval solver failed to find valid aperture spacing");
    assert(clearance.minClearanceMeters >= 0.3f && "Clearance margin violates minimum buffer");
    std::cout << "✔ [PASS] C++20 Mount Clearance Interval Solved: U=" 
              << clearance.solvedCenterOffset.x << "m, margin=" << clearance.minClearanceMeters << "m" << std::endl;

    // 2. Test Exact Planar Aperture Cutter
    std::vector<ApertureSpec> apertures;
    // 6 floors x 4 bays of windows
    float floorHeight = 3.5f;
    for (int floor = 0; floor < 6; ++floor) {
        float y = -9.0f + floor * floorHeight;
        for (int bay = 0; bay < 4; ++bay) {
            float x = -6.0f + bay * 4.0f;
            ApertureSpec win;
            win.centerOffset = Vec2(x, y);
            win.size = Vec2(1.6f, 2.2f);
            win.recessDepth = 0.25f;
            win.sillHeight = 0.08f;
            win.sillDepth = 0.12f;
            win.confidence = 0.95f; // measured
            apertures.push_back(win);
        }
    }

    geometry::ScratchboxMesh facadeMesh;
    generateFacadeWithApertures(
        facadeMesh,
        Vec3(0.0f, 11.0f, 0.0f), // wall center
        Vec3(1.0f, 0.0f, 0.0f),  // U direction
        Vec3(0.0f, 1.0f, 0.0f),  // V direction
        20.0f,                   // width
        22.0f,                   // height
        apertures
    );

    assert(facadeMesh.vertices.size() > 50 && "Facade mesh should have subdivided aperture vertices");
    assert(facadeMesh.indices.size() > 100 && "Facade mesh should have triangulated faces");

    // Verify confidence and reveal tags in COLOR_0
    bool hasRevealFlag = false;
    bool hasWallConfidence = false;
    for (const auto& v : facadeMesh.vertices) {
        if (std::abs(v.color.x - 0.95f) < 0.05f) {
            hasWallConfidence = true;
        }
        if (v.color.y > 0.5f) {
            hasRevealFlag = true;
        }
    }

    assert(hasWallConfidence && "Wall confidence not encoded in COLOR_0.r");
    assert(hasRevealFlag && "Aperture reveal flag not encoded in COLOR_0.g");

    std::cout << "✔ [PASS] C++20 Exact Planar Facade Generated: "
              << facadeMesh.vertices.size() << " vertices, "
              << facadeMesh.indices.size() / 3 << " triangles." << std::endl;
    std::cout << "ALL C++20 CSG CUTTER INVARIANTS SATISFIED!" << std::endl;

    return 0;
}
