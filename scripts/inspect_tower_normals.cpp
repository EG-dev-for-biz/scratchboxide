#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_gltf_scene.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <map>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::gltf;

int main() {
    std::string glbPath = "public/tiles/scan_studio_tile_esb_77197_98526.glb";
    GltfScene scene = GlbSceneReader::readFile(glbPath);
    if (!scene.ok) return 1;

    const auto& indices = scene.mesh.indices;
    const auto& vertices = scene.mesh.vertices;

    std::vector<float> wallAngles;
    for (size_t i = 0; i < indices.size(); i += 3) {
        const auto& v0 = vertices[indices[i]];
        const auto& v1 = vertices[indices[i+1]];
        const auto& v2 = vertices[indices[i+2]];

        float cy = (v0.position.y + v1.position.y + v2.position.y) / 3.0f;
        float cx = (v0.position.x + v1.position.x + v2.position.x) / 3.0f;
        float cz = (v0.position.z + v1.position.z + v2.position.z) / 3.0f;

        // In tower shaft (120m to 250m) and within 40m of center
        if (cy >= 120.0f && cy <= 250.0f && std::hypot(cx, cz) < 40.0f) {
            Vec3 edge1 = v1.position - v0.position;
            Vec3 edge2 = v2.position - v0.position;
            Vec3 norm = edge1.cross(edge2).normalized();

            // Check if vertical wall (normal roughly horizontal: |norm.y| < 0.25)
            if (std::abs(norm.y) < 0.25f) {
                float angle = std::atan2(norm.z, norm.x) * 180.0f / 3.14159265358979f;
                wallAngles.push_back(angle);
            }
        }
    }

    std::cout << "Collected " << wallAngles.size() << " vertical wall triangle normals in tower shaft.\n";

    int bins[360] = {0};
    for (float a : wallAngles) {
        int b = static_cast<int>(std::round(a)) % 360;
        if (b < 0) b += 360;
        bins[b]++;
    }

    std::vector<std::pair<int, int>> sortedBins;
    for (int i = 0; i < 360; ++i) {
        if (bins[i] > 10) sortedBins.push_back({bins[i], i});
    }
    std::sort(sortedBins.rbegin(), sortedBins.rend());

    std::cout << "\nTop Normal Peak Angles:\n";
    for (size_t i = 0; i < std::min((size_t)10, sortedBins.size()); ++i) {
        std::cout << "  Bin " << sortedBins[i].second << " deg: " << sortedBins[i].first << " hits\n";
    }

    return 0;
}
