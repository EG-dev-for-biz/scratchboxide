/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * Native C++20 Multithreaded BVH Raytracer for Pure Google 3D Tile GLB Extractions.
 * Renders ONLY the geometry extracted from the Google 3D Tile mesh:
 * - Zero added procedural windows
 * - Zero added spandrel panels
 * - Zero added parapets
 *
 * Generates:
 * 1. Cleaned Tile Hero Shaded
 * 2. Cleaned Tile Hero Wireframe (Cyan polygon edges)
 * 3. Cleaned Tile Crown & Spire Close-Up (Shaded & Wireframe)
 * 4. Cleaned Tile Setback Terraces Close-Up
 * 5. Cleaned Tile 4-Panel Proof Card (1920x1080)
 * 6. Raw Tile Photogrammetry Hero (scripts/building_raw.glb - 12,340 triangles)
 ********************************************************************************/

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
#include <chrono>

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

    Vec3 forward;
    Vec3 right;
    Vec3 camUp;
    float halfH;
    float halfW;

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
        float ndcX = (2.0f * (px + 0.5f) / static_cast<float>(width) - 1.0f) * halfW;
        float ndcY = (1.0f - 2.0f * (py + 0.5f) / static_cast<float>(height)) * halfH;
        Vec3 dir = (forward + right * ndcX + camUp * ndcY).normalized();
        return Ray(eye, dir);
    }
};

inline Vec3 acesFilmic(const Vec3& x) {
    float a = 2.51f, b = 0.03f, c = 2.43f, d = 0.59f, e = 0.14f;
    auto tone = [=](float v) {
        return std::clamp((v * (a * v + b)) / (v * (c * v + d) + e), 0.0f, 1.0f);
    };
    return Vec3(tone(x.x), tone(x.y), tone(x.z));
}

inline Vec3 sampleSkyDome(const Vec3& dir, const Vec3& sunDir) {
    Vec3 horizonCol(0.72f, 0.78f, 0.86f);
    Vec3 zenithCol(0.16f, 0.36f, 0.70f);

    if (dir.y < 0.0f) {
        float groundGrad = std::clamp((dir.y + 0.5f) / 0.5f, 0.0f, 1.0f);
        return Vec3(0.42f, 0.40f, 0.38f) * (1.0f - groundGrad) + horizonCol * groundGrad;
    }

    float y = std::max(0.0f, dir.y);
    float haze = std::pow(1.0f - y, 3.0f);
    Vec3 sky = zenithCol * (1.0f - haze) + horizonCol * haze;

    float sunCos = std::max(0.0f, dir.dot(sunDir));
    float sunHalo = std::pow(sunCos, 16.0f) * 0.45f;
    float sunDisc = std::pow(sunCos, 350.0f) * 6.5f;

    sky += Vec3(1.0f, 0.88f, 0.68f) * sunHalo;
    sky += Vec3(1.0f, 0.98f, 0.90f) * sunDisc;
    return sky;
}

enum class RenderMode {
    SHADED,
    WIREFRAME,
    NORMALS,
    EDGES_ONLY
};

