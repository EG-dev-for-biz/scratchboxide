/********************************************************************************
 * Copyright (C) 2026 Scratchbox LLC. All rights reserved.
 *
 * This software and associated documentation files are proprietary and confidential
 * to Scratchbox LLC. Unauthorized copying, modification, distribution, or use
 * of this file, via any medium, is strictly prohibited without explicit written
 * permission from Scratchbox LLC.
 ********************************************************************************/

/**
 * Tile restyle CLI (scratchbox_tile_restyle.hpp).
 *
 *   run_tile_restyle --input <tile.glb> --config <restyle.json> --sidecar <out.sbrx> --forms <out_forms.glb>
 *
 * Reads the tile with GlbSceneReader (world space, the vertex order glb-geometry-patcher.ts uses),
 * applies the config's fields to the vertices and writes them as an SBRX sidecar (every triangle
 * kept), so the caller can patch POSITION in place without touching textures. The config's forms
 * go to a separate GLB in the same world frame. One JSON line of stats goes to stdout.
 *
 * Build: clang++ -std=c++20 -O3 -I packages/core/src/native/3d-engine/include scripts/run_tile_restyle.cpp -o build/3d-native/run_tile_restyle -lz
 */

#include "scratchbox_tile_restyle.hpp"

#include <cstdio>
#include <fstream>
#include <sstream>

using namespace scratchbox;
using namespace scratchbox::restyle;
using scratchbox::io::GlbJsonParser;
using scratchbox::io::GlbJsonValue;

static Vec2 vec2(const GlbJsonValue& v, Vec2 def) {
    return (v.type == GlbJsonValue::Array && v.arr.size() >= 2) ? Vec2(v[0].asFloat(), v[1].asFloat()) : def;
}

static Vec3 vec3(const GlbJsonValue& v, Vec3 def) {
    return (v.type == GlbJsonValue::Array && v.arr.size() >= 3) ? Vec3(v[0].asFloat(), v[1].asFloat(), v[2].asFloat()) : def;
}

static float num(const GlbJsonValue& o, const char* key, float def) {
    const GlbJsonValue& v = o[key];
    return v.type == GlbJsonValue::Number && std::isfinite(v.num) ? static_cast<float>(v.num) : def;
}

static Config parseConfig(const std::string& text) {
    Config cfg;
    GlbJsonParser parser(text.c_str(), text.size());
    const GlbJsonValue root = parser.parse();
    for (const auto& f : root["fields"].arr) {
        Field field;
        field.center = vec2(f["center"], field.center);
        field.radiusMeters = num(f, "radiusMeters", field.radiusMeters);
        field.blendMeters = num(f, "blendMeters", field.blendMeters);
        field.offsetMeters = num(f, "offsetMeters", 0.0f);
        field.hasLevel = f["levelMeters"].type == GlbJsonValue::Number;
        field.levelMeters = num(f, "levelMeters", 0.0f);
        field.levelWeight = num(f, "levelWeight", 1.0f);
        field.terraceStepMeters = num(f, "terraceStepMeters", 0.0f);
        field.reliefAmplitudeMeters = num(f, "reliefAmplitudeMeters", 0.0f);
        field.reliefWavelengthMeters = num(f, "reliefWavelengthMeters", 2.0f);
        field.reliefHeadingDeg = num(f, "reliefHeadingDeg", 0.0f);
        cfg.fields.push_back(field);
    }
    for (const auto& f : root["forms"].arr) {
        Form form;
        form.center = vec2(f["center"], form.center);
        form.baseOffsetMeters = num(f, "baseOffsetMeters", 0.0f);
        form.groundSnap = f["groundSnap"].type != GlbJsonValue::Bool || f["groundSnap"].b;
        form.rotationYDeg = num(f, "rotationYDeg", 0.0f);
        for (const auto& p : f["profile"].arr) form.profile.push_back(vec2(p, Vec2(0, 0)));
        form.segments = static_cast<int>(num(f, "segments", 48));
        form.lobes = static_cast<int>(num(f, "lobes", 0));
        form.lobeAmplitude = num(f, "lobeAmplitude", 0.0f);
        form.helixTurns = num(f, "helixTurns", 0.0f);
        for (const auto& p : f["path"].arr) form.path.push_back(vec3(p, Vec3(0, 0, 0)));
        form.radiusStartMeters = num(f, "radiusStartMeters", 0.3f);
        form.radiusEndMeters = num(f, "radiusEndMeters", form.radiusStartMeters);
        form.sides = static_cast<int>(num(f, "sides", 12));
        form.twistTurns = num(f, "twistTurns", 0.0f);
        const GlbJsonValue& rep = f["replicate"];
        form.replicate.count = static_cast<int>(num(rep, "count", 1));
        form.replicate.ringRadiusMeters = num(rep, "ringRadiusMeters", 0.0f);
        form.replicate.stepMeters = vec2(rep["stepMeters"], Vec2(0, 0));
        const GlbJsonValue& m = f["material"];
        form.material.albedo = vec3(m["albedo"], form.material.albedo);
        form.material.roughness = num(m, "roughness", form.material.roughness);
        form.material.metalness = num(m, "metalness", form.material.metalness);
        form.material.emissive = vec3(m["emissive"], form.material.emissive);
        cfg.forms.push_back(form);
    }
    return cfg;
}

