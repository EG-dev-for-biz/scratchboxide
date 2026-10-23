#include "scratchbox_engine.hpp"
#include <cassert>
#include <cmath>
#include <iostream>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::architecture;

namespace {

bool near(float a, float b, float eps = 1e-3f) { return std::abs(a - b) < eps; }

// A 1-story curved building's roof must sit right on top of its single built floor, not one extra
// floorHeight above it: the gap between two configs that differ only by one floor must equal exactly
// one floorHeight, since the roof (and everything above it) rides on the same `totalH`.
void testCurvedBuildingNoFloatingRoof() {
    std::cout << "[Test Building] generateCurvedBuilding: 1-story roof height + plinth ground cap...\n";

    BuildingConfig cfg;
    cfg.width = 14.0f;
    cfg.depth = 11.0f;
    cfg.curvature = 0.6f; // routes generateBuilding -> generateCurvedBuilding
    cfg.roofType = RoofType::FlatParapet;
    cfg.floorCount = 1;
    cfg.floorHeight = 3.4f;
    cfg.groundFloorHeight = 4.2f;
    cfg.plinthHeight = 0.6f;

    ScratchboxMesh one = ProceduralBuildingGenerator::generateBuilding(cfg, "Curved1");
    cfg.floorCount = 2;
    ScratchboxMesh two = ProceduralBuildingGenerator::generateBuilding(cfg, "Curved2");

    float diff = two.bounds.max.y - one.bounds.max.y;
    std::cout << "  1-story max.y=" << one.bounds.max.y << ", 2-story max.y=" << two.bounds.max.y
              << ", diff=" << diff << " (expected floorHeight=" << cfg.floorHeight << ")\n";
    // Pre-fix this was 0 (floorCount==1 got std::max(1, 0)==1, the same extra floorHeight baked into
    // *every* floorCount, so adding a real second floor changed nothing about where the roof sat).
    assert(near(diff, cfg.floorHeight, 0.05f) && "the roof must move up by exactly one floorHeight when a floor is added, not float independently of floorCount");

    // The curved plinth must be a closed solid at y = 0: the ground-contact cap fan's center vertex.
    int originVerts = 0;
    for (const auto& v : one.vertices) if (v.position.length() < 1e-4f) ++originVerts;
    std::cout << "  vertices at the origin (ground cap fan centers): " << originVerts << "\n";
    assert(originVerts > 0 && "the curved plinth must have a bottom ground-contact cap closing it at y=0");

    std::cout << "  [PASS]\n";
}

// The rectilinear flat-parapet roof's deck must be flush with, and share its outer edge with, the
// parapet's own inner wall — not float disconnected 1m below the coping and 0.35m inset with nothing
// closing the gap.
void testFlatParapetRoofDeckConnected() {
    std::cout << "[Test Building] generateFlatParapetRoof (rectilinear): deck <-> inner parapet wall connection...\n";

    BuildingConfig cfg;
    cfg.width = 16.0f;
    cfg.depth = 12.0f;
    cfg.floorCount = 3;
    cfg.floorHeight = 3.2f;
    cfg.groundFloorHeight = 4.0f;
    cfg.plinthHeight = 0.6f;
    cfg.roofType = RoofType::FlatParapet;
    cfg.parapetHeight = 1.1f;
    cfg.parapetThickness = 0.35f;
    // generateBuilding routes to generateCurvedBuilding (already-correct inner-wall code, a different
    // function) whenever superellipseExponent < 8.0 — the BuildingConfig default (2.4f). Push it above
    // that threshold so this test actually exercises the rectilinear generateFlatParapetRoof being fixed.
    cfg.superellipseExponent = 10.0f;

    ScratchboxMesh mesh = ProceduralBuildingGenerator::generateBuilding(cfg, "FlatParapetBuilding");

    float totalH = cfg.plinthHeight + cfg.groundFloorHeight + cfg.floorHeight * static_cast<float>(cfg.floorCount - 1);
    float inX = cfg.width * 0.5f - cfg.parapetThickness;
    float inZ = cfg.depth * 0.5f - cfg.parapetThickness;
    const float oldBuggyDeckY = totalH + 0.1f;

    auto hasVertexNear = [&](const Vec3& p) {
        for (const auto& v : mesh.vertices) if ((v.position - p).length() < 1e-3f) return true;
        return false;
    };

    // All four deck/inner-wall corners now sit at the SAME position (totalH, inset by parapetThickness):
    // this is what makes the deck and the inner parapet wall manifold-connected rather than two
    // disjoint plates.
    Vec3 corners[4] = {
        Vec3(inX, totalH, inZ), Vec3(-inX, totalH, inZ),
        Vec3(inX, totalH, -inZ), Vec3(-inX, totalH, -inZ)
    };
    for (const auto& c : corners) {
        std::cout << "  corner (" << c.x << ", " << c.y << ", " << c.z << ") present: " << hasVertexNear(c) << "\n";
        assert(hasVertexNear(c) && "the deck's corner must exist at totalH, flush with the inner parapet wall's bottom edge");
    }

    // The old, disconnected deck height (totalH + 0.1, inset, with no connecting wall) must be gone.
    bool anyOldDeckVertex = hasVertexNear(Vec3(inX, oldBuggyDeckY, inZ)) || hasVertexNear(Vec3(-inX, oldBuggyDeckY, -inZ));
    assert(!anyOldDeckVertex && "the roof deck must no longer sit at the old disconnected totalH+0.1 height");

    std::cout << "  [PASS]\n";
}

// BarrelVault has no roof geometry of its own yet; it must not silently fall through to the flat-parapet
// default (a shape unrelated to what was asked for). Routed to the dome branch instead, it should rise a
// real curved amount above totalH, not sit at the flat parapet's much smaller fixed height.
void testBarrelVaultRoutesToCurvedRoof() {
    std::cout << "[Test Building] BarrelVault: routes to a curved roof, not the flat-parapet default...\n";

    BuildingConfig cfg;
    cfg.width = 10.0f;
    cfg.depth = 8.0f;
    cfg.floorCount = 1;
    cfg.floorHeight = 3.4f;
    cfg.groundFloorHeight = 4.0f;
    cfg.plinthHeight = 0.5f;
    cfg.roofType = RoofType::BarrelVault;

    ScratchboxMesh mesh = ProceduralBuildingGenerator::generateBuilding(cfg, "Vault");
    float totalH = cfg.plinthHeight + cfg.groundFloorHeight;
    std::cout << "  bounds.max.y=" << mesh.bounds.max.y << " (totalH=" << totalH << ")\n";
    // A flat-parapet roof would top out at totalH + parapetHeight (default 1.1f); the dome branch's default
    // rise is min(halfW, halfD) * 0.65, noticeably more for this config (2.6).
    assert(mesh.bounds.max.y > totalH + 2.0f && "BarrelVault must route to the dome branch's curved roof height, not the flat-parapet default");

    std::cout << "  [PASS]\n";
}

// generateRoof's totalH (the rectilinear, non-curved path) must not invert when floorCount==0 — reachable
// by constructing BuildingConfig directly, bypassing create_building's Python-side clamp.
void testGenerateRoofZeroFloorsNoInversion() {
    std::cout << "[Test Building] generateRoof: floorCount=0 does not sink the roof below the plinth...\n";

    BuildingConfig cfg;
    cfg.width = 10.0f;
    cfg.depth = 8.0f;
    cfg.superellipseExponent = 10.0f; // force the rectilinear path (generateRoof), not generateCurvedBuilding
    cfg.floorCount = 0;
    cfg.floorHeight = 3.4f;
    cfg.groundFloorHeight = 4.0f;
    cfg.plinthHeight = 0.5f;
    cfg.roofType = RoofType::FlatParapet;

    ScratchboxMesh mesh = ProceduralBuildingGenerator::generateBuilding(cfg, "ZeroFloors");
    float expected = cfg.plinthHeight + cfg.groundFloorHeight;
    std::cout << "  bounds.max.y=" << mesh.bounds.max.y << " (expected roof at/above " << expected << ")\n";
    // Pre-fix, floorCount-1 == -1 subtracted a whole floorHeight instead of adding none, sinking the roof
    // below plinth + groundFloorHeight.
    assert(mesh.bounds.max.y >= expected - 0.01f && "the roof must not sink below plinth + groundFloorHeight when floorCount=0");

    std::cout << "  [PASS]\n";
}

} // namespace

int main() {
    testCurvedBuildingNoFloatingRoof();
    testFlatParapetRoofDeckConnected();
    testBarrelVaultRoutesToCurvedRoof();
    testGenerateRoofZeroFloorsNoInversion();
    std::cout << "[Test Building] All curved-building + flat-parapet-roof fix tests passed.\n";
    return 0;
}
