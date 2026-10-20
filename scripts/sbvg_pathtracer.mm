/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Path-traced render of a .sbvg cluster LOD file, configured by a JSON file.
// Usage: sbvg_pathtracer <config.json>      render; writes beauty.png, color.f32 and stats.json into config.outputDir
//        sbvg_pathtracer --probe            print the Metal device as JSON (exit 1 when there is none)
//
// backend "metal" (default) traces on the GPU; backend "cpu" traces the same LOD cut with render::PathTracer,
// the reference the GPU kernels are checked against. The CPU backend needs sun lighting.

#import <Foundation/Foundation.h>

#include "scratchbox_denoise.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_metal_pathtracer.hpp"
#include "scratchbox_pathtracer.hpp"
#include "scratchbox_sbvg_reader.hpp"
#include "scratchbox_sky.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_view_transform.hpp"
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

using namespace scratchbox;
using math::Vec3;
using Json = io::GlbJsonValue;

namespace {

float numberOr(const Json& v, float fallback) {
    return v.type == Json::Number ? static_cast<float>(v.num) : fallback;
}

bool boolOr(const Json& v, bool fallback) {
    return v.type == Json::Bool ? v.b : fallback;
}

Vec3 vec3Or(const Json& v, const Vec3& fallback) {
    if (v.arr.size() != 3) return fallback;
    return Vec3(numberOr(v[0], fallback.x), numberOr(v[1], fallback.y), numberOr(v[2], fallback.z));
}

std::string jsonString(const std::string& s) {
    std::string out = "\"";
    for (char c : s) {
        if (c == '"' || c == '\\') out += '\\';
        if (c == '\n') {
            out += "\\n";
            continue;
        }
        out += c;
    }
    return out + "\"";
}

std::string jsonVec(const Vec3& v) {
    std::ostringstream s;
    s.precision(9);
    s << '[' << v.x << ',' << v.y << ',' << v.z << ']';
    return s.str();
}

bool writeBytes(const std::filesystem::path& path, const void* data, size_t size) {
    std::ofstream file(path, std::ios::binary);
    if (!file.is_open()) return false;
    file.write(static_cast<const char*>(data), static_cast<std::streamsize>(size));
    return file.good();
}

/** Length of a GLB's glTF materials array (gltf::GltfScene appends a default material, so its count cannot say). */
uint32_t glbMaterialCount(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open GLB: " + path);
    uint32_t header[5];
    if (!f.read(reinterpret_cast<char*>(header), sizeof(header)) || header[0] != 0x46546C67u || header[4] != 0x4E4F534Au) throw std::runtime_error("not a GLB file: " + path);
    std::string json(header[3], '\0');
    if (!f.read(json.data(), static_cast<std::streamsize>(json.size()))) throw std::runtime_error("truncated GLB: " + path);
    io::GlbJsonParser parser(json.data(), json.size());
    const Json root = parser.parse();
    return static_cast<uint32_t>(root["materials"].arr.size());
}

int probe() {
    try {
        metalpt::DeviceInfo info = metalpt::probeDevice();
        std::cout << "{\"device\":" << jsonString(info.name) << ",\"raytracing\":" << (info.raytracing ? "true" : "false")
                  << ",\"appleFamily\":" << info.appleFamily << ",\"recommendedWorkingSetBytes\":" << info.recommendedWorkingSetBytes << "}" << std::endl;
        return info.raytracing ? 0 : 1;
    } catch (const std::exception& e) {
        std::cout << "{\"device\":null,\"raytracing\":false,\"error\":" << jsonString(e.what()) << "}" << std::endl;
        return 1;
    }
}

/**
 * The LOD cut as a glTF scene for render::PathTracer, vertices relative to the file origin. With a
 * `source` scene its materials and images are taken over (a default material appended for triangles
 * without one); otherwise one default material, for the uniform clay path.
 */
gltf::GltfScene sceneFromCut(const sbvg::File& file, const sbvg::Cut& cut, gltf::GltfScene* source) {
    gltf::GltfScene scene;
    scene.ok = true;
    scene.mesh.name = "sbvg_cut";
    const uint32_t vertexCount = file.vertexCount();
    for (uint32_t i = 0; i < vertexCount; ++i) {
        const float* v = file.vertices.data() + static_cast<size_t>(i) * vgeo::kSbvgVertexFloats;
        // No tangent (zero): the tracer derives one from the uv derivatives.
        scene.mesh.addVertex(geometry::Vertex(Vec3(v[0], v[1], v[2]), Vec3(v[3], v[4], v[5]), math::Vec2(v[6], v[7]), math::Vec4(1, 1, 1, 1), math::Vec4(0, 0, 0, 1)));
    }
    scene.mesh.indices = cut.indices;
    if (source) {
        scene.materials = source->materials;
        scene.images = std::move(source->images);
    }
    const uint32_t defaultMaterial = static_cast<uint32_t>(scene.materials.size());
    scene.materials.push_back(gltf::SceneMaterial{});
    scene.triangleMaterial.reserve(cut.triangleCount());
    for (uint32_t id : cut.materials) scene.triangleMaterial.push_back(source && id != vgeo::kNoMaterial ? id : defaultMaterial);
    scene.bounds = scene.mesh.bounds;
    scene.primitiveCount = 1;
    scene.nodeCount = 1;
    return scene;
}

} // namespace