static bool writeSidecar(const std::string& path, const std::vector<float>& xyz, size_t triangles) {
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    if (!f) return false;
    const char magic[4] = {'S', 'B', 'R', 'X'};
    const uint32_t version = 1, V = static_cast<uint32_t>(xyz.size() / 3), T = static_cast<uint32_t>(triangles);
    f.write(magic, 4);
    f.write(reinterpret_cast<const char*>(&version), 4);
    f.write(reinterpret_cast<const char*>(&V), 4);
    f.write(reinterpret_cast<const char*>(&T), 4);
    f.write(reinterpret_cast<const char*>(xyz.data()), static_cast<std::streamsize>(xyz.size() * sizeof(float)));
    const std::vector<uint8_t> keep(triangles, 1);
    f.write(reinterpret_cast<const char*>(keep.data()), static_cast<std::streamsize>(keep.size()));
    return static_cast<bool>(f);
}

int main(int argc, char** argv) {
    std::string input, configPath, sidecarPath, formsPath;
    for (int i = 1; i + 1 < argc; i += 2) {
        const std::string a = argv[i];
        if (a == "--input") input = argv[i + 1];
        else if (a == "--config") configPath = argv[i + 1];
        else if (a == "--sidecar") sidecarPath = argv[i + 1];
        else if (a == "--forms") formsPath = argv[i + 1];
    }
    if (input.empty() || configPath.empty() || sidecarPath.empty() || formsPath.empty()) {
        std::fprintf(stderr, "usage: run_tile_restyle --input <tile.glb> --config <json> --sidecar <out.sbrx> --forms <out.glb>\n");
        return 2;
    }

    std::ifstream cf(configPath);
    if (!cf) { std::fprintf(stderr, "cannot read %s\n", configPath.c_str()); return 1; }
    std::stringstream ss;
    ss << cf.rdbuf();
    const Config cfg = parseConfig(ss.str());

    gltf::GltfScene scene = gltf::GlbSceneReader::readFile(input);
    if (!scene.ok) { std::fprintf(stderr, "cannot read %s: %s\n", input.c_str(), scene.error.c_str()); return 1; }
    if (scene.mesh.vertices.empty()) { std::fprintf(stderr, "%s has no triangle geometry\n", input.c_str()); return 1; }

    // Area-weighted smooth normals for relief: tile normals are often missing or baked flat.
    ScratchboxMesh shading = scene.mesh;
    shading.recomputeSmoothNormals();

    std::vector<float> xyz, nrm;
    xyz.reserve(scene.mesh.vertices.size() * 3);
    nrm.reserve(scene.mesh.vertices.size() * 3);
    for (size_t i = 0; i < scene.mesh.vertices.size(); ++i) {
        const Vec3& p = scene.mesh.vertices[i].position;
        const Vec3& n = shading.vertices[i].normal;
        xyz.insert(xyz.end(), {p.x, p.y, p.z});
        nrm.insert(nrm.end(), {n.x, n.y, n.z});
    }

    Stats stats;
    stats.vertexCount = scene.mesh.vertices.size();
    stats.bounds = scene.bounds;
    stats.datumY = TileRestyler::datum(xyz);
    const SurfaceGrid surface(xyz, scene.bounds, 1.0f);

    TileRestyler::applyFields(xyz, nrm, scene.bounds, stats.datumY, cfg.fields, stats);
    // Forms sit on the restyled surface, not the original one.
    const SurfaceGrid restyledSurface(xyz, scene.bounds, 1.0f);
    const std::vector<ScratchboxMesh> forms = TileRestyler::buildForms(cfg.forms, scene.bounds, restyledSurface, stats.datumY, stats);

    if (!writeSidecar(sidecarPath, xyz, scene.mesh.indices.size() / 3)) {
        std::fprintf(stderr, "cannot write %s\n", sidecarPath.c_str());
        return 1;
    }
    if (!forms.empty() && !io::GlbWriter::writeMultiMeshToFile(forms, formsPath)) {
        std::fprintf(stderr, "cannot write %s\n", formsPath.c_str());
        return 1;
    }

    const auto& b = stats.bounds;
    std::printf("{\"vertexCount\":%zu,\"movedVertices\":%zu,\"maxDisplacementMeters\":%.4f,"
                "\"formMeshes\":%zu,\"formVertices\":%zu,\"formTriangles\":%zu,\"datumY\":%.3f,"
                "\"bounds\":{\"min\":[%.3f,%.3f,%.3f],\"max\":[%.3f,%.3f,%.3f]}}\n",
                stats.vertexCount, stats.movedVertices, stats.maxDisplacementMeters,
                stats.formMeshes, stats.formVertices, stats.formTriangles, stats.datumY,
                b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z);
    return 0;
}
