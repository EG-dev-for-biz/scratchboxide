#include "scratchbox_engine.hpp"
#include "scratchbox_pbr_manifold.hpp"
#include "scratchbox_gltf_scene.hpp"

#include <iostream>
#include <vector>
#include <cmath>
#include <string>
#include <chrono>
#include <algorithm>
#include <fstream>
#include <map>
#include <unordered_map>
#include <cstdio>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::pbr_manifold;
using namespace scratchbox::texture;
using namespace scratchbox::io;
using namespace scratchbox::gltf;

// ============================================================================
// Core Geometry Helpers
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
        uv0 = { p0.x * scaleU, p0.z * scaleV };
        uv1 = { p1.x * scaleU, p1.z * scaleV };
        uv2 = { p2.x * scaleU, p2.z * scaleV };
        uv3 = { p3.x * scaleU, p3.z * scaleV };
    } else if (std::abs(normal.z) > 0.7f) {
        float signZ = normal.z > 0.0f ? 1.0f : -1.0f;
        uv0 = { signZ * p0.x * scaleU, p0.y * scaleV };
        uv1 = { signZ * p1.x * scaleU, p1.y * scaleV };
        uv2 = { signZ * p2.x * scaleU, p2.y * scaleV };
        uv3 = { signZ * p3.x * scaleU, p3.y * scaleV };
    } else {
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

    Vec3 v001 = center + Vec3(-h.x, -h.y,  h.z);
    Vec3 v101 = center + Vec3( h.x, -h.y,  h.z);
    Vec3 v111 = center + Vec3( h.x,  h.y,  h.z);
    Vec3 v011 = center + Vec3(-h.x,  h.y,  h.z);
    Vec3 v000 = center + Vec3(-h.x, -h.y, -h.z);
    Vec3 v100 = center + Vec3( h.x, -h.y, -h.z);
    Vec3 v110 = center + Vec3( h.x,  h.y, -h.z);
    Vec3 v010 = center + Vec3(-h.x,  h.y, -h.z);

    addOutwardQuad(mesh, v001, v101, v111, v011, Vec3(0, 0, 1), color, scaleU, scaleV);
    addOutwardQuad(mesh, v100, v000, v010, v110, Vec3(0, 0, -1), color, scaleU, scaleV);
    addOutwardQuad(mesh, v000, v001, v011, v010, Vec3(-1, 0, 0), color, scaleU, scaleV);
    addOutwardQuad(mesh, v101, v100, v110, v111, Vec3(1, 0, 0), color, scaleU, scaleV);
    addOutwardQuad(mesh, v011, v111, v110, v010, Vec3(0, 1, 0), color, scaleU, scaleV);
    addOutwardQuad(mesh, v000, v100, v101, v001, Vec3(0, -1, 0), color, scaleU, scaleV);
}

inline void addCylinderMetric(
    ScratchboxMesh& mesh,
    const Vec3& baseCenter,
    float radiusBottom,
    float radiusTop,
    float height,
    int segments,
    const Vec4& color,
    float scaleU = 1.0f,
    float scaleV = 1.0f
) {
    uint32_t startIdx = static_cast<uint32_t>(mesh.vertices.size());
    float dTheta = (2.0f * 3.14159265f) / static_cast<float>(segments);

    for (int i = 0; i <= segments; ++i) {
        float theta = static_cast<float>(i) * dTheta;
        float cosT = std::cos(theta);
        float sinT = std::sin(theta);

        Vec3 pBot = baseCenter + Vec3(radiusBottom * cosT, 0.0f, radiusBottom * sinT);
        Vec3 pTop = baseCenter + Vec3(radiusTop * cosT, height, radiusTop * sinT);

        Vec3 sideNormal = Vec3(cosT, (radiusBottom - radiusTop) / height, sinT).normalized();

        float u = (static_cast<float>(i) / static_cast<float>(segments)) * scaleU;
        mesh.addVertex({pBot, sideNormal, Vec2(u, 0.0f), color});
        mesh.addVertex({pTop, sideNormal, Vec2(u, height * scaleV), color});
    }

    for (int i = 0; i < segments; ++i) {
        uint32_t b0 = startIdx + static_cast<uint32_t>(i * 2);
        uint32_t t0 = b0 + 1;
        uint32_t b1 = b0 + 2;
        uint32_t t1 = b0 + 3;

        mesh.addTriangle(b0, b1, t0);
        mesh.addTriangle(b1, t1, t0);
    }
}

// ============================================================================
// Adaptive Domain Architecture (ADA): Differential Tangent-Plane Facade Grammar
// In accordance with ADA Pillars 1, 2, & 8: Zero closed taxonomies, zero street
// enums, continuous normal/tangent frame transformations for arbitrary geometry.
// ============================================================================

struct TangentPlaneFacade {
    Vec3 origin;      // Base anchor in world space
    Vec3 tangent;     // Unit horizontal tangent (+s direction along wall)
    Vec3 bitangent;   // Unit vertical bitangent (+y direction)
    Vec3 normal;      // Unit outward surface normal (+forward direction, perpendicular to wall)
    float length;     // Metric span along tangent
    float height;     // Metric vertical height

    inline Vec3 localToWorld(float s, float y, float forwardOffset = 0.0f) const {
        return origin + tangent * s + bitangent * y + normal * forwardOffset;
    }
};

inline void addOrientedQuad(
    ScratchboxMesh& mesh,
    const Vec3& p0, const Vec3& p1, const Vec3& p2, const Vec3& p3,
    const Vec3& targetNormal,
    const Vec4& color,
    float scaleU = 1.0f, float scaleV = 1.0f
) {
    Vec3 crossP = (p1 - p0).cross(p3 - p0);
    if (crossP.dot(targetNormal) >= 0.0f) {
        addOutwardQuad(mesh, p0, p1, p2, p3, targetNormal, color, scaleU, scaleV);
    } else {
        addOutwardQuad(mesh, p1, p0, p3, p2, targetNormal, color, scaleU, scaleV);
    }
}

inline void addOrientedBoxMetric(
    ScratchboxMesh& mesh,
    const Vec3& center,
    const Vec3& axisU, // tangent
    const Vec3& axisV, // bitangent
    const Vec3& axisW, // normal
    float sizeU, float sizeV, float sizeW,
    const Vec4& color,
    float scaleU = 1.0f, float scaleV = 1.0f
) {
    Vec3 hU = axisU * (sizeU * 0.5f);
    Vec3 hV = axisV * (sizeV * 0.5f);
    Vec3 hW = axisW * (sizeW * 0.5f);

    // Front (+W)
    addOrientedQuad(mesh, center + hW - hU - hV, center + hW + hU - hV, center + hW + hU + hV, center + hW - hU + hV, axisW, color, scaleU, scaleV);
    // Back (-W)
    addOrientedQuad(mesh, center - hW + hU - hV, center - hW - hU - hV, center - hW - hU + hV, center - hW + hU + hV, -axisW, color, scaleU, scaleV);
    // Right (+U)
    addOrientedQuad(mesh, center + hU + hW - hV, center + hU - hW - hV, center + hU - hW + hV, center + hU + hW + hV, axisU, color, scaleU, scaleV);
    // Left (-U)
    addOrientedQuad(mesh, center - hU - hW - hV, center - hU + hW - hV, center - hU + hW + hV, center - hU - hW + hV, -axisU, color, scaleU, scaleV);
    // Top (+V)
    addOrientedQuad(mesh, center + hV - hU + hW, center + hV + hU + hW, center + hV + hU - hW, center + hV - hU - hW, axisV, color, scaleU, scaleV);
    // Bottom (-V)
    addOrientedQuad(mesh, center - hV - hU - hW, center - hV + hU - hW, center - hV + hU + hW, center - hV - hU + hW, -axisV, color, scaleU, scaleV);
}

