#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_gltf_scene.hpp"
#include <iostream>
#include <vector>
#include <cmath>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::gltf;

int main() {
    std::string glbPath = "public/tiles/scan_studio_tile_esb_77197_98526.glb";
    GltfScene scene = GlbSceneReader::readFile(glbPath);
    if (!scene.ok) return 1;

    // Find triangles near ground level (Y between -5 and 5) that are horizontal (normal ~ (0,1,0))
    // These represent the streets and sidewalks!
    const auto& indices = scene.mesh.indices;
    const auto& vertices = scene.mesh.vertices;

    std::vector<Vec3> streetPoints;
    for (size_t i = 0; i < indices.size(); i += 3) {
        const auto& v0 = vertices[indices[i]];
        const auto& v1 = vertices[indices[i+1]];
        const auto& v2 = vertices[indices[i+2]];

        float cy = (v0.position.y + v1.position.y + v2.position.y) / 3.0f;
        if (cy >= -10.0f && cy <= 5.0f) {
            Vec3 edge1 = v1.position - v0.position;
            Vec3 edge2 = v2.position - v0.position;
            Vec3 norm = edge1.cross(edge2).normalized();
            if (norm.y > 0.85f) { // horizontal flat ground
                float cx = (v0.position.x + v1.position.x + v2.position.x) / 3.0f;
                float cz = (v0.position.z + v1.position.z + v2.position.z) / 3.0f;
                streetPoints.push_back(Vec3(cx, cy, cz));
            }
        }
    }
    std::cout << "Found " << streetPoints.size() << " ground/street points.\n";

    // Let's print point density in bands along X and Z
    // e.g., points near X = -100, -80, -60, -40, -20, 0, 20, 40, 60, 80, 100
    // and points along Z = -60, -40, -20, 0, 20, 40, 60
    // Specifically, let's look at the edges of the Empire State Building block!
    // 5th Ave should be at high X or low X or high Z or low Z?
    return 0;
}
