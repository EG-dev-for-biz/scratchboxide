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
    if (!scene.ok) {
        std::cerr << "Failed to read GLB: " << scene.error << "\n";
        return 1;
    }

    std::cout << "Loaded GLB: " << scene.mesh.vertices.size() << " verts, " 
              << scene.mesh.indices.size() / 3 << " triangles\n";

    // 1. Find bounding box of the entire tile
    Vec3 minTile(1e9f, 1e9f, 1e9f), maxTile(-1e9f, -1e9f, -1e9f);
    for (const auto& v : scene.mesh.vertices) {
        minTile.x = std::min(minTile.x, v.position.x);
        minTile.y = std::min(minTile.y, v.position.y);
        minTile.z = std::min(minTile.z, v.position.z);
        maxTile.x = std::max(maxTile.x, v.position.x);
        maxTile.y = std::max(maxTile.y, v.position.y);
        maxTile.z = std::max(maxTile.z, v.position.z);
    }
    std::cout << "Tile BBox: Min(" << minTile.x << ", " << minTile.y << ", " << minTile.z 
              << ") Max(" << maxTile.x << ", " << maxTile.y << ", " << maxTile.z << ")\n";

    // 2. High altitude vertices (Tower shaft & Spire)
    Vec3 highestPoint(0, -1e9f, 0);
    for (const auto& v : scene.mesh.vertices) {
        if (v.position.y > highestPoint.y) {
            highestPoint = v.position;
        }
    }
    std::cout << "Highest Point (Spire Peak): (" << highestPoint.x << ", " 
              << highestPoint.y << ", " << highestPoint.z << ")\n";

    // 3. Center of mass of the tower at various heights
    auto findSliceCenter = [&](float yMin, float yMax) {
        Vec3 sum(0, 0, 0);
        Vec3 minB(1e9f, 1e9f, 1e9f), maxB(-1e9f, -1e9f, -1e9f);
        size_t count = 0;
        for (const auto& v : scene.mesh.vertices) {
            if (v.position.y >= yMin && v.position.y <= yMax) {
                float distXZ = std::hypot(v.position.x - highestPoint.x, v.position.z - highestPoint.z);
                if (distXZ < 90.0f) {
                    sum += v.position;
                    minB.x = std::min(minB.x, v.position.x);
                    minB.y = std::min(minB.y, v.position.y);
                    minB.z = std::min(minB.z, v.position.z);
                    maxB.x = std::max(maxB.x, v.position.x);
                    maxB.y = std::max(maxB.y, v.position.y);
                    maxB.z = std::max(maxB.z, v.position.z);
                    count++;
                }
            }
        }
        if (count > 0) {
            Vec3 avg = sum * (1.0f / count);
            std::cout << "Slice [" << yMin << ", " << yMax << "] m: Count=" << count 
                      << " Center=(" << avg.x << ", " << avg.y << ", " << avg.z << ")"
                      << " SpanX=" << (maxB.x - minB.x) << " SpanZ=" << (maxB.z - minB.z)
                      << " MinX=" << minB.x << " MaxX=" << maxB.x 
                      << " MinZ=" << minB.z << " MaxZ=" << maxB.z << "\n";
        }
    };

    findSliceCenter(350.0f, 400.0f);
    findSliceCenter(250.0f, 300.0f);
    findSliceCenter(150.0f, 200.0f);
    findSliceCenter(50.0f, 100.0f);
    findSliceCenter(5.0f, 25.0f);

    // 4. Determine building orientation / principal axes at podium level (Y = 10m to 25m)
    std::vector<std::pair<float, float>> podiumPts;
    for (const auto& v : scene.mesh.vertices) {
        if (v.position.y >= 5.0f && v.position.y <= 25.0f) {
            float distXZ = std::hypot(v.position.x - highestPoint.x, v.position.z - highestPoint.z);
            if (distXZ < 80.0f) {
                podiumPts.push_back({v.position.x, v.position.z});
            }
        }
    }

    if (podiumPts.size() > 100) {
        float meanX = 0, meanZ = 0;
        for (const auto& p : podiumPts) {
            meanX += p.first;
            meanZ += p.second;
        }
        meanX /= podiumPts.size();
        meanZ /= podiumPts.size();

        float covXX = 0, covXZ = 0, covZZ = 0;
        for (const auto& p : podiumPts) {
            float dx = p.first - meanX;
            float dz = p.second - meanZ;
            covXX += dx * dx;
            covXZ += dx * dz;
            covZZ += dz * dz;
        }

        float theta = 0.5f * std::atan2(2.0f * covXZ, covXX - covZZ);
        float thetaDeg = theta * 180.0f / 3.14159265358979f;
        std::cout << "\nPodium Footprint Analysis:\n";
        std::cout << "  Mean Center: (" << meanX << ", " << meanZ << ")\n";
        std::cout << "  Principal Axis Rotation Angle theta: " << thetaDeg << " degrees\n";
    }

    return 0;
}
