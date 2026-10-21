/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Path-traced rendering of a .sbvg cluster LOD file.
//
//   sbvg_pathtracer <config.json>   one render; writes beauty.png, color.f32 and stats.json into config.outputDir
//   sbvg_pathtracer --probe         print the Metal device as JSON (exit 1 when there is none)
//   sbvg_pathtracer --serve <dir>   resident: JSON commands on stdin, JSON events on stdout, progressive
//                                   frames as <dir>/frame.rgba (8-bit RGBA, display-ready); see serve()
//
// backend "metal" (default) traces on the GPU; backend "cpu" traces the same LOD cut with render::PathTracer,
// the reference the GPU kernels are checked against. The CPU backend needs sun lighting.

#import <Foundation/Foundation.h>

#include "scratchbox_denoise.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_metal_pathtracer.hpp"
#include "scratchbox_pathtracer.hpp"
#include "scratchbox_png.hpp"
#include "scratchbox_sbvg_reader.hpp"
#include "scratchbox_sky.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_view_transform.hpp"
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
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

Json parseJson(const std::string& text) {
    io::GlbJsonParser parser(text.data(), text.size());
    return parser.parse();
}

/** Length of a GLB's glTF materials array (gltf::GltfScene appends a default material, so its count cannot say). */
uint32_t glbMaterialCount(const std::string& path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) throw std::runtime_error("cannot open GLB: " + path);
    uint32_t header[5];
    if (!f.read(reinterpret_cast<char*>(header), sizeof(header)) || header[0] != 0x46546C67u || header[4] != 0x4E4F534Au) throw std::runtime_error("not a GLB file: " + path);
    std::string json(header[3], '\0');
    if (!f.read(json.data(), static_cast<std::streamsize>(json.size()))) throw std::runtime_error("truncated GLB: " + path);
    return static_cast<uint32_t>(parseJson(json)["materials"].arr.size());
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

math::AABB fileBounds(const sbvg::File& file) {
    math::AABB bounds;
    bounds.expand(Vec3(file.aabbMin[0], file.aabbMin[1], file.aabbMin[2]));
    bounds.expand(Vec3(file.aabbMax[0], file.aabbMax[1], file.aabbMax[2]));
    return bounds;
}

/** Camera from config, in the file's own coordinates (its vertices are relative to the stored origin). */
render::CameraSpec parseCamera(const Json& cameraConfig, const math::AABB& bounds, float aspect) {
    render::CameraSpec camera;
    if (cameraConfig.has("position") && cameraConfig.has("target")) {
        camera.position = vec3Or(cameraConfig["position"], camera.position);
        camera.target = vec3Or(cameraConfig["target"], camera.target);
        camera.verticalFovDeg = numberOr(cameraConfig["verticalFovDeg"], camera.verticalFovDeg);
        camera.up = vec3Or(cameraConfig["up"], camera.up);
        camera.apertureRadius = numberOr(cameraConfig["apertureRadius"], 0.0f);
        camera.focusDistance = numberOr(cameraConfig["focusDistance"], 0.0f);
        return camera;
    }
    const Json& framing = cameraConfig["auto"];
    return render::PathTracer::frameBounds(bounds, bounds.min.y, aspect, numberOr(framing["verticalFovDeg"], 40.0f),
                                           numberOr(framing["pitchDeg"], 35.0f), numberOr(framing["headingDeg"], 20.0f),
                                           numberOr(framing["distanceScale"], 0.9f));
}

/** Lighting from config: a physical sun and sky when it asks for one, else a uniform neutral dome. */
struct LightingSetup {
    metalpt::Lighting lighting;
    std::unique_ptr<sky::PhysicalSky> sky;
    float elevationDeg{0.0f};
    float azimuthDeg{0.0f};
};