inline void addProjectingPier(
    ScratchboxMesh& meshLimestone,
    const TangentPlaneFacade& facade,
    float s0, float s1,
    float y0, float y1,
    float pierDepth,
    const Vec4& colLimestone
) {
    float pierWidth = s1 - s0;
    float pierHeight = y1 - y0;
    float sMid = (s0 + s1) * 0.5f;
    float yMid = (y0 + y1) * 0.5f;

    Vec3 center = facade.localToWorld(sMid, yMid, pierDepth * 0.5f);
    addOrientedBoxMetric(meshLimestone, center, facade.tangent, facade.bitangent, facade.normal, pierWidth, pierHeight, pierDepth, colLimestone, 1.0f / 2.0f, 1.0f / 3.0f);
}

inline void addApertureWindowBay(
    ScratchboxMesh& meshLimestone,
    ScratchboxMesh& meshGlazing,
    ScratchboxMesh& meshSpandrel,
    ScratchboxMesh& meshSteel,
    const TangentPlaneFacade& facade,
    float s0, float s1,
    float yFloor, float yCeiling,
    float hSpandrel,
    float hSill,
    float hLintel,
    float dRecess,
    int windowCount,
    const Vec4& colLimestone,
    const Vec4& colGlazing,
    const Vec4& colSpandrel,
    const Vec4& colSteel
) {
    float ySpandrelBase = yFloor;
    float ySpandrelTop  = yFloor + hSpandrel;
    float ySillBase     = ySpandrelTop;
    float yWinBase      = ySillBase + hSill;
    float yWinTop       = yCeiling - hLintel;
    float yLintel       = yWinTop;
    float hWin          = yWinTop - yWinBase;
    float sLen          = s1 - s0;

    // 1. Spandrel
    Vec3 spCenter = facade.localToWorld((s0 + s1) * 0.5f, (ySpandrelBase + ySpandrelTop) * 0.5f, -dRecess * 0.5f);
    addOrientedBoxMetric(meshSpandrel, spCenter, facade.tangent, facade.bitangent, facade.normal, sLen, hSpandrel, dRecess * 0.8f, colSpandrel, 1.0f / 1.5f, 1.0f / 1.0f);

    // 2. Sill
    Vec3 sillCenter = facade.localToWorld((s0 + s1) * 0.5f, ySillBase + hSill * 0.5f, -dRecess * 0.3f);
    addOrientedBoxMetric(meshLimestone, sillCenter, facade.tangent, facade.bitangent, facade.normal, sLen, hSill, dRecess * 0.6f, colLimestone, 1.0f / 2.0f, 1.0f / 0.5f);

    // 3. Glazing Quads
    float fGlass = -dRecess;
    float winWidth = (sLen - (windowCount - 1) * 0.18f) / static_cast<float>(windowCount);

    for (int w = 0; w < windowCount; ++w) {
        float ws0 = s0 + static_cast<float>(w) * (winWidth + 0.18f);
        float ws1 = ws0 + winWidth;

        Vec3 g0 = facade.localToWorld(ws0, yWinBase, fGlass);
        Vec3 g1 = facade.localToWorld(ws1, yWinBase, fGlass);
        Vec3 g2 = facade.localToWorld(ws1, yWinTop, fGlass);
        Vec3 g3 = facade.localToWorld(ws0, yWinTop, fGlass);

        addOrientedQuad(meshGlazing, g0, g1, g2, g3, facade.normal, colGlazing, 1.0f / 1.5f, 1.0f / 2.2f);

        if (w < windowCount - 1) {
            float ms0 = ws1;
            float ms1 = ms0 + 0.18f;
            Vec3 mulCenter = facade.localToWorld((ms0 + ms1) * 0.5f, (yWinBase + yWinTop) * 0.5f, fGlass + 0.04f);
            addOrientedBoxMetric(meshSteel, mulCenter, facade.tangent, facade.bitangent, facade.normal, 0.18f, hWin, 0.10f, colSteel, 1.0f / 0.3f, 1.0f / 2.0f);
        }
    }

    // 4. Reveal Returns
    Vec3 jL0 = facade.localToWorld(s0, yWinBase, fGlass);
    Vec3 jL1 = facade.localToWorld(s0, yWinBase, 0.0f);
    Vec3 jL2 = facade.localToWorld(s0, yWinTop, 0.0f);
    Vec3 jL3 = facade.localToWorld(s0, yWinTop, fGlass);
    addOrientedQuad(meshLimestone, jL0, jL1, jL2, jL3, facade.tangent, colLimestone, 1.0f / 0.5f, 1.0f / 2.0f);

    Vec3 jR0 = facade.localToWorld(s1, yWinBase, 0.0f);
    Vec3 jR1 = facade.localToWorld(s1, yWinBase, fGlass);
    Vec3 jR2 = facade.localToWorld(s1, yWinTop, fGlass);
    Vec3 jR3 = facade.localToWorld(s1, yWinTop, 0.0f);
    addOrientedQuad(meshLimestone, jR0, jR1, jR2, jR3, -facade.tangent, colLimestone, 1.0f / 0.5f, 1.0f / 2.0f);

    // 5. Head Beam / Lintel
    if (hLintel > 0.05f) {
        Vec3 lintelCenter = facade.localToWorld((s0 + s1) * 0.5f, yLintel + hLintel * 0.5f, -dRecess * 0.5f);
        addOrientedBoxMetric(meshLimestone, lintelCenter, facade.tangent, facade.bitangent, facade.normal, sLen, hLintel, dRecess, colLimestone, 1.0f / 2.0f, 1.0f / 0.8f);
    }
}

// ============================================================================
// MAIN GENERATOR
// ============================================================================

