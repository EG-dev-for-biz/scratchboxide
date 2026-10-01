#include "scratchbox_engine.hpp"
#include <iostream>
#include <vector>
#include <cmath>

int main() {
    using namespace scratchbox::geometry;
    using namespace scratchbox::math;
    using namespace scratchbox::shaper;

    std::cout << "[Scratchbox Engine] Baking procedural 3D architectural asset..." << std::endl;

    // 1. Construct Base Parametric Lofted Cross-Sections
    std::vector<std::vector<Vec3>> slices;
    const int numSlices = 10;
    const int ptsPerSlice = 16;
    const float height = 8.0f;

    for (int s = 0; s < numSlices; ++s) {
        float t = static_cast<float>(s) / (numSlices - 1);
        float y = (t - 0.5f) * height;
        float baseRadius = 1.2f + 0.6f * std::sin(t * PI);

        std::vector<Vec3> slicePts;
        for (int p = 0; p < ptsPerSlice; ++p) {
            float angle = (static_cast<float>(p) / ptsPerSlice) * TWO_PI;
            float rx = baseRadius * (1.0f + 0.2f * std::cos(angle * 2.0f));
            float rz = baseRadius * 0.7f;
            slicePts.push_back(Vec3(std::cos(angle) * rx, y, std::sin(angle) * rz));
        }
        slices.push_back(slicePts);
    }

    ScratchboxMesh shaped = Loft3D::skin(slices, true, Vec4(0.85f, 0.90f, 0.98f, 1.0f));
    shaped.name = "procedural_sculpture_monolith";
    shaped.material = PbrMaterial::titanium();

    // 2. Non-Linear Deformations: Taper and Twist
    Deformer::taper(shaped, Axis::Y, 0.45f, -height * 0.5f, height * 0.5f, 1.2f);
    Deformer::twist(shaped, Axis::Y, PI * 0.75f, -height * 0.5f, height * 0.5f);

    // 3. Digital Sculpt Strokes: Clay Build-up
    SculptEngine::applyStroke(shaped, SculptBrush::Clay, Vec3(0, 1.0f, 0.8f), 1.8f, 0.35f, Vec3(0, 0, 1));

    // 4. Topology Clean and Normals Recomputation
    MeshTopologyCleaner::removeDegenerateFaces(shaped);
    shaped.recomputeSmoothNormals();

    std::cout << "[Scratchbox Engine] Generated mesh with " << shaped.vertices.size() << " vertices, " 
              << shaped.indices.size() << " indices." << std::endl;

    // 5. Stream binary glTF 2.0 (.glb) chunk
    scratchbox::io::GlbWriter::streamChunk(shaped, "procedural_sculpture_monolith");
    std::cout << "[Scratchbox Engine] Streamed binary glTF 2.0 chunk successfully." << std::endl;

    return 0;
}
