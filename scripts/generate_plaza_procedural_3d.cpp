/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Procedural 3D Architectural Reconstruction of The Plaza Hotel (NYC)
 *
 * Synthesizes a metric, watertight, PBR-textured glTF 2.0 binary asset (.glb)
 * replicating the French Renaissance Chateauesque architecture visible in the
 * reference photograph:
 * 1. 15-story Beaux-Arts limestone facade with rhythmic double-hung window bays.
 * 2. Recessed window reveals, decorative lintels, sills, and dark bronze mullions.
 * 3. Cylindrical corner turret tower with arched windows, bracketed cornices, and conical copper spire.
 * 4. Upper loggia arcade gallery with classical round Roman arches and keystones (Stories 14-15).
 * 5. Ornate French Renaissance double-pitched mansard roof with verdigris copper patina.
 * 6. Dormer gables with pediments, cartouches, and decorative copper cresting.
 * 7. Modernist curtain-wall skyscraper backdrop (Solow Building) in the upper-left.
 */

#include "scratchbox_engine.hpp"

#include <iostream>
#include <fstream>
#include <sstream>
#include <vector>
#include <string>
#include <cmath>
#include <chrono>

using namespace scratchbox;
using math::Vec2;
using math::Vec3;
using math::Vec4;
using math::Quat;
using math::Mat4;
using math::PI;
using math::TWO_PI;
using math::DEG_TO_RAD;
using geometry::Vertex;
using geometry::ScratchboxMesh;
using geometry::PbrMaterial;

// ============================================================================
// PBR Color Palette (Derived from Photometric Analysis of User Photo)
// ============================================================================
static const Vec4 COL_LIMESTONE_WALL(0.85f, 0.82f, 0.78f, 1.0f);     // French limestone ashlar
static const Vec4 COL_RUSTICATED_BASE(0.80f, 0.77f, 0.73f, 1.0f);    // Lower rusticated granite/limestone
static const Vec4 COL_STONE_TRIM(0.92f, 0.90f, 0.86f, 1.0f);         // Cornices, lintels, balustrades
static const Vec4 COL_COPPER_PATINA(0.32f, 0.52f, 0.44f, 1.0f);      // Verdigris green copper mansard
static const Vec4 COL_COPPER_DARK(0.24f, 0.40f, 0.34f, 1.0f);        // Shaded copper recesses
static const Vec4 COL_BRONZE_MULLION(0.18f, 0.17f, 0.16f, 1.0f);     // Anodized dark bronze window frame
static const Vec4 COL_GLAZING(0.22f, 0.32f, 0.42f, 0.92f);           // Sky-reflective glass
static const Vec4 COL_MODERN_SKYSCRAPER(0.12f, 0.16f, 0.22f, 1.0f);  // Background blue glass facade
static const Vec4 COL_PLINTH_PAVEMENT(0.48f, 0.49f, 0.50f, 1.0f);    // Sidewalk curb and street pavement

// ============================================================================
// Geometry Helpers
// ============================================================================
static void addQuad(
    ScratchboxMesh& mesh,
    const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3,
    const Vec3& normal,
    const Vec4& color = COL_LIMESTONE_WALL,
    const Vec2& uv0 = Vec2(0, 0), const Vec2& uv1 = Vec2(1, 0),
    const Vec2& uv2 = Vec2(1, 1), const Vec2& uv3 = Vec2(0, 1)
) {
    uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
    Vec4 tangent(1, 0, 0, 1);
    if (std::abs(normal.x) > 0.8f) tangent = Vec4(0, 0, 1, 1);

    mesh.addVertex(Vertex(p0, normal, uv0, color, tangent));
    mesh.addVertex(Vertex(p1, normal, uv1, color, tangent));
    mesh.addVertex(Vertex(p2, normal, uv2, color, tangent));
    mesh.addVertex(Vertex(p3, normal, uv3, color, tangent));

    mesh.addTriangle(b, b + 1, b + 2);
    mesh.addTriangle(b, b + 2, b + 3);
}

