#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_gltf_scene.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <algorithm>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::gltf;

int main() {
    GltfScene scene = GlbSceneReader::readFile("public/tiles/scan_studio_tile_esb_77197_98526.glb");
    if (!scene.ok) return 1;

    // Find all vertices belonging to the Empire State Building
    // In the raw scan, the ESB is the central structure connecting to the spire at (0, 427, 0).
    // Let's find all triangles connected upwards or within the parcel.
    // Let's look at the streets surrounding the ESB:
    // 5th Ave is on the East (+X). Where is the curb?
    // 6th Ave / Broadway is on the West (-X). Where is the curb?
    // 34th St is on the North (-Z or +Z?).
    // 33rd St is on the South (+Z or -Z?).

    // Let's inspect ground vertices (Y in [-2, 8]) around the central block:
    // Find where the sidewalks drop down to road level, or where street canyons exist.
    // Road surface in Manhattan is flat asphalt, typically at Y ~ 0 to 2m.
    std::cout << "Inspecting parcel boundaries in scan...\n";

    // Check X profile of high-geometry areas
    auto checkAxisProfile = [&](char axis) {
        std::cout << "\n--- Density Profile along " << axis << " (Y in [15, 60]m) ---\n";
        for (float val = -120.0f; val <= 120.0f; val += 5.0f) {
            size_t count = 0;
            for (const auto& v : scene.mesh.vertices) {
                if (v.position.y >= 15.0f && v.position.y <= 60.0f) {
                    float pos = (axis == 'X') ? v.position.x : v.position.z;
                    float cross = (axis == 'X') ? v.position.z : v.position.x;
                    if (std::abs(cross) < 40.0f && std::abs(pos - val) < 2.5f) {
                        count++;
                    }
                }
            }
            if (count > 0) {
                std::cout << "  " << axis << " = " << val << "m: " << count << " verts\n";
            }
        }
    };

    checkAxisProfile('X');
    checkAxisProfile('Z');

    return 0;
}
