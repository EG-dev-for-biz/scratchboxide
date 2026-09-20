#include "scratchbox_engine.hpp"
#include "scratchbox_pbr_50_library.hpp"

#include <iostream>
#include <vector>
#include <cmath>
#include <string>
#include <chrono>
#include <algorithm>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::pbr_texture;
using namespace scratchbox::texture;
using namespace scratchbox::io;

// ============================================================================
// Core Geometry Helpers: Outward-Facing Quads & Boxes
// ============================================================================

inline void addOutwardQuad(
    ScratchboxMesh& mesh,
    const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3,
    const Vec3& normal,
    const Vec4& color,
    float scaleU = 1.0f,
    float scaleV = 1.0f
) {
    uint32_t base = static_cast<uint32_t>(mesh.vertices.size());

    Vec2 uv0, uv1, uv2, uv3;
    if (std::abs(normal.y) > 0.7f) {
        // Horizontal (+Y / -Y)
        uv0 = { p0.x * scaleU, p0.z * scaleV };
        uv1 = { p1.x * scaleU, p1.z * scaleV };
        uv2 = { p2.x * scaleU, p2.z * scaleV };
        uv3 = { p3.x * scaleU, p3.z * scaleV };
    } else if (std::abs(normal.z) > 0.7f) {
        // North / South (+Z / -Z)
        float signZ = normal.z > 0.0f ? 1.0f : -1.0f;
        uv0 = { signZ * p0.x * scaleU, p0.y * scaleV };
        uv1 = { signZ * p1.x * scaleU, p1.y * scaleV };
        uv2 = { signZ * p2.x * scaleU, p2.y * scaleV };
        uv3 = { signZ * p3.x * scaleU, p3.y * scaleV };
    } else {
        // East / West (+X / -X)
        float signX = normal.x > 0.0f ? -1.0f : 1.0f;
        uv0 = { signX * p0.z * scaleU, p0.y * scaleV };
        uv1 = { signX * p1.z * scaleU, p1.y * scaleV };
        uv2 = { signX * p2.z * scaleU, p2.y * scaleV };
        uv3 = { signX * p3.z * scaleU, p3.y * scaleV };
    }

    mesh.addVertex({p0, normal, uv0, color});
    mesh.addVertex({p1, normal, uv1, color});
    mesh.addVertex({p2, normal, uv2, color});
    mesh.addVertex({p3, normal, uv3, color});

    // CCW Front-Face Triangles
    mesh.addTriangle(base, base + 1, base + 2);
    mesh.addTriangle(base, base + 2, base + 3);
}

inline void addBoxMetric(
    ScratchboxMesh& mesh,
    const Vec3& center,
    const Vec3& size,
    const Vec4& color,
    float scaleU = 1.0f,
    float scaleV = 1.0f
) {
    Vec3 h = size * 0.5f;

    // 8 Corner Vertices
    Vec3 v001 = center + Vec3(-h.x, -h.y,  h.z);
    Vec3 v101 = center + Vec3( h.x, -h.y,  h.z);
    Vec3 v111 = center + Vec3( h.x,  h.y,  h.z);
    Vec3 v011 = center + Vec3(-h.x,  h.y,  h.z);
    Vec3 v000 = center + Vec3(-h.x, -h.y, -h.z);
    Vec3 v100 = center + Vec3( h.x, -h.y, -h.z);
    Vec3 v110 = center + Vec3( h.x,  h.y, -h.z);
    Vec3 v010 = center + Vec3(-h.x,  h.y, -h.z);

    // Front (+Z, 33rd St)
    addOutwardQuad(mesh, v001, v101, v111, v011, Vec3(0, 0, 1), color, scaleU, scaleV);
    // Back (-Z, 34th St)
    addOutwardQuad(mesh, v100, v000, v010, v110, Vec3(0, 0, -1), color, scaleU, scaleV);
    // Left (-X, 6th Ave / West)
    addOutwardQuad(mesh, v000, v001, v011, v010, Vec3(-1, 0, 0), color, scaleU, scaleV);
    // Right (+X, 5th Ave / East)
    addOutwardQuad(mesh, v101, v100, v110, v111, Vec3(1, 0, 0), color, scaleU, scaleV);
    // Top (+Y, Sky)
    addOutwardQuad(mesh, v011, v111, v110, v010, Vec3(0, 1, 0), color, scaleU, scaleV);
    // Bottom (-Y, Ground)
    addOutwardQuad(mesh, v000, v100, v101, v001, Vec3(0, -1, 0), color, scaleU, scaleV);
}

inline void addCylinderMetric(
    ScratchboxMesh& mesh,
    const Vec3& baseCenter,
    float radius,
    float height,
    int segments,
    const Vec4& color,
    float scaleU = 1.0f,
    float scaleV = 1.0f
) {
    const float dTheta = 6.2831853f / static_cast<float>(segments);
    for (int i = 0; i < segments; ++i) {
        float t0 = static_cast<float>(i) * dTheta;
        float t1 = static_cast<float>(i + 1) * dTheta;

        float c0 = std::cos(t0), s0 = std::sin(t0);
        float c1 = std::cos(t1), s1 = std::sin(t1);

        Vec3 b0 = baseCenter + Vec3(c0 * radius, 0.0f, s0 * radius);
        Vec3 b1 = baseCenter + Vec3(c1 * radius, 0.0f, s1 * radius);
        Vec3 top0 = b0 + Vec3(0.0f, height, 0.0f);
        Vec3 top1 = b1 + Vec3(0.0f, height, 0.0f);

        Vec3 n0(c0, 0.0f, s0);
        Vec3 n1(c1, 0.0f, s1);
        Vec3 nMid = ((n0 + n1) * 0.5f).normalized();

        uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
        float u0 = (static_cast<float>(i) / static_cast<float>(segments)) * scaleU;
        float u1 = (static_cast<float>(i + 1) / static_cast<float>(segments)) * scaleU;

        mesh.addVertex({b0, nMid, {u0, 0.0f}, color});
        mesh.addVertex({b1, nMid, {u1, 0.0f}, color});
        mesh.addVertex({top1, nMid, {u1, height * scaleV}, color});
        mesh.addVertex({top0, nMid, {u0, height * scaleV}, color});

        mesh.addTriangle(base, base + 1, base + 2);
        mesh.addTriangle(base, base + 2, base + 3);
    }
}

// ============================================================================
// Architectural Wall Segment Builders (Pier-and-Aperture System)
// ============================================================================

enum class FacadeFacing {
    EAST_5TH_AVE,  // +X
    WEST_6TH_AVE,  // -X
    SOUTH_33RD_ST, // +Z
    NORTH_34TH_ST  // -Z
};

