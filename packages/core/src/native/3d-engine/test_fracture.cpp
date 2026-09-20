#include "scratchbox_engine.hpp"
#include <cassert>
#include <iostream>

int main() {
    using namespace scratchbox;
    using namespace scratchbox::fracture;

    std::cout << "[Test Fracture] Initializing glass pane and bullet configuration..." << std::endl;
    GlassPaneConfig pane;
    pane.width = 4.0f;
    pane.height = 3.0f;
    pane.thickness = 0.06f;

    BulletConfig bullet;
    bullet.caliber = 0.12f;
    bullet.length = 0.46f;
    bullet.speed = 820.0f;

    // 1. Frame generation
    auto frame = GlassFractureGenerator::generateFrame(pane);
    std::cout << "[Test Fracture] Frame generated with " << frame.vertices.size() << " vertices, " << frame.indices.size() << " indices." << std::endl;
    assert(frame.vertices.size() > 0);
    assert(frame.indices.size() > 0);

    // 2. Intact perimeter glass
    auto intact = GlassFractureGenerator::generateIntactGlassPerimeter(pane, pane.outerFractureRadius);
    std::cout << "[Test Fracture] Intact perimeter generated with " << intact.vertices.size() << " vertices." << std::endl;
    assert(intact.vertices.size() > 0);
    assert(intact.material.transmissionFactor > 0.9f);
    assert(intact.material.ior > 1.5f);

    // 3. Voronoi shards
    auto shards = GlassFractureGenerator::generateVoronoiShards(pane, bullet);
    std::cout << "[Test Fracture] Generated " << shards.size() << " Voronoi shards." << std::endl;
    assert(shards.size() >= 40);

    for (size_t i = 0; i < std::min<size_t>(5, shards.size()); ++i) {
        assert(shards[i].localMesh.vertices.size() > 0);
        assert(shards[i].linearVelocity.length() > 0.0f);
        assert(shards[i].angularVelocity.length() > 0.0f);
    }

    // 4. Bullet mesh
    auto bulletMesh = GlassFractureGenerator::generateBulletMesh(bullet, {0, 0, 0.2f});
    std::cout << "[Test Fracture] Bullet mesh generated with " << bulletMesh.vertices.size() << " vertices." << std::endl;
    assert(bulletMesh.vertices.size() > 0);
    assert(bulletMesh.material.metallicFactor > 0.8f);

    // 5. Mach shockwave cone
    auto shockwave = GlassFractureGenerator::generateSupersonicMachCone(bullet, {0, 0, 0.2f});
    std::cout << "[Test Fracture] Supersonic Mach cone generated with " << shockwave.vertices.size() << " vertices." << std::endl;
    assert(shockwave.vertices.size() > 0);

    // 6. Complete Scene Assembly & Serialization to .glb
    auto sceneMesh = GlassFractureGenerator::buildCompleteScene(pane, bullet, 0.08f);
    std::cout << "[Test Fracture] Complete scene assembled with " << sceneMesh.vertices.size() << " vertices, " << sceneMesh.indices.size() << " indices." << std::endl;
    assert(sceneMesh.vertices.size() > 1000);

    std::vector<uint8_t> glbData = scratchbox::io::GlbWriter::writeGlb(sceneMesh);
    std::cout << "[Test Fracture] Serialized binary glTF (.glb) size: " << glbData.size() << " bytes." << std::endl;
    assert(glbData.size() > 1000);
    // Check GLB header magic 'glTF' (0x46546C67)
    assert(glbData[0] == 'g' && glbData[1] == 'l' && glbData[2] == 'T' && glbData[3] == 'F');

    std::cout << "[Test Fracture] All C++20 fracture and ballistics tests PASSED successfully!" << std::endl;
    return 0;
}