int main(int argc, char** argv) {
    if (argc >= 2 && std::string(argv[1]) == "--probe") return probe();
    if (argc < 2) {
        std::cerr << "usage: sbvg_pathtracer <config.json> | --probe" << std::endl;
        return 2;
    }
    std::ifstream configFile(argv[1]);
    if (!configFile.is_open()) {
        std::cerr << "cannot open config " << argv[1] << std::endl;
        return 2;
    }
    std::stringstream configText;
    configText << configFile.rdbuf();
    const std::string text = configText.str();
    io::GlbJsonParser parser(text.data(), text.size());
    const Json config = parser.parse();

    const std::string sbvgPath = config["sbvgPath"].asString("");
    const std::string outputDir = config["outputDir"].asString("");
    if (sbvgPath.empty() || outputDir.empty()) {
        std::cerr << "config must set sbvgPath and outputDir" << std::endl;
        return 2;
    }
    const std::string backend = config["backend"].asString("metal");
    if (backend != "metal" && backend != "cpu") {
        std::cerr << "config.backend must be \"metal\" or \"cpu\"" << std::endl;
        return 2;
    }

    try {
        std::filesystem::create_directories(outputDir);
        const auto totalStart = std::chrono::steady_clock::now();
        const sbvg::File file = sbvg::readFile(sbvgPath);
        const double loadMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - totalStart).count();

        render::RenderSettings settings;
        settings.width = static_cast<int>(numberOr(config["width"], 1280));
        settings.height = static_cast<int>(numberOr(config["height"], 720));
        settings.samplesPerPixel = static_cast<int>(numberOr(config["samplesPerPixel"], 64));
        settings.maxBounces = static_cast<int>(numberOr(config["maxBounces"], 4));
        settings.threads = static_cast<int>(numberOr(config["threads"], 0));
        settings.clampIndirect = numberOr(config["clampIndirect"], 10.0f);
        settings.seed = static_cast<uint32_t>(numberOr(config["seed"], 1));
        const float aspect = static_cast<float>(settings.width) / static_cast<float>(std::max(settings.height, 1));

        // Camera, in the file's own coordinates (its vertices are relative to the stored origin).
        math::AABB bounds;
        bounds.expand(Vec3(file.aabbMin[0], file.aabbMin[1], file.aabbMin[2]));
        bounds.expand(Vec3(file.aabbMax[0], file.aabbMax[1], file.aabbMax[2]));
        render::CameraSpec camera;
        const Json& cameraConfig = config["camera"];
        if (cameraConfig.has("position") && cameraConfig.has("target")) {
            camera.position = vec3Or(cameraConfig["position"], camera.position);
            camera.target = vec3Or(cameraConfig["target"], camera.target);
            camera.verticalFovDeg = numberOr(cameraConfig["verticalFovDeg"], camera.verticalFovDeg);
            camera.up = vec3Or(cameraConfig["up"], camera.up);
            camera.apertureRadius = numberOr(cameraConfig["apertureRadius"], 0.0f);
            camera.focusDistance = numberOr(cameraConfig["focusDistance"], 0.0f);
        } else {
            const Json& framing = cameraConfig["auto"];
            camera = render::PathTracer::frameBounds(bounds, bounds.min.y, aspect, numberOr(framing["verticalFovDeg"], 40.0f),
                                                     numberOr(framing["pitchDeg"], 35.0f), numberOr(framing["headingDeg"], 20.0f),
                                                     numberOr(framing["distanceScale"], 0.9f));
        }

        // The LOD cut for this camera.
        const Json& lodConfig = config["lod"];
        sbvg::CutParams cutParams;
        cutParams.eye[0] = camera.position.x;
        cutParams.eye[1] = camera.position.y;
        cutParams.eye[2] = camera.position.z;
        cutParams.lodScale = static_cast<float>(settings.height) / (2.0f * std::tan(0.5f * camera.verticalFovDeg * math::DEG_TO_RAD));
        cutParams.near = numberOr(lodConfig["near"], 0.1f);
        cutParams.thresholdPx = numberOr(lodConfig["thresholdPx"], 1.0f);
        cutParams.finestLevel = static_cast<uint32_t>(numberOr(lodConfig["finestLevel"], 0.0f));
        const auto cutStart = std::chrono::steady_clock::now();
        const sbvg::Cut cut = sbvg::selectCut(file, cutParams);
        const double cutMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - cutStart).count();
        if (cut.indices.empty()) throw std::runtime_error("the LOD cut selected no clusters (is the camera inside every LOD sphere?)");

        // Lighting: a physical sun and sky when the config asks for one, else a uniform neutral dome.
        metalpt::Lighting lighting;
        std::unique_ptr<sky::PhysicalSky> physicalSky;
        float elevationDeg = 0.0f, azimuthDeg = 0.0f;
        const Json& lightingConfig = config["lighting"];
        if (lightingConfig.has("sun")) {
            const Json& sunConfig = lightingConfig["sun"];
            if (!sunConfig.has("elevationDeg") || !sunConfig.has("azimuthDeg")) throw std::runtime_error("config.lighting.sun needs elevationDeg and azimuthDeg");
            elevationDeg = numberOr(sunConfig["elevationDeg"], 0.0f);
            azimuthDeg = numberOr(sunConfig["azimuthDeg"], 0.0f);
            const float e = elevationDeg * math::DEG_TO_RAD, a = azimuthDeg * math::DEG_TO_RAD;
            const Vec3 sunDirection(std::cos(e) * std::sin(a), std::sin(e), -std::cos(e) * std::cos(a));
            const Json& atmosphereConfig = lightingConfig["atmosphere"];
            sky::AtmosphereParams atmosphere;
            atmosphere.observerAltitudeMeters = std::max(0.0f, numberOr(atmosphereConfig["siteElevationMeters"], 0.0f) + camera.position.y - bounds.min.y);
            atmosphere.airDensity = numberOr(atmosphereConfig["airDensity"], atmosphere.airDensity);
            atmosphere.dustDensity = numberOr(atmosphereConfig["dustDensity"], atmosphere.dustDensity);
            atmosphere.ozoneDensity = numberOr(atmosphereConfig["ozoneDensity"], atmosphere.ozoneDensity);
            atmosphere.sunAngularDiameterDeg = numberOr(atmosphereConfig["sunAngularDiameterDeg"], atmosphere.sunAngularDiameterDeg);
            atmosphere.sunIntensity = numberOr(atmosphereConfig["sunIntensity"], atmosphere.sunIntensity);
            physicalSky = std::make_unique<sky::PhysicalSky>(sunDirection, atmosphere);
            lighting.mode = metalpt::Lighting::Mode::Sky;
            lighting.sky = physicalSky.get();
        } else {
            lighting.mode = metalpt::Lighting::Mode::Studio;
            lighting.studioRadiance = vec3Or(lightingConfig["studio"]["radiance"], Vec3(1, 1, 1));
        }

        // Materials: the source GLB's (by the ids the .sbvg carries), or one uniform material.
        metalpt::Material material;
        const Json& materialConfig = config["material"];
        material.albedo = vec3Or(materialConfig["albedo"], material.albedo);
        material.roughness = numberOr(materialConfig["roughness"], material.roughness);
        material.metallic = numberOr(materialConfig["metallic"], material.metallic);
        const std::string materialsGlb = config["materials"]["glbPath"].asString("");
        const bool sceneMaterials = !materialsGlb.empty();
        gltf::GltfScene source;
        size_t imagesDecoded = 0;
        double materialsLoadMs = 0.0;
        if (sceneMaterials) {
            if (file.version < 3) throw std::runtime_error("this .sbvg carries no material ids (version " + std::to_string(file.version) + "); rebuild it from its GLB");
            const auto loadStart = std::chrono::steady_clock::now();
            source = gltf::GlbSceneReader::readFile(materialsGlb);
            if (!source.ok) throw std::runtime_error("failed to load materials from " + materialsGlb + ": " + source.error);
            materialsLoadMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - loadStart).count();
            const uint32_t glbMaterials = glbMaterialCount(materialsGlb);
            if (glbMaterials != file.materialCount) {
                throw std::runtime_error("the .sbvg was built from a GLB with " + std::to_string(file.materialCount) + " materials; " + materialsGlb + " has " + std::to_string(glbMaterials));
            }
            for (const auto& image : source.images) if (image.decoded) ++imagesDecoded;
        }

        render::RenderOutput out;
        std::string deviceName = "cpu";
        double accelerationBuildMs = 0.0;
        uint32_t texturesUploaded = 0;
        if (backend == "metal") {
            metalpt::MetalPathTracer tracer;
            tracer.setGeometry(file.vertices, cut.indices, cut.materials);
            if (sceneMaterials) {
                tracer.setMaterials(source);
                texturesUploaded = tracer.textureCount();
            }
            deviceName = tracer.deviceName();
            accelerationBuildMs = tracer.accelerationBuildMs();
            out = tracer.render(camera, lighting, settings, sceneMaterials ? nullptr : &material);
        } else {
            if (lighting.mode != metalpt::Lighting::Mode::Sky) throw std::runtime_error("backend \"cpu\" (render::PathTracer) needs config.lighting.sun");
            const gltf::GltfScene scene = sceneFromCut(file, cut, sceneMaterials ? &source : nullptr);
            const auto buildStart = std::chrono::steady_clock::now();
            render::PathTracer tracer(scene, false);
            accelerationBuildMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - buildStart).count();
            if (!sceneMaterials) tracer.setClayMaterial(material.albedo, material.roughness, material.metallic);
            out = tracer.render(camera, *physicalSky, settings);
        }

        std::vector<Vec3> beauty = out.color;
        const bool denoise = boolOr(config["denoise"], false);
        if (denoise) beauty = denoise::denoiseATrous(out.color, out.guides);
        const Json& exposureConfig = config["exposure"];
        const float exposureEv = exposureConfig.type == Json::Number ? static_cast<float>(exposureConfig.num) : view::autoExposureEv(beauty);
        const texture::ImageBuffer beautyImage = view::toDisplayImage(beauty, out.width, out.height, exposureEv, view::AgxLook::Base);
        const std::vector<uint8_t> png = texture::encodePng(beautyImage);
        const std::filesystem::path dir(outputDir);
        if (!writeBytes(dir / "beauty.png", png.data(), png.size())) throw std::runtime_error("failed to write beauty.png");
        {
            std::vector<float> raw(out.color.size() * 3);
            for (size_t i = 0; i < out.color.size(); ++i) {
                raw[i * 3] = out.color[i].x;
                raw[i * 3 + 1] = out.color[i].y;
                raw[i * 3 + 2] = out.color[i].z;
            }
            if (!writeBytes(dir / "color.f32", raw.data(), raw.size() * sizeof(float))) throw std::runtime_error("failed to write color.f32");
        }

        double meanLuminance = 0.0;
        for (const Vec3& c : out.color) meanLuminance += view::luminance(c);
        meanLuminance /= static_cast<double>(std::max<size_t>(1, out.color.size()));
        const double totalMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - totalStart).count();

        std::ostringstream stats;
        stats.precision(9);
        stats << "{\n"
              << "  \"backend\": " << jsonString(backend) << ",\n"
              << "  \"device\": " << jsonString(deviceName) << ",\n"
              << "  \"width\": " << out.width << ",\n"
              << "  \"height\": " << out.height << ",\n"
              << "  \"samplesPerPixel\": " << settings.samplesPerPixel << ",\n"
              << "  \"maxBounces\": " << settings.maxBounces << ",\n"
              << "  \"lighting\": " << jsonString(lighting.mode == metalpt::Lighting::Mode::Sky ? "sky" : "studio") << ",\n"
              << "  \"file\": { \"clusters\": " << file.clusters.size() << ", \"levels\": " << file.levelCount
              << ", \"vertices\": " << file.vertexCount() << ", \"leafTriangles\": " << file.leafTriangleCount << " },\n"
              << "  \"cut\": { \"clusters\": " << cut.clusterIds.size() << ", \"triangles\": " << cut.triangleCount()
              << ", \"thresholdPx\": " << cutParams.thresholdPx << ", \"finestLevel\": " << cutParams.finestLevel << " },\n"
              << "  \"rays\": " << out.rays << ",\n"
              << "  \"raysPerSecond\": " << (out.renderMs > 0.0 ? static_cast<double>(out.rays) * 1000.0 / out.renderMs : 0.0) << ",\n"
              << "  \"renderMs\": " << out.renderMs << ",\n"
              << "  \"accelerationBuildMs\": " << accelerationBuildMs << ",\n"
              << "  \"loadMs\": " << loadMs << ",\n"
              << "  \"cutMs\": " << cutMs << ",\n"
              << "  \"totalMs\": " << totalMs << ",\n"
              << "  \"geometryCoverage\": " << out.geometryCoverage << ",\n"
              << "  \"nanSamples\": " << out.nanSamples << ",\n"
              << "  \"meanLinearLuminance\": " << meanLuminance << ",\n"
              << "  \"exposureEv\": " << exposureEv << ",\n"
              << "  \"denoised\": " << (denoise ? "true" : "false") << ",\n"
              << "  \"materials\": { \"source\": " << jsonString(sceneMaterials ? "glb" : "uniform") << ", \"glbPath\": " << jsonString(materialsGlb)
              << ", \"count\": " << (sceneMaterials ? source.materials.size() : 1) << ", \"images\": " << source.images.size() << ", \"imagesDecoded\": " << imagesDecoded
              << ", \"texturesUploaded\": " << texturesUploaded << ", \"loadMs\": " << materialsLoadMs << " },\n"
              << "  \"material\": { \"albedo\": " << jsonVec(material.albedo) << ", \"roughness\": " << material.roughness << ", \"metallic\": " << material.metallic << " },\n"
              << "  \"sun\": { \"elevationDeg\": " << elevationDeg << ", \"azimuthDeg\": " << azimuthDeg << " },\n"
              << "  \"camera\": { \"position\": " << jsonVec(camera.position) << ", \"target\": " << jsonVec(camera.target)
              << ", \"up\": " << jsonVec(camera.up) << ", \"verticalFovDeg\": " << camera.verticalFovDeg << " },\n"
              << "  \"colorRaw\": \"color.f32: float32 scene-linear RGB per pixel, row-major\"\n"
              << "}\n";
        const std::string statsText = stats.str();
        if (!writeBytes(dir / "stats.json", statsText.data(), statsText.size())) throw std::runtime_error("failed to write stats.json");
        std::cout << "[TELEMETRY] backend=" << backend << " renderMs=" << out.renderMs << " spp=" << settings.samplesPerPixel
                  << " triangles=" << cut.triangleCount() << " rays=" << out.rays << " coverage=" << out.geometryCoverage << std::endl;
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "sbvg_pathtracer: " << e.what() << std::endl;
        return 1;
    }
}