// Generates an outward-facing window bay between two projecting limestone piers
inline void addApertureWindowBay(
    ScratchboxMesh& meshLimestone,
    ScratchboxMesh& meshGlazing,
    ScratchboxMesh& meshSpandrel,
    ScratchboxMesh& meshSteel,
    FacadeFacing facing,
    float wallLine,          // Exterior pier face coordinate
    float bayStart,          // Horizontal start coordinate along facade
    float bayEnd,            // Horizontal end coordinate along facade
    float yFloor,            // Floor slab elevation
    float floorHeight,       // Floor-to-floor height
    int windowCount,         // 1, 2, or 3 windows in this bay
    const Vec4& colLimestone,
    const Vec4& colGlazing,
    const Vec4& colSpandrel,
    const Vec4& colSteel
) {
    const float hSpandrel = 1.15f;
    const float hSill = 0.14f;
    const float hWin = floorHeight - hSpandrel - 0.25f;
    const float dRecess = 0.22f; // 22cm reveal depth

    float ySpandrelBase = yFloor;
    float ySpandrelTop = yFloor + hSpandrel;
    float ySill = ySpandrelTop;
    float yWinBase = ySill + hSill;
    float yWinTop = yWinBase + hWin;
    float yLintel = yWinTop;
    float yCeiling = yFloor + floorHeight;

    float hLintel = yCeiling - yLintel;

    Vec3 normal, tangent, forward;
    if (facing == FacadeFacing::EAST_5TH_AVE) {
        normal = Vec3(1, 0, 0);   // Points East
        tangent = Vec3(0, 0, -1); // Along -Z
        forward = Vec3(1, 0, 0);
    } else if (facing == FacadeFacing::WEST_6TH_AVE) {
        normal = Vec3(-1, 0, 0);  // Points West
        tangent = Vec3(0, 0, 1);  // Along +Z
        forward = Vec3(-1, 0, 0);
    } else if (facing == FacadeFacing::SOUTH_33RD_ST) {
        normal = Vec3(0, 0, 1);   // Points South
        tangent = Vec3(1, 0, 0);  // Along +X
        forward = Vec3(0, 0, 1);
    } else { // NORTH_34TH_ST
        normal = Vec3(0, 0, -1);  // Points North
        tangent = Vec3(-1, 0, 0); // Along -X
        forward = Vec3(0, 0, -1);
    }

    auto getPt = [&](float s, float y, float f) -> Vec3 {
        if (facing == FacadeFacing::EAST_5TH_AVE || facing == FacadeFacing::WEST_6TH_AVE) {
            float x = wallLine + f * forward.x;
            float z = s;
            return Vec3(x, y, z);
        } else {
            float x = s;
            float z = wallLine + f * forward.z;
            return Vec3(x, y, z);
        }
    };

    float s0 = bayStart;
    float s1 = bayEnd;
    if (s0 > s1) std::swap(s0, s1);

    // 1. Spandrel Panel (Art Deco Chevron, recessed by 12cm)
    float fSpandrel = -0.12f;
    Vec3 sp0 = getPt(s0, ySpandrelBase, fSpandrel);
    Vec3 sp1 = getPt(s1, ySpandrelBase, fSpandrel);
    Vec3 sp2 = getPt(s1, ySpandrelTop, fSpandrel);
    Vec3 sp3 = getPt(s0, ySpandrelTop, fSpandrel);
    if (facing == FacadeFacing::EAST_5TH_AVE || facing == FacadeFacing::NORTH_34TH_ST) {
        addOutwardQuad(meshSpandrel, sp1, sp0, sp3, sp2, normal, colSpandrel, 1.0f / 1.8f, 1.0f / 1.2f);
    } else {
        addOutwardQuad(meshSpandrel, sp0, sp1, sp2, sp3, normal, colSpandrel, 1.0f / 1.8f, 1.0f / 1.2f);
    }

    // 2. Projecting Limestone Sill
    float fSillFront = -0.06f;
    float fSillBack = -dRecess - 0.05f;
    Vec3 sillCenter = getPt((s0 + s1) * 0.5f, ySill + hSill * 0.5f, (fSillFront + fSillBack) * 0.5f);
    Vec3 sillSize;
    if (facing == FacadeFacing::EAST_5TH_AVE || facing == FacadeFacing::WEST_6TH_AVE) {
        sillSize = Vec3(std::abs(fSillFront - fSillBack), hSill, (s1 - s0) + 0.10f);
    } else {
        sillSize = Vec3((s1 - s0) + 0.10f, hSill, std::abs(fSillFront - fSillBack));
    }
    addBoxMetric(meshLimestone, sillCenter, sillSize, colLimestone, 1.0f / 2.0f, 1.0f / 0.5f);

    // 3. Recessed Glazing & Stainless Steel Mullions
    float fGlass = -dRecess;
    float winWidth = ((s1 - s0) - (windowCount - 1) * 0.18f) / static_cast<float>(windowCount);

    for (int w = 0; w < windowCount; ++w) {
        float ws0 = s0 + static_cast<float>(w) * (winWidth + 0.18f);
        float ws1 = ws0 + winWidth;

        Vec3 g0 = getPt(ws0, yWinBase, fGlass);
        Vec3 g1 = getPt(ws1, yWinBase, fGlass);
        Vec3 g2 = getPt(ws1, yWinTop, fGlass);
        Vec3 g3 = getPt(ws0, yWinTop, fGlass);

        if (facing == FacadeFacing::EAST_5TH_AVE || facing == FacadeFacing::NORTH_34TH_ST) {
            addOutwardQuad(meshGlazing, g1, g0, g3, g2, normal, colGlazing, 1.0f / 1.5f, 1.0f / 2.2f);
        } else {
            addOutwardQuad(meshGlazing, g0, g1, g2, g3, normal, colGlazing, 1.0f / 1.5f, 1.0f / 2.2f);
        }

        if (w < windowCount - 1) {
            float ms0 = ws1;
            float ms1 = ms0 + 0.18f;
            Vec3 mulCenter = getPt((ms0 + ms1) * 0.5f, (yWinBase + yWinTop) * 0.5f, fGlass + 0.04f);
            Vec3 mulSize;
            if (facing == FacadeFacing::EAST_5TH_AVE || facing == FacadeFacing::WEST_6TH_AVE) {
                mulSize = Vec3(0.10f, hWin, 0.18f);
            } else {
                mulSize = Vec3(0.18f, hWin, 0.10f);
            }
            addBoxMetric(meshSteel, mulCenter, mulSize, colSteel, 1.0f / 0.3f, 1.0f / 2.0f);
        }
    }

    // 4. Reveal Returns (Window Jambs on Left and Right)
    Vec3 jL0 = getPt(s0, yWinBase, fGlass);
    Vec3 jL1 = getPt(s0, yWinBase, 0.0f);
    Vec3 jL2 = getPt(s0, yWinTop, 0.0f);
    Vec3 jL3 = getPt(s0, yWinTop, fGlass);
    Vec3 nJambL = tangent;
    addOutwardQuad(meshLimestone, jL0, jL1, jL2, jL3, nJambL, colLimestone, 1.0f / 0.5f, 1.0f / 2.0f);

    Vec3 jR0 = getPt(s1, yWinBase, 0.0f);
    Vec3 jR1 = getPt(s1, yWinBase, fGlass);
    Vec3 jR2 = getPt(s1, yWinTop, fGlass);
    Vec3 jR3 = getPt(s1, yWinTop, 0.0f);
    Vec3 nJambR = -tangent;
    addOutwardQuad(meshLimestone, jR0, jR1, jR2, jR3, nJambR, colLimestone, 1.0f / 0.5f, 1.0f / 2.0f);

    // 5. Head Beam / Lintel
    if (hLintel > 0.05f) {
        Vec3 lintelCenter = getPt((s0 + s1) * 0.5f, yLintel + hLintel * 0.5f, -dRecess * 0.5f);
        Vec3 lintelSize;
        if (facing == FacadeFacing::EAST_5TH_AVE || facing == FacadeFacing::WEST_6TH_AVE) {
            lintelSize = Vec3(dRecess, hLintel, s1 - s0);
        } else {
            lintelSize = Vec3(s1 - s0, hLintel, dRecess);
        }
        addBoxMetric(meshLimestone, lintelCenter, lintelSize, colLimestone, 1.0f / 2.0f, 1.0f / 0.8f);
    }
}

inline void addProjectingPier(
    ScratchboxMesh& meshLimestone,
    FacadeFacing facing,
    float wallLine,
    float pierStart,
    float pierEnd,
    float yBottom,
    float yTop,
    float depth,
    const Vec4& colLimestone
) {
    float s0 = pierStart;
    float s1 = pierEnd;
    if (s0 > s1) std::swap(s0, s1);
    float width = s1 - s0;
    float height = yTop - yBottom;
    float yMid = yBottom + height * 0.5f;

    Vec3 center, size;
    if (facing == FacadeFacing::EAST_5TH_AVE) {
        center = Vec3(wallLine - depth * 0.5f, yMid, (s0 + s1) * 0.5f);
        size = Vec3(depth, height, width);
    } else if (facing == FacadeFacing::WEST_6TH_AVE) {
        center = Vec3(wallLine + depth * 0.5f, yMid, (s0 + s1) * 0.5f);
        size = Vec3(depth, height, width);
    } else if (facing == FacadeFacing::SOUTH_33RD_ST) {
        center = Vec3((s0 + s1) * 0.5f, yMid, wallLine - depth * 0.5f);
        size = Vec3(width, height, depth);
    } else { // NORTH_34TH_ST
        center = Vec3((s0 + s1) * 0.5f, yMid, wallLine + depth * 0.5f);
        size = Vec3(width, height, depth);
    }

    addBoxMetric(meshLimestone, center, size, colLimestone, 1.0f / 2.4f, 1.0f / 2.4f);
}

// ============================================================================
// Main Execution
// ============================================================================

