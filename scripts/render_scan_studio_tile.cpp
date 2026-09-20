#include "scratchbox_engine.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_bvh.hpp"
#include "scratchbox_texture.hpp"
#include <iostream>
#include <fstream>
#include <vector>
#include <cmath>
#include <algorithm>
#include <thread>
#include <future>

using namespace scratchbox;
using namespace scratchbox::math;
using namespace scratchbox::texture;
using namespace scratchbox::bvh;
using namespace scratchbox::io;

struct Camera {
    Vec3 eye;
    Vec3 target;
    Vec3 up{0.0f, 1.0f, 0.0f};
    float fovDeg{45.0f};
    int width{1280};
    int height{720};

    Vec3 forward, right, camUp;
    float halfH, halfW;

    void update() {
        forward = (target - eye).normalized();
        right = forward.cross(up).normalized();
        camUp = right.cross(forward).normalized();

        float aspect = static_cast<float>(width) / static_cast<float>(height);
        float rad = fovDeg * (math::PI / 180.0f) * 0.5f;
        halfH = std::tan(rad);
        halfW = halfH * aspect;
    }

    Ray getRay(float px, float py) const {
        float u = (px + 0.5f) / static_cast<float>(width);
        float v = (py + 0.5f) / static_cast<float>(height);

        float cx = (2.0f * u - 1.0f) * halfW;
        float cy = (1.0f - 2.0f * v) * halfH;

        Vec3 dir = (forward + right * cx + camUp * cy).normalized();
        return Ray(eye, dir);
    }
};

static Vec3 acesFilmic(const Vec3& x) {
    float a = 2.51f, b = 0.03f, c = 2.43f, d = 0.59f, e = 0.14f;
    auto mapChan = [=](float v) {
        v = std::max(0.0f, v);
        return std::clamp((v * (a * v + b)) / (v * (c * v + d) + e), 0.0f, 1.0f);
    };
    return Vec3(mapChan(x.x), mapChan(x.y), mapChan(x.z));
}

static ImageBuffer renderScene(const ScratchboxMesh& mesh, const BvhTree& bvh, const Camera& cam, const Vec3& sunDir, bool wireframe) {
    ImageBuffer buffer(cam.width, cam.height, 3);
    int numThreads = static_cast<int>(std::thread::hardware_concurrency());
    if (numThreads <= 0) numThreads = 8;
    int rowsPerThread = (cam.height + numThreads - 1) / numThreads;

    std::vector<std::future<void>> futures;

    for (int t = 0; t < numThreads; ++t) {
        int yStart = t * rowsPerThread;
        int yEnd = std::min(cam.height, yStart + rowsPerThread);
        if (yStart >= yEnd) continue;

        futures.push_back(std::async(std::launch::async, [&mesh, &bvh, &cam, &sunDir, &buffer, yStart, yEnd, wireframe]() {
            for (int y = yStart; y < yEnd; ++y) {
                for (int x = 0; x < cam.width; ++x) {
                    Ray ray = cam.getRay(static_cast<float>(x), static_cast<float>(y));
                    RayHit hit;
                    hit.t = 1e9f;

                    if (!bvh.raycast(ray, hit)) {
                        float skyT = std::clamp(ray.direction.y * 0.5f + 0.5f, 0.0f, 1.0f);
                        Vec3 skyCol = Vec3(0.08f, 0.14f, 0.22f) * skyT + Vec3(0.04f, 0.06f, 0.10f) * (1.0f - skyT);
                        buffer.setPixelRGB(x, y, skyCol);
                        continue;
                    }

                    uint32_t idx0 = mesh.indices[hit.triangleIndex * 3 + 0];
                    uint32_t idx1 = mesh.indices[hit.triangleIndex * 3 + 1];
                    uint32_t idx2 = mesh.indices[hit.triangleIndex * 3 + 2];

                    const auto& v0 = mesh.vertices[idx0];
                    const auto& v1 = mesh.vertices[idx1];
                    const auto& v2 = mesh.vertices[idx2];

                    float w = 1.0f - hit.u - hit.v;
                    Vec3 N = (v0.normal * w + v1.normal * hit.u + v2.normal * hit.v).normalized();
                    if (N.lengthSquared() < 0.1f) N = hit.normal;

                    Vec4 c0 = (v0.color.w > 0.01f) ? v0.color : Vec4(0.85f, 0.82f, 0.78f, 1.0f);
                    Vec4 c1 = (v1.color.w > 0.01f) ? v1.color : Vec4(0.85f, 0.82f, 0.78f, 1.0f);
                    Vec4 c2 = (v2.color.w > 0.01f) ? v2.color : Vec4(0.85f, 0.82f, 0.78f, 1.0f);
                    Vec4 vertColor = c0 * w + c1 * hit.u + c2 * hit.v;
                    Vec3 baseColor(vertColor.x, vertColor.y, vertColor.z);

                    float minBary = std::min({w, hit.u, hit.v});
                    bool isEdge = (minBary < 0.035f);

                    float ndotl = std::max(0.0f, N.dot(sunDir));
                    Vec3 directSun = baseColor * Vec3(1.1f, 1.05f, 0.95f) * (ndotl * 2.2f);
                    float skyVis = std::clamp(N.y * 0.5f + 0.5f, 0.0f, 1.0f);
                    Vec3 ambientSky = baseColor * Vec3(0.18f, 0.22f, 0.32f) * (skyVis * 0.95f);
                    Vec3 radiance = directSun + ambientSky;

                    if (wireframe && isEdge) {
                        radiance = Vec3(0.06f, 0.85f, 0.98f) * 2.0f;
                    }

                    buffer.setPixelRGB(x, y, acesFilmic(radiance));
                }
            }
        }));
    }

    for (auto& f : futures) f.get();
    return buffer;
}