LightingSetup parseLighting(const Json& lightingConfig, const math::AABB& bounds, const Vec3& cameraPosition) {
    LightingSetup setup;
    if (lightingConfig.has("sun")) {
        const Json& sunConfig = lightingConfig["sun"];
        if (!sunConfig.has("elevationDeg") || !sunConfig.has("azimuthDeg")) throw std::runtime_error("lighting.sun needs elevationDeg and azimuthDeg");
        setup.elevationDeg = numberOr(sunConfig["elevationDeg"], 0.0f);
        setup.azimuthDeg = numberOr(sunConfig["azimuthDeg"], 0.0f);
        const float e = setup.elevationDeg * math::DEG_TO_RAD, a = setup.azimuthDeg * math::DEG_TO_RAD;
        const Vec3 sunDirection(std::cos(e) * std::sin(a), std::sin(e), -std::cos(e) * std::cos(a));
        const Json& atmosphereConfig = lightingConfig["atmosphere"];
        sky::AtmosphereParams atmosphere;
        atmosphere.observerAltitudeMeters = std::max(0.0f, numberOr(atmosphereConfig["siteElevationMeters"], 0.0f) + cameraPosition.y - bounds.min.y);
        atmosphere.airDensity = numberOr(atmosphereConfig["airDensity"], atmosphere.airDensity);
        atmosphere.dustDensity = numberOr(atmosphereConfig["dustDensity"], atmosphere.dustDensity);
        atmosphere.ozoneDensity = numberOr(atmosphereConfig["ozoneDensity"], atmosphere.ozoneDensity);
        atmosphere.sunAngularDiameterDeg = numberOr(atmosphereConfig["sunAngularDiameterDeg"], atmosphere.sunAngularDiameterDeg);
        atmosphere.sunIntensity = numberOr(atmosphereConfig["sunIntensity"], atmosphere.sunIntensity);
        setup.sky = std::make_unique<sky::PhysicalSky>(sunDirection, atmosphere);
        setup.lighting.mode = metalpt::Lighting::Mode::Sky;
        setup.lighting.sky = setup.sky.get();
    } else {
        setup.lighting.mode = metalpt::Lighting::Mode::Studio;
        setup.lighting.studioRadiance = vec3Or(lightingConfig["studio"]["radiance"], Vec3(1, 1, 1));
    }
    return setup;
}

metalpt::Material parseMaterial(const Json& materialConfig) {
    metalpt::Material material;
    material.albedo = vec3Or(materialConfig["albedo"], material.albedo);
    material.roughness = numberOr(materialConfig["roughness"], material.roughness);
    material.metallic = numberOr(materialConfig["metallic"], material.metallic);
    return material;
}

/** The GLB's materials and images for a version-3 file, checked against the file's material count. */
struct MaterialSource {
    gltf::GltfScene scene;
    std::string glbPath;
    size_t imagesDecoded{0};
    double loadMs{0.0};
};

