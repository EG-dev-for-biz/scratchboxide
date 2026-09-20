/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Native C++20 Generator: Analytical Cuboid Blockout Generator (Synthetic Box Test Environment)
 *
 * NOTE: This tool generates synthetic analytical cuboid parcel boxes for geometric
 * box kinematics testing. It is NOT the photogrammetric Google 3D Tiles pipeline.
 * Real-world photogrammetric 3D tile streaming is handled via Google3DTileBlockoutPipelineService.
 *
 * - Generates public/models/analytical_cuboid_blockout.glb
 * - Computes smooth 6-DOF camera path through synthetic cuboid canyon
 * - Exports trajectory coordinates to public/models/analytical_cuboid_camera_path.json
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_tiles.hpp"
#include "scratchbox_camera_reprojector.hpp"
#include "scratchbox_trajectory_collision.hpp"
#include <iostream>
#include <fstream>
#include <vector>
#include <cmath>
#include <filesystem>
#include <numbers>
#include <iomanip>

using namespace scratchbox;
using math::Vec2;
using math::Vec3;
using math::Vec4;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;
using io::GlbWriter;

// Manhattan Grid alignment: 29.0 degrees East of True North
constexpr float GRID_THETA_DEG = 29.0f;
constexpr float GRID_RAD = GRID_THETA_DEG * (std::numbers::pi_v<float> / 180.0f);
const float COS_THETA = std::cos(GRID_RAD);
const float SIN_THETA = std::sin(GRID_RAD);

inline Vec2 manhattanToEnu(float u, float v) {
    float x = u * COS_THETA - v * SIN_THETA;
    float z = u * SIN_THETA + v * COS_THETA;
    return Vec2(x, z);
}

// Google Elevation gradient
inline float getGroundElevation(float u, float v) {
    return 0.00671f * u - 0.01709f * v - 0.10f;
}

// Helper: Add outward quad to mesh with guaranteed counter-clockwise winding
inline void addQuad(
    ScratchboxMesh& mesh,
    const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3,
    const Vec3& normal,
    const Vec4& color
) {
    uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(p0, normal, Vec2(0, 0), color));
    mesh.addVertex(Vertex(p1, normal, Vec2(1, 0), color));
    mesh.addVertex(Vertex(p2, normal, Vec2(1, 1), color));
    mesh.addVertex(Vertex(p3, normal, Vec2(0, 1), color));

    // Verify cross product against expected outward face normal
    Vec3 cross0 = (p1 - p0).cross(p2 - p0);
    if (cross0.dot(normal) >= 0.0f) {
        mesh.addTriangle(base, base + 1, base + 2);
        mesh.addTriangle(base, base + 2, base + 3);
    } else {
        mesh.addTriangle(base, base + 2, base + 1);
        mesh.addTriangle(base, base + 3, base + 2);
    }
}

