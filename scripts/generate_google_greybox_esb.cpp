/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Native C++20 Generator: Google Maps-Informed Low-Poly Grey-Box Empire State Building
 *
 * Uses Scratchbox Astra 3D Engine core geometry and GlbWriter to produce a clean,
 * planar, low-poly architectural grey-box massing model adhering to Google 3D Tiles
 * spatial envelopes, setbacks, and 443.2m datum.
 ********************************************************************************/

#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include <iostream>
#include <fstream>
#include <vector>
#include <cmath>
#include <filesystem>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::io;

// Helper to add outward quad
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

    mesh.addTriangle(base, base + 1, base + 2);
    mesh.addTriangle(base, base + 2, base + 3);
}

// Helper to add architectural box tier with facade color and roof color
inline void addArchitecturalTier(
    ScratchboxMesh& mesh,
    const Vec3& center,
    const Vec3& size,
    const Vec4& facadeColor,
    const Vec4& roofColor,
    bool includeBottom = false
) {
    Vec3 h = size * 0.5f;

    Vec3 p000 = center + Vec3(-h.x, -h.y, -h.z);
    Vec3 p100 = center + Vec3( h.x, -h.y, -h.z);
    Vec3 p101 = center + Vec3( h.x, -h.y,  h.z);
    Vec3 p001 = center + Vec3(-h.x, -h.y,  h.z);

    Vec3 p010 = center + Vec3(-h.x,  h.y, -h.z);
    Vec3 p110 = center + Vec3( h.x,  h.y, -h.z);
    Vec3 p111 = center + Vec3( h.x,  h.y,  h.z);
    Vec3 p011 = center + Vec3(-h.x,  h.y,  h.z);

    // Front (+Z)
    addQuad(mesh, p001, p101, p111, p011, Vec3(0, 0, 1), facadeColor);
    // Back (-Z)
    addQuad(mesh, p100, p000, p010, p110, Vec3(0, 0, -1), facadeColor);
    // Left (-X)
    addQuad(mesh, p000, p001, p011, p010, Vec3(-1, 0, 0), facadeColor);
    // Right (+X)
    addQuad(mesh, p101, p100, p110, p111, Vec3(1, 0, 0), facadeColor);
    // Top (+Y)
    addQuad(mesh, p011, p111, p110, p010, Vec3(0, 1, 0), roofColor);

    if (includeBottom) {
        // Bottom (-Y)
        addQuad(mesh, p000, p100, p101, p001, Vec3(0, -1, 0), facadeColor);
    }
}

// Helper to add octagonal cylinder tier (for mooring mast and observation decks)
inline void addOctagonalTier(
    ScratchboxMesh& mesh,
    float yBottom,
    float yTop,
    float rBottom,
    float rTop,
    const Vec3& centerXZ,
    const Vec4& wallColor,
    const Vec4& roofColor,
    int segments = 8
) {
    uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
    float angleStep = TWO_PI / static_cast<float>(segments);

    // Build side quads
    for (int i = 0; i < segments; ++i) {
        float a0 = i * angleStep;
        float a1 = (i + 1) * angleStep;

        float c0 = std::cos(a0), s0 = std::sin(a0);
        float c1 = std::cos(a1), s1 = std::sin(a1);

        Vec3 b0 = centerXZ + Vec3(c0 * rBottom, yBottom, s0 * rBottom);
        Vec3 b1 = centerXZ + Vec3(c1 * rBottom, yBottom, s1 * rBottom);
        Vec3 t1 = centerXZ + Vec3(c1 * rTop, yTop, s1 * rTop);
        Vec3 t0 = centerXZ + Vec3(c0 * rTop, yTop, s0 * rTop);

        Vec3 n0 = Vec3((c0 + c1) * 0.5f, 0.0f, (s0 + s1) * 0.5f).normalized();
        addQuad(mesh, b0, b1, t1, t0, n0, wallColor);
    }

    // Build roof disc fan
    uint32_t centerTopIdx = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex(Vertex(centerXZ + Vec3(0, yTop, 0), Vec3(0, 1, 0), Vec2(0.5f, 0.5f), roofColor));

    uint32_t ringStart = static_cast<uint32_t>(mesh.vertices.size());
    for (int i = 0; i < segments; ++i) {
        float a = i * angleStep;
        Vec3 p = centerXZ + Vec3(std::cos(a) * rTop, yTop, std::sin(a) * rTop);
        mesh.addVertex(Vertex(p, Vec3(0, 1, 0), Vec2(0.5f + 0.5f * std::cos(a), 0.5f + 0.5f * std::sin(a)), roofColor));
    }

    for (int i = 0; i < segments; ++i) {
        uint32_t next = (i + 1) % segments;
        mesh.addTriangle(centerTopIdx, ringStart + i, ringStart + next);
    }
}