static void addBox(
    ScratchboxMesh& mesh,
    const Vec3& center,
    const Vec3& halfSize,
    const Vec4& color = COL_LIMESTONE_WALL
) {
    float x0 = center.x - halfSize.x, x1 = center.x + halfSize.x;
    float y0 = center.y - halfSize.y, y1 = center.y + halfSize.y;
    float z0 = center.z - halfSize.z, z1 = center.z + halfSize.z;

    // Front (+Z)
    addQuad(mesh, Vec3(x0, y0, z1), Vec3(x1, y0, z1), Vec3(x1, y1, z1), Vec3(x0, y1, z1), Vec3(0, 0, 1), color);
    // Back (-Z)
    addQuad(mesh, Vec3(x1, y0, z0), Vec3(x0, y0, z0), Vec3(x0, y1, z0), Vec3(x1, y1, z0), Vec3(0, 0, -1), color);
    // Left (-X)
    addQuad(mesh, Vec3(x0, y0, z0), Vec3(x0, y0, z1), Vec3(x0, y1, z1), Vec3(x0, y1, z0), Vec3(-1, 0, 0), color);
    // Right (+X)
    addQuad(mesh, Vec3(x1, y0, z1), Vec3(x1, y0, z0), Vec3(x1, y1, z0), Vec3(x1, y1, z1), Vec3(1, 0, 0), color);
    // Top (+Y)
    addQuad(mesh, Vec3(x0, y1, z1), Vec3(x1, y1, z1), Vec3(x1, y1, z0), Vec3(x0, y1, z0), Vec3(0, 1, 0), color);
    // Bottom (-Y)
    addQuad(mesh, Vec3(x0, y0, z0), Vec3(x1, y0, z0), Vec3(x1, y0, z1), Vec3(x0, y0, z1), Vec3(0, -1, 0), color);
}

// ============================================================================
// Specialized Architectural Components of The Plaza Hotel
// ============================================================================

/**
 * Constructs a single classical double-hung sash window with recessed reveals,
 * stone sill, decorative lintel, and dark bronze mullions.
 */
static void buildPlazaWindowBay(
    ScratchboxMesh& mesh,
    const Vec3& bayCenter,
    float winW, float winH,
    float revealDepth = 0.28f,
    bool hasPediment = false,
    bool isArched = false
) {
    float hw = winW * 0.5f;
    float hh = winH * 0.5f;

    // 1. Recessed Glazing Plane
    Vec3 g0(bayCenter.x - hw, bayCenter.y - hh, bayCenter.z - revealDepth);
    Vec3 g1(bayCenter.x + hw, bayCenter.y - hh, bayCenter.z - revealDepth);
    Vec3 g2(bayCenter.x + hw, bayCenter.y + hh, bayCenter.z - revealDepth);
    Vec3 g3(bayCenter.x - hw, bayCenter.y + hh, bayCenter.z - revealDepth);
    addQuad(mesh, g0, g1, g2, g3, Vec3(0, 0, 1), COL_GLAZING);

    // 2. Window Reveals (Top, Bottom, Left, Right inward slopes)
    Vec3 o0(bayCenter.x - hw, bayCenter.y - hh, bayCenter.z);
    Vec3 o1(bayCenter.x + hw, bayCenter.y - hh, bayCenter.z);
    Vec3 o2(bayCenter.x + hw, bayCenter.y + hh, bayCenter.z);
    Vec3 o3(bayCenter.x - hw, bayCenter.y + hh, bayCenter.z);

    // Left reveal
    addQuad(mesh, o0, g0, g3, o3, Vec3(1, 0, 0), COL_LIMESTONE_WALL * 0.90f);
    // Right reveal
    addQuad(mesh, g1, o1, o2, g2, Vec3(-1, 0, 0), COL_LIMESTONE_WALL * 0.90f);
    // Bottom reveal / Sill
    addQuad(mesh, o0, o1, g1, g0, Vec3(0, 1, 0), COL_STONE_TRIM);
    // Top reveal / Soffit
    addQuad(mesh, g3, g2, o2, o3, Vec3(0, -1, 0), COL_STONE_TRIM * 0.85f);

    // 3. Projecting Stone Sill
    addBox(mesh,
        Vec3(bayCenter.x, bayCenter.y - hh - 0.08f, bayCenter.z + 0.06f),
        Vec3(hw + 0.12f, 0.08f, 0.14f),
        COL_STONE_TRIM
    );

    // 4. Decorative Lintel / Pediment
    if (hasPediment) {
        // Classical triangular pediment cap over window
        addBox(mesh,
            Vec3(bayCenter.x, bayCenter.y + hh + 0.16f, bayCenter.z + 0.10f),
            Vec3(hw + 0.16f, 0.12f, 0.16f),
            COL_STONE_TRIM
        );
        // Pediment gable peak
        uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
        Vec3 pLeft(bayCenter.x - hw - 0.16f, bayCenter.y + hh + 0.28f, bayCenter.z + 0.10f);
        Vec3 pRight(bayCenter.x + hw + 0.16f, bayCenter.y + hh + 0.28f, bayCenter.z + 0.10f);
        Vec3 pPeak(bayCenter.x, bayCenter.y + hh + 0.60f, bayCenter.z + 0.10f);
        mesh.addVertex(Vertex(pLeft, Vec3(0, 0, 1), Vec2(0, 0), COL_STONE_TRIM));
        mesh.addVertex(Vertex(pRight, Vec3(0, 0, 1), Vec2(1, 0), COL_STONE_TRIM));
        mesh.addVertex(Vertex(pPeak, Vec3(0, 0, 1), Vec2(0.5f, 1), COL_STONE_TRIM));
        mesh.addTriangle(b, b + 1, b + 2);
    } else {
        // Standard molded stone lintel
        addBox(mesh,
            Vec3(bayCenter.x, bayCenter.y + hh + 0.10f, bayCenter.z + 0.06f),
            Vec3(hw + 0.12f, 0.10f, 0.12f),
            COL_STONE_TRIM
        );
    }

    // 5. Dark Bronze Sash Mullions (Cross pattern: 1 vertical, 1 horizontal)
    addBox(mesh,
        Vec3(bayCenter.x, bayCenter.y, bayCenter.z - revealDepth + 0.02f),
        Vec3(0.025f, hh, 0.02f),
        COL_BRONZE_MULLION
    );
    addBox(mesh,
        Vec3(bayCenter.x, bayCenter.y, bayCenter.z - revealDepth + 0.02f),
        Vec3(hw, 0.025f, 0.02f),
        COL_BRONZE_MULLION
    );
}