/** `atlasNormals` false leaves the baked normal atlases out (for measuring their effect); colour atlases always load. */
MaterialSource loadMaterials(const std::string& glbPath, const sbvg::File& file, bool atlasNormals = true) {
    if (file.version < 3) throw std::runtime_error("this .sbvg carries no material ids (version " + std::to_string(file.version) + "); rebuild it from its GLB");
    MaterialSource source;
    source.glbPath = glbPath;
    const auto start = std::chrono::steady_clock::now();
    source.scene = gltf::GlbSceneReader::readFile(glbPath);
    if (!source.scene.ok) throw std::runtime_error("failed to load materials from " + glbPath + ": " + source.scene.error);
    source.loadMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
    const uint32_t glbMaterials = glbMaterialCount(glbPath);
    if (glbMaterials != file.materialCount) {
        throw std::runtime_error("the .sbvg was built from a GLB with " + std::to_string(file.materialCount) + " materials; " + glbPath + " has " + std::to_string(glbMaterials));
    }
    // gltf::GlbSceneReader appends a default material when a primitive has none; the atlas materials
    // must sit exactly at materialCount, materialCount + 1, ... as the file's triangles name them.
    source.scene.materials.resize(file.materialCount);
    auto loadAtlasImage = [&](const std::string& imagePath, uint32_t level, const char* what) {
        std::ifstream in(imagePath, std::ios::binary);
        if (!in) throw std::runtime_error(std::string(what) + " of level " + std::to_string(level) + " is missing: " + imagePath);
        std::vector<uint8_t> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
        png::DecodeResult decoded = png::decode(bytes.data(), bytes.size(), png::OutputFormat::Rgb);
        if (!decoded.ok) throw std::runtime_error(std::string(what) + " of level " + std::to_string(level) + " failed to decode: " + decoded.error);
        gltf::SceneImage image;
        image.mimeType = "image/png";
        image.decoded = true;
        image.pixels = std::move(decoded.image);
        source.scene.images.push_back(std::move(image));
        return static_cast<int>(source.scene.images.size() - 1);
    };
    for (const sbvg::Atlas& atlas : file.atlases) {
        gltf::SceneMaterial material;
        material.baseColorImage = loadAtlasImage(atlas.imagePath, atlas.level, "atlas");
        material.wrapS = 33071;
        material.wrapT = 33071;
        material.metallicFactor = atlas.metallic;
        material.roughnessFactor = atlas.roughness;
        if (atlasNormals && !atlas.normalImagePath.empty()) {
            material.normalImage = loadAtlasImage(atlas.normalImagePath, atlas.level, "normal atlas");
            material.normalWrapS = 33071;
            material.normalWrapT = 33071;
            material.normalScale = 1.0f;
        }
        source.scene.materials.push_back(material);
    }
    for (const auto& image : source.scene.images) if (image.decoded) ++source.imagesDecoded;
    return source;
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

sbvg::CutParams cutParamsFor(const render::CameraSpec& camera, int height, const Json& lodConfig) {
    sbvg::CutParams params;
    params.eye[0] = camera.position.x;
    params.eye[1] = camera.position.y;
    params.eye[2] = camera.position.z;
    params.lodScale = static_cast<float>(height) / (2.0f * std::tan(0.5f * camera.verticalFovDeg * math::DEG_TO_RAD));
    params.near = numberOr(lodConfig["near"], 0.1f);
    params.thresholdPx = numberOr(lodConfig["thresholdPx"], 1.0f);
    params.finestLevel = static_cast<uint32_t>(numberOr(lodConfig["finestLevel"], 0.0f));
    return params;
}

// ---- one render from a config file ---------------------------------------------------------------

int renderOnce(const std::string& configPath) {
    std::ifstream configFile(configPath);
    if (!configFile.is_open()) {
        std::cerr << "cannot open config " << configPath << std::endl;
        return 2;
    }
    std::stringstream configText;
    configText << configFile.rdbuf();
    const Json config = parseJson(configText.str());

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

        const math::AABB bounds = fileBounds(file);
        const render::CameraSpec camera = parseCamera(config["camera"], bounds, aspect);
        const sbvg::CutParams cutParams = cutParamsFor(camera, settings.height, config["lod"]);
        const auto cutStart = std::chrono::steady_clock::now();
        const sbvg::Cut cut = sbvg::selectCut(file, cutParams);
        const double cutMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - cutStart).count();
        if (cut.indices.empty()) throw std::runtime_error("the LOD cut selected no clusters (is the camera inside every LOD sphere?)");

        LightingSetup lighting = parseLighting(config["lighting"], bounds, camera.position);
        const metalpt::Material material = parseMaterial(config["material"]);
        const std::string materialsGlb = config["materials"]["glbPath"].asString("");
        const bool sceneMaterials = !materialsGlb.empty();
        MaterialSource source;
        if (sceneMaterials) source = loadMaterials(materialsGlb, file, boolOr(config["materials"]["atlasNormals"], true));

        render::RenderOutput out;
        std::string deviceName = "cpu";
        double accelerationBuildMs = 0.0;
        uint32_t texturesUploaded = 0;
        std::unique_ptr<metalpt::MetalPathTracer> metalTracer;
        // Optional speed-ups, each measured by scripts/bench_sbvg_pathtracer.cjs; off by default.
        const Json& opt = config["optimizations"];
        const float bounceThresholdPx = numberOr(opt["bounceThresholdPx"], 0.0f);
        const bool accelFastBuild = boolOr(opt["accelFastBuild"], false);
        const std::string samplerName = opt["sampler"].asString("pcg");
        if (samplerName != "pcg" && samplerName != "sobol") throw std::runtime_error("optimizations.sampler must be \"pcg\" or \"sobol\"");
        const bool primaryRaster = boolOr(opt["primaryRaster"], false);
        sbvg::Cut bounceCut;
        if (backend == "metal") {
            metalTracer = std::make_unique<metalpt::MetalPathTracer>();
            metalpt::MetalPathTracer& tracer = *metalTracer;
            tracer.setPreferFastBuild(accelFastBuild);
            tracer.setSampler(samplerName == "sobol" ? 1 : 0);
            tracer.setPrimaryRaster(primaryRaster);
            tracer.setBounceShadowRays(boolOr(opt["bounceShadowRays"], true));
            tracer.setGeometry(file.vertices, cut.indices, cut.materials);
            if (bounceThresholdPx > 0.0f) {
                sbvg::CutParams bounceParams = cutParams;
                bounceParams.thresholdPx = bounceThresholdPx;
                bounceCut = sbvg::selectCut(file, bounceParams);
                if (bounceCut.indices.empty()) throw std::runtime_error("the bounce LOD cut selected no clusters");
                tracer.setBounceGeometry(bounceCut.indices, bounceCut.materials, bounceThresholdPx / cutParams.lodScale);
            }
            if (sceneMaterials) {
                tracer.setMaterials(source.scene);
                texturesUploaded = tracer.textureCount();
            }
            deviceName = tracer.deviceName();
            accelerationBuildMs = tracer.accelerationBuildMs();
            out = tracer.render(camera, lighting.lighting, settings, sceneMaterials ? nullptr : &material);
        } else {
            if (lighting.lighting.mode != metalpt::Lighting::Mode::Sky) throw std::runtime_error("backend \"cpu\" (render::PathTracer) needs config.lighting.sun");
            const gltf::GltfScene scene = sceneFromCut(file, cut, sceneMaterials ? &source.scene : nullptr);
            const auto buildStart = std::chrono::steady_clock::now();
            render::PathTracer tracer(scene, false);
            accelerationBuildMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - buildStart).count();
            if (!sceneMaterials) tracer.setClayMaterial(material.albedo, material.roughness, material.metallic);
            out = tracer.render(camera, *lighting.sky, settings);
        }

        std::vector<Vec3> beauty = out.color;
        const bool denoise = boolOr(config["denoise"], false);
        double denoiseMs = 0.0;
        std::string denoiseBackend = "none";
        if (denoise) {
            if (backend == "metal") {
                denoiseBackend = "metal";
                beauty = metalTracer->denoise(metalpt::DenoiseOptions{});
                denoiseMs = metalTracer->denoiseGpuMs();
                if (boolOr(config["denoiseCheck"], false)) {
                    // The CPU filter on the same raw frame, for the parity test.
                    const auto cpuStart = std::chrono::steady_clock::now();
                    const std::vector<Vec3> cpu = denoise::denoiseATrous(out.color, out.guides);
                    const double cpuMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - cpuStart).count();
                    std::vector<float> raw(cpu.size() * 3);
                    for (size_t i = 0; i < cpu.size(); ++i) { raw[i * 3] = cpu[i].x; raw[i * 3 + 1] = cpu[i].y; raw[i * 3 + 2] = cpu[i].z; }
                    if (!writeBytes(std::filesystem::path(outputDir) / "denoised_cpu.f32", raw.data(), raw.size() * sizeof(float))) throw std::runtime_error("failed to write denoised_cpu.f32");
                    std::cout << "[TELEMETRY] denoiseCheck cpuMs=" << cpuMs << " gpuMs=" << denoiseMs << std::endl;
                }
            } else {
                denoiseBackend = "cpu";
                const auto cpuStart = std::chrono::steady_clock::now();
                beauty = denoise::denoiseATrous(out.color, out.guides);
                denoiseMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - cpuStart).count();
            }
            std::vector<float> raw(beauty.size() * 3);
            for (size_t i = 0; i < beauty.size(); ++i) { raw[i * 3] = beauty[i].x; raw[i * 3 + 1] = beauty[i].y; raw[i * 3 + 2] = beauty[i].z; }
            if (!writeBytes(std::filesystem::path(outputDir) / "denoised.f32", raw.data(), raw.size() * sizeof(float))) throw std::runtime_error("failed to write denoised.f32");
        }
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
              << "  \"lighting\": " << jsonString(lighting.lighting.mode == metalpt::Lighting::Mode::Sky ? "sky" : "studio") << ",\n"
              << "  \"file\": { \"clusters\": " << file.clusters.size() << ", \"levels\": " << file.levelCount
              << ", \"vertices\": " << file.vertexCount() << ", \"leafTriangles\": " << file.leafTriangleCount << ", \"atlases\": " << file.atlases.size() << " },\n"
              << "  \"cut\": { \"clusters\": " << cut.clusterIds.size() << ", \"triangles\": " << cut.triangleCount()
              << ", \"thresholdPx\": " << cutParams.thresholdPx << ", \"finestLevel\": " << cutParams.finestLevel << " },\n"
              << "  \"optimizations\": { \"accelFastBuild\": " << (accelFastBuild ? "true" : "false") << ", \"sampler\": " << jsonString(samplerName)
              << ", \"primaryRaster\": " << (primaryRaster ? "true" : "false") << ", \"rasterMs\": " << (metalTracer ? metalTracer->rasterMs() : 0.0)
              << ", \"bounceCut\": { \"thresholdPx\": " << bounceThresholdPx << ", \"clusters\": " << bounceCut.clusterIds.size() << ", \"triangles\": " << bounceCut.triangleCount()
              << ", \"accelerationBuildMs\": " << (metalTracer ? metalTracer->bounceBuildMs() : 0.0) << " } },\n"
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
              << "  \"denoiseBackend\": " << jsonString(denoiseBackend) << ",\n"
              << "  \"denoiseMs\": " << denoiseMs << ",\n"
              << "  \"materials\": { \"source\": " << jsonString(sceneMaterials ? "glb" : "uniform") << ", \"glbPath\": " << jsonString(materialsGlb)
              << ", \"count\": " << (sceneMaterials ? file.materialCount : 1) << ", \"atlasMaterials\": " << (sceneMaterials ? file.atlases.size() : 0)
              << ", \"images\": " << source.scene.images.size() << ", \"imagesDecoded\": " << source.imagesDecoded
              << ", \"texturesUploaded\": " << texturesUploaded << ", \"loadMs\": " << source.loadMs << " },\n"
              << "  \"material\": { \"albedo\": " << jsonVec(material.albedo) << ", \"roughness\": " << material.roughness << ", \"metallic\": " << material.metallic << " },\n"
              << "  \"sun\": { \"elevationDeg\": " << lighting.elevationDeg << ", \"azimuthDeg\": " << lighting.azimuthDeg << " },\n"
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