int main() {
    std::cout << "======================================================================\n";
    std::cout << "  SCRATCHBOX 3D ENGINE: NATIVE C++20 GOOGLE GREY-BOX ESB GENERATOR\n";
    std::cout << "======================================================================\n";

    ScratchboxMesh esb("google_greybox_empire_state_building");

    // Studio Grey Box PBR Material Palette
    PbrMaterial greyBoxMat;
    greyBoxMat.name = "studio_grey_clay";
    greyBoxMat.baseColorFactor = Vec4(0.56f, 0.58f, 0.61f, 1.0f); // #8e929b Studio Neutral Grey
    greyBoxMat.roughnessFactor = 0.80f;
    greyBoxMat.metallicFactor = 0.02f;
    esb.material = greyBoxMat;

    // Palette shades for architectural contrast
    Vec4 colFacadeLight(0.58f, 0.60f, 0.63f, 1.0f); // #9499a1 primary facade
    Vec4 colFacadeDeep(0.52f, 0.54f, 0.57f, 1.0f);  // #858a91 secondary recess
    Vec4 colRoofSlate(0.38f, 0.40f, 0.44f, 1.0f);   // #616670 setback roof terrace
    Vec4 colCrownGlow(0.70f, 0.72f, 0.76f, 1.0f);   // #b3b8c2 observation deck & spire
    Vec4 colSpireMetal(0.80f, 0.82f, 0.86f, 1.0f);  // #ccd1db pinnacle antenna needle

    // Center offset: centered at origin (0, 0, 0) in model coordinates
    // When loaded in Three.js or engine, modelsRootGroup is placed at the surveyed
    // cadastral parcel centroid (-47.01m, 0, -26.06m) with Manhattan Grid rotation Y = -29.0°,
    // perfectly matching Block 835, Lot 41 and aligning with 5th Ave and W 33rd/34th Streets.
    float centerX = 0.0f;
    float centerZ = 0.0f;
    Vec3 cOrigin(centerX, 0.0f, centerZ);

    // -------------------------------------------------------------------------
    // Tier 1: Street Level Commercial Podium (Stories 1–5, Y: 0 to 18m)
    // Footprint: 101.5m (cross-street along 33rd/34th) x 62.0m (along 5th Ave) x 18m
    // Fits exactly within surveyed cadastral Lot 41: u in [-104.5, -3.0], v in [-31.0, 31.0]
    // -------------------------------------------------------------------------
    addArchitecturalTier(esb, cOrigin + Vec3(0, 9.0f, 0), Vec3(101.5f, 18.0f, 62.0f), colFacadeLight, colRoofSlate, true);

    // -------------------------------------------------------------------------
    // Tier 2: Lower Setback (Stories 6–10, Y: 18m to 40m)
    // Footprint: 84.5m x 54.0m x 22m
    // -------------------------------------------------------------------------
    addArchitecturalTier(esb, cOrigin + Vec3(0, 29.0f, 0), Vec3(84.5f, 22.0f, 54.0f), colFacadeLight, colRoofSlate);

    // -------------------------------------------------------------------------
    // Tier 3: Mid Setback (Stories 11–21, Y: 40m to 86m)
    // Footprint: 72.0m x 48.0m x 46m
    // -------------------------------------------------------------------------
    addArchitecturalTier(esb, cOrigin + Vec3(0, 63.0f, 0), Vec3(72.0f, 46.0f, 48.0f), colFacadeLight, colRoofSlate);

    // -------------------------------------------------------------------------
    // Tier 4: Main Tower Shaft (Stories 22–72, Y: 86m to 250m)
    // Footprint: 57.0m x 40.0m x 164m
    // -------------------------------------------------------------------------
    addArchitecturalTier(esb, cOrigin + Vec3(0, 168.0f, 0), Vec3(57.0f, 164.0f, 40.0f), colFacadeLight, colRoofSlate);

    // Architectural Chamfered Wings on Tower Corners (Art Deco massing lines)
    float wingH = 160.0f;
    addArchitecturalTier(esb, cOrigin + Vec3(0, 168.0f, 0), Vec3(61.0f, wingH, 34.0f), colFacadeDeep, colRoofSlate);
    addArchitecturalTier(esb, cOrigin + Vec3(0, 168.0f, 0), Vec3(51.0f, wingH, 44.0f), colFacadeDeep, colRoofSlate);

    // -------------------------------------------------------------------------
    // Tier 5: Upper Tower Setback 1 (Stories 73–81, Y: 250m to 288m)
    // Footprint: 52.0m x 36.0m x 38m
    // -------------------------------------------------------------------------
    addArchitecturalTier(esb, cOrigin + Vec3(0, 269.0f, 0), Vec3(52.0f, 38.0f, 36.0f), colFacadeLight, colRoofSlate);

    // -------------------------------------------------------------------------
    // Tier 6: Upper Tower Setback 2 (Stories 82–85, Y: 288m to 320m)
    // Footprint: 46.0m x 30.0m x 32m
    // -------------------------------------------------------------------------
    addArchitecturalTier(esb, cOrigin + Vec3(0, 304.0f, 0), Vec3(46.0f, 32.0f, 30.0f), colFacadeLight, colRoofSlate);

    // -------------------------------------------------------------------------
    // Tier 7: 86th Floor Observation Deck & Glass Pavilion (Y: 320m to 330m)
    // Footprint: 40.0m x 24.0m x 10m
    // -------------------------------------------------------------------------
    addArchitecturalTier(esb, cOrigin + Vec3(0, 325.0f, 0), Vec3(40.0f, 10.0f, 24.0f), colCrownGlow, colRoofSlate);
    addArchitecturalTier(esb, cOrigin + Vec3(0, 332.0f, 0), Vec3(32.0f, 4.0f, 18.0f), colFacadeLight, colRoofSlate);

    // -------------------------------------------------------------------------
    // Tier 8: 102nd Floor Glass Observation Tower (Y: 334m to 375m)
    // Stepped low-poly tower rising to base of mooring mast
    // -------------------------------------------------------------------------
    addArchitecturalTier(esb, cOrigin + Vec3(0, 344.0f, 0), Vec3(22.0f, 20.0f, 16.0f), colFacadeLight, colRoofSlate);
    addArchitecturalTier(esb, cOrigin + Vec3(0, 360.0f, 0), Vec3(16.0f, 12.0f, 14.0f), colCrownGlow, colRoofSlate);
    addArchitecturalTier(esb, cOrigin + Vec3(0, 370.0f, 0), Vec3(13.0f, 8.0f, 11.0f), colCrownGlow, colRoofSlate);

    // -------------------------------------------------------------------------
    // Tier 9: Art Deco Mooring Mast (Y: 375m to 420m)
    // Stepped circular/octagonal column (diameter 10m tapering to 6m)
    // -------------------------------------------------------------------------
    Vec3 mastCenter = cOrigin;
    addOctagonalTier(esb, 375.0f, 395.0f, 5.5f, 4.8f, mastCenter, colCrownGlow, colRoofSlate, 12);
    addOctagonalTier(esb, 395.0f, 412.0f, 4.8f, 3.8f, mastCenter, colCrownGlow, colRoofSlate, 12);
    addOctagonalTier(esb, 412.0f, 420.0f, 3.8f, 3.0f, mastCenter, colCrownGlow, colRoofSlate, 12);

    // Mooring Mast Ring Fins (Art Deco fins)
    for (int i = 0; i < 4; ++i) {
        float yFin = 380.0f + i * 8.0f;
        addOctagonalTier(esb, yFin, yFin + 0.8f, 6.2f, 6.2f, mastCenter, colSpireMetal, colRoofSlate, 12);
    }

    // -------------------------------------------------------------------------
    // Tier 10: Broadcast Needle & Steel Spire Tip (Y: 420m to 443.2m exact datum)
    // -------------------------------------------------------------------------
    addOctagonalTier(esb, 420.0f, 432.0f, 2.2f, 1.4f, mastCenter, colSpireMetal, colRoofSlate, 8);
    addOctagonalTier(esb, 432.0f, 440.0f, 1.4f, 0.6f, mastCenter, colSpireMetal, colRoofSlate, 8);
    addOctagonalTier(esb, 440.0f, 443.2f, 0.6f, 0.1f, mastCenter, colSpireMetal, colRoofSlate, 6);

    // Recompute normals and bounding volume
    esb.recomputeNormals();
    esb.recomputeBounds();

    std::cout << "  Generated Low-Poly Empire State Building:\n";
    std::cout << "    -> Vertices:  " << esb.vertices.size() << "\n";
    std::cout << "    -> Triangles: " << (esb.indices.size() / 3) << "\n";
    std::cout << "    -> Height:    " << esb.bounds.max.y << " m (Datum: 443.2m)\n";
    std::cout << "    -> Base Span: " << (esb.bounds.max.x - esb.bounds.min.x) << "m x "
              << (esb.bounds.max.z - esb.bounds.min.z) << "m\n";

    // Serialize to standard binary glTF 2.0 (.glb)
    std::vector<uint8_t> glbData = GlbWriter::serializeToGlb(esb);
    std::filesystem::create_directories("public/models");
    std::string outputPath = "public/models/google_greybox_esb.glb";

    std::ofstream outFile(outputPath, std::ios::binary);
    if (!outFile.is_open()) {
        std::cerr << "  [Error] Failed to open " << outputPath << " for writing\n";
        return 1;
    }
    outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
    outFile.close();

    std::cout << "  [Success] Saved Google Grey-Box GLB: " << outputPath
              << " (" << (glbData.size() / 1024.0f) << " KB)\n";
    std::cout << "======================================================================\n";
    return 0;
}
