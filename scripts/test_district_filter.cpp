#include "scratchbox_engine.hpp"
#include "scratchbox_gltf_scene.hpp"
#include <iostream>

using namespace scratchbox;
using namespace scratchbox::gltf;

int main() {
    auto scene = GlbSceneReader::readFile("public/models/spce_scan_studio_cleaned_pbr.glb");
    if (!scene.ok) {
        std::cerr << "Failed: " << scene.error << std::endl;
        return 1;
    }
    
    // ESB Footprint: X in [-75, 45], Z in [-45, 45]
    size_t districtTris = 0;
    size_t esbTris = 0;
    
    const auto& indices = scene.mesh.indices;
    const auto& vertices = scene.mesh.vertices;
    
    for (size_t i = 0; i < indices.size(); i += 3) {
        const auto& p0 = vertices[indices[i]].position;
        const auto& p1 = vertices[indices[i+1]].position;
        const auto& p2 = vertices[indices[i+2]].position;
        
        float cx = (p0.x + p1.x + p2.x) / 3.0f;
        float cz = (p0.z + p1.z + p2.z) / 3.0f;
        
        if (cx >= -75.0f && cx <= 45.0f && cz >= -45.0f && cz <= 45.0f) {
            esbTris++;
        } else {
            districtTris++;
        }
    }
    
    std::cout << "Total Tris: " << indices.size() / 3 
              << " | ESB Tris to replace: " << esbTris 
              << " | Surrounding District Tris to preserve: " << districtTris << std::endl;
    return 0;
}