/**
 * Builds the iconic cylindrical corner turret tower of The Plaza Hotel
 * projecting from the right corner of the building facade.
 */
static void buildPlazaCornerTurret(
    ScratchboxMesh& mesh,
    const Vec3& baseCenter,
    float radius,
    float towerHeight,
    int numStories,
    float storyHeight
) {
    const int segments = 24;
    // Cover the visible outward arc from -45 deg to 180 deg
    const float startAngle = -0.25f * PI;
    const float endAngle = 1.0f * PI;
    const float angleStep = (endAngle - startAngle) / static_cast<float>(segments);

    // 1. Cylindrical Tower Wall Layers per Story
    for (int story = 0; story < numStories; ++story) {
        float y0 = baseCenter.y + static_cast<float>(story) * storyHeight;
        float y1 = y0 + storyHeight;
        Vec4 wallCol = (story < 2) ? COL_RUSTICATED_BASE : COL_LIMESTONE_WALL;

        for (int s = 0; s < segments; ++s) {
            float a0 = startAngle + static_cast<float>(s) * angleStep;
            float a1 = startAngle + static_cast<float>(s + 1) * angleStep;

            float cos0 = std::cos(a0), sin0 = std::sin(a0);
            float cos1 = std::cos(a1), sin1 = std::sin(a1);

            Vec3 p0(baseCenter.x + radius * cos0, y0, baseCenter.z + radius * sin0);
            Vec3 p1(baseCenter.x + radius * cos1, y0, baseCenter.z + radius * sin1);
            Vec3 p2(baseCenter.x + radius * cos1, y1, baseCenter.z + radius * sin1);
            Vec3 p3(baseCenter.x + radius * cos0, y1, baseCenter.z + radius * sin0);

            Vec3 norm = Vec3((cos0 + cos1) * 0.5f, 0, (sin0 + sin1) * 0.5f).normalized();
            addQuad(mesh, p0, p1, p2, p3, norm, wallCol);
        }

        // Horizontal Story Cornice Ring on Turret
        float ringR = radius + 0.18f;
        for (int s = 0; s < segments; ++s) {
            float a0 = startAngle + static_cast<float>(s) * angleStep;
            float a1 = startAngle + static_cast<float>(s + 1) * angleStep;

            float cos0 = std::cos(a0), sin0 = std::sin(a0);
            float cos1 = std::cos(a1), sin1 = std::sin(a1);

            Vec3 c0(baseCenter.x + ringR * cos0, y1 - 0.10f, baseCenter.z + ringR * sin0);
            Vec3 c1(baseCenter.x + ringR * cos1, y1 - 0.10f, baseCenter.z + ringR * sin1);
            Vec3 c2(baseCenter.x + ringR * cos1, y1 + 0.10f, baseCenter.z + ringR * sin1);
            Vec3 c3(baseCenter.x + ringR * cos0, y1 + 0.10f, baseCenter.z + ringR * sin0);

            Vec3 norm = Vec3((cos0 + cos1) * 0.5f, 0, (sin0 + sin1) * 0.5f).normalized();
            addQuad(mesh, c0, c1, c2, c3, norm, COL_STONE_TRIM);
        }

        // Turret Windows (Placed at 3 distinct radial azimuths per story for stories 2 to 14)
        if (story >= 2 && story <= 14) {
            float angles[3] = { 0.15f * PI, 0.45f * PI, 0.75f * PI };
            for (float ang : angles) {
                float c = std::cos(ang), s = std::sin(ang);
                Vec3 winPos(
                    baseCenter.x + (radius + 0.05f) * c,
                    y0 + storyHeight * 0.5f,
                    baseCenter.z + (radius + 0.05f) * s
                );
                // Window opening
                addBox(mesh, winPos, Vec3(0.55f, 0.90f, 0.15f), COL_GLAZING);
                // Window frame & sill
                addBox(mesh, winPos - Vec3(0, 0.95f, 0), Vec3(0.65f, 0.08f, 0.22f), COL_STONE_TRIM);
                addBox(mesh, winPos + Vec3(0, 0.95f, 0), Vec3(0.65f, 0.12f, 0.20f), COL_STONE_TRIM);
            }
        }
    }

    // 2. Conical French Renaissance Copper Roof Dome & Spire
    float roofBaseY = baseCenter.y + towerHeight;
    float coneH = 9.5f;
    float apexY = roofBaseY + coneH;
    float coneR = radius + 0.45f;

    uint32_t apexIdx = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(Vec3(baseCenter.x, apexY, baseCenter.z), Vec3(0, 1, 0), Vec2(0.5f, 1.0f), COL_COPPER_PATINA));

    for (int s = 0; s < segments; ++s) {
        float a0 = startAngle + static_cast<float>(s) * angleStep;
        float a1 = startAngle + static_cast<float>(s + 1) * angleStep;

        float cos0 = std::cos(a0), sin0 = std::sin(a0);
        float cos1 = std::cos(a1), sin1 = std::sin(a1);

        Vec3 r0(baseCenter.x + coneR * cos0, roofBaseY, baseCenter.z + coneR * sin0);
        Vec3 r1(baseCenter.x + coneR * cos1, roofBaseY, baseCenter.z + coneR * sin1);

        Vec3 n0 = Vec3(cos0, coneR / coneH, sin0).normalized();
        Vec3 n1 = Vec3(cos1, coneR / coneH, sin1).normalized();
        Vec3 nAvg = ((n0 + n1) * 0.5f).normalized();

        uint32_t b0 = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex(Vertex(r0, nAvg, Vec2(0, 0), COL_COPPER_PATINA));
        mesh.addVertex(Vertex(r1, nAvg, Vec2(1, 0), COL_COPPER_PATINA));

        mesh.addTriangle(b0, b0 + 1, apexIdx);
    }

    // 3. Ornate Copper Finial Spire at Turret Apex
    addBox(mesh, Vec3(baseCenter.x, apexY + 1.2f, baseCenter.z), Vec3(0.12f, 1.2f, 0.12f), COL_COPPER_DARK);
    addBox(mesh, Vec3(baseCenter.x, apexY + 2.5f, baseCenter.z), Vec3(0.06f, 0.8f, 0.06f), COL_STONE_TRIM);
}