int main(int argc, char** argv) {
    std::cout << "======================================================================\n";
    std::cout << "SCRATCHBOX OMNISPATIAL MASTER SUITE GENERATOR (4-SIDED ART DECO)\n";
    std::cout << "1. Stage 1: Authentic Google 3D Tile in 18% Studio Grey Clay\n";
    std::cout << "2. Stage 2: 4-Sided Vector-Refined Geometry + SB-Veggie Trees in Clay\n";
    std::cout << "3. Stage 3: Master Hyper-Realistic PBR Model with Photogrammetric City\n";
    std::cout << "======================================================================\n";

    auto totalStart = std::chrono::high_resolution_clock::now();

    // ------------------------------------------------------------------------
    // A. Load Authentic Google 3D Tile Mesh
    // ------------------------------------------------------------------------
    std::string rawTileGlb = "public/models/spce_scan_studio_cleaned_pbr.glb";
    std::cout << "\n[Step 1/5] Ingesting Authentic Google 3D Tile: " << rawTileGlb << "...\n";
    GltfScene tileScene = GlbSceneReader::readFile(rawTileGlb);
    if (!tileScene.ok) {
        std::cerr << "ERROR: Failed to load raw tile: " << tileScene.error << "\n";
        return 1;
    }
    std::cout << "Loaded Tile: " << tileScene.mesh.vertices.size() << " vertices, " 
              << (tileScene.mesh.indices.size() / 3) << " triangles, "
              << tileScene.materials.size() << " materials, "
              << tileScene.images.size() << " images.\n";

    // ------------------------------------------------------------------------
    // B. Export Stage 1: Authentic Google 3D Tile in 18% Studio Grey Clay
    // ------------------------------------------------------------------------
    std::string stage1Path = "public/models/omnispatial_stage1_real_clay_tile.glb";
    std::cout << "\n[Step 2/5] Building Stage 1 (Raw Photogrammetric Scan in Studio Grey Clay)...\n";
    {
        ScratchboxMesh clayMesh = tileScene.mesh;
        clayMesh.name = "Google3DTile_StudioGreyClay";
        clayMesh.material.name = "Mat_StudioGreyClay";
        clayMesh.material.baseColorFactor = Vec4(0.55f, 0.57f, 0.60f, 1.0f);
        clayMesh.material.roughnessFactor = 0.85f;
        clayMesh.material.metallicFactor = 0.0f;
        clayMesh.material.emissiveFactor = Vec3(0.0f, 0.0f, 0.0f);

        for (auto& v : clayMesh.vertices) {
            v.color = Vec4(0.55f, 0.57f, 0.60f, 1.0f);
        }

        bool ok = GlbWriter::writeToFile(clayMesh, stage1Path);
        if (ok) {
            std::cout << "SUCCESS: Wrote Stage 1 Clay Tile to " << stage1Path << " (" 
                      << (clayMesh.indices.size() / 3) << " triangles)\n";
        }
    }

    // ------------------------------------------------------------------------
    // C. Extract Surrounding Midtown Manhattan District Geometry & Bake Colors
    // ------------------------------------------------------------------------
    std::cout << "\n[Step 3/5] Extracting Surrounding City District & Baking Photogrammetric Colors...\n";
    ScratchboxMesh meshDistrict;
    meshDistrict.name = "MidtownManhattan_SurroundingDistrict";
    meshDistrict.material.name = "Mat_MidtownDistrict";
    meshDistrict.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
    meshDistrict.material.roughnessFactor = 0.82f;
    meshDistrict.material.metallicFactor = 0.04f;

    const auto& tileIndices = tileScene.mesh.indices;
    const auto& tileVerts = tileScene.mesh.vertices;
    size_t districtTris = 0;
    size_t esbTris = 0;

    // District triangles keep their original tile material, UVs and shared vertices, so
    // Stage 3 can re-embed the authentic photogrammetric textures instead of three
    // corner color samples per triangle.
    std::map<uint32_t, ScratchboxMesh> districtByMaterial;
    std::map<uint32_t, std::unordered_map<uint32_t, uint32_t>> districtRemap;
    std::unordered_map<uint32_t, uint32_t> clayRemap;
    auto remapInto = [&](ScratchboxMesh& dst, std::unordered_map<uint32_t, uint32_t>& remap, uint32_t src) {
        auto it = remap.find(src);
        if (it != remap.end()) return it->second;
        Vertex v = tileVerts[src];
        v.color = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
        uint32_t idx = static_cast<uint32_t>(dst.vertices.size());
        dst.addVertex(v);
        remap.emplace(src, idx);
        return idx;
    };

    for (size_t i = 0; i < tileIndices.size(); i += 3) {
        const Vertex& v0 = tileVerts[tileIndices[i]];
        const Vertex& v1 = tileVerts[tileIndices[i + 1]];
        const Vertex& v2 = tileVerts[tileIndices[i + 2]];

        float cx = (v0.position.x + v1.position.x + v2.position.x) / 3.0f;
        float cz = (v0.position.z + v1.position.z + v2.position.z) / 3.0f;

        // Bounding box for Empire State Building parcel (centered at 0,0)
        if (cx >= -65.0f && cx <= 65.0f && cz >= -46.0f && cz <= 46.0f) {
            esbTris++;
            continue;
        }
        districtTris++;
        uint32_t matIdx = (i / 3 < tileScene.triangleMaterial.size()) ? tileScene.triangleMaterial[i / 3] : 0;
        ScratchboxMesh& chunk = districtByMaterial[matIdx];
        auto& remap = districtRemap[matIdx];
        uint32_t c0 = remapInto(chunk, remap, tileIndices[i]);
        uint32_t c1 = remapInto(chunk, remap, tileIndices[i + 1]);
        uint32_t c2 = remapInto(chunk, remap, tileIndices[i + 2]);
        chunk.addTriangle(c0, c1, c2);
        meshDistrict.addTriangle(remapInto(meshDistrict, clayRemap, tileIndices[i]),
                                 remapInto(meshDistrict, clayRemap, tileIndices[i + 1]),
                                 remapInto(meshDistrict, clayRemap, tileIndices[i + 2]));
    }
    std::cout << "Preserved Surrounding District: " << districtTris << " triangles (" 
              << meshDistrict.vertices.size() << " shared vertices, "
              << districtByMaterial.size() << " photogrammetric texture chunks)\n";

    // ------------------------------------------------------------------------
    // D. Load Botanical Oak Tree from SB-Veggie
    // ------------------------------------------------------------------------
    std::string oakGlb = "public/models/sb_veggie_oak.glb";
    std::cout << "\n[Step 4/5] Loading SB-Veggie Botanical Oak Tree: " << oakGlb << "...\n";
    GltfScene oakScene = GlbSceneReader::readFile(oakGlb);

    ScratchboxMesh meshTreeTrunk;
    meshTreeTrunk.name = "SBVeggie_OakTrunks";
    meshTreeTrunk.material.name = "Mat_OakBark";
    meshTreeTrunk.material.baseColorFactor = Vec4(0.38f, 0.32f, 0.25f, 1.0f);
    meshTreeTrunk.material.roughnessFactor = 0.88f;
    meshTreeTrunk.material.metallicFactor = 0.0f;

    ScratchboxMesh meshTreeFoliage;
    meshTreeFoliage.name = "SBVeggie_OakFoliage";
    meshTreeFoliage.material.name = "Mat_OakFoliage";
    meshTreeFoliage.material.baseColorFactor = Vec4(0.24f, 0.42f, 0.12f, 1.0f);
    meshTreeFoliage.material.roughnessFactor = 0.65f;
    meshTreeFoliage.material.metallicFactor = 0.0f;

    if (oakScene.ok) {
        struct TreeInstance {
            Vec3 pos;
            float scale;
            float rotY;
        };
        std::vector<TreeInstance> treeInstances = {
            // 5th Avenue Sidewalk (X = 45.0m)
            { Vec3(45.0f, 0.0f, -32.0f), 0.62f, 0.3f },
            { Vec3(45.0f, 0.0f, -20.0f), 0.68f, 1.2f },
            { Vec3(45.0f, 0.0f,  -8.0f), 0.65f, 2.4f },
            { Vec3(45.0f, 0.0f,   8.0f), 0.60f, 0.8f },
            { Vec3(45.0f, 0.0f,  20.0f), 0.66f, 1.9f },
            { Vec3(45.0f, 0.0f,  32.0f), 0.64f, 3.1f },
            // 34th Street Sidewalk (Z = -43.0m)
            { Vec3(-35.0f, 0.0f, -43.0f), 0.65f, 0.5f },
            { Vec3(-20.0f, 0.0f, -43.0f), 0.62f, 1.7f },
            { Vec3( -5.0f, 0.0f, -43.0f), 0.67f, 2.8f },
            { Vec3( 10.0f, 0.0f, -43.0f), 0.64f, 0.2f },
            { Vec3( 25.0f, 0.0f, -43.0f), 0.66f, 1.4f },
            // 33rd Street Sidewalk (Z = 43.0m)
            { Vec3(-35.0f, 0.0f,  43.0f), 0.63f, 0.7f },
            { Vec3(-20.0f, 0.0f,  43.0f), 0.67f, 1.9f },
            { Vec3( -5.0f, 0.0f,  43.0f), 0.65f, 3.0f },
            { Vec3( 10.0f, 0.0f,  43.0f), 0.62f, 0.4f },
            { Vec3( 25.0f, 0.0f,  43.0f), 0.66f, 1.6f }
        };

        const auto& oakIndices = oakScene.mesh.indices;
        const auto& oakVerts = oakScene.mesh.vertices;

        for (const auto& inst : treeInstances) {
            float cosR = std::cos(inst.rotY);
            float sinR = std::sin(inst.rotY);

            for (size_t i = 0; i < oakIndices.size(); i += 3) {
                uint32_t matIdx = (i / 3 < oakScene.triangleMaterial.size()) ? oakScene.triangleMaterial[i / 3] : 0;
                ScratchboxMesh& targetMesh = (matIdx == 1) ? meshTreeFoliage : meshTreeTrunk;

                uint32_t b = static_cast<uint32_t>(targetMesh.vertices.size());
                for (int vi = 0; vi < 3; ++vi) {
                    Vertex v = oakVerts[oakIndices[i + vi]];
                    float rx = (v.position.x * cosR - v.position.z * sinR) * inst.scale;
                    float rz = (v.position.x * sinR + v.position.z * cosR) * inst.scale;
                    float ry = v.position.y * inst.scale;
                    v.position = Vec3(rx, ry, rz) + inst.pos;

                    float rnx = v.normal.x * cosR - v.normal.z * sinR;
                    float rnz = v.normal.x * sinR + v.normal.z * cosR;
                    v.normal = Vec3(rnx, v.normal.y, rnz).normalized();

                    targetMesh.addVertex(v);
                }
                targetMesh.addTriangle(b, b + 1, b + 2);
            }
        }
        std::cout << "Instanced " << treeInstances.size() << " SB-Veggie Oak Trees\n";
    }

    // ------------------------------------------------------------------------
    // E. Synthesize 4-Sided Art Deco Hero Architecture
    // ------------------------------------------------------------------------
    std::cout << "\n[Step 5/5] Synthesizing 4-Sided Art Deco Architectural Geometry...\n";

    Vec4 colLimestone(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colGranite(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colSpandrel(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colSteel(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colGlazing(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colBronze(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colRoof(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colSidewalk(1.0f, 1.0f, 1.0f, 1.0f);
    Vec4 colInterior(1.0f, 1.0f, 1.0f, 1.0f);

    ScratchboxMesh meshLimestone;  meshLimestone.name = "Hero_IndianaLimestone";
    ScratchboxMesh meshGranite;    meshGranite.name = "Hero_CharcoalGranitePlinth";
    ScratchboxMesh meshSpandrel;   meshSpandrel.name = "Hero_ArtDecoSpandrels";
    ScratchboxMesh meshSteel;      meshSteel.name = "Hero_StainlessSteel";
    ScratchboxMesh meshGlazing;    meshGlazing.name = "Hero_ArchitecturalGlazing";
    ScratchboxMesh meshBronze;     meshBronze.name = "Hero_StatuaryBronze";
    ScratchboxMesh meshRoof;       meshRoof.name = "Hero_BitumenRoofBallast";
    ScratchboxMesh meshSidewalk;   meshSidewalk.name = "Hero_ScoredSidewalkApron";
    ScratchboxMesh meshInterior;   meshInterior.name = "Hero_GrandLobbyInterior";
    ScratchboxMesh meshTileSpire;  meshTileSpire.name = "Hero_MooringMastAndSpire";

    // 1. Foundation & Sidewalk (centered at 0,0)
    addBoxMetric(meshSidewalk, Vec3(0.0f, -0.075f, 0.0f), Vec3(110.0f, 0.15f, 96.0f), colSidewalk, 1.0f / 2.0f, 1.0f / 2.0f);

    const float xEast = 40.0f;
    const float xWest = -40.0f;
    const float zSouth = 36.0f;
    const float zNorth = -36.0f;
    const float baseCenterX = 0.0f;
    const float baseCenterZ = 0.0f;
    const float baseW = xEast - xWest; // 80.0m
    const float baseD = zSouth - zNorth; // 72.0m

    // Granite Plinth (Y = 0 to 1.5m)
    addBoxMetric(meshGranite, Vec3(baseCenterX, 0.75f, baseCenterZ), Vec3(baseW, 1.5f, baseD), colGranite, 1.0f / 2.0f, 1.0f / 1.0f);

    // Elevator Core & Floor Slabs
    addBoxMetric(meshRoof, Vec3(0.0f, 160.0f, 0.0f), Vec3(26.0f, 320.0f, 24.0f), colRoof, 1.0f / 4.0f, 1.0f / 4.0f);

    for (float ySlab = 4.8f; ySlab <= 24.0f; ySlab += 4.8f) {
        addBoxMetric(meshRoof, Vec3(0.0f, ySlab - 0.15f, 0.0f), Vec3(78.0f, 0.30f, 70.0f), colRoof, 1.0f / 4.0f, 1.0f / 4.0f);
    }
    for (float ySlab = 28.0f; ySlab <= 96.0f; ySlab += 3.6f) {
        addBoxMetric(meshRoof, Vec3(0.0f, ySlab - 0.15f, 0.0f), Vec3(72.0f, 0.30f, 64.0f), colRoof, 1.0f / 4.0f, 1.0f / 4.0f);
    }

    // 2. 5th Avenue 3-Story Grand Entrance Portico (centered at Z = 0)
    addBoxMetric(meshLimestone, Vec3(xEast + 0.35f, 7.8f, -10.0f), Vec3(0.70f, 12.6f, 2.0f), colLimestone, 1.0f / 1.0f, 1.0f / 3.0f);
    addBoxMetric(meshLimestone, Vec3(xEast + 0.35f, 7.8f,  10.0f), Vec3(0.70f, 12.6f, 2.0f), colLimestone, 1.0f / 1.0f, 1.0f / 3.0f);
    addBoxMetric(meshLimestone, Vec3(xEast + 0.40f, 13.1f, 0.0f), Vec3(0.80f, 2.0f, 22.0f), colLimestone, 1.0f / 3.0f, 1.0f / 1.0f);

    addBoxMetric(meshLimestone, Vec3(xEast + 0.35f, 7.8f, -3.2f), Vec3(0.70f, 12.6f, 1.1f), colLimestone, 1.0f / 1.0f, 1.0f / 3.0f);
    addBoxMetric(meshLimestone, Vec3(xEast + 0.35f, 7.8f,  3.2f), Vec3(0.70f, 12.6f, 1.1f), colLimestone, 1.0f / 1.0f, 1.0f / 3.0f);

    // Bronze Revolving Doors & Cast Transoms
    addBoxMetric(meshBronze, Vec3(xEast + 0.12f, 1.6f, 0.0f), Vec3(0.24f, 3.2f, 4.2f), colBronze, 1.0f / 1.0f, 1.0f / 1.0f);
    addBoxMetric(meshBronze, Vec3(xEast + 0.12f, 1.6f, -6.6f), Vec3(0.24f, 3.2f, 4.2f), colBronze, 1.0f / 1.0f, 1.0f / 1.0f);
    addBoxMetric(meshBronze, Vec3(xEast + 0.12f, 1.6f,  6.6f), Vec3(0.24f, 3.2f, 4.2f), colBronze, 1.0f / 1.0f, 1.0f / 1.0f);

    addBoxMetric(meshBronze, Vec3(xEast + 0.10f, 7.6f, 0.0f), Vec3(0.20f, 8.8f, 4.4f), colBronze, 1.0f / 1.0f, 1.0f / 2.0f);
    addBoxMetric(meshBronze, Vec3(xEast + 0.10f, 7.6f, -6.6f), Vec3(0.20f, 8.8f, 4.4f), colBronze, 1.0f / 1.0f, 1.0f / 2.0f);
    addBoxMetric(meshBronze, Vec3(xEast + 0.10f, 7.6f,  6.6f), Vec3(0.20f, 8.8f, 4.4f), colBronze, 1.0f / 1.0f, 1.0f / 2.0f);

    // Grand Lobby Interior Backing
    addBoxMetric(meshInterior, Vec3(31.4f, 6.75f, 0.0f), Vec3(17.2f, 13.5f, 14.0f), colInterior, 1.0f / 2.0f, 1.0f / 2.0f);

    // 33rd & 34th Street Marquee Entrance Canopies (centered at X = 0)
    auto addMarqueeCanopy = [&](float xCenter, float zWall, float forwardSign) {
        float canW = 14.0f, canD = 3.2f, canH = 0.65f, yCan = 4.4f;
        Vec3 center(xCenter, yCan, zWall + forwardSign * canD * 0.5f);
        addBoxMetric(meshBronze, center, Vec3(canW, canH, canD), colBronze, 1.0f / 2.0f, 1.0f / 0.5f);
        addBoxMetric(meshSteel, center + Vec3(0.0f, 0.0f, forwardSign * (canD * 0.5f + 0.02f)), Vec3(canW + 0.1f, canH * 0.45f, 0.06f), colSteel, 1.0f / 2.0f, 1.0f / 0.2f);
        addBoxMetric(meshBronze, Vec3(xCenter, 2.0f, zWall - forwardSign * 0.15f), Vec3(canW - 2.0f, 4.0f, 0.45f), colBronze, 1.0f / 2.0f, 1.0f / 2.0f);
        addBoxMetric(meshGlazing, Vec3(xCenter, 2.0f, zWall + forwardSign * 0.06f), Vec3(canW - 3.2f, 3.2f, 0.08f), colGlazing, 1.0f / 1.5f, 1.0f / 2.0f);
    };
    addMarqueeCanopy(0.0f, zNorth, -1.0f);
    addMarqueeCanopy(0.0f, zSouth, 1.0f);

    // 5-Story Base Facade (Y = 1.5m to 25.0m)
    addBoxMetric(meshGlazing, Vec3(xEast + 0.05f, 3.15f, -19.25f), Vec3(0.12f, 3.3f, 22.5f), colGlazing, 1.0f / 2.0f, 1.0f / 2.0f);
    addBoxMetric(meshGlazing, Vec3(xEast + 0.05f, 3.15f,  19.25f), Vec3(0.12f, 3.3f, 22.5f), colGlazing, 1.0f / 2.0f, 1.0f / 2.0f);

    std::vector<std::pair<float, float>> base5thAveBays = {
        {-31.0f, -24.0f}, {-22.5f, -15.5f}, {-14.0f, -7.5f},
        { 7.5f,  14.0f},  { 15.5f,  22.5f},  { 24.0f, 31.0f}
    };
    std::vector<std::pair<float, float>> base5thAvePiers = {
        {-35.0f, -31.0f}, {-24.0f, -22.5f}, {-15.5f, -14.0f}, {-7.5f, -6.0f},
        { 6.0f,   7.5f},  { 14.0f,  15.5f},  { 22.5f,  24.0f}, { 31.0f, 35.0f}
    };

    // Base 4-Sided Facades (Y = 1.5 to 25.0m)
    TangentPlaneFacade baseFacadeEast { Vec3(xEast, 0.0f, 0.0f), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3( 1, 0, 0), baseD, 25.0f };
    TangentPlaneFacade baseFacadeWest { Vec3(xWest, 0.0f, 0.0f), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3(-1, 0, 0), baseD, 25.0f };

    for (const auto& pr : base5thAvePiers) {
        addProjectingPier(meshLimestone, baseFacadeEast, pr.first, pr.second, 5.2f, 25.0f, 0.45f, colLimestone);
        addProjectingPier(meshLimestone, baseFacadeWest, pr.first, pr.second, 5.2f, 25.0f, 0.45f, colLimestone);
    }
    for (float yF = 5.2f; yF < 24.0f; yF += 4.8f) {
        for (const auto& bay : base5thAveBays) {
            addApertureWindowBay(
                meshLimestone, meshGlazing, meshSpandrel, meshSteel,
                baseFacadeEast, bay.first, bay.second,
                yF, yF + 4.8f, 1.1f, 0.20f, 0.40f, 0.35f, 3,
                colLimestone, colGlazing, colSpandrel, colSteel
            );
            addApertureWindowBay(
                meshLimestone, meshGlazing, meshSpandrel, meshSteel,
                baseFacadeWest, bay.first, bay.second,
                yF, yF + 4.8f, 1.1f, 0.20f, 0.40f, 0.35f, 3,
                colLimestone, colGlazing, colSpandrel, colSteel
            );
        }
    }

    // Setback Parapet Coping on Floor 5 (Y = 25.0m) (centered at 0,0)
    addBoxMetric(meshRoof, Vec3(0.0f, 25.1f, 0.0f), Vec3(baseW, 0.20f, baseD), colRoof, 1.0f / 3.0f, 1.0f / 3.0f);
    addBoxMetric(meshLimestone, Vec3(0.0f, 25.7f, zNorth + 0.4f), Vec3(baseW, 1.2f, 0.8f), colLimestone, 1.0f / 2.0f, 1.0f / 1.0f);
    addBoxMetric(meshLimestone, Vec3(0.0f, 25.7f, zSouth - 0.4f), Vec3(baseW, 1.2f, 0.8f), colLimestone, 1.0f / 2.0f, 1.0f / 1.0f);
    addBoxMetric(meshLimestone, Vec3(xEast - 0.4f, 25.7f, 0.0f), Vec3(0.8f, 1.2f, baseD), colLimestone, 1.0f / 2.0f, 1.0f / 1.0f);
    addBoxMetric(meshLimestone, Vec3(xWest + 0.4f, 25.7f, 0.0f), Vec3(0.8f, 1.2f, baseD), colLimestone, 1.0f / 2.0f, 1.0f / 1.0f);

    // Floors 6 to 29 (Y = 25.0m to 96.0m) - 4-SIDED FENESTRATION (centered at 0,0)
    const float xEastT1 = 37.0f;
    const float xWestT1 = -37.0f;
    const float zSouthT1 = 33.0f;
    const float zNorthT1 = -33.0f;

    TangentPlaneFacade t1FacadeEast { Vec3(xEastT1, 0.0f, 0.0f), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3( 1, 0, 0), 66.0f, 71.0f };
    TangentPlaneFacade t1FacadeWest { Vec3(xWestT1, 0.0f, 0.0f), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3(-1, 0, 0), 66.0f, 71.0f };
    TangentPlaneFacade t1FacadeNorth{ Vec3(0.0f, 0.0f, zNorthT1), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, -1), 74.0f, 71.0f };
    TangentPlaneFacade t1FacadeSouth{ Vec3(0.0f, 0.0f, zSouthT1), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0,  1), 74.0f, 71.0f };

    // East & West (along Z: -33 to 33)
    std::vector<std::pair<float, float>> t1BaysZ = {
        {-28.0f, -20.0f}, {-15.0f, -7.0f}, { 7.0f, 15.0f}, {20.0f, 28.0f}
    };
    std::vector<std::pair<float, float>> t1PiersZ = {
        {-33.0f, -28.0f}, {-20.0f, -15.0f}, {-7.0f, 7.0f}, {15.0f, 20.0f}, {28.0f, 33.0f}
    };

    // North & South (along X: -37 to 37)
    std::vector<std::pair<float, float>> t1BaysX = {
        {-32.0f, -24.0f}, {-18.0f, -10.0f}, {-4.0f, 4.0f}, {10.0f, 18.0f}, {24.0f, 32.0f}
    };
    std::vector<std::pair<float, float>> t1PiersX = {
        {-37.0f, -32.0f}, {-24.0f, -18.0f}, {-10.0f, -4.0f}, {4.0f, 10.0f}, {18.0f, 24.0f}, {32.0f, 37.0f}
    };

    // Piers Tier 1
    for (const auto& pr : t1PiersZ) {
        addProjectingPier(meshLimestone, t1FacadeEast, pr.first, pr.second, 25.0f, 96.0f, 0.45f, colLimestone);
        addProjectingPier(meshLimestone, t1FacadeWest, pr.first, pr.second, 25.0f, 96.0f, 0.45f, colLimestone);
    }
    for (const auto& pr : t1PiersX) {
        addProjectingPier(meshLimestone, t1FacadeNorth, pr.first, pr.second, 25.0f, 96.0f, 0.45f, colLimestone);
        addProjectingPier(meshLimestone, t1FacadeSouth, pr.first, pr.second, 25.0f, 96.0f, 0.45f, colLimestone);
    }

    // Windows Tier 1
    for (float yF = 25.0f; yF < 94.0f; yF += 3.6f) {
        for (const auto& bay : t1BaysZ) {
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, t1FacadeEast, bay.first, bay.second, yF, yF + 3.6f, 0.90f, 0.15f, 0.30f, 0.35f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, t1FacadeWest, bay.first, bay.second, yF, yF + 3.6f, 0.90f, 0.15f, 0.30f, 0.35f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
        }
        for (const auto& bay : t1BaysX) {
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, t1FacadeNorth, bay.first, bay.second, yF, yF + 3.6f, 0.90f, 0.15f, 0.30f, 0.35f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, t1FacadeSouth, bay.first, bay.second, yF, yF + 3.6f, 0.90f, 0.15f, 0.30f, 0.35f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
        }
    }

    // Floors 30 to 85 Main Tower (Y = 96.0m to 320.0m) - 4-SIDED FENESTRATION (matches real scan: X in [-33.5, 33.5], Z in [-31, 31])
    const float xEastT2 = 33.5f;
    const float xWestT2 = -33.5f;
    const float zSouthT2 = 31.0f;
    const float zNorthT2 = -31.0f;

    TangentPlaneFacade t2FacadeEast { Vec3(xEastT2, 0.0f, 0.0f), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3( 1, 0, 0), 62.0f, 224.0f };
    TangentPlaneFacade t2FacadeWest { Vec3(xWestT2, 0.0f, 0.0f), Vec3(0, 0, 1), Vec3(0, 1, 0), Vec3(-1, 0, 0), 62.0f, 224.0f };
    TangentPlaneFacade t2FacadeNorth{ Vec3(0.0f, 0.0f, zNorthT2), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0, -1), 67.0f, 224.0f };
    TangentPlaneFacade t2FacadeSouth{ Vec3(0.0f, 0.0f, zSouthT2), Vec3(1, 0, 0), Vec3(0, 1, 0), Vec3(0, 0,  1), 67.0f, 224.0f };

    // East & West (along Z: -31 to 31)
    std::vector<std::pair<float, float>> t2BaysZ = {
        {-25.0f, -17.0f}, {-11.0f, -3.0f}, { 3.0f, 11.0f}, {17.0f, 25.0f}
    };
    std::vector<std::pair<float, float>> t2PiersZ = {
        {-31.0f, -25.0f}, {-17.0f, -11.0f}, {-3.0f, 3.0f}, {11.0f, 17.0f}, {25.0f, 31.0f}
    };

    // North & South (along X: -33.5 to 33.5)
    std::vector<std::pair<float, float>> t2BaysX = {
        {-27.0f, -19.0f}, {-13.0f, -5.0f}, {5.0f, 13.0f}, {19.0f, 27.0f}
    };
    std::vector<std::pair<float, float>> t2PiersX = {
        {-33.5f, -27.0f}, {-19.0f, -13.0f}, {-5.0f, 5.0f}, {13.0f, 19.0f}, {27.0f, 33.5f}
    };

    // Piers Tier 2
    for (const auto& pr : t2PiersZ) {
        addProjectingPier(meshLimestone, t2FacadeEast, pr.first, pr.second, 96.0f, 320.0f, 0.45f, colLimestone);
        addProjectingPier(meshLimestone, t2FacadeWest, pr.first, pr.second, 96.0f, 320.0f, 0.45f, colLimestone);
    }
    for (const auto& pr : t2PiersX) {
        addProjectingPier(meshLimestone, t2FacadeNorth, pr.first, pr.second, 96.0f, 320.0f, 0.45f, colLimestone);
        addProjectingPier(meshLimestone, t2FacadeSouth, pr.first, pr.second, 96.0f, 320.0f, 0.45f, colLimestone);
    }

    // Windows Tier 2
    for (float yF = 96.0f; yF < 318.0f; yF += 3.6f) {
        for (const auto& bay : t2BaysZ) {
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, t2FacadeEast, bay.first, bay.second, yF, yF + 3.6f, 0.85f, 0.15f, 0.25f, 0.35f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, t2FacadeWest, bay.first, bay.second, yF, yF + 3.6f, 0.85f, 0.15f, 0.25f, 0.35f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
        }
        for (const auto& bay : t2BaysX) {
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, t2FacadeNorth, bay.first, bay.second, yF, yF + 3.6f, 0.85f, 0.15f, 0.25f, 0.35f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
            addApertureWindowBay(meshLimestone, meshGlazing, meshSpandrel, meshSteel, t2FacadeSouth, bay.first, bay.second, yF, yF + 3.6f, 0.85f, 0.15f, 0.25f, 0.35f, 2, colLimestone, colGlazing, colSpandrel, colSteel);
        }
    }

    // 86th Floor Open-Air Observation Deck (Y = 320.0m) (centered at 0,0)
    addBoxMetric(meshRoof, Vec3(0.0f, 320.1f, 0.0f), Vec3(67.0f, 0.20f, 62.0f), colRoof, 1.0f / 3.0f, 1.0f / 3.0f);
    addBoxMetric(meshLimestone, Vec3(0.0f, 320.6f, -30.6f), Vec3(66.0f, 1.0f, 0.6f), colLimestone, 1.0f / 2.0f, 1.0f / 1.0f);
    addBoxMetric(meshLimestone, Vec3(0.0f, 320.6f,  30.6f), Vec3(66.0f, 1.0f, 0.6f), colLimestone, 1.0f / 2.0f, 1.0f / 1.0f);
    addBoxMetric(meshLimestone, Vec3( 33.1f, 320.6f, 0.0f), Vec3(0.6f, 1.0f, 61.0f), colLimestone, 1.0f / 2.0f, 1.0f / 1.0f);
    addBoxMetric(meshLimestone, Vec3(-33.1f, 320.6f, 0.0f), Vec3(0.6f, 1.0f, 61.0f), colLimestone, 1.0f / 2.0f, 1.0f / 1.0f);

    // Mooring Mast & 102nd Floor Glass Observation Gallery (Y = 320m to 381m) (centered at 0,0)
    addCylinderMetric(meshSteel, Vec3(0.0f, 320.0f, 0.0f), 12.0f, 9.5f, 35.0f, 32, colSteel, 4.0f, 1.0f / 4.0f);
    addCylinderMetric(meshGlazing, Vec3(0.0f, 355.0f, 0.0f), 9.6f, 9.6f, 8.0f, 32, colGlazing, 4.0f, 1.0f / 2.0f);
    addCylinderMetric(meshSteel, Vec3(0.0f, 363.0f, 0.0f), 9.5f, 6.5f, 18.0f, 32, colSteel, 4.0f, 1.0f / 3.0f);

    // Antenna Spire (Y = 381.0m to 427.5m) (centered at 0,0)
    addCylinderMetric(meshTileSpire, Vec3(0.0f, 381.0f, 0.0f), 3.2f, 1.8f, 24.0f, 24, colSteel, 2.0f, 1.0f / 4.0f);
    addCylinderMetric(meshTileSpire, Vec3(0.0f, 405.0f, 0.0f), 1.8f, 0.45f, 20.0f, 16, colSteel, 1.0f, 1.0f / 4.0f);
    addCylinderMetric(meshTileSpire, Vec3(0.0f, 425.0f, 0.0f), 0.45f, 0.08f, 2.5f, 12, colSteel, 1.0f, 1.0f / 1.0f);

    // ------------------------------------------------------------------------
    // F. Export Stage 2: Vector-Refined Geometry + Trees in Studio Grey Clay
    // ------------------------------------------------------------------------
    std::string stage2Path = "public/models/omnispatial_stage2_vector_refined.glb";
    std::cout << "\nBuilding Stage 2 (4-Sided Vector-Refined Geometry + Trees in Studio Grey Clay)...\n";
    {
        ScratchboxMesh stage2ClayMesh;
        stage2ClayMesh.name = "VectorRefined_StudioGreyClay";
        stage2ClayMesh.material.name = "Mat_StudioGreyClay";
        stage2ClayMesh.material.baseColorFactor = Vec4(0.55f, 0.57f, 0.60f, 1.0f);
        stage2ClayMesh.material.roughnessFactor = 0.85f;
        stage2ClayMesh.material.metallicFactor = 0.0f;

        auto mergeClay = [&](const ScratchboxMesh& src) {
            uint32_t base = static_cast<uint32_t>(stage2ClayMesh.vertices.size());
            for (auto v : src.vertices) {
                v.color = Vec4(0.55f, 0.57f, 0.60f, 1.0f);
                stage2ClayMesh.addVertex(v);
            }
            for (auto idx : src.indices) {
                stage2ClayMesh.indices.push_back(base + idx);
            }
        };

        mergeClay(meshDistrict);
        mergeClay(meshLimestone);
        mergeClay(meshGranite);
        mergeClay(meshSpandrel);
        mergeClay(meshSteel);
        mergeClay(meshGlazing);
        mergeClay(meshBronze);
        mergeClay(meshRoof);
        mergeClay(meshSidewalk);
        mergeClay(meshInterior);
        mergeClay(meshTileSpire);
        mergeClay(meshTreeTrunk);
        mergeClay(meshTreeFoliage);

        bool ok = GlbWriter::writeToFile(stage2ClayMesh, stage2Path);
        if (ok) {
            std::cout << "SUCCESS: Wrote Stage 2 Vector-Refined Clay to " << stage2Path << " (" 
                      << (stage2ClayMesh.indices.size() / 3) << " triangles)\n";
        }
    }

    // ------------------------------------------------------------------------
    // G. Export Stage 3: Master Hyper-Realistic PBR Model
    // ------------------------------------------------------------------------
    std::string stage3Path = "public/models/omnispatial_real_stage3_streetview_pbr.glb";
    std::cout << "\nBuilding Stage 3 (Master Hyper-Realistic Model with PBR & Street View Ground Truth)...\n";

    meshLimestone.material.name = "Mat_IndianaLimestone";
    meshGranite.material.name = "Mat_CharcoalGranite";
    meshSpandrel.material.name = "Mat_ArtDecoSpandrels";
    meshSteel.material.name = "Mat_StainlessSteel";
    meshGlazing.material.name = "Mat_ArchitecturalGlazing";
    meshBronze.material.name = "Mat_StatuaryBronze";
    meshRoof.material.name = "Mat_BitumenRoof";
    meshSidewalk.material.name = "Mat_ScoredSidewalk";
    meshInterior.material.name = "Mat_LobbyAndInterior";
    meshTileSpire.material.name = "Mat_AuthenticTileSpire";
    meshTreeTrunk.material.name = "Mat_OakBark";
    meshTreeFoliage.material.name = "Mat_OakFoliage";
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
        std::move(meshTileSpire),       // 9
        std::move(meshTreeTrunk),       // 10
        std::move(meshTreeFoliage)      // 11
    };

    // Synthesize PBR Texture Sets via Continuous Biophysical Manifold (ADA Pillar 3)
    const int TEX_RES = 1024;
    std::vector<EmbeddedTexture> embeddedTextures;

    struct ContinuousMaterialSlot {
        int matIndex;
        std::string name;
        ContinuousMaterialDescriptor descriptor;
        uint32_t seed;
    };

    std::vector<ContinuousMaterialSlot> materialSlots;
    {
        // 0. Honed Indiana Limestone (Continuous biophysical stone)
        ContinuousMaterialDescriptor dLimestone = getAnchorManifoldPoint(0);
        dLimestone.albedoLinear = Vec3(0.72f, 0.70f, 0.65f);
        dLimestone.roughnessBaseline = 0.82f;
        dLimestone.conduction = 0.0f;
        dLimestone.microPorosity = 0.42f;
        dLimestone.normalStrength = 1.6f;
        dLimestone.fissureScale = 12.0f;
        dLimestone.fissureDepth = 0.18f;
        materialSlots.push_back({0, "IndianaLimestone", dLimestone, 101});

        // 1. Charcoal Granite Plinth
        ContinuousMaterialDescriptor dGranite = getAnchorManifoldPoint(4);
        dGranite.albedoLinear = Vec3(0.18f, 0.19f, 0.20f);
        dGranite.secondaryAlbedo = Vec3(0.10f, 0.11f, 0.12f);
        dGranite.conduction = 0.0f;
        dGranite.roughnessBaseline = 0.75f;
        dGranite.microPorosity = 0.50f;
        dGranite.normalStrength = 1.8f;
        dGranite.cellularWeight = 0.45f;
        materialSlots.push_back({1, "CharcoalGranite", dGranite, 202});

        // 2. Art Deco Bronze Spandrels
        ContinuousMaterialDescriptor dSpandrel = getAnchorManifoldPoint(18);
        dSpandrel.albedoLinear = Vec3(0.28f, 0.22f, 0.16f);
        dSpandrel.secondaryAlbedo = Vec3(0.18f, 0.14f, 0.10f);
        dSpandrel.conduction = 0.85f;
        dSpandrel.roughnessBaseline = 0.38f;
        dSpandrel.anisotropyStrength = 0.50f;
        materialSlots.push_back({2, "ArtDecoSpandrels", dSpandrel, 303});

        // 3. Brushed Stainless Steel
        ContinuousMaterialDescriptor dSteel = getAnchorManifoldPoint(20);
        dSteel.albedoLinear = Vec3(0.75f, 0.76f, 0.78f);
        dSteel.conduction = 0.95f;
        dSteel.roughnessBaseline = 0.28f;
        dSteel.anisotropyStrength = 0.85f;
        materialSlots.push_back({3, "StainlessSteel", dSteel, 404});

        // 4. Low-E Architectural Reflective Glazing
        ContinuousMaterialDescriptor dGlass = getAnchorManifoldPoint(30);
        dGlass.albedoLinear = Vec3(0.05f, 0.08f, 0.12f);
        dGlass.conduction = 0.05f;
        dGlass.roughnessBaseline = 0.03f;
        dGlass.microPorosity = 0.02f;
        dGlass.normalStrength = 0.3f;
        materialSlots.push_back({4, "ArchitecturalGlazing", dGlass, 505});

        // 5. Statuary Cast Bronze
        ContinuousMaterialDescriptor dBronze = getAnchorManifoldPoint(18);
        dBronze.albedoLinear = Vec3(0.25f, 0.18f, 0.12f);
        dBronze.conduction = 0.90f;
        dBronze.roughnessBaseline = 0.42f;
        materialSlots.push_back({5, "CastBronze", dBronze, 606});

        // 6. Bitumen Tar & Gravel Ballast
        ContinuousMaterialDescriptor dRoof = getAnchorManifoldPoint(10);
        dRoof.albedoLinear = Vec3(0.15f, 0.15f, 0.16f);
        dRoof.conduction = 0.0f;
        dRoof.roughnessBaseline = 0.92f;
        dRoof.cellularWeight = 0.60f;
        dRoof.normalStrength = 2.4f;
        materialSlots.push_back({6, "BitumenRoof", dRoof, 707});

        // 7. Scored Sidewalk Pavement
        ContinuousMaterialDescriptor dSidewalk = getAnchorManifoldPoint(10);
        dSidewalk.albedoLinear = Vec3(0.60f, 0.59f, 0.57f);
        dSidewalk.conduction = 0.0f;
        dSidewalk.roughnessBaseline = 0.90f;
        dSidewalk.graininess = 0.40f;
        materialSlots.push_back({7, "SidewalkPavement", dSidewalk, 808});

        // 8. Grand Lobby Interior Travertine Marble
        ContinuousMaterialDescriptor dMarble = getAnchorManifoldPoint(2);
        dMarble.albedoLinear = Vec3(0.85f, 0.81f, 0.72f);
        dMarble.roughnessBaseline = 0.48f;
        materialSlots.push_back({8, "LobbyInteriorMarble", dMarble, 909});

        // 9. Turned Lathe Aluminum Spire
        ContinuousMaterialDescriptor dSpire = getAnchorManifoldPoint(20);
        dSpire.albedoLinear = Vec3(0.82f, 0.84f, 0.86f);
        dSpire.conduction = 0.98f;
        dSpire.roughnessBaseline = 0.20f;
        materialSlots.push_back({9, "AuthenticTileSpire", dSpire, 999});

        // 10. Botanical Oak Bark
        ContinuousMaterialDescriptor dBark = getAnchorManifoldPoint(0);
        dBark.albedoLinear = Vec3(0.22f, 0.18f, 0.14f);
        dBark.roughnessBaseline = 0.88f;
        dBark.fissureScale = 16.0f;
        dBark.fissureDepth = 0.45f;
        materialSlots.push_back({10, "OakBark", dBark, 111});

        // 11. Botanical Oak Foliage
        ContinuousMaterialDescriptor dLeaf = getAnchorManifoldPoint(30);
        dLeaf.albedoLinear = Vec3(0.12f, 0.28f, 0.08f);
        dLeaf.roughnessBaseline = 0.65f;
        dLeaf.microPorosity = 0.25f;
        materialSlots.push_back({11, "OakFoliage", dLeaf, 222});

        // 12. Surrounding District Facades (Context Tiles)
        ContinuousMaterialDescriptor dContext = getAnchorManifoldPoint(0);
        dContext.albedoLinear = Vec3(0.70f, 0.68f, 0.64f);
        dContext.roughnessBaseline = 0.80f;
        (void)dContext; // District uses its authentic tile textures (appended below).
    }

    for (const auto& def : materialSlots) {
        auto pbrSet = synthesizeManifoldPbrParallel(def.descriptor, TEX_RES, TEX_RES, def.seed);

        if (def.matIndex == 4) { // Architectural Glazing: Dark reflective glass, ZERO daytime emission
            const int cellW = TEX_RES / 8;
            const int cellH = TEX_RES / 4;
            for (int y = 0; y < TEX_RES; ++y) {
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
                        pbrSet.albedo.setPixelRGB(x, y, Vec3(0.12f, 0.10f, 0.09f)); // Dark bronze mullion
                        pbrSet.orm.setPixelRGB(x, y, Vec3(1.0f, 0.35f, 0.85f));     // R=0.35, M=0.85
                    } else {
                        pbrSet.albedo.setPixelRGB(x, y, Vec3(0.04f, 0.05f, 0.07f)); // Reflective glass pane
                        pbrSet.orm.setPixelRGB(x, y, Vec3(1.0f, 0.03f, 0.05f));     // R=0.03, M=0.05
                    }
                }
            }
        } else if (def.matIndex == 10) { // Oak Bark
            for (int y = 0; y < TEX_RES; ++y) {
                for (int x = 0; x < TEX_RES; ++x) {
                    pbrSet.albedo.setPixelRGB(x, y, Vec3(0.36f, 0.30f, 0.24f));
                    pbrSet.orm.setPixelRGB(x, y, Vec3(1.0f, 0.88f, 0.0f));
                }
            }
        } else if (def.matIndex == 11) { // Oak Foliage (Translucent green)
            for (int y = 0; y < TEX_RES; ++y) {
                for (int x = 0; x < TEX_RES; ++x) {
                    pbrSet.albedo.setPixelRGB(x, y, Vec3(0.22f, 0.40f, 0.12f));
                    pbrSet.orm.setPixelRGB(x, y, Vec3(1.0f, 0.65f, 0.0f));
                }
            }
        } else if (def.matIndex == 12) { // Surrounding District Facades (Clean neutral multiplier)
            for (int y = 0; y < TEX_RES; ++y) {
                for (int x = 0; x < TEX_RES; ++x) {
                    pbrSet.albedo.setPixelRGB(x, y, Vec3(1.0f, 1.0f, 1.0f));
                    pbrSet.orm.setPixelRGB(x, y, Vec3(1.0f, 0.82f, 0.04f));
                }
            }
        }

        EmbeddedTexture texAlbedo;
        texAlbedo.name = def.name + "_BaseColor";
        texAlbedo.mimeType = "image/png";
        texAlbedo.data = scratchbox::png::encode(pbrSet.albedo);
        texAlbedo.usage = TextureUsage::BASE_COLOR;
        texAlbedo.materialIndex = def.matIndex;
        embeddedTextures.push_back(std::move(texAlbedo));

        EmbeddedTexture texNormal;
        texNormal.name = def.name + "_Normal";
        texNormal.mimeType = "image/png";
        texNormal.data = scratchbox::png::encode(pbrSet.normal);
        texNormal.usage = TextureUsage::NORMAL;
        texNormal.materialIndex = def.matIndex;
        embeddedTextures.push_back(std::move(texNormal));

        EmbeddedTexture texOrm;
        texOrm.name = def.name + "_ORM";
        texOrm.mimeType = "image/png";
        texOrm.data = scratchbox::png::encode(pbrSet.orm);
        texOrm.usage = TextureUsage::ORM;
        texOrm.materialIndex = def.matIndex;
        embeddedTextures.push_back(std::move(texOrm));
    }

    // Zero Daytime Emission for Glazing
    {
        ImageBuffer emissiveImg(TEX_RES, TEX_RES, 3);
        for (int y = 0; y < TEX_RES; ++y) {
            for (int x = 0; x < TEX_RES; ++x) {
                emissiveImg.setPixelRGB(x, y, Vec3(0.0f, 0.0f, 0.0f));
            }
        }
        EmbeddedTexture texEmissive;
        texEmissive.name = "ArchitecturalGlazing_Emissive";
        texEmissive.mimeType = "image/png";
        texEmissive.data = scratchbox::png::encode(emissiveImg);
        texEmissive.usage = TextureUsage::EMISSIVE;
        texEmissive.materialIndex = 4;
        embeddedTextures.push_back(std::move(texEmissive));
    }

    // Surrounding district: one submesh per tile material, carrying the original
    // photogrammetric JPEG/PNG bytes losslessly (no re-encode, no color baking).
    size_t districtTextured = 0, districtTextureBytes = 0;
    for (auto& [matIdx, chunk] : districtByMaterial) {
        char tag[32];
        std::snprintf(tag, sizeof(tag), "TileTex_%03u_", matIdx);
        chunk.name = std::string("MidtownDistrict_") + tag;
        chunk.material.name = std::string("Mat_") + tag;
        chunk.material.baseColorFactor = Vec4(1.0f, 1.0f, 1.0f, 1.0f);
        chunk.material.roughnessFactor = 0.82f;
        chunk.material.metallicFactor = 0.04f;
        int imgIdx = -1;
        if (matIdx < tileScene.materials.size()) {
            chunk.material.baseColorFactor = tileScene.materials[matIdx].baseColorFactor;
            imgIdx = tileScene.materials[matIdx].baseColorImage;
        }
        int subIdx = static_cast<int>(subMeshes.size());
        subMeshes.push_back(std::move(chunk));
        if (imgIdx >= 0 && imgIdx < static_cast<int>(tileScene.images.size()) && !tileScene.images[imgIdx].encoded.empty()) {
            const auto& img = tileScene.images[imgIdx];
            EmbeddedTexture tex;
            tex.name = std::string(tag) + "BaseColor";
            tex.mimeType = img.mimeType;
            tex.data = img.encoded;
            tex.usage = TextureUsage::BASE_COLOR;
            tex.materialIndex = subIdx;
            districtTextureBytes += tex.data.size();
            embeddedTextures.push_back(std::move(tex));
            districtTextured++;
        }
    }
    std::cout << "Embedded " << districtTextured << " authentic district textures ("
              << (districtTextureBytes / 1e6) << " MB, original encoding)\n";

    bool ok3 = GlbWriter::writeMultiMeshToFile(subMeshes, stage3Path, embeddedTextures);
    if (ok3) {
        std::cout << "SUCCESS: Wrote Stage 3 Master PBR Model to " << stage3Path << "\n";
    }

    auto totalEnd = std::chrono::high_resolution_clock::now();
    double totalMs = std::chrono::duration<double, std::milli>(totalEnd - totalStart).count();

    std::cout << "\n======================================================================\n";
    std::cout << "OMNISPATIAL MASTER SUITE GENERATION COMPLETE IN " << totalMs << " ms\n";
    std::cout << "Stage 1 (Raw Tile Clay):       " << stage1Path << "\n";
    std::cout << "Stage 2 (Vector Refined Clay): " << stage2Path << "\n";
    std::cout << "Stage 3 (Master PBR Reality):  " << stage3Path << "\n";
    std::cout << "======================================================================\n";

    return 0;
}
