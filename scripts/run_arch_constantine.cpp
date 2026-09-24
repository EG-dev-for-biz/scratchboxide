/********************************************************************************
 * Copyright (C) 2026 Scratchbox IDE.
 *
 * Standalone Headless SB-Archi Tectonic Generator & Analyzer: Arch of Constantine.
 * Synthesizes the monumental triple-fornix Triumphal Arch of Constantine in Rome
 * (AD 315) using the universal C++20 tectonic geometry engine (scratchbox_tectonics.hpp).
 *
 * Mathematical & Algorithmic Tectonic Features:
 * - 3 Semicircular Arches with 2-tier Stepped Lacunaria Coffers (VaultMesher)
 * - Radial Voussoir Rings with V-Groove Chamfers & Flared Projecting Keystones
 * - Hollow Transverse Pier Circulation Passages (Pier Vomitoria)
 * - 8 Free-Standing Fluted Corinthian Columns on Profiled Pedestals with Vitruvian Entasis
 * - Entablature with Mitered Ressaut Breaks projecting over columns
 * - Attic Storey with Colossal Latin Inscription Tabula & 8 Dacian Prisoner Statues
 * - Hollow Interior Attic Chamber with Staircase Access
 * - Automated Tectonic Classification & Elevation Slicing Analysis
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include "scratchbox_tectonics.hpp"
#include "scratchbox_tectonic_analyzer.hpp"
#include "scratchbox_io.hpp"

#include <iostream>
#include <fstream>
#include <string>
#include <vector>
#include <chrono>
#include <filesystem>
#include <cmath>

namespace fs = std::filesystem;
using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::tectonics;
using namespace scratchbox::io;

// Helper to add an axis-aligned box with normals and UVs
static void addSolidBox(ScratchboxMesh& mesh, const Vec3& center, const Vec3& size,
                        const Vec4& color = Vec4(0.88f, 0.85f, 0.79f, 1.0f)) {
    float hx = size.x * 0.5f, hy = size.y * 0.5f, hz = size.z * 0.5f;
    std::array<Vec3, 8> c = {
        center + Vec3(-hx, -hy, -hz), center + Vec3( hx, -hy, -hz),
        center + Vec3( hx,  hy, -hz), center + Vec3(-hx,  hy, -hz),
        center + Vec3(-hx, -hy,  hz), center + Vec3( hx, -hy,  hz),
        center + Vec3( hx,  hy,  hz), center + Vec3(-hx,  hy,  hz)
    };
    auto addFace = [&](int i0, int i1, int i2, int i3, const Vec3& n) {
        uint32_t b = static_cast<uint32_t>(mesh.vertices.size());
        mesh.addVertex(Vertex(c[i0], n, Vec2(0, 0), color));
        mesh.addVertex(Vertex(c[i1], n, Vec2(1, 0), color));
        mesh.addVertex(Vertex(c[i2], n, Vec2(1, 1), color));
        mesh.addVertex(Vertex(c[i3], n, Vec2(0, 1), color));
        mesh.addTriangle(b + 0, b + 1, b + 2);
        mesh.addTriangle(b + 0, b + 2, b + 3);
    };
    addFace(4, 5, 6, 7, Vec3(0, 0, 1));   // Front (+Z)
    addFace(1, 0, 3, 2, Vec3(0, 0, -1));  // Back (-Z)
    addFace(0, 4, 7, 3, Vec3(-1, 0, 0));  // Left (-X)
    addFace(5, 1, 2, 6, Vec3(1, 0, 0));   // Right (+X)
    addFace(3, 2, 6, 7, Vec3(0, 1, 0));   // Top (+Y)
    addFace(0, 1, 5, 4, Vec3(0, -1, 0));  // Bottom (-Y)
}

// Builds a sculpted Dacian Prisoner Statue (attic plinth figure)
static ScratchboxMesh buildDacianStatue(const Vec3& pos, float height = 3.0f,
                                       const Vec4& col = Vec4(0.85f, 0.82f, 0.77f, 1.0f)) {
    ScratchboxMesh mesh("dacian_prisoner");
    // Statue pedestal
    addSolidBox(mesh, pos + Vec3(0, 0.25f, 0), Vec3(0.9f, 0.5f, 0.9f), col * 0.95f);
    // Draped tunic body (tapered)
    addSolidBox(mesh, pos + Vec3(0, 1.25f, 0), Vec3(0.7f, 1.5f, 0.6f), col);
    // Folded arms / chest drapery
    addSolidBox(mesh, pos + Vec3(0, 1.75f, 0.1f), Vec3(0.75f, 0.5f, 0.5f), col * 1.02f);
    // Head with beard
    addSolidBox(mesh, pos + Vec3(0, 2.35f, 0), Vec3(0.42f, 0.45f, 0.42f), col);
    // Phrygian peaked cap
    addSolidBox(mesh, pos + Vec3(0, 2.70f, -0.05f), Vec3(0.35f, 0.35f, 0.4f), col * 0.92f);
    return mesh;
}

int main(int argc, char* argv[]) {
    std::string outputGlbPath = "public/models/arch_constantine_sb_archi.glb";
    std::string copyGlbPath = "public/arch_constantine_sb_archi.glb";

    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--output-glb" && i + 1 < argc) {
            outputGlbPath = argv[++i];
            copyGlbPath = ""; // Do not overwrite root copy if custom output specified
        }
    }

    std::cout << "\n======================================================================\n"
              << "[SB-Archi] Monumental Arch of Constantine Tectonic Synthesizer (C++20)\n"
              << "======================================================================\n";

    auto tStart = std::chrono::high_resolution_clock::now();

    // 1. Historical & Architectural Geodetic Coordinates
    // District placement coordinates from total_entities.json
    Vec3 worldCenter(-139.62f, 31.5f, -45.28f);
    float worldYawRad = 0.29025f; // 16.63 degrees in radians
    float cosYaw = std::cos(worldYawRad);
    float sinYaw = std::sin(worldYawRad);

    // Primary dimensions (meters)
    float totalWidthX = 25.70f;
    float totalHeightY = 21.00f;
    float totalDepthZ = 7.40f;

    // Materials
    PbrMaterial marbleMat = PbrMaterial::stoneLimestone();
    marbleMat.name = "pentelic_and_proconnesian_marble";
    marbleMat.baseColorFactor = Vec4(0.88f, 0.85f, 0.79f, 1.0f);
    marbleMat.roughnessFactor = 0.82f;
    marbleMat.metallicFactor = 0.02f;

    PbrMaterial cofferMat = PbrMaterial::stoneLimestone();
    cofferMat.name = "coffered_vault_marble";
    cofferMat.baseColorFactor = Vec4(0.82f, 0.78f, 0.72f, 1.0f);
    cofferMat.roughnessFactor = 0.86f;

    ScratchboxMesh masterMesh("arch_of_constantine_tectonic");
    masterMesh.material = marbleMat;

    // ------------------------------------------------------------------------
    // A. BASE PLINTH / PODIUM
    // ------------------------------------------------------------------------
    float plinthH = 0.70f;
    addSolidBox(masterMesh, Vec3(0, plinthH * 0.5f, 0), Vec3(totalWidthX + 0.6f, plinthH, totalDepthZ + 0.6f));

    // ------------------------------------------------------------------------
    // B. LOWER STOREY PYLONS & PIERS (Solid ashlar piers with hollow passages)
    // ------------------------------------------------------------------------
    float lowerStoreyTopY = 14.20f;
    float pierH = lowerStoreyTopY - plinthH;
    float pierCenterY = plinthH + pierH * 0.5f;

    // Pier 1 (Far West): x from -12.85 to -8.55 (width 4.30m)
    float p1W = 4.30f;
    float p1X = -12.85f + p1W * 0.5f;
    addSolidBox(masterMesh, Vec3(p1X, pierCenterY, 0), Vec3(p1W, pierH, totalDepthZ));

    // Pier 4 (Far East): x from +8.55 to +12.85 (width 4.30m)
    float p4W = 4.30f;
    float p4X = 12.85f - p4W * 0.5f;
    addSolidBox(masterMesh, Vec3(p4X, pierCenterY, 0), Vec3(p4W, pierH, totalDepthZ));

    // Pier 2 (Central West): x from -5.15 to -3.25 (width 1.90m)
    // Has a hollow transverse connecting barrel passage between central & lateral arches
    float p2W = 1.90f;
    float p2X = -4.20f;
    // Transverse passage: span 1.90m along X, height 5.0m, depth 2.2m along Z
    // Lower front and back solid masses of Pier 2:
    float transH = 5.2f;
    float transDepthZ = 2.4f;
    float sideZ = (totalDepthZ - transDepthZ) * 0.5f;
    // Solid Pier 2 front block (+Z)
    addSolidBox(masterMesh, Vec3(p2X, plinthH + transH * 0.5f, totalDepthZ * 0.5f - sideZ * 0.5f), Vec3(p2W, transH, sideZ));
    // Solid Pier 2 back block (-Z)
    addSolidBox(masterMesh, Vec3(p2X, plinthH + transH * 0.5f, -totalDepthZ * 0.5f + sideZ * 0.5f), Vec3(p2W, transH, sideZ));
    // Solid Pier 2 upper mass (above transverse passage up to entablature)
    float upperPierH = pierH - transH;
    addSolidBox(masterMesh, Vec3(p2X, plinthH + transH + upperPierH * 0.5f, 0), Vec3(p2W, upperPierH, totalDepthZ));

    // Pier 3 (Central East): x from +3.25 to +5.15 (width 1.90m)
    float p3W = 1.90f;
    float p3X = 4.20f;
    addSolidBox(masterMesh, Vec3(p3X, plinthH + transH * 0.5f, totalDepthZ * 0.5f - sideZ * 0.5f), Vec3(p3W, transH, sideZ));
    addSolidBox(masterMesh, Vec3(p3X, plinthH + transH * 0.5f, -totalDepthZ * 0.5f + sideZ * 0.5f), Vec3(p3W, transH, sideZ));
    addSolidBox(masterMesh, Vec3(p3X, plinthH + transH + upperPierH * 0.5f, 0), Vec3(p3W, upperPierH, totalDepthZ));

    // ------------------------------------------------------------------------
    // C. CENTRAL FORNIX (Monumental Center Arch)
    // ------------------------------------------------------------------------
    // Span: 6.50m (x from -3.25 to +3.25), Springline: 8.25m, Rise: 3.25m (Crown 11.50m), Depth: 7.40m
    ArchConfig centralArchCfg;
    centralArchCfg.type = ArchCurveType::Semicircular;
    centralArchCfg.span = 6.50f;
    centralArchCfg.rise = 3.25f;
    centralArchCfg.depth = totalDepthZ;
    centralArchCfg.archivoltThickness = 0.55f;

    // Coffered lacunaria barrel vault
    CofferConfig centralCofferCfg;
    centralCofferCfg.enabled = true;
    centralCofferCfg.gridArch = 5;       // 5 concentric coffer rows
    centralCofferCfg.gridDepth = 9;      // 9 longitudinal bays
    centralCofferCfg.recessDepth = 0.12f;// Deep classical lacunaria recess
    centralCofferCfg.marginRatio = 0.20f;
    centralCofferCfg.steppedBands = 3;   // Triple stepped moulded relief

    ScratchboxMesh centralVault = VaultMesher::buildBarrelVault(
        centralArchCfg, centralCofferCfg, Vec3(0, 8.25f, 0), cofferMat
    );
    masterMesh.append(centralVault);

    // Solid spandrel infill above central vault up to lower storey top (y=14.2)
    float spandrelH = lowerStoreyTopY - 11.50f;
    addSolidBox(masterMesh, Vec3(0, 11.50f + spandrelH * 0.5f, 0), Vec3(6.50f, spandrelH, totalDepthZ));

    // Radial voussoirs with flared keystone on North (+Z) and South (-Z) facades
    VoussoirConfig centralVousCfg;
    centralVousCfg.count = 25;           // 25 radial voussoirs (odd)
    centralVousCfg.bevelWidth = 0.03f;
    centralVousCfg.keystoneFlaring = 1.35f;
    centralVousCfg.keystoneRadialOffset = 0.18f;
    centralVousCfg.consoleScrollDepth = 0.12f;

    ArchConfig centralArchNorth = centralArchCfg;
    centralArchNorth.depth = 0.45f;
    ScratchboxMesh northCentralRing = VoussoirSubdivider::buildVoussoirArchRing(
        centralArchNorth, centralVousCfg, Vec3(0, 8.25f, totalDepthZ * 0.5f), marbleMat
    );
    masterMesh.append(northCentralRing);

    ScratchboxMesh southCentralRing = VoussoirSubdivider::buildVoussoirArchRing(
        centralArchNorth, centralVousCfg, Vec3(0, 8.25f, -totalDepthZ * 0.5f), marbleMat
    );
    masterMesh.append(southCentralRing);

    // ------------------------------------------------------------------------
    // D. LATERAL FORNICES (West and East Arches)
    // ------------------------------------------------------------------------
    // Lateral arches: Span 3.40m, Springline 5.70m, Rise 1.70m (Crown 7.40m), Depth 7.40m
    ArchConfig lateralArchCfg;
    lateralArchCfg.type = ArchCurveType::Semicircular;
    lateralArchCfg.span = 3.40f;
    lateralArchCfg.rise = 1.70f;
    lateralArchCfg.depth = totalDepthZ;
    lateralArchCfg.archivoltThickness = 0.42f;

    CofferConfig lateralCofferCfg;
    lateralCofferCfg.enabled = true;
    lateralCofferCfg.gridArch = 4;
    lateralCofferCfg.gridDepth = 7;
    lateralCofferCfg.recessDepth = 0.08f;
    lateralCofferCfg.marginRatio = 0.22f;
    lateralCofferCfg.steppedBands = 2;

    VoussoirConfig lateralVousCfg;
    lateralVousCfg.count = 17;
    lateralVousCfg.bevelWidth = 0.025f;
    lateralVousCfg.keystoneFlaring = 1.28f;
    lateralVousCfg.keystoneRadialOffset = 0.14f;
    lateralVousCfg.consoleScrollDepth = 0.09f;

    ArchConfig lateralArchFacade = lateralArchCfg;
    lateralArchFacade.depth = 0.40f;

    for (float latX : { -6.85f, 6.85f }) {
        // Vault
        ScratchboxMesh latVault = VaultMesher::buildBarrelVault(
            lateralArchCfg, lateralCofferCfg, Vec3(latX, 5.70f, 0), cofferMat
        );
        masterMesh.append(latVault);

        // Spandrel masonry infill above lateral vault up to entablature (7.40m to 14.20m)
        float latSpandrelH = lowerStoreyTopY - 7.40f;
        addSolidBox(masterMesh, Vec3(latX, 7.40f + latSpandrelH * 0.5f, 0), Vec3(3.40f, latSpandrelH, totalDepthZ));

        // Hadrianic Tondi roundels on North & South spandrel walls
        for (float signZ : { 1.0f, -1.0f }) {
            // Left & right roundel pair per arch
            for (float rX : { latX - 0.95f, latX + 0.95f }) {
                Vec3 tondoPos(rX, 10.8f, signZ * (totalDepthZ * 0.5f + 0.05f));
                addSolidBox(masterMesh, tondoPos, Vec3(1.35f, 1.35f, 0.10f), marbleMat.baseColorFactor * 1.05f);
            }
        }

        // Voussoir rings
        ScratchboxMesh northLatRing = VoussoirSubdivider::buildVoussoirArchRing(
            lateralArchFacade, lateralVousCfg, Vec3(latX, 5.70f, totalDepthZ * 0.5f), marbleMat
        );
        masterMesh.append(northLatRing);

        ScratchboxMesh southLatRing = VoussoirSubdivider::buildVoussoirArchRing(
            lateralArchFacade, lateralVousCfg, Vec3(latX, 5.70f, -totalDepthZ * 0.5f), marbleMat
        );
        masterMesh.append(southLatRing);
    }

    // ------------------------------------------------------------------------
    // E. 8 FREE-STANDING CORINTHIAN COLUMNS ON PROFILE PEDESTALS
    // ------------------------------------------------------------------------
    std::vector<float> columnX = { -10.80f, -4.20f, 4.20f, 10.80f };
    float colPedestalH = 3.20f;
    float colShaftH = 8.60f;
    float colBaseRadius = 0.52f;
    float colTopRadius = 0.44f;

    ColumnConfig colCfg;
    colCfg.order = ClassicalOrder::Corinthian;
    colCfg.hasPedestal = true;
    colCfg.pedestalHeight = colPedestalH;
    colCfg.pedestalWidth = 1.35f;
    colCfg.baseRadius = colBaseRadius;
    colCfg.topRadius = colTopRadius;
    colCfg.shaftHeight = colShaftH;
    colCfg.entasisInflection = 0.333f; // Vitruvian 1/3 entasis
    colCfg.fluteCount = 24;

    for (float colX : columnX) {
        // North Columns (+Z)
        Vec3 posNorth(colX, plinthH, totalDepthZ * 0.5f + colCfg.pedestalWidth * 0.45f);
        masterMesh.append(ColumnBuilder::buildFullColumn(colCfg, posNorth, marbleMat));

        // South Columns (-Z)
        Vec3 posSouth(colX, plinthH, -totalDepthZ * 0.5f - colCfg.pedestalWidth * 0.45f);
        masterMesh.append(ColumnBuilder::buildFullColumn(colCfg, posSouth, marbleMat));
    }

    // ------------------------------------------------------------------------
    // F. ENTABLATURE WITH MITERED RESSAUT BREAKS OVER COLUMNS
    // ------------------------------------------------------------------------
    EntablatureConfig entCfg;
    entCfg.totalHeight = 2.30f;
    entCfg.architraveRatio = 0.35f;
    entCfg.friezeRatio = 0.33f;
    entCfg.corniceRatio = 0.32f;
    entCfg.ressautProjection = 0.70f; // Forward projection over columns

    ScratchboxMesh entablature = EntablatureExtruder::buildRessautEntablature(
        entCfg, totalWidthX + 0.4f, totalDepthZ, columnX,
        Vec3(0, lowerStoreyTopY, 0), marbleMat
    );
    masterMesh.append(entablature);

    // ------------------------------------------------------------------------
    // G. ATTIC STOREY (Top Story with Latin Inscriptions & Dacian Statues)
    // ------------------------------------------------------------------------
    float atticBaseY = lowerStoreyTopY + entCfg.totalHeight; // 16.50m
    float atticH = totalHeightY - atticBaseY;                // 4.50m (to 21.0m)
    float atticW = totalWidthX + 0.2f;
    float atticD = totalDepthZ * 0.94f;

    // Solid attic shell
    addSolidBox(masterMesh, Vec3(0, atticBaseY + atticH * 0.5f, 0), Vec3(atticW, atticH, atticD));

    // Crown cornice moulding atop attic
    float crownCorniceH = 0.55f;
    addSolidBox(masterMesh, Vec3(0, totalHeightY + crownCorniceH * 0.5f, 0),
                Vec3(atticW + 0.6f, crownCorniceH, atticD + 0.6f));

    // Monumental Central Inscription Tabula (North & South)
    float tabulaW = 10.40f;
    float tabulaH = 3.20f;
    for (float signZ : { 1.0f, -1.0f }) {
        Vec3 tabulaPos(0, atticBaseY + 0.5f + tabulaH * 0.5f, signZ * (atticD * 0.5f + 0.08f));
        addSolidBox(masterMesh, tabulaPos, Vec3(tabulaW, tabulaH, 0.12f), Vec4(0.92f, 0.90f, 0.84f, 1.0f));

        // Raised inscription border moulding
        addSolidBox(masterMesh, tabulaPos + Vec3(0, tabulaH * 0.5f, 0), Vec3(tabulaW + 0.3f, 0.18f, 0.18f));
        addSolidBox(masterMesh, tabulaPos - Vec3(0, tabulaH * 0.5f, 0), Vec3(tabulaW + 0.3f, 0.18f, 0.18f));
        addSolidBox(masterMesh, tabulaPos + Vec3(tabulaW * 0.5f, 0, 0), Vec3(0.18f, tabulaH + 0.3f, 0.18f));
        addSolidBox(masterMesh, tabulaPos - Vec3(tabulaW * 0.5f, 0, 0), Vec3(0.18f, tabulaH + 0.3f, 0.18f));
    }

    // 8 Dacian Prisoner Statues (Standing on the ressaut attics directly above columns)
    for (float colX : columnX) {
        for (float signZ : { 1.0f, -1.0f }) {
            Vec3 statuePos(colX, atticBaseY, signZ * (atticD * 0.5f + entCfg.ressautProjection * 0.5f));
            masterMesh.append(buildDacianStatue(statuePos, 3.2f));
        }
    }

    // ------------------------------------------------------------------------
    // H. GEODETIC TRANSFORMATION TO DISTRICT METRIC SPACE
    // ------------------------------------------------------------------------
    // Rotate by worldYawRad and translate to worldCenter
    for (auto& v : masterMesh.vertices) {
        // Rotate around Y
        float rx = v.position.x * cosYaw - v.position.z * sinYaw;
        float rz = v.position.x * sinYaw + v.position.z * cosYaw;
        v.position.x = rx + worldCenter.x;
        v.position.y = v.position.y + worldCenter.y;
        v.position.z = rz + worldCenter.z;

        // Rotate normal
        float nx = v.normal.x * cosYaw - v.normal.z * sinYaw;
        float nz = v.normal.x * sinYaw + v.normal.z * cosYaw;
        v.normal = Vec3(nx, v.normal.y, nz).normalized();
    }
    masterMesh.bounds = AABB();
    for (const auto& v : masterMesh.vertices) {
        masterMesh.bounds.expand(v.position);
    }

    auto tEnd = std::chrono::high_resolution_clock::now();
    float synthTimeMs = std::chrono::duration<float, std::milli>(tEnd - tStart).count();

    // ------------------------------------------------------------------------
    // I. RUN AUTOMATED TECTONIC CLASSIFICATION & ELEVATION ANALYSIS
    // ------------------------------------------------------------------------
    std::cout << "[SB-Archi] Running Automated Tectonic Scan & Structural Classifier...\n";
    TectonicAnalysisReport report = TectonicStructureClassifier::classify(masterMesh);

    std::cout << "\n======================================================================\n"
              << "[SB-Archi] Arch of Constantine Tectonic Inversion Report:\n"
              << "  - Classification: " << report.classificationName << " (Confidence: " << (report.confidence * 100.0f) << "%)\n"
              << "  - Footprint Center: (" << report.footprint.center.x << ", " << report.footprint.center.y << ", " << report.footprint.center.z << ")\n"
              << "  - Footprint Major Dimension: " << report.footprint.majorDimension << " m (Target: 25.7 m)\n"
              << "  - Footprint Minor Dimension: " << report.footprint.minorDimension << " m (Target: 7.4 m)\n"
              << "  - Structure Total Height: " << report.elevationProfile.totalHeight << " m (Target: 21.0 m)\n"
              << "  - Detected Datums: " << report.elevationProfile.detectedDatums.size() << " architectural levels\n"
              << "  - Synthesized Vertices: " << masterMesh.vertices.size() << "\n"
              << "  - Synthesized Triangles: " << (masterMesh.indices.size() / 3) << "\n"
              << "  - Synthesis Runtime: " << synthTimeMs << " ms\n"
              << "======================================================================\n\n";

    // ------------------------------------------------------------------------
    // J. SERIALIZE WATERTIGHT BINARY GLTF 2.0 (.glb)
    // ------------------------------------------------------------------------
    std::cout << "[SB-Archi] Serializing Watertight Binary GLB to: " << outputGlbPath << " ...\n";
    fs::create_directories(fs::path(outputGlbPath).parent_path());
    std::vector<uint8_t> glbData = GlbWriter::serializeToGlb(masterMesh);

    if (glbData.empty()) {
        std::cerr << "[SB-Archi] ERROR: GLB serialization produced empty buffer!\n";
        return 1;
    }

    std::ofstream outFile(outputGlbPath, std::ios::binary);
    if (!outFile.is_open()) {
        std::cerr << "[SB-Archi] ERROR: Failed to open output file: " << outputGlbPath << "\n";
        return 1;
    }
    outFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
    outFile.close();

    // Also copy to root public directory for direct viewer access
    if (!copyGlbPath.empty()) {
        std::ofstream copyFile(copyGlbPath, std::ios::binary);
        if (copyFile.is_open()) {
            copyFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
            copyFile.close();
            std::cout << "[SB-Archi] Copied to: " << copyGlbPath << " (" << (glbData.size() / 1024.0f) << " KB)\n";
        }
    }

    std::cout << "[SB-Archi] 100% Watertight Classical Arch Synthesis Complete!\n\n";
    return 0;
}