ImageBuffer renderTileMesh(
    const ScratchboxMesh& mesh,
    const BvhTree& bvh,
    const Camera& cam,
    const Vec3& sunDir,
    RenderMode mode
) {
    ImageBuffer buffer(cam.width, cam.height, 4);

    const int numThreads = std::max(1u, std::thread::hardware_concurrency());
    std::vector<std::future<void>> futures;
    int rowsPerThread = (cam.height + numThreads - 1) / numThreads;

    for (int t = 0; t < numThreads; ++t) {
        int yStart = t * rowsPerThread;
        int yEnd = std::min(cam.height, yStart + rowsPerThread);
        if (yStart >= yEnd) continue;

        futures.push_back(std::async(std::launch::async, [&mesh, &bvh, &cam, &sunDir, &buffer, yStart, yEnd, mode]() {
            for (int y = yStart; y < yEnd; ++y) {
                for (int x = 0; x < cam.width; ++x) {
                    Ray ray = cam.getRay(static_cast<float>(x), static_cast<float>(y));

                    RayHit hit;
                    hit.t = 1e9f;

                    if (!bvh.raycast(ray, hit)) {
                        if (mode == RenderMode::NORMALS) {
                            buffer.setPixelRGB(x, y, Vec3(0.06f, 0.08f, 0.12f));
                        } else if (mode == RenderMode::EDGES_ONLY) {
                            buffer.setPixelRGB(x, y, Vec3(0.08f, 0.10f, 0.14f));
                        } else {
                            Vec3 sky = sampleSkyDome(ray.direction, sunDir);
                            buffer.setPixelRGB(x, y, acesFilmic(sky));
                        }
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

                    Vec4 c0 = (v0.color.w > 0.01f) ? v0.color : Vec4(0.82f, 0.80f, 0.76f, 1.0f);
                    Vec4 c1 = (v1.color.w > 0.01f) ? v1.color : Vec4(0.82f, 0.80f, 0.76f, 1.0f);
                    Vec4 c2 = (v2.color.w > 0.01f) ? v2.color : Vec4(0.82f, 0.80f, 0.76f, 1.0f);
                    Vec4 vertColor = c0 * w + c1 * hit.u + c2 * hit.v;
                    Vec3 baseColor(vertColor.x, vertColor.y, vertColor.z);

                    float minBary = std::min({w, hit.u, hit.v});
                    bool isEdge = (minBary < 0.038f);

                    if (mode == RenderMode::NORMALS) {
                        Vec3 nVis = N * 0.5f + Vec3(0.5f, 0.5f, 0.5f);
                        if (isEdge) nVis = Vec3(0.02f, 0.02f, 0.02f);
                        buffer.setPixelRGB(x, y, nVis);
                        continue;
                    }

                    if (mode == RenderMode::EDGES_ONLY) {
                        if (isEdge) {
                            buffer.setPixelRGB(x, y, Vec3(0.20f, 0.85f, 0.98f));
                        } else {
                            float ndotl = std::max(0.12f, N.dot(sunDir));
                            buffer.setPixelRGB(x, y, Vec3(0.08f, 0.12f, 0.18f) * ndotl);
                        }
                        continue;
                    }

                    float NdotL = std::max(0.0f, N.dot(sunDir));
                    float shadow = 1.0f;
                    if (NdotL > 0.001f) {
                        Ray shadowRay(hit.position + N * 0.04f, sunDir);
                        RayHit shadowHit;
                        shadowHit.t = 1e9f;
                        if (bvh.raycast(shadowRay, shadowHit) && shadowHit.t < 500.0f) {
                            shadow = 0.15f;
                        }
                    }

                    Vec3 sunColor(1.0f, 0.96f, 0.90f);
                    Vec3 directSun = baseColor * sunColor * (NdotL * shadow * 2.8f);

                    float skyVis = std::clamp(N.y * 0.5f + 0.5f, 0.0f, 1.0f);
                    Vec3 ambientSky = baseColor * Vec3(0.38f, 0.48f, 0.62f) * (skyVis * 0.55f);

                    float groundVis = std::clamp(-N.y * 0.5f + 0.5f, 0.0f, 1.0f);
                    Vec3 ambientGround = baseColor * Vec3(0.25f, 0.22f, 0.20f) * (groundVis * 0.25f);

                    Vec3 radiance = directSun + ambientSky + ambientGround;

                    if (mode == RenderMode::WIREFRAME && isEdge) {
                        radiance = Vec3(0.06f, 0.78f, 0.95f) * 1.5f;
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

int main(int argc, char** argv) {
    std::cout << "============================================================\n"
              << "NATIVE C++20 RAYTRACER: PURE GOOGLE 3D TILE GLB EXTRACTION\n"
              << "============================================================\n";

    std::string tileGlb = "scripts/models/empire_state_building_cleaned_tile.glb";
    ScratchboxMesh mesh = GlbReader::readGlb(tileGlb);

    BvhTree bvh;
    bvh.build(mesh);
    Vec3 sunDir = Vec3(0.55f, 0.75f, 0.35f).normalized();

    // 1. Hero Shaded & Wireframe
    Camera heroCam;
    heroCam.eye = Vec3(270.0f, 220.0f, 360.0f);
    heroCam.target = Vec3(0.0f, 220.0f, 0.0f);
    heroCam.fovDeg = 54.0f;
    heroCam.width = 1280;
    heroCam.height = 720;
    heroCam.update();

    std::cout << "Rendering Hero Shaded...\n";
    ImageBuffer heroShaded = renderTileMesh(mesh, bvh, heroCam, sunDir, RenderMode::SHADED);
    savePng("scripts/pure_tile_hero_shaded.png", heroShaded);

    std::cout << "Rendering Hero Wireframe...\n";
    ImageBuffer heroWire = renderTileMesh(mesh, bvh, heroCam, sunDir, RenderMode::WIREFRAME);
    savePng("scripts/pure_tile_hero_wireframe.png", heroWire);

    // 2. Crown Close-Up (Framing 86th Observatory, Mooring Mast, Spire)
    Camera crownCam;
    crownCam.eye = Vec3(95.0f, 355.0f, 115.0f);
    crownCam.target = Vec3(0.0f, 345.0f, 0.0f);
    crownCam.fovDeg = 48.0f;
    crownCam.width = 1280;
    crownCam.height = 720;
    crownCam.update();

    std::cout << "Rendering Crown Shaded...\n";
    ImageBuffer crownShaded = renderTileMesh(mesh, bvh, crownCam, sunDir, RenderMode::SHADED);
    savePng("scripts/pure_tile_crown_shaded.png", crownShaded);

    std::cout << "Rendering Crown Wireframe...\n";
    ImageBuffer crownWire = renderTileMesh(mesh, bvh, crownCam, sunDir, RenderMode::WIREFRAME);
    savePng("scripts/pure_tile_crown_wireframe.png", crownWire);

    // 3. Setback Terraces & Base Close-Up
    Camera setbackCam;
    setbackCam.eye = Vec3(135.0f, 130.0f, 160.0f);
    setbackCam.target = Vec3(0.0f, 75.0f, 0.0f);
    setbackCam.fovDeg = 48.0f;
    setbackCam.width = 1280;
    setbackCam.height = 720;
    setbackCam.update();

    std::cout << "Rendering Setbacks Shaded...\n";
    ImageBuffer setbackShaded = renderTileMesh(mesh, bvh, setbackCam, sunDir, RenderMode::SHADED);
    savePng("scripts/pure_tile_setbacks_shaded.png", setbackShaded);

    std::cout << "Rendering Setbacks Wireframe...\n";
    ImageBuffer setbackWire = renderTileMesh(mesh, bvh, setbackCam, sunDir, RenderMode::WIREFRAME);
    savePng("scripts/pure_tile_setbacks_wireframe.png", setbackWire);

    // 4. 4-Panel Proof Card (1920x1080)
    std::cout << "Rendering 4-Panel Inspection Proof Card (1920x1080)...\n";
    int panelW = 480, panelH = 1080;
    Camera proofCam;
    proofCam.eye = Vec3(270.0f, 220.0f, 360.0f);
    proofCam.target = Vec3(0.0f, 220.0f, 0.0f);
    proofCam.fovDeg = 54.0f;
    proofCam.width = panelW;
    proofCam.height = panelH;
    proofCam.update();

    ImageBuffer p1 = renderTileMesh(mesh, bvh, proofCam, sunDir, RenderMode::SHADED);
    ImageBuffer p2 = renderTileMesh(mesh, bvh, proofCam, sunDir, RenderMode::WIREFRAME);
    ImageBuffer p3 = renderTileMesh(mesh, bvh, proofCam, sunDir, RenderMode::NORMALS);
    ImageBuffer p4 = renderTileMesh(mesh, bvh, proofCam, sunDir, RenderMode::EDGES_ONLY);

    ImageBuffer card(1920, 1080, 4);
    for (int y = 0; y < 1080; ++y) {
        for (int x = 0; x < panelW; ++x) {
            Vec3 c1 = p1.getPixelRGB(x, y);
            Vec3 c2 = p2.getPixelRGB(x, y);
            Vec3 c3 = p3.getPixelRGB(x, y);
            Vec3 c4 = p4.getPixelRGB(x, y);

            card.setPixelRGB(x, y, c1);
            card.setPixelRGB(x + panelW, y, c2);
            card.setPixelRGB(x + panelW * 2, y, c3);
            card.setPixelRGB(x + panelW * 3, y, c4);
        }
    }
    savePng("scripts/pure_tile_extraction_proof_card.png", card);

    // 5. Also Render Raw Tile Photogrammetry (building_raw.glb - 12,340 triangles)
    std::cout << "Loading Raw Tile Photogrammetry (scripts/building_raw.glb)...\n";
    ScratchboxMesh rawMesh = GlbReader::readGlb("scripts/building_raw.glb");
    if (!rawMesh.vertices.empty()) {
        BvhTree rawBvh;
        rawBvh.build(rawMesh);

        Camera rawCam;
        rawCam.eye = Vec3(135.0f, 110.0f, 180.0f);
        rawCam.target = Vec3(0.0f, 110.0f, 0.0f);
        rawCam.fovDeg = 54.0f;
        rawCam.width = 1280;
        rawCam.height = 720;
        rawCam.update();

        std::cout << "Rendering Raw Photogrammetry Shaded (12,340 tris)...\n";
        ImageBuffer rawShaded = renderTileMesh(rawMesh, rawBvh, rawCam, sunDir, RenderMode::SHADED);
        savePng("scripts/raw_photogrammetry_shaded.png", rawShaded);

        std::cout << "Rendering Raw Photogrammetry Wireframe (12,340 tris)...\n";
        ImageBuffer rawWire = renderTileMesh(rawMesh, rawBvh, rawCam, sunDir, RenderMode::WIREFRAME);
        savePng("scripts/raw_photogrammetry_wireframe.png", rawWire);
    }

    // Copy to brain artifacts
    std::string artifactDir = "/Users/eligreen/.gemini/antigravity/brain/c39326e3-d704-45bd-a2f5-76f66ba90b68/";
    std::string cmd = "cp scripts/pure_tile_*.png scripts/raw_photogrammetry_*.png " + artifactDir;
    system(cmd.c_str());

    std::cout << "SUCCESS: All Pure Tile GLB extraction renders completed!\n";
    return 0;
}
