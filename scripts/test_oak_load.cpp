#include "scratchbox_engine.hpp"
#include "scratchbox_gltf_scene.hpp"
#include <iostream>

using namespace scratchbox;
using namespace scratchbox::gltf;

int main() {
    auto scene = GlbSceneReader::readFile("public/models/sb_veggie_oak.glb");
    if (!scene.ok) {
        std::cerr << "Failed: " << scene.error << std::endl;
        return 1;
    }
    std::cout << "Loaded oak successfully: " << scene.mesh.vertices.size() << " verts, "
              << scene.mesh.indices.size() / 3 << " tris, "
              << scene.materials.size() << " mats, "
              << scene.images.size() << " images." << std::endl;
    return 0;
}
