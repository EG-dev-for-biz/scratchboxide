/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Adaptive High-Rise Architectural Procedural Synthesizer (V3 Master)
 * Formulates high-rise skyscraper massing via the 4 Universal Geometric Operators:
 * 1. SE(3) Lie Group Carrier Curves & Sweeps
 * 2. Harmonic Solids of Revolution (Octagonal Mooring Mast, Dome Cap, Spire)
 * 3. Affine Metric Replicators (Piers, Window Bays, Promenade Railings, Antenna Tiers)
 * 4. Isoparametric Normal Relief Fields (Rustication, Spandrel Recesses)
 *
 * Compliant with ADA (Adaptive Domain Architecture):
 * - Zero hardcoded closed taxonomies
 * - Continuous physical parameter schemas (AdaptiveHighRiseParams)
 * - Ephemerally compiled via Apple Clang C++20
 * - Generates both 18% Studio Grey Clay (Stage 2) and Multi-Slot PBR (Stage 3)
 * - Rectifies street alignment to authentic Google 3D Tiles Manhattan street grid:
 *     5th Ave curb: X = +72.0m, 6th Ave curb: X = -80.0m (152m block width)
 *     34th St curb: Z = -43.0m, 33rd St curb: Z = +47.0m (90m block depth)
 *     Parcel Center: (-4.0m, +2.0m), Tower Shaft Center: (0.0m, 0.0m)
 * - High-Level Facade Architectural Sophistication:
 *     Compound 3-tier stepped limestone piers with Art Deco pyramidal finials
 *     Recessed cast metal spandrels with 3D horizontal reeded fluting
 *     Continuous polished stainless steel mullion fins with chevron caps
 *     Dielectric solar glazing with bronze sash rails and office interior depth
 ********************************************************************************/

#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_pbr_manifold.hpp"

#include <iostream>
#include <vector>
#include <cmath>
#include <string>
#include <chrono>
#include <algorithm>
#include <fstream>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::pbr_manifold;
using namespace scratchbox::texture;
using namespace scratchbox::io;
using namespace scratchbox::gltf;

namespace {

// ============================================================================
// CONTINUOUS ARCHITECTURAL PARAMETERS (ADA COMPLIANT)
// ============================================================================

struct SetbackTier {
    float yMin;
    float yMax;
    float halfX;
    float halfZ;
    float cornerInset;       // Re-entrant corner notch dimension (e.g. 3.2m for Art Deco tower)
    float centralBayDepth;   // Projecting central bay along Z
    float pierSpacing;
    float pierDepth;
    bool hasRoofTerrace;
    bool hasMechanicalPenthouses;
};

struct AdaptiveHighRiseParams {
    // 1. Surrounding Midtown Manhattan Block Geometry (Calibrated to WGS-84 / Google 3D Tiles)
    float curbEast  =  72.0f;   // 5th Avenue curb line
    float curbWest  = -80.0f;   // 6th Avenue curb line
    float curbNorth = -43.0f;   // 34th Street curb line
    float curbSouth =  47.0f;   // 33rd Street curb line

    // Podium Base Footprint (leaving 2.5m sidewalk to curbs)
    float podEast   =  69.5f;
    float podWest   = -77.5f;
    float podNorth  = -40.5f;
    float podSouth  =  44.5f;
    float podiumHeight = 24.0f; // Floors 1-5 podium

    // 2. Stepped Setback Hierarchy (Centered at Tower Shaft: X=0, Z=0)
    std::vector<SetbackTier> tiers = {
        // Tier 1: Floors 6-20 (Y = 24.0m to 68.0m)
        { 24.0f,  68.0f, 44.0f, 27.0f, 0.0f, 0.0f, 3.6f, 0.50f, true,  true  },
        // Tier 2: Floors 21-24 (Y = 68.0m to 82.0m)
        { 68.0f,  82.0f, 39.0f, 24.0f, 0.0f, 0.0f, 3.6f, 0.50f, true,  false },
        // Tier 3: Floors 25-29 (Y = 82.0m to 96.0m)
        { 82.0f,  96.0f, 35.0f, 21.5f, 0.0f, 0.0f, 3.6f, 0.50f, true,  true  },
        // Tier 4: Floors 30-71 Main Tower Shaft (Y = 96.0m to 258.0m) - Art Deco Corner Insets!
        { 96.0f, 258.0f, 30.0f, 19.0f, 3.2f, 0.6f, 3.6f, 0.55f, true,  false },
        // Tier 5: Floors 72-80 High Tower (Y = 258.0m to 294.0m)
        { 258.0f, 294.0f, 26.5f, 17.0f, 2.5f, 0.4f, 3.6f, 0.50f, true,  false },
        // Tier 6: Floors 81-85 Crown Transition (Y = 294.0m to 320.0m)
        { 294.0f, 320.0f, 23.0f, 15.0f, 1.8f, 0.0f, 3.6f, 0.50f, true,  false }
    };

    // 3. 86th Floor Open-Air Observation Promenade
    float promenadeDeckY = 320.0f;
    float promenadeHalfX = 23.0f;
    float promenadeHalfZ = 15.0f;
    float promenadeRailingHeight = 1.35f;

    // 4. 86th Floor Enclosed Observation Pavilion
    float pavilionYMin = 320.0f;
    float pavilionYMax = 328.0f;
    float pavilionHalfX = 15.0f;
    float pavilionHalfZ = 9.5f;
    float pavilionWindowYMin = 321.2f;
    float pavilionWindowYMax = 326.5f;

    // 5. Stepped Octagonal Mooring Mast (Dirigible Tower)
    float mastBaseY = 328.0f;
    float mastTransitionY = 365.0f;
    float mastBaseRadius = 6.2f;
    float mastTopRadius = 4.7f;
    int mastRadialHarmonics = 4;        // 4 fluted corner buttress fins
    float mastFinProjection = 1.4f;

    // 6. 102nd Floor Glass Observation Gallery & Conical Dome
    float galleryYMin = 365.0f;
    float galleryYMax = 373.0f;
    float galleryRadius = 4.4f;
    int galleryMullionCount = 24;

    float domeYMin = 373.0f;
    float domeYMax = 381.0f;
    float domeTopRadius = 1.8f;

