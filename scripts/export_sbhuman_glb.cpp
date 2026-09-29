#include "scratchbox_engine.hpp"
#include <iostream>
#include <fstream>

int main() {
    using namespace scratchbox;
    auto model = human::SbHumanModel::loadStandardModel(skinning::GenderMorph::Neutral, 1.75f);
    std::cout << "Loaded .sbhuman model: " << model.templateMesh.vertices.size() << " vertices, "
              << model.templateMesh.indices.size() / 3 << " triangles." << std::endl;

    model.templateMesh.name = "sbhuman_neutral";
    model.templateMesh.material.name = "sbhuman_skin_pbr";
    model.templateMesh.material.baseColorFactor = math::Vec4(0.82f, 0.72f, 0.65f, 1.0f);
    model.templateMesh.material.roughnessFactor = 0.45f;
    model.templateMesh.material.metallicFactor = 0.04f;

    auto glbBytes = io::GlbWriter::writeGlb(model.templateMesh);
    if (glbBytes.empty()) {
        std::cerr << "Failed to serialize .sbhuman to glTF binary" << std::endl;
        return 1;
    }

    std::ofstream out("public/models/sbhuman_canonical_preview.glb", std::ios::binary);
    if (!out.is_open()) {
        std::cerr << "Failed to open output file" << std::endl;
        return 2;
    }
    out.write(reinterpret_cast<const char*>(glbBytes.data()), glbBytes.size());
    out.close();

    std::cout << "Exported public/models/sbhuman_canonical_preview.glb (" << glbBytes.size() << " bytes)" << std::endl;
    return 0;
}