int main() {
    auto startTime = std::chrono::high_resolution_clock::now();
    std::cout << "======================================================================\n";
    std::cout << "Native C++20 Generator: Rectified Empire State Building Architectural Hybrid\n";
    std::cout << "Mode: Pier-and-Aperture Facade System with Ground-Truth Entrances & Grand Lobby\n";
    std::cout << "======================================================================\n";

    // Clean neutral multipliers for PBR textures
    Vec4 colLimestone(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colGranite(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colSpandrel(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colSteel(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colGlazing(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colBronze(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colRoof(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colSidewalk(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colInterior(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colPylonEagle(1.0f, 1.0f, 1.0f, 1.0f);

    ScratchboxMesh meshLimestone;
    ScratchboxMesh meshGranite;
    ScratchboxMesh meshSpandrel;
    ScratchboxMesh meshSteel;
    ScratchboxMesh meshGlazing;
    ScratchboxMesh meshBronze;
    ScratchboxMesh meshRoof;
    ScratchboxMesh meshSidewalk;
    ScratchboxMesh meshInterior;
    ScratchboxMesh meshTileSpire;

    // ------------------------------------------------------------------------
    // 1. Clean Grounding & Sidewalk Apron (Y = 0.0m)
    // ------------------------------------------------------------------------
    std::cout << "[1/8] Laying Plumb Foundation, Scored NYC Sidewalk & Contact Shadow Apron...\n";

    addBoxMetric(meshSidewalk, Vec3(-15.0f, -0.075f, 0.0f), Vec3(130.0f, 0.15f, 96.0f), colSidewalk, 1.0f / 2.0f, 1.0f / 2.0f);

    const float xEast = 35.0f;
    const float xWest = -65.0f;
    const float zSouth = 35.0f;
    const float zNorth = -35.0f;
    const float baseCenterX = (xEast + xWest) * 0.5f; // -15.0m
    const float baseCenterZ = 0.0f;
    const float baseW = xEast - xWest; // 100.0m
    const float baseD = zSouth - zNorth; // 70.0m

    // Granite Water Table Plinth (Y = 0.0m to 1.5m)
    addBoxMetric(meshGranite, Vec3(baseCenterX, 0.75f, baseCenterZ), Vec3(baseW, 1.5f, baseD), colGranite, 1.0f / 2.0f, 1.0f / 1.0f);

    // ------------------------------------------------------------------------
    // 2. Skyscraper Structural Core & Floor Slabs (Interior Depth)
    // ------------------------------------------------------------------------
    std::cout << "[2/8] Framing Central Elevator Core (64 Otis Elevators) & Floor Slabs...\n";

    // Central Structural Elevator Core: X in [-26m, 0m], Z in [-12m, 12m], Y from 0 to 320m
    addBoxMetric(meshRoof, Vec3(-13.0f, 160.0f, 0.0f), Vec3(26.0f, 320.0f, 24.0f), colRoof, 1.0f / 4.0f, 1.0f / 4.0f);

    // Floor Slabs for Base (Y = 4.8m to 24.0m every 4.8m)
    for (float ySlab = 4.8f; ySlab <= 24.0f; ySlab += 4.8f) {
        addBoxMetric(meshRoof, Vec3(-15.0f, ySlab - 0.15f, 0.0f), Vec3(98.0f, 0.30f, 68.0f), colRoof, 1.0f / 4.0f, 1.0f / 4.0f);
    }

    // Floor Slabs for Setback Tier 1 (Y = 28.0m to 96.0m every 3.6m)
    for (float ySlab = 28.0f; ySlab <= 96.0f; ySlab += 3.6f) {
        addBoxMetric(meshRoof, Vec3(-15.0f, ySlab - 0.15f, 0.0f), Vec3(66.8f, 0.30f, 48.8f), colRoof, 1.0f / 4.0f, 1.0f / 4.0f);
    }

    // Floor Slabs for Tower Shaft (Y = 99.0m to 318.0m every 3.6m, strictly within X in [-33.4m, +7.4m], Z in [-27.6m, +27.6m])
    for (float ySlab = 99.0f; ySlab <= 318.0f; ySlab += 3.6f) {
        addBoxMetric(meshRoof, Vec3(-13.0f, ySlab - 0.15f, 0.0f), Vec3(40.8f, 0.30f, 55.2f), colRoof, 1.0f / 4.0f, 1.0f / 4.0f);
    }

    // ------------------------------------------------------------------------
    // 3. Ground-Truth 5th Avenue 3-Story Grand Art Deco Lobby & Portal
    // ------------------------------------------------------------------------
    std::cout << "[3/8] Sculpting 5th Avenue 3-Story Monumental Main Portal, Eagle Pylons & Grand Lobby...\n";

    const float pylonProj = 0.85f;

    // Stepped Indiana Limestone Eagle Pylons flanking the portal (Z = -6.8m and +6.8m)
    for (float zPylon : {-6.8f, 6.8f}) {
        // Lower Pylon Pier (Y = 1.5m to 14.0m)
        addBoxMetric(meshLimestone, Vec3(xEast + pylonProj * 0.5f - 0.15f, 7.75f, zPylon), Vec3(pylonProj + 0.3f, 12.5f, 1.4f), colLimestone, 1.0f / 1.5f, 1.0f / 2.0f);
        // Fluted Art Deco Pylon Accents
        addBoxMetric(meshLimestone, Vec3(xEast + pylonProj + 0.05f, 7.75f, zPylon), Vec3(0.12f, 12.0f, 0.9f), colLimestone, 1.0f / 0.5f, 1.0f / 2.0f);
        // Stepped Transition Cornice (Y = 14.0m to 15.2m)
        addBoxMetric(meshLimestone, Vec3(xEast + pylonProj * 0.5f - 0.1f, 14.4f, zPylon), Vec3(pylonProj + 0.2f, 0.8f, 1.5f), colLimestone, 1.0f / 1.0f, 1.0f / 0.5f);
        addBoxMetric(meshLimestone, Vec3(xEast + pylonProj * 0.5f - 0.05f, 15.0f, zPylon), Vec3(pylonProj + 0.1f, 0.4f, 1.35f), colLimestone, 1.0f / 1.0f, 1.0f / 0.5f);
        // Carved Stone American Eagle Sculpture (Y = 15.2m to 17.5m)
        addBoxMetric(meshLimestone, Vec3(xEast + pylonProj * 0.5f, 16.35f, zPylon), Vec3(pylonProj + 0.25f, 2.3f, 1.6f), colPylonEagle, 1.0f / 1.0f, 1.0f / 1.0f);
        // Sculpted folded wings and chest
        addBoxMetric(meshLimestone, Vec3(xEast + pylonProj + 0.12f, 16.2f, zPylon), Vec3(0.20f, 1.8f, 1.3f), colPylonEagle, 1.0f / 0.5f, 1.0f / 1.0f);
        // Bronze Star Medallion at Eagle Base
        addBoxMetric(meshBronze, Vec3(xEast + pylonProj + 0.14f, 15.4f, zPylon), Vec3(0.08f, 0.6f, 0.6f), colBronze, 1.0f / 0.5f, 1.0f / 0.5f);
    }

    // Inscribed Architrave Beam: "EMPIRE STATE" (Y = 13.5m to 14.8m)
    addBoxMetric(meshLimestone, Vec3(xEast + 0.15f, 14.15f, 0.0f), Vec3(0.7f, 1.3f, 12.2f), colLimestone, 1.0f / 2.0f, 1.0f / 1.0f);
    // Raised Bronze Lettering: "EMPIRE STATE"
    addBoxMetric(meshBronze, Vec3(xEast + 0.52f, 14.15f, 0.0f), Vec3(0.05f, 0.65f, 8.8f), colBronze, 1.0f / 3.0f, 1.0f / 0.6f);

    // 3-Story Grand Sunburst Transom Grille & Architectural Glazing (Y = 4.5m to 13.5m, 9m tall!)
    addBoxMetric(meshGlazing, Vec3(xEast - 0.15f, 9.0f, 0.0f), Vec3(0.08f, 9.0f, 11.6f), colGlazing, 1.0f / 2.0f, 1.0f / 3.0f);
    // Monumental Bronze Mullions dividing into 3 tall bays
    addBoxMetric(meshBronze, Vec3(xEast - 0.05f, 9.0f, -1.9f), Vec3(0.22f, 9.0f, 0.35f), colBronze, 1.0f / 0.5f, 1.0f / 3.0f);
    addBoxMetric(meshBronze, Vec3(xEast - 0.05f, 9.0f,  1.9f), Vec3(0.22f, 9.0f, 0.35f), colBronze, 1.0f / 0.5f, 1.0f / 3.0f);
    // Horizontal bronze transom beams
    for (float yg = 6.0f; yg <= 12.0f; yg += 1.5f) {
        addBoxMetric(meshBronze, Vec3(xEast - 0.06f, yg, 0.0f), Vec3(0.14f, 0.14f, 11.2f), colBronze, 1.0f / 2.0f, 1.0f / 0.2f);
    }
    // Art Deco Chevron Radiant Sunburst Tracery
    for (float zOff : {-3.8f, 0.0f, 3.8f}) {
        addBoxMetric(meshBronze, Vec3(xEast - 0.04f, 11.2f, zOff), Vec3(0.10f, 2.2f, 0.12f), colBronze, 1.0f / 0.2f, 1.0f / 1.0f);
        addBoxMetric(meshBronze, Vec3(xEast - 0.04f, 11.8f, zOff - 0.6f), Vec3(0.08f, 1.2f, 0.08f), colBronze, 1.0f / 0.2f, 1.0f / 1.0f);
        addBoxMetric(meshBronze, Vec3(xEast - 0.04f, 11.8f, zOff + 0.6f), Vec3(0.08f, 1.2f, 0.08f), colBronze, 1.0f / 0.2f, 1.0f / 1.0f);
    }

    // Portal Ground Level: Swedish Black Granite Plinth Surround (Y = 0.0m to 4.5m)
    // Left & Right Monumental Granite Jambs
    addBoxMetric(meshGranite, Vec3(xEast - 0.1f, 2.25f, -5.4f), Vec3(0.5f, 4.5f, 1.2f), colGranite, 1.0f / 1.0f, 1.0f / 2.0f);
    addBoxMetric(meshGranite, Vec3(xEast - 0.1f, 2.25f,  5.4f), Vec3(0.5f, 4.5f, 1.2f), colGranite, 1.0f / 1.0f, 1.0f / 2.0f);
    // Intermediate Granite Pilasters between revolving doors
    addBoxMetric(meshGranite, Vec3(xEast - 0.1f, 2.25f, -1.9f), Vec3(0.5f, 4.5f, 0.55f), colGranite, 1.0f / 1.0f, 1.0f / 2.0f);
    addBoxMetric(meshGranite, Vec3(xEast - 0.1f, 2.25f,  1.9f), Vec3(0.5f, 4.5f, 0.55f), colGranite, 1.0f / 1.0f, 1.0f / 2.0f);
    // Transom Lintel Beam above revolving doors (Y = 3.5m to 4.5m)
    addBoxMetric(meshGranite, Vec3(xEast - 0.1f, 4.0f, 0.0f), Vec3(0.5f, 1.0f, 12.0f), colGranite, 1.0f / 2.0f, 1.0f / 1.0f);
    addBoxMetric(meshBronze, Vec3(xEast + 0.16f, 3.65f, 0.0f), Vec3(0.12f, 0.30f, 11.6f), colBronze, 1.0f / 2.0f, 1.0f / 0.3f);

    // 3 Bronze Revolving Doors (Z = -3.8m, 0.0m, +3.8m)
    for (float zDoor : {-3.8f, 0.0f, 3.8f}) {
        // Curved bronze drum canopy top (Y = 3.35m)
        addCylinderMetric(meshBronze, Vec3(xEast + 0.12f, 3.25f, zDoor), 1.35f, 0.25f, 16, colBronze, 1.0f / 1.0f, 1.0f / 0.5f);
        // Curved glass sidewall drum (Y = 0.05m to 3.25m)
        addCylinderMetric(meshGlazing, Vec3(xEast + 0.12f, 0.05f, zDoor), 1.32f, 3.20f, 16, colGlazing, 1.0f / 1.0f, 1.0f / 2.0f);
        // Central brass pivot spindle
        addCylinderMetric(meshBronze, Vec3(xEast + 0.12f, 0.0f, zDoor), 0.06f, 3.35f, 8, colBronze, 1.0f / 0.2f, 1.0f / 2.0f);
        // 4 Revolving Door Leaves (0, 90, 180, 270 deg)
        addBoxMetric(meshBronze, Vec3(xEast + 0.12f + 0.60f, 1.62f, zDoor), Vec3(1.20f, 3.10f, 0.04f), colBronze, 1.0f / 1.0f, 1.0f / 2.0f);
        addBoxMetric(meshBronze, Vec3(xEast + 0.12f - 0.60f, 1.62f, zDoor), Vec3(1.20f, 3.10f, 0.04f), colBronze, 1.0f / 1.0f, 1.0f / 2.0f);
        addBoxMetric(meshBronze, Vec3(xEast + 0.12f, 1.62f, zDoor + 0.60f), Vec3(0.04f, 3.10f, 1.20f), colBronze, 1.0f / 1.0f, 1.0f / 2.0f);
        addBoxMetric(meshBronze, Vec3(xEast + 0.12f, 1.62f, zDoor - 0.60f), Vec3(0.04f, 3.10f, 1.20f), colBronze, 1.0f / 1.0f, 1.0f / 2.0f);
    }

    // ------------------------------------------------------------------------
    // Grand 3-Story Art Deco Lobby Interior (Visible through Transom & Doors)
    // ------------------------------------------------------------------------
    // Hauteville & German Rose Polished Marble Floor (Y = 0.02m)
    addBoxMetric(meshInterior, Vec3(26.4f, 0.02f, 0.0f), Vec3(16.8f, 0.04f, 13.0f), colInterior, 1.0f / 2.0f, 1.0f / 2.0f);
    // Belgian Black Marble Inlay Floor Border
    addBoxMetric(meshGranite, Vec3(26.4f, 0.03f, -6.1f), Vec3(16.8f, 0.02f, 0.45f), colGranite, 1.0f / 2.0f, 1.0f / 0.5f);
    addBoxMetric(meshGranite, Vec3(26.4f, 0.03f,  6.1f), Vec3(16.8f, 0.02f, 0.45f), colGranite, 1.0f / 2.0f, 1.0f / 0.5f);

    // North & South Lobby Walls (Z = +/- 6.4m, Y = 0 to 13.5m)
    addBoxMetric(meshInterior, Vec3(26.4f, 6.75f, -6.4f), Vec3(16.8f, 13.5f, 0.35f), colInterior, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshInterior, Vec3(26.4f, 6.75f,  6.4f), Vec3(16.8f, 13.5f, 0.35f), colInterior, 1.0f / 2.0f, 1.0f / 2.0f);

    // Gilded Stepped Coffered Lobby Ceiling (Y = 13.5m)
    addBoxMetric(meshInterior, Vec3(26.4f, 13.5f, 0.0f), Vec3(16.8f, 0.30f, 13.0f), colInterior, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshBronze, Vec3(26.4f, 13.3f, 0.0f), Vec3(14.0f, 0.15f, 10.0f), colBronze, 1.0f / 2.0f, 1.0f / 2.0f);

    // Iconic West Lobby Wall: Monumental Empire State Building Bas-Relief Mural!
    // Wall Backing at X = 18.0m (Y = 0 to 13.5m, Z in [-6.4m, 6.4m])
    addBoxMetric(meshInterior, Vec3(18.0f, 6.75f, 0.0f), Vec3(0.40f, 13.5f, 12.8f), colInterior, 1.0f / 2.0f, 1.0f / 2.0f);
    // Aluminum & Bronze Empire State Building Silhouette Relief at center
    addBoxMetric(meshBronze, Vec3(18.25f, 6.8f, 0.0f), Vec3(0.12f, 9.6f, 2.4f), colBronze, 1.0f / 1.0f, 1.0f / 2.0f);
    addBoxMetric(meshSteel, Vec3(18.32f, 11.2f, 0.0f), Vec3(0.06f, 2.6f, 0.35f), colSteel, 1.0f / 0.5f, 1.0f / 2.0f);
    // Radiating Celestial Sunburst Rays expanding across the wall
    for (float rayAngle = -1.2f; rayAngle <= 1.2f; rayAngle += 0.35f) {
        float rLen = 5.2f;
        float rY = 7.0f + std::cos(rayAngle) * rLen * 0.5f;
        float rZ = std::sin(rayAngle) * rLen * 0.8f;
        addBoxMetric(meshBronze, Vec3(18.22f, rY, rZ), Vec3(0.08f, 0.12f, rLen * 0.6f), colBronze, 1.0f / 0.5f, 1.0f / 1.0f);
    }

    // ------------------------------------------------------------------------
    // 4. Ground-Truth 33rd & 34th Street Marquee Entrance Canopies
    // ------------------------------------------------------------------------
    std::cout << "[4/8] Installing Streamlined Art Deco Entrance Canopies on 33rd & 34th Streets...\n";

    auto addMarqueeCanopy = [&](float xCenter, float zWall, float forwardSign) {
        float canW = 14.0f;
        float canD = 3.2f;
        float canH = 0.65f;
        float yCan = 4.4f;

        Vec3 center(xCenter, yCan, zWall + forwardSign * canD * 0.5f);
        // Bronze Canopy Body
        addBoxMetric(meshBronze, center, Vec3(canW, canH, canD), colBronze, 1.0f / 2.0f, 1.0f / 0.5f);
        // Stainless Steel Speedline Fascia
        addBoxMetric(meshSteel, center + Vec3(0.0f, 0.0f, forwardSign * (canD * 0.5f + 0.02f)), Vec3(canW + 0.1f, canH * 0.45f, 0.06f), colSteel, 1.0f / 2.0f, 1.0f / 0.2f);
        // Canopy Soffit with 8 Recessed Downlights (Facing Ground)
        addBoxMetric(meshInterior, center - Vec3(0.0f, canH * 0.5f - 0.02f, 0.0f), Vec3(canW - 1.0f, 0.04f, canD - 0.6f), colInterior, 1.0f / 2.0f, 1.0f / 1.0f);
        // 3 Pairs of Bronze Secondary Entrance Doors
        addBoxMetric(meshBronze, Vec3(xCenter, 2.0f, zWall - forwardSign * 0.15f), Vec3(canW - 2.0f, 4.0f, 0.45f), colBronze, 1.0f / 2.0f, 1.0f / 2.0f);
        addBoxMetric(meshGlazing, Vec3(xCenter, 2.0f, zWall + forwardSign * 0.06f), Vec3(canW - 3.2f, 3.2f, 0.08f), colGlazing, 1.0f / 1.5f, 1.0f / 2.0f);
        // Warm Illuminated Entrance Vestibule Backing
        addBoxMetric(meshInterior, Vec3(xCenter, 2.2f, zWall - forwardSign * 1.5f), Vec3(canW - 1.0f, 4.4f, 2.5f), colInterior, 1.0f / 2.0f, 1.0f / 2.0f);
    };

    addMarqueeCanopy(-15.0f, zNorth, -1.0f);
    addMarqueeCanopy(-15.0f, zSouth, 1.0f);

    // ------------------------------------------------------------------------
    // 5. Ground-Truth 5-Story Base Facade (Stories 1 to 5, Y = 1.5m to 25.0m)
    // ------------------------------------------------------------------------
    std::cout << "[5/8] Constructing Monumental 5-Story Base with Projecting Piers & Storefronts...\n";

    // Storefront Plate Glass Windows
    addBoxMetric(meshGlazing, Vec3(xEast + 0.05f, 3.15f, -19.25f), Vec3(0.12f, 3.3f, 22.5f), colGlazing, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshGlazing, Vec3(xEast + 0.05f, 3.15f,  19.25f), Vec3(0.12f, 3.3f, 22.5f), colGlazing, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshBronze, Vec3(xEast + 0.15f, 4.85f, -19.25f), Vec3(0.35f, 0.35f, 23.5f), colBronze, 1.0f / 2.0f, 1.0f / 0.3f);
    addBoxMetric(meshBronze, Vec3(xEast + 0.15f, 4.85f,  19.25f), Vec3(0.35f, 0.35f, 23.5f), colBronze, 1.0f / 2.0f, 1.0f / 0.3f);

    // Storefront Display Vitrine Backings (neutral interior partition)
    addBoxMetric(meshLimestone, Vec3(xEast - 1.2f, 2.8f, -19.25f), Vec3(2.2f, 3.6f, 22.0f), colLimestone, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshLimestone, Vec3(xEast - 1.2f, 2.8f,  19.25f), Vec3(2.2f, 3.6f, 22.0f), colLimestone, 1.0f / 2.0f, 1.0f / 2.0f);

    // North & South Storefronts along 33rd & 34th Streets
    addBoxMetric(meshGlazing, Vec3(-42.0f, 3.15f, zNorth - 0.05f), Vec3(38.0f, 3.3f, 0.12f), colGlazing, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshGlazing, Vec3( 12.0f, 3.15f, zNorth - 0.05f), Vec3(38.0f, 3.3f, 0.12f), colGlazing, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshGlazing, Vec3(-42.0f, 3.15f, zSouth + 0.05f), Vec3(38.0f, 3.3f, 0.12f), colGlazing, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshGlazing, Vec3( 12.0f, 3.15f, zSouth + 0.05f), Vec3(38.0f, 3.3f, 0.12f), colGlazing, 1.0f / 2.0f, 1.0f / 2.0f);

    // Display Interior Backings on North & South
    addBoxMetric(meshLimestone, Vec3(-42.0f, 2.8f, zNorth + 1.2f), Vec3(37.5f, 3.6f, 2.2f), colLimestone, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshLimestone, Vec3( 12.0f, 2.8f, zNorth + 1.2f), Vec3(37.5f, 3.6f, 2.2f), colLimestone, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshLimestone, Vec3(-42.0f, 2.8f, zSouth - 1.2f), Vec3(37.5f, 3.6f, 2.2f), colLimestone, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshLimestone, Vec3( 12.0f, 2.8f, zSouth - 1.2f), Vec3(37.5f, 3.6f, 2.2f), colLimestone, 1.0f / 2.0f, 1.0f / 2.0f);

    // 5th Avenue Base Piers and Windows (Floors 2 to 5)
    std::vector<std::pair<float, float>> base5thAveBays = {
        {-31.0f, -24.0f},
        {-22.5f, -15.5f},
        {-14.0f,  -7.5f},
        {  7.5f,  14.0f},
        { 15.5f,  22.5f},
        { 24.0f,  31.0f}
    };

    std::vector<std::pair<float, float>> base5thAvePiers = {
        {-35.0f, -31.0f},
        {-24.0f, -22.5f},
        {-15.5f, -14.0f},
        {-7.5f,   -6.0f},
        { 6.0f,    7.5f},
        {14.0f,   15.5f},
        {22.5f,   24.0f},
        {31.0f,   35.0f}
    };

    for (const auto& pr : base5thAvePiers) {
        addProjectingPier(meshLimestone, FacadeFacing::EAST_5TH_AVE, xEast, pr.first, pr.second, 5.2f, 25.0f, 0.45f, colLimestone);
    }

    for (float yF = 5.2f; yF < 24.0f; yF += 4.8f) {
        for (const auto& bay : base5thAveBays) {
            addApertureWindowBay(
                meshLimestone, meshGlazing, meshSpandrel, meshSteel,
                FacadeFacing::EAST_5TH_AVE, xEast, bay.first, bay.second,
                yF, 4.8f, 2, colLimestone, colGlazing, colSpandrel, colSteel
            );
        }
        // Central Bay of 3 Windows directly above the 3-story portal (Y > 14.5m)
        if (yF > 14.5f) {
            addApertureWindowBay(
                meshLimestone, meshGlazing, meshSpandrel, meshSteel,
                FacadeFacing::EAST_5TH_AVE, xEast, -4.8f, 4.8f,
                yF, 4.8f, 3, colLimestone, colGlazing, colSpandrel, colSteel
            );
        }
    }

    const float bayStepX = 4.4f;
    for (float x = -61.0f; x <= 30.0f; x += bayStepX) {
        if (x > -21.0f && x < -9.0f) continue;
        float bx0 = x;
        float bx1 = x + 3.1f;
        float px0 = bx1;
        float px1 = x + bayStepX;

        addProjectingPier(meshLimestone, FacadeFacing::SOUTH_33RD_ST, zSouth, px0, px1, 5.2f, 25.0f, 0.40f, colLimestone);
        addProjectingPier(meshLimestone, FacadeFacing::NORTH_34TH_ST, zNorth, px0, px1, 5.2f, 25.0f, 0.40f, colLimestone);

        for (float yF = 5.2f; yF < 24.0f; yF += 4.8f) {
            addApertureWindowBay(
                meshLimestone, meshGlazing, meshSpandrel, meshSteel,
                FacadeFacing::SOUTH_33RD_ST, zSouth, bx0, bx1,
                yF, 4.8f, 2, colLimestone, colGlazing, colSpandrel, colSteel
            );
            addApertureWindowBay(
                meshLimestone, meshGlazing, meshSpandrel, meshSteel,
                FacadeFacing::NORTH_34TH_ST, zNorth, bx0, bx1,
                yF, 4.8f, 2, colLimestone, colGlazing, colSpandrel, colSteel
            );
        }
    }

    for (float z = -31.0f; z <= 27.0f; z += 5.5f) {
        addProjectingPier(meshLimestone, FacadeFacing::WEST_6TH_AVE, xWest, z + 3.8f, z + 5.5f, 5.2f, 25.0f, 0.40f, colLimestone);
        for (float yF = 5.2f; yF < 24.0f; yF += 4.8f) {
            addApertureWindowBay(
                meshLimestone, meshGlazing, meshSpandrel, meshSteel,
                FacadeFacing::WEST_6TH_AVE, xWest, z, z + 3.8f,
                yF, 4.8f, 2, colLimestone, colGlazing, colSpandrel, colSteel
            );
        }
    }

    auto addParapetCoping = [&](float yRoof, float cx, float cz, float w, float d) {
        float hParapet = 1.25f;
        float tParapet = 0.85f;
        addBoxMetric(meshLimestone, Vec3(cx, yRoof + hParapet * 0.5f, cz + d * 0.5f - tParapet * 0.5f), Vec3(w, hParapet, tParapet), colLimestone, 1.0f / 2.4f, 1.0f / 1.2f);
        addBoxMetric(meshLimestone, Vec3(cx, yRoof + hParapet * 0.5f, cz - d * 0.5f + tParapet * 0.5f), Vec3(w, hParapet, tParapet), colLimestone, 1.0f / 2.4f, 1.0f / 1.2f);
        addBoxMetric(meshLimestone, Vec3(cx + w * 0.5f - tParapet * 0.5f, yRoof + hParapet * 0.5f, cz), Vec3(tParapet, hParapet, d - tParapet * 2.0f), colLimestone, 1.0f / 2.4f, 1.0f / 1.2f);
        addBoxMetric(meshLimestone, Vec3(cx - w * 0.5f + tParapet * 0.5f, yRoof + hParapet * 0.5f, cz), Vec3(tParapet, hParapet, d - tParapet * 2.0f), colLimestone, 1.0f / 2.4f, 1.0f / 1.2f);
        addBoxMetric(meshRoof, Vec3(cx, yRoof + 0.05f, cz), Vec3(w - tParapet * 2.0f, 0.1f, d - tParapet * 2.0f), colRoof, 1.0f / 4.0f, 1.0f / 4.0f);
    };

    addParapetCoping(25.0f, baseCenterX, baseCenterZ, baseW, baseD);

    // ------------------------------------------------------------------------
    // 6. Setback Tier 1 (Stories 6 to 29, Y = 25.0m to 98.0m)
    // ------------------------------------------------------------------------
    std::cout << "[6/8] Building Setback Tier 1 with Pier-and-Aperture Fenestration...\n";

    const float t1_w = 68.0f;
    const float t1_d = 50.0f;
    const float t1_cx = -15.0f;
    const float t1_cz = 0.0f;
    const float t1_xEast = t1_cx + t1_w * 0.5f;
    const float t1_xWest = t1_cx - t1_w * 0.5f;
    const float t1_zSouth = t1_cz + t1_d * 0.5f;
    const float t1_zNorth = t1_cz - t1_d * 0.5f;

    // Continuous Indiana Limestone Piers & Corner Piers for Tier 1
    // East & West Piers
    addProjectingPier(meshLimestone, FacadeFacing::EAST_5TH_AVE, t1_xEast, t1_zNorth, t1_zNorth + 3.0f, 25.0f, 98.0f, 0.45f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::WEST_6TH_AVE, t1_xWest, t1_zNorth, t1_zNorth + 3.0f, 25.0f, 98.0f, 0.45f, colLimestone);
    for (float z = t1_zNorth + 3.0f; z <= t1_zSouth - 6.0f; z += 5.2f) {
        addProjectingPier(meshLimestone, FacadeFacing::EAST_5TH_AVE, t1_xEast, z + 3.6f, z + 5.2f, 25.0f, 98.0f, 0.40f, colLimestone);
        addProjectingPier(meshLimestone, FacadeFacing::WEST_6TH_AVE, t1_xWest, z + 3.6f, z + 5.2f, 25.0f, 98.0f, 0.40f, colLimestone);
    }
    addProjectingPier(meshLimestone, FacadeFacing::EAST_5TH_AVE, t1_xEast, 19.6f, t1_zSouth, 25.0f, 98.0f, 0.45f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::WEST_6TH_AVE, t1_xWest, 19.6f, t1_zSouth, 25.0f, 98.0f, 0.45f, colLimestone);

    // South & North Piers
    addProjectingPier(meshLimestone, FacadeFacing::SOUTH_33RD_ST, t1_zSouth, t1_xWest, t1_xWest + 3.0f, 25.0f, 98.0f, 0.45f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::NORTH_34TH_ST, t1_zNorth, t1_xWest, t1_xWest + 3.0f, 25.0f, 98.0f, 0.45f, colLimestone);
    for (float x = t1_xWest + 3.0f; x <= t1_xEast - 6.0f; x += 4.8f) {
        addProjectingPier(meshLimestone, FacadeFacing::SOUTH_33RD_ST, t1_zSouth, x + 3.3f, x + 4.8f, 25.0f, 98.0f, 0.40f, colLimestone);
        addProjectingPier(meshLimestone, FacadeFacing::NORTH_34TH_ST, t1_zNorth, x + 3.3f, x + 4.8f, 25.0f, 98.0f, 0.40f, colLimestone);
    }
    addProjectingPier(meshLimestone, FacadeFacing::SOUTH_33RD_ST, t1_zSouth, 16.4f, t1_xEast, 25.0f, 98.0f, 0.45f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::NORTH_34TH_ST, t1_zNorth, 16.4f, t1_xEast, 25.0f, 98.0f, 0.45f, colLimestone);

    for (float yF = 26.0f; yF < 96.0f; yF += 3.6f) {
        for (float z = t1_zNorth + 3.0f; z <= t1_zSouth - 6.0f; z += 5.2f) {
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::EAST_5TH_AVE, t1_xEast, z, z + 3.6f, yF, 3.6f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::WEST_6TH_AVE, t1_xWest, z, z + 3.6f, yF, 3.6f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
        }
        for (float x = t1_xWest + 3.0f; x <= t1_xEast - 6.0f; x += 4.8f) {
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::SOUTH_33RD_ST, t1_zSouth, x, x + 3.3f, yF, 3.6f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::NORTH_34TH_ST, t1_zNorth, x, x + 3.3f, yF, 3.6f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
        }
    }

    addParapetCoping(98.0f, t1_cx, t1_cz, t1_w, t1_d);

    // ------------------------------------------------------------------------
    // 7. Tower Shaft (Stories 30 to 85, Y = 98.0m to 320.0m)
    // ------------------------------------------------------------------------
    std::cout << "[7/8] Erecting Main Tower Shaft with 2+3+3+2 Art Deco Window Cadence...\n";

    const float tw_w = 42.0f;
    const float tw_d = 56.4f;
    const float tw_cx = -13.0f;
    const float tw_cz = 0.0f;
    const float tw_xEast = tw_cx + tw_w * 0.5f;  // +8.0m
    const float tw_xWest = tw_cx - tw_w * 0.5f;  // -34.0m
    const float tw_zSouth = tw_cz + tw_d * 0.5f; // +28.2m
    const float tw_zNorth = tw_cz - tw_d * 0.5f; // -28.2m

    // East & West Tower Corner Piers & Intermediate Piers (100% Watertight Facade Closure)
    addProjectingPier(meshLimestone, FacadeFacing::EAST_5TH_AVE, tw_xEast, -28.2f, -17.2f, 99.0f, 320.0f, 0.55f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::EAST_5TH_AVE, tw_xEast, -12.4f, -10.6f, 99.0f, 320.0f, 0.45f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::EAST_5TH_AVE, tw_xEast,  -2.2f,   2.2f, 99.0f, 320.0f, 0.45f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::EAST_5TH_AVE, tw_xEast,  10.6f,  12.4f, 99.0f, 320.0f, 0.45f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::EAST_5TH_AVE, tw_xEast,  17.2f,  28.2f, 99.0f, 320.0f, 0.55f, colLimestone);

    addProjectingPier(meshLimestone, FacadeFacing::WEST_6TH_AVE, tw_xWest, -28.2f, -17.2f, 99.0f, 320.0f, 0.55f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::WEST_6TH_AVE, tw_xWest, -12.4f, -10.6f, 99.0f, 320.0f, 0.45f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::WEST_6TH_AVE, tw_xWest,  -2.2f,   2.2f, 99.0f, 320.0f, 0.45f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::WEST_6TH_AVE, tw_xWest,  10.6f,  12.4f, 99.0f, 320.0f, 0.45f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::WEST_6TH_AVE, tw_xWest,  17.2f,  28.2f, 99.0f, 320.0f, 0.55f, colLimestone);

    // Projecting Flutes on Central East & West Piers
    for (float zPier : {-11.5f, -1.0f, 1.0f, 11.5f}) {
        addProjectingPier(meshLimestone, FacadeFacing::EAST_5TH_AVE, tw_xEast, zPier - 0.45f, zPier + 0.45f, 99.0f, 320.0f, 0.60f, colLimestone);
        addProjectingPier(meshLimestone, FacadeFacing::WEST_6TH_AVE, tw_xWest, zPier - 0.45f, zPier + 0.45f, 99.0f, 320.0f, 0.60f, colLimestone);
    }

    // South & North Tower Corner Piers & Intermediate Piers (100% Watertight Facade Closure)
    addProjectingPier(meshLimestone, FacadeFacing::SOUTH_33RD_ST, tw_zSouth, -34.0f, -28.8f, 99.0f, 320.0f, 0.55f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::SOUTH_33RD_ST, tw_zSouth,   3.0f,   8.0f, 99.0f, 320.0f, 0.55f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::NORTH_34TH_ST, tw_zNorth, -34.0f, -28.8f, 99.0f, 320.0f, 0.55f, colLimestone);
    addProjectingPier(meshLimestone, FacadeFacing::NORTH_34TH_ST, tw_zNorth,   3.0f,   8.0f, 99.0f, 320.0f, 0.55f, colLimestone);

    for (float x = -28.8f; x < 0.0f; x += 5.6f) {
        addProjectingPier(meshLimestone, FacadeFacing::SOUTH_33RD_ST, tw_zSouth, x + 3.8f, x + 5.6f, 99.0f, 320.0f, 0.45f, colLimestone);
        addProjectingPier(meshLimestone, FacadeFacing::NORTH_34TH_ST, tw_zNorth, x + 3.8f, x + 5.6f, 99.0f, 320.0f, 0.45f, colLimestone);
    }

    // Tower Shaft Window Bays with Authentic 2+3+3+2 Rhythm
    for (float yF = 99.0f; yF < 319.0f; yF += 3.6f) {
        // East (5th Ave) & West (6th Ave) 2+3+3+2 Cadence
        addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::EAST_5TH_AVE, tw_xEast, -17.2f, -12.4f, yF, 3.6f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
        addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::EAST_5TH_AVE, tw_xEast, -10.6f,  -2.2f, yF, 3.6f, 3, colLimestone, colGlazing, colSpandrel, colSteel);
        addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::EAST_5TH_AVE, tw_xEast,   2.2f,  10.6f, yF, 3.6f, 3, colLimestone, colGlazing, colSpandrel, colSteel);
        addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::EAST_5TH_AVE, tw_xEast,  12.4f,  17.2f, yF, 3.6f, 2, colLimestone, colGlazing, colSpandrel, colSteel);

        addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::WEST_6TH_AVE, tw_xWest, -17.2f, -12.4f, yF, 3.6f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
        addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::WEST_6TH_AVE, tw_xWest, -10.6f,  -2.2f, yF, 3.6f, 3, colLimestone, colGlazing, colSpandrel, colSteel);
        addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::WEST_6TH_AVE, tw_xWest,   2.2f,  10.6f, yF, 3.6f, 3, colLimestone, colGlazing, colSpandrel, colSteel);
        addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::WEST_6TH_AVE, tw_xWest,  12.4f,  17.2f, yF, 3.6f, 2, colLimestone, colGlazing, colSpandrel, colSteel);

        // South (33rd St) & North (34th St) 6 Bays of 2 Windows
        for (float x = -28.8f; x <= 0.0f; x += 5.6f) {
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::SOUTH_33RD_ST, tw_zSouth, x, x + 3.8f, yF, 3.6f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
        }
        for (float x = -28.8f; x <= 0.0f; x += 5.6f) {
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, FacadeFacing::NORTH_34TH_ST, tw_zNorth, x, x + 3.8f, yF, 3.6f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
        }
    }

    addParapetCoping(320.0f, tw_cx, tw_cz, tw_w, tw_d);

    // ------------------------------------------------------------------------
    // 8. Crown & 86th/102nd Floor Observatories (Y = 320.0m to 381.0m)
    // ------------------------------------------------------------------------
    std::cout << "[8/8] Generating 86th Floor Open-Air Deck & 102nd Floor Glass Enclosure...\n";

    const float t3_w = 29.0f;
    const float t3_d = 34.0f;
    addBoxMetric(meshLimestone, Vec3(tw_cx, 332.5f, 0.0f), Vec3(t3_w, 25.0f, t3_d), colLimestone, 1.0f / 2.0f, 1.0f / 2.0f);
    for (float yF = 322.0f; yF < 344.0f; yF += 3.4f) {
        addBoxMetric(meshGlazing, Vec3(tw_cx + t3_w * 0.5f + 0.05f, yF, 0.0f), Vec3(0.1f, 2.2f, t3_d - 4.0f), colGlazing, 1.0f / 1.5f, 1.0f / 2.0f);
        addBoxMetric(meshGlazing, Vec3(tw_cx - t3_w * 0.5f - 0.05f, yF, 0.0f), Vec3(0.1f, 2.2f, t3_d - 4.0f), colGlazing, 1.0f / 1.5f, 1.0f / 2.0f);
        addBoxMetric(meshGlazing, Vec3(tw_cx, yF, t3_d * 0.5f + 0.05f), Vec3(t3_w - 4.0f, 2.2f, 0.1f), colGlazing, 1.0f / 1.5f, 1.0f / 2.0f);
        addBoxMetric(meshGlazing, Vec3(tw_cx, yF, -t3_d * 0.5f - 0.05f), Vec3(t3_w - 4.0f, 2.2f, 0.1f), colGlazing, 1.0f / 1.5f, 1.0f / 2.0f);
    }
    addParapetCoping(345.0f, tw_cx, 0.0f, t3_w, t3_d);

    // ------------------------------------------------------------------------
    // Ingest & Center Authentic Google 3D Tile Photogrammetry Spire (Y >= 340.0m)
    // Preserves all 1,776 triangles of the authentic fluted mooring mast barrel,
    // 4 aerodynamic pylons, 102nd floor observatory dome, and broadcast antenna array.
    // Centroid of authentic mooring mast in raw tile GLB is (0.133m, -0.286m).
    // Translating by (tw_cx - 0.133m, 0.0m - (-0.286m)) centers it perfectly on the tower shaft!
    // ------------------------------------------------------------------------
    const std::string isolatedTilePath = "public/models/spce_esb_isolated_full_quality_raw.glb";
    std::cout << "Ingesting and centering authentic Google 3D Tile photogrammetry spire from: " << isolatedTilePath << "...\n";
    auto rawTileMesh = GlbReader::readGlb(isolatedTilePath);
    size_t authenticSpireTriCount = 0;
    if (!rawTileMesh.vertices.empty()) {
        const float SPIRE_Y_CUTOFF = 340.0f; // Mooring mast barrel begins cleanly at 340.91m
        const float tile_cx = 0.133f;
        const float tile_cz = -0.286f;
        const float dx = tw_cx - tile_cx;   // -13.0f - 0.133f = -13.133f
        const float dz = 0.0f - tile_cz;    //  0.0f - (-0.286f) = +0.286f

        std::vector<int> remap(rawTileMesh.vertices.size(), -1);

        for (size_t i = 0; i < rawTileMesh.indices.size(); i += 3) {
            uint32_t i0 = rawTileMesh.indices[i];
            uint32_t i1 = rawTileMesh.indices[i + 1];
            uint32_t i2 = rawTileMesh.indices[i + 2];

            const auto& v0 = rawTileMesh.vertices[i0];
            const auto& v1 = rawTileMesh.vertices[i1];
            const auto& v2 = rawTileMesh.vertices[i2];

            // Retain triangles strictly above 340.0m for 100% watertight embedding into roof deck
            if (v0.position.y >= SPIRE_Y_CUTOFF && v1.position.y >= SPIRE_Y_CUTOFF && v2.position.y >= SPIRE_Y_CUTOFF) {
                auto getNewIdx = [&](uint32_t origIdx, const Vertex& origVert) -> uint32_t {
                    if (remap[origIdx] != -1) return static_cast<uint32_t>(remap[origIdx]);
                    uint32_t nIdx = static_cast<uint32_t>(meshTileSpire.vertices.size());
                    remap[origIdx] = static_cast<int>(nIdx);

                    Vertex translatedVert = origVert;
                    // Apply exact coordinate alignment to tower shaft center
                    translatedVert.position.x += dx;
                    translatedVert.position.z += dz;

                    // Calculate circumferential cylindrical UV coordinates for Art Deco turned aluminum fluting
                    float angle = std::atan2(origVert.position.z - tile_cz, origVert.position.x - tile_cx);
                    float u = (angle + 3.14159265f) / (2.0f * 3.14159265f);
                    float v_uv = std::clamp((origVert.position.y - SPIRE_Y_CUTOFF) / (427.5f - SPIRE_Y_CUTOFF), 0.0f, 1.0f);
                    translatedVert.uv = Vec2(u, v_uv);

                    // PBR material color and FAA beacon illumination
                    if (origVert.position.y >= 424.0f) {
                        // FAA Red flashing aviation warning beacon at antenna apex
                        translatedVert.color = Vec4(1.0f, 0.25f, 0.25f, 1.0f);
                    } else if (origVert.position.y >= 381.0f && origVert.position.y <= 395.0f) {
                        // 102nd Floor observation gallery lantern warm ambient tint
                        translatedVert.color = Vec4(0.98f, 0.94f, 0.85f, 1.0f);
                    } else {
                        // Art Deco brushed aluminum / stainless steel fluted mooring mast
                        translatedVert.color = Vec4(0.92f, 0.94f, 0.97f, 1.0f);
                    }

                    meshTileSpire.addVertex(translatedVert);
                    return nIdx;
                };

                uint32_t n0 = getNewIdx(i0, v0);
                uint32_t n1 = getNewIdx(i1, v1);
                uint32_t n2 = getNewIdx(i2, v2);
                meshTileSpire.addTriangle(n0, n1, n2);
                authenticSpireTriCount++;
            }
        }
        std::cout << "Preserved & Centered Authentic Photogrammetry Spire Triangles: " << authenticSpireTriCount << "\n";
    }

    // ------------------------------------------------------------------------
    // Materials & PBR Properties Setup
    // ------------------------------------------------------------------------
    meshLimestone.material.name = "Mat_IndianaLimestone";
    meshLimestone.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshLimestone.material.roughnessFactor = 0.72f;
    meshLimestone.material.metallicFactor = 0.02f;

    meshGranite.material.name = "Mat_CharcoalGranite";
    meshGranite.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshGranite.material.roughnessFactor = 0.32f;
    meshGranite.material.metallicFactor = 0.05f;

    meshSpandrel.material.name = "Mat_ArtDecoSpandrels";
    meshSpandrel.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshSpandrel.material.roughnessFactor = 0.45f;
    meshSpandrel.material.metallicFactor = 0.85f;

    meshSteel.material.name = "Mat_StainlessSteel";
    meshSteel.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshSteel.material.roughnessFactor = 0.28f;
    meshSteel.material.metallicFactor = 0.90f;

    meshGlazing.material.name = "Mat_ArchitecturalGlazing";
    meshGlazing.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshGlazing.material.emissiveFactor = Vec3(1.0f, 1.0f, 1.0f);
    meshGlazing.material.roughnessFactor = 0.06f;
    meshGlazing.material.metallicFactor = 0.88f;
    meshGlazing.material.doubleSided = false;

    meshBronze.material.name = "Mat_StatuaryBronze";
    meshBronze.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshBronze.material.roughnessFactor = 0.26f;
    meshBronze.material.metallicFactor = 0.85f;

    meshRoof.material.name = "Mat_BitumenRoof";
    meshRoof.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshRoof.material.roughnessFactor = 0.88f;
    meshRoof.material.metallicFactor = 0.02f;

    meshSidewalk.material.name = "Mat_ScoredSidewalk";
    meshSidewalk.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshSidewalk.material.roughnessFactor = 0.82f;
    meshSidewalk.material.metallicFactor = 0.02f;

    meshInterior.material.name = "Mat_LobbyAndInterior";
    meshInterior.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshInterior.material.emissiveFactor = Vec3(1.0f, 1.0f, 1.0f);
    meshInterior.material.roughnessFactor = 0.22f;
    meshInterior.material.metallicFactor = 0.10f;
    meshInterior.material.doubleSided = true;

    meshTileSpire.material.name = "Mat_AuthenticTileSpire";
    meshTileSpire.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshTileSpire.material.emissiveFactor = Vec3(1.0f, 1.0f, 1.0f);
    meshTileSpire.material.roughnessFactor = 0.32f;
    meshTileSpire.material.metallicFactor = 0.80f;

    std::vector<ScratchboxMesh> subMeshes = {
        std::move(meshLimestone),       // 0
        std::move(meshGranite),         // 1
        std::move(meshSpandrel),        // 2
        std::move(meshSteel),           // 3
        std::move(meshGlazing),         // 4
        std::move(meshBronze),          // 5
        std::move(meshRoof),            // 6
        std::move(meshSidewalk),        // 7
        std::move(meshInterior),        // 8
        std::move(meshTileSpire)        // 9
    };

    size_t totalVerts = 0;
    size_t totalIndices = 0;
    for (const auto& m : subMeshes) {
        totalVerts += m.vertices.size();
        totalIndices += m.indices.size();
    }
    std::cout << "\nSub-Meshes Assembled: " << subMeshes.size() << "\n";
    std::cout << "Total Vertices:  " << totalVerts << "\n";
    std::cout << "Total Triangles: " << (totalIndices / 3) << "\n";

    std::cout << "\nSynthesizing 1024x1024 PBR Texture Sets...\n";
    std::vector<EmbeddedTexture> embeddedTextures;

    struct MaterialDef {
        int matIndex;
        std::string name;
        PbrMaterialArchetype archetype;
        uint32_t seed;
    };

    std::vector<MaterialDef> materialDefs = {
        {0, "IndianaLimestone", PbrMaterialArchetype::INDIANA_LIMESTONE_HONED, 101},
        {1, "CharcoalGranite", PbrMaterialArchetype::CHARCOAL_GRANITE_PLINTH, 202},
        {2, "ArtDecoSpandrels", PbrMaterialArchetype::ART_DECO_CHEVRON_SPANDREL, 303},
        {3, "StainlessSteel", PbrMaterialArchetype::BRUSHED_STAINLESS_STEEL_316, 404},
        {4, "ArchitecturalGlazing", PbrMaterialArchetype::SOLAR_LOW_E_REFLECTIVE_GLASS, 505},
        {5, "CastBronze", PbrMaterialArchetype::STATUARY_CAST_BRONZE, 606},
        {6, "BitumenRoof", PbrMaterialArchetype::BITUMEN_TAR_GRAVEL_BALLAST, 707},
        {7, "SidewalkPavement", PbrMaterialArchetype::SCORED_SIDEWALK_PAVEMENT, 808},
        {8, "LobbyInteriorMarble", PbrMaterialArchetype::ROMAN_TRAVERTINE_POLISHED, 909},
        {9, "AuthenticTileSpire", PbrMaterialArchetype::TURNED_LATHE_ALUMINUM, 999}
    };

    const int TEX_RES = 1024;
    for (const auto& def : materialDefs) {
        auto pbrSet = generatePbrMaterial(def.archetype, TEX_RES, TEX_RES, def.seed);

        // Custom Albedo override for Architectural Glazing (daylight sky reflection + venetian blinds)
        if (def.matIndex == 4) {
            const int cellW = TEX_RES / 8;
            const int cellH = TEX_RES / 4;
            for (int y = 0; y < TEX_RES; ++y) {
                float v = static_cast<float>(y) / static_cast<float>(TEX_RES);
                int cellY = y / cellH;
                for (int x = 0; x < TEX_RES; ++x) {
                    int cellX = x / cellW;
                    int mx = x % cellW;
                    int my = y % cellH;
                    int padX = cellW / 8;
                    int padY = cellH / 16;
                    int midY = cellH / 2;

                    bool isOuterFrame = (mx <= padX || mx >= cellW - padX || my <= padY || my >= cellH - padY);
                    bool isMeetingRail = (std::abs(my - midY) <= 3);

                    if (isOuterFrame || isMeetingRail) {
                        pbrSet.albedo.setPixelRGB(x, y, Vec3(0.18f, 0.16f, 0.15f));
                    } else {
                        // Upper / lower glass pane
                        float normYInPane = (my < midY) ? (static_cast<float>(my - padY) / static_cast<float>(midY - padY)) : (static_cast<float>(my - midY) / static_cast<float>(cellH - padY - midY));
                        // Sky reflection gradient
                        Vec3 skyReflect = Vec3(0.24f, 0.35f, 0.48f) * (1.0f - normYInPane) + Vec3(0.16f, 0.22f, 0.30f) * normYInPane;

                        // Venetian blind slats
                        float blind = std::sin(normYInPane * 24.0f * 3.14159f);
                        if (blind > 0.1f) {
                            skyReflect = skyReflect * 0.70f + Vec3(0.48f, 0.44f, 0.36f) * 0.30f;
                        }
                        pbrSet.albedo.setPixelRGB(x, y, skyReflect);
                    }
                }
            }
        }

        EmbeddedTexture texAlbedo;
        texAlbedo.name = def.name + "_BaseColor";
        texAlbedo.mimeType = "image/png";
        texAlbedo.data = encodePng(pbrSet.albedo);
        texAlbedo.usage = TextureUsage::BASE_COLOR;
        texAlbedo.materialIndex = def.matIndex;
        embeddedTextures.push_back(std::move(texAlbedo));

        EmbeddedTexture texNormal;
        texNormal.name = def.name + "_Normal";
        texNormal.mimeType = "image/png";
        texNormal.data = encodePng(pbrSet.normal);
        texNormal.usage = TextureUsage::NORMAL;
        texNormal.materialIndex = def.matIndex;
        embeddedTextures.push_back(std::move(texNormal));

        EmbeddedTexture texOrm;
        texOrm.name = def.name + "_ORM";
        texOrm.mimeType = "image/png";
        texOrm.data = encodePng(pbrSet.orm);
        texOrm.usage = TextureUsage::ORM;
        texOrm.materialIndex = def.matIndex;
        embeddedTextures.push_back(std::move(texOrm));
    }

    // ------------------------------------------------------------------------
    // Emissive Texture Maps (Office Windows + Grand Lobby + Marquee Soffits)
    // ------------------------------------------------------------------------
    // 1. Office Glazing Emissive Map
    {
        ImageBuffer emissiveImg(TEX_RES, TEX_RES, 3);
        const int cellW = TEX_RES / 8;
        const int cellH = TEX_RES / 4;

        for (int y = 0; y < TEX_RES; ++y) {
            float v = static_cast<float>(y) / static_cast<float>(TEX_RES);
            int cellY = y / cellH;
            for (int x = 0; x < TEX_RES; ++x) {
                int cellX = x / cellW;
                int mx = x % cellW;
                int my = y % cellH;
                int padX = cellW / 8;
                int padY = cellH / 16;
                int midY = cellH / 2;

                bool isPane = (mx > padX && mx < cellW - padX) && 
                              ((my > padY && my < midY - 3) || (my > midY + 3 && my < cellH - padY));

                uint32_t cellHash = (static_cast<uint32_t>(cellX) * 73856093u) ^ (static_cast<uint32_t>(cellY) * 19349663u) ^ 9091u;
                bool isOccupied = ((cellHash % 100) < 32);

                if (isPane && isOccupied) {
                    float venetian = 0.85f + 0.15f * std::sin(v * 128.0f * 3.14159f);
                    emissiveImg.setPixelRGB(x, y, Vec3(0.92f * venetian, 0.76f * venetian, 0.48f * venetian));
                } else {
                    emissiveImg.setPixelRGB(x, y, Vec3(0.0f, 0.0f, 0.0f));
                }
            }
        }
        EmbeddedTexture texEmissive;
        texEmissive.name = "ArchitecturalGlazing_Emissive";
        texEmissive.mimeType = "image/png";
        texEmissive.data = encodePng(emissiveImg);
        texEmissive.usage = TextureUsage::EMISSIVE;
        texEmissive.materialIndex = 4;
        embeddedTextures.push_back(std::move(texEmissive));
    }

    // 2. Grand Lobby & Interior Emissive Map (Golden ESB Relief Mural & Ceiling Coves)
    {
        ImageBuffer lobbyEmissive(TEX_RES, TEX_RES, 3);
        for (int y = 0; y < TEX_RES; ++y) {
            float v = static_cast<float>(y) / static_cast<float>(TEX_RES);
            for (int x = 0; x < TEX_RES; ++x) {
                float u = static_cast<float>(x) / static_cast<float>(TEX_RES);
                // Center mural highlight: golden sunburst
                float du = u - 0.5f;
                float dv = v - 0.5f;
                float dist = std::sqrt(du * du + dv * dv);
                if (dist < 0.45f) {
                    float ray = 0.5f + 0.5f * std::cos(std::atan2(dv, du) * 16.0f);
                    float intensity = (1.0f - dist / 0.45f) * ray;
                    lobbyEmissive.setPixelRGB(x, y, Vec3(0.95f * intensity, 0.82f * intensity, 0.45f * intensity));
                } else {
                    // Subtle warm ambient interior office cove glow
                    lobbyEmissive.setPixelRGB(x, y, Vec3(0.25f, 0.20f, 0.12f));
                }
            }
        }
        EmbeddedTexture texLobbyEmissive;
        texLobbyEmissive.name = "LobbyInterior_Emissive";
        texLobbyEmissive.mimeType = "image/png";
        texLobbyEmissive.data = encodePng(lobbyEmissive);
        texLobbyEmissive.usage = TextureUsage::EMISSIVE;
        texLobbyEmissive.materialIndex = 8;
        embeddedTextures.push_back(std::move(texLobbyEmissive));
    }

    // 3. Authentic Tile Spire Emissive Map (102nd Floor Dome Observatory & Apex FAA Beacon)
    {
        ImageBuffer spireEmissive(TEX_RES, TEX_RES, 3);
        const float v_obs_low  = (381.0f - 340.0f) / (427.5f - 340.0f); // ~0.4686
        const float v_obs_high = (395.0f - 340.0f) / (427.5f - 340.0f); // ~0.6286
        const float v_beacon   = (424.0f - 340.0f) / (427.5f - 340.0f); // ~0.9600

        for (int y = 0; y < TEX_RES; ++y) {
            float v = static_cast<float>(y) / static_cast<float>(TEX_RES);
            for (int x = 0; x < TEX_RES; ++x) {
                float u = static_cast<float>(x) / static_cast<float>(TEX_RES);

                if (v >= v_beacon) {
                    // Apex FAA aviation obstruction warning light (bright red)
                    spireEmissive.setPixelRGB(x, y, Vec3(1.0f, 0.12f, 0.12f));
                } else if (v >= v_obs_low && v <= v_obs_high) {
                    // 102nd Floor observation gallery lantern windows
                    float rib = std::cos(u * 32.0f * 3.14159f);
                    float lanternGlow = (rib > -0.2f) ? 0.95f : 0.25f;
                    spireEmissive.setPixelRGB(x, y, Vec3(0.98f * lanternGlow, 0.86f * lanternGlow, 0.52f * lanternGlow));
                } else {
                    spireEmissive.setPixelRGB(x, y, Vec3(0.0f, 0.0f, 0.0f));
                }
            }
        }
        EmbeddedTexture texSpireEmissive;
        texSpireEmissive.name = "AuthenticTileSpire_Emissive";
        texSpireEmissive.mimeType = "image/png";
        texSpireEmissive.data = encodePng(spireEmissive);
        texSpireEmissive.usage = TextureUsage::EMISSIVE;
        texSpireEmissive.materialIndex = 9;
        embeddedTextures.push_back(std::move(texSpireEmissive));
    }

    std::cout << "Embedded PBR Maps Ready: " << embeddedTextures.size() << "\n";

    std::string outputPath = "public/models/spce_esb_rectified_hybrid.glb";
    std::cout << "Exporting GLB to: " << outputPath << "...\n";

    bool success = GlbWriter::writeMultiMeshToFile(subMeshes, outputPath, embeddedTextures);
    if (!success) {
        std::cerr << "ERROR: Failed to write GLB\n";
        return 1;
    }

    GlbWriter::writeMultiMeshToFile(subMeshes, "scripts/models/spce_esb_rectified_hybrid.glb", embeddedTextures);

    auto endTime = std::chrono::high_resolution_clock::now();
    double elapsedMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

    std::cout << "======================================================================\n";
    std::cout << "SUCCESS: Architectural Hybrid Model Generated!\n";
    std::cout << "Output File: " << outputPath << "\n";
    std::cout << "Apex Height: Y = 426.89m (spire summit)\n";
    std::cout << "Elapsed:     " << elapsedMs << " ms\n";
    std::cout << "======================================================================\n";

    return 0;
}