    // 7. 4-Leg Structural Steel Antenna Lattice Mast
    float spireBaseY = 381.0f;
    float spirePinnacleY = 443.2f;
    float spireBaseHalfWidth = 1.6f;
    float spireTopHalfWidth = 0.22f;
    std::vector<float> antennaPlatformY = { 394.0f, 408.0f, 422.0f, 434.0f };
    std::vector<float> antennaPlatformRadius = { 2.5f, 2.1f, 1.7f, 1.3f };
};

// ============================================================================
// GEOMETRY GENERATION HELPERS
// ============================================================================

void addQuad(ScratchboxMesh& target,
             const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3,
             const Vec3& norm, const Vec4& col,
             float uScale = 1.0f, float vScale = 1.0f) {
    uint32_t b = static_cast<uint32_t>(target.vertices.size());
    target.addVertex(Vertex{p0, norm, Vec2(0.0f, 0.0f), col});
    target.addVertex(Vertex{p1, norm, Vec2(uScale, 0.0f), col});
    target.addVertex(Vertex{p2, norm, Vec2(uScale, vScale), col});
    target.addVertex(Vertex{p3, norm, Vec2(0.0f, vScale), col});
    target.addTriangle(b, b + 1, b + 2);
    target.addTriangle(b, b + 2, b + 3);
}

void addBoxMetric(ScratchboxMesh& target,
                  const Vec3& center, const Vec3& size, const Vec4& col,
                  float uScale = 1.0f, float vScale = 1.0f) {
    Vec3 h = size * 0.5f;
    // +Z face
    addQuad(target,
            center + Vec3(-h.x, -h.y,  h.z),
            center + Vec3( h.x, -h.y,  h.z),
            center + Vec3( h.x,  h.y,  h.z),
            center + Vec3(-h.x,  h.y,  h.z),
            Vec3(0, 0, 1), col, size.x * uScale, size.y * vScale);
    // -Z face
    addQuad(target,
            center + Vec3( h.x, -h.y, -h.z),
            center + Vec3(-h.x, -h.y, -h.z),
            center + Vec3(-h.x,  h.y, -h.z),
            center + Vec3( h.x,  h.y, -h.z),
            Vec3(0, 0, -1), col, size.x * uScale, size.y * vScale);
    // +X face
    addQuad(target,
            center + Vec3( h.x, -h.y,  h.z),
            center + Vec3( h.x, -h.y, -h.z),
            center + Vec3( h.x,  h.y, -h.z),
            center + Vec3( h.x,  h.y,  h.z),
            Vec3(1, 0, 0), col, size.z * uScale, size.y * vScale);
    // -X face
    addQuad(target,
            center + Vec3(-h.x, -h.y, -h.z),
            center + Vec3(-h.x, -h.y,  h.z),
            center + Vec3(-h.x,  h.y,  h.z),
            center + Vec3(-h.x,  h.y, -h.z),
            Vec3(-1, 0, 0), col, size.z * uScale, size.y * vScale);
    // +Y face (Roof / Top)
    addQuad(target,
            center + Vec3(-h.x,  h.y,  h.z),
            center + Vec3( h.x,  h.y,  h.z),
            center + Vec3( h.x,  h.y, -h.z),
            center + Vec3(-h.x,  h.y, -h.z),
            Vec3(0, 1, 0), col, size.x * uScale, size.z * vScale);
    // -Y face (Bottom)
    addQuad(target,
            center + Vec3(-h.x, -h.y, -h.z),
            center + Vec3( h.x, -h.y, -h.z),
            center + Vec3( h.x, -h.y,  h.z),
            center + Vec3(-h.x, -h.y,  h.z),
            Vec3(0, -1, 0), col, size.x * uScale, size.z * vScale);
}

void addCylinderMetric(ScratchboxMesh& target,
                       const Vec3& baseCenter,
                       float rBottom, float rTop, float height,
                       int segments, const Vec4& col,
                       float uRepeat = 1.0f, float vRepeat = 1.0f) {
    uint32_t baseIdx = static_cast<uint32_t>(target.vertices.size());
    float dTheta = TWO_PI / static_cast<float>(segments);

    for (int i = 0; i <= segments; ++i) {
        float theta = static_cast<float>(i) * dTheta;
        float cosT = std::cos(theta);
        float sinT = std::sin(theta);
        float u = (static_cast<float>(i) / static_cast<float>(segments)) * uRepeat;

        Vec3 pBot = baseCenter + Vec3(rBottom * cosT, 0.0f, rBottom * sinT);
        Vec3 pTop = baseCenter + Vec3(rTop * cosT, height, rTop * sinT);

        Vec3 tangent(-sinT, 0.0f, cosT);
        Vec3 slope(pTop - pBot);
        Vec3 norm = tangent.cross(slope).normalized();

        target.addVertex(Vertex{pBot, norm, Vec2(u, 0.0f), col});
        target.addVertex(Vertex{pTop, norm, Vec2(u, vRepeat), col});
    }

    for (int i = 0; i < segments; ++i) {
        uint32_t i0 = baseIdx + i * 2;
        uint32_t i1 = i0 + 1;
        uint32_t i2 = i0 + 2;
        uint32_t i3 = i0 + 3;
        target.addTriangle(i0, i2, i1);
        target.addTriangle(i1, i2, i3);
    }
}

// ============================================================================
// ARCHITECTURAL FENESTRATION GENERATOR (TANGENT PLANE FACADES)
// ============================================================================

struct TangentPlaneFacade {
    Vec3 origin;
    Vec3 uDir;
    Vec3 vDir;
    Vec3 nDir;
    float width;
    float height;
};

/**
 * Highly sophisticated Art Deco architectural window bay generator:
 * - Recessed Indiana limestone aperture surrounds with deep top/bottom/side splay reveals
 * - 3D cast Art Deco spandrel panels with 3 horizontal raised reeded ribs
 * - Continuous 3D vertical stainless steel mullion fins projecting +0.12m forward of glass
 * - Dielectric architectural glazing recessed -0.18m, divided by bronze meeting rail
 * - Ambient warm office interior illumination backing quads
 */
void addArtDecoWindowBay(
    ScratchboxMesh& meshStone,
    ScratchboxMesh& meshGlazing,
    ScratchboxMesh& meshSpandrel,
    ScratchboxMesh& meshSteel,
    ScratchboxMesh& meshBronze,
    ScratchboxMesh& meshInterior,
    const TangentPlaneFacade& facade,
    float uMin, float uMax,
    float vMin, float vMax,
    float sillHeight,
    float headerHeight,
    float stoneRecess,       // Depth of stone reveal behind outer pier face (e.g. 0.12m)
    float windowRecess,      // Depth of glass plane behind stone reveal (e.g. 0.16m)
    int panes,
    const Vec4& colStone,
    const Vec4& colGlazing,
    const Vec4& colSpandrel,
    const Vec4& colSteel,
    const Vec4& colBronze,
    const Vec4& colInterior,
    bool addInteriorGlow = false
) {
    Vec3 u = facade.uDir;
    Vec3 v = facade.vDir;
    Vec3 n = facade.nDir;
    Vec3 base = facade.origin;

    float bayW = uMax - uMin;
    float bayH = vMax - vMin;
    float ySill = vMin + sillHeight;
    float yHeader = vMax - headerHeight;

    // 1. Recessed Stone Aperture Plane
    Vec3 rStone = n * (-stoneRecess);

    // Stone Lintel above header (recessed into aperture)
    Vec3 lp0 = base + u * uMin + v * yHeader + rStone;
    Vec3 lp1 = base + u * uMax + v * yHeader + rStone;
    Vec3 lp2 = base + u * uMax + v * vMax + rStone;
    Vec3 lp3 = base + u * uMin + v * vMax + rStone;
    addQuad(meshStone, lp0, lp1, lp2, lp3, n, colStone, bayW * 0.5f, headerHeight * 0.5f);

    // Stone Jamb Reveals connecting outer pier face to recessed aperture
    // Left jamb (facing +U)
    addQuad(meshStone,
            base + u * uMin + v * vMin,
            base + u * uMin + v * vMin + rStone,
            base + u * uMin + v * vMax + rStone,
            base + u * uMin + v * vMax,
            u, colStone, stoneRecess * 2.0f, bayH * 0.25f);
    // Right jamb (facing -U)
    addQuad(meshStone,
            base + u * uMax + v * vMin + rStone,
            base + u * uMax + v * vMin,
            base + u * uMax + v * vMax,
            base + u * uMax + v * vMax + rStone,
            -u, colStone, stoneRecess * 2.0f, bayH * 0.25f);

    // 2. 3D Art Deco Cast Spandrel Panel below sill
    float spandrelRecess = stoneRecess + 0.05f;
    Vec3 rSpandrel = n * (-spandrelRecess);

    // Beveled stone sill projecting at ySill
    Vec3 sill0 = base + u * (uMin - 0.03f) + v * (ySill - 0.08f) + n * (-stoneRecess + 0.04f);
    Vec3 sill1 = base + u * (uMax + 0.03f) + v * (ySill - 0.08f) + n * (-stoneRecess + 0.04f);
    Vec3 sill2 = base + u * (uMax + 0.03f) + v * ySill + n * (-stoneRecess + 0.04f);
    Vec3 sill3 = base + u * (uMin - 0.03f) + v * ySill + n * (-stoneRecess + 0.04f);
    addQuad(meshStone, sill0, sill1, sill2, sill3, n, colStone, bayW, 0.2f);

    // Spandrel back plate
    Vec3 sp0 = base + u * uMin + v * vMin + rSpandrel;
    Vec3 sp1 = base + u * uMax + v * vMin + rSpandrel;
    Vec3 sp2 = base + u * uMax + v * (ySill - 0.08f) + rSpandrel;
    Vec3 sp3 = base + u * uMin + v * (ySill - 0.08f) + rSpandrel;
    addQuad(meshSpandrel, sp0, sp1, sp2, sp3, n, colSpandrel, bayW * 0.5f, sillHeight * 0.5f);

    // 3 Horizontal Raised Reeded Fluting Ribs across the spandrel panel
    float spandrelH = (ySill - 0.10f) - (vMin + 0.06f);
    if (spandrelH > 0.30f) {
        float ribH = spandrelH / 4.0f;
        for (int r = 1; r <= 3; ++r) {
            float rY = vMin + 0.06f + static_cast<float>(r) * ribH;
            Vec3 ribC = base + u * (uMin + uMax) * 0.5f + v * rY + rSpandrel + n * 0.025f;
            addBoxMetric(meshSpandrel, ribC, Vec3(bayW - 0.08f, 0.04f, 0.03f), colSpandrel * 1.08f);
        }
    }

    // 3. Recessed Window Glazing
    float totalGlassRecess = stoneRecess + windowRecess;
    Vec3 rGlass = n * (-totalGlassRecess);
    Vec3 g0 = base + u * uMin + v * ySill + rGlass;
    Vec3 g1 = base + u * uMax + v * ySill + rGlass;
    Vec3 g2 = base + u * uMax + v * yHeader + rGlass;
    Vec3 g3 = base + u * uMin + v * yHeader + rGlass;
    addQuad(meshGlazing, g0, g1, g2, g3, n, colGlazing, bayW * 0.5f, (yHeader - ySill) * 0.5f);

    // Deep Stone Window Reveals (around glazing aperture)
    // Top header reveal (facing -Y)
    addQuad(meshStone, g3, g2, lp1, lp0, -v, colStone, bayW * 0.5f, windowRecess * 2.0f);
    // Bottom sill reveal (facing +Y)
    addQuad(meshStone, base + u * uMin + v * ySill + rStone, base + u * uMax + v * ySill + rStone, g1, g0, v, colStone, bayW * 0.5f, windowRecess * 2.0f);
    // Left jamb reveal (facing +U)
    addQuad(meshStone, base + u * uMin + v * ySill + rStone, g0, g3, lp0, u, colStone, windowRecess * 2.0f, (yHeader - ySill) * 0.5f);
    // Right jamb reveal (facing -U)
    addQuad(meshStone, g1, base + u * uMax + v * ySill + rStone, lp1, g2, -u, colStone, windowRecess * 2.0f, (yHeader - ySill) * 0.5f);

    // 4. Continuous Vertical Stainless Steel Mullion Fins
    // Running vertically through the center of the bay, projecting FORWARD past the stone plane!
    if (panes > 1) {
        float paneW = bayW / static_cast<float>(panes);
        for (int p = 1; p < panes; ++p) {
            float uM = uMin + static_cast<float>(p) * paneW;
            float finW = 0.08f;
            float finProj = 0.12f;
            float finTotalDepth = totalGlassRecess - stoneRecess + finProj;
            Vec3 finC = base + u * uM + v * (vMin + vMax) * 0.5f + rGlass + n * (finTotalDepth * 0.5f);
            addBoxMetric(meshSteel, finC, Vec3(finW, bayH, finTotalDepth), colSteel);

            // Art Deco Chevron Finial Cap at top of each floor fin
            Vec3 capC = base + u * uM + v * (vMax - 0.06f) + rGlass + n * (finTotalDepth + 0.02f);
            addBoxMetric(meshSteel, capC, Vec3(finW * 1.3f, 0.12f, 0.05f), colSteel * 1.15f);
        }
    }

    // Horizontal Meeting Rail (Bronze window sash divider)
    float yMid = (ySill + yHeader) * 0.5f;
    Vec3 railC = base + u * (uMin + uMax) * 0.5f + v * yMid + rGlass + n * 0.02f;
    addBoxMetric(meshBronze, railC, Vec3(bayW - 0.04f, 0.045f, 0.035f), colBronze);

    // 5. Office Interior Depth Illumination Backing Quad
    if (addInteriorGlow) {
        Vec3 rInt = n * (-(totalGlassRecess + 0.35f));
        addQuad(meshInterior,
                base + u * uMin + v * ySill + rInt,
                base + u * uMax + v * ySill + rInt,
                base + u * uMax + v * yHeader + rInt,
                base + u * uMin + v * yHeader + rInt,
                n, colInterior, 1.0f, 1.0f);
    }
}

/**
 * Compound 3-Tier Stepped Indiana Limestone Pier:
 * - Central projecting pier stem (depth: projectionDepth)
 * - Stepped flanking wings (depth: projectionDepth - 0.08m)
 * - Art Deco 3-tier stepped pyramidal pylon finial terminating above setback roof lines
 */
void addArtDecoPier(
    ScratchboxMesh& meshStone,
    const TangentPlaneFacade& facade,
    float uMin, float uMax,
    float vMin, float vMax,
    float projectionDepth,
    const Vec4& colStone,
    bool addParapetFinial = false
) {
    Vec3 u = facade.uDir;
    Vec3 v = facade.vDir;
    Vec3 n = facade.nDir;
    Vec3 base = facade.origin;

    float pierW = uMax - uMin;
    float pierH = vMax - vMin;

    // 1. Central Pier Stem (projects full projectionDepth)
    float stemW = pierW * 0.65f;
    float uMid = (uMin + uMax) * 0.5f;
    Vec3 pStemOffset = n * projectionDepth;
    addBoxMetric(meshStone,
                 base + u * uMid + v * (vMin + vMax) * 0.5f + pStemOffset * 0.5f,
                 Vec3(stemW, pierH, projectionDepth),
                 colStone, stemW * 0.5f, pierH * 0.25f);

    // 2. Stepped Flanking Wings (left and right, stepped back by 0.08m)
    float wingW = (pierW - stemW) * 0.5f;
    float wingProj = projectionDepth - 0.08f;
    Vec3 pWingOffset = n * wingProj;
    // Left wing
    addBoxMetric(meshStone,
                 base + u * (uMin + wingW * 0.5f) + v * (vMin + vMax) * 0.5f + pWingOffset * 0.5f,
                 Vec3(wingW, pierH, wingProj),
                 colStone * 0.96f, wingW * 0.5f, pierH * 0.25f);
    // Right wing
    addBoxMetric(meshStone,
                 base + u * (uMax - wingW * 0.5f) + v * (vMin + vMax) * 0.5f + pWingOffset * 0.5f,
                 Vec3(wingW, pierH, wingProj),
                 colStone * 0.96f, wingW * 0.5f, pierH * 0.25f);

    // 3. Art Deco Pyramidal Pylon Finial above roof line
    if (addParapetFinial) {
        addBoxMetric(meshStone,
                     base + u * uMid + v * (vMax + 0.35f) + pStemOffset * 0.5f,
                     Vec3(pierW * 0.85f, 0.70f, projectionDepth * 0.90f),
                     colStone * 1.02f);
        addBoxMetric(meshStone,
                     base + u * uMid + v * (vMax + 0.85f) + pStemOffset * 0.45f,
                     Vec3(pierW * 0.60f, 0.50f, projectionDepth * 0.75f),
                     colStone * 1.05f);
        addBoxMetric(meshStone,
                     base + u * uMid + v * (vMax + 1.25f) + pStemOffset * 0.35f,
                     Vec3(pierW * 0.35f, 0.40f, projectionDepth * 0.50f),
                     colStone * 1.10f);
    }
}

} // namespace

