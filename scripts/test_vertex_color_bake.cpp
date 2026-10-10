#include "scratchbox_engine.hpp"
#include "scratchbox_gltf_scene.hpp"
#include <iostream>

using namespace scratchbox;
using namespace scratchbox::gltf;

int main() {
    auto scene = GlbSceneReader::readFile("public/models/spce_scan_studio_cleaned_pbr.glb");
    if (!scene.ok) return 1;

    size_t coloredVerts = 0;
    const auto& indices = scene.mesh.indices;
    auto& verts = scene.mesh.vertices;

    for (size_t i = 0; i < indices.size(); i += 3) {
        uint32_t matIdx = (i / 3 < scene.triangleMaterial.size()) ? scene.triangleMaterial[i / 3] : 0;
        if (matIdx >= scene.materials.size()) continue;

        int imgIdx = scene.materials[matIdx].baseColorImage;
        if (imgIdx < 0 || imgIdx >= static_cast<int>(scene.images.size())) continue;

        const auto& img = scene.images[imgIdx];
        if (!img.decoded || img.pixels.data.empty()) continue;

        for (int vi = 0; vi < 3; ++vi) {
            auto& v = verts[indices[i + vi]];
            float u = v.uv.x - std::floor(v.uv.x);
            float vCoord = v.uv.y - std::floor(v.uv.y);
            Vec3 col = img.pixels.sampleBilinear(u, vCoord);
            v.color = math::Vec4(col.x, col.y, col.z, 1.0f);
            coloredVerts++;
        }
    }
    std::cout << "Successfully baked photogrammetric colors into " << coloredVerts << " vertices!" << std::endl;
    return 0;
}
