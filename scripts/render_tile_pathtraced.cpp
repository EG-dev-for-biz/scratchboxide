/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

// Offline path-traced render of a GLB tile, configured by a JSON file.
// Usage: render_tile_pathtraced <config.json>
// Writes beauty.png, noisy.png, albedo.png, normal.png, depth.png and stats.json into config.outputDir.

#include "scratchbox_ephemeris.hpp"
#include "scratchbox_gltf_scene.hpp"
#include "scratchbox_io.hpp"
#include "scratchbox_pathtracer.hpp"
#include "scratchbox_texture.hpp"
#include "scratchbox_view_transform.hpp"
#include "scratchbox_displacement.hpp"
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <set>
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

bool writePng(const std::string& path, const texture::ImageBuffer& image) {
    std::vector<uint8_t> bytes = texture::encodePng(image);
    std::ofstream file(path, std::ios::binary);
    if (!file.is_open()) return false;
    file.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    return file.good();
}

texture::ImageBuffer albedoImage(const render::RenderOutput& out) {
    texture::ImageBuffer image(out.width, out.height, 3);
    for (int y = 0; y < out.height; ++y) {
        for (int x = 0; x < out.width; ++x) {
            const Vec3& a = out.guides.albedo[static_cast<size_t>(y) * out.width + x];
            image.setPixelRGB(x, y, Vec3(view::srgbEncode(a.x), view::srgbEncode(a.y), view::srgbEncode(a.z)));
        }
    }
    return image;
}

texture::ImageBuffer normalImage(const render::RenderOutput& out) {
    texture::ImageBuffer image(out.width, out.height, 3);
    for (int y = 0; y < out.height; ++y) {
        for (int x = 0; x < out.width; ++x) {
            size_t i = static_cast<size_t>(y) * out.width + x;
            if (!out.guides.geometryMask[i]) continue;
            const Vec3& n = out.guides.normal[i];
            image.setPixelRGB(x, y, Vec3(n.x * 0.5f + 0.5f, n.y * 0.5f + 0.5f, n.z * 0.5f + 0.5f));
        }
    }
    return image;
}