// ---- resident session ------------------------------------------------------------------------------

/**
 * Commands (one JSON object per stdin line):
 *   {"op":"open","sbvgPath":..,"glbPath"?:..,"lighting"?:{..},"material"?:{..}}
 *       loads the file (and the GLB's materials), builds nothing yet -> {"event":"opened",..}
 *   {"op":"view","width","height","camera":{position,target,up,verticalFovDeg},"lod"?:{thresholdPx,near},
 *                "maxBounces"?,"clampIndirect"?,"seed"?,"targetSpp"?,"exposureEv"?}
 *       starts a progressive frame for that view: the LOD cut (and acceleration structure) is rebuilt when
 *       the eye moved more than a tenth of the scene radius or the LOD parameters changed
 *       -> {"event":"view","seq",..} then {"event":"frame","seq","spp","rays","gpuMs",..} as samples accumulate;
 *       each frame event means <dir>/frame.rgba holds the display-ready image (width * height * 4 bytes)
 *   {"op":"close"}  (or EOF) exits.
 * Errors come back as {"event":"error","message":..}; a failed open leaves the session without a file.
 */
class ServeSession {
public:
    explicit ServeSession(std::filesystem::path dir) : dir_(std::move(dir)) {}

    int run() {
        std::filesystem::create_directories(dir_);
        std::thread reader([this] { readStdin(); });
        emit("{\"event\":\"ready\",\"dir\":" + jsonString(dir_.string()) + "}");
        while (!closed_) {
            std::string line;
            if (nextCommand(line, !frameActive())) {
                if (line.empty()) {
                    closed_ = true;
                    break;
                }
                handle(line);
                continue;
            }
            if (frameActive()) step();
        }
        reader.join();
        return 0;
    }

private:
    std::filesystem::path dir_;
    std::mutex mutex_;
    std::condition_variable wake_;
    std::deque<std::string> commands_;
    bool stdinClosed_{false};
    bool closed_{false};