static void savePng(const std::string& path, const ImageBuffer& img) {
    auto png = encodePng(img);
    std::ofstream out(path, std::ios::binary);
    out.write(reinterpret_cast<const char*>(png.data()), png.size());
}

int main() {
    std::cout << "Loading Scan Studio Tile: public/tiles/scan_studio_tile_77205_98511.glb ...\n";
    ScratchboxMesh mesh = GlbReader::readGlb("public/tiles/scan_studio_tile_77205_98511.glb");
    std::cout << "Loaded vertices: " << mesh.vertices.size() << ", triangles: " << mesh.indices.size() / 3 << "\n";

    Vec3 minP(1e9f, 1e9f, 1e9f);
    Vec3 maxP(-1e9f, -1e9f, -1e9f);
    for (const auto& v : mesh.vertices) {
        minP.x = std::min(minP.x, v.position.x);
        minP.y = std::min(minP.y, v.position.y);
        minP.z = std::min(minP.z, v.position.z);
        maxP.x = std::max(maxP.x, v.position.x);
        maxP.y = std::max(maxP.y, v.position.y);
        maxP.z = std::max(maxP.z, v.position.z);
    }
    Vec3 size = maxP - minP;
    Vec3 center = (minP + maxP) * 0.5f;
    std::cout << "Bounding Box Min: (" << minP.x << ", " << minP.y << ", " << minP.z << ")\n";
    std::cout << "Bounding Box Max: (" << maxP.x << ", " << maxP.y << ", " << maxP.z << ")\n";
    std::cout << "Size: " << size.x << " x " << size.y << " x " << size.z << " meters\n";
    std::cout << "Center: (" << center.x << ", " << center.y << ", " << center.z << ")\n";

    BvhTree bvh;
    bvh.build(mesh);
    Vec3 sunDir = Vec3(0.55f, 0.75f, 0.35f).normalized();

    // Render Hero Angle
    Camera cam;
    cam.target = Vec3(center.x, center.y + size.y * 0.15f, center.z);
    cam.eye = cam.target + Vec3(size.x * 0.95f, size.y * 0.55f, size.z * 1.15f);
    cam.fovDeg = 45.0f;
    cam.width = 1280;
    cam.height = 720;
    cam.update();

    std::cout << "Rendering Scan Studio Tile Hero Shaded...\n";
    ImageBuffer shaded = renderScene(mesh, bvh, cam, sunDir, false);
    savePng("public/tiles/scan_studio_hero_shaded.png", shaded);

    std::cout << "Rendering Scan Studio Tile Hero Wireframe...\n";
    ImageBuffer wire = renderScene(mesh, bvh, cam, sunDir, true);
    savePng("public/tiles/scan_studio_hero_wireframe.png", wire);

    std::cout << "SUCCESS! Images saved to public/tiles/scan_studio_hero_shaded.png and wireframe.png\n";
    return 0;
}
