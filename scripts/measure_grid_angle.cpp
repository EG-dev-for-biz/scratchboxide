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
    GltfScene scanScene = GlbSceneReader::readFile("public/tiles/scan_studio_tile_esb_77197_98526.glb");
    if (!scanScene.ok) return 1;

    // We want to find the angle of the street edges in the scan.
    // For every edge (v0, v1) in the mesh where both vertices are near ground (Y in [-5, 10])
    // and edge length is between 2m and 30m, compute angle theta = atan2(dz, dx).
    const auto& indices = scanScene.mesh.indices;
    const auto& vertices = scanScene.mesh.vertices;

    std::vector<float> edgeAngles;
    for (size_t i = 0; i < indices.size(); i += 3) {
        for (int e = 0; e < 3; ++e) {
            const auto& va = vertices[indices[i + e]];
            const auto& vb = vertices[indices[i + ((e + 1) % 3)]];
            if (va.position.y >= -5.0f && va.position.y <= 15.0f &&
                vb.position.y >= -5.0f && vb.position.y <= 15.0f) {
                float dx = vb.position.x - va.position.x;
                float dz = vb.position.z - va.position.z;
                float len = std::hypot(dx, dz);
                if (len > 3.0f && len < 40.0f) {
                    float ang = std::atan2(dz, dx) * 180.0f / 3.14159265358979f;
                    // Fold into [0, 90) because grid is orthogonal
                    while (ang < 0.0f) ang += 180.0f;
                    while (ang >= 90.0f) ang -= 90.0f;
                    edgeAngles.push_back(ang);
                }
            }
        }
    }

    std::cout << "Collected " << edgeAngles.size() << " ground edge segments.\n";

    // Bin in 0.5 degree bins from 0 to 90
    int bins[180] = {0};
    for (float a : edgeAngles) {
        int b = static_cast<int>(std::floor(a * 2.0f));
        if (b >= 0 && b < 180) bins[b]++;
    }

    int maxCount = 0;
    int bestBin = -1;
    for (int i = 0; i < 180; ++i) {
        if (bins[i] > maxCount) {
            maxCount = bins[i];
            bestBin = i;
        }
    }

    float dominantAngle = (bestBin + 0.5f) * 0.5f;
    std::cout << "Dominant Grid Angle in Scan: " << dominantAngle << " degrees (bin count = " << maxCount << ")\n";

    // Print top 5 bins
    std::vector<std::pair<int, float>> sortedBins;
    for (int i = 0; i < 180; ++i) {
        sortedBins.push_back({bins[i], (i + 0.5f) * 0.5f});
    }
    std::sort(sortedBins.rbegin(), sortedBins.rend());
    std::cout << "Top 5 Angle Peaks:\n";
    for (int i = 0; i < 5; ++i) {
        std::cout << "  " << sortedBins[i].second << " deg (" << sortedBins[i].first << " edges)\n";
    }

    return 0;
}