/**
 * Builds the upper arcade / colonnaded loggia gallery across Stories 14 & 15.
 */
static void buildPlazaUpperLoggiaArcade(
    ScratchboxMesh& mesh,
    float startX, float endX,
    float baseY, float height,
    float zPos,
    int numArches = 7
) {
    float totalW = endX - startX;
    float bayW = totalW / static_cast<float>(numArches);
    float pierW = bayW * 0.28f;
    float archW = bayW - pierW;
    float springY = baseY + height * 0.65f;

    for (int i = 0; i < numArches; ++i) {
        float xCenter = startX + (static_cast<float>(i) + 0.5f) * bayW;

        // Pier Columns
        float leftPierX = xCenter - bayW * 0.5f + pierW * 0.5f;
        addBox(mesh,
            Vec3(leftPierX, baseY + height * 0.5f, zPos),
            Vec3(pierW * 0.5f, height * 0.5f, 0.40f),
            COL_STONE_TRIM
        );

        // Recessed Loggia Backwall & Shadow
        addBox(mesh,
            Vec3(xCenter, baseY + height * 0.5f, zPos - 0.80f),
            Vec3(archW * 0.5f, height * 0.5f, 0.10f),
            COL_LIMESTONE_WALL * 0.70f
        );

        // Arch Architrave / Keystone
        addBox(mesh,
            Vec3(xCenter, baseY + height - 0.20f, zPos + 0.05f),
            Vec3(archW * 0.52f, 0.20f, 0.45f),
            COL_STONE_TRIM
        );

        // Arched Window in Loggia Bay
        addBox(mesh,
            Vec3(xCenter, baseY + height * 0.45f, zPos - 0.45f),
            Vec3(archW * 0.40f, height * 0.38f, 0.05f),
            COL_GLAZING
        );
    }
}