    sbvg::File file_;
    bool opened_{false};
    math::AABB bounds_;
    float sceneRadius_{1.0f};
    LightingSetup lighting_;
    metalpt::Material material_;
    bool sceneMaterials_{false};
    MaterialSource source_;
    std::unique_ptr<metalpt::MetalPathTracer> tracer_;

    bool haveCut_{false};
    sbvg::CutParams cutParams_;
    sbvg::Cut cut_;
    double cutMs_{0.0};

    bool frameActive_{false};
    uint64_t seq_{0};
    int targetSpp_{256};
    int width_{0}, height_{0};
    render::CameraSpec camera_;
    render::RenderSettings settings_;
    float exposureEv_{0.0f};
    bool exposureFixed_{false};
    bool exposureSet_{false};
    bool denoise_{true};
    bool temporal_{true};
    float renderScale_{1.0f};
    int outWidth_{0}, outHeight_{0};
    std::chrono::steady_clock::time_point lastWrite_;

    bool frameActive() const { return frameActive_ && tracer_ && tracer_->samplesPerPixel() < targetSpp_; }

    void readStdin() {
        std::string line;
        while (std::getline(std::cin, line)) {
            std::lock_guard<std::mutex> lock(mutex_);
            commands_.push_back(line);
            wake_.notify_one();
        }
        std::lock_guard<std::mutex> lock(mutex_);
        stdinClosed_ = true;
        wake_.notify_one();
    }

    /** Next command; with `block`, waits for one. Returns false when none is pending; an empty line means stdin closed. */
    bool nextCommand(std::string& out, bool block) {
        std::unique_lock<std::mutex> lock(mutex_);
        if (block) wake_.wait(lock, [this] { return !commands_.empty() || stdinClosed_; });
        if (!commands_.empty()) {
            out = std::move(commands_.front());
            commands_.pop_front();
            return true;
        }
        if (stdinClosed_) {
            out.clear();
            return true;
        }
        return false;
    }