// ============================================================================
// MAIN SYNTHESIZER
// ============================================================================

int main(int argc, char** argv) {
    std::cout << "======================================================================\n";
    std::cout << "  SCRATCHBOX ADAPTIVE HIGH-RISE PROCEDURAL ARCHITECTURAL SYNTHESIZER  \n";
    std::cout << "  V3 Master: Manhattan Grid Rectification & Art Deco High-Level PBR   \n";
    std::cout << "======================================================================\n";

    AdaptiveHighRiseParams params;

    // Material slot colors
    Vec4 colLimestone(0.76f, 0.73f, 0.68f, 1.0f);     // Authentic Indiana limestone warm buff
    Vec4 colGranite(0.20f, 0.20f, 0.22f, 1.0f);       // Polished charcoal granite base course
    Vec4 colSpandrel(0.24f, 0.22f, 0.20f, 1.0f);      // Cast nickel bronze / oxidized aluminum spandrels
    Vec4 colSteel(0.92f, 0.94f, 0.96f, 1.0f);         // Polished stainless steel / nickel chromium trim
    Vec4 colGlazing(0.06f, 0.09f, 0.12f, 0.95f);      // Solar-tinted architectural dielectric glazing
    Vec4 colBronze(0.38f, 0.28f, 0.18f, 1.0f);        // Statuary architectural bronze entrance doors
    Vec4 colPaverDeck(0.55f, 0.54f, 0.50f, 1.0f);     // Stone paver terrace decking (NOT black!)
    Vec4 colSidewalk(0.65f, 0.63f, 0.60f, 1.0f);      // Scored concrete sidewalk apron
    Vec4 colInterior(0.98f, 0.90f, 0.74f, 1.0f);      // Warm incandescent office/lobby illumination
    Vec4 colMooringSpire(0.85f, 0.88f, 0.92f, 1.0f);   // Metallic mooring mast & broadcast spire

    // Sub-meshes for all architectural slots
    ScratchboxMesh meshLimestone("Hero_IndianaLimestone");
    ScratchboxMesh meshGranite("Hero_CharcoalGranitePlinth");
    ScratchboxMesh meshSpandrel("Hero_ArtDecoSpandrels");
    ScratchboxMesh meshSteel("Hero_StainlessSteel");
    ScratchboxMesh meshGlazing("Hero_ArchitecturalGlazing");
    ScratchboxMesh meshBronze("Hero_StatuaryBronze");
    ScratchboxMesh meshPaverDeck("Hero_StonePaverDecking");
    ScratchboxMesh meshSidewalk("Hero_ScoredSidewalkApron");
    ScratchboxMesh meshInterior("Hero_GrandLobbyInterior");
    ScratchboxMesh meshMooringMast("Hero_MooringMastAndSpire");

    // ------------------------------------------------------------------------
    // A. Sidewalk Apron & Granite Base Course (Calibrated to Midtown Grid)
    // ------------------------------------------------------------------------
    std::cout << "[Step 1/6] Synthesizing Ground Footprint & Granite Base Course...\n";

    float curbEast  = params.curbEast;   // +72.0m (5th Ave)
    float curbWest  = params.curbWest;   // -80.0m (6th Ave)
    float curbNorth = params.curbNorth;  // -43.0m (34th St)
    float curbSouth = params.curbSouth;  // +47.0m (33rd St)

    float blockWidthX = curbEast - curbWest;   // 152.0m
    float blockDepthZ = curbSouth - curbNorth; // 90.0m
    float blockCenterX = (curbEast + curbWest) * 0.5f;   // -4.0m
    float blockCenterZ = (curbSouth + curbNorth) * 0.5f; // +2.0m

    // Scored Sidewalk Apron spanning the entire parcel block (Y = 0.05m to 0.20m)
    addBoxMetric(meshSidewalk,
                 Vec3(blockCenterX, 0.05f, blockCenterZ),
                 Vec3(blockWidthX + 1.0f, 0.20f, blockDepthZ + 1.0f),
                 colSidewalk, 0.25f, 0.25f);

    // Podium Base Bounds (leaving 2.5m sidewalk buffer to curbs)
    float podEast   = params.podEast;   // +69.5m
    float podWest   = params.podWest;   // -77.5m
    float podNorth  = params.podNorth;  // -40.5m
    float podSouth  = params.podSouth;  // +44.5m
    float podWidthX = podEast - podWest;   // 147.0m
    float podDepthZ = podSouth - podNorth; // 85.0m
    float podCenterX = (podEast + podWest) * 0.5f;   // -4.0m
    float podCenterZ = (podSouth + podNorth) * 0.5f; // +2.0m

    // Charcoal Granite Plinth Course (Y = 0.15m to 1.65m)
    addBoxMetric(meshGranite,
                 Vec3(podCenterX, 0.90f, podCenterZ),
                 Vec3(podWidthX, 1.50f, podDepthZ),
                 colGranite, 0.5f, 1.0f);

    // ------------------------------------------------------------------------
    // B. Ground Entrances & Grand Portico
    // ------------------------------------------------------------------------
    std::cout << "[Step 2/6] Synthesizing 5th Ave Portico & Marquee Canopies...\n";

    // 5th Ave 3-Story Grand Portico (East facade centered at Z = 2.0m)
    float porticoZ = blockCenterZ;
    addBoxMetric(meshLimestone, Vec3(podEast + 0.35f, 7.8f, porticoZ - 10.0f), Vec3(0.70f, 12.6f, 2.0f), colLimestone);
    addBoxMetric(meshLimestone, Vec3(podEast + 0.35f, 7.8f, porticoZ + 10.0f), Vec3(0.70f, 12.6f, 2.0f), colLimestone);
    addBoxMetric(meshLimestone, Vec3(podEast + 0.40f, 13.1f, porticoZ), Vec3(0.80f, 2.0f, 22.0f), colLimestone);
    addBoxMetric(meshLimestone, Vec3(podEast + 0.35f, 7.8f, porticoZ - 3.2f), Vec3(0.70f, 12.6f, 1.1f), colLimestone);
    addBoxMetric(meshLimestone, Vec3(podEast + 0.35f, 7.8f, porticoZ + 3.2f), Vec3(0.70f, 12.6f, 1.1f), colLimestone);

    // Bronze Revolving Doors & Cast Transoms
    addBoxMetric(meshBronze, Vec3(podEast + 0.12f, 1.6f, porticoZ), Vec3(0.24f, 3.2f, 4.2f), colBronze);
    addBoxMetric(meshBronze, Vec3(podEast + 0.12f, 1.6f, porticoZ - 6.6f), Vec3(0.24f, 3.2f, 4.2f), colBronze);
    addBoxMetric(meshBronze, Vec3(podEast + 0.12f, 1.6f, porticoZ + 6.6f), Vec3(0.24f, 3.2f, 4.2f), colBronze);

    addBoxMetric(meshBronze, Vec3(podEast + 0.10f, 7.6f, porticoZ), Vec3(0.20f, 8.8f, 4.4f), colBronze);
    addBoxMetric(meshBronze, Vec3(podEast + 0.10f, 7.6f, porticoZ - 6.6f), Vec3(0.20f, 8.8f, 4.4f), colBronze);
    addBoxMetric(meshBronze, Vec3(podEast + 0.10f, 7.6f, porticoZ + 6.6f), Vec3(0.20f, 8.8f, 4.4f), colBronze);

    // Grand Lobby Interior Backing
    addBoxMetric(meshInterior, Vec3(podEast - 10.0f, 6.75f, porticoZ), Vec3(18.0f, 13.5f, 22.0f), colInterior);

    // 33rd & 34th Street Marquee Canopies
    auto addMarquee = [&](float zWall, float sgn) {
        Vec3 cen(blockCenterX, 4.4f, zWall + sgn * 1.6f);
        addBoxMetric(meshBronze, cen, Vec3(14.0f, 0.65f, 3.2f), colBronze);
        addBoxMetric(meshSteel, cen + Vec3(0.0f, 0.0f, sgn * 1.62f), Vec3(14.2f, 0.30f, 0.06f), colSteel);
        addBoxMetric(meshGlazing, Vec3(blockCenterX, 2.0f, zWall + sgn * 0.06f), Vec3(10.8f, 3.2f, 0.08f), colGlazing);
    };
    addMarquee(podNorth, -1.0f);
    addMarquee(podSouth,  1.0f);

    // ------------------------------------------------------------------------
    // C. Podium Facades (Floors 1-5: Y = 1.65m to 24.0m)
    // ------------------------------------------------------------------------
    std::cout << "[Step 3/6] Synthesizing Podium Fenestration & Floor Slabs...\n";
    TangentPlaneFacade podiumEast { Vec3(podEast,  0.0f, podCenterZ), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3( 1, 0, 0), podDepthZ, 24.0f };
    TangentPlaneFacade podiumWest { Vec3(podWest,  0.0f, podCenterZ), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3(-1, 0, 0), podDepthZ, 24.0f };
    TangentPlaneFacade podiumNorth{ Vec3(podCenterX, 0.0f, podNorth), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, -1), podWidthX, 24.0f };
    TangentPlaneFacade podiumSouth{ Vec3(podCenterX, 0.0f, podSouth), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0,  1), podWidthX, 24.0f };

    // Retail Storefront Glazing along 5th Ave
    addBoxMetric(meshGlazing, Vec3(podEast + 0.05f, 3.15f, porticoZ - 22.0f), Vec3(0.12f, 3.3f, 20.0f), colGlazing);
    addBoxMetric(meshGlazing, Vec3(podEast + 0.05f, 3.15f, porticoZ + 22.0f), Vec3(0.12f, 3.3f, 20.0f), colGlazing);

    // Upper podium window bays (Y = 5.2m to 23.0m)
    for (float yF = 5.2f; yF < 22.0f; yF += 4.5f) {
        float halfD = podDepthZ * 0.5f;
        for (float zB = -halfD + 4.5f; zB <= halfD - 4.5f; zB += 8.6f) {
            if (std::abs(zB) < 11.0f) continue; // Skip entrance portico
            addArtDecoWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, meshBronze, meshInterior,
                                podiumEast, zB - 3.2f, zB + 3.2f, yF, yF + 4.5f,
                                0.90f, 0.20f, 0.15f, 0.18f, 3,
                                colLimestone, colGlazing, colSpandrel, colSteel, colBronze, colInterior, false);
            addArtDecoWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, meshBronze, meshInterior,
                                podiumWest, zB - 3.2f, zB + 3.2f, yF, yF + 4.5f,
                                0.90f, 0.20f, 0.15f, 0.18f, 3,
                                colLimestone, colGlazing, colSpandrel, colSteel, colBronze, colInterior, false);
        }
        float halfW = podWidthX * 0.5f;
        for (float xB = -halfW + 6.0f; xB <= halfW - 6.0f; xB += 9.0f) {
            if (std::abs(xB) < 8.0f) continue; // Skip marquee
            addArtDecoWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, meshBronze, meshInterior,
                                podiumNorth, xB - 3.4f, xB + 3.4f, yF, yF + 4.5f,
                                0.90f, 0.20f, 0.15f, 0.18f, 3,
                                colLimestone, colGlazing, colSpandrel, colSteel, colBronze, colInterior, false);
            addArtDecoWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, meshBronze, meshInterior,
                                podiumSouth, xB - 3.4f, xB + 3.4f, yF, yF + 4.5f,
                                0.90f, 0.20f, 0.15f, 0.18f, 3,
                                colLimestone, colGlazing, colSpandrel, colSteel, colBronze, colInterior, false);
        }
    }

    // Floor 5 Setback Parapet & Paver Terrace (Y = 24.0m) - Covering Full Podium Roof
    addBoxMetric(meshPaverDeck, Vec3(podCenterX, 24.1f, podCenterZ), Vec3(podWidthX, 0.20f, podDepthZ), colPaverDeck);
    // Parapet coping walls around perimeter
    addBoxMetric(meshLimestone, Vec3(podCenterX, 24.7f, podNorth + 0.4f), Vec3(podWidthX, 1.2f, 0.8f), colLimestone);
    addBoxMetric(meshLimestone, Vec3(podCenterX, 24.7f, podSouth - 0.4f), Vec3(podWidthX, 1.2f, 0.8f), colLimestone);
    addBoxMetric(meshLimestone, Vec3(podEast - 0.4f, 24.7f, podCenterZ), Vec3(0.8f, 1.2f, podDepthZ), colLimestone);
    addBoxMetric(meshLimestone, Vec3(podWest + 0.4f, 24.7f, podCenterZ), Vec3(0.8f, 1.2f, podDepthZ), colLimestone);

    // Solid Central Interior Core for Podium Base (guarantees water-tight interior)
    addBoxMetric(meshLimestone, Vec3(podCenterX, 12.0f, podCenterZ), Vec3(podWidthX - 0.4f, 23.8f, podDepthZ - 0.4f), colLimestone * 0.9f);

    // Solid Corner Limestone Pylons for Podium (seals all 4 corners water-tight)
    float podCornW = 4.0f;
    addBoxMetric(meshLimestone, Vec3(podEast - podCornW*0.5f, 12.0f, podSouth - podCornW*0.5f), Vec3(podCornW, 24.0f, podCornW), colLimestone);
    addBoxMetric(meshLimestone, Vec3(podWest + podCornW*0.5f, 12.0f, podSouth - podCornW*0.5f), Vec3(podCornW, 24.0f, podCornW), colLimestone);
    addBoxMetric(meshLimestone, Vec3(podEast - podCornW*0.5f, 12.0f, podNorth + podCornW*0.5f), Vec3(podCornW, 24.0f, podCornW), colLimestone);
    addBoxMetric(meshLimestone, Vec3(podWest + podCornW*0.5f, 12.0f, podNorth + podCornW*0.5f), Vec3(podCornW, 24.0f, podCornW), colLimestone);

    // ------------------------------------------------------------------------
    // D. Multi-Tier Setbacks & Art Deco Tower Shaft (Tiers 1 to 6)
    // ------------------------------------------------------------------------
    std::cout << "[Step 4/6] Synthesizing Multi-Tier Setbacks & High-Level Tower Shaft...\n";

    for (size_t tIdx = 0; tIdx < params.tiers.size(); ++tIdx) {
        const auto& tier = params.tiers[tIdx];
        float hX = tier.halfX;
        float hZ = tier.halfZ;
        float yBot = tier.yMin;
        float yTop = tier.yMax;
        float tierH = yTop - yBot;
        bool isTopTier = (tIdx == params.tiers.size() - 1);

        std::cout << "  -> Synthesizing Tier " << (tIdx + 1) << " [Y: " << yBot << "m to " << yTop 
                  << "m, Size: " << (hX * 2.0f) << "m x " << (hZ * 2.0f) << "m]...\n";

        // Solid Central Interior Core for Tier (guarantees water-tight interior)
        addBoxMetric(meshLimestone, Vec3(0.0f, (yBot + yTop) * 0.5f, 0.0f), Vec3(hX * 2.0f - 0.3f, tierH - 0.05f, hZ * 2.0f - 0.3f), colLimestone * 0.9f);

        // Solid Corner Limestone Pylons (sealing all 4 corners water-tight with zero dark gaps)
        float cSize = 3.2f;
        addBoxMetric(meshLimestone, Vec3( hX - cSize*0.5f, (yBot + yTop)*0.5f,  hZ - cSize*0.5f), Vec3(cSize, tierH, cSize), colLimestone);
        addBoxMetric(meshLimestone, Vec3(-hX + cSize*0.5f, (yBot + yTop)*0.5f,  hZ - cSize*0.5f), Vec3(cSize, tierH, cSize), colLimestone);
        addBoxMetric(meshLimestone, Vec3( hX - cSize*0.5f, (yBot + yTop)*0.5f, -hZ + cSize*0.5f), Vec3(cSize, tierH, cSize), colLimestone);
        addBoxMetric(meshLimestone, Vec3(-hX + cSize*0.5f, (yBot + yTop)*0.5f, -hZ + cSize*0.5f), Vec3(cSize, tierH, cSize), colLimestone);

        // 1. Facades for the 4 cardinal directions (Centered at Tower Shaft: X=0, Z=0)
        TangentPlaneFacade fEast { Vec3( hX, 0.0f, 0.0f), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3( 1, 0, 0), hZ * 2.0f, tierH };
        TangentPlaneFacade fWest { Vec3(-hX, 0.0f, 0.0f), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3(-1, 0, 0), hZ * 2.0f, tierH };
        TangentPlaneFacade fNorth{ Vec3(0.0f, 0.0f, -hZ), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, -1), hX * 2.0f, tierH };
        TangentPlaneFacade fSouth{ Vec3(0.0f, 0.0f,  hZ), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0,  1), hX * 2.0f, tierH };

        // 2. Compound 3-Tier Stepped Indiana Limestone Piers with Art Deco Finials
        float pierPitch = tier.pierSpacing;
        for (float z = -hZ + 2.5f; z <= hZ - 2.5f; z += pierPitch) {
            addArtDecoPier(meshLimestone, fEast, z - 0.50f, z + 0.50f, yBot, yTop, tier.pierDepth, colLimestone, true);
            addArtDecoPier(meshLimestone, fWest, z - 0.50f, z + 0.50f, yBot, yTop, tier.pierDepth, colLimestone, true);
        }
        for (float x = -hX + 2.5f; x <= hX - 2.5f; x += pierPitch) {
            addArtDecoPier(meshLimestone, fNorth, x - 0.50f, x + 0.50f, yBot, yTop, tier.pierDepth, colLimestone, true);
            addArtDecoPier(meshLimestone, fSouth, x - 0.50f, x + 0.50f, yBot, yTop, tier.pierDepth, colLimestone, true);
        }

        // 3. Multi-Floor Art Deco Window Bays with Fluted Spandrels & Stainless Steel Mullions
        float floorStep = 3.6f;
        int floorCount = 0;
        for (float yF = yBot; yF < yTop - 1.5f; yF += floorStep) {
            float yFEnd = std::min(yTop, yF + floorStep);
            floorCount++;

            for (float z = -hZ + 2.5f; z <= hZ - pierPitch; z += pierPitch) {
                bool glowEast = ((floorCount + static_cast<int>(z * 3.7f)) % 4 == 0);
                bool glowWest = ((floorCount + static_cast<int>(z * 5.3f)) % 4 == 0);

                addArtDecoWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, meshBronze, meshInterior,
                                    fEast, z + 0.50f, z + pierPitch - 0.50f, yF, yFEnd,
                                    0.85f, 0.15f, 0.14f, 0.18f, 2,
                                    colLimestone, colGlazing, colSpandrel, colSteel, colBronze, colInterior, glowEast);
                addArtDecoWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, meshBronze, meshInterior,
                                    fWest, z + 0.50f, z + pierPitch - 0.50f, yF, yFEnd,
                                    0.85f, 0.15f, 0.14f, 0.18f, 2,
                                    colLimestone, colGlazing, colSpandrel, colSteel, colBronze, colInterior, glowWest);
            }
            for (float x = -hX + 2.5f; x <= hX - pierPitch; x += pierPitch) {
                bool glowNorth = ((floorCount + static_cast<int>(x * 4.1f)) % 4 == 0);
                bool glowSouth = ((floorCount + static_cast<int>(x * 2.9f)) % 4 == 0);

                addArtDecoWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, meshBronze, meshInterior,
                                    fNorth, x + 0.50f, x + pierPitch - 0.50f, yF, yFEnd,
                                    0.85f, 0.15f, 0.14f, 0.18f, 2,
                                    colLimestone, colGlazing, colSpandrel, colSteel, colBronze, colInterior, glowNorth);
                addArtDecoWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, meshBronze, meshInterior,
                                    fSouth, x + 0.50f, x + pierPitch - 0.50f, yF, yFEnd,
                                    0.85f, 0.15f, 0.14f, 0.18f, 2,
                                    colLimestone, colGlazing, colSpandrel, colSteel, colBronze, colInterior, glowSouth);
            }
        }

        // 4. Stepped Re-Entrant Corner Insets (for Tier 4 Main Shaft)
        if (tier.cornerInset > 0.0f) {
            float cW = tier.cornerInset;
            addBoxMetric(meshLimestone, Vec3( hX - cW * 0.5f, (yBot + yTop) * 0.5f, -hZ + cW * 0.5f), Vec3(cW, tierH, cW), colLimestone);
            addBoxMetric(meshLimestone, Vec3(-hX + cW * 0.5f, (yBot + yTop) * 0.5f, -hZ + cW * 0.5f), Vec3(cW, tierH, cW), colLimestone);
            addBoxMetric(meshLimestone, Vec3( hX - cW * 0.5f, (yBot + yTop) * 0.5f,  hZ - cW * 0.5f), Vec3(cW, tierH, cW), colLimestone);
            addBoxMetric(meshLimestone, Vec3(-hX + cW * 0.5f, (yBot + yTop) * 0.5f,  hZ - cW * 0.5f), Vec3(cW, tierH, cW), colLimestone);
        }

        // 5. Roof Terrace Pavers & 2-Tier Parapet Coping
        if (tier.hasRoofTerrace) {
            addBoxMetric(meshPaverDeck, Vec3(0.0f, yTop + 0.10f, 0.0f), Vec3(hX * 2.0f, 0.20f, hZ * 2.0f), colPaverDeck);
            // 2-Tier Perimeter Parapet Coping (with overhang)
            addBoxMetric(meshLimestone, Vec3(0.0f, yTop + 0.60f, -hZ + 0.35f), Vec3(hX * 2.0f, 1.0f, 0.7f), colLimestone);
            addBoxMetric(meshLimestone, Vec3(0.0f, yTop + 0.60f,  hZ - 0.35f), Vec3(hX * 2.0f, 1.0f, 0.7f), colLimestone);
            addBoxMetric(meshLimestone, Vec3( hX - 0.35f, yTop + 0.60f, 0.0f), Vec3(0.7f, 1.0f, hZ * 2.0f), colLimestone);
            addBoxMetric(meshLimestone, Vec3(-hX + 0.35f, yTop + 0.60f, 0.0f), Vec3(0.7f, 1.0f, hZ * 2.0f), colLimestone);

            // Beveled Stone Cornice Overhang (projecting +0.15m outwards)
            addBoxMetric(meshLimestone, Vec3(0.0f, yTop + 1.15f, -hZ - 0.08f), Vec3(hX * 2.0f + 0.3f, 0.15f, 0.25f), colLimestone * 1.05f);
            addBoxMetric(meshLimestone, Vec3(0.0f, yTop + 1.15f,  hZ + 0.08f), Vec3(hX * 2.0f + 0.3f, 0.15f, 0.25f), colLimestone * 1.05f);
            addBoxMetric(meshLimestone, Vec3( hX + 0.08f, yTop + 1.15f, 0.0f), Vec3(0.25f, 0.15f, hZ * 2.0f + 0.3f), colLimestone * 1.05f);
            addBoxMetric(meshLimestone, Vec3(-hX - 0.08f, yTop + 1.15f, 0.0f), Vec3(0.25f, 0.15f, hZ * 2.0f + 0.3f), colLimestone * 1.05f);
        }

        // 6. Rooftop Mechanical Penthouses & HVAC Chillers (Eliminates flat bare roofs!)
        if (tier.hasMechanicalPenthouses) {
            float pentH = 3.2f;
            float pentW = hX * 0.35f;
            float pentD = hZ * 0.40f;
            addBoxMetric(meshLimestone, Vec3( hX * 0.65f, yTop + pentH * 0.5f, 0.0f), Vec3(pentW, pentH, pentD), colLimestone);
            addBoxMetric(meshLimestone, Vec3(-hX * 0.65f, yTop + pentH * 0.5f, 0.0f), Vec3(pentW, pentH, pentD), colLimestone);
            // Steel Louvered Ventilation Grilles
            addBoxMetric(meshSteel, Vec3( hX * 0.65f, yTop + pentH * 0.5f,  pentD * 0.52f), Vec3(pentW * 0.75f, pentH * 0.65f, 0.12f), colSteel);
            addBoxMetric(meshSteel, Vec3(-hX * 0.65f, yTop + pentH * 0.5f,  pentD * 0.52f), Vec3(pentW * 0.75f, pentH * 0.65f, 0.12f), colSteel);
            // Cylindrical HVAC cooling fans on top
            addCylinderMetric(meshSteel, Vec3( hX * 0.65f, yTop + pentH, 0.0f), 1.2f, 1.2f, 0.8f, 16, colSteel);
            addCylinderMetric(meshSteel, Vec3(-hX * 0.65f, yTop + pentH, 0.0f), 1.2f, 1.2f, 0.8f, 16, colSteel);
        }
    }

    // ------------------------------------------------------------------------
    // E. 86th Floor Open-Air Observation Promenade & Enclosed Pavilion (Y = 320m to 328m)
    // ------------------------------------------------------------------------
    std::cout << "[Step 5/6] Synthesizing 86th Floor Observation Promenade & Pavilion...\n";
    float deckY = params.promenadeDeckY;
    float promHX = params.promenadeHalfX;
    float promHZ = params.promenadeHalfZ;

    // 1. Promenade Stone Paver Deck (albedo: [0.55, 0.54, 0.50] - NOT pitch black!)
    addBoxMetric(meshPaverDeck, Vec3(0.0f, deckY + 0.10f, 0.0f), Vec3(promHX * 2.0f, 0.20f, promHZ * 2.0f), colPaverDeck, 0.5f, 0.5f);

    // 2. Art Deco Stainless Steel Protective Safety Railings / Balustrade
    float rH = params.promenadeRailingHeight;
    auto addRailing = [&](const Vec3& pA, const Vec3& pB) {
        Vec3 dir = (pB - pA);
        float len = dir.length();
        Vec3 u = dir.normalized();
        Vec3 n(u.z, 0.0f, -u.x);

        // Top Handrail
        addQuad(meshSteel,
                pA + Vec3(0, rH, 0) - n * 0.05f,
                pB + Vec3(0, rH, 0) - n * 0.05f,
                pB + Vec3(0, rH, 0) + n * 0.05f,
                pA + Vec3(0, rH, 0) + n * 0.05f,
                Vec3(0, 1, 0), colSteel);

        // Vertical Safety Grille Mesh
        addQuad(meshSteel,
                pA + Vec3(0, 0.15f, 0),
                pB + Vec3(0, 0.15f, 0),
                pB + Vec3(0, rH, 0),
                pA + Vec3(0, rH, 0),
                n, colSteel, len * 2.0f, 1.0f);

        // Intermediate Decorative Posts
        for (float d = 0.0f; d <= len; d += 2.8f) {
            Vec3 postC = pA + u * d + Vec3(0.0f, rH * 0.5f, 0.0f);
            addBoxMetric(meshSteel, postC, Vec3(0.12f, rH, 0.12f), colSteel);
        }
    };

    // 4 Sides of the Observation Promenade Railing
    addRailing(Vec3(-promHX + 0.3f, deckY, -promHZ + 0.3f), Vec3( promHX - 0.3f, deckY, -promHZ + 0.3f));
    addRailing(Vec3( promHX - 0.3f, deckY, -promHZ + 0.3f), Vec3( promHX - 0.3f, deckY,  promHZ - 0.3f));
    addRailing(Vec3( promHX - 0.3f, deckY,  promHZ - 0.3f), Vec3(-promHX + 0.3f, deckY,  promHZ - 0.3f));
    addRailing(Vec3(-promHX + 0.3f, deckY,  promHZ - 0.3f), Vec3(-promHX + 0.3f, deckY, -promHZ + 0.3f));

    // 3. Central Enclosed Limestone Observation Pavilion (Y = 320m to 328m)
    float pavHX = params.pavilionHalfX;
    float pavHZ = params.pavilionHalfZ;
    float pavY0 = params.pavilionYMin;
    float pavY1 = params.pavilionYMax;
    float pavH = pavY1 - pavY0;

    // Pavilion base course & roof slab
    addBoxMetric(meshLimestone, Vec3(0.0f, pavY0 + 0.6f, 0.0f), Vec3(pavHX * 2.0f, 1.2f, pavHZ * 2.0f), colLimestone);
    addBoxMetric(meshLimestone, Vec3(0.0f, pavY1 - 0.4f, 0.0f), Vec3(pavHX * 2.0f + 0.6f, 0.8f, pavHZ * 2.0f + 0.6f), colLimestone);

    // Wrap-Around Continuous Panoramic Glass Viewing Windows (Y = 321.2m to 326.5m)
    float winY0 = params.pavilionWindowYMin;
    float winY1 = params.pavilionWindowYMax;
    float winH = winY1 - winY0;

    TangentPlaneFacade pavEast { Vec3( pavHX, 0.0f, 0.0f), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3( 1, 0, 0), pavHZ * 2.0f, pavH };
    TangentPlaneFacade pavWest { Vec3(-pavHX, 0.0f, 0.0f), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3(-1, 0, 0), pavHZ * 2.0f, pavH };
    TangentPlaneFacade pavNorth{ Vec3(0.0f, 0.0f, -pavHZ), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, -1), pavHX * 2.0f, pavH };
    TangentPlaneFacade pavSouth{ Vec3(0.0f, 0.0f,  pavHZ), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0,  1), pavHX * 2.0f, pavH };

    auto addPavilionGlazing = [&](const TangentPlaneFacade& f, float halfLen) {
        addQuad(meshGlazing,
                f.origin - f.uDir * halfLen + f.vDir * winY0,
                f.origin + f.uDir * halfLen + f.vDir * winY0,
                f.origin + f.uDir * halfLen + f.vDir * winY1,
                f.origin - f.uDir * halfLen + f.vDir * winY1,
                f.nDir, colGlazing, halfLen, 1.0f);

        // Mullions
        for (float uPos = -halfLen + 2.0f; uPos <= halfLen - 2.0f; uPos += 2.0f) {
            Vec3 mPos = f.origin + f.uDir * uPos + f.vDir * (winY0 + winH * 0.5f) + f.nDir * 0.04f;
            addBoxMetric(meshSteel, mPos, Vec3(0.08f, winH, 0.12f), colSteel);
        }
    };

    addPavilionGlazing(pavEast,  pavHZ);
    addPavilionGlazing(pavWest,  pavHZ);
    addPavilionGlazing(pavNorth, pavHX);
    addPavilionGlazing(pavSouth, pavHX);

    // Warm illuminated interior ceiling inside pavilion
    addBoxMetric(meshInterior, Vec3(0.0f, (winY0 + winY1) * 0.5f, 0.0f), Vec3(pavHX * 1.8f, winH * 0.9f, pavHZ * 1.8f), colInterior);

    // ------------------------------------------------------------------------
    // F. Octagonal Mooring Mast, 102nd Floor Gallery & Broadcast Spire
    // ------------------------------------------------------------------------
    std::cout << "[Step 6/6] Synthesizing Octagonal Mooring Mast, 102nd Gallery & Antenna Spire...\n";

    // 1. Stepped Octagonal Mooring Mast Base (Y = 328.0m to 365.0m)
    float mastY0 = params.mastBaseY;
    float mastY1 = params.mastTransitionY;
    float mastH = mastY1 - mastY0;
    float rMastBot = params.mastBaseRadius;
    float rMastTop = params.mastTopRadius;

    // Mooring Mast Revolved Octagonal Core with 8 Fluted Facets
    addCylinderMetric(meshMooringMast, Vec3(0.0f, mastY0, 0.0f), rMastBot, rMastTop, mastH, 8, colMooringSpire, 4.0f, 4.0f);

    // 4 Art Deco Projecting Stainless Steel Buttress Fins (aligned with diagonals)
    float finH = mastH * 0.85f;
    for (int k = 0; k < 4; ++k) {
        float angle = static_cast<float>(k) * (PI * 0.5f) + (PI * 0.25f);
        float cosA = std::cos(angle);
        float sinA = std::sin(angle);
        Vec3 finCenter(cosA * (rMastBot + 0.6f), mastY0 + finH * 0.5f, sinA * (rMastBot + 0.6f));
        addBoxMetric(meshSteel, finCenter, Vec3(0.35f, finH, 1.6f), colSteel);
        // Step insets along the fins
        Vec3 stepC(cosA * (rMastBot + 1.1f), mastY0 + finH * 0.25f, sinA * (rMastBot + 1.1f));
        addBoxMetric(meshSteel, stepC, Vec3(0.25f, finH * 0.5f, 0.8f), colSteel);
    }

    // 2. 102nd Floor Glass Observation Gallery (Y = 365.0m to 373.0m)
    float galY0 = params.galleryYMin;
    float galY1 = params.galleryYMax;
    float galH = galY1 - galY0;
    float rGal = params.galleryRadius;

    // Glass cylinder
    addCylinderMetric(meshGlazing, Vec3(0.0f, galY0, 0.0f), rGal, rGal, galH, 32, colGlazing, 4.0f, 1.0f);
    // Interior warm glow
    addCylinderMetric(meshInterior, Vec3(0.0f, galY0, 0.0f), rGal * 0.82f, rGal * 0.82f, galH, 16, colInterior, 1.0f, 1.0f);

    // 24 Polished Stainless Steel Vertical Mullions
    for (int m = 0; m < params.galleryMullionCount; ++m) {
        float theta = static_cast<float>(m) * (TWO_PI / static_cast<float>(params.galleryMullionCount));
        float cT = std::cos(theta);
        float sT = std::sin(theta);
        Vec3 mPos(cT * (rGal + 0.05f), galY0 + galH * 0.5f, sT * (rGal + 0.05f));
        addBoxMetric(meshSteel, mPos, Vec3(0.08f, galH, 0.12f), colSteel);
    }

    // Base and Top Stainless Steel Ring Bezels
    addCylinderMetric(meshSteel, Vec3(0.0f, galY0 - 0.4f, 0.0f), rGal + 0.35f, rGal + 0.35f, 0.4f, 32, colSteel);
    addCylinderMetric(meshSteel, Vec3(0.0f, galY1, 0.0f), rGal + 0.35f, rGal + 0.35f, 0.6f, 32, colSteel);

    // 3. Stepped Conical Mooring Dome Cap (Y = 373.0m to 381.0m)
    float domeY0 = params.domeYMin;
    float domeY1 = params.domeYMax;
    float domeH = domeY1 - domeY0;
    addCylinderMetric(meshMooringMast, Vec3(0.0f, domeY0, 0.0f), rGal + 0.2f, params.domeTopRadius, domeH, 24, colMooringSpire, 2.0f, 2.0f);

    // Stepped collar rings around the dome
    addCylinderMetric(meshSteel, Vec3(0.0f, domeY0 + 2.5f, 0.0f), rGal * 0.85f, rGal * 0.85f, 0.4f, 24, colSteel);
    addCylinderMetric(meshSteel, Vec3(0.0f, domeY0 + 5.2f, 0.0f), rGal * 0.60f, rGal * 0.60f, 0.4f, 24, colSteel);

    // 4. 4-Leg Structural Steel Broadcast Lattice Spire (Y = 381.0m to 443.2m)
    float spY0 = params.spireBaseY;
    float spY1 = params.spirePinnacleY;
    float spH = spY1 - spY0;
    float rSpBot = params.spireBaseHalfWidth;
    float rSpTop = params.spireTopHalfWidth;

    // Central Structural Mast Core
    addCylinderMetric(meshMooringMast, Vec3(0.0f, spY0, 0.0f), rSpBot, rSpTop, spH * 0.90f, 16, colMooringSpire, 1.0f, 4.0f);

    // Pinnacle Lightning Rod Tip (Y = 437m to 443.2m)
    addCylinderMetric(meshSteel, Vec3(0.0f, spY0 + spH * 0.90f, 0.0f), rSpTop, 0.04f, spH * 0.10f, 8, colSteel);

    // 4 Horizontal Antenna Platforms with Circular Steel Grates
    for (size_t p = 0; p < params.antennaPlatformY.size(); ++p) {
        float pY = params.antennaPlatformY[p];
        float pR = params.antennaPlatformRadius[p];
        addCylinderMetric(meshSteel, Vec3(0.0f, pY, 0.0f), pR, pR, 0.35f, 24, colSteel);
        addCylinderMetric(meshSteel, Vec3(0.0f, pY + 0.35f, 0.0f), pR + 0.1f, pR + 0.1f, 0.75f, 24, colSteel);
        Vec4 colBeacon = (p % 2 == 0) ? Vec4(1.0f, 0.2f, 0.2f, 1.0f) : Vec4(1.0f, 1.0f, 1.0f, 1.0f);
        addBoxMetric(meshBronze, Vec3(pR * 0.8f, pY + 0.75f, 0.0f), Vec3(0.18f, 0.30f, 0.18f), colBeacon);
        addBoxMetric(meshBronze, Vec3(-pR * 0.8f, pY + 0.75f, 0.0f), Vec3(0.18f, 0.30f, 0.18f), colBeacon);
    }

    // ------------------------------------------------------------------------
    // G. Procedural Street Trees along 5th Avenue & 34th Street
    // ------------------------------------------------------------------------
    std::cout << "[Step 7/7] Synthesizing Street Trees & Planters...\n";
    ScratchboxMesh meshTreeTrunk("Hero_OakTreeTrunks");
    ScratchboxMesh meshTreeFoliage("Hero_OakTreeFoliage");
    Vec4 colBark(0.32f, 0.25f, 0.20f, 1.0f);
    Vec4 colLeaf(0.24f, 0.52f, 0.18f, 1.0f);

    auto addStreetTree = [&](const Vec3& basePos) {
        // Concrete Planter Curb
        addBoxMetric(meshGranite, basePos + Vec3(0.0f, 0.25f, 0.0f), Vec3(2.4f, 0.40f, 2.4f), colGranite);
        // Soil bed
        addBoxMetric(meshSidewalk, basePos + Vec3(0.0f, 0.35f, 0.0f), Vec3(2.1f, 0.10f, 2.1f), Vec4(0.25f, 0.20f, 0.16f, 1.0f));
        // Tree trunk
        addCylinderMetric(meshTreeTrunk, basePos + Vec3(0.0f, 0.40f, 0.0f), 0.22f, 0.14f, 3.8f, 12, colBark);
        // Volumetric Foliage Canopy (Multi-tier ellipsoids)
        Vec3 cBase = basePos + Vec3(0.0f, 4.2f, 0.0f);
        addCylinderMetric(meshTreeFoliage, cBase, 1.8f, 2.4f, 2.0f, 16, colLeaf);
        addCylinderMetric(meshTreeFoliage, cBase + Vec3(0.0f, 1.8f, 0.0f), 2.4f, 1.4f, 1.8f, 16, colLeaf * 1.08f);
        addCylinderMetric(meshTreeFoliage, cBase + Vec3(0.0f, 3.4f, 0.0f), 1.4f, 0.2f, 1.2f, 12, colLeaf * 1.15f);
    };

    // 5th Avenue Trees (Sidewalk at X = +71.0m)
    for (float zT = -32.0f; zT <= 32.0f; zT += 12.8f) {
        if (std::abs(zT - porticoZ) < 8.0f) continue; // Don't block portico
        addStreetTree(Vec3(71.0f, 0.15f, zT));
    }
    // 34th Street Trees (Sidewalk at Z = -42.0m)
    for (float xT = -64.0f; xT <= 56.0f; xT += 14.0f) {
        if (std::abs(xT - blockCenterX) < 10.0f) continue; // Don't block marquee
        addStreetTree(Vec3(xT, 0.15f, -42.0f));
    }

    // ------------------------------------------------------------------------
    // H. Load & Preserve Midtown Manhattan Google 3D Tile Context District
    // ------------------------------------------------------------------------
    std::cout << "\n[Step 8/8] Ingesting Surrounding Midtown District Tile...\n";
    ScratchboxMesh meshDistrict("MidtownManhattan_SurroundingDistrict");

    std::string tileGlb = "public/tiles/scan_studio_tile_esb_77197_98526.glb";
    GltfScene tileScene = GlbSceneReader::readFile(tileGlb);
    if (tileScene.ok && !tileScene.mesh.vertices.empty()) {
        const auto& tIndices = tileScene.mesh.indices;
        const auto& tVerts = tileScene.mesh.vertices;
        size_t preservedTris = 0;

        // Clean excision bounding box: covers authentic street canyon curbs
        // 5th Ave: +72m, 6th Ave: -80m, 34th St: -43m, 33rd St: +47m
        float excMinX = -81.0f;
        float excMaxX =  73.0f;
        float excMinZ = -44.0f;
        float excMaxZ =  48.0f;

        for (size_t i = 0; i < tIndices.size(); i += 3) {
            Vertex v0 = tVerts[tIndices[i]];
            Vertex v1 = tVerts[tIndices[i + 1]];
            Vertex v2 = tVerts[tIndices[i + 2]];

            float cx = (v0.position.x + v1.position.x + v2.position.x) / 3.0f;
            float cz = (v0.position.z + v1.position.z + v2.position.z) / 3.0f;

            // Excise ONLY the authentic Empire State Building block parcel
            if (cx >= excMinX && cx <= excMaxX && cz >= excMinZ && cz <= excMaxZ) {
                continue; // 100% cleanly excised for synthesized hero architecture!
            }

            // Sample authentic photogrammetric texture color into vertex colors
            uint32_t matIdx = (i / 3 < tileScene.triangleMaterial.size()) ? tileScene.triangleMaterial[i / 3] : 0;
            if (matIdx < tileScene.materials.size()) {
                int imgIdx = tileScene.materials[matIdx].baseColorImage;
                if (imgIdx >= 0 && imgIdx < static_cast<int>(tileScene.images.size())) {
                    const auto& img = tileScene.images[imgIdx];
                    if (img.decoded && !img.pixels.data.empty()) {
                        auto sampleCol = [&](Vertex& v) {
                            float u = v.uv.x - std::floor(v.uv.x);
                            float vCoord = v.uv.y - std::floor(v.uv.y);
                            Vec3 c = img.pixels.sampleBilinear(u, vCoord);
                            v.color = Vec4(c.x, c.y, c.z, 1.0f);
                        };
                        sampleCol(v0);
                        sampleCol(v1);
                        sampleCol(v2);
                    }
                }
            }

            uint32_t b = static_cast<uint32_t>(meshDistrict.vertices.size());
            meshDistrict.addVertex(v0);
            meshDistrict.addVertex(v1);
            meshDistrict.addVertex(v2);
            meshDistrict.addTriangle(b, b + 1, b + 2);
            preservedTris++;
        }
        std::cout << "  Preserved Midtown District: " << preservedTris << " triangles ("
                  << meshDistrict.vertices.size() << " vertices with photogrammetric colors)\n";
    }

    // ------------------------------------------------------------------------
    // EXPORT STAGE 2: 18% STUDIO GREY CLAY GLB
    // ------------------------------------------------------------------------
    std::string stage2Path = "public/models/omnispatial_stage2_vector_refined.glb";
    std::cout << "\nSerializing Stage 2 (Vector-Refined 18% Studio Grey Clay GLB)...\n";
    {
        ScratchboxMesh stage2ClayMesh("VectorRefined_StudioGreyClay");
        stage2ClayMesh.material.name = "Mat_StudioGreyClay";
        stage2ClayMesh.material.baseColorFactor = Vec4(0.55f, 0.57f, 0.60f, 1.0f);
        stage2ClayMesh.material.roughnessFactor = 0.85f;
        stage2ClayMesh.material.metallicFactor = 0.0f;

        auto appendClay = [&](const ScratchboxMesh& src) {
            uint32_t base = static_cast<uint32_t>(stage2ClayMesh.vertices.size());
            for (auto v : src.vertices) {
                v.color = Vec4(0.55f, 0.57f, 0.60f, 1.0f);
                stage2ClayMesh.addVertex(v);
            }
            for (size_t i = 0; i < src.indices.size(); i += 3) {
                stage2ClayMesh.addTriangle(base + src.indices[i], base + src.indices[i + 1], base + src.indices[i + 2]);
            }
        };

        appendClay(meshLimestone);
        appendClay(meshGranite);
        appendClay(meshSpandrel);
        appendClay(meshSteel);
        appendClay(meshGlazing);
        appendClay(meshBronze);
        appendClay(meshPaverDeck);
        appendClay(meshSidewalk);
        appendClay(meshInterior);
        appendClay(meshMooringMast);
        if (!meshTreeTrunk.vertices.empty())   appendClay(meshTreeTrunk);
        if (!meshTreeFoliage.vertices.empty()) appendClay(meshTreeFoliage);
        if (!meshDistrict.vertices.empty())    appendClay(meshDistrict);

        std::vector<uint8_t> clayGlbData = GlbWriter::writeGlb(stage2ClayMesh);
        std::ofstream file(stage2Path, std::ios::binary);
        if (file.is_open()) {
            file.write(reinterpret_cast<const char*>(clayGlbData.data()), clayGlbData.size());
            std::cout << "SUCCESS: Wrote " << clayGlbData.size() << " bytes to " << stage2Path << "\n";
            std::cout << "  Total Vertices: " << stage2ClayMesh.vertices.size() 
                      << ", Total Triangles: " << (stage2ClayMesh.indices.size() / 3) << "\n";
        }
    }

    // ------------------------------------------------------------------------
    // EXPORT STAGE 3: MULTI-SLOT PBR GLB
    // ------------------------------------------------------------------------
    std::string stage3Path = "public/models/omnispatial_real_stage3_streetview_pbr.glb";
    std::cout << "\nSerializing Stage 3 (Multi-Slot PBR Street View GLB)...\n";
    {
        meshLimestone.material.name = "Mat_IndianaLimestone";
        meshLimestone.material.baseColorFactor = Vec4(0.76f, 0.73f, 0.68f, 1.0f);
        meshLimestone.material.roughnessFactor = 0.72f;
        meshLimestone.material.metallicFactor = 0.02f;

        meshGranite.material.name = "Mat_CharcoalGranite";
        meshGranite.material.baseColorFactor = Vec4(0.18f, 0.18f, 0.20f, 1.0f);
        meshGranite.material.roughnessFactor = 0.32f;
        meshGranite.material.metallicFactor = 0.45f;

        meshSpandrel.material.name = "Mat_ArtDecoSpandrels";
        meshSpandrel.material.baseColorFactor = Vec4(0.24f, 0.22f, 0.20f, 1.0f);
        meshSpandrel.material.roughnessFactor = 0.40f;
        meshSpandrel.material.metallicFactor = 0.80f;

        meshSteel.material.name = "Mat_StainlessSteel";
        meshSteel.material.baseColorFactor = Vec4(0.92f, 0.94f, 0.96f, 1.0f);
        meshSteel.material.roughnessFactor = 0.18f;
        meshSteel.material.metallicFactor = 0.96f;

        meshGlazing.material.name = "Mat_ArchitecturalGlazing";
        meshGlazing.material.baseColorFactor = Vec4(0.06f, 0.09f, 0.12f, 0.95f);
        meshGlazing.material.roughnessFactor = 0.05f;
        meshGlazing.material.metallicFactor = 0.15f;

        meshBronze.material.name = "Mat_StatuaryBronze";
        meshBronze.material.baseColorFactor = Vec4(0.42f, 0.30f, 0.18f, 1.0f);
        meshBronze.material.roughnessFactor = 0.35f;
        meshBronze.material.metallicFactor = 0.85f;

        meshPaverDeck.material.name = "Mat_StonePaverDecking";
        meshPaverDeck.material.baseColorFactor = Vec4(0.55f, 0.54f, 0.50f, 1.0f);
        meshPaverDeck.material.roughnessFactor = 0.78f;
        meshPaverDeck.material.metallicFactor = 0.05f;

        meshSidewalk.material.name = "Mat_ScoredSidewalk";
        meshSidewalk.material.baseColorFactor = Vec4(0.65f, 0.63f, 0.60f, 1.0f);
        meshSidewalk.material.roughnessFactor = 0.85f;
        meshSidewalk.material.metallicFactor = 0.02f;

        meshInterior.material.name = "Mat_LobbyAndInterior";
        meshInterior.material.baseColorFactor = Vec4(0.98f, 0.90f, 0.74f, 1.0f);
        meshInterior.material.roughnessFactor = 0.30f;
        meshInterior.material.metallicFactor = 0.10f;
        meshInterior.material.emissiveFactor = Vec3(0.98f, 0.90f, 0.74f);
        meshInterior.material.emissiveStrength = 2.5f;

        meshMooringMast.material.name = "Mat_MooringMastAndSpire";
        meshMooringMast.material.baseColorFactor = Vec4(0.85f, 0.88f, 0.92f, 1.0f);
        meshMooringMast.material.roughnessFactor = 0.22f;
        meshMooringMast.material.metallicFactor = 0.94f;

        meshTreeTrunk.material.name = "Mat_OakBark";
        meshTreeTrunk.material.baseColorFactor = Vec4(0.32f, 0.25f, 0.20f, 1.0f);
        meshTreeTrunk.material.roughnessFactor = 0.92f;

        meshTreeFoliage.material.name = "Mat_OakFoliage";
        meshTreeFoliage.material.baseColorFactor = Vec4(0.24f, 0.52f, 0.18f, 1.0f);
        meshTreeFoliage.material.roughnessFactor = 0.65f;

        meshDistrict.material.name = "Mat_MidtownDistrict";
        meshDistrict.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
        meshDistrict.material.roughnessFactor = 0.82f;
        meshDistrict.material.metallicFactor = 0.04f;

        std::vector<ScratchboxMesh> subMeshes = {
            std::move(meshLimestone),
            std::move(meshGranite),
            std::move(meshSpandrel),
            std::move(meshSteel),
            std::move(meshGlazing),
            std::move(meshBronze),
            std::move(meshPaverDeck),
            std::move(meshSidewalk),
            std::move(meshInterior),
            std::move(meshMooringMast)
        };
        if (!meshTreeTrunk.vertices.empty())   subMeshes.push_back(std::move(meshTreeTrunk));
        if (!meshTreeFoliage.vertices.empty()) subMeshes.push_back(std::move(meshTreeFoliage));
        if (!meshDistrict.vertices.empty())    subMeshes.push_back(std::move(meshDistrict));

        std::vector<uint8_t> pbrGlbData = GlbWriter::serializeMultiMeshToGlb(subMeshes);
        std::ofstream file(stage3Path, std::ios::binary);
        if (file.is_open()) {
            file.write(reinterpret_cast<const char*>(pbrGlbData.data()), pbrGlbData.size());
            std::cout << "SUCCESS: Wrote " << pbrGlbData.size() << " bytes to " << stage3Path << "\n";
        }
    }

    std::cout << "\n======================================================================\n";
    std::cout << "  HIGH-RISE SYNTHESIS COMPLETE: Both Stage 2 & Stage 3 Updated!       \n";
    std::cout << "======================================================================\n";
    return 0;
}
