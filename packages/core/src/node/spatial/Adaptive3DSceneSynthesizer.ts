/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Adaptive Domain Architecture 3D Scene Synthesizer.
 * In strict alignment with Scratchbox IDE Adaptive Domain Architecture:
 * - Zero static scene .cpp files checked into production or user codebases.
 * - Compiles an Adaptive3DSceneContract that the caller supplies; it never infers one from prompt keywords.
 *   (Objects asked for in words are built by build_3d_object_from_reference / sb.object_spec instead.)
 * - Programmatic synthesis of high-performance C++20 generator code leveraging
 *   native Astro 3D Engine, Archie Architecture Engine, and SB-Veggie Botany Engine.
 * - On-the-fly compilation via Apple Clang (-std=c++20 -O3) and binary glTF 2.0 streaming.
 ********************************************************************************/

import * as fs from 'fs';
import * as path from 'path';
import { NativeCppCompilerService } from '../3d-engine/native-compiler-service';
import { AdaptiveSceneChunkPlanner, type ChunkDescriptor, type ChunkAllocationPlan } from './AdaptiveSceneChunkPlanner';
import type {
    Adaptive3DSceneContract,
    AdaptiveSceneGraphBlueprint,
    SceneChunkRegion
} from '../../common/spatial/adaptive-3d-scene-contract';

export interface Adaptive3DSceneExecutionResult {
    success: boolean;
    contract: Adaptive3DSceneContract;
    sourceCode: string;
    glbPath?: string;
    glbBase64?: string;
    vertexCount: number;
    triangleCount: number;
    compilationTimeMs: number;
    executionTimeMs: number;
    error?: string;
}

export interface ChunkedSceneChunk {
    originMeters: [number, number, number];
    physicalExtentMeters: number;
    regionIndex: number;
    result: Adaptive3DSceneExecutionResult;
}

export interface ChunkedSceneResult {
    chunks: ChunkedSceneChunk[];
    plan: ChunkAllocationPlan;
    totalVertexCount: number;
    totalTriangleCount: number;
    success: boolean;
}

export class Adaptive3DSceneSynthesizer {
    private compiler: NativeCppCompilerService;

    constructor(compiler?: NativeCppCompilerService) {
        this.compiler = compiler || NativeCppCompilerService.getInstance();
    }