texture::ImageBuffer depthImage(const render::RenderOutput& out) {
    float nearest = 1e30f, farthest = 0.0f;
    for (size_t i = 0; i < out.guides.depth.size(); ++i) {
        if (!out.guides.geometryMask[i]) continue;
        nearest = std::min(nearest, out.guides.depth[i]);
        farthest = std::max(farthest, out.guides.depth[i]);
    }
    // Inverse depth keeps nearby structure readable when the ground plane runs out to the horizon.
    const float invNear = 1.0f / std::max(nearest, 1e-3f);
    const float invFar = 1.0f / std::max(farthest, nearest + 1e-3f);
    const float invRange = std::max(invNear - invFar, 1e-9f);
    texture::ImageBuffer image(out.width, out.height, 1);
    for (int y = 0; y < out.height; ++y) {
        for (int x = 0; x < out.width; ++x) {
            size_t i = static_cast<size_t>(y) * out.width + x;
            if (!out.guides.geometryMask[i]) continue;
            float depth = std::max(out.guides.depth[i], 1e-3f);
            float value = std::clamp((1.0f / depth - invFar) / invRange, 0.0f, 1.0f);
            image.data[i] = static_cast<uint8_t>(1.0f + value * 254.0f + 0.5f);
        }
    }
    return image;
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

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: render_tile_pathtraced <config.json>" << std::endl;
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

    const std::string glbPath = config["glbPath"].asString("");
    const std::string outputDir = config["outputDir"].asString("");
    if (glbPath.empty() || outputDir.empty()) {
        std::cerr << "config must set glbPath and outputDir" << std::endl;
        return 2;
    }
    std::filesystem::create_directories(outputDir);
    const auto totalStart = std::chrono::steady_clock::now();

    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(glbPath);
    if (!scene.ok) {
        std::cerr << "failed to load " << glbPath << ": " << scene.error << std::endl;
        return 1;
    }

    uint32_t originalTris = static_cast<uint32_t>(scene.mesh.indices.size() / 3);
    uint32_t originalVerts = static_cast<uint32_t>(scene.mesh.vertices.size());

    if (config.has("displacement")) {
        const Json& dispJson = config["displacement"];
        displacement::DisplacementOptions dispOpt;
        dispOpt.tessellationFactor = static_cast<uint32_t>(numberOr(dispJson["tessellationFactor"], 4.0f));
        dispOpt.displacementScale = numberOr(dispJson["displacementScale"], 0.06f);
        dispOpt.midpoint = numberOr(dispJson["midpoint"], 0.5f);
        dispOpt.enableProceduralNoise = boolOr(dispJson["enableProceduralNoise"], true);
        dispOpt.proceduralNoiseScale = numberOr(dispJson["proceduralNoiseScale"], 0.015f);
        dispOpt.proceduralNoiseFrequency = numberOr(dispJson["proceduralNoiseFrequency"], 32.0f);
        dispOpt.sampleTextureHeight = boolOr(dispJson["sampleTextureHeight"], true);
        dispOpt.textureHeightWeight = numberOr(dispJson["textureHeightWeight"], 1.0f);
        dispOpt.recomputeSmoothNormals = boolOr(dispJson["recomputeSmoothNormals"], true);

        std::cout << "[Displacement] Subdividing and physically displacing scene: factor N=" 
                  << dispOpt.tessellationFactor << ", scale=" << dispOpt.displacementScale << "m..." << std::endl;
        scene = displacement::DisplacementEngine::tessellateAndDisplaceScene(scene, dispOpt);
        std::cout << "[Displacement] Complete. Triangles: " << originalTris << " -> " 
                  << (scene.mesh.indices.size() / 3) << " (x" 
                  << ((scene.mesh.indices.size() / 3) / std::max<size_t>(1, originalTris))
                  << "), Vertices: " << originalVerts << " -> " << scene.mesh.vertices.size() << std::endl;

        if (dispJson.has("exportDisplacedGlb")) {
            std::string outGlb = dispJson["exportDisplacedGlb"].asString("");
            if (!outGlb.empty()) {
                std::vector<uint8_t> glbData = io::GlbWriter::writeGlb(scene.mesh);
                std::ofstream glbFile(outGlb, std::ios::binary);
                if (glbFile.is_open()) {
                    glbFile.write(reinterpret_cast<const char*>(glbData.data()), glbData.size());
                    std::cout << "[Displacement] Exported displaced GLB mesh to " << outGlb << std::endl;
                }
            }
        }
    }

    render::PathTracer tracer(scene, boolOr(config["groundPlane"], true));
    if (config.has("clayAlbedo")) {
        // Linear RGB; studio clay #dcd6cd is [0.716, 0.672, 0.610]
        tracer.setClayMaterial(vec3Or(config["clayAlbedo"], Vec3(0.716f, 0.672f, 0.610f)),
                               numberOr(config["clayRoughness"], 0.82f), numberOr(config["clayMetallic"], 0.02f));
    }

    render::RenderSettings settings;
    settings.width = static_cast<int>(numberOr(config["width"], 1280));
    settings.height = static_cast<int>(numberOr(config["height"], 720));
    settings.samplesPerPixel = static_cast<int>(numberOr(config["samplesPerPixel"], 64));
    settings.maxBounces = static_cast<int>(numberOr(config["maxBounces"], 4));
    settings.threads = static_cast<int>(numberOr(config["threads"], 0));
    settings.clampIndirect = numberOr(config["clampIndirect"], 10.0f);
    settings.seed = static_cast<uint32_t>(numberOr(config["seed"], 1));
    const std::string modeName = config["shadingMode"].asString("relit");
    settings.mode = modeName == "baked" ? render::ShadingMode::Baked : render::ShadingMode::Relit;

    const Json& sunConfig = config["sun"];
    float elevationDeg = 0.0f, azimuthDeg = 0.0f;
    if (sunConfig.has("unixSeconds") && sunConfig.has("latitude") && sunConfig.has("longitude")) {
        auto angles = ephemeris::EphemerisService::calculateSolarAngles(
            numberOr(sunConfig["latitude"], 0.0f), numberOr(sunConfig["longitude"], 0.0f),
            static_cast<int64_t>(sunConfig["unixSeconds"].num));
        elevationDeg = angles.elevationDeg;
        azimuthDeg = angles.azimuthDeg;
    } else if (sunConfig.has("elevationDeg") && sunConfig.has("azimuthDeg")) {
        elevationDeg = numberOr(sunConfig["elevationDeg"], 0.0f);
        azimuthDeg = numberOr(sunConfig["azimuthDeg"], 0.0f);
    } else {
        std::cerr << "config.sun must provide latitude, longitude and unixSeconds, or elevationDeg and azimuthDeg" << std::endl;
        return 2;
    }
    const float e = elevationDeg * math::DEG_TO_RAD, a = azimuthDeg * math::DEG_TO_RAD;
    const Vec3 sunDirection(std::cos(e) * std::sin(a), std::sin(e), -std::cos(e) * std::cos(a));

    render::CameraSpec camera;
    const Json& cameraConfig = config["camera"];
    const float aspect = static_cast<float>(settings.width) / static_cast<float>(std::max(settings.height, 1));
    if (cameraConfig.has("position") && cameraConfig.has("target")) {
        camera.position = vec3Or(cameraConfig["position"], camera.position);
        camera.target = vec3Or(cameraConfig["target"], camera.target);
        camera.verticalFovDeg = numberOr(cameraConfig["verticalFovDeg"], camera.verticalFovDeg);
        camera.up = vec3Or(cameraConfig["up"], camera.up);
        camera.apertureRadius = numberOr(cameraConfig["apertureRadius"], 0.0f);
        camera.focusDistance = numberOr(cameraConfig["focusDistance"], 0.0f);
    } else {
        const Json& framing = cameraConfig["auto"];
        camera = render::PathTracer::frameBounds(
            scene.bounds, tracer.groundHeight(), aspect,
            numberOr(framing["verticalFovDeg"], 40.0f),
            numberOr(framing["pitchDeg"], 35.0f),
            numberOr(framing["headingDeg"], 20.0f),
            numberOr(framing["distanceScale"], 0.9f));
    }

    const Json& atmosphereConfig = config["atmosphere"];
    sky::AtmosphereParams atmosphere;
    const float siteElevation = numberOr(atmosphereConfig["siteElevationMeters"], 0.0f);
    atmosphere.observerAltitudeMeters = std::max(0.0f, siteElevation + camera.position.y - tracer.groundHeight());
    atmosphere.airDensity = numberOr(atmosphereConfig["airDensity"], atmosphere.airDensity);
    atmosphere.dustDensity = numberOr(atmosphereConfig["dustDensity"], atmosphere.dustDensity);
    atmosphere.ozoneDensity = numberOr(atmosphereConfig["ozoneDensity"], atmosphere.ozoneDensity);
    atmosphere.sunAngularDiameterDeg = numberOr(atmosphereConfig["sunAngularDiameterDeg"], atmosphere.sunAngularDiameterDeg);
    atmosphere.sunIntensity = numberOr(atmosphereConfig["sunIntensity"], atmosphere.sunIntensity);
    sky::PhysicalSky sky(sunDirection, atmosphere);

    render::RenderOutput out = tracer.render(camera, sky, settings);

    const auto denoiseStart = std::chrono::steady_clock::now();
    std::vector<Vec3> beauty = out.color;
    const bool denoise = boolOr(config["denoise"], true) && settings.mode == render::ShadingMode::Relit;
    if (denoise) beauty = denoise::denoiseATrous(out.color, out.guides);
    const double denoiseMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - denoiseStart).count();

    const Json& exposureConfig = config["exposure"];
    const float exposureEv = exposureConfig.type == Json::Number ? static_cast<float>(exposureConfig.num) : view::autoExposureEv(beauty);
    const view::AgxLook look = config["look"].asString("base") == "punchy" ? view::AgxLook::Punchy : view::AgxLook::Base;

    const texture::ImageBuffer beautyImage = view::toDisplayImage(beauty, out.width, out.height, exposureEv, look);
    const texture::ImageBuffer noisyImage = view::toDisplayImage(out.color, out.width, out.height, exposureEv, look);
    const std::filesystem::path dir(outputDir);
    bool written = writePng((dir / "beauty.png").string(), beautyImage)
                && writePng((dir / "noisy.png").string(), noisyImage)
                && writePng((dir / "albedo.png").string(), albedoImage(out))
                && writePng((dir / "normal.png").string(), normalImage(out))
                && writePng((dir / "depth.png").string(), depthImage(out));
    if (!written) {
        std::cerr << "failed to write images into " << outputDir << std::endl;
        return 1;
    }
    {
        // Metric depth for 2D-to-3D lifting: float32 distance along each pixel-centre ray, 0 where no geometry
        std::vector<float> rawDepth(out.guides.depth.size(), 0.0f);
        for (size_t i = 0; i < rawDepth.size(); ++i) {
            if (out.guides.geometryMask[i]) rawDepth[i] = out.guides.depth[i];
        }
        std::ofstream depthFile(dir / "depth.f32", std::ios::binary);
        depthFile.write(reinterpret_cast<const char*>(rawDepth.data()), static_cast<std::streamsize>(rawDepth.size() * sizeof(float)));
        if (!depthFile.good()) {
            std::cerr << "failed to write depth.f32" << std::endl;
            return 1;
        }
    }

    double displayLuminance = 0.0;
    for (int y = 0; y < beautyImage.height; ++y) {
        for (int x = 0; x < beautyImage.width; ++x) displayLuminance += beautyImage.getLuminance(x, y);
    }
    displayLuminance /= static_cast<double>(beautyImage.width) * beautyImage.height;

    size_t decoded = 0;
    std::set<std::string> imageErrors;
    for (const auto& image : scene.images) {
        if (image.decoded) ++decoded;
        else if (!image.error.empty()) imageErrors.insert(image.error);
    }
    const double totalMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - totalStart).count();

    std::ostringstream stats;
    stats.precision(9);
    stats << "{\n"
          << "  \"width\": " << out.width << ",\n"
          << "  \"height\": " << out.height << ",\n"
          << "  \"samplesPerPixel\": " << settings.samplesPerPixel << ",\n"
          << "  \"shadingMode\": " << jsonString(modeName == "baked" ? "baked" : "relit") << ",\n"
          << "  \"triangles\": " << tracer.triangleCount() << ",\n"
          << "  \"primitives\": " << scene.primitiveCount << ",\n"
          << "  \"images\": " << scene.images.size() << ",\n"
          << "  \"imagesDecoded\": " << decoded << ",\n"
          << "  \"imageErrors\": [";
    bool firstError = true;
    for (const auto& err : imageErrors) {
        stats << (firstError ? "" : ", ") << jsonString(err);
        firstError = false;
    }
    stats << "],\n"
          << "  \"bvhNodes\": " << tracer.bvhNodeCount() << ",\n"
          << "  \"geometryCoverage\": " << out.geometryCoverage << ",\n"
          << "  \"nanSamples\": " << out.nanSamples << ",\n"
          << "  \"renderMs\": " << out.renderMs << ",\n"
          << "  \"denoiseMs\": " << (denoise ? denoiseMs : 0.0) << ",\n"
          << "  \"totalMs\": " << totalMs << ",\n"
          << "  \"exposureEv\": " << exposureEv << ",\n"
          << "  \"meanDisplayLuminance\": " << displayLuminance << ",\n"
          << "  \"sun\": { \"elevationDeg\": " << elevationDeg << ", \"azimuthDeg\": " << azimuthDeg
          << ", \"direction\": " << jsonVec(sunDirection) << ", \"irradiance\": " << jsonVec(sky.sunIrradiance()) << " },\n"
          << "  \"camera\": { \"position\": " << jsonVec(camera.position) << ", \"target\": " << jsonVec(camera.target)
          << ", \"up\": " << jsonVec(camera.up) << ", \"verticalFovDeg\": " << camera.verticalFovDeg << " },\n"
          << "  \"depthRaw\": \"depth.f32: float32 distance along each pixel-centre ray, row-major, 0 = no geometry\",\n"
          << "  \"groundHeight\": " << tracer.groundHeight() << ",\n"
          << "  \"groundAlbedo\": " << jsonVec(tracer.groundAlbedo()) << "\n"
          << "}\n";
    std::ofstream statsFile(dir / "stats.json");
    statsFile << stats.str();
    if (!statsFile.good()) {
        std::cerr << "failed to write stats.json" << std::endl;
        return 1;
    }
    std::cout << "[TELEMETRY] renderMs=" << out.renderMs << " spp=" << settings.samplesPerPixel
              << " triangles=" << tracer.triangleCount() << " coverage=" << out.geometryCoverage << std::endl;
    return 0;
}
