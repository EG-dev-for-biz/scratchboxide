/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Procedural C++20 Photorealistic Building Generator with Authentic PBR Textures
 * Empire State Building - 350 5th Ave, New York, NY 10118
 *
 * 1. Metric World-Space UV Unwrapping (Eliminating all texture stretching)
 * 2. Multi-Mesh glTF 2.0 Binary Architecture:
 *    - Indiana Limestone Facade (Piers, Setbacks, Crown)
 *    - Honed Charcoal Granite (Plinth & Water Table)
 *    - Cast Aluminum Spandrels (Stepped Art Deco Chevrons)
 *    - Allegheny 18-8 Stainless Steel (Fluted Mullions, Spire, Mooring Mast)
 *    - Low-E Solar Architectural Glazing (Recessed Double-Hung Panes)
 *    - Art Deco Statuary Cast Bronze (Grand Portals & Canopies)
 *    - Bitumen Gravel Ballast (Terrace Roofs)
 *    - NYC Scored Sidewalk Pavement (Street Grid)
 * 3. 1024x1024 Biophysically Calibrated PBR Texture Sets (Albedo, Normal, ORM, Emissive)
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_pbr_50_library.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_io.hpp"

#include <iostream>
#include <vector>
#include <cmath>
#include <string>
#include <chrono>

using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::tiles;
using namespace scratchbox::io;
using namespace scratchbox::pbr_texture;
using namespace scratchbox::texture;
namespace abs_tile = scratchbox::abstractor;

// ============================================================================
// Metric World-Space UV Unwrapped Primitives
// ============================================================================