    /**
     * Dynamically generates the complete C++20 program implementing the scene contract.
     * Uses Astro 3D Engine, Archie Architectural Generator, and SB-Veggie Foliage Engine.
     */
    public generateCppSource(contract: Adaptive3DSceneContract): string {
        const t = contract.terrain;
        const cr = contract.chunkRegion;
        const b = contract.architecture.structures[0] || {
            dimensions: { width: 16, depth: 12, floorCount: 3, floorHeight: 3.4 },
            fenestration: { bayWidth: 3.2, windowRecess: 0.35, sillHeight: 0.85, headerHeight: 2.85 },
            glazing: { emissiveColor: [1.0, 0.65, 0.2] }
        };
        const charList = contract.characters || contract.entourage?.characters || [];

        // Chunk-aware terrain parameters: when a chunkRegion is present, use its
        // physical extent and origin; otherwise fall back to the full-scene grid.
        const chunkGridSize  = cr ? cr.gridResolution : t.gridSize;
        const chunkPhysExt   = cr ? cr.physicalExtentMeters : (t.gridSize - 1) * t.gridSpacing;
        const chunkOriginX   = cr ? cr.origin[0] : -((t.gridSize - 1) * t.gridSpacing) / 2;
        const chunkOriginZ   = cr ? cr.origin[2] : -((t.gridSize - 1) * t.gridSpacing) / 2;

        // Whether the architecture compound falls inside this chunk's XZ bounds
        const archX = b.dimensions ? 0 : 0;  // primary structure always at origin
        const chunkContainsArch = !cr || (
            archX >= cr.origin[0] && archX < cr.origin[0] + cr.physicalExtentMeters &&
            0     >= cr.origin[2] && 0     < cr.origin[2] + cr.physicalExtentMeters
        );

        // For parametric vegetation in chunked mode: tree density from botany contract
        const botanyPatch  = contract.botany.forestPatches[0];
        const treeDensity  = botanyPatch?.density ?? 24;
        const exclRadius   = chunkContainsArch && botanyPatch ? botanyPatch.exclusionRadius : 0;
        const exclCX       = botanyPatch?.exclusionCenter[0] ?? 0;
        const exclCZ       = botanyPatch?.exclusionCenter[1] ?? 0;
        // Trees per chunk proportional to area × density / 100 (density is trees per 100m²)
        const chunkArea    = cr ? cr.physicalExtentMeters * cr.physicalExtentMeters : 150 * 150;
        const chunkTrees   = cr ? Math.round(treeDensity * chunkArea / 1000) : null;

        return `// Generated dynamically via Scratchbox Adaptive Domain Architecture
// Zero hardcoded scene files. Authoritative procedural synthesis in C++20.
${cr ? `// Chunk region: origin=(${cr.origin[0].toFixed(1)}, ${cr.origin[2].toFixed(1)}) extent=${cr.physicalExtentMeters}m region=${cr.regionIndex}` : '// Full-scene (non-chunked) generation'}
#include "scratchbox_engine.hpp"
#include "scratchbox_sb_veggie.hpp"
#include "scratchbox_architecture.hpp"
#include "scratchbox_parametric_human.hpp"
#include "scratchbox_kinematics.hpp"
#include "scratchbox_skinning.hpp"
#include "scratchbox_halfedge.hpp"
#include "scratchbox_infiniti.hpp"
#include "scratchbox_substrate.hpp"
#include "scratchbox_io.hpp"

#include <iostream>
#include <fstream>
#include <vector>
#include <cmath>
#include <algorithm>
${cr ? '#include <random>' : ''}

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::geometry;
using namespace scratchbox::sb_veggie;
using namespace scratchbox::architecture;
using namespace scratchbox::parametric;
using namespace scratchbox::kinematics;
using namespace scratchbox::skinning;
using namespace scratchbox::halfedge;
using namespace scratchbox::infiniti;
using namespace scratchbox::substrate;
using namespace scratchbox::io;

/// ============================================================================
// 1. DYNAMIC TOPOGRAPHICAL ELEVATION, GRADIENT & SLICING (ELEVATION ORACLE)
// ============================================================================

static float getTerrainHeight(float x, float z) {
    const float peakX = ${t.peakPosition[0].toFixed(2)}f;
    const float peakZ = ${t.peakPosition[1].toFixed(2)}f;
    const float peakH = ${t.peakHeight.toFixed(2)}f;
    const float valleyElev = ${t.valleyFloorElevation.toFixed(2)}f;

    float dx = x - peakX;
    float dz = z - peakZ;
    float dist = std::sqrt(dx * dx + dz * dz);
    float angle = std::atan2(dz, dx);

    // ${t.ridgeCount}-ridge pyramidal arêtes with sharp knife-edge crests
    float ridgeWave = std::cos(${t.ridgeCount}.0f * angle);
    float ridgeFactor = 1.0f + 0.45f * std::pow(std::abs(ridgeWave), ${t.sharpnessExponent.toFixed(2)}f) * (ridgeWave >= 0 ? 1.0f : -0.7f);

    float radialFalloff = std::exp(-dist * 0.024f);
    float hMassif = peakH * radialFalloff * ridgeFactor;

    // Glacial cirque erosion
    float cirqueDist = std::sqrt(x * x + (z + 28.0f) * (z + 28.0f));
    float cirqueHollow = 12.0f * std::exp(-cirqueDist * cirqueDist * 0.0018f);
    hMassif = std::max(valleyElev, hMassif - cirqueHollow);

    // Glacial U-shaped flat floor valley
    float valleyU = std::pow(std::clamp(std::abs(x) / 36.0f, 0.0f, 1.0f), 2.2f) * 16.0f;
    if (z > -15.0f) {
        hMassif = std::min(hMassif, valleyU + valleyElev);
    }

    // High-frequency scree & talus noise
    float scree = std::sin(x * 0.45f + z * 0.35f) * std::cos(z * 0.55f - x * 0.25f) * ${t.screeNoiseAmplitude.toFixed(2)}f;
    scree += std::sin(x * 1.1f - z * 0.9f) * 0.35f;

    // Smooth moat depression around central compound
    float moatDist = std::sqrt(x * x + z * z);
    if (moatDist < 26.0f) {
        float moatBlend = std::clamp((moatDist - 16.0f) / 10.0f, 0.0f, 1.0f);
        hMassif = math::lerp(valleyElev, hMassif, moatBlend);
    }

    return std::max(valleyElev, hMassif + scree);
}

static Vec3 getTerrainNormal(float x, float z, float eps = 0.4f) {
    float hL = getTerrainHeight(x - eps, z);
    float hR = getTerrainHeight(x + eps, z);
    float hD = getTerrainHeight(x, z - eps);
    float hU = getTerrainHeight(x, z + eps);
    Vec3 n(-(hR - hL) / (2.0f * eps), 1.0f, -(hU - hD) / (2.0f * eps));
    return n.normalized();
}

static ScratchboxMesh buildTerrainMesh() {
    ScratchboxMesh mesh("Adaptive_Topography");

    // Chunk-aware grid: gridSize and extent are either full-scene or per-chunk values.
    // When chunked, originX/Z place the grid in world space; vertices are world-coordinate.
    const int gridSize = ${chunkGridSize};
    const float extent = ${chunkPhysExt.toFixed(2)}f;
    const float originX = ${chunkOriginX.toFixed(2)}f;
    const float originZ = ${chunkOriginZ.toFixed(2)}f;
    const float step = extent / (gridSize - 1);

    std::vector<std::vector<Vec3>> positions(gridSize, std::vector<Vec3>(gridSize));
    std::vector<std::vector<Vec3>> normals(gridSize, std::vector<Vec3>(gridSize));
    std::vector<std::vector<Vec4>> colors(gridSize, std::vector<Vec4>(gridSize));

    for (int i = 0; i < gridSize; ++i) {
        float z = originZ + i * step;
        for (int j = 0; j < gridSize; ++j) {
            float x = originX + j * step;
            float y = getTerrainHeight(x, z);
            positions[i][j] = Vec3(x, y, z);
        }
    }

    // Particle-based hydraulic erosion and talus slope thermal settling
    std::vector<float> hGrid(gridSize * gridSize);
    for (int i = 0; i < gridSize; ++i) {
        for (int j = 0; j < gridSize; ++j) {
            hGrid[i * gridSize + j] = positions[i][j].y;
        }
    }

    HydraulicErosionConfig ecfg;
    ecfg.iterations = 2500;
    ecfg.thermalIterations = 3;
    ecfg.talusAngleThresholdDeg = 33.0f;
    std::vector<float> erosionDeltas = HydraulicErosionSimulator::simulate(hGrid, gridSize, gridSize, step, ecfg);

    for (int i = 0; i < gridSize; ++i) {
        for (int j = 0; j < gridSize; ++j) {
            positions[i][j].y = hGrid[i * gridSize + j];
        }
    }

    for (int i = 0; i < gridSize; ++i) {
        for (int j = 0; j < gridSize; ++j) {
            float x = positions[i][j].x;
            float z = positions[i][j].z;
            normals[i][j] = getTerrainNormal(x, z);

            float slope = 1.0f - normals[i][j].y;
            float elev = positions[i][j].y;

            Vec4 snowColor(${t.snowColor[0].toFixed(2)}f, ${t.snowColor[1].toFixed(2)}f, ${t.snowColor[2].toFixed(2)}f, 1.0f);
            Vec4 rockColor(${t.rockColor[0].toFixed(2)}f, ${t.rockColor[1].toFixed(2)}f, ${t.rockColor[2].toFixed(2)}f, 1.0f);
            Vec4 iceColor(0.70f, 0.82f, 0.94f, 1.0f);

            Vec4 vColor;
            if (slope > 0.38f) {
                // Steeper slopes shed snow rapidly, exposing stratified bedrock
                float rockFactor = std::clamp((slope - 0.38f) * 3.5f, 0.0f, 1.0f);
                float strata = std::sin(elev * 1.6f + x * 0.25f) * 0.06f;
                Vec4 stratifiedRock(
                    std::clamp(rockColor.x + strata, 0.0f, 1.0f),
                    std::clamp(rockColor.y + strata, 0.0f, 1.0f),
                    std::clamp(rockColor.z + strata, 0.0f, 1.0f),
                    1.0f
                );
                vColor = math::lerp(snowColor, stratifiedRock, rockFactor);
            } else if (elev < ${t.snowLineElevation.toFixed(2)}f && std::abs(x) < 22.0f) {
                float iceBlend = std::clamp((22.0f - std::abs(x)) / 12.0f, 0.0f, 1.0f);
                vColor = math::lerp(snowColor, iceColor, iceBlend);
            } else {
                // Crisp windblown snow with ambient cool shadow
                float shadowCool = std::clamp(-normals[i][j].x * 0.10f, -0.04f, 0.06f);
                vColor = Vec4(
                    std::clamp(snowColor.x + shadowCool * 0.5f, 0.0f, 1.0f),
                    std::clamp(snowColor.y + shadowCool * 0.7f, 0.0f, 1.0f),
                    std::clamp(snowColor.z + shadowCool, 0.0f, 1.0f),
                    1.0f
                );
            }

            // Deposition sediment tints warmer ochre, carved talwegs tint cooler moisture
            float ed = erosionDeltas.empty() ? 0.0f : erosionDeltas[i * gridSize + j];
            if (ed > 0.04f) {
                float dep = std::clamp(ed * 1.5f, 0.0f, 0.5f);
                vColor = math::lerp(vColor, Vec4(0.52f, 0.46f, 0.38f, 1.0f), dep);
            } else if (ed < -0.04f) {
                float carve = std::clamp(-ed * 1.5f, 0.0f, 0.5f);
                vColor = math::lerp(vColor, Vec4(0.20f, 0.22f, 0.26f, 1.0f), carve);
            }

            colors[i][j] = vColor;
        }
    }

    for (int i = 0; i < gridSize - 1; ++i) {
        for (int j = 0; j < gridSize - 1; ++j) {
            uint32_t i0 = static_cast<uint32_t>(mesh.vertices.size());

            mesh.vertices.push_back(Vertex{positions[i][j], normals[i][j], Vec2(0, 0), colors[i][j]});
            mesh.vertices.push_back(Vertex{positions[i+1][j], normals[i+1][j], Vec2(0, 1), colors[i+1][j]});
            mesh.vertices.push_back(Vertex{positions[i+1][j+1], normals[i+1][j+1], Vec2(1, 1), colors[i+1][j+1]});
            mesh.vertices.push_back(Vertex{positions[i][j+1], normals[i][j+1], Vec2(1, 0), colors[i][j+1]});

            mesh.indices.push_back(i0);
            mesh.indices.push_back(i0 + 1);
            mesh.indices.push_back(i0 + 2);
            mesh.indices.push_back(i0);
            mesh.indices.push_back(i0 + 2);
            mesh.indices.push_back(i0 + 3);
        }
    }

    mesh.recomputeBounds();
    return mesh;
}

// ============================================================================
// 2. ARCHIE ARCHITECTURAL ENGINE SYNTHESIS
// ============================================================================

static void appendMesh(ScratchboxMesh& dest, const ScratchboxMesh& src) {
    uint32_t base = static_cast<uint32_t>(dest.vertices.size());
    for (const auto& v : src.vertices) {
        dest.vertices.push_back(v);
    }
    for (uint32_t idx : src.indices) {
        dest.indices.push_back(base + idx);
    }
}

static void addBox(ScratchboxMesh& target, const Vec3& center, const Vec3& size, const Vec4& color) {
    Vec3 h = size * 0.5f;
    uint32_t baseIdx = static_cast<uint32_t>(target.vertices.size());

    struct Face { Vec3 n; Vec3 p0, p1, p2, p3; };
    Face faces[6] = {
        {Vec3(0, 0, 1), Vec3(-h.x, -h.y, h.z), Vec3(h.x, -h.y, h.z), Vec3(h.x, h.y, h.z), Vec3(-h.x, h.y, h.z)},
        {Vec3(0, 0, -1), Vec3(h.x, -h.y, -h.z), Vec3(-h.x, -h.y, -h.z), Vec3(-h.x, h.y, -h.z), Vec3(h.x, h.y, -h.z)},
        {Vec3(0, 1, 0), Vec3(-h.x, h.y, h.z), Vec3(h.x, h.y, h.z), Vec3(h.x, h.y, -h.z), Vec3(-h.x, h.y, -h.z)},
        {Vec3(0, -1, 0), Vec3(-h.x, -h.y, -h.z), Vec3(h.x, -h.y, -h.z), Vec3(h.x, -h.y, h.z), Vec3(-h.x, -h.y, h.z)},
        {Vec3(1, 0, 0), Vec3(h.x, -h.y, h.z), Vec3(h.x, -h.y, -h.z), Vec3(h.x, h.y, -h.z), Vec3(h.x, h.y, h.z)},
        {Vec3(-1, 0, 0), Vec3(-h.x, -h.y, -h.z), Vec3(-h.x, -h.y, h.z), Vec3(-h.x, h.y, h.z), Vec3(-h.x, h.y, -h.z)}
    };

    for (int f = 0; f < 6; ++f) {
        uint32_t i0 = static_cast<uint32_t>(target.vertices.size());
        target.vertices.push_back(Vertex{faces[f].p0 + center, faces[f].n, Vec2(0, 0), color});
        target.vertices.push_back(Vertex{faces[f].p1 + center, faces[f].n, Vec2(1, 0), color});
        target.vertices.push_back(Vertex{faces[f].p2 + center, faces[f].n, Vec2(1, 1), color});
        target.vertices.push_back(Vertex{faces[f].p3 + center, faces[f].n, Vec2(0, 1), color});

        target.indices.push_back(i0);
        target.indices.push_back(i0 + 1);
        target.indices.push_back(i0 + 2);
        target.indices.push_back(i0);
        target.indices.push_back(i0 + 2);
        target.indices.push_back(i0 + 3);
    }
}

static ScratchboxMesh buildArchitecturalCompound() {
    // Relation-driven assembly: every entity is built at origin, registered with
    // the SpatialConstraintSolver, and placed purely via relational predicates
    // (SUPPORTED_BY / ATTACHED_TO_SURFACE / SYMMETRIC_TO) resolved against live
    // bounding volumes and the terrain heightfield. Zero blind Cartesian offsets.
    using composer::SpatialConstraintSolver;

    const Vec4 darkConcrete(0.26f, 0.27f, 0.30f, 1.0f);
    const Vec4 titanPylon(0.38f, 0.40f, 0.43f, 1.0f);
    const Vec4 warmGlow(${b.glazing.emissiveColor[0].toFixed(2)}f, ${b.glazing.emissiveColor[1].toFixed(2)}f, ${b.glazing.emissiveColor[2].toFixed(2)}f, 1.0f);
    const Vec4 snowDrift(0.88f, 0.90f, 0.94f, 1.0f);
    const Vec4 solarDark(0.08f, 0.10f, 0.16f, 1.0f);

    // --- Entity: plinth (foundation slab, grounded on terrain) ---
    ScratchboxMesh plinth("plinth");
    addBox(plinth, Vec3(0, 0, 0), Vec3(${(b.dimensions.width * 1.5).toFixed(2)}f, 1.8f, ${(b.dimensions.depth * 1.6).toFixed(2)}f), darkConcrete);

    // --- Entity: structure_primary (Archie core building) ---
    BuildingConfig bldgCfg;
    bldgCfg.width = ${b.dimensions.width.toFixed(2)}f;
    bldgCfg.depth = ${b.dimensions.depth.toFixed(2)}f;
    bldgCfg.floorCount = ${b.dimensions.floorCount};
    bldgCfg.floorHeight = ${b.dimensions.floorHeight.toFixed(2)}f;
    bldgCfg.groundFloorHeight = ${(b.dimensions.floorHeight + 0.6).toFixed(2)}f;
    bldgCfg.plinthHeight = 0.1f;
    bldgCfg.plinthOffset = 0.1f;
    bldgCfg.bayWidth = ${b.fenestration.bayWidth.toFixed(2)}f;
    bldgCfg.windowWidth = ${(b.fenestration.bayWidth * 0.56).toFixed(2)}f;
    bldgCfg.windowHeight = 1.95f;
    bldgCfg.windowRecessDepth = ${b.fenestration.windowRecess.toFixed(2)}f;
    bldgCfg.sillHeight = ${b.fenestration.sillHeight.toFixed(2)}f;
    bldgCfg.roofType = RoofType::FlatParapet;
    bldgCfg.parapetHeight = 1.25f;
    bldgCfg.parapetThickness = 0.45f;
    bldgCfg.materials.wall.baseColorFactor = Vec4(0.48f, 0.50f, 0.53f, 1.0f);
    bldgCfg.materials.roof.baseColorFactor = Vec4(0.32f, 0.34f, 0.36f, 1.0f);
    bldgCfg.materials.foundation.baseColorFactor = Vec4(0.25f, 0.26f, 0.28f, 1.0f);
    ScratchboxMesh coreBuilding = ProceduralBuildingGenerator::generateBuilding(bldgCfg, "structure_primary");

    // --- Optional relational feature entities (emitted only when present in the scene graph) ---
    ${contract.sceneGraph?.entities.some(e => e.id === 'access_bridge') ? `
    ScratchboxMesh accessBridge("access_bridge");
    addBox(accessBridge, Vec3(0, 0, 0), Vec3(4.2f, 0.85f, 11.0f), darkConcrete);
    addBox(accessBridge, Vec3(-2.0f, 0.65f, 0), Vec3(0.45f, 0.7f, 11.0f), titanPylon);
    addBox(accessBridge, Vec3( 2.0f, 0.65f, 0), Vec3(0.45f, 0.7f, 11.0f), titanPylon);
    ` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'mast') ? `
    ScratchboxMesh mast("mast");
    addBox(mast, Vec3(0, 0, 0), Vec3(1.4f, 12.0f, 1.4f), titanPylon);
    addBox(mast, Vec3(0, 4.0f, 0), Vec3(5.2f, 0.45f, 0.9f), titanPylon);
    addBox(mast, Vec3(2.0f, 4.4f, 0), Vec3(0.3f, 1.8f, 1.8f), snowDrift);
    addBox(mast, Vec3(-2.0f, 4.4f, 0), Vec3(0.3f, 1.8f, 1.8f), snowDrift);
    addBox(mast, Vec3(0, 7.0f, 0), Vec3(0.3f, 3.2f, 0.3f), warmGlow);
    ` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'hvac_unit') ? `
    ScratchboxMesh hvacUnit("hvac_unit");
    addBox(hvacUnit, Vec3(0, 0, 0), Vec3(2.6f, 1.8f, 2.2f), titanPylon);
    addBox(hvacUnit, Vec3(0, 0.95f, 0), Vec3(1.8f, 0.25f, 1.8f), darkConcrete);
    ` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'solar_array_east') ? `
    ScratchboxMesh solarEast("solar_array_east");
    addBox(solarEast, Vec3(0, 0, 0), Vec3(5.4f, 0.15f, 3.2f), solarDark);
    addBox(solarEast, Vec3(2.7f, 0.0f, 0), Vec3(0.12f, 0.4f, 3.2f), titanPylon);
    ScratchboxMesh solarWest("solar_array_west");
    addBox(solarWest, Vec3(0, 0, 0), Vec3(5.4f, 0.15f, 3.2f), solarDark);
    addBox(solarWest, Vec3(-2.7f, 0.0f, 0), Vec3(0.12f, 0.4f, 3.2f), titanPylon);
    ` : ''}

    // --- Register entities & solve relational layout ---
    SpatialConstraintSolver solver;
    solver.registerMesh("plinth", &plinth);
    solver.registerMesh("structure_primary", &coreBuilding);
    ${contract.sceneGraph?.entities.some(e => e.id === 'access_bridge') ? `solver.registerMesh("access_bridge", &accessBridge);` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'mast') ? `solver.registerMesh("mast", &mast);` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'hvac_unit') ? `solver.registerMesh("hvac_unit", &hvacUnit);` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'solar_array_east') ? `solver.registerMesh("solar_array_east", &solarEast);` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'solar_array_west') ? `solver.registerMesh("solar_array_west", &solarWest);` : ''}

    // Terrain raycast grounding: plinth sinks its skirt into bedrock
    solver.groundOnTerrain("plinth", [](float x, float z) { return getTerrainHeight(x, z); }, -3.5f);

    // Relational predicates from the AdaptiveSceneGraphBlueprint contract
    ${(contract.relations || []).filter(r => r.targetId !== 'terrain').map(r => {
        const face = r.parameters?.faceAlignment || 'top';
        const clearance = r.parameters?.clearanceMeters ?? 0.0;
        const pred = r.predicate.toLowerCase();
        return `solver.addConstraint("${r.subjectId}", "${pred}", "${r.targetId}", "${face}", ${clearance.toFixed(2)}f);`;
    }).join('\n    ')}

    solver.solve(8, 0.01f);

    // --- Merge solved layout into unified compound ---
    ScratchboxMesh compound("Adaptive_Archie_Compound");
    appendMesh(compound, plinth);
    appendMesh(compound, coreBuilding);
    ${contract.sceneGraph?.entities.some(e => e.id === 'access_bridge') ? `appendMesh(compound, accessBridge);` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'mast') ? `appendMesh(compound, mast);` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'hvac_unit') ? `appendMesh(compound, hvacUnit);` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'solar_array_east') ? `appendMesh(compound, solarEast);` : ''}
    ${contract.sceneGraph?.entities.some(e => e.id === 'solar_array_west') ? `appendMesh(compound, solarWest);` : ''}
    compound.recomputeBounds();

    // Multi-Scale 70-20-10 Geometric Detail & Micro-Topography Enhancement:
    // 1. Continuous Edge Beveling & Filleting (kill infinite razor edges, catch specular glints)
    BevelConfig bcfg;
    bcfg.bevelRadius = 0.04f;
    bcfg.dihedralThresholdDeg = 35.0f;
    bcfg.segments = 2;
    ScratchboxMesh beveledCompound = ContinuousEdgeBeveler::bevelSharpEdges(compound, bcfg);

    // 2. Discrete Laplace-Beltrami Mean Curvature & Cavity Ambient Obscurance Baking
    LaplaceBeltramiCurvatureEngine::computeAndBake(beveledCompound);

    // 3. Multi-layer Physical Weathering, Patina, Edge Scuffing & Crevice Grime Stratification
    ProceduralWearAndGrimeShader::applyWearAndGrimeToMesh(beveledCompound);

    beveledCompound.recomputeBounds();
    return beveledCompound;
}