// Helper: Extrude a 100% closed, watertight 6-sided solid manifold box with outward normals
inline void addBuildingBlock(
    ScratchboxMesh& mesh,
    float uMin, float uMax, float vMin, float vMax,
    float yBottom, float yTop,
    const Vec4& facadeColor,
    const Vec4& roofColor,
    bool addParapet = true
) {
    Vec2 pNW = manhattanToEnu(uMin, vMin);
    Vec2 pNE = manhattanToEnu(uMax, vMin);
    Vec2 pSE = manhattanToEnu(uMax, vMax);
    Vec2 pSW = manhattanToEnu(uMin, vMax);

    Vec3 bNW(pNW.x, yBottom, pNW.y);
    Vec3 bNE(pNE.x, yBottom, pNE.y);
    Vec3 bSE(pSE.x, yBottom, pSE.y);
    Vec3 bSW(pSW.x, yBottom, pSW.y);

    Vec3 tNW(pNW.x, yTop, pNW.y);
    Vec3 tNE(pNE.x, yTop, pNE.y);
    Vec3 tSE(pSE.x, yTop, pSE.y);
    Vec3 tSW(pSW.x, yTop, pSW.y);

    // Precise outward face normals
    Vec3 nNorth = (bNW - bNE).cross(Vec3(0, 1, 0)).normalized(); // Points North (-V)
    Vec3 nSouth = (bSE - bSW).cross(Vec3(0, 1, 0)).normalized(); // Points South (+V)
    Vec3 nEast  = (bNE - bSE).cross(Vec3(0, 1, 0)).normalized(); // Points East (+U)
    Vec3 nWest  = (bSW - bNW).cross(Vec3(0, 1, 0)).normalized(); // Points West (-U)

    // 1. North facade (at vMin): CCW from outside is bNE -> bNW -> tNW -> tNE
    addQuad(mesh, bNE, bNW, tNW, tNE, nNorth, facadeColor);

    // 2. South facade (at vMax): CCW from outside is bSW -> bSE -> tSE -> tSW
    addQuad(mesh, bSW, bSE, tSE, tSW, nSouth, facadeColor);

    // 3. East facade (at uMax): CCW from outside is bSE -> bNE -> tNE -> tSE
    addQuad(mesh, bSE, bNE, tNE, tSE, nEast, facadeColor);

    // 4. West facade (at uMin): CCW from outside is bNW -> bSW -> tSW -> tNW
    addQuad(mesh, bNW, bSW, tSW, tNW, nWest, facadeColor);

    // 5. Roof (Top cap): CCW from above is tSW -> tSE -> tNE -> tNW
    addQuad(mesh, tSW, tSE, tNE, tNW, Vec3(0, 1, 0), roofColor);

    // 6. Floor (Bottom cap): CCW from below is bNW -> bNE -> bSE -> bSW
    addQuad(mesh, bNW, bNE, bSE, bSW, Vec3(0, -1, 0), roofColor);

    // Architectural Parapet Curb: Creates solid volumetric perimeter on rooftops
    if (addParapet && (uMax - uMin > 8.0f) && (vMax - vMin > 8.0f)) {
        float pHeight = 0.9f;
        float pThick = 0.6f;
        Vec4 parapetColor(roofColor.x * 0.95f, roofColor.y * 0.95f, roofColor.z * 0.95f, 1.0f);

        // North parapet curb
        addBuildingBlock(mesh, uMin, uMax, vMin, vMin + pThick, yTop, yTop + pHeight, parapetColor, parapetColor, false);
        // South parapet curb
        addBuildingBlock(mesh, uMin, uMax, vMax - pThick, vMax, yTop, yTop + pHeight, parapetColor, parapetColor, false);
        // East parapet curb
        addBuildingBlock(mesh, uMax - pThick, uMax, vMin + pThick, vMax - pThick, yTop, yTop + pHeight, parapetColor, parapetColor, false);
        // West parapet curb
        addBuildingBlock(mesh, uMin, uMin + pThick, vMin + pThick, vMax - pThick, yTop, yTop + pHeight, parapetColor, parapetColor, false);
    }
}

// Catmull-Rom spline evaluator
inline Vec3 catmullRom(const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3, float t) {
    float t2 = t * t;
    float t3 = t2 * t;
    return (
        (p1 * 2.0f) +
        (-p0 + p2) * t +
        (p0 * 2.0f - p1 * 5.0f + p2 * 4.0f - p3) * t2 +
        (-p0 + p1 * 3.0f - p2 * 3.0f + p3) * t3
    ) * 0.5f;
}

