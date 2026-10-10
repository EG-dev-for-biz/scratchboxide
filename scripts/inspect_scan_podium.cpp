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
    std::string glbPath = "public/tiles/scan_studio_tile_esb_77197_98526.glb";
    GltfScene scene = GlbSceneReader::readFile(glbPath);
    if (!scene.ok) return 1;

    // Look at vertices in the central block where the ESB is located:
    // Let's find all vertices in Y in [0, 25] within X in [-100, 100], Z in [-100, 100]
    // And see the distribution of X and Z to find the exact street boundaries!
    
    // In Manhattan, 5th Ave is to the East, 6th Ave is to the West.
    // 34th Street is to the North, 33rd Street is to the South.
    // Let's check the X span and Z span of the ground parcel.
    std::vector<float> xCoords, zCoords;
    for (const auto& v : scene.mesh.vertices) {
        if (v.position.y >= 2.0f && v.position.y <= 25.0f) {
            if (std::abs(v.position.x) < 120.0f && std::abs(v.position.z) < 80.0f) {
                xCoords.push_back(v.position.x);
                zCoords.push_back(v.position.z);
            }
        }
    }
    std::sort(xCoords.begin(), xCoords.end());
    std::sort(zCoords.begin(), zCoords.end());

    std::cout << "Vertices in central region: " << xCoords.size() << "\n";
    if (!xCoords.empty()) {
        std::cout << "X Percentiles: 1%=" << xCoords[xCoords.size() * 0.01]
                  << " 5%=" << xCoords[xCoords.size() * 0.05]
                  << " 10%=" << xCoords[xCoords.size() * 0.10]
                  << " 50%=" << xCoords[xCoords.size() * 0.50]
                  << " 90%=" << xCoords[xCoords.size() * 0.90]
                  << " 95%=" << xCoords[xCoords.size() * 0.95]
                  << " 99%=" << xCoords[xCoords.size() * 0.99] << "\n";
        std::cout << "Z Percentiles: 1%=" << zCoords[zCoords.size() * 0.01]
                  << " 5%=" << zCoords[zCoords.size() * 0.05]
                  << " 10%=" << zCoords[zCoords.size() * 0.10]
                  << " 50%=" << zCoords[zCoords.size() * 0.50]
                  << " 90%=" << zCoords[zCoords.size() * 0.90]
                  << " 95%=" << zCoords[zCoords.size() * 0.95]
                  << " 99%=" << zCoords[zCoords.size() * 0.99] << "\n";
    }

    // Now let's examine triangles in the scan that have high Y (> 100m)
    // and find their X and Z bounds!
    float minTowerX = 1e9, maxTowerX = -1e9;
    float minTowerZ = 1e9, maxTowerZ = -1e9;
    for (const auto& v : scene.mesh.vertices) {
        if (v.position.y > 100.0f && std::hypot(v.position.x, v.position.z) < 70.0f) {
            minTowerX = std::min(minTowerX, v.position.x);
            maxTowerX = std::max(maxTowerX, v.position.x);
            minTowerZ = std::min(minTowerZ, v.position.z);
            maxTowerZ = std::max(maxTowerZ, v.position.z);
        }
    }
    std::cout << "\nTower Bounds (Y > 100m): X in [" << minTowerX << ", " << maxTowerX 
              << "] (width " << (maxTowerX - minTowerX) << "m), Z in [" 
              << minTowerZ << ", " << maxTowerZ << "] (depth " << (maxTowerZ - minTowerZ) << "m)\n";
    std::cout << "Tower Center: X = " << (minTowerX + maxTowerX) * 0.5f 
              << ", Z = " << (minTowerZ + maxTowerZ) * 0.5f << "\n";

    // Now let's examine the podium bounds (Y between 20m and 35m) for the ESB:
    float minPodX = 1e9, maxPodX = -1e9;
    float minPodZ = 1e9, maxPodZ = -1e9;
    for (const auto& v : scene.mesh.vertices) {
        if (v.position.y >= 5.0f && v.position.y <= 30.0f) {
            // Must be within 85m of origin in X and 55m in Z
            if (std::abs(v.position.x) <= 85.0f && std::abs(v.position.z) <= 55.0f) {
                minPodX = std::min(minPodX, v.position.x);
                maxPodX = std::max(maxPodX, v.position.x);
                minPodZ = std::min(minPodZ, v.position.z);
                maxPodZ = std::max(maxPodZ, v.position.z);
            }
        }
    }
    std::cout << "\nPodium Bounds (Y in [20, 35]m): X in [" << minPodX << ", " << maxPodX 
              << "] (width " << (maxPodX - minPodX) << "m), Z in [" 
              << minPodZ << ", " << maxPodZ << "] (depth " << (maxPodZ - minPodZ) << "m)\n";
    std::cout << "Podium Center: X = " << (minPodX + maxPodX) * 0.5f 
              << ", Z = " << (minPodZ + maxPodZ) * 0.5f << "\n";

    return 0;
}
