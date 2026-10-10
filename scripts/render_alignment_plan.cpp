#include "scratchbox_math.hpp"
#include "scratchbox_geometry.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_gltf_scene.hpp"
#include <iostream>
#include <vector>
#include <cmath>
#include <fstream>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::gltf;

int main() {
    const int W = 1024, H = 1024;
    std::vector<uint8_t> img(W * H * 3, 30); // dark grey background

    auto project = [&](float x, float z, int& px, int& py) {
        px = static_cast<int>((x + 150.0f) / 300.0f * (W - 1));
        py = static_cast<int>((z + 150.0f) / 300.0f * (H - 1));
        return (px >= 0 && px < W && py >= 0 && py < H);
    };

    auto drawPixel = [&](int px, int py, uint8_t r, uint8_t g, uint8_t b) {
        if (px >= 0 && px < W && py >= 0 && py < H) {
            int idx = (py * W + px) * 3;
            img[idx] = r;
            img[idx+1] = g;
            img[idx+2] = b;
        }
    };

    auto drawLine = [&](float x0, float z0, float x1, float z1, uint8_t r, uint8_t g, uint8_t b) {
        int steps = 200;
        for (int i = 0; i <= steps; ++i) {
            float t = (float)i / steps;
            float x = x0 + t * (x1 - x0);
            float z = z0 + t * (z1 - z0);
            int px, py;
            if (project(x, z, px, py)) drawPixel(px, py, r, g, b);
        }
    };

    // 1. Draw raw scan tile at podium level (Y in [5, 40]m) in BLUE
    GltfScene scanScene = GlbSceneReader::readFile("public/tiles/scan_studio_tile_esb_77197_98526.glb");
    if (scanScene.ok) {
        for (const auto& v : scanScene.mesh.vertices) {
            if (v.position.y >= 5.0f && v.position.y <= 40.0f) {
                int px, py;
                if (project(v.position.x, v.position.z, px, py)) {
                    drawPixel(px, py, 60, 140, 255); // Cyan-blue for scan
                }
            }
        }
    }

    // 2. Draw procedural building in RED/ORANGE
    GltfScene heroScene = GlbSceneReader::readFile("public/models/omnispatial_real_stage3_streetview_pbr.glb");
    if (heroScene.ok) {
        for (const auto& v : heroScene.mesh.vertices) {
            if (v.position.y >= 5.0f && v.position.y <= 40.0f) {
                if (v.position.x >= -79.0f && v.position.x <= 71.0f && v.position.z >= -42.0f && v.position.z <= 46.0f) {
                    int px, py;
                    if (project(v.position.x, v.position.z, px, py)) {
                        drawPixel(px, py, 255, 80, 40); // Bright Orange-Red for procedural building
                    }
                }
            }
        }
    }

    // 3. Draw coordinate axes: X in Green, Z in Yellow
    drawLine(-140, 0, 140, 0, 0, 255, 0); // X axis
    drawLine(0, -140, 0, 140, 255, 255, 0); // Z axis

    std::ofstream out("public/renders/alignment_plan_view.ppm", std::ios::binary);
    out << "P6\n" << W << " " << H << "\n255\n";
    out.write(reinterpret_cast<const char*>(img.data()), img.size());
    out.close();

    std::cout << "Rendered alignment plan view to public/renders/alignment_plan_view.ppm\n";
    return 0;
}