void addBoxMetric(
    ScratchboxMesh& mesh,
    const Vec3& center,
    const Vec3& size,
    const Vec4& color,
    float scaleU = 1.0f,
    float scaleV = 1.0f
) {
    Vec3 h = size * 0.5f;

    auto addQuad = [&](const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3, const Vec3& normal) {
        uint32_t base = static_cast<uint32_t>(mesh.vertices.size());

        Vec2 uv0, uv1, uv2, uv3;
        if (std::abs(normal.y) > 0.7f) {
            // Horizontal roof / terrace / pavement (+Y / -Y)
            uv0 = { p0.x * scaleU, p0.z * scaleV };
            uv1 = { p1.x * scaleU, p1.z * scaleV };
            uv2 = { p2.x * scaleU, p2.z * scaleV };
            uv3 = { p3.x * scaleU, p3.z * scaleV };
        } else if (std::abs(normal.z) > 0.7f) {
            // North / South vertical facade (+Z / -Z)
            float signZ = normal.z > 0.0f ? 1.0f : -1.0f;
            uv0 = { signZ * p0.x * scaleU, p0.y * scaleV };
            uv1 = { signZ * p1.x * scaleU, p1.y * scaleV };
            uv2 = { signZ * p2.x * scaleU, p2.y * scaleV };
            uv3 = { signZ * p3.x * scaleU, p3.y * scaleV };
        } else {
            // East / West vertical facade (+X / -X)
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

        // Counter-Clockwise Winding
        mesh.addTriangle(base, base + 1, base + 2);
        mesh.addTriangle(base, base + 2, base + 3);
    };

    // 8 Corner Vertices
    Vec3 v001 = center + Vec3(-h.x, -h.y,  h.z);
    Vec3 v101 = center + Vec3( h.x, -h.y,  h.z);
    Vec3 v111 = center + Vec3( h.x,  h.y,  h.z);
    Vec3 v011 = center + Vec3(-h.x,  h.y,  h.z);
    Vec3 v000 = center + Vec3(-h.x, -h.y, -h.z);
    Vec3 v100 = center + Vec3( h.x, -h.y, -h.z);
    Vec3 v110 = center + Vec3( h.x,  h.y, -h.z);
    Vec3 v010 = center + Vec3(-h.x,  h.y, -h.z);

    // Front (+Z)
    addQuad(v001, v101, v111, v011, Vec3(0, 0, 1));
    // Back (-Z)
    addQuad(v100, v000, v010, v110, Vec3(0, 0, -1));
    // Right (+X)
    addQuad(v101, v100, v110, v111, Vec3(1, 0, 0));
    // Left (-X)
    addQuad(v000, v001, v011, v010, Vec3(-1, 0, 0));
    // Top (+Y)
    addQuad(v011, v111, v110, v010, Vec3(0, 1, 0));
    // Bottom (-Y)
    addQuad(v000, v100, v101, v001, Vec3(0, -1, 0));
}

void addCylinderMetric(
    ScratchboxMesh& mesh,
    const Vec3& center,
    float radiusTop,
    float radiusBottom,
    float height,
    int segments,
    const Vec4& color,
    float scaleU = 1.0f,
    float scaleV = 1.0f
) {
    float halfH = height * 0.5f;
    uint32_t base = static_cast<uint32_t>(mesh.vertices.size());
    float avgRadius = (radiusTop + radiusBottom) * 0.5f;
    float circum = TWO_PI * avgRadius;

    for (int i = 0; i <= segments; ++i) {
        float frac = static_cast<float>(i) / segments;
        float angle = frac * TWO_PI;
        float cosA = std::cos(angle);
        float sinA = std::sin(angle);

        Vec3 topPos = center + Vec3(cosA * radiusTop, halfH, sinA * radiusTop);
        Vec3 botPos = center + Vec3(cosA * radiusBottom, -halfH, sinA * radiusBottom);
        Vec3 norm(cosA, 0.0f, sinA);

        float u = frac * circum * scaleU;
        float vTop = (center.y + halfH) * scaleV;
        float vBot = (center.y - halfH) * scaleV;

        mesh.addVertex({topPos, norm, {u, vTop}, color});
        mesh.addVertex({botPos, norm, {u, vBot}, color});
    }

    for (int i = 0; i < segments; ++i) {
        uint32_t top1 = base + i * 2;
        uint32_t bot1 = base + i * 2 + 1;
        uint32_t top2 = base + (i + 1) * 2;
        uint32_t bot2 = base + (i + 1) * 2 + 1;

        mesh.addTriangle(top1, top2, bot2);
        mesh.addTriangle(top1, bot2, bot1);
    }

    // Top Cap
    uint32_t centerTopIdx = static_cast<uint32_t>(mesh.vertices.size());
    mesh.addVertex({center + Vec3(0, halfH, 0), Vec3(0, 1, 0), {center.x * scaleU, center.z * scaleV}, color});
    for (int i = 0; i < segments; ++i) {
        float a1 = (static_cast<float>(i) / segments) * TWO_PI;
        float a2 = (static_cast<float>(i + 1) / segments) * TWO_PI;
        Vec3 p1 = center + Vec3(std::cos(a1) * radiusTop, halfH, std::sin(a1) * radiusTop);
        Vec3 p2 = center + Vec3(std::cos(a2) * radiusTop, halfH, std::sin(a2) * radiusTop);
        uint32_t idx1 = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex({p1, Vec3(0, 1, 0), {p1.x * scaleU, p1.z * scaleV}, color});
        mesh.addVertex({p2, Vec3(0, 1, 0), {p2.x * scaleU, p2.z * scaleV}, color});
        mesh.addTriangle(centerTopIdx, idx1, idx1 + 1);
    }
}

// ============================================================================
// Substrate Layered Physical BSDF Builders
// ============================================================================

sub::LayeredMaterialStack buildLimestoneStack(const Vec3& baseColor = Vec3(0.86f, 0.83f, 0.77f)) {
    sub::LayeredMaterialStack s;
    s.name = "IndianaLimestone_Substrate";

    sub::PhysicalLayer base;
    base.name = "Salem Limestone Substrate";
    base.baseColor = baseColor;
    base.roughness = 0.78f;
    base.metallic = 0.02f;
    base.specularF0 = 0.04f;
    base.height = 0.45f;
    base.coverageMask = 1.0f;
    s.addLayer(base);

    sub::PhysicalLayer soot;
    soot.name = "Atmospheric Manhattan Soot";
    soot.baseColor = Vec3(0.18f, 0.17f, 0.16f);
    soot.roughness = 0.92f;
    soot.metallic = 0.0f;
    soot.height = 0.20f;
    soot.coverageMask = 0.35f;
    s.addLayer(soot);

    sub::PhysicalLayer sheen;
    sheen.name = "Weathering Rain Sheen";
    sheen.baseColor = Vec3(1.0f, 1.0f, 1.0f);
    sheen.roughness = 0.08f;
    sheen.specularF0 = 0.03f;
    sheen.ior = 1.333f;
    sheen.thicknessMm = 0.4f;
    sheen.absorptionCoeff = Vec3(0.04f, 0.02f, 0.01f);
    sheen.coverageMask = 0.85f;
    s.addLayer(sheen);

    return s;
}

sub::LayeredMaterialStack buildGraniteStack(const Vec3& baseColor = Vec3(0.18f, 0.19f, 0.20f)) {
    sub::LayeredMaterialStack s;
    s.name = "CharcoalGranite_Substrate";

    sub::PhysicalLayer base;
    base.name = "Deer Isle Charcoal Granite";
    base.baseColor = baseColor;
    base.roughness = 0.48f;
    base.metallic = 0.05f;
    base.specularF0 = 0.05f;
    base.coverageMask = 1.0f;
    s.addLayer(base);

    sub::PhysicalLayer sealer;
    sealer.name = "Street Plinth Sealer Wax";
    sealer.baseColor = Vec3(1.0f, 1.0f, 1.0f);
    sealer.roughness = 0.10f;
    sealer.specularF0 = 0.04f;
    sealer.ior = 1.333f;
    sealer.thicknessMm = 0.6f;
    sealer.coverageMask = 0.75f;
    s.addLayer(sealer);

    return s;
}

sub::LayeredMaterialStack buildSpandrelStack(const Vec3& baseColor = Vec3(0.35f, 0.36f, 0.38f)) {
    sub::LayeredMaterialStack s;
    s.name = "ArtDeco_Spandrels_Substrate";

    sub::PhysicalLayer base;
    base.name = "Alcoa 43 Die-Cast Aluminum";
    base.baseColor = baseColor;
    base.roughness = 0.42f;
    base.metallic = 0.85f;
    base.specularF0 = 0.88f;
    base.coverageMask = 1.0f;
    s.addLayer(base);

    sub::PhysicalLayer patina;
    patina.name = "Chevron Crevice Oxide Patina";
    patina.baseColor = Vec3(0.15f, 0.16f, 0.18f);
    patina.roughness = 0.85f;
    patina.metallic = 0.10f;
    patina.height = 0.20f;
    patina.coverageMask = 0.40f;
    s.addLayer(patina);

    return s;
}

sub::LayeredMaterialStack buildSteelStack(const Vec3& baseColor = Vec3(0.92f, 0.93f, 0.95f)) {
    sub::LayeredMaterialStack s;
    s.name = "StainlessSteel_Substrate";

    sub::PhysicalLayer base;
    base.name = "Allegheny 18-8 Austenitic Steel";
    base.baseColor = baseColor;
    base.roughness = 0.16f;
    base.metallic = 0.98f;
    base.specularF0 = 0.92f;
    base.coverageMask = 1.0f;
    s.addLayer(base);

    sub::PhysicalLayer passiv;
    passiv.name = "Chromium Oxide Passivation";
    passiv.baseColor = Vec3(1.0f, 1.0f, 1.0f);
    passiv.roughness = 0.03f;
    passiv.specularF0 = 0.05f;
    passiv.coverageMask = 0.45f;
    s.addLayer(passiv);

    return s;
}

sub::LayeredMaterialStack buildGlazingStack(const Vec3& baseColor = Vec3(0.08f, 0.12f, 0.18f)) {
    sub::LayeredMaterialStack s;
    s.name = "ArchitecturalGlazing_Substrate";

    sub::PhysicalLayer glass;
    glass.name = "Solar Low-E Pyrolytic Glass";
    glass.baseColor = baseColor;
    glass.roughness = 0.04f;
    glass.metallic = 0.04f;
    glass.ior = 1.52f;
    glass.thicknessMm = 6.0f;
    glass.absorptionCoeff = Vec3(0.02f, 0.01f, 0.005f);
    glass.coverageMask = 1.0f;
    s.addLayer(glass);

    return s;
}

sub::LayeredMaterialStack buildBronzeStack(const Vec3& baseColor = Vec3(0.58f, 0.42f, 0.22f)) {
    sub::LayeredMaterialStack s;
    s.name = "CastBronze_Substrate";

    sub::PhysicalLayer base;
    base.name = "Architectural Statuary Bronze";
    base.baseColor = baseColor;
    base.roughness = 0.35f;
    base.metallic = 0.88f;
    base.specularF0 = 0.75f;
    base.coverageMask = 1.0f;
    s.addLayer(base);

    sub::PhysicalLayer verde;
    verde.name = "Natural Verde Cuprous Oxide";
    verde.baseColor = Vec3(0.31f, 0.48f, 0.40f);
    verde.roughness = 0.80f;
    verde.metallic = 0.05f;
    verde.height = 0.25f;
    verde.coverageMask = 0.30f;
    s.addLayer(verde);

    return s;
}

sub::LayeredMaterialStack buildRoofStack(const Vec3& baseColor = Vec3(0.28f, 0.28f, 0.30f)) {
    sub::LayeredMaterialStack s;
    s.name = "BitumenRoof_Substrate";

    sub::PhysicalLayer base;
    base.name = "Bitumen Tar Membrane";
    base.baseColor = baseColor;
    base.roughness = 0.88f;
    base.metallic = 0.01f;
    base.coverageMask = 1.0f;
    s.addLayer(base);

    sub::PhysicalLayer gravel;
    gravel.name = "Washed Ballast Gravel";
    gravel.baseColor = Vec3(0.48f, 0.46f, 0.44f);
    gravel.roughness = 0.95f;
    gravel.coverageMask = 0.80f;
    s.addLayer(gravel);

    return s;
}

sub::LayeredMaterialStack buildSidewalkStack(const Vec3& baseColor = Vec3(0.72f, 0.71f, 0.69f)) {
    sub::LayeredMaterialStack s;
    s.name = "SidewalkPavement_Substrate";

    sub::PhysicalLayer base;
    base.name = "NYC Scored Concrete";
    base.baseColor = baseColor;
    base.roughness = 0.85f;
    base.metallic = 0.02f;
    base.coverageMask = 1.0f;
    s.addLayer(base);

    return s;
}

// ============================================================================
// Main Empire State Building Generator
// ============================================================================

int main(int argc, char** argv) {
    auto startTime = std::chrono::high_resolution_clock::now();

    std::cout << "============================================================" << std::endl;
    std::cout << "SCRATCHBOX NATIVE 3D ENGINE: NEXT-GEN EMPIRE STATE BUILDING" << std::endl;
    std::cout << "  - Architectural DNA Abstraction from Google 3D Tile GLB" << std::endl;
    std::cout << "  - Nanite Micro-Poly Continuous LOD & Displacement" << std::endl;
    std::cout << "  - Lumen Dynamic Multi-Bounce GI (3D SH Radiance Volume)" << std::endl;
    std::cout << "  - Substrate Multi-Layer Physical BSDF & Energy Conservation" << std::endl;
    std::cout << "============================================================" << std::endl;

    TileRegionAnchor anchor{
        .latDeg = 40.7484405,
        .lngDeg = -73.9856644,
        .altitudeMeters = 15.0,
        .landmarkName = "EmpireStateBuilding",
        .groundRadiusMeters = 200.0f,
        .clayPreset = ClayPreset::ARCHITECTURAL_WHITE
    };

    // ------------------------------------------------------------------------
    // 0. Extract Deep Architectural DNA Directly from Raw Tile Mesh
    // ------------------------------------------------------------------------
    std::string rawTilePath = "scripts/models/empire_state_building_raw_tile.glb";
    std::cout << "\n[ARCHITECTURAL DNA ABSTRACTION]" << std::endl;
    std::cout << "Parsing raw photogrammetry GLB: " << rawTilePath << "..." << std::endl;
    auto dna = abs_tile::TileBuildingAbstractor::abstractFromGlb(rawTilePath, "Empire State Building");
    dna.printSummary();

    // ------------------------------------------------------------------------
    // 1. Initialize 8 Architectural Sub-Meshes & Substrate Biophysical Materials
    // ------------------------------------------------------------------------
    // Sub-Mesh 0: Indiana Limestone Facade (Podium, Setbacks, Tower Shaft, Crown)
    ScratchboxMesh meshLimestone("EmpireState_Limestone");
    meshLimestone.material = buildLimestoneStack(dna.primaryMasonry.baseAlbedo).toPbrMaterial();
    const float uvScaleLimestoneU = 1.0f / 2.4f; // 2.4m x 1.2m ashlar block module
    const float uvScaleLimestoneV = 1.0f / 1.2f;

    // Sub-Mesh 1: Honed Charcoal Granite Plinth (Water table & street base 0.0m - 7.0m)
    ScratchboxMesh meshGranite("EmpireState_CharcoalGranite");
    meshGranite.material = buildGraniteStack(dna.plinthGranite.baseAlbedo).toPbrMaterial();
    const float uvScaleGraniteU = 1.0f / 1.8f; // 1.8m x 0.9m rusticated course
    const float uvScaleGraniteV = 1.0f / 0.9f;

    // Sub-Mesh 2: Cast Aluminum Spandrels (Stepped Art Deco chevrons below windows)
    ScratchboxMesh meshSpandrel("EmpireState_CastAluminumSpandrels");
    meshSpandrel.material = buildSpandrelStack(dna.spandrelMetal.baseAlbedo).toPbrMaterial();
    const float uvScaleSpandrelU = 1.0f / 2.0f; // 2.0m x 1.2m chevron spandrel panel
    const float uvScaleSpandrelV = 1.0f / 1.2f;

    // Sub-Mesh 3: Allegheny 18-8 Stainless Steel (Fluted pilasters, Spire, Mooring Mast)
    ScratchboxMesh meshSteel("EmpireState_StainlessSteel");
    meshSteel.material = buildSteelStack(dna.mooringMast.baseAlbedo).toPbrMaterial();
    const float uvScaleSteelU = 1.0f / 0.30f; // 0.30m vertical fluting repeat
    const float uvScaleSteelV = 1.0f / 4.00f;

    // Sub-Mesh 4: Tinted Architectural Glazing (Recessed double-hung windows)
    ScratchboxMesh meshGlazing("EmpireState_ArchitecturalGlazing");
    meshGlazing.material = buildGlazingStack(dna.windowGlazing.baseAlbedo).toPbrMaterial();
    meshGlazing.material.emissiveFactor = Vec3(0.40f, 0.32f, 0.18f); // Warm 3000K interior glow
    meshGlazing.material.emissiveStrength = 2.0f;
    const float uvScaleGlassU = 1.0f / 2.0f; // 2.0m x 3.5m window module
    const float uvScaleGlassV = 1.0f / 3.5f;

    // Sub-Mesh 5: Art Deco Statuary Cast Bronze (Grand 5th Ave entrance marquee)
    ScratchboxMesh meshBronze("EmpireState_CastBronze");
    meshBronze.material = buildBronzeStack().toPbrMaterial();
    const float uvScaleBronzeU = 1.0f / 1.5f; // 1.5m x 1.5m bronze panel
    const float uvScaleBronzeV = 1.0f / 1.5f;

    // Sub-Mesh 6: Bitumen Gravel Ballast Roof (Podium & setback terraces)
    ScratchboxMesh meshRoof("EmpireState_RoofTerrace");
    meshRoof.material = buildRoofStack(dna.terraceBitumen.baseAlbedo).toPbrMaterial();
    const float uvScaleRoofU = 1.0f / 2.0f; // 2.0m x 2.0m aggregate ballast
    const float uvScaleRoofV = 1.0f / 2.0f;

    // Sub-Mesh 7: NYC Scored Sidewalk Pavement (Street grid & observation deck)
    ScratchboxMesh meshSidewalk("EmpireState_SidewalkStreetscape");
    meshSidewalk.material = buildSidewalkStack(dna.streetSidewalk.baseAlbedo).toPbrMaterial();
    const float uvScaleSidewalkU = 1.0f / 1.5f; // 1.5m x 1.5m concrete sidewalk slabs
    const float uvScaleSidewalkV = 1.0f / 1.5f;

    // ------------------------------------------------------------------------
    // SECTION A-F: Extract Majority of 3D Shape Directly from Real-World Tile Mesh
    // ------------------------------------------------------------------------
    std::string tileMeshPath = "scripts/models/empire_state_building_cleaned_tile.glb";
    std::cout << "\n[EXTRACTING 3D BUILDING SHAPE DIRECTLY FROM TILE MESH]" << std::endl;
    std::cout << "Preserving 100% of real-world photogrammetry shape & setback geometry..." << std::endl;
    auto extractedShape = abs_tile::TileShapeExtractor::extractBuildingShape(tileMeshPath, dna, true);

    meshGranite = std::move(extractedShape.granitePlinth);
    meshLimestone = std::move(extractedShape.limestoneFacade);
    meshGlazing = std::move(extractedShape.windowGlazing);
    meshSpandrel = std::move(extractedShape.spandrelMetal);
    meshRoof = std::move(extractedShape.terraceRoofs);
    meshSteel = std::move(extractedShape.mooringMast);
    meshBronze = std::move(extractedShape.castBronzePortals);
    meshSidewalk = std::move(extractedShape.sidewalkStreet);

    // Merge stainless spire into steel submesh
    meshSteel.append(extractedShape.stainlessSpire);

    // Re-bind calibrated Substrate Biophysical PBR Material Stacks to Extracted Sub-Meshes
    meshGranite.name = "EmpireState_CharcoalGranite";
    meshGranite.material = buildGraniteStack(dna.plinthGranite.baseAlbedo).toPbrMaterial();

    meshLimestone.name = "EmpireState_Limestone";
    meshLimestone.material = buildLimestoneStack(dna.primaryMasonry.baseAlbedo).toPbrMaterial();

    meshGlazing.name = "EmpireState_ArchitecturalGlazing";
    meshGlazing.material = buildGlazingStack(dna.windowGlazing.baseAlbedo).toPbrMaterial();
    meshGlazing.material.emissiveFactor = Vec3(0.40f, 0.32f, 0.18f); // Warm 3000K interior glow
    meshGlazing.material.emissiveStrength = 2.0f;

    meshSpandrel.name = "EmpireState_CastAluminumSpandrels";
    meshSpandrel.material = buildSpandrelStack(dna.spandrelMetal.baseAlbedo).toPbrMaterial();

    meshRoof.name = "EmpireState_RoofTerrace";
    meshRoof.material = buildRoofStack(dna.terraceBitumen.baseAlbedo).toPbrMaterial();

    meshSteel.name = "EmpireState_StainlessSteel";
    meshSteel.material = buildSteelStack(dna.mooringMast.baseAlbedo).toPbrMaterial();

    meshBronze.name = "EmpireState_CastBronze";
    meshBronze.material = buildBronzeStack().toPbrMaterial();

    meshSidewalk.name = "EmpireState_SidewalkStreetscape";
    meshSidewalk.material = buildSidewalkStack(dna.streetSidewalk.baseAlbedo).toPbrMaterial();


    // Assemble the 8 Sub-Meshes
    std::vector<ScratchboxMesh> subMeshes = {
        std::move(meshLimestone),
        std::move(meshGranite),
        std::move(meshSpandrel),
        std::move(meshSteel),
        std::move(meshGlazing),
        std::move(meshBronze),
        std::move(meshRoof),
        std::move(meshSidewalk)
    };

    size_t totalVerts = 0;
    size_t totalIndices = 0;
    for (const auto& m : subMeshes) {
        totalVerts += m.vertices.size();
        totalIndices += m.indices.size();
    }

    std::cout << "Architectural Sub-Meshes Assembled: " << subMeshes.size() << std::endl;
    std::cout << "Total Vertices:  " << totalVerts << std::endl;
    std::cout << "Total Triangles: " << (totalIndices / 3) << std::endl;

    // ------------------------------------------------------------------------
    // 2. Nanite Cluster DAG & Micro-Poly Continuous LOD
    // ------------------------------------------------------------------------
    std::cout << "\n[1/3] Building Nanite Cluster DAGs & Sub-Pixel Screen Error Metric..." << std::endl;
    std::vector<nnt::NaniteClusterDAG> clusterDags(subMeshes.size());
    size_t totalNaniteClusters = 0;
    for (size_t i = 0; i < subMeshes.size(); ++i) {
        clusterDags[i].buildFromMesh(subMeshes[i], 128);
        totalNaniteClusters += clusterDags[i].clusters.size();
        std::cout << "  ✓ Nanite Cluster DAG [" << subMeshes[i].name << "]: " 
                  << clusterDags[i].clusters.size() << " clusters, "
                  << clusterDags[i].maxLodLevel << " LOD levels (" 
                  << (subMeshes[i].indices.size() / 3) << " tris)\n";
    }
    std::cout << "  -> Total Nanite Clusters Partitioned: " << totalNaniteClusters << " (Target: <= 1.0 px/tri continuous LOD)\n";

    // ------------------------------------------------------------------------
    // 3. Ephemeris Lighting Rig & Lumen Dynamic Multi-Bounce GI
    // ------------------------------------------------------------------------
    auto lights = TileIngestor::createGeospatialLighting(anchor.latDeg, anchor.lngDeg, 14.5f);
    std::cout << "\n[2/3] Simulating Lumen Dynamic Multi-Bounce GI (3D Radiance Probe Volume)..." << std::endl;
    std::cout << "  ✓ Calibrated Geospatial Solar Ephemeris Rig: " << lights.size() << " physical lights" << std::endl;

    lmn::LumenGlobalIllumination lumen;
    for (const auto& sm : subMeshes) {
        lumen.surfaceCache.appendFromMesh(sm, 8); // stride 8 for efficient card coverage
    }
    std::cout << "  ✓ Lumen Surface Cache: " << lumen.surfaceCache.cards.size() << " surface radiance cards\n";

    // Initialize 3D Radiance Probe Grid over 443.2m tower and surrounding city blocks using abstracted bounds
    lumen.initializeGrid(dna.lumenProbeVolumeMin, dna.lumenProbeVolumeMax, 25.0f);
    std::cout << "  ✓ Lumen 3D Radiance Probe Grid: " << lumen.dimX << "x" << lumen.dimY << "x" << lumen.dimZ 
              << " (" << lumen.probes.size() << " probes, 27 floats/probe L2 SH)\n";

    Vec3 sunDirection = dna.estimatedSunDirection;
    Vec3 sunColor = lights.empty() ? Vec3(1.0f, 0.95f, 0.85f) : lights[0].color;
    Vec3 skyAmbient(0.18f, 0.26f, 0.38f);
    lumen.updateDirectLighting(sunDirection, sunColor, skyAmbient);
    std::cout << "  ✓ Direct Lighting Pass completed with abstracted solar azimuth/zenith vector.\n";

    auto esbSdf = [](const Vec3& p) -> float {
        float ground = p.y;
        float shaft = scratchbox::sdf::sdBox(p - Vec3(0.0f, 170.0f, 0.0f), Vec3(42.0f, 150.0f, 32.0f));
        return std::min(ground, shaft);
    };

    std::cout << "  ✓ Evaluating Lumen Bounce 1 (Indirect diffuse radiosity)..." << std::flush;
    lumen.evaluateBouncePass(esbSdf);
    std::cout << " Done.\n";

    std::cout << "  ✓ Evaluating Lumen Bounce 2 (Secondary terrace setback bounce)..." << std::flush;
    lumen.evaluateBouncePass(esbSdf);
    std::cout << " Done.\n";

    // Sample probe volume for each vertex in subMeshes
    for (auto& sm : subMeshes) {
        for (auto& v : sm.vertices) {
            Vec3 bounce = lumen.sampleProbeVolume(v.position, v.normal);
            v.color.x = std::clamp(v.color.x * (0.85f + bounce.x * 1.5f), 0.0f, 1.0f);
            v.color.y = std::clamp(v.color.y * (0.85f + bounce.y * 1.5f), 0.0f, 1.0f);
            v.color.z = std::clamp(v.color.z * (0.85f + bounce.z * 1.5f), 0.0f, 1.0f);
        }
    }
    std::cout << "  ✓ Injected Lumen Multi-Bounce Radiosity into Vertex Streams of all 8 Sub-Meshes!\n";

    // ------------------------------------------------------------------------
    // 4. Synthesize 2048x2048 Biophysical PBR Texture Sets (Plaza Hotel Standard)
    // ------------------------------------------------------------------------
    std::cout << "\n[3/3] Synthesizing 2048x2048 Biophysical PBR Texture Sets..." << std::endl;
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
        {7, "SidewalkPavement", PbrMaterialArchetype::SCORED_SIDEWALK_PAVEMENT, 808}
    };

    const int TEX_RES = 2048;

    for (const auto& def : materialDefs) {
        std::cout << "  - Generating [" << def.name << "] 2K PBR maps (Albedo, Normal, ORM)..." << std::flush;
        auto pbrSet = generatePbrMaterial(def.archetype, TEX_RES, TEX_RES, def.seed);

        // Albedo PNG
        EmbeddedTexture texAlbedo;
        texAlbedo.name = def.name + "_BaseColor";
        texAlbedo.mimeType = "image/png";
        texAlbedo.data = encodePng(pbrSet.albedo);
        texAlbedo.usage = TextureUsage::BASE_COLOR;
        texAlbedo.materialIndex = def.matIndex;
        embeddedTextures.push_back(std::move(texAlbedo));

        // Normal PNG
        EmbeddedTexture texNormal;
        texNormal.name = def.name + "_Normal";
        texNormal.mimeType = "image/png";
        texNormal.data = encodePng(pbrSet.normal);
        texNormal.usage = TextureUsage::NORMAL;
        texNormal.materialIndex = def.matIndex;
        embeddedTextures.push_back(std::move(texNormal));

        // ORM PNG (Cavity AO in Red, Roughness in Green, Metallic in Blue)
        EmbeddedTexture texOrm;
        texOrm.name = def.name + "_ORM";
        texOrm.mimeType = "image/png";
        texOrm.data = encodePng(pbrSet.orm);
        texOrm.usage = TextureUsage::ORM;
        texOrm.materialIndex = def.matIndex;
        embeddedTextures.push_back(std::move(texOrm));

        std::cout << " Done." << std::endl;
    }

    // Window Interior Emissive Map for Architectural Glazing (Material 4)
    {
        std::cout << "  - Generating [ArchitecturalGlazing] 2K Calibrated Emissive Window Map..." << std::flush;
        ImageBuffer emissiveImg(TEX_RES, TEX_RES, 3);
        const int cellW = TEX_RES / 8; // 256
        const int cellH = TEX_RES / 4; // 512

        for (int y = 0; y < TEX_RES; ++y) {
            float v = static_cast<float>(y) / static_cast<float>(TEX_RES);
            int cellY = y / cellH;
            for (int x = 0; x < TEX_RES; ++x) {
                float u = static_cast<float>(x) / static_cast<float>(TEX_RES);
                int cellX = x / cellW;

                // Double-hung window sash framing
                int mx = x % cellW;
                int my = y % cellH;
                int padX = cellW / 8;
                int padY = cellH / 16;
                int midY = cellH / 2;

                bool isPane = (mx > padX && mx < cellW - padX) && 
                              ((my > padY && my < midY - 6) || (my > midY + 6 && my < cellH - padY));

                // Natural ~18% office window occupancy scattering
                uint32_t cellHash = (static_cast<uint32_t>(cellX) * 73856093u) ^ (static_cast<uint32_t>(cellY) * 19349663u) ^ 9091u;
                bool isOccupied = ((cellHash % 100) < 18);

                if (isPane && isOccupied) {
                    float venetian = 0.80f + 0.20f * std::sin(v * 256.0f * 3.14159f);
                    float warmR = 0.75f * venetian;
                    float warmG = 0.58f * venetian;
                    float warmB = 0.35f * venetian;
                    emissiveImg.setPixelRGB(x, y, Vec3(warmR, warmG, warmB));
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
        std::cout << " Done." << std::endl;
    }

    std::cout << "Total Embedded PBR Textures: " << embeddedTextures.size() << std::endl;

    // ------------------------------------------------------------------------
    // 5. Export Multi-Mesh Binary glTF 2.0 (.glb) with PBR Next Extensions
    // ------------------------------------------------------------------------
    std::string outputPath = "scripts/models/empire_state_building_pbr_textured.glb";
    if (argc > 1) {
        outputPath = argv[1];
    }

    std::cout << "Writing glTF 2.0 Binary container to: " << outputPath << "..." << std::endl;
    bool success = GlbWriter::writeMultiMeshToFile(subMeshes, outputPath, embeddedTextures, lights);
    if (!success) {
        std::cerr << "ERROR: Failed to write multi-mesh GLB to " << outputPath << std::endl;
        return 1;
    }

    // Also copy to public/models and scripts/models/empire_state_building_improved_tile.glb
    std::string publicPath = "public/models/empire_state_building_pbr_textured.glb";
    GlbWriter::writeMultiMeshToFile(subMeshes, publicPath, embeddedTextures, lights);

    std::string legacyPath = "scripts/models/empire_state_building_improved_tile.glb";
    GlbWriter::writeMultiMeshToFile(subMeshes, legacyPath, embeddedTextures, lights);

    auto endTime = std::chrono::high_resolution_clock::now();
    double elapsedMs = std::chrono::duration<double, std::milli>(endTime - startTime).count();

    std::cout << "============================================================" << std::endl;
    std::cout << "SUCCESS: Authentic PBR Textured Empire State Building Generated!" << std::endl;
    std::cout << "Elapsed Time: " << elapsedMs << " ms" << std::endl;
    std::cout << "GLB Output: " << outputPath << std::endl;
    std::cout << "Public GLB: " << publicPath << std::endl;
    std::cout << "============================================================" << std::endl;

    return 0;
}