// ============================================================================
// 3. SB-VEGGIE BOTANICAL INSTANCING WITH ENVELOPE NORMALS
// ============================================================================

struct TreeInstance {
    Vec3 pos;
    float scale;
    float yaw;
    int templateVariant;
};

static Vec3 rotateY(const Vec3& v, float angleRad) {
    float c = std::cos(angleRad);
    float s = std::sin(angleRad);
    return Vec3(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

// ============================================================================
// 4. MAIN PROGRAM ENTRY POINT
// ============================================================================

int main(int argc, char** argv) {
    std::string outGlbPath = "scene_output.glb";
    if (argc > 1) {
        outGlbPath = argv[1];
    }

    // 1. Build Terrain
    ScratchboxMesh terrainMesh = buildTerrainMesh();

    // 2. Build Archie Architectural Compound (skipped in distant chunks)
    ${chunkContainsArch ? 'ScratchboxMesh citadelMesh = buildArchitecturalCompound();' : 'ScratchboxMesh citadelMesh("ArchCompound_Skipped"); // not in this chunk'}

    // 3. Build SB-Veggie Conifer Templates
    SbVeggieTemplate baseTmpl = SbVeggieModelBuilder::buildCanonicalTemplate(SbVeggieArchetype::ExcurrentConifer);

    SbVeggieParams paramsTall = SbVeggieParams::createNeutral();
    paramsTall.leafMorphology = 2; // Conifer needles
    paramsTall.psi_leafDensity = 0.22f;
    paramsTall.transferEnvelopeNormals = true;
    paramsTall.beta[0] = 0.35f;
    paramsTall.beta[1] = 0.85f;
    paramsTall.branchCurvature = 0.65f;
    auto decompTall = SbVeggieEvaluator::evaluateDecomposed(baseTmpl, paramsTall, true);

    SbVeggieParams paramsMed = SbVeggieParams::createNeutral();
    paramsMed.leafMorphology = 2;
    paramsMed.psi_leafDensity = 0.20f;
    paramsMed.transferEnvelopeNormals = true;
    paramsMed.beta[0] = 0.0f;
    paramsMed.beta[1] = 0.0f;
    paramsMed.branchCurvature = 0.70f;
    auto decompMed = SbVeggieEvaluator::evaluateDecomposed(baseTmpl, paramsMed, true);

    SbVeggieParams paramsCompact = SbVeggieParams::createNeutral();
    paramsCompact.leafMorphology = 2;
    paramsCompact.psi_leafDensity = 0.25f;
    paramsCompact.transferEnvelopeNormals = true;
    paramsCompact.beta[0] = -0.25f;
    paramsCompact.beta[1] = -0.55f;
    paramsCompact.branchCurvature = 0.75f;
    auto decompCompact = SbVeggieEvaluator::evaluateDecomposed(baseTmpl, paramsCompact, true);

    // 4. Tree Stand Layout
    ${cr ? `
    // Chunked mode: parametric PRNG vegetation seeded by chunk world position.
    // Density and exclusion radius from the botany contract field.
    const float CHUNK_OX = ${chunkOriginX.toFixed(2)}f;
    const float CHUNK_OZ = ${chunkOriginZ.toFixed(2)}f;
    const float CHUNK_EXT = ${chunkPhysExt.toFixed(2)}f;
    const float EXCL_RADIUS = ${exclRadius.toFixed(2)}f;
    const float EXCL_CX = ${exclCX.toFixed(2)}f;
    const float EXCL_CZ = ${exclCZ.toFixed(2)}f;
    const int TARGET_TREES = ${chunkTrees ?? 0};

    uint32_t rngSeed = static_cast<uint32_t>(
        std::abs(CHUNK_OX) * 997.0f + std::abs(CHUNK_OZ) * 1009.0f
    );
    std::mt19937 rng(rngSeed);
    std::uniform_real_distribution<float> xDist(CHUNK_OX, CHUNK_OX + CHUNK_EXT);
    std::uniform_real_distribution<float> zDist(CHUNK_OZ, CHUNK_OZ + CHUNK_EXT);
    std::uniform_real_distribution<float> scaleDist(0.82f, 1.22f);
    std::uniform_real_distribution<float> yawDist(0.0f, 6.2832f);
    std::uniform_int_distribution<int>    varDist(0, 2);

    std::vector<TreeInstance> treeStands;
    treeStands.reserve(TARGET_TREES);
    for (int ti = 0; ti < TARGET_TREES * 4 && static_cast<int>(treeStands.size()) < TARGET_TREES; ++ti) {
        float tx = xDist(rng);
        float tz = zDist(rng);
        float dx = tx - EXCL_CX;
        float dz = tz - EXCL_CZ;
        if (std::sqrt(dx * dx + dz * dz) < EXCL_RADIUS) continue;
        treeStands.push_back({Vec3(tx, 0, tz), scaleDist(rng), yawDist(rng), varDist(rng)});
    }
    ` : `
    // Full-scene mode: curated 70-20-10 biome-stratified placement.
    std::vector<TreeInstance> treeStands = {
        // --- TIER 1: DOMINANT CANOPY CONIFERS (70%) ---
        {Vec3(-12.5f, 0, 18.0f), 1.18f, 0.42f, 0},
        {Vec3(-16.5f, 0, 14.5f), 1.10f, 1.15f, 0},
        {Vec3(-20.5f, 0, 21.0f), 1.05f, 0.88f, 0},
        {Vec3(12.5f,  0, 19.0f), 1.15f, 0.55f, 0},
        {Vec3(17.0f,  0, 15.0f), 1.08f, 1.45f, 0},
        {Vec3(19.5f,  0, 21.5f), 1.02f, 0.25f, 0},
        {Vec3(-18.5f, 0, -4.0f), 1.20f, 0.20f, 0},
        {Vec3(-21.5f, 0,  2.0f), 1.08f, 1.30f, 0},
        {Vec3(-24.5f, 0, -3.0f), 1.00f, 0.70f, 0},
        {Vec3(19.5f,  0, -5.0f), 1.16f, 0.35f, 0},
        {Vec3(22.5f,  0,  1.5f), 1.05f, 1.50f, 0},
        {Vec3(16.0f,  0, -9.5f), 1.10f, 2.40f, 0},
        {Vec3(-9.0f,  0, 26.0f), 1.02f, 1.80f, 0},
        {Vec3(9.5f,   0, 26.5f), 1.06f, 0.95f, 0},
        // --- TIER 2: UNDERSTORY ADOLESCENT SAPLINGS (20%) ---
        {Vec3(-14.5f, 0, 19.5f), 0.68f, 2.10f, 1},
        {Vec3(-18.5f, 0, 16.0f), 0.62f, 0.50f, 1},
        {Vec3(14.5f,  0, 20.5f), 0.72f, 1.90f, 1},
        {Vec3(18.5f,  0, 17.0f), 0.58f, 2.80f, 1},
        {Vec3(-20.0f, 0, -2.0f), 0.65f, 1.10f, 1},
        {Vec3(-23.0f, 0,  4.0f), 0.60f, 2.40f, 1},
        {Vec3(21.0f,  0, -3.0f), 0.66f, 0.85f, 1},
        {Vec3(24.0f,  0,  3.0f), 0.59f, 2.15f, 1},
        // --- TIER 3: ALPINE GROUNDCOVER SHRUBS & DWARF CLUSTERS (10%) ---
        {Vec3(-11.0f, 0, 16.5f), 0.35f, 1.40f, 2},
        {Vec3(-15.5f, 0, 22.5f), 0.32f, 2.70f, 2},
        {Vec3(11.0f,  0, 17.5f), 0.38f, 0.60f, 2},
        {Vec3(16.0f,  0, 23.5f), 0.30f, 3.05f, 2},
        {Vec3(-17.0f, 0, -6.0f), 0.34f, 1.95f, 2},
        {Vec3(18.0f,  0, -7.0f), 0.36f, 0.40f, 2}
    };
    `}

    // Ground-snapping & slope-aware vegetation survival
    std::vector<TreeInstance> activeStands;
    for (auto& tree : treeStands) {
        Vec3 norm = getTerrainNormal(tree.pos.x, tree.pos.z);
        // Exclude trees on sheer vertical cliffs (slope > 36 deg)
        if (norm.y >= 0.80f) {
            tree.pos.y = getTerrainHeight(tree.pos.x, tree.pos.z);
            activeStands.push_back(tree);
        } else if (norm.y >= 0.65f && tree.templateVariant == 2) {
            // Dwarf shrubs can cling to moderately steep rocky ledges
            tree.pos.y = getTerrainHeight(tree.pos.x, tree.pos.z);
            activeStands.push_back(tree);
        }
    }

    ScratchboxMesh woodCompound("SB_Veggie_Wood_Compound");
    woodCompound.material = decompTall.woodMesh.material;
    ScratchboxMesh foliageCompound("SB_Veggie_Foliage_Compound");
    foliageCompound.material = decompTall.foliageMesh.material;

    for (const auto& inst : activeStands) {
        const auto& treeData = (inst.templateVariant == 0) ? decompTall :
                               (inst.templateVariant == 1) ? decompMed : decompCompact;

        uint32_t woodBase = static_cast<uint32_t>(woodCompound.vertices.size());
        for (const auto& v : treeData.woodMesh.vertices) {
            Vec3 rotP = rotateY(v.position * inst.scale, inst.yaw);
            Vec3 rotN = rotateY(v.normal, inst.yaw);
            woodCompound.vertices.push_back(Vertex{rotP + inst.pos, rotN, v.uv, v.color});
        }
        for (uint32_t idx : treeData.woodMesh.indices) {
            woodCompound.indices.push_back(woodBase + idx);
        }

        uint32_t folBase = static_cast<uint32_t>(foliageCompound.vertices.size());
        for (const auto& v : treeData.foliageMesh.vertices) {
            Vec3 rotP = rotateY(v.position * inst.scale, inst.yaw);
            Vec3 rotN = rotateY(v.normal, inst.yaw);
            foliageCompound.vertices.push_back(Vertex{rotP + inst.pos, rotN, v.uv, v.color});
        }
        for (uint32_t idx : treeData.foliageMesh.indices) {
            foliageCompound.indices.push_back(folBase + idx);
        }
    }

    woodCompound.recomputeBounds();
    foliageCompound.recomputeBounds();

    ${charList.length > 0 ? `
    // 5. Build Architectural Scale Entourage Figures (Approach A: Studio Grey Clay Entourage)
    ScratchboxMesh entourageCompound("Adaptive_Entourage_Compound");
    entourageCompound.material.name = "Entourage_Studio_Clay";
    entourageCompound.material.roughnessFactor = 0.85f;
    entourageCompound.material.metallicFactor = 0.0f;
    entourageCompound.material.baseColorFactor = Vec4(0.55f, 0.57f, 0.60f, 1.0f);

    ${charList.map((charDef, idx) => {
        const charGender = charDef.genderBeta > 0.3 ? 'skinning::GenderMorph::Male'
                         : charDef.genderBeta < -0.3 ? 'skinning::GenderMorph::Female'
                         : 'skinning::GenderMorph::Neutral';
        const targetH = charDef.targetHeightMeters.toFixed(2);
        const posX = charDef.position[0].toFixed(2);
        const posZ = charDef.position[2].toFixed(2);
        const facingAngleDeg = charDef.facingAngleDeg ?? -25.0;
        const facingRad = (facingAngleDeg * Math.PI / 180.0).toFixed(4);
        const charName = charDef.name || 'Entourage Figure';
        const charRole = charDef.role || 'scale_figure';

        return `
    {
        // Character ${idx}: ${charName} (${charRole})
        SbHumanModel charModel = SbHumanModel::loadStandardModel(${charGender}, ${targetH}f);
        kinematics::Skeleton posedRig = charModel.skeleton;

        // Contrapposto / Natural Survey Stance:
        // Relax arms from horizontal T/A-pose down to side
        posedRig.setJointRotation("LeftShoulder", Vec3(0.06f, 0.08f, -1.18f));
        posedRig.setJointRotation("RightShoulder", Vec3(0.06f, -0.08f, 1.18f));
        posedRig.setJointRotation("LeftElbow", Vec3(0.18f, 0.15f, -0.12f));
        posedRig.setJointRotation("RightElbow", Vec3(0.18f, -0.15f, 0.12f));
        posedRig.setJointRotation("Spine1", Vec3(0.04f, 0.0f, 0.02f));
        posedRig.setJointRotation("Spine2", Vec3(0.02f, 0.0f, -0.01f));
        posedRig.setJointRotation("Head", Vec3(-0.06f, 0.12f, 0.0f));

        // Analytical 2-Bone IK Foot-to-Ground Clamp
        const float targetX = ${posX}f;
        const float targetZ = ${posZ}f;
        const float facingAngle = ${facingRad}f;

        // Ground/Surface elevation query (detects plinth or terrain)
        auto getSurfaceElevation = [&](float x, float z) -> float {
            float th = getTerrainHeight(x, z);
            float halfPW = ${(b.dimensions.width * 1.5 * 0.48).toFixed(2)}f;
            float halfPD = ${(b.dimensions.depth * 1.6 * 0.48).toFixed(2)}f;
            if (std::abs(x) <= halfPW && std::abs(z) <= halfPD) {
                return std::max(th, citadelMesh.bounds.min.y + 1.8f);
            }
            return th;
        };

        auto getSurfaceNormal = [&](float x, float z) -> Vec3 {
            float halfPW = ${(b.dimensions.width * 1.5 * 0.48).toFixed(2)}f;
            float halfPD = ${(b.dimensions.depth * 1.6 * 0.48).toFixed(2)}f;
            if (std::abs(x) <= halfPW && std::abs(z) <= halfPD) {
                return Vec3(0.0f, 1.0f, 0.0f);
            }
            return getTerrainNormal(x, z);
        };

        // Query foot rest positions
        int32_t lAnkleIdx = posedRig.findJoint("LeftAnkle");
        int32_t rAnkleIdx = posedRig.findJoint("RightAnkle");
        Vec3 lAnkleRest = (lAnkleIdx >= 0) ? posedRig.joints[lAnkleIdx].restPosition : Vec3(0.10f, 0.08f, 0.0f);
        Vec3 rAnkleRest = (rAnkleIdx >= 0) ? posedRig.joints[rAnkleIdx].restPosition : Vec3(-0.10f, 0.08f, 0.0f);

        Vec3 lFootRot = rotateY(Vec3(lAnkleRest.x, 0.0f, lAnkleRest.z), facingAngle);
        Vec3 rFootRot = rotateY(Vec3(rAnkleRest.x, 0.0f, rAnkleRest.z), facingAngle);
        float lFootX = targetX + lFootRot.x;
        float lFootZ = targetZ + lFootRot.z;
        float rFootX = targetX + rFootRot.x;
        float rFootZ = targetZ + rFootRot.z;

        float hL = getSurfaceElevation(lFootX, lFootZ);
        float hR = getSurfaceElevation(rFootX, rFootZ);
        Vec3 nL = getSurfaceNormal(lFootX, lFootZ);
        Vec3 nR = getSurfaceNormal(rFootX, rFootZ);

        float hBase = std::min(hL, hR);
        float deltaL = hL - hBase;
        float deltaR = hR - hBase;

        // Law of Cosines 2-Bone IK Leg Shortening for the elevated foot
        float legLength = 0.82f * (${targetH}f / 1.76f);
        float upperLeg = legLength * 0.52f;
        float lowerLeg = legLength * 0.48f;

        if (deltaL > 0.002f) {
            float targetReach = std::clamp(legLength - deltaL, 0.35f * legLength, legLength);
            float cosKnee = std::clamp((upperLeg * upperLeg + lowerLeg * lowerLeg - targetReach * targetReach) / (2.0f * upperLeg * lowerLeg), -1.0f, 1.0f);
            float kneeAngle = std::acos(cosKnee);
            posedRig.setJointRotation("LeftKnee", Vec3(kneeAngle, 0.0f, 0.0f));
            posedRig.setJointRotation("LeftHip", Vec3(-kneeAngle * 0.5f, 0.0f, 0.0f));
        }
        if (deltaR > 0.002f) {
            float targetReach = std::clamp(legLength - deltaR, 0.35f * legLength, legLength);
            float cosKnee = std::clamp((upperLeg * upperLeg + lowerLeg * lowerLeg - targetReach * targetReach) / (2.0f * upperLeg * lowerLeg), -1.0f, 1.0f);
            float kneeAngle = std::acos(cosKnee);
            posedRig.setJointRotation("RightKnee", Vec3(kneeAngle, 0.0f, 0.0f));
            posedRig.setJointRotation("RightHip", Vec3(-kneeAngle * 0.5f, 0.0f, 0.0f));
        }

        // Ankle alignment with local surface normal
        float pitchL = -std::atan2(nL.z, std::max(0.01f, nL.y));
        float rollL = std::atan2(nL.x, std::max(0.01f, nL.y));
        posedRig.setJointRotation("LeftAnkle", Vec3(pitchL, 0.0f, rollL));

        float pitchR = -std::atan2(nR.z, std::max(0.01f, nR.y));
        float rollR = std::atan2(nR.x, std::max(0.01f, nR.y));
        posedRig.setJointRotation("RightAnkle", Vec3(pitchR, 0.0f, rollR));

        // Evaluate posed mesh via Linear Blend Skinning
        ScratchboxMesh figureMesh = charModel.evaluatePosed(posedRig);

        // Ground contact alignment (0.00 mm floating / penetration)
        float modelMinY = figureMesh.bounds.min.y;
        float groundPlacementY = hBase - modelMinY;

        // Apply world orientation & 18% Studio Grey Clay tone
        Vec4 clayTone(0.55f, 0.57f, 0.60f, 1.0f);
        uint32_t charBaseIdx = static_cast<uint32_t>(entourageCompound.vertices.size());

        for (const auto& v : figureMesh.vertices) {
            Vec3 rotP = rotateY(v.position, facingAngle);
            Vec3 rotN = rotateY(v.normal, facingAngle);
            Vec3 worldP = rotP + Vec3(targetX, groundPlacementY, targetZ);
            entourageCompound.vertices.push_back(Vertex{worldP, rotN, v.uv, clayTone});
        }
        for (uint32_t idx : figureMesh.indices) {
            entourageCompound.indices.push_back(charBaseIdx + idx);
        }
    }
        `;
    }).join('\n')}

    entourageCompound.recomputeBounds();
    ` : ''}

    // 6. Serialize Multi-Mesh Binary glTF 2.0 (.glb)
    // Blender-Grade Contiguous Memory: Packing the world into unified compound buffers
    // guarantees minimal JavaScript object allocation in Three.js (0 GC stutter on update).
    std::vector<ScratchboxMesh> multiMeshes = {
        terrainMesh,
        citadelMesh,
        woodCompound,
        foliageCompound
    };
    ${(charList.length > 0) ? `if (!entourageCompound.vertices.empty()) { multiMeshes.push_back(entourageCompound); }` : ''}

    std::vector<uint8_t> glbData = io::GlbWriter::serializeMultiMeshToGlb(multiMeshes);

    std::ofstream glbFile(outGlbPath, std::ios::binary);
    if (!glbFile.is_open()) {
        std::cerr << "ERROR: Failed to open output path: " << outGlbPath << std::endl;
        return 1;
    }
    glbFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
    glbFile.close();

    size_t totalVerts = terrainMesh.vertices.size() + citadelMesh.vertices.size() + 
                        woodCompound.vertices.size() + foliageCompound.vertices.size()
                        ${(charList.length > 0) ? `+ entourageCompound.vertices.size()` : ''};
    size_t totalTris = (terrainMesh.indices.size() + citadelMesh.indices.size() + 
                        woodCompound.indices.size() + foliageCompound.indices.size()
                        ${(charList.length > 0) ? `+ entourageCompound.indices.size()` : ''}) / 3;

    std::cout << "SUCCESS: Wrote " << glbData.size() << " bytes to " << outGlbPath << std::endl;
    std::cout << "TOTAL_VERTS:" << totalVerts << std::endl;
    std::cout << "TOTAL_TRIS:" << totalTris << std::endl;
    return 0;
}
`;
    }

    /**
     * Synthesize, compile, and execute the C++ generator dynamically on the fly.
     */
    public async synthesizeAndCompile(
        contract: Adaptive3DSceneContract,
        options: { outputDir?: string; outputGlbPath?: string } = {}
    ): Promise<Adaptive3DSceneExecutionResult> {
        const sourceCode = this.generateCppSource(contract);
        const outputDir = options.outputDir || path.resolve(process.cwd(), 'build/3d-native');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outGlbPath = options.outputGlbPath || path.join(outputDir, `${contract.id}.glb`);

        // 1. Compile C++20 source code via Apple Clang
        const compileResult = await this.compiler.compileSource(sourceCode, {
            outputDir,
            outputBinaryName: contract.id,
            optimization: '-O3'
        });

        if (!compileResult.success || !compileResult.binaryPath) {
            const errorMsg = compileResult.diagnostics.map(d => `${d.file}:${d.line} - ${d.message}`).join('\n') || compileResult.compilerOutput;
            return {
                success: false,
                contract,
                sourceCode,
                vertexCount: 0,
                triangleCount: 0,
                compilationTimeMs: compileResult.compilationTimeMs,
                executionTimeMs: 0,
                error: `Compilation failed: ${errorMsg}`
            };
        }

        // 2. Execute binary
        const execResult = await this.compiler.executeBinary(compileResult.binaryPath, [outGlbPath], outputDir);

        if (!execResult.success) {
            return {
                success: false,
                contract,
                sourceCode,
                vertexCount: 0,
                triangleCount: 0,
                compilationTimeMs: compileResult.compilationTimeMs,
                executionTimeMs: execResult.executionTimeMs,
                error: `Execution failed (exit code ${execResult.exitCode}): ${execResult.stderr || execResult.stdout}`
            };
        }

        // 3. Extract mesh statistics and glb payload
        let vertexCount = 0;
        let triangleCount = 0;

        const vertMatch = execResult.stdout.match(/TOTAL_VERTS:(\d+)/);
        if (vertMatch) {
            vertexCount = parseInt(vertMatch[1], 10);
        }

        const triMatch = execResult.stdout.match(/TOTAL_TRIS:(\d+)/);
        if (triMatch) {
            triangleCount = parseInt(triMatch[1], 10);
        }

        let glbBase64: string | undefined;
        let finalGlbPath: string | undefined;

        if (fs.existsSync(outGlbPath)) {
            finalGlbPath = outGlbPath;
            glbBase64 = fs.readFileSync(outGlbPath).toString('base64');
        } else if (execResult.glbBase64) {
            glbBase64 = execResult.glbBase64;
        }

        return {
            success: true,
            contract,
            sourceCode,
            glbPath: finalGlbPath,
            glbBase64,
            vertexCount,
            triangleCount,
            compilationTimeMs: compileResult.compilationTimeMs,
            executionTimeMs: execResult.executionTimeMs
        };
    }

    /**
     * Perspective-aware chunked synthesis (Contribution 1 of the adaptive chunking paper).
     * Plans a set of depth-region chunks via AdaptiveSceneChunkPlanner, compiles each
     * chunk independently in parallel, and returns world-space origin metadata alongside
     * each chunk's GLB buffer so the caller can load them as separate Three.js Groups.
     */
    public async synthesizeChunked(
        contract: Adaptive3DSceneContract,
        options: { outputDir?: string; maxConcurrency?: number } = {}
    ): Promise<ChunkedSceneResult> {
        const planner = new AdaptiveSceneChunkPlanner();
        const plan = planner.plan(contract);
        const outputDir = options.outputDir || path.resolve(process.cwd(), 'build/3d-native');
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const concurrency = options.maxConcurrency ?? 4;
        const chunks = plan.chunks;
        const results: Adaptive3DSceneExecutionResult[] = new Array(chunks.length);

        // Process chunks in concurrency-limited batches
        for (let i = 0; i < chunks.length; i += concurrency) {
            const batch = chunks.slice(i, i + concurrency);
            const batchResults = await Promise.all(batch.map((desc, batchIdx) => {
                const chunkContract: Adaptive3DSceneContract = {
                    ...contract,
                    id: `${contract.id}_chunk_r${desc.regionIndex}_l${desc.lateralIndex}`,
                    chunkRegion: AdaptiveSceneChunkPlanner.toChunkRegion(desc)
                };
                const glbPath = path.join(outputDir, `${chunkContract.id}.glb`);
                return this.synthesizeAndCompile(chunkContract, { outputDir, outputGlbPath: glbPath });
            }));
            batchResults.forEach((r, batchIdx) => { results[i + batchIdx] = r; });
        }

        const totalVertexCount  = results.reduce((s, r) => s + r.vertexCount,  0);
        const totalTriangleCount = results.reduce((s, r) => s + r.triangleCount, 0);
        const allSucceeded       = results.every(r => r.success);

        return {
            chunks: results.map((r, idx) => ({
                originMeters: chunks[idx].originMeters,
                physicalExtentMeters: chunks[idx].physicalExtentMeters,
                regionIndex: chunks[idx].regionIndex,
                result: r
            })),
            plan,
            totalVertexCount,
            totalTriangleCount,
            success: allSucceeded
        };
    }
}
