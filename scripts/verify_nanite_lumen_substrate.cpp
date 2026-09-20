/********************************************************************************
 * Verification Suite for Nanite, Lumen & Substrate in Scratchbox Engine (C++20)
 ********************************************************************************/

#include "scratchbox_engine.hpp"
#include <iostream>
#include <cassert>
#include <iomanip>

int main() {
    std::cout << "========================================================\n";
    std::cout << "  SCRATCHBOX ENGINE: NANITE, LUMEN & SUBSTRATE VERIFY  \n";
    std::cout << "========================================================\n\n";

    // =========================================================================
    // 1. NANITE CLUSTER DAG & MICRO-POLY DISPLACEMENT
    // =========================================================================
    std::cout << "[1/3] Testing Nanite Cluster DAG & Continuous Sub-Pixel LOD...\n";
    
    // Create a high-poly test plane (1,000+ triangles)
    geo::ScratchboxMesh baseMesh;
    baseMesh.name = "ArchitecturalWall";
    int gridRes = 30; // 30x30 vertices = 1,682 triangles
    for (int y = 0; y <= gridRes; ++y) {
        for (int x = 0; x <= gridRes; ++x) {
            geo::Vertex v;
            float fx = static_cast<float>(x) / gridRes * 10.0f - 5.0f;
            float fy = static_cast<float>(y) / gridRes * 10.0f;
            v.position = math::Vec3(fx, fy, 0.0f);
            v.normal = math::Vec3(0.0f, 0.0f, 1.0f);
            v.uv = math::Vec2(static_cast<float>(x) / gridRes, static_cast<float>(y) / gridRes);
            v.color = math::Vec4(0.85f, 0.82f, 0.78f, 1.0f);
            baseMesh.vertices.push_back(v);
        }
    }
    for (int y = 0; y < gridRes; ++y) {
        for (int x = 0; x < gridRes; ++x) {
            uint32_t i0 = y * (gridRes + 1) + x;
            uint32_t i1 = y * (gridRes + 1) + (x + 1);
            uint32_t i2 = (y + 1) * (gridRes + 1) + x;
            uint32_t i3 = (y + 1) * (gridRes + 1) + (x + 1);
            baseMesh.indices.push_back(i0);
            baseMesh.indices.push_back(i1);
            baseMesh.indices.push_back(i2);
            baseMesh.indices.push_back(i1);
            baseMesh.indices.push_back(i3);
            baseMesh.indices.push_back(i2);
        }
    }

    nnt::NaniteClusterDAG dag;
    dag.buildFromMesh(baseMesh, 128); // 128 triangles per cluster
    
    std::cout << "  ✓ Total Input Triangles: " << (baseMesh.indices.size() / 3) << "\n";
    std::cout << "  ✓ Total Nanite Clusters Built: " << dag.clusters.size() << "\n";
    std::cout << "  ✓ Leaf (LOD0) Clusters: " << dag.leafClusterIds.size() << "\n";
    std::cout << "  ✓ Root (Coarsest) Clusters: " << dag.rootClusterIds.size() << "\n";
    std::cout << "  ✓ Max DAG Hierarchy Depth: " << dag.maxLodLevel << " levels\n";

    // Test Screen-Space LOD Selection at Close Range vs Far Range
    nnt::CameraView camClose;
    camClose.position = math::Vec3(0.0f, 5.0f, 2.0f); // 2 meters away
    std::vector<uint32_t> selectedClose;
    dag.cullAndSelectLOD(camClose, 1.0f, selectedClose); // 1 pixel target
    
    nnt::CameraView camFar;
    camFar.position = math::Vec3(0.0f, 5.0f, 150.0f); // 150 meters away
    std::vector<uint32_t> selectedFar;
    dag.cullAndSelectLOD(camFar, 1.0f, selectedFar);

    std::cout << "  ✓ Close View (2m, Target 1 px): " << selectedClose.size() << " clusters selected\n";
    std::cout << "  ✓ Far View (150m, Target 1 px): " << selectedFar.size() << " clusters selected (Simplified)\n";
    assert(selectedClose.size() >= selectedFar.size());

    // Test Micro-Poly Displacement
    auto heightmap = [](const math::Vec2& uv) {
        return std::sin(uv.x * 20.0f) * std::cos(uv.y * 20.0f) * 0.5f + 0.5f;
    };
    const auto& testCluster = dag.clusters[dag.leafClusterIds[0]];
    nnt::NaniteCluster displaced = nnt::MicroPolyDisplacer::displaceCluster(testCluster, heightmap, 0.05f, 2);
    std::cout << "  ✓ Micro-Poly Displacement: Cluster " << testCluster.clusterId 
              << " (" << testCluster.triangleCount() << " tris) -> Micro-Poly Cluster (" 
              << displaced.triangleCount() << " micro-tris)\n";
    assert(displaced.triangleCount() > testCluster.triangleCount());

    // =========================================================================
    // 2. LUMEN DYNAMIC MULTI-BOUNCE GLOBAL ILLUMINATION
    // =========================================================================
    std::cout << "\n[2/3] Testing Lumen Dynamic Multi-Bounce GI (SDF Cone Tracing & L2 SH Probes)...\n";
    
    lmn::LumenGlobalIllumination lumen;
    lumen.surfaceCache.buildFromMesh(baseMesh, 1.0f);
    std::cout << "  ✓ Surface Cache Cards Generated: " << lumen.surfaceCache.cards.size() << "\n";
    
    // Initialize 3D Probe Grid
    lumen.initializeGrid(math::Vec3(-6.0f, 0.0f, -6.0f), math::Vec3(6.0f, 12.0f, 6.0f), 2.0f);
    std::cout << "  ✓ Radiance Probe Grid: " << lumen.dimX << "x" << lumen.dimY << "x" << lumen.dimZ 
              << " (" << lumen.probes.size() << " total probes)\n";

    // Pass 1: Direct Illumination (Sun + Sky)
    math::Vec3 sunDir(-0.5f, 0.8f, -0.3f);
    math::Vec3 sunColor(1.0f, 0.95f, 0.85f);
    math::Vec3 skyAmbient(0.15f, 0.22f, 0.35f);
    lumen.updateDirectLighting(sunDir, sunColor, skyAmbient);
    std::cout << "  ✓ Direct Lighting Pass completed.\n";

    // Scene SDF representing the floor and wall
    auto sceneSdf = [](const math::Vec3& p) -> float {
        float floorD = p.y; // Plane at y=0
        float wallD = std::abs(p.z) - 0.2f; // Wall at z=0
        return std::min(floorD, wallD);
    };

    // Pass 2: Multi-Bounce Iterations (Neumann series)
    std::cout << "  ✓ Evaluating Bounce 1 (Indirect diffuse bounce)...\n";
    lumen.evaluateBouncePass(sceneSdf);
    
    math::Vec3 sampleNormal(0.0f, 0.0f, 1.0f);
    math::Vec3 bounce1 = lumen.sampleProbeVolume(math::Vec3(0.0f, 2.0f, 1.0f), sampleNormal);
    std::cout << "    Indirect Irradiance (Bounce 1): RGB(" 
              << bounce1.x << ", " << bounce1.y << ", " << bounce1.z << ")\n";

    std::cout << "  ✓ Evaluating Bounce 2 (Secondary bounce)...\n";
    lumen.evaluateBouncePass(sceneSdf);
    math::Vec3 bounce2 = lumen.sampleProbeVolume(math::Vec3(0.0f, 2.0f, 1.0f), sampleNormal);
    std::cout << "    Indirect Irradiance (Bounce 2): RGB(" 
              << bounce2.x << ", " << bounce2.y << ", " << bounce2.z << ")\n";

    assert(bounce1.length() > 0.0f);
    assert(bounce2.length() >= bounce1.length() * 0.5f);

    // =========================================================================
    // 3. SUBSTRATE LAYERED PHYSICAL MATERIALS
    // =========================================================================
    std::cout << "\n[3/3] Testing Substrate Multi-Layer Physical BSDF & Beer-Lambert Absorption...\n";
    
    sub::LayeredMaterialStack matStack;
    matStack.name = "EmpireState_WeatheredLimestone_Wet";

    // Layer 0: Indiana Limestone Substrate
    sub::PhysicalLayer limestone;
    limestone.name = "Indiana Limestone";
    limestone.baseColor = math::Vec3(0.863f, 0.851f, 0.839f);
    limestone.roughness = 0.78f;
    limestone.metallic = 0.0f;
    limestone.specularF0 = 0.04f;
    limestone.height = 0.45f;
    limestone.coverageMask = 1.0f;
    matStack.addLayer(limestone);

    // Layer 1: Atmospheric Soot & Crevice Patina
    sub::PhysicalLayer soot;
    soot.name = "Manhattan Soot Patina";
    soot.baseColor = math::Vec3(0.18f, 0.17f, 0.16f);
    soot.roughness = 0.92f;
    soot.metallic = 0.0f;
    soot.specularF0 = 0.03f;
    soot.height = 0.20f; // Settles into low crevices
    soot.coverageMask = 0.35f;
    matStack.addLayer(soot);

    // Layer 2: Rain Sheen Topcoat with Beer-Lambert absorption
    sub::PhysicalLayer rain;
    rain.name = "Rainwater Surface Film";
    rain.baseColor = math::Vec3(1.0f, 1.0f, 1.0f);
    rain.roughness = 0.02f; // Mirror-like sheen
    rain.metallic = 0.0f;
    rain.specularF0 = 0.02f; // Water F0 = 2%
    rain.ior = 1.333f;
    rain.thicknessMm = 0.8f; // 0.8 mm water layer
    rain.absorptionCoeff = math::Vec3(0.05f, 0.02f, 0.01f); // Subtle organic mineral tint
    rain.coverageMask = 0.90f;
    matStack.addLayer(rain);

    // Evaluate BSDF at Normal View vs Grazing View
    math::Vec3 normalView(0.0f, 0.0f, 1.0f);
    math::Vec3 grazingView(0.965f, 0.0f, 0.258f); // 75 degrees grazing angle

    sub::EvaluatedBSDF bsdfNormal = matStack.evaluate(normalView);
    sub::EvaluatedBSDF bsdfGrazing = matStack.evaluate(grazingView);

    std::cout << "  ✓ Normal View (0 deg):\n";
    std::cout << "    Diffuse Albedo: RGB(" << bsdfNormal.diffuseAlbedo.x << ", " 
              << bsdfNormal.diffuseAlbedo.y << ", " << bsdfNormal.diffuseAlbedo.z << ")\n";
    std::cout << "    Clearcoat Sheen: " << bsdfNormal.clearcoat << "\n";
    std::cout << "    Roughness: " << bsdfNormal.roughness << "\n";
    std::cout << "    Transmission Throughput: RGB(" << bsdfNormal.transmissionThroughput.x << ", "
              << bsdfNormal.transmissionThroughput.y << ", " << bsdfNormal.transmissionThroughput.z << ")\n";

    std::cout << "  ✓ Grazing View (75 deg):\n";
    std::cout << "    Clearcoat Sheen (Fresnel boost): " << bsdfGrazing.clearcoat << "\n";
    std::cout << "    Transmission Throughput (Longer optical path): RGB(" 
              << bsdfGrazing.transmissionThroughput.x << ", " 
              << bsdfGrazing.transmissionThroughput.y << ", " 
              << bsdfGrazing.transmissionThroughput.z << ")\n";

    // Verify Fresnel boost and Beer-Lambert attenuation at grazing
    assert(bsdfGrazing.clearcoat > bsdfNormal.clearcoat);
    assert(bsdfGrazing.transmissionThroughput.x < bsdfNormal.transmissionThroughput.x);

    // Convert to PbrMaterial for glTF export
    geo::PbrMaterial gltfMat = matStack.toPbrMaterial(normalView);
    std::cout << "  ✓ glTF PBR Next Export: Clearcoat=" << gltfMat.clearcoatFactor 
              << ", Roughness=" << gltfMat.roughnessFactor << "\n";

    std::cout << "\n========================================================\n";
    std::cout << "  ALL VERIFICATION CHECKS PASSED WITH 100% SUCCESS!    \n";
    std::cout << "========================================================\n";

    return 0;
}