    void emit(const std::string& json) {
        std::cout << json << std::endl;
    }

    void emitError(const std::string& message) {
        emit("{\"event\":\"error\",\"message\":" + jsonString(message) + "}");
    }

    void handle(const std::string& line) {
        try {
            const Json cmd = parseJson(line);
            const std::string op = cmd["op"].asString("");
            if (op == "open") open(cmd);
            else if (op == "view") view(cmd);
            else if (op == "close") closed_ = true;
            else throw std::runtime_error("unknown op: " + op);
        } catch (const std::exception& e) {
            emitError(e.what());
        }
    }

    void open(const Json& cmd) {
        const std::string sbvgPath = cmd["sbvgPath"].asString("");
        if (sbvgPath.empty()) throw std::runtime_error("open needs sbvgPath");
        const auto start = std::chrono::steady_clock::now();
        frameActive_ = false;
        haveCut_ = false;
        opened_ = false;
        file_ = sbvg::readFile(sbvgPath);
        bounds_ = fileBounds(file_);
        sceneRadius_ = std::max(0.5f * bounds_.size().length(), 1e-3f);
        material_ = parseMaterial(cmd["material"]);
        const std::string glbPath = cmd["glbPath"].asString("");
        sceneMaterials_ = !glbPath.empty();
        source_ = MaterialSource{};
        if (sceneMaterials_) source_ = loadMaterials(glbPath, file_);
        // The sky's observer altitude depends on the camera; it is rebuilt per view when it changes.
        lightingConfig_ = cmd.has("lighting") ? serialize(cmd["lighting"]) : "{}";
        if (!tracer_) tracer_ = std::make_unique<metalpt::MetalPathTracer>();
        if (sceneMaterials_) tracer_->setMaterials(source_.scene);
        opened_ = true;
        const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - start).count();
        std::ostringstream s;
        s.precision(9);
        s << "{\"event\":\"opened\",\"device\":" << jsonString(tracer_->deviceName())
          << ",\"file\":{\"clusters\":" << file_.clusters.size() << ",\"levels\":" << file_.levelCount << ",\"vertices\":" << file_.vertexCount()
          << ",\"leafTriangles\":" << file_.leafTriangleCount << ",\"materialCount\":" << file_.materialCount << ",\"atlases\":" << file_.atlases.size()
          << ",\"aabbMin\":" << jsonVec(bounds_.min) << ",\"aabbMax\":" << jsonVec(bounds_.max) << "}"
          << ",\"materials\":{\"source\":" << jsonString(sceneMaterials_ ? "glb" : "uniform") << ",\"count\":" << (sceneMaterials_ ? file_.materialCount : 1)
          << ",\"atlasMaterials\":" << (sceneMaterials_ ? file_.atlases.size() : 0)
          << ",\"images\":" << source_.scene.images.size() << ",\"imagesDecoded\":" << source_.imagesDecoded << ",\"texturesUploaded\":" << tracer_->textureCount() << "}"
          << ",\"openMs\":" << ms << "}";
        emit(s.str());
    }

    std::string lightingConfig_{"{}"};

    /** Re-serializes the small lighting object so it can be parsed again per view (the parser owns no copy). */
    static std::string serialize(const Json& v) {
        std::ostringstream s;
        s.precision(9);
        switch (v.type) {
            case Json::Null: s << "null"; break;
            case Json::Bool: s << (v.b ? "true" : "false"); break;
            case Json::Number: s << v.num; break;
            case Json::String: s << jsonString(v.str); break;
            case Json::Array:
                s << '[';
                for (size_t i = 0; i < v.arr.size(); ++i) s << (i ? "," : "") << serialize(v.arr[i]);
                s << ']';
                break;
            case Json::Object:
                s << '{';
                for (size_t i = 0; i < v.obj.size(); ++i) s << (i ? "," : "") << jsonString(v.obj[i].first) << ':' << serialize(v.obj[i].second);
                s << '}';
                break;
        }
        return s.str();
    }

    void view(const Json& cmd) {
        if (!opened_) throw std::runtime_error("open a file before view");
        const int outWidth = static_cast<int>(numberOr(cmd["width"], 0));
        const int outHeight = static_cast<int>(numberOr(cmd["height"], 0));
        if (outWidth < 8 || outHeight < 8 || outWidth > 8192 || outHeight > 8192) throw std::runtime_error("view needs width and height between 8 and 8192");
        if (!cmd["camera"].has("position") || !cmd["camera"].has("target")) throw std::runtime_error("view needs camera.position and camera.target");
        // Below 1, the frame is traced at a fraction of the size and MetalFX scales it up to the view.
        renderScale_ = std::clamp(numberOr(cmd["renderScale"], 1.0f), 0.25f, 1.0f);
        const int width = std::max(8, static_cast<int>(std::lround(outWidth * renderScale_)));
        const int height = std::max(8, static_cast<int>(std::lround(outHeight * renderScale_)));
        outWidth_ = outWidth;
        outHeight_ = outHeight;
        const std::string samplerName = cmd["sampler"].asString("sobol");
        if (samplerName != "pcg" && samplerName != "sobol") throw std::runtime_error("view.sampler must be \"pcg\" or \"sobol\"");
        tracer_->setSampler(samplerName == "sobol" ? 1 : 0);
        const float aspect = static_cast<float>(outWidth) / static_cast<float>(outHeight);
        render::CameraSpec camera = parseCamera(cmd["camera"], bounds_, aspect);
        // LOD is chosen for the pixels the viewer sees, not the traced size.
        const sbvg::CutParams params = cutParamsFor(camera, outHeight, cmd["lod"]);

        const bool lodChanged = !haveCut_ || params.lodScale != cutParams_.lodScale || params.thresholdPx != cutParams_.thresholdPx
                             || params.near != cutParams_.near || params.finestLevel != cutParams_.finestLevel;
        const float dx = params.eye[0] - cutParams_.eye[0], dy = params.eye[1] - cutParams_.eye[1], dz = params.eye[2] - cutParams_.eye[2];
        const bool moved = std::sqrt(dx * dx + dy * dy + dz * dz) > 0.1f * sceneRadius_;
        double accelerationBuildMs = 0.0;
        if (lodChanged || moved) {
            const auto cutStart = std::chrono::steady_clock::now();
            cut_ = sbvg::selectCut(file_, params);
            cutMs_ = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - cutStart).count();
            if (cut_.indices.empty()) throw std::runtime_error("the LOD cut selected no clusters");
            tracer_->setGeometry(file_.vertices, cut_.indices, cut_.materials);
            accelerationBuildMs = tracer_->accelerationBuildMs();
            cutParams_ = params;
            haveCut_ = true;
        }

        lighting_ = parseLighting(parseJson(lightingConfig_), bounds_, camera.position);
        settings_ = render::RenderSettings{};
        settings_.width = width;
        settings_.height = height;
        settings_.maxBounces = static_cast<int>(numberOr(cmd["maxBounces"], 4));
        settings_.clampIndirect = numberOr(cmd["clampIndirect"], 10.0f);
        settings_.seed = static_cast<uint32_t>(numberOr(cmd["seed"], 1));
        targetSpp_ = std::max(1, static_cast<int>(numberOr(cmd["targetSpp"], 256)));
        denoise_ = boolOr(cmd["denoise"], true);
        temporal_ = boolOr(cmd["temporal"], true);
        // The frame just left becomes the history this view reprojects from (when it was denoised).
        if (temporal_) tracer_->commitHistory();
        else tracer_->clearHistory();
        exposureFixed_ = cmd["exposureEv"].type == Json::Number;
        exposureEv_ = exposureFixed_ ? static_cast<float>(cmd["exposureEv"].num) : 0.0f;
        exposureSet_ = exposureFixed_;
        camera_ = camera;
        width_ = width;
        height_ = height;
        tracer_->beginFrame(camera_, lighting_.lighting, settings_, sceneMaterials_ ? nullptr : &material_);
        frameActive_ = true;
        ++seq_;
        lastWrite_ = std::chrono::steady_clock::now() - std::chrono::seconds(1);
        std::ostringstream s;
        s.precision(9);
        s << "{\"event\":\"view\",\"seq\":" << seq_ << ",\"width\":" << outWidth << ",\"height\":" << outHeight
          << ",\"renderWidth\":" << width << ",\"renderHeight\":" << height << ",\"renderScale\":" << renderScale_ << ",\"sampler\":" << jsonString(samplerName)
          << ",\"cut\":{\"clusters\":" << cut_.clusterIds.size() << ",\"triangles\":" << cut_.triangleCount() << ",\"thresholdPx\":" << cutParams_.thresholdPx
          << ",\"rebuilt\":" << ((lodChanged || moved) ? "true" : "false") << ",\"cutMs\":" << cutMs_ << ",\"accelerationBuildMs\":" << accelerationBuildMs << "}"
          << ",\"lighting\":" << jsonString(lighting_.lighting.mode == metalpt::Lighting::Mode::Sky ? "sky" : "studio") << ",\"targetSpp\":" << targetSpp_ << "}";
        emit(s.str());
    }

    /** One batch of samples, then the frame file when enough time passed or the target is reached. */
    void step() {
        const int spp = tracer_->samplesPerPixel();
        const int passes = spp < 8 ? 1 : spp < 64 ? 2 : 4;
        tracer_->samplePasses(std::min(passes, targetSpp_ - spp));
        const auto now = std::chrono::steady_clock::now();
        const bool done = tracer_->samplesPerPixel() >= targetSpp_;
        const double sinceWrite = std::chrono::duration<double, std::milli>(now - lastWrite_).count();
        if (!done && sinceWrite < 40.0) return;
        writeFrame();
        lastWrite_ = std::chrono::steady_clock::now();
        if (done) frameActive_ = false;
    }

    void writeFrame() {
        const render::RenderOutput out = tracer_->readback();
        std::vector<Vec3> color = out.color;
        double denoiseMs = 0.0;
        uint32_t historyPixels = 0;
        if (denoise_) {
            metalpt::DenoiseOptions options;
            options.temporal = temporal_;
            color = tracer_->denoise(options);
            denoiseMs = tracer_->denoiseGpuMs();
            historyPixels = tracer_->historyPixels();
        }
        if (!exposureSet_) {
            exposureEv_ = view::autoExposureEv(color);
            exposureSet_ = true;
        }
        const texture::ImageBuffer image = view::toDisplayImage(color, out.width, out.height, exposureEv_, view::AgxLook::Base);
        std::vector<uint8_t> rgba(static_cast<size_t>(out.width) * out.height * 4);
        for (size_t p = 0; p < static_cast<size_t>(out.width) * out.height; ++p) {
            const uint8_t* src = image.data.data() + p * image.channels;
            uint8_t* dst = rgba.data() + p * 4;
            dst[0] = src[0];
            dst[1] = image.channels >= 3 ? src[1] : src[0];
            dst[2] = image.channels >= 3 ? src[2] : src[0];
            dst[3] = 255;
        }
        double upscaleMs = 0.0;
        if (out.width != outWidth_ || out.height != outHeight_) {
            rgba = tracer_->upscaleRgba(rgba, out.width, out.height, outWidth_, outHeight_);
            upscaleMs = tracer_->upscaleGpuMs();
        }
        const std::filesystem::path tmp = dir_ / "frame.rgba.tmp";
        const std::filesystem::path final = dir_ / "frame.rgba";
        if (!writeBytes(tmp, rgba.data(), rgba.size())) throw std::runtime_error("failed to write " + tmp.string());
        std::filesystem::rename(tmp, final);
        std::ostringstream s;
        s.precision(9);
        s << "{\"event\":\"frame\",\"seq\":" << seq_ << ",\"spp\":" << tracer_->samplesPerPixel() << ",\"rays\":" << out.rays
          << ",\"gpuMs\":" << tracer_->frameGpuMs() << ",\"width\":" << outWidth_ << ",\"height\":" << outHeight_
          << ",\"renderWidth\":" << out.width << ",\"renderHeight\":" << out.height << ",\"upscaleMs\":" << upscaleMs
          << ",\"coverage\":" << out.geometryCoverage << ",\"exposureEv\":" << exposureEv_ << ",\"path\":" << jsonString(final.string())
          << ",\"denoised\":" << (denoise_ ? "true" : "false") << ",\"denoiseMs\":" << denoiseMs << ",\"historyPixels\":" << historyPixels
          << ",\"done\":" << (tracer_->samplesPerPixel() >= targetSpp_ ? "true" : "false") << "}";
        emit(s.str());
    }
};

int serve(const std::string& dir) {
    try {
        ServeSession session{std::filesystem::path(dir)};
        return session.run();
    } catch (const std::exception& e) {
        std::cout << "{\"event\":\"error\",\"message\":" << jsonString(e.what()) << ",\"fatal\":true}" << std::endl;
        return 1;
    }
}

} // namespace

int main(int argc, char** argv) {
    if (argc >= 2 && std::string(argv[1]) == "--probe") return probe();
    if (argc >= 3 && std::string(argv[1]) == "--serve") return serve(argv[2]);
    if (argc < 2) {
        std::cerr << "usage: sbvg_pathtracer <config.json> | --probe | --serve <dir>" << std::endl;
        return 2;
    }
    return renderOnce(argv[1]);
}