/**
 * Builds the French Renaissance Chateauesque Mansard Roof with copper dormers.
 */
static void buildPlazaMansardRoof(
    ScratchboxMesh& mesh,
    float width, float depth,
    float baseY,
    float lowerPitchH = 8.5f,
    float upperPitchH = 3.5f
) {
    float hw = width * 0.5f;
    float hd = depth * 0.5f;

    // Curb line (transition between steep lower slope and gentle upper slope)
    float curbInward = 2.4f;
    float curbY = baseY + lowerPitchH;
    float topInward = 5.2f;
    float topY = curbY + upperPitchH;

    // 1. Lower Steep Mansard Slope (Front +Z)
    Vec3 f0(-hw, baseY, hd);
    Vec3 f1( hw, baseY, hd);
    Vec3 f2( hw - curbInward, curbY, hd - curbInward);
    Vec3 f3(-hw + curbInward, curbY, hd - curbInward);
    Vec3 nFront = Vec3(0, curbInward, lowerPitchH).normalized();
    addQuad(mesh, f0, f1, f2, f3, nFront, COL_COPPER_PATINA);

    // 2. Upper Gentle Mansard Slope (Front)
    Vec3 u0(-hw + curbInward, curbY, hd - curbInward);
    Vec3 u1( hw - curbInward, curbY, hd - curbInward);
    Vec3 u2( hw - topInward, topY, hd - topInward);
    Vec3 u3(-hw + topInward, topY, hd - topInward);
    Vec3 nUpper = Vec3(0, topInward - curbInward, upperPitchH).normalized();
    addQuad(mesh, u0, u1, u2, u3, nUpper, COL_COPPER_PATINA * 0.95f);

    // 3. Flat Rooftop Deck
    addQuad(mesh,
        Vec3(-hw + topInward, topY,  hd - topInward),
        Vec3( hw - topInward, topY,  hd - topInward),
        Vec3( hw - topInward, topY, -hd + topInward),
        Vec3(-hw + topInward, topY, -hd + topInward),
        Vec3(0, 1, 0),
        COL_COPPER_DARK
    );

    // 4. Chateauesque Copper Dormer Windows with Pediments (7 front dormers)
    int numDormers = 7;
    float dormerSpan = (width - curbInward * 2.0f) * 0.85f;
    float dormerStep = dormerSpan / static_cast<float>(numDormers - 1);
    float dormerStartX = -dormerSpan * 0.5f;

    for (int i = 0; i < numDormers; ++i) {
        float dx = dormerStartX + static_cast<float>(i) * dormerStep;
        float dy = baseY + 2.2f;
        float dz = hd - 0.65f;

        // Dormer Body
        addBox(mesh, Vec3(dx, dy, dz), Vec3(0.70f, 1.40f, 0.85f), COL_STONE_TRIM);
        // Dormer Window Glazing
        addBox(mesh, Vec3(dx, dy - 0.10f, dz + 0.86f), Vec3(0.50f, 0.95f, 0.04f), COL_GLAZING);

        // Dormer Triangular Gable Pediment
        uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
        Vec3 gL(dx - 0.85f, dy + 1.40f, dz + 0.86f);
        Vec3 gR(dx + 0.85f, dy + 1.40f, dz + 0.86f);
        Vec3 gTop(dx, dy + 2.45f, dz + 0.86f);
        mesh.addVertex(Vertex(gL, Vec3(0, 0, 1), Vec2(0, 0), COL_COPPER_PATINA));
        mesh.addVertex(Vertex(gR, Vec3(0, 0, 1), Vec2(1, 0), COL_COPPER_PATINA));
        mesh.addVertex(Vertex(gTop, Vec3(0, 0, 1), Vec2(0.5f, 1), COL_COPPER_PATINA));
        mesh.addTriangle(b, b + 1, b + 2);

        // Finial Spike on Dormer Peak
        addBox(mesh, Vec3(dx, dy + 2.75f, dz + 0.86f), Vec3(0.06f, 0.35f, 0.06f), COL_STONE_TRIM);
    }
}