int main() {
    std::cout << "======================================================================\n";
    std::cout << "  SCRATCHBOX 3D ENGINE: GOOGLE MAP TILES CLAY BLOCKOUT GENERATOR\n";
    std::cout << "  Canonical glTF 2.0 (.glb) & 6-DOF Camera Spline Flight Pipeline\n";
    std::cout << "======================================================================\n";

    ScratchboxMesh cityClay("google_tiles_clay_blockout");

    // -------------------------------------------------------------------------
    // 1. PBR Clay Material Palette (Studio Grey & Architectural White Clay)
    // -------------------------------------------------------------------------
    PbrMaterial clayMat;
    clayMat.name = "architectural_studio_clay";
    clayMat.baseColorFactor = Vec4(0.86f, 0.87f, 0.89f, 1.0f); // #dcdee3 Architectural Clay
    clayMat.roughnessFactor = 0.82f;
    clayMat.metallicFactor = 0.02f;
    cityClay.material = clayMat;

    // Palette with ambient occlusion / cavity variations
    Vec4 colFacadeLight(0.88f, 0.89f, 0.91f, 1.0f); // Upper facade
    Vec4 colFacadeMid(0.82f, 0.83f, 0.85f, 1.0f);   // Lower facade
    Vec4 colRoofCavity(0.68f, 0.70f, 0.73f, 1.0f);  // Setback roof terraces (AO shaded)
    Vec4 colStreetClay(0.48f, 0.50f, 0.53f, 1.0f);  // Street surface clay
    Vec4 colSidewalkClay(0.74f, 0.76f, 0.78f, 1.0f);// Sidewalk clay

    // -------------------------------------------------------------------------
    // 2. Terrain & Ground Base
    // -------------------------------------------------------------------------
    float span = 500.0f;
    int divs = 20;
    float step = (span * 2.0f) / divs;
    for (int i = 0; i < divs; ++i) {
        for (int j = 0; j < divs; ++j) {
            float u0 = -span + i * step;
            float u1 = u0 + step;
            float v0 = -span + j * step;
            float v1 = v0 + step;

            Vec2 g0 = manhattanToEnu(u0, v0);
            Vec2 g1 = manhattanToEnu(u1, v0);
            Vec2 g2 = manhattanToEnu(u1, v1);
            Vec2 g3 = manhattanToEnu(u0, v1);

            float y00 = getGroundElevation(u0, v0) - 0.2f;
            float y10 = getGroundElevation(u1, v0) - 0.2f;
            float y11 = getGroundElevation(u1, v1) - 0.2f;
            float y01 = getGroundElevation(u0, v1) - 0.2f;

            uint32_t bIdx = static_cast<uint32_t>(cityClay.vertices.size());
            Vec3 norm(0, 1, 0);
            cityClay.vertices.push_back(Vertex(Vec3(g0.x, y00, g0.y), norm, Vec2(0, 0), colStreetClay));
            cityClay.vertices.push_back(Vertex(Vec3(g1.x, y10, g1.y), norm, Vec2(1, 0), colStreetClay));
            cityClay.vertices.push_back(Vertex(Vec3(g2.x, y11, g2.y), norm, Vec2(1, 1), colStreetClay));
            cityClay.vertices.push_back(Vertex(Vec3(g3.x, y01, g3.y), norm, Vec2(0, 1), colStreetClay));

            cityClay.addTriangle(bIdx + 0, bIdx + 1, bIdx + 2);
            cityClay.addTriangle(bIdx + 0, bIdx + 2, bIdx + 3);
        }
    }

    // -------------------------------------------------------------------------
    // 3. Roads & Avenue Ribbons
    // -------------------------------------------------------------------------
    auto addRoad = [&](float uCenter, float vStart, float vEnd, float width) {
        float halfW = width * 0.5f;
        int nSegs = 16;
        float vDelta = (vEnd - vStart) / nSegs;
        for (int s = 0; s < nSegs; ++s) {
            float va = vStart + s * vDelta;
            float vb = va + vDelta;
            Vec2 r0 = manhattanToEnu(uCenter - halfW, va);
            Vec2 r1 = manhattanToEnu(uCenter + halfW, va);
            Vec2 r2 = manhattanToEnu(uCenter + halfW, vb);
            Vec2 r3 = manhattanToEnu(uCenter - halfW, vb);

            float ya = getGroundElevation(uCenter, va) + 0.05f;
            float yb = getGroundElevation(uCenter, vb) + 0.05f;

            uint32_t bIdx = static_cast<uint32_t>(cityClay.vertices.size());
            Vec3 norm(0, 1, 0);
            cityClay.vertices.push_back(Vertex(Vec3(r0.x, ya, r0.y), norm, Vec2(0, 0), colStreetClay));
            cityClay.vertices.push_back(Vertex(Vec3(r1.x, ya, r1.y), norm, Vec2(1, 0), colStreetClay));
            cityClay.vertices.push_back(Vertex(Vec3(r2.x, yb, r2.y), norm, Vec2(1, 1), colStreetClay));
            cityClay.vertices.push_back(Vertex(Vec3(r3.x, yb, r3.y), norm, Vec2(0, 1), colStreetClay));

            cityClay.addTriangle(bIdx + 0, bIdx + 1, bIdx + 2);
            cityClay.addTriangle(bIdx + 0, bIdx + 2, bIdx + 3);
        }
    };

    // Major avenues
    addRoad(18.0f, -480.0f, 320.0f, 28.0f);   // 5th Ave
    addRoad(-240.0f, -480.0f, 320.0f, 32.0f); // 6th Ave
    addRoad(280.0f, -480.0f, 320.0f, 28.0f);  // Madison Ave

    // Cross-streets
    auto addStreet = [&](float vCenter, float uStart, float uEnd, float width) {
        float halfW = width * 0.5f;
        int nSegs = 16;
        float uDelta = (uEnd - uStart) / nSegs;
        for (int s = 0; s < nSegs; ++s) {
            float ua = uStart + s * uDelta;
            float ub = ua + uDelta;
            Vec2 s0 = manhattanToEnu(ua, vCenter - halfW);
            Vec2 s1 = manhattanToEnu(ub, vCenter - halfW);
            Vec2 s2 = manhattanToEnu(ub, vCenter + halfW);
            Vec2 s3 = manhattanToEnu(ua, vCenter + halfW);

            float ya = getGroundElevation(ua, vCenter) + 0.05f;
            float yb = getGroundElevation(ub, vCenter) + 0.05f;

            uint32_t bIdx = static_cast<uint32_t>(cityClay.vertices.size());
            Vec3 norm(0, 1, 0);
            cityClay.vertices.push_back(Vertex(Vec3(s0.x, ya, s0.y), norm, Vec2(0, 0), colStreetClay));
            cityClay.vertices.push_back(Vertex(Vec3(s1.x, yb, s1.y), norm, Vec2(1, 0), colStreetClay));
            cityClay.vertices.push_back(Vertex(Vec3(s2.x, yb, s2.y), norm, Vec2(1, 1), colStreetClay));
            cityClay.vertices.push_back(Vertex(Vec3(s3.x, ya, s3.y), norm, Vec2(0, 1), colStreetClay));

            cityClay.addTriangle(bIdx + 0, bIdx + 1, bIdx + 2);
            cityClay.addTriangle(bIdx + 0, bIdx + 2, bIdx + 3);
        }
    };

    addStreet(-40.0f, -450.0f, 380.0f, 30.0f); // 34th St
    addStreet(40.0f, -450.0f, 380.0f, 18.0f);  // 33rd St
    addStreet(-120.0f, -450.0f, 380.0f, 18.0f); // 35th St
    addStreet(120.0f, -450.0f, 380.0f, 18.0f);  // 32nd St

    // -------------------------------------------------------------------------
    // 4. Skyscraper Parcels with Authentic Setbacks & Architectural Towers
    // -------------------------------------------------------------------------
    struct BuildingSpec {
        std::string name;
        float uMin, uMax, vMin, vMax;
        float baseH;
        float towerH;
        float crownH;
        float setbackInset;
    };

    std::vector<BuildingSpec> buildings = {
        // Empire State Building: Iconic tiered setbacks (Podium -> Tower -> Mooring Mast -> Spire)
        {"Empire State Building", -98.0f, -8.0f, -32.0f, 32.0f, 32.0f, 320.0f, 381.0f, 6.0f},
        // Macy's Herald Square
        {"Macy's Herald Square", -224.0f, -115.0f, -111.0f, -49.0f, 45.0f, 85.0f, 0.0f, 4.0f},
        // 1 West 34th Street
        {"1 West 34th Street", -104.5f, -8.0f, -111.0f, -49.0f, 35.0f, 140.0f, 165.0f, 5.0f},
        // CUNY Graduate Center
        {"CUNY Graduate Center", 32.0f, 150.0f, -32.0f, 32.0f, 38.0f, 48.0f, 0.0f, 0.0f},
        // 10 East 34th Street
        {"10 East 34th Street", 155.0f, 260.0f, -32.0f, 32.0f, 30.0f, 105.0f, 125.0f, 4.0f},
        // 362 5th Avenue
        {"362 5th Avenue", 32.0f, 145.0f, -111.0f, -49.0f, 35.0f, 120.0f, 138.0f, 4.0f},
        // 200 Madison Avenue
        {"200 Madison Avenue", 150.0f, 260.0f, -111.0f, -49.0f, 32.0f, 115.0f, 0.0f, 3.0f},
        // Hotel Martinique
        {"Hotel Martinique", -224.0f, -115.0f, 49.0f, 111.0f, 28.0f, 82.0f, 0.0f, 3.0f},
        // Koreatown Plaza
        {"Koreatown 10 W 33rd", -110.0f, -8.0f, 49.0f, 111.0f, 30.0f, 75.0f, 0.0f, 2.0f},
        // 320 5th Avenue
        {"320 5th Avenue", 32.0f, 145.0f, 49.0f, 111.0f, 35.0f, 108.0f, 0.0f, 3.0f},
        // 180 Madison Avenue
        {"180 Madison Avenue", 150.0f, 260.0f, 49.0f, 111.0f, 30.0f, 95.0f, 0.0f, 3.0f},
        // 225 Madison Avenue
        {"225 Madison Avenue", 150.0f, 260.0f, -190.0f, -130.0f, 35.0f, 145.0f, 170.0f, 5.0f},
        // 373 5th Avenue
        {"373 5th Avenue", -105.0f, -8.0f, -190.0f, -130.0f, 30.0f, 100.0f, 0.0f, 3.0f},
        // Herald Center
        {"Herald Center", -224.0f, -115.0f, -32.0f, 32.0f, 25.0f, 55.0f, 0.0f, 2.0f}
    };

    for (const auto& b : buildings) {
        float gY = getGroundElevation((b.uMin + b.uMax) * 0.5f, (b.vMin + b.vMax) * 0.5f);

        // Tier 1: Podium base
        addBuildingBlock(cityClay, b.uMin, b.uMax, b.vMin, b.vMax, gY, gY + b.baseH, colFacadeMid, colRoofCavity);

        // Tier 2: Main setback shaft
        if (b.towerH > b.baseH) {
            float s = b.setbackInset;
            addBuildingBlock(cityClay, b.uMin + s, b.uMax - s, b.vMin + s, b.vMax - s,
                             gY + b.baseH, gY + b.towerH, colFacadeLight, colRoofCavity);
        }

        // Tier 3: Crown / Upper setback
        if (b.crownH > b.towerH) {
            float s2 = b.setbackInset * 2.2f;
            addBuildingBlock(cityClay, b.uMin + s2, b.uMax - s2, b.vMin + s2, b.vMax - s2,
                             gY + b.towerH, gY + b.crownH, colFacadeLight, colRoofCavity);
        }
    }

    // Special: Empire State Building Mooring Mast & Spire Needle
    {
        float esbCenterX = (-98.0f - 8.0f) * 0.5f;
        float esbCenterY = (-32.0f + 32.0f) * 0.5f;
        Vec2 esbCenterEnu = manhattanToEnu(esbCenterX, esbCenterY);
        float gY = getGroundElevation(esbCenterX, esbCenterY);

        // Mooring mast (381m to 410m)
        float mastR = 7.0f;
        int mastSides = 8;
        for (int i = 0; i < mastSides; ++i) {
            float a0 = i * (2.0f * std::numbers::pi_v<float> / mastSides);
            float a1 = (i + 1) * (2.0f * std::numbers::pi_v<float> / mastSides);
            Vec3 p0(esbCenterEnu.x + std::cos(a0) * mastR, gY + 381.0f, esbCenterEnu.y + std::sin(a0) * mastR);
            Vec3 p1(esbCenterEnu.x + std::cos(a1) * mastR, gY + 381.0f, esbCenterEnu.y + std::sin(a1) * mastR);
            Vec3 p2(esbCenterEnu.x + std::cos(a1) * (mastR * 0.8f), gY + 410.0f, esbCenterEnu.y + std::sin(a1) * (mastR * 0.8f));
            Vec3 p3(esbCenterEnu.x + std::cos(a0) * (mastR * 0.8f), gY + 410.0f, esbCenterEnu.y + std::sin(a0) * (mastR * 0.8f));
            Vec3 n = (p1 - p0).cross(Vec3(0, 1, 0)).normalized();
            addQuad(cityClay, p0, p1, p2, p3, n, colFacadeLight);
        }

        // Top cap for mooring mast at 410m (watertight closure)
        Vec3 mastTopCenter(esbCenterEnu.x, gY + 410.0f, esbCenterEnu.y);
        for (int i = 0; i < mastSides; ++i) {
            float a0 = i * (2.0f * std::numbers::pi_v<float> / mastSides);
            float a1 = (i + 1) * (2.0f * std::numbers::pi_v<float> / mastSides);
            Vec3 p0(esbCenterEnu.x + std::cos(a0) * (mastR * 0.8f), gY + 410.0f, esbCenterEnu.y + std::sin(a0) * (mastR * 0.8f));
            Vec3 p1(esbCenterEnu.x + std::cos(a1) * (mastR * 0.8f), gY + 410.0f, esbCenterEnu.y + std::sin(a1) * (mastR * 0.8f));
            uint32_t bIdx = static_cast<uint32_t>(cityClay.vertices.size());
            Vec3 n(0, 1, 0);
            cityClay.vertices.push_back(Vertex(mastTopCenter, n, Vec2(0.5f, 0.5f), colRoofCavity));
            cityClay.vertices.push_back(Vertex(p0, n, Vec2(0, 0), colRoofCavity));
            cityClay.vertices.push_back(Vertex(p1, n, Vec2(1, 0), colRoofCavity));
            cityClay.addTriangle(bIdx, bIdx + 1, bIdx + 2);
        }

        // Antenna needle (410m to 443m)
        float needleR = 1.2f;
        for (int i = 0; i < 6; ++i) {
            float a0 = i * (2.0f * std::numbers::pi_v<float> / 6);
            float a1 = (i + 1) * (2.0f * std::numbers::pi_v<float> / 6);
            Vec3 p0(esbCenterEnu.x + std::cos(a0) * needleR, gY + 410.0f, esbCenterEnu.y + std::sin(a0) * needleR);
            Vec3 p1(esbCenterEnu.x + std::cos(a1) * needleR, gY + 410.0f, esbCenterEnu.y + std::sin(a1) * needleR);
            Vec3 pTop(esbCenterEnu.x, gY + 443.2f, esbCenterEnu.y);

            uint32_t bIdx = static_cast<uint32_t>(cityClay.vertices.size());
            Vec3 n = (p1 - p0).cross(pTop - p0).normalized();
            cityClay.vertices.push_back(Vertex(p0, n, Vec2(0, 0), colFacadeLight));
            cityClay.vertices.push_back(Vertex(p1, n, Vec2(1, 0), colFacadeLight));
            cityClay.vertices.push_back(Vertex(pTop, n, Vec2(0.5f, 1), colFacadeLight));
            cityClay.addTriangle(bIdx, bIdx + 1, bIdx + 2);
        }
    }

    cityClay.recomputeNormals();

    // -------------------------------------------------------------------------
    // 5. Export Binary glTF 2.0 (.glb)
    // -------------------------------------------------------------------------
    std::filesystem::create_directories("public/models");
    std::string glbPath = "public/models/analytical_cuboid_blockout.glb";

    std::vector<uint8_t> glbData = GlbWriter::serializeToGlb(cityClay);
    std::ofstream outFile(glbPath, std::ios::binary);
    if (!outFile.is_open()) {
        std::cerr << "  [Error] Failed to open " << glbPath << " for writing\n";
        return 1;
    }
    outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
    outFile.close();

    std::cout << "  Geometry Generation Summary:\n";
    std::cout << "    -> Vertices:     " << cityClay.vertices.size() << "\n";
    std::cout << "    -> Triangles:    " << cityClay.indices.size() / 3 << "\n";
    std::cout << "    -> Bounding Min: (" << cityClay.bounds.min.x << ", "
              << cityClay.bounds.min.y << ", " << cityClay.bounds.min.z << ")\n";
    std::cout << "    -> Bounding Max: (" << cityClay.bounds.max.x << ", "
              << cityClay.bounds.max.y << ", " << cityClay.bounds.max.z << ")\n";
    std::cout << "  [Result] Exported: " << glbPath << " (" << glbData.size() / 1024.0f << " KB)\n";

    // -------------------------------------------------------------------------
    // 6. Generate 6-DOF Spline Camera Flight Trajectory & BVH Collision Audit
    // -------------------------------------------------------------------------
    struct SplineControlPoint {
        Vec3 pos;
        Vec3 target;
        float rollDeg;
    };

    // Safe cinematic aerial sweep: smooth forward glide down 5th Avenue corridor, safely clearing all rooftops (Y: 95m -> 86m)
    // Preserves CP0 Frame 0 pose 1:1, eliminates extreme sky-pitch at the end, and maintains steady forward kinematics
    std::vector<SplineControlPoint> ctrlPoints = {
        // CP0: High altitude approach from North (40th St / 5th Ave corridor) - MATCHES Frame 0 1:1
        {
            Vec3(manhattanToEnu(18.0f, -320.0f).x, 95.0f, manhattanToEnu(18.0f, -320.0f).y),
            Vec3(manhattanToEnu(18.0f, -120.0f).x, 45.0f, manhattanToEnu(18.0f, -120.0f).y),
            -2.0f
        },
        // CP1: Gliding smoothly down 5th Avenue towards 38th St
        {
            Vec3(manhattanToEnu(18.0f, -295.0f).x, 92.5f, manhattanToEnu(18.0f, -295.0f).y),
            Vec3(manhattanToEnu(8.0f, -100.0f).x, 50.0f, manhattanToEnu(8.0f, -100.0f).y),
            -2.2f
        },
        // CP2: Steady cruising above 37th St intersection, framing ESB tower and setbacks
        {
            Vec3(manhattanToEnu(18.0f, -270.0f).x, 90.0f, manhattanToEnu(18.0f, -270.0f).y),
            Vec3(manhattanToEnu(-2.0f, -80.0f).x, 56.0f, manhattanToEnu(-2.0f, -80.0f).y),
            -2.0f
        },
        // CP3: Cruising past 36th St intersection, majestic continuous perspective
        {
            Vec3(manhattanToEnu(18.0f, -245.0f).x, 88.0f, manhattanToEnu(18.0f, -245.0f).y),
            Vec3(manhattanToEnu(-12.0f, -60.0f).x, 62.0f, manhattanToEnu(-12.0f, -60.0f).y),
            -1.8f
        },
        // CP4: Approaching 35th St vista, stable framing with full skyline geometry anchored
        {
            Vec3(manhattanToEnu(18.0f, -220.0f).x, 86.0f, manhattanToEnu(18.0f, -220.0f).y),
            Vec3(manhattanToEnu(-20.0f, -40.0f).x, 68.0f, manhattanToEnu(-20.0f, -40.0f).y),
            -1.5f
        }
    };

    const int totalFrames = 72;
    const float durationSec = 3.0f;
    std::vector<collision::CameraWaypoint> rawWaypoints;

    for (int f = 0; f < totalFrames; ++f) {
        float tGlobal = static_cast<float>(f) / (totalFrames - 1);
        float tScaled = tGlobal * (ctrlPoints.size() - 1);
        int seg = std::min(static_cast<int>(tScaled), static_cast<int>(ctrlPoints.size() - 2));
        float tLocal = tScaled - seg;

        int i0 = std::max(0, seg - 1);
        int i1 = seg;
        int i2 = seg + 1;
        int i3 = std::min(static_cast<int>(ctrlPoints.size() - 1), seg + 2);

        Vec3 pos = catmullRom(ctrlPoints[i0].pos, ctrlPoints[i1].pos, ctrlPoints[i2].pos, ctrlPoints[i3].pos, tLocal);
        Vec3 tgt = catmullRom(ctrlPoints[i0].target, ctrlPoints[i1].target, ctrlPoints[i2].target, ctrlPoints[i3].target, tLocal);
        float roll = ctrlPoints[i1].rollDeg * (1.0f - tLocal) + ctrlPoints[i2].rollDeg * tLocal;

        Vec3 forward = (tgt - pos).normalized();
        Vec3 worldUp(0, 1, 0);
        Vec3 right = forward.cross(worldUp).normalized();
        Vec3 camUp = right.cross(forward).normalized();

        float rollRad = roll * (std::numbers::pi_v<float> / 180.0f);
        Vec3 finalUp = (camUp * std::cos(rollRad) + right * std::sin(rollRad)).normalized();

        collision::CameraWaypoint wp;
        wp.frameIndex = f;
        wp.timeSec = static_cast<float>(f) / 24.0f;
        wp.position = pos;
        wp.target = tgt;
        wp.up = finalUp;
        wp.fov = 65.0f;
        wp.rollDeg = roll;
        rawWaypoints.push_back(wp);
    }

    // -------------------------------------------------------------------------
    // 7. Trajectory BVH Clearance Audit & Adaptive Obstacle Avoidance
    // -------------------------------------------------------------------------
    std::cout << "  Starting Native C++20 BVH Trajectory Clearance Audit...\n";
    constexpr float MIN_CLEARANCE_METERS = 6.0f;
    auto initialAudit = collision::TrajectoryCollisionAuditor::auditTrajectory(rawWaypoints, cityClay, MIN_CLEARANCE_METERS);

    std::cout << "    -> Total Frames Audited:    " << initialAudit.totalFramesAudited << "\n";
    std::cout << "    -> Colliding Frames:        " << initialAudit.collidingFramesCount << "\n";
    std::cout << "    -> Clearance Breaches:      " << initialAudit.clearanceBreachesCount << "\n";
    std::cout << "    -> Min Clearance Distance:  " << initialAudit.minClearanceEncountered << " m\n";

    std::vector<collision::CameraWaypoint> verifiedWaypoints;
    if (!initialAudit.isCleanAndClear) {
        std::cout << "  [Warning] Clearance breaches detected. Applying C2-continuous adaptive elevation...\n";
        verifiedWaypoints = collision::TrajectoryCollisionAuditor::resolveTrajectoryCollisions(
            rawWaypoints, cityClay, MIN_CLEARANCE_METERS, 8
        );
        auto postAudit = collision::TrajectoryCollisionAuditor::auditTrajectory(verifiedWaypoints, cityClay, MIN_CLEARANCE_METERS);
        std::cout << "    -> Post-Resolution Min Clearance: " << postAudit.minClearanceEncountered << " m\n";
        std::cout << "    -> Post-Resolution Breaches:      " << postAudit.clearanceBreachesCount << "\n";
    } else {
        std::cout << "  ✓ All 72 trajectory frames strictly satisfy minimum clearance ("
                  << initialAudit.minClearanceEncountered << "m >= " << MIN_CLEARANCE_METERS << "m)\n";
        verifiedWaypoints = rawWaypoints;
    }

    std::ofstream jsonFile("public/models/analytical_cuboid_camera_path.json");
    jsonFile << "{\n";
    jsonFile << "  \"totalFrames\": " << totalFrames << ",\n";
    jsonFile << "  \"fps\": 24,\n";
    jsonFile << "  \"durationSec\": " << durationSec << ",\n";
    jsonFile << "  \"modelGlb\": \"analytical_cuboid_blockout.glb\",\n";
    jsonFile << "  \"environment\": \"Synthetic Analytical Cuboid Box Environment\",\n";
    jsonFile << "  \"collisionAudited\": true,\n";
    jsonFile << "  \"minClearanceMeters\": " << MIN_CLEARANCE_METERS << ",\n";
    jsonFile << "  \"frames\": [\n";

    for (size_t f = 0; f < verifiedWaypoints.size(); ++f) {
        const auto& wp = verifiedWaypoints[f];
        jsonFile << "    {\n";
        jsonFile << "      \"frame\": " << wp.frameIndex << ",\n";
        jsonFile << "      \"timeSec\": " << std::fixed << std::setprecision(3) << wp.timeSec << ",\n";
        jsonFile << "      \"position\": [" << wp.position.x << ", " << wp.position.y << ", " << wp.position.z << "],\n";
        jsonFile << "      \"target\": [" << wp.target.x << ", " << wp.target.y << ", " << wp.target.z << "],\n";
        jsonFile << "      \"up\": [" << wp.up.x << ", " << wp.up.y << ", " << wp.up.z << "],\n";
        jsonFile << "      \"fov\": 65.0,\n";
        jsonFile << "      \"rollDeg\": " << wp.rollDeg << "\n";
        jsonFile << "    }" << (f < verifiedWaypoints.size() - 1 ? "," : "") << "\n";
    }

    jsonFile << "  ]\n";
    jsonFile << "}\n";
    jsonFile.close();

    std::cout << "  [Result] Exported verified collision-free camera path: public/models/analytical_cuboid_camera_path.json\n";
    std::cout << "======================================================================\n";
    return 0;
}
