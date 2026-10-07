/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

#include "scratchbox_core.hpp"

#include <cmath>
#include <algorithm>
#include <random>
#include <chrono>

namespace scratchbox {
namespace core {

// ============================================================================
// 1. GEOMORPH IMPLEMENTATION
// ============================================================================

TerrainSurface generateGeologicalTerrain(const TerrainOptions& opts) {
    TerrainSurface result;
    result.options = opts;

    // 1. Configure continuous physical parameters for domain warping
    infiniti::WarpedTerrainConfig& cfg = result.config;
    cfg.seed = opts.seed;
    cfg.warpScale = opts.domainWarpScale;

    // ADA Pillar 3 Invariant: Read continuous physical fields first if specified
    if (opts.warpFreq > 0.0f || opts.contentScale > 0.0f || opts.strataDuneScale > 0.0f) {
        cfg.macroSlopeX = opts.macroSlopeX != 0.0f ? opts.macroSlopeX : -0.015f;
        cfg.macroSlopeZ = opts.macroSlopeZ != 0.0f ? opts.macroSlopeZ : -0.020f;
        cfg.warpFreq = opts.warpFreq > 0.0f ? opts.warpFreq : 0.065f;
        cfg.warpOctaves = opts.warpOctaves > 0 ? opts.warpOctaves : 3;
        cfg.contentScale = opts.contentScale > 0.0f ? opts.contentScale : 0.85f;
        cfg.contentFreq = opts.contentFreq > 0.0f ? opts.contentFreq : 0.12f;
        cfg.strataDuneScale = opts.strataDuneScale > 0.0f ? opts.strataDuneScale : 0.30f;
        cfg.strataDuneFreq = opts.strataDuneFreq > 0.0f ? opts.strataDuneFreq : 0.30f;
        cfg.slopeScale = opts.slopeScale > 0.0f ? opts.slopeScale : 0.50f;
        cfg.supressingParam = opts.suppressingParam > 0.0f ? opts.suppressingParam : 0.85f;
    } else if (opts.archetype == "alpine_karst" || opts.archetype.find("karst") != std::string::npos || opts.archetype.find("alpine") != std::string::npos) {
        cfg.macroSlopeX = -0.012f;
        cfg.macroSlopeZ = -0.018f;
        cfg.warpFreq = 0.055f;
        cfg.warpOctaves = 4;
        cfg.contentScale = 1.35f;
        cfg.contentFreq = 0.11f;
        cfg.contentOctaves = 4;
        cfg.strataDuneScale = 0.38f;
        cfg.strataDuneFreq = 0.25f;
        cfg.slopeScale = 0.55f;
        cfg.supressingParam = 0.90f;
    } else if (opts.archetype.find("canyon") != std::string::npos || opts.archetype.find("gorge") != std::string::npos) {
        cfg.macroSlopeX = -0.025f;
        cfg.macroSlopeZ = 0.015f;
        cfg.warpFreq = 0.040f;
        cfg.warpOctaves = 3;
        cfg.contentScale = 0.95f;
        cfg.contentFreq = 0.09f;
        cfg.strataDuneScale = 0.75f;
        cfg.strataDuneFreq = 0.18f;
        cfg.slopeScale = 0.70f;
        cfg.supressingParam = 0.85f;
    } else {
        // Continuous physical fallback
        cfg.macroSlopeX = -0.015f;
        cfg.macroSlopeZ = -0.020f;
        cfg.warpFreq = 0.065f;
        cfg.warpOctaves = 3;
        cfg.contentScale = 0.85f;
        cfg.contentFreq = 0.12f;
        cfg.strataDuneScale = 0.30f;
        cfg.strataDuneFreq = 0.30f;
        cfg.slopeScale = 0.50f;
        cfg.supressingParam = 0.85f;
    }

    // 2. Grid Dimensions
    int res = std::max(64, opts.resolution);
    float halfX = opts.extentX * 0.5f;
    float halfZ = opts.extentZ * 0.5f;
    float stepX = opts.extentX / static_cast<float>(res - 1);
    float stepZ = opts.extentZ / static_cast<float>(res - 1);

    // 3. Run Soil Machine Hydrological Simulation
    infiniti::SoilSimulationConfig soilCfg;
    soilCfg.seed = opts.seed + 777;
    soilCfg.numParticles = std::max(300, opts.hydraulicErosionSteps * 25);
    soilCfg.maxSteps = std::min(60, std::max(15, opts.hydraulicErosionSteps));
    soilCfg.sedimentCapacityFactor = 0.38f;
    soilCfg.erosionRate = 0.20f;
    soilCfg.depositionRate = 0.28f;

    auto heightFn = [&](float x, float z) {
        return infiniti::DomainWarpedTerrain::sampleHeight(x, z, cfg);
    };

    result.soil = infiniti::SoilMachineSedimentTracker::runSimulation(
        res, res, -halfX, -halfZ, stepX, heightFn, soilCfg
    );

    // 4. Construct Authentic 3D Mesh
    ScratchboxMesh& mesh = result.mesh;
    mesh.name = "GeologicalTerrain_" + opts.archetype;
    mesh.vertices.reserve(static_cast<size_t>(res) * res);
    mesh.indices.reserve(static_cast<size_t>(res - 1) * (res - 1) * 6);

    // Geological PBR Palette
    const Vec4 rockColor(0.48f, 0.46f, 0.43f, 1.0f);     // Limestone / Travertine bedrock
    const Vec4 sedimentColor(0.58f, 0.52f, 0.42f, 1.0f); // Sandy alluvial sediment
    const Vec4 humusColor(0.28f, 0.36f, 0.20f, 1.0f);    // Loamy vegetation / humus

    for (int iz = 0; iz < res; ++iz) {
        float z = -halfZ + static_cast<float>(iz) * stepZ;
        float v = static_cast<float>(iz) / static_cast<float>(res - 1);

        for (int ix = 0; ix < res; ++ix) {
            float x = -halfX + static_cast<float>(ix) * stepX;
            float u = static_cast<float>(ix) / static_cast<float>(res - 1);

            float y = heightFn(x, z);
            Vec3 norm = infiniti::DomainWarpedTerrain::sampleNormal(x, z, cfg);

            // Sample soil metrics
            float sediment = result.soil.sampleSediment(x, z, -halfX, -halfZ, stepX, res, res);
            float moisture = result.soil.sampleMoisture(x, z, -halfX, -halfZ, stepX, res, res);

            // Shading stratification based on slope and sediment
            float slopeY = std::clamp(norm.y, 0.0f, 1.0f);
            Vec4 vertColor = rockColor;

            if (slopeY > 0.70f) {
                // Flatter benches accumulate sediment and botanical humus
                float grassWeight = std::clamp((slopeY - 0.70f) / 0.30f * (0.3f + moisture * 0.7f), 0.0f, 1.0f);
                Vec4 soilMix = sedimentColor * (1.0f - sediment) + sedimentColor * 0.8f * sediment;
                vertColor = soilMix * (1.0f - grassWeight) + humusColor * grassWeight;
            } else if (slopeY > 0.45f) {
                // Transitional scree slopes
                float screeWeight = (slopeY - 0.45f) / 0.25f;
                vertColor = rockColor * (1.0f - screeWeight) + sedimentColor * screeWeight;
            }

            mesh.addVertex(Vertex(Vec3(x, y, z), norm, Vec2(u, v), vertColor));
        }
    }

    // Connect Grid Triangles
    for (int iz = 0; iz < res - 1; ++iz) {
        for (int ix = 0; ix < res - 1; ++ix) {
            uint32_t i0 = static_cast<uint32_t>(iz * res + ix);
            uint32_t i1 = static_cast<uint32_t>(iz * res + (ix + 1));
            uint32_t i2 = static_cast<uint32_t>((iz + 1) * res + (ix + 1));
            uint32_t i3 = static_cast<uint32_t>((iz + 1) * res + ix);

            mesh.addTriangle(i0, i1, i2);
            mesh.addTriangle(i0, i2, i3);
        }
    }

    mesh.material.name = "Terrain_PBR";
    mesh.material.baseColorFactor = Vec4(0.92f, 0.90f, 0.88f, 1.0f);
    mesh.material.roughnessFactor = 0.88f;
    mesh.material.metallicFactor = 0.02f;

    mesh.recomputeBounds();
    return result;
}

// ============================================================================
// 2. ARCHIMORPH IMPLEMENTATION
// ============================================================================

ScratchboxMesh buildClassicalTemple(const TempleOptions& opts) {
    ScratchboxMesh temple("ClassicalTemple_" + opts.archetype);
    temple.material.name = "ClassicalTravertine_PBR";
    temple.material.baseColorFactor = opts.stoneColor;
    temple.material.roughnessFactor = 0.78f;
    temple.material.metallicFactor = 0.02f;

    float W = opts.footprintWidth;
    float L = opts.footprintLength;
    float plinthH = opts.plinthHeight;
    float colH = opts.columnHeight;
    float colR = colH * 0.065f; // Vitruvian 1:8 to 1:10 aspect ratio
    Vec4 colStone = opts.stoneColor;

    // ------------------------------------------------------------------------
    // A. Stepped Stereobate & Stylobate Podium (3 Classical Steps)
    // ------------------------------------------------------------------------
    const int stepCount = 3;
    float stepH = plinthH / static_cast<float>(stepCount);
    for (int s = 0; s < stepCount; ++s) {
        float inset = static_cast<float>(stepCount - 1 - s) * 0.65f;
        float curW = W + 2.0f + inset * 2.0f;
        float curL = L + 2.0f + inset * 2.0f;
        float curY = static_cast<float>(s) * stepH + stepH * 0.5f;

        ScratchboxMesh stepBox = ScratchboxMesh::createBox(
            Vec3(curW, stepH, curL),
            colStone * (0.92f + 0.03f * static_cast<float>(s))
        );
        for (auto& v : stepBox.vertices) v.position.y += curY;
        temple.append(stepBox);
    }

    // ------------------------------------------------------------------------
    // B. Peristyle Colonnade (Front, Back & Flanks)
    // ------------------------------------------------------------------------
    int nx = std::max(4, opts.columnCountX);
    int ny = std::max(6, opts.columnCountY);

    float spanX = W - colR * 3.0f;
    float spanZ = L - colR * 3.0f;
    float dx = spanX / static_cast<float>(nx - 1);
    float dz = spanZ / static_cast<float>(ny - 1);
    float colBaseY = plinthH;

    // Single fluted column template
    ScratchboxMesh colTemplate = ScratchboxMesh::createFlutedColumn(
        colR, colH, 20, 32, colStone
    );

    // Capital & Entablature order modulation
    if (opts.order == RomanOrder::Corinthian || opts.order == RomanOrder::Composite) {
        // Add Corinthian acanthus bell capital
        float capH = colR * 1.5f;
        ScratchboxMesh bell = ScratchboxMesh::createCylinder(colR * 1.0f, colR * 1.45f, capH, 24, colStone * 1.02f);
        for (auto& v : bell.vertices) v.position.y += (colH - capH * 0.5f);
        colTemplate.append(bell);

        // Abacus plate
        ScratchboxMesh abacus = ScratchboxMesh::createBox(Vec3(colR * 2.8f, colR * 0.28f, colR * 2.8f), colStone * 1.05f);
        for (auto& v : abacus.vertices) v.position.y += colH;
        colTemplate.append(abacus);
    } else if (opts.order == RomanOrder::Ionic) {
        // Ionic volute cushion capital
        ScratchboxMesh volute = ScratchboxMesh::createBox(Vec3(colR * 3.0f, colR * 0.55f, colR * 2.2f), colStone * 1.02f);
        for (auto& v : volute.vertices) v.position.y += colH - colR * 0.27f;
        colTemplate.append(volute);
    }

    auto placeColumnAt = [&](float px, float pz) {
        ScratchboxMesh instance = colTemplate;
        for (auto& v : instance.vertices) {
            v.position.x += px;
            v.position.y += colBaseY;
            v.position.z += pz;
        }
        temple.append(instance);
    };

    // Front & Back Colonnades
    float halfSpanX = spanX * 0.5f;
    float halfSpanZ = spanZ * 0.5f;

    for (int ix = 0; ix < nx; ++ix) {
        float px = -halfSpanX + static_cast<float>(ix) * dx;
        placeColumnAt(px, -halfSpanZ); // Front
        placeColumnAt(px,  halfSpanZ); // Back
    }

    // Left & Right Flank Colonnades
    for (int iz = 1; iz < ny - 1; ++iz) {
        float pz = -halfSpanZ + static_cast<float>(iz) * dz;
        placeColumnAt(-halfSpanX, pz); // Left
        placeColumnAt( halfSpanX, pz); // Right
    }

    // ------------------------------------------------------------------------
    // C. Interior Cella (Enclosed Sacred Chamber)
    // ------------------------------------------------------------------------
    float cellaW = spanX - dx * 1.4f;
    float cellaL = spanZ - dz * 2.0f;
    float cellaH = colH;
    float cellaCenterZ = dz * 0.5f; // Recessed slightly behind front portico

    ScratchboxMesh cella = ScratchboxMesh::createBox(
        Vec3(cellaW, cellaH, cellaL),
        colStone * 0.94f
    );
    for (auto& v : cella.vertices) {
        v.position.y += colBaseY + cellaH * 0.5f;
        v.position.z += cellaCenterZ;
    }
    temple.append(cella);

    // ------------------------------------------------------------------------
    // D. Classical Entablature (Architrave + Frieze + Dentil Cornice)
    // ------------------------------------------------------------------------
    float entabY = colBaseY + colH;
    float beamW = spanX + colR * 3.2f;
    float beamL = spanZ + colR * 3.2f;

    // 1. Architrave (Epistyle)
    float archH = colH * 0.08f;
    ScratchboxMesh architrave = ScratchboxMesh::createBox(
        Vec3(beamW, archH, beamL), colStone * 0.98f
    );
    for (auto& v : architrave.vertices) v.position.y += entabY + archH * 0.5f;
    temple.append(architrave);
    entabY += archH;

    // 2. Frieze Band
    float friezeH = colH * 0.10f;
    ScratchboxMesh frieze = ScratchboxMesh::createBox(
        Vec3(beamW * 0.98f, friezeH, beamL * 0.98f), colStone * 0.96f
    );
    for (auto& v : frieze.vertices) v.position.y += entabY + friezeH * 0.5f;
    temple.append(frieze);
    entabY += friezeH;

    // 3. Projecting Dentil Cornice
    float cornH = colH * 0.06f;
    float cornW = beamW + 0.8f;
    float cornL = beamL + 0.8f;
    ScratchboxMesh cornice = ScratchboxMesh::createBox(
        Vec3(cornW, cornH, cornL), colStone * 1.02f
    );
    for (auto& v : cornice.vertices) v.position.y += entabY + cornH * 0.5f;
    temple.append(cornice);
    entabY += cornH;

    // ------------------------------------------------------------------------
    // E. Pediment Tympanum & Dual-Pitched Gable Roof
    // ------------------------------------------------------------------------
    float pedPitchRad = 15.0f * (math::PI / 180.0f);
    float pedPeakH = (cornW * 0.5f) * std::tan(pedPitchRad);

    // Front & Rear Triangular Pediments (Tympanum)
    auto addPediment = [&](float zPos, bool flipZ) {
        ScratchboxMesh ped("tympanum");
        uint32_t baseIdx = static_cast<uint32_t>(ped.vertices.size());
        Vec3 norm(0, 0, flipZ ? 1.0f : -1.0f);

        ped.addVertex(Vertex(Vec3(-cornW * 0.5f, entabY, zPos), norm, Vec2(0, 0), colStone));
        ped.addVertex(Vertex(Vec3( cornW * 0.5f, entabY, zPos), norm, Vec2(1, 0), colStone));
        ped.addVertex(Vertex(Vec3( 0.0f, entabY + pedPeakH, zPos), norm, Vec2(0.5f, 1), colStone * 1.03f));

        if (flipZ) {
            ped.addTriangle(baseIdx, baseIdx + 2, baseIdx + 1);
        } else {
            ped.addTriangle(baseIdx, baseIdx + 1, baseIdx + 2);
        }
        temple.append(ped);
    };

    addPediment(-cornL * 0.5f, false); // Front
    addPediment( cornL * 0.5f, true);  // Rear

    // Gable Roof Slopes (Terracotta Tiles)
    const Vec4 tileColor(0.68f, 0.35f, 0.25f, 1.0f);
    float roofOverhang = 0.6f;
    float roofSlopeLen = std::sqrt((cornW * 0.5f) * (cornW * 0.5f) + pedPeakH * pedPeakH) + roofOverhang;
    float roofTotalL = cornL + roofOverhang * 2.0f;

    // Left Roof Slope
    ScratchboxMesh leftRoof = ScratchboxMesh::createBox(
        Vec3(roofSlopeLen, 0.18f, roofTotalL), tileColor
    );
    for (auto& v : leftRoof.vertices) {
        // Rotate by pitch angle around Z-axis
        float cosA = std::cos(-pedPitchRad);
        float sinA = std::sin(-pedPitchRad);
        float rx = v.position.x * cosA - v.position.y * sinA;
        float ry = v.position.x * sinA + v.position.y * cosA;
        v.position.x = rx - cornW * 0.25f;
        v.position.y = ry + entabY + pedPeakH * 0.5f;
    }
    temple.append(leftRoof);

    // Right Roof Slope
    ScratchboxMesh rightRoof = ScratchboxMesh::createBox(
        Vec3(roofSlopeLen, 0.18f, roofTotalL), tileColor
    );
    for (auto& v : rightRoof.vertices) {
        // Rotate by pitch angle around Z-axis
        float cosA = std::cos(pedPitchRad);
        float sinA = std::sin(pedPitchRad);
        float rx = v.position.x * cosA - v.position.y * sinA;
        float ry = v.position.x * sinA + v.position.y * cosA;
        v.position.x = rx + cornW * 0.25f;
        v.position.y = ry + entabY + pedPeakH * 0.5f;
    }
    temple.append(rightRoof);

    temple.recomputeBounds();
    return temple;
}

// ============================================================================
// 3. SENSOR PASSES IMPLEMENTATION
// ============================================================================

SensorPassesResult renderSensorPasses(
    const ScratchboxMesh& sceneMesh,
    const SensorPassesOptions& opts
) {
    SensorPassesResult res;
    res.width = std::max(1, opts.width);
    res.height = std::max(1, opts.height);

    const size_t totalPixels = static_cast<size_t>(res.width) * res.height;
    res.rgbBeauty.assign(totalPixels * 3, 0.0f);
    res.linearDepth.assign(totalPixels, 1000.0f);
    res.surfaceNormals.assign(totalPixels * 3, 0.0f);

    res.triangleCount = sceneMesh.indices.size() / 3;
    res.vertexCount = sceneMesh.vertices.size();

    // Contact elevation bounds
    float minY = 1e9f, maxY = -1e9f;
    for (const auto& v : sceneMesh.vertices) {
        minY = std::min(minY, v.position.y);
        maxY = std::max(maxY, v.position.y);
    }
    res.groundElevationContactMin = (sceneMesh.vertices.empty()) ? 0.0f : minY;
    res.groundElevationContactMax = (sceneMesh.vertices.empty()) ? 0.0f : maxY;

    if (sceneMesh.vertices.empty() || sceneMesh.indices.empty()) {
        return res;
    }

    gltf::GltfScene scene;
    scene.ok = true;
    scene.mesh = sceneMesh;
    scene.mesh.recomputeBounds();
    scene.bounds = scene.mesh.bounds;

    // Populate default PBR material and per-triangle index mapping for PathTracer
    gltf::SceneMaterial defaultMat;
    defaultMat.baseColorFactor = Vec4(0.85f, 0.82f, 0.78f, 1.0f);
    defaultMat.roughnessFactor = 0.75f;
    defaultMat.metallicFactor = 0.05f;
    scene.materials.push_back(defaultMat);
    scene.triangleMaterial.assign(scene.mesh.indices.size() / 3, 0);

    render::PathTracer tracer(scene, false);

    render::CameraSpec cam;
    cam.position = opts.cameraPosition;
    cam.target = opts.cameraTarget;
    cam.verticalFovDeg = opts.fovDegrees;
    cam.up = Vec3(0, 1, 0);

    sky::PhysicalSky sky(Vec3(0.5f, 0.8f, 0.3f).normalized());
    render::RenderSettings settings;
    settings.width = res.width;
    settings.height = res.height;
    settings.samplesPerPixel = std::max(1, opts.samplesPerPixel);
    settings.seed = opts.seed;

    render::RenderOutput out = tracer.render(cam, sky, settings);

    res.geometryCoverage = out.geometryCoverage;
    res.renderMs = out.renderMs;

    for (size_t i = 0; i < totalPixels; ++i) {
        // RGB
        const Vec3& col = out.color[i];
        res.rgbBeauty[i * 3 + 0] = std::clamp(col.x, 0.0f, 1.0f);
        res.rgbBeauty[i * 3 + 1] = std::clamp(col.y, 0.0f, 1.0f);
        res.rgbBeauty[i * 3 + 2] = std::clamp(col.z, 0.0f, 1.0f);

        // Linear Depth
        res.linearDepth[i] = out.guides.depth[i];

        // Normal
        const Vec3& n = out.guides.normal[i];
        res.surfaceNormals[i * 3 + 0] = n.x;
        res.surfaceNormals[i * 3 + 1] = n.y;
        res.surfaceNormals[i * 3 + 2] = n.z;
    }

    return res;
}

} // namespace core
} // namespace scratchbox