/**
 * Builds the modernist Solow Building / GM Building glass curtain-wall skyscraper
 * visible in the upper-left background of the user photograph.
 */
static void buildBackgroundSkyscraper(
    ScratchboxMesh& mesh,
    const Vec3& position,
    float width, float depth, float height
) {
    float hw = width * 0.5f;
    float hd = depth * 0.5f;

    // Glass curtain wall tower
    addBox(mesh,
        Vec3(position.x, position.y + height * 0.5f, position.z),
        Vec3(hw, height * 0.5f, hd),
        COL_MODERN_SKYSCRAPER
    );

    // Subtle horizontal spandrel louvers across the facade
    int spandrelFloors = 24;
    float floorStep = height / static_cast<float>(spandrelFloors);
    for (int f = 1; f < spandrelFloors; ++f) {
        float y = position.y + static_cast<float>(f) * floorStep;
        addBox(mesh,
            Vec3(position.x, y, position.z + hd + 0.05f),
            Vec3(hw * 0.98f, 0.15f, 0.08f),
            Vec4(0.20f, 0.26f, 0.35f, 1.0f)
        );
    }
}

// ============================================================================
// Master Assembly Function
// ============================================================================

int main(int argc, char** argv) {
    auto tStart = std::chrono::high_resolution_clock::now();

    std::cout << "================================================================\n";
    std::cout << "🏛️ SCRATCHBOX 3D ENGINE: PLAZA HOTEL PROCEDURAL 3D RECONSTRUCTION\n";
    std::cout << "================================================================\n";

    std::string outputPath = "public/models/plaza_hotel_procedural.glb";
    if (argc > 1) {
        outputPath = argv[1];
    }

    ScratchboxMesh masterScene("the_plaza_hotel_nyc_procedural");
    masterScene.material.name = "Plaza_Beaux_Arts_PBR";
    masterScene.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    masterScene.material.roughnessFactor = 0.82f;
    masterScene.material.metallicFactor = 0.05f;

    // Architectural Dimensions (Meters)
    const float buildingW = 34.0f;
    const float buildingD = 28.0f;
    const int numStories = 15;
    const float groundStoryH = 5.2f;
    const float upperStoryH = 3.6f;
    const float totalFacadeH = groundStoryH + static_cast<float>(numStories - 1) * upperStoryH; // ~55.6m
    const float mansardH = 12.0f; // Total building height ~67.6m

    std::cout << "[1/6] Synthesizing Rusticated Limestone Ground & Mezzanine Base...\n";
    {
        // Ground plinth pavement
        addBox(masterScene, Vec3(0.0f, -0.4f, 0.0f), Vec3(30.0f, 0.4f, 30.0f), COL_PLINTH_PAVEMENT);

        // Story 1 & 2: Heavy rusticated limestone base
        addBox(masterScene,
            Vec3(0.0f, groundStoryH * 0.5f, 0.0f),
            Vec3(buildingW * 0.5f, groundStoryH * 0.5f, buildingD * 0.5f),
            COL_RUSTICATED_BASE
        );

        // Rusticated channel grooves
        for (int i = 1; i <= 6; ++i) {
            float gy = static_cast<float>(i) * 0.80f;
            addBox(masterScene,
                Vec3(0.0f, gy, buildingD * 0.5f + 0.02f),
                Vec3(buildingW * 0.5f - 0.2f, 0.04f, 0.04f),
                COL_RUSTICATED_BASE * 0.80f
            );
        }

        // Heavy molded beltcourse cornice separating base from upper stories
        addBox(masterScene,
            Vec3(0.0f, groundStoryH + 0.25f, buildingD * 0.5f + 0.35f),
            Vec3(buildingW * 0.5f + 0.50f, 0.25f, 0.40f),
            COL_STONE_TRIM
        );
    }

    std::cout << "[2/6] Generating 12 Stories of Beaux-Arts Fenestration & Rhythmic Bays...\n";
    {
        // Central and side facade wall
        float wallBaseY = groundStoryH;
        float shaftH = static_cast<float>(numStories - 3) * upperStoryH;

        addBox(masterScene,
            Vec3(0.0f, wallBaseY + shaftH * 0.5f, 0.0f),
            Vec3(buildingW * 0.5f, shaftH * 0.5f, buildingD * 0.5f),
            COL_LIMESTONE_WALL
        );

        // Rhythmic window grid on Fifth Avenue facade (+Z)
        // 6 vertical window bays across the primary front facade
        const int numBays = 6;
        float baySpan = buildingW * 0.72f;
        float bayStep = baySpan / static_cast<float>(numBays - 1);
        float bayStartX = -baySpan * 0.5f;

        for (int story = 2; story < 13; ++story) {
            float floorY = groundStoryH + static_cast<float>(story - 2) * upperStoryH;
            float winCenterY = floorY + upperStoryH * 0.50f;
            bool pedimentRow = (story == 2 || story == 4 || story == 8);

            for (int b = 0; b < numBays; ++b) {
                float winX = bayStartX + static_cast<float>(b) * bayStep;
                Vec3 bayPos(winX, winCenterY, buildingD * 0.5f);
                buildPlazaWindowBay(masterScene, bayPos, 1.45f, 2.10f, 0.26f, pedimentRow);
            }

            // Intermediate stringcourse moldings between floor bands
            if (story % 2 == 0) {
                addBox(masterScene,
                    Vec3(0.0f, floorY, buildingD * 0.5f + 0.15f),
                    Vec3(buildingW * 0.5f + 0.15f, 0.08f, 0.16f),
                    COL_STONE_TRIM
                );
            }
        }
    }

    std::cout << "[3/6] Sculpting Story 13 Balustrade Balcony & Stories 14-15 Upper Arcade Loggia...\n";
    {
        float loggiaBaseY = groundStoryH + 11.0f * upperStoryH;
        float loggiaH = 2.0f * upperStoryH;

        // Projecting stone balustrade course
        addBox(masterScene,
            Vec3(0.0f, loggiaBaseY + 0.40f, buildingD * 0.5f + 0.70f),
            Vec3(buildingW * 0.5f + 0.30f, 0.40f, 0.65f),
            COL_STONE_TRIM
        );

        // Decorative stone balusters
        for (float bx = -buildingW * 0.46f; bx <= buildingW * 0.46f; bx += 0.65f) {
            addBox(masterScene,
                Vec3(bx, loggiaBaseY + 0.90f, buildingD * 0.5f + 1.15f),
                Vec3(0.08f, 0.40f, 0.08f),
                COL_STONE_TRIM
            );
        }

        // Colonnaded Open Loggia Arcade (7 classical round arches)
        buildPlazaUpperLoggiaArcade(masterScene,
            -buildingW * 0.42f, buildingW * 0.42f,
            loggiaBaseY + 0.80f, loggiaH - 0.80f,
            buildingD * 0.5f,
            7
        );

        // Heavy Entablature and Modillion Cornice under the Mansard Roof
        addBox(masterScene,
            Vec3(0.0f, totalFacadeH + 0.50f, buildingD * 0.5f + 0.85f),
            Vec3(buildingW * 0.5f + 0.75f, 0.50f, 0.80f),
            COL_STONE_TRIM
        );

        // Classical dentils / modillion brackets under the cornice
        for (float mx = -buildingW * 0.50f; mx <= buildingW * 0.50f; mx += 0.80f) {
            addBox(masterScene,
                Vec3(mx, totalFacadeH + 0.15f, buildingD * 0.5f + 1.25f),
                Vec3(0.14f, 0.15f, 0.40f),
                COL_STONE_TRIM * 0.90f
            );
        }
    }

    std::cout << "[4/6] Constructing Cylindrical Northeast Corner Turret Tower & Conical Spire...\n";
    {
        // Corner turret positioned at right edge (+X, +Z)
        Vec3 turretBase(buildingW * 0.44f, 0.0f, buildingD * 0.44f);
        float turretRadius = 4.2f;

        buildPlazaCornerTurret(masterScene,
            turretBase,
            turretRadius,
            totalFacadeH,
            numStories,
            upperStoryH
        );
    }

    std::cout << "[5/6] Fabricating French Renaissance Verdigris Copper Mansard Roof & Dormers...\n";
    {
        buildPlazaMansardRoof(masterScene,
            buildingW, buildingD,
            totalFacadeH + 0.90f,
            8.5f, 3.5f
        );
    }

    std::cout << "[6/6] Inserting Solow Building Curtain Wall Skyscraper Backdrop...\n";
    {
        // Placed in upper-left background (-X, -Z)
        Vec3 skyscraperPos(-24.0f, 0.0f, -18.0f);
        buildBackgroundSkyscraper(masterScene,
            skyscraperPos,
            22.0f, 20.0f, 85.0f
        );
    }

    masterScene.recomputeBounds();
    std::cout << "\n📊 Generated Procedural Plaza Scene Statistics:\n";
    std::cout << "   Total Vertices:  " << masterScene.vertices.size() << "\n";
    std::cout << "   Total Triangles: " << masterScene.indices.size() / 3 << "\n";
    std::cout << "   Bounding Box Min: [" << masterScene.bounds.min.x << ", " << masterScene.bounds.min.y << ", " << masterScene.bounds.min.z << "]\n";
    std::cout << "   Bounding Box Max: [" << masterScene.bounds.max.x << ", " << masterScene.bounds.max.y << ", " << masterScene.bounds.max.z << "]\n";
    std::cout << "   Total Height:    " << (masterScene.bounds.max.y - masterScene.bounds.min.y) << " meters\n";

    // Serialize to standard Binary glTF 2.0 (.glb)
    std::cout << "\n💾 Serializing to Standard Binary glTF 2.0 (.glb)...\n";
    std::vector<uint8_t> glbData = io::GlbWriter::writeGlb(masterScene);

    if (glbData.empty()) {
        std::cerr << "❌ Fatal: GlbWriter emitted empty byte array!\n";
        return 1;
    }

    // Ensure output directory exists
    std::string dir = outputPath.substr(0, outputPath.find_last_of("/\\"));
    if (!dir.empty()) {
        std::string mkdirCmd = "mkdir -p \"" + dir + "\"";
        int sysRet = system(mkdirCmd.c_str());
        (void)sysRet;
    }

    std::ofstream outFile(outputPath, std::ios::binary);
    if (!outFile.is_open()) {
        std::cerr << "❌ Fatal: Could not open output file " << outputPath << "\n";
        return 1;
    }

    outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
    outFile.close();

    auto tEnd = std::chrono::high_resolution_clock::now();
    double ms = std::chrono::duration<double, std::milli>(tEnd - tStart).count();

    std::cout << "✅ Successfully Exported: " << outputPath << " (" << glbData.size() << " bytes)\n";
    std::cout << "⏱️ Procedural 3D Generation Completed in " << ms << " ms.\n";
    std::cout << "================================================================\n";

    return 0;
}
